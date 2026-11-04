'use strict';

// The office, second round: contract terms (stepped increases, service as a share of the rent, VAT
// per contract, revenue share with a minimum guarantee), merging and splitting units on the plan,
// cheques (receive, deposit, collect, bounce, return) with tenant notifications and whether they were
// seen, salary advances repaid through payroll, and filtering and sorting lists.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const TM = require('../src/admin/terms');
const C = require('../src/admin/revenue/calc');

let server;
let base;
let db;
let h;
let M;
let admin;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  M = h.M;
  base = `http://127.0.0.1:${server.address().port}`;
  db.run("INSERT INTO users (name, email, role, password_hash, finance, hr, created_at) VALUES ('Office Admin', 'o2-admin@thewave.test', 'admin', ?, 1, 1, datetime('now'))", hashPassword('long-enough-1'));
  admin = browser();
  await admin.signIn('o2-admin@thewave.test', 'long-enough-1');
  admin.user = db.get("SELECT * FROM users WHERE email = 'o2-admin@thewave.test'");
});
after(() => server.close());

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
    go,
    csrf: null,
    form: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: b.csrf, ...data }).toString() }),
    async signIn(email, password) {
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303);
      const page = await (await go('/admin')).text();
      b.csrf = (page.match(/name="csrf" content="([^"]+)"/) || page.match(/name="_csrf" value="([^"]+)"/))[1];
    },
  };
  return b;
}
const brand = (name) => Number(db.run("INSERT INTO brands (name, category, created_at) VALUES (?, 'fashion', datetime('now'))", name).lastInsertRowid);
const freeUnits = (n, zone = 'plaza') => db.all("SELECT * FROM units WHERE zone = ? AND status = 'available' ORDER BY sort", zone).slice(0, n);
const leaseFor = (b) => db.get('SELECT * FROM leases WHERE brand_id = ? ORDER BY id DESC LIMIT 1', b);

test('terms: stepped increases, service as a share of the rent, a minimum guarantee', () => {
  const terms = { escalation_pct: 10, escalation_steps: JSON.stringify([{ from: 6, pct: 12.5 }]) };
  assert.equal(TM.pctFor(terms, 2), 10);
  assert.equal(TM.pctFor(terms, 5), 10);
  assert.equal(TM.pctFor(terms, 6), 12.5);
  assert.ok(Math.abs(TM.factor(terms, 4) - 1.1 ** 4) < 1e-9, 'years 2–5 at 10%');
  assert.ok(Math.abs(TM.factor(terms, 6) - 1.1 ** 4 * 1.125 ** 2) < 1e-9, 'then 12.5%');
  assert.match(TM.describe(terms), /10% a year until year 5 · 12.5% from year 6/);
  const units = [{ indoor_m2: 100, terrace_m2: 20 }];
  assert.equal(TM.serviceMonthly({ service_mode: 'pct', service_pct: 10 }, units, 50000), 5000);
  assert.equal(TM.serviceMonthly({ service_mode: 'm2', service_m2: 140 }, units, 50000), 14000);
  assert.equal(TM.baseMonthly({ revenue_share: 1, min_guarantee: 80000, rent_m2: 500 }, units).rent, 80000, 'the minimum guarantee is the base rent');
  assert.equal(TM.baseMonthly({ revenue_share: 0, min_guarantee: 80000, rent_m2: 500, terrace_rent_m2: 200 }, units).rent, 54000);
  // revenue share on top of the base: the percentage of all sales
  assert.equal(C.pctRent({ sales: 1000000, pct: 8, base: 60000, type: 'none' }), 80000);
  assert.equal(C.pctRent({ sales: 1000000, pct: 8, base: 60000, type: 'natural' }), 20000, 'the higher of the two: base plus the top-up');
});

