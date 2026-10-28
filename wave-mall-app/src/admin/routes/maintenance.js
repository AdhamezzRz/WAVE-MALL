'use strict';

// Maintenance and facilities: the assets register (with warranties and the service contract
// that covers each), work orders with priorities and SLA timers, costs that reach the accounts,
// planned preventive maintenance that raises its own work orders, and tenant requests through
// the tenant portal.

const express = require('express');
const { t: tr, tn, tx } = require('../i18n');
const { tmap, registerDocs, uploadRoute, csvCell, pager } = require('../ops-common');

const SCHEMA = `
  CREATE TABLE assets (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'electrical',
    location TEXT, level TEXT, unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    make TEXT, model TEXT, serial TEXT, install_date TEXT, warranty_until TEXT,
    contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL, criticality TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'in_service', notes TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ppm_plans (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'electrical', priority INTEGER NOT NULL DEFAULT 3,
    every_n INTEGER NOT NULL DEFAULT 1, every_unit TEXT NOT NULL DEFAULT 'month', checklist TEXT,
    next_due TEXT NOT NULL, last_done TEXT, assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL, contractor TEXT,
    active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE work_orders (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
    category TEXT NOT NULL DEFAULT 'electrical', priority INTEGER NOT NULL DEFAULT 3, source TEXT NOT NULL DEFAULT 'staff',
    status TEXT NOT NULL DEFAULT 'new', asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
    unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL, location TEXT, brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    reported_by TEXT, portal_user_id INTEGER, assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL, contractor TEXT,
    contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL, ppm_id INTEGER REFERENCES ppm_plans(id) ON DELETE SET NULL,
    due_date TEXT, checklist TEXT, response_due TEXT, resolve_due TEXT, responded_at TEXT, resolved_at TEXT, closed_at TEXT,
    reopened INTEGER NOT NULL DEFAULT 0, rating INTEGER, rating_note TEXT,
    cost_labour REAL NOT NULL DEFAULT 0, cost_parts REAL NOT NULL DEFAULT 0, cost_contractor REAL NOT NULL DEFAULT 0, minutes INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX work_orders_ppm_due ON work_orders(ppm_id, due_date) WHERE ppm_id IS NOT NULL;
  CREATE INDEX work_orders_status ON work_orders(status, priority);
  CREATE TABLE wo_events (
    id INTEGER PRIMARY KEY, wo_id INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE, kind TEXT NOT NULL,
    body TEXT, status_from TEXT, status_to TEXT, minutes INTEGER, cost_type TEXT, amount REAL, vendor TEXT, date TEXT,
    shared INTEGER NOT NULL DEFAULT 0, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, portal_user_id INTEGER,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX wo_events_wo ON wo_events(wo_id, created_at);
`;

const CATEGORIES = {
  electrical: 'mnt|Electrical', plumbing: 'mnt|Plumbing', hvac: 'mnt|Air conditioning (HVAC)', civil: 'mnt|Civil and finishes',
  cleaning: 'mnt|Cleaning', security: 'mnt|Security systems', it: 'mnt|IT and low current', lifts: 'mnt|Lifts and escalators',
};
const PRIORITY = { 1: 'mnt|P1 · Emergency', 2: 'mnt|P2 · Urgent', 3: 'mnt|P3 · Normal', 4: 'mnt|P4 · Planned' };
const P_TONE = { 1: 'rose', 2: 'amber', 3: 'sky', 4: 'mute' };
const STATUS = {
  new: 'mnt|New', assigned: 'mnt|Assigned', in_progress: 'mnt|In progress', on_hold: 'mnt|On hold',
  resolved: 'mnt|Resolved', closed: 'mnt|Closed', reopened: 'mnt|Reopened',
};
const S_TONE = { new: 'sea', assigned: 'sky', in_progress: 'amber', on_hold: 'cocoa', resolved: 'ok', closed: 'mute', reopened: 'rose' };
const OPEN = ['new', 'assigned', 'in_progress', 'on_hold', 'reopened'];
const NEXT = {
  new: ['assigned', 'in_progress', 'on_hold', 'resolved'],
  assigned: ['in_progress', 'on_hold', 'resolved'],
  in_progress: ['on_hold', 'resolved'],
  on_hold: ['in_progress', 'resolved'],
  reopened: ['assigned', 'in_progress', 'on_hold', 'resolved'],
  resolved: ['closed', 'reopened'],
  closed: ['reopened'],
};
const SOURCES = { staff: 'mnt|Staff', tenant: 'mnt|Tenant', ppm: 'mnt|Preventive plan' };
const CRIT = { high: 'mnt|High', medium: 'mnt|Medium', low: 'mnt|Low' };
const C_TONE = { high: 'rose', medium: 'amber', low: 'mute' };
const A_STATUS = { in_service: 'mnt|In service', out_of_service: 'mnt|Out of service', retired: 'mnt|Retired' };
const UNITS = { day: ['mnt|Every day', 'mnt|Every {n} days'], week: ['mnt|Every week', 'mnt|Every {n} weeks'], month: ['mnt|Every month', 'mnt|Every {n} months'] };
const COSTS = { labour: 'mnt|Labour', parts: 'mnt|Parts and materials', contractor: 'mnt|Contractor' };
// default SLA targets in hours: [response, resolution]
const SLA_DEFAULT = { 1: [1, 4], 2: [4, 24], 3: [24, 72], 4: [72, 240] };
// tenants pick an urgency, which sets the priority
const URGENCY = { 1: 'mnt|Emergency: safety risk or the store cannot trade', 2: 'mnt|Urgent: affecting customers today', 3: 'mnt|Normal: in the next few days', 4: 'mnt|Low: when convenient' };
const PPM_LOOKAHEAD = 7;

