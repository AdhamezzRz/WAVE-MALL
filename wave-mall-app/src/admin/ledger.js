'use strict';

// The Wave's books: a double-entry general ledger.
//
//   Chart of accounts      acc_accounts (seeded on first run with an Egyptian mall chart)
//   Journal                acc_entries + acc_lines; every entry balances (debits = credits)
//   Automatic postings     invoices, payments, payroll, supplier bills, depreciation and
//                          key-money recognition post themselves (see sync() and the event
//                          listeners in routes/accounting.js), once each: an entry carries a
//                          source key (inv:12, pay:40, payroll:3 …) and is never posted twice
//   Periods                a lock date: nothing is posted on or before it. Closing a month moves
//                          the lock date; automatic postings that fall in a closed month are
//                          dated the first open day instead
//   Reports                trial balance, ledger, P&L, balance sheet, cash flow, VAT, ageing
//
// Money is rounded to 2 decimals. Account types: asset, liability, equity, income, expense.

const { now, today } = require('./db');
const { isAr } = require('./i18n');

const SCHEMA = `
  CREATE TABLE acc_accounts (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, key TEXT UNIQUE, type TEXT NOT NULL, sub TEXT,
    name_en TEXT NOT NULL, name_ar TEXT, parent_id INTEGER REFERENCES acc_accounts(id),
    is_group INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, system INTEGER NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE acc_entries (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, date TEXT NOT NULL, memo TEXT, kind TEXT NOT NULL DEFAULT 'manual',
    source TEXT UNIQUE, source_base TEXT, reverses_id INTEGER REFERENCES acc_entries(id) ON DELETE SET NULL,
    reversed_by INTEGER REFERENCES acc_entries(id) ON DELETE SET NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX acc_entries_date ON acc_entries(date);
  CREATE INDEX acc_entries_base ON acc_entries(source_base);
  CREATE TABLE acc_lines (
    id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES acc_entries(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES acc_accounts(id), debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0,
    memo TEXT, party_type TEXT, party_id INTEGER, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX acc_lines_entry ON acc_lines(entry_id);
  CREATE INDEX acc_lines_account ON acc_lines(account_id);
  CREATE TABLE acc_periods (period TEXT PRIMARY KEY, closed_at TEXT NOT NULL, closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, note TEXT);

  CREATE TABLE acc_banks (
    id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES acc_accounts(id), name TEXT NOT NULL, bank TEXT, iban TEXT,
    currency TEXT NOT NULL DEFAULT 'EGP', opening_balance REAL NOT NULL DEFAULT 0, opening_date TEXT, kind TEXT NOT NULL DEFAULT 'bank',
    active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE acc_imports (
    id INTEGER PRIMARY KEY, bank_id INTEGER NOT NULL REFERENCES acc_banks(id) ON DELETE CASCADE, file_name TEXT, rows INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE acc_statement_lines (
    id INTEGER PRIMARY KEY, bank_id INTEGER NOT NULL REFERENCES acc_banks(id) ON DELETE CASCADE, date TEXT NOT NULL,
    description TEXT, reference TEXT, amount REAL NOT NULL, balance REAL, import_id INTEGER REFERENCES acc_imports(id) ON DELETE CASCADE,
    matched_line_id INTEGER REFERENCES acc_lines(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'open',
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX acc_stmt_bank ON acc_statement_lines(bank_id, status);

  CREATE TABLE acc_vendors (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, tax_id TEXT, phone TEXT, email TEXT, bank TEXT, iban TEXT,
    contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL, account_id INTEGER REFERENCES acc_accounts(id),
    terms_days INTEGER NOT NULL DEFAULT 30, notes TEXT, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE acc_bills (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, vendor_id INTEGER NOT NULL REFERENCES acc_vendors(id), vendor_ref TEXT,
    date TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', net REAL NOT NULL DEFAULT 0, vat REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0, paid REAL NOT NULL DEFAULT 0, memo TEXT, source TEXT, source_id INTEGER,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, approved_at TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (source, source_id)
  );
  CREATE TABLE acc_bill_lines (
    id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES acc_bills(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES acc_accounts(id), description TEXT, amount REAL NOT NULL, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE acc_bill_payments (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, bill_id INTEGER NOT NULL REFERENCES acc_bills(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES acc_accounts(id), date TEXT NOT NULL, amount REAL NOT NULL, reference TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );

  CREATE TABLE acc_assets (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, name TEXT NOT NULL, class TEXT NOT NULL, cost REAL NOT NULL,
    acquired_on TEXT NOT NULL, life_months INTEGER NOT NULL, residual REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    disposed_on TEXT, proceeds REAL, location TEXT, notes TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE acc_depreciation (
    id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES acc_assets(id) ON DELETE CASCADE, period TEXT NOT NULL,
    amount REAL NOT NULL, entry_id INTEGER REFERENCES acc_entries(id) ON DELETE CASCADE, UNIQUE (asset_id, period)
  );
  CREATE TABLE acc_budgets (period TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES acc_accounts(id) ON DELETE CASCADE, amount REAL NOT NULL, PRIMARY KEY (period, account_id));
`;

// [code, key, type, sub, English, Arabic, parent code, is group]
const CHART = [
  ['1', null, 'asset', null, 'Assets', 'الأصول', null, 1],
  ['11', null, 'asset', null, 'Current assets', 'الأصول المتداولة', '1', 1],
  ['1100', 'cash_group', 'asset', 'cash', 'Cash and banks', 'النقدية والبنوك', '11', 1],
  ['1110', 'petty_cash', 'asset', 'cash', 'Petty cash', 'العهدة النقدية (الخزينة)', '1100', 0],
  ['1190', 'bank_clearing', 'asset', 'cash', 'Bank clearing (unassigned)', 'حساب بنكي وسيط (غير مخصص)', '1100', 0],
  ['1200', 'ar', 'asset', 'receivable', 'Accounts receivable – tenants', 'الذمم المدينة – المستأجرون', '11', 0],
  ['1210', 'other_receivables', 'asset', 'current', 'Other receivables', 'ذمم مدينة أخرى', '11', 0],
  ['1300', 'prepaid', 'asset', 'current', 'Prepaid expenses', 'مصروفات مدفوعة مقدمًا', '11', 0],
  ['1400', 'vat_in', 'asset', 'current', 'VAT input', 'ضريبة القيمة المضافة – مدخلات', '11', 0],
  ['15', null, 'asset', 'fixed', 'Fixed assets', 'الأصول الثابتة', '1', 1],
  ['1510', 'fa_building', 'asset', 'fixed', 'Buildings and structures', 'المباني والإنشاءات', '15', 0],
  ['1511', 'ad_building', 'asset', 'accum', 'Accumulated depreciation – buildings', 'مجمع إهلاك المباني', '15', 0],
  ['1520', 'fa_fitout', 'asset', 'fixed', 'Fit-out and improvements', 'التجهيزات والتحسينات', '15', 0],
  ['1521', 'ad_fitout', 'asset', 'accum', 'Accumulated depreciation – fit-out', 'مجمع إهلاك التجهيزات', '15', 0],
  ['1530', 'fa_mep', 'asset', 'fixed', 'MEP and equipment', 'المعدات والأنظمة الكهروميكانيكية', '15', 0],
  ['1531', 'ad_mep', 'asset', 'accum', 'Accumulated depreciation – MEP', 'مجمع إهلاك المعدات', '15', 0],
  ['1540', 'fa_furniture', 'asset', 'fixed', 'Furniture and fixtures', 'الأثاث والتركيبات', '15', 0],
  ['1541', 'ad_furniture', 'asset', 'accum', 'Accumulated depreciation – furniture', 'مجمع إهلاك الأثاث', '15', 0],
  ['1550', 'fa_it', 'asset', 'fixed', 'IT equipment', 'أجهزة الحاسب والأنظمة', '15', 0],
  ['1551', 'ad_it', 'asset', 'accum', 'Accumulated depreciation – IT', 'مجمع إهلاك أجهزة الحاسب', '15', 0],
  ['1560', 'fa_vehicles', 'asset', 'fixed', 'Vehicles', 'وسائل النقل', '15', 0],
  ['1561', 'ad_vehicles', 'asset', 'accum', 'Accumulated depreciation – vehicles', 'مجمع إهلاك وسائل النقل', '15', 0],
  ['2', null, 'liability', null, 'Liabilities', 'الالتزامات', null, 1],
  ['2100', 'ap', 'liability', 'payable', 'Accounts payable – suppliers', 'الذمم الدائنة – الموردون', '2', 0],
  ['2200', 'deposits', 'liability', 'liability', 'Tenant security deposits held', 'تأمينات المستأجرين المحتجزة', '2', 0],
  ['2210', 'fitout_deposits', 'liability', 'liability', 'Fit-out deposits held', 'تأمينات التجهيز المحتجزة', '2', 0],
  ['2300', 'unearned', 'liability', 'liability', 'Unearned income – key money', 'إيرادات مؤجلة – الخلو', '2', 0],
  ['2400', 'vat_out', 'liability', 'liability', 'VAT output', 'ضريبة القيمة المضافة – مخرجات', '2', 0],
  ['2500', 'salaries_payable', 'liability', 'liability', 'Salaries payable', 'رواتب مستحقة', '2', 0],
  ['2510', 'si_payable', 'liability', 'liability', 'Social insurance payable', 'التأمينات الاجتماعية المستحقة', '2', 0],
  ['2520', 'tax_payable', 'liability', 'liability', 'Payroll income tax withheld', 'ضريبة كسب العمل المستقطعة', '2', 0],
  ['2600', 'accrued', 'liability', 'liability', 'Accrued expenses', 'مصروفات مستحقة', '2', 0],
  ['3', null, 'equity', null, 'Equity', 'حقوق الملكية', null, 1],
  ['3100', 'capital', 'equity', 'equity', 'Share capital', 'رأس المال', '3', 0],
  ['3200', 'retained', 'equity', 'equity', 'Retained earnings', 'الأرباح المحتجزة', '3', 0],
  ['3900', 'opening_equity', 'equity', 'equity', 'Opening balances', 'أرصدة افتتاحية', '3', 0],
  ['4', null, 'income', null, 'Income', 'الإيرادات', null, 1],
  ['4100', 'inc_rent', 'income', 'income', 'Base rent', 'إيراد الإيجار الأساسي', '4', 0],
  ['4200', 'inc_service', 'income', 'income', 'Service charge income', 'إيراد رسوم الخدمات', '4', 0],
  ['4300', 'inc_turnover', 'income', 'income', 'Turnover rent', 'إيراد إيجار نسبة المبيعات', '4', 0],
  ['4400', 'inc_specialty', 'income', 'income', 'Specialty leasing', 'إيراد المساحات المؤقتة', '4', 0],
  ['4500', 'inc_utility', 'income', 'income', 'Utility recharges', 'إيراد استرداد المرافق', '4', 0],
  ['4600', 'inc_key', 'income', 'income', 'Key money income', 'إيراد الخلو', '4', 0],
  ['4700', 'inc_other', 'income', 'income', 'Penalties and other income', 'الغرامات والإيرادات الأخرى', '4', 0],
  ['5', null, 'expense', null, 'Expenses', 'المصروفات', null, 1],
  ['5100', 'exp_salaries', 'expense', 'expense', 'Salaries and wages', 'الرواتب والأجور', '5', 0],
  ['5110', 'exp_si', 'expense', 'expense', 'Employer social insurance', 'حصة صاحب العمل في التأمينات', '5', 0],
  ['5200', 'exp_maintenance', 'expense', 'expense', 'Maintenance and repairs', 'الصيانة والإصلاحات', '5', 0],
  ['5210', 'exp_security', 'expense', 'expense', 'Security', 'الأمن والحراسة', '5', 0],
  ['5220', 'exp_cleaning', 'expense', 'expense', 'Cleaning', 'النظافة', '5', 0],
  ['5230', 'exp_utilities', 'expense', 'expense', 'Utilities', 'المرافق (كهرباء ومياه)', '5', 0],
  ['5300', 'exp_marketing', 'expense', 'expense', 'Marketing', 'التسويق والفعاليات', '5', 0],
  ['5400', 'exp_insurance', 'expense', 'expense', 'Insurance', 'التأمين', '5', 0],
  ['5500', 'exp_professional', 'expense', 'expense', 'Professional fees', 'الأتعاب المهنية', '5', 0],
  ['5600', 'exp_bank', 'expense', 'expense', 'Bank charges', 'المصروفات البنكية', '5', 0],
  ['5700', 'exp_depreciation', 'expense', 'expense', 'Depreciation', 'الإهلاك', '5', 0],
  ['5900', 'exp_other', 'expense', 'expense', 'Other expenses', 'مصروفات أخرى', '5', 0],
];

