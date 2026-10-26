'use strict';

// The document vault and the contracts register: who sees what, contract renewals and terminations,
// the lease signed-copy indicator, and sample data that loads and clears without leaving files behind.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { samplePdf } = require('../src/admin/files');
const { hashPassword } = require('../src/admin/db');

const FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-records-test-'));
let server;
let base;
let db;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:', ADMIN_FILES: FILES }, mail: async () => ({ delivered: true }) });
  db = app.locals.admin.db;
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(FILES, { recursive: true, force: true });
});

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
    upload: (q, buf, name) => go(`/admin/documents/upload?${q}`, { method: 'POST', headers: { 'x-csrf': b.csrf, 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', accept: 'application/json' }, body: buf }),
    async signIn(email, password) {
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303);
      b.csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
    },
  };
  return b;
}

const admin = browser();
const agent = browser();
const onDisk = () => fs.readdirSync(FILES).filter((f) => !f.startsWith('.'));

test('records: set up, sample data with real files', async () => {
  const html = await (await admin.go('/admin/setup')).text();
  await admin.go('/admin/setup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: html.match(/name="_token" value="([^"]+)"/)[1], name: 'Admin', email: 'admin@thewave.test', password: 'long-enough-1' }).toString() });
  admin.csrf = (await (await admin.go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
  const r = await admin.form('/admin/settings/demo', {});
  assert.equal(r.status, 303);
  assert.ok(db.value('SELECT COUNT(*) FROM contracts WHERE demo = 1') >= 10);
  const docs = db.all('SELECT stored FROM documents');
  assert.ok(docs.length >= 15, 'sample papers were filed');
  for (const d of docs) assert.ok(fs.existsSync(path.join(FILES, d.stored)), `${d.stored} is on disk`);
  const page = await (await admin.go('/admin/documents')).text();
  assert.match(page, /Mall operating licence/);
  assert.match(page, /Mall documents/);
});

test('records: employee and confidential documents stay with HR', async () => {
  const emp = Number(db.run("INSERT INTO employees (code, name, hire_date, created_at, updated_at) VALUES ('EMP-T01', 'Test Person', '2026-01-01', ?, ?)", new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  let r = await admin.upload(`entity=employee&entity_id=${emp}&kind=employment_contract&title=${encodeURIComponent('Secret employment contract')}`, samplePdf('Employment contract'), 'contract.pdf');
  const empDoc = (await r.json()).id;
  r = await admin.upload(`entity=office&kind=policy&confidential=1&title=${encodeURIComponent('Confidential salary policy')}`, samplePdf('Salary policy'), 'policy.pdf');
  const confDoc = (await r.json()).id;
  assert.ok(empDoc && confDoc);

  db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES ('Agent', 'agent@thewave.test', 'agent', ?, ?)", hashPassword('long-enough-2'), new Date().toISOString());
  await agent.signIn('agent@thewave.test', 'long-enough-2');

  const adminPage = await (await admin.go('/admin/documents')).text();
  const agentPage = await (await agent.go('/admin/documents')).text();
  assert.match(adminPage, /Secret employment contract/);
  assert.match(adminPage, /Confidential salary policy/);
  assert.doesNotMatch(agentPage, /Secret employment contract|Confidential salary policy/);
  const onFile = (html) => Number(html.match(/On file<\/p><p class="kpi__value">([\d,]+)/)[1].replace(/,/g, ''));
  const hidden = db.value("SELECT COUNT(*) FROM documents WHERE archived = 0 AND (confidential = 1 OR entity = 'employee')");
  assert.ok(hidden >= 2);
  assert.equal(onFile(adminPage) - onFile(agentPage), hidden, 'the KPIs leave them out too');

  assert.equal((await agent.go(`/admin/documents/${empDoc}/file`)).status, 403);
  assert.equal((await agent.go(`/admin/documents/${confDoc}/file`)).status, 403);
  assert.equal((await agent.go(`/admin/documents/${empDoc}`)).status, 303);
  assert.equal((await admin.go(`/admin/documents/${empDoc}`)).status, 200);
  const found = await (await agent.go('/admin/search?q=Secret', { headers: { accept: 'application/json' } })).json();
  assert.equal(found.filter((x) => /Secret/.test(x.label)).length, 0, 'search hides them');
  r = await agent.upload(`entity=employee&entity_id=${emp}&kind=cv`, samplePdf('CV'), 'cv.pdf');
  assert.equal(r.status, 403, 'agents cannot file HR papers');
  // agents may not create contracts
  r = await agent.form('/admin/contracts', { title: 'X', counterparty: 'Y', start_date: '2026-01-01' });
  assert.equal(r.status, 303);
  assert.equal(db.value("SELECT COUNT(*) FROM contracts WHERE counterparty = 'Y'"), 0);
});

test('records: contracts are created, flagged for renewal, renewed and terminated', async () => {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  let r = await admin.form('/admin/contracts', { title: 'Pest control', counterparty: 'Clean Shield', kind: 'other', status: 'active', start_date: day(-300), end_date: day(10), notice_days: '30', value: '12000', billing: 'monthly' });
  assert.equal(r.status, 303);
  const id = Number(r.headers.get('location').split('/').pop());
  const c = db.get('SELECT * FROM contracts WHERE id = ?', id);
  assert.match(c.ref, /^SC-\d{4}-\d{3}$/);

  let page = await (await admin.go('/admin/contracts?tab=renewals')).text();
  assert.match(page, /Pest control/, 'notice date passed: renewal due');
  page = await (await admin.go(`/admin/contracts/${id}`)).text();
  assert.match(page, /EGP 144K/, 'value a year = 12 × monthly');
  assert.match(page, /Decide now/);
  const dash = await (await admin.go('/admin')).text();
  assert.match(dash, /Renewal due: Clean Shield/);

  r = await admin.form(`/admin/contracts/${id}/renew`, { end_date: day(5) });
  assert.equal(db.get('SELECT end_date FROM contracts WHERE id = ?', id).end_date, day(10), 'an earlier end date is refused');
  r = await admin.form(`/admin/contracts/${id}/renew`, { end_date: day(375), value: '13000' });
  const renewed = db.get('SELECT * FROM contracts WHERE id = ?', id);
  assert.equal(renewed.end_date, day(375));
  assert.equal(renewed.value, 13000);
  page = await (await admin.go('/admin/contracts?tab=renewals')).text();
  assert.doesNotMatch(page, /Pest control/, 'no longer due after renewal');

  r = await admin.form(`/admin/contracts/${id}/terminate`, { date: day(0), reason: 'Moved in-house' });
  const ended = db.get('SELECT * FROM contracts WHERE id = ?', id);
  assert.equal(ended.status, 'terminated');
  assert.equal(ended.end_date, day(0));
  assert.ok(db.value("SELECT COUNT(*) FROM audit WHERE entity = 'contract' AND entity_id = ? AND action = 'Terminated a contract'", id));

  // a contract's paper, then deleting the contract takes the paper (and its file) with it
  r = await admin.upload(`entity=contract&entity_id=${id}&kind=service_contract`, samplePdf('Pest control contract', ['unique line for this test']), 'pest.pdf');
  const stored = db.get('SELECT stored FROM documents WHERE id = ?', (await r.json()).id).stored;
  assert.ok(fs.existsSync(path.join(FILES, stored)));
  r = await admin.form(`/admin/contracts/${id}/delete`, {});
  assert.equal(db.value('SELECT COUNT(*) FROM contracts WHERE id = ?', id), 0);
  assert.ok(!fs.existsSync(path.join(FILES, stored)), 'its file is gone');
});

test('records: the signed copy of each lease is tracked', async () => {
  const leases = db.all('SELECT id FROM leases ORDER BY id');
  const signed = (id) => db.value("SELECT COUNT(*) FROM documents WHERE entity = 'lease' AND entity_id = ? AND kind = 'lease_contract' AND archived = 0", id);
  // make sure one lease has no signed copy (sample data from other modules may have filed them all)
  const last = leases[leases.length - 1];
  db.run("UPDATE documents SET kind = 'addendum' WHERE entity = 'lease' AND entity_id = ? AND kind = 'lease_contract'", last.id);
  const missing = leases.find((l) => !signed(l.id));
  const has = leases.find((l) => signed(l.id));
  assert.ok(missing && has, 'one lease is missing its signed copy, another has it');
  let page = await (await admin.go(`/admin/leases/${missing.id}`)).text();
  assert.match(page, /Missing: upload the signed lease/);
  page = await (await admin.go(`/admin/leases/${has.id}`)).text();
  assert.match(page, /The signed lease is on file\./);
  const list = await (await admin.go('/admin/leases')).text();
  assert.match(list, /paper is-missing/);
  assert.match(list, /paper is-ok/);
  page = await (await admin.go('/admin/contracts?tab=leases')).text();
  assert.match(page, /Signed copy missing/);
});

test('records: a document page shows its versions and can be edited', async () => {
  let r = await admin.upload('entity=office&kind=licence&title=Trade%20licence', samplePdf('Trade licence v1', ['first']), 'licence.pdf');
  const v1 = (await r.json()).id;
  r = await admin.upload(`entity=office&replaces=${v1}`, samplePdf('Trade licence v2', ['second']), 'licence-2.pdf');
  const v2 = (await r.json()).id;
  let page = await (await admin.go(`/admin/documents/${v2}`)).text();
  assert.match(page, /<iframe class="docview" src="\/admin\/documents\/\d+\/file"/);
  assert.match(page, new RegExp(`/admin/documents/${v1}"`), 'links to the earlier version');
  page = await (await admin.go(`/admin/documents/${v1}`)).text();
  assert.match(page, /This is an earlier version/);
  r = await admin.go(`/admin/documents/${v2}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/admin/documents/${v2}` }, body: new URLSearchParams({ _csrf: admin.csrf, title: 'Trade licence 2027', kind: 'licence', expires_on: '2027-12-31' }).toString() });
  assert.equal(r.headers.get('location'), `/admin/documents/${v2}`);
  assert.equal(db.get('SELECT title, expires_on FROM documents WHERE id = ?', v2).expires_on, '2027-12-31');
  r = await admin.go(`/admin/documents/${v2}/delete`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/admin/documents/${v2}` }, body: `_csrf=${admin.csrf}` });
  assert.equal(r.headers.get('location'), `/admin/documents/${v1}`, 'deleting the newest returns to the version now current');
  assert.equal(db.get('SELECT archived FROM documents WHERE id = ?', v1).archived, 0);
});

test('records: clearing sample data leaves no sample documents or stray files', async () => {
  const r = await admin.form('/admin/settings/demo/clear', {});
  assert.equal(r.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM documents WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM contracts WHERE demo = 1'), 0);
  const kept = new Set(db.all('SELECT stored FROM documents').map((d) => d.stored));
  assert.deepEqual(onDisk().filter((f) => !kept.has(f)), [], 'every file on disk belongs to a document');
  for (const s of kept) assert.ok(fs.existsSync(path.join(FILES, s)));
});