// ---------- pure helpers (exported for tests) ----------
const HOUR = 3600000;
const plusHours = (iso, hrs) => new Date(Date.parse(iso) + hrs * HOUR).toISOString();
// SLA state of a work order at a moment. Each of response and resolution: met, ok, due (within
// a quarter of its window), breached (late, open or closed).
function sla(wo, now = new Date().toISOString()) {
  const one = (due, done, start) => {
    if (!due) return { state: 'none' };
    if (done) return { state: done > due ? 'breached' : 'met', due, done };
    if (now > due) return { state: 'breached', due, overBy: Date.parse(now) - Date.parse(due) };
    const left = Date.parse(due) - Date.parse(now);
    const window = Math.max(1, Date.parse(due) - Date.parse(start || now));
    return { state: left < window / 4 ? 'due' : 'ok', due, left };
  };
  const response = one(wo.response_due, wo.responded_at, wo.created_at);
  const resolution = one(wo.resolve_due, wo.resolved_at, wo.created_at);
  return { response, resolution, breached: response.state === 'breached' || resolution.state === 'breached' };
}
// the next due date of a plan after a date
function nextDue(from, n, unit) {
  const k = Math.max(1, Number(n) || 1);
  if (unit === 'day') return new Date(Date.parse(from) + k * 86400000).toISOString().slice(0, 10);
  if (unit === 'week') return new Date(Date.parse(from) + k * 7 * 86400000).toISOString().slice(0, 10);
  const [y, m, d] = from.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
// SQL: open and late on response or resolution (parameter: now)
const BREACHED_SQL = "(w.status IN ('new','assigned','in_progress','on_hold','reopened') AND ((w.responded_at IS NULL AND w.response_due < ?) OR w.resolve_due < ?))";

function ensure(db) {
  db.ensure('maintenance-1', SCHEMA);
}

// Create the work orders that preventive plans have coming up. One per plan and due date, ever.
function generatePpm(db, { today, user = null, lookahead = PPM_LOOKAHEAD } = {}) {
  const horizon = new Date(Date.parse(today) + lookahead * 86400000).toISOString().slice(0, 10);
  let made = 0;
  for (const p of db.all('SELECT p.*, a.unit_id, a.location, a.contract_id, a.level FROM ppm_plans p LEFT JOIN assets a ON a.id = p.asset_id WHERE p.active = 1 AND p.next_due <= ?', horizon)) {
    let due = p.next_due;
    let guard = 0;
    db.tx(() => {
      while (due <= horizon && guard++ < 6) {
        const exists = db.get('SELECT id FROM work_orders WHERE ppm_id = ? AND due_date = ?', p.id, due);
        if (!exists) {
          const end = `${due}T20:00:00.000Z`; // the end of the working day in Cairo
          const created = new Date().toISOString();
          db.run(
            `INSERT INTO work_orders (ref, title, description, category, priority, source, status, asset_id, unit_id, location, assignee_id, contractor, contract_id, ppm_id, due_date, checklist,
             response_due, resolve_due, responded_at, created_by, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ppm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
            db.nextRef('work_orders', 'WO', 4, true), p.title, 'Planned preventive maintenance', p.category, p.priority, p.assignee_id || p.contractor ? 'assigned' : 'new',
            p.asset_id, p.unit_id, p.location || p.level || null, p.assignee_id, p.contractor, p.contract_id, p.id, due, p.checklist,
            end, end, p.assignee_id || p.contractor ? created : null, user ? user.id : null, p.demo, created, created,
          );
          made++;
        }
        due = nextDue(due, p.every_n, p.every_unit);
      }
      db.run('UPDATE ppm_plans SET next_due = ?, updated_at = ? WHERE id = ?', due, new Date().toISOString(), p.id);
    });
  }
  return made;
}

module.exports = function maintenance(router, h) {
  const { db, ui, M } = h;
  const R = h.R;
  ensure(db);
  registerDocs(M, 'asset', 'mnt|Asset', { asset_photo: 'mnt|Photo', asset_manual: 'mnt|Manual or datasheet', asset_cert: 'mnt|Inspection certificate' });
  registerDocs(M, 'work_order', 'mnt|Work order', { wo_photo: 'mnt|Photo', wo_report: 'mnt|Service report', wo_quote: 'mnt|Quotation' });
  const panel = uploadRoute(router, h, '/maintenance/files', { asset: 'assets', work_order: 'work_orders' });

  const now = () => new Date().toISOString();
  const today = () => M.today();
  const cats = () => tmap(CATEGORIES);
  const pris = () => tmap(PRIORITY);
  const statuses = () => tmap(STATUS);
  const sBadge = (s) => ui.badge(s, tr(STATUS[s]), S_TONE[s]);
  const pBadge = (p) => ui.badge(`p${p}`, tr(`mnt|P${p}`), P_TONE[p]);
  const slaHours = () => {
    let v = {};
    try { v = JSON.parse(db.setting('maintenance_sla') || '{}'); } catch { v = {}; }
    return Object.fromEntries([1, 2, 3, 4].map((p) => [p, Array.isArray(v[p]) && v[p].length === 2 ? v[p].map(Number) : SLA_DEFAULT[p]]));
  };
  const dueTimes = (priority, from) => {
    const [a, b] = slaHours()[priority] || SLA_DEFAULT[3];
    return { response_due: plusHours(from, a), resolve_due: plusHours(from, b) };
  };
  const generate = (user = null) => generatePpm(db, { today: today(), user });
  h.every('maintenance-ppm', 60 * 60 * 1000, () => generate(), { first: 30 * 1000 });

  h.count('maintenance', () => {
    const t = now();
    return db.value(`SELECT COUNT(*) FROM work_orders w WHERE w.status IN ('new','assigned','in_progress','on_hold','reopened') AND (w.priority <= 2 OR ${BREACHED_SQL})`, t, t);
  });

  const woOf = (id) => db.get(
    `SELECT w.*, a.code asset_code, a.name asset_name, u.code unit_code, b.name brand_name, us.name assignee, c.ref contract_ref, c.counterparty contract_party,
     p.title ppm_title, cr.name author FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN units u ON u.id = w.unit_id
     LEFT JOIN brands b ON b.id = w.brand_id LEFT JOIN users us ON us.id = w.assignee_id LEFT JOIN contracts c ON c.id = w.contract_id
     LEFT JOIN ppm_plans p ON p.id = w.ppm_id LEFT JOIN users cr ON cr.id = w.created_by WHERE w.id = ?`, id);
  const where = (w) => [w.unit_code, w.asset_code ? `${w.asset_code} · ${tx(w.asset_name)}` : null, w.location ? tx(w.location) : null].filter(Boolean).join(' · ') || '—';
  const who = (w) => w.assignee || (w.contractor ? tx(w.contractor) : null) || (w.contract_party || null);
  const totalCost = (w) => (w.cost_labour || 0) + (w.cost_parts || 0) + (w.cost_contractor || 0);
  const tabs = (on, req) => `<nav class="tabs">${[['/admin/maintenance', tr('mnt|Overview')], ['/admin/maintenance/orders', tr('mnt|Work orders')], ['/admin/maintenance/assets', tr('mnt|Assets')], ['/admin/maintenance/ppm', tr('mnt|Preventive')], ...(h.can(req, 'manager') ? [['/admin/maintenance/settings', tr('mnt|SLA targets')]] : [])]
    .map(([href, l]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${ui.esc(l)}</a>`).join('')}</nav>`;
  const crumbs = (...rest) => [['/admin/maintenance', tr('nav|Maintenance')], ...rest];
  // time left or late, readable
  const span = (ms) => {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 60) return tn(m, 'mnt|{n} min', 'mnt|{n} min');
    const hrs = Math.round(m / 60);
    if (hrs < 48) return tn(hrs, 'mnt|{n} hour', 'mnt|{n} hours');
    return tn(Math.round(hrs / 24), 'mnt|{n} day', 'mnt|{n} days');
  };
  const slaChip = (w) => {
    if (!OPEN.includes(w.status)) {
      const s = sla(w);
      return s.breached ? ui.badge('late', tr('mnt|SLA missed'), 'rose') : ui.badge('met', tr('mnt|SLA met'), 'ok');
    }
    const s = sla(w);
    if (s.breached) {
      const late = s.resolution.state === 'breached' ? s.resolution : s.response;
      return ui.badge('late', tr('mnt|Late by {time}', { time: span(late.overBy || 0) }), 'rose');
    }
    const next = w.status === 'new' || !w.responded_at ? s.response : s.resolution;
    if (next.state === 'none') return '';
    return ui.badge(next.state === 'due' ? 'due' : 'ok', w.status === 'new' || !w.responded_at ? tr('mnt|Respond within {time}', { time: span(next.left) }) : tr('mnt|Fix within {time}', { time: span(next.left) }), next.state === 'due' ? 'amber' : 'mute');
  };
  const ago = (iso) => ui.rel(iso);

  function addEvent(woId, e, req) {
    db.run('INSERT INTO wo_events (wo_id, kind, body, status_from, status_to, minutes, cost_type, amount, vendor, date, shared, user_id, portal_user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      woId, e.kind, e.body || null, e.from || null, e.to || null, e.minutes || null, e.cost_type || null, e.amount ?? null, e.vendor || null, e.date || null, e.shared ? 1 : 0,
      req && req.user ? req.user.id : null, e.portal_user_id || null, e.demo ? 1 : 0, e.at || now());
  }

  // Move a work order to a new status (staff or the system). Returns an error text or null.
  function move(w, to, { req = null, note = null } = {}) {
    if (!(NEXT[w.status] || []).includes(to)) return tr('mnt|A work order cannot go from {a} to {b}.', { a: tr(STATUS[w.status]), b: tr(STATUS[to]) });
    const t = now();
    const set = { status: to, updated_at: t };
    if (!w.responded_at && to !== 'resolved' && w.status !== 'resolved' && w.status !== 'closed') set.responded_at = t;
    if (to === 'resolved') { set.resolved_at = t; if (!w.responded_at) set.responded_at = t; }
    if (to === 'closed') set.closed_at = t;
    if (to === 'reopened') { set.resolved_at = null; set.closed_at = null; set.reopened = (w.reopened || 0) + 1; set.rating = null; set.rating_note = null; }
    const keys = Object.keys(set);
    db.tx(() => {
      db.run(`UPDATE work_orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), w.id);
      addEvent(w.id, { kind: 'status', from: w.status, to, body: note, shared: true }, req);
      if (to === 'resolved' && w.ppm_id) db.run('UPDATE ppm_plans SET last_done = ? WHERE id = ? AND (last_done IS NULL OR last_done < ?)', today(), w.ppm_id, today());
    });
    if (req) h.log(req, 'Work order status changed', 'work_order', w.id, `${w.ref} · ${w.status} → ${to}`);
    h.events.emit('work_order.status', { work_order: db.get('SELECT * FROM work_orders WHERE id = ?', w.id), from: w.status, to });
    return null;
  }

  // Record a cost: totals on the work order, and an expense for the accounts.
  function addCost(w, { type, amount, vendor, date, memo }, req) {
    const col = { labour: 'cost_labour', parts: 'cost_parts', contractor: 'cost_contractor' }[type];
    db.tx(() => {
      db.run(`UPDATE work_orders SET ${col} = ${col} + ?, updated_at = ? WHERE id = ?`, amount, now(), w.id);
      addEvent(w.id, { kind: 'cost', cost_type: type, amount, vendor, date, body: memo, demo: w.demo }, req);
    });
    const eventId = db.value('SELECT MAX(id) FROM wo_events WHERE wo_id = ? AND kind = ?', w.id, 'cost');
    h.events.emit('expense.incurred', {
      date, amount, vendor: vendor || (w.contract_party || 'Maintenance supplier'), category: 'maintenance', source: 'work_order', source_id: eventId,
      memo: `${w.ref} · ${w.title}${memo ? ` · ${memo}` : ''} (${type})`, work_order_id: w.id, demo: w.demo ? 1 : 0,
    });
  }
  h.maintenance = { move, addCost, addEvent, generate, sla, nextDue };

  // ---------- overview ----------
  router.get('/maintenance', (req, res) => {
    generate(req.user);
    const t = now();
    const d = today();
    const open = db.value("SELECT COUNT(*) FROM work_orders w WHERE w.status IN ('new','assigned','in_progress','on_hold','reopened')");
    const breached = db.all(`SELECT w.*, a.code asset_code, a.name asset_name, u.code unit_code, us.name assignee FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN units u ON u.id = w.unit_id
      LEFT JOIN users us ON us.id = w.assignee_id WHERE ${BREACHED_SQL} ORDER BY w.priority, w.resolve_due LIMIT 50`, t, t);
    const urgent = db.all(`SELECT w.*, a.code asset_code, a.name asset_name, u.code unit_code, us.name assignee FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN units u ON u.id = w.unit_id
      LEFT JOIN users us ON us.id = w.assignee_id WHERE w.status IN ('new','assigned','in_progress','on_hold','reopened') ORDER BY w.priority, w.resolve_due LIMIT 8`);
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const fixed = db.all("SELECT created_at, resolved_at FROM work_orders WHERE resolved_at IS NOT NULL AND resolved_at >= ? AND source != 'ppm'", since);
    const mttr = fixed.length ? fixed.reduce((s, w) => s + (Date.parse(w.resolved_at) - Date.parse(w.created_at)), 0) / fixed.length : null;
    const ppmDue = db.all("SELECT due_date, resolved_at, status FROM work_orders WHERE ppm_id IS NOT NULL AND due_date <= ? AND due_date >= ?", d, M.addDays(d, -90));
    const onTime = ppmDue.filter((w) => w.resolved_at && w.resolved_at.slice(0, 10) <= w.due_date).length;
    const compliance = ppmDue.length ? onTime / ppmDue.length : null;
    const m0 = `${d.slice(0, 7)}-01`;
    const costs = db.all(`SELECT w.category, SUM(e.amount) amount FROM wo_events e JOIN work_orders w ON w.id = e.wo_id WHERE e.kind = 'cost' AND e.date >= ? AND e.date <= ? GROUP BY w.category ORDER BY amount DESC`, m0, d);
    const costTotal = costs.reduce((s, c) => s + c.amount, 0);
    const byStatus = db.all("SELECT status, COUNT(*) n FROM work_orders WHERE status IN ('new','assigned','in_progress','on_hold','reopened') GROUP BY status");
    const satisfaction = db.get('SELECT AVG(rating) avg, COUNT(*) n FROM work_orders WHERE rating IS NOT NULL AND resolved_at >= ?', new Date(Date.now() - 90 * 86400000).toISOString());

    const kpis = [
      ui.kpi({ label: tr('mnt|Open work orders'), value: ui.n0(open), href: '/admin/maintenance/orders', sub: ui.esc(tr('mnt|{n} urgent or emergency', { n: db.value("SELECT COUNT(*) FROM work_orders WHERE priority <= 2 AND status IN ('new','assigned','in_progress','on_hold','reopened')") })) }),
      ui.kpi({ label: tr('mnt|Past their SLA'), value: ui.n0(breached.length), href: '/admin/maintenance/orders?view=late', tone: breached.length ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('mnt|Average time to fix'), value: mttr === null ? '—' : ui.esc(span(mttr)), sub: ui.esc(tr('mnt|repairs closed in the last 30 days')) }),
      ui.kpi({ label: tr('mnt|Preventive on time'), value: compliance === null ? '—' : ui.pct(compliance), bar: compliance, sub: ui.esc(tr('mnt|{a} of {b} in the last 90 days', { a: onTime, b: ppmDue.length })) }),
    ].join('');
    const woList = (rows, empty) => (rows.length
      ? `<ul class="list">${rows.map((w) => `<li><a href="/admin/maintenance/orders/${w.id}"><span class="what"><b>${pBadge(w.priority)} ${ui.esc(tx(w.title))}</b><small>${ui.esc(w.ref)} · ${ui.esc(where(w))}${who(w) ? ` · ${ui.esc(who(w))}` : ''}</small></span>${slaChip(w)}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(empty)}</p>`);
    const costCard = costs.length
      ? ui.donut(costs.map((c) => ({ label: tr(CATEGORIES[c.category] || 'mnt|Other'), value: c.amount, display: ui.money(c.amount, { compact: true }) })), { label: ui.money(costTotal, { compact: true, cur: false }) })
      : `<p class="muted pad">${ui.esc(tr('mnt|No costs recorded this month.'))}</p>`;
    const pipeline = `<ul class="list">${OPEN.map((s) => `<li><a href="/admin/maintenance/orders?status=${s}"><span class="what"><b>${ui.esc(tr(STATUS[s]))}</b></span><b>${ui.n0((byStatus.find((x) => x.status === s) || {}).n || 0)}</b></a></li>`).join('')}</ul>`;
    const upcoming = db.all(`SELECT w.*, a.code asset_code, a.name asset_name, u.code unit_code, us.name assignee FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN units u ON u.id = w.unit_id
      LEFT JOIN users us ON us.id = w.assignee_id WHERE w.ppm_id IS NOT NULL AND w.status IN ('new','assigned','in_progress','on_hold','reopened') ORDER BY w.due_date LIMIT 6`);
    const body = `${tabs('/admin/maintenance', req)}<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--2">
  ${ui.card(tr('mnt|Most urgent'), woList(urgent, tr('mnt|No open work orders. All quiet.')), { action: ui.btn(tr('mnt|All work orders'), { href: '/admin/maintenance/orders', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('mnt|Past their SLA'), woList(breached.slice(0, 8), tr('mnt|Every open work order is within its SLA.')))}
</div>
<div class="grid">
  ${ui.card(tr('mnt|Cost this month'), costCard, { sub: ui.esc(tr('mnt|By category, labour, parts and contractors')) })}
  ${ui.card(tr('mnt|Open by status'), pipeline)}
  ${ui.card(tr('mnt|Preventive coming up'), woList(upcoming, tr('mnt|Nothing planned in the next week.')), { sub: satisfaction && satisfaction.n ? ui.esc(tr('mnt|Tenants rate fixes {avg} out of 5 ({n} ratings)', { avg: Number(satisfaction.avg).toFixed(1), n: satisfaction.n })) : '' })}
</div>`;
    h.page(req, res, {
      title: tr('nav|Maintenance'), active: '/admin/maintenance', wide: true, body,
      actions: h.can(req, 'agent') ? ui.btn(tr('mnt|New work order'), { href: '/admin/maintenance/orders/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  // ---------- work orders ----------
  const PER = 25;
  router.get('/maintenance/orders', (req, res) => {
    generate(req.user);
    const t = now();
    const q = req.query;
    const view = ['open', 'late', 'mine', 'closed', 'all'].includes(q.view) ? q.view : 'open';
    const conds = [];
    const args = [];
    if (OPEN.concat(['resolved', 'closed']).includes(q.status)) { conds.push('w.status = ?'); args.push(q.status); } else if (view === 'open') conds.push("w.status IN ('new','assigned','in_progress','on_hold','reopened')");
    else if (view === 'closed') conds.push("w.status IN ('resolved','closed')");
    if (view === 'late') { conds.push(BREACHED_SQL); args.push(t, t); }
    if (view === 'mine') { conds.push("w.assignee_id = ? AND w.status IN ('new','assigned','in_progress','on_hold','reopened')"); args.push(req.user.id); }
    if (CATEGORIES[q.category]) { conds.push('w.category = ?'); args.push(q.category); }
    if (PRIORITY[q.priority]) { conds.push('w.priority = ?'); args.push(Number(q.priority)); }
    if (SOURCES[q.source]) { conds.push('w.source = ?'); args.push(q.source); }
    const sql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = db.value(`SELECT COUNT(*) FROM work_orders w ${sql}`, ...args);
    const pages = Math.max(1, Math.ceil(total / PER));
    const page = Math.min(pages, Math.max(1, h.int(q.page) || 1));
    const rows = db.all(`SELECT w.*, a.code asset_code, a.name asset_name, u.code unit_code, b.name brand_name, us.name assignee FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id
      LEFT JOIN units u ON u.id = w.unit_id LEFT JOIN brands b ON b.id = w.brand_id LEFT JOIN users us ON us.id = w.assignee_id ${sql}
      ORDER BY ${view === 'closed' ? 'w.resolved_at DESC' : "CASE WHEN w.status IN ('resolved','closed') THEN 1 ELSE 0 END, w.priority, w.resolve_due"} LIMIT ? OFFSET ?`, ...args, PER, (page - 1) * PER);
    const viewTabs = [['open', tr('mnt|Open')], ['late', tr('mnt|Past SLA')], ['mine', tr('mnt|Assigned to me')], ['closed', tr('mnt|Resolved and closed')], ['all', tr('mnt|All')]]
      .map(([k, l]) => `<a class="tab${view === k && !q.status ? ' is-on' : ''}" href="/admin/maintenance/orders${k === 'open' ? '' : `?view=${k}`}">${ui.esc(l)}</a>`).join('');
    const filters = `<form method="get" class="filters" action="/admin/maintenance/orders"><input type="hidden" name="view" value="${ui.esc(view)}">
      ${ui.select('category', tr('mnt|Category'), cats(), q.category || '', { blank: tr('mnt|All categories') })}
      ${ui.select('priority', tr('mnt|Priority'), pris(), q.priority || '', { blank: tr('mnt|All priorities') })}
      ${ui.select('source', tr('mnt|Raised by'), tmap(SOURCES), q.source || '', { blank: tr('mnt|Anyone') })}
      ${ui.btn(tr('mnt|Filter'), { cls: 'btn--ghost btn--sm' })}</form>`;
    const table = ui.table([
      { label: tr('mnt|Work order'), render: (w) => `<b>${ui.esc(tx(w.title))}</b><small class="sub">${ui.esc(w.ref)} · ${ui.esc(tr(CATEGORIES[w.category]))}${w.brand_name ? ` · ${ui.esc(w.brand_name)}` : ''}</small>` },
      { label: tr('mnt|Priority'), render: (w) => pBadge(w.priority) },
      { label: tr('mnt|Where'), render: (w) => ui.esc(where(w)) },
      { label: tr('mnt|With'), render: (w) => ui.esc(who(w) || '—') },
      { label: tr('Status'), render: (w) => `${sBadge(w.status)}<small class="sub">${slaChip(w)}</small>` },
      { label: tr('mnt|Raised'), render: (w) => `${ui.esc(ago(w.created_at))}<small class="sub">${ui.esc(tr(SOURCES[w.source]))}</small>` },
    ], rows, { empty: ui.esc(tr('mnt|No work orders here.')), href: (w) => `/admin/maintenance/orders/${w.id}` });
    const keep = Object.fromEntries(Object.entries({ view, status: q.status, category: q.category, priority: q.priority, source: q.source }).filter(([, v]) => v));
    h.page(req, res, {
      title: tr('mnt|Work orders'), crumbs: crumbs([null, tr('mnt|Work orders')]), active: '/admin/maintenance', wide: true,
      body: `${tabs('/admin/maintenance/orders', req)}<nav class="tabs">${viewTabs}</nav>${ui.card(tn(total, 'mnt|{n} work order', 'mnt|{n} work orders'), `${filters}${table}${pager(ui, '/admin/maintenance/orders', keep, page, pages)}`, { action: ui.btn(tr('Export CSV'), { href: '/admin/maintenance/orders.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`,
      actions: h.can(req, 'agent') ? ui.btn(tr('mnt|New work order'), { href: '/admin/maintenance/orders/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  router.get('/maintenance/orders.csv', (req, res) => {
    const rows = db.all(`SELECT w.*, a.code asset_code, u.code unit_code, b.name brand_name, us.name assignee FROM work_orders w LEFT JOIN assets a ON a.id = w.asset_id
      LEFT JOIN units u ON u.id = w.unit_id LEFT JOIN brands b ON b.id = w.brand_id LEFT JOIN users us ON us.id = w.assignee_id ORDER BY w.created_at`);
    const cols = [['ref', tr('Ref')], ['title', tr('Title')], [(w) => tr(CATEGORIES[w.category]), tr('mnt|Category')], [(w) => `P${w.priority}`, tr('mnt|Priority')], [(w) => tr(STATUS[w.status]), tr('Status')],
      [(w) => tr(SOURCES[w.source]), tr('mnt|Raised by')], ['unit_code', tr('mnt|Unit')], ['asset_code', tr('mnt|Asset')], ['brand_name', tr('Brand')], [(w) => w.assignee || w.contractor, tr('mnt|With')],
      ['created_at', tr('mnt|Raised')], ['response_due', tr('mnt|Respond by')], ['responded_at', tr('mnt|Responded')], ['resolve_due', tr('mnt|Fix by')], ['resolved_at', tr('mnt|Resolved')],
      [(w) => (sla(w).breached ? tr('mnt|Yes') : tr('mnt|No')), tr('mnt|SLA missed')], [(w) => totalCost(w), tr('mnt|Cost')], ['rating', tr('mnt|Rating')]];
    const csv = [cols.map((c) => csvCell(c[1])).join(','), ...rows.map((w) => cols.map(([f]) => csvCell(typeof f === 'function' ? f(w) : w[f])).join(','))].join('\r\n');
    h.log(req, 'Exported', 'export', null, 'Work orders');
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="work-orders-${today()}.csv"`).send(`﻿${csv}`);
  });

  const assetOpts = () => db.all("SELECT id, code, name FROM assets WHERE status != 'retired' ORDER BY code").map((a) => [a.id, `${a.code} · ${tx(a.name)}`]);
  const unitOpts = () => db.all('SELECT id, code FROM units ORDER BY code').map((u) => [u.id, u.code]);
  const contractOpts = () => db.all("SELECT id, ref, title, counterparty FROM contracts WHERE status IN ('active','draft') ORDER BY counterparty").map((c) => [c.id, `${c.counterparty} · ${tx(c.title)}`]);
  const userOpts = () => h.users().map((u) => [u.id, u.name]);

  function woForm(req, w = {}, prefill = {}) {
    const v = (k, d = '') => (w[k] !== undefined && w[k] !== null ? w[k] : prefill[k] !== undefined ? prefill[k] : d);
    return ui.form(w.id ? `/admin/maintenance/orders/${w.id}/edit` : '/admin/maintenance/orders', req.session.csrf, `<div class="fields">
      ${ui.input('title', tr('mnt|What is wrong'), v('title'), { required: true, cls: 'span-all', placeholder: tr('mnt|e.g. Water leak above the food court corridor') })}
      ${ui.select('category', tr('mnt|Category'), cats(), v('category', 'electrical'))}
      ${ui.select('priority', tr('mnt|Priority'), pris(), v('priority', 3))}
      ${ui.select('asset_id', tr('mnt|Asset'), assetOpts(), v('asset_id'), { blank: tr('mnt|No particular asset') })}
      ${ui.select('unit_id', tr('mnt|Unit'), unitOpts(), v('unit_id'), { blank: tr('mnt|Common area') })}
      ${ui.input('location', tr('mnt|Exact place'), v('location'), { placeholder: tr('mnt|e.g. Level 1, toilets by the cinema') })}
      ${ui.input('reported_by', tr('mnt|Reported by'), v('reported_by'), { placeholder: tr('mnt|Name or phone, if not you') })}
      ${ui.textarea('description', tr('mnt|Details'), v('description'), { rows: 4, cls: 'span-all', placeholder: tr('mnt|What you saw, since when, anything already tried') })}
      ${w.id ? '' : `${ui.select('assignee_id', tr('mnt|Assign to'), userOpts(), v('assignee_id'), { blank: tr('mnt|Nobody yet') })}${ui.select('contract_id', tr('mnt|Service contract'), contractOpts(), v('contract_id'), { blank: tr('mnt|In-house') })}`}
    </div>${ui.btn(w.id ? tr('Save changes') : tr('mnt|Raise the work order'), { cls: 'btn--primary' })}`, { cls: 'form stack' });
  }

  function readWo(req) {
    const b = req.body;
    const title = h.str(b.title, 160);
    if (!title) return { error: tr('mnt|Say what is wrong.') };
    const asset = h.int(b.asset_id) ? db.get('SELECT * FROM assets WHERE id = ?', h.int(b.asset_id)) : null;
    const unitId = h.int(b.unit_id) && db.get('SELECT id FROM units WHERE id = ?', h.int(b.unit_id)) ? h.int(b.unit_id) : (asset ? asset.unit_id : null);
    const brand = unitId ? db.get("SELECT l.brand_id FROM lease_units lu JOIN leases l ON l.id = lu.lease_id WHERE lu.unit_id = ? AND l.status IN ('active','signed') ORDER BY l.start_date DESC LIMIT 1", unitId) : null;
    return {
      values: {
        title, description: h.str(b.description, 4000) || null, category: CATEGORIES[b.category] ? b.category : (asset ? asset.category : 'electrical'),
        priority: PRIORITY[b.priority] ? Number(b.priority) : 3, asset_id: asset ? asset.id : null, unit_id: unitId, location: h.str(b.location, 160) || null,
        reported_by: h.str(b.reported_by, 120) || null, brand_id: brand ? brand.brand_id : null,
        contract_id: h.int(b.contract_id) && db.get('SELECT id FROM contracts WHERE id = ?', h.int(b.contract_id)) ? h.int(b.contract_id) : (asset ? asset.contract_id : null),
        assignee_id: h.int(b.assignee_id) && db.get('SELECT id FROM users WHERE id = ? AND active = 1', h.int(b.assignee_id)) ? h.int(b.assignee_id) : null,
      },
    };
  }

  // Create a work order (staff form, tenant portal, other modules). Returns the id.
  function createWo(v, { source = 'staff', userId = null, portalUserId = null, demo = 0, at = null } = {}) {
    const t = at || now();
    const due = dueTimes(v.priority, t);
    const id = Number(db.run(
      `INSERT INTO work_orders (ref, title, description, category, priority, source, status, asset_id, unit_id, location, brand_id, reported_by, portal_user_id, assignee_id, contractor, contract_id,
       response_due, resolve_due, created_by, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      db.nextRef('work_orders', 'WO', 4, true), v.title, v.description || null, v.category, v.priority, source, v.assignee_id || v.contractor ? 'assigned' : 'new',
      v.asset_id || null, v.unit_id || null, v.location || null, v.brand_id || null, v.reported_by || null, portalUserId, v.assignee_id || null, v.contractor || null, v.contract_id || null,
      due.response_due, due.resolve_due, userId, demo ? 1 : 0, t, t,
    ).lastInsertRowid);
    if (v.assignee_id || v.contractor) db.run('UPDATE work_orders SET responded_at = ? WHERE id = ?', t, id);
    h.events.emit('work_order.created', { work_order: db.get('SELECT * FROM work_orders WHERE id = ?', id) });
    return id;
  }
  h.maintenance.createWo = createWo;

  router.get('/maintenance/orders/new', R('agent'), (req, res) => {
    const prefill = {};
    for (const k of ['asset_id', 'unit_id']) if (h.int(req.query[k.replace('_id', '')])) prefill[k] = h.int(req.query[k.replace('_id', '')]);
    if (prefill.asset_id) {
      const a = db.get('SELECT * FROM assets WHERE id = ?', prefill.asset_id);
      if (a) Object.assign(prefill, { category: a.category, unit_id: prefill.unit_id || a.unit_id, contract_id: a.contract_id, location: a.location });
    }
    h.page(req, res, { title: tr('mnt|New work order'), crumbs: crumbs(['/admin/maintenance/orders', tr('mnt|Work orders')], [null, tr('mnt|New')]), active: '/admin/maintenance', body: ui.card(tr('mnt|New work order'), woForm(req, {}, prefill), { sub: ui.esc(tr('mnt|The priority sets the response and fix-by times.')) }) });
  });
  router.post('/maintenance/orders', R('agent'), (req, res) => {
    const r = readWo(req);
    if (r.error) return h.back(req, res, '/admin/maintenance/orders/new', 'error', r.error);
    const id = db.tx(() => createWo(r.values, { userId: req.user.id }));
    const ref = db.value('SELECT ref FROM work_orders WHERE id = ?', id);
    if (r.values.assignee_id) addEvent(id, { kind: 'assignment', body: db.value('SELECT name FROM users WHERE id = ?', r.values.assignee_id) }, req);
    h.log(req, 'Raised a work order', 'work_order', id, ref);
    h.back(req, res, `/admin/maintenance/orders/${id}`, 'ok', tr('mnt|{ref} raised.', { ref }));
  });

  router.get('/maintenance/orders/:id', (req, res, next) => {
    const w = woOf(h.int(req.params.id));
    if (!w) return next();
    const csrf = req.session.csrf;
    const s = sla(w);
    const agent = h.can(req, 'agent');
    const events = db.all('SELECT e.*, u.name user_name FROM wo_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.wo_id = ? ORDER BY e.created_at, e.id', w.id);
    const timer = (label, x) => {
      if (x.state === 'none') return '';
      const tone = { met: 'ok', ok: 'mute', due: 'amber', breached: 'rose' }[x.state];
      const text = x.done ? (x.state === 'met' ? tr('mnt|Met · {date}', { date: ui.dt(x.done) }) : tr('mnt|Missed · done {date}', { date: ui.dt(x.done) }))
        : x.state === 'breached' ? tr('mnt|Late by {time}', { time: span(x.overBy) }) : tr('mnt|{time} left', { time: span(x.left) });
      return `<div class="mnt-timer mnt-timer--${tone}"><span>${ui.esc(label)}</span><b>${ui.esc(text)}</b><small>${ui.esc(tr('mnt|Target {date}', { date: ui.dt(x.due) }))}</small></div>`;
    };
    const facts = `<dl class="dl">
      <div><dt>${tr('mnt|Category')}</dt><dd>${ui.esc(tr(CATEGORIES[w.category]))}</dd></div>
      <div><dt>${tr('mnt|Priority')}</dt><dd>${ui.badge(`p${w.priority}`, tr(PRIORITY[w.priority]), P_TONE[w.priority])}</dd></div>
      <div><dt>${tr('mnt|Where')}</dt><dd>${w.unit_id ? `<a href="/admin/units/${w.unit_id}">${ui.esc(w.unit_code)}</a>` : ui.esc(tr('mnt|Common area'))}${w.location ? ` · ${ui.esc(tx(w.location))}` : ''}</dd></div>
      ${w.asset_id ? `<div><dt>${tr('mnt|Asset')}</dt><dd><a href="/admin/maintenance/assets/${w.asset_id}">${ui.esc(w.asset_code)} · ${ui.esc(tx(w.asset_name))}</a></dd></div>` : ''}
      ${w.brand_id ? `<div><dt>${tr('Brand')}</dt><dd><a href="/admin/brands/${w.brand_id}">${ui.esc(w.brand_name)}</a></dd></div>` : ''}
      <div><dt>${tr('mnt|Raised by')}</dt><dd>${ui.esc(tr(SOURCES[w.source]))}${w.reported_by ? ` · ${ui.esc(tx(w.reported_by))}` : w.author ? ` · ${ui.esc(w.author)}` : ''} · ${ui.dt(w.created_at)}</dd></div>
      ${w.ppm_id ? `<div><dt>${tr('mnt|Preventive plan')}</dt><dd><a href="/admin/maintenance/ppm/${w.ppm_id}">${ui.esc(tx(w.ppm_title))}</a> · ${ui.esc(tr('mnt|due {date}', { date: ui.date(w.due_date) }))}</dd></div>` : ''}
      <div><dt>${tr('mnt|With')}</dt><dd>${ui.esc(who(w) || tr('mnt|Nobody yet'))}${w.contract_id ? `<small class="sub"><a href="/admin/contracts/${w.contract_id}">${ui.esc(w.contract_ref)}</a> · ${ui.esc(w.contract_party)}</small>` : ''}</dd></div>
      <div><dt>${tr('mnt|Cost so far')}</dt><dd>${ui.money(totalCost(w))}<small class="sub">${ui.esc(`${tr(COSTS.labour)} ${ui.money(w.cost_labour, { cur: false })} · ${tr(COSTS.parts)} ${ui.money(w.cost_parts, { cur: false })} · ${tr(COSTS.contractor)} ${ui.money(w.cost_contractor, { cur: false })}`)}</small></dd></div>
      <div><dt>${tr('mnt|Time logged')}</dt><dd>${w.minutes ? ui.esc(tr('mnt|{h} h {m} min', { h: Math.floor(w.minutes / 60), m: w.minutes % 60 })) : '—'}</dd></div>
      ${w.rating ? `<div><dt>${tr('mnt|Tenant rating')}</dt><dd><span class="mnt-stars" aria-label="${ui.esc(tr('mnt|{n} out of 5', { n: w.rating }))}">${'★'.repeat(w.rating)}${'☆'.repeat(5 - w.rating)}</span>${w.rating_note ? `<small class="sub">${ui.esc(tx(w.rating_note))}</small>` : ''}</dd></div>` : ''}
      ${w.reopened ? `<div><dt>${tr('mnt|Reopened')}</dt><dd>${ui.esc(tn(w.reopened, 'mnt|{n} time', 'mnt|{n} times'))}</dd></div>` : ''}
    </dl>`;
    const checklist = w.checklist ? `<ul class="mnt-check">${String(w.checklist).split('\n').map((x) => x.trim()).filter(Boolean).map((x) => `<li>${ui.esc(tx(x))}</li>`).join('')}</ul>` : '';
    const label = (e) => {
      const by = e.user_name || (e.portal_user_id ? (w.brand_name ? tr('mnt|{name} (tenant)', { name: w.brand_name }) : tr('mnt|Tenant')) : tr('mnt|System'));
      if (e.kind === 'status') return [`${tr('mnt|Status: {a} → {b}', { a: tr(STATUS[e.status_from] || e.status_from), b: tr(STATUS[e.status_to] || e.status_to) })}`, by, e.body ? tx(e.body) : ''];
      if (e.kind === 'cost') return [tr('mnt|{type}: {amount}', { type: tr(COSTS[e.cost_type]), amount: ui.money(e.amount) }), by, [e.vendor ? tx(e.vendor) : null, e.body ? tx(e.body) : null].filter(Boolean).join(' · ')];
      if (e.kind === 'time') return [tr('mnt|Worked {h} h {m} min', { h: Math.floor(e.minutes / 60), m: e.minutes % 60 }), by, e.body ? tx(e.body) : ''];
      if (e.kind === 'assignment') return [tr('mnt|Assigned to {name}', { name: tx(e.body) }), by, ''];
      if (e.kind === 'rating') return [tr('mnt|Rated {n} out of 5', { n: e.minutes }), by, e.body ? tx(e.body) : ''];
      return [tr('mnt|Comment'), by, e.body ? tx(e.body) : ''];
    };
    const timeline = events.length
      ? `<ol class="mnt-tl">${events.map((e) => { const [head, by, text] = label(e); return `<li class="mnt-tl__i mnt-tl__i--${e.kind}"><p><b>${ui.esc(head)}</b> <small class="muted">${ui.esc(by)} · ${ui.esc(ago(e.created_at))}${e.shared && e.kind === 'comment' ? ` · ${ui.esc(tr('mnt|shared with the tenant'))}` : ''}</small></p>${text ? `<p>${ui.esc(text)}</p>` : ''}</li>`; }).join('')}</ol>`
      : `<p class="muted pad">${ui.esc(tr('mnt|Nothing logged yet.'))}</p>`;
    const nextOpts = (NEXT[w.status] || []).map((x) => [x, tr(STATUS[x])]);
    const forms = agent ? `
      ${nextOpts.length ? `<details class="upload-box" open><summary>${ui.icon('flow')}<span>${ui.esc(tr('mnt|Move it on'))}</span></summary>${ui.form(`/admin/maintenance/orders/${w.id}/status`, csrf, `<div class="fields">${ui.select('status', tr('mnt|New status'), nextOpts, nextOpts[0][0])}${ui.input('note', tr('mnt|Note'), '', { placeholder: tr('mnt|What was done, or why it waits') })}</div>${ui.btn(tr('mnt|Update'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}
      ${OPEN.includes(w.status) ? `<details class="upload-box"><summary>${ui.icon('people')}<span>${ui.esc(tr('mnt|Assign'))}</span></summary>${ui.form(`/admin/maintenance/orders/${w.id}/assign`, csrf, `<div class="fields">${ui.select('assignee_id', tr('mnt|Staff member'), userOpts(), w.assignee_id || '', { blank: tr('mnt|Nobody') })}${ui.select('contract_id', tr('mnt|Service contract'), contractOpts(), w.contract_id || '', { blank: tr('mnt|In-house') })}${ui.input('contractor', tr('mnt|Or a contractor'), w.contractor || '', { placeholder: tr('mnt|Company and phone') })}</div>${ui.btn(tr('mnt|Assign'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}
      <details class="upload-box"><summary>${ui.icon('coins')}<span>${ui.esc(tr('mnt|Add a cost'))}</span></summary>${ui.form(`/admin/maintenance/orders/${w.id}/cost`, csrf, `<div class="fields">${ui.select('type', tr('Type'), tmap(COSTS), 'parts')}${ui.input('amount', tr('mnt|Amount'), '', { type: 'number', min: 1, step: '0.01', required: true })}${ui.input('vendor', tr('mnt|Paid to'), '', { placeholder: tr('mnt|Supplier or contractor') })}${ui.input('date', tr('Date'), today(), { type: 'date', required: true })}${ui.input('memo', tr('mnt|What for'), '', { cls: 'span-all', placeholder: tr('mnt|e.g. Replacement contactor 32A') })}</div><p class="muted small">${ui.esc(tr('mnt|The cost is sent to the accounts as a supplier bill.'))}</p>${ui.btn(tr('mnt|Add the cost'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>
      <details class="upload-box"><summary>${ui.icon('cal')}<span>${ui.esc(tr('mnt|Log time'))}</span></summary>${ui.form(`/admin/maintenance/orders/${w.id}/time`, csrf, `<div class="fields">${ui.input('hours', tr('mnt|Hours'), '', { type: 'number', min: 0, max: 72, step: 1 })}${ui.input('minutes', tr('mnt|Minutes'), '', { type: 'number', min: 0, max: 59, step: 5 })}${ui.input('note', tr('mnt|Note'), '', { cls: 'span-all' })}</div>${ui.btn(tr('mnt|Log it'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const comment = agent ? ui.form(`/admin/maintenance/orders/${w.id}/comment`, csrf, `${ui.textarea('body', tr('mnt|Add a comment'), '', { rows: 3 })}${w.source === 'tenant' ? `<label class="check"><input type="checkbox" name="shared" value="1" checked> ${ui.esc(tr('mnt|Show it to the tenant in the portal'))}</label>` : ''}${ui.btn(tr('mnt|Post'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack mnt-comment' }) : '';
    const edit = agent && OPEN.includes(w.status) ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${ui.esc(tr('mnt|Edit the details'))}</span></summary>${woForm(req, w)}</details>` : '';
    const body = `<div class="mnt-head">${sBadge(w.status)} ${pBadge(w.priority)} <span class="muted">${ui.esc(w.ref)}</span></div>
${w.description ? `<p class="mnt-desc">${ui.esc(tx(w.description))}</p>` : ''}
<div class="mnt-timers">${timer(tr('mnt|Response'), s.response)}${timer(tr('mnt|Fix'), s.resolution)}</div>
<div class="grid grid--side">
  <div class="stack">
    ${checklist ? ui.card(tr('mnt|Checklist'), checklist) : ''}
    ${ui.card(tr('mnt|History and comments'), `${timeline}${comment}`)}
    ${panel(req, 'work_order', w.id, { title: tr('mnt|Photos and reports') })}
  </div>
  <div class="stack">${ui.card(tr('mnt|Details'), facts)}${forms}${edit}</div>
</div>`;
    h.page(req, res, { title: tx(w.title), crumbs: crumbs(['/admin/maintenance/orders', tr('mnt|Work orders')], [null, w.ref]), active: '/admin/maintenance', wide: true, body });
  });

  const back = (w) => `/admin/maintenance/orders/${w.id}`;
  const getWo = (req) => db.get('SELECT * FROM work_orders WHERE id = ?', h.int(req.params.id));
  router.post('/maintenance/orders/:id/status', R('agent'), (req, res, next) => {
    const w = getWo(req);
    if (!w) return next();
    const err = move(w, String(req.body.status || ''), { req, note: h.str(req.body.note, 1000) || null });
    if (err) return h.back(req, res, back(w), 'error', err);
    h.back(req, res, back(w), 'ok', tr('mnt|Now {status}.', { status: tr(STATUS[req.body.status]) }));
  });
  router.post('/maintenance/orders/:id/assign', R('agent'), (req, res, next) => {
    const w = getWo(req);
    if (!w) return next();
    if (!OPEN.includes(w.status)) return h.back(req, res, back(w), 'error', tr('mnt|Reopen the work order first.'));
    const user = h.int(req.body.assignee_id) ? db.get('SELECT id, name FROM users WHERE id = ? AND active = 1', h.int(req.body.assignee_id)) : null;
    const contract = h.int(req.body.contract_id) ? db.get('SELECT id, counterparty FROM contracts WHERE id = ?', h.int(req.body.contract_id)) : null;
    const contractor = h.str(req.body.contractor, 160) || null;
    const t = now();
    db.tx(() => {
      db.run('UPDATE work_orders SET assignee_id = ?, contract_id = ?, contractor = ?, status = ?, responded_at = COALESCE(responded_at, ?), updated_at = ? WHERE id = ?',
        user ? user.id : null, contract ? contract.id : null, contractor, w.status === 'new' && (user || contractor || contract) ? 'assigned' : w.status, user || contractor || contract ? t : null, t, w.id);
      addEvent(w.id, { kind: 'assignment', body: [user && user.name, contractor, contract && contract.counterparty].filter(Boolean).join(' · ') || 'Nobody' }, req);
    });
    h.log(req, 'Assigned a work order', 'work_order', w.id, w.ref);
    h.events.emit('work_order.assigned', { work_order: db.get('SELECT * FROM work_orders WHERE id = ?', w.id), user });
    h.back(req, res, back(w), 'ok', tr('Saved.'));
  });
  router.post('/maintenance/orders/:id/cost', R('agent'), (req, res, next) => {
    const w = woOf(h.int(req.params.id));
    if (!w) return next();
    const amount = h.numv(req.body.amount);
    const type = COSTS[req.body.type] ? req.body.type : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || '')) ? req.body.date : today();
    if (!type || !(amount > 0)) return h.back(req, res, back(w), 'error', tr('mnt|Enter the type and the amount.'));
    addCost(w, { type, amount: Math.round(amount * 100) / 100, vendor: h.str(req.body.vendor, 120) || null, date, memo: h.str(req.body.memo, 300) || null }, req);
    h.log(req, 'Added a work order cost', 'work_order', w.id, `${w.ref} · ${type} · ${amount}`);
    h.back(req, res, back(w), 'ok', tr('mnt|Cost added and sent to the accounts.'));
  });
  router.post('/maintenance/orders/:id/time', R('agent'), (req, res, next) => {
    const w = getWo(req);
    if (!w) return next();
    const minutes = Math.max(0, (h.int(req.body.hours) || 0) * 60 + (h.int(req.body.minutes) || 0));
    if (!minutes || minutes > 72 * 60) return h.back(req, res, back(w), 'error', tr('mnt|Enter the time worked.'));
    db.tx(() => {
      db.run('UPDATE work_orders SET minutes = minutes + ?, updated_at = ? WHERE id = ?', minutes, now(), w.id);
      addEvent(w.id, { kind: 'time', minutes, body: h.str(req.body.note, 500) || null }, req);
    });
    h.back(req, res, back(w), 'ok', tr('Saved.'));
  });
  router.post('/maintenance/orders/:id/comment', R('agent'), (req, res, next) => {
    const w = getWo(req);
    if (!w) return next();
    const body = h.str(req.body.body, 2000);
    if (!body) return h.back(req, res, back(w), 'error', tr('mnt|Write something first.'));
    addEvent(w.id, { kind: 'comment', body, shared: w.source === 'tenant' && !!req.body.shared }, req);
    db.run('UPDATE work_orders SET updated_at = ? WHERE id = ?', now(), w.id);
    h.back(req, res, back(w), 'ok', tr('mnt|Comment posted.'));
  });
  router.post('/maintenance/orders/:id/edit', R('agent'), (req, res, next) => {
    const w = getWo(req);
    if (!w) return next();
    const r = readWo(req);
    if (r.error) return h.back(req, res, back(w), 'error', r.error);
    const v = r.values;
    // a new priority moves the targets, counted from when it was raised
    const due = v.priority !== w.priority && !w.ppm_id ? dueTimes(v.priority, w.created_at) : { response_due: w.response_due, resolve_due: w.resolve_due };
    db.run('UPDATE work_orders SET title = ?, description = ?, category = ?, priority = ?, asset_id = ?, unit_id = ?, location = ?, reported_by = ?, brand_id = COALESCE(brand_id, ?), response_due = ?, resolve_due = ?, updated_at = ? WHERE id = ?',
      v.title, v.description, v.category, v.priority, v.asset_id, v.unit_id, v.location, v.reported_by, v.brand_id, due.response_due, due.resolve_due, now(), w.id);
    h.log(req, 'Edited a work order', 'work_order', w.id, w.ref);
    h.back(req, res, back(w), 'ok', tr('Saved.'));
  });

  // ---------- assets ----------
  router.get('/maintenance/assets', (req, res) => {
    const q = req.query;
    const conds = [];
    const args = [];
    if (CATEGORIES[q.category]) { conds.push('a.category = ?'); args.push(q.category); }
    if (CRIT[q.criticality]) { conds.push('a.criticality = ?'); args.push(q.criticality); }
    if (q.warranty === 'soon') { conds.push('a.warranty_until IS NOT NULL AND a.warranty_until <= ?'); args.push(M.addDays(today(), 90)); }
    const sql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = db.value(`SELECT COUNT(*) FROM assets a ${sql}`, ...args);
    const pages = Math.max(1, Math.ceil(total / PER));
    const page = Math.min(pages, Math.max(1, h.int(q.page) || 1));
    const rows = db.all(`SELECT a.*, u.code unit_code, c.counterparty, (SELECT COUNT(*) FROM work_orders w WHERE w.asset_id = a.id AND w.status IN ('new','assigned','in_progress','on_hold','reopened')) open_wos
      FROM assets a LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN contracts c ON c.id = a.contract_id ${sql} ORDER BY CASE a.criticality WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.code LIMIT ? OFFSET ?`, ...args, PER, (page - 1) * PER);
    const filters = `<form method="get" class="filters" action="/admin/maintenance/assets">${ui.select('category', tr('mnt|Category'), cats(), q.category || '', { blank: tr('mnt|All categories') })}${ui.select('criticality', tr('mnt|Criticality'), tmap(CRIT), q.criticality || '', { blank: tr('mnt|Any') })}${ui.select('warranty', tr('mnt|Warranty'), { soon: tr('mnt|Ended or ending in 90 days') }, q.warranty || '', { blank: tr('mnt|Any') })}${ui.btn(tr('mnt|Filter'), { cls: 'btn--ghost btn--sm' })}</form>`;
    const table = ui.table([
      { label: tr('mnt|Asset'), render: (a) => `<b>${ui.esc(a.code)} · ${ui.esc(tx(a.name))}</b><small class="sub">${ui.esc(tr(CATEGORIES[a.category]))}${a.make ? ` · ${ui.esc(tx(a.make))}${a.model ? ` ${ui.esc(a.model)}` : ''}` : ''}</small>` },
      { label: tr('mnt|Where'), render: (a) => ui.esc([a.unit_code, a.location ? tx(a.location) : null].filter(Boolean).join(' · ') || '—') },
      { label: tr('mnt|Criticality'), render: (a) => ui.badge(a.criticality, tr(CRIT[a.criticality]), C_TONE[a.criticality]) },
      { label: tr('mnt|Warranty'), render: (a) => (a.warranty_until ? ui.expiry(a.warranty_until, { warnDays: 90 }) : '—') },
      { label: tr('mnt|Service contract'), render: (a) => ui.esc(a.counterparty || '—') },
      { label: tr('mnt|Open'), num: true, render: (a) => ui.n0(a.open_wos) },
    ], rows, { empty: ui.esc(tr('mnt|No assets yet.')), href: (a) => `/admin/maintenance/assets/${a.id}` });
    const keep = Object.fromEntries(Object.entries({ category: q.category, criticality: q.criticality, warranty: q.warranty }).filter(([, v]) => v));
    h.page(req, res, {
      title: tr('mnt|Assets'), crumbs: crumbs([null, tr('mnt|Assets')]), active: '/admin/maintenance', wide: true,
      body: `${tabs('/admin/maintenance/assets', req)}${ui.card(tn(total, 'mnt|{n} asset', 'mnt|{n} assets'), `${filters}${table}${pager(ui, '/admin/maintenance/assets', keep, page, pages)}`)}`,
      actions: h.can(req, 'manager') ? ui.btn(tr('mnt|Add an asset'), { href: '/admin/maintenance/assets/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  function assetForm(req, a = {}) {
    const v = (k, d = '') => (a[k] !== undefined && a[k] !== null ? a[k] : d);
    return ui.form(a.id ? `/admin/maintenance/assets/${a.id}` : '/admin/maintenance/assets', req.session.csrf, `<div class="fields">
      ${ui.input('code', tr('mnt|Code'), v('code'), { required: true, placeholder: tr('mnt|e.g. AHU-03') })}
      ${ui.input('name', tr('Name'), v('name'), { required: true, placeholder: tr('mnt|e.g. Air handling unit, food court') })}
      ${ui.select('category', tr('mnt|Category'), cats(), v('category', 'hvac'))}
      ${ui.select('criticality', tr('mnt|Criticality'), tmap(CRIT), v('criticality', 'medium'))}
      ${ui.select('unit_id', tr('mnt|Unit'), unitOpts(), v('unit_id'), { blank: tr('mnt|Common area') })}
      ${ui.input('location', tr('mnt|Exact place'), v('location'), { placeholder: tr('mnt|e.g. Roof, plant room 2') })}
      ${ui.input('make', tr('mnt|Make'), v('make'))}
      ${ui.input('model', tr('mnt|Model'), v('model'))}
      ${ui.input('serial', tr('mnt|Serial number'), v('serial'))}
      ${ui.input('install_date', tr('mnt|Installed'), v('install_date'), { type: 'date' })}
      ${ui.input('warranty_until', tr('mnt|Warranty until'), v('warranty_until'), { type: 'date' })}
      ${ui.select('contract_id', tr('mnt|Service contract'), contractOpts(), v('contract_id'), { blank: tr('mnt|In-house') })}
      ${a.id ? ui.select('status', tr('Status'), tmap(A_STATUS), v('status', 'in_service')) : ''}
      ${ui.textarea('notes', tr('Notes'), v('notes'), { rows: 3, cls: 'span-all' })}
    </div>${ui.btn(a.id ? tr('Save changes') : tr('mnt|Add the asset'), { cls: 'btn--primary' })}`, { cls: 'form stack' });
  }
  function readAsset(req) {
    const b = req.body;
    const date = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? x : null);
    return {
      code: h.str(b.code, 30).toUpperCase(), name: h.str(b.name, 160), category: CATEGORIES[b.category] ? b.category : 'electrical', criticality: CRIT[b.criticality] ? b.criticality : 'medium',
      unit_id: h.int(b.unit_id) && db.get('SELECT id FROM units WHERE id = ?', h.int(b.unit_id)) ? h.int(b.unit_id) : null, location: h.str(b.location, 160) || null,
      make: h.str(b.make, 80) || null, model: h.str(b.model, 80) || null, serial: h.str(b.serial, 80) || null, install_date: date(b.install_date), warranty_until: date(b.warranty_until),
      contract_id: h.int(b.contract_id) && db.get('SELECT id FROM contracts WHERE id = ?', h.int(b.contract_id)) ? h.int(b.contract_id) : null,
      status: A_STATUS[b.status] ? b.status : 'in_service', notes: h.str(b.notes, 2000) || null,
    };
  }
  router.get('/maintenance/assets/new', R('manager'), (req, res) => {
    h.page(req, res, { title: tr('mnt|Add an asset'), crumbs: crumbs(['/admin/maintenance/assets', tr('mnt|Assets')], [null, tr('mnt|New')]), active: '/admin/maintenance', body: ui.card(tr('mnt|Add an asset'), assetForm(req)) });
  });
  router.post('/maintenance/assets', R('manager'), (req, res) => {
    const a = readAsset(req);
    if (!a.code || !a.name) return h.back(req, res, '/admin/maintenance/assets/new', 'error', tr('mnt|Give the asset a code and a name.'));
    if (db.get('SELECT id FROM assets WHERE code = ?', a.code)) return h.back(req, res, '/admin/maintenance/assets/new', 'error', tr('mnt|{code} is already used.', { code: a.code }));
    const id = Number(db.run(`INSERT INTO assets (code, name, category, criticality, unit_id, location, make, model, serial, install_date, warranty_until, contract_id, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.code, a.name, a.category, a.criticality, a.unit_id, a.location, a.make, a.model, a.serial, a.install_date, a.warranty_until, a.contract_id, 'in_service', a.notes, now(), now()).lastInsertRowid);
    h.log(req, 'Added an asset', 'asset', id, a.code);
    h.back(req, res, `/admin/maintenance/assets/${id}`, 'ok', tr('mnt|{code} added.', { code: a.code }));
  });
  router.get('/maintenance/assets/:id', (req, res, next) => {
    const a = db.get('SELECT a.*, u.code unit_code, c.ref contract_ref, c.counterparty, c.end_date contract_end FROM assets a LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN contracts c ON c.id = a.contract_id WHERE a.id = ?', h.int(req.params.id));
    if (!a) return next();
    const wos = db.all('SELECT w.*, us.name assignee FROM work_orders w LEFT JOIN users us ON us.id = w.assignee_id WHERE w.asset_id = ? ORDER BY w.created_at DESC LIMIT 20', a.id);
    const plans = db.all('SELECT * FROM ppm_plans WHERE asset_id = ? ORDER BY next_due', a.id);
    const spent = db.value("SELECT COALESCE(SUM(cost_labour + cost_parts + cost_contractor), 0) FROM work_orders WHERE asset_id = ? AND created_at >= ?", a.id, `${today().slice(0, 4)}-01-01`);
    const facts = `<dl class="dl">
      <div><dt>${tr('mnt|Category')}</dt><dd>${ui.esc(tr(CATEGORIES[a.category]))}</dd></div>
      <div><dt>${tr('mnt|Criticality')}</dt><dd>${ui.badge(a.criticality, tr(CRIT[a.criticality]), C_TONE[a.criticality])}</dd></div>
      <div><dt>${tr('Status')}</dt><dd>${ui.esc(tr(A_STATUS[a.status]))}</dd></div>
      <div><dt>${tr('mnt|Where')}</dt><dd>${a.unit_id ? `<a href="/admin/units/${a.unit_id}">${ui.esc(a.unit_code)}</a>` : ui.esc(tr('mnt|Common area'))}${a.location ? ` · ${ui.esc(tx(a.location))}` : ''}</dd></div>
      <div><dt>${tr('mnt|Make and model')}</dt><dd>${ui.esc([a.make ? tx(a.make) : null, a.model].filter(Boolean).join(' ') || '—')}</dd></div>
      <div><dt>${tr('mnt|Serial number')}</dt><dd>${a.serial ? `<bdi>${ui.esc(a.serial)}</bdi>` : '—'}</dd></div>
      <div><dt>${tr('mnt|Installed')}</dt><dd>${ui.date(a.install_date)}</dd></div>
      <div><dt>${tr('mnt|Warranty')}</dt><dd>${a.warranty_until ? ui.expiry(a.warranty_until, { warnDays: 90 }) : '—'}</dd></div>
      <div><dt>${tr('mnt|Service contract')}</dt><dd>${a.contract_id ? `<a href="/admin/contracts/${a.contract_id}">${ui.esc(a.counterparty)}</a><small class="sub">${ui.esc(a.contract_ref)}${a.contract_end ? ` · ${ui.esc(tr('mnt|until {date}', { date: ui.date(a.contract_end) }))}` : ''}</small>` : ui.esc(tr('mnt|In-house'))}</dd></div>
      <div><dt>${tr('mnt|Spent this year')}</dt><dd>${ui.money(spent)}</dd></div>
      ${a.notes ? `<div><dt>${tr('Notes')}</dt><dd>${ui.esc(tx(a.notes))}</dd></div>` : ''}
    </dl>`;
    const woList = wos.length
      ? `<ul class="list">${wos.map((w) => `<li><a href="/admin/maintenance/orders/${w.id}"><span class="what"><b>${pBadge(w.priority)} ${ui.esc(tx(w.title))}</b><small>${ui.esc(w.ref)} · ${ui.date(w.created_at)}${w.assignee ? ` · ${ui.esc(w.assignee)}` : ''}</small></span>${sBadge(w.status)}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('mnt|No work orders for this asset yet.'))}</p>`;
    const planList = plans.length
      ? `<ul class="list">${plans.map((p) => `<li><a href="/admin/maintenance/ppm/${p.id}"><span class="what"><b>${ui.esc(tx(p.title))}</b><small>${ui.esc(every(p))} · ${ui.esc(tr('mnt|next {date}', { date: ui.date(p.next_due) }))}</small></span>${p.active ? '' : ui.badge('off', tr('mnt|Paused'), 'mute')}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('mnt|No preventive plan.'))}</p>`;
    const mgr = h.can(req, 'manager');
    const body = `<div class="grid grid--side">
  <div class="stack">${ui.card(tr('mnt|Work orders'), woList, { action: h.can(req, 'agent') ? ui.btn(tr('mnt|Report a fault'), { href: `/admin/maintenance/orders/new?asset=${a.id}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '' })}
    ${ui.card(tr('mnt|Preventive plans'), planList, { action: mgr ? ui.btn(tr('mnt|Add a plan'), { href: `/admin/maintenance/ppm/new?asset=${a.id}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '' })}
    ${panel(req, 'asset', a.id, { title: tr('mnt|Photos, manuals and certificates') })}</div>
  <div class="stack">${ui.card(tr('mnt|Details'), facts)}${mgr ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${ui.esc(tr('mnt|Edit the asset'))}</span></summary>${assetForm(req, a)}</details>` : ''}</div>
</div>`;
    h.page(req, res, { title: `${a.code} · ${tx(a.name)}`, crumbs: crumbs(['/admin/maintenance/assets', tr('mnt|Assets')], [null, a.code]), active: '/admin/maintenance', wide: true, body });
  });
  router.post('/maintenance/assets/:id', R('manager'), (req, res, next) => {
    const old = db.get('SELECT * FROM assets WHERE id = ?', h.int(req.params.id));
    if (!old) return next();
    const a = readAsset(req);
    const back2 = `/admin/maintenance/assets/${old.id}`;
    if (!a.code || !a.name) return h.back(req, res, back2, 'error', tr('mnt|Give the asset a code and a name.'));
    if (db.get('SELECT id FROM assets WHERE code = ? AND id != ?', a.code, old.id)) return h.back(req, res, back2, 'error', tr('mnt|{code} is already used.', { code: a.code }));
    db.run('UPDATE assets SET code = ?, name = ?, category = ?, criticality = ?, unit_id = ?, location = ?, make = ?, model = ?, serial = ?, install_date = ?, warranty_until = ?, contract_id = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?',
      a.code, a.name, a.category, a.criticality, a.unit_id, a.location, a.make, a.model, a.serial, a.install_date, a.warranty_until, a.contract_id, a.status, a.notes, now(), old.id);
    h.log(req, 'Edited an asset', 'asset', old.id, a.code);
    h.back(req, res, back2, 'ok', tr('Saved.'));
  });

  // ---------- preventive maintenance ----------
  const every = (p) => (p.every_n === 1 ? tr(UNITS[p.every_unit][0]) : tr(UNITS[p.every_unit][1], { n: p.every_n }));
  router.get('/maintenance/ppm', (req, res) => {
    generate(req.user);
    const d = today();
    const key = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) && Math.abs(M.daysBetween(`${req.query.month}-01`, d)) < 400 ? req.query.month : d.slice(0, 7);
    const from = `${key}-01`;
    const to = M.addDays(M.addMonths(from, 1), -1);
    const plans = db.all('SELECT p.*, a.code asset_code, a.name asset_name, u.name assignee FROM ppm_plans p LEFT JOIN assets a ON a.id = p.asset_id LEFT JOIN users u ON u.id = p.assignee_id ORDER BY p.active DESC, p.next_due');
    // what falls in the month: generated work orders, and plan dates still to come
    const items = db.all("SELECT w.id, w.ref, w.title, w.due_date, w.status, w.resolved_at FROM work_orders w WHERE w.ppm_id IS NOT NULL AND w.due_date >= ? AND w.due_date <= ?", from, to)
      .map((w) => ({ date: w.due_date, title: w.title, href: `/admin/maintenance/orders/${w.id}`, state: ['resolved', 'closed'].includes(w.status) ? 'done' : w.due_date < d ? 'late' : 'open' }));
    for (const p of plans.filter((x) => x.active)) {
      let due = p.next_due;
      let guard = 0;
      while (due <= to && guard++ < 62) {
        if (due >= from) items.push({ date: due, title: p.title, href: `/admin/maintenance/ppm/${p.id}`, state: 'planned' });
        due = nextDue(due, p.every_n, p.every_unit);
      }
    }
    const first = (new Date(Date.parse(`${from}T00:00:00Z`)).getUTCDay() + 6) % 7;
    const days = M.daysBetween(from, to) + 1;
    const cells = [];
    for (let i = 0; i < first; i++) cells.push('<div class="mnt-cal__d is-out"></div>');
    for (let i = 0; i < days; i++) {
      const dd = M.addDays(from, i);
      const here = items.filter((x) => x.date === dd);
      cells.push(`<div class="mnt-cal__d${dd === d ? ' is-today' : ''}"><b>${i + 1}</b>${here.slice(0, 4).map((x) => `<a class="mnt-cal__e mnt-cal__e--${x.state}" href="${x.href}" title="${ui.esc(tx(x.title))}">${ui.esc(tx(x.title))}</a>`).join('')}${here.length > 4 ? `<small class="muted">${ui.esc(tr('mnt|+{n} more', { n: here.length - 4 }))}</small>` : ''}</div>`);
    }
    const prev = M.addMonths(from, -1).slice(0, 7);
    const next = M.addMonths(from, 1).slice(0, 7);
    const nav = `<form method="get" action="/admin/maintenance/ppm" class="row spc-nav"><button class="btn btn--ghost btn--sm" name="month" value="${prev}" aria-label="${ui.esc(tr('spc|Previous month'))}">‹</button><b>${ui.esc(ui.monthYear(key))}</b><button class="btn btn--ghost btn--sm" name="month" value="${next}" aria-label="${ui.esc(tr('spc|Next month'))}">›</button></form>`;
    const legend = `<ul class="legend legend--row">${[['planned', tr('mnt|Planned')], ['open', tr('mnt|Work order open')], ['done', tr('mnt|Done')], ['late', tr('mnt|Overdue')]].map(([k, l]) => `<li><i class="mnt-dot mnt-dot--${k}"></i><span>${ui.esc(l)}</span></li>`).join('')}</ul>`;
    const cal = `<div class="mnt-cal"><div class="mnt-cal__h">${ui.weekdays().map((x) => `<span>${ui.esc(x)}</span>`).join('')}</div><div class="mnt-cal__g">${cells.join('')}</div></div>${legend}`;
    const table = ui.table([
      { label: tr('mnt|Plan'), render: (p) => `<b>${ui.esc(tx(p.title))}</b><small class="sub">${p.asset_code ? `${ui.esc(p.asset_code)} · ${ui.esc(tx(p.asset_name))}` : ui.esc(tr(CATEGORIES[p.category]))}</small>` },
      { label: tr('mnt|How often'), render: (p) => ui.esc(every(p)) },
      { label: tr('mnt|Next due'), render: (p) => (p.active ? ui.date(p.next_due) : ui.badge('off', tr('mnt|Paused'), 'mute')) },
      { label: tr('mnt|Last done'), render: (p) => ui.date(p.last_done) },
      { label: tr('mnt|With'), render: (p) => ui.esc(p.assignee || (p.contractor ? tx(p.contractor) : '—')) },
    ], plans, { empty: ui.esc(tr('mnt|No preventive plans yet.')), href: (p) => `/admin/maintenance/ppm/${p.id}` });
    const body = `${tabs('/admin/maintenance/ppm', req)}${ui.card(tr('mnt|Preventive calendar'), cal, { action: nav, sub: ui.esc(tr('mnt|Work orders are raised {n} days before each date.', { n: PPM_LOOKAHEAD })) })}${ui.card(tn(plans.length, 'mnt|{n} plan', 'mnt|{n} plans'), table)}`;
    h.page(req, res, {
      title: tr('mnt|Preventive maintenance'), crumbs: crumbs([null, tr('mnt|Preventive')]), active: '/admin/maintenance', wide: true, body,
      actions: h.can(req, 'manager') ? ui.btn(tr('mnt|Add a plan'), { href: '/admin/maintenance/ppm/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  function ppmForm(req, p = {}, prefill = {}) {
    const v = (k, d = '') => (p[k] !== undefined && p[k] !== null ? p[k] : prefill[k] !== undefined ? prefill[k] : d);
    return ui.form(p.id ? `/admin/maintenance/ppm/${p.id}` : '/admin/maintenance/ppm', req.session.csrf, `<div class="fields">
      ${ui.input('title', tr('mnt|What is done'), v('title'), { required: true, cls: 'span-all', placeholder: tr('mnt|e.g. Quarterly service of the chillers') })}
      ${ui.select('asset_id', tr('mnt|Asset'), assetOpts(), v('asset_id'), { blank: tr('mnt|No particular asset') })}
      ${ui.select('category', tr('mnt|Category'), cats(), v('category', 'hvac'))}
      ${ui.input('every_n', tr('mnt|Every'), v('every_n', 1), { type: 'number', min: 1, max: 365, step: 1, required: true })}
      ${ui.select('every_unit', tr('mnt|Unit of time'), { day: tr('mnt|days'), week: tr('mnt|weeks'), month: tr('mnt|months') }, v('every_unit', 'month'))}
      ${ui.input('next_due', tr('mnt|Next due'), v('next_due', today()), { type: 'date', required: true })}
      ${ui.select('priority', tr('mnt|Priority'), pris(), v('priority', 4))}
      ${ui.select('assignee_id', tr('mnt|Assign to'), userOpts(), v('assignee_id'), { blank: tr('mnt|Nobody yet') })}
      ${ui.input('contractor', tr('mnt|Or a contractor'), v('contractor'))}
      ${ui.textarea('checklist', tr('mnt|Checklist, one step per line'), v('checklist'), { rows: 5, cls: 'span-all', placeholder: tr('mnt|Check refrigerant pressure\nClean condenser coils\nTest alarms') })}
      ${p.id ? `<label class="check"><input type="checkbox" name="active" value="1"${v('active', 1) ? ' checked' : ''}> ${ui.esc(tr('mnt|Active'))}</label>` : ''}
    </div>${ui.btn(p.id ? tr('Save changes') : tr('mnt|Add the plan'), { cls: 'btn--primary' })}`, { cls: 'form stack' });
  }
  function readPpm(req) {
    const b = req.body;
    const asset = h.int(b.asset_id) ? db.get('SELECT * FROM assets WHERE id = ?', h.int(b.asset_id)) : null;
    return {
      title: h.str(b.title, 160), asset_id: asset ? asset.id : null, category: CATEGORIES[b.category] ? b.category : (asset ? asset.category : 'hvac'),
      every_n: Math.max(1, Math.min(365, h.int(b.every_n) || 1)), every_unit: UNITS[b.every_unit] ? b.every_unit : 'month',
      next_due: /^\d{4}-\d{2}-\d{2}$/.test(String(b.next_due || '')) ? b.next_due : null, priority: PRIORITY[b.priority] ? Number(b.priority) : 4,
      assignee_id: h.int(b.assignee_id) && db.get('SELECT id FROM users WHERE id = ?', h.int(b.assignee_id)) ? h.int(b.assignee_id) : null,
      contractor: h.str(b.contractor, 160) || null, checklist: h.str(b.checklist, 4000) || null,
    };
  }
  router.get('/maintenance/ppm/new', R('manager'), (req, res) => {
    const prefill = h.int(req.query.asset) ? { asset_id: h.int(req.query.asset) } : {};
    h.page(req, res, { title: tr('mnt|Add a preventive plan'), crumbs: crumbs(['/admin/maintenance/ppm', tr('mnt|Preventive')], [null, tr('mnt|New')]), active: '/admin/maintenance', body: ui.card(tr('mnt|Add a preventive plan'), ppmForm(req, {}, prefill)) });
  });
  router.post('/maintenance/ppm', R('manager'), (req, res) => {
    const p = readPpm(req);
    if (!p.title || !p.next_due) return h.back(req, res, '/admin/maintenance/ppm/new', 'error', tr('mnt|Give the plan a name and its next date.'));
    const id = Number(db.run('INSERT INTO ppm_plans (title, asset_id, category, priority, every_n, every_unit, checklist, next_due, assignee_id, contractor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      p.title, p.asset_id, p.category, p.priority, p.every_n, p.every_unit, p.checklist, p.next_due, p.assignee_id, p.contractor, now(), now()).lastInsertRowid);
    h.log(req, 'Added a preventive plan', 'ppm_plan', id, p.title);
    generate(req.user);
    h.back(req, res, `/admin/maintenance/ppm/${id}`, 'ok', tr('Saved.'));
  });
  router.get('/maintenance/ppm/:id', (req, res, next) => {
    const p = db.get('SELECT p.*, a.code asset_code, a.name asset_name, u.name assignee FROM ppm_plans p LEFT JOIN assets a ON a.id = p.asset_id LEFT JOIN users u ON u.id = p.assignee_id WHERE p.id = ?', h.int(req.params.id));
    if (!p) return next();
    const wos = db.all('SELECT * FROM work_orders WHERE ppm_id = ? ORDER BY due_date DESC LIMIT 24', p.id);
    const done = wos.filter((w) => w.due_date <= today());
    const onTime = done.filter((w) => w.resolved_at && w.resolved_at.slice(0, 10) <= w.due_date).length;
    const facts = `<dl class="dl">
      <div><dt>${tr('mnt|How often')}</dt><dd>${ui.esc(every(p))}</dd></div>
      <div><dt>${tr('mnt|Next due')}</dt><dd>${p.active ? ui.date(p.next_due) : ui.badge('off', tr('mnt|Paused'), 'mute')}</dd></div>
      <div><dt>${tr('mnt|Last done')}</dt><dd>${ui.date(p.last_done)}</dd></div>
      <div><dt>${tr('mnt|Asset')}</dt><dd>${p.asset_id ? `<a href="/admin/maintenance/assets/${p.asset_id}">${ui.esc(p.asset_code)} · ${ui.esc(tx(p.asset_name))}</a>` : '—'}</dd></div>
      <div><dt>${tr('mnt|With')}</dt><dd>${ui.esc(p.assignee || (p.contractor ? tx(p.contractor) : tr('mnt|Nobody yet')))}</dd></div>
      <div><dt>${tr('mnt|On time')}</dt><dd>${done.length ? `${ui.pct(onTime / done.length)} <small class="muted">${ui.esc(tr('mnt|{a} of {b}', { a: onTime, b: done.length }))}</small>` : '—'}</dd></div>
    </dl>`;
    const checklist = p.checklist ? `<ul class="mnt-check">${String(p.checklist).split('\n').map((x) => x.trim()).filter(Boolean).map((x) => `<li>${ui.esc(tx(x))}</li>`).join('')}</ul>` : `<p class="muted pad">${ui.esc(tr('mnt|No checklist.'))}</p>`;
    const list = wos.length
      ? `<ul class="list">${wos.map((w) => `<li><a href="/admin/maintenance/orders/${w.id}"><span class="what"><b>${ui.esc(w.ref)} · ${ui.esc(tr('mnt|due {date}', { date: ui.date(w.due_date) }))}</b><small>${w.resolved_at ? ui.esc(tr('mnt|done {date}', { date: ui.date(w.resolved_at) })) : ''}</small></span>${sBadge(w.status)}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('mnt|No work orders raised yet.'))}</p>`;
    const body = `<div class="grid grid--side"><div class="stack">${ui.card(tr('mnt|Checklist'), checklist)}${ui.card(tr('mnt|Work orders raised'), list)}</div>
<div class="stack">${ui.card(tr('mnt|Details'), facts)}${h.can(req, 'manager') ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${ui.esc(tr('mnt|Edit the plan'))}</span></summary>${ppmForm(req, p)}</details>` : ''}</div></div>`;
    h.page(req, res, { title: tx(p.title), crumbs: crumbs(['/admin/maintenance/ppm', tr('mnt|Preventive')], [null, tx(p.title)]), active: '/admin/maintenance', wide: true, body });
  });
  router.post('/maintenance/ppm/:id', R('manager'), (req, res, next) => {
    const old = db.get('SELECT * FROM ppm_plans WHERE id = ?', h.int(req.params.id));
    if (!old) return next();
    const p = readPpm(req);
    if (!p.title || !p.next_due) return h.back(req, res, `/admin/maintenance/ppm/${old.id}`, 'error', tr('mnt|Give the plan a name and its next date.'));
    db.run('UPDATE ppm_plans SET title = ?, asset_id = ?, category = ?, priority = ?, every_n = ?, every_unit = ?, checklist = ?, next_due = ?, assignee_id = ?, contractor = ?, active = ?, updated_at = ? WHERE id = ?',
      p.title, p.asset_id, p.category, p.priority, p.every_n, p.every_unit, p.checklist, p.next_due, p.assignee_id, p.contractor, req.body.active ? 1 : 0, now(), old.id);
    h.log(req, 'Edited a preventive plan', 'ppm_plan', old.id, p.title);
    generate(req.user);
    h.back(req, res, `/admin/maintenance/ppm/${old.id}`, 'ok', tr('Saved.'));
  });

  // ---------- SLA targets ----------
  router.get('/maintenance/settings', R('manager'), (req, res) => {
    const s = slaHours();
    const rows = [1, 2, 3, 4].map((p) => `<tr><th>${ui.badge(`p${p}`, tr(PRIORITY[p]), P_TONE[p])}</th><td>${ui.input(`r${p}`, tr('mnt|Respond within (hours)'), s[p][0], { type: 'number', min: 0.25, max: 720, step: '0.25', required: true })}</td><td>${ui.input(`f${p}`, tr('mnt|Fix within (hours)'), s[p][1], { type: 'number', min: 0.5, max: 2160, step: '0.5', required: true })}</td></tr>`).join('');
    const body = `${tabs('/admin/maintenance/settings', req)}${ui.card(tr('mnt|SLA targets'), ui.form('/admin/maintenance/settings', req.session.csrf, `<div class="tablewrap"><table class="table mnt-sla"><tbody>${rows}</tbody></table></div>${ui.btn(tr('Save changes'), { cls: 'btn--primary' })}`, { cls: 'stack' }), { sub: ui.esc(tr('mnt|Counted from when a work order is raised. New targets apply to new work orders.')) })}`;
    h.page(req, res, { title: tr('mnt|SLA targets'), crumbs: crumbs([null, tr('mnt|SLA targets')]), active: '/admin/maintenance', body });
  });
  router.post('/maintenance/settings', R('manager'), (req, res) => {
    const out = {};
    for (const p of [1, 2, 3, 4]) {
      const a = h.numv(req.body[`r${p}`]);
      const b = h.numv(req.body[`f${p}`]);
      if (!(a > 0) || !(b > 0) || b < a) return h.back(req, res, '/admin/maintenance/settings', 'error', tr('mnt|Each fix time must be at least its response time.'));
      out[p] = [a, b];
    }
    db.setSetting('maintenance_sla', JSON.stringify(out));
    h.log(req, 'Changed the SLA targets', 'setting', null, 'maintenance_sla');
    h.back(req, res, '/admin/maintenance/settings', 'ok', tr('Saved.'));
  });

  // ---------- panels for other pages (contracts, units) ----------
  h.opsPanels = h.opsPanels || {};
  h.opsPanels.contract = (req, contractId) => {
    const assets = db.all('SELECT id, code, name, criticality FROM assets WHERE contract_id = ? ORDER BY code LIMIT 30', contractId);
    const wos = db.all('SELECT id, ref, title, status, priority, created_at FROM work_orders WHERE contract_id = ? ORDER BY created_at DESC LIMIT 10', contractId);
    if (!assets.length && !wos.length) return '';
    const spent = db.value('SELECT COALESCE(SUM(cost_contractor), 0) FROM work_orders WHERE contract_id = ?', contractId);
    const a = assets.length ? `<p class="eyebrow pad">${ui.esc(tr('mnt|Assets covered'))}</p><ul class="list">${assets.map((x) => `<li><a href="/admin/maintenance/assets/${x.id}"><span class="what"><b>${ui.esc(x.code)} · ${ui.esc(tx(x.name))}</b></span>${ui.badge(x.criticality, tr(CRIT[x.criticality]), C_TONE[x.criticality])}</a></li>`).join('')}</ul>` : '';
    const w = wos.length ? `<p class="eyebrow pad">${ui.esc(tr('mnt|Recent work orders'))}</p><ul class="list">${wos.map((x) => `<li><a href="/admin/maintenance/orders/${x.id}"><span class="what"><b>${ui.esc(tx(x.title))}</b><small>${ui.esc(x.ref)} · ${ui.date(x.created_at)}</small></span>${sBadge(x.status)}</a></li>`).join('')}</ul>` : '';
    return ui.card(tr('mnt|Maintenance under this contract'), `${a}${w}`, { sub: spent ? ui.esc(tr('mnt|{amount} in contractor costs on work orders', { amount: ui.money(spent) })) : '' });
  };
  h.opsPanels.unit = (req, unitId) => {
    const wos = db.all("SELECT id, ref, title, status, priority, created_at, response_due, resolve_due, responded_at, resolved_at, updated_at FROM work_orders WHERE unit_id = ? AND status IN ('new','assigned','in_progress','on_hold','reopened') ORDER BY priority, created_at LIMIT 10", unitId);
    const list = wos.length
      ? `<ul class="list">${wos.map((x) => `<li><a href="/admin/maintenance/orders/${x.id}"><span class="what"><b>${pBadge(x.priority)} ${ui.esc(tx(x.title))}</b><small>${ui.esc(x.ref)} · ${ui.esc(ago(x.created_at))}</small></span>${slaChip(x)}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('mnt|No open work orders.'))}</p>`;
    return ui.card(tr('mnt|Open work orders'), list, { action: h.can(req, 'agent') ? ui.btn(tr('mnt|Report a fault'), { href: `/admin/maintenance/orders/new?unit=${unitId}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '' });
  };

  // ---------- tenant requests through the portal ----------
  if (h.portal && h.portal.router && h.portal.requireTenant) {
    const P = h.portal;
    const pr = P.router;
    const need = P.requireTenant;
    const brandOf = (req) => (P.brandId ? P.brandId(req) : req.tenant && req.tenant.brand_id);
    const mine = (req, id) => db.get('SELECT w.*, u.code unit_code FROM work_orders w LEFT JOIN units u ON u.id = w.unit_id WHERE w.id = ? AND w.brand_id = ?', h.int(id), brandOf(req));
    const pBack = (req, res, url, type, text) => (P.back ? P.back(req, res, url, type, text) : res.redirect(303, url));
    // what the tenant sees of the status
    const T_STATUS = { new: 'mnt|Received', assigned: 'mnt|Received', in_progress: 'mnt|Being fixed', on_hold: 'mnt|Waiting', reopened: 'mnt|Being fixed', resolved: 'mnt|Fixed', closed: 'mnt|Closed' };
    const T_TONE = { new: 'sea', assigned: 'sea', in_progress: 'amber', on_hold: 'cocoa', reopened: 'amber', resolved: 'ok', closed: 'mute' };
    const tBadge = (s) => ui.badge(s, tr(T_STATUS[s]), T_TONE[s]);
    const unitsOf = (bid) => db.all("SELECT DISTINCT u.id, u.code FROM leases l JOIN lease_units lu ON lu.lease_id = l.id JOIN units u ON u.id = lu.unit_id WHERE l.brand_id = ? AND l.status IN ('active','signed','draft') ORDER BY u.code", bid);
    P.tab({ key: 'requests', href: '/portal/requests', label: 'mnt|Maintenance', icon: 'wrench', order: 30, badge: (req) => db.value("SELECT COUNT(*) FROM work_orders WHERE brand_id = ? AND source = 'tenant' AND status = 'resolved' AND rating IS NULL", brandOf(req)) });

    pr.get('/requests', need, (req, res) => {
      const bid = brandOf(req);
      const list = db.all("SELECT w.*, u.code unit_code FROM work_orders w LEFT JOIN units u ON u.id = w.unit_id WHERE w.brand_id = ? AND w.source = 'tenant' ORDER BY CASE WHEN w.status IN ('resolved','closed') THEN 1 ELSE 0 END, w.created_at DESC LIMIT 100", bid);
      const units = unitsOf(bid);
      const csrf = req.psession.csrf;
      const form = `<form method="post" action="/portal/requests" class="stack"><input type="hidden" name="_csrf" value="${ui.esc(csrf)}"><div class="fields">
        ${ui.input('title', tr('mnt|What is wrong'), '', { required: true, cls: 'span-all', placeholder: tr('mnt|e.g. No cold air in the shop since this morning') })}
        ${ui.select('category', tr('mnt|Category'), cats(), 'hvac')}
        ${ui.select('priority', tr('mnt|How urgent'), tmap(URGENCY), 3)}
        ${units.length > 1 ? ui.select('unit_id', tr('mnt|Unit'), units.map((u) => [u.id, u.code]), units[0].id) : ''}
        ${ui.input('location', tr('mnt|Exact place'), '', { placeholder: tr('mnt|e.g. Stock room, back door') })}
        ${ui.textarea('description', tr('mnt|Details'), '', { rows: 4, cls: 'span-all', placeholder: tr('mnt|What you saw, since when, and the best time for a technician to come') })}
      </div><p class="muted small">${ui.esc(tr('mnt|You can add photos once the request is sent.'))}</p>${ui.btn(tr('mnt|Send the request'), { cls: 'btn--primary' })}</form>`;
      const items = list.length
        ? `<ul class="list">${list.map((w) => `<li><a href="/portal/requests/${w.id}"><span class="what"><b>${ui.esc(tx(w.title))}</b><small>${ui.esc(w.ref)} · ${ui.date(w.created_at)}${w.unit_code ? ` · ${ui.esc(w.unit_code)}` : ''}</small></span>${tBadge(w.status)}</a></li>`).join('')}</ul>`
        : `<p class="muted pad">${ui.esc(tr('mnt|No requests yet.'))}</p>`;
      const body = `<div class="grid grid--side">${ui.card(tr('mnt|Your requests'), items)}${ui.card(tr('mnt|Report a problem'), form, { sub: ui.esc(tr('mnt|For fire, smoke or flooding, call mall security first.')) })}</div>`;
      P.page(req, res, { title: tr('mnt|Maintenance requests'), active: 'requests', body });
    });
    pr.post('/requests', need, (req, res) => {
      const bid = brandOf(req);
      const title = h.str(req.body.title, 160);
      if (!title) return pBack(req, res, '/portal/requests', 'error', tr('mnt|Say what is wrong.'));
      const units = unitsOf(bid);
      const unit = units.find((u) => u.id === h.int(req.body.unit_id)) || units[0] || null;
      const priority = PRIORITY[req.body.priority] ? Number(req.body.priority) : 3;
      const id = db.tx(() => createWo({
        title, description: h.str(req.body.description, 4000) || null, category: CATEGORIES[req.body.category] ? req.body.category : 'civil', priority,
        unit_id: unit ? unit.id : null, location: h.str(req.body.location, 160) || null, brand_id: bid, reported_by: req.tenant.name,
      }, { source: 'tenant', portalUserId: req.tenant.id }));
      const ref = db.value('SELECT ref FROM work_orders WHERE id = ?', id);
      db.audit(null, 'Tenant raised a maintenance request', 'work_order', id, `${ref} · ${req.brand ? req.brand.name : ''}`, req.ip);
      h.events.emit('maintenance.request', { work_order: db.get('SELECT * FROM work_orders WHERE id = ?', id), tenant: req.tenant });
      pBack(req, res, `/portal/requests/${id}`, 'ok', tr('mnt|Request {ref} sent. The maintenance team has it.', { ref }));
    });
    pr.get('/requests/:id', need, (req, res, next) => {
      const w = mine(req, req.params.id);
      if (!w) return next();
      const csrf = req.psession.csrf;
      const events = db.all("SELECT e.*, u.name user_name FROM wo_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.wo_id = ? AND (e.kind = 'status' OR (e.kind = 'comment' AND (e.shared = 1 OR e.portal_user_id IS NOT NULL)) OR e.kind = 'rating') ORDER BY e.created_at, e.id", w.id);
      const docs = db.all("SELECT * FROM documents WHERE entity = 'work_order' AND entity_id = ? AND archived = 0 AND confidential = 0 ORDER BY created_at", w.id);
      const tl = events.map((e) => {
        const by = e.portal_user_id ? tr('mnt|You') : tr('mnt|Maintenance team');
        const head = e.kind === 'status' ? tr('mnt|Now: {status}', { status: tr(T_STATUS[e.status_to] || 'mnt|Received') }) : e.kind === 'rating' ? tr('mnt|Rated {n} out of 5', { n: e.minutes }) : by;
        return `<li class="mnt-tl__i mnt-tl__i--${e.kind}"><p><b>${ui.esc(head)}</b> <small class="muted">${ui.esc(ui.rel(e.created_at))}</small></p>${e.body && e.kind !== 'status' ? `<p>${ui.esc(tx(e.body))}</p>` : ''}</li>`;
      }).join('');
      const photos = docs.length ? `<ul class="doclist">${docs.map((d) => `<li>${ui.fileIcon(d.mime)}<div class="doclist__what"><a href="/portal/requests/${w.id}/files/${d.id}" target="_blank" rel="noopener"><b>${ui.esc(tx(d.title))}</b></a><small>${ui.KB(d.size)} · ${ui.date(d.created_at)}</small></div></li>`).join('')}</ul>` : '';
      const upload = !['closed'].includes(w.status) ? `<form class="upload" data-upload="/portal/requests/${w.id}/files?kind=wo_photo" novalidate>
        <label class="drop"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*">${ui.icon('upload')}<span data-drop-label>${ui.esc(tr('mnt|Add a photo'))}</span><small>${ui.esc(tr('PDF, JPG, PNG, WebP, Word or Excel · up to 25 MB'))}</small><i class="drop__bar" hidden><b></b></i></label>
        <p class="upload__msg" data-upload-msg hidden></p></form>` : '';
      const comment = !['closed'].includes(w.status) ? `<form method="post" action="/portal/requests/${w.id}/comment" class="stack"><input type="hidden" name="_csrf" value="${ui.esc(csrf)}">${ui.textarea('body', tr('mnt|Add a message'), '', { rows: 3 })}${ui.btn(tr('mnt|Send'), { cls: 'btn--primary btn--sm' })}</form>` : '';
      const rate = ['resolved', 'closed'].includes(w.status) && !w.rating ? ui.card(tr('mnt|How was the fix?'), `<form method="post" action="/portal/requests/${w.id}/rate" class="stack"><input type="hidden" name="_csrf" value="${ui.esc(csrf)}">
        <fieldset class="mnt-rate"><legend>${ui.esc(tr('mnt|Your rating'))}</legend>${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" value="${n}" id="r${n}"${n === 5 ? ' required' : ''}><label for="r${n}" title="${ui.esc(tr('mnt|{n} out of 5', { n }))}">★</label>`).join('')}</fieldset>
        ${ui.input('note', tr('mnt|Anything to add'), '', { placeholder: tr('mnt|Optional') })}
        <label class="check"><input type="checkbox" name="reopen" value="1"> ${ui.esc(tr('mnt|The problem is not fixed, reopen it'))}</label>
        ${ui.btn(tr('mnt|Send'), { cls: 'btn--primary btn--sm' })}</form>`) : '';
      const facts = `<dl class="dl"><div><dt>${ui.esc(tr('Status'))}</dt><dd>${tBadge(w.status)}</dd></div>
        <div><dt>${ui.esc(tr('mnt|Category'))}</dt><dd>${ui.esc(tr(CATEGORIES[w.category]))}</dd></div>
        <div><dt>${ui.esc(tr('mnt|How urgent'))}</dt><dd>${ui.esc(tr(URGENCY[w.priority]))}</dd></div>
        <div><dt>${ui.esc(tr('mnt|Where'))}</dt><dd>${ui.esc([w.unit_code, w.location ? tx(w.location) : null].filter(Boolean).join(' · ') || '—')}</dd></div>
        <div><dt>${ui.esc(tr('mnt|Sent'))}</dt><dd>${ui.dt(w.created_at)}</dd></div>
        ${w.resolved_at ? `<div><dt>${ui.esc(tr('mnt|Fixed'))}</dt><dd>${ui.dt(w.resolved_at)}</dd></div>` : ''}
        ${w.rating ? `<div><dt>${ui.esc(tr('mnt|Your rating'))}</dt><dd><span class="mnt-stars">${'★'.repeat(w.rating)}${'☆'.repeat(5 - w.rating)}</span></dd></div>` : ''}</dl>`;
      const body = `${w.description ? `<p class="mnt-desc">${ui.esc(tx(w.description))}</p>` : ''}<div class="grid grid--side">
  <div class="stack">${rate}${ui.card(tr('mnt|Updates'), `${tl ? `<ol class="mnt-tl">${tl}</ol>` : `<p class="muted pad">${ui.esc(tr('mnt|No updates yet.'))}</p>`}${comment}`)}</div>
  <div class="stack">${ui.card(tr('Details'), facts)}${ui.card(tr('mnt|Photos'), `${photos}${upload}` || `<p class="muted pad">${ui.esc(tr('mnt|No photos.'))}</p>`)}</div></div>`;
      P.page(req, res, { title: `${w.ref} · ${tx(w.title)}`, active: 'requests', crumbs: [['/portal/requests', tr('mnt|Maintenance requests')], [null, w.ref]], body });
    });
    pr.post('/requests/:id/comment', need, (req, res, next) => {
      const w = mine(req, req.params.id);
      if (!w) return next();
      const body = h.str(req.body.body, 2000);
      if (!body || w.status === 'closed') return pBack(req, res, `/portal/requests/${w.id}`, 'error', tr('mnt|Write something first.'));
      addEvent(w.id, { kind: 'comment', body, shared: true, portal_user_id: req.tenant.id }, null);
      db.run('UPDATE work_orders SET updated_at = ? WHERE id = ?', now(), w.id);
      pBack(req, res, `/portal/requests/${w.id}`, 'ok', tr('mnt|Message sent.'));
    });
    pr.post('/requests/:id/rate', need, (req, res, next) => {
      const w = mine(req, req.params.id);
      if (!w) return next();
      const n = h.int(req.body.rating);
      if (!['resolved', 'closed'].includes(w.status) || w.rating) return pBack(req, res, `/portal/requests/${w.id}`, 'error', tr('mnt|This request cannot be rated now.'));
      if (!(n >= 1 && n <= 5)) return pBack(req, res, `/portal/requests/${w.id}`, 'error', tr('mnt|Choose from one to five stars.'));
      const note = h.str(req.body.note, 500) || null;
      db.tx(() => {
        db.run('UPDATE work_orders SET rating = ?, rating_note = ?, updated_at = ? WHERE id = ?', n, note, now(), w.id);
        addEvent(w.id, { kind: 'rating', minutes: n, body: note, shared: true, portal_user_id: req.tenant.id }, null);
      });
      if (req.body.reopen) move(db.get('SELECT * FROM work_orders WHERE id = ?', w.id), 'reopened', { note: 'Reopened by the tenant' });
      db.audit(null, 'Tenant rated a repair', 'work_order', w.id, `${w.ref} · ${n}/5`, req.ip);
      pBack(req, res, `/portal/requests/${w.id}`, 'ok', req.body.reopen ? tr('mnt|Thank you. The request is open again.') : tr('mnt|Thank you for the rating.'));
    });
    pr.post('/requests/:id/files', need, express.raw({ type: () => true, limit: h.files.MAX_BYTES + 1024 }), (req, res) => {
      const w = mine(req, req.params.id);
      if (!w || w.status === 'closed') return res.status(404).json({ ok: false, error: tr('That record no longer exists.') });
      const saved = h.files.save(Buffer.isBuffer(req.body) ? req.body : null, h.str(decodeURIComponent(String(req.get('x-file-name') || '')), 200));
      if (saved.error === 'empty') return res.status(422).json({ ok: false, error: tr('Choose a file to upload.') });
      if (saved.error === 'too_big') return res.status(413).json({ ok: false, error: tr('That file is larger than 25 MB.') });
      if (saved.error) return res.status(415).json({ ok: false, error: tr('Upload a PDF, JPG, PNG, WebP, Word (.docx) or Excel (.xlsx) file.') });
      const id = Number(db.run(
        `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, notes, portal_user_id, created_at)
         VALUES (?, 'work_order', ?, 'wo_photo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('documents', 'DOC', 4, true), w.id, saved.file_name.replace(/\.[a-z0-9]+$/i, '') || 'Photo', saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored,
        'Sent by the tenant through the portal', req.tenant.id, now(),
      ).lastInsertRowid);
      db.audit(null, 'Tenant added a photo to a request', 'document', id, w.ref, req.ip);
      res.json({ ok: true, id });
    });
    pr.get('/requests/:id/files/:doc', need, (req, res, next) => {
      const w = mine(req, req.params.id);
      const d = w && db.get("SELECT * FROM documents WHERE id = ? AND entity = 'work_order' AND entity_id = ? AND archived = 0 AND confidential = 0", h.int(req.params.doc), w.id);
      if (!d) return next();
      const file = h.files.path(d.stored);
      if (!file) return res.status(410).type('text').send(tr('This file is missing from the server. Upload it again.'));
      res.set({ 'Content-Type': d.mime, 'Content-Disposition': `inline; filename="${d.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
      res.removeHeader('Content-Security-Policy');
      res.sendFile(file);
    });
  }
};

module.exports.SCHEMA = SCHEMA;
module.exports.ensure = ensure;
module.exports.sla = sla;
module.exports.nextDue = nextDue;
module.exports.generatePpm = generatePpm;
module.exports.SLA_DEFAULT = SLA_DEFAULT;
module.exports.CATEGORIES = CATEGORIES;
