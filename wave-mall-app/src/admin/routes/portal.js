'use strict';

// The tenant portal at /portal: each brand trading in The Wave signs in to see its invoices and
// receipts, pay online, keep its compliance documents up to date and read the mall's notices.
// Separate accounts (portal_users), sessions (cookie on /portal only) and CSRF from the office.
//
// Other modules add their own tabs and pages (they load after this one):
//   h.portal.tab({ key, href, label, icon, order, badge(req) })   label is an English i18n key
//   h.portal.router.get('/sales', h.portal.requireTenant, (req, res) => h.portal.page(req, res, { title, body, active: 'sales' }))
//   req.tenant = { id, brand_id, name, email, lang, … }, req.brand = the brand row, h.portal.brandId(req)
// Staff manage accounts and notices at /admin/portal.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const { hashPassword, verifyPassword } = require('../db');
const tenancy = require('../tenancy');

const { t: tr, tn, tx } = i18n;

const SCHEMA = `
  CREATE TABLE portal_users (
    id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, phone TEXT, password_hash TEXT, lang TEXT,
    active INTEGER NOT NULL DEFAULT 1, invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_login_at TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX portal_users_brand ON portal_users(brand_id);
  CREATE TABLE portal_sessions (
    id TEXT PRIMARY KEY, portal_user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT, agent TEXT
  );
  CREATE TABLE portal_tokens (
    id TEXT PRIMARY KEY, portal_user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL, reveal TEXT, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE portal_notices (
    id INTEGER PRIMARY KEY, title_en TEXT NOT NULL, title_ar TEXT, body_en TEXT NOT NULL, body_ar TEXT,
    audience TEXT NOT NULL DEFAULT 'all', brand_ids TEXT, status TEXT NOT NULL DEFAULT 'draft',
    publish_at TEXT, expire_at TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE portal_notice_reads (
    notice_id INTEGER NOT NULL REFERENCES portal_notices(id) ON DELETE CASCADE,
    portal_user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL, PRIMARY KEY (notice_id, portal_user_id)
  );
  ALTER TABLE documents ADD COLUMN portal_user_id INTEGER REFERENCES portal_users(id) ON DELETE SET NULL;
`;

const COOKIE = 'wv_tenant';
const FLASH = 'wv_pflash';
const LANG = 'wv_plang';
const TTL = 12 * 60 * 60 * 1000;
const INVITE_DAYS = 7;
const RESET_HOURS = 2;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const now = () => new Date().toISOString();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;


