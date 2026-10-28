'use strict';

// The parking engine: one place for every rule, used by the gates (plate cameras, ticket and card
// readers), the booth, the pay machines, the visitors' pay page and the tenant portal. No screens here.
//
//   Visits (pk_sessions)      a car from the entry gate to the exit gate. Found again by its ticket code
//                             (the QR on the ticket or the phone), its plate, or the NFC card it entered with.
//   Prices (pk_tariffs)       hourly, a day rate after 24 hours, grace period, lost ticket (tariff.js).
//   Payments (pk_payments)    at the booth or a machine (in a till, pk_tills) or online (through billing
//                             and Paymob). A till's takings go to the books when it is closed.
//   Validations               a shop (through the tenant portal) or the mall makes a visit free: the whole
//                             visit or some hours. What it was worth is worked out when the car leaves and
//                             billed to the shop each month when the shop pays for it.
//   Subscriptions (permits)   monthly parking for tenants' staff, mall staff, VIPs and the public, on a plate
//                             or an NFC card, billed through billing; unpaid ones are suspended.
//   Gate log (pk_events)      every decision a gate took and why.
// Times are stored as UTC ISO strings; the office shows them in Cairo time.

const crypto = require('node:crypto');
const T = require('./tariff');
const { cairo } = require('../ops-common');

const SCHEMA = `
  CREATE TABLE pk_zones (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_ar TEXT, level TEXT,
    capacity INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'general', counted INTEGER, counted_at TEXT,
    sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE pk_lanes (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'in',
    zone_id INTEGER REFERENCES pk_zones(id) ON DELETE SET NULL, prints INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1, last_seen_at TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE pk_tariffs (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'standard', starts_on TEXT, ends_on TEXT,
    grace_min INTEGER NOT NULL DEFAULT 15, first_hour REAL NOT NULL DEFAULT 0, next_hour REAL NOT NULL DEFAULT 0,
    round_min INTEGER NOT NULL DEFAULT 5, daily_cap REAL NOT NULL DEFAULT 0, day_rate REAL NOT NULL DEFAULT 0,
    lost_fee REAL NOT NULL DEFAULT 0, exit_min INTEGER NOT NULL DEFAULT 15, active INTEGER NOT NULL DEFAULT 1,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pk_plans (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_ar TEXT, kind TEXT NOT NULL DEFAULT 'public',
    price REAL NOT NULL DEFAULT 0, months INTEGER NOT NULL DEFAULT 1, zone_id INTEGER REFERENCES pk_zones(id) ON DELETE SET NULL,
    cars INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE pk_permits (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, plan_id INTEGER REFERENCES pk_plans(id) ON DELETE SET NULL,
    holder TEXT NOT NULL DEFAULT 'individual', brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL, name TEXT NOT NULL, phone TEXT, email TEXT,
    plates TEXT, plate_keys TEXT, card_uid TEXT, zone_id INTEGER REFERENCES pk_zones(id) ON DELETE SET NULL,
    cars INTEGER NOT NULL DEFAULT 1, price REAL NOT NULL DEFAULT 0, months INTEGER NOT NULL DEFAULT 1,
    starts_on TEXT NOT NULL, ends_on TEXT, next_bill_on TEXT, auto_renew INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active', status_reason TEXT, notes TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX pk_permits_status ON pk_permits(status);
  CREATE UNIQUE INDEX pk_permits_card ON pk_permits(card_uid) WHERE card_uid IS NOT NULL AND status IN ('active','suspended');
  CREATE TABLE pk_sessions (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'visitor',
    plate TEXT, plate_key TEXT, card_uid TEXT, permit_id INTEGER REFERENCES pk_permits(id) ON DELETE SET NULL,
    zone_id INTEGER REFERENCES pk_zones(id) ON DELETE SET NULL, tariff_id INTEGER REFERENCES pk_tariffs(id) ON DELETE SET NULL,
    entry_at TEXT NOT NULL, entry_lane_id INTEGER REFERENCES pk_lanes(id) ON DELETE SET NULL, entry_via TEXT,
    exit_at TEXT, exit_lane_id INTEGER REFERENCES pk_lanes(id) ON DELETE SET NULL, exit_via TEXT,
    status TEXT NOT NULL DEFAULT 'inside', lost INTEGER NOT NULL DEFAULT 0,
    fee REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, paid REAL NOT NULL DEFAULT 0, paid_at TEXT,
    note TEXT, photo_url TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX pk_sessions_status ON pk_sessions(status, entry_at);
  CREATE INDEX pk_sessions_plate ON pk_sessions(plate_key, status);
  CREATE INDEX pk_sessions_card ON pk_sessions(card_uid, status);
  CREATE INDEX pk_sessions_exit ON pk_sessions(exit_at);
  CREATE TABLE pk_tills (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'booth',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, device TEXT, opened_at TEXT NOT NULL, float REAL NOT NULL DEFAULT 0,
    closed_at TEXT, closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, counted REAL, expected_cash REAL,
    totals TEXT, difference REAL, invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open', note TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_tills_status ON pk_tills(status);
  CREATE TABLE pk_payments (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, session_id INTEGER REFERENCES pk_sessions(id) ON DELETE CASCADE,
    till_id INTEGER REFERENCES pk_tills(id) ON DELETE SET NULL, amount REAL NOT NULL, method TEXT NOT NULL,
    reference TEXT, invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'ok',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, device TEXT, at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_payments_at ON pk_payments(at);
  CREATE INDEX pk_payments_till ON pk_payments(till_id);
  CREATE TABLE pk_validators (
    brand_id INTEGER PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE, active INTEGER NOT NULL DEFAULT 1,
    minutes INTEGER, min_purchase REAL, payer TEXT, share REAL, monthly_cap INTEGER, updated_at TEXT NOT NULL
  );
  CREATE TABLE pk_validations (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES pk_sessions(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, portal_user_id INTEGER, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    via TEXT NOT NULL DEFAULT 'code', minutes INTEGER NOT NULL DEFAULT 0, whole INTEGER NOT NULL DEFAULT 0,
    purchase REAL, receipt_ref TEXT, reason TEXT, value REAL NOT NULL DEFAULT 0, payer TEXT NOT NULL DEFAULT 'mall', share REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok', invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_validations_session ON pk_validations(session_id);
  CREATE INDEX pk_validations_brand ON pk_validations(brand_id, at);
  CREATE TABLE pk_events (
    id INTEGER PRIMARY KEY, at TEXT NOT NULL, lane_id INTEGER REFERENCES pk_lanes(id) ON DELETE SET NULL, kind TEXT NOT NULL,
    plate TEXT, credential TEXT, decision TEXT, reason TEXT, amount REAL, session_id INTEGER REFERENCES pk_sessions(id) ON DELETE SET NULL,
    via TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, photo_url TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_events_at ON pk_events(at);
  CREATE TABLE pk_lists (
    id INTEGER PRIMARY KEY, plate_key TEXT NOT NULL UNIQUE, plate TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'block',
    reason TEXT, until TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
`;

