'use strict';

// Sample HR data: the mall's own team of 25 across 11 departments, leave in every state,
// two paid payrolls and this month's draft, and employee files as small sample PDFs.
// Everything carries demo = 1 so clear() removes exactly it. Names are fictional.

const M = require('./model');
const { samplePdf } = require('./files');
const hr = require('./routes/hr');

const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
const T = () => M.today();
const thisMonth = () => T().slice(5, 7);
const thisYear = () => Number(T().slice(0, 4));
const r2 = (n) => Math.round(n * 100) / 100;

// [name, Arabic name, gender, department, position, basic, allowances, hire, birth, type, extra]
// hire / birth: a date, or a function of today; extra: contract_end, probation_end, ended_at…
function team() {
  const m = thisMonth();
  const y = thisYear();
  return [
    ['Hisham El-Sayed', 'هشام السيد', 'male', 'Management', 'Mall General Manager', 95000, 25000, '2019-03-01', '1975-06-12', 'full_time', { shift: '09:00–17:00' }],
    ['Rania Fouad', 'رانيا فؤاد', 'female', 'Leasing', 'Leasing Director', 70000, 15000, '2020-09-15', '1982-11-03', 'full_time'],
    ['Karim Abdelaziz', 'كريم عبد العزيز', 'male', 'Leasing', 'Leasing Executive', 28000, 6000, '2023-02-01', '1994-07-22', 'full_time'],
    ['Nour Hassan', 'نور حسن', 'female', 'Leasing', 'Leasing Executive', 26000, 6000, '2024-01-10', '1996-04-05', 'full_time'],
    ['Tarek Mansour', 'طارق منصور', 'male', 'Finance', 'Finance Manager', 60000, 12000, '2014-05-04', '1980-02-18', 'full_time'],
    ['Mai Abdelrahman', 'مي عبد الرحمن', 'female', 'Finance', 'Accountant', 18000, 4000, '2022-06-12', '1995-10-30', 'full_time'],
    ['Ahmed Samir', 'أحمد سمير', 'male', 'Operations', 'Operations Manager', 55000, 10000, `2019-${m}-08`, '1983-01-09', 'full_time'],
    ['Sherif Kamal', 'شريف كمال', 'male', 'Operations', 'Parking Supervisor', 10000, 2500, '2019-12-01', '1987-03-27', 'full_time', { shift: 'Rotating' }],
    ['Mostafa Gamal', 'مصطفى جمال', 'male', 'Facilities & maintenance', 'Facility Engineer', 32000, 7000, '2021-03-14', '1990-05-16', 'full_time'],
    ['Mahmoud Adel', 'محمود عادل', 'male', 'Facilities & maintenance', 'MEP Technician', 12500, 3000, '2022-11-01', '1993-12-02', 'full_time', { shift: 'Rotating' }],
    ['Youssef Ibrahim', 'يوسف إبراهيم', 'male', 'Facilities & maintenance', 'MEP Technician', 12000, 3000, iso(-40), '1999-03-21', 'full_time', { probation_end: iso(50), shift: 'Rotating' }],
    ['Ashraf Zaki', 'أشرف زكي', 'male', 'Security', 'Security Supervisor', 15000, 3500, '2018-10-01', '1974-08-08', 'full_time', { shift: 'Rotating' }],
    ['Walid Fathy', 'وليد فتحي', 'male', 'Security', 'Security Officer', 8500, 2000, '2021-01-05', '1988-09-11', 'full_time', { shift: 'Night' }],
    ['Islam Reda', 'إسلام رضا', 'male', 'Security', 'Security Officer', 8500, 2000, '2022-04-17', '1991-06-30', 'full_time', { shift: 'Day' }],
    ['Hany Shawky', 'هاني شوقي', 'male', 'Security', 'Security Officer', 8000, 2000, '2024-07-01', '1997-02-14', 'fixed_term', { contract_end: iso(40), shift: 'Night' }],
    ['Samira Lotfy', 'سميرة لطفي', 'female', 'Housekeeping', 'Housekeeping Supervisor', 11000, 2500, '2020-02-02', '1985-04-19', 'full_time'],
    ['Eman Saad', 'إيمان سعد', 'female', 'Housekeeping', 'Housekeeping Attendant', 7000, 1500, '2023-05-20', '1992-08-25', 'outsourced'],
    ['Dina Mahmoud', 'دينا محمود', 'female', 'Customer service', 'Customer Service Lead', 16000, 3500, '2021-09-09', `1990-${m}-19`, 'full_time'],
    ['Hana Ali', 'هنا علي', 'female', 'Customer service', 'Customer Service Agent', 9500, 2000, iso(-45), '2001-01-15', 'full_time', { probation_end: iso(45) }],
    ['Laila Khaled', 'ليلى خالد', 'female', 'Marketing', 'Marketing Manager', 48000, 9000, '2020-11-23', '1986-07-07', 'full_time'],
    ['Omar Nabil', 'عمر نبيل', 'male', 'Marketing', 'Graphic Designer', 20000, 4000, '2023-08-06', '1996-09-01', 'full_time'],
    ['Ziad Hamdy', 'زياد حمدي', 'male', 'Marketing', 'Marketing Intern', 5000, 0, iso(-90), '2003-05-05', 'intern', { contract_end: iso(55) }],
    ['Yasmin Sherif', 'ياسمين شريف', 'female', 'HR & admin', 'HR Officer', 22000, 5000, '2021-04-11', '1993-03-03', 'full_time'],
    ['Amr Hosny', 'عمرو حسني', 'male', 'IT', 'IT Specialist', 26000, 5000, '2022-01-16', `1992-${m}-04`, 'full_time'],
    ['Mona Ragab', 'منى رجب', 'female', 'Finance', 'Cashier', 9000, 2000, '2021-03-01', '1994-12-12', 'full_time', { ended_at: iso(-70), end_reason: 'resigned', status: 'left' }],
  ];
}

