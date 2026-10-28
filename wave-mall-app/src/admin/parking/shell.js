'use strict';

// The frame of the visitors' parking pages (bookings, subscriptions, the subscriber's page):
// The Wave's logo, the language switch, no navigation. Language from ?lang=, the form, or the browser.

const express = require('express');
const i18n = require('../i18n');

const { t: tr } = i18n;

function publicRouter(h, mount) {
  const r = express.Router();
  h.public.use(mount, r);
  r.use(express.urlencoded({ extended: false, limit: '8kb' }));
  r.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex');
    const q = String(req.query.lang || (req.body && req.body.lang) || '');
    req.lang = q === 'ar' || q === 'en' ? q : /^ar\b/i.test(String(req.get('accept-language') || '')) ? 'ar' : 'en';
    i18n.run(req.lang, next);
  });
  return r;
}

function shell(h) {
  const { ui, db } = h;
  return (req, res, { title, body, status = 200 }) => {
    ui.setCurrency(db.setting('currency'));
    const other = req.lang === 'ar' ? 'en' : 'ar';
    const self = req.originalUrl.replace(/([?&])lang=(en|ar)(&|$)/, '$1').replace(/[?&]$/, '');
    res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="${req.lang}" dir="${req.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#283833">
<meta name="robots" content="noindex">
<title>${ui.esc(title)} · The Wave</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ui.ASSETS.css}">
</head>
<body class="adm portal paypage pk-public" data-lang="${req.lang}">
<main class="paywrap pk-wrap">
  <header class="paywrap__head"><a href="/parking${req.lang === 'ar' ? '?lang=ar' : ''}" aria-label="The Wave">${ui.logo('paywrap__logo')}</a><a class="langbtn" href="${ui.esc(self)}${self.includes('?') ? '&' : '?'}lang=${other}" lang="${other}">${ui.icon('globe')}<span>${other === 'ar' ? 'العربية' : 'English'}</span></a></header>
  ${body}
  <p class="paywrap__foot">${ui.icon('car')}<span>${ui.esc(tr('prk|The Wave · North 90, New Cairo'))}</span></p>
</main>
<script src="/admin/admin.js?v=${ui.ASSETS.js}" defer></script>
<script src="/admin/parking.js?v=${ui.ASSETS.parking}" defer></script>
</body>
</html>`);
  };
}

// A Cairo-local date and time ("2026-10-28", "14:30") as a UTC ISO moment (Egypt keeps summer time).
function cairoToUtc(date, hm, ui) {
  const [hh, mm] = String(hm).split(':').map(Number);
  for (const off of [2, 3]) {
    const t = Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) - off * 3600000;
    if (ui.local(new Date(t).toISOString()).slice(0, 16) === `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`) return new Date(t).toISOString();
  }
  return new Date(Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) - 2 * 3600000).toISOString();
}

module.exports = { publicRouter, shell, cairoToUtc };
