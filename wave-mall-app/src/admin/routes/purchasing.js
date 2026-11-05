'use strict';

// Purchasing and spare parts (/admin/purchasing): from a need to a paid supplier bill, and the
// store of parts and supplies the maintenance team uses.
//
//   purchase request (department, lines, needed by, reason)
//     → approval (routes/approvals.js, kind 'purchase', when the rules ask for it)
//     → purchase order to a supplier (number, terms, delivery date; printable in both languages)
//     → goods received notes (partial deliveries allowed; stock items go into the store)
//     → supplier bill in accounting (h.ledger.createBill) with a three-way match:
//       ordered vs received vs billed, quantity and price; differences are flagged
//     → paid from accounting like any other bill.
//
// The store: items (code, unit, category, minimum level, location, average cost), movements
// (received from a delivery, issued to a work order or a department, adjusted with a reason, opening
// stock), what is on hand, what is running low (one click raises a purchase request), and what the
// stock is worth. In the books: stock bought is billed to the inventory account; parts issued are
// an expense (maintenance, cleaning or security); adjustments go to other expenses.
//
// For other modules: h.purchasing.issuesFor(workOrderId) → the parts issued to a work order, and
// h.purchasing.partsCard(req, workOrder) → a card for the work order's page (with an "Issue parts" link).

const i18n = require('../i18n');

const { t: tr, tn, tx, isAr } = i18n;

const SCHEMA = `
  CREATE TABLE pur_requests (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL, department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    needed_by TEXT, reason TEXT, source TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'pending', est_total REAL NOT NULL DEFAULT 0,
    approval_id INTEGER, requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX pur_requests_status ON pur_requests(status);
  CREATE TABLE pur_request_lines (
    id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES pur_requests(id) ON DELETE CASCADE, item_id INTEGER,
    description TEXT NOT NULL, qty REAL NOT NULL DEFAULT 1, unit TEXT, est_price REAL NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE pur_orders (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, request_id INTEGER REFERENCES pur_requests(id) ON DELETE SET NULL, vendor_id INTEGER NOT NULL,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'draft', order_date TEXT NOT NULL,
    delivery_date TEXT, terms TEXT, payment_days INTEGER, deliver_to TEXT, vat_pct REAL NOT NULL DEFAULT 14, net REAL NOT NULL DEFAULT 0,
    vat REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, notes TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sent_at TEXT, closed_at TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX pur_orders_status ON pur_orders(status, delivery_date);
  CREATE INDEX pur_orders_vendor ON pur_orders(vendor_id);
  CREATE TABLE pur_order_lines (
    id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES pur_orders(id) ON DELETE CASCADE, item_id INTEGER,
    description TEXT NOT NULL, qty REAL NOT NULL, unit TEXT, price REAL NOT NULL DEFAULT 0, account TEXT, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE pur_receipts (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, order_id INTEGER NOT NULL REFERENCES pur_orders(id) ON DELETE CASCADE, date TEXT NOT NULL,
    delivery_note TEXT, note TEXT, received_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE pur_receipt_lines (
    id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL REFERENCES pur_receipts(id) ON DELETE CASCADE,
    order_line_id INTEGER NOT NULL REFERENCES pur_order_lines(id) ON DELETE CASCADE, qty REAL NOT NULL
  );
  CREATE TABLE pur_bills (
    id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES pur_orders(id) ON DELETE CASCADE, bill_id INTEGER, vendor_ref TEXT, date TEXT NOT NULL,
    net REAL NOT NULL DEFAULT 0, vat REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, flags TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE pur_bill_lines (
    id INTEGER PRIMARY KEY, pur_bill_id INTEGER NOT NULL REFERENCES pur_bills(id) ON DELETE CASCADE,
    order_line_id INTEGER NOT NULL REFERENCES pur_order_lines(id) ON DELETE CASCADE, qty REAL NOT NULL, price REAL NOT NULL
  );
  CREATE TABLE inv_items (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_ar TEXT, unit TEXT NOT NULL DEFAULT 'pcs', category TEXT NOT NULL DEFAULT 'general',
    min_qty REAL NOT NULL DEFAULT 0, reorder_qty REAL NOT NULL DEFAULT 0, location TEXT, avg_cost REAL NOT NULL DEFAULT 0, on_hand REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE inv_moves (
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES inv_items(id) ON DELETE CASCADE, date TEXT NOT NULL, kind TEXT NOT NULL,
    qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, value REAL NOT NULL DEFAULT 0, balance REAL NOT NULL DEFAULT 0,
    receipt_line_id INTEGER REFERENCES pur_receipt_lines(id) ON DELETE SET NULL, work_order_id INTEGER, department_id INTEGER, reason TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX inv_moves_item ON inv_moves(item_id, date);
  CREATE INDEX inv_moves_wo ON inv_moves(work_order_id);
`;

const PR_STATUS = {
  pending: ['pur|Waiting for approval', 'amber'], approved: ['pur|Approved', 'sky'], ordered: ['pur|Ordered', 'sea'],
  rejected: ['pur|Not approved', 'rose'], withdrawn: ['pur|Withdrawn', 'mute'], closed: ['pur|Closed', 'ok'],
};
const PO_STATUS = {
  draft: ['pur|Draft', 'mute'], sent: ['pur|Sent to the supplier', 'sky'], partial: ['pur|Partly received', 'amber'],
  received: ['pur|Received', 'sea'], closed: ['pur|Closed', 'ok'], cancelled: ['pur|Cancelled', 'rose'],
};
const OPEN_PO = ['sent', 'partial'];
const CATEGORIES = {
  electrical: 'pur|Electrical', plumbing: 'pur|Plumbing', hvac: 'pur|Air conditioning', cleaning: 'pur|Cleaning supplies',
  safety: 'pur|Safety and security', it: 'pur|IT and low current', general: 'pur|General',
};
// what parts issued to a department cost, by the item's category (a work order is always maintenance)
const ISSUE_ACCOUNTS = { cleaning: 'exp_cleaning', safety: 'exp_security' };
const UNITS = { pcs: 'pur|pcs', box: 'pur|box', set: 'pur|set', m: 'pur|m', l: 'pur|litre', kg: 'pur|kg', roll: 'pur|roll', pack: 'pur|pack' };
// non-stock lines: what they cost in the books
const ACCOUNTS = {
  exp_maintenance: 'pur|Maintenance and repairs', exp_cleaning: 'pur|Cleaning', exp_security: 'pur|Security', exp_utilities: 'pur|Utilities',
  exp_marketing: 'pur|Marketing', exp_other: 'pur|Other expenses', fa_mep: 'pur|Equipment (fixed asset)', fa_furniture: 'pur|Furniture (fixed asset)', fa_it: 'pur|IT equipment (fixed asset)',
};
const MOVES = {
  opening: 'pur|Opening stock', receive: 'pur|Received', issue: 'pur|Issued', adjust: 'pur|Adjusted',
};
const WO_OPEN = ['new', 'assigned', 'in_progress', 'on_hold', 'reopened'];
// the reasons offered for an adjustment (stored in English, shown in the reader's language)
const ADJUST = { 'Stock count': 'pur|Stock count', Damaged: 'pur|Damaged', Expired: 'pur|Expired', Found: 'pur|Found', 'Returned to the store': 'pur|Returned to the store' };

