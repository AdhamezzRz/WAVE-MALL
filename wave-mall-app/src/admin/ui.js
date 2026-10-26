'use strict';

// The leasing office interface: shell, formatting, components and SVG charts. Server-rendered;
// /admin/admin.js adds drag and drop, search and small conveniences.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LOGO = require('../logo-paths.json');
const { floorSvg } = require('../plan');
const M = require('./model');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const v = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, f))).digest('hex').slice(0, 8);
const ASSETS = { css: v('admin/admin.css'), js: v('admin/admin.js') };

const esc = (s) => (s === null || s === undefined ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
const attr = (o) => Object.entries(o).filter(([, x]) => x !== false && x !== null && x !== undefined).map(([k, x]) => (x === true ? k : `${k}="${esc(x)}"`)).join(' ');

// ---------- formatting ----------
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
let CUR = 'EGP';
const setCurrency = (c) => { CUR = c || 'EGP'; };
const n0 = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : fmt.format(n));
function money(n, { compact = false, cur = true } = {}) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  let s;
  if (compact && Math.abs(n) >= 1e6) s = `${fmt1.format(n / 1e6)}M`;
  else if (compact && Math.abs(n) >= 1e4) s = `${fmt1.format(n / 1e3)}K`;
  else s = fmt.format(n);
  return cur ? `${CUR} ${s}` : s;
}
const m2 = (n) => (n === null || n === undefined ? '—' : `${fmt.format(n)} m²`);
const pct = (x, d = 0) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function date(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
// Stored moments are UTC ISO strings ending in Z; the office reads them in Cairo time.
// Times typed into a form (no Z) are already local and shown as they are.
const CAIRO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function local(iso) {
  if (!iso || !/Z$|[+-]\d\d:\d\d$/.test(iso)) return iso;
  const p = Object.fromEntries(CAIRO.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function dt(iso) {
  if (!iso) return '—';
  iso = local(iso);
  const t = iso.length > 10 ? iso.slice(11, 16) : '';
  return t && t !== '00:00' ? `${date(iso)}, ${t}` : date(iso);
}
function rel(iso) {
  if (!iso) return '';
  const d = Math.round((Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso) - Date.now()) / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}
const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

// ---------- icons (24px line) ----------
const I = {
  dash: 'M4 13h6V4H4zM14 20h6V11h-6zM4 20h6v-4H4zM14 7h6V4h-6z',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  leads: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  pipe: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v5h-4z',
  offer: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  cal: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  unit: 'M3 21V9l9-6 9 6v12M9 21v-7h6v7',
  brand: 'M4 7h16l-1 13H5zM9 7a3 3 0 0 1 6 0',
  lease: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h3',
  bill: 'M4 5h16v14H4zM4 9h16M8 15h3',
  report: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  team: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
  mail: 'M3 6h18v12H3zM3 6l9 7 9-7',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  log: 'M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 7h16M4 12h16M4 17h16',
  out: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  print: 'M7 8V3h10v5M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  check: 'M5 12l5 5 9-10',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  dl: 'M12 4v12M7 11l5 5 5-5M5 20h14',
};
const icon = (k, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${I[k]}"/></svg>`;
const logo = (cls = '') => `<svg class="logo ${cls}" viewBox="0 0 490 225.2" aria-label="The Wave">${['T', 'H', 'E2', 'W', 'AV', 'E'].map((k) => `<path d="${LOGO[k]}"/>`).join('')}</svg>`;
const mark = (cls = '') => `<svg class="mark ${cls}" viewBox="163 97 207 128" aria-hidden="true"><path d="${LOGO.AV}"/></svg>`;

// ---------- shell ----------
const NAV = [
  ['Overview', [['/admin', 'Dashboard', 'dash']]],
  ['Sales', [['/admin/inbox', 'Inbox', 'inbox', 'inbox'], ['/admin/leads', 'Leads', 'leads'], ['/admin/pipeline', 'Pipeline', 'pipe'], ['/admin/offers', 'Offers', 'offer', 'approvals'], ['/admin/calendar', 'Calendar & tasks', 'cal', 'tasks']]],
  ['Property', [['/admin/units', 'Units & plan', 'unit'], ['/admin/brands', 'Brands', 'brand']]],
  ['Revenue', [['/admin/leases', 'Leases', 'lease'], ['/admin/billing', 'Billing', 'bill', 'overdue']]],
  ['Insight', [['/admin/reports', 'Reports', 'report']]],
  ['Office', [['/admin/team', 'Team & targets', 'team'], ['/admin/subscribers', 'Subscribers', 'mail'], ['/admin/settings', 'Settings', 'gear', null, 'admin'], ['/admin/audit', 'Activity log', 'log', null, 'manager']]],
];
const RANK = { viewer: 0, agent: 1, manager: 2, admin: 3 };

function layout({ title, crumbs = [], active = '', body, user, csrf, nonce, flash, actions = '', counts = {}, wide = false }) {
  const nav = NAV.map(([group, items]) => {
    const links = items
      .filter(([, , , , min]) => !min || RANK[user.role] >= RANK[min])
      .map(([href, label, ic, count]) => {
        const on = href === '/admin' ? active === '/admin' : active.startsWith(href);
        const c = count && counts[count] ? `<b class="nav__count">${counts[count]}</b>` : '';
        return `<a href="${href}" class="nav__a${on ? ' is-on' : ''}"${on ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${c}</a>`;
      })
      .join('');
    return links ? `<div class="nav__group"><p class="nav__label">${group}</p>${links}</div>` : '';
  }).join('');
  const crumb = crumbs.length ? `<p class="crumbs">${crumbs.map(([h, l]) => (h ? `<a href="${h}">${esc(l)}</a>` : `<span>${esc(l)}</span>`)).join('<i>/</i>')}</p>` : '';
  const toast = flash ? `<div class="toast toast--${esc(flash.type || 'ok')}" role="status" data-toast>${icon(flash.type === 'error' ? 'log' : 'check')}<span>${esc(flash.text)}</span></div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="csrf" content="${esc(csrf)}">
<title>${esc(title)} · The Wave Leasing</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ASSETS.css}">
</head>
<body class="adm">
<aside class="side" id="side" data-side>
  <a class="side__brand" href="/admin">${logo()}<span>Leasing office</span></a>
  <nav class="nav" aria-label="Leasing office">${nav}</nav>
  <div class="side__me">
    <span class="avatar">${esc(initials(user.name))}</span>
    <div><b>${esc(user.name)}</b><small>${esc(M.ROLES[user.role])}</small></div>
    <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" class="iconbtn" title="Sign out" aria-label="Sign out">${icon('out')}</button></form>
  </div>
</aside>
<div class="main">
  <header class="bar">
    <button type="button" class="iconbtn bar__menu" data-side-toggle aria-label="Menu">${icon('menu')}</button>
    <div class="bar__title">${crumb}<h1>${esc(title)}</h1></div>
    <button type="button" class="search" data-cmdk-open>${icon('search')}<span>Search leads, brands, units…</span><kbd>⌘K</kbd></button>
    <div class="bar__actions">${actions}</div>
  </header>
  ${toast}
  <main class="content${wide ? ' content--wide' : ''}" id="content">${body}</main>
</div>
<div class="cmdk" data-cmdk hidden>
  <div class="cmdk__box" role="dialog" aria-label="Search">
    <div class="cmdk__in">${icon('search')}<input type="search" placeholder="Search leads, brands, units, offers, leases…" autocomplete="off" data-cmdk-input></div>
    <div class="cmdk__list" data-cmdk-list></div>
  </div>
</div>
<script src="/admin/admin.js?v=${ASSETS.js}" defer></script>
</body>
</html>`;
}

// Sign-in, setup and print pages: no sidebar.
function bare({ title, body, cls = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · The Wave Leasing</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ASSETS.css}">
</head>
<body class="adm ${cls}">${body}<script src="/admin/admin.js?v=${ASSETS.js}" defer></script></body>
</html>`;
}

// ---------- components ----------
const TONE = {
  new: 'sea', contacted: 'sky', viewing: 'sand', proposal: 'amber', negotiation: 'cocoa', reserved: 'forest', won: 'ok', lost: 'rose',
  available: 'ok', hold: 'amber', reserved_u: 'cocoa', leased: 'forest', blocked: 'mute',
  draft: 'mute', pending: 'amber', approved: 'sky', sent: 'sea', accepted: 'ok', rejected: 'rose', expired: 'mute',
  active: 'ok', ended: 'mute', terminated: 'rose', open: 'sky', partial: 'amber', paid: 'ok', void: 'mute', overdue: 'rose',
  admin: 'forest', manager: 'cocoa', agent: 'sea', viewer: 'mute',
};
const badge = (key, label, tone) => `<span class="badge badge--${tone || TONE[key] || 'mute'}">${esc(label || key)}</span>`;
const stageBadge = (s) => badge(s, M.stage(s).label);
const unitBadge = (s) => badge(s === 'reserved' ? 'reserved_u' : s, M.UNIT_STATUS[s]);

function kpi({ label, value, sub = '', tone = '', href = '', bar = null }) {
  const b = bar !== null ? `<span class="kpi__bar"><i style="width:${Math.max(0, Math.min(100, bar * 100)).toFixed(1)}%"></i></span>` : '';
  const inner = `<p class="kpi__label">${esc(label)}</p><p class="kpi__value">${value}</p>${b}${sub ? `<p class="kpi__sub">${sub}</p>` : ''}`;
  return href ? `<a class="kpi ${tone}" href="${href}">${inner}</a>` : `<div class="kpi ${tone}">${inner}</div>`;
}
const trend = (now, before) => {
  if (!before) return now ? '<span class="up">new</span>' : '';
  const d = (now - before) / before;
  return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}%</span> vs previous 30 days`;
};

function card(title, body, { action = '', cls = '', sub = '' } = {}) {
  return `<section class="card ${cls}"><header class="card__head"><div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${action}</header><div class="card__body">${body}</div></section>`;
}

function table(cols, rows, { empty = 'Nothing here yet.', href = null, cls = '' } = {}) {
  if (!rows.length) return `<div class="empty">${mark()}<p>${empty}</p></div>`;
  const th = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const tr = rows
    .map((r) => {
      const link = href ? href(r) : null;
      return `<tr${link ? ` data-href="${esc(link)}" tabindex="0"` : ''}>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`;
    })
    .join('');
  return `<div class="tablewrap"><table class="table ${cls}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

function empty(text, action = '') {
  return `<div class="empty">${mark()}<p>${esc(text)}</p>${action}</div>`;
}

const btn = (label, { href, type = 'submit', cls = '', ic = '', attrs = {} } = {}) =>
  href ? `<a class="btn ${cls}" href="${href}" ${attr(attrs)}>${ic ? icon(ic) : ''}<span>${label}</span></a>` : `<button class="btn ${cls}" type="${type}" ${attr(attrs)}>${ic ? icon(ic) : ''}<span>${label}</span></button>`;

// ---------- forms ----------
const hidden = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
function form(action, csrf, inner, { cls = '', attrs = {} } = {}) {
  return `<form method="post" action="${action}" class="${cls}" ${attr(attrs)}>${hidden(csrf)}${inner}</form>`;
}
function input(name, label, value = '', { type = 'text', required = false, step, min, max, placeholder, hint, cls = '', attrs = {} } = {}) {
  return `<label class="f ${cls}"><span class="f__l">${esc(label)}${required ? ' <i>*</i>' : ''}</span><input ${attr({ type, name, value: value ?? '', required, step, min, max, placeholder, ...attrs })}>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}
function select(name, label, options, value = '', { required = false, cls = '', blank = null, attrs = {} } = {}) {
  const list = Array.isArray(options) ? options.map((o) => (Array.isArray(o) ? o : [o, o])) : Object.entries(options);
  const opts = (blank !== null ? `<option value="">${esc(blank)}</option>` : '') + list.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(value ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
  return `<label class="f ${cls}"><span class="f__l">${esc(label)}${required ? ' <i>*</i>' : ''}</span><select ${attr({ name, required, ...attrs })}>${opts}</select></label>`;
}
function textarea(name, label, value = '', { rows = 4, cls = '', placeholder } = {}) {
  return `<label class="f ${cls}"><span class="f__l">${esc(label)}</span><textarea ${attr({ name, rows, placeholder })}>${esc(value)}</textarea></label>`;
}

// ---------- charts (SVG) ----------
function bars(series, { key, label, h = 170, fmtv = n0, tone = 'forest', compare = null }) {
  const max = Math.max(1, ...series.map((x) => Math.max(x[key], compare ? x[compare] || 0 : 0)));
  const cols = series
    .map((x) => {
      const ghost = compare ? `<i class="bars__ghost" style="height:${((x[compare] || 0) / max) * 100}%"></i>` : '';
      return `<div class="bars__c"><b>${x[key] ? fmtv(x[key]) : ''}</b><div class="bars__t">${ghost}<i class="t-${tone}" style="height:${(x[key] / max) * 100}%"></i></div><span>${esc(x[label])}</span></div>`;
    })
    .join('');
  return `<div class="bars" style="--h:${h}px">${cols}</div>`;
}

function funnel(stages) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  return `<div class="funnel">${stages
    .map(
      (s) => `<a class="funnel__row" href="/admin/leads?stage=${s.id}"><span class="funnel__name">${esc(s.label)}</span><span class="funnel__track"><i class="t-${TONE[s.id]}" style="width:${Math.max(2, (s.count / max) * 100)}%"></i></span><b>${s.count}</b><em>${money(s.value, { compact: true })}</em></a>`,
    )
    .join('')}</div>`;
}

function donut(parts, { size = 150, label = '' } = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const R = 54;
  const C = 2 * Math.PI * R;
  let off = 0;
  const tones = ['forest', 'sea', 'cocoa', 'sand', 'amber', 'sky', 'rose', 'mute'];
  const rings = parts
    .map((p, i) => {
      const len = (p.value / total) * C;
      const s = `<circle r="${R}" cx="70" cy="70" class="ring t-${p.tone || tones[i % tones.length]}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}"/>`;
      off += len;
      return s;
    })
    .join('');
  const legend = parts.map((p, i) => `<li><i class="t-${p.tone || tones[i % tones.length]}"></i><span>${esc(p.label)}</span><b>${p.display ?? n0(p.value)}</b></li>`).join('');
  return `<div class="donut"><svg viewBox="0 0 140 140" width="${size}" height="${size}" role="img"><circle r="${R}" cx="70" cy="70" class="ring ring--bg"/><g transform="rotate(-90 70 70)">${rings}</g><text x="70" y="68" class="donut__v">${esc(label)}</text><text x="70" y="86" class="donut__s">total</text></svg><ul class="legend">${legend}</ul></div>`;
}

const meter = (x, tone = 'forest') => `<span class="meter"><i class="t-${tone}" style="width:${Math.max(0, Math.min(100, (x || 0) * 100)).toFixed(1)}%"></i></span>`;

// ---------- the plan, coloured by unit status ----------
function plan(units, level, { link = true } = {}) {
  const by = Object.fromEntries(units.map((u) => [u.code, u]));
  let svg = level === 'G' ? floorSvg('G', { id: 'adm-g' }) : floorSvg('B1', { id: 'adm-s' });
  svg = svg.replace(/class="plan__unit( plan__unit--street)?" data-unit="(\d+)"/g, (all, street, n) => {
    const code = `${street ? 'S' : 'G'}${String(n).padStart(2, '0')}`;
    const u = by[code];
    if (!u) return all;
    const tip = `${code} · ${M.UNIT_STATUS[u.status]} · ${n0(u.indoor_m2)} m² + ${n0(u.terrace_m2)} m² terrace`;
    return `class="plan__unit${street ? ' plan__unit--street' : ''} st-${u.status}" data-unit="${n}" data-code="${code}"${link ? ` data-href="/admin/units/${u.id}"` : ''} data-tip="${esc(tip)}"`;
  });
  return `<div class="plan-wrap" data-plan>${svg}<div class="plan-tip" data-plan-tip hidden></div></div>`;
}
const planLegend = () => `<ul class="legend legend--row">${Object.entries(M.UNIT_STATUS).map(([k, l]) => `<li><i class="st-${k}"></i><span>${l}</span></li>`).join('')}</ul>`;

module.exports = {
  esc, attr, n0, money, local, m2, pct, date, dt, rel, initials, icon, logo, mark, setCurrency,
  layout, bare, badge, stageBadge, unitBadge, kpi, trend, card, table, empty, btn, hidden, form, input, select, textarea,
  bars, funnel, donut, meter, plan, planLegend, TONE, RANK,
};