const BANKS = [['CIB', 'EG380010012300000001001234561'], ['National Bank of Egypt', 'EG200003004200000000123456780'], ['Banque Misr', 'EG610002000700000000987654321'], ['QNB Alahli', 'EG830037010800000001234567012']];
// A plausible 14-digit national ID: century, yymmdd, governorate 01 (Cairo), serial, gender digit, check digit.
function nationalId(birth, gender, i) {
  const c = birth < '2000' ? '2' : '3';
  const serial = String(100 + ((i * 37) % 899));
  const g = gender === 'male' ? String(1 + 2 * (i % 5)) : String(2 * (i % 5));
  return `${c}${birth.slice(2, 4)}${birth.slice(5, 7)}${birth.slice(8, 10)}01${serial}${g}${(i * 7) % 10}`;
}

function load(db, admin, { files } = {}) {
  if (db.value('SELECT COUNT(*) FROM employees WHERE demo = 1')) return;
  const now = M.now();
  const s = db.settings();
  db.tx(() => {
    // departments: reuse any that already exist
    const dept = {};
    hr.DEFAULT_DEPTS.forEach((name, i) => {
      const found = db.get('SELECT id FROM departments WHERE name = ? COLLATE NOCASE', name);
      dept[name] = found ? found.id : Number(db.run('INSERT INTO departments (name, sort, demo) VALUES (?, ?, 1)', name, i + 1).lastInsertRowid);
    });
    let last = db.all("SELECT code FROM employees WHERE code LIKE 'EMP-%'").map((r) => Number(r.code.slice(4)) || 0).sort((a, b) => b - a)[0] || 0;
    const ids = {};
    team().forEach(([name, nameAr, gender, d, position, basic, allow, hire, birth, type, extra = {}], i) => {
      const [bank, iban] = BANKS[i % BANKS.length];
      const first = name.split(' ')[0].toLowerCase();
      const id = Number(db.run(
        `INSERT INTO employees (code, name, name_ar, national_id, birth_date, gender, nationality, marital_status, phone, email, address, department_id, position,
          hire_date, employment_type, contract_end, probation_end, status, ended_at, end_reason, basic_salary, allowances, insurance_no, bank_name, iban,
          emergency_name, emergency_phone, shift, user_id, demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        `EMP-${String(++last).padStart(4, '0')}`, name, nameAr, nationalId(birth, gender, i + 1), birth, gender, 'Egyptian', i % 3 ? 'married' : 'single',
        `+20 1${i % 3}${i % 2 ? 0 : 2} ${String(2000 + i * 113).slice(0, 4)} ${String(5000 + i * 271).slice(0, 4)}`, `${first}.${name.split(' ').pop().toLowerCase().replace(/[^a-z]/g, '')}@thewave.example`,
        ['New Cairo, Fifth Settlement', 'Heliopolis, Cairo', 'Nasr City, Cairo', 'Al Rehab City', 'Madinaty', 'Maadi, Cairo'][i % 6],
        dept[d], position, hire, type, extra.contract_end || null, extra.probation_end || null, extra.status || 'active', extra.ended_at || null, extra.end_reason || null,
        basic, allow, String(10000000 + i * 7919), bank, iban, `${['Mona', 'Ali', 'Sara', 'Hassan', 'Amal'][i % 5]} ${name.split(' ').pop()}`, `+20 11${i % 10} ${String(3000 + i * 97).slice(0, 4)} ${String(7000 + i * 53).slice(0, 4)}`,
        extra.shift || null, null, now, now,
      ).lastInsertRowid);
      ids[name] = id;
    });
    // reporting lines and heads of department
    const gm = ids['Hisham El-Sayed'];
    const heads = { Management: 'Hisham El-Sayed', Leasing: 'Rania Fouad', Finance: 'Tarek Mansour', Operations: 'Ahmed Samir', 'Facilities & maintenance': 'Mostafa Gamal', Security: 'Ashraf Zaki', Housekeeping: 'Samira Lotfy', 'Customer service': 'Dina Mahmoud', Marketing: 'Laila Khaled', 'HR & admin': 'Yasmin Sherif', IT: 'Amr Hosny' };
    for (const [d, n] of Object.entries(heads)) {
      db.run('UPDATE departments SET head_id = ? WHERE id = ? AND head_id IS NULL', ids[n], dept[d]);
      db.run('UPDATE employees SET manager_id = ? WHERE department_id = ? AND id != ? AND demo = 1', ids[n], dept[d], ids[n]);
      if (ids[n] !== gm) db.run('UPDATE employees SET manager_id = ? WHERE id = ?', gm, ids[n]);
    }
    db.run('UPDATE employees SET manager_id = ? WHERE id IN (?, ?)', ids['Ahmed Samir'], ids['Mostafa Gamal'], ids['Ashraf Zaki']);

    // leave in every state
    const L = (n, type, start, end, status, reason = null, note = null) => {
      const days = hr.workDays(start, end) || 1;
      db.run('INSERT INTO leave_requests (employee_id, type, start_date, end_date, days, reason, status, decided_by, decided_at, decision_note, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
        ids[n], type, start, end, days, reason, status, status === 'pending' ? null : admin ? admin.id : null, status === 'pending' ? null : now, note, admin ? admin.id : null, now);
    };
    const y = thisYear();
    L('Karim Abdelaziz', 'annual', iso(-2), iso(2), 'approved', 'Family trip to Alexandria');
    L('Mai Abdelrahman', 'sick', iso(-1), iso(0), 'approved', 'Flu');
    L('Walid Fathy', 'annual', iso(9), iso(15), 'pending', 'Family wedding in Assiut');
    L('Omar Nabil', 'casual', iso(4), iso(4), 'pending');
    L('Dina Mahmoud', 'annual', iso(20), iso(27), 'pending', 'Summer holiday');
    L('Islam Reda', 'annual', iso(5), iso(7), 'rejected', null, 'Peak season, please choose other dates');
    L('Laila Khaled', 'annual', `${y}-02-08`, `${y}-02-15`, 'approved', 'Winter holiday');
    L('Laila Khaled', 'casual', `${y}-04-12`, `${y}-04-12`, 'approved');
    L('Tarek Mansour', 'annual', `${y}-03-01`, `${y}-03-12`, 'approved');
    L('Samira Lotfy', 'unpaid', iso(-25), iso(-23), 'approved', 'Personal matters');
    L('Hisham El-Sayed', 'hajj', `${y - 1}-06-01`, `${y - 1}-06-25`, 'approved');
    L('Eman Saad', 'casual', iso(-8), iso(-8), 'cancelled');

    // two paid payrolls and this month's draft
    const months = [-2, -1, 0].map((k) => M.addMonths(`${T().slice(0, 7)}-01`, k).slice(0, 7));
    const emps = db.all('SELECT * FROM employees WHERE demo = 1');
    months.forEach((period, k) => {
      if (db.get('SELECT id FROM payroll_runs WHERE period = ?', period)) return;
      const status = k < 2 ? 'paid' : 'draft';
      const runId = Number(db.run('INSERT INTO payroll_runs (period, status, created_by, approved_by, approved_at, paid_at, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        period, status, admin ? admin.id : null, status === 'paid' ? (admin ? admin.id : null) : null, status === 'paid' ? `${period}-25T10:00:00.000Z` : null, status === 'paid' ? `${period}-26` : null, now).lastInsertRowid);
      const start = `${period}-01`;
      const end = M.addDays(M.addMonths(start, 1), -1);
      for (const e of emps) {
        if (e.hire_date > end || (e.ended_at && e.ended_at < start)) continue;
        const unpaid = db.all("SELECT * FROM leave_requests WHERE employee_id = ? AND type = 'unpaid' AND status = 'approved' AND start_date <= ? AND end_date >= ?", e.id, end, start)
          .reduce((a, r) => a + hr.workDays(r.start_date > start ? r.start_date : start, r.end_date < end ? r.end_date : end), 0);
        const ot = /Security|MEP/.test(e.position) ? 1200 + (e.id % 4) * 300 : 0;
        const bonus = k === 1 && /Leasing/.test(e.position) ? 5000 : 0;
        // illustrative tax only: the real figure follows the brackets in force
        const tax = r2(Math.max(0, (e.basic_salary + e.allowances - 15000) * 0.1));
        const l = hr.payLine(e, period, s, { unpaidDays: unpaid, overtime: ot, bonus, tax });
        db.run('INSERT INTO payroll_lines (run_id, employee_id, basic, allowances, overtime, bonus, deductions, unpaid_days, insurance_employee, insurance_employer, tax, net) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          runId, e.id, l.basic, l.allowances, l.overtime, l.bonus, l.deductions, l.unpaid_days, l.insurance_employee, l.insurance_employer, l.tax, l.net);
      }
    });

    // employee files (confidential): contract, ID copy, insurance form; one ID copy missing
    if (files) {
      const doc = (empId, kind, title, name, lines, { issued = null, expires = null } = {}) => {
        const saved = files.save(samplePdf(title, lines), name);
        if (saved.error) return;
        db.run(
          `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, expires_on, confidential, uploaded_by, demo, created_at)
           VALUES (?, 'employee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)`,
          db.nextRef('documents', 'DOC', 4, true), empId, kind, title, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored, issued, expires, admin ? admin.id : null, now,
        );
      };
      for (const e of emps.filter((x) => x.status === 'active')) {
        const slug = e.code.toLowerCase();
        doc(e.id, 'employment_contract', 'Employment contract', `${slug}-contract.pdf`, [`Employee: ${e.name} (${e.code})`, `Position: ${e.position}`, `Start date: ${e.hire_date}`], { issued: e.hire_date, expires: e.contract_end });
        if (e.name !== 'Youssef Ibrahim') doc(e.id, 'national_id', 'National ID copy', `${slug}-national-id.pdf`, [`Name: ${e.name}`, `National ID: ${e.national_id}`], { issued: '2021-01-10', expires: e.name === 'Walid Fathy' ? iso(20) : '2028-01-09' });
        doc(e.id, 'insurance_form', 'Social insurance form 1', `${slug}-form-1.pdf`, [`Insured: ${e.name}`, `Insurance no.: ${e.insurance_no}`], { issued: e.hire_date });
      }
      doc(ids['Laila Khaled'], 'cv', 'CV', 'laila-khaled-cv.pdf', ['Laila Khaled', 'Marketing Manager']);
      doc(ids['Mostafa Gamal'], 'certificate', 'Engineering syndicate card', 'mostafa-gamal-syndicate.pdf', ['Mostafa Gamal', 'Egyptian Engineers Syndicate'], { expires: iso(12) });
    }
  });
}

function clear(db, { files } = {}) {
  const docs = db.all("SELECT id, stored FROM documents WHERE entity = 'employee' AND entity_id IN (SELECT id FROM employees WHERE demo = 1)");
  db.tx(() => {
    db.run("UPDATE documents SET replaces_id = NULL WHERE replaces_id IN (SELECT id FROM documents WHERE entity = 'employee' AND entity_id IN (SELECT id FROM employees WHERE demo = 1))");
    db.run("DELETE FROM documents WHERE entity = 'employee' AND entity_id IN (SELECT id FROM employees WHERE demo = 1)");
    db.run('DELETE FROM payroll_runs WHERE demo = 1');
    db.run('DELETE FROM leave_requests WHERE demo = 1 OR employee_id IN (SELECT id FROM employees WHERE demo = 1)');
    db.run('DELETE FROM payroll_lines WHERE employee_id IN (SELECT id FROM employees WHERE demo = 1)');
    db.run('UPDATE departments SET head_id = NULL WHERE head_id IN (SELECT id FROM employees WHERE demo = 1)');
    db.run('UPDATE employees SET manager_id = NULL WHERE manager_id IN (SELECT id FROM employees WHERE demo = 1)');
    db.run('DELETE FROM employees WHERE demo = 1');
    db.run('DELETE FROM departments WHERE demo = 1 AND id NOT IN (SELECT department_id FROM employees WHERE department_id IS NOT NULL)');
  });
  if (files) for (const d of docs) files.release(db, d.stored);
}

module.exports = { load, clear };
