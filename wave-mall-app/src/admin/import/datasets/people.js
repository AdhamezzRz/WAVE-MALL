'use strict';

// People: salary advances still being repaid on the start day, leave already taken, attendance
// shifts and who works which shift. Departments and employees are in core.js. Never PINs, phones or
// passwords: those are set in the office.

const i18n = require('../../i18n');
const HR = require('../../routes/hr');
const ATT = require('../../routes/attendance');
const P = require('../parse');

const L = (en, ar) => ({ en, ar });
const lab = (key) => ({ en: i18n.english(key), ar: typeof i18n.AR[key] === 'string' ? i18n.AR[key] : i18n.english(key) });
const opts = (map) => Object.entries(map).map(([k, key]) => [k, lab(key)]);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// the days of a shift: codes in the week's order; names in English or Arabic, ranges, or digits 1–7
const DAYS = [
  ['mon', 1, ['mon', 'monday', 'الاثنين', 'اثنين', 'الإثنين']], ['tue', 2, ['tue', 'tues', 'tuesday', 'الثلاثاء', 'ثلاثاء']],
  ['wed', 3, ['wed', 'wednesday', 'الاربعاء', 'الأربعاء', 'اربعاء', 'أربعاء']], ['thu', 4, ['thu', 'thur', 'thurs', 'thursday', 'الخميس', 'خميس']],
  ['fri', 5, ['fri', 'friday', 'الجمعة', 'الجمعه', 'جمعة', 'جمعه']], ['sat', 6, ['sat', 'saturday', 'السبت', 'سبت']],
  ['sun', 7, ['sun', 'sunday', 'الاحد', 'الأحد', 'احد', 'أحد']],
];
const EVERY = new Set(['every day', 'everyday', 'daily', 'all', 'all days', 'كل يوم', 'كل الايام', 'كل الأيام', 'يوميا', 'يوميًا', 'طوال الاسبوع', 'طوال الأسبوع']);
const dayOf = (s) => { const t = P.norm(s); const d = DAYS.find(([, , names]) => names.some((n) => P.norm(n) === t)); return d || null; };
function readDays(list) {
  const set = new Set();
  for (const raw of [].concat(list)) {
    const s = String(raw).trim();
    if (!s) continue;
    if (EVERY.has(P.norm(s)) || EVERY.has(s)) { DAYS.forEach((d) => set.add(d[1])); continue; }
    if (/^[1-7]+$/.test(s)) { for (const c of s) set.add(Number(c)); continue; }
    const range = s.split(/\s*(?:-|–|—|\bto\b|إلى|الى)\s*/);
    if (range.length === 2 && dayOf(range[0]) && dayOf(range[1])) {
      let a = dayOf(range[0])[1];
      const b = dayOf(range[1])[1];
      for (let i = 0; i < 7; i++) { set.add(a); if (a === b) break; a = a === 7 ? 1 : a + 1; }
      continue;
    }
    const d = dayOf(s);
    if (!d) return { error: 'imp2|“{day}” is not a day of the week.', params: { day: s } };
    set.add(d[1]);
  }
  if (!set.size) return { error: 'imp2|Give at least one day.' };
  return { value: DAYS.filter(([, n]) => set.has(n)).map(([c]) => c) };
}
const daysDigits = (codes) => DAYS.filter(([c]) => [].concat(codes || []).includes(c)).map(([, n]) => n).join('');
const daysCodes = (digits) => DAYS.filter(([, n]) => String(digits || '').includes(String(n))).map(([c]) => c);

