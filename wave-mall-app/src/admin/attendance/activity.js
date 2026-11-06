'use strict';

// "What did they last do?" — one timeline of a person's real records, read from every module that
// keeps who did what. Nothing is guessed: each event is a row somewhere in the database.
//
//   person: { employeeId, userId, names: ['Walid Fathy', 'وليد فتحي'] }
//   feed(person, { from, to, limit, sources, now })  newest first: [{ at, source, icon, title, detail, link, place, tone, end }]
//   last(person, { now })                            the newest event, or null
//   SOURCES                                          { key: [label, icon] }
//
// Sources: the staff app (clocking, location updates), the office (minutes with the office open
// and in use), the activity log, security patrols, cleaning rounds, maintenance work orders,
// parking (booth payments, tills, gate actions), the work hub (tasks), approvals and the sales
// activities (calls, meetings, viewings). Location updates and office minutes are folded into
// spans ("In the mall · 09:10–10:05") in the feed. An activity-log line that repeats a module's
// own record of the same thing (same record, within a few seconds) is left out.

const i18n = require('../i18n');

const { t: tr, tx } = i18n;

const SOURCES = {
  clock: ['att|Clocking', 'log'],
  location: ['att|Location', 'gauge'],
  office: ['att|Office', 'dash'],
  log: ['att|Activity log', 'file'],
  patrol: ['att|Patrols', 'shield'],
  cleaning: ['att|Cleaning', 'check'],
  maintenance: ['att|Maintenance', 'wrench'],
  parking: ['att|Parking', 'car'],
  tasks: ['att|Tasks', 'check'],
  approvals: ['att|Approvals', 'check'],
  sales: ['att|Sales', 'leads'],
};

const REASON_SHORT = { no_fence: 'att|no circle set', no_position: 'att|no position', no_time: 'att|no time', future: 'att|dated in the future', stale: 'att|old reading', weak: 'att|weak signal', outside: 'att|outside the circle', jump: 'att|impossible jump', order: 'att|out of order', device: 'att|unknown phone', no_selfie: 'att|no photo' };
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const PUNCH = { in: 'att|Clocked in', out: 'att|Clocked out', break_start: 'att|Started a break', break_end: 'att|Back from the break' };
const PUNCH_REFUSED = { in: 'att|Clocking in was refused', out: 'att|Clocking out was refused', break_start: 'att|Starting a break was refused', break_end: 'att|Ending a break was refused' };
const WO_EVENT = { comment: 'att|Added a note to', status: 'att|Changed the status of', time: 'att|Logged time on', cost: 'att|Added a cost to', assignment: 'att|Assigned', rating: 'att|Rated' };
const WK_EVENT = { created: 'att|Created the task', status: 'att|Moved the task', comment: 'att|Commented on the task', assigned: 'att|Assigned the task', watched: 'att|Started following the task' };
const APR_EVENT = { submitted: 'att|Asked for approval:', approved: 'att|Approved', rejected: 'att|Did not approve', comment: 'att|Commented on', info_asked: 'att|Asked a question about', info_given: 'att|Answered a question about', withdrawn: 'att|Withdrew', claimed: 'att|Took on', reassigned: 'att|Handed on', escalated: 'att|Escalated', reminded: 'att|Sent a reminder about' };
const ACT_TYPE = { call: 'att|Logged a call with', meeting: 'att|Held a meeting with', viewing: 'att|Held a viewing with', email: 'att|Emailed', whatsapp: 'att|Sent a WhatsApp message to', note: 'att|Added a note on', task: 'att|Completed a to-do on' };
// where an activity-log line's record lives
const LOG_LINK = {
  lead: '/admin/leads/', offer: '/admin/offers/', lease: '/admin/leases/', unit: '/admin/units/', brand: '/admin/brands/', invoice: '/admin/invoices/',
  employee: '/admin/hr/employees/', user: '/admin/people/', contract: '/admin/contracts/', payroll: '/admin/hr/payroll/', work_order: '/admin/maintenance/',
  wk_task: '/admin/work/tasks/', apr_request: '/admin/approvals/',
};