// The second step: the floor plan's bays, company accounts, bookings, valet, violations, incidents,
// the cash safe, alerts, e-receipts and the gates' offline queue.
const SCHEMA2 = `
  ALTER TABLE pk_sessions ADD COLUMN extra REAL NOT NULL DEFAULT 0;
  ALTER TABLE pk_sessions ADD COLUMN bay_id INTEGER;
  ALTER TABLE pk_sessions ADD COLUMN booking_id INTEGER;
  ALTER TABLE pk_sessions ADD COLUMN account_id INTEGER;
  ALTER TABLE pk_permits ADD COLUMN account_id INTEGER;
  ALTER TABLE pk_permits ADD COLUMN source TEXT NOT NULL DEFAULT 'office';
  ALTER TABLE pk_permits ADD COLUMN access_token TEXT;
  ALTER TABLE pk_permits ADD COLUMN plate_changes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pk_plans ADD COLUMN online INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pk_plans ADD COLUMN max_active INTEGER;
  ALTER TABLE pk_plans ADD COLUMN description TEXT;
  ALTER TABLE pk_plans ADD COLUMN description_ar TEXT;
  ALTER TABLE pk_tills ADD COLUMN drops REAL NOT NULL DEFAULT 0;
  ALTER TABLE pk_tills ADD COLUMN denominations TEXT;
  CREATE TABLE pk_bays (
    id INTEGER PRIMARY KEY, zone_id INTEGER NOT NULL REFERENCES pk_zones(id) ON DELETE CASCADE, code TEXT NOT NULL UNIQUE, section TEXT,
    x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, kind TEXT NOT NULL DEFAULT 'general',
    sensor TEXT, state TEXT, state_at TEXT, plate TEXT, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_bays_zone ON pk_bays(zone_id);
  CREATE TABLE pk_accounts (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, name TEXT NOT NULL, brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    contact_name TEXT, phone TEXT, email TEXT, tax_id TEXT, address TEXT, mode TEXT NOT NULL DEFAULT 'fixed',
    price REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, cap REAL, terms_days INTEGER NOT NULL DEFAULT 15,
    next_bill_on TEXT, status TEXT NOT NULL DEFAULT 'active', notes TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pk_account_charges (
    id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES pk_accounts(id) ON DELETE CASCADE, session_id INTEGER REFERENCES pk_sessions(id) ON DELETE SET NULL,
    plate TEXT, minutes INTEGER, amount REAL NOT NULL, at TEXT NOT NULL, invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_account_charges_account ON pk_account_charges(account_id, at);
  CREATE TABLE pk_bookings (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, plate TEXT, plate_key TEXT, name TEXT NOT NULL, phone TEXT, email TEXT,
    zone_id INTEGER REFERENCES pk_zones(id) ON DELETE SET NULL, bay_id INTEGER REFERENCES pk_bays(id) ON DELETE SET NULL,
    starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
    session_id INTEGER REFERENCES pk_sessions(id) ON DELETE SET NULL, invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'office', note TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX pk_bookings_plate ON pk_bookings(plate_key, status);
  CREATE INDEX pk_bookings_time ON pk_bookings(starts_at);
  CREATE TABLE pk_valet (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, tag INTEGER NOT NULL, session_id INTEGER REFERENCES pk_sessions(id) ON DELETE SET NULL,
    plate TEXT, plate_key TEXT, name TEXT, phone TEXT, bay_id INTEGER REFERENCES pk_bays(id) ON DELETE SET NULL, place TEXT,
    condition TEXT, notes TEXT, fee REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'received', token_hash TEXT, token TEXT,
    received_at TEXT NOT NULL, parked_at TEXT, requested_at TEXT, ready_at TEXT, delivered_at TEXT,
    received_by INTEGER REFERENCES users(id) ON DELETE SET NULL, runner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    delivered_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_valet_status ON pk_valet(status);
  CREATE TABLE pk_violation_types (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_ar TEXT, fine REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE pk_violations (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, type_id INTEGER REFERENCES pk_violation_types(id) ON DELETE SET NULL,
    plate TEXT, plate_key TEXT, session_id INTEGER REFERENCES pk_sessions(id) ON DELETE SET NULL, charged_session_id INTEGER REFERENCES pk_sessions(id) ON DELETE SET NULL,
    bay_id INTEGER REFERENCES pk_bays(id) ON DELETE SET NULL, place TEXT, note TEXT, fine REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'charged', resolution TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, at TEXT NOT NULL,
    resolved_at TEXT, resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_violations_plate ON pk_violations(plate_key, status);
  CREATE TABLE pk_incidents (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL, at TEXT NOT NULL,
    zone_id INTEGER REFERENCES pk_zones(id) ON DELETE SET NULL, bay_id INTEGER REFERENCES pk_bays(id) ON DELETE SET NULL, place TEXT,
    plates TEXT, session_id INTEGER REFERENCES pk_sessions(id) ON DELETE SET NULL, reporter_name TEXT, reporter_phone TEXT,
    description TEXT, status TEXT NOT NULL DEFAULT 'open', assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolution TEXT, claim_ref TEXT, value REAL, item TEXT, stored_at TEXT, returned_to TEXT, returned_at TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pk_incident_notes (
    id INTEGER PRIMARY KEY, incident_id INTEGER NOT NULL REFERENCES pk_incidents(id) ON DELETE CASCADE, body TEXT NOT NULL,
    status_to TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, at TEXT NOT NULL
  );
  CREATE TABLE pk_safe (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, amount REAL NOT NULL, till_id INTEGER REFERENCES pk_tills(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, witness TEXT, bag TEXT, carrier TEXT, reference TEXT, note TEXT,
    status TEXT NOT NULL DEFAULT 'done', confirmed_amount REAL, confirmed_at TEXT, at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pk_safe_at ON pk_safe(at);
  CREATE TABLE pk_alerts (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'warn', title TEXT NOT NULL, detail TEXT, key TEXT UNIQUE,
    lane_id INTEGER REFERENCES pk_lanes(id) ON DELETE SET NULL, session_id INTEGER REFERENCES pk_sessions(id) ON DELETE SET NULL,
    at TEXT NOT NULL, acked_at TEXT, acked_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE pk_ereceipts (
    id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES pk_payments(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 's',
    number TEXT NOT NULL UNIQUE, uuid TEXT, previous_uuid TEXT, reference_uuid TEXT, document TEXT, status TEXT NOT NULL DEFAULT 'prepared',
    submission_uuid TEXT, errors TEXT, issued_at TEXT NOT NULL, submitted_at TEXT, checked_at TEXT, demo INTEGER NOT NULL DEFAULT 0,
    UNIQUE (payment_id, kind)
  );
  CREATE TABLE pk_edge_events (
    id TEXT PRIMARY KEY, device TEXT, payload TEXT, result TEXT, at TEXT NOT NULL
  );
`;

// Settings (db settings, prk_*) and their defaults.
const DEFAULTS = {
  prk_val_minutes: '0', // free time a validation gives; 0 = the whole visit
  prk_val_min_purchase: '0', // the smallest purchase that earns a validation
  prk_val_payer: 'mall', // who pays for validations by default: mall, tenant or split
  prk_val_share: '50', // the shop's share (%) when split
  prk_val_cap: '0', // validations a shop may give in a month; 0 = no limit
  prk_block_full: '1', // close the entry to visitors when the car park is full
  prk_suspend_days: '30', // suspend a subscription when its invoice is this many days late
  prk_overstay_hours: '24', // flag cars parked longer than this
  prk_repeat_min: '3', // the same plate read again within this many minutes is the same arrival
  prk_valet_fee: '100', // valet, per visit
  prk_valet_parking: '0', // 0: the valet fee includes parking; 1: parking is charged as well
  prk_booking_hold_min: '30', // a booked space is held this long after the booking starts
  prk_booking_early_min: '60', // a booked car may arrive this early
};

const HOLDERS = ['tenant', 'staff', 'vip', 'individual'];
const METHODS = ['cash', 'card', 'wallet', 'instapay', 'online'];
// what a booth or machine method is called in billing (M.PAY_METHODS)
const BILL_METHOD = { cash: 'cash', card: 'card', wallet: 'wallet', instapay: 'instapay', online: 'online' };

const now = () => new Date().toISOString();
const r2 = T.r2;
// errors carry an i18n key (and its values) for the screen to translate: tr(err.message, err.params)
const fail = (key, params) => Object.assign(new Error(key), { params });
const pad = (n) => String(n).padStart(2, '0');

