'use strict';

// Approvals and purchasing: approval rules per kind (amount, one or two steps, who decides), the
// h.approvals contract other modules use, salary advances waiting for approval, and the purchasing
// cycle — request, approval, order, partial deliveries, supplier bill with a three-way match — plus
// the store: stock in and out, issues to work orders and departments in the books, low stock raising
// a request, the printable order in both languages, and the sample data.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let db;
let h;
let M;
let admin;
let manager;
let clerk;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  M = h.M;
  base = `http://127.0.0.1:${server.address().port}`;
  const user = (name, email, role, extra = '') => db.run(`INSERT INTO users (name, email, role, password_hash, finance, hr, created_at) VALUES (?, ?, ?, ?, ${extra.includes('finance') ? 1 : 0}, ${extra.includes('hr') ? 1 : 0}, datetime('now'))`, name, email, role, hashPassword('long-enough-1'));
  user('Purchasing Admin', 'pur-admin@thewave.test', 'admin', 'finance hr');
  user('Store Manager', 'pur-manager@thewave.test', 'manager', 'hr');
  user('Front Clerk', 'pur-clerk@thewave.test', 'agent');
  db.run("INSERT OR IGNORE INTO departments (name, sort) VALUES ('Facilities & maintenance', 1)");
  admin = browser();
  manager = browser();
  clerk = browser();
  await admin.signIn('pur-admin@thewave.test', 'long-enough-1');
  await manager.signIn('pur-manager@thewave.test', 'long-enough-1');
  await clerk.signIn('pur-clerk@thewave.test', 'long-enough-1');
  for (const [b, e] of [[admin, 'pur-admin'], [manager, 'pur-manager'], [clerk, 'pur-clerk']]) b.user = db.get('SELECT * FROM users WHERE email = ?', `${e}@thewave.test`);
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
    async page(p) {
      const r = await go(p);
      return { status: r.status, html: await r.text() };
    },
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
const rules = (over = {}) => {
  const data = {};
  for (const k of ['writeoff', 'refund', 'purchase', 'advance', 'media_discount', 'other']) Object.assign(data, { [`${k}_min`]: '0', [`${k}_who1`]: 'manager', [`${k}_who2`]: '' });
  return { ...data, ...over };
};

test('approval rules: set by a manager, not by an agent; needs() follows the amount', async () => {
  assert.equal(h.approvals.needs('purchase', 1e9), false, 'no rule: no approval');
  const denied = await clerk.form('/admin/approvals/rules', rules({ purchase_active: '1' }));
  assert.equal(denied.status, 303);
  assert.equal(h.approvals.ruleOf('purchase'), null, 'an agent cannot set the rules');
  const r = await manager.form('/admin/approvals/rules', rules({ purchase_active: '1', purchase_min: '5000', purchase_who1: 'manager', purchase_who2: 'finance', other_active: '1', other_min: '100' }));
  assert.equal(r.status, 303);
  assert.equal(h.approvals.needs('purchase', 4999.99), false);
  assert.equal(h.approvals.needs('purchase', 5000), true, 'from the amount, inclusive');
  assert.deepEqual(h.approvals.ruleOf('purchase').steps, [{ who: 'manager' }, { who: 'finance' }]);
  assert.equal(h.approvals.needs('refund', 1e6), false, 'a kind switched off goes ahead');
  const page = await manager.page('/admin/approvals/rules');
  assert.equal(page.status, 200);
  assert.match(page.html, /name="purchase_active" value="1" checked/);
});

