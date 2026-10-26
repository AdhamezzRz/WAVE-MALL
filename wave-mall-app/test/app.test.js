'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, ROUTES } = require('../src/app');
const { validate } = require('../src/enquiry');

let server;
let base;
const sent = [];

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:' }, mail: async (v) => { sent.push(v); return { delivered: true }; } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready; // the office opens in the background on older Node (sql.js)
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('every page renders in both languages with the right lang/dir and canonical', async () => {
  for (const [route] of ROUTES) {
    for (const [prefix, lang, dir] of [['', 'en', 'ltr'], ['/ar', 'ar', 'rtl']]) {
      const res = await fetch(base + prefix + route);
      assert.equal(res.status, 200, prefix + route);
      const html = await res.text();
      assert.match(html, new RegExp(`<html lang="${lang}" dir="${dir}"`));
      assert.match(html, new RegExp(`<link rel="canonical" href="https://thewavemall.com${prefix}${route}">`));
      assert.match(html, /<main id="main"/);
      assert.doesNotMatch(html, /undefined|\[object Object\]/);
    }
  }
});

test('security headers and asset caching', async () => {
  const res = await fetch(base + '/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'nonce-/);
  assert.equal(res.headers.get('x-powered-by'), null);
  const css = await fetch(base + '/css/site.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('cache-control'), /immutable/);
});

test('sitemap, robots, health and 404', async () => {
  const sm = await (await fetch(base + '/sitemap.xml')).text();
  assert.match(sm, /<loc>https:\/\/thewavemall.com\/ar\/leasing\/<\/loc>/);
  assert.match(await (await fetch(base + '/robots.txt')).text(), /Sitemap: https:\/\/thewavemall.com\/sitemap.xml/);
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true });
  const old = await fetch(base + '/ar/location/', { redirect: 'manual' });
  assert.equal(old.status, 301);
  assert.equal(old.headers.get('location'), '/ar/visit/');
  const nf = await fetch(base + '/ar/nothing-here');
  assert.equal(nf.status, 404);
  assert.match(await nf.text(), /dir="rtl"/);
});

test('enquiry validation', () => {
  assert.equal(validate({}).ok, false);
  assert.deepEqual(validate({}).errors, ['name', 'brand', 'email']);
  const ok = validate({ name: ' Mona ', brand: 'Atelier', email: 'mona@example.com', lang: 'ar', message: 'x'.repeat(5000) });
  assert.equal(ok.value.category, 'other');
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, 'Mona');
  assert.equal(ok.value.message.length, 2000);
  assert.equal(ok.value.lang, 'ar');
  assert.equal(validate({ name: 'a', brand: 'b', email: 'nope' }).errors[0], 'email');
  assert.deepEqual(validate({ name: 'a', brand: 'b', email: 'a@b.co', category: 'bogus' }).errors, ['category']);
});

test('journal: posts, feed, structured data, sitemap lastmod', async () => {
  const idx = await (await fetch(base + '/journal/')).text();
  assert.match(idx, /"@type":"Blog"/);
  const res = await fetch(base + '/ar/journal/designed-to-flow/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /"@type":"BlogPosting"/);
  assert.match(html, /property="og:type" content="article"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/thewavemall.com\/ar\/journal\/designed-to-flow\/">/);
  assert.match(html, /<h2>/);
  assert.equal((await fetch(base + '/journal/not-a-post/')).status, 404);
  const feed = await fetch(base + '/journal/feed.xml');
  assert.match(feed.headers.get('content-type'), /rss/);
  assert.match(await feed.text(), /<item><title>The story behind our mark<\/title>/);
  const sm = await (await fetch(base + '/sitemap.xml')).text();
  assert.match(sm, /<loc>https:\/\/thewavemall.com\/journal\/after-dark\/<\/loc><lastmod>2026-09-10<\/lastmod>/);
  assert.match(sm, /\/ar\/contact\//);
});

test('contact and subscribe APIs', async () => {
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' };
  let res = await fetch(base + '/api/contact', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Mona', email: 'mona@example.com', subject: 'press', message: 'Hello' }) });
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(sent.at(-1).kind, 'contact');
  res = await fetch(base + '/api/contact', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Mona', email: 'mona@example.com', subject: 'nope', message: '' }) });
  assert.equal(res.status, 422);
  assert.deepEqual((await res.json()).errors, ['subject', 'message']);
  res = await fetch(base + '/api/subscribe', { method: 'POST', headers: json, body: JSON.stringify({ email: 'mona@example.com', lang: 'ar' }) });
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(sent.at(-1), { kind: 'subscribe', email: 'mona@example.com', lang: 'ar' });
  res = await fetch(base + '/api/subscribe', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: 'email=bad' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/journal/?sent=0');
});

test('enquiry API: json, honeypot, form redirect', async () => {
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' };
  let res = await fetch(base + '/api/enquiry', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Mona', brand: 'Atelier', email: 'mona@example.com', category: 'fashion' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(sent.filter((v) => v.kind === 'leasing').length, 1);

  res = await fetch(base + '/api/enquiry', { method: 'POST', headers: json, body: JSON.stringify({ name: '', email: 'x' }) });
  assert.equal(res.status, 422);
  assert.deepEqual((await res.json()).errors, ['name', 'brand', 'email']);

  res = await fetch(base + '/api/enquiry', { method: 'POST', headers: json, body: JSON.stringify({ website: 'spam', name: 'x' }) });
  assert.equal(res.status, 200);
  assert.equal(sent.filter((v) => v.kind === 'leasing').length, 1, 'honeypot submissions are not delivered');

  res = await fetch(base + '/api/enquiry', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: 'name=Mona&brand=Atelier&email=mona%40example.com&category=fnb&lang=ar' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/ar/leasing/?sent=1');
});
