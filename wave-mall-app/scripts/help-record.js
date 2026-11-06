#!/usr/bin/env node
'use strict';

// Records the Help & training videos from the lesson scripts in src/admin/help/lessons.
//
//   node scripts/help-record.js                      every lesson, English and Arabic
//   node scripts/help-record.js --only=leads-new,offers-new --lang=ar
//   node scripts/help-record.js --area=sales         one area
//   node scripts/help-record.js --check              walk every step fast without recording (selectors, both languages)
//   node scripts/help-record.js --port=3810          the port of the app it boots (default 3810)
//
// For each lesson and language it boots a fresh copy of the office in memory with the sample data,
// signs in as an administrator, plays the steps in Chromium at 1280×720 with an animated cursor,
// click ripples and a spotlight, captures the frames over the DevTools screencast, and writes to
// public/admin/help-media/<lang>/<id>.mp4 (H.264 + a synthesized click/typing sound track), .vtt
// (captions), .json (transcript cues with times) and .jpg (poster), then updates manifest.json.
// A step whose target cannot be found stops the lesson with the lesson id and step number.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const help = require(path.join(ROOT, 'src', 'admin', 'help'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const PORT = Number(args.port || 3810);
const LANGS = args.lang && args.lang !== 'both' ? [args.lang] : ['en', 'ar'];
const CHECK = !!args.check;
const W = 1280;
const H = 720;
const DSF = Number(args.dsf || 1.5);
const FPS = 25;
const CRF = Number(args.crf || 30);
const VERBOSE = !!args.verbose;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (x, lang) => help.textOf(x, lang);
// reading time of a line: about 2.6 words a second (2.3 in Arabic), never under 2.2 s
const readMs = (text, lang) => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2200, Math.round((words / (lang === 'ar' ? 2.3 : 2.6)) * 1000) + 500);
};
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- the office, booted for one lesson
// a failed start (a fetch that did not go through) closes its server and tries once more, so the
// port is free for the next lesson
async function boot(port, tries = 2) {
  try { return await bootOnce(port); } catch (e) {
    if (tries <= 1) throw e;
    await sleep(1500);
    return boot(port, tries - 1);
  }
}
async function bootOnce(port) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'src'))) delete require.cache[k];
  const { createApp } = require(path.join(ROOT, 'src', 'app'));
  // the sample tenants' portal password (read by src/admin/demo-portal.js)
  process.env.PORTAL_DEMO_PASSWORD = process.env.PORTAL_DEMO_PASSWORD || 'portal-demo-pass-1';
  const app = createApp({ env: { ADMIN_DB: ':memory:', ADMIN_JOBS: '0', SITE_URL: `http://127.0.0.1:${port}`, PAYMENTS_MODE: 'sandbox', PORTAL_DEMO_PASSWORD: 'portal-demo-1' }, mail: async () => ({ delivered: true }) });
  const server = app.listen(port);
  await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
  try { return await signIn(app, server, port); } catch (e) { await new Promise((r) => server.close(r)); throw e; }
}
async function signIn(app, server, port) {
  await app.locals.admin.ready;
  const base = `http://127.0.0.1:${port}`;
  const jar = new Map();
  const go = async (p, opts = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (/Max-Age=0/i.test(c)) jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
  const post = (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  const setup = await (await go('/admin/setup')).text();
  const tok = (setup.match(/name="_token" value="([^"]+)"/) || [])[1];
  await post('/admin/setup', { _token: tok, name: 'Mona Kamal', email: 'admin@thewave.test', password: 'long-enough-1' });
  const csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
  await post('/admin/settings/demo', { _csrf: csrf });
  const { db, h } = app.locals.admin;
  // a sample tenant signed in to the portal too, for the portal lessons
  const tenant = db.get('SELECT email FROM portal_users WHERE demo = 1 AND password_hash IS NOT NULL AND active = 1 ORDER BY id LIMIT 1');
  if (tenant) {
    const lp = await (await go('/portal/login')).text();
    const pt = (lp.match(/name="_token" value="([^"]+)"/) || [])[1];
    await post('/portal/login', { ...(pt ? { _token: pt } : {}), email: tenant.email, password: db.setting('portal_demo_password') || process.env.PORTAL_DEMO_PASSWORD });
  }
  // show (and so consume) the "sample data loaded" notices before the videos start
  await go('/admin');
  if (tenant) await go('/portal');
  const cookies = [...jar].filter(([name]) => !/flash/i.test(name)).map(([name, value]) => ({ name, value, url: base }));
  return { app, server, base, db, h, cookies, close: () => new Promise((r) => server.close(r)) };
}

// ---------------------------------------------------------------- the overlay (cursor, spotlight, chip)
const OVERLAY = `(() => {
  if (window.__hlp) return;
  const css = \`
    html { scrollbar-width: none; } html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
    .hlpx { position: fixed; inset: 0; pointer-events: none; z-index: 2147483600; }
    .hlpx-spot { position: fixed; border-radius: 14px; opacity: 0; transition: left .55s cubic-bezier(.22,.8,.2,1), top .55s cubic-bezier(.22,.8,.2,1), width .55s cubic-bezier(.22,.8,.2,1), height .55s cubic-bezier(.22,.8,.2,1), opacity .4s ease;
      box-shadow: 0 0 0 3px rgba(195,145,54,.95), 0 0 0 9px rgba(195,145,54,.18), 0 0 34px 8px rgba(195,145,54,.28), 0 0 0 200vmax rgba(14,24,21,.46); }
    .hlpx-spot.is-on { opacity: 1; }
    .hlpx-spot::after { content: ''; position: absolute; inset: -3px; border-radius: 16px; border: 2px solid rgba(255,255,255,.7); animation: hlpxPulse 1.8s ease-out infinite; }
    @keyframes hlpxPulse { 0% { transform: scale(1); opacity: .9; } 100% { transform: scale(1.08); opacity: 0; } }
    .hlpx-cur { position: fixed; left: 0; top: 0; width: 34px; height: 34px; transform: translate(640px, 420px); transition-property: transform; transition-timing-function: cubic-bezier(.45,.05,.2,1); will-change: transform; filter: drop-shadow(0 6px 10px rgba(0,0,0,.28)); }
    .hlpx-cur svg { width: 34px; height: 34px; transition: transform .14s ease; transform-origin: 6px 4px; }
    .hlpx-cur.is-down svg { transform: scale(.82); }
    .hlpx-halo { position: absolute; left: -14px; top: -14px; width: 40px; height: 40px; border-radius: 50%; background: radial-gradient(circle, rgba(195,145,54,.35), rgba(195,145,54,0) 70%); }
    .hlpx-rip { position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; border: 3px solid rgba(195,145,54,.95); background: rgba(195,145,54,.18); animation: hlpxRip .7s cubic-bezier(.2,.7,.3,1) forwards; }
    @keyframes hlpxRip { 0% { transform: scale(.4); opacity: 1; } 100% { transform: scale(4.2); opacity: 0; } }
    .hlpx-chip { position: fixed; bottom: 18px; inset-inline-start: 18px; display: flex; align-items: center; gap: 10px; padding: 8px 16px 8px 8px; border-radius: 999px; background: rgba(31,44,40,.92); color: #fff; font: 600 13px/1.2 Montserrat, Almarai, sans-serif; box-shadow: 0 14px 30px -12px rgba(0,0,0,.5); opacity: 0; transform: translateY(10px); transition: opacity .4s ease, transform .4s ease; backdrop-filter: blur(6px); }
    [dir="rtl"] .hlpx-chip, .hlpx-chip[dir="rtl"] { padding: 8px 8px 8px 16px; font-family: Almarai, Montserrat, sans-serif; }
    .hlpx-chip.is-on { opacity: 1; transform: none; }
    .hlpx-chip b { display: grid; place-items: center; min-width: 28px; height: 28px; padding: 0 8px; border-radius: 999px; background: #c39136; color: #1f2c28; font-weight: 800; }
    .hlpx-chip span { opacity: .92; max-width: 520px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hlpx-key { position: fixed; padding: 6px 12px; border-radius: 8px; background: rgba(31,44,40,.92); color: #fff; font: 700 13px Montserrat, sans-serif; opacity: 0; transition: opacity .25s; }
    .hlpx-key.is-on { opacity: 1; }
  \`;
  const arrow = '<svg viewBox="0 0 32 32"><path d="M6 3.5 L6 25.5 L11.6 20.4 L15.4 28.6 L19.2 26.9 L15.5 18.9 L23.2 18.6 Z" fill="#fff" stroke="#1f2c28" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  let root, spot, cur, chip, key;
  let pos = { x: 640, y: 420 };
  const ensure = () => {
    if (root && root.isConnected) return;
    const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st);
    root = document.createElement('div'); root.className = 'hlpx';
    root.innerHTML = '<div class="hlpx-spot"></div><div class="hlpx-chip"><b></b><span></span></div><div class="hlpx-key"></div><div class="hlpx-cur"><i class="hlpx-halo"></i>' + arrow + '</div>';
    document.documentElement.appendChild(root);
    spot = root.querySelector('.hlpx-spot'); cur = root.querySelector('.hlpx-cur'); chip = root.querySelector('.hlpx-chip'); key = root.querySelector('.hlpx-key');
    cur.style.transitionDuration = '0ms';
    cur.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
  };
  window.__hlp = {
    place(x, y) { ensure(); pos = { x, y }; cur.style.transitionDuration = '0ms'; cur.style.transform = 'translate(' + x + 'px,' + y + 'px)'; },
    move(x, y, ms) { ensure(); pos = { x, y }; void cur.offsetWidth; cur.style.transitionDuration = ms + 'ms'; cur.style.transform = 'translate(' + x + 'px,' + y + 'px)'; },
    down(on) { ensure(); cur.classList.toggle('is-down', !!on); },
    ripple(x, y) { ensure(); const r = document.createElement('div'); r.className = 'hlpx-rip'; r.style.left = x + 'px'; r.style.top = y + 'px'; root.appendChild(r); setTimeout(() => r.remove(), 900); },
    spot(rect) {
      ensure();
      if (!rect) { spot.classList.remove('is-on'); return; }
      const pad = 8;
      spot.style.left = (rect.x - pad) + 'px'; spot.style.top = (rect.y - pad) + 'px';
      spot.style.width = (rect.width + pad * 2) + 'px'; spot.style.height = (rect.height + pad * 2) + 'px';
      spot.classList.add('is-on');
    },
    chip(n, text, rtl) { ensure(); if (!n) { chip.classList.remove('is-on'); return; } chip.querySelector('b').textContent = n; chip.querySelector('b').dir = 'ltr'; chip.querySelector('span').textContent = text; chip.dir = rtl ? 'rtl' : 'ltr'; chip.classList.add('is-on'); },
    key(text, x, y) { ensure(); if (!text) { key.classList.remove('is-on'); return; } key.textContent = text; key.style.left = x + 'px'; key.style.top = y + 'px'; key.classList.add('is-on'); },
    hide() { ensure(); root.style.display = 'none'; },
    show() { ensure(); root.style.display = ''; },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure); else ensure();
})();`;

// ---------------------------------------------------------------- title cards
const LOGO = (() => {
  const P = require(path.join(ROOT, 'src', 'logo-paths.json'));
  return `<svg viewBox="0 0 490 225.2" aria-label="The Wave">${['T', 'H', 'E2', 'W', 'AV', 'E'].map((k) => `<path d="${P[k]}"/>`).join('')}</svg>`;
})();
const AREA_LABEL = Object.fromEntries(help.AREAS.map(([k, label]) => [k, label]));
const STRINGS = {
  en: { lesson: 'Lesson', steps: (n) => `${n} steps`, complete: 'Lesson complete', next: 'Up next', academy: 'The Wave · Help & training', min: (m) => (m <= 1 ? 'about a minute' : `about ${m} minutes`) },
  ar: { lesson: 'درس', steps: (n) => (n === 1 ? 'خطوة واحدة' : n === 2 ? 'خطوتان' : n <= 10 ? `${n} خطوات` : `${n} خطوة`), complete: 'اكتمل الدرس', next: 'الدرس التالي', academy: 'ذا ويف · المساعدة والتدريب', min: (m) => (m <= 1 ? 'دقيقة تقريبًا' : m === 2 ? 'دقيقتان تقريبًا' : `${m} دقائق تقريبًا`) },
};
const areaName = (area, lang) => {
  const AR = require(path.join(ROOT, 'src', 'admin', 'i18n')).AR;
  const key = AREA_LABEL[area];
  return lang === 'ar' ? AR[key] || key.split('|')[1] : key.split('|')[1];
};
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function cardHtml(base, lang, kind, { title, summary, area, steps, minutes, next }) {
  const s = STRINGS[lang];
  const rtl = lang === 'ar';
  const fontFace = `
    @font-face { font-family: 'Bodoni Moda'; font-weight: 400 700; src: url(${base}/fonts/BodoniModa-normal.woff2) format('woff2'); }
    @font-face { font-family: 'Montserrat'; font-weight: 100 900; src: url(${base}/fonts/Montserrat-var.woff2) format('woff2'); }
    @font-face { font-family: 'Almarai'; font-weight: 400; src: url(${base}/fonts/Almarai-400.woff2) format('woff2'); }
    @font-face { font-family: 'Almarai'; font-weight: 700; src: url(${base}/fonts/Almarai-700.woff2) format('woff2'); }`;
  const head = rtl ? "'Almarai', sans-serif" : "'Bodoni Moda', Georgia, serif";
  const body = rtl ? "'Almarai', sans-serif" : "'Montserrat', sans-serif";
  const common = `${fontFace}
    * { box-sizing: border-box; margin: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #1f2c28; }
    body { position: relative; color: #fff; font-family: ${body}; }
    .bg { position: absolute; inset: -4%; background: url(${base}/img/aerialnight-1600.webp) center/cover; filter: saturate(.8) brightness(.42); animation: kb 9s ease-out forwards; }
    .tint { position: absolute; inset: 0; background: radial-gradient(1200px 700px at ${rtl ? '85%' : '15%'} 30%, rgba(40,56,51,.35), rgba(20,30,27,.94)); }
    @keyframes kb { from { transform: scale(1.08); } to { transform: scale(1); } }
    .logo { position: absolute; top: 56px; ${rtl ? 'right' : 'left'}: 72px; width: 150px; fill: #fff; opacity: 0; animation: up .9s .15s cubic-bezier(.2,.7,.2,1) forwards; }
    .academy { position: absolute; top: 74px; ${rtl ? 'left' : 'right'}: 72px; font: 600 13px/1 ${body}; letter-spacing: ${rtl ? '0' : '.18em'}; text-transform: uppercase; color: #d1c9b3; opacity: 0; animation: fade .8s .4s forwards; }
    @keyframes up { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
    @keyframes fade { to { opacity: 1; } }
    @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }`;
  if (kind === 'intro') {
    return `<!doctype html><html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${common}
      .wrap { position: absolute; ${rtl ? 'right' : 'left'}: 72px; bottom: 96px; width: 900px; }
      .chip { display: inline-flex; align-items: center; gap: 10px; padding: 8px 16px; border-radius: 999px; background: rgba(195,145,54,.16); border: 1px solid rgba(195,145,54,.55); color: #e8c27a; font: 700 14px/1 ${body}; opacity: 0; animation: up .7s .5s forwards; }
      .chip i { width: 8px; height: 8px; border-radius: 50%; background: #c39136; box-shadow: 0 0 12px #c39136; }
      h1 { margin-top: 22px; font: 700 ${rtl ? 58 : 64}px/1.12 ${head}; letter-spacing: ${rtl ? '0' : '-.01em'}; opacity: 0; animation: up .9s .75s cubic-bezier(.2,.7,.2,1) forwards; }
      .line { margin-top: 26px; width: 120px; height: 3px; background: #c39136; transform-origin: ${rtl ? 'right' : 'left'}; transform: scaleX(0); animation: grow .9s 1.1s cubic-bezier(.2,.7,.2,1) forwards; }
      p { margin-top: 22px; max-width: 820px; font: 400 21px/1.55 ${body}; color: #e9e4d6; opacity: 0; animation: up .8s 1.25s forwards; }
      .meta { margin-top: 26px; display: flex; gap: 22px; font: 600 15px/1 ${body}; color: #d1c9b3; opacity: 0; animation: fade .8s 1.6s forwards; }
      .meta span { display: inline-flex; align-items: center; gap: 8px; } .meta span::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #a2c5b9; }
    </style></head><body><div class="bg"></div><div class="tint"></div><div class="logo">${LOGO}</div><div class="academy">${escHtml(s.academy)}</div>
    <div class="wrap"><span class="chip"><i></i>${escHtml(areaName(area, lang))}</span><h1>${escHtml(title)}</h1><div class="line"></div><p>${escHtml(summary)}</p>
    <div class="meta"><span>${escHtml(s.steps(steps))}</span><span>${escHtml(s.min(minutes))}</span></div></div></body></html>`;
  }
  return `<!doctype html><html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${common}
    .c { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }
    .tick { width: 110px; height: 110px; margin: 0 auto; border-radius: 50%; background: rgba(195,145,54,.14); border: 2px solid #c39136; display: grid; place-items: center; opacity: 0; transform: scale(.6); animation: pop .7s .2s cubic-bezier(.2,1.4,.4,1) forwards; box-shadow: 0 0 60px rgba(195,145,54,.35); }
    .tick svg { width: 56px; height: 56px; stroke: #e8c27a; stroke-width: 3.2; fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 40; stroke-dashoffset: 40; animation: draw .6s .7s ease forwards; }
    @keyframes pop { to { opacity: 1; transform: none; } } @keyframes draw { to { stroke-dashoffset: 0; } }
    h1 { margin-top: 30px; font: 700 52px/1.15 ${head}; opacity: 0; animation: up .8s .6s forwards; }
    .t { margin-top: 12px; font: 400 20px/1.5 ${body}; color: #d1c9b3; opacity: 0; animation: up .8s .8s forwards; }
    .next { margin-top: 38px; display: inline-flex; gap: 12px; align-items: center; padding: 12px 22px; border-radius: 999px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.18); font: 600 16px/1.2 ${body}; opacity: 0; animation: up .8s 1.1s forwards; }
    .next b { color: #e8c27a; }
  </style></head><body><div class="bg"></div><div class="tint"></div><div class="logo">${LOGO}</div><div class="academy">${escHtml(s.academy)}</div>
  <div class="c"><div><div class="tick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div><h1>${escHtml(s.complete)}</h1><div class="t">${escHtml(title)}</div>
  ${next ? `<div class="next"><b>${escHtml(s.next)}</b><span>${escHtml(next)}</span></div>` : ''}</div></div></body></html>`;
}

// ---------------------------------------------------------------- sound (synthesized, 24 kHz mono)
const RATE = 24000;
function soundTrack(durationS, events) {
  const n = Math.ceil((durationS + 0.5) * RATE);
  const buf = new Float32Array(n);
  const add = (t0, fn, len) => {
    const s0 = Math.floor(t0 * RATE);
    for (let i = 0; i < len * RATE && s0 + i < n; i++) if (s0 + i >= 0) buf[s0 + i] += fn(i / RATE);
  };
  let seed = 7;
  const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  for (const e of events) {
    if (e.kind === 'click') add(e.t, (t) => 0.42 * Math.exp(-t * 95) * (Math.sin(2 * Math.PI * 1650 * t) * 0.6 + Math.sin(2 * Math.PI * 820 * t) * 0.4) + 0.12 * noise() * Math.exp(-t * 300), 0.09);
    else if (e.kind === 'key') add(e.t, (t) => 0.09 * Math.exp(-t * 220) * (noise() * 0.7 + Math.sin(2 * Math.PI * 2600 * t) * 0.3), 0.035);
    else if (e.kind === 'nav') {
      let lp = 0;
      add(e.t, (t) => { lp += 0.06 * (noise() - lp); const env = Math.sin(Math.PI * Math.min(1, t / 0.42)); return 0.5 * lp * env; }, 0.42);
    } else if (e.kind === 'chime') {
      for (const [f, d] of [[659.25, 0], [987.77, 0.16]]) add(e.t + d, (t) => 0.16 * Math.exp(-t * 3.2) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t)) * Math.min(1, t * 200), 1.4);
    } else if (e.kind === 'done') {
      for (const [f, d] of [[523.25, 0], [659.25, 0.12], [783.99, 0.24]]) add(e.t + d, (t) => 0.13 * Math.exp(-t * 3) * Math.sin(2 * Math.PI * f * t) * Math.min(1, t * 200), 1.3);
    }
  }
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVE', 8); pcm.write('fmt ', 12);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(RATE, 24); pcm.writeUInt32LE(RATE * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[i] * 32767))), 44 + i * 2);
  return pcm;
}

