'use strict';

// The leasing office and the tenant portal as installable apps (PWA): web app manifests, the
// service worker and the offline page for each scope. Browsers fetch these without the session
// cookie, so they are served ahead of the sign-in checks: the router's own layer is moved to the
// front of the admin router (and of the public router for /portal).

const crypto = require('node:crypto');
const express = require('express');
const { t: tr, run } = require('../i18n');

const FOREST = '#283833';
const PAPER = '#fbfaf6';

const SCOPES = {
  admin: {
    base: '/admin',
    name: ['The Wave Leasing', 'mob|The Wave Leasing'],
    short: ['The Wave', 'mob|The Wave'],
    description: ['The leasing office of The Wave, New Cairo: leads, offers, leases, billing and more.', 'mob|The leasing office of The Wave, New Cairo: leads, offers, leases, billing and more.'],
    start: '/admin?source=pwa',
    shortcuts: [
      ['New lead', 'mob|New lead', '/admin/leads/new?source=pwa'],
      ['Pipeline', 'mob|Pipeline', '/admin/pipeline?source=pwa'],
      ['Calendar', 'mob|Calendar', '/admin/calendar?source=pwa'],
      ['Billing', 'mob|Billing', '/admin/billing?source=pwa'],
    ],
  },
  portal: {
    base: '/portal',
    name: ['The Wave · Tenants', 'mob|The Wave · Tenants'],
    short: ['The Wave', 'mob|The Wave'],
    description: ['Your store at The Wave: invoices, payments, documents and requests.', 'mob|Your store at The Wave: invoices, payments, documents and requests.'],
    start: '/portal?source=pwa',
    shortcuts: [],
  },
};

// The manifest for a scope, in English or Arabic.
function manifest(scope, lang) {
  const s = SCOPES[scope];
  const pick = (pair) => (lang === 'ar' ? run('ar', () => tr(pair[1])) : pair[0]);
  const icon = (src, size, purpose = 'any') => ({ src: `/admin/app/${src}`, sizes: `${size}x${size}`, type: 'image/png', purpose });
  return {
    id: `${s.base}/`,
    name: pick(s.name),
    short_name: pick(s.short),
    description: pick(s.description),
    lang: lang === 'ar' ? 'ar' : 'en',
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    start_url: s.start,
    scope: `${s.base}/`,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    theme_color: PAPER,
    background_color: FOREST,
    categories: ['business', 'productivity'],
    icons: [icon('icon-192.png', 192), icon('icon-512.png', 512), icon('icon-maskable-512.png', 512, 'maskable')],
    shortcuts: s.shortcuts.map((sc) => ({ name: pick(sc), url: sc[2], icons: [icon('shortcut-96.png', 96)] })),
  };
}

// The service worker. Static files (versioned URLs) are cached first; pages always come from the
// network (they are personal and carry a form token) and fall back to the offline page. Nothing
// else is cached: no POSTs, exports, documents or JSON.
function worker(scope, version) {
  const s = SCOPES[scope];
  return `/* The Wave · ${scope} app, ${version} */
'use strict';
const CACHE = 'wave-${scope}-${version}';
const OFFLINE = '${s.base}/offline';
const PRECACHE = [OFFLINE, '/admin/app/icon-192.png', '/fonts/Montserrat-var.woff2', '/fonts/Almarai-400.woff2', '/fonts/Almarai-700.woff2'];
const STATIC = /^\\/(?:admin\\/(?:admin\\.(?:css|js)|app\\/)|fonts\\/)/;
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('wave-${scope}-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).catch(() => caches.match(OFFLINE)));
    return;
  }
  if (!STATIC.test(u.pathname)) return;
  e.respondWith(caches.open(CACHE).then((c) => c.match(r).then((hit) => hit || fetch(r).then((res) => {
    if (res.ok && res.type === 'basic') {
      c.put(r, res.clone());
      // keep one version of each file: drop the same path with an older ?v=
      c.keys().then((ks) => ks.forEach((k) => { const ku = new URL(k.url); if (ku.pathname === u.pathname && ku.search !== u.search) c.delete(k); }));
    }
    return res;
  }))));
});
`;
}

