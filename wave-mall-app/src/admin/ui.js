'use strict';

// The leasing office interface: shell, formatting, components and SVG charts. Server-rendered;
// /admin/admin.js adds drag and drop, search and small conveniences.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LOGO = require('../logo-paths.json');
const { floorSvg } = require('../plan');
const M = require('./model');
const { t, tn, tx, isAr, lang, dir } = require('./i18n');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const v = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, f))).digest('hex').slice(0, 8);
const ASSETS = { css: v('admin/admin.css'), js: v('admin/admin.js'), pwa: v('admin/app/pwa.js') };

const esc = (s) => (s === null || s === undefined ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
const attr = (o) => Object.entries(o).filter(([, x]) => x !== false && x !== null && x !== undefined).map(([k, x]) => (x === true ? k : `${k}="${esc(x)}"`)).join(' ');

// ---------- formatting ----------
// Both languages use Western digits (as Egyptian leasing documents do); Arabic gets Arabic words,
// month names, units and currency.
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const AR_COMPACT = new Intl.NumberFormat('ar-EG-u-nu-latn', { notation: 'compact', maximumFractionDigits: 1 });
let CUR = 'EGP';
const setCurrency = (c) => { CUR = c || 'EGP'; };
const AR_CUR = { EGP: 'ج.م', USD: 'دولار', EUR: 'يورو', SAR: 'ر.س', AED: 'د.إ' };
const curLabel = () => (isAr() ? AR_CUR[CUR] || CUR : CUR);
// In Arabic, dates and amounts start with a right-to-left mark so a Latin name just before them
// ("Salma Adel · 18 يونيو") cannot pull their digits into its left-to-right run.
const RLM = '\u200f';
const rtl = (x) => (isAr() && x !== '—' ? RLM + x : x);
const n0 = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : fmt.format(n));
function money(n, { compact = false, cur = true } = {}) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  let s;
  if (isAr()) {
    s = compact && Math.abs(n) >= 1e4 ? AR_COMPACT.format(n) : fmt.format(n);
    return rtl(cur ? `${s} ${curLabel()}` : s);
  }
  if (compact && Math.abs(n) >= 1e6) s = `${fmt1.format(n / 1e6)}M`;
  else if (compact && Math.abs(n) >= 1e4) s = `${fmt1.format(n / 1e3)}K`;
  else s = fmt.format(n);
  return cur ? `${CUR} ${s}` : s;
}
const m2 = (n) => (n === null || n === undefined ? '—' : rtl(`${fmt.format(n)} ${isAr() ? 'م²' : 'm²'}`));
const pct = (x, d = 0) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
// Month name for a 1-based month number, in the current language.
const monthName = (m, { short = true } = {}) => (isAr() ? AR_MONTHS[m - 1] : short ? MONTHS[m - 1] : new Date(Date.UTC(2000, m - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }));
// "October 2026" / "أكتوبر 2026" for a YYYY-MM key.
const monthYear = (key) => `${monthName(Number(key.slice(5, 7)), { short: false })} ${key.slice(0, 4)}`;
const AR_DAYS = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];
const EN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Weekday names starting Monday.
const weekdays = () => (isAr() ? AR_DAYS : EN_DAYS);
function date(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return rtl(`${d} ${monthName(m)} ${y}`);
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
  const hm = iso.length > 10 ? iso.slice(11, 16) : '';
  return hm && hm !== '00:00' ? `${date(iso)}${isAr() ? '، ' : ', '}${hm}` : date(iso);
}
const AR_REL = new Intl.RelativeTimeFormat('ar-EG-u-nu-latn', { numeric: 'auto' });
function rel(iso) {
  if (!iso) return '';
  const d = Math.round((Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso) - Date.now()) / 86400000);
  if (isAr()) return AR_REL.format(d, 'day');
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}
const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join(isAr() && /[\u0600-\u06ff]/.test(name) ? ' ' : '').toUpperCase();

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
  back: 'M19 12H5M11 6l-6 6 6 6',
  home: 'M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5',
  more: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  x: 'M6 6l12 12M18 6L6 18',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  folder: 'M3 6h6l2 2h10v11H3z',
  contract: 'M7 3h7l5 5v13H7zM14 3v5h5M10 17c1.5-2 2.5-2 3 0s1.5 2 3 0',
  tenant: 'M4 10h16v10H4zM3 10l2-6h14l2 6M9 20v-5h6v5',
  people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M17 14a6 6 0 0 1 4 6',
  leave: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M9 15l6 0',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H3zM3 7l12-4 2 4M17 13h2',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  chat: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  coins: 'M12 7c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3M4 4v5c0 1.7 3.6 3 8 3s8-1.3 8-3V4M4 9v5c0 1.7 3.6 3 8 3s8-1.3 8-3V9M4 14v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5',
  store: 'M4 9l1-5h14l1 5M4 9h16v11H4zM4 9c0 2 4 2 4 0 0 2 4 2 4 0 0 2 4 2 4 0 0 2 4 2 4 0M10 20v-5h4v5',
  gauge: 'M12 21a9 9 0 1 1 9-9M12 12l4-4M7 16h10',
  percent: 'M19 5L5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  hammer: 'M14 4l6 6-3 3-6-6zM11 7L3 15l3 3 8-8',
  flow: 'M3 12h4l3-7 4 14 3-7h4',
  plug: 'M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3',
};
// Icons that point somewhere are mirrored in Arabic (see .ic--dir in admin.css).
const DIRECTIONAL = new Set(['arrow', 'out', 'back']);
const icon = (k, cls = '') => `<svg class="ic${DIRECTIONAL.has(k) ? ' ic--dir' : ''} ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${I[k]}"/></svg>`;
const logo = (cls = '') => `<svg class="logo ${cls}" viewBox="0 0 490 225.2" aria-label="The Wave">${['T', 'H', 'E2', 'W', 'AV', 'E'].map((k) => `<path d="${LOGO[k]}"/>`).join('')}</svg>`;
const mark = (cls = '') => `<svg class="mark ${cls}" viewBox="163 97 207 128" aria-hidden="true"><path d="${LOGO.AV}"/></svg>`;