// ---------------------------------------------------------------- captions
const vttTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); const sec = Math.floor((ms % 60000) / 1000); const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
};
const toVtt = (cues) => `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n')}`;

// ---------------------------------------------------------------- manifest (several recorders may run at once)
function withLock(fn) {
  const lock = `${help.MANIFEST}.lock`;
  for (let i = 0; i < 400; i++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.rmSync(lock, { force: true }); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw new Error('manifest lock timeout');
}
function saveManifest(id, lang, entry) {
  withLock(() => {
    let m = { lessons: {} };
    try { m = JSON.parse(fs.readFileSync(help.MANIFEST, 'utf8')); } catch {}
    m.lessons = m.lessons || {};
    m.lessons[id] = { ...(m.lessons[id] || {}), [lang]: entry };
    m.lessons = Object.fromEntries(Object.entries(m.lessons).sort(([a], [b]) => a.localeCompare(b)));
    m.recorded_at = new Date().toISOString();
    m.app_version = require(path.join(ROOT, 'package.json')).version;
    const tmp = `${help.MANIFEST}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(m, null, 1)}\n`);
    fs.renameSync(tmp, help.MANIFEST);
  });
}

// ---------------------------------------------------------------- one lesson in one language
async function playLesson(browser, office, lesson, lang, { record }) {
  const { db, h, base } = office;
  db.run("UPDATE users SET lang = ? WHERE email = 'admin@thewave.test'", lang);
  db.run('UPDATE portal_users SET lang = ? WHERE demo = 1', lang);
  if (typeof lesson.prepare === 'function') await lesson.prepare({ db, h, lang, base });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: record ? DSF : 1, locale: lang === 'ar' ? 'ar-EG' : 'en-GB', timezoneId: 'Africa/Cairo', reducedMotion: 'no-preference' });
  await ctx.addCookies(office.cookies);
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.setDefaultTimeout(8000);
  const fail = (i, what) => { throw new Error(`${lesson.id} [${lang}] step ${i + 1}: ${what}`); };

  // frames over the DevTools screencast
  const tmp = record ? fs.mkdtempSync(path.join(os.tmpdir(), `wave-help-${lesson.id}-${lang}-`)) : null;
  const frames = [];
  let cdp = null;
  let t0 = null;
  const now = () => Date.now() / 1000 - (t0 || Date.now() / 1000);
  const startCast = async () => {
    cdp = await ctx.newCDPSession(page);
    cdp.on('Page.screencastFrame', async (f) => {
      const file = path.join(tmp, `f${String(frames.length).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      const ts = f.metadata.timestamp || Date.now() / 1000;
      if (t0 === null) t0 = ts;
      frames.push({ file, t: ts - t0 });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    for (let i = 0; i < 100 && t0 === null; i++) await sleep(20);
  };
  const sounds = [];
  const cues = [];
  const stepsLog = [];
  const T = lesson.title[lang];
  const said = lesson.steps.filter((s) => s.say).length;
  const minutes = Math.max(1, Math.round(lesson.steps.reduce((ms, s) => ms + (s.say ? readMs(say(s.say, lang), lang) + 900 : 600), 7000) / 60000));

  const wait = (ms) => sleep(record ? ms : Math.min(ms, 60));
  const ov = (fn, ...a) => page.evaluate(([f, a2]) => window.__hlp && window.__hlp[f](...a2), [fn, a]).catch(() => {});
  let cursor = { x: W * 0.62, y: H * 0.58 };
  const placeCursor = () => ov('place', cursor.x, cursor.y);
  const glide = async (x, y) => {
    const d = Math.hypot(x - cursor.x, y - cursor.y);
    const ms = Math.round(Math.min(1100, Math.max(420, d * 1.1)));
    cursor = { x, y };
    await ov('move', x, y, record ? ms : 0);
    await wait(ms + 60);
  };
  const textFilter = (s) => (s.has === undefined ? null : say(s.has, lang));
  const locate = async (i, sel, s) => {
    let loc = page.locator(sel);
    const has = textFilter(s);
    if (has) loc = loc.filter({ hasText: has });
    loc = s.nth !== undefined ? loc.nth(s.nth) : loc.first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 8000 });
    } catch {
      fail(i, `nothing visible matches ${JSON.stringify(sel)}${has ? ` with text ${JSON.stringify(has)}` : ''} on ${page.url().replace(base, '')}`);
    }
    return loc;
  };
  const bring = async (loc) => {
    await loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight - 70) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    await wait(650);
    const b = await loc.boundingBox();
    return b;
  };
  const cueStart = () => now();
  const pushCue = (i, start, text) => { if (text) cues.push({ start: +start.toFixed(2), end: +now().toFixed(2), text, step: i + 1, url: page.url().replace(base, '') }); };
  const chip = (n) => ov('chip', n ? `${n} / ${said}` : '', T, lang === 'ar');

  try {
    // intro card
    if (record) {
      // same origin as the office, so the card can load its fonts and photo
      await page.goto(`${base}/healthz`);
      await page.setContent(cardHtml(base, lang, 'intro', { title: T, summary: lesson.summary[lang], area: lesson.area, steps: said, minutes }), { waitUntil: 'load' });
      await ov('hide');
      await sleep(250);
      await startCast();
      sounds.push({ kind: 'chime', t: 0.5 });
      const st = now();
      await sleep(Math.max(4200, readMs(lesson.summary[lang], lang) + 1500));
      cues.push({ start: +st.toFixed(2), end: +now().toFixed(2), text: lesson.summary[lang], step: 0, url: '', intro: true });
    }
    let n = 0;
    for (let i = 0; i < lesson.steps.length; i++) {
      const s = lesson.steps[i];
      const kind = help.kindOf(s);
      const text = s.say ? say(s.say, lang) : '';
      if (text) n++;
      const st = cueStart();
      const read = text ? readMs(text, lang) : 0;
      if (VERBOSE) log(`  ${lesson.id} [${lang}] ${i + 1} ${kind} ${text.slice(0, 50)}`);
      if (kind === 'go') {
        if (record) sounds.push({ kind: 'nav', t: now() });
        await page.goto(base + s.go, { waitUntil: 'load' }).catch((e) => fail(i, `could not open ${s.go}: ${e.message}`));
        if (s.go.startsWith('/portal') && /\/portal\/login/.test(page.url())) fail(i, 'the portal asked to sign in: use prepare to sign a tenant in');
        await placeCursor();
        if (text) await chip(n);
        await wait(text ? Math.max(read, 1200) : 900);
        pushCue(i, st, text);
      } else if (kind === 'say') {
        if (text) await chip(n);
        await ov('spot', null);
        await wait(read);
        pushCue(i, st, text);
      } else if (kind === 'pause') {
        await wait(Number(s.pause) || 800);
      } else if (kind === 'wait') {
        await locate(i, s.wait, s);
      } else if (kind === 'key') {
        await page.keyboard.press(s.key);
        if (record) sounds.push({ kind: 'key', t: now() });
        await wait(text ? read : 600);
        pushCue(i, st, text);
      } else if (kind === 'scroll') {
        if (typeof s.scroll === 'number') await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), s.scroll);
        else { const loc = await locate(i, s.scroll, s); await loc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' })); }
        if (text) await chip(n);
        await wait(Math.max(900, read));
        pushCue(i, st, text);
      } else {
        const sel = kind === 'type' ? s.type[0] : kind === 'select' ? s.select[0] : s[kind];
        const loc = await locate(i, sel, s);
        if (text) await chip(n);
        const box = await bring(loc);
        if (!box) fail(i, `${JSON.stringify(sel)} has no size`);
        const spot = s.spot ? await (await locate(i, s.spot, {})).boundingBox() : box;
        await ov('spot', spot);
        const tx = box.x + Math.min(box.width / 2, Math.max(14, box.width * 0.35));
        const ty = box.y + box.height / 2;
        await glide(tx, ty);
        if (kind === 'point' || kind === 'hover') {
          if (kind === 'hover') await loc.hover().catch(() => {});
          await wait(Math.max(read - 900, 1200));
        } else if (kind === 'click' || kind === 'check') {
          await wait(Math.max(read - 1500, 500));
          await ov('down', true);
          await ov('ripple', tx, ty);
          if (record) sounds.push({ kind: 'click', t: now() });
          await wait(140);
          await ov('down', false);
          const before = page.url();
          await page.evaluate(() => { window.__hlpMark = 1; }).catch(() => {});
          const navP = s.nav ? page.waitForURL((u) => u.toString() !== before, { timeout: 15000 }).then(() => true, () => false) : null;
          if (kind === 'check') await loc.check({ force: true }).catch((e) => fail(i, e.message));
          else await loc.click({ force: !!s.force }).catch((e) => fail(i, e.message));
          if (navP) {
            if (record) sounds.push({ kind: 'nav', t: now() });
            if (!(await navP)) fail(i, 'the click did not open another page (remove nav: true?)');
            await page.waitForLoadState('load');
            await placeCursor();
            await ov('spot', null);
            if (text) await chip(n);
          } else {
            // a form that posts back (or a link) loads a new document: put the cursor back
            let fresh = false;
            for (let k = 0; k < 14 && !fresh; k++) {
              await sleep(100);
              fresh = !(await page.evaluate(() => window.__hlpMark === 1).catch(() => false));
            }
            if (fresh) {
              if (record) sounds.push({ kind: 'nav', t: now() });
              await page.waitForLoadState('load');
              await placeCursor();
              await ov('spot', null);
              if (text) await chip(n);
            }
          }
          await wait(s.nav ? 900 : 700);
        } else if (kind === 'type') {
          await wait(Math.max(400, read - 2600));
          await ov('down', true); await ov('ripple', tx, ty); if (record) sounds.push({ kind: 'click', t: now() }); await wait(120); await ov('down', false);
          await loc.click().catch(() => {});
          if (s.clear !== false) await loc.fill('');
          const value = say(s.type[1], lang);
          const delay = record ? Math.max(28, Math.min(85, Math.round(1600 / Math.max(1, value.length)))) : 0;
          const tt = now();
          if (record) for (let k = 0; k < value.length; k++) if (value[k] !== ' ') sounds.push({ kind: 'key', t: tt + (k * delay) / 1000 });
          await loc.pressSequentially(value, { delay });
          await wait(700);
        } else if (kind === 'select') {
          await wait(Math.max(400, read - 1600));
          await ov('down', true); await ov('ripple', tx, ty); if (record) sounds.push({ kind: 'click', t: now() }); await wait(120); await ov('down', false);
          const v = s.select[1];
          const opt = typeof v === 'object' && v !== null ? { label: say(v, lang) } : String(v);
          await loc.selectOption(opt).catch((e) => fail(i, `could not choose ${JSON.stringify(v)}: ${e.message.split('\n')[0]}`));
          await wait(900);
        }
        if (!s.keep) await ov('spot', null);
        pushCue(i, st, text);
      }
      stepsLog.push({ step: i + 1, kind, url: page.url().replace(base, '') });
    }
    await ov('chip', '');
    await wait(500);
    if (record) {
      const next = lesson.nextTitle ? lesson.nextTitle[lang] : null;
      const outroAt = now();
      await page.setContent(cardHtml(base, lang, 'outro', { title: T, next }), { waitUntil: 'load' });
      await ov('hide');
      sounds.push({ kind: 'done', t: now() + 0.4 });
      await sleep(3600);
      // on a busy machine the screencast runs behind: wait until the card's frames have arrived,
      // or the video would end on the last screen of the lesson instead of "Lesson complete"
      for (let k = 0; k < 80 && !frames.some((f) => f.t >= outroAt + 1.6); k++) await sleep(100);
    }
  } finally {
    if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  }
  const end = record ? now() : 0;
  await ctx.close();
  if (!record) return { steps: stepsLog };

  // ---- encode
  const outDir = path.join(help.MEDIA_DIR, lang);
  fs.mkdirSync(outDir, { recursive: true });
  if (frames.length < 2) throw new Error(`${lesson.id} [${lang}]: no frames were captured`);
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1] ? frames[i + 1].t : end) - f.t)).toFixed(3)}`).join('\n');
  fs.writeFileSync(path.join(tmp, 'list.txt'), `${list}\nfile '${frames[frames.length - 1].file}'\n`);
  fs.writeFileSync(path.join(tmp, 'sound.wav'), soundTrack(end, sounds));
  const mp4 = path.join(outDir, `${lesson.id}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-i', path.join(tmp, 'sound.wav'),
    '-vf', `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF), '-tune', 'animation', '-g', String(FPS * 4),
    '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-ar', '24000', '-shortest', '-movflags', '+faststart', mp4]);
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4]).toString().trim());
  // poster: a frame from the middle of the lesson (past the title card)
  const posterAt = Math.min(duration - 1, Math.max(5, (cues.find((c, k) => k > 0 && k >= Math.floor(cues.length / 2)) || cues[cues.length - 1] || { start: duration / 2 }).start + 1));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', posterAt.toFixed(2), '-i', mp4, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(outDir, `${lesson.id}.jpg`)]);
  const doc = { id: lesson.id, lang, title: T, duration: +duration.toFixed(2), cues, steps: stepsLog, recorded_at: new Date().toISOString() };
  fs.writeFileSync(path.join(outDir, `${lesson.id}.json`), `${JSON.stringify(doc, null, 1)}\n`);
  fs.writeFileSync(path.join(outDir, `${lesson.id}.vtt`), toVtt(cues));
  const size = fs.statSync(mp4).size;
  const v = crypto.createHash('sha1').update(fs.readFileSync(mp4)).update(JSON.stringify(cues)).digest('hex').slice(0, 10);
  saveManifest(lesson.id, lang, { duration: +duration.toFixed(2), size, v, cues: cues.length, recorded_at: doc.recorded_at });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { duration, size };
}