// The fixed-asset classes: cost account, accumulated depreciation, default life (months).
const ASSET_CLASSES = {
  building: ['fa_building', 'ad_building', 600], fitout: ['fa_fitout', 'ad_fitout', 120], mep: ['fa_mep', 'ad_mep', 180],
  furniture: ['fa_furniture', 'ad_furniture', 60], it: ['fa_it', 'ad_it', 36], vehicles: ['fa_vehicles', 'ad_vehicles', 60],
};
// What each invoice kind earns (or holds). Editable in Settings (acc_map_<kind>).
const KIND_ACCOUNTS = {
  rent: 'inc_rent', service: 'inc_service', turnover: 'inc_turnover', service_recon: 'inc_service', utility: 'inc_utility',
  specialty: 'inc_specialty', key: 'inc_key', other: 'inc_other', penalty: 'inc_other', deposit: 'deposits', fitout: 'fitout_deposits',
};
// Supplier spending by category (maintenance module, service-contract kinds).
const CATEGORY_ACCOUNTS = {
  maintenance: 'exp_maintenance', elevators: 'exp_maintenance', landscaping: 'exp_maintenance', repairs: 'exp_maintenance', hvac: 'exp_maintenance',
  electrical: 'exp_maintenance', plumbing: 'exp_maintenance', security: 'exp_security', cleaning: 'exp_cleaning', waste: 'exp_cleaning',
  utilities: 'exp_utilities', marketing: 'exp_marketing', insurance: 'exp_insurance', consultancy: 'exp_professional', professional: 'exp_professional',
  it: 'exp_other', parking: 'exp_other', supplies: 'exp_other', other: 'exp_other',
};
const METHODS = ['transfer', 'cheque', 'card', 'cash', 'online', 'instapay', 'fawry', 'wallet'];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const pad = (n) => String(n).padStart(2, '0');
const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};
const addMonthsYM = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
const addDays = (iso, n) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

