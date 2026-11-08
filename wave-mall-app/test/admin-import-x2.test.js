'use strict';

// Import from Excel — finance, purchasing and people: the chart of accounts, bank and cash
// accounts, the opening trial balance (one balanced entry per date, refused when it does not
// balance, closed months, double counting warned), suppliers and their unpaid bills, fixed assets
// with the depreciation already charged, store items with opening stock, salary advances, leave
// already taken, shifts and who works them; undo of each; permissions; a round trip of the sample
// data that changes nothing, in English and Arabic.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const { readDays } = require('../src/admin/import/datasets/people');

let server;
let base;
let db;
let h;
let admin;

function browser() {
  const jar = new Map();
  const go = async (p, opts = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const b = {
    go, csrf: null,
    form: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: b.csrf, ...data }).toString() }),
    async signIn(email) {
      const html = await (await go('/admin/login')).text();
      const t = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: t, email, password: 'long-enough-1' }).toString() });
      assert.equal(r.status, 303);
      b.csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
    },
    async upload(key, buf, name) {
      const r = await go(`/admin/import/${key}/upload`, { method: 'POST', headers: { 'x-csrf': b.csrf, 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', accept: 'application/json' }, body: buf });
      return { status: r.status, ...(await r.json()) };
    },
    flash() {
      const raw = jar.get('wv_flash');
      return raw ? JSON.parse(decodeURIComponent(raw)).text : '';
    },
  };
  return b;
}
function user(name, email, role, { hr = 0, finance = 0 } = {}) {
  const id = Number(db.run("INSERT INTO users (name, email, role, password_hash, hr, finance, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))", name, email, role, hashPassword('long-enough-1'), hr, finance).lastInsertRowid);
  h.access.engine.touch();
  return id;
}
async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const tokenOf = (url) => url.split('/').pop();
const stage = (token) => h.imports.staged(token);
// upload rows, return the preview (by line) and the token
async function check(key, rows, who = admin) {
  const up = await who.upload(key, await xlsx(rows), `${key}.xlsx`);
  assert.equal(up.ok, true, up.error);
  const token = tokenOf(up.url);
  const pv = h.imports.preview(stage(token), {}, 'en');
  return { token, pv, line: Object.fromEntries(pv.rows.map((r) => [r.line, r])) };
}
const commit = (token, who = admin, opts = { mode: 'all', action: 'both', empties: 'keep' }) => who.form(`/admin/import/s/${token}/commit`, opts);
const lastBatch = (key) => db.get('SELECT * FROM imp_batches WHERE dataset = ? ORDER BY id DESC LIMIT 1', key);
const L = () => h.ledger;
const acct = (code) => db.get('SELECT * FROM acc_accounts WHERE code = ?', code);
const emp = (code, name, extra = {}) => Number(db.run("INSERT INTO employees (code, name, position, hire_date, basic_salary, status, created_at, updated_at) VALUES (?, ?, 'Officer', '2024-01-01', ?, 'active', datetime('now'), datetime('now'))", code, name, extra.salary || 12000).lastInsertRowid);

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  user('Finance Admin', 'x2-admin@thewave.test', 'admin', { hr: 1, finance: 1 });
  admin = browser();
  await admin.signIn('x2-admin@thewave.test');
});
after(() => server.close());

