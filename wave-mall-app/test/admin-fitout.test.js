'use strict';

// Fit-out management: a project for every signed lease, design review rounds with the mall's
// review deadline, drawings filed on the lease, the deposit billed and refunded through billing,
// checklists, permits, the timeline, and the tenant portal showing each tenant only its own shop.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const M = require('../src/admin/model');
const { samplePdf } = require('../src/admin/files');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let db;
let h;
let csrf;
const jar = new Map();

async function go(path, opts = {}, cookies = jar) {
  const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (/Max-Age=0/.test(c)) cookies.delete(kv.slice(0, i));
    else cookies.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}
const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const post = (path, data = {}) => go(path, form({ _csrf: csrf, ...data }));
const upload = (path, buf, name) => go(path, { method: 'POST', headers: { 'x-csrf': csrf, 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', accept: 'application/json' }, body: buf });

// a brand with a unit and a lease starting in two months
function tenant(name, code, { status = 'active', start = M.addDays(M.today(), 60) } = {}) {
  const t = M.now();
  const b = Number(db.run("INSERT INTO brands (name, category, created_at) VALUES (?, 'fashion', ?)", name, t).lastInsertRowid);
  const u = db.get('SELECT id FROM units WHERE code = ?', code).id;
  const l = Number(db.run(
    `INSERT INTO leases (ref, brand_id, status, start_date, end_date, term_years, rent_m2, created_at) VALUES (?, ?, ?, ?, ?, 5, 2000, ?)`,
    db.nextRef('leases', 'LS', 3, true), b, status, start, M.addDays(M.addMonths(start, 60), -1), t,
  ).lastInsertRowid);
  db.run('INSERT INTO lease_units (lease_id, unit_id) VALUES (?, ?)', l, u);
  return { brand: b, lease: l };
}
const project = (leaseId) => db.get('SELECT * FROM fitout_projects WHERE lease_id = ?', leaseId);

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  base = `http://127.0.0.1:${server.address().port}`;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  const setup = await (await go('/admin/setup')).text();
  await go('/admin/setup', form({ _token: setup.match(/name="_token" value="([^"]+)"/)[1], name: 'Karim Office', email: 'admin@thewave.test', password: 'long-enough-1' }));
  csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
});
after(() => server.close());

let A;
let P;
test('fit-out: every draft or active lease gets a project, dated from the lease', async () => {
  A = tenant('Maison Test', 'G03');
  const draft = tenant('Draft Brand', 'G06', { status: 'draft' });
  const ended = tenant('Gone Brand', 'G07', { status: 'ended' });
  const res = await go('/admin/fitout');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Maison Test/);
  assert.match(html, /class="gantt"/, 'the timeline is drawn');
  assert.match(html, /gantt__today/, 'with a line for today');
  P = project(A.lease);
  assert.ok(P && project(draft.lease), 'draft and active leases have projects');
  assert.equal(project(ended.lease), undefined, 'ended leases do not');
  const lease = db.get('SELECT * FROM leases WHERE id = ?', A.lease);
  assert.equal(P.stage, 'kickoff');
  assert.equal(P.planned_opening, lease.start_date);
  assert.equal(P.planned_handover, M.addMonths(lease.start_date, -2));
  assert.equal(db.value("SELECT COUNT(*) FROM fitout_checks WHERE project_id = ? AND list = 'handover'", P.id), 7, 'checklists from the templates');
  assert.doesNotMatch(await (await go(`/admin/fitout/${P.id}`)).text(), /undefined|NaN|\[object Object\]/);
});

test('fit-out: submission rounds, the review deadline and stage changes', async () => {
  // a concept submitted ten days ago: in review, and past the 7-day deadline
  let res = await post(`/admin/fitout/${P.id}/rounds`, { kind: 'concept', submitted_on: M.addDays(M.today(), -10), note: 'Rev. A' });
  assert.equal(res.status, 303);
  let r1 = db.get('SELECT * FROM fitout_rounds WHERE project_id = ?', P.id);
  assert.equal(r1.round_no, 1);
  assert.equal(r1.status, 'in_review');
  assert.equal(r1.due_on, M.addDays(M.today(), -3));
  assert.equal(project(A.lease).stage, 'review');
  assert.equal(h.fitout.facts(h.fitout.projectOf(P.id)).overdueReview, true);
  assert.match(await (await go('/admin/fitout')).text(), /1 past the review deadline/);
  assert.match(await (await go('/admin/fitout?view=attention')).text(), /Maison Test/);

  // drawings for the round go into the document vault, on the lease; only real files are taken
  res = await upload(`/admin/fitout/rounds/${r1.id}/upload?x=1`, samplePdf('Layout plan'), 'layout-plan.pdf');
  assert.equal(res.status, 200);
  const doc = db.get('SELECT d.* FROM fitout_round_docs x JOIN documents d ON d.id = x.document_id WHERE x.round_id = ?', r1.id);
  assert.equal(doc.entity, 'lease');
  assert.equal(doc.entity_id, A.lease);
  assert.equal(doc.kind, 'fitout_drawings');
  res = await upload(`/admin/fitout/rounds/${r1.id}/upload?x=1`, Buffer.from('<script>alert(1)</script> not a drawing'), 'x.pdf');
  assert.equal(res.status, 415);

  // a refusal needs comments, and sends the design back
  res = await post(`/admin/fitout/rounds/${r1.id}/decide`, { status: 'rejected', comments: '' });
  assert.equal(db.get('SELECT status FROM fitout_rounds WHERE id = ?', r1.id).status, 'in_review');
  res = await post(`/admin/fitout/rounds/${r1.id}/decide`, { status: 'rejected', comments: 'No mezzanine in this unit.' });
  r1 = db.get('SELECT * FROM fitout_rounds WHERE id = ?', r1.id);
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.decided_on, M.today());
  assert.equal(project(A.lease).stage, 'concept');
  res = await post(`/admin/fitout/rounds/${r1.id}/decide`, { status: 'approved' });
  assert.equal(db.get('SELECT status FROM fitout_rounds WHERE id = ?', r1.id).status, 'rejected', 'a decided round stays decided');

  // round 2 approved with comments: on to detailed design; detailed approved: design approved
  await post(`/admin/fitout/${P.id}/rounds`, { kind: 'concept' });
  const r2 = db.get("SELECT * FROM fitout_rounds WHERE project_id = ? AND round_no = 2 AND kind = 'concept'", P.id);
  assert.ok(r2, 'the second concept submission is round 2');
  await post(`/admin/fitout/rounds/${r2.id}/decide`, { status: 'approved_comments', comments: 'Keep the bulkhead at 3.2 m.' });
  assert.equal(project(A.lease).stage, 'detailed');

  // the review deadline is a setting
  await post('/admin/fitout/settings', { review_days: '10', handover: 'Keys issued\nMeters read', opening: 'Fire approval' });
  await post(`/admin/fitout/${P.id}/rounds`, { kind: 'detailed' });
  const r3 = db.get("SELECT * FROM fitout_rounds WHERE project_id = ? AND kind = 'detailed'", P.id);
  assert.equal(r3.due_on, M.addDays(M.today(), 10));
  await post(`/admin/fitout/rounds/${r3.id}/decide`, { status: 'approved' });
  const p = project(A.lease);
  assert.equal(p.stage, 'approved');
  assert.equal(p.approved_at, M.today());
  const later = tenant('Later Brand', 'G09');
  await go('/admin/fitout');
  assert.equal(db.value("SELECT COUNT(*) FROM fitout_checks WHERE project_id = ? AND list = 'handover'", project(later.lease).id), 2, 'new projects take the new templates');

  const hist = await (await go(`/admin/fitout/${P.id}`)).text();
  assert.match(hist, /Design reviewed/);
  assert.match(hist, /Concept design, round 1: Revise and resubmit/);
});

test('fit-out: the deposit is billed and refunded through billing', async () => {
  let res = await post(`/admin/fitout/${P.id}/deposit`, { amount: '50000', due: M.today() });
  assert.equal(res.status, 303);
  const p = project(A.lease);
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', p.deposit_invoice_id);
  assert.equal(inv.kind, 'fitout');
  assert.equal(inv.source, 'fitout');
  assert.equal(inv.source_id, p.id);
  assert.equal(inv.total, 50000, 'deposits carry no VAT');
  res = await post(`/admin/fitout/${P.id}/deposit`, { amount: '1000' });
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE source = 'fitout' AND source_id = ?", p.id), 1, 'billed once');

  // paid in full: the project moves to "deposit" and the checklist item ticks itself
  db.run("INSERT INTO fitout_checks (project_id, list, label, sort) VALUES (?, 'handover', 'Fit-out deposit received', 0)", p.id);
  h.billing.recordPayment({ invoice_id: inv.id, amount: 50000, method: 'transfer' });
  assert.equal(project(A.lease).stage, 'deposit');
  assert.ok(db.get("SELECT done_at FROM fitout_checks WHERE project_id = ? AND label = 'Fit-out deposit received'", p.id).done_at);

  const seen = [];
  const off = h.events.on('fitout.deposit_refunded', (e) => seen.push(e));
  res = await post(`/admin/fitout/${P.id}/refund`, { amount: '60000' });
  assert.equal(project(A.lease).deposit_refunded_at, null, 'never more than was received');
  res = await post(`/admin/fitout/${P.id}/refund`, { amount: '47500', date: M.today(), note: 'Less 2,500 for a tile' });
  off();
  assert.equal(project(A.lease).deposit_refund, 47500);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].amount, 47500);
  assert.equal(seen[0].project.id, p.id);
  assert.equal(seen[0].date, M.today());
});

