'use strict';

// The owner's monthly report: one printable A4 document per month, in English or Arabic, with the
// headline numbers against the month before and the same month last year, then income (billed and
// collected by kind, and the ledger's profit and loss when the books are kept here), occupancy and
// leasing, collections (ageing, overdue, days to pay), tenant sales and occupancy cost, footfall,
// parking, operations, cheques and energy; and the month's highlights and risks as plain sentences.
// A monthly job emails it to the owner's list (a short HTML email with a link to the printable page,
// and the whole report attached as an HTML file). Every section checks its tables exist, so the
// report works whatever modules the office runs.

const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../i18n');
const C = require('../revenue/calc');
const { template } = require('../mailer');
const { cairo, docLang, docSwitch } = require('../ops-common');

const { t: tr, tn, tx } = i18n;

const OPEN_WO = ['new', 'assigned', 'in_progress', 'on_hold', 'reopened'];
const BUCKETS = [[0, 0, 'own|Not yet late'], [1, 30, 'own|1–30 days'], [31, 60, 'own|31–60 days'], [61, 90, 'own|61–90 days'], [91, Infinity, 'own|Over 90 days']];
const WO_CATS = {
  electrical: 'mnt|Electrical', plumbing: 'mnt|Plumbing', hvac: 'mnt|Air conditioning (HVAC)', civil: 'mnt|Civil and finishes',
  cleaning: 'mnt|Cleaning', security: 'mnt|Security systems', it: 'mnt|IT and low current', lifts: 'mnt|Lifts and escalators',
};
const LANGS = { en: 'own|English', ar: 'own|Arabic', both: 'own|English and Arabic' };
const CSS_FILE = path.join(__dirname, '..', '..', '..', 'public', 'admin', 'admin.css');

