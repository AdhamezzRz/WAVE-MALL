'use strict';

// Sample data for security and cleaning: twelve patrol checkpoints on three routes with a week of
// rounds (most complete, some started late, a few checkpoints skipped, some rounds missed, one in
// progress now); ten cleaning areas with a week of cleans (checked, one sent back, two areas overdue
// now); incidents of the last month with their timelines; lost and found; the key register with keys
// out (two overdue); and the last two days of shift handovers.

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);

// a repeatable random sequence
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const CHECKPOINTS = [
  ['CP-01', 'Main entrance doors', 'Ground floor'], ['CP-02', 'Fountain court', 'Ground floor'], ['CP-03', 'East fire exit', 'Ground floor'],
  ['CP-04', 'Food court service corridor', 'First floor'], ['CP-05', 'West fire exit', 'First floor'], ['CP-06', 'Cinema lobby', 'First floor'],
  ['CP-07', 'Roof plant room door', 'Roof'], ['CP-08', 'Loading bay gate', 'Service yard'], ['CP-09', 'B1 lifts lobby', 'Car park B1'],
  ['CP-10', 'B1 pay machines', 'Car park B1'], ['CP-11', 'B2 ramp', 'Car park B2'], ['CP-12', 'North perimeter fence', 'Outside'],
];
const ROUTES = [
  ['Mall floors', ['CP-01', 'CP-02', 'CP-03', 'CP-04', 'CP-05', 'CP-06'], 120, 40, '10:00', '24:00'],
  ['Car park B1 and B2', ['CP-09', 'CP-10', 'CP-11'], 180, 30, '00:00', '24:00'],
  ['Night perimeter', ['CP-08', 'CP-12', 'CP-07', 'CP-01'], 120, 45, '00:00', '07:00'],
];
const GUARDS = { morning: ['Ahmed Saeed', 'Mahmoud Fathy'], evening: ['Karim Adel', 'Sherif Nabil'], night: ['Hany Mostafa', 'Ibrahim Lotfy'] };
const AREAS = [
  ['CL-01', 'Ladies’ toilets, ground floor', 'toilets', 'Ground floor', 30], ['CL-02', 'Men’s toilets, ground floor', 'toilets', 'Ground floor', 30],
  ['CL-03', 'Toilets, first floor', 'toilets', 'First floor', 45], ['CL-04', 'Food court seating', 'food_court', 'First floor', 30],
  ['CL-05', 'Main entrance', 'entrance', 'Ground floor', 90], ['CL-06', 'Prayer rooms', 'prayer', 'First floor', 120],
  ['CL-07', 'B1 lifts lobby', 'lifts', 'Car park B1', 120], ['CL-08', 'Kids’ play area', 'other', 'First floor', 60],
  ['CL-09', 'Fountain court', 'corridor', 'Ground floor', 90], ['CL-10', 'Outdoor plaza', 'outdoor', 'Outside', 120],
];
const CLEANERS = ['Samia Ali', 'Fatma Hassan', 'Reda Mahmoud', 'Om Hashem', 'Sayed Ragab'];

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  const S = h.security;
  if (!S || !has(db, 'sec_checkpoints') || db.value('SELECT COUNT(*) FROM sec_checkpoints WHERE demo = 1')) return;
  const rnd = rng(20261104);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const ago = (hours) => iso(nowMs - hours * 3600000);
  const uid = admin ? admin.id : null;
  const today = S.localDay();
  const tok = (code) => `demo-${code.toLowerCase()}-${Math.floor(rnd() * 1e9).toString(36)}`;

  db.tx(() => {
    // ---------- patrols ----------
    const cp = {};
    CHECKPOINTS.forEach(([code, name, place], i) => {
      cp[code] = Number(db.run('INSERT INTO sec_checkpoints (code, name, place, token, sort, demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', code, name, place, tok(code), i + 1, ago(24 * 40)).lastInsertRowid);
    });
    for (const [name, codes, every, win, start, end] of ROUTES) {
      const rid = Number(db.run('INSERT INTO sec_routes (name, checkpoints, every_min, window_min, start_hm, end_hm, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', name, JSON.stringify(codes.map((c) => cp[c])), every, win, start, end, ago(24 * 40)).lastInsertRowid);
      const route = db.get('SELECT * FROM sec_routes WHERE id = ?', rid);
      for (let d = 7; d >= 0; d--) {
        const day = new Date(Date.parse(`${today}T12:00:00Z`) - d * 86400000).toISOString().slice(0, 10);
        for (const slot of S.slotsOf(route, day)) {
          const s = Date.parse(slot);
          if (s > nowMs) continue;
          // one round in five days missed; this morning's first car park round too
          const r = rnd();
          if (r < 0.07 || (d === 0 && name === 'Car park B1 and B2' && S.shiftOf(slot) === 'morning' && rnd() < 0.5)) continue;
          const late = rnd() < 0.1;
          const startMs = s + (late ? 20 + Math.floor(rnd() * 25) : Math.floor(rnd() * 10)) * 60000;
          if (startMs > nowMs) continue;
          const guard = pick(GUARDS[S.shiftOf(iso(startMs))]);
          const running = nowMs - startMs < win * 60000;
          const rd = Number(db.run("INSERT INTO sec_rounds (route_id, slot_at, guard_name, status, started_at, demo) VALUES (?, ?, ?, 'open', ?, 1)", rid, slot, guard, iso(startMs)).lastInsertRowid);
          let t = startMs;
          let got = 0;
          codes.forEach((code, i) => {
            t += (i ? 4 + Math.floor(rnd() * 6) : 0) * 60000 + Math.floor(rnd() * 50000);
            if (t > nowMs) return;
            // a checkpoint skipped now and then (the roof door most often)
            if (rnd() < (code === 'CP-07' ? 0.18 : 0.04)) return;
            const lateScan = t > startMs + win * 60000 || rnd() < 0.03 ? 1 : 0;
            const note = code === 'CP-03' && rnd() < 0.05 ? 'Door found propped open, closed it' : code === 'CP-12' && rnd() < 0.05 ? 'Light out on the fence, reported' : null;
            db.run('INSERT INTO sec_scans (round_id, checkpoint_id, guard_name, at, late, note, demo) VALUES (?, ?, ?, ?, ?, ?, 1)', rd, cp[code], guard, iso(t), lateScan, note);
            got++;
          });
          const status = got === codes.length ? 'done' : running ? 'open' : 'incomplete';
          db.run('UPDATE sec_rounds SET status = ?, finished_at = ? WHERE id = ?', status, status === 'open' ? null : iso(Math.min(t, startMs + win * 60000)), rd);
        }
      }
    }

    // ---------- cleaning ----------
    const area = {};
    AREAS.forEach(([code, name, kind, place, every], i) => {
      area[code] = Number(db.run("INSERT INTO sec_clean_areas (code, name, place, kind, every_min, start_hm, end_hm, token, sort, demo, created_at) VALUES (?, ?, ?, ?, ?, '10:00', '24:00', ?, ?, 1, ?)", code, name, place, kind, every, tok(code), i + 1, ago(24 * 40)).lastInsertRowid);
    });
    for (const [code, , , , every] of AREAS) {
      for (let d = 7; d >= 0; d--) {
        const day = new Date(Date.parse(`${today}T12:00:00Z`) - d * 86400000).toISOString().slice(0, 10);
        for (let m = 600 + every; m <= 1440; m += every) {
          const at = Date.parse(S.atLocal(day, m)) - Math.floor(rnd() * 8) * 60000;
          if (at > nowMs) break;
          // the first-floor toilets and the play area fall behind this afternoon
          if (d === 0 && ['CL-03', 'CL-08'].includes(code) && at > nowMs - 3 * 3600000) continue;
          if (rnd() < 0.08) continue;
          const old = nowMs - at > 3 * 3600000;
          const check = old ? (rnd() < 0.03 ? 'redo' : rnd() < 0.85 ? 'ok' : 'pending') : 'pending';
          db.run('INSERT INTO sec_clean_logs (area_id, cleaner_name, at, note, check_status, checked_by, checked_at, check_note, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
            area[code], pick(CLEANERS), iso(at), rnd() < 0.06 ? pick(['Refilled soap and paper', 'Mopped after a spill', 'Emptied all bins']) : null, check,
            check === 'pending' ? null : uid, check === 'pending' ? null : iso(at + 25 * 60000), check === 'redo' ? 'Floor still wet and bins full' : null);
        }
      }
    }

    // ---------- incidents ----------
    const INC = [
      ['theft', 'high', 'Shoplifting at a fashion store', 'Ground floor, unit G-12', 54, 'resolved', 'Store manager Nada (0100 222 3344). Suspect held until police arrived; ID copied.', 'Cameras 14 and 15, 18:42–18:55', '3417 / New Cairo 1st', [['Suspect held by two guards at the main entrance.', 'investigating', 10], ['Police took the suspect and the goods back to the store.', 'resolved', 95]], 'Goods returned to the store; police report filed.'],
      ['medical', 'medium', 'Shopper fainted in the food court', 'First floor, food court', 30, 'closed', 'Mrs. S. Hamdy, 60s, with her daughter (0111 555 0101).', 'Camera 31', null, [['First aider on site in 3 minutes; ambulance not needed.', 'resolved', 20], ['Family thanked the team; closed.', 'closed', 300]], 'Recovered after water and rest; left with family.'],
      ['fire_alarm', 'high', 'Fire alarm set off by kitchen smoke', 'First floor, Saffron Table kitchen', 140, 'closed', 'Kitchen staff of Saffron Table', 'Camera 28', null, [['Zone 4 alarm, no fire; kitchen hood filter blocked.', 'investigating', 8], ['Civil defence informed. Tenant asked to clean the hood ducts.', 'resolved', 60], ['Duct cleaning certificate received.', 'closed', 2880]], 'False alarm from smoke; hood duct cleaned by the tenant.'],
      ['damage', 'low', 'Scratched glass on the main entrance door', 'Ground floor, main entrance', 76, 'investigating', null, 'Camera 2, overnight', null, [['Maintenance asked for a quote for the glass.', null, 60]], null],
      ['security', 'medium', 'Group refusing to leave after closing', 'Ground floor, fountain court', 20, 'resolved', 'Five young men, names not given', 'Cameras 6 and 7, 00:10–00:25', null, [['Talked to them calmly; left at 00:25.', 'resolved', 15]], 'Left without trouble.'],
      ['safety', 'medium', 'Wet floor near the escalator, no sign', 'First floor, east escalator', 8, 'open', null, null, null, [], null],
      ['theft', 'medium', 'Phone reported stolen in the cinema lobby', 'First floor, cinema lobby', 4, 'open', 'Owner Omar Khaled, 0122 333 4455', 'Camera 22, 19:00–19:30', null, [['Footage being reviewed.', null, 1]], null],
      ['other', 'low', 'Lost child found at the play area', 'First floor, kids’ play area', 200, 'closed', 'Child of about 5, mother Mrs. Reem (0100 777 8899)', 'Camera 33', null, [['Announced on the speakers; mother came in 6 minutes.', 'closed', 10]], 'Reunited with mother after checking her ID.'],
      ['security', 'critical', 'Suspicious bag left at the north entrance', 'North entrance', 400, 'closed', null, 'Camera 4', 'Bomb squad call 2219', [['Area cordoned off; police called.', 'investigating', 2], ['Bag belonged to a shopper who came back; police cleared it.', 'closed', 55]], 'Owner found; police cleared the area after 55 minutes.'],
    ];
    for (const [kind, sev, title, place, hours, status, people, cctv, police, notes, outcome] of INC) {
      const t = ago(hours);
      const id = Number(db.run(`INSERT INTO sec_incidents (ref, kind, severity, title, place, at, description, people, cctv_ref, police_ref, status, assignee_id, outcome, resolved_at, user_id, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, db.nextRef('sec_incidents', 'SI', 4, true), kind, sev, title, place, t, null, people, cctv, police, status, uid, outcome,
      ['resolved', 'closed'].includes(status) ? ago(hours - 2) : null, uid, t, t).lastInsertRowid);
      db.run("INSERT INTO sec_incident_notes (incident_id, body, status_to, user_id, at) VALUES (?, NULL, 'open', ?, ?)", id, uid, t);
      for (const [body, to, mins] of notes) db.run('INSERT INTO sec_incident_notes (incident_id, body, status_to, user_id, at) VALUES (?, ?, ?, ?, ?)', id, body, to, uid, iso(Date.parse(t) + mins * 60000));
    }

    // ---------- lost and found ----------
    const LOST = [
      ['Black leather wallet', 'wallet', 'Food court, table 12', 'Cleaner Samia Ali', 30, 'returned', 'Ahmed Mansour', '2900101xxxxxx'],
      ['iPhone in a blue case', 'phone', 'Cinema lobby seats', 'Guard Karim Adel', 6, 'held', null, null],
      ['Car keys (Hyundai) with a red key ring', 'keys', 'Main entrance', 'Guard Ahmed Saeed', 50, 'returned', 'Mona Sherif', '2850505xxxxxx'],
      ['Child’s pink jacket', 'child', 'Kids’ play area', 'Staff of the play area', 80, 'held', null, null],
      ['Gold bracelet', 'jewellery', 'Ladies’ toilets, ground floor', 'Cleaner Fatma Hassan', 140, 'held', null, null],
      ['Shopping bag with a new shirt', 'bag', 'Fountain court bench', 'Guard Sherif Nabil', 400, 'returned', 'Youssef Adel', '3010202xxxxxx'],
      ['Sunglasses', 'other', 'Outdoor plaza', 'Guard Hany Mostafa', 2400, 'disposed', 'Donated to charity after 90 days', null],
      ['National ID card', 'documents', 'B1 pay machines', 'Guard Ibrahim Lotfy', 20, 'held', null, null],
    ];
    for (const [item, cat, where, by, hours, status, to, idNo] of LOST) {
      const id = Number(db.run('INSERT INTO sec_lost (ref, item, category, found_at, found_where, found_by, stored_at, status, returned_to, returned_id, returned_at, returned_by, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
        db.nextRef('sec_lost', 'LF', 4, true), item, cat, ago(hours), where, by, cat === 'jewellery' || cat === 'documents' ? 'Security office safe' : 'Security office, locker 3', status, to, idNo, status === 'held' ? null : ago(hours - 5), status === 'held' ? null : uid, uid, ago(hours)).lastInsertRowid);
      if (item.startsWith('iPhone')) db.run('UPDATE sec_lost SET owner_contact = ? WHERE id = ?', 'Called 0122 333 4455, coming tomorrow', id);
    }

    // ---------- keys ----------
    const KEYS = [
      ['K-001', 'master', 'Master key, all service doors', 'All floors', 2, 'Security office safe'], ['K-002', 'key', 'Roof plant room door', 'Roof', 2, 'Key cabinet, hook 2'],
      ['K-003', 'key', 'Main electrical room', 'B1', 2, 'Key cabinet, hook 3'], ['K-004', 'key', 'Generator room', 'Service yard', 1, 'Key cabinet, hook 4'],
      ['K-005', 'card', 'Loading bay gate', 'Service yard', 4, 'Key cabinet, card rack'], ['K-006', 'key', 'Fire pump room', 'B2', 1, 'Key cabinet, hook 6'],
      ['K-007', 'key', 'CCTV control room', 'Ground floor', 2, 'Key cabinet, hook 7'], ['K-008', 'key', 'Water tanks hatch', 'Roof', 1, 'Key cabinet, hook 8'],
      ['K-009', 'key', 'Unit G-07 (vacant)', 'Ground floor', 2, 'Key cabinet, hook 9'], ['K-010', 'key', 'Unit F-03 (fit-out)', 'First floor', 2, 'Key cabinet, hook 10'],
      ['K-011', 'card', 'Management office', 'First floor', 6, 'Reception drawer'], ['K-012', 'master', 'Master key, car park doors', 'B1 and B2', 1, 'Security office safe'],
    ];
    const key = {};
    for (const [code, kind, opens, place, copies, kept] of KEYS) key[code] = Number(db.run('INSERT INTO sec_keys (code, kind, opens, place, copies, kept_at, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', code, kind, opens, place, copies, kept, ago(24 * 60)).lastInsertRowid);
    const LOANS = [
      ['K-002', 'Mohamed Ezz', 'Cool Air contractors', 'AC maintenance, roof units', 3, 2, false],
      ['K-010', 'Eng. Tarek Fouad', 'Atelier fit-out team', 'Fit-out works, unit F-03', 9, -3, false],
      ['K-005', 'Saber Hamed', 'Delivery company', 'Night deliveries', 30, -26, false],
      ['K-004', 'Eng. Walid', 'Power Gen Services', 'Monthly generator test', 2, 1, false],
      ['K-012', 'Ahmed Saeed', null, 'Car park round', 1, 3, false],
    ];
    for (const [code, to, company, purpose, outH, dueInH] of LOANS) db.run('INSERT INTO sec_key_loans (key_id, issued_to, company, purpose, issued_at, due_at, issued_by, demo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', key[code], to, company, purpose, ago(outH), iso(nowMs + dueInH * 3600000), uid);
    for (let i = 0; i < 24; i++) {
      const code = pick(Object.keys(key));
      const out = 24 * 2 + Math.floor(rnd() * 24 * 25);
      const len = 1 + Math.floor(rnd() * 6);
      db.run('INSERT INTO sec_key_loans (key_id, issued_to, company, purpose, issued_at, due_at, returned_at, issued_by, returned_by, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', key[code],
        pick(['Mohamed Ezz', 'Eng. Walid', 'Saber Hamed', 'Karim Adel', 'Reda Mahmoud', 'Eng. Tarek Fouad']), pick([null, 'Cool Air contractors', 'Power Gen Services', 'Clean Pro']), pick(['Maintenance', 'Inspection', 'Deliveries', 'Cleaning', 'Night round']),
        ago(out), ago(out - len), ago(out - len - (rnd() < 0.15 ? 2 : -0.5)), uid, uid);
    }

    // ---------- handover ----------
    const HAND = [
      ['night', 54, 'Ahmed Saeed', 'Quiet night. Night perimeter complete except the roof door at 03:00 (ladder blocked). Delivery truck at 05:30, gate key returned.', 'Roof door round to check after the ladder is moved.'],
      ['morning', 46, 'Karim Adel', 'Opening checks done. Shoplifting at G-12 at 18:42 handed to police (SI). Fountain court busy after 17:00, extra guard placed.', null],
      ['evening', 38, 'Hany Mostafa', 'Closing done at 00:25 after a group in the fountain court left. All tenants locked up. Two keys out with contractors.', 'Cool Air has K-002 until tomorrow noon.'],
      ['night', 30, 'Ahmed Saeed', 'Night perimeter complete. Water leak noticed in B2 near the ramp, maintenance called.', 'Follow up the B2 leak with maintenance.'],
      ['morning', 22, 'Karim Adel', 'Shopper fainted in the food court, first aid given, family took her home. Wet floor by the east escalator reported to cleaning.', null],
      ['evening', 14, 'Hany Mostafa', 'Phone reported stolen in the cinema lobby; footage being reviewed. Delivery company card still out.', 'Chase the delivery company for card K-005 (overdue).'],
    ];
    for (const [shift, hours, to, summary, open] of HAND) {
      db.run('INSERT INTO sec_handover (shift, user_id, to_name, summary, open_items, at, ack_by, ack_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)', S.shiftOf(ago(hours)) || shift, uid, to, summary, open, ago(hours), hours > 14 ? uid : null, hours > 14 ? ago(hours - 0.3) : null);
    }
  });
}

function clear(db) {
  if (!has(db, 'sec_checkpoints')) return;
  db.tx(() => {
    db.run('DELETE FROM sec_scans WHERE demo = 1');
    db.run('DELETE FROM sec_rounds WHERE demo = 1');
    db.run('DELETE FROM sec_routes WHERE demo = 1');
    db.run('DELETE FROM sec_scans WHERE checkpoint_id IN (SELECT id FROM sec_checkpoints WHERE demo = 1)');
    db.run('DELETE FROM sec_checkpoints WHERE demo = 1');
    db.run('DELETE FROM sec_clean_alerts WHERE demo = 1 OR area_id IN (SELECT id FROM sec_clean_areas WHERE demo = 1)');
    db.run('DELETE FROM sec_clean_logs WHERE demo = 1 OR area_id IN (SELECT id FROM sec_clean_areas WHERE demo = 1)');
    db.run('DELETE FROM sec_clean_areas WHERE demo = 1');
    db.run('DELETE FROM sec_incident_notes WHERE incident_id IN (SELECT id FROM sec_incidents WHERE demo = 1)');
    db.run('DELETE FROM sec_incidents WHERE demo = 1');
    db.run('DELETE FROM sec_lost WHERE demo = 1');
    db.run('DELETE FROM sec_key_loans WHERE demo = 1 OR key_id IN (SELECT id FROM sec_keys WHERE demo = 1)');
    db.run('DELETE FROM sec_keys WHERE demo = 1');
    db.run('DELETE FROM sec_handover WHERE demo = 1');
  });
}

module.exports = { load, clear };
