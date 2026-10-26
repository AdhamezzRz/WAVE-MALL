'use strict';

// Tenant files: the directory, a tenant's dossier, compliance scoring, edits with validation and
// permissions, the compliance CSV, the fact sheet in both languages, and the sample data.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const T = require('../src/admin/tenancy');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let app;
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
const flash = (cookies = jar) => {
  try {
    return JSON.parse(decodeURIComponent(cookies.get('wv_flash') || '{}'));
  } catch {
    return {};
  }
};

before(async () => {
  app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready; // the office opens in the background on older Node (sql.js)
  base = `http://127.0.0.1:${server.address().port}`;
  const setup = await (await go('/admin/setup?lang=en')).text();
  await go('/admin/setup', form({ _token: setup.match(/name="_token" value="([^"]+)"/)[1], name: 'Admin', email: 'admin@thewave.test', password: 'long-enough-1' }));
  csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
});
after(() => server.close());

test('tenants: an empty office explains where tenants come from', async () => {
  const html = await (await go('/admin/tenants')).text();
  assert.match(html, /No tenants yet/);
});

test('tenants: sample data gives a directory with varied compliance', async () => {
  await go('/admin/settings/demo', form({ _csrf: csrf }));
  const { db } = app.locals.admin;
  const list = T.tenants(db);
  const by = Object.fromEntries(list.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['Atelier Nour', 'Kahwa House', 'Lumière Beauty', 'Maison Lune', 'Saffron Table']);
  assert.equal(by['Maison Lune'].compliance.score, 1, 'a complete file');
  assert.equal(by['Kahwa House'].compliance.expired, 1, 'an expired insurance policy');
  assert.equal(by['Lumière Beauty'].compliance.items.find((i) => i.kind === 'tax_card').state, 'missing');
  assert.equal(by['Lumière Beauty'].status, 'opening');
  assert.ok(by['Saffron Table'].compliance.expiring >= 1, 'insurance expiring soon');
  assert.ok(by['Saffron Table'].arrears > 0, 'arrears');
  assert.equal(by['Atelier Nour'].status, 'signing');
  assert.equal(by['Maison Lune'].status, 'trading');

  for (const path of ['/admin/tenants', '/admin/tenants?view=table', '/admin/tenants?view=compliance', '/admin/tenants?compliance=expired&sort=compliance', '/admin/tenants?level=street', '/admin/tenants?q=nothing-matches']) {
    const res = await go(path);
    assert.equal(res.status, 200, path);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, path);
  }
  assert.match(await (await go('/admin/tenants?compliance=missing')).text(), /Lumière Beauty/);
  assert.doesNotMatch(await (await go('/admin/tenants?compliance=missing')).text(), /Maison Lune/);
});

test('tenants: the dossier, the fact sheet and the brand and unit pages', async () => {
  const { db } = app.locals.admin;
  const kahwa = db.get("SELECT * FROM brands WHERE name = 'Kahwa House' AND demo = 1");
  let html = await (await go(`/admin/tenants/${kahwa.id}`)).text();
  for (const part of ['Overview', 'Legal &amp; registration', 'Store operations', 'Brand documents', 'Kahwa House for Restaurants and Cafés LLC', 'data-upload']) assert.ok(html.includes(part), part);
  assert.match(html, /Expired/);
  // a missing document can be uploaded straight from the checklist, the form preselected
  const lumiere = db.get("SELECT * FROM brands WHERE name = 'Lumière Beauty' AND demo = 1");
  html = await (await go(`/admin/tenants/${lumiere.id}?kind=tax_card`)).text();
  assert.match(html, /value="tax_card" selected/);
  assert.match(html, /<details class="upload-box" open>/);

  for (const doc of ['en', 'ar']) {
    const res = await go(`/admin/tenants/${kahwa.id}/print?doc=${doc}`);
    const t = await res.text();
    assert.equal(res.status, 200);
    assert.match(t, new RegExp(`<html lang="${doc}" dir="${doc === 'ar' ? 'rtl' : 'ltr'}"`));
  }
  html = await (await go(`/admin/brands/${kahwa.id}`)).text();
  assert.match(html, new RegExp(`href="/admin/tenants/${kahwa.id}"`));
  const unit = db.get("SELECT id FROM units WHERE code = 'G04'");
  html = await (await go(`/admin/units/${unit.id}`)).text();
  assert.match(html, /Unit documents/);
  assert.match(html, new RegExp(`/admin/tenants/${kahwa.id}`));
  assert.equal((await go('/admin/tenants/99999')).status, 404);
});

test('tenants: edits validate, save and respect roles', async () => {
  const { db } = app.locals.admin;
  const b = db.get("SELECT * FROM brands WHERE name = 'Maison Lune' AND demo = 1");
  await go(`/admin/tenants/${b.id}/legal`, form({ _csrf: csrf, legal_name: 'ML S.A.E.', iban: 'EG12 34' }));
  assert.equal(flash().type, 'error');
  assert.notEqual(db.get('SELECT legal_name FROM brands WHERE id = ?', b.id).legal_name, 'ML S.A.E.');
  await go(`/admin/tenants/${b.id}/legal`, form({ _csrf: csrf, legal_name: 'ML S.A.E.', iban: 'eg38 0019 0005 0000 0000 2631 8000 2' }));
  assert.equal(flash().type, 'ok');
  assert.equal(db.get('SELECT iban FROM brands WHERE id = ?', b.id).iban, 'EG380019000500000000263180002');
  await go(`/admin/tenants/${b.id}/store`, form({ _csrf: csrf, store_email: 'not-an-email' }));
  assert.equal(flash().type, 'error');
  await go(`/admin/tenants/${b.id}/store`, form({ _csrf: csrf, store_manager: 'Hana', store_email: 'hana@example.com', opening_date: '2026-12-01' }));
  const row = db.get('SELECT store_manager, opening_date, updated_at FROM brands WHERE id = ?', b.id);
  assert.equal(row.store_manager, 'Hana');
  assert.equal(row.opening_date, '2026-12-01');
  assert.ok(row.updated_at);
  assert.ok(db.value("SELECT COUNT(*) FROM audit WHERE action = 'Updated tenant store details' AND entity_id = ?", b.id));

  // an agent edits store details but not legal or bank details, and sees bank numbers masked
  db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES ('Agent', 'agent@thewave.test', 'agent', ?, ?)", hashPassword('long-enough-2'), new Date().toISOString());
  const agent = new Map();
  const login = await (await go('/admin/login', {}, agent)).text();
  await go('/admin/login', form({ _token: login.match(/name="_token" value="([^"]+)"/)[1], email: 'agent@thewave.test', password: 'long-enough-2' }), agent);
  const html = await (await go(`/admin/tenants/${b.id}`, {}, agent)).text();
  assert.doesNotMatch(html, /EG380019000500000000263180002/);
  assert.match(html, /EG38 •••• •••• 0002/);
  const aCsrf = html.match(/name="csrf" content="([^"]+)"/)[1];
  await go(`/admin/tenants/${b.id}/legal`, form({ _csrf: aCsrf, legal_name: 'Hijacked' }), agent);
  assert.equal(flash(agent).type, 'error');
  assert.equal(db.get('SELECT legal_name FROM brands WHERE id = ?', b.id).legal_name, 'ML S.A.E.');
});

test('tenants: compliance CSV is spreadsheet-safe', async () => {
  const res = await go('/admin/tenants/compliance.csv');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with a BOM for Excel');
  const text = bytes.toString('utf8');
  assert.match(text.split('\r\n')[0], /Tenant,Legal name,Units/);
  assert.match(text, /Kahwa House/);
});

test('tenants: clearing sample data removes their papers and details', async () => {
  const { db } = app.locals.admin;
  await go('/admin/settings/demo/clear', form({ _csrf: csrf }));
  assert.equal(db.value('SELECT COUNT(*) FROM documents WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM brands WHERE demo = 1 AND legal_name IS NOT NULL'), 0);
  assert.equal((await go('/admin/tenants')).status, 200);
});