module.exports = function portal(router, h) {
  const { db, ui, M } = h;
  db.ensure('portal-1', SCHEMA);
  const { ASSETS } = ui;

  // ---------- cookies ----------
  function cookies(req) {
    return h.auth.cookies(req);
  }
  function setCookie(req, res, name, value, { maxAge, pathName = '/portal' } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${pathName}`, 'SameSite=Lax', 'HttpOnly'];
    if (req.secure) parts.push('Secure');
    if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
  }
  const flash = (req, res, type, text) => setCookie(req, res, FLASH, JSON.stringify({ type, text: String(text).slice(0, 300) }), { maxAge: 60000 });
  function takeFlash(req, res) {
    const raw = cookies(req)[FLASH];
    if (!raw) return null;
    setCookie(req, res, FLASH, '', { maxAge: 0 });
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const back = (req, res, url, type, text) => {
    if (text) flash(req, res, type, text);
    res.redirect(303, url);
  };

  // ---------- sessions ----------
  function startSession(req, res, u) {
    const t = token();
    db.run('INSERT INTO portal_sessions (id, portal_user_id, csrf, created_at, expires_at, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha(t), u.id, token(24), now(), new Date(Date.now() + TTL).toISOString(), req.ip, String(req.get('user-agent') || '').slice(0, 200));
    db.run('UPDATE portal_users SET last_login_at = ? WHERE id = ?', now(), u.id);
    db.run('DELETE FROM portal_sessions WHERE expires_at < ?', now());
    setCookie(req, res, COOKIE, t, { maxAge: TTL });
  }
  function endSession(req, res) {
    const t = cookies(req)[COOKIE];
    if (t) db.run('DELETE FROM portal_sessions WHERE id = ?', sha(t));
    setCookie(req, res, COOKIE, '', { maxAge: 0 });
  }
  function load(req, res, next) {
    const t = cookies(req)[COOKIE];
    if (t) {
      const s = db.get('SELECT * FROM portal_sessions WHERE id = ?', sha(t));
      if (s && s.expires_at > now()) {
        const u = db.get('SELECT * FROM portal_users WHERE id = ?', s.portal_user_id);
        const b = u && db.get('SELECT * FROM brands WHERE id = ?', u.brand_id);
        if (u && u.active && b) {
          req.tenant = u;
          req.brand = b;
          req.psession = s;
          if (Date.parse(s.expires_at) - Date.now() < TTL - 60000) {
            db.run('UPDATE portal_sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() + TTL).toISOString(), s.id);
            setCookie(req, res, COOKIE, t, { maxAge: TTL });
          }
        }
      }
    }
    next();
  }
  // the portal language: ?lang= (remembered), the tenant's choice, the cookie, the browser
  function language(req, res, next) {
    const q = String(req.query.lang || '');
    let l = null;
    if (req.method === 'GET' && (q === 'en' || q === 'ar')) {
      l = q;
      setCookie(req, res, LANG, q, { maxAge: 365 * 86400000 });
      if (req.tenant && req.tenant.lang !== q) db.run('UPDATE portal_users SET lang = ? WHERE id = ?', q, req.tenant.id);
    }
    l = l || (req.tenant && req.tenant.lang) || cookies(req)[LANG] || (/^ar\b/i.test(String(req.get('accept-language') || '')) ? 'ar' : 'en');
    req.lang = l === 'ar' ? 'ar' : 'en';
    i18n.run(req.lang, next);
  }
  function requireTenant(req, res, next) {
    if (!req.tenant) {
      if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.redirect(303, `/portal/login?next=${encodeURIComponent(req.originalUrl)}`);
      return res.status(401).json({ ok: false, error: tr('Please sign in again.') });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const sent = String((req.body && req.body._csrf) || req.get('x-csrf') || '');
      const want = req.psession.csrf;
      if (!(sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want)))) {
        if (req.accepts(['html', 'json']) === 'json' && !req.is('urlencoded')) return res.status(403).json({ ok: false, error: tr('This page has expired. Reload it and try again.') });
        return res.status(403).type('text').send(tr('This form has expired. Go back, reload the page and try again.'));
      }
    }
    return next();
  }
  // the sign-in form's double-submit token (before a session exists)
  function formToken(req, res) {
    const t = token(18);
    setCookie(req, res, 'wv_plogin', t, { maxAge: 30 * 60 * 1000 });
    return t;
  }
  function checkFormToken(req) {
    const a = String(cookies(req).wv_plogin || '');
    const b = String((req.body && req.body._token) || '');
    return a.length > 10 && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  // ---------- tokens (invite, reset) ----------
  function issueToken(userId, purpose, { reveal = false } = {}) {
    const t = token();
    const ms = purpose === 'invite' ? INVITE_DAYS * 86400000 : RESET_HOURS * 3600000;
    db.run('UPDATE portal_tokens SET used_at = ? WHERE portal_user_id = ? AND purpose = ? AND used_at IS NULL', now(), userId, purpose);
    db.run('INSERT INTO portal_tokens (id, portal_user_id, purpose, reveal, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      sha(t), userId, purpose, reveal ? t : null, new Date(Date.now() + ms).toISOString(), now());
    return t;
  }
  const tokenRow = (t, purpose) => {
    const r = db.get('SELECT * FROM portal_tokens WHERE id = ? AND purpose = ?', sha(t), purpose);
    return r && !r.used_at && r.expires_at > now() ? r : null;
  };
  const siteUrl = (req) => (h.env && h.env.SITE_URL) || `${req.protocol}://${req.get('host')}`;
  const link = (req, t, purpose) => `${siteUrl(req)}/portal/${purpose === 'invite' ? 'welcome' : 'reset'}/${t}`;

  // Sends an email if the messaging module is there; returns true when sent.
  async function mail(to, subject, text, html) {
    // with no mail server set up, messages would only wait in the outbox: show the link instead
    if (!h.mail || typeof h.mail.send !== 'function' || (typeof h.mail.configured === 'function' && !h.mail.configured())) return false;
    try {
      const r = await h.mail.send({ to, subject, text, html });
      return r !== false && !(r && r.ok === false);
    } catch (err) {
      console.error('[portal] email failed:', err.message);
      return false;
    }
  }

  // ---------- the shell ----------
  const tabs = [];
  function tab(def) {
    const i = tabs.findIndex((x) => x.key === def.key);
    if (i >= 0) tabs.splice(i, 1);
    tabs.push({ order: 50, icon: 'file', ...def });
    tabs.sort((a, b) => a.order - b.order);
  }
  function head(title) {
    return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#283833">
<title>${ui.esc(title)} · ${ui.esc(tr('por|The Wave Tenant Portal'))}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ASSETS.css}">
${ui.pwaHead ? ui.pwaHead('portal') : ''}`;
  }
  const langSwitch = (req) => {
    const other = req.lang === 'ar' ? 'en' : 'ar';
    const p = req.originalUrl.replace(/([?&])lang=(en|ar)(&|$)/, '$1').replace(/[?&]$/, '');
    return `<a class="langbtn" href="${ui.esc(p)}${p.includes('?') ? '&' : '?'}lang=${other}" lang="${other}">${ui.icon('globe')}<span>${other === 'ar' ? 'العربية' : 'English'}</span></a>`;
  };
  function page(req, res, { title, body, active = '', actions = '', crumbs = [] }) {
    ui.setCurrency(db.setting('currency'));
    const f = takeFlash(req, res);
    const visible = tabs.filter((x) => !x.show || x.show(req));
    const badge = (x) => {
      try {
        const n = x.badge ? x.badge(req) : 0;
        return n ? `<b class="nav__count">${n}</b>` : '';
      } catch {
        return '';
      }
    };
    const nav = visible.map((x) => `<a href="${x.href}" class="nav__a${x.key === active ? ' is-on' : ''}"${x.key === active ? ' aria-current="page"' : ''}>${ui.icon(x.icon)}<span>${ui.esc(tr(x.label))}</span>${badge(x)}</a>`).join('');
    // phones: the first four tabs in a bottom bar, the rest in the "More" sheet (the office app's
    // tab bar and sheet, routes/mobile.js and admin.css)
    const count = (x) => {
      try {
        const n = x.badge ? x.badge(req) : 0;
        return n ? `<b class="tabbar__count">${n > 99 ? '99+' : n}</b>` : '';
      } catch {
        return '';
      }
    };
    const main = visible.filter((x) => x.mobile !== false).slice(0, 4);
    const rest = visible.filter((x) => !main.includes(x));
    const restOn = rest.some((x) => x.key === active);
    const tabbar = `<nav class="tabbar" aria-label="${ui.esc(tr('por|Tenant portal'))}">${main.map((x) => `<a href="${x.href}" class="tabbar__a${x.key === active ? ' is-on' : ''}"${x.key === active ? ' aria-current="page"' : ''}>${ui.icon(x.icon)}<span>${ui.esc(tr(x.label))}</span>${count(x)}</a>`).join('')}<a href="#more" class="tabbar__a${restOn ? ' is-on' : ''}" data-more-open aria-controls="more">${ui.icon('more')}<span>${ui.esc(tr('por|More'))}</span></a></nav>
<div class="sheet more" id="more" data-more role="dialog" aria-modal="true" aria-label="${ui.esc(tr('Menu'))}">
  <a class="sheet__scrim" href="#close" data-more-close aria-label="${ui.esc(tr('mob|Close'))}"></a>
  <div class="sheet__panel" data-sheet-panel>
    <span class="sheet__grip" aria-hidden="true"></span>
    <header class="more__me">
      <a class="avatar" href="/portal/account">${ui.esc(ui.initials(req.tenant.name))}</a>
      <a class="more__who" href="/portal/account"><b>${ui.esc(req.tenant.name)}</b><small>${ui.esc(req.brand.name)}</small></a>
      <a class="iconbtn more__x" href="#close" data-more-close aria-label="${ui.esc(tr('mob|Close'))}">${ui.icon('x')}</a>
    </header>
    <div class="more__nav"><section class="more__group"><div class="more__grid">${visible.map((x) => `<a href="${x.href}" class="more__a${x.key === active ? ' is-on' : ''}">${ui.icon(x.icon)}<span>${ui.esc(tr(x.label))}</span>${badge(x)}</a>`).join('')}</div></section></div>
    <footer class="more__foot">${langSwitch(req)}<form method="post" action="/portal/logout"><input type="hidden" name="_csrf" value="${ui.esc(req.psession.csrf)}"><button type="submit" class="btn btn--ghost btn--block">${ui.icon('out')}<span>${ui.esc(tr('Sign out'))}</span></button></form></footer>
  </div>
</div>`;
    const crumb = crumbs.length ? `<p class="crumbs">${crumbs.map(([hr, l]) => (hr ? `<a href="${hr}">${ui.esc(l)}</a>` : `<span>${ui.esc(l)}</span>`)).join('<i>/</i>')}</p>` : '';
    const toast = f ? `<div class="toast toast--${ui.esc(f.type || 'ok')}" role="status" data-toast>${ui.icon(f.type === 'error' ? 'log' : 'check')}<span>${ui.esc(f.text)}</span></div>` : '';
    const html = `<!doctype html>
<html lang="${req.lang}" dir="${req.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
${head(title)}
<meta name="csrf" content="${ui.esc(req.psession.csrf)}">
</head>
<body class="adm portal has-tabbar" data-lang="${req.lang}">
<aside class="side" id="side" data-side>
  <a class="side__brand" href="/portal">${ui.logo()}<span>${ui.esc(tr('por|Tenant portal'))}</span></a>
  <div class="pbrand"><span class="avatar">${ui.esc(ui.initials(req.brand.name))}</span><div><b>${ui.esc(req.brand.name)}</b><small>${ui.esc(req.tenant.name)}</small></div></div>
  <nav class="nav" aria-label="${ui.esc(tr('por|Tenant portal'))}"><div class="nav__group">${nav}</div></nav>
  <div class="side__me">
    <a class="avatar" href="/portal/account" title="${ui.esc(tr('Your account'))}">${ui.esc(ui.initials(req.tenant.name))}</a>
    <div><b>${ui.esc(req.tenant.name)}</b><small>${ui.esc(req.tenant.email)}</small></div>
    <form method="post" action="/portal/logout"><input type="hidden" name="_csrf" value="${ui.esc(req.psession.csrf)}"><button type="submit" class="iconbtn" title="${ui.esc(tr('Sign out'))}" aria-label="${ui.esc(tr('Sign out'))}">${ui.icon('out')}</button></form>
  </div>
</aside>
<div class="main">
  <header class="bar">
    <a class="pbar__logo" href="/portal" aria-label="The Wave">${ui.logo()}</a>
    <div class="bar__title">${crumb}<h1>${ui.esc(title)}</h1></div>
    ${langSwitch(req)}
    <div class="bar__actions">${actions}</div>
  </header>
  ${toast}
  <main class="content" id="content">${body}</main>
</div>
${tabbar}
<script src="/admin/admin.js?v=${ASSETS.js}" defer></script>
</body>
</html>`;
    res.set('Cache-Control', 'no-store').type('html').send(html);
  }
  // sign-in, welcome and reset pages: no navigation
  function barePage(req, res, { title, body, status = 200 }) {
    res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="${req.lang}" dir="${req.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
${head(title)}
</head>
<body class="adm portal signin" data-lang="${req.lang}">${body}<script src="/admin/admin.js?v=${ASSETS.js}" defer></script></body>
</html>`);
  }
  function authPage(req, res, { title, intro = '', form, error = '', status = 200 }) {
    barePage(req, res, {
      title, status,
      body: `<main class="signin__wrap">
  <section class="signin__art">${ui.logo('signin__logo')}<p class="signin__line">${ui.esc(tr('por|Everything your store needs from the mall, in one place.'))}</p><p class="signin__foot">${ui.esc(tr('por|Tenant portal · North 90'))}</p></section>
  <section class="signin__form">
    <div class="signin__lang">${langSwitch(req)}</div>
    <p class="eyebrow">${ui.esc(tr('por|Tenant portal'))}</p>
    <h1>${ui.esc(title)}</h1>
    ${intro ? `<p class="muted">${intro}</p>` : ''}
    ${error ? `<p class="alert alert--error">${ui.esc(error)}</p>` : ''}
    ${form}
  </section>
</main>`,
    });
  }

  // ---------- data helpers ----------
  const T = () => M.today();
  const brandId = (req) => req.tenant && req.tenant.brand_id;
  const invoicesOf = (bid) => db.all("SELECT * FROM invoices WHERE brand_id = ? AND status != 'void' ORDER BY due_date, id", bid);
  const invoiceFor = (req, id) => db.get("SELECT i.*, s.ref lease_ref FROM invoices i LEFT JOIN leases s ON s.id = i.lease_id WHERE i.id = ? AND i.brand_id = ? AND i.status != 'void'", h.int(id), brandId(req));
  const outstanding = (bid) => db.value("SELECT COALESCE(SUM(total - paid), 0) FROM invoices WHERE brand_id = ? AND status IN ('open','partial') AND due_date <= ?", bid, T());
  const overdue = (bid) => db.value("SELECT COALESCE(SUM(total - paid), 0) FROM invoices WHERE brand_id = ? AND status IN ('open','partial') AND due_date < ?", bid, T());
  const invoiceFor_ = (i) => (i.kind === 'rent' && i.period_start ? tr('Rent and service, {start} – {end}', { start: ui.date(i.period_start), end: ui.date(i.period_end) }) : tx(i.note) || M.INVOICE_KINDS[i.kind] || i.kind);
  const statusBadge = (i) => (['open', 'partial'].includes(i.status) && i.due_date < T() ? ui.badge('overdue', tr('invoice|Overdue')) : ui.badge(i.status, M.INVOICE_STATUS[i.status]));
  // notices this tenant may read
  function noticesFor(req, { limit = 50 } = {}) {
    const t = now();
    return db.all(
      `SELECT n.*, (SELECT read_at FROM portal_notice_reads r WHERE r.notice_id = n.id AND r.portal_user_id = ?) read_at FROM portal_notices n
       WHERE n.status = 'published' AND (n.publish_at IS NULL OR n.publish_at <= ?) AND (n.expire_at IS NULL OR n.expire_at > ?)
         AND (n.audience = 'all' OR (',' || COALESCE(n.brand_ids, '') || ',') LIKE ?)
       ORDER BY COALESCE(n.publish_at, n.created_at) DESC LIMIT ?`,
      req.tenant.id, t, t, `%,${req.tenant.brand_id},%`, limit,
    );
  }
  const noticeTitle = (n) => (i18n.isAr() && n.title_ar ? n.title_ar : n.title_en);
  const noticeBody = (n) => (i18n.isAr() && n.body_ar ? n.body_ar : n.body_en);
  const paragraphs = (s) => String(s || '').split(/\n{2,}/).map((p) => `<p>${ui.esc(p).replace(/\n/g, '<br>')}</p>`).join('');

  // ---------- the routers ----------
  const pr = express.Router();     // /portal
  const ext = express.Router();    // routes other modules add (h.portal.router)
  h.public.use('/portal', pr);
  pr.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  pr.use(express.urlencoded({ extended: false, limit: '64kb' }));
  pr.use(express.json({ limit: '32kb' }));
  pr.use(load);
  pr.use(language);

  const signinLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
  const safeNext = (n) => (typeof n === 'string' && /^\/portal(\/|$|\?)/.test(n) && !n.startsWith('//') ? n : '/portal');

  // sign in
  const loginForm = (req, res, { email = '', next = '/portal' } = {}) => `<form method="post" action="/portal/login" class="stack">
      <input type="hidden" name="_token" value="${ui.esc(formToken(req, res))}"><input type="hidden" name="next" value="${ui.esc(next)}">
      ${ui.input('email', tr('Email'), email, { type: 'email', required: true, attrs: { autocomplete: 'username', autofocus: true } })}
      ${ui.input('password', tr('Password'), '', { type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}
      ${ui.btn(tr('Sign in'), { cls: 'btn--primary btn--block', ic: 'arrow' })}
      <p class="small"><a href="/portal/forgot">${ui.esc(tr('por|Forgot your password?'))}</a></p>
    </form>`;
  pr.get('/login', (req, res) => {
    if (req.tenant) return res.redirect(303, safeNext(req.query.next));
    authPage(req, res, { title: tr('Sign in'), intro: ui.esc(tr('por|Invoices, receipts, documents and notices for your store at The Wave.')), form: loginForm(req, res, { next: safeNext(req.query.next) }) });
  });
  pr.post('/login', signinLimit, (req, res) => {
    const email = h.str(req.body.email, 200);
    const next = safeNext(req.body.next);
    const fail = (msg, status) => authPage(req, res, { title: tr('Sign in'), status, error: msg, form: loginForm(req, res, { email, next }) });
    if (!checkFormToken(req)) return fail(tr('The form expired. Please try again.'), 403);
    const u = db.get('SELECT * FROM portal_users WHERE email = ? COLLATE NOCASE', email);
    if (!u || !u.active || !u.password_hash || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
      db.audit(null, 'Failed tenant sign-in', 'portal_user', u ? u.id : null, email, req.ip);
      return fail(tr('That email and password do not match.'), 401);
    }
    startSession(req, res, u);
    db.audit(null, 'Tenant signed in', 'portal_user', u.id, `${u.name} · ${email}`, req.ip);
    res.redirect(303, next);
  });

  // welcome (set a password from an invitation) and reset
  const passwordForm = (req, res, action) => `<form method="post" action="${action}" class="stack">
      <input type="hidden" name="_token" value="${ui.esc(formToken(req, res))}">
      ${ui.input('password', tr('por|New password'), '', { type: 'password', required: true, hint: tr('At least 10 characters.'), attrs: { autocomplete: 'new-password', minlength: 10 } })}
      ${ui.input('confirm', tr('por|Repeat the password'), '', { type: 'password', required: true, attrs: { autocomplete: 'new-password', minlength: 10 } })}
      ${ui.btn(tr('por|Save and sign in'), { cls: 'btn--primary btn--block', ic: 'arrow' })}
    </form>`;
  for (const purpose of ['invite', 'reset']) {
    const route = purpose === 'invite' ? '/welcome/:token' : '/reset/:token';
    const title = () => (purpose === 'invite' ? tr('por|Welcome to the tenant portal') : tr('por|Choose a new password'));
    const expired = (req, res) => authPage(req, res, { title: title(), status: 410, error: tr('por|This link has expired or was already used. Ask the leasing office for a new one.'), form: `<p><a class="btn btn--ghost" href="/portal/login">${ui.esc(tr('Sign in'))}</a></p>` });
    pr.get(route, (req, res) => {
      const t = tokenRow(req.params.token, purpose);
      if (!t) return expired(req, res);
      const u = db.get('SELECT u.*, b.name brand FROM portal_users u JOIN brands b ON b.id = u.brand_id WHERE u.id = ?', t.portal_user_id);
      authPage(req, res, { title: title(), intro: ui.esc(tr('por|{name}, set a password for {brand}’s account ({email}).', { name: u.name, brand: u.brand, email: u.email })), form: passwordForm(req, res, req.originalUrl.replace(/\?.*$/, '')) });
    });
    pr.post(route, signinLimit, (req, res) => {
      const t = tokenRow(req.params.token, purpose);
      if (!t) return expired(req, res);
      const u = db.get('SELECT * FROM portal_users WHERE id = ?', t.portal_user_id);
      const pw = String(req.body.password || '');
      let error = '';
      if (!checkFormToken(req)) error = tr('The form expired. Please try again.');
      else if (pw.length < 10) error = tr('Use a password of at least 10 characters.');
      else if (pw !== String(req.body.confirm || '')) error = tr('por|The two passwords do not match.');
      if (error) return authPage(req, res, { title: title(), status: 422, error, form: passwordForm(req, res, req.originalUrl) });
      db.tx(() => {
        db.run('UPDATE portal_tokens SET used_at = ?, reveal = NULL WHERE id = ?', now(), t.id);
        db.run('UPDATE portal_users SET password_hash = ?, active = 1 WHERE id = ?', hashPassword(pw), u.id);
        db.run('DELETE FROM portal_sessions WHERE portal_user_id = ?', u.id);
      });
      db.audit(null, purpose === 'invite' ? 'Tenant joined the portal' : 'Tenant reset the password', 'portal_user', u.id, u.email, req.ip);
      startSession(req, res, u);
      back(req, res, '/portal', 'ok', purpose === 'invite' ? tr('por|Welcome. Your account is ready.') : tr('por|Password changed.'));
    });
  }

  // forgot password: always the same answer, so it never reveals who has an account
  pr.get('/forgot', (req, res) => {
    authPage(req, res, {
      title: tr('por|Forgot your password?'), intro: ui.esc(tr('por|Enter your email. If it belongs to a portal account, we will send a link to choose a new password.')),
      form: `<form method="post" action="/portal/forgot" class="stack"><input type="hidden" name="_token" value="${ui.esc(formToken(req, res))}">${ui.input('email', tr('Email'), '', { type: 'email', required: true })}${ui.btn(tr('por|Send the link'), { cls: 'btn--primary btn--block' })}<p class="small"><a href="/portal/login">${ui.esc(tr('Sign in'))}</a></p></form>`,
    });
  });
  pr.post('/forgot', signinLimit, async (req, res) => {
    if (!checkFormToken(req)) return res.redirect(303, '/portal/forgot');
    const u = db.get('SELECT * FROM portal_users WHERE email = ? COLLATE NOCASE AND active = 1 AND password_hash IS NOT NULL', h.str(req.body.email, 200));
    if (u) {
      const t = issueToken(u.id, 'reset');
      const url = link(req, t, 'reset');
      const sent = await i18n.run(u.lang || req.lang, () => mail(u.email, tr('por|Your Wave tenant portal password'), tr('por|Choose a new password for the tenant portal: {url}\n\nThe link works for two hours. If you did not ask for it, ignore this email.', { url })));
      db.audit(null, sent ? 'Tenant asked for a password reset' : 'Tenant asked for a password reset (no email set up)', 'portal_user', u.id, u.email, req.ip);
    }
    authPage(req, res, { title: tr('por|Check your email'), intro: ui.esc(tr('por|If that email has a portal account, a link to choose a new password is on its way. No email? Ask the leasing office to send you a new link.')), form: `<p><a class="btn btn--ghost" href="/portal/login">${ui.esc(tr('Sign in'))}</a></p>` });
  });

  pr.post('/logout', requireTenant, (req, res) => {
    endSession(req, res);
    res.redirect(303, '/portal/login');
  });

  // ---------- home ----------
  tab({ key: 'home', href: '/portal', label: 'por|Home', icon: 'home', order: 10 });
  tab({ key: 'invoices', href: '/portal/invoices', label: 'Invoices', icon: 'bill', order: 20, badge: (req) => db.value("SELECT COUNT(*) FROM invoices WHERE brand_id = ? AND status IN ('open','partial') AND due_date < ?", req.tenant.brand_id, T()) });
  tab({ key: 'payments', href: '/portal/payments', label: 'por|Receipts', icon: 'wallet', order: 30 });
  tab({ key: 'documents', href: '/portal/documents', label: 'Documents', icon: 'folder', order: 40, badge: (req) => {
    const c = tenancy.tenant(db, req.brand).compliance;
    return c.missing + c.expired;
  } });
  tab({ key: 'notices', href: '/portal/notices', label: 'por|Notices', icon: 'mail', order: 60, badge: (req) => noticesFor(req).filter((n) => !n.read_at).length });
  tab({ key: 'account', href: '/portal/account', label: 'Your account', icon: 'team', order: 90, mobile: false });

  pr.get('/', requireTenant, (req, res) => {
    const bid = brandId(req);
    const due = outstanding(bid);
    const late = overdue(bid);
    const next = db.get("SELECT * FROM invoices WHERE brand_id = ? AND status IN ('open','partial') AND due_date > ? ORDER BY due_date LIMIT 1", bid, T());
    const pays = db.all("SELECT p.*, i.ref invoice_ref FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.brand_id = ? AND p.status = 'received' ORDER BY p.date DESC, p.id DESC LIMIT 4", bid);
    const ten = tenancy.tenant(db, req.brand);
    const c = ten.compliance;
    const notices = noticesFor(req, { limit: 3 });
    const payable = h.payments && h.payments.canPayOnline ? db.all("SELECT * FROM invoices WHERE brand_id = ? AND status IN ('open','partial') AND due_date <= ? ORDER BY due_date", bid, T()) : [];
    const kpis = [
      ui.kpi({ label: tr('por|Balance due'), value: ui.money(due, { compact: true }), tone: late ? 'kpi--alert' : '', href: '/portal/invoices', sub: late ? ui.esc(tr('por|{amount} overdue', { amount: ui.money(late) })) : ui.esc(tr('por|Nothing overdue')) }),
      ui.kpi({ label: tr('por|Next invoice'), value: next ? ui.money(next.total - next.paid, { compact: true }) : '—', href: next ? `/portal/invoices/${next.id}` : '', sub: next ? ui.esc(tr('por|Due {date}', { date: ui.date(next.due_date) })) : ui.esc(tr('por|No invoice coming up')) }),
      ui.kpi({ label: tr('por|Your file'), value: `${Math.round(c.score * 100)}%`, bar: c.score, href: '/portal/documents', tone: c.expired ? 'kpi--alert' : '', sub: c.missing || c.expired ? ui.esc(tr('por|{missing} missing · {expired} expired', { missing: c.missing, expired: c.expired })) : ui.esc(tr('por|Complete')) }),
      ui.kpi({ label: tr('por|Your units'), value: ten.units.length ? ui.esc(ten.units.map((u) => u.code).join(' · ')) : '—', sub: ten.area ? ui.m2(ten.area) : '' }),
    ].join('');
    const firstPayable = payable.find((i) => h.payments.canPayOnline(i));
    const quick = `<div class="pquick">
      ${firstPayable ? `<a class="pquick__a pquick__a--primary" href="/portal/invoices/${firstPayable.id}#pay">${ui.icon('wallet')}<span>${ui.esc(tr('por|Pay now'))}</span></a>` : ''}
      <a class="pquick__a" href="/portal/invoices">${ui.icon('bill')}<span>${ui.esc(tr('Invoices'))}</span></a>
      <a class="pquick__a" href="/portal/documents">${ui.icon('upload')}<span>${ui.esc(tr('por|Upload a document'))}</span></a>
      ${tabs.filter((x) => x.quick && (!x.show || x.show(req))).map((x) => `<a class="pquick__a" href="${x.href}">${ui.icon(x.icon)}<span>${ui.esc(tr(x.quick))}</span></a>`).join('')}
    </div>`;
    const payList = pays.length
      ? `<ul class="list">${pays.map((p) => `<li><a href="/portal/payments/${p.id}/receipt"><span class="dot dot--sea"></span><span class="what"><b>${ui.money(p.amount)}</b><small>${ui.date(p.date)}${p.invoice_ref ? ` · ${ui.esc(p.invoice_ref)}` : ''}${p.method ? ` · ${ui.esc(M.PAY_METHODS[p.method] || p.method)}` : ''}</small></span>${ui.icon('print')}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('No payments yet.'))}</p>`;
    const noticeList = notices.length
      ? `<ul class="list">${notices.map((n) => `<li><a href="/portal/notices/${n.id}"><span class="dot${n.read_at ? '' : ' dot--amber'}"></span><span class="what"><b>${ui.esc(noticeTitle(n))}</b><small>${ui.date(n.publish_at || n.created_at)}</small></span></a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('por|No notices right now.'))}</p>`;
    const fileList = c.items.filter((x) => x.state !== 'ok').length
      ? `<ul class="list">${c.items.filter((x) => x.state !== 'ok').map((x) => `<li><a href="/portal/documents#${x.kind}"><span class="dot dot--${x.state === 'expiring' ? 'amber' : 'rose'}"></span><span class="what"><b>${ui.esc(M.DOC_KINDS[x.kind])}</b><small>${ui.esc(stateLabel(x))}</small></span></a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('por|Everything we need is on file. Thank you.'))}</p>`;
    const body = `<p class="hello">${ui.esc(tr('por|Welcome, {name}.', { name: req.tenant.name.split(' ')[0] }))} <b>${ui.esc(req.brand.name)}</b></p>
