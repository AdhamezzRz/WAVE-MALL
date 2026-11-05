'use strict';

// The shared list toolbar (date range + "Sort by") on the security, office, users & permissions,
// work hub, help and tenant-portal lists: a from/to range narrows the rows, a sort choice reorders
// them, the default order is unchanged, and CSV exports follow the same filter.

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
  person('Filter Admin', 'lf-admin@thewave.test', 'admin');
  admin = browser();
  await admin.signIn('lf-admin@thewave.test', 'long-enough-1');
});
after(() => server.close());

function person(name, email, role) {
  const id = Number(db.run("INSERT INTO users (name, email, role, password_hash, lang, created_at) VALUES (?, ?, ?, ?, 'en', datetime('now'))", name, email, role, hashPassword('long-enough-1')).lastInsertRowid);
  if (h.access && h.access.engine) h.access.engine.touch();
  return id;
}
let ipN = 0;
function browser() {
  const jar = new Map();
  const ip = `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}`;
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
    go,
    text: async (p) => { const r = await go(p); assert.equal(r.status, 200, p); return r.text(); },
    async signIn(email, password) {
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303, `sign-in for ${email}`);
    },
  };
  return b;
}
// the order in which the given markers appear in the page (missing ones are left out)
const order = (html, marks) => marks.map((m) => [m, html.indexOf(m)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]).map(([m]) => m);

test('lists: security incidents and lost & found filter by date and sort', async () => {
  const t = new Date().toISOString();
  const add = (ref, title, at, severity) => db.run("INSERT INTO sec_incidents (ref, kind, severity, title, at, status, created_at, updated_at) VALUES (?, 'other', ?, ?, ?, 'open', ?, ?)", ref, severity, title, at, t, t);
  add('LFI-1', 'Zeta incident old', '2025-01-10T10:00:00.000Z', 'low');
  add('LFI-2', 'Alpha incident mid', '2025-03-15T10:00:00.000Z', 'critical');
  add('LFI-3', 'Mid incident new', '2025-06-20T10:00:00.000Z', 'medium');
  const marks = ['Zeta incident old', 'Alpha incident mid', 'Mid incident new'];
  let html = await admin.text('/admin/security/incidents?status=all');
  assert.deepEqual(order(html, marks), ['Mid incident new', 'Alpha incident mid', 'Zeta incident old'], 'newest first by default');
  assert.match(html, /name="sort"/, 'the sort select is in the filter bar');
  assert.match(html, /name="from"/);
  html = await admin.text('/admin/security/incidents?status=all&sort=oldest');
  assert.deepEqual(order(html, marks), ['Zeta incident old', 'Alpha incident mid', 'Mid incident new']);
  html = await admin.text('/admin/security/incidents?status=all&sort=severity');
  assert.equal(order(html, marks)[0], 'Alpha incident mid', 'critical first');
  html = await admin.text('/admin/security/incidents?status=all&from=2025-03-01&to=2025-04-01');
  assert.deepEqual(order(html, marks), ['Alpha incident mid'], 'the date range narrows the list');
  html = await admin.text('/admin/security/incidents?status=all&from=2025-04-01&to=2025-03-01');
  assert.deepEqual(order(html, marks), ['Alpha incident mid'], 'a reversed range is swapped');

  const lost = (ref, item, at) => db.run("INSERT INTO sec_lost (ref, item, found_at, status, created_at) VALUES (?, ?, ?, 'held', ?)", ref, item, at, t);
  lost('LFL-1', 'Yellow umbrella', '2025-02-01T09:00:00.000Z');
  lost('LFL-2', 'Black wallet', '2025-05-01T09:00:00.000Z');
  html = await admin.text('/admin/security/lost?status=all&sort=name');
  assert.deepEqual(order(html, ['Yellow umbrella', 'Black wallet']), ['Black wallet', 'Yellow umbrella']);
  html = await admin.text('/admin/security/lost?status=all&to=2025-03-01');
  assert.deepEqual(order(html, ['Yellow umbrella', 'Black wallet']), ['Yellow umbrella']);
});