// ---------------------------------------------------------------- --fix-outro
// Videos recorded on a busy machine can lose the closing "Lesson complete" card (the screencast
// stopped before its frames arrived), so they end on the lesson's last screen. This finds them by
// comparing the last frame with the card and cross-fades the card in over the same seconds, keeping
// the length, the sound and the transcript as they are.
async function fixOutros(browser, todo) {
  const office = await boot(PORT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-help-outro-'));
  const thumb = (input, extra = []) => execFileSync('ffmpeg', ['-loglevel', 'error', ...extra, '-i', input, '-frames:v', '1', '-vf', 'scale=48:27,format=gray', '-f', 'rawvideo', '-']);
  const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
  let fixed = 0;
  let fine = 0;
  try {
    for (const lesson of todo) {
      for (const lang of LANGS) {
        const dir = path.join(help.MEDIA_DIR, lang);
        const mp4 = path.join(dir, `${lesson.id}.mp4`);
        const jsonFile = path.join(dir, `${lesson.id}.json`);
        if (!fs.existsSync(mp4) || !fs.existsSync(jsonFile)) continue;
        const doc = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        const next = lesson.nextTitle ? lesson.nextTitle[lang] : null;
        await page.setContent(cardHtml(office.base, lang, 'outro', { title: lesson.title[lang], next }), { waitUntil: 'load' });
        await sleep(2600);
        const png = path.join(tmp, `${lesson.id}-${lang}.png`);
        await page.screenshot({ path: png });
        await ctx.close();
        const d = diff(thumb(mp4, ['-sseof', '-0.6']), thumb(png));
        if (d < 18) { fine++; if (VERBOSE) log(`ok    ${lesson.id} [${lang}] ends on the card (${d.toFixed(1)})`); continue; }
        const T = doc.duration;
        const last = doc.cues[doc.cues.length - 1];
        const cut = Math.min(T - 2.5, Math.max(1, (last ? last.end : T - 4.2) + 0.6));
        const L = T - cut + 0.5;
        const out = path.join(tmp, `${lesson.id}-${lang}.mp4`);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-loop', '1', '-t', L.toFixed(2), '-i', png,
          '-filter_complex', `[0:v]trim=0:${cut.toFixed(2)},setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p[a];[1:v]scale=${W}:${H},fps=${FPS},format=yuv420p[b];[a][b]xfade=transition=fade:duration=0.5:offset=${(cut - 0.5).toFixed(2)}[v]`,
          '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF), '-tune', 'animation', '-g', String(FPS * 4), '-c:a', 'copy', '-shortest', '-movflags', '+faststart', out]);
        fs.copyFileSync(out, mp4);
        const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4]).toString().trim());
        const size = fs.statSync(mp4).size;
        const v = crypto.createHash('sha1').update(fs.readFileSync(mp4)).update(JSON.stringify(doc.cues)).digest('hex').slice(0, 10);
        doc.duration = +duration.toFixed(2);
        fs.writeFileSync(jsonFile, `${JSON.stringify(doc, null, 1)}\n`);
        saveManifest(lesson.id, lang, { duration: doc.duration, size, v, cues: doc.cues.length, recorded_at: doc.recorded_at });
        fixed++;
        log(`card  ${lesson.id} [${lang}] closing card added (${d.toFixed(1)}), ${duration.toFixed(1)} s`);
      }
    }
  } finally {
    await office.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log(`\n${fixed} videos given their closing card, ${fine} already had it`);
}

