'use strict';

// Date range and "Sort by" on the lists of sales, property, revenue and records: a from/to range
// narrows the rows, a sort reorders them, and with nothing chosen the order is what it always was.
// Every list page renders with the shared filter bar, in English and Arabic.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const demo = require('../src/admin/demo');

let server;
let base;
let db;
let h;
let M;
let admin;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  M = h.M;
  base = `http://127.0.0.1:${server.address().port}`;
  db.run("INSERT INTO users (name, email, role, password_hash, finance, hr, created_at) VALUES ('Lists Admin', 'lists-admin@thewave.test', 'admin', ?, 1, 1, datetime('now'))", hashPassword('long-enough-1'));
  demo.load(db, db.get("SELECT * FROM users WHERE email = 'lists-admin@thewave.test'"), { files: h.files, billing: h.billing, h });
  admin = browser();
  await admin.signIn('lists-admin@thewave.test', 'long-enough-1');
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
    async page(p) {
      const r = await go(p);
      assert.equal(r.status, 200, `${p} answers 200`);
      return r.text();
    },
    async signIn(email, password) {
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303);
    },
  };
  return b;
}

// the ids of the rows of the first table on a page, in order (rows link to /admin/<what>/<id>)
const ids = (html, what) => [...html.matchAll(new RegExp(`<tr data-href="/admin/${what}/(\\d+)`, 'g'))].map((m) => Number(m[1]));
const sorted = (xs, cmp) => [...xs].sort(cmp);

test('lists: every list page has the date range and the sort choice', async () => {
  const pages = [
    '/admin/offers', '/admin/leases', '/admin/billing', '/admin/inbox', '/admin/leads', '/admin/conversations', '/admin/units?view=table', '/admin/brands',
    '/admin/tenants', '/admin/fitout', '/admin/specialty/bookings', '/admin/specialty/spaces', '/admin/leases/renewals', '/admin/cheques', '/admin/collections/reminders',
    '/admin/collections/writeoffs', '/admin/collections/plans', '/admin/collections/cases', '/admin/collections/aging', '/admin/collections/penalties', '/admin/payments/online',
    '/admin/media/campaigns', '/admin/media/inventory', '/admin/media/clients', '/admin/documents', '/admin/contracts', '/admin/website', '/admin/website?tab=events',
    '/admin/website?tab=promos', '/admin/service-charge/credits', '/admin/service-charge/actuals', '/admin/turnover/terms', '/admin/turnover/billing', '/admin/utilities/meters', '/admin/utilities/billing',
  ];
  for (const p of pages) {
    const html = await admin.page(p);
    assert.match(html, /name="sort"/, `${p} has a Sort by choice`);
    if (!['/admin/specialty/spaces', '/admin/utilities/billing'].includes(p)) {
      assert.match(html, /name="from"[^>]*type="date"|type="date"[^>]*name="from"/, `${p} has a From date`);
      assert.match(html, /class="filters__quick"/, `${p} has the quick ranges`);
    }
  }
  // and in Arabic: the sort choices are translated
  db.run("UPDATE users SET lang = 'ar' WHERE email = 'lists-admin@thewave.test'");
  try {
    const html = await admin.page('/admin/billing');
    assert.match(html, /الترتيب حسب/);
    assert.match(html, /المبلغ: الأعلى أولًا/);
    assert.doesNotMatch(html, />sort\|/);
  } finally {
    db.run("UPDATE users SET lang = 'en' WHERE email = 'lists-admin@thewave.test'");
  }
});

