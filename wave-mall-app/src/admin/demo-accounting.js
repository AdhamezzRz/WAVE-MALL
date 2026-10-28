'use strict';

// Sample books for the accounting module (loaded last, after the leasing, records and HR samples):
// two bank accounts, the mall's opening balances and fixed assets, depreciation to last month,
// supplier bills (from the sample service contracts and a few one-offs), a bank statement to
// reconcile, a budget, and the books closed to the end of the month before last.
// Everything carries demo = 1 (periods: note 'Sample data'), so clear() removes exactly it.

const { today } = require('./db');
const { ledger } = require('./ledger');

const NOTE = 'Sample data';
const r2 = (n) => Math.round(n * 100) / 100;

function load(db, admin, opts = {}) {
  const L = ledger(db, opts.h ? opts.h.events : null);
  if (db.value('SELECT COUNT(*) FROM acc_banks WHERE demo = 1')) return;
  const t = today();
  const year = Number(t.slice(0, 4));
  // (if someone has closed months already, the samples start on the first open day)
  const start = L.firstOpen(`${year - 1}-01-01`);
  const ym = t.slice(0, 7);
  const user = admin || null;
  // Sample data must always load: a step that cannot be done (a closed month, say) is skipped.
  const step = (fn) => {
    try {
      return fn();
    } catch (err) {
      console.warn('[accounting] sample step skipped:', err.message);
      return null;
    }
  };

  // Postings made while the other samples loaded went to the clearing account; they are redone
  // below once the banks exist, so receipts land in the right bank.
  db.run('DELETE FROM acc_entries WHERE demo = 1');

  const cib = L.createBank({ name: 'CIB current account', name_ar: 'البنك التجاري الدولي – حساب جاري', bank: 'Commercial International Bank', iban: 'EG380010001000000100012345678', opening_balance: 18500000, opening_date: start, user, demo: 1 });
  const misr = L.createBank({ name: 'Banque Misr collections', name_ar: 'بنك مصر – حساب التحصيلات', bank: 'Banque Misr', iban: 'EG020002000200000200098765432', opening_balance: 2400000, opening_date: start, user, demo: 1 });
  const code = (bank) => L.byId(bank.account_id).code;
  const set = (k, v) => { if (!L.S(k, '')) L.setS(k, v); };
  for (const m of ['transfer', 'cheque']) set(`method_${m}`, code(cib));
  for (const m of ['card', 'online', 'instapay', 'fawry', 'wallet']) set(`method_${m}`, code(misr));
  set('payroll_account', code(cib));
  set('payables_account', code(cib));
  db.setSetting('acc_demo_banks', [code(cib), code(misr)].join(','));

  // a few invoices with VAT (the marketing fund contribution), one of them paid
  const bill = opts.billing || require('./billing').billing(db, opts.h ? opts.h.events : require('./events').bus());
  const leases = db.all("SELECT id FROM leases WHERE demo = 1 AND status = 'active' ORDER BY id LIMIT 3");
  leases.forEach((l, i) => step(() => {
    const inv = bill.createInvoice({ lease_id: l.id, kind: 'other', other: [18000, 12500, 9800][i], vat_pct: 14, due_date: L.addDays(t, -(12 + i * 9)), note: 'Marketing fund contribution', demo: 1 });
    if (i === 0) bill.recordPayment({ invoice_id: inv.id, amount: inv.total, date: L.addDays(t, -6), method: 'transfer', reference: 'MKT-FUND', demo: 1 });
  }));

  // the building, its systems and equipment, brought in as opening balances
  const assets = [
    ['Mall building and structures', 'building', 380000000, 600, 'The Wave'],
    ['Central chillers and HVAC', 'mep', 28500000, 180, 'Plant room'],
    ['Escalators and lifts', 'mep', 17500000, 180, 'Atrium'],
    ['Common area furniture and signage', 'furniture', 6500000, 60, 'Plaza and food court'],
    ['CCTV, access control and IT', 'it', 2400000, 36, 'Security room'],
    ['Maintenance vehicles', 'vehicles', 1850000, 60, 'Service yard'],
  ];
  const cost = (cls) => r2(assets.filter((a) => a[1] === cls).reduce((s, a) => s + a[2], 0));
  const lines = [];
  for (const cls of ['building', 'mep', 'furniture', 'it', 'vehicles']) lines.push({ account: L.ASSET_CLASSES[cls][0], debit: cost(cls) });
  const total = r2(lines.reduce((s, l) => s + l.debit, 0));
  lines.push({ account: 'capital', credit: 400000000 }, { account: 'opening_equity', credit: r2(total - 400000000) });
  step(() => {
    L.post({ date: start, memo: 'Opening balances', kind: 'opening', lines, user, demo: 1 });
    for (const [name, cls, c, life, location] of assets) L.createAsset({ name, class: cls, cost: c, acquired_on: start, life_months: life, location, user, demo: 1 });
  });

  // everything the other samples did, now into the banks
  step(() => L.sync());
  step(() => L.runDepreciation(L.addMonthsYM(ym, -1), { user }));

  // suppliers and bills: the sample service contracts for the last three months, plus one-offs
  const pct = 14;
  if (opts.h && opts.h.accountingContractBills) {
    for (let k = 3; k >= 1; k--) step(() => opts.h.accountingContractBills(L.addMonthsYM(ym, -k + 1), { user, demo: 1 }));
  }
  const vendor = (name, extra = {}) => {
    const v = L.vendorFor(name, { demo: 1 });
    db.run('UPDATE acc_vendors SET tax_id = ?, phone = ?, email = ?, bank = ?, iban = ?, terms_days = ?, account_id = ?, demo = 1 WHERE id = ?',
      extra.tax_id || null, extra.phone || null, extra.email || null, extra.bank || null, extra.iban || null, extra.terms ?? 30, extra.account ? L.idOf(extra.account) : null, v.id);
    return db.get('SELECT * FROM acc_vendors WHERE id = ?', v.id);
  };
  const power = vendor('North Cairo Electricity Distribution', { tax_id: '100-200-300', account: 'exp_utilities', terms: 15, phone: '121' });
  const water = vendor('Cairo Water Company', { tax_id: '100-200-311', account: 'exp_utilities', terms: 15 });
  const ads = vendor('Blue Hour Media', { tax_id: '512-884-220', account: 'exp_marketing', email: 'billing@bluehour.example', bank: 'QNB', iban: 'EG150037000500000000123456789' });
  const audit = vendor('Hassan & Partners Chartered Accountants', { tax_id: '318-447-901', account: 'exp_professional', terms: 30 });
  const ins = vendor('Misr Insurance', { tax_id: '200-100-050', account: 'exp_insurance', terms: 30 });
  const mk = (...a) => step(() => db.tx(() => mkBill(...a)));
  const mkBill = (v, date, account, description, amount, vat, status, paidFrac = 0, memo = null) => {
    const b = L.createBill({ vendor_id: v.id, vendor_ref: `${2000 + v.id * 37}/${date.slice(2, 4)}${date.slice(5, 7)}`, date, lines: [{ account, description, amount }], vat: r2((amount * vat) / 100), memo, user, demo: 1 });
    if (status !== 'draft') L.approveBill(b.id, { user });
    if (paidFrac > 0) {
      const fresh = db.get('SELECT * FROM acc_bills WHERE id = ?', b.id);
      L.payBill(b.id, { amount: r2(fresh.total * paidFrac), date: L.addDays(fresh.due_date, -2) > t ? t : L.addDays(fresh.due_date, -2), account: cib.account_id, reference: String(704400 + b.id), user, demo: 1 });
    }
    return b;
  };
  for (let k = 3; k >= 1; k--) {
    const m = L.addMonthsYM(ym, -k);
    mk(power, `${m}-05`, 'exp_utilities', 'Common area electricity', 1180000 + k * 41000, pct, 'approved', 1);
    mk(water, `${m}-07`, 'exp_utilities', 'Water and drainage', 96000 + k * 3500, 0, 'approved', 1);
  }
  mk(power, `${ym}-05`, 'exp_utilities', 'Common area electricity', 1236000, pct, 'approved', 0);
  mk(ads, L.addDays(t, -40), 'exp_marketing', 'Autumn campaign: outdoor and social', 640000, pct, 'approved', 0.5, 'Autumn campaign');
  mk(ads, L.addDays(t, -4), 'exp_marketing', 'Opening weekend activation', 210000, pct, 'draft');
  mk(audit, L.addDays(t, -55), 'exp_professional', 'Interim audit fee', 185000, pct, 'approved', 0);
  mk(ins, `${year}-01-10`, 'exp_insurance', 'Property all risks and public liability', 2350000, 0, 'approved', 1);
  // approve and pay the older contract bills; this month's stay as drafts to approve
  for (const b of db.all("SELECT * FROM acc_bills WHERE demo = 1 AND status = 'draft' AND source LIKE 'contract:%' AND date < ? ORDER BY date", `${ym}-01`)) step(() => db.tx(() => {
    L.approveBill(b.id, { user });
    const fresh = db.get('SELECT * FROM acc_bills WHERE id = ?', b.id);
    if (fresh.due_date < t) L.payBill(b.id, { amount: fresh.total, date: fresh.due_date, account: cib.account_id, reference: String(704400 + b.id), user, demo: 1 });
  }));


  // bank charges and a transfer between the banks
  step(() => L.post({ date: L.addDays(t, -20), memo: 'Transfer from collections to the current account', lines: [{ account: cib.account_id, debit: 1500000 }, { account: misr.account_id, credit: 1500000 }], user, demo: 1 }));

  // the CIB statement: everything in the books except the last two lines, plus what the bank did alone
  const ledgerLines = db.all("SELECT l.*, e.date, e.memo, e.ref FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.kind != 'opening' ORDER BY e.date, l.id", cib.account_id);
  const rows = [['Date', 'Description', 'Reference', 'Debit', 'Credit']];
  const fmtDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  ledgerLines.slice(0, -2).forEach((l, i) => {
    const amount = r2(l.debit - l.credit);
    const d = L.addDays(l.date, i % 3 === 0 ? 1 : 0) > t ? l.date : L.addDays(l.date, i % 3 === 0 ? 1 : 0);
    const ref = (String(l.memo).match(/\b[A-Z]{2}-\d{4}-\d+\b/) || [''])[0];
    const desc = amount > 0 ? (/^Receipt/.test(l.memo) ? 'Incoming transfer' : 'Internal transfer in') : /^Salaries/.test(l.memo) ? 'Payroll transfer' : 'Outgoing transfer';
    rows.push([fmtDate(d), desc, ref, amount < 0 ? (-amount).toFixed(2) : '', amount > 0 ? amount.toFixed(2) : '']);
  });
  rows.push([fmtDate(L.addDays(t, -9)), 'Bank charges', '', '350.00', '']);
  rows.push([fmtDate(L.addDays(t, -9)), 'Account maintenance fee', '', '150.00', '']);
  rows.push([fmtDate(L.addDays(t, -3)), 'Interest received', '', '', '4820.00']);
  step(() => {
    L.importStatement(cib.id, rows.map((r) => r.join(',')).join('\n'), { file_name: 'cib-statement.csv', user, demo: 1 });
    L.autoMatch(cib.id);
  });

  // this year's budget: last year's actual months plus 8% (or this year's run rate)
  const fy = L.fiscalYear(t);
  const pl = L.profitLoss({ from: fy.from, to: L.monthEnd(L.addMonthsYM(ym, -1)) });
  const elapsed = Math.max(1, L.monthsBetween(fy.from.slice(0, 7), ym));
  for (let i = 0; i < 12; i++) {
    const m = L.addMonthsYM(fy.from.slice(0, 7), i);
    for (const r of [...pl.income, ...pl.expense]) {
      const v = Math.round(((r.amount / elapsed) * 1.08) / 1000) * 1000;
      if (v > 0) db.run('INSERT OR REPLACE INTO acc_budgets (period, account_id, amount) VALUES (?, ?, ?)', m, r.id, v);
    }
  }
  db.setSetting('acc_demo_budget', fy.from.slice(0, 7));

  // the books closed to the end of the month before last, and last year closed. Sample data must
  // always load: if anything is still unposted, the months simply stay open.
  try {
    L.sync();
    const closeTo = L.addMonthsYM(ym, -2);
    const ready = !L.lockDate() && closeTo >= L.nextToClose() && L.checklist(closeTo).every((c) => !c.required || c.ok);
    if (ready) {
      L.closeMonth(closeTo, { user, force: true, note: NOTE });
      db.run('UPDATE acc_periods SET note = ? WHERE note IS NULL', NOTE);
      const last = L.fiscalYear(L.addDays(fy.from, -1));
      if (L.lockDate() >= last.to) {
        const e = L.closeYear(last.from, { user });
        db.run('UPDATE acc_entries SET demo = 1 WHERE id = ?', e.id);
      }
    }
  } catch (err) {
    console.warn('[accounting] sample months left open:', err.message);
  }
}