// ---------- identifiers ----------
// Plates: Arabic and Western digits alike, Arabic letter variants folded, letters before digits, so a
// camera reading "1234 ق ص ر" and a cashier typing "قصر 1234" find the same car.
const AR_DIG = '٠١٢٣٤٥٦٧٨٩';
const FA_DIG = '۰۱۲۳۴۵۶۷۸۹';
function plateKey(s) {
  let x = String(s ?? '').normalize('NFKC');
  x = x.replace(/[٠-٩]/g, (d) => AR_DIG.indexOf(d)).replace(/[۰-۹]/g, (d) => FA_DIG.indexOf(d));
  x = x.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/[\u064B-\u0652\u0640]/g, '');
  x = x.toUpperCase().replace(/[^A-Z0-9\u0621-\u064A]/g, '');
  const letters = x.replace(/[0-9]/g, '');
  const digits = x.replace(/[^0-9]/g, '');
  return (letters + digits).slice(0, 16);
}
// "قصر1234" → "ق ص ر 1234" (letters spaced, as on Egyptian plates); Latin plates as typed
function plateShow(s) {
  const raw = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  const k = plateKey(raw);
  if (/[\u0621-\u064A]/.test(k)) return `${k.replace(/[0-9]/g, '').split('').join(' ')} ${k.replace(/[^0-9]/g, '')}`.trim();
  return raw.toUpperCase().slice(0, 16);
}
// NFC card numbers: readers print them with colons, spaces or in lower case
const cardKey = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 32);
// Ticket codes: 8 characters without 0/O, 1/I, shown as ABCD-2345
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  const b = crypto.randomBytes(8);
  return Array.from(b, (x) => ALPHABET[x % 32]).join('');
}
const codeShow = (c) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : '');
// What someone scanned or typed: a ticket URL or code, a card number or a plate.
function readCredential(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return {};
  const url = s.match(/\/parking\/t\/([A-Za-z0-9-]{8,9})/);
  const c = (url ? url[1] : s).toUpperCase().replace(/-/g, '');
  const out = { raw: s };
  if (/^[2-9A-HJ-NP-Z]{8}$/.test(c)) out.code = c;
  if (url) return out;
  if (/^[0-9A-F:\s-]{8,32}$/i.test(s) && /\d/.test(s) && !/[\u0600-\u06FF]/.test(s)) out.card = cardKey(s);
  out.plate = plateKey(s);
  return out;
}

