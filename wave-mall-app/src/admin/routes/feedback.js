'use strict';

// Shopper feedback (/admin/feedback): QR posters around the mall open a short page on the shopper's
// phone (/feedback/<location>, Arabic or English): a rating from 1 to 5, what it is about, a comment
// and, if they want an answer, a mobile number. Each one becomes a ticket for the office (new, in
// progress, resolved; who handles it, the reply). Cleanliness raises a cleaning alert on the area
// the poster is in; facilities open a maintenance work order. The dashboard shows the average rating
// by location and by week, a recommend score (5 = promoter, 4 = passive, 1–3 = detractor), the worst
// places and how fast the office responds.
// The public page is rate-limited, carries a signed time token (bots that post at once are refused),
// has a hidden trap field, and ignores repeats.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const { tmap } = require('../ops-common');
const QR = require('../qr');

const { t: tr, tn } = i18n;

const SCHEMA = `
  CREATE TABLE fb_locations (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_ar TEXT, floor TEXT,
    area_id INTEGER, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE fb_entries (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, location_id INTEGER REFERENCES fb_locations(id) ON DELETE SET NULL,
    rating INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'other', comment TEXT, phone TEXT, lang TEXT NOT NULL DEFAULT 'en',
    ip_hash TEXT, status TEXT NOT NULL DEFAULT 'new', assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reply TEXT,
    routed_kind TEXT, routed_id INTEGER, first_action_at TEXT, resolved_at TEXT, demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX fb_entries_at ON fb_entries(created_at);
  CREATE INDEX fb_entries_loc ON fb_entries(location_id, created_at);
  CREATE TABLE fb_events (
    id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES fb_entries(id) ON DELETE CASCADE, kind TEXT NOT NULL, body TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, at TEXT NOT NULL
  );
`;