function ledger(db, events = null) {
  db.ensure('accounting-1', SCHEMA);
  // seed the chart once
  if (!db.value('SELECT COUNT(*) FROM acc_accounts')) {
    db.tx(() => {
      const ids = {};
      for (const [code, key, type, sub, en, ar, parent, group] of CHART) {
        ids[code] = Number(db.run(
          'INSERT INTO acc_accounts (code, key, type, sub, name_en, name_ar, parent_id, is_group, system, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
          code, key, type, sub, en, ar, parent ? ids[parent] : null, group, now(),
        ).lastInsertRowid);
      }
    });
  }

  const S = (k, d = '') => {
    const v = db.setting(`acc_${k}`);
    return v === undefined || v === null || v === '' ? d : v;
  };
  const setS = (k, v) => db.setSetting(`acc_${k}`, v);

  // ---------- accounts ----------
  const byKey = (key) => db.get('SELECT * FROM acc_accounts WHERE key = ?', key);
  const byCode = (code) => db.get('SELECT * FROM acc_accounts WHERE code = ?', String(code));
  const byId = (id) => db.get('SELECT * FROM acc_accounts WHERE id = ?', id);
  // an account given as a row, an id (number), a key ('ar') or a code ('1200')
  const resolve = (a) => {
    if (a && typeof a === 'object') return a;
    if (typeof a === 'number') return byId(a);
    return a ? byKey(String(a)) || byCode(String(a)) : null;
  };
  const idOf = (key) => {
    const a = resolve(key);
    if (!a) throw new Error(`Unknown account ${key}`);
    return a.id;
  };
  const name = (a) => (a ? (isAr() && a.name_ar ? a.name_ar : a.name_en) : '');
  const label = (a) => (a ? `${a.code} · ${name(a)}` : '');
  const natural = (type) => (type === 'asset' || type === 'expense' ? 1 : -1);
  const accounts = ({ postable = false, type = null, activeOnly = false } = {}) => db.all(
    `SELECT * FROM acc_accounts WHERE 1 = 1 ${postable ? 'AND is_group = 0' : ''} ${activeOnly ? 'AND active = 1' : ''} ${type ? 'AND type = ?' : ''} ORDER BY code`,
    ...(type ? [type] : []),
  );
  // the next free code under a parent (bank accounts 1120, 1121 …)
  function nextCode(parentCode, start) {
    let c = Number(start);
    while (byCode(String(c))) c++;
    return String(c);
  }
  function createAccount({ code, name_en, name_ar, type, sub, parent_id, key = null, demo = 0 }) {
    if (!code || !name_en) throw new Error('Give the account a code and a name.');
    if (byCode(code)) throw new Error('That account code is already used.');
    const parent = parent_id ? byId(parent_id) : null;
    const t = parent ? parent.type : type;
    if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(t)) throw new Error('Choose the account type.');
    return Number(db.run(
      'INSERT INTO acc_accounts (code, key, type, sub, name_en, name_ar, parent_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      String(code), key, t, sub || (parent ? parent.sub : null) || (t === 'income' ? 'income' : t === 'expense' ? 'expense' : t === 'equity' ? 'equity' : t === 'liability' ? 'liability' : 'current'),
      name_en, name_ar || null, parent ? parent.id : null, demo ? 1 : 0, now(),
    ).lastInsertRowid);
  }
  const hasLines = (id) => !!db.value('SELECT COUNT(*) FROM acc_lines WHERE account_id = ?', id);

  // ---------- periods ----------
  const lockDate = () => S('lock_date', '') || null;
  const isLocked = (date) => !!lockDate() && String(date).slice(0, 10) <= lockDate();
  const firstOpen = (date) => (isLocked(date) ? addDays(lockDate(), 1) : date);
  const fyStart = () => Math.min(12, Math.max(1, Number(S('fy_start', '1')) || 1));
  function fiscalYear(date = today()) {
    const s = fyStart();
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    const startY = m >= s ? y : y - 1;
    const from = `${startY}-${pad(s)}-01`;
    const to = addDays(`${addMonthsYM(`${startY}-${pad(s)}`, 12)}-01`, -1);
    return { from, to, label: s === 1 ? String(startY) : `${startY}/${String(startY + 1).slice(2)}`, year: startY };
  }

  // ---------- posting ----------
  function post({ date, memo = '', kind = 'manual', source = null, lines, user = null, demo = 0, reverses = null, allowLocked = false }) {
    if (!isDate(date)) throw new Error('Choose a valid date.');
    if (!allowLocked && isLocked(date)) throw new Error('That date is in a closed period.');
    const rows = (lines || [])
      .map((l, i) => ({ ...l, account_id: idOf(l.account), debit: r2(l.debit), credit: r2(l.credit), sort: i }))
      .filter((l) => l.debit || l.credit);
    if (rows.length < 2) throw new Error('An entry needs at least two lines.');
    for (const l of rows) {
      if (l.debit < 0 || l.credit < 0 || (l.debit && l.credit)) throw new Error('Each line is either a debit or a credit, above zero.');
      const a = byId(l.account_id);
      if (!a || a.is_group) throw new Error('Post to an account, not a group.');
    }
    const dr = r2(rows.reduce((s, l) => s + l.debit, 0));
    const cr = r2(rows.reduce((s, l) => s + l.credit, 0));
    if (Math.abs(dr - cr) > 0.005) throw new Error('Debits and credits must be equal.');
    return db.tx(() => {
      const id = Number(db.run(
        'INSERT INTO acc_entries (ref, date, memo, kind, source, source_base, reverses_id, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('acc_entries', 'JV', 4, true), date, memo || null, kind, source, source ? source.replace(/#\d+$/, '') : null, reverses,
        user ? user.id : null, demo ? 1 : 0, now(),
      ).lastInsertRowid);
      for (const l of rows) {
        db.run('INSERT INTO acc_lines (entry_id, account_id, debit, credit, memo, party_type, party_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id, l.account_id, l.debit, l.credit, l.memo || null, l.party_type || null, l.party_id ?? null, l.sort);
      }
      return entry(id);
    });
  }
  const entry = (id) => db.get('SELECT * FROM acc_entries WHERE id = ?', id);
  const linesOf = (id) => db.all('SELECT l.*, a.code, a.name_en, a.name_ar, a.type FROM acc_lines l JOIN acc_accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.sort, l.id', id);
  // the live (not reversed) automatic entry for a source key, if any
  const active = (base) => db.get("SELECT * FROM acc_entries WHERE source_base = ? AND reversed_by IS NULL AND reverses_id IS NULL ORDER BY id DESC LIMIT 1", base);
  // Post once per source key; a reversed source can be posted again (base#2, base#3 …).
  function postOnce(base, build) {
    const live = active(base);
    if (live) return { entry: live, created: false };
    const spec = build();
    if (!spec) return { entry: null, created: false };
    const n = db.value('SELECT COUNT(*) FROM acc_entries WHERE source_base = ?', base) + 1;
    const date = firstOpen(spec.date);
    return { entry: post({ kind: 'auto', ...spec, date, source: `${base}#${n}`, allowLocked: false }), created: true };
  }
  // A reversing entry (swapped lines) dated `date` (or the first open day).
  function reverse(entryId, { date = today(), memo = null, user = null, exact = false } = {}) {
    const e = entry(entryId);
    if (!e) throw new Error('That entry no longer exists.');
    if (e.reversed_by) throw new Error('This entry is already reversed.');
    if (e.kind === 'reversal') throw new Error('A reversal cannot be reversed; post a new entry instead.');
    const lines = linesOf(e.id).map((l) => ({ account: l.account_id, debit: l.credit, credit: l.debit, memo: l.memo, party_type: l.party_type, party_id: l.party_id }));
    return db.tx(() => {
      const r = post({
        date: exact ? date : firstOpen(date < e.date ? e.date : date), memo: memo || `Reversal of ${e.ref}`, kind: e.kind === 'closing' ? 'closing' : 'reversal', lines, user, demo: e.demo, reverses: e.id,
        source: e.source_base ? `rev:${e.source_base}:${e.id}` : null, allowLocked: exact,
      });
      db.run('UPDATE acc_entries SET reversed_by = ? WHERE id = ?', r.id, e.id);
      return r;
    });
  }
  const unpost = (base, opts) => {
    const live = active(base);
    return live ? reverse(live.id, opts) : null;
  };

  // ---------- automatic postings ----------
  const kindAccount = (kind) => S(`map_${kind}`, '') && byCode(S(`map_${kind}`)) ? byCode(S(`map_${kind}`)).id : idOf(KIND_ACCOUNTS[kind] || 'inc_other');
  const methodAccount = (method) => {
    const code = S(`method_${method || 'transfer'}`, '');
    if (code && byCode(code)) return byCode(code).id;
    return idOf(method === 'cash' ? 'petty_cash' : 'bank_clearing');
  };
  const party = (inv) => (inv.brand_id ? { party_type: 'brand', party_id: inv.brand_id } : {});
  const partyName = (inv) => (inv.brand_id ? db.value('SELECT name FROM brands WHERE id = ?', inv.brand_id) : null) || inv.customer || '';
  const keyDeferred = () => S('key_treatment', 'income') === 'deferred';

  function postInvoice(inv, { upTo = today() } = {}) {
    if (!inv || inv.status === 'void' || !(inv.total > 0) || inv.due_date > upTo) return null;
    return postOnce(`inv:${inv.id}`, () => {
      const p = party(inv);
      const vat = r2(inv.vat || 0);
      const lines = [{ account: 'ar', debit: inv.total, ...p }];
      const main = inv.kind === 'key' && keyDeferred() ? idOf('unearned') : kindAccount(inv.kind);
      const rentAcc = inv.kind === 'rent' ? kindAccount('rent') : main;
      if (inv.rent) lines.push({ account: rentAcc, credit: inv.rent, ...p });
      if (inv.service) lines.push({ account: kindAccount('service'), credit: inv.service, ...p });
      if (inv.other) lines.push({ account: inv.kind === 'rent' ? kindAccount('other') : main, credit: inv.other, ...p });
      if (vat) lines.push({ account: 'vat_out', credit: vat, ...p });
      // whatever the components do not explain (an invoice with an explicit total) goes to the kind
      const diff = r2(inv.total - lines.slice(1).reduce((s, l) => s + l.credit, 0));
      if (diff) lines.push(diff > 0 ? { account: main, credit: diff, ...p } : { account: main, debit: -diff, ...p });
      return { date: inv.due_date, memo: `Invoice ${inv.ref} · ${partyName(inv)}`, lines, demo: inv.demo };
    }).entry;
  }
  function postPayment(pay) {
    if (!pay || pay.status !== 'received' || !(pay.amount > 0)) return null;
    const inv = pay.invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', pay.invoice_id) : null;
    return postOnce(`pay:${pay.id}`, () => {
      const p = inv ? party(inv) : pay.brand_id ? { party_type: 'brand', party_id: pay.brand_id } : {};
      return {
        date: pay.date, memo: `Receipt ${pay.ref}${inv ? ` · ${inv.ref}` : ''}`, demo: pay.demo,
        lines: [{ account: methodAccount(pay.method), debit: pay.amount, ...p }, { account: 'ar', credit: pay.amount, ...p }],
      };
    }).entry;
  }
  function payrollTotals(runId) {
    const t = db.get(`SELECT COALESCE(SUM(net),0) net, COALESCE(SUM(insurance_employee),0) ie, COALESCE(SUM(insurance_employer),0) ir,
      COALESCE(SUM(tax),0) tax, COALESCE(SUM(deductions),0) ded FROM payroll_lines WHERE run_id = ?`, runId);
    return { net: r2(t.net), ie: r2(t.ie), ir: r2(t.ir), tax: r2(t.tax), ded: r2(t.ded), gross: r2(t.net + t.ie + t.tax + t.ded) };
  }
  function postPayroll(run) {
    if (!run || !['approved', 'paid'].includes(run.status)) return null;
    const t = payrollTotals(run.id);
    if (!(t.gross > 0)) return null;
    return postOnce(`payroll:${run.id}`, () => ({
      date: monthEnd(run.period), memo: `Payroll ${run.period}`, demo: run.demo,
      lines: [
        { account: 'exp_salaries', debit: t.gross },
        { account: 'exp_si', debit: t.ir },
        { account: 'salaries_payable', credit: t.net },
        { account: 'si_payable', credit: r2(t.ie + t.ir) },
        { account: 'tax_payable', credit: t.tax },
        { account: 'other_receivables', credit: t.ded },
      ],
    })).entry;
  }
  function postPayrollPaid(run) {
    if (!run || run.status !== 'paid') return null;
    const t = payrollTotals(run.id);
    if (!(t.net > 0)) return null;
    const code = S('payroll_account', '');
    const bank = code && byCode(code) ? byCode(code).id : methodAccount('transfer');
    return postOnce(`payroll-paid:${run.id}`, () => ({
      date: run.paid_at || monthEnd(run.period), memo: `Salaries paid ${run.period}`, demo: run.demo,
      lines: [{ account: 'salaries_payable', debit: t.net }, { account: bank, credit: t.net }],
    })).entry;
  }
  // Deferred key money: recognised straight-line over the lease, one entry per month end.
  function recogniseKeyMoney(upTo = today()) {
    if (!keyDeferred()) return 0;
    let n = 0;
    const invs = db.all("SELECT i.*, s.start_date, s.end_date, s.term_years FROM invoices i JOIN leases s ON s.id = i.lease_id WHERE i.kind = 'key' AND i.status != 'void'");
    for (const inv of invs) {
      const posted = active(`inv:${inv.id}`);
      if (!posted || !linesOf(posted.id).some((l) => l.account_id === idOf('unearned'))) continue;
      const months = Math.max(1, (inv.term_years || 1) * 12);
      const net = r2(inv.total - (inv.vat || 0));
      const per = r2(net / months);
      const start = inv.start_date.slice(0, 7);
      for (let k = 0; k < months; k++) {
        const ym = addMonthsYM(start, k);
        if (monthEnd(ym) > upTo) break;
        const amount = k === months - 1 ? r2(net - per * (months - 1)) : per;
        const r = postOnce(`keyrec:${inv.id}:${ym}`, () => ({
          date: monthEnd(ym), memo: `Key money recognised ${ym} · ${inv.ref}`, demo: inv.demo,
          lines: [{ account: 'unearned', debit: amount, ...party(inv) }, { account: 'inc_key', credit: amount, ...party(inv) }],
        }));
        if (r.created) n++;
      }
    }
    return n;
  }
  const billPartyLines = (bill) => ({ party_type: 'vendor', party_id: bill.vendor_id });
  function postBill(bill) {
    if (!bill || !['approved', 'partial', 'paid'].includes(bill.status)) return null;
    return postOnce(`bill:${bill.id}`, () => {
      const p = billPartyLines(bill);
      const lines = db.all('SELECT * FROM acc_bill_lines WHERE bill_id = ? ORDER BY sort, id', bill.id).map((l) => ({ account: l.account_id, debit: l.amount, memo: l.description, ...p }));
      if (bill.vat) lines.push({ account: 'vat_in', debit: bill.vat, ...p });
      lines.push({ account: 'ap', credit: bill.total, ...p });
      const v = db.get('SELECT name FROM acc_vendors WHERE id = ?', bill.vendor_id);
      return { date: bill.date, memo: `Supplier bill ${bill.ref} · ${v ? v.name : ''}`, lines, demo: bill.demo };
    }).entry;
  }
  function postBillPayment(pay) {
    const bill = db.get('SELECT * FROM acc_bills WHERE id = ?', pay.bill_id);
    return postOnce(`billpay:${pay.id}`, () => ({
      date: pay.date, memo: `Payment ${pay.ref} · ${bill.ref}`, demo: pay.demo,
      lines: [{ account: 'ap', debit: pay.amount, ...billPartyLines(bill) }, { account: pay.account_id, credit: pay.amount, ...billPartyLines(bill) }],
    })).entry;
  }

  // SQL: rows of a table aliased x whose automatic entry (prefix:id) is live
  const LIVE = (prefix, col = 'x.id') => `EXISTS (SELECT 1 FROM acc_entries e WHERE e.source_base = '${prefix}:' || ${col} AND e.reversed_by IS NULL AND e.reverses_id IS NULL)`;

  // Bring the books up to date with everything else in the office. Idempotent.
  function sync({ upTo = today() } = {}) {
    const out = { invoices: 0, voided: 0, payments: 0, reversed: 0, payroll: 0, keyMoney: 0, bills: 0 };
    db.tx(() => {
      for (const inv of db.all(`SELECT * FROM invoices x WHERE status != 'void' AND due_date <= ? AND total > 0 AND NOT ${LIVE('inv')} ORDER BY due_date, id`, upTo)) {
        if (postInvoice(inv, { upTo })) out.invoices++;
      }
      for (const inv of db.all(`SELECT id, ref FROM invoices x WHERE status = 'void' AND ${LIVE('inv')}`)) {
        unpost(`inv:${inv.id}`, { memo: `Invoice ${inv.ref} voided` });
        out.voided++;
      }
      for (const p of db.all(`SELECT * FROM payments x WHERE status = 'received' AND NOT ${LIVE('pay')} ORDER BY date, id`)) {
        if (postPayment(p)) out.payments++;
      }
      for (const p of db.all(`SELECT id, ref FROM payments x WHERE status != 'received' AND ${LIVE('pay')}`)) {
        unpost(`pay:${p.id}`, { memo: `Receipt ${p.ref} reversed` });
        out.reversed++;
      }
      const hasPayroll = db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'payroll_runs'");
      if (hasPayroll) {
        for (const run of db.all('SELECT * FROM payroll_runs')) {
          if (['approved', 'paid'].includes(run.status)) {
            if (!active(`payroll:${run.id}`) && postPayroll(run)) out.payroll++;
            if (run.status === 'paid' && !active(`payroll-paid:${run.id}`) && postPayrollPaid(run)) out.payroll++;
          } else {
            if (active(`payroll-paid:${run.id}`)) unpost(`payroll-paid:${run.id}`, { memo: 'Payroll reopened' });
            if (active(`payroll:${run.id}`)) { unpost(`payroll:${run.id}`, { memo: 'Payroll reopened' }); out.payroll++; }
          }
        }
      }
      for (const b of db.all(`SELECT * FROM acc_bills x WHERE status IN ('approved','partial','paid') AND NOT ${LIVE('bill')}`)) {
        if (postBill(b)) out.bills++;
      }
      for (const p of db.all(`SELECT * FROM acc_bill_payments x WHERE NOT ${LIVE('billpay')}`)) postBillPayment(p);
      out.keyMoney = recogniseKeyMoney(upTo);
    });
    return out;
  }
  // What is not in the books yet (for the dashboard and the month-close checklist).
  function pending(upTo = today()) {
    const inv = db.value(`SELECT COUNT(*) FROM invoices x WHERE status != 'void' AND due_date <= ? AND total > 0 AND NOT ${LIVE('inv')}`, upTo);
    const pay = db.value(`SELECT COUNT(*) FROM payments x WHERE status = 'received' AND date <= ? AND NOT ${LIVE('pay')}`, upTo);
    const voided = db.value(`SELECT COUNT(*) FROM invoices x WHERE status = 'void' AND ${LIVE('inv')}`) + db.value(`SELECT COUNT(*) FROM payments x WHERE status != 'received' AND ${LIVE('pay')}`);
    return { invoices: inv, payments: pay, voided, total: inv + pay + voided };
  }

  // ---------- supplier bills ----------
  function vendorFor(name, { demo = 0, contract_id = null } = {}) {
    const clean = String(name || '').trim() || 'Unnamed supplier';
    const v = db.get('SELECT * FROM acc_vendors WHERE name = ? COLLATE NOCASE', clean);
    if (v) return v;
    const id = Number(db.run('INSERT INTO acc_vendors (name, contract_id, demo, created_at) VALUES (?, ?, ?, ?)', clean, contract_id, demo ? 1 : 0, now()).lastInsertRowid);
    return db.get('SELECT * FROM acc_vendors WHERE id = ?', id);
  }
  function createBill({ vendor_id, vendor_ref = null, date, due_date = null, lines, vat = 0, memo = null, source = null, source_id = null, status = 'draft', user = null, demo = 0 }) {
    if (!vendor_id) throw new Error('Choose the supplier.');
    if (!isDate(date)) throw new Error('Choose a valid date.');
    const rows = (lines || []).map((l) => ({ account_id: idOf(l.account), description: l.description || null, amount: r2(l.amount) })).filter((l) => l.amount > 0);
    if (!rows.length) throw new Error('Add at least one line with an amount.');
    const net = r2(rows.reduce((s, l) => s + l.amount, 0));
    const vatAmt = r2(vat);
    const vendor = db.get('SELECT * FROM acc_vendors WHERE id = ?', vendor_id);
    const due = isDate(due_date) ? due_date : addDays(date, vendor ? vendor.terms_days || 30 : 30);
    return db.tx(() => {
      const id = Number(db.run(
        `INSERT INTO acc_bills (ref, vendor_id, vendor_ref, date, due_date, status, net, vat, total, memo, source, source_id, created_by, demo, created_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('acc_bills', 'BL', 4, true), vendor_id, vendor_ref, date, due, net, vatAmt, r2(net + vatAmt), memo, source, source_id,
        user ? user.id : null, demo ? 1 : 0, now(),
      ).lastInsertRowid);
      rows.forEach((l, i) => db.run('INSERT INTO acc_bill_lines (bill_id, account_id, description, amount, sort) VALUES (?, ?, ?, ?, ?)', id, l.account_id, l.description, l.amount, i));
      if (status === 'approved') approveBill(id, { user });
      return db.get('SELECT * FROM acc_bills WHERE id = ?', id);
    });
  }
  function approveBill(id, { user = null } = {}) {
    const b = db.get('SELECT * FROM acc_bills WHERE id = ?', id);
    if (!b || b.status !== 'draft') throw new Error('Only a draft bill can be approved.');
    if (isLocked(b.date)) throw new Error('That date is in a closed period.');
    return db.tx(() => {
      db.run("UPDATE acc_bills SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", user ? user.id : null, now(), id);
      return postBill(db.get('SELECT * FROM acc_bills WHERE id = ?', id));
    });
  }
  function payBill(id, { amount, date = today(), account, reference = null, user = null, demo = 0 }) {
    const b = db.get('SELECT * FROM acc_bills WHERE id = ?', id);
    if (!b || !['approved', 'partial'].includes(b.status)) throw new Error('Approve the bill before paying it.');
    const amt = r2(Math.min(Number(amount), b.total - b.paid));
    if (!(amt > 0)) throw new Error('Enter the amount paid.');
    if (!isDate(date)) throw new Error('Choose a valid date.');
    if (isLocked(date)) throw new Error('That date is in a closed period.');
    return db.tx(() => {
      const pid = Number(db.run('INSERT INTO acc_bill_payments (ref, bill_id, account_id, date, amount, reference, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('acc_bill_payments', 'PV', 4, true), id, idOf(account), date, amt, reference, user ? user.id : null, demo ? 1 : 0, now()).lastInsertRowid);
      const paid = r2(b.paid + amt);
      db.run('UPDATE acc_bills SET paid = ?, status = ? WHERE id = ?', paid, paid >= b.total - 0.005 ? 'paid' : 'partial', id);
      postBillPayment(db.get('SELECT * FROM acc_bill_payments WHERE id = ?', pid));
      return db.get('SELECT * FROM acc_bills WHERE id = ?', id);
    });
  }
  function voidBill(id) {
    const b = db.get('SELECT * FROM acc_bills WHERE id = ?', id);
    if (!b || b.paid > 0 || b.status === 'void') throw new Error('Only an unpaid bill can be voided.');
    return db.tx(() => {
      unpost(`bill:${id}`, { memo: `Bill ${b.ref} voided` });
      db.run("UPDATE acc_bills SET status = 'void' WHERE id = ?", id);
    });
  }

  // ---------- banks ----------
  function createBank({ name: n, name_ar = null, bank = null, iban = null, opening_balance = 0, opening_date = null, kind = 'bank', user = null, demo = 0 }) {
    if (!n) throw new Error('Give the account a name.');
    return db.tx(() => {
      const parent = byKey('cash_group');
      const code = nextCode('1100', kind === 'cash' ? 1111 : 1120);
      const accountId = createAccount({ code, name_en: n, name_ar: name_ar || null, parent_id: parent.id, sub: 'cash', demo });
      const date = isDate(opening_date) ? opening_date : today();
      const id = Number(db.run('INSERT INTO acc_banks (account_id, name, bank, iban, opening_balance, opening_date, kind, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        accountId, n, bank, iban, r2(opening_balance), date, kind, demo ? 1 : 0, now()).lastInsertRowid);
      if (r2(opening_balance)) {
        const amt = r2(opening_balance);
        post({
          date: firstOpen(date), memo: `Opening balance · ${n}`, kind: 'opening', source: `bank-open:${id}#1`, user, demo, allowLocked: false,
          lines: amt > 0 ? [{ account: accountId, debit: amt }, { account: 'opening_equity', credit: amt }] : [{ account: 'opening_equity', debit: -amt }, { account: accountId, credit: -amt }],
        });
      }
      return db.get('SELECT * FROM acc_banks WHERE id = ?', id);
    });
  }
  // CSV/TSV/semicolon statements, English or Arabic headers, dd/mm/yyyy or ISO dates,
  // one amount column (+/−) or separate debit/credit (withdrawal/deposit) columns.
  function parseStatement(text) {
    const raw = String(text || '').replace(/^﻿/, '').trim();
    if (!raw) return { rows: [], errors: ['empty'] };
    const linesTxt = raw.split(/\r?\n/).filter((l) => l.trim());
    const delim = [',', ';', '\t', '|'].map((d) => [d, (linesTxt[0].match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
    const split = (line) => {
      const out = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (c === delim && !q) { out.push(cur); cur = ''; } else cur += c;
      }
      out.push(cur);
      return out.map((x) => x.trim());
    };
    const head = split(linesTxt[0]).map((h) => h.toLowerCase());
    const find = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
    const ci = {
      date: find('date', 'تاريخ', 'value date'),
      desc: find('description', 'details', 'narrative', 'particular', 'البيان', 'الوصف', 'التفاصيل', 'memo'),
      ref: find('reference', 'ref', 'cheque', 'المرجع', 'رقم'),
      amount: find('amount', 'المبلغ', 'القيمة'),
      debit: find('debit', 'withdrawal', 'money out', 'مدين', 'سحب', 'خصم'),
      credit: find('credit', 'deposit', 'money in', 'دائن', 'إيداع', 'ايداع'),
      balance: find('balance', 'الرصيد'),
    };
    if (ci.date < 0 || (ci.amount < 0 && ci.debit < 0 && ci.credit < 0)) return { rows: [], errors: ['headers'] };
    const toNum = (v) => {
      let s = String(v || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d.,()\-−]/g, '');
      if (!s) return null;
      const neg = /^\(.*\)$/.test(s) || /^[-−]/.test(s) || /[-−]$/.test(s);
      s = s.replace(/[()\-−]/g, '');
      // 1,234.50 · 1.234,50 · 1234,5: the last separator followed by 1–2 digits is the decimal point
      if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
      const n = Number(s);
      return Number.isFinite(n) ? (neg ? -n : n) : null;
    };
    const toDate = (v) => {
      const s = String(v || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim();
      let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
      m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
      if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[2])}-${pad(m[1])}`;
      const t = Date.parse(s);
      return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
    };
    const rows = [];
    const errors = [];
    linesTxt.slice(1).forEach((line, i) => {
      const c = split(line);
      const date = toDate(c[ci.date]);
      let amount = ci.amount >= 0 ? toNum(c[ci.amount]) : null;
      if (amount === null && (ci.debit >= 0 || ci.credit >= 0)) {
        const d = ci.debit >= 0 ? toNum(c[ci.debit]) : null;
        const cr = ci.credit >= 0 ? toNum(c[ci.credit]) : null;
        if (d || cr) amount = r2((cr || 0) - Math.abs(d || 0));
      }
      if (!date || amount === null || amount === 0) { if (c.some((x) => x)) errors.push(i + 2); return; }
      rows.push({ date, amount: r2(amount), description: ci.desc >= 0 ? c[ci.desc] || null : null, reference: ci.ref >= 0 && ci.ref !== ci.desc ? c[ci.ref] || null : null, balance: ci.balance >= 0 ? toNum(c[ci.balance]) : null });
    });
    return { rows, errors };
  }
  function importStatement(bankId, text, { file_name = null, user = null, demo = 0 } = {}) {
    const bank = db.get('SELECT * FROM acc_banks WHERE id = ?', bankId);
    if (!bank) throw new Error('That account no longer exists.');
    const { rows, errors } = parseStatement(text);
    if (!rows.length) return { added: 0, skipped: 0, errors: errors.length ? errors : ['empty'] };
    let added = 0;
    let skipped = 0;
    db.tx(() => {
      const imp = Number(db.run('INSERT INTO acc_imports (bank_id, file_name, rows, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?)', bankId, file_name, rows.length, user ? user.id : null, demo ? 1 : 0, now()).lastInsertRowid);
      for (const r of rows) {
        const dup = db.value('SELECT COUNT(*) FROM acc_statement_lines WHERE bank_id = ? AND date = ? AND amount = ? AND COALESCE(description, \'\') = ? AND COALESCE(reference, \'\') = ?', bankId, r.date, r.amount, r.description || '', r.reference || '');
        if (dup) { skipped++; continue; }
        db.run('INSERT INTO acc_statement_lines (bank_id, date, description, reference, amount, balance, import_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', bankId, r.date, r.description, r.reference, r.amount, r.balance, imp, demo ? 1 : 0, now());
        added++;
      }
      db.run('UPDATE acc_imports SET rows = ? WHERE id = ?', added, imp);
    });
    return { added, skipped, errors };
  }
  // Ledger lines on the bank's account that no statement line claims yet.
  // (The opening balance is on the statement already, so it never needs matching.)
  const unmatchedLedger = (bank) => db.all(
    `SELECT l.*, e.date, e.ref, e.memo entry_memo FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? AND e.kind != 'opening' AND l.id NOT IN (SELECT matched_line_id FROM acc_statement_lines WHERE matched_line_id IS NOT NULL) ORDER BY e.date, l.id`, bank.account_id,
  );
  function candidates(line, bank) {
    return unmatchedLedger(bank)
      .filter((l) => Math.abs(r2(l.debit - l.credit) - line.amount) < 0.01 && Math.abs(Date.parse(l.date) - Date.parse(line.date)) <= 10 * 86400000)
      .map((l) => ({ ...l, score: Math.abs(Date.parse(l.date) - Date.parse(line.date)) / 86400000 - (line.reference && l.entry_memo && String(l.entry_memo).includes(line.reference) ? 20 : 0) }))
      .sort((a, b) => a.score - b.score);
  }
  function match(lineId, ledgerLineId) {
    const sl = db.get('SELECT * FROM acc_statement_lines WHERE id = ?', lineId);
    if (!sl) throw new Error('That statement line no longer exists.');
    const bank = db.get('SELECT * FROM acc_banks WHERE id = ?', sl.bank_id);
    const l = db.get('SELECT * FROM acc_lines WHERE id = ?', ledgerLineId);
    if (!l || l.account_id !== bank.account_id) throw new Error('That ledger line is not on this account.');
    if (Math.abs(r2(l.debit - l.credit) - sl.amount) > 0.009) throw new Error('The amounts do not agree.');
    if (db.value('SELECT COUNT(*) FROM acc_statement_lines WHERE matched_line_id = ?', ledgerLineId)) throw new Error('That ledger line is already matched.');
    db.run("UPDATE acc_statement_lines SET matched_line_id = ?, status = 'matched' WHERE id = ?", ledgerLineId, lineId);
  }
  function autoMatch(bankId) {
    const bank = db.get('SELECT * FROM acc_banks WHERE id = ?', bankId);
    let n = 0;
    db.tx(() => {
      for (const sl of db.all("SELECT * FROM acc_statement_lines WHERE bank_id = ? AND status = 'open' ORDER BY date, id", bankId)) {
        const c = candidates(sl, bank);
        if (c.length && (c.length === 1 || c[0].score < c[1].score)) { match(sl.id, c[0].id); n++; }
      }
    });
    return n;
  }
  // Post a statement line that the books do not have yet (bank charges, interest …) and match it.
  function postFromLine(lineId, account, { memo = null, user = null } = {}) {
    const sl = db.get('SELECT * FROM acc_statement_lines WHERE id = ?', lineId);
    if (!sl || sl.status !== 'open') throw new Error('That statement line is already dealt with.');
    const bank = db.get('SELECT * FROM acc_banks WHERE id = ?', sl.bank_id);
    return db.tx(() => {
      const amt = Math.abs(sl.amount);
      const e = post({
        date: sl.date, memo: memo || sl.description || 'Bank statement line', kind: 'manual', user, demo: sl.demo,
        lines: sl.amount > 0 ? [{ account: bank.account_id, debit: amt }, { account, credit: amt }] : [{ account, debit: amt }, { account: bank.account_id, credit: amt }],
      });
      const line = linesOf(e.id).find((l) => l.account_id === bank.account_id);
      match(sl.id, line.id);
      return e;
    });
  }
  // Reconciliation: statement balance + what the books have that the bank has not shown yet
  // − what the bank shows that the books do not have yet = book balance. difference 0 = reconciled.
  function bankSummary(bank) {
    const book = balance(bank.account_id);
    const st = db.get("SELECT COALESCE(SUM(amount),0) total, COUNT(*) n, COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END),0) open, COALESCE(SUM(CASE WHEN status = 'open' THEN amount ELSE 0 END),0) openAmt FROM acc_statement_lines WHERE bank_id = ? AND status != 'ignored'", bank.id);
    const last = db.get("SELECT * FROM acc_statement_lines WHERE bank_id = ? AND balance IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1", bank.id);
    const lastAny = db.get('SELECT * FROM acc_statement_lines WHERE bank_id = ? ORDER BY date DESC, id DESC LIMIT 1', bank.id);
    const statement = last && lastAny && last.id === lastAny.id ? r2(last.balance) : r2(bank.opening_balance + st.total);
    const ul = unmatchedLedger(bank);
    const inTransit = r2(ul.reduce((s, l) => s + l.debit - l.credit, 0));
    const adjusted = r2(statement + inTransit - st.openAmt);
    return { book, statement, lines: st.n, open: st.open, openAmt: r2(st.openAmt), inTransit, unmatchedLedger: ul.length, difference: r2(book - adjusted), last: lastAny };
  }

  // ---------- balances and reports ----------
  // sums per account: { [accountId]: { d, c } } for entries dated in [from, to]
  function sums({ from = null, to = null, excludeClosing = false } = {}) {
    const rows = db.all(
      `SELECT l.account_id id, SUM(l.debit) d, SUM(l.credit) c FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
       WHERE 1 = 1 ${from ? 'AND e.date >= ?' : ''} ${to ? 'AND e.date <= ?' : ''} ${excludeClosing ? "AND e.kind != 'closing'" : ''} GROUP BY l.account_id`,
      ...[from, to].filter(Boolean),
    );
    return Object.fromEntries(rows.map((r) => [r.id, { d: r2(r.d), c: r2(r.c) }]));
  }
  function balance(accountId, { from = null, to = null } = {}) {
    const a = byId(accountId);
    const r = db.get(`SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.account_id = ? ${from ? 'AND e.date >= ?' : ''} ${to ? 'AND e.date <= ?' : ''}`, accountId, ...[from, to].filter(Boolean));
    return r2((r.d - r.c) * natural(a.type));
  }
  const keyBalance = (key, opts) => balance(idOf(key), opts);
  const cashAccounts = () => db.all("SELECT * FROM acc_accounts WHERE sub = 'cash' AND is_group = 0 ORDER BY code");

  function trialBalance({ from, to }) {
    const open = sums({ to: addDays(from, -1) });
    const mov = sums({ from, to });
    const rows = accounts({ postable: true }).map((a) => {
      const o = open[a.id] || { d: 0, c: 0 };
      const m = mov[a.id] || { d: 0, c: 0 };
      const openNet = r2(o.d - o.c);
      const closeNet = r2(openNet + m.d - m.c);
      return { ...a, openNet, md: m.d, mc: m.c, closeNet };
    }).filter((r) => r.openNet || r.md || r.mc || r.closeNet);
    const tot = rows.reduce((t, r) => ({
      od: r2(t.od + Math.max(0, r.openNet)), oc: r2(t.oc + Math.max(0, -r.openNet)), md: r2(t.md + r.md), mc: r2(t.mc + r.mc),
      cd: r2(t.cd + Math.max(0, r.closeNet)), cc: r2(t.cc + Math.max(0, -r.closeNet)),
    }), { od: 0, oc: 0, md: 0, mc: 0, cd: 0, cc: 0 });
    return { rows, tot, balanced: Math.abs(tot.cd - tot.cc) < 0.01 && Math.abs(tot.md - tot.mc) < 0.01 };
  }
  function profitLoss({ from, to }) {
    const m = sums({ from, to, excludeClosing: true });
    const row = (a) => {
      const s = m[a.id] || { d: 0, c: 0 };
      return { ...a, amount: r2(a.type === 'income' ? s.c - s.d : s.d - s.c) };
    };
    const income = accounts({ postable: true, type: 'income' }).map(row).filter((r) => r.amount);
    const expense = accounts({ postable: true, type: 'expense' }).map(row).filter((r) => r.amount);
    const ti = r2(income.reduce((s, r) => s + r.amount, 0));
    const te = r2(expense.reduce((s, r) => s + r.amount, 0));
    return { income, expense, totalIncome: ti, totalExpense: te, result: r2(ti - te) };
  }
  function balanceSheet(asOf) {
    const all = sums({ to: asOf });
    const bal = (a) => {
      const s = all[a.id] || { d: 0, c: 0 };
      return r2((s.d - s.c) * natural(a.type));
    };
    const pick = (type) => accounts({ postable: true, type }).map((a) => ({ ...a, amount: bal(a) })).filter((r) => r.amount);
    const assets = pick('asset');
    const liabilities = pick('liability');
    const equity = pick('equity');
    const unclosed = r2(accounts({ postable: true }).filter((a) => ['income', 'expense'].includes(a.type)).reduce((s, a) => s + bal(a) * (a.type === 'income' ? 1 : -1), 0));
    const fy = fiscalYear(asOf);
    const current = active(`yearclose:${fy.year}`) && asOf >= fy.to ? 0 : profitLoss({ from: fy.from, to: asOf }).result;
    const ta = r2(assets.reduce((s, r) => s + r.amount, 0));
    const tl = r2(liabilities.reduce((s, r) => s + r.amount, 0));
    const te = r2(equity.reduce((s, r) => s + r.amount, 0) + unclosed);
    return { assets, liabilities, equity, currentResult: current, earlierResult: r2(unclosed - current), totalAssets: ta, totalLiabilities: tl, totalEquity: te, balanced: Math.abs(ta - tl - te) < 0.01 };
  }
  function cashFlow({ from, to }) {
    const m = sums({ from, to, excludeClosing: true });
    const net = (a) => { const s = m[a.id] || { d: 0, c: 0 }; return r2(s.d - s.c); };
    const pl = profitLoss({ from, to });
    const all = accounts({ postable: true });
    const lines = { operating: [], investing: [], financing: [] };
    let cash = 0;
    for (const a of all) {
      const d = net(a);
      if (!d) continue;
      if (a.sub === 'cash') { cash = r2(cash + d); continue; }
      if (a.type === 'income' || a.type === 'expense') continue;
      const effect = r2(-d); // more of an asset uses cash; more of a liability/equity brings it
      if (a.sub === 'accum') lines.operating.push({ ...a, amount: effect, addback: true });
      else if (a.sub === 'fixed') lines.investing.push({ ...a, amount: effect });
      else if (a.type === 'equity') lines.financing.push({ ...a, amount: effect });
      else lines.operating.push({ ...a, amount: effect });
    }
    const sum = (l) => r2(l.reduce((s, r) => s + r.amount, 0));
    const operating = r2(pl.result + sum(lines.operating));
    const investing = sum(lines.investing);
    const financing = sum(lines.financing);
    const opening = r2(cashAccounts().reduce((s, a) => s + balance(a.id, { to: addDays(from, -1) }), 0));
    return { result: pl.result, lines, operating, investing, financing, change: cash, opening, closing: r2(opening + cash), ties: Math.abs(operating + investing + financing - cash) < 0.01 };
  }
  function generalLedger(accountId, { from, to }) {
    const a = byId(accountId);
    const sign = natural(a.type);
    const opening = r2(balance(accountId, { to: addDays(from, -1) }));
    let run = opening;
    const rows = db.all(
      `SELECT l.*, e.ref, e.date, e.memo entry_memo, e.kind, e.id entry_id FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.date >= ? AND e.date <= ? ORDER BY e.date, e.id, l.sort`, accountId, from, to,
    ).map((r) => { run = r2(run + (r.debit - r.credit) * sign); return { ...r, running: run }; });
    return { account: a, opening, rows, closing: run, debit: r2(rows.reduce((s, r) => s + r.debit, 0)), credit: r2(rows.reduce((s, r) => s + r.credit, 0)) };
  }
  function vatSummary({ from, to }) {
    const m = sums({ from, to });
    const out = m[idOf('vat_out')] || { d: 0, c: 0 };
    const inn = m[idOf('vat_in')] || { d: 0, c: 0 };
    const output = r2(out.c - out.d);
    const input = r2(inn.d - inn.c);
    return { output, input, payable: r2(output - input) };
  }
  const BUCKETS = [[0, 0], [1, 30], [31, 60], [61, 90], [91, Infinity]];
  const bucketOf = (days) => BUCKETS.findIndex(([a, b]) => days >= a && days <= b);
  function agedReceivables(asOf = today()) {
    const rows = db.all("SELECT i.*, COALESCE(b.name, i.customer) party FROM invoices i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.status IN ('open','partial') AND i.due_date <= ?", asOf);
    const by = new Map();
    for (const i of rows) {
      const k = i.brand_id ? `b${i.brand_id}` : `c${i.customer}`;
      if (!by.has(k)) by.set(k, { party: i.party || '', brand_id: i.brand_id, buckets: [0, 0, 0, 0, 0], total: 0, count: 0 });
      const r = by.get(k);
      const days = Math.max(0, Math.round((Date.parse(asOf) - Date.parse(i.due_date)) / 86400000));
      const amt = r2(i.total - i.paid);
      r.buckets[bucketOf(days)] = r2(r.buckets[bucketOf(days)] + amt);
      r.total = r2(r.total + amt);
      r.count++;
    }
    const list = [...by.values()].filter((r) => r.total > 0.004).sort((a, b) => b.total - a.total);
    const totals = list.reduce((t, r) => t.map((x, i) => r2(x + r.buckets[i])), [0, 0, 0, 0, 0]);
    return { rows: list, totals, total: r2(totals.reduce((s, x) => s + x, 0)) };
  }
  function agedPayables(asOf = today()) {
    const rows = db.all("SELECT b.*, v.name party FROM acc_bills b JOIN acc_vendors v ON v.id = b.vendor_id WHERE b.status IN ('approved','partial')");
    const by = new Map();
    for (const b of rows) {
      if (!by.has(b.vendor_id)) by.set(b.vendor_id, { party: b.party, vendor_id: b.vendor_id, buckets: [0, 0, 0, 0, 0], total: 0, count: 0 });
      const r = by.get(b.vendor_id);
      const days = Math.max(0, Math.round((Date.parse(asOf) - Date.parse(b.due_date)) / 86400000));
      const amt = r2(b.total - b.paid);
      r.buckets[bucketOf(days)] = r2(r.buckets[bucketOf(days)] + amt);
      r.total = r2(r.total + amt);
      r.count++;
    }
    const list = [...by.values()].filter((r) => r.total > 0.004).sort((a, b) => b.total - a.total);
    const totals = list.reduce((t, r) => t.map((x, i) => r2(x + r.buckets[i])), [0, 0, 0, 0, 0]);
    return { rows: list, totals, total: r2(totals.reduce((s, x) => s + x, 0)) };
  }
  // A tenant's statement of account: issued invoices and payments with a running balance.
  function tenantStatement(brandId, { from = null, to = today() } = {}) {
    const items = [
      ...db.all("SELECT id, ref, due_date date, total amount, kind, note, status FROM invoices WHERE brand_id = ? AND status != 'void' AND due_date <= ?", brandId, to).map((i) => ({ ...i, type: 'invoice', debit: i.amount, credit: 0 })),
      ...db.all("SELECT p.id, p.ref, p.date, p.amount, p.method, p.status, i.ref inv FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE (p.brand_id = ? OR i.brand_id = ?) AND p.date <= ?", brandId, brandId, to)
        .flatMap((p) => (p.status === 'received' ? [{ ...p, type: 'payment', debit: 0, credit: p.amount }] : [{ ...p, type: 'payment', debit: 0, credit: p.amount }, { ...p, type: 'reversal', debit: p.amount, credit: 0 }])),
    ].sort((a, b) => (a.date === b.date ? (a.type === 'invoice' ? -1 : 1) : a.date < b.date ? -1 : 1));
    let run = 0;
    let opening = 0;
    const rows = [];
    for (const it of items) {
      run = r2(run + it.debit - it.credit);
      if (from && it.date < from) opening = run;
      else rows.push({ ...it, running: run });
    }
    return { opening, rows, closing: run, invoiced: r2(rows.reduce((s, r) => s + r.debit, 0)), paid: r2(rows.reduce((s, r) => s + r.credit, 0)) };
  }
  function monthly(months = 6, to = today()) {
    const out = [];
    for (let k = months - 1; k >= 0; k--) {
      const ym = addMonthsYM(to.slice(0, 7), -k);
      const p = profitLoss({ from: `${ym}-01`, to: monthEnd(ym) });
      out.push({ ym, month: Number(ym.slice(5, 7)), income: p.totalIncome, expense: p.totalExpense, result: p.result });
    }
    return out;
  }

  // ---------- fixed assets ----------
  const assetMonthly = (a) => r2((a.cost - a.residual) / Math.max(1, a.life_months));
  const depreciated = (assetId, upTo = null) => r2(db.value(`SELECT COALESCE(SUM(amount),0) FROM acc_depreciation WHERE asset_id = ? ${upTo ? 'AND period <= ?' : ''}`, assetId, ...(upTo ? [upTo] : [])));
  function createAsset({ name: n, class: cls, cost, acquired_on, life_months, residual = 0, location = null, notes = null, pay_from = null, user = null, demo = 0 }) {
    if (!n || !ASSET_CLASSES[cls]) throw new Error('Give the asset a name and a class.');
    if (!(Number(cost) > 0) || !isDate(acquired_on)) throw new Error('Enter the cost and the date acquired.');
    const life = Math.max(1, Math.round(Number(life_months) || ASSET_CLASSES[cls][2]));
    return db.tx(() => {
      const id = Number(db.run('INSERT INTO acc_assets (ref, name, class, cost, acquired_on, life_months, residual, location, notes, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('acc_assets', 'FA', 4, false), n, cls, r2(cost), acquired_on, life, r2(residual), location, notes, demo ? 1 : 0, now()).lastInsertRowid);
      if (pay_from) {
        const a = db.get('SELECT * FROM acc_assets WHERE id = ?', id);
        post({
          date: firstOpen(acquired_on), memo: `Asset ${a.ref} · ${n}`, kind: 'auto', source: `asset:${id}#1`, user, demo,
          lines: [{ account: ASSET_CLASSES[cls][0], debit: a.cost }, { account: pay_from, credit: a.cost }],
        });
      }
      return db.get('SELECT * FROM acc_assets WHERE id = ?', id);
    });
  }
  // One depreciation entry per month for every asset in use; catches up from the last run.
  function runDepreciation(ym, { user = null } = {}) {
    if (!/^\d{4}-\d{2}$/.test(ym) || ym > today().slice(0, 7)) throw new Error('Choose this month or an earlier one.');
    if (isLocked(monthEnd(ym))) throw new Error('That month is closed.');
    let posted = 0;
    db.tx(() => {
      const assets = db.all("SELECT * FROM acc_assets WHERE acquired_on <= ? AND (status = 'active' OR disposed_on > ?)", monthEnd(ym), monthEnd(ym));
      let first = ym;
      for (const a of assets) {
        const start = a.acquired_on.slice(0, 7);
        let k = start;
        while (k < ym && db.value('SELECT COUNT(*) FROM acc_depreciation WHERE asset_id = ? AND period = ?', a.id, k)) k = addMonthsYM(k, 1);
        if (k < first) first = k;
      }
      for (let p = first; p <= ym; p = addMonthsYM(p, 1)) {
        if (isLocked(monthEnd(p))) continue;
        const rows = [];
        for (const a of assets) {
          if (a.acquired_on.slice(0, 7) > p) continue;
          if (a.disposed_on && a.disposed_on.slice(0, 7) < p) continue;
          if (db.value('SELECT COUNT(*) FROM acc_depreciation WHERE asset_id = ? AND period = ?', a.id, p)) continue;
          const left = r2(a.cost - a.residual - depreciated(a.id));
          const amt = r2(Math.min(assetMonthly(a), left));
          if (amt > 0) rows.push({ a, amt });
        }
        if (!rows.length) continue;
        const lines = [];
        for (const { a, amt } of rows) {
          lines.push({ account: 'exp_depreciation', debit: amt, memo: `Depreciation ${a.ref}` });
          lines.push({ account: ASSET_CLASSES[a.class][1], credit: amt, memo: `Depreciation ${a.ref}` });
        }
        const e = post({ date: monthEnd(p), memo: `Depreciation ${p}`, kind: 'depreciation', source: `dep:${p}#${db.value("SELECT COUNT(*) FROM acc_entries WHERE source_base = ?", `dep:${p}`) + 1}`, lines, user, demo: rows.every((r) => r.a.demo) ? 1 : 0 });
        for (const { a, amt } of rows) db.run('INSERT INTO acc_depreciation (asset_id, period, amount, entry_id) VALUES (?, ?, ?, ?)', a.id, p, amt, e.id);
        posted++;
      }
    });
    return posted;
  }
  function disposeAsset(id, { date, proceeds = 0, account = null, user = null }) {
    const a = db.get('SELECT * FROM acc_assets WHERE id = ?', id);
    if (!a || a.status !== 'active') throw new Error('That asset is not in use.');
    if (!isDate(date) || isLocked(date)) throw new Error('Choose an open date.');
    const acc = depreciated(a.id);
    const nbv = r2(a.cost - acc);
    const cash = r2(proceeds);
    const gain = r2(cash - nbv);
    const [costKey, accKey] = ASSET_CLASSES[a.class];
    const lines = [{ account: costKey, credit: a.cost }];
    if (acc) lines.push({ account: accKey, debit: acc });
    if (cash) lines.push({ account: account || 'bank_clearing', debit: cash });
    if (gain > 0) lines.push({ account: 'inc_other', credit: gain });
    if (gain < 0) lines.push({ account: 'exp_other', debit: -gain });
    return db.tx(() => {
      post({ date, memo: `Disposal ${a.ref} · ${a.name}`, kind: 'auto', source: `dispose:${a.id}#1`, lines, user, demo: a.demo });
      db.run("UPDATE acc_assets SET status = 'disposed', disposed_on = ?, proceeds = ? WHERE id = ?", date, cash, a.id);
      return { nbv, gain };
    });
  }

  // ---------- periods: close a month, reopen, close a year ----------
  function checklist(ym) {
    const end = monthEnd(ym);
    const p = pending(end);
    const hasEmp = db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'employees'") && db.value("SELECT COUNT(*) FROM employees WHERE status = 'active' AND hire_date <= ?", end);
    const run = hasEmp ? db.get('SELECT * FROM payroll_runs WHERE period = ?', ym) : null;
    const assets = db.value("SELECT COUNT(*) FROM acc_assets WHERE acquired_on <= ? AND status = 'active'", end);
    const depDone = !assets || !!db.value('SELECT COUNT(*) FROM acc_entries WHERE source_base = ? AND reversed_by IS NULL', `dep:${ym}`);
    const unrec = db.value("SELECT COUNT(*) FROM acc_statement_lines WHERE status = 'open' AND date <= ?", end);
    const drafts = db.value("SELECT COUNT(*) FROM acc_bills WHERE status = 'draft' AND date <= ?", end);
    return [
      { key: 'invoices', ok: !p.invoices, n: p.invoices, required: true },
      { key: 'payments', ok: !p.payments, n: p.payments, required: true },
      { key: 'payroll', ok: !hasEmp || (run && ['approved', 'paid'].includes(run.status)), n: hasEmp ? 1 : 0 },
      { key: 'depreciation', ok: depDone, n: assets },
      { key: 'bank', ok: !unrec, n: unrec },
      { key: 'bills', ok: !drafts, n: drafts },
    ];
  }
  function nextToClose() {
    const lock = lockDate();
    if (lock) return addMonthsYM(lock.slice(0, 7), 1);
    const first = db.value('SELECT MIN(date) FROM acc_entries');
    return (first || today()).slice(0, 7);
  }
  // Close every month up to and including ym (the lock date moves to its last day).
  function closeMonth(ym, { user = null, force = false, note = null } = {}) {
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('Choose a month.');
    if (ym < nextToClose()) throw new Error('That month is already closed.');
    if (monthEnd(ym) >= today()) throw new Error('A month can be closed once it has ended.');
    const list = checklist(ym);
    if (list.some((c) => c.required && !c.ok)) throw new Error('Post everything for the month before closing it.');
    if (!force && list.some((c) => !c.ok)) throw new Error('Some checks are not done. Tick “close anyway” to close regardless.');
    db.tx(() => {
      for (let p = nextToClose(); p <= ym; p = addMonthsYM(p, 1)) {
        db.run('INSERT OR REPLACE INTO acc_periods (period, closed_at, closed_by, note) VALUES (?, ?, ?, ?)', p, now(), user ? user.id : null, p === ym ? note : null);
      }
      setS('lock_date', monthEnd(ym));
    });
  }
  // Reopen the last closed month (not inside a closed year: reopen the year first).
  function reopenLast() {
    const lock = lockDate();
    if (!lock) throw new Error('No month is closed.');
    const ym = lock.slice(0, 7);
    const fy = fiscalYear(lock);
    if (active(`yearclose:${fy.year}`)) throw new Error('That year is closed. Reopen the year first.');
    db.tx(() => {
      db.run('DELETE FROM acc_periods WHERE period = ?', ym);
      const prev = addMonthsYM(ym, -1);
      setS('lock_date', db.value('SELECT COUNT(*) FROM acc_periods WHERE period = ?', prev) ? monthEnd(prev) : '');
    });
    return ym;
  }
  function closeYear(fyFrom, { user = null } = {}) {
    const fy = fiscalYear(fyFrom);
    if (!lockDate() || lockDate() < fy.to) throw new Error('Close every month of the year first.');
    if (active(`yearclose:${fy.year}`)) throw new Error('That year is already closed.');
    const pl = profitLoss({ from: fy.from, to: fy.to });
    const lines = [];
    for (const r of pl.income) lines.push(r.amount > 0 ? { account: r.id, debit: r.amount } : { account: r.id, credit: -r.amount });
    for (const r of pl.expense) lines.push(r.amount > 0 ? { account: r.id, credit: r.amount } : { account: r.id, debit: -r.amount });
    if (pl.result > 0) lines.push({ account: 'retained', credit: pl.result });
    if (pl.result < 0) lines.push({ account: 'retained', debit: -pl.result });
    if (lines.length < 2) throw new Error('There is nothing to close for that year.');
    const n = db.value('SELECT COUNT(*) FROM acc_entries WHERE source_base = ?', `yearclose:${fy.year}`) + 1;
    return post({ date: fy.to, memo: `Year-end close ${fy.label}`, kind: 'closing', source: `yearclose:${fy.year}#${n}`, lines, user, allowLocked: true });
  }
  // Undo a year-end close: the closing entry is reversed on the same date.
  function reopenYear(year, { user = null } = {}) {
    const e = active(`yearclose:${year}`);
    if (!e) throw new Error('That year is not closed.');
    const later = db.get("SELECT * FROM acc_entries WHERE kind = 'closing' AND date > ? AND reversed_by IS NULL AND reverses_id IS NULL", e.date);
    if (later) throw new Error('Reopen the later year first.');
    return reverse(e.id, { date: e.date, exact: true, memo: `Year-end close reopened ${year}`, user });
  }

  // ---------- budgets ----------
  function budget(from, to) {
    const rows = db.all('SELECT account_id, SUM(amount) amount FROM acc_budgets WHERE period >= ? AND period <= ? GROUP BY account_id', from.slice(0, 7), to.slice(0, 7));
    return Object.fromEntries(rows.map((r) => [r.account_id, r2(r.amount)]));
  }

  // ---------- events from the rest of the office ----------
  function listen(bus) {
    if (!bus) return;
    const safe = (fn) => (p) => { try { fn(p); } catch (err) { console.error('[accounting]', err.message); } };
    bus.on('invoice.created', safe(({ invoice }) => postInvoice(invoice)));
    bus.on('invoice.voided', safe(({ invoice }) => unpost(`inv:${invoice.id}`, { memo: `Invoice ${invoice.ref} voided` })));
    bus.on('payment.received', safe(({ payment, invoice }) => { if (invoice) postInvoice(invoice); postPayment(payment); }));
    bus.on('payment.reversed', safe(({ payment }) => unpost(`pay:${payment.id}`, { memo: `Receipt ${payment.ref} reversed` })));
    bus.on('payroll.approved', safe(({ run }) => postPayroll(db.get('SELECT * FROM payroll_runs WHERE id = ?', run.id))));
    bus.on('payroll.paid', safe(({ run }) => {
      const r = db.get('SELECT * FROM payroll_runs WHERE id = ?', run.id);
      postPayroll(r);
      postPayrollPaid(r);
    }));
    bus.on('payroll.reopened', safe(({ run }) => {
      unpost(`payroll-paid:${run.id}`, { memo: 'Payroll reopened' });
      unpost(`payroll:${run.id}`, { memo: 'Payroll reopened' });
    }));
    bus.on('expense.incurred', safe((e) => {
      if (!(Number(e.amount) > 0)) return;
      if (e.source && db.value('SELECT COUNT(*) FROM acc_bills WHERE source = ? AND source_id IS ?', e.source, e.source_id ?? null)) return;
      const v = vendorFor(e.vendor || 'Maintenance supplier', { demo: e.demo });
      createBill({
        vendor_id: v.id, date: isDate(e.date) ? e.date : today(), memo: e.memo || null, source: e.source || null, source_id: e.source_id ?? null, demo: e.demo,
        lines: [{ account: CATEGORY_ACCOUNTS[e.category] || 'exp_maintenance', description: e.memo || null, amount: e.amount }],
      });
    }));
  }
  listen(events);

  return {
    CHART, ASSET_CLASSES, KIND_ACCOUNTS, CATEGORY_ACCOUNTS, METHODS, r2, monthEnd, addMonthsYM, addDays, monthsBetween,
    S, setS, byKey, byCode, byId, resolve, idOf, name, label, natural, accounts, createAccount, hasLines, nextCode,
    lockDate, isLocked, firstOpen, fyStart, fiscalYear,
    post, entry, linesOf, active, postOnce, reverse, unpost,
    postInvoice, postPayment, postPayroll, postPayrollPaid, recogniseKeyMoney, postBill, sync, pending, payrollTotals,
    vendorFor, createBill, approveBill, payBill, voidBill,
    createBank, parseStatement, importStatement, unmatchedLedger, candidates, match, autoMatch, postFromLine, bankSummary,
    sums, balance, keyBalance, cashAccounts, trialBalance, profitLoss, balanceSheet, cashFlow, generalLedger, vatSummary,
    agedReceivables, agedPayables, tenantStatement, monthly, BUCKETS,
    assetMonthly, depreciated, createAsset, runDepreciation, disposeAsset,
    checklist, nextToClose, closeMonth, reopenLast, closeYear, reopenYear, budget, LIVE,
  };
}

// One ledger per database (routes, demo data and tests share it; listeners attach once).
const cache = new WeakMap();
function forDb(db, events = null) {
  let l = cache.get(db);
  if (!l) { l = ledger(db, events); cache.set(db, l); }
  return l;
}

module.exports = { ledger: forDb, CHART, ASSET_CLASSES, KIND_ACCOUNTS };
