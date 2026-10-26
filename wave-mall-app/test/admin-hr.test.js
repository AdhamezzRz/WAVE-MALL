'use strict';

// HR: privacy (HR access only), Egyptian leave and payroll rules, one payroll a month,
// approval locks, and the sample team loading and clearing cleanly.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const hr = require('../src/admin/routes/hr');

const S = { si_employee_pct: '11', si_employer_pct: '18.75', si_min_wage: '2300', si_max_wage: '14500', work_days_month: '26', annual_leave_days: '21' };

test('hr: working days leave out Fridays', () => {
  assert.equal(hr.workDays('2026-10-26', '2026-11-01'), 6); // Mon–Sun, one Friday
  assert.equal(hr.workDays('2026-10-30', '2026-10-30'), 0); // a Friday
  assert.equal(hr.workDays('2026-11-02', '2026-11-05'), 4);
  assert.equal(hr.workDays('2026-11-05', '2026-11-02'), 0);
});

test('hr: annual leave is 21 days, 30 after ten years or from age 50', () => {
  assert.equal(hr.entitlement({ hire_date: '2020-01-01', birth_date: '1990-01-01' }, 21, 2026), 21);
  assert.equal(hr.entitlement({ hire_date: '2016-06-01', birth_date: '1990-01-01' }, 21, 2026), 30);
  assert.equal(hr.entitlement({ hire_date: '2024-01-01', birth_date: '1976-12-31' }, 21, 2026), 30);
  assert.equal(hr.entitlement({ hire_date: '2024-01-01', annual_leave_days: 25 }, 21, 2026), 25);
});

test('hr: insured wage is kept within the legal limits', () => {
  assert.equal(hr.insuredWage({ basic_salary: 95000, allowances: 25000 }, S), 14500);
  assert.equal(hr.insuredWage({ basic_salary: 1500, allowances: 0 }, S), 2300);
  assert.equal(hr.insuredWage({ basic_salary: 8000, allowances: 2000 }, S), 10000);
  assert.equal(hr.insuredWage({ basic_salary: 8000, allowances: 2000, insured_wage: 9000 }, S), 9000);
});

test('hr: a payslip line (insurance, unpaid leave, net, pro-rating)', () => {
  const e = { basic_salary: 9100, allowances: 1300, hire_date: '2020-01-01' };
  const l = hr.payLine(e, '2026-11', S, { unpaidDays: 2, overtime: 500, bonus: 0, deductions: 100, tax: 250 });
  assert.equal(l.basic, 9100);
  assert.equal(l.insurance_employee, 1144); // 11% of 10,400
  assert.equal(l.insurance_employer, 1950); // 18.75% of 10,400
  assert.equal(l.unpaid, 800); // 10,400 / 26 × 2
  assert.equal(l.net, 9100 + 1300 + 500 - 100 - 800 - 1144 - 250);
  // joined on the 16th of a 30-day month: half the pay
  const half = hr.payLine({ ...e, hire_date: '2026-11-16' }, '2026-11', S);
  assert.equal(half.basic, 4550);
  assert.equal(half.worked, 15);
  // the top of the insured wage
  assert.equal(hr.payLine({ basic_salary: 95000, allowances: 25000, hire_date: '2019-03-01' }, '2026-11', S).insurance_employee, 1595);
});

// ---------- through the app ----------
let server;
let base;
let app;
function client() {
  const jar = new Map();
  const go = async (path, opts = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const flash = () => {
    try { return JSON.parse(decodeURIComponent(jar.get('wv_flash') || '')).text; } catch { return ''; }
  };
  return { go, flash, jar };
}
const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const csrfOf = (html) => html.match(/name="csrf" content="([^"]+)"/)[1];
const token = (html) => html.match(/name="_token" value="([^"]+)"/)[1];

