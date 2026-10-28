'use strict';

// Operations: short-term space (rate-card prices, clashes, invoices through billing), maintenance
// (SLA breaches, preventive plans raised once per date, costs sent to the accounts, tenant requests
// through the portal) and footfall (CSV import that never doubles counts, the counters' ingest key).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const M = require('../src/admin/model');
const specialty = require('../src/admin/routes/specialty');
const maintenance = require('../src/admin/routes/maintenance');
const footfall = require('../src/admin/routes/footfall');

const FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-ops-test-'));
const KEY = 'counter-key-0123456789';
const SECRET = 'hmac-secret-abcdef';
let server;
let base;
let db;
let h;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:', ADMIN_FILES: FILES, ADMIN_JOBS: '0', FOOTFALL_API_KEY: KEY, FOOTFALL_HMAC_SECRET: SECRET }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(FILES, { recursive: true, force: true });
});

function browser(prefix = '/admin') {
  const jar = new Map();
  const go = async (p, opts = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const b = {
    go,
    csrf: null,
    form: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: b.csrf, ...data }).toString() }),
    async signIn(email, password) {
      const html = await (await go(`${prefix}/login`)).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go(`${prefix}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303, `sign-in ${email}`);
      b.csrf = (await (await go(prefix)).text()).match(/name="csrf" content="([^"]+)"/)[1];
    },
  };
  return b;
}
const user = (name, email, role) => db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, datetime('now'))", name, email, role, hashPassword('long-enough-1')).lastInsertRowid;
const day = (n) => M.addDays(M.today(), n);
const idFrom = (res) => Number(res.headers.get('location').match(/(\d+)$/)[1]);

let admin;
let agent;
test('ops: sign in an administrator and an agent', async () => {
  user('Ops Admin', 'ops-admin@thewave.test', 'admin');
  user('Ops Agent', 'ops-agent@thewave.test', 'agent');
  admin = browser();
  await admin.signIn('ops-admin@thewave.test', 'long-enough-1');
  agent = browser();
  await agent.signIn('ops-agent@thewave.test', 'long-enough-1');
});

test('specialty: rate-card price — day, week and month rates, weekends, peaks, minimum days, loop share', () => {
  const s = { type: 'kiosk', rate_day: 1000, rate_week: 5600, rate_month: 18000, weekend_pct: 20, min_days: 2 };
  // Mon 2 Nov 2026 to Wed 4 Nov: three weekdays at the day rate
  assert.equal(specialty.quote(s, '2026-11-02', '2026-11-04').total, 3000);
  // Thu 5 to Sat 7: one weekday and two weekend days (+20%)
  const q = specialty.quote(s, '2026-11-05', '2026-11-07');
  assert.equal(q.total, 1000 + 1200 * 2);
  assert.equal(q.weekendDays, 2);
  // seven days use the weekly rate: 800 a day, two weekend days +20%
  assert.equal(specialty.quote(s, '2026-11-02', '2026-11-08').total, 800 * 5 + 960 * 2);
  assert.equal(specialty.quote(s, '2026-11-02', '2026-11-08').rate, 'week');
  // thirty days use the monthly rate
  assert.equal(specialty.quote({ ...s, weekend_pct: 0 }, '2026-11-01', '2026-11-30').total, 18000);
  // a peak period adds on top
  assert.equal(specialty.quote(s, '2026-11-02', '2026-11-03', { peaks: [{ start_date: '2026-11-03', end_date: '2026-11-10', pct: 50 }] }).total, 1000 + 1500);
  assert.match(specialty.quote(s, '2026-11-02', '2026-11-02').error, /at least/);
  assert.match(specialty.quote(s, '2026-11-05', '2026-11-02').error, /end/);
  // a screen: the advertiser pays its share of the loop
  assert.equal(specialty.quote({ type: 'screen', rate_day: 2000, min_days: 1 }, '2026-11-02', '2026-11-03', { share: 25 }).total, 1000);
});

test('specialty: bookings cannot clash, holds expire, confirming invoices through billing, cancelling voids', async () => {
  let res = await admin.form('/admin/specialty/spaces', { code: 'k-77', name: 'Test kiosk', type: 'kiosk', rate_day: 1000, rate_week: 6000, weekend_pct: 0, min_days: 1, deposit: 5000 });
  const space = idFrom(res);
  assert.equal(db.get('SELECT code FROM spaces WHERE id = ?', space).code, 'K-77');
  res = await admin.form('/admin/specialty/bookings', { space_id: space, start_date: day(10), end_date: day(12), customer: 'Pop Up Co', status: 'held' });
  const first = idFrom(res);
  const b1 = db.get('SELECT * FROM space_bookings WHERE id = ?', first);
  assert.equal(b1.status, 'held');
  assert.equal(b1.price, 3000);
  assert.ok(b1.hold_until > M.today());
  // overlapping dates are refused while the hold stands
  res = await admin.form('/admin/specialty/bookings', { space_id: space, start_date: day(12), end_date: day(14), customer: 'Other Co', status: 'held' });
  assert.match(res.headers.get('location'), /bookings\/new/);
  assert.equal(db.value('SELECT COUNT(*) FROM space_bookings WHERE space_id = ?', space), 1);
  // the live quote says so too
  const q = await (await admin.go('/admin/specialty/quote', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf': admin.csrf }, body: JSON.stringify({ space_id: space, start_date: day(11), end_date: day(11) }) })).json();
  assert.ok(q.ok);
  assert.match(q.clash, new RegExp(b1.ref));
  // an expired hold frees the dates
  db.run('UPDATE space_bookings SET hold_until = ? WHERE id = ?', day(-1), first);
  await admin.go('/admin/specialty');
  assert.equal(db.value('SELECT status FROM space_bookings WHERE id = ?', first), 'enquiry');
  res = await admin.form('/admin/specialty/bookings', { space_id: space, start_date: day(12), end_date: day(13), customer: 'Other Co', status: 'held' });
  const second = idFrom(res);
  // confirming the first now clashes with the second
  res = await admin.form(`/admin/specialty/bookings/${first}/confirm`, {});
  assert.equal(db.value('SELECT status FROM space_bookings WHERE id = ?', first), 'enquiry');
  // confirm the second: an invoice of kind specialty and a deposit invoice
  res = await admin.form(`/admin/specialty/bookings/${second}/confirm`, {});
  const b2 = db.get('SELECT * FROM space_bookings WHERE id = ?', second);
  assert.equal(b2.status, 'confirmed');
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', b2.invoice_id);
  assert.equal(inv.kind, 'specialty');
  assert.equal(inv.customer, 'Other Co');
  assert.equal(inv.total - inv.vat, 2000);
  assert.equal(inv.source, 'space_booking');
  assert.equal(db.get('SELECT kind, total FROM invoices WHERE id = ?', b2.deposit_invoice_id).kind, 'deposit');
  // the printable summary, both languages
  for (const lang of ['en', 'ar']) {
    const r = await admin.go(`/admin/specialty/bookings/${second}/print?doc=${lang}`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), lang === 'ar' ? /حجز مساحة مؤقتة/ : /Short-term space booking/);
  }
  // cancelling voids the unpaid invoices
  await admin.form(`/admin/specialty/bookings/${second}/cancel`, { reason: 'Withdrew' });
  assert.equal(db.value('SELECT status FROM invoices WHERE id = ?', b2.invoice_id), 'void');
  assert.equal(db.value('SELECT status FROM space_bookings WHERE id = ?', second), 'cancelled');
});

test('specialty: screens share the loop; deep discounts wait for a manager', async () => {
  let res = await admin.form('/admin/specialty/spaces', { code: 'D-77', name: 'Test screen', type: 'screen', rate_day: 2000, min_days: 1 });
  const screen = idFrom(res);
  await admin.form('/admin/specialty/bookings', { space_id: screen, start_date: day(5), end_date: day(6), customer: 'A', share_pct: 60, status: 'held' });
  await admin.form('/admin/specialty/bookings', { space_id: screen, start_date: day(5), end_date: day(6), customer: 'B', share_pct: 40, status: 'held' });
  res = await admin.form('/admin/specialty/bookings', { space_id: screen, start_date: day(6), end_date: day(7), customer: 'C', share_pct: 10, status: 'held' });
  assert.equal(db.value('SELECT COUNT(*) FROM space_bookings WHERE space_id = ?', screen), 2, 'the loop is full on day 6');
  assert.equal(db.value("SELECT price FROM space_bookings WHERE space_id = ? AND customer = 'B'", screen), 1600);
  // an agent's 30% discount needs approval before it can be confirmed
  res = await agent.form('/admin/specialty/bookings', { space_id: screen, start_date: day(20), end_date: day(20), customer: 'D', share_pct: 100, price: 1400, override_reason: 'Launch partner', status: 'held' });
  const id = idFrom(res);
  assert.equal(db.value('SELECT needs_approval FROM space_bookings WHERE id = ?', id), 1);
  await agent.form(`/admin/specialty/bookings/${id}/confirm`, {});
  assert.equal(db.value('SELECT status FROM space_bookings WHERE id = ?', id), 'held');
  await admin.form(`/admin/specialty/bookings/${id}/approve`, {});
  await agent.form(`/admin/specialty/bookings/${id}/confirm`, {});
  assert.equal(db.value('SELECT status FROM space_bookings WHERE id = ?', id), 'confirmed');
  // a price without a reason is refused
  res = await agent.form('/admin/specialty/bookings', { space_id: screen, start_date: day(25), end_date: day(25), customer: 'E', price: 100, status: 'held' });
  assert.match(res.headers.get('location'), /bookings\/new/);
});

test('maintenance: SLA timers and breaches', async () => {
  const wo = { status: 'in_progress', created_at: '2026-01-01T08:00:00.000Z', response_due: '2026-01-01T09:00:00.000Z', resolve_due: '2026-01-01T12:00:00.000Z', responded_at: '2026-01-01T08:30:00.000Z', resolved_at: null };
  assert.equal(maintenance.sla(wo, '2026-01-01T10:00:00.000Z').breached, false);
  assert.equal(maintenance.sla(wo, '2026-01-01T10:00:00.000Z').response.state, 'met');
  assert.equal(maintenance.sla(wo, '2026-01-01T11:30:00.000Z').resolution.state, 'due');
  assert.equal(maintenance.sla(wo, '2026-01-01T12:30:00.000Z').breached, true);
  assert.equal(maintenance.sla({ ...wo, responded_at: null, status: 'new' }, '2026-01-01T09:30:00.000Z').response.state, 'breached');
  assert.equal(maintenance.sla({ ...wo, status: 'resolved', resolved_at: '2026-01-01T11:00:00.000Z' }, '2026-02-01T00:00:00.000Z').breached, false);

  // a P1 raised three hours ago and never answered is late, counted in the sidebar badge
  let res = await admin.form('/admin/maintenance/orders', { title: 'Lift stuck', category: 'lifts', priority: 1 });
  const id = idFrom(res);
  const w = db.get('SELECT * FROM work_orders WHERE id = ?', id);
  assert.match(w.ref, /^WO-\d{4}-\d{4}$/);
  assert.equal(Date.parse(w.resolve_due) - Date.parse(w.created_at), 4 * 3600000);
  const past = new Date(Date.now() - 3 * 3600000).toISOString();
  db.run('UPDATE work_orders SET created_at = ?, response_due = ?, resolve_due = ? WHERE id = ?', past, new Date(Date.now() - 2 * 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString(), id);
  const late = await (await admin.go('/admin/maintenance/orders?view=late')).text();
  assert.match(late, /Lift stuck/);
  // status flow, with a reopen
  res = await admin.form(`/admin/maintenance/orders/${id}/status`, { status: 'closed' });
  assert.equal(db.value('SELECT status FROM work_orders WHERE id = ?', id), 'new', 'cannot jump to closed');
  await admin.form(`/admin/maintenance/orders/${id}/status`, { status: 'in_progress' });
  await admin.form(`/admin/maintenance/orders/${id}/status`, { status: 'resolved' });
  await admin.form(`/admin/maintenance/orders/${id}/status`, { status: 'reopened' });
  const r = db.get('SELECT * FROM work_orders WHERE id = ?', id);
  assert.equal(r.status, 'reopened');
  assert.equal(r.reopened, 1);
  assert.equal(r.resolved_at, null);
  assert.ok(r.responded_at);
  // the SLA targets are editable and must make sense
  res = await admin.form('/admin/maintenance/settings', { r1: 2, f1: 1, r2: 4, f2: 24, r3: 24, f3: 72, r4: 72, f4: 240 });
  assert.equal(db.setting('maintenance_sla') || '', '');
  await admin.form('/admin/maintenance/settings', { r1: 0.5, f1: 2, r2: 4, f2: 24, r3: 24, f3: 72, r4: 72, f4: 240 });
  assert.deepEqual(JSON.parse(db.setting('maintenance_sla'))[1], [0.5, 2]);
});

test('maintenance: a cost becomes an expense for the accounts', async () => {
  const seen = [];
  h.events.on('expense.incurred', (e) => seen.push(e));
  let res = await admin.form('/admin/maintenance/orders', { title: 'Leak in toilets', category: 'plumbing', priority: 3 });
  const id = idFrom(res);
  res = await admin.form(`/admin/maintenance/orders/${id}/cost`, { type: 'parts', amount: '1250.50', vendor: 'Pipe Shop', date: '2026-10-20', memo: 'Valves' });
  assert.equal(db.value('SELECT cost_parts FROM work_orders WHERE id = ?', id), 1250.5);
  assert.equal(seen.length, 1);
  const e = seen[0];
  assert.equal(e.amount, 1250.5);
  assert.equal(e.date, '2026-10-20');
  assert.equal(e.vendor, 'Pipe Shop');
  assert.equal(e.category, 'maintenance');
  assert.equal(e.source, 'work_order');
  assert.ok(e.source_id);
  assert.match(e.memo, /Leak in toilets/);
  // nothing for a zero amount
  await admin.form(`/admin/maintenance/orders/${id}/cost`, { type: 'parts', amount: '0', date: '2026-10-20' });
  assert.equal(seen.length, 1);
});

test('maintenance: preventive plans raise one work order per due date, never twice', async () => {
  let res = await admin.form('/admin/maintenance/assets', { code: 'h-900', name: 'Test chiller', category: 'hvac', criticality: 'high' });
  const asset = idFrom(res);
  res = await admin.form('/admin/maintenance/ppm', { title: 'Weekly check', asset_id: asset, every_n: 1, every_unit: 'week', next_due: day(-14), checklist: 'One\nTwo' });
  const plan = idFrom(res);
  const count = () => db.value('SELECT COUNT(*) FROM work_orders WHERE ppm_id = ?', plan);
  const after = count();
  // -14, -7, 0, +7 (inside the seven-day lookahead)
  assert.equal(after, 4);
  assert.equal(maintenance.generatePpm(db, { today: M.today() }), 0);
  await admin.go('/admin/maintenance');
  await admin.go('/admin/maintenance/ppm');
  assert.equal(count(), after);
  assert.equal(db.value('SELECT next_due FROM ppm_plans WHERE id = ?', plan), day(14));
  // moving the plan back does not duplicate a date it already raised
  db.run('UPDATE ppm_plans SET next_due = ? WHERE id = ?', day(-14), plan);
  maintenance.generatePpm(db, { today: M.today() });
  assert.equal(count(), after);
  assert.equal(db.value('SELECT COUNT(DISTINCT due_date) FROM work_orders WHERE ppm_id = ?', plan), after);
  assert.equal(db.value('SELECT checklist FROM work_orders WHERE ppm_id = ? LIMIT 1', plan), 'One\nTwo');
  assert.equal(maintenance.nextDue('2026-01-31', 1, 'month'), '2026-02-28');
});

test('maintenance: tenants raise requests in the portal and see only their own', async (t) => {
  if (!h.portal) return t.skip('no tenant portal');
  const brandA = db.run("INSERT INTO brands (name, category, created_at) VALUES ('Ops Brand A', 'fashion', datetime('now'))").lastInsertRowid;
  const brandB = db.run("INSERT INTO brands (name, category, created_at) VALUES ('Ops Brand B', 'fashion', datetime('now'))").lastInsertRowid;
  for (const [b, email] of [[brandA, 'a@tenant.test'], [brandB, 'b@tenant.test']]) db.run("INSERT INTO portal_users (brand_id, name, email, password_hash, created_at) VALUES (?, 'Tenant', ?, ?, datetime('now'))", b, email, hashPassword('long-enough-1'));
  const a = browser('/portal');
  await a.signIn('a@tenant.test', 'long-enough-1');
  const b = browser('/portal');
  await b.signIn('b@tenant.test', 'long-enough-1');
  assert.match(await (await a.go('/portal/requests')).text(), /requests/);
  let res = await a.form('/portal/requests', { title: 'Door handle broken', category: 'civil', priority: 2, description: 'Front door' });
  assert.equal(res.status, 303);
  const id = idFrom(res);
  const w = db.get('SELECT * FROM work_orders WHERE id = ?', id);
  assert.equal(w.source, 'tenant');
  assert.equal(w.brand_id, Number(brandA));
  assert.equal(w.priority, 2);
  // the other tenant cannot see, comment on, rate or upload to it
  assert.equal((await b.go(`/portal/requests/${id}`)).status, 404);
  assert.doesNotMatch(await (await b.go('/portal/requests')).text(), /Door handle broken/);
  await b.form(`/portal/requests/${id}/comment`, { body: 'Sneaky' });
  assert.equal(db.value("SELECT COUNT(*) FROM wo_events WHERE wo_id = ? AND kind = 'comment'", id), 0);
  res = await b.go(`/portal/requests/${id}/files?kind=wo_photo`, { method: 'POST', headers: { 'x-csrf': b.csrf, 'x-file-name': 'x.png', accept: 'application/json' }, body: Buffer.from('x') });
  assert.equal(res.status, 404);
  // without the form token nothing is posted
  res = await a.go(`/portal/requests/${id}/comment`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'body=hi' });
  assert.equal(res.status, 403);
  // staff answer it; the tenant sees shared comments only, then rates the fix
  await admin.form(`/admin/maintenance/orders/${id}/comment`, { body: 'Technician at 10:00', shared: '1' });
  await admin.form(`/admin/maintenance/orders/${id}/comment`, { body: 'Internal note only' });
  let page = await (await a.go(`/portal/requests/${id}`)).text();
  assert.match(page, /Technician at 10:00/);
  assert.doesNotMatch(page, /Internal note only/);
  await admin.form(`/admin/maintenance/orders/${id}/status`, { status: 'resolved' });
  await b.form(`/portal/requests/${id}/rate`, { rating: 1 });
  assert.equal(db.value('SELECT rating FROM work_orders WHERE id = ?', id), null);
  await a.form(`/portal/requests/${id}/rate`, { rating: 4, note: 'Good' });
  assert.equal(db.value('SELECT rating FROM work_orders WHERE id = ?', id), 4);
  page = await (await admin.go(`/admin/maintenance/orders/${id}`)).text();
  assert.match(page, /Rated 4 out of 5/);
});

test('footfall: CSV import with column mapping never doubles counts', async () => {
  const csv = 'Date;Hour;Door;Visitors In;Visitors Out\n01/10/2026;10;North gate;1.200;300\n01/10/2026;11;North gate;950;700\n01/10/2026;11;South gate;400;380\nbad;row;x;1;1\n';
  const run = async () => {
    let res = await admin.form('/admin/footfall/import/stage-text', { kind: 'footfall', csv });
    const id = idFrom(res);
    const page = await (await admin.go(`/admin/footfall/import/${id}`)).text();
    assert.match(page, /1 row will be skipped/);
    res = await admin.form(`/admin/footfall/import/${id}/run`, { m_date: 0, m_hour: 1, m_entrance: 2, m_in: 3, m_out: 4 });
    assert.equal(res.status, 303);
    return db.get('SELECT * FROM footfall_imports WHERE id = ?', id);
  };
  const first = await run();
  assert.equal(first.inserted, 3);
  assert.equal(first.skipped, 1);
  const total = () => db.value("SELECT SUM(visitors_in) FROM footfall WHERE ts_hour LIKE '2026-10-01%'");
  assert.equal(total(), 1200 + 950 + 400);
  const again = await run();
  assert.equal(again.inserted, 0);
  assert.equal(again.unchanged, 3);
  assert.equal(total(), 2550, 'the same file twice changes nothing');
  assert.equal(db.value("SELECT COUNT(*) FROM footfall_entrances WHERE name IN ('North gate', 'South gate')"), 2);
  // a corrected file replaces the hour
  const fixed = footfall.readRows([['2026-10-01T10:00', 'North gate', '1250', '300']], 'footfall', { time: 0, entrance: 1, in: 2, out: 3 });
  const out = footfall.store(db, 'footfall', fixed.records);
  assert.equal(out.updated, 1);
  assert.equal(total(), 2600);
  // the dashboard and the export render
  assert.equal((await admin.go('/admin/footfall?p=month')).status, 200);
  assert.match(await (await admin.go('/admin/footfall/export.csv?p=month')).text(), /North gate \(in\)/);
});

test('footfall: the counters need the API key (and the signature) to send counts', async () => {
  const body = JSON.stringify({ records: [{ time: '2026-10-02T14:00:00+03:00', entrance: 'N9', in: 321, out: 300 }], parking: [{ time: '2026-10-02 14:00', entries: 40, exits: 10, occupancy: 400 }] });
  const sign = (s) => `sha256=${crypto.createHmac('sha256', SECRET).update(s).digest('hex')}`;
  const send = (headers, b = body) => fetch(`${base}/ingest/footfall`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: b });
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ authorization: 'Bearer wrong-key', 'x-signature': sign(body) })).status, 401);
  assert.equal((await send({ authorization: `Bearer ${KEY}` })).status, 401, 'signature required');
  assert.equal((await send({ authorization: `Bearer ${KEY}`, 'x-signature': sign(`${body} `) })).status, 401, 'signature must match the body');
  let res = await send({ 'x-api-key': KEY, 'x-signature': sign(body) });
  assert.equal(res.status, 200);
  let j = await res.json();
  assert.equal(j.footfall.inserted, 1);
  assert.equal(j.parking.inserted, 1);
  assert.deepEqual(j.footfall.new_entrances, ['N9']);
  assert.equal(db.value("SELECT visitors_in FROM footfall WHERE ts_hour = '2026-10-02T14' AND entrance = 'N9'"), 321);
  res = await send({ authorization: `Bearer ${KEY}`, 'x-signature': sign(body) });
  j = await res.json();
  assert.equal(j.footfall.unchanged, 1, 'sending the same hour again replaces it');
  assert.equal(db.value("SELECT COUNT(*) FROM footfall WHERE entrance = 'N9'"), 1);
  // the Integrations page shows the card
  assert.match(await (await admin.go('/admin/integrations')).text(), /People counters and parking/);
});

test('footfall: no key configured means the ingest is closed', async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  await app.locals.admin.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/ingest/footfall`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer anything' }, body: '{"records":[]}' });
    assert.equal(res.status, 503);
  } finally {
    s.close();
  }
});

