'use strict';

// Attendance & activity: the rules (distance, the verdict, shifts across midnight, the day's
// record), the staff app end to end (PIN, phone, notice, clocking inside and outside the circle,
// location updates), corrections through Approvals, the office heartbeat, the last-activity
// aggregator, permissions and the pages in both languages.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const E = require('../src/admin/attendance/engine');

let server;
let base;
let db;
let h;
let S;
let hr;
let admin;
const CENTER = { lat: 30.02624, lng: 31.46648 };
const north = (m) => ({ lat: CENTER.lat + m / ((6371008.8 * Math.PI) / 180), lng: CENTER.lng });

let ipN = 0;
function browser() {
  const jar = new Map();
  const ip = `10.7.${Math.floor(++ipN / 250)}.${ipN % 250}`;
  const go = async (p, opts = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': ip, ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const b = {
    go, jar, csrf: null, scsrf: null,
    form: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: b.csrf, ...data }).toString() }),
    json: (p, data, token) => go(p, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf': token }, body: JSON.stringify(data) }),
    async signIn(email) {
      const html = await (await go('/admin/login')).text();
      const t = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: t, email, password: 'long-enough-1' }).toString() });
      assert.equal(r.status, 303);
      b.csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
    },
    // the staff app: sign in with the code and PIN; returns the response
    async staff(code, pin) {
      const html = await (await go('/staff/login')).text();
      const t = html.match(/name="_token" value="([^"]+)"/)[1];
      return go('/staff/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: t, code, pin }).toString() });
    },
    async staffCsrf() {
      const page = await (await go('/staff')).text();
      const m = page.match(/name="csrf" content="([^"]+)"/);
      b.scsrf = m ? m[1] : null;
      return b.scsrf;
    },
  };
  return b;
}
function user(name, email, role, { hr: isHr = 0 } = {}) {
  const id = Number(db.run("INSERT INTO users (name, email, role, password_hash, hr, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))", name, email, role, hashPassword('long-enough-1'), isHr).lastInsertRowid);
  h.access.engine.touch();
  return id;
}
let empN = 0;
function employee(name, { userId = null, managerId = null } = {}) {
  const n = ++empN;
  return Number(db.run(`INSERT INTO employees (code, name, hire_date, status, basic_salary, user_id, manager_id, created_at, updated_at) VALUES (?, ?, '2024-01-01', 'active', 12000, ?, ?, datetime('now'), datetime('now'))`,
    `ATT-${String(n).padStart(3, '0')}`, name, userId, managerId).lastInsertRowid);
}

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  app.set('trust proxy', true);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  S = h.attendance;
  base = `http://127.0.0.1:${server.address().port}`;
  user('Att Admin', 'att-admin@thewave.test', 'admin', { hr: 1 });
  hr = user('Att HR', 'att-hr@thewave.test', 'agent', { hr: 1 });
  admin = browser();
  await admin.signIn('att-admin@thewave.test');
  db.setSetting('att_lat', String(CENTER.lat));
  db.setSetting('att_lng', String(CENTER.lng));
  db.setSetting('att_selfie', '0');
});
after(() => server.close());