test('billing: a due-date range narrows, the amount sorts, the default keeps the old order', async () => {
  const all = ids(await admin.page('/admin/billing?status=all'), 'invoices');
  assert.ok(all.length > 5, 'sample invoices are listed');
  const due = (id) => db.value('SELECT due_date FROM invoices WHERE id = ?', id);
  const total = (id) => db.value('SELECT total FROM invoices WHERE id = ?', id);
  // the default is the due date, soonest first, as before
  assert.deepEqual(all.map(due), sorted(all.map(due), (a, b) => a.localeCompare(b)));
  assert.deepEqual(ids(await admin.page('/admin/billing?status=all&sort=default'), 'invoices'), all);
  // a range
  const dates = [...new Set(all.map(due))].sort();
  const from = dates[Math.floor(dates.length / 3)];
  const to = dates[Math.floor((dates.length * 2) / 3)];
  const ranged = ids(await admin.page(`/admin/billing?status=all&from=${from}&to=${to}`), 'invoices');
  assert.ok(ranged.length && ranged.length < all.length, 'the range narrows the list');
  assert.ok(ranged.every((id) => due(id) >= from && due(id) <= to), 'only invoices due inside the range');
  // from after to is read the other way round
  assert.deepEqual(ids(await admin.page(`/admin/billing?status=all&from=${to}&to=${from}`), 'invoices'), ranged);
  // amounts
  const asc = ids(await admin.page('/admin/billing?status=all&sort=amount_asc'), 'invoices');
  assert.deepEqual(asc.map(total), sorted(asc.map(total), (a, b) => a - b));
  const desc = ids(await admin.page('/admin/billing?status=all&sort=amount_desc'), 'invoices');
  assert.deepEqual(desc.map(total), sorted(desc.map(total), (a, b) => b - a));
  // the tabs keep the range and the sort
  assert.match(await admin.page(`/admin/billing?status=all&from=${from}&sort=amount_asc`), new RegExp(`href="/admin/billing\\?status=overdue&(amp;)?from=${from}&(amp;)?sort=amount_asc"`));
});

test('offers and leases: newest and oldest, value, and ending soonest', async () => {
  const offers = ids(await admin.page('/admin/offers'), 'offers');
  assert.ok(offers.length > 1);
  assert.deepEqual(offers, sorted(offers, (a, b) => b - a), 'newest first by default, as before');
  assert.deepEqual(ids(await admin.page('/admin/offers?sort=oldest'), 'offers'), sorted(offers, (a, b) => a - b));

  const leases = ids(await admin.page('/admin/leases'), 'leases');
  const ends = ids(await admin.page('/admin/leases?sort=expiry'), 'leases');
  const end = (id) => db.value('SELECT end_date FROM leases WHERE id = ?', id);
  assert.equal(ends.length, leases.length);
  assert.deepEqual(ends.map(end), sorted(ends.map(end), (a, b) => a.localeCompare(b)));
  const old = db.all("SELECT s.id FROM leases s JOIN brands b ON b.id = s.brand_id ORDER BY s.status = 'active' DESC, s.start_date DESC, s.id DESC").map((r) => r.id);
  assert.deepEqual(leases, old, 'the default order is unchanged');
  const starts = [...new Set(leases.map((id) => db.value('SELECT start_date FROM leases WHERE id = ?', id)))].sort();
  const cut = starts[Math.floor(starts.length / 2)];
  const later = ids(await admin.page(`/admin/leases?from=${cut}`), 'leases');
  assert.ok(later.length && later.length < leases.length);
  assert.ok(later.every((id) => db.value('SELECT start_date FROM leases WHERE id = ?', id) >= cut));
});