// ---------- shell ----------
const NAV = [
  ['Overview', [['/admin', 'Dashboard', 'dash']]],
  ['Sales', [['/admin/inbox', 'Inbox', 'inbox', 'inbox'], ['/admin/leads', 'Leads', 'leads'], ['/admin/pipeline', 'Pipeline', 'pipe'], ['/admin/offers', 'Offers', 'offer', 'approvals'], ['/admin/conversations', 'nav|Conversations', 'chat', 'conversations'], ['/admin/calendar', 'Calendar & tasks', 'cal', 'tasks']]],
  ['Property', [['/admin/units', 'Units & plan', 'unit'], ['/admin/brands', 'Brands', 'brand'], ['/admin/tenants', 'Tenant files', 'tenant'], ['/admin/fitout', 'nav|Fit-out', 'hammer', 'fitout'], ['/admin/specialty', 'nav|Short-term space', 'store', 'specialty']]],
  ['Revenue', [['/admin/leases', 'Leases', 'lease'], ['/admin/billing', 'Billing', 'bill', 'overdue'], ['/admin/turnover', 'nav|Turnover & sales', 'percent', 'turnover'], ['/admin/service-charge', 'nav|Service charge', 'report'], ['/admin/utilities', 'nav|Utilities', 'gauge']]],
  ['nav|Finance', [['/admin/accounting', 'nav|Accounting', 'coins', 'finance', 'finance']]],
  ['nav|Operations', [['/admin/maintenance', 'nav|Maintenance', 'wrench', 'maintenance'], ['/admin/footfall', 'nav|Footfall', 'flow'], ['/admin/website', 'nav|Website', 'globe']]],
  ['Records', [['/admin/documents', 'Documents', 'folder', 'docs'], ['/admin/contracts', 'Contracts', 'contract', 'renewals']]],
  ['People', [['/admin/hr', 'Employees', 'people', null, 'hr'], ['/admin/hr/leave', 'nav|Leave', 'leave', 'leave', 'hr'], ['/admin/hr/payroll', 'Payroll', 'wallet', null, 'hr']]],
  ['Insight', [['/admin/reports', 'Reports', 'report']]],
  ['Office', [['/admin/team', 'Team & targets', 'team'], ['/admin/subscribers', 'Subscribers', 'mail'], ['/admin/integrations', 'nav|Integrations', 'plug', null, 'admin'], ['/admin/settings', 'Settings', 'gear', null, 'admin'], ['/admin/audit', 'Activity log', 'log', null, 'manager']]],
];
const RANK = { viewer: 0, agent: 1, manager: 2, admin: 3 };