test('ops: sample data loads, every page renders, and it clears again', async () => {
  await admin.form('/admin/settings/demo', {});
  assert.ok(db.value('SELECT COUNT(*) FROM spaces WHERE demo = 1') >= 12);
  assert.ok(db.value('SELECT COUNT(*) FROM work_orders WHERE demo = 1') >= 40);
  assert.ok(db.value("SELECT COUNT(*) FROM invoices WHERE kind = 'specialty' AND demo = 1 AND status = 'paid'") > 0);
  assert.ok(db.value('SELECT COUNT(DISTINCT substr(ts_hour, 1, 10)) FROM footfall WHERE demo = 1') >= 90);
  const pages = ['/admin/specialty', '/admin/specialty?view=week', '/admin/specialty/spaces', '/admin/specialty/bookings', '/admin/specialty/bookings/new',
    '/admin/maintenance', '/admin/maintenance/orders', '/admin/maintenance/orders?view=all&page=2', '/admin/maintenance/assets', '/admin/maintenance/ppm', '/admin/maintenance/settings',
    '/admin/footfall', '/admin/footfall?p=yesterday', '/admin/footfall?p=week', '/admin/footfall?p=month', '/admin/footfall/import', '/admin/footfall/setup'];
  const one = (t, q) => db.value(`SELECT id FROM ${t} WHERE demo = 1 ${q || ''} ORDER BY id LIMIT 1`);
  pages.push(`/admin/specialty/spaces/${one('spaces')}`, `/admin/specialty/bookings/${one('space_bookings')}`, `/admin/specialty/bookings/${one('space_bookings')}/print`,
    `/admin/maintenance/orders/${one('work_orders', "AND source = 'tenant'")}`, `/admin/maintenance/assets/${one('assets')}`, `/admin/maintenance/ppm/${one('ppm_plans')}`);
  for (const p of pages) {
    const res = await admin.go(p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, p);
  }
  await admin.form('/admin/settings/demo/clear', {});
  for (const t of ['spaces', 'space_bookings', 'assets', 'work_orders', 'ppm_plans', 'footfall', 'parking']) assert.equal(db.value(`SELECT COUNT(*) FROM ${t} WHERE demo = 1`), 0, t);
  assert.equal(db.value("SELECT COUNT(*) FROM wo_events WHERE wo_id NOT IN (SELECT id FROM work_orders)"), 0);
});
