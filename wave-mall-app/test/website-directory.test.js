'use strict';

// The website's store directory, events and offers: kept at /admin/website, shown at /stores/ and
// /events/ in English and Arabic, with structured data and sitemap entries. Only tenants with an
// active lease are published; images are served only while something published uses them; and
// when the leasing office cannot start the pages say "coming soon" instead of failing.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const M = require('../src/admin/model');

let server;
let base;
let db;
let csrf;
const jar = new Map();

async function go(path_, opts = {}) {
  const res = await fetch(base + path_, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}
const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const post = (p, data = {}) => go(p, form({ _csrf: csrf, ...data }));
const upload = (p, buf, name) => go(p, { method: 'POST', headers: { 'x-csrf': csrf, 'x-file-name': name, 'content-type': 'application/octet-stream', accept: 'application/json' }, body: buf });
const ld = (html) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].flatMap((m) => JSON.parse(m[1])['@graph']);
// the first bytes of a real PNG are all the store checks
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function tenant(name, code, status = 'active') {
  const t = M.now();
  const b = Number(db.run("INSERT INTO brands (name, category, instagram, website, trading_hours, store_phone, created_at) VALUES (?, 'fnb', '@kahwatest', 'kahwa.example', '08:00–01:00', '+20 10 1234 5678', ?)", name, t).lastInsertRowid);
  const l = Number(db.run(`INSERT INTO leases (ref, brand_id, status, start_date, end_date, term_years, rent_m2, created_at) VALUES (?, ?, ?, ?, ?, 5, 2000, ?)`,
    db.nextRef('leases', 'LS', 3, true), b, status, M.today(), M.addDays(M.today(), 1800), t).lastInsertRowid);
  db.run('INSERT INTO lease_units (lease_id, unit_id) VALUES (?, ?)', l, db.get('SELECT id FROM units WHERE code = ?', code).id);
  return { brand: b, lease: l };
}

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  base = `http://127.0.0.1:${server.address().port}`;
  db = app.locals.admin.db;
  const setup = await (await go('/admin/setup')).text();
  await go('/admin/setup', form({ _token: setup.match(/name="_token" value="([^"]+)"/)[1], name: 'Admin', email: 'admin@thewave.test', password: 'long-enough-1' }));
  csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
});
after(() => server.close());