test('attendance: distances, points and the verdict are exact', () => {
  // one degree of latitude on the mean-radius sphere (R = 6 371 008.8 m) is 2πR/360 = 111 195.08 m
  assert.ok(Math.abs(E.distance({ lat: 30, lng: 31 }, { lat: 31, lng: 31 }) - (2 * Math.PI * 6371008.8) / 360) < 1e-6);
  // London → Paris, the textbook haversine value (343.5 km)
  assert.ok(Math.abs(E.distance({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 }) - 343556) < 300);
  assert.ok(Math.abs(E.distance(CENTER, north(100)) - 100) < 1e-6, 'a point 100 m north is 100 m away');
  // Google Maps links and plain coordinates
  assert.deepEqual(E.parsePoint('30.026240, 31.466480'), { lat: 30.02624, lng: 31.46648 });
  assert.deepEqual(E.parsePoint('https://www.google.com/maps/place/The+Wave/@30.0261,31.4660,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d30.02624!4d31.46648'), { lat: 30.02624, lng: 31.46648 }, 'the pin wins over the map centre');
  assert.deepEqual(E.parsePoint('https://maps.google.com/?q=30.1,31.2'), { lat: 30.1, lng: 31.2 });
  assert.equal(E.parsePoint('somewhere'), null);
  assert.equal(E.parsePoint('91, 31'), null, 'out of range');

  const fence = { ...CENTER, radius: 100, maxAccuracy: 60 };
  const now = Date.parse('2026-11-05T10:00:00Z');
  const v = (reading, extra = {}) => E.verdict({ fence, reading: { at: now - 3000, accuracy: 10, ...reading }, now, sentAt: now - 500, ...extra });
  assert.equal(v(north(100)).status, 'flagged', 'exactly on the radius: accepted (flagged at the edge)');
  assert.deepEqual(v(north(100)).flags, ['edge']);
  assert.equal(v(north(60), { }).status, 'accepted');
  assert.deepEqual(v(north(100.5)).reasons, ['outside']);
  assert.deepEqual(v({ ...north(10), accuracy: 61 }).reasons, ['weak'], 'not precise enough');
  assert.equal(v({ ...north(10), accuracy: 60 }).status, 'accepted', 'precision exactly at the limit is fine');
  assert.deepEqual(v({ ...north(10), at: now - 130000 }).reasons, ['stale'], 'more than two minutes old');
  assert.deepEqual(v({ ...north(10), at: now + 120000 }).reasons, ['future']);
  assert.deepEqual(v(north(10), { prev: { ...north(0), lat: CENTER.lat + 0.1, accuracy: 10, at: now - 60000 } }).reasons, ['jump'], '11 km in a minute');
  assert.equal(v(north(10), { prev: { ...north(300), accuracy: 30, at: now - 60000 } }).status, 'accepted', 'GPS wander within the error is not a jump');
  assert.deepEqual(v({ ...north(10), accuracy: 0 }).flags, ['exact']);
  assert.deepEqual(v(north(10), { wifi: { configured: true, matched: false } }).flags, ['wifi']);
  assert.equal(v(north(10), { wifi: { configured: true, matched: true } }).status, 'accepted');
  assert.deepEqual(v(north(10), { sentAt: now - 900000 }).flags, ['clock'], 'the phone clock 15 min out is flagged, its own age still counts');
  assert.deepEqual(E.verdict({ fence: { lat: null, lng: null, radius: 100, maxAccuracy: 60 }, reading: { ...north(1), accuracy: 5, at: now }, now }).reasons, ['no_fence']);
  assert.deepEqual(v({ lat: NaN, lng: 31 }).reasons, ['no_position']);
});

test('attendance: shifts in Cairo time, across midnight and the clock change', () => {
  // Cairo is UTC+3 in summer 2026 and UTC+2 in winter
  assert.equal(E.cairoAt('2026-07-15', '09:00'), '2026-07-15T06:00:00.000Z');
  assert.equal(E.cairoAt('2026-12-15', '09:00'), '2026-12-15T07:00:00.000Z');
  const night = { start_hm: '23:00', end_hm: '07:00', days: '1234567', grace_min: 10, break_min: 30 };
  const on = E.shiftOn(night, '2026-11-05');
  assert.equal(on.start, '2026-11-05T21:00:00.000Z');
  assert.equal(on.end, '2026-11-06T05:00:00.000Z');
  assert.equal(on.minutes, 480);
  assert.equal(on.net, 450);
  const evening = { start_hm: '16:00', end_hm: '00:00', days: '1234567', grace_min: 10, break_min: 0 };
  assert.equal(E.shiftOn(evening, '2026-11-05').end, '2026-11-05T22:00:00.000Z', 'midnight ends the same work day');
  // which work day a moment belongs to
  const nightFor = () => night;
  assert.equal(E.workDate('2026-11-06T05:05:00Z', nightFor), '2026-11-05', 'leaving at 07:05 belongs to the night that started the day before');
  assert.equal(E.workDate('2026-11-05T20:50:00Z', nightFor), '2026-11-05', 'arriving at 22:50 belongs to tonight');
  assert.equal(E.workDate('2026-11-05T22:30:00Z', () => evening), '2026-11-05', 'clocking out at 00:30 after an evening shift');
  assert.equal(E.workDate('2026-11-05T09:00:00Z', () => null), '2026-11-05', 'no shift: the Cairo date');
  // days of the week (ISO: Monday 1 … Sunday 7); 2026-11-06 is a Friday
  assert.equal(E.isoDay('2026-11-06'), 5);
  assert.equal(E.shiftOn({ ...night, days: '71234' }, '2026-11-06'), null, 'not on its days');
});

