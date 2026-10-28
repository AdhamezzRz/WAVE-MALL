'use strict';

// Revenue modules: turnover (percentage) rent, the service charge reconciliation and utilities
// recharge — the arithmetic by hand, then billing through the office: once per period, credit notes
// carried to the next invoice, the tenant portal limited to its own brand, and the sample data.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const C = require('../src/admin/revenue/calc');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let app;
let csrf;
const jar = new Map();

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
const flash = (cookies = jar) => {
  try {
    return JSON.parse(decodeURIComponent(cookies.get('wv_flash') || '{}'));
  } catch {
    return {};
  }
};

before(async () => {
  app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready; // the office opens in the background on older Node (sql.js)
  base = `http://127.0.0.1:${server.address().port}`;
  const setup = await (await go('/admin/setup?lang=en')).text();
  await go('/admin/setup', form({ _token: setup.match(/name="_token" value="([^"]+)"/)[1], name: 'Admin', email: 'admin@thewave.test', password: 'long-enough-1' }));
  csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
});
after(() => server.close());

// ---------- the arithmetic ----------
test('revenue: percentage rent, natural and fixed breakpoints', () => {
  // natural: the tenant pays the part of pct × sales above the base rent
  assert.equal(C.pctRent({ sales: 1000000, pct: 10, base: 80000, type: 'natural' }), 20000);
  assert.equal(C.pctRent({ sales: 500000, pct: 10, base: 80000, type: 'natural' }), 0, 'below the breakpoint nothing is due');
  // fixed: pct of the sales above an agreed amount
  assert.equal(C.pctRent({ sales: 1000000, pct: 8, type: 'fixed', breakpoint: 600000 }), 32000);
  assert.equal(C.breakpointFor({ breakpoint_type: 'natural', pct: 10 }, 80000, 1), 800000);
  assert.equal(C.breakpointFor({ breakpoint_type: 'fixed', breakpoint: 1200000 }, 0, 3), 300000, 'a quarter of the yearly breakpoint');
  // base rent: rent-free months, the yearly escalation, a part first month
  const lease = { start_date: '2026-01-16', end_date: '2030-01-15', rent_m2: 1000, terrace_rent_m2: 0, escalation_pct: 10, rent_free_months: 1 };
  const units = [{ indoor_m2: 100, terrace_m2: 0 }];
  assert.equal(C.baseRentMonth(lease, units, '2026-01'), 0, 'rent free');
  assert.equal(C.baseRentMonth(lease, units, '2026-02'), 100000);
  assert.equal(C.baseRentMonth(lease, units, '2027-01'), 110000, 'the second lease year, escalated');
  assert.equal(C.r2(C.monthCover(lease, '2026-01')), C.r2(16 / 31));
});

test('revenue: apportionment shares exactly the costs, with vacancy and caps on the landlord', () => {
  const units = [
    { id: 1, area: 100, occupied: [{ lease_id: 'a', fraction: 1 }] },
    { id: 2, area: 200, weight: 1.5, occupied: [{ lease_id: 'b', fraction: 0.5 }] }, // held half the year
    { id: 3, area: 300, occupied: [] }, // vacant
    { id: 4, area: 50, excluded: true, occupied: [{ lease_id: 'c', fraction: 1 }] },
    { id: 5, area: 77, cap: 1000, occupied: [{ lease_id: 'd', fraction: 0.4 }, { lease_id: 'e', fraction: 0.6 }] },
  ];
  const r = C.apportion(100000, units);
  const tenants = Object.values(r.leases).reduce((s, v) => s + v, 0);
  assert.equal(C.r2(tenants + r.landlord), 100000, 'tenants and landlord carry exactly the costs');
  assert.equal(C.r2(r.units.reduce((s, u) => s + u.share, 0)), 100000);
  assert.equal(C.r2(r.units.reduce((s, u) => s + u.pct, 0)), 1, 'the pool is 100%');
  assert.equal(r.leases.c, undefined, 'an excluded unit is outside the pool');
  const u2 = r.units.find((u) => u.id === 2);
  assert.equal(r.leases.b, C.r2(u2.share / 2), 'half a year, half the share');
  assert.equal(C.r2(r.leases.d + r.leases.e), 1000, 'the cap holds across the unit’s leases');
  assert.ok(r.capped > 0 && r.vacancy > 0);
  // weights: unit 2 counts 1.5 × its area
  assert.equal(C.r2(u2.pct), C.r2(300 / (100 + 300 + 300 + 77)));
  // nothing to share, or nobody in the pool
  assert.equal(C.apportion(5000, [{ id: 1, area: 10, excluded: true }]).landlord, 5000);
});

test('revenue: meter consumption — rollover, drops and unusual use; tiered tariffs', () => {
  assert.deepEqual(C.consumption({ previous: null, reading: 500 }), { consumption: null, flag: 'first' });
  assert.deepEqual(C.consumption({ previous: 1000, reading: 1250, history: [240, 260] }), { consumption: 250, flag: null });
  assert.deepEqual(C.consumption({ previous: 999900, reading: 70, digits: 6 }), { consumption: 170, flag: 'rollover' });
  assert.deepEqual(C.consumption({ previous: 5000, reading: 4000 }), { consumption: null, flag: 'negative' });
  assert.equal(C.consumption({ previous: 1000, reading: 4000, history: [1000, 1000, 1000] }).flag, 'abnormal');
  assert.equal(C.consumption({ previous: 1000, reading: 1100, history: [1000, 1000, 1000] }).flag, 'abnormal', 'a sudden drop too');
  assert.equal(C.consumption({ previous: 100, reading: 150, multiplier: 10 }).consumption, 500, 'CT multiplier');
  const tiers = JSON.stringify([{ upto: 100, rate: 1 }, { upto: 500, rate: 2 }, { upto: null, rate: 3 }]);
  assert.equal(C.tariffCost(450, { tiers, fixed_monthly: 50 }), 100 + 700 + 50);
  assert.equal(C.tariffCost(600, { tiers }), 100 + 800 + 300);
  assert.equal(C.tariffCost(100, { rate: 2.5 }), 250);
});

// ---------- the office ----------
const Y = new Date().getUTCFullYear();
let leaseA;
let leaseB;
let brandA;
let brandB;

function seedLeases() {
  const { db } = app.locals.admin;
  const now = new Date().toISOString();
  const unit = (code) => db.get('SELECT * FROM units WHERE code = ?', code);
  const mk = (name, code, ref) => {
    const b = Number(db.run('INSERT INTO brands (name, category, created_at) VALUES (?, ?, ?)', name, 'fashion', now).lastInsertRowid);
    const s = Number(db.run(
      `INSERT INTO leases (ref, brand_id, status, start_date, end_date, term_years, rent_m2, terrace_rent_m2, service_m2, escalation_pct, rent_free_months, payment_freq, created_at)
       VALUES (?, ?, 'active', ?, ?, 5, 1000, 0, 100, 0, 0, 'monthly', ?)`, ref, b, `${Y - 1}-01-01`, `${Y + 3}-12-31`, now,
    ).lastInsertRowid);
    db.run('INSERT INTO lease_units (lease_id, unit_id) VALUES (?, ?)', s, unit(code).id);
    db.run("UPDATE units SET status = 'leased' WHERE code = ?", code);
    return [b, s];
  };
  [brandA, leaseA] = mk('Alpha Fashion', 'G03', 'LS-T-001');
  [brandB, leaseB] = mk('Beta Shoes', 'G05', 'LS-T-002');
}

test('turnover: terms, sales, a bill once per period, the true-up as a credit note', async () => {
  seedLeases();
  const { db, h } = app.locals.admin;
  const T = h.revenue.turnover;
  const area = db.value("SELECT indoor_m2 FROM units WHERE code = 'G03'");
  const base = area * 1000;

  let res = await go(`/admin/turnover/leases/${leaseA}/terms`, form({ _csrf: csrf, pct: 12, breakpoint_type: 'natural', frequency: 'monthly', due_day: 10, annual_recon: 1 }));
  assert.equal(res.status, 303);
  assert.equal(T.termsOf(leaseA).pct, 12);

  // sales for March last year: 10 × base rent → 12% of sales above the base rent
  const period = `${Y - 1}-03`;
  res = await go(`/admin/turnover/leases/${leaseA}/sales`, form({ _csrf: csrf, period, gross: base * 10 + 5000, returns: 5000, transactions: 900 }));
  assert.equal(flash().type, 'ok', JSON.stringify(flash()));
  const sale = db.get('SELECT * FROM tenant_sales WHERE lease_id = ? AND period = ?', leaseA, period);
  assert.equal(sale.amount, base * 10);
  assert.equal(sale.brand_id, brandA, 'tenant_sales carries the brand for other modules');

  // returns larger than the sales are refused
  await go(`/admin/turnover/leases/${leaseA}/sales`, form({ _csrf: csrf, period: `${Y - 1}-04`, gross: 100, returns: 200 }));
  assert.equal(flash().type, 'error');

  res = await go('/admin/turnover/bill', form({ _csrf: csrf, lease_id: leaseA, period }));
  assert.equal(flash().type, 'ok', JSON.stringify(flash()));
  const inv = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'turnover'", leaseA);
  assert.equal(inv.other, C.r2(base * 10 * 0.12 - base));
  assert.equal(inv.source, 'turnover');
  assert.equal(inv.note, `Turnover rent ${period}`);

  // billing the same period again is refused, and the month's sales are locked
  await go('/admin/turnover/bill', form({ _csrf: csrf, lease_id: leaseA, period }));
  assert.equal(flash().type, 'error');
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE lease_id = ? AND kind = 'turnover'", leaseA), 1);
  await go(`/admin/turnover/leases/${leaseA}/sales`, form({ _csrf: csrf, period, gross: 1, returns: 0 }));
  assert.equal(flash().type, 'error');
  assert.equal(db.value('SELECT amount FROM tenant_sales WHERE id = ?', sale.id), base * 10);

  // a period with sales missing cannot be billed
  await go('/admin/turnover/bill', form({ _csrf: csrf, lease_id: leaseA, period: `${Y - 1}-05` }));
  assert.match(flash().text, /missing/i);

  // the year's true-up: every other month of last year had low sales, so on the year the tenant
  // paid more than 12% of the year's sales above the year's base rent → a credit note
  const lease = { ...db.get('SELECT * FROM leases WHERE id = ?', leaseA), units: db.all('SELECT u.* FROM lease_units lu JOIN units u ON u.id = lu.unit_id WHERE lu.lease_id = ?', leaseA) };
  for (const ym of C.ymRange(`${Y - 1}-01`, `${Y - 1}-12`)) if (ym !== period) T.saveSales(lease, ym, { gross: base * 2 });
  const annual = T.calcAnnual(lease, T.termsOf(leaseA), String(Y - 1));
  assert.equal(annual.previously, inv.other);
  assert.equal(annual.due, C.pctRent({ sales: base * 32, pct: 12, base: base * 12, type: 'natural' }));
  res = await go('/admin/turnover/bill', form({ _csrf: csrf, lease_id: leaseA, period: String(Y - 1) }));
  assert.equal(flash().type, 'ok', JSON.stringify(flash()));
  const cn = db.get("SELECT * FROM revenue_credits WHERE lease_id = ? AND source = 'turnover'", leaseA);
  assert.equal(cn.amount, C.r2(inv.other - annual.due));
  assert.match(cn.ref, new RegExp(`^CN-${Y}-\\d{4}$`));
  // the tenant was paid back: the credit is closed and not set against later invoices
  await go(`/admin/service-charge/credits/${cn.id}/refund`, form({ _csrf: csrf }));
  assert.equal(db.value('SELECT status FROM revenue_credits WHERE id = ?', cn.id), 'refunded');

  // pages render
  for (const p of ['/admin/turnover', '/admin/turnover/sales', '/admin/turnover/billing', '/admin/turnover/terms', `/admin/turnover/leases/${leaseA}`, `/admin/turnover/leases/${leaseA}/statement?year=${Y - 1}`, `/admin/turnover/leases/${leaseA}/statement?year=${Y - 1}&doc=ar`]) {
    res = await go(p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, p);
  }
  // voiding the turnover invoice releases its period
  h.billing.voidInvoice(inv.id);
  assert.equal(db.value('SELECT COUNT(*) FROM turnover_bills WHERE lease_id = ? AND period = ?', leaseA, period), 0);
});

test('service charge: last year’s reconciliation balances, settles once, and credits carry forward', async () => {
  const { db, h } = app.locals.admin;
  const S = h.revenue.service;
  const year = Y - 1;
  let res = await go('/admin/service-charge/budget', form({ _csrf: csrf, year, amount_security: 900000, rec_security: 1, amount_cleaning: 300000, rec_cleaning: 1, amount_other: 50000, mgmt_fee_pct: 10 }));
  assert.equal(res.status, 303);
  assert.equal(S.budgetOf(year).mgmt_fee_pct, 10);
  assert.equal(db.value('SELECT recoverable FROM sc_lines WHERE category = ? AND budget_id = ?', 'other', S.budgetOf(year).id), 0);

  await go('/admin/service-charge/actuals', form({ _csrf: csrf, year, period: `${year}-06`, category: 'security', amount: 1000000, description: 'Guards' }));
  await go('/admin/service-charge/actuals/import', form({ _csrf: csrf, year, rows: `month,category,amount,description\n${year}-07,cleaning,200000,Cleaner\n${year}-08,"Cleaning and waste","50,000",Bins\n${year}-09,other,40000,Owner\nnot a row` }));
  assert.match(flash().text, /3 rows imported; rows 4/);
  assert.equal(db.value('SELECT SUM(amount) FROM sc_actuals WHERE year = ?', year), 1290000);

  // billed on account: one invoice each for last year's service charge; B was billed more than its share
  let r = S.recon(year);
  assert.equal(r.mode, 'final');
  assert.equal(r.pool, C.r2(1250000 * 1.1), 'recoverable costs plus the management fee; "other" stays with the landlord');
  const shareA = r.appor.leases[leaseA];
  const shareB = r.appor.leases[leaseB];
  assert.ok(shareA > 0 && shareB > 0);
  h.billing.createInvoice({ lease_id: leaseA, kind: 'rent', service: C.r2(shareA - 3000), rent: 1, period_start: `${year}-01-01`, period_end: `${year}-12-31`, due_date: `${year}-01-05` });
  h.billing.createInvoice({ lease_id: leaseB, kind: 'rent', service: C.r2(shareB + 5000), rent: 1, period_start: `${year}-01-01`, period_end: `${year}-12-31`, due_date: `${year}-01-05` });
  r = S.recon(year);
  assert.equal(C.r2(r.tenants + r.appor.landlord), r.pool, 'tenants and landlord carry the costs in full');
  assert.equal(r.rows.find((x) => x.lease.id === leaseA).balance, 3000);
  assert.equal(r.rows.find((x) => x.lease.id === leaseB).balance, -5000);

  res = await go('/admin/service-charge/settle', form({ _csrf: csrf, year }));
  assert.equal(flash().type, 'ok', JSON.stringify(flash()));
  const settleInv = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'service_recon'", leaseA);
  assert.equal(settleInv.service, 3000);
  assert.equal(settleInv.note, `Service charge settlement ${year}`);
  const credit = db.get("SELECT * FROM revenue_credits WHERE lease_id = ? AND source = 'service_recon'", leaseB);
  assert.equal(credit.amount, 5000);
  assert.equal(credit.status, 'open');

  // once only; the year's costs and rules are locked
  await go('/admin/service-charge/settle', form({ _csrf: csrf, year }));
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE kind = 'service_recon'"), 1);
  assert.equal(db.value('SELECT COUNT(*) FROM sc_recons WHERE year = ?', year), 2);
  await go('/admin/service-charge/rules', form({ _csrf: csrf, year }));
  assert.equal(flash().type, 'error');
  // this year's reconciliation cannot be issued before the year ends
  assert.throws(() => S.settle(Y, null), /once the year has ended/);

  for (const p of [`/admin/service-charge?year=${year}`, `/admin/service-charge/budget?year=${year}`, `/admin/service-charge/actuals?year=${year}`, `/admin/service-charge/rules?year=${year}`, `/admin/service-charge/reconciliation?year=${year}`, '/admin/service-charge/credits', `/admin/service-charge/statement/${leaseA}?year=${year}`, `/admin/service-charge/statement/${leaseB}?year=${year}&doc=ar`]) {
    res = await go(p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, p);
  }
});

test('utilities: readings with checks, billing once per meter and month, credits applied', async () => {
  const { db, h } = app.locals.admin;
  const U = h.revenue.utilities;
  const LM = C.ymAdd(C.ymOf(new Date().toISOString()), -1);
  const months = [C.ymAdd(LM, -4), C.ymAdd(LM, -3), C.ymAdd(LM, -2), C.ymAdd(LM, -1), LM];
  let res = await go('/admin/utilities/meters', form({ _csrf: csrf, code: 'e-g03', utility: 'electricity', unit_id: db.value("SELECT id FROM units WHERE code = 'G03'"), digits: 6, multiplier: 1 }));
  const mA = db.get("SELECT * FROM utl_meters WHERE code = 'E-G03'");
  assert.ok(mA, 'codes are kept upper case');
  await go('/admin/utilities/meters', form({ _csrf: csrf, code: 'E-G05', utility: 'electricity', unit_id: db.value("SELECT id FROM units WHERE code = 'G05'"), digits: 6 }));
  const mB = db.get("SELECT * FROM utl_meters WHERE code = 'E-G05'");
  await go('/admin/utilities/meters', form({ _csrf: csrf, code: 'E-G05', utility: 'water' }));
  assert.match(flash().text, /already exists/);

  // A: steady use, then a spike in the last month; B: a large use (more than its 5,000 credit)
  [1000, 2000, 3000, 4000, 9000].forEach((v, i) => U.saveReading(mA, months[i], v));
  U.saveReading(mB, months[3], 100);
  res = await go('/admin/utilities/readings/import', form({ _csrf: csrf, period: LM, rows: 'E-G05;10100\nNOPE;5' }));
  assert.match(flash().text, /1 readings imported; rows 2/);
  const spike = db.get('SELECT * FROM utl_readings WHERE meter_id = ? AND period = ?', mA.id, LM);
  assert.equal(spike.consumption, 5000);
  assert.equal(spike.flag, 'abnormal');
  assert.equal(spike.accepted, 0);
  // a reading longer than the meter's dial is refused
  assert.throws(() => U.saveReading(mA, LM, 1e7), /more digits/);

  const p = U.preview(LM);
  assert.deepEqual(p.blocked.map((x) => x.m.code), ['E-G03'], 'the spike is held back');
  res = await go('/admin/utilities/bill', form({ _csrf: csrf, period: LM }));
  assert.equal(flash().type, 'ok', JSON.stringify(flash()));
  const invB = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'utility'", leaseB);
  const tariff = U.tariffFor('electricity', LM);
  const cost = C.tariffCost(10000, tariff);
  assert.equal(invB.other, C.r2(cost - 5000), 'the open service-charge credit is set against it');
  assert.match(invB.note, /less credit CN-/);
  assert.equal(db.value("SELECT status FROM revenue_credits WHERE lease_id = ? AND source = 'service_recon'", leaseB), 'applied');

  // accept the spike, bill again: only A is billed; B is never billed twice
  await go(`/admin/utilities/readings/${spike.id}/accept`, form({ _csrf: csrf }));
  await go('/admin/utilities/bill', form({ _csrf: csrf, period: LM }));
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE lease_id = ? AND kind = 'utility'", leaseB), 1);
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE lease_id = ? AND kind = 'utility'", leaseA), 1);
  assert.equal(db.value('SELECT COUNT(*) FROM utl_bills WHERE period = ?', LM), 2);
  await go('/admin/utilities/bill', form({ _csrf: csrf, period: LM }));
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE kind = 'utility'"), 2);
  // a billed month's reading is locked
  assert.throws(() => U.saveReading(mA, LM, 9100), /locked/);

  // a common-area meter's cost becomes a service-charge actual
  await go('/admin/utilities/meters', form({ _csrf: csrf, code: 'E-100', utility: 'electricity', area: 'Plaza lighting' }));
  const mC = db.get("SELECT * FROM utl_meters WHERE code = 'E-100'");
  U.saveReading(mC, months[3], 500);
  U.saveReading(mC, LM, 1500);
  const actual = db.get("SELECT * FROM sc_actuals WHERE source = 'utilities' AND source_ref = ?", `meter:${mC.id}:${LM}`);
  assert.equal(actual.amount, C.tariffCost(1000, tariff));
  assert.equal(actual.category, 'utilities');

  for (const path of ['/admin/utilities', `/admin/utilities/readings?period=${LM}`, `/admin/utilities/billing?period=${LM}`, '/admin/utilities/meters', `/admin/utilities/meters/${mA.id}`, '/admin/utilities/tariffs']) {
    res = await go(path);
    assert.equal(res.status, 200, path);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, path);
  }
});

test('portal: a tenant reports its own sales and sees only its own meters', async () => {
  const { db } = app.locals.admin;
  if (!app.locals.admin.h.portal) return; // the portal module is not installed
  const now = new Date().toISOString();
  db.run('INSERT INTO portal_users (brand_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', brandB, 'Bea', 'bea@beta.test', hashPassword('tenant-pass-1'), now);
  const t = new Map();
  const login = await (await go('/portal/login?lang=en', {}, t)).text();
  let res = await go('/portal/login', form({ _token: login.match(/name="_token" value="([^"]+)"/)[1], email: 'bea@beta.test', password: 'tenant-pass-1' }), t);
  assert.equal(res.status, 303);
  const page = await (await go('/portal/sales', {}, t)).text();
  assert.match(page, /Report sales/);
  assert.doesNotMatch(page, /Alpha Fashion|G03/, 'nothing of another brand');
  const pcsrf = page.match(/name="csrf" content="([^"]+)"/)[1];
  const LM = C.ymAdd(C.ymOf(now), -1);

  // another brand's lease is refused
  const before = db.value('SELECT COUNT(*) FROM tenant_sales WHERE lease_id = ?', leaseA);
  res = await go('/portal/sales', form({ _csrf: pcsrf, lease_id: leaseA, period: LM, gross: 999 }), t);
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM tenant_sales WHERE lease_id = ?', leaseA), before);
  // its own lease is accepted, marked as from the portal
  res = await go('/portal/sales', form({ _csrf: pcsrf, lease_id: leaseB, period: LM, gross: 250000, returns: 1000, transactions: 300 }), t);
  const s = db.get('SELECT * FROM tenant_sales WHERE lease_id = ? AND period = ?', leaseB, LM);
  assert.equal(s.amount, 249000);
  assert.equal(s.submitted_via, 'portal');
  assert.equal(s.status, 'submitted');
  // without the portal's CSRF token nothing changes
  res = await go('/portal/sales', form({ lease_id: leaseB, period: LM, gross: 1 }), t);
  assert.equal(res.status, 403);

  const util = await (await go('/portal/utilities', {}, t)).text();
  assert.match(util, /E-G05/);
  assert.doesNotMatch(util, /E-G03|E-100/);
  // the office is not reachable with a tenant session
  res = await go('/admin/turnover', {}, t);
  assert.equal(res.status, 303);
});

test('revenue: sample data renders in both languages and clears', async () => {
  const { db } = app.locals.admin;
  await go('/admin/settings/demo', form({ _csrf: csrf }));
  assert.ok(db.value('SELECT COUNT(*) FROM utl_meters WHERE demo = 1') > 0);
  assert.ok(db.value('SELECT COUNT(*) FROM sc_actuals WHERE demo = 1') > 0 || db.value('SELECT COUNT(*) FROM sc_budgets') > 0);
  for (const lang of ['en', 'ar']) {
    await go('/admin/lang', form({ _csrf: csrf, lang, back: '/admin' }));
    for (const p of ['/admin/turnover', '/admin/turnover/billing', '/admin/service-charge', '/admin/service-charge/rules', '/admin/service-charge/reconciliation', '/admin/utilities', '/admin/utilities/readings', '/admin/utilities/billing']) {
      const res = await go(p);
      assert.equal(res.status, 200, `${lang} ${p}`);
      assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]|Infinity/, `${lang} ${p}`);
    }
  }
  await go('/admin/lang', form({ _csrf: csrf, lang: 'en', back: '/admin' }));
  await go('/admin/settings/demo/clear', form({ _csrf: csrf }));
  assert.equal(db.value('SELECT COUNT(*) FROM utl_meters WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM tenant_sales WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM turnover_terms WHERE demo = 1'), 0);
  // the test's own records survive
  assert.ok(db.value('SELECT COUNT(*) FROM utl_meters') >= 3);
  assert.ok(db.value('SELECT COUNT(*) FROM sc_recons') === 2);
});