test('contracts: a lease with stepped increases, service as % of rent, its own VAT and a revenue share', async () => {
  const b = brand('Terms Test Co');
  const [u] = freeUnits(1);
  const res = await admin.form('/admin/leases', {
    brand_id: String(b), units: String(u.id), rent_m2: '1000', terrace_rent_m2: '0', escalation_pct: '10', esc_from_1: '3', esc_pct_1: '15',
    service_mode: 'pct', service_pct: '10', vat_pct: '14', revenue_share: '1', revenue_pct: '7', min_guarantee: '', take_higher: '1',
    start_date: M.today(), term_years: '5', rent_free_months: '0', payment_freq: 'monthly', deposit: '0', key_money: '0', signed_at: M.today(),
  });
  assert.equal(res.status, 303);
  const s = leaseFor(b);
  assert.equal(s.service_mode, 'pct');
  assert.equal(s.vat_pct, 14);
  assert.equal(s.revenue_share, 1);
  assert.deepEqual(JSON.parse(s.escalation_steps), [{ from: 3, pct: 15 }]);
  const terms = db.get('SELECT * FROM turnover_terms WHERE lease_id = ?', s.id);
  assert.equal(terms.pct, 7);
  assert.equal(terms.breakpoint_type, 'natural', 'take the higher');
  await admin.form(`/admin/leases/${s.id}/activate`, {});
  const first = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent' ORDER BY due_date LIMIT 1", s.id);
  const rent = u.indoor_m2 * 1000;
  assert.equal(first.rent, Math.round(rent));
  assert.equal(first.service, Math.round(rent * 0.1), 'service is 10% of the rent');
  assert.ok(Math.abs(first.vat - (first.rent + first.service) * 0.14) < 0.02, 'VAT at the contract’s 14%');
  // year 3: +10% then +15%
  const y3 = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent' ORDER BY due_date LIMIT 1 OFFSET 24", s.id);
  assert.equal(y3.rent, Math.round(rent * 1.1 * 1.15));
  const page = await (await admin.go(`/admin/leases/${s.id}`)).text();
  assert.match(page, /10% a year until year 2 · 15% from year 3/);
  assert.match(page, /7% of sales/);
  // a charge with its own VAT, amount including it
  await admin.form(`/admin/leases/${s.id}/charge`, { note: 'Signage', amount: '1140', due: M.today(), vat_pct: '14', vat_included: '1' });
  const charge = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'other' ORDER BY id DESC LIMIT 1", s.id);
  assert.equal(charge.total, 1140);
  assert.equal(charge.vat, 140);
});

test('units: merge two shops into one, split one into two, and undo', async () => {
  const [a, b, c] = freeUnits(3);
  let res = await admin.form(`/admin/units/${a.id}/merge`, { with: String(b.id), code: '' });
  assert.equal(res.status, 303);
  const merged = db.get('SELECT * FROM units WHERE made_from = ?', `${a.code},${b.code}`);
  assert.ok(merged, 'a merged unit');
  assert.equal(merged.indoor_m2, a.indoor_m2 + b.indoor_m2);
  assert.equal(JSON.parse(merged.cells).length, 2);
  assert.equal(db.value('SELECT status FROM units WHERE id = ?', a.id), 'retired');
  // the plan draws it as one unit, the totals do not count the old ones twice
  const plan = await (await admin.go('/admin/units')).text();
  assert.match(plan, new RegExp(`data-code="${merged.code}"`));
  assert.equal((await admin.go(`/admin/units/${a.id}`)).status, 200);
  // split
  res = await admin.form(`/admin/units/${c.id}/split`, { code_0: `${c.code}A`, indoor_0: String(c.indoor_m2 / 2), terrace_0: '0', code_1: `${c.code}B`, indoor_1: String(c.indoor_m2 / 2), terrace_1: String(c.terrace_m2) });
  assert.equal(res.status, 303);
  const parts = db.all('SELECT * FROM units WHERE made_from = ? ORDER BY code', c.code);
  assert.equal(parts.length, 2);
  assert.deepEqual(JSON.parse(parts[0].cells)[0], { slot: c.code, from: 0, to: 0.5 });
  res = await admin.form(`/admin/units/${c.id}/split`, { code_0: 'X1', indoor_0: '1', code_1: 'X2', indoor_1: '1' });
  assert.equal(db.value("SELECT COUNT(*) FROM units WHERE code IN ('X1','X2')"), 0, 'a retired unit is not split again');
  // undo the merge
  res = await admin.form(`/admin/units/${merged.id}/undo`, {});
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM units WHERE id = ?', merged.id), 0);
  assert.equal(db.value('SELECT status FROM units WHERE id = ?', a.id), 'available');
});