// The language switch: a small form in the top bar (signed in) or a link (sign-in pages).
const other = () => (isAr() ? 'en' : 'ar');
const otherLabel = () => (isAr() ? 'English' : 'العربية');
const langForm = (csrf, back = '') => `<form method="post" action="/admin/lang" class="langform"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="lang" value="${other()}"><input type="hidden" name="back" value="${esc(back)}"><button type="submit" class="langbtn" lang="${other()}" title="${esc(t('Switch language'))}">${icon('globe')}<span>${otherLabel()}</span></button></form>`;
const langLink = (path) => `<a class="langbtn" href="${esc(path)}${path.includes('?') ? '&' : '?'}lang=${other()}" lang="${other()}">${icon('globe')}<span>${otherLabel()}</span></a>`;
const brandName = () => t('The Wave Leasing');

// The installable app's head tags (manifest, theme colour, home-screen icon, service worker).
// scope: 'admin' (the leasing office) or 'portal' (the tenant portal). See routes/mobile.js.
function pwaHead(scope = 'admin') {
  const base = scope === 'portal' ? '/portal' : '/admin';
  return `<meta name="theme-color" content="#fbfaf6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1f2c28" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${esc(t(scope === 'portal' ? 'mob|The Wave · Tenants' : 'mob|The Wave'))}">
<link rel="manifest" href="${base}/manifest.webmanifest${isAr() ? '?lang=ar' : ''}">
<link rel="apple-touch-icon" href="/admin/app/apple-touch-icon.png">
<script src="/admin/app/pwa.js?v=${ASSETS.pwa}" data-sw="${base}/sw.js" data-scope="${base}/" defer></script>`;
}

