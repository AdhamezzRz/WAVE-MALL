'use strict';

// Accounting: the double-entry engine (posting rules, VAT, idempotent sync, periods), supplier
// bills, bank reconciliation, fixed assets, the reports' integrity, and the pages behind finance access.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');

let app;
let server;
let base;
let db;
let h;
let L;
const jar = new Map();
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

before(async () => {
  app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  base = `http://127.0.0.1:${server.address().port}`;
  ({ db, h } = app.locals.admin);
  L = h.ledger;
});
after(() => server.close());

async function go(path, opts = {}, cookies = jar) {
  const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (/Max-Age=0/.test(c)) cookies.delete(kv.slice(0, i));
    else cookies.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}
const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const csrfOf = (html) => html.match(/name="csrf" content="([^"]+)"/)[1];
// the lines of the live entry for a source, as { code: net debit }
const linesOf = (base) => {
  const e = L.active(base);
  if (!e) return null;
  const out = {};
  for (const l of L.linesOf(e.id)) out[l.code] = Math.round(((out[l.code] || 0) + l.debit - l.credit) * 100) / 100;
  return out;
};
const balanced = () => {
  const r = db.get('SELECT ROUND(SUM(debit), 2) d, ROUND(SUM(credit), 2) c FROM acc_lines');
  return Math.abs((r.d || 0) - (r.c || 0)) < 0.005;
};
const brand = (name) => Number(db.run("INSERT INTO brands (name, category, created_at) VALUES (?, 'fashion', ?)", name, new Date().toISOString()).lastInsertRowid);

test('accounting: the chart is seeded and manual entries must balance', () => {
  assert.ok(db.value('SELECT COUNT(*) FROM acc_accounts') >= 50);
  for (const key of ['ar', 'ap', 'vat_out', 'vat_in', 'deposits', 'retained', 'inc_rent', 'exp_salaries']) assert.ok(L.byKey(key), key);
  assert.throws(() => L.post({ date: today(), memo: 'x', lines: [{ account: 'petty_cash', debit: 100 }, { account: 'capital', credit: 90 }] }), /equal/);
  assert.throws(() => L.post({ date: today(), memo: 'x', lines: [{ account: 'cash_group', debit: 100 }, { account: 'capital', credit: 100 }] }), /group/);
  assert.throws(() => L.post({ date: today(), memo: 'x', lines: [{ account: 'petty_cash', debit: 100 }] }), /two lines/);
  const e = L.post({ date: today(), memo: 'Capital paid in', lines: [{ account: 'petty_cash', debit: 1000.005 }, { account: 'capital', credit: 1000.005 }] });
  assert.match(e.ref, /^JV-\d{4}-\d{4}$/);
  assert.equal(L.balance(L.idOf('petty_cash')), 1000.01, 'money is rounded to 2 decimals');
  const r = L.reverse(e.id);
  assert.equal(L.entry(e.id).reversed_by, r.id);
  assert.equal(L.balance(L.idOf('petty_cash')), 0);
  assert.throws(() => L.reverse(e.id), /already reversed/);
  assert.ok(balanced());
});