before(async () => {
  app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready; // the office opens in the background on older Node (sql.js)
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('hr: only administrators and people with HR access see People', async () => {
  const admin = client();
  const setup = await (await admin.go('/admin/setup')).text();
  await admin.go('/admin/setup', form({ _token: token(setup), name: 'Owner', email: 'owner@thewave.test', password: 'long-enough-1' }));
  let html = await (await admin.go('/admin')).text();
  assert.match(html, /href="\/admin\/hr\/payroll"/);
  const csrf = csrfOf(html);
  await admin.go('/admin/team', form({ _csrf: csrf, name: 'Agent', email: 'agent@thewave.test', role: 'manager' }));
  const pw = admin.flash().match(/password is (\S+)/)[1];

  const agent = client();
  const login = await (await agent.go('/admin/login')).text();
  await agent.go('/admin/login', form({ _token: token(login), email: 'agent@thewave.test', password: pw }));
  html = await (await agent.go('/admin')).text();
  assert.doesNotMatch(html, /\/admin\/hr/, 'no People menu without HR access');
  for (const p of ['/admin/hr', '/admin/hr/leave', '/admin/hr/payroll', '/admin/hr/employees/new', '/admin/hr/employees.csv']) {
    const r = await agent.go(p);
    assert.equal(r.status, 303, p);
    assert.doesNotMatch(r.headers.get('location'), /\/admin\/hr/, p);
  }
  const r = await agent.go('/admin/hr/employees', form({ _csrf: csrfOf(html), name: 'X', position: 'Y', hire_date: '2026-01-01', basic_salary: '1' }));
  assert.equal(r.status, 303);
  assert.equal(app.locals.admin.db.value('SELECT COUNT(*) FROM employees'), 0, 'nothing written');

  // grant HR access: now it opens
  const u = app.locals.admin.db.get("SELECT id FROM users WHERE email = 'agent@thewave.test'");
  await admin.go(`/admin/team/${u.id}`, form({ _csrf: csrf, role: 'manager', active: '1', hr: '1' }));
  assert.equal((await agent.go('/admin/hr')).status, 200);
  assert.match(await (await agent.go('/admin')).text(), /href="\/admin\/hr"/);
});

test('hr: one payroll per month, and approval locks it', async () => {
  const c = client();
  const login = await (await c.go('/admin/login')).text();
  await c.go('/admin/login', form({ _token: token(login), email: 'owner@thewave.test', password: 'long-enough-1' }));
  const csrf = csrfOf(await (await c.go('/admin')).text());
  let r = await c.go('/admin/hr/employees', form({ _csrf: csrf, name: 'Walid Fathy', national_id: '28809110101234', position: 'Security Officer', hire_date: '2021-01-05', basic_salary: '8500', allowances: '2000' }));
  const id = r.headers.get('location').split('/').pop();
  const db = app.locals.admin.db;
  assert.equal(db.get('SELECT birth_date FROM employees WHERE id = ?', id).birth_date, '1988-09-11', 'birth date read from the national ID');
  r = await c.go('/admin/hr/employees', form({ _csrf: csrf, name: 'Bad', position: 'x', hire_date: '2026-01-01', basic_salary: '1', national_id: '12345' }));
  assert.match(c.flash(), /14 digits/);

  // approved unpaid leave reaches the payslip
  await c.go('/admin/hr/leave', form({ _csrf: csrf, employee_id: id, type: 'unpaid', start_date: '2026-11-02', end_date: '2026-11-05', approve: '1' }));
  assert.equal(db.get("SELECT days FROM leave_requests WHERE employee_id = ?", id).days, 4);
  r = await c.go('/admin/hr/payroll', form({ _csrf: csrf, period: '2026-11' }));
  const run = r.headers.get('location').split('/').pop();
  let line = db.get('SELECT * FROM payroll_lines WHERE run_id = ? AND employee_id = ?', run, id);
  assert.equal(line.unpaid_days, 4);
  assert.equal(line.net, Math.round((10500 - (10500 / 26) * 4 - 1155) * 100) / 100);

  r = await c.go('/admin/hr/payroll', form({ _csrf: csrf, period: '2026-11' }));
  assert.match(c.flash(), /already has a payroll/);
  assert.equal(db.value("SELECT COUNT(*) FROM payroll_runs WHERE period = '2026-11'"), 1);

  await c.go(`/admin/hr/payroll/${run}`, form({ _csrf: csrf, [`overtime_${id}`]: '600', [`tax_${id}`]: '120' }));
  line = db.get('SELECT * FROM payroll_lines WHERE run_id = ? AND employee_id = ?', run, id);
  assert.equal(line.overtime, 600);
  assert.equal(line.tax, 120);
  await c.go(`/admin/hr/payroll/${run}/approve`, form({ _csrf: csrf }));
  await c.go(`/admin/hr/payroll/${run}`, form({ _csrf: csrf, [`overtime_${id}`]: '9999' }));
  assert.match(c.flash(), /locked/);
  assert.equal(db.get('SELECT overtime FROM payroll_lines WHERE run_id = ? AND employee_id = ?', run, id).overtime, 600);
  // a salary change after approval does not move the approved payslip
  await c.go(`/admin/hr/employees/${id}`, form({ _csrf: csrf, name: 'Walid Fathy', position: 'Security Officer', hire_date: '2021-01-05', basic_salary: '20000', allowances: '2000' }));
  assert.equal(db.get('SELECT basic FROM payroll_lines WHERE run_id = ? AND employee_id = ?', run, id).basic, 8500);

  r = await c.go(`/admin/hr/payroll/${run}/slip/${id}?doc=ar`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<html lang="ar" dir="rtl"/);
  r = await c.go(`/admin/hr/payroll/${run}/bank.csv`);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel reads Arabic names');
  assert.match(bytes.toString('utf8'), /EMP-0001,Walid Fathy/);
});

test('hr: the sample team loads with its files and clears completely', async () => {
  const c = client();
  const login = await (await c.go('/admin/login')).text();
  await c.go('/admin/login', form({ _token: token(login), email: 'owner@thewave.test', password: 'long-enough-1' }));
  const csrf = csrfOf(await (await c.go('/admin')).text());
  const db = app.locals.admin.db;
  await c.go('/admin/settings/demo', form({ _csrf: csrf }));
  assert.ok(db.value('SELECT COUNT(*) FROM employees WHERE demo = 1') >= 24);
  assert.ok(db.value("SELECT COUNT(*) FROM documents WHERE entity = 'employee'") > 40);
  assert.ok(db.value("SELECT COUNT(*) FROM payroll_runs WHERE demo = 1 AND status = 'paid'") >= 1);
  for (const p of ['/admin/hr', '/admin/hr/leave', '/admin/hr/payroll', '/admin/hr/departments']) assert.equal((await c.go(p)).status, 200, p);
  await c.go('/admin/settings/demo/clear', form({ _csrf: csrf }));
  assert.equal(db.value('SELECT COUNT(*) FROM employees WHERE demo = 1'), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM documents WHERE entity = 'employee' AND entity_id NOT IN (SELECT id FROM employees)"), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM payroll_runs WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM leave_requests WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM employees'), 1, 'the real employee stays');
});
