'use strict';

// Help & training (/admin/help): the academy of video lessons, with the transcript under every
// video, learning paths by role, progress, "Show me" tours on the real pages, search, frequent
// questions, the glossary, what's new, keyboard shortcuts, support requests and, for managers, the
// team's training report. Tenants get the portal lessons under /portal/help.
//
// Lessons live in src/admin/help/lessons (one file per area); scripts/help-record.js turns them
// into the videos in public/admin/help-media. The player, the transcript, reading aloud and the
// live tour are public/admin/help.js.

const help = require('../help');
const content = require('../help/content');
const i18n = require('../i18n');
const { registerDocs, uploadRoute } = require('../ops-common');

const { t: tr, tn } = i18n;

const SCHEMA = `
  CREATE TABLE hlp_progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL, lang TEXT,
    pos REAL NOT NULL DEFAULT 0, dur REAL, seen REAL NOT NULL DEFAULT 0, done_at TEXT, demo INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, lesson_id)
  );
  CREATE TABLE hlp_feedback (
    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, lesson_id TEXT NOT NULL,
    helpful INTEGER NOT NULL, note TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE hlp_tickets (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    subject TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'question', body TEXT NOT NULL, page TEXT, agent TEXT,
    status TEXT NOT NULL DEFAULT 'open', staff_reply_at TEXT, user_seen_at TEXT, closed_at TEXT, demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX hlp_tickets_user ON hlp_tickets(user_id, status);
  CREATE TABLE hlp_replies (
    id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES hlp_tickets(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, body TEXT NOT NULL, staff INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX hlp_replies_ticket ON hlp_replies(ticket_id, id);
`;

const CATEGORIES = { question: 'hlp|A question', problem: 'hlp|Something does not work', access: 'hlp|Access or permissions', idea: 'hlp|An idea or a request', other: 'hlp|Something else' };
const STATUS = { open: ['hlp|Waiting for support', 'amber'], answered: ['hlp|Answered', 'ok'], closed: ['hlp|Closed', 'mute'] };
const LEVELS = { basic: 'hlp|Basics', advanced: 'hlp|Advanced' };

const fmtDur = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