test('accounting: invoices post when issued, with VAT; receipts, reversals and voids follow', () => {
  const b = brand('Ledger Test Brand');
  // issued today, VAT 14% on rent and service
  const inv = h.billing.createInvoice({ brand_id: b, kind: 'rent', rent: 10000, service: 2000, vat_pct: 14, due_date: today() });
  assert.equal(inv.vat, 1680);
  assert.equal(inv.total, 13680);
  assert.deepEqual(linesOf(`inv:${inv.id}`), { 1200: 13680, 4100: -10000, 4200: -2000, 2400: -1680 });
  // a future invoice waits until it falls due
  const later = h.billing.createInvoice({ brand_id: b, kind: 'rent', rent: 5000, vat_pct: 0, due_date: addDays(today(), 40) });
  assert.equal(L.active(`inv:${later.id}`), undefined);
  L.sync({ upTo: addDays(today(), 45) });
  assert.ok(L.active(`inv:${later.id}`), 'posted once due');
  // deposits are held, never VAT, and go to the deposits liability
  const dep = h.billing.createInvoice({ brand_id: b, kind: 'deposit', other: 30000, due_date: today() });
  assert.equal(dep.vat, 0);
  assert.deepEqual(linesOf(`inv:${dep.id}`), { 1200: 30000, 2200: -30000 });
  // a receipt by transfer: bank (clearing until mapped) against receivables
  const { payment } = h.billing.recordPayment({ invoice_id: inv.id, amount: 13680, date: today(), method: 'transfer' });
  assert.deepEqual(linesOf(`pay:${payment.id}`), { 1190: 13680, 1200: -13680 });
  h.billing.reversePayment(payment.id, { note: 'Bounced cheque' });
  assert.equal(L.active(`pay:${payment.id}`), undefined, 'the receipt is reversed');
  assert.equal(db.value("SELECT COUNT(*) FROM acc_entries WHERE source_base = ?", `rev:pay:${payment.id}:${db.value('SELECT id FROM acc_entries WHERE source_base = ?', `pay:${payment.id}`)}`), 1);
  // void
  const v = h.billing.createInvoice({ brand_id: b, kind: 'other', other: 700, vat_pct: 14, due_date: today() });
  assert.ok(L.active(`inv:${v.id}`));
  h.billing.voidInvoice(v.id);
  assert.equal(L.active(`inv:${v.id}`), undefined);
  // sync twice: nothing new
  const n = db.value('SELECT COUNT(*) FROM acc_entries');
  L.sync({ upTo: addDays(today(), 45) });
  L.sync({ upTo: addDays(today(), 45) });
  assert.equal(db.value('SELECT COUNT(*) FROM acc_entries'), n, 'sync is idempotent');
  assert.equal(db.value('SELECT COUNT(*) FROM acc_entries GROUP BY source HAVING COUNT(*) > 1 AND source IS NOT NULL') || 0, 0);
  assert.equal(L.pending().total, 0);
  // AR in the books equals what tenants owe on issued invoices
  const owed = db.value("SELECT ROUND(SUM(total - paid), 2) FROM invoices WHERE status IN ('open','partial') AND due_date <= ?", addDays(today(), 45));
  assert.equal(L.balance(L.idOf('ar'), { to: addDays(today(), 45) }), owed);
  // VAT: output in the books, by the report
  assert.equal(L.vatSummary({ from: addDays(today(), -1), to: addDays(today(), 1) }).output, 1680);
  assert.ok(balanced());
});

test('accounting: key money spread over the lease when deferred', () => {
  L.setS('key_treatment', 'deferred');
  const b = brand('Key Money Brand');
  const start = `${addDays(today(), -100).slice(0, 7)}-01`;
  const lease = Number(db.run("INSERT INTO leases (ref, brand_id, status, start_date, end_date, term_years, rent_m2, created_at) VALUES ('LS-KEY-1', ?, 'active', ?, ?, 2, 1000, ?)", b, start, addDays(start, 730), new Date().toISOString()).lastInsertRowid);
  const inv = h.billing.createInvoice({ lease_id: lease, kind: 'key', other: 240000, vat_pct: 0, due_date: start });
  assert.deepEqual(linesOf(`inv:${inv.id}`), { 1200: 240000, 2300: -240000 });
  L.sync();
  const months = db.value("SELECT COUNT(*) FROM acc_entries WHERE source_base LIKE ?", `keyrec:${inv.id}:%`);
  assert.ok(months >= 2 && months <= 4, `${months} months recognised`);
  assert.equal(L.balance(L.idOf('unearned')), 240000 - months * 10000);
  L.setS('key_treatment', 'income');
});