test('lists: the activity log, subscribers (with the CSV) and the team', async () => {
  db.run("INSERT INTO audit (action, detail, created_at) VALUES ('Exported', 'lf-audit-old', '2024-02-02T10:00:00.000Z')");
  db.run("INSERT INTO audit (action, detail, created_at) VALUES ('Exported', 'lf-audit-new', '2024-08-08T10:00:00.000Z')");
  let html = await admin.text('/admin/audit');
  assert.deepEqual(order(html, ['lf-audit-old', 'lf-audit-new']), ['lf-audit-new', 'lf-audit-old'], 'newest first by default');
  html = await admin.text('/admin/audit?from=2024-01-01&to=2024-03-01');
  assert.deepEqual(order(html, ['lf-audit-old', 'lf-audit-new']), ['lf-audit-old']);
  html = await admin.text('/admin/audit?from=2024-01-01&to=2024-12-31&sort=oldest');
  assert.deepEqual(order(html, ['lf-audit-old', 'lf-audit-new']), ['lf-audit-old', 'lf-audit-new']);
  assert.match(html, /class="filters__quick"/, 'quick ranges');

  db.run("INSERT INTO subscribers (email, lang, source, created_at) VALUES ('zz-lf@sub.test', 'en', 'website', '2024-01-05T10:00:00.000Z')");
  db.run("INSERT INTO subscribers (email, lang, source, created_at) VALUES ('aa-lf@sub.test', 'ar', 'website', '2024-06-05T10:00:00.000Z')");
  html = await admin.text('/admin/subscribers');
  assert.deepEqual(order(html, ['zz-lf@sub.test', 'aa-lf@sub.test']), ['aa-lf@sub.test', 'zz-lf@sub.test']);
  html = await admin.text('/admin/subscribers?sort=email&to=2024-12-31');
  assert.deepEqual(order(html, ['zz-lf@sub.test', 'aa-lf@sub.test']), ['aa-lf@sub.test', 'zz-lf@sub.test']);
  html = await admin.text('/admin/subscribers?from=2024-01-01&to=2024-02-01');
  assert.deepEqual(order(html, ['zz-lf@sub.test', 'aa-lf@sub.test']), ['zz-lf@sub.test']);
  assert.match(html, /href="\/admin\/export\/subscribers\.csv\?from=2024-01-01&(amp;)?to=2024-02-01"/, 'the export link carries the filter');
  const csvText = await admin.text('/admin/export/subscribers.csv?from=2024-01-01&to=2024-02-01');
  assert.ok(csvText.includes('zz-lf@sub.test') && !csvText.includes('aa-lf@sub.test'), 'the CSV follows the filter');

  person('Aaron Early', 'lf-early@thewave.test', 'agent');
  const body = (x) => x.slice(x.indexOf('<tbody'));
  html = body(await admin.text('/admin/team'));
  assert.ok(html.indexOf('Aaron Early') < html.indexOf('Filter Admin'), 'by name by default');
  html = body(await admin.text('/admin/team?sort=name_desc'));
  assert.ok(html.indexOf('Filter Admin') < html.indexOf('Aaron Early'));
  html = body(await admin.text('/admin/people?sort=name_desc'));
  assert.ok(html.indexOf('Filter Admin') < html.indexOf('Aaron Early'), 'users & permissions sorts too');
  html = body(await admin.text('/admin/people?from=2001-01-01&to=2001-12-31'));
  assert.ok(!html.includes('Aaron Early'), 'account created range');
  html = await admin.text('/admin/people/history?sort=oldest');
  assert.match(html, /name="sort"/);
  assert.match(await admin.text('/admin/people/invites'), /name="sort"/);
});

test('lists: work hub list and inbox, support and the training report', async () => {
  const uid = db.value("SELECT id FROM users WHERE email = 'lf-admin@thewave.test'");
  const t = new Date().toISOString();
  const task = (title, due, priority) => {
    const id = Number(db.run("INSERT INTO wk_tasks (ref, title, status, priority, due_date, created_by, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?, ?, ?, ?)", `LF-${title.length}-${due}`, title, priority, due, uid, t, t).lastInsertRowid);
    db.run("INSERT INTO wk_people (task_id, user_id, role) VALUES (?, ?, 'assignee')", id, uid);
  };
  task('Lf task urgent late', '2030-03-01', 'urgent');
  task('Lf task low early', '2030-01-01', 'low');
  const marks = ['Lf task urgent late', 'Lf task low early'];
  let html = await admin.text('/admin/work/list?type=tasks&who=me');
  assert.deepEqual(order(html, marks), ['Lf task urgent late', 'Lf task low early'], 'priority first by default');
  html = await admin.text('/admin/work/list?type=tasks&who=me&sort=due');
  assert.deepEqual(order(html, marks), ['Lf task low early', 'Lf task urgent late']);
  html = await admin.text('/admin/work/list?type=tasks&who=me&from=2030-02-01');
  assert.deepEqual(order(html, marks), ['Lf task urgent late']);

  db.run("INSERT INTO wk_notes (user_id, kind, params, created_at) VALUES (?, 'comment', '{\"excerpt\":\"lf-note-old\"}', '2024-01-01T10:00:00.000Z')", uid);
  db.run("INSERT INTO wk_notes (user_id, kind, params, created_at) VALUES (?, 'comment', '{\"excerpt\":\"lf-note-new\"}', '2024-05-01T10:00:00.000Z')", uid);
  html = await admin.text('/admin/work/inbox?from=2024-01-01&to=2024-12-31');
  assert.deepEqual(order(html, ['lf-note-old', 'lf-note-new']), ['lf-note-new', 'lf-note-old'], 'a range shows older notifications too');
  html = await admin.text('/admin/work/inbox?from=2024-01-01&to=2024-12-31&sort=oldest');
  assert.deepEqual(order(html, ['lf-note-old', 'lf-note-new']), ['lf-note-old', 'lf-note-new']);

  assert.match(await admin.text('/admin/help/support?sort=oldest'), /name="sort"/);
  html = await admin.text('/admin/help/training?sort=most');
  assert.match(html, /name="sort"/);
  const csvRes = await admin.go('/admin/help/training/export.csv?from=2001-01-01&to=2001-01-02');
  assert.equal(csvRes.status, 200);
  assert.equal((await csvRes.text()).trim().split('\n').length, 1, 'the CSV follows the date range (header only)');
  assert.match(await admin.text('/admin/approvals?tab=all&sort=amount_desc'), /name="sort"/);
});

