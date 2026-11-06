'use strict';

// Sample attendance: four shifts (office, mall morning, mall evening across midnight, night security),
// the sample team assigned to them, a PIN and a registered phone each, a month of clocking with the
// usual life in it (a few late mornings, two absences, overtime, a forgotten clock-out closed by the
// system, refused attempts from outside the circle or with a weak signal, borderline ones flagged),
// and TODAY as it is at the moment the data is loaded: people in, one late, one not in yet, one
// outside the circle, one on a break, one whose app has been closed for a while, the night guards
// done. Location updates for yesterday and today, office minutes for the people who use the office,
// patrol scans and cleaning rounds by the guards and cleaners on shift, a new phone waiting for
// approval and a correction waiting in Approvals. Every sample employee's PIN is 135790.
// Everything carries demo = 1; clear() removes exactly it.

const crypto = require('node:crypto');
const E = require('./attendance/engine');

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const DEMO_PIN = '135790';
// approximately The Wave, North 90 Street, New Cairo: marked as sample data on the settings page
const POINT = { lat: 30.026240, lng: 31.466480 };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// [name, start, end, ISO days, grace, unpaid break, colour]
const SHIFTS = {
  office: ['Office day', '09:00', '17:00', '71234', 15, 60, 'forest'],
  morning: ['Mall morning', '10:00', '18:00', '123567', 10, 30, 'sea'],
  day: ['Mall day', '12:00', '20:00', '134567', 10, 30, 'sand'],
  evening: ['Mall evening', '16:00', '00:00', '234567', 10, 30, 'sky'],
  night: ['Night security', '23:00', '07:00', '124567', 10, 30, 'cocoa'],
};
const WHO = {
  office: ['Hisham El-Sayed', 'Rania Fouad', 'Karim Abdelaziz', 'Nour Hassan', 'Tarek Mansour', 'Mai Abdelrahman', 'Ahmed Samir', 'Mostafa Gamal', 'Laila Khaled', 'Omar Nabil', 'Yasmin Sherif', 'Amr Hosny'],
  morning: ['Ashraf Zaki', 'Samira Lotfy'],
  day: ['Mahmoud Adel', 'Islam Reda', 'Dina Mahmoud'],
  evening: ['Sherif Kamal', 'Youssef Ibrahim', 'Eman Saad', 'Hana Ali'],
  night: ['Walid Fathy', 'Hany Shawky'],
};
// how each person tends to be: late, absent, overtime, early (chances per shift day)
const HABIT = { 'Karim Abdelaziz': { late: 0.22 }, 'Hana Ali': { late: 0.25, absent: 0.06 }, 'Mostafa Gamal': { ot: 0.4 }, 'Walid Fathy': { late: 0.04 }, 'Omar Nabil': { late: 0.15, early: 0.08 }, 'Mahmoud Adel': { ot: 0.25 } };
const PHONES = ['iPhone 13 · Safari', 'Samsung Galaxy A54 · Chrome', 'Xiaomi Redmi Note 12 · Chrome', 'OPPO A78 · Chrome', 'iPhone 15 · Safari', 'Huawei nova 11 · Chrome', 'Samsung Galaxy S23 · Samsung Internet', 'Realme 11 · Chrome'];
// Egypt's fixed-date official holidays
const HOLIDAYS = [['01-07', 'Coptic Christmas'], ['01-25', 'Revolution Day (25 January)'], ['04-25', 'Sinai Liberation Day'], ['05-01', 'Labour Day'], ['06-30', '30 June Revolution'], ['07-23', 'Revolution Day (23 July)'], ['10-06', 'Armed Forces Day']];