module.exports = function activity(h) {
  const { db, ui } = h;
  const has = (() => {
    const cache = new Map();
    return (table) => {
      if (!cache.has(table)) cache.set(table, !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", table));
      return cache.get(table);
    };
  })();
  const navName = (path) => {
    const href = ui.navFor(path);
    const e = href && ui.NAV_ENTRIES.find((x) => x.href === href);
    return e ? tr(e.label) : href === '/admin' ? tr('Dashboard') : tr('att|the office');
  };
  const lower = (names) => (names || []).filter(Boolean).map((n) => String(n).toLowerCase());
  const nameIn = (col, names) => (names.length ? `LOWER(${col}) IN (${names.map(() => '?').join(', ')})` : '0');
  const aprTitle = (e) => {
    try {
      const r = h.approvals && h.approvals.requestOf(e.request_id);
      if (r) return h.approvals.titleOf(r);
    } catch { /* fall back to the stored title */ }
    return tx(e.req_title);
  };
  const meters = (d) => (d === null || d === undefined ? '' : tr('att|{m} m', { m: Math.round(d) }));

  // ---------- each source: rows between from and to (newest first), limited ----------
  const SRC = {
    clock(p, { from, to, limit }) {
      if (!p.employeeId || !has('att_punches')) return [];
      return db.all('SELECT * FROM att_punches WHERE employee_id = ? AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT ?', p.employeeId, from, to, limit).map((x) => {
        const refused = x.status === 'rejected';
        const why = refused ? (parse(x.reasons) || []).map((c) => tr(REASON_SHORT[c] || 'att|refused')).join(' · ') : '';
        const where = x.distance === null ? '' : refused ? meters(x.distance) : x.distance <= Number(db.setting('att_radius') || 100) ? tr('att|inside · {m}', { m: meters(x.distance) }) : tr('att|outside · {m}', { m: meters(x.distance) });
        const via = x.source === 'auto' ? tr('att|closed by the system') : x.source === 'correction' ? tr('att|correction') : x.source === 'hr' ? tr('att|entered by HR') : '';
        return {
          at: x.at, source: 'clock', title: tr((refused ? PUNCH_REFUSED : PUNCH)[x.kind] || 'att|Clocking'),
          detail: [why, where, x.accuracy !== null && x.accuracy !== undefined && x.source === 'app' ? tr('att|±{m} m', { m: Math.round(x.accuracy) }) : '', via].filter(Boolean).join(' · '),
          link: `/admin/attendance/people/${p.employeeId}?date=${x.work_date}`, place: tr('att|Staff app'), tone: refused ? 'rose' : x.status === 'flagged' ? 'amber' : 'ok', id: `p${x.id}`,
        };
      });
    },
    location(p, { from, to, limit }) {
      if (!p.employeeId || !has('att_pings')) return [];
      return db.all('SELECT * FROM att_pings WHERE employee_id = ? AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT ?', p.employeeId, from, to, limit).map((x) => ({
        at: x.at, source: 'location', inside: x.inside,
        title: x.inside === 1 ? tr('att|In the mall') : x.inside === 0 ? tr('att|Outside the mall') : tr('att|Location unclear'),
        detail: [meters(x.distance), x.accuracy !== null ? tr('att|±{m} m', { m: Math.round(x.accuracy) }) : '', x.visible ? '' : tr('att|app in the background')].filter(Boolean).join(' · '),
        link: `/admin/attendance/people/${p.employeeId}`, place: tr('att|Staff app'), tone: x.inside === 0 ? 'rose' : x.inside === 1 ? 'ok' : 'mute', id: `g${x.id}`,
      }));
    },
    office(p, { from, to, limit }) {
      if (!p.userId || !has('att_beats')) return [];
      return db.all('SELECT * FROM att_beats WHERE user_id = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT ?', p.userId, from, to, limit).map((x) => ({
        at: x.at, source: 'office', active: x.active, path: x.path,
        title: x.active ? tr('att|Working in {module}', { module: navName(x.path) }) : tr('att|{module} open, not in use', { module: navName(x.path) }),
        detail: '', link: x.path && /^\/admin(\/|$)/.test(x.path) ? x.path : null, place: tr('att|Office'), tone: x.active ? 'ok' : 'mute', id: `b${x.user_id}${x.at}`,
      }));
    },
    log(p, { from, to, limit }) {
      if (!p.userId) return [];
      return db.all('SELECT * FROM audit WHERE user_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT ?', p.userId, from, to, limit).map((a) => ({
        at: a.created_at, source: 'log', title: tx(a.action), detail: a.detail ? tx(a.detail) : '',
        link: LOG_LINK[a.entity] && a.entity_id ? `${LOG_LINK[a.entity]}${a.entity_id}` : null, place: a.entity ? navName(LOG_LINK[a.entity] ? `${LOG_LINK[a.entity]}${a.entity_id}` : '') : tr('att|Activity log'),
        entity: a.entity, entity_id: a.entity_id, tone: 'sea', id: `a${a.id}`,
      }));
    },
    patrol(p, { from, to, limit }) {
      if (!has('sec_scans')) return [];
      const names = lower(p.names);
      return db.all(`SELECT s.*, c.code, c.name cp_name, c.place FROM sec_scans s JOIN sec_checkpoints c ON c.id = s.checkpoint_id
        WHERE (${p.userId ? 's.user_id = ? OR ' : ''}${nameIn('s.guard_name', names)}) AND s.at >= ? AND s.at <= ? ORDER BY s.at DESC LIMIT ?`, ...(p.userId ? [p.userId] : []), ...names, from, to, limit).map((s) => ({
        at: s.at, source: 'patrol', title: tr('att|Scanned checkpoint {code}', { code: s.code }), detail: [tx(s.cp_name), tx(s.place), s.late ? tr('att|late') : ''].filter(Boolean).join(' · '),
        link: '/admin/security/patrols', place: tr('nav|Security & cleaning'), tone: s.late ? 'amber' : 'ok', id: `s${s.id}`,
      }));
    },
    cleaning(p, { from, to, limit }) {
      if (!has('sec_clean_logs')) return [];
      const names = lower(p.names);
      return db.all(`SELECT l.*, a.code, a.name area_name FROM sec_clean_logs l JOIN sec_clean_areas a ON a.id = l.area_id
        WHERE (${p.userId ? 'l.user_id = ? OR ' : ''}${nameIn('l.cleaner_name', names)}) AND l.at >= ? AND l.at <= ? ORDER BY l.at DESC LIMIT ?`, ...(p.userId ? [p.userId] : []), ...names, from, to, limit).map((l) => ({
        at: l.at, source: 'cleaning', title: tr('att|Cleaned {area}', { area: tx(l.area_name) }), detail: l.code,
        link: '/admin/security/cleaning', place: tr('nav|Security & cleaning'), tone: l.check_status === 'redo' ? 'amber' : 'ok', id: `c${l.id}`,
      }));
    },
    maintenance(p, { from, to, limit }) {
      if (!p.userId || !has('wo_events')) return [];
      return db.all(`SELECT e.*, w.ref, w.title wo_title FROM wo_events e JOIN work_orders w ON w.id = e.wo_id
        WHERE e.user_id = ? AND e.created_at >= ? AND e.created_at <= ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`, p.userId, from, to, limit).map((e) => ({
        at: e.created_at, source: 'maintenance', title: `${tr(WO_EVENT[e.kind] || 'att|Updated')} ${e.ref}`, detail: tx(e.wo_title),
        link: `/admin/maintenance/${e.wo_id}`, place: tr('nav|Maintenance'), tone: 'sky', entity: 'work_order', entity_id: e.wo_id, id: `w${e.id}`,
      }));
    },
    parking(p, { from, to, limit }) {
      if (!p.userId || !has('pk_payments')) return [];
      const pays = db.all("SELECT * FROM pk_payments WHERE user_id = ? AND at >= ? AND at <= ? AND status = 'ok' ORDER BY at DESC LIMIT ?", p.userId, from, to, limit).map((x) => ({
        at: x.at, source: 'parking', title: tr('att|Took a parking payment of {amount}', { amount: ui.money(x.amount) }), detail: x.ref, link: '/admin/parking', place: tr('nav|Parking'), tone: 'ok', id: `k${x.id}`,
      }));
      const tills = db.all('SELECT * FROM pk_tills WHERE (user_id = ? AND opened_at >= ? AND opened_at <= ?) OR (closed_by = ? AND closed_at >= ? AND closed_at <= ?) ORDER BY opened_at DESC LIMIT ?', p.userId, from, to, p.userId, from, to, limit).flatMap((x) => [
        x.user_id === p.userId && x.opened_at >= from && x.opened_at <= to ? { at: x.opened_at, source: 'parking', title: tr('att|Opened the till {name}', { name: tx(x.name) }), detail: x.ref, link: '/admin/parking/tills', place: tr('nav|Parking'), tone: 'sea', id: `ko${x.id}` } : null,
        x.closed_by === p.userId && x.closed_at && x.closed_at >= from && x.closed_at <= to ? { at: x.closed_at, source: 'parking', title: tr('att|Closed the till {name}', { name: tx(x.name) }), detail: x.ref, link: '/admin/parking/tills', place: tr('nav|Parking'), tone: 'sea', id: `kc${x.id}` } : null,
      ].filter(Boolean));
      return [...pays, ...tills];
    },
    tasks(p, { from, to, limit }) {
      if (!p.userId || !has('wk_events')) return [];
      return db.all(`SELECT e.*, t.ref, t.title task_title FROM wk_events e JOIN wk_tasks t ON t.id = e.task_id
        WHERE e.user_id = ? AND e.at >= ? AND e.at <= ? ORDER BY e.at DESC, e.id DESC LIMIT ?`, p.userId, from, to, limit).map((e) => ({
        at: e.at, source: 'tasks', title: `${tr(WK_EVENT[e.kind] || 'att|Updated the task')} ${e.ref}`, detail: e.task_title,
        link: `/admin/work/tasks/${e.task_id}`, place: tr('nav|Approvals & tasks'), tone: 'sky', entity: 'wk_task', entity_id: e.task_id, id: `t${e.id}`,
      }));
    },
    // a request's name as Approvals shows it (translated for the kinds that describe themselves)
    approvals(p, { from, to, limit }) {
      if (!p.userId || !has('apr_events')) return [];
      return db.all(`SELECT e.*, r.ref, r.title req_title FROM apr_events e JOIN apr_requests r ON r.id = e.request_id
        WHERE e.user_id = ? AND e.at >= ? AND e.at <= ? ORDER BY e.at DESC, e.id DESC LIMIT ?`, p.userId, from, to, limit).map((e) => ({
        at: e.at, source: 'approvals', title: `${tr(APR_EVENT[e.action] || 'att|Worked on')} ${e.ref}`, detail: aprTitle(e),
        link: `/admin/approvals/${e.request_id}`, place: tr('nav|Approvals & tasks'), tone: e.action === 'rejected' ? 'rose' : 'sky', entity: 'apr_request', entity_id: e.request_id, id: `r${e.id}`,
      }));
    },
    sales(p, { from, to, limit }) {
      if (!p.userId) return [];
      return db.all(`SELECT a.*, b.name brand_name, l.id lid FROM activities a LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN brands b ON b.id = COALESCE(a.brand_id, l.brand_id)
        WHERE a.user_id = ? AND a.done_at IS NOT NULL AND a.done_at >= ? AND a.done_at <= ? ORDER BY a.done_at DESC LIMIT ?`, p.userId, from, to, limit).map((a) => ({
        at: a.done_at, source: 'sales', title: `${tr(ACT_TYPE[a.type] || 'att|Worked on')} ${a.brand_name || ''}`.trim(), detail: tx(a.subject) || '',
        link: a.lid ? `/admin/leads/${a.lid}` : null, place: tr('Leads'), tone: 'sea', entity: 'lead', entity_id: a.lid, id: `v${a.id}`,
      }));
    },
  };

  // fold location updates and office minutes into spans; drop log lines another source already shows
  function fold(events) {
    const out = [];
    const sorted = [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    for (const e of sorted) {
      const prev = out[out.length - 1];
      if (prev && e.source === 'location' && prev.source === 'location' && prev.inside === e.inside && Date.parse(prev.start || prev.at) - Date.parse(e.at) <= 20 * 60000) {
        prev.start = e.at;
        prev.count = (prev.count || 1) + 1;
        continue;
      }
      if (prev && e.source === 'office' && prev.source === 'office' && Date.parse(prev.start || prev.at) - Date.parse(e.at) <= 3 * 60000) {
        prev.start = e.at;
        prev.count = (prev.count || 1) + 1;
        prev.activeMin = (prev.activeMin || (prev.active ? 1 : 0)) + (e.active ? 1 : 0);
        prev.modules = prev.modules || new Set([navName(prev.path)]);
        prev.modules.add(navName(e.path));
        continue;
      }
      out.push({ ...e });
    }
    for (const e of out) {
      if (e.source === 'office') {
        const mods = [...(e.modules || new Set([navName(e.path)]))].slice(0, 4);
        const active = e.activeMin ?? (e.active ? 1 : 0);
        e.end = e.at;
        e.title = active ? tr('att|Working in the office') : tr('att|Office open, not in use');
        e.detail = [mods.join(i18n.isAr() ? '، ' : ', '), active ? tr('att|{n} active min', { n: active }) : ''].filter(Boolean).join(' · ');
      } else if (e.source === 'location' && e.count > 1) {
        e.end = e.at;
        e.detail = [e.detail, tr('att|{n} updates', { n: e.count })].filter(Boolean).join(' · ');
      }
    }
    // an activity-log line for the same record as a module's own event, a few seconds apart
    const near = (a, b) => Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= 5000;
    return out.filter((e) => !(e.source === 'log' && e.entity && out.some((o) => o !== e && o.source !== 'log' && o.entity === e.entity && o.entity_id === e.entity_id && near(o, e))));
  }

  function feed(person, { from = '0000', to = null, limit = 200, sources = null, now = new Date().toISOString() } = {}) {
    const upto = to && to < now ? to : now; // never anything dated in the future
    const keys = (sources && sources.length ? sources : Object.keys(SRC)).filter((k) => SRC[k]);
    const raw = [];
    for (const k of keys) {
      try {
        // folded sources need more rows to make the same number of events
        raw.push(...SRC[k](person, { from, to: upto, limit: ['location', 'office'].includes(k) ? limit * 30 : limit }));
      } catch (err) {
        if (!/no such table|no such column/.test(String(err.message))) throw err;
      }
    }
    return fold(raw).slice(0, limit).map((e) => ({ ...e, icon: (SOURCES[e.source] || [])[1] || 'log', label: tr((SOURCES[e.source] || [])[0] || 'att|Activity') }));
  }
  // the newest real event: every source's newest row, then the newest of those
  function last(person, { now = new Date().toISOString(), sources = null } = {}) {
    let best = null;
    for (const k of (sources || Object.keys(SRC))) {
      try {
        const [e] = SRC[k](person, { from: '0000', to: now, limit: 1 });
        if (e && (!best || e.at > best.at)) best = e;
      } catch (err) {
        if (!/no such table|no such column/.test(String(err.message))) throw err;
      }
    }
    if (best && best.source === 'office') best.title = best.active ? tr('att|Working in {module}', { module: navName(best.path) }) : tr('att|{module} open, not in use', { module: navName(best.path) });
    return best ? { ...best, icon: (SOURCES[best.source] || [])[1] || 'log', label: tr((SOURCES[best.source] || [])[0] || 'att|Activity') } : null;
  }

  return { feed, last, SOURCES, LOG_LINK };
};

module.exports.SOURCES = SOURCES;
