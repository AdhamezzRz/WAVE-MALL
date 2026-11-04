'use strict';

// Sample data for contract terms, cheques, salary advances and tenant notifications: the sample
// leases get stepped increases, a service charge as a share of the rent and their revenue share;
// each tenant hands over post-dated cheques (some deposited, one collected, one bounced); three
// employees have salary advances, repaid through the payrolls already approved; and the cheque
// notifications are part seen, part not.

const M = require('./model');

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const BANKS = ['National Bank of Egypt', 'CIB', 'Banque Misr', 'QNB', 'HSBC'];

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  if (!has(db, 'cheques') || db.value('SELECT COUNT(*) FROM cheques WHERE demo = 1')) return;
  const T = M.today();
  const now = () => new Date().toISOString();
  const user = admin ? { id: admin.id } : null;
  const brandLease = (name) => db.get("SELECT s.* FROM leases s JOIN brands b ON b.id = s.brand_id WHERE b.name = ? AND s.status = 'active' AND s.demo = 1", name);

  // ---------- contract terms on the sample leases ----------
  const kahwa = brandLease('Kahwa House');
  if (kahwa) db.run('UPDATE leases SET escalation_steps = ? WHERE id = ?', JSON.stringify([{ from: 4, pct: 12.5 }]), kahwa.id);
  const lumiere = brandLease('Lumière Beauty');
  if (lumiere) db.run("UPDATE leases SET service_mode = 'pct', service_pct = 8, vat_included = 1 WHERE id = ?", lumiere.id);
  // the revenue share the turnover module already bills, shown on the contract
  if (has(db, 'turnover_terms')) {
    for (const t of db.all('SELECT * FROM turnover_terms')) db.run('UPDATE leases SET revenue_share = 1, revenue_pct = ?, take_higher = ? WHERE id = ?', t.pct, t.breakpoint_type === 'none' ? 0 : 1, t.lease_id);
  }

  // ---------- cheques ----------
  let seq = 0;
  const cheque = (s, inv, { bank, status = 'held', received = -20 } = {}) => {
    const t = now();
    const id = Number(db.run(`INSERT INTO cheques (ref, number, bank, drawer, amount, due_date, brand_id, lease_id, invoice_id, status, received_on, received_by, demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, 1, ?, ?)`, db.nextRef('cheques', 'CQ', 5, true), String(10204500 + (seq += 37)), bank, db.value('SELECT name FROM brands WHERE id = ?', s.brand_id),
    Math.round((inv.total - inv.paid) * 100) / 100, inv.due_date, s.brand_id, s.id, inv.id, M.addDays(T, received), user ? user.id : null, t, t).lastInsertRowid);
    db.run("INSERT INTO cheque_events (cheque_id, status, user_id, at) VALUES (?, 'held', ?, ?)", id, user ? user.id : null, new Date(Date.now() + received * 86400000).toISOString());
    return id;
  };
  const C = h.cheques;
  const move = (id, to, extra = {}) => { if (C) C.move(C.chequeOf(id), to, { user, ...extra }); };
  db.tx(() => {
    for (const [k, s] of ['Maison Lune', 'Kahwa House', 'Lumière Beauty', 'Saffron Table'].map((n) => brandLease(n)).filter(Boolean).entries()) {
      const bank = BANKS[k % BANKS.length];
      const open = db.all("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status IN ('open','partial') ORDER BY due_date LIMIT 5", s.id);
      const ids = open.map((inv) => cheque(s, inv, { bank }));
      // what happened to the ones already due
      const late = db.value('SELECT name FROM brands WHERE id = ?', s.brand_id) === 'Saffron Table';
      open.forEach((inv, i) => {
        if (inv.due_date > T) return;
        if (late) {
          if (i === 0) { move(ids[i], 'deposited', { date: M.addDays(inv.due_date, 1), bank: 'CIB current account', ref: 'DS-4471' }); move(ids[i], 'bounced', { date: M.addDays(inv.due_date, 4), reason: 'chq|Insufficient funds' }); }
          else move(ids[i], 'deposited', { date: M.addDays(T, -1), bank: 'CIB current account', ref: 'DS-4480' });
        } else if (i === 0) {
          move(ids[i], 'deposited', { date: M.addDays(inv.due_date, 1), bank: 'CIB current account', ref: 'DS-4468' });
          move(ids[i], 'collected', { date: M.addDays(inv.due_date, 3) });
        } else move(ids[i], 'deposited', { date: M.addDays(T, -2), bank: 'CIB current account', ref: 'DS-4475' });
      });
    }
  });

  // ---------- tenant notifications: part seen, part not ----------
  if (has(db, 'notice_emails')) {
    const notices = db.all("SELECT * FROM portal_notices WHERE kind = 'cheque' AND demo = 1 ORDER BY id");
    notices.forEach((n, i) => {
      const users = db.all("SELECT id FROM portal_users WHERE (',' || ? || ',') LIKE ('%,' || brand_id || ',%')", n.brand_ids || '');
      if (i % 3 === 0) for (const u of users.slice(0, 1)) db.run('INSERT INTO portal_notice_reads (notice_id, portal_user_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', n.id, u.id, new Date(Date.now() - (i + 1) * 3600000).toISOString());
      if (i % 3 === 1) db.run('UPDATE notice_emails SET opened_at = ?, opens = 1 WHERE notice_id = ?', new Date(Date.now() - (i + 2) * 3600000).toISOString(), n.id);
    });
  }

  // ---------- salary advances ----------
  if (has(db, 'hr_advances')) {
    const emps = db.all("SELECT * FROM employees WHERE demo = 1 AND status = 'active' ORDER BY id LIMIT 6");
    const runs = db.all("SELECT * FROM payroll_runs WHERE demo = 1 AND status IN ('approved','paid') ORDER BY period");
    const advance = (e, amount, n, monthsAgo, reason, { cash = 0 } = {}) => {
      if (!e) return;
      const start = M.addMonths(`${T.slice(0, 7)}-01`, -monthsAgo + 1).slice(0, 7);
      const monthly = Math.round((amount / n) * 100) / 100;
      const id = Number(db.run("INSERT INTO hr_advances (ref, employee_id, amount, installments, monthly, start_period, issued_on, method, reason, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'cash', ?, ?, 1, ?)",
        db.nextRef('hr_advances', 'AD', 4, true), e.id, amount, n, monthly, start, M.addDays(`${start}-01`, -12), reason, user ? user.id : null, now()).lastInsertRowid);
      // the payrolls already approved took their installments
      let left = amount;
      for (const r of runs.filter((x) => x.period >= start)) {
        const take = Math.min(monthly, left);
        if (take <= 0) break;
        db.run("INSERT INTO hr_advance_repayments (advance_id, run_id, period, amount, source, created_at) VALUES (?, ?, ?, ?, 'payroll', ?)", id, r.id, r.period, take, now());
        db.run('UPDATE payroll_lines SET advance = advance + ?, net = net - ? WHERE run_id = ? AND employee_id = ?', take, take, r.id, e.id);
        left -= take;
      }
      if (cash && left > 0) {
        db.run("INSERT INTO hr_advance_repayments (advance_id, amount, source, paid_on, created_at) VALUES (?, ?, 'cash', ?, ?)", id, left, M.addDays(T, -9), now());
        left = 0;
      }
      if (left <= 0) db.run("UPDATE hr_advances SET status = 'settled' WHERE id = ?", id);
    };
    advance(emps[1], 9000, 6, 3, 'Family occasion');
    advance(emps[3], 4000, 2, 4, 'Car repair', { cash: 1 });
    advance(emps[4], 6000, 4, 0, 'School fees');
  }
}

function clear(db) {
  if (!has(db, 'cheques')) return;
  db.tx(() => {
    db.run('DELETE FROM cheques WHERE demo = 1');
    if (has(db, 'hr_advances')) db.run('DELETE FROM hr_advances WHERE demo = 1');
    if (has(db, 'notice_emails')) db.run("DELETE FROM portal_notices WHERE demo = 1 AND kind != 'notice'");
  });
}

module.exports = { load, clear };