// ---------------------------------------------------------------- main
(async () => {
  const { lessons, errors } = help.load();
  if (errors.length) { console.error(`Lesson files have problems:\n  ${errors.join('\n  ')}`); process.exit(1); }
  let todo = lessons;
  if (args.only) { const ids = String(args.only).split(','); todo = lessons.filter((l) => ids.includes(l.id)); const missing = ids.filter((id) => !lessons.some((l) => l.id === id)); if (missing.length) { console.error(`No lesson called ${missing.join(', ')}`); process.exit(1); } }
  if (args.area) todo = todo.filter((l) => l.area === args.area);
  // the title of the next lesson in the same area, for the outro card
  for (const l of todo) {
    const same = lessons.filter((x) => x.area === l.area);
    const nx = same[same.indexOf(l) + 1];
    l.nextTitle = nx ? nx.title : null;
  }
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text'] });
  const started = Date.now();
  if (args['fix-outro']) { await fixOutros(browser, todo); await browser.close(); return; }
  const report = [];
  let failed = 0;
  for (const lesson of todo) {
    const t = Date.now();
    let office;
    try {
      office = await boot(PORT);
      for (const lang of LANGS) {
        const r = await playLesson(browser, office, lesson, lang, { record: !CHECK });
        if (CHECK) log(`ok    ${lesson.id} [${lang}] ${r.steps.length} steps`);
        else {
          report.push({ id: lesson.id, lang, duration: r.duration, size: r.size });
          log(`made  ${lesson.id} [${lang}] ${r.duration.toFixed(1)} s, ${(r.size / 1024).toFixed(0)} KB (${((r.size / 1024 / 1024) / (r.duration / 60)).toFixed(2)} MB/min)`);
        }
      }
    } catch (e) {
      failed++;
      console.error(`FAIL  ${e.message.split('\n')[0]}`);
      if (VERBOSE) console.error(e.stack);
    } finally {
      if (office) await office.close();
    }
    if (VERBOSE) log(`  (${((Date.now() - t) / 1000).toFixed(0)} s)`);
  }
  await browser.close();
  if (!CHECK && report.length) {
    const secs = report.reduce((s, r) => s + r.duration, 0);
    const bytes = report.reduce((s, r) => s + r.size, 0);
    log(`\n${report.length} videos, ${(secs / 60).toFixed(1)} min, ${(bytes / 1024 / 1024).toFixed(1)} MB (${(bytes / 1024 / 1024 / (secs / 60)).toFixed(2)} MB per minute), in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
