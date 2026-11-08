'use strict';

// The first datasets: departments and employees (HR), units and brands (property). Each one saves
// exactly what the module's own forms save, with the same checks (routes/hr.js, routes/property.js,
// routes/tenants.js), so an imported record is indistinguishable from one typed in.

const i18n = require('../../i18n');
const HR = require('../../routes/hr');
const { TIERS } = require('../../routes/property');

const L = (en, ar) => ({ en, ar });
// a dictionary key → { en, ar }
const lab = (key) => ({ en: i18n.english(key), ar: typeof i18n.AR[key] === 'string' ? i18n.AR[key] : i18n.english(key) });
const opts = (map) => Object.entries(map).map(([k, key]) => [k, lab(key)]);
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/;
const ibanOf = (v) => (v ? String(v).replace(/[\s-]+/g, '').toUpperCase() : null);

module.exports = function coreDatasets(imports, h) {
  const { M } = h;
  const now = () => M.now();
  const rawLabels = (proxy) => Object.keys(proxy).map((k) => [k, { en: i18n.run('en', () => proxy[k]), ar: i18n.run('ar', () => proxy[k]) }]);

  // ---------- departments ----------
  const empChoices = (db) => db.all("SELECT id, code, name, name_ar FROM employees ORDER BY status = 'active' DESC, code").map((e) => ({ id: e.id, name: `${e.code} · ${e.name}`, alt: [e.code, e.name, e.name_ar].filter(Boolean) }));
  const deptChoices = (db) => db.all('SELECT id, name FROM departments ORDER BY sort, name').map((d) => ({ id: d.id, name: d.name, alt: [typeof i18n.AR[d.name] === 'string' ? i18n.AR[d.name] : null].filter(Boolean) }));

  imports.register({
    key: 'departments',
    module: '/admin/hr',
    pages: ['/admin/hr/departments'],
    area: 'people',
    order: 10,
    icon: 'people',
    table: 'departments',
    title: L('Departments', 'الإدارات'),
    summary: L('The teams your employees belong to.', 'الإدارات التي ينتمي إليها الموظفون.'),
    canView: (req) => h.canHR(req),
    allowed: (req) => h.canHR(req),
    keys: ['name'],
    columns: [
      { key: 'name', label: L('Department', 'الإدارة'), type: 'text', required: true, max: 80, width: 28, example: 'Security', aliases: ['department', 'dept', 'الاداره'], help: L('The department’s name. Rows whose name is already in the system update it.', 'اسم الإدارة. الصف الذي يحمل اسمًا موجودًا في النظام يحدّث الإدارة نفسها.') },
      { key: 'head', label: L('Head (employee)', 'المدير (موظف)'), type: 'ref', width: 30, ref: { list: empChoices, dataset: 'employees', what: L('Employees', 'الموظفين') }, help: L('Optional. Pick the employee who leads it; import Employees first.', 'اختياري. اختر الموظف الذي يديرها، بعد استيراد الموظفين.') },
      { key: 'sort', label: L('Order in lists', 'الترتيب في القوائم'), type: 'int', min: 0, maxValue: 999, width: 16, help: L('A number: lower comes first.', 'رقم: الأصغر يظهر أولًا.') },
    ],
    find: (db, v) => {
      const typed = String(v.name || '').trim().toLowerCase();
      const hits = db.all('SELECT id, name FROM departments').filter((d) => d.name.toLowerCase() === typed || (typeof i18n.AR[d.name] === 'string' && i18n.AR[d.name] === String(v.name).trim()));
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      const other = ctx.db.get('SELECT id FROM departments WHERE name = ? COLLATE NOCASE AND id != ?', row.name, ctx.id || 0);
      if (other) ctx.error('name', 'imp|Another department already has this name.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const sort = row.sort ?? (ctx.id ? undefined : (db.value('SELECT COALESCE(MAX(sort), 0) FROM departments') || 0) + 1);
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO departments (name, head_id, sort) VALUES (?, ?, ?)', row.name, row.head || null, sort).lastInsertRowid);
        ctx.log('Added a department', 'department', id, row.name);
        return id;
      }
      db.run('UPDATE departments SET name = ?, head_id = ?, sort = COALESCE(?, sort) WHERE id = ?', row.name, row.head || null, sort ?? null, ctx.id);
      ctx.log('Updated a department', 'department', ctx.id, row.name);
      return ctx.id;
    },
    export: (db) => db.all('SELECT d.*, e.code head_code, e.name head_name FROM departments d LEFT JOIN employees e ON e.id = d.head_id ORDER BY d.sort, d.name')
      .map((d) => ({ $id: d.id, name: d.name, head: d.head_id ? `${d.head_code} · ${d.head_name}` : null, sort: d.sort })),
    uses: (db, id, o) => imports.usesOf('departments', id, o),
    link: (id) => '/admin/hr/departments',
    label: (v) => v.name,
    examples: [{ name: 'Security', sort: 6 }, { name: 'Housekeeping', sort: 7 }, { name: 'Customer service', sort: 8 }],
  });

  // ---------- employees ----------
  const nextCode = (db) => {
    const last = db.all("SELECT code FROM employees WHERE code LIKE 'EMP-%'").map((r) => Number(r.code.slice(4)) || 0).sort((a, b) => b - a)[0] || 0;
    return `EMP-${String(last + 1).padStart(4, '0')}`;
  };
  const COLS = ['name', 'name_ar', 'national_id', 'birth_date', 'gender', 'nationality', 'marital_status', 'phone', 'email', 'address', 'emergency_name', 'emergency_phone', 'department_id', 'position', 'manager_id', 'hire_date', 'employment_type', 'contract_end', 'probation_end', 'shift', 'user_id', 'basic_salary', 'allowances', 'insured_wage', 'insurance_no', 'bank_name', 'iban', 'annual_leave_days', 'notes'];
  imports.register({
    key: 'employees',
    module: '/admin/hr',
    pages: ['/admin/hr'],
    area: 'people',
    order: 20,
    icon: 'people',
    table: 'employees',
    depends: ['departments'],
    title: L('Employees', 'الموظفون'),
    summary: L('The mall’s own team: personal details, job, pay and bank.', 'فريق المول: البيانات الشخصية والوظيفة والأجر والبنك.'),
    notes: L('Salaries and national IDs are seen by HR only. Passwords and staff-app PINs are never imported: set them in the office.', 'الرواتب وأرقام الهوية يراها قسم الموارد البشرية فقط. لا تُستورد كلمات المرور ولا الأرقام السرية لتطبيق الموظفين: تُضبط من داخل المكتب.'),
    canView: (req) => h.canHR(req),
    allowed: (req) => h.canHR(req),
    keys: ['code', 'national_id'],
    columns: [
      { key: 'code', label: L('Employee code', 'كود الموظف'), type: 'code', max: 20, width: 16, keepOnUpdate: true, example: 'EMP-0042', aliases: ['emp code', 'employee no', 'employee number', 'staff no', 'رقم الموظف', 'الرقم الوظيفي'], help: L('Leave empty for new people: the office gives the next code. A code already in the system updates that person.', 'اتركه فارغًا للموظفين الجدد: يعطي النظام الكود التالي. الكود الموجود في النظام يحدّث بيانات صاحبه.') },
      { key: 'name', label: L('Full name', 'الاسم بالكامل'), type: 'text', required: true, max: 120, width: 26, example: 'Ahmed Samir Fathy' },
      { key: 'name_ar', label: L('Name in Arabic', 'الاسم بالعربية'), type: 'text', max: 120, width: 24, example: 'أحمد سمير فتحي' },
      { key: 'national_id', label: L('National ID', 'الرقم القومي'), type: 'text', max: 20, width: 18, pattern: { re: /^[23]\d{13}$/, error: 'imp|A national ID has 14 digits and starts with 2 or 3.' }, example: '29001011234567', help: L('14 digits. The birth date is read from it when the birth date is empty.', '١٤ رقمًا. يُستخرج منه تاريخ الميلاد إن تُرك فارغًا.') },
      { key: 'birth_date', label: L('Birth date', 'تاريخ الميلاد'), type: 'date', width: 14, example: '1990-01-01' },
      { key: 'gender', label: L('Gender', 'النوع'), type: 'enum', enum: opts(HR.GENDER), width: 12, example: 'male' },
      { key: 'nationality', label: L('Nationality', 'الجنسية'), type: 'text', max: 60, width: 14, example: 'Egyptian' },
      { key: 'marital_status', label: L('Marital status', 'الحالة الاجتماعية'), type: 'enum', enum: opts(HR.MARITAL), width: 16 },
      { key: 'phone', label: L('Mobile', 'الموبايل'), type: 'phone', width: 16, example: '01001234567' },
      { key: 'email', label: L('Email', 'البريد الإلكتروني'), type: 'email', width: 26, example: 'ahmed.samir@thewavemall.com' },
      { key: 'address', label: L('Address', 'العنوان'), type: 'text', max: 300, width: 30 },
      { key: 'emergency_name', label: L('Emergency contact', 'جهة اتصال للطوارئ'), type: 'text', max: 120, width: 22 },
      { key: 'emergency_phone', label: L('Emergency phone', 'هاتف الطوارئ'), type: 'phone', width: 16 },
      { key: 'department', label: L('Department', 'الإدارة'), type: 'ref', width: 22, ref: { list: deptChoices, dataset: 'departments', what: L('Departments', 'الإدارات') }, example: 'Security', help: L('Pick from the list. Import Departments first.', 'اختر من القائمة. استورد الإدارات أولًا.') },
      { key: 'position', label: L('Position', 'الوظيفة'), type: 'text', required: true, max: 120, width: 22, example: 'Security supervisor' },
      { key: 'manager', label: L('Manager', 'المدير المباشر'), type: 'ref', width: 28, ref: { list: empChoices, dataset: 'employees', what: L('Employees', 'الموظفين'), self: 'code', set: (db, id, target) => db.run('UPDATE employees SET manager_id = ? WHERE id = ?', target, id) }, help: L('The manager’s employee code (they may be further down in the same file).', 'كود الموظف للمدير (يمكن أن يكون في الملف نفسه).') },
      { key: 'hire_date', label: L('Hire date', 'تاريخ التعيين'), type: 'date', required: true, width: 14, example: '2024-03-01' },
      { key: 'employment_type', label: L('Employment type', 'نوع التعاقد'), type: 'enum', enum: opts(HR.TYPES), width: 20, example: 'full_time', help: L('Empty means full time.', 'الفارغ يعني دوامًا كاملًا.') },
      { key: 'contract_end', label: L('Contract end', 'نهاية العقد'), type: 'date', width: 14 },
      { key: 'probation_end', label: L('Probation end', 'نهاية فترة الاختبار'), type: 'date', width: 16 },
      { key: 'shift', label: L('Shift', 'الوردية'), type: 'text', max: 120, width: 16, example: 'Morning' },
      { key: 'office_account', label: L('Office account (email)', 'حساب المكتب (البريد)'), type: 'ref', width: 26, ref: { list: (db) => db.all('SELECT id, email, name FROM users ORDER BY name').map((u) => ({ id: u.id, name: u.email, alt: [u.name] })), what: L('Office accounts', 'حسابات المكتب') }, help: L('Optional: the email of their office sign-in, if they have one.', 'اختياري: البريد الذي يدخل به إلى المكتب إن كان له حساب.') },
      { key: 'basic_salary', label: L('Basic salary', 'الراتب الأساسي'), type: 'money', required: true, width: 15, example: 12000, help: L('A month, before deductions.', 'شهريًا، قبل الاستقطاعات.') },
      { key: 'allowances', label: L('Allowances', 'البدلات'), type: 'money', width: 13, example: 1500 },
      { key: 'insured_wage', label: L('Insured wage', 'الأجر التأميني'), type: 'money', width: 14, help: L('Empty: basic + allowances.', 'الفارغ: الأساسي + البدلات.') },
      { key: 'insurance_no', label: L('Insurance number', 'الرقم التأميني'), type: 'text', max: 40, width: 16 },
      { key: 'bank_name', label: L('Bank', 'البنك'), type: 'text', max: 120, width: 18, example: 'CIB' },
      { key: 'iban', label: L('IBAN', 'رقم الحساب الدولي'), type: 'text', max: 60, width: 32, example: 'EG380019000500000000263180002', transform: (v) => ({ value: ibanOf(v) }) },
      { key: 'annual_leave_days', label: L('Annual leave days', 'أيام الإجازة السنوية'), type: 'int', min: 1, maxValue: 60, width: 14, help: L('Empty: the office default (21, or 30 with seniority).', 'الفارغ: الافتراضي (٢١، أو ٣٠ مع الأقدمية).') },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: [['active', L('Active', 'على رأس العمل')], ['left', L('Left', 'ترك العمل')]], width: 14, help: L('Empty means active. “Left” needs the last day.', 'الفارغ يعني على رأس العمل. «ترك العمل» يحتاج آخر يوم.') },
      { key: 'ended_at', label: L('Last day', 'آخر يوم عمل'), type: 'date', width: 14 },
      { key: 'end_reason', label: L('Reason for leaving', 'سبب ترك العمل'), type: 'enum', enum: opts(HR.END_REASONS), width: 18 },
      { key: 'notes', label: L('Notes', 'ملاحظات'), type: 'text', max: 2000, multiline: true, width: 30 },
    ],
    find: (db, v, key) => {
      const hits = key === 'code' ? db.all('SELECT id FROM employees WHERE code = ? COLLATE NOCASE', v.code) : db.all('SELECT id FROM employees WHERE national_id = ?', v.national_id);
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      if (row.iban && !IBAN_RE.test(row.iban)) ctx.error('iban', 'imp|That IBAN does not look right.');
      if (row.national_id && db.get('SELECT id FROM employees WHERE national_id = ? AND id != ?', row.national_id, ctx.id || 0)) ctx.error('national_id', 'imp|Someone else in the system has this national ID.');
      if (!ctx.id && row.code && db.get('SELECT id FROM employees WHERE code = ? COLLATE NOCASE', row.code)) ctx.error('code', 'imp|This code is already used.');
      if (row.contract_end && row.hire_date && row.contract_end < row.hire_date) ctx.error('contract_end', 'imp|The contract cannot end before the hire date.');
      if (row.status === 'left') {
        if (!row.ended_at) ctx.error('ended_at', 'imp|Give the last day of someone who left.');
        else if (row.hire_date && row.ended_at < row.hire_date) ctx.error('ended_at', 'imp|The last day cannot be before the hire date.');
      } else if (row.ended_at && ctx.provided.has('ended_at')) ctx.warn('ended_at', 'imp|A last day is only kept for someone who left.');
      if (ctx.id && row.manager === ctx.id) ctx.error('manager', 'imp|Someone cannot be their own manager.');
      if (row.national_id && !row.birth_date) {
        const c = row.national_id[0] === '2' ? '19' : '20';
        const d = `${c}${row.national_id.slice(1, 3)}-${row.national_id.slice(3, 5)}-${row.national_id.slice(5, 7)}`;
        if (HR.isDate(d)) row.birth_date = d;
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const e = {
        ...row,
        iban: ibanOf(row.iban),
        department_id: row.department || null,
        manager_id: row.manager && typeof row.manager === 'number' ? row.manager : null,
        user_id: row.office_account || null,
        employment_type: row.employment_type || 'full_time',
        allowances: row.allowances || 0,
      };
      const status = row.status === 'left' ? 'left' : 'active';
      if (!ctx.id) {
        const code = row.code || nextCode(db);
        const id = Number(db.run(
          `INSERT INTO employees (code, ${COLS.join(', ')}, status, ended_at, end_reason, created_at, updated_at) VALUES (?, ${COLS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)`,
          code, ...COLS.map((k) => e[k] ?? null), status, status === 'left' ? row.ended_at : null, status === 'left' ? row.end_reason || 'resigned' : null, now(), now(),
        ).lastInsertRowid);
        ctx.log('Added an employee', 'employee', id, row.name);
        return id;
      }
      const old = db.get('SELECT * FROM employees WHERE id = ?', ctx.id);
      db.run(`UPDATE employees SET ${COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...COLS.map((k) => e[k] ?? null), now(), ctx.id);
      if (status === 'left' && old.status !== 'left') {
        db.run("UPDATE employees SET status = 'left', ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ?", row.ended_at, row.end_reason || 'resigned', now(), ctx.id);
        db.run('UPDATE employees SET manager_id = NULL WHERE manager_id = ?', ctx.id);
        db.run("UPDATE leave_requests SET status = 'cancelled' WHERE employee_id = ? AND status = 'pending'", ctx.id);
        ctx.log('Ended employment', 'employee', ctx.id, `${old.name} — reason: ${i18n.english(HR.END_REASONS[row.end_reason || 'resigned'])}`);
      } else if (status === 'left') {
        db.run('UPDATE employees SET ended_at = ?, end_reason = ? WHERE id = ?', row.ended_at, row.end_reason || old.end_reason || 'resigned', ctx.id);
      } else if (old.status === 'left') {
        db.run("UPDATE employees SET status = 'active', ended_at = NULL, end_reason = NULL WHERE id = ?", ctx.id);
        ctx.log('Rehired an employee', 'employee', ctx.id, old.name);
      }
      const pay = ['basic_salary', 'allowances'].some((k) => Number(old[k] || 0) !== Number(e[k] || 0));
      ctx.log(pay ? 'Changed pay' : 'Updated an employee', 'employee', ctx.id, old.name);
      return ctx.id;
    },
    export: (db) => db.all(`SELECT e.*, d.name dept, m.code m_code, m.name m_name, u.email u_email FROM employees e LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN employees m ON m.id = e.manager_id LEFT JOIN users u ON u.id = e.user_id ORDER BY e.code`).map((e) => ({
      $id: e.id, code: e.code, name: e.name, name_ar: e.name_ar, national_id: e.national_id, birth_date: e.birth_date, gender: e.gender, nationality: e.nationality,
      marital_status: e.marital_status, phone: e.phone, email: e.email, address: e.address, emergency_name: e.emergency_name, emergency_phone: e.emergency_phone,
      department: e.dept, position: e.position, manager: e.manager_id ? `${e.m_code} · ${e.m_name}` : null, hire_date: e.hire_date, employment_type: e.employment_type,
      contract_end: e.contract_end, probation_end: e.probation_end, shift: e.shift, office_account: e.u_email, basic_salary: e.basic_salary, allowances: e.allowances,
      insured_wage: e.insured_wage, insurance_no: e.insurance_no, bank_name: e.bank_name, iban: e.iban, annual_leave_days: e.annual_leave_days,
      status: e.status === 'left' ? 'left' : 'active', ended_at: e.ended_at, end_reason: e.end_reason, notes: e.notes,
    })),
    uses: (db, id, o) => imports.usesOf('employees', id, { ...o, entity: 'employee' }),
    link: (id) => `/admin/hr/employees/${id}`,
    label: (v) => (v.code ? `${v.code} · ${v.name || ''}` : v.name || ''),
    examples: [
      { code: 'EMP-0101', name: 'Ahmed Samir Fathy', name_ar: 'أحمد سمير فتحي', national_id: '29001011234567', gender: 'male', nationality: 'Egyptian', phone: '01001234567', email: 'ahmed.samir@thewavemall.com', department: 'Security', position: 'Security supervisor', hire_date: '2024-03-01', employment_type: 'full_time', shift: 'Morning', basic_salary: 14000, allowances: 1500, bank_name: 'CIB', status: 'active' },
      { name: 'Mona Adel Hassan', name_ar: 'منى عادل حسن', national_id: '29506151234561', gender: 'female', phone: '01112345678', department: 'Customer service', position: 'Customer service agent', manager: 'EMP-0101', hire_date: '2025-01-15', employment_type: 'full_time', basic_salary: 9000, status: 'active' },
    ],
  });

  // ---------- units ----------
  const STATUS_IMPORTABLE = ['available', 'blocked'];
  imports.register({
    key: 'units',
    module: '/admin/units',
    pages: ['/admin/units'],
    area: 'property',
    order: 10,
    icon: 'unit',
    table: 'units',
    title: L('Units', 'الوحدات'),
    summary: L('Every shop, kiosk and space: area, level and list rates.', 'كل محل وكشك ومساحة: المساحة والدور وأسعار القائمة.'),
    notes: L('Holds, reservations and leases set a unit’s status by themselves; an import only sets Available or Blocked. Merging and splitting units stay on the unit page.', 'الحجز المؤقت والحجز والعقود تضبط حالة الوحدة تلقائيًا؛ الاستيراد يضبط «متاحة» أو «محجوبة» فقط. دمج الوحدات وتقسيمها يتم من صفحة الوحدة.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Unit code', 'رمز الوحدة'), type: 'code', required: true, max: 20, width: 14, example: 'F1-04', aliases: ['unit', 'unit no', 'shop', 'shop no', 'رقم الوحده', 'الوحده', 'المحل'], help: L('Unique. A code already in the system updates that unit.', 'فريد. الكود الموجود في النظام يحدّث الوحدة نفسها.') },
      { key: 'zone', label: L('Level', 'المستوى'), type: 'enum', required: true, enum: () => rawLabels(M.ZONES), width: 18, example: 'upper', keepOnUpdate: true },
      { key: 'level', label: L('Floor', 'الدور'), type: 'text', max: 4, width: 10, example: '1', keepOnUpdate: true, help: L('G, B1, 1, 2…', 'G أو B1 أو 1 أو 2…') },
      { key: 'indoor_m2', label: L('Indoor area (m²)', 'المساحة الداخلية (م²)'), type: 'number', required: true, min: 0, maxValue: 100000, width: 16, example: 120 },
      { key: 'terrace_m2', label: L('Terrace (m²)', 'التراس (م²)'), type: 'number', min: 0, maxValue: 100000, width: 13, example: 0 },
      { key: 'rent_m2', label: L('List rent per m² a month', 'الإيجار للمتر شهريًا'), type: 'money', width: 18, help: L('Empty uses the default for its level (Settings).', 'الفارغ يأخذ السعر الافتراضي لمستواه (الإعدادات).') },
      { key: 'terrace_rent_m2', label: L('Terrace per m² a month', 'التراس للمتر شهريًا'), type: 'money', width: 18 },
      { key: 'service_m2', label: L('Service per m² a month', 'رسوم الخدمات للمتر شهريًا'), type: 'money', width: 18 },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: () => rawLabels(M.UNIT_STATUS), width: 14, example: 'available', help: L('Available or Blocked. Other statuses come from holds, offers and leases.', 'متاحة أو محجوبة. الحالات الأخرى تأتي من الحجوزات والعروض والعقود.') },
      { key: 'frontage', label: L('Frontage / position', 'الواجهة / الموقع'), type: 'text', max: 200, width: 26 },
      { key: 'notes', label: L('Notes', 'ملاحظات'), type: 'text', max: 2000, multiline: true, width: 30 },
    ],
    rowCheck(row, ctx) {
      const cur = ctx.current;
      if (cur && cur.status === 'retired') { ctx.error('code', 'imp|This unit was merged or split; it cannot be changed.'); return; }
      const want = row.status || (cur ? cur.status : 'available');
      if (!cur && !STATUS_IMPORTABLE.includes(want)) ctx.error('status', 'imp|A new unit is Available or Blocked.');
      if (cur && want !== cur.status && (!STATUS_IMPORTABLE.includes(want) || !STATUS_IMPORTABLE.includes(cur.status))) ctx.error('status', 'imp|This status is set by holds, offers and leases, not by an import.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO units (code, level, zone, indoor_m2, terrace_m2, rent_m2, terrace_rent_m2, service_m2, status, frontage, notes, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          row.code, row.level || '1', row.zone, row.indoor_m2 || 0, row.terrace_m2 || 0, row.rent_m2, row.terrace_rent_m2, row.service_m2, row.status || 'available', row.frontage, row.notes,
          500 + db.value('SELECT COUNT(*) FROM units'), now()).lastInsertRowid);
        ctx.log('Added a unit', 'unit', id, row.code);
        return id;
      }
      const u = db.get('SELECT * FROM units WHERE id = ?', ctx.id);
      const status = STATUS_IMPORTABLE.includes(u.status) && STATUS_IMPORTABLE.includes(row.status) ? row.status : u.status;
      db.run('UPDATE units SET rent_m2 = ?, terrace_rent_m2 = ?, service_m2 = ?, status = ?, indoor_m2 = ?, terrace_m2 = ?, frontage = ?, notes = ?, updated_at = ? WHERE id = ?',
        row.rent_m2, row.terrace_rent_m2, row.service_m2, status, row.indoor_m2 ?? u.indoor_m2, row.terrace_m2 ?? 0, row.frontage, row.notes, now(), ctx.id);
      const changes = [];
      if (String(row.rent_m2 ?? '') !== String(u.rent_m2 ?? '')) changes.push(`rent ${u.rent_m2 ?? '—'} → ${row.rent_m2 ?? '—'}`);
      if (status !== u.status) changes.push(`${u.status} → ${status}`);
      ctx.log('Updated a unit', 'unit', ctx.id, `${u.code}${changes.length ? ` · ${changes.join(', ')}` : ''}`);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM units ORDER BY sort, code').map((u) => ({
      $id: u.id, code: u.code, zone: u.zone, level: u.level, indoor_m2: u.indoor_m2, terrace_m2: u.terrace_m2, rent_m2: u.rent_m2, terrace_rent_m2: u.terrace_rent_m2,
      service_m2: u.service_m2, status: u.status, frontage: u.frontage, notes: u.notes,
    })),
    uses: (db, id, o) => imports.usesOf('units', id, { ...o, entity: 'unit' }),
    link: (id) => `/admin/units/${id}`,
    label: (v) => v.code,
    examples: [
      { code: 'F1-01', zone: 'upper', level: '1', indoor_m2: 145, terrace_m2: 0, rent_m2: 1500, service_m2: 140, status: 'available', frontage: L('Facing the escalators', 'مواجهة للسلالم المتحركة') },
      { code: 'K-03', zone: 'kiosk', level: 'G', indoor_m2: 9, status: 'available', notes: L('Kiosk by the main entrance', 'كشك بجوار المدخل الرئيسي') },
    ],
  });

  // ---------- brands (with their main contact, store and legal details) ----------
  const LEGAL = ['legal_name', 'cr_number', 'tax_id', 'vat_number', 'legal_address', 'signatory_name', 'signatory_title', 'signatory_id', 'bank_name', 'iban'];
  const STORE = ['store_manager', 'store_phone', 'store_email', 'trading_hours', 'opening_date', 'emergency_name', 'emergency_phone', 'insurance_policy', 'insurance_expiry'];
  const CONTACT = ['contact_name', 'contact_title', 'contact_email', 'contact_phone'];
  const legal = L('Legal details (managers only)', 'البيانات القانونية (للمديرين فقط)');
  imports.register({
    key: 'brands',
    module: '/admin/brands',
    pages: ['/admin/brands'],
    area: 'property',
    order: 20,
    icon: 'brand',
    table: 'brands',
    title: L('Brands', 'العلامات التجارية'),
    summary: L('Brands and tenants: profile, main contact, store and legal details.', 'العلامات والمستأجرون: البيانات والمسؤول والمحل والبيانات القانونية.'),
    notes: L('One row per brand. The contact columns set the brand’s main contact (a new one is added if the name or email is not on file). Legal details need a manager.', 'صف لكل علامة. أعمدة جهة الاتصال تضبط جهة الاتصال الرئيسية (تُضاف جهة جديدة إن لم يكن الاسم أو البريد مسجلًا). البيانات القانونية تحتاج صلاحية مدير.'),
    allowed: (req) => h.can(req, 'agent'),
    keys: ['name'],
    columns: [
      { key: 'name', label: L('Brand', 'العلامة التجارية'), type: 'text', required: true, max: 160, width: 24, example: 'Maison Lune', aliases: ['brand name', 'tenant', 'tenant name', 'shop name', 'اسم العلامه', 'المستاجر', 'اسم المحل'], help: L('A brand already in the system (same name) is updated.', 'العلامة الموجودة في النظام بنفس الاسم يتم تحديثها.') },
      { key: 'category', label: L('Category', 'الفئة'), type: 'enum', enum: () => rawLabels(M.CATEGORIES), width: 22, example: 'fashion', help: L('Empty means Other.', 'الفارغ يعني «أخرى».') },
      { key: 'origin', label: L('Origin / group', 'المنشأ / المجموعة'), type: 'text', max: 120, width: 18, example: 'Egyptian' },
      { key: 'tier', label: L('Positioning', 'التموضع'), type: 'enum', enum: () => Object.entries(TIERS).map(([k, key]) => [k, lab(key)]), width: 14, example: 'premium' },
      { key: 'stores', label: L('Stores in Egypt', 'عدد الفروع في مصر'), type: 'int', min: 0, maxValue: 100000, width: 14, example: 12 },
      { key: 'website', label: L('Website', 'الموقع الإلكتروني'), type: 'text', max: 200, width: 26, example: 'https://maisonlune.com', transform: (v) => (/^https?:\/\//i.test(v) ? { value: v } : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v) ? { value: `https://${v}`, warn: 'imp|Added https:// to the website.' } : { error: 'imp|A website starts with https://' }) },
      { key: 'instagram', label: L('Instagram', 'إنستجرام'), type: 'text', max: 80, width: 16, example: '@maisonlune' },
      { key: 'contact_name', label: L('Main contact', 'جهة الاتصال الرئيسية'), type: 'text', max: 120, width: 22, example: 'Laila Hamdy' },
      { key: 'contact_title', label: L('Contact’s job title', 'المسمى الوظيفي لجهة الاتصال'), type: 'text', max: 120, width: 20, example: 'Expansion manager' },
      { key: 'contact_email', label: L('Contact email', 'بريد جهة الاتصال'), type: 'email', width: 26, example: 'laila@maisonlune.com' },
      { key: 'contact_phone', label: L('Contact phone', 'هاتف جهة الاتصال'), type: 'phone', width: 16, example: '01001234567' },
      { key: 'store_manager', label: L('Store manager', 'مدير المحل'), type: 'text', max: 120, width: 18 },
      { key: 'store_phone', label: L('Store phone', 'هاتف المحل'), type: 'phone', width: 16 },
      { key: 'store_email', label: L('Store email', 'بريد المحل'), type: 'email', width: 24 },
      { key: 'trading_hours', label: L('Trading hours', 'مواعيد العمل'), type: 'text', max: 80, width: 18, example: '10:00–24:00' },
      { key: 'opening_date', label: L('Opening date', 'تاريخ الافتتاح'), type: 'date', width: 14 },
      { key: 'emergency_name', label: L('Emergency contact', 'جهة اتصال للطوارئ'), type: 'text', max: 120, width: 20 },
      { key: 'emergency_phone', label: L('Emergency phone', 'هاتف الطوارئ'), type: 'phone', width: 16 },
      { key: 'insurance_policy', label: L('Insurance policy no.', 'رقم وثيقة التأمين'), type: 'text', max: 80, width: 18 },
      { key: 'insurance_expiry', label: L('Insurance expiry', 'انتهاء التأمين'), type: 'date', width: 15 },
      { key: 'legal_name', label: L('Legal name', 'الاسم القانوني'), type: 'text', max: 200, width: 26, help: legal },
      { key: 'cr_number', label: L('Commercial register no.', 'رقم السجل التجاري'), type: 'text', max: 40, width: 18, help: legal },
      { key: 'tax_id', label: L('Tax card no.', 'رقم البطاقة الضريبية'), type: 'text', max: 40, width: 16, help: legal },
      { key: 'vat_number', label: L('VAT registration no.', 'رقم التسجيل في ضريبة القيمة المضافة'), type: 'text', max: 40, width: 18, help: legal },
      { key: 'legal_address', label: L('Registered address', 'العنوان المسجل'), type: 'text', max: 300, width: 28, help: legal },
      { key: 'signatory_name', label: L('Signatory', 'المفوض بالتوقيع'), type: 'text', max: 120, width: 20, help: legal },
      { key: 'signatory_title', label: L('Signatory’s title', 'صفة المفوض بالتوقيع'), type: 'text', max: 120, width: 18, help: legal },
      { key: 'signatory_id', label: L('Signatory’s ID no.', 'رقم هوية المفوض'), type: 'text', max: 40, width: 18, help: legal },
      { key: 'bank_name', label: L('Bank', 'البنك'), type: 'text', max: 120, width: 16, help: legal },
      { key: 'iban', label: L('IBAN', 'رقم الحساب الدولي'), type: 'text', max: 60, width: 32, help: legal, transform: (v) => ({ value: ibanOf(v) }) },
      { key: 'notes', label: L('Notes', 'ملاحظات'), type: 'text', max: 3000, multiline: true, width: 30 },
    ],
    find: (db, v) => {
      const hits = db.all('SELECT id FROM brands WHERE lower(trim(name)) = lower(trim(?))', v.name);
      if (hits.length > 1) return { error: 'imp|More than one brand in the system has this name; rename one of them first.' };
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      if (row.iban) {
        if (row.iban.startsWith('EG') && !/^EG\d{27}$/.test(row.iban)) ctx.error('iban', 'imp|An Egyptian IBAN is EG followed by 27 digits.');
        else if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(row.iban)) ctx.error('iban', 'imp|That IBAN does not look right.');
      }
      if (!row.contact_name && CONTACT.slice(1).some((k) => ctx.provided.has(k))) ctx.error('contact_name', 'imp|Give the contact’s name with their details.');
      if (!ctx.can('manager')) {
        const cur = ctx.current || {};
        const touched = LEGAL.filter((k) => ctx.provided.has(k) && String(row[k] ?? '') !== String(cur[k] ?? ''));
        if (touched.length) ctx.error(touched[0], 'imp|Legal details need a manager.');
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      let id = ctx.id;
      const category = row.category || 'other';
      if (!id) {
        id = Number(db.run('INSERT INTO brands (name, category, origin, tier, stores, website, instagram, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', row.name, category, row.origin, row.tier, row.stores, row.website, row.instagram, row.notes, now()).lastInsertRowid);
        ctx.log('Added a brand', 'brand', id, row.name);
      } else {
        db.run('UPDATE brands SET name = ?, category = ?, origin = ?, tier = ?, stores = ?, website = ?, instagram = ?, notes = ? WHERE id = ?', row.name, category, row.origin, row.tier, row.stores, row.website, row.instagram, row.notes, id);
        ctx.log('Updated a brand', 'brand', id, row.name);
      }
      db.run(`UPDATE brands SET ${[...LEGAL, ...STORE].map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...[...LEGAL, ...STORE].map((k) => (k === 'iban' ? ibanOf(row.iban) : row[k] ?? null)), now(), id);
      // the main contact: the one with this email, else this name, else a new one
      if (row.contact_name) {
        const c = (row.contact_email && db.get('SELECT * FROM contacts WHERE brand_id = ? AND lower(email) = lower(?)', id, row.contact_email))
          || db.get('SELECT * FROM contacts WHERE brand_id = ? AND lower(trim(name)) = lower(trim(?))', id, row.contact_name);
        db.run('UPDATE contacts SET primary_contact = 0 WHERE brand_id = ?', id);
        if (c) db.run('UPDATE contacts SET name = ?, title = ?, email = ?, phone = ?, primary_contact = 1 WHERE id = ?', row.contact_name, row.contact_title, row.contact_email, row.contact_phone, c.id);
        else {
          db.run('INSERT INTO contacts (brand_id, name, title, email, phone, primary_contact, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', id, row.contact_name, row.contact_title, row.contact_email, row.contact_phone, now());
          ctx.log('Added a contact', 'brand', id, `${row.contact_name} · ${row.name}`);
        }
      }
      return id;
    },
    export: (db) => db.all(`SELECT b.*, c.name c_name, c.title c_title, c.email c_email, c.phone c_phone FROM brands b
      LEFT JOIN contacts c ON c.id = (SELECT x.id FROM contacts x WHERE x.brand_id = b.id ORDER BY x.primary_contact DESC, x.id LIMIT 1) ORDER BY b.name`).map((b) => ({
      $id: b.id, name: b.name, category: b.category, origin: b.origin, tier: b.tier, stores: b.stores, website: b.website, instagram: b.instagram,
      contact_name: b.c_name, contact_title: b.c_title, contact_email: b.c_email, contact_phone: b.c_phone,
      ...Object.fromEntries([...STORE, ...LEGAL].map((k) => [k, b[k]])), notes: b.notes,
    })),
    // a brand and its contacts are one record for undo
    snapshot: (db, id) => {
      const b = db.get('SELECT * FROM brands WHERE id = ?', id);
      return b ? { brand: b, contacts: db.all('SELECT * FROM contacts WHERE brand_id = ? ORDER BY id', id) } : null;
    },
    restore: (db, snap) => {
      const cols = Object.keys(snap.brand).filter((k) => k !== 'id');
      db.run(`UPDATE brands SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => snap.brand[k]), snap.brand.id);
      const keep = new Set(snap.contacts.map((c) => c.id));
      for (const c of db.all('SELECT id FROM contacts WHERE brand_id = ?', snap.brand.id)) if (!keep.has(c.id)) { db.run('UPDATE leads SET contact_id = NULL WHERE contact_id = ?', c.id); db.run('DELETE FROM contacts WHERE id = ?', c.id); }
      for (const c of snap.contacts) {
        const ccols = Object.keys(c).filter((k) => k !== 'id');
        db.run(`UPDATE contacts SET ${ccols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...ccols.map((k) => c[k]), c.id);
      }
    },
    remove: (db, id) => {
      db.run('DELETE FROM contacts WHERE brand_id = ?', id);
      db.run('DELETE FROM brands WHERE id = ?', id);
    },
    uses: (db, id, o) => imports.usesOf('brands', id, { ...o, ignore: ['contacts'], entity: 'brand' }),
    link: (id) => `/admin/brands/${id}`,
    label: (v) => v.name,
    examples: [
      { name: 'Maison Lune', category: 'fashion', origin: 'Egyptian', tier: 'premium', stores: 12, website: 'https://maisonlune.com', instagram: '@maisonlune', contact_name: 'Laila Hamdy', contact_title: 'Expansion manager', contact_email: 'laila@maisonlune.com', contact_phone: '01001234567', trading_hours: '10:00–24:00' },
      { name: 'Kahwa House', category: 'fnb', origin: 'Egyptian', tier: 'mid', stores: 4, contact_name: 'Omar Fathy', contact_email: 'omar@kahwahouse.com', contact_phone: '01112345678', legal_name: 'Kahwa House for Restaurants S.A.E.', cr_number: '123456' },
    ],
  });
};