test('directory: an empty directory is a calm page, in both languages', async () => {
  let res = await go('/stores/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /are moving in/);
  res = await go('/ar/stores/');
  const html = await res.text();
  assert.match(html, /<html lang="ar" dir="rtl"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/thewavemall.com\/ar\/stores\/">/);
  assert.match(html, /hreflang="en" href="https:\/\/thewavemall.com\/stores\/"/);
  assert.match(html, /href="\/ar\/stores\/" aria-current="page"/, 'Stores is in the menu');
});

let K;
let S;
test('directory: a listing starts from the tenant file and is published only with an active lease', async () => {
  K = tenant('Kahwa Test', 'G04');
  const draft = tenant('Draft Café', 'G05', 'draft');
  let res = await post('/admin/website/stores', { brand_id: String(K.brand) });
  assert.equal(res.status, 303);
  S = db.get('SELECT * FROM web_stores WHERE brand_id = ?', K.brand);
  assert.equal(S.slug, 'kahwa-test');
  assert.equal(S.category, 'fnb');
  assert.equal(S.published, 0);
  assert.equal((await go('/stores/kahwa-test/')).status, 404, 'unpublished stores are not on the website');

  // the draft-lease brand can be prepared but not published
  await post('/admin/website/stores', { brand_id: String(draft.brand) });
  const d = db.get('SELECT * FROM web_stores WHERE brand_id = ?', draft.brand);
  await post(`/admin/website/stores/${d.id}/publish`, { on: '1' });
  assert.equal(db.get('SELECT published FROM web_stores WHERE id = ?', d.id).published, 0);
  const none = tenant('No Lease', 'G06', 'ended');
  res = await post('/admin/website/stores', { brand_id: String(none.brand) });
  assert.equal(db.value('SELECT COUNT(*) FROM web_stores WHERE brand_id = ?', none.brand), 0, 'no lease, no listing');

  // words in both languages; bad links are refused
  res = await post(`/admin/website/stores/${S.id}`, { name: 'Kahwa Test', slug: 'kahwa-test', category: 'fnb', instagram: 'javascript:alert(1)' });
  assert.equal(db.get('SELECT instagram FROM web_stores WHERE id = ?', S.id).instagram, null);
  await post(`/admin/website/stores/${S.id}`, {
    name: 'Kahwa Test', name_ar: 'قهوة تست', slug: 'kahwa-test', category: 'fnb', tagline: 'Coffee on the court', tagline_ar: 'قهوة في الساحة',
    description: 'Small-batch coffee.\n\nBreakfast until late </script><script>alert(1)</script>', description_ar: 'قهوة مختصة.', instagram: 'https://instagram.com/kahwatest/', opening_soon: '1',
  });
  S = db.get('SELECT * FROM web_stores WHERE id = ?', S.id);
  assert.equal(S.instagram, 'kahwatest');
  res = await post(`/admin/website/stores/${S.id}/publish`, { on: '1' });
  assert.equal(db.get('SELECT published FROM web_stores WHERE id = ?', S.id).published, 1);
  assert.match(await (await go(`/admin/tenants/${K.brand}`)).text(), /stores\/kahwa-test\//, 'the tenant file shows the listing');
});

test('directory: public pages in English and Arabic, with valid structured data', async () => {
  let res = await go('/stores/');
  let html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Kahwa Test/);
  assert.match(html, /Opening soon/);
  assert.match(html, /data-shop="kahwa-test"/, 'marked on the plan');
  assert.ok(ld(html).some((x) => x['@type'] === 'ItemList' && x.itemListElement[0].url === 'https://thewavemall.com/stores/kahwa-test/'));
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);

  res = await go('/stores/kahwa-test/');
  html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /08:00–01:00/, 'hours from the tenant file');
  assert.match(html, /tel:\+201012345678/);
  assert.match(html, /instagram.com\/kahwatest/);
  assert.doesNotMatch(html, /<\/script><script>alert/, 'typed text is escaped');
  const store = ld(html).find((x) => x['@type'] === 'FoodEstablishment');
  assert.equal(store.name, 'Kahwa Test');
  assert.equal(store.openingHours, 'Mo-Su 08:00-01:00');
  assert.ok(store.sameAs.includes('https://www.instagram.com/kahwatest'));

  res = await go('/ar/stores/kahwa-test/');
  html = await res.text();
  assert.match(html, /<html lang="ar" dir="rtl"/);
  assert.match(html, /قهوة تست/);
  assert.match(html, /مستوى الساحة · G04/);

  // filters work without JavaScript
  html = await (await go('/stores/?cat=fashion')).text();
  assert.match(html, /<li hidden class="shop/);
  html = await (await go('/stores/?q=kahwa')).text();
  assert.doesNotMatch(html, /<li hidden class="shop/);
  assert.equal((await go('/stores/nope/')).status, 404);
});

test('directory: images are raster only and public only while published', async () => {
  let res = await upload(`/admin/website/stores/${S.id}/image?slot=cover`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg');
  assert.equal(res.status, 415, 'no SVG uploads');
  res = await upload(`/admin/website/stores/${S.id}/image?slot=cover`, PNG, 'cover.png');
  assert.equal(res.status, 200);
  const img = db.get('SELECT i.* FROM web_stores s JOIN web_images i ON i.id = s.cover_id WHERE s.id = ?', S.id);
  assert.match(await (await go('/stores/kahwa-test/')).text(), new RegExp(`/media/web/${img.stored}`));
  res = await go(`/media/web/${img.stored}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  await post(`/admin/website/stores/${S.id}/publish`, { on: '0' });
  assert.equal((await go(`/media/web/${img.stored}`)).status, 404, 'unpublished images are private');
  assert.equal((await go(`/admin/website/img/${img.id}`)).status, 200, 'the office still sees it');
  await post(`/admin/website/stores/${S.id}/publish`, { on: '1' });
  // replacing the image removes the old one
  res = await upload(`/admin/website/stores/${S.id}/image?slot=cover`, Buffer.concat([PNG, Buffer.from('v2')]), 'cover2.png');
  assert.equal(db.value('SELECT COUNT(*) FROM web_images WHERE id = ?', img.id), 0);
});

test('directory: a store leaves the website when its lease ends', async () => {
  const x = tenant('Short Stay', 'G07');
  await post('/admin/website/stores', { brand_id: String(x.brand) });
  const s = db.get('SELECT * FROM web_stores WHERE brand_id = ?', x.brand);
  await post(`/admin/website/stores/${s.id}/publish`, { on: '1' });
  assert.equal((await go('/stores/short-stay/')).status, 200);
  db.run("UPDATE leases SET status = 'ended' WHERE id = ?", x.lease);
  assert.equal((await go('/stores/short-stay/')).status, 404);
  assert.doesNotMatch(await (await go('/stores/')).text(), /Short Stay/);
});

test('events and offers: published, listed, with Event data and a calendar file', async () => {
  let res = await post('/admin/website/events', { title: 'Jazz on the Court', starts_on: M.addDays(M.today(), 10) });
  const e = db.get("SELECT * FROM web_events WHERE slug = 'jazz-on-the-court'");
  assert.ok(e);
  await post(`/admin/website/events/${e.id}`, { title: 'Jazz on the Court', title_ar: 'جاز في الساحة', slug: 'jazz-on-the-court', starts_on: e.starts_on, ends_on: M.addDays(e.starts_on, 2), time_from: '19:30', time_to: '23:00', location: 'The open court', rsvp_url: 'tickets.example/jazz' });
  assert.equal((await go('/events/jazz-on-the-court/')).status, 404, 'drafts are not public');
  await post(`/admin/website/events/${e.id}/publish`, { on: '1' });
  res = await go('/events/');
  let html = await res.text();
  assert.match(html, /Jazz on the Court/);
  res = await go('/events/jazz-on-the-court/');
  html = await res.text();
  const ev = ld(html).find((x) => x['@type'] === 'Event');
  assert.equal(ev.name, 'Jazz on the Court');
  assert.match(ev.startDate, new RegExp(`^${e.starts_on}T19:30:00\\+0[23]:00$`));
  assert.match(html, /href="https:\/\/tickets.example\/jazz"/);
  html = await (await go('/ar/events/jazz-on-the-court/')).text();
  assert.match(html, /جاز في الساحة/);
  res = await go('/events/jazz-on-the-court/calendar.ics');
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  assert.match(await res.text(), /BEGIN:VEVENT[\s\S]*SUMMARY:Jazz on the Court/);

  await post('/admin/website/promos', { brand_id: String(K.brand), title: 'Two for one', starts_on: M.today(), ends_on: M.addDays(M.today(), 7) });
  const pr = db.get("SELECT * FROM web_promos WHERE title = 'Two for one'");
  await post(`/admin/website/promos/${pr.id}/publish`, { on: '1' });
  assert.match(await (await go('/stores/')).text(), /Two for one/);
  assert.match(await (await go('/stores/kahwa-test/')).text(), /Two for one/);
});

test('directory: the sitemap lists the directory, stores and events', async () => {
  const sm = await (await go('/sitemap.xml')).text();
  for (const u of ['/stores/', '/ar/stores/', '/events/', '/stores/kahwa-test/', '/ar/stores/kahwa-test/', '/events/jazz-on-the-court/']) assert.match(sm, new RegExp(`<loc>https://thewavemall.com${u}</loc>`), u);
  assert.doesNotMatch(sm, /draft-cafe/);
});

test('directory: admin pages render in English and Arabic', async () => {
  for (const lang of ['en', 'ar']) {
    await post('/admin/lang', { lang, back: '/admin' });
    for (const p of ['/admin/website', '/admin/website?tab=events', '/admin/website?tab=promos', '/admin/website?tab=settings', `/admin/website/stores/${S.id}`]) {
      const res = await go(p);
      assert.equal(res.status, 200, p);
      assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, p);
    }
  }
  await post('/admin/lang', { lang: 'en', back: '/admin' });
});

test('directory: when the office cannot start, the pages say "coming soon" and never fail', async () => {
  const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wave-ro-')), 'file');
  fs.writeFileSync(blocked, 'not a folder');
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: path.join(blocked, 'office.db'), DATA_DIR: blocked, ADMIN_JOBS: '0' } });
  const s2 = app.listen(0);
  await new Promise((r) => s2.once('listening', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    await app.locals.admin.ready;
    assert.ok(app.locals.admin.error, 'the office is down for this test');
    for (const p of ['/stores/', '/ar/stores/', '/events/', '/ar/events/']) {
      const res = await fetch(b2 + p);
      assert.equal(res.status, 200, p);
      assert.match(await res.text(), /coming soon|قريبًا/, p);
    }
    const res = await fetch(`${b2}/stores/kahwa-test/`);
    assert.ok(res.status < 500 || res.status === 503, 'a store page is unavailable, not broken');
    assert.notEqual(res.status, 500);
    const sm = await fetch(`${b2}/sitemap.xml`);
    assert.equal(sm.status, 200);
    assert.match(await sm.text(), /\/stores\//);
  } finally {
    s2.close();
  }
});