test('fit-out: contractors, permits, checklists and opening day', async () => {
  await post(`/admin/fitout/${P.id}/contractors`, { company: 'Best Fitout Co', insurance_expiry: M.addDays(M.today(), 200) });
  const c = db.get('SELECT * FROM fitout_contractors WHERE project_id = ?', P.id);
  assert.ok(c);
  await post(`/admin/fitout/${P.id}/permits`, { type: 'hot_works', contractor_id: String(c.id), from_on: M.today(), to_on: M.addDays(M.today(), 2), hours: '23:00–04:00' });
  const x = db.get('SELECT * FROM fitout_permits WHERE project_id = ?', P.id);
  assert.equal(x.type, 'hot_works');
  assert.equal(x.contractor_id, c.id);
  await post(`/admin/fitout/${P.id}/permits`, { type: 'work', from_on: M.today(), to_on: M.addDays(M.today(), -3) });
  assert.equal(db.value('SELECT COUNT(*) FROM fitout_permits WHERE project_id = ?', P.id), 1, 'a permit cannot end before it starts');

  const item = db.get("SELECT * FROM fitout_checks WHERE project_id = ? AND done_at IS NULL ORDER BY id LIMIT 1", P.id);
  await post(`/admin/fitout/checks/${item.id}`);
  const ticked = db.get('SELECT * FROM fitout_checks WHERE id = ?', item.id);
  assert.equal(ticked.done_at, M.today());
  assert.equal(ticked.done_by, 'Karim Office', 'who ticked it');

  await post(`/admin/fitout/${P.id}/stage`, { stage: 'handover' });
  assert.equal(project(A.lease).actual_handover, M.today());
  await post(`/admin/fitout/${P.id}/stage`, { stage: 'open' });
  const p = project(A.lease);
  assert.equal(p.stage, 'open');
  assert.equal(p.actual_opening, M.today());
  assert.equal(db.get('SELECT opening_date FROM brands WHERE id = ?', A.brand).opening_date, M.today());
  // the tenant file and the unit page show the project
  assert.match(await (await go(`/admin/tenants/${A.brand}`)).text(), /href="\/admin\/fitout\/\d+"/);
  const unit = db.get('SELECT unit_id FROM lease_units WHERE lease_id = ?', A.lease).unit_id;
  assert.match(await (await go(`/admin/units/${unit}`)).text(), /href="\/admin\/fitout\/\d+"/);
});