test('attendance: the day record — late, early, breaks, overtime, absent, leave, holiday', () => {
  const shift = { start_hm: '10:00', end_hm: '18:00', days: '1234567', grace_min: 10, break_min: 30 };
  const on = E.shiftOn(shift, '2026-11-05'); // 08:00Z–16:00Z
  const p = (kind, at, extra = {}) => ({ id: at.length, kind, at, status: 'accepted', ...extra });
  const day = E.computeDay({ on, now: '2026-11-05T20:00:00Z', punches: [p('in', '2026-11-05T08:25:00Z'), p('break_start', '2026-11-05T12:00:00Z'), p('break_end', '2026-11-05T12:30:00Z'), p('out', '2026-11-05T17:40:00Z')] });
  assert.equal(day.status, 'done');
  assert.equal(day.lateMin, 25, 'late counts from the start once past the grace');
  assert.equal(day.breakMin, 30);
  assert.equal(day.workedMin, 9 * 60 + 15 - 30);
  assert.equal(day.overtimeMin, day.workedMin - 450, 'over the net scheduled time');
  const early = E.computeDay({ on, now: '2026-11-05T20:00:00Z', punches: [p('in', '2026-11-05T08:05:00Z'), p('out', '2026-11-05T15:00:00Z')] });
  assert.equal(early.lateMin, 0, 'within the grace');
  assert.equal(early.earlyMin, 60);
  assert.equal(early.overtimeMin, 0);
  assert.equal(E.computeDay({ on, now: '2026-11-05T07:00:00Z' }).status, 'upcoming');
  assert.equal(E.computeDay({ on, now: '2026-11-05T08:11:00Z' }).status, 'not_in');
  assert.equal(E.computeDay({ on, now: '2026-11-05T16:01:00Z' }).status, 'absent');
  assert.equal(E.computeDay({ on, now: '2026-11-05T16:01:00Z', leave: 'annual' }).status, 'leave');
  assert.equal(E.computeDay({ on, now: '2026-11-05T16:01:00Z', holiday: 'Armed Forces Day' }).status, 'holiday');
  assert.equal(E.computeDay({ on: null, now: '2026-11-05T16:01:00Z' }).status, 'off');
  const working = E.computeDay({ on, now: '2026-11-05T10:00:00Z', punches: [p('in', '2026-11-05T08:00:00Z'), p('break_start', '2026-11-05T09:30:00Z')] });
  assert.equal(working.status, 'on_break');
  assert.equal(working.workedMin, 90, 'a break in progress does not count');
  const refused = E.computeDay({ on, now: '2026-11-05T16:01:00Z', punches: [p('in', '2026-11-05T08:00:00Z', { status: 'rejected' })] });
  assert.equal(refused.status, 'absent', 'a refused attempt is not attendance');
  assert.deepEqual(E.nextAllowed('in'), ['break_start', 'out']);
  assert.deepEqual(E.nextAllowed(null), ['in']);
});

