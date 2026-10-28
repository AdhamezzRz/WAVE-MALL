'use strict';

// Sample data for parking: 30 days of cars at The Wave's two parking levels (busy Thursday, Friday
// and Saturday evenings, Friday after prayers), stays from a quick drop-off to a car left overnight,
// shops validating about a third of their customers' visits, cashiers' shifts at the exit booth and a
// pay machine (closed into the books, one with cash short), monthly subscriptions for tenants' staff,
// mall staff and the public (one suspended for an unpaid invoice), and the cars parked right now.
// The footfall module's hourly car-park counts are rebuilt from the same visits. Every row has demo = 1.
// Text is stored in English and shown in Arabic through tx() (i18n/ar-parking.js).

const M = require('./model');
const T = require('./parking/tariff');
const { parking, plateKey, plateShow } = require('./parking/core');
const { cairo } = require('./ops-common');
const extra = require('./demo-parking-extra');

const DAYS = 30;
const LETTERS = ['أ', 'ب', 'ج', 'د', 'ر', 'س', 'ص', 'ط', 'ع', 'ف', 'ق', 'ل', 'م', 'ن', 'ه', 'و', 'ي'];
// arrivals by hour (Cairo time) and how many a day
const SHAPE = {
  weekday: { 9: 1, 10: 2, 11: 3, 12: 4.5, 13: 6, 14: 6.5, 15: 6, 16: 6.5, 17: 7.5, 18: 9, 19: 10, 20: 10, 21: 8, 22: 5, 23: 2.5, 0: 0.8 },
  thursday: { 10: 1.5, 11: 2.2, 12: 3.4, 13: 5, 14: 5.5, 15: 5.5, 16: 6, 17: 7.5, 18: 9.5, 19: 11, 20: 12, 21: 11, 22: 8, 23: 5, 0: 2.5, 1: 0.8 },
  friday: { 10: 0.4, 11: 0.6, 12: 0.8, 13: 2, 14: 6.5, 15: 8, 16: 8.5, 17: 9, 18: 10, 19: 11, 20: 11, 21: 9.5, 22: 7, 23: 4.5, 0: 2 },
  saturday: { 10: 1.8, 11: 3, 12: 4.5, 13: 6, 14: 7, 15: 7.5, 16: 7.5, 17: 8, 18: 9, 19: 9.5, 20: 9.5, 21: 8, 22: 6, 23: 3.5, 0: 1.2 },
};
const PER_DAY = { weekday: 212, thursday: 310, friday: 385, saturday: 352 };
const MALL_REASONS = ['Customer service', 'Event guest', 'Complaint resolved', 'Management guest'];
const PEOPLE = ['Karim Mostafa', 'Dina Samir', 'Youssef Adel', 'Mariam Khaled', 'Hany Lotfy', 'Rana Fawzy', 'Tarek Nabil', 'Laila Hamdy', 'Sherif Ezz', 'Nada Magdy'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const pad = (n, w = 2) => String(n).padStart(w, '0');

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  const P = h.parking || parking(db, { billing: opts.billing || h.billing, events: h.events, ledger: h.ledger });
  if (db.value('SELECT COUNT(*) FROM pk_sessions WHERE demo = 1')) return;
  const B = opts.billing || h.billing;
  const r = rng(20261028);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const today = cairo().date;
  const t0 = iso(nowMs);
  // the UTC moment of a Cairo date and hour
  const at = (date, hour, min = 0) => {
    for (const off of [2, 3]) {
      const ms = Date.parse(`${date}T${pad(hour)}:${pad(min)}:00Z`) - off * 3600000;
      const c = cairo(new Date(ms));
      if (c.date === date && c.hour === hour) return ms;
    }
    return Date.parse(`${date}T${pad(hour)}:${pad(min)}:00Z`) - 2 * 3600000;
  };
  const plate = () => `${Array.from({ length: 2 + Math.floor(r() * 2) }, () => pick(LETTERS)).join(' ')} ${1 + Math.floor(r() * 9998)}`;
  const tariff = P.tariffAt();
  const tariffId = tariff.id;
  const zones = db.all('SELECT * FROM pk_zones WHERE active = 1 ORDER BY sort');
  const users = db.all("SELECT id, name FROM users WHERE role IN ('agent','manager') ORDER BY id").slice(0, 3);
  const cashier = (i) => (users.length ? users[i % users.length].id : admin ? admin.id : null);
  const brands = db.all("SELECT DISTINCT b.id, b.name FROM brands b JOIN leases l ON l.brand_id = b.id WHERE b.demo = 1 AND l.status = 'active' ORDER BY b.id");
  const year = new Date().getFullYear();
  let seqS = Number((db.get('SELECT ref FROM pk_sessions WHERE ref LIKE ? ORDER BY id DESC LIMIT 1', `PK-${year}-%`) || { ref: `PK-${year}-0` }).ref.split('-').pop());
  let seqP = Number((db.get('SELECT ref FROM pk_payments WHERE ref LIKE ? ORDER BY id DESC LIMIT 1', `PP-${year}-%`) || { ref: `PP-${year}-0` }).ref.split('-').pop());
  const codes = new Set(db.all('SELECT code FROM pk_sessions').map((x) => x.code));
  const newCode = () => { let c = P.newCode(); while (codes.has(c)) c = P.newCode(); codes.add(c); return c; };

  const tills = new Map();
  db.tx(() => {
    // ---------- set-up the sample adds: a second pair of gates, event prices, a blocked plate ----------
    const lane = (code, name, dir) => db.get('SELECT * FROM pk_lanes WHERE code = ?', code) || db.get('SELECT * FROM pk_lanes WHERE id = ?', Number(db.run('INSERT INTO pk_lanes (code, name, direction, demo, created_at) VALUES (?, ?, ?, 1, ?)', code, name, dir, t0).lastInsertRowid));
    const ins = [lane('IN-1', 'Main entry', 'in'), lane('IN-2', 'South entry', 'in')];
    const outs = [lane('OUT-1', 'Main exit', 'out'), lane('OUT-2', 'South exit', 'out')];
    const ev = M.addDays(today, 9);
    db.run("INSERT INTO pk_tariffs (name, kind, starts_on, ends_on, grace_min, first_hour, next_hour, round_min, daily_cap, day_rate, lost_fee, exit_min, demo, created_at, updated_at) VALUES ('Wave Nights concert', 'event', ?, ?, 15, 50, 0, 5, 50, 120, 150, 20, 1, ?, ?)", ev, M.addDays(ev, 1), t0, t0);
    db.run("INSERT INTO pk_lists (plate_key, plate, kind, reason, user_id, demo, created_at) VALUES (?, ?, 'block', 'Left without paying twice', ?, 1, ?) ON CONFLICT(plate_key) DO NOTHING", plateKey('ط ع م 4402'), plateShow('ط ع م 4402'), admin ? admin.id : null, t0);
    // shops' validation rules: one pays in full from 500, one shares half, the rest the mall's defaults
    if (brands[0]) db.run('INSERT OR REPLACE INTO pk_validators (brand_id, active, minutes, min_purchase, payer, share, monthly_cap, updated_at) VALUES (?, 1, 0, 500, \'tenant\', 100, NULL, ?)', brands[0].id, t0);
    if (brands[1]) db.run('INSERT OR REPLACE INTO pk_validators (brand_id, active, minutes, min_purchase, payer, share, monthly_cap, updated_at) VALUES (?, 1, 180, 0, \'split\', 50, 400, ?)', brands[1].id, t0);

    // ---------- subscriptions ----------
    const plan = (code) => db.get('SELECT * FROM pk_plans WHERE code = ?', code);
    // a sample NFC card number no real subscription uses
    const freeCard = () => {
      let c;
      do c = `04:${Array.from({ length: 6 }, () => Math.floor(r() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':')}`;
      while (db.get('SELECT id FROM pk_permits WHERE card_uid = ?', c.replace(/:/g, '')));
      return c;
    };
    const permits = [];
    const sub = (v) => { const p = P.savePermit({ auto_renew: true, demo: 1, ...v }); permits.push(p); return p; };
    brands.slice(0, 4).forEach((b, i) => {
      const pl = plan('TENANT-STAFF');
      for (let k = 0; k < 2; k++) sub({ plan_id: pl && pl.id, holder: 'tenant', brand_id: b.id, name: `${b.name} · ${PEOPLE[(i * 2 + k) % PEOPLE.length]}`, plates: plate(), price: pl ? pl.price : 400, months: 1, starts_on: M.addDays(today, -50 - i * 5), cars: 1 });
    });
    const emps = has(db, 'employees') ? db.all("SELECT id, name FROM employees WHERE status = 'active' AND demo = 1 ORDER BY id LIMIT 3") : [];
    for (const e of emps) sub({ plan_id: (plan('MALL-STAFF') || {}).id, holder: 'staff', employee_id: e.id, name: e.name, plates: plate(), price: 0, months: 1, starts_on: M.addDays(today, -80) });
    const pub = plan('PUBLIC-MONTHLY');
    sub({ plan_id: pub && pub.id, holder: 'individual', name: 'Karim Mostafa', phone: '01001234567', plates: plate(), price: pub ? pub.price : 900, months: 1, starts_on: M.addDays(today, -40) });
    sub({ plan_id: pub && pub.id, holder: 'individual', name: 'Rana Fawzy', phone: '01112223344', card_uid: freeCard(), plates: plate(), price: pub ? pub.price : 900, months: 1, starts_on: M.addDays(today, -25) });
    const late = sub({ plan_id: pub && pub.id, holder: 'individual', name: 'Hany Lotfy', phone: '01223334455', plates: plate(), price: pub ? pub.price : 900, months: 1, starts_on: M.addDays(today, -70), notes: 'Asked to pay by cheque at the end of each month.' });
    const vip = plan('VIP');
    sub({ plan_id: vip && vip.id, holder: 'vip', name: 'Board member', plates: plate(), price: vip ? vip.price : 2500, months: 3, starts_on: M.addDays(today, -60), notes: 'Reserved bay B1-01 by the lifts.' });
    if (B) {
      P.billPermits(today);
      // everyone paid on time except one
      for (const inv of db.all("SELECT * FROM invoices WHERE source = 'parking-permit' AND demo = 1 AND status = 'open' ORDER BY due_date")) {
        if (inv.source_id === late.id && inv.due_date < M.addDays(today, -20)) continue;
        if (inv.due_date > today) continue;
        B.recordPayment({ invoice_id: inv.id, amount: inv.total, date: M.addDays(inv.due_date, Math.floor(r() * 5)) > today ? today : M.addDays(inv.due_date, Math.floor(r() * 5)), method: pick(['transfer', 'instapay', 'cash']), reference: 'Parking subscription', demo: 1 });
      }
      P.reviewPermits(today);
    }

    // ---------- tills: two cashier shifts a day at the exit booth, one pay machine ----------
    let seqT = Number((db.get('SELECT ref FROM pk_tills WHERE ref LIKE ? ORDER BY id DESC LIMIT 1', `TL-${year}-%`) || { ref: `TL-${year}-0` }).ref.split('-').pop());
    const tillFor = (ms, kind) => {
      const c = cairo(new Date(ms));
      // the evening shift runs past midnight: its hours after midnight belong to the day before
      const day = c.hour < 3 ? M.addDays(c.date, -1) : c.date;
      const shift = kind === 'machine' ? 'M' : c.hour >= 3 && c.hour < 16 ? 'A' : 'B';
      const key = `${day}|${shift}`;
      if (!tills.has(key)) {
        const open = Math.min(ms, kind === 'machine' ? at(day, 0, 1) : shift === 'A' ? at(day, 8) : at(day, 16));
        const id = Number(db.run('INSERT INTO pk_tills (ref, name, kind, user_id, device, opened_at, float, status, demo) VALUES (?, ?, ?, ?, ?, ?, ?, \'open\', 1)',
          `TL-${year}-${pad(++seqT, 5)}`, kind === 'machine' ? 'Pay machine PM-1' : 'Exit booth', kind === 'machine' ? 'machine' : 'booth', kind === 'machine' ? null : cashier(shift === 'A' ? 0 : 1),
          kind === 'machine' ? 'PM-1' : null, iso(Math.min(open, nowMs - 60000)), kind === 'machine' ? 0 : 500).lastInsertRowid);
        tills.set(key, { id, day, shift, kind });
      }
      return tills.get(key);
    };

    // ---------- visits ----------
    const sessions = [];
    const visit = (v) => {
      const id = Number(db.run(`INSERT INTO pk_sessions (ref, code, kind, plate, plate_key, card_uid, permit_id, zone_id, tariff_id, entry_at, entry_lane_id, entry_via, exit_at, exit_lane_id, exit_via, status, lost, fee, discount, paid, paid_at, note, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      `PK-${year}-${pad(++seqS, 6)}`, newCode(), v.kind, v.plate, plateKey(v.plate), v.card || null, v.permit || null, v.zone, tariffId, iso(v.in), v.inLane.id, v.inVia,
      v.out ? iso(v.out) : null, v.out ? v.outLane.id : null, v.out ? v.outVia : null, v.out ? 'left' : 'inside', v.lost ? 1 : 0, v.fee || 0, v.discount || 0, v.paid || 0, v.paidAt ? iso(v.paidAt) : null, v.note || null, iso(v.in), iso(v.out || v.in)).lastInsertRowid);
      db.run("INSERT INTO pk_events (at, lane_id, kind, plate, decision, reason, session_id, via, demo) VALUES (?, ?, 'entry', ?, 'open', ?, ?, ?, 1)", iso(v.in), v.inLane.id, v.plate, v.kind, id, v.inVia);
      if (v.out) {
        if (v.denied) db.run("INSERT INTO pk_events (at, lane_id, kind, plate, decision, reason, amount, session_id, via, demo) VALUES (?, ?, 'deny', ?, 'closed', 'unpaid', ?, ?, 'anpr', 1)", iso(v.out - 4 * 60000), v.outLane.id, v.plate, v.denied, id);
        db.run("INSERT INTO pk_events (at, lane_id, kind, plate, decision, reason, session_id, via, demo) VALUES (?, ?, 'exit', ?, 'open', ?, ?, ?, 1)", iso(v.out), v.outLane.id, v.plate, v.kind, id, v.outVia);
      }
      sessions.push({ id, in: v.in, out: v.out });
      return id;
    };
    const payment = (sid, amount, method, ms, till, device) => {
      db.run('INSERT INTO pk_payments (ref, session_id, till_id, amount, method, reference, user_id, device, at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        `PP-${year}-${pad(++seqP, 6)}`, sid, till ? till.id : null, amount, method, null, till && till.kind !== 'machine' ? cashier(till.shift === 'A' ? 0 : 1) : null, device, iso(ms));
    };
    const validation = (sid, { brand = null, minutes = 0, value = 0, ms, via, reason = null, purchase = null, payer = 'mall', share = 0 }) => {
      db.run('INSERT INTO pk_validations (session_id, brand_id, via, minutes, whole, purchase, receipt_ref, reason, value, payer, share, at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        sid, brand, via, minutes, minutes === 0 ? 1 : 0, purchase, purchase ? String(10000 + Math.floor(r() * 89999)) : null, reason, value, payer, share, iso(ms));
      db.run("INSERT INTO pk_events (at, kind, plate, reason, session_id, via, demo) VALUES (?, 'validate', NULL, ?, ?, ?, 1)", iso(ms), brand ? 'shop' : 'mall', sid, via);
    };
    const ruleOf = (bid) => {
      const x = P.ruleFor(bid);
      return { minutes: x.minutes, payer: x.payer, share: x.payer === 'tenant' ? 100 : x.payer === 'split' ? x.share : 0, min: x.min_purchase };
    };

    for (let back = DAYS; back >= 0; back--) {
      const d = M.addDays(today, -back);
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      const kind = dow === 4 ? 'thursday' : dow === 5 ? 'friday' : dow === 6 ? 'saturday' : 'weekday';
      const shape = SHAPE[kind];
      const sum = Object.values(shape).reduce((s, x) => s + x, 0);
      const n = Math.round(PER_DAY[kind] * (0.9 + r() * 0.2) * (Number(d.slice(8)) >= 25 ? 1.08 : 1));
      for (const [hrS, w] of Object.entries(shape)) {
        const hr = Number(hrS);
        const date = hr < 6 ? M.addDays(d, 1) : d;
        const cars = Math.round((n * w) / sum);
        for (let k = 0; k < cars; k++) {
          const inMs = at(date, hr, Math.floor(r() * 60)) + Math.floor(r() * 60000);
          if (inMs > nowMs - 60000) continue;
          // how long: a few drop-offs, mostly two to four hours, some long evenings, the odd overnight
          const x = r();
          const stay = x < 0.08 ? 5 + r() * 10 : x < 0.55 ? 60 + r() * 120 : x < 0.88 ? 180 + r() * 120 : x < 0.985 ? 300 + r() * 240 : 1440 + r() * 600;
          let outMs = inMs + Math.round(stay * 60000);
          if (outMs > nowMs) outMs = null;
          const p = plate();
          const inLane = r() < 0.7 ? ins[0] : ins[1];
          const outLane = r() < 0.7 ? outs[0] : outs[1];
          const inVia = r() < 0.94 ? 'anpr' : 'ticket';
          const zone = zones.length ? (r() < 0.45 ? zones[0].id : zones[zones.length - 1].id) : null;
          const minutes = T.minutesBetween(iso(inMs), iso(outMs || nowMs));
          const gross = T.cost(tariff, minutes);
          // validations: a third by shops (at a time during the visit), a few by the mall
          const vx = r();
          let free = 0;
          let vals = [];
          if (gross > 0 && brands.length && vx < 0.34) {
            const b = pick(brands.slice(0, 8));
            const rule = ruleOf(b.id);
            const ms = inMs + Math.round(Math.min(stay * 0.7, 90 + r() * 60) * 60000);
            if (ms < nowMs) {
              const purchase = rule.min ? rule.min + Math.round(r() * 1500) : r() < 0.6 ? Math.round(200 + r() * 2400) : null;
              const value = rule.minutes === 0 ? gross : Math.max(0, gross - Math.max(0, gross - T.cost(tariff, rule.minutes)));
              vals.push({ brand: b.id, minutes: rule.minutes, ms, via: pick(['qr', 'qr', 'qr', 'plate', 'nfc']), purchase, payer: rule.payer, share: rule.share, value: outMs ? value : 0 });
              free = rule.minutes === 0 ? gross : gross - Math.max(0, gross - T.cost(tariff, rule.minutes));
            }
          } else if (gross > 0 && vx > 0.985) {
            const ms = inMs + Math.round(stay * 0.5 * 60000);
            if (ms < nowMs) { vals.push({ brand: null, minutes: 0, ms, via: 'manual', reason: pick(MALL_REASONS), value: outMs ? gross : 0 }); free = gross; }
          }
          free = T.r2(Math.min(gross, free));
          const due = T.r2(gross - free);
          let paid = 0;
          let paidAt = null;
          let outVia = 'anpr';
          let denied = 0;
          const pays = [];
          if (outMs && due > 0) {
            const how = r();
            if (how < 0.5) { pays.push([due, 'cash', outMs - 60000, 'booth']); outVia = 'booth'; denied = r() < 0.4 ? due : 0; } else if (how < 0.75) { pays.push([due, 'card', outMs - 60000, 'booth']); outVia = 'booth'; } else { pays.push([due, pick(['card', 'card', 'cash', 'wallet']), outMs - (3 + Math.floor(r() * 8)) * 60000, 'machine']); }
            paid = due;
            paidAt = pays[0][2];
          } else if (!outMs && due > 0 && r() < 0.06) {
            // paid at a machine on the way out, a minute ago
            const ms = nowMs - Math.floor(r() * 5) * 60000;
            if (ms > inMs) { pays.push([due, 'card', ms, 'machine']); paid = due; paidAt = ms; }
          }
          const sid = visit({ kind: 'visitor', plate: p, zone, in: inMs, out: outMs, inLane, outLane, inVia, outVia, fee: outMs ? gross : 0, discount: outMs ? free : 0, paid, paidAt, denied });
          for (const v of vals) validation(sid, v);
          for (const [amt, method, ms, where] of pays) payment(sid, amt, method, ms, tillFor(ms, where === 'machine' ? 'machine' : 'booth'), where === 'machine' ? 'PM-1' : 'booth');
        }
      }
      // subscribers park on working days
      if (kind !== 'friday') {
        for (const p of permits.filter((x) => x.status === 'active' || x.id === late.id)) {
          if (r() < 0.2) continue;
          const inMs = at(d, 9, Math.floor(r() * 50));
          if (inMs > nowMs) continue;
          let outMs = at(d, 22, Math.floor(r() * 59));
          if (p.holder === 'vip') outMs = inMs + (2 + r() * 4) * 3600000;
          if (outMs > nowMs) outMs = null;
          const k = p.holder === 'individual' ? 'subscriber' : p.holder;
          visit({ kind: k, plate: p.plates.split(', ')[0], card: p.card_uid, permit: p.id, zone: p.zone_id || (zones[0] && zones[0].id), in: inMs, out: outMs, inLane: ins[0], outLane: outs[0], inVia: p.card_uid ? 'card' : 'anpr', outVia: p.card_uid ? 'card' : 'anpr' });
        }
      }
    }
    // two cars left far too long, and a ticket lost at the booth
    visit({ kind: 'visitor', plate: plate(), zone: zones[0] && zones[0].id, in: nowMs - 52 * 3600000, out: null, inLane: ins[0], outLane: outs[0], inVia: 'anpr', note: 'Security checked the car: windows closed, nothing left in view.' });
    visit({ kind: 'visitor', plate: plate(), zone: zones[0] && zones[0].id, in: nowMs - 30 * 3600000, out: null, inLane: ins[1], outLane: outs[0], inVia: 'ticket' });
    const lost = visit({ kind: 'visitor', plate: plate(), zone: zones[0] && zones[0].id, in: nowMs - 3.5 * 3600000, out: null, inLane: ins[0], outLane: outs[0], inVia: 'ticket', lost: 1, note: 'Ticket reported lost.' });
    db.run("INSERT INTO pk_events (at, kind, reason, session_id, via, demo) VALUES (?, 'lost', 'lost', ?, 'booth', 1)", iso(nowMs - 10 * 60000), lost);
    // refused at the gates today
    const refuse = (reason, plateText, ms) => db.run("INSERT INTO pk_events (at, lane_id, kind, plate, decision, reason, via, demo) VALUES (?, ?, 'deny', ?, 'closed', ?, 'anpr', 1)", iso(ms), (reason === 'blocked' ? ins[0] : outs[0]).id, plateText, reason);
    refuse('blocked', plateShow('ط ع م 4402'), nowMs - 95 * 60000);
    refuse('unknown', plateShow('م ن 812'), nowMs - 40 * 60000);
    // the gates last spoke a moment ago
    for (const l of [...ins, ...outs]) db.run('UPDATE pk_lanes SET last_seen_at = ? WHERE id = ?', iso(nowMs - Math.floor(r() * 120000)), l.id);
  });

  // ---------- close the tills of past shifts (into the books), keep today's open ----------
  const nowCairo = cairo();
  const curShift = nowCairo.hour >= 3 && nowCairo.hour < 16 ? 'A' : 'B';
  const curDay = nowCairo.hour < 3 ? M.addDays(nowCairo.date, -1) : nowCairo.date;
  db.tx(() => {
    for (const x of [...tills.values()].sort((a, b) => a.id - b.id)) {
      const t = P.tillBy(x.id);
      if (!t || t.status !== 'open') continue;
      const shift = x.shift;
      if (x.day === curDay && (shift === curShift || shift === 'M')) continue;
      const tot = P.tillTotals(t);
      const r2 = rng(t.id)();
      const counted = t.kind === 'machine' ? null : r2 < 0.12 ? tot.expectedCash - (r2 < 0.06 ? 50 : 20) : r2 > 0.95 ? tot.expectedCash + 10 : tot.expectedCash;
      const closeAt = t.kind === 'machine' ? new Date(Date.parse(t.opened_at) + 24 * 3600000 - 120000).toISOString() : new Date(Date.parse(t.opened_at) + (shift === 'A' ? 8 : 10) * 3600000).toISOString();
      if (B) P.closeTill(t, { counted, user: t.user_id ? { id: t.user_id } : null, at: closeAt < new Date().toISOString() ? closeAt : new Date().toISOString(), note: counted !== null && counted < tot.expectedCash ? 'Counted twice. Short.' : null });
    }
    // what the shops' validations were worth last month, billed
    const lastMonth = M.addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    if (B) P.billValidations(lastMonth);
    db.setSetting('prk_billed_month', lastMonth);
  });

  // ---------- valet, bookings, companies, fines, incidents, the safe, alerts, e-receipts ----------
  extra.load(db, admin, { h, P, r, plate });

  // ---------- the footfall module's hourly car-park counts, from the same visits ----------
  if (has(db, 'parking')) {
    const cap = P.capacity();
    if (db.setting('demo_parking_capacity') === '1') db.setSetting('parking_capacity', String(cap));
    const start = Date.parse(`${M.addDays(today, -DAYS)}T00:00:00Z`);
    const rows = db.all("SELECT entry_at, exit_at FROM pk_sessions WHERE demo = 1 AND status != 'void'");
    const hours = new Map();
    const keyOf = (ms) => { const c = cairo(new Date(ms)); return `${c.date}T${pad(c.hour)}`; };
    for (const s of rows) {
      const a = Date.parse(s.entry_at);
      const b = s.exit_at ? Date.parse(s.exit_at) : null;
      const ka = keyOf(a);
      if (a >= start) (hours.get(ka) || hours.set(ka, { e: 0, x: 0 }).get(ka)).e++;
      if (b && b >= start) { const kb = keyOf(b); (hours.get(kb) || hours.set(kb, { e: 0, x: 0 }).get(kb)).x++; }
    }
    db.tx(() => {
      // older sample hours (from the footfall sample) scaled to this car park's size
      const old = Number(db.value("SELECT MAX(occupancy) FROM parking WHERE demo = 1 AND ts_hour < ?", keyOf(start))) || 0;
      if (old > cap && cap > 0) {
        const k = cap / old;
        db.run('UPDATE parking SET entries = CAST(entries * ? AS INTEGER), exits = CAST(exits * ? AS INTEGER), occupancy = CAST(occupancy * ? AS INTEGER), capacity = ? WHERE demo = 1 AND ts_hour < ?', k, k, k, cap, keyOf(start));
      }
      const sorted = [...hours.keys()].sort();
      for (const k of sorted) {
        const end = at(k.slice(0, 10), Number(k.slice(11)), 59) + 59999;
        const occ = rows.filter((s) => Date.parse(s.entry_at) <= end && (!s.exit_at || Date.parse(s.exit_at) > end)).length;
        const v = hours.get(k);
        db.run(`INSERT INTO parking (ts_hour, entries, exits, occupancy, capacity, source, demo, updated_at) VALUES (?, ?, ?, ?, ?, 'gates', 1, ?)
          ON CONFLICT(ts_hour) DO UPDATE SET entries = excluded.entries, exits = excluded.exits, occupancy = excluded.occupancy, capacity = excluded.capacity, source = 'gates' WHERE parking.demo = 1`,
        k, v.e, v.x, Math.min(occ, cap || occ), cap || null, new Date().toISOString());
      }
    });
  }
}

function clear(db) {
  if (!has(db, 'pk_sessions')) return;
  extra.clear(db);
  db.tx(() => {
    db.run('DELETE FROM pk_events WHERE demo = 1 OR session_id IN (SELECT id FROM pk_sessions WHERE demo = 1)');
    db.run('DELETE FROM pk_payments WHERE demo = 1 OR session_id IN (SELECT id FROM pk_sessions WHERE demo = 1)');
    db.run('DELETE FROM pk_validations WHERE demo = 1 OR session_id IN (SELECT id FROM pk_sessions WHERE demo = 1)');
    db.run('DELETE FROM pk_sessions WHERE demo = 1');
    db.run('DELETE FROM pk_tills WHERE demo = 1');
    db.run('UPDATE pk_sessions SET permit_id = NULL WHERE permit_id IN (SELECT id FROM pk_permits WHERE demo = 1)');
    db.run('DELETE FROM pk_permits WHERE demo = 1');
    db.run('DELETE FROM pk_validators WHERE brand_id IN (SELECT id FROM brands WHERE demo = 1)');
    db.run('DELETE FROM pk_lists WHERE demo = 1');
    db.run('DELETE FROM pk_tariffs WHERE demo = 1');
    db.run('DELETE FROM pk_lanes WHERE demo = 1');
    if (db.setting('prk_billed_month')) db.setSetting('prk_billed_month', '');
  });
}

module.exports = { load, clear };