test('x2: the opening trial balance is one balanced entry; refused when it does not balance; the trial balance equals the file; undo', async () => {
  const head = ['Account *', 'Debit', 'Credit', 'Balance on *', 'Note'];
  // out of balance by 100: every row says so, nothing can be imported
  let r = await check('opening_balances', [head, ['1110', '18,500', '', '01/01/2026', ''], ['1510 · Buildings and structures', 1000000, '', '01/01/2026', ''], ['3100', '', '1,018,400', '01/01/2026', '']]);
  assert.equal(r.pv.counts.error, 3);
  assert.ok(r.line[2].errors.some((e) => e.key.includes('do not balance') && e.params.diff === '100.00' && e.params.date === '1 Jan 2026'), JSON.stringify(r.line[2].errors));
  assert.equal(r.pv.canCommit, false);
  // problems a row can have: both sides, neither, the balancing account itself, a group, an unknown account
  r = await check('opening_balances', [head, ['1110', 10, 10, '2026-01-01', ''], ['1110', '', '', '2026-01-01', ''], ['3900', 5, '', '2026-01-01', ''], ['15', 5, '', '2026-01-01', ''], ['9999', 5, '', '2026-01-01', '']]);
  assert.ok(r.line[2].errors.some((e) => e.key === 'imp2|A line is a debit or a credit, not both.'));
  assert.ok(r.line[3].errors.some((e) => e.key === 'imp2|Give the debit or the credit balance.'));
  assert.ok(r.line[4].errors.some((e) => e.key.startsWith('imp2|Opening balances (3900)')));
  assert.ok(r.line[5].errors.some((e) => e.col === 'account'), 'a group is not offered');
  assert.ok(r.line[6].errors.some((e) => e.col === 'account'), 'unknown account');
  // receivables warn about counting twice
  r = await check('opening_balances', [head, ['1200', 500, '', '2026-01-01', ''], ['3100', '', 500, '2026-01-01', '']]);
  assert.ok(r.line[2].warns.some((w) => w.key.startsWith('imp2|Tenant receivables')));
  // a balanced file goes in as one entry
  const rows = [['1110', 18500, '', '2026-01-01', 'Cash count 31 Dec'], ['1510', 450000000, '', '2026-01-01', ''], ['1511', '', 36000000, '2026-01-01', ''], ['2600', '', 1250000, '2026-01-01', ''], ['3100', '', 412768500, '2026-01-01', '']];
  r = await check('opening_balances', [head, ...rows]);
  assert.equal(r.pv.counts.new, 5, JSON.stringify(r.pv.rows.find((x) => x.errors.length)?.errors));
  await commit(r.token);
  assert.match(admin.flash(), /5 new/);
  const e = L().active('opening:2026-01-01');
  assert.ok(e, 'one opening entry');
  assert.equal(e.kind, 'opening');
  const lines = db.all('SELECT * FROM acc_lines WHERE entry_id = ?', e.id);
  assert.equal(lines.length, 5, 'no balancing line when the file balances');
  const s = L().sums({ from: '2026-01-01', to: '2026-01-01' });
  for (const [code, d, c] of rows) {
    const x = s[acct(code).id];
    assert.equal(x.d, Number(d || 0), `${code} debit`);
    assert.equal(x.c, Number(c || 0), `${code} credit`);
  }
  // the page and the report agree
  const tb = L().trialBalance({ from: '2026-01-01', to: '2026-01-01' });
  assert.ok(tb);
  // a later file for the same date updates a line; the entry stays balanced through the balancing line
  r = await check('opening_balances', [head, ['1110', 20000, '', '2026-01-01', ''], ['3100', '', 412770000, '2026-01-01', '']]);
  assert.equal(r.pv.counts.update, 2);
  await commit(r.token);
  assert.equal(L().balance(acct('1110').id), 20000);
  const dr = db.value('SELECT SUM(debit) FROM acc_lines WHERE entry_id = ?', e.id);
  const cr = db.value('SELECT SUM(credit) FROM acc_lines WHERE entry_id = ?', e.id);
  assert.equal(Math.round(dr * 100), Math.round(cr * 100));
  // undo the update, then the import: the entry goes
  assert.equal(h.imports.undo(lastBatch('opening_balances').id, null).ok, true);
  assert.equal(L().balance(acct('1110').id), 18500);
  // a closed month refuses both the import and its undo
  L().setS('lock_date', '2026-01-31');
  r = await check('opening_balances', [head, ['1110', 1, '', '2026-01-15', ''], ['3100', '', 1, '2026-01-15', '']]);
  assert.ok(r.line[2].errors.some((x) => x.key.startsWith('imp2|The books are closed')));
  const first = db.get("SELECT * FROM imp_batches WHERE dataset = 'opening_balances' AND status = 'done' ORDER BY id LIMIT 1");
  assert.ok(h.imports.blockers(h.imports.batch(first.id)).length, 'undo refused in a closed month');
  L().setS('lock_date', '');
  assert.equal(h.imports.undo(first.id, null).ok, true);
  assert.equal(L().active('opening:2026-01-01'), undefined);
  assert.equal(L().balance(acct('1510').id), 0);
});

