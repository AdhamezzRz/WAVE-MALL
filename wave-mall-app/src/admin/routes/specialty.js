'use strict';

// Short-term space (specialty leasing): kiosks, pop-up units, promotional and exhibition areas in
// the plaza, the event space, digital screens and billboard faces, car display and ATM spots.
// A register of spaces with rate cards, an availability calendar, bookings priced from the rate card
// (with approval for deep discounts), invoices through the billing service, and a printable
// booking summary in either language.

const { t: tr, tn, tx } = require('../i18n');
const i18n = require('../i18n');
const { tmap, registerDocs, uploadRoute, docLang, docSwitch, csvCell } = require('../ops-common');

const SCHEMA = `
  CREATE TABLE spaces (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'kiosk',
    level TEXT, location TEXT, size_m2 REAL, power INTEGER NOT NULL DEFAULT 0, water INTEGER NOT NULL DEFAULT 0,
    rate_day REAL, rate_week REAL, rate_month REAL, weekend_pct REAL NOT NULL DEFAULT 0, min_days INTEGER NOT NULL DEFAULT 1,
    deposit REAL NOT NULL DEFAULT 0, notes TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE space_bookings (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, customer TEXT, phone TEXT, email TEXT, purpose TEXT,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, days INTEGER NOT NULL, share_pct REAL NOT NULL DEFAULT 100,
    list_price REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, override_reason TEXT, deposit REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'enquiry', hold_until TEXT, needs_approval INTEGER NOT NULL DEFAULT 0,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, approved_at TEXT,
    invoice_id INTEGER, deposit_invoice_id INTEGER, cancel_reason TEXT, notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX space_bookings_dates ON space_bookings(space_id, start_date, end_date);
  CREATE TABLE space_peaks (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, pct REAL NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
`;

const TYPES = {
  kiosk: 'spc|Kiosk', popup: 'spc|Pop-up unit', promo: 'spc|Promotional area', event: 'spc|Event space',
  screen: 'spc|Digital screen', billboard: 'spc|Billboard face', car: 'spc|Car display', atm: 'spc|ATM spot',
};
// shared faces: several advertisers share the loop, each with a share of the time
const SHARED = new Set(['screen', 'billboard']);
const STATUS = {
  enquiry: 'spc|Enquiry', held: 'spc|On hold', confirmed: 'spc|Confirmed', live: 'spc|Live', completed: 'spc|Completed', cancelled: 'spc|Cancelled',
};
const TONE = { enquiry: 'sky', held: 'amber', confirmed: 'sea', live: 'ok', completed: 'mute', cancelled: 'rose' };
// statuses that take the space
const TAKES = ['held', 'confirmed', 'live'];

// ---------- dates and pricing (pure; exported for tests) ----------
const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(day(v));
function daysOf(start, end) {
  const out = [];
  for (let t = day(start); t <= day(end); t += 86400000) out.push(iso(t));
  return out;
}
// Friday and Saturday are the weekend in Egypt
const weekend = (d) => [5, 6].includes(new Date(day(d)).getUTCDay());

// The rate-card price of a booking. peaks: [{ start_date, end_date, pct }]
function quote(space, start, end, { peaks = [], share = 100 } = {}) {
  if (!isDate(start) || !isDate(end) || end < start) return { error: 'spc|Choose a start and an end date (the end on or after the start).' };
  const days = daysOf(start, end);
  const n = days.length;
  if (n > 366) return { error: 'spc|A booking can run for a year at most.' };
  if (n < (space.min_days || 1)) return { error: 'spc|This space is booked for at least {n} days.', params: { n: space.min_days } };
  const r = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const d = r(space.rate_day);
  const w = r(space.rate_week);
  const m = r(space.rate_month);
  let base;
  let rate;
  if (n >= 28 && m) { base = m / 30; rate = 'month'; } else if (n >= 7 && w) { base = w / 7; rate = 'week'; } else if (d) { base = d; rate = 'day'; } else if (w) { base = w / 7; rate = 'week'; } else if (m) { base = m / 30; rate = 'month'; } else return { error: 'spc|This space has no rates yet. Set its rate card first.' };
  let total = 0;
  let weekendDays = 0;
  let peakDays = 0;
  for (const x of days) {
    let f = 1;
    if (weekend(x) && space.weekend_pct) { f += space.weekend_pct / 100; weekendDays++; }
    const p = Math.max(0, ...peaks.filter((k) => k.start_date <= x && k.end_date >= x).map((k) => Number(k.pct) || 0));
    if (p) { f += p / 100; peakDays++; }
    total += base * f;
  }
  const shared = SHARED.has(space.type);
  const sh = shared ? Math.max(1, Math.min(100, Number(share) || 100)) : 100;
  total = Math.round((total * sh) / 100);
  return { days: n, base: Math.round(base * 100) / 100, rate, weekendDays, peakDays, share: sh, total };
}

// Days on which a booking would clash with others. Exclusive spaces: any overlap. Shared faces:
// the loop shares on a day may not pass 100%.
function clashes(db, space, start, end, share, excludeId, today) {
  const others = db.all(
    `SELECT * FROM space_bookings WHERE space_id = ? AND id != ? AND status IN ('held','confirmed','live')
     AND (status != 'held' OR hold_until IS NULL OR hold_until >= ?) AND start_date <= ? AND end_date >= ?`,
    space.id, excludeId || 0, today, end, start,
  );
  if (!others.length) return [];
  if (!SHARED.has(space.type)) return others;
  const bad = [];
  for (const d of daysOf(start, end)) {
    const used = others.filter((o) => o.start_date <= d && o.end_date >= d).reduce((s, o) => s + o.share_pct, 0);
    if (used + Number(share) > 100) { bad.push(...others.filter((o) => o.start_date <= d && o.end_date >= d)); break; }
  }
  return [...new Set(bad)];
}