test('lists: the tenant portal — receipts, invoices and notices', async () => {
  const bid = Number(db.run("INSERT INTO brands (name, created_at) VALUES ('Filter Brand', datetime('now'))").lastInsertRowid);
  db.run("INSERT INTO portal_users (brand_id, name, email, password_hash, created_at) VALUES (?, 'Filter Tenant', 'lf@tenant.test', ?, datetime('now'))", bid, hashPassword('long-enough-1'));
  const t = new Date().toISOString();
  db.run("INSERT INTO payments (ref, brand_id, amount, date, method, status, created_at) VALUES ('RC-LF-1', ?, 100, '2025-01-10', 'cash', 'received', ?)", bid, t);
  db.run("INSERT INTO payments (ref, brand_id, amount, date, method, status, created_at) VALUES ('RC-LF-2', ?, 900, '2025-02-10', 'cash', 'received', ?)", bid, t);
  db.run("INSERT INTO payments (ref, brand_id, amount, date, method, status, created_at) VALUES ('RC-LF-3', ?, 500, '2025-03-10', 'cash', 'received', ?)", bid, t);
  const tenant = browser();
  const lp = await (await tenant.go('/portal/login')).text();
  const token = lp.match(/name="_token" value="([^"]+)"/);
  await tenant.go('/portal/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...(token ? { _token: token[1] } : {}), email: 'lf@tenant.test', password: 'long-enough-1' }).toString() });
  const marks = ['RC-LF-1', 'RC-LF-2', 'RC-LF-3'];
  let html = await tenant.text('/portal/payments');
  assert.deepEqual(order(html, marks), ['RC-LF-3', 'RC-LF-2', 'RC-LF-1'], 'newest first by default');
  assert.match(html, /name="sort"/);
  html = await tenant.text('/portal/payments?sort=amount_desc');
  assert.deepEqual(order(html, marks), ['RC-LF-2', 'RC-LF-3', 'RC-LF-1']);
  html = await tenant.text('/portal/payments?from=2025-02-01&to=2025-02-28');
  assert.deepEqual(order(html, marks), ['RC-LF-2']);
  html = await tenant.text('/portal/payments?lang=ar');
  assert.match(html, /الترتيب حسب/, 'the toolbar in Arabic');

  db.run("INSERT INTO invoices (ref, brand_id, kind, due_date, total, paid, status, created_at) VALUES ('INV-LF-A', ?, 'other', '2020-01-05', 300, 0, 'open', ?)", bid, t);
  db.run("INSERT INTO invoices (ref, brand_id, kind, due_date, total, paid, status, created_at) VALUES ('INV-LF-B', ?, 'other', '2020-02-05', 700, 0, 'open', ?)", bid, t);
  html = await tenant.text('/portal/invoices');
  assert.deepEqual(order(html, ['INV-LF-A', 'INV-LF-B']), ['INV-LF-A', 'INV-LF-B'], 'oldest due first by default');
  html = await tenant.text('/portal/invoices?sort=amount_desc');
  assert.deepEqual(order(html, ['INV-LF-A', 'INV-LF-B']), ['INV-LF-B', 'INV-LF-A']);
  html = await tenant.text('/portal/invoices?view=due&from=2020-02-01');
  assert.deepEqual(order(html, ['INV-LF-A', 'INV-LF-B']), ['INV-LF-B']);
  assert.match(await tenant.text('/portal/notices?sort=oldest'), /name="sort"/);
  assert.match(await tenant.text('/portal/documents'), /name="sort"/);
});
