'use strict';

// Collections (/admin/collections): getting overdue money in.
//
//   Reminders     a schedule of steps around the due date (e.g. 7 days before, on the day, 7, 15 and
//                 30 days after), sent by email and the tenant portal (h.tenantNotify, in each portal
//                 user's language) and by WhatsApp when it is set up. Every reminder is logged and a
//                 step is never sent twice for the same invoice. A background job sends them; "Send
//                 now" sends one by hand.
//   Penalties     late payment charges: a percentage a month or a fixed amount a day, after a grace
//                 period, capped at a share of the invoice. Charged as 'penalty' invoices by hand or by
//                 the monthly job. What has been charged (or waived) is never charged again.
//   Write-offs    money that will not come in: recorded as a payment by the method 'writeoff' (in the
//                 books: other expenses against receivables), through approvals (kind 'writeoff') when
//                 a rule asks for it. Waiving a penalty is a write-off.
//   Promises      what the tenant said on the phone: an amount by a date, kept or broken.
//   Payment plans a tenant's overdue invoices spread over installments; kept or broken is worked out
//                 from the payments on those invoices. Reminders and penalties pause while a plan is
//                 kept. An installment can be backed by a cheque.
//   Legal cases   warning letter → legal notice → lawsuit → hearings → judgment → settled/closed, with
//                 the lawyer, hearing dates (alerts before each), notes and papers.
//   Dashboard     aging, who to call today, promises, DSO and the collection rate.
//
// Refunds: approvals kind 'refund' (reversing a receipt, refunding a deposit at the end of a lease)
// are decided here and handed to whoever asked: h.refunds.on(type, fn).

const i18n = require('../i18n');
const { registerDocs, uploadRoute } = require('../ops-common');

const { t: tr, tn } = i18n;

const SCHEMA = `
  CREATE TABLE col_reminders (
    id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    step INTEGER, channels TEXT, notice_id INTEGER, status TEXT NOT NULL DEFAULT 'sent', detail TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX col_reminders_step ON col_reminders(invoice_id, step) WHERE step IS NOT NULL;
  CREATE INDEX col_reminders_brand ON col_reminders(brand_id, created_at);
  CREATE TABLE col_calls (
    id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE, outcome TEXT NOT NULL, note TEXT, next_on TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX col_calls_brand ON col_calls(brand_id, created_at);
  CREATE TABLE col_promises (
    id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE, call_id INTEGER REFERENCES col_calls(id) ON DELETE SET NULL,
    amount REAL NOT NULL, due_on TEXT NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'open', closed_on TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX col_promises_brand ON col_promises(brand_id, status);
  CREATE TABLE col_penalties (
    id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, penalty_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    amount REAL NOT NULL, through_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'charged',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX col_penalties_invoice ON col_penalties(invoice_id);
  CREATE TABLE col_writeoffs (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, brand_id INTEGER,
    penalty_id INTEGER REFERENCES col_penalties(id) ON DELETE SET NULL, amount REAL NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending',
    approval_id INTEGER, payment_id INTEGER, requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE col_plans (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE, lease_id INTEGER REFERENCES leases(id) ON DELETE SET NULL,
    total REAL NOT NULL, installments INTEGER NOT NULL, first_due TEXT NOT NULL, every_months INTEGER NOT NULL DEFAULT 1, grace_days INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'active', note TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, closed_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE col_plan_invoices (plan_id INTEGER NOT NULL REFERENCES col_plans(id) ON DELETE CASCADE, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, PRIMARY KEY (plan_id, invoice_id));
  CREATE TABLE col_plan_items (
    id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES col_plans(id) ON DELETE CASCADE, n INTEGER NOT NULL, due_date TEXT NOT NULL, amount REAL NOT NULL,
    cheque_id INTEGER REFERENCES cheques(id) ON DELETE SET NULL
  );
  CREATE TABLE col_cases (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE, lease_id INTEGER REFERENCES leases(id) ON DELETE SET NULL,
    stage TEXT NOT NULL DEFAULT 'warning', status TEXT NOT NULL DEFAULT 'open', amount REAL NOT NULL DEFAULT 0, lawyer TEXT, court TEXT, case_no TEXT,
    next_hearing TEXT, opened_on TEXT NOT NULL, closed_on TEXT, outcome TEXT, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE col_case_notes (
    id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES col_cases(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL,
    on_date TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX col_case_notes_case ON col_case_notes(case_id, created_at);
`;

const OUTCOMES = { reached: 'col|Spoke to them', promised: 'col|Promised to pay', no_answer: 'col|No answer', dispute: 'col|Disputes the amount', wrong_number: 'col|Wrong number', visit: 'col|Visited the store' };
const PROMISE = { open: ['col|Waiting', 'amber'], kept: ['col|Kept', 'ok'], broken: ['col|Broken', 'rose'], cancelled: ['col|Cancelled', 'mute'] };
const PLAN = { active: ['col|On track', 'ok'], late: ['col|Behind', 'amber'], broken: ['col|Broken', 'rose'], completed: ['col|Completed', 'forest'], cancelled: ['col|Cancelled', 'mute'] };
const ITEM = { kept: ['col|Paid', 'ok'], due: ['col|Coming', 'sky'], late: ['col|Late', 'amber'], broken: ['col|Missed', 'rose'] };
const WRITEOFF = { pending: ['col|Awaiting approval', 'amber'], done: ['col|Written off', 'mute'], rejected: ['col|Not approved', 'rose'] };
const STAGES = {
  warning: 'col|Warning letter', notice: 'col|Legal notice', filed: 'col|Lawsuit filed', hearing: 'col|In hearings', judgment: 'col|Judgment', settled: 'col|Settled', closed: 'col|Closed',
};
const CLOSED_STAGES = ['settled', 'closed'];
const BUCKETS = [['current', 'col|Not due yet', null, 0], ['b30', 'col|1–30 days', 1, 30], ['b60', 'col|31–60 days', 31, 60], ['b90', 'col|61–90 days', 61, 90], ['b180', 'col|91–180 days', 91, 180], ['old', 'col|Over 180 days', 181, null]];
const DEFAULTS = {
  col_reminders_on: '1', col_steps: '-7,0,7,15,30', col_whatsapp: '1',
  col_penalty_mode: 'pct_month', col_penalty_rate: '1.5', col_penalty_grace: '15', col_penalty_cap: '10', col_penalty_auto: '0', col_penalty_vat: '0', col_penalty_min: '500',
  col_plan_grace: '5',
};

