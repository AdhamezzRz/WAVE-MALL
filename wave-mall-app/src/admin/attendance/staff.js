'use strict';

// The staff app at /staff: each employee clocks in and out on their own phone, inside the mall's
// circle. Sign-in with the employee code and a 6-digit PIN from HR (or straight from the office
// for someone whose account is linked to their employee record). The first phone is registered to
// the person; another phone needs HR's approval, so nobody can clock in for someone else from their
// own phone. Separate cookies (path /staff) from the office and the tenant portal.
//
// The page reads the position several times (up to ~20 s) and sends the best reading with the time
// the phone took it; the server decides (attendance/engine.js). While clocked in with the page
// open, the position is sent every few minutes. A page cannot track anyone once it is closed, and
// the office says so ("app closed since …") instead of guessing.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const E = require('./engine');

const { t: tr, tn, tx } = i18n;

const COOKIE = 'wv_staff';
const DEVICE = 'wv_sdev';
const LANG = 'wv_slang';
const FLASH = 'wv_sflash';
const TTL = 14 * 86400000;

module.exports = function staff(h, S, V) {
  const { db, ui } = h;
  const esc = ui.esc;
  const now = () => new Date().toISOString();
  const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
  const sr = express.Router();
  h.public.use('/staff', sr);
  sr.use(express.urlencoded({ extended: false, limit: '32kb' }));
  sr.use(express.json({ limit: '700kb' }));
  sr.use((req, res, next) => {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Permissions-Policy': 'geolocation=(self), camera=(self)' });
    next();
  });

  // ---------- cookies ----------
  const cookies = (req) => h.auth.cookies(req);
  function setCookie(req, res, name, value, { maxAge } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/staff', 'SameSite=Lax', 'HttpOnly'];
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
    try { return JSON.parse(raw); } catch { return null; }
  }
  const back = (req, res, url, type, text) => { if (text) flash(req, res, type, text); res.redirect(303, url); };

  // ---------- language ----------
  sr.use((req, res, next) => {
    const q = String(req.query.lang || '');
    let l = null;
    if (req.method === 'GET' && (q === 'en' || q === 'ar')) { l = q; setCookie(req, res, LANG, q, { maxAge: 365 * 86400000 }); }
    l = l || cookies(req)[LANG] || (/^ar\b/i.test(String(req.get('accept-language') || '')) ? 'ar' : 'en');
    req.lang = l === 'ar' ? 'ar' : 'en';
    i18n.run(req.lang, next);
  });

  // ---------- sessions ----------
  function startSession(req, res, e, device) {
    const t = token();
    db.run('INSERT INTO att_logins (id, employee_id, device_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', S.sha(t), e.id, device.id, token(24), now(), new Date(Date.now() + TTL).toISOString());
    db.run('UPDATE att_creds SET last_login_at = ? WHERE employee_id = ?', now(), e.id);
    setCookie(req, res, COOKIE, t, { maxAge: TTL });
  }
  sr.use((req, res, next) => {
    const t = cookies(req)[COOKIE];
    if (t) {
      const s = db.get('SELECT * FROM att_logins WHERE id = ?', S.sha(t));
      const dev = s && s.device_id ? db.get('SELECT * FROM att_devices WHERE id = ?', s.device_id) : null;
      const devTok = cookies(req)[DEVICE];
      // the session lives only on the phone it was opened on, and only while that phone is approved
      if (s && s.expires_at > now() && dev && dev.status === 'active' && devTok && S.sha(devTok) === dev.token_hash) {
        const e = db.get("SELECT e.*, d.name dept FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ? AND e.status = 'active'", s.employee_id);
        if (e) {
          req.emp = e;
          req.slogin = s;
          req.device = dev;
          if (Date.parse(s.expires_at) - Date.now() < TTL - 3600000) {
            db.run('UPDATE att_logins SET expires_at = ? WHERE id = ?', new Date(Date.now() + TTL).toISOString(), s.id);
            setCookie(req, res, COOKIE, t, { maxAge: TTL });
          }
        }
      }
    }
    next();
  });
  function need(req, res, next) {
    if (!req.emp) {
      if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.redirect(303, '/staff/login');
      return res.status(401).json({ ok: false, error: tr('att|Please sign in again.') });
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const sent = String((req.body && req.body._csrf) || req.get('x-csrf') || '');
      const want = req.slogin.csrf;
      if (!(sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want)))) {
        if (req.is('json')) return res.status(403).json({ ok: false, error: tr('att|This page has expired. Reload it and try again.') });
        return res.status(403).type('text').send(tr('att|This page has expired. Reload it and try again.'));
      }
    }
    const c = S.credsOf(req.emp.id);
    if ((!c || !c.consent_at || c.consent_version < S.CONSENT_VERSION) && !req.path.startsWith('/consent') && req.path !== '/logout') {
      if (req.method === 'GET') return res.redirect(303, '/staff/consent');
      return res.status(403).json({ ok: false, error: tr('att|Read and accept the notice first.') });
    }
    return next();
  }

  // ---------- the shell ----------
  const nm = (e) => S.nameOf(e);
  const langSwitch = (req) => {
    const other = req.lang === 'ar' ? 'en' : 'ar';
    const p = req.originalUrl.replace(/([?&])lang=(en|ar)(&|$)/, '$1').replace(/[?&]$/, '');
    return `<a class="langbtn" href="${esc(p)}${p.includes('?') ? '&' : '?'}lang=${other}" lang="${other}">${ui.icon('globe')}<span>${other === 'ar' ? 'العربية' : 'English'}</span></a>`;
  };
  const head = (title) => `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · ${esc(tr('att|The Wave · Staff'))}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/admin/admin.css?v=${ui.ASSETS.css}">${ui.pwaHead('staff')}`;
  function page(req, res, { title, body, tab = '', status = 200, data = '' }) {
    const f = takeFlash(req, res);
    const toast = f ? `<div class="toast toast--${esc(f.type || 'ok')}" role="status" data-toast>${ui.icon(f.type === 'error' ? 'log' : 'check')}<span>${esc(f.text)}</span></div>` : '';
    const tabs = req.emp ? `<nav class="att-stabs" aria-label="${esc(tr('att|Staff app'))}">${[['/staff', 'log', 'att|Today'], ['/staff/month', 'cal', 'att|My month'], ['/staff/fix', 'wrench', 'att|Fix a time']].map(([href, ic, l]) => `<a href="${href}" class="${tab === href ? 'is-on' : ''}"${tab === href ? ' aria-current="page"' : ''}>${ui.icon(ic)}<span>${esc(tr(l))}</span></a>`).join('')}</nav>` : '';
    res.status(status).type('html').send(`<!doctype html><html lang="${req.lang}" dir="${req.lang === 'ar' ? 'rtl' : 'ltr'}"><head>${head(title)}${req.slogin ? `<meta name="csrf" content="${esc(req.slogin.csrf)}">` : ''}</head>
<body class="adm att-staff${req.emp ? ' has-stabs' : ''}" data-lang="${req.lang}">
<header class="att-sbar"><a href="/staff" class="att-sbar__logo" aria-label="The Wave">${ui.logo()}</a><span class="att-sbar__t">${esc(tr('att|Staff'))}</span>${langSwitch(req)}${req.emp ? `<form method="post" action="/staff/logout"><input type="hidden" name="_csrf" value="${esc(req.slogin.csrf)}"><button class="iconbtn" title="${esc(tr('Sign out'))}" aria-label="${esc(tr('Sign out'))}">${ui.icon('out')}</button></form>` : ''}</header>
${toast}<main class="att-smain"${data}>${body}</main>${tabs}
<script src="/admin/admin.js?v=${ui.ASSETS.js}" defer></script><script src="/admin/staff.js?v=${ui.ASSETS.staff || '0'}" defer></script></body></html>`);
  }

  // ---------- signing in ----------
  function formToken(req, res) {
    const t = token(18);
    setCookie(req, res, 'wv_slogin', t, { maxAge: 30 * 60000 });
    return t;
  }
  const checkFormToken = (req) => {
    const a = String(cookies(req).wv_slogin || '');
    const b = String((req.body && req.body._token) || '');
    return a.length > 10 && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  };
  function loginPage(req, res, { error = '', code = '', status = 200 } = {}) {
    const tok = formToken(req, res);
    page(req, res, {
      title: tr('att|Sign in'), status,
      body: `<section class="att-signin"><div class="att-signin__art">${ui.logo('att-signin__logo')}<p>${esc(tr('att|Clock in and out at The Wave from your own phone.'))}</p></div>
        <form method="post" action="/staff/login" class="stack att-signin__form" autocomplete="off"><input type="hidden" name="_token" value="${esc(tok)}">
          <h1>${esc(tr('att|Sign in'))}</h1>${error ? `<p class="alert alert--error">${esc(error)}</p>` : ''}
          ${ui.input('code', tr('att|Employee code'), code, { required: true, placeholder: 'EMP-0001', attrs: { autocapitalize: 'characters', dir: 'ltr', autocomplete: 'username' } })}
          ${ui.input('pin', tr('att|PIN (6 digits)'), '', { type: 'password', required: true, attrs: { inputmode: 'numeric', pattern: '\\d{6}', maxlength: 6, autocomplete: 'current-password', dir: 'ltr' } })}
          ${ui.btn(esc(tr('att|Sign in')), { cls: 'btn--primary btn--block' })}
          <p class="muted small">${esc(tr('att|No PIN yet? Ask HR for one. The first phone you sign in on becomes your phone.'))}</p></form></section>`,
    });
  }
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false, handler: (req, res) => loginPage(req, res, { error: tr('att|Too many tries. Wait a few minutes and try again.'), status: 429 }) });
  sr.get('/login', (req, res) => (req.emp ? res.redirect(303, '/staff') : loginPage(req, res)));
  // after the PIN (or the office hand-off): which phone is this?
  function admit(req, res, e) {
    const d = S.deviceFor(e, cookies(req)[DEVICE], { agent: req.get('user-agent'), ip: req.ip, demo: 0 });
    if (d.token) setCookie(req, res, DEVICE, d.token, { maxAge: 2 * 365 * 86400000 });
    if (d.state === 'active' || d.state === 'new_first') {
      startSession(req, res, e, d.device);
      return res.redirect(303, '/staff');
    }
    const text = d.state === 'revoked' ? tr('att|This phone was removed from your account. Ask HR.') : tr('att|This is not your registered phone. HR has been asked to approve it; try again once they have.');
    return page(req, res, { title: tr('att|Phone not approved'), status: 403, body: `<section class="att-wait">${ui.icon('phone')}<h1>${esc(tr('att|Phone not approved yet'))}</h1><p>${esc(text)}</p><p class="muted small">${esc(tr('att|Phone: {label}', { label: d.device.label || '—' }))}</p><a class="btn btn--ghost" href="/staff/login">${esc(tr('att|Back'))}</a></section>` });
  }
  sr.post('/login', limiter, (req, res) => {
    const code = String(req.body.code || '').trim().slice(0, 30);
    if (!checkFormToken(req)) return loginPage(req, res, { error: tr('att|This page has expired. Reload it and try again.'), code, status: 403 });
    const r = S.checkPin(code, String(req.body.pin || ''));
    if (!r.ok) {
      const msg = r.reason === 'locked' ? tr('att|Too many wrong PINs. Try again after {time}, or ask HR.', { time: V.hm(r.until) })
        : r.reason === 'no_pin' ? tr('att|You have no PIN yet. Ask HR for one.')
          : r.reason === 'wrong' ? tn(r.left, 'att|Wrong code or PIN. {n} try left.', 'att|Wrong code or PIN. {n} tries left.') : tr('att|Wrong code or PIN.');
      return loginPage(req, res, { error: msg, code, status: 401 });
    }
    return admit(req, res, r.e);
  });
  // from the office (/admin/me/clock): a one-time link, valid two minutes
  sr.get('/handoff/:token', (req, res) => {
    const row = db.get('SELECT * FROM att_handoffs WHERE id = ?', S.sha(req.params.token));
    if (!row || row.used_at || row.expires_at < now()) return loginPage(req, res, { error: tr('att|That link has expired. Sign in with your code and PIN.'), status: 410 });
    db.run('UPDATE att_handoffs SET used_at = ? WHERE id = ?', now(), row.id);
    const e = db.get("SELECT * FROM employees WHERE id = ? AND status = 'active'", row.employee_id);
    if (!e) return loginPage(req, res, { status: 403 });
    return admit(req, res, e);
  });
  sr.post('/logout', need, (req, res) => {
    db.run('DELETE FROM att_logins WHERE id = ?', req.slogin.id);
    setCookie(req, res, COOKIE, '', { maxAge: 0 });
    res.redirect(303, '/staff/login');
  });

  // ---------- the notice ----------
  sr.get('/consent', need, (req, res) => {
    const f = S.fence();
    page(req, res, {
      title: tr('att|Before you start'),
      body: `<section class="att-consent"><h1>${esc(tr('att|Before you start'))}</h1>
        <ul class="att-consent__list">
          <li>${ui.icon('gauge')}<span>${esc(tr('att|When you clock in, take a break or clock out, the app reads your phone’s position to check you are within {m} of the mall.', { m: tr('att|{m} m', { m: f.radius }) }))}</span></li>
          <li>${ui.icon('log')}<span>${esc(tr('att|While you are clocked in and the app is open, it sends your position every {n} minutes. It never tracks you when you are clocked out or the app is closed.', { n: S.num('att_ping_min') }))}</span></li>
          ${S.selfieOn() ? `<li>${ui.icon('cam')}<span>${esc(tr('att|When you clock in and out, it takes a photo with the front camera to confirm it is you.'))}</span></li>` : ''}
          <li>${ui.icon('shield')}<span>${esc(tr('att|Only HR and your manager see this. It is used for attendance and pay, and kept as the law requires (Egypt’s Personal Data Protection Law, 151 of 2020). You can ask HR to see it.'))}</span></li>
          <li>${ui.icon('phone')}<span>${esc(tr('att|This phone is now registered to you. Do not let anyone else clock in with it.'))}</span></li>
        </ul>
        <form method="post" action="/staff/consent"><input type="hidden" name="_csrf" value="${esc(req.slogin.csrf)}">${ui.btn(esc(tr('att|I understand and agree')), { cls: 'btn--primary btn--block' })}</form></section>`,
    });
  });
  sr.post('/consent', need, (req, res) => {
    db.run('UPDATE att_creds SET consent_at = ?, consent_version = ? WHERE employee_id = ?', now(), S.CONSENT_VERSION, req.emp.id);
    if (!db.get('SELECT employee_id FROM att_creds WHERE employee_id = ?', req.emp.id)) db.run('INSERT INTO att_creds (employee_id, consent_at, consent_version) VALUES (?, ?, ?)', req.emp.id, now(), S.CONSENT_VERSION);
    res.redirect(303, '/staff');
  });

  // ---------- today ----------
  function state(e, t = now()) {
    const date = S.currentDate(e, t);
    const d = S.dayOf(e, date, t);
    const last = S.lastValid(e.id);
    const allowed = E.nextAllowed(last ? last.kind : null);
    return { date, d, allowed, open: d.open, onBreak: d.onBreak };
  }
  const greet = (t) => {
    const hr = Math.floor(E.cairo(t).min / 60);
    return hr < 12 ? 'att|Good morning, {name}' : hr < 17 ? 'att|Good afternoon, {name}' : 'att|Good evening, {name}';
  };
  sr.get('/', need, (req, res) => {
    const e = req.emp;
    const t = now();
    S.autoClose(e, t);
    const st = state(e, t);
    const d = st.d;
    const f = S.fence();
    const first = (nm(e) || '').split(/\s+/)[0];
    const ring = d.open
      ? `<div class="att-ring att-ring--${d.onBreak ? 'break' : 'on'}"><small>${esc(d.onBreak ? tr('att|On a break since') : tr('att|Working since'))}</small><b>${esc(d.onBreak ? V.hm(d.spans[d.spans.length - 1].breaks.slice(-1)[0].start) : V.hm(d.spans[d.spans.length - 1].in))}</b><span class="att-worked" ${d.onBreak ? '' : `data-live-from="${esc(new Date(Date.now() - d.workedMin * 60000).toISOString())}"`}>${esc(V.dur(d.workedMin))}</span></div>`
      : `<div class="att-ring att-ring--off"><small>${esc(d.status === 'done' ? tr('att|Clocked out at') : tr('att|Not clocked in'))}</small><b>${esc(d.status === 'done' ? V.hm(d.lastOut) : '—')}</b><span>${esc(d.workedMin ? V.dur(d.workedMin) : d.on ? tr('att|Shift {time}', { time: `${V.hm(d.on.start)}–${V.hm(d.on.end)}` }) : tr('att|No shift today'))}</span></div>`;
    const buttons = ['in', 'break_start', 'break_end', 'out'].filter((k) => st.allowed.includes(k)).map((k, i) => `<button type="button" class="btn ${i === 0 ? 'btn--primary' : 'btn--ghost'} att-act att-act--${k}" data-kind="${k}" disabled>${ui.icon(k === 'in' ? 'log' : k === 'out' ? 'out' : 'leave')}<span>${esc(tr(S.LABEL[k]))}</span></button>`).join('');
    const punches = S.punchesOn(e.id, st.date, { all: true });
    const list = punches.length ? `<ol class="att-slist">${punches.map((p) => `<li class="${p.status === 'rejected' ? 'is-refused' : ''}${p.voided_at ? ' is-void' : ''}"><b>${esc(V.hm(p.at))}</b><span>${esc(tr({ in: 'att|Clocked in', out: 'att|Clocked out', break_start: 'att|Break started', break_end: 'att|Break ended' }[p.kind]))}${p.status === 'rejected' ? ` · ${esc(tr('att|refused'))}` : p.source === 'auto' ? ` · ${esc(tr('att|closed by the system'))}` : ''}</span>${p.distance !== null ? `<small>${esc(tr('att|{m} m', { m: Math.round(p.distance) }))}</small>` : ''}</li>`).join('')}</ol>` : `<p class="muted">${esc(tr('att|Nothing yet today.'))}</p>`;
    // this week, Monday to Sunday
    const monday = E.addDays(st.date, 1 - E.isoDay(st.date));
    const week = [];
    for (let i = 0; i < 7; i++) {
      const date = E.addDays(monday, i);
      const x = date <= E.cairo(t).date ? S.dayOf(e, date, t) : null;
      week.push({ date, worked: x ? x.workedMin : 0, sched: x && x.on ? x.on.net : 0, late: x ? x.lateMin : 0, today: date === st.date });
    }
    const maxMin = Math.max(480, ...week.map((w) => Math.max(w.worked, w.sched)));
    const weekHtml = `<div class="att-week">${week.map((w, i) => `<div class="att-week__d${w.today ? ' is-today' : ''}"><span class="att-week__bar" style="--h:${((w.worked / maxMin) * 100).toFixed(1)}%;--s:${((w.sched / maxMin) * 100).toFixed(1)}%"><i></i></span><b>${esc(V.shortDays()[i])}</b><small>${w.worked ? esc(V.hours(w.worked)) : ''}</small></div>`).join('')}</div>`;
    const tot = week.reduce((s, w) => s + w.worked, 0);
    const bal = h.hrBalance ? h.hrBalance(e) : null;
    const lateMonth = (() => { let n = 0; const key = st.date.slice(0, 7); for (let i = 1; i <= Number(st.date.slice(8)); i++) { const x = S.dayOf(e, `${key}-${String(i).padStart(2, '0')}`, t); if (x.lateMin) n++; } return n; })();
    const i18nData = {
      finding: tr('att|Finding your location…'), inside: tr('att|You are {m} from the mall — inside'), outside: tr('att|You are {m} from the mall — outside the circle'),
      weak: tr('att|Location not precise yet: ±{m}'), denied: tr('att|Location is blocked. Allow it for this site in the browser settings.'), unsupported: tr('att|This phone cannot share its location.'),
      sending: tr('att|Sending…'), camera: tr('att|Take a photo to confirm it is you'), snap: tr('att|Take the photo'), retake: tr('att|Again'), cancel: tr('att|Cancel'), use: tr('att|Use this photo'),
      noCamera: tr('att|The camera could not start. Allow the camera for this site.'), m: tr('att|{m} m'), acc: tr('att|±{m} m'), offline: tr('att|No connection. Try again.'), waitBetter: tr('att|Waiting for a more precise position…'),
      durM: tr('att|{m} min'), durHM: tr('att|{h} h {m} min'), durH: tr('att|{h} h'),
    };
    const data = ` data-staff data-csrf="${esc(req.slogin.csrf)}" data-lat="${S.fenceSet() ? f.lat : ''}" data-lng="${S.fenceSet() ? f.lng : ''}" data-radius="${f.radius}" data-maxacc="${f.maxAccuracy}" data-selfie="${S.selfieOn() ? '1' : ''}" data-ping="${S.num('att_ping_min')}" data-open="${d.open ? '1' : ''}" data-i18n="${esc(JSON.stringify(i18nData))}"`;
    page(req, res, {
      title: tr('att|Today'), tab: '/staff', data,
      body: `<section class="att-today">
        <p class="att-hello">${esc(tr(greet(t), { name: first }))}<small>${esc(ui.date(st.date))}${d.on ? ` · ${esc(tr('att|Shift {time}', { time: `${V.hm(d.on.start)}–${V.hm(d.on.end)}` }))}` : ''}</small></p>
        ${ring}
        ${!S.fenceSet() ? `<p class="alert alert--error">${esc(tr(S.ADVICE.no_fence))}</p>` : ''}
        <div class="att-where" data-where><span class="att-where__dot"></span><span data-where-text>${esc(tr('att|Finding your location…'))}</span><span class="att-where__acc"><i data-acc-bar></i></span></div>
        <div class="att-acts">${buttons}</div>
        <div class="att-result" data-result role="status" aria-live="polite"></div>
        <div class="att-cam" data-cam hidden><video playsinline muted autoplay data-video></video><canvas data-canvas hidden></canvas><img alt="" data-shot hidden><p data-cam-text></p><div class="row"><button type="button" class="btn btn--primary" data-snap></button><button type="button" class="btn btn--ghost" data-cam-cancel></button></div></div>
        <p class="muted small att-honest">${esc(d.open ? tr('att|Keep this page open while you work: it sends your position every {n} minutes. When it is closed, the office sees “app closed”.', { n: S.num('att_ping_min') }) : tr('att|Your position is checked only when you press a button.'))}</p>
      </section>
      <section class="card att-scard"><h2>${esc(tr('att|Today'))}</h2>${list}</section>
      <section class="card att-scard"><h2>${esc(tr('att|This week · {h} h', { h: V.hours(tot) }))}</h2>${weekHtml}
        <div class="att-mini">${bal ? `<div class="att-stat"><small>${esc(tr('att|Leave left'))}</small><b>${esc(String(bal.remaining))}</b></div>` : ''}<div class="att-stat"><small>${esc(tr('att|Late this month'))}</small><b>${lateMonth}</b></div><div class="att-stat"><small>${esc(tr('att|Your phone'))}</small><b>${esc(req.device.label || '—')}</b></div></div></section>`,
    });
  });

  // ---------- clocking and location (JSON) ----------
  const reading = (b) => ({ lat: Number(b.lat), lng: Number(b.lng), accuracy: Number(b.accuracy), at: Number(b.taken) || null });
  sr.post('/punch', need, (req, res) => {
    const e = req.emp;
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!S.KINDS.includes(kind)) return res.status(400).json({ ok: false, error: tr('att|Choose what to record.') });
    let selfie = null;
    if (b.selfie && typeof b.selfie === 'string') {
      const m = b.selfie.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      const buf = m ? Buffer.from(m[1], 'base64') : null;
      if (buf && buf.length <= 500 * 1024) {
        const saved = h.files.save(buf, `clock-${e.code}.jpg`);
        if (!saved.error && saved.ext === 'jpg') selfie = saved.stored;
      }
    }
    const r = S.clock(e, { kind, reading: reading(b), sentAt: Number(b.sent) || null, deviceId: req.device.id, ip: req.ip, agent: req.get('user-agent'), selfie, source: 'app' });
    const st = state(e);
    const advice = r.reasons.map((c) => tr(S.ADVICE[c] || S.REASONS[c] || c));
    const okText = { in: tr('att|Clocked in at {time}. Have a good shift.', { time: V.hm(r.punch.at) }), break_start: tr('att|Break started at {time}.', { time: V.hm(r.punch.at) }), break_end: tr('att|Welcome back. Break ended at {time}.', { time: V.hm(r.punch.at) }), out: tr('att|Clocked out at {time}. Thank you.', { time: V.hm(r.punch.at) }) }[kind];
    res.json({
      ok: r.ok, status: r.status, distance: r.distance === null ? null : Math.round(r.distance),
      message: r.ok ? okText : tr('att|Not recorded.'), advice: [...new Set(advice)], flags: r.flags.map((c) => tr(S.FLAGS[c] || c)),
      allowed: st.allowed, open: st.open,
    });
  });
  sr.post('/ping', need, (req, res) => {
    const r = S.ping(req.emp, { reading: reading(req.body || {}), visible: !!(req.body && req.body.visible), deviceId: req.device.id });
    res.json({ ok: r.ok, inside: r.inside ?? null, distance: r.distance ?? null, open: !!S.openDay(req.emp.id) });
  });

  // ---------- my month ----------
  sr.get('/month', need, (req, res) => {
    const e = req.emp;
    const t = now();
    const key = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : E.cairo(t).date.slice(0, 7);
    const n = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
    const days = {};
    const rows = [];
    let worked = 0;
    let late = 0;
    let absent = 0;
    for (let i = 1; i <= n; i++) {
      const date = `${key}-${String(i).padStart(2, '0')}`;
      if (date > E.cairo(t).date) { days[date] = { status: 'upcoming' }; continue; }
      const d = S.dayOf(e, date, t);
      days[date] = { status: d.status, worked: d.workedMin, late: d.lateMin, incomplete: d.incomplete, short: { absent: tr('att|Absent'), leave: tr('att|Leave'), holiday: tr('att|Holiday') }[d.status] || '' };
      worked += d.workedMin;
      if (d.lateMin) late++;
      if (d.status === 'absent') absent++;
      if (d.spans.length || ['absent', 'leave', 'holiday'].includes(d.status)) rows.push(`<li><b>${esc(ui.date(date))}</b><span>${d.spans.length ? esc(`${V.hm(d.firstIn)}–${d.lastOut ? V.hm(d.lastOut) : '…'} · ${V.dur(d.workedMin)}`) : esc(tr(S.STATUS[d.status][0]))}${d.lateMin ? ` · <em>${esc(tr('att|late {n} min', { n: d.lateMin }))}</em>` : ''}${d.incomplete ? ` · <em>${esc(tr('att|closed by the system'))}</em>` : ''}</span></li>`);
    }
    const prev = E.addDays(`${key}-01`, -1).slice(0, 7);
    const next = E.addDays(`${key}-28`, 5).slice(0, 7);
    page(req, res, {
      title: tr('att|My month'), tab: '/staff/month',
      body: `<section class="card att-scard"><div class="att-monthnav"><a href="?month=${prev}">${ui.icon('back')}</a><b>${esc(ui.monthYear(key))}</b>${key < E.cairo(t).date.slice(0, 7) ? `<a href="?month=${next}">${ui.icon('arrow')}</a>` : '<span></span>'}</div>${V.month(key, days, { today: E.cairo(t).date })}
        <div class="att-mini"><div class="att-stat"><small>${esc(tr('att|Worked'))}</small><b>${esc(tr('att|{h} h', { h: V.hours(worked) }))}</b></div><div class="att-stat"><small>${esc(tr('att|Late'))}</small><b>${late}</b></div><div class="att-stat"><small>${esc(tr('att|Absent'))}</small><b>${absent}</b></div></div></section>
        <section class="card att-scard"><h2>${esc(tr('att|Day by day'))}</h2>${rows.length ? `<ol class="att-slist">${rows.reverse().join('')}</ol>` : `<p class="muted">${esc(tr('att|Nothing this month yet.'))}</p>`}</section>`,
    });
  });

  // ---------- asking for a correction ----------
  sr.get('/fix', need, (req, res) => {
    const e = req.emp;
    const t = now();
    const mine = db.all("SELECT * FROM apr_requests WHERE kind = 'attendance' AND entity = 'employee' AND entity_id = ? ORDER BY created_at DESC LIMIT 10", e.id);
    const STATUS = { pending: ['att|Waiting for HR', 'amber'], approved: ['att|Approved', 'ok'], rejected: ['att|Not approved', 'rose'], withdrawn: ['att|Withdrawn', 'mute'] };
    const list = mine.length ? `<ol class="att-slist">${mine.map((r) => { const p = S.parse(r.payload, {}); return `<li><b>${esc(p.work_date ? ui.date(p.work_date) : '')}</b><span>${esc(tr(S.LABEL[p.kind] || ''))} · ${esc(p.at ? V.hm(p.at) : '')}</span>${ui.badge(r.status, tr((STATUS[r.status] || STATUS.pending)[0]), (STATUS[r.status] || STATUS.pending)[1])}</li>`; }).join('')}</ol>` : `<p class="muted">${esc(tr('att|No requests yet.'))}</p>`;
    page(req, res, {
      title: tr('att|Fix a time'), tab: '/staff/fix',
      body: `<section class="card att-scard"><h2>${esc(tr('att|Forgot to clock, or clocked wrong?'))}</h2><p class="muted small">${esc(tr('att|Tell HR what really happened. It changes your record only when HR approves it.'))}</p>
        <form method="post" action="/staff/fix" class="stack"><input type="hidden" name="_csrf" value="${esc(req.slogin.csrf)}">
          ${ui.input('date', tr('att|The work day'), E.cairo(t).date, { type: 'date', required: true, max: E.cairo(t).date, min: E.addDays(E.cairo(t).date, -31) })}
          ${ui.select('kind', tr('att|What'), S.KINDS.map((k) => [k, tr(S.LABEL[k])]), 'out')}
          ${ui.input('time', tr('att|The real time'), '', { type: 'time', required: true })}
          ${ui.textarea('reason', tr('att|What happened'), '', { rows: 3, placeholder: tr('att|e.g. My phone died at the end of the shift.') })}
          ${ui.btn(esc(tr('att|Send to HR')), { cls: 'btn--primary btn--block' })}</form></section>
        <section class="card att-scard"><h2>${esc(tr('att|Your requests'))}</h2>${list}</section>`,
    });
  });
  sr.post('/fix', need, (req, res) => {
    const e = req.emp;
    const b = req.body;
    const td = E.cairo(now()).date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) || b.date > td || b.date < E.addDays(td, -31) || !S.KINDS.includes(b.kind) || E.hmMin(b.time) === null) return back(req, res, '/staff/fix', 'error', tr('att|Choose the day, what and the time.'));
    const reason = h.str(b.reason, 500);
    if (!reason) return back(req, res, '/staff/fix', 'error', tr('att|Say what happened.'));
    if (!h.approvals) return back(req, res, '/staff/fix', 'error', tr('att|Corrections are not available. Ask HR.'));
    const on = S.onOf(e.id, b.date);
    let at = E.cairoAt(b.date, b.time);
    if (on && on.overnight && Date.parse(at) < Date.parse(on.start) - 3 * 3600000) at = E.cairoAt(E.addDays(b.date, 1), b.time);
    if (Date.parse(at) > Date.now() + 60000) return back(req, res, '/staff/fix', 'error', tr('att|That time has not come yet.'));
    if (db.value("SELECT COUNT(*) FROM apr_requests WHERE kind = 'attendance' AND entity = 'employee' AND entity_id = ? AND status = 'pending'", e.id) >= 5) return back(req, res, '/staff/fix', 'error', tr('att|You already have 5 requests waiting. Wait for HR.'));
    const user = e.user_id ? db.get('SELECT * FROM users WHERE id = ? AND active = 1', e.user_id) : null;
    h.approvals.request({ kind: 'attendance', title: `Attendance correction: ${e.name} · ${b.kind} ${b.time} on ${b.date}`, entity: 'employee', entity_id: e.id, link: `/admin/attendance/people/${e.id}?date=${b.date}`, payload: { employee_id: e.id, kind: b.kind, at, work_date: b.date, reason }, note: reason, user });
    back(req, res, '/staff/fix', 'ok', tr('att|Sent. HR will look at it.'));
  });
};