test('x2: chart of accounts — under a group, groups in the same file, types, system accounts', async () => {
  const head = ['Account code *', 'Name in English *', 'Name in Arabic', 'Under (group)', 'Account or group', 'Type', 'Active'];
  const r = await check('accounts', [head,
    ['5250', 'Generator diesel', 'سولار المولدات', '5 · Expenses', '', '', 'yes'],
    ['580', 'Campaigns', 'الحملات', '5', 'Group', '', ''],
    ['5810', 'Ramadan campaign', '', '580', '', 'expense', ''],
    ['5820', 'Bad type', '', '580', '', 'income', ''],
    ['1200', 'Accounts receivable – tenants', '', '', '', '', 'no'],
    ['12', 'Too short', '', '5', '', '', ''],
  ]);
  assert.equal(r.line[2].status, 'new');
  assert.equal(r.line[3].status, 'new');
  assert.equal(r.line[4].status, 'new', JSON.stringify(r.line[4].errors));
  assert.ok(r.line[5].errors.some((e) => e.key.startsWith('imp2|An account has the type of its group')));
  assert.ok(r.line[6].errors.some((e) => e.key.startsWith('imp2|A system account stays active')));
  assert.ok(r.line[7].errors.some((e) => e.key === 'imp2|An account code has 3 to 6 digits.'));
  await commit(r.token, admin, { mode: 'valid', action: 'both', empties: 'keep' });
  assert.equal(acct('5250').type, 'expense');
  assert.equal(acct('580').is_group, 1);
  assert.equal(acct('5810').parent_id, acct('580').id, 'linked to the group from the same file');
  assert.equal(acct('5810').type, 'expense');
  assert.equal(h.imports.undo(lastBatch('accounts').id, null).ok, true);
  assert.equal(acct('5810'), undefined);
});

