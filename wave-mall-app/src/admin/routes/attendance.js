'use strict';

// Attendance & activity (/admin/attendance): instead of a fingerprint machine, each person clocks in
// and out on their own registered phone through the staff app (/staff), only inside the mall's
// circle (100 m by default). The office sees, live, who is in, late, on a break, outside the circle
// or not in yet, where they are on a radar, and what each person last did anywhere in the system
// (attendance/activity.js reads every module's own records). Shifts, timesheets, payroll, phones,
// PINs and the settings live here too. The rules are in attendance/engine.js, the data in
// attendance/service.js, the staff app in attendance/staff.js.
//
// Who sees what: HR (and administrators) see everyone; a person linked to an employee who manages
// others sees their own team on the board, the activity stream and the timesheets; nobody else.

const i18n = require('../i18n');
const E = require('../attendance/engine');

const { t: tr, tn, tx } = i18n;

const SHIFT_COLORS = ['sea', 'sky', 'forest', 'sand', 'amber', 'cocoa', 'rose'];
const COLOR_NAME = { sea: 'att|Sea green', sky: 'att|Sky blue', forest: 'att|Forest green', sand: 'att|Sand', amber: 'att|Amber', cocoa: 'att|Cocoa', rose: 'att|Rose' };
const DOW = [[1, 'att|Mon'], [2, 'att|Tue'], [3, 'att|Wed'], [4, 'att|Thu'], [5, 'att|Fri'], [6, 'att|Sat'], [7, 'att|Sun']];
const FILTERS = [
  ['', 'att|Everyone'], ['in', 'att|In the mall'], ['late', 'att|Late today'], ['not_in', 'att|Not in yet'], ['absent', 'att|Absent'], ['break', 'att|On a break'],
  ['outside', 'att|Outside the circle'], ['closed', 'att|App closed'], ['leave', 'att|On leave'], ['off', 'att|Off today'], ['done', 'att|Done for the day'],
];