test('attendance: the staff app end to end — PIN, phone, notice, clocking, location', async () => {
  const id = employee('Walid Test');
  const e = S.empOf(id);
  db.run("INSERT INTO att_shifts (name, start_hm, end_hm, days, grace_min, break_min, created_at) VALUES ('Test day', '00:00', '23:59', '1234567', 10, 0, datetime('now'))");
  S.setPin(id, '482913');
  assert.throws(() => S.setPin(id, '123456'), /sequence/);
  assert.throws(() => S.setPin(id, '12345'), /6 digits/);
  const phone = browser();
  // wrong PIN, then right; the first phone is registered at once
  const bad = await phone.staff(e.code, '000001');
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /4 tries left/);
  const ok = await phone.staff(e.code, '482913');
  assert.equal(ok.status, 303);
  assert.equal(db.value("SELECT COUNT(*) FROM att_devices WHERE employee_id = ? AND status = 'active'", id), 1);
  // the notice comes first
  assert.equal((await phone.go('/staff')).headers.get('location'), '/staff/consent');
  const consent = await (await phone.go('/staff/consent')).text();
  const cs = consent.match(/name="_csrf" value="([^"]+)"/)[1];
  const blocked = await phone.json('/staff/punch', { kind: 'in' }, cs);
  assert.equal(blocked.status, 403, 'no clocking before the notice');
  await phone.go('/staff/consent', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: cs }).toString() });
  const token = await phone.staffCsrf();
  assert.ok(token);
  // outside the circle: refused, kept, explained
  const now = Date.now();
  const out = await (await phone.json('/staff/punch', { kind: 'in', ...north(400), accuracy: 12, taken: now - 2000, sent: now }, token)).json();
  assert.equal(out.ok, false);
  assert.match(out.advice.join(' '), /outside the mall’s circle/);
  assert.equal(db.value("SELECT COUNT(*) FROM att_punches WHERE employee_id = ? AND status = 'rejected'", id), 1, 'refused attempts are kept');
  // inside: accepted
  const inside = await (await phone.json('/staff/punch', { kind: 'in', ...north(40), accuracy: 15, taken: now - 2000, sent: now }, token)).json();
  assert.equal(inside.ok, true, JSON.stringify(inside));
  assert.equal(inside.distance, 40);
  assert.deepEqual(inside.allowed, ['break_start', 'out']);
  // a second clock-in is out of order
  const again = await (await phone.json('/staff/punch', { kind: 'in', ...north(40), accuracy: 15, taken: Date.now() - 1000, sent: Date.now() }, token)).json();
  assert.equal(again.ok, false);
  assert.match(again.advice.join(' '), /not possible right now/);
  // location updates: inside, then outside
  const pin1 = await (await phone.json('/staff/ping', { ...north(20), accuracy: 10, taken: Date.now(), visible: true }, token)).json();
  assert.equal(pin1.inside, 1);
  db.run('UPDATE att_pings SET at = ? WHERE employee_id = ?', new Date(Date.now() - 60000).toISOString(), id);
  const pin2 = await (await phone.json('/staff/ping', { ...north(500), accuracy: 10, taken: Date.now(), visible: true }, token)).json();
  assert.equal(pin2.inside, 0);
  assert.equal(pin2.distance, 500);
  // a stranger's phone: not this person's; refused until HR approves it
  const other = browser();
  const second = await other.staff(e.code, '482913');
  assert.equal(second.status, 403);
  assert.match(await second.text(), /not your registered phone/);
  const pending = db.get("SELECT * FROM att_devices WHERE employee_id = ? AND status = 'pending'", id);
  assert.ok(pending, 'the new phone waits');
  assert.ok(db.get("SELECT * FROM att_alerts WHERE kind = 'device' AND employee_id = ?", id), 'HR is told');
  await admin.form(`/admin/attendance/devices/${pending.id}/approve`, {});
  assert.equal(db.value("SELECT status FROM att_devices WHERE id = ?", pending.id), 'active');
  assert.equal(db.value("SELECT COUNT(*) FROM att_devices WHERE employee_id = ? AND status = 'active'", id), 1, 'one phone per person: the old one is retired');
  assert.equal((await other.staff(e.code, '482913')).status, 303, 'the approved phone signs in');
  assert.equal((await phone.go('/staff')).status, 303, 'the retired phone is signed out');
  // five wrong PINs lock the account
  const locker = browser();
  for (let i = 0; i < 4; i++) await locker.staff(e.code, '999999');
  const locked = await locker.staff(e.code, '999999');
  assert.match(await locked.text(), /Too many wrong PINs/);
  const right = await locker.staff(e.code, '482913');
  assert.equal(right.status, 401, 'even the right PIN waits while locked');
  await admin.form(`/admin/attendance/people/${id}/unlock`, {});
  assert.equal(db.value('SELECT failed FROM att_creds WHERE employee_id = ?', id), 0);
});

