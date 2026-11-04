'use strict';

// Operations, third round: security and cleaning (patrol checkpoints and rounds scanned from a phone,
// missed and late rounds, cleaning areas marked clean by QR with a supervisor check, cleaning
// alerts, incidents, lost and found, keys, the shift handover), safety and licences (the register,
// recording tests, due alerts by email, tenant insurance reminders), and shopper feedback (the
// public page and its spam guards, routing to cleaning and maintenance, tickets, the dashboard).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let db;
let h;
let admin;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  db.run("INSERT INTO users (name, email, role, password_hash, finance, hr, created_at) VALUES ('Security Head', 'sec-admin@thewave.test', 'admin', ?, 1, 1, datetime('now'))", hashPassword('long-enough-1'));
  db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES ('Guard Two', 'guard@thewave.test', 'agent', ?, datetime('now'))", hashPassword('long-enough-1'));
  admin = browser();
  await admin.signIn('sec-admin@thewave.test', 'long-enough-1');
  admin.user = db.get("SELECT * FROM users WHERE email = 'sec-admin@thewave.test'");
});
after(() => server.close());

function browser() {
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
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303);
      const page = await (await go('/admin')).text();
      b.csrf = (page.match(/name="csrf" content="([^"]+)"/) || page.match(/name="_csrf" value="([^"]+)"/))[1];
    },
  };
  return b;
}
const ok = async (p) => {
  const r = await admin.go(p);
  assert.equal(r.status, 200, p);
  return r.text();
};
const pub = (p, data, headers = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data).toString() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('patrols: checkpoints, a route, scanning from the phone starts and closes a round', async () => {
  for (const [code, name] of [['T-01', 'Test gate'], ['T-02', 'Test stairs']]) {
    const r = await admin.form('/admin/security/patrols/checkpoints', { code, name, place: 'Ground floor' });
    assert.equal(r.status, 303);
  }
  const cps = db.all("SELECT * FROM sec_checkpoints WHERE code LIKE 'T-%' ORDER BY code");
  assert.equal(cps.length, 2);
  assert.ok(cps[0].token.length >= 10, 'each sticker has a secret token');
  const dup = await admin.form('/admin/security/patrols/checkpoints', { code: 't-01', name: 'Again' });
  assert.match(decodeURIComponent(dup.headers.get('set-cookie') || ''), /already used/);
  // the ticked checkpoints arrive as cp=…&cp=…
  const body = new URLSearchParams([['_csrf', admin.csrf], ['name', 'Test route'], ['every_min', '60'], ['window_min', '30'], ['start_hm', '00:00'], ['end_hm', '23:59'], ['cp', String(cps[0].id)], ['cp', String(cps[1].id)]]);
  await admin.go('/admin/security/patrols/routes', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const route = db.get("SELECT * FROM sec_routes WHERE name = 'Test route'");
  assert.deepEqual(JSON.parse(route.checkpoints), [cps[0].id, cps[1].id]);
  assert.equal(route.end_hm, '24:00', '23:59 means to the end of the day');

  const page = await ok(`/admin/security/scan/${cps[0].token}`);
  assert.match(page, /Record this checkpoint/);
  assert.match(page, /This scan starts a new round/);
  let r = await admin.form(`/admin/security/scan/${cps[0].token}`, { route_id: route.id, guard: 'Security Head', note: 'All quiet' });
  assert.equal(r.status, 303);
  const round = db.get('SELECT * FROM sec_rounds WHERE route_id = ?', route.id);
  assert.equal(round.status, 'open');
  assert.ok(round.slot_at, 'the round knows its slot');
  assert.match(r.headers.get('location'), new RegExp(`/admin/security/rounds/${round.id}$`));
  r = await admin.form(`/admin/security/scan/${cps[1].token}`, { route_id: route.id, guard: 'Security Head' });
  assert.equal(db.get('SELECT status FROM sec_rounds WHERE id = ?', round.id).status, 'done', 'the last checkpoint closes the round');
  assert.equal(db.value('SELECT COUNT(*) FROM sec_scans WHERE round_id = ?', round.id), 2);
  const rp = await ok(`/admin/security/rounds/${round.id}`);
  assert.match(rp, /Test gate/);
  assert.equal((await admin.go('/admin/security/scan/not-a-token')).status, 404);

  // yesterday: every hour was due, none was walked
  const yesterday = h.security.localDay(h.security.atLocal(h.security.localDay(), -720));
  const day = h.security.patrolDay(yesterday).routes.find((x) => x.route.id === route.id);
  assert.equal(day.missed, 24, 'every slot of yesterday was missed');
  assert.equal(day.expected, 48);
  assert.equal(day.scanned, 0);

  // a round that ran out of time is closed as incomplete
  const old = h.security.startRound(db.get('SELECT * FROM sec_routes WHERE id = ?', route.id), { guard: 'Night guard', at: new Date(Date.now() - 2 * 3600000).toISOString() });
  h.security.settle();
  assert.equal(db.get('SELECT status FROM sec_rounds WHERE id = ?', old).status, 'incomplete');

  const report = await ok('/admin/security/patrols/report');
  assert.match(report, /Security Head/);
  assert.match(report, /Night guard/);
  await ok('/admin/security/patrols');
  const qr = await ok('/admin/security/patrols/qr');
  assert.match(qr, /<svg/);
  assert.equal(qr.split('<figure').length - 1, db.value('SELECT COUNT(*) FROM sec_checkpoints WHERE active = 1'), 'one sticker per checkpoint');
});

test('cleaning: areas, marking clean from the QR, overdue, the supervisor sends one back', async () => {
  await admin.form('/admin/security/cleaning/areas', { code: 'TC-1', name: 'Test toilets', kind: 'toilets', every_min: 30, start_hm: '00:00', end_hm: '23:59' });
  const a = db.get("SELECT * FROM sec_clean_areas WHERE code = 'TC-1'");
  assert.ok(a);
  // cleaned 50 minutes ago, every 30 minutes: overdue
  db.run('INSERT INTO sec_clean_logs (area_id, cleaner_name, at, check_status) VALUES (?, ?, ?, ?)', a.id, 'Earlier cleaner', new Date(Date.now() - 50 * 60000).toISOString(), 'ok');
  assert.equal(h.security.areaState(a).state, 'overdue');
  assert.ok(h.security.areaState(a).late >= 19);

  await ok(`/admin/security/clean/${a.token}`);
  const r = await admin.form(`/admin/security/clean/${a.token}`, { cleaner: 'Samia', note: 'Refilled soap' });
  assert.equal(r.status, 303);
  const log = db.get('SELECT * FROM sec_clean_logs WHERE area_id = ? ORDER BY id DESC LIMIT 1', a.id);
  assert.equal(log.cleaner_name, 'Samia');
  assert.match(r.headers.get('location'), new RegExp(`/admin/security/cleaning/logs/${log.id}$`));
  assert.equal(h.security.areaState(a).state, 'ok');
  const lp = await ok(`/admin/security/cleaning/logs/${log.id}`);
  assert.match(lp, /data-upload="\/admin\/security\/cleaning\/upload\?entity=sec_clean/, 'the photo goes on the clean');

  // the supervisor is not happy: a cleaning alert on the area
  await admin.form(`/admin/security/cleaning/logs/${log.id}/check`, { result: 'redo', check_note: 'Bins still full' });
  assert.equal(db.get('SELECT check_status FROM sec_clean_logs WHERE id = ?', log.id).check_status, 'redo');
  assert.equal(h.security.areaState(a).state, 'alert');
  // cleaning again clears the alert
  await admin.form(`/admin/security/clean/${a.token}`, { cleaner: 'Samia' });
  assert.equal(db.value('SELECT COUNT(*) FROM sec_clean_alerts WHERE area_id = ? AND resolved_at IS NULL', a.id), 0);
  const c = h.security.cleanDay(h.security.localDay());
  assert.ok(c.areas.some((x) => x.area.id === a.id));
  const page = await ok('/admin/security/cleaning');
  assert.match(page, /Test toilets/);
  await ok(`/admin/security/cleaning/areas/${a.id}`);
  await ok('/admin/security/cleaning/qr');
});

test('incidents, lost and found, keys and the handover log', async () => {
  let r = await admin.form('/admin/security/incidents', { kind: 'theft', severity: 'high', title: 'Bag snatched at the fountain', at: '2026-11-03T18:40', place: 'Fountain court', people: 'Victim: Nour, 0100', cctv_ref: 'Cam 6' });
  assert.equal(r.status, 303);
  const i = db.get("SELECT * FROM sec_incidents WHERE title = 'Bag snatched at the fountain'");
  assert.match(i.ref, /^SI-\d{4}-\d{4}$/);
  assert.equal(i.status, 'open');
  assert.match(i.at, /^2026-11-03T1[56]:40/, 'Cairo time stored as UTC');
  await admin.form(`/admin/security/incidents/${i.id}/note`, { status: 'resolved', severity: 'high', body: 'Police took the report', outcome: 'Bag returned' });
  const after = db.get('SELECT * FROM sec_incidents WHERE id = ?', i.id);
  assert.equal(after.status, 'resolved');
  assert.ok(after.resolved_at);
  assert.equal(db.value('SELECT COUNT(*) FROM sec_incident_notes WHERE incident_id = ?', i.id), 2);
  const ip = await ok(`/admin/security/incidents/${i.id}`);
  assert.match(ip, /Police took the report/);
  await ok('/admin/security/incidents?status=all&kind=theft');

  await admin.form('/admin/security/lost', { item: 'Blue umbrella', category: 'other', found_where: 'Main entrance' });
  const l = db.get("SELECT * FROM sec_lost WHERE item = 'Blue umbrella'");
  assert.equal(l.status, 'held');
  r = await admin.form(`/admin/security/lost/${l.id}/return`, { returned_to: 'Omar' });
  assert.match(decodeURIComponent(r.headers.get('set-cookie') || ''), /name and ID/);
  await admin.form(`/admin/security/lost/${l.id}/return`, { returned_to: 'Omar', returned_id: '29001011234567' });
  const back = db.get('SELECT * FROM sec_lost WHERE id = ?', l.id);
  assert.equal(back.status, 'returned');
  assert.equal(back.returned_id, '29001011234567');

  await admin.form('/admin/security/keys', { code: 'TK-1', kind: 'key', opens: 'Test door', copies: 1 });
  const k = db.get("SELECT * FROM sec_keys WHERE code = 'TK-1'");
  await admin.form('/admin/security/keys/issue', { key_id: k.id, issued_to: 'Contractor A', due_at: '2026-01-01T10:00' });
  r = await admin.form('/admin/security/keys/issue', { key_id: k.id, issued_to: 'Contractor B' });
  assert.match(decodeURIComponent(r.headers.get('set-cookie') || ''), /Every copy/);
  const loan = db.get('SELECT * FROM sec_key_loans WHERE key_id = ?', k.id);
  assert.ok(loan.due_at < new Date().toISOString(), 'overdue');
  const counts = await ok('/admin/security');
  assert.match(counts, /Keys out/);
  await admin.form(`/admin/security/keys/loans/${loan.id}/return`, {});
  assert.ok(db.get('SELECT returned_at FROM sec_key_loans WHERE id = ?', loan.id).returned_at);
  await ok(`/admin/security/keys/${k.id}`);

  await admin.form('/admin/security/handover', { shift: 'evening', to_name: 'Guard Two', summary: 'Quiet evening', open_items: 'Check roof door' });
  const x = db.get("SELECT * FROM sec_handover WHERE summary = 'Quiet evening'");
  assert.ok(x);
  const guard = browser();
  await guard.signIn('guard@thewave.test', 'long-enough-1');
  await guard.form(`/admin/security/handover/${x.id}/ack`, {});
  assert.ok(db.get('SELECT ack_at FROM sec_handover WHERE id = ?', x.id).ack_at, 'the next shift confirms it read it');
  // a guard (agent) cannot change the patrol set-up
  r = await guard.form('/admin/security/patrols/checkpoints', { code: 'X-1', name: 'Nope' });
  assert.match(decodeURIComponent(r.headers.get('set-cookie') || ''), /does not allow/);
  assert.equal(db.value("SELECT COUNT(*) FROM sec_checkpoints WHERE code = 'X-1'"), 0);
});

test('safety and licences: the register, recording tests, alerts once, tenant insurance reminders', async () => {
  const T = h.M.today();
  let r = await admin.form('/admin/compliance/items', { category: 'fire_alarm', title: 'Test fire alarm', freq: 'quarterly', last_done: h.M.addDays(T, -100), owner_id: admin.user.id, remind_days: 21 });
  assert.equal(r.status, 303);
  const it = db.get("SELECT * FROM cmp_items WHERE title = 'Test fire alarm'");
  assert.equal(it.next_due, h.M.addMonths(h.M.addDays(T, -100), 3), 'counted from the last test');
  assert.equal(h.compliance.stateOf(it), 'overdue');

  // alerts go out once per due date and stage
  const before = db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'cmp_item' AND related_id = ?", it.id);
  assert.ok(h.compliance.alerts() >= 1);
  const sent = db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'cmp_item' AND related_id = ?", it.id);
  assert.ok(sent > before);
  assert.match(db.value("SELECT subject FROM outbox WHERE related_entity = 'cmp_item' AND related_id = ? ORDER BY id DESC LIMIT 1", it.id), /Overdue: Test fire alarm/);
  h.compliance.alerts();
  assert.equal(db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'cmp_item' AND related_id = ?", it.id), sent, 'not sent twice');

  // a failed test keeps it due; a passed one moves the date on
  await admin.form(`/admin/compliance/items/${it.id}/done`, { done_on: T, result: 'fail', note: 'Zone 3 sounder dead' });
  assert.equal(db.get('SELECT next_due FROM cmp_items WHERE id = ?', it.id).next_due, it.next_due);
  await admin.form(`/admin/compliance/items/${it.id}/done`, { done_on: T, result: 'pass', by_name: 'SafeTech', cert_no: 'C-1' });
  const done = db.get('SELECT * FROM cmp_items WHERE id = ?', it.id);
  assert.equal(done.next_due, h.M.addMonths(T, 3));
  assert.equal(done.last_done, T);
  assert.equal(done.alerted, null);
  assert.equal(db.value('SELECT COUNT(*) FROM cmp_done WHERE item_id = ?', it.id), 2);
  const page = await ok(`/admin/compliance/items/${it.id}`);
  assert.match(page, /Zone 3 sounder dead/);
  assert.match(page, /data-upload="\/admin\/compliance\/files\?entity=cmp_item/);
  const cal = await ok('/admin/compliance/calendar');
  assert.match(cal, /Test fire alarm/);
  await ok('/admin/compliance');
  await ok('/admin/compliance/history');

  // tenant insurance, read from the tenant's documents
  const b = Number(db.run("INSERT INTO brands (name, category, created_at) VALUES ('Insured Co', 'fashion', datetime('now'))").lastInsertRowid);
  db.run("INSERT INTO leases (ref, brand_id, status, start_date, end_date, term_years, rent_m2, created_at) VALUES ('LS-INS-1', ?, 'active', '2026-01-01', '2030-12-31', 5, 1000, ?)", b, new Date().toISOString());
  let row = h.compliance.insurance().find((x) => x.id === b);
  assert.equal(row.state, 'missing');
  db.run(`INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, expires_on, created_at)
    VALUES ('DOC-T-1', 'brand', ?, 'insurance', 'Policy 2025', 'p.pdf', 'application/pdf', 10, 'x', 'x', ?, datetime('now'))`, b, h.M.addDays(T, -3));
  row = h.compliance.insurance().find((x) => x.id === b);
  assert.equal(row.state, 'expired');
  r = await admin.form(`/admin/compliance/insurance/${b}/remind`, {});
  assert.equal(r.status, 303);
  const rem = db.get('SELECT * FROM cmp_reminders WHERE brand_id = ?', b);
  assert.ok(rem && rem.notice_id, 'the tenant got a notice');
  const n = db.get('SELECT * FROM portal_notices WHERE id = ?', rem.notice_id);
  assert.match(n.title_en, /expired/);
  assert.ok(n.title_ar && n.title_ar !== n.title_en, 'in both languages');
  const ins = await ok('/admin/compliance/insurance');
  assert.match(ins, /Insured Co/);
  assert.match(ins, /Not seen yet/);
});

test('shopper feedback: the public page, spam guards, routing, tickets and the dashboard', async () => {
  // a cleaning area for the poster
  const area = db.get("SELECT * FROM sec_clean_areas WHERE code = 'TC-1'");
  await admin.form('/admin/feedback/locations', { name: 'Test court', name_ar: 'ساحة الاختبار', code: 'Test Court', floor: 'GF', area_id: area.id });
  const loc = db.get("SELECT * FROM fb_locations WHERE name = 'Test court'");
  assert.equal(loc.code, 'test-court');
  assert.equal(loc.area_id, area.id);
  const poster = await ok(`/admin/feedback/locations/${loc.id}/poster`);
  assert.match(poster, /thewavemall\.test<\/code>|thewavemall\.test\/feedback\/test-court/);

  const form = await (await fetch(`${base}/feedback/test-court?lang=ar`)).text();
  assert.match(form, /<html lang="ar" dir="rtl"/);
  assert.match(form, /كيف كانت زيارتك/);
  assert.match(form, /ساحة الاختبار/);
  const ft = form.match(/name="ft" value="([^"]+)"/)[1];
  assert.equal((await fetch(`${base}/feedback/nowhere`)).status, 404);

  // too fast: a bot
  let r = await pub('/feedback/test-court', { ft, rating: 5, category: 'staff', lang: 'en' });
  assert.equal(r.status, 400);
  // a forged token
  r = await pub('/feedback/test-court', { ft: `${Date.now() - 10000}.forged`, rating: 5, lang: 'en' });
  assert.equal(r.status, 400);
  await sleep(2100);
  // the trap field filled in: thanked, not saved
  r = await pub('/feedback/test-court', { ft, rating: 1, website: 'http://spam', lang: 'en' });
  assert.equal(r.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM fb_entries WHERE location_id = ?', loc.id), 0);
  // a real one: cleanliness raises a cleaning alert on the area
  r = await pub('/feedback/test-court', { ft, rating: 2, category: 'cleanliness', comment: 'No soap in the toilets', phone: '0100 123 4567', lang: 'en' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /\/feedback\/test-court\/thanks\?lang=en/);
  const e = db.get('SELECT * FROM fb_entries WHERE location_id = ? ORDER BY id DESC LIMIT 1', loc.id);
  assert.equal(e.rating, 2);
  assert.equal(e.phone, '01001234567');
  assert.equal(e.routed_kind, 'cleaning');
  const alert = db.get('SELECT * FROM sec_clean_alerts WHERE id = ?', e.routed_id);
  assert.equal(alert.area_id, area.id);
  assert.equal(alert.source, 'feedback');
  assert.equal(h.security.areaState(area).state, 'alert');
  // the same again (a double tap): ignored
  await pub('/feedback/test-court', { ft, rating: 2, category: 'cleanliness', comment: 'No soap in the toilets', lang: 'en' });
  assert.equal(db.value('SELECT COUNT(*) FROM fb_entries WHERE location_id = ?', loc.id), 1);
  // facilities open a work order
  await pub('/feedback/test-court', { ft, rating: 1, category: 'facilities', comment: 'Hand dryer broken', lang: 'ar' });
  const f = db.get("SELECT * FROM fb_entries WHERE comment = 'Hand dryer broken'");
  assert.equal(f.routed_kind, 'maintenance');
  const wo = db.get('SELECT * FROM work_orders WHERE id = ?', f.routed_id);
  assert.match(wo.title, /Shopper feedback FB-/);
  assert.equal(wo.priority, 2);
  assert.equal(wo.location, 'Test court · GF');
  const thanks = await (await fetch(`${base}/feedback/test-court/thanks?lang=en`)).text();
  assert.match(thanks, /Thank you/);
  // no rating: asked again
  r = await pub('/feedback/test-court', { ft, category: 'other', lang: 'en' });
  assert.equal(r.status, 422);

  // the office handles it
  r = await admin.form(`/admin/feedback/${e.id}`, { status: 'in_progress', assignee_id: admin.user.id, reply: 'Cleaner sent' });
  assert.equal(r.status, 303);
  const handled = db.get('SELECT * FROM fb_entries WHERE id = ?', e.id);
  assert.equal(handled.status, 'in_progress');
  assert.ok(handled.first_action_at);
  assert.equal(db.value('SELECT COUNT(*) FROM fb_events WHERE entry_id = ?', e.id), 4, 'routed, status, assigned, reply');
  const tp = await ok(`/admin/feedback/${e.id}`);
  assert.match(tp, /No soap in the toilets/);
  assert.match(tp, /Cleaner sent/);
  const dash = await ok('/admin/feedback');
  assert.match(dash, /Test court/);
  await ok('/admin/feedback/tickets?status=all');
  await ok('/admin/feedback/locations');
  await ok('/admin/feedback/posters');

  // flooding from one address is cut off
  let last;
  for (let i = 0; i < 6; i++) last = await pub('/feedback/test-court', { ft, rating: 4, comment: `ok ${i}`, lang: 'en' });
  assert.equal(last.status, 429);
});

test('sample data loads once, reads well and clears completely', async () => {
  const opts = { h, files: h.files };
  const mods = ['demo-security', 'demo-compliance', 'demo-feedback'].map((m) => require(`../src/admin/${m}`));
  for (const m of mods) m.load(db, admin.user, opts);
  const n = (t) => db.value(`SELECT COUNT(*) FROM ${t} WHERE demo = 1`);
  assert.equal(n('sec_checkpoints'), 12);
  assert.ok(n('sec_rounds') > 60, 'a week of rounds');
  assert.ok(db.value("SELECT COUNT(*) FROM sec_rounds WHERE demo = 1 AND status = 'incomplete'") > 0, 'some rounds skipped checkpoints');
  assert.ok(n('sec_clean_logs') > 300);
  assert.ok(db.value('SELECT COUNT(*) FROM sec_key_loans WHERE demo = 1 AND returned_at IS NULL AND due_at < ?', new Date().toISOString()) >= 2, 'keys overdue');
  assert.equal(n('cmp_items'), 16);
  assert.ok(db.value('SELECT COUNT(*) FROM cmp_items WHERE demo = 1 AND next_due < ?', h.M.today()) >= 2, 'items overdue');
  assert.ok(n('fb_entries') >= 80);
  assert.ok(db.value("SELECT COUNT(*) FROM fb_entries WHERE demo = 1 AND routed_kind = 'maintenance'") > 0);
  const counts = { sec: n('sec_rounds'), fb: n('fb_entries') };
  for (const m of mods) m.load(db, admin.user, opts);
  assert.deepEqual({ sec: n('sec_rounds'), fb: n('fb_entries') }, counts, 'loading twice adds nothing');
  for (const p of ['/admin/security', '/admin/security/patrols', '/admin/security/patrols/report', '/admin/security/cleaning', '/admin/security/incidents', '/admin/security/lost', '/admin/security/keys', '/admin/security/handover', '/admin/compliance', '/admin/compliance/calendar', '/admin/compliance/history', '/admin/compliance/insurance', '/admin/feedback', '/admin/feedback/tickets']) await ok(p);
  for (const m of [...mods].reverse()) m.clear(db);
  for (const t of ['sec_checkpoints', 'sec_routes', 'sec_rounds', 'sec_scans', 'sec_clean_areas', 'sec_clean_logs', 'sec_incidents', 'sec_lost', 'sec_keys', 'sec_key_loans', 'sec_handover', 'cmp_items', 'cmp_done', 'cmp_reminders', 'fb_locations', 'fb_entries']) assert.equal(n(t), 0, t);
  assert.equal(db.value("SELECT COUNT(*) FROM work_orders WHERE demo = 1 AND reported_by LIKE 'Shopper feedback%'"), 0);
  // what people typed is known to the Arabic audit
  assert.ok(h.auditTyped.some((q) => /FROM fb_entries/.test(q)));
  for (const q of h.auditTyped) db.all(q);
});