test('the contract: request, two steps, onDecision once on the final decision, pendingFor, withdraw', async () => {
  const calls = [];
  h.approvals.onDecision('other', (r, decision, user) => calls.push([r.id, decision, user && user.id, r.payload]));
  const withdrawn = [];
  h.approvals.onWithdraw('other', (r) => withdrawn.push(r.id));
  await manager.form('/admin/approvals/rules', rules({ purchase_active: '1', purchase_min: '5000', purchase_who1: 'manager', purchase_who2: 'finance', other_active: '1', other_min: '100', other_who1: 'manager', other_who2: `user:${admin.user.id}` }));
  const before = db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'approval'");
  const r = h.approvals.request({ kind: 'other', title: 'New chairs', amount: 2500, entity: 'thing', entity_id: 7, link: '/admin/approvals', payload: { a: 1, list: [2, 3] }, user: clerk.user });
  assert.equal(r.status, 'pending');
  assert.equal(r.step, 0);
  assert.deepEqual(r.payload, { a: 1, list: [2, 3] }, 'the payload comes back parsed');
  assert.equal(h.approvals.pendingFor('thing', 7).id, r.id);
  assert.ok(db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'approval'") > before, 'the approvers were emailed');
  // the badge: the manager has it to decide, the clerk (who asked) does not
  const counts = (b) => b.page('/admin/approvals?tab=todo').then((p) => p.html);
  assert.match(await counts(manager), /New chairs/);
  assert.doesNotMatch(await counts(clerk), /<b>New chairs<\/b>/);
  // the requester cannot decide their own request
  let res = await clerk.form(`/admin/approvals/${r.id}/decide`, { decision: 'approved' });
  assert.equal(res.status, 303);
  assert.equal(h.approvals.requestOf(r.id).step, 0);
  // rejecting needs a reason
  res = await manager.form(`/admin/approvals/${r.id}/decide`, { decision: 'rejected', note: '' });
  assert.equal(h.approvals.requestOf(r.id).status, 'pending');
  // step 1 by the manager: no final decision yet
  res = await manager.form(`/admin/approvals/${r.id}/decide`, { decision: 'approved', note: 'fine' });
  assert.equal(res.status, 303);
  assert.equal(h.approvals.requestOf(r.id).step, 1);
  assert.equal(calls.length, 0, 'not called on an intermediate step');
  // the same manager cannot take the second step
  assert.equal(h.approvals.canDecide(manager.user, h.approvals.requestOf(r.id)), false);
  // step 2 is the named person
  await admin.form(`/admin/approvals/${r.id}/comment`, { note: 'Looks right' });
  res = await admin.form(`/admin/approvals/${r.id}/decide`, { decision: 'approved' });
  const done = h.approvals.requestOf(r.id);
  assert.equal(done.status, 'approved');
  assert.deepEqual(calls, [[r.id, 'approved', admin.user.id, { a: 1, list: [2, 3] }]]);
  assert.equal(h.approvals.pendingFor('thing', 7), null);
  const events = db.all('SELECT action FROM apr_events WHERE request_id = ? ORDER BY id', r.id).map((e) => e.action);
  assert.deepEqual(events, ['submitted', 'approved', 'comment', 'approved']);
  const page = await clerk.page(`/admin/approvals/${r.id}`);
  assert.equal(page.status, 200);
  assert.match(page.html, /Looks right/);
  // a handler that throws undoes the decision
  h.approvals.onDecision('refund', () => { throw new Error('apr|There is no such request.'); });
  const bad = h.approvals.request({ kind: 'refund', title: 'Refund', amount: 10, user: clerk.user });
  assert.throws(() => h.approvals.decide(bad.id, admin.user, 'approved'));
  assert.equal(h.approvals.requestOf(bad.id).status, 'pending', 'rolled back');
  // rejected: called with 'rejected'; withdrawn: only the requester (or an administrator)
  const r2 = h.approvals.request({ kind: 'other', title: 'Second', amount: 500, user: clerk.user });
  h.approvals.decide(r2.id, manager.user, 'rejected', 'No budget');
  assert.equal(calls.at(-1)[1], 'rejected');
  const r3 = h.approvals.request({ kind: 'other', title: 'Third', amount: 500, user: clerk.user });
  assert.throws(() => h.approvals.withdraw(r3.id, manager.user));
  res = await clerk.form(`/admin/approvals/${r3.id}/withdraw`, { note: 'Not needed' });
  assert.equal(h.approvals.requestOf(r3.id).status, 'withdrawn');
  assert.deepEqual(withdrawn, [r3.id]);
  // a request of another kind from the page
  res = await clerk.form('/admin/approvals/new', { title: 'Paint the loading bay', amount: '7500', note: 'Peeling' });
  assert.equal(res.status, 303);
  const mine = await clerk.page('/admin/approvals?tab=mine');
  assert.match(mine.html, /Paint the loading bay/);
});

test('salary advances above the rule amount wait for approval, then are given as before', async () => {
  await manager.form('/admin/approvals/rules', rules({ advance_active: '1', advance_min: '10000', advance_who1: 'manager', purchase_active: '1', purchase_min: '5000', purchase_who1: 'manager', purchase_who2: 'finance' }));
  const emp = Number(db.run("INSERT INTO employees (code, name, status, basic_salary, hire_date, created_at, updated_at) VALUES ('E-APR-1', 'Hany Saad', 'active', 12000, '2024-01-01', datetime('now'), datetime('now'))").lastInsertRowid);
  const before = db.value('SELECT COUNT(*) FROM hr_advances');
  // below the amount: given at once
  let res = await admin.form('/admin/hr/advances', { employee_id: String(emp), amount: '3000', installments: '3', start_period: M.today().slice(0, 7), issued_on: M.today(), method: 'cash' });
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM hr_advances'), before + 1);
  // above: a request, no advance yet
  res = await admin.form('/admin/hr/advances', { employee_id: String(emp), amount: '15000', installments: '5', start_period: M.today().slice(0, 7), issued_on: M.today(), method: 'transfer', reason: 'Wedding' });
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM hr_advances'), before + 1);
  const r = db.get("SELECT * FROM apr_requests WHERE kind = 'advance' ORDER BY id DESC LIMIT 1");
  assert.equal(r.status, 'pending');
  assert.equal(r.amount, 15000);
  const list = await admin.page('/admin/hr/advances');
  assert.match(list.html, /Waiting for approval/);
  assert.match(list.html, /Hany Saad/);
  // the manager approves: the advance exists with the same effects (the books, the request linked to it)
  res = await manager.form(`/admin/approvals/${r.id}/decide`, { decision: 'approved' });
  assert.equal(res.status, 303);
  const a = db.get('SELECT * FROM hr_advances ORDER BY id DESC LIMIT 1');
  assert.equal(a.amount, 15000);
  assert.equal(a.installments, 5);
  assert.equal(a.monthly, 3000);
  assert.equal(a.method, 'transfer');
  assert.equal(a.created_by, admin.user.id, 'given in the name of who asked');
  assert.ok(db.get("SELECT id FROM acc_entries WHERE source_base = ? AND reversed_by IS NULL", `advance:${a.id}`), 'posted in the books');
  const after = db.get('SELECT * FROM apr_requests WHERE id = ?', r.id);
  assert.equal(after.status, 'approved');
  assert.equal(after.link, `/admin/hr/advances/${a.id}`);
});

let item;
let order;
test('purchasing: request → two-step approval → order → partial deliveries → bill with a three-way match', async () => {
  // a stock item with opening stock
  let res = await manager.form('/admin/purchasing/stock', { code: 'el-9001', name: 'Test lamp', name_ar: 'مصباح', category: 'electrical', unit: 'pcs', min_qty: '10', reorder_qty: '30', location: 'B1', opening_qty: '5', opening_cost: '100' });
  assert.equal(res.status, 303);
  item = db.get("SELECT * FROM inv_items WHERE code = 'EL-9001'");
  assert.equal(item.on_hand, 5);
  assert.equal(item.avg_cost, 100);
  // the clerk asks for 20 lamps and a service (over the 5,000 rule)
  const dept = db.get('SELECT id FROM departments ORDER BY id LIMIT 1');
  res = await clerk.form('/admin/purchasing/requests', {
    title: 'Lamps for the plaza', department_id: dept ? String(dept.id) : '', needed_by: M.addDays(M.today(), 10), reason: 'Replacement',
    item_0: String(item.id), desc_0: '', qty_0: '20', unit_0: 'pcs', price_0: '120',
    item_1: '', desc_1: 'Installation labour', qty_1: '1', unit_1: 'set', price_1: '3000',
    item_2: '', desc_2: '', qty_2: '', unit_2: 'pcs', price_2: '',
  });
  assert.equal(res.status, 303);
  const pr = db.get('SELECT * FROM pur_requests ORDER BY id DESC LIMIT 1');
  assert.equal(pr.status, 'pending');
  assert.equal(pr.est_total, 5400);
  assert.equal(db.value('SELECT COUNT(*) FROM pur_request_lines WHERE request_id = ?', pr.id), 2, 'blank lines are ignored');
  assert.equal(db.value('SELECT description FROM pur_request_lines WHERE request_id = ? AND item_id = ?', pr.id, item.id), 'Test lamp', 'a stock line takes the item name');
  // cannot be ordered before approval
  res = await manager.form('/admin/purchasing/orders', { request_id: String(pr.id), vendor_new: 'Lamp Co', order_date: M.today(), item_0: String(item.id), desc_0: 'Test lamp', qty_0: '20', unit_0: 'pcs', price_0: '120', send: '1' });
  assert.equal(db.value('SELECT COUNT(*) FROM pur_orders'), 0);
  h.approvals.decide(pr.approval_id, manager.user, 'approved');
  assert.equal(db.value('SELECT status FROM pur_requests WHERE id = ?', pr.id), 'pending', 'one step of two');
  h.approvals.decide(pr.approval_id, admin.user, 'approved');
  assert.equal(db.value('SELECT status FROM pur_requests WHERE id = ?', pr.id), 'approved');
  // the order, sent
  res = await manager.form('/admin/purchasing/orders', {
    request_id: String(pr.id), vendor_id: '', vendor_new: 'Lamp Co', order_date: M.addDays(M.today(), -20), delivery_date: M.addDays(M.today(), -3), payment_days: '30', vat_pct: '14', terms: 'Net 30',
    item_0: String(item.id), desc_0: 'Test lamp', qty_0: '20', unit_0: 'pcs', price_0: '120', account_0: 'exp_maintenance',
    item_1: '', desc_1: 'Installation labour', qty_1: '1', unit_1: 'set', price_1: '3000', account_1: 'exp_maintenance', send: '1',
  });
  assert.equal(res.status, 303);
  order = db.get('SELECT * FROM pur_orders ORDER BY id DESC LIMIT 1');
  assert.equal(order.status, 'sent');
  assert.equal(order.net, 5400);
  assert.equal(order.vat, 756);
  assert.equal(order.total, 6156);
  assert.equal(db.value('SELECT status FROM pur_requests WHERE id = ?', pr.id), 'ordered');
  const lines = db.all('SELECT * FROM pur_order_lines WHERE order_id = ? ORDER BY sort', order.id);
  // late and open
  let ov = await manager.page('/admin/purchasing');
  assert.match(ov.html, new RegExp(order.ref));
  // a partial delivery: 12 lamps in at 120 → average cost (5×100 + 12×120) / 17
  res = await manager.form(`/admin/purchasing/orders/${order.id}/receive`, { date: M.today(), delivery_note: 'DN-1', [`qty_${lines[0].id}`]: '12', [`qty_${lines[1].id}`]: '0' });
  assert.equal(res.status, 303);
  item = db.get('SELECT * FROM inv_items WHERE id = ?', item.id);
  assert.equal(item.on_hand, 17);
  assert.ok(Math.abs(item.avg_cost - (5 * 100 + 12 * 120) / 17) < 0.001);
  assert.equal(db.value('SELECT status FROM pur_orders WHERE id = ?', order.id), 'partial');
  // the bill: 12 billed at 125 (a different price) → flagged, a draft bill in accounting
  res = await admin.form(`/admin/purchasing/orders/${order.id}/bill`, { vendor_ref: 'INV-77', date: M.today(), [`qty_${lines[0].id}`]: '12', [`price_${lines[0].id}`]: '125', vat: '' });
  assert.equal(res.status, 303);
  const pb = db.get('SELECT * FROM pur_bills WHERE order_id = ?', order.id);
  const bill = db.get('SELECT * FROM acc_bills WHERE id = ?', pb.bill_id);
  assert.equal(bill.source, 'purchase');
  assert.equal(bill.status, 'draft');
  assert.equal(bill.net, 1500);
  assert.equal(bill.vat, 210);
  assert.ok(JSON.parse(pb.flags).some((f) => f.flag === 'price'));
  const inv = db.value("SELECT account_id FROM acc_bill_lines WHERE bill_id = ?", bill.id);
  assert.equal(db.value('SELECT key FROM acc_accounts WHERE id = ?', inv), 'inventory', 'stock is billed to the inventory account');
  let state = h.purchasing.lineState(order.id);
  assert.deepEqual(state[0].flags, ['price']);
  // billing more than received is flagged too
  const out = h.purchasing.billOrder(order.id, { vendor_ref: 'INV-78', lines: [{ order_line_id: lines[1].id, qty: 1, price: 3000 }], user: admin.user });
  assert.ok(out.flags.some((f) => f.flag === 'over_billed'));
  const page = await admin.page(`/admin/purchasing/orders/${order.id}`);
  assert.match(page.html, /Billed at a different price/);
  assert.match(page.html, /Billed more than received/);
  // the rest arrives; everything billed → the order closes, and its request
  h.purchasing.receive(order.id, { lines: { [lines[0].id]: 8, [lines[1].id]: 1 }, user: manager.user });
  assert.equal(db.value('SELECT status FROM pur_orders WHERE id = ?', order.id), 'received');
  h.purchasing.billOrder(order.id, { vendor_ref: 'INV-79', lines: [{ order_line_id: lines[0].id, qty: 8, price: 120 }], user: admin.user });
  assert.equal(db.value('SELECT status FROM pur_orders WHERE id = ?', order.id), 'closed');
  assert.equal(db.value('SELECT status FROM pur_requests WHERE id = ?', pr.id), 'closed');
  state = h.purchasing.lineState(order.id);
  assert.equal(state[0].received, 20);
  assert.equal(state[0].billed, 20);
  // the bill is paid from accounting like any other
  h.ledger.approveBill(bill.id, { user: admin.user });
  h.ledger.payBill(bill.id, { amount: 1710, account: 'bank_clearing', user: admin.user });
  assert.equal(db.value('SELECT status FROM acc_bills WHERE id = ?', bill.id), 'paid');
});

test('the store: issue to a work order or a department (in the books), adjust, low stock raises one request', async () => {
  const wo = Number(db.run("INSERT INTO work_orders (ref, title, category, status, created_at, updated_at) VALUES ('WO-T-1', 'Replace lamps', 'electrical', 'in_progress', datetime('now'), datetime('now'))").lastInsertRowid);
  item = db.get('SELECT * FROM inv_items WHERE id = ?', item.id);
  const avg = item.avg_cost;
  let res = await manager.form(`/admin/purchasing/stock/${item.id}/issue`, { qty: '4', work_order_id: String(wo), date: M.today() });
  assert.equal(res.status, 303);
  const m = db.get("SELECT * FROM inv_moves WHERE kind = 'issue' ORDER BY id DESC LIMIT 1");
  assert.equal(m.qty, -4);
  assert.equal(m.work_order_id, wo);
  assert.ok(Math.abs(m.value + 4 * avg) < 0.01);
  const entry = db.get("SELECT * FROM acc_entries WHERE source_base = ? AND reversed_by IS NULL", `stock:${m.id}`);
  assert.ok(entry, 'the issue is in the books');
  const dr = db.get("SELECT a.key FROM acc_lines l JOIN acc_accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND l.debit > 0", entry.id);
  assert.equal(dr.key, 'exp_maintenance');
  assert.equal(h.purchasing.issuesFor(wo).length, 1);
  // more than on hand is refused; a department needs no work order
  item = db.get('SELECT * FROM inv_items WHERE id = ?', item.id);
  res = await manager.form(`/admin/purchasing/stock/${item.id}/issue`, { qty: String(item.on_hand + 1), work_order_id: String(wo) });
  assert.equal(db.get('SELECT on_hand FROM inv_items WHERE id = ?', item.id).on_hand, item.on_hand);
  res = await manager.form(`/admin/purchasing/stock/${item.id}/issue`, { qty: '1', department_id: String(db.get('SELECT id FROM departments ORDER BY id LIMIT 1').id) });
  assert.equal(db.get('SELECT on_hand FROM inv_items WHERE id = ?', item.id).on_hand, item.on_hand - 1);
  // the clerk cannot issue
  res = await clerk.form(`/admin/purchasing/stock/${item.id}/issue`, { qty: '1', work_order_id: String(wo) });
  assert.equal(db.get('SELECT on_hand FROM inv_items WHERE id = ?', item.id).on_hand, item.on_hand - 1);
  // adjust: a reason is required
  res = await manager.form(`/admin/purchasing/stock/${item.id}/adjust`, { qty: '-2', reason: '', note: '' });
  assert.equal(db.get('SELECT on_hand FROM inv_items WHERE id = ?', item.id).on_hand, item.on_hand - 1);
  res = await manager.form(`/admin/purchasing/stock/${item.id}/adjust`, { qty: '-2', reason: 'Damaged', note: 'dropped' });
  item = db.get('SELECT * FROM inv_items WHERE id = ?', item.id);
  assert.equal(db.get("SELECT reason FROM inv_moves WHERE kind = 'adjust' ORDER BY id DESC LIMIT 1").reason, 'Damaged · dropped');
  // run it low: one click raises one request (and not twice)
  h.purchasing.issue({ item_id: item.id, qty: item.on_hand - 3, department_id: db.get('SELECT id FROM departments ORDER BY id LIMIT 1').id, user: manager.user });
  assert.ok(h.purchasing.lowItems().some((i) => i.id === item.id));
  const before = db.value('SELECT COUNT(*) FROM pur_requests');
  res = await clerk.form('/admin/purchasing/stock/reorder', {});
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM pur_requests'), before + 1);
  const pr = db.get('SELECT * FROM pur_requests ORDER BY id DESC LIMIT 1');
  assert.equal(pr.source, 'reorder');
  assert.equal(db.get('SELECT qty FROM pur_request_lines WHERE request_id = ? AND item_id = ?', pr.id, item.id).qty, 30, 'the reorder quantity');
  await clerk.form('/admin/purchasing/stock/reorder', {});
  assert.equal(db.value('SELECT COUNT(*) FROM pur_requests'), before + 1, 'already requested: not twice');
  // valuation: the store at average cost; the badge counts what needs doing
  const val = await manager.page('/admin/purchasing/stock/valuation');
  assert.equal(val.status, 200);
  assert.match(val.html, /EL-9001/);
});

test('pages in English and Arabic, the printable order in both languages, access', async () => {
  const urls = ['/admin/approvals', '/admin/approvals?tab=all&status=any', '/admin/approvals/rules', '/admin/approvals/new', '/admin/purchasing', '/admin/purchasing/requests', '/admin/purchasing/requests/new',
    `/admin/purchasing/requests/${db.value('SELECT MIN(id) FROM pur_requests')}`, '/admin/purchasing/orders', '/admin/purchasing/orders/new', `/admin/purchasing/orders/${order.id}`, '/admin/purchasing/receipts',
    `/admin/purchasing/receipts/${db.value('SELECT MIN(id) FROM pur_receipts')}`, '/admin/purchasing/stock', `/admin/purchasing/stock/${item.id}`, '/admin/purchasing/stock/valuation', '/admin/purchasing/stock/movements?kind=issue', '/admin/hr/advances'];
  for (const u of urls) assert.equal((await admin.page(u)).status, 200, u);
  const print = await admin.page(`/admin/purchasing/orders/${order.id}/print`);
  assert.equal(print.status, 200);
  assert.match(print.html, /Purchase order/);
  assert.match(print.html, /أمر شراء/);
  await admin.form('/admin/lang', { lang: 'ar', back: '/admin' });
  for (const u of urls) {
    const p = await admin.page(u);
    assert.equal(p.status, 200, u);
    assert.match(p.html, /dir="rtl"/);
  }
  assert.match((await admin.page('/admin/purchasing')).html, /المشتريات/);
  assert.match((await admin.page('/admin/approvals')).html, /الموافقات/);
  await admin.form('/admin/lang', { lang: 'en', back: '/admin' });
  // the clerk sees requests but not orders, the store's forms, or the rules
  assert.equal((await clerk.page('/admin/purchasing/orders')).status, 303);
  assert.equal((await clerk.page(`/admin/purchasing/orders/${order.id}`)).status, 303);
  assert.equal((await clerk.page('/admin/approvals/rules')).status, 303);
  assert.equal((await clerk.page('/admin/purchasing/requests')).status, 200);
  assert.doesNotMatch((await clerk.page(`/admin/purchasing/stock/${item.id}`)).html, /Issue from the store/);
});

test('sample data loads (requests in every state, orders, deliveries, bills, low stock) and clears', async () => {
  const res = await admin.form('/admin/settings/demo', {});
  assert.equal(res.status, 303);
  const n = (sql) => db.value(sql);
  assert.ok(n('SELECT COUNT(*) FROM inv_items WHERE demo = 1') >= 12);
  assert.ok(n("SELECT COUNT(*) FROM inv_items WHERE demo = 1 AND min_qty > 0 AND on_hand <= min_qty") >= 2, 'some items run low');
  for (const s of ['pending', 'rejected', 'withdrawn', 'closed']) assert.ok(n(`SELECT COUNT(*) FROM pur_requests WHERE demo = 1 AND status = '${s}'`) >= 1, `a request ${s}`);
  for (const s of ['partial', 'received', 'sent', 'draft']) assert.ok(n(`SELECT COUNT(*) FROM pur_orders WHERE demo = 1 AND status IN ('${s}', ${s === 'received' ? "'closed'" : "''"})`) >= 1, `an order ${s}`);
  assert.ok(n("SELECT COUNT(*) FROM acc_bills WHERE source = 'purchase' AND demo = 1") >= 3);
  assert.ok(n("SELECT COUNT(*) FROM apr_requests WHERE demo = 1 AND kind = 'advance' AND status = 'pending'") === 1);
  assert.ok(n("SELECT COUNT(*) FROM inv_moves WHERE demo = 1 AND kind = 'issue' AND work_order_id IS NOT NULL") >= 3);
  // stock issued is in the books once a purchasing or accounting page is opened
  assert.equal((await admin.page('/admin/purchasing')).status, 200);
  assert.equal(n(`SELECT COUNT(*) FROM inv_moves m WHERE m.kind != 'receive' AND ABS(m.value) >= 0.005 AND NOT EXISTS (SELECT 1 FROM acc_entries e WHERE e.source_base = 'stock:' || m.id AND e.reversed_by IS NULL AND e.reverses_id IS NULL)`), 0);
  for (const u of ['/admin/approvals?tab=all', '/admin/purchasing/orders', '/admin/purchasing/stock', `/admin/purchasing/orders/${n('SELECT MIN(id) FROM pur_orders WHERE demo = 1')}/print`]) assert.equal((await admin.page(u)).status, 200, u);
  // loading twice changes nothing
  const items = n('SELECT COUNT(*) FROM inv_items');
  require('../src/admin/demo-purchasing').load(db, admin.user, { h });
  assert.equal(n('SELECT COUNT(*) FROM inv_items'), items);
  const clear = await admin.form('/admin/settings/demo/clear', {});
  assert.equal(clear.status, 303);
  for (const t of ['inv_items', 'inv_moves', 'pur_requests', 'pur_orders', 'pur_receipts', 'apr_requests', 'apr_rules']) assert.equal(n(`SELECT COUNT(*) FROM ${t} WHERE demo = 1`), 0, t);
  assert.ok(n("SELECT COUNT(*) FROM inv_items WHERE code = 'EL-9001'") === 1, 'real records stay');
  assert.ok(h.approvals.ruleOf('purchase'), 'rules set by a person stay');
});