test('attendance: a forgotten clock-out is closed at the shift end, and a correction through Approvals replaces it', async () => {
  const uid = user('Nadia Test', 'nadia@thewave.test', 'agent');
  const id = employee('Nadia Test', { userId: uid });
  const e = S.empOf(id);
  const sid = Number(db.run("INSERT INTO att_shifts (name, start_hm, end_hm, days, grace_min, break_min, created_at) VALUES ('Evening test', '16:00', '00:00', '1234567', 10, 0, datetime('now'))").lastInsertRowid);
  S.assign(id, sid, '2026-01-01', null, null);
  const d = E.addDays(E.cairo(Date.now()).date, -3);
  const on = E.shiftOn(S.shiftById(sid), d);
  const r = S.clock(e, { kind: 'in', at: new Date(Date.parse(on.start) + 5 * 60000).toISOString(), source: 'hr', note: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.punch.work_date, d);
  S.resetSweep();
  S.sweep(new Date().toISOString(), { force: true });
  const auto = db.get("SELECT * FROM att_punches WHERE employee_id = ? AND source = 'auto'", id);
  assert.ok(auto, 'closed by the system');
  assert.equal(auto.at, on.end, 'at the shift end');
  assert.equal(auto.status, 'flagged');
  assert.equal(S.dayOf(e, d).incomplete, true);
  // the person asks for the real time from the staff app
  S.setPin(id, '740219');
  const phone = browser();
  await phone.staff(e.code, '740219');
  const consent = await (await phone.go('/staff/consent')).text();
  await phone.go('/staff/consent', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: consent.match(/name="_csrf" value="([^"]+)"/)[1] }).toString() });
  const fix = await (await phone.go('/staff/fix')).text();
  await phone.go('/staff/fix', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: fix.match(/name="_csrf" value="([^"]+)"/)[1], date: d, kind: 'out', time: '00:25', reason: 'Battery died' }).toString() });
  const req = db.get("SELECT * FROM apr_requests WHERE kind = 'attendance' AND entity_id = ?", id);
  assert.ok(req, 'the request waits in Approvals');
  assert.equal(JSON.parse(req.payload).at, E.cairoAt(E.addDays(d, 1), '00:25'), '00:25 after an evening shift is the next morning');
  const decider = db.get("SELECT * FROM users WHERE email = 'att-admin@thewave.test'");
  h.approvals.decide(req.id, decider, 'approved');
  const corrected = db.get("SELECT * FROM att_punches WHERE employee_id = ? AND source = 'correction'", id);
  assert.ok(corrected);
  assert.equal(corrected.work_date, d);
  assert.ok(db.get('SELECT voided_at FROM att_punches WHERE id = ?', auto.id).voided_at, 'the system’s clock-out is set aside, and kept');
  const after = S.dayOf(e, d);
  assert.equal(after.incomplete, false);
  assert.equal(after.lastOut, corrected.at);
  assert.equal(after.workedMin, Math.round((Date.parse(corrected.at) - Date.parse(r.punch.at)) / 60000));
});

test('attendance: the office heartbeat and the last activity across modules', async () => {
  const uid = user('Omar Beat', 'omar.beat@thewave.test', 'agent');
  const id = employee('Omar Beat', { userId: uid });
  const b = browser();
  await b.signIn('omar.beat@thewave.test');
  const res = await b.go('/admin/me/beat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': b.csrf }, body: JSON.stringify({ path: '/admin/leads', active: true }) });
  assert.equal(res.status, 204);
  assert.equal(S.officeOf(uid).state, 'active');
  assert.equal(S.officeOf(uid).minutesToday, 1);
  // an idle minute later: open but not in use
  S.beat(uid, { path: '/admin/leads', active: false, at: new Date(Date.now() + 60000).toISOString() });
  assert.equal(S.officeOf(uid, new Date(Date.now() + 70000).toISOString()).state, 'idle');
  assert.equal(S.officeOf(uid, new Date(Date.now() + 10 * 60000).toISOString()).state, 'offline');
  // the newest real record wins, whichever module wrote it
  const t = (min) => new Date(Date.now() - min * 60000).toISOString();
  const person = S.personOf(S.empOf(id));
  db.run('DELETE FROM att_beats WHERE user_id = ?', uid);
  db.run('DELETE FROM audit WHERE user_id = ?', uid); // the sign-in line
  db.run("INSERT INTO audit (user_id, action, entity, entity_id, created_at) VALUES (?, 'Updated a lead', 'lead', 1, ?)", uid, t(30));
  assert.equal(h.activity.last(person).source, 'log');
  db.run("INSERT INTO att_punches (employee_id, kind, at, work_date, status, source, created_at) VALUES (?, 'in', ?, ?, 'accepted', 'hr', ?)", id, t(20), E.cairo(t(20)).date, t(20));
  assert.equal(h.activity.last(person).source, 'clock');
  S.beat(uid, { path: '/admin/billing', active: true, at: t(5) });
  const last = h.activity.last(person);
  assert.equal(last.source, 'office');
  assert.match(last.title, /Billing/);
  db.run("INSERT INTO audit (user_id, action, created_at) VALUES (?, 'Future thing', ?)", uid, new Date(Date.now() + 3600000).toISOString());
  assert.equal(h.activity.last(person).source, 'office', 'nothing dated in the future');
  // the feed folds office minutes into a span and keeps every source
  S.beat(uid, { path: '/admin/billing', active: true, at: t(4) });
  S.beat(uid, { path: '/admin/leases', active: true, at: t(3) });
  const feed = h.activity.feed(person, { from: t(60), now: new Date().toISOString() });
  assert.deepEqual(feed.map((x) => x.source), ['office', 'clock', 'log']);
  assert.match(feed[0].detail, /Billing/);
  assert.match(feed[0].detail, /3 active min/);
});

