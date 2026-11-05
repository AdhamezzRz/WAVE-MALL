'use strict';

// Advertising and media sales: the mall's media inventory (digital screens sold by slots in a loop,
// banners, atrium and promotion zones, lift and escalator wraps, ATM spaces, sampling stands, car
// display spots, parking barrier arms…), a rate card per day, week and month with editable peak
// seasons and volume or duration discounts, a quote builder, an availability calendar (holds that
// expire, clashes refused), campaigns from proposal to proof of posting, invoices through the billing
// service (kind 'media'), discount approvals, reports, and a printable proposal in either language.

const { t: tr, tn, tx, isAr } = require('../i18n');
const i18n = require('../i18n');
const { tmap, registerDocs, uploadRoute, docLang, docSwitch, csvCell } = require('../ops-common');

const SCHEMA = `
  CREATE TABLE media_items (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_ar TEXT, type TEXT NOT NULL DEFAULT 'screen',
    level TEXT, location TEXT, location_ar TEXT, unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL, plan_pos TEXT,
    width_m REAL, height_m REAL, area_m2 REAL, specs TEXT, slots INTEGER NOT NULL DEFAULT 1, slot_seconds INTEGER, loop_seconds INTEGER,
    rate_day REAL, rate_week REAL, rate_month REAL, min_days INTEGER NOT NULL DEFAULT 1, exposure_pct REAL,
    status TEXT NOT NULL DEFAULT 'active', sort INTEGER NOT NULL DEFAULT 0, notes TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE media_seasons (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_ar TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL, pct REAL NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE media_tiers (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'duration', threshold INTEGER NOT NULL, pct REAL NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE media_clients (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'company', contact_name TEXT, phone TEXT, email TEXT,
    tax_id TEXT, address TEXT, notes TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE media_campaigns (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, client_id INTEGER REFERENCES media_clients(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'proposal', hold_until TEXT, start_date TEXT, end_date TEXT,
    list_total REAL NOT NULL DEFAULT 0, duration_off REAL NOT NULL DEFAULT 0, volume_pct REAL NOT NULL DEFAULT 0, volume_off REAL NOT NULL DEFAULT 0,
    extra_pct REAL NOT NULL DEFAULT 0, extra_off REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, discount_pct REAL NOT NULL DEFAULT 0,
    needs_approval INTEGER NOT NULL DEFAULT 0, approval_state TEXT NOT NULL DEFAULT 'none', approval_ref TEXT, approved_pct REAL,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, approved_at TEXT, approval_note TEXT,
    artwork_status TEXT NOT NULL DEFAULT 'none', artwork_at TEXT, artwork_by INTEGER REFERENCES users(id) ON DELETE SET NULL, artwork_note TEXT,
    confirmed_at TEXT, live_at TEXT, ended_at TEXT, cancel_reason TEXT, notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE media_lines (
    id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES media_campaigns(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
    slots INTEGER NOT NULL DEFAULT 1, days INTEGER NOT NULL DEFAULT 1, rate TEXT, base REAL NOT NULL DEFAULT 0, season_days INTEGER NOT NULL DEFAULT 0,
    list REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX media_lines_item ON media_lines(item_id, start_date, end_date);
  CREATE INDEX media_lines_campaign ON media_lines(campaign_id);
`;

const TYPES = {
  screen: 'med|Digital screen', videowall: 'med|LED video wall', banner: 'med|Banner', hanging: 'med|Hanging banner',
  atrium: 'med|Atrium or promotion zone', wrap: 'med|Lift or escalator wrap', atm: 'med|ATM space', stand: 'med|Sampling or promo stand',
  car: 'med|Car display spot', barrier: 'med|Parking barrier arm', lightbox: 'med|Lightbox or totem', facade: 'med|Façade billboard',
};
const TYPE_ICON = { screen: 'dash', videowall: 'dash', banner: 'flow', hanging: 'flow', atrium: 'store', wrap: 'flow', atm: 'wallet', stand: 'store', car: 'car', barrier: 'car', lightbox: 'globe', facade: 'unit' };
// sold by slots in a loop (several advertisers share the face)
const DIGITAL = new Set(['screen', 'videowall']);
const LEVELS = { b2: 'med|Parking B2', b1: 'med|Parking B1', ground: 'med|Ground floor', first: 'med|First floor', second: 'med|Second floor', roof: 'med|Roof terrace', outdoor: 'med|Outdoor' };
const ITEM_STATUS = { active: 'med|On sale', maintenance: 'med|Under maintenance', retired: 'med|Retired' };
const ITEM_TONE = { active: 'ok', maintenance: 'amber', retired: 'mute' };
const STATUS = { proposal: 'med|Proposal', held: 'med|On hold', confirmed: 'med|Confirmed', live: 'med|Live', ended: 'med|Ended', cancelled: 'med|Cancelled' };
const TONE = { proposal: 'sky', held: 'amber', confirmed: 'sea', live: 'ok', ended: 'mute', cancelled: 'rose' };
const ARTWORK = { none: 'med|Waiting for artwork', received: 'med|Artwork received', approved: 'med|Artwork approved', changes: 'med|Changes requested' };
const ART_TONE = { none: 'mute', received: 'amber', approved: 'ok', changes: 'rose' };
const CLIENT_KINDS = { company: 'med|Advertiser', agency: 'med|Agency' };
const TIER_KINDS = { duration: 'med|Duration', volume: 'med|Volume' };
// the campaign history, in the reader's language
const LOG = {
  'Created a media proposal': 'med|created the proposal', 'Added a space to a campaign': 'med|added a space', 'Took a space off a campaign': 'med|took a space off',
  'Changed a media discount': 'med|changed the discount', 'Asked for a media discount approval': 'med|asked for the discount to be approved',
  'Approved a media discount': 'med|approved the discount', 'Rejected a media discount': 'med|rejected the discount', 'Held media spaces': 'med|held the spaces',
  'Extended a media hold': 'med|extended the hold', 'Released a media hold': 'med|released the hold', 'Media hold expired': 'med|the hold ran out',
  'Confirmed a media campaign': 'med|confirmed the booking', 'Invoiced a media campaign': 'med|raised an invoice', 'Received media artwork': 'med|received the artwork',
  'Approved media artwork': 'med|approved the artwork', 'Asked for artwork changes': 'med|asked for artwork changes', 'Started a media campaign': 'med|started the campaign',
  'Ended a media campaign': 'med|ended the campaign', 'Cancelled a media campaign': 'med|cancelled the campaign', 'Uploaded a document': 'med|uploaded a file',
};
const RATE = { day: 'med|Day rate', week: 'med|Weekly rate', month: 'med|Monthly rate' };
const APPROVAL = { none: '', pending: 'med|Discount waiting for approval', approved: 'med|Discount approved', rejected: 'med|Discount rejected' };
// campaign statuses that take the inventory (a hold only while it lasts)
const TAKING = ['held', 'confirmed', 'live'];
const EDITABLE = ['proposal', 'held'];
const SOLD = ['confirmed', 'live', 'ended'];

// ---------- dates, pricing and clashes (pure; exported for tests) ----------
const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(day(v));
const addDays = (d, n) => iso(day(d) + n * 86400000);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function daysOf(start, end) {
  const out = [];
  for (let t = day(start); t <= day(end); t += 86400000) out.push(iso(t));
  return out;
}
const overlap = (a1, b1, a2, b2) => {
  const a = a1 > a2 ? a1 : a2;
  const b = b1 < b2 ? b1 : b2;
  return a > b ? 0 : Math.round((day(b) - day(a)) / 86400000) + 1;
};
const capOf = (item) => Math.max(1, Number(item.slots) || 1);

// The rate-card price of one placement. seasons: [{ start_date, end_date, pct }] (a day in several
// seasons takes the highest). Digital faces are priced per slot.
function priceLine(item, start, end, { seasons = [], slots = 1 } = {}) {
  if (!isDate(start) || !isDate(end) || end < start) return { error: 'med|Choose a start and an end date (the end on or after the start).' };
  const days = daysOf(start, end);
  const n = days.length;
  if (n > 366) return { error: 'med|A booking can run for a year at most.' };
  if (n < (item.min_days || 1)) return { error: 'med|{code} is sold for at least {n} days.', params: { code: item.code, n: item.min_days } };
  const cap = capOf(item);
  const s = Math.max(1, Math.min(cap, Math.round(Number(slots) || 1)));
  const v = (x) => (x === null || x === undefined || x === '' || !(Number(x) > 0) ? null : Number(x));
  const d = v(item.rate_day);
  const w = v(item.rate_week);
  const m = v(item.rate_month);
  let base;
  let rate;
  if (n >= 28 && m) { base = m / 30; rate = 'month'; } else if (n >= 7 && w) { base = w / 7; rate = 'week'; } else if (d) { base = d; rate = 'day'; } else if (w) { base = w / 7; rate = 'week'; } else if (m) { base = m / 30; rate = 'month'; } else return { error: 'med|{code} has no rates yet. Set its rate card first.', params: { code: item.code } };
  let total = 0;
  let seasonDays = 0;
  for (const x of days) {
    const hits = seasons.filter((k) => k.start_date <= x && k.end_date >= x).map((k) => Number(k.pct) || 0);
    const p = hits.length ? Math.max(...hits) : 0;
    if (p) seasonDays++;
    total += base * (1 + p / 100);
  }
  return { days: n, rate, base: r2(base), slots: s, seasonDays, plain: r2(base * n * s), list: r2(total * s) };
}

// Discounts on a set of priced lines: duration tiers per line (by its days), a volume tier on the
// number of placements, then any extra discount the salesperson gives. Allocates the total back
// to the lines (for invoicing by month).
function priceCampaign(lines, { tiers = [], extraPct = 0 } = {}) {
  const best = (kind, x) => Math.max(0, ...tiers.filter((t) => t.kind === kind && x >= Number(t.threshold)).map((t) => Number(t.pct) || 0));
  const list = r2(lines.reduce((s, l) => s + l.list, 0));
  const after = lines.map((l) => {
    const pct = Math.min(100, best('duration', l.days));
    return { ...l, duration_pct: pct, net: l.list * (1 - pct / 100) };
  });
  const sub = after.reduce((s, l) => s + l.net, 0);
  const placements = new Set(lines.map((l) => l.item_id)).size;
  const volumePct = Math.min(100, best('volume', placements));
  const afterVol = sub * (1 - volumePct / 100);
  const extra = Math.max(0, Math.min(100, Number(extraPct) || 0));
  const total = Math.round(afterVol * (1 - extra / 100));
  // the total back onto the lines, in proportion; the last line takes the rounding
  let left = total;
  const out = after.map((l, i) => {
    const price = i === after.length - 1 ? r2(left) : r2(sub ? (total * l.net) / sub : 0);
    left -= price;
    return { ...l, price };
  });
  return {
    list, placements, durationOff: r2(list - sub), volumePct, volumeOff: r2(sub - afterVol), extraPct: extra, extraOff: r2(afterVol - total),
    total, pct: list ? r2((1 - total / list) * 100) : 0, lines: out,
  };
}

// Days on which a placement would not fit: the slots taken by others plus this one pass the face's
// capacity (1 for a banner or a stand, the loop's slots for a screen). others: [{ start_date, end_date, slots }]
function conflicts(others, item, start, end, slots = 1) {
  const cap = capOf(item);
  const want = Math.max(1, Number(slots) || 1);
  const bad = [];
  if (!isDate(start) || !isDate(end) || end < start) return bad;
  const mine = others.filter((o) => (o.item_id === undefined || o.item_id === item.id) && o.start_date <= end && o.end_date >= start);
  if (!mine.length && want <= cap) return bad;
  for (const d of daysOf(start, end)) {
    const used = mine.filter((o) => o.start_date <= d && o.end_date >= d).reduce((s, o) => s + (Number(o.slots) || 1), 0);
    if (used + want > cap) bad.push({ date: d, used, cap });
  }
  return bad;
}

// Invoices for a campaign: one for the whole, or one per calendar month (each line's price spread
// over its days). lines: [{ start_date, end_date, days, price }]
function invoicePlan(lines, { monthly = false } = {}) {
  const total = r2(lines.reduce((s, l) => s + l.price, 0));
  if (!lines.length || !(total > 0)) return [];
  const start = lines.reduce((a, l) => (l.start_date < a ? l.start_date : a), lines[0].start_date);
  const end = lines.reduce((a, l) => (l.end_date > a ? l.end_date : a), lines[0].end_date);
  if (!monthly || start.slice(0, 7) === end.slice(0, 7)) return [{ period_start: start, period_end: end, amount: total }];
  const out = [];
  for (let m = `${start.slice(0, 7)}-01`; m <= end; ) {
    const next = iso(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1));
    const mEnd = addDays(next, -1);
    const amount = r2(lines.reduce((s, l) => s + (l.price * overlap(l.start_date, l.end_date, m, mEnd)) / (l.days || 1), 0));
    if (amount > 0) out.push({ period_start: m < start ? start : m, period_end: mEnd > end ? end : mEnd, amount });
    m = next;
  }
  const head = r2(out.slice(0, -1).reduce((s, x) => s + x.amount, 0));
  out[out.length - 1].amount = r2(total - head);
  return out;
}