module.exports = function ownerReport(router, h) {
  const { db, ui, M } = h;
  const has = (name) => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  const thisYm = () => cairo().date.slice(0, 7);
  const lastYm = () => C.ymAdd(thisYm(), -1);
  const validYm = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) && String(v) <= thisYm();
  const end = (ym) => `${ym}-${String(C.daysIn(ym)).padStart(2, '0')}`;
  const r2 = (x) => Math.round(x * 100) / 100;
  const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
  const siteUrl = () => String((h.env && h.env.SITE_URL) || '').replace(/\/$/, '');
  const setting = (k, d = '') => { const v = db.setting(k); return v === null || v === undefined || v === '' ? d : v; };
  const recipients = () => String(setting('own_recipients')).split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));

  // ---------- the numbers ----------
  const gla = () => db.value("SELECT COALESCE(SUM(indoor_m2), 0) FROM units WHERE status != 'retired'") || 0;
  const area = (id) => M.leaseArea(db, id);
  // leases in force on a day (signed leases that have started and not ended)
  const inForce = (day) => (has('leases') ? db.all("SELECT * FROM leases WHERE status IN ('active','ended','terminated') AND start_date <= ? AND end_date >= ?", day, day) : []);

  // the headline numbers of a month (also used for the comparisons)
  function headline(ym) {
    const a = `${ym}-01`;
    const b = end(ym);
    const out = { ym };
    if (has('invoices')) {
      const bill = db.get("SELECT COALESCE(SUM(total), 0) total, COALESCE(SUM(paid), 0) paid FROM invoices WHERE status != 'void' AND due_date >= ? AND due_date <= ?", a, b);
      out.billed = bill.total;
      out.billedPaid = bill.paid;
    }
    if (has('payments')) out.collected = db.value("SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'received' AND COALESCE(method, '') NOT IN ('writeoff', 'deposit') AND date >= ? AND date <= ?", a, b);
    const g = gla();
    if (g) out.occupancy = inForce(b).reduce((s, l) => s + area(l.id), 0) / g;
    if (has('tenant_sales')) out.sales = db.value("SELECT COALESCE(SUM(amount), 0) FROM tenant_sales WHERE period = ? AND status IN ('submitted','verified')", ym);
    if (has('footfall')) out.footfall = db.value('SELECT COALESCE(SUM(visitors_in), 0) FROM footfall WHERE substr(ts_hour, 1, 7) = ?', ym);
    if (has('pk_payments')) out.parking = db.value("SELECT COALESCE(SUM(amount), 0) FROM pk_payments WHERE status = 'ok' AND substr(at, 1, 7) = ?", ym);
    if (h.ledger && has('acc_accounts')) out.noi = safe(() => h.ledger.profitLoss({ from: a, to: b }).result);
    return out;
  }

  function collect(ym) {
    const a = `${ym}-01`;
    const b = end(ym);
    const asOf = ym === thisYm() ? M.today() : b;
    const R = { ym, a, b, asOf, now: headline(ym), prev: headline(C.ymAdd(ym, -1)), ly: headline(C.ymAdd(ym, -12)), gla: gla() };
    const six = C.ymRange(C.ymAdd(ym, -5), ym);

    // income
    if (has('invoices')) {
      R.billedByKind = db.all("SELECT kind, COALESCE(SUM(total), 0) total, COALESCE(SUM(paid), 0) paid, COUNT(*) n FROM invoices WHERE status != 'void' AND due_date >= ? AND due_date <= ? GROUP BY kind ORDER BY total DESC", a, b);
      R.trend = six.map((m) => ({ ym: m, ...headline(m) }));
    }
    if (has('payments')) R.collectedByKind = db.all("SELECT COALESCE(i.kind, 'other') kind, COALESCE(SUM(p.amount), 0) amount FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.status = 'received' AND COALESCE(p.method, '') NOT IN ('writeoff', 'deposit') AND p.date >= ? AND p.date <= ? GROUP BY 1 ORDER BY amount DESC", a, b);
    if (h.ledger && has('acc_accounts')) R.pl = safe(() => h.ledger.profitLoss({ from: a, to: b }));

    // occupancy and leasing
    if (has('leases') && R.gla) {
      const live = inForce(b);
      R.leased = live.reduce((s, l) => s + area(l.id), 0);
      const later = db.all("SELECT * FROM leases WHERE (status = 'active' AND start_date > ?) OR (status = 'draft' AND signed_at IS NOT NULL AND end_date >= ?)", b, b);
      R.committed = R.leased + later.reduce((s, l) => s + area(l.id), 0);
      const yrs = live.reduce((s, l) => s + area(l.id) * Math.max(0, (Date.parse(l.end_date) - Date.parse(b)) / (365.25 * 86400000)), 0);
      R.wale = R.leased ? yrs / R.leased : null;
      R.newLeases = db.all("SELECT l.*, br.name brand_name FROM leases l JOIN brands br ON br.id = l.brand_id WHERE l.status != 'draft' AND substr(COALESCE(l.signed_at, l.created_at), 1, 7) = ? ORDER BY l.start_date", ym)
        .map((l) => ({ ...l, area: area(l.id), annual: safe(() => M.currentAnnualRent(db, l), 0) }));
      R.expiring = db.all("SELECT l.*, br.name brand_name FROM leases l JOIN brands br ON br.id = l.brand_id WHERE l.status = 'active' AND l.end_date > ? AND l.end_date <= ? ORDER BY l.end_date", b, M.addDays(b, 365))
        .map((l) => ({ ...l, area: area(l.id) }));
    }

    // collections
    if (has('invoices')) {
      const open = db.all("SELECT i.*, br.name brand_name FROM invoices i LEFT JOIN brands br ON br.id = i.brand_id WHERE i.status IN ('open','partial') AND i.due_date <= ?", asOf);
      const buckets = BUCKETS.map(() => 0);
      const byBrand = new Map();
      for (const i of open) {
        const days = Math.max(0, Math.round((Date.parse(asOf) - Date.parse(i.due_date)) / 86400000));
        const due = r2(i.total - i.paid);
        if (due <= 0.004) continue;
        buckets[BUCKETS.findIndex(([x, y]) => days >= x && days <= y)] += due;
        if (days >= 1) {
          const k = i.brand_name || i.customer || '—';
          const e = byBrand.get(k) || { name: k, amount: 0, oldest: 0 };
          e.amount += due;
          e.oldest = Math.max(e.oldest, days);
          byBrand.set(k, e);
        }
      }
      R.aging = buckets;
      R.receivable = buckets.reduce((s, x) => s + x, 0);
      R.overdue = buckets.slice(1).reduce((s, x) => s + x, 0);
      R.over90 = buckets[4];
      R.debtors = [...byBrand.values()].sort((x, y) => y.amount - x.amount).slice(0, 6);
      const billed90 = db.value("SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status != 'void' AND due_date > ? AND due_date <= ?", M.addDays(asOf, -90), asOf);
      R.dso = billed90 ? (R.receivable / billed90) * 90 : null;
      R.rate = R.now.billed ? R.now.billedPaid / R.now.billed : null;
    }

    // tenant sales and what occupancy costs them
    if (has('tenant_sales')) {
      R.salesByBrand = db.all("SELECT s.lease_id, s.amount, s.status, br.name brand_name, br.category FROM tenant_sales s JOIN brands br ON br.id = s.brand_id WHERE s.period = ? AND s.status IN ('submitted','verified') ORDER BY s.amount DESC", ym)
        .map((s) => {
          const l = s.lease_id ? db.get('SELECT * FROM leases WHERE id = ?', s.lease_id) : null;
          const m2 = l ? area(l.id) : 0;
          const cost = l ? safe(() => M.currentAnnualRent(db, l) / 12 + (l.service_m2 || 0) * m2, 0) : 0;
          const ly = db.value("SELECT amount FROM tenant_sales WHERE lease_id = ? AND period = ? AND status IN ('submitted','verified')", s.lease_id, C.ymAdd(ym, -12));
          return { ...s, m2, perM2: m2 ? s.amount / m2 : null, cost, ocr: s.amount ? cost / s.amount : null, ly };
        });
    }

    // footfall
    if (has('footfall')) {
      const days = db.all("SELECT substr(ts_hour, 1, 10) d, SUM(visitors_in) n FROM footfall WHERE substr(ts_hour, 1, 7) = ? GROUP BY d ORDER BY d", ym);
      R.ffDays = days;
      R.ffPeak = days.reduce((m, d) => (!m || d.n > m.n ? d : m), null);
      R.ffAvg = days.length ? days.reduce((s, d) => s + d.n, 0) / days.length : 0;
      const wkend = days.filter((d) => [5, 6].includes(new Date(`${d.d}T12:00:00Z`).getUTCDay()));
      R.ffWeekend = wkend.length && R.ffAvg ? wkend.reduce((s, d) => s + d.n, 0) / wkend.length / R.ffAvg : null;
      R.ffTrend = six.map((m) => ({ ym: m, n: db.value('SELECT COALESCE(SUM(visitors_in), 0) FROM footfall WHERE substr(ts_hour, 1, 7) = ?', m) }));
    }

    // parking
    if (has('pk_sessions')) {
      R.pkVisits = db.value('SELECT COUNT(*) FROM pk_sessions WHERE substr(entry_at, 1, 7) = ?', ym);
      R.pkKinds = db.all('SELECT kind, COUNT(*) n FROM pk_sessions WHERE substr(entry_at, 1, 7) = ? GROUP BY kind ORDER BY n DESC', ym);
      R.pkStay = db.value("SELECT AVG((julianday(exit_at) - julianday(entry_at)) * 1440) FROM pk_sessions WHERE status = 'left' AND exit_at IS NOT NULL AND substr(entry_at, 1, 7) = ?", ym);
      R.pkPaid = has('pk_payments') ? db.value("SELECT COUNT(*) FROM pk_payments WHERE status = 'ok' AND substr(at, 1, 7) = ?", ym) : 0;
    }
    if (has('parking')) {
      const p = db.get('SELECT MAX(occupancy) occ, MAX(capacity) cap FROM parking WHERE substr(ts_hour, 1, 7) = ?', ym);
      const cap = Number(db.setting('parking_capacity')) || (p && p.cap) || 0;
      R.pkPeak = p && p.occ ? { cars: p.occ, cap } : null;
    }

    // operations
    if (has('work_orders')) {
      const resolved = db.all("SELECT * FROM work_orders WHERE resolved_at IS NOT NULL AND substr(resolved_at, 1, 7) = ?", ym);
      R.woOpened = db.value('SELECT COUNT(*) FROM work_orders WHERE substr(created_at, 1, 7) = ?', ym);
      R.woClosed = resolved.length;
      const timed = resolved.filter((w) => w.resolve_due);
      R.woSla = timed.length ? timed.filter((w) => w.resolved_at <= w.resolve_due).length / timed.length : null;
      R.woHours = resolved.length ? resolved.reduce((s, w) => s + (Date.parse(w.resolved_at) - Date.parse(w.created_at)) / 3600000, 0) / resolved.length : null;
      R.woOpen = db.value(`SELECT COUNT(*) FROM work_orders WHERE created_at <= ? AND (resolved_at IS NULL OR resolved_at > ?) AND status NOT IN ('cancelled')`, `${b}T23:59:59`, `${b}T23:59:59`);
      R.woCats = db.all('SELECT category, COUNT(*) n FROM work_orders WHERE substr(created_at, 1, 7) = ? GROUP BY category ORDER BY n DESC LIMIT 5', ym);
    }

    // cheques
    if (has('cheques')) {
      const q = (col, extra = '') => db.get(`SELECT COUNT(*) n, COALESCE(SUM(amount), 0) amount FROM cheques WHERE ${col} >= ? AND ${col} <= ?${extra}`, a, b);
      R.chq = {
        received: q('received_on'), deposited: q('deposited_on'), collected: q('collected_on'), bounced: q('bounced_on'),
        upcoming: db.get("SELECT COUNT(*) n, COALESCE(SUM(amount), 0) amount FROM cheques WHERE status = 'held' AND due_date > ? AND due_date <= ?", b, M.addDays(b, 90)),
        held: db.get("SELECT COUNT(*) n, COALESCE(SUM(amount), 0) amount FROM cheques WHERE status = 'held'"),
      };
    }

    // energy
    if (h.energy && has('nrg_readings')) R.energy = safe(() => h.energy.month(ym));

    R.notes = notes(R);
    return R;
  }

  // ---------- highlights and risks, as plain sentences ----------
  const change = (a, b) => (a === null || a === undefined || !b ? null : (a - b) / b);
  function notes(R) {
    const good = [];
    const risk = [];
    const pct = (x) => ui.pct(Math.abs(x));
    if (R.rate !== null && R.rate !== undefined && R.now.billed) {
      if (R.rate >= 0.9) good.push(tr('own|Collected {pct} of what fell due in the month.', { pct: ui.pct(R.rate) }));
      else if (R.rate < 0.75) risk.push(tr('own|Only {pct} of what fell due in the month has been collected.', { pct: ui.pct(R.rate) }));
    }
    if (R.newLeases && R.newLeases.length) good.push(tn(R.newLeases.length, 'own|{n} new lease signed, adding {area}.', 'own|{n} new leases signed, adding {area}.', { area: ui.m2(R.newLeases.reduce((s, l) => s + l.area, 0)) }));
    const occ = change(R.now.occupancy, R.prev.occupancy);
    if (R.now.occupancy !== undefined && R.prev.occupancy !== undefined && R.now.occupancy - R.prev.occupancy >= 0.01) good.push(tr('own|Occupancy rose to {pct}.', { pct: ui.pct(R.now.occupancy) }));
    else if (occ !== null && R.prev.occupancy - R.now.occupancy >= 0.01) risk.push(tr('own|Occupancy fell to {pct}.', { pct: ui.pct(R.now.occupancy) }));
    const sales = change(R.now.sales, R.prev.sales);
    if (sales !== null && sales >= 0.05) good.push(tr('own|Tenant sales rose {pct} on the month before.', { pct: pct(sales) }));
    else if (sales !== null && sales <= -0.05) risk.push(tr('own|Tenant sales fell {pct} on the month before.', { pct: pct(sales) }));
    const ff = change(R.now.footfall, R.prev.footfall);
    if (ff !== null && ff >= 0.05) good.push(tr('own|Footfall rose {pct} on the month before.', { pct: pct(ff) }));
    else if (ff !== null && ff <= -0.05) risk.push(tr('own|Footfall fell {pct} on the month before.', { pct: pct(ff) }));
    const pk = change(R.now.parking, R.prev.parking);
    if (pk !== null && pk >= 0.1) good.push(tr('own|Parking takings rose {pct} on the month before.', { pct: pct(pk) }));
    if (R.over90 > 0) risk.push(tr('own|{amount} has been overdue for more than 90 days.', { amount: ui.money(R.over90) }));
    if (R.dso !== null && R.dso !== undefined && R.dso > 45) risk.push(tr('own|Tenants take {n} days on average to pay.', { n: Math.round(R.dso) }));
    if (R.chq && R.chq.bounced.n) risk.push(tn(R.chq.bounced.n, 'own|{n} cheque bounced, worth {amount}.', 'own|{n} cheques bounced, worth {amount}.', { amount: ui.money(R.chq.bounced.amount) }));
    const soon = (R.expiring || []).filter((l) => l.end_date <= M.addDays(R.b, 183));
    if (soon.length) risk.push(tn(soon.length, 'own|{n} lease covering {area} ends within six months.', 'own|{n} leases covering {area} end within six months.', { area: ui.m2(soon.reduce((s, l) => s + l.area, 0)) }));
    if (R.woSla !== null && R.woSla !== undefined) {
      if (R.woSla >= 0.95) good.push(tr('own|{pct} of work orders were fixed within the agreed time.', { pct: ui.pct(R.woSla) }));
      else if (R.woSla < 0.85) risk.push(tr('own|Only {pct} of work orders were fixed within the agreed time.', { pct: ui.pct(R.woSla) }));
    }
    for (const s of (R.salesByBrand || []).filter((x) => x.ocr > 0.15).slice(0, 2)) risk.push(tr('own|{brand} pays {pct} of its sales in rent and service charge.', { brand: s.brand_name, pct: ui.pct(s.ocr) }));
    if (R.energy && R.energy.ly && !R.energy.span.partial) {
      const e = change(R.energy.kwh, R.energy.ly);
      if (e !== null && e <= -0.03) good.push(tr('own|The common areas used {pct} less electricity than a year before.', { pct: pct(e) }));
      else if (e !== null && e >= 0.1) risk.push(tr('own|The common areas used {pct} more electricity than a year before.', { pct: pct(e) }));
    }
    return { good: good.slice(0, 6), risk: risk.slice(0, 6) };
  }

  // ---------- the document ----------
  const vs = (a, b, { good = 'up', fmt = null } = {}) => {
    if (a === null || a === undefined || b === null || b === undefined) return '<span class="muted">—</span>';
    if (fmt === 'pts') {
      const d = (a - b) * 100;
      if (Math.abs(d) < 0.05) return '<span class="muted">=</span>';
      return `<span class="${(d >= 0) === (good === 'up') ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} ${ui.esc(tr('own|pts'))}</span>`;
    }
    if (!b) return '<span class="muted">—</span>';
    const d = (a - b) / b;
    return `<span class="${(d >= 0) === (good === 'up') ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}%</span>`;
  };
  const kindLabel = (k) => (Object.hasOwn(M.INVOICE_KINDS, k) ? M.INVOICE_KINDS[k] : tr('kind|Other charge'));
  const short = (ym) => ui.monthName(Number(ym.slice(5, 7)));

  function render(R, { email = false } = {}) {
    const s = db.settings();
    const ym = R.ym;
    const prevL = ui.monthYear(C.ymAdd(ym, -1));
    const lyL = ui.monthYear(C.ymAdd(ym, -12));
    const tiles = [
      ['billed', tr('own|Billed'), (v) => ui.money(v, { compact: true }), 'up'],
      ['collected', tr('own|Collected'), (v) => ui.money(v, { compact: true }), 'up'],
      ['noi', tr('own|Net operating income'), (v) => ui.money(v, { compact: true }), 'up'],
      ['occupancy', tr('own|Occupancy'), (v) => ui.pct(v, 1), 'up', 'pts'],
      ['sales', tr('own|Tenant sales'), (v) => ui.money(v, { compact: true }), 'up'],
      ['footfall', tr('own|Visitors'), (v) => ui.n0(v), 'up'],
      ['parking', tr('own|Parking takings'), (v) => ui.money(v, { compact: true }), 'up'],
    ].filter(([k]) => R.now[k] !== undefined && R.now[k] !== null);
    const summary = `<div class="own-kpis">${tiles.map(([k, label, f, good, fmt]) => `<div class="own-kpi"><p>${ui.esc(label)}</p><b>${f(R.now[k])}</b><small>${vs(R.now[k], R.prev[k], { good, fmt })} ${ui.esc(tr('own|vs {month}', { month: prevL }))}</small><small>${vs(R.now[k], R.ly[k], { good, fmt })} ${ui.esc(tr('own|vs {month}', { month: lyL }))}</small></div>`).join('')}</div>`;
    const notesHtml = `<div class="own-notes"><div><h3>${ui.esc(tr('own|Highlights'))}</h3>${R.notes.good.length ? `<ul>${R.notes.good.map((x) => `<li>${ui.esc(x)}</li>`).join('')}</ul>` : `<p class="muted">${ui.esc(tr('own|Nothing stands out this month.'))}</p>`}</div><div class="is-risk"><h3>${ui.esc(tr('own|Risks to watch'))}</h3>${R.notes.risk.length ? `<ul>${R.notes.risk.map((x) => `<li>${ui.esc(x)}</li>`).join('')}</ul>` : `<p class="muted">${ui.esc(tr('own|No risks flagged this month.'))}</p>`}</div></div>`;
    const sec = (title, inner, cls = '') => (inner ? `<section class="own-sec ${cls}"><h2>${ui.esc(title)}</h2>${inner}</section>` : '');
    const t2 = (rows, head = null, foot = null) => `<table class="doc__t">${head ? `<thead><tr>${head.map((x, i) => `<th${i ? ' class="num"' : ''}>${ui.esc(x)}</th>`).join('')}</tr></thead>` : ''}<tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td class="num">${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('')}</tbody>${foot ? `<tfoot><tr>${foot.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr></tfoot>` : ''}</table>`;

    // income
    let income = '';
    if (R.billedByKind) {
      const coll = new Map((R.collectedByKind || []).map((x) => [x.kind, x.amount]));
      const kinds = [...new Set([...R.billedByKind.map((x) => x.kind), ...coll.keys()])];
      const rows = kinds.map((k) => {
        const b = R.billedByKind.find((x) => x.kind === k) || { total: 0, paid: 0 };
        return [ui.esc(kindLabel(k)), ui.money(b.total), ui.money(coll.get(k) || 0), b.total ? ui.pct(b.paid / b.total) : '—'];
      });
      const tb = R.billedByKind.reduce((x, r) => x + r.total, 0);
      const tc = [...coll.values()].reduce((x, v) => x + v, 0);
      const chart = R.trend && R.trend.some((x) => x.billed) ? `<figure class="own-fig"><figcaption>${ui.esc(tr('own|Billed and collected, last six months'))}</figcaption>${ui.bars(R.trend.map((x) => ({ label: short(x.ym), v: Math.round(x.collected || 0), b: Math.round(x.billed || 0) })), { key: 'v', label: 'label', compare: 'b', h: 130, fmtv: (v) => ui.money(v, { compact: true, cur: false }), tone: 'forest' })}<ul class="legend legend--row"><li><i class="t-forest"></i><span>${ui.esc(tr('own|Collected'))}</span></li><li><i class="x-ghost"></i><span>${ui.esc(tr('own|Billed'))}</span></li></ul></figure>` : '';
      const donut = tb ? `<figure class="own-fig">${ui.donut(R.billedByKind.filter((x) => x.total > 0).map((x) => ({ label: kindLabel(x.kind), value: Math.round(x.total), display: ui.money(x.total, { compact: true, cur: false }) })), { size: 120, label: ui.money(tb, { compact: true, cur: false }) })}</figure>` : '';
      income = `${t2(rows, [tr('own|Charge'), tr('own|Billed'), tr('own|Collected in the month'), tr('own|Paid so far')], [ui.esc(tr('own|Total')), ui.money(tb), ui.money(tc), tb ? ui.pct(R.now.billedPaid / tb) : '—'])}
        <div class="own-row">${chart}${donut}</div>`;
      if (R.pl && (R.pl.totalIncome || R.pl.totalExpense)) {
        const name = (a) => (h.ledger.name ? h.ledger.name(a) : a.name_en);
        const top = [...R.pl.expense].sort((x, y) => y.amount - x.amount).slice(0, 6);
        income += `<h3>${ui.esc(tr('own|Profit and loss (from the ledger)'))}</h3>${t2([
          [ui.esc(tr('own|Income')), ui.money(R.pl.totalIncome)],
          ...top.map((x) => [`<span class="own-ind">${ui.esc(name(x))}</span>`, ui.money(x.amount)]),
          [ui.esc(tr('own|All expenses')), ui.money(R.pl.totalExpense)],
        ], null, [ui.esc(tr('own|Net operating income')), ui.money(R.pl.result)])}`;
      }
    }

    // occupancy and leasing
    let leasing = '';
    if (R.leased !== undefined) {
      leasing = `<div class="own-mini">
        <div><p>${ui.esc(tr('own|Gross leasable area'))}</p><b>${ui.m2(R.gla)}</b></div>
        <div><p>${ui.esc(tr('own|Leased'))}</p><b>${ui.m2(R.leased)}</b><small>${ui.pct(R.leased / R.gla, 1)}</small></div>
        <div><p>${ui.esc(tr('own|Committed'))}</p><b>${ui.m2(R.committed)}</b><small>${ui.pct(R.committed / R.gla, 1)}</small></div>
        <div><p>${ui.esc(tr('own|Average lease left (WALE)'))}</p><b>${R.wale === null ? '—' : ui.esc(tr('own|{n} years', { n: R.wale.toFixed(1) }))}</b></div>
      </div>${ui.meter(R.leased / R.gla, 'forest')}
      <h3>${ui.esc(tr('own|New leases'))}</h3>${R.newLeases.length ? t2(R.newLeases.map((l) => [`${ui.esc(l.brand_name)} <small class="muted"><bdi>${ui.esc(l.ref)}</bdi></small>`, ui.m2(l.area), ui.date(l.start_date), ui.money(l.annual)]), [tr('own|Tenant'), tr('own|Area'), tr('own|Starts'), tr('own|Rent a year')]) : `<p class="muted">${ui.esc(tr('own|No new leases this month.'))}</p>`}
      <h3>${ui.esc(tr('own|Leases ending in the next 12 months'))}</h3>${R.expiring.length ? t2(R.expiring.map((l) => [`${ui.esc(l.brand_name)} <small class="muted"><bdi>${ui.esc(l.ref)}</bdi></small>`, ui.m2(l.area), ui.date(l.end_date)]), [tr('own|Tenant'), tr('own|Area'), tr('own|Ends')]) : `<p class="muted">${ui.esc(tr('own|No lease ends in the next 12 months.'))}</p>`}`;
    }

    // collections
    let collections = '';
    if (R.aging) {
      const tones = ['forest', 'sand', 'amber', 'cocoa', 'rose'];
      collections = `<div class="own-mini">
        <div><p>${ui.esc(tr('own|Owed by tenants'))}</p><b>${ui.money(R.receivable)}</b></div>
        <div><p>${ui.esc(tr('own|Overdue'))}</p><b>${ui.money(R.overdue)}</b></div>
        <div><p>${ui.esc(tr('own|Over 90 days'))}</p><b>${ui.money(R.over90)}</b></div>
        <div><p>${ui.esc(tr('own|Days to pay (DSO)'))}</p><b>${R.dso === null ? '—' : ui.n0(R.dso)}</b></div>
      </div>
      <div class="own-row own-row--wide"><figure class="own-fig">${R.receivable ? ui.donut(BUCKETS.map(([, , l], i) => ({ label: tr(l), value: Math.round(R.aging[i]), tone: tones[i], display: ui.money(R.aging[i], { compact: true, cur: false }) })), { size: 120, label: ui.money(R.receivable, { compact: true, cur: false }) }) : `<p class="muted">${ui.esc(tr('own|Nothing owed.'))}</p>`}</figure>
      <div>${R.debtors.length ? t2(R.debtors.map((d) => [ui.esc(d.name), ui.money(d.amount), ui.esc(tn(d.oldest, 'own|{n} day', 'own|{n} days'))]), [tr('own|Largest overdue balances'), tr('own|Overdue'), tr('own|Oldest')]) : `<p class="muted">${ui.esc(tr('own|No tenant is behind.'))}</p>`}</div></div>
      <p class="doc__small">${ui.esc(tr('own|Balances as on {date}, with what has been paid since.', { date: ui.date(R.asOf) }))}</p>`;
    }

    // tenant sales
    let sales = '';
    if (R.salesByBrand) {
      const tot = R.salesByBrand.reduce((x, r) => x + r.amount, 0);
      const cost = R.salesByBrand.reduce((x, r) => x + r.cost, 0);
      sales = R.salesByBrand.length ? `${t2(R.salesByBrand.map((r) => [ui.esc(r.brand_name), ui.money(r.amount), r.perM2 === null ? '—' : ui.money(r.perM2), r.ocr === null ? '—' : `<span class="${r.ocr > 0.15 ? 'down' : ''}">${ui.pct(r.ocr, 1)}</span>`, vs(r.amount, r.ly)]),
        [tr('own|Tenant'), tr('own|Sales'), tr('own|Per m²'), tr('own|Occupancy cost'), tr('own|vs last year')],
        [ui.esc(tr('own|Total')), ui.money(tot), '', cost && tot ? ui.pct(cost / tot, 1) : '—', vs(tot, R.ly.sales)])}
        <p class="doc__small">${ui.esc(tr('own|Occupancy cost is the month\'s rent and service charge as a share of sales; above 15% is a warning sign.'))}${R.now.footfall && tot ? ` ${ui.esc(tr('own|Sales per visitor: {amount}.', { amount: ui.money(tot / R.now.footfall) }))}` : ''}</p>` : `<p class="muted">${ui.esc(tr('own|No sales reported for this month yet.'))}</p>`;
    }

    // footfall
    let footfall = '';
    if (R.ffDays) {
      footfall = R.now.footfall ? `<div class="own-mini">
        <div><p>${ui.esc(tr('own|Visitors'))}</p><b>${ui.n0(R.now.footfall)}</b><small>${vs(R.now.footfall, R.prev.footfall)} ${ui.esc(tr('own|vs {month}', { month: prevL }))}</small></div>
        <div><p>${ui.esc(tr('own|A day on average'))}</p><b>${ui.n0(R.ffAvg)}</b></div>
        <div><p>${ui.esc(tr('own|Busiest day'))}</p><b>${R.ffPeak ? ui.n0(R.ffPeak.n) : '—'}</b><small>${R.ffPeak ? ui.date(R.ffPeak.d) : ''}</small></div>
        <div><p>${ui.esc(tr('own|Weekends'))}</p><b>${R.ffWeekend ? `×${R.ffWeekend.toFixed(2)}` : '—'}</b><small>${ui.esc(tr('own|of an average day'))}</small></div>
      </div><figure class="own-fig"><figcaption>${ui.esc(tr('own|Visitors, last six months'))}</figcaption>${ui.bars(R.ffTrend.map((x) => ({ label: short(x.ym), v: x.n })), { key: 'v', label: 'label', h: 110, fmtv: (v) => ui.money(v, { compact: true, cur: false }), tone: 'sea' })}</figure>` : `<p class="muted">${ui.esc(tr('own|No visitor counts for this month.'))}</p>`;
    }

    // parking
    let parking = '';
    if (R.pkVisits !== undefined) {
      const KIND = { visitor: 'own|Visitors', subscriber: 'own|Subscribers', staff: 'own|Staff', valet: 'own|Valet', booking: 'own|Bookings', company: 'own|Company accounts', tenant: 'own|Tenants', vip: 'own|VIP' };
      parking = `<div class="own-mini">
        <div><p>${ui.esc(tr('own|Cars'))}</p><b>${ui.n0(R.pkVisits)}</b><small>${ui.esc(R.pkKinds.slice(0, 3).map((k) => `${tr(KIND[k.kind] || 'own|Other')} ${ui.n0(k.n)}`).join(' · '))}</small></div>
        <div><p>${ui.esc(tr('own|Takings'))}</p><b>${ui.money(R.now.parking || 0)}</b><small>${vs(R.now.parking, R.prev.parking)} ${ui.esc(tr('own|vs {month}', { month: prevL }))}</small></div>
        <div><p>${ui.esc(tr('own|Average stay'))}</p><b>${R.pkStay ? ui.esc(tr('own|{h} h {m} min', { h: Math.floor(R.pkStay / 60), m: Math.round(R.pkStay % 60) })) : '—'}</b></div>
        <div><p>${ui.esc(tr('own|Fullest hour'))}</p><b>${R.pkPeak ? `${ui.n0(R.pkPeak.cars)}${R.pkPeak.cap ? ` / ${ui.n0(R.pkPeak.cap)}` : ''}` : '—'}</b></div>
      </div>`;
    }

    // operations
    let ops = '';
    if (R.woOpened !== undefined) {
      const CAT = (c) => tr(WO_CATS[c] || 'own|Other');
      ops = `<div class="own-mini">
        <div><p>${ui.esc(tr('own|Work orders opened'))}</p><b>${ui.n0(R.woOpened)}</b><small>${ui.esc(R.woCats.slice(0, 3).map((c) => `${CAT(c.category)} ${c.n}`).join(' · '))}</small></div>
        <div><p>${ui.esc(tr('own|Fixed'))}</p><b>${ui.n0(R.woClosed)}</b></div>
        <div><p>${ui.esc(tr('own|Fixed on time'))}</p><b>${R.woSla === null ? '—' : ui.pct(R.woSla)}</b></div>
        <div><p>${ui.esc(tr('own|Average time to fix'))}</p><b>${R.woHours === null ? '—' : ui.esc(tr('own|{n} hours', { n: ui.n0(R.woHours) }))}</b><small>${ui.esc(tr('own|{n} still open at the month end', { n: R.woOpen }))}</small></div>
      </div>`;
    }

    // cheques
    let cheques = '';
    if (R.chq) {
      const c = R.chq;
      cheques = t2([
        [ui.esc(tr('own|Received')), ui.n0(c.received.n), ui.money(c.received.amount)],
        [ui.esc(tr('own|Deposited')), ui.n0(c.deposited.n), ui.money(c.deposited.amount)],
        [ui.esc(tr('own|Cleared')), ui.n0(c.collected.n), ui.money(c.collected.amount)],
        [`<span class="${c.bounced.n ? 'down' : ''}">${ui.esc(tr('own|Bounced'))}</span>`, ui.n0(c.bounced.n), ui.money(c.bounced.amount)],
        [ui.esc(tr('own|Due in the next 90 days')), ui.n0(c.upcoming.n), ui.money(c.upcoming.amount)],
      ], [tr('own|Cheques'), tr('own|Number'), tr('own|Amount')]);
    }

    // energy
    let energy = '';
    if (R.energy && R.energy.kwh) {
      const e = R.energy;
      energy = `<div class="own-mini">
        <div><p>${ui.esc(tr('own|Common-area electricity'))}</p><b>${ui.n0(e.kwh)} <small>${ui.esc(tr('nrg|kWh'))}</small></b><small>${vs(e.kwh, e.ly, { good: 'down' })} ${ui.esc(tr('own|vs {month}', { month: lyL }))}</small></div>
        <div><p>${ui.esc(tr('own|Cost'))}</p><b>${ui.money(e.cost)}</b><small>${ui.esc(tr('nrg|{amount} per m² of GLA', { amount: ui.money(e.costM2) }))}</small></div>
        <div><p>${ui.esc(tr('own|Peak demand'))}</p><b>${e.peak ? `${ui.n0(e.peak.kw)} ${ui.esc(tr('nrg|kW'))}` : '—'}</b></div>
        <div><p>${ui.esc(tr('own|Carbon'))}</p><b>${ui.n0(Math.round(e.co2 * 10) / 10)} <small>${ui.esc(tr('nrg|t CO₂e'))}</small></b></div>
      </div>`;
    }

    const self = '/admin/owner-report/print';
    return `<main class="doc own-doc">
  ${email ? '' : `<div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="/admin/owner-report?m=${ym}">${tr('Back')}</a>${docSwitch(ui, self, i18n.isAr() ? 'ar' : 'en').replace('?doc=', `?m=${ym}&doc=`)}</div>`}
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${ui.esc(tr('own|Owner\'s monthly report'))}</p><p class="doc__ref">${ui.esc(tr('own|Prepared {date}', { date: ui.date(M.today()) }))}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${ui.esc(tx(s.legal_name) || 'The Wave')}</p><h1>${ui.esc(ui.monthYear(ym))}</h1>${ym === thisYm() ? `<p class="muted">${ui.esc(tr('own|Month to date, as on {date}.', { date: ui.date(M.today()) }))}</p>` : ''}</section>
  ${sec(tr('own|Summary'), `${summary}${notesHtml}`, 'own-sec--first')}
  ${sec(tr('own|Income'), income)}
  ${sec(tr('own|Occupancy and leasing'), leasing)}
  ${sec(tr('own|Collections'), collections)}
  ${sec(tr('own|Tenant sales'), sales)}
  ${sec(tr('own|Footfall'), footfall)}
  ${sec(tr('own|Parking'), parking)}
  ${sec(tr('own|Operations'), ops)}
  ${sec(tr('own|Cheques'), cheques)}
  ${sec(tr('own|Energy'), energy)}
  <p class="doc__foot">${ui.esc(tx(s.legal_name))} · ${ui.esc(tx(s.address))}${s.leasing_email ? ` · ${ui.esc(s.leasing_email)}` : ''}</p>
</main>`;
  }
  const pageHtml = (ym, lang) => i18n.run(lang, () => ui.bare({ title: `${tr('own|Owner report')} ${ui.monthYear(ym)}`, body: render(collect(ym)), cls: 'print' }));
  // the attachment: the same report as one self-contained file (the stylesheet inside, no scripts)
  let cssCache = null;
  const css = () => {
    if (cssCache === null) cssCache = safe(() => fs.readFileSync(CSS_FILE, 'utf8'), '');
    return cssCache;
  };
  const fileHtml = (R, lang) => i18n.run(lang, () => `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${ui.esc(`${tr('own|Owner report')} ${ui.monthYear(R.ym)}`)}</title><style>${css()}</style></head><body class="adm print" data-lang="${lang}">${render(R, { email: true })}</body></html>`);

  // ---------- the email ----------
  function emailFor(ym, lang) {
    return i18n.run(lang, () => {
      const R = collect(ym);
      const link = `${siteUrl()}/admin/owner-report/print?m=${ym}&doc=${lang}`;
      const row = (label, v, sub) => `<tr><td style="padding:8px 0;border-bottom:1px solid #e6e1d5;color:#56625d;">${ui.esc(label)}</td><td style="padding:8px 0;border-bottom:1px solid #e6e1d5;text-align:${lang === 'ar' ? 'left' : 'right'};font-weight:600;color:#1e2925;">${v}${sub ? ` <span style="font-weight:400;color:#56625d;font-size:12px;">${sub}</span>` : ''}</td></tr>`;
      const ch = (a, b) => (a === null || a === undefined || !b ? '' : `${a >= b ? '▲' : '▼'} ${Math.abs(((a - b) / b) * 100).toFixed(0)}%`);
      const n = R.now;
      const rows = [
        n.billed !== undefined ? row(tr('own|Billed'), ui.money(n.billed), ch(n.billed, R.prev.billed)) : '',
        n.collected !== undefined ? row(tr('own|Collected'), ui.money(n.collected), ch(n.collected, R.prev.collected)) : '',
        n.noi !== undefined && n.noi !== null ? row(tr('own|Net operating income'), ui.money(n.noi), '') : '',
        n.occupancy !== undefined ? row(tr('own|Occupancy'), ui.pct(n.occupancy, 1), '') : '',
        n.sales !== undefined ? row(tr('own|Tenant sales'), ui.money(n.sales), ch(n.sales, R.prev.sales)) : '',
        n.footfall !== undefined ? row(tr('own|Visitors'), ui.n0(n.footfall), ch(n.footfall, R.prev.footfall)) : '',
        n.parking !== undefined ? row(tr('own|Parking takings'), ui.money(n.parking), ch(n.parking, R.prev.parking)) : '',
      ].join('');
      const list = (items, colour) => (items.length ? `<ul style="margin:6px 0 16px;padding-${lang === 'ar' ? 'right' : 'left'}:18px;color:${colour};">${items.map((x) => `<li style="margin:4px 0;">${ui.esc(x)}</li>`).join('')}</ul>` : '');
      const body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size:14px;">${rows}</table>
        ${R.notes.good.length ? `<p style="margin:18px 0 0;font-weight:600;">${ui.esc(tr('own|Highlights'))}</p>${list(R.notes.good, '#1e2925')}` : ''}
        ${R.notes.risk.length ? `<p style="margin:12px 0 0;font-weight:600;color:#7c4d28;">${ui.esc(tr('own|Risks to watch'))}</p>${list(R.notes.risk, '#7c4d28')}` : ''}
        <p style="margin:14px 0 0;color:#56625d;font-size:12px;">${ui.esc(tr('own|The full report is attached, and opens in any browser.'))}</p>`;
      const subject = tr('own|The Wave · owner report for {month}', { month: ui.monthYear(ym) });
      const html = template({
        lang, eyebrow: tr('own|Owner\'s monthly report'), title: ui.monthYear(ym), preheader: subject,
        intro: ui.esc(tr('own|The month in numbers, against {month}.', { month: ui.monthYear(C.ymAdd(ym, -1)) })), body,
        button: { label: tr('own|Open the report'), url: link }, site: siteUrl(),
      });
      const text = `${subject}\n\n${[...R.notes.good, ...R.notes.risk].map((x) => `- ${x}`).join('\n')}\n\n${link}`;
      return { subject, html, text, attachment: { filename: `owner-report-${ym}-${lang}.html`, content: Buffer.from(fileHtml(R, lang), 'utf8'), contentType: 'text/html; charset=utf-8' } };
    });
  }
  function send(ym, { to = recipients(), lang = setting('own_lang', 'en'), user = null } = {}) {
    if (!h.mail || typeof h.mail.send !== 'function') return { ok: false, error: 'mail' };
    if (!to.length) return { ok: false, error: 'recipients' };
    const langs = lang === 'both' ? ['en', 'ar'] : [lang === 'ar' ? 'ar' : 'en'];
    const sent = langs.map((l) => {
      const m = emailFor(ym, l);
      return h.mail.send({ to, subject: m.subject, html: m.html, text: m.text, attachments: [m.attachment], related: { entity: 'owner_report', id: Number(ym.replace('-', '')) }, user_id: user ? user.id : null, lang: l });
    });
    db.audit(user, 'Sent the owner report', 'owner_report', Number(ym.replace('-', '')), `${ym} · ${to.length} recipients · ${langs.join('+')}`);
    return { ok: true, sent };
  }
  // the monthly run: once the send day comes, last month goes out (once)
  function tick() {
    if (setting('own_enabled', '1') === '0' || !recipients().length) return null;
    const c = cairo();
    const day = Math.min(28, Math.max(1, Number(setting('own_day', '3')) || 3));
    if (Number(c.date.slice(8, 10)) < day) return null;
    const ym = lastYm();
    if (setting('own_last') === ym) return null;
    const r = send(ym);
    if (r.ok) db.setSetting('own_last', ym);
    return r;
  }
  h.every('owner-report', 60 * 60 * 1000, tick, { first: 10 * 60 * 1000 });
  h.ownerReport = { collect, render, send, tick, emailFor, headline };

  // ---------- the office page ----------
  router.get('/owner-report', h.RF, (req, res) => {
    const ym = validYm(req.query.m) ? req.query.m : lastYm();
    const R = collect(ym);
    const csrf = req.session.csrf;
    const months = Array.from({ length: 13 }, (_, i) => C.ymAdd(thisYm(), -i));
    const pick = `<form method="get" action="/admin/owner-report" class="own-pick">${ui.select('m', tr('own|Month'), months.map((m) => [m, ui.monthYear(m)]), ym, { attrs: { 'data-autosubmit': '' } })}${ui.btn(tr('own|Show'), { cls: 'btn--ghost btn--sm' })}</form>`;
    const actions = `<div class="own-acts">
      ${ui.btn(tr('own|Open the report (English)'), { href: `/admin/owner-report/print?m=${ym}&doc=en`, cls: 'btn--primary btn--sm', ic: 'print', attrs: { target: '_blank', rel: 'noopener' } })}
      ${ui.btn(tr('own|Open the report (Arabic)'), { href: `/admin/owner-report/print?m=${ym}&doc=ar`, cls: 'btn--ghost btn--sm', ic: 'print', attrs: { target: '_blank', rel: 'noopener' } })}
      ${ui.form('/admin/owner-report/send', csrf, `<input type="hidden" name="m" value="${ym}">${ui.btn(tr('own|Send now'), { cls: 'btn--ghost btn--sm', ic: 'mail' })}`, { cls: 'own-inline' })}
    </div>`;
    const prevL = ui.monthYear(C.ymAdd(ym, -1));
    const k = (key, label, f, fmt) => (R.now[key] === undefined || R.now[key] === null ? '' : ui.kpi({ label, value: f(R.now[key]), sub: `${vs(R.now[key], R.prev[key], { fmt })} ${ui.esc(tr('own|vs {month}', { month: prevL }))}` }));
    const kpis = `<div class="kpis kpis--3">${[
      k('billed', tr('own|Billed'), (v) => ui.money(v, { compact: true })),
      k('collected', tr('own|Collected'), (v) => ui.money(v, { compact: true })),
      k('occupancy', tr('own|Occupancy'), (v) => ui.pct(v, 1), 'pts'),
      k('sales', tr('own|Tenant sales'), (v) => ui.money(v, { compact: true })),
      k('footfall', tr('own|Visitors'), (v) => ui.n0(v)),
      k('parking', tr('own|Parking takings'), (v) => ui.money(v, { compact: true })),
    ].join('')}</div>`;
    const notesCard = ui.card(tr('own|Highlights and risks'), `<div class="own-notes"><div><h3>${ui.esc(tr('own|Highlights'))}</h3>${R.notes.good.length ? `<ul>${R.notes.good.map((x) => `<li>${ui.esc(x)}</li>`).join('')}</ul>` : `<p class="muted">${ui.esc(tr('own|Nothing stands out this month.'))}</p>`}</div><div class="is-risk"><h3>${ui.esc(tr('own|Risks to watch'))}</h3>${R.notes.risk.length ? `<ul>${R.notes.risk.map((x) => `<li>${ui.esc(x)}</li>`).join('')}</ul>` : `<p class="muted">${ui.esc(tr('own|No risks flagged this month.'))}</p>`}</div></div>`, { sub: ui.esc(tr('own|Written from the month\'s numbers; the same sentences open the report.')) });
    const admin = req.user.role === 'admin';
    const settings = ui.form('/admin/owner-report/settings', csrf, `<div class="fields">
      ${ui.textarea('recipients', tr('own|Send to'), setting('own_recipients'), { rows: 3, placeholder: 'owner@example.com, cfo@example.com' })}
      ${ui.select('lang', tr('own|Language'), Object.entries(LANGS).map(([x, l]) => [x, tr(l)]), setting('own_lang', 'en'))}
      ${ui.input('day', tr('own|Send on day'), setting('own_day', '3'), { type: 'number', min: 1, max: 28, hint: tr('own|of each month, for the month before') })}
      ${ui.select('enabled', tr('own|Monthly email'), [['1', tr('own|On')], ['0', tr('own|Off')]], setting('own_enabled', '1'))}
    </div>${admin ? ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' }) : `<p class="muted small">${ui.esc(tr('own|Only an administrator can change who receives the report.'))}</p>`}`, { cls: 'stack' });
    const last = setting('own_last');
    const next = (() => {
      const c = cairo();
      const day = Math.min(28, Math.max(1, Number(setting('own_day', '3')) || 3));
      const due = last === lastYm() || Number(c.date.slice(8, 10)) >= day ? `${C.ymAdd(thisYm(), 1)}-${String(day).padStart(2, '0')}` : `${thisYm()}-${String(day).padStart(2, '0')}`;
      return due;
    })();
    const status = setting('own_enabled', '1') === '0' ? tr('own|The monthly email is off.') : recipients().length ? tr('own|Next email on {date}.', { date: ui.date(next) }) : tr('own|Add at least one address to start the monthly email.');
    const hist = has('outbox') ? db.all("SELECT * FROM outbox WHERE related_entity = 'owner_report' ORDER BY id DESC LIMIT 8") : [];
    const histTable = ui.table([
      { label: tr('own|Month'), render: (o) => ui.esc(ui.monthYear(`${String(o.related_id).slice(0, 4)}-${String(o.related_id).slice(4)}`)) },
      { label: tr('own|Sent'), render: (o) => ui.esc(ui.rel(o.created_at)) },
      { label: tr('own|To'), render: (o) => `<small>${ui.esc(o.to_addr)}</small>` },
      { label: tr('own|Language'), render: (o) => ui.esc(tr(LANGS[o.lang] || LANGS.en)) },
      { label: tr('own|Status'), render: (o) => ui.badge(o.status, tr(`own|mail ${o.status}`), o.status === 'sent' ? 'ok' : o.status === 'failed' ? 'rose' : 'mute') },
    ], hist, { empty: ui.esc(tr('own|No report sent yet.')) });
    const body = `<div class="own-top">${pick}${actions}</div>
${kpis}
<div class="grid grid--side">
  <div class="stack">${notesCard}${ui.card(tr('own|What the report covers'), `<ol class="own-toc">${['own|Summary', 'own|Income', 'own|Occupancy and leasing', 'own|Collections', 'own|Tenant sales', 'own|Footfall', 'own|Parking', 'own|Operations', 'own|Cheques', 'own|Energy'].map((x) => `<li>${ui.esc(tr(x))}</li>`).join('')}</ol>`, { sub: ui.esc(tr('own|One A4 document, in English or Arabic; a section is left out when the office does not track it.')) })}</div>
  <div class="stack">${ui.card(tr('own|Monthly email'), `${settings}<p class="muted small">${ui.esc(status)}${last ? ` ${ui.esc(tr('own|Last sent for {month}.', { month: ui.monthYear(last) }))}` : ''}</p>`)}${ui.card(tr('own|Sent reports'), histTable)}</div>
</div>`;
    h.page(req, res, { title: tr('nav|Owner report'), crumbs: [['/admin/owner-report', tr('nav|Owner report')], [null, ui.monthYear(ym)]], active: '/admin/owner-report', wide: true, body });
  });
  router.get('/owner-report/print', h.RF, (req, res) => {
    const ym = validYm(req.query.m) ? req.query.m : lastYm();
    res.type('html').send(pageHtml(ym, docLang(req)));
  });
  router.post('/owner-report/settings', h.R('admin'), (req, res) => {
    const list = String(req.body.recipients || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const bad = list.filter((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (bad.length) return h.back(req, res, '/admin/owner-report', 'error', tr('own|Not an email address: {list}', { list: bad.slice(0, 3).join(', ') }));
    db.setSetting('own_recipients', list.slice(0, 20).join(', '));
    db.setSetting('own_lang', LANGS[req.body.lang] ? req.body.lang : 'en');
    db.setSetting('own_day', String(Math.min(28, Math.max(1, h.int(req.body.day) || 3))));
    db.setSetting('own_enabled', req.body.enabled === '0' ? '0' : '1');
    h.log(req, 'Changed the owner report settings', 'setting', null, `${list.length} recipients`);
    h.back(req, res, '/admin/owner-report', 'ok', tr('Saved.'));
  });
  router.post('/owner-report/send', h.RF, (req, res) => {
    const ym = validYm(req.body.m) ? req.body.m : lastYm();
    const r = send(ym, { user: req.user });
    const back = `/admin/owner-report?m=${ym}`;
    if (!r.ok) return h.back(req, res, back, 'error', r.error === 'recipients' ? tr('own|Add at least one address to send the report to.') : tr('own|Email is not available.'));
    h.back(req, res, back, 'ok', tn(recipients().length, 'own|Report for {month} sent to {n} address.', 'own|Report for {month} sent to {n} addresses.', { month: ui.monthYear(ym) }));
  });
};