function parking(db, h = {}) {
  db.ensure('parking-1', SCHEMA);
  db.ensure('parking-2', SCHEMA2);
  const events = h.events || { emit() {}, on() {} };
  const S = (k) => {
    const v = db.setting(k);
    return v === undefined || v === null || v === '' ? DEFAULTS[k] : v;
  };
  const N = (k) => Number(S(k)) || 0;
  const billing = () => h.billing;

  // ---------- reference data ----------
  const zones = ({ all = false } = {}) => db.all(`SELECT * FROM pk_zones ${all ? '' : 'WHERE active = 1'} ORDER BY sort, code`);
  const capacity = () => db.value('SELECT COALESCE(SUM(capacity), 0) FROM pk_zones WHERE active = 1') || Number(db.setting('parking_capacity')) || 0;
  const laneBy = (x) => (x === null || x === undefined || x === '' ? null : typeof x === 'object' ? x : db.get('SELECT * FROM pk_lanes WHERE code = ? OR id = ?', String(x), Number(x) || -1));
  // the tariff in force at a moment: an event tariff covering that day wins over the standard one
  function tariffAt(at = now()) {
    const d = cairo(new Date(at)).date;
    return db.get("SELECT * FROM pk_tariffs WHERE active = 1 AND kind = 'event' AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?) ORDER BY starts_on DESC, id DESC LIMIT 1", d, d)
      || db.get("SELECT * FROM pk_tariffs WHERE active = 1 AND kind = 'standard' ORDER BY id LIMIT 1")
      || { id: null, name: 'Standard', ...T.DEFAULT };
  }
  const tariffOf = (s) => (s.tariff_id && db.get('SELECT * FROM pk_tariffs WHERE id = ?', s.tariff_id)) || tariffAt(s.entry_at);

  // cars inside, in total and per level (a level's own counter wins while it is fresh)
  const insideCount = () => db.value("SELECT COUNT(*) FROM pk_sessions WHERE status = 'inside'");
  function occupancy() {
    const zs = zones();
    const by = new Map(db.all("SELECT zone_id, COUNT(*) n FROM pk_sessions WHERE status = 'inside' GROUP BY zone_id").map((r) => [r.zone_id, r.n]));
    const fresh = Date.now() - 15 * 60000;
    const list = zs.map((z) => {
      const counted = z.counted !== null && z.counted !== undefined && z.counted_at && Date.parse(z.counted_at) > fresh;
      const cars = counted ? z.counted : by.get(z.id) || 0;
      return { ...z, cars: Math.min(cars, z.capacity || cars), free: Math.max(0, (z.capacity || 0) - cars), counted };
    });
    const cap = capacity();
    const cars = insideCount();
    return { zones: list, capacity: cap, cars, free: Math.max(0, cap - cars), full: cap > 0 && cars >= cap };
  }
  // the level a new car is counted on: its lane's, else the one with the most room
  function zoneFor(lane) {
    if (lane && lane.zone_id) return lane.zone_id;
    const o = occupancy();
    const best = o.zones.filter((z) => z.kind === 'general').sort((a, b) => b.free - a.free)[0] || o.zones[0];
    return best ? best.id : null;
  }

  // ---------- the gate log and the hourly counts ----------
  function log(kind, { lane = null, plate = null, credential = null, decision = null, reason = null, amount = null, session = null, via = null, user = null, photo = null, at = now(), demo = 0 } = {}) {
    db.run('INSERT INTO pk_events (at, lane_id, kind, plate, credential, decision, reason, amount, session_id, via, user_id, photo_url, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      at, lane ? lane.id : null, kind, plate || null, credential || null, decision, reason, amount, session ? session.id : null, via, user ? user.id : null, photo || null, demo ? 1 : 0);
    if (lane) db.run('UPDATE pk_lanes SET last_seen_at = ? WHERE id = ?', at, lane.id);
  }
  // The footfall module's hourly car-park counts (entries, exits, cars parked), kept by the gates.
  const hasHourly = () => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'parking'");
  function bump(field, at, demo) {
    if (demo || !hasHourly()) return;
    const c = cairo(new Date(at));
    const key = `${c.date}T${pad(c.hour)}`;
    const e = field === 'entries' ? 1 : 0;
    const x = field === 'exits' ? 1 : 0;
    db.run(`INSERT INTO parking (ts_hour, entries, exits, occupancy, capacity, source, demo, updated_at) VALUES (?, ?, ?, ?, ?, 'gates', 0, ?)
      ON CONFLICT(ts_hour) DO UPDATE SET entries = entries + excluded.entries, exits = exits + excluded.exits, occupancy = excluded.occupancy,
      capacity = excluded.capacity, source = 'gates', updated_at = excluded.updated_at`, key, e, x, insideCount(), capacity() || null, now());
  }

  // ---------- finding a car ----------
  const sessionBy = (id) => db.get('SELECT * FROM pk_sessions WHERE id = ?', id);
  const byCode = (code) => (code ? db.get('SELECT * FROM pk_sessions WHERE code = ?', String(code).toUpperCase().replace(/-/g, '')) : null);
  // the car inside that matches a credential (ticket code, card, plate)
  function findInside(cred) {
    const c = typeof cred === 'string' ? readCredential(cred) : cred || {};
    if (c.code) {
      const s = byCode(c.code);
      if (s && s.status === 'inside') return s;
    }
    if (c.card) {
      const s = db.get("SELECT * FROM pk_sessions WHERE card_uid = ? AND status = 'inside' ORDER BY id DESC LIMIT 1", c.card);
      if (s) return s;
    }
    if (c.plate) return db.get("SELECT * FROM pk_sessions WHERE plate_key = ? AND status = 'inside' ORDER BY id DESC LIMIT 1", c.plate) || null;
    return null;
  }
  const blocked = (key) => (key ? db.get("SELECT * FROM pk_lists WHERE plate_key = ? AND kind = 'block' AND (until IS NULL OR until >= ?)", key, cairo().date) : null);
  // a subscription valid today for a plate or a card
  function permitFor({ plate = '', card = '' } = {}, at = now()) {
    const d = cairo(new Date(at)).date;
    const live = "status = 'active' AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?)";
    if (card) {
      const p = db.get(`SELECT * FROM pk_permits WHERE card_uid = ? AND ${live}`, card, d, d);
      if (p) return p;
    }
    if (plate) return db.get(`SELECT * FROM pk_permits WHERE plate_keys LIKE ? AND ${live} ORDER BY id LIMIT 1`, `%,${plate},%`, d, d) || null;
    return null;
  }

  // ---------- what a visit owes ----------
  const validationsOf = (s) => db.all("SELECT * FROM pk_validations WHERE session_id = ? AND status = 'ok' ORDER BY at", s.id);
  // What a visit owes. Parking by the tariff (minus validations and a booking's prepaid time) plus
  // extras (the valet fee, fines), which validations never cancel. Subscribers, company cars and
  // (by default) valet cars pay no hourly parking. Just paid: the way to the exit is free.
  const PERMIT_KINDS = ['subscriber', 'tenant', 'staff', 'vip', 'company'];
  const bookingOf = (s) => (s.booking_id ? db.get('SELECT * FROM pk_bookings WHERE id = ?', s.booking_id) : null);
  function quoteOf(s, at = now()) {
    const vals = validationsOf(s);
    const whole = vals.some((v) => v.whole);
    const free = vals.reduce((t, v) => t + (v.whole ? 0 : v.minutes), 0);
    const end = s.status === 'inside' ? at : s.exit_at || at;
    const minutes = T.minutesBetween(s.entry_at, end);
    const extra = r2(s.extra || 0);
    const noParking = s.permit_id || PERMIT_KINDS.includes(s.kind) || (s.kind === 'valet' && !N('prk_valet_parking'));
    const t = tariffOf(s);
    const booking = s.kind === 'booking' ? bookingOf(s) : null;
    // a booking covers the time from arrival to its end
    const covered = booking ? T.minutesBetween(s.entry_at, booking.ends_at) : 0;
    const parking = (when) => (noParking ? { minutes: T.minutesBetween(s.entry_at, when), gross: 0, free: 0, net: 0 }
      : T.quote(t, { entry_at: s.entry_at, at: when, free_min: free + covered, whole, paid: 0, lost: !!s.lost }));
    const q = parking(end);
    const exitMin = Number((t || T.DEFAULT).exit_min) || 0;
    const inExitWindow = !!s.paid_at && s.paid > 0 && Date.parse(end) - Date.parse(s.paid_at) <= exitMin * 60000;
    // in the exit window the parking is what it was when they paid; extras added since are still due
    const owed = (inExitWindow ? parking(s.paid_at).net : q.net) + extra;
    const due = r2(Math.max(0, owed - (s.paid || 0)));
    return {
      minutes, gross: r2(q.gross + extra), free: r2(q.free), net: r2(q.net + extra), parking: r2(q.net), extra, paid: r2(s.paid || 0), due,
      inExitWindow: inExitWindow && due <= 0, whole, freeMin: free, covered, validations: vals, tariff: noParking ? null : t, booking,
    };
  }

  // ---------- entry ----------
  // Returns { open, reason, session, kind, message } — message is what the gate's display says.
  function entry({ lane = null, plate = '', card = '', via = null, at = now(), user = null, photo = null, demo = 0, force = false, code: given = null } = {}) {
    const L = laneBy(lane);
    const key = plateKey(plate);
    const ck = cardKey(card);
    const how = via || (ck ? 'card' : key ? 'anpr' : 'ticket');
    const shown = plateShow(plate);
    const deny = (reason) => {
      log('deny', { lane: L, plate: shown, credential: ck, decision: 'closed', reason, via: how, user, photo, at, demo });
      return { open: false, reason };
    };
    // force: the car is already in (a gate that worked offline); a blocked plate is still logged
    if (key && blocked(key)) {
      if (!force) return deny('blocked');
      log('alarm', { lane: L, plate: shown, credential: ck, decision: 'open', reason: 'blocked', via: how, at, demo });
    }
    return db.tx(() => {
      // the same car read twice, or a car that left without an exit read
      const before = (ck && db.get("SELECT * FROM pk_sessions WHERE card_uid = ? AND status = 'inside' ORDER BY id DESC LIMIT 1", ck))
        || (key && db.get("SELECT * FROM pk_sessions WHERE plate_key = ? AND status = 'inside' ORDER BY id DESC LIMIT 1", key));
      if (before) {
        if (T.minutesBetween(before.entry_at, at) <= N('prk_repeat_min')) return { open: true, repeat: true, session: before, kind: before.kind, reason: 'repeat' };
        db.run("UPDATE pk_sessions SET status = 'void', note = TRIM(COALESCE(note, '') || ' No exit was recorded; a new entry was read.'), updated_at = ? WHERE id = ?", at, before.id);
        log('alarm', { lane: L, plate: shown, credential: ck, decision: 'open', reason: 'no-exit', session: before, via: how, at, demo });
      }
      const permit = permitFor({ plate: key, card: ck }, at);
      let kind = 'visitor';
      let permitId = null;
      let accountId = null;
      let note = null;
      let booking = null;
      if (permit) {
        const inUse = db.value("SELECT COUNT(*) FROM pk_sessions WHERE permit_id = ? AND status = 'inside'", permit.id);
        const account = permit.account_id ? db.get("SELECT * FROM pk_accounts WHERE id = ? AND status = 'active'", permit.account_id) : null;
        if (permit.account_id && !account) note = `The company account of subscription ${permit.ref} is not active: parked as a visitor.`;
        else if (inUse < permit.cars) {
          kind = account ? 'company' : permit.holder === 'individual' ? 'subscriber' : permit.holder;
          permitId = permit.id;
          accountId = account ? account.id : null;
        } else note = `Subscription ${permit.ref} already has ${permit.cars} car(s) inside: parked as a visitor.`;
      }
      // a booked space: from a little before it starts until it ends
      if (kind === 'visitor' && key) {
        const early = new Date(Date.parse(at) + N('prk_booking_early_min') * 60000).toISOString();
        booking = db.get("SELECT * FROM pk_bookings WHERE plate_key = ? AND status = 'confirmed' AND starts_at <= ? AND ends_at > ? ORDER BY starts_at LIMIT 1", key, early, at);
        if (booking) kind = 'booking';
      }
      if (kind === 'visitor' && !force && N('prk_block_full') && occupancy().full) return deny('full');
      // a ticket printed by a gate while offline keeps its code
      const g = String(given || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
      let code = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(g) && !byCode(g) ? g : newCode();
      if (code !== g) while (byCode(code)) code = newCode();
      const tariff = tariffAt(at);
      const id = Number(db.run(
        `INSERT INTO pk_sessions (ref, code, kind, plate, plate_key, card_uid, permit_id, account_id, booking_id, bay_id, zone_id, tariff_id, entry_at, entry_lane_id, entry_via, status, note, photo_url, user_id, demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inside', ?, ?, ?, ?, ?, ?)`,
        db.nextRef('pk_sessions', 'PK', 6, true), code, kind, shown || null, key || null, ck || null, permitId, accountId, booking ? booking.id : null, booking ? booking.bay_id : null,
        booking && booking.zone_id ? booking.zone_id : permit && permit.zone_id ? permit.zone_id : zoneFor(L), tariff.id, at, L ? L.id : null, how, note, photo, user ? user.id : null, demo ? 1 : 0, at, at,
      ).lastInsertRowid);
      if (booking) db.run("UPDATE pk_bookings SET status = 'arrived', session_id = ?, updated_at = ? WHERE id = ?", id, at, booking.id);
      // fines left unpaid on an earlier visit come back with the car
      if (key) {
        for (const v of db.all("SELECT * FROM pk_violations WHERE plate_key = ? AND status = 'unpaid'", key)) {
          db.run("UPDATE pk_violations SET status = 'charged', charged_session_id = ? WHERE id = ?", id, v.id);
          db.run('UPDATE pk_sessions SET extra = extra + ? WHERE id = ?', v.fine, id);
        }
      }
      const s = sessionBy(id);
      log('entry', { lane: L, plate: shown, credential: ck || code, decision: 'open', reason: kind, session: s, via: how, user, photo, at, demo });
      bump('entries', at, demo);
      events.emit('parking.entry', { session: s });
      return { open: true, session: s, kind, permit: permitId ? permit : null, reason: kind };
    });
  }

  // ---------- exit ----------
  // Opens for subscribers and paid (or free) visits; otherwise says what is due.
  // manual: a person opens the barrier anyway (reason required; the amount is written off).
  function exit({ lane = null, credential = null, plate = '', card = '', code = '', via = null, at = now(), user = null, manual = false, reason = null, photo = null, demo = 0 } = {}) {
    const L = laneBy(lane);
    const c = credential ? readCredential(credential) : { code: code ? String(code).toUpperCase().replace(/-/g, '') : null, card: cardKey(card) || null, plate: plateKey(plate) || null };
    const how = via || (c.code ? 'ticket' : c.card ? 'card' : 'anpr');
    const s = findInside(c);
    if (!s) {
      log('deny', { lane: L, plate: plateShow(plate) || null, credential: c.code || c.card || null, decision: 'closed', reason: 'unknown', via: how, user, photo, at, demo });
      return { open: false, reason: 'unknown' };
    }
    const q = quoteOf(s, at);
    if (q.due > 0 && !manual) {
      log('deny', { lane: L, plate: s.plate, credential: c.code || c.card || null, decision: 'closed', reason: 'unpaid', amount: q.due, session: s, via: how, user, photo, at, demo });
      return { open: false, reason: 'unpaid', due: q.due, session: s, quote: q };
    }
    const closed = close(s, { at, lane: L, via: how, written_off: manual ? q.due : 0, reason, user, demo });
    log(manual ? 'manual' : 'exit', { lane: L, plate: s.plate, credential: c.code || c.card || null, decision: 'open', reason: manual ? reason || 'manual' : s.kind, amount: manual ? q.due : null, session: s, via: how, user, photo, at, demo });
    return { open: true, session: closed, quote: q, reason: s.kind };
  }

  // The car has left: final price, what validations were worth, the hourly count.
  function close(s, { at = now(), lane = null, via = null, written_off = 0, reason = null, demo = 0 } = {}) {
    return db.tx(() => {
      const q = quoteOf(s, at);
      const note = written_off > 0 ? `${s.note ? `${s.note} ` : ''}Barrier opened by hand with ${written_off} unpaid: ${reason || 'no reason given'}.` : s.note;
      db.run("UPDATE pk_sessions SET status = 'left', exit_at = ?, exit_lane_id = ?, exit_via = ?, fee = ?, discount = ?, note = ?, updated_at = ? WHERE id = ?",
        at, lane ? lane.id : null, via, q.gross, r2(q.free + written_off), note, at, s.id);
      // what each validation was worth: the free part of the price, shared by the minutes each one gave
      const vals = q.validations;
      if (vals.length && q.free > 0) {
        const weight = (v) => (v.whole ? Math.max(q.minutes, 1) : v.minutes);
        const sum = vals.reduce((t, v) => t + weight(v), 0) || 1;
        let left = q.free;
        vals.forEach((v, i) => {
          const value = i === vals.length - 1 ? r2(left) : r2((q.free * weight(v)) / sum);
          left = r2(left - value);
          db.run('UPDATE pk_validations SET value = ? WHERE id = ?', value, v.id);
        });
      }
      // a company car: its time goes on the company's account
      if (s.account_id) {
        const a = db.get('SELECT * FROM pk_accounts WHERE id = ?', s.account_id);
        if (a && a.mode === 'usage') {
          const t = tariffOf(s);
          let amount = r2(T.cost(t, q.minutes) * (1 - (Number(a.discount) || 0) / 100));
          if (a.cap) {
            const month = cairo(new Date(at)).date.slice(0, 7);
            const used = db.value('SELECT COALESCE(SUM(amount), 0) FROM pk_account_charges WHERE account_id = ? AND substr(at, 1, 7) = ?', a.id, month);
            amount = r2(Math.max(0, Math.min(amount, a.cap - used)));
          }
          if (amount > 0) db.run('INSERT INTO pk_account_charges (account_id, session_id, plate, minutes, amount, at, demo) VALUES (?, ?, ?, ?, ?, ?, ?)', a.id, s.id, s.plate, q.minutes, amount, at, s.demo);
        }
      }
      if (s.booking_id) db.run("UPDATE pk_bookings SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'arrived'", at, s.booking_id);
      // fines on this visit: paid with it, or written off with the barrier opened by hand
      db.run('UPDATE pk_violations SET status = ?, resolved_at = ? WHERE charged_session_id = ? AND status = \'charged\'', written_off > 0 ? 'waived' : 'paid', at, s.id);
      bump('exits', at, demo || s.demo);
      const out = sessionBy(s.id);
      events.emit('parking.exit', { session: out });
      return out;
    });
  }

  // An extra charge on a visit inside (a valet fee, a fine): due at the exit, never validated away.
  function addExtra(s, amount) {
    db.run('UPDATE pk_sessions SET extra = MAX(0, extra + ?), updated_at = ? WHERE id = ?', r2(amount), now(), s.id);
    return sessionBy(s.id);
  }

  // ---------- payments ----------
  function pay(s, { amount, method = 'cash', till = null, user = null, device = null, reference = null, invoice_id = null, at = now(), demo = 0 } = {}) {
    if (!s) throw fail('prk|That visit no longer exists.');
    if (!METHODS.includes(method)) throw fail('prk|Choose how the visitor paid.');
    const amt = r2(amount);
    if (!(amt > 0)) throw fail('prk|Enter the amount received.');
    if (method !== 'online' && !till) throw fail('prk|Open a till before taking money.');
    if (till && till.status !== 'open') throw fail('prk|This till is closed.');
    return db.tx(() => {
      const id = Number(db.run('INSERT INTO pk_payments (ref, session_id, till_id, amount, method, reference, invoice_id, user_id, device, at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('pk_payments', 'PP', 6, true), s.id, till ? till.id : null, amt, method, reference, invoice_id, user ? user.id : null, device, at, demo || s.demo ? 1 : 0).lastInsertRowid);
      db.run('UPDATE pk_sessions SET paid = paid + ?, paid_at = ?, updated_at = ? WHERE id = ?', amt, at, at, s.id);
      const p = db.get('SELECT * FROM pk_payments WHERE id = ?', id);
      events.emit('parking.paid', { session: sessionBy(s.id), payment: p });
      return p;
    });
  }
  // A lost ticket: the lost-ticket fee is added to what is due.
  function markLost(s, { user = null } = {}) {
    if (!s || s.status !== 'inside' || s.kind !== 'visitor') throw fail('prk|Only a visitor’s car inside can have a lost ticket.');
    db.run("UPDATE pk_sessions SET lost = 1, note = TRIM(COALESCE(note, '') || ' Ticket reported lost.'), updated_at = ? WHERE id = ?", now(), s.id);
    log('lost', { plate: s.plate, session: s, user, reason: 'lost', demo: s.demo });
    return sessionBy(s.id);
  }

  // ---------- validations ----------
  // The rule a shop works by (its own, else the mall's defaults).
  function ruleFor(brandId) {
    const own = brandId ? db.get('SELECT * FROM pk_validators WHERE brand_id = ?', brandId) : null;
    const pick = (k, d) => (own && own[k] !== null && own[k] !== undefined ? own[k] : d);
    return {
      active: own ? !!own.active : true,
      minutes: Number(pick('minutes', N('prk_val_minutes'))),
      min_purchase: Number(pick('min_purchase', N('prk_val_min_purchase'))),
      payer: brandId ? pick('payer', S('prk_val_payer')) : 'mall',
      share: Number(pick('share', S('prk_val_payer') === 'tenant' ? 100 : N('prk_val_share'))),
      monthly_cap: Number(pick('monthly_cap', N('prk_val_cap'))),
      own: !!own,
    };
  }
  // A shop (brandId) or the mall (brandId null, with a reason) makes a visit free or partly free.
  function validate(s, { brandId = null, via = 'code', minutes = null, purchase = null, receipt = null, reason = null, user = null, portalUser = null, at = now(), demo = 0 } = {}) {
    if (!s) throw fail('prk|We could not find that car. Check the code or the plate.');
    if (s.status !== 'inside') throw fail('prk|This car has already left.');
    if (s.kind !== 'visitor') throw fail('prk|This car parks on a subscription: nothing to validate.');
    const rule = ruleFor(brandId);
    if (!rule.active) throw fail('prk|Parking validation is not switched on for your store. Ask the mall management.');
    if (!brandId && !reason) throw fail('prk|Give a reason for the mall’s validation.');
    if (brandId && db.get("SELECT id FROM pk_validations WHERE session_id = ? AND brand_id = ? AND status = 'ok'", s.id, brandId)) throw fail('prk|Your store has already validated this visit.');
    const amount = purchase === null || purchase === '' ? null : r2(purchase);
    if (brandId && rule.min_purchase > 0 && !(amount >= rule.min_purchase)) throw fail('prk|Validation needs a purchase of at least {amount}.', { amount: rule.min_purchase });
    if (brandId && rule.monthly_cap > 0) {
      const month = cairo(new Date(at)).date.slice(0, 7);
      const used = db.value("SELECT COUNT(*) FROM pk_validations WHERE brand_id = ? AND status = 'ok' AND substr(at, 1, 7) = ?", brandId, month);
      if (used >= rule.monthly_cap) throw fail('prk|Your store has used all its validations for this month.');
    }
    const mins = minutes === null || minutes === undefined || minutes === '' ? rule.minutes : Math.max(0, Math.round(Number(minutes)));
    const payer = brandId ? rule.payer : 'mall';
    const share = payer === 'tenant' ? 100 : payer === 'split' ? Math.min(100, Math.max(0, rule.share)) : 0;
    const id = Number(db.run('INSERT INTO pk_validations (session_id, brand_id, portal_user_id, user_id, via, minutes, whole, purchase, receipt_ref, reason, payer, share, at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      s.id, brandId, portalUser ? portalUser.id : null, user ? user.id : null, via, mins, mins === 0 ? 1 : 0, amount, receipt || null, reason || null, payer, share, at, demo || s.demo ? 1 : 0).lastInsertRowid);
    log('validate', { plate: s.plate, session: s, user, reason: brandId ? 'shop' : 'mall', via, at, demo: demo || s.demo });
    const v = db.get('SELECT * FROM pk_validations WHERE id = ?', id);
    events.emit('parking.validated', { session: s, validation: v });
    return { validation: v, quote: quoteOf(sessionBy(s.id), at) };
  }
  function unvalidate(id, { user = null } = {}) {
    const v = db.get('SELECT v.*, s.status session_status FROM pk_validations v JOIN pk_sessions s ON s.id = v.session_id WHERE v.id = ?', id);
    if (!v || v.status !== 'ok') throw fail('prk|That validation is not active.');
    if (v.session_status !== 'inside') throw fail('prk|The car has left; the validation stays as it was.');
    db.run("UPDATE pk_validations SET status = 'void' WHERE id = ?", id);
    log('unvalidate', { session: { id: v.session_id }, user, reason: 'void', demo: v.demo });
    return v;
  }

  // ---------- the cash safe: every movement of cash in or out ----------
  function safe(kind, amount, { till = null, user = null, witness = null, bag = null, carrier = null, reference = null, note = null, status = 'done', at = now(), demo = 0 } = {}) {
    const id = Number(db.run('INSERT INTO pk_safe (ref, kind, amount, till_id, user_id, witness, bag, carrier, reference, note, status, at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      db.nextRef('pk_safe', 'SF', 5, true), kind, r2(amount), till, user ? user.id : null, witness, bag, carrier, reference, note, status, at, demo ? 1 : 0).lastInsertRowid);
    return db.get('SELECT * FROM pk_safe WHERE id = ?', id);
  }
  const safeBalance = () => r2(db.value("SELECT COALESCE(SUM(amount), 0) FROM pk_safe WHERE status != 'void'"));
  // Cash taken out of a drawer during a shift into the safe.
  function drop(till, { amount, user = null, witness = null, at = now() } = {}) {
    if (!till || till.status !== 'open') throw fail('prk|This till is closed.');
    const amt = r2(amount);
    if (!(amt > 0)) throw fail('prk|Enter the amount.');
    if (amt > tillTotals(till).expectedCash) throw fail('prk|The drawer does not have that much cash.');
    return db.tx(() => {
      db.run('UPDATE pk_tills SET drops = drops + ? WHERE id = ?', amt, till.id);
      return safe('drop', amt, { till: till.id, user, witness, at, demo: till.demo });
    });
  }

  // ---------- tills (a cashier's shift, or a pay machine's day) ----------
  const tillBy = (id) => db.get('SELECT * FROM pk_tills WHERE id = ?', id);
  const openTillOf = (userId) => db.get("SELECT * FROM pk_tills WHERE status = 'open' AND kind = 'booth' AND user_id = ? ORDER BY id DESC LIMIT 1", userId);
  function openTill({ user, name = 'Exit booth', float = 0, at = now(), demo = 0 } = {}) {
    if (!user) throw fail('prk|Sign in to open a till.');
    if (openTillOf(user.id)) throw fail('prk|You already have an open till.');
    return db.tx(() => {
      const id = Number(db.run('INSERT INTO pk_tills (ref, name, kind, user_id, opened_at, float, status, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('pk_tills', 'TL', 5, true), String(name).slice(0, 60), 'booth', user.id, at, r2(Math.max(0, float)), 'open', demo ? 1 : 0).lastInsertRowid);
      // the starting cash comes out of the safe
      if (float > 0) safe('float', -r2(float), { till: id, user, at, demo });
      return tillBy(id);
    });
  }
  // a pay machine's till for the day (opened by itself, closed by the nightly job)
  function machineTill(device, at = now()) {
    const d = cairo(new Date(at)).date;
    const open = db.get("SELECT * FROM pk_tills WHERE kind = 'machine' AND device = ? AND status = 'open' ORDER BY id DESC LIMIT 1", device);
    if (open && cairo(new Date(open.opened_at)).date === d) return open;
    if (open) closeTill(open, { counted: null, at });
    const id = Number(db.run("INSERT INTO pk_tills (ref, name, kind, device, opened_at, status) VALUES (?, ?, 'machine', ?, ?, 'open')",
      db.nextRef('pk_tills', 'TL', 5, true), `Pay machine ${device}`, device, at).lastInsertRowid);
    return tillBy(id);
  }
  function tillTotals(till) {
    const rows = db.all("SELECT method, COUNT(*) n, SUM(amount) total FROM pk_payments WHERE till_id = ? AND status = 'ok' GROUP BY method", till.id);
    const by = Object.fromEntries(rows.map((r) => [r.method, { n: r.n, total: r2(r.total) }]));
    const total = r2(rows.reduce((t, r) => t + r.total, 0));
    return { by, total, count: rows.reduce((t, r) => t + r.n, 0), drops: r2(till.drops || 0), expectedCash: r2((till.float || 0) + ((by.cash && by.cash.total) || 0) - (till.drops || 0)) };
  }
  // Closing a till: cash counted against what the system expects, and the takings into the books
  // (one invoice for the shift, paid by each method; a cash difference as its own entry).
  function closeTill(till, { counted = null, user = null, note = null, at = now() } = {}) {
    if (!till || till.status !== 'open') throw fail('prk|This till is already closed.');
    const tot = tillTotals(till);
    const countedCash = counted === null || counted === undefined || counted === '' ? tot.expectedCash : r2(counted);
    const diff = r2(countedCash - tot.expectedCash);
    return db.tx(() => {
      let invoiceId = null;
      const B = billing();
      if (tot.total > 0 && B) {
        const day = cairo(new Date(at)).date;
        const inv = B.createInvoice({
          kind: 'parking', customer: 'Parking takings', total: tot.total, vat_included: true, due_date: day, period_start: cairo(new Date(till.opened_at)).date, period_end: day,
          note: `Parking till ${till.ref}`, source: 'parking-till', source_id: till.id, demo: till.demo,
        }, { user });
        invoiceId = inv.id;
        for (const [m, v] of Object.entries(tot.by)) {
          if (v.total > 0) B.recordPayment({ invoice_id: inv.id, amount: v.total, date: day, method: BILL_METHOD[m] || 'cash', reference: till.ref, note: 'Parking till', demo: till.demo }, { user });
        }
      }
      db.run("UPDATE pk_tills SET status = 'closed', closed_at = ?, closed_by = ?, counted = ?, expected_cash = ?, totals = ?, difference = ?, invoice_id = ?, note = ? WHERE id = ?",
        at, user ? user.id : null, countedCash, tot.expectedCash, JSON.stringify(tot.by), diff, invoiceId, note, till.id);
      // the counted cash goes into the safe
      if (countedCash > 0) safe('till', countedCash, { till: till.id, user, at, demo: till.demo });
      // over or short: into the books as cash differences
      if (diff && h.ledger && typeof h.ledger.post === 'function') {
        try {
          const L = h.ledger;
          const cashCode = L.S('method_cash', '');
          const cashAcc = cashCode && L.byCode(cashCode) ? L.byCode(cashCode).id : 'petty_cash';
          const day = L.firstOpen(cairo(new Date(at)).date);
          const lines = diff < 0
            ? [{ account: 'exp_other', debit: -diff, memo: 'Cash short' }, { account: cashAcc, credit: -diff }]
            : [{ account: cashAcc, debit: diff }, { account: 'inc_other', credit: diff, memo: 'Cash over' }];
          L.post({ date: day, memo: `Parking till ${till.ref}: cash ${diff < 0 ? 'short' : 'over'} ${Math.abs(diff)}`, kind: 'auto', source: `pktill:${till.id}#1`, lines, user, demo: till.demo });
        } catch (err) {
          console.error('[parking] till difference not posted:', err.message);
        }
      }
      return tillBy(till.id);
    });
  }

  // ---------- subscriptions ----------
  const addMonths = (iso, n) => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
    const dt = new Date(Date.UTC(y, m - 1 + n, Math.min(d, last)));
    return dt.toISOString().slice(0, 10);
  };
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const platesOf = (text) => [...new Set(String(text || '').split(/[,،;\n]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 6);
  function savePermit(v, { id = null, user = null } = {}) {
    const plates = platesOf(v.plates);
    const keys = plates.map(plateKey).filter(Boolean);
    const card = cardKey(v.card_uid) || null;
    if (!keys.length && !card) throw fail('prk|Add a plate or a card number.');
    if (!String(v.name || '').trim()) throw fail('prk|Give the name the subscription is for.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.starts_on || ''))) throw fail('prk|Choose the start date.');
    if (v.ends_on && v.ends_on < v.starts_on) throw fail('prk|The end date is before the start date.');
    if (card && db.get("SELECT id FROM pk_permits WHERE card_uid = ? AND status IN ('active','suspended') AND id != ?", card, id || 0)) throw fail('prk|That card is already used by another subscription.');
    const holder = HOLDERS.includes(v.holder) ? v.holder : 'individual';
    if (holder === 'tenant' && !v.brand_id) throw fail('prk|Choose the tenant.');
    const months = Math.max(1, Math.min(12, Math.round(Number(v.months) || 1)));
    const row = {
      plan_id: v.plan_id || null, holder, brand_id: holder === 'tenant' ? v.brand_id : null, employee_id: holder === 'staff' ? v.employee_id || null : null,
      name: String(v.name).trim().slice(0, 120), phone: v.phone || null, email: v.email || null, plates: plates.map(plateShow).join(', ') || null,
      plate_keys: keys.length ? `,${keys.join(',')},` : null, card_uid: card, zone_id: v.zone_id || null, cars: Math.max(1, Math.min(10, Math.round(Number(v.cars) || 1))),
      price: r2(Math.max(0, Number(v.price) || 0)), months, starts_on: v.starts_on, ends_on: v.ends_on || null, auto_renew: v.auto_renew ? 1 : 0, notes: v.notes || null,
    };
    const t = now();
    if (id) {
      db.run(`UPDATE pk_permits SET plan_id = ?, holder = ?, brand_id = ?, employee_id = ?, name = ?, phone = ?, email = ?, plates = ?, plate_keys = ?, card_uid = ?, zone_id = ?, cars = ?,
        price = ?, months = ?, starts_on = ?, ends_on = ?, auto_renew = ?, notes = ?, updated_at = ? WHERE id = ?`,
      ...Object.values(row), t, id);
      return db.get('SELECT * FROM pk_permits WHERE id = ?', id);
    }
    const nid = Number(db.run(`INSERT INTO pk_permits (ref, plan_id, holder, brand_id, employee_id, name, phone, email, plates, plate_keys, card_uid, zone_id, cars, price, months, starts_on, ends_on, auto_renew, notes, next_bill_on, status, demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    db.nextRef('pk_permits', 'PS', 4, true), ...Object.values(row), row.price > 0 ? row.starts_on : null, v.demo ? 1 : 0, t, t).lastInsertRowid);
    return db.get('SELECT * FROM pk_permits WHERE id = ?', nid);
  }
  function setPermitStatus(p, status, reason = null) {
    if (!['active', 'suspended', 'cancelled', 'expired', 'pending'].includes(status)) throw fail('prk|Unknown status.');
    db.run('UPDATE pk_permits SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', status, reason, now(), p.id);
    return db.get('SELECT * FROM pk_permits WHERE id = ?', p.id);
  }
  // Bill subscriptions that are due (one invoice per period, in advance), renewing them as they go.
  function billPermits(today = cairo().date, { user = null } = {}) {
    const B = billing();
    if (!B) return 0;
    let n = 0;
    for (const p of db.all("SELECT * FROM pk_permits WHERE status IN ('active','suspended') AND price > 0 AND account_id IS NULL AND source != 'pending' AND next_bill_on IS NOT NULL AND next_bill_on <= ?", today)) {
      db.tx(() => {
        let next = p.next_bill_on;
        let ends = p.ends_on;
        // a few periods at most per run, so a long-forgotten subscription does not flood the books
        for (let k = 0; k < 3 && next <= today; k++) {
          if (ends && next > ends) {
            if (!p.auto_renew) break;
            ends = addDays(addMonths(next, p.months), -1);
          }
          const end = addDays(addMonths(next, p.months), -1);
          B.createInvoice({
            kind: 'parking', brand_id: p.holder === 'tenant' ? p.brand_id : null, customer: p.holder === 'tenant' ? null : p.name, total: p.price, vat_included: true,
            period_start: next, period_end: end, due_date: next, note: `Parking subscription ${p.ref} · ${p.plates || p.card_uid}`, source: 'parking-permit', source_id: p.id, demo: p.demo,
          }, { user });
          next = addMonths(next, p.months);
          n++;
        }
        db.run('UPDATE pk_permits SET next_bill_on = ?, ends_on = ?, updated_at = ? WHERE id = ?', next, ends, now(), p.id);
      });
    }
    return n;
  }
  // Ended, unpaid and paid-again subscriptions; staff who left.
  function reviewPermits(today = cairo().date) {
    const out = { expired: 0, suspended: 0, restored: 0, cancelled: 0 };
    for (const p of db.all("SELECT id FROM pk_permits WHERE status = 'active' AND ends_on IS NOT NULL AND ends_on < ? AND auto_renew = 0", today)) {
      db.run("UPDATE pk_permits SET status = 'expired', updated_at = ? WHERE id = ?", now(), p.id);
      out.expired++;
    }
    const hasEmployees = !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'employees'");
    if (hasEmployees) {
      for (const p of db.all("SELECT p.id FROM pk_permits p JOIN employees e ON e.id = p.employee_id WHERE p.status IN ('active','suspended') AND p.holder = 'staff' AND e.status != 'active'")) {
        db.run("UPDATE pk_permits SET status = 'cancelled', status_reason = 'left', updated_at = ? WHERE id = ?", now(), p.id);
        out.cancelled++;
      }
    }
    const late = addDays(today, -N('prk_suspend_days'));
    const overdue = "EXISTS (SELECT 1 FROM invoices i WHERE i.source = 'parking-permit' AND i.source_id = p.id AND i.status IN ('open','partial') AND i.due_date < ?)";
    for (const p of db.all(`SELECT id FROM pk_permits p WHERE status = 'active' AND ${overdue}`, late)) {
      db.run("UPDATE pk_permits SET status = 'suspended', status_reason = 'unpaid', updated_at = ? WHERE id = ?", now(), p.id);
      out.suspended++;
    }
    for (const p of db.all(`SELECT id FROM pk_permits p WHERE status = 'suspended' AND status_reason = 'unpaid' AND NOT ${overdue}`, late)) {
      db.run("UPDATE pk_permits SET status = 'active', status_reason = NULL, updated_at = ? WHERE id = ?", now(), p.id);
      out.restored++;
    }
    return out;
  }

  // ---------- billing shops for their validations ----------
  // For a month (YYYY-MM): one invoice per shop for its share of what its validations were worth.
  function billValidations(month, { user = null } = {}) {
    const B = billing();
    if (!B) return [];
    const rows = db.all(`SELECT v.brand_id, COUNT(*) n, SUM(v.value * v.share / 100.0) amount FROM pk_validations v JOIN pk_sessions s ON s.id = v.session_id
      WHERE v.status = 'ok' AND v.brand_id IS NOT NULL AND v.payer != 'mall' AND v.invoice_id IS NULL AND s.status = 'left' AND substr(v.at, 1, 7) = ? GROUP BY v.brand_id`, month);
    const out = [];
    for (const r of rows) {
      const amount = r2(r.amount);
      if (!(amount > 0)) continue;
      db.tx(() => {
        const [y, m] = month.split('-').map(Number);
        const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        const inv = B.createInvoice({
          kind: 'parking', brand_id: r.brand_id, total: amount, vat_included: true, period_start: `${month}-01`, period_end: end, due_date: addDays(end, 15),
          note: `Parking validations for ${month}: ${r.n} visits`, source: 'parking-validations', source_id: Number(month.replace('-', '')),
          demo: db.value('SELECT MAX(demo) FROM pk_validations WHERE brand_id = ? AND substr(at, 1, 7) = ?', r.brand_id, month) || 0,
        }, { user });
        db.run(`UPDATE pk_validations SET invoice_id = ? WHERE brand_id = ? AND status = 'ok' AND payer != 'mall' AND invoice_id IS NULL AND substr(at, 1, 7) = ?
          AND session_id IN (SELECT id FROM pk_sessions WHERE status = 'left')`, inv.id, r.brand_id, month);
        out.push(inv);
      });
    }
    return out;
  }

  // ---------- paying online (the visitor's phone) ----------
  // An invoice for what is due now, then the shared checkout (payments.js). Returns the next URL.
  async function payOnline(s, { method, walletPhone = '', lang = 'en' } = {}) {
    if (!h.payments || !h.payments.begin) throw fail('prk|Online payment is not available. Pay at a machine or at the exit.');
    const q = quoteOf(s);
    if (s.status !== 'inside' || !(q.due > 0)) throw fail('prk|Nothing to pay.');
    const B = billing();
    // an earlier attempt that was never paid makes way for this one
    for (const old of db.all("SELECT id FROM invoices WHERE source = 'parking' AND source_id = ? AND status = 'open' AND paid = 0", s.id)) B.voidInvoice(old.id, { note: 'Replaced by a new payment attempt' });
    const inv = B.createInvoice({ kind: 'parking', customer: `Parking ${s.plate || codeShow(s.code)}`, total: q.due, vat_included: true, due_date: cairo().date, note: `Parking visit ${s.ref}`, source: 'parking', source_id: s.id, demo: s.demo });
    return h.payments.begin(inv, { method, walletPhone, source: 'parking', lang });
  }
  // money confirmed by the payment service: onto the visit, once
  events.on('payment.received', ({ invoice, payment }) => {
    if (!invoice || invoice.source !== 'parking' || !invoice.source_id) return;
    if (db.get('SELECT id FROM pk_payments WHERE invoice_id = ? AND reference = ?', invoice.id, payment.ref)) return;
    const s = sessionBy(invoice.source_id);
    if (s) pay(s, { amount: payment.amount, method: 'online', reference: payment.ref, invoice_id: invoice.id, demo: invoice.demo });
  });
  events.on('payment.reversed', ({ invoice, payment }) => {
    if (!invoice || invoice.source !== 'parking' || !payment) return;
    const p = db.get("SELECT * FROM pk_payments WHERE invoice_id = ? AND reference = ? AND status = 'ok'", invoice.id, payment.ref);
    if (!p) return;
    db.run("UPDATE pk_payments SET status = 'refunded' WHERE id = ?", p.id);
    db.run('UPDATE pk_sessions SET paid = MAX(0, paid - ?), updated_at = ? WHERE id = ?', p.amount, now(), p.session_id);
    events.emit('parking.refunded', { payment: db.get('SELECT * FROM pk_payments WHERE id = ?', p.id) });
  });
  // checkouts started and never finished: their invoices are voided
  function sweepOnline(hours = 3) {
    const before = new Date(Date.now() - hours * 3600000).toISOString();
    let n = 0;
    for (const inv of db.all("SELECT id FROM invoices WHERE source = 'parking' AND status = 'open' AND paid = 0 AND created_at < ?", before)) {
      if (billing().voidInvoice(inv.id, { note: 'Online parking payment not completed' })) n++;
    }
    return n;
  }

  // ---------- the gate API ----------
  // What the gate's display shows, in both languages.
  function message(r, i18n) {
    // amounts in each display's own way: "40 EGP" and "40 ج.م"
    const both = (key, p = {}) => ({
      en: i18n.run('en', () => i18n.t(key, { ...p, amount: p.amount === undefined ? undefined : `${Number(p.amount).toLocaleString('en-US')} EGP` })),
      ar: i18n.run('ar', () => i18n.t(key, { ...p, amount: p.amount === undefined ? undefined : `${Number(p.amount).toLocaleString('en-US')} ج.م` })),
    });
    if (r.open) {
      if (r.session && r.session.status === 'left') return both('prk|Thank you. Drive safely.');
      if (r.reason && r.reason !== 'visitor' && r.reason !== 'repeat') return both('prk|Welcome back.');
      return both('prk|Welcome to The Wave.');
    }
    return {
      full: both('prk|Car park full. Please come back shortly.'),
      blocked: both('prk|Please wait: security will assist you.'),
      unknown: both('prk|No entry found. Please press the help button.'),
      unpaid: both('prk|Please pay {amount} at a machine or the booth.', { amount: r.due || 0 }),
    }[r.reason] || both('prk|Please press the help button.');
  }

  return {
    SCHEMA, SCHEMA2, DEFAULTS, HOLDERS, METHODS, PERMIT_KINDS, S, N, fail, bookingOf, addExtra,
    plateKey, plateShow, cardKey, codeShow, readCredential, newCode,
    zones, capacity, occupancy, laneBy, tariffAt, tariffOf, insideCount,
    sessionBy, byCode, findInside, permitFor, blocked, quoteOf, validationsOf,
    entry, exit, close, pay, markLost, ruleFor, validate, unvalidate,
    tillBy, openTillOf, openTill, machineTill, tillTotals, closeTill, safe, safeBalance, drop,
    savePermit, setPermitStatus, billPermits, reviewPermits, billValidations, payOnline, sweepOnline,
    log, message, addMonths, addDays, platesOf,
  };
}

module.exports = { parking, SCHEMA, DEFAULTS, plateKey, plateShow, cardKey, readCredential, codeShow };
