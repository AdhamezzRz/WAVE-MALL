'use strict';

// Sign-in sessions for the leasing office. The cookie holds a random token; the database holds
// only its SHA-256, with the user, the CSRF token and an expiry that slides while you work.

const crypto = require('node:crypto');
const { now } = require('./db');
const { t } = require('./i18n');

const COOKIE = 'wv_sess';
const FLASH = 'wv_flash';
const LOGIN = 'wv_login';
const LANG = 'wv_lang';
const TTL = 12 * 60 * 60 * 1000; // 12 hours idle
const RANK = { viewer: 0, agent: 1, manager: 2, admin: 3 };

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* ignore malformed */
      }
    }
  }
  return out;
}

function setCookie(req, res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/admin', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (req.secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}

function startSession(db, req, res, user) {
  const t = token();
  const csrf = token(24);
  db.run(
    'INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha(t), user.id, csrf, now(), new Date(Date.now() + TTL).toISOString(), req.ip, String(req.get('user-agent') || '').slice(0, 200),
  );
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
  db.run('DELETE FROM sessions WHERE expires_at < ?', now());
  setCookie(req, res, COOKIE, t, { maxAge: TTL });
}

function endSession(db, req, res) {
  const t = cookies(req)[COOKIE];
  if (t) db.run('DELETE FROM sessions WHERE id = ?', sha(t));
  setCookie(req, res, COOKIE, '', { maxAge: 0 });
}

// Attaches req.user and req.session when the cookie is valid.
function load(db) {
  return (req, res, next) => {
    const t = cookies(req)[COOKIE];
    if (t) {
      const s = db.get('SELECT * FROM sessions WHERE id = ?', sha(t));
      if (s && s.expires_at > now()) {
        const user = db.get('SELECT id, name, email, role, title, phone, active, lang, hr FROM users WHERE id = ?', s.user_id);
        if (user && user.active) {
          req.user = user;
          req.session = s;
          // slide the expiry at most once a minute
          if (Date.parse(s.expires_at) - Date.now() < TTL - 60000) {
            db.run('UPDATE sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() + TTL).toISOString(), s.id);
            setCookie(req, res, COOKIE, t, { maxAge: TTL });
          }
        }
      }
    }
    next();
  };
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.redirect(303, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.status(401).json({ ok: false, error: t('Please sign in again.') });
}

const allowed = (user, min) => !!user && RANK[user.role] >= RANK[min];
// The answer when someone may not do something: JSON for scripts, a message and a way back for pages.
function denied(req, res) {
  if (req.accepts(['html', 'json']) === 'json' && req.method !== 'GET') return res.status(403).json({ ok: false, error: t('Your role does not allow that.') });
  flash(req, res, 'error', t('Your role does not allow that.'));
  return res.redirect(303, req.get('referer') && String(req.get('referer')).includes('/admin') && !String(req.get('referer')).endsWith(req.originalUrl) ? req.get('referer') : '/admin');
}
function requireRole(min) {
  return (req, res, next) => {
    if (allowed(req.user, min)) return next();
    if (req.accepts(['html', 'json']) === 'json') return res.status(403).json({ ok: false, error: t('Your role does not allow that.') });
    flash(req, res, 'error', t('Your role does not allow that.'));
    return res.redirect(303, req.get('referer') && String(req.get('referer')).includes('/admin') ? req.get('referer') : '/admin');
  };
}

// Every change needs the session's CSRF token, from the form or the X-CSRF header.
function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = String((req.body && req.body._csrf) || req.get('x-csrf') || '');
  const want = req.session ? req.session.csrf : '';
  if (want && sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want))) return next();
  if (req.accepts(['html', 'json']) === 'json' && !req.is('urlencoded')) return res.status(403).json({ ok: false, error: t('This page has expired. Reload it and try again.') });
  return res.status(403).type('text').send(t('This form has expired. Go back, reload the page and try again.'));
}

// One-time messages after a redirect.
function flash(req, res, type, text) {
  setCookie(req, res, FLASH, JSON.stringify({ type, text: String(text).slice(0, 300) }), { maxAge: 60000 });
}
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

// The sign-in form gets its own double-submit token before any session exists.
function loginToken(req, res) {
  const t = token(18);
  setCookie(req, res, LOGIN, t, { maxAge: 30 * 60 * 1000 });
  return t;
}
function checkLoginToken(req) {
  const a = String(cookies(req)[LOGIN] || '');
  const b = String((req.body && req.body._token) || '');
  return a.length > 10 && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// The office language: ?lang= (remembered), else the person's choice, else the browser cookie, else English.
function language(db) {
  return (req, res, next) => {
    let l = null;
    const q = String(req.query.lang || '');
    if (req.method === 'GET' && (q === 'en' || q === 'ar')) {
      l = q;
      setCookie(req, res, LANG, q, { maxAge: 365 * 86400000 });
      if (req.user && req.user.lang !== q) db.run('UPDATE users SET lang = ? WHERE id = ?', q, req.user.id);
    }
    l = l || (req.user && req.user.lang) || cookies(req)[LANG];
    req.lang = l === 'ar' ? 'ar' : 'en';
    require('./i18n').run(req.lang, next);
  };
}
function setLanguage(db, req, res, l) {
  const v = l === 'ar' ? 'ar' : 'en';
  setCookie(req, res, LANG, v, { maxAge: 365 * 86400000 });
  if (req.user) db.run('UPDATE users SET lang = ? WHERE id = ?', v, req.user.id);
  return v;
}

module.exports = { denied, language, setLanguage, cookies, setCookie, startSession, endSession, load, requireUser, requireRole, allowed, csrf, flash, takeFlash, loginToken, checkLoginToken, RANK, token };