module.exports = function helpRoutes(router, h) {
  const { db, ui, M } = h;
  db.ensure('help-1', SCHEMA);
  registerDocs(M, 'hlp_ticket', 'hlp|Support request', {});
  (h.auditTyped = h.auditTyped || []).push('SELECT subject, body, page, agent FROM hlp_tickets', 'SELECT body FROM hlp_replies', 'SELECT note FROM hlp_feedback WHERE note IS NOT NULL');
  const esc = ui.esc;
  const VERSION = () => ui.ASSETS.help;
  const L = (req) => (req.lang === 'ar' ? 'ar' : 'en');
  const T = (req, x) => help.textOf(x, L(req));
  const isStaff = (req) => !!req.user && req.user.role === 'admin';
  const canOpen = (req, href) => {
    if (!href) return true;
    if (h.access && typeof h.access.can === 'function') {
      try { return h.access.can(req.user, href, 'view'); } catch { return true; }
    }
    return true;
  };
  const now = () => new Date().toISOString();
  // email through the office outbox; a failure never stops the request
  const mailTo = (o) => {
    try {
      const r = h.mail && h.mail.send(o);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* the outbox keeps it */ }
  };

  // ---------- lessons, media and progress ----------
  // staff see every lesson, the tenant portal's too (to help tenants); tenants only the portal ones
  const lessons = () => help.load().lessons;
  const portalLessons = () => help.load().lessons.filter((l) => l.area === 'portal');
  const mediaOf = (l, lang) => help.media(l.id, lang) || help.media(l.id, lang === 'ar' ? 'en' : 'ar');
  const seconds = (l, lang) => {
    const m = mediaOf(l, lang);
    if (m) return m.duration;
    return l.steps.reduce((s, x) => s + (x.say ? 5 : 1), 6);
  };
  const progressOf = (userId) => new Map(db.all('SELECT * FROM hlp_progress WHERE user_id = ?', userId).map((p) => [p.lesson_id, p]));
  const areaOf = (k) => help.AREAS.find(([x]) => x === k) || ['', 'hlp|Lessons', 'help'];
  const pathLessons = (key) => help.forPath(key);

  const ring = (frac, size = 44) => {
    const r = (size - 6) / 2;
    const c = 2 * Math.PI * r;
    const f = Math.max(0, Math.min(1, frac || 0));
    return `<svg class="hlp-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="hlp-ring__bg"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="hlp-ring__fg" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  };
  const thumb = (req, l, { big = false } = {}) => {
    const m = mediaOf(l, L(req));
    const [, , ic] = areaOf(l.area);
    const dur = `<span class="hlp-thumb__dur">${esc(fmtDur(seconds(l, L(req))))}</span>`;
    return m
      ? `<span class="hlp-thumb${big ? ' hlp-thumb--big' : ''}"><img src="${esc(m.jpg)}" alt="" loading="lazy" width="640" height="360"><i class="hlp-thumb__play">${ui.icon('play')}</i>${dur}</span>`
      : `<span class="hlp-thumb hlp-thumb--none${big ? ' hlp-thumb--big' : ''}">${ui.icon(ic)}<i class="hlp-thumb__play">${ui.icon('play')}</i>${dur}</span>`;
  };
  const lessonCard = (req, l, prog, { base = '/admin/help/l/' } = {}) => {
    const p = prog ? prog.get(l.id) : null;
    const done = p && p.done_at;
    const seen = p ? Math.max(p.seen || 0, done ? 1 : 0) : 0;
    return `<a class="hlp-card${done ? ' is-done' : ''}" href="${base}${esc(l.id)}">${thumb(req, l)}
      <span class="hlp-card__body"><b>${esc(T(req, l.title))}</b><small>${esc(T(req, l.summary))}</small>
      <span class="hlp-card__meta">${l.level === 'advanced' ? `<em>${esc(tr(LEVELS.advanced))}</em>` : ''}${done ? `<em class="is-ok">${ui.icon('check')}${esc(tr('hlp|Watched'))}</em>` : seen > 0.02 ? `<em>${esc(tr('hlp|{pct}% watched', { pct: Math.round(seen * 100) }))}</em>` : ''}</span></span>
      ${seen > 0.02 ? `<span class="hlp-card__bar"><i style="width:${(seen * 100).toFixed(0)}%"></i></span>` : ''}</a>`;
  };
  const tabs = (active) => `<nav class="tabs hlp-tabs">${[
    ['/admin/help', 'hlp|Lessons'], ['/admin/help/faq', 'hlp|Questions'], ['/admin/help/glossary', 'hlp|Glossary'], ['/admin/help/new', "hlp|What's new"],
    ['/admin/help/shortcuts', 'hlp|Shortcuts'], ['/admin/help/support', 'hlp|Support'],
  ].map(([href, label]) => `<a class="tab${active === href ? ' is-on' : ''}" href="${href}">${esc(tr(label))}</a>`).join('')}</nav>`;
  const page = (req, res, { title, body, crumbs, active, actions = '' }) => h.page(req, res, {
    title, crumbs: crumbs || (active === '/admin/help' ? undefined : [['/admin/help', tr('nav|Help & training')]]), active: '/admin/help', wide: true, actions,
    body: `${tabs(active)}${body}<script src="/admin/help.js?v=${VERSION()}" defer></script>`,
  });
  const supportBtn = (req, from) => ui.btn(esc(tr('hlp|Contact support')), { href: `/admin/help/support/new${from ? `?page=${encodeURIComponent(from)}` : ''}`, cls: 'btn--ghost', ic: 'chat' });

  // ---------- sidebar count ----------
  h.count('help', (user) => {
    if (!user) return 0;
    const mine = db.value("SELECT COUNT(*) FROM hlp_tickets WHERE user_id = ? AND staff_reply_at IS NOT NULL AND (user_seen_at IS NULL OR user_seen_at < staff_reply_at) AND status != 'closed'", user.id);
    const desk = user.role === 'admin' ? db.value("SELECT COUNT(*) FROM hlp_tickets WHERE status = 'open'") : 0;
    return mine + desk;
  });

  // ---------- the academy ----------
  router.get('/help', (req, res) => {
    const all = lessons();
    const prog = progressOf(req.user.id);
    const lang = L(req);
    const q = String(req.query.q || '').trim();
    if (q) return searchPage(req, res, q);
    const forPath = String(req.query.for || '').slice(0, 200);
    const here = forPath && forPath !== '/admin/help' ? help.forPage(forPath).filter((l) => l.area !== 'portal') : [];
    const done = all.filter((l) => (prog.get(l.id) || {}).done_at).length;
    const totalMin = Math.round(all.reduce((s, l) => s + seconds(l, lang), 0) / 60);
    const going = [...prog.values()].filter((p) => !p.done_at && p.seen > 0.02 && help.load().byId.get(p.lesson_id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 4).map((p) => help.load().byId.get(p.lesson_id)).filter((l) => l.area !== 'portal');
    const hero = `<section class="hlp-hero">
      <div class="hlp-hero__text"><p class="hlp-hero__kicker">${esc(tr('hlp|The Wave academy'))}</p><h2>${esc(tr('hlp|Learn the office, one short video at a time'))}</h2>
      <p>${esc(tr('hlp|Every lesson shows each step on the real screens, with the transcript under the video. Watch, read along, or let the office point at each step for you.'))}</p>
      <form class="hlp-search" method="get" action="/admin/help">${ui.icon('search')}<input type="search" name="q" placeholder="${esc(tr('hlp|Search lessons, transcripts and questions'))}" aria-label="${esc(tr('hlp|Search'))}"><button class="btn btn--primary btn--sm" type="submit">${esc(tr('hlp|Search'))}</button></form></div>
      <div class="hlp-hero__stats">
        <div class="hlp-stat">${ring(all.length ? done / all.length : 0, 92)}<b>${all.length ? Math.round((done / all.length) * 100) : 0}%</b><small>${esc(tr('hlp|your progress'))}</small></div>
        <div class="hlp-stat__list"><p><b>${all.length}</b> ${esc(tn(all.length, 'hlp|lesson', 'hlp|lessons'))}</p><p><b>${totalMin}</b> ${esc(tn(totalMin, 'hlp|minute of video', 'hlp|minutes of video'))}</p><p><b>${done}</b> ${esc(tr('hlp|watched'))}</p></div>
      </div></section>`;
    const hereCard = here.length ? ui.card(tr('hlp|Help for the page you were on'), `<div class="hlp-grid">${here.map((l) => lessonCard(req, l, prog)).join('')}</div>`, { cls: 'hlp-here', sub: `<span class="ltr">${esc(forPath)}</span>`, action: supportBtn(req, forPath) })
      : forPath && forPath !== '/admin/help' ? ui.card(tr('hlp|Help for the page you were on'), `<p class="muted">${esc(tr('hlp|There is no lesson for that page yet. Browse the lessons below, or ask support.'))}</p>`, { cls: 'hlp-here', action: supportBtn(req, forPath) }) : '';
    const goingCard = going.length ? ui.card(tr('hlp|Continue watching'), `<div class="hlp-grid hlp-grid--4">${going.map((l) => lessonCard(req, l, prog)).join('')}</div>`) : '';
    const paths = help.PATHS.map((p) => {
      const list = pathLessons(p.key);
      if (!list.length) return '';
      const d = list.filter((l) => (prog.get(l.id) || {}).done_at).length;
      const min = Math.round(list.reduce((s, l) => s + seconds(l, lang), 0) / 60);
      return `<a class="hlp-path${d === list.length ? ' is-done' : ''}" href="/admin/help/paths/${p.key}"><span class="hlp-path__ring">${ring(d / list.length, 56)}${ui.icon(p.icon)}</span><span><b>${esc(tr(p.label))}</b><small>${esc(tr(p.sub))}</small><em>${esc(tn(list.length, 'hlp|{n} lesson · {min} min', 'hlp|{n} lessons · {min} min', { min: Math.max(1, min) }))} · ${esc(tr('hlp|{d} of {n} watched', { d, n: list.length }))}</em></span></a>`;
    }).join('');
    const byArea = help.AREAS.map(([k, label, ic]) => {
      const list = all.filter((l) => l.area === k);
      if (!list.length) return '';
      return `<section class="hlp-area" id="area-${k}"><header class="hlp-area__head">${ui.icon(ic)}<h2>${esc(tr(label))}</h2><small>${esc(tn(list.length, 'hlp|{n} lesson', 'hlp|{n} lessons'))}</small></header><div class="hlp-grid">${list.map((l) => lessonCard(req, l, prog)).join('')}</div></section>`;
    }).join('');
    const side = `<div class="hlp-links">
      <a href="/admin/help/faq">${ui.icon('chat')}<span><b>${esc(tr('hlp|Questions people ask'))}</b><small>${esc(tr('hlp|Quick answers to common questions'))}</small></span></a>
      <a href="/admin/help/glossary">${ui.icon('file')}<span><b>${esc(tr('hlp|Glossary'))}</b><small>${esc(tr('hlp|WALE, DSO, GLA and other terms explained'))}</small></span></a>
      <a href="/admin/help/new">${ui.icon('flow')}<span><b>${esc(tr("hlp|What's new"))}</b><small>${esc(tr('hlp|The latest modules and changes'))}</small></span></a>
      <a href="/admin/help/support">${ui.icon('mail')}<span><b>${esc(tr('hlp|Contact support'))}</b><small>${esc(tr('hlp|Ask a question or report a problem'))}</small></span></a>
      ${h.can(req, 'manager') ? `<a href="/admin/help/training">${ui.icon('report')}<span><b>${esc(tr('hlp|Team training'))}</b><small>${esc(tr('hlp|Who watched which lessons'))}</small></span></a>` : ''}
    </div>`;
    const empty = all.length ? '' : ui.empty(tr('hlp|No lessons yet.'));
    const body = `${hero}${hereCard}${goingCard}
      <section class="hlp-paths-wrap"><h2 class="hlp-h">${esc(tr('hlp|Learning paths'))}</h2><div class="hlp-paths">${paths}</div></section>
      ${side}${byArea}${empty}`;
    page(req, res, { title: tr('nav|Help & training'), active: '/admin/help', body, actions: supportBtn(req, forPath || '') });
  });

  // ---------- search ----------
  function searchPage(req, res, q) {
    const lang = L(req);
    const other = lang === 'ar' ? 'en' : 'ar';
    const needle = q.toLowerCase();
    const has = (s) => String(s || '').toLowerCase().includes(needle);
    const prog = progressOf(req.user.id);
    const hits = [];
    for (const l of lessons()) {
      const lines = help.said(l, lang);
      const line = lines.find(has) || help.said(l, other).find(has);
      if (has(T(req, l.title)) || has(T(req, l.summary)) || has(help.textOf(l.title, other)) || line) hits.push({ l, line: line && !has(T(req, l.title)) ? line : null });
    }
    const faq = content.FAQ.filter((f) => has(f.q.en) || has(f.q.ar) || has(f.a.en) || has(f.a.ar));
    const gl = content.GLOSSARY.filter((g) => has(g.term.en) || has(g.term.ar) || has(g.def.en) || has(g.def.ar));
    const mark = (s) => {
      const str = String(s);
      const i = str.toLowerCase().indexOf(needle);
      return i < 0 ? esc(str) : `${esc(str.slice(0, i))}<mark>${esc(str.slice(i, i + q.length))}</mark>${esc(str.slice(i + q.length))}`;
    };
    const lessonsHtml = hits.length ? `<div class="hlp-results">${hits.map(({ l, line }) => `<a class="hlp-result" href="/admin/help/l/${esc(l.id)}${line ? `?q=${encodeURIComponent(q)}` : ''}">${thumb(req, l)}<span><b>${mark(T(req, l.title))}</b><small>${line ? `“${mark(line)}”` : mark(T(req, l.summary))}</small></span></a>`).join('')}</div>` : `<p class="muted pad">${esc(tr('hlp|No lesson matches.'))}</p>`;
    const body = `<form class="hlp-search hlp-search--page" method="get" action="/admin/help">${ui.icon('search')}<input type="search" name="q" value="${esc(q)}" aria-label="${esc(tr('hlp|Search'))}"><button class="btn btn--primary btn--sm" type="submit">${esc(tr('hlp|Search'))}</button></form>
      ${ui.card(tr('hlp|Lessons'), lessonsHtml, { sub: esc(tr('hlp|{n} found', { n: hits.length })) })}
      ${faq.length ? ui.card(tr('hlp|Questions'), faq.map((f) => `<details class="hlp-faq"><summary>${mark(T(req, f.q))}</summary><p>${mark(T(req, f.a))}</p></details>`).join('')) : ''}
      ${gl.length ? ui.card(tr('hlp|Glossary'), `<dl class="hlp-gloss">${gl.map((g) => `<dt>${mark(T(req, g.term))}</dt><dd>${mark(T(req, g.def))}</dd>`).join('')}</dl>`) : ''}
      ${!hits.length && !faq.length && !gl.length ? ui.card(tr('hlp|Nothing found'), `<p class="muted pad">${esc(tr('hlp|Try other words, or ask support.'))}</p>${supportBtn(req, '')}`) : ''}`;
    void prog;
    page(req, res, { title: tr('hlp|Search: {q}', { q }), active: '/admin/help', body });
  }

  // ---------- a learning path ----------
  router.get('/help/paths/:key', (req, res, next) => {
    const p = help.PATHS.find((x) => x.key === req.params.key);
    if (!p) return next();
    const list = pathLessons(p.key);
    const prog = progressOf(req.user.id);
    const d = list.filter((l) => (prog.get(l.id) || {}).done_at).length;
    const nextL = list.find((l) => !(prog.get(l.id) || {}).done_at);
    const steps = `<ol class="hlp-pathlist">${list.map((l, i) => {
      const pr = prog.get(l.id);
      const state = pr && pr.done_at ? 'is-done' : pr && pr.seen > 0.02 ? 'is-going' : '';
      return `<li class="${state}"><span class="hlp-pathlist__n">${pr && pr.done_at ? ui.icon('check') : i + 1}</span><a href="/admin/help/l/${esc(l.id)}">${thumb(req, l)}<span><b>${esc(T(req, l.title))}</b><small>${esc(T(req, l.summary))}</small></span></a></li>`;
    }).join('')}</ol>`;
    const head = `<section class="hlp-pathhead"><span class="hlp-path__ring">${ring(list.length ? d / list.length : 0, 84)}${ui.icon(p.icon)}</span><div><h2>${esc(tr(p.label))}</h2><p>${esc(tr(p.sub))}</p><p class="muted">${esc(tr('hlp|{d} of {n} watched', { d, n: list.length }))}${d === list.length && list.length ? ` · <b class="is-ok">${esc(tr('hlp|Path complete'))}</b>` : ''}</p></div>
      ${nextL ? ui.btn(esc(d ? tr('hlp|Continue') : tr('hlp|Start the path')), { href: `/admin/help/l/${esc(nextL.id)}?path=${p.key}`, cls: 'btn--primary', ic: 'play' }) : ''}</section>`;
    page(req, res, { title: tr(p.label), active: '/admin/help', crumbs: [['/admin/help', tr('nav|Help & training')], [null, tr('hlp|Learning paths')]], body: `${head}${ui.card(tr('hlp|Lessons in this path'), steps)}` });
  });

  // ---------- a lesson ----------
  function lessonCues(l, lang) {
    const recorded = help.cues(l.id, lang);
    if (recorded) return { cues: recorded, timed: true };
    const said = l.steps.filter((s) => s.say).map((s, i) => ({ start: null, end: null, text: help.textOf(s.say, lang), step: i + 1 }));
    return { cues: [{ start: null, end: null, text: help.textOf(l.summary, lang), step: 0, intro: true }, ...said], timed: false };
  }
  function playerHtml(req, l, { lang, progressUrl = '', startAt = 0, langSwitch = '', portal = false }) {
    const m = help.media(l.id, lang);
    const { cues } = lessonCues(l, lang);
    const steps = cues.filter((c) => !c.intro && c.start !== null);
    if (!m) {
      return `<div class="hlp-player hlp-player--none">${thumb(req, l, { big: true })}<div class="hlp-player__soon"><b>${esc(tr('hlp|The video for this lesson is being prepared.'))}</b><span>${esc(tr('hlp|Read the steps below, or let the office show you on the real page.'))}</span></div></div>`;
    }
    const s = (key) => esc(tr(key));
    return `<div class="hlp-player" data-hlp-player data-lang="${lang}" data-cues="${esc(m.json)}" data-progress="${esc(progressUrl)}" data-start="${Number(startAt) || 0}" data-duration="${m.duration}"
        data-t-play="${s('hlp|Play')}" data-t-pause="${s('hlp|Pause')}" data-t-novoice="${s('hlp|This device has no voice for this language.')}" data-portal="${portal ? 1 : 0}">
      <div class="hlp-player__screen">
        <video class="hlp-video" preload="metadata" playsinline poster="${esc(m.jpg)}" data-hlp-video><source src="${esc(m.mp4)}" type="video/mp4"><track kind="captions" src="${esc(m.vtt)}" srclang="${lang}" label="${lang === 'ar' ? 'العربية' : 'English'}"></video>
        <div class="hlp-cap" data-hlp-cap aria-live="polite" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"></div>
        <button type="button" class="hlp-big" data-hlp-big aria-label="${s('hlp|Play')}">${ui.icon('play')}</button>
        <div class="hlp-toast" data-hlp-toast hidden></div>
      </div>
      <div class="hlp-ctrl" dir="ltr">
        <button type="button" class="hlp-btn" data-hlp-toggle aria-label="${s('hlp|Play')}" title="${s('hlp|Play')} (K)"><svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg class="i-pause" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg></button>
        <button type="button" class="hlp-btn" data-hlp-prev title="${s('hlp|Previous step')}" aria-label="${s('hlp|Previous step')}"><svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
        <button type="button" class="hlp-btn" data-hlp-next title="${s('hlp|Next step')}" aria-label="${s('hlp|Next step')}"><svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
        <span class="hlp-time" data-hlp-time>0:00 / ${fmtDur(m.duration)}</span>
        <div class="hlp-scrub" data-hlp-scrub role="slider" tabindex="0" aria-label="${s('hlp|Position')}" aria-valuemin="0" aria-valuemax="${Math.round(m.duration)}"><div class="hlp-scrub__buf"></div><div class="hlp-scrub__fill" data-hlp-fill></div>
          ${steps.map((c) => `<i class="hlp-scrub__mark" style="left:${((c.start / m.duration) * 100).toFixed(2)}%" title="${esc(c.text)}"></i>`).join('')}<div class="hlp-scrub__tip" data-hlp-tip hidden></div></div>
        <button type="button" class="hlp-btn hlp-btn--txt" data-hlp-speed title="${s('hlp|Speed')}">1×</button>
        <button type="button" class="hlp-btn hlp-btn--txt is-on" data-hlp-cc title="${s('hlp|Captions')} (C)" aria-pressed="true">CC</button>
        <button type="button" class="hlp-btn" data-hlp-voice title="${s('hlp|Read aloud')} (R)" aria-pressed="false"><svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        ${langSwitch}
        <button type="button" class="hlp-btn" data-hlp-full title="${s('hlp|Full screen')} (F)" aria-label="${s('hlp|Full screen')}"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
    </div>`;
  }
  function transcriptHtml(req, l, lang, { forPrint = false } = {}) {
    const { cues, timed } = lessonCues(l, lang);
    const lines = cues.map((c, i) => `<li class="hlp-line${c.intro ? ' hlp-line--intro' : ''}" data-i="${i}"${timed ? ` data-start="${c.start}" data-end="${c.end}"` : ''}>${timed && !forPrint ? `<button type="button" class="hlp-line__go" data-hlp-seek="${c.start}"><time>${fmtDur(c.start)}</time></button>` : timed ? `<time>${fmtDur(c.start)}</time>` : `<span class="hlp-line__n">${c.intro ? '•' : c.step}</span>`}<p>${esc(c.text)}</p></li>`).join('');
    return `<ol class="hlp-lines" data-hlp-lines dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang}">${lines}</ol>`;
  }
  const langLinks = (req, l, lang, base) => {
    const other = lang === 'ar' ? 'en' : 'ar';
    return help.media(l.id, other) ? `<a class="hlp-btn hlp-btn--txt hlp-btn--lang" href="${base}?doc=${other}" title="${esc(tr('hlp|Watch in the other language'))}">${other === 'ar' ? 'ع' : 'EN'}</a>` : '';
  };

  router.get('/help/l/:id', (req, res, next) => {
    const l = help.load().byId.get(req.params.id);
    if (!l) return next();
    if (l.area === 'portal' && !req.query.staff) { /* staff can watch the tenant lessons too */ }
    const lang = ['en', 'ar'].includes(req.query.doc) ? req.query.doc : L(req);
    const prog = progressOf(req.user.id);
    const p = prog.get(l.id);
    const base = `/admin/help/l/${l.id}`;
    const pathKey = help.PATHS.some((x) => x.key === req.query.path) ? req.query.path : null;
    const sameArea = lessons().filter((x) => x.area === l.area);
    const seq = pathKey ? pathLessons(pathKey) : l.area === 'portal' ? portalLessons() : sameArea;
    const idx = seq.findIndex((x) => x.id === l.id);
    const nextL = idx >= 0 ? seq[idx + 1] : null;
    const prevL = idx > 0 ? seq[idx - 1] : null;
    const [, areaLabel, areaIc] = areaOf(l.area);
    const m = help.media(l.id, lang);
    const dur = seconds(l, lang);
    const tourable = l.area !== 'portal' && canOpen(req, l.module);
    const csrf = req.session.csrf;
    const startAt = p && !p.done_at && p.pos > 3 && (!p.dur || p.pos < p.dur - 4) ? p.pos : 0;
    const player = playerHtml(req, l, { lang, progressUrl: `${base}/progress`, startAt, langSwitch: langLinks(req, l, lang, base) });
    const { cues, timed } = lessonCues(l, lang);
    const transcript = `<section class="card hlp-transcript" data-hlp-transcript>
      <header class="card__head hlp-transcript__head"><div><h2>${esc(tr('hlp|Transcript'))}</h2><p>${esc(timed ? tr('hlp|Follows the video. Click a line to jump to it.') : tr('hlp|The steps of this lesson.'))}</p></div>
        <div class="hlp-transcript__tools">
          <label class="hlp-tsearch">${ui.icon('search')}<input type="search" data-hlp-tsearch placeholder="${esc(tr('hlp|Find in the transcript'))}" value="${esc(String(req.query.q || ''))}" aria-label="${esc(tr('hlp|Find in the transcript'))}"></label>
          <button type="button" class="btn btn--ghost btn--sm" data-hlp-copy data-done="${esc(tr('hlp|Copied'))}">${esc(tr('hlp|Copy'))}</button>
          <a class="btn btn--ghost btn--sm" href="${base}/transcript.txt?doc=${lang}" download>${ui.icon('dl')}<span>${esc(tr('hlp|Download'))}</span></a>
          <a class="btn btn--ghost btn--sm" href="${base}/transcript?doc=${lang}" target="_blank" rel="noopener">${ui.icon('print')}<span>${esc(tr('hlp|Print'))}</span></a>
          ${timed ? `<label class="check hlp-follow"><input type="checkbox" data-hlp-follow checked> ${esc(tr('hlp|Follow the video'))}</label>` : ''}
        </div></header>
      <div class="card__body">${transcriptHtml(req, l, lang)}</div></section>`;
    const chapters = cues.filter((c) => !c.intro);
    const facts = `<dl class="hlp-facts"><div><dt>${esc(tr('hlp|Area'))}</dt><dd>${ui.icon(areaIc)}<span>${esc(tr(areaLabel))}</span></dd></div><div><dt>${esc(tr('hlp|Length'))}</dt><dd>${esc(fmtDur(dur))}</dd></div><div><dt>${esc(tr('hlp|Steps'))}</dt><dd>${chapters.length}</dd></div><div><dt>${esc(tr('hlp|Level'))}</dt><dd>${esc(tr(LEVELS[l.level] || LEVELS.basic))}</dd></div></dl>`;
    const doneState = p && p.done_at;
    const actionsCard = `<section class="card hlp-do"><div class="card__body">
      ${tourable ? `<a class="btn btn--primary btn--block hlp-showme" href="${esc(l.module || '/admin')}${(l.module || '').includes('?') ? '&' : '?'}tour=${esc(l.id)}" data-hlp-tour="${esc(l.id)}">${ui.icon('flow')}<span>${esc(tr('hlp|Show me on the real page'))}</span></a><p class="muted small">${esc(tr('hlp|The office points at each step while you do it yourself.'))}</p>` : l.area === 'portal' ? '' : `<p class="muted small">${esc(tr('hlp|You do not have access to this module, so the live tour is not available.'))}</p>`}
      ${ui.form(`${base}/done`, csrf, `<input type="hidden" name="done" value="${doneState ? 0 : 1}">${ui.btn(esc(doneState ? tr('hlp|Watched · undo') : tr('hlp|Mark as watched')), { cls: `btn--ghost btn--block${doneState ? ' is-done' : ''}`, ic: 'check' })}`)}
    </div></section>`;
    const chaptersCard = timed ? ui.card(tr('hlp|Steps'), `<ol class="hlp-chapters">${chapters.map((c, i) => `<li><button type="button" data-hlp-seek="${c.start}"><span class="hlp-chapters__n">${i + 1}</span><span class="hlp-chapters__t">${esc(c.text.length > 90 ? `${c.text.slice(0, 88)}…` : c.text)}</span><time>${fmtDur(c.start)}</time></button></li>`).join('')}</ol>`, { cls: 'hlp-chapcard' }) : '';
    const fb = db.get('SELECT * FROM hlp_feedback WHERE user_id = ? AND lesson_id = ? ORDER BY id DESC LIMIT 1', req.user.id, l.id);
    const feedback = ui.card(tr('hlp|Was this helpful?'), fb ? `<p class="muted pad">${esc(fb.helpful ? tr('hlp|Thank you. Glad it helped.') : tr('hlp|Thank you. We will make it clearer.'))}</p>`
      : ui.form(`${base}/feedback`, csrf, `<div class="hlp-fb"><button class="btn btn--ghost btn--sm" name="helpful" value="1" type="submit">👍 ${esc(tr('hlp|Yes'))}</button><button class="btn btn--ghost btn--sm" name="helpful" value="0" type="submit">👎 ${esc(tr('hlp|Not really'))}</button></div><input type="text" name="note" class="hlp-fb__note" placeholder="${esc(tr('hlp|What was missing? (optional)'))}" maxlength="500">`));
    const nextCard = nextL ? `<a class="hlp-next" href="/admin/help/l/${esc(nextL.id)}${pathKey ? `?path=${pathKey}` : ''}" data-hlp-nextlesson>${thumb(req, nextL)}<span><small>${esc(tr('hlp|Up next'))}</small><b>${esc(T(req, nextL.title))}</b></span></a>` : '';
    const related = sameArea.filter((x) => x.id !== l.id && (!nextL || x.id !== nextL.id)).slice(0, 4);
    const relatedCard = related.length ? ui.card(tr('hlp|More in this area'), `<div class="hlp-mini">${related.map((x) => `<a href="/admin/help/l/${esc(x.id)}">${thumb(req, x)}<span>${esc(T(req, x.title))}</span></a>`).join('')}</div>`) : '';
    const top = `<div class="hlp-lesson__top"><span class="hlp-pill">${ui.icon(areaIc)}${esc(tr(areaLabel))}</span>${doneState ? `<span class="hlp-pill is-ok">${ui.icon('check')}${esc(tr('hlp|Watched'))}</span>` : ''}<p>${esc(T(req, l.summary))}</p></div>`;
    const nav = `<div class="hlp-lesson__nav">${prevL ? `<a class="btn btn--ghost btn--sm" href="/admin/help/l/${esc(prevL.id)}${pathKey ? `?path=${pathKey}` : ''}">${ui.icon('back')}<span>${esc(T(req, prevL.title))}</span></a>` : '<span></span>'}${nextL ? `<a class="btn btn--ghost btn--sm hlp-lesson__nextbtn" href="/admin/help/l/${esc(nextL.id)}${pathKey ? `?path=${pathKey}` : ''}"><span>${esc(T(req, nextL.title))}</span>${ui.icon('arrow')}</a>` : ''}</div>`;
    const body = `<div class="hlp-lesson${m ? '' : ' hlp-lesson--nomedia'}">
      <div class="hlp-lesson__main">${top}${player}${transcript}${nav}</div>
      <aside class="hlp-lesson__side">${actionsCard}${ui.card(tr('hlp|About this lesson'), facts)}${chaptersCard}${nextCard}${feedback}${relatedCard}</aside>
    </div>`;
    page(req, res, { title: T(req, l.title), active: '/admin/help', crumbs: [['/admin/help', tr('nav|Help & training')], pathKey ? [`/admin/help/paths/${pathKey}`, tr(help.PATHS.find((x) => x.key === pathKey).label)] : [`/admin/help#area-${l.area}`, tr(areaLabel)]], body });
  });

  // progress from the player: { pos, dur, seen (0..1) }
  router.post('/help/l/:id/progress', (req, res) => {
    const l = help.load().byId.get(req.params.id);
    if (!l) return res.status(404).json({ ok: false });
    const pos = Math.max(0, Number(req.body.pos) || 0);
    const dur = Math.max(0, Number(req.body.dur) || 0) || null;
    const seen = Math.max(0, Math.min(1, Number(req.body.seen) || 0));
    const lang = ['en', 'ar'].includes(req.body.lang) ? req.body.lang : L(req);
    const old = db.get('SELECT * FROM hlp_progress WHERE user_id = ? AND lesson_id = ?', req.user.id, l.id);
    const best = Math.max(seen, old ? old.seen : 0);
    const done = old && old.done_at ? old.done_at : best >= 0.9 || req.body.ended ? now() : null;
    if (old) db.run('UPDATE hlp_progress SET lang = ?, pos = ?, dur = ?, seen = ?, done_at = ?, updated_at = ? WHERE user_id = ? AND lesson_id = ?', lang, pos, dur, best, done, now(), req.user.id, l.id);
    else db.run('INSERT INTO hlp_progress (user_id, lesson_id, lang, pos, dur, seen, done_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', req.user.id, l.id, lang, pos, dur, best, done, now());
    res.json({ ok: true, seen: best, done: !!done });
  });
  router.post('/help/l/:id/done', (req, res, next) => {
    const l = help.load().byId.get(req.params.id);
    if (!l) return next();
    const on = req.body.done !== '0';
    const old = db.get('SELECT * FROM hlp_progress WHERE user_id = ? AND lesson_id = ?', req.user.id, l.id);
    if (old) db.run('UPDATE hlp_progress SET done_at = ?, seen = ?, updated_at = ? WHERE user_id = ? AND lesson_id = ?', on ? now() : null, on ? Math.max(old.seen, 1) : Math.min(old.seen, 0.89), now(), req.user.id, l.id);
    else if (on) db.run('INSERT INTO hlp_progress (user_id, lesson_id, lang, pos, dur, seen, done_at, updated_at) VALUES (?, ?, ?, 0, NULL, 1, ?, ?)', req.user.id, l.id, L(req), now(), now());
    h.back(req, res, `/admin/help/l/${l.id}`, 'ok', on ? tr('hlp|Marked as watched.') : tr('hlp|Marked as not watched.'));
  });
  router.post('/help/l/:id/feedback', (req, res, next) => {
    const l = help.load().byId.get(req.params.id);
    if (!l) return next();
    db.run('INSERT INTO hlp_feedback (user_id, lesson_id, helpful, note, created_at) VALUES (?, ?, ?, ?, ?)', req.user.id, l.id, req.body.helpful === '1' ? 1 : 0, h.str(req.body.note, 500) || null, now());
    h.back(req, res, `/admin/help/l/${l.id}`, 'ok', tr('hlp|Thank you for the feedback.'));
  });
  // the transcript as text, and as a printable page
  router.get('/help/l/:id/transcript.txt', (req, res, next) => {
    const l = help.load().byId.get(req.params.id);
    if (!l) return next();
    const lang = ['en', 'ar'].includes(req.query.doc) ? req.query.doc : L(req);
    const { cues, timed } = lessonCues(l, lang);
    const text = `${help.textOf(l.title, lang)}\n${'='.repeat(40)}\n\n${cues.map((c) => `${timed ? `[${fmtDur(c.start)}] ` : ''}${c.text}`).join('\n\n')}\n`;
    res.set('Content-Disposition', `attachment; filename="${l.id}-${lang}.txt"`).type('text/plain; charset=utf-8').send(`﻿${text}`);
  });
  router.get('/help/l/:id/transcript', (req, res, next) => {
    const l = help.load().byId.get(req.params.id);
    if (!l) return next();
    const lang = ['en', 'ar'].includes(req.query.doc) ? req.query.doc : L(req);
    const doc = `<article class="hlp-print" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang}"><header>${ui.logo('hlp-print__logo')}<p>${esc(lang === 'ar' ? 'ذا ويف · المساعدة والتدريب' : 'The Wave · Help & training')}</p></header><h1>${esc(help.textOf(l.title, lang))}</h1><p class="hlp-print__sum">${esc(help.textOf(l.summary, lang))}</p>${transcriptHtml(req, l, lang, { forPrint: true })}</article>`;
    res.type('html').send(ui.bare ? ui.bare({ title: help.textOf(l.title, lang), body: doc }) : doc);
  });

  // the live tour: the steps of a lesson with where each one happens
  router.get('/help/l/:id/tour.json', (req, res) => {
    const l = help.load().byId.get(req.params.id);
    if (!l) return res.status(404).json({ ok: false });
    const lang = L(req);
    let recorded = null;
    try { recorded = JSON.parse(require('node:fs').readFileSync(require('node:path').join(help.MEDIA_DIR, lang, `${l.id}.json`), 'utf8')); } catch {}
    if (!recorded) try { recorded = JSON.parse(require('node:fs').readFileSync(require('node:path').join(help.MEDIA_DIR, lang === 'ar' ? 'en' : 'ar', `${l.id}.json`), 'utf8')); } catch {}
    const urls = recorded && recorded.steps ? recorded.steps.map((x) => x.url) : [];
    let at = l.module || '/admin';
    const steps = [];
    l.steps.forEach((s, i) => {
      const kind = help.kindOf(s);
      const here = kind === 'go' ? s.go : at;
      const sel = kind === 'type' ? s.type[0] : kind === 'select' ? s.select[0] : ['point', 'click', 'check', 'hover', 'scroll'].includes(kind) && typeof s[kind] === 'string' ? s[kind] : null;
      if (s.say) {
        steps.push({
          n: steps.length + 1, kind, sel, has: s.has === undefined ? null : help.textOf(s.has, lang), nth: s.nth === undefined ? null : s.nth,
          text: help.textOf(s.say, lang), page: String(here).split('?')[0], value: kind === 'type' ? help.textOf(s.type[1], lang) : null,
        });
      }
      if (kind === 'go') at = s.go;
      else if (urls[i] && urls[i] !== at && s.nav) at = urls[i];
    });
    res.json({ ok: true, id: l.id, title: help.textOf(l.title, lang), back: `/admin/help/l/${l.id}`, lang, steps,
      t: { next: tr('hlp|Next'), back: tr('hlp|Back'), end: tr('hlp|End the tour'), done: tr('hlp|Finish'), open: tr('hlp|Open this page'), step: tr('hlp|Step {n} of {total}'), missing: tr('hlp|This part is not on the screen. It may need a record that is not here, or other access.'), type: tr('hlp|Type, for example:'), title: tr('hlp|Guided tour'), finished: tr('hlp|Tour complete. Well done!') } });
  });

  // ---------- questions, glossary, what's new, shortcuts ----------
  router.get('/help/faq', (req, res) => {
    const groups = help.AREAS.map(([k, label, ic]) => {
      const list = content.FAQ.filter((f) => f.area === k);
      return list.length ? `<section class="hlp-faqgroup"><h3>${ui.icon(ic)}${esc(tr(label))}</h3>${list.map((f) => `<details class="hlp-faq"><summary>${esc(T(req, f.q))}</summary><p>${esc(T(req, f.a))}</p></details>`).join('')}</section>` : '';
    }).join('');
    page(req, res, { title: tr('hlp|Questions people ask'), active: '/admin/help/faq', body: `${ui.card(tr('hlp|Questions people ask'), groups, { sub: esc(tr('hlp|Cannot find the answer? Ask support.')), action: supportBtn(req, '') })}` });
  });
  router.get('/help/glossary', (req, res) => {
    const list = [...content.GLOSSARY].sort((a, b) => T(req, a.term).localeCompare(T(req, b.term), L(req)));
    page(req, res, { title: tr('hlp|Glossary'), active: '/admin/help/glossary', body: ui.card(tr('hlp|Glossary'), `<dl class="hlp-gloss">${list.map((g) => `<div><dt>${esc(T(req, g.term))}</dt><dd>${esc(T(req, g.def))}</dd></div>`).join('')}</dl>`, { sub: esc(tr('hlp|The words used in leasing and in the office, explained.')) }) });
  });
  router.get('/help/new', (req, res) => {
    const items = content.NEWS.map((n) => `<article class="hlp-news"><time>${esc(ui.date(n.date))}</time><div><h3>${esc(T(req, n.title))}</h3><ul>${n.items.map((x) => `<li>${esc(T(req, x))}</li>`).join('')}</ul>${n.link ? `<a class="btn btn--ghost btn--sm" href="${esc(n.link)}">${esc(tr('hlp|Open'))}</a>` : ''}</div></article>`).join('');
    page(req, res, { title: tr("hlp|What's new"), active: '/admin/help/new', body: ui.card(tr("hlp|What's new"), `<div class="hlp-newslist">${items}</div>`) });
  });
  router.get('/help/shortcuts', (req, res) => {
    const g = content.SHORTCUTS.map((s) => `<section class="hlp-keys"><h3>${esc(T(req, s.group))}</h3><dl>${s.keys.map((k) => `<div><dt>${k.k.split(' / ').map((x) => `<code class="hlp-key">${esc(x)}</code>`).join(' ')}</dt><dd>${esc(T(req, k.what))}</dd></div>`).join('')}</dl></section>`).join('');
    page(req, res, { title: tr('hlp|Keyboard shortcuts'), active: '/admin/help/shortcuts', body: ui.card(tr('hlp|Keyboard shortcuts'), `<div class="hlp-keysgrid">${g}</div>`) });
  });

  // ---------- support ----------
  const panel = uploadRoute(router, h, '/help/files', { hlp_ticket: 'hlp_tickets' }, { canUpload: (req) => !!req.user });
  const canSee = (req, t) => isStaff(req) || t.user_id === req.user.id;
  const statusBadge = (s) => ui.badge(s, tr(STATUS[s][0]), STATUS[s][1]);
  router.get('/help/support', (req, res) => {
    const staff = isStaff(req);
    const which = staff && req.query.mine !== '1' ? 'all' : 'mine';
    const st = ['open', 'answered', 'closed'].includes(req.query.status) ? req.query.status : '';
    const where = [];
    const args = [];
    if (which === 'mine') { where.push('t.user_id = ?'); args.push(req.user.id); }
    if (st) { where.push('t.status = ?'); args.push(st); }
    const rows = db.all(`SELECT t.*, u.name person, (SELECT COUNT(*) FROM hlp_replies r WHERE r.ticket_id = t.id) replies FROM hlp_tickets t LEFT JOIN users u ON u.id = t.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.status = 'closed', t.updated_at DESC LIMIT 300`, ...args);
    const table = ui.table([
      { label: tr('hlp|Request'), render: (t) => `<b>${esc(t.subject)}</b><small class="sub"><span class="ltr">${esc(t.ref)}</span> · ${esc(tr(CATEGORIES[t.category] || CATEGORIES.other))}</small>`, sort: (t) => t.subject },
      ...(which === 'all' ? [{ label: tr('hlp|From'), render: (t) => esc(t.person || '—'), sort: (t) => t.person }] : []),
      { label: tr('Status'), render: (t) => `${statusBadge(t.status)}${t.user_id === req.user.id && t.staff_reply_at && (!t.user_seen_at || t.user_seen_at < t.staff_reply_at) && t.status !== 'closed' ? ` <b class="hlp-new">${esc(tr('hlp|New reply'))}</b>` : ''}`, sort: (t) => t.status },
      { label: tr('hlp|Replies'), num: true, render: (t) => String(t.replies), sort: (t) => t.replies },
      { label: tr('hlp|Updated'), render: (t) => esc(ui.rel(t.updated_at)), sort: (t) => t.updated_at },
    ], rows, { href: (t) => `/admin/help/support/${t.id}`, empty: esc(tr('hlp|No support requests yet.')) });
    const filt = `<nav class="tabs tabs--sub">${[['', 'hlp|All'], ['open', 'hlp|Waiting for support'], ['answered', 'hlp|Answered'], ['closed', 'hlp|Closed']].map(([k, label]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/help/support?${new URLSearchParams({ ...(k ? { status: k } : {}), ...(which === 'mine' && staff ? { mine: '1' } : {}) })}">${esc(tr(label))}</a>`).join('')}${staff ? `<a class="tab${which === 'mine' ? ' is-on' : ''}" href="/admin/help/support?mine=1">${esc(tr('hlp|Only mine'))}</a>` : ''}</nav>`;
    const intro = `<section class="hlp-supporthero">${ui.icon('chat')}<div><h2>${esc(tr('hlp|How can we help?'))}</h2><p>${esc(staff ? tr('hlp|Requests from the team come here. Reply, and the person is told by email and in Help & training.') : tr('hlp|Ask a question, report a problem or suggest an idea. The administrators reply here and by email.'))}</p></div>${ui.btn(esc(tr('hlp|New request')), { href: '/admin/help/support/new', cls: 'btn--primary', ic: 'plus' })}</section>`;
    page(req, res, { title: tr('hlp|Support'), active: '/admin/help/support', body: `${intro}${filt}${ui.card(staff && which === 'all' ? tr('hlp|All requests') : tr('hlp|Your requests'), table)}` });
  });
  router.get('/help/support/new', (req, res) => {
    const pageFrom = h.str(req.query.page, 300) || h.str(String(req.get('referer') || '').replace(/^https?:\/\/[^/]+/, ''), 300);
    const csrf = req.session.csrf;
    const lessonsHere = pageFrom ? help.forPage(pageFrom).filter((l) => l.area !== 'portal').slice(0, 3) : [];
    const hint = lessonsHere.length ? ui.card(tr('hlp|These lessons may answer it'), `<div class="hlp-mini">${lessonsHere.map((x) => `<a href="/admin/help/l/${esc(x.id)}">${thumb(req, x)}<span>${esc(T(req, x.title))}</span></a>`).join('')}</div>`) : '';
    const form = ui.form('/admin/help/support', csrf, `<div class="fields">
        ${ui.input('subject', tr('hlp|Subject'), '', { required: true, cls: 'span-all', placeholder: tr('hlp|e.g. I cannot print an invoice') })}
        ${ui.select('category', tr('hlp|What is it about?'), Object.entries(CATEGORIES).map(([k, v]) => [k, tr(v)]), String(req.query.category || 'question'))}
        ${ui.input('page', tr('hlp|Page'), pageFrom, { hint: tr('hlp|Filled in for you: the page you came from.') })}
        ${ui.textarea('body', tr('hlp|Tell us more'), '', { rows: 6, cls: 'span-all', placeholder: tr('hlp|What did you do, what did you expect, and what happened?') })}
      </div><input type="hidden" name="agent" value="" data-hlp-agent><p class="muted small">${esc(tr('hlp|Your browser and screen size are added so support can see the problem the way you do. You can add a screenshot after sending.'))}</p>
      ${ui.btn(esc(tr('hlp|Send to support')), { cls: 'btn--primary', ic: 'arrow' })}`, { cls: 'stack' });
    page(req, res, { title: tr('hlp|New support request'), active: '/admin/help/support', crumbs: [['/admin/help', tr('nav|Help & training')], ['/admin/help/support', tr('hlp|Support')]], body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('hlp|New support request'), form)}</div><div class="stack">${hint}${ui.card(tr('hlp|Before you send'), `<ul class="hlp-tips"><li>${esc(tr('hlp|Say which record it is about (a lease, an invoice, a unit…).'))}</li><li>${esc(tr('hlp|Copy any error message exactly.'))}</li><li>${esc(tr('hlp|A screenshot helps a lot: add it on the next page.'))}</li></ul>`)}</div></div>` });
  });
  router.post('/help/support', (req, res) => {
    const subject = h.str(req.body.subject, 160);
    const body = h.str(req.body.body, 5000);
    if (!subject || !body) return h.back(req, res, `/admin/help/support/new?page=${encodeURIComponent(h.str(req.body.page, 300))}`, 'error', tr('hlp|Write a subject and a few words about it.'));
    const category = CATEGORIES[req.body.category] ? req.body.category : 'other';
    const ref = db.nextRef('hlp_tickets', 'HLP', 4, true);
    const id = Number(db.run('INSERT INTO hlp_tickets (ref, user_id, subject, category, body, page, agent, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ref, req.user.id, subject, category, body, h.str(req.body.page, 300) || null, h.str(req.body.agent, 300) || h.str(req.get('user-agent'), 300) || null, 'open', now(), now()).lastInsertRowid);
    h.log(req, 'Sent a support request', 'hlp_ticket', id, `${ref} · ${subject}`);
    const site = (h.env && h.env.SITE_URL) || '';
    for (const a of db.all("SELECT email, lang FROM users WHERE role = 'admin' AND active = 1 AND id != ?", req.user.id)) {
      const ar = a.lang === 'ar';
      mailTo({
        to: a.email,
        subject: ar ? `طلب دعم جديد ${ref}: ${subject}` : `New support request ${ref}: ${subject}`,
        text: `${req.user.name}\n\n${body}\n\n${site}/admin/help/support/${id}`,
        lang: a.lang, related: { entity: 'hlp_ticket', id },
      });
    }
    h.back(req, res, `/admin/help/support/${id}`, 'ok', tr('hlp|Sent. You will be told here and by email when support replies.'));
  });
  router.get('/help/support/:id(\\d+)', (req, res, next) => {
    const t = db.get('SELECT t.*, u.name person, u.email person_email FROM hlp_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?', h.int(req.params.id));
    if (!t || !canSee(req, t)) return next();
    if (t.user_id === req.user.id) db.run('UPDATE hlp_tickets SET user_seen_at = ? WHERE id = ?', now(), t.id);
    const replies = db.all('SELECT r.*, u.name FROM hlp_replies r LEFT JOIN users u ON u.id = r.user_id WHERE r.ticket_id = ? ORDER BY r.id', t.id);
    const csrf = req.session.csrf;
    const msg = (who, body, at, staffSide) => `<li class="hlp-msg${staffSide ? ' hlp-msg--staff' : ''}"><span class="avatar avatar--sm">${esc(ui.initials(who || '?'))}</span><div><p class="hlp-msg__who"><b>${esc(who || '—')}</b>${staffSide ? ` <em>${esc(tr('hlp|Support'))}</em>` : ''} · <time>${esc(ui.rel(at))}</time></p><p class="hlp-msg__body">${esc(body)}</p></div></li>`;
    const thread = `<ol class="hlp-thread">${msg(t.person, t.body, t.created_at, false)}${replies.map((r) => msg(r.name, r.body, r.created_at, !!r.staff)).join('')}</ol>`;
    const reply = t.status === 'closed' ? '' : ui.form(`/admin/help/support/${t.id}/reply`, csrf, `${ui.textarea('body', isStaff(req) && t.user_id !== req.user.id ? tr('hlp|Your reply') : tr('hlp|Add to the request'), '', { rows: 4 })}${ui.btn(esc(tr('hlp|Send')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack hlp-reply' });
    const facts = `<dl class="hlp-facts hlp-facts--list"><div><dt>${esc(tr('Status'))}</dt><dd>${statusBadge(t.status)}</dd></div><div><dt>${esc(tr('hlp|From'))}</dt><dd>${esc(t.person || '—')}</dd></div><div><dt>${esc(tr('hlp|What is it about?'))}</dt><dd>${esc(tr(CATEGORIES[t.category] || CATEGORIES.other))}</dd></div>
      ${t.page ? `<div><dt>${esc(tr('hlp|Page'))}</dt><dd>${/^\/admin(\/|$|\?)/.test(t.page) ? `<a class="ltr" href="${esc(t.page)}">${esc(t.page)}</a>` : `<span class="ltr">${esc(t.page)}</span>`}</dd></div>` : ''}
      ${t.agent && isStaff(req) ? `<div><dt>${esc(tr('hlp|Browser'))}</dt><dd class="ltr hlp-agent">${esc(t.agent)}</dd></div>` : ''}<div><dt>${esc(tr('hlp|Sent'))}</dt><dd>${esc(ui.dt ? ui.dt(t.created_at) : t.created_at)}</dd></div></dl>`;
    const statusForm = ui.form(`/admin/help/support/${t.id}/status`, csrf, `<input type="hidden" name="status" value="${t.status === 'closed' ? 'open' : 'closed'}">${ui.btn(esc(t.status === 'closed' ? tr('hlp|Reopen') : tr('hlp|Close the request')), { cls: 'btn--ghost btn--sm btn--block' })}`);
    const here = t.page ? help.forPage(t.page).filter((l) => l.area !== 'portal').slice(0, 3) : [];
    const lessonsCard = here.length ? ui.card(tr('hlp|Lessons for that page'), `<div class="hlp-mini">${here.map((x) => `<a href="/admin/help/l/${esc(x.id)}">${thumb(req, x)}<span>${esc(T(req, x.title))}</span></a>`).join('')}</div>`) : '';
    const body = `<div class="grid grid--side"><div class="stack">${ui.card(t.subject, `${thread}${reply}`, { sub: `<span class="ltr">${esc(t.ref)}</span>` })}</div>
      <div class="stack">${ui.card(tr('hlp|Details'), `${facts}${statusForm}`)}${panel(req, 'hlp_ticket', t.id, { title: tr('hlp|Screenshots and files') })}${lessonsCard}</div></div>`;
    page(req, res, { title: `${t.ref}`, active: '/admin/help/support', crumbs: [['/admin/help', tr('nav|Help & training')], ['/admin/help/support', tr('hlp|Support')]], body });
  });
  router.post('/help/support/:id(\\d+)/reply', (req, res, next) => {
    const t = db.get('SELECT t.*, u.email person_email, u.lang person_lang FROM hlp_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?', h.int(req.params.id));
    if (!t || !canSee(req, t)) return next();
    const body = h.str(req.body.body, 5000);
    if (!body) return h.back(req, res, `/admin/help/support/${t.id}`, 'error', tr('hlp|Write a reply first.'));
    const staff = isStaff(req) && t.user_id !== req.user.id ? 1 : 0;
    db.run('INSERT INTO hlp_replies (ticket_id, user_id, body, staff, created_at) VALUES (?, ?, ?, ?, ?)', t.id, req.user.id, body, staff, now());
    if (staff) db.run("UPDATE hlp_tickets SET status = 'answered', staff_reply_at = ?, updated_at = ? WHERE id = ?", now(), now(), t.id);
    else db.run("UPDATE hlp_tickets SET status = 'open', updated_at = ? WHERE id = ?", now(), t.id);
    h.log(req, 'Replied to a support request', 'hlp_ticket', t.id, t.ref);
    const site = (h.env && h.env.SITE_URL) || '';
    if (staff && t.person_email) {
      const ar = t.person_lang === 'ar';
      mailTo({ to: t.person_email, subject: ar ? `رد على طلب الدعم ${t.ref}: ${t.subject}` : `Reply to your support request ${t.ref}: ${t.subject}`, text: `${body}\n\n${site}/admin/help/support/${t.id}`, lang: t.person_lang, related: { entity: 'hlp_ticket', id: t.id } });
    } else if (!staff) {
      for (const a of db.all("SELECT email, lang FROM users WHERE role = 'admin' AND active = 1 AND id != ?", req.user.id)) {
        mailTo({ to: a.email, subject: a.lang === 'ar' ? `إضافة إلى طلب الدعم ${t.ref}` : `More on support request ${t.ref}`, text: `${req.user.name}\n\n${body}\n\n${site}/admin/help/support/${t.id}`, lang: a.lang, related: { entity: 'hlp_ticket', id: t.id } });
      }
    }
    h.back(req, res, `/admin/help/support/${t.id}`, 'ok', tr('hlp|Sent.'));
  });
  router.post('/help/support/:id(\\d+)/status', (req, res, next) => {
    const t = db.get('SELECT * FROM hlp_tickets WHERE id = ?', h.int(req.params.id));
    if (!t || !canSee(req, t)) return next();
    const close = req.body.status === 'closed';
    db.run('UPDATE hlp_tickets SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?', close ? 'closed' : 'open', close ? now() : null, now(), t.id);
    h.log(req, close ? 'Closed a support request' : 'Reopened a support request', 'hlp_ticket', t.id, t.ref);
    h.back(req, res, `/admin/help/support/${t.id}`, 'ok', close ? tr('hlp|Request closed.') : tr('hlp|Request reopened.'));
  });

  // ---------- the team's training (managers) ----------
  const trainingRows = () => {
    const people = db.all('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name');
    const all = lessons();
    const paths = help.PATHS.filter((p) => p.key !== 'tenant').map((p) => ({ ...p, list: pathLessons(p.key) })).filter((p) => p.list.length);
    const rows = people.map((u) => {
      const prog = progressOf(u.id);
      const done = all.filter((l) => (prog.get(l.id) || {}).done_at).length;
      const last = [...prog.values()].reduce((m, p) => (p.updated_at > m ? p.updated_at : m), '');
      return { ...u, done, total: all.length, last, paths: paths.map((p) => p.list.filter((l) => (prog.get(l.id) || {}).done_at).length / p.list.length) };
    });
    return { rows, paths, total: all.length };
  };
  router.get('/help/training', h.R('manager'), (req, res) => {
    const { rows, paths, total } = trainingRows();
    const fb = db.all('SELECT lesson_id, SUM(helpful) yes, COUNT(*) n FROM hlp_feedback GROUP BY lesson_id ORDER BY n DESC LIMIT 12');
    const pct = (x) => `${Math.round(x * 100)}%`;
    const table = ui.table([
      { label: tr('hlp|Person'), render: (u) => `<b>${esc(u.name)}</b>`, sort: (u) => u.name },
      { label: tr('hlp|Lessons watched'), render: (u) => `<span class="hlp-tbar">${ui.meter(u.total ? u.done / u.total : 0, 'forest')}<b>${u.done} / ${u.total}</b></span>`, sort: (u) => u.done },
      ...paths.map((p, i) => ({ label: tr(p.label), num: true, render: (u) => (u.paths[i] >= 1 ? `<span class="hlp-okmark">${ui.icon('check')}</span>` : esc(pct(u.paths[i]))), sort: (u) => u.paths[i] })),
      { label: tr('hlp|Last watched'), render: (u) => (u.last ? esc(ui.rel(u.last)) : '<span class="muted">—</span>'), sort: (u) => u.last },
    ], rows, { empty: esc(tr('hlp|No one yet.')) });
    const avg = rows.length ? rows.reduce((s, u) => s + (total ? u.done / total : 0), 0) / rows.length : 0;
    const kpis = `<div class="kpis kpis--3">${ui.kpi({ label: tr('hlp|Average progress'), value: pct(avg), bar: avg })}${ui.kpi({ label: tr('hlp|People who started'), value: String(rows.filter((u) => u.last).length), sub: esc(tr('hlp|of {n} people', { n: rows.length })) })}${ui.kpi({ label: tr('hlp|Lessons'), value: String(total) })}</div>`;
    const fbCard = fb.length ? ui.card(tr('hlp|How helpful the lessons are'), ui.table([
      { label: tr('hlp|Lesson'), render: (f) => { const l = help.load().byId.get(f.lesson_id); return l ? `<a href="/admin/help/l/${esc(l.id)}">${esc(T(req, l.title))}</a>` : esc(f.lesson_id); } },
      { label: tr('hlp|Helpful'), num: true, render: (f) => `${Math.round((f.yes / f.n) * 100)}% <small class="muted">(${f.n})</small>` },
    ], fb)) : '';
    page(req, res, { title: tr('hlp|Team training'), active: '/admin/help', crumbs: [['/admin/help', tr('nav|Help & training')]], actions: ui.btn(esc(tr('Export CSV')), { href: '/admin/help/training/export.csv', cls: 'btn--ghost', ic: 'dl' }), body: `${kpis}${ui.card(tr('hlp|Who watched what'), table, { sub: esc(tr('hlp|A lesson counts as watched at 90% of the video, or when the person marks it.')) })}${fbCard}` });
  });
  router.get('/help/training/export.csv', h.R('manager'), (req, res) => {
    const { rows, paths } = trainingRows();
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Person', 'Role', 'Lessons watched', 'Lessons', ...paths.map((p) => p.label.split('|')[1]), 'Last watched'];
    const lines = rows.map((u) => [u.name, u.role, u.done, u.total, ...u.paths.map((x) => `${Math.round(x * 100)}%`), u.last || ''].map(q).join(','));
    res.set('Content-Disposition', 'attachment; filename="training.csv"').type('text/csv; charset=utf-8').send(`﻿${head.map(q).join(',')}\n${lines.join('\n')}\n`);
  });

  // ---------- the tenant portal ----------
  if (h.portal && h.portal.router && typeof h.portal.tab === 'function') {
    h.portal.tab({ key: 'help', href: '/portal/help', label: 'hlp|Help', icon: 'help', order: 95 });
    const P = h.portal;
    P.router.get('/help', P.requireTenant, (req, res) => {
      const list = portalLessons();
      const cards = list.length ? `<div class="hlp-grid">${list.map((l) => lessonCard(req, l, null, { base: '/portal/help/' })).join('')}</div>` : `<p class="muted pad">${esc(tr('hlp|No lessons yet.'))}</p>`;
      const faq = content.FAQ.filter((f) => f.area === 'portal');
      P.page(req, res, { title: tr('hlp|Help'), active: 'help', body: `<section class="hlp-hero hlp-hero--portal"><div class="hlp-hero__text"><p class="hlp-hero__kicker">${esc(tr('hlp|The Wave academy'))}</p><h2>${esc(tr('hlp|How to use your tenant portal'))}</h2><p>${esc(tr('hlp|Short videos with the transcript under each one.'))}</p></div></section>${ui.card(tr('hlp|Lessons'), cards)}${faq.length ? ui.card(tr('hlp|Questions'), faq.map((f) => `<details class="hlp-faq"><summary>${esc(T(req, f.q))}</summary><p>${esc(T(req, f.a))}</p></details>`).join('')) : ''}<script src="/admin/help.js?v=${VERSION()}" defer></script>` });
    });
    P.router.get('/help/:id', P.requireTenant, (req, res, next) => {
      const l = help.load().byId.get(req.params.id);
      if (!l || l.area !== 'portal') return next();
      const lang = ['en', 'ar'].includes(req.query.doc) ? req.query.doc : L(req);
      const base = `/portal/help/${l.id}`;
      const player = playerHtml(req, l, { lang, langSwitch: langLinks(req, l, lang, base), portal: true });
      const transcript = `<section class="card hlp-transcript" data-hlp-transcript><header class="card__head hlp-transcript__head"><div><h2>${esc(tr('hlp|Transcript'))}</h2></div><div class="hlp-transcript__tools"><label class="hlp-tsearch">${ui.icon('search')}<input type="search" data-hlp-tsearch placeholder="${esc(tr('hlp|Find in the transcript'))}" aria-label="${esc(tr('hlp|Find in the transcript'))}"></label><button type="button" class="btn btn--ghost btn--sm" data-hlp-copy data-done="${esc(tr('hlp|Copied'))}">${esc(tr('hlp|Copy'))}</button></div></header><div class="card__body">${transcriptHtml(req, l, lang)}</div></section>`;
      const list = portalLessons();
      const i = list.findIndex((x) => x.id === l.id);
      const nx = list[i + 1];
      P.page(req, res, { title: T(req, l.title), active: 'help', crumbs: [['/portal/help', tr('hlp|Help')]], body: `<div class="hlp-lesson hlp-lesson--portal"><div class="hlp-lesson__main"><div class="hlp-lesson__top"><p>${esc(T(req, l.summary))}</p></div>${player}${transcript}${nx ? `<div class="hlp-lesson__nav"><span></span><a class="btn btn--ghost btn--sm" href="/portal/help/${esc(nx.id)}"><span>${esc(T(req, nx.title))}</span>${ui.icon('arrow')}</a></div>` : ''}</div></div><script src="/admin/help.js?v=${VERSION()}" defer></script>` });
    });
  }

  h.help = { lessons: () => help.load().lessons, forPage: help.forPage, media: help.media };
};

module.exports.SCHEMA = SCHEMA;
module.exports.CATEGORIES = CATEGORIES;