function clear(db) {
  if (!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'acc_entries'")) return;
  const L = ledger(db);
  db.tx(() => {
    // entries of sample records, wherever they came from
    db.run(`DELETE FROM acc_entries WHERE demo = 1
      OR source_base IN (SELECT 'inv:' || id FROM invoices WHERE demo = 1 OR lease_id IN (SELECT id FROM leases WHERE demo = 1))
      OR source_base IN (SELECT 'pay:' || id FROM payments WHERE demo = 1 OR invoice_id IN (SELECT id FROM invoices WHERE demo = 1 OR lease_id IN (SELECT id FROM leases WHERE demo = 1)))
      OR source_base IN (SELECT 'payroll:' || id FROM payroll_runs WHERE demo = 1) OR source_base IN (SELECT 'payroll-paid:' || id FROM payroll_runs WHERE demo = 1)`);
    db.run("DELETE FROM acc_entries WHERE reverses_id IS NULL AND kind = 'reversal' AND demo = 1");
    db.run('DELETE FROM acc_statement_lines WHERE demo = 1 OR bank_id IN (SELECT id FROM acc_banks WHERE demo = 1)');
    db.run('DELETE FROM acc_imports WHERE demo = 1 OR bank_id IN (SELECT id FROM acc_banks WHERE demo = 1)');
    db.run('DELETE FROM acc_bill_payments WHERE demo = 1 OR bill_id IN (SELECT id FROM acc_bills WHERE demo = 1)');
    db.run('DELETE FROM acc_bills WHERE demo = 1');
    db.run('DELETE FROM acc_vendors WHERE demo = 1 AND id NOT IN (SELECT vendor_id FROM acc_bills)');
    db.run('DELETE FROM acc_assets WHERE demo = 1');
    // sample bank accounts, unless someone has posted to them since
    for (const b of db.all('SELECT * FROM acc_banks WHERE demo = 1')) {
      if (db.value('SELECT COUNT(*) FROM acc_lines WHERE account_id = ?', b.account_id)) continue;
      db.run('DELETE FROM acc_banks WHERE id = ?', b.id);
      db.run('DELETE FROM acc_budgets WHERE account_id = ?', b.account_id);
      db.run('DELETE FROM acc_accounts WHERE id = ? AND demo = 1', b.account_id);
    }
    // settings that pointed at the sample banks
    const codes = String(db.setting('acc_demo_banks') || '').split(',').filter(Boolean);
    for (const k of ['method_transfer', 'method_cheque', 'method_card', 'method_cash', 'method_online', 'method_instapay', 'method_fawry', 'method_wallet', 'payroll_account', 'payables_account']) {
      if (codes.includes(L.S(k, ''))) L.setS(k, '');
    }
    db.setSetting('acc_demo_banks', '');
    const bud = db.setting('acc_demo_budget');
    if (bud) {
      for (let i = 0; i < 12; i++) db.run('DELETE FROM acc_budgets WHERE period = ?', L.addMonthsYM(bud, i));
      db.setSetting('acc_demo_budget', '');
    }
    // the sample month closes
    if (db.value('SELECT COUNT(*) FROM acc_periods WHERE note = ?', NOTE)) {
      db.run('DELETE FROM acc_periods WHERE note = ?', NOTE);
      const last = db.value('SELECT MAX(period) FROM acc_periods');
      L.setS('lock_date', last ? L.monthEnd(last) : '');
    }
  });
}

module.exports = { load, clear };