module.exports = function collections(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  db.ensure('collections-1', SCHEMA);
  const esc = ui.esc;
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const today = () => M.today();
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const dayDiff = (a, b) => Math.round((Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`)) / 864e5);
  const S = (k) => {
    const v = db.setting(k);
    return v === undefined || v === null || v === '' ? DEFAULTS[k] : String(v);
  };
  const tmap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tr(Array.isArray(v) ? v[0] : v)]));
  const badgeOf = (map, s) => ui.badge(s, tr((map[s] || [s])[0]), (map[s] || [])[1]);
  const enMoney = (n) => i18n.run('en', () => ui.money(n));
  const enDate = (d) => i18n.run('en', () => ui.date(d));
  const canMoney = (req) => h.can(req, 'manager') || h.canFinance(req);
  h.auditTyped = h.auditTyped || [];
  h.auditTyped.push('SELECT note FROM col_calls', 'SELECT note FROM col_promises', 'SELECT reason FROM col_writeoffs', 'SELECT note FROM col_plans',
    'SELECT lawyer, court, case_no, outcome FROM col_cases', 'SELECT body FROM col_case_notes');

  // a write-off and money taken from the deposit are receipts by a method of their own; they are not
  // offered on the payment form and do not count as money collected
  for (const [k, label] of [['writeoff', 'col|Written off'], ['deposit', 'col|From the deposit']]) {
    if (!Object.hasOwn(M.PAY_METHODS, k)) Object.defineProperty(M.PAY_METHODS, k, { value: label, enumerable: false, configurable: true });
  }
  const NOT_CASH = "('writeoff','deposit')";
  // in the books: a write-off is an expense, money from the deposit settles receivables against it
  function ensureMethodAccounts() {
    const L = h.ledger;
    if (!L || typeof L.S !== 'function') return;
    try {
      for (const [method, keys] of [['writeoff', ['bad_debts', 'exp_other']], ['deposit', ['deposits']]]) {
        if (L.S(`method_${method}`, '')) continue;
        const a = keys.map((k) => db.get('SELECT code FROM acc_accounts WHERE key = ?', k)).find(Boolean);
        if (a) L.setS(`method_${method}`, a.code);
      }
    } catch (e) {
      console.error('[collections] payment accounts:', e.message);
    }
  }
  h.ensureMethodAccounts = ensureMethodAccounts;

  // ---------- approvals (h.approvals, when that module is there) ----------
  const approvals = () => (h.approvals && typeof h.approvals.request === 'function' ? h.approvals : null);
  const needsApproval = (kind, amount) => {
    const A = approvals();
    try {
      return !!(A && typeof A.needs === 'function' && A.needs(kind, amount));
    } catch {
      return false;
    }
  };
  const payloadOf = (r) => {
    try {
      return (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) || {};
    } catch {
      return {};
    }
  };
  const requestId = (r) => (r && (r.id || r.request_id)) || null;
  // refunds are asked for by several modules; each says what to do once a refund is decided
  const refundHandlers = {};
  h.refunds = {
    on: (type, fn) => { refundHandlers[type] = fn; },
    needs: (amount) => needsApproval('refund', amount),
    // returns the approval request, or null when no approval is needed (do it now)
    ask: ({ type, title, amount, entity, entity_id, link, payload = {}, user, demo = 0 }) => {
      if (!needsApproval('refund', amount)) return null;
      return approvals().request({ kind: 'refund', title, amount, entity, entity_id, link, payload: { ...payload, type }, user, demo });
    },
  };
  if (approvals() && typeof h.approvals.onDecision === 'function') {
    h.approvals.onDecision('writeoff', (r, decision, user) => {
      const p = payloadOf(r);
      const w = db.get('SELECT * FROM col_writeoffs WHERE id = ? OR (approval_id IS NOT NULL AND approval_id = ?) ORDER BY id LIMIT 1', h.int(p.writeoff_id) || 0, requestId(r) || 0);
      if (!w || w.status !== 'pending') return;
      if (decision === 'approved') applyWriteoff(w, { user });
      else db.run("UPDATE col_writeoffs SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", user ? user.id : null, now(), w.id);
    });
    h.approvals.onDecision('refund', (r, decision, user) => {
      const p = payloadOf(r);
      const fn = refundHandlers[p.type];
      if (fn) fn(r, decision, user, p);
    });
    // withdrawn by the person who asked: the write-off is dropped, the refund is not made
    if (typeof h.approvals.onWithdraw === 'function') {
      h.approvals.onWithdraw('writeoff', (r, user) => {
        const p = payloadOf(r);
        db.run("UPDATE col_writeoffs SET status = 'rejected', decided_by = ?, decided_at = ? WHERE status = 'pending' AND (id = ? OR approval_id = ?)", user ? user.id : null, now(), h.int(p.writeoff_id) || 0, requestId(r) || 0);
      });
      h.approvals.onWithdraw('refund', (r, user) => {
        const p = payloadOf(r);
        const fn = refundHandlers[p.type];
        if (fn) fn(r, 'withdrawn', user, p);
      });
    }
  }
  // a receipt reversed (routes/deals.js asks for approval when a rule needs it)
  h.refunds.on('reverse_payment', (r, decision, user, p) => {
    if (decision !== 'approved') return;
    const pay = db.get('SELECT * FROM payments WHERE id = ?', h.int(p.payment_id));
    if (!pay || pay.status === 'reversed') return;
    h.billing.reversePayment(pay.id, { user, note: p.note || null });
  });

  // ---------- money owed ----------
  const OPEN = "i.status IN ('open','partial')";
  const bal = (i) => r2(i.total - i.paid);
  const invoiceOf = (id) => db.get('SELECT i.*, b.name brand_name, s.ref lease_ref FROM invoices i LEFT JOIN brands b ON b.id = i.brand_id LEFT JOIN leases s ON s.id = i.lease_id WHERE i.id = ?', id);
  const overdueOf = (brandId) => db.all(`SELECT i.*, s.ref lease_ref FROM invoices i LEFT JOIN leases s ON s.id = i.lease_id WHERE i.brand_id = ? AND ${OPEN} AND i.due_date < ? ORDER BY i.due_date, i.id`, brandId, today());
  const cashIn = (where, ...args) => r2(db.value(`SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.status = 'received' AND COALESCE(p.method, '') NOT IN ${NOT_CASH} AND ${where}`, ...args));

  function aging() {
    const t = today();
    const out = Object.fromEntries(BUCKETS.map(([k]) => [k, { amount: 0, count: 0 }]));
    for (const i of db.all(`SELECT i.total, i.paid, i.due_date FROM invoices i WHERE ${OPEN}`)) {
      const d = dayDiff(i.due_date, t);
      const b = BUCKETS.find(([k, , lo, hi]) => (k === 'current' ? d <= 0 : d >= lo && (hi === null || d <= hi)));
      if (!b) continue;
      out[b[0]].amount = r2(out[b[0]].amount + i.total - i.paid);
      out[b[0]].count++;
    }
    return out;
  }
  function stats() {
    const t = today();
    const from = M.addDays(t, -90);
    const ar = r2(db.value(`SELECT COALESCE(SUM(i.total - i.paid), 0) FROM invoices i WHERE ${OPEN} AND i.due_date <= ?`, t));
    const overdue = r2(db.value(`SELECT COALESCE(SUM(i.total - i.paid), 0) FROM invoices i WHERE ${OPEN} AND i.due_date < ?`, t));
    const billed = r2(db.value("SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status != 'void' AND due_date > ? AND due_date <= ?", from, t));
    const collected = cashIn('i.due_date > ? AND i.due_date <= ?', from, t);
    return {
      ar, overdue, billed, collected,
      dso: billed > 0 ? Math.round(ar / (billed / 90)) : null,
      rate: billed > 0 ? Math.min(1, collected / billed) : null,
      writtenOff: r2(db.value("SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'received' AND method = 'writeoff' AND substr(date, 1, 4) = ?", t.slice(0, 4))),
    };
  }

  // ---------- payment plans ----------
  const planInvoices = (planId) => db.all('SELECT i.* FROM col_plan_invoices x JOIN invoices i ON i.id = x.invoice_id WHERE x.plan_id = ? ORDER BY i.due_date, i.id', planId);
  // installments and how each stands: payments on the plan's invoices since it was agreed count
  // towards the installments in order
  function planState(p) {
    const items = db.all('SELECT x.*, c.number cheque_number, c.status cheque_status FROM col_plan_items x LEFT JOIN cheques c ON c.id = x.cheque_id WHERE x.plan_id = ? ORDER BY x.n', p.id);
    const invs = planInvoices(p.id);
    const ids = invs.map((i) => i.id);
    const paid = ids.length ? cashIn(`p.invoice_id IN (${ids.map(() => '?').join(',')}) AND p.date >= ?`, ...ids, p.created_at.slice(0, 10)) : 0;
    const t = today();
    let cum = 0;
    const rows = items.map((x) => {
      cum = r2(cum + x.amount);
      const st = paid >= cum - 0.5 ? 'kept' : x.due_date >= t ? 'due' : M.addDays(x.due_date, p.grace_days) >= t ? 'late' : 'broken';
      return { ...x, cum, state: st };
    });
    const left = r2(invs.reduce((s, i) => s + (['open', 'partial'].includes(i.status) ? i.total - i.paid : 0), 0));
    let status = p.status;
    if (!['cancelled'].includes(p.status)) {
      if (left <= 0.5 || paid >= p.total - 0.5) status = 'completed';
      else if (rows.some((x) => x.state === 'broken')) status = 'broken';
      else if (rows.some((x) => x.state === 'late')) status = 'late';
      else status = 'active';
    }
    return { items: rows, invoices: invs, paid, left, status, next: rows.find((x) => x.state !== 'kept') || null };
  }
  // invoices under a plan that is being kept: no reminders and no penalties
  const pausedByPlan = (invoiceId) => db.all("SELECT p.* FROM col_plan_invoices x JOIN col_plans p ON p.id = x.plan_id WHERE x.invoice_id = ? AND p.status IN ('active','late')", invoiceId).length > 0;
  const openCase = (brandId) => db.get("SELECT * FROM col_cases WHERE brand_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", brandId);
  const openPromise = (brandId) => db.get("SELECT * FROM col_promises WHERE brand_id = ? AND status = 'open' ORDER BY due_on LIMIT 1", brandId);

  // ---------- reminders ----------
  const steps = () => [...new Set(String(S('col_steps')).split(/[,\s]+/).map((x) => Math.round(Number(x))).filter((x) => Number.isFinite(x) && x >= -60 && x <= 365))].sort((a, b) => a - b);
  const stepLabel = (s) => (s === null || s === undefined ? tr('col|Sent by hand') : s < 0 ? tn(-s, 'col|{n} day before', 'col|{n} days before') : s === 0 ? tr('col|On the due date') : tn(s, 'col|{n} day late', 'col|{n} days late'));
  // who gets WhatsApp: the primary contact's WhatsApp or phone, else the store phone
  function phoneOf(brandId) {
    const c = db.get('SELECT whatsapp, phone FROM contacts WHERE brand_id = ? ORDER BY primary_contact DESC, id LIMIT 1', brandId);
    const b = db.get('SELECT store_phone FROM brands WHERE id = ?', brandId);
    return (c && (c.whatsapp || c.phone)) || (b && b.store_phone) || null;
  }
  const langOf = (brandId) => (db.value("SELECT lang FROM portal_users WHERE brand_id = ? AND active = 1 ORDER BY id LIMIT 1", brandId) === 'ar' ? 'ar' : 'en');
  function message(inv, step) {
    const t = today();
    const late = Math.max(0, dayDiff(inv.due_date, t));
    const params = { ref: inv.ref, amount: enMoney(bal(inv)), date: enDate(inv.due_date), iso: inv.due_date, days: late };
    if (step !== null && step < 0) return { title: 'col|Invoice {ref} is due on {date}', body: 'col|A friendly reminder: invoice {ref} for {amount} is due on {date}. You can pay in the tenant portal or by bank transfer.', params };
    if (step === 0 || (step === null && late <= 0)) return { title: 'col|Invoice {ref} is due today', body: 'col|Invoice {ref} for {amount} is due today. Thank you for paying on time.', params };
    if (step !== null && step >= 30) return { title: 'col|Final reminder: invoice {ref}', body: 'col|Invoice {ref} for {amount} is {days} days overdue. Please pay within 7 days; late payment charges apply under your lease and the matter may be passed to our lawyers.', params };
    return { title: 'col|Invoice {ref} is overdue', body: 'col|Invoice {ref} for {amount} was due on {date} and is {days} days overdue. Please pay as soon as possible, or call us to agree a date.', params };
  }
  // send one reminder (step null: by hand). Returns the log row id, or null when there was nothing to send.
  function sendReminder(inv, step, { user = null, force = false } = {}) {
    if (!inv || !['open', 'partial'].includes(inv.status) || bal(inv) < 1 || !inv.brand_id) return null;
    if (step !== null && db.get('SELECT id FROM col_reminders WHERE invoice_id = ? AND step = ?', inv.id, step)) return null;
    const m = message(inv, step);
    const channels = [];
    let noticeId = null;
    let detail = null;
    if (h.tenantNotify) {
      noticeId = h.tenantNotify(inv.brand_id, {
        kind: 'reminder', title: m.title, body: m.body, params: m.params,
        rows: [['col|Invoice', inv.ref], ['col|Amount due', m.params.amount], ['col|Due date', m.params.date]],
        link: `/portal/invoices/${inv.id}`, entity: 'invoice', entity_id: inv.id, demo: inv.demo,
      });
      channels.push('portal');
      if (db.value('SELECT COUNT(*) FROM portal_users WHERE brand_id = ? AND active = 1 AND email IS NOT NULL', inv.brand_id)) channels.push('email');
    }
    const phone = phoneOf(inv.brand_id);
    if (S('col_whatsapp') === '1' && phone && h.whatsapp && h.whatsapp.configured && h.whatsapp.configured()) {
      if (inv.demo) detail = 'WhatsApp skipped (sample data)';
      else {
        const lang = langOf(inv.brand_id);
        const text = i18n.run(lang, () => `${tr(m.title, m.params)}\n\n${tr(m.body, m.params)}`);
        Promise.resolve(h.whatsapp.sendText(phone, text)).catch((e) => console.error('[collections] WhatsApp:', e.message));
        channels.push('whatsapp');
      }
    }
    if (!force && !channels.length) return null;
    return Number(db.run('INSERT INTO col_reminders (invoice_id, brand_id, step, channels, notice_id, status, detail, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      inv.id, inv.brand_id, step, channels.join(','), noticeId, channels.length ? 'sent' : 'failed', detail || (channels.length ? null : 'No portal account or phone'), user ? user.id : null, inv.demo ? 1 : 0, now()).lastInsertRowid);
  }
  // the scheduled step of each open invoice: only the latest step that is due is sent (the earlier
  // ones, missed while the office was off, are logged as skipped)
  function runReminders({ user = null } = {}) {
    if (S('col_reminders_on') !== '1') return 0;
    const list = steps();
    if (!list.length) return 0;
    const t = today();
    let sent = 0;
    const horizon = M.addDays(t, -list[0]);
    for (const inv of db.all(`SELECT i.* FROM invoices i WHERE ${OPEN} AND i.brand_id IS NOT NULL AND i.kind != 'deposit' AND i.due_date <= ? ORDER BY i.due_date`, horizon)) {
      if (bal(inv) < 1 || pausedByPlan(inv.id) || openCase(inv.brand_id)) continue;
      const promise = openPromise(inv.brand_id);
      if (promise && promise.due_on >= t) continue;
      const late = dayDiff(inv.due_date, t);
      const due = list.filter((s) => s <= late);
      if (!due.length) continue;
      const step = due[due.length - 1];
      if (db.get('SELECT id FROM col_reminders WHERE invoice_id = ? AND step = ?', inv.id, step)) continue;
      for (const s of due.slice(0, -1)) {
        if (!db.get('SELECT id FROM col_reminders WHERE invoice_id = ? AND step = ?', inv.id, s)) db.run("INSERT INTO col_reminders (invoice_id, brand_id, step, channels, status, detail, demo, created_at) VALUES (?, ?, ?, '', 'skipped', 'Passed before it was sent', ?, ?)", inv.id, inv.brand_id, s, inv.demo ? 1 : 0, now());
      }
      if (sendReminder(inv, step, { user, force: true })) sent++;
    }
    return sent;
  }

  // ---------- penalties ----------
  const penaltyCfg = () => ({
    mode: ['pct_month', 'per_day', 'none'].includes(S('col_penalty_mode')) ? S('col_penalty_mode') : 'none',
    rate: Math.max(0, Number(S('col_penalty_rate')) || 0), grace: Math.max(0, Math.round(Number(S('col_penalty_grace')) || 0)),
    cap: Math.max(0, Number(S('col_penalty_cap')) || 0), min: Math.max(0, Number(S('col_penalty_min')) || 0),
    auto: S('col_penalty_auto') === '1', vat: S('col_penalty_vat') === '1',
  });
  // the late charge built up on an invoice so far (before what was already charged or waived)
  function accrued(inv, upTo = today()) {
    const c = penaltyCfg();
    if (c.mode === 'none' || !c.rate || ['penalty', 'deposit'].includes(inv.kind) || !['open', 'partial'].includes(inv.status)) return 0;
    const owed = bal(inv);
    if (owed < Math.max(1, c.min)) return 0;
    const start = M.addDays(inv.due_date, c.grace);
    if (upTo <= start) return 0;
    const days = dayDiff(start, upTo);
    let amt = c.mode === 'pct_month' ? (owed * c.rate / 100) * (days / 30) : c.rate * days;
    if (c.cap > 0) amt = Math.min(amt, (inv.total * c.cap) / 100);
    return r2(amt);
  }
  const charged = (invoiceId) => r2(db.value("SELECT COALESCE(SUM(amount), 0) FROM col_penalties WHERE invoice_id = ? AND status IN ('charged','waived')", invoiceId));
  const pendingPenalty = (inv) => r2(Math.max(0, accrued(inv) - charged(inv.id)));
  function chargePenalty(inv, { user = null, notify = true } = {}) {
    const amount = Math.round(pendingPenalty(inv));
    if (!(amount >= 1) || pausedByPlan(inv.id)) return null;
    const c = penaltyCfg();
    return db.tx(() => {
      const pen = h.billing.createInvoice({
        lease_id: inv.lease_id || undefined, brand_id: inv.brand_id || undefined, customer: inv.customer || undefined, kind: 'penalty',
        due_date: M.addDays(today(), 7), other: amount, note: `Late payment charge on ${inv.ref}`, source: 'penalty', source_id: inv.id,
        vat_pct: c.vat ? undefined : 0, vat_included: c.vat ? undefined : false, demo: inv.demo,
      }, { user });
      const id = Number(db.run('INSERT INTO col_penalties (invoice_id, penalty_invoice_id, amount, through_date, status, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        inv.id, pen.id, amount, today(), 'charged', user ? user.id : null, inv.demo ? 1 : 0, now()).lastInsertRowid);
      if (notify && h.tenantNotify && inv.brand_id) {
        h.tenantNotify(inv.brand_id, {
          kind: 'penalty', title: 'col|Late payment charge on {ref}', body: 'col|Invoice {ref} is still unpaid, so a late payment charge of {amount} was added under your lease ({pen}).',
          params: { ref: inv.ref, amount: enMoney(pen.total), pen: pen.ref }, rows: [['col|Invoice', pen.ref], ['col|Amount due', enMoney(pen.total)]],
          link: `/portal/invoices/${pen.id}`, entity: 'invoice', entity_id: pen.id, demo: inv.demo,
        });
      }
      return { id, invoice: pen };
    });
  }
  // the monthly run: a charge for each overdue invoice whose last charge is a month old
  function runPenalties({ user = null, force = false } = {}) {
    const c = penaltyCfg();
    if (c.mode === 'none' || (!force && !c.auto)) return 0;
    let n = 0;
    for (const inv of db.all(`SELECT i.* FROM invoices i WHERE ${OPEN} AND i.kind NOT IN ('penalty','deposit') AND i.due_date < ?`, M.addDays(today(), -c.grace))) {
      const last = db.value('SELECT MAX(through_date) FROM col_penalties WHERE invoice_id = ?', inv.id);
      if (!force && last && dayDiff(last, today()) < 28) continue;
      if (chargePenalty(inv, { user })) n++;
    }
    return n;
  }

  // ---------- write-offs ----------
  function applyWriteoff(w, { user = null } = {}) {
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', w.invoice_id);
    if (!inv) return null;
    ensureMethodAccounts();
    return db.tx(() => {
      let paymentId = null;
      const pen = w.penalty_id ? db.get('SELECT * FROM col_penalties WHERE id = ?', w.penalty_id) : null;
      // a penalty nobody paid is simply cancelled; anything else is written off as a receipt
      if (['open', 'partial'].includes(inv.status)) {
        if (pen && inv.status === 'open' && !inv.paid && w.amount >= inv.total - 0.5) h.billing.voidInvoice(inv.id, { user, note: `Waived (${w.ref})` });
        else {
          const out = h.billing.recordPayment({ invoice_id: inv.id, amount: Math.min(w.amount, bal(inv)), date: today(), method: 'writeoff', reference: w.ref, note: w.reason || 'Written off', demo: inv.demo }, { user });
          paymentId = out.payment.id;
        }
      }
      if (pen) db.run("UPDATE col_penalties SET status = 'waived' WHERE id = ?", pen.id);
      db.run("UPDATE col_writeoffs SET status = 'done', payment_id = ?, decided_by = COALESCE(decided_by, ?), decided_at = ? WHERE id = ?", paymentId, user ? user.id : null, now(), w.id);
      return db.get('SELECT * FROM col_writeoffs WHERE id = ?', w.id);
    });
  }
  // returns { writeoff, pending } — pending when it waits for approval
  function writeOff(inv, amount, reason, { user = null, penaltyId = null } = {}) {
    const amt = r2(Math.min(Number(amount) || 0, bal(inv)));
    if (!(amt > 0)) throw new Error('col|Enter the amount to write off.');
    const id = Number(db.run('INSERT INTO col_writeoffs (ref, invoice_id, brand_id, penalty_id, amount, reason, status, requested_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      db.nextRef('col_writeoffs', 'WO', 4, true), inv.id, inv.brand_id, penaltyId, amt, reason || null, 'pending', user ? user.id : null, inv.demo ? 1 : 0, now()).lastInsertRowid);
    const w = db.get('SELECT * FROM col_writeoffs WHERE id = ?', id);
    if (needsApproval('writeoff', amt)) {
      const r = approvals().request({ kind: 'writeoff', title: `${penaltyId ? 'Waive the late charge' : 'Write off'} ${inv.ref}${inv.brand_name ? ` · ${inv.brand_name}` : ''}`, amount: amt, entity: 'invoice', entity_id: inv.id, link: `/admin/invoices/${inv.id}`, payload: { writeoff_id: id }, user, demo: inv.demo });
      db.run('UPDATE col_writeoffs SET approval_id = ? WHERE id = ?', requestId(r), id);
      return { writeoff: w, pending: true };
    }
    return { writeoff: applyWriteoff(w, { user }), pending: false };
  }

  // ---------- promises ----------
  function settlePromises() {
    const t = today();
    for (const p of db.all("SELECT * FROM col_promises WHERE status = 'open'")) {
      const paid = cashIn('i.brand_id = ? AND p.date >= ?', p.brand_id, p.created_at.slice(0, 10));
      if (paid >= p.amount - 0.5) db.run("UPDATE col_promises SET status = 'kept', closed_on = ? WHERE id = ?", t, p.id);
      else if (p.due_on < t) db.run("UPDATE col_promises SET status = 'broken', closed_on = ? WHERE id = ?", t, p.id);
    }
  }
  // plans: store how each stands, and tell the tenant once when one breaks
  function refreshPlans() {
    for (const p of db.all("SELECT * FROM col_plans WHERE status IN ('active','late','broken')")) {
      const st = planState(p).status;
      if (st === p.status) continue;
      db.run('UPDATE col_plans SET status = ?, closed_at = ? WHERE id = ?', st, st === 'completed' ? now() : null, p.id);
      if (st === 'broken' && h.tenantNotify) {
        h.tenantNotify(p.brand_id, { kind: 'plan', title: 'col|Payment plan {ref} missed', body: 'col|An installment of payment plan {ref} was not paid. Please pay it now or call us; otherwise reminders and late charges start again on the invoices it covers.', params: { ref: p.ref }, link: '/portal/invoices', entity: 'col_plan', entity_id: p.id, demo: p.demo });
      }
    }
  }
  // hearings in the next 3 days: the case owner and the leasing inbox get an email once per hearing
  function hearingAlerts() {
    const t = today();
    for (const c of db.all("SELECT c.*, b.name brand_name, u.email owner_email FROM col_cases c JOIN brands b ON b.id = c.brand_id LEFT JOIN users u ON u.id = c.owner_id WHERE c.status = 'open' AND c.next_hearing IS NOT NULL AND c.next_hearing >= ? AND c.next_hearing <= ?", t, M.addDays(t, 3))) {
      if (db.get("SELECT id FROM col_case_notes WHERE case_id = ? AND kind = 'alert' AND on_date = ?", c.id, c.next_hearing)) continue;
      const to = [c.owner_email, db.setting('leasing_email')].filter(Boolean);
      if (to.length && h.mail && typeof h.mail.send === 'function' && !c.demo) {
        h.mail.send({ to: [...new Set(to)].join(','), subject: `Hearing ${c.next_hearing}: ${c.brand_name} (${c.ref})`, text: `The next hearing of ${c.ref} (${c.brand_name}${c.case_no ? `, case ${c.case_no}` : ''}${c.court ? `, ${c.court}` : ''}) is on ${c.next_hearing}.${c.lawyer ? ` Lawyer: ${c.lawyer}.` : ''}`, related: { entity: 'col_case', id: c.id } });
      }
      db.run("INSERT INTO col_case_notes (case_id, kind, body, on_date, demo, created_at) VALUES (?, 'alert', ?, ?, ?, ?)", c.id, `Hearing reminder sent for ${c.next_hearing}`, c.next_hearing, c.demo, now());
    }
  }
  function sweep() {
    settlePromises();
    refreshPlans();
    const reminders = runReminders();
    const penalties = new Date().getUTCDate() === 1 || penaltyCfg().auto ? runPenalties() : 0;
    hearingAlerts();
    return { reminders, penalties };
  }
  h.every('collections', 6 * 3600 * 1000, sweep, { first: 10 * 60 * 1000 });

  // ---------- who to call today ----------
  function worklist() {
    const t = today();
    const out = [];
    for (const b of db.all(`SELECT b.id, b.name, COALESCE(SUM(i.total - i.paid), 0) owed, MIN(i.due_date) oldest, COUNT(*) n
      FROM invoices i JOIN brands b ON b.id = i.brand_id WHERE ${OPEN} AND i.due_date < ? GROUP BY b.id HAVING owed >= 1 ORDER BY owed DESC`, t)) {
      const invs = overdueOf(b.id);
      const loose = invs.filter((i) => !pausedByPlan(i.id));
      if (!loose.length) continue;
      const promise = openPromise(b.id);
      if (promise && promise.due_on >= t) continue;
      const last = db.get('SELECT * FROM col_calls WHERE brand_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', b.id);
      if (last && last.next_on && last.next_on > t) continue;
      if (last && !last.next_on && dayDiff(last.created_at, t) < 3) continue;
      const days = dayDiff(b.oldest, t);
      const c = openCase(b.id);
      out.push({ ...b, owed: r2(b.owed), days, last, promise: db.get("SELECT * FROM col_promises WHERE brand_id = ? ORDER BY id DESC LIMIT 1", b.id), legal: c, phone: phoneOf(b.id), score: r2(b.owed) * (1 + Math.min(days, 180) / 30) });
    }
    return out.sort((a, b) => b.score - a.score);
  }
  h.count('collect', (user) => (auth(user) ? worklist().length : 0));
  function auth(user) {
    return !!user && (h.auth.allowed(user, 'manager') || user.role === 'admin' || !!user.finance);
  }

  // ---------- pages ----------
  const TABS = [['/admin/collections', 'col|Overview'], ['/admin/collections/reminders', 'col|Reminders'], ['/admin/collections/penalties', 'col|Late charges'], ['/admin/collections/plans', 'col|Payment plans'], ['/admin/collections/cases', 'col|Legal cases'], ['/admin/collections/writeoffs', 'col|Write-offs'], ['/admin/collections/settings', 'col|Settings']];
  const tabs = (on) => `<nav class="tabs">${TABS.map(([href, l]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${esc(tr(l))}</a>`).join('')}</nav>`;
  const page = (req, res, { title, on, body, crumbs, actions }) => h.page(req, res, { title, active: '/admin/collections', wide: true, crumbs, actions, body: `${on ? tabs(on) : ''}${body}` });
  const tenantLink = (id, name) => `<a href="/admin/collections/tenants/${id}"><b>${esc(name)}</b></a>`;
  const daysLate = (d) => (d > 0 ? `<span class="late">${esc(tn(d, 'col|{n} day late', 'col|{n} days late'))}</span>` : esc(tr('col|Not due yet')));
  const invLink = (i) => `<a href="/admin/invoices/${i.id}"><bdi>${esc(i.ref)}</bdi></a>`;

  router.get('/collections', (req, res) => {
    settlePromises();
    const st = stats();
    const ag = aging();
    const total = Object.values(ag).reduce((s, x) => s + x.amount, 0);
    const work = worklist();
    const t = today();
    const promises = db.all("SELECT p.*, b.name brand_name FROM col_promises p JOIN brands b ON b.id = p.brand_id WHERE p.status = 'open' ORDER BY p.due_on LIMIT 30");
    const broken = db.all("SELECT p.*, b.name brand_name FROM col_promises p JOIN brands b ON b.id = p.brand_id WHERE p.status = 'broken' AND p.closed_on >= ? ORDER BY p.closed_on DESC LIMIT 10", M.addDays(t, -30));
    const plans = db.all("SELECT p.*, b.name brand_name FROM col_plans p JOIN brands b ON b.id = p.brand_id WHERE p.status IN ('active','late','broken') ORDER BY p.status = 'broken' DESC, p.id DESC LIMIT 12");
    const hearings = db.all("SELECT c.*, b.name brand_name FROM col_cases c JOIN brands b ON b.id = c.brand_id WHERE c.status = 'open' AND c.next_hearing >= ? AND c.next_hearing <= ? ORDER BY c.next_hearing", t, M.addDays(t, 21));
    const kpis = [
      ui.kpi({ label: tr('col|Overdue now'), value: ui.money(st.overdue, { compact: true }), tone: st.overdue ? 'kpi--alert' : '', sub: esc(tr('col|of {amount} owed today', { amount: ui.money(st.ar, { compact: true }) })) }),
      ui.kpi({ label: tr('col|Days sales outstanding'), value: st.dso === null ? '—' : esc(tn(st.dso, 'col|{n} day', 'col|{n} days')), sub: esc(tr('col|Owed ÷ average daily billing, last 90 days')) }),
      ui.kpi({ label: tr('col|Collection rate'), value: st.rate === null ? '—' : ui.pct(st.rate), bar: st.rate, sub: esc(tr('col|{amount} in of {billed} billed, last 90 days', { amount: ui.money(st.collected, { compact: true }), billed: ui.money(st.billed, { compact: true }) })) }),
      ui.kpi({ label: tr('col|To call today'), value: String(work.length), sub: esc(tn(promises.length, 'col|{n} promise waiting', 'col|{n} promises waiting')) }),
      ui.kpi({ label: tr('col|Written off this year'), value: ui.money(st.writtenOff, { compact: true }), href: '/admin/collections/writeoffs' }),
    ].join('');
    const agingRows = BUCKETS.map(([k, l]) => `<tr><td>${esc(tr(l))}</td><td class="num">${ag[k].count}</td><td class="num">${ui.money(ag[k].amount, { cur: false })}</td><td class="col-agebar">${ui.meter(total ? ag[k].amount / total : 0, k === 'current' ? 'forest' : ['b30', 'b60'].includes(k) ? 'amber' : 'rose')}</td></tr>`).join('');
    const agingCard = ui.card(tr('col|Aging'), `<div class="tablewrap"><table class="table table--fin"><thead><tr><th>${esc(tr('col|Overdue by'))}</th><th class="num">${esc(tr('Invoices'))}</th><th class="num">${esc(tr('col|Owed'))}</th><th></th></tr></thead><tbody>${agingRows}</tbody><tfoot><tr><td>${esc(tr('Total'))}</td><td class="num">${Object.values(ag).reduce((s, x) => s + x.count, 0)}</td><td class="num"><b>${ui.money(total, { cur: false })}</b></td><td></td></tr></tfoot></table></div>`, { sub: esc(tr('col|Every open invoice by how late it is.')), action: ui.btn(esc(tr('col|Aging by tenant')), { href: '/admin/collections/aging', cls: 'btn--ghost btn--sm' }) });
    const workTable = ui.table([
      { label: tr('Tenant'), render: (w) => `${tenantLink(w.id, w.name)}${w.phone ? `<small class="sub ltr">${esc(w.phone)}</small>` : ''}` },
      { label: tr('col|Overdue'), num: true, sort: (w) => w.owed, render: (w) => `<b>${ui.money(w.owed, { cur: false })}</b><small class="sub">${esc(tn(w.n, '{n} invoice', '{n} invoices'))}</small>` },
      { label: tr('col|Oldest'), sort: (w) => w.days, render: (w) => daysLate(w.days) },
      { label: tr('col|Last contact'), render: (w) => (w.last ? `${esc(tr(OUTCOMES[w.last.outcome] || w.last.outcome))}<small class="sub">${esc(ui.rel(w.last.created_at))}</small>` : `<span class="muted">${esc(tr('col|Never called'))}</span>`) },
      { label: tr('col|Promise'), render: (w) => (w.promise ? `${badgeOf(PROMISE, w.promise.status)}<small class="sub">${esc(ui.money(w.promise.amount, { compact: true }))} · ${esc(ui.date(w.promise.due_on))}</small>` : '—') },
      { label: '', render: (w) => (w.legal ? ui.badge('legal', tr(STAGES[w.legal.stage]), 'cocoa') : '') },
    ], work, { empty: esc(tr('col|Nobody to call today. Everyone overdue has a promise, a plan or a follow-up date.')), href: (w) => `/admin/collections/tenants/${w.id}` });
    const promiseList = promises.length ? `<ul class="list">${promises.map((p) => `<li><a href="/admin/collections/tenants/${p.brand_id}"><span class="what"><b>${esc(p.brand_name)}</b><small>${esc(ui.date(p.due_on))} · ${esc(ui.rel(p.due_on))}${p.note ? ` · ${esc(p.note)}` : ''}</small></span><b>${ui.money(p.amount, { compact: true })}</b>${p.due_on < t ? badgeOf(PROMISE, 'broken') : badgeOf(PROMISE, 'open')}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('col|No promises waiting.'))}</p>`;
    const brokenList = broken.length ? `<ul class="list">${broken.map((p) => `<li><a href="/admin/collections/tenants/${p.brand_id}"><span class="what"><b>${esc(p.brand_name)}</b><small>${esc(tr('col|Promised {amount} by {date}', { amount: ui.money(p.amount, { compact: true }), date: ui.date(p.due_on) }))}</small></span>${badgeOf(PROMISE, 'broken')}</a></li>`).join('')}</ul>` : '';
    const planList = plans.length ? `<ul class="list">${plans.map((p) => `<li><a href="/admin/collections/plans/${p.id}"><span class="what"><b>${esc(p.brand_name)}</b><small><bdi>${esc(p.ref)}</bdi> · ${esc(tn(p.installments, 'col|{n} installment', 'col|{n} installments'))}</small></span><b>${ui.money(p.total, { compact: true })}</b>${badgeOf(PLAN, p.status)}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('col|No payment plans running.'))}</p>`;
    const hearingList = hearings.length ? `<ul class="list">${hearings.map((c) => `<li class="${c.next_hearing <= M.addDays(t, 3) ? 'is-late' : ''}"><a href="/admin/collections/cases/${c.id}"><span class="when"><b>${esc(c.next_hearing.slice(8, 10))}</b><small>${esc(ui.monthName(Number(c.next_hearing.slice(5, 7))))}</small></span><span class="what"><b>${esc(c.brand_name)}</b><small>${esc([c.court, c.case_no, c.lawyer].filter(Boolean).join(' · '))}</small></span>${ui.badge(c.stage, tr(STAGES[c.stage]), 'cocoa')}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('col|No hearings in the next three weeks.'))}</p>`;
    const run = canMoney(req) ? `<div class="row">${ui.form('/admin/collections/reminders/run', req.session.csrf, ui.btn(esc(tr('col|Send due reminders now')), { cls: 'btn--ghost btn--sm', ic: 'mail' }))}</div>` : '';
    page(req, res, {
      title: tr('col|Collections'), on: '/admin/collections', actions: run,
      body: `<div class="kpis kpis--5">${kpis}</div><div class="grid grid--side"><div class="stack">${ui.card(tr('col|Who to call today'), workTable, { sub: esc(tr('col|Overdue tenants without a promise, a plan being kept or a later follow-up, biggest and oldest first.')) })}${agingCard}</div>
        <div class="stack">${ui.card(tr('col|Promises to pay'), promiseList)}${brokenList ? ui.card(tr('col|Broken promises, last 30 days'), brokenList) : ''}${ui.card(tr('col|Payment plans'), planList, { action: ui.btn(esc(tr('All')), { href: '/admin/collections/plans', cls: 'btn--ghost btn--sm' }) })}${ui.card(tr('col|Upcoming hearings'), hearingList)}</div></div>`,
    });
  });

  // aging by tenant (and a CSV)
  // the aging list's filters: a range on the invoices' due date (those outside it are left out), and the order
  const agingFilters = (req) => h.listFilters(req, {
    cols: { date: 'i.due_date' }, dateLabel: tr('Due'),
    sorts: [['overdue', 'sort|Overdue: highest first', ''], ['total', 'sort|Total: highest first', ''], ['total_asc', 'sort|Total: lowest first', ''], ['name', 'sort|Name: A to Z', ''], ['name_desc', 'sort|Name: Z to A', '']],
  });
  function agingByTenant(f = { where: [], args: [], sortKey: 'overdue' }) {
    const t = today();
    const rows = new Map();
    for (const i of db.all(`SELECT i.total, i.paid, i.due_date, i.brand_id, COALESCE(b.name, i.customer, '—') name FROM invoices i LEFT JOIN brands b ON b.id = i.brand_id WHERE ${[OPEN, ...f.where].join(' AND ')}`, ...f.args)) {
      const key = i.brand_id || `c:${i.name}`;
      if (!rows.has(key)) rows.set(key, { id: i.brand_id, name: i.name, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0])), total: 0 });
      const r = rows.get(key);
      const d = dayDiff(i.due_date, t);
      const b = BUCKETS.find(([k, , lo, hi]) => (k === 'current' ? d <= 0 : d >= lo && (hi === null || d <= hi)));
      r[b[0]] = r2(r[b[0]] + i.total - i.paid);
      r.total = r2(r.total + i.total - i.paid);
    }
    const by = {
      overdue: (a, b) => b.overdue - a.overdue || b.total - a.total,
      total: (a, b) => b.total - a.total,
      total_asc: (a, b) => a.total - b.total,
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
      name_desc: (a, b) => String(b.name).localeCompare(String(a.name)),
    };
    return [...rows.values()].map((r) => ({ ...r, overdue: r2(r.total - r.current) })).sort(by[f.sortKey] || by.overdue);
  }
  router.get('/collections/aging', (req, res) => {
    const f = agingFilters(req);
    const rows = agingByTenant(f);
    const fq = ['from', 'to', 'sort'].filter((k) => req.query[k]).map((k) => `${k}=${encodeURIComponent(req.query[k])}`).join('&');
    const table = ui.table([
      { label: tr('Tenant'), render: (r) => (r.id ? tenantLink(r.id, r.name) : esc(r.name)) },
      ...BUCKETS.map(([k, l]) => ({ label: tr(l), num: true, sort: (r) => r[k], render: (r) => (r[k] ? `<span class="${k !== 'current' && ['b90', 'b180', 'old'].includes(k) ? 'late' : ''}">${ui.money(r[k], { cur: false })}</span>` : '—') })),
      { label: tr('Total'), num: true, sort: (r) => r.total, render: (r) => `<b>${ui.money(r.total, { cur: false })}</b>` },
    ], rows, { empty: esc(tr('col|Nothing is owed.')), href: (r) => (r.id ? `/admin/collections/tenants/${r.id}` : null) });
    page(req, res, { title: tr('col|Aging by tenant'), on: '/admin/collections', crumbs: [['/admin/collections', tr('col|Collections')], [null, tr('col|Aging by tenant')]], actions: ui.btn(esc(tr('col|Download CSV')), { href: `/admin/collections/aging.csv${fq ? `?${fq}` : ''}`, cls: 'btn--ghost', ic: 'dl' }), body: `${f.html}${ui.card(tr('col|Aging by tenant'), table)}` });
  });
  router.get('/collections/aging.csv', (req, res) => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Tenant', ...BUCKETS.map(([, l]) => i18n.run('en', () => tr(l))), 'Total'].map(q).join(',')];
    for (const r of agingByTenant(agingFilters(req))) lines.push([r.name, ...BUCKETS.map(([k]) => r[k]), r.total].map(q).join(','));
    res.set('Content-Disposition', `attachment; filename="aging-${today()}.csv"`).type('text/csv').send(`﻿${lines.join('\n')}\n`);
  });

  // ---------- one tenant ----------
  router.get('/collections/tenants/:id', (req, res, next) => {
    const b = db.get('SELECT * FROM brands WHERE id = ?', h.int(req.params.id));
    if (!b) return next();
    const csrf = req.session.csrf;
    const t = today();
    const open = db.all(`SELECT i.*, s.ref lease_ref FROM invoices i LEFT JOIN leases s ON s.id = i.lease_id WHERE i.brand_id = ? AND ${OPEN} ORDER BY i.due_date, i.id`, b.id);
    const overdue = open.filter((i) => i.due_date < t);
    const owed = r2(overdue.reduce((s, i) => s + bal(i), 0));
    const calls = db.all('SELECT c.*, u.name user_name FROM col_calls c LEFT JOIN users u ON u.id = c.user_id WHERE c.brand_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 40', b.id);
    const promises = db.all('SELECT * FROM col_promises WHERE brand_id = ? ORDER BY id DESC LIMIT 20', b.id);
    const reminders = db.all('SELECT r.*, i.ref FROM col_reminders r JOIN invoices i ON i.id = r.invoice_id WHERE r.brand_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 30', b.id);
    const plans = db.all('SELECT * FROM col_plans WHERE brand_id = ? ORDER BY id DESC', b.id);
    const cases = db.all('SELECT * FROM col_cases WHERE brand_id = ? ORDER BY id DESC', b.id);
    const contacts = db.all('SELECT * FROM contacts WHERE brand_id = ? ORDER BY primary_contact DESC, name', b.id);
    const may = canMoney(req);
    // what is late or falls due in the next 45 days; the rest of the term is in billing
    const shown = open.filter((i) => i.due_date <= M.addDays(t, 45));
    const invTable = ui.table([
      { label: tr('Invoice'), render: (i) => `${invLink(i)}<small class="sub">${esc(M.INVOICE_KINDS[i.kind] || i.kind)}${i.lease_ref ? ` · ${esc(i.lease_ref)}` : ''}</small>` },
      { label: tr('Due'), sort: (i) => i.due_date, render: (i) => `${esc(ui.date(i.due_date))}<small class="sub">${daysLate(dayDiff(i.due_date, t))}</small>` },
      { label: tr('col|Owed'), num: true, sort: (i) => bal(i), render: (i) => `<b>${ui.money(bal(i), { cur: false })}</b>` },
      { label: tr('col|Late charge'), num: true, render: (i) => { const p = pendingPenalty(i); return p >= 1 ? ui.money(p, { cur: false }) : '—'; } },
      { label: tr('col|Reminders'), render: (i) => { const n = db.value("SELECT COUNT(*) FROM col_reminders WHERE invoice_id = ? AND status = 'sent'", i.id); return n ? esc(tn(n, 'col|{n} sent', 'col|{n} sent')) : '—'; } },
      ...(may ? [{ label: '', render: (i) => `<div class="row col-acts">${ui.form(`/admin/collections/invoices/${i.id}/remind`, csrf, ui.btn(esc(tr('col|Remind')), { cls: 'btn--ghost btn--xs', ic: 'mail' }))}${pendingPenalty(i) >= 1 ? ui.form(`/admin/collections/invoices/${i.id}/penalty`, csrf, ui.btn(esc(tr('col|Charge')), { cls: 'btn--ghost btn--xs', ic: 'percent', attrs: { 'data-confirm': tr('col|Add a late payment charge of {amount}?', { amount: ui.money(Math.round(pendingPenalty(i))) }) } })) : ''}</div>` }] : []),
    ], shown, { empty: esc(tr('col|Nothing owed. Every invoice is paid.')) });
    const later = open.length - shown.length;
    const more = later ? `<p class="muted small pad">${esc(tn(later, 'col|{n} more invoice falls due later.', 'col|{n} more invoices fall due later.'))} <a href="/admin/billing?brand=${b.id}">${esc(tr('col|See them in billing'))}</a></p>` : '';
    const tl = calls.map((c) => `<li class="tl"><span class="tl__ic">${ui.icon(c.outcome === 'visit' ? 'store' : 'phone')}</span><div class="tl__body"><p><b>${esc(tr(OUTCOMES[c.outcome] || c.outcome))}</b>${c.next_on ? ` · <span class="muted">${esc(tr('col|Follow up {date}', { date: ui.date(c.next_on) }))}</span>` : ''}</p>${c.note ? `<p class="tl__text">${esc(c.note)}</p>` : ''}<p class="tl__meta">${esc([c.user_name, ui.dt(c.created_at)].filter(Boolean).join(' · '))}</p></div></li>`).join('');
    const callForm = may ? ui.form(`/admin/collections/tenants/${b.id}/call`, csrf, `<div class="fields">
      ${ui.select('outcome', tr('col|Outcome'), tmap(OUTCOMES), 'reached')}
      ${ui.input('next_on', tr('col|Follow up on'), M.addDays(t, 3), { type: 'date' })}
      ${ui.input('promise_amount', tr('col|Promised amount'), '', { type: 'number', min: 0, step: '0.01', placeholder: owed ? String(owed) : '' })}
      ${ui.input('promise_on', tr('col|Promised by'), '', { type: 'date' })}
      ${ui.textarea('note', tr('col|What was said'), '', { rows: 2, cls: 'span-all' })}
    </div>${ui.btn(esc(tr('col|Log the call')), { cls: 'btn--primary btn--sm', ic: 'phone' })}`, { cls: 'stack' }) : '';
    const promiseList = promises.length ? `<ul class="list">${promises.map((p) => `<li><span class="what"><b>${esc(tr('col|{amount} by {date}', { amount: ui.money(p.amount), date: ui.date(p.due_on) }))}</b><small>${esc([p.note, ui.dt(p.created_at)].filter(Boolean).join(' · '))}</small></span>${badgeOf(PROMISE, p.status)}${p.status === 'open' && may ? ui.form(`/admin/collections/promises/${p.id}/cancel`, csrf, ui.btn(esc(tr('col|Cancel')), { cls: 'btn--ghost btn--xs' })) : ''}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('col|No promises yet.'))}</p>`;
    const remList = reminders.length ? `<ul class="list">${reminders.map((r) => `<li><span class="what"><b><bdi>${esc(r.ref)}</bdi> · ${esc(stepLabel(r.step))}</b><small>${esc([ui.dt(r.created_at), (r.channels || '').split(',').filter(Boolean).map((c) => tr(`col|ch_${c}`)).join(' + ')].filter(Boolean).join(' · '))}</small></span>${r.status === 'sent' ? (r.notice_id && h.noticeSeen && h.seenBadge ? h.seenBadge((h.noticeSeen(r.notice_id) || {}).seen) : ui.badge('sent', tr('col|Sent'), 'ok')) : ui.badge(r.status, tr(r.status === 'skipped' ? 'col|Skipped' : 'col|Not sent'), 'mute')}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('col|No reminders sent yet.'))}</p>`;
    // a plan for the overdue invoices that are not under one already
    const free = open.filter((i) => !db.get("SELECT 1 FROM col_plan_invoices x JOIN col_plans p ON p.id = x.plan_id WHERE x.invoice_id = ? AND p.status IN ('active','late','broken')", i.id));
    const planForm = may && free.length ? `<details class="pop-block"><summary class="btn btn--ghost btn--sm">${ui.icon('plus')}<span>${esc(tr('col|New payment plan'))}</span></summary>${ui.form(`/admin/collections/tenants/${b.id}/plans`, csrf, `<fieldset class="col-pick"><legend>${esc(tr('col|Invoices it covers'))}</legend>${free.map((i) => `<label class="check"><input type="checkbox" name="inv" value="${i.id}"${i.due_date < t ? ' checked' : ''}><span><bdi>${esc(i.ref)}</bdi> · ${esc(ui.date(i.due_date))} · <b>${ui.money(bal(i))}</b></span></label>`).join('')}</fieldset>
      <div class="fields">${ui.input('installments', tr('col|Installments'), 3, { type: 'number', min: 1, max: 36, required: true })}${ui.input('first_due', tr('col|First installment'), M.addDays(t, 7), { type: 'date', required: true })}${ui.select('every', tr('col|Every'), { 1: tr('col|Month'), 2: tr('col|Two months'), 3: tr('col|Quarter') }, 1)}${ui.input('grace', tr('col|Grace days'), S('col_plan_grace'), { type: 'number', min: 0, max: 30 })}${ui.input('note', tr('col|Note'), '', { cls: 'span-all' })}</div>
      ${ui.btn(esc(tr('col|Agree the plan')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const planList = plans.length ? `<ul class="list">${plans.map((p) => `<li><a href="/admin/collections/plans/${p.id}"><span class="what"><b><bdi>${esc(p.ref)}</bdi></b><small>${esc(tn(p.installments, 'col|{n} installment', 'col|{n} installments'))} · ${esc(ui.date(p.first_due))}</small></span><b>${ui.money(p.total, { compact: true })}</b>${badgeOf(PLAN, p.status)}</a></li>`).join('')}</ul>` : '';
    const caseList = cases.length ? `<ul class="list">${cases.map((c) => `<li><a href="/admin/collections/cases/${c.id}"><span class="what"><b><bdi>${esc(c.ref)}</bdi> · ${esc(tr(STAGES[c.stage]))}</b><small>${esc([c.lawyer, c.next_hearing ? tr('col|Hearing {date}', { date: ui.date(c.next_hearing) }) : null].filter(Boolean).join(' · '))}</small></span><b>${ui.money(c.amount, { compact: true })}</b>${c.status === 'open' ? ui.badge('open', tr('col|Open'), 'cocoa') : ui.badge('closed', tr('col|Closed'), 'mute')}</a></li>`).join('')}</ul>` : '';
    const caseForm = may && !cases.some((c) => c.status === 'open') && owed ? `<details class="pop-block"><summary class="btn btn--ghost btn--sm">${ui.icon('contract')}<span>${esc(tr('col|Open a legal case'))}</span></summary>${ui.form(`/admin/collections/tenants/${b.id}/cases`, csrf, `<div class="fields">${ui.select('stage', tr('col|Stage'), tmap(STAGES), 'warning')}${ui.input('amount', tr('col|Amount claimed'), owed, { type: 'number', min: 0, step: '0.01' })}${ui.input('lawyer', tr('col|Lawyer'), '')}${ui.select('owner_id', tr('col|Followed by'), h.users().map((u) => [u.id, u.name]), req.user.id)}</div>${ui.btn(esc(tr('col|Open the case')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const who = contacts.length ? `<ul class="list">${contacts.slice(0, 4).map((c) => `<li><span class="what"><b>${esc(c.name)}${c.primary_contact ? ` · ${esc(tr('col|Main contact'))}` : ''}</b><small class="ltr">${esc([c.phone, c.whatsapp && c.whatsapp !== c.phone ? `WA ${c.whatsapp}` : null, c.email].filter(Boolean).join(' · '))}</small></span>${c.phone ? `<a class="btn btn--ghost btn--xs" href="tel:${esc(String(c.phone).replace(/\s+/g, ''))}">${ui.icon('phone')}</a>` : ''}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(b.store_phone ? b.store_phone : tr('col|No contacts on file.'))}</p>`;
    const kpis = [
      ui.kpi({ label: tr('col|Overdue now'), value: ui.money(owed, { compact: true }), tone: owed ? 'kpi--alert' : '', sub: esc(tn(overdue.length, '{n} invoice', '{n} invoices')) }),
      ui.kpi({ label: tr('col|Owed in total'), value: ui.money(r2(open.reduce((s, i) => s + bal(i), 0)), { compact: true }), sub: esc(tr('col|including what is not due yet')) }),
      ui.kpi({ label: tr('col|Paid in the last 90 days'), value: ui.money(cashIn('i.brand_id = ? AND p.date >= ?', b.id, M.addDays(t, -90)), { compact: true }) }),
      ui.kpi({ label: tr('col|Promises kept'), value: (() => { const done = promises.filter((p) => ['kept', 'broken'].includes(p.status)); return done.length ? `${promises.filter((p) => p.status === 'kept').length}/${done.length}` : '—'; })() }),
    ].join('');
    page(req, res, {
      title: b.name, crumbs: [['/admin/collections', tr('col|Collections')], [null, b.name]],
      actions: ui.btn(esc(tr('col|Tenant file')), { href: `/admin/tenants/${b.id}`, cls: 'btn--ghost', ic: 'tenant' }),
      body: `<div class="kpis kpis--4">${kpis}</div><div class="grid grid--side"><div class="stack">${ui.card(tr('col|Open invoices'), `${invTable}${more}`, { sub: esc(tr('col|Late charges shown are what has built up and not been charged yet.')) })}${ui.card(tr('col|Calls and visits'), `${tl ? `<ul class="timeline">${tl}</ul>` : `<p class="muted pad">${esc(tr('col|No calls logged yet.'))}</p>`}`)}${ui.card(tr('col|Reminders sent'), remList)}</div>
        <div class="stack">${ui.card(tr('col|Who to call'), who)}${callForm ? ui.card(tr('col|Log a call'), callForm) : ''}${ui.card(tr('col|Promises to pay'), promiseList)}${ui.card(tr('col|Payment plans'), `${planList}${planForm || (planList ? '' : `<p class="muted pad">${esc(tr('col|No payment plans.'))}</p>`)}`)}${ui.card(tr('col|Legal'), `${caseList}${caseForm || (caseList ? '' : `<p class="muted pad">${esc(tr('col|No legal cases.'))}</p>`)}`)}</div></div>`,
    });
  });

  router.post('/collections/tenants/:id/call', R('agent'), (req, res, next) => {
    const b = db.get('SELECT * FROM brands WHERE id = ?', h.int(req.params.id));
    if (!b) return next();
    const back = `/admin/collections/tenants/${b.id}`;
    if (!canMoney(req)) return h.back(req, res, back, 'error', tr('Your role does not allow that.'));
    const outcome = OUTCOMES[req.body.outcome] ? req.body.outcome : 'reached';
    const amount = r2(h.numv(req.body.promise_amount));
    const promiseOn = isDate(req.body.promise_on) ? req.body.promise_on : null;
    if ((amount > 0) !== !!promiseOn) return h.back(req, res, back, 'error', tr('col|A promise needs both the amount and the date.'));
    const note = h.str(req.body.note, 1000) || null;
    db.tx(() => {
      const cid = Number(db.run('INSERT INTO col_calls (brand_id, outcome, note, next_on, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', b.id, amount > 0 ? 'promised' : outcome, note, isDate(req.body.next_on) ? req.body.next_on : promiseOn, req.user.id, now()).lastInsertRowid);
      if (amount > 0) {
        db.run("UPDATE col_promises SET status = 'cancelled', closed_on = ? WHERE brand_id = ? AND status = 'open'", today(), b.id);
        db.run('INSERT INTO col_promises (brand_id, call_id, amount, due_on, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', b.id, cid, amount, promiseOn, note, req.user.id, now());
        // the next call is the day after the promised date
        db.run('UPDATE col_calls SET next_on = ? WHERE id = ?', M.addDays(promiseOn, 1), cid);
      }
    });
    h.log(req, 'Logged a collection call', 'brand', b.id, `${b.name} · ${outcome}${amount ? ` · promised ${amount} by ${promiseOn}` : ''}`);
    h.back(req, res, back, 'ok', amount > 0 ? tr('col|Promise recorded. Reminders pause until {date}.', { date: ui.date(promiseOn) }) : tr('col|Call logged.'));
  });
  router.post('/collections/promises/:id/cancel', R('agent'), (req, res, next) => {
    const p = db.get('SELECT * FROM col_promises WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    if (p.status === 'open' && canMoney(req)) db.run("UPDATE col_promises SET status = 'cancelled', closed_on = ? WHERE id = ?", today(), p.id);
    h.back(req, res, `/admin/collections/tenants/${p.brand_id}`, 'ok', tr('Saved.'));
  });

  // ---------- one invoice: remind, charge, write off (also on the invoice page) ----------
  router.post('/collections/invoices/:id/remind', R('agent'), (req, res, next) => {
    const inv = invoiceOf(h.int(req.params.id));
    if (!inv) return next();
    const back = String(req.get('referer') || '').includes('/admin/invoices/') ? `/admin/invoices/${inv.id}` : inv.brand_id ? `/admin/collections/tenants/${inv.brand_id}` : '/admin/collections';
    if (!canMoney(req)) return h.back(req, res, back, 'error', tr('Your role does not allow that.'));
    const id = sendReminder(inv, null, { user: req.user });
    if (!id) return h.back(req, res, back, 'error', tr('col|Nothing to send: the invoice is paid, or the tenant has no portal account or phone.'));
    h.log(req, 'Sent a payment reminder', 'invoice', inv.id, inv.ref);
    h.back(req, res, back, 'ok', tr('col|Reminder sent.'));
  });
  router.post('/collections/invoices/:id/penalty', R('manager'), (req, res, next) => {
    const inv = invoiceOf(h.int(req.params.id));
    if (!inv) return next();
    const back = String(req.get('referer') || '').includes('/admin/invoices/') ? `/admin/invoices/${inv.id}` : inv.brand_id ? `/admin/collections/tenants/${inv.brand_id}` : '/admin/collections/penalties';
    const out = chargePenalty(inv, { user: req.user });
    if (!out) return h.back(req, res, back, 'error', tr('col|No late charge is due on this invoice.'));
    h.log(req, 'Charged a late payment penalty', 'invoice', inv.id, `${inv.ref} · ${out.invoice.total}`);
    h.back(req, res, `/admin/invoices/${out.invoice.id}`, 'ok', tr('col|Late charge {ref} added. The tenant was told.', { ref: out.invoice.ref }));
  });
  router.post('/collections/invoices/:id/writeoff', R('manager'), (req, res, next) => {
    const inv = invoiceOf(h.int(req.params.id));
    if (!inv) return next();
    const back = `/admin/invoices/${inv.id}`;
    if (!canMoney(req)) return h.back(req, res, back, 'error', tr('Your role does not allow that.'));
    if (!['open', 'partial'].includes(inv.status)) return h.back(req, res, back, 'error', tr('col|Only an unpaid invoice can be written off.'));
    const reason = h.str(req.body.reason, 300);
    if (!reason) return h.back(req, res, back, 'error', tr('col|Say why it is written off.'));
    let out;
    try {
      const pen = inv.kind === 'penalty' ? db.get('SELECT id FROM col_penalties WHERE penalty_invoice_id = ?', inv.id) : null;
      out = writeOff(inv, h.numv(req.body.amount) ?? bal(inv), reason, { user: req.user, penaltyId: pen ? pen.id : null });
    } catch (e) {
      return h.back(req, res, back, 'error', tr(e.message));
    }
    h.log(req, out.pending ? 'Asked to write off' : 'Wrote off', 'invoice', inv.id, `${inv.ref} · ${out.writeoff.amount} · ${reason}`);
    h.back(req, res, back, 'ok', out.pending ? tr('col|Sent for approval. It is written off once approved.') : tr('col|Written off.'));
  });
  router.post('/collections/penalties/:id/waive', R('manager'), (req, res, next) => {
    const p = db.get('SELECT * FROM col_penalties WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    const inv = p.penalty_invoice_id ? invoiceOf(p.penalty_invoice_id) : null;
    const back = '/admin/collections/penalties';
    if (!canMoney(req) || !inv || !['open', 'partial'].includes(inv.status) || p.status !== 'charged') return h.back(req, res, back, 'error', tr('col|This charge cannot be waived.'));
    const reason = h.str(req.body.reason, 300) || 'Late charge waived';
    const out = writeOff(inv, bal(inv), reason, { user: req.user, penaltyId: p.id });
    h.log(req, out.pending ? 'Asked to waive a late charge' : 'Waived a late charge', 'invoice', inv.id, `${inv.ref} · ${reason}`);
    h.back(req, res, back, 'ok', out.pending ? tr('col|Sent for approval. It is written off once approved.') : tr('col|Late charge waived.'));
  });

  // on the invoice page: what collections did, and the actions
  (h.invoiceCards = h.invoiceCards || []).push((req, i) => {
    const open = ['open', 'partial'].includes(i.status);
    const rem = db.all('SELECT * FROM col_reminders WHERE invoice_id = ? ORDER BY created_at DESC, id DESC LIMIT 8', i.id);
    const pens = db.all('SELECT p.*, x.ref pen_ref, x.status pen_status FROM col_penalties p LEFT JOIN invoices x ON x.id = p.penalty_invoice_id WHERE p.invoice_id = ? ORDER BY p.id', i.id);
    const wos = db.all('SELECT * FROM col_writeoffs WHERE invoice_id = ? ORDER BY id DESC', i.id);
    const plan = db.get("SELECT p.* FROM col_plan_invoices x JOIN col_plans p ON p.id = x.plan_id WHERE x.invoice_id = ? ORDER BY p.id DESC LIMIT 1", i.id);
    const pending = open ? pendingPenalty(i) : 0;
    if (!open && !rem.length && !pens.length && !wos.length && !plan) return '';
    const csrf = req.session.csrf;
    const may = canMoney(req);
    const lines = [
      ...(plan ? [`<li><a href="/admin/collections/plans/${plan.id}"><span class="what"><b>${esc(tr('col|Under payment plan {ref}', { ref: plan.ref }))}</b></span>${badgeOf(PLAN, plan.status)}</a></li>`] : []),
      ...rem.map((r) => `<li><span class="what"><b>${esc(stepLabel(r.step))}</b><small>${esc(ui.dt(r.created_at))}</small></span>${r.status === 'sent' ? ui.badge('sent', tr('col|Sent'), 'ok') : ui.badge(r.status, tr(r.status === 'skipped' ? 'col|Skipped' : 'col|Not sent'), 'mute')}</li>`),
      ...pens.map((p) => `<li><a href="/admin/invoices/${p.penalty_invoice_id}"><span class="what"><b>${esc(tr('col|Late charge {ref}', { ref: p.pen_ref || '—' }))}</b><small>${esc(ui.date(p.through_date))}</small></span><b>${ui.money(p.amount, { compact: true })}</b>${p.status === 'waived' ? ui.badge('waived', tr('col|Waived'), 'mute') : ''}</a></li>`),
      ...wos.map((w) => `<li><span class="what"><b>${esc(tr('col|Write-off {ref}', { ref: w.ref }))}</b><small>${esc(w.reason || '')}</small></span><b>${ui.money(w.amount, { compact: true })}</b>${badgeOf(WRITEOFF, w.status)}</li>`),
    ];
    const acts = open && may ? `<div class="row">${ui.form(`/admin/collections/invoices/${i.id}/remind`, csrf, ui.btn(esc(tr('col|Send a reminder')), { cls: 'btn--ghost btn--sm', ic: 'mail' }))}${pending >= 1 ? ui.form(`/admin/collections/invoices/${i.id}/penalty`, csrf, ui.btn(esc(tr('col|Charge {amount} late fee', { amount: ui.money(Math.round(pending), { compact: true }) })), { cls: 'btn--ghost btn--sm', ic: 'percent' })) : ''}</div>
      <details class="danger"><summary>${esc(tr(i.kind === 'penalty' ? 'col|Waive this charge' : 'col|Write off'))}</summary>${ui.form(`/admin/collections/invoices/${i.id}/writeoff`, csrf, `<div class="fields">${ui.input('amount', tr('Amount'), bal(i), { type: 'number', min: 1, max: bal(i), step: '0.01', required: true })}${ui.input('reason', tr('col|Why'), '', { required: true, placeholder: tr('col|e.g. Tenant left the country; agreed settlement') })}</div>${ui.btn(esc(tr(needsApproval('writeoff', bal(i)) ? 'col|Ask for approval' : 'col|Write off')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('col|Write this off? It stops being owed and is booked as an expense.') } })}`, { cls: 'stack' })}</details>` : '';
    return ui.card(tr('col|Collections'), `${lines.length ? `<ul class="list">${lines.join('')}</ul>` : ''}${acts}`, { sub: open && i.due_date < today() ? esc(tn(dayDiff(i.due_date, today()), 'col|{n} day late', 'col|{n} days late')) : '' });
  });

  // ---------- reminders ----------
  router.get('/collections/reminders', (req, res) => {
    const f = h.listFilters(req, { cols: { date: 'r.created_at', brand: 'r.brand_id' }, dateLabel: tr('col|Sent'), sorts: [['newest', 'sort|Newest first', 'r.created_at DESC, r.id DESC'], ['oldest', 'sort|Oldest first', 'r.created_at ASC, r.id ASC'], ['amount_desc', 'sort|Amount: highest first', 'i.total DESC'], ['name', 'sort|Name: A to Z', 'b.name COLLATE NOCASE']] });
    const rows = db.all(`SELECT r.*, i.ref, i.total, i.due_date, b.name brand_name, u.name user_name FROM col_reminders r JOIN invoices i ON i.id = r.invoice_id LEFT JOIN brands b ON b.id = r.brand_id LEFT JOIN users u ON u.id = r.user_id ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''} ORDER BY ${f.order} LIMIT 400`, ...f.args);
    const table = ui.table([
      { label: tr('col|Sent'), sort: (r) => r.created_at, render: (r) => esc(ui.dt(r.created_at)) },
      { label: tr('Tenant'), render: (r) => (r.brand_id ? tenantLink(r.brand_id, r.brand_name) : '—') },
      { label: tr('Invoice'), render: (r) => `<a href="/admin/invoices/${r.invoice_id}"><bdi>${esc(r.ref)}</bdi></a><small class="sub">${esc(ui.date(r.due_date))}</small>` },
      { label: tr('col|Step'), render: (r) => `${esc(stepLabel(r.step))}${r.user_name ? `<small class="sub">${esc(r.user_name)}</small>` : ''}` },
      { label: tr('col|Channels'), render: (r) => esc((r.channels || '').split(',').filter(Boolean).map((c) => tr(`col|ch_${c}`)).join(' + ') || '—') },
      { label: tr('Status'), render: (r) => (r.status === 'sent' ? (r.notice_id && h.noticeSeen && h.seenBadge ? h.seenBadge((h.noticeSeen(r.notice_id) || {}).seen) : ui.badge('sent', tr('col|Sent'), 'ok')) : ui.badge(r.status, tr(r.status === 'skipped' ? 'col|Skipped' : 'col|Not sent'), 'mute')) },
    ], rows, { empty: esc(tr('col|No reminders yet.')) });
    const list = steps();
    const plan = `<p class="muted">${esc(tr('col|Schedule: {steps}.', { steps: list.map(stepLabel).join(' · ') || '—' }))} ${S('col_reminders_on') === '1' ? '' : `<b class="late">${esc(tr('col|Automatic reminders are off.'))}</b>`}</p>`;
    const run = canMoney(req) ? ui.form('/admin/collections/reminders/run', req.session.csrf, ui.btn(esc(tr('col|Send due reminders now')), { cls: 'btn--ghost', ic: 'mail' })) : '';
    page(req, res, { title: tr('col|Reminders'), on: '/admin/collections/reminders', actions: `<div class="row">${run}</div>`, body: `${f.html}${ui.card(tn(rows.length, 'col|{n} reminder', 'col|{n} reminders'), `${plan}${table}`, { sub: esc(tr('col|Sent by email, in the tenant portal and by WhatsApp. Seen means opened in the portal or the email opened.')) })}` });
  });
  router.post('/collections/reminders/run', R('agent'), (req, res) => {
    if (!canMoney(req)) return h.back(req, res, '/admin/collections', 'error', tr('Your role does not allow that.'));
    settlePromises();
    refreshPlans();
    const n = runReminders({ user: req.user });
    h.log(req, 'Sent due reminders', 'collections', null, String(n));
    h.back(req, res, '/admin/collections/reminders', 'ok', n ? tn(n, 'col|{n} reminder sent.', 'col|{n} reminders sent.') : tr('col|No reminders were due.'));
  });

  // ---------- late charges ----------
  router.get('/collections/penalties', (req, res) => {
    const c = penaltyCfg();
    const csrf = req.session.csrf;
    const due = db.all(`SELECT i.*, b.name brand_name FROM invoices i LEFT JOIN brands b ON b.id = i.brand_id WHERE ${OPEN} AND i.kind NOT IN ('penalty','deposit') AND i.due_date < ? ORDER BY i.due_date`, today())
      .map((i) => ({ ...i, pending: pendingPenalty(i), done: charged(i.id), paused: pausedByPlan(i.id) })).filter((i) => i.pending >= 1 || i.done > 0);
    // the history of charges: a range on when they were charged, and its order
    const pf = h.listFilters(req, { cols: { date: 'p.created_at', brand: 'i.brand_id' }, dateLabel: tr('col|Charged'), sorts: [['newest', 'sort|Newest first', 'p.created_at DESC, p.id DESC'], ['oldest', 'sort|Oldest first', 'p.created_at ASC, p.id ASC'], ['amount_desc', 'sort|Amount: highest first', 'p.amount DESC'], ['amount_asc', 'sort|Amount: lowest first', 'p.amount ASC']] });
    const history = db.all(`SELECT p.*, i.ref inv_ref, x.ref pen_ref, x.status pen_status, x.total pen_total, x.paid pen_paid, b.name brand_name FROM col_penalties p JOIN invoices i ON i.id = p.invoice_id LEFT JOIN invoices x ON x.id = p.penalty_invoice_id LEFT JOIN brands b ON b.id = i.brand_id ${pf.where.length ? `WHERE ${pf.where.join(' AND ')}` : ''} ORDER BY ${pf.order} LIMIT 200`, ...pf.args);
    const may = canMoney(req);
    const dueTable = ui.table([
      { label: tr('Invoice'), render: (i) => `${invLink(i)}<small class="sub">${esc(i.brand_name || i.customer || '')}</small>` },
      { label: tr('Due'), sort: (i) => i.due_date, render: (i) => `${esc(ui.date(i.due_date))}<small class="sub">${daysLate(dayDiff(i.due_date, today()))}</small>` },
      { label: tr('col|Owed'), num: true, render: (i) => ui.money(bal(i), { cur: false }) },
      { label: tr('col|Charged so far'), num: true, render: (i) => (i.done ? ui.money(i.done, { cur: false }) : '—') },
      { label: tr('col|To charge now'), num: true, sort: (i) => i.pending, render: (i) => (i.paused ? `<span class="muted">${esc(tr('col|Paused: payment plan'))}</span>` : i.pending >= 1 ? `<b>${ui.money(Math.round(i.pending), { cur: false })}</b>` : '—') },
      ...(may ? [{ label: '', render: (i) => (!i.paused && i.pending >= 1 ? ui.form(`/admin/collections/invoices/${i.id}/penalty`, csrf, ui.btn(esc(tr('col|Charge')), { cls: 'btn--ghost btn--xs' })) : '') }] : []),
    ], due, { empty: esc(c.mode === 'none' ? tr('col|Late charges are off. Turn them on in the settings.') : tr('col|No late charges are due.')) });
    const histTable = ui.table([
      { label: tr('col|Charged'), sort: (p) => p.created_at, render: (p) => esc(ui.date(p.through_date)) },
      { label: tr('col|Charge'), render: (p) => (p.penalty_invoice_id ? `<a href="/admin/invoices/${p.penalty_invoice_id}"><bdi>${esc(p.pen_ref)}</bdi></a>` : '—') },
      { label: tr('col|On invoice'), render: (p) => `<a href="/admin/invoices/${p.invoice_id}"><bdi>${esc(p.inv_ref)}</bdi></a><small class="sub">${esc(p.brand_name || '')}</small>` },
      { label: tr('Amount'), num: true, render: (p) => ui.money(p.amount, { cur: false }) },
      { label: tr('Status'), render: (p) => (p.status === 'waived' ? ui.badge('waived', tr('col|Waived'), 'mute') : ui.badge(p.pen_status, M.INVOICE_STATUS[p.pen_status])) },
      ...(may ? [{ label: '', render: (p) => (p.status === 'charged' && ['open', 'partial'].includes(p.pen_status) ? `<details class="pop-inline"><summary class="btn btn--ghost btn--xs">${esc(tr('col|Waive'))}</summary>${ui.form(`/admin/collections/penalties/${p.id}/waive`, csrf, `${ui.input('reason', tr('col|Why'), '', { placeholder: tr('col|e.g. First time late; goodwill') })}${ui.btn(esc(tr('col|Waive')), { cls: 'btn--danger btn--xs' })}`, { cls: 'stack' })}</details>` : '') }] : []),
    ], history, { empty: esc(tr('col|No late charges yet.')) });
    const rule = c.mode === 'none' ? tr('col|Late charges are off.') : tr(c.mode === 'pct_month' ? 'col|{rate}% a month on what is owed, after {grace} days of grace, at most {cap}% of the invoice.' : 'col|{rate} a day, after {grace} days of grace, at most {cap}% of the invoice.', { rate: c.mode === 'pct_month' ? c.rate : ui.money(c.rate), grace: c.grace, cap: c.cap || '∞' });
    const run = may && c.mode !== 'none' ? ui.form('/admin/collections/penalties/run', csrf, ui.btn(esc(tr('col|Charge all that are due')), { cls: 'btn--ghost', ic: 'percent', attrs: { 'data-confirm': tr('col|Add a late charge to every overdue invoice listed?') } })) : '';
    page(req, res, { title: tr('col|Late charges'), on: '/admin/collections/penalties', actions: `<div class="row">${run}</div>`, body: `<p class="muted col-rule">${esc(rule)} ${esc(c.auto ? tr('col|Charged automatically once a month.') : tr('col|Charged by hand.'))} <a href="/admin/collections/settings">${esc(tr('col|Change'))}</a></p>${ui.card(tr('col|Due now'), dueTable)}${pf.html}${ui.card(tr('col|Charged'), histTable)}` });
  });
  router.post('/collections/penalties/run', R('manager'), (req, res) => {
    if (!canMoney(req)) return h.back(req, res, '/admin/collections/penalties', 'error', tr('Your role does not allow that.'));
    const n = runPenalties({ user: req.user, force: true });
    h.log(req, 'Charged late payment penalties', 'collections', null, String(n));
    h.back(req, res, '/admin/collections/penalties', 'ok', n ? tn(n, 'col|{n} late charge added.', 'col|{n} late charges added.') : tr('col|No late charges were due.'));
  });

  // ---------- write-offs ----------
  router.get('/collections/writeoffs', (req, res) => {
    const f = h.listFilters(req, { cols: { date: 'w.created_at', brand: 'w.brand_id' }, dateLabel: tr('Date'), sorts: [['newest', 'sort|Newest first', 'w.id DESC'], ['oldest', 'sort|Oldest first', 'w.id ASC'], ['amount_desc', 'sort|Amount: highest first', 'w.amount DESC'], ['amount_asc', 'sort|Amount: lowest first', 'w.amount ASC'], ['name', 'sort|Name: A to Z', 'b.name COLLATE NOCASE']] });
    const rows = db.all(`SELECT w.*, i.ref inv_ref, i.kind, b.name brand_name, u.name by_name, d.name decided_name FROM col_writeoffs w JOIN invoices i ON i.id = w.invoice_id LEFT JOIN brands b ON b.id = w.brand_id LEFT JOIN users u ON u.id = w.requested_by LEFT JOIN users d ON d.id = w.decided_by ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''} ORDER BY ${f.order} LIMIT 400`, ...f.args);
    const table = ui.table([
      { label: tr('col|Write-off'), render: (w) => `<b><bdi>${esc(w.ref)}</bdi></b><small class="sub">${esc(ui.date(w.created_at))}${w.by_name ? ` · ${esc(w.by_name)}` : ''}</small>` },
      { label: tr('Tenant'), render: (w) => (w.brand_id ? tenantLink(w.brand_id, w.brand_name) : '—') },
      { label: tr('Invoice'), render: (w) => `<a href="/admin/invoices/${w.invoice_id}"><bdi>${esc(w.inv_ref)}</bdi></a><small class="sub">${esc(w.penalty_id ? tr('col|Late charge waived') : M.INVOICE_KINDS[w.kind] || w.kind)}</small>` },
      { label: tr('col|Why'), render: (w) => esc(w.reason || '') },
      { label: tr('Amount'), num: true, sort: (w) => w.amount, render: (w) => `<b>${ui.money(w.amount, { cur: false })}</b>` },
      { label: tr('Status'), render: (w) => `${badgeOf(WRITEOFF, w.status)}${w.decided_name ? `<small class="sub">${esc(w.decided_name)}</small>` : ''}` },
    ], rows, { empty: esc(tr('col|Nothing written off.')) });
    const total = r2(rows.filter((w) => w.status === 'done').reduce((s, w) => s + w.amount, 0));
    page(req, res, { title: tr('col|Write-offs'), on: '/admin/collections/writeoffs', body: `${f.html}${ui.card(tr('col|Write-offs'), table, { sub: esc(tr('col|{amount} written off in this list. Booked as an expense against what tenants owe; approvals apply when a rule asks for them.', { amount: ui.money(total) })) })}` });
  });

  // ---------- payment plans ----------
  router.post('/collections/tenants/:id/plans', R('manager'), (req, res, next) => {
    const b = db.get('SELECT * FROM brands WHERE id = ?', h.int(req.params.id));
    if (!b) return next();
    const back = `/admin/collections/tenants/${b.id}`;
    if (!canMoney(req)) return h.back(req, res, back, 'error', tr('Your role does not allow that.'));
    const ids = [...new Set(h.list(req.body.inv).map((x) => h.int(x)).filter(Boolean))];
    const invs = ids.map((id) => db.get(`SELECT i.* FROM invoices i WHERE i.id = ? AND i.brand_id = ? AND ${OPEN}`, id, b.id)).filter(Boolean)
      .filter((i) => !db.get("SELECT 1 FROM col_plan_invoices x JOIN col_plans p ON p.id = x.plan_id WHERE x.invoice_id = ? AND p.status IN ('active','late','broken')", i.id));
    const n = Math.min(36, Math.max(1, h.int(req.body.installments) || 1));
    const first = isDate(req.body.first_due) ? req.body.first_due : M.addDays(today(), 7);
    const every = [1, 2, 3].includes(h.int(req.body.every)) ? h.int(req.body.every) : 1;
    if (!invs.length) return h.back(req, res, back, 'error', tr('col|Choose the invoices the plan covers.'));
    const total = r2(invs.reduce((s, i) => s + bal(i), 0));
    const each = Math.floor((total / n) * 100) / 100;
    const id = db.tx(() => {
      const pid = Number(db.run('INSERT INTO col_plans (ref, brand_id, lease_id, total, installments, first_due, every_months, grace_days, status, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('col_plans', 'PP', 4, true), b.id, invs[0].lease_id || null, total, n, first, every, Math.min(30, Math.max(0, h.int(req.body.grace) ?? Number(S('col_plan_grace')))), 'active', h.str(req.body.note, 300) || null, req.user.id, now()).lastInsertRowid);
      for (const i of invs) db.run('INSERT INTO col_plan_invoices (plan_id, invoice_id) VALUES (?, ?)', pid, i.id);
      for (let k = 0; k < n; k++) db.run('INSERT INTO col_plan_items (plan_id, n, due_date, amount) VALUES (?, ?, ?, ?)', pid, k + 1, M.addMonths(first, k * every), k === n - 1 ? r2(total - each * (n - 1)) : each);
      return pid;
    });
    const p = db.get('SELECT * FROM col_plans WHERE id = ?', id);
    if (h.tenantNotify) {
      h.tenantNotify(b.id, { kind: 'plan', title: 'col|Payment plan {ref} agreed', body: 'col|You agreed to pay {amount} in {n} installments, the first on {date}. Reminders and late charges pause on these invoices while the plan is kept.', params: { ref: p.ref, amount: enMoney(total), n, date: enDate(first), iso: first }, rows: db.all('SELECT * FROM col_plan_items WHERE plan_id = ? ORDER BY n', id).map((x) => [`col|Installment`, `${x.n} · ${enDate(x.due_date)} · ${enMoney(x.amount)}`]), link: '/portal/invoices', entity: 'col_plan', entity_id: id });
    }
    h.log(req, 'Agreed a payment plan', 'brand', b.id, `${p.ref} · ${total} over ${n}`);
    h.back(req, res, `/admin/collections/plans/${id}`, 'ok', tr('col|Payment plan agreed. The tenant was told.'));
  });
  router.get('/collections/plans', (req, res) => {
    const st = PLAN[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : '';
    const f = h.listFilters(req, {
      cols: { date: 'p.created_at', brand: 'p.brand_id' }, dateLabel: tr('col|Agreed'), keep: ['status'],
      sorts: [['newest', 'sort|Newest first', 'p.id DESC'], ['oldest', 'sort|Oldest first', 'p.id ASC'], ['amount_desc', 'sort|Amount: highest first', 'p.total DESC'], ['amount_asc', 'sort|Amount: lowest first', 'p.total ASC'], ['name', 'sort|Name: A to Z', 'b.name COLLATE NOCASE']],
    });
    const pw = [...(st === 'all' ? [] : st ? ['p.status = ?'] : ["p.status IN ('active','late','broken')"]), ...f.where];
    const rows = db.all(`SELECT p.*, b.name brand_name FROM col_plans p JOIN brands b ON b.id = p.brand_id ${pw.length ? `WHERE ${pw.join(' AND ')}` : ''} ORDER BY ${f.order} LIMIT 300`, ...(st && st !== 'all' ? [st] : []), ...f.args)
      .map((p) => ({ ...p, s: planState(p) }));
    const fq = ['brand', 'from', 'to', 'sort'].filter((k) => req.query[k]).map((k) => `${k}=${encodeURIComponent(req.query[k])}`).join('&');
    const sub = `<nav class="tabs tabs--sub">${[['', 'col|Running'], ...Object.entries(PLAN).map(([k, v]) => [k, v[0]]), ['all', 'All']].map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/collections/plans${k || fq ? `?${[k ? `status=${k}` : '', fq].filter(Boolean).join('&')}` : ''}">${esc(tr(l))}</a>`).join('')}</nav>`;
    const table = ui.table([
      { label: tr('col|Plan'), render: (p) => `<b><bdi>${esc(p.ref)}</bdi></b><small class="sub">${esc(ui.date(p.created_at))}</small>` },
      { label: tr('Tenant'), render: (p) => tenantLink(p.brand_id, p.brand_name) },
      { label: tr('Total'), num: true, sort: (p) => p.total, render: (p) => ui.money(p.total, { cur: false }) },
      { label: tr('col|Paid'), num: true, render: (p) => `${ui.money(Math.min(p.s.paid, p.total), { cur: false })}${ui.meter(p.total ? Math.min(1, p.s.paid / p.total) : 0)}` },
      { label: tr('col|Next installment'), render: (p) => (p.s.next ? `${esc(ui.date(p.s.next.due_date))}<small class="sub">${ui.money(p.s.next.amount, { compact: true })}</small>` : '—') },
      { label: tr('Status'), render: (p) => badgeOf(PLAN, p.s.status) },
    ], rows, { empty: esc(tr('col|No payment plans here.')), href: (p) => `/admin/collections/plans/${p.id}` });
    page(req, res, { title: tr('col|Payment plans'), on: '/admin/collections/plans', body: `${sub}${f.html}${ui.card(tn(rows.length, 'col|{n} plan', 'col|{n} plans'), table, { sub: esc(tr('col|Agree a plan from a tenant\'s collection page. Installments count as paid when payments on the plan\'s invoices reach them.')) })}` });
  });
  router.get('/collections/plans/:id', (req, res, next) => {
    const p = db.get('SELECT p.*, b.name brand_name, u.name by_name FROM col_plans p JOIN brands b ON b.id = p.brand_id LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?', h.int(req.params.id));
    if (!p) return next();
    const s = planState(p);
    const csrf = req.session.csrf;
    const may = canMoney(req) && !['completed', 'cancelled'].includes(p.status);
    const cheques = may ? db.all("SELECT * FROM cheques WHERE brand_id = ? AND status IN ('held','deposited') ORDER BY due_date", p.brand_id) : [];
    const items = ui.table([
      { label: '#', render: (x) => String(x.n) },
      { label: tr('Due'), render: (x) => esc(ui.date(x.due_date)) },
      { label: tr('Amount'), num: true, render: (x) => ui.money(x.amount, { cur: false }) },
      { label: tr('col|Running total'), num: true, render: (x) => ui.money(x.cum, { cur: false }) },
      { label: tr('chq|Cheque'), render: (x) => (x.cheque_id ? `<a href="/admin/cheques/${x.cheque_id}" class="ltr">${esc(x.cheque_number)}</a>` : may && cheques.length ? ui.form(`/admin/collections/plans/${p.id}/items/${x.id}/cheque`, csrf, ui.select('cheque_id', tr('chq|Cheque'), cheques.map((c) => [c.id, `${c.number} · ${ui.date(c.due_date)} · ${ui.money(c.amount, { compact: true })}`]), '', { blank: tr('col|Link a cheque…'), attrs: { 'data-autosubmit': '' }, cls: 'f--bare' })) : '—') },
      { label: tr('Status'), render: (x) => badgeOf(ITEM, x.state) },
    ], s.items);
    const invs = ui.table([
      { label: tr('Invoice'), render: (i) => invLink(i) },
      { label: tr('Due'), render: (i) => esc(ui.date(i.due_date)) },
      { label: tr('Total'), num: true, render: (i) => ui.money(i.total, { cur: false }) },
      { label: tr('Paid'), num: true, render: (i) => ui.money(i.paid, { cur: false }) },
      { label: tr('Status'), render: (i) => ui.badge(i.status, M.INVOICE_STATUS[i.status]) },
    ], s.invoices, { href: (i) => `/admin/invoices/${i.id}` });
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('Tenant'))}</dt><dd>${tenantLink(p.brand_id, p.brand_name)}</dd></div>
      <div><dt>${esc(tr('Total'))}</dt><dd><b>${ui.money(p.total)}</b></dd></div>
      <div><dt>${esc(tr('col|Installments'))}</dt><dd>${esc(tr('col|{n} × {amount}, every {every} month(s) from {date}', { n: p.installments, amount: ui.money(s.items[0] ? s.items[0].amount : 0), every: p.every_months, date: ui.date(p.first_due) }))}</dd></div>
      <div><dt>${esc(tr('col|Paid'))}</dt><dd>${ui.money(Math.min(s.paid, p.total))} ${ui.meter(p.total ? Math.min(1, s.paid / p.total) : 0)}</dd></div>
      <div><dt>${esc(tr('col|Grace days'))}</dt><dd>${p.grace_days}</dd></div>
      <div><dt>${esc(tr('col|Agreed'))}</dt><dd>${esc(ui.date(p.created_at))}${p.by_name ? ` · ${esc(p.by_name)}` : ''}</dd></div>
      ${p.note ? `<div><dt>${esc(tr('col|Note'))}</dt><dd>${esc(p.note)}</dd></div>` : ''}
    </dl>`;
    const cancel = may ? `<details class="danger"><summary>${esc(tr('col|Cancel the plan'))}</summary>${ui.form(`/admin/collections/plans/${p.id}/cancel`, csrf, ui.btn(esc(tr('col|Cancel the plan')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('col|Cancel this plan? Reminders and late charges start again on its invoices.') } }))}</details>` : '';
    page(req, res, {
      title: tr('col|Payment plan {ref}', { ref: p.ref }), crumbs: [['/admin/collections/plans', tr('col|Payment plans')], [null, p.ref]],
      body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('col|Installments'), items)}${ui.card(tr('col|Invoices it covers'), invs)}</div><div class="stack">${ui.card(p.brand_name, facts, { action: badgeOf(PLAN, s.status) })}${cancel}</div></div>`,
    });
  });
  router.post('/collections/plans/:id/items/:item/cheque', R('manager'), (req, res, next) => {
    const p = db.get('SELECT * FROM col_plans WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    const c = db.get('SELECT * FROM cheques WHERE id = ? AND brand_id = ?', h.int(req.body.cheque_id), p.brand_id);
    if (c && canMoney(req)) db.run('UPDATE col_plan_items SET cheque_id = ? WHERE id = ? AND plan_id = ?', c.id, h.int(req.params.item), p.id);
    h.back(req, res, `/admin/collections/plans/${p.id}`, c ? 'ok' : 'error', c ? tr('Saved.') : tr('col|Choose one of the tenant\'s cheques.'));
  });
  router.post('/collections/plans/:id/cancel', R('manager'), (req, res, next) => {
    const p = db.get('SELECT * FROM col_plans WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    if (canMoney(req)) db.run("UPDATE col_plans SET status = 'cancelled', closed_at = ? WHERE id = ?", now(), p.id);
    h.log(req, 'Cancelled a payment plan', 'brand', p.brand_id, p.ref);
    h.back(req, res, `/admin/collections/plans/${p.id}`, 'ok', tr('col|Plan cancelled.'));
  });

  // ---------- legal cases ----------
  registerDocs(M, 'col_case', 'col|Legal case', { warning_letter: 'col|Warning letter', legal_notice: 'col|Legal notice', lawsuit: 'col|Lawsuit', hearing_minutes: 'col|Hearing minutes', judgment: 'col|Judgment', settlement_paper: 'col|Settlement agreement' });
  const caseDocs = uploadRoute(router, h, '/collections/cases/upload', { col_case: 'col_cases' });
  const caseOf = (id) => db.get('SELECT c.*, b.name brand_name, s.ref lease_ref, u.name owner_name FROM col_cases c JOIN brands b ON b.id = c.brand_id LEFT JOIN leases s ON s.id = c.lease_id LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?', id);
  router.post('/collections/tenants/:id/cases', R('manager'), (req, res, next) => {
    const b = db.get('SELECT * FROM brands WHERE id = ?', h.int(req.params.id));
    if (!b) return next();
    if (!canMoney(req)) return h.back(req, res, `/admin/collections/tenants/${b.id}`, 'error', tr('Your role does not allow that.'));
    const stage = STAGES[req.body.stage] ? req.body.stage : 'warning';
    const lease = db.get("SELECT id FROM leases WHERE brand_id = ? ORDER BY status = 'active' DESC, id DESC LIMIT 1", b.id);
    const owner = db.get('SELECT id FROM users WHERE id = ?', h.int(req.body.owner_id));
    const id = db.tx(() => {
      const cid = Number(db.run('INSERT INTO col_cases (ref, brand_id, lease_id, stage, status, amount, lawyer, opened_on, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('col_cases', 'LC', 4, true), b.id, lease ? lease.id : null, stage, CLOSED_STAGES.includes(stage) ? 'closed' : 'open', r2(h.numv(req.body.amount) || 0), h.str(req.body.lawyer, 120) || null, today(), owner ? owner.id : req.user.id, now(), now()).lastInsertRowid);
      db.run("INSERT INTO col_case_notes (case_id, kind, body, user_id, created_at) VALUES (?, 'stage', ?, ?, ?)", cid, stage, req.user.id, now());
      return cid;
    });
    h.log(req, 'Opened a legal case', 'brand', b.id, `${b.name} · ${stage}`);
    h.back(req, res, `/admin/collections/cases/${id}`, 'ok', tr('col|Case opened. Reminders to this tenant pause while it is open.'));
  });
  router.get('/collections/cases', (req, res) => {
    const st = req.query.status === 'closed' ? 'closed' : req.query.status === 'all' ? 'all' : 'open';
    const f = h.listFilters(req, {
      cols: { date: 'c.created_at', brand: 'c.brand_id' }, dateLabel: tr('col|Opened'), keep: ['status'],
      sorts: [['hearing', 'sort|Next hearing: soonest first', "c.status = 'open' DESC, COALESCE(c.next_hearing, '9999'), c.id DESC"], ['newest', 'sort|Newest first', 'c.id DESC'], ['oldest', 'sort|Oldest first', 'c.id ASC'],
        ['amount_desc', 'sort|Amount: highest first', 'c.amount DESC'], ['amount_asc', 'sort|Amount: lowest first', 'c.amount ASC'], ['name', 'sort|Name: A to Z', 'b.name COLLATE NOCASE']],
    });
    const cw = [...(st === 'all' ? [] : ['c.status = ?']), ...f.where];
    const rows = db.all(`SELECT c.*, b.name brand_name FROM col_cases c JOIN brands b ON b.id = c.brand_id ${cw.length ? `WHERE ${cw.join(' AND ')}` : ''} ORDER BY ${f.order}`, ...(st === 'all' ? [] : [st]), ...f.args);
    const fq = ['brand', 'from', 'to', 'sort'].filter((k) => req.query[k]).map((k) => `&${k}=${encodeURIComponent(req.query[k])}`).join('');
    const t = today();
    const sub = `<nav class="tabs tabs--sub">${[['open', 'col|Open'], ['closed', 'col|Closed'], ['all', 'All']].map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/collections/cases?status=${k}${fq}">${esc(tr(l))}</a>`).join('')}</nav>`;
    const table = ui.table([
      { label: tr('col|Case'), render: (c) => `<b><bdi>${esc(c.ref)}</bdi></b><small class="sub">${esc([c.case_no, c.court].filter(Boolean).join(' · '))}</small>` },
      { label: tr('Tenant'), render: (c) => tenantLink(c.brand_id, c.brand_name) },
      { label: tr('col|Stage'), render: (c) => ui.badge(c.stage, tr(STAGES[c.stage]), CLOSED_STAGES.includes(c.stage) ? 'mute' : 'cocoa') },
      { label: tr('col|Amount claimed'), num: true, sort: (c) => c.amount, render: (c) => ui.money(c.amount, { cur: false }) },
      { label: tr('col|Lawyer'), render: (c) => esc(c.lawyer || '—') },
      { label: tr('col|Next hearing'), sort: (c) => c.next_hearing || '', render: (c) => (c.next_hearing && c.status === 'open' ? `<span class="${c.next_hearing <= M.addDays(t, 3) ? 'late' : ''}">${esc(ui.date(c.next_hearing))}</span><small class="sub">${esc(ui.rel(c.next_hearing))}</small>` : '—') },
    ], rows, { empty: esc(tr('col|No legal cases here. Open one from a tenant\'s collection page.')), href: (c) => `/admin/collections/cases/${c.id}` });
    page(req, res, { title: tr('col|Legal cases'), on: '/admin/collections/cases', body: `${sub}${f.html}${ui.card(tn(rows.length, 'col|{n} case', 'col|{n} cases'), table)}` });
  });
  router.get('/collections/cases/:id', (req, res, next) => {
    const c = caseOf(h.int(req.params.id));
    if (!c) return next();
    const csrf = req.session.csrf;
    const notes = db.all('SELECT n.*, u.name user_name FROM col_case_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.case_id = ? ORDER BY n.created_at DESC, n.id DESC', c.id);
    const icon = { stage: 'flow', hearing: 'cal', alert: 'mail', note: 'chat' };
    const text = (n) => (n.kind === 'stage' ? tr('col|Moved to {stage}', { stage: tr(STAGES[n.body] || n.body) }) : n.kind === 'hearing' ? tr('col|Hearing set for {date}', { date: ui.date(n.on_date) }) : n.kind === 'alert' ? tr('col|Hearing reminder sent for {date}', { date: ui.date(n.on_date) }) : n.body);
    const tl = notes.map((n) => `<li class="tl"><span class="tl__ic">${ui.icon(icon[n.kind] || 'chat')}</span><div class="tl__body"><p>${n.kind === 'note' ? esc(n.body) : `<b>${esc(text(n))}</b>`}</p><p class="tl__meta">${esc([n.user_name, ui.dt(n.created_at)].filter(Boolean).join(' · '))}</p></div></li>`).join('');
    const owed = r2(db.value(`SELECT COALESCE(SUM(i.total - i.paid), 0) FROM invoices i WHERE i.brand_id = ? AND ${OPEN} AND i.due_date < ?`, c.brand_id, today()));
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('Tenant'))}</dt><dd>${tenantLink(c.brand_id, c.brand_name)}${c.lease_ref ? ` · <a href="/admin/leases/${c.lease_id}">${esc(c.lease_ref)}</a>` : ''}</dd></div>
      <div><dt>${esc(tr('col|Stage'))}</dt><dd>${ui.badge(c.stage, tr(STAGES[c.stage]), CLOSED_STAGES.includes(c.stage) ? 'mute' : 'cocoa')}</dd></div>
      <div><dt>${esc(tr('col|Amount claimed'))}</dt><dd><b>${ui.money(c.amount)}</b><small class="sub">${esc(tr('col|Overdue today: {amount}', { amount: ui.money(owed) }))}</small></dd></div>
      <div><dt>${esc(tr('col|Lawyer'))}</dt><dd>${esc(c.lawyer || '—')}</dd></div>
      <div><dt>${esc(tr('col|Court'))}</dt><dd>${esc([c.court, c.case_no].filter(Boolean).join(' · ') || '—')}</dd></div>
      <div><dt>${esc(tr('col|Next hearing'))}</dt><dd>${c.next_hearing ? `${esc(ui.date(c.next_hearing))} · ${esc(ui.rel(c.next_hearing))}` : '—'}</dd></div>
      <div><dt>${esc(tr('col|Followed by'))}</dt><dd>${esc(c.owner_name || '—')}</dd></div>
      <div><dt>${esc(tr('col|Opened'))}</dt><dd>${esc(ui.date(c.opened_on))}${c.closed_on ? ` · ${esc(tr('col|closed {date}', { date: ui.date(c.closed_on) }))}` : ''}</dd></div>
      ${c.outcome ? `<div><dt>${esc(tr('col|Outcome'))}</dt><dd>${esc(c.outcome)}</dd></div>` : ''}
    </dl>`;
    const update = canMoney(req) ? ui.form(`/admin/collections/cases/${c.id}`, csrf, `<div class="fields">
      ${ui.select('stage', tr('col|Stage'), tmap(STAGES), c.stage)}${ui.input('next_hearing', tr('col|Next hearing'), c.next_hearing || '', { type: 'date' })}
      ${ui.input('amount', tr('col|Amount claimed'), c.amount, { type: 'number', min: 0, step: '0.01' })}${ui.input('lawyer', tr('col|Lawyer'), c.lawyer || '')}
      ${ui.input('court', tr('col|Court'), c.court || '')}${ui.input('case_no', tr('col|Case number'), c.case_no || '', { attrs: { dir: 'auto' } })}
      ${ui.select('owner_id', tr('col|Followed by'), h.users().map((u) => [u.id, u.name]), c.owner_id || '')}
      ${ui.textarea('outcome', tr('col|Outcome'), c.outcome || '', { rows: 2, cls: 'span-all' })}
      ${ui.textarea('note', tr('col|Add a note'), '', { rows: 2, cls: 'span-all' })}
    </div>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    page(req, res, {
      title: tr('col|Case {ref}', { ref: c.ref }), crumbs: [['/admin/collections/cases', tr('col|Legal cases')], [null, c.ref]],
      body: `<div class="grid grid--side"><div class="stack">${ui.card(c.brand_name, facts, { action: c.status === 'open' ? ui.badge('open', tr('col|Open'), 'cocoa') : ui.badge('closed', tr('col|Closed'), 'mute') })}${caseDocs(req, 'col_case', c.id, { title: tr('col|Letters and court papers') })}${ui.card(tr('col|History'), tl ? `<ul class="timeline">${tl}</ul>` : `<p class="muted pad">${esc(tr('col|Nothing yet.'))}</p>`)}</div><div class="stack">${update ? ui.card(tr('col|Update the case'), update) : ''}</div></div>`,
    });
  });
  router.post('/collections/cases/:id', R('manager'), (req, res, next) => {
    const c = caseOf(h.int(req.params.id));
    if (!c) return next();
    const back = `/admin/collections/cases/${c.id}`;
    if (!canMoney(req)) return h.back(req, res, back, 'error', tr('Your role does not allow that.'));
    const b = req.body;
    const stage = STAGES[b.stage] ? b.stage : c.stage;
    const hearing = isDate(b.next_hearing) ? b.next_hearing : null;
    const owner = db.get('SELECT id FROM users WHERE id = ?', h.int(b.owner_id));
    const closed = CLOSED_STAGES.includes(stage);
    db.tx(() => {
      db.run('UPDATE col_cases SET stage = ?, status = ?, next_hearing = ?, amount = ?, lawyer = ?, court = ?, case_no = ?, owner_id = ?, outcome = ?, closed_on = ?, updated_at = ? WHERE id = ?',
        stage, closed ? 'closed' : 'open', closed ? null : hearing, r2(h.numv(b.amount) ?? c.amount), h.str(b.lawyer, 120) || null, h.str(b.court, 160) || null, h.str(b.case_no, 60) || null,
        owner ? owner.id : c.owner_id, h.str(b.outcome, 1000) || null, closed ? c.closed_on || today() : null, now(), c.id);
      if (stage !== c.stage) db.run("INSERT INTO col_case_notes (case_id, kind, body, user_id, created_at) VALUES (?, 'stage', ?, ?, ?)", c.id, stage, req.user.id, now());
      if (hearing && hearing !== c.next_hearing && !closed) db.run("INSERT INTO col_case_notes (case_id, kind, body, on_date, user_id, created_at) VALUES (?, 'hearing', ?, ?, ?, ?)", c.id, hearing, hearing, req.user.id, now());
      const note = h.str(b.note, 2000);
      if (note) db.run("INSERT INTO col_case_notes (case_id, kind, body, user_id, created_at) VALUES (?, 'note', ?, ?, ?)", c.id, note, req.user.id, now());
    });
    h.log(req, 'Updated a legal case', 'brand', c.brand_id, `${c.ref} · ${stage}`);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  // ---------- settings ----------
  router.get('/collections/settings', (req, res) => {
    const may = h.can(req, 'admin') || h.canFinance(req);
    const csrf = req.session.csrf;
    const v = (k) => S(k);
    const form = ui.form('/admin/collections/settings', csrf, `<h3 class="col-h">${esc(tr('col|Reminders'))}</h3><div class="fields">
      ${ui.select('col_reminders_on', tr('col|Automatic reminders'), { 1: tr('col|On'), 0: tr('col|Off') }, v('col_reminders_on'))}
      ${ui.input('col_steps', tr('col|Steps (days from the due date)'), v('col_steps'), { hint: tr('col|Negative is before the due date, e.g. -7, 0, 7, 15, 30'), attrs: { dir: 'ltr' } })}
      ${ui.select('col_whatsapp', tr('col|Also by WhatsApp'), { 1: tr('col|Yes, when WhatsApp is set up'), 0: tr('col|No') }, v('col_whatsapp'))}
    </div><h3 class="col-h">${esc(tr('col|Late charges'))}</h3><div class="fields">
      ${ui.select('col_penalty_mode', tr('col|How they are worked out'), { pct_month: tr('col|A percentage a month'), per_day: tr('col|A fixed amount a day'), none: tr('col|No late charges') }, v('col_penalty_mode'))}
      ${ui.input('col_penalty_rate', tr('col|Rate (% a month, or the amount a day)'), v('col_penalty_rate'), { type: 'number', min: 0, step: '0.01' })}
      ${ui.input('col_penalty_grace', tr('col|Grace days'), v('col_penalty_grace'), { type: 'number', min: 0, max: 120 })}
      ${ui.input('col_penalty_cap', tr('col|Cap (% of the invoice, 0 = none)'), v('col_penalty_cap'), { type: 'number', min: 0, max: 100, step: '0.1' })}
      ${ui.input('col_penalty_min', tr('col|Only when more than this is owed'), v('col_penalty_min'), { type: 'number', min: 0 })}
      ${ui.select('col_penalty_auto', tr('col|Charge them'), { 0: tr('col|By hand'), 1: tr('col|Automatically, once a month') }, v('col_penalty_auto'))}
      ${ui.select('col_penalty_vat', tr('col|VAT on late charges'), { 0: tr('col|No VAT'), 1: tr('col|As on the lease') }, v('col_penalty_vat'))}
    </div><h3 class="col-h">${esc(tr('col|Payment plans'))}</h3><div class="fields">${ui.input('col_plan_grace', tr('col|Days before a missed installment breaks the plan'), v('col_plan_grace'), { type: 'number', min: 0, max: 30 })}</div>
    ${may ? ui.btn(esc(tr('Save')), { cls: 'btn--primary' }) : ''}`, { cls: 'stack' });
    const appr = approvals() ? tr('col|Write-offs and refunds follow the approval rules on the Approvals page.') : tr('col|Write-offs and refunds are done at once (no approval rules are set up).');
    page(req, res, { title: tr('col|Collections settings'), on: '/admin/collections/settings', body: `<div class="grid grid--side"><div>${ui.card(tr('col|Settings'), form)}</div><div>${ui.card(tr('col|Approvals'), `<p class="muted">${esc(appr)}</p>${approvals() ? `<p>${ui.btn(esc(tr('nav|Approvals')), { href: '/admin/approvals', cls: 'btn--ghost btn--sm' })}</p>` : ''}`)}</div></div>` });
  });
  router.post('/collections/settings', R('manager'), (req, res) => {
    if (!(h.can(req, 'admin') || h.canFinance(req))) return h.back(req, res, '/admin/collections/settings', 'error', tr('Your role does not allow that.'));
    const b = req.body;
    const num = (k, lo, hi) => { const n = Number(b[k]); if (Number.isFinite(n)) db.setSetting(k, String(Math.min(hi, Math.max(lo, n)))); };
    db.setSetting('col_reminders_on', b.col_reminders_on === '0' ? '0' : '1');
    const list = String(b.col_steps || '').split(/[,\s]+/).map((x) => Math.round(Number(x))).filter((x) => x !== null && Number.isFinite(x) && x >= -60 && x <= 365);
    if (String(b.col_steps || '').trim()) db.setSetting('col_steps', [...new Set(list)].sort((x, y) => x - y).join(','));
    db.setSetting('col_whatsapp', b.col_whatsapp === '0' ? '0' : '1');
    db.setSetting('col_penalty_mode', ['pct_month', 'per_day', 'none'].includes(b.col_penalty_mode) ? b.col_penalty_mode : 'none');
    num('col_penalty_rate', 0, 100000);
    num('col_penalty_grace', 0, 120);
    num('col_penalty_cap', 0, 100);
    num('col_penalty_min', 0, 1e9);
    num('col_plan_grace', 0, 30);
    db.setSetting('col_penalty_auto', b.col_penalty_auto === '1' ? '1' : '0');
    db.setSetting('col_penalty_vat', b.col_penalty_vat === '1' ? '1' : '0');
    h.log(req, 'Changed the collection settings', 'settings', null, null);
    h.back(req, res, '/admin/collections/settings', 'ok', tr('Saved.'));
  });

  // ---------- on other pages ----------
  const planCard = (rows) => `<ul class="list">${rows.map((p) => { const s = planState(p); return `<li><a href="/admin/collections/plans/${p.id}"><span class="what"><b><bdi>${esc(p.ref)}</bdi> · ${ui.money(p.total, { compact: true })}</b><small>${esc(s.next ? tr('col|Next: {amount} on {date}', { amount: ui.money(s.next.amount, { compact: true }), date: ui.date(s.next.due_date) }) : tr('col|All installments paid'))}</small></span>${badgeOf(PLAN, s.status)}</a></li>`; }).join('')}</ul>`;
  (h.tenantCards = h.tenantCards || []).push((req, b) => {
    const owed = r2(db.value(`SELECT COALESCE(SUM(i.total - i.paid), 0) FROM invoices i WHERE i.brand_id = ? AND ${OPEN} AND i.due_date < ?`, b.id, today()));
    const plans = db.all("SELECT * FROM col_plans WHERE brand_id = ? AND status IN ('active','late','broken') ORDER BY id DESC", b.id);
    const promise = openPromise(b.id);
    const c = openCase(b.id);
    if (!owed && !plans.length && !promise && !c) return '';
    const bits = [
      owed ? `<p class="col-owed"><b class="late">${ui.money(owed)}</b> ${esc(tr('col|overdue'))}</p>` : '',
      promise ? `<p class="small">${badgeOf(PROMISE, promise.status)} ${esc(tr('col|Promised {amount} by {date}', { amount: ui.money(promise.amount, { compact: true }), date: ui.date(promise.due_on) }))}</p>` : '',
      plans.length ? planCard(plans) : '',
      c ? `<p class="small"><a href="/admin/collections/cases/${c.id}">${esc(tr('col|Legal case {ref}', { ref: c.ref }))}</a> · ${esc(tr(STAGES[c.stage]))}</p>` : '',
    ].join('');
    return ui.card(tr('col|Collections'), bits, { action: ui.btn(esc(tr('col|Open')), { href: `/admin/collections/tenants/${b.id}`, cls: 'btn--ghost btn--sm' }) });
  });
  (h.leaseCards = h.leaseCards || []).push((req, s) => {
    const plans = db.all("SELECT p.* FROM col_plans p WHERE p.status IN ('active','late','broken') AND (p.lease_id = ? OR p.id IN (SELECT x.plan_id FROM col_plan_invoices x JOIN invoices i ON i.id = x.invoice_id WHERE i.lease_id = ?)) ORDER BY p.id DESC", s.id, s.id);
    const c = db.get("SELECT * FROM col_cases WHERE status = 'open' AND (lease_id = ? OR brand_id = ?) ORDER BY id DESC LIMIT 1", s.id, s.brand_id);
    if (!plans.length && !c) return '';
    return ui.card(tr('col|Collections'), `${plans.length ? planCard(plans) : ''}${c ? `<p class="small pad"><a href="/admin/collections/cases/${c.id}">${esc(tr('col|Legal case {ref}', { ref: c.ref }))}</a> · ${esc(tr(STAGES[c.stage]))}</p>` : ''}`, { action: ui.btn(esc(tr('col|Open')), { href: `/admin/collections/tenants/${s.brand_id}`, cls: 'btn--ghost btn--sm' }) });
  });

  h.collections = { sweep, runReminders, sendReminder, steps, accrued, pendingPenalty, chargePenalty, runPenalties, writeOff, applyWriteoff, planState, refreshPlans, settlePromises, worklist, stats, aging, hearingAlerts, ensureMethodAccounts, STAGES, OUTCOMES };
};

module.exports.SCHEMA = SCHEMA;
module.exports.STAGES = STAGES;
