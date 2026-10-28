'use strict';

// The leasing office as an installable app: manifests for both scopes, the service workers, the
// offline pages, the head tags on every page, and the phone shell's markup.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const ui = require('../src/admin/ui');
const i18n = require('../src/admin/i18n');

let server;
let base;
let app;
const jar = new Map();

before(async () => {
  app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function go(path, opts = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
    else jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}

test('mobile: manifests for the office and the portal, in both languages, without signing in', async () => {
  for (const [scope, name] of [['admin', 'The Wave Leasing'], ['portal', 'The Wave · Tenants']]) {
    const res = await fetch(`${base}/${scope}/manifest.webmanifest`);
    assert.equal(res.status, 200, scope);
    assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
    const m = await res.json();
    assert.equal(m.name, name);
    assert.equal(m.scope, `/${scope}/`);
    assert.ok(m.start_url.startsWith(`/${scope}`));
    assert.equal(m.display, 'standalone');
    assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
    assert.ok(m.icons.some((i) => i.sizes === '192x192'));
    for (const i of m.icons) assert.equal((await fetch(base + i.src)).status, 200, i.src);
    const ar = await (await fetch(`${base}/${scope}/manifest.webmanifest?lang=ar`)).json();
    assert.equal(ar.dir, 'rtl');
    assert.match(ar.name, /[؀-ۿ]/);
  }
  const m = await (await fetch(`${base}/admin/manifest.webmanifest`)).json();
  assert.deepEqual(m.shortcuts.map((s) => s.url.split('?')[0]), ['/admin/leads/new', '/admin/pipeline', '/admin/calendar', '/admin/billing']);
});

test('mobile: service workers and offline pages are served with the right headers', async () => {
  for (const scope of ['admin', 'portal']) {
    const res = await fetch(`${base}/${scope}/sw.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(res.headers.get('service-worker-allowed'), `/${scope}/`);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const js = await res.text();
    assert.match(js, new RegExp(`OFFLINE = '/${scope}/offline'`));
    assert.match(js, /r\.method !== 'GET'/, 'never caches anything but GET');
    const off = await fetch(`${base}/${scope}/offline`);
    assert.equal(off.status, 200);
    const html = await off.text();
    assert.match(html, /You are offline/);
    assert.match(html, /لا يوجد اتصال/);
  }
  // the worker itself is valid JavaScript
  // eslint-disable-next-line no-new-func
  new Function(await (await fetch(`${base}/admin/sw.js`)).text());
  // the page reloads for a new version only when asked: the first install also changes the
  // controller, and reloading then wiped the sign-in form as it was being typed
  const pwa = await (await fetch(`${base}/admin/app/pwa.js`)).text();
  assert.match(pwa, /controllerchange', \(\) => \{\s*if \(!wanted \|\| refreshing\) return;/);
  assert.match(pwa, /wanted = true; w\.postMessage\('skip-waiting'\)/);
});

test('mobile: every page carries the app head, and phones get the tab bar and the More sheet', async () => {
  let html = await (await go('/admin/setup')).text();
  assert.match(html, /<link rel="manifest" href="\/admin\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color" content="#fbfaf6"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /\/admin\/app\/pwa\.js\?v=\w+" data-sw="\/admin\/sw\.js" data-scope="\/admin\/"/);
  await go('/admin/setup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: html.match(/name="_token" value="([^"]+)"/)[1], name: 'Owner Test', email: 'o@thewave.test', password: 'long-enough-1' }).toString() });
  html = await (await go('/admin/leads/new')).text();
  assert.match(html, /class="tabbar"/);
  assert.match(html, /id="more" data-more/);
  assert.match(html, /class="bar__back" href="\/admin\/leads"/, 'back to the nearest crumb');
  assert.match(html, /data-more-open/);
  assert.match(html, /data-cmdk-close/);
  // the whole menu is in the sheet, by permission: an admin sees Settings
  const sheet = html.slice(html.indexOf('id="more"'));
  assert.match(sheet, /href="\/admin\/settings"/);
  html = await (await go('/admin?lang=ar')).text();
  assert.match(html, /<link rel="manifest" href="\/admin\/manifest\.webmanifest\?lang=ar">/);
  assert.match(html, /tabbar__a is-on" aria-current="page"[^>]*><svg[^>]*><path[^>]*\/><\/svg><span>الرئيسية/);
});

test('mobile: tables label every cell so phones can show them as cards', () => {
  const html = ui.table([{ label: 'Name', key: 'n' }, { label: 'Total', num: true, key: 't' }, { label: '', key: 'x' }], [{ n: 'A', t: 5, x: '' }]);
  assert.match(html, /class="table table--resp /);
  assert.match(html, /<td data-label="Name">A<\/td>/);
  assert.match(html, /<td class="num" data-label="Total">5<\/td>/);
  assert.match(html, /<td data-label="">/);
  i18n.run('ar', () => assert.match(ui.pwaHead('portal'), /manifest\.webmanifest\?lang=ar/));
  assert.match(ui.pwaHead('portal'), /data-sw="\/portal\/sw\.js" data-scope="\/portal\/"/);
});
