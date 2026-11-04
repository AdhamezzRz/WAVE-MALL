'use strict';

// Sample data for collections and lease changes: the reminders already sent on the sample invoices,
// calls with a promise kept, one broken and one waiting, a payment plan with its first installment
// paid, a late charge (and one waived), a write-off, a legal case with a hearing coming up, an
// addendum raising one lease's rent, and renewal and break options with notice dates.

const M = require('./model');

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const TABLES = ['col_case_notes', 'col_cases', 'col_plan_items', 'col_plan_invoices', 'col_plans', 'col_writeoffs', 'col_penalties', 'col_promises', 'col_calls', 'col_reminders'];

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  if (!has(db, 'col_reminders') || db.value('SELECT COUNT(*) FROM col_calls WHERE demo = 1')) return;
  const T = M.today();
  const at = (days, hour = 11) => {
    const d = new Date(Date.now() + days * 86400000);
    d.setUTCHours(hour - 3, 20, 0, 0);
    return d.toISOString();
  };
  const uid = admin ? admin.id : null;
  const brand = (name) => db.get('SELECT * FROM brands WHERE name = ?', name);
  const lease = (b) => (b ? db.get("SELECT * FROM leases WHERE brand_id = ? AND status = 'active' ORDER BY id LIMIT 1", b.id) : null);
  const overdue = (b) => (b ? db.all("SELECT * FROM invoices WHERE brand_id = ? AND status IN ('open','partial') AND due_date < ? ORDER BY due_date", b.id, T) : []);
  const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
  const user = admin ? { id: admin.id, name: admin.name } : null;

  // ---------- two charges that went unpaid ----------
  if (h.billing) {
    const charge = (name, days, amount, note) => {
      const s = lease(brand(name));
      if (!s) return;
      try {
        h.billing.createInvoice({ lease_id: s.id, kind: 'other', due_date: M.addDays(T, days), other: amount, note, demo: 1 }, { user });
      } catch (e) {
        console.error('[demo] charge:', e.message);
      }
    };
    charge('Kahwa House', -38, 22800, 'Common area marketing contribution, Q3');
    charge('Lumière Beauty', -52, 9600, 'Extra security cover for late-night trading');
  }

  // ---------- reminders already sent (the steps that have passed) ----------
  const steps = [-7, 0, 7, 15, 30];
  for (const i of db.all("SELECT * FROM invoices WHERE status IN ('open','partial') AND brand_id IS NOT NULL AND kind NOT IN ('deposit') AND due_date <= ? AND due_date >= ?", M.addDays(T, 7), M.addDays(T, -120))) {
    for (const s of steps) {
      if (days(i.due_date, T) < s) continue;
      const when = M.addDays(i.due_date, s);
      db.run("INSERT OR IGNORE INTO col_reminders (invoice_id, brand_id, step, channels, status, user_id, demo, created_at) VALUES (?, ?, ?, 'portal,email', 'sent', NULL, 1, ?)", i.id, i.brand_id, s, `${when}T07:05:00.000Z`);
    }
  }

  // ---------- calls and promises ----------
  const call = (b, d, outcome, note, nextOn = null) => Number(db.run('INSERT INTO col_calls (brand_id, outcome, note, next_on, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', b.id, outcome, note, nextOn, uid, at(d)).lastInsertRowid);
  const promise = (b, callId, amount, dueOn, status, d, note) => db.run('INSERT INTO col_promises (brand_id, call_id, amount, due_on, note, status, closed_on, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    b.id, callId, amount, dueOn, note, status, status === 'open' ? null : M.addDays(dueOn, 1), uid, at(d));
  const kahwa = brand('Kahwa House');
  const lumiere = brand('Lumière Beauty');
  const saffron = brand('Saffron Table');
  if (kahwa && overdue(kahwa).length) {
    const owed = overdue(kahwa).reduce((s, i) => s + i.total - i.paid, 0);
    call(kahwa, -9, 'no_answer', 'Store phone rang out; left a message with the barista.', M.addDays(T, -7));
    const c = call(kahwa, -2, 'promised', 'Spoke to the owner. The transfer waits for their bank to clear a large supplier payment.', M.addDays(T, 4));
    promise(kahwa, c, Math.round(owed), M.addDays(T, 3), 'open', -2, 'Full amount by bank transfer');
  }
  if (lumiere && overdue(lumiere).length) {
    const owed = overdue(lumiere).reduce((s, i) => s + i.total - i.paid, 0);
    const c1 = call(lumiere, -16, 'promised', 'Finance manager promised to pay both invoices by the end of the week.', M.addDays(T, -11));
    promise(lumiere, c1, Math.round(owed), M.addDays(T, -12), 'broken', -16, 'Both invoices');
    call(lumiere, -8, 'dispute', 'Says the service charge on the second invoice is too high; sent them the calculation by email.', M.addDays(T, -1));
  }
  if (saffron) {
    const c = call(saffron, -26, 'promised', 'Opening costs ran over budget; agreed to split the quarter into three monthly payments.', null);
    db.run("UPDATE col_calls SET outcome = 'reached' WHERE id = ?", c);
  }

  // ---------- a payment plan, the first installment paid ----------
  const sInv = overdue(saffron);
  if (saffron && sInv.length && h.billing) {
    const total = Math.round(sInv.reduce((s, i) => s + i.total - i.paid, 0) * 100) / 100;
    const n = 3;
    const each = Math.floor((total / n) * 100) / 100;
    const created = at(-20);
    const first = M.addDays(T, -10);
    const pid = Number(db.run("INSERT INTO col_plans (ref, brand_id, lease_id, total, installments, first_due, every_months, grace_days, status, note, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 5, 'active', ?, ?, 1, ?)",
      db.nextRef('col_plans', 'PP', 4, true), saffron.id, sInv[0].lease_id, total, n, first, 'Opening quarter split in three', uid, created).lastInsertRowid);
    for (const i of sInv) db.run('INSERT INTO col_plan_invoices (plan_id, invoice_id) VALUES (?, ?)', pid, i.id);
    for (let k = 0; k < n; k++) db.run('INSERT INTO col_plan_items (plan_id, n, due_date, amount) VALUES (?, ?, ?, ?)', pid, k + 1, M.addMonths(first, k), k === n - 1 ? Math.round((total - each * (n - 1)) * 100) / 100 : each);
    try {
      h.billing.recordPayment({ invoice_id: sInv[0].id, amount: each, date: M.addDays(T, -9), method: 'transfer', reference: 'TRF-55120', note: 'Payment plan, installment 1', demo: 1 }, { user });
    } catch (e) {
      console.error('[demo] plan payment:', e.message);
    }
    // a post-dated cheque backs the last installment, when the sample cheques have one
    const chq = has(db, 'cheques') ? db.get("SELECT id FROM cheques WHERE brand_id = ? AND status = 'held' AND demo = 1 ORDER BY due_date DESC LIMIT 1", saffron.id) : null;
    if (chq) db.run('UPDATE col_plan_items SET cheque_id = ? WHERE plan_id = ? AND n = ?', chq.id, pid, n);
  }

  // ---------- late charges and write-offs ----------
  const C = h.collections;
  const lInv = overdue(lumiere);
  if (C && lInv.length) {
    try {
      const pen = C.chargePenalty(lInv[0], { user, notify: false });
      if (pen) {
        db.run('UPDATE col_penalties SET demo = 1 WHERE id = ?', pen.id);
        db.run('UPDATE invoices SET demo = 1 WHERE id = ?', pen.invoice.id);
      }
    } catch (e) {
      console.error('[demo] late charge:', e.message);
    }
  }
  if (C) {
    // a small utility bill the office agreed to drop after a meter fault
    const util = db.get("SELECT i.*, b.name brand_name FROM invoices i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.kind = 'utility' AND i.status = 'open' AND i.brand_id IS NOT NULL ORDER BY i.total LIMIT 1");
    if (util) {
      const id = Number(db.run("INSERT INTO col_writeoffs (ref, invoice_id, brand_id, amount, reason, status, requested_by, demo, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, 1, ?)",
        db.nextRef('col_writeoffs', 'WO', 4, true), util.id, util.brand_id, Math.round((util.total - util.paid) * 100) / 100, 'Meter fault: reading agreed with the tenant', uid, at(-3)).lastInsertRowid);
      try {
        C.applyWriteoff(db.get('SELECT * FROM col_writeoffs WHERE id = ?', id), { user });
        db.run("UPDATE payments SET demo = 1 WHERE method = 'writeoff' AND invoice_id = ?", util.id);
      } catch (e) {
        console.error('[demo] write-off:', e.message);
      }
    }
  }

  // ---------- a legal case ----------
  if (lumiere && lInv.length) {
    const owed = Math.round(lInv.reduce((s, i) => s + i.total - i.paid, 0));
    const cid = Number(db.run("INSERT INTO col_cases (ref, brand_id, lease_id, stage, status, amount, lawyer, court, case_no, next_hearing, opened_on, owner_id, demo, created_at, updated_at) VALUES (?, ?, ?, 'notice', 'open', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      db.nextRef('col_cases', 'LC', 4, true), lumiere.id, lInv[0].lease_id, owed, 'Hany Abdelaziz, Abdelaziz & Partners', 'New Cairo Economic Court', null, M.addDays(T, 9), M.addDays(T, -7), uid, at(-7), at(-1)).lastInsertRowid);
    const note = (d, kind, body, onDate = null) => db.run('INSERT INTO col_case_notes (case_id, kind, body, on_date, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', cid, kind, body, onDate, uid, at(d));
    note(-7, 'stage', 'warning');
    note(-7, 'note', 'Warning letter delivered to the store by hand; signed for by the store manager.');
    note(-1, 'stage', 'notice');
    note(-1, 'note', 'Formal notice served through the lawyer. Settlement meeting proposed before the hearing.');
    note(-1, 'hearing', M.addDays(T, 9), M.addDays(T, 9));
  }

  // ---------- an addendum: Kahwa House takes the terrace rate up after the seating area grew ----------
  const A = h.amendments;
  const kl = lease(kahwa);
  if (A && kl) {
    try {
      const nextStart = (db.get("SELECT period_start FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status = 'open' AND paid = 0 AND period_start > ? ORDER BY period_start LIMIT 1", kl.id, T) || {}).period_start;
      if (nextStart) {
        const rate = Math.round(A.rateOn(kl, nextStart) * 1.05);
        const aid = A.createAmendment(kl, { effective_date: nextStart, reason: 'Seating area extended onto the plaza; rent reviewed', changes: { rent: { rate, terrace: Math.round((kl.terrace_rent_m2 || 0) * 1.25), min_guarantee: null } } }, { user, demo: 1 });
        A.applyAmendment(db.get('SELECT * FROM lease_amendments WHERE id = ?', aid), { user });
        db.run("UPDATE invoices SET demo = 1 WHERE lease_id = ? AND created_at >= ? AND demo = 0", kl.id, at(-1));
      }
    } catch (e) {
      console.error('[demo] addendum:', e.message);
    }
  }

  // ---------- options with notice dates ----------
  const option = (s, kind, party, noticeBy, effectiveOn, terms) => db.run("INSERT INTO lease_options (lease_id, kind, party, notice_by, effective_on, terms, status, alerts, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', '', ?, 1, ?)", s.id, kind, party, noticeBy, effectiveOn, terms, uid, at(-30));
  const ll = lease(lumiere);
  if (ll) option(ll, 'break', 'tenant', M.addDays(T, 40), M.addMonths(ll.start_date, 24), 'Tenant may end the lease at the end of year 2 with six months\' notice and three months\' rent.');
  const sl = lease(saffron);
  if (sl) option(sl, 'renewal', 'tenant', M.addMonths(sl.end_date, -9), M.addDays(sl.end_date, 1), 'Five more years at the rent then, plus 10%.');
  if (kl) option(kl, 'renewal', 'either', M.addMonths(kl.end_date, -6), M.addDays(kl.end_date, 1), 'Three more years on the same terms.');
}

function clear(db) {
  if (!has(db, 'col_reminders')) return;
  db.tx(() => {
    for (const t of TABLES) if (has(db, t) && db.value(`SELECT COUNT(*) FROM pragma_table_info('${t}') WHERE name = 'demo'`)) db.run(`DELETE FROM ${t} WHERE demo = 1`);
    db.run('DELETE FROM col_plan_items WHERE plan_id NOT IN (SELECT id FROM col_plans)');
    db.run('DELETE FROM col_plan_invoices WHERE plan_id NOT IN (SELECT id FROM col_plans)');
    for (const t of ['lease_settlements', 'lease_renewals', 'lease_options', 'lease_amendments']) if (has(db, t)) db.run(`DELETE FROM ${t} WHERE demo = 1 OR lease_id IN (SELECT id FROM leases WHERE demo = 1)`);
  });
}

module.exports = { load, clear };
