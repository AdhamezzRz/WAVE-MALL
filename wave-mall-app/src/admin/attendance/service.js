'use strict';

// Attendance: the data and the rules applied to it. The office pages (routes/attendance.js) and the
// staff app (attendance/staff.js) both go through this; nothing else writes attendance records.
//
//   A person clocks in, takes breaks and clocks out from their own registered phone, within the
//   mall's circle (settings). Each attempt is judged on the server (engine.verdict) and kept —
//   refused ones too, with the reasons. While they are clocked in with the app open, the phone sends
//   its position every few minutes (pings): inside or outside the circle. A day's record (present,
//   late, left early, overtime, absent, on leave, holiday, day off) is computed from the punches,
//   the shift, approved leave and the holiday list whenever it is read, so it is never stale.

const crypto = require('node:crypto');
const i18n = require('../i18n');
const E = require('./engine');

const { t: tr } = i18n;

const SCHEMA = `
  CREATE TABLE att_shifts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_hm TEXT NOT NULL, end_hm TEXT NOT NULL, days TEXT NOT NULL DEFAULT '1234567',
    grace_min INTEGER, break_min INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT 'sea', active INTEGER NOT NULL DEFAULT 1,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE att_assign (
    id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    shift_id INTEGER NOT NULL REFERENCES att_shifts(id) ON DELETE CASCADE, starts TEXT NOT NULL, ends TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX att_assign_emp ON att_assign(employee_id, starts);
  CREATE TABLE att_creds (
    employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE, pin_hash TEXT, pin_set_at TEXT,
    pin_set_by INTEGER REFERENCES users(id) ON DELETE SET NULL, failed INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
    consent_at TEXT, consent_version INTEGER, last_login_at TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE att_devices (
    id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
    label TEXT, agent TEXT, ip TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_at TEXT, last_seen_at TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX att_devices_emp ON att_devices(employee_id, status);
  CREATE TABLE att_logins (
    id TEXT PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES att_devices(id) ON DELETE CASCADE, csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE att_handoffs (
    id TEXT PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used_at TEXT
  );
  CREATE TABLE att_punches (
    id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, kind TEXT NOT NULL,
    at TEXT NOT NULL, work_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'accepted', reasons TEXT, flags TEXT,
    lat REAL, lng REAL, accuracy REAL, distance REAL, taken_at TEXT, device_id INTEGER REFERENCES att_devices(id) ON DELETE SET NULL,
    ip TEXT, agent TEXT, selfie TEXT, source TEXT NOT NULL DEFAULT 'app', note TEXT, by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
    replaces_id INTEGER REFERENCES att_punches(id) ON DELETE SET NULL, request_id INTEGER,
    voided_at TEXT, voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, void_note TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX att_punches_emp ON att_punches(employee_id, at);
  CREATE INDEX att_punches_day ON att_punches(work_date, employee_id);
  CREATE TABLE att_pings (
    id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, at TEXT NOT NULL,
    lat REAL, lng REAL, accuracy REAL, distance REAL, inside INTEGER, visible INTEGER NOT NULL DEFAULT 1,
    device_id INTEGER REFERENCES att_devices(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX att_pings_emp ON att_pings(employee_id, at);
  CREATE TABLE att_beats (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, at TEXT NOT NULL, path TEXT, active INTEGER NOT NULL DEFAULT 1,
    demo INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, at)
  );
  CREATE INDEX att_beats_at ON att_beats(at);
  CREATE TABLE att_alerts (
    id INTEGER PRIMARY KEY, employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE, kind TEXT NOT NULL, key TEXT NOT NULL,
    at TEXT NOT NULL, detail TEXT, seen_at TEXT, demo INTEGER NOT NULL DEFAULT 0, UNIQUE (kind, key)
  );
  CREATE INDEX att_alerts_at ON att_alerts(at);
  CREATE TABLE att_holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0);
`;

