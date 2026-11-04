'use strict';

// Collections and lease changes: reminders on a schedule (never twice), late charges (worked out,
// charged once, waived), write-offs (booked as an expense, through approvals when a rule asks),
// promises and the call list, payment plans (installments kept from payments), legal cases with
// hearing alerts; lease addenda (invoices voided and issued again, paid ones untouched), options
// with notice alerts, renewals into a linked lease, and the end-of-lease settlement against the
// deposit; reversing a receipt through approvals.

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

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  M = h.M;
  base = `http://127.0.0.1:${server.address().port}`;
  db.run("INSERT INTO users (name, email, role, password_hash, finance, hr, created_at) VALUES ('Collections Admin', 'col-admin@thewave.test', 'admin', ?, 1, 1, datetime('now'))", hashPassword('long-enough-1'));
  admin = browser();
  await admin.signIn('col-admin@thewave.test', 'long-enough-1');
  admin.user = db.get("SELECT * FROM users WHERE email = 'col-admin@thewave.test'");
  db.setSetting('leasing_email', 'leasing@thewave.test');
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
    form: (p, data) => {
      const q = new URLSearchParams({ _csrf: b.csrf });
      for (const [k, v] of Object.entries(data)) for (const x of [].concat(v)) q.append(k, x);
      return go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q.toString() });
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

let seq = 0;
const T = () => M.today();
// a tenant with a portal account and an active lease that started `monthsAgo` months back
async function tenant(name, { monthsAgo = 3, rate = 1000, deposit = 0, freq = 'monthly', years = 2 } = {}) {
  const b = Number(db.run("INSERT INTO brands (name, category, created_at) VALUES (?, 'fashion', datetime('now'))", name).lastInsertRowid);
  db.run("INSERT INTO portal_users (brand_id, name, email, lang, active, created_at) VALUES (?, 'Finance', ?, 'ar', 1, datetime('now'))", b, `fin${++seq}@tenant.test`);
  db.run("INSERT INTO contacts (brand_id, name, phone, whatsapp, primary_contact, created_at) VALUES (?, 'Owner', '+20 100 000 0000', '+201000000000', 1, datetime('now'))", b);
  const u = db.get("SELECT * FROM units WHERE status = 'available' AND zone = 'plaza' ORDER BY sort LIMIT 1");
  const start = M.addMonths(T(), -monthsAgo);
  const res = await admin.form('/admin/leases', {
    brand_id: String(b), units: String(u.id), rent_m2: String(rate), terrace_rent_m2: '0', escalation_pct: '10', service_mode: 'm2', service_m2: '0', vat_pct: '0',
    start_date: start, term_years: String(years), rent_free_months: '0', payment_freq: freq, deposit: String(deposit), key_money: '0', signed_at: start,
  });
  assert.equal(res.status, 303);
  const s = db.get('SELECT * FROM leases WHERE brand_id = ? ORDER BY id DESC LIMIT 1', b);
  assert.equal((await admin.form(`/admin/leases/${s.id}/activate`, {})).status, 303);
  return { brand: b, lease: db.get('SELECT * FROM leases WHERE id = ?', s.id), unit: u };
}
const invoices = (leaseId, where = '1=1') => db.all(`SELECT * FROM invoices WHERE lease_id = ? AND ${where} ORDER BY due_date, id`, leaseId);