module.exports = function specialty(router, h) {
  const { db, ui, M } = h;
  const R = h.R;
  db.ensure('specialty-1', SCHEMA);
  registerDocs(M, 'space', 'spc|Short-term space', { space_photo: 'spc|Photo', space_layout: 'spc|Layout or drawing', space_permit: 'spc|Permit' });
  const panel = uploadRoute(router, h, '/specialty/files', { space: 'spaces' });

  const today = () => M.today();
  const types = () => tmap(TYPES);
  const statuses = () => tmap(STATUS);
  const badge = (s) => ui.badge(s, tr(STATUS[s]), TONE[s]);
  const peaks = () => db.all('SELECT * FROM space_peaks ORDER BY start_date');
  const maxDiscount = () => Number(db.setting('max_discount_pct')) || 0;
  const holdDays = () => Number(db.setting('hold_days')) || 7;
  const who = (b) => b.brand_name || (b.customer ? tx(b.customer) : '—');
  const spaceOf = (id) => db.get('SELECT * FROM spaces WHERE id = ?', id);
  const bookingOf = (id) => db.get(
    `SELECT k.*, s.code space_code, s.name space_name, s.type space_type, s.level space_level, s.location space_location, s.size_m2 space_size,
     s.power, s.water, b.name brand_name, u.name author, a.name approver
     FROM space_bookings k JOIN spaces s ON s.id = k.space_id LEFT JOIN brands b ON b.id = k.brand_id
     LEFT JOIN users u ON u.id = k.created_by LEFT JOIN users a ON a.id = k.approved_by WHERE k.id = ?`, id);

  // housekeeping: holds that ran out, bookings that started or finished
  function sweep() {
    const t = today();
    for (const k of db.all("SELECT id, ref FROM space_bookings WHERE status = 'held' AND hold_until IS NOT NULL AND hold_until < ?", t)) {
      db.run("UPDATE space_bookings SET status = 'enquiry', hold_until = NULL, updated_at = ? WHERE id = ?", M.now(), k.id);
      db.audit(null, 'Space hold expired', 'space_booking', k.id, k.ref);
    }
    db.run("UPDATE space_bookings SET status = 'live', updated_at = ? WHERE status = 'confirmed' AND start_date <= ? AND end_date >= ?", M.now(), t, t);
    db.run("UPDATE space_bookings SET status = 'completed', updated_at = ? WHERE status IN ('confirmed','live') AND end_date < ?", M.now(), t);
  }
  h.count('specialty', (user) => {
    const approvals = h.auth.allowed(user, 'manager') ? db.value("SELECT COUNT(*) FROM space_bookings WHERE needs_approval = 1 AND approved_at IS NULL AND status NOT IN ('cancelled','completed')") : 0;
    return approvals + db.value("SELECT COUNT(*) FROM space_bookings WHERE status = 'enquiry'");
  });

  const tabs = (on) => `<nav class="tabs">${[['/admin/specialty', tr('spc|Overview')], ['/admin/specialty/bookings', tr('spc|Bookings')], ['/admin/specialty/spaces', tr('spc|Spaces and rates')]]
    .map(([href, l]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${ui.esc(l)}</a>`).join('')}</nav>`;

  // ---------- the availability calendar ----------
  function calendar(spaces, from, to, { compact = false, book = false } = {}) {
    const days = daysOf(from, to);
    const n = days.length;
    const t = today();
    const list = db.all(
      `SELECT k.*, b.name brand_name FROM space_bookings k LEFT JOIN brands b ON b.id = k.brand_id
       WHERE k.status != 'cancelled' AND k.start_date <= ? AND k.end_date >= ? ORDER BY k.start_date`, to, from,
    );
    const head = `<div class="spc-cal__row spc-cal__row--head"><span class="spc-cal__name"></span><div class="spc-cal__days" style="--n:${n}">${days.map((d) => `<span class="${weekend(d) ? 'is-we' : ''}${d === t ? ' is-today' : ''}"><b>${Number(d.slice(8))}</b>${compact ? '' : `<small>${ui.esc(ui.weekdays()[(new Date(day(d)).getUTCDay() + 6) % 7])}</small>`}</span>`).join('')}</div></div>`;
    const rows = spaces.map((s) => {
      const mine = list.filter((k) => k.space_id === s.id);
      // lanes so overlapping bookings (shared faces) sit one under the other
      const lanes = [];
      const placed = mine.map((k) => {
        let lane = lanes.findIndex((end) => end < k.start_date);
        if (lane < 0) { lane = lanes.length; lanes.push(k.end_date); } else lanes[lane] = k.end_date;
        return { k, lane };
      });
      const bars = placed.map(({ k, lane }) => {
        const a = Math.max(0, days.indexOf(k.start_date < from ? from : k.start_date));
        const b = days.indexOf(k.end_date > to ? to : k.end_date);
        const left = (a / n) * 100;
        const width = ((b - a + 1) / n) * 100;
        const label = `${who(k)}${SHARED.has(s.type) ? ` · ${Math.round(k.share_pct)}%` : ''}`;
        return `<a class="spc-bar spc-bar--${k.status}" href="/admin/specialty/bookings/${k.id}" style="inset-inline-start:${left.toFixed(3)}%;width:${width.toFixed(3)}%;top:${4 + lane * 26}px" title="${ui.esc(`${k.ref} · ${label} · ${ui.date(k.start_date)} – ${ui.date(k.end_date)} · ${tr(STATUS[k.status])}`)}">${ui.esc(label)}</a>`;
      }).join('');
      return `<div class="spc-cal__row"><a class="spc-cal__name" href="/admin/specialty/spaces/${s.id}"><b>${ui.esc(s.code)}</b><small>${ui.esc(tr(TYPES[s.type]))}</small></a><div class="spc-cal__track" style="--n:${n};height:${Math.max(1, lanes.length) * 26 + 8}px">${days.map((d, i) => `<span class="spc-cal__cell${weekend(d) ? ' is-we' : ''}${d === t ? ' is-today' : ''}" style="inset-inline-start:${((i / n) * 100).toFixed(3)}%;width:${(100 / n).toFixed(3)}%"${book ? ` data-book="/admin/specialty/bookings/new?space=${s.id}&amp;start=${d}" role="button" tabindex="-1" aria-label="${ui.esc(tr('spc|Book {code} from {date}', { code: s.code, date: ui.date(d) }))}"` : ''}></span>`).join('')}${bars}</div></div>`;
    }).join('');
    return `<div class="spc-cal${compact ? ' spc-cal--compact' : ''}">${head}${rows}</div>`;
  }

  const monthBounds = (key) => {
    const from = `${key}-01`;
    return { from, to: M.addDays(M.addMonths(from, 1), -1) };
  };
  // months the calendar may show: a year either side of today (keeps links finite)
  const monthOk = (key) => /^\d{4}-\d{2}$/.test(key || '') && key >= M.addMonths(`${today().slice(0, 7)}-01`, -12).slice(0, 7) && key <= M.addMonths(`${today().slice(0, 7)}-01`, 12).slice(0, 7);

  // ---------- overview ----------
  router.get('/specialty', (req, res) => {
    sweep();
    const t = today();
    const key = monthOk(req.query.month) ? req.query.month : t.slice(0, 7);
    const view = req.query.view === 'week' ? 'week' : 'month';
    const spaces = db.all('SELECT * FROM spaces WHERE active = 1 ORDER BY sort, code');
    let from;
    let to;
    if (view === 'week') {
      const start = isDate(req.query.week) && Math.abs(day(req.query.week) - day(t)) < 400 * 86400000 ? req.query.week : t;
      const dow = (new Date(day(start)).getUTCDay() + 6) % 7;
      from = M.addDays(start, -dow);
      to = M.addDays(from, 6);
    } else ({ from, to } = monthBounds(key));
    const { from: mFrom, to: mTo } = monthBounds(t.slice(0, 7));
    const mDays = daysOf(mFrom, mTo).length;
    const taken = db.all(`SELECT k.*, s.type FROM space_bookings k JOIN spaces s ON s.id = k.space_id WHERE k.status IN ('confirmed','live','completed') AND k.start_date <= ? AND k.end_date >= ?`, mTo, mFrom);
    let used = 0;
    for (const k of taken) {
      const a = k.start_date < mFrom ? mFrom : k.start_date;
      const b = k.end_date > mTo ? mTo : k.end_date;
      used += daysOf(a, b).length * (SHARED.has(k.type) ? k.share_pct / 100 : 1);
    }
    const occupancy = spaces.length ? used / (spaces.length * mDays) : 0;
    const revenue = (a, b) => db.value("SELECT COALESCE(SUM(total - vat), 0) FROM invoices WHERE kind = 'specialty' AND status != 'void' AND due_date >= ? AND due_date <= ?", a, b);
    const monthRev = revenue(mFrom, mTo);
    const ytd = revenue(`${t.slice(0, 4)}-01-01`, `${t.slice(0, 4)}-12-31`);
    const upcoming = db.all(`SELECT k.*, s.code space_code, b.name brand_name FROM space_bookings k JOIN spaces s ON s.id = k.space_id LEFT JOIN brands b ON b.id = k.brand_id
      WHERE k.status IN ('held','confirmed') AND k.start_date >= ? AND k.start_date <= ? ORDER BY k.start_date LIMIT 8`, t, M.addDays(t, 30));
    const pending = db.all(`SELECT k.*, s.code space_code, b.name brand_name FROM space_bookings k JOIN spaces s ON s.id = k.space_id LEFT JOIN brands b ON b.id = k.brand_id
      WHERE (k.status = 'enquiry' OR (k.needs_approval = 1 AND k.approved_at IS NULL AND k.status NOT IN ('cancelled','completed'))) ORDER BY k.created_at DESC LIMIT 6`);
    const kpis = [
      ui.kpi({ label: tr('spc|Occupancy this month'), value: ui.pct(occupancy), bar: occupancy, sub: tr('spc|of space-days across {n} spaces', { n: spaces.length }) }),
      ui.kpi({ label: tr('spc|Revenue this month'), value: ui.money(monthRev, { compact: true }), sub: tr('spc|{amount} this year', { amount: ui.money(ytd, { compact: true }) }) }),
      ui.kpi({ label: tr('spc|Starting in 30 days'), value: ui.n0(upcoming.length), href: '/admin/specialty/bookings?status=upcoming' }),
      ui.kpi({ label: tr('spc|Waiting on you'), value: ui.n0(pending.length), sub: tr('spc|enquiries and approvals'), href: '/admin/specialty/bookings?status=enquiry', tone: pending.length ? 'kpi--alert' : '' }),
    ].join('');

    // utilisation: each space over the next eight weeks
    const dow = (new Date(day(t)).getUTCDay() + 6) % 7;
    const w0 = M.addDays(t, -dow);
    const weeks = Array.from({ length: 8 }, (_, i) => M.addDays(w0, i * 7));
    const span = db.all(`SELECT k.*, s.type FROM space_bookings k JOIN spaces s ON s.id = k.space_id WHERE k.status IN ('held','confirmed','live','completed') AND k.start_date <= ? AND k.end_date >= ?`, M.addDays(w0, 55), w0);
    const heat = `<div class="spc-heat" style="--w:${weeks.length}"><span></span>${weeks.map((w) => `<span class="spc-heat__h">${ui.esc(ui.date(w).replace(/\s\d{4}$/, ''))}</span>`).join('')}${spaces.map((s) => `<a class="spc-heat__s" href="/admin/specialty/spaces/${s.id}">${ui.esc(s.code)}</a>${weeks.map((w) => {
      const wd = daysOf(w, M.addDays(w, 6));
      const f = wd.reduce((sum, d) => sum + Math.min(1, span.filter((k) => k.space_id === s.id && k.start_date <= d && k.end_date >= d).reduce((x, k) => x + (SHARED.has(s.type) ? k.share_pct / 100 : 1), 0)), 0) / 7;
      return `<span class="spc-heat__c" style="--f:${f.toFixed(2)}" title="${ui.esc(`${s.code} · ${ui.date(w)} · ${ui.pct(f)}`)}">${f ? ui.pct(f) : ''}</span>`;
    }).join('')}`).join('')}</div>`;

    const top = db.all(`SELECT COALESCE(b.name, k.customer) name, k.brand_id, SUM(k.price) amount, COUNT(*) n FROM space_bookings k LEFT JOIN brands b ON b.id = k.brand_id
      WHERE k.status IN ('confirmed','live','completed') AND substr(k.start_date, 1, 4) = ? GROUP BY COALESCE(CAST(k.brand_id AS TEXT), k.customer) ORDER BY amount DESC LIMIT 6`, t.slice(0, 4));
    const topList = top.length
      ? `<ul class="list spc-top">${top.map((c) => `<li><span class="what"><b>${ui.esc(c.name ? tx(c.name) : '—')}</b><small>${ui.esc(tn(c.n, 'spc|{n} booking', 'spc|{n} bookings'))}</small></span><b>${ui.money(c.amount, { compact: true })}</b></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('spc|No confirmed bookings this year yet.'))}</p>`;
    const listOf = (rows, empty) => (rows.length
      ? `<ul class="list">${rows.map((k) => `<li><a href="/admin/specialty/bookings/${k.id}"><span class="what"><b>${ui.esc(k.space_code)} · ${ui.esc(who(k))}</b><small>${ui.date(k.start_date)} – ${ui.date(k.end_date)} · ${ui.money(k.price, { compact: true })}</small></span>${k.needs_approval && !k.approved_at ? ui.badge('pending', tr('spc|Needs approval'), 'amber') : badge(k.status)}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(empty)}</p>`);

    const prev = M.addMonths(`${key}-01`, -1).slice(0, 7);
    const next = M.addMonths(`${key}-01`, 1).slice(0, 7);
    const wPrev = M.addDays(from, -7);
    const wNext = M.addDays(from, 7);
    // month and week steps are form buttons (GET), not links
    const step = (name, value, label, aria) => `<button class="btn btn--ghost btn--sm" name="${name}" value="${value}" aria-label="${ui.esc(aria)}">${label}</button>`;
    const nav = view === 'week'
      ? `<form method="get" action="/admin/specialty" class="row spc-nav"><input type="hidden" name="view" value="week">${step('week', wPrev, '‹', tr('spc|Previous week'))}<b>${ui.date(from)} – ${ui.date(to)}</b>${step('week', wNext, '›', tr('spc|Next week'))}<a class="btn btn--ghost btn--sm" href="/admin/specialty">${ui.esc(tr('spc|Month'))}</a></form>`
      : `<form method="get" action="/admin/specialty" class="row spc-nav">${monthOk(prev) ? step('month', prev, '‹', tr('spc|Previous month')) : ''}<b>${ui.esc(ui.monthYear(key))}</b>${monthOk(next) ? step('month', next, '›', tr('spc|Next month')) : ''}<a class="btn btn--ghost btn--sm" href="/admin/specialty?view=week">${ui.esc(tr('spc|Week'))}</a></form>`;
    const legend = `<ul class="legend legend--row">${Object.keys(STATUS).filter((s) => s !== 'cancelled').map((s) => `<li><i class="spc-dot spc-dot--${s}"></i><span>${ui.esc(tr(STATUS[s]))}</span></li>`).join('')}</ul>`;
    const cal = spaces.length
      ? `<div class="spc-cal-wrap">${calendar(spaces, from, to, { compact: view === 'month', book: h.can(req, 'agent') })}</div>${legend}<p class="muted small">${ui.esc(tr('spc|Click an empty day to book it. Friday and Saturday are shaded.'))}</p>`
      : ui.empty(tr('spc|Add your first space to start taking bookings.'), h.can(req, 'manager') ? ui.btn(tr('spc|Add a space'), { href: '/admin/specialty/spaces/new', cls: 'btn--primary btn--sm' }) : '');
    const body = `${tabs('/admin/specialty')}<div class="kpis kpis--4">${kpis}</div>
${ui.card(tr('spc|Availability'), cal, { action: nav, cls: 'spc-calcard' })}
<div class="grid grid--2">
  ${ui.card(tr('spc|Starting soon'), listOf(upcoming, tr('spc|Nothing starts in the next 30 days.')))}
  ${ui.card(tr('spc|Waiting on you'), listOf(pending, tr('spc|No enquiries or approvals waiting.')))}
</div>
<div class="grid grid--side">
  ${ui.card(tr('spc|Utilisation, next eight weeks'), `<div class="spc-heat-wrap">${heat}</div>`, { sub: ui.esc(tr('spc|Share of each week the space is held or booked')) })}
  ${ui.card(tr('spc|Top customers this year'), topList)}
</div>`;
    h.page(req, res, {
      title: tr('nav|Short-term space'), active: '/admin/specialty', wide: true, body,
      actions: h.can(req, 'agent') ? ui.btn(tr('spc|New booking'), { href: '/admin/specialty/bookings/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  // ---------- spaces and rates ----------
  router.get('/specialty/spaces', (req, res) => {
    const spaces = db.all(`SELECT s.*, (SELECT COUNT(*) FROM space_bookings k WHERE k.space_id = s.id AND k.status IN ('held','confirmed','live')) active_bookings
      FROM spaces s ORDER BY s.active DESC, s.sort, s.code`);
    const rate = (v) => (v ? ui.money(v, { cur: false }) : '—');
    const table = ui.table([
      { label: tr('spc|Space'), render: (s) => `<b>${ui.esc(s.code)} · ${ui.esc(tx(s.name))}</b><small class="sub">${ui.esc(tr(TYPES[s.type]))}${s.location ? ` · ${ui.esc(tx(s.location))}` : ''}${s.active ? '' : ` · ${ui.esc(tr('spc|Not in use'))}`}</small>` },
      { label: tr('spc|Size'), render: (s) => (s.size_m2 ? ui.m2(s.size_m2) : '—') },
      { label: tr('spc|Day'), num: true, render: (s) => rate(s.rate_day) },
      { label: tr('spc|Week'), num: true, render: (s) => rate(s.rate_week) },
      { label: tr('spc|Month'), num: true, render: (s) => rate(s.rate_month) },
      { label: tr('spc|Minimum'), render: (s) => ui.esc(tn(s.min_days, 'spc|{n} day', 'spc|{n} days')) },
      { label: tr('spc|Active bookings'), num: true, render: (s) => ui.n0(s.active_bookings) },
    ], spaces, { empty: ui.esc(tr('spc|No spaces yet.')), href: (s) => `/admin/specialty/spaces/${s.id}` });
    const pk = peaks();
    const mgr = h.can(req, 'manager');
    const peakList = `${pk.length ? `<ul class="list">${pk.map((p) => `<li><span class="what"><b>${ui.esc(tx(p.name))} · +${ui.n0(p.pct)}%</b><small>${ui.date(p.start_date)} – ${ui.date(p.end_date)}</small></span>${mgr ? ui.form(`/admin/specialty/peaks/${p.id}/delete`, req.session.csrf, `<button class="iconbtn" title="${ui.esc(tr('Remove'))}" aria-label="${ui.esc(tr('Remove'))}" data-confirm="${ui.esc(tr('spc|Remove this peak period?'))}">×</button>`) : ''}</li>`).join('')}</ul>` : `<p class="muted pad">${ui.esc(tr('spc|No peak periods yet.'))}</p>`}
      ${mgr ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${ui.esc(tr('spc|Add a peak period'))}</span></summary>${ui.form('/admin/specialty/peaks', req.session.csrf, `<div class="fields">${ui.input('name', tr('Name'), '', { required: true, placeholder: tr('spc|e.g. Ramadan nights') })}${ui.input('start_date', tr('spc|From'), '', { type: 'date', required: true })}${ui.input('end_date', tr('spc|To'), '', { type: 'date', required: true })}${ui.input('pct', tr('spc|Surcharge (%)'), 20, { type: 'number', min: 0, max: 300, step: 1, required: true })}</div>${ui.btn(tr('Add'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}`;
    const body = `${tabs('/admin/specialty/spaces')}<div class="grid grid--side">
  ${ui.card(tn(spaces.length, 'spc|{n} space', 'spc|{n} spaces'), table, { sub: ui.esc(tr('spc|Rates are per space, before VAT. A week or a month is cheaper per day than single days.')) })}
  ${ui.card(tr('spc|Peak periods'), peakList, { sub: ui.esc(tr('spc|Days inside a peak period cost more, on top of any weekend surcharge.')) })}
</div>`;
    h.page(req, res, {
      title: tr('spc|Spaces and rates'), crumbs: [['/admin/specialty', tr('nav|Short-term space')], [null, tr('spc|Spaces and rates')]], active: '/admin/specialty', wide: true, body,
      actions: mgr ? ui.btn(tr('spc|Add a space'), { href: '/admin/specialty/spaces/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  router.post('/specialty/peaks', R('manager'), (req, res) => {
    const name = h.str(req.body.name, 80);
    const a = req.body.start_date;
    const b = req.body.end_date;
    const pct = h.numv(req.body.pct);
    if (!name || !isDate(a) || !isDate(b) || b < a || pct === null || pct < 0 || pct > 300) return h.back(req, res, '/admin/specialty/spaces', 'error', tr('spc|Give the period a name, dates and a surcharge.'));
    const r = db.run('INSERT INTO space_peaks (name, start_date, end_date, pct, created_at) VALUES (?, ?, ?, ?, ?)', name, a, b, pct, M.now());
    h.log(req, 'Added a peak period', 'space_peak', Number(r.lastInsertRowid), `${name} · +${pct}%`);
    h.back(req, res, '/admin/specialty/spaces', 'ok', tr('Saved.'));
  });
  router.post('/specialty/peaks/:id/delete', R('manager'), (req, res) => {
    db.run('DELETE FROM space_peaks WHERE id = ?', h.int(req.params.id));
    h.log(req, 'Removed a peak period', 'space_peak', h.int(req.params.id));
    h.back(req, res, '/admin/specialty/spaces', 'ok', tr('spc|Peak period removed.'));
  });

  function spaceForm(req, s = {}) {
    const v = (k, d = '') => (s[k] !== undefined && s[k] !== null ? s[k] : d);
    return ui.form(s.id ? `/admin/specialty/spaces/${s.id}` : '/admin/specialty/spaces', req.session.csrf, `
      <fieldset><legend>${tr('spc|The space')}</legend><div class="fields">
        ${ui.input('code', tr('spc|Code'), v('code'), { required: true, placeholder: tr('spc|e.g. K-01') })}
        ${ui.input('name', tr('Name'), v('name'), { required: true, placeholder: tr('spc|e.g. Plaza kiosk by the fountain') })}
        ${ui.select('type', tr('Type'), types(), v('type', 'kiosk'))}
        ${ui.input('level', tr('Level'), v('level'), { placeholder: tr('spc|e.g. Plaza') })}
        ${ui.input('location', tr('spc|Where'), v('location'), { placeholder: tr('spc|e.g. North entrance, beside G03') })}
        ${ui.input('size_m2', tr('spc|Size (m²)'), v('size_m2'), { type: 'number', min: 0, step: '0.1' })}
      </div>
      <div class="row"><label class="check"><input type="checkbox" name="power" value="1"${v('power', 0) ? ' checked' : ''}> ${ui.esc(tr('spc|Power point'))}</label><label class="check"><input type="checkbox" name="water" value="1"${v('water', 0) ? ' checked' : ''}> ${ui.esc(tr('spc|Water point'))}</label>${s.id ? `<label class="check"><input type="checkbox" name="active" value="1"${v('active', 1) ? ' checked' : ''}> ${ui.esc(tr('spc|In use'))}</label>` : ''}</div></fieldset>
      <fieldset><legend>${tr('spc|Rate card')}</legend><div class="fields">
        ${ui.input('rate_day', tr('spc|Per day'), v('rate_day'), { type: 'number', min: 0, step: 1 })}
        ${ui.input('rate_week', tr('spc|Per week'), v('rate_week'), { type: 'number', min: 0, step: 1 })}
        ${ui.input('rate_month', tr('spc|Per month'), v('rate_month'), { type: 'number', min: 0, step: 1 })}
        ${ui.input('weekend_pct', tr('spc|Weekend surcharge (%)'), v('weekend_pct', 0), { type: 'number', min: 0, max: 300, step: 1, hint: tr('spc|Fridays and Saturdays') })}
        ${ui.input('min_days', tr('spc|Minimum days'), v('min_days', 1), { type: 'number', min: 1, max: 365, step: 1 })}
        ${ui.input('deposit', tr('spc|Refundable deposit'), v('deposit', 0), { type: 'number', min: 0, step: 1 })}
        ${ui.textarea('notes', tr('Notes'), v('notes'), { rows: 3, cls: 'span-all', placeholder: tr('spc|Opening hours, set-up rules, what is included') })}
      </div></fieldset>
      ${ui.btn(s.id ? tr('Save changes') : tr('spc|Add the space'), { cls: 'btn--primary' })}`, { cls: 'form stack' });
  }
  function readSpace(req) {
    const b = req.body;
    const n = (k) => { const x = h.numv(b[k]); return x === null || x < 0 ? null : x; };
    return {
      code: h.str(b.code, 20).toUpperCase(), name: h.str(b.name, 120), type: TYPES[b.type] ? b.type : 'kiosk', level: h.str(b.level, 40) || null,
      location: h.str(b.location, 160) || null, size_m2: n('size_m2'), power: b.power ? 1 : 0, water: b.water ? 1 : 0,
      rate_day: n('rate_day'), rate_week: n('rate_week'), rate_month: n('rate_month'), weekend_pct: n('weekend_pct') || 0,
      min_days: Math.max(1, Math.min(365, h.int(b.min_days) || 1)), deposit: n('deposit') || 0, notes: h.str(b.notes, 1000) || null,
    };
  }
  router.get('/specialty/spaces/new', R('manager'), (req, res) => {
    h.page(req, res, { title: tr('spc|Add a space'), crumbs: [['/admin/specialty', tr('nav|Short-term space')], ['/admin/specialty/spaces', tr('spc|Spaces and rates')], [null, tr('spc|New')]], active: '/admin/specialty', body: ui.card(tr('spc|Add a space'), spaceForm(req)) });
  });
  router.post('/specialty/spaces', R('manager'), (req, res) => {
    const s = readSpace(req);
    if (!s.code || !s.name) return h.back(req, res, '/admin/specialty/spaces/new', 'error', tr('spc|Give the space a code and a name.'));
    if (db.get('SELECT id FROM spaces WHERE code = ?', s.code)) return h.back(req, res, '/admin/specialty/spaces/new', 'error', tr('spc|{code} is already used.', { code: s.code }));
    const r = db.run(`INSERT INTO spaces (code, name, type, level, location, size_m2, power, water, rate_day, rate_week, rate_month, weekend_pct, min_days, deposit, notes, sort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, s.code, s.name, s.type, s.level, s.location, s.size_m2, s.power, s.water, s.rate_day, s.rate_week, s.rate_month, s.weekend_pct, s.min_days, s.deposit, s.notes,
    (db.value('SELECT MAX(sort) FROM spaces') || 0) + 1, M.now(), M.now());
    h.log(req, 'Added a space', 'space', Number(r.lastInsertRowid), s.code);
    h.back(req, res, `/admin/specialty/spaces/${r.lastInsertRowid}`, 'ok', tr('spc|{code} added.', { code: s.code }));
  });

  router.get('/specialty/spaces/:id', (req, res, next) => {
    sweep();
    const s = spaceOf(h.int(req.params.id));
    if (!s) return next();
    const t = today();
    const bookings = db.all(`SELECT k.*, b.name brand_name FROM space_bookings k LEFT JOIN brands b ON b.id = k.brand_id WHERE k.space_id = ? ORDER BY k.start_date DESC LIMIT 30`, s.id);
    const ytd = db.value("SELECT COALESCE(SUM(price), 0) FROM space_bookings WHERE space_id = ? AND status IN ('confirmed','live','completed') AND substr(start_date, 1, 4) = ?", s.id, t.slice(0, 4));
    const from = t;
    const to = M.addDays(t, 41);
    const ex = [7, 30].map((n) => ({ n, q: quote(s, t, M.addDays(t, n - 1), { peaks: peaks() }) }));
    const facts = `<dl class="dl">
      <div><dt>${tr('Type')}</dt><dd>${ui.esc(tr(TYPES[s.type]))}</dd></div>
      <div><dt>${tr('spc|Where')}</dt><dd>${ui.esc([s.level, s.location].filter(Boolean).map((x) => tx(x)).join(' · ') || '—')}</dd></div>
      <div><dt>${tr('spc|Size')}</dt><dd>${s.size_m2 ? ui.m2(s.size_m2) : '—'}</dd></div>
      <div><dt>${tr('spc|Services')}</dt><dd>${ui.esc([s.power ? tr('spc|Power point') : null, s.water ? tr('spc|Water point') : null].filter(Boolean).join(' · ') || '—')}</dd></div>
      <div><dt>${tr('spc|Rate card')}</dt><dd>${ui.esc([s.rate_day ? tr('spc|{amount} a day', { amount: ui.money(s.rate_day) }) : null, s.rate_week ? tr('spc|{amount} a week', { amount: ui.money(s.rate_week) }) : null, s.rate_month ? tr('spc|{amount} a month', { amount: ui.money(s.rate_month) }) : null].filter(Boolean).join(' · ') || tr('spc|Not set'))}</dd></div>
      <div><dt>${tr('spc|Weekend surcharge')}</dt><dd>${s.weekend_pct ? `+${ui.n0(s.weekend_pct)}%` : '—'}</dd></div>
      <div><dt>${tr('spc|Minimum')}</dt><dd>${ui.esc(tn(s.min_days, 'spc|{n} day', 'spc|{n} days'))}</dd></div>
      <div><dt>${tr('spc|Refundable deposit')}</dt><dd>${s.deposit ? ui.money(s.deposit) : '—'}</dd></div>
      ${ex.map(({ n, q }) => `<div><dt>${ui.esc(tr('spc|{n} days from today', { n }))}</dt><dd>${q.error ? '—' : `${ui.money(q.total)}${SHARED.has(s.type) ? ` <small class="muted">${ui.esc(tr('spc|for the whole loop'))}</small>` : ''}`}</dd></div>`).join('')}
      ${s.notes ? `<div><dt>${tr('Notes')}</dt><dd>${ui.esc(tx(s.notes))}</dd></div>` : ''}
    </dl>`;
    const list = bookings.length
      ? `<ul class="list">${bookings.map((k) => `<li><a href="/admin/specialty/bookings/${k.id}"><span class="what"><b>${ui.esc(who(k))}</b><small>${ui.esc(k.ref)} · ${ui.date(k.start_date)} – ${ui.date(k.end_date)}${SHARED.has(s.type) ? ` · ${Math.round(k.share_pct)}%` : ''} · ${ui.money(k.price, { compact: true })}</small></span>${badge(k.status)}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('spc|No bookings yet.'))}</p>`;
    const kpis = [
      ui.kpi({ label: tr('spc|Booked this year'), value: ui.money(ytd, { compact: true }) }),
      ui.kpi({ label: tr('spc|Bookings'), value: ui.n0(bookings.length) }),
      ui.kpi({ label: tr('spc|Day rate'), value: s.rate_day ? ui.money(s.rate_day, { compact: true }) : '—' }),
    ].join('');
    const body = `<div class="kpis kpis--3">${kpis}</div>
${ui.card(tr('spc|The next six weeks'), `<div class="spc-cal-wrap">${calendar([s], from, to, { compact: true, book: h.can(req, 'agent') && !!s.active })}</div>`)}
<div class="grid grid--side">
  <div class="stack">${ui.card(tr('spc|Bookings'), list)}${panel(req, 'space', s.id, { title: tr('spc|Photos and drawings') })}</div>
  <div class="stack">${ui.card(tr('spc|Details'), facts)}${h.can(req, 'manager') ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${ui.esc(tr('spc|Edit the space and its rates'))}</span></summary>${spaceForm(req, s)}</details>` : ''}</div>
</div>`;
    h.page(req, res, {
      title: `${s.code} · ${tx(s.name)}`, crumbs: [['/admin/specialty', tr('nav|Short-term space')], ['/admin/specialty/spaces', tr('spc|Spaces and rates')], [null, s.code]], active: '/admin/specialty', body,
      actions: h.can(req, 'agent') && s.active ? ui.btn(tr('spc|Book this space'), { href: `/admin/specialty/bookings/new?space=${s.id}`, cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });
  router.post('/specialty/spaces/:id', R('manager'), (req, res, next) => {
    const old = spaceOf(h.int(req.params.id));
    if (!old) return next();
    const s = readSpace(req);
    if (!s.code || !s.name) return h.back(req, res, `/admin/specialty/spaces/${old.id}`, 'error', tr('spc|Give the space a code and a name.'));
    if (db.get('SELECT id FROM spaces WHERE code = ? AND id != ?', s.code, old.id)) return h.back(req, res, `/admin/specialty/spaces/${old.id}`, 'error', tr('spc|{code} is already used.', { code: s.code }));
    db.run(`UPDATE spaces SET code = ?, name = ?, type = ?, level = ?, location = ?, size_m2 = ?, power = ?, water = ?, rate_day = ?, rate_week = ?, rate_month = ?, weekend_pct = ?, min_days = ?, deposit = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?`,
      s.code, s.name, s.type, s.level, s.location, s.size_m2, s.power, s.water, s.rate_day, s.rate_week, s.rate_month, s.weekend_pct, s.min_days, s.deposit, s.notes, req.body.active ? 1 : 0, M.now(), old.id);
    h.log(req, 'Edited a space', 'space', old.id, s.code);
    h.back(req, res, `/admin/specialty/spaces/${old.id}`, 'ok', tr('Saved.'));
  });

  // ---------- bookings ----------
  router.get('/specialty/bookings', (req, res) => {
    sweep();
    const t = today();
    const st = ['enquiry', 'held', 'confirmed', 'live', 'completed', 'cancelled', 'upcoming', 'approval'].includes(req.query.status) ? req.query.status : 'open';
    const where = {
      open: "k.status IN ('enquiry','held','confirmed','live')",
      upcoming: `k.status IN ('held','confirmed') AND k.start_date >= '${t}'`,
      approval: "k.needs_approval = 1 AND k.approved_at IS NULL AND k.status NOT IN ('cancelled','completed')",
    }[st] || `k.status = '${st}'`;
    const rows = db.all(`SELECT k.*, s.code space_code, s.type space_type, b.name brand_name, i.status invoice_status FROM space_bookings k JOIN spaces s ON s.id = k.space_id
      LEFT JOIN brands b ON b.id = k.brand_id LEFT JOIN invoices i ON i.id = k.invoice_id WHERE ${where} ORDER BY k.start_date ${st === 'completed' || st === 'cancelled' ? 'DESC' : ''} LIMIT 200`);
    const tabsHtml = [['open', tr('spc|Open')], ['upcoming', tr('spc|Upcoming')], ['enquiry', tr(STATUS.enquiry)], ['held', tr(STATUS.held)], ['approval', tr('spc|Needs approval')], ['live', tr(STATUS.live)], ['completed', tr(STATUS.completed)], ['cancelled', tr(STATUS.cancelled)]]
      .map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/specialty/bookings${k === 'open' ? '' : `?status=${k}`}">${ui.esc(l)}</a>`).join('');
    const table = ui.table([
      { label: tr('spc|Booking'), render: (k) => `<b>${ui.esc(who(k))}</b><small class="sub">${ui.esc(k.ref)}${k.purpose ? ` · ${ui.esc(tx(k.purpose))}` : ''}</small>` },
      { label: tr('spc|Space'), render: (k) => `${ui.esc(k.space_code)}${SHARED.has(k.space_type) ? `<small class="sub">${ui.esc(tr('spc|{pct}% of the loop', { pct: Math.round(k.share_pct) }))}</small>` : ''}` },
      { label: tr('spc|Dates'), render: (k) => `${ui.date(k.start_date)} – ${ui.date(k.end_date)}<small class="sub">${ui.esc(tn(k.days, 'spc|{n} day', 'spc|{n} days'))}</small>` },
      { label: tr('spc|Price'), num: true, render: (k) => `${ui.money(k.price, { cur: false })}${k.price < k.list_price ? `<small class="sub">${ui.esc(tr('spc|list {amount}', { amount: ui.money(k.list_price, { cur: false }) }))}</small>` : ''}` },
      { label: tr('Status'), render: (k) => `${badge(k.status)}${k.needs_approval && !k.approved_at && !['cancelled', 'completed'].includes(k.status) ? ` ${ui.badge('pending', tr('spc|Needs approval'), 'amber')}` : ''}${k.invoice_status ? `<small class="sub">${ui.esc(tr('spc|Invoice {status}', { status: M.INVOICE_STATUS[k.invoice_status] || k.invoice_status }))}</small>` : ''}` },
    ], rows, { empty: ui.esc(tr('spc|No bookings here.')), href: (k) => `/admin/specialty/bookings/${k.id}` });
    h.page(req, res, {
      title: tr('spc|Bookings'), crumbs: [['/admin/specialty', tr('nav|Short-term space')], [null, tr('spc|Bookings')]], active: '/admin/specialty', wide: true,
      body: `${tabs('/admin/specialty/bookings')}<nav class="tabs">${tabsHtml}</nav>${ui.card(tn(rows.length, 'spc|{n} booking', 'spc|{n} bookings'), table, { action: ui.btn(tr('Export CSV'), { href: '/admin/specialty/bookings.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`,
      actions: h.can(req, 'agent') ? ui.btn(tr('spc|New booking'), { href: '/admin/specialty/bookings/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  router.get('/specialty/bookings.csv', (req, res) => {
    const rows = db.all(`SELECT k.*, s.code space_code, b.name brand_name FROM space_bookings k JOIN spaces s ON s.id = k.space_id LEFT JOIN brands b ON b.id = k.brand_id ORDER BY k.start_date`);
    const cols = [['ref', tr('Ref')], ['space_code', tr('spc|Space')], [(k) => who(k), tr('spc|Customer')], ['start_date', tr('spc|From')], ['end_date', tr('spc|To')], ['days', tr('spc|Days')], ['share_pct', tr('spc|Share of loop (%)')], ['list_price', tr('spc|List price')], ['price', tr('spc|Price')], ['deposit', tr('spc|Deposit')], [(k) => tr(STATUS[k.status]), tr('Status')]];
    const csv = [cols.map((c) => csvCell(c[1])).join(','), ...rows.map((k) => cols.map(([f]) => csvCell(typeof f === 'function' ? f(k) : k[f])).join(','))].join('\r\n');
    h.log(req, 'Exported', 'export', null, 'Short-term bookings');
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="short-term-bookings-${today()}.csv"`).send(`﻿${csv}`);
  });

  function bookingForm(req, k = {}, { prefill = {} } = {}) {
    const spaces = db.all('SELECT * FROM spaces WHERE active = 1 OR id = ? ORDER BY sort, code', k.space_id || 0);
    const brands = db.all('SELECT id, name FROM brands ORDER BY name');
    const v = (key, d = '') => (k[key] !== undefined && k[key] !== null ? k[key] : prefill[key] !== undefined ? prefill[key] : d);
    const t = today();
    const start = v('start_date', t);
    const s0 = spaces.find((s) => String(s.id) === String(v('space_id'))) || spaces[0];
    const end = v('end_date', s0 ? M.addDays(start, Math.max(1, s0.min_days) - 1) : start);
    const spaceOpts = spaces.map((s) => `<option value="${s.id}" data-shared="${SHARED.has(s.type) ? 1 : 0}" data-deposit="${s.deposit || 0}"${String(s.id) === String(v('space_id', s0 ? s0.id : '')) ? ' selected' : ''}>${ui.esc(`${s.code} · ${tx(s.name)} · ${tr(TYPES[s.type])}`)}</option>`).join('');
    return ui.form(k.id ? `/admin/specialty/bookings/${k.id}` : '/admin/specialty/bookings', req.session.csrf, `
      <div class="grid grid--side spc-form" data-spc-quote="/admin/specialty/quote"${k.id ? ` data-exclude="${k.id}"` : ''}>
        <div class="stack">
          <fieldset><legend>${tr('spc|Space and dates')}</legend><div class="fields">
            <label class="f span-all"><span class="f__l">${ui.esc(tr('spc|Space'))} <i>*</i></span><select name="space_id" required data-spc="space">${spaceOpts}</select></label>
            ${ui.input('start_date', tr('spc|From'), start, { type: 'date', required: true, attrs: { 'data-spc': 'start' } })}
            ${ui.input('end_date', tr('spc|To'), end, { type: 'date', required: true, attrs: { 'data-spc': 'end' } })}
            ${ui.input('share_pct', tr('spc|Share of the loop (%)'), v('share_pct', 100), { type: 'number', min: 1, max: 100, step: 1, cls: 'spc-share', hint: tr('spc|Screens and billboard faces only: the advertiser\'s share of each loop'), attrs: { 'data-spc': 'share' } })}
          </div></fieldset>
          <fieldset><legend>${tr('spc|Customer')}</legend><div class="fields">
            ${ui.select('brand_id', tr('Brand'), brands.map((b) => [b.id, b.name]), v('brand_id'), { blank: tr('spc|Not a brand on file (fill in below)') })}
            ${ui.input('customer', tr('spc|Customer name'), v('customer'), { placeholder: tr('spc|Company or person') })}
            ${ui.input('phone', tr('Phone'), v('phone'), { type: 'tel' })}
            ${ui.input('email', tr('Email'), v('email'), { type: 'email' })}
            ${ui.input('purpose', tr('spc|What for'), v('purpose'), { cls: 'span-all', placeholder: tr('spc|e.g. Perfume launch pop-up, car display, Ramadan campaign') })}
          </div></fieldset>
          <fieldset><legend>${tr('spc|Price and terms')}</legend><div class="fields">
            ${ui.input('price', tr('spc|Agreed price'), k.id && k.price !== k.list_price ? k.price : '', { type: 'number', min: 0, step: 1, hint: tr('spc|Leave empty to use the rate card'), attrs: { 'data-spc': 'price' } })}
            ${ui.input('override_reason', tr('spc|Why a different price'), v('override_reason'), { placeholder: tr('spc|Needed when the price is not the rate card') })}
            ${ui.input('deposit', tr('spc|Refundable deposit'), v('deposit', s0 ? s0.deposit : 0), { type: 'number', min: 0, step: 1, attrs: { 'data-spc': 'deposit' } })}
            ${k.id ? '' : ui.select('status', tr('spc|Save as'), { enquiry: tr(STATUS.enquiry), held: tr('spc|On hold for {n} days', { n: holdDays() }) }, v('status', 'held'))}
            ${ui.textarea('notes', tr('Notes'), v('notes'), { rows: 3, cls: 'span-all', placeholder: tr('spc|Set-up and removal times, power needs, branding, anything agreed') })}
          </div></fieldset>
        </div>
        <aside class="calc card">
          <header class="card__head"><div><h2>${ui.esc(tr('spc|The price'))}</h2><p>${ui.esc(tr('spc|From the rate card, as you type'))}</p></div></header>
          <div class="card__body">
            <dl class="calc__dl">
              <div><dt>${ui.esc(tr('spc|Days'))}</dt><dd data-q="days">—</dd></div>
              <div><dt>${ui.esc(tr('spc|Rate used'))}</dt><dd data-q="rate">—</dd></div>
              <div><dt>${ui.esc(tr('spc|Weekend days'))}</dt><dd data-q="weekend">—</dd></div>
              <div><dt>${ui.esc(tr('spc|Peak days'))}</dt><dd data-q="peak">—</dd></div>
              <div class="calc__big"><dt>${ui.esc(tr('spc|Rate card price'))}</dt><dd data-q="total">—</dd></div>
              <div><dt>${ui.esc(tr('spc|Against the rate card'))}</dt><dd data-q="disc">—</dd></div>
            </dl>
            <p class="alert alert--warn" data-q="clash" hidden></p>
            <p class="alert alert--warn" data-q="error" hidden></p>
            <p class="alert alert--warn" data-q="approval" hidden>${ui.esc(h.can(req, 'manager') ? tr('spc|Below the allowed discount. As a manager, you can confirm it yourself.') : tr('spc|Below the allowed discount: a manager will approve it before it is confirmed.'))}</p>
            ${ui.btn(k.id ? tr('Save changes') : tr('spc|Save the booking'), { cls: 'btn--primary btn--block' })}
          </div>
        </aside>
      </div>`, { cls: 'form' });
  }

  // live quote for the booking form (JSON)
  router.post('/specialty/quote', (req, res) => {
    const s = spaceOf(h.int(req.body.space_id));
    if (!s) return res.json({ ok: false, error: tr('That record no longer exists.') });
    const q = quote(s, req.body.start_date, req.body.end_date, { peaks: peaks(), share: req.body.share_pct });
    if (q.error) return res.json({ ok: false, error: tr(q.error, q.params) });
    const c = clashes(db, s, req.body.start_date, req.body.end_date, q.share, h.int(req.body.exclude), today());
    const price = h.numv(req.body.price);
    const disc = price !== null && q.total ? (price / q.total - 1) * 100 : null;
    res.json({
      ok: true, days: tn(q.days, 'spc|{n} day', 'spc|{n} days'), rate: tr({ day: 'spc|Day rate', week: 'spc|Weekly rate', month: 'spc|Monthly rate' }[q.rate]),
      weekend: q.weekendDays ? String(q.weekendDays) : '—', peak: q.peakDays ? String(q.peakDays) : '—', total: ui.money(q.total), totalValue: q.total,
      disc: disc === null ? '—' : `${disc > 0 ? '+' : ''}${disc.toFixed(1)}%`, approval: disc !== null && disc < -maxDiscount(),
      clash: c.length ? tr('spc|Clashes with {refs}. Choose other dates or a smaller share.', { refs: c.map((o) => o.ref).join(', ') }) : '',
      shared: SHARED.has(s.type),
    });
  });

  // read and check a booking from the form; returns { error } or { values }
  function readBooking(req, existing = null) {
    const b = req.body;
    const s = spaceOf(h.int(b.space_id));
    if (!s) return { error: tr('spc|Choose a space.') };
    const q = quote(s, b.start_date, b.end_date, { peaks: peaks(), share: b.share_pct });
    if (q.error) return { error: tr(q.error, q.params) };
    const brand = h.int(b.brand_id) ? db.get('SELECT id, name FROM brands WHERE id = ?', h.int(b.brand_id)) : null;
    const customer = h.str(b.customer, 120);
    if (!brand && !customer) return { error: tr('spc|Choose a brand or write the customer\'s name.') };
    const email = h.str(b.email, 160);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: tr('spc|That email does not look right.') };
    const priceIn = h.numv(b.price);
    const price = priceIn === null ? q.total : Math.round(priceIn);
    if (price < 0) return { error: tr('spc|The price cannot be negative.') };
    const reason = h.str(b.override_reason, 300);
    if (price !== q.total && !reason) return { error: tr('spc|Say why the price differs from the rate card.') };
    const discount = q.total ? (price / q.total - 1) * 100 : 0;
    const needs = discount < -maxDiscount() && !h.can(req, 'manager') ? 1 : 0;
    const status = existing ? existing.status : (b.status === 'enquiry' ? 'enquiry' : 'held');
    if (TAKES.includes(status)) {
      const c = clashes(db, s, b.start_date, b.end_date, q.share, existing ? existing.id : 0, today());
      if (c.length) return { error: tr('spc|Clashes with {refs}. Choose other dates or a smaller share.', { refs: c.map((o) => o.ref).join(', ') }) };
    }
    return {
      s, q,
      values: {
        space_id: s.id, brand_id: brand ? brand.id : null, customer: brand ? null : customer, phone: h.str(b.phone, 40) || null, email: email || null,
        purpose: h.str(b.purpose, 200) || null, start_date: b.start_date, end_date: b.end_date, days: q.days, share_pct: q.share,
        list_price: q.total, price, override_reason: price !== q.total ? reason : null, deposit: b.deposit === undefined || b.deposit === '' ? (s.deposit || 0) : Math.max(0, h.numv(b.deposit) || 0), status,
        needs_approval: needs, notes: h.str(b.notes, 1000) || null,
      },
    };
  }

  router.get('/specialty/bookings/new', R('agent'), (req, res) => {
    const prefill = {};
    if (h.int(req.query.space)) prefill.space_id = h.int(req.query.space);
    if (isDate(req.query.start)) prefill.start_date = req.query.start;
    if (!db.value('SELECT COUNT(*) FROM spaces WHERE active = 1')) return h.back(req, res, '/admin/specialty/spaces', 'error', tr('spc|Add a space first.'));
    h.page(req, res, { title: tr('spc|New booking'), crumbs: [['/admin/specialty', tr('nav|Short-term space')], ['/admin/specialty/bookings', tr('spc|Bookings')], [null, tr('spc|New')]], active: '/admin/specialty', wide: true, body: bookingForm(req, {}, { prefill }) });
  });

  router.post('/specialty/bookings', R('agent'), (req, res) => {
    const r = readBooking(req);
    if (r.error) return h.back(req, res, h.safeBack(req, '/admin/specialty/bookings/new'), 'error', r.error);
    const v = r.values;
    const id = Number(db.run(
      `INSERT INTO space_bookings (ref, space_id, brand_id, customer, phone, email, purpose, start_date, end_date, days, share_pct, list_price, price, override_reason, deposit, status, hold_until, needs_approval, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      db.nextRef('space_bookings', 'SB', 4, true), v.space_id, v.brand_id, v.customer, v.phone, v.email, v.purpose, v.start_date, v.end_date, v.days, v.share_pct, v.list_price, v.price, v.override_reason, v.deposit,
      v.status, v.status === 'held' ? M.addDays(today(), holdDays()) : null, v.needs_approval, v.notes, req.user.id, M.now(), M.now(),
    ).lastInsertRowid);
    const k = bookingOf(id);
    h.log(req, 'Booked a space', 'space_booking', id, `${k.ref} · ${k.space_code}`);
    h.back(req, res, `/admin/specialty/bookings/${id}`, 'ok', v.needs_approval ? tr('spc|Booking saved. It is below the allowed discount, so a manager will approve it.') : tr('spc|Booking saved.'));
  });

  router.get('/specialty/bookings/:id', (req, res, next) => {
    sweep();
    const k = bookingOf(h.int(req.params.id));
    if (!k) return next();
    const t = today();
    const csrf = req.session.csrf;
    const act = (path, label, cls = 'btn--ghost', confirm, extra = '') => ui.form(`/admin/specialty/bookings/${k.id}/${path}`, csrf, `${extra}${ui.btn(label, { cls, attrs: confirm ? { 'data-confirm': confirm } : {} })}`);
    const waiting = k.needs_approval && !k.approved_at;
    const acts = [];
    if (h.can(req, 'agent')) {
      if (waiting && h.can(req, 'manager') && !['cancelled', 'completed'].includes(k.status)) acts.push(act('approve', tr('spc|Approve the price'), 'btn--primary'));
      if (k.status === 'enquiry') acts.push(act('hold', tr('spc|Hold the space')));
      if (['enquiry', 'held'].includes(k.status) && !waiting) acts.push(act('confirm', tr('spc|Confirm and invoice'), 'btn--primary', tr('spc|Confirm the booking? The invoice is created now.')));
      if (['enquiry', 'held', 'confirmed', 'live'].includes(k.status)) acts.push(`<details class="pop"><summary class="btn btn--ghost">${ui.esc(tr('spc|Cancel'))}</summary>${ui.form(`/admin/specialty/bookings/${k.id}/cancel`, csrf, `${ui.input('reason', tr('spc|Reason'), '', { required: true, placeholder: tr('spc|e.g. The customer withdrew') })}<p class="muted small">${ui.esc(tr('spc|Unpaid invoices for this booking are voided.'))}</p>${ui.btn(tr('spc|Cancel the booking'), { cls: 'btn--danger btn--sm' })}`, { cls: 'stack' })}</details>`);
    }
    const inv = k.invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', k.invoice_id) : null;
    const dep = k.deposit_invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', k.deposit_invoice_id) : null;
    const invLine = (i, label) => (i ? `<div><dt>${ui.esc(label)}</dt><dd><a href="/admin/invoices/${i.id}">${ui.esc(i.ref)}</a> · ${ui.money(i.total)} · ${ui.badge(i.status, M.INVOICE_STATUS[i.status])}</dd></div>` : '');
    const facts = `<dl class="dl">
      <div><dt>${tr('spc|Customer')}</dt><dd>${k.brand_id ? `<a href="/admin/brands/${k.brand_id}">${ui.esc(k.brand_name)}</a>` : ui.esc(k.customer ? tx(k.customer) : '—')}${k.phone ? `<br><a href="tel:${ui.esc(k.phone)}">${ui.esc(k.phone)}</a>` : ''}${k.email ? `<br><a href="mailto:${ui.esc(k.email)}">${ui.esc(k.email)}</a>` : ''}</dd></div>
      <div><dt>${tr('spc|Space')}</dt><dd><a href="/admin/specialty/spaces/${k.space_id}">${ui.esc(k.space_code)} · ${ui.esc(tx(k.space_name))}</a><small class="sub">${ui.esc(tr(TYPES[k.space_type]))}</small></dd></div>
      <div><dt>${tr('spc|Dates')}</dt><dd>${ui.date(k.start_date)} – ${ui.date(k.end_date)} · ${ui.esc(tn(k.days, 'spc|{n} day', 'spc|{n} days'))}</dd></div>
      ${SHARED.has(k.space_type) ? `<div><dt>${tr('spc|Share of the loop')}</dt><dd>${Math.round(k.share_pct)}%</dd></div>` : ''}
      ${k.purpose ? `<div><dt>${tr('spc|What for')}</dt><dd>${ui.esc(tx(k.purpose))}</dd></div>` : ''}
      <div><dt>${tr('spc|Rate card price')}</dt><dd>${ui.money(k.list_price)}</dd></div>
      <div><dt>${tr('spc|Agreed price')}</dt><dd><b>${ui.money(k.price)}</b>${k.override_reason ? `<small class="sub">${ui.esc(tx(k.override_reason))}</small>` : ''}</dd></div>
      <div><dt>${tr('spc|Refundable deposit')}</dt><dd>${k.deposit ? ui.money(k.deposit) : '—'}</dd></div>
      <div><dt>${tr('Status')}</dt><dd>${badge(k.status)}${k.status === 'held' && k.hold_until ? ` <small class="muted">${ui.esc(tr('spc|until {date}', { date: ui.date(k.hold_until) }))}</small>` : ''}${waiting ? ` ${ui.badge('pending', tr('spc|Needs approval'), 'amber')}` : ''}${k.approved_at ? `<small class="sub">${ui.esc(tr('spc|Price approved by {name}, {date}', { name: k.approver || '—', date: ui.date(k.approved_at) }))}</small>` : ''}</dd></div>
      ${invLine(inv, tr('Invoice'))}${invLine(dep, tr('spc|Deposit invoice'))}
      ${k.cancel_reason ? `<div><dt>${tr('spc|Cancelled because')}</dt><dd>${ui.esc(tx(k.cancel_reason))}</dd></div>` : ''}
      ${k.notes ? `<div><dt>${tr('Notes')}</dt><dd>${ui.esc(tx(k.notes))}</dd></div>` : ''}
      <div><dt>${tr('spc|Booked by')}</dt><dd>${ui.esc(k.author || '—')} · ${ui.date(k.created_at)}</dd></div>
    </dl>`;
    const editable = ['enquiry', 'held'].includes(k.status) && h.can(req, 'agent');
    const body = `${acts.length ? `<div class="row spc-acts">${acts.join('')}</div>` : ''}
<div class="grid grid--side">
  ${ui.card(tr('spc|Booking'), facts)}
  <div class="stack">${ui.card(tr('spc|Where'), `<div class="spc-cal-wrap">${calendar([{ id: k.space_id, code: k.space_code, type: k.space_type }], M.addDays(k.start_date, -3), M.addDays(k.end_date < M.addDays(k.start_date, 40) ? k.end_date : M.addDays(k.start_date, 40), 3), { compact: true })}</div>`)}</div>
</div>
${editable ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${ui.esc(tr('spc|Change dates, customer or price'))}</span></summary>${bookingForm(req, k)}</details>` : ''}`;
    void t;
    h.page(req, res, {
      title: `${k.ref} · ${who(k)}`, crumbs: [['/admin/specialty', tr('nav|Short-term space')], ['/admin/specialty/bookings', tr('spc|Bookings')], [null, k.ref]], active: '/admin/specialty', wide: true, body,
      actions: ui.btn(tr('Print'), { href: `/admin/specialty/bookings/${k.id}/print`, cls: 'btn--ghost', ic: 'print' }),
    });
  });

  router.post('/specialty/bookings/:id', R('agent'), (req, res, next) => {
    const k = bookingOf(h.int(req.params.id));
    if (!k) return next();
    const back = `/admin/specialty/bookings/${k.id}`;
    if (!['enquiry', 'held'].includes(k.status)) return h.back(req, res, back, 'error', tr('spc|Only an enquiry or a hold can be changed.'));
    const r = readBooking(req, k);
    if (r.error) return h.back(req, res, back, 'error', r.error);
    const v = r.values;
    db.run(`UPDATE space_bookings SET space_id = ?, brand_id = ?, customer = ?, phone = ?, email = ?, purpose = ?, start_date = ?, end_date = ?, days = ?, share_pct = ?, list_price = ?, price = ?,
      override_reason = ?, deposit = ?, needs_approval = ?, approved_by = NULL, approved_at = NULL, notes = ?, updated_at = ? WHERE id = ?`,
    v.space_id, v.brand_id, v.customer, v.phone, v.email, v.purpose, v.start_date, v.end_date, v.days, v.share_pct, v.list_price, v.price, v.override_reason, v.deposit, v.needs_approval, v.notes, M.now(), k.id);
    h.log(req, 'Changed a space booking', 'space_booking', k.id, k.ref);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  router.post('/specialty/bookings/:id/:action', R('agent'), (req, res, next) => {
    const k = bookingOf(h.int(req.params.id));
    if (!k) return next();
    const back = `/admin/specialty/bookings/${k.id}`;
    const fail = (text) => h.back(req, res, back, 'error', text);
    const space = spaceOf(k.space_id);
    const a = req.params.action;
    if (a === 'approve') {
      if (!h.can(req, 'manager')) return fail(tr('Your role does not allow that.'));
      if (!k.needs_approval || k.approved_at) return fail(tr('spc|This booking does not need approval.'));
      db.run('UPDATE space_bookings SET approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?', req.user.id, M.now(), M.now(), k.id);
      h.log(req, 'Approved a space booking price', 'space_booking', k.id, k.ref);
      return h.back(req, res, back, 'ok', tr('spc|Price approved.'));
    }
    if (a === 'hold') {
      if (k.status !== 'enquiry') return fail(tr('spc|Only an enquiry can be put on hold.'));
      const c = clashes(db, space, k.start_date, k.end_date, k.share_pct, k.id, today());
      if (c.length) return fail(tr('spc|Clashes with {refs}. Choose other dates or a smaller share.', { refs: c.map((o) => o.ref).join(', ') }));
      db.run("UPDATE space_bookings SET status = 'held', hold_until = ?, updated_at = ? WHERE id = ?", M.addDays(today(), holdDays()), M.now(), k.id);
      h.log(req, 'Held a space', 'space_booking', k.id, k.ref);
      return h.back(req, res, back, 'ok', tr('spc|On hold until {date}.', { date: ui.date(M.addDays(today(), holdDays())) }));
    }
    if (a === 'confirm') {
      if (!['enquiry', 'held'].includes(k.status)) return fail(tr('spc|Only an enquiry or a hold can be confirmed.'));
      if (k.needs_approval && !k.approved_at) return fail(tr('spc|A manager must approve the price first.'));
      const c = clashes(db, space, k.start_date, k.end_date, k.share_pct, k.id, today());
      if (c.length) return fail(tr('spc|Clashes with {refs}. Choose other dates or a smaller share.', { refs: c.map((o) => o.ref).join(', ') }));
      const t = today();
      try {
        db.tx(() => {
          const party = k.brand_id ? { brand_id: k.brand_id } : { customer: k.customer };
          const inv = k.price > 0 ? h.billing.createInvoice({
            ...party, kind: 'specialty', period_start: k.start_date, period_end: k.end_date, due_date: k.start_date > t ? k.start_date : t,
            other: k.price, note: `Short-term space ${k.space_code}, ${k.start_date} to ${k.end_date}`, source: 'space_booking', source_id: k.id, demo: k.demo,
          }, { user: req.user }) : null;
          const dep = k.deposit > 0 ? h.billing.createInvoice({
            ...party, kind: 'deposit', due_date: t, other: k.deposit, note: `Space deposit ${k.space_code}`, source: 'space_booking', source_id: k.id, demo: k.demo,
          }, { user: req.user }) : null;
          db.run('UPDATE space_bookings SET status = ?, hold_until = NULL, invoice_id = ?, deposit_invoice_id = ?, updated_at = ? WHERE id = ?',
            k.start_date <= t && k.end_date >= t ? 'live' : 'confirmed', inv ? inv.id : null, dep ? dep.id : null, M.now(), k.id);
        });
      } catch (err) {
        return fail(tr(err.message));
      }
      h.log(req, 'Confirmed a space booking', 'space_booking', k.id, `${k.ref} · ${k.price}`);
      return h.back(req, res, back, 'ok', tr('spc|Confirmed. The invoice is in Billing.'));
    }
    if (a === 'cancel') {
      if (!['enquiry', 'held', 'confirmed', 'live'].includes(k.status)) return fail(tr('spc|This booking cannot be cancelled.'));
      const reason = h.str(req.body.reason, 300);
      if (!reason) return fail(tr('spc|Give a reason for cancelling.'));
      for (const id of [k.invoice_id, k.deposit_invoice_id].filter(Boolean)) h.billing.voidInvoice(id, { user: req.user, note: `Cancelled booking ${k.ref}` });
      db.run("UPDATE space_bookings SET status = 'cancelled', hold_until = NULL, cancel_reason = ?, updated_at = ? WHERE id = ?", reason, M.now(), k.id);
      h.log(req, 'Cancelled a space booking', 'space_booking', k.id, k.ref);
      return h.back(req, res, back, 'ok', tr('spc|Booking cancelled.'));
    }
    return next();
  });

  // the booking summary, printable in either language
  router.get('/specialty/bookings/:id/print', (req, res, next) => {
    const k = bookingOf(h.int(req.params.id));
    if (!k) return next();
    const lang = docLang(req);
    const html = i18n.run(lang, () => {
      const s = db.settings();
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="/admin/specialty/bookings/${k.id}">${tr('Back')}</a>${docSwitch(ui, `/admin/specialty/bookings/${k.id}/print`, lang)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${ui.esc(tr('spc|Short-term space booking'))}</p><p class="doc__ref"><bdi>${ui.esc(k.ref)}</bdi> · ${ui.date(k.created_at)}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${ui.esc(tr('spc|Prepared for'))}</p><h1>${ui.esc(who(k))}</h1>${k.purpose ? `<p class="muted">${ui.esc(tx(k.purpose))}</p>` : ''}</section>
  <h2>${ui.esc(tr('spc|The space'))}</h2>
  <table class="doc__t doc__t--terms"><tbody>
    <tr><th>${ui.esc(tr('spc|Space'))}</th><td><bdi>${ui.esc(k.space_code)}</bdi> · ${ui.esc(tx(k.space_name))} · ${ui.esc(tr(TYPES[k.space_type]))}</td></tr>
    <tr><th>${ui.esc(tr('spc|Where'))}</th><td>${ui.esc([k.space_level, k.space_location].filter(Boolean).map((x) => tx(x)).join(' · ') || '—')}</td></tr>
    ${k.space_size ? `<tr><th>${ui.esc(tr('spc|Size'))}</th><td>${ui.m2(k.space_size)}</td></tr>` : ''}
    <tr><th>${ui.esc(tr('spc|Dates'))}</th><td>${ui.date(k.start_date)} – ${ui.date(k.end_date)} · ${ui.esc(tn(k.days, 'spc|{n} day', 'spc|{n} days'))}</td></tr>
    ${SHARED.has(k.space_type) ? `<tr><th>${ui.esc(tr('spc|Share of the loop'))}</th><td>${Math.round(k.share_pct)}%</td></tr>` : ''}
    <tr><th>${ui.esc(tr('spc|Services'))}</th><td>${ui.esc([k.power ? tr('spc|Power point') : null, k.water ? tr('spc|Water point') : null].filter(Boolean).join(' · ') || '—')}</td></tr>
  </tbody></table>
  <h2>${ui.esc(tr('spc|Price'))}</h2>
  <table class="doc__t"><tbody>
    <tr><td>${ui.esc(tr('spc|Booking fee'))}</td><td class="num">${ui.money(k.price)}</td></tr>
    ${k.deposit ? `<tr><td>${ui.esc(tr('spc|Refundable deposit'))}</td><td class="num">${ui.money(k.deposit)}</td></tr>` : ''}
  </tbody><tfoot><tr><td>${ui.esc(tr('spc|Due before set-up'))}</td><td class="num">${ui.money(k.price + (k.deposit || 0))}</td></tr></tfoot></table>
  <p class="doc__small">${ui.esc(tr('spc|{currency}, before VAT. The deposit is returned after the space is handed back clean and undamaged.', { currency: ui.curLabel() }))}</p>
  <h2>${ui.esc(tr('spc|Conditions'))}</h2>
  <ol class="doc__small">
    <li>${ui.esc(tr('spc|Set-up and removal happen outside opening hours, at times agreed with mall operations.'))}</li>
    <li>${ui.esc(tr('spc|All branding, structures and electrical work follow the mall\'s design and safety guidelines and are approved before set-up.'))}</li>
    <li>${ui.esc(tr('spc|The customer insures its goods and staff and is responsible for any damage to the space.'))}</li>
    <li>${ui.esc(tr('spc|The booking is confirmed once the fee and the deposit are paid.'))}</li>
    ${k.notes ? `<li>${ui.esc(tx(k.notes))}</li>` : ''}
  </ol>
  <div class="doc__sign"><div><span></span><p>${ui.esc(tr('spc|For {name}', { name: tx(s.legal_name) || 'The Wave' }))}</p></div><div><span></span><p>${ui.esc(tr('spc|For {name}', { name: who(k) }))}</p></div></div>
  <p class="doc__foot">${ui.esc(tx(s.legal_name))} · ${ui.esc(tx(s.address))}${s.leasing_email ? ` · ${ui.esc(s.leasing_email)}` : ''}</p>
</main>`;
      return ui.bare({ title: `${k.ref}`, body, cls: 'print' });
    });
    res.type('html').send(html);
  });
};

module.exports.SCHEMA = SCHEMA;
module.exports.quote = quote;
module.exports.clashes = clashes;
module.exports.SHARED = SHARED;
module.exports.ensure = (db) => db.ensure('specialty-1', SCHEMA);