module.exports = function purchasing(router, h) {
  const { db, ui, M } = h;
  db.ensure('purchasing-1', SCHEMA);
  (h.auditTyped = h.auditTyped || []).push(
    'SELECT title, reason FROM pur_requests', 'SELECT description FROM pur_request_lines', 'SELECT description FROM pur_order_lines',
    'SELECT terms, notes, deliver_to FROM pur_orders', 'SELECT ref, delivery_note, note FROM pur_receipts', 'SELECT vendor_ref FROM pur_bills', 'SELECT name, name_ar, location FROM inv_items', 'SELECT reason FROM inv_moves', "SELECT substr(reason, instr(reason, ' · ') + 3) note FROM inv_moves WHERE instr(reason, ' · ') > 0",
  );
  const esc = ui.esc;
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const r3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const dateOr = (d, fb = M.today()) => (isDate(d) ? d : fb);
  const qtyf = (n) => (Number.isInteger(r3(n)) ? String(r3(n)) : r3(n).toLocaleString('en-US', { maximumFractionDigits: 3 }));
  const amt = (n) => ui.money(n, { cur: false });
  const prBadge = (s) => ui.badge(s, tr((PR_STATUS[s] || [s])[0]), (PR_STATUS[s] || [])[1]);
  const poBadge = (s) => ui.badge(s, tr((PO_STATUS[s] || [s])[0]), (PO_STATUS[s] || [])[1]);
  const unitLabel = (u) => (UNITS[u] ? tr(UNITS[u]) : u || '');
  const catLabel = (c) => tr(CATEGORIES[c] || 'pur|General');
  const itemName = (i) => (i ? (isAr() && i.name_ar ? i.name_ar : i.name) : '');
  const deptName = (n) => (n ? tx(n) : '—');
  const sub = (s) => `<small class="sub">${s}</small>`;
  const canAsk = (req) => h.can(req, 'agent');
  const canBuy = (req) => h.can(req, 'manager') || h.canFinance(req);
  const RA = (req, res, next) => (canAsk(req) ? next() : h.auth.denied(req, res));
  const RP = (req, res, next) => (canBuy(req) ? next() : h.auth.denied(req, res));
  const RF = h.RF;
  const L = () => (h.ledger && typeof h.ledger.post === 'function' ? h.ledger : null);
  // errors carry a pur| key (and its params) or the ledger's own English message
  const E = (key, params) => Object.assign(new Error(key), { params });
  const fail = (req, res, url, e) => {
    const m = String((e && e.message) || e);
    h.back(req, res, url, 'error', /^(pur|apr)\|/.test(m) ? tr(m, e.params) : tr('pur|That could not be done: {error}', { error: tr(m) }));
  };

  // ---------- lookups ----------
  const depts = () => db.all('SELECT id, name FROM departments ORDER BY sort, name');
  const vendors = () => (L() ? db.all('SELECT id, name FROM acc_vendors WHERE active = 1 ORDER BY name') : []);
  const vendorOf = (id) => (L() ? db.get('SELECT * FROM acc_vendors WHERE id = ?', id) : null);
  const itemOf = (id) => db.get('SELECT * FROM inv_items WHERE id = ?', id);
  const items = () => db.all('SELECT * FROM inv_items WHERE active = 1 ORDER BY code');
  const requestOf = (id) => db.get(`SELECT r.*, d.name dept, u.name requester FROM pur_requests r LEFT JOIN departments d ON d.id = r.department_id
    LEFT JOIN users u ON u.id = r.requested_by WHERE r.id = ?`, id);
  const orderOf = (id) => db.get(`SELECT o.*, v.name vendor, v.tax_id vendor_tax, v.phone vendor_phone, v.email vendor_email, d.name dept, r.ref request_ref, u.name creator
    FROM pur_orders o LEFT JOIN acc_vendors v ON v.id = o.vendor_id LEFT JOIN departments d ON d.id = o.department_id LEFT JOIN pur_requests r ON r.id = o.request_id
    LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`, id);
  const hasWO = () => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'work_orders'");
  const workOrders = (keep = null) => (hasWO() ? db.all(`SELECT id, ref, title, status FROM work_orders WHERE status IN (${WO_OPEN.map(() => '?').join(',')}) OR id = ? OR (resolved_at IS NOT NULL AND resolved_at >= ?) ORDER BY id DESC LIMIT 200`, ...WO_OPEN, keep || 0, M.addDays(M.today(), -30)) : []);

  // ---------- the books ----------
  function inventoryAccount() {
    const l = L();
    if (!l) return null;
    const a = l.byKey('inventory');
    if (a) return a.id;
    const parent = l.byCode('11');
    return l.createAccount({ code: l.nextCode('11', 1350), key: 'inventory', name_en: 'Inventory – spare parts and supplies', name_ar: 'المخزون – قطع الغيار والمستلزمات', type: 'asset', sub: 'current', parent_id: parent ? parent.id : null });
  }
  const LIVE = "EXISTS (SELECT 1 FROM acc_entries e WHERE e.source_base = 'stock:' || m.id AND e.reversed_by IS NULL AND e.reverses_id IS NULL)";
  function postMove(m) {
    const l = L();
    if (!l || m.kind === 'receive' || Math.abs(m.value) < 0.005) return null;
    const inv = inventoryAccount();
    const item = itemOf(m.item_id) || {};
    const v = r2(Math.abs(m.value));
    // memos are shown as typed (the item's code and name, the work order's number): no English to translate
    const wo = m.work_order_id && hasWO() ? db.value('SELECT ref FROM work_orders WHERE id = ?', m.work_order_id) : null;
    let lines;
    let memo = [item.code, item.name, wo].filter(Boolean).join(' · ');
    if (m.kind === 'opening') {
      lines = m.value > 0 ? [{ account: inv, debit: v }, { account: 'opening_equity', credit: v }] : [{ account: 'opening_equity', debit: v }, { account: inv, credit: v }];
      memo = `Opening balance · ${item.code}`;
    } else if (m.kind === 'issue') {
      const exp = m.work_order_id ? 'exp_maintenance' : ISSUE_ACCOUNTS[item.category] || 'exp_maintenance';
      lines = m.value < 0 ? [{ account: exp, debit: v }, { account: inv, credit: v }] : [{ account: inv, debit: v }, { account: exp, credit: v }];
    } else {
      lines = m.value > 0 ? [{ account: inv, debit: v }, { account: 'exp_other', credit: v }] : [{ account: 'exp_other', debit: v }, { account: inv, credit: v }];
    }
    try {
      return l.post({ date: l.firstOpen(m.date), memo, kind: 'auto', source: `stock:${m.id}`, lines, user: m.user_id ? { id: m.user_id } : null, demo: m.demo });
    } catch (e) {
      console.error('[purchasing] stock movement not posted:', e.message);
      return null;
    }
  }
  // movements not in the books yet (e.g. after the sample data reloaded the books): post them
  function syncBooks() {
    if (!L() || !db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'acc_entries'")) return 0;
    let n = 0;
    for (const m of db.all(`SELECT m.* FROM inv_moves m WHERE m.kind != 'receive' AND ABS(m.value) >= 0.005 AND NOT ${LIVE} ORDER BY m.date, m.id LIMIT 500`)) if (postMove(m)) n++;
    return n;
  }
  for (const p of ['/purchasing', '/accounting']) {
    router.use(p, (req, res, next) => {
      try {
        syncBooks();
      } catch (e) {
        console.error('[purchasing] books not synced:', e.message);
      }
      next();
    });
  }

  // ---------- stock ----------
  // One movement: on hand and the moving average cost follow. Receipts bring their unit cost;
  // everything else moves at the average cost.
  function move({ item_id, kind, qty, unit_cost = null, date = M.today(), receipt_line_id = null, work_order_id = null, department_id = null, reason = null, user = null, demo = 0, allowNegative = false }) {
    if (!MOVES[kind]) throw new Error('pur|Unknown stock movement.');
    return db.tx(() => {
      const it = itemOf(item_id);
      if (!it) throw new Error('pur|There is no such item.');
      const q = r3(qty);
      if (!q) throw new Error('pur|Enter the quantity.');
      const onHand = r3(it.on_hand + q);
      if (onHand < -0.0005 && !allowNegative) throw E('pur|Only {n} on hand.', { n: qtyf(it.on_hand) });
      let avg = it.avg_cost;
      let cost = it.avg_cost;
      if (q > 0 && (kind === 'receive' || kind === 'opening' || (kind === 'adjust' && unit_cost !== null))) {
        cost = r2(unit_cost === null ? it.avg_cost : unit_cost);
        avg = it.on_hand > 0 ? (it.on_hand * it.avg_cost + q * cost) / (it.on_hand + q) : cost;
      }
      const value = r2(q * cost);
      const id = Number(db.run(`INSERT INTO inv_moves (item_id, date, kind, qty, unit_cost, value, balance, receipt_line_id, work_order_id, department_id, reason, user_id, demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, it.id, dateOr(date), kind, q, cost, value, onHand, receipt_line_id, work_order_id, department_id, reason, user ? user.id : null, demo ? 1 : 0, now()).lastInsertRowid);
      db.run('UPDATE inv_items SET on_hand = ?, avg_cost = ?, updated_at = ? WHERE id = ?', onHand, Math.round(avg * 10000) / 10000, now(), it.id);
      const m = db.get('SELECT * FROM inv_moves WHERE id = ?', id);
      postMove(m);
      return m;
    });
  }
  const issue = ({ item_id, qty, work_order_id = null, department_id = null, date, reason = null, user = null, demo = 0 }) => {
    if (!work_order_id && !department_id) throw new Error('pur|Choose the work order or the department.');
    return move({ item_id, kind: 'issue', qty: -Math.abs(Number(qty) || 0), work_order_id, department_id, date, reason, user, demo });
  };
  const isLow = (i) => i.active && i.min_qty > 0 && i.on_hand <= i.min_qty;
  const lowItems = () => db.all('SELECT * FROM inv_items WHERE active = 1 AND min_qty > 0 AND on_hand <= min_qty ORDER BY (on_hand / min_qty), code');
  const reorderQty = (i) => r3(i.reorder_qty > 0 ? i.reorder_qty : Math.max(1, i.min_qty * 2 - i.on_hand));
  const issuesFor = (woId) => db.all('SELECT m.*, i.code, i.name, i.name_ar, i.unit FROM inv_moves m JOIN inv_items i ON i.id = m.item_id WHERE m.work_order_id = ? ORDER BY m.date, m.id', woId);

  // ---------- requests ----------
  const apr = () => (h.approvals && typeof h.approvals.needs === 'function' ? h.approvals : null);
  function createRequest({ title, department_id = null, needed_by = null, reason = null, lines, source = 'manual', user = null, demo = 0, at = null }) {
    const rows = (lines || []).map((l) => ({ ...l, qty: r3(l.qty), est_price: r2(l.est_price) })).filter((l) => l.description && l.qty > 0);
    if (!rows.length) throw new Error('pur|Add at least one line with a description and a quantity.');
    if (!title) throw new Error('pur|Give the request a title.');
    const total = r2(rows.reduce((s, l) => s + l.qty * l.est_price, 0));
    const t = at || now();
    const id = db.tx(() => {
      const rid = Number(db.run(`INSERT INTO pur_requests (ref, title, department_id, needed_by, reason, source, status, est_total, requested_by, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`, db.nextRef('pur_requests', 'PR', 4, true), title, department_id, isDate(needed_by) ? needed_by : null, reason, source, total, user ? user.id : null, demo ? 1 : 0, t, t).lastInsertRowid);
      rows.forEach((l, i) => db.run('INSERT INTO pur_request_lines (request_id, item_id, description, qty, unit, est_price, sort) VALUES (?, ?, ?, ?, ?, ?, ?)', rid, l.item_id || null, String(l.description).slice(0, 200), l.qty, l.unit || null, l.est_price, i));
      const A = apr();
      if (A && A.needs('purchase', total)) {
        const pr = requestOf(rid);
        const a = A.request({ kind: 'purchase', title, amount: total, entity: 'purchase_request', entity_id: rid, link: `/admin/purchasing/requests/${rid}`, payload: { request_id: rid, ref: pr.ref }, note: reason, user, demo, at: t });
        db.run("UPDATE pur_requests SET status = 'pending', approval_id = ? WHERE id = ?", a.id, rid);
      }
      return rid;
    });
    return requestOf(id);
  }
  (h.approvalHooks = h.approvalHooks || []).push((A) => {
    A.onDecision('purchase', (r, decision) => {
      const id = Number((r.payload && r.payload.request_id) || r.entity_id);
      db.run("UPDATE pur_requests SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'", decision === 'approved' ? 'approved' : 'rejected', now(), id);
    });
    A.onWithdraw('purchase', (r) => {
      const id = Number((r.payload && r.payload.request_id) || r.entity_id);
      db.run("UPDATE pur_requests SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status = 'pending'", now(), id);
    });
    A.describe('purchase', (r) => {
      const pr = requestOf(Number((r.payload && r.payload.request_id) || r.entity_id));
      return pr ? tr('pur|Purchase request {ref}: {title}', { ref: pr.ref, title: pr.title }) : r.title;
    });
    A.details('purchase', (r) => {
      const pr = requestOf(Number((r.payload && r.payload.request_id) || r.entity_id));
      if (!pr) return '';
      const lines = db.all('SELECT * FROM pur_request_lines WHERE request_id = ? ORDER BY sort, id', pr.id);
      return `<dl class="dl apr-more"><div><dt>${esc(tr('pur|Department'))}</dt><dd>${esc(deptName(pr.dept))}</dd></div>${pr.needed_by ? `<div><dt>${esc(tr('pur|Needed by'))}</dt><dd>${esc(ui.date(pr.needed_by))}</dd></div>` : ''}</dl>
        <div class="tablewrap"><table class="table table--fin"><thead><tr><th>${esc(tr('pur|Item'))}</th><th class="num">${esc(tr('pur|Qty'))}</th><th class="num">${esc(tr('pur|Estimate'))}</th></tr></thead><tbody>${lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${esc(qtyf(l.qty))} ${esc(unitLabel(l.unit))}</td><td class="num">${amt(r2(l.qty * l.est_price))}</td></tr>`).join('')}</tbody></table></div>`;
    });
  });

  // ---------- orders ----------
  // ordered, received and billed, line by line (the three-way match)
  function lineState(orderId) {
    return db.all(`SELECT l.*, i.code item_code, i.name item_name, i.name_ar item_name_ar,
        COALESCE((SELECT SUM(x.qty) FROM pur_receipt_lines x WHERE x.order_line_id = l.id), 0) received,
        COALESCE((SELECT SUM(b.qty) FROM pur_bill_lines b JOIN pur_bills pb ON pb.id = b.pur_bill_id LEFT JOIN acc_bills ab ON ab.id = pb.bill_id WHERE b.order_line_id = l.id AND COALESCE(ab.status, '') != 'void'), 0) billed,
        COALESCE((SELECT SUM(b.qty * b.price) FROM pur_bill_lines b JOIN pur_bills pb ON pb.id = b.pur_bill_id LEFT JOIN acc_bills ab ON ab.id = pb.bill_id WHERE b.order_line_id = l.id AND COALESCE(ab.status, '') != 'void'), 0) billed_value
      FROM pur_order_lines l LEFT JOIN inv_items i ON i.id = l.item_id WHERE l.order_id = ? ORDER BY l.sort, l.id`, orderId).map((l) => {
      const flags = [];
      if (r3(l.received) > r3(l.qty)) flags.push('over_received');
      if (r3(l.billed) > r3(l.received)) flags.push('over_billed');
      const billedPrice = l.billed > 0 ? l.billed_value / l.billed : null;
      if (billedPrice !== null && Math.abs(billedPrice - l.price) > 0.005) flags.push('price');
      return { ...l, received: r3(l.received), billed: r3(l.billed), billed_value: r2(l.billed_value), billed_price: billedPrice, flags };
    });
  }
  const FLAGS = { over_received: 'pur|More received than ordered', over_billed: 'pur|Billed more than received', price: 'pur|Billed at a different price' };
  const flagBadges = (flags) => flags.map((f) => ui.badge(f, tr(FLAGS[f]), 'rose')).join(' ');
  function totals(lines, vatPct) {
    const net = r2(lines.reduce((s, l) => s + r2(l.qty * l.price), 0));
    const vat = r2((net * (Number(vatPct) || 0)) / 100);
    return { net, vat, total: r2(net + vat) };
  }
  function createOrder({ vendor_id, request_id = null, department_id = null, order_date = M.today(), delivery_date = null, terms = null, payment_days = null, deliver_to = null, vat_pct = 14, notes = null, lines, status = 'draft', user = null, demo = 0 }) {
    const rows = (lines || []).map((l) => ({ ...l, qty: r3(l.qty), price: r2(l.price) })).filter((l) => l.description && l.qty > 0);
    if (!vendor_id) throw new Error('pur|Choose the supplier.');
    if (!rows.length) throw new Error('pur|Add at least one line with a description and a quantity.');
    const tt = totals(rows, vat_pct);
    const t = now();
    const id = db.tx(() => {
      const oid = Number(db.run(`INSERT INTO pur_orders (ref, request_id, vendor_id, department_id, status, order_date, delivery_date, terms, payment_days, deliver_to, vat_pct, net, vat, total, notes, created_by, sent_at, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, db.nextRef('pur_orders', 'PO', 4, true), request_id, vendor_id, department_id, status === 'sent' ? 'sent' : 'draft', dateOr(order_date),
      isDate(delivery_date) ? delivery_date : null, terms, payment_days, deliver_to, Number(vat_pct) || 0, tt.net, tt.vat, tt.total, notes, user ? user.id : null, status === 'sent' ? now() : null, demo ? 1 : 0, t, t).lastInsertRowid);
      rows.forEach((l, i) => db.run('INSERT INTO pur_order_lines (order_id, item_id, description, qty, unit, price, account, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', oid, l.item_id || null, String(l.description).slice(0, 200), l.qty, l.unit || null, l.price, l.item_id ? null : ACCOUNTS[l.account] ? l.account : 'exp_maintenance', i));
      if (request_id) db.run("UPDATE pur_requests SET status = 'ordered', updated_at = ? WHERE id = ? AND status IN ('approved','ordered')", t, request_id);
      return oid;
    });
    return orderOf(id);
  }
  // after a delivery or a bill: partly received, received, or closed once everything is billed too
  function refreshOrder(id) {
    const o = db.get('SELECT * FROM pur_orders WHERE id = ?', id);
    if (!o || ['cancelled', 'closed', 'draft'].includes(o.status)) return o && o.status;
    const lines = lineState(id);
    const got = lines.reduce((s, l) => s + Math.min(l.received, l.qty), 0);
    const all = lines.reduce((s, l) => s + l.qty, 0);
    const billedAll = lines.every((l) => l.billed >= Math.min(l.received, l.qty) - 0.0005 && l.billed >= l.qty - 0.0005);
    const status = got >= all - 0.0005 ? (billedAll ? 'closed' : 'received') : got > 0 ? 'partial' : 'sent';
    if (status !== o.status) db.run('UPDATE pur_orders SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?', status, status === 'closed' ? now() : null, now(), id);
    if (status === 'closed' && o.request_id && !db.value("SELECT COUNT(*) FROM pur_orders WHERE request_id = ? AND status NOT IN ('closed','cancelled')", o.request_id)) {
      db.run("UPDATE pur_requests SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'ordered'", now(), o.request_id);
    }
    return status;
  }
  function receive(orderId, { date = M.today(), delivery_note = null, note = null, lines, user = null, demo = 0 }) {
    const o = db.get('SELECT * FROM pur_orders WHERE id = ?', orderId);
    if (!o || !['sent', 'partial', 'received'].includes(o.status)) throw new Error('pur|Send the order to the supplier before receiving goods.');
    const want = Object.entries(lines || {}).map(([k, v]) => [Number(k), r3(v)]).filter(([, q]) => q > 0);
    if (!want.length) throw new Error('pur|Enter the quantity received on at least one line.');
    return db.tx(() => {
      const rid = Number(db.run('INSERT INTO pur_receipts (ref, order_id, date, delivery_note, note, received_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('pur_receipts', 'GRN', 4, true), o.id, dateOr(date), delivery_note, note, user ? user.id : null, demo ? 1 : 0, now()).lastInsertRowid);
      for (const [lineId, q] of want) {
        const l = db.get('SELECT * FROM pur_order_lines WHERE id = ? AND order_id = ?', lineId, o.id);
        if (!l) continue;
        const xid = Number(db.run('INSERT INTO pur_receipt_lines (receipt_id, order_line_id, qty) VALUES (?, ?, ?)', rid, l.id, q).lastInsertRowid);
        if (l.item_id) move({ item_id: l.item_id, kind: 'receive', qty: q, unit_cost: l.price, date: dateOr(date), receipt_line_id: xid, reason: null, user, demo });
      }
      refreshOrder(o.id);
      return db.get('SELECT * FROM pur_receipts WHERE id = ?', rid);
    });
  }
  // The supplier's invoice for an order: a bill in accounting, matched line by line.
  function billOrder(orderId, { vendor_ref = null, date = M.today(), due_date = null, lines, vat = null, approve = false, user = null, demo = 0 }) {
    const l = L();
    if (!l) throw new Error('pur|Accounting is not available.');
    const o = db.get('SELECT * FROM pur_orders WHERE id = ?', orderId);
    if (!o || ['draft', 'cancelled'].includes(o.status)) throw new Error('pur|Only an order sent to the supplier can be billed.');
    const state = Object.fromEntries(lineState(o.id).map((x) => [x.id, x]));
    const rows = (lines || []).map((x) => ({ ...x, line: state[Number(x.order_line_id)], qty: r3(x.qty), price: r2(x.price) })).filter((x) => x.line && x.qty > 0);
    if (!rows.length) throw new Error('pur|Enter the quantity billed on at least one line.');
    const net = r2(rows.reduce((s, x) => s + r2(x.qty * x.price), 0));
    const vatAmt = vat === null || vat === undefined || vat === '' ? r2((net * o.vat_pct) / 100) : r2(vat);
    const flags = [];
    for (const x of rows) {
      if (r3(x.line.billed + x.qty) > r3(x.line.received)) flags.push({ line: x.line.id, flag: 'over_billed' });
      if (Math.abs(x.price - x.line.price) > 0.005) flags.push({ line: x.line.id, flag: 'price' });
    }
    return db.tx(() => {
      const pid = Number(db.run('INSERT INTO pur_bills (order_id, vendor_ref, date, net, vat, total, flags, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        o.id, vendor_ref, dateOr(date), net, vatAmt, r2(net + vatAmt), flags.length ? JSON.stringify(flags) : null, user ? user.id : null, demo ? 1 : 0, now()).lastInsertRowid);
      for (const x of rows) db.run('INSERT INTO pur_bill_lines (pur_bill_id, order_line_id, qty, price) VALUES (?, ?, ?, ?)', pid, x.line.id, x.qty, x.price);
      const inv = rows.some((x) => x.line.item_id) ? inventoryAccount() : null;
      const bill = l.createBill({
        vendor_id: o.vendor_id, vendor_ref, date: dateOr(date), due_date: isDate(due_date) ? due_date : o.payment_days ? M.addDays(dateOr(date), o.payment_days) : null,
        lines: rows.map((x) => ({ account: x.line.item_id ? inv : x.line.account || 'exp_maintenance', description: `${x.line.description} · ${qtyf(x.qty)} × ${r2(x.price)}`, amount: r2(x.qty * x.price) })),
        vat: vatAmt, memo: o.ref, source: 'purchase', source_id: pid, status: approve ? 'approved' : 'draft', user, demo,
      });
      db.run('UPDATE pur_bills SET bill_id = ? WHERE id = ?', bill.id, pid);
      refreshOrder(o.id);
      return { ...db.get('SELECT * FROM pur_bills WHERE id = ?', pid), bill, flags };
    });
  }

  h.purchasing = { move, issue, receive, billOrder, createOrder, createRequest, refreshOrder, lineState, lowItems, issuesFor, syncBooks, inventoryAccount, partsCard: null };
  h.count('purchase', (user) => {
    if (!(h.auth.allowed(user, 'manager') || user.finance)) return 0;
    return db.value("SELECT COUNT(*) FROM pur_requests WHERE status = 'approved'")
      + db.value(`SELECT COUNT(*) FROM pur_orders WHERE status IN ('sent','partial') AND delivery_date IS NOT NULL AND delivery_date < ?`, M.today())
      + db.value('SELECT COUNT(*) FROM inv_items WHERE active = 1 AND min_qty > 0 AND on_hand <= min_qty');
  });
  h.every('purchasing-books', 60 * 60 * 1000, () => syncBooks());

  // ---------- pages ----------
  const TABS = [['/admin/purchasing', 'pur|Overview'], ['/admin/purchasing/requests', 'pur|Requests'], ['/admin/purchasing/orders', 'pur|Orders'], ['/admin/purchasing/receipts', 'pur|Deliveries'], ['/admin/purchasing/stock', 'pur|Stock'], ['/admin/purchasing/stock/movements', 'pur|Movements']];
  const tabs = (on) => `<nav class="tabs pur-tabs">${TABS.map(([href, l]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${esc(tr(l))}</a>`).join('')}</nav>`;
  // One filter bar for a list: the list's own selects, then the date range and "Sort by" of
  // h.listFilters (f), the Filter/Clear buttons and the quick ranges. hidden: params to keep.
  const bar = (action, f, extra = '', hidden = {}) => {
    const keep = Object.entries(hidden).filter(([, v]) => v !== '' && v !== null && v !== undefined);
    const on = f.active || extra.includes(' selected') || keep.some(([k]) => k !== 'status');
    return `<form method="get" action="${esc(action)}" class="filters">${keep.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${extra}${f.fields}
      <div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}${on || f.active ? `<a class="btn btn--ghost btn--sm" href="${esc(action)}${hidden.status ? `?status=${encodeURIComponent(hidden.status)}` : ''}">${esc(tr('Clear'))}</a>` : ''}</div>${f.quick}</form>`;
  };
  const page = (req, res, { title, on, body, crumbs, actions = '', wide = true }) => h.page(req, res, { title, active: '/admin/purchasing', crumbs, actions, wide, body: `${tabs(on)}${body}` });
  const names = () => Object.fromEntries(db.all('SELECT id, name FROM users').map((x) => [x.id, x.name]));
  const late = (o) => OPEN_PO.includes(o.status) && o.delivery_date && o.delivery_date < M.today();
  const ymOf = (d) => String(d).slice(0, 7);

  // ----- overview -----
  router.get('/purchasing', RA, (req, res) => {
    const T = M.today();
    const year = T.slice(0, 4);
    const month = T.slice(0, 7);
    const orders = db.all("SELECT o.*, v.name vendor, d.name dept FROM pur_orders o LEFT JOIN acc_vendors v ON v.id = o.vendor_id LEFT JOIN departments d ON d.id = o.department_id WHERE o.status != 'cancelled'");
    const open = orders.filter((o) => OPEN_PO.includes(o.status));
    const lateOnes = open.filter(late);
    const low = lowItems();
    const waiting = db.value("SELECT COUNT(*) FROM pur_requests WHERE status = 'pending'");
    const toOrder = db.all("SELECT r.*, d.name dept FROM pur_requests r LEFT JOIN departments d ON d.id = r.department_id WHERE r.status = 'approved' ORDER BY r.needed_by IS NULL, r.needed_by, r.id");
    const stockValue = r2(db.value('SELECT COALESCE(SUM(on_hand * avg_cost), 0) FROM inv_items WHERE active = 1'));
    const kpis = [
      ui.kpi({ label: tr('pur|Ordered this month'), value: ui.money(r2(orders.filter((o) => o.status !== 'draft' && ymOf(o.order_date) === month).reduce((s, o) => s + o.total, 0)), { compact: true }), sub: esc(tr('pur|{amount} this year', { amount: ui.money(r2(orders.filter((o) => o.status !== 'draft' && o.order_date.slice(0, 4) === year).reduce((s, o) => s + o.total, 0)), { compact: true }) })) }),
      ui.kpi({ label: tr('pur|Open orders'), value: String(open.length), href: '/admin/purchasing/orders?status=open', sub: esc(ui.money(r2(open.reduce((s, o) => s + o.total, 0)), { compact: true })) }),
      ui.kpi({ label: tr('pur|Late deliveries'), value: String(lateOnes.length), tone: lateOnes.length ? 'kpi--alert' : '', href: '/admin/purchasing/orders?status=late' }),
      ui.kpi({ label: tr('pur|Running low'), value: String(low.length), tone: low.length ? 'kpi--alert' : '', href: '/admin/purchasing/stock?low=1', sub: esc(tr('pur|Stock worth {amount}', { amount: ui.money(stockValue, { compact: true }) })) }),
      ui.kpi({ label: tr('pur|Requests waiting'), value: String(waiting), href: '/admin/purchasing/requests?status=pending', sub: toOrder.length ? esc(tn(toOrder.length, 'pur|{n} approved to order', 'pur|{n} approved to order')) : '' }),
    ].join('');
    // ordered by month, last 12 months
    const months = [];
    for (let k = 11; k >= 0; k--) {
      const ym = M.addMonths(`${month}-01`, -k).slice(0, 7);
      months.push({ ym, label: ui.monthName(Number(ym.slice(5, 7))), value: r2(orders.filter((o) => o.status !== 'draft' && ymOf(o.order_date) === ym).reduce((s, o) => s + o.total, 0)) });
    }
    const byMonth = ui.bars(months, { key: 'value', label: 'label', fmtv: (n) => ui.money(n, { compact: true, cur: false }) });
    const group = (key, label) => {
      const m = new Map();
      for (const o of orders.filter((x) => x.status !== 'draft' && x.order_date.slice(0, 4) === year)) {
        const k = o[key] || '';
        m.set(k, { label: label(o), value: r2(((m.get(k) || {}).value || 0) + o.total), href: (m.get(k) || {}).href });
      }
      const list = [...m.values()].sort((a, b) => b.value - a.value).slice(0, 8);
      const max = Math.max(1, ...list.map((x) => x.value));
      return list.length ? `<ul class="list pur-rank">${list.map((x) => `<li><span class="what"><b>${esc(x.label)}</b>${ui.meter(x.value / max)}</span><b class="num">${ui.money(x.value, { compact: true })}</b></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('pur|No orders this year yet.'))}</p>`;
    };
    const lateList = lateOnes.length ? `<ul class="list">${lateOnes.sort((a, b) => a.delivery_date.localeCompare(b.delivery_date)).slice(0, 8).map((o) => `<li class="is-late"><a href="/admin/purchasing/orders/${o.id}"><span class="what"><b><bdi>${esc(o.ref)}</bdi> · ${esc(o.vendor || '—')}</b><small>${esc(tr('pur|Due {date} · {days} late', { date: ui.date(o.delivery_date), days: tn(Math.round((new Date(T) - new Date(o.delivery_date)) / 86400000), 'pur|{n} day', 'pur|{n} days') }))}</small></span>${poBadge(o.status)}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('pur|Nothing is late.'))}</p>`;
    const csrf = req.session.csrf;
    const lowList = low.length ? `<ul class="list">${low.slice(0, 8).map((i) => `<li class="is-late"><a href="/admin/purchasing/stock/${i.id}"><span class="what"><b><bdi>${esc(i.code)}</bdi> · ${esc(itemName(i))}</b><small>${esc(tr('pur|{qty} on hand · minimum {min}', { qty: `${qtyf(i.on_hand)} ${unitLabel(i.unit)}`, min: qtyf(i.min_qty) }))}</small></span></a></li>`).join('')}</ul>${canAsk(req) ? ui.form('/admin/purchasing/stock/reorder', csrf, ui.btn(esc(tr('pur|Request everything running low')), { cls: 'btn--primary btn--sm', ic: 'plus' }), { cls: 'pad' }) : ''}` : `<p class="muted pad">${esc(tr('pur|Every item is above its minimum.'))}</p>`;
    const toOrderList = toOrder.length ? `<ul class="list">${toOrder.slice(0, 8).map((r) => `<li><a href="/admin/purchasing/requests/${r.id}"><span class="what"><b><bdi>${esc(r.ref)}</bdi> · ${esc(r.title)}</b><small>${esc(deptName(r.dept))}${r.needed_by ? ` · ${esc(tr('pur|needed by {date}', { date: ui.date(r.needed_by) }))}` : ''}</small></span><b>${ui.money(r.est_total, { compact: true })}</b></a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('pur|No approved request is waiting for an order.'))}</p>`;
    // three-way match: orders with a difference
    const issues = db.all("SELECT DISTINCT o.id, o.ref, v.name vendor FROM pur_bills b JOIN pur_orders o ON o.id = b.order_id LEFT JOIN acc_vendors v ON v.id = o.vendor_id LEFT JOIN acc_bills ab ON ab.id = b.bill_id WHERE b.flags IS NOT NULL AND COALESCE(ab.status, '') != 'void' ORDER BY b.id DESC LIMIT 8");
    const issueList = issues.length ? `<ul class="list">${issues.map((o) => `<li><a href="/admin/purchasing/orders/${o.id}"><span class="what"><b><bdi>${esc(o.ref)}</bdi> · ${esc(o.vendor || '—')}</b><small>${flagBadges([...new Set(lineState(o.id).flatMap((l) => l.flags))])}</small></span></a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('pur|Every bill matches its order and delivery.'))}</p>`;
    const actions = [
      canAsk(req) ? ui.btn(esc(tr('pur|New purchase request')), { href: '/admin/purchasing/requests/new', cls: 'btn--primary btn--sm', ic: 'plus' }) : '',
      canBuy(req) ? ui.btn(esc(tr('pur|New order')), { href: '/admin/purchasing/orders/new', cls: 'btn--ghost btn--sm', ic: 'file' }) : '',
    ].join('');
    page(req, res, {
      title: tr('pur|Purchasing'), on: '/admin/purchasing', actions,
      body: `<div class="kpis kpis--5">${kpis}</div>
        <div class="grid grid--2">${ui.card(tr('pur|Ordered by month'), byMonth, { sub: esc(tr('pur|Purchase orders, VAT included')) })}${ui.card(tr('pur|Approved, to order'), toOrderList)}</div>
        <div class="grid grid--2">${ui.card(tr('pur|By department this year'), group('department_id', (o) => deptName(o.dept)))}${ui.card(tr('pur|By supplier this year'), group('vendor_id', (o) => o.vendor || '—'))}</div>
        <div class="grid grid--2">${ui.card(tr('pur|Late deliveries'), lateList, { action: ui.btn(esc(tr('pur|All orders')), { href: '/admin/purchasing/orders', cls: 'btn--ghost btn--sm' }) })}${ui.card(tr('pur|Running low'), lowList, { action: ui.btn(esc(tr('pur|Stock')), { href: '/admin/purchasing/stock', cls: 'btn--ghost btn--sm' }) })}</div>
        ${ui.card(tr('pur|Bills that do not match'), issueList, { sub: esc(tr('pur|Ordered vs received vs billed')) })}`,
    });
  });

  // ----- requests -----
  router.get('/purchasing/requests', RA, (req, res) => {
    const q = req.query;
    const status = PR_STATUS[q.status] ? q.status : q.status === 'all' ? 'all' : 'open';
    const dept = h.int(q.dept);
    const f = h.listFilters(req, { cols: { date: 'r.created_at' }, dateLabel: tr('pur|Asked on'), keep: ['status', 'dept'], sort: { date: 'r.created_at', due: 'r.needed_by', amount: 'r.est_total', name: 'r.title', ref: 'r.ref' } });
    const where = [...f.where];
    const args = [...f.args];
    if (status === 'open') where.push("r.status IN ('pending','approved','ordered')");
    else if (status !== 'all') { where.push('r.status = ?'); args.push(status); }
    if (dept) { where.push('r.department_id = ?'); args.push(dept); }
    if (!canBuy(req)) { where.push('r.requested_by = ?'); args.push(req.user.id); }
    const rows = db.all(`SELECT r.*, d.name dept, u.name requester, (SELECT COUNT(*) FROM pur_request_lines l WHERE l.request_id = r.id) n_lines
      FROM pur_requests r LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN users u ON u.id = r.requested_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${f.order}, r.id DESC LIMIT 500`, ...args);
    const st = `<nav class="tabs tabs--sub">${['open', 'pending', 'approved', 'ordered', 'closed', 'rejected', 'withdrawn', 'all'].map((s) => `<a class="tab${status === s ? ' is-on' : ''}" href="/admin/purchasing/requests?status=${s}${dept ? `&dept=${dept}` : ''}">${esc(s === 'open' ? tr('pur|Open') : s === 'all' ? tr('All') : tr(PR_STATUS[s][0]))}</a>`).join('')}</nav>`;
    const deptSel = bar('/admin/purchasing/requests', f, ui.select('dept', tr('pur|Department'), depts().map((d) => [d.id, deptName(d.name)]), dept || '', { blank: tr('All'), attrs: { 'data-autosubmit': '' } }), { status });
    const table = ui.table([
      { label: tr('pur|Request'), sort: (r) => r.ref, render: (r) => `<b>${esc(r.title)}</b>${sub(`<bdi>${esc(r.ref)}</bdi> · ${esc(tn(r.n_lines, 'pur|{n} line', 'pur|{n} lines'))}${r.source === 'reorder' ? ` · ${esc(tr('pur|Low stock'))}` : ''}`)}` },
      { label: tr('pur|Department'), sort: (r) => deptName(r.dept), render: (r) => esc(deptName(r.dept)) },
      { label: tr('pur|Asked by'), sort: (r) => r.created_at, render: (r) => `${esc(r.requester || '—')}${sub(esc(ui.date(r.created_at)))}` },
      { label: tr('pur|Needed by'), sort: (r) => r.needed_by || '9999', render: (r) => (r.needed_by ? `<span class="${r.needed_by < M.today() && ['pending', 'approved'].includes(r.status) ? 'late' : ''}">${esc(ui.date(r.needed_by))}</span>` : '—') },
      { label: tr('pur|Estimate'), num: true, sort: (r) => r.est_total, render: (r) => amt(r.est_total) },
      { label: tr('pur|Status'), sort: (r) => r.status, render: (r) => prBadge(r.status) },
    ], rows, { empty: esc(tr('pur|No purchase requests here.')), href: (r) => `/admin/purchasing/requests/${r.id}` });
    page(req, res, {
      title: tr('pur|Purchase requests'), on: '/admin/purchasing/requests', actions: ui.btn(esc(tr('pur|New purchase request')), { href: '/admin/purchasing/requests/new', cls: 'btn--primary btn--sm', ic: 'plus' }),
      body: `${st}${deptSel}${ui.card(tr('pur|Purchase requests'), table, { sub: esc(tn(rows.length, 'pur|{n} request', 'pur|{n} requests')) })}`,
    });
  });

  const itemOptions = () => items().map((i) => [i.id, `${i.code} · ${itemName(i)}`]);
  // the line rows of a request or an order form (no script: a fixed number of rows, blank ones ignored)
  function lineRows(kind, lines, n) {
    const rows = [...lines];
    while (rows.length < n) rows.push({});
    const itemsOpt = itemOptions();
    return `<div class="pur-lines">${rows.map((l, i) => `<div class="pur-line">
      <span class="pur-line__n">${i + 1}</span>
      ${ui.select(`item_${i}`, tr('pur|Stock item'), itemsOpt, l.item_id || '', { blank: tr('pur|Not a stock item') })}
      ${ui.input(`desc_${i}`, tr('pur|Description'), l.description || '', { cls: 'pur-line__desc', placeholder: i === 0 ? tr('pur|e.g. LED panel 60×60, 40 W') : '' })}
      ${ui.input(`qty_${i}`, tr('pur|Qty'), l.qty || '', { type: 'number', min: 0, step: 'any' })}
      ${ui.select(`unit_${i}`, tr('pur|Unit'), Object.fromEntries(Object.entries(UNITS).map(([k, v]) => [k, tr(v)])), l.unit || 'pcs')}
      ${ui.input(`price_${i}`, kind === 'order' ? tr('pur|Unit price') : tr('pur|Estimated unit price'), l.price ?? l.est_price ?? '', { type: 'number', min: 0, step: '0.01' })}
      ${kind === 'order' ? ui.select(`account_${i}`, tr('pur|Booked to (not stock)'), Object.fromEntries(Object.entries(ACCOUNTS).map(([k, v]) => [k, tr(v)])), l.account || 'exp_maintenance') : ''}
    </div>`).join('')}</div>`;
  }
  // the lines as posted; a stock item with no description takes the item's name
  function postedLines(b, kind) {
    const out = [];
    for (let i = 0; i < 40; i++) {
      if (b[`desc_${i}`] === undefined && b[`item_${i}`] === undefined) continue;
      const it = h.int(b[`item_${i}`]) ? itemOf(h.int(b[`item_${i}`])) : null;
      const description = h.str(b[`desc_${i}`], 200) || (it ? it.name : '');
      const qty = h.numv(b[`qty_${i}`]) || 0;
      if (!description || !(qty > 0)) continue;
      const price = Math.max(0, h.numv(b[`price_${i}`]) || 0);
      out.push({ item_id: it ? it.id : null, description, qty, unit: UNITS[b[`unit_${i}`]] ? b[`unit_${i}`] : it ? it.unit : 'pcs', ...(kind === 'order' ? { price, account: ACCOUNTS[b[`account_${i}`]] ? b[`account_${i}`] : 'exp_maintenance' } : { est_price: price }) });
    }
    return out;
  }

  router.get('/purchasing/requests/new', RA, (req, res) => {
    const csrf = req.session.csrf;
    const pre = [];
    const it = h.int(req.query.item) ? itemOf(h.int(req.query.item)) : null;
    if (it) pre.push({ item_id: it.id, description: it.name, qty: h.numv(req.query.qty) || reorderQty(it), unit: it.unit, est_price: r2(it.avg_cost) });
    const n = Math.min(30, Math.max(5, h.int(req.query.lines) || 5, pre.length + 2));
    const rule = apr() ? apr().ruleOf('purchase') : null;
    const myDept = db.value('SELECT department_id FROM employees WHERE email = ? AND status = \'active\'', req.user.email);
    const form = ui.form('/admin/purchasing/requests', csrf, `<div class="fields">
      ${ui.input('title', tr('pur|What is it for'), it ? it.name : '', { required: true, cls: 'span-all', placeholder: tr('pur|e.g. Lighting spares for the food court') })}
      ${ui.select('department_id', tr('pur|Department'), depts().map((d) => [d.id, deptName(d.name)]), myDept || '', { blank: tr('pur|Choose…') })}
      ${ui.input('needed_by', tr('pur|Needed by'), '', { type: 'date', min: M.today() })}
      ${ui.textarea('reason', tr('pur|Why it is needed'), '', { rows: 2, cls: 'span-all' })}
    </div>
    <h3 class="pur-h">${esc(tr('pur|Lines'))}</h3>${lineRows('request', pre, n)}
    <p class="muted small">${esc(tr('pur|Blank lines are ignored.'))} <a href="/admin/purchasing/requests/new?lines=${n + 5}${it ? `&item=${it.id}` : ''}">${esc(tr('pur|More lines'))}</a></p>
    ${rule && rule.active ? `<p class="muted small">${esc(tr('pur|Requests from {amount} need approval before they are ordered.', { amount: ui.money(rule.min_amount) }))}</p>` : ''}
    ${ui.btn(esc(tr('pur|Send the request')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    page(req, res, { title: tr('pur|New purchase request'), on: '/admin/purchasing/requests', crumbs: [['/admin/purchasing', tr('pur|Purchasing')], ['/admin/purchasing/requests', tr('pur|Requests')], [null, tr('pur|New')]], body: ui.card(tr('pur|New purchase request'), form) });
  });
  router.post('/purchasing/requests', RA, (req, res) => {
    const b = req.body;
    const dept = h.int(b.department_id) && db.get('SELECT id FROM departments WHERE id = ?', h.int(b.department_id)) ? h.int(b.department_id) : null;
    try {
      const r = createRequest({ title: h.str(b.title, 200), department_id: dept, needed_by: b.needed_by, reason: h.str(b.reason, 1000) || null, lines: postedLines(b, 'request'), user: req.user });
      h.log(req, 'Raised a purchase request', 'purchase_request', r.id, `${r.ref} · ${r.est_total}`);
      h.back(req, res, `/admin/purchasing/requests/${r.id}`, 'ok', r.status === 'pending' ? tr('pur|Request sent for approval.') : tr('pur|Request saved. It can be ordered now.'));
    } catch (e) {
      fail(req, res, '/admin/purchasing/requests/new', e);
    }
  });
  router.get('/purchasing/requests/:id', RA, (req, res, next) => {
    const r = requestOf(h.int(req.params.id));
    if (!r) return next();
    if (!canBuy(req) && r.requested_by !== req.user.id) return h.auth.denied(req, res);
    const csrf = req.session.csrf;
    const lines = db.all('SELECT l.*, i.code FROM pur_request_lines l LEFT JOIN inv_items i ON i.id = l.item_id WHERE l.request_id = ? ORDER BY l.sort, l.id', r.id);
    const orders = db.all('SELECT o.*, v.name vendor FROM pur_orders o LEFT JOIN acc_vendors v ON v.id = o.vendor_id WHERE o.request_id = ? ORDER BY o.id', r.id);
    const ap = r.approval_id && apr() ? apr().requestOf(r.approval_id) : null;
    const table = `<div class="tablewrap"><table class="table table--fin table--resp"><thead><tr><th>${esc(tr('pur|Item'))}</th><th class="num">${esc(tr('pur|Qty'))}</th><th class="num">${esc(tr('pur|Estimated unit price'))}</th><th class="num">${esc(tr('pur|Estimate'))}</th></tr></thead><tbody>
      ${lines.map((l) => `<tr><td data-label="${esc(tr('pur|Item'))}">${esc(l.description)}${l.code ? sub(`<a href="/admin/purchasing/stock/${l.item_id}"><bdi>${esc(l.code)}</bdi></a>`) : ''}</td><td class="num" data-label="${esc(tr('pur|Qty'))}">${esc(qtyf(l.qty))} ${esc(unitLabel(l.unit))}</td><td class="num" data-label="${esc(tr('pur|Estimated unit price'))}">${amt(l.est_price)}</td><td class="num" data-label="${esc(tr('pur|Estimate'))}">${amt(r2(l.qty * l.est_price))}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="3">${esc(tr('pur|Estimated total'))}</td><td class="num">${ui.money(r.est_total)}</td></tr></tfoot></table></div>`;
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('pur|Department'))}</dt><dd>${esc(deptName(r.dept))}</dd></div>
      <div><dt>${esc(tr('pur|Asked by'))}</dt><dd>${esc(r.requester || '—')} · ${esc(ui.dt(r.created_at))}</dd></div>
      ${r.needed_by ? `<div><dt>${esc(tr('pur|Needed by'))}</dt><dd>${esc(ui.date(r.needed_by))}</dd></div>` : ''}
      ${r.reason ? `<div><dt>${esc(tr('pur|Why'))}</dt><dd>${esc(r.reason)}</dd></div>` : ''}
      ${ap ? `<div><dt>${esc(tr('pur|Approval'))}</dt><dd><a href="/admin/approvals/${ap.id}"><bdi>${esc(ap.ref)}</bdi></a> · ${esc(tr((({ pending: 'apr|Waiting', approved: 'apr|Approved', rejected: 'apr|Rejected', withdrawn: 'apr|Withdrawn' })[ap.status]) || ap.status))}</dd></div>` : ''}
    </dl>`;
    const orderList = orders.length ? `<ul class="list">${orders.map((o) => `<li><a href="/admin/purchasing/orders/${o.id}"><span class="what"><b><bdi>${esc(o.ref)}</bdi> · ${esc(o.vendor || '—')}</b><small>${esc(ui.date(o.order_date))} · ${ui.money(o.total)}</small></span>${poBadge(o.status)}</a></li>`).join('')}</ul>` : '';
    const acts = [];
    if (canBuy(req) && ['approved', 'ordered'].includes(r.status)) acts.push(ui.btn(esc(tr('pur|Create the purchase order')), { href: `/admin/purchasing/orders/new?request=${r.id}`, cls: 'btn--primary btn--block', ic: 'file' }));
    if (r.status === 'pending' && ap) acts.push(ui.btn(esc(tr('pur|See the approval')), { href: `/admin/approvals/${ap.id}`, cls: 'btn--ghost btn--block', ic: 'check' }));
    if (canBuy(req) && ['approved', 'ordered'].includes(r.status)) acts.push(`<details class="danger"><summary>${esc(tr('pur|Close the request'))}</summary>${ui.form(`/admin/purchasing/requests/${r.id}/close`, csrf, ui.btn(esc(tr('pur|Close the request')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('pur|Close this request? Nothing more will be ordered for it.') } }))}</details>`);
    page(req, res, {
      title: r.title, on: '/admin/purchasing/requests', wide: false, crumbs: [['/admin/purchasing', tr('pur|Purchasing')], ['/admin/purchasing/requests', tr('pur|Requests')], [null, r.ref]],
      body: `<div class="grid grid--side"><div class="stack">${ui.card(r.title, facts, { action: prBadge(r.status), sub: `<bdi>${esc(r.ref)}</bdi>` })}${ui.card(tr('pur|Lines'), table)}${orderList ? ui.card(tr('pur|Purchase orders'), orderList) : ''}</div><div class="stack">${acts.length ? ui.card(tr('pur|Next step'), `<div class="stack">${acts.join('')}</div>`) : ''}</div></div>`,
    });
  });
  router.post('/purchasing/requests/:id/close', RP, (req, res, next) => {
    const r = requestOf(h.int(req.params.id));
    if (!r) return next();
    if (!['approved', 'ordered'].includes(r.status)) return h.back(req, res, `/admin/purchasing/requests/${r.id}`, 'error', tr('pur|Only an approved request can be closed.'));
    db.run("UPDATE pur_requests SET status = 'closed', updated_at = ? WHERE id = ?", now(), r.id);
    h.log(req, 'Closed a purchase request', 'purchase_request', r.id, r.ref);
    h.back(req, res, `/admin/purchasing/requests/${r.id}`, 'ok', tr('pur|Request closed.'));
  });

  // ----- orders -----
  router.get('/purchasing/orders', RA, (req, res) => {
    if (!canBuy(req)) return h.auth.denied(req, res);
    const q = req.query;
    const status = PO_STATUS[q.status] || ['open', 'late', 'all'].includes(q.status) ? q.status : 'all';
    const vendor = h.int(q.vendor);
    const f = h.listFilters(req, { cols: { date: 'o.order_date' }, dateLabel: tr('pur|Ordered on'), keep: ['status', 'vendor'], sort: { date: 'o.order_date', due: 'o.delivery_date', amount: 'o.total', name: 'v.name', ref: 'o.ref' } });
    const where = [...f.where];
    const args = [...f.args];
    if (status === 'open') where.push("o.status IN ('draft','sent','partial')");
    else if (status === 'late') { where.push("o.status IN ('sent','partial') AND o.delivery_date < ?"); args.push(M.today()); } else if (status !== 'all') { where.push('o.status = ?'); args.push(status); }
    if (vendor) { where.push('o.vendor_id = ?'); args.push(vendor); }
    const rows = db.all(`SELECT o.*, v.name vendor, d.name dept FROM pur_orders o LEFT JOIN acc_vendors v ON v.id = o.vendor_id LEFT JOIN departments d ON d.id = o.department_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${f.order}, o.id ${['oldest', 'due', 'amount_asc', 'name'].includes(f.sortKey) ? 'ASC' : 'DESC'} LIMIT 500`, ...args);
    const st = `<nav class="tabs tabs--sub">${['all', 'open', 'late', 'draft', 'sent', 'partial', 'received', 'closed', 'cancelled'].map((s) => `<a class="tab${status === s ? ' is-on' : ''}" href="/admin/purchasing/orders?status=${s}${vendor ? `&vendor=${vendor}` : ''}">${esc(s === 'all' ? tr('All') : s === 'open' ? tr('pur|Open') : s === 'late' ? tr('pur|Late') : tr(PO_STATUS[s][0]))}</a>`).join('')}</nav>`;
    const vendSel = bar('/admin/purchasing/orders', f, ui.select('vendor', tr('pur|Supplier'), db.all('SELECT DISTINCT v.id, v.name FROM acc_vendors v JOIN pur_orders o ON o.vendor_id = v.id ORDER BY v.name').map((v) => [v.id, v.name]), vendor || '', { blank: tr('All'), attrs: { 'data-autosubmit': '' } }), { status });
    const table = ui.table([
      { label: tr('pur|Order'), sort: (o) => o.ref, render: (o) => `<b><bdi>${esc(o.ref)}</bdi></b>${sub(esc(deptName(o.dept)))}` },
      { label: tr('pur|Supplier'), sort: (o) => o.vendor || '', render: (o) => esc(o.vendor || '—') },
      { label: tr('pur|Ordered on'), sort: (o) => o.order_date, render: (o) => esc(ui.date(o.order_date)) },
      { label: tr('pur|Delivery by'), sort: (o) => o.delivery_date || '9999', render: (o) => (o.delivery_date ? `<span class="${late(o) ? 'late' : ''}">${esc(ui.date(o.delivery_date))}</span>${late(o) ? sub(esc(tr('pur|Late'))) : ''}` : '—') },
      { label: tr('pur|Total'), num: true, sort: (o) => o.total, render: (o) => amt(o.total) },
      { label: tr('pur|Status'), sort: (o) => o.status, render: (o) => poBadge(o.status) },
    ], rows, { empty: esc(tr('pur|No purchase orders here.')), href: (o) => `/admin/purchasing/orders/${o.id}` });
    page(req, res, {
      title: tr('pur|Purchase orders'), on: '/admin/purchasing/orders', actions: ui.btn(esc(tr('pur|New order')), { href: '/admin/purchasing/orders/new', cls: 'btn--primary btn--sm', ic: 'plus' }),
      body: `${st}${vendSel}${ui.card(tr('pur|Purchase orders'), table, { sub: esc(tr('pur|{n} orders · {amount}', { n: rows.length, amount: ui.money(r2(rows.reduce((s, o) => s + o.total, 0)), { compact: true }) })) })}`,
    });
  });
  router.get('/purchasing/orders/new', RP, (req, res) => {
    const csrf = req.session.csrf;
    const pr = h.int(req.query.request) ? requestOf(h.int(req.query.request)) : null;
    const pre = pr ? db.all('SELECT * FROM pur_request_lines WHERE request_id = ? ORDER BY sort, id', pr.id).map((l) => ({ ...l, price: l.est_price })) : [];
    const n = Math.min(30, Math.max(5, h.int(req.query.lines) || 5, pre.length + 1));
    const s = db.settings();
    const form = ui.form('/admin/purchasing/orders', csrf, `${pr ? `<input type="hidden" name="request_id" value="${pr.id}">` : ''}<div class="fields">
      ${ui.select('vendor_id', tr('pur|Supplier'), vendors().map((v) => [v.id, v.name]), '', { blank: tr('pur|Choose…') })}
      ${ui.input('vendor_new', tr('pur|or a new supplier'), '', { placeholder: tr('pur|Supplier name') })}
      ${ui.select('department_id', tr('pur|Department'), depts().map((d) => [d.id, deptName(d.name)]), pr ? pr.department_id || '' : '', { blank: tr('pur|Choose…') })}
      ${ui.input('order_date', tr('pur|Order date'), M.today(), { type: 'date', required: true })}
      ${ui.input('delivery_date', tr('pur|Delivery by'), pr && pr.needed_by ? pr.needed_by : M.addDays(M.today(), 14), { type: 'date' })}
      ${ui.input('payment_days', tr('pur|Payment due (days)'), 30, { type: 'number', min: 0, max: 365 })}
      ${ui.input('vat_pct', tr('pur|VAT %'), 14, { type: 'number', min: 0, max: 100, step: '0.01' })}
      ${ui.input('deliver_to', tr('pur|Deliver to'), s.legal_name ? `${s.legal_name} · ${s.address || ''}` : '', { cls: 'span-all' })}
      ${ui.textarea('terms', tr('pur|Terms'), tr('pur|Prices include delivery to site. Goods are inspected on receipt; anything damaged or not as ordered is returned at the supplier\'s cost. Quote the order number on the delivery note and the invoice.'), { rows: 3, cls: 'span-all' })}
    </div>
    <h3 class="pur-h">${esc(tr('pur|Lines'))}</h3>${lineRows('order', pre, n)}
    <p class="muted small">${esc(tr('pur|Blank lines are ignored.'))} <a href="/admin/purchasing/orders/new?lines=${n + 5}${pr ? `&request=${pr.id}` : ''}">${esc(tr('pur|More lines'))}</a></p>
    <div class="row">${ui.btn(esc(tr('pur|Save as draft')), { cls: 'btn--ghost', attrs: { name: 'send', value: '0' } })}${ui.btn(esc(tr('pur|Save and mark as sent')), { cls: 'btn--primary', attrs: { name: 'send', value: '1' } })}</div>`, { cls: 'stack' });
    page(req, res, {
      title: tr('pur|New purchase order'), on: '/admin/purchasing/orders', crumbs: [['/admin/purchasing', tr('pur|Purchasing')], ['/admin/purchasing/orders', tr('pur|Orders')], [null, tr('pur|New')]],
      body: ui.card(pr ? tr('pur|Order for {ref}: {title}', { ref: pr.ref, title: pr.title }) : tr('pur|New purchase order'), form),
    });
  });
  router.post('/purchasing/orders', RP, (req, res) => {
    const b = req.body;
    const l = L();
    if (!l) return h.back(req, res, '/admin/purchasing/orders', 'error', tr('pur|Accounting is not available.'));
    const pr = h.int(b.request_id) ? requestOf(h.int(b.request_id)) : null;
    if (pr && !['approved', 'ordered'].includes(pr.status)) return h.back(req, res, `/admin/purchasing/requests/${pr.id}`, 'error', tr('pur|This request is not approved yet.'));
    let vendorId = h.int(b.vendor_id) && vendorOf(h.int(b.vendor_id)) ? h.int(b.vendor_id) : null;
    const back = `/admin/purchasing/orders/new${pr ? `?request=${pr.id}` : ''}`;
    if (!vendorId && h.str(b.vendor_new, 120)) vendorId = l.vendorFor(h.str(b.vendor_new, 120)).id;
    try {
      const days = h.int(b.payment_days);
      const o = createOrder({
        vendor_id: vendorId, request_id: pr ? pr.id : null, department_id: h.int(b.department_id) && db.get('SELECT id FROM departments WHERE id = ?', h.int(b.department_id)) ? h.int(b.department_id) : null,
        order_date: b.order_date, delivery_date: b.delivery_date, terms: h.str(b.terms, 2000) || null, payment_days: days !== null && days >= 0 ? Math.min(365, days) : null,
        deliver_to: h.str(b.deliver_to, 300) || null, vat_pct: Math.min(100, Math.max(0, h.numv(b.vat_pct) || 0)), lines: postedLines(b, 'order'), status: b.send === '1' ? 'sent' : 'draft', user: req.user,
      });
      h.log(req, 'Created a purchase order', 'purchase_order', o.id, `${o.ref} · ${o.vendor} · ${o.total}`);
      h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'ok', o.status === 'sent' ? tr('pur|Order {ref} saved and marked as sent. Print it for the supplier.', { ref: o.ref }) : tr('pur|Order {ref} saved as a draft.', { ref: o.ref }));
    } catch (e) {
      fail(req, res, back, e);
    }
  });
  const pbillsOf = (orderId) => db.all('SELECT pb.*, ab.ref bill_ref, ab.status bill_status, ab.paid bill_paid, ab.total bill_total FROM pur_bills pb LEFT JOIN acc_bills ab ON ab.id = pb.bill_id WHERE pb.order_id = ? ORDER BY pb.date, pb.id', orderId);
  router.get('/purchasing/orders/:id', RP, (req, res, next) => {
    const o = orderOf(h.int(req.params.id));
    if (!o) return next();
    const csrf = req.session.csrf;
    const lines = lineState(o.id);
    const receipts = db.all('SELECT r.*, u.name by_name FROM pur_receipts r LEFT JOIN users u ON u.id = r.received_by WHERE r.order_id = ? ORDER BY r.date, r.id', o.id);
    const bills = pbillsOf(o.id);
    const allFlags = [...new Set(lines.flatMap((l) => l.flags))];
    const lineTable = `<div class="tablewrap"><table class="table table--fin table--resp pur-match"><thead><tr><th>${esc(tr('pur|Item'))}</th><th class="num">${esc(tr('pur|Ordered'))}</th><th class="num">${esc(tr('pur|Unit price'))}</th><th class="num">${esc(tr('pur|Received'))}</th><th class="num">${esc(tr('pur|Billed'))}</th><th class="num">${esc(tr('pur|Amount'))}</th></tr></thead><tbody>
      ${lines.map((l) => `<tr class="${l.flags.length ? 'is-flag' : ''}"><td data-label="${esc(tr('pur|Item'))}">${esc(l.description)}${l.item_code ? sub(`<a href="/admin/purchasing/stock/${l.item_id}"><bdi>${esc(l.item_code)}</bdi></a> · ${esc(tr('pur|Stock'))}`) : sub(esc(tr(ACCOUNTS[l.account] || 'pur|Maintenance and repairs')))}${l.flags.length ? `<div>${flagBadges(l.flags)}</div>` : ''}</td>
        <td class="num" data-label="${esc(tr('pur|Ordered'))}">${esc(qtyf(l.qty))} ${esc(unitLabel(l.unit))}</td><td class="num" data-label="${esc(tr('pur|Unit price'))}">${amt(l.price)}${l.billed_price !== null && l.flags.includes('price') ? sub(esc(tr('pur|billed at {price}', { price: amt(r2(l.billed_price)) }))) : ''}</td>
        <td class="num" data-label="${esc(tr('pur|Received'))}">${esc(qtyf(l.received))}${l.received < l.qty ? sub(esc(tr('pur|{n} to come', { n: qtyf(r3(l.qty - l.received)) }))) : ''}</td><td class="num" data-label="${esc(tr('pur|Billed'))}">${esc(qtyf(l.billed))}</td><td class="num" data-label="${esc(tr('pur|Amount'))}">${amt(r2(l.qty * l.price))}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="5">${esc(tr('pur|Net'))}</td><td class="num">${amt(o.net)}</td></tr><tr><td colspan="5">${esc(tr('pur|VAT {pct}%', { pct: o.vat_pct }))}</td><td class="num">${amt(o.vat)}</td></tr><tr><td colspan="5"><b>${esc(tr('pur|Total'))}</b></td><td class="num"><b>${ui.money(o.total)}</b></td></tr></tfoot></table></div>`;
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('pur|Supplier'))}</dt><dd><a href="/admin/accounting/vendors/${o.vendor_id}">${esc(o.vendor || '—')}</a></dd></div>
      <div><dt>${esc(tr('pur|Order date'))}</dt><dd>${esc(ui.date(o.order_date))}${o.creator ? ` · ${esc(o.creator)}` : ''}</dd></div>
      <div><dt>${esc(tr('pur|Delivery by'))}</dt><dd>${o.delivery_date ? `<span class="${late(o) ? 'late' : ''}">${esc(ui.date(o.delivery_date))}</span>${late(o) ? ` · ${ui.badge('late', tr('pur|Late'), 'rose')}` : ''}` : '—'}</dd></div>
      ${o.payment_days !== null ? `<div><dt>${esc(tr('pur|Payment'))}</dt><dd>${esc(tn(o.payment_days, 'pur|{n} day after the invoice', 'pur|{n} days after the invoice'))}</dd></div>` : ''}
      <div><dt>${esc(tr('pur|Department'))}</dt><dd>${esc(deptName(o.dept))}</dd></div>
      ${o.request_id ? `<div><dt>${esc(tr('pur|Request'))}</dt><dd><a href="/admin/purchasing/requests/${o.request_id}"><bdi>${esc(o.request_ref)}</bdi></a></dd></div>` : ''}
      ${o.deliver_to ? `<div><dt>${esc(tr('pur|Deliver to'))}</dt><dd>${esc(o.deliver_to)}</dd></div>` : ''}
      ${o.terms ? `<div><dt>${esc(tr('pur|Terms'))}</dt><dd>${esc(o.terms)}</dd></div>` : ''}
    </dl>`;
    const recList = receipts.length ? `<ul class="list">${receipts.map((r) => `<li><a href="/admin/purchasing/receipts/${r.id}"><span class="what"><b><bdi>${esc(r.ref)}</bdi>${r.delivery_note ? ` · ${esc(r.delivery_note)}` : ''}</b><small>${esc(ui.date(r.date))} · ${esc(r.by_name || '—')}</small></span></a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('pur|Nothing received yet.'))}</p>`;
    const billList = bills.length ? `<ul class="list">${bills.map((b) => `<li><a href="/admin/accounting/bills/${b.bill_id}"><span class="what"><b><bdi>${esc(b.bill_ref || '—')}</bdi>${b.vendor_ref ? ` · <bdi>${esc(b.vendor_ref)}</bdi>` : ''}</b><small>${esc(ui.date(b.date))} · ${ui.money(b.total)}${b.bill_paid ? ` · ${esc(tr('pur|{amount} paid', { amount: ui.money(b.bill_paid) }))}` : ''}</small></span>${b.flags ? ui.badge('flag', tr('pur|Difference'), 'rose') : ''}${ui.badge(b.bill_status, tr(({ draft: 'pur|Draft', approved: 'pur|To pay', partial: 'pur|Partly paid', paid: 'pur|Paid', void: 'pur|Void' })[b.bill_status] || 'pur|Draft'))}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('pur|No supplier bill yet.'))}</p>`;
    // actions
    const acts = [];
    acts.push(ui.btn(esc(tr('pur|Print the order')), { href: `/admin/purchasing/orders/${o.id}/print?doc=both`, cls: 'btn--ghost btn--block', ic: 'print' }));
    if (o.status === 'draft') acts.push(ui.form(`/admin/purchasing/orders/${o.id}/send`, csrf, ui.btn(esc(tr('pur|Mark as sent to the supplier')), { cls: 'btn--primary btn--block', ic: 'mail' })));
    const toReceive = lines.filter((l) => l.received < l.qty);
    const receiveCard = ['sent', 'partial'].includes(o.status) && toReceive.length ? ui.card(tr('pur|Receive goods'), ui.form(`/admin/purchasing/orders/${o.id}/receive`, csrf, `<div class="fields">${ui.input('date', tr('pur|Received on'), M.today(), { type: 'date' })}${ui.input('delivery_note', tr('pur|Delivery note number'), '')}</div>
      <div class="pur-recv">${toReceive.map((l) => `<label class="f pur-recv__l"><span class="f__l">${esc(l.description)} <small class="muted">${esc(tr('pur|{n} of {total} received', { n: qtyf(l.received), total: qtyf(l.qty) }))}</small></span><input type="number" name="qty_${l.id}" value="${esc(qtyf(r3(l.qty - l.received)))}" min="0" step="any"></label>`).join('')}</div>
      ${ui.input('note', tr('pur|Note'), '')}${ui.btn(esc(tr('pur|Record the delivery')), { cls: 'btn--primary btn--sm', ic: 'check' })}`, { cls: 'stack' }), { sub: esc(tr('pur|A part delivery is fine: the rest stays open.')) }) : '';
    const billable = lines.filter((l) => l.received > l.billed);
    const billCard = h.canFinance(req) && !['draft', 'cancelled'].includes(o.status) && billable.length ? ui.card(tr('pur|Supplier bill'), ui.form(`/admin/purchasing/orders/${o.id}/bill`, csrf, `<div class="fields">${ui.input('vendor_ref', tr('pur|Supplier invoice number'), '', { required: true })}${ui.input('date', tr('pur|Invoice date'), M.today(), { type: 'date' })}</div>
      <div class="pur-recv">${billable.map((l) => `<div class="pur-bill__l"><span class="f__l">${esc(l.description)} <small class="muted">${esc(tr('pur|received {r} · billed {b}', { r: qtyf(l.received), b: qtyf(l.billed) }))}</small></span><div class="fields fields--2">${ui.input(`qty_${l.id}`, tr('pur|Qty billed'), qtyf(Math.max(0, r3(l.received - l.billed))), { type: 'number', min: 0, step: 'any' })}${ui.input(`price_${l.id}`, tr('pur|Unit price billed'), l.price, { type: 'number', min: 0, step: '0.01' })}</div></div>`).join('')}</div>
      ${ui.input('vat', tr('pur|VAT on the invoice (blank: {pct}%)', { pct: o.vat_pct }), '', { type: 'number', min: 0, step: '0.01' })}
      <label class="check"><input type="checkbox" name="approve" value="1"> ${esc(tr('pur|Approve it for payment now'))}</label>
      ${ui.btn(esc(tr('pur|Record the bill')), { cls: 'btn--primary btn--sm', ic: 'coins' })}`, { cls: 'stack' }), { sub: esc(tr('pur|Checked against what was ordered and received; any difference is flagged.')) }) : '';
    if (['received', 'partial'].includes(o.status)) acts.push(`<details class="danger"><summary>${esc(tr('pur|Close the order'))}</summary>${ui.form(`/admin/purchasing/orders/${o.id}/close`, csrf, `<p class="muted small">${esc(tr('pur|Nothing more will be delivered or billed on it.'))}</p>${ui.btn(esc(tr('pur|Close the order')), { cls: 'btn--danger btn--sm' })}`)}</details>`);
    if (['draft', 'sent'].includes(o.status) && !receipts.length && !bills.length) acts.push(`<details class="danger"><summary>${esc(tr('pur|Cancel the order'))}</summary>${ui.form(`/admin/purchasing/orders/${o.id}/cancel`, csrf, ui.btn(esc(tr('pur|Cancel the order')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('pur|Cancel this order? Tell the supplier too.') } }))}</details>`);
    page(req, res, {
      title: tr('pur|Purchase order {ref}', { ref: o.ref }), on: '/admin/purchasing/orders', crumbs: [['/admin/purchasing', tr('pur|Purchasing')], ['/admin/purchasing/orders', tr('pur|Orders')], [null, o.ref]],
      body: `${allFlags.length ? `<div class="alert alert--warn">${esc(tr('pur|The bills do not match the order and the deliveries:'))} ${flagBadges(allFlags)}</div>` : ''}
        <div class="grid grid--side"><div class="stack">${ui.card(o.vendor || '—', facts, { action: poBadge(o.status), sub: `<bdi>${esc(o.ref)}</bdi>` })}</div>
        <div class="stack">${ui.card(tr('pur|Next step'), `<div class="stack">${acts.join('')}</div>`)}${receiveCard}</div></div>
        ${ui.card(tr('pur|Ordered, received, billed'), lineTable)}
        <div class="grid grid--side"><div class="grid grid--2 pur-docs">${ui.card(tr('pur|Deliveries'), recList)}${ui.card(tr('pur|Supplier bills'), billList)}</div><div class="stack">${billCard}</div></div>`,
    });
  });
  router.post('/purchasing/orders/:id/send', RP, (req, res, next) => {
    const o = orderOf(h.int(req.params.id));
    if (!o) return next();
    if (o.status !== 'draft') return h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'error', tr('pur|Only a draft order can be sent.'));
    db.run("UPDATE pur_orders SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?", now(), now(), o.id);
    h.log(req, 'Sent a purchase order', 'purchase_order', o.id, o.ref);
    h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'ok', tr('pur|Marked as sent. Print it or email it to the supplier.'));
  });
  router.post('/purchasing/orders/:id/cancel', RP, (req, res, next) => {
    const o = orderOf(h.int(req.params.id));
    if (!o) return next();
    if (!['draft', 'sent'].includes(o.status) || db.value('SELECT COUNT(*) FROM pur_receipts WHERE order_id = ?', o.id) || db.value('SELECT COUNT(*) FROM pur_bills WHERE order_id = ?', o.id)) return h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'error', tr('pur|Only an order with nothing received or billed can be cancelled.'));
    db.tx(() => {
      db.run("UPDATE pur_orders SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), o.id);
      if (o.request_id && !db.value("SELECT COUNT(*) FROM pur_orders WHERE request_id = ? AND status != 'cancelled'", o.request_id)) db.run("UPDATE pur_requests SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'ordered'", now(), o.request_id);
    });
    h.log(req, 'Cancelled a purchase order', 'purchase_order', o.id, o.ref);
    h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'ok', tr('pur|Order cancelled.'));
  });
  router.post('/purchasing/orders/:id/close', RP, (req, res, next) => {
    const o = orderOf(h.int(req.params.id));
    if (!o) return next();
    if (!['received', 'partial'].includes(o.status)) return h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'error', tr('pur|Only an order with deliveries can be closed.'));
    db.tx(() => {
      db.run("UPDATE pur_orders SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?", now(), now(), o.id);
      if (o.request_id && !db.value("SELECT COUNT(*) FROM pur_orders WHERE request_id = ? AND status NOT IN ('closed','cancelled')", o.request_id)) db.run("UPDATE pur_requests SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'ordered'", now(), o.request_id);
    });
    h.log(req, 'Closed a purchase order', 'purchase_order', o.id, o.ref);
    h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'ok', tr('pur|Order closed.'));
  });
  router.post('/purchasing/orders/:id/receive', RP, (req, res, next) => {
    const o = orderOf(h.int(req.params.id));
    if (!o) return next();
    const lines = {};
    for (const [k, v] of Object.entries(req.body)) if (/^qty_\d+$/.test(k)) lines[k.slice(4)] = h.numv(v) || 0;
    try {
      const r = receive(o.id, { date: req.body.date, delivery_note: h.str(req.body.delivery_note, 80) || null, note: h.str(req.body.note, 500) || null, lines, user: req.user });
      h.log(req, 'Received goods', 'purchase_order', o.id, `${o.ref} · ${r.ref}`);
      h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'ok', tr('pur|Delivery {ref} recorded. Stock items are in the store.', { ref: r.ref }));
    } catch (e) {
      fail(req, res, `/admin/purchasing/orders/${o.id}`, e);
    }
  });
  router.post('/purchasing/orders/:id/bill', RF, (req, res, next) => {
    const o = orderOf(h.int(req.params.id));
    if (!o) return next();
    const b = req.body;
    if (!h.str(b.vendor_ref, 60)) return h.back(req, res, `/admin/purchasing/orders/${o.id}`, 'error', tr('pur|Enter the supplier invoice number.'));
    const lines = Object.keys(b).filter((k) => /^qty_\d+$/.test(k)).map((k) => ({ order_line_id: Number(k.slice(4)), qty: h.numv(b[k]) || 0, price: h.numv(b[`price_${k.slice(4)}`]) ?? 0 }));
    try {
      const out = billOrder(o.id, { vendor_ref: h.str(b.vendor_ref, 60), date: b.date, lines, vat: b.vat === '' || b.vat === undefined ? null : h.numv(b.vat), approve: b.approve === '1', user: req.user });
      h.log(req, 'Recorded a supplier bill for a purchase order', 'purchase_order', o.id, `${o.ref} · ${out.bill.ref}`);
      h.back(req, res, `/admin/purchasing/orders/${o.id}`, out.flags.length ? 'error' : 'ok', out.flags.length
        ? tr('pur|Bill {ref} recorded, with differences to check: {list}.', { ref: out.bill.ref, list: [...new Set(out.flags.map((f) => tr(FLAGS[f.flag])))].join(', ') })
        : tr('pur|Bill {ref} recorded. It matches the order and the delivery.', { ref: out.bill.ref }));
    } catch (e) {
      fail(req, res, `/admin/purchasing/orders/${o.id}`, e);
    }
  });

  // ----- the printable order, in English and Arabic side by side -----
  const both = (key, p) => {
    const en = i18n.run('en', () => tr(key, p));
    const ar = i18n.run('ar', () => tr(key, p));
    return en === ar ? `<span class="bi">${esc(en)}</span>` : `<span class="bi"><span lang="en" dir="ltr">${esc(en)}</span><span lang="ar" dir="rtl">${esc(ar)}</span></span>`;
  };
  // ?doc=both (the default): English and Arabic side by side; ?doc=en or ?doc=ar: one language
  router.get('/purchasing/orders/:id/print', RP, (req, res, next) => {
    const o = orderOf(h.int(req.params.id));
    if (!o) return next();
    const doc = ['en', 'ar'].includes(req.query.doc) ? req.query.doc : 'both';
    const lines = db.all('SELECT * FROM pur_order_lines WHERE order_id = ? ORDER BY sort, id', o.id);
    const s = db.settings();
    const render = () => {
      const L1 = doc === 'both' ? both : (key, p) => esc(tr(key, p));
      const unitOf = (u) => (UNITS[u] ? L1(UNITS[u]) : esc(u || ''));
      const self = `/admin/purchasing/orders/${o.id}/print`;
      const switcher = [['both', 'English · العربية'], ['en', 'English'], ['ar', 'العربية']].map(([k, l]) => `<a class="btn btn--ghost${doc === k ? ' is-on' : ''}" href="${self}?doc=${k}">${l}</a>`).join('');
      const legal = doc === 'both' ? s.legal_name || '' : tx(s.legal_name) || '';
      const address = doc === 'both' ? s.address || '' : tx(s.address) || '';
      const body = `<main class="doc pur-doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${esc(tr('pur|Print or save as PDF'))}</span></button><a class="btn btn--ghost" href="/admin/purchasing/orders/${o.id}">${esc(tr('pur|Back'))}</a>${switcher}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${L1('pur|Purchase order')}</p><p class="doc__ref"><bdi>${esc(o.ref)}</bdi> · <bdi>${esc(o.order_date)}</bdi></p>${o.status === 'draft' ? `<p class="doc__ref">${L1('pur|Draft')}</p>` : ''}</div></header>
  <section class="pur-doc__parties">
    <div><p class="eyebrow">${L1('pur|Supplier')}</p><h1>${esc(o.vendor || '—')}</h1>${o.vendor_tax ? `<p>${L1('pur|Tax ID')} <bdi>${esc(o.vendor_tax)}</bdi></p>` : ''}${o.vendor_phone ? `<p><bdi>${esc(o.vendor_phone)}</bdi></p>` : ''}${o.vendor_email ? `<p><bdi>${esc(o.vendor_email)}</bdi></p>` : ''}</div>
    <div><p class="eyebrow">${L1('pur|Buyer')}</p><h1>${esc(legal)}</h1><p>${esc(address)}</p>${s.leasing_email ? `<p><bdi>${esc(s.leasing_email)}</bdi></p>` : ''}</div>
  </section>
  <table class="doc__t doc__t--terms pur-doc__facts"><tbody>
    <tr><th>${L1('pur|Order date')}</th><td><bdi>${esc(o.order_date)}</bdi></td></tr>
    ${o.delivery_date ? `<tr><th>${L1('pur|Delivery by')}</th><td><bdi>${esc(o.delivery_date)}</bdi></td></tr>` : ''}
    ${o.payment_days !== null ? `<tr><th>${L1('pur|Payment')}</th><td>${L1('pur|{n} days after the invoice', { n: o.payment_days })}</td></tr>` : ''}
    ${o.deliver_to ? `<tr><th>${L1('pur|Deliver to')}</th><td>${esc(o.deliver_to)}</td></tr>` : ''}
    ${o.dept ? `<tr><th>${L1('pur|Department')}</th><td>${esc(doc === 'both' ? o.dept : deptName(o.dept))}</td></tr>` : ''}
    ${o.request_ref ? `<tr><th>${L1('pur|Request')}</th><td><bdi>${esc(o.request_ref)}</bdi></td></tr>` : ''}
  </tbody></table>
  <table class="doc__t pur-doc__lines"><thead><tr><th>#</th><th>${L1('pur|Description')}</th><th class="num">${L1('pur|Qty')}</th><th>${L1('pur|Unit')}</th><th class="num">${L1('pur|Unit price')}</th><th class="num">${L1('pur|Amount')}</th></tr></thead>
  <tbody>${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td class="num">${esc(qtyf(l.qty))}</td><td>${unitOf(l.unit)}</td><td class="num">${amt(l.price)}</td><td class="num">${amt(r2(l.qty * l.price))}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="5">${L1('pur|Net')}</td><td class="num">${amt(o.net)}</td></tr><tr><td colspan="5">${L1('pur|VAT {pct}%', { pct: o.vat_pct })}</td><td class="num">${amt(o.vat)}</td></tr><tr><td colspan="5">${L1('pur|Total')}</td><td class="num">${ui.money(o.total)}</td></tr></tfoot></table>
  ${o.terms ? `<h2>${L1('pur|Terms')}</h2><p class="pur-doc__terms">${esc(o.terms)}</p>` : ''}
  <p class="doc__small">${L1('pur|Quote the order number {ref} on the delivery note and the invoice.', { ref: o.ref })}</p>
  <div class="doc__sign pur-doc__sign"><div><span></span><p>${L1('pur|Prepared by')}</p>${o.creator ? `<p>${esc(o.creator)}</p>` : ''}</div><div><span></span><p>${L1('pur|Approved by')}</p></div><div><span></span><p>${L1('pur|Accepted by the supplier')}</p></div></div>
  <p class="doc__foot">${esc(legal)} · ${esc(address)}</p>
</main>`;
      return ui.bare({ title: tr('pur|Purchase order {ref}', { ref: o.ref }), body, cls: 'print' });
    };
    res.type('html').send(doc === 'both' ? render() : i18n.run(doc, render));
  });

  // ----- deliveries -----
  router.get('/purchasing/receipts', RP, (req, res) => {
    const f = h.listFilters(req, { cols: { date: 'r.date' }, dateLabel: tr('pur|Received on'), sort: { date: 'r.date', amount: 'value', name: 'v.name', ref: 'r.ref' } });
    const rows = db.all(`SELECT r.*, o.ref order_ref, o.id order_id, v.name vendor, u.name by_name, (SELECT COALESCE(SUM(x.qty * l.price), 0) FROM pur_receipt_lines x JOIN pur_order_lines l ON l.id = x.order_line_id WHERE x.receipt_id = r.id) value
      FROM pur_receipts r JOIN pur_orders o ON o.id = r.order_id LEFT JOIN acc_vendors v ON v.id = o.vendor_id LEFT JOIN users u ON u.id = r.received_by
      ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''} ORDER BY ${f.order}, r.id ${['oldest', 'amount_asc', 'name'].includes(f.sortKey) ? 'ASC' : 'DESC'} LIMIT 500`, ...f.args);
    const table = ui.table([
      { label: tr('pur|Delivery'), sort: (r) => r.ref, render: (r) => `<b><bdi>${esc(r.ref)}</bdi></b>${r.delivery_note ? sub(`<bdi>${esc(r.delivery_note)}</bdi>`) : ''}` },
      { label: tr('pur|Order'), sort: (r) => r.order_ref, render: (r) => `<bdi>${esc(r.order_ref)}</bdi>${sub(esc(r.vendor || '—'))}` },
      { label: tr('pur|Received on'), sort: (r) => r.date, render: (r) => `${esc(ui.date(r.date))}${sub(esc(r.by_name || '—'))}` },
      { label: tr('pur|Value'), num: true, sort: (r) => r.value, render: (r) => amt(r2(r.value)) },
    ], rows, { empty: esc(tr('pur|No deliveries here.')), href: (r) => `/admin/purchasing/receipts/${r.id}` });
    page(req, res, { title: tr('pur|Goods received'), on: '/admin/purchasing/receipts', body: `${f.html}${ui.card(tr('pur|Goods received notes'), table)}` });
  });
  router.get('/purchasing/receipts/:id', RP, (req, res, next) => {
    const r = db.get('SELECT r.*, o.ref order_ref, v.name vendor, u.name by_name FROM pur_receipts r JOIN pur_orders o ON o.id = r.order_id LEFT JOIN acc_vendors v ON v.id = o.vendor_id LEFT JOIN users u ON u.id = r.received_by WHERE r.id = ?', h.int(req.params.id));
    if (!r) return next();
    const lines = db.all('SELECT x.*, l.description, l.unit, l.price, l.qty ordered, l.item_id, i.code FROM pur_receipt_lines x JOIN pur_order_lines l ON l.id = x.order_line_id LEFT JOIN inv_items i ON i.id = l.item_id WHERE x.receipt_id = ? ORDER BY l.sort, l.id', r.id);
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('pur|Order'))}</dt><dd><a href="/admin/purchasing/orders/${r.order_id}"><bdi>${esc(r.order_ref)}</bdi></a> · ${esc(r.vendor || '—')}</dd></div>
      <div><dt>${esc(tr('pur|Received on'))}</dt><dd>${esc(ui.date(r.date))} · ${esc(r.by_name || '—')}</dd></div>
      ${r.delivery_note ? `<div><dt>${esc(tr('pur|Delivery note number'))}</dt><dd><bdi>${esc(r.delivery_note)}</bdi></dd></div>` : ''}
      ${r.note ? `<div><dt>${esc(tr('pur|Note'))}</dt><dd>${esc(r.note)}</dd></div>` : ''}
    </dl>`;
    const table = ui.table([
      { label: tr('pur|Item'), render: (l) => `${esc(l.description)}${l.code ? sub(`<a href="/admin/purchasing/stock/${l.item_id}"><bdi>${esc(l.code)}</bdi></a> · ${esc(tr('pur|into the store'))}`) : ''}` },
      { label: tr('pur|Received'), num: true, render: (l) => `${esc(qtyf(l.qty))} ${esc(unitLabel(l.unit))}${sub(esc(tr('pur|of {n} ordered', { n: qtyf(l.ordered) })))}` },
      { label: tr('pur|Value'), num: true, render: (l) => amt(r2(l.qty * l.price)) },
    ], lines);
    page(req, res, { title: tr('pur|Delivery {ref}', { ref: r.ref }), on: '/admin/purchasing/receipts', wide: false, crumbs: [['/admin/purchasing', tr('pur|Purchasing')], ['/admin/purchasing/receipts', tr('pur|Deliveries')], [null, r.ref]], body: `<div class="stack">${ui.card(tr('pur|Goods received note'), facts, { sub: `<bdi>${esc(r.ref)}</bdi>` })}${ui.card(tr('pur|Lines'), table)}</div>` });
  });

  // ----- stock -----
  router.get('/purchasing/stock', RA, (req, res) => {
    const q = req.query;
    const cat = CATEGORIES[q.category] ? q.category : '';
    const lowOnly = q.low === '1';
    const search = h.str(q.q, 60);
    const wo = h.int(q.wo) && hasWO() ? db.get('SELECT id, ref, title FROM work_orders WHERE id = ?', h.int(q.wo)) : null;
    const where = ['i.active = 1'];
    const args = [];
    if (cat) { where.push('i.category = ?'); args.push(cat); }
    if (lowOnly) where.push('i.min_qty > 0 AND i.on_hand <= i.min_qty');
    if (search) { where.push('(i.code LIKE ? OR i.name LIKE ? OR i.name_ar LIKE ? OR i.location LIKE ?)'); args.push(...Array(4).fill(`%${search}%`)); }
    // last issued in a date range, and the sort order (by code unless chosen)
    const lastIssue = "(SELECT MAX(m.date) FROM inv_moves m WHERE m.item_id = i.id AND m.kind = 'issue')";
    const f = h.listFilters(req, {
      cols: { date: lastIssue }, dateLabel: tr('pur|Last issued'),
      sorts: [['code', 'sort|Reference', 'i.code'], ['name', 'sort|Name: A to Z', 'i.name COLLATE NOCASE, i.code'],
        ['qty_desc', 'sort|On hand: most first', 'i.on_hand DESC, i.code'], ['qty_asc', 'sort|On hand: least first', 'i.on_hand, i.code'],
        ['amount_desc', 'sort|Value: highest first', 'i.on_hand * i.avg_cost DESC, i.code'], ['newest', 'sort|Last issued: most recent', `${lastIssue} IS NULL, ${lastIssue} DESC, i.code`]],
    });
    const rows = db.all(`SELECT i.*, ${lastIssue} last_issue FROM inv_items i WHERE ${where.join(' AND ')}${f.sql} ORDER BY ${f.order}`, ...args, ...f.args);
    const all = db.all('SELECT * FROM inv_items WHERE active = 1');
    const value = r2(all.reduce((s, i) => s + i.on_hand * i.avg_cost, 0));
    const month = M.today().slice(0, 7);
    const issued = r2(-db.value("SELECT COALESCE(SUM(value), 0) FROM inv_moves WHERE kind = 'issue' AND substr(date, 1, 7) = ?", month));
    const low = all.filter(isLow);
    const kpis = [
      ui.kpi({ label: tr('pur|Stock value'), value: ui.money(value, { compact: true }), sub: esc(tn(all.length, 'pur|{n} item', 'pur|{n} items')), href: '/admin/purchasing/stock/valuation' }),
      ui.kpi({ label: tr('pur|Running low'), value: String(low.length), tone: low.length ? 'kpi--alert' : '', href: '/admin/purchasing/stock?low=1' }),
      ui.kpi({ label: tr('pur|Issued this month'), value: ui.money(issued, { compact: true }), href: '/admin/purchasing/stock/movements?kind=issue' }),
    ].join('');
    const csrf = req.session.csrf;
    const filt = `<form method="get" action="/admin/purchasing/stock" class="filters">${wo ? `<input type="hidden" name="wo" value="${wo.id}">` : ''}
      ${ui.input('q', tr('pur|Search'), search, { placeholder: tr('pur|Code, name or location') })}
      ${ui.select('category', tr('pur|Category'), Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, tr(v)])), cat, { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}
      ${ui.select('low', tr('pur|Show'), [['', tr('pur|All items')], ['1', tr('pur|Running low only')]], lowOnly ? '1' : '', { attrs: { 'data-autosubmit': '' } })}
      ${f.fields}
      <div class="filters__go">${ui.btn(esc(tr('pur|Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}${f.active || search || cat || lowOnly ? `<a class="btn btn--ghost btn--sm" href="/admin/purchasing/stock${wo ? `?wo=${wo.id}` : ''}">${esc(tr('Clear'))}</a>` : ''}</div>${f.quick}</form>`;
    const table = ui.table([
      { label: tr('pur|Item'), sort: (i) => i.code, render: (i) => `<b><bdi>${esc(i.code)}</bdi> · ${esc(itemName(i))}</b>${sub(`${esc(catLabel(i.category))}${i.location ? ` · ${esc(i.location)}` : ''}`)}` },
      { label: tr('pur|On hand'), num: true, sort: (i) => i.on_hand, render: (i) => `<b class="${isLow(i) ? 'late' : ''}">${esc(qtyf(i.on_hand))}</b> ${esc(unitLabel(i.unit))}${isLow(i) ? sub(ui.badge('low', tr('pur|Low'), 'rose')) : ''}` },
      { label: tr('pur|Minimum'), num: true, sort: (i) => i.min_qty, render: (i) => esc(qtyf(i.min_qty)) },
      { label: tr('pur|Average cost'), num: true, sort: (i) => i.avg_cost, render: (i) => amt(i.avg_cost) },
      { label: tr('pur|Value'), num: true, sort: (i) => i.on_hand * i.avg_cost, render: (i) => amt(r2(i.on_hand * i.avg_cost)) },
      { label: tr('pur|Last issued'), sort: (i) => i.last_issue || '', render: (i) => (i.last_issue ? esc(ui.date(i.last_issue)) : '—') },
    ], rows, { empty: esc(tr('pur|No items here.')), href: (i) => `/admin/purchasing/stock/${i.id}${wo ? `?wo=${wo.id}` : ''}` });
    const newForm = canBuy(req) ? ui.card(tr('pur|New item'), ui.form('/admin/purchasing/stock', csrf, `<div class="fields">
      ${ui.input('code', tr('pur|Code'), '', { required: true, placeholder: 'EL-0101' })}
      ${ui.input('name', tr('pur|Name'), '', { required: true })}
      ${ui.input('name_ar', tr('pur|Name in Arabic'), '', { attrs: { dir: 'rtl' } })}
      ${ui.select('category', tr('pur|Category'), Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, tr(v)])), 'general')}
      ${ui.select('unit', tr('pur|Unit'), Object.fromEntries(Object.entries(UNITS).map(([k, v]) => [k, tr(v)])), 'pcs')}
      ${ui.input('location', tr('pur|Location'), '', { placeholder: tr('pur|e.g. Store B1 · shelf 4') })}
      ${ui.input('min_qty', tr('pur|Minimum level'), 0, { type: 'number', min: 0, step: 'any' })}
      ${ui.input('reorder_qty', tr('pur|Reorder quantity'), 0, { type: 'number', min: 0, step: 'any' })}
      ${ui.input('opening_qty', tr('pur|Opening stock'), 0, { type: 'number', min: 0, step: 'any' })}
      ${ui.input('opening_cost', tr('pur|Opening unit cost'), 0, { type: 'number', min: 0, step: '0.01' })}
    </div>${ui.btn(esc(tr('pur|Add the item')), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' })) : '';
    const actions = [
      low.length && canAsk(req) ? ui.form('/admin/purchasing/stock/reorder', csrf, ui.btn(esc(tr('pur|Request everything running low')), { cls: 'btn--primary btn--sm', ic: 'plus' }), { cls: 'inl' }) : '',
      ui.btn(esc(tr('pur|Valuation')), { href: '/admin/purchasing/stock/valuation', cls: 'btn--ghost btn--sm', ic: 'coins' }),
    ].join('');
    page(req, res, {
      title: tr('pur|Stock'), on: '/admin/purchasing/stock', actions,
      body: `${wo ? `<div class="alert alert--ok">${esc(tr('pur|Choose the part to issue to work order {ref}: {title}', { ref: wo.ref, title: tx(wo.title) }))}</div>` : ''}<div class="kpis kpis--3">${kpis}</div><div class="apr-bar">${filt}</div><div class="grid grid--side"><div>${ui.card(tr('pur|Items'), table, { sub: esc(tn(rows.length, 'pur|{n} item', 'pur|{n} items')) })}</div><div>${newForm}</div></div>`,
    });
  });
  router.post('/purchasing/stock', RP, (req, res) => {
    const b = req.body;
    const code = h.str(b.code, 30).toUpperCase();
    const name = h.str(b.name, 120);
    if (!code || !name) return h.back(req, res, '/admin/purchasing/stock', 'error', tr('pur|Give the item a code and a name.'));
    if (db.get('SELECT id FROM inv_items WHERE code = ?', code)) return h.back(req, res, '/admin/purchasing/stock', 'error', tr('pur|That code is already used.'));
    try {
      const id = db.tx(() => {
        const iid = Number(db.run(`INSERT INTO inv_items (code, name, name_ar, unit, category, min_qty, reorder_qty, location, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          code, name, h.str(b.name_ar, 120) || null, UNITS[b.unit] ? b.unit : 'pcs', CATEGORIES[b.category] ? b.category : 'general', Math.max(0, h.numv(b.min_qty) || 0), Math.max(0, h.numv(b.reorder_qty) || 0), h.str(b.location, 80) || null, now(), now()).lastInsertRowid);
        const oq = Math.max(0, h.numv(b.opening_qty) || 0);
        if (oq > 0) move({ item_id: iid, kind: 'opening', qty: oq, unit_cost: Math.max(0, h.numv(b.opening_cost) || 0), user: req.user });
        return iid;
      });
      h.log(req, 'Added a stock item', 'stock_item', id, `${code} · ${name}`);
      h.back(req, res, `/admin/purchasing/stock/${id}`, 'ok', tr('pur|Item added.'));
    } catch (e) {
      fail(req, res, '/admin/purchasing/stock', e);
    }
  });
  // one purchase request for everything running low (or one item)
  router.post('/purchasing/stock/reorder', RA, (req, res) => {
    const only = h.int(req.body.item);
    const list = (only ? [itemOf(only)].filter(Boolean) : lowItems()).filter((i) => i.active);
    if (!list.length) return h.back(req, res, '/admin/purchasing/stock', 'ok', tr('pur|Nothing is running low.'));
    // not twice: items already on an open request or order are left out
    const busy = new Set([
      ...db.all("SELECT l.item_id FROM pur_request_lines l JOIN pur_requests r ON r.id = l.request_id WHERE r.status IN ('pending','approved') AND l.item_id IS NOT NULL").map((x) => x.item_id),
      ...db.all("SELECT l.item_id FROM pur_order_lines l JOIN pur_orders o ON o.id = l.order_id WHERE o.status IN ('draft','sent','partial') AND l.item_id IS NOT NULL").map((x) => x.item_id),
    ]);
    const todo = list.filter((i) => !busy.has(i.id));
    if (!todo.length) return h.back(req, res, '/admin/purchasing/requests', 'ok', tr('pur|Everything running low is already requested or on order.'));
    const maint = db.get("SELECT id FROM departments WHERE name LIKE '%aintenance%' OR name LIKE '%acilit%' ORDER BY sort LIMIT 1");
    try {
      const r = createRequest({
        title: todo.length === 1 ? todo[0].name : todo.map((i) => i.code).join(', ').slice(0, 200), department_id: maint ? maint.id : null, needed_by: M.addDays(M.today(), 7), source: 'reorder',
        lines: todo.map((i) => ({ item_id: i.id, description: i.name, qty: reorderQty(i), unit: i.unit, est_price: r2(i.avg_cost) })), user: req.user,
      });
      h.log(req, 'Requested low stock', 'purchase_request', r.id, `${r.ref} · ${todo.length} items`);
      h.back(req, res, `/admin/purchasing/requests/${r.id}`, 'ok', tn(todo.length, 'pur|Purchase request {ref} raised for {n} item.', 'pur|Purchase request {ref} raised for {n} items.', { ref: r.ref }));
    } catch (e) {
      fail(req, res, '/admin/purchasing/stock', e);
    }
  });
  router.get('/purchasing/stock/valuation', RA, (req, res) => {
    const rows = db.all('SELECT * FROM inv_items WHERE active = 1 ORDER BY category, code');
    const total = r2(rows.reduce((s, i) => s + i.on_hand * i.avg_cost, 0));
    const byCat = Object.keys(CATEGORIES).map((c) => ({ label: catLabel(c), value: r2(rows.filter((i) => i.category === c).reduce((s, i) => s + i.on_hand * i.avg_cost, 0)) })).filter((x) => x.value > 0);
    const l = L();
    const invAcc = l ? l.byKey('inventory') : null;
    const gl = invAcc ? r2(db.value('SELECT COALESCE(SUM(debit - credit), 0) FROM acc_lines WHERE account_id = ?', invAcc.id)) : null;
    // received but not billed yet (the bill is what puts bought stock in the books)
    const unbilled = r2(db.all("SELECT l.id, l.price, COALESCE((SELECT SUM(x.qty) FROM pur_receipt_lines x WHERE x.order_line_id = l.id), 0) rec, COALESCE((SELECT SUM(b.qty) FROM pur_bill_lines b JOIN pur_bills pb ON pb.id = b.pur_bill_id LEFT JOIN acc_bills ab ON ab.id = pb.bill_id WHERE b.order_line_id = l.id AND COALESCE(ab.status, '') NOT IN ('void','draft')), 0) bil FROM pur_order_lines l WHERE l.item_id IS NOT NULL")
      .reduce((s, x) => s + Math.max(0, x.rec - x.bil) * x.price, 0));
    const kpis = [
      ui.kpi({ label: tr('pur|Stock value'), value: ui.money(total, { compact: true }), sub: esc(tr('pur|at average cost')) }),
      ui.kpi({ label: tr('pur|In the books'), value: gl === null ? '—' : ui.money(gl, { compact: true }), sub: invAcc ? `<a href="/admin/accounting/accounts/${invAcc.id}">${esc(`${invAcc.code} · ${l.name(invAcc)}`)}</a>` : '' }),
      ui.kpi({ label: tr('pur|Received, not billed yet'), value: ui.money(unbilled, { compact: true }), sub: esc(tr('pur|enters the books with the supplier bill')) }),
    ].join('');
    const table = ui.table([
      { label: tr('pur|Item'), sort: (i) => i.code, render: (i) => `<b><bdi>${esc(i.code)}</bdi> · ${esc(itemName(i))}</b>${sub(esc(catLabel(i.category)))}` },
      { label: tr('pur|On hand'), num: true, sort: (i) => i.on_hand, render: (i) => `${esc(qtyf(i.on_hand))} ${esc(unitLabel(i.unit))}` },
      { label: tr('pur|Average cost'), num: true, sort: (i) => i.avg_cost, render: (i) => amt(i.avg_cost) },
      { label: tr('pur|Value'), num: true, sort: (i) => i.on_hand * i.avg_cost, render: (i) => amt(r2(i.on_hand * i.avg_cost)) },
      { label: tr('pur|Share'), num: true, sort: (i) => i.on_hand * i.avg_cost, render: (i) => (total ? `${((i.on_hand * i.avg_cost * 100) / total).toFixed(1)}%` : '—') },
    ], rows, { href: (i) => `/admin/purchasing/stock/${i.id}` });
    page(req, res, {
      title: tr('pur|Stock valuation'), on: '/admin/purchasing/stock', crumbs: [['/admin/purchasing', tr('pur|Purchasing')], ['/admin/purchasing/stock', tr('pur|Stock')], [null, tr('pur|Valuation')]],
      body: `<div class="kpis kpis--3">${kpis}</div><div class="grid grid--side"><div>${ui.card(tr('pur|By item'), table)}</div><div>${ui.card(tr('pur|By category'), byCat.length ? ui.donut(byCat.map((x) => ({ ...x, display: ui.money(x.value, { compact: true }) })), { label: ui.money(total, { compact: true, cur: false }) }) : `<p class="muted pad">${esc(tr('pur|Nothing in stock.'))}</p>`)}</div></div>`,
    });
  });
  router.get('/purchasing/stock/movements', RA, (req, res) => {
    const q = req.query;
    const kind = MOVES[q.kind] ? q.kind : '';
    const f = h.listFilters(req, { cols: { date: 'm.date' }, dateLabel: tr('pur|Date'), keep: ['kind'], sort: { date: 'm.date', amount: 'ABS(m.value)', name: 'i.code' } });
    const where = [...f.where];
    const args = [...f.args];
    if (kind) { where.push('m.kind = ?'); args.push(kind); }
    const rows = db.all(`SELECT m.*, i.code, i.name, i.name_ar, i.unit, u.name by_name, d.name dept ${hasWO() ? ', w.ref wo_ref, w.title wo_title' : ''}
      FROM inv_moves m JOIN inv_items i ON i.id = m.item_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN departments d ON d.id = m.department_id ${hasWO() ? 'LEFT JOIN work_orders w ON w.id = m.work_order_id' : ''}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${f.order}, m.id ${['oldest', 'amount_asc', 'name'].includes(f.sortKey) ? 'ASC' : 'DESC'} LIMIT 500`, ...args);
    const kindSel = bar('/admin/purchasing/stock/movements', f, ui.select('kind', tr('pur|Movement'), Object.fromEntries(Object.entries(MOVES).map(([k, v]) => [k, tr(v)])), kind, { blank: tr('All'), attrs: { 'data-autosubmit': '' } }));
    const table = ui.table(moveCols({ withItem: true }), rows, { empty: esc(tr('pur|No movements here.')), href: (m) => `/admin/purchasing/stock/${m.item_id}` });
    page(req, res, { title: tr('pur|Stock movements'), on: '/admin/purchasing/stock/movements', body: `${kindSel}${ui.card(tr('pur|Stock movements'), table, { sub: esc(tn(rows.length, 'pur|{n} movement', 'pur|{n} movements')) })}` });
  });
  // "Damaged · two cartons split": the chosen reason in the reader's language, the note as typed
  const reasonText = (r) => {
    const [first, ...rest] = String(r).split(' · ');
    return [ADJUST[first] ? tr(ADJUST[first]) : first, ...rest].join(' · ');
  };
  function moveCols({ withItem = false } = {}) {
    return [
      { label: tr('pur|Date'), sort: (m) => `${m.date}${String(m.id).padStart(8, '0')}`, render: (m) => esc(ui.date(m.date)) },
      ...(withItem ? [{ label: tr('pur|Item'), sort: (m) => m.code, render: (m) => `<bdi>${esc(m.code)}</bdi> · ${esc(itemName(m))}` }] : []),
      { label: tr('pur|Movement'), sort: (m) => m.kind, render: (m) => `${esc(tr(MOVES[m.kind] || m.kind))}${sub(m.work_order_id ? `<a href="/admin/maintenance/orders/${m.work_order_id}"><bdi>${esc(m.wo_ref || `#${m.work_order_id}`)}</bdi></a>${m.wo_title ? ` · ${esc(tx(m.wo_title))}` : ''}` : m.department_id ? esc(deptName(m.dept)) : m.reason ? esc(reasonText(m.reason)) : '')}` },
      { label: tr('pur|Qty'), num: true, sort: (m) => m.qty, render: (m) => `<b class="${m.qty < 0 ? 'down' : 'up'}">${m.qty > 0 ? '+' : ''}${esc(qtyf(m.qty))}</b>` },
      { label: tr('pur|Balance'), num: true, render: (m) => esc(qtyf(m.balance)) },
      { label: tr('pur|Value'), num: true, sort: (m) => m.value, render: (m) => amt(m.value) },
      { label: tr('pur|By'), render: (m) => esc(m.by_name || '—') },
    ];
  }
  router.get('/purchasing/stock/:id', RA, (req, res, next) => {
    const it = itemOf(h.int(req.params.id));
    if (!it) return next();
    const csrf = req.session.csrf;
    const moves = db.all(`SELECT m.*, i.code, i.name, i.name_ar, u.name by_name, d.name dept ${hasWO() ? ', w.ref wo_ref, w.title wo_title' : ''} FROM inv_moves m JOIN inv_items i ON i.id = m.item_id
      LEFT JOIN users u ON u.id = m.user_id LEFT JOIN departments d ON d.id = m.department_id ${hasWO() ? 'LEFT JOIN work_orders w ON w.id = m.work_order_id' : ''} WHERE m.item_id = ? ORDER BY m.date DESC, m.id DESC LIMIT 200`, it.id);
    const onOrder = r3(db.value("SELECT COALESCE(SUM(l.qty - COALESCE((SELECT SUM(x.qty) FROM pur_receipt_lines x WHERE x.order_line_id = l.id), 0)), 0) FROM pur_order_lines l JOIN pur_orders o ON o.id = l.order_id WHERE l.item_id = ? AND o.status IN ('draft','sent','partial')", it.id));
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('pur|On hand'))}</dt><dd><b class="${isLow(it) ? 'late' : ''}">${esc(qtyf(it.on_hand))} ${esc(unitLabel(it.unit))}</b>${isLow(it) ? ` ${ui.badge('low', tr('pur|Running low'), 'rose')}` : ''}</dd></div>
      <div><dt>${esc(tr('pur|Minimum level'))}</dt><dd>${esc(qtyf(it.min_qty))}${it.reorder_qty ? ` · ${esc(tr('pur|reorder {n}', { n: qtyf(it.reorder_qty) }))}` : ''}</dd></div>
      ${onOrder > 0 ? `<div><dt>${esc(tr('pur|On order'))}</dt><dd>${esc(qtyf(onOrder))} ${esc(unitLabel(it.unit))}</dd></div>` : ''}
      <div><dt>${esc(tr('pur|Average cost'))}</dt><dd>${ui.money(it.avg_cost)}</dd></div>
      <div><dt>${esc(tr('pur|Value'))}</dt><dd>${ui.money(r2(it.on_hand * it.avg_cost))}</dd></div>
      <div><dt>${esc(tr('pur|Category'))}</dt><dd>${esc(catLabel(it.category))}</dd></div>
      ${it.location ? `<div><dt>${esc(tr('pur|Location'))}</dt><dd>${esc(it.location)}</dd></div>` : ''}
    </dl>`;
    const wo = h.int(req.query.wo);
    const woOpts = workOrders(wo).map((w) => [w.id, `${w.ref} · ${tx(w.title)}`]);
    const issueCard = canBuy(req) && it.on_hand > 0 ? ui.card(tr('pur|Issue'), ui.form(`/admin/purchasing/stock/${it.id}/issue`, csrf, `<div class="fields">
      ${ui.input('qty', tr('pur|Qty'), 1, { type: 'number', min: 0, max: it.on_hand, step: 'any', required: true })}
      ${ui.input('date', tr('pur|Date'), M.today(), { type: 'date' })}
      ${ui.select('work_order_id', tr('pur|For work order'), woOpts, wo || '', { blank: tr('pur|No work order'), cls: 'span-all' })}
      ${ui.select('department_id', tr('pur|or for a department'), depts().map((d) => [d.id, deptName(d.name)]), '', { blank: tr('pur|Choose…'), cls: 'span-all' })}
      ${ui.input('reason', tr('pur|Note'), '', { cls: 'span-all' })}
    </div>${ui.btn(esc(tr('pur|Issue from the store')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }), { sub: esc(tr('pur|Charged at the average cost: {amount} each.', { amount: ui.money(it.avg_cost) })) }) : '';
    const adjustCard = canBuy(req) ? ui.card(tr('pur|Adjust'), ui.form(`/admin/purchasing/stock/${it.id}/adjust`, csrf, `<div class="fields">
      ${ui.input('qty', tr('pur|Change (+ or −)'), '', { type: 'number', step: 'any', required: true, placeholder: '-2' })}
      ${ui.input('date', tr('pur|Date'), M.today(), { type: 'date' })}
      ${ui.select('reason', tr('pur|Reason'), Object.entries(ADJUST).map(([k, v]) => [k, tr(v)]), 'Stock count', { cls: 'span-all' })}
      ${ui.input('note', tr('pur|Note'), '', { cls: 'span-all' })}
    </div>${ui.btn(esc(tr('pur|Record the adjustment')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })) : '';
    const reorder = canAsk(req) ? ui.form('/admin/purchasing/stock/reorder', csrf, `<input type="hidden" name="item" value="${it.id}">${ui.btn(esc(tr('pur|Request more')), { cls: isLow(it) ? 'btn--primary btn--sm' : 'btn--ghost btn--sm', ic: 'plus' })}`, { cls: 'inl' }) : '';
    const editCard = canBuy(req) ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${esc(tr('pur|Edit the item'))}</span></summary>${ui.form(`/admin/purchasing/stock/${it.id}`, csrf, `<div class="fields">
      ${ui.input('name', tr('pur|Name'), it.name, { required: true })}
      ${ui.input('name_ar', tr('pur|Name in Arabic'), it.name_ar || '', { attrs: { dir: 'rtl' } })}
      ${ui.select('category', tr('pur|Category'), Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, tr(v)])), it.category)}
      ${ui.select('unit', tr('pur|Unit'), Object.fromEntries(Object.entries(UNITS).map(([k, v]) => [k, tr(v)])), it.unit)}
      ${ui.input('location', tr('pur|Location'), it.location || '')}
      ${ui.input('min_qty', tr('pur|Minimum level'), it.min_qty, { type: 'number', min: 0, step: 'any' })}
      ${ui.input('reorder_qty', tr('pur|Reorder quantity'), it.reorder_qty, { type: 'number', min: 0, step: 'any' })}
      <label class="check span-all"><input type="checkbox" name="active" value="1"${it.active ? ' checked' : ''}> ${esc(tr('pur|In use'))}</label>
    </div>${ui.btn(esc(tr('pur|Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    page(req, res, {
      title: `${it.code} · ${itemName(it)}`, on: '/admin/purchasing/stock', crumbs: [['/admin/purchasing', tr('pur|Purchasing')], ['/admin/purchasing/stock', tr('pur|Stock')], [null, it.code]], actions: reorder,
      body: `<div class="grid grid--side"><div class="stack">${ui.card(itemName(it), facts, { sub: `<bdi>${esc(it.code)}</bdi>`, action: it.active ? '' : ui.badge('off', tr('pur|Not in use'), 'mute') })}${ui.card(tr('pur|Movements'), ui.table(moveCols(), moves, { empty: esc(tr('pur|No movements yet.')) }))}</div><div class="stack">${issueCard}${adjustCard}${editCard}</div></div>`,
    });
  });
  router.post('/purchasing/stock/:id', RP, (req, res, next) => {
    const it = itemOf(h.int(req.params.id));
    if (!it) return next();
    const b = req.body;
    const name = h.str(b.name, 120);
    if (!name) return h.back(req, res, `/admin/purchasing/stock/${it.id}`, 'error', tr('pur|Give the item a code and a name.'));
    db.run('UPDATE inv_items SET name = ?, name_ar = ?, category = ?, unit = ?, location = ?, min_qty = ?, reorder_qty = ?, active = ?, updated_at = ? WHERE id = ?',
      name, h.str(b.name_ar, 120) || null, CATEGORIES[b.category] ? b.category : it.category, UNITS[b.unit] ? b.unit : it.unit, h.str(b.location, 80) || null,
      Math.max(0, h.numv(b.min_qty) || 0), Math.max(0, h.numv(b.reorder_qty) || 0), b.active === '1' ? 1 : 0, now(), it.id);
    h.log(req, 'Edited a stock item', 'stock_item', it.id, it.code);
    h.back(req, res, `/admin/purchasing/stock/${it.id}`, 'ok', tr('pur|Item saved.'));
  });
  router.post('/purchasing/stock/:id/issue', RP, (req, res, next) => {
    const it = itemOf(h.int(req.params.id));
    if (!it) return next();
    const b = req.body;
    const wo = h.int(b.work_order_id) && hasWO() && db.get('SELECT id FROM work_orders WHERE id = ?', h.int(b.work_order_id)) ? h.int(b.work_order_id) : null;
    const dept = !wo && h.int(b.department_id) && db.get('SELECT id FROM departments WHERE id = ?', h.int(b.department_id)) ? h.int(b.department_id) : null;
    const qty = h.numv(b.qty) || 0;
    try {
      if (!(qty > 0)) throw new Error('pur|Enter the quantity.');
      if (qty > it.on_hand + 0.0005) throw E('pur|Only {n} on hand.', { n: qtyf(it.on_hand) });
      issue({ item_id: it.id, qty, work_order_id: wo, department_id: dept, date: dateOr(b.date), reason: h.str(b.reason, 200) || null, user: req.user });
      h.log(req, 'Issued stock', 'stock_item', it.id, `${it.code} · ${qty}${wo ? ` · WO ${wo}` : ''}`);
      h.back(req, res, h.safeBack(req, `/admin/purchasing/stock/${it.id}`), 'ok', tr('pur|Issued {qty} {unit}.', { qty: qtyf(qty), unit: unitLabel(it.unit) }));
    } catch (e) {
      fail(req, res, `/admin/purchasing/stock/${it.id}`, e);
    }
  });
  router.post('/purchasing/stock/:id/adjust', RP, (req, res, next) => {
    const it = itemOf(h.int(req.params.id));
    if (!it) return next();
    const b = req.body;
    const qty = h.numv(b.qty) || 0;
    const reason = [ADJUST[b.reason] ? b.reason : null, h.str(b.note, 200)].filter(Boolean).join(' · ');
    try {
      if (!qty) throw new Error('pur|Enter the quantity.');
      if (!reason) throw new Error('pur|Give the reason.');
      move({ item_id: it.id, kind: 'adjust', qty, date: dateOr(b.date), reason, user: req.user });
      h.log(req, 'Adjusted stock', 'stock_item', it.id, `${it.code} · ${qty} · ${reason}`);
      h.back(req, res, `/admin/purchasing/stock/${it.id}`, 'ok', tr('pur|Adjustment recorded.'));
    } catch (e) {
      fail(req, res, `/admin/purchasing/stock/${it.id}`, e);
    }
  });

  // a card for a work order's page (routes/maintenance.js can show it): the parts it used
  h.purchasing.partsCard = (req, w) => {
    const list = issuesFor(w.id);
    const cost = r2(-list.reduce((s, m) => s + m.value, 0));
    const add = canBuy(req) ? ui.btn(esc(tr('pur|Issue parts')), { href: `/admin/purchasing/stock?wo=${w.id}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '';
    const body = list.length ? `<ul class="list">${list.map((m) => `<li><a href="/admin/purchasing/stock/${m.item_id}"><span class="what"><b><bdi>${esc(m.code)}</bdi> · ${esc(itemName(m))}</b><small>${esc(ui.date(m.date))}</small></span><b>${esc(qtyf(-m.qty))} ${esc(unitLabel(m.unit))}</b><b class="num">${amt(-m.value)}</b></a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('pur|No parts used yet.'))}</p>`;
    return ui.card(tr('pur|Parts used'), body, { action: add, sub: list.length ? esc(tr('pur|{amount} at cost', { amount: ui.money(cost) })) : '' });
  };
};

module.exports.PR_STATUS = PR_STATUS;
module.exports.PO_STATUS = PO_STATUS;
module.exports.CATEGORIES = CATEGORIES;