test('reminders: the latest due step is sent once, earlier missed steps are logged as skipped, and the tenant is told in their language', async () => {
  const t = await tenant('Reminder Co', { monthsAgo: 2 });
  const late = invoices(t.lease.id, "kind = 'rent' AND status = 'open' AND due_date < date('now')");
  assert.ok(late.length >= 2, 'overdue rent invoices');
  const n = h.collections.runReminders();
  assert.ok(n >= late.length);
  const oldest = late[0];
  const age = Math.round((Date.parse(`${T()}T00:00:00Z`) - Date.parse(`${oldest.due_date}T00:00:00Z`)) / 864e5);
  const expected = [-7, 0, 7, 15, 30].filter((s) => s <= age).at(-1);
  const rows = db.all('SELECT * FROM col_reminders WHERE invoice_id = ? ORDER BY step', oldest.id);
  assert.equal(rows.filter((r) => r.status === 'sent').length, 1, 'one reminder sent');
  assert.equal(rows.find((r) => r.status === 'sent').step, expected, 'the latest step that is due');
  assert.ok(rows.filter((r) => r.status === 'skipped').length >= 1, 'earlier steps skipped, not sent');
  const sent = rows.find((r) => r.status === 'sent');
  assert.match(sent.channels, /portal/);
  assert.match(sent.channels, /email/);
  const notice = db.get('SELECT * FROM portal_notices WHERE id = ?', sent.notice_id);
  assert.match(notice.title_en, new RegExp(oldest.ref));
  assert.match(notice.title_ar, /الفاتورة/);
  assert.ok(db.get("SELECT * FROM outbox WHERE to_addr LIKE 'fin%@tenant.test' AND lang = 'ar' ORDER BY id DESC LIMIT 1"), 'emailed in Arabic');
  // never twice
  const again = h.collections.runReminders();
  assert.equal(db.value("SELECT COUNT(*) FROM col_reminders WHERE invoice_id = ? AND status = 'sent'", oldest.id), 1);
  assert.ok(again < n);
  // by hand from the invoice
  const res = await admin.form(`/admin/collections/invoices/${oldest.id}/remind`, {});
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM col_reminders WHERE invoice_id = ? AND step IS NULL', oldest.id), 1);
  const page = await (await admin.go('/admin/collections/reminders')).text();
  assert.match(page, new RegExp(oldest.ref));
});

test('late charges: a percentage a month after the grace period, capped, charged once and waived as a write-off', async () => {
  db.setSetting('col_penalty_mode', 'pct_month');
  db.setSetting('col_penalty_rate', '2');
  db.setSetting('col_penalty_grace', '10');
  db.setSetting('col_penalty_cap', '3');
  db.setSetting('col_penalty_min', '0');
  const t = await tenant('Penalty Co', { monthsAgo: 3 });
  const inv = invoices(t.lease.id, "kind = 'rent' AND status = 'open'")[0];
  const owed = inv.total - inv.paid;
  const days = Math.round((Date.parse(`${T()}T00:00:00Z`) - Date.parse(`${M.addDays(inv.due_date, 10)}T00:00:00Z`)) / 864e5);
  const want = Math.min(owed * 0.02 * (days / 30), inv.total * 0.03);
  assert.ok(Math.abs(h.collections.accrued(inv) - want) < 0.02, 'worked out from the end of the grace period, capped');
  const res = await admin.form(`/admin/collections/invoices/${inv.id}/penalty`, {});
  assert.equal(res.status, 303);
  const pen = db.get("SELECT * FROM invoices WHERE kind = 'penalty' AND source_id = ?", inv.id);
  assert.ok(pen, 'a penalty invoice');
  assert.equal(pen.total, Math.round(want), 'no VAT on a late charge');
  assert.equal(h.collections.pendingPenalty(inv), 0, 'nothing more to charge');
  assert.equal(h.collections.chargePenalty(inv), null, 'not charged twice');
  assert.ok(db.get("SELECT * FROM portal_notices WHERE kind = 'penalty' AND entity_id = ?", pen.id), 'the tenant is told');
  // waived: an unpaid charge is cancelled
  const row = db.get('SELECT * FROM col_penalties WHERE penalty_invoice_id = ?', pen.id);
  const w = await admin.form(`/admin/collections/penalties/${row.id}/waive`, { reason: 'First time late' });
  assert.equal(w.status, 303);
  assert.equal(db.value('SELECT status FROM invoices WHERE id = ?', pen.id), 'void');
  assert.equal(db.value('SELECT status FROM col_penalties WHERE id = ?', row.id), 'waived');
  assert.equal(h.collections.pendingPenalty(inv), 0, 'a waived charge is not charged again');
  assert.equal((await admin.go('/admin/collections/penalties')).status, 200);
});