test('cheques, documents, brands and campaigns sort and narrow', async () => {
  const chq = ids(await admin.page('/admin/cheques?status=all&sort=amount_asc'), 'cheques');
  const amt = (id) => db.value('SELECT amount FROM cheques WHERE id = ?', id);
  assert.ok(chq.length > 1);
  assert.deepEqual(chq.map(amt), sorted(chq.map(amt), (a, b) => a - b));

  const docs = ids(await admin.page('/admin/documents'), 'documents');
  const docsOld = ids(await admin.page('/admin/documents?sort=oldest'), 'documents');
  assert.ok(docs.length > 1);
  const at = (id) => db.value('SELECT created_at FROM documents WHERE id = ?', id);
  assert.deepEqual(docs.map(at), sorted(docs.map(at), (a, b) => b.localeCompare(a)), 'newest first by default');
  assert.deepEqual(docsOld.map(at), sorted(docsOld.map(at), (a, b) => a.localeCompare(b)));
  const future = M.addDays(M.today(), 400);
  assert.equal(ids(await admin.page(`/admin/documents?from=${future}`), 'documents').length, 0, 'nothing filed in the future');

  const brands = ids(await admin.page('/admin/brands'), 'brands');
  const brandsZ = ids(await admin.page('/admin/brands?sort=name_desc'), 'brands');
  assert.equal(brandsZ.length, brands.length);
  assert.deepEqual(brands, db.all('SELECT id FROM brands ORDER BY name').map((r) => r.id), 'by name by default, as before');
  assert.deepEqual(brandsZ, db.all('SELECT id FROM brands ORDER BY name DESC').map((r) => r.id));

  const camps = ids(await admin.page('/admin/media/campaigns?sort=amount_desc'), 'media/campaigns');
  const tot = (id) => db.value('SELECT total FROM media_campaigns WHERE id = ?', id);
  assert.ok(camps.length > 1);
  assert.deepEqual(camps.map(tot), sorted(camps.map(tot), (a, b) => b - a));
  const starts = db.all('SELECT start_date d FROM media_campaigns WHERE start_date IS NOT NULL ORDER BY start_date').map((r) => r.d);
  const mid = starts[Math.floor(starts.length / 2)];
  const before = ids(await admin.page(`/admin/media/campaigns?to=${mid}`), 'media/campaigns');
  assert.ok(before.length && before.every((id) => db.value('SELECT start_date FROM media_campaigns WHERE id = ?', id) <= mid));
});

test('collections, renewals and exports follow the filters', async () => {
  // aging by tenant: by name, and the CSV in the same order
  const html = await admin.page('/admin/collections/aging?sort=name');
  const names = [...html.matchAll(/<td data-label="[^"]*"><a href="\/admin\/collections\/tenants\/\d+"><b>([^<]+)<\/b><\/a>/g)].map((m) => m[1]);
  assert.ok(names.length > 1);
  assert.deepEqual(names, sorted(names, (a, b) => a.localeCompare(b)));
  assert.match(html, /href="\/admin\/collections\/aging\.csv\?sort=name"/, 'the download keeps the order');
  const csv = await (await admin.go('/admin/collections/aging.csv?sort=name')).text();
  const csvNames = csv.trim().split('\n').slice(1).map((l) => JSON.parse(l.split(',')[0]));
  assert.deepEqual(csvNames.filter((n) => names.includes(n)), names.filter((n) => csvNames.includes(n)));

  // renewals: by annual rent
  const ren = await admin.page('/admin/leases/renewals?months=24&sort=end_late');
  const leaseIds = [...ren.matchAll(/<tr data-href="\/admin\/leases\/(\d+)#renewal"/g)].map((m) => Number(m[1]));
  const end = (id) => db.value('SELECT end_date FROM leases WHERE id = ?', id);
  assert.deepEqual(leaseIds.map(end), sorted(leaseIds.map(end), (a, b) => b.localeCompare(a)));

  // short-term bookings: the CSV takes the same range
  const all = db.value('SELECT COUNT(*) FROM space_bookings');
  if (all > 1) {
    const d = db.all('SELECT start_date FROM space_bookings ORDER BY start_date').map((r) => r.start_date);
    const cut = d[Math.floor(d.length / 2)];
    const rows = (await (await admin.go(`/admin/specialty/bookings.csv?from=${cut}`)).text()).trim().split('\n').length - 1;
    assert.equal(rows, db.value('SELECT COUNT(*) FROM space_bookings WHERE start_date >= ?', cut));
  }
});
