'use strict';

// Import from Excel, leasing and revenue: tenant contacts (and portal accounts), leads, leases (with
// every term, activated at go-live from "Invoice rent from", deposits already received, past leases),
// service contracts, opening balances (in the books against Opening balances), cheques and tenants'
// monthly sales. Round trips of the sample data change nothing, in English and in Arabic; bad rows
// are refused with the reason; undo puts everything back.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let db;
let h;
let admin;
let agent;

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
const me = () => db.get("SELECT * FROM users WHERE email = 'x1-admin@thewave.test'");
// upload rows (first row: the titles) and preview them as `who`
async function check(key, rows, { as = admin, options = {}, lang = 'en' } = {}) {
  // rows (the first row: the titles) or the bytes of a workbook (the same file uploaded twice)
  const up = await as.upload(key, Buffer.isBuffer(rows) ? rows : await xlsx(rows), `${key}.xlsx`);
  assert.equal(up.ok, true, up.error);
  const st = stage(tokenOf(up.url));
  const m = h.imports.mapColumns(st.d, h.imports.grid(st).headers);
  h.imports.setMapping(st.token, Object.fromEntries(m.columns.filter((x) => !x.empty).map((x) => [x.index, x.key || ''])));
  const who = db.get('SELECT * FROM users WHERE id = ?', as === agent ? db.value("SELECT id FROM users WHERE email = 'x1-agent@thewave.test'") : me().id);
  return { st, pv: h.imports.preview(stage(st.token), options, lang, who), who, map: m };
}
const errs = (pv, line) => pv.rows.find((r) => r.line === line).errors.map((e) => e.key);
const commit = (st, who, options = {}) => h.imports.commit(stage(st.token), options, who, 'en');

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  user('X1 Admin', 'x1-admin@thewave.test', 'admin', { hr: 1, finance: 1 });
  user('X1 Agent', 'x1-agent@thewave.test', 'agent');
  require('../src/admin/demo').load(db, me(), { files: h.files, billing: h.billing, h });
  admin = browser();
  await admin.signIn('x1-admin@thewave.test');
  agent = browser();
  await agent.signIn('x1-agent@thewave.test');
});
after(() => server.close());

const KEYS = ['tenant-contacts', 'leads', 'leases', 'service-contracts', 'opening-balances', 'cheques', 'tenant-sales'];

test('import x1: every leasing and revenue dataset is registered, in the right go-live order', () => {
  const list = h.imports.list().map((d) => d.key);
  for (const k of KEYS) assert.ok(list.includes(k), k);
  const at = (k) => list.indexOf(k);
  assert.ok(at('units') < at('brands') && at('brands') < at('tenant-contacts') && at('tenant-contacts') < at('leases'));
  assert.ok(at('leases') < at('opening-balances') && at('opening-balances') < at('cheques'));
});