// A branded page for when there is no connection, in both languages.
function offline(scope) {
  const s = SCOPES[scope];
  const en = 'You are offline';
  const ar = run('ar', () => tr('mob|You are offline'));
  const enLead = 'Check your connection, then try again. Nothing you saved has been lost.';
  const arLead = run('ar', () => tr('mob|Check your connection, then try again. Nothing you saved has been lost.'));
  const retry = 'Try again';
  const arRetry = run('ar', () => tr('mob|Try again'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="${FOREST}"><meta name="robots" content="noindex">
<title>The Wave · ${en}</title><link rel="icon" href="/admin/app/icon-192.png">
<style>
@font-face{font-family:'Montserrat';font-weight:100 900;src:url(/fonts/Montserrat-var.woff2) format('woff2')}
@font-face{font-family:'Almarai';font-weight:400;src:url(/fonts/Almarai-400.woff2) format('woff2')}
@font-face{font-family:'Almarai';font-weight:700;src:url(/fonts/Almarai-700.woff2) format('woff2')}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{min-height:100vh;display:grid;place-items:center;background:${FOREST};color:#e9e4d6;font:15px/1.6 Montserrat,system-ui,sans-serif;padding:32px 24px calc(32px + env(safe-area-inset-bottom))}
main{max-width:420px;text-align:center}
img{width:76px;height:76px;border-radius:20px;margin-bottom:28px}
h1{font:600 24px/1.25 Montserrat,sans-serif;color:${PAPER};margin:0 0 8px}
p{margin:0 0 6px;opacity:.85}
.ar{font-family:Almarai,sans-serif;margin-top:22px}.ar h1{font-family:Almarai,sans-serif;font-weight:700}
a{display:inline-block;margin-top:28px;padding:13px 26px;border-radius:999px;background:#d1c9b3;color:${FOREST};font-weight:700;text-decoration:none}
</style></head><body><main>
<img src="/admin/app/icon-192.png" alt="The Wave">
<h1>${en}</h1><p>${enLead}</p>
<div class="ar" dir="rtl" lang="ar"><h1>${ar}</h1><p>${arLead}</p></div>
<a href="${s.base}">${retry} · <span lang="ar">${arRetry}</span></a>
</main></body></html>`;
}

module.exports = function mobile(router, h) {
  const { ui } = h;
  const version = crypto.createHash('sha1').update(JSON.stringify([ui.ASSETS || {}, require('../../../package.json').version])).digest('hex').slice(0, 10);

  // prefix: the path the router sees ('' inside the admin router, which is mounted at /admin)
  const serve = (scope, prefix) => {
    const r = express.Router();
    const base = SCOPES[scope].base;
    r.get(`${prefix}/manifest.webmanifest`, (req, res) => {
      const lang = req.query.lang === 'ar' ? 'ar' : 'en';
      res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      res.send(JSON.stringify(manifest(scope, lang), null, 2));
    });
    r.get(`${prefix}/sw.js`, (req, res) => {
      res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': `${base}/` });
      res.send(worker(scope, version));
    });
    r.get(`${prefix}/offline`, (req, res) => {
      res.set({ 'Cache-Control': 'public, max-age=3600', 'X-Robots-Tag': 'noindex' });
      res.type('html').send(offline(scope));
    });
    return r;
  };

  // Put a router ahead of everything already on `target` (sign-in checks, CSRF, the portal's own auth).
  const first = (target, sub) => {
    target.use(sub);
    target.stack.unshift(target.stack.pop());
  };
  first(router, serve('admin', ''));
  if (h.public) first(h.public, serve('portal', '/portal'));
};

module.exports.manifest = manifest;
module.exports.SCOPES = SCOPES;
