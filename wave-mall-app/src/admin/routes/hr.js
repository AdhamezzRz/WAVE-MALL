'use strict';

// HR for the mall's own team: the people directory and profiles, departments, leave (requests,
// approvals, balances, who is off) and monthly payroll with payslips. Every route is HR-only
// (administrators, and anyone given HR access on the Team page): salaries, national IDs and
// employee files are never shown to anyone else.
//
// Egypt: the weekend is Friday; annual leave is 21 days (30 after ten years' service or from
// age 50), casual leave (up to 6 days) counts within it. Social insurance is a share of the
// insured wage, which is clamped to the yearly minimum and maximum set in Settings. Income tax is
// entered per payslip: it must follow the brackets in force, which this module does not guess.

const { t: tr, tn, tx, isAr } = require('../i18n');
const i18n = require('../i18n');

// ---------- label lists (stored as keys, shown through tr) ----------
const TYPES = { full_time: 'hr|Full time', part_time: 'hr|Part time', fixed_term: 'hr|Fixed-term contract', intern: 'hr|Intern', outsourced: 'hr|Outsourced' };
const LEAVE = { annual: 'hr|Annual leave', casual: 'hr|Casual leave', sick: 'hr|Sick leave', unpaid: 'hr|Unpaid leave', maternity: 'hr|Maternity leave', compassionate: 'hr|Compassionate leave', hajj: 'hr|Hajj leave' };
const LEAVE_STATUS = { pending: 'leave|Pending', approved: 'leave|Approved', rejected: 'leave|Rejected', cancelled: 'leave|Cancelled' };
const RUN_STATUS = { draft: 'payroll|Draft', approved: 'payroll|Approved', paid: 'payroll|Paid' };
const END_REASONS = { resigned: 'hr|Resigned', contract_ended: 'hr|Contract ended', terminated: 'hr|Terminated', retired: 'hr|Retired' };
const GENDER = { male: 'hr|Male', female: 'hr|Female' };
const MARITAL = { single: 'hr|Single', married: 'hr|Married', divorced: 'hr|Divorced', widowed: 'hr|Widowed' };
const LEAVE_TONE = { annual: 'sea', casual: 'sky', sick: 'amber', unpaid: 'rose', maternity: 'cocoa', compassionate: 'sand', hajj: 'forest' };
const DEFAULT_DEPTS = ['Management', 'Leasing', 'Finance', 'Operations', 'Facilities & maintenance', 'Security', 'Housekeeping', 'Customer service', 'Marketing', 'HR & admin', 'IT'];
const CASUAL_MAX = 6;

const labels = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, tr(v)]));
const lbl = (map, k) => (map[k] ? tr(map[k]) : k || '—');

// ---------- dates and maths (pure, tested) ----------
const DAY = 86400000;
const ms = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
const isoOf = (t) => new Date(t).toISOString().slice(0, 10);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(ms(v));

// Working days from start to end inclusive, Fridays excluded.
function workDays(start, end) {
  if (!isDate(start) || !isDate(end) || end < start) return 0;
  let n = 0;
  for (let d = ms(start); d <= ms(end); d += DAY) if (new Date(d).getUTCDay() !== 5) n++;
  return n;
}
// Working days of [start, end] that fall inside [from, to].
function overlapDays(start, end, from, to) {
  const a = start > from ? start : from;
  const b = end < to ? end : to;
  return b < a ? 0 : workDays(a, b);
}
// Whole years from a date to another.
function yearsBetween(from, to) {
  if (!isDate(from) || !isDate(to)) return 0;
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0);
}
// Annual leave for a year: the person's own figure or the office default; 30 days once they have
// ten years' service or turn 50 during the year.
function entitlement(emp, base = 21, year = new Date().getUTCFullYear()) {
  const b = Number(emp.annual_leave_days) || Number(base) || 21;
  const end = `${year}-12-31`;
  const senior = yearsBetween(emp.hire_date, end) >= 10 || (emp.birth_date && yearsBetween(emp.birth_date, end) >= 50);
  return senior ? Math.max(b, 30) : b;
}
// The wage social insurance is worked out on: the person's insured wage (or basic + allowances),
// kept between the legal minimum and maximum.
function insuredWage(emp, s) {
  const raw = emp.insured_wage !== null && emp.insured_wage !== undefined && emp.insured_wage !== '' ? Number(emp.insured_wage) : Number(emp.basic_salary) + Number(emp.allowances);
  const lo = Number(s.si_min_wage) || 0;
  const hi = Number(s.si_max_wage) || Infinity;
  return Math.min(hi, Math.max(lo, raw || 0));
}
const monthBounds = (period) => {
  const start = `${period}-01`;
  const end = isoOf(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0));
  return { start, end, days: Number(end.slice(8)) };
};
// One payslip line. Pay is pro-rated by calendar days for someone who joined or left during the
// month; unpaid leave is taken off at a daily rate of (basic + allowances) / working days a month.
function payLine(emp, period, s, { unpaidDays = 0, overtime = 0, bonus = 0, deductions = 0, tax = 0 } = {}) {
  const { start, end, days } = monthBounds(period);
  const from = emp.hire_date > start ? emp.hire_date : start;
  const to = emp.ended_at && emp.ended_at < end ? emp.ended_at : end;
  const worked = to < from ? 0 : Math.round((ms(to) - ms(from)) / DAY) + 1;
  const f = worked / days;
  const basic = r2(Number(emp.basic_salary) * f);
  const allowances = r2(Number(emp.allowances) * f);
  const daily = (Number(emp.basic_salary) + Number(emp.allowances)) / (Number(s.work_days_month) || 26);
  const unpaid = r2(daily * (Number(unpaidDays) || 0));
  const wage = worked ? insuredWage(emp, s) : 0;
  const insEmp = r2((wage * (Number(s.si_employee_pct) || 0)) / 100);
  const insCo = r2((wage * (Number(s.si_employer_pct) || 0)) / 100);
  const extra = { overtime: r2(overtime), bonus: r2(bonus), deductions: r2(deductions), tax: r2(tax) };
  const net = r2(basic + allowances + extra.overtime + extra.bonus - extra.deductions - unpaid - insEmp - extra.tax);
  return { basic, allowances, ...extra, unpaid_days: Number(unpaidDays) || 0, unpaid, insurance_employee: insEmp, insurance_employer: insCo, net, worked, days };
}
const gross = (l) => r2(l.basic + l.allowances + l.overtime + l.bonus);
// The unpaid-leave amount of a stored line (what is left once everything else is accounted for).
const unpaidOf = (l) => r2(gross(l) - l.deductions - l.insurance_employee - l.tax - l.net);