test('accounting: supplier bills, approval, VAT input and payment', () => {
  const v = L.vendorFor('Test Cleaning Co.');
  const bill = L.createBill({ vendor_id: v.id, date: today(), lines: [{ account: 'exp_cleaning', amount: 50000, description: 'October cleaning' }], vat: 7000 });
  assert.equal(bill.status, 'draft');
  assert.equal(L.active(`bill:${bill.id}`), undefined, 'drafts are not in the books');
  L.approveBill(bill.id);
  assert.deepEqual(linesOf(`bill:${bill.id}`), { 5220: 50000, 1400: 7000, 2100: -57000 });
  L.payBill(bill.id, { amount: 20000, account: 'petty_cash', date: today() });
  assert.equal(db.value('SELECT status FROM acc_bills WHERE id = ?', bill.id), 'partial');
  L.payBill(bill.id, { amount: 99999, account: 'petty_cash', date: today() });
  assert.equal(db.value('SELECT status FROM acc_bills WHERE id = ?', bill.id), 'paid');
  assert.equal(db.value('SELECT paid FROM acc_bills WHERE id = ?', bill.id), 57000, 'never overpaid');
  assert.equal(L.agedPayables().rows.find((r) => r.vendor_id === v.id), undefined);
  // maintenance costs arrive as draft bills, once per source
  h.events.emit('expense.incurred', { date: today(), amount: 1200, vendor: 'Delta Hardware Test', category: 'maintenance', source: 'work_order', source_id: 99001, memo: 'Door lock' });
  h.events.emit('expense.incurred', { date: today(), amount: 1200, vendor: 'Delta Hardware Test', category: 'maintenance', source: 'work_order', source_id: 99001, memo: 'Door lock' });
  assert.equal(db.value("SELECT COUNT(*) FROM acc_bills WHERE source = 'work_order' AND source_id = 99001 AND status = 'draft'"), 1);
  assert.ok(balanced());
});

test('accounting: bank statements import (Arabic headers) and reconcile', () => {
  const bank = L.createBank({ name: 'Test Bank', opening_balance: 100000, opening_date: addDays(today(), -30) });
  const acc = bank.account_id;
  L.post({ date: addDays(today(), -10), memo: 'Receipt RC-TEST-1', lines: [{ account: acc, debit: 25000 }, { account: 'ar', credit: 25000 }] });
  L.post({ date: addDays(today(), -5), memo: 'Supplier transfer', lines: [{ account: 'ap', debit: 8000 }, { account: acc, credit: 8000 }] });
  const dmy = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const csv = `التاريخ;البيان;المرجع;مدين;دائن\n${dmy(addDays(today(), -9))};تحويل وارد;RC-TEST-1;;25.000,00\n${dmy(addDays(today(), -4))};تحويل صادر;;8.000,00;\n${dmy(addDays(today(), -3))};مصروفات بنكية;;٣٥٠;`;
  const r = L.importStatement(bank.id, csv);
  assert.deepEqual([r.added, r.skipped], [3, 0]);
  assert.equal(L.importStatement(bank.id, csv).skipped, 3, 'the same lines are not imported twice');
  assert.equal(L.autoMatch(bank.id), 2);
  let s = L.bankSummary(bank);
  assert.equal(s.open, 1);
  assert.equal(s.difference, 0, 'books = statement + in transit − not booked');
  const charge = db.get("SELECT * FROM acc_statement_lines WHERE bank_id = ? AND status = 'open'", bank.id);
  assert.equal(charge.amount, -350);
  L.postFromLine(charge.id, L.idOf('exp_bank'));
  s = L.bankSummary(bank);
  assert.equal(s.open, 0);
  assert.equal(s.book, 100000 + 25000 - 8000 - 350);
  assert.equal(s.statement, s.book);
  // tolerant parsing: ISO dates, one amount column, (negatives), English headers
  const p = L.parseStatement('Value Date,Narrative,Amount\n2026-01-05,"Fee, monthly",(120.50)\n2026-01-06,Deposit,1500');
  assert.deepEqual(p.rows.map((x) => [x.date, x.amount, x.description]), [['2026-01-05', -120.5, 'Fee, monthly'], ['2026-01-06', 1500, 'Deposit']]);
  assert.deepEqual(L.parseStatement('just,some,text\n1,2,3').errors, ['headers']);
});

test('accounting: fixed assets depreciate straight line, once a month, and dispose with a gain', () => {
  const start = `${addDays(today(), -120).slice(0, 7)}-01`;
  const a = L.createAsset({ name: 'Test chiller', class: 'mep', cost: 120000, acquired_on: start, life_months: 60, residual: 0, pay_from: 'petty_cash' });
  const lastMonth = L.addMonthsYM(today().slice(0, 7), -1);
  const n = L.runDepreciation(lastMonth);
  assert.ok(n >= 3);
  assert.equal(L.runDepreciation(lastMonth), 0, 'already posted');
  const months = db.value('SELECT COUNT(*) FROM acc_depreciation WHERE asset_id = ?', a.id);
  assert.equal(L.depreciated(a.id), months * 2000);
  const r = L.disposeAsset(a.id, { date: today(), proceeds: 120000, account: 'petty_cash' });
  assert.equal(r.gain, months * 2000);
  assert.equal(db.value('SELECT status FROM acc_assets WHERE id = ?', a.id), 'disposed');
  assert.equal(L.balance(L.idOf('fa_mep')), 0);
  assert.ok(balanced());
});