test('cheques: received in the portfolio, deposited, collected onto the invoices, a bounce reverses it; the tenant is told and we see whether they saw it', async () => {
  const b = brand('Cheque Test Co');
  const [u] = freeUnits(1);
  await admin.form('/admin/leases', { brand_id: String(b), units: String(u.id), rent_m2: '500', start_date: M.today(), term_years: '1', payment_freq: 'monthly', deposit: '0', key_money: '0' });
  const s = leaseFor(b);
  await admin.form(`/admin/leases/${s.id}/activate`, {});
  db.run("INSERT INTO portal_users (brand_id, name, email, password_hash, created_at) VALUES (?, 'Cheque Tenant', 'chq@tenant.test', ?, datetime('now'))", b, hashPassword('long-enough-1'));
  const inv = db.all("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent' ORDER BY due_date LIMIT 2", s.id);
  // the receive screen offers the lease's open invoices
  const form = await (await admin.go(`/admin/cheques/receive?lease=${s.id}`)).text();
  assert.match(form, new RegExp(inv[0].ref));
  let res = await admin.form('/admin/cheques', { brand_id: String(b), lease_id: String(s.id), rows: '2', received_on: M.today(),
    number_0: '5550001', bank_0: 'CIB', amount_0: String(inv[0].total), due_0: inv[0].due_date, invoice_0: String(inv[0].id),
    number_1: '5550002', bank_1: 'CIB', amount_1: String(inv[1].total), due_1: inv[1].due_date, invoice_1: String(inv[1].id) });
  assert.equal(res.status, 303);
  const [c1, c2] = db.all('SELECT * FROM cheques WHERE brand_id = ? ORDER BY id', b);
  assert.equal(c1.status, 'held');
  // deposit both from the portfolio
  res = await admin.form('/admin/cheques/deposit', { ids: String(c1.id), date: M.today(), bank: 'CIB current', ref: 'DS-1' });
  await admin.form('/admin/cheques/deposit', { ids: String(c2.id), date: M.today() });
  assert.equal(db.value('SELECT status FROM cheques WHERE id = ?', c1.id), 'deposited');
  const notice = db.get("SELECT * FROM portal_notices WHERE kind = 'cheque' AND entity_id = ? ORDER BY id LIMIT 1", c1.id);
  assert.ok(notice, 'the tenant is told it was deposited');
  assert.match(notice.title_ar, /[؀-ۿ]/, 'in Arabic too');
  const mail = db.get('SELECT * FROM notice_emails WHERE notice_id = ?', notice.id);
  assert.ok(mail, 'and emailed');
  // not seen yet; the email opened (the 1×1 image) counts as seen
  assert.match(await (await admin.go(`/admin/portal/notices/${notice.id}`)).text(), /Not seen yet/);
  const tok = (await db.get('SELECT id FROM notice_emails WHERE id = ?', mail.id)) && null;
  void tok;
  // collected: paid onto its invoice
  res = await admin.form(`/admin/cheques/${c1.id}/move`, { to: 'collected', date: M.today() });
  assert.equal(db.value('SELECT status FROM invoices WHERE id = ?', inv[0].id), 'paid');
  assert.equal(db.value("SELECT method FROM payments WHERE invoice_id = ? AND status = 'received'", inv[0].id), 'cheque');
  // the bank reverses it later: the payment is undone and the tenant and finance are told
  res = await admin.form(`/admin/cheques/${c1.id}/move`, { to: 'bounced', reason: 'chq|Insufficient funds' });
  assert.equal(db.value('SELECT status FROM cheques WHERE id = ?', c1.id), 'bounced');
  assert.notEqual(db.value('SELECT status FROM invoices WHERE id = ?', inv[0].id), 'paid');
  assert.ok(db.get("SELECT id FROM portal_notices WHERE kind = 'cheque' AND entity_id = ? AND title_en LIKE '%returned by the bank%'", c1.id));
  // a step that is not possible
  res = await admin.form(`/admin/cheques/${c2.id}/move`, { to: 'returned' });
  assert.equal(db.value('SELECT status FROM cheques WHERE id = ?', c2.id), 'deposited', 'a cheque at the bank cannot be handed back');
  // return the bounced one
  await admin.form(`/admin/cheques/${c1.id}/move`, { to: 'returned', reason: 'chq|Bounced, settled another way', returned_to: 'Tenant accountant' });
  assert.equal(db.value('SELECT status FROM cheques WHERE id = ?', c1.id), 'returned');
  assert.ok(db.value('SELECT COUNT(*) FROM cheque_events WHERE cheque_id = ?', c1.id) >= 5, 'the whole history');
  // the tenant reads it in the portal: seen
  const tenant = browser();
  const html = await (await tenant.go('/portal/login')).text();
  const token = html.match(/name="_token" value="([^"]+)"/);
  await tenant.go('/portal/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...(token ? { _token: token[1] } : {}), email: 'chq@tenant.test', password: 'long-enough-1' }).toString() });
  assert.equal((await tenant.go(`/portal/notices/${notice.id}`)).status, 200);
  assert.ok(db.get('SELECT * FROM portal_notice_reads WHERE notice_id = ?', notice.id), 'read in the portal');
  assert.match(await (await admin.go(`/admin/portal/notices/${notice.id}`)).text(), /Seen/);
  assert.equal((await tenant.go('/portal/cheques')).status, 200);
  // the books still balance
  h.ledger.sync({ upTo: '2100-12-31' });
  assert.ok(h.ledger.trialBalance({ from: '2000-01-01', to: '2100-12-31' }).balanced);
});

