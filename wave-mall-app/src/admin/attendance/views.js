'use strict';

// Attendance drawings: the radar (positions around the mall, north up, true scale), the day's
// timeline strip, the month calendar, durations and times. Plain SVG and HTML, no scripts needed
// (public/admin/attendance.js only adds live updates and hover details).

const i18n = require('../i18n');
const E = require('./engine');

const { t: tr } = i18n;

module.exports = function views(ui) {
  const esc = ui.esc;
  const hm = (iso) => (iso ? E.cairo(iso).hm : '—');
  // 7 h 45 min · 45 min · 0 min
  const dur = (min) => {
    const m = Math.max(0, Math.round(Number(min) || 0));
    const hh = Math.floor(m / 60);
    const mm = m % 60;
    if (!hh) return tr('att|{m} min', { m: mm });
    return mm ? tr('att|{h} h {m} min', { h: hh, m: mm }) : tr('att|{h} h', { h: hh });
  };
  const hours = (min) => (Math.round((Number(min) || 0) / 6) / 10).toFixed(1);
  // "4 min ago" that the page keeps current (data-ago)
  const ago = (iso, now = new Date().toISOString()) => {
    if (!iso) return '—';
    const s = Math.max(0, (Date.parse(now) - Date.parse(iso)) / 1000);
    const text = s < 60 ? tr('att|just now') : s < 3600 ? tr('att|{n} min ago', { n: Math.floor(s / 60) }) : s < 86400 ? tr('att|{h} h {m} min ago', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) }) : ui.dt(iso);
    return `<time class="att-ago" datetime="${esc(iso)}" data-ago>${esc(text)}</time>`;
  };
  // the activity light: green under 15 min, amber up to an hour, red after, grey when not at work
  const light = (iso, { atWork = true, now = new Date().toISOString() } = {}) => {
    if (!atWork) return 'grey';
    if (!iso) return 'red';
    const m = (Date.parse(now) - Date.parse(iso)) / 60000;
    return m < 15 ? 'green' : m < 60 ? 'amber' : 'red';
  };

  // ---------- the radar ----------
  // center: { lat, lng }; radius: the circle (m); points: [{ lat, lng, tone, label, sub, href, size, kind }]
  // The view shows a little more than the circle; anything further sits on the edge with an arrow.
  function radar({ center, radius, points = [], size = 420, cls = '', title = '', rings = null, trail = false }) {
    const view = radius * 1.45;
    const c = size / 2;
    const k = (c - 18) / view;
    const ringsAt = rings || [25, 50, 100, 200, 400, 800].filter((r) => r < view * 0.98 && r !== radius);
    const xy = (p) => {
      const o = E.offset(center, p);
      const d = Math.hypot(o.x, o.y);
      const out = d > view;
      const f = out ? view / d : 1;
      return { x: c + o.x * f * k, y: c - o.y * f * k, out, d };
    };
    // a scale bar of a round length
    const scaleM = [10, 20, 25, 50, 100, 200, 250, 500].reduce((best, m) => (Math.abs(m * k - size * 0.18) < Math.abs(best * k - size * 0.18) ? m : best), 50);
    const ring = (r, main) => `<circle cx="${c}" cy="${c}" r="${(r * k).toFixed(1)}" class="${main ? 'att-radar__fence' : 'att-radar__ring'}"/>${main ? '' : `<text x="${c + 4}" y="${(c - r * k + 12).toFixed(1)}" class="att-radar__rl">${esc(tr('att|{m} m', { m: r }))}</text>`}`;
    const placed = points.map((p, i) => ({ ...p, ...xy(p), i }));
    const path = trail && placed.length > 1 ? `<polyline class="att-radar__trail" points="${placed.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}"/>` : '';
    const dot = (p) => {
      const r = p.size || 7;
      const body = p.out
        ? `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${(Math.atan2(p.y - c, p.x - c) * 180 / Math.PI).toFixed(1)})"><path d="M-7 -6 L7 0 L-7 6 Z" class="att-dot att-dot--${esc(p.tone || 'sea')}"/></g>`
        : `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" class="att-dot att-dot--${esc(p.tone || 'sea')}${p.pulse ? ' att-dot--pulse' : ''}"/>${p.initials ? `<text x="${p.x.toFixed(1)}" y="${(p.y + 3.5).toFixed(1)}" class="att-dot__t">${esc(p.initials)}</text>` : ''}`;
      const tip = `<title>${esc([p.label, p.sub, p.out ? tr('att|{m} m away', { m: Math.round(p.d) }) : ''].filter(Boolean).join(' · '))}</title>`;
      return p.href ? `<a href="${esc(p.href)}" class="att-radar__pt">${body}${tip}</a>` : `<g class="att-radar__pt">${body}${tip}</g>`;
    };
    return `<figure class="att-radar ${cls}"><svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(title || tr('att|Positions around the mall'))}">
      <defs><radialGradient id="attRg" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="currentColor" stop-opacity=".10"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></radialGradient></defs>
      <circle cx="${c}" cy="${c}" r="${(view * k).toFixed(1)}" class="att-radar__bg"/>
      <circle cx="${c}" cy="${c}" r="${(radius * k).toFixed(1)}" fill="url(#attRg)" class="att-radar__glow"/>
      <line x1="${c}" y1="${c - view * k}" x2="${c}" y2="${c + view * k}" class="att-radar__axis"/><line x1="${c - view * k}" y1="${c}" x2="${c + view * k}" y2="${c}" class="att-radar__axis"/>
      ${ringsAt.map((r) => ring(r, false)).join('')}${ring(radius, true)}
      <g class="att-radar__sweep"><path d="M${c} ${c} L${c} ${(c - view * k).toFixed(1)} A${(view * k).toFixed(1)} ${(view * k).toFixed(1)} 0 0 1 ${(c + view * k * Math.sin(Math.PI / 7)).toFixed(1)} ${(c - view * k * Math.cos(Math.PI / 7)).toFixed(1)} Z"/></g>
      <g class="att-radar__compass"><text x="${c}" y="13" class="att-radar__n">${esc(tr('att|N'))}</text><path d="M${c} 16 l-5 9 h10 z"/></g>
      <g class="att-radar__mall"><rect x="${c - 9}" y="${c - 9}" width="18" height="18" rx="5"/><circle cx="${c}" cy="${c}" r="3"/></g>
      ${path}${placed.map(dot).join('')}
      <g class="att-radar__scale" transform="translate(${size - 14 - scaleM * k} ${size - 16})"><line x1="0" y1="0" x2="${(scaleM * k).toFixed(1)}" y2="0"/><line x1="0" y1="-4" x2="0" y2="4"/><line x1="${(scaleM * k).toFixed(1)}" y1="-4" x2="${(scaleM * k).toFixed(1)}" y2="4"/><text x="${(scaleM * k / 2).toFixed(1)}" y="-6">${esc(tr('att|{m} m', { m: scaleM }))}</text></g>
    </svg>${title ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`;
  }

  // ---------- the day's timeline ----------
  // rows: [{ label, items: [{ from, to, tone, title, href }] (spans) or dots: [{ at, tone, title, href }] }]
  function timeline({ from, to, rows, now = null, marks = [] }) {
    const a = Date.parse(from);
    const b = Date.parse(to);
    const span = Math.max(60000, b - a);
    const pct = (t) => Math.max(0, Math.min(100, ((Date.parse(t) - a) / span) * 100));
    const startHour = Math.ceil(a / 3600000) * 3600000;
    const step = span > 14 * 3600000 ? 3 : span > 7 * 3600000 ? 2 : 1;
    const ticks = [];
    for (let t = startHour; t <= b; t += 3600000) {
      const lab = E.cairo(t).hm;
      if (Number(lab.slice(0, 2)) % step === 0) ticks.push(`<span class="att-tl__tick" style="--x:${pct(new Date(t).toISOString()).toFixed(2)}%"><i>${esc(lab)}</i></span>`);
    }
    const nowMark = now && Date.parse(now) >= a && Date.parse(now) <= b ? `<span class="att-tl__now" style="--f:${(pct(now) / 100).toFixed(4)}"><i>${esc(tr('att|now'))}</i></span>` : '';
    const markHtml = marks.map((m) => `<span class="att-tl__mark att-tl__mark--${esc(m.tone || 'mute')}" style="--f:${(pct(m.at) / 100).toFixed(4)}" title="${esc(m.title || '')}"></span>`).join('');
    const row = (r) => {
      const spans = (r.items || []).map((x) => {
        const l = pct(x.from);
        const w = Math.max(0.35, pct(x.to || now || x.from) - l);
        const tag = x.href ? 'a' : 'span';
        return `<${tag}${x.href ? ` href="${esc(x.href)}"` : ''} class="att-tl__span att-tl__span--${esc(x.tone || 'sea')}${x.open ? ' is-open' : ''}" style="--l:${l.toFixed(2)}%;--w:${w.toFixed(2)}%" title="${esc(x.title || '')}" data-tip="${esc(x.title || '')}"></${tag}>`;
      }).join('');
      const dots = (r.dots || []).map((x) => {
        const tag = x.href ? 'a' : 'span';
        return `<${tag}${x.href ? ` href="${esc(x.href)}"` : ''} class="att-tl__dot att-tl__dot--${esc(x.tone || 'sea')}" style="--x:${pct(x.at).toFixed(2)}%" title="${esc(x.title || '')}" data-tip="${esc(x.title || '')}"></${tag}>`;
      }).join('');
      return `<div class="att-tl__row"><span class="att-tl__label">${esc(r.label)}</span><div class="att-tl__track">${spans}${dots}</div></div>`;
    };
    return `<div class="att-tl" dir="ltr"><div class="att-tl__rows">${rows.map(row).join('')}</div><div class="att-tl__axis">${ticks.join('')}</div>${nowMark}${markHtml}</div>`;
  }

  // weekday initials from Monday: the usual one-letter Arabic forms (ن ث ر خ ج س ح)
  const shortDays = () => (i18n.isAr() ? ['ن', 'ث', 'ر', 'خ', 'ج', 'س', 'ح'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  // ---------- the month ----------
  // days: { 'YYYY-MM-DD': { status, worked, late, href } }
  const TONE = { done: 'ok', working: 'ok', on_break: 'ok', late: 'amber', absent: 'rose', not_in: 'rose', leave: 'sand', holiday: 'sand', off: 'mute', upcoming: 'mute', incomplete: 'amber' };
  function month(key, days, { today = null } = {}) {
    const first = `${key}-01`;
    const startDow = E.isoDay(first); // 1 Monday
    const n = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
    const cells = [];
    for (let i = 1; i < startDow; i++) cells.push('<span class="att-cal__d is-blank"></span>');
    for (let d = 1; d <= n; d++) {
      const date = `${key}-${String(d).padStart(2, '0')}`;
      const x = days[date] || {};
      const st = x.late && ['done', 'working', 'on_break'].includes(x.status) ? 'late' : x.incomplete ? 'incomplete' : x.status || 'off';
      const inner = `<b>${d}</b>${x.worked ? `<small>${esc(hours(x.worked))}</small>` : x.status && !['off', 'upcoming'].includes(x.status) ? `<small>${esc(x.short || '')}</small>` : ''}`;
      const tag = x.href ? 'a' : 'span';
      cells.push(`<${tag}${x.href ? ` href="${esc(x.href)}"` : ''} class="att-cal__d att-cal__d--${TONE[st] || 'mute'}${date === today ? ' is-today' : ''}" title="${esc(x.title || '')}">${inner}</${tag}>`);
    }
    return `<div class="att-cal"><div class="att-cal__head">${shortDays().map((w) => `<span>${esc(w)}</span>`).join('')}</div><div class="att-cal__grid">${cells.join('')}</div></div>`;
  }

  return { hm, dur, hours, ago, light, radar, timeline, month, TONE, shortDays };
};