<div class="kpis kpis--4">${kpis}</div>
${quick}
<div class="grid grid--2">
  ${ui.card(tr('por|Recent payments'), payList, { action: ui.btn(tr('por|All receipts'), { href: '/portal/payments', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('por|Notices'), noticeList, { action: ui.btn(tr('All'), { href: '/portal/notices', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('por|Your file'), fileList, { sub: ui.esc(tr('por|Documents the mall must hold for every tenant.')), action: ui.btn(tr('Documents'), { href: '/portal/documents', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('por|The leasing office'), office(), {})}
</div>`;
    page(req, res, { title: tr('por|Home'), active: 'home', body });
  });
  function office() {
    const s = db.settings();
    return `<dl class="dl">
      ${s.leasing_email ? `<div><dt>${ui.esc(tr('Email'))}</dt><dd><a href="mailto:${ui.esc(s.leasing_email)}">${ui.esc(s.leasing_email)}</a></dd></div>` : ''}
      ${s.leasing_phone ? `<div><dt>${ui.esc(tr('Phone'))}</dt><dd><a href="tel:${ui.esc(String(s.leasing_phone).replace(/\s+/g, ''))}">${ui.esc(s.leasing_phone)}</a></dd></div>` : ''}
      <div><dt>${ui.esc(tr('por|Address'))}</dt><dd>${ui.esc(tx(s.address))}</dd></div>
    </dl>`;
  }
  const stateLabel = (x) => ({
    ok: tr('por|On file'), missing: tr('por|Missing'), expired: x.doc && x.doc.expires_on ? tr('Expired {date}', { date: ui.date(x.doc.expires_on) }) : tr('por|Expired'),
    expiring: x.doc && x.doc.expires_on ? tr('Expires {when}', { when: ui.rel(x.doc.expires_on) }) : tr('por|Expiring'),
  })[x.state];

  // ---------- invoices ----------
  pr.get('/invoices', requireTenant, (req, res) => {
    const bid = brandId(req);
    const t = T();
    const view = ['due', 'upcoming', 'paid'].includes(req.query.view) ? req.query.view : 'due';
    const all = invoicesOf(bid);
    const lists = {
      due: all.filter((i) => ['open', 'partial'].includes(i.status) && i.due_date <= t),
      upcoming: all.filter((i) => ['open', 'partial'].includes(i.status) && i.due_date > t && i.due_date <= M.addDays(t, 120)),
      paid: all.filter((i) => i.status === 'paid').reverse(),
    };
    const rows = lists[view];
    const tabsHtml = [['due', tr('por|To pay')], ['upcoming', tr('Upcoming')], ['paid', tr('invoice|Paid')]].map(([k, l]) => `<a class="tab${view === k ? ' is-on' : ''}" href="/portal/invoices?view=${k}">${ui.esc(l)}${lists[k].length && k !== 'paid' ? ` <b class="nav__count">${lists[k].length}</b>` : ''}</a>`).join('');
    const table = ui.table([
      { label: tr('Invoice'), render: (i) => `<b>${ui.esc(i.ref)}</b><small class="sub">${ui.esc(invoiceFor_(i))}</small>` },
      { label: tr('Due'), render: (i) => `<span class="${['open', 'partial'].includes(i.status) && i.due_date < t ? 'late' : ''}">${ui.date(i.due_date)}<small class="sub">${ui.rel(i.due_date)}</small></span>` },
      { label: tr('Total'), num: true, render: (i) => ui.money(i.total, { cur: false }) },
      { label: view === 'paid' ? tr('Paid') : tr('Outstanding'), num: true, render: (i) => `<b>${ui.money(view === 'paid' ? i.paid : i.total - i.paid, { cur: false })}</b>` },
      { label: tr('Status'), render: statusBadge },
    ], rows, { empty: ui.esc(view === 'due' ? tr('por|Nothing to pay right now.') : view === 'upcoming' ? tr('por|No invoices in the next four months.') : tr('No payments yet.')), href: (i) => `/portal/invoices/${i.id}` });
    const due = outstanding(bid);
    const body = `<div class="kpis kpis--3">
      ${ui.kpi({ label: tr('por|Balance due'), value: ui.money(due, { compact: true }), tone: overdue(bid) ? 'kpi--alert' : '' })}
      ${ui.kpi({ label: tr('invoice|Overdue'), value: ui.money(overdue(bid), { compact: true }) })}
      ${ui.kpi({ label: tr('por|Paid this year'), value: ui.money(db.value("SELECT COALESCE(SUM(amount), 0) FROM payments WHERE brand_id = ? AND status = 'received' AND substr(date, 1, 4) = ?", bid, t.slice(0, 4)), { compact: true }) })}
    </div><nav class="tabs">${tabsHtml}</nav>${ui.card(tn(rows.length, '{n} invoice', '{n} invoices'), table)}${payInstructions()}`;
    page(req, res, { title: tr('Invoices'), active: 'invoices', body });
  });

  // how to pay without the portal: bank transfer and InstaPay, from the portal settings
  function payInstructions() {
    const s = db.settings();
    const rows = [
      s.portal_instapay ? [tr('pay|InstaPay'), `<span class="ltr">${ui.esc(s.portal_instapay)}</span>${s.portal_instapay_name ? ` · ${ui.esc(s.portal_instapay_name)}` : ''}`] : null,
      s.portal_bank ? [tr('pay|Bank transfer'), `${ui.esc(s.portal_bank)}${s.portal_bank_account ? ` · ${ui.esc(s.portal_bank_account)}` : ''}${s.portal_iban ? `<br><span class="ltr">${ui.esc(s.portal_iban)}</span>` : ''}`] : null,
    ].filter(Boolean);
    if (!rows.length) return '';
    return ui.card(tr('por|Other ways to pay'), `<dl class="dl">${rows.map(([k, v]) => `<div><dt>${ui.esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl><p class="muted small">${ui.esc(tr('por|Quote the invoice number as the reference. Transfers are matched by the leasing office within two working days.'))}</p>`);
  }

  pr.get('/invoices/:id', requireTenant, (req, res, next) => {
    const i = invoiceFor(req, req.params.id);
    if (!i) return next();
    const t = T();
    const open = ['open', 'partial'].includes(i.status);
    const pays = db.all("SELECT * FROM payments WHERE invoice_id = ? AND status = 'received' ORDER BY date, id", i.id);
    const payCard = open && h.payments && h.payments.payCard ? h.payments.payCard(req, i, { csrf: req.psession.csrf, action: `/portal/invoices/${i.id}/pay` }) : '';
    const facts = `<dl class="dl">
      <div><dt>${ui.esc(tr('invoice|For'))}</dt><dd>${ui.esc(invoiceFor_(i))}</dd></div>
      ${i.lease_ref ? `<div><dt>${ui.esc(tr('Lease'))}</dt><dd>${ui.esc(i.lease_ref)}</dd></div>` : ''}
      <div><dt>${ui.esc(tr('Due'))}</dt><dd class="${open && i.due_date < t ? 'late' : ''}">${ui.date(i.due_date)} · ${ui.rel(i.due_date)}</dd></div>
      ${i.rent ? `<div><dt>${ui.esc(tr('Rent'))}</dt><dd>${ui.money(i.rent)}</dd></div>` : ''}
      ${i.service ? `<div><dt>${ui.esc(tr('Service'))}</dt><dd>${ui.money(i.service)}</dd></div>` : ''}
      ${i.other ? `<div><dt>${ui.esc(tr('Other'))}</dt><dd>${ui.money(i.other)}</dd></div>` : ''}
      <div><dt>${ui.esc(tr('Total'))}</dt><dd><b>${ui.money(i.total)}</b></dd></div>
      <div><dt>${ui.esc(tr('Paid'))}</dt><dd>${ui.money(i.paid)}</dd></div>
      <div><dt>${ui.esc(tr('Outstanding'))}</dt><dd><b>${ui.money(i.total - i.paid)}</b></dd></div>
      <div><dt>${ui.esc(tr('Status'))}</dt><dd>${statusBadge(i)}</dd></div>
    </dl>`;
    const payList = pays.length
      ? `<ul class="list">${pays.map((p) => `<li><a href="/portal/payments/${p.id}/receipt"><span class="what"><b>${ui.esc(p.ref)} · ${ui.money(p.amount)}</b><small>${ui.date(p.date)}${p.method ? ` · ${ui.esc(M.PAY_METHODS[p.method] || p.method)}` : ''}</small></span>${ui.icon('print')}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('No payments yet.'))}</p>`;
    const body = `<div class="grid grid--side">
  <div class="stack">${ui.card(tr('Invoice'), facts)}${ui.card(tr('Payments'), payList)}</div>
  <div class="stack" id="pay">${payCard}${open ? payInstructions() : ''}</div>
</div>`;
    page(req, res, {
      title: tr('Invoice {ref}', { ref: i.ref }), active: 'invoices', crumbs: [['/portal/invoices', tr('Invoices')], [null, i.ref]], body,
      actions: ui.btn(tr('Print'), { href: `/portal/invoices/${i.id}/print`, cls: 'btn--ghost', ic: 'print', attrs: { target: '_blank' } }),
    });
  });

  // the invoice document, rendered by the billing pages (deals.js) for staff and tenants alike
  pr.get('/invoices/:id/print', requireTenant, (req, res, next) => {
    const i = invoiceFor(req, req.params.id);
    if (!i || !h.invoiceDoc) return next();
    const lang = ['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang;
    res.type('html').send(h.invoiceDoc(i.id, { lang, back: `/portal/invoices/${i.id}`, self: `/portal/invoices/${i.id}/print` }));
  });

  // ---------- receipts ----------
  pr.get('/payments', requireTenant, (req, res) => {
    const pays = db.all("SELECT p.*, i.ref invoice_ref FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.brand_id = ? AND p.status = 'received' ORDER BY p.date DESC, p.id DESC LIMIT 400", brandId(req));
    const table = ui.table([
      { label: tr('por|Receipt'), render: (p) => `<b>${ui.esc(p.ref)}</b>${p.invoice_ref ? `<small class="sub">${ui.esc(p.invoice_ref)}</small>` : ''}` },
      { label: tr('Date'), render: (p) => ui.date(p.date) },
      { label: tr('Method'), render: (p) => ui.esc(M.PAY_METHODS[p.method] || p.method || '—') },
      { label: tr('Amount'), num: true, render: (p) => `<b>${ui.money(p.amount, { cur: false })}</b>` },
    ], pays, { empty: ui.esc(tr('No payments yet.')), href: (p) => `/portal/payments/${p.id}/receipt` });
    page(req, res, { title: tr('por|Receipts'), active: 'payments', body: ui.card(tn(pays.length, 'por|{n} payment', 'por|{n} payments'), table) });
  });
  pr.get('/payments/:id/receipt', requireTenant, (req, res, next) => {
    const p = db.get("SELECT * FROM payments WHERE id = ? AND brand_id = ? AND status = 'received'", h.int(req.params.id), brandId(req));
    if (!p || !h.receiptDoc) return next();
    const lang = ['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang;
    res.type('html').send(h.receiptDoc(p.id, { lang, back: '/portal/payments', self: `/portal/payments/${p.id}/receipt` }));
  });

  // ---------- documents ----------
  pr.get('/documents', requireTenant, (req, res) => {
    const ten = tenancy.tenant(db, req.brand);
    const c = ten.compliance;
    const csrf = req.psession.csrf;
    const kinds = M.DOC_GROUPS.brand.filter((k) => k !== 'other').concat('other');
    const uploader = (kind) => `<form class="upload" data-upload="/portal/documents/upload?kind=${encodeURIComponent(kind)}" novalidate>
      <div class="fields">
        ${kind === 'any' ? ui.select('type', tr('Type'), kinds.map((k) => [k, M.DOC_KINDS[k]]), kinds[0]) : ''}
        ${ui.input('title', tr('Title'), '', { placeholder: kind === 'any' ? tr('e.g. Commercial register 2026') : M.DOC_KINDS[kind] })}
        ${ui.input('issued_on', tr('Issued'), '', { type: 'date' })}
        ${ui.input('expires_on', tr('Expires'), '', { type: 'date' })}
      </div>
      <label class="drop"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,application/pdf,image/*">${ui.icon('upload')}<span data-drop-label>${ui.esc(tr('Drop a file here, or click to choose'))}</span><small>${ui.esc(tr('PDF, JPG, PNG, WebP, Word or Excel · up to 25 MB'))}</small><i class="drop__bar" hidden><b></b></i></label>
      <p class="upload__msg" data-upload-msg hidden></p>
    </form>`;
    const items = c.items.map((x) => {
      const isLease = x.key.startsWith('lease:');
      const label = isLease ? tr('por|Signed lease {ref}', { ref: x.lease.ref }) : M.DOC_KINDS[x.kind];
      const tone = { ok: 'ok', expiring: 'amber', expired: 'rose', missing: 'rose' }[x.state];
      return `<li class="pdoc" id="${ui.esc(x.key.replace(":", "-"))}">
        <div class="pdoc__head"><span class="pdoc__ic pdoc__ic--${tone}">${ui.icon(x.state === 'ok' || x.state === 'expiring' ? 'check' : 'log')}</span>
          <div class="pdoc__what"><b>${ui.esc(label)}</b><small>${ui.esc(stateLabel(x))}${x.doc && tx(x.doc.title) !== label ? ` · ${ui.esc(tx(x.doc.title))}` : ''}</small></div>
          ${x.doc ? `<a class="iconbtn" href="/portal/documents/${x.doc.id}/file" target="_blank" rel="noopener" title="${ui.esc(tr('Download'))}">${ui.icon('dl')}</a>` : ''}</div>
        ${isLease ? (x.state === 'ok' ? '' : `<p class="muted small">${ui.esc(tr('por|The leasing office files the signed lease.'))}</p>`) : x.state === 'ok' ? '' : `<details class="upload-box"${x.state === 'missing' || x.state === 'expired' ? ' open' : ''}><summary>${ui.icon('upload')}<span>${ui.esc(x.state === 'missing' ? tr('por|Upload') : tr('por|Upload the renewal'))}</span></summary>${uploader(x.kind)}</details>`}
      </li>`;
    }).join('');
    const mine = db.all("SELECT d.* FROM documents d WHERE d.entity = 'brand' AND d.entity_id = ? AND d.archived = 0 AND d.confidential = 0 ORDER BY d.created_at DESC LIMIT 60", brandId(req));
    const list = mine.length
      ? `<ul class="doclist">${mine.map((d) => `<li>${ui.fileIcon(d.mime)}<div class="doclist__what"><a href="/portal/documents/${d.id}/file" target="_blank" rel="noopener"><b>${ui.esc(tx(d.title))}</b></a><small>${ui.esc(M.DOC_KINDS[d.kind] || d.kind)} · ${ui.KB(d.size)} · ${ui.date(d.created_at)}${d.portal_user_id ? ` · ${ui.esc(tr('por|sent by you'))}` : ''}</small></div><div class="doclist__end">${ui.expiry(d.expires_on)}</div></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('No documents yet.'))}</p>`;
    const body = `<input type="hidden" value="${ui.esc(csrf)}">
<div class="kpis kpis--3">
  ${ui.kpi({ label: tr('por|Your file'), value: `${Math.round(c.score * 100)}%`, bar: c.score })}
  ${ui.kpi({ label: tr('por|Missing'), value: String(c.missing), tone: c.missing ? 'kpi--alert' : '' })}
  ${ui.kpi({ label: tr('por|Expired'), value: String(c.expired), tone: c.expired ? 'kpi--alert' : '', sub: c.expiring ? ui.esc(tr('por|{n} expiring soon', { n: c.expiring })) : '' })}
</div>
<div class="grid grid--side">
  ${ui.card(tr('por|What the mall needs'), `<ul class="pdocs">${items}</ul>`, { sub: ui.esc(tr('por|Upload a clear scan or photo. The leasing office checks each document.')) })}
  <div class="stack">
    ${ui.card(tr('por|Send another document'), `<details class="upload-box"><summary>${ui.icon('plus')}<span>${ui.esc(tr('Add a document'))}</span></summary>${uploader('any')}</details>`)}
    ${ui.card(tr('por|Your documents'), list)}
  </div>
</div>`;
    page(req, res, { title: tr('Documents'), active: 'documents', body });
  });
  pr.post('/documents/upload', requireTenant, express.raw({ type: () => true, limit: h.files.MAX_BYTES + 1024 }), (req, res) => {
    const kinds = M.DOC_GROUPS.brand;
    const asked = req.query.kind === 'any' ? req.query.type : req.query.kind;
    const kind = kinds.includes(asked) ? asked : 'other';
    const name = h.str(decodeURIComponent(String(req.get('x-file-name') || '')), 200);
    const saved = h.files.save(Buffer.isBuffer(req.body) ? req.body : null, name);
    if (saved.error === 'empty') return res.status(422).json({ ok: false, error: tr('Choose a file to upload.') });
    if (saved.error === 'too_big') return res.status(413).json({ ok: false, error: tr('That file is larger than 25 MB.') });
    if (saved.error) return res.status(415).json({ ok: false, error: tr('Upload a PDF, JPG, PNG, WebP, Word (.docx) or Excel (.xlsx) file.') });
    const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const id = Number(db.run(
      `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, expires_on, notes, confidential, version, portal_user_id, created_at)
       VALUES (?, 'brand', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      db.nextRef('documents', 'DOC', 4, true), brandId(req), kind, h.str(req.query.title, 160) || englishKind(kind), saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored,
      date(req.query.issued_on), date(req.query.expires_on), 'Submitted by the tenant through the portal', req.tenant.id, M.now(),
    ).lastInsertRowid);
    db.audit(null, 'Tenant uploaded a document', 'document', id, `${req.brand.name} · ${englishKind(kind)}`, req.ip);
    h.events.emit('portal.document', { document: db.get('SELECT * FROM documents WHERE id = ?', id), tenant: req.tenant, brand: req.brand });
    res.json({ ok: true, id });
  });
  // the English name of a document type (stored titles stay English; tx() shows them in Arabic)
  const englishKind = (k) => i18n.run('en', () => M.DOC_KINDS[k]);
  pr.get('/documents/:id/file', requireTenant, (req, res, next) => {
    const d = db.get('SELECT * FROM documents WHERE id = ? AND confidential = 0', h.int(req.params.id));
    const leases = db.all('SELECT id FROM leases WHERE brand_id = ?', brandId(req)).map((x) => x.id);
    const mine = d && ((d.entity === 'brand' && d.entity_id === brandId(req)) || (d.entity === 'lease' && leases.includes(d.entity_id)));
    if (!mine) return next();
    const file = h.files.path(d.stored);
    if (!file) return res.status(410).type('text').send(tr('This file is missing from the server. Upload it again.'));
    const inline = !req.query.download && /^(application\/pdf|image\/)/.test(d.mime);
    res.set({
      'Content-Type': d.mime,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${d.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(d.file_name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.removeHeader('Content-Security-Policy');
    res.sendFile(file);
  });

  // ---------- notices ----------
  pr.get('/notices', requireTenant, (req, res) => {
    const list = noticesFor(req);
    const body = list.length
      ? `<div class="pnotices">${list.map((n) => `<a class="pnotice${n.read_at ? '' : ' is-new'}" href="/portal/notices/${n.id}"><span class="eyebrow">${ui.date(n.publish_at || n.created_at)}${n.read_at ? '' : ` · ${ui.esc(tr('por|New'))}`}</span><b>${ui.esc(noticeTitle(n))}</b><p>${ui.esc(String(noticeBody(n)).slice(0, 180))}${String(noticeBody(n)).length > 180 ? '…' : ''}</p></a>`).join('')}</div>`
      : ui.empty(tr('por|No notices right now.'));
    page(req, res, { title: tr('por|Notices'), active: 'notices', body });
  });
  pr.get('/notices/:id', requireTenant, (req, res, next) => {
    const n = noticesFor(req).find((x) => x.id === h.int(req.params.id));
    if (!n) return next();
    db.run('INSERT INTO portal_notice_reads (notice_id, portal_user_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', n.id, req.tenant.id, now());
    page(req, res, {
      title: noticeTitle(n), active: 'notices', crumbs: [['/portal/notices', tr('por|Notices')], [null, ui.date(n.publish_at || n.created_at)]],
      body: ui.card(noticeTitle(n), `<div class="pnotice__body">${paragraphs(noticeBody(n))}</div>`, { sub: ui.date(n.publish_at || n.created_at) }),
    });
  });

  // ---------- account ----------
  pr.get('/account', requireTenant, (req, res) => {
    const csrf = req.psession.csrf;
    const u = req.tenant;
    const others = db.all('SELECT name, email, last_login_at FROM portal_users WHERE brand_id = ? AND id != ? AND active = 1 ORDER BY name', u.brand_id, u.id);
    const body = `<div class="grid grid--2">
  ${ui.card(tr('Your details'), `<form method="post" action="/portal/account" class="stack"><input type="hidden" name="_csrf" value="${ui.esc(csrf)}"><div class="fields">
    ${ui.input('name', tr('Name'), u.name, { required: true })}
    ${ui.input('phone', tr('Phone'), u.phone, { type: 'tel' })}
    ${ui.select('lang', tr('por|Language'), [['en', 'English'], ['ar', 'العربية']], u.lang || req.lang)}
    ${ui.input('email_ro', tr('Email'), u.email, { attrs: { readonly: true } })}
  </div>${ui.btn(tr('Save'), { cls: 'btn--primary' })}</form>`)}
  ${ui.card(tr('Change password'), `<form method="post" action="/portal/account/password" class="stack"><input type="hidden" name="_csrf" value="${ui.esc(csrf)}"><div class="fields">
    ${ui.input('current', tr('Current password'), '', { type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}
    ${ui.input('password', tr('New password'), '', { type: 'password', required: true, hint: tr('At least 10 characters.'), attrs: { autocomplete: 'new-password', minlength: 10 } })}
  </div>${ui.btn(tr('Update password'), { cls: 'btn--primary' })}</form>`)}
  ${ui.card(tr('por|Your colleagues on the portal'), others.length ? `<ul class="list">${others.map((o) => `<li><span class="what"><b>${ui.esc(o.name)}</b><small>${ui.esc(o.email)}</small></span></li>`).join('')}</ul>` : `<p class="muted pad">${ui.esc(tr('por|Only you so far. The leasing office can invite colleagues.'))}</p>`)}
</div>`;
    page(req, res, { title: tr('Your account'), active: 'account', body });
  });
  pr.post('/account', requireTenant, (req, res) => {
    const name = h.str(req.body.name, 120);
    if (!name) return back(req, res, '/portal/account', 'error', tr('Name is required.'));
    const lang = req.body.lang === 'ar' ? 'ar' : 'en';
    db.run('UPDATE portal_users SET name = ?, phone = ?, lang = ? WHERE id = ?', name, h.str(req.body.phone, 40) || null, lang, req.tenant.id);
    setCookie(req, res, LANG, lang, { maxAge: 365 * 86400000 });
    back(req, res, '/portal/account', 'ok', i18n.run(lang, () => tr('Saved.')));
  });
  pr.post('/account/password', requireTenant, (req, res) => {
    const u = req.tenant;
    if (!verifyPassword(String(req.body.current || ''), u.password_hash)) return back(req, res, '/portal/account', 'error', tr('por|Your current password is not right.'));
    const pw = String(req.body.password || '');
    if (pw.length < 10) return back(req, res, '/portal/account', 'error', tr('Use a password of at least 10 characters.'));
    db.run('UPDATE portal_users SET password_hash = ? WHERE id = ?', hashPassword(pw), u.id);
    db.run('DELETE FROM portal_sessions WHERE portal_user_id = ? AND id != ?', u.id, req.psession.id);
    back(req, res, '/portal/account', 'ok', tr('por|Password changed.'));
  });

  // other modules' tabs and pages, then a portal-styled "not found"
  pr.use(ext);
  pr.use((req, res) => {
    if (!req.tenant) return res.redirect(303, '/portal/login');
    res.status(404);
    page(req, res, { title: tr('por|Not found'), body: ui.empty(tr('por|That page is not in your portal.'), ui.btn(tr('por|Home'), { href: '/portal', cls: 'btn--primary' })) });
  });

  h.portal = { router: ext, requireTenant, tab, page, brandId, back, flash, noticesFor };

  // ================= staff: /admin/portal =================
  const R = h.auth.requireRole;
  const tenantsBrands = () => db.all("SELECT b.id, b.name FROM brands b WHERE b.id IN (SELECT brand_id FROM leases WHERE status IN ('draft','active')) ORDER BY b.name");
  const usersTable = (req, rows, { brandCol = true, csrf }) => ui.table([
    ...(brandCol ? [{ label: tr('Brand'), render: (u) => `<a href="/admin/tenants/${u.brand_id}">${ui.esc(u.brand)}</a>` }] : []),
    { label: tr('Name'), render: (u) => `<b>${ui.esc(u.name)}</b><small class="sub">${ui.esc(u.email)}</small>` },
    { label: tr('por|Last sign-in'), render: (u) => (u.last_login_at ? ui.rel(u.last_login_at) : `<span class="muted">${u.password_hash ? ui.esc(tr('por|Never')) : '—'}</span>`) },
    { label: tr('Status'), render: (u) => (u.active ? ui.badge('active', u.password_hash ? tr('por|Active') : tr('por|Invited'), u.password_hash ? 'ok' : 'amber') : ui.badge('void', tr('por|Disabled'))) },
    ...(h.can(req, 'agent') ? [{ label: '', render: (u) => `<div class="prow">${ui.form(`/admin/portal/users/${u.id}/link`, csrf, ui.btn(u.password_hash ? tr('por|Reset link') : tr('por|New invite link'), { cls: 'btn--ghost btn--xs' }))}${h.can(req, 'manager') ? ui.form(`/admin/portal/users/${u.id}/toggle`, csrf, ui.btn(u.active ? tr('por|Disable') : tr('por|Enable'), { cls: 'btn--ghost btn--xs', attrs: u.active ? { 'data-confirm': tr('por|Disable {name}? They will be signed out.', { name: u.name }) } : {} })) : ''}</div>` }] : []),
  ], rows, { empty: ui.esc(tr('por|No tenant accounts yet.')) });
  // a link that was just created, shown once to the person who created it
  function revealed(req) {
    const id = h.int(req.query.link);
    if (!id || !h.can(req, 'agent')) return '';
    const t = db.get('SELECT t.*, u.email, u.name FROM portal_tokens t JOIN portal_users u ON u.id = t.portal_user_id WHERE t.rowid = ? AND t.reveal IS NOT NULL', id);
    if (!t) return '';
    db.run('UPDATE portal_tokens SET reveal = NULL WHERE rowid = ?', id);
    const url = link(req, t.reveal, t.purpose);
    return `<div class="alert alert--ok plink"><p>${ui.esc(t.purpose === 'invite' ? tr('por|Invitation link for {name}. It works for {days} days and can be used once:', { name: t.name, days: INVITE_DAYS }) : tr('por|Password link for {name}. It works for two hours and can be used once:', { name: t.name }))}</p><input readonly value="${ui.esc(url)}" class="ltr" data-select><p class="small">${ui.esc(tr('por|Copy it now: it is not shown again.'))}</p></div>`;
  }

  router.get('/portal', (req, res) => {
    const csrf = req.session.csrf;
    const users = db.all('SELECT u.*, b.name brand FROM portal_users u JOIN brands b ON b.id = u.brand_id ORDER BY b.name, u.name');
    const notices = db.all('SELECT n.*, (SELECT COUNT(*) FROM portal_notice_reads r WHERE r.notice_id = n.id) reads FROM portal_notices n ORDER BY n.id DESC LIMIT 100');
    const s = db.settings();
    const demoPw = db.value('SELECT COUNT(*) FROM portal_users WHERE demo = 1') ? db.setting('portal_demo_password') : '';
    const brands = tenantsBrands();
    const invite = h.can(req, 'agent') && brands.length ? ui.card(tr('por|Invite a tenant'), ui.form('/admin/portal/invite', csrf, `<div class="fields">
      ${ui.select('brand_id', tr('Brand'), brands.map((b) => [b.id, b.name]), req.query.brand || '', { required: true })}
      ${ui.input('name', tr('Name'), '', { required: true })}
      ${ui.input('email', tr('Email'), '', { type: 'email', required: true })}
      ${ui.select('lang', tr('por|Language'), [['en', 'English'], ['ar', 'العربية']], 'en')}
    </div>${ui.btn(tr('por|Send invitation'), { cls: 'btn--primary', ic: 'mail' })}`, { cls: 'stack' }), { sub: ui.esc(tr('por|They get a link to set a password. Without email set up, the link is shown here to pass on.')) }) : '';
    const noticeRows = ui.table([
      { label: tr('Title'), render: (n) => `<b>${ui.esc(noticeTitle(n))}</b>${n.title_ar ? '' : `<small class="sub">${ui.esc(tr('por|English only'))}</small>`}` },
      { label: tr('por|Audience'), render: (n) => ui.esc(n.audience === 'all' ? tr('por|All tenants') : tn(String(n.brand_ids || '').split(',').filter(Boolean).length, '{n} tenant', '{n} tenants')) },
      { label: tr('Status'), render: (n) => ui.badge(n.status, n.status === 'published' ? (n.expire_at && n.expire_at <= now() ? tr('offer|Expired') : tr('por|Published')) : tr('offer|Draft'), n.status === 'published' ? 'ok' : 'mute') },
      { label: tr('por|Read by'), num: true, render: (n) => String(n.reads) },
      ...(h.can(req, 'agent') ? [{ label: '', render: (n) => `<div class="prow">${ui.form(`/admin/portal/notices/${n.id}/toggle`, csrf, ui.btn(n.status === 'published' ? tr('por|Unpublish') : tr('por|Publish'), { cls: 'btn--ghost btn--xs' }))}${ui.form(`/admin/portal/notices/${n.id}/delete`, csrf, `<button class="iconbtn" title="${ui.esc(tr('Delete'))}" aria-label="${ui.esc(tr('Delete'))}" data-confirm="${ui.esc(tr('Delete {name}? This cannot be undone.', { name: noticeTitle(n) }))}">×</button>`)}</div>` }] : []),
    ], notices, { empty: ui.esc(tr('por|No notices yet.')) });
    const noticeForm = h.can(req, 'agent') ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${ui.esc(tr('por|New notice'))}</span></summary>${ui.form('/admin/portal/notices', csrf, `<div class="fields">
      ${ui.input('title_en', tr('por|Title (English)'), '', { required: true })}
      ${ui.input('title_ar', tr('por|Title (Arabic)'), '', { attrs: { dir: 'rtl' } })}
      ${ui.textarea('body_en', tr('por|Message (English)'), '', { rows: 4, cls: 'span-all' })}
      ${ui.textarea('body_ar', tr('por|Message (Arabic)'), '', { rows: 4, cls: 'span-all' })}
      ${ui.select('audience', tr('por|Audience'), [['all', tr('por|All tenants')], ['brands', tr('por|Chosen tenants')]], 'all')}
      ${ui.input('expire_at', tr('por|Show until'), '', { type: 'date' })}
    </div><div class="picks">${brands.map((b) => `<label class="pick"><input type="checkbox" name="brands" value="${b.id}"><b>${ui.esc(b.name)}</b></label>`).join('')}</div><label class="check"><input type="checkbox" name="publish" value="1" checked> ${ui.esc(tr('por|Publish now'))}</label>${ui.btn(tr('Save'), { cls: 'btn--primary' })}`, { cls: 'stack' })}</details>` : '';
    const instructions = h.can(req, 'admin') ? ui.card(tr('por|Payment instructions'), ui.form('/admin/portal/settings', csrf, `<div class="fields">
      ${ui.input('portal_instapay', tr('por|InstaPay address (IPA)'), s.portal_instapay, { placeholder: 'thewave@instapay' })}
      ${ui.input('portal_instapay_name', tr('por|InstaPay account name'), s.portal_instapay_name)}
      ${ui.input('portal_bank', tr('por|Bank'), s.portal_bank)}
      ${ui.input('portal_bank_account', tr('por|Account name and number'), s.portal_bank_account)}
      ${ui.input('portal_iban', tr('por|IBAN'), s.portal_iban, { cls: 'span-all' })}
    </div>${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }), { sub: ui.esc(tr('por|Shown to tenants beside every invoice, for paying outside the portal.')) }) : '';
    const body = `${revealed(req)}${demoPw && h.can(req, 'manager') ? `<p class="alert alert--warn">${ui.esc(tr('por|Sample tenants can sign in at /portal with their email and the password {pw}.', { pw: demoPw }))}</p>` : ''}
<div class="kpis kpis--4">
  ${ui.kpi({ label: tr('por|Tenant accounts'), value: String(users.filter((u) => u.active).length) })}
  ${ui.kpi({ label: tr('por|Signed in this month'), value: String(users.filter((u) => u.last_login_at && u.last_login_at.slice(0, 7) === M.today().slice(0, 7)).length) })}
  ${ui.kpi({ label: tr('por|Waiting to join'), value: String(users.filter((u) => !u.password_hash && u.active).length) })}
  ${ui.kpi({ label: tr('por|Live notices'), value: String(notices.filter((n) => n.status === 'published' && (!n.expire_at || n.expire_at > now())).length) })}
</div>
<div class="grid grid--side">
  <div class="stack">
    ${ui.card(tr('por|Tenant accounts'), usersTable(req, users, { csrf }), { action: ui.btn(tr('por|Open the portal'), { href: '/portal', cls: 'btn--ghost btn--sm', ic: 'arrow', attrs: { target: '_blank', rel: 'noopener' } }) })}
    ${ui.card(tr('por|Notices'), `${noticeRows}${noticeForm}`, { sub: ui.esc(tr('por|Announcements tenants see on their home page.')) })}
  </div>
  <div class="stack">${invite}${instructions}${h.payments && h.payments.adminCard ? h.payments.adminCard(req) : ''}</div>
</div>`;
    h.page(req, res, { title: tr('por|Tenant portal'), crumbs: [['/admin/tenants', tr('Tenant files')], [null, tr('por|Tenant portal')]], active: '/admin/tenants', wide: true, body });
  });

  router.post('/portal/invite', R('agent'), async (req, res) => {
    const brand = db.get('SELECT * FROM brands WHERE id = ?', h.int(req.body.brand_id));
    const name = h.str(req.body.name, 120);
    const email = h.str(req.body.email, 200);
    const backTo = h.safeBack(req, '/admin/portal');
    if (!brand) return h.back(req, res, backTo, 'error', tr('That record no longer exists.'));
    if (!name || !EMAIL_RE.test(email)) return h.back(req, res, backTo, 'error', tr('Enter your name and a valid email.'));
    if (db.get('SELECT id FROM portal_users WHERE email = ? COLLATE NOCASE', email)) return h.back(req, res, backTo, 'error', tr('por|{email} already has a portal account.', { email }));
    const uid = Number(db.run('INSERT INTO portal_users (brand_id, name, email, lang, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', brand.id, name, email, req.body.lang === 'ar' ? 'ar' : 'en', req.user.id, now()).lastInsertRowid);
    const t = issueToken(uid, 'invite', { reveal: true });
    const tokRow = db.get('SELECT rowid FROM portal_tokens WHERE id = ?', sha(t));
    const url = link(req, t, 'invite');
    const lang = req.body.lang === 'ar' ? 'ar' : 'en';
    const sent = await i18n.run(lang, () => mail(email, tr('por|Your Wave tenant portal account'), tr('por|Hello {name},\n\nThe Wave has opened a tenant portal account for {brand}. Set your password here: {url}\n\nThe link works for {days} days. In the portal you will find your invoices and receipts, can pay online, keep your documents up to date and read notices from the mall.\n\nThe Wave leasing office', { name, brand: brand.name, url, days: INVITE_DAYS })));
    h.log(req, 'Invited a tenant to the portal', 'brand', brand.id, `${name} · ${email}`);
    h.back(req, res, `${backTo.split('?')[0]}?link=${tokRow.rowid}${backTo.includes('/tenants/') ? '#portal' : ''}`, 'ok', sent ? tr('por|Invitation emailed to {email}.', { email }) : tr('por|Account created. Send them the link below.'));
  });
  router.post('/portal/users/:id/link', R('agent'), async (req, res, next) => {
    const u = db.get('SELECT * FROM portal_users WHERE id = ?', h.int(req.params.id));
    if (!u) return next();
    const purpose = u.password_hash ? 'reset' : 'invite';
    const t = issueToken(u.id, purpose, { reveal: true });
    const tokRow = db.get('SELECT rowid FROM portal_tokens WHERE id = ?', sha(t));
    const url = link(req, t, purpose);
    const sent = await i18n.run(u.lang || 'en', () => mail(u.email, purpose === 'invite' ? tr('por|Your Wave tenant portal account') : tr('por|Your Wave tenant portal password'),
      purpose === 'invite' ? tr('por|Set your tenant portal password here: {url}', { url }) : tr('por|Choose a new password for the tenant portal: {url}\n\nThe link works for two hours. If you did not ask for it, ignore this email.', { url })));
    h.log(req, purpose === 'invite' ? 'Sent a new portal invitation' : 'Sent a portal password link', 'brand', u.brand_id, u.email);
    const backTo = h.safeBack(req, '/admin/portal').split('?')[0];
    h.back(req, res, `${backTo}?link=${tokRow.rowid}`, 'ok', sent ? tr('por|Link emailed to {email}.', { email: u.email }) : tr('por|Send them the link below.'));
  });
  router.post('/portal/users/:id/toggle', R('manager'), (req, res, next) => {
    const u = db.get('SELECT * FROM portal_users WHERE id = ?', h.int(req.params.id));
    if (!u) return next();
    db.run('UPDATE portal_users SET active = ? WHERE id = ?', u.active ? 0 : 1, u.id);
    if (u.active) db.run('DELETE FROM portal_sessions WHERE portal_user_id = ?', u.id);
    h.log(req, u.active ? 'Disabled a portal account' : 'Enabled a portal account', 'brand', u.brand_id, u.email);
    h.back(req, res, h.safeBack(req, '/admin/portal'), 'ok', u.active ? tr('por|Account disabled.') : tr('por|Account enabled.'));
  });
  router.post('/portal/notices', R('agent'), (req, res) => {
    const titleEn = h.str(req.body.title_en, 160);
    const bodyEn = h.str(req.body.body_en, 4000);
    if (!titleEn || !bodyEn) return h.back(req, res, '/admin/portal', 'error', tr('por|A notice needs an English title and message.'));
    const brands = h.list(req.body.brands).map((x) => h.int(x)).filter(Boolean);
    const audience = req.body.audience === 'brands' && brands.length ? 'brands' : 'all';
    const expire = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.expire_at || '')) ? `${req.body.expire_at}T23:59:59.000Z` : null;
    const publish = !!req.body.publish;
    db.run('INSERT INTO portal_notices (title_en, title_ar, body_en, body_ar, audience, brand_ids, status, publish_at, expire_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      titleEn, h.str(req.body.title_ar, 160) || null, bodyEn, h.str(req.body.body_ar, 4000) || null, audience, audience === 'brands' ? brands.join(',') : null, publish ? 'published' : 'draft', publish ? now() : null, expire, req.user.id, now());
    h.log(req, publish ? 'Published a portal notice' : 'Drafted a portal notice', 'portal_notice', null, titleEn);
    h.back(req, res, '/admin/portal', 'ok', publish ? tr('por|Notice published.') : tr('Saved.'));
  });
  router.post('/portal/notices/:id/toggle', R('agent'), (req, res, next) => {
    const n = db.get('SELECT * FROM portal_notices WHERE id = ?', h.int(req.params.id));
    if (!n) return next();
    const pub = n.status !== 'published';
    db.run('UPDATE portal_notices SET status = ?, publish_at = ? WHERE id = ?', pub ? 'published' : 'draft', pub ? now() : n.publish_at, n.id);
    h.back(req, res, '/admin/portal', 'ok', pub ? tr('por|Notice published.') : tr('por|Notice withdrawn.'));
  });
  router.post('/portal/notices/:id/delete', R('agent'), (req, res) => {
    db.run('DELETE FROM portal_notices WHERE id = ?', h.int(req.params.id));
    h.back(req, res, '/admin/portal', 'ok', tr('por|Notice deleted.'));
  });
  router.post('/portal/settings', R('admin'), (req, res) => {
    for (const k of ['portal_instapay', 'portal_instapay_name', 'portal_bank', 'portal_bank_account', 'portal_iban']) db.setSetting(k, h.str(req.body[k], 160));
    h.log(req, 'Changed the payment instructions', 'settings', null, null);
    h.back(req, res, '/admin/portal', 'ok', tr('Saved.'));
  });

  // the "Portal access" card on each tenant file
  (h.tenantCards = h.tenantCards || []).push((req, b) => {
    const csrf = req.session.csrf;
    const users = db.all('SELECT u.*, ? brand FROM portal_users u WHERE u.brand_id = ? ORDER BY u.name', b.name, b.id);
    const form = h.can(req, 'agent') ? `<details class="pop pop--inline"><summary class="btn btn--ghost btn--sm">${ui.esc(tr('por|Invite'))}</summary>${ui.form('/admin/portal/invite', csrf, `<input type="hidden" name="brand_id" value="${b.id}"><div class="fields">${ui.input('name', tr('Name'), '', { required: true })}${ui.input('email', tr('Email'), '', { type: 'email', required: true })}${ui.select('lang', tr('por|Language'), [['en', 'English'], ['ar', 'العربية']], 'en')}</div>${ui.btn(tr('por|Send invitation'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    return `<div id="portal">${revealed(req)}${ui.card(tr('por|Portal access'), users.length ? usersTable(req, users, { brandCol: false, csrf }) : `<p class="muted pad">${ui.esc(tr('por|No one from this brand can sign in to the tenant portal yet.'))}</p>`, { action: form, sub: ui.esc(tr('por|Invoices, receipts, documents and notices, online.')) })}</div>`;
  });
};