test('attendance: who may see it, the live board and the pages in both languages', async () => {
  // a manager with a team sees the team only; someone else is refused
  const mgrUser = user('Team Lead', 'lead@thewave.test', 'agent');
  const mgr = employee('Team Lead', { userId: mgrUser });
  const member = employee('Team Member', { managerId: mgr });
  const outsider = employee('Someone Else');
  const lead = browser();
  await lead.signIn('lead@thewave.test');
  const board = await (await lead.go('/admin/attendance')).text();
  assert.match(board, /Team Member/);
  assert.doesNotMatch(board, /Someone Else/);
  assert.equal((await lead.go(`/admin/attendance/people/${outsider}`)).status, 404, 'outside their team');
  assert.equal((await lead.go(`/admin/attendance/people/${member}`)).status, 200);
  assert.equal((await lead.go('/admin/attendance/settings')).status, 303, 'settings are HR’s');
  user('No Team', 'noteam@thewave.test', 'agent');
  const nobody = browser();
  await nobody.signIn('noteam@thewave.test');
  assert.equal((await nobody.go('/admin/attendance')).status, 303, 'refused');
  const j = await nobody.go('/admin/attendance/live.json', { headers: { accept: 'application/json' } });
  assert.notEqual(j.status, 200);
  // HR: the live JSON and every page, in English and Arabic
  const live = await (await admin.go('/admin/attendance/live.json', { headers: { accept: 'application/json' } })).json();
  assert.equal(live.ok, true);
  assert.match(live.html, /Walid Test/);
  assert.match(live.html, /att-card/);
  const someone = db.value("SELECT id FROM employees WHERE name = 'Walid Test'");
  for (const lang of ['en', 'ar']) {
    await admin.go(`/admin?lang=${lang}`);
    for (const p of ['/admin/attendance', '/admin/attendance/activity', '/admin/attendance/timesheets', '/admin/attendance/timesheets?view=day', '/admin/attendance/exceptions', '/admin/attendance/shifts', '/admin/attendance/devices', '/admin/attendance/settings', '/admin/attendance/payroll', `/admin/attendance/people/${someone}`, `/admin/attendance/people/${someone}/timesheet`, '/admin/attendance/timesheets.csv']) {
      const r = await admin.go(p);
      assert.equal(r.status, 200, `${lang} ${p}`);
      const body = await r.text();
      assert.doesNotMatch(body, /att\|/, `${lang} ${p}: a key without its text`);
    }
  }
  await admin.go('/admin?lang=en');
  const ar = await (await browser().go('/staff/login?lang=ar')).text();
  assert.match(ar, /تسجيل الدخول/);
  // settings: a Google Maps link sets the circle
  await admin.form('/admin/attendance/settings', { part: 'fence', point: 'https://www.google.com/maps/@30.0300,31.4700,17z', radius: '120', max_acc: '50' });
  assert.equal(db.setting('att_lat'), '30.03');
  assert.equal(db.setting('att_radius'), '120');
  await admin.form('/admin/attendance/settings', { part: 'fence', point: `${CENTER.lat}, ${CENTER.lng}`, radius: '100', max_acc: '60' });
});