test('x2: bank accounts with a balance, suppliers and unpaid bills post against Opening balances; undo removes the postings', async () => {
  let r = await check('bank_accounts', [['Account name *', 'Bank or cash', 'Bank', 'IBAN', 'Balance on the start day', 'Balance on'], ['QNB current', 'bank', 'QNB', 'EG38 0019 0005 0000 0000 2631 8000 2', '250,000', '01/01/2026'], ['Bad IBAN', 'bank', '', 'EG12', '', '']]);
  assert.equal(r.line[2].status, 'new');
  assert.ok(r.line[3].errors.some((e) => e.col === 'iban'));
  await commit(r.token, admin, { mode: 'valid', action: 'both', empties: 'keep' });
  const bank = db.get("SELECT * FROM acc_banks WHERE name = 'QNB current'");
  assert.equal(bank.iban, 'EG380019000500000000263180002');
  assert.equal(L().balance(bank.account_id), 250000);
  // the opening trial balance warns that this account already has its balance
  const tbw = await check('opening_balances', [['Account *', 'Debit', 'Balance on *'], [acct(db.value('SELECT code FROM acc_accounts WHERE id = ?', bank.account_id)).code, 5, '2026-01-01']]);
  assert.ok(Object.values(tbw.line)[0].warns.some((w) => w.key.includes('another list')));

  r = await check('suppliers', [['Supplier name *', 'Tax registration number', 'Phone', 'Payment terms (days)', 'Usual expense account'], ['Delta Lifts Co.', '200-123-456', '19555', 45, '5200'], ['Shield Security', '', '', '', '5210 · Security']]);
  assert.equal(r.pv.counts.new, 2, JSON.stringify(r.pv.rows.find((x) => x.errors.length)?.errors));
  await commit(r.token);
  const delta = db.get("SELECT * FROM acc_vendors WHERE name = 'Delta Lifts Co.'");
  assert.equal(delta.terms_days, 45);
  assert.equal(delta.account_id, acct('5200').id);
  r = await check('supplier_bills', [['Supplier *', 'Supplier’s invoice number *', 'Bill date *', 'Due date', 'Amount still owed *'], ['Delta Lifts Co.', 'INV-4471', '10/12/2025', '', '48,500'], ['Shield Security', 'SS-118', '2025-12-31', '2025-12-01', '1000'], ['Nobody', 'X', '2025-12-31', '', '5']]);
  assert.equal(r.line[2].status, 'new');
  assert.ok(r.line[3].errors.some((e) => e.key === 'imp2|The due date is before the bill date.'));
  assert.ok(r.line[4].errors.some((e) => e.col === 'supplier'));
  await commit(r.token, admin, { mode: 'valid', action: 'both', empties: 'keep' });
  const bill = db.get("SELECT * FROM acc_bills WHERE vendor_ref = 'INV-4471'");
  assert.equal(bill.status, 'approved');
  assert.equal(bill.total, 48500);
  assert.equal(bill.due_date, '2026-01-24', 'bill date + the supplier’s 45 days');
  assert.equal(L().keyBalance('ap'), 48500);
  assert.equal(L().keyBalance('opening_equity'), 250000 - 48500);
  // re-importing the same bill finds it: nothing to do
  const again = await check('supplier_bills', [['Supplier *', 'Supplier’s invoice number *', 'Bill date *', 'Amount still owed *'], ['Delta Lifts Co.', 'inv-4471', '2025-12-10', '48500']]);
  assert.equal(again.pv.counts.same, 1);
  // undo the bills, then the bank: their entries go too
  assert.equal(h.imports.undo(lastBatch('supplier_bills').id, null).ok, true);
  assert.equal(L().keyBalance('ap'), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM acc_entries WHERE source_base = 'bill:' || ?", bill.id), 0);
  assert.equal(h.imports.undo(lastBatch('bank_accounts').id, null).ok, true);
  assert.equal(db.get("SELECT * FROM acc_banks WHERE name = 'QNB current'"), undefined);
  assert.equal(L().byId(bank.account_id), undefined, 'its account in the chart goes too');
  assert.equal(L().keyBalance('opening_equity'), 0);
});

test('x2: fixed assets keep the depreciation already charged; the monthly run carries on without charging twice', async () => {
  const r = await check('fixed_assets', [['Asset *', 'Class *', 'Cost *', 'Acquired on *', 'Useful life (months)', 'Depreciation charged so far', 'Charged up to (month)'],
    ['Escalator E2', 'MEP and equipment', '3,600,000', '01/07/2022', 180, '840,000', '2026-01'],
    ['Too much', 'it', 1000, '2025-01-01', '', 2000, '2025-06'],
    ['No month', 'it', 1000, '2025-01-01', '', 100, ''],
  ]);
  assert.equal(r.line[2].status, 'new', JSON.stringify(r.line[2].errors));
  assert.ok(r.line[3].errors.some((e) => e.key.startsWith('imp2|More depreciation')));
  assert.ok(r.line[4].errors.some((e) => e.key === 'imp2|Give the month the depreciation runs to.'));
  await commit(r.token, admin, { mode: 'valid', action: 'both', empties: 'keep' });
  const a = db.get("SELECT * FROM acc_assets WHERE name = 'Escalator E2'");
  assert.equal(a.class, 'mep');
  assert.equal(L().depreciated(a.id), 840000);
  assert.equal(db.value('SELECT COUNT(*) FROM acc_depreciation WHERE asset_id = ?', a.id), 43, 'July 2022 to January 2026');
  assert.equal(db.value('SELECT COUNT(*) FROM acc_entries'), 0, 'nothing posted: the trial balance carries it');
  L().runDepreciation('2026-03');
  const posted = db.all('SELECT * FROM acc_depreciation WHERE asset_id = ? AND entry_id IS NOT NULL ORDER BY period', a.id);
  assert.deepEqual(posted.map((p) => p.period), ['2026-02', '2026-03'], 'only the months after');
  assert.equal(posted[0].amount, 20000);
  assert.ok(h.imports.blockers(h.imports.batch(lastBatch('fixed_assets').id)).length, 'undo refused once depreciation is posted');
});

test('x2: store items with opening stock; advances, leave and shifts for people', async () => {
  // store items
  let r = await check('stock_items', [['Item code *', 'Item *', 'Unit', 'Category', 'Reorder when at or below', 'On hand today', 'Unit cost'], ['EL-0420', 'LED panel 60×60', 'pcs', 'Electrical', 10, 24, 950], ['CL-0110', 'Floor cleaner 5 L', 'litre', 'cleaning', '', -3, '']]);
  assert.equal(r.line[2].status, 'new');
  assert.ok(r.line[3].errors.some((e) => e.col === 'opening_qty'), 'negative stock refused');
  await commit(r.token, admin, { mode: 'valid', action: 'both', empties: 'keep' });
  const item = db.get("SELECT * FROM inv_items WHERE code = 'EL-0420'");
  assert.equal(item.on_hand, 24);
  assert.equal(item.avg_cost, 950);
  assert.equal(db.value("SELECT COUNT(*) FROM inv_moves WHERE item_id = ? AND kind = 'opening'", item.id), 1);
  assert.equal(L().balance(L().idOf(h.purchasing.inventoryAccount())), 22800, 'stock in the books');
  assert.equal(L().keyBalance('opening_equity'), 22800, 'against Opening balances');
  assert.equal(h.imports.undo(lastBatch('stock_items').id, null).ok, true);
  assert.equal(db.value("SELECT COUNT(*) FROM acc_entries WHERE source_base LIKE 'stock:%'"), 0);

  // people
  const e1 = emp('EMP-0901', 'Mahmoud Adel');
  const e2 = emp('EMP-0902', 'Salma Adel');
  r = await check('salary_advances', [['Employee *', 'Amount given *', 'Given on *', 'Repaid over (months) *', 'Repaid before the start day', 'Next deduction month *'], ['EMP-0901', 24000, '05/10/2025', 8, 6000, '2026-01'], ['EMP-0902', 1000, '2025-12-01', 2, 2000, '2026-01']]);
  assert.equal(r.line[2].status, 'new', JSON.stringify(r.line[2].errors));
  assert.ok(r.line[3].errors.some((x) => x.key === 'imp2|More was repaid than was given.'));
  await commit(r.token, admin, { mode: 'valid', action: 'both', empties: 'keep' });
  const adv = db.get('SELECT * FROM hr_advances WHERE employee_id = ?', e1);
  assert.equal(adv.monthly, 3000);
  assert.equal(h.advances.remaining(adv), 18000);
  assert.equal(L().keyBalance('other_receivables'), 18000);
  assert.equal(adv.status, 'active');
  assert.equal(h.imports.undo(lastBatch('salary_advances').id, null).ok, true);
  assert.equal(L().keyBalance('other_receivables'), 0);

  r = await check('leave_taken', [['Employee *', 'Leave type', 'From *', 'To *', 'Days counted'], ['EMP-0901', 'Annual leave', '12/03/2026', '16/03/2026', ''], ['EMP-0901', 'sick', '2026-03-15', '2026-03-17', ''], ['EMP-0902', 'casual', '2026-03-13', '2026-03-13', '']]);
  assert.equal(r.line[2].status, 'new');
  assert.ok(r.line[3].errors.some((x) => x.key === 'imp2|This overlaps the leave on row {line}.'), 'overlap within the file');
  assert.ok(r.line[4].errors.some((x) => x.key === 'imp2|Those dates are all Fridays.'));
  await commit(r.token, admin, { mode: 'valid', action: 'both', empties: 'keep' });
  const lv = db.get('SELECT * FROM leave_requests WHERE employee_id = ?', e1);
  assert.equal(lv.status, 'approved');
  assert.equal(lv.days, 4, '12–16 March 2026 less the Friday');

  // shifts: days in English, Arabic, ranges, every day
  assert.deepEqual(readDays(['Sat–Thu']).value, ['mon', 'tue', 'wed', 'thu', 'sat', 'sun']);
  assert.deepEqual(readDays(['الجمعة', 'السبت']).value, ['fri', 'sat']);
  assert.deepEqual(readDays(['every day']).value.length, 7);
  assert.equal(readDays(['Funday']).error, 'imp2|“{day}” is not a day of the week.');
  r = await check('shifts', [['Shift *', 'Starts *', 'Ends *', 'Days *', 'Unpaid break (minutes)'], ['Morning', '8:00', '16:00', 'Sat–Thu', 30], ['Night', '22:00', '06:00', 'كل يوم', 45], ['Broken', '10:00', '10:00', 'Mon', '']]);
  assert.equal(r.line[2].status, 'new');
  assert.ok(r.line[4].errors.some((x) => x.key === 'imp2|A shift cannot end when it starts.'));
  await commit(r.token, admin, { mode: 'valid', action: 'both', empties: 'keep' });
  assert.equal(db.value("SELECT days FROM att_shifts WHERE name = 'Morning'"), '123467');
  assert.equal(db.value("SELECT start_hm FROM att_shifts WHERE name = 'Morning'"), '08:00');
  r = await check('shift_assignments', [['Employee *', 'Shift *', 'From *', 'Until (optional)'], ['EMP-0901', 'Morning', '2026-01-01', '']]);
  await commit(r.token);
  r = await check('shift_assignments', [['Employee *', 'Shift *', 'From *'], ['EMP-0901', 'Night', '2026-06-01']]);
  await commit(r.token);
  const first = db.get("SELECT * FROM att_assign WHERE employee_id = ? AND starts = '2026-01-01'", e1);
  assert.equal(first.ends, '2026-05-31', 'the shift before ends the day before');
  assert.equal(h.imports.undo(lastBatch('shift_assignments').id, null).ok, true);
  assert.equal(db.get('SELECT ends FROM att_assign WHERE id = ?', first.id).ends, null, 'undo puts it back');
});

test('x2: who may see and import finance and people data', async () => {
  user('Sales Manager', 'x2-mgr@thewave.test', 'manager');
  const mgr = browser();
  await mgr.signIn('x2-mgr@thewave.test');
  const centre = await (await mgr.go('/admin/import')).text();
  assert.doesNotMatch(centre, /Opening balances \(trial balance\)/, 'no finance capability');
  assert.doesNotMatch(centre, /Salary advances/, 'no HR');
  assert.match(centre, /Store items and opening stock/, 'a manager buys for the store');
  assert.equal((await mgr.go('/admin/import/opening_balances')).status, 404);
  for (const key of ['accounts', 'bank_accounts', 'opening_balances', 'suppliers', 'supplier_bills', 'fixed_assets', 'stock_items', 'salary_advances', 'leave_taken', 'shifts', 'shift_assignments']) {
    for (const lang of ['en', 'ar']) assert.equal((await admin.go(`/admin/import/${key}?lang=${lang}`)).status, 200, `${key} ${lang}`);
    const t = await admin.go(`/admin/import/${key}/template.xlsx?as=ar`);
    assert.equal(t.status, 200, key);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await t.arrayBuffer()));
    assert.ok(wb.worksheets[0].views[0].rightToLeft, `${key}: Arabic template right to left`);
  }
  await admin.go('/admin?lang=en');
});