function layout({ title, crumbs = [], active = '', body, user, csrf, nonce, flash, actions = '', counts = {}, wide = false, path = '' }) {
  const allowedTo = (min) => !min || (min === 'hr' ? user.role === 'admin' || !!user.hr : min === 'finance' ? user.role === 'admin' || !!user.finance : RANK[user.role] >= RANK[min]);
  // the most specific menu entry wins (/admin/hr/leave over /admin/hr)
  const best = NAV.flatMap(([, items]) => items.map(([href]) => href)).filter((href) => (href === '/admin' ? active === '/admin' : active === href || active.startsWith(`${href}/`) || active.startsWith(`${href}?`))).sort((a, b) => b.length - a.length)[0];
  // the menu this person may see: [group, [{ href, label, ic, on, count }]]
  const menu = NAV.map(([group, items]) => [group, items
    .filter(([, , , , min]) => allowedTo(min))
    .map(([href, label, ic, count]) => ({ href, label: t(label), ic, on: href === best, count: count && counts[count] ? counts[count] : 0 }))])
    .filter(([, items]) => items.length);
  const nav = menu.map(([group, items]) => `<div class="nav__group"><p class="nav__label">${esc(t(group))}</p>${items.map((a) => `<a href="${a.href}" class="nav__a${a.on ? ' is-on' : ''}"${a.on ? ' aria-current="page"' : ''}>${icon(a.ic)}<span>${esc(a.label)}</span>${a.count ? `<b class="nav__count">${a.count}</b>` : ''}</a>`).join('')}</div>`).join('');
  const crumb = crumbs.length ? `<p class="crumbs">${crumbs.map(([h, l]) => (h ? `<a href="${h}">${esc(l)}</a>` : `<span>${esc(l)}</span>`)).join('<i>/</i>')}</p>` : '';
  const toast = flash ? `<div class="toast toast--${esc(flash.type || 'ok')}" role="status" data-toast>${icon(flash.type === 'error' ? 'log' : 'check')}<span>${esc(flash.text)}</span></div>` : '';
  // phones: a back button to the nearest crumb, a bottom tab bar and a "More" sheet with the whole menu
  const parent = [...crumbs].reverse().find(([h]) => h);
  const back = parent ? `<a class="bar__back" href="${parent[0]}" aria-label="${esc(t('mob|Back'))}" title="${esc(parent[1])}">${icon('back')}</a>` : '';
  const tabOn = ['/admin', '/admin/pipeline', '/admin/calendar'].includes(best) ? best : 'more';
  const moreCount = menu.flatMap(([, items]) => items).filter((a) => !['/admin', '/admin/pipeline', '/admin/calendar'].includes(a.href)).reduce((s, a) => s + (a.count || 0), 0);
  const tab = (href, ic, label, extra = '', attrs = '') => `<a href="${href}" class="tabbar__a${tabOn === href || (href === '#more' && tabOn === 'more') ? ' is-on' : ''}"${tabOn === href ? ' aria-current="page"' : ''} ${attrs}>${icon(ic)}<span>${esc(label)}</span>${extra}</a>`;
  const tasks = counts.tasks ? `<b class="tabbar__count">${counts.tasks}</b>` : '';
  const tabbar = `<nav class="tabbar" aria-label="${esc(t('mob|App navigation'))}">
    ${tab('/admin', 'home', t('mob|Home'))}
    ${tab('/admin/pipeline', 'pipe', t('mob|Pipeline'))}
    ${tab('/admin/calendar', 'cal', t('mob|Calendar'), tasks)}
    ${tab('/admin/leads', 'search', t('Search'), '', 'data-cmdk-open data-tab-search')}
    ${tab('#more', 'more', t('mob|More'), moreCount ? `<b class="tabbar__count">${moreCount > 99 ? '99+' : moreCount}</b>` : '', 'data-more-open aria-controls="more"')}
  </nav>`;
  const more = `<div class="sheet more" id="more" data-more role="dialog" aria-modal="true" aria-label="${esc(t('Menu'))}">
  <a class="sheet__scrim" href="#close" data-more-close aria-label="${esc(t('mob|Close'))}"></a>
  <div class="sheet__panel" data-sheet-panel>
    <span class="sheet__grip" aria-hidden="true"></span>
    <header class="more__me">
      <a class="avatar" href="/admin/me">${esc(initials(user.name))}</a>
      <a class="more__who" href="/admin/me"><b>${esc(user.name)}</b><small>${esc(M.ROLES[user.role])} · ${esc(t('Your account'))}</small></a>
      <a class="iconbtn more__x" href="#close" data-more-close aria-label="${esc(t('mob|Close'))}">${icon('x')}</a>
    </header>
    <div class="more__nav">${menu.map(([group, items]) => `<section class="more__group"><p class="more__label">${esc(t(group))}</p><div class="more__grid">${items.map((a) => `<a href="${a.href}" class="more__a${a.on ? ' is-on' : ''}">${icon(a.ic)}<span>${esc(a.label)}</span>${a.count ? `<b class="nav__count">${a.count}</b>` : ''}</a>`).join('')}</div></section>`).join('')}</div>
    <footer class="more__foot">${langForm(csrf, path)}<form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" class="btn btn--ghost btn--block">${icon('out')}<span>${esc(t('Sign out'))}</span></button></form></footer>
  </div>
</div>`;
  return `<!doctype html>
<html lang="${lang()}" dir="${dir()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="csrf" content="${esc(csrf)}">
<title>${esc(title)} · ${esc(brandName())}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ASSETS.css}">
${pwaHead('admin')}
</head>
<body class="adm has-tabbar" data-lang="${lang()}">
<aside class="side" id="side" data-side>
  <a class="side__brand" href="/admin">${logo()}<span>${esc(t('Leasing office'))}</span></a>
  <nav class="nav" aria-label="${esc(t('Leasing office'))}">${nav}</nav>
  <div class="side__me">
    <a class="avatar" href="/admin/me" title="${esc(t('Your account'))}">${esc(initials(user.name))}</a>
    <div><b>${esc(user.name)}</b><small>${esc(M.ROLES[user.role])}</small></div>
    <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" class="iconbtn" title="${esc(t('Sign out'))}" aria-label="${esc(t('Sign out'))}">${icon('out')}</button></form>
  </div>
</aside>
<div class="main">
  <header class="bar">
    <button type="button" class="iconbtn bar__menu" data-side-toggle aria-label="${esc(t('Menu'))}">${icon('menu')}</button>
    ${back}
    <div class="bar__title">${crumb}<h1>${esc(title)}</h1></div>
    <button type="button" class="search" data-cmdk-open>${icon('search')}<span>${esc(t('Search leads, brands, units…'))}</span><kbd>⌘K</kbd></button>
    ${langForm(csrf, path)}
    <div class="bar__actions">${actions}</div>
  </header>
  ${toast}
  <main class="content${wide ? ' content--wide' : ''}" id="content">${body}</main>
</div>
${tabbar}
${more}
<div class="ptr" data-ptr aria-hidden="true">${icon('arrow')}</div>
<div class="cmdk" data-cmdk hidden>
  <div class="cmdk__box" role="dialog" aria-label="${esc(t('Search'))}">
    <div class="cmdk__in">${icon('search')}<input type="search" placeholder="${esc(t('Search leads, brands, units, offers, leases…'))}" autocomplete="off" data-cmdk-input><button type="button" class="cmdk__close" data-cmdk-close>${esc(t('Cancel'))}</button></div>
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
<html lang="${lang()}" dir="${dir()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · ${esc(brandName())}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ASSETS.css}">
${pwaHead('admin')}
</head>
<body class="adm ${cls}" data-lang="${lang()}">${body}<script src="/admin/admin.js?v=${ASSETS.js}" defer></script></body>
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
const badge = (key, label, tone) => `<span class="badge badge--${tone || TONE[key] || 'mute'}">${esc(label || t(key))}</span>`;
const stageBadge = (s) => badge(s, M.stage(s).label);
const unitBadge = (s) => badge(s === 'reserved' ? 'reserved_u' : s, M.UNIT_STATUS[s]);

function kpi({ label, value, sub = '', tone = '', href = '', bar = null }) {
  const b = bar !== null ? `<span class="kpi__bar"><i style="width:${Math.max(0, Math.min(100, bar * 100)).toFixed(1)}%"></i></span>` : '';
  const inner = `<p class="kpi__label">${esc(label)}</p><p class="kpi__value">${value}</p>${b}${sub ? `<p class="kpi__sub">${sub}</p>` : ''}`;
  return href ? `<a class="kpi ${tone}" href="${href}">${inner}</a>` : `<div class="kpi ${tone}">${inner}</div>`;
}
const trend = (now, before) => {
  if (!before) return now ? `<span class="up">${esc(t('trend|new'))}</span>` : '';
  const d = (now - before) / before;
  return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}%</span> ${esc(t('vs previous 30 days'))}`;
};