// The settings and their defaults (db.setting keys)
const DEFAULTS = {
  att_radius: 100, att_max_acc: 60, att_selfie: 1, att_ping_min: 5, att_grace: 10, att_auto_out_h: 3, att_left_min: 15,
  att_ot_from: 15, att_ot_rate: 1.35, att_absent_unpaid: 1, att_keep_days: 180,
};
const LIMITS = { att_radius: [30, 1000], att_max_acc: [10, 500], att_ping_min: [1, 60], att_grace: [0, 120], att_auto_out_h: [1, 12], att_left_min: [5, 120], att_ot_from: [0, 120], att_ot_rate: [1, 3], att_keep_days: [30, 1825] };
const CONSENT_VERSION = 1;
const KINDS = ['in', 'break_start', 'break_end', 'out'];
const STATUS = {
  working: ['att|Working', 'ok'], on_break: ['att|On a break', 'sky'], done: ['att|Done for the day', 'forest'], not_in: ['att|Not in yet', 'rose'],
  absent: ['att|Absent', 'rose'], upcoming: ['att|Shift later', 'mute'], leave: ['att|On leave', 'sand'], holiday: ['att|Holiday', 'sand'], off: ['att|Day off', 'mute'],
};
const REASONS = {
  no_fence: 'att|The mall’s location has not been set yet.', no_position: 'att|The phone did not give a position.', no_time: 'att|The reading had no time.',
  future: 'att|The reading is dated in the future.', stale: 'att|The reading was more than two minutes old.', weak: 'att|The location was not precise enough.',
  outside: 'att|Outside the mall’s circle.', jump: 'att|An impossible jump from the last position.', order: 'att|Not possible right now (check in/out order).',
  device: 'att|Not the registered phone.', no_selfie: 'att|No photo was taken.',
};
const FLAGS = {
  edge: 'att|At the edge of the circle', exact: 'att|Suspiciously exact position', wifi: 'att|Not on the mall’s Wi-Fi', clock: 'att|The phone’s clock is wrong',
  auto_out: 'att|Clocked out by the system', late: 'att|Late',
};
// what the person is told, per reason
const ADVICE = {
  no_fence: 'att|HR has not set the mall’s location yet. Ask HR, then try again.',
  no_position: 'att|Allow location for this site and turn on precise location, then try again.',
  stale: 'att|Your phone gave an old position. Wait a few seconds for a fresh one and try again.',
  future: 'att|Your phone’s date and time look wrong. Set them to automatic and try again.',
  weak: 'att|The signal is not precise enough. Step near a window or entrance, turn on Wi-Fi and precise location, and try again.',
  outside: 'att|You are outside the mall’s circle. Go inside the mall and try again.',
  jump: 'att|Your position jumped too far too fast. Wait a moment for the location to settle and try again.',
  order: 'att|That is not possible right now. Refresh the page to see where you are.',
  no_selfie: 'att|Take the photo first, then try again.',
};
const LABEL = { in: 'att|Clock in', break_start: 'att|Start a break', break_end: 'att|End the break', out: 'att|Clock out' };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();
const parse = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