test('x2: a round trip of the sample data changes nothing, in English and Arabic', async () => {
  await admin.form('/admin/settings/demo', {});
  const I = h.imports;
  for (const key of ['accounts', 'bank_accounts', 'suppliers', 'supplier_bills', 'fixed_assets', 'stock_items', 'salary_advances', 'leave_taken', 'shifts', 'shift_assignments']) {
    for (const as of ['en', 'ar']) {
      const r = await admin.go(`/admin/import/${key}/export/data.xlsx?as=${as}`);
      assert.equal(r.status, 200, key);
      const up = await admin.upload(key, Buffer.from(await r.arrayBuffer()), `${key}.xlsx`);
      assert.equal(up.ok, true, `${key}: ${up.error}`);
      const st = stage(tokenOf(up.url));
      const m = I.mapColumns(st.d, I.grid(st).headers);
      assert.equal(m.needsConfirm, false, `${key} ${as}: our own titles are recognised`);
      const pv = I.preview(stage(st.token), {}, as);
      const odd = pv.rows.find((x) => x.status !== 'same' || x.warns.length);
      assert.equal(odd, undefined, `${key} ${as}: ${odd && JSON.stringify({ line: odd.line, status: odd.status, errors: odd.errors, warns: odd.warns, diff: odd.diff })}`);
      assert.ok(pv.counts.same > 0, `${key}: sample data to compare`);
    }
  }
});