test('write-offs: booked as an expense, not counted as money collected; above the rule they wait for approval', async () => {
  const t = await tenant('Writeoff Co', { monthsAgo: 2 });
  const [a, b] = invoices(t.lease.id, "kind = 'rent' AND status = 'open' AND due_date < date('now')");
  const before = h.collections.stats().collected;
  const rule = h.approvals ? h.approvals.ruleOf('writeoff') : null;
  if (h.approvals) h.approvals.setRule('writeoff', { active: 0, min_amount: 0, steps: [{ who: 'manager' }] }, admin.user);
  let res = await admin.form(`/admin/collections/invoices/${a.id}/writeoff`, { amount: String(a.total), reason: 'Agreed settlement' });
  assert.equal(res.status, 303);
  const pay = db.get("SELECT * FROM payments WHERE invoice_id = ? AND method = 'writeoff'", a.id);
  assert.ok(pay, 'a write-off receipt');
  assert.equal(db.value('SELECT status FROM invoices WHERE id = ?', a.id), 'paid');
  assert.equal(h.collections.stats().collected, before, 'not money collected');
  const entry = db.get("SELECT e.id FROM acc_entries e WHERE e.source = ?", `pay:${pay.id}`);
  if (entry) {
    const lines = db.all('SELECT a.key, l.debit, l.credit FROM acc_lines l JOIN acc_accounts a ON a.id = l.account_id WHERE l.entry_id = ?', entry.id);
    assert.ok(lines.find((l) => ['bad_debts', 'exp_other'].includes(l.key) && l.debit === a.total), 'an expense');
    assert.ok(lines.find((l) => l.key === 'ar' && l.credit === a.total), 'off what tenants owe');
  }
  // the manual payment form does not offer it
  const page = await (await admin.go(`/admin/invoices/${b.id}`)).text();
  assert.doesNotMatch(page, /<option value="writeoff"/);
  // with an approval rule
  if (h.approvals) {
    h.approvals.setRule('writeoff', { active: 1, min_amount: 1, steps: [{ who: 'admin' }] }, admin.user);
    res = await admin.form(`/admin/collections/invoices/${b.id}/writeoff`, { amount: String(b.total), reason: 'Tenant gone' });
    assert.equal(res.status, 303);
    const w = db.get('SELECT * FROM col_writeoffs WHERE invoice_id = ?', b.id);
    assert.equal(w.status, 'pending');
    assert.equal(db.value('SELECT status FROM invoices WHERE id = ?', b.id), 'open', 'nothing written off yet');
    const other = db.get("SELECT * FROM users WHERE email = 'col-boss@thewave.test'") || db.get('SELECT * FROM users WHERE id = ?', Number(db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES ('Boss', 'col-boss@thewave.test', 'admin', 'x', datetime('now'))").lastInsertRowid));
    h.approvals.decide(w.approval_id, other, 'approved');
    assert.equal(db.value('SELECT status FROM col_writeoffs WHERE id = ?', w.id), 'done');
    assert.equal(db.value('SELECT status FROM invoices WHERE id = ?', b.id), 'paid');
    if (rule) h.approvals.setRule('writeoff', rule, admin.user);
    else h.approvals.setRule('writeoff', { active: 0, min_amount: 0, steps: [{ who: 'manager' }] }, admin.user);
  }
  assert.equal((await admin.go('/admin/collections/writeoffs')).status, 200);
});

test('promises and the call list: a promise takes the tenant off the list until its date; unpaid, it is broken', async () => {
  const t = await tenant('Promise Co', { monthsAgo: 2 });
  assert.ok(h.collections.worklist().some((w) => w.id === t.brand), 'overdue: on the call list');
  const res = await admin.form(`/admin/collections/tenants/${t.brand}/call`, { outcome: 'reached', promise_amount: '5000', promise_on: M.addDays(T(), 2), note: 'Pays Thursday' });
  assert.equal(res.status, 303);
  const p = db.get('SELECT * FROM col_promises WHERE brand_id = ?', t.brand);
  assert.equal(p.status, 'open');
  assert.ok(!h.collections.worklist().some((w) => w.id === t.brand), 'off the list while the promise stands');
  // the date passes with nothing paid
  db.run('UPDATE col_promises SET due_on = ? WHERE id = ?', M.addDays(T(), -1), p.id);
  db.run('UPDATE col_calls SET next_on = ? WHERE brand_id = ?', M.addDays(T(), -1), t.brand);
  h.collections.settlePromises();
  assert.equal(db.value('SELECT status FROM col_promises WHERE id = ?', p.id), 'broken');
  assert.ok(h.collections.worklist().some((w) => w.id === t.brand), 'back on the list');
  const page = await (await admin.go(`/admin/collections/tenants/${t.brand}`)).text();
  assert.match(page, /Pays Thursday/);
  assert.equal((await admin.go('/admin/collections')).status, 200);
});

test('payment plans: installments from the overdue invoices, kept from payments, reminders paused while kept', async () => {
  const t = await tenant('Plan Co', { monthsAgo: 3 });
  const late = invoices(t.lease.id, "kind = 'rent' AND status = 'open' AND due_date < date('now')");
  const total = late.reduce((s, i) => s + i.total - i.paid, 0);
  const res = await admin.form(`/admin/collections/tenants/${t.brand}/plans`, { inv: late.map((i) => String(i.id)), installments: '3', first_due: M.addDays(T(), -5), every: '1', grace: '3' });
  assert.equal(res.status, 303);
  const plan = db.get('SELECT * FROM col_plans WHERE brand_id = ?', t.brand);
  assert.ok(Math.abs(plan.total - total) < 0.01);
  const items = db.all('SELECT * FROM col_plan_items WHERE plan_id = ? ORDER BY n', plan.id);
  assert.equal(items.length, 3);
  assert.ok(Math.abs(items.reduce((s, x) => s + x.amount, 0) - total) < 0.01, 'installments add up');
  let st = h.collections.planState(plan);
  assert.equal(st.items[0].state, 'broken', 'first installment 5 days late, past 3 days of grace');
  // paid: kept
  h.billing.recordPayment({ invoice_id: late[0].id, amount: items[0].amount, date: T(), method: 'transfer' }, { user: admin.user });
  st = h.collections.planState(db.get('SELECT * FROM col_plans WHERE id = ?', plan.id));
  assert.equal(st.items[0].state, 'kept');
  assert.equal(st.status, 'active');
  // no reminders, no late charges on its invoices
  const before = db.value('SELECT COUNT(*) FROM col_reminders WHERE invoice_id = ?', late[1].id);
  h.collections.runReminders();
  assert.equal(db.value('SELECT COUNT(*) FROM col_reminders WHERE invoice_id = ?', late[1].id), before);
  assert.equal(h.collections.chargePenalty(db.get('SELECT * FROM invoices WHERE id = ?', late[1].id)), null);
  assert.ok(db.get("SELECT * FROM portal_notices WHERE entity = 'col_plan' AND entity_id = ?", plan.id), 'the tenant got the plan');
  assert.equal((await admin.go(`/admin/collections/plans/${plan.id}`)).status, 200);
  const lease = await (await admin.go(`/admin/leases/${t.lease.id}`)).text();
  assert.match(lease, new RegExp(plan.ref));
});

test('legal cases: stages, hearing dates with one alert each, papers and notes', async () => {
  const t = await tenant('Court Co', { monthsAgo: 2 });
  let res = await admin.form(`/admin/collections/tenants/${t.brand}/cases`, { stage: 'warning', amount: '25000', lawyer: 'A. Lawyer', owner_id: String(admin.user.id) });
  assert.equal(res.status, 303);
  const c = db.get('SELECT * FROM col_cases WHERE brand_id = ?', t.brand);
  res = await admin.form(`/admin/collections/cases/${c.id}`, { stage: 'filed', next_hearing: M.addDays(T(), 2), amount: '25000', lawyer: 'A. Lawyer', court: 'New Cairo Court', case_no: '123/2026', owner_id: String(admin.user.id), note: 'Filed today' });
  assert.equal(res.status, 303);
  const notes = db.all('SELECT kind FROM col_case_notes WHERE case_id = ?', c.id).map((n) => n.kind);
  assert.deepEqual(notes.filter((k) => k === 'stage').length, 2);
  assert.ok(notes.includes('hearing'));
  assert.ok(notes.includes('note'));
  const mails = () => db.value("SELECT COUNT(*) FROM outbox WHERE subject LIKE 'Hearing %' AND related_id = ?", c.id);
  h.collections.hearingAlerts();
  assert.equal(mails(), 1, 'an alert before the hearing');
  h.collections.hearingAlerts();
  assert.equal(mails(), 1, 'only once');
  // reminders pause for a tenant in a legal case
  const before = db.value('SELECT COUNT(*) FROM col_reminders WHERE brand_id = ?', t.brand);
  h.collections.runReminders();
  assert.equal(db.value('SELECT COUNT(*) FROM col_reminders WHERE brand_id = ?', t.brand), before);
  const page = await (await admin.go(`/admin/collections/cases/${c.id}`)).text();
  assert.match(page, /123\/2026/);
  assert.match(page, /data-upload|documents/);
  assert.equal((await admin.go('/admin/collections/cases')).status, 200);
});

test('addenda: a new rent from a date voids the unpaid invoices from then on and issues them again; paid ones stay', async () => {
  const t = await tenant('Addendum Co', { monthsAgo: 1, rate: 1000 });
  const all = invoices(t.lease.id, "kind = 'rent' AND status != 'void'");
  // pay a future one: it must not be touched
  const future = all.filter((i) => i.period_start > T());
  const eff = future[0].period_start;
  h.billing.recordPayment({ invoice_id: future[1].id, amount: future[1].total, date: T(), method: 'transfer' }, { user: admin.user });
  let res = await admin.form(`/admin/leases/${t.lease.id}/amendments`, { effective_date: eff, reason: 'Rent review', rate: '1200' });
  assert.equal(res.status, 303);
  const a = db.get('SELECT * FROM lease_amendments WHERE lease_id = ?', t.lease.id);
  assert.equal(a.status, 'draft');
  assert.equal(a.n, 1);
  const preview = await (await admin.go(`/admin/leases/${t.lease.id}/amendments/${a.id}`)).text();
  assert.match(preview, /Invoices voided/);
  res = await admin.form(`/admin/leases/${t.lease.id}/amendments/${a.id}/apply`, {});
  assert.equal(res.status, 303);
  const done = db.get('SELECT * FROM lease_amendments WHERE id = ?', a.id);
  assert.equal(done.status, 'applied');
  assert.equal(db.value('SELECT status FROM invoices WHERE id = ?', future[1].id), 'paid', 'a paid invoice is untouched');
  assert.equal(db.value('SELECT status FROM invoices WHERE id = ?', future[0].id), 'void');
  const fresh = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status = 'open' AND period_start = ?", t.lease.id, eff);
  const yearIdx = Math.floor((Date.parse(eff) - Date.parse(t.lease.start_date)) / (365.25 * 864e5));
  assert.equal(fresh.rent, Math.round(t.unit.indoor_m2 * 1200), `the new rent from ${eff} (year ${yearIdx + 1})`);
  assert.ok(!db.get("SELECT id FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status != 'void' AND period_start = ? AND id != ?", t.lease.id, future[1].period_start, future[1].id), 'the paid period is not billed twice');
  // a year later the yearly increase goes on from the new rent
  const nextYear = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status = 'open' AND period_start = ?", t.lease.id, M.addMonths(t.lease.start_date, 12));
  if (nextYear && M.addMonths(t.lease.start_date, 12) >= eff) assert.equal(nextYear.rent, Math.round(t.unit.indoor_m2 * 1200 * 1.1));
  // extend by 6 months: new invoices to the new end
  res = await admin.form(`/admin/leases/${t.lease.id}/amendments`, { effective_date: eff, extend_months: '6' });
  const b = db.get('SELECT * FROM lease_amendments WHERE lease_id = ? AND n = 2', t.lease.id);
  await admin.form(`/admin/leases/${t.lease.id}/amendments/${b.id}/apply`, {});
  const s = db.get('SELECT * FROM leases WHERE id = ?', t.lease.id);
  assert.equal(s.end_date, M.addDays(M.addMonths(t.lease.start_date, 30), -1));
  assert.equal(db.value("SELECT MAX(period_end) FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status != 'void'", s.id), s.end_date);
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status != 'void'", s.id), 30, 'one per month, none twice');
  assert.equal((await admin.go(`/admin/leases/${t.lease.id}/amendments/${a.id}/print?doc=ar`)).status, 200);
});

test('options: notice alerts at 90, 60 and 30 days, once each; a passed deadline lapses', async () => {
  const t = await tenant('Option Co', { monthsAgo: 1 });
  const res = await admin.form(`/admin/leases/${t.lease.id}/options`, { kind: 'break', party: 'tenant', notice_by: M.addDays(T(), 50), terms: 'Break at year 1' });
  assert.equal(res.status, 303);
  const o = db.get('SELECT * FROM lease_options WHERE lease_id = ?', t.lease.id);
  h.amendments.optionAlerts();
  assert.equal(db.value('SELECT alerts FROM lease_options WHERE id = ?', o.id), '90,60');
  const n = db.value("SELECT COUNT(*) FROM outbox WHERE subject LIKE '%break clause notice%'");
  assert.equal(n, 1, 'one email for the alerts due');
  h.amendments.optionAlerts();
  assert.equal(db.value("SELECT COUNT(*) FROM outbox WHERE subject LIKE '%break clause notice%'"), 1, 'not again');
  db.run('UPDATE lease_options SET notice_by = ? WHERE id = ?', M.addDays(T(), -1), o.id);
  h.amendments.optionAlerts();
  assert.equal(db.value('SELECT status FROM lease_options WHERE id = ?', o.id), 'lapsed');
  assert.equal((await admin.go('/admin/leases/renewals')).status, 200);
});

test('renewals: an accepted offer drafts a linked lease that can be activated on the same units', async () => {
  const t = await tenant('Renewal Co', { monthsAgo: 22, years: 2 });
  let res = await admin.form(`/admin/leases/${t.lease.id}/renewals`, { kind: 'lease', months: '36', rent_m2: '1300', escalation_pct: '8', deposit_topup: '0', carry_deposit: '1', send: '1' });
  assert.equal(res.status, 303);
  const r = db.get('SELECT * FROM lease_renewals WHERE lease_id = ?', t.lease.id);
  assert.equal(r.status, 'offered');
  assert.ok(r.notice_id, 'sent to the tenant');
  assert.equal((await admin.go(`/admin/leases/renewals/${r.id}/print?doc=ar`)).status, 200);
  res = await admin.form(`/admin/leases/renewals/${r.id}/accept`, {});
  assert.equal(res.status, 303);
  const n = db.get('SELECT * FROM leases WHERE renewed_from = ?', t.lease.id);
  assert.ok(n, 'a new lease');
  assert.equal(n.status, 'draft');
  assert.equal(n.start_date, M.addDays(t.lease.end_date, 1));
  assert.equal(n.rent_m2, 1300);
  assert.deepEqual(M.leaseUnits(db, n.id).map((u) => u.id), [t.unit.id]);
  res = await admin.form(`/admin/leases/${n.id}/activate`, {});
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT status FROM leases WHERE id = ?', n.id), 'active', 'the old lease holding the unit is not a clash');
  // the old lease ends: the unit stays leased to the new one
  await admin.form(`/admin/leases/${t.lease.id}/end`, { how: 'ended', date: t.lease.end_date });
  assert.equal(db.value('SELECT status FROM units WHERE id = ?', t.unit.id), 'leased');
});

test('settlement: the deposit pays what is owed and deductions, the rest is refunded, the lease ends', async () => {
  const t = await tenant('Settle Co', { monthsAgo: 4, deposit: 300000, rate: 100 });
  const dep = db.get("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'deposit'", t.lease.id);
  h.billing.recordPayment({ invoice_id: dep.id, amount: dep.total, date: T(), method: 'transfer' }, { user: admin.user });
  const owed = invoices(t.lease.id, "kind = 'rent' AND status = 'open' AND period_start <= date('now')").reduce((s, i) => s + i.total - i.paid, 0);
  db.setSetting('col_penalty_mode', 'none');
  let res = await admin.form(`/admin/leases/${t.lease.id}/settlement`, { how: 'terminated', last_day: T(), charge_penalties: '0', refund_method: 'transfer', ded_label_1: 'Broken glass', ded_amount_1: '12000', ded_label_2: 'Cleaning', ded_amount_2: '3000' });
  assert.equal(res.status, 303);
  const st = db.get('SELECT * FROM lease_settlements WHERE lease_id = ?', t.lease.id);
  assert.equal(st.status, 'draft');
  const page = await (await admin.go(`/admin/settlements/${st.id}`)).text();
  assert.match(page, /Broken glass/);
  assert.equal(db.value('SELECT status FROM leases WHERE id = ?', t.lease.id), 'active', 'nothing changes before it is confirmed');
  res = await admin.form(`/admin/settlements/${st.id}/confirm`, {});
  assert.equal(res.status, 303);
  const done = db.get('SELECT * FROM lease_settlements WHERE id = ?', st.id);
  assert.equal(done.deposit_held, 300000);
  assert.ok(Math.abs(done.applied - (owed + 15000)) < 0.02, `the deposit pays the rent owed and the deductions: ${JSON.stringify({ done, owed })}`);
  assert.ok(Math.abs(done.refund - (300000 - owed - 15000)) < 0.02, 'the rest is refunded');
  assert.equal(done.due, 0);
  assert.ok(['done', 'refund_pending'].includes(done.status));
  assert.equal(db.value('SELECT status FROM leases WHERE id = ?', t.lease.id), 'terminated');
  assert.equal(db.value('SELECT status FROM units WHERE id = ?', t.unit.id), 'available');
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE lease_id = ? AND status IN ('open','partial')", t.lease.id), 0, 'nothing left open');
  assert.ok(db.get("SELECT * FROM invoices WHERE lease_id = ? AND source = 'settlement' AND total = 15000", t.lease.id), 'deductions invoiced (no VAT)');
  assert.equal(db.value("SELECT COUNT(*) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.lease_id = ? AND p.method = 'deposit'", t.lease.id) > 0, true);
  if (done.status === 'done' && h.ledger) assert.ok(db.get('SELECT id FROM acc_entries WHERE source = ?', `settlement:${st.id}`), 'the refund is in the books');
  for (const l of ['en', 'ar']) assert.equal((await admin.go(`/admin/settlements/${st.id}/print?doc=${l}`)).status, 200);
  res = await admin.go(`/admin/leases/${t.lease.id}/settle`);
  assert.equal(res.status, 303, 'settled once');
});

test('reversing a receipt asks for approval when a refund rule applies', async () => {
  if (!h.approvals) return;
  const t = await tenant('Reverse Co', { monthsAgo: 1 });
  const inv = invoices(t.lease.id, "kind = 'rent' AND status = 'open'")[0];
  const out = h.billing.recordPayment({ invoice_id: inv.id, amount: inv.total, date: T(), method: 'transfer' }, { user: admin.user });
  const rule = h.approvals.ruleOf('refund');
  h.approvals.setRule('refund', { active: 1, min_amount: 1, steps: [{ who: 'admin' }] }, admin.user);
  let res = await admin.form(`/admin/payments/${out.payment.id}/reverse`, {});
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT status FROM payments WHERE id = ?', out.payment.id), 'received', 'waits for approval');
  const page = await (await admin.go(`/admin/invoices/${inv.id}`)).text();
  assert.match(page, /Reversal awaiting approval/);
  const req = h.approvals.pendingFor('payment', out.payment.id);
  const boss = db.get("SELECT * FROM users WHERE email = 'col-boss2@thewave.test'") || db.get('SELECT * FROM users WHERE id = ?', Number(db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES ('Boss 2', 'col-boss2@thewave.test', 'admin', 'x', datetime('now'))").lastInsertRowid));
  h.approvals.decide(req.id, boss, 'approved');
  assert.equal(db.value('SELECT status FROM payments WHERE id = ?', out.payment.id), 'reversed');
  if (rule) h.approvals.setRule('refund', rule, admin.user);
  else h.approvals.setRule('refund', { active: 0, min_amount: 0, steps: [{ who: 'manager' }] }, admin.user);
  res = await admin.go('/admin/collections/aging.csv');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Reverse Co|Tenant/);
});

test('every collections page opens in English and Arabic', async () => {
  const brand = db.value('SELECT brand_id FROM col_promises LIMIT 1');
  const plan = db.value('SELECT id FROM col_plans LIMIT 1');
  const kase = db.value('SELECT id FROM col_cases LIMIT 1');
  const pages = ['/admin/collections', '/admin/collections/aging', '/admin/collections/reminders', '/admin/collections/penalties', '/admin/collections/plans', '/admin/collections/cases',
    '/admin/collections/writeoffs', '/admin/collections/settings', `/admin/collections/tenants/${brand}`, `/admin/collections/plans/${plan}`, `/admin/collections/cases/${kase}`, '/admin/leases/renewals'];
  for (const lang of ['en', 'ar']) {
    await admin.form('/admin/lang', { lang, back: '/admin' });
    for (const p of pages) {
      const res = await admin.go(p);
      assert.equal(res.status, 200, `${lang} ${p}`);
      const html = await res.text();
      if (lang === 'ar') assert.doesNotMatch(html, /\b(?:col|amd)\|/, `${p}: no untranslated key`);
    }
  }
  await admin.form('/admin/lang', { lang: 'en', back: '/admin' });
  const res = await admin.form('/admin/collections/settings', { col_reminders_on: '1', col_steps: '-3, 0, 10, 20', col_whatsapp: '1', col_penalty_mode: 'per_day', col_penalty_rate: '50', col_penalty_grace: '5', col_penalty_cap: '5', col_penalty_min: '100', col_penalty_auto: '0', col_penalty_vat: '0', col_plan_grace: '5' });
  assert.equal(res.status, 303);
  assert.deepEqual(h.collections.steps(), [-3, 0, 10, 20]);
});