module.exports = function service(h) {
  const { db, M } = h;
  db.ensure('attendance-1', SCHEMA);

  // ---------- settings ----------
  const num = (k) => {
    const v = db.setting(k);
    const n = v === null || v === undefined || v === '' ? DEFAULTS[k] : Number(v);
    const [lo, hi] = LIMITS[k] || [-Infinity, Infinity];
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[k];
  };
  const fence = () => {
    const lat = db.setting('att_lat');
    const lng = db.setting('att_lng');
    return { lat: lat === null || lat === '' ? null : Number(lat), lng: lng === null || lng === '' ? null : Number(lng), radius: num('att_radius'), maxAccuracy: num('att_max_acc') };
  };
  const fenceSet = () => { const f = fence(); return E.validPoint(f.lat, f.lng); };
  const selfieOn = () => db.setting('att_selfie') === null || db.setting('att_selfie') === undefined ? true : db.setting('att_selfie') === '1';
  const wifiList = () => String(db.setting('att_wifi') || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const wifiOf = (ip) => {
    const list = wifiList();
    const clean = String(ip || '').replace(/^::ffff:/, '');
    return { configured: list.length > 0, matched: list.includes(clean) };
  };

  // ---------- people ----------
  const empOf = (id) => db.get('SELECT e.*, d.name dept FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?', Number(id));
  const activeEmps = () => db.all("SELECT e.*, d.name dept FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' ORDER BY e.name");
  const empOfUser = (userId) => (userId ? db.get("SELECT * FROM employees WHERE user_id = ? AND status = 'active' ORDER BY id LIMIT 1", userId) : null);
  const nameOf = (e) => (!e ? '' : i18n.isAr() && e.name_ar ? e.name_ar : e.name);
  const personOf = (e) => ({ employeeId: e.id, userId: e.user_id || null, names: [e.name, e.name_ar].filter(Boolean) });
  // everyone a person manages, directly or through others
  function teamOf(empId) {
    const out = new Set();
    let frontier = [Number(empId)];
    for (let depth = 0; depth < 8 && frontier.length; depth++) {
      const next = db.all(`SELECT id FROM employees WHERE manager_id IN (${frontier.map(() => '?').join(',')})`, ...frontier).map((r) => r.id).filter((id) => !out.has(id) && id !== Number(empId));
      next.forEach((id) => out.add(id));
      frontier = next;
    }
    return out;
  }

  // ---------- shifts ----------
  const shiftById = (id) => db.get('SELECT * FROM att_shifts WHERE id = ?', id);
  const shifts = ({ all = false } = {}) => db.all(`SELECT * FROM att_shifts ${all ? '' : 'WHERE active = 1'} ORDER BY start_hm, name`);
  const withGrace = (s) => (s ? { ...s, grace_min: s.grace_min === null || s.grace_min === undefined ? num('att_grace') : s.grace_min } : null);
  // the person's shift on a date: their assignment covering it, else the default shift
  function shiftFor(empId, date) {
    const a = db.get('SELECT s.* FROM att_assign a JOIN att_shifts s ON s.id = a.shift_id WHERE a.employee_id = ? AND a.starts <= ? AND (a.ends IS NULL OR a.ends >= ?) ORDER BY a.starts DESC, a.id DESC LIMIT 1', empId, date, date);
    if (a) return withGrace(a);
    const d = db.setting('att_default_shift');
    return d ? withGrace(shiftById(Number(d))) : null;
  }
  const onOf = (empId, date) => E.shiftOn(shiftFor(empId, date), date);
  const holidayOn = (date) => { const x = db.get('SELECT * FROM att_holidays WHERE date = ?', date); return x ? x.name : null; };
  const leaveOn = (empId, date) => { const l = db.get("SELECT type FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ? LIMIT 1", empId, date, date); return l ? l.type : null; };

  // ---------- punches ----------
  const valid = "status != 'rejected' AND voided_at IS NULL";
  const lastValid = (empId) => db.get(`SELECT * FROM att_punches WHERE employee_id = ? AND ${valid} ORDER BY at DESC, id DESC LIMIT 1`, empId);
  const punchesOn = (empId, date, { all = false } = {}) => db.all(`SELECT * FROM att_punches WHERE employee_id = ? AND work_date = ? ${all ? '' : `AND ${valid}`} ORDER BY at, id`, empId, date);
  // the open work day (clocked in, not out), or null
  function openDay(empId) {
    const last = lastValid(empId);
    return last && last.kind !== 'out' ? last.work_date : null;
  }
  const lastReading = (empId) => {
    const p = db.get(`SELECT lat, lng, accuracy, COALESCE(taken_at, at) at FROM att_punches WHERE employee_id = ? AND ${valid} AND lat IS NOT NULL ORDER BY at DESC LIMIT 1`, empId);
    const g = db.get('SELECT lat, lng, accuracy, at FROM att_pings WHERE employee_id = ? AND lat IS NOT NULL AND inside IS NOT NULL ORDER BY at DESC LIMIT 1', empId);
    return [p, g].filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1))[0] || null;
  };

  // Clocking. source 'app' (judged by the rules), 'hr' or 'correction' (entered by the office, kept
  // as typed), 'auto' (the system closing a forgotten day). Returns { punch, ok, reasons, flags }.
  function clock(e, { kind, reading = null, sentAt = null, deviceId = null, ip = null, agent = null, selfie = null, source = 'app', at = null, note = null, by = null, requestId = null, replaces = null, demo = 0, deviceOk = true }) {
    if (!KINDS.includes(kind)) throw new Error('att|Choose what to record.');
    const t = at || nowIso();
    return db.tx(() => {
      if (source === 'app') autoClose(e, t);
      const last = db.get(`SELECT * FROM att_punches WHERE employee_id = ? AND ${valid} AND at <= ? ORDER BY at DESC, id DESC LIMIT 1`, e.id, t);
      const reasons = [];
      let v = { status: 'accepted', distance: null, reasons: [], flags: [] };
      if (source === 'app') {
        v = E.verdict({ fence: fence(), reading, now: t, prev: lastReading(e.id), sentAt, wifi: wifiOf(ip) });
        if (!deviceOk) reasons.push('device');
        if (selfieOn() && ['in', 'out'].includes(kind) && !selfie) reasons.push('no_selfie');
      } else if (reading && E.validPoint(Number(reading.lat), Number(reading.lng)) && fenceSet()) {
        v.distance = Math.round(E.distance(fence(), reading) * 10) / 10;
      }
      if (!E.nextAllowed(last ? last.kind : null).includes(kind)) reasons.push('order');
      const allReasons = [...new Set([...v.reasons, ...reasons])];
      const flags = [...v.flags];
      if (source === 'auto') flags.push('auto_out');
      const status = allReasons.length ? 'rejected' : flags.length ? 'flagged' : 'accepted';
      // the work day: a clock-in finds its shift; everything else continues the open day
      let wd;
      if (kind === 'in') wd = E.workDate(t, (d) => shiftFor(e.id, d), { after: num('att_auto_out_h') });
      else wd = (last && last.kind !== 'out' ? last.work_date : null) || E.cairo(t).date;
      const id = Number(db.run(`INSERT INTO att_punches (employee_id, kind, at, work_date, status, reasons, flags, lat, lng, accuracy, distance, taken_at, device_id, ip, agent, selfie, source, note, by_user, replaces_id, request_id, demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id, kind, t, wd, status, allReasons.length ? JSON.stringify(allReasons) : null, flags.length ? JSON.stringify(flags) : null,
      reading && Number.isFinite(Number(reading.lat)) ? Number(reading.lat) : null, reading && Number.isFinite(Number(reading.lng)) ? Number(reading.lng) : null,
      reading && Number.isFinite(Number(reading.accuracy)) ? Math.round(Number(reading.accuracy) * 10) / 10 : null, v.distance,
      reading && reading.at ? new Date(typeof reading.at === 'number' ? reading.at : Date.parse(reading.at)).toISOString() : null,
      deviceId, ip ? String(ip).slice(0, 64) : null, agent ? String(agent).slice(0, 200) : null, selfie, source, note ? String(note).slice(0, 500) : null,
      by ? by.id : null, replaces, requestId, demo ? 1 : 0, nowIso()).lastInsertRowid);
      const punch = db.get('SELECT * FROM att_punches WHERE id = ?', id);
      if (status === 'rejected' && source === 'app') {
        // three refused attempts within half an hour: HR hears about it once
        const recent = db.value("SELECT COUNT(*) FROM att_punches WHERE employee_id = ? AND status = 'rejected' AND source = 'app' AND at >= ?", e.id, new Date(Date.parse(t) - 30 * 60000).toISOString());
        if (recent >= 3) alert(e, 'refused', `${e.id}:${E.cairo(t).date}:${Math.floor(Date.parse(t) / (30 * 60000))}`, { n: recent, reasons: allReasons }, { at: t, demo });
      }
      return { punch, ok: status !== 'rejected', reasons: allReasons, flags, status, distance: v.distance };
    });
  }

  // A forgotten clock-out: an open day closed by the system some hours after the shift ended
  // (12 h after clocking in when there is no shift), at the shift's end (or the last sign of
  // presence when there is no shift), flagged for HR.
  function autoClose(e, t = nowIso()) {
    const last = lastValid(e.id);
    if (!last || last.kind === 'out') return null;
    const on = onOf(e.id, last.work_date);
    const lastIn = db.get(`SELECT * FROM att_punches WHERE employee_id = ? AND ${valid} AND kind = 'in' AND at <= ? ORDER BY at DESC LIMIT 1`, e.id, last.at);
    if (!lastIn) return null;
    let deadline;
    let outAt;
    if (on && Date.parse(on.end) > Date.parse(lastIn.at)) {
      deadline = Date.parse(on.end) + num('att_auto_out_h') * 3600000;
      outAt = on.end;
    } else {
      deadline = Date.parse(lastIn.at) + 12 * 3600000;
      const ping = db.get('SELECT at FROM att_pings WHERE employee_id = ? AND at >= ? AND inside = 1 ORDER BY at DESC LIMIT 1', e.id, lastIn.at);
      outAt = ping ? ping.at : last.at;
    }
    if (Date.parse(t) < deadline) return null;
    if (Date.parse(outAt) < Date.parse(last.at)) outAt = last.at;
    const id = Number(db.run(`INSERT INTO att_punches (employee_id, kind, at, work_date, status, flags, source, note, demo, created_at) VALUES (?, 'out', ?, ?, 'flagged', ?, 'auto', ?, ?, ?)`,
      e.id, outAt, last.work_date, JSON.stringify(['auto_out']), 'No clock-out: closed by the system', last.demo ? 1 : 0, nowIso()).lastInsertRowid);
    alert(e, 'auto_out', `${e.id}:${last.work_date}`, { date: last.work_date }, { at: t, demo: last.demo });
    return id;
  }

  // A location update while clocked in. Readings that are not precise enough are kept as "unclear".
  function ping(e, { reading, visible = true, deviceId = null, at = null, demo = 0 }) {
    const t = at || nowIso();
    const open = openDay(e.id);
    if (!open) return { ok: false, reason: 'not_in' };
    const last = db.get('SELECT * FROM att_pings WHERE employee_id = ? ORDER BY at DESC LIMIT 1', e.id);
    if (last && Date.parse(t) - Date.parse(last.at) < 25000 && !at) return { ok: true, skipped: true };
    const f = fence();
    const ok = reading && E.validPoint(Number(reading.lat), Number(reading.lng)) && Number.isFinite(Number(reading.accuracy));
    const d = ok && fenceSet() ? E.distance(f, { lat: Number(reading.lat), lng: Number(reading.lng) }) : null;
    const inside = d === null || Number(reading.accuracy) > f.maxAccuracy ? null : d <= f.radius + 0.01 ? 1 : 0;
    db.run('INSERT INTO att_pings (employee_id, at, lat, lng, accuracy, distance, inside, visible, device_id, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      e.id, t, ok ? Number(reading.lat) : null, ok ? Number(reading.lng) : null, ok ? Math.round(Number(reading.accuracy) * 10) / 10 : null, d === null ? null : Math.round(d * 10) / 10, inside, visible ? 1 : 0, deviceId, demo ? 1 : 0);
    checkLeft(e, t, demo);
    return { ok: true, inside, distance: d === null ? null : Math.round(d) };
  }
  // outside the circle for longer than the setting, without a clear reading inside since: once per absence
  function checkLeft(e, t = nowIso(), demo = 0) {
    const open = openDay(e.id);
    if (!open) return;
    const lastIn = db.get(`SELECT at FROM att_punches WHERE employee_id = ? AND ${valid} AND kind = 'in' ORDER BY at DESC LIMIT 1`, e.id);
    if (!lastIn) return;
    const lastInside = db.get('SELECT at FROM att_pings WHERE employee_id = ? AND at >= ? AND inside = 1 ORDER BY at DESC LIMIT 1', e.id, lastIn.at);
    const firstOut = db.get('SELECT at FROM att_pings WHERE employee_id = ? AND at > ? AND inside = 0 ORDER BY at LIMIT 1', e.id, lastInside ? lastInside.at : lastIn.at);
    const lastOut = db.get('SELECT * FROM att_pings WHERE employee_id = ? AND inside IS NOT NULL ORDER BY at DESC LIMIT 1', e.id);
    if (!firstOut || !lastOut || lastOut.inside !== 0) return;
    const mins = (Date.parse(lastOut.at) - Date.parse(firstOut.at)) / 60000;
    if (mins >= num('att_left_min')) alert(e, 'left', `${e.id}:${firstOut.at}`, { since: firstOut.at, distance: Math.round(lastOut.distance || 0) }, { at: t, demo });
  }

  // ---------- alerts: kept once, told to the person's manager and HR ----------
  const NOTE_KIND = { late: 'att_late', left: 'att_left', auto_out: 'att_auto_out', refused: 'att_refused', device: 'att_device', correction: 'att_correction' };
  function alert(e, kind, key, detail = {}, { at = nowIso(), demo = 0 } = {}) {
    const fresh = db.run('INSERT OR IGNORE INTO att_alerts (employee_id, kind, key, at, detail, demo) VALUES (?, ?, ?, ?, ?, ?)', e ? e.id : null, kind, key, at, JSON.stringify(detail || {}), demo ? 1 : 0).changes;
    if (!fresh || !h.work || !h.work.notify) return !!fresh;
    const to = new Set(db.all("SELECT id FROM users WHERE active = 1 AND hr = 1").map((u) => u.id));
    if (!to.size) db.all("SELECT id FROM users WHERE active = 1 AND role = 'admin'").forEach((u) => to.add(u.id));
    if (e && e.manager_id) {
      const m = db.get('SELECT user_id FROM employees WHERE id = ?', e.manager_id);
      if (m && m.user_id) to.add(m.user_id);
    }
    if (e && e.user_id) to.delete(e.user_id);
    const vars = { who: e ? e.name : '', who_ar: e ? e.name_ar || e.name : '', ...detail };
    for (const uid of to) {
      try {
        h.work.notify(uid, NOTE_KIND[kind], { params: { vars }, link: e ? `/admin/attendance/people/${e.id}${detail.date ? `?date=${detail.date}` : ''}` : '/admin/attendance', demo });
      } catch (err) {
        console.error('[attendance] notification not sent:', err.message);
      }
    }
    return true;
  }

  // ---------- the day ----------
  function dayOf(e, date, now = nowIso()) {
    const on = onOf(e.id, date);
    const r = E.computeDay({ on, punches: punchesOn(e.id, date), leave: leaveOn(e.id, date), holiday: holidayOn(date), now, overtimeFrom: num('att_ot_from') });
    r.date = date;
    return r;
  }
  // The day to show for someone now: their open day, else today (or last night's shift if it is
  // still running and they never came).
  function currentDate(e, now = nowIso()) {
    const open = openDay(e.id);
    if (open) return open;
    const today = E.cairo(now).date;
    const y = E.addDays(today, -1);
    const yOn = onOf(e.id, y);
    if (yOn && Date.parse(now) < Date.parse(yOn.end) && !punchesOn(e.id, y).length) return y;
    return today;
  }

  // Housekeeping (on page loads and every few minutes): forgotten clock-outs, people not in by
  // their start time, long absences from the circle, old pings and office minutes.
  let lastSweep = 0;
  function sweep(now = nowIso(), { force = false } = {}) {
    if (!force && Date.now() - lastSweep < 45000) return;
    lastSweep = Date.now();
    for (const e of activeEmps()) {
      autoClose(e, now);
      const date = currentDate(e, now);
      const d = dayOf(e, date, now);
      if (d.status === 'not_in' && d.on) alert(e, 'late', `${e.id}:${date}`, { date, start: E.cairo(d.on.start).hm }, { at: now, demo: e.demo });
      if (openDay(e.id)) checkLeft(e, now, e.demo);
    }
    const keep = new Date(Date.parse(now) - num('att_keep_days') * 86400000).toISOString();
    db.run('DELETE FROM att_pings WHERE at < ?', keep);
    db.run('DELETE FROM att_beats WHERE at < ?', keep);
    db.run('DELETE FROM att_logins WHERE expires_at < ?', now);
    db.run('DELETE FROM att_handoffs WHERE expires_at < ?', now);
  }

  // ---------- the office: minutes with the office open (active: touched in the last 2 minutes) ----------
  function beat(userId, { path = null, active = true, at = null, demo = 0 } = {}) {
    const t = at ? new Date(at) : new Date();
    t.setUTCSeconds(0, 0);
    const p = String(path || '').split('#')[0].slice(0, 200);
    db.run('INSERT INTO att_beats (user_id, at, path, active, demo) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, at) DO UPDATE SET active = MAX(active, excluded.active), path = excluded.path',
      userId, t.toISOString(), /^\/admin(\/|$|\?)/.test(p) ? p : null, active ? 1 : 0, demo ? 1 : 0);
  }
  // the office now: { state: 'active'|'idle'|'offline'|'never', since, path, minutesToday }
  function officeOf(userId, now = nowIso()) {
    if (!userId) return null;
    const last = db.get('SELECT * FROM att_beats WHERE user_id = ? AND at <= ? ORDER BY at DESC LIMIT 1', userId, now);
    const today = E.cairo(now).date;
    const dayStart = E.cairoAt(today, '00:00');
    const minutesToday = db.value('SELECT COUNT(*) FROM att_beats WHERE user_id = ? AND active = 1 AND at >= ? AND at <= ?', userId, dayStart, now);
    if (!last) return { state: 'never', minutesToday };
    const age = (Date.parse(now) - Date.parse(last.at)) / 60000;
    if (age > 2.5) return { state: 'offline', since: last.at, path: last.path, minutesToday };
    if (last.active) return { state: 'active', since: last.at, path: last.path, minutesToday };
    const lastActive = db.get('SELECT at FROM att_beats WHERE user_id = ? AND active = 1 AND at <= ? ORDER BY at DESC LIMIT 1', userId, now);
    return { state: 'idle', since: lastActive ? lastActive.at : last.at, path: last.path, minutesToday };
  }

  // ---------- staff sign-in: PIN, devices, consent ----------
  const credsOf = (empId) => db.get('SELECT * FROM att_creds WHERE employee_id = ?', empId);
  function setPin(empId, pin, by = null, { demo = 0 } = {}) {
    if (!/^\d{6}$/.test(String(pin || ''))) throw new Error('att|The PIN is 6 digits.');
    if (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw new Error('att|Choose a PIN that is not a simple sequence.');
    const hash = require('../db').hashPassword(String(pin));
    db.run(`INSERT INTO att_creds (employee_id, pin_hash, pin_set_at, pin_set_by, failed, locked_until, demo) VALUES (?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(employee_id) DO UPDATE SET pin_hash = excluded.pin_hash, pin_set_at = excluded.pin_set_at, pin_set_by = excluded.pin_set_by, failed = 0, locked_until = NULL`,
    empId, hash, nowIso(), by ? by.id : null, demo ? 1 : 0);
  }
  // { ok, reason: 'unknown'|'no_pin'|'locked'|'wrong', left, until }
  function checkPin(code, pin, t = nowIso()) {
    const e = db.get("SELECT * FROM employees WHERE code = ? COLLATE NOCASE AND status = 'active'", String(code || '').trim());
    const c = e && credsOf(e.id);
    if (!e || !c || !c.pin_hash) return { ok: false, reason: e ? 'no_pin' : 'unknown' };
    if (c.locked_until && c.locked_until > t) return { ok: false, reason: 'locked', until: c.locked_until, e };
    const good = require('../db').verifyPassword(String(pin || ''), c.pin_hash);
    if (!good) {
      const failed = (c.locked_until && c.locked_until <= t ? 0 : c.failed) + 1;
      const lock = failed >= 5 ? new Date(Date.parse(t) + 15 * 60000).toISOString() : null;
      db.run('UPDATE att_creds SET failed = ?, locked_until = ? WHERE employee_id = ?', lock ? 0 : failed, lock, e.id);
      return { ok: false, reason: lock ? 'locked' : 'wrong', left: lock ? 0 : 5 - failed, until: lock, e };
    }
    db.run('UPDATE att_creds SET failed = 0, locked_until = NULL, last_login_at = ? WHERE employee_id = ?', t, e.id);
    return { ok: true, e };
  }
  const deviceLabel = (agent) => {
    const a = String(agent || '');
    const os = /iPhone/.test(a) ? 'iPhone' : /iPad/.test(a) ? 'iPad' : /Android/.test(a) ? (a.match(/Android [\d.]+; ([^;)]+)/) || [])[1] || 'Android' : /Mac OS X/.test(a) ? 'Mac' : /Windows/.test(a) ? 'Windows' : /Linux/.test(a) ? 'Linux' : '';
    const br = /CriOS|Chrome\//.test(a) && !/Edg/.test(a) ? 'Chrome' : /FxiOS|Firefox/.test(a) ? 'Firefox' : /Edg/.test(a) ? 'Edge' : /SamsungBrowser/.test(a) ? 'Samsung Internet' : /Safari/.test(a) ? 'Safari' : '';
    return [os.trim(), br].filter(Boolean).join(' · ').slice(0, 80) || '—';
  };
  // The phone signing in: { device, state: 'active'|'pending'|'new_first'|'new_pending', token? }.
  // The first phone of a person is registered at once; any other needs HR's approval.
  function deviceFor(e, token, { agent = null, ip = null, demo = 0 } = {}) {
    const known = token ? db.get('SELECT * FROM att_devices WHERE token_hash = ?', sha(token)) : null;
    if (known && known.employee_id === e.id) {
      if (known.status === 'active') {
        db.run('UPDATE att_devices SET last_seen_at = ?, ip = ? WHERE id = ?', nowIso(), ip, known.id);
        return { device: known, state: 'active' };
      }
      return { device: known, state: known.status === 'pending' ? 'pending' : 'revoked' };
    }
    const fresh = require('node:crypto').randomBytes(32).toString('base64url');
    const first = !db.value("SELECT COUNT(*) FROM att_devices WHERE employee_id = ? AND status = 'active'", e.id);
    const id = Number(db.run('INSERT INTO att_devices (employee_id, token_hash, label, agent, ip, status, created_at, decided_at, last_seen_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      e.id, sha(fresh), deviceLabel(agent), agent ? String(agent).slice(0, 200) : null, ip, first ? 'active' : 'pending', nowIso(), first ? nowIso() : null, first ? nowIso() : null, demo ? 1 : 0).lastInsertRowid);
    const device = db.get('SELECT * FROM att_devices WHERE id = ?', id);
    if (!first) alert(e, 'device', `${e.id}:${id}`, { label: device.label }, { demo });
    // a phone already registered to someone else stays theirs; this person gets a new token
    return { device, token: fresh, state: first ? 'new_first' : 'new_pending', sharedWith: known && known.employee_id !== e.id ? known.employee_id : null };
  }
  function decideDevice(id, status, by) {
    const d = db.get('SELECT * FROM att_devices WHERE id = ?', id);
    if (!d) return null;
    db.run('UPDATE att_devices SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', status, by ? by.id : null, nowIso(), id);
    if (status !== 'active') db.run('DELETE FROM att_logins WHERE device_id = ?', id);
    return d;
  }

  return {
    SCHEMA, DEFAULTS, LIMITS, CONSENT_VERSION, KINDS, STATUS, REASONS, FLAGS, ADVICE, LABEL, sha, parse,
    num, fence, fenceSet, selfieOn, wifiList, wifiOf,
    empOf, activeEmps, empOfUser, nameOf, personOf, teamOf,
    shiftById, shifts, shiftFor, onOf, holidayOn, leaveOn,
    lastValid, punchesOn, openDay, lastReading, clock, autoClose, ping, checkLeft, alert, dayOf, currentDate, sweep,
    beat, officeOf, credsOf, setPin, checkPin, deviceFor, decideDevice, deviceLabel, nowIso,
    // for tests: forget when the last sweep ran
    resetSweep: () => { lastSweep = 0; },
    T: () => M.today(),
    tr,
  };
};

module.exports.SCHEMA = SCHEMA;
module.exports.STATUS = STATUS;
module.exports.REASONS = REASONS;
