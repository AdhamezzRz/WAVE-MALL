'use strict';

// Sample data for the car park's second wave of features, on top of demo-parking.js: sensors on the
// lower ground, valet cars, booked spaces, company accounts, fines, incidents and lost property, the
// cash safe with the bank's collections, alerts, subscriptions bought online and ETA e-receipts.

const crypto = require('node:crypto');
const M = require('./model');
const F = require('./parking/floor');
const { plateKey, plateShow } = require('./parking/core');
const { cairo } = require('./ops-common');

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const pad = (n, w = 2) => String(n).padStart(w, '0');

function load(db, admin, { h, P, r, plate }) {
  if (!has(db, 'pk_bays') || db.value('SELECT COUNT(*) FROM pk_valet WHERE demo = 1')) return;
  const pick = (a) => a[Math.floor(r() * a.length)];
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const today = cairo().date;
  const year = new Date().getFullYear();
  const user = admin ? admin.id : null;
  const users = db.all("SELECT id FROM users WHERE role IN ('agent','manager') ORDER BY id").map((u) => u.id);
  const staff = () => (users.length ? pick(users) : user);
  const ref = (table, prefix, width) => db.nextRef(table, prefix, width, true);
  const token = () => crypto.randomBytes(18).toString('base64url');
  const code8 = () => P.newCode();
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

  db.tx(() => {
    // ---------- the levels' bays, and sensors on the lower ground's sections A and B ----------
    for (const z of P.zones().filter((x) => x.capacity > 0)) if (!db.value('SELECT COUNT(*) FROM pk_bays WHERE zone_id = ?', z.id)) F.drawBays(db, z);
    const b1 = P.zones().find((z) => z.code === 'B1');
    const bays = b1 ? db.all('SELECT * FROM pk_bays WHERE zone_id = ? AND active = 1 ORDER BY code', b1.id) : [];
    const inside = db.all("SELECT id, plate FROM pk_sessions WHERE demo = 1 AND status = 'inside' AND kind = 'visitor' ORDER BY entry_at DESC");
    let k = 0;
    for (const b of bays.filter((x) => ['A', 'B'].includes(x.section))) {
      const taken = b.kind === 'general' ? r() < 0.72 : r() < 0.3;
      const car = taken ? inside[k++] : null;
      db.run('UPDATE pk_bays SET sensor = ?, state = ?, state_at = ?, plate = ? WHERE id = ?', `demo:${b.code}`, taken ? 'taken' : 'free', iso(nowMs - Math.floor(r() * 120000)), car ? car.plate : null, b.id);
      if (car) db.run('UPDATE pk_sessions SET bay_id = ?, zone_id = ? WHERE id = ?', b.id, b1.id, car.id);
    }

    // ---------- valet: cars with the team now, and earlier ones delivered ----------
    const fee = P.N('prk_valet_fee') || 100;
    const valetBays = bays.filter((b) => b.kind === 'valet');
    const now = [['parked', 150], ['parked', 95], ['requested', 140], ['ready', 180], ['received', 4], ['parked', 40]];
    let tag = 100;
    now.forEach(([status, minsAgo], i) => {
      const p = plate();
      const at = iso(nowMs - minsAgo * 60000);
      const e = P.entry({ lane: 'IN-1', plate: p, at, demo: 1, force: true });
      if (!e.session) return;
      const bay = status === 'received' ? null : valetBays[i] || null;
      db.run("UPDATE pk_sessions SET kind = 'valet', extra = extra + ?, bay_id = ?, zone_id = COALESCE(?, zone_id) WHERE id = ?", fee, bay ? bay.id : null, bay ? b1.id : null, e.session.id);
      const t = token();
      db.run(`INSERT INTO pk_valet (ref, tag, session_id, plate, plate_key, name, phone, bay_id, place, condition, notes, fee, status, token_hash, token, received_at, parked_at, requested_at, ready_at, received_by, runner_id, demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ref('pk_valet', 'VL', 5), ++tag, e.session.id, plateShow(p), plateKey(p), pick(['Omar Saleh', 'Nour Hassan', 'Ahmed Fathy', 'Salma Adel', 'Mona Raafat', 'Ziad Kamal']), `010${String(10000000 + Math.floor(r() * 89999999))}`,
      bay ? bay.id : null, null, JSON.stringify(i === 1 ? ['back'] : []), i === 1 ? 'Small scratch on the rear bumper, shown to the customer.' : null, fee, status, sha(t), t, at,
      status === 'received' ? null : iso(Date.parse(at) + 6 * 60000), ['requested', 'ready'].includes(status) ? iso(nowMs - (status === 'ready' ? 6 : 2) * 60000) : null, status === 'ready' ? iso(nowMs - 60000) : null, staff(), staff());
    });
    // delivered over the last two weeks: earlier visits that came by valet
    const past = db.all("SELECT id, plate, entry_at, exit_at FROM pk_sessions WHERE demo = 1 AND status = 'left' AND kind = 'visitor' AND exit_at >= ? AND (julianday(exit_at) - julianday(entry_at)) * 24 > 1.5 ORDER BY id LIMIT 400", iso(nowMs - 14 * 86400000));
    for (let i = 0; i < Math.min(22, past.length); i++) {
      const s = past[Math.floor(r() * past.length)];
      if (db.get('SELECT id FROM pk_valet WHERE session_id = ?', s.id)) continue;
      db.run("UPDATE pk_sessions SET kind = 'valet' WHERE id = ?", s.id);
      db.run(`INSERT INTO pk_valet (ref, tag, session_id, plate, plate_key, condition, fee, status, received_at, parked_at, requested_at, ready_at, delivered_at, received_by, runner_id, delivered_by, demo)
        VALUES (?, ?, ?, ?, ?, '[]', ?, 'delivered', ?, ?, ?, ?, ?, ?, ?, ?, 1)`, ref('pk_valet', 'VL', 5), 200 + i, s.id, s.plate, plateKey(s.plate), fee, s.entry_at,
      iso(Date.parse(s.entry_at) + 5 * 60000), iso(Date.parse(s.exit_at) - 12 * 60000), iso(Date.parse(s.exit_at) - 4 * 60000), s.exit_at, staff(), staff(), staff());
    }

    // ---------- booked spaces ----------
    const reserved = bays.filter((b) => b.kind === 'reserved');
    const booking = ({ hoursFrom, hours, status, bay, name, source = 'online', arrive = false }) => {
      const p = plate();
      const starts = nowMs + hoursFrom * 3600000;
      const ends = starts + hours * 3600000;
      const price = 30 + Math.max(20, 20 + (hours - 1) * 10);
      const id = Number(db.run(`INSERT INTO pk_bookings (ref, code, plate, plate_key, name, phone, email, zone_id, bay_id, starts_at, ends_at, price, status, source, user_id, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, ref('pk_bookings', 'PB', 5), code8(), plateShow(p), plateKey(p), name, `011${String(10000000 + Math.floor(r() * 89999999))}`,
      `${name.split(' ')[0].toLowerCase()}@example.com`, b1 ? b1.id : null, bay ? bay.id : null, iso(starts), iso(ends), price, status, source, source === 'office' ? user : null, iso(starts - 2 * 86400000), iso(Math.min(nowMs, starts))).lastInsertRowid);
      if (arrive) {
        const e = P.entry({ lane: 'IN-1', plate: p, at: iso(starts + 8 * 60000), demo: 1, force: true });
        if (e.session) {
          db.run("UPDATE pk_sessions SET kind = 'booking', booking_id = ?, bay_id = ? WHERE id = ?", id, bay ? bay.id : null, e.session.id);
          db.run("UPDATE pk_bookings SET status = 'arrived', session_id = ? WHERE id = ?", e.session.id, id);
        }
      }
      return id;
    };
    if (reserved.length) {
      booking({ hoursFrom: -1.5, hours: 4, status: 'confirmed', bay: reserved[0], name: 'Yasmine Farouk', arrive: true });
      booking({ hoursFrom: 1, hours: 3, status: 'confirmed', bay: reserved[1], name: 'Khaled Mansour' });
      booking({ hoursFrom: 2.5, hours: 2, status: 'confirmed', bay: reserved[2], name: 'Hoda Sami', source: 'office' });
      booking({ hoursFrom: 26, hours: 5, status: 'confirmed', bay: reserved[0], name: 'Mostafa Gamal' });
      booking({ hoursFrom: 3, hours: 2, status: 'pending', bay: reserved[3], name: 'Sara Wahba' });
      booking({ hoursFrom: -26, hours: 3, status: 'completed', bay: reserved[1], name: 'Ali Ragab' });
      booking({ hoursFrom: -50, hours: 4, status: 'completed', bay: reserved[2], name: 'Nadia Helmy' });
      booking({ hoursFrom: -74, hours: 2, status: 'no_show', bay: reserved[0], name: 'Samir Fouad' });
      booking({ hoursFrom: -6, hours: 2, status: 'cancelled', bay: reserved[4], name: 'Rania Ezzat', source: 'office' });
    }

    // ---------- company accounts ----------
    const account = (v) => Number(db.run(`INSERT INTO pk_accounts (ref, name, contact_name, phone, email, tax_id, address, mode, price, discount, cap, terms_days, next_bill_on, status, notes, demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 15, ?, 'active', ?, 1, ?, ?)`, ref('pk_accounts', 'PC', 4), v.name, v.contact, v.phone, v.email, v.tax, v.address, v.mode, v.price || 0, v.discount || 0, v.cap || null,
    `${M.addDays(`${today.slice(0, 7)}-01`, 32).slice(0, 7)}-01`, v.notes || null, iso(nowMs - 75 * 86400000), iso(nowMs)).lastInsertRowid);
    const fixed = account({ name: 'Nile Pharma', contact: 'Hesham Badawy', phone: '0227654321', email: 'admin@nilepharma.example', tax: '412-558-301', address: 'Office tower, 4th floor', mode: 'fixed', price: 650, notes: 'Four managers, reserved for weekdays.' });
    const usage = account({ name: 'Cairo Logistics', contact: 'Amira Shawky', phone: '0223456789', email: 'fleet@cairologistics.example', tax: '377-120-984', address: 'Building 3, Fifth Settlement', mode: 'usage', discount: 20, cap: 3000, notes: 'Delivery vans visiting the mall.' });
    const people = ['Hesham Badawy', 'Mai Nabil', 'Tamer Wagdy', 'Reem Atef', 'Fady Samy', 'Ola Hegazy', 'Bassem Ali'];
    const fleet = [];
    people.forEach((name, i) => {
      const a = i < 4 ? fixed : usage;
      const p = P.savePermit({ holder: 'individual', name, plates: plate(), price: a === fixed ? 650 : 0, months: 1, starts_on: M.addDays(today, -70), auto_renew: true, demo: 1 });
      db.run("UPDATE pk_permits SET account_id = ?, source = 'company', next_bill_on = NULL WHERE id = ?", a, p.id);
      if (a === usage) fleet.push(p);
    });
    // what the fleet parked: this month and last
    for (let d = 45; d >= 0; d--) {
      for (const p of fleet) {
        if (r() < 0.45) continue;
        const ms = nowMs - d * 86400000 - Math.floor(r() * 6) * 3600000;
        const minutes = 40 + Math.floor(r() * 200);
        db.run('INSERT INTO pk_account_charges (account_id, plate, minutes, amount, at, demo) VALUES (?, ?, ?, ?, ?, 1)', usage, p.plates.split(', ')[0], minutes, Math.round((20 + Math.max(0, Math.ceil((minutes - 65) / 60)) * 10) * 0.8 * 100) / 100, iso(ms));
      }
    }

    // ---------- fines ----------
    const types = new Map(db.all('SELECT * FROM pk_violation_types').map((t) => [t.code, t]));
    const left = db.all("SELECT id, plate, entry_at FROM pk_sessions WHERE demo = 1 AND status = 'left' AND kind = 'visitor' AND entry_at >= ? ORDER BY id DESC LIMIT 200", iso(nowMs - 14 * 86400000));
    const fine = (code, s, status, extra = {}) => {
      const t = types.get(code);
      if (!t || !s) return;
      db.run(`INSERT INTO pk_violations (ref, type_id, plate, plate_key, session_id, charged_session_id, bay_id, place, note, fine, status, resolution, user_id, at, resolved_at, resolved_by, demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, ref('pk_violations', 'PV', 5), t.id, s.plate, plateKey(s.plate), s.id, ['charged', 'paid'].includes(status) ? s.id : null,
      extra.bay || null, extra.place || null, extra.note || null, t.fine, status, extra.resolution || null, staff(), extra.at || iso(Date.parse(s.entry_at) + 40 * 60000), ['paid', 'waived'].includes(status) ? iso(Date.parse(s.entry_at) + 3 * 3600000) : null, ['paid', 'waived'].includes(status) ? staff() : null);
    };
    const accessible = bays.find((b) => b.kind === 'accessible');
    fine('ACCESSIBLE', left[3], 'paid', { bay: accessible && accessible.id, note: 'No permit card on the dashboard.' });
    fine('BLOCKING', left[11], 'paid', { place: 'Ramp to B2' });
    fine('VIP', left[20], 'waived', { resolution: 'Guest of the general manager.' });
    fine('DOUBLE', left[31], 'unpaid', { note: 'Left before security reached the car.' });
    fine('EV', left[44], 'unpaid', { note: 'Not charging, stayed two hours.' });
    fine('RESERVED', left[52], 'disputed', { note: 'Says the bay sign was covered.' });
    // a car inside now: fined on this visit
    const now1 = db.get("SELECT * FROM pk_sessions WHERE demo = 1 AND status = 'inside' AND kind = 'visitor' AND bay_id IS NULL ORDER BY entry_at DESC LIMIT 1");
    if (now1) {
      fine('NOPARK', now1, 'charged', { place: 'Fire lane by the south stairs', at: iso(nowMs - 25 * 60000) });
      P.addExtra(now1, (types.get('NOPARK') || { fine: 0 }).fine);
    }

    // ---------- incidents and lost property ----------
    const incident = (v) => {
      const at = iso(nowMs - v.hours * 3600000);
      const id = Number(db.run(`INSERT INTO pk_incidents (ref, kind, title, at, zone_id, place, plates, reporter_name, reporter_phone, description, status, assigned_to, resolution, claim_ref, value, item, stored_at, returned_to, returned_at, user_id, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, ref('pk_incidents', 'PI', 5), v.kind, v.title, at, b1 ? b1.id : null, v.place || null, v.plates || null, v.reporter || null, v.phone || null,
      v.description || null, v.status, staff(), v.resolution || null, v.claim || null, v.value || null, v.item || null, v.stored || null, v.returnedTo || null, v.returnedTo ? iso(nowMs - (v.hours - 20) * 3600000) : null, staff(), at, at).lastInsertRowid);
      for (const [body, st, after] of v.notes || []) db.run('INSERT INTO pk_incident_notes (incident_id, body, status_to, user_id, at) VALUES (?, ?, ?, ?, ?)', id, body, st || null, staff(), iso(Date.parse(at) + after * 60000));
    };
    incident({ kind: 'accident', title: 'Two cars touched reversing out of bays', hours: 52, place: 'Section C', plates: `${plateShow(plate())}, ${plateShow(plate())}`, reporter: 'Tamer Wagdy', phone: '01005556677', status: 'resolved', resolution: 'Both drivers exchanged insurance details; camera footage kept.', description: 'Low speed. Bumpers scratched, no one hurt.', notes: [['Camera footage from B1-C saved for 30 days.', 'investigating', 20], ['Drivers agreed between them.', 'resolved', 180]] });
    incident({ kind: 'damage', title: 'Customer reports a scratched door', hours: 20, place: 'Section F, by the pay machine', plates: plateShow(plate()), reporter: 'Laila Hamdy', phone: '01223344550', status: 'investigating', claim: 'CLM-2231', value: 3500, description: 'Noticed a long scratch on the driver’s door when returning to the car.', notes: [['Reviewing the cameras between 14:00 and 17:30.', 'investigating', 30]] });
    incident({ kind: 'security', title: 'Person trying car doors', hours: 75, place: 'Near the ramp down', status: 'closed', resolution: 'Escorted out by security; police informed.', notes: [['Security on site within three minutes.', null, 4]] });
    incident({ kind: 'lost', title: 'Car keys lost', hours: 5, place: 'Between the lifts and the food court', reporter: 'Nada Magdy', phone: '01112223300', status: 'open', item: 'Toyota key with a blue keyring', description: 'Spare key on the way.' });
    incident({ kind: 'found', title: 'Wallet found by a cleaner', hours: 30, place: 'By the lifts', status: 'closed', item: 'Brown leather wallet, ID inside', stored: 'Security office, safe box 2', returnedTo: 'Owner, ID checked' });
    incident({ kind: 'found', title: 'Child’s scooter', hours: 9, place: 'Section A', status: 'open', item: 'Pink scooter', stored: 'Security office' });

    // ---------- the safe: floats out, drops and closed tills in, the bank's collections ----------
    for (const t of db.all("SELECT * FROM pk_tills WHERE demo = 1 AND kind = 'booth' AND float > 0 ORDER BY opened_at")) {
      if (!db.get("SELECT id FROM pk_safe WHERE till_id = ? AND kind = 'float'", t.id)) P.safe('float', -t.float, { till: t.id, user: t.user_id ? { id: t.user_id } : null, at: t.opened_at, demo: 1 });
    }
    const first = db.value('SELECT MIN(at) FROM pk_safe WHERE demo = 1');
    if (first) {
      const startDay = cairo(new Date(first)).date;
      let seal = 41870;
      for (let d = startDay; d < today; d = M.addDays(d, 3)) {
        const ms = Date.parse(`${d}T09:30:00Z`);
        if (ms > nowMs) break;
        const bal = Math.round(db.value("SELECT COALESCE(SUM(amount), 0) FROM pk_safe WHERE status != 'void' AND at <= ?", iso(ms)) - 2000);
        if (bal < 500) continue;
        const inTransit = Date.parse(M.addDays(d, 3)) > Date.parse(today);
        const x = P.safe('collection', -bal, { user: { id: staff() }, bag: `BG-${++seal}`, carrier: 'Bank cash-in-transit team', reference: `CIT-${pad(seal % 1000, 4)}`, status: inTransit ? 'in_transit' : 'banked', at: iso(ms), demo: 1 });
        if (!inTransit) db.run('UPDATE pk_safe SET confirmed_amount = ?, confirmed_at = ? WHERE id = ?', r() < 0.1 ? bal - 20 : bal, iso(ms + 86400000), x.id);
      }
    }

    // ---------- alerts ----------
    const alert = (kind, level, title, detail, hoursAgo, acked) => db.run('INSERT OR IGNORE INTO pk_alerts (kind, level, title, detail, key, at, acked_at, acked_by, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
      kind, level, title, detail, `demo:${kind}:${hoursAgo}`, iso(nowMs - hoursAgo * 3600000), acked ? iso(nowMs - (hoursAgo - 0.2) * 3600000) : null, acked ? user : null);
    alert('repeat', 'warn', `Plate ${plateShow(plate())} was validated 9 times in 30 days`, null, 30, false);
    alert('manual', 'warn', `${(db.get('SELECT name FROM users WHERE id = ?', staff()) || { name: 'A cashier' }).name} opened the barrier by hand 4 times today`, null, 50, true);
    alert('readrate', 'info', 'The camera at IN-2 read 81% of plates today', 'Clean the lens or check the lighting.', 72, true);

    // ---------- subscriptions bought online ----------
    const plan = db.get("SELECT * FROM pk_plans WHERE code = 'PUBLIC-MONTHLY'");
    for (const [name, status, days] of [['Mahmoud Saber', 'active', 20], ['Heba Lotfy', 'active', 6], ['Ehab Naguib', 'pending', 0]]) {
      const p = P.savePermit({ plan_id: plan && plan.id, holder: 'individual', name, phone: `012${String(10000000 + Math.floor(r() * 89999999))}`, email: `${name.split(' ')[0].toLowerCase()}@example.com`, plates: plate(), price: plan ? plan.price : 900, months: 1, starts_on: M.addDays(today, -days), auto_renew: true, demo: 1 });
      db.run("UPDATE pk_permits SET source = 'online', access_token = ?, status = ? WHERE id = ?", token(), status, p.id);
    }

    // ---------- ETA e-receipts for the last day's payments ----------
    if (P.ereceipt && P.ereceipt.sample) {
      const pays = db.all("SELECT * FROM pk_payments WHERE demo = 1 AND status = 'ok' AND at >= ? ORDER BY at, id", iso(nowMs - 36 * 3600000));
      pays.forEach((p, i) => P.ereceipt.sample(p, i >= pays.length - 3 ? 'prepared' : 'valid'));
    }
  });
}

function clear(db) {
  if (!has(db, 'pk_bays')) return;
  db.tx(() => {
    db.run('DELETE FROM pk_ereceipts WHERE demo = 1 OR payment_id IN (SELECT id FROM pk_payments WHERE demo = 1)');
    db.run('DELETE FROM pk_account_charges WHERE demo = 1 OR account_id IN (SELECT id FROM pk_accounts WHERE demo = 1)');
    db.run('UPDATE pk_permits SET account_id = NULL WHERE account_id IN (SELECT id FROM pk_accounts WHERE demo = 1)');
    db.run('UPDATE pk_sessions SET account_id = NULL WHERE account_id IN (SELECT id FROM pk_accounts WHERE demo = 1)');
    db.run('DELETE FROM pk_accounts WHERE demo = 1');
    db.run('DELETE FROM pk_valet WHERE demo = 1');
    db.run('DELETE FROM pk_violations WHERE demo = 1');
    db.run('DELETE FROM pk_incident_notes WHERE incident_id IN (SELECT id FROM pk_incidents WHERE demo = 1)');
    db.run('DELETE FROM pk_incidents WHERE demo = 1');
    db.run('UPDATE pk_sessions SET booking_id = NULL WHERE booking_id IN (SELECT id FROM pk_bookings WHERE demo = 1)');
    db.run('DELETE FROM pk_bookings WHERE demo = 1');
    db.run('DELETE FROM pk_safe WHERE demo = 1');
    db.run('DELETE FROM pk_alerts WHERE demo = 1');
    db.run("UPDATE pk_bays SET sensor = NULL, state = NULL, state_at = NULL, plate = NULL WHERE sensor LIKE 'demo:%'");
  });
}

module.exports = { load, clear };
