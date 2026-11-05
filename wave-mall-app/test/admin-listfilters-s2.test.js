'use strict';

// Date ranges and "Sort by" on the finance, purchasing, HR, maintenance and parking lists
// (h.listFilters): a from/to range narrows the rows, a chosen sort reorders them, and with nothing
// chosen the order is what it always was. Runs on the sample data.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const demo = require('../src/admin/demo');

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
  db.run("INSERT INTO users (name, email, role, password_hash, finance, hr, created_at) VALUES ('Filter Admin', 'lf2-admin@thewave.test', 'admin', ?, 1, 1, datetime('now'))", hashPassword('long-enough-1'));
  demo.load(db, db.get("SELECT * FROM users WHERE email = 'lf2-admin@thewave.test'"), { files: h.files, billing: h.billing, h });
  admin = browser();
  await admin.signIn('lf2-admin@thewave.test', 'long-enough-1');
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
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    async page(p) {
      const r = await go(p);
      assert.equal(r.status, 200, `${p} answers ${r.status}`);
      return r.text();
    },
    async signIn(email, password) {
      base = base || `http://127.0.0.1:${server.address().port}`;
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303);
    },
  };
  return b;
}
// the links of a list's rows, in page order
const hrefs = (html, prefix) => [...html.matchAll(new RegExp(`data-href="(${prefix.replace(/\//g, '\\/')}\\d+)"`, 'g'))].map((m) => m[1]);
const ids = (html, prefix) => hrefs(html, prefix).map((x) => Number(x.split('/').pop()));

test('every list here has a date range, a Sort by and the quick ranges', async () => {
  for (const p of ['/admin/accounting/journal', '/admin/accounting/payables?tab=all', '/admin/accounting/assets', '/admin/purchasing/requests?status=all', '/admin/purchasing/orders',
    '/admin/purchasing/receipts', '/admin/purchasing/stock', '/admin/purchasing/stock/movements', '/admin/hr', '/admin/hr/leave?tab=all', '/admin/hr/payroll', '/admin/hr/advances?status=all',
    '/admin/maintenance/orders?view=all', '/admin/maintenance/assets', '/admin/maintenance/ppm', '/admin/parking/visits?status=all', '/admin/parking/tills', '/admin/parking/subscriptions?status=all',
    '/admin/parking/violations', '/admin/parking/incidents?status=all', '/admin/parking/lost', '/admin/parking/bookings', '/admin/parking/companies', '/admin/parking/ereceipts', '/admin/parking/safe']) {
    const html = await admin.page(p);
    assert.match(html, /name="from"[^>]*type="date"|type="date"[^>]*name="from"/, `${p}: a from date`);
    assert.match(html, /name="to"/, `${p}: a to date`);
    assert.match(html, /<select[^>]*name="sort"/, `${p}: a Sort by`);
    assert.match(html, /class="filters__quick"/, `${p}: quick ranges`);
    assert.equal((html.match(/class="filters"/g) || []).length, 1, `${p}: one filter bar`);
  }
  // period pages: their own range, no list sort
  for (const p of ['/admin/footfall', '/admin/parking/reports']) assert.match(await admin.page(p), /name="from"/, `${p}: a from date`);
  assert.match(await admin.page('/admin/parking/validations'), /<select[^>]*name="sort"/);
});

test('purchase orders: the range narrows, the sort reorders, the default is unchanged', async () => {
  const all = db.all('SELECT id, order_date, total FROM pur_orders ORDER BY order_date DESC, id DESC');
  assert.ok(all.length >= 3, 'sample orders');
  assert.deepEqual(ids(await admin.page('/admin/purchasing/orders'), '/admin/purchasing/orders/'), all.map((o) => o.id), 'default: newest first');
  const day = all[Math.floor(all.length / 2)].order_date;
  const inRange = all.filter((o) => o.order_date >= day);
  assert.deepEqual(ids(await admin.page(`/admin/purchasing/orders?from=${day}`), '/admin/purchasing/orders/').sort(), inRange.map((o) => o.id).sort(), 'from narrows');
  assert.ok(inRange.length < all.length);
  const cheap = ids(await admin.page('/admin/purchasing/orders?sort=amount_asc'), '/admin/purchasing/orders/');
  const totals = cheap.map((id) => all.find((o) => o.id === id).total);
  assert.deepEqual(totals, [...totals].sort((a, b) => a - b), 'lowest total first');
  const old = ids(await admin.page('/admin/purchasing/orders?sort=oldest'), '/admin/purchasing/orders/');
  assert.equal(old[0], [...all].sort((a, b) => a.order_date.localeCompare(b.order_date) || a.id - b.id)[0].id, 'oldest first');
});