module.exports = function media(router, h) {
  const { db, ui, M } = h;
  const R = h.R;
  const esc = ui.esc;
  db.ensure('media-1', SCHEMA);
  registerDocs(M, 'media_item', 'med|Advertising space', { media_photo: 'med|Photo', media_spec: 'med|Technical specification' });
  registerDocs(M, 'media_campaign', 'med|Advertising campaign', { media_artwork: 'med|Artwork', media_proof: 'med|Proof of posting', media_signed: 'med|Signed proposal' });
  const panel = uploadRoute(router, h, '/media/files', { media_item: 'media_items', media_campaign: 'media_campaigns' });
  // what people type: never translated (the Arabic audit skips it)
  (h.auditTyped = h.auditTyped || []).push(
    'SELECT code, name, location, plan_pos, specs, notes FROM media_items',
    'SELECT name FROM media_seasons',
    'SELECT name, contact_name, phone, email, tax_id, address, notes FROM media_clients',
    'SELECT ref, title, notes, artwork_note, approval_note, cancel_reason FROM media_campaigns',
  );

  const today = () => M.today();
  const nm = (x, k = 'name') => (x ? (isAr() && x[`${k}_ar`] ? x[`${k}_ar`] : x[k] || '') : '');
  const types = () => tmap(TYPES);
  const badge = (s) => ui.badge(s, tr(STATUS[s]), TONE[s]);
  const artBadge = (s) => ui.badge(`art_${s}`, tr(ARTWORK[s] || ARTWORK.none), ART_TONE[s]);
  const S = (k, d) => { const v = Number(db.setting(k)); return Number.isFinite(v) && db.setting(k) !== null && db.setting(k) !== undefined && db.setting(k) !== '' ? v : d; };
  const holdDays = () => S('media_hold_days', 5);
  const freePct = () => S('media_free_discount', 10);
  const artDays = () => S('media_artwork_days', 5);
  const seasons = () => db.all('SELECT * FROM media_seasons ORDER BY start_date');
  const tiers = () => db.all('SELECT * FROM media_tiers ORDER BY kind, threshold');
  const has = (t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  const itemOf = (id) => db.get('SELECT * FROM media_items WHERE id = ?', id);
  const PARTY = `COALESCE(b.name, k.name) party, b.name brand_name, k.name client_name, k.kind client_kind`;
  const JOINS = 'LEFT JOIN brands b ON b.id = c.brand_id LEFT JOIN media_clients k ON k.id = c.client_id';
  const campaignOf = (id) => db.get(`SELECT c.*, ${PARTY}, k.contact_name, k.phone client_phone, k.email client_email, k.tax_id client_tax, k.address client_address,
    u.name author, a.name approver, w.name art_user FROM media_campaigns c ${JOINS} LEFT JOIN users u ON u.id = c.created_by LEFT JOIN users a ON a.id = c.approved_by
    LEFT JOIN users w ON w.id = c.artwork_by WHERE c.id = ?`, id);
  const linesOf = (id) => db.all(`SELECT l.*, i.code, i.name, i.name_ar, i.type, i.level, i.location, i.location_ar, i.slots cap, i.slot_seconds, i.loop_seconds,
    i.width_m, i.height_m, i.area_m2, i.exposure_pct, i.specs FROM media_lines l JOIN media_items i ON i.id = l.item_id WHERE l.campaign_id = ? ORDER BY l.start_date, i.sort, i.code`, id);
  const party = (c) => c.party || '—';
  const where = (i) => [i.level && LEVELS[i.level] ? tr(LEVELS[i.level]) : null, nm(i, 'location') || null].filter(Boolean).join(' · ');
  const size = (i) => {
    const n2 = (x) => String(Math.round(Number(x) * 100) / 100);
    if (i.width_m && i.height_m) return `${n2(i.width_m)} × ${n2(i.height_m)} ${tr('med|m')}`;
    if (i.area_m2) return ui.m2(i.area_m2);
    return '';
  };
  const loop = (i) => (capOf(i) > 1 ? tr('med|{n} slots × {s} s', { n: capOf(i), s: i.slot_seconds || 10 }) : '');
  const slotsText = (l) => (capOf({ slots: l.cap }) > 1 ? tr('med|{n} of {cap} slots', { n: l.slots, cap: l.cap }) : '');

  // ---------- the audience: visitors a day from the footfall counts (last 28 days) ----------
  let visitorsCache = { at: 0, v: null };
  function dailyVisitors() {
    if (Date.now() - visitorsCache.at < 60000) return visitorsCache.v;
    let v = null;
    if (has('footfall')) {
      const from = addDays(today(), -28);
      const r = db.get('SELECT COUNT(DISTINCT substr(ts_hour, 1, 10)) d, COALESCE(SUM(visitors_in), 0) n FROM footfall WHERE ts_hour >= ?', from);
      if (r && r.d && r.n) v = Math.round(r.n / r.d);
    }
    if (!v) v = Number(db.setting('media_daily_visitors')) || null;
    visitorsCache = { at: Date.now(), v };
    return v;
  }
  // people passing a day, and the views of one placement (a digital ad shows for its share of the loop)
  const passing = (i) => (dailyVisitors() && i.exposure_pct ? Math.round((dailyVisitors() * i.exposure_pct) / 100) : null);
  const views = (l) => {
    const p = passing(l);
    return p === null ? null : Math.round(p * l.days * (capOf({ slots: l.cap }) > 1 ? l.slots / l.cap : 1));
  };

  // ---------- what takes the inventory ----------
  // Lines of campaigns holding, confirmed or live (a hold only until it runs out), overlapping a range.
  function taking(from, to, { exclude = 0, itemId = null } = {}) {
    return db.all(`SELECT l.*, c.status, c.ref FROM media_lines l JOIN media_campaigns c ON c.id = l.campaign_id
      WHERE c.id != ? AND c.status IN ('held','confirmed','live') AND (c.status != 'held' OR c.hold_until IS NULL OR c.hold_until >= ?)
      AND l.start_date <= ? AND l.end_date >= ?${itemId ? ' AND l.item_id = ?' : ''}`, exclude, today(), to, from, ...(itemId ? [itemId] : []));
  }
  // Every day a campaign's lines would not fit, against the others and its own earlier lines.
  function campaignClashes(c, lines) {
    if (!lines.length) return [];
    const from = lines.reduce((a, l) => (l.start_date < a ? l.start_date : a), lines[0].start_date);
    const to = lines.reduce((a, l) => (l.end_date > a ? l.end_date : a), lines[0].end_date);
    const others = taking(from, to, { exclude: c.id });
    const out = [];
    const mine = [];
    for (const l of lines) {
      const item = { id: l.item_id, slots: l.cap, code: l.code };
      const bad = conflicts([...others, ...mine], item, l.start_date, l.end_date, l.slots);
      if (bad.length) out.push({ line: l, days: bad });
      mine.push(l);
    }
    return out;
  }
  const clashText = (list) => list.map((x) => tr('med|{code} is fully booked on {date}', { code: x.line.code, date: ui.date(x.days[0].date) })).join(' · ');

  // ---------- discounts and approvals ----------
  const needsApproval = (extraPct, extraOff) => extraPct > 0 && (extraPct > freePct() + 1e-9
    || !!(h.approvals && typeof h.approvals.needs === 'function' && h.approvals.needs('media_discount', extraOff)));
  let hooked = null;
  function decide(request, decision, user) {
    const id = Number((request && (request.entity_id || (request.payload && request.payload.campaign_id))) || 0);
    const c = id && db.get('SELECT * FROM media_campaigns WHERE id = ?', id);
    if (!c) return;
    const status = decision && typeof decision === 'object' ? decision.status || decision.decision : decision;
    const ok = decision === true || /^approv/i.test(String(status || ''));
    const note = decision && typeof decision === 'object' ? decision.note || decision.comment || null : null;
    if (ok) {
      const pct = request && request.payload && Number.isFinite(Number(request.payload.pct)) ? Number(request.payload.pct) : c.extra_pct;
      db.run("UPDATE media_campaigns SET approval_state = 'approved', approved_pct = ?, approved_by = ?, approved_at = ?, needs_approval = 0, approval_note = ?, updated_at = ? WHERE id = ?",
        pct, user ? user.id : null, M.now(), note, M.now(), c.id);
      db.audit(user || null, 'Approved a media discount', 'media_campaign', c.id, `${c.ref} · ${pct}%`);
    } else {
      db.run("UPDATE media_campaigns SET approval_state = 'rejected', approval_note = ?, updated_at = ? WHERE id = ?", note, M.now(), c.id);
      db.audit(user || null, 'Rejected a media discount', 'media_campaign', c.id, c.ref);
    }
    refresh(c.id);
  }
  function hook() {
    const A = h.approvals;
    if (A && A !== hooked && typeof A.onDecision === 'function') { A.onDecision('media_discount', decide); hooked = A; }
  }
  hook();

  // Re-price a campaign still being sold (proposal or hold): lines from the rate card, discounts,
  // dates, and whether the discount needs approval.
  function refresh(id) {
    const c = db.get('SELECT * FROM media_campaigns WHERE id = ?', id);
    if (!c) return null;
    const lines = linesOf(id);
    if (EDITABLE.includes(c.status)) {
      const sea = seasons();
      for (const l of lines) {
        const q = priceLine({ ...itemOf(l.item_id), min_days: 1 }, l.start_date, l.end_date, { seasons: sea, slots: l.slots });
        if (q.error) continue;
        Object.assign(l, { days: q.days, rate: q.rate, base: q.base, season_days: q.seasonDays, list: q.list, slots: q.slots });
      }
      const p = priceCampaign(lines, { tiers: tiers(), extraPct: c.extra_pct });
      db.tx(() => {
        for (const l of p.lines) db.run('UPDATE media_lines SET days = ?, rate = ?, base = ?, season_days = ?, list = ?, price = ?, slots = ? WHERE id = ?', l.days, l.rate, l.base, l.season_days, l.list, l.price, l.slots, l.id);
        // an approval covers the discount it was given for, not a deeper one
        const need = needsApproval(p.extraPct, p.extraOff);
        // (lowering it back within an earlier approval needs no new one)
        const covered = c.approved_pct !== null && c.approved_pct !== undefined && p.extraPct <= c.approved_pct + 1e-9;
        let state = c.approval_state;
        if (!need && state !== 'approved') state = 'none';
        if (need) state = covered ? 'approved' : state === 'approved' ? 'none' : state;
        db.run(`UPDATE media_campaigns SET list_total = ?, duration_off = ?, volume_pct = ?, volume_off = ?, extra_off = ?, total = ?, discount_pct = ?,
          needs_approval = ?, approval_state = ?, approved_pct = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ?`,
        p.list, p.durationOff, p.volumePct, p.volumeOff, p.extraOff, p.total, p.pct, need && state !== 'approved' ? 1 : 0, state,
        c.approved_pct,
        lines.length ? lines.reduce((a, l) => (l.start_date < a ? l.start_date : a), lines[0].start_date) : null,
        lines.length ? lines.reduce((a, l) => (l.end_date > a ? l.end_date : a), lines[0].end_date) : null, M.now(), id);
      });
    }
    return db.get('SELECT * FROM media_campaigns WHERE id = ?', id);
  }

  // ---------- housekeeping: holds that ran out, campaigns that went live or ended ----------
  function sweep() {
    const t = today();
    for (const c of db.all("SELECT id, ref FROM media_campaigns WHERE status = 'held' AND hold_until IS NOT NULL AND hold_until < ?", t)) {
      db.run("UPDATE media_campaigns SET status = 'proposal', hold_until = NULL, updated_at = ? WHERE id = ?", M.now(), c.id);
      db.audit(null, 'Media hold expired', 'media_campaign', c.id, c.ref);
    }
    db.run("UPDATE media_campaigns SET status = 'live', live_at = COALESCE(live_at, ?), updated_at = ? WHERE status = 'confirmed' AND artwork_status = 'approved' AND start_date <= ? AND end_date >= ?", M.now(), M.now(), t, t);
    db.run("UPDATE media_campaigns SET status = 'ended', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE status IN ('confirmed','live') AND end_date < ?", M.now(), M.now(), t);
  }
  h.media = { sweep, priceLine, priceCampaign, conflicts, invoicePlan, refresh };
  h.every('media-sweep', 60 * 60 * 1000, () => sweep(), { first: 20 * 1000 });

  // starting within a week with artwork not yet approved, and discounts waiting on a manager here
  const attention = (user) => {
    const t = today();
    const art = db.value("SELECT COUNT(*) FROM media_campaigns WHERE status IN ('held','confirmed','live') AND artwork_status != 'approved' AND start_date <= ? AND end_date >= ?", addDays(t, 7), t);
    const appr = !h.approvals && user && h.auth.allowed(user, 'manager') ? db.value("SELECT COUNT(*) FROM media_campaigns WHERE approval_state = 'pending' AND status IN ('proposal','held')") : 0;
    return art + appr;
  };
  h.count('media', (user) => attention(user));

  const docCount = (entity, id, kind) => db.value('SELECT COUNT(*) FROM documents WHERE entity = ? AND entity_id = ? AND kind = ? AND archived = 0', entity, id, kind);
  const photoOf = (id) => db.value("SELECT id FROM documents WHERE entity = 'media_item' AND entity_id = ? AND kind = 'media_photo' AND mime LIKE 'image/%' AND archived = 0 ORDER BY id DESC LIMIT 1", id);
  const thumb = (i, cls = '') => {
    const p = photoOf(i.id);
    return p ? `<span class="med-thumb ${cls}"><img src="/admin/documents/${p}/file" alt="" loading="lazy"></span>` : `<span class="med-thumb med-thumb--${esc(i.type)} ${cls}">${ui.icon(TYPE_ICON[i.type] || 'cam')}</span>`;
  };

  const TABS = [['/admin/media', 'med|Overview'], ['/admin/media/calendar', 'med|Calendar'], ['/admin/media/campaigns', 'med|Campaigns'], ['/admin/media/inventory', 'med|Inventory'],
    ['/admin/media/rates', 'med|Rates and seasons'], ['/admin/media/clients', 'med|Advertisers'], ['/admin/media/reports', 'med|Reports']];
  const tabs = (on) => `<nav class="tabs">${TABS.map(([href, l]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${esc(tr(l))}</a>`).join('')}</nav>`;
  const crumbs = (...more) => [['/admin/media', tr('nav|Advertising')], ...more];
  const quoteBtn = (req) => (h.can(req, 'agent') ? ui.btn(esc(tr('med|Build a quote')), { href: '/admin/media/quote', cls: 'btn--primary', ic: 'plus' }) : '');

  // ---------- booked revenue and sell-through ----------
  // Each sold line's price spread over its days; the share falling inside [from, to].
  function bookedLines(from, to) {
    return db.all(`SELECT l.*, i.type, i.code, c.brand_id, c.client_id, c.ref, ${PARTY} FROM media_lines l JOIN media_campaigns c ON c.id = l.campaign_id
      JOIN media_items i ON i.id = l.item_id ${JOINS} WHERE c.status IN ('confirmed','live','ended') AND l.start_date <= ? AND l.end_date >= ?`, to, from);
  }
  const share = (l, from, to) => (l.days ? (l.price * overlap(l.start_date, l.end_date, from, to)) / l.days : 0);
  function sellThrough(from, to, items = null) {
    const list = items || db.all("SELECT * FROM media_items WHERE status != 'retired'");
    const n = overlap(from, to, from, to);
    const capacity = list.reduce((s, i) => s + capOf(i) * n, 0);
    const ids = new Set(list.map((i) => i.id));
    const sold = bookedLines(from, to).filter((l) => ids.has(l.item_id)).reduce((s, l) => s + l.slots * overlap(l.start_date, l.end_date, from, to), 0);
    return capacity ? Math.min(1, sold / capacity) : 0;
  }
  const monthEnd = (key) => addDays(iso(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 1)), -1);
  const monthOk = (key) => /^\d{4}-\d{2}$/.test(key || '') && key >= M.addMonths(`${today().slice(0, 7)}-01`, -12).slice(0, 7) && key <= M.addMonths(`${today().slice(0, 7)}-01`, 12).slice(0, 7);

  // ---------- the availability calendar: items × days ----------
  function calendar(items, from, to, { book = false } = {}) {
    const days = daysOf(from, to);
    const n = days.length;
    const t = today();
    const lines = db.all(`SELECT l.*, c.ref, c.status, c.hold_until, ${PARTY} FROM media_lines l JOIN media_campaigns c ON c.id = l.campaign_id ${JOINS}
      WHERE c.status IN ('proposal','held','confirmed','live','ended') AND l.start_date <= ? AND l.end_date >= ? ORDER BY l.start_date, c.id`, to, from);
    const wd = ui.weekdays();
    const head = `<div class="med-cal__row med-cal__row--head"><span class="med-cal__name"></span><div class="med-cal__days" style="--n:${n}">${days.map((d) => {
      const dow = new Date(day(d)).getUTCDay();
      return `<span class="${[5, 6].includes(dow) ? 'is-we' : ''}${d === t ? ' is-today' : ''}"><b>${Number(d.slice(8))}</b>${n <= 21 ? `<small>${esc(isAr() ? String(wd[(dow + 6) % 7]).replace(/^ال/, '').slice(0, 2) : String(wd[(dow + 6) % 7]).slice(0, 2))}</small>` : ''}</span>`;
    }).join('')}</div></div>`;
    const rows = items.map((i) => {
      const cap = capOf(i);
      const mine = lines.filter((l) => l.item_id === i.id);
      const lanes = [];
      const placed = mine.map((l) => {
        let lane = lanes.findIndex((end) => end < l.start_date);
        if (lane < 0) { lane = lanes.length; lanes.push(l.end_date); } else lanes[lane] = l.end_date;
        return { l, lane };
      });
      const bars = placed.map(({ l, lane }) => {
        const a = days.indexOf(l.start_date < from ? from : l.start_date);
        const b = days.indexOf(l.end_date > to ? to : l.end_date);
        const label = `${party(l)}${cap > 1 ? ` · ${l.slots}/${cap}` : ''}`;
        return `<a class="med-bar med-bar--${l.status}" href="/admin/media/campaigns/${l.campaign_id}" style="inset-inline-start:${((a / n) * 100).toFixed(3)}%;width:${(((b - a + 1) / n) * 100).toFixed(3)}%;top:${4 + lane * 24}px" title="${esc(`${l.ref} · ${label} · ${ui.date(l.start_date)} – ${ui.date(l.end_date)} · ${tr(STATUS[l.status])}`)}">${esc(label)}</a>`;
      }).join('');
      const take = mine.filter((l) => TAKING.includes(l.status) && (l.status !== 'held' || !l.hold_until || l.hold_until >= t));
      const cells = days.map((d, k) => {
        const used = take.filter((l) => l.start_date <= d && l.end_date >= d).reduce((s, l) => s + l.slots, 0);
        const dow = new Date(day(d)).getUTCDay();
        const free = used < cap && i.status === 'active';
        const fill = cap > 1 && used ? `<i class="med-cal__fill" style="width:${Math.min(100, (used / cap) * 100).toFixed(0)}%"></i>` : '';
        return `<span class="med-cal__cell${[5, 6].includes(dow) ? ' is-we' : ''}${d === t ? ' is-today' : ''}${used >= cap ? ' is-full' : ''}" style="inset-inline-start:${((k / n) * 100).toFixed(3)}%;width:${(100 / n).toFixed(3)}%"${book && free && d >= t ? ` data-book="/admin/media/quote?item=${i.id}&amp;start=${d}&amp;end=${addDays(d, Math.max(6, (i.min_days || 1) - 1))}" role="button" tabindex="-1" aria-label="${esc(tr('med|Quote {code} from {date}', { code: i.code, date: ui.date(d) }))}"` : ''}>${fill}</span>`;
      }).join('');
      return `<div class="med-cal__row"><a class="med-cal__name" href="/admin/media/inventory/${i.id}"><b><bdi>${esc(i.code)}</bdi></b><small>${esc(cap > 1 ? loop(i) : tr(TYPES[i.type]))}</small></a><div class="med-cal__track${i.status !== 'active' ? ' is-off' : ''}" style="height:${Math.max(1, lanes.length) * 24 + 10}px">${cells}${bars}</div></div>`;
    }).join('');
    return `<div class="med-cal-wrap"><div class="med-cal" style="--days:${n}">${head}${rows}</div></div>`;
  }
  // items × weeks: the share of slot-days sold or held
  function weekGrid(items, from, weeks) {
    const to = addDays(from, weeks * 7 - 1);
    const t = today();
    const lines = db.all(`SELECT l.* FROM media_lines l JOIN media_campaigns c ON c.id = l.campaign_id WHERE c.status IN ('held','confirmed','live','ended')
      AND (c.status != 'held' OR c.hold_until IS NULL OR c.hold_until >= ?) AND l.start_date <= ? AND l.end_date >= ?`, t, to, from);
    const ws = Array.from({ length: weeks }, (_, k) => addDays(from, k * 7));
    return `<div class="med-heat-wrap"><div class="med-heat" style="--w:${weeks}"><span></span>${ws.map((w) => `<span class="med-heat__h">${esc(ui.date(w).replace(/\s\d{4}$/, ''))}</span>`).join('')}${items.map((i) => `<a class="med-heat__s" href="/admin/media/inventory/${i.id}"><bdi>${esc(i.code)}</bdi></a>${ws.map((w) => {
      const we = addDays(w, 6);
      const used = lines.filter((l) => l.item_id === i.id).reduce((s, l) => s + l.slots * overlap(l.start_date, l.end_date, w, we), 0);
      const f = Math.min(1, used / (capOf(i) * 7));
      return `<span class="med-heat__c" style="--f:${f.toFixed(2)}" title="${esc(`${i.code} · ${ui.date(w)} · ${ui.pct(f)}`)}">${f ? ui.pct(f) : ''}</span>`;
    }).join('')}`).join('')}</div></div>`;
  }
  const legend = () => `<ul class="legend legend--row med-legend">${['proposal', 'held', 'confirmed', 'live', 'ended'].map((s) => `<li><i class="med-dot med-dot--${s}"></i><span>${esc(tr(STATUS[s]))}</span></li>`).join('')}<li><i class="med-dot med-dot--fill"></i><span>${esc(tr('med|Slots taken'))}</span></li></ul>`;

  // ---------- overview ----------
  router.get('/media', (req, res) => {
    sweep();
    const t = today();
    const key = t.slice(0, 7);
    const mFrom = `${key}-01`;
    const mTo = monthEnd(key);
    const items = db.all("SELECT * FROM media_items WHERE status != 'retired' ORDER BY sort, code");
    const live = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.status = 'live' ORDER BY c.end_date`);
    const liveLines = db.value("SELECT COUNT(*) FROM media_lines l JOIN media_campaigns c ON c.id = l.campaign_id WHERE c.status = 'live' AND l.start_date <= ? AND l.end_date >= ?", t, t);
    const st = sellThrough(mFrom, mTo, items);
    const rev = (a, b) => bookedLines(a, b).reduce((s, l) => s + share(l, a, b), 0);
    const monthRev = rev(mFrom, mTo);
    const ytd = rev(`${t.slice(0, 4)}-01-01`, `${t.slice(0, 4)}-12-31`);
    const soon = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.status IN ('held','confirmed','live') AND c.start_date <= ? AND c.end_date >= ?
      AND (c.artwork_status != 'approved' OR c.approval_state = 'pending') ORDER BY c.start_date LIMIT 10`, addDays(t, 7), t);
    const holds = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.status = 'held' ORDER BY c.hold_until LIMIT 8`);
    const approvals = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.approval_state = 'pending' AND c.status IN ('proposal','held') ORDER BY c.updated_at DESC LIMIT 6`);
    const proof = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.status IN ('live','ended') AND c.end_date >= ?
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.entity = 'media_campaign' AND d.entity_id = c.id AND d.kind = 'media_proof' AND d.archived = 0) ORDER BY c.start_date LIMIT 8`, addDays(t, -45));
    const ending = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.status IN ('confirmed','live') AND c.end_date >= ? AND c.end_date <= ? ORDER BY c.end_date LIMIT 8`, t, addDays(t, 21));
    const kpis = [
      ui.kpi({ label: tr('med|Live now'), value: ui.n0(live.length), sub: esc(tn(liveLines, 'med|{n} placement on air', 'med|{n} placements on air')), href: '/admin/media/campaigns?status=live' }),
      ui.kpi({ label: tr('med|Sell-through this month'), value: ui.pct(st), bar: st, sub: esc(tn(items.length, 'med|across {n} space', 'med|across {n} spaces')) }),
      ui.kpi({ label: tr('med|Booked this month'), value: ui.money(monthRev, { compact: true }), sub: esc(tr('med|{amount} this year', { amount: ui.money(ytd, { compact: true }) })) }),
      ui.kpi({ label: tr('med|Needs you this week'), value: ui.n0(soon.length + approvals.length), sub: esc(tr('med|artwork and approvals')), tone: soon.length + approvals.length ? 'kpi--alert' : '' }),
    ].join('');
    const listOf = (rows, empty, extra) => (rows.length
      ? `<ul class="list">${rows.map((c) => `<li><a href="/admin/media/campaigns/${c.id}"><span class="what"><b>${esc(party(c))} · ${esc(c.title)}</b><small><bdi>${esc(c.ref)}</bdi> · ${c.start_date ? `${ui.date(c.start_date)} – ${ui.date(c.end_date)}` : '—'}${extra ? ` · ${extra(c)}` : ''}</small></span>${badge(c.status)}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${esc(empty)}</p>`);
    const why = (c) => esc([c.artwork_status !== 'approved' ? tr(ARTWORK[c.artwork_status]) : null, c.approval_state === 'pending' ? tr(APPROVAL.pending) : null].filter(Boolean).join(' · '));
    const holdLeft = (c) => esc(c.hold_until ? tr('med|hold until {date}', { date: ui.date(c.hold_until) }) : '');
    const from = t;
    const to = addDays(t, 20);
    const cal = items.length
      ? `${calendar(items, from, to, { book: h.can(req, 'agent') })}${legend()}`
      : ui.empty(tr('med|Add your first advertising space to start selling.'), h.can(req, 'manager') ? ui.btn(esc(tr('med|Add a space')), { href: '/admin/media/inventory/new', cls: 'btn--primary btn--sm' }) : '');
    const top = db.all(`SELECT COALESCE(b.name, k.name) party, c.brand_id, c.client_id, SUM(c.total) amount, COUNT(*) n FROM media_campaigns c ${JOINS}
      WHERE c.status IN ('confirmed','live','ended') AND substr(c.start_date, 1, 4) = ? GROUP BY c.brand_id, c.client_id ORDER BY amount DESC LIMIT 6`, t.slice(0, 4));
    const topList = top.length
      ? `<ul class="list med-top">${top.map((c) => `<li><span class="what"><b>${esc(c.party || '—')}</b><small>${esc(tn(c.n, 'med|{n} campaign', 'med|{n} campaigns'))}</small></span><b>${ui.money(c.amount, { compact: true })}</b></li>`).join('')}</ul>`
      : `<p class="muted pad">${esc(tr('med|No campaigns sold this year yet.'))}</p>`;
    const body = `${tabs('/admin/media')}<div class="kpis kpis--4">${kpis}</div>
${ui.card(tr('med|The next three weeks'), cal, { action: ui.btn(esc(tr('med|Full calendar')), { href: '/admin/media/calendar', cls: 'btn--ghost btn--sm' }), sub: esc(tr('med|Click a free day to quote that space.')) })}
<div class="grid grid--2">
  ${ui.card(tr('med|Artwork and approvals this week'), listOf([...approvals.filter((a) => !soon.some((s) => s.id === a.id)), ...soon], tr('med|Every campaign starting this week has its artwork and approvals.'), why))}
  ${ui.card(tr('med|Holds'), listOf(holds, tr('med|No campaigns on hold.'), holdLeft), { sub: esc(tr('med|A hold keeps the space for {n} days, then lets it go.', { n: holdDays() })) })}
</div>
<div class="grid grid--3">
  ${ui.card(tr('med|Ending in three weeks'), listOf(ending, tr('med|Nothing ends in the next three weeks.')), { sub: esc(tr('med|A good moment to offer a renewal.')) })}
  ${ui.card(tr('med|Proof of posting missing'), listOf(proof, tr('med|Every campaign on air has its photos.')), { sub: esc(tr('med|Photos of each placement on air, for the advertiser.')) })}
  ${ui.card(tr('med|Top advertisers this year'), topList)}
</div>`;
    h.page(req, res, { title: tr('nav|Advertising'), active: '/admin/media', wide: true, body, actions: quoteBtn(req) });
  });

  // ---------- the calendar ----------
  router.get('/media/calendar', (req, res) => {
    sweep();
    const t = today();
    const view = req.query.view === 'weeks' ? 'weeks' : 'days';
    const type = TYPES[req.query.type] ? req.query.type : '';
    const level = LEVELS[req.query.level] ? req.query.level : '';
    const items = db.all(`SELECT * FROM media_items WHERE status != 'retired'${type ? ' AND type = ?' : ''}${level ? ' AND level = ?' : ''} ORDER BY sort, code`, ...[type, level].filter(Boolean));
    const key = monthOk(req.query.month) ? req.query.month : t.slice(0, 7);
    const keep = (extra) => { const q = new URLSearchParams({ ...(type ? { type } : {}), ...(level ? { level } : {}), ...extra }); return `/admin/media/calendar?${q}`; };
    let grid;
    let nav;
    if (view === 'weeks') {
      const dow = (new Date(day(t)).getUTCDay() + 6) % 7;
      const start = isDate(req.query.from) && Math.abs(day(req.query.from) - day(t)) < 400 * 86400000 ? req.query.from : addDays(t, -dow);
      grid = weekGrid(items, start, 13);
      nav = `<div class="row med-nav"><a class="btn btn--ghost btn--sm" href="${esc(keep({ view: 'weeks', from: addDays(start, -91) }))}" aria-label="${esc(tr('med|Earlier'))}">‹</a><b>${ui.date(start)} – ${ui.date(addDays(start, 90))}</b><a class="btn btn--ghost btn--sm" href="${esc(keep({ view: 'weeks', from: addDays(start, 91) }))}" aria-label="${esc(tr('med|Later'))}">›</a><a class="btn btn--ghost btn--sm" href="${esc(keep({}))}">${esc(tr('med|Days'))}</a></div>`;
    } else {
      const from = `${key}-01`;
      const to = monthEnd(key);
      const prev = M.addMonths(from, -1).slice(0, 7);
      const next = M.addMonths(from, 1).slice(0, 7);
      grid = `${calendar(items, from, to, { book: h.can(req, 'agent') })}`;
      nav = `<div class="row med-nav">${monthOk(prev) ? `<a class="btn btn--ghost btn--sm" href="${esc(keep({ month: prev }))}" aria-label="${esc(tr('med|Previous month'))}">‹</a>` : ''}<b>${esc(ui.monthYear(key))}</b>${monthOk(next) ? `<a class="btn btn--ghost btn--sm" href="${esc(keep({ month: next }))}" aria-label="${esc(tr('med|Next month'))}">›</a>` : ''}<a class="btn btn--ghost btn--sm" href="${esc(keep({ view: 'weeks' }))}">${esc(tr('med|Weeks'))}</a></div>`;
    }
    const filters = `<form method="get" action="/admin/media/calendar" class="filters med-filters">${view === 'weeks' ? '<input type="hidden" name="view" value="weeks">' : `<input type="hidden" name="month" value="${esc(key)}">`}
      ${ui.select('type', tr('Type'), types(), type, { blank: tr('med|All types'), attrs: { 'data-autosubmit': '' } })}
      ${ui.select('level', tr('Level'), tmap(LEVELS), level, { blank: tr('med|All levels'), attrs: { 'data-autosubmit': '' } })}
      ${ui.btn(esc(tr('med|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    const body = `${tabs('/admin/media/calendar')}${filters}
${ui.card(view === 'weeks' ? tr('med|Thirteen weeks') : tr('med|Availability'), items.length ? `${grid}${view === 'days' ? legend() : ''}` : ui.empty(tr('med|No spaces match.')), { action: nav, cls: 'med-calcard', sub: esc(view === 'weeks' ? tr('med|Share of each week sold or held, slots included.') : tr('med|Each bar is a placement. On a screen, several advertisers share the loop. Click a free day to quote it.')) })}`;
    h.page(req, res, { title: tr('med|Calendar'), crumbs: crumbs([null, tr('med|Calendar')]), active: '/admin/media', wide: true, body, actions: quoteBtn(req) });
  });

  // ---------- inventory ----------
  router.get('/media/inventory', (req, res) => {
    const t = today();
    const type = TYPES[req.query.type] ? req.query.type : '';
    const status = ITEM_STATUS[req.query.status] ? req.query.status : '';
    const f = h.listFilters(req, {
      cols: { date: 'i.created_at' }, dateLabel: tr('sort|Added'),
      sorts: [['default', 'sort|Plan order', 'i.sort, i.code'], ['code', 'sort|Code', 'i.code'], ['rate_desc', 'sort|Day rate: highest first', 'i.rate_day DESC'], ['rate_asc', 'sort|Day rate: lowest first', 'i.rate_day ASC'],
        ['newest', 'sort|Newest first', 'i.created_at DESC, i.id DESC'], ['oldest', 'sort|Oldest first', 'i.created_at ASC, i.id ASC']],
    });
    const items = db.all(`SELECT i.*, u.code unit_code FROM media_items i LEFT JOIN units u ON u.id = i.unit_id WHERE 1 = 1${type ? ' AND i.type = ?' : ''}${status ? ' AND i.status = ?' : " AND i.status != 'retired'"}${f.sql} ORDER BY ${f.order}`, ...[type, status].filter(Boolean), ...f.args);
    const next30 = addDays(t, 29);
    const sold = taking(t, next30);
    const rate = (v) => (v ? ui.money(v, { cur: false }) : '—');
    const table = ui.table([
      { label: tr('med|Space'), render: (i) => `<span class="med-item">${thumb(i)}<span><b><bdi>${esc(i.code)}</bdi> · ${esc(nm(i))}</b><small class="sub">${esc([tr(TYPES[i.type]), where(i)].filter(Boolean).join(' · '))}</small></span></span>`, sort: (i) => i.code },
      { label: tr('med|Size'), render: (i) => esc([size(i), loop(i)].filter(Boolean).join(' · ') || '—') },
      { label: tr('med|Per day'), num: true, render: (i) => rate(i.rate_day), sort: (i) => i.rate_day || 0 },
      { label: tr('med|Per week'), num: true, render: (i) => rate(i.rate_week), sort: (i) => i.rate_week || 0 },
      { label: tr('med|Per month'), num: true, render: (i) => rate(i.rate_month), sort: (i) => i.rate_month || 0 },
      { label: tr('med|Passing a day'), num: true, render: (i) => (passing(i) ? ui.n0(passing(i)) : '—'), sort: (i) => passing(i) || 0 },
      { label: tr('med|Next 30 days'), render: (i) => { const f = Math.min(1, sold.filter((l) => l.item_id === i.id).reduce((s, l) => s + l.slots * overlap(l.start_date, l.end_date, t, next30), 0) / (capOf(i) * 30)); return `${ui.meter(f, f > 0.85 ? 'cocoa' : 'forest')}<small class="sub">${ui.pct(f)}</small>`; } },
      { label: tr('med|Status'), render: (i) => ui.badge(`it_${i.status}`, tr(ITEM_STATUS[i.status]), ITEM_TONE[i.status]) },
    ], items, { empty: esc(tr('med|No advertising spaces yet.')), href: (i) => `/admin/media/inventory/${i.id}`, cls: 'med-inv' });
    const filters = `<form method="get" action="/admin/media/inventory" class="filters med-filters">
      ${ui.select('type', tr('Type'), types(), type, { blank: tr('med|All types'), attrs: { 'data-autosubmit': '' } })}
      ${ui.select('status', tr('med|Status'), tmap(ITEM_STATUS), status, { blank: tr('med|On sale and in maintenance'), attrs: { 'data-autosubmit': '' } })}
      ${f.fields}
      ${ui.btn(esc(tr('med|Show')), { cls: 'btn--ghost btn--sm' })}${f.quick}</form>`;
    const byType = Object.keys(TYPES).map((k) => ({ k, n: items.filter((i) => i.type === k).length })).filter((x) => x.n);
    const body = `${tabs('/admin/media/inventory')}${filters}
${ui.card(tn(items.length, 'med|{n} advertising space', 'med|{n} advertising spaces'), table, { sub: esc(`${byType.map((x) => `${tr(TYPES[x.k])}: ${x.n}`).join(' · ')}${dailyVisitors() ? ` · ${tr('med|about {n} visitors a day', { n: ui.n0(dailyVisitors()) })}` : ''}`) })}`;
    h.page(req, res, {
      title: tr('med|Inventory'), crumbs: crumbs([null, tr('med|Inventory')]), active: '/admin/media', wide: true, body,
      actions: h.can(req, 'manager') ? ui.btn(esc(tr('med|Add a space')), { href: '/admin/media/inventory/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  function itemForm(req, i = {}) {
    const v = (k, d = '') => (i[k] !== undefined && i[k] !== null ? i[k] : d);
    const units = db.all("SELECT id, code FROM units WHERE status != 'retired' ORDER BY sort, code").map((u) => [u.id, u.code]);
    return ui.form(i.id ? `/admin/media/inventory/${i.id}` : '/admin/media/inventory', req.session.csrf, `
      <fieldset><legend>${esc(tr('med|The space'))}</legend><div class="fields">
        ${ui.input('code', tr('med|Code'), v('code'), { required: true, placeholder: tr('med|e.g. DS-G-01') })}
        ${ui.select('type', tr('Type'), types(), v('type', 'screen'))}
        ${ui.input('name', tr('med|Name (English)'), v('name'), { required: true, placeholder: tr('med|e.g. Main atrium screen') })}
        ${ui.input('name_ar', tr('med|Name (Arabic)'), v('name_ar'), { attrs: { dir: 'rtl', lang: 'ar' } })}
        ${ui.select('level', tr('Level'), tmap(LEVELS), v('level', 'ground'))}
        ${ui.input('location', tr('med|Where (English)'), v('location'), { placeholder: tr('med|e.g. Facing the north entrance') })}
        ${ui.input('location_ar', tr('med|Where (Arabic)'), v('location_ar'), { attrs: { dir: 'rtl', lang: 'ar' } })}
        ${ui.select('unit_id', tr('med|Next to unit'), units, v('unit_id'), { blank: tr('med|None') })}
        ${ui.input('plan_pos', tr('med|Position on the plan'), v('plan_pos'), { placeholder: tr('med|e.g. Grid C4, column 12') })}
        ${ui.select('status', tr('med|Status'), tmap(ITEM_STATUS), v('status', 'active'))}
      </div></fieldset>
      <fieldset><legend>${esc(tr('med|Size and specification'))}</legend><div class="fields">
        ${ui.input('width_m', tr('med|Width (m)'), v('width_m'), { type: 'number', min: 0, step: '0.01' })}
        ${ui.input('height_m', tr('med|Height (m)'), v('height_m'), { type: 'number', min: 0, step: '0.01' })}
        ${ui.input('area_m2', tr('med|Floor area (m²)'), v('area_m2'), { type: 'number', min: 0, step: '0.1', hint: tr('med|For zones, stands and car spots') })}
        ${ui.input('slots', tr('med|Advertisers in the loop'), v('slots', 1), { type: 'number', min: 1, max: 30, step: 1, hint: tr('med|1 for a space sold whole') })}
        ${ui.input('slot_seconds', tr('med|Seconds per slot'), v('slot_seconds'), { type: 'number', min: 1, max: 600, step: 1 })}
        ${ui.input('exposure_pct', tr('med|Visitors passing (%)'), v('exposure_pct'), { type: 'number', min: 0, max: 100, step: '0.1', hint: tr('med|Share of the mall\'s visitors who pass it') })}
        ${ui.textarea('specs', tr('med|Specification'), v('specs'), { rows: 3, cls: 'span-all', placeholder: tr('med|Resolution, file format, material, fixing, power') })}
      </div></fieldset>
      <fieldset><legend>${esc(tr('med|Rate card'))}</legend><div class="fields">
        ${ui.input('rate_day', tr('med|Per day'), v('rate_day'), { type: 'number', min: 0, step: 1, hint: tr('med|Per slot on a screen') })}
        ${ui.input('rate_week', tr('med|Per week'), v('rate_week'), { type: 'number', min: 0, step: 1 })}
        ${ui.input('rate_month', tr('med|Per month'), v('rate_month'), { type: 'number', min: 0, step: 1 })}
        ${ui.input('min_days', tr('med|Minimum days'), v('min_days', 1), { type: 'number', min: 1, max: 365, step: 1 })}
        ${ui.textarea('notes', tr('Notes'), v('notes'), { rows: 2, cls: 'span-all' })}
      </div></fieldset>
      ${ui.btn(esc(i.id ? tr('Save changes') : tr('med|Add the space')), { cls: 'btn--primary' })}`, { cls: 'form stack' });
  }
  function readItem(req) {
    const b = req.body;
    const n = (k) => { const x = h.numv(b[k]); return x === null || x < 0 ? null : x; };
    const type = TYPES[b.type] ? b.type : 'screen';
    const slots = Math.max(1, Math.min(30, h.int(b.slots) || 1));
    const secs = h.int(b.slot_seconds) || (slots > 1 ? 10 : null);
    const unit = h.int(b.unit_id);
    return {
      code: h.str(b.code, 20).toUpperCase(), name: h.str(b.name, 120), name_ar: h.str(b.name_ar, 120) || null, type, level: LEVELS[b.level] ? b.level : null,
      location: h.str(b.location, 160) || null, location_ar: h.str(b.location_ar, 160) || null, unit_id: unit && db.get('SELECT id FROM units WHERE id = ?', unit) ? unit : null,
      plan_pos: h.str(b.plan_pos, 80) || null, width_m: n('width_m'), height_m: n('height_m'), area_m2: n('area_m2'), specs: h.str(b.specs, 1000) || null,
      slots, slot_seconds: secs, loop_seconds: secs ? secs * slots : null, rate_day: n('rate_day'), rate_week: n('rate_week'), rate_month: n('rate_month'),
      min_days: Math.max(1, Math.min(365, h.int(b.min_days) || 1)), exposure_pct: n('exposure_pct') === null ? null : Math.min(100, n('exposure_pct')),
      status: ITEM_STATUS[b.status] ? b.status : 'active', notes: h.str(b.notes, 1000) || null,
    };
  }
  const ITEM_COLS = ['code', 'name', 'name_ar', 'type', 'level', 'location', 'location_ar', 'unit_id', 'plan_pos', 'width_m', 'height_m', 'area_m2', 'specs', 'slots', 'slot_seconds', 'loop_seconds', 'rate_day', 'rate_week', 'rate_month', 'min_days', 'exposure_pct', 'status', 'notes'];
  router.get('/media/inventory/new', R('manager'), (req, res) => {
    h.page(req, res, { title: tr('med|Add a space'), crumbs: crumbs(['/admin/media/inventory', tr('med|Inventory')], [null, tr('med|New')]), active: '/admin/media', body: ui.card(tr('med|Add a space'), itemForm(req)) });
  });
  router.post('/media/inventory', R('manager'), (req, res) => {
    const i = readItem(req);
    if (!i.code || !i.name) return h.back(req, res, '/admin/media/inventory/new', 'error', tr('med|Give the space a code and a name.'));
    if (db.get('SELECT id FROM media_items WHERE code = ?', i.code)) return h.back(req, res, '/admin/media/inventory/new', 'error', tr('med|{code} is already used.', { code: i.code }));
    const r = db.run(`INSERT INTO media_items (${ITEM_COLS.join(', ')}, sort, created_at, updated_at) VALUES (${ITEM_COLS.map(() => '?').join(', ')}, ?, ?, ?)`,
      ...ITEM_COLS.map((k) => i[k]), (db.value('SELECT MAX(sort) FROM media_items') || 0) + 1, M.now(), M.now());
    h.log(req, 'Added an advertising space', 'media_item', Number(r.lastInsertRowid), i.code);
    h.back(req, res, `/admin/media/inventory/${r.lastInsertRowid}`, 'ok', tr('med|{code} added.', { code: i.code }));
  });
  router.post('/media/inventory/:id', R('manager'), (req, res, next) => {
    const old = itemOf(h.int(req.params.id));
    if (!old) return next();
    const i = readItem(req);
    const back = `/admin/media/inventory/${old.id}`;
    if (!i.code || !i.name) return h.back(req, res, back, 'error', tr('med|Give the space a code and a name.'));
    if (db.get('SELECT id FROM media_items WHERE code = ? AND id != ?', i.code, old.id)) return h.back(req, res, back, 'error', tr('med|{code} is already used.', { code: i.code }));
    // fewer slots than already sold on a future day is refused
    if (i.slots < capOf(old)) {
      const t = today();
      const future = taking(t, addDays(t, 400), { itemId: old.id });
      const bad = conflicts(future, { id: old.id, slots: i.slots }, t, addDays(t, 400), 0).filter((d) => d.used > i.slots);
      if (bad.length) return h.back(req, res, back, 'error', tr('med|{n} slots are already sold on {date}. Move those campaigns first.', { n: bad[0].used, date: ui.date(bad[0].date) }));
    }
    db.run(`UPDATE media_items SET ${ITEM_COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...ITEM_COLS.map((k) => i[k]), M.now(), old.id);
    h.log(req, 'Edited an advertising space', 'media_item', old.id, i.code);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  router.get('/media/inventory/:id', (req, res, next) => {
    sweep();
    const i = db.get('SELECT i.*, u.code unit_code FROM media_items i LEFT JOIN units u ON u.id = i.unit_id WHERE i.id = ?', h.int(req.params.id));
    if (!i) return next();
    const t = today();
    const lines = db.all(`SELECT l.*, c.ref, c.status, c.title, ${PARTY} FROM media_lines l JOIN media_campaigns c ON c.id = l.campaign_id ${JOINS}
      WHERE l.item_id = ? AND c.status != 'cancelled' ORDER BY l.start_date DESC LIMIT 40`, i.id);
    const ytd = bookedLines(`${t.slice(0, 4)}-01-01`, `${t.slice(0, 4)}-12-31`).filter((l) => l.item_id === i.id).reduce((s, l) => s + share(l, `${t.slice(0, 4)}-01-01`, `${t.slice(0, 4)}-12-31`), 0);
    const st = sellThrough(`${t.slice(0, 7)}-01`, monthEnd(t.slice(0, 7)), [i]);
    const sea = seasons();
    const ex = [7, 30].map((n) => ({ n, q: priceLine(i, t, addDays(t, n - 1), { seasons: sea }) }));
    const photos = db.all("SELECT id, title FROM documents WHERE entity = 'media_item' AND entity_id = ? AND kind = 'media_photo' AND mime LIKE 'image/%' AND archived = 0 ORDER BY id DESC LIMIT 6", i.id);
    const gallery = photos.length
      ? `<div class="med-gallery">${photos.map((p) => `<a href="/admin/documents/${p.id}/file" target="_blank" rel="noopener"><img src="/admin/documents/${p.id}/file" alt="${esc(p.title || i.code)}" loading="lazy"></a>`).join('')}</div>`
      : `<div class="med-gallery med-gallery--empty">${thumb(i, 'med-thumb--lg')}<p class="muted small">${esc(tr('med|Add a photo below: it goes on the proposal.'))}</p></div>`;
    const pass = passing(i);
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('Type'))}</dt><dd>${esc(tr(TYPES[i.type]))}</dd></div>
      <div><dt>${esc(tr('med|Where'))}</dt><dd>${esc(where(i) || '—')}${i.unit_code ? ` · ${esc(tr('med|by unit {code}', { code: i.unit_code }))}` : ''}${i.plan_pos ? `<small class="sub">${esc(i.plan_pos)}</small>` : ''}</dd></div>
      <div><dt>${esc(tr('med|Size'))}</dt><dd>${esc(size(i) || '—')}</dd></div>
      ${capOf(i) > 1 ? `<div><dt>${esc(tr('med|Loop'))}</dt><dd>${esc(loop(i))}${i.loop_seconds ? ` · ${esc(tr('med|{s} s loop', { s: i.loop_seconds }))}` : ''}</dd></div>` : ''}
      <div><dt>${esc(tr('med|Rate card'))}</dt><dd>${esc([i.rate_day ? tr('med|{amount} a day', { amount: ui.money(i.rate_day) }) : null, i.rate_week ? tr('med|{amount} a week', { amount: ui.money(i.rate_week) }) : null, i.rate_month ? tr('med|{amount} a month', { amount: ui.money(i.rate_month) }) : null].filter(Boolean).join(' · ') || tr('med|Not set'))}${capOf(i) > 1 ? `<small class="sub">${esc(tr('med|per slot'))}</small>` : ''}</dd></div>
      <div><dt>${esc(tr('med|Minimum'))}</dt><dd>${esc(tn(i.min_days, 'med|{n} day', 'med|{n} days'))}</dd></div>
      <div><dt>${esc(tr('med|Audience'))}</dt><dd>${pass ? esc(tr('med|about {n} people pass it a day', { n: ui.n0(pass) })) : '—'}${i.exposure_pct ? `<small class="sub">${esc(tr('med|{pct}% of the mall\'s visitors', { pct: ui.n0(i.exposure_pct) }))}</small>` : ''}</dd></div>
      ${ex.map(({ n, q }) => `<div><dt>${esc(tr('med|{n} days from today', { n }))}</dt><dd>${q.error ? '—' : `${ui.money(q.list)}${q.seasonDays ? ` <small class="muted">${esc(tr('med|includes peak days'))}</small>` : ''}`}</dd></div>`).join('')}
      ${i.specs ? `<div><dt>${esc(tr('med|Specification'))}</dt><dd>${esc(i.specs)}</dd></div>` : ''}
      ${i.notes ? `<div><dt>${esc(tr('Notes'))}</dt><dd>${esc(i.notes)}</dd></div>` : ''}
    </dl>`;
    const list = lines.length
      ? `<ul class="list">${lines.map((l) => `<li><a href="/admin/media/campaigns/${l.campaign_id}"><span class="what"><b>${esc(party(l))} · ${esc(l.title)}</b><small><bdi>${esc(l.ref)}</bdi> · ${ui.date(l.start_date)} – ${ui.date(l.end_date)}${capOf(i) > 1 ? ` · ${l.slots}/${capOf(i)}` : ''} · ${ui.money(l.price, { compact: true })}</small></span>${badge(l.status)}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${esc(tr('med|Not booked yet.'))}</p>`;
    const kpis = [
      ui.kpi({ label: tr('med|Booked this year'), value: ui.money(ytd, { compact: true }) }),
      ui.kpi({ label: tr('med|Sell-through this month'), value: ui.pct(st), bar: st }),
      ui.kpi({ label: tr('med|Passing a day'), value: pass ? ui.n0(pass) : '—' }),
    ].join('');
    const body = `<div class="kpis kpis--3">${kpis}</div>
${ui.card(tr('med|The next six weeks'), calendar([i], t, addDays(t, 41), { book: h.can(req, 'agent') && i.status === 'active' }))}
<div class="grid grid--side">
  <div class="stack">${ui.card(tr('med|Bookings'), list)}${panel(req, 'media_item', i.id, { title: tr('med|Photos and specifications') })}</div>
  <div class="stack">${ui.card(tr('med|Details'), `${gallery}${facts}`)}${h.can(req, 'manager') ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${esc(tr('med|Edit the space and its rates'))}</span></summary>${itemForm(req, i)}</details>` : ''}</div>
</div>`;
    h.page(req, res, {
      title: `${i.code} · ${nm(i)}`, crumbs: crumbs(['/admin/media/inventory', tr('med|Inventory')], [null, i.code]), active: '/admin/media', body,
      actions: h.can(req, 'agent') && i.status === 'active' ? ui.btn(esc(tr('med|Quote this space')), { href: `/admin/media/quote?item=${i.id}`, cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  // ---------- rates, seasons, discounts, settings ----------
  router.get('/media/rates', (req, res) => {
    const mgr = h.can(req, 'manager');
    const csrf = req.session.csrf;
    const items = db.all("SELECT * FROM media_items WHERE status != 'retired' ORDER BY type, sort, code");
    const rate = (v) => (v ? ui.money(v, { cur: false }) : '—');
    const perDay = (i) => {
      const w = i.rate_week ? i.rate_week / 7 : null;
      const m = i.rate_month ? i.rate_month / 30 : null;
      return i.rate_day && (m || w) ? 1 - (m || w) / i.rate_day : null;
    };
    const table = ui.table([
      { label: tr('med|Space'), render: (i) => `<b><bdi>${esc(i.code)}</bdi> · ${esc(nm(i))}</b><small class="sub">${esc([tr(TYPES[i.type]), loop(i)].filter(Boolean).join(' · '))}</small>` },
      { label: tr('med|Per day'), num: true, render: (i) => rate(i.rate_day) },
      { label: tr('med|Per week'), num: true, render: (i) => rate(i.rate_week) },
      { label: tr('med|Per month'), num: true, render: (i) => rate(i.rate_month) },
      { label: tr('med|Long booking saves'), num: true, render: (i) => (perDay(i) !== null && perDay(i) > 0 ? ui.pct(perDay(i)) : '—') },
      { label: tr('med|Minimum'), render: (i) => esc(tn(i.min_days, 'med|{n} day', 'med|{n} days')) },
    ], items, { empty: esc(tr('med|No advertising spaces yet.')), href: (i) => `/admin/media/inventory/${i.id}` });
    const sea = seasons();
    const t = today();
    const del = (url, q) => (mgr ? ui.form(url, csrf, `<button class="iconbtn" title="${esc(tr('Remove'))}" aria-label="${esc(tr('Remove'))}" data-confirm="${esc(q)}">×</button>`) : '');
    const seaList = `${sea.length ? `<ul class="list">${sea.map((s) => `<li><span class="what"><b>${esc(nm(s))} · ${s.pct >= 0 ? '+' : ''}${ui.n0(s.pct)}%</b><small>${ui.date(s.start_date)} – ${ui.date(s.end_date)}${s.start_date <= t && s.end_date >= t ? ` · ${esc(tr('med|on now'))}` : ''}</small></span>${del(`/admin/media/seasons/${s.id}/delete`, tr('med|Remove this season?'))}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('med|No seasons yet.'))}</p>`}
      ${mgr ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${esc(tr('med|Add a season'))}</span></summary>${ui.form('/admin/media/seasons', csrf, `<div class="fields">${ui.input('name', tr('med|Name (English)'), '', { required: true, placeholder: tr('med|e.g. Ramadan') })}${ui.input('name_ar', tr('med|Name (Arabic)'), '', { attrs: { dir: 'rtl', lang: 'ar' } })}${ui.input('start_date', tr('med|From'), '', { type: 'date', required: true })}${ui.input('end_date', tr('med|To'), '', { type: 'date', required: true })}${ui.input('pct', tr('med|Price change (%)'), 25, { type: 'number', min: -50, max: 300, step: 1, required: true, hint: tr('med|Negative for a quiet season') })}</div>${ui.btn(esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}`;
    const ti = tiers();
    const tierLabel = (x) => (x.kind === 'volume' ? tn(x.threshold, 'med|{n} placement or more', 'med|{n} placements or more') : tn(x.threshold, 'med|{n} day or longer', 'med|{n} days or longer'));
    const tierList = `${ti.length ? `<ul class="list">${ti.map((x) => `<li><span class="what"><b>${esc(tr(TIER_KINDS[x.kind]))} · −${ui.n0(x.pct)}%</b><small>${esc(tierLabel(x))}</small></span>${del(`/admin/media/tiers/${x.id}/delete`, tr('med|Remove this discount?'))}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('med|No discounts yet.'))}</p>`}
      ${mgr ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${esc(tr('med|Add a discount'))}</span></summary>${ui.form('/admin/media/tiers', csrf, `<div class="fields">${ui.select('kind', tr('Type'), tmap(TIER_KINDS), 'duration')}${ui.input('threshold', tr('med|From (days or placements)'), 28, { type: 'number', min: 1, max: 400, step: 1, required: true })}${ui.input('pct', tr('med|Discount (%)'), 10, { type: 'number', min: 1, max: 90, step: '0.5', required: true })}</div>${ui.btn(esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}`;
    const settings = mgr ? ui.form('/admin/media/settings', csrf, `<div class="fields">
      ${ui.input('hold_days', tr('med|A hold lasts (days)'), holdDays(), { type: 'number', min: 1, max: 60, step: 1 })}
      ${ui.input('free_discount', tr('med|Extra discount without approval (%)'), freePct(), { type: 'number', min: 0, max: 90, step: '0.5', hint: tr('med|Above this, a manager approves') })}
      ${ui.input('artwork_days', tr('med|Artwork due before the start (days)'), artDays(), { type: 'number', min: 0, max: 60, step: 1 })}
      ${ui.input('daily_visitors', tr('med|Visitors a day, without footfall counts'), db.setting('media_daily_visitors') || '', { type: 'number', min: 0, step: 100 })}
      </div>${ui.btn(esc(tr('Save changes')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : `<dl class="dl"><div><dt>${esc(tr('med|A hold lasts'))}</dt><dd>${esc(tn(holdDays(), 'med|{n} day', 'med|{n} days'))}</dd></div><div><dt>${esc(tr('med|Extra discount without approval'))}</dt><dd>${ui.n0(freePct())}%</dd></div></dl>`;
    const body = `${tabs('/admin/media/rates')}<div class="grid grid--side">
  ${ui.card(tr('med|Rate card'), table, { sub: esc(tr('med|Before VAT. Screens are priced per slot in the loop. A week or a month costs less per day.')) })}
  <div class="stack">
    ${ui.card(tr('med|Seasons'), seaList, { sub: esc(tr('med|Days in a season cost more (or less). A day in two seasons takes the higher.')) })}
    ${ui.card(tr('med|Discounts'), tierList, { sub: esc(tr('med|Duration: for each placement booked that long. Volume: on the whole campaign, by the number of spaces.')) })}
    ${ui.card(tr('med|Rules'), settings)}
  </div>
</div>`;
    h.page(req, res, { title: tr('med|Rates and seasons'), crumbs: crumbs([null, tr('med|Rates and seasons')]), active: '/admin/media', wide: true, body });
  });
  router.post('/media/seasons', R('manager'), (req, res) => {
    const name = h.str(req.body.name, 80);
    const a = req.body.start_date;
    const b = req.body.end_date;
    const pct = h.numv(req.body.pct);
    if (!name || !isDate(a) || !isDate(b) || b < a || pct === null || pct < -50 || pct > 300) return h.back(req, res, '/admin/media/rates', 'error', tr('med|Give the season a name, dates and a price change.'));
    const r = db.run('INSERT INTO media_seasons (name, name_ar, start_date, end_date, pct, created_at) VALUES (?, ?, ?, ?, ?, ?)', name, h.str(req.body.name_ar, 80) || null, a, b, pct, M.now());
    h.log(req, 'Added a media season', 'media_season', Number(r.lastInsertRowid), `${name} · ${pct}%`);
    h.back(req, res, '/admin/media/rates', 'ok', tr('Saved.'));
  });
  router.post('/media/seasons/:id/delete', R('manager'), (req, res) => {
    db.run('DELETE FROM media_seasons WHERE id = ?', h.int(req.params.id));
    h.log(req, 'Removed a media season', 'media_season', h.int(req.params.id));
    h.back(req, res, '/admin/media/rates', 'ok', tr('med|Season removed.'));
  });
  router.post('/media/tiers', R('manager'), (req, res) => {
    const kind = TIER_KINDS[req.body.kind] ? req.body.kind : 'duration';
    const threshold = h.int(req.body.threshold);
    const pct = h.numv(req.body.pct);
    if (!threshold || threshold < 1 || pct === null || pct <= 0 || pct > 90) return h.back(req, res, '/admin/media/rates', 'error', tr('med|Give the discount a threshold and a percentage.'));
    const r = db.run('INSERT INTO media_tiers (kind, threshold, pct, created_at) VALUES (?, ?, ?, ?)', kind, threshold, pct, M.now());
    h.log(req, 'Added a media discount', 'media_tier', Number(r.lastInsertRowid), `${kind} ${threshold} · ${pct}%`);
    h.back(req, res, '/admin/media/rates', 'ok', tr('Saved.'));
  });
  router.post('/media/tiers/:id/delete', R('manager'), (req, res) => {
    db.run('DELETE FROM media_tiers WHERE id = ?', h.int(req.params.id));
    h.log(req, 'Removed a media discount', 'media_tier', h.int(req.params.id));
    h.back(req, res, '/admin/media/rates', 'ok', tr('med|Discount removed.'));
  });
  router.post('/media/settings', R('manager'), (req, res) => {
    const b = req.body;
    const clamp = (v, lo, hi, d) => { const x = h.numv(v); return x === null ? d : Math.max(lo, Math.min(hi, x)); };
    db.setSetting('media_hold_days', String(Math.round(clamp(b.hold_days, 1, 60, 5))));
    db.setSetting('media_free_discount', String(clamp(b.free_discount, 0, 90, 10)));
    db.setSetting('media_artwork_days', String(Math.round(clamp(b.artwork_days, 0, 60, 5))));
    const v = h.int(b.daily_visitors);
    db.setSetting('media_daily_visitors', v && v > 0 ? String(v) : '');
    visitorsCache = { at: 0, v: null };
    h.log(req, 'Changed the media sales rules', 'settings', null);
    h.back(req, res, '/admin/media/rates', 'ok', tr('Saved.'));
  });

  // ---------- advertisers (outside the tenants: agencies and companies) ----------
  router.get('/media/clients', (req, res) => {
    const t = today();
    const f = h.listFilters(req, {
      cols: { date: 'k.created_at' }, dateLabel: tr('sort|Added'),
      sorts: [['name', 'sort|Name: A to Z', 'k.name'], ['name_desc', 'sort|Name: Z to A', 'k.name DESC'], ['amount_desc', 'sort|Spend: highest first', 'spend DESC, k.name'], ['busy', 'sort|Most campaigns first', 'n DESC, k.name'],
        ['newest', 'sort|Newest first', 'k.created_at DESC, k.id DESC'], ['oldest', 'sort|Oldest first', 'k.created_at ASC, k.id ASC']],
    });
    const clients = db.all(`SELECT k.*, (SELECT COUNT(*) FROM media_campaigns c WHERE c.client_id = k.id AND c.status != 'cancelled') n,
      (SELECT COALESCE(SUM(total), 0) FROM media_campaigns c WHERE c.client_id = k.id AND c.status IN ('confirmed','live','ended') AND substr(c.start_date, 1, 4) = ?) spend FROM media_clients k${f.where.length ? ` WHERE ${f.where.join(' AND ')}` : ''} ORDER BY ${f.order}`, t.slice(0, 4), ...f.args);
    const brands = db.all(`SELECT b.id, b.name, COUNT(c.id) n, COALESCE(SUM(CASE WHEN c.status IN ('confirmed','live','ended') AND substr(c.start_date, 1, 4) = ? THEN c.total END), 0) spend
      FROM brands b JOIN media_campaigns c ON c.brand_id = b.id WHERE c.status != 'cancelled' GROUP BY b.id ORDER BY spend DESC`, t.slice(0, 4));
    const table = ui.table([
      { label: tr('med|Advertiser'), render: (k) => `<b>${esc(k.name)}</b><small class="sub">${esc(tr(CLIENT_KINDS[k.kind] || CLIENT_KINDS.company))}${k.contact_name ? ` · ${esc(k.contact_name)}` : ''}</small>` },
      { label: tr('med|Contact'), render: (k) => esc([k.phone, k.email].filter(Boolean).join(' · ') || '—') },
      { label: tr('med|Campaigns'), num: true, render: (k) => ui.n0(k.n) },
      { label: tr('med|This year'), num: true, render: (k) => ui.money(k.spend, { compact: true }), sort: (k) => k.spend },
    ], clients, { empty: esc(tr('med|No outside advertisers yet.')), href: (k) => `/admin/media/clients/${k.id}` });
    const brandTable = ui.table([
      { label: tr('med|Tenant brand'), render: (b) => `<b>${esc(b.name)}</b>` },
      { label: tr('med|Campaigns'), num: true, render: (b) => ui.n0(b.n) },
      { label: tr('med|This year'), num: true, render: (b) => ui.money(b.spend, { compact: true }) },
    ], brands, { empty: esc(tr('med|No tenant has advertised yet.')), href: (b) => `/admin/tenants/${b.id}` });
    const body = `${tabs('/admin/media/clients')}${f.html}<div class="grid grid--side">
  ${ui.card(tr('med|Agencies and companies'), table)}
  <div class="stack">${h.can(req, 'agent') ? ui.card(tr('med|Add an advertiser'), clientForm(req)) : ''}${ui.card(tr('med|Tenants who advertise'), brandTable)}</div>
</div>`;
    h.page(req, res, { title: tr('med|Advertisers'), crumbs: crumbs([null, tr('med|Advertisers')]), active: '/admin/media', wide: true, body });
  });
  function clientForm(req, k = {}) {
    const v = (x) => (k[x] !== undefined && k[x] !== null ? k[x] : '');
    return ui.form(k.id ? `/admin/media/clients/${k.id}` : '/admin/media/clients', req.session.csrf, `<div class="fields">
      ${ui.input('name', tr('Name'), v('name'), { required: true, placeholder: tr('med|e.g. Nile Telecom') })}
      ${ui.select('kind', tr('Type'), tmap(CLIENT_KINDS), v('kind') || 'company')}
      ${ui.input('contact_name', tr('med|Contact person'), v('contact_name'))}
      ${ui.input('phone', tr('med|Phone'), v('phone'), { type: 'tel' })}
      ${ui.input('email', tr('med|Email'), v('email'), { type: 'email' })}
      ${ui.input('tax_id', tr('med|Tax number'), v('tax_id'))}
      ${ui.input('address', tr('med|Address'), v('address'), { cls: 'span-all' })}
      ${ui.textarea('notes', tr('Notes'), v('notes'), { rows: 2, cls: 'span-all' })}
    </div>${ui.btn(esc(k.id ? tr('Save changes') : tr('med|Add the advertiser')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' });
  }
  const readClient = (b) => ({
    name: h.str(b.name, 120), kind: CLIENT_KINDS[b.kind] ? b.kind : 'company', contact_name: h.str(b.contact_name, 120) || null, phone: h.str(b.phone, 40) || null,
    email: h.str(b.email, 160) || null, tax_id: h.str(b.tax_id, 40) || null, address: h.str(b.address, 240) || null, notes: h.str(b.notes, 1000) || null,
  });
  const insertClient = (k) => Number(db.run('INSERT INTO media_clients (name, kind, contact_name, phone, email, tax_id, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    k.name, k.kind, k.contact_name, k.phone, k.email, k.tax_id, k.address, k.notes, M.now(), M.now()).lastInsertRowid);
  router.post('/media/clients', R('agent'), (req, res) => {
    const k = readClient(req.body);
    if (!k.name) return h.back(req, res, '/admin/media/clients', 'error', tr('med|Give the advertiser a name.'));
    const id = insertClient(k);
    h.log(req, 'Added an advertiser', 'media_client', id, k.name);
    h.back(req, res, `/admin/media/clients/${id}`, 'ok', tr('Saved.'));
  });
  router.post('/media/clients/:id', R('agent'), (req, res, next) => {
    const old = db.get('SELECT * FROM media_clients WHERE id = ?', h.int(req.params.id));
    if (!old) return next();
    const k = readClient(req.body);
    if (!k.name) return h.back(req, res, `/admin/media/clients/${old.id}`, 'error', tr('med|Give the advertiser a name.'));
    db.run('UPDATE media_clients SET name = ?, kind = ?, contact_name = ?, phone = ?, email = ?, tax_id = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?',
      k.name, k.kind, k.contact_name, k.phone, k.email, k.tax_id, k.address, k.notes, M.now(), old.id);
    h.log(req, 'Edited an advertiser', 'media_client', old.id, k.name);
    h.back(req, res, `/admin/media/clients/${old.id}`, 'ok', tr('Saved.'));
  });
  router.get('/media/clients/:id', (req, res, next) => {
    const k = db.get('SELECT * FROM media_clients WHERE id = ?', h.int(req.params.id));
    if (!k) return next();
    const camps = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.client_id = ? ORDER BY c.start_date DESC`, k.id);
    const spend = camps.filter((c) => SOLD.includes(c.status)).reduce((s, c) => s + c.total, 0);
    const body = `<div class="kpis kpis--3">${ui.kpi({ label: tr('med|Campaigns'), value: ui.n0(camps.length) })}${ui.kpi({ label: tr('med|Sold to date'), value: ui.money(spend, { compact: true }) })}${ui.kpi({ label: tr('med|Live now'), value: ui.n0(camps.filter((c) => c.status === 'live').length) })}</div>
<div class="grid grid--side">
  ${ui.card(tr('med|Campaigns'), campaignTable(camps))}
  <div class="stack">${ui.card(tr('med|Details'), h.can(req, 'agent') ? clientForm(req, k) : `<dl class="dl"><div><dt>${esc(tr('med|Contact'))}</dt><dd>${esc([k.contact_name, k.phone, k.email].filter(Boolean).join(' · ') || '—')}</dd></div></dl>`)}</div>
</div>`;
    h.page(req, res, {
      title: k.name, crumbs: crumbs(['/admin/media/clients', tr('med|Advertisers')], [null, k.name]), active: '/admin/media', body,
      actions: h.can(req, 'agent') ? ui.btn(esc(tr('med|Build a quote')), { href: `/admin/media/quote?client=c:${k.id}`, cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  // ---------- campaigns ----------
  function campaignTable(rows) {
    return ui.table([
      { label: tr('med|Campaign'), render: (c) => `<b>${esc(c.title)}</b><small class="sub"><bdi>${esc(c.ref)}</bdi> · ${esc(party(c))}</small>`, sort: (c) => c.ref },
      { label: tr('med|Dates'), render: (c) => (c.start_date ? `${ui.date(c.start_date)} – ${ui.date(c.end_date)}` : '—'), sort: (c) => c.start_date || '' },
      { label: tr('med|Spaces'), num: true, render: (c) => ui.n0(c.n_lines || 0) },
      { label: tr('med|Total'), num: true, render: (c) => `${ui.money(c.total)}${c.discount_pct > 0.05 ? `<small class="sub">−${ui.n0(c.discount_pct)}%</small>` : ''}`, sort: (c) => c.total },
      { label: tr('med|Artwork'), render: (c) => (['proposal', 'cancelled'].includes(c.status) ? '—' : artBadge(c.artwork_status)) },
      { label: tr('med|Status'), render: (c) => `${badge(c.status)}${c.approval_state === 'pending' ? ` ${ui.badge('pending', tr('med|Approval'), 'amber')}` : ''}` },
    ], rows, { empty: esc(tr('med|No campaigns here.')), href: (c) => `/admin/media/campaigns/${c.id}` });
  }
  router.get('/media/campaigns', (req, res) => {
    sweep();
    const status = STATUS[req.query.status] ? req.query.status : req.query.status === 'attention' ? 'attention' : '';
    const q = h.str(req.query.q, 80);
    const t = today();
    const cond = [];
    const args = [];
    if (status === 'attention') { cond.push("((c.status IN ('held','confirmed','live') AND c.artwork_status != 'approved' AND c.start_date <= ?) OR c.approval_state = 'pending')"); args.push(addDays(t, 7)); } else if (status) { cond.push('c.status = ?'); args.push(status); }
    if (q) { cond.push('(c.ref LIKE ? OR c.title LIKE ? OR b.name LIKE ? OR k.name LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
    const f = h.listFilters(req, {
      cols: { date: 'c.start_date' }, dateLabel: tr('sort|Starts'),
      sorts: [['default', 'sort|Live first', "CASE c.status WHEN 'live' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'held' THEN 2 WHEN 'proposal' THEN 3 ELSE 4 END, c.start_date DESC"],
        ['newest', 'sort|Start date: newest first', 'c.start_date DESC'], ['oldest', 'sort|Start date: oldest first', 'c.start_date ASC'], ['created', 'sort|Newest first', 'c.id DESC'],
        ['amount_desc', 'sort|Amount: highest first', 'c.total DESC'], ['amount_asc', 'sort|Amount: lowest first', 'c.total ASC'], ['name', 'sort|Name: A to Z', 'c.title COLLATE NOCASE']],
    });
    cond.push(...f.where); args.push(...f.args);
    const rows = db.all(`SELECT c.*, ${PARTY}, (SELECT COUNT(*) FROM media_lines l WHERE l.campaign_id = c.id) n_lines FROM media_campaigns c ${JOINS}
      ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY ${f.order}, c.id DESC LIMIT 300`, ...args);
    const fq = ['q', 'from', 'to', 'sort'].filter((x) => req.query[x]).map((x) => `${x}=${encodeURIComponent(req.query[x])}`).join('&');
    const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM media_campaigns GROUP BY status').map((r) => [r.status, r.n]));
    const pill = (s, label, n) => `<a class="tab${status === s ? ' is-on' : ''}" href="/admin/media/campaigns${s || fq ? `?${[s ? `status=${s}` : '', fq].filter(Boolean).join('&')}` : ''}">${esc(label)}${n ? ` <small>${ui.n0(n)}</small>` : ''}</a>`;
    const sub = `<nav class="tabs tabs--sub">${pill('', tr('med|All'), 0)}${pill('attention', tr('med|Needs attention'), 0)}${Object.keys(STATUS).map((s) => pill(s, tr(STATUS[s]), counts[s])).join('')}</nav>`;
    const search = `<form method="get" action="/admin/media/campaigns" class="filters med-filters">${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}${ui.input('q', tr('med|Search'), q, { placeholder: tr('med|Reference, title or advertiser') })}${f.fields}${ui.btn(esc(tr('med|Show')), { cls: 'btn--ghost btn--sm' })}<a class="btn btn--ghost btn--sm" href="/admin/media/reports.csv">${ui.icon('dl')}<span>${esc(tr('med|Export'))}</span></a>${f.quick}</form>`;
    const body = `${tabs('/admin/media/campaigns')}${sub}${search}${ui.card(tn(rows.length, 'med|{n} campaign', 'med|{n} campaigns'), campaignTable(rows))}`;
    h.page(req, res, { title: tr('med|Campaigns'), crumbs: crumbs([null, tr('med|Campaigns')]), active: '/admin/media', wide: true, body, actions: quoteBtn(req) });
  });

  // ---------- the quote builder ----------
  const clientOptions = (value) => {
    const brands = db.all("SELECT id, name FROM brands WHERE id IN (SELECT brand_id FROM leases WHERE status IN ('active','draft')) OR id IN (SELECT brand_id FROM media_campaigns WHERE brand_id IS NOT NULL) ORDER BY name");
    const clients = db.all('SELECT id, name, kind FROM media_clients ORDER BY name');
    const o = (v, l) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`;
    return `<option value="">${esc(tr('med|Choose the advertiser'))}</option>${clients.length ? `<optgroup label="${esc(tr('med|Agencies and companies'))}">${clients.map((k) => o(`c:${k.id}`, k.name)).join('')}</optgroup>` : ''}${brands.length ? `<optgroup label="${esc(tr('med|Tenant brands'))}">${brands.map((b) => o(`b:${b.id}`, b.name)).join('')}</optgroup>` : ''}<option value="new"${value === 'new' ? ' selected' : ''}>${esc(tr('med|A new advertiser…'))}</option>`;
  };
  // the builder's state from a query or a form
  function readQuote(src) {
    const t = today();
    const start = isDate(src.start) ? src.start : addDays(t, 7);
    let end = isDate(src.end) && src.end >= start ? src.end : addDays(start, 13);
    if (day(end) - day(start) > 365 * 86400000) end = addDays(start, 365);
    const ids = [...new Set([].concat(src.item || []).map((x) => h.int(x)).filter(Boolean))].slice(0, 60);
    const slots = Object.fromEntries(ids.map((id) => [id, Math.max(1, h.int(src[`slots_${id}`]) || 1)]));
    const extra = Math.max(0, Math.min(90, h.numv(src.extra) || 0));
    return { start, end, ids, slots, extra, client: String(src.client || ''), title: h.str(src.title, 160) };
  }
  function priceQuote(q) {
    const sea = seasons();
    const items = q.ids.map((id) => itemOf(id)).filter((i) => i && i.status === 'active');
    const lines = [];
    const errors = [];
    for (const i of items) {
      const p = priceLine(i, q.start, q.end, { seasons: sea, slots: q.slots[i.id] });
      if (p.error) { errors.push(tr(p.error, p.params)); continue; }
      lines.push({ item_id: i.id, code: i.code, name: i.name, name_ar: i.name_ar, type: i.type, cap: capOf(i), start_date: q.start, end_date: q.end, days: p.days, rate: p.rate, base: p.base, season_days: p.seasonDays, list: p.list, slots: p.slots, exposure_pct: i.exposure_pct });
    }
    return { lines, errors, ...priceCampaign(lines, { tiers: tiers(), extraPct: q.extra }) };
  }
  router.get('/media/quote', R('agent'), (req, res) => {
    sweep();
    const q = readQuote(req.query);
    const items = db.all("SELECT * FROM media_items WHERE status = 'active' ORDER BY type, sort, code");
    const busy = taking(q.start, q.end);
    // the slots still free on the busiest day of the range
    const freeOf = (i) => {
      const mine = busy.filter((l) => l.item_id === i.id);
      const worst = mine.length ? Math.max(0, ...daysOf(q.start, q.end).map((d) => mine.filter((l) => l.start_date <= d && l.end_date >= d).reduce((s, l) => s + l.slots, 0))) : 0;
      return capOf(i) - worst;
    };
    const p = priceQuote(q);
    const sea = seasons();
    const groups = Object.keys(TYPES).map((k) => [k, items.filter((i) => i.type === k)]).filter(([, l]) => l.length);
    const picker = groups.map(([k, list]) => `<fieldset class="med-pick"><legend>${esc(tr(TYPES[k]))}</legend>${list.map((i) => {
      const free = freeOf(i);
      const on = q.ids.includes(i.id);
      const pr = priceLine(i, q.start, q.end, { seasons: sea, slots: q.slots[i.id] || 1 });
      const avail = free <= 0 ? ui.badge('full', tr('med|Taken'), 'rose') : capOf(i) > 1 ? ui.badge('free', tr('med|{n} of {cap} slots free', { n: free, cap: capOf(i) }), free < capOf(i) ? 'amber' : 'ok') : ui.badge('free', tr('med|Free'), 'ok');
      return `<label class="med-pick__row${on ? ' is-on' : ''}${free <= 0 ? ' is-full' : ''}"><input type="checkbox" name="item" value="${i.id}"${on ? ' checked' : ''}>${thumb(i, 'med-thumb--sm')}<span class="med-pick__what"><b><bdi>${esc(i.code)}</bdi> · ${esc(nm(i))}</b><small>${esc([where(i), size(i), loop(i)].filter(Boolean).join(' · '))}</small></span>${capOf(i) > 1 ? `<span class="med-pick__slots">${ui.input(`slots_${i.id}`, tr('med|Slots'), q.slots[i.id] || 1, { type: 'number', min: 1, max: capOf(i), step: 1 })}</span>` : '<span class="med-pick__slots"></span>'}<span class="med-pick__p">${avail}<small${pr.error ? ` class="muted" title="${esc(tr(pr.error, pr.params))}"` : ''}>${pr.error ? esc(pr.params && pr.params.n ? tn(pr.params.n, 'med|min. {n} day', 'med|min. {n} days') : '—') : ui.money(pr.list)}</small></span></label>`;
    }).join('')}</fieldset>`).join('');
    const head = `<div class="fields med-qhead">
      <label class="f"><span class="f__l">${esc(tr('med|Advertiser'))}</span><select name="client">${clientOptions(q.client)}</select></label>
      ${ui.input('title', tr('med|Campaign title'), q.title, { placeholder: tr('med|e.g. Summer launch') })}
      ${ui.input('start', tr('med|From'), q.start, { type: 'date', required: true })}
      ${ui.input('end', tr('med|To'), q.end, { type: 'date', required: true })}
      ${ui.input('extra', tr('med|Extra discount (%)'), q.extra || '', { type: 'number', min: 0, max: 90, step: '0.5', hint: tr('med|Up to {pct}% without approval', { pct: ui.n0(freePct()) }) })}
    </div>`;
    const newClient = `<fieldset class="med-newclient"><legend>${esc(tr('med|A new advertiser'))}</legend><div class="fields">${ui.input('new_name', tr('Name'), h.str(req.query.new_name, 120))}${ui.select('new_kind', tr('Type'), tmap(CLIENT_KINDS), req.query.new_kind || 'company')}${ui.input('new_contact', tr('med|Contact person'), h.str(req.query.new_contact, 120))}${ui.input('new_phone', tr('med|Phone'), h.str(req.query.new_phone, 40), { type: 'tel' })}${ui.input('new_email', tr('med|Email'), h.str(req.query.new_email, 160), { type: 'email' })}</div></fieldset>`;
    const days = daysOf(q.start, q.end).length;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) for (const x of [].concat(v)) qs.append(k, x);
    const sumRows = p.lines.length ? `<ul class="med-ql">${p.lines.map((l) => `<li><span class="med-ql__what"><b><bdi>${esc(l.code)}</bdi> · ${esc(nm(l))}</b><small>${esc([tr(RATE[l.rate]), l.cap > 1 ? tr('med|{n} of {cap} slots', { n: l.slots, cap: l.cap }) : null, l.season_days ? tn(l.season_days, 'med|{n} peak day', 'med|{n} peak days') : null, l.duration_pct ? `−${ui.n0(l.duration_pct)}%` : null].filter(Boolean).join(' · '))}</small></span><span class="med-ql__p">${l.price < l.list - 0.5 ? `<s>${ui.money(l.list)}</s>` : ''}<b>${ui.money(l.price)}</b></span></li>`).join('')}</ul>
      <dl class="dl med-sum">
        <div><dt>${esc(tr('med|Rate card'))}</dt><dd>${ui.money(p.list)}</dd></div>
        ${p.durationOff ? `<div><dt>${esc(tr('med|Duration discount'))}</dt><dd>−${ui.money(p.durationOff)}</dd></div>` : ''}
        ${p.volumeOff ? `<div><dt>${esc(tr('med|Volume discount ({pct}%)', { pct: ui.n0(p.volumePct) }))}</dt><dd>−${ui.money(p.volumeOff)}</dd></div>` : ''}
        ${p.extraOff ? `<div><dt>${esc(tr('med|Extra discount ({pct}%)', { pct: ui.n0(p.extraPct) }))}</dt><dd>−${ui.money(p.extraOff)}</dd></div>` : ''}
        <div class="med-sum__total"><dt>${esc(tr('med|Total before VAT'))}</dt><dd>${ui.money(p.total)}</dd></div>
      </dl>
      ${needsApproval(p.extraPct, p.extraOff) ? `<p class="med-note med-note--warn">${esc(tr('med|This extra discount needs a manager\'s approval before the campaign is confirmed.'))}</p>` : ''}`
      : `<p class="muted pad">${esc(tr('med|Tick the spaces to price them.'))}</p>`;
    const clashing = p.lines.filter((l) => freeOf({ id: l.item_id, slots: l.cap }) < l.slots);
    // the save form lives outside the builder's form; its button sits in the quote card (form="…")
    const saveForm = p.lines.length ? ui.form('/admin/media/campaigns', req.session.csrf, [...qs.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join(''), { attrs: { id: 'med-save' } }) : '';
    const saveBtn = p.lines.length ? `${clashing.length ? `<p class="med-note med-note--warn">${esc(tr('med|Some spaces are taken on these dates: you can save the proposal, but not hold or confirm it until they are free.'))}</p>` : ''}${ui.btn(esc(tr('med|Save as a proposal')), { cls: 'btn--primary med-quote__go', ic: 'check', attrs: { form: 'med-save' } })}` : '';
    const body = `${tabs('')}<form method="get" action="/admin/media/quote" class="med-quote">
<div class="grid grid--side">
  <div class="stack">
    ${ui.card(tr('med|The campaign'), `${head}${q.client === 'new' ? newClient : ''}`, { sub: esc(tn(days, 'med|{n} day', 'med|{n} days')) })}
    ${ui.card(tr('med|Choose the spaces'), `${p.errors.length ? `<p class="med-note med-note--warn">${esc(p.errors.join(' · '))}</p>` : ''}${picker || ui.empty(tr('med|No spaces on sale.'))}`, { action: ui.btn(esc(tr('med|Price it')), { cls: 'btn--ghost btn--sm' }) })}
  </div>
  <div class="stack med-quote__side">
    ${ui.card(tr('med|The quote'), `${sumRows}<div class="row med-quote__acts">${ui.btn(esc(tr('med|Update the price')), { cls: 'btn--ghost btn--sm' })}</div>${saveBtn}`, { sub: esc(`${ui.date(q.start)} – ${ui.date(q.end)}`) })}
  </div>
</div></form>${saveForm}`;
    h.page(req, res, { title: tr('med|Build a quote'), crumbs: crumbs([null, tr('med|Build a quote')]), active: '/admin/media', wide: true, body });
  });

  // the advertiser from the builder: an existing client or brand, or a new client typed in
  function readParty(b) {
    const v = String(b.client || '');
    if (/^b:\d+$/.test(v) && db.get('SELECT id FROM brands WHERE id = ?', Number(v.slice(2)))) return { brand_id: Number(v.slice(2)), client_id: null };
    if (/^c:\d+$/.test(v) && db.get('SELECT id FROM media_clients WHERE id = ?', Number(v.slice(2)))) return { brand_id: null, client_id: Number(v.slice(2)) };
    if (v === 'new') {
      const name = h.str(b.new_name, 120);
      if (!name) return null;
      const existing = db.get('SELECT id FROM media_clients WHERE lower(name) = lower(?)', name);
      return { brand_id: null, client_id: existing ? existing.id : insertClient({ name, kind: CLIENT_KINDS[b.new_kind] ? b.new_kind : 'company', contact_name: h.str(b.new_contact, 120) || null, phone: h.str(b.new_phone, 40) || null, email: h.str(b.new_email, 160) || null, tax_id: null, address: null, notes: null }) };
    }
    return null;
  }
  router.post('/media/campaigns', R('agent'), (req, res) => {
    const q = readQuote(req.body);
    const back = `/admin/media/quote?${new URLSearchParams(Object.entries(req.body).filter(([k]) => k !== '_csrf').flatMap(([k, v]) => [].concat(v).map((x) => [k, x])))}`;
    const who = readParty(req.body);
    if (!who) return h.back(req, res, back, 'error', tr('med|Choose the advertiser (or type the new one\'s name).'));
    const p = priceQuote(q);
    if (!p.lines.length) return h.back(req, res, back, 'error', p.errors[0] || tr('med|Tick at least one space.'));
    const party0 = who.brand_id ? db.value('SELECT name FROM brands WHERE id = ?', who.brand_id) : db.value('SELECT name FROM media_clients WHERE id = ?', who.client_id);
    const title = q.title || tr('med|{name} campaign', { name: party0 });
    const id = db.tx(() => {
      const cid = Number(db.run(`INSERT INTO media_campaigns (ref, title, brand_id, client_id, status, extra_pct, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'proposal', ?, ?, ?, ?, ?)`,
        db.nextRef('media_campaigns', 'MC', 4, true), title, who.brand_id, who.client_id, p.extraPct, h.str(req.body.notes, 1000) || null, req.user.id, M.now(), M.now()).lastInsertRowid);
      for (const l of p.lines) db.run('INSERT INTO media_lines (campaign_id, item_id, start_date, end_date, slots, days, rate, base, season_days, list, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', cid, l.item_id, l.start_date, l.end_date, l.slots, l.days, l.rate, l.base, l.season_days, l.list, l.price);
      return cid;
    });
    const c = refresh(id);
    h.log(req, 'Created a media proposal', 'media_campaign', id, `${c.ref} · ${title}`);
    h.back(req, res, `/admin/media/campaigns/${id}`, 'ok', tr('med|Proposal {ref} saved.', { ref: c.ref }));
  });

  // ---------- one campaign ----------
  const STEPS = [['proposal', 'med|Proposal'], ['confirmed', 'med|Confirmed'], ['artwork', 'med|Artwork approved'], ['live', 'med|Live'], ['ended', 'med|Ended']];
  function steps(c) {
    const reached = {
      proposal: true, confirmed: ['confirmed', 'live', 'ended'].includes(c.status), artwork: c.artwork_status === 'approved',
      live: ['live', 'ended'].includes(c.status), ended: c.status === 'ended',
    };
    const cur = STEPS.findIndex(([k]) => !reached[k]);
    return `<ol class="med-steps">${STEPS.map(([k, l], i) => `<li class="${reached[k] ? 'is-done' : ''}${i === cur && c.status !== 'cancelled' ? ' is-now' : ''}"><i>${reached[k] ? ui.icon('check') : i + 1}</i><span>${esc(tr(l))}</span></li>`).join('')}</ol>`;
  }
  const invoicesOf = (id) => db.all("SELECT * FROM invoices WHERE source = 'media' AND source_id = ? ORDER BY period_start, id", id);
  router.get('/media/campaigns/:id', (req, res, next) => {
    sweep();
    const c = campaignOf(h.int(req.params.id));
    if (!c) return next();
    const t = today();
    const csrf = req.session.csrf;
    const lines = linesOf(c.id);
    const edit = EDITABLE.includes(c.status) && h.can(req, 'agent');
    const mgr = h.can(req, 'manager');
    const clash = ['proposal', 'held'].includes(c.status) ? campaignClashes(c, lines) : [];
    const invs = invoicesOf(c.id);
    const invoiced = invs.filter((x) => x.status !== 'void').reduce((s, x) => s + (x.total - x.vat), 0);
    const base = `/admin/media/campaigns/${c.id}`;
    const act = (path, label, { cls = 'btn--ghost btn--sm', ic = '', confirm = '', inner = '' } = {}) => ui.form(`${base}/${path}`, csrf, `${inner}${ui.btn(esc(label), { cls, ic, attrs: confirm ? { 'data-confirm': confirm } : {} })}`);
    const del = (l) => (edit ? ui.form(`${base}/lines/${l.id}/delete`, csrf, `<button class="iconbtn" title="${esc(tr('Remove'))}" aria-label="${esc(tr('Remove'))}" data-confirm="${esc(tr('med|Take this space off the campaign?'))}">×</button>`) : '');
    const linesTable = `<div class="tablewrap"><table class="table table--resp med-lines"><thead><tr><th>${esc(tr('med|Space'))}</th><th class="num">${esc(tr('med|Views (est.)'))}</th><th class="num">${esc(tr('med|List price'))}</th><th class="num">${esc(tr('med|Price'))}</th><th></th></tr></thead><tbody>${lines.map((l) => {
      const bad = clash.find((x) => x.line.id === l.id);
      const v = views(l);
      return `<tr${bad ? ' class="is-clash"' : ''}><td data-label="${esc(tr('med|Space'))}"><a class="med-lines__a" href="/admin/media/inventory/${l.item_id}"><b><bdi>${esc(l.code)}</bdi></b> · ${esc(nm(l))}</a><small class="sub">${ui.date(l.start_date)} – ${ui.date(l.end_date)} · ${esc([tn(l.days, 'med|{n} day', 'med|{n} days'), slotsText(l), l.season_days ? tn(l.season_days, 'med|{n} peak day', 'med|{n} peak days') : null].filter(Boolean).join(' · '))}</small>${bad ? `<small class="sub med-clash">${esc(tr('med|Taken on {date}', { date: ui.date(bad.days[0].date) }))}${bad.days.length > 1 ? ` (+${bad.days.length - 1})` : ''}</small>` : ''}</td><td class="num" data-label="${esc(tr('med|Views (est.)'))}">${v ? ui.n0(v) : '—'}</td><td class="num" data-label="${esc(tr('med|List price'))}">${ui.money(l.list)}</td><td class="num" data-label="${esc(tr('med|Price'))}"><b>${ui.money(l.price)}</b></td><td>${del(l)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    const itemsOn = db.all("SELECT * FROM media_items WHERE status = 'active' ORDER BY type, sort, code");
    const addLine = edit ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${esc(tr('med|Add a space'))}</span></summary>${ui.form(`${base}/lines`, csrf, `<div class="fields">
      ${ui.select('item_id', tr('med|Space'), itemsOn.map((i) => [i.id, `${i.code} · ${nm(i)}${capOf(i) > 1 ? ` (${loop(i)})` : ''}`]), '')}
      ${ui.input('start_date', tr('med|From'), c.start_date || addDays(t, 7), { type: 'date', required: true })}
      ${ui.input('end_date', tr('med|To'), c.end_date || addDays(t, 20), { type: 'date', required: true })}
      ${ui.input('slots', tr('med|Slots (screens)'), 1, { type: 'number', min: 1, max: 30, step: 1 })}
    </div>${ui.btn(esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const need = c.needs_approval && c.approval_state !== 'approved';
    const apprLine = c.approval_state !== 'none' || need
      ? `<p class="med-note ${c.approval_state === 'approved' ? 'med-note--ok' : 'med-note--warn'}">${esc(c.approval_state === 'none' ? tr('med|The extra discount is above {pct}%: it needs approval before the campaign is confirmed.', { pct: ui.n0(freePct()) }) : tr(APPROVAL[c.approval_state]))}${c.approval_state === 'approved' && c.approver ? ` · ${esc(c.approver)}` : ''}${c.approval_note ? ` · ${esc(c.approval_note)}` : ''}</p>` : '';
    const priceCard = `<dl class="dl med-sum">
      <div><dt>${esc(tr('med|Rate card'))}</dt><dd>${ui.money(c.list_total)}</dd></div>
      ${c.duration_off ? `<div><dt>${esc(tr('med|Duration discount'))}</dt><dd>−${ui.money(c.duration_off)}</dd></div>` : ''}
      ${c.volume_off ? `<div><dt>${esc(tr('med|Volume discount ({pct}%)', { pct: ui.n0(c.volume_pct) }))}</dt><dd>−${ui.money(c.volume_off)}</dd></div>` : ''}
      ${c.extra_off ? `<div><dt>${esc(tr('med|Extra discount ({pct}%)', { pct: ui.n0(c.extra_pct) }))}</dt><dd>−${ui.money(c.extra_off)}</dd></div>` : ''}
      <div class="med-sum__total"><dt>${esc(tr('med|Total before VAT'))}</dt><dd>${ui.money(c.total)}</dd></div>
      ${invs.length ? `<div><dt>${esc(tr('med|Invoiced'))}</dt><dd>${ui.money(invoiced)}</dd></div>` : ''}
    </dl>${apprLine}
    ${edit ? ui.form(`${base}/discount`, csrf, `<div class="row med-disc">${ui.input('extra', tr('med|Extra discount (%)'), c.extra_pct || 0, { type: 'number', min: 0, max: 90, step: '0.5' })}${ui.btn(esc(tr('med|Apply')), { cls: 'btn--ghost btn--sm' })}</div>`) : ''}
    ${need && c.approval_state !== 'pending' && edit ? act('request-approval', tr('med|Ask for approval'), { cls: 'btn--primary btn--sm', ic: 'check' }) : ''}
    ${c.approval_state === 'pending' && !h.approvals && mgr ? `<div class="row med-acts">${act('approve-discount', tr('med|Approve the discount'), { cls: 'btn--primary btn--sm', ic: 'check' })}${act('reject-discount', tr('med|Reject'), { confirm: tr('med|Reject this discount?') })}</div>` : ''}
    ${c.approval_state === 'pending' && h.approvals ? `<p class="muted small">${esc(tr('med|Waiting in the approvals queue.'))} <a href="/admin/approvals">${esc(tr('med|Open approvals'))}</a></p>` : ''}`;
    // the status actions
    const acts = [];
    if (h.can(req, 'agent') && c.status === 'proposal') acts.push(act('hold', tr('med|Hold the spaces'), { ic: 'cal', inner: '' }));
    if (h.can(req, 'agent') && c.status === 'held') acts.push(act('hold', tr('med|Extend the hold'), { ic: 'cal' }), act('release', tr('med|Release the hold'), { confirm: tr('med|Release these spaces?') }));
    if (h.can(req, 'agent') && EDITABLE.includes(c.status)) {
      const span = c.start_date && c.end_date && c.start_date.slice(0, 7) !== c.end_date.slice(0, 7);
      acts.push(ui.form(`${base}/confirm`, csrf, `${span ? `<label class="check"><input type="checkbox" name="monthly" value="1" checked> ${esc(tr('med|Invoice month by month'))}</label>` : ''}<label class="check"><input type="checkbox" name="invoice" value="1" checked> ${esc(tr('med|Raise the invoice now'))}</label>${ui.btn(esc(tr('med|Confirm the booking')), { cls: 'btn--primary btn--sm', ic: 'check', attrs: need ? { disabled: true, title: tr('med|The discount needs approval first.') } : {} })}`, { cls: 'row med-confirm' }));
    }
    if (mgr && c.status === 'confirmed' && c.artwork_status === 'approved' && c.start_date > t) acts.push(act('live', tr('med|Mark as live now'), { ic: 'check', confirm: tr('med|Start the campaign before its first day?') }));
    if (mgr && c.status === 'live') acts.push(act('end', tr('med|End the campaign'), { confirm: tr('med|End this campaign now?') }));
    if (h.can(req, 'agent') && SOLD.includes(c.status) && invoiced < c.total - 0.5) acts.push(act('invoice', tr('med|Invoice the rest'), { ic: 'bill' }));
    if (h.can(req, 'agent') && !['cancelled', 'ended'].includes(c.status)) acts.push(`<details class="med-cancel"><summary class="btn btn--ghost btn--sm">${esc(tr('med|Cancel…'))}</summary>${ui.form(`${base}/cancel`, csrf, `${ui.input('reason', tr('med|Why'), '', { placeholder: tr('med|e.g. Budget moved to next quarter') })}${ui.btn(esc(tr('med|Cancel the campaign')), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('med|Cancel this campaign? Its spaces are freed and unpaid invoices voided.') } })}`, { cls: 'stack' })}</details>`);
    const statusLine = `<div class="row med-head">${badge(c.status)}${c.status === 'held' && c.hold_until ? `<span class="muted small">${esc(tr('med|hold until {date}', { date: ui.date(c.hold_until) }))}</span>` : ''}${clash.length ? ui.badge('clash', tr('med|Clash'), 'rose') : ''}</div>`;
    const clashNote = clash.length ? `<p class="med-note med-note--warn">${esc(clashText(clash))}</p>` : '';
    // artwork
    const due = c.start_date ? addDays(c.start_date, -artDays()) : null;
    const nArt = docCount('media_campaign', c.id, 'media_artwork');
    const nProof = docCount('media_campaign', c.id, 'media_proof');
    const artCard = ['proposal', 'cancelled'].includes(c.status) && c.artwork_status === 'none' ? '' : ui.card(tr('med|Artwork'), `<div class="row med-head">${artBadge(c.artwork_status)}${due && c.artwork_status !== 'approved' ? `<span class="muted small${due < t ? ' med-late' : ''}">${esc(tr('med|due {date}', { date: ui.date(due) }))}</span>` : ''}</div>
      <p class="muted small">${esc(tn(nArt, 'med|{n} artwork file', 'med|{n} artwork files'))} · ${esc(tn(nProof, 'med|{n} proof photo', 'med|{n} proof photos'))}${c.art_user && c.artwork_at ? ` · ${esc(tr('med|{who}, {when}', { who: c.art_user, when: ui.date(c.artwork_at) }))}` : ''}</p>
      ${c.artwork_note ? `<p class="small">${esc(c.artwork_note)}</p>` : ''}
      ${h.can(req, 'agent') && ['held', 'confirmed', 'live'].includes(c.status) && c.artwork_status !== 'approved' ? act('artwork/received', tr('med|Artwork received'), { ic: 'upload' }) : ''}
      ${mgr && ['held', 'confirmed', 'live'].includes(c.status) && c.artwork_status !== 'approved' ? ui.form(`${base}/artwork/review`, csrf, `${ui.input('note', tr('med|Note for the advertiser'), '', { placeholder: tr('med|e.g. Logo too small for the barrier arms') })}<div class="row med-acts">${ui.btn(esc(tr('med|Approve the artwork')), { cls: 'btn--primary btn--sm', ic: 'check', attrs: { name: 'decision', value: 'approved' } })}${ui.btn(esc(tr('med|Ask for changes')), { cls: 'btn--ghost btn--sm', attrs: { name: 'decision', value: 'changes' } })}</div>`, { cls: 'stack' }) : ''}`, { sub: esc(tr('med|Upload the files below; marketing approves them before the campaign goes live.')), cls: 'med-artcard' });
    const invCard = invs.length || SOLD.includes(c.status) ? ui.card(tr('med|Invoices'), invs.length ? `<ul class="list">${invs.map((x) => `<li><a href="/admin/invoices/${x.id}"><span class="what"><b><bdi>${esc(x.ref)}</bdi> · ${ui.money(x.total)}</b><small>${x.period_start ? `${ui.date(x.period_start)} – ${ui.date(x.period_end)} · ` : ''}${esc(tr('med|due {date}', { date: ui.date(x.due_date) }))}</small></span>${ui.badge(x.status, M.INVOICE_STATUS[x.status])}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('med|Not invoiced yet.'))}</p>`) : '';
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('med|Advertiser'))}</dt><dd>${c.brand_id ? `<a href="/admin/tenants/${c.brand_id}">${esc(c.brand_name)}</a> <small class="muted">${esc(tr('med|tenant'))}</small>` : c.client_id ? `<a href="/admin/media/clients/${c.client_id}">${esc(c.client_name)}</a> <small class="muted">${esc(tr(CLIENT_KINDS[c.client_kind] || CLIENT_KINDS.company))}</small>` : '—'}</dd></div>
      ${c.contact_name || c.client_phone || c.client_email ? `<div><dt>${esc(tr('med|Contact'))}</dt><dd>${esc([c.contact_name, c.client_phone, c.client_email].filter(Boolean).join(' · '))}</dd></div>` : ''}
      <div><dt>${esc(tr('med|Dates'))}</dt><dd>${c.start_date ? `${ui.date(c.start_date)} – ${ui.date(c.end_date)}` : '—'}</dd></div>
      <div><dt>${esc(tr('med|Views (est.)'))}</dt><dd>${lines.some((l) => views(l)) ? ui.n0(lines.reduce((s, l) => s + (views(l) || 0), 0)) : '—'}</dd></div>
      <div><dt>${esc(tr('med|Prepared by'))}</dt><dd>${esc(c.author || '—')} · ${ui.date(c.created_at)}</dd></div>
      ${c.cancel_reason ? `<div><dt>${esc(tr('med|Why cancelled'))}</dt><dd>${esc(c.cancel_reason)}</dd></div>` : ''}
      ${c.notes ? `<div><dt>${esc(tr('Notes'))}</dt><dd>${esc(c.notes)}</dd></div>` : ''}
    </dl>`;
    const hist = db.all("SELECT a.action, a.detail, a.created_at, u.name user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'media_campaign' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 20", c.id);
    const histCard = ui.card(tr('med|History'), hist.length ? `<ul class="feed">${hist.map((a) => `<li><span class="avatar avatar--sm">${esc(ui.initials(a.user_name || tr('System')))}</span><p><b>${esc(a.user_name || tr('System'))}</b> ${esc(LOG[a.action] ? tr(LOG[a.action]) : a.action)}</p><time>${ui.rel(a.created_at)}</time></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('med|Nothing yet.'))}</p>`);
    const body = `${steps(c)}${statusLine}${clashNote}${acts.length ? `<div class="row med-acts">${acts.join('')}</div>` : ''}
<div class="grid grid--side">
  <div class="stack">
    ${ui.card(tn(lines.length, 'med|{n} space', 'med|{n} spaces'), `${lines.length ? linesTable : `<p class="muted pad">${esc(tr('med|No spaces yet.'))}</p>`}${addLine}`)}
    ${artCard}
    ${panel(req, 'media_campaign', c.id, { title: tr('med|Artwork, proof and signed proposal') })}
  </div>
  <div class="stack">
    ${ui.card(tr('med|Price'), priceCard, { sub: esc(tr('med|Before VAT')) })}
    ${ui.card(tr('med|Details'), facts)}
    ${invCard}
    ${histCard}
  </div>
</div>`;
    h.page(req, res, {
      title: c.title, crumbs: crumbs(['/admin/media/campaigns', tr('med|Campaigns')], [null, c.ref]), active: '/admin/media', wide: true, body,
      actions: ui.btn(esc(tr('med|Proposal')), { href: `${base}/print`, cls: 'btn--ghost', ic: 'print' }),
    });
  });

  // every campaign action: the campaign, or a 404
  const withCampaign = (min, fn) => [R(min), (req, res, next) => {
    const c = campaignOf(h.int(req.params.id));
    if (!c) return next();
    return fn(req, res, c, `/admin/media/campaigns/${c.id}`);
  }];

  router.post('/media/campaigns/:id/lines', ...withCampaign('agent', (req, res, c, back) => {
    if (!EDITABLE.includes(c.status)) return h.back(req, res, back, 'error', tr('med|A confirmed campaign cannot change. Cancel it and make a new one.'));
    const i = itemOf(h.int(req.body.item_id));
    if (!i || i.status !== 'active') return h.back(req, res, back, 'error', tr('med|Choose a space on sale.'));
    const p = priceLine(i, req.body.start_date, req.body.end_date, { seasons: seasons(), slots: h.int(req.body.slots) || 1 });
    if (p.error) return h.back(req, res, back, 'error', tr(p.error, p.params));
    db.run('INSERT INTO media_lines (campaign_id, item_id, start_date, end_date, slots, days, rate, base, season_days, list, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, i.id, req.body.start_date, req.body.end_date, p.slots, p.days, p.rate, p.base, p.seasonDays, p.list, p.list);
    refresh(c.id);
    // a hold must still fit
    if (c.status === 'held') {
      const clash = campaignClashes(c, linesOf(c.id));
      if (clash.length) { db.run('DELETE FROM media_lines WHERE id = (SELECT MAX(id) FROM media_lines WHERE campaign_id = ?)', c.id); refresh(c.id); return h.back(req, res, back, 'error', clashText(clash)); }
    }
    h.log(req, 'Added a space to a campaign', 'media_campaign', c.id, `${c.ref} · ${i.code}`);
    h.back(req, res, back, 'ok', tr('med|{code} added.', { code: i.code }));
  }));
  router.post('/media/campaigns/:id/lines/:line/delete', ...withCampaign('agent', (req, res, c, back) => {
    if (!EDITABLE.includes(c.status)) return h.back(req, res, back, 'error', tr('med|A confirmed campaign cannot change. Cancel it and make a new one.'));
    if (db.value('SELECT COUNT(*) FROM media_lines WHERE campaign_id = ?', c.id) <= 1) return h.back(req, res, back, 'error', tr('med|A campaign needs at least one space.'));
    db.run('DELETE FROM media_lines WHERE id = ? AND campaign_id = ?', h.int(req.params.line), c.id);
    refresh(c.id);
    h.log(req, 'Took a space off a campaign', 'media_campaign', c.id, c.ref);
    h.back(req, res, back, 'ok', tr('Saved.'));
  }));
  router.post('/media/campaigns/:id/discount', ...withCampaign('agent', (req, res, c, back) => {
    if (!EDITABLE.includes(c.status)) return h.back(req, res, back, 'error', tr('med|A confirmed campaign cannot change. Cancel it and make a new one.'));
    const pct = Math.max(0, Math.min(90, h.numv(req.body.extra) || 0));
    db.run("UPDATE media_campaigns SET extra_pct = ?, approval_state = CASE WHEN approval_state IN ('pending','rejected') AND extra_pct != ? THEN 'none' ELSE approval_state END WHERE id = ?", pct, pct, c.id);
    const n = refresh(c.id);
    h.log(req, 'Changed a media discount', 'media_campaign', c.id, `${c.ref} · ${pct}%`);
    h.back(req, res, back, n.needs_approval ? 'error' : 'ok', n.needs_approval ? tr('med|Saved. This discount needs approval before the campaign is confirmed.') : tr('Saved.'));
  }));
  router.post('/media/campaigns/:id/request-approval', ...withCampaign('agent', (req, res, c, back) => {
    if (!c.needs_approval || c.approval_state === 'approved') return h.back(req, res, back, 'ok', tr('med|No approval is needed.'));
    hook();
    let ref = null;
    if (h.approvals && typeof h.approvals.request === 'function') {
      const r = h.approvals.request({
        kind: 'media_discount', title: `${c.ref} · ${c.title} · −${c.extra_pct}%`, amount: c.extra_off, entity: 'media_campaign', entity_id: c.id,
        link: `/admin/media/campaigns/${c.id}`, payload: { campaign_id: c.id, pct: c.extra_pct, list: c.list_total, total: c.total }, user: req.user, demo: c.demo ? 1 : 0,
      });
      ref = r && typeof r === 'object' ? String(r.id ?? r.ref ?? '') : r !== undefined && r !== null ? String(r) : null;
    }
    db.run("UPDATE media_campaigns SET approval_state = 'pending', approval_ref = ?, approval_note = NULL, updated_at = ? WHERE id = ?", ref, M.now(), c.id);
    h.log(req, 'Asked for a media discount approval', 'media_campaign', c.id, `${c.ref} · ${c.extra_pct}%`);
    h.back(req, res, back, 'ok', tr('med|Sent for approval.'));
  }));
  // without the approvals module, a manager decides here
  router.post('/media/campaigns/:id/approve-discount', ...withCampaign('manager', (req, res, c, back) => {
    if (h.approvals) return h.back(req, res, back, 'error', tr('med|This goes through the approvals queue.'));
    decide({ entity_id: c.id, payload: { pct: c.extra_pct } }, 'approved', req.user);
    h.back(req, res, back, 'ok', tr('med|Discount approved.'));
  }));
  router.post('/media/campaigns/:id/reject-discount', ...withCampaign('manager', (req, res, c, back) => {
    if (h.approvals) return h.back(req, res, back, 'error', tr('med|This goes through the approvals queue.'));
    decide({ entity_id: c.id }, 'rejected', req.user);
    h.back(req, res, back, 'ok', tr('med|Discount rejected.'));
  }));

  // hold: the spaces are kept for a few days, if they are free
  router.post('/media/campaigns/:id/hold', ...withCampaign('agent', (req, res, c, back) => {
    if (!EDITABLE.includes(c.status)) return h.back(req, res, back, 'error', tr('med|Only a proposal can be held.'));
    const lines = linesOf(c.id);
    if (!lines.length) return h.back(req, res, back, 'error', tr('med|A campaign needs at least one space.'));
    const clash = campaignClashes(c, lines);
    if (clash.length) return h.back(req, res, back, 'error', clashText(clash));
    const until = addDays(today(), holdDays());
    db.run("UPDATE media_campaigns SET status = 'held', hold_until = ?, updated_at = ? WHERE id = ?", until, M.now(), c.id);
    h.log(req, c.status === 'held' ? 'Extended a media hold' : 'Held media spaces', 'media_campaign', c.id, `${c.ref} · ${until}`);
    h.back(req, res, back, 'ok', tr('med|Spaces held until {date}.', { date: ui.date(until) }));
  }));
  router.post('/media/campaigns/:id/release', ...withCampaign('agent', (req, res, c, back) => {
    if (c.status !== 'held') return h.back(req, res, back, 'error', tr('med|This campaign is not on hold.'));
    db.run("UPDATE media_campaigns SET status = 'proposal', hold_until = NULL, updated_at = ? WHERE id = ?", M.now(), c.id);
    h.log(req, 'Released a media hold', 'media_campaign', c.id, c.ref);
    h.back(req, res, back, 'ok', tr('med|Hold released.'));
  }));

  // raise the invoices still due on a campaign (all, or month by month)
  function invoice(c, { monthly = false, user = null } = {}) {
    const lines = linesOf(c.id);
    const done = invoicesOf(c.id).filter((x) => x.status !== 'void');
    const plan = invoicePlan(lines, { monthly }).filter((p) => !done.some((x) => x.period_start === p.period_start && x.period_end === p.period_end));
    const left = r2(c.total - done.reduce((s, x) => s + (x.total - x.vat), 0));
    if (!(left > 0.5) || !plan.length) return [];
    // what is left, spread over the remaining periods in proportion
    const sum = plan.reduce((s, p) => s + p.amount, 0) || 1;
    let rest = left;
    const t = today();
    return plan.map((p, k) => {
      const amount = k === plan.length - 1 ? r2(rest) : r2((left * p.amount) / sum);
      rest -= amount;
      const due = p.period_start > t ? addDays(p.period_start, -Math.min(7, artDays())) : addDays(t, 7);
      return h.billing.createInvoice({
        brand_id: c.brand_id || null, customer: c.brand_id ? null : c.client_name || c.party, kind: 'media', total: amount,
        due_date: due < t ? t : due, period_start: p.period_start, period_end: p.period_end, note: `${c.ref} · ${c.title}`,
        source: 'media', source_id: c.id, demo: c.demo ? 1 : 0,
      }, { user });
    });
  }
  router.post('/media/campaigns/:id/confirm', ...withCampaign('agent', (req, res, c, back) => {
    if (!EDITABLE.includes(c.status)) return h.back(req, res, back, 'error', tr('med|This campaign is already confirmed.'));
    const fresh = refresh(c.id);
    if (fresh.needs_approval && fresh.approval_state !== 'approved') return h.back(req, res, back, 'error', tr('med|The discount needs approval first.'));
    const lines = linesOf(c.id);
    if (!lines.length) return h.back(req, res, back, 'error', tr('med|A campaign needs at least one space.'));
    let invs = [];
    const err = db.tx(() => {
      const clash = campaignClashes(c, lines);
      if (clash.length) return clashText(clash);
      db.run("UPDATE media_campaigns SET status = 'confirmed', hold_until = NULL, confirmed_at = ?, updated_at = ? WHERE id = ?", M.now(), M.now(), c.id);
      return null;
    });
    if (err) return h.back(req, res, back, 'error', err);
    h.log(req, 'Confirmed a media campaign', 'media_campaign', c.id, `${c.ref} · ${fresh.total}`);
    if (req.body.invoice) invs = invoice(campaignOf(c.id), { monthly: !!req.body.monthly, user: req.user });
    sweep();
    h.back(req, res, back, 'ok', invs.length ? tn(invs.length, 'med|Confirmed. {n} invoice raised.', 'med|Confirmed. {n} invoices raised.') : tr('med|Confirmed.'));
  }));
  router.post('/media/campaigns/:id/invoice', ...withCampaign('agent', (req, res, c, back) => {
    if (!SOLD.includes(c.status)) return h.back(req, res, back, 'error', tr('med|Confirm the campaign first.'));
    const invs = invoice(c, { monthly: false, user: req.user });
    if (!invs.length) return h.back(req, res, back, 'error', tr('med|Nothing left to invoice.'));
    h.log(req, 'Invoiced a media campaign', 'media_campaign', c.id, invs.map((x) => x.ref).join(', '));
    h.back(req, res, back, 'ok', tr('med|Invoice {ref} raised.', { ref: invs[0].ref }));
  }));
  router.post('/media/campaigns/:id/artwork/received', ...withCampaign('agent', (req, res, c, back) => {
    if (!['held', 'confirmed', 'live'].includes(c.status)) return h.back(req, res, back, 'error', tr('med|Confirm or hold the campaign first.'));
    if (!docCount('media_campaign', c.id, 'media_artwork')) return h.back(req, res, back, 'error', tr('med|Upload the artwork first (as “Artwork”).'));
    db.run("UPDATE media_campaigns SET artwork_status = 'received', artwork_at = ?, artwork_by = ?, updated_at = ? WHERE id = ?", M.now(), req.user.id, M.now(), c.id);
    h.log(req, 'Received media artwork', 'media_campaign', c.id, c.ref);
    h.back(req, res, back, 'ok', tr('med|Artwork received. Marketing will review it.'));
  }));
  router.post('/media/campaigns/:id/artwork/review', ...withCampaign('manager', (req, res, c, back) => {
    if (!['held', 'confirmed', 'live'].includes(c.status)) return h.back(req, res, back, 'error', tr('med|Confirm or hold the campaign first.'));
    const ok = req.body.decision === 'approved';
    if (ok && !docCount('media_campaign', c.id, 'media_artwork')) return h.back(req, res, back, 'error', tr('med|Upload the artwork first (as “Artwork”).'));
    db.run('UPDATE media_campaigns SET artwork_status = ?, artwork_at = ?, artwork_by = ?, artwork_note = ?, updated_at = ? WHERE id = ?', ok ? 'approved' : 'changes', M.now(), req.user.id, h.str(req.body.note, 500) || null, M.now(), c.id);
    h.log(req, ok ? 'Approved media artwork' : 'Asked for artwork changes', 'media_campaign', c.id, c.ref);
    sweep();
    h.back(req, res, back, 'ok', ok ? tr('med|Artwork approved.') : tr('med|Changes requested.'));
  }));
  router.post('/media/campaigns/:id/live', ...withCampaign('manager', (req, res, c, back) => {
    if (c.status !== 'confirmed' || c.artwork_status !== 'approved') return h.back(req, res, back, 'error', tr('med|The artwork must be approved first.'));
    db.run("UPDATE media_campaigns SET status = 'live', live_at = ?, updated_at = ? WHERE id = ?", M.now(), M.now(), c.id);
    h.log(req, 'Started a media campaign', 'media_campaign', c.id, c.ref);
    h.back(req, res, back, 'ok', tr('med|The campaign is live.'));
  }));
  router.post('/media/campaigns/:id/end', ...withCampaign('manager', (req, res, c, back) => {
    if (c.status !== 'live') return h.back(req, res, back, 'error', tr('med|Only a live campaign can end.'));
    db.run("UPDATE media_campaigns SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = ?", M.now(), M.now(), c.id);
    h.log(req, 'Ended a media campaign', 'media_campaign', c.id, c.ref);
    h.back(req, res, back, 'ok', docCount('media_campaign', c.id, 'media_proof') ? tr('med|Campaign ended.') : tr('med|Campaign ended. Add the proof-of-posting photos for the advertiser.'));
  }));
  router.post('/media/campaigns/:id/cancel', ...withCampaign('agent', (req, res, c, back) => {
    if (['cancelled', 'ended'].includes(c.status)) return h.back(req, res, back, 'error', tr('med|This campaign is already closed.'));
    if (['confirmed', 'live'].includes(c.status) && !h.can(req, 'manager')) return h.back(req, res, back, 'error', tr('med|A manager cancels a confirmed campaign.'));
    const reason = h.str(req.body.reason, 300) || null;
    for (const x of invoicesOf(c.id)) h.billing.voidInvoice(x.id, { user: req.user, note: null });
    db.run("UPDATE media_campaigns SET status = 'cancelled', hold_until = NULL, cancel_reason = ?, approval_state = CASE approval_state WHEN 'pending' THEN 'none' ELSE approval_state END, updated_at = ? WHERE id = ?", reason, M.now(), c.id);
    h.log(req, 'Cancelled a media campaign', 'media_campaign', c.id, c.ref);
    h.back(req, res, back, 'ok', tr('med|Campaign cancelled.'));
  }));

  // ---------- the proposal, printable in either language ----------
  router.get('/media/campaigns/:id/print', (req, res, next) => {
    const c = campaignOf(h.int(req.params.id));
    if (!c) return next();
    const lang = docLang(req);
    const lines = linesOf(c.id);
    const html = i18n.run(lang, () => {
      const s = db.settings();
      const vatPct = Number(db.setting('vat_pct')) || 0;
      const vat = r2((c.total * vatPct) / 100);
      const valid = c.status === 'held' && c.hold_until ? c.hold_until : addDays(String(c.created_at).slice(0, 10), 14);
      const totalViews = lines.reduce((x, l) => x + (views(l) || 0), 0);
      const photo = (l) => { const p = photoOf(l.item_id); return p ? `<img class="med-doc__ph" src="/admin/documents/${p}/file" alt="">` : ''; };
      // the mall's own details, as the other printed documents show them
      const legal = (v) => (v ? tx(v) : '');
      const body = `<main class="doc med-doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${esc(tr('Print or save as PDF'))}</span></button><a class="btn btn--ghost" href="/admin/media/campaigns/${c.id}">${esc(tr('Back'))}</a>${docSwitch(ui, `/admin/media/campaigns/${c.id}/print`, lang)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${esc(tr('med|Advertising proposal'))}</p><p class="doc__ref"><bdi>${esc(c.ref)}</bdi> · ${ui.date(c.created_at)}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${esc(tr('med|Prepared for'))}</p><h1>${esc(party(c))}</h1>${c.contact_name ? `<p class="muted">${esc([c.contact_name, c.client_email, c.client_phone].filter(Boolean).join(' · '))}</p>` : ''}</section>
  <p class="doc__intro">${esc(tr('med|“{title}”: {n} placements at The Wave, from {from} to {to}.', { title: '\u0001', n: lines.length, from: c.start_date ? ui.date(c.start_date) : '—', to: c.end_date ? ui.date(c.end_date) : '—' })).replace('\u0001', `<bdi>${esc(c.title)}</bdi>`)}</p>
  <h2>${esc(tr('med|The placements'))}</h2>
  <table class="doc__t med-doc__t"><thead><tr><th>${esc(tr('med|Space'))}</th><th>${esc(tr('med|Dates'))}</th><th class="num">${esc(tr('med|Views (est.)'))}</th><th class="num">${esc(tr('med|Price'))}</th></tr></thead><tbody>
    ${lines.map((l) => `<tr><td><div class="med-doc__sp">${photo(l)}<div><b><bdi>${esc(l.code)}</bdi> · ${esc(nm(l))}</b><small>${esc([tr(TYPES[l.type]), where(l), size(l), slotsText(l), capOf({ slots: l.cap }) > 1 && l.slot_seconds ? tr('med|{s} s per slot', { s: l.slot_seconds }) : null].filter(Boolean).join(' · '))}</small></div></div></td><td>${ui.date(l.start_date)} – ${ui.date(l.end_date)}<small>${esc(tn(l.days, 'med|{n} day', 'med|{n} days'))}</small></td><td class="num">${views(l) ? ui.n0(views(l)) : '—'}</td><td class="num">${ui.money(l.price)}</td></tr>`).join('')}
  </tbody><tfoot>
    ${c.list_total - c.total > 0.5 ? `<tr class="med-doc__sub"><td colspan="3">${esc(tr('med|Rate card'))}</td><td class="num">${ui.money(c.list_total)}</td></tr><tr class="med-doc__sub"><td colspan="3">${esc(tr('med|Your discount ({pct}%)', { pct: ui.n0(c.discount_pct) }))}</td><td class="num">−${ui.money(c.list_total - c.total)}</td></tr>` : ''}
    <tr><td colspan="3">${esc(tr('med|Total before VAT'))}</td><td class="num">${ui.money(c.total)}</td></tr>
    ${vatPct ? `<tr class="med-doc__sub"><td colspan="3">${esc(tr('med|VAT ({pct}%)', { pct: ui.n0(vatPct) }))}</td><td class="num">${ui.money(vat)}</td></tr><tr><td colspan="3">${esc(tr('med|Total with VAT'))}</td><td class="num">${ui.money(c.total + vat)}</td></tr>` : ''}
  </tfoot></table>
  ${totalViews ? `<p class="doc__small">${esc(tr('med|Estimated views: about {n}, from the mall\'s visitor counts and the share passing each space (a screen counts its share of the loop). Cost per thousand views: {cpm}.', { n: ui.n0(totalViews), cpm: ui.money(Math.round((c.total / totalViews) * 1000)) }))}</p>` : ''}
  <h2>${esc(tr('med|Terms'))}</h2>
  <ol class="doc__small">
    <li>${esc(tr('med|This proposal is valid until {date}. Spaces are only reserved once it is confirmed (or held, for {n} days).', { date: ui.date(valid), n: holdDays() }))}</li>
    <li>${esc(tr('med|Artwork is due {n} days before the start, in the format of each space\'s specification, and is approved by the mall\'s marketing team before it goes up.', { n: artDays() }))}</li>
    <li>${esc(tr('med|Production, printing and installation are the advertiser\'s, unless agreed otherwise; installation happens outside opening hours.'))}</li>
    <li>${esc(tr('med|Invoices are due before the campaign starts. Prices are in {currency}, before VAT.', { currency: ui.curLabel() }))}</li>
    <li>${esc(tr('med|Proof-of-posting photos are shared once each placement is live.'))}</li>
  </ol>
  <div class="doc__sign"><div><span></span><p>${esc(tr('med|For {name}', { name: legal(s.legal_name) || 'The Wave' }))}</p></div><div><span></span><p>${esc(tr('med|For {name}', { name: party(c) }))}</p></div></div>
  <p class="doc__foot">${esc(legal(s.legal_name))}${s.address ? ` · ${esc(legal(s.address))}` : ''}${s.leasing_email ? ` · ${esc(s.leasing_email)}` : ''}</p>
</main>`;
      return ui.bare({ title: `${c.ref}`, body, cls: 'print' });
    });
    res.type('html').send(html);
  });

  // ---------- reports ----------
  router.get('/media/reports', (req, res) => {
    sweep();
    const t = today();
    const years = db.all("SELECT DISTINCT substr(start_date, 1, 4) y FROM media_campaigns WHERE start_date IS NOT NULL ORDER BY y DESC").map((r) => r.y);
    const year = /^\d{4}$/.test(req.query.year || '') && years.includes(req.query.year) ? req.query.year : t.slice(0, 4);
    const yFrom = `${year}-01-01`;
    const yTo = `${year}-12-31`;
    const months = Array.from({ length: 12 }, (_, k) => `${year}-${String(k + 1).padStart(2, '0')}`);
    const items = db.all("SELECT * FROM media_items WHERE status != 'retired' ORDER BY sort, code");
    const lines = bookedLines(yFrom, yTo);
    const rev = lines.reduce((s, l) => s + share(l, yFrom, yTo), 0);
    const byMonth = months.map((m) => ({ m, label: ui.monthName(Number(m.slice(5, 7)), { short: true }), v: Math.round(lines.reduce((s, l) => s + share(l, `${m}-01`, monthEnd(m)), 0)) }));
    const byType = Object.keys(TYPES).map((k) => ({ label: tr(TYPES[k]), value: Math.round(lines.filter((l) => l.type === k).reduce((s, l) => s + share(l, yFrom, yTo), 0)) })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    const byClient = new Map();
    for (const l of lines) {
      const k = l.party || '—';
      const x = byClient.get(k) || { name: k, tenant: !!l.brand_id, v: 0, refs: new Set() };
      x.v += share(l, yFrom, yTo);
      x.refs.add(l.ref);
      byClient.set(k, x);
    }
    const top = [...byClient.values()].sort((a, b) => b.v - a.v).slice(0, 10);
    const st = sellThrough(yFrom, yTo < t || year !== t.slice(0, 4) ? yTo : yTo, items);
    const camps = db.all("SELECT * FROM media_campaigns WHERE status IN ('confirmed','live','ended') AND substr(start_date, 1, 4) = ?", year);
    const avgDisc = camps.length ? camps.reduce((s, c) => s + c.discount_pct, 0) / camps.length : 0;
    const tenantShare = rev ? top.concat([...byClient.values()].slice(10)).filter((x) => x.tenant).reduce((s, x) => s + x.v, 0) / rev : 0;
    const kpis = [
      ui.kpi({ label: tr('med|Booked revenue'), value: ui.money(rev, { compact: true }), sub: esc(tn(camps.length, 'med|{n} campaign', 'med|{n} campaigns')) }),
      ui.kpi({ label: tr('med|Sell-through'), value: ui.pct(st), bar: st, sub: esc(tr('med|of slot-days in {year}', { year })) }),
      ui.kpi({ label: tr('med|Average discount'), value: `${ui.n0(avgDisc)}%` }),
      ui.kpi({ label: tr('med|From tenants'), value: ui.pct(tenantShare), bar: tenantShare, sub: esc(tr('med|the rest from outside advertisers')) }),
    ].join('');
    // sell-through: items × months
    const sold = (i, m) => {
      const a = `${m}-01`;
      const b = monthEnd(m);
      const used = lines.filter((l) => l.item_id === i.id).reduce((s, l) => s + l.slots * overlap(l.start_date, l.end_date, a, b), 0);
      return Math.min(1, used / (capOf(i) * overlap(a, b, a, b)));
    };
    const heat = `<div class="med-heat-wrap"><div class="med-heat med-heat--months" style="--w:12"><span></span>${byMonth.map((x) => `<span class="med-heat__h">${esc(x.label)}</span>`).join('')}${items.map((i) => `<a class="med-heat__s" href="/admin/media/inventory/${i.id}" title="${esc(nm(i))}"><bdi>${esc(i.code)}</bdi></a>${months.map((m) => { const f = sold(i, m); return `<span class="med-heat__c" style="--f:${f.toFixed(2)}" title="${esc(`${i.code} · ${ui.monthYear(m)} · ${ui.pct(f)}`)}">${f ? Math.round(f * 100) : ''}</span>`; }).join('')}`).join('')}</div></div>`;
    const topTable = ui.table([
      { label: tr('med|Advertiser'), render: (x) => `<b>${esc(x.name)}</b><small class="sub">${esc(x.tenant ? tr('med|tenant') : tr('med|outside advertiser'))}</small>` },
      { label: tr('med|Campaigns'), num: true, render: (x) => ui.n0(x.refs.size) },
      { label: tr('med|Booked'), num: true, render: (x) => ui.money(x.v, { compact: true }) },
      { label: tr('med|Share'), num: true, render: (x) => ui.pct(rev ? x.v / rev : 0) },
    ], top, { empty: esc(tr('med|No campaigns sold this year yet.')) });
    const ending = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.status IN ('confirmed','live') AND c.end_date >= ? AND c.end_date <= ? ORDER BY c.end_date`, t, addDays(t, 45));
    const holds = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.status = 'held' ORDER BY c.hold_until`);
    const expTable = ui.table([
      { label: tr('med|Campaign'), render: (c) => `<b>${esc(party(c))}</b><small class="sub"><bdi>${esc(c.ref)}</bdi> · ${esc(c.title)}</small>` },
      { label: tr('med|Ends'), render: (c) => `${ui.date(c.status === 'held' ? c.hold_until : c.end_date)}<small class="sub">${esc(c.status === 'held' ? tr('med|hold runs out') : tr('med|campaign ends'))}</small>` },
      { label: tr('med|Total'), num: true, render: (c) => ui.money(c.total, { compact: true }) },
      { label: tr('med|Status'), render: (c) => badge(c.status) },
    ], [...holds, ...ending], { empty: esc(tr('med|Nothing ends in the next 45 days.')), href: (c) => `/admin/media/campaigns/${c.id}` });
    const yearSel = `<form method="get" action="/admin/media/reports" class="row med-nav">${ui.select('year', tr('med|Year'), [...new Set([t.slice(0, 4), ...years])].sort().reverse(), year, { attrs: { 'data-autosubmit': '' } })}${ui.btn(esc(tr('med|Show')), { cls: 'btn--ghost btn--sm' })}<a class="btn btn--ghost btn--sm" href="/admin/media/reports.csv?year=${year}">${ui.icon('dl')}<span>${esc(tr('med|Export'))}</span></a></form>`;
    const body = `${tabs('/admin/media/reports')}<div class="row med-yearbar">${yearSel}</div><div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side">
  ${ui.card(tr('med|Booked revenue by month'), ui.bars(byMonth, { key: 'v', label: 'label', fmtv: (v) => ui.money(v, { compact: true, cur: false }) }), { sub: esc(tr('med|Each campaign spread over the days it runs, before VAT')) })}
  ${ui.card(tr('med|By type of space'), byType.length ? ui.donut(byType.map((x) => ({ ...x, display: ui.money(x.value, { compact: true }) })), { label: ui.money(rev, { compact: true, cur: false }) }) : `<p class="muted pad">${esc(tr('med|No campaigns sold this year yet.'))}</p>`)}
</div>
${ui.card(tr('med|Sell-through by space and month'), items.length ? heat : ui.empty(tr('med|No advertising spaces yet.')), { sub: esc(tr('med|Share of slot-days sold, in percent')) })}
<div class="grid grid--2">
  ${ui.card(tr('med|Top advertisers'), topTable)}
  ${ui.card(tr('med|Coming to an end'), expTable, { sub: esc(tr('med|Holds running out and campaigns ending in 45 days: renewals to chase.')) })}
</div>`;
    h.page(req, res, { title: tr('med|Reports'), crumbs: crumbs([null, tr('med|Reports')]), active: '/admin/media', wide: true, body });
  });
  router.get('/media/reports.csv', (req, res) => {
    const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : null;
    const rows = db.all(`SELECT c.ref, c.title, c.status, ${PARTY}, i.code, i.type, l.start_date, l.end_date, l.days, l.slots, l.list, l.price, c.artwork_status
      FROM media_lines l JOIN media_campaigns c ON c.id = l.campaign_id JOIN media_items i ON i.id = l.item_id ${JOINS}
      ${year ? 'WHERE substr(l.start_date, 1, 4) = ?' : ''} ORDER BY l.start_date, c.ref`, ...(year ? [year] : []));
    const head = ['Campaign', 'Title', 'Status', 'Advertiser', 'Tenant', 'Space', 'Type', 'From', 'To', 'Days', 'Slots', 'List price', 'Price', 'Artwork'];
    const out = [head.join(',')].concat(rows.map((r) => [r.ref, r.title, r.status, r.party, r.brand_name ? 'yes' : 'no', r.code, r.type, r.start_date, r.end_date, r.days, r.slots, r.list, r.price, r.artwork_status].map(csvCell).join(',')));
    res.type('text/csv').set('Content-Disposition', `attachment; filename="media-${year || 'all'}.csv"`).send(`\ufeff${out.join('\n')}\n`);
  });

  // ---------- the tenant file: the brand's advertising ----------
  (h.tenantCards = h.tenantCards || []).push((req, b) => {
    const camps = db.all(`SELECT c.*, ${PARTY} FROM media_campaigns c ${JOINS} WHERE c.brand_id = ? AND c.status != 'cancelled' ORDER BY c.start_date DESC LIMIT 6`, b.id);
    if (!camps.length) return '';
    const spend = db.value("SELECT COALESCE(SUM(total), 0) FROM media_campaigns WHERE brand_id = ? AND status IN ('confirmed','live','ended')", b.id);
    return ui.card(tr('med|Advertising'), `<ul class="list">${camps.map((c) => `<li><a href="/admin/media/campaigns/${c.id}"><span class="what"><b>${esc(c.title)}</b><small><bdi>${esc(c.ref)}</bdi> · ${c.start_date ? `${ui.date(c.start_date)} – ${ui.date(c.end_date)}` : '—'} · ${ui.money(c.total, { compact: true })}</small></span>${badge(c.status)}</a></li>`).join('')}</ul>`,
      { sub: esc(tr('med|{amount} booked to date', { amount: ui.money(spend, { compact: true }) })), action: h.can(req, 'agent') ? ui.btn(esc(tr('med|Quote')), { href: `/admin/media/quote?client=b:${b.id}`, cls: 'btn--ghost btn--sm' }) : '' });
  });
};

module.exports.SCHEMA = SCHEMA;
module.exports.TYPES = TYPES;
module.exports.priceLine = priceLine;
module.exports.priceCampaign = priceCampaign;
module.exports.conflicts = conflicts;
module.exports.invoicePlan = invoicePlan;
module.exports.daysOf = daysOf;
module.exports.ensure = (db) => db.ensure('media-1', SCHEMA);