function load(db, admin, opts = {}) {
  if (!has(db, 'att_shifts') || !has(db, 'employees')) return;
  if (db.value('SELECT COUNT(*) FROM att_shifts WHERE demo = 1')) return;
  const h = opts.h || {};
  const S = h.attendance || null;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const today = E.cairo(nowMs).date;
  const iso = (ms) => new Date(ms).toISOString();
  const emps = Object.fromEntries(db.all("SELECT * FROM employees WHERE demo = 1 AND status = 'active'").map((e) => [e.name, e]));
  if (!Object.keys(emps).length) return;

  db.tx(() => {
    // ---- the circle: keep a point HR already set ----
    if (!db.setting('att_lat')) {
      db.setSetting('att_lat', String(POINT.lat));
      db.setSetting('att_lng', String(POINT.lng));
      db.setSetting('att_point_demo', '1');
    }
    const center = { lat: Number(db.setting('att_lat')), lng: Number(db.setting('att_lng')) };
    const radius = Number(db.setting('att_radius') || 100);
    const year = today.slice(0, 4);
    for (const [md, name] of HOLIDAYS) db.run('INSERT OR IGNORE INTO att_holidays (date, name, demo) VALUES (?, ?, 1)', `${year}-${md}`, name);
    const holiday = (d) => !!db.get('SELECT 1 FROM att_holidays WHERE date = ?', d);

    // ---- shifts and who works them (from 40 days ago) ----
    const shiftId = {};
    for (const [k, [name, a, b, days, grace, brk, color]] of Object.entries(SHIFTS)) {
      shiftId[k] = Number(db.run('INSERT INTO att_shifts (name, start_hm, end_hm, days, grace_min, break_min, color, active, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)', name, a, b, days, grace, brk, color, nowIso).lastInsertRowid);
    }
    const from = E.addDays(today, -40);
    const shiftOf = {};
    for (const [k, names] of Object.entries(WHO)) {
      for (const n of names) {
        const e = emps[n];
        if (!e) continue;
        db.run('INSERT INTO att_assign (employee_id, shift_id, starts, created_by, demo, created_at) VALUES (?, ?, ?, ?, 1, ?)', e.id, shiftId[k], e.hire_date > from ? e.hire_date : from, admin ? admin.id : null, nowIso);
        shiftOf[e.id] = { ...db.get('SELECT * FROM att_shifts WHERE id = ?', shiftId[k]), key: k };
      }
    }

    // ---- office accounts that belong to sample employees (same name) ----
    for (const e of Object.values(emps)) {
      if (e.user_id) continue;
      const u = db.get('SELECT id FROM users WHERE name = ? COLLATE NOCASE AND active = 1', e.name);
      if (u && !db.get('SELECT id FROM employees WHERE user_id = ?', u.id)) { db.run('UPDATE employees SET user_id = ? WHERE id = ?', u.id, e.id); e.user_id = u.id; }
    }

    // ---- PINs, notices, phones ----
    const pinHash = require('./db').hashPassword(DEMO_PIN);
    const device = {};
    let pi = 0;
    for (const e of Object.values(emps)) {
      if (!shiftOf[e.id]) continue; // the intern has no shift and no PIN yet
      const since = iso(Date.parse(`${(e.hire_date > from ? e.hire_date : from)}T08:00:00Z`));
      db.run('INSERT OR REPLACE INTO att_creds (employee_id, pin_hash, pin_set_at, pin_set_by, failed, consent_at, consent_version, last_login_at, demo) VALUES (?, ?, ?, ?, 0, ?, 1, ?, 1)', e.id, pinHash, since, admin ? admin.id : null, since, nowIso);
      const label = PHONES[pi++ % PHONES.length];
      device[e.id] = Number(db.run("INSERT INTO att_devices (employee_id, token_hash, label, agent, ip, status, created_at, decided_at, last_seen_at, demo) VALUES (?, ?, ?, ?, '41.233.12.40', 'active', ?, ?, ?, 1)",
        e.id, crypto.randomBytes(32).toString('hex'), label, label, since, since, nowIso).lastInsertRowid);
    }

    // ---- a month of clocking, and today as it is now ----
    const near = (r, maxM, minM = 0) => {
      const a = r() * Math.PI * 2;
      const d = minM + r() * (maxM - minM);
      return { lat: center.lat + (d * Math.cos(a)) / 111320, lng: center.lng + (d * Math.sin(a)) / (111320 * Math.cos((center.lat * Math.PI) / 180)) };
    };
    const ins = (e, kind, at, wd, { status = 'accepted', reasons = null, flags = null, pt = null, acc = null, source = 'app', note = null } = {}) => {
      const dist = pt ? Math.round(E.distance(center, pt) * 10) / 10 : null;
      return Number(db.run(`INSERT INTO att_punches (employee_id, kind, at, work_date, status, reasons, flags, lat, lng, accuracy, distance, taken_at, device_id, ip, agent, source, note, demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, e.id, kind, at, wd, status, reasons ? JSON.stringify(reasons) : null, flags ? JSON.stringify(flags) : null,
      pt ? pt.lat : null, pt ? pt.lng : null, acc, dist, source === 'app' ? iso(Date.parse(at) - 4000) : null, source === 'app' ? device[e.id] || null : null, source === 'app' ? '41.233.12.40' : null, null, source, note, at).lastInsertRowid);
    };
    const pings = (e, a, b, { inside = true, outsideFrom = null } = {}, r) => {
      for (let t = a; t <= b; t += 5 * 60000 + Math.round(r() * 40000)) {
        const out = outsideFrom && t >= outsideFrom;
        const pt = out ? near(r, 320, 210) : near(r, 70);
        const acc = Math.round(10 + r() * 28);
        const d = E.distance(center, pt);
        db.run('INSERT INTO att_pings (employee_id, at, lat, lng, accuracy, distance, inside, visible, device_id, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
          e.id, iso(t), pt.lat, pt.lng, acc, Math.round(d * 10) / 10, d <= radius ? 1 : 0, r() < 0.85 ? 1 : 0, device[e.id] || null);
        void inside;
      }
    };
    const leaveOn = (e, d) => !!db.get("SELECT 1 FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?", e.id, d, d);
    const timeline = {}; // who worked when today and yesterday (for scans, cleans and office minutes)
    // today's roles go to people really on shift right now (the sample follows the clock)
    const liveNow = Object.values(emps).filter((e) => shiftOf[e.id] && [today, E.addDays(today, -1)].some((d) => {
      const on = E.shiftOn(shiftOf[e.id], d);
      return on && Date.parse(on.start) <= nowMs - 25 * 60000 && nowMs < Date.parse(on.end) - 15 * 60000 && !leaveOn(e, d);
    })).map((e) => e.name);
    const ROLE = {};
    const used = new Set();
    for (const [role, pref] of [['notIn', ['Hana Ali', 'Omar Nabil']], ['outside', ['Islam Reda', 'Youssef Ibrahim']], ['onBreak', ['Dina Mahmoud', 'Eman Saad']], ['appClosed', ['Mahmoud Adel', 'Ashraf Zaki']], ['late', ['Karim Abdelaziz', 'Youssef Ibrahim', 'Sherif Kamal']]]) {
      const pick = pref.find((n) => liveNow.includes(n) && !used.has(n)) || liveNow.find((n) => !used.has(n));
      if (pick) { ROLE[role] = pick; used.add(pick); }
    }
    let forgot = null;
    for (const e of Object.values(emps)) {
      const sh = shiftOf[e.id];
      if (!sh) continue;
      const habit = { late: 0.08, absent: 0.025, ot: 0.12, early: 0.04, ...(HABIT[e.name] || {}) };
      const r = rng(e.id * 7919 + 17);
      for (let back = 32; back >= 0; back--) {
        const date = E.addDays(today, -back);
        if (date < e.hire_date) continue;
        const on = E.shiftOn(sh, date);
        if (!on) continue;
        if (Date.parse(on.start) - 3 * 3600000 > nowMs) continue;
        if (leaveOn(e, date)) continue;
        if (sh.key === 'office' && holiday(date)) continue;
        const isLive = Date.parse(on.end) + 3 * 3600000 > nowMs; // today's (or last night's) shift, still in its window
        const roll = r();
        if (isLive && e.name === ROLE.notIn) continue; // has not come
        if (!isLive && roll < habit.absent) continue; // absent that day
        const s = Date.parse(on.start);
        const en = Date.parse(on.end);
        let inAt = s - (3 + Math.round(r() * 14)) * 60000;
        if ((isLive && e.name === ROLE.late) || (!isLive && r() < habit.late)) inAt = s + (12 + Math.round(r() * 30)) * 60000;
        if (inAt > nowMs) continue; // not time yet
        // a refused try first, now and then: from the car park outside, or a weak signal
        if (r() < 0.05 || (isLive && e.name === ROLE.outside)) {
          const weak = r() < 0.4;
          const pt = weak ? near(r, 60) : near(r, 380, 160);
          const d = E.distance(center, pt);
          ins(e, 'in', iso(inAt - (2 + Math.round(r() * 5)) * 60000), date, { status: 'rejected', reasons: weak ? ['weak'] : ['outside'], pt, acc: weak ? Math.round(85 + r() * 120) : Math.round(12 + r() * 20) });
          void d;
        }
        const edge = r() < 0.05;
        const inPt = edge ? near(r, 96, 82) : near(r, 65);
        const inAcc = edge ? Math.round(18 + r() * 14) : Math.round(8 + r() * 24);
        ins(e, 'in', iso(inAt), date, { pt: inPt, acc: inAcc, status: edge && E.distance(center, inPt) + inAcc > radius ? 'flagged' : 'accepted', flags: edge && E.distance(center, inPt) + inAcc > radius ? ['edge'] : null });
        // the break: half-way through
        const brk = Number(sh.break_min) || 0;
        let bs = s + Math.round((en - s) / 2 - brk * 30000 + (r() - 0.5) * 50 * 60000);
        let be = bs + (brk + Math.round((r() - 0.3) * 12)) * 60000;
        if (isLive && e.name === ROLE.onBreak && nowMs - inAt > 70 * 60000) { bs = nowMs - 12 * 60000; be = null; }
        let outAt = en + Math.round((r() * 12 - 2) * 60000);
        if (!isLive && r() < habit.ot) outAt = en + (40 + Math.round(r() * 80)) * 60000;
        if (!isLive && r() < habit.early) outAt = en - (25 + Math.round(r() * 40)) * 60000;
        const stillIn = isLive && outAt > nowMs;
        if (brk && bs > inAt && bs < nowMs && (!stillIn || bs < nowMs)) {
          ins(e, 'break_start', iso(bs), date, { pt: near(r, 70), acc: Math.round(10 + r() * 25) });
          if (be && be < nowMs && be < outAt) ins(e, 'break_end', iso(be), date, { pt: near(r, 70), acc: Math.round(10 + r() * 25) });
        }
        // one forgotten clock-out a few days ago, closed by the system, and its correction waiting
        if (!forgot && !isLive && back >= 3 && back <= 6 && sh.key === 'evening') {
          forgot = { e, date, en, real: outAt };
          ins(e, 'out', iso(en), date, { status: 'flagged', flags: ['auto_out'], source: 'auto', note: 'No clock-out: closed by the system' });
          if (S) S.alert(e, 'auto_out', `${e.id}:${date}`, { date }, { at: iso(en + 3 * 3600000), demo: 1 });
          continue;
        }
        if (!stillIn) ins(e, 'out', iso(outAt), date, { pt: near(r, 70), acc: Math.round(8 + r() * 24) });
        // location updates for yesterday and today
        if (back <= 1 || isLive) {
          let to = stillIn ? nowMs - 60000 : outAt;
          if (isLive && e.name === ROLE.appClosed) to = Math.min(to, nowMs - 48 * 60000);
          const outsideFrom = isLive && e.name === ROLE.outside && stillIn ? nowMs - 26 * 60000 : null;
          pings(e, inAt + 60000, to, { outsideFrom }, r);
          (timeline[e.id] = timeline[e.id] || []).push([inAt, stillIn ? nowMs : outAt]);
        }
      }
    }

    // ---- what they did while on shift: patrol scans, cleaning rounds ----
    const Sec = h.security;
    if (Sec && has(db, 'sec_checkpoints')) {
      const cps = db.all('SELECT * FROM sec_checkpoints WHERE active = 1 ORDER BY sort, code');
      const areas = db.all('SELECT * FROM sec_clean_areas WHERE active = 1 ORDER BY sort, code');
      for (const n of ['Walid Fathy', 'Hany Shawky', 'Islam Reda', 'Ashraf Zaki', 'Samira Lotfy', 'Eman Saad']) {
        const e = emps[n];
        if (!e || !timeline[e.id]) continue;
        const r = rng(e.id * 31 + 5);
        const guard = ['Samira Lotfy', 'Eman Saad'].includes(n) ? null : n;
        for (const [a, b] of timeline[e.id]) {
          let i = Math.floor(r() * 5);
          for (let t = a + 20 * 60000; t < Math.min(b, nowMs - 2 * 60000); t += (35 + Math.round(r() * 25)) * 60000) {
            if (guard && cps.length) Sec.scan(cps[i++ % cps.length], { guard, at: iso(t), demo: 1 });
            else if (!guard && areas.length) Sec.markClean(areas[i++ % areas.length], { cleaner: n, at: iso(t), demo: 1 });
          }
        }
      }
    }

    // ---- office minutes: the people who work in the office, today (and the last week for the linked) ----
    const beat = (userId, t, active, path) => db.run('INSERT OR IGNORE INTO att_beats (user_id, at, path, active, demo) VALUES (?, ?, ?, ?, 1)', userId, iso(Math.floor(t / 60000) * 60000), path, active ? 1 : 0);
    const PATHS = ['/admin', '/admin/leads', '/admin/pipeline', '/admin/billing', '/admin/leases', '/admin/work', '/admin/tenants', '/admin/maintenance', '/admin/reports', '/admin/collections', '/admin/hr', '/admin/parking'];
    const session = (userId, a, b, r, { endState = 'active' } = {}) => {
      let t = a;
      let path = PATHS[Math.floor(r() * PATHS.length)];
      while (t < b) {
        const block = (20 + Math.round(r() * 50)) * 60000;
        for (let x = t; x < Math.min(b, t + block); x += 60000) { if (r() < 0.06) path = PATHS[Math.floor(r() * PATHS.length)]; beat(userId, x, true, path); }
        t += block;
        const idle = (3 + Math.round(r() * 10)) * 60000;
        for (let x = t; x < Math.min(b, t + idle); x += 60000) beat(userId, x, false, path);
        t += idle + (r() < 0.4 ? (10 + Math.round(r() * 25)) * 60000 : 0);
      }
      if (endState === 'idle') for (let x = b - 14 * 60000; x <= b; x += 60000) beat(userId, x, false, path);
    };
    const dayStart = (d, hm) => Date.parse(E.cairoAt(d, hm));
    for (const e of Object.values(emps)) {
      if (!e.user_id || !timeline[e.id]) continue;
      const r = rng(e.user_id * 101);
      for (const [a, b] of timeline[e.id]) session(e.user_id, a + 10 * 60000, Math.min(b - 5 * 60000, nowMs - 60000), r);
    }
    // office accounts without an employee record: a working day so far
    const others = db.all("SELECT * FROM users WHERE active = 1 AND email LIKE '%@demo.thewave.local' AND id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL) ORDER BY id LIMIT 7");
    others.forEach((u, i) => {
      const r = rng(u.id * 977);
      const a = dayStart(today, '09:00') + Math.round(r() * 50) * 60000;
      if (a > nowMs) return;
      const end = i % 3 === 0 ? nowMs - 60000 : i % 3 === 1 ? nowMs - 60000 : Math.max(a + 60 * 60000, nowMs - (100 + Math.round(r() * 80)) * 60000);
      session(u.id, a, Math.min(end, dayStart(today, '18:30'), nowMs - 60000), r, { endState: i % 3 === 1 ? 'idle' : 'active' });
    });

    // ---- a new phone waiting, a correction waiting ----
    const hana = emps['Hana Ali'];
    if (hana && device[hana.id]) {
      const id = Number(db.run("INSERT INTO att_devices (employee_id, token_hash, label, agent, ip, status, created_at, demo) VALUES (?, ?, 'Samsung Galaxy A15 · Chrome', 'Samsung Galaxy A15 · Chrome', '197.48.90.12', 'pending', ?, 1)",
        hana.id, crypto.randomBytes(32).toString('hex'), iso(nowMs - 95 * 60000)).lastInsertRowid);
      if (S) S.alert(hana, 'device', `${hana.id}:${id}`, { label: 'Samsung Galaxy A15 · Chrome' }, { at: iso(nowMs - 95 * 60000), demo: 1 });
    }
    if (forgot && h.approvals) {
      const real = forgot.real > forgot.en ? forgot.real : forgot.en + 25 * 60000;
      const at = iso(Math.round(real / 60000) * 60000);
      h.approvals.request({ kind: 'attendance', title: `Attendance correction: ${forgot.e.name} · out ${E.cairo(at).hm} on ${forgot.date}`, entity: 'employee', entity_id: forgot.e.id, link: `/admin/attendance/people/${forgot.e.id}?date=${forgot.date}`, payload: { employee_id: forgot.e.id, kind: 'out', at, work_date: forgot.date, reason: 'My phone battery died at the end of the shift; I left at the usual time.' }, note: 'My phone battery died at the end of the shift; I left at the usual time.', user: forgot.e.user_id ? db.get('SELECT * FROM users WHERE id = ?', forgot.e.user_id) : null, demo: 1 });
    }
  });
  // alerts for who is late and who left the circle, as the office would raise them
  if (S) {
    S.resetSweep();
    S.sweep(nowIso, { force: true });
    db.run('UPDATE att_alerts SET demo = 1 WHERE employee_id IN (SELECT id FROM employees WHERE demo = 1)');
    db.run("UPDATE wk_notes SET demo = 1 WHERE kind LIKE 'att_%' AND user_id IS NOT NULL AND created_at >= ?", new Date(nowMs - 60000).toISOString());
  }
}

function clear(db) {
  if (!has(db, 'att_shifts')) return;
  db.tx(() => {
    for (const t of ['att_pings', 'att_punches', 'att_alerts', 'att_devices', 'att_creds', 'att_assign', 'att_beats', 'att_holidays']) db.run(`DELETE FROM ${t} WHERE demo = 1`);
    db.run('DELETE FROM att_logins WHERE employee_id IN (SELECT id FROM employees WHERE demo = 1)');
    const def = Number(db.setting('att_default_shift') || 0);
    if (def && db.get('SELECT id FROM att_shifts WHERE id = ? AND demo = 1', def)) db.setSetting('att_default_shift', '');
    db.run('DELETE FROM att_shifts WHERE demo = 1');
    if (has(db, 'apr_requests')) db.run("DELETE FROM apr_requests WHERE kind = 'attendance' AND demo = 1");
    if (db.setting('att_point_demo') === '1') {
      db.setSetting('att_lat', '');
      db.setSetting('att_lng', '');
      db.setSetting('att_point_demo', '0');
    }
  });
}

module.exports = { load, clear, DEMO_PIN };