test('accounting: payroll accrues on approval and is paid; reopening reverses', () => {
  const emp = db.get('SELECT id FROM employees LIMIT 1') || { id: Number(db.run("INSERT INTO employees (code, name, hire_date, status, created_at, updated_at) VALUES ('E-T1', 'Test Person', '2024-01-01', 'active', ?, ?)", new Date().toISOString(), new Date().toISOString()).lastInsertRowid) };
  const run = Number(db.run("INSERT INTO payroll_runs (period, status, created_at) VALUES ('2020-01', 'draft', ?)", new Date().toISOString()).lastInsertRowid);
  db.run('INSERT INTO payroll_lines (run_id, employee_id, basic, allowances, insurance_employee, insurance_employer, tax, deductions, net) VALUES (?, ?, 20000, 5000, 1100, 1875, 1500, 400, 22000)', run, emp.id);
  db.run("UPDATE payroll_runs SET status = 'approved' WHERE id = ?", run);
  h.events.emit('payroll.approved', { run: db.get('SELECT * FROM payroll_runs WHERE id = ?', run), lines: [] });
  assert.deepEqual(linesOf(`payroll:${run}`), { 5100: 25000, 5110: 1875, 2500: -22000, 2510: -2975, 2520: -1500, 1210: -400 });
  db.run("UPDATE payroll_runs SET status = 'paid', paid_at = ? WHERE id = ?", '2020-02-01', run);
  h.events.emit('payroll.paid', { run: db.get('SELECT * FROM payroll_runs WHERE id = ?', run), lines: [], date: '2020-02-01' });
  assert.equal(linesOf(`payroll-paid:${run}`)[2500], 22000);
  db.run("UPDATE payroll_runs SET status = 'draft', paid_at = NULL WHERE id = ?", run);
  L.sync();
  assert.equal(L.active(`payroll:${run}`), undefined, 'a reopened payroll leaves the books');
  db.run("UPDATE payroll_runs SET status = 'approved' WHERE id = ?", run);
  L.sync();
  assert.ok(L.active(`payroll:${run}`), 'and comes back when approved again');
  assert.match(L.active(`payroll:${run}`).source, /#2$/);
  assert.ok(balanced());
});

test('accounting: reports tie out, months close in order, the year closes to retained earnings', () => {
  const fy = L.fiscalYear(today());
  const tb = L.trialBalance({ from: fy.from, to: today() });
  assert.ok(tb.balanced);
  const bs = L.balanceSheet(today());
  assert.ok(bs.balanced, 'assets = liabilities + equity');
  assert.ok(L.cashFlow({ from: fy.from, to: today() }).ties);
  // close up to last month, then nothing can be posted there
  L.sync();
  const last = L.addMonthsYM(today().slice(0, 7), -1);
  L.closeMonth(last, { force: true });
  assert.equal(L.lockDate(), L.monthEnd(last));
  assert.throws(() => L.post({ date: L.monthEnd(last), memo: 'late', lines: [{ account: 'petty_cash', debit: 1 }, { account: 'capital', credit: 1 }] }), /closed period/);
  assert.equal(L.firstOpen(L.monthEnd(last)), addDays(L.monthEnd(last), 1), 'late automatic postings move to the first open day');
  assert.throws(() => L.closeMonth(last), /already closed/);
  // an old payroll year (2020) is in a closed period now: its year can close
  const e = L.closeYear('2020-01-01');
  const pl2020 = L.profitLoss({ from: '2020-01-01', to: '2020-12-31' });
  assert.equal(e.kind, 'closing');
  assert.equal(L.balance(L.idOf('exp_salaries'), { to: '2020-12-31' }), 0, 'income and expenses are emptied');
  assert.ok(pl2020.result < 0);
  assert.ok(L.balanceSheet(today()).balanced);
  L.reopenYear(2020);
  assert.equal(L.active('yearclose:2020'), undefined);
  assert.ok(L.balanceSheet(today()).balanced);
  assert.equal(L.reopenLast(), last);
  assert.equal(L.lockDate(), L.monthEnd(L.addMonthsYM(last, -1)), 'the month before stays closed');
  db.run('DELETE FROM acc_periods');
  L.setS('lock_date', '');
});

test('accounting: pages need finance access, render, post and export', async () => {
  let html = await (await go('/admin/setup')).text();
  await go('/admin/setup', form({ _token: html.match(/name="_token" value="([^"]+)"/)[1], name: 'Admin', email: 'acc-admin@thewave.test', password: 'long-enough-1' }));
  html = await (await go('/admin')).text();
  const csrf = csrfOf(html);
  // an agent without finance access is refused
  db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES ('Agent', 'agent@thewave.test', 'agent', ?, ?)", hashPassword('long-enough-2'), new Date().toISOString());
  const other = new Map();
  const login = await (await go('/admin/login', {}, other)).text();
  await go('/admin/login', form({ _token: login.match(/name="_token" value="([^"]+)"/)[1], email: 'agent@thewave.test', password: 'long-enough-2' }), other);
  for (const p of ['/admin/accounting', '/admin/accounting/journal', '/admin/accounting/reports/tb?format=csv']) {
    const r = await go(p, {}, other);
    assert.ok([302, 303, 403].includes(r.status), `${p} → ${r.status}`);
  }
  // a manual entry through the form: unbalanced is refused, balanced is posted
  let res = await go('/admin/accounting/journal', form({ _csrf: csrf, date: today(), memo: 'Bank charges', account: [String(L.idOf('exp_bank')), String(L.idOf('petty_cash'))], debit: ['500', ''], credit: ['', '400'], line_memo: ['', ''] }));
  assert.equal(res.status, 422);
  const body = new URLSearchParams({ _csrf: csrf, date: today(), memo: 'Bank charges' });
  for (const [a, d, c] of [[L.idOf('exp_bank'), '500', ''], [L.idOf('petty_cash'), '', '500']]) { body.append('account', a); body.append('debit', d); body.append('credit', c); body.append('line_memo', ''); }
  res = await go('/admin/accounting/journal', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/admin\/accounting\/journal\/\d+$/);
  // sample data: every tab renders, reports export, documents print in either language
  res = await go('/admin/settings/demo', form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  assert.equal(L.pending().total, 0, 'the sample books are complete');
  for (const p of ['/admin/accounting', '/admin/accounting/journal', '/admin/accounting/journal/new', '/admin/accounting/accounts', '/admin/accounting/receivables', '/admin/accounting/payables', '/admin/accounting/payables?tab=draft', '/admin/accounting/bills/new',
    '/admin/accounting/banking', '/admin/accounting/assets', '/admin/accounting/budgets', '/admin/accounting/reports', '/admin/accounting/settings',
    ...['pl', 'pl?view=monthly', 'pl?compare=budget', 'bs', 'cf', 'tb', 'gl', 'journal', 'vat', 'ar', 'ap'].map((r) => `/admin/accounting/reports/${r}`)]) {
    res = await go(p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, p);
  }
  const bank = db.get('SELECT * FROM acc_banks WHERE demo = 1 LIMIT 1');
  html = await (await go(`/admin/accounting/banking/${bank.id}`)).text();
  assert.match(html, /acc-rec|acc-cand|Every statement line/);
  res = await go('/admin/accounting/reports/tb?format=csv');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a BOM, so Excel reads Arabic');
  assert.match(bytes.toString('utf8', 3), /^Code,Account/);
  res = await go('/admin/accounting/reports/bs?print=1&doc=ar');
  html = await res.text();
  assert.match(html, /<html lang="ar" dir="rtl"/);
  assert.match(html, /قائمة المركز المالي/);
  const brandId = db.value("SELECT brand_id FROM invoices WHERE demo = 1 AND brand_id IS NOT NULL LIMIT 1");
  res = await go(`/admin/accounting/receivables/${brandId}/print?doc=en`);
  assert.match(await res.text(), /Statement of account/);
  assert.ok(L.trialBalance({ from: L.fiscalYear().from, to: today() }).balanced);
  assert.ok(L.balanceSheet(today()).balanced);
  // the sync button
  res = await go('/admin/accounting/sync', form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  // clearing the samples removes their books
  res = await go('/admin/settings/demo/clear', form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM acc_entries WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM acc_banks WHERE demo = 1'), 0);
  assert.ok(balanced());
});