test('import x1: leases — a contracts workbook at go-live (active from a date, deposits held, history), with every rule', async () => {
  const t = h.M.today();
  const year = Number(t.slice(0, 4));
  const head = ['Contract number', 'Tenant (brand) *', 'Units *', 'Status', 'Start date *', 'Term (years) *', 'End date', 'Rent per m² a month', 'Yearly increase (%)', 'Increase changes from year (1)', 'Increase becomes (%) (1)',
    'Service charge is', 'Service per m² a month', 'Service (% of the rent)', 'Revenue share', 'Share of sales (%)', 'Minimum guarantee a month', 'Invoiced', 'Security deposit', 'Deposit already received', 'Invoice rent from', 'Signed on'];
  const rows = [head,
    // 2: active, quarterly, from two years ago; billed from the first of next month
    ['C-2024-101', 'Ember Grill', 'G03', 'Active', `${year - 2}-01-01`, 5, '', 1400, 10, 4, 12.5, '', 140, '', 'No', '', '', 'Quarterly in advance', 300000, '', `${t.slice(0, 7)}-01`, `${year - 3}-11-20`],
    // 3: revenue share with a guarantee, service as % of the rent, monthly, part of the deposit received
    ['C-2025-102', 'Habibi Gelato', 'G06, g07', 'active', `${year - 1}-06-01`, 6, '', '', 8, '', '', 'A percentage of the rent', '', 10, 'Yes', 8, 120000, 'Monthly in advance', 400000, 250000, '', ''],
    // 4: a past lease, kept as history
    ['C-2018-007', 'Atelier Nour', 'S03', 'Ended', '2018-02-01', 5, '2023-01-31', 900, 7, '', '', '', 100, '', '', '', '', '', 0, '', '', ''],
    // 5: a draft
    ['', 'Nile Optics', 'S04', 'Draft', `${year + 1}-01-01`, 3, '', 1600, 10, '', '', '', 150, '', '', '', '', '', 0, '', '', ''],
    // 6: problems: the same unit as row 2 at the same time, a made-up system number, an end date that is not whole years
    ['LS-2024-999', 'Ember Grill', 'G03', 'Active', `${year - 2}-06-01`, 3, `${year}-03-01`, 1000, 0, '', '', '', '', '', '', '', '', '', 0, '', '', ''],
    // 7: a unit that does not exist, no rent and no share
    ['C-2024-103', 'Cotton Trail', 'Z99', 'Draft', `${year + 1}-01-01`, 2, '', '', 0, '', '', '', '', '', '', '', '', '', 0, '', '', ''],
    // 8: a stepped increase without its year, a unit merged away is not possible here; a unit leased by someone else
    ['C-2024-104', 'Cotton Trail', 'G01', 'Active', `${year}-01-01`, 3, '', 1000, 5, '', 9, '', '', '', '', '', '', '', 0, '', '', ''],
  ];
  const file = await xlsx(rows);
  const { st, pv, who } = await check('leases', file);
  assert.equal(pv.rows.find((r) => r.line === 2).status, 'new', JSON.stringify(pv.rows.find((r) => r.line === 2).errors));
  assert.equal(pv.rows.find((r) => r.line === 3).status, 'new', JSON.stringify(pv.rows.find((r) => r.line === 3).errors));
  assert.equal(pv.rows.find((r) => r.line === 4).status, 'new');
  assert.equal(pv.rows.find((r) => r.line === 5).status, 'new');
  const e6 = errs(pv, 6);
  assert.ok(e6.some((k) => /looks like a number the office gives/.test(k)), e6.join(' / '));
  assert.ok(e6.some((k) => /Leases run whole years/.test(k)), e6.join(' / '));
  const e7 = errs(pv, 7);
  assert.ok(e7.some((k) => /is not in the system/.test(k)) && e7.some((k) => /Give the rent per m²/.test(k)), e7.join(' / '));
  const e8 = errs(pv, 8);
  assert.ok(e8.some((k) => /both the year and the percentage/.test(k)) && e8.some((k) => /already leased|at the same time/.test(k)), e8.join(' / '));
  // all or nothing refuses; valid rows only imports 2–5
  assert.ok(commit(st, who).error);
  const done = commit(st, who, { mode: 'valid' });
  assert.equal(done.counts.created, 4, JSON.stringify(done.failed));

  // row 2: units leased, rent billed only from the first of this month on, the deposit held as paid history
  const a = db.get("SELECT * FROM leases WHERE ref = 'C-2024-101'");
  assert.equal(a.status, 'active');
  assert.equal(a.end_date, `${year + 2}-12-31`);
  assert.deepEqual(JSON.parse(a.escalation_steps), [{ from: 4, pct: 12.5 }]);
  assert.equal(db.value("SELECT status FROM units WHERE code = 'G03'"), 'leased');
  const rent = db.all("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent' ORDER BY period_start", a.id);
  assert.ok(rent.length > 0 && rent.every((i) => i.period_start >= `${t.slice(0, 7)}-01`), 'no rent before the go-live date');
  assert.equal(rent.length, h.M.invoicePlan(a, h.M.leaseUnits(db, a.id)).filter((p) => p.period_start >= `${t.slice(0, 7)}-01`).length);
  const dep = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'deposit'", a.id);
  assert.equal(dep.status, 'paid');
  assert.equal(dep.total, 300000);
  assert.equal(db.value("SELECT note FROM payments WHERE invoice_id = ?", dep.id), 'Received before go-live');
  // the deposit history leaves the books as they were (it is in the opening trial balance)
  const net = db.value("SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.source_base IN (?, ?)", `inv:${dep.id}`, `pay:${db.value('SELECT id FROM payments WHERE invoice_id = ?', dep.id)}`);
  assert.equal(Math.round(net), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM acc_entries WHERE source_base = ? AND reversed_by IS NULL", `inv:${dep.id}`), 1);

  // row 3: revenue share terms, both units, service as a %, the rest of the deposit billed now
  const b = db.get("SELECT * FROM leases WHERE ref = 'C-2025-102'");
  assert.equal(b.revenue_share, 1);
  assert.equal(b.revenue_pct, 8);
  assert.equal(b.min_guarantee, 120000);
  assert.equal(b.service_mode, 'pct');
  assert.equal(b.payment_freq, 'monthly');
  assert.deepEqual(h.M.leaseUnits(db, b.id).map((u) => u.code).sort(), ['G06', 'G07']);
  assert.equal(db.value('SELECT pct FROM turnover_terms WHERE lease_id = ?', b.id), 8);
  const deps = db.all("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'deposit' ORDER BY id", b.id);
  assert.deepEqual(deps.map((i) => [i.total, i.status]), [[250000, 'paid'], [150000, 'open']]);
  assert.ok(db.all("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent'", b.id).every((i) => i.period_start >= t), 'billed from today');

  // row 4: history only
  const c = db.get("SELECT * FROM leases WHERE ref = 'C-2018-007'");
  assert.equal(c.status, 'ended');
  assert.equal(c.end_date, '2023-01-31');
  assert.equal(db.value('SELECT COUNT(*) FROM invoices WHERE lease_id = ?', c.id), 0);
  assert.equal(db.value("SELECT status FROM units WHERE code = 'S03'"), 'available');
  // row 5: a draft numbered by the office
  const d = db.get("SELECT * FROM leases WHERE brand_id = (SELECT id FROM brands WHERE name = 'Nile Optics') AND status = 'draft'");
  assert.match(d.ref, /^LS-\d{4}-\d{3}$/);
  assert.equal(db.value("SELECT status FROM units WHERE code = 'S04'"), 'available');

  // the same file again: unchanged rows, and the terms of a lease in the system cannot change by an import
  const again = await check('leases', file);
  assert.ok(again.pv.again, 'the identical upload is noticed');
  for (const line of [2, 3, 4]) assert.equal(again.pv.rows.find((r) => r.line === line).status, 'same', `${line}: ${JSON.stringify(again.pv.rows.find((r) => r.line === line).errors)}`);
  const changed = await check('leases', [head.slice(0, 8), ['C-2024-101', 'Ember Grill', 'G03', 'Active', `${year - 2}-01-01`, 5, '', 1500]]);
  assert.ok(errs(changed.pv, 2).some((k) => /through an amendment/.test(k)));

  // the draft becomes active through an import; an active one ends
  const act = await check('leases', [['Contract number', 'Status', 'Signed on'], [d.ref, 'Active', t]]);
  assert.equal(act.pv.rows[0].status, 'update', JSON.stringify(act.pv.rows[0].errors));
  commit(act.st, act.who);
  assert.equal(db.value('SELECT status FROM leases WHERE id = ?', d.id), 'active');
  assert.equal(db.value("SELECT status FROM units WHERE code = 'S04'"), 'leased');
  assert.ok(db.value("SELECT COUNT(*) FROM invoices WHERE lease_id = ? AND kind = 'rent'", d.id) > 0);
  const bad = await check('leases', [['Contract number', 'Status'], [d.ref, 'Draft']]);
  assert.ok(errs(bad.pv, 2).some((k) => /Draft to Active/.test(k)));

  // undo of the first import: leases, invoices, payments and the books go back; units are free again
  const batch = db.get("SELECT id FROM imp_batches WHERE dataset = 'leases' ORDER BY id LIMIT 1").id;
  const blocked = h.imports.blockers(h.imports.batch(batch));
  assert.ok(blocked.some((x) => /changed again/.test(x.key)), 'the draft was activated since: undo refused');
  // undo the activation first, then the import
  const last = db.get("SELECT id FROM imp_batches WHERE dataset = 'leases' ORDER BY id DESC LIMIT 1").id;
  assert.equal(h.imports.undo(last, me()).ok, true);
  assert.equal(db.value('SELECT status FROM leases WHERE id = ?', d.id), 'draft');
  assert.equal(db.value("SELECT status FROM units WHERE code = 'S04'"), 'available');
  assert.equal(db.value('SELECT COUNT(*) FROM invoices WHERE lease_id = ?', d.id), 0);
  const u = h.imports.undo(batch, me());
  assert.equal(u.ok, true, JSON.stringify(u.blockers));
  assert.equal(db.value("SELECT COUNT(*) FROM leases WHERE ref IN ('C-2024-101','C-2025-102','C-2018-007')"), 0);
  assert.equal(db.value("SELECT status FROM units WHERE code = 'G03'"), 'available');
  assert.equal(db.value("SELECT COUNT(*) FROM payments WHERE note = 'Received before go-live'"), 0);
  // every automatic entry of those invoices is reversed
  assert.equal(db.value("SELECT COUNT(*) FROM acc_entries WHERE source_base = ? AND reversed_by IS NULL AND reverses_id IS NULL", `inv:${dep.id}`), 0);
});

test('import x1: opening balances — open invoices under the old number, posted against Opening balances', async () => {
  const head = ['Invoice number *', 'Lease', 'Tenant (brand)', 'For', 'Period from', 'Period to', 'Due date *', 'Invoice amount *', 'Already paid', 'Note'];
  const rows = [head,
    ['INV-2026-0841', 'LS-2026-001', '', 'Rent', '2026-07-01', '2026-09-30', '01/07/2026', '186,000', '60000', ''],
    ['INV-2026-0790', '', 'Kahwa House', 'Utilities', '', '', '15/08/2026', 'EGP 12,450', '', 'Electricity August'],
    ['IN-2026-9999', '', 'Kahwa House', '', '', '', '15/08/2026', 100, '', ''],
    ['INV-2026-0791', 'LS-2026-001', 'Kahwa House', '', '', '', '15/08/2026', 100, '', ''],
    ['INV-2026-0792', '', 'Kahwa House', '', '', '', '15/08/2026', 100, 100, ''],
    ['INV-2026-0793', '', '', '', '', '', '15/08/2026', 100, '', ''],
  ];
  const { st, pv, who } = await check('opening-balances', rows);
  assert.equal(pv.counts.new, 2, JSON.stringify(pv.rows.filter((r) => r.errors.length).map((r) => [r.line, r.errors])));
  assert.ok(errs(pv, 4).some((k) => /number the office gives/.test(k)));
  assert.ok(errs(pv, 5).some((k) => /not the tenant of that lease/.test(k)));
  assert.ok(errs(pv, 6).some((k) => /Nothing is left to pay/.test(k)));
  assert.ok(errs(pv, 7).some((k) => /Give the lease or the tenant/.test(k)));
  const done = commit(st, who, { mode: 'valid' });
  assert.equal(done.counts.created, 2);
  const inv = db.get("SELECT * FROM invoices WHERE ref = 'INV-2026-0841'");
  assert.equal(inv.source, 'opening');
  assert.equal(inv.status, 'partial');
  assert.equal(inv.total, 186000);
  assert.equal(inv.paid, 60000);
  assert.equal(inv.vat, 0);
  assert.equal(inv.brand_id, db.value("SELECT brand_id FROM leases WHERE ref = 'LS-2026-001'"));
  // the books: receivable 126,000 against Opening balances (3900), no income
  const lines = db.all("SELECT a.key, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id JOIN acc_accounts a ON a.id = l.account_id WHERE e.source_base = ? ORDER BY l.id", `inv:${inv.id}`);
  assert.deepEqual(lines.map((l) => [l.key, l.debit, l.credit]), [['ar', 126000, 0], ['opening_equity', 0, 126000]]);
  const util = db.get("SELECT * FROM invoices WHERE ref = 'INV-2026-0790'");
  assert.equal(util.kind, 'utility');
  assert.equal(util.lease_id, null);
  assert.equal(util.total, 12450);
  // round trip, then a change of amount is refused
  for (const lang of ['en', 'ar']) {
    const buf = Buffer.from(await h.imports.template(h.imports.get('opening-balances'), { lang, withData: true }));
    const up = await admin.upload('opening-balances', buf, 'ob.xlsx');
    const p = h.imports.preview(stage(tokenOf(up.url)), {}, lang, who);
    assert.equal(p.counts.same, 2, `${lang}: ${JSON.stringify(p.rows.map((r) => [r.status, r.errors, r.warns, r.diff]))}`);
    assert.equal(p.counts.warn + p.counts.error + p.counts.new + p.counts.update, 0);
  }
  const ch = await check('opening-balances', [['Invoice number', 'Invoice amount'], ['INV-2026-0841', 200000]]);
  assert.ok(errs(ch.pv, 2).some((k) => /cannot change/.test(k)));
  // a payment later posts as usual, and then the import cannot be undone
  h.billing.recordPayment({ invoice_id: util.id, amount: 2450, date: h.M.today(), method: 'transfer' }, { user: who });
  const b = db.get("SELECT id FROM imp_batches WHERE dataset = 'opening-balances' ORDER BY id DESC LIMIT 1").id;
  assert.ok(h.imports.blockers(h.imports.batch(b)).length, 'paid since: undo refused');
});

test('import x1: cheques — portfolio and at the bank, found by number and bank, only open steps', async () => {
  const head = ['Cheque number *', 'Bank', 'Amount *', 'Due date *', 'Tenant (brand)', 'Lease', 'For invoice', 'Status', 'Received on', 'Deposited on', 'Deposited into'];
  const inv = db.get("SELECT id, ref FROM invoices WHERE ref = 'INV-2026-0841'");
  const rows = [head,
    ['20001', 'QNB', '62,000', '01/01/2027', '', 'LS-2026-001', inv.ref, 'In the portfolio', '20/10/2026', '', ''],
    ['20002', 'QNB', '62,000', '01/04/2027', '', 'LS-2026-001', '', '', '', '', ''],
    ['558120', 'National Bank of Egypt', 31500, '01/11/2026', 'Kahwa House', '', '', 'At the bank', '', '02/11/2026', 'CIB current account'],
    ['20003', 'QNB', 100, '01/01/2027', 'Kahwa House', '', '', 'Collected', '', '', ''],
    ['20004', 'QNB', 100, '01/01/2027', 'Kahwa House', '', '', 'At the bank', '', '', ''],
    ['20005', 'QNB', 100, '01/01/2027', 'Kahwa House', 'LS-2026-001', '', '', '', '', ''],
    ['20001', 'QNB', 100, '01/01/2027', '', 'LS-2026-001', '', '', '', '', ''],
  ];
  const { st, pv, who } = await check('cheques', rows);
  assert.equal(pv.counts.new, 3, JSON.stringify(pv.rows.filter((r) => r.errors.length).map((r) => [r.line, r.errors])));
  assert.ok(errs(pv, 5).some((k) => /Only cheques in the portfolio or at the bank/.test(k)));
  assert.ok(errs(pv, 6).some((k) => /date it was deposited/.test(k)));
  assert.ok(errs(pv, 7).some((k) => /not the tenant of that lease/.test(k)));
  assert.ok(errs(pv, 8).some((k) => /is also on row/.test(k)));
  assert.equal(commit(st, who, { mode: 'valid' }).counts.created, 3);
  const c1 = db.get("SELECT * FROM cheques WHERE number = '20001'");
  assert.equal(c1.status, 'held');
  assert.equal(c1.invoice_id, inv.id);
  assert.equal(c1.received_on, '2026-10-20');
  assert.equal(c1.drawer, 'Maison Lune');
  const c3 = db.get("SELECT * FROM cheques WHERE number = '558120'");
  assert.equal(c3.status, 'deposited');
  assert.equal(c3.deposited_on, '2026-11-02');
  assert.deepEqual(db.all('SELECT status FROM cheque_events WHERE cheque_id = ? ORDER BY id', c3.id).map((e) => e.status), ['held', 'deposited']);
  // to the bank by an import; an amount cannot change; a cheque already there cannot come in again
  const move = await check('cheques', [['Cheque number', 'Bank', 'Status', 'Deposited on', 'Amount'], ['20002', 'QNB', 'At the bank', '05/11/2026', ''], ['20001', 'QNB', '', '', 70000]]);
  assert.equal(move.pv.rows[0].status, 'update', JSON.stringify(move.pv.rows[0].errors));
  assert.ok(errs(move.pv, 3).some((k) => /cannot change by an import/.test(k)));
  commit(move.st, move.who, { mode: 'valid' });
  assert.equal(db.value("SELECT status FROM cheques WHERE number = '20002'"), 'deposited');
  // round trip of the whole portfolio, both languages
  for (const lang of ['en', 'ar']) {
    const buf = Buffer.from(await h.imports.template(h.imports.get('cheques'), { lang, withData: true }));
    const up = await admin.upload('cheques', buf, 'c.xlsx');
    const p = h.imports.preview(stage(tokenOf(up.url)), {}, lang, who);
    assert.equal(p.counts.same, db.value('SELECT COUNT(*) FROM cheques'), `${lang}: ${JSON.stringify(p.rows.filter((r) => r.status !== 'same').map((r) => [r.line, r.errors, r.diff]))}`);
  }
});

test('import x1: tenant sales — by lease and month, locked and future months refused, verified needs a manager', async () => {
  const ym = h.M.today().slice(0, 7);
  const prev = h.M.addMonths(`${ym}-01`, -1).slice(0, 7);
  const prev2 = h.M.addMonths(`${ym}-01`, -2).slice(0, 7);
  const next = h.M.addMonths(`${ym}-01`, 1).slice(0, 7);
  const head = ['Lease *', 'Month *', 'Gross sales *', 'Returns', 'Receipts', 'Status'];
  const lease = db.get("SELECT * FROM leases WHERE status = 'active' AND id NOT IN (SELECT lease_id FROM tenant_sales WHERE period = ?) ORDER BY id LIMIT 1", prev2);
  const rows = [head, [lease.ref, prev2, '1,250,000', 12000, 3150, 'Submitted'], [lease.ref, next, 100, 0, '', ''], [lease.ref, prev2, 100, 0, '', ''], [lease.ref, prev, 100, 200, '', ''], [lease.ref, prev, 1000, 0, '', 'Verified']];
  const ag = await check('tenant-sales', rows, { as: agent });
  assert.equal(ag.pv.rows[0].status, 'new', JSON.stringify(ag.pv.rows[0].errors));
  assert.ok(errs(ag.pv, 3).some((k) => /future month/.test(k)));
  assert.ok(errs(ag.pv, 4).some((k) => /is also on row/.test(k)));
  assert.ok(errs(ag.pv, 5).some((k) => /Returns cannot be more/.test(k)));
  assert.ok(errs(ag.pv, 6).some((k) => /Only a manager/.test(k)));
  assert.equal(commit(ag.st, ag.who, { mode: 'valid' }).counts.created, 1);
  const s = db.get('SELECT * FROM tenant_sales WHERE lease_id = ? AND period = ?', lease.id, prev2);
  assert.equal(s.gross, 1250000);
  assert.equal(s.amount, 1238000);
  assert.equal(s.transactions, 3150);
  assert.equal(s.status, 'submitted');
  // a manager verifies through an import
  const mg = await check('tenant-sales', [head, [lease.ref, prev2, 1250000, 12000, 3150, 'Verified']]);
  assert.equal(mg.pv.rows[0].status, 'update');
  commit(mg.st, mg.who);
  assert.equal(db.value('SELECT status FROM tenant_sales WHERE id = ?', s.id), 'verified');
});

test('import x1: leads, tenant contacts (with portal accounts) and service contracts', async () => {
  // leads: a new brand and contact like the New lead form, a stage moved, a lost one needs its reason
  const lh = ['Lead number', 'Lead (brand or company) *', 'Category', 'Source', 'Stage', 'Why lost', 'Area from (m²)', 'Area to (m²)', 'Unit of interest', 'Owner (email)', 'Contact name', 'Contact email'];
  const lrows = [lh,
    ['', 'Sahara Leather', 'Fashion & accessories', 'Referral', 'Contacted', '', 60, 90, 'G09', 'x1-agent@thewave.test', 'Mariam Tarek', 'mariam@sahara.example'],
    ['', 'Bad Area Co', '', '', '', '', 90, 60, '', '', '', ''],
    ['', 'Lost Co', '', '', 'Lost', '', '', '', '', '', '', ''],
    ['LD-2026-777', 'Ghost', '', '', '', '', '', '', '', '', '', ''],
  ];
  const L1 = await check('leads', lrows, { as: agent });
  assert.equal(L1.pv.rows[0].status, 'new', JSON.stringify(L1.pv.rows[0].errors));
  assert.ok(errs(L1.pv, 3).some((k) => /smaller than the smallest/.test(k)));
  assert.ok(errs(L1.pv, 4).some((k) => /why the lead was lost/.test(k)));
  assert.ok(errs(L1.pv, 5).some((k) => /number the office gives/.test(k)));
  commit(L1.st, L1.who, { mode: 'valid' });
  const lead = db.get("SELECT * FROM leads WHERE title = 'Sahara Leather'");
  assert.equal(lead.stage, 'contacted');
  assert.equal(lead.category, 'fashion');
  assert.equal(lead.unit_id, db.value("SELECT id FROM units WHERE code = 'G09'"));
  assert.ok(db.value("SELECT COUNT(*) FROM activities WHERE lead_id = ? AND subject = 'Moved to Contacted'", lead.id));
  const brandId = db.value("SELECT id FROM brands WHERE name = 'Sahara Leather'");
  assert.ok(brandId && db.value("SELECT COUNT(*) FROM contacts WHERE brand_id = ? AND email = 'mariam@sahara.example'", brandId));
  // undo removes the lead, its contact and the brand it created
  const lb = db.get("SELECT id FROM imp_batches WHERE dataset = 'leads' ORDER BY id DESC LIMIT 1").id;
  assert.equal(h.imports.undo(lb, me()).ok, true);
  assert.equal(db.value("SELECT COUNT(*) FROM brands WHERE name = 'Sahara Leather'"), 0);

  // tenant contacts: a portal account opened without a password and no email; an email of another brand's account refused
  const portalOther = db.get('SELECT p.email, b.name FROM portal_users p JOIN brands b ON b.id = p.brand_id ORDER BY p.id LIMIT 1');
  const ch = ['Brand *', 'Name *', 'Job title', 'Email', 'Mobile', 'Main contact', 'Portal account'];
  const crow = [ch,
    ['Nile Optics', 'Rana Fouad', 'Accounts', 'rana@nileoptics.example', '+20 100 123 4567', 'No', 'Yes'],
    ['Nile Optics', 'No Mail', '', '', '', '', 'Yes'],
    ['Azure Swim', 'Someone', '', portalOther ? portalOther.email : 'x@y.z', '', '', 'Yes'],
  ];
  const C1 = await check('tenant-contacts', crow, { as: agent });
  assert.equal(C1.pv.rows[0].status, 'new', JSON.stringify(C1.pv.rows[0].errors));
  assert.ok(errs(C1.pv, 3).some((k) => /needs the person’s email/.test(k)));
  if (portalOther && portalOther.name !== 'Azure Swim') assert.ok(errs(C1.pv, 4).some((k) => /another brand/.test(k)));
  commit(C1.st, C1.who, { mode: 'valid' });
  const c = db.get("SELECT * FROM contacts WHERE email = 'rana@nileoptics.example'");
  assert.equal(c.phone, '01001234567');
  const pu = db.get("SELECT * FROM portal_users WHERE email = 'rana@nileoptics.example'");
  assert.ok(pu && !pu.password_hash, 'an account without a password');
  const cb = db.get("SELECT id FROM imp_batches WHERE dataset = 'tenant-contacts' ORDER BY id DESC LIMIT 1").id;
  assert.equal(h.imports.undo(cb, me()).ok, true);
  assert.equal(db.value("SELECT COUNT(*) FROM portal_users WHERE email = 'rana@nileoptics.example'"), 0);

  // service contracts
  const sh = ['Contract number', 'Contract *', 'Supplier *', 'Type', 'Status', 'Start date *', 'End date', 'Notice (days)', 'Renews by itself', 'Value', 'Value is', 'Managed by (email)'];
  const S1 = await check('service-contracts', [sh,
    ['', 'Security guarding 2027', 'Falcon Security', 'Security', 'Active', '01/01/2027', '31/12/2027', 60, 'No', '185,000', 'Monthly', 'x1-admin@thewave.test'],
    ['SC-2026-777', 'Ghost', 'Nobody', '', '', '01/01/2027', '', '', '', '', '', ''],
    ['', 'Backwards', 'Someone', '', '', '01/01/2027', '01/01/2026', '', '', '', '', ''],
  ]);
  assert.equal(S1.pv.rows[0].status, 'new', JSON.stringify(S1.pv.rows[0].errors));
  assert.ok(errs(S1.pv, 3).some((k) => /number the office gives/.test(k)));
  assert.ok(errs(S1.pv, 4).some((k) => /end is before the start/.test(k)));
  commit(S1.st, S1.who, { mode: 'valid' });
  const sc = db.get("SELECT * FROM contracts WHERE title = 'Security guarding 2027'");
  assert.equal(sc.kind, 'security');
  assert.equal(sc.value, 185000);
  assert.equal(sc.owner_id, me().id);
  assert.match(sc.ref, /^SC-\d{4}-\d{3}$/);
});

test('import x1: round trips of the sample data change nothing, in English and in Arabic; pages in Arabic', async () => {
  const who = me();
  for (const lang of ['en', 'ar']) {
    for (const key of KEYS) {
      const d = h.imports.get(key);
      if (!(d.count ? d.count(db) : db.value(`SELECT COUNT(*) FROM ${d.table}`))) continue;
      const buf = Buffer.from(await h.imports.template(d, { lang, withData: true }));
      const up = await admin.upload(key, buf, `${key}.xlsx`);
      assert.equal(up.ok, true, `${key}: ${up.error}`);
      const st = stage(tokenOf(up.url));
      const m = h.imports.mapColumns(st.d, h.imports.grid(st).headers);
      assert.equal(m.needsConfirm, false, `${key} ${lang}: our own titles are recognised`);
      const pv = h.imports.preview(st, {}, lang, who);
      const odd = pv.rows.filter((r) => r.status !== 'same' || r.warns.length);
      assert.equal(odd.length, 0, `${key} ${lang}: ${JSON.stringify(odd.slice(0, 3).map((r) => [r.line, r.status, r.errors, r.warns, r.diff]))}`);
    }
  }
  for (const key of KEYS) {
    for (const p of [`/admin/import/${key}`, `/admin/import/${key}/template.xlsx?as=ar`]) assert.equal((await admin.go(`${p}${p.includes('?') ? '&' : '?'}lang=ar`)).status, 200, p);
  }
  await admin.go('/admin?lang=en');
  // the Import from Excel button on the lists
  for (const p of ['/admin/leases', '/admin/billing', '/admin/cheques', '/admin/leads', '/admin/contracts', '/admin/turnover/sales', '/admin/tenants']) {
    assert.match(await (await admin.go(p)).text(), /imp-pagebtn/, p);
  }
});