test('journal, work orders and advances: sort and range', async () => {
  const j = ids(await admin.page('/admin/accounting/journal?sort=amount_desc'), '/admin/accounting/journal/');
  const amt = (id) => db.value('SELECT SUM(debit) FROM acc_lines WHERE entry_id = ?', id);
  assert.ok(j.length > 2);
  for (let i = 1; i < j.length; i++) assert.ok(amt(j[i - 1]) >= amt(j[i]) - 0.001, 'journal: highest amount first');
  const def = ids(await admin.page('/admin/accounting/journal'), '/admin/accounting/journal/');
  assert.deepEqual(def, db.all('SELECT id FROM acc_entries ORDER BY date DESC, id DESC LIMIT 50').map((r) => r.id), 'journal default unchanged');

  const wo = db.all("SELECT id, created_at FROM work_orders ORDER BY created_at");
  assert.ok(wo.length > 3);
  const cut = wo[Math.floor(wo.length / 2)].created_at.slice(0, 10);
  const listed = ids(await admin.page(`/admin/maintenance/orders?view=all&to=${cut}&sort=oldest`), '/admin/maintenance/orders/');
  assert.ok(listed.length && listed.length < wo.length, 'to narrows the work orders');
  for (const id of listed) assert.ok(db.value('SELECT created_at FROM work_orders WHERE id = ?', id).slice(0, 10) <= cut);
  assert.equal(listed[0], wo[0].id, 'oldest raised first');
  const csv = await (await admin.go(`/admin/maintenance/orders.csv?view=all&to=${cut}`)).text();
  assert.equal(csv.trim().split('\r\n').length - 1, db.value('SELECT COUNT(*) FROM work_orders WHERE substr(created_at, 1, 10) <= ?', cut), 'the CSV follows the filters');

  const adv = ids(await admin.page('/admin/hr/advances?status=all&sort=amount_desc'), '/admin/hr/advances/');
  const advAmt = adv.map((id) => db.value('SELECT amount FROM hr_advances WHERE id = ?', id));
  assert.deepEqual(advAmt, [...advAmt].sort((a, b) => b - a), 'advances: highest first');
});

test('employees: hire-date range and sort, and the CSV export follows them', async () => {
  const active = db.all("SELECT id, name, hire_date FROM employees WHERE status = 'active' ORDER BY name");
  assert.ok(active.length > 3);
  assert.deepEqual(ids(await admin.page('/admin/hr'), '/admin/hr/employees/'), active.map((e) => e.id), 'default: by name');
  const newest = ids(await admin.page('/admin/hr?sort=newest'), '/admin/hr/employees/');
  assert.equal(newest[0], [...active].sort((a, b) => b.hire_date.localeCompare(a.hire_date) || a.name.localeCompare(b.name))[0].id, 'latest hire first');
  const y = active.map((e) => e.hire_date).sort()[Math.floor(active.length / 2)];
  const after2 = ids(await admin.page(`/admin/hr?from=${y}`), '/admin/hr/employees/');
  assert.deepEqual(after2.sort(), active.filter((e) => e.hire_date >= y).map((e) => e.id).sort());
  const csv = await (await admin.go(`/admin/hr/employees.csv?from=${y}`)).text();
  assert.equal(csv.trim().split(/\r?\n/).length - 1, after2.length, 'the CSV has the filtered people');
});

test('parking: cars by Cairo day, ?day= still opens one day, fines by amount', async () => {
  const r = await admin.go('/admin/parking/visits?status=all&day=2026-01-05');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /from=2026-01-05&to=2026-01-05/);
  const all = db.value("SELECT COUNT(*) FROM pk_sessions");
  assert.ok(all > 0);
  const html = await admin.page('/admin/parking/visits?status=all&from=2000-01-01&to=2000-01-02');
  assert.equal(hrefs(html, '/admin/parking/visits/').length, 0, 'an empty range shows nothing');
  const fines = ids(await admin.page('/admin/parking/violations?sort=amount_desc'), '/admin/parking/violations/');
  const f = fines.map((id) => db.value('SELECT fine FROM pk_violations WHERE id = ?', id));
  assert.deepEqual(f, [...f].sort((a, b) => b - a));
  const subs = ids(await admin.page('/admin/parking/subscriptions?status=all&sort=amount_desc'), '/admin/parking/subscriptions/');
  const pr = subs.map((id) => db.value('SELECT price FROM pk_permits WHERE id = ?', id));
  assert.deepEqual(pr, [...pr].sort((a, b) => b - a));
});

test('in Arabic the toolbar is translated', async () => {
  const r = await admin.go('/admin/purchasing/orders', { headers: { cookie: `${admin.cookie()}; wv_lang=ar` } });
  const html = await r.text();
  assert.match(html, /<html lang="ar"/);
  assert.match(html, /الترتيب حسب/);
  assert.match(html, /هذا الشهر/);
  assert.match(html, /الأحدث أولًا/);
});