test('fit-out: an opening that slips past its date is flagged on the timeline', async () => {
  const late = tenant('Slow Brand', 'G10', { start: M.addDays(M.today(), -5) });
  await go('/admin/fitout');
  const p = project(late.lease);
  db.run("UPDATE fitout_projects SET stage = 'works' WHERE id = ?", p.id);
  assert.equal(h.fitout.facts(h.fitout.projectOf(p.id)).late, true);
  const html = await (await go('/admin/fitout')).text();
  assert.match(html, /gantt__row is-late" href="\/admin\/fitout\/\d+"/);
});

test('fit-out: the tenant portal shows each tenant only its own fit-out', { skip: !(() => { try { require.resolve('../src/admin/routes/portal'); return true; } catch { return false; } })() }, async () => {
  if (!h.portal) return;
  const B = tenant('Other Brand', 'G11');
  await go('/admin/fitout');
  const mine = project(B.lease);
  const theirs = project(A.lease);
  db.run("INSERT INTO portal_users (brand_id, name, email, password_hash, created_at) VALUES (?, 'Nadia Other', 'nadia@other.test', ?, ?)", B.brand, hashPassword('tenant-pass-123'), M.now());
  const t = new Map();
  const login = await (await go('/portal/login', {}, t)).text();
  let res = await go('/portal/login', form({ _token: login.match(/name="_token" value="([^"]+)"/)[1], email: 'nadia@other.test', password: 'tenant-pass-123' }), t);
  assert.equal(res.status, 303);
  const page = await (await go('/portal/fitout', {}, t)).text();
  assert.match(page, new RegExp(db.get('SELECT ref FROM leases WHERE id = ?', B.lease).ref));
  assert.doesNotMatch(page, new RegExp(db.get('SELECT ref FROM leases WHERE id = ?', A.lease).ref), 'never another tenant’s project');
  const pcsrf = page.match(/name="csrf" content="([^"]+)"/)[1];
  // submitting to someone else's project or round is refused
  res = await go(`/portal/fitout/${theirs.id}/rounds`, form({ _csrf: pcsrf, kind: 'concept' }), t);
  assert.equal(res.status, 404);
  const theirRound = db.get('SELECT id FROM fitout_rounds WHERE project_id = ? ORDER BY id DESC LIMIT 1', theirs.id);
  res = await go(`/portal/fitout/rounds/${theirRound.id}/upload?x=1`, { method: 'POST', headers: { 'x-csrf': pcsrf, 'x-file-name': 'a.pdf', accept: 'application/json', 'content-type': 'application/octet-stream' }, body: samplePdf('x') }, t);
  assert.equal(res.status, 404);
  // its own submission starts a round the office can see, and its drawings attach to it
  res = await go(`/portal/fitout/${mine.id}/rounds`, form({ _csrf: pcsrf, kind: 'concept', note: 'From the tenant' }), t);
  assert.equal(res.status, 303);
  const r = db.get('SELECT * FROM fitout_rounds WHERE project_id = ?', mine.id);
  assert.equal(r.via, 'portal');
  res = await go(`/portal/fitout/rounds/${r.id}/upload?x=1`, { method: 'POST', headers: { 'x-csrf': pcsrf, 'x-file-name': 'concept.pdf', accept: 'application/json', 'content-type': 'application/octet-stream' }, body: samplePdf('Concept') }, t);
  assert.equal(res.status, 200);
  assert.equal(db.value('SELECT COUNT(*) FROM fitout_round_docs WHERE round_id = ?', r.id), 1);
  res = await go(`/portal/fitout/${mine.id}/rounds`, form({ kind: 'concept' }), t);
  assert.equal(res.status, 403, 'portal forms need the portal token');
});

test('fit-out: sample data loads in every stage and clears completely', async () => {
  const demo = require('../src/admin/demo-fitout');
  const before = db.value('SELECT COUNT(*) FROM invoices');
  // the sample needs the sample tenants: make them, then load only the fit-out part
  for (const [name, code] of [['Kahwa House', 'G04'], ['Saffron Table', 'G12'], ['Maison Lune', 'G01'], ['Lumière Beauty', 'S02']]) {
    const x = tenant(name, code, { start: M.addDays(M.today(), -60) });
    db.run('UPDATE brands SET demo = 1 WHERE id = ?', x.brand);
  }
  const user = db.get('SELECT * FROM users LIMIT 1');
  demo.load(db, user, { files: h.files, billing: h.billing, h });
  const stages = db.all('SELECT stage FROM fitout_projects WHERE demo = 1').map((r) => r.stage).sort();
  assert.deepEqual(stages, ['open', 'open', 'open', 'works']);
  assert.ok(db.value("SELECT COUNT(*) FROM fitout_round_docs x JOIN documents d ON d.id = x.document_id WHERE d.mime = 'application/pdf'") >= 4, 'submissions have their drawings');
  assert.ok(db.value("SELECT COUNT(*) FROM invoices WHERE source = 'fitout' AND demo = 1") >= 4, 'deposits through billing');
  assert.ok(db.value('SELECT COUNT(*) FROM fitout_projects WHERE demo = 1 AND deposit_refunded_at IS NOT NULL') >= 1, 'one deposit refunded');
  const html = await (await go('/admin/fitout')).text();
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
  demo.clear(db, { files: h.files });
  assert.equal(db.value('SELECT COUNT(*) FROM fitout_projects WHERE demo = 1'), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE source = 'fitout' AND demo = 1"), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM payments WHERE invoice_id NOT IN (SELECT id FROM invoices)"), 0, 'their payments too');
  assert.equal(db.value('SELECT COUNT(*) FROM invoices'), before, 'every invoice the sample made is gone');
});