module.exports = function peopleDatasets(imports, h) {
  const { M, db: DB } = h;
  const now = () => M.now();
  const today = () => M.today();
  const hrOnly = (req) => h.canHR(req);
  const empChoices = (db) => db.all("SELECT id, code, name, name_ar FROM employees WHERE status = 'active' ORDER BY code").map((e) => ({ id: e.id, name: `${e.code} · ${e.name}`, alt: [e.code, e.name, e.name_ar].filter(Boolean) }));
  const empLabel = (e) => `${e.code} · ${e.name}`;
  const recalcDrafts = (db) => { if (h.hrRecalc) for (const run of db.all("SELECT * FROM payroll_runs WHERE status = 'draft'")) h.hrRecalc(run); };
  const Lg = () => (h.ledger && typeof h.ledger.post === 'function' ? h.ledger : null);
  const ADV_METHODS = [['cash', lab('pay|Cash')], ['transfer', lab('pay|Bank transfer')]];

  // =====================================================================================
  // Salary advances still being repaid on the start day
  // =====================================================================================
  const repaidBefore = (db, id) => r2(db.value("SELECT COALESCE(SUM(amount), 0) FROM hr_advance_repayments WHERE advance_id = ? AND source = 'opening'", id));
  imports.register({
    key: 'salary_advances',
    module: '/admin/hr',
    pages: ['/admin/hr/advances'],
    area: 'people',
    order: 30,
    depends: ['employees'],
    icon: 'wallet',
    table: 'hr_advances',
    title: L('Salary advances (start day)', 'السلف (يوم البدء)'),
    summary: L('Loans against salary still being repaid on the day you start.', 'سلف على الراتب ما زالت تُسدد يوم البدء.'),
    notes: L('What is left to repay is posted to Other receivables against Opening balances (3900): leave staff advances out of the opening trial balance. From the first deduction month the payroll takes the monthly installment until it is repaid.', 'المتبقي للسداد يُقيد في الذمم المدينة الأخرى مقابل الأرصدة الافتتاحية (٣٩٠٠): لا تضع سلف العاملين في ميزان المراجعة الافتتاحي. من شهر أول خصم يأخذ كشف الرواتب القسط الشهري حتى السداد.'),
    canView: hrOnly,
    allowed: hrOnly,
    keys: ['ref'],
    count: (db) => db.value("SELECT COUNT(*) FROM hr_advances WHERE status != 'cancelled'"),
    columns: [
      { key: 'ref', label: L('Advance number', 'رقم السلفة'), type: 'code', max: 20, width: 14, keepOnUpdate: true, help: L('Leave empty for new advances: the office numbers them (AD-…).', 'اتركه فارغًا للسلف الجديدة: يرقمها النظام تلقائيًا.') },
      { key: 'employee', label: L('Employee', 'الموظف'), type: 'ref', required: true, width: 28, ref: { list: empChoices, dataset: 'employees', what: L('Employees', 'الموظفين') }, example: 'EMP-0007 · Mahmoud Adel', aliases: ['employee code', 'emp code', 'name', 'كود الموظف', 'اسم الموظف'] },
      { key: 'amount', label: L('Amount given', 'المبلغ الممنوح'), type: 'money', required: true, width: 15, keepOnUpdate: true, example: 24000, aliases: ['amount', 'advance', 'loan', 'المبلغ', 'قيمه السلفه'] },
      { key: 'issued_on', label: L('Given on', 'تاريخ الصرف'), type: 'date', required: true, width: 14, keepOnUpdate: true, example: '2025-10-05' },
      { key: 'installments', label: L('Repaid over (months)', 'مدة السداد (بالشهور)'), type: 'int', required: true, min: 1, maxValue: 36, width: 16, keepOnUpdate: true, example: 8, help: L('The monthly installment is the amount divided by this.', 'القسط الشهري هو المبلغ مقسومًا على هذا العدد.') },
      { key: 'repaid', label: L('Repaid before the start day', 'المسدد قبل يوم البدء'), type: 'money', width: 18, keepOnUpdate: true, example: 6000, help: L('What was already taken off their pay or paid back.', 'ما خُصم من رواتبه أو رُدّ بالفعل.') },
      { key: 'start_period', label: L('Next deduction month', 'شهر الخصم التالي'), type: 'month', required: true, width: 16, keepOnUpdate: true, example: '2026-01', help: L('The first payroll in the office that takes an installment.', 'أول كشف رواتب في النظام يُخصم منه القسط.') },
      { key: 'method', label: L('Paid out by', 'طريقة الصرف'), type: 'enum', enum: ADV_METHODS, width: 14, keepOnUpdate: true, example: 'cash' },
      { key: 'reason', label: L('Reason', 'السبب'), type: 'text', max: 200, width: 26, example: 'Family occasion' },
    ],
    find: (db, v) => {
      const a = db.get('SELECT id FROM hr_advances WHERE ref = ? COLLATE NOCASE', v.ref);
      return a ? a.id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      if (ctx.id) {
        const a = db.get('SELECT employee_id FROM hr_advances WHERE id = ?', ctx.id);
        if (typeof row.employee === 'number' && row.employee !== a.employee_id) ctx.error('employee', 'imp2|The employee of an advance cannot be changed.');
        return;
      }
      const amount = r2(row.amount);
      const repaid = r2(row.repaid);
      if (!(amount > 0)) ctx.error('amount', 'imp2|Give the amount given.');
      if (repaid > amount + 0.005) ctx.error('repaid', 'imp2|More was repaid than was given.');
      else if (amount > 0 && repaid >= amount - 0.005) ctx.warn('repaid', 'imp2|Fully repaid: it is saved as repaid.');
      if (row.issued_on && row.issued_on > today()) ctx.error('issued_on', 'imp2|An advance on the start day cannot be dated in the future.');
      if (row.start_period && row.issued_on && row.start_period < row.issued_on.slice(0, 7)) ctx.error('start_period', 'imp2|The next deduction cannot be before the advance was given.');
      if (row.ref && db.get('SELECT id FROM hr_advances WHERE ref = ? COLLATE NOCASE', row.ref)) ctx.error('ref', 'imp|This code is already used.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      if (ctx.id) {
        db.run('UPDATE hr_advances SET reason = ? WHERE id = ?', row.reason || null, ctx.id);
        return ctx.id;
      }
      const e = db.get('SELECT * FROM employees WHERE id = ?', row.employee);
      const amount = r2(row.amount);
      const n = Math.min(36, Math.max(1, Number(row.installments) || 1));
      const ref = row.ref || db.nextRef('hr_advances', 'AD', 4, true);
      const id = Number(db.run('INSERT INTO hr_advances (ref, employee_id, amount, installments, monthly, start_period, issued_on, method, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ref, e.id, amount, n, r2(Math.ceil((amount / n) * 100) / 100), row.start_period, row.issued_on, row.method || 'cash', row.reason || null, ctx.user ? ctx.user.id : null, now()).lastInsertRowid);
      const repaid = r2(Math.min(r2(row.repaid), amount));
      if (repaid > 0) db.run("INSERT INTO hr_advance_repayments (advance_id, amount, source, paid_on, user_id, created_at) VALUES (?, ?, 'opening', ?, ?, ?)", id, repaid, today(), ctx.user ? ctx.user.id : null, now());
      // what is left: a receivable from staff brought forward (no cash moves now)
      const left = r2(amount - repaid);
      const L1 = Lg();
      if (L1 && left > 0) L1.post({ date: L1.firstOpen(today()), memo: `Opening balance · ${ref} · ${e.name}`, kind: 'opening', source: `advance:${id}`, lines: [{ account: 'other_receivables', debit: left }, { account: 'opening_equity', credit: left }], user: ctx.user });
      if (h.advances && h.advances.refresh) h.advances.refresh(db.get('SELECT * FROM hr_advances WHERE id = ?', id));
      ctx.log('Gave a salary advance', 'employee', e.id, `${e.name} · ${amount} over ${n} months`);
      return id;
    },
    after: (db) => recalcDrafts(db),
    export: (db) => db.all("SELECT a.*, e.code, e.name FROM hr_advances a JOIN employees e ON e.id = a.employee_id WHERE a.status != 'cancelled' AND e.status = 'active' ORDER BY a.issued_on, a.id").map((a) => ({
      $id: a.id, ref: a.ref, employee: empLabel(a), amount: a.amount, issued_on: a.issued_on, installments: a.installments, repaid: repaidBefore(db, a.id) || null,
      start_period: a.start_period, method: a.method, reason: a.reason,
    })),
    uses(db, id) {
      const n = db.value("SELECT COUNT(*) FROM hr_advance_repayments WHERE advance_id = ? AND (source = 'cash' OR run_id IN (SELECT id FROM payroll_runs WHERE status IN ('approved','paid')))", id);
      const out = n ? [{ n, what: L('repayments', 'أقساط مسددة') }] : [];
      const L1 = Lg();
      if (L1 && db.all("SELECT date FROM acc_entries WHERE source_base = ? OR source = ?", `advance:${id}`, `advance:${id}`).some((e) => L1.isLocked(e.date))) out.push({ n: 1, what: L('closed accounting month', 'شهر محاسبي مغلق') });
      return out;
    },
    remove(db, id) {
      for (const e of db.all('SELECT id FROM acc_entries WHERE source_base = ? OR source = ?', `advance:${id}`, `advance:${id}`)) {
        db.run('UPDATE acc_entries SET reversed_by = NULL WHERE reversed_by = ?', e.id);
        db.run('DELETE FROM acc_lines WHERE entry_id = ?', e.id);
        db.run('DELETE FROM acc_entries WHERE id = ?', e.id);
      }
      db.run('DELETE FROM hr_advance_repayments WHERE advance_id = ?', id);
      db.run('DELETE FROM hr_advances WHERE id = ?', id);
      recalcDrafts(db);
    },
    link: (id) => `/admin/hr/advances/${id}`,
    label: (v, names) => `${v.ref ? `${v.ref} · ` : ''}${names.employee || ''}`,
    examples: [
      { employee: 'EMP-0007 · Mahmoud Adel', amount: 24000, issued_on: '2025-10-05', installments: 8, repaid: 6000, start_period: '2026-01', method: 'cash', reason: 'Family occasion' },
      { employee: 'EMP-0012 · Salma Adel', amount: 9000, issued_on: '2025-12-20', installments: 3, start_period: '2026-01', method: 'transfer' },
    ],
  });

  // =====================================================================================
  // Leave already taken (approved leave)
  // =====================================================================================
  const LEAVE_OPTS = opts(HR.LEAVE);
  const overlapIn = (db, emp, start, end, except = 0) => db.get("SELECT * FROM leave_requests WHERE employee_id = ? AND status IN ('approved','pending') AND start_date <= ? AND end_date >= ? AND id != ?", emp, end, start, except);
  imports.register({
    key: 'leave_taken',
    module: '/admin/hr',
    pages: ['/admin/hr/leave'],
    area: 'people',
    order: 40,
    depends: ['employees'],
    icon: 'leave',
    table: 'leave_requests',
    title: L('Leave already taken', 'الإجازات المستخدمة'),
    summary: L('Approved leave from your records, so this year’s balances are right.', 'الإجازات المعتمدة من سجلاتك، لتكون أرصدة هذا العام صحيحة.'),
    notes: L('Each row is saved as approved leave, exactly as if HR had entered it. Balances count working days (Fridays excluded). Unpaid leave also reaches the draft payroll of its month.', 'يُحفظ كل صف إجازة معتمدة كما لو أدخلها قسم الموارد البشرية. الأرصدة تُحسب بأيام العمل (بدون الجمعة). الإجازة بدون أجر تنعكس أيضًا على كشف الرواتب المسودة لشهرها.'),
    canView: hrOnly,
    allowed: hrOnly,
    keys: [['employee', 'start_date']],
    count: (db) => db.value("SELECT COUNT(*) FROM leave_requests WHERE status = 'approved'"),
    columns: [
      { key: 'employee', label: L('Employee', 'الموظف'), type: 'ref', required: true, width: 28, ref: { list: empChoices, dataset: 'employees', what: L('Employees', 'الموظفين') }, example: 'EMP-0007 · Mahmoud Adel', aliases: ['employee code', 'emp code', 'name', 'كود الموظف', 'اسم الموظف'] },
      { key: 'type', label: L('Leave type', 'نوع الإجازة'), type: 'enum', enum: LEAVE_OPTS, width: 18, example: 'annual', help: L('Empty: annual leave.', 'الفارغ: إجازة سنوية.') },
      { key: 'start_date', label: L('From', 'من'), type: 'date', required: true, width: 14, keepOnUpdate: true, example: '2026-03-08', aliases: ['start', 'start date', 'from date', 'تاريخ البدايه', 'من تاريخ'] },
      { key: 'end_date', label: L('To', 'إلى'), type: 'date', required: true, width: 14, example: '2026-03-12', aliases: ['end', 'end date', 'to date', 'تاريخ النهايه', 'الى تاريخ'] },
      { key: 'days', label: L('Days counted', 'الأيام المحسوبة'), type: 'number', min: 0.5, maxValue: 366, width: 14, help: L('Empty: the working days between the dates (Fridays excluded). Half days as 0.5.', 'الفارغ: أيام العمل بين التاريخين (بدون الجمعة). نصف اليوم ٠٫٥.') },
      { key: 'reason', label: L('Reason', 'السبب'), type: 'text', max: 300, width: 26 },
    ],
    find: (db, v) => {
      if (!v.employee || !v.start_date) return null;
      const l = db.get("SELECT id FROM leave_requests WHERE employee_id = ? AND start_date = ? AND status IN ('approved','pending') ORDER BY id DESC LIMIT 1", v.employee, v.start_date);
      return l ? l.id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      if (ctx.id) {
        const l = db.get('SELECT * FROM leave_requests WHERE id = ?', ctx.id);
        if (l.status !== 'approved') { ctx.error('start_date', 'imp2|This leave is still waiting for a decision: decide it in the office.'); return; }
      }
      if (!row.start_date || !row.end_date) return;
      if (row.end_date < row.start_date) { ctx.error('end_date', 'imp2|The leave ends before it starts.'); return; }
      const counted = HR.workDays(row.start_date, row.end_date);
      if (!counted) { ctx.error('end_date', 'imp2|Those dates are all Fridays.'); return; }
      if (row.days && row.days > counted) ctx.error('days', 'imp2|More days than the working days between the dates ({n}).', { n: counted });
      if (row.days && Math.round(row.days * 2) !== row.days * 2) ctx.error('days', 'imp2|Days are whole or half days.');
      if (row.employee && typeof row.employee === 'number' && overlapIn(db, row.employee, row.start_date, row.end_date, ctx.id || 0)) ctx.error('start_date', 'imp2|That overlaps leave already booked for this person.');
    },
    // two rows of the same person must not overlap either
    fileCheck(rows, ctx) {
      const by = new Map();
      for (const r of rows) if (typeof r.full.employee === 'number' && r.full.start_date && r.full.end_date) (by.get(r.full.employee) || by.set(r.full.employee, []).get(r.full.employee)).push(r);
      for (const list of by.values()) {
        list.sort((a, b) => (a.full.start_date < b.full.start_date ? -1 : 1));
        for (let i = 1; i < list.length; i++) if (list[i].full.start_date <= list[i - 1].full.end_date) ctx.error(list[i], 'start_date', 'imp2|This overlaps the leave on row {line}.', { line: list[i - 1].line });
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const type = row.type || 'annual';
      const counted = HR.workDays(row.start_date, row.end_date);
      const days = row.days ? Math.min(counted, Math.max(0.5, Math.round(row.days * 2) / 2)) : counted;
      const e = db.get('SELECT * FROM employees WHERE id = ?', row.employee);
      if (ctx.id) {
        db.run('UPDATE leave_requests SET type = ?, end_date = ?, days = ?, reason = ? WHERE id = ?', type, row.end_date, days, row.reason || null, ctx.id);
        ctx.log('Changed a leave record', 'leave', ctx.id, `${e.name} — leave: ${i18n.english(HR.LEAVE[type])}, ${days} days`);
        return ctx.id;
      }
      const uid = ctx.user ? ctx.user.id : null;
      const id = Number(db.run("INSERT INTO leave_requests (employee_id, type, start_date, end_date, days, reason, status, decided_by, decided_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)",
        e.id, type, row.start_date, row.end_date, days, row.reason || null, uid, now(), uid, now()).lastInsertRowid);
      ctx.log('Approved leave', 'leave', id, `${e.name} — leave: ${i18n.english(HR.LEAVE[type])}, ${days} days`);
      return id;
    },
    after: (db, hh, { created, changes }) => { if (created.length || changes.length) recalcDrafts(db); },
    export: (db) => db.all("SELECT l.*, e.code, e.name FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.status = 'approved' AND e.status = 'active' ORDER BY l.start_date DESC, l.id DESC").map((l) => ({
      $id: l.id, employee: empLabel(l), type: l.type, start_date: l.start_date, end_date: l.end_date, days: l.days, reason: l.reason,
    })),
    uses(db, id) {
      const l = db.get('SELECT * FROM leave_requests WHERE id = ?', id);
      if (!l || l.type !== 'unpaid') return [];
      const n = db.value("SELECT COUNT(*) FROM payroll_runs WHERE status IN ('approved','paid') AND period >= ? AND period <= ?", l.start_date.slice(0, 7), l.end_date.slice(0, 7));
      return n ? [{ n, what: L('approved payroll runs', 'كشوف رواتب معتمدة') }] : [];
    },
    remove(db, id) {
      db.run('DELETE FROM leave_requests WHERE id = ?', id);
      recalcDrafts(db);
    },
    link: (id) => '/admin/hr/leave',
    label: (v, names) => `${names.employee || ''} · ${v.start_date || ''}`,
    examples: [
      { employee: 'EMP-0007 · Mahmoud Adel', type: 'annual', start_date: '2026-03-08', end_date: '2026-03-12', reason: 'Family trip' },
      { employee: 'EMP-0012 · Salma Adel', type: 'sick', start_date: '2026-02-15', end_date: '2026-02-16', days: 2 },
    ],
  });

  // =====================================================================================
  // Attendance shifts
  // =====================================================================================
  const COLOR_OPTS = ATT.SHIFT_COLORS.map((c) => [c, lab(ATT.COLOR_NAME[c])]);
  const shiftChoices = (db) => db.all('SELECT id, name FROM att_shifts ORDER BY active DESC, name').map((s) => ({ id: s.id, name: s.name, alt: [typeof i18n.AR[s.name] === 'string' ? i18n.AR[s.name] : null].filter(Boolean) }));
  const dayHelp = L('Mon, Tue, Wed… or Arabic names, a range like Sat–Thu, or “every day”.', 'الاثنين، الثلاثاء… أو أسماء بالإنجليزية، أو مدى مثل السبت–الخميس، أو «كل يوم».');
  imports.register({
    key: 'shifts',
    module: '/admin/attendance',
    pages: ['/admin/attendance/shifts'],
    area: 'people',
    order: 50,
    icon: 'cal',
    table: 'att_shifts',
    title: L('Attendance shifts', 'ورديات الحضور'),
    summary: L('The working hours: start and end, the days, grace and break.', 'مواعيد العمل: البداية والنهاية والأيام وفترة السماح والاستراحة.'),
    notes: L('A shift that ends at or before it starts runs past midnight and belongs to the day it starts. The default shift is chosen on the Shifts page.', 'الوردية التي تنتهي قبل أو عند بدايتها تمتد بعد منتصف الليل وتُحسب لليوم الذي بدأت فيه. الوردية الافتراضية تُختار من صفحة الورديات.'),
    canView: hrOnly,
    allowed: hrOnly,
    keys: ['name'],
    columns: [
      { key: 'name', label: L('Shift', 'الوردية'), type: 'text', required: true, max: 80, width: 22, example: 'Evening', aliases: ['shift name', 'name', 'اسم الورديه'], help: L('A name already in the system updates that shift.', 'الاسم الموجود في النظام يحدّث الوردية نفسها.') },
      { key: 'start_hm', label: L('Starts', 'تبدأ'), type: 'time', required: true, width: 10, example: '16:00', aliases: ['start', 'from', 'start time', 'من', 'البدايه'] },
      { key: 'end_hm', label: L('Ends', 'تنتهي'), type: 'time', required: true, width: 10, example: '00:00', aliases: ['end', 'to', 'end time', 'الى', 'النهايه'] },
      { key: 'days', label: L('Days', 'الأيام'), type: 'list', required: true, width: 26, example: 'Sat, Sun, Mon, Tue, Wed, Thu', help: dayHelp, transform: (v) => readDays(v) },
      { key: 'grace_min', label: L('Grace (minutes)', 'السماح (بالدقائق)'), type: 'int', min: 0, maxValue: 120, width: 14, help: L('Empty: the office default.', 'الفارغ: الافتراضي في الإعدادات.') },
      { key: 'break_min', label: L('Unpaid break (minutes)', 'استراحة غير مدفوعة (بالدقائق)'), type: 'int', min: 0, maxValue: 240, width: 16, example: 30 },
      { key: 'color', label: L('Colour', 'اللون'), type: 'enum', enum: COLOR_OPTS, width: 14, example: 'sky', help: L('Empty: sea green.', 'الفارغ: أخضر بحري.') },
      { key: 'active', label: L('In use', 'مستخدمة'), type: 'bool', width: 10, example: 'yes' },
    ],
    find: (db, v) => {
      const hits = db.all('SELECT id, name FROM att_shifts').filter((s) => P.norm(s.name) === P.norm(v.name) || (typeof i18n.AR[s.name] === 'string' && P.norm(i18n.AR[s.name]) === P.norm(v.name)));
      if (hits.length > 1) return { error: 'imp2|More than one shift has this name; rename one of them first.' };
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      if (row.start_hm && row.end_hm && row.start_hm === row.end_hm) ctx.error('end_hm', 'imp2|A shift cannot end when it starts.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const days = daysDigits(row.days);
      const color = row.color || 'sea';
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO att_shifts (name, start_hm, end_hm, days, grace_min, break_min, color, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', row.name, row.start_hm, row.end_hm, days, row.grace_min ?? null, row.break_min || 0, color, row.active === false ? 0 : 1, now()).lastInsertRowid);
        ctx.log('Added a shift', 'settings', null, row.name);
        return id;
      }
      db.run('UPDATE att_shifts SET name = ?, start_hm = ?, end_hm = ?, days = ?, grace_min = ?, break_min = ?, color = ?, active = ? WHERE id = ?', row.name, row.start_hm, row.end_hm, days, row.grace_min ?? null, row.break_min || 0, color, row.active === false ? 0 : 1, ctx.id);
      ctx.log('Changed a shift', 'settings', null, row.name);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM att_shifts ORDER BY active DESC, start_hm, name').map((s) => ({
      $id: s.id, name: s.name, start_hm: s.start_hm, end_hm: s.end_hm, days: daysCodes(s.days), grace_min: s.grace_min, break_min: s.break_min, color: s.color, active: !!s.active,
    })),
    uses: (db, id, o) => imports.usesOf('att_shifts', id, o),
    link: (id) => `/admin/attendance/shifts/${id}`,
    label: (v) => v.name || '',
    examples: [
      { name: 'Morning', start_hm: '08:00', end_hm: '16:00', days: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu'], grace_min: 10, break_min: 30, color: 'sky', active: true },
      { name: 'Night security', start_hm: '22:00', end_hm: '06:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], break_min: 45, color: 'forest', active: true },
    ],
  });

  // =====================================================================================
  // Who works which shift
  // =====================================================================================
  // the assignment an import cut short (its end date before): put back by undo
  DB.ensure('import-x2-1', 'CREATE TABLE imp_x2_assign_prev (assign_id INTEGER NOT NULL, prev_id INTEGER NOT NULL, prev_ends TEXT)');
  imports.register({
    key: 'shift_assignments',
    module: '/admin/attendance',
    pages: ['/admin/attendance/shifts'],
    area: 'people',
    order: 60,
    depends: ['employees', 'shifts'],
    icon: 'people',
    table: 'att_assign',
    title: L('Who works which shift', 'من يعمل في أي وردية'),
    summary: L('Each person’s shift from a date (and until a date, if it ends).', 'وردية كل شخص من تاريخ (وحتى تاريخ إن كانت تنتهي).'),
    notes: L('A shift from a date ends the person’s current shift the day before, as on the Shifts page. A later shift already set for them is kept: change it there.', 'الوردية من تاريخ معين تُنهي الوردية الحالية للشخص في اليوم السابق، كما في صفحة الورديات. الوردية اللاحقة المحددة له تبقى: غيّرها من هناك.'),
    canView: hrOnly,
    allowed: hrOnly,
    keys: [['employee', 'starts']],
    columns: [
      { key: 'employee', label: L('Employee', 'الموظف'), type: 'ref', required: true, width: 28, ref: { list: empChoices, dataset: 'employees', what: L('Employees', 'الموظفين') }, example: 'EMP-0007 · Mahmoud Adel', aliases: ['employee code', 'emp code', 'name', 'كود الموظف', 'اسم الموظف'] },
      { key: 'shift', label: L('Shift', 'الوردية'), type: 'ref', required: true, width: 22, ref: { list: shiftChoices, dataset: 'shifts', what: L('Shifts', 'الورديات') }, example: 'Morning', aliases: ['shift name', 'الورديه'] },
      { key: 'starts', label: L('From', 'من'), type: 'date', required: true, width: 14, keepOnUpdate: true, example: '2026-01-01', aliases: ['start', 'from date', 'starts on', 'من تاريخ'] },
      { key: 'ends', label: L('Until (optional)', 'حتى (اختياري)'), type: 'date', width: 14, aliases: ['end', 'to', 'until', 'ends on', 'حتى', 'الى تاريخ'] },
    ],
    find: (db, v) => {
      if (!v.employee || !v.starts) return null;
      const a = db.get('SELECT id FROM att_assign WHERE employee_id = ? AND starts = ? ORDER BY id DESC LIMIT 1', v.employee, v.starts);
      return a ? a.id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      if (!row.starts || typeof row.employee !== 'number') return;
      if (row.ends && row.ends < row.starts) { ctx.error('ends', 'imp2|It ends before it starts.'); return; }
      const end = row.ends || '9999-12-31';
      const later = db.get('SELECT a.*, s.name shift FROM att_assign a JOIN att_shifts s ON s.id = a.shift_id WHERE a.employee_id = ? AND a.starts > ? AND a.starts <= ? AND a.id != ? ORDER BY a.starts LIMIT 1', row.employee, row.starts, end, ctx.id || 0);
      if (later) ctx.error(row.ends ? 'ends' : 'starts', 'imp2|They already have “{shift}” from {date}: end this one before, or change that one on the Shifts page.', { shift: later.shift, date: later.starts });
    },
    fileCheck(rows, ctx) {
      const by = new Map();
      for (const r of rows) if (typeof r.full.employee === 'number' && r.full.starts) (by.get(r.full.employee) || by.set(r.full.employee, []).get(r.full.employee)).push(r);
      for (const list of by.values()) {
        list.sort((a, b) => (a.full.starts < b.full.starts ? -1 : 1));
        for (let i = 1; i < list.length; i++) {
          const prev = list[i - 1];
          if (!prev.full.ends || prev.full.ends >= list[i].full.starts) ctx.error(prev, 'ends', 'imp2|It must end before the shift on row {line} starts.', { line: list[i].line });
        }
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const s = db.get('SELECT name FROM att_shifts WHERE id = ?', row.shift);
      if (ctx.id) {
        db.run('UPDATE att_assign SET shift_id = ?, ends = ? WHERE id = ?', row.shift, row.ends || null, ctx.id);
        ctx.log('Assigned a shift', 'settings', null, s.name);
        return ctx.id;
      }
      // the shift they work now ends the day before (kept for undo)
      const cut = db.all('SELECT id, ends FROM att_assign WHERE employee_id = ? AND starts < ? AND (ends IS NULL OR ends >= ?)', row.employee, row.starts, row.starts);
      const id = Number(db.run('INSERT INTO att_assign (employee_id, shift_id, starts, ends, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', row.employee, row.shift, row.starts, row.ends || null, ctx.user ? ctx.user.id : null, now()).lastInsertRowid);
      for (const c of cut) {
        db.run('INSERT INTO imp_x2_assign_prev (assign_id, prev_id, prev_ends) VALUES (?, ?, ?)', id, c.id, c.ends);
        db.run('UPDATE att_assign SET ends = ? WHERE id = ?', addDays(row.starts, -1), c.id);
      }
      ctx.log('Assigned a shift', 'settings', null, s.name);
      return id;
    },
    export: (db) => db.all("SELECT a.*, e.code, e.name, s.name shift_name FROM att_assign a JOIN employees e ON e.id = a.employee_id JOIN att_shifts s ON s.id = a.shift_id WHERE e.status = 'active' ORDER BY e.code, a.starts").map((a) => ({
      $id: a.id, employee: empLabel(a), shift: a.shift_name, starts: a.starts, ends: a.ends,
    })),
    remove(db, id) {
      for (const p of db.all('SELECT * FROM imp_x2_assign_prev WHERE assign_id = ?', id)) db.run('UPDATE att_assign SET ends = ? WHERE id = ?', p.prev_ends, p.prev_id);
      db.run('DELETE FROM imp_x2_assign_prev WHERE assign_id = ?', id);
      db.run('DELETE FROM att_assign WHERE id = ?', id);
    },
    link: () => '/admin/attendance/shifts',
    label: (v, names) => `${names.employee || ''} · ${names.shift || ''}`,
    examples: [
      { employee: 'EMP-0007 · Mahmoud Adel', shift: 'Morning', starts: '2026-01-01' },
      { employee: 'EMP-0015 · Hany Fawzy', shift: 'Night security', starts: '2026-01-01', ends: '2026-06-30' },
    ],
  });
};

module.exports.readDays = readDays;