const RATE = { 1: 'fb|Very bad', 2: 'fb|Bad', 3: 'fb|Okay', 4: 'fb|Good', 5: 'fb|Excellent' };
const CATS = { cleanliness: 'fb|Cleanliness', safety: 'fb|Safety and security', staff: 'fb|Staff and service', facilities: 'fb|Facilities (toilets, lifts, AC…)', parking: 'fb|Parking', other: 'fb|Something else' };
const STATUS = { new: ['fb|New', 'sky'], in_progress: ['fb|In progress', 'amber'], resolved: ['fb|Resolved', 'ok'] };
// the faces on the public page: mouth curve per rating
const MOUTH = { 1: 'M9 17.5q3-3.5 6 0', 2: 'M9 16.8q3-1.6 6 0', 3: 'M9 16h6', 4: 'M9 15.2q3 2 6 0', 5: 'M8.5 14.5q3.5 4 7 0' };
const face = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/><circle cx="8.6" cy="10" r="1.2" class="e"/><circle cx="15.4" cy="10" r="1.2" class="e"/><path d="${MOUTH[n]}"/></svg>`;
const MIN_SECONDS = 2;
// the poster speaks both languages at once
const POSTER = { ar: ['كيف كانت زيارتك؟', 'امسح الرمز بكاميرا هاتفك وقيّم تجربتك في أقل من دقيقة'], en: ['How was your visit?', 'Scan with your phone camera and rate your visit in under a minute'] };

module.exports = function feedback(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  db.ensure('feedback-1', SCHEMA);
  const esc = ui.esc;
  const now = () => new Date().toISOString();
  const badge = (k) => ui.badge(k, tr((STATUS[k] || [k])[0]), (STATUS[k] || [])[1]);
  const site = (req) => String((h.env && h.env.SITE_URL) || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const secret = () => {
    let s = db.setting('fb_secret');
    if (!s) { s = crypto.randomBytes(24).toString('base64url'); db.setSetting('fb_secret', s); }
    return s;
  };
  const sign = (s) => crypto.createHmac('sha256', secret()).update(s).digest('base64url').slice(0, 24);
  const stars = (r) => (r === null || r === undefined ? '—' : `${(Math.round(r * 10) / 10).toFixed(1)}`);
  (h.auditTyped = h.auditTyped || []).push('SELECT code, name, floor FROM fb_locations', 'SELECT ref, comment, phone, reply FROM fb_entries', 'SELECT body FROM fb_events',
    "SELECT title, description, reported_by, location FROM work_orders WHERE reported_by LIKE 'Shopper feedback%'",
    // the posters are bilingual on purpose
    `SELECT '${POSTER.en[0]}' a, '${POSTER.en[1]}' b`);

  // ---------- a submission ----------
  function event(id, kind, body = null, user = null, at = now()) {
    db.run('INSERT INTO fb_events (entry_id, kind, body, user_id, at) VALUES (?, ?, ?, ?, ?)', id, kind, body, user ? user.id : null, at);
  }
  // route a complaint (rated 3 or less): cleanliness → a cleaning alert; facilities → a maintenance work order
  function route(e, loc, { demo = 0, at = now() } = {}) {
    if (e.rating > 3) return;
    if (e.category === 'cleanliness' && h.security && h.security.cleaningAlert) {
      const id = h.security.cleaningAlert({ area_id: loc ? loc.area_id : null, place: loc ? loc.name : null, note: e.comment, source: 'feedback', source_id: e.id, demo, at });
      db.run("UPDATE fb_entries SET routed_kind = 'cleaning', routed_id = ? WHERE id = ?", id, e.id);
      event(e.id, 'routed_cleaning', null, null, at);
    } else if (e.category === 'facilities' && h.maintenance && h.maintenance.createWo) {
      const id = h.maintenance.createWo({
        title: `Shopper feedback ${e.ref}${loc ? ` · ${loc.name}` : ''}`, description: e.comment || null, category: 'civil', priority: e.rating <= 2 ? 2 : 3,
        location: loc ? [loc.name, loc.floor].filter(Boolean).join(' · ') : null, reported_by: `Shopper feedback ${e.ref}`,
      }, { source: 'staff', demo, at });
      db.run("UPDATE fb_entries SET routed_kind = 'maintenance', routed_id = ? WHERE id = ?", id, e.id);
      event(e.id, 'routed_maintenance', db.value('SELECT ref FROM work_orders WHERE id = ?', id), null, at);
    }
  }
  function submit(loc, { rating, category = 'other', comment = null, phone = null, lang = 'en', ip_hash = null, demo = 0, at = now() }) {
    return db.tx(() => {
      const id = Number(db.run(`INSERT INTO fb_entries (ref, location_id, rating, category, comment, phone, lang, ip_hash, status, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`, db.nextRef('fb_entries', 'FB', 4, true), loc ? loc.id : null, rating, CATS[category] ? category : 'other', comment, phone, lang === 'ar' ? 'ar' : 'en', ip_hash, demo ? 1 : 0, at, at).lastInsertRowid);
      const e = db.get('SELECT * FROM fb_entries WHERE id = ?', id);
      route(e, loc, { demo, at });
      h.events.emit('feedback.received', { entry: e });
      return db.get('SELECT * FROM fb_entries WHERE id = ?', id);
    });
  }
  h.feedback = { submit, RATE, CATS };

  h.count('feedback', () => db.value("SELECT COUNT(*) FROM fb_entries WHERE status = 'new'"));

  // ================= the shopper's page =================
  const pub = express.Router();
  h.public.use('/feedback', pub);
  pub.use(express.urlencoded({ extended: false, limit: '8kb' }));
  pub.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex');
    const q = String(req.query.lang || (req.body && req.body.lang) || '');
    req.lang = q === 'ar' || q === 'en' ? q : /^ar\b/i.test(String(req.get('accept-language') || '')) ? 'ar' : 'en';
    i18n.run(req.lang, next);
  });
  const postLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, handler: (req, res) => shell(req, res, { title: tr('fb|Thank you'), status: 429, body: `<section class="fb-card fb-done"><h1>${esc(tr('fb|Thank you'))}</h1><p>${esc(tr('fb|We have your feedback already. Please try again in a few minutes.'))}</p></section>` }) });
  function shell(req, res, { title, body, status = 200 }) {
    const other = req.lang === 'ar' ? 'en' : 'ar';
    const self = req.originalUrl.replace(/([?&])lang=(en|ar)(&|$)/, '$1').replace(/[?&]$/, '');
    res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="${req.lang}" dir="${req.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#283833">
<meta name="robots" content="noindex">
<title>${esc(title)} · The Wave</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ui.ASSETS.css}">
</head>
<body class="adm portal paypage fb-public" data-lang="${req.lang}">
<main class="paywrap fb-wrap">
  <header class="paywrap__head">${ui.logo('paywrap__logo')}<a class="langbtn" href="${esc(self)}${self.includes('?') ? '&' : '?'}lang=${other}" lang="${other}">${ui.icon('globe')}<span>${other === 'ar' ? 'العربية' : 'English'}</span></a></header>
  ${body}
  <p class="paywrap__foot">${ui.icon('chat')}<span>${esc(tr('fb|The Wave · North 90, New Cairo'))}</span></p>
</main>
</body>
</html>`);
  }
  const locBy = (code) => db.get('SELECT * FROM fb_locations WHERE code = ? AND active = 1', String(code || '').toLowerCase());
  const locName = (loc, lang) => (lang === 'ar' && loc.name_ar ? loc.name_ar : loc.name);
  function formPage(req, res, loc, { error = null, v = {}, status = 200 } = {}) {
    const ts = String(Date.now());
    const rate = Object.keys(RATE).reverse().map((n) => `<label class="fb-face fb-face--${n}"><input type="radio" name="rating" value="${n}" required${String(v.rating) === n ? ' checked' : ''}><span>${face(Number(n))}<b>${esc(tr(RATE[n]))}</b></span></label>`).join('');
    const cats = Object.keys(CATS).map((k) => `<label class="fb-chip"><input type="radio" name="category" value="${k}"${(v.category || '') === k ? ' checked' : ''}><span>${esc(tr(CATS[k]))}</span></label>`).join('');
    const body = `<section class="fb-card">
      <p class="fb-where">${ui.icon('store')}<span>${esc(locName(loc, req.lang))}${loc.floor ? ` · ${esc(loc.floor)}` : ''}</span></p>
      <h1>${esc(tr('fb|How was your visit?'))}</h1>
      <p class="muted">${esc(tr('fb|Tell us in a few seconds. Every message is read by the mall team.'))}</p>
      ${error ? `<p class="alert alert--warn">${esc(error)}</p>` : ''}
      <form method="post" action="/feedback/${esc(loc.code)}" class="fb-form" novalidate>
        <input type="hidden" name="lang" value="${req.lang}"><input type="hidden" name="ft" value="${ts}.${sign(`${loc.code}.${ts}`)}">
        <div class="fb-trap" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
        <fieldset class="fb-rate"><legend>${esc(tr('fb|Your rating'))}</legend><div class="fb-faces">${rate}</div></fieldset>
        <fieldset class="fb-cats"><legend>${esc(tr('fb|What is it about?'))}</legend><div class="fb-chips">${cats}</div></fieldset>
        <label class="f"><span class="f__l">${esc(tr('fb|Your comment'))}</span><textarea name="comment" rows="4" maxlength="1000" placeholder="${esc(tr('fb|What went well, or what should we fix?'))}">${esc(v.comment || '')}</textarea></label>
        <label class="f"><span class="f__l">${esc(tr('fb|Mobile number (optional)'))}</span><input type="tel" name="phone" inputmode="tel" autocomplete="tel" maxlength="20" value="${esc(v.phone || '')}" placeholder="01xxxxxxxxx" dir="ltr"><small>${esc(tr('fb|Only if you would like us to call you back.'))}</small></label>
        <button class="btn btn--primary fb-send" type="submit">${esc(tr('fb|Send'))}</button>
      </form></section>`;
    shell(req, res, { title: tr('fb|How was your visit?'), body, status });
  }
  pub.get('/:code', (req, res, next) => {
    const loc = locBy(req.params.code);
    if (!loc) return next();
    formPage(req, res, loc);
  });
  pub.post('/:code', postLimit, (req, res, next) => {
    const loc = locBy(req.params.code);
    if (!loc) return next();
    const b = req.body || {};
    const thanks = `/feedback/${loc.code}/thanks?lang=${req.lang}`;
    // the trap: people never fill it in
    if (h.str(b.website, 200)) return res.redirect(303, thanks);
    const v = { rating: h.int(b.rating), category: CATS[b.category] ? b.category : 'other', comment: h.str(b.comment, 1000) || null, phone: (h.str(b.phone, 24).replace(/[^\d+]/g, '') || null) };
    const [ts, mac] = String(b.ft || '').split('.');
    const age = (Date.now() - Number(ts)) / 1000;
    if (!ts || !mac || mac !== sign(`${loc.code}.${ts}`) || !(age >= MIN_SECONDS) || age > 6 * 3600) return formPage(req, res, loc, { error: tr('fb|Please try again.'), v, status: 400 });
    if (!(v.rating >= 1 && v.rating <= 5)) return formPage(req, res, loc, { error: tr('fb|Choose a rating first.'), v, status: 422 });
    if (v.phone && !/^\+?\d{8,15}$/.test(v.phone)) return formPage(req, res, loc, { error: tr('fb|Check the mobile number.'), v, status: 422 });
    const ip = crypto.createHash('sha256').update(`${secret()}|${req.ip}`).digest('hex').slice(0, 20);
    // repeats (a double tap, the back button) and floods from one phone are dropped quietly
    const dup = db.value('SELECT COUNT(*) FROM fb_entries WHERE ip_hash = ? AND location_id = ? AND rating = ? AND COALESCE(comment, \'\') = ? AND created_at > ?', ip, loc.id, v.rating, v.comment || '', new Date(Date.now() - 30 * 60000).toISOString());
    const today = db.value('SELECT COUNT(*) FROM fb_entries WHERE ip_hash = ? AND created_at > ?', ip, new Date(Date.now() - 86400000).toISOString());
    if (!dup && today < 20) submit(loc, { ...v, lang: req.lang, ip_hash: ip });
    res.redirect(303, thanks);
  });
  pub.get('/:code/thanks', (req, res, next) => {
    const loc = locBy(req.params.code);
    if (!loc) return next();
    shell(req, res, { title: tr('fb|Thank you'), body: `<section class="fb-card fb-done"><span class="fb-tick">${ui.icon('check')}</span><h1>${esc(tr('fb|Thank you'))}</h1><p>${esc(tr('fb|Your feedback reached the mall team.'))}</p><p class="muted">${esc(tr('fb|If you left your number, we will call you back.'))}</p></section>` });
  });

  // ================= the office =================
  const TABS = [['/admin/feedback', 'fb|Dashboard'], ['/admin/feedback/tickets', 'fb|Tickets'], ['/admin/feedback/locations', 'fb|Locations and posters']];
  const page = (req, res, { title, on, crumbs = [], body, actions = '' }) => h.page(req, res, {
    title, active: '/admin/feedback', wide: true, actions,
    crumbs: on === '/admin/feedback' && !crumbs.length ? undefined : [['/admin/feedback', tr('nav|Shopper feedback')], ...crumbs],
    body: `<nav class="tabs">${TABS.map(([href, label]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${esc(tr(label))}</a>`).join('')}</nav>${body}`,
  });
  const lname = (l) => (i18n.lang() === 'ar' && l.name_ar ? l.name_ar : l.name);
  const eloc = (e) => (i18n.lang() === 'ar' && e.loc_ar ? e.loc_ar : e.loc_name);
  const rateTxt = (n) => `<span class="fb-stars fb-stars--${n}">${face(n)}<b>${n}</b></span>`;
  const PERIODS = { 7: 'fb|Last 7 days', 30: 'fb|Last 30 days', 90: 'fb|Last 90 days', 365: 'fb|Last 12 months' };
  // the summary of a set of entries
  const sum = (rows) => {
    const n = rows.length;
    const avg = n ? rows.reduce((s, r) => s + r.rating, 0) / n : null;
    const pro = rows.filter((r) => r.rating === 5).length;
    const det = rows.filter((r) => r.rating <= 3).length;
    return { n, avg, nps: n ? Math.round(((pro - det) / n) * 100) : null };
  };
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const hoursTxt = (hrs) => (hrs === null ? '—' : hrs < 1 ? tr('fb|{n} min', { n: Math.max(1, Math.round(hrs * 60)) }) : hrs < 48 ? tr('fb|{n} h', { n: Math.round(hrs * 10) / 10 }) : tr('fb|{n} days', { n: Math.round(hrs / 24) }));
  const weekOf = (iso) => { const d = new Date(`${ui.local(iso).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

  router.get('/feedback', (req, res) => {
    const dd = PERIODS[req.query.days] ? Number(req.query.days) : 30;
    const since = new Date(Date.now() - dd * 86400000).toISOString();
    const rows = db.all('SELECT e.*, l.name loc_name, l.name_ar loc_ar FROM fb_entries e LEFT JOIN fb_locations l ON l.id = e.location_id WHERE e.created_at >= ?', since);
    const s = sum(rows);
    const responded = rows.filter((r) => r.first_action_at).map((r) => (Date.parse(r.first_action_at) - Date.parse(r.created_at)) / 3600000);
    const open = db.value("SELECT COUNT(*) FROM fb_entries WHERE status != 'resolved'");
    const kpis = [
      ui.kpi({ label: tr('fb|Average rating'), value: `${stars(s.avg)}<small>/5</small>`, bar: s.avg ? s.avg / 5 : null, sub: esc(tn(s.n, 'fb|{n} rating', 'fb|{n} ratings')) }),
      ui.kpi({ label: tr('fb|Recommend score'), value: s.nps === null ? '—' : `${s.nps > 0 ? '+' : ''}${s.nps}`, sub: esc(tr('fb|5s minus 1s to 3s, out of 100')), tone: s.nps !== null && s.nps < 0 ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('fb|Open tickets'), value: ui.n0(open), tone: db.value("SELECT COUNT(*) FROM fb_entries WHERE status = 'new'") ? 'kpi--alert' : '', href: '/admin/feedback/tickets' }),
      ui.kpi({ label: tr('fb|Response time (median)'), value: esc(hoursTxt(median(responded))), sub: esc(tr('fb|from the message to the first action')) }),
    ].join('');
    // average by week, the last 12 weeks
    const w0 = weekOf(new Date(Date.now() - 77 * 86400000).toISOString());
    const all12 = db.all('SELECT rating, created_at FROM fb_entries WHERE created_at >= ?', new Date(Date.parse(w0) - 86400000).toISOString());
    const weeks = Array.from({ length: 12 }, (_, i) => M.addDays(w0, i * 7)).map((w) => { const x = sum(all12.filter((r) => weekOf(r.created_at) === w)); return { label: ui.date(w).split(' ').slice(0, 2).join(' '), avg: x.avg || 0, n: x.n }; });
    // by location, worst first
    const locs = db.all('SELECT * FROM fb_locations ORDER BY name').map((l) => ({ l, ...sum(rows.filter((r) => r.location_id === l.id)), worst: (() => { const c = {}; for (const r of rows.filter((x) => x.location_id === l.id && x.rating <= 3)) c[r.category] = (c[r.category] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]; })() })).filter((x) => x.n);
    locs.sort((a, b) => a.avg - b.avg);
    const locTable = ui.table([
      { label: tr('fb|Location'), sort: (x) => x.l.name, render: (x) => `<b>${esc(lname(x.l))}</b><small class="sub">${esc([x.l.floor, x.worst ? tr('fb|most complaints: {what} ({n})', { what: tr(CATS[x.worst[0]]), n: x.worst[1] }) : null].filter(Boolean).join(' · '))}</small>` },
      { label: tr('fb|Ratings'), num: true, sort: (x) => x.n, render: (x) => ui.n0(x.n) },
      { label: tr('fb|Average'), num: true, sort: (x) => x.avg, render: (x) => `<b class="${x.avg < 3.5 ? 'late' : ''}">${stars(x.avg)}</b><span class="fb-bar"><i style="width:${Math.round((x.avg / 5) * 100)}%"></i></span>` },
      { label: tr('fb|Recommend score'), num: true, sort: (x) => x.nps, render: (x) => `${x.nps > 0 ? '+' : ''}${x.nps}` },
    ], locs, { href: (x) => `/admin/feedback/tickets?location=${x.l.id}&status=all`, empty: esc(tr('fb|No feedback in this period.')) });
    const cats = Object.keys(CATS).map((k) => ({ k, ...sum(rows.filter((r) => r.category === k)) })).filter((x) => x.n).sort((a, b) => b.n - a.n);
    const catList = cats.length ? `<ul class="list">${cats.map((c) => `<li><a href="/admin/feedback/tickets?category=${c.k}&status=all"><span class="what"><b>${esc(tr(CATS[c.k]))}</b><small>${esc(tn(c.n, 'fb|{n} rating', 'fb|{n} ratings'))}</small></span><b>${stars(c.avg)}</b></a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('fb|No feedback in this period.'))}</p>`;
    const dist = [5, 4, 3, 2, 1].map((n) => ({ n, c: rows.filter((r) => r.rating === n).length }));
    const distHtml = `<ul class="fb-dist">${dist.map((d) => `<li>${rateTxt(d.n)}<span class="fb-bar"><i style="width:${s.n ? Math.round((d.c / s.n) * 100) : 0}%"></i></span><b>${d.c}</b></li>`).join('')}</ul>`;
    const latest = db.all("SELECT e.*, l.name loc_name, l.name_ar loc_ar FROM fb_entries e LEFT JOIN fb_locations l ON l.id = e.location_id WHERE e.status = 'new' ORDER BY e.created_at DESC LIMIT 8");
    const latestList = latest.length ? `<ul class="list">${latest.map((e) => `<li><a href="/admin/feedback/${e.id}"><span class="what"><b>${esc(e.comment || tr(CATS[e.category]))}</b><small>${esc([e.ref, eloc(e), tr(CATS[e.category]), ui.dt(e.created_at)].filter(Boolean).join(' · '))}</small></span>${rateTxt(e.rating)}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('fb|No new tickets.'))}</p>`;
    const filters = `<nav class="sec-chips">${Object.entries(PERIODS).map(([k, v]) => `<a class="sec-chip${Number(k) === dd ? ' is-on' : ''}" href="/admin/feedback?days=${k}">${esc(tr(v))}</a>`).join('')}</nav>`;
    page(req, res, {
      title: tr('nav|Shopper feedback'), on: '/admin/feedback', actions: ui.btn(esc(tr('fb|Print the posters')), { href: '/admin/feedback/posters', cls: 'btn--ghost', ic: 'print' }),
      body: `${filters}<div class="kpis kpis--4">${kpis}</div><div class="grid grid--side"><div class="stack">${ui.card(tr('fb|Average rating by week'), ui.bars(weeks, { key: 'avg', label: 'label', h: 150, fmtv: (v) => (v ? stars(v) : '') }), { sub: esc(tr('fb|The last 12 weeks')) })}${ui.card(tr('fb|By location, worst first'), locTable)}</div><div class="stack">${ui.card(tr('fb|Ratings'), distHtml)}${ui.card(tr('fb|By subject'), catList)}${ui.card(tr('fb|New tickets'), latestList, { action: ui.btn(esc(tr('All')), { href: '/admin/feedback/tickets', cls: 'btn--ghost btn--sm' }) })}</div></div>`,
    });
  });

  router.get('/feedback/tickets', (req, res) => {
    const st = STATUS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'open';
    const loc = h.int(req.query.location);
    const cat = CATS[req.query.category] ? req.query.category : '';
    const rating = h.int(req.query.rating);
    const where = [st === 'all' ? '1 = 1' : st === 'open' ? "e.status != 'resolved'" : 'e.status = ?', ...(loc ? ['e.location_id = ?'] : []), ...(cat ? ['e.category = ?'] : []), ...(rating ? ['e.rating = ?'] : [])];
    const args = [...(['all', 'open'].includes(st) ? [] : [st]), ...(loc ? [loc] : []), ...(cat ? [cat] : []), ...(rating ? [rating] : [])];
    const rows = db.all(`SELECT e.*, l.name loc_name, l.name_ar loc_ar, u.name assignee FROM fb_entries e LEFT JOIN fb_locations l ON l.id = e.location_id LEFT JOIN users u ON u.id = e.assignee_id WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT 400`, ...args);
    const table = ui.table([
      { label: tr('fb|Rating'), sort: (e) => e.rating, render: (e) => rateTxt(e.rating) },
      { label: tr('fb|Feedback'), render: (e) => `<b dir="auto">${esc(e.comment || '—')}</b><small class="sub">${esc([e.ref, tr(CATS[e.category]), e.phone ? tr('fb|wants a call back') : null].filter(Boolean).join(' · '))}</small>` },
      { label: tr('fb|Location'), render: (e) => esc(eloc(e) || '—') },
      { label: tr('fb|Received'), sort: (e) => e.created_at, render: (e) => `${esc(ui.dt(e.created_at))}<small class="sub">${ui.rel(e.created_at)}</small>` },
      { label: tr('fb|Handled by'), render: (e) => esc(e.assignee || '—') },
      { label: tr('Status'), render: (e) => `${badge(e.status)}${e.routed_kind ? `<small class="sub">${esc(tr(e.routed_kind === 'cleaning' ? 'fb|sent to cleaning' : 'fb|work order opened'))}</small>` : ''}` },
    ], rows, { href: (e) => `/admin/feedback/${e.id}`, empty: esc(tr('fb|No tickets here.')) });
    const filters = `<form method="get" class="filters">${ui.select('status', tr('Status'), [['open', tr('fb|Not resolved')], ...Object.entries(STATUS).map(([k, v]) => [k, tr(v[0])]), ['all', tr('All')]], st)}${ui.select('location', tr('fb|Location'), db.all('SELECT id, name, name_ar FROM fb_locations ORDER BY name').map((l) => [l.id, lname(l)]), loc || '', { blank: tr('All') })}${ui.select('category', tr('fb|Subject'), tmap(CATS), cat, { blank: tr('All') })}${ui.select('rating', tr('fb|Rating'), [5, 4, 3, 2, 1].map((n) => [n, `${n} · ${tr(RATE[n])}`]), rating || '', { blank: tr('All') })}${ui.btn(esc(tr('fb|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    page(req, res, { title: tr('fb|Tickets'), on: '/admin/feedback/tickets', crumbs: [[null, tr('fb|Tickets')]], body: `${filters}${ui.card(tn(rows.length, 'fb|{n} ticket', 'fb|{n} tickets'), table)}` });
  });

  // ---------- locations and posters ----------
  const posterHtml = (req, l) => `<article class="fb-poster"><header>${ui.logo('fb-poster__logo')}</header><h1><span lang="ar" dir="rtl">${POSTER.ar[0]}</span><span lang="en">${POSTER.en[0]}</span></h1>
    <div class="fb-poster__qr">${QR.svg(`${site(req)}/feedback/${l.code}`, { ecl: 'M', cls: 'qr' })}</div>
    <p class="fb-poster__how"><span lang="ar" dir="rtl">${POSTER.ar[1]}</span><span lang="en">${POSTER.en[1]}</span></p>
    <footer><b>${esc(l.name_ar || '')}</b><b>${esc(l.name)}</b><code class="ltr">${esc(site(req).replace(/^https?:\/\//, ''))}/feedback/${esc(l.code)}</code></footer></article>`;
  const posters = (req, res, list) => res.type('html').send(ui.bare({ title: tr('fb|Feedback posters'), cls: 'fb-print', body: `<div class="sec-printbar noprint"><button class="btn btn--primary" type="button" data-print>${ui.icon('print')}<span>${esc(tr('fb|Print'))}</span></button></div>${list.map((l) => posterHtml(req, l)).join('') || `<p>${esc(tr('Nothing here yet.'))}</p>`}` }));
  router.get('/feedback/posters', (req, res) => posters(req, res, db.all('SELECT * FROM fb_locations WHERE active = 1 ORDER BY name')));
  router.get('/feedback/locations/:id/poster', (req, res, next) => {
    const l = db.get('SELECT * FROM fb_locations WHERE id = ?', h.int(req.params.id));
    if (!l) return next();
    posters(req, res, [l]);
  });
  const areas = () => (h.security ? db.all('SELECT id, code, name FROM sec_clean_areas WHERE active = 1 ORDER BY sort, name') : []);
  router.get('/feedback/locations', (req, res) => {
    const csrf = req.session.csrf;
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const list = db.all('SELECT * FROM fb_locations ORDER BY active DESC, name');
    const areaOpts = areas().map((a) => [a.id, `${a.code} · ${a.name}`]);
    const table = ui.table([
      { label: tr('fb|Location'), sort: (l) => l.name, render: (l) => `<b>${esc(l.name)}</b><small class="sub">${esc([l.name_ar, l.floor].filter(Boolean).join(' · '))}</small>` },
      { label: tr('fb|Link'), render: (l) => `<a class="ltr" href="/feedback/${esc(l.code)}" target="_blank" rel="noopener"><code>/feedback/${esc(l.code)}</code></a>` },
      { label: tr('fb|Cleaning area'), render: (l) => esc((areas().find((a) => a.id === l.area_id) || {}).name || '—') },
      { label: tr('fb|Last 30 days'), num: true, render: (l) => { const x = sum(db.all('SELECT rating FROM fb_entries WHERE location_id = ? AND created_at >= ?', l.id, since)); return x.n ? `${stars(x.avg)} <small class="muted">(${x.n})</small>` : '—'; } },
      { label: '', render: (l) => `<a class="btn btn--ghost btn--sm" href="/admin/feedback/locations/${l.id}/poster">${ui.icon('print')}<span>${esc(tr('fb|Poster'))}</span></a>${h.can(req, 'manager') ? `<details class="pop-inline"><summary class="btn btn--ghost btn--sm">${esc(tr('Edit'))}</summary>${ui.form(`/admin/feedback/locations/${l.id}`, csrf, `<div class="fields">${ui.input('name', tr('fb|Name'), l.name, { required: true })}${ui.input('name_ar', tr('fb|Name in Arabic'), l.name_ar || '', { attrs: { dir: 'rtl' } })}${ui.input('floor', tr('fb|Floor'), l.floor || '')}${areaOpts.length ? ui.select('area_id', tr('fb|Cleaning area'), areaOpts, l.area_id || '', { blank: tr('fb|None') }) : ''}</div><label class="check"><input type="checkbox" name="active" value="1"${l.active ? ' checked' : ''}> ${esc(tr('fb|In use'))}</label>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}` },
    ], list, { empty: esc(tr('fb|No locations yet.')) });
    const add = h.can(req, 'manager') ? ui.form('/admin/feedback/locations', csrf, `<div class="fields">${ui.input('name', tr('fb|Name'), '', { required: true, placeholder: tr('fb|e.g. Food court') })}${ui.input('name_ar', tr('fb|Name in Arabic'), '', { attrs: { dir: 'rtl' } })}${ui.input('code', tr('fb|Short code for the link'), '', { placeholder: 'food-court', hint: tr('fb|Small letters, numbers and dashes.') })}${ui.input('floor', tr('fb|Floor'), '')}${areaOpts.length ? ui.select('area_id', tr('fb|Cleaning area'), areaOpts, '', { blank: tr('fb|None') }) : ''}</div><p class="muted small">${esc(tr('fb|A low rating about cleanliness from this poster raises a cleaning alert on the area.'))}</p>${ui.btn(esc(tr('fb|Add location')), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' }) : '';
    page(req, res, { title: tr('fb|Locations and posters'), on: '/admin/feedback/locations', crumbs: [[null, tr('fb|Locations and posters')]], actions: ui.btn(esc(tr('fb|Print the posters')), { href: '/admin/feedback/posters', cls: 'btn--ghost', ic: 'print' }), body: `<div class="grid grid--side"><div>${ui.card(tr('fb|Locations'), table, { sub: esc(tr('fb|Put a poster at each place. Shoppers scan it; no app or sign-in needed.')) })}</div><div>${add ? ui.card(tr('fb|Add location'), add) : ''}</div></div>` });
  });
  const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40);
  router.post('/feedback/locations', R('manager'), (req, res) => {
    const name = h.str(req.body.name, 120);
    let code = slug(req.body.code || name);
    if (!name) return h.back(req, res, '/admin/feedback/locations', 'error', tr('fb|Enter the name.'));
    if (!code) code = `place-${db.value('SELECT COUNT(*) FROM fb_locations') + 1}`;
    if (db.get('SELECT id FROM fb_locations WHERE code = ?', code)) return h.back(req, res, '/admin/feedback/locations', 'error', tr('fb|The code {code} is already used.', { code }));
    const area = h.int(req.body.area_id);
    const id = Number(db.run('INSERT INTO fb_locations (code, name, name_ar, floor, area_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', code, name, h.str(req.body.name_ar, 120) || null, h.str(req.body.floor, 60) || null, area && areas().some((a) => a.id === area) ? area : null, now()).lastInsertRowid);
    h.log(req, 'Added a feedback location', 'fb_location', id, name);
    h.back(req, res, '/admin/feedback/locations', 'ok', tr('fb|Added. Print its poster.'));
  });
  router.post('/feedback/locations/:id', R('manager'), (req, res, next) => {
    const l = db.get('SELECT * FROM fb_locations WHERE id = ?', h.int(req.params.id));
    if (!l) return next();
    const name = h.str(req.body.name, 120);
    if (!name) return h.back(req, res, '/admin/feedback/locations', 'error', tr('fb|Enter the name.'));
    const area = h.int(req.body.area_id);
    db.run('UPDATE fb_locations SET name = ?, name_ar = ?, floor = ?, area_id = ?, active = ? WHERE id = ?', name, h.str(req.body.name_ar, 120) || null, h.str(req.body.floor, 60) || null, area && areas().some((a) => a.id === area) ? area : null, req.body.active ? 1 : 0, l.id);
    h.log(req, 'Changed a feedback location', 'fb_location', l.id, name);
    h.back(req, res, '/admin/feedback/locations', 'ok', tr('Saved.'));
  });

  // ---------- one ticket ----------
  const EV = { status: 'fb|Status: {status}', assigned: 'fb|Given to {name}', reply: 'fb|Reply', note: 'fb|Note', routed_cleaning: 'fb|Sent to cleaning as an alert', routed_maintenance: 'fb|Work order {ref} opened' };
  router.get('/feedback/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const e = db.get('SELECT e.*, l.name loc_name, l.name_ar loc_ar, l.floor, l.id loc_id FROM fb_entries e LEFT JOIN fb_locations l ON l.id = e.location_id WHERE e.id = ?', h.int(req.params.id));
    if (!e) return next();
    const events = db.all('SELECT v.*, u.name user_name FROM fb_events v LEFT JOIN users u ON u.id = v.user_id WHERE v.entry_id = ? ORDER BY v.at, v.id', e.id);
    const routed = e.routed_kind === 'maintenance' ? db.get('SELECT id, ref, status FROM work_orders WHERE id = ?', e.routed_id) : null;
    const facts = `<div class="fb-quote">${rateTxt(e.rating)}<div><p class="fb-comment" dir="auto">${esc(e.comment || tr('fb|No comment.'))}</p><small class="muted">${esc([tr(RATE[e.rating]), tr(CATS[e.category]), e.lang === 'ar' ? 'العربية' : 'English'].join(' · '))}</small></div></div>
      <dl class="dl"><div><dt>${esc(tr('fb|Location'))}</dt><dd>${e.loc_id ? `<a href="/admin/feedback/tickets?location=${e.loc_id}&status=all">${esc(eloc(e))}</a>${e.floor ? ` · ${esc(e.floor)}` : ''}` : '—'}</dd></div><div><dt>${esc(tr('fb|Received'))}</dt><dd>${esc(ui.dt(e.created_at))}</dd></div>
      <div><dt>${esc(tr('fb|Mobile'))}</dt><dd>${e.phone ? `<a class="ltr" href="tel:${esc(e.phone)}">${esc(e.phone)}</a>` : esc(tr('fb|Not given'))}</dd></div>
      ${e.routed_kind === 'cleaning' ? `<div><dt>${esc(tr('fb|Sent to'))}</dt><dd><a href="/admin/security/cleaning">${esc(tr('fb|Cleaning, as an alert'))}</a></dd></div>` : ''}
      ${routed ? `<div><dt>${esc(tr('fb|Sent to'))}</dt><dd><a href="/admin/maintenance/orders/${routed.id}">${esc(tr('fb|Work order {ref}', { ref: routed.ref }))}</a></dd></div>` : ''}
      ${e.first_action_at ? `<div><dt>${esc(tr('fb|First action'))}</dt><dd>${esc(hoursTxt((Date.parse(e.first_action_at) - Date.parse(e.created_at)) / 3600000))}</dd></div>` : ''}</dl>`;
    const timeline = `<ol class="tl"><li><span class="tl__ic">${ui.icon('chat')}</span><div><p><b>${esc(tr('fb|Received'))}</b></p><small class="muted">${esc(ui.dt(e.created_at))}</small></div></li>${events.map((v) => `<li><span class="tl__ic">${ui.icon(v.kind === 'reply' ? 'mail' : v.kind.startsWith('routed') ? 'flow' : 'check')}</span><div><p><b>${esc(tr(EV[v.kind] || 'fb|Note', { status: v.kind === 'status' && STATUS[v.body] ? tr(STATUS[v.body][0]) : '', name: v.body || '', ref: v.body || '' }))}</b>${['reply', 'note'].includes(v.kind) && v.body ? `<br>${esc(v.body)}` : ''}</p><small class="muted">${esc([ui.dt(v.at), v.user_name].filter(Boolean).join(' · '))}</small></div></li>`).join('')}</ol>`;
    const form = h.can(req, 'agent') ? ui.form(`/admin/feedback/${e.id}`, req.session.csrf, `<div class="fields">${ui.select('status', tr('Status'), Object.entries(STATUS).map(([k, v]) => [k, tr(v[0])]), e.status)}${ui.select('assignee_id', tr('fb|Handled by'), h.users().map((u) => [u.id, u.name]), e.assignee_id || '', { blank: tr('fb|Nobody yet') })}</div>${ui.textarea('reply', tr('fb|Reply to the shopper (what was done)'), e.reply || '', { rows: 3 })}${ui.textarea('note', tr('fb|Internal note'), '', { rows: 2 })}${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    page(req, res, { title: e.ref, on: '/admin/feedback/tickets', crumbs: [['/admin/feedback/tickets', tr('fb|Tickets')], [null, e.ref]], body: `<div class="grid grid--side"><div class="stack">${ui.card(e.ref, facts, { action: badge(e.status) })}${ui.card(tr('fb|History'), timeline)}</div><div class="stack">${form ? ui.card(tr('fb|Handle'), form) : ''}</div></div>` });
  });
  router.post('/feedback/:id', R('agent'), (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const e = db.get('SELECT * FROM fb_entries WHERE id = ?', h.int(req.params.id));
    if (!e) return next();
    const status = STATUS[req.body.status] ? req.body.status : e.status;
    const assignee = h.int(req.body.assignee_id) || null;
    const reply = h.str(req.body.reply, 2000) || null;
    const note = h.str(req.body.note, 2000) || null;
    const t = now();
    db.tx(() => {
      const acted = status !== e.status || assignee !== e.assignee_id || (reply && reply !== e.reply) || note;
      db.run(`UPDATE fb_entries SET status = ?, assignee_id = ?, reply = ?, first_action_at = CASE WHEN ? THEN COALESCE(first_action_at, ?) ELSE first_action_at END,
        resolved_at = CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?`, status, assignee, reply, acted ? 1 : 0, t, status, t, t, e.id);
      if (status !== e.status) event(e.id, 'status', status, req.user, t);
      if (assignee && assignee !== e.assignee_id) event(e.id, 'assigned', db.value('SELECT name FROM users WHERE id = ?', assignee), req.user, t);
      if (reply && reply !== e.reply) event(e.id, 'reply', reply, req.user, t);
      if (note) event(e.id, 'note', note, req.user, t);
    });
    h.log(req, 'Handled shopper feedback', 'fb_entry', e.id, `${e.ref} · ${status}`);
    h.back(req, res, `/admin/feedback/${e.id}`, 'ok', tr('Saved.'));
  });
};

module.exports.SCHEMA = SCHEMA;
module.exports.CATS = CATS;
module.exports.RATE = RATE;