module.exports = function hr(router, h) {
  const { db, ui, M } = h;
  const RH = h.RH;
  const esc = ui.esc;
  const today = () => M.today();
  const year = () => Number(today().slice(0, 4));
  const S = () => db.settings();

  // ---------- reading ----------
  const nm = (e) => (e ? (isAr() && e.name_ar ? e.name_ar : e.name) : '');
  // initials; for Arabic names the article «ال» is skipped (السيد → س)
  const ini = (e) => {
    const n = nm(e);
    return /[\u0600-\u06ff]/.test(n) ? n.trim().split(/\s+/).map((w) => w.replace(/^ال(?=..)/, '')[0]).slice(0, 2).join(' ') : ui.initials(n);
  };
  const emps = (where = '', ...args) => db.all(`SELECT e.*, d.name dept FROM employees e LEFT JOIN departments d ON d.id = e.department_id ${where} ORDER BY e.name`, ...args);
  const empOf = (id) => db.get('SELECT e.*, d.name dept, m.name manager_name, m.name_ar manager_name_ar FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN employees m ON m.id = e.manager_id WHERE e.id = ?', id);
  const depts = () => db.all('SELECT d.*, (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.status = \'active\') n FROM departments d ORDER BY d.sort, d.name');
  const deptName = (n) => tx(n) || '—';
  const onLeave = (on = today()) => new Set(db.all("SELECT employee_id FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ?", on, on).map((r) => r.employee_id));
  const nextCode = () => {
    const last = db.all("SELECT code FROM employees WHERE code LIKE 'EMP-%'").map((r) => Number(r.code.slice(4)) || 0).sort((a, b) => b - a)[0] || 0;
    return `EMP-${String(last + 1).padStart(4, '0')}`;
  };
  // Leave taken (approved) and pending in a year, by type, in working days.
  function leaveUse(empId, y = year()) {
    const from = `${y}-01-01`;
    const to = `${y}-12-31`;
    const out = { taken: {}, pending: 0, annualTaken: 0, casual: 0 };
    for (const r of db.all("SELECT * FROM leave_requests WHERE employee_id = ? AND status IN ('approved','pending') AND end_date >= ? AND start_date <= ?", empId, from, to)) {
      const full = workDays(r.start_date, r.end_date) || 1;
      const inYear = overlapDays(r.start_date, r.end_date, from, to);
      const d = r2((r.days * inYear) / full);
      if (r.status === 'pending') {
        if (['annual', 'casual'].includes(r.type)) out.pending += d;
        continue;
      }
      out.taken[r.type] = r2((out.taken[r.type] || 0) + d);
      if (['annual', 'casual'].includes(r.type)) out.annualTaken = r2(out.annualTaken + d);
      if (r.type === 'casual') out.casual = r2(out.casual + d);
    }
    return out;
  }
  const balance = (e, y = year()) => {
    const ent = entitlement(e, S().annual_leave_days, y);
    const u = leaveUse(e.id, y);
    return { entitled: ent, taken: u.annualTaken, pending: u.pending, remaining: r2(ent - u.annualTaken), casual: u.casual, use: u };
  };
  const statusBadge = (e, off = null) => (e.status === 'left' ? ui.badge('void', tr('hr|Left')) : (off || onLeave()).has(e.id) ? ui.badge('pending', tr('hr|On leave'), 'amber') : e.probation_end && e.probation_end >= today() ? ui.badge('sent', tr('hr|On probation'), 'sky') : ui.badge('active', tr('hr|Active')));
  const who = (e, sub = '') => `<span class="who"><span class="avatar avatar--sm">${esc(ini(e))}</span><span><b>${esc(nm(e))}</b>${sub ? `<small class="sub">${sub}</small>` : ''}</span></span>`;
  const service = (hire, on = today()) => {
    const y = yearsBetween(hire, on);
    const m = Math.max(0, Math.floor((ms(on) - ms(M.addMonths(hire, y * 12))) / (DAY * 30.44)));
    return y ? (m ? tr('{y} and {m}', { y: tn(y, '{n} year', '{n} years'), m: tn(m, '{n} month', '{n} months') }) : tn(y, '{n} year', '{n} years')) : tn(m, '{n} month', '{n} months');
  };
  const sub = (txt) => `<p class="hr-sub">${txt}</p>`;
  const tabs = (items, on) => `<nav class="tabs">${items.map(([href, label, key, count]) => `<a class="tab${on === key ? ' is-on' : ''}" href="${href}">${esc(label)}${count ? ` <b class="nav__count">${count}</b>` : ''}</a>`).join('')}</nav>`;
  const money = (n) => ui.money(n, { cur: false });

  // ---------- the people overview and directory ----------
  router.get('/hr', RH, (req, res) => {
    const q = req.query;
    const t = today();
    const s = S();
    const all = emps();
    const active = all.filter((e) => e.status === 'active');
    const off = onLeave();
    const yearStart = `${year()}-01-01`;
    const hires = all.filter((e) => e.hire_date >= yearStart && e.hire_date <= t).length;
    const lastRun = db.get("SELECT * FROM payroll_runs WHERE status IN ('approved','paid') ORDER BY period DESC LIMIT 1");
    const runCost = lastRun ? db.get('SELECT COALESCE(SUM(basic + allowances + overtime + bonus + insurance_employer), 0) c FROM payroll_lines WHERE run_id = ?', lastRun.id).c : null;
    const estimate = active.reduce((a, e) => a + Number(e.basic_salary) + Number(e.allowances) + (insuredWage(e, s) * (Number(s.si_employer_pct) || 0)) / 100, 0);
    const pending = db.value("SELECT COUNT(*) FROM leave_requests WHERE status = 'pending'");
    const in60 = M.addDays(t, 60);
    const ending = active.filter((e) => (e.contract_end && e.contract_end >= t && e.contract_end <= in60) || (e.probation_end && e.probation_end >= t && e.probation_end <= in60));
    const kpis = [
      ui.kpi({ label: tr('hr|Headcount'), value: ui.n0(active.length), sub: esc(tn(depts().filter((d) => d.n).length, '{n} department', '{n} departments')) }),
      ui.kpi({ label: tr('New this year'), value: ui.n0(hires), sub: esc(tr('Joined since 1 January')) }),
      ui.kpi({ label: tr('Monthly payroll cost'), value: ui.money(runCost ?? estimate, { compact: true }), sub: esc(lastRun ? tr('{month} payroll, with employer insurance', { month: ui.monthYear(lastRun.period) }) : tr('Estimated from current salaries')), href: '/admin/hr/payroll' }),
      ui.kpi({ label: tr('On leave today'), value: ui.n0(active.filter((e) => off.has(e.id)).length), href: '/admin/hr/leave?tab=approved' }),
      ui.kpi({ label: tr('Leave to approve'), value: ui.n0(pending), tone: pending ? 'kpi--alert' : '', href: '/admin/hr/leave' }),
      ui.kpi({ label: tr('Contracts & probation ending'), value: ui.n0(ending.length), sub: esc(tr('Within 60 days')) }),
    ].join('');

    // headcount by department
    const byDept = depts().filter((d) => d.n);
    const none = active.filter((e) => !e.department_id).length;
    const maxN = Math.max(1, ...byDept.map((d) => d.n), none);
    const deptRows = [...byDept.map((d) => [deptName(d.name), d.n, `/admin/hr?dept=${d.id}`]), ...(none ? [[tr('hr|No department'), none, '/admin/hr?dept=none']] : [])]
      .map(([l, n, href]) => `<a class="funnel__row hr-dept" href="${href}"><span class="funnel__name">${esc(l)}</span><span class="funnel__track"><i class="t-forest" style="width:${Math.max(3, (n / maxN) * 100)}%"></i></span><b>${n}</b></a>`).join('');

    // this month: birthdays and work anniversaries
    const mm = t.slice(5, 7);
    const moments = active
      .flatMap((e) => [
        e.birth_date && e.birth_date.slice(5, 7) === mm ? { e, day: e.birth_date.slice(8), what: tr('hr|Birthday'), tone: 'dot--rose' } : null,
        e.hire_date.slice(5, 7) === mm && e.hire_date.slice(0, 4) < String(year()) ? { e, day: e.hire_date.slice(8), what: tn(year() - Number(e.hire_date.slice(0, 4)), '{n} year with us', '{n} years with us'), tone: 'dot--sea' } : null,
      ])
      .filter(Boolean)
      .sort((a, b) => a.day.localeCompare(b.day));
    const momentList = moments.length
      ? `<ul class="list">${moments.map((m) => `<li><a href="/admin/hr/employees/${m.e.id}"><span class="when"><b>${Number(m.day)}</b><small>${esc(ui.monthName(Number(mm)))}</small></span><span class="dot ${m.tone}"></span><span class="what"><b>${esc(nm(m.e))}</b><small>${esc(m.what)}</small></span></a></li>`).join('')}</ul>`
      : `<p class="muted pad">${esc(tr('No birthdays or anniversaries this month.'))}</p>`;

    // coming up: contract and probation ends, and who is off this week
    const soon = [
      ...ending.map((e) => (e.probation_end && e.probation_end >= t && e.probation_end <= in60 ? { e, date: e.probation_end, what: tr('hr|Probation ends') } : { e, date: e.contract_end, what: tr('hr|Contract ends') })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const week = db.all("SELECT l.*, e.name, e.name_ar FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ? ORDER BY l.start_date", M.addDays(t, 7), t);
    const soonList = soon.length || week.length
      ? `<ul class="list">${soon.map((x) => `<li><a href="/admin/hr/employees/${x.e.id}"><span class="dot dot--amber"></span><span class="what"><b>${esc(nm(x.e))}</b><small>${esc(x.what)} · ${ui.date(x.date)} · ${esc(ui.rel(x.date))}</small></span></a></li>`).join('')}${week.map((l) => `<li><a href="/admin/hr/employees/${l.employee_id}"><span class="dot dot--sea"></span><span class="what"><b>${esc(nm(l))}</b><small>${esc(lbl(LEAVE, l.type))} · ${ui.date(l.start_date)} – ${ui.date(l.end_date)}</small></span></a></li>`).join('')}</ul>`
      : `<p class="muted pad">${esc(tr('Nothing in the next 60 days.'))}</p>`;

    // the directory
    const where = [];
    const args = [];
    if (q.q) { where.push('(e.name LIKE ? OR e.name_ar LIKE ? OR e.code LIKE ? OR e.phone LIKE ? OR e.position LIKE ?)'); args.push(...Array(5).fill(`%${h.str(q.q, 80)}%`)); }
    if (q.dept === 'none') where.push('e.department_id IS NULL');
    else if (h.int(q.dept)) { where.push('e.department_id = ?'); args.push(h.int(q.dept)); }
    if (TYPES[q.type]) { where.push('e.employment_type = ?'); args.push(q.type); }
    const st = ['active', 'left', 'all'].includes(q.status) ? q.status : 'active';
    if (st !== 'all') { where.push('e.status = ?'); args.push(st); }
    const list = emps(where.length ? `WHERE ${where.join(' AND ')}` : '', ...args);
    const filters = `<form class="filters" method="get" action="/admin/hr">
      <input type="search" name="q" value="${esc(q.q || '')}" placeholder="${esc(tr('Search name, code, phone, position'))}" aria-label="${esc(tr('Search'))}">
      ${ui.select('dept', tr('hr|Department'), [...depts().map((d) => [d.id, deptName(d.name)]), ['none', tr('hr|No department')]], q.dept, { blank: tr('All departments'), cls: 'f--inline' })}
      ${ui.select('type', tr('hr|Employment type'), labels(TYPES), q.type, { blank: tr('Any type'), cls: 'f--inline' })}
      ${ui.select('status', tr('Status'), [['active', tr('hr|Active')], ['left', tr('hr|Left')], ['all', tr('All')]], st, { cls: 'f--inline' })}
      ${ui.btn(esc(tr('hr|Filter')), { cls: 'btn--ghost btn--sm' })}
    </form>`;
    const table = ui.table(
      [
        { label: tr('hr|Person'), render: (e) => who(e, `<span class="ltr">${esc(e.code)}</span>`) },
        { label: tr('hr|Position'), render: (e) => `${esc(tx(e.position) || '—')}<small class="sub">${esc(deptName(e.dept))}</small>` },
        { label: tr('Phone'), render: (e) => (e.phone ? `<a href="tel:${esc(e.phone)}">${esc(e.phone)}</a>` : '—') },
        { label: tr('hr|Hired'), render: (e) => `${ui.date(e.hire_date)}<small class="sub">${esc(service(e.hire_date, e.ended_at || today()))}</small>` },
        { label: tr('hr|Employment type'), render: (e) => esc(lbl(TYPES, e.employment_type)) },
        { label: tr('Status'), render: (e) => statusBadge(e, off) },
      ],
      list,
      { empty: esc(all.length ? tr('No one matches these filters.') : tr('No employees yet. Add the first person to start the directory.')), href: (e) => `/admin/hr/employees/${e.id}` },
    );
    const body = `<div class="kpis">${kpis}</div>
<div class="grid">
  ${ui.card(tr('Headcount by department'), deptRows ? `<div class="funnel">${deptRows}</div>` : `<p class="muted pad">${esc(tr('No employees yet.'))}</p>`, { action: ui.btn(esc(tr('hr|Departments')), { href: '/admin/hr/departments', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('hr|This month'), momentList, { sub: esc(tr('Birthdays and work anniversaries')) })}
  ${ui.card(tr('Coming up'), soonList, { sub: esc(tr('Contracts, probation and leave')) })}
</div>
<div class="hr-dir">${filters}${ui.card(tn(list.length, '{n} person', '{n} people'), table, { action: ui.btn(esc(tr('Export CSV')), { href: '/admin/hr/employees.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}</div>`;
    h.page(req, res, {
      title: tr('Employees'), active: '/admin/hr', wide: true, body,
      actions: `${ui.btn(esc(tr('hr|Departments')), { href: '/admin/hr/departments', cls: 'btn--ghost' })}${ui.btn(esc(tr('New employee')), { href: '/admin/hr/employees/new', cls: 'btn--primary', ic: 'plus' })}`,
    });
  });

  // ---------- the employee form ----------
  const employeeForm = (req, e = {}, action) => {
    const s = S();
    const v = (k, d = '') => (e[k] !== undefined && e[k] !== null ? e[k] : d);
    const managers = emps("WHERE e.status = 'active'").filter((m) => m.id !== e.id).map((m) => [m.id, `${nm(m)}${m.position ? ` · ${tx(m.position)}` : ''}`]);
    const users = db.all('SELECT id, name, email FROM users WHERE active = 1 ORDER BY name').map((u) => [u.id, `${u.name} · ${u.email}`]);
    return ui.form(action, req.session.csrf, `
      <fieldset><legend>${esc(tr('hr|Personal'))}</legend><div class="fields">
        ${ui.input('name', tr('Full name (English)'), v('name'), { required: true, attrs: { autocomplete: 'off' } })}
        ${ui.input('name_ar', tr('Full name (Arabic)'), v('name_ar'), { attrs: { dir: 'rtl', lang: 'ar' } })}
        ${ui.input('national_id', tr('National ID'), v('national_id'), { hint: tr('14 digits'), attrs: { inputmode: 'numeric', pattern: '[0-9]{14}', maxlength: 14 } })}
        ${ui.input('birth_date', tr('hr|Date of birth'), v('birth_date'), { type: 'date' })}
        ${ui.select('gender', tr('hr|Gender'), labels(GENDER), v('gender'), { blank: '—' })}
        ${ui.input('nationality', tr('hr|Nationality'), v('nationality') ? tx(v('nationality')) : '', { placeholder: tr('e.g. Egyptian') })}
        ${ui.select('marital_status', tr('hr|Marital status'), labels(MARITAL), v('marital_status'), { blank: '—' })}
        ${ui.input('phone', tr('Phone'), v('phone'), { type: 'tel' })}
        ${ui.input('email', tr('Email'), v('email'), { type: 'email' })}
        ${ui.input('address', tr('hr|Address'), v('address'), { cls: 'span-all' })}
        ${ui.input('emergency_name', tr('hr|Emergency contact'), v('emergency_name'))}
        ${ui.input('emergency_phone', tr('hr|Emergency phone'), v('emergency_phone'), { type: 'tel' })}
      </div></fieldset>
      <fieldset><legend>${esc(tr('hr|Job'))}</legend><div class="fields">
        ${ui.select('department_id', tr('hr|Department'), depts().map((d) => [d.id, deptName(d.name)]), v('department_id'), { blank: tr('hr|No department') })}
        ${ui.input('position', tr('hr|Position'), v('position') ? tx(v('position')) : '', { required: true, placeholder: tr('e.g. Security officer') })}
        ${ui.select('manager_id', tr('hr|Reports to'), managers, v('manager_id'), { blank: tr('hr|No one') })}
        ${ui.input('hire_date', tr('hr|Hire date'), v('hire_date', today()), { type: 'date', required: true })}
        ${ui.select('employment_type', tr('hr|Employment type'), labels(TYPES), v('employment_type', 'full_time'))}
        ${ui.input('contract_end', tr('hr|Contract ends'), v('contract_end'), { type: 'date', hint: tr('For fixed-term contracts') })}
        ${ui.input('probation_end', tr('hr|Probation ends'), v('probation_end', e.id ? '' : M.addMonths(today(), 3)), { type: 'date', hint: tr('Up to three months under Egyptian labour law') })}
        ${ui.input('shift', tr('hr|Shift'), v('shift'), { placeholder: tr('e.g. 10:00–18:00, or rotating') })}
        ${ui.select('user_id', tr('hr|Office account'), users, v('user_id'), { blank: tr('None'), hint: tr('Link if this person signs in to the office') })}
      </div></fieldset>
      <fieldset><legend>${esc(tr('hr|Pay'))}</legend><div class="fields">
        ${ui.input('basic_salary', tr('Basic salary / month ({cur})', { cur: ui.curLabel() }), v('basic_salary', ''), { type: 'number', min: 0, step: '0.01', required: true })}
        ${ui.input('allowances', tr('Allowances / month ({cur})', { cur: ui.curLabel() }), v('allowances', 0), { type: 'number', min: 0, step: '0.01' })}
        ${ui.input('insured_wage', tr('Insured wage ({cur})', { cur: ui.curLabel() }), v('insured_wage', ''), { type: 'number', min: 0, step: '0.01', hint: tr('Empty: basic + allowances, kept between {min} and {max}', { min: ui.money(Number(s.si_min_wage)), max: ui.money(Number(s.si_max_wage)) }) })}
        ${ui.input('insurance_no', tr('hr|Social insurance number'), v('insurance_no'))}
        ${ui.input('bank_name', tr('hr|Bank'), v('bank_name'))}
        ${ui.input('iban', tr('hr|IBAN'), v('iban'), { attrs: { dir: 'ltr', autocomplete: 'off' } })}
        ${ui.input('annual_leave_days', tr('hr|Annual leave (days)'), v('annual_leave_days', ''), { type: 'number', min: 0, max: 60, hint: tr('Empty: {n} days, or 30 after ten years or from age 50', { n: s.annual_leave_days }) })}
      </div></fieldset>
      <fieldset><legend>${esc(tr('Notes'))}</legend>${ui.textarea('notes', tr('Notes'), v('notes') ? tx(v('notes')) : '', { rows: 3, cls: 'span-all' })}</fieldset>
      <div class="row">${ui.btn(esc(e.id ? tr('Save changes') : tr('Add employee')), { cls: 'btn--primary' })}${ui.btn(esc(tr('Cancel')), { href: e.id ? `/admin/hr/employees/${e.id}` : '/admin/hr', cls: 'btn--ghost' })}</div>`, { cls: 'form stack' });
  };

  // Read and check the form; returns { e } or { error }.
  function readEmployee(req, old = {}) {
    const b = req.body;
    const s = (k, n = 200) => h.str(b[k], n) || null;
    const e = {
      name: h.str(b.name, 120), name_ar: s('name_ar', 120), national_id: s('national_id', 20), birth_date: isDate(b.birth_date) ? b.birth_date : null,
      gender: GENDER[b.gender] ? b.gender : null, marital_status: MARITAL[b.marital_status] ? b.marital_status : null,
      phone: s('phone', 40), email: s('email', 200), address: s('address', 300), emergency_name: s('emergency_name', 120), emergency_phone: s('emergency_phone', 40),
      department_id: db.get('SELECT id FROM departments WHERE id = ?', h.int(b.department_id)) ? h.int(b.department_id) : null,
      position: s('position', 120), manager_id: h.int(b.manager_id) && h.int(b.manager_id) !== old.id && db.get('SELECT id FROM employees WHERE id = ?', h.int(b.manager_id)) ? h.int(b.manager_id) : null,
      hire_date: isDate(b.hire_date) ? b.hire_date : null, employment_type: TYPES[b.employment_type] ? b.employment_type : 'full_time',
      contract_end: isDate(b.contract_end) ? b.contract_end : null, probation_end: isDate(b.probation_end) ? b.probation_end : null, shift: s('shift', 120),
      user_id: h.int(b.user_id) && db.get('SELECT id FROM users WHERE id = ?', h.int(b.user_id)) ? h.int(b.user_id) : null,
      basic_salary: Math.max(0, h.numv(b.basic_salary) ?? -1), allowances: Math.max(0, h.numv(b.allowances) || 0),
      insured_wage: h.numv(b.insured_wage) !== null && h.numv(b.insured_wage) >= 0 ? h.numv(b.insured_wage) : null,
      insurance_no: s('insurance_no', 40), bank_name: s('bank_name', 120), iban: b.iban ? h.str(b.iban, 60).replace(/\s+/g, '').toUpperCase() || null : null,
      annual_leave_days: h.int(b.annual_leave_days) > 0 ? Math.min(60, h.int(b.annual_leave_days)) : null, notes: s('notes', 2000),
    };
    // keep the stored English when a translated value comes back unchanged
    for (const k of ['position', 'notes']) if (old[k] && e[k] === tx(old[k])) e[k] = old[k];
    if (old.nationality && h.str(b.nationality, 60) === tx(old.nationality)) e.nationality = old.nationality;
    else e.nationality = s('nationality', 60);
    if (!e.name) return { error: tr('Enter the full name.') };
    if (!e.position) return { error: tr('Enter the position.') };
    if (!e.hire_date) return { error: tr('Enter the hire date.') };
    if (b.basic_salary === undefined || b.basic_salary === '' || h.numv(b.basic_salary) === null || h.numv(b.basic_salary) < 0) return { error: tr('Enter the basic salary.') };
    if (e.national_id && !/^[23]\d{13}$/.test(e.national_id)) return { error: tr('A national ID has 14 digits and starts with 2 or 3.') };
    if (e.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.email)) return { error: tr('Enter a valid email.') };
    if (e.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(e.iban)) return { error: tr('That IBAN does not look right.') };
    if (e.national_id && db.get('SELECT id FROM employees WHERE national_id = ? AND id != ?', e.national_id, old.id || 0)) return { error: tr('Someone else has that national ID.') };
    // the national ID carries the birth date (century, year, month, day)
    if (e.national_id && !e.birth_date) {
      const c = e.national_id[0] === '2' ? '19' : '20';
      const d = `${c}${e.national_id.slice(1, 3)}-${e.national_id.slice(3, 5)}-${e.national_id.slice(5, 7)}`;
      if (isDate(d)) e.birth_date = d;
    }
    return { e };
  }
  const COLS = ['name', 'name_ar', 'national_id', 'birth_date', 'gender', 'nationality', 'marital_status', 'phone', 'email', 'address', 'emergency_name', 'emergency_phone', 'department_id', 'position', 'manager_id', 'hire_date', 'employment_type', 'contract_end', 'probation_end', 'shift', 'user_id', 'basic_salary', 'allowances', 'insured_wage', 'insurance_no', 'bank_name', 'iban', 'annual_leave_days', 'notes'];

  router.get('/hr/employees/new', RH, (req, res) => {
    h.page(req, res, { title: tr('New employee'), crumbs: [['/admin/hr', tr('Employees')], [null, tr('hr|New')]], active: '/admin/hr', body: ui.card(tr('Employee details'), employeeForm(req, {}, '/admin/hr/employees'), { sub: esc(tr('Fields marked * are required. Everything here is visible to HR only.')) }) });
  });
  router.post('/hr/employees', RH, (req, res) => {
    const r = readEmployee(req);
    if (r.error) return h.back(req, res, '/admin/hr/employees/new', 'error', r.error);
    const e = r.e;
    const id = Number(db.run(
      `INSERT INTO employees (code, ${COLS.join(', ')}, status, created_at, updated_at) VALUES (?, ${COLS.map(() => '?').join(', ')}, 'active', ?, ?)`,
      nextCode(), ...COLS.map((k) => e[k]), M.now(), M.now(),
    ).lastInsertRowid);
    h.log(req, 'Added an employee', 'employee', id, e.name);
    h.back(req, res, `/admin/hr/employees/${id}`, 'ok', tr('{name} added to the team.', { name: isAr() && e.name_ar ? e.name_ar : e.name }));
  });

  // ---------- the profile ----------
  router.get('/hr/employees/:id', RH, (req, res, next) => {
    const e = empOf(req.params.id);
    if (!e) return next();
    const s = S();
    const csrf = req.session.csrf;
    const t = today();
    const bal = balance(e);
    const age = e.birth_date ? yearsBetween(e.birth_date, t) : null;
    const reports = emps('WHERE e.manager_id = ? AND e.status = \'active\'', e.id);
    const user = e.user_id ? db.get('SELECT id, name, email FROM users WHERE id = ?', e.user_id) : null;
    const dl = (rows) => `<dl class="dl">${rows.filter(Boolean).map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${val || '—'}</dd></div>`).join('')}</dl>`;
    const head = `<div class="leadhead hr-head">
      <div class="hr-head__who"><span class="avatar avatar--lg">${esc(ini(e))}</span><div><h2>${esc(nm(e))}</h2><p>${esc(tx(e.position) || '—')} · ${esc(deptName(e.dept))}</p>${isAr() && e.name_ar ? `<p class="muted small ltr">${esc(e.name)}</p>` : e.name_ar ? `<p class="muted small" lang="ar">${esc(e.name_ar)}</p>` : ''}</div>${statusBadge(e)}</div>
      <div class="leadhead__stats">
        <div><small>${esc(tr('hr|Employee code'))}</small><b class="ltr">${esc(e.code)}</b></div>
        <div><small>${esc(tr('hr|Service'))}</small><b>${esc(service(e.hire_date, e.ended_at || t))}</b></div>
        <div><small>${esc(tr('hr|Employment type'))}</small><b>${esc(lbl(TYPES, e.employment_type))}</b></div>
        <div><small>${esc(tr('hr|Monthly gross'))}</small><b>${ui.money(Number(e.basic_salary) + Number(e.allowances))}</b></div>
        <div><small>${esc(tr('Leave left {year}', { year: year() }))}</small><b>${esc(tn(bal.remaining, '{n} day', '{n} days'))}</b></div>
        <div><small>${esc(tr('hr|Reports to'))}</small><b>${e.manager_id ? `<a href="/admin/hr/employees/${e.manager_id}">${esc(isAr() && e.manager_name_ar ? e.manager_name_ar : e.manager_name)}</a>` : '—'}</b></div>
      </div></div>`;
    const personal = dl([
      [tr('National ID'), e.national_id ? `<span class="ltr">${esc(e.national_id)}</span>` : ''],
      [tr('hr|Date of birth'), e.birth_date ? `${ui.date(e.birth_date)} · ${esc(tn(age, '{n} year old', '{n} years old'))}` : ''],
      [tr('hr|Gender'), esc(lbl(GENDER, e.gender) === '—' ? '' : lbl(GENDER, e.gender))],
      [tr('hr|Nationality'), esc(tx(e.nationality) || '')],
      [tr('hr|Marital status'), MARITAL[e.marital_status] ? esc(lbl(MARITAL, e.marital_status)) : ''],
      [tr('Phone'), e.phone ? `<a href="tel:${esc(e.phone)}">${esc(e.phone)}</a>` : ''],
      [tr('Email'), e.email ? `<a href="mailto:${esc(e.email)}">${esc(e.email)}</a>` : ''],
      [tr('hr|Address'), esc(e.address || '')],
      [tr('hr|Emergency contact'), e.emergency_name ? `${esc(e.emergency_name)}${e.emergency_phone ? ` · <a href="tel:${esc(e.emergency_phone)}">${esc(e.emergency_phone)}</a>` : ''}` : ''],
    ]);
    const job = dl([
      [tr('hr|Department'), esc(deptName(e.dept))],
      [tr('hr|Position'), esc(tx(e.position) || '')],
      [tr('hr|Hire date'), ui.date(e.hire_date)],
      [tr('hr|Contract ends'), e.contract_end ? `${ui.date(e.contract_end)} · ${esc(ui.rel(e.contract_end))}` : esc(tr('Open-ended'))],
      [tr('hr|Probation ends'), e.probation_end ? `${ui.date(e.probation_end)}${e.probation_end >= t ? ` · ${esc(ui.rel(e.probation_end))}` : ` · ${esc(tr('hr|Passed'))}`}` : ''],
      [tr('hr|Shift'), esc(tx(e.shift) || '')],
      [tr('hr|Team'), reports.length ? reports.map((r) => `<a href="/admin/hr/employees/${r.id}">${esc(nm(r))}</a>`).join(isAr() ? '، ' : ', ') : ''],
      [tr('hr|Office account'), user ? `${esc(user.name)} <small class="muted ltr">${esc(user.email)}</small>` : ''],
      e.status === 'left' ? [tr('hr|Left'), `${ui.date(e.ended_at)} · ${esc(lbl(END_REASONS, e.end_reason))}`] : null,
    ]);
    const iw = insuredWage(e, s);
    const pay = dl([
      [tr('hr|Basic salary'), ui.money(e.basic_salary)],
      [tr('hr|Allowances'), ui.money(e.allowances)],
      [tr('hr|Insured wage'), `${ui.money(iw)}${e.insured_wage === null || e.insured_wage === undefined ? ` <small class="muted">${esc(tr('hr|automatic'))}</small>` : ''}`],
      [tr('hr|Social insurance'), esc(tr('{a} employee · {b} employer a month', { a: ui.money((iw * Number(s.si_employee_pct)) / 100), b: ui.money((iw * Number(s.si_employer_pct)) / 100) }))],
      [tr('hr|Social insurance number'), e.insurance_no ? `<span class="ltr">${esc(e.insurance_no)}</span>` : ''],
      [tr('hr|Bank'), esc(e.bank_name || '')],
      [tr('hr|IBAN'), e.iban ? `<code>${esc(e.iban)}</code>` : ''],
    ]);
    const leaves = db.all('SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY start_date DESC LIMIT 30', e.id);
    const leaveCard = ui.card(tr('Leave {year}', { year: year() }), `<div class="hr-bal">
        <div><small>${esc(tr('hr|Entitled'))}</small><b>${bal.entitled}</b></div><div><small>${esc(tr('hr|Taken'))}</small><b>${bal.taken}</b></div>
        <div><small>${esc(tr('leave|Pending'))}</small><b>${bal.pending}</b></div><div class="is-key"><small>${esc(tr('hr|Remaining'))}</small><b>${bal.remaining}</b></div>
        <div><small>${esc(tr('Casual (of {n})', { n: CASUAL_MAX }))}</small><b>${bal.casual}</b></div><div><small>${esc(tr('hr|Sick'))}</small><b>${bal.use.taken.sick || 0}</b></div></div>
      ${leaves.length ? `<ul class="list">${leaves.map((l) => `<li><a href="/admin/hr/leave?employee=${e.id}&tab=all"><span class="dot dot--${l.status === 'approved' ? 'sea' : l.status === 'pending' ? 'amber' : 'rose'}"></span><span class="what"><b>${esc(lbl(LEAVE, l.type))} · ${esc(tn(l.days, '{n} day', '{n} days'))}</b><small>${ui.date(l.start_date)} – ${ui.date(l.end_date)}${l.reason ? ` · ${esc(tx(l.reason))}` : ''}</small></span>${ui.badge(l.status === 'approved' ? 'active' : l.status === 'pending' ? 'pending' : 'void', lbl(LEAVE_STATUS, l.status))}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('No leave yet.'))}</p>`}`,
    { action: e.status === 'active' ? ui.btn(esc(tr('Request leave')), { href: `/admin/hr/leave?employee=${e.id}#new`, cls: 'btn--ghost btn--sm' }) : '' });
    const slips = db.all("SELECT l.*, r.period, r.status run_status FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.employee_id = ? ORDER BY r.period DESC LIMIT 24", e.id);
    const slipCard = ui.card(tr('hr|Payslips'), ui.table(
      [
        { label: tr('hr|Month'), render: (l) => esc(ui.monthYear(l.period)) },
        { label: tr('hr|Gross'), num: true, render: (l) => money(gross(l)) },
        { label: tr('hr|Net'), num: true, render: (l) => `<b>${money(l.net)}</b>` },
        { label: tr('Status'), render: (l) => ui.badge(l.run_status === 'paid' ? 'paid' : l.run_status === 'approved' ? 'approved' : 'draft', lbl(RUN_STATUS, l.run_status)) },
        { label: '', render: (l) => `<a class="btn btn--ghost btn--xs" href="/admin/hr/payroll/${l.run_id}/slip/${e.id}">${esc(tr('hr|Payslip'))}</a>` },
      ],
      slips, { empty: esc(tr('No payroll yet.')), href: (l) => `/admin/hr/payroll/${l.run_id}` },
    ));
    const docs = ui.docPanel({ docs: h.docs(req, 'employee', e.id), entity: 'employee', entityId: e.id, csrf, canUpload: true, canDelete: true, required: ['employment_contract', 'national_id', 'insurance_form'], warnDays: Number(s.doc_warn_days) || 30, sub: esc(tr('Confidential: HR and administrators only')) });
    const end = e.status === 'active'
      ? `<details class="danger"><summary>${esc(tr('End employment'))}</summary>${ui.form(`/admin/hr/employees/${e.id}/end`, csrf, `<div class="fields">${ui.input('ended_at', tr('Last working day'), t, { type: 'date', required: true })}${ui.select('end_reason', tr('Reason'), labels(END_REASONS), 'resigned')}</div>${ui.btn(esc(tr('End employment')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('End {name}\'s employment?', { name: nm(e) }) } })}`, { cls: 'stack' })}</details>`
      : ui.form(`/admin/hr/employees/${e.id}/reactivate`, csrf, ui.btn(esc(tr('hr|Rehire')), { cls: 'btn--ghost btn--sm' }));
    const notes = e.notes ? ui.card(tr('Notes'), `<p class="quote quote--sm">${esc(tx(e.notes)).replace(/\n/g, '<br>')}</p>`) : '';
    const body = `${head}<div class="grid grid--side">
      <div class="stack">${ui.card(tr('hr|Personal'), personal)}${ui.card(tr('hr|Job'), job)}${leaveCard}${slipCard}${notes}</div>
      <div class="stack">${ui.card(tr('hr|Pay'), pay)}${docs}${end}</div></div>`;
    h.page(req, res, {
      title: nm(e), crumbs: [['/admin/hr', tr('Employees')], [null, e.code]], active: '/admin/hr', body,
      actions: ui.btn(esc(tr('Edit')), { href: `/admin/hr/employees/${e.id}/edit`, cls: 'btn--ghost' }),
    });
  });

  router.get('/hr/employees/:id/edit', RH, (req, res, next) => {
    const e = empOf(req.params.id);
    if (!e) return next();
    h.page(req, res, { title: tr('Edit {name}', { name: nm(e) }), crumbs: [['/admin/hr', tr('Employees')], [`/admin/hr/employees/${e.id}`, nm(e)], [null, tr('Edit')]], active: '/admin/hr', body: ui.card(tr('Employee details'), employeeForm(req, e, `/admin/hr/employees/${e.id}`)) });
  });
  router.post('/hr/employees/:id', RH, (req, res, next) => {
    const old = empOf(req.params.id);
    if (!old) return next();
    const r = readEmployee(req, old);
    if (r.error) return h.back(req, res, `/admin/hr/employees/${old.id}/edit`, 'error', r.error);
    db.run(`UPDATE employees SET ${COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...COLS.map((k) => r.e[k]), M.now(), old.id);
    const changed = ['basic_salary', 'allowances', 'department_id', 'position'].filter((k) => String(old[k] ?? '') !== String(r.e[k] ?? ''));
    h.log(req, changed.includes('basic_salary') || changed.includes('allowances') ? 'Changed pay' : 'Updated an employee', 'employee', old.id, old.name);
    h.back(req, res, `/admin/hr/employees/${old.id}`, 'ok', tr('Saved.'));
  });
  router.post('/hr/employees/:id/end', RH, (req, res, next) => {
    const e = empOf(req.params.id);
    if (!e) return next();
    const d = isDate(req.body.ended_at) ? req.body.ended_at : today();
    if (d < e.hire_date) return h.back(req, res, `/admin/hr/employees/${e.id}`, 'error', tr('The last day cannot be before the hire date.'));
    const reason = END_REASONS[req.body.end_reason] ? req.body.end_reason : 'resigned';
    db.run("UPDATE employees SET status = 'left', ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ?", d, reason, M.now(), e.id);
    db.run("UPDATE employees SET manager_id = NULL WHERE manager_id = ?", e.id);
    db.run("UPDATE leave_requests SET status = 'cancelled' WHERE employee_id = ? AND status = 'pending'", e.id);
    h.log(req, 'Ended employment', 'employee', e.id, `${e.name} — reason: ${i18n.english(END_REASONS[reason])}`);
    h.back(req, res, `/admin/hr/employees/${e.id}`, 'ok', tr('Employment ended on {date}.', { date: ui.date(d) }));
  });
  router.post('/hr/employees/:id/reactivate', RH, (req, res, next) => {
    const e = empOf(req.params.id);
    if (!e) return next();
    db.run("UPDATE employees SET status = 'active', ended_at = NULL, end_reason = NULL, updated_at = ? WHERE id = ?", M.now(), e.id);
    h.log(req, 'Rehired an employee', 'employee', e.id, e.name);
    h.back(req, res, `/admin/hr/employees/${e.id}`, 'ok', tr('{name} is active again.', { name: nm(e) }));
  });
  router.get('/hr/employees.csv', RH, (req, res) => {
    const rows = emps();
    const cols = [['code', tr('hr|Employee code')], ['name', tr('Full name (English)')], ['name_ar', tr('Full name (Arabic)')], [(e) => deptName(e.dept), tr('hr|Department')], [(e) => tx(e.position), tr('hr|Position')], [(e) => lbl(TYPES, e.employment_type), tr('hr|Employment type')], ['hire_date', tr('hr|Hire date')], ['contract_end', tr('hr|Contract ends')], ['phone', tr('Phone')], ['email', tr('Email')], ['national_id', tr('National ID')], ['basic_salary', tr('hr|Basic salary')], ['allowances', tr('hr|Allowances')], ['insurance_no', tr('hr|Social insurance number')], ['bank_name', tr('hr|Bank')], ['iban', tr('hr|IBAN')], [(e) => (e.status === 'left' ? tr('hr|Left') : tr('hr|Active')), tr('Status')]];
    h.log(req, 'Exported', 'export', null, 'Employees');
    res.set('Content-Disposition', `attachment; filename="employees-${today()}.csv"`).type('text/csv; charset=utf-8').send(csv(rows, cols));
  });

  // ---------- departments ----------
  router.get('/hr/departments', RH, (req, res) => {
    const csrf = req.session.csrf;
    const list = depts();
    const heads = emps("WHERE e.status = 'active'").map((e) => [e.id, nm(e)]);
    const rows = list.map((d) => ({ ...d, head: d.head_id ? empOf(d.head_id) : null }));
    const table = ui.table(
      [
        { label: tr('hr|Department'), render: (d) => `<b>${esc(deptName(d.name))}</b>` },
        { label: tr('hr|Head'), render: (d) => (d.head ? `<a href="/admin/hr/employees/${d.head.id}">${esc(nm(d.head))}</a>` : '—') },
        { label: tr('People'), num: true, render: (d) => `<a href="/admin/hr?dept=${d.id}">${d.n}</a>` },
        { label: '', render: (d) => `<details class="pop"><summary class="btn btn--ghost btn--xs">${esc(tr('Edit'))}</summary>${ui.form(`/admin/hr/departments/${d.id}`, csrf, `${ui.input('name', tr('Name'), deptName(d.name), { required: true })}${ui.select('head_id', tr('hr|Head'), heads, d.head_id, { blank: tr('hr|No one') })}${ui.input('sort', tr('hr|Order'), d.sort, { type: 'number' })}${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}${d.n ? '' : ui.form(`/admin/hr/departments/${d.id}/delete`, csrf, ui.btn(esc(tr('Delete')), { cls: 'btn--ghost btn--xs', attrs: { 'data-confirm': tr('Delete {name}?', { name: deptName(d.name) }) } }))}</details>` },
      ],
      rows, { empty: esc(tr('No departments yet.')) },
    );
    const add = ui.card(tr('Add a department'), ui.form('/admin/hr/departments', csrf, `<div class="fields">${ui.input('name', tr('Name'), '', { required: true, placeholder: tr('e.g. Security') })}</div>${ui.btn(esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }), {
      action: list.length ? '' : ui.form('/admin/hr/departments/defaults', csrf, ui.btn(esc(tr('Add the usual mall departments')), { cls: 'btn--ghost btn--sm' })),
    });
    h.page(req, res, { title: tr('hr|Departments'), crumbs: [['/admin/hr', tr('Employees')], [null, tr('hr|Departments')]], active: '/admin/hr', body: `<div class="grid grid--side">${ui.card(tn(list.length, '{n} department', '{n} departments'), table)}<div class="stack">${add}</div></div>` });
  });
  const deptNameIn = (req, old) => {
    const n = h.str(req.body.name, 80);
    return old && n === tx(old) ? old : n;
  };
  router.post('/hr/departments', RH, (req, res) => {
    const name = deptNameIn(req);
    if (!name) return h.back(req, res, '/admin/hr/departments', 'error', tr('Enter a name.'));
    if (db.get('SELECT id FROM departments WHERE name = ? COLLATE NOCASE', name)) return h.back(req, res, '/admin/hr/departments', 'error', tr('That department already exists.'));
    db.run('INSERT INTO departments (name, sort) VALUES (?, ?)', name, (db.value('SELECT COALESCE(MAX(sort), 0) FROM departments') || 0) + 1);
    h.log(req, 'Added a department', 'department', null, name);
    h.back(req, res, '/admin/hr/departments', 'ok', tr('Saved.'));
  });
  router.post('/hr/departments/defaults', RH, (req, res) => {
    DEFAULT_DEPTS.forEach((n, i) => db.run('INSERT OR IGNORE INTO departments (name, sort) VALUES (?, ?)', n, i + 1));
    h.back(req, res, '/admin/hr/departments', 'ok', tr('Saved.'));
  });
  router.post('/hr/departments/:id', RH, (req, res, next) => {
    const d = db.get('SELECT * FROM departments WHERE id = ?', req.params.id);
    if (!d) return next();
    const name = deptNameIn(req, d.name);
    if (!name) return h.back(req, res, '/admin/hr/departments', 'error', tr('Enter a name.'));
    if (db.get('SELECT id FROM departments WHERE name = ? COLLATE NOCASE AND id != ?', name, d.id)) return h.back(req, res, '/admin/hr/departments', 'error', tr('That department already exists.'));
    const head = h.int(req.body.head_id) && db.get('SELECT id FROM employees WHERE id = ?', h.int(req.body.head_id)) ? h.int(req.body.head_id) : null;
    db.run('UPDATE departments SET name = ?, head_id = ?, sort = ? WHERE id = ?', name, head, h.int(req.body.sort) || 0, d.id);
    h.back(req, res, '/admin/hr/departments', 'ok', tr('Saved.'));
  });
  router.post('/hr/departments/:id/delete', RH, (req, res, next) => {
    const d = db.get('SELECT * FROM departments WHERE id = ?', req.params.id);
    if (!d) return next();
    if (db.value('SELECT COUNT(*) FROM employees WHERE department_id = ?', d.id)) return h.back(req, res, '/admin/hr/departments', 'error', tr('Move its people to another department first.'));
    db.run('DELETE FROM departments WHERE id = ?', d.id);
    h.back(req, res, '/admin/hr/departments', 'ok', tr('Department deleted.'));
  });

  // ---------- leave ----------
  router.get('/hr/leave', RH, (req, res) => {
    const q = req.query;
    const csrf = req.session.csrf;
    const t = today();
    const tab = ['pending', 'approved', 'rejected', 'all'].includes(q.tab) ? q.tab : 'pending';
    const empId = h.int(q.employee);
    const where = [];
    const args = [];
    if (tab === 'rejected') where.push("l.status IN ('rejected','cancelled')");
    else if (tab !== 'all') { where.push('l.status = ?'); args.push(tab); }
    if (empId) { where.push('l.employee_id = ?'); args.push(empId); }
    const rows = db.all(`SELECT l.*, e.name, e.name_ar, e.code, u.name decider FROM leave_requests l JOIN employees e ON e.id = l.employee_id LEFT JOIN users u ON u.id = l.decided_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${tab === 'pending' ? 'l.start_date' : 'l.start_date DESC'} LIMIT 300`, ...args);
    const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM leave_requests GROUP BY status').map((r) => [r.status, r.n]));
    const base = empId ? `/admin/hr/leave?employee=${empId}&` : '/admin/hr/leave?';
    const tabNav = tabs([[`${base}tab=pending`, tr('To approve'), 'pending', counts.pending], [`${base}tab=approved`, tr('leave|Approved'), 'approved'], [`${base}tab=rejected`, tr('Declined or cancelled'), 'rejected'], [`${base}tab=all`, tr('All'), 'all']], tab);
    const table = ui.table(
      [
        { label: tr('hr|Person'), render: (l) => who(l, `<span class="ltr">${esc(l.code)}</span>`) },
        { label: tr('Type'), render: (l) => `<span class="badge badge--${LEAVE_TONE[l.type] || 'mute'}">${esc(lbl(LEAVE, l.type))}</span>` },
        { label: tr('hr|Dates'), render: (l) => `${ui.date(l.start_date)} – ${ui.date(l.end_date)}<small class="sub">${esc(tn(l.days, '{n} day', '{n} days'))}${l.reason ? ` · ${esc(tx(l.reason))}` : ''}</small>` },
        { label: tr('Status'), render: (l) => `${ui.badge(l.status === 'approved' ? 'active' : l.status === 'pending' ? 'pending' : 'void', lbl(LEAVE_STATUS, l.status))}${l.decider ? `<small class="sub">${esc(l.decider)}${l.decision_note ? ` · ${esc(tx(l.decision_note))}` : ''}</small>` : ''}` },
        { label: '', render: (l) => (l.status === 'pending'
          ? `<div class="row hr-acts">${ui.form(`/admin/hr/leave/${l.id}/approve`, csrf, ui.btn(esc(tr('Approve')), { cls: 'btn--primary btn--xs' }))}<details class="pop"><summary class="btn btn--ghost btn--xs">${esc(tr('hr|Decline'))}</summary>${ui.form(`/admin/hr/leave/${l.id}/reject`, csrf, `${ui.input('note', tr('Reason'), '', { placeholder: tr('e.g. Peak season, please choose other dates') })}${ui.btn(esc(tr('hr|Decline')), { cls: 'btn--danger btn--sm' })}`, { cls: 'stack' })}</details></div>`
          : l.status === 'approved' && l.end_date >= t ? ui.form(`/admin/hr/leave/${l.id}/cancel`, csrf, ui.btn(esc(tr('Cancel leave')), { cls: 'btn--ghost btn--xs', attrs: { 'data-confirm': tr('Cancel this leave?') } })) : '') },
      ],
      rows, { cls: 'hr-leave', empty: esc(tab === 'pending' ? tr('No leave waiting for approval.') : tr('No leave here.')) },
    );

    // who is off: one strip per person across the month
    const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : t.slice(0, 7);
    const { start, end, days } = monthBounds(month);
    const offRows = db.all("SELECT l.*, e.name, e.name_ar FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.status IN ('approved','pending') AND l.start_date <= ? AND l.end_date >= ? ORDER BY e.name, l.start_date", end, start);
    const people = [...new Map(offRows.map((r) => [r.employee_id, r])).values()];
    const dayCells = Array.from({ length: days }, (_, i) => {
      const d = `${month}-${String(i + 1).padStart(2, '0')}`;
      return { d, fri: new Date(ms(d)).getUTCDay() === 5, today: d === t };
    });
    const strip = people.length
      ? `<div class="offgrid" style="--days:${days}"><div class="offgrid__row offgrid__head"><span></span>${dayCells.map((c, i) => `<i class="${c.fri ? 'is-fri' : ''}${c.today ? ' is-today' : ''}">${i + 1}</i>`).join('')}</div>${people.map((p) => `<div class="offgrid__row"><a href="/admin/hr/employees/${p.employee_id}">${esc(nm(p))}</a>${dayCells.map((c) => {
        const l = offRows.find((r) => r.employee_id === p.employee_id && r.start_date <= c.d && r.end_date >= c.d);
        return `<i class="${c.fri ? 'is-fri' : ''}${l ? ` t-${LEAVE_TONE[l.type] || 'mute'}${l.status === 'pending' ? ' is-pending' : ''}` : ''}"${l ? ` title="${esc(`${nm(p)} · ${lbl(LEAVE, l.type)}${l.status === 'pending' ? ` · ${tr('leave|Pending')}` : ''}`)}"` : ''}></i>`;
      }).join('')}</div>`).join('')}</div><ul class="legend legend--row">${Object.keys(LEAVE).map((k) => `<li><i class="t-${LEAVE_TONE[k]}"></i><span>${esc(lbl(LEAVE, k))}</span></li>`).join('')}<li><i class="offgrid__fri"></i><span>${esc(tr('hr|Friday'))}</span></li></ul>`
      : `<p class="muted pad">${esc(tr('No one is off this month.'))}</p>`;
    const prev = M.addMonths(`${month}-01`, -1).slice(0, 7);
    const next = M.addMonths(`${month}-01`, 1).slice(0, 7);
    const monthNav = `<div class="row">${ui.btn(isAr() ? '→' : '←', { href: `/admin/hr/leave?tab=${tab}&month=${prev}${empId ? `&employee=${empId}` : ''}#off`, cls: 'btn--ghost btn--sm', attrs: { 'aria-label': tr('o|Previous month') } })}${ui.btn(isAr() ? '←' : '→', { href: `/admin/hr/leave?tab=${tab}&month=${next}${empId ? `&employee=${empId}` : ''}#off`, cls: 'btn--ghost btn--sm', attrs: { 'aria-label': tr('o|Next month') } })}</div>`;

    // balances
    const active = emps("WHERE e.status = 'active'");
    const balRows = active.map((e) => ({ e, b: balance(e) }));
    const balTable = ui.table(
      [
        { label: tr('hr|Person'), render: ({ e }) => `<a href="/admin/hr/employees/${e.id}">${esc(nm(e))}</a>` },
        { label: tr('hr|Entitled'), num: true, render: ({ b }) => b.entitled },
        { label: tr('hr|Taken'), num: true, render: ({ b }) => b.taken },
        { label: tr('leave|Pending'), num: true, render: ({ b }) => b.pending || '—' },
        { label: tr('hr|Remaining'), num: true, render: ({ b }) => `<b class="${b.remaining < 0 ? 'late' : ''}">${b.remaining}</b>${ui.meter(b.entitled ? Math.max(0, b.remaining) / b.entitled : 0, b.remaining < 3 ? 'amber' : 'sea')}` },
        { label: tr('Casual (of {n})', { n: CASUAL_MAX }), num: true, render: ({ b }) => `<span class="${b.casual > CASUAL_MAX ? 'late' : ''}">${b.casual}</span>` },
        { label: tr('hr|Sick'), num: true, render: ({ b }) => b.use.taken.sick || 0 },
      ],
      balRows, { empty: esc(tr('No employees yet.')) },
    );
    const newForm = ui.card(tr('New leave request'), active.length ? ui.form('/admin/hr/leave', csrf, `<div class="fields">
        ${ui.select('employee_id', tr('hr|Person'), active.map((e) => [e.id, nm(e)]), empId, { required: true, blank: tr('Choose…') })}
        ${ui.select('type', tr('Type'), labels(LEAVE), 'annual')}
        ${ui.input('start_date', tr('hr|From'), '', { type: 'date', required: true })}
        ${ui.input('end_date', tr('hr|To'), '', { type: 'date', required: true })}
        ${ui.input('days', tr('hr|Working days'), '', { type: 'number', min: '0.5', step: '0.5', hint: tr('Empty: counted for you, Fridays excluded. Use .5 for a half day.') })}
        ${ui.input('reason', tr('Reason'), '', { cls: 'span-all' })}
      </div><label class="check"><input type="checkbox" name="approve" value="1"> ${esc(tr('hr|Approve now'))}</label>${ui.btn(esc(tr('hr|Add request')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack', attrs: { id: 'new' } }) : `<p class="muted pad">${esc(tr('Add employees first.'))}</p>`);
    const filterEmp = empId ? `<p class="hint">${esc(tr('Showing one person.'))} <a href="/admin/hr/leave?tab=${tab}">${esc(tr('Show everyone'))}</a></p>` : '';
    const body = `${tabNav}${filterEmp}<div class="grid grid--side"><div class="stack">${ui.card(tn(rows.length, '{n} request', '{n} requests'), table)}${ui.card(tr('Who is off in {month}', { month: ui.monthYear(month) }), strip, { action: monthNav, cls: 'offcard', sub: '' }).replace('<section class="card offcard', '<section id="off" class="card offcard')}</div><div class="stack">${newForm}</div></div>
${ui.card(tr('Balances {year}', { year: year() }), balTable, { sub: esc(tr('Annual leave in working days. Casual leave counts within annual leave, up to {n} days a year.', { n: CASUAL_MAX })) })}`;
    h.page(req, res, { title: tr('nav|Leave'), active: '/admin/hr/leave', wide: true, body });
  });

  router.post('/hr/leave', RH, (req, res) => {
    const b = req.body;
    const e = db.get("SELECT * FROM employees WHERE id = ? AND status = 'active'", h.int(b.employee_id));
    const back = h.safeBack(req, '/admin/hr/leave');
    if (!e) return h.back(req, res, back, 'error', tr('Choose who the leave is for.'));
    if (!isDate(b.start_date) || !isDate(b.end_date) || b.end_date < b.start_date) return h.back(req, res, back, 'error', tr('Choose a start and an end date, in order.'));
    const type = LEAVE[b.type] ? b.type : 'annual';
    const counted = workDays(b.start_date, b.end_date);
    if (!counted) return h.back(req, res, back, 'error', tr('Those dates are all Fridays.'));
    let days = h.numv(b.days);
    days = days !== null && days > 0 ? Math.min(Math.max(0.5, Math.round(days * 2) / 2), counted) : counted;
    if (!days) return h.back(req, res, back, 'error', tr('Those dates are all Fridays.'));
    if (db.get("SELECT id FROM leave_requests WHERE employee_id = ? AND status IN ('approved','pending') AND start_date <= ? AND end_date >= ?", e.id, b.end_date, b.start_date)) return h.back(req, res, back, 'error', tr('That overlaps leave already booked for this person.'));
    const approve = b.approve ? 1 : 0;
    const id = Number(db.run('INSERT INTO leave_requests (employee_id, type, start_date, end_date, days, reason, status, decided_by, decided_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      e.id, type, b.start_date, b.end_date, days, h.str(b.reason, 300) || null, approve ? 'approved' : 'pending', approve ? req.user.id : null, approve ? M.now() : null, req.user.id, M.now()).lastInsertRowid);
    h.log(req, approve ? 'Approved leave' : 'Requested leave', 'leave', id, `${e.name} — leave: ${i18n.english(LEAVE[type])}, ${days} days`);
    let msg = approve ? tr('Leave approved.') : tr('Leave request added.');
    if (['annual', 'casual'].includes(type)) {
      const bal = balance(e);
      if (bal.remaining - (approve ? 0 : bal.pending) < 0) msg += ` ${tr('Note: this takes {name} past their annual balance.', { name: nm(e) })}`;
    }
    h.back(req, res, back.includes('/admin/hr/employees/') ? back : '/admin/hr/leave', 'ok', msg);
  });
  const decide = (status, action) => (req, res, next) => {
    const l = db.get('SELECT l.*, e.name FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.id = ?', req.params.id);
    if (!l) return next();
    const ok = status === 'cancelled' ? l.status === 'approved' || l.status === 'pending' : l.status === 'pending';
    if (!ok) return h.back(req, res, h.safeBack(req, '/admin/hr/leave'), 'error', tr('That request has already been decided.'));
    db.run('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?', status, req.user.id, M.now(), h.str(req.body.note, 300) || null, l.id);
    h.log(req, action, 'leave', l.id, `${l.name} — leave: ${i18n.english(LEAVE[l.type])}, ${l.days} days`);
    h.back(req, res, h.safeBack(req, '/admin/hr/leave'), 'ok', { approved: tr('Leave approved.'), rejected: tr('Leave declined.'), cancelled: tr('Leave cancelled.') }[status]);
  };
  router.post('/hr/leave/:id/approve', RH, decide('approved', 'Approved leave'));
  router.post('/hr/leave/:id/reject', RH, decide('rejected', 'Declined leave'));
  router.post('/hr/leave/:id/cancel', RH, decide('cancelled', 'Cancelled leave'));

  // ---------- payroll ----------
  const runOf = (id) => db.get('SELECT r.*, a.name approver FROM payroll_runs r LEFT JOIN users a ON a.id = r.approved_by WHERE r.id = ?', id);
  const linesOf = (runId) => db.all('SELECT l.*, e.name, e.name_ar, e.code, e.iban, e.bank_name, e.position, e.basic_salary emp_basic, e.allowances emp_allow, d.name dept FROM payroll_lines l JOIN employees e ON e.id = l.employee_id LEFT JOIN departments d ON d.id = e.department_id WHERE l.run_id = ? ORDER BY d.sort, e.name', runId);
  const totals = (lines) => lines.reduce((t, l) => {
    t.gross += gross(l); t.insE += l.insurance_employee; t.insR += l.insurance_employer; t.tax += l.tax; t.net += l.net; t.unpaid += unpaidOf(l); t.ded += l.deductions;
    return t;
  }, { gross: 0, insE: 0, insR: 0, tax: 0, net: 0, unpaid: 0, ded: 0 });
  const unpaidDaysIn = (empId, period) => {
    const { start, end } = monthBounds(period);
    return db.all("SELECT * FROM leave_requests WHERE employee_id = ? AND type = 'unpaid' AND status = 'approved' AND start_date <= ? AND end_date >= ?", empId, end, start)
      .reduce((s, r) => s + r2((r.days * overlapDays(r.start_date, r.end_date, start, end)) / (workDays(r.start_date, r.end_date) || 1)), 0);
  };
  const eligible = (period) => {
    const { start, end } = monthBounds(period);
    return db.all("SELECT * FROM employees WHERE hire_date <= ? AND (ended_at IS NULL OR ended_at >= ?) AND (status = 'active' OR ended_at IS NOT NULL)", end, start);
  };
  // (Re)calculate a draft run from today's employee records, keeping the amounts typed in.
  function calcRun(run, typed = {}) {
    const s = S();
    const existing = new Map(linesOf(run.id).map((l) => [l.employee_id, l]));
    const keep = new Set();
    for (const e of eligible(run.period)) {
      const old = existing.get(e.id) || {};
      const pick = (k, d) => (typed[`${k}_${e.id}`] !== undefined && typed[`${k}_${e.id}`] !== '' ? Math.max(0, h.numv(typed[`${k}_${e.id}`]) || 0) : old[k] ?? d);
      const unpaidDays = typed[`unpaid_days_${e.id}`] !== undefined ? Math.max(0, h.numv(typed[`unpaid_days_${e.id}`]) || 0) : old.unpaid_days ?? unpaidDaysIn(e.id, run.period);
      const l = payLine(e, run.period, s, { unpaidDays, overtime: pick('overtime', 0), bonus: pick('bonus', 0), deductions: pick('deductions', 0), tax: pick('tax', 0) });
      db.run(`INSERT INTO payroll_lines (run_id, employee_id, basic, allowances, overtime, bonus, deductions, unpaid_days, insurance_employee, insurance_employer, tax, net, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, employee_id) DO UPDATE SET basic = excluded.basic, allowances = excluded.allowances, overtime = excluded.overtime, bonus = excluded.bonus, deductions = excluded.deductions, unpaid_days = excluded.unpaid_days, insurance_employee = excluded.insurance_employee, insurance_employer = excluded.insurance_employer, tax = excluded.tax, net = excluded.net`,
      run.id, e.id, l.basic, l.allowances, l.overtime, l.bonus, l.deductions, l.unpaid_days, l.insurance_employee, l.insurance_employer, l.tax, l.net, old.notes || null);
      keep.add(e.id);
    }
    for (const id of existing.keys()) if (!keep.has(id)) db.run('DELETE FROM payroll_lines WHERE run_id = ? AND employee_id = ?', run.id, id);
  }

  router.get('/hr/payroll', RH, (req, res) => {
    const csrf = req.session.csrf;
    const runs = db.all('SELECT * FROM payroll_runs ORDER BY period DESC');
    const rows = runs.map((r) => ({ ...r, lines: linesOf(r.id) })).map((r) => ({ ...r, tot: totals(r.lines) }));
    const t = today().slice(0, 7);
    const next = runs.some((r) => r.period === t) ? M.addMonths(`${t}-01`, 1).slice(0, 7) : t;
    const last = rows.find((r) => r.status !== 'draft');
    const kpis = last ? [
      ui.kpi({ label: tr('hr|Last payroll'), value: esc(ui.monthYear(last.period)), sub: esc(lbl(RUN_STATUS, last.status)), href: `/admin/hr/payroll/${last.id}` }),
      ui.kpi({ label: tr('hr|Net paid'), value: ui.money(last.tot.net, { compact: true }), sub: esc(tn(last.lines.length, '{n} person', '{n} people')) }),
      ui.kpi({ label: tr('hr|Social insurance'), value: ui.money(last.tot.insE + last.tot.insR, { compact: true }), sub: esc(tr('Employee and employer shares')) }),
      ui.kpi({ label: tr('hr|Cost to the mall'), value: ui.money(last.tot.gross + last.tot.insR, { compact: true }), sub: esc(tr('Gross pay plus employer insurance')) }),
    ].join('') : '';
    const table = ui.table(
      [
        { label: tr('hr|Month'), render: (r) => `<b>${esc(ui.monthYear(r.period))}</b>` },
        { label: tr('Status'), render: (r) => ui.badge(r.status === 'paid' ? 'paid' : r.status === 'approved' ? 'approved' : 'draft', lbl(RUN_STATUS, r.status)) },
        { label: tr('People'), num: true, render: (r) => r.lines.length },
        { label: tr('hr|Gross'), num: true, render: (r) => money(r.tot.gross) },
        { label: tr('hr|Net'), num: true, render: (r) => `<b>${money(r.tot.net)}</b>` },
        { label: tr('hr|Cost to the mall'), num: true, render: (r) => money(r.tot.gross + r.tot.insR) },
        { label: tr('hr|Paid on'), render: (r) => (r.paid_at ? ui.date(r.paid_at) : '—') },
      ],
      rows, { empty: esc(tr('No payroll yet. Start with this month.')), href: (r) => `/admin/hr/payroll/${r.id}` },
    );
    const create = ui.card(tr('Run payroll'), ui.form('/admin/hr/payroll', csrf, `<div class="fields">${ui.input('period', tr('hr|Month'), next, { type: 'month', required: true })}</div><p class="muted small">${esc(tr('A line is made for everyone employed during the month, from their current pay. You can adjust overtime, bonuses, deductions and tax before approving.'))}</p>${ui.btn(esc(tr('Create payroll')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }));
    const s = S();
    const rules = ui.card(tr('Rates in use'), `<dl class="dl">
      <div><dt>${esc(tr('hr|Employee share'))}</dt><dd>${esc(s.si_employee_pct)}%</dd></div>
      <div><dt>${esc(tr('hr|Employer share'))}</dt><dd>${esc(s.si_employer_pct)}%</dd></div>
      <div><dt>${esc(tr('hr|Insured wage'))}</dt><dd>${ui.money(Number(s.si_min_wage))} – ${ui.money(Number(s.si_max_wage))}</dd></div>
      <div><dt>${esc(tr('hr|Working days a month'))}</dt><dd>${esc(s.work_days_month)}</dd></div></dl>${h.can(req, 'admin') ? `<p class="small"><a href="/admin/settings#people">${esc(tr('Change in Settings'))}</a></p>` : ''}`);
    h.page(req, res, { title: tr('Payroll'), active: '/admin/hr/payroll', wide: true, body: `${kpis ? `<div class="kpis kpis--4">${kpis}</div>` : ''}<div class="grid grid--side">${ui.card(tn(rows.length, '{n} payroll', '{n} payrolls'), table)}<div class="stack">${create}${rules}</div></div>` });
  });

  router.post('/hr/payroll', RH, (req, res) => {
    const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.body.period || '') ? req.body.period : null;
    if (!period) return h.back(req, res, '/admin/hr/payroll', 'error', tr('Choose a month.'));
    const existing = db.get('SELECT id FROM payroll_runs WHERE period = ?', period);
    if (existing) return h.back(req, res, `/admin/hr/payroll/${existing.id}`, 'error', tr('{month} already has a payroll.', { month: ui.monthYear(period) }));
    if (!eligible(period).length) return h.back(req, res, '/admin/hr/payroll', 'error', tr('No one was employed in {month}.', { month: ui.monthYear(period) }));
    const id = db.tx(() => {
      const r = db.run("INSERT INTO payroll_runs (period, status, created_by, created_at) VALUES (?, 'draft', ?, ?)", period, req.user.id, M.now());
      const run = runOf(Number(r.lastInsertRowid));
      calcRun(run);
      return run.id;
    });
    h.log(req, 'Created a payroll', 'payroll', id, period);
    h.back(req, res, `/admin/hr/payroll/${id}`, 'ok', tr('Payroll for {month} is ready to review.', { month: ui.monthYear(period) }));
  });

  router.get('/hr/payroll/:id', RH, (req, res, next) => {
    const run = runOf(req.params.id);
    if (!run) return next();
    const csrf = req.session.csrf;
    const s = S();
    const lines = linesOf(run.id);
    const tot = totals(lines);
    const draft = run.status === 'draft';
    const cell = (l, k, v, step = '0.01') => (draft ? `<input class="cellin cellin--pay" type="number" min="0" step="${step}" name="${k}_${l.employee_id}" value="${v || ''}" placeholder="0" data-pay="${k}">` : money(v));
    const kpis = [
      ui.kpi({ label: tr('hr|Gross pay'), value: ui.money(tot.gross, { compact: true }), sub: esc(tn(lines.length, '{n} person', '{n} people')) }),
      ui.kpi({ label: tr('hr|Social insurance'), value: ui.money(tot.insE + tot.insR, { compact: true }), sub: esc(tr('{a} employees · {b} the mall', { a: ui.money(tot.insE, { compact: true }), b: ui.money(tot.insR, { compact: true }) })) }),
      ui.kpi({ label: tr('hr|Income tax'), value: ui.money(tot.tax, { compact: true }) }),
      ui.kpi({ label: tr('Net to pay'), value: ui.money(tot.net, { compact: true }) }),
      ui.kpi({ label: tr('hr|Cost to the mall'), value: ui.money(tot.gross + tot.insR, { compact: true }), sub: esc(tr('Gross pay plus employer insurance')) }),
    ].join('');
    const rows = lines.map((l) => {
      const daily = r2((Number(l.emp_basic) + Number(l.emp_allow)) / (Number(s.work_days_month) || 26));
      return `<tr data-payrow data-basic="${l.basic}" data-allow="${l.allowances}" data-ins="${l.insurance_employee}" data-daily="${daily}">
        <td><a href="/admin/hr/employees/${l.employee_id}"><b>${esc(nm(l))}</b></a><small class="sub">${esc(tx(l.position) || '')}</small></td>
        <td class="num">${money(l.basic + l.allowances)}<small class="sub">${esc(tr('{a} + {b} allowances', { a: money(l.basic), b: money(l.allowances) }))}</small></td>
        <td class="num">${cell(l, 'overtime', l.overtime)}</td><td class="num">${cell(l, 'bonus', l.bonus)}</td>
        <td class="num">${draft ? `<input class="cellin cellin--sm" type="number" min="0" step="0.5" name="unpaid_days_${l.employee_id}" value="${l.unpaid_days || ''}" placeholder="0">` : l.unpaid_days || '—'}<small class="sub">${unpaidOf(l) ? `−${money(unpaidOf(l))}` : ''}</small></td>
        <td class="num">${cell(l, 'deductions', l.deductions)}</td>
        <td class="num">${money(l.insurance_employee)}</td>
        <td class="num">${cell(l, 'tax', l.tax)}</td>
        <td class="num"><b data-net>${money(l.net)}</b></td>
        <td class="num muted">${money(l.insurance_employer)}</td>
        <td><a class="btn btn--ghost btn--xs" href="/admin/hr/payroll/${run.id}/slip/${l.employee_id}">${esc(tr('hr|Payslip'))}</a></td></tr>`;
    }).join('');
    const grid = `<div class="tablewrap"><table class="table table--fin hr-pay"><thead><tr><th>${esc(tr('hr|Person'))}</th><th class="num">${esc(tr('hr|Salary'))}</th><th class="num">${esc(tr('hr|Overtime'))}</th><th class="num">${esc(tr('hr|Bonus'))}</th><th class="num">${esc(tr('hr|Unpaid days'))}</th><th class="num">${esc(tr('hr|Deductions'))}</th><th class="num">${esc(tr('Insurance (employee)'))}</th><th class="num">${esc(tr('hr|Income tax'))}</th><th class="num">${esc(tr('hr|Net'))}</th><th class="num">${esc(tr('Insurance (employer)'))}</th><th></th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td>${esc(tr('Total'))}</td><td class="num">${money(lines.reduce((a, l) => a + l.basic + l.allowances, 0))}</td><td class="num">${money(lines.reduce((a, l) => a + l.overtime, 0))}</td><td class="num">${money(lines.reduce((a, l) => a + l.bonus, 0))}</td><td class="num">${tot.unpaid ? `−${money(tot.unpaid)}` : '—'}</td><td class="num">${money(tot.ded)}</td><td class="num">${money(tot.insE)}</td><td class="num">${money(tot.tax)}</td><td class="num"><b>${money(tot.net)}</b></td><td class="num">${money(tot.insR)}</td><td></td></tr></tfoot></table></div>`;
    const gridCard = draft
      ? ui.form(`/admin/hr/payroll/${run.id}`, csrf, `${ui.card(tr('Payroll lines'), `${grid}<p class="muted small hr-taxnote">${esc(tr('Income tax is entered per person: work it out with the brackets in force this year (they change by law). Social insurance is calculated from each insured wage at {a}% and {b}%.', { a: s.si_employee_pct, b: s.si_employer_pct }))}</p>`, { action: ui.btn(esc(tr('Save and recalculate')), { cls: 'btn--primary btn--sm' }) })}`, { attrs: { 'data-payroll': '' } })
      : ui.card(tr('Payroll lines'), grid);
    const acts = [];
    if (draft) acts.push(ui.form(`/admin/hr/payroll/${run.id}/approve`, csrf, ui.btn(esc(tr('hr|Approve payroll')), { cls: 'btn--primary', attrs: { 'data-confirm': tr('Approve the {month} payroll? It is locked once approved.', { month: ui.monthYear(run.period) }) } })));
    if (run.status === 'approved') acts.push(`<details class="pop"><summary class="btn btn--primary">${esc(tr('hr|Mark as paid'))}</summary>${ui.form(`/admin/hr/payroll/${run.id}/paid`, csrf, `${ui.input('paid_at', tr('hr|Paid on'), today(), { type: 'date', required: true })}${ui.btn(esc(tr('hr|Mark as paid')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>`);
    if (run.status === 'approved' && h.can(req, 'admin')) acts.push(ui.form(`/admin/hr/payroll/${run.id}/reopen`, csrf, ui.btn(esc(tr('hr|Reopen')), { cls: 'btn--ghost' })));
    const exports = `${ui.btn(esc(tr('Bank transfer file')), { href: `/admin/hr/payroll/${run.id}/bank.csv`, cls: 'btn--ghost btn--sm', ic: 'dl' })}${ui.btn(esc(tr('Payroll sheet')), { href: `/admin/hr/payroll/${run.id}/payroll.csv`, cls: 'btn--ghost btn--sm', ic: 'dl' })}`;
    const info = `<p class="hint">${esc(run.status === 'draft' ? tr('Draft: amounts follow the employee records until you approve.') : run.status === 'approved' ? tr('Approved by {name} on {date}. Locked.', { name: run.approver || '—', date: ui.date(run.approved_at) }) : tr('Paid on {date}.', { date: ui.date(run.paid_at) }))}</p>`;
    const del = draft ? `<details class="danger"><summary>${esc(tr('Delete this draft'))}</summary>${ui.form(`/admin/hr/payroll/${run.id}/delete`, csrf, ui.btn(esc(tr('Delete')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('Delete the {month} draft?', { month: ui.monthYear(run.period) }) } }))}</details>` : '';
    h.page(req, res, {
      title: tr('Payroll {month}', { month: ui.monthYear(run.period) }), crumbs: [['/admin/hr/payroll', tr('Payroll')], [null, ui.monthYear(run.period)]], active: '/admin/hr/payroll', wide: true,
      body: `<div class="kpis kpis--5">${kpis}</div>${info}${gridCard}<div class="row hr-exports">${exports}</div>${del}`,
      actions: `${ui.badge(run.status === 'paid' ? 'paid' : run.status === 'approved' ? 'approved' : 'draft', lbl(RUN_STATUS, run.status))}${acts.join('')}`,
    });
  });

  const runGuard = (want) => (req, res, next) => {
    const run = runOf(req.params.id);
    if (!run) return next();
    if (!want.includes(run.status)) return h.back(req, res, `/admin/hr/payroll/${run.id}`, 'error', tr('This payroll is locked.'));
    req.run = run;
    return next();
  };
  router.post('/hr/payroll/:id', RH, runGuard(['draft']), (req, res) => {
    db.tx(() => calcRun(req.run, req.body));
    h.log(req, 'Edited a payroll', 'payroll', req.run.id, req.run.period);
    h.back(req, res, `/admin/hr/payroll/${req.run.id}`, 'ok', tr('Saved and recalculated.'));
  });
  router.post('/hr/payroll/:id/approve', RH, runGuard(['draft']), (req, res) => {
    db.tx(() => calcRun(req.run));
    db.run("UPDATE payroll_runs SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", req.user.id, M.now(), req.run.id);
    h.log(req, 'Approved a payroll', 'payroll', req.run.id, req.run.period);
    h.back(req, res, `/admin/hr/payroll/${req.run.id}`, 'ok', tr('Payroll approved and locked.'));
  });
  router.post('/hr/payroll/:id/paid', RH, runGuard(['approved']), (req, res) => {
    db.run("UPDATE payroll_runs SET status = 'paid', paid_at = ? WHERE id = ?", isDate(req.body.paid_at) ? req.body.paid_at : today(), req.run.id);
    h.log(req, 'Paid a payroll', 'payroll', req.run.id, req.run.period);
    h.back(req, res, `/admin/hr/payroll/${req.run.id}`, 'ok', tr('Marked as paid.'));
  });
  router.post('/hr/payroll/:id/reopen', RH, h.R('admin'), runGuard(['approved']), (req, res) => {
    db.run("UPDATE payroll_runs SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = ?", req.run.id);
    h.log(req, 'Reopened a payroll', 'payroll', req.run.id, req.run.period);
    h.back(req, res, `/admin/hr/payroll/${req.run.id}`, 'ok', tr('Payroll reopened as a draft.'));
  });
  router.post('/hr/payroll/:id/delete', RH, runGuard(['draft']), (req, res) => {
    db.run('DELETE FROM payroll_runs WHERE id = ?', req.run.id);
    h.log(req, 'Deleted a payroll draft', 'payroll', null, req.run.period);
    h.back(req, res, '/admin/hr/payroll', 'ok', tr('Draft deleted.'));
  });

  // exports: the bank transfer file and the full sheet
  const exportRun = (bank) => (req, res, next) => {
    const run = runOf(req.params.id);
    if (!run) return next();
    const lines = linesOf(run.id);
    const cols = bank
      ? [['code', tr('hr|Employee code')], ['name', tr('Full name (English)')], ['bank_name', tr('hr|Bank')], ['iban', tr('hr|IBAN')], ['net', tr('hr|Net')]]
      : [['code', tr('hr|Employee code')], ['name', tr('Full name (English)')], ['name_ar', tr('Full name (Arabic)')], [(l) => deptName(l.dept), tr('hr|Department')], ['basic', tr('hr|Basic')], ['allowances', tr('hr|Allowances')], ['overtime', tr('hr|Overtime')], ['bonus', tr('hr|Bonus')], ['unpaid_days', tr('hr|Unpaid days')], [(l) => unpaidOf(l), tr('hr|Unpaid leave')], ['deductions', tr('hr|Deductions')], ['insurance_employee', tr('Insurance (employee)')], ['tax', tr('hr|Income tax')], ['net', tr('hr|Net')], ['insurance_employer', tr('Insurance (employer)')]];
    h.log(req, 'Exported', 'export', null, bank ? 'Bank transfer file' : 'Payroll sheet');
    res.set('Content-Disposition', `attachment; filename="${bank ? 'bank-transfer' : 'payroll'}-${run.period}.csv"`).type('text/csv; charset=utf-8').send(csv(lines, cols));
  };
  router.get('/hr/payroll/:id/bank.csv', RH, exportRun(true));
  router.get('/hr/payroll/:id/payroll.csv', RH, exportRun(false));

  // the payslip: A4, in the reader's language or ?doc=ar|en
  router.get('/hr/payroll/:id/slip/:employeeId', RH, (req, res, next) => {
    const run = runOf(req.params.id);
    const l = run && linesOf(run.id).find((x) => String(x.employee_id) === String(req.params.employeeId));
    if (!l) return next();
    const e = empOf(l.employee_id);
    const lang = ['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en';
    const path = `/admin/hr/payroll/${run.id}/slip/${e.id}`;
    const html = i18n.run(lang, () => {
      const s = S();
      const earn = [[tr('hr|Basic salary'), l.basic], [tr('hr|Allowances'), l.allowances], l.overtime ? [tr('hr|Overtime'), l.overtime] : null, l.bonus ? [tr('hr|Bonus'), l.bonus] : null].filter(Boolean);
      const ded = [unpaidOf(l) ? [tr('Unpaid leave ({n} days)', { n: l.unpaid_days }), unpaidOf(l)] : null, [tr('Social insurance ({pct}%)', { pct: s.si_employee_pct }), l.insurance_employee], l.tax ? [tr('hr|Income tax'), l.tax] : null, l.deductions ? [tr('Other deductions'), l.deductions] : null].filter(Boolean);
      const rowsOf = (list) => list.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${money(v)}</td></tr>`).join('');
      const totalDed = ded.reduce((a, [, v]) => a + v, 0);
      const name = lang === 'ar' && e.name_ar ? e.name_ar : e.name;
      const sw = lang === 'ar' ? `<a class="langbtn" href="${path}?doc=en" lang="en">${ui.icon('globe')}<span>English</span></a>` : `<a class="langbtn" href="${path}?doc=ar" lang="ar">${ui.icon('globe')}<span>العربية</span></a>`;
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${esc(tr('Print or save as PDF'))}</span></button><a class="btn btn--ghost" href="/admin/hr/payroll/${run.id}">${esc(tr('Back'))}</a>${sw}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${esc(tr('hr|Payslip'))}</p><p class="doc__ref">${esc(ui.monthYear(run.period))}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${esc(tr('Employee'))}</p><h1>${esc(name)}</h1><p>${esc(tx(e.position) || '')}${e.dept ? ` · ${esc(deptName(e.dept))}` : ''}</p></section>
  <table class="doc__t doc__t--terms"><tbody>
    <tr><th>${esc(tr('hr|Employee code'))}</th><td><bdi>${esc(e.code)}</bdi></td></tr>
    <tr><th>${esc(tr('hr|Hire date'))}</th><td>${ui.date(e.hire_date)}</td></tr>
    ${e.insurance_no ? `<tr><th>${esc(tr('hr|Social insurance number'))}</th><td><bdi>${esc(e.insurance_no)}</bdi></td></tr>` : ''}
    ${e.iban ? `<tr><th>${esc(tr('hr|Paid to'))}</th><td>${esc(e.bank_name || '')} · <bdi>${esc(e.iban)}</bdi></td></tr>` : ''}
    <tr><th>${esc(tr('hr|Days employed'))}</th><td>${esc(tr('{a} of {b}', { a: payLine(e, run.period, s).worked, b: monthBounds(run.period).days }))}</td></tr>
  </tbody></table>
  <div class="slip">
    <div><h2>${esc(tr('hr|Earnings'))}</h2><table class="doc__t"><tbody>${rowsOf(earn)}</tbody><tfoot><tr><td>${esc(tr('hr|Gross pay'))}</td><td class="num">${money(gross(l))}</td></tr></tfoot></table></div>
    <div><h2>${esc(tr('hr|Deductions'))}</h2><table class="doc__t"><tbody>${rowsOf(ded)}</tbody><tfoot><tr><td>${esc(tr('hr|Total deductions'))}</td><td class="num">${money(totalDed)}</td></tr></tfoot></table></div>
  </div>
  <p class="slip__net"><span>${esc(tr('hr|Net pay'))}</span><b>${ui.money(l.net)}</b></p>
  <p class="doc__small">${esc(tr('Employer social insurance paid on your behalf: {amount}. Amounts in {cur}.', { amount: ui.money(l.insurance_employer), cur: ui.curLabel() }))}${run.status === 'draft' ? ` ${esc(tr('Draft: not yet approved.'))}` : ''}</p>
  <div class="doc__sign"><div><span></span><p>${esc(tr('For {company}', { company: tx(s.legal_name) }))}</p></div><div><span></span><p>${esc(tr('Received by {name}', { name }))}</p></div></div>
  <p class="doc__foot">${esc(tx(s.legal_name))} · ${esc(tx(s.address))}</p>
</main>`;
      return ui.bare({ title: tr('Payslip {month}', { month: `${ui.monthYear(run.period)} · ${name}` }), body, cls: 'print' });
    });
    res.type('html').send(html);
  });

  function csv(rows, cols) {
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
    };
    return `﻿${[cols.map(([, l]) => cell(l)).join(','), ...rows.map((r) => cols.map(([k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\r\n')}\r\n`;
  }
};

module.exports.workDays = workDays;
module.exports.entitlement = entitlement;
module.exports.insuredWage = insuredWage;
module.exports.payLine = payLine;
module.exports.yearsBetween = yearsBetween;
module.exports.DEFAULT_DEPTS = DEFAULT_DEPTS;
module.exports.LEAVE = LEAVE;