function card(title, body, { action = '', cls = '', sub = '' } = {}) {
  return `<section class="card ${cls}"><header class="card__head"><div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${action}</header><div class="card__body">${body}</div></section>`;
}

function table(cols, rows, { empty = null, href = null, cls = '' } = {}) {
  if (!rows.length) return `<div class="empty">${mark()}<p>${empty ?? esc(t('Nothing here yet.'))}</p></div>`;
  const th = cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const tr = rows
    .map((r) => {
      const link = href ? href(r) : null;
      // data-label: on phones each row becomes a card of "label: value" lines (admin.css, mobile app)
      return `<tr${link ? ` data-href="${esc(link)}" tabindex="0"` : ''}>${cols.map((c) => `<td${c.num ? ' class="num"' : ''} data-label="${esc(c.label)}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`;
    })
    .join('');
  return `<div class="tablewrap"><table class="table table--resp ${cls}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
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

// ---------- documents ----------
const KB = (n) => (n >= 1048576 ? `${fmt1.format(n / 1048576)} ${isAr() ? 'ميجابايت' : 'MB'}` : `${Math.max(1, Math.round(n / 1024))} ${isAr() ? 'كيلوبايت' : 'KB'}`);
// Expiry as a badge: expired, expiring within warnDays, or valid.
function expiry(iso, { warnDays = 30 } = {}) {
  if (!iso) return '';
  const days = Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86400000);
  if (days < 0) return badge('expired', t('Expired {date}', { date: date(iso) }), 'rose');
  if (days <= warnDays) return badge('soon', t('Expires {when}', { when: rel(iso) }), 'amber');
  return badge('valid', t('Valid until {date}', { date: date(iso) }), 'mute');
}
const fileIcon = (mime) => `<span class="docic docic--${/pdf/.test(mime) ? 'pdf' : /image/.test(mime) ? 'img' : /sheet/.test(mime) ? 'xls' : 'doc'}">${/pdf/.test(mime) ? 'PDF' : /image/.test(mime) ? 'IMG' : /sheet/.test(mime) ? 'XLS' : 'DOC'}</span>`;

// The documents card for any record: a checklist of what is required, the files on record,
// and an upload form (admin.js sends the file; see routes/files.js).
function docPanel({ docs, entity, entityId = null, csrf, canUpload = false, canDelete = false, canConfidential = false, title = null, required = [], warnDays = 30, sub = '', cls = '' }) {
  const kinds = M.DOC_GROUPS[entity] || ['other'];
  const have = new Set(docs.filter((d) => !d.expires_on || d.expires_on >= new Date().toISOString().slice(0, 10)).map((d) => d.kind));
  const check = required.length
    ? `<ul class="checklist">${required.map((k) => `<li class="${have.has(k) ? 'is-ok' : 'is-missing'}">${icon(have.has(k) ? 'check' : 'log')}<span>${esc(M.DOC_KINDS[k])}</span></li>`).join('')}</ul>`
    : '';
  const rows = docs.length
    ? `<ul class="doclist">${docs.map((d) => `<li>
        ${fileIcon(d.mime)}
        <div class="doclist__what"><a href="/admin/documents/${d.id}/file" target="_blank" rel="noopener"><b>${esc(tx(d.title))}</b></a>
          <small>${esc(M.DOC_KINDS[d.kind] || d.kind)} · ${KB(d.size)} · ${date(d.created_at)}${d.uploader ? ` · ${esc(d.uploader)}` : ''}${d.version > 1 ? ` · ${esc(t('version {n}', { n: d.version }))}` : ''}${d.confidential ? ` · ${icon('shield')}${esc(t('Confidential'))}` : ''}</small></div>
        <div class="doclist__end">${expiry(d.expires_on, { warnDays })}
          <a class="iconbtn" href="/admin/documents/${d.id}" title="${esc(t('Details'))}" aria-label="${esc(t('Details'))}">${icon('file')}</a>
          <a class="iconbtn" href="/admin/documents/${d.id}/file?download=1" title="${esc(t('Download'))}" aria-label="${esc(t('Download'))}">${icon('dl')}</a>
          ${canUpload ? `<button type="button" class="iconbtn" data-replace="${d.id}" title="${esc(t('Upload a new version'))}" aria-label="${esc(t('Upload a new version'))}">${icon('upload')}</button>` : ''}
          ${canDelete ? form(`/admin/documents/${d.id}/delete`, csrf, `<button class="iconbtn" title="${esc(t('Delete'))}" aria-label="${esc(t('Delete'))}" data-confirm="${esc(t('Delete {name}? This cannot be undone.', { name: tx(d.title) }))}">×</button>`) : ''}
        </div></li>`).join('')}</ul>`
    : `<p class="muted pad">${esc(t('No documents yet.'))}</p>`;
  const base = `/admin/documents/upload?entity=${encodeURIComponent(entity)}${entity === 'office' ? '' : `&entity_id=${encodeURIComponent(entityId)}`}`;
  const up = canUpload
    ? `<form class="upload" data-upload="${esc(base)}" novalidate>
        <div class="fields">
          ${select('kind', t('Type'), kinds.map((k) => [k, M.DOC_KINDS[k]]), kinds[0])}
          ${input('title', t('Title'), '', { placeholder: t('e.g. Commercial register 2026') })}
          ${input('issued_on', t('Issued'), '', { type: 'date' })}
          ${input('expires_on', t('Expires'), '', { type: 'date' })}
        </div>
        ${canConfidential && entity !== 'employee' ? `<label class="check"><input type="checkbox" name="confidential" value="1"> ${esc(t('Confidential: HR and administrators only'))}</label>` : ''}
        <label class="drop"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,application/pdf,image/*">${icon('upload')}<span data-drop-label>${esc(t('Drop a file here, or click to choose'))}</span><small>${esc(t('PDF, JPG, PNG, WebP, Word or Excel · up to 25 MB'))}</small><i class="drop__bar" hidden><b></b></i></label>
        <p class="upload__msg" data-upload-msg hidden></p>
      </form>`
    : '';
  const head = `${title ?? t('Documents')}`;
  return card(head, `${check}${rows}${up ? `<details class="upload-box"${docs.length ? '' : ' open'}><summary>${icon('plus')}<span>${esc(t('Add a document'))}</span></summary>${up}</details>` : ''}`, { sub, cls: `docs ${cls}` });
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
  return `<div class="donut"><svg viewBox="0 0 140 140" width="${size}" height="${size}" role="img"><circle r="${R}" cx="70" cy="70" class="ring ring--bg"/><g transform="rotate(-90 70 70)">${rings}</g><text x="70" y="68" class="donut__v">${esc(label)}</text><text x="70" y="86" class="donut__s">${esc(t('chart|total'))}</text></svg><ul class="legend">${legend}</ul></div>`;
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
    const tip = `${code} · ${M.UNIT_STATUS[u.status]} · ${t('plan|{a} + {b} terrace', { a: m2(u.indoor_m2), b: m2(u.terrace_m2) })}`;
    return `class="plan__unit${street ? ' plan__unit--street' : ''} st-${u.status}" data-unit="${n}" data-code="${code}"${link ? ` data-href="/admin/units/${u.id}"` : ''} data-tip="${esc(tip)}"`;
  });
  return `<div class="plan-wrap" data-plan>${svg}<div class="plan-tip" data-plan-tip hidden></div></div>`;
}
const planLegend = () => `<ul class="legend legend--row">${Object.entries(M.UNIT_STATUS).map(([k, l]) => `<li><i class="st-${k}"></i><span>${esc(l)}</span></li>`).join('')}</ul>`;

module.exports = {
  esc, attr, n0, money, local, m2, pct, date, dt, rel, initials, icon, logo, mark, setCurrency, pwaHead, ASSETS, docPanel, expiry, KB, fileIcon, curLabel, monthName, monthYear, weekdays, langLink, langForm, t, tn,
  layout, bare, badge, stageBadge, unitBadge, kpi, trend, card, table, empty, btn, hidden, form, input, select, textarea,
  bars, funnel, donut, meter, plan, planLegend, TONE, RANK,
};
