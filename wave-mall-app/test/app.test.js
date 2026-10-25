'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, ROUTES } = require('../src/app');
const { validate } = require('../src/enquiry');

let server;
let base;
const sent = [];

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com' }, mail: async (v) => { sent.push(v); return { delivered: true }; } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
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

test('enquiry API: json, honeypot, form redirect', async () => {
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' };
  let res = await fetch(base + '/api/enquiry', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Mona', brand: 'Atelier', email: 'mona@example.com', category: 'fashion' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(sent.length, 1);

  res = await fetch(base + '/api/enquiry', { method: 'POST', headers: json, body: JSON.stringify({ name: '', email: 'x' }) });
  assert.equal(res.status, 422);
  assert.deepEqual((await res.json()).errors, ['name', 'brand', 'email']);

  res = await fetch(base + '/api/enquiry', { method: 'POST', headers: json, body: JSON.stringify({ website: 'spam', name: 'x' }) });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1, 'honeypot submissions are not delivered');

  res = await fetch(base + '/api/enquiry', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: 'name=Mona&brand=Atelier&email=mona%40example.com&category=fnb&lang=ar' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/ar/leasing/?sent=1#enquire');
});