module.exports = function attendance(router, h) {
  const { db, ui } = h;
  const S = require('../attendance/service')(h);
  const V = require('../attendance/views')(ui);
  const A = require('../attendance/activity')(h);
  const esc = ui.esc;
  h.attendance = S;
  h.activity = A;
  (h.auditTyped = h.auditTyped || []).push('SELECT name FROM att_shifts', 'SELECT name FROM att_holidays', "SELECT note, void_note FROM att_punches WHERE source IN ('hr','correction')", 'SELECT label FROM att_devices', "SELECT json_extract(payload, '$.reason') reason FROM apr_requests WHERE kind = 'attendance'");
  const now = () => new Date().toISOString();
  const today = () => E.cairo(now()).date;
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const isMonth = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));
  const nm = (e) => S.nameOf(e);
  const ini = (e) => {
    const n = nm(e);
    return /[؀-ۿ]/.test(n) ? n.trim().split(/\s+/).map((w) => w.replace(/^ال(?=..)/, '')[0]).slice(0, 2).join(' ') : ui.initials(n);
  };
  const shiftText = (on) => (on ? `${V.hm(on.start)}–${V.hm(on.end)}` : tr('att|No shift'));
  const statusBadge = (st, extra = '') => {
    const [label, tone] = S.STATUS[st] || ['att|Day off', 'mute'];
    return ui.badge(st, `${tr(label)}${extra}`, tone);
  };
  const reasonText = (codes) => (S.parse(codes, []) || []).map((c) => tr(S.REASONS[c] || c)).join(' ');
  const flagText = (codes) => (S.parse(codes, []) || []).map((c) => tr(S.FLAGS[c] || c)).join(' · ');
  const KIND_LABEL = { in: 'att|Clocked in', break_start: 'att|Break started', break_end: 'att|Break ended', out: 'att|Clocked out' };

  // ---------- who may see whom ----------
  const isHR = (req) => h.canHR(req);
  // null: everyone; a Set of employee ids: their team; false: nobody
  function scope(req) {
    if (isHR(req)) return null;
    const me = S.empOfUser(req.user.id);
    if (!me) return false;
    const team = S.teamOf(me.id);
    return team.size ? team : false;
  }
  const RA = (req, res, next) => (scope(req) === false ? h.auth.denied(req, res) : next());
  const RH = h.RH;
  const scoped = (req) => {
    const sc = scope(req);
    return S.activeEmps().filter((e) => sc === null || (sc && sc.has(e.id)));
  };
  const canSee = (req, e) => {
    const sc = scope(req);
    return !!e && (sc === null || (sc && sc.has(e.id)));
  };

  // ---------- approvals: corrections asked from the staff app ----------
  const registerApprovals = (AP) => {
    AP.KINDS.attendance = 'att|Attendance correction';
    AP.describe('attendance', (r) => {
      const p = r.payload || {};
      const e = p.employee_id && S.empOf(p.employee_id);
      return tr('att|Attendance correction: {name} · {what} at {time} on {date}', { name: e ? nm(e) : '—', what: tr(S.LABEL[p.kind] || 'att|Clocking'), time: p.at ? V.hm(p.at) : '—', date: p.work_date ? ui.date(p.work_date) : '—' });
    });
    AP.details('attendance', (r) => {
      const p = r.payload || {};
      const e = p.employee_id && S.empOf(p.employee_id);
      if (!e) return '';
      const d = S.dayOf(e, p.work_date || today());
      return `<dl class="dl"><div><dt>${esc(tr('att|Person'))}</dt><dd><a href="/admin/attendance/people/${e.id}?date=${esc(p.work_date)}">${esc(nm(e))}</a></dd></div>
        <div><dt>${esc(tr('att|Asked for'))}</dt><dd>${esc(tr(S.LABEL[p.kind] || ''))} · ${esc(V.hm(p.at))} · ${ui.date(p.work_date)}</dd></div>
        <div><dt>${esc(tr('att|Reason'))}</dt><dd>${esc(p.reason || '—')}</dd></div>
        <div><dt>${esc(tr('att|That day so far'))}</dt><dd>${d.spans.map((s) => `${V.hm(s.in)}–${s.out ? V.hm(s.out) : '…'}`).join(' · ') || esc(tr('att|No clocking'))}</dd></div></dl>`;
    });
    AP.onDecision('attendance', (r, decision, user) => {
      if (decision !== 'approved') return;
      const p = r.payload || {};
      const e = S.empOf(p.employee_id);
      if (!e || !S.KINDS.includes(p.kind) || !p.at) throw new Error('att|This correction no longer fits. Reject it and ask for a new one.');
      // a corrected clock-out replaces the one the system made
      if (p.kind === 'out') {
        for (const x of db.all("SELECT * FROM att_punches WHERE employee_id = ? AND work_date = ? AND kind = 'out' AND source = 'auto' AND voided_at IS NULL", e.id, p.work_date)) {
          db.run('UPDATE att_punches SET voided_at = ?, voided_by = ?, void_note = ? WHERE id = ?', now(), user ? user.id : null, 'Replaced by an approved correction', x.id);
        }
      }
      const res = S.clock(e, { kind: p.kind, at: p.at, source: 'correction', by: user, requestId: r.id, note: p.reason || null, demo: r.demo });
      if (!res.ok) throw new Error('att|This correction no longer fits the day’s clocking. Reject it and ask for a new one.');
      if (res.punch.work_date !== p.work_date) db.run('UPDATE att_punches SET work_date = ? WHERE id = ?', p.work_date, res.punch.id);
    });
  };
  if (h.approvals) registerApprovals(h.approvals);
  else (h.approvalHooks = h.approvalHooks || []).push(registerApprovals);

  // notifications in the work hub's inbox (routes/work.js renders them with these sentences)
  try {
    const W = require('./work');
    if (W.NOTE) {
      Object.assign(W.NOTE, {
        att_late: 'att|{who} has not clocked in — the shift started at {start}', att_left: 'att|{who} left the mall’s circle while clocked in',
        att_auto_out: 'att|{who} did not clock out; the system closed the day', att_refused: 'att|{who} was refused {n} times when clocking',
        att_device: 'att|{who} is signing in from a new phone ({label}) that needs your approval', att_correction: 'att|{who} asks to correct their attendance',
      });
      if (W.NOTE_ICON) Object.assign(W.NOTE_ICON, { att_late: 'log', att_left: 'gauge', att_auto_out: 'log', att_refused: 'shield', att_device: 'phone', att_correction: 'log' });
    }
  } catch { /* the work hub is optional */ }

  // ---------- the frame ----------
  const TABS = [
    ['/admin/attendance', 'att|Live board', false], ['/admin/attendance/activity', 'att|Activity', false], ['/admin/attendance/timesheets', 'att|Timesheets', false],
    ['/admin/attendance/exceptions', 'att|Exceptions', true], ['/admin/attendance/shifts', 'att|Shifts', true], ['/admin/attendance/devices', 'att|Phones & PINs', true],
    ['/admin/attendance/settings', 'att|Settings', true],
  ];
  const JS_TEXT = () => ({
    justNow: tr('att|just now'), minAgo: tr('att|{n} min ago'), hMinAgo: tr('att|{h} h {m} min ago'), durM: tr('att|{m} min'), durHM: tr('att|{h} h {m} min'), durH: tr('att|{h} h'),
    noGeo: tr('att|This device cannot share its location here.'), reading: tr('att|Reading the position for 15 seconds…'), readings: tr('att|{n} readings · best ±{acc} m'), got: tr('att|Done: {n} readings, best ±{acc} m. Check the point, then save.'),
  });
  function frame(req, res, { tab, title, body, actions = '', crumbs = null }) {
    const pend = isHR(req) ? db.value("SELECT COUNT(*) FROM att_devices WHERE status = 'pending'") : 0;
    const tabs = `<nav class="tabs att-tabs">${TABS.filter(([, , hr]) => !hr || isHR(req)).map(([href, label]) => `<a class="tab${tab === href ? ' is-on' : ''}" href="${href}">${esc(tr(label))}${href.endsWith('/devices') && pend ? ` <b class="nav__count">${pend}</b>` : ''}</a>`).join('')}</nav>`;
    const warn = !S.fenceSet() ? `<p class="alert alert--error att-warn">${ui.icon('gauge')} ${esc(tr('att|The mall’s location is not set, so nobody can clock in yet.'))} ${isHR(req) ? `<a href="/admin/attendance/settings">${esc(tr('att|Set it now'))}</a>` : ''}</p>` : '';
    h.page(req, res, { title, active: '/admin/attendance', wide: true, actions, crumbs: crumbs || (tab === '/admin/attendance' ? [] : [['/admin/attendance', tr('nav|Attendance & activity')]]), body: `${tabs}${warn}${body}<div hidden data-att-i18n="${esc(JSON.stringify(JS_TEXT()))}"></div><script src="/admin/attendance.js?v=${ui.ASSETS.att || '0'}" defer></script>` });
  }

  // ---------- the live board ----------
  function personNow(e, t) {
    const date = S.currentDate(e, t);
    const day = S.dayOf(e, date, t);
    const lastIn = day.open ? day.spans[day.spans.length - 1].in : null;
    const lastPunch = db.get("SELECT * FROM att_punches WHERE employee_id = ? AND status != 'rejected' AND voided_at IS NULL AND at <= ? ORDER BY at DESC, id DESC LIMIT 1", e.id, t);
    const ping = lastIn ? db.get('SELECT * FROM att_pings WHERE employee_id = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT 1', e.id, lastIn, t) : null;
    const pingSure = lastIn ? db.get('SELECT * FROM att_pings WHERE employee_id = ? AND at >= ? AND at <= ? AND inside IS NOT NULL ORDER BY at DESC LIMIT 1', e.id, lastIn, t) : null;
    const f = S.fence();
    let loc = null;
    if (day.open) {
      const src = pingSure || (lastPunch && lastPunch.distance !== null ? lastPunch : null);
      if (src) loc = { at: src.at, distance: src.distance, inside: src.inside !== undefined ? src.inside : src.distance <= f.radius ? 1 : 0, lat: src.lat, lng: src.lng, accuracy: src.accuracy };
    }
    const signal = day.open ? [ping && ping.at, lastPunch && lastPunch.at].filter(Boolean).sort().pop() : null;
    const closed = !!(day.open && signal && Date.parse(t) - Date.parse(signal) > (S.num('att_ping_min') * 2 + 2) * 60000);
    const last = A.last(S.personOf(e), { now: t });
    const office = S.officeOf(e.user_id, t);
    const outside = !!(day.open && loc && loc.inside === 0);
    const light = V.light(last && last.at, { atWork: day.open, now: t });
    return { e, date, day, loc, signal, closed, last, office, outside, light };
  }
  function bucketsOf(p) {
    const d = p.day;
    const b = new Set();
    if (d.open) b.add(p.outside ? 'outside' : 'in');
    if (d.onBreak) b.add('break');
    if (p.closed) b.add('closed');
    if (d.lateMin && (d.open || d.status === 'done')) b.add('late');
    if (d.status === 'not_in') b.add('not_in');
    if (d.status === 'absent') b.add('absent');
    if (d.status === 'leave') b.add('leave');
    if (['off', 'holiday', 'upcoming'].includes(d.status)) b.add('off');
    if (d.status === 'done') b.add('done');
    return b;
  }
  const PRIORITY = { not_in: 0, absent: 1, outside: 2, closed: 3, late: 4, break: 5, in: 6, done: 7, upcoming: 8, leave: 9, off: 10 };
  const rank = (p) => Math.min(...[...bucketsOf(p)].map((k) => PRIORITY[k] ?? 9), 11);
  function officeLine(o) {
    if (!o || o.state === 'never') return '';
    const where = o.path ? (() => { const href = ui.navFor(o.path); const en = href && ui.NAV_ENTRIES.find((x) => x.href === href); return en ? tr(en.label) : tr('Dashboard'); })() : '';
    const text = o.state === 'active' ? tr('att|Office: active now in {where}', { where }) : o.state === 'idle' ? tr('att|Office: open, idle since {time}', { time: V.hm(o.since) }) : tr('att|Office: offline since {time}', { time: V.hm(o.since) });
    return `<p class="att-card__office att-office--${esc(o.state)}">${ui.icon('dash')}<span>${esc(text)}${o.minutesToday ? ` · ${esc(tr('att|{n} active min today', { n: o.minutesToday }))}` : ''}</span></p>`;
  }
  function locLine(p) {
    const d = p.day;
    if (!d.open) {
      if (d.status === 'done') return `<p class="att-card__loc">${ui.icon('check')}<span>${esc(tr('att|Clocked out at {time}', { time: V.hm(d.lastOut) }))}${d.incomplete ? ` · <b class="att-warnword">${esc(tr('att|closed by the system'))}</b>` : ''}</span></p>`;
      return '';
    }
    if (p.closed) return `<p class="att-card__loc att-loc--closed">${ui.icon('phone')}<span>${esc(tr('att|App closed since {time} — location unknown since then', { time: V.hm(p.signal) }))}</span></p>`;
    if (!p.loc) return `<p class="att-card__loc att-loc--unknown">${ui.icon('gauge')}<span>${esc(tr('att|Location not known yet'))}</span></p>`;
    const where = p.loc.inside === 1 ? tr('att|Inside · {m} from the centre', { m: tr('att|{m} m', { m: Math.round(p.loc.distance) }) }) : tr('att|Outside · {m} from the centre', { m: tr('att|{m} m', { m: Math.round(p.loc.distance) }) });
    return `<p class="att-card__loc att-loc--${p.loc.inside === 1 ? 'in' : 'out'}">${ui.icon('gauge')}<span>${esc(where)} · ${V.ago(p.loc.at)}</span></p>`;
  }
  function card(p) {
    const { e, day: d } = p;
    const extra = d.lateMin && (d.open || d.status === 'done') ? ` · ${tr('att|late {n} min', { n: d.lateMin })}` : '';
    const facts = [
      `<span>${ui.icon('cal')}${esc(shiftText(d.on))}${d.on && d.on.overnight ? ` <small>${esc(tr('att|overnight'))}</small>` : ''}</span>`,
      d.firstIn ? `<span>${ui.icon('log')}${esc(tr('att|In {time}', { time: V.hm(d.firstIn) }))}</span>` : '',
      d.workedMin || d.open ? `<span class="att-worked" ${d.open && !d.onBreak ? `data-live-from="${esc(new Date(Date.now() - d.workedMin * 60000).toISOString())}"` : ''}>${ui.icon('check')}<b>${esc(V.dur(d.workedMin))}</b></span>` : '',
    ].filter(Boolean).join('');
    const last = p.last
      ? `<a class="att-card__last" href="${esc(p.last.link || `/admin/attendance/people/${e.id}`)}">${ui.icon(p.last.icon)}<span><b>${esc(p.last.title)}</b>${p.last.detail || p.last.place ? `<small>${esc([p.last.detail, p.last.place].filter(Boolean).join(' · '))}</small>` : ''}</span>${V.ago(p.last.at)}</a>`
      : `<p class="att-card__last is-none">${ui.icon('log')}<span>${esc(tr('att|No activity recorded yet'))}</span></p>`;
    return `<article class="att-card att-card--${p.light}" data-status="${esc([...bucketsOf(p)].join(' '))}">
      <header class="att-card__head"><a class="att-av att-av--${p.light}" href="/admin/attendance/people/${e.id}"><span>${esc(ini(e))}</span></a>
        <div class="att-card__who"><a href="/admin/attendance/people/${e.id}"><b>${esc(nm(e))}</b></a><small>${esc([tx(e.position), tx(e.dept)].filter(Boolean).join(' · '))}</small></div>
        ${statusBadge(d.status, extra)}</header>
      <div class="att-card__facts">${facts}</div>
      ${locLine(p)}${last}${officeLine(p.office)}
    </article>`;
  }
  function boardModel(req) {
    const t = now();
    S.sweep(t);
    const q = req.query;
    let people = scoped(req).map((e) => personNow(e, t));
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k ? people.filter((p) => bucketsOf(p).has(k)).length : people.length]));
    if (h.int(q.dept)) people = people.filter((p) => p.e.department_id === h.int(q.dept));
    if (q.q) { const s = String(q.q).toLowerCase(); people = people.filter((p) => [p.e.name, p.e.name_ar, p.e.code, p.e.position].some((x) => String(x || '').toLowerCase().includes(s))); }
    const show = FILTERS.some(([k]) => k === q.show) ? q.show : '';
    if (show) people = people.filter((p) => bucketsOf(p).has(show));
    const sort = ['attention', 'name', 'recent', 'worked'].includes(q.sort) ? q.sort : 'attention';
    const byName = (a, b) => nm(a.e).localeCompare(nm(b.e), i18n.isAr() ? 'ar' : 'en');
    people.sort(sort === 'name' ? byName : sort === 'recent' ? (a, b) => String(b.last ? b.last.at : '').localeCompare(String(a.last ? a.last.at : '')) || byName(a, b)
      : sort === 'worked' ? (a, b) => b.day.workedMin - a.day.workedMin || byName(a, b) : (a, b) => rank(a) - rank(b) || byName(a, b));
    return { t, people, counts, show, sort };
  }
  function boardHtml(req, m) {
    const qs = (extra) => {
      const p = new URLSearchParams();
      for (const k of ['dept', 'q', 'sort', 'show']) if (req.query[k]) p.set(k, req.query[k]);
      for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v); else p.delete(k);
      const s = p.toString();
      return `/admin/attendance${s ? `?${s}` : ''}`;
    };
    const chips = `<nav class="att-chips">${FILTERS.map(([k, label]) => `<a class="att-chip att-chip--${k || 'all'}${m.show === k ? ' is-on' : ''}" href="${esc(qs({ show: k }))}"><b>${m.counts[k]}</b><span>${esc(tr(label))}</span></a>`).join('')}</nav>`;
    const grid = m.people.length ? `<div class="att-grid">${m.people.map(card).join('')}</div>` : ui.empty(tr('att|Nobody matches.'));
    return `${chips}${grid}`;
  }
  function liveRadar(m) {
    const f = S.fence();
    if (!S.fenceSet()) return '';
    const pts = m.people.filter((p) => p.day.open && p.loc && p.loc.lat !== null && p.loc.lat !== undefined).map((p) => ({
      lat: p.loc.lat, lng: p.loc.lng, tone: p.loc.inside === 1 ? (p.closed ? 'amber' : 'ok') : 'rose', label: nm(p.e), initials: ini(p.e), size: 11,
      sub: `${tr('att|{m} m', { m: Math.round(p.loc.distance) })} · ${V.hm(p.loc.at)}`, href: `/admin/attendance/people/${p.e.id}`, pulse: !p.closed,
    }));
    return ui.card(tr('att|Who is where'), `${V.radar({ center: f, radius: f.radius, points: pts, size: 440, title: tr('att|North up · true scale · circle {m}', { m: tr('att|{m} m', { m: f.radius }) }) })}<p class="muted small">${esc(tr('att|Each dot is the last position the person’s phone sent while clocked in. Amber: the app has been closed since.'))}</p>`, { cls: 'att-radarcard' });
  }

  router.get('/attendance', RA, (req, res) => {
    const m = boardModel(req);
    const depts = db.all('SELECT id, name FROM departments ORDER BY sort, name');
    const filters = `<form method="get" action="/admin/attendance" class="filters att-filters">${req.query.show ? `<input type="hidden" name="show" value="${esc(req.query.show)}">` : ''}
      ${ui.input('q', tr('Search'), req.query.q || '', { type: 'search', placeholder: tr('att|Name, code, job') })}
      ${ui.select('dept', tr('hr|Department'), depts.map((d) => [d.id, tx(d.name)]), req.query.dept || '', { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}
      ${ui.select('sort', tr('sort|Sort by'), [['attention', tr('att|Needs attention first')], ['name', tr('sort|Name: A to Z')], ['recent', tr('att|Most recent activity')], ['worked', tr('att|Most time worked')]], m.sort, { attrs: { 'data-autosubmit': '' } })}
      <div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div>
      <div class="filters__quick"><a class="chip" href="/admin/attendance/timesheets?view=day&date=${today()}">${esc(tr('att|Today’s register'))}</a><a class="chip" href="/admin/attendance/timesheets?view=day&date=${E.addDays(today(), -1)}">${esc(tr('att|Yesterday'))}</a><a class="chip" href="/admin/attendance/timesheets">${esc(tr('att|This month'))}</a></div></form>`;
    const officeOnly = isHR(req) ? officeAccounts(m.t) : '';
    const live = `<div class="att-livebar"><span class="att-pulse"></span><span>${esc(tr('att|Live'))}</span><small data-att-updated>${esc(tr('att|Updated {time}', { time: V.hm(m.t) }))}</small></div>`;
    frame(req, res, {
      tab: '/admin/attendance', title: tr('nav|Attendance & activity'),
      actions: `${ui.btn(esc(tr('att|Staff app')), { href: '/staff', cls: 'btn--ghost', ic: 'phone', attrs: { target: '_blank', rel: 'noopener' } })}`,
      body: `${live}${filters}<div class="att-board"><div class="att-board__main" id="att-live" data-live="/admin/attendance/live.json${req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : ''}">${boardHtml(req, m)}</div><aside class="att-board__side">${liveRadar(m)}${alertsCard(req)}${officeOnly}</aside></div>`,
    });
  });
  router.get('/attendance/live.json', RA, (req, res) => {
    const m = boardModel(req);
    res.set('Cache-Control', 'no-store').json({ ok: true, at: m.t, html: boardHtml(req, m), updated: tr('att|Updated {time}', { time: V.hm(m.t) }) });
  });

  // office accounts with no employee record: their office presence and last action
  function officeAccounts(t) {
    const users = db.all('SELECT * FROM users WHERE active = 1 AND id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL) ORDER BY name');
    if (!users.length) return '';
    const rows = users.map((u) => ({ u, o: S.officeOf(u.id, t), last: A.last({ userId: u.id, names: [] }, { now: t }) }))
      .sort((a, b) => String(b.last ? b.last.at : '').localeCompare(String(a.last ? a.last.at : '')));
    return ui.card(tr('att|Office accounts'), `<ul class="list att-users">${rows.map(({ u, o, last }) => `<li><a href="/admin/attendance/users/${u.id}"><span class="att-av att-av--sm att-av--${o && o.state === 'active' ? 'green' : o && o.state === 'idle' ? 'amber' : 'grey'}"><span>${esc(ui.initials(u.name))}</span></span><span class="what"><b>${esc(u.name)}</b><small>${last ? `${esc(last.title)} · ${V.ago(last.at)}` : esc(tr('att|No activity recorded yet'))}</small></span></a></li>`).join('')}</ul>`, { sub: esc(tr('att|People who sign in to the office without an employee record')) });
  }
  function alertsCard(req) {
    const sc = scope(req);
    const list = db.all(`SELECT a.*, e.name, e.name_ar FROM att_alerts a LEFT JOIN employees e ON e.id = a.employee_id WHERE a.at >= ? ORDER BY a.at DESC LIMIT 40`, new Date(Date.now() - 2 * 86400000).toISOString())
      .filter((a) => sc === null || (sc && sc.has(a.employee_id))).slice(0, 8);
    if (!list.length) return '';
    const text = (a) => {
      const d = S.parse(a.detail, {});
      const who = i18n.isAr() && a.name_ar ? a.name_ar : a.name;
      return {
        late: tr('att|{who} has not clocked in — the shift started at {start}', { who, start: d.start || '' }), left: tr('att|{who} left the mall’s circle while clocked in', { who }),
        auto_out: tr('att|{who} did not clock out; the system closed the day', { who }), refused: tr('att|{who} was refused {n} times when clocking', { who, n: d.n || 3 }),
        device: tr('att|{who} is signing in from a new phone ({label}) that needs your approval', { who, label: d.label || '' }),
      }[a.kind] || a.kind;
    };
    return ui.card(tr('att|Alerts · last 48 hours'), `<ul class="list att-alerts">${list.map((a) => `<li><a href="${a.kind === 'device' ? '/admin/attendance/devices' : `/admin/attendance/people/${a.employee_id}`}">${ui.icon(a.kind === 'device' ? 'phone' : a.kind === 'left' ? 'gauge' : 'log')}<span class="what"><b>${esc(text(a))}</b><small>${V.ago(a.at)}</small></span></a></li>`).join('')}</ul>`);
  }

  // ---------- one person ----------
  function feedFilters(req, { keep = [] } = {}) {
    const f = h.listFilters(req, { cols: { date: 'at' }, dateLabel: tr('att|Day'), keep: ['date', 'source', 'person', 'dept', ...keep], sort: { date: 'at' } });
    const src = Object.keys(A.SOURCES).includes(req.query.source) ? req.query.source : '';
    return { f, src };
  }
  const feedList = (events, { who = null } = {}) => (events.length ? `<ol class="att-feed">${events.map((ev) => `<li class="att-feed__i att-feed__i--${esc(ev.tone || 'sea')}">
      <span class="att-feed__ic">${ui.icon(ev.icon)}</span>
      <div class="att-feed__body">${who ? `<p class="att-feed__who">${who(ev)}</p>` : ''}<p class="att-feed__t">${ev.link ? `<a href="${esc(ev.link)}">${esc(ev.title)}</a>` : esc(ev.title)}</p>${ev.detail ? `<p class="att-feed__d">${esc(ev.detail)}</p>` : ''}</div>
      <div class="att-feed__when"><b>${esc(ev.end && ev.end !== ev.at && ev.start ? `${V.hm(ev.start)}–${V.hm(ev.at)}` : ev.start ? `${V.hm(ev.start)}–${V.hm(ev.at)}` : V.hm(ev.at))}</b><small>${esc(ui.date(E.cairo(ev.at).date))}</small><span class="badge badge--mute">${esc(ev.label)}</span></div></li>`).join('')}</ol>` : ui.empty(tr('att|Nothing recorded for this period.')));

  function dayTimeline(e, date, d, t) {
    const on = d.on;
    const punches = S.punchesOn(e.id, date, { all: true });
    const first = [on && on.start, ...punches.map((p) => p.at)].filter(Boolean).sort()[0] || E.cairoAt(date, '09:00');
    const lastT = [on && on.end, ...punches.map((p) => p.at), d.open ? t : null].filter(Boolean).sort().pop() || E.cairoAt(date, '18:00');
    const from = new Date(Date.parse(first) - 45 * 60000).toISOString();
    const to = new Date(Math.max(Date.parse(lastT) + 45 * 60000, Date.parse(from) + 6 * 3600000)).toISOString();
    const pings = db.all('SELECT * FROM att_pings WHERE employee_id = ? AND at >= ? AND at <= ? ORDER BY at', e.id, from, to);
    const pingSpans = [];
    for (const g of pings) {
      const tone = g.inside === 1 ? 'ok' : g.inside === 0 ? 'rose' : 'mute';
      const prev = pingSpans[pingSpans.length - 1];
      if (prev && prev.tone === tone && Date.parse(g.at) - Date.parse(prev.to) <= (S.num('att_ping_min') * 2 + 2) * 60000) prev.to = g.at;
      else pingSpans.push({ from: g.at, to: new Date(Date.parse(g.at) + 60000).toISOString(), tone, title: `${g.inside === 1 ? tr('att|In the mall') : g.inside === 0 ? tr('att|Outside the mall') : tr('att|Location unclear')} · ${V.hm(g.at)}` });
    }
    for (const s of pingSpans) s.title = `${s.title}–${V.hm(s.to)}`;
    const beats = e.user_id ? db.all('SELECT * FROM att_beats WHERE user_id = ? AND at >= ? AND at <= ? ORDER BY at', e.user_id, from, to) : [];
    const office = [];
    for (const b of beats) {
      const prev = office[office.length - 1];
      const tone = b.active ? 'sky' : 'mute';
      if (prev && prev.tone === tone && Date.parse(b.at) - Date.parse(prev.to) <= 3 * 60000) prev.to = new Date(Date.parse(b.at) + 60000).toISOString();
      else office.push({ from: b.at, to: new Date(Date.parse(b.at) + 60000).toISOString(), tone, title: '' });
    }
    for (const o of office) o.title = `${o.tone === 'sky' ? tr('att|Working in the office') : tr('att|Office open, not in use')} · ${V.hm(o.from)}–${V.hm(o.to)}`;
    const acts = A.feed(S.personOf(e), { from, to, limit: 200, sources: ['log', 'patrol', 'cleaning', 'maintenance', 'parking', 'tasks', 'approvals', 'sales'], now: t });
    const work = [];
    for (const s of d.spans) {
      const end = s.out || (d.open ? t : null);
      let cur = s.in;
      for (const b of s.breaks) {
        work.push({ from: cur, to: b.start, tone: 'forest', title: `${tr('att|Working')} · ${V.hm(cur)}–${V.hm(b.start)}` });
        work.push({ from: b.start, to: b.end || end, tone: 'sand', title: `${tr('att|On a break')} · ${V.hm(b.start)}–${b.end ? V.hm(b.end) : '…'}` });
        cur = b.end || end;
      }
      if (cur && end) work.push({ from: cur, to: end, tone: s.outPunch && s.outPunch.source === 'auto' ? 'amber' : 'forest', open: !s.out, title: `${tr('att|Working')} · ${V.hm(cur)}–${s.out ? V.hm(s.out) : tr('att|now')}` });
    }
    const rows = [
      { label: tr('att|Shift'), items: on ? [{ from: on.start, to: on.end, tone: 'shift', title: `${tr('att|Shift')} · ${shiftText(on)}` }] : [] },
      { label: tr('att|Clocked'), items: work, dots: punches.filter((p) => p.status === 'rejected').map((p) => ({ at: p.at, tone: 'rose', title: `${tr(KIND_LABEL[p.kind])} · ${tr('att|refused')} · ${V.hm(p.at)} · ${reasonText(p.reasons)}` })) },
      { label: tr('att|Location'), items: pingSpans },
      ...(e.user_id ? [{ label: tr('att|Office'), items: office }] : []),
      { label: tr('att|Actions'), dots: acts.map((a) => ({ at: a.at, tone: a.tone, title: `${V.hm(a.at)} · ${a.title}${a.detail ? ` · ${a.detail}` : ''}`, href: a.link })) },
    ];
    const marks = punches.filter((p) => p.status !== 'rejected' && !p.voided_at).map((p) => ({ at: p.at, tone: p.status === 'flagged' ? 'amber' : 'ok', title: `${tr(KIND_LABEL[p.kind])} · ${V.hm(p.at)}` }));
    return V.timeline({ from, to, rows, now: d.open ? t : null, marks });
  }

  function monthDays(e, key, t) {
    const n = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
    const out = {};
    const tot = { scheduled: 0, present: 0, lateDays: 0, lateMin: 0, earlyMin: 0, absent: 0, leave: 0, holiday: 0, worked: 0, scheduledMin: 0, overtime: 0, incomplete: 0 };
    const td = E.cairo(t).date;
    for (let i = 1; i <= n; i++) {
      const date = `${key}-${String(i).padStart(2, '0')}`;
      if (date > td) { out[date] = { status: 'upcoming' }; continue; }
      if (e.hire_date && date < e.hire_date) continue;
      const d = S.dayOf(e, date, t);
      const short = { absent: tr('att|Absent'), leave: tr('att|Leave'), holiday: tr('att|Holiday'), not_in: tr('att|Not in') }[d.status] || '';
      out[date] = { status: d.status, worked: d.workedMin, late: d.lateMin, incomplete: d.incomplete, short, href: `/admin/attendance/people/${e.id}?date=${date}`, title: `${ui.date(date)} · ${tr(S.STATUS[d.status] ? S.STATUS[d.status][0] : 'att|Day off')}${d.workedMin ? ` · ${V.dur(d.workedMin)}` : ''}${d.lateMin ? ` · ${tr('att|late {n} min', { n: d.lateMin })}` : ''}` };
      if (d.on) { tot.scheduled++; tot.scheduledMin += d.on.net; }
      if (d.spans.length) tot.present++;
      if (d.lateMin) { tot.lateDays++; tot.lateMin += d.lateMin; }
      tot.earlyMin += d.earlyMin;
      if (d.status === 'absent') tot.absent++;
      if (d.status === 'leave') tot.leave++;
      if (d.status === 'holiday') tot.holiday++;
      if (d.incomplete) tot.incomplete++;
      tot.worked += d.workedMin;
      tot.overtime += d.overtimeMin;
    }
    tot.punctuality = tot.present ? (tot.present - tot.lateDays) / tot.present : null;
    return { days: out, tot };
  }

  function punchRow(req, p) {
    const canHr = isHR(req);
    const verdict = p.status === 'rejected' ? `${ui.badge('rejected', tr('att|Refused'), 'rose')} <small>${esc(reasonText(p.reasons))}</small>`
      : p.status === 'flagged' ? `${ui.badge('flagged', tr('att|Accepted, flagged'), 'amber')} <small>${esc(flagText(p.flags))}</small>` : ui.badge('ok', tr('att|Accepted'), 'ok');
    const src = { app: tr('att|Staff app'), hr: tr('att|Entered by HR'), correction: tr('att|Approved correction'), auto: tr('att|The system') }[p.source] || p.source;
    return `<tr class="${p.voided_at ? 'is-void' : ''}"><td data-label="${esc(tr('att|Time'))}"><b>${esc(V.hm(p.at))}</b>${p.voided_at ? ` <small class="muted">${esc(tr('att|cancelled'))}</small>` : ''}</td>
      <td data-label="${esc(tr('att|What'))}">${esc(tr(KIND_LABEL[p.kind]))}</td>
      <td data-label="${esc(tr('att|Verdict'))}">${verdict}</td>
      <td data-label="${esc(tr('att|Where'))}">${p.distance !== null ? esc(tr('att|{m} m', { m: Math.round(p.distance) })) : '—'}${p.accuracy !== null ? ` <small class="muted">${esc(tr('att|±{m} m', { m: Math.round(p.accuracy) }))}</small>` : ''}</td>
      <td data-label="${esc(tr('att|How'))}">${esc(src)}${p.note ? `<small class="sub">${esc(tx(p.note))}</small>` : ''}${p.void_note ? `<small class="sub">${esc(tx(p.void_note))}</small>` : ''}</td>
      <td data-label="${esc(tr('att|Photo'))}">${p.selfie && canHr ? `<a href="/admin/attendance/punches/${p.id}/photo" target="_blank" rel="noopener"><img class="att-selfie" src="/admin/attendance/punches/${p.id}/photo" alt="${esc(tr('att|Photo taken when clocking'))}" loading="lazy"></a>` : '—'}</td>
      <td>${canHr && !p.voided_at && p.status !== 'rejected' ? `<details class="pop"><summary class="btn btn--ghost btn--xs">${esc(tr('att|Cancel'))}</summary>${ui.form(`/admin/attendance/punches/${p.id}/void`, req.session.csrf, `${ui.input('note', tr('att|Why'), '', { required: true })}${ui.btn(esc(tr('att|Cancel this clocking')), { cls: 'btn--danger btn--sm' })}`)}</details>` : ''}</td></tr>`;
  }

  router.get('/attendance/people/:id(\\d+)', RA, (req, res, next) => {
    const e = S.empOf(req.params.id);
    if (!e || !canSee(req, e)) return next();
    const t = now();
    S.sweep(t);
    const date = isDate(req.query.date) ? req.query.date : S.currentDate(e, t);
    const d = S.dayOf(e, date, t);
    const p = personNow(e, t);
    const key = isMonth(req.query.month) ? req.query.month : date.slice(0, 7);
    const mon = monthDays(e, key, t);
    const office = S.officeOf(e.user_id, t);
    const head = `<div class="att-hero att-hero--${p.light}">
      <span class="att-av att-av--xl att-av--${p.light}"><span>${esc(ini(e))}</span></span>
      <div class="att-hero__who"><h2>${esc(nm(e))}</h2><p>${esc([tx(e.position), tx(e.dept), e.code].filter(Boolean).join(' · '))}</p><p class="att-hero__now">${statusBadge(p.day.status, p.day.lateMin && (p.day.open || p.day.status === 'done') ? ` · ${tr('att|late {n} min', { n: p.day.lateMin })}` : '')}</p></div>
      <div class="att-hero__last">${p.last ? `<small>${esc(tr('att|Last activity'))}</small><a href="${esc(p.last.link || '#feed')}"><b>${esc(p.last.title)}</b></a><span>${esc([p.last.detail, p.last.place].filter(Boolean).join(' · '))}</span>${V.ago(p.last.at)}` : `<small>${esc(tr('att|Last activity'))}</small><b>${esc(tr('att|No activity recorded yet'))}</b>`}</div>
    </div>`;
    const stat = (label, value, sub = '') => `<div class="att-stat"><small>${esc(label)}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
    const daynav = `<div class="att-daynav"><a class="btn btn--ghost btn--sm" href="?date=${E.addDays(date, -1)}">${ui.icon('back')}<span>${esc(tr('att|Previous day'))}</span></a>
      <form method="get" class="att-daynav__f"><input type="date" name="date" value="${esc(date)}" data-autosubmit aria-label="${esc(tr('att|Day'))}"></form>
      <b>${esc(ui.date(date))}${date === today() ? ` · ${esc(tr('att|today'))}` : ''}</b>
      ${date < today() ? `<a class="btn btn--ghost btn--sm" href="?date=${E.addDays(date, 1)}"><span>${esc(tr('att|Next day'))}</span>${ui.icon('arrow')}</a>` : ''}</div>`;
    const stats = `<div class="att-stats">${stat(tr('att|Shift'), esc(shiftText(d.on)), d.on ? esc(tx(d.on.shift.name)) : '')}
      ${stat(tr('att|First in'), esc(d.firstIn ? V.hm(d.firstIn) : '—'), d.lateMin ? `<span class="att-warnword">${esc(tr('att|late {n} min', { n: d.lateMin }))}</span>` : '')}
      ${stat(tr('att|Last out'), esc(d.lastOut ? V.hm(d.lastOut) : d.open ? tr('att|still in') : '—'), d.earlyMin ? `<span class="att-warnword">${esc(tr('att|left {n} min early', { n: d.earlyMin }))}</span>` : d.incomplete ? `<span class="att-warnword">${esc(tr('att|closed by the system'))}</span>` : '')}
      ${stat(tr('att|Worked'), esc(V.dur(d.workedMin)), d.on ? esc(tr('att|of {d} scheduled', { d: V.dur(d.on.net) })) : '')}
      ${stat(tr('att|Breaks'), esc(V.dur(d.breakMin)))}
      ${stat(tr('att|Overtime'), esc(d.overtimeMin ? V.dur(d.overtimeMin) : '—'))}
      ${e.user_id ? stat(tr('att|In the office'), esc(tr('att|{n} active min', { n: db.value('SELECT COUNT(*) FROM att_beats WHERE user_id = ? AND active = 1 AND at >= ? AND at < ?', e.user_id, E.cairoAt(date, '00:00'), E.cairoAt(E.addDays(date, 1), '00:00')) })), office && date === today() ? esc(office.state === 'active' ? tr('att|active now') : office.state === 'idle' ? tr('att|idle') : tr('att|offline')) : '') : ''}</div>`;
    const tl = ui.card(tr('att|The day, hour by hour'), dayTimeline(e, date, d, t), { sub: esc(tr('att|Shift, clocking and breaks, location while clocked in, office use and every recorded action. Hover for details.')), cls: 'att-tlcard' });
    // positions on the day
    const f = S.fence();
    const pts = [
      ...db.all("SELECT * FROM att_punches WHERE employee_id = ? AND work_date = ? AND lat IS NOT NULL ORDER BY at", e.id, date).map((x) => ({ lat: x.lat, lng: x.lng, tone: x.status === 'rejected' ? 'rose' : x.status === 'flagged' ? 'amber' : 'forest', size: 7, label: `${tr(KIND_LABEL[x.kind])} · ${V.hm(x.at)}`, sub: x.status === 'rejected' ? reasonText(x.reasons) : tr('att|±{m} m', { m: Math.round(x.accuracy || 0) }), at: x.at })),
      ...db.all('SELECT * FROM att_pings WHERE employee_id = ? AND at >= ? AND at < ? AND lat IS NOT NULL ORDER BY at', e.id, E.cairoAt(date, '00:00'), E.cairoAt(E.addDays(date, 2), '00:00'))
        .filter((g) => !d.spans.length || (g.at >= d.spans[0].in && (!d.lastOut || g.at <= d.lastOut))).map((g) => ({ lat: g.lat, lng: g.lng, tone: g.inside === 1 ? 'ok' : g.inside === 0 ? 'rose' : 'mute', size: 4, label: `${tr('att|Location')} · ${V.hm(g.at)}`, sub: tr('att|{m} m', { m: Math.round(g.distance || 0) }), at: g.at })),
    ].sort((a, b) => (a.at < b.at ? -1 : 1));
    const radarCard = S.fenceSet() ? ui.card(tr('att|Positions that day'), V.radar({ center: f, radius: f.radius, points: pts, size: 360, trail: true, title: tr('att|{n} positions · north up', { n: pts.length }) })) : '';
    const punches = S.punchesOn(e.id, date, { all: true });
    const csrf = req.session.csrf;
    const addForm = isHR(req) ? `<details class="pop att-add"><summary class="btn btn--ghost btn--sm">${ui.icon('plus')}<span>${esc(tr('att|Add a clocking'))}</span></summary>${ui.form(`/admin/attendance/people/${e.id}/punches`, csrf, `<div class="fields">${ui.select('kind', tr('att|What'), S.KINDS.map((k) => [k, tr(KIND_LABEL[k])]), 'in')}${ui.input('date', tr('att|Work day'), date, { type: 'date', required: true })}${ui.input('time', tr('att|Time'), '', { type: 'time', required: true })}${ui.input('note', tr('att|Why'), '', { required: true })}</div>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`)}</details>` : '';
    const punchTable = ui.card(tr('att|Clocking that day'), punches.length ? `<div class="tablewrap"><table class="table table--resp att-punches"><thead><tr><th>${esc(tr('att|Time'))}</th><th>${esc(tr('att|What'))}</th><th>${esc(tr('att|Verdict'))}</th><th>${esc(tr('att|Where'))}</th><th>${esc(tr('att|How'))}</th><th>${esc(tr('att|Photo'))}</th><th></th></tr></thead><tbody>${punches.map((x) => punchRow(req, x)).join('')}</tbody></table></div>` : ui.empty(tr('att|No clocking that day.')), { action: addForm });
    const { f: ff, src } = feedFilters(req);
    const ffrom = ff.from ? E.cairoAt(ff.from, '00:00') : E.cairoAt(date, '00:00');
    const fto = ff.to ? E.cairoAt(E.addDays(ff.to, 1), '00:00') : E.cairoAt(E.addDays(date, 1), '04:00');
    let events = A.feed(S.personOf(e), { from: ffrom, to: fto, limit: 300, sources: src ? [src] : null, now: t });
    if (ff.sortKey === 'oldest') events = events.reverse();
    const srcSel = ui.select('source', tr('att|Source'), Object.entries(A.SOURCES).map(([k, [l]]) => [k, tr(l)]), src, { blank: tr('All'), attrs: { 'data-autosubmit': '' } });
    const feedCard = ui.card(tr('att|Everything they did'), `<form method="get" class="filters" id="feed"><input type="hidden" name="date" value="${esc(date)}">${srcSel}${ff.fields}<div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div>${ff.quick}</form>${feedList(events)}`, { sub: esc(ff.from || ff.to ? tr('att|{from} to {to}', { from: ui.date(ff.from || date), to: ui.date(ff.to || date) }) : ui.date(date)) });
    const t2 = mon.tot;
    const monthCard = ui.card(tr('att|{month} at a glance', { month: ui.monthYear(key) }), `<div class="att-monthnav"><a href="?date=${esc(date)}&month=${esc(E.addDays(`${key}-01`, -1).slice(0, 7))}">${ui.icon('back')}</a><b>${esc(ui.monthYear(key))}</b><a href="?date=${esc(date)}&month=${esc(E.addDays(`${key}-28`, 5).slice(0, 7))}">${ui.icon('arrow')}</a></div>${V.month(key, mon.days, { today: today() })}
      <div class="att-mini">${stat(tr('att|Worked'), esc(tr('att|{h} h', { h: V.hours(t2.worked) })), esc(tr('att|of {h} h scheduled', { h: V.hours(t2.scheduledMin) })))}${stat(tr('att|Present'), esc(String(t2.present)), esc(tr('att|of {n} shift days', { n: t2.scheduled })))}${stat(tr('att|Late'), esc(String(t2.lateDays)), esc(tr('att|{n} min in all', { n: t2.lateMin })))}${stat(tr('att|Absent'), esc(String(t2.absent)))}${stat(tr('att|Overtime'), esc(tr('att|{h} h', { h: V.hours(t2.overtime) })))}${stat(tr('att|On time'), t2.punctuality === null ? '—' : esc(ui.pct(t2.punctuality)))}</div>
      <p class="row"><a class="btn btn--ghost btn--sm" href="/admin/attendance/people/${e.id}/timesheet?month=${esc(key)}" target="_blank" rel="noopener">${ui.icon('print')}<span>${esc(tr('att|Print the timesheet'))}</span></a></p>`);
    const access = isHR(req) ? accessCard(req, e) : '';
    const shiftCard = isHR(req) ? shiftAssignCard(req, e) : '';
    frame(req, res, {
      tab: '/admin/attendance', title: nm(e), crumbs: [['/admin/attendance', tr('nav|Attendance & activity')], [null, e.code]],
      actions: isHR(req) ? ui.btn(esc(tr('att|Employee file')), { href: `/admin/hr/employees/${e.id}`, cls: 'btn--ghost', ic: 'people' }) : '',
      body: `${head}${daynav}${stats}${tl}<div class="grid grid--side"><div class="stack">${punchTable}${feedCard}</div><div class="stack">${radarCard}${monthCard}${shiftCard}${access}</div></div>`,
    });
  });

  // an office account with no employee record: the office and the activity only
  router.get('/attendance/users/:id(\\d+)', RH, (req, res, next) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!u) return next();
    const linked = db.get('SELECT id FROM employees WHERE user_id = ?', u.id);
    if (linked) return res.redirect(303, `/admin/attendance/people/${linked.id}`);
    const t = now();
    const { f, src } = feedFilters(req);
    const from = f.from ? E.cairoAt(f.from, '00:00') : new Date(Date.parse(t) - 7 * 86400000).toISOString();
    const to = f.to ? E.cairoAt(E.addDays(f.to, 1), '00:00') : t;
    let events = A.feed({ userId: u.id, names: [] }, { from, to, limit: 300, sources: src ? [src] : null, now: t });
    if (f.sortKey === 'oldest') events = events.reverse();
    const o = S.officeOf(u.id, t);
    const last = A.last({ userId: u.id, names: [] }, { now: t });
    const srcSel = ui.select('source', tr('att|Source'), Object.entries(A.SOURCES).map(([k, [l]]) => [k, tr(l)]), src, { blank: tr('All'), attrs: { 'data-autosubmit': '' } });
    frame(req, res, {
      tab: '/admin/attendance', title: u.name, crumbs: [['/admin/attendance', tr('nav|Attendance & activity')], [null, u.name]],
      body: `<div class="att-hero att-hero--${o && o.state === 'active' ? 'green' : 'grey'}"><span class="att-av att-av--xl"><span>${esc(ui.initials(u.name))}</span></span><div class="att-hero__who"><h2>${esc(u.name)}</h2><p>${esc(ui.roleName(u) || '')} · <span class="ltr">${esc(u.email)}</span></p><p>${esc(tr('att|Not linked to an employee record: no clocking, only office use and actions.'))}</p></div>
        <div class="att-hero__last">${last ? `<small>${esc(tr('att|Last activity'))}</small><a href="${esc(last.link || '#')}"><b>${esc(last.title)}</b></a><span>${esc(last.detail || '')}</span>${V.ago(last.at)}` : ''}</div></div>
        ${officeLine(o)}${ui.card(tr('att|Everything they did'), `<form method="get" class="filters">${srcSel}${f.fields}<div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div>${f.quick}</form>${feedList(events)}`, { sub: esc(f.from || f.to ? '' : tr('att|The last 7 days')) })}`,
    });
  });

  // the printable month for one person (?doc=ar|en)
  router.get('/attendance/people/:id(\\d+)/timesheet', RA, (req, res, next) => {
    const e = S.empOf(req.params.id);
    if (!e || !canSee(req, e)) return next();
    const key = isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
    const doc = req.query.doc === 'ar' || req.query.doc === 'en' ? req.query.doc : i18n.lang();
    i18n.run(doc, () => {
      const t = now();
      const n = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
      const rows = [];
      for (let i = 1; i <= n; i++) {
        const date = `${key}-${String(i).padStart(2, '0')}`;
        if (date > E.cairo(t).date) break;
        const d = S.dayOf(e, date, t);
        rows.push(`<tr><td>${esc(ui.date(date))}</td><td>${esc(ui.weekdays()[E.isoDay(date) - 1])}</td><td>${esc(shiftText(d.on))}</td><td>${esc(d.firstIn ? V.hm(d.firstIn) : '—')}</td><td>${esc(d.lastOut ? V.hm(d.lastOut) : d.open ? '…' : '—')}</td><td class="num">${esc(d.workedMin ? V.dur(d.workedMin) : '—')}</td><td class="num">${esc(d.lateMin ? String(d.lateMin) : '')}</td><td class="num">${esc(d.earlyMin ? String(d.earlyMin) : '')}</td><td class="num">${esc(d.overtimeMin ? V.dur(d.overtimeMin) : '')}</td><td>${esc(tr(S.STATUS[d.status] ? S.STATUS[d.status][0] : 'att|Day off'))}${d.incomplete ? ` · ${esc(tr('att|closed by the system'))}` : ''}</td></tr>`);
      }
      const m = monthDays(e, key, t).tot;
      const html = `<!doctype html><html lang="${doc}" dir="${doc === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(tr('att|Timesheet'))} · ${esc(nm(e))} · ${esc(ui.monthYear(key))}</title><link rel="stylesheet" href="/admin/admin.css?v=${ui.ASSETS.css}"></head>
<body class="adm doc att-print"><main class="doc__page"><header class="doc__head">${ui.logo('doc__logo')}<div><h1>${esc(tr('att|Timesheet'))}</h1><p>${esc(nm(e))} · ${esc(e.code)} · ${esc(tx(e.position) || '')}</p><p>${esc(ui.monthYear(key))}</p></div></header>
<table class="table att-ts"><thead><tr><th>${esc(tr('att|Day'))}</th><th></th><th>${esc(tr('att|Shift'))}</th><th>${esc(tr('att|In'))}</th><th>${esc(tr('att|Out'))}</th><th class="num">${esc(tr('att|Worked'))}</th><th class="num">${esc(tr('att|Late (min)'))}</th><th class="num">${esc(tr('att|Early (min)'))}</th><th class="num">${esc(tr('att|Overtime'))}</th><th>${esc(tr('Status'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>
<p class="att-print__tot">${esc(tr('att|Worked {w} of {s} scheduled · present {p} of {d} shift days · late {l} times ({lm} min) · absent {a} · overtime {o}', { w: V.dur(m.worked), s: V.dur(m.scheduledMin), p: m.present, d: m.scheduled, l: m.lateDays, lm: m.lateMin, a: m.absent, o: V.dur(m.overtime) }))}</p>
<div class="att-print__sign"><span>${esc(tr('att|Employee'))}</span><span>${esc(tr('att|HR'))}</span></div></main></body></html>`;
      res.type('html').send(html);
    });
  });

  // ---------- HR: clocking entered or cancelled by hand ----------
  router.post('/attendance/people/:id(\\d+)/punches', RH, (req, res, next) => {
    const e = S.empOf(req.params.id);
    if (!e) return next();
    const b = req.body;
    const back = `/admin/attendance/people/${e.id}?date=${isDate(b.date) ? b.date : ''}`;
    if (!isDate(b.date) || E.hmMin(b.time) === null) return h.back(req, res, back, 'error', tr('att|Choose the day and the time.'));
    if (!h.str(b.note, 300)) return h.back(req, res, back, 'error', tr('att|Say why.'));
    // a time before the shift's start on an overnight shift belongs to the next calendar day
    const on = S.onOf(e.id, b.date);
    let at = E.cairoAt(b.date, b.time);
    if (on && on.overnight && Date.parse(at) < Date.parse(on.start) - 3 * 3600000) at = E.cairoAt(E.addDays(b.date, 1), b.time);
    if (Date.parse(at) > Date.now() + 60000) return h.back(req, res, back, 'error', tr('att|That time has not come yet.'));
    const r = S.clock(e, { kind: b.kind, at, source: 'hr', by: req.user, note: h.str(b.note, 300) });
    if (!r.ok) return h.back(req, res, back, 'error', tr('att|That does not fit the day’s clocking: {why}', { why: r.reasons.map((c) => tr(S.REASONS[c] || c)).join(' ') }));
    if (r.punch.work_date !== b.date) db.run('UPDATE att_punches SET work_date = ? WHERE id = ?', b.date, r.punch.id);
    h.log(req, 'Added a clocking by hand', 'employee', e.id, e.name);
    h.back(req, res, back, 'ok', tr('att|Saved.'));
  });
  router.post('/attendance/punches/:id(\\d+)/void', RH, (req, res, next) => {
    const p = db.get('SELECT * FROM att_punches WHERE id = ?', req.params.id);
    if (!p) return next();
    const back = `/admin/attendance/people/${p.employee_id}?date=${p.work_date}`;
    if (!h.str(req.body.note, 300)) return h.back(req, res, back, 'error', tr('att|Say why.'));
    db.run('UPDATE att_punches SET voided_at = ?, voided_by = ?, void_note = ? WHERE id = ? AND voided_at IS NULL', now(), req.user.id, h.str(req.body.note, 300), p.id);
    h.log(req, 'Cancelled a clocking', 'employee', p.employee_id, (S.empOf(p.employee_id) || {}).name || null);
    h.back(req, res, back, 'ok', tr('att|Cancelled. The day is recalculated.'));
  });
  router.get('/attendance/punches/:id(\\d+)/photo', RH, (req, res, next) => {
    const p = db.get('SELECT selfie FROM att_punches WHERE id = ?', req.params.id);
    const file = p && p.selfie && h.files.path(p.selfie);
    if (!file) return next();
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    res.sendFile(file);
  });

  // ---------- phones, PINs, shifts on the person ----------
  function accessCard(req, e) {
    const c = S.credsOf(e.id);
    const csrf = req.session.csrf;
    const devs = db.all("SELECT * FROM att_devices WHERE employee_id = ? AND status != 'revoked' ORDER BY status = 'pending' DESC, created_at DESC", e.id);
    const state = !c || !c.pin_hash ? ui.badge('x', tr('att|No PIN yet'), 'rose') : c.locked_until && c.locked_until > now() ? ui.badge('x', tr('att|Locked until {time}', { time: V.hm(c.locked_until) }), 'rose') : ui.badge('ok', tr('att|PIN set {date}', { date: ui.date((c.pin_set_at || '').slice(0, 10)) }), 'ok');
    const pin = ui.form(`/admin/attendance/people/${e.id}/pin`, csrf, `<div class="fields">${ui.input('pin', tr('att|New 6-digit PIN'), '', { attrs: { inputmode: 'numeric', pattern: '\\d{6}', maxlength: 6, autocomplete: 'off' } })}</div><div class="row">${ui.btn(esc(tr('att|Set the PIN')), { cls: 'btn--primary btn--sm' })}${ui.btn(esc(tr('att|Make one for me')), { cls: 'btn--ghost btn--sm', attrs: { name: 'auto', value: '1' } })}</div>`);
    const list = devs.length ? `<ul class="list att-devs">${devs.map((d) => `<li><span class="what"><b>${esc(d.label || tr('att|Phone'))}</b><small>${esc(d.status === 'pending' ? tr('att|waiting for approval') : tr('att|registered {date}', { date: ui.date((d.decided_at || d.created_at).slice(0, 10)) }))}${d.last_seen_at ? ` · ${esc(tr('att|last used'))} ${V.ago(d.last_seen_at)}` : ''}</small></span>
      ${d.status === 'pending' ? ui.form(`/admin/attendance/devices/${d.id}/approve`, csrf, ui.btn(esc(tr('att|Approve')), { cls: 'btn--primary btn--xs' })) : ''}${ui.form(`/admin/attendance/devices/${d.id}/revoke`, csrf, ui.btn(esc(d.status === 'pending' ? tr('att|Refuse') : tr('att|Remove')), { cls: 'btn--ghost btn--xs' }))}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('att|No phone yet: the first phone they sign in on is registered to them.'))}</p>`;
    return ui.card(tr('att|Phone and PIN'), `<p>${state}${c && c.consent_at ? ` ${ui.badge('ok', tr('att|Agreed to the notice {date}', { date: ui.date(c.consent_at.slice(0, 10)) }), 'sea')}` : ''}</p>${pin}<h3 class="att-h3">${esc(tr('att|Phones'))}</h3>${list}`);
  }
  function shiftAssignCard(req, e) {
    const csrf = req.session.csrf;
    const list = db.all('SELECT a.*, s.name, s.start_hm, s.end_hm FROM att_assign a JOIN att_shifts s ON s.id = a.shift_id WHERE a.employee_id = ? ORDER BY a.starts DESC LIMIT 6', e.id);
    const cur = S.shiftFor(e.id, today());
    return ui.card(tr('att|Shift'), `<p>${cur ? `<b>${esc(tx(cur.name))}</b> · ${esc(cur.start_hm)}–${esc(cur.end_hm)} · ${esc(daysText(cur.days))}` : esc(tr('att|No shift: every day counts as a day off unless they clock in.'))}</p>
      ${list.length ? `<ul class="list">${list.map((a) => `<li><span class="what"><b>${esc(tx(a.name))} · ${esc(a.start_hm)}–${esc(a.end_hm)}</b><small>${esc(tr('att|from {from}', { from: ui.date(a.starts) }))}${a.ends ? ` ${esc(tr('att|to {to}', { to: ui.date(a.ends) }))}` : ''}</small></span></li>`).join('')}</ul>` : ''}
      ${ui.form(`/admin/attendance/people/${e.id}/shift`, csrf, `<div class="fields">${ui.select('shift_id', tr('att|Shift'), S.shifts().map((s) => [s.id, `${tx(s.name)} · ${s.start_hm}–${s.end_hm}`]), cur ? cur.id : '', { required: true })}${ui.input('starts', tr('att|From'), today(), { type: 'date', required: true })}${ui.input('ends', tr('att|To (optional)'), '', { type: 'date' })}</div>${ui.btn(esc(tr('att|Assign')), { cls: 'btn--ghost btn--sm' })}`)}`);
  }
  const daysText = (days) => {
    const set = E.daysOf({ days });
    if (set.size === 7) return tr('att|every day');
    return DOW.filter(([n]) => set.has(n)).map(([, l]) => tr(l)).join(i18n.isAr() ? '، ' : ', ');
  };
  router.post('/attendance/people/:id(\\d+)/pin', RH, (req, res, next) => {
    const e = S.empOf(req.params.id);
    if (!e) return next();
    const back = req.get('referer') && /\/admin\/hr\/employees\//.test(req.get('referer')) ? `/admin/hr/employees/${e.id}` : `/admin/attendance/people/${e.id}`;
    let pin = String(req.body.pin || '').trim();
    if (req.body.auto) {
      do pin = String(require('node:crypto').randomInt(0, 1000000)).padStart(6, '0'); while (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin));
    }
    try {
      S.setPin(e.id, pin, req.user);
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    db.run('DELETE FROM att_logins WHERE employee_id = ?', e.id);
    h.log(req, 'Set an attendance PIN', 'employee', e.id, e.name);
    h.back(req, res, back, 'ok', req.body.auto ? tr('att|The new PIN for {name} is {pin}. Give it to them in person; it is not shown again.', { name: nm(e), pin }) : tr('att|PIN saved. {name} signs in with the code {code} and this PIN.', { name: nm(e), code: e.code }));
  });
  router.post('/attendance/people/:id(\\d+)/unlock', RH, (req, res, next) => {
    const e = S.empOf(req.params.id);
    if (!e) return next();
    db.run('UPDATE att_creds SET failed = 0, locked_until = NULL WHERE employee_id = ?', e.id);
    h.log(req, 'Unlocked the staff app', 'employee', e.id, e.name);
    h.back(req, res, '/admin/attendance/devices', 'ok', tr('att|Unlocked.'));
  });
  router.post('/attendance/people/:id(\\d+)/shift', RH, (req, res, next) => {
    const e = S.empOf(req.params.id);
    if (!e) return next();
    const back = req.get('referer') && /\/admin\/hr\/employees\//.test(req.get('referer')) ? `/admin/hr/employees/${e.id}` : `/admin/attendance/people/${e.id}`;
    const s = S.shiftById(h.int(req.body.shift_id));
    if (!s || !isDate(req.body.starts) || (req.body.ends && (!isDate(req.body.ends) || req.body.ends < req.body.starts))) return h.back(req, res, back, 'error', tr('att|Choose the shift and the dates.'));
    assign(e.id, s.id, req.body.starts, req.body.ends || null, req.user);
    h.log(req, 'Assigned a shift', 'employee', e.id, e.name);
    h.back(req, res, back, 'ok', tr('att|Shift assigned.'));
  });
  // a new assignment ends the one running at its start
  function assign(empId, shiftId, starts, ends, by, demo = 0) {
    db.tx(() => {
      db.run('UPDATE att_assign SET ends = ? WHERE employee_id = ? AND starts < ? AND (ends IS NULL OR ends >= ?)', E.addDays(starts, -1), empId, starts, starts);
      db.run('DELETE FROM att_assign WHERE employee_id = ? AND starts >= ? AND (? IS NULL OR starts <= ?)', empId, starts, ends, ends);
      db.run('INSERT INTO att_assign (employee_id, shift_id, starts, ends, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', empId, shiftId, starts, ends, by ? by.id : null, demo ? 1 : 0, now());
    });
  }
  S.assign = assign;

  // the HR employee page: an attendance card
  (h.employeeCards = h.employeeCards || []).push((req, e) => {
    if (!isHR(req) || e.status !== 'active') return '';
    const t = now();
    const p = personNow(e, t);
    const key = today().slice(0, 7);
    const m = monthDays(e, key, t).tot;
    const c = S.credsOf(e.id);
    return ui.card(tr('nav|Attendance & activity'), `<div class="att-empcard"><span class="att-av att-av--${p.light}"><span>${esc(ini(e))}</span></span><div><p>${statusBadge(p.day.status)} ${p.last ? `<small class="muted">${esc(p.last.title)} · </small>${V.ago(p.last.at)}` : ''}</p>
      <p class="small">${esc(tr('att|This month: worked {w}, late {l} times, absent {a}', { w: V.dur(m.worked), l: m.lateDays, a: m.absent }))}</p>
      <p class="small">${!c || !c.pin_hash ? `<b class="att-warnword">${esc(tr('att|No PIN yet: they cannot use the staff app.'))}</b>` : esc(tr('att|Signs in to the staff app with {code} and their PIN.', { code: e.code }))}</p></div></div>`,
    { action: ui.btn(esc(tr('att|Open')), { href: `/admin/attendance/people/${e.id}`, cls: 'btn--ghost btn--sm' }) }) + accessCard(req, e);
  });

  // ---------- the team's activity ----------
  router.get('/attendance/activity', RA, (req, res) => {
    const t = now();
    const { f, src } = feedFilters(req);
    const from = f.from ? E.cairoAt(f.from, '00:00') : new Date(Date.parse(t) - 24 * 3600000).toISOString();
    const to = f.to ? E.cairoAt(E.addDays(f.to, 1), '00:00') : t;
    let people = scoped(req);
    if (h.int(req.query.dept)) people = people.filter((e) => e.department_id === h.int(req.query.dept));
    const pick = String(req.query.person || '');
    if (/^e\d+$/.test(pick)) people = people.filter((e) => e.id === Number(pick.slice(1)));
    const persons = people.map((e) => ({ p: S.personOf(e), name: nm(e), link: `/admin/attendance/people/${e.id}`, key: `e${e.id}` }));
    if (isHR(req) && (!pick || /^u\d+$/.test(pick)) && !h.int(req.query.dept)) {
      for (const u of db.all('SELECT * FROM users WHERE active = 1 AND id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL) ORDER BY name')) {
        if (!pick || pick === `u${u.id}`) persons.push({ p: { userId: u.id, names: [] }, name: u.name, link: `/admin/attendance/users/${u.id}`, key: `u${u.id}` });
      }
    }
    if (/^u\d+$/.test(pick)) for (let i = persons.length - 1; i >= 0; i--) if (persons[i].key !== pick) persons.splice(i, 1);
    const all = [];
    for (const x of persons) for (const ev of A.feed(x.p, { from, to, limit: 120, sources: src ? [src] : null, now: t })) all.push({ ...ev, who: x });
    all.sort((a, b) => (a.at < b.at ? 1 : -1));
    let events = all.slice(0, 400);
    if (f.sortKey === 'oldest') events = events.reverse();
    const depts = db.all('SELECT id, name FROM departments ORDER BY sort, name');
    const whoOpts = [...scoped(req).map((e) => [`e${e.id}`, nm(e)]), ...(isHR(req) ? db.all('SELECT * FROM users WHERE active = 1 AND id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL) ORDER BY name').map((u) => [`u${u.id}`, `${u.name} · ${tr('att|office account')}`]) : [])];
    const filters = `<form method="get" class="filters">${ui.select('person', tr('att|Person'), whoOpts, pick, { blank: tr('att|Everyone'), attrs: { 'data-autosubmit': '' } })}${ui.select('dept', tr('hr|Department'), depts.map((d) => [d.id, tx(d.name)]), req.query.dept || '', { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}${ui.select('source', tr('att|Source'), Object.entries(A.SOURCES).map(([k, [l]]) => [k, tr(l)]), src, { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}${f.fields}<div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div>${f.quick}</form>`;
    const sub = f.from || f.to ? tr('att|{from} to {to}', { from: ui.date(f.from || E.cairo(from).date), to: ui.date(f.to || E.cairo(t).date) }) : tr('att|The last 24 hours');
    frame(req, res, {
      tab: '/admin/attendance/activity', title: tr('att|Team activity'),
      body: `${filters}${ui.card(tr('att|Everything the team did'), feedList(events, { who: (ev) => `<a href="${esc(ev.who.link)}"><b>${esc(ev.who.name)}</b></a>` }), { sub: `${esc(sub)} · ${esc(tn(events.length, 'att|{n} event', 'att|{n} events'))}` })}`,
    });
  });

  // ---------- timesheets: a day's register or a month ----------
  function monthRows(req, key, t) {
    let people = scoped(req);
    if (h.int(req.query.dept)) people = people.filter((e) => e.department_id === h.int(req.query.dept));
    return people.map((e) => ({ e, ...monthDays(e, key, t).tot }));
  }
  const SORTS = {
    name: ['sort|Name: A to Z', (a, b) => nm(a.e).localeCompare(nm(b.e))], worked: ['att|Most hours worked', (a, b) => b.worked - a.worked],
    late: ['att|Most late', (a, b) => b.lateMin - a.lateMin || b.lateDays - a.lateDays], absent: ['att|Most absent', (a, b) => b.absent - a.absent],
    punctual: ['att|Most punctual', (a, b) => (b.punctuality ?? -1) - (a.punctuality ?? -1) || b.present - a.present], overtime: ['att|Most overtime', (a, b) => b.overtime - a.overtime],
  };
  router.get('/attendance/timesheets', RA, (req, res) => {
    const t = now();
    const view = req.query.view === 'day' ? 'day' : 'month';
    const depts = db.all('SELECT id, name FROM departments ORDER BY sort, name');
    const deptSel = ui.select('dept', tr('hr|Department'), depts.map((d) => [d.id, tx(d.name)]), req.query.dept || '', { blank: tr('All'), attrs: { 'data-autosubmit': '' } });
    const switcher = `<nav class="tabs tabs--sub"><a class="tab${view === 'month' ? ' is-on' : ''}" href="/admin/attendance/timesheets">${esc(tr('att|Month'))}</a><a class="tab${view === 'day' ? ' is-on' : ''}" href="/admin/attendance/timesheets?view=day">${esc(tr('att|Day'))}</a></nav>`;
    if (view === 'day') {
      const date = isDate(req.query.date) ? req.query.date : today();
      let people = scoped(req);
      if (h.int(req.query.dept)) people = people.filter((e) => e.department_id === h.int(req.query.dept));
      const sort = ['name', 'in', 'worked', 'late', 'status'].includes(req.query.sort) ? req.query.sort : 'status';
      const rows = people.map((e) => ({ e, d: S.dayOf(e, date, t) }));
      const order = { not_in: 0, absent: 1, working: 2, on_break: 3, done: 4, upcoming: 5, leave: 6, holiday: 7, off: 8 };
      rows.sort(sort === 'name' ? (a, b) => nm(a.e).localeCompare(nm(b.e)) : sort === 'in' ? (a, b) => String(a.d.firstIn || 'z').localeCompare(String(b.d.firstIn || 'z')) : sort === 'worked' ? (a, b) => b.d.workedMin - a.d.workedMin : sort === 'late' ? (a, b) => b.d.lateMin - a.d.lateMin : (a, b) => (order[a.d.status] ?? 9) - (order[b.d.status] ?? 9) || nm(a.e).localeCompare(nm(b.e)));
      const filters = `<form method="get" class="filters"><input type="hidden" name="view" value="day">${ui.input('date', tr('att|Day'), date, { type: 'date', attrs: { 'data-autosubmit': '' } })}${deptSel}${ui.select('sort', tr('sort|Sort by'), [['status', tr('sort|Status')], ['name', tr('sort|Name: A to Z')], ['in', tr('att|Earliest in')], ['worked', tr('att|Most hours worked')], ['late', tr('att|Most late')]], sort, { attrs: { 'data-autosubmit': '' } })}<div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div><div class="filters__quick"><a class="chip${date === today() ? ' is-on' : ''}" href="?view=day&date=${today()}">${esc(tr('att|today'))}</a><a class="chip${date === E.addDays(today(), -1) ? ' is-on' : ''}" href="?view=day&date=${E.addDays(today(), -1)}">${esc(tr('att|Yesterday'))}</a></div></form>`;
      const table = ui.table([
        { label: tr('att|Person'), render: (r) => `<a href="/admin/attendance/people/${r.e.id}?date=${date}"><b>${esc(nm(r.e))}</b></a><small class="sub">${esc(tx(r.e.position) || '')}</small>`, sort: (r) => nm(r.e) },
        { label: tr('att|Shift'), render: (r) => esc(shiftText(r.d.on)) },
        { label: tr('att|In'), render: (r) => esc(r.d.firstIn ? V.hm(r.d.firstIn) : '—'), sort: (r) => r.d.firstIn || '' },
        { label: tr('att|Out'), render: (r) => esc(r.d.lastOut ? V.hm(r.d.lastOut) : r.d.open ? tr('att|still in') : '—') },
        { label: tr('att|Worked'), num: true, render: (r) => esc(r.d.workedMin ? V.dur(r.d.workedMin) : '—'), sort: (r) => r.d.workedMin },
        { label: tr('att|Late (min)'), num: true, render: (r) => (r.d.lateMin ? `<b class="att-warnword">${r.d.lateMin}</b>` : ''), sort: (r) => r.d.lateMin },
        { label: tr('att|Early (min)'), num: true, render: (r) => (r.d.earlyMin ? String(r.d.earlyMin) : ''), sort: (r) => r.d.earlyMin },
        { label: tr('att|Overtime'), num: true, render: (r) => esc(r.d.overtimeMin ? V.dur(r.d.overtimeMin) : ''), sort: (r) => r.d.overtimeMin },
        { label: tr('Status'), render: (r) => `${statusBadge(r.d.status)}${r.d.incomplete ? ` ${ui.badge('x', tr('att|closed by the system'), 'amber')}` : ''}` },
      ], rows, { href: (r) => `/admin/attendance/people/${r.e.id}?date=${date}` });
      return frame(req, res, { tab: '/admin/attendance/timesheets', title: tr('att|Register for {date}', { date: ui.date(date) }), body: `${switcher}${filters}${ui.card(tr('att|Everyone that day'), table, { sub: esc(ui.date(date)) })}` });
    }
    const key = isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
    const sort = SORTS[req.query.sort] ? req.query.sort : 'name';
    const rows = monthRows(req, key, t).sort(SORTS[sort][1]);
    const filters = `<form method="get" class="filters">${ui.input('month', tr('att|Month'), key, { type: 'month', attrs: { 'data-autosubmit': '' } })}${deptSel}${ui.select('sort', tr('sort|Sort by'), Object.entries(SORTS).map(([k, [l]]) => [k, tr(l)]), sort, { attrs: { 'data-autosubmit': '' } })}<div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div><div class="filters__quick"><a class="chip${key === today().slice(0, 7) ? ' is-on' : ''}" href="?month=${today().slice(0, 7)}">${esc(tr('sort|This month'))}</a><a class="chip" href="?month=${E.addDays(`${today().slice(0, 7)}-01`, -1).slice(0, 7)}">${esc(tr('sort|Last month'))}</a></div></form>`;
    const table = ui.table([
      { label: tr('att|Person'), render: (r) => `<a href="/admin/attendance/people/${r.e.id}?month=${key}&date=${key === today().slice(0, 7) ? today() : `${key}-01`}"><b>${esc(nm(r.e))}</b></a><small class="sub">${esc(tx(r.e.dept) || '')}</small>`, sort: (r) => nm(r.e) },
      { label: tr('att|Shift days'), num: true, render: (r) => String(r.scheduled), sort: (r) => r.scheduled },
      { label: tr('att|Present'), num: true, render: (r) => String(r.present), sort: (r) => r.present },
      { label: tr('att|Late'), num: true, render: (r) => (r.lateDays ? `<b class="att-warnword">${r.lateDays}</b> <small class="muted">${esc(tr('att|{n} min', { n: r.lateMin }))}</small>` : '0'), sort: (r) => r.lateMin },
      { label: tr('att|Absent'), num: true, render: (r) => (r.absent ? `<b class="att-warnword">${r.absent}</b>` : '0'), sort: (r) => r.absent },
      { label: tr('att|Leave'), num: true, render: (r) => String(r.leave), sort: (r) => r.leave },
      { label: tr('att|Worked'), num: true, render: (r) => esc(tr('att|{h} h', { h: V.hours(r.worked) })), sort: (r) => r.worked },
      { label: tr('att|Scheduled'), num: true, render: (r) => esc(tr('att|{h} h', { h: V.hours(r.scheduledMin) })), sort: (r) => r.scheduledMin },
      { label: tr('att|Overtime'), num: true, render: (r) => esc(r.overtime ? tr('att|{h} h', { h: V.hours(r.overtime) }) : '—'), sort: (r) => r.overtime },
      { label: tr('att|On time'), num: true, render: (r) => (r.punctuality === null ? '—' : `<span class="att-punct" style="--p:${(r.punctuality * 100).toFixed(0)}%">${esc(ui.pct(r.punctuality))}</span>`), sort: (r) => r.punctuality ?? -1 },
    ], rows, { href: (r) => `/admin/attendance/people/${r.e.id}?month=${key}` });
    const total = rows.reduce((s, r) => ({ worked: s.worked + r.worked, late: s.late + r.lateDays, absent: s.absent + r.absent, ot: s.ot + r.overtime, present: s.present + r.present }), { worked: 0, late: 0, absent: 0, ot: 0, present: 0 });
    const kpis = `<div class="kpis kpis--4">${ui.kpi({ label: tr('att|Hours worked'), value: esc(V.hours(total.worked)) })}${ui.kpi({ label: tr('att|Late arrivals'), value: String(total.late), tone: total.late ? 'kpi--alert' : '' })}${ui.kpi({ label: tr('att|Absences'), value: String(total.absent), tone: total.absent ? 'kpi--alert' : '' })}${ui.kpi({ label: tr('att|Overtime hours'), value: esc(V.hours(total.ot)) })}</div>`;
    const qs = new URLSearchParams({ month: key, ...(req.query.dept ? { dept: req.query.dept } : {}), sort }).toString();
    frame(req, res, {
      tab: '/admin/attendance/timesheets', title: tr('att|Timesheets · {month}', { month: ui.monthYear(key) }),
      actions: `${ui.btn(esc(tr('att|Export CSV')), { href: `/admin/attendance/timesheets.csv?${qs}`, cls: 'btn--ghost', ic: 'dl' })}${isHR(req) ? ui.btn(esc(tr('att|Send to payroll')), { href: `/admin/attendance/payroll?month=${key}`, cls: 'btn--ghost', ic: 'wallet' }) : ''}`,
      body: `${switcher}${filters}${kpis}${ui.card(tr('att|Everyone this month'), table, { sub: esc(tr('att|Days up to today; leave and holidays are not absences.')) })}`,
    });
  });
  router.get('/attendance/timesheets.csv', RA, (req, res) => {
    const key = isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
    const sort = SORTS[req.query.sort] ? req.query.sort : 'name';
    const rows = monthRows(req, key, now()).sort(SORTS[sort][1]);
    const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Code', 'Name', 'Department', 'Shift days', 'Present', 'Late days', 'Late minutes', 'Early minutes', 'Absent', 'Leave', 'Holidays', 'Hours worked', 'Hours scheduled', 'Overtime hours', 'On time %', 'Closed by the system'];
    const lines = [head.join(','), ...rows.map((r) => [r.e.code, r.e.name, r.e.dept || '', r.scheduled, r.present, r.lateDays, r.lateMin, r.earlyMin, r.absent, r.leave, r.holiday, V.hours(r.worked), V.hours(r.scheduledMin), V.hours(r.overtime), r.punctuality === null ? '' : Math.round(r.punctuality * 100), r.incomplete].map(cell).join(','))];
    h.log(req, 'Exported timesheets', 'export', null, key);
    res.attachment(`timesheets-${key}.csv`).type('text/csv').send(`﻿${lines.join('\n')}\n`);
  });

  // ---------- payroll: overtime pay and unpaid absences into a draft run ----------
  function payrollPlan(key, t) {
    const run = db.get('SELECT * FROM payroll_runs WHERE period = ?', key);
    const rate = S.num('att_ot_rate');
    const unpaid = S.num('att_absent_unpaid') === 1;
    const lines = run ? new Map(db.all('SELECT * FROM payroll_lines WHERE run_id = ?', run.id).map((l) => [l.employee_id, l])) : new Map();
    const rows = S.activeEmps().map((e) => {
      const m = monthDays(e, key, t).tot;
      const hourly = Number(e.basic_salary || 0) / 30 / 8;
      const otPay = Math.round((m.overtime / 60) * hourly * rate * 100) / 100;
      const leaveUnpaid = h.hrUnpaidLeave ? h.hrUnpaidLeave(e.id, key) : 0;
      const line = lines.get(e.id) || null;
      // someone with no shift and no clocking that month is not on attendance: their line stays as typed
      const tracked = m.scheduled > 0 || !!db.value("SELECT COUNT(*) FROM att_punches WHERE employee_id = ? AND work_date LIKE ? AND status != 'rejected'", e.id, `${key}-%`);
      return { e, m, hourly, otPay, tracked, absentDays: unpaid ? m.absent : 0, newUnpaid: Math.round(((unpaid ? m.absent : 0) + leaveUnpaid) * 100) / 100, line };
    });
    return { run, rows, rate, unpaid };
  }
  router.get('/attendance/payroll', RH, (req, res) => {
    const key = isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
    const plan = payrollPlan(key, now());
    const csrf = req.session.csrf;
    const note = !plan.run ? `<p class="alert">${esc(tr('att|There is no payroll for {month} yet. Create it under Payroll, then come back.', { month: ui.monthYear(key) }))} <a href="/admin/hr/payroll">${esc(tr('Payroll'))}</a></p>`
      : plan.run.status !== 'draft' ? `<p class="alert alert--error">${esc(tr('att|The payroll for {month} is {status}: it can no longer change.', { month: ui.monthYear(key), status: tr(plan.run.status === 'paid' ? 'att|paid' : 'att|approved') }))}</p>` : '';
    const table = ui.table([
      { label: tr('att|Person'), render: (r) => `<b>${esc(nm(r.e))}</b><small class="sub">${esc(r.e.code)}</small>` },
      { label: tr('att|Overtime'), num: true, render: (r) => esc(tr('att|{h} h', { h: V.hours(r.m.overtime) })) },
      { label: tr('att|Overtime pay'), num: true, render: (r) => `${ui.money(r.otPay)}${r.line ? `<small class="sub">${esc(tr('att|now {amount}', { amount: ui.money(r.line.overtime) }))}</small>` : ''}` },
      { label: tr('att|Absent days'), num: true, render: (r) => String(r.absentDays) },
      { label: tr('att|Unpaid days'), num: true, render: (r) => `${r.newUnpaid}${r.line ? `<small class="sub">${esc(tr('att|now {n}', { n: r.line.unpaid_days }))}</small>` : ''}` },
    ], plan.rows.filter((r) => r.tracked));
    const skipped = plan.rows.filter((r) => !r.tracked);
    const can = plan.run && plan.run.status === 'draft';
    frame(req, res, {
      tab: '/admin/attendance/timesheets', title: tr('att|Send {month} to payroll', { month: ui.monthYear(key) }), crumbs: [['/admin/attendance', tr('nav|Attendance & activity')], ['/admin/attendance/timesheets', tr('att|Timesheets')]],
      body: `${note}<p class="muted">${esc(tr('att|Overtime is paid at {rate}× the hourly rate (basic salary ÷ 30 ÷ 8). Absences without leave become unpaid days{unpaid}. Approved unpaid leave is added as before. Bonuses, deductions and tax you typed stay as they are.', { rate: plan.rate, unpaid: plan.unpaid ? '' : tr('att| (switched off in the settings)') }))}</p>
        ${ui.card(tr('att|What will change'), table, { sub: skipped.length ? esc(tr('att|Not on attendance (no shift, no clocking), left as they are: {names}', { names: skipped.map((r) => nm(r.e)).join(i18n.isAr() ? '، ' : ', ') })) : '' })}${can ? ui.form(`/admin/attendance/payroll?month=${key}`, csrf, `<input type="hidden" name="month" value="${esc(key)}">${ui.btn(esc(tr('att|Apply to the draft payroll')), { cls: 'btn--primary', ic: 'check' })}`) : ''}`,
    });
  });
  router.post('/attendance/payroll', RH, (req, res) => {
    const key = isMonth(req.body.month) ? req.body.month : '';
    const plan = key ? payrollPlan(key, now()) : null;
    if (!plan || !plan.run || plan.run.status !== 'draft' || !h.hrRecalc) return h.back(req, res, `/admin/attendance/payroll?month=${key}`, 'error', tr('att|Only a draft payroll can change.'));
    const typed = {};
    for (const r of plan.rows.filter((x) => x.tracked)) {
      typed[`overtime_${r.e.id}`] = String(r.otPay);
      typed[`unpaid_days_${r.e.id}`] = String(r.newUnpaid);
    }
    h.hrRecalc(plan.run, typed);
    h.log(req, 'Sent attendance to payroll', 'payroll', plan.run.id, key);
    h.back(req, res, `/admin/hr/payroll/${plan.run.id}`, 'ok', tr('att|Overtime and unpaid days are in the draft payroll.'));
  });

  // ---------- exceptions: refused and flagged clocking, alerts ----------
  router.get('/attendance/exceptions', RH, (req, res) => {
    const f = h.listFilters(req, { cols: { date: 'p.at' }, dateLabel: tr('att|When'), keep: ['which', 'person'], sort: { date: 'p.at' } });
    const which = ['rejected', 'flagged', 'auto'].includes(req.query.which) ? req.query.which : '';
    const where = ["(p.status IN ('rejected','flagged'))", ...f.where];
    const args = [...f.args];
    if (which === 'auto') where.push("p.source = 'auto'");
    else if (which) { where.push('p.status = ?'); args.push(which); }
    if (h.int(req.query.person)) { where.push('p.employee_id = ?'); args.push(h.int(req.query.person)); }
    const rows = db.all(`SELECT p.*, e.name, e.name_ar, e.code, d.label device FROM att_punches p JOIN employees e ON e.id = p.employee_id LEFT JOIN att_devices d ON d.id = p.device_id WHERE ${where.join(' AND ')} ORDER BY ${f.order} LIMIT 500`, ...args);
    const filters = `<form method="get" class="filters">${ui.select('which', tr('att|Show'), [['rejected', tr('att|Refused')], ['flagged', tr('att|Accepted, flagged')], ['auto', tr('att|Closed by the system')]], which, { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}${ui.select('person', tr('att|Person'), S.activeEmps().map((e) => [e.id, nm(e)]), req.query.person || '', { blank: tr('att|Everyone'), attrs: { 'data-autosubmit': '' } })}${f.fields}<div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div>${f.quick}</form>`;
    const table = ui.table([
      { label: tr('att|When'), render: (p) => esc(ui.dt(p.at)), sort: (p) => p.at },
      { label: tr('att|Person'), render: (p) => `<a href="/admin/attendance/people/${p.employee_id}?date=${p.work_date}"><b>${esc(i18n.isAr() && p.name_ar ? p.name_ar : p.name)}</b></a>` },
      { label: tr('att|What'), render: (p) => esc(tr(KIND_LABEL[p.kind])) },
      { label: tr('att|Verdict'), render: (p) => (p.status === 'rejected' ? `${ui.badge('x', tr('att|Refused'), 'rose')}<small class="sub">${esc(reasonText(p.reasons))}</small>` : `${ui.badge('x', tr('att|Accepted, flagged'), 'amber')}<small class="sub">${esc(flagText(p.flags))}</small>`) },
      { label: tr('att|Distance'), num: true, render: (p) => (p.distance === null ? '—' : esc(tr('att|{m} m', { m: Math.round(p.distance) }))), sort: (p) => p.distance ?? -1 },
      { label: tr('att|Accuracy'), num: true, render: (p) => (p.accuracy === null ? '—' : esc(tr('att|±{m} m', { m: Math.round(p.accuracy) }))), sort: (p) => p.accuracy ?? -1 },
      { label: tr('att|Phone'), render: (p) => esc(p.device || '—') },
    ], rows, { empty: esc(tr('att|Nothing refused or flagged in this period.')), href: (p) => `/admin/attendance/people/${p.employee_id}?date=${p.work_date}` });
    frame(req, res, { tab: '/admin/attendance/exceptions', title: tr('att|Exceptions'), body: `${filters}${ui.card(tr('att|Refused and flagged clocking'), table, { sub: esc(tn(rows.length, 'att|{n} attempt', 'att|{n} attempts')) })}` });
  });

  // ---------- shifts ----------
  router.get('/attendance/shifts', RH, (req, res) => {
    const list = S.shifts({ all: true });
    const t = today();
    const people = (id) => db.value('SELECT COUNT(DISTINCT a.employee_id) FROM att_assign a JOIN employees e ON e.id = a.employee_id WHERE a.shift_id = ? AND a.starts <= ? AND (a.ends IS NULL OR a.ends >= ?) AND e.status = \'active\'', id, t, t);
    const def = Number(db.setting('att_default_shift') || 0);
    const cards = list.map((s) => {
      const on = E.shiftOn({ ...s, days: '1234567' }, t);
      return `<a class="att-shift att-shift--${esc(s.color)}${s.active ? '' : ' is-off'}" href="/admin/attendance/shifts/${s.id}"><b>${esc(tx(s.name))}</b><span class="att-shift__time">${esc(s.start_hm)}–${esc(s.end_hm)}${on && on.overnight ? ` <small>${esc(tr('att|overnight'))}</small>` : ''}</span><small>${esc(daysText(s.days))} · ${esc(tr('att|grace {n} min', { n: s.grace_min ?? S.num('att_grace') }))}${s.break_min ? ` · ${esc(tr('att|unpaid break {n} min', { n: s.break_min }))}` : ''}</small><span class="att-shift__n">${esc(tn(people(s.id), 'att|{n} person', 'att|{n} people'))}${def === s.id ? ` · ${esc(tr('att|default'))}` : ''}</span></a>`;
    }).join('');
    frame(req, res, {
      tab: '/admin/attendance/shifts', title: tr('att|Shifts'), actions: ui.btn(esc(tr('att|New shift')), { href: '/admin/attendance/shifts/new', cls: 'btn--primary', ic: 'plus' }),
      body: list.length ? `<div class="att-shifts">${cards}</div>` : ui.empty(tr('att|No shifts yet. Add the mall’s shifts, then assign people to them.'), ui.btn(esc(tr('att|New shift')), { href: '/admin/attendance/shifts/new', cls: 'btn--primary' })),
    });
  });
  function shiftForm(req, s) {
    const days = E.daysOf(s || { days: '1234567' });
    return ui.form(s ? `/admin/attendance/shifts/${s.id}` : '/admin/attendance/shifts', req.session.csrf, `<div class="fields">
      ${ui.input('name', tr('att|Name'), s ? s.name : '', { required: true, placeholder: tr('att|e.g. Mall evening') })}
      ${ui.input('start_hm', tr('att|Starts'), s ? s.start_hm : '10:00', { type: 'time', required: true })}${ui.input('end_hm', tr('att|Ends'), s ? s.end_hm : '18:00', { type: 'time', required: true, hint: tr('att|An end before the start ends the next morning.') })}
      ${ui.input('grace_min', tr('att|Grace (minutes)'), s && s.grace_min !== null ? s.grace_min : '', { type: 'number', min: 0, max: 120, hint: tr('att|Empty: the default ({n} min).', { n: S.num('att_grace') }) })}
      ${ui.input('break_min', tr('att|Unpaid break (minutes)'), s ? s.break_min : 30, { type: 'number', min: 0, max: 240 })}
      ${ui.select('color', tr('att|Colour'), SHIFT_COLORS.map((c) => [c, tr(COLOR_NAME[c])]), s ? s.color : 'sea')}</div>
      <fieldset class="att-days"><legend class="f__l">${esc(tr('att|Days'))}</legend>${DOW.map(([n, l]) => `<label class="att-day"><input type="checkbox" name="d${n}" value="1"${days.has(n) ? ' checked' : ''}><span>${esc(tr(l))}</span></label>`).join('')}</fieldset>
      <label class="check"><input type="checkbox" name="is_default" value="1"${s && Number(db.setting('att_default_shift')) === s.id ? ' checked' : ''}> ${esc(tr('att|The default shift for people with none assigned'))}</label>
      ${s ? `<label class="check"><input type="checkbox" name="active" value="1"${s.active ? ' checked' : ''}> ${esc(tr('att|In use'))}</label>` : ''}
      <div class="row">${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}</div>`, { cls: 'stack' });
  }
  router.get('/attendance/shifts/new', RH, (req, res) => frame(req, res, { tab: '/admin/attendance/shifts', title: tr('att|New shift'), crumbs: [['/admin/attendance', tr('nav|Attendance & activity')], ['/admin/attendance/shifts', tr('att|Shifts')]], body: ui.card(tr('att|The shift'), shiftForm(req, null)) }));
  router.get('/attendance/shifts/:id(\\d+)', RH, (req, res, next) => {
    const s = S.shiftById(req.params.id);
    if (!s) return next();
    const t = today();
    const on = new Set(db.all('SELECT employee_id FROM att_assign WHERE shift_id = ? AND starts <= ? AND (ends IS NULL OR ends >= ?)', s.id, t, t).map((r) => r.employee_id));
    const assignForm = ui.form(`/admin/attendance/shifts/${s.id}/assign`, req.session.csrf, `<div class="att-pick">${S.activeEmps().map((e) => `<label class="att-pick__p${on.has(e.id) ? ' is-on' : ''}"><input type="checkbox" name="emp" value="${e.id}"${on.has(e.id) ? ' checked disabled' : ''}><span class="att-av att-av--sm"><span>${esc(ini(e))}</span></span><span><b>${esc(nm(e))}</b><small>${esc(tx(e.position) || '')}</small></span></label>`).join('')}</div>
      <div class="fields">${ui.input('starts', tr('att|From'), t, { type: 'date', required: true })}${ui.input('ends', tr('att|To (optional)'), '', { type: 'date' })}</div>${ui.btn(esc(tr('att|Assign the people ticked')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    frame(req, res, {
      tab: '/admin/attendance/shifts', title: tx(s.name), crumbs: [['/admin/attendance', tr('nav|Attendance & activity')], ['/admin/attendance/shifts', tr('att|Shifts')]],
      body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('att|Who works it'), assignForm, { sub: esc(tn(on.size, 'att|{n} person today', 'att|{n} people today')) })}</div><div class="stack">${ui.card(tr('att|The shift'), shiftForm(req, s))}</div></div>`,
    });
  });
  function readShift(b) {
    const days = DOW.filter(([n]) => b[`d${n}`] === '1').map(([n]) => n).join('');
    const f = { name: h.str(b.name, 80), start_hm: String(b.start_hm || ''), end_hm: String(b.end_hm || ''), days, grace_min: b.grace_min === '' || b.grace_min === undefined ? null : Math.max(0, Math.min(120, h.int(b.grace_min) || 0)), break_min: Math.max(0, Math.min(240, h.int(b.break_min) || 0)), color: SHIFT_COLORS.includes(b.color) ? b.color : 'sea' };
    if (!f.name) throw new Error('att|Give the shift a name.');
    if (E.hmMin(f.start_hm) === null || E.hmMin(f.end_hm) === null || f.start_hm === f.end_hm) throw new Error('att|Choose when it starts and ends.');
    if (!days) throw new Error('att|Tick at least one day.');
    return f;
  }
  router.post('/attendance/shifts', RH, (req, res) => {
    let f;
    try { f = readShift(req.body); } catch (err) { return h.back(req, res, '/admin/attendance/shifts/new', 'error', tr(err.message)); }
    const id = Number(db.run('INSERT INTO att_shifts (name, start_hm, end_hm, days, grace_min, break_min, color, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)', f.name, f.start_hm, f.end_hm, f.days, f.grace_min, f.break_min, f.color, now()).lastInsertRowid);
    if (req.body.is_default === '1') db.setSetting('att_default_shift', String(id));
    h.log(req, 'Added a shift', 'settings', null, f.name);
    h.back(req, res, `/admin/attendance/shifts/${id}`, 'ok', tr('att|Shift saved. Now tick who works it.'));
  });
  router.post('/attendance/shifts/:id(\\d+)', RH, (req, res, next) => {
    const s = S.shiftById(req.params.id);
    if (!s) return next();
    let f;
    try { f = readShift(req.body); } catch (err) { return h.back(req, res, `/admin/attendance/shifts/${s.id}`, 'error', tr(err.message)); }
    db.run('UPDATE att_shifts SET name = ?, start_hm = ?, end_hm = ?, days = ?, grace_min = ?, break_min = ?, color = ?, active = ? WHERE id = ?', f.name, f.start_hm, f.end_hm, f.days, f.grace_min, f.break_min, f.color, req.body.active === '1' ? 1 : 0, s.id);
    if (req.body.is_default === '1') db.setSetting('att_default_shift', String(s.id));
    else if (Number(db.setting('att_default_shift')) === s.id) db.setSetting('att_default_shift', '');
    h.log(req, 'Changed a shift', 'settings', null, f.name);
    h.back(req, res, `/admin/attendance/shifts/${s.id}`, 'ok', tr('att|Saved.'));
  });
  router.post('/attendance/shifts/:id(\\d+)/assign', RH, (req, res, next) => {
    const s = S.shiftById(req.params.id);
    if (!s) return next();
    const ids = h.list(req.body.emp).map(Number).filter((id) => S.empOf(id));
    if (!ids.length || !isDate(req.body.starts) || (req.body.ends && (!isDate(req.body.ends) || req.body.ends < req.body.starts))) return h.back(req, res, `/admin/attendance/shifts/${s.id}`, 'error', tr('att|Tick the people and choose the dates.'));
    for (const id of ids) assign(id, s.id, req.body.starts, req.body.ends || null, req.user);
    h.log(req, 'Assigned a shift', 'settings', null, s.name);
    h.back(req, res, `/admin/attendance/shifts/${s.id}`, 'ok', tn(ids.length, 'att|{n} person assigned.', 'att|{n} people assigned.'));
  });

  // ---------- phones and PINs ----------
  router.get('/attendance/devices', RH, (req, res) => {
    const csrf = req.session.csrf;
    const pending = db.all("SELECT d.*, e.name, e.name_ar, e.code FROM att_devices d JOIN employees e ON e.id = d.employee_id WHERE d.status = 'pending' ORDER BY d.created_at DESC");
    const pend = pending.length ? ui.card(tr('att|New phones waiting for approval'), `<ul class="list att-devs">${pending.map((d) => `<li><span class="what"><b>${esc(i18n.isAr() && d.name_ar ? d.name_ar : d.name)} · ${esc(d.label || '')}</b><small>${esc(tr('att|asked'))} ${V.ago(d.created_at)} · <span class="ltr">${esc(d.ip || '')}</span></small></span>${ui.form(`/admin/attendance/devices/${d.id}/approve`, csrf, ui.btn(esc(tr('att|Approve')), { cls: 'btn--primary btn--xs' }))}${ui.form(`/admin/attendance/devices/${d.id}/revoke`, csrf, ui.btn(esc(tr('att|Refuse')), { cls: 'btn--ghost btn--xs' }))}</li>`).join('')}</ul>`, { sub: esc(tr('att|Approve only when you know the person changed their phone. Their old phone stops working.')) }) : '';
    const f = h.listFilters(req, { cols: {}, sorts: [['name', 'sort|Name: A to Z', 'e.name'], ['nopin', 'att|No PIN first', 'c.pin_hash IS NOT NULL, e.name'], ['recent', 'att|Last signed in', 'c.last_login_at IS NULL, c.last_login_at DESC']] });
    const rows = db.all(`SELECT e.*, c.pin_hash, c.locked_until, c.consent_at, c.last_login_at, (SELECT COUNT(*) FROM att_devices d WHERE d.employee_id = e.id AND d.status = 'active') phones FROM employees e LEFT JOIN att_creds c ON c.employee_id = e.id WHERE e.status = 'active' ORDER BY ${f.order}`);
    const table = ui.table([
      { label: tr('att|Person'), render: (e) => `<a href="/admin/attendance/people/${e.id}"><b>${esc(nm(e))}</b></a><small class="sub ltr">${esc(e.code)}</small>`, sort: (e) => nm(e) },
      { label: tr('att|PIN'), render: (e) => (!e.pin_hash ? ui.badge('x', tr('att|No PIN yet'), 'rose') : e.locked_until && e.locked_until > now() ? `${ui.badge('x', tr('att|Locked'), 'rose')} ${ui.form(`/admin/attendance/people/${e.id}/unlock`, csrf, ui.btn(esc(tr('att|Unlock')), { cls: 'btn--ghost btn--xs' }), { cls: 'inline' })}` : ui.badge('ok', tr('att|Set'), 'ok')) },
      { label: tr('att|Phones'), num: true, render: (e) => String(e.phones), sort: (e) => e.phones },
      { label: tr('att|Notice'), render: (e) => (e.consent_at ? esc(ui.date(e.consent_at.slice(0, 10))) : '—') },
      { label: tr('att|Last signed in'), render: (e) => (e.last_login_at ? V.ago(e.last_login_at) : '—'), sort: (e) => e.last_login_at || '' },
      { label: '', render: (e) => `<details class="pop"><summary class="btn btn--ghost btn--xs">${esc(tr('att|Set the PIN'))}</summary>${ui.form(`/admin/attendance/people/${e.id}/pin`, csrf, `${ui.input('pin', tr('att|New 6-digit PIN'), '', { attrs: { inputmode: 'numeric', pattern: '\\d{6}', maxlength: 6, autocomplete: 'off' } })}<div class="row">${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}${ui.btn(esc(tr('att|Make one for me')), { cls: 'btn--ghost btn--sm', attrs: { name: 'auto', value: '1' } })}</div>`)}</details>` },
    ], rows);
    frame(req, res, {
      tab: '/admin/attendance/devices', title: tr('att|Phones & PINs'),
      body: `${pend}<form method="get" class="filters">${f.fields}<div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div></form>${ui.card(tr('att|Who can use the staff app'), table, { sub: esc(tr('att|Each person signs in at {url} with their employee code and a 6-digit PIN. Their first phone is registered to them.', { url: `${(h.env && h.env.SITE_URL) || ''}/staff` })) })}`,
    });
  });
  router.post('/attendance/devices/:id(\\d+)/approve', RH, (req, res, next) => {
    const d = S.decideDevice(h.int(req.params.id), 'active', req.user);
    if (!d) return next();
    // one phone per person: approving a new one retires the others
    db.run("UPDATE att_devices SET status = 'revoked', decided_by = ?, decided_at = ? WHERE employee_id = ? AND id != ? AND status = 'active'", req.user.id, now(), d.employee_id, d.id);
    db.run('DELETE FROM att_logins WHERE employee_id = ? AND (device_id IS NULL OR device_id != ?)', d.employee_id, d.id);
    h.log(req, 'Approved a phone for the staff app', 'employee', d.employee_id, d.label);
    h.back(req, res, req.get('referer') && req.get('referer').includes('/admin/') ? req.get('referer').replace(/^https?:\/\/[^/]+/, '') : '/admin/attendance/devices', 'ok', tr('att|Approved. The phone can sign in now.'));
  });
  router.post('/attendance/devices/:id(\\d+)/revoke', RH, (req, res, next) => {
    const d = S.decideDevice(h.int(req.params.id), 'revoked', req.user);
    if (!d) return next();
    h.log(req, 'Removed a phone from the staff app', 'employee', d.employee_id, d.label);
    h.back(req, res, req.get('referer') && req.get('referer').includes('/admin/') ? req.get('referer').replace(/^https?:\/\/[^/]+/, '') : '/admin/attendance/devices', 'ok', tr('att|Removed.'));
  });

  // ---------- settings ----------
  router.get('/attendance/settings', RH, (req, res) => {
    const csrf = req.session.csrf;
    const f = S.fence();
    const set = S.fenceSet();
    const sample = db.setting('att_point_demo') === '1';
    const point = set ? `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}` : '';
    const holidays = db.all('SELECT * FROM att_holidays WHERE date >= ? ORDER BY date LIMIT 40', `${today().slice(0, 4)}-01-01`);
    const fenceCard = ui.card(tr('att|The mall’s circle'), `${sample ? `<p class="alert alert--error">${esc(tr('att|This point came with the sample data and is only approximate. Stand in the middle of the mall and press “Use where I am standing”, or paste the exact point.'))}</p>` : ''}
      ${!set ? `<p class="alert alert--error">${esc(tr('att|Not set yet: nobody can clock in until it is.'))}</p>` : ''}
      ${ui.form('/admin/attendance/settings', csrf, `<input type="hidden" name="part" value="fence">
        <div class="fields">${ui.input('point', tr('att|The centre of the mall'), point, { required: true, placeholder: '30.0300, 31.4700', hint: tr('att|Coordinates, or paste a Google Maps link to the mall’s pin.'), attrs: { 'data-att-point': '', dir: 'ltr' } })}
        ${ui.input('radius', tr('att|Circle radius (metres)'), S.num('att_radius'), { type: 'number', min: 30, max: 1000, required: true, hint: tr('att|100 m by default. Large malls may need more so every entrance counts.') })}
        ${ui.input('max_acc', tr('att|Precision needed (metres)'), S.num('att_max_acc'), { type: 'number', min: 10, max: 500, required: true, hint: tr('att|A reading less precise than this is refused. Indoors, 30–60 m is usual.') })}</div>
        <p class="row"><button type="button" class="btn btn--ghost" data-att-here>${ui.icon('gauge')}<span>${esc(tr('att|Use where I am standing'))}</span></button><span class="muted small" data-att-here-out></span></p>
        ${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' })}`);
    const radarPrev = set ? ui.card(tr('att|Preview'), V.radar({ center: f, radius: f.radius, points: [], size: 360, title: tr('att|North up · rings every 25 m · your circle in gold') })) : '';
    const rules = ui.card(tr('att|Rules'), ui.form('/admin/attendance/settings', csrf, `<input type="hidden" name="part" value="rules"><div class="fields">
      ${ui.input('grace', tr('att|Default grace (minutes)'), S.num('att_grace'), { type: 'number', min: 0, max: 120, hint: tr('att|Arriving later than this after the shift starts counts as late.') })}
      ${ui.input('ping', tr('att|Location update while clocked in (minutes)'), S.num('att_ping_min'), { type: 'number', min: 1, max: 60 })}
      ${ui.input('left', tr('att|Alert when outside the circle for (minutes)'), S.num('att_left_min'), { type: 'number', min: 5, max: 120 })}
      ${ui.input('auto_out', tr('att|Close a forgotten day after the shift ends (hours)'), S.num('att_auto_out_h'), { type: 'number', min: 1, max: 12 })}
      ${ui.input('ot_from', tr('att|Overtime counts from (minutes over the shift)'), S.num('att_ot_from'), { type: 'number', min: 0, max: 120 })}
      ${ui.input('ot_rate', tr('att|Overtime pay rate (× the hourly rate)'), S.num('att_ot_rate'), { type: 'number', step: '0.05', min: 1, max: 3 })}
      ${ui.input('wifi', tr('att|The mall’s Wi-Fi public IP addresses (optional)'), S.wifiList().join(', '), { hint: tr('att|Only an extra signal: clocking from elsewhere is flagged, never refused, for this.'), attrs: { dir: 'ltr' } })}
      ${ui.input('keep', tr('att|Keep location updates and office minutes for (days)'), S.num('att_keep_days'), { type: 'number', min: 30, max: 1825 })}</div>
      <label class="check"><input type="checkbox" name="selfie" value="1"${S.selfieOn() ? ' checked' : ''}> ${esc(tr('att|Ask for a photo with the front camera when clocking in and out'))}</label>
      <label class="check"><input type="checkbox" name="absent_unpaid" value="1"${S.num('att_absent_unpaid') === 1 ? ' checked' : ''}> ${esc(tr('att|Absences without leave become unpaid days in payroll'))}</label>
      ${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' }));
    const hol = ui.card(tr('att|Official holidays'), `${holidays.length ? `<ul class="list">${holidays.map((x) => `<li><span class="what"><b>${esc(tx(x.name))}</b><small>${esc(ui.date(x.date))}</small></span>${ui.form(`/admin/attendance/holidays/${x.date}/delete`, csrf, `<button class="iconbtn" aria-label="${esc(tr('att|Remove'))}">${ui.icon('x')}</button>`)}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('att|None this year yet.'))}</p>`}
      ${ui.form('/admin/attendance/holidays', csrf, `<div class="fields">${ui.input('date', tr('att|Date'), '', { type: 'date', required: true })}${ui.input('name', tr('att|Name'), '', { required: true })}</div>${ui.btn(esc(tr('att|Add')), { cls: 'btn--ghost btn--sm' })}`)}`, { sub: esc(tr('att|A holiday is not an absence; people who work it are paid as usual.')) });
    const notice = ui.card(tr('att|What staff are told'), `<p class="small">${esc(tr('att|Before first use, each person reads and accepts a notice: the app records their position only when they clock and every few minutes while they are clocked in with the app open, plus a photo when clocking if switched on. It is used for attendance and pay, kept for the period set above (punches as long as the HR file), seen only by HR and their manager. This follows Egypt’s Personal Data Protection Law (151 of 2020).'))}</p><p class="small muted">${esc(tr('att|Location and the camera need the site to be on HTTPS.'))}</p>`);
    frame(req, res, { tab: '/admin/attendance/settings', title: tr('att|Settings'), body: `<div class="grid grid--side"><div class="stack">${fenceCard}${rules}</div><div class="stack">${radarPrev}${hol}${notice}</div></div>` });
  });
  router.post('/attendance/settings', RH, (req, res) => {
    const b = req.body;
    const clamp = (k, v) => { const [lo, hi] = S.LIMITS[k]; const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : S.DEFAULTS[k]; };
    if (b.part === 'fence') {
      const p = E.parsePoint(b.point);
      if (!p) return h.back(req, res, '/admin/attendance/settings', 'error', tr('att|That is not a point: use coordinates like 30.0300, 31.4700 or a Google Maps link.'));
      db.setSetting('att_lat', String(p.lat));
      db.setSetting('att_lng', String(p.lng));
      db.setSetting('att_radius', String(clamp('att_radius', b.radius)));
      db.setSetting('att_max_acc', String(clamp('att_max_acc', b.max_acc)));
      db.setSetting('att_point_demo', '0');
      h.log(req, 'Set the mall’s attendance circle', 'settings', null, `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
    } else {
      db.setSetting('att_grace', String(clamp('att_grace', b.grace)));
      db.setSetting('att_ping_min', String(clamp('att_ping_min', b.ping)));
      db.setSetting('att_left_min', String(clamp('att_left_min', b.left)));
      db.setSetting('att_auto_out_h', String(clamp('att_auto_out_h', b.auto_out)));
      db.setSetting('att_ot_from', String(clamp('att_ot_from', b.ot_from)));
      db.setSetting('att_ot_rate', String(clamp('att_ot_rate', b.ot_rate)));
      db.setSetting('att_keep_days', String(clamp('att_keep_days', b.keep)));
      db.setSetting('att_selfie', b.selfie === '1' ? '1' : '0');
      db.setSetting('att_absent_unpaid', b.absent_unpaid === '1' ? '1' : '0');
      const ips = String(b.wifi || '').split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^[0-9a-f.:]{3,45}$/i.test(x)).slice(0, 20);
      db.setSetting('att_wifi', ips.join(','));
      h.log(req, 'Changed the attendance rules', 'settings');
    }
    h.back(req, res, '/admin/attendance/settings', 'ok', tr('att|Saved.'));
  });
  router.post('/attendance/holidays', RH, (req, res) => {
    if (!isDate(req.body.date) || !h.str(req.body.name, 80)) return h.back(req, res, '/admin/attendance/settings', 'error', tr('att|Choose the date and give it a name.'));
    db.run('INSERT INTO att_holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name', req.body.date, h.str(req.body.name, 80));
    h.log(req, 'Added an official holiday', 'settings', null, h.str(req.body.name, 80));
    h.back(req, res, '/admin/attendance/settings', 'ok', tr('att|Saved.'));
  });
  router.post('/attendance/holidays/:date/delete', RH, (req, res) => {
    db.run('DELETE FROM att_holidays WHERE date = ?', String(req.params.date));
    h.back(req, res, '/admin/attendance/settings', 'ok', tr('att|Removed.'));
  });

  // ---------- every office page: minutes in use (public/admin/beat.js), and "my clock" ----------
  router.post('/me/beat', (req, res) => {
    const b = req.body || {};
    S.beat(req.user.id, { path: typeof b.path === 'string' ? b.path : null, active: b.active !== false && b.active !== 0 });
    res.status(204).end();
  });
  router.get('/me/clock', (req, res) => {
    const e = S.empOfUser(req.user.id);
    if (!e) return h.back(req, res, '/admin', 'error', tr('att|Your account is not linked to an employee record. Ask HR to link it.'));
    const token = require('node:crypto').randomBytes(24).toString('base64url');
    db.run('INSERT INTO att_handoffs (id, employee_id, expires_at) VALUES (?, ?, ?)', S.sha(token), e.id, new Date(Date.now() + 120000).toISOString());
    res.redirect(303, `/staff/handoff/${token}`);
  });

  h.count('attendance', (u) => (u.role === 'admin' || u.hr ? db.value("SELECT COUNT(*) FROM att_devices WHERE status = 'pending'") : 0));
  if (h.every) h.every('attendance', 2 * 60 * 1000, () => S.sweep(undefined, { force: true }), { first: 60 * 1000 });

  // the staff app at /staff
  require('../attendance/staff')(h, S, V);
};