test('notification email opened: the image marks it seen', async () => {
  const b = brand('Pixel Co');
  db.run("INSERT INTO portal_users (brand_id, name, email, created_at) VALUES (?, 'Pixel Person', 'pixel@tenant.test', datetime('now'))", b);
  const id = h.tenantNotify(b, { kind: 'test', title: 'chq|Your cheque {number} was deposited', body: 'chq|Your cheque {number} from {bank} for {amount}, due {due}, has been deposited at the bank for collection.', params: { number: '1', bank: 'CIB', amount: '10', due: '2026-01-01' } });
  const out = db.get("SELECT body_html FROM outbox WHERE related_entity = 'portal_notice' AND related_id = ?", id);
  const m = out && out.body_html.match(/\/n\/([\w-]+)\.gif/);
  assert.ok(m, 'the email carries the image');
  const r = await fetch(`${base}/n/${m[1]}.gif`);
  assert.equal(r.status, 200);
  assert.ok(db.value('SELECT opened_at FROM notice_emails WHERE notice_id = ?', id), 'opened');
  assert.ok(h.noticeSeen(id).seen);
});

test('advances: given, taken off the payroll, shown on the payslip, the books balance', async () => {
  const emp = Number(db.run("INSERT INTO employees (code, name, hire_date, basic_salary, allowances, status, created_at, updated_at) VALUES ('ADV-1', 'Advance Person', '2025-01-01', 12000, 2000, 'active', datetime('now'), datetime('now'))").lastInsertRowid);
  const period = M.today().slice(0, 7);
  let res = await admin.form('/admin/hr/advances', { employee_id: String(emp), amount: '6000', installments: '3', start_period: period, issued_on: M.today(), method: 'cash', reason: 'Test' });
  assert.equal(res.status, 303);
  const a = db.get('SELECT * FROM hr_advances WHERE employee_id = ?', emp);
  assert.equal(a.monthly, 2000);
  if (!db.get('SELECT id FROM payroll_runs WHERE period = ?', period)) await admin.form('/admin/hr/payroll', { period });
  const run = db.get('SELECT * FROM payroll_runs WHERE period = ?', period);
  if (run.status === 'draft') h.hrRecalc(run);
  const line = db.get('SELECT * FROM payroll_lines WHERE run_id = ? AND employee_id = ?', run.id, emp);
  assert.equal(line.advance, 2000, 'this month’s installment');
  assert.ok(line.net < 14000 - 2000 + 0.01);
  const slip = await (await admin.go(`/admin/hr/payroll/${run.id}/slip/${emp}`)).text();
  assert.match(slip, /Salary advance repayment/);
  // approved: repaid 2000 of 6000
  await admin.form(`/admin/hr/payroll/${run.id}/approve`, {});
  assert.equal(h.advances.remaining(a), 4000);
  // the rest in cash: settled
  await admin.form(`/admin/hr/advances/${a.id}/repay`, { amount: '4000', date: M.today() });
  assert.equal(db.value('SELECT status FROM hr_advances WHERE id = ?', a.id), 'settled');
  assert.equal((await admin.go('/admin/hr/advances?status=all')).status, 200);
  h.ledger.sync({ upTo: '2100-12-31' });
  assert.ok(h.ledger.trialBalance({ from: '2000-01-01', to: '2100-12-31' }).balanced);
});

test('lists: filter by date, tenant and contract; columns sort', async () => {
  const s = db.get("SELECT * FROM leases WHERE status = 'active' ORDER BY id LIMIT 1");
  const html = await (await admin.go(`/admin/billing?status=all&lease=${s.id}`)).text();
  assert.match(html, /class="filters"/);
  const refs = [...html.matchAll(/<b>(IN-\d{4}-\d{4})<\/b>/g)].map((x) => x[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) assert.equal(db.value('SELECT lease_id FROM invoices WHERE ref = ?', ref), s.id, 'only that contract’s invoices');
  const dated = await (await admin.go(`/admin/billing?status=all&from=2099-01-01`)).text();
  assert.doesNotMatch(dated, /<b>IN-\d{4}-\d{4}<\/b>/, 'nothing due after 2099');
  assert.match(html, /data-sort="\d{4}-\d{2}-\d{2}"/, 'dates sort by their value');
  for (const p of ['/admin/leases?from=2020-01-01', '/admin/cheques?status=all&from=2020-01-01', '/admin/contracts?from=2020-01-01', '/admin/maintenance/orders?from=2020-01-01']) assert.equal((await admin.go(p)).status, 200, p);
});