test('attendance: overtime and absences go into a draft payroll only, and people not on attendance keep what was typed', async () => {
  const key = E.cairo(Date.now()).date.slice(0, 7);
  const tracked = employee('Payroll Tracked');
  const untracked = employee('Payroll Untracked');
  const sid = Number(db.run("INSERT INTO att_shifts (name, start_hm, end_hm, days, grace_min, break_min, created_at) VALUES ('Payroll day', '09:00', '17:00', '1234567', 10, 0, datetime('now'))").lastInsertRowid);
  S.assign(tracked, sid, `${key}-01`, null, null);
  // a day with two hours over the shift on the 1st (it has passed in any month)
  const on = E.shiftOn(S.shiftById(sid), `${key}-01`);
  S.clock(S.empOf(tracked), { kind: 'in', at: on.start, source: 'hr', note: 't' });
  S.clock(S.empOf(tracked), { kind: 'out', at: new Date(Date.parse(on.end) + 120 * 60000).toISOString(), source: 'hr', note: 't' });
  db.run('DELETE FROM payroll_runs WHERE period = ?', key);
  await admin.form('/admin/hr/payroll', { period: key });
  const run = db.get('SELECT * FROM payroll_runs WHERE period = ?', key);
  assert.ok(run, 'a draft payroll');
  db.run('UPDATE payroll_lines SET overtime = 999 WHERE run_id = ? AND employee_id = ?', run.id, untracked);
  await admin.form('/admin/attendance/payroll', { month: key });
  const line = (id) => db.get('SELECT * FROM payroll_lines WHERE run_id = ? AND employee_id = ?', run.id, id);
  // 120 min × (12 000 ÷ 30 ÷ 8) × 1.35
  assert.equal(line(tracked).overtime, Math.round(2 * (12000 / 30 / 8) * 1.35 * 100) / 100);
  assert.equal(line(untracked).overtime, 999, 'not on attendance: left as typed');
  db.run("UPDATE payroll_runs SET status = 'approved' WHERE id = ?", run.id);
  db.run('UPDATE payroll_lines SET overtime = 5 WHERE run_id = ? AND employee_id = ?', run.id, tracked);
  await admin.form('/admin/attendance/payroll', { month: key });
  assert.equal(line(tracked).overtime, 5, 'an approved payroll never changes');
  db.run('DELETE FROM payroll_runs WHERE id = ?', run.id);
});
