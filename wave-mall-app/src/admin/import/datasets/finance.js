'use strict';

// Finance and purchasing: the chart of accounts, bank and cash accounts, the opening trial balance,
// suppliers, unpaid supplier bills at go-live, fixed assets and store items with their opening stock.
// Each one saves through the books' own functions (ledger.js) and the modules' rules
// (routes/accounting.js, routes/purchasing.js), so an imported record behaves like a typed one.
//
// Going live: whatever is imported in its own list (bank balances, unpaid supplier bills, opening
// stock, salary advances) posts its own opening entry against "Opening balances" (3900); the opening
// trial balance carries the rest, and warns about accounts that would then count twice.

const i18n = require('../../i18n');
const ACC = require('../../routes/accounting');
const PUR = require('../../routes/purchasing');

const L = (en, ar) => ({ en, ar });
const lab = (key) => ({ en: i18n.english(key), ar: typeof i18n.AR[key] === 'string' ? i18n.AR[key] : i18n.english(key) });
const opts = (map) => Object.entries(map).map(([k, key]) => [k, lab(key)]);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const ibanOf = (v) => (v ? String(v).replace(/[\s-]+/g, '').toUpperCase() : null);
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const DIFF = 'opening-diff'; // the balancing line of an opening entry (party_type), kept by the import itself
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CLOSED = L('closed accounting month', 'شهر محاسبي مغلق');

module.exports = function financeDatasets(imports, h) {
  const { M } = h;
  const now = () => M.now();
  const today = () => M.today();
  const Lg = () => h.ledger;
  const finance = (req) => h.canFinance(req);
  const buyer = (req) => h.can(req, 'manager') || h.canFinance(req);
  const ibanCheck = (row, ctx, col = 'iban') => {
    if (!row[col]) return;
    if (row[col].startsWith('EG') && !/^EG\d{27}$/.test(row[col])) ctx.error(col, 'imp|An Egyptian IBAN is EG followed by 27 digits.');
    else if (!IBAN_RE.test(row[col])) ctx.error(col, 'imp|That IBAN does not look right.');
  };
  // an automatic entry posted for a record: deleted with the record on undo (never left half-undone)
  const dropEntries = (db, base) => {
    for (const e of db.all('SELECT id FROM acc_entries WHERE source_base = ? OR source = ?', base, base)) {
      db.run('UPDATE acc_entries SET reversed_by = NULL WHERE reversed_by = ?', e.id);
      db.run('UPDATE acc_entries SET reverses_id = NULL WHERE reverses_id = ?', e.id);
      db.run('DELETE FROM acc_lines WHERE entry_id = ?', e.id);
      db.run('DELETE FROM acc_entries WHERE id = ?', e.id);
    }
  };
  // what keeps an automatic entry: dated in a closed month, reversed, or matched to a bank line
  const entryUses = (db, base) => {
    const out = [];
    const L1 = Lg();
    const es = db.all('SELECT * FROM acc_entries WHERE source_base = ? OR source = ?', base, base);
    if (es.some((e) => L1.isLocked(e.date))) out.push({ n: 1, what: CLOSED });
    const matched = es.reduce((s, e) => s + db.value('SELECT COUNT(*) FROM acc_statement_lines WHERE matched_line_id IN (SELECT id FROM acc_lines WHERE entry_id = ?)', e.id), 0);
    if (matched) out.push({ n: matched, what: L('reconciled bank lines', 'سطور بنكية مسواة') });
    const reversed = es.filter((e) => e.reversed_by || e.reverses_id).length;
    if (reversed) out.push({ n: reversed, what: L('reversed entries', 'قيود معكوسة') });
    return out;
  };

  // ---------- references ----------
  const accName = (a) => `${a.code} · ${a.name_en}`;
  const accItem = (a) => ({ id: a.id, name: accName(a), alt: [a.code, a.name_en, a.name_ar].filter(Boolean) });
  const groupChoices = (db) => db.all('SELECT * FROM acc_accounts WHERE is_group = 1 ORDER BY code').map(accItem);
  const postable = (db) => db.all('SELECT * FROM acc_accounts WHERE is_group = 0 ORDER BY code').map(accItem);
  const expenseChoices = (db) => db.all("SELECT * FROM acc_accounts WHERE is_group = 0 AND active = 1 AND type IN ('expense','asset') AND COALESCE(sub, '') NOT IN ('cash','accum') AND COALESCE(key, '') != 'ar' ORDER BY code").map(accItem);
  const vendorChoices = (db) => db.all('SELECT id, name FROM acc_vendors ORDER BY name').map((v) => ({ id: v.id, name: v.name, alt: [] }));
  const contractChoices = (db) => db.all('SELECT id, ref, counterparty FROM contracts ORDER BY counterparty').map((c) => ({ id: c.id, name: `${c.ref} · ${c.counterparty}`, alt: [c.ref] }));
  const TYPE_OPTS = opts(ACC.TYPES);

  // =====================================================================================
  // Chart of accounts
  // =====================================================================================
  const isUnder = (db, id, ancestor) => {
    for (let a = db.get('SELECT * FROM acc_accounts WHERE id = ?', id), n = 0; a && n < 20; a = a.parent_id ? db.get('SELECT * FROM acc_accounts WHERE id = ?', a.parent_id) : null, n++) if (a.id === ancestor) return true;
    return false;
  };
  imports.register({
    key: 'accounts',
    module: '/admin/accounting',
    pages: ['/admin/accounting/accounts'],
    area: 'finance',
    order: 10,
    icon: 'coins',
    table: 'acc_accounts',
    title: L('Chart of accounts', 'دليل الحسابات'),
    summary: L('Your accounts and the groups they sit under, in English and Arabic.', 'حساباتك والمجموعات التي تندرج تحتها، بالعربية والإنجليزية.'),
    notes: L('The office starts with an Egyptian mall chart. Add your own accounts under its groups (an account takes the type of its group), rename them, or make unused ones inactive. System accounts that the automatic postings use always stay active.', 'يبدأ المكتب بدليل حسابات لمول مصري. أضف حساباتك تحت مجموعاته (يأخذ الحساب نوع مجموعته)، أو غيّر أسماءها، أو أوقف ما لا تستخدمه. حسابات النظام التي تستخدمها القيود التلقائية تبقى نشطة دائمًا.'),
    canView: finance,
    allowed: finance,
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Account code', 'رقم الحساب'), type: 'code', required: true, max: 6, width: 12, keepOnUpdate: true, example: '5250', aliases: ['code', 'account no', 'account number', 'acc no', 'كود الحساب', 'رقم'], help: L('3 to 6 digits (groups may have 2). A code already in the system updates that account.', 'من ٣ إلى ٦ أرقام (المجموعات قد تكون رقمين). الرقم الموجود في النظام يحدّث الحساب نفسه.') },
      { key: 'name_en', label: L('Name in English', 'الاسم بالإنجليزية'), type: 'text', required: true, max: 120, width: 30, example: 'Generator diesel', aliases: ['account name', 'name', 'english name', 'اسم الحساب بالانجليزيه'] },
      { key: 'name_ar', label: L('Name in Arabic', 'الاسم بالعربية'), type: 'text', max: 120, width: 28, example: 'سولار المولدات', aliases: ['arabic name', 'اسم الحساب', 'الاسم'] },
      { key: 'parent', label: L('Under (group)', 'تحت المجموعة'), type: 'ref', width: 30, ref: { list: groupChoices, dataset: 'accounts', what: L('Account groups', 'مجموعات الحسابات'), self: 'code', set: (db, id, target) => db.run('UPDATE acc_accounts SET parent_id = ?, sub = COALESCE((SELECT CASE WHEN sub = \'cash\' THEN sub END FROM acc_accounts WHERE id = ?), sub) WHERE id = ?', target, target, id) }, aliases: ['parent', 'group', 'parent account', 'الحساب الرئيسي', 'المجموعه'], help: L('The group it sits under, by its code (5 · Expenses) — it may be a group further down in the same file.', 'المجموعة التي يندرج تحتها، برقمها (٥ · المصروفات) — ويمكن أن تكون مجموعة في الملف نفسه.') },
      { key: 'kind', label: L('Account or group', 'حساب أم مجموعة'), type: 'enum', enum: [['account', L('Account (takes entries)', 'حساب (تُسجل عليه القيود)')], ['group', L('Group (holds accounts)', 'مجموعة (تضم حسابات)')]], width: 18, keepOnUpdate: true, example: 'account', help: L('Empty means an account. Entries are posted to accounts, never to groups.', 'الفارغ يعني حسابًا. القيود تُسجل على الحسابات، لا على المجموعات.') },
      { key: 'type', label: L('Type', 'النوع'), type: 'enum', enum: TYPE_OPTS, width: 14, keepOnUpdate: true, help: L('Only needed when its group is new in the same file: otherwise it takes its group’s type.', 'يُطلب فقط إذا كانت مجموعته جديدة في الملف نفسه، وإلا يأخذ نوع مجموعته.') },
      { key: 'active', label: L('Active', 'نشط'), type: 'bool', width: 10, example: 'yes', help: L('Inactive accounts keep their history but are not offered for new entries.', 'الحساب غير النشط يحتفظ بسجله لكنه لا يظهر في القيود الجديدة.') },
    ],
    find: (db, v) => {
      const a = db.get('SELECT id FROM acc_accounts WHERE code = ?', String(v.code));
      return a ? a.id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      const cur = ctx.id ? db.get('SELECT * FROM acc_accounts WHERE id = ?', ctx.id) : null;
      const kind = cur ? (cur.is_group ? 'group' : 'account') : row.kind || 'account';
      if (!cur && !(kind === 'group' ? /^\d{2,6}$/ : /^\d{3,6}$/).test(String(row.code))) ctx.error('code', kind === 'group' ? 'imp2|A group code has 2 to 6 digits.' : 'imp2|An account code has 3 to 6 digits.');
      const parent = row.parent && typeof row.parent === 'number' ? db.get('SELECT * FROM acc_accounts WHERE id = ?', row.parent) : null;
      if (!cur) {
        if (!row.parent) ctx.error('parent', 'imp2|Choose the group it sits under.');
        else if (parent && !parent.is_group) ctx.error('parent', 'imp2|That is an account, not a group.');
        else if (row.parent && row.parent.self && !row.type) ctx.error('type', 'imp2|Give the type: its group is new in this file.');
        if (parent && row.type && row.type !== parent.type && ctx.provided.has('type')) ctx.error('type', 'imp2|An account has the type of its group ({type}).', { type: i18n.run(ctx.lang, () => i18n.t(ACC.TYPES[parent.type])) });
      } else {
        if (row.parent && typeof row.parent === 'number' && row.parent !== cur.parent_id) {
          if (!parent || !parent.is_group) ctx.error('parent', 'imp2|That is an account, not a group.');
          else if (parent.type !== cur.type) ctx.error('parent', 'imp2|An account moves only to a group of the same type ({type}).', { type: i18n.run(ctx.lang, () => i18n.t(ACC.TYPES[cur.type])) });
          else if (parent.id === cur.id || isUnder(db, parent.id, cur.id)) ctx.error('parent', 'imp2|A group cannot sit under itself.');
        }
        if (!row.parent && cur.parent_id && ctx.provided.has('parent')) ctx.error('parent', 'imp2|Choose the group it sits under.');
        if (cur.key && row.active === false) ctx.error('active', 'imp2|A system account stays active: the automatic postings use it.');
      }
    },
    // groups new in this file: the account's type must be the group's
    fileCheck(rows, ctx) {
      const byCode = new Map(rows.map((r) => [String(r.full.code).toLowerCase(), r]));
      const rowOf = (key) => byCode.get(String(key).toLowerCase());
      // a row's type: its own, else its group's (in the system or further up the file)
      const typeOf = (r, n = 0) => {
        if (r.id) return ctx.db.value('SELECT type FROM acc_accounts WHERE id = ?', r.id);
        const p = r.full.parent;
        if (typeof p === 'number') return ctx.db.value('SELECT type FROM acc_accounts WHERE id = ?', p);
        if (p && p.self && n < 10 && rowOf(p.self)) return typeOf(rowOf(p.self), n + 1);
        return r.full.type || null;
      };
      for (const r of rows) {
        const p = r.full.parent;
        if (!p || !p.self) continue;
        const g = rowOf(p.self);
        if (!g) continue;
        const gt = typeOf(g);
        if ((g.full.kind || 'account') !== 'group') ctx.error(r, 'parent', 'imp2|That is an account, not a group.');
        else if (gt && r.full.type && gt !== r.full.type) ctx.error(r, 'type', 'imp2|An account has the type of its group ({type}).', { type: i18n.run(ctx.lang, () => i18n.t(ACC.TYPES[gt])) });
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const L1 = Lg();
      if (!ctx.id) {
        const parentId = row.parent && typeof row.parent === 'number' ? row.parent : null;
        const id = L1.createAccount({ code: String(row.code), name_en: row.name_en, name_ar: row.name_ar || null, parent_id: parentId, type: parentId ? undefined : row.type });
        if (row.kind === 'group') db.run('UPDATE acc_accounts SET is_group = 1 WHERE id = ?', id);
        if (row.active === false) db.run('UPDATE acc_accounts SET active = 0 WHERE id = ?', id);
        ctx.log('Added an account', 'account', id, `${row.code} ${row.name_en}`);
        return id;
      }
      const a = db.get('SELECT * FROM acc_accounts WHERE id = ?', ctx.id);
      const parentId = row.parent && typeof row.parent === 'number' ? row.parent : a.parent_id;
      db.run('UPDATE acc_accounts SET name_en = ?, name_ar = ?, parent_id = ?, active = ? WHERE id = ?', row.name_en, row.name_ar || null, parentId, a.key ? 1 : row.active === false ? 0 : 1, a.id);
      ctx.log('Edited an account', 'account', a.id, `${a.code} ${row.name_en}`);
      return a.id;
    },
    export: (db) => db.all('SELECT a.*, p.code p_code, p.name_en p_name FROM acc_accounts a LEFT JOIN acc_accounts p ON p.id = a.parent_id ORDER BY a.code').map((a) => ({
      $id: a.id, code: a.code, name_en: a.name_en, name_ar: a.name_ar, parent: a.parent_id ? `${a.p_code} · ${a.p_name}` : null,
      kind: a.is_group ? 'group' : 'account', type: a.type, active: !!a.active,
    })),
    uses: (db, id, o) => imports.usesOf('acc_accounts', id, { ...o, entity: 'account' }),
    link: (id) => `/admin/accounting/accounts/${id}`,
    label: (v) => `${v.code || ''} · ${v.name_en || ''}`,
    examples: [
      { code: '5250', name_en: 'Generator diesel', name_ar: 'سولار المولدات', parent: '5 · Expenses', kind: 'account', active: true },
      { code: '1215', name_en: 'Staff loans', name_ar: 'سلف العاملين', parent: '11 · Current assets', kind: 'account', active: true },
      { code: '5800', name_en: 'Marketing campaigns', name_ar: 'الحملات التسويقية', parent: '5 · Expenses', kind: 'group' },
    ],
  });

  // =====================================================================================
  // Bank and cash accounts
  // =====================================================================================
  imports.register({
    key: 'bank_accounts',
    module: '/admin/accounting',
    pages: ['/admin/accounting/banking'],
    area: 'finance',
    order: 20,
    depends: ['accounts'],
    icon: 'wallet',
    table: 'acc_banks',
    title: L('Bank and cash accounts', 'الحسابات البنكية والنقدية'),
    summary: L('The mall’s bank accounts and cash boxes, with their balance on the day you start.', 'حسابات المول البنكية وخزائنه النقدية، برصيدها يوم البدء.'),
    notes: L('Each one gets its own account in the chart under Cash and banks. A balance given here is posted against Opening balances (3900): leave these accounts out of the opening trial balance, or give 0 here and put the balance there.', 'يحصل كل حساب على حساب خاص به في الدليل تحت النقدية والبنوك. الرصيد المذكور هنا يُقيد مقابل الأرصدة الافتتاحية (٣٩٠٠): لا تكرر هذه الحسابات في ميزان المراجعة الافتتاحي، أو اكتب صفرًا هنا وضع الرصيد هناك.'),
    canView: finance,
    allowed: finance,
    keys: ['name'],
    count: (db) => db.value('SELECT COUNT(*) FROM acc_banks'),
    columns: [
      { key: 'name', label: L('Account name', 'اسم الحساب'), type: 'text', required: true, max: 120, width: 28, example: 'CIB current account', aliases: ['bank account', 'account', 'اسم الحساب البنكي'], help: L('As it should read in the chart. A name already in the system is that account.', 'كما يظهر في الدليل. الاسم الموجود في النظام يعني الحساب نفسه.') },
      { key: 'name_ar', label: L('Name in Arabic', 'الاسم بالعربية'), type: 'text', max: 120, width: 26, keepOnUpdate: true, example: 'البنك التجاري الدولي – جاري' },
      { key: 'kind', label: L('Bank or cash', 'بنك أم نقدية'), type: 'enum', enum: [['bank', lab('acc|Bank account')], ['cash', lab('acc|Cash')]], width: 14, keepOnUpdate: true, example: 'bank', help: L('Empty means a bank account.', 'الفارغ يعني حسابًا بنكيًا.') },
      { key: 'bank', label: L('Bank', 'البنك'), type: 'text', max: 120, width: 18, keepOnUpdate: true, example: 'CIB' },
      { key: 'iban', label: L('IBAN', 'رقم الحساب الدولي'), type: 'text', max: 40, width: 32, keepOnUpdate: true, transform: (v) => ({ value: ibanOf(v) }) },
      { key: 'opening_balance', label: L('Balance on the start day', 'الرصيد يوم البدء'), type: 'money', min: -1e12, width: 18, keepOnUpdate: true, example: 250000, aliases: ['opening balance', 'balance', 'الرصيد الافتتاحي', 'الرصيد'], help: L('What the bank or the box held. Negative for an overdraft. Empty or 0: no opening entry.', 'ما كان في البنك أو الخزينة. بالسالب للسحب على المكشوف. الفارغ أو صفر: لا قيد افتتاحي.') },
      { key: 'opening_date', label: L('Balance on', 'الرصيد في تاريخ'), type: 'date', width: 14, keepOnUpdate: true, example: '2026-01-01', help: L('Empty: today. In a closed month it is booked on the first open day.', 'الفارغ: اليوم. إن كان في شهر مغلق يُقيد في أول يوم مفتوح.') },
    ],
    find: (db, v) => {
      const hits = db.all('SELECT id FROM acc_banks WHERE lower(trim(name)) = lower(trim(?))', v.name);
      if (hits.length > 1) return { error: 'imp2|More than one bank account has this name; rename one of them first.' };
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      if (ctx.id) return;
      ibanCheck(row, ctx);
      const { db } = ctx;
      if (db.get('SELECT id FROM acc_accounts WHERE lower(name_en) = lower(?) AND is_group = 0 AND sub = \'cash\'', row.name)) ctx.warn('name', 'imp2|An account in the chart already has this name.');
      if (r2(row.opening_balance) && row.opening_date && Lg().isLocked(row.opening_date)) ctx.warn('opening_date', 'imp2|That month is closed: the balance is booked on the first open day.');
      if (row.opening_date && row.opening_date > today()) ctx.error('opening_date', 'imp2|A balance cannot be dated in the future.');
    },
    apply(row, ctx) {
      if (ctx.id) return ctx.id;
      const b = Lg().createBank({ name: row.name, name_ar: row.name_ar || null, bank: row.bank || null, iban: ibanOf(row.iban), opening_balance: r2(row.opening_balance), opening_date: row.opening_date || today(), kind: row.kind === 'cash' ? 'cash' : 'bank', user: ctx.user });
      ctx.log('Added a bank account', 'bank', b.id, b.name);
      return b.id;
    },
    export: (db) => db.all('SELECT b.*, a.name_ar a_ar FROM acc_banks b JOIN acc_accounts a ON a.id = b.account_id ORDER BY b.kind, b.name').map((b) => ({
      $id: b.id, name: b.name, name_ar: b.a_ar, kind: b.kind, bank: b.bank, iban: b.iban, opening_balance: b.opening_balance, opening_date: b.opening_date,
    })),
    uses(db, id) {
      const b = db.get('SELECT * FROM acc_banks WHERE id = ?', id);
      if (!b) return [];
      const base = `bank-open:${id}`;
      const own = db.all('SELECT id FROM acc_entries WHERE source_base = ?', base).map((e) => e.id);
      const lines = db.value(`SELECT COUNT(*) FROM acc_lines WHERE account_id = ? ${own.length ? `AND entry_id NOT IN (${own.join(',')})` : ''}`, b.account_id);
      const out = [];
      if (lines) out.push({ n: lines, what: L('journal lines', 'سطور قيود') });
      const st = db.value('SELECT COUNT(*) FROM acc_statement_lines WHERE bank_id = ?', id);
      if (st) out.push({ n: st, what: L('bank statement lines', 'سطور كشف حساب بنكي') });
      const other = ['acc_vendors', 'acc_bill_lines', 'acc_bill_payments', 'acc_budgets'].reduce((s, t) => s + db.value(`SELECT COUNT(*) FROM ${t} WHERE account_id = ?`, b.account_id), 0);
      if (other) out.push({ n: other, what: L('other records', 'سجلات أخرى') });
      return [...out, ...entryUses(db, base)];
    },
    remove(db, id) {
      const b = db.get('SELECT * FROM acc_banks WHERE id = ?', id);
      if (!b) return;
      dropEntries(db, `bank-open:${id}`);
      db.run('DELETE FROM acc_banks WHERE id = ?', id);
      db.run('DELETE FROM acc_accounts WHERE id = ?', b.account_id);
    },
    link: (id) => `/admin/accounting/banking/${id}`,
    label: (v) => v.name || '',
    examples: [
      { name: 'CIB current account', name_ar: 'البنك التجاري الدولي – جاري', kind: 'bank', bank: 'CIB', iban: 'EG380019000500000000263180002', opening_balance: 1250000, opening_date: '2026-01-01' },
      { name: 'Main cash box', name_ar: 'الخزينة الرئيسية', kind: 'cash', opening_balance: 18500, opening_date: '2026-01-01' },
    ],
  });

  // =====================================================================================
  // Opening trial balance: one journal entry per date, rows = its lines
  // =====================================================================================
  // accounts whose balance other lists bring in (or the system computes): counted twice if also here
  const COMPUTED = {
    ar: 'imp2|Tenant receivables come from their unpaid invoices: if you import those, leave this account out or it counts twice.',
    ap: 'imp2|Supplier payables come from their unpaid bills: if you import those, leave this account out or it counts twice.',
    other_receivables: 'imp2|Staff advances imported under Salary advances post their own balance here: leave it out if you import them.',
    deposits: 'imp2|Tenant deposits come from deposit invoices: check you are not importing them twice.',
    vat_out: 'imp2|VAT is worked out from invoices and bills from now on: bring in only what was still due on the start day.',
    vat_in: 'imp2|VAT is worked out from invoices and bills from now on: bring in only what was still due on the start day.',
  };
  const opening = (db, date) => Lg().active(`opening:${date}`);
  const realLines = (db, entryId) => db.all('SELECT * FROM acc_lines WHERE entry_id = ? AND COALESCE(party_type, \'\') != ? ORDER BY sort, id', entryId, DIFF);
  // the balancing line follows the real lines; an entry with no real line left goes
  function rebalance(db, entryId) {
    const lines = realLines(db, entryId);
    if (!lines.length) {
      db.run('UPDATE acc_entries SET reversed_by = NULL WHERE reversed_by = ?', entryId);
      db.run('DELETE FROM acc_lines WHERE entry_id = ?', entryId);
      db.run('DELETE FROM acc_entries WHERE id = ?', entryId);
      return;
    }
    const diff = r2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
    const bal = db.get('SELECT * FROM acc_lines WHERE entry_id = ? AND party_type = ?', entryId, DIFF);
    if (Math.abs(diff) < 0.005) { if (bal) db.run('DELETE FROM acc_lines WHERE id = ?', bal.id); return; }
    const acct = Lg().idOf('opening_equity');
    const dr = diff < 0 ? -diff : 0;
    const cr = diff > 0 ? diff : 0;
    if (bal) db.run('UPDATE acc_lines SET account_id = ?, debit = ?, credit = ? WHERE id = ?', acct, dr, cr, bal.id);
    else db.run('INSERT INTO acc_lines (entry_id, account_id, debit, credit, memo, party_type, sort) VALUES (?, ?, ?, ?, ?, ?, ?)', entryId, acct, dr, cr, 'Opening balances', DIFF, 9999);
  }
  const otherOpening = (db, accountId) => {
    // opening entries other lists already posted to this account (banks, stock, advances)
    const banks = db.value("SELECT COUNT(*) FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.source_base LIKE 'bank-open:%' AND e.reversed_by IS NULL", accountId);
    const stock = db.value("SELECT COUNT(*) FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.source_base LIKE 'stock:%' AND e.memo LIKE 'Opening balance%' AND e.reversed_by IS NULL", accountId);
    return banks + stock;
  };
  imports.register({
    key: 'opening_balances',
    module: '/admin/accounting',
    pages: ['/admin/accounting', '/admin/accounting/journal'],
    area: 'finance',
    order: 30,
    depends: ['accounts', 'bank_accounts'],
    icon: 'report',
    table: 'acc_lines',
    title: L('Opening balances (trial balance)', 'الأرصدة الافتتاحية (ميزان المراجعة)'),
    summary: L('Every account’s balance on the day you start, as one balanced opening entry.', 'رصيد كل حساب يوم البدء، في قيد افتتاحي واحد متوازن.'),
    notes: L('One row per account, with its debit or credit balance on the start date. The rows of one date become one journal entry, “Opening balances”, which must balance: debits equal credits, or nothing is imported. Balances you import in their own lists (bank accounts, unpaid supplier bills, opening stock, salary advances, tenants’ unpaid invoices) post their own opening entries: leave those accounts out here.', 'صف لكل حساب برصيده المدين أو الدائن في تاريخ البدء. صفوف التاريخ الواحد تصبح قيدًا واحدًا هو «الأرصدة الافتتاحية» ويجب أن يتوازن: المدين يساوي الدائن، وإلا لا يُستورد شيء. الأرصدة التي تستوردها في قوائمها (الحسابات البنكية، فواتير الموردين غير المسددة، المخزون الافتتاحي، السلف، فواتير المستأجرين غير المسددة) تُسجل قيودها الافتتاحية بنفسها: لا تكررها هنا.'),
    canView: finance,
    allowed: finance,
    keys: [['account', 'date']],
    count: (db) => db.value("SELECT COUNT(*) FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.source_base LIKE 'opening:%' AND e.reversed_by IS NULL AND e.reverses_id IS NULL AND COALESCE(l.party_type, '') != ?", DIFF),
    columns: [
      { key: 'account', label: L('Account', 'الحساب'), type: 'ref', required: true, width: 36, ref: { list: postable, dataset: 'accounts', what: L('Accounts', 'الحسابات') }, example: '1110 · Petty cash', aliases: ['account code', 'acc', 'code', 'account name', 'رقم الحساب', 'اسم الحساب'], help: L('By its code or name. Groups cannot take a balance.', 'برقمه أو اسمه. المجموعات لا تأخذ رصيدًا.') },
      { key: 'debit', label: L('Debit', 'مدين'), type: 'money', width: 16, example: 18500, aliases: ['dr', 'debit balance', 'رصيد مدين', 'مدينه'] },
      { key: 'credit', label: L('Credit', 'دائن'), type: 'money', width: 16, aliases: ['cr', 'credit balance', 'رصيد دائن', 'دائنه'] },
      { key: 'date', label: L('Balance on', 'الرصيد في تاريخ'), type: 'date', required: true, width: 14, example: '2026-01-01', aliases: ['as of', 'as at', 'date', 'opening date', 'التاريخ', 'في'], help: L('The start day. One opening entry per date.', 'يوم البدء. قيد افتتاحي واحد لكل تاريخ.') },
      { key: 'memo', label: L('Note', 'ملاحظة'), type: 'text', max: 200, width: 26 },
    ],
    find: (db, v) => {
      if (!v.account || !v.date) return null;
      const e = opening(db, v.date);
      if (!e) return null;
      const l = db.get('SELECT id FROM acc_lines WHERE entry_id = ? AND account_id = ? AND COALESCE(party_type, \'\') != ? ORDER BY id LIMIT 1', e.id, v.account, DIFF);
      return l ? l.id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      const L1 = Lg();
      const dr = r2(row.debit);
      const cr = r2(row.credit);
      if (dr && cr) ctx.error('credit', 'imp2|A line is a debit or a credit, not both.');
      else if (!dr && !cr) ctx.error('debit', 'imp2|Give the debit or the credit balance.');
      const a = row.account ? db.get('SELECT * FROM acc_accounts WHERE id = ?', row.account) : null;
      if (a) {
        if (a.key === 'opening_equity') ctx.error('account', 'imp2|Opening balances (3900) balances the entry by itself: leave it out.');
        if (!a.active) ctx.warn('account', 'imp2|This account is inactive.');
        if (COMPUTED[a.key]) ctx.warn('account', COMPUTED[a.key]);
        if (otherOpening(db, a.id)) ctx.warn('account', 'imp2|This account already has an opening balance from another list (bank accounts or stock): it would count twice.');
      }
      if (row.date) {
        if (L1.isLocked(row.date)) ctx.error('date', 'imp2|The books are closed on {date}: reopen that month or choose a later date.', { date: i18n.run(ctx.lang, () => h.ui.date(row.date)) });
        else if (row.date > today()) ctx.warn('date', 'imp2|This date is in the future.');
      }
    },
    // each date's entry must balance, with what is already in it
    fileCheck(rows, ctx) {
      const { db } = ctx;
      const byDate = new Map();
      for (const r of rows) {
        if (!r.full.date) continue;
        if (!byDate.has(r.full.date)) byDate.set(r.full.date, []);
        byDate.get(r.full.date).push(r);
      }
      for (const [date, list] of byDate) {
        const e = opening(db, date);
        const kept = e ? realLines(db, e.id).filter((l) => !list.some((r) => r.id === l.id)) : [];
        const dr = r2(kept.reduce((s, l) => s + l.debit, 0) + list.reduce((s, r) => s + r2(r.full.debit), 0));
        const cr = r2(kept.reduce((s, l) => s + l.credit, 0) + list.reduce((s, r) => s + r2(r.full.credit), 0));
        if (Math.abs(dr - cr) >= 0.005) for (const r of list) ctx.error(r, r2(r.full.debit) ? 'debit' : 'credit', 'imp2|The balances on {date} do not balance: debits {dr}, credits {cr}, a difference of {diff}.', { date: i18n.run(ctx.lang, () => h.ui.date(date)), dr: fmt(dr), cr: fmt(cr), diff: fmt(Math.abs(dr - cr)) });
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const L1 = Lg();
      const dr = r2(row.debit);
      const cr = r2(row.credit);
      if (ctx.id) {
        const l = db.get('SELECT * FROM acc_lines WHERE id = ?', ctx.id);
        db.run('UPDATE acc_lines SET debit = ?, credit = ?, memo = ? WHERE id = ?', dr, cr, row.memo || null, l.id);
        rebalance(db, l.entry_id);
        return l.id;
      }
      let e = opening(db, row.date);
      if (!e) {
        if (L1.isLocked(row.date)) throw new Error('imp2|The books are closed on that date: reopen that month or choose a later date.');
        const n = db.value('SELECT COUNT(*) FROM acc_entries WHERE source_base = ?', `opening:${row.date}`) + 1;
        e = L1.post({
          date: row.date, memo: 'Opening balances', kind: 'opening', source: `opening:${row.date}#${n}`, user: ctx.user,
          lines: [{ account: row.account, debit: dr, credit: cr, memo: row.memo || null }, { account: 'opening_equity', debit: cr, credit: dr, memo: 'Opening balances', party_type: DIFF }],
        });
        ctx.log('Posted a journal entry', 'journal', e.id, e.ref);
        return db.get('SELECT id FROM acc_lines WHERE entry_id = ? AND COALESCE(party_type, \'\') != ? ORDER BY id LIMIT 1', e.id, DIFF).id;
      }
      const sort = (db.value('SELECT COALESCE(MAX(sort), 0) FROM acc_lines WHERE entry_id = ? AND COALESCE(party_type, \'\') != ?', e.id, DIFF) || 0) + 1;
      const id = Number(db.run('INSERT INTO acc_lines (entry_id, account_id, debit, credit, memo, sort) VALUES (?, ?, ?, ?, ?, ?)', e.id, row.account, dr, cr, row.memo || null, sort).lastInsertRowid);
      rebalance(db, e.id);
      return id;
    },
    export: (db) => db.all(`SELECT l.*, a.code, a.name_en, e.date FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id JOIN acc_accounts a ON a.id = l.account_id
      WHERE e.source_base LIKE 'opening:%' AND e.reversed_by IS NULL AND e.reverses_id IS NULL AND COALESCE(l.party_type, '') != ? ORDER BY e.date, l.sort, l.id`, DIFF)
      .map((l) => ({ $id: l.id, account: `${l.code} · ${l.name_en}`, debit: l.debit || null, credit: l.credit || null, date: l.date, memo: l.memo })),
    snapshot: (db, id) => db.get('SELECT * FROM acc_lines WHERE id = ?', id),
    restore(db, snap) {
      if (!snap) return;
      if (db.get('SELECT id FROM acc_lines WHERE id = ?', snap.id)) db.run('UPDATE acc_lines SET account_id = ?, debit = ?, credit = ?, memo = ? WHERE id = ?', snap.account_id, snap.debit, snap.credit, snap.memo, snap.id);
      else db.run('INSERT INTO acc_lines (id, entry_id, account_id, debit, credit, memo, party_type, party_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', snap.id, snap.entry_id, snap.account_id, snap.debit, snap.credit, snap.memo, snap.party_type, snap.party_id, snap.sort);
      rebalance(db, snap.entry_id);
    },
    remove(db, id) {
      const l = db.get('SELECT * FROM acc_lines WHERE id = ?', id);
      if (!l) return;
      db.run('DELETE FROM acc_lines WHERE id = ?', id);
      rebalance(db, l.entry_id);
    },
    uses(db, id, o) {
      const l = db.get('SELECT l.*, e.date, e.reversed_by FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.id = ?', id);
      if (!l) return [];
      const out = imports.usesOf('acc_lines', id, o);
      if (Lg().isLocked(l.date)) out.push({ n: 1, what: CLOSED });
      if (l.reversed_by) out.push({ n: 1, what: L('reversed entries', 'قيود معكوسة') });
      return out;
    },
    link: () => '/admin/accounting/journal',
    label: (v, names) => names.account || String(v.account || ''),
    examples: [
      { account: '1110 · Petty cash', debit: 18500, date: '2026-01-01' },
      { account: '1510 · Buildings and structures', debit: 450000000, date: '2026-01-01' },
      { account: '1511 · Accumulated depreciation – buildings', credit: 36000000, date: '2026-01-01' },
      { account: '3100 · Share capital', credit: 414018500, date: '2026-01-01' },
    ],
  });

  // =====================================================================================
  // Suppliers
  // =====================================================================================
  imports.register({
    key: 'suppliers',
    module: '/admin/accounting',
    pages: ['/admin/accounting/payables', '/admin/purchasing/orders'],
    area: 'finance',
    order: 40,
    icon: 'people',
    table: 'acc_vendors',
    title: L('Suppliers', 'الموردون'),
    summary: L('Who the mall buys from: tax number, contacts, bank, payment terms.', 'من يشتري منهم المول: الرقم الضريبي والتواصل والبنك وشروط السداد.'),
    canView: finance,
    allowed: finance,
    keys: ['name'],
    columns: [
      { key: 'name', label: L('Supplier name', 'اسم المورد'), type: 'text', required: true, max: 160, width: 28, example: 'Delta Lifts Co.', aliases: ['supplier', 'vendor', 'vendor name', 'المورد', 'اسم الشركه'], help: L('A name already in the system updates that supplier.', 'الاسم الموجود في النظام يحدّث المورد نفسه.') },
      { key: 'tax_id', label: L('Tax registration number', 'رقم التسجيل الضريبي'), type: 'text', max: 40, width: 18, example: '200-123-456', aliases: ['tax id', 'tax number', 'tax card', 'الرقم الضريبي', 'البطاقه الضريبيه'] },
      { key: 'phone', label: L('Phone', 'الهاتف'), type: 'text', max: 40, width: 16, example: '01001234567', help: L('A mobile, a landline or a hotline (19xxx).', 'موبايل أو تليفون أرضي أو خط ساخن من خمسة أرقام.') },
      { key: 'email', label: L('Email', 'البريد الإلكتروني'), type: 'email', width: 26, example: 'accounts@deltalifts.com' },
      { key: 'bank', label: L('Bank', 'البنك'), type: 'text', max: 120, width: 16, example: 'NBE' },
      { key: 'iban', label: L('IBAN', 'رقم الحساب الدولي'), type: 'text', max: 40, width: 32, transform: (v) => ({ value: ibanOf(v) }) },
      { key: 'terms_days', label: L('Payment terms (days)', 'شروط السداد (أيام)'), type: 'int', min: 0, maxValue: 365, width: 14, example: 30, help: L('Days from the bill date to the due date. Empty: 30.', 'عدد الأيام من تاريخ الفاتورة حتى الاستحقاق. الفارغ: ٣٠.') },
      { key: 'account', label: L('Usual expense account', 'حساب المصروف المعتاد'), type: 'ref', width: 32, ref: { list: expenseChoices, dataset: 'accounts', what: L('Expense accounts', 'حسابات المصروفات') }, example: '5200 · Maintenance and repairs', help: L('Offered first on their bills. Optional.', 'يُقترح أولًا على فواتيره. اختياري.') },
      { key: 'contract', label: L('Service contract', 'عقد الخدمة'), type: 'ref', width: 26, ref: { list: contractChoices, dataset: 'contracts', what: L('Service contracts', 'عقود الخدمات') } },
      { key: 'active', label: L('Active', 'نشط'), type: 'bool', width: 10, example: 'yes' },
    ],
    find: (db, v) => {
      const hits = db.all('SELECT id FROM acc_vendors WHERE lower(trim(name)) = lower(trim(?))', v.name);
      if (hits.length > 1) return { error: 'imp2|More than one supplier has this name; rename one of them first.' };
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      ibanCheck(row, ctx);
      if (ctx.db.get('SELECT id FROM acc_vendors WHERE lower(trim(name)) = lower(trim(?)) AND id != ?', row.name, ctx.id || 0)) ctx.error('name', 'imp2|Another supplier already has this name.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const v = [row.name, row.tax_id || null, row.phone || null, row.email || null, row.bank || null, ibanOf(row.iban), row.terms_days ?? 30, row.account || null, row.contract || null];
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO acc_vendors (name, tax_id, phone, email, bank, iban, terms_days, account_id, contract_id, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...v, row.active === false ? 0 : 1, now()).lastInsertRowid);
        ctx.log('Added a supplier', 'vendor', id, row.name);
        return id;
      }
      db.run('UPDATE acc_vendors SET name = ?, tax_id = ?, phone = ?, email = ?, bank = ?, iban = ?, terms_days = ?, account_id = ?, contract_id = ?, active = ? WHERE id = ?', ...v, row.active === false ? 0 : 1, ctx.id);
      ctx.log('Edited a supplier', 'vendor', ctx.id, row.name);
      return ctx.id;
    },
    export: (db) => db.all('SELECT v.*, a.code a_code, a.name_en a_name, c.ref c_ref, c.counterparty c_party FROM acc_vendors v LEFT JOIN acc_accounts a ON a.id = v.account_id LEFT JOIN contracts c ON c.id = v.contract_id ORDER BY v.name').map((v) => ({
      $id: v.id, name: v.name, tax_id: v.tax_id, phone: v.phone, email: v.email, bank: v.bank, iban: v.iban, terms_days: v.terms_days,
      account: v.account_id ? `${v.a_code} · ${v.a_name}` : null, contract: v.contract_id ? `${v.c_ref} · ${v.c_party}` : null, active: !!v.active,
    })),
    uses(db, id, o) {
      const out = imports.usesOf('acc_vendors', id, { ...o, entity: 'vendor' });
      const po = db.value('SELECT COUNT(*) FROM pur_orders WHERE vendor_id = ?', id);
      if (po) out.push({ n: po, what: L('purchase orders', 'أوامر شراء') });
      return out;
    },
    link: (id) => `/admin/accounting/vendors/${id}`,
    label: (v) => v.name || '',
    examples: [
      { name: 'Delta Lifts Co.', tax_id: '200-123-456', phone: '01001234567', email: 'accounts@deltalifts.com', bank: 'NBE', terms_days: 30, account: '5200 · Maintenance and repairs', active: true },
      { name: 'Shield Security Services', tax_id: '311-555-901', phone: '0225550000', terms_days: 45, account: '5210 · Security', active: true },
    ],
  });

  // =====================================================================================
  // Unpaid supplier bills on the start day
  // =====================================================================================
  const billOpen = (b) => b && ['approved', 'partial'].includes(b.status);
  imports.register({
    key: 'supplier_bills',
    module: '/admin/accounting',
    pages: ['/admin/accounting/payables'],
    area: 'finance',
    order: 50,
    depends: ['suppliers'],
    icon: 'file',
    table: 'acc_bills',
    title: L('Unpaid supplier bills (start day)', 'فواتير الموردين غير المسددة (يوم البدء)'),
    summary: L('What the mall still owed suppliers on the day you start, bill by bill.', 'ما كان المول مدينًا به للموردين يوم البدء، فاتورة بفاتورة.'),
    notes: L('Each bill is saved as approved for the amount still owed and posted against Opening balances (3900), so payables and their ageing are right from day one. Leave “Accounts payable – suppliers” out of the opening trial balance. Pay them from Payables as usual.', 'تُحفظ كل فاتورة معتمدة بالمبلغ المتبقي وتُقيد مقابل الأرصدة الافتتاحية (٣٩٠٠)، فتكون الذمم الدائنة وأعمارها صحيحة من أول يوم. لا تضع «الذمم الدائنة – الموردون» في ميزان المراجعة الافتتاحي. سددها من الذمم الدائنة كالمعتاد.'),
    canView: finance,
    allowed: finance,
    keys: [['supplier', 'vendor_ref']],
    count: (db) => db.value("SELECT COUNT(*) FROM acc_bills WHERE status IN ('approved','partial')"),
    columns: [
      { key: 'supplier', label: L('Supplier', 'المورد'), type: 'ref', required: true, width: 28, ref: { list: vendorChoices, dataset: 'suppliers', what: L('Suppliers', 'الموردين') }, example: 'Delta Lifts Co.', aliases: ['vendor', 'supplier name', 'اسم المورد'] },
      { key: 'vendor_ref', label: L('Supplier’s invoice number', 'رقم فاتورة المورد'), type: 'text', required: true, max: 60, width: 20, example: 'INV-4471', aliases: ['invoice no', 'invoice number', 'bill no', 'رقم الفاتوره'], help: L('With the supplier, it finds the bill again on a later import.', 'مع المورد يحدد الفاتورة نفسها عند استيراد لاحق.') },
      { key: 'date', label: L('Bill date', 'تاريخ الفاتورة'), type: 'date', required: true, width: 14, keepOnUpdate: true, example: '2025-12-10' },
      { key: 'due_date', label: L('Due date', 'تاريخ الاستحقاق'), type: 'date', width: 14, example: '2026-01-09', help: L('Empty: the bill date plus the supplier’s payment terms.', 'الفارغ: تاريخ الفاتورة مضافًا إليه مدة السداد للمورد.') },
      { key: 'amount', label: L('Amount still owed', 'المبلغ المتبقي'), type: 'money', required: true, width: 16, keepOnUpdate: true, example: 48500, aliases: ['amount', 'balance', 'outstanding', 'المبلغ', 'الرصيد', 'المستحق'], help: L('VAT included. If part was paid before the start day, only what is left.', 'شاملًا الضريبة. إن سُدد جزء قبل يوم البدء فاكتب المتبقي فقط.') },
      { key: 'memo', label: L('Note', 'ملاحظة'), type: 'text', max: 300, width: 28 },
    ],
    find: (db, v) => {
      if (!v.supplier || !v.vendor_ref) return null;
      const b = db.get("SELECT id FROM acc_bills WHERE vendor_id = ? AND lower(trim(vendor_ref)) = lower(trim(?)) AND status != 'void' ORDER BY id DESC LIMIT 1", v.supplier, v.vendor_ref);
      return b ? b.id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      if (!ctx.id && !(r2(row.amount) > 0)) ctx.error('amount', 'imp2|Give the amount still owed.');
      if (row.date && row.date > today()) ctx.error('date', 'imp2|A bill on the start day cannot be dated in the future.');
      if (row.due_date && row.date && row.due_date < row.date) ctx.error('due_date', 'imp2|The due date is before the bill date.');
      if (ctx.id) {
        const b = db.get('SELECT * FROM acc_bills WHERE id = ?', ctx.id);
        const changing = ['due_date', 'memo'].some((k) => ctx.provided.has(k) && String(row[k] ?? '') !== String(b[k] ?? ''));
        if (changing && (b.source !== 'import' || !billOpen(b))) ctx.error('vendor_ref', 'imp2|This bill was entered in the office or is settled: change it there.');
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const L1 = Lg();
      if (ctx.id) {
        db.run('UPDATE acc_bills SET due_date = COALESCE(?, due_date), memo = ? WHERE id = ?', row.due_date || null, row.memo || null, ctx.id);
        return ctx.id;
      }
      const bill = L1.createBill({ vendor_id: row.supplier, vendor_ref: row.vendor_ref, date: row.date, due_date: row.due_date || null, lines: [{ account: 'opening_equity', amount: r2(row.amount), description: 'Opening balances' }], vat: 0, memo: row.memo || null, source: 'import', user: ctx.user });
      // approved as it stands on the start day: posted on the first open day if its month is closed
      db.run("UPDATE acc_bills SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", ctx.user ? ctx.user.id : null, now(), bill.id);
      L1.postBill(db.get('SELECT * FROM acc_bills WHERE id = ?', bill.id));
      ctx.log('Added a supplier bill', 'bill', bill.id, bill.ref);
      ctx.log('Approved a supplier bill', 'bill', bill.id, bill.ref);
      return bill.id;
    },
    export: (db) => db.all("SELECT b.*, v.name vendor FROM acc_bills b JOIN acc_vendors v ON v.id = b.vendor_id WHERE b.status IN ('approved','partial') AND b.vendor_ref IS NOT NULL ORDER BY b.date, b.id").map((b) => ({
      $id: b.id, supplier: b.vendor, vendor_ref: b.vendor_ref, date: b.date, due_date: b.due_date, amount: r2(b.total - b.paid), memo: b.memo,
    })),
    uses(db, id, o) {
      const out = imports.usesOf('acc_bills', id, { ...o, ignore: ['acc_bill_lines'], entity: 'bill' });
      const pb = db.value('SELECT COUNT(*) FROM pur_bills WHERE bill_id = ?', id);
      if (pb) out.push({ n: pb, what: L('purchase order bills', 'فواتير أوامر شراء') });
      return [...out, ...entryUses(db, `bill:${id}`)];
    },
    remove(db, id) {
      dropEntries(db, `bill:${id}`);
      db.run('DELETE FROM acc_bills WHERE id = ?', id);
    },
    link: (id) => `/admin/accounting/bills/${id}`,
    label: (v, names) => `${names.supplier || ''} · ${v.vendor_ref || ''}`,
    examples: [
      { supplier: 'Delta Lifts Co.', vendor_ref: 'INV-4471', date: '2025-12-10', due_date: '2026-01-09', amount: 48500 },
      { supplier: 'Shield Security Services', vendor_ref: 'SS-2025-118', date: '2025-12-31', amount: 212000, memo: 'December guarding' },
    ],
  });

  // =====================================================================================
  // Fixed assets
  // =====================================================================================
  const CLASS_OPTS = opts(ACC.ASSET_CLASSES);
  const monthsFrom = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
  imports.register({
    key: 'fixed_assets',
    module: '/admin/accounting',
    pages: ['/admin/accounting/assets'],
    area: 'finance',
    order: 60,
    icon: 'unit',
    table: 'acc_assets',
    title: L('Fixed assets', 'الأصول الثابتة'),
    summary: L('The asset register: cost, date, useful life and the depreciation already charged.', 'سجل الأصول: التكلفة والتاريخ والعمر الإنتاجي والإهلاك المحمّل حتى الآن.'),
    notes: L('Assets are registered as already in the books: no entry is posted for their cost (it comes with the opening trial balance, with the accumulated depreciation). The depreciation charged before the start day is kept, so the monthly run carries on from the next month without charging it twice.', 'تُسجل الأصول على أنها موجودة في الدفاتر: لا يُقيد قيد لتكلفتها (تأتي مع ميزان المراجعة الافتتاحي ومعها مجمع الإهلاك). يُحفظ الإهلاك المحمّل قبل يوم البدء، فيستمر الإهلاك الشهري من الشهر التالي دون أن يُحمّل مرتين.'),
    canView: finance,
    allowed: finance,
    keys: ['ref'],
    columns: [
      { key: 'ref', label: L('Asset number', 'رقم الأصل'), type: 'code', max: 20, width: 14, keepOnUpdate: true, aliases: ['asset no', 'asset code', 'tag', 'رقم الاصل', 'الكود'], help: L('Leave empty for new assets: the office numbers them (FA-0001…).', 'اتركه فارغًا للأصول الجديدة: يرقمها النظام (FA-0001…).') },
      { key: 'name', label: L('Asset', 'الأصل'), type: 'text', required: true, max: 160, width: 30, example: 'Escalator E2 – main atrium', aliases: ['asset name', 'description', 'اسم الاصل', 'الوصف'] },
      { key: 'class', label: L('Class', 'الفئة'), type: 'enum', required: true, enum: CLASS_OPTS, width: 22, keepOnUpdate: true, example: 'mep', help: L('Sets the accounts and the default useful life.', 'تحدد الحسابات والعمر الإنتاجي الافتراضي.') },
      { key: 'cost', label: L('Cost', 'التكلفة'), type: 'money', required: true, width: 16, keepOnUpdate: true, example: 3200000 },
      { key: 'acquired_on', label: L('Acquired on', 'تاريخ الاقتناء'), type: 'date', required: true, width: 14, keepOnUpdate: true, example: '2022-07-01' },
      { key: 'life_months', label: L('Useful life (months)', 'العمر الإنتاجي (بالشهور)'), type: 'int', min: 1, maxValue: 1200, width: 16, keepOnUpdate: true, example: 180, help: L('Empty: the class default (MEP 15 years, IT 3 years…).', 'الفارغ: الافتراضي للفئة (المعدات ١٥ سنة، الحاسب ٣ سنوات…).') },
      { key: 'residual', label: L('Residual value', 'القيمة التخريدية'), type: 'money', width: 14, keepOnUpdate: true },
      { key: 'depreciated', label: L('Depreciation charged so far', 'الإهلاك المحمّل حتى الآن'), type: 'money', width: 18, keepOnUpdate: true, example: 853333.33, aliases: ['accumulated depreciation', 'acc dep', 'مجمع الاهلاك'], help: L('The accumulated depreciation on the start day. Empty or 0: none yet.', 'مجمع الإهلاك يوم البدء. الفارغ أو صفر: لا إهلاك بعد.') },
      { key: 'depreciated_to', label: L('Charged up to (month)', 'محمّل حتى شهر'), type: 'month', width: 16, keepOnUpdate: true, example: '2026-12', help: L('The last month that depreciation covers. Needed with the depreciation charged.', 'آخر شهر يغطيه الإهلاك. مطلوب مع الإهلاك المحمّل.') },
      { key: 'location', label: L('Location', 'الموقع'), type: 'text', max: 120, width: 20, example: 'Main atrium' },
      { key: 'notes', label: L('Notes', 'ملاحظات'), type: 'text', max: 2000, multiline: true, width: 26 },
    ],
    find: (db, v) => {
      const a = db.get('SELECT id FROM acc_assets WHERE ref = ? COLLATE NOCASE', v.ref);
      return a ? a.id : null;
    },
    rowCheck(row, ctx) {
      if (ctx.id) return;
      const { db } = ctx;
      const cost = r2(row.cost);
      const residual = r2(row.residual);
      const dep = r2(row.depreciated);
      if (!(cost > 0)) ctx.error('cost', 'imp2|Give the cost.');
      if (residual >= cost && cost > 0) ctx.error('residual', 'imp2|The residual value must be below the cost.');
      if (row.acquired_on && row.acquired_on > today()) ctx.error('acquired_on', 'imp2|An asset cannot be acquired in the future.');
      if (row.ref && db.get('SELECT id FROM acc_assets WHERE ref = ? COLLATE NOCASE', row.ref)) ctx.error('ref', 'imp|This code is already used.');
      if (dep) {
        if (dep > r2(cost - residual) + 0.005) ctx.error('depreciated', 'imp2|More depreciation than the cost less the residual value.');
        if (!row.depreciated_to) ctx.error('depreciated_to', 'imp2|Give the month the depreciation runs to.');
        else if (row.acquired_on && row.depreciated_to < row.acquired_on.slice(0, 7)) ctx.error('depreciated_to', 'imp2|That month is before the asset was acquired.');
        else if (row.depreciated_to > today().slice(0, 7)) ctx.error('depreciated_to', 'imp2|That month is in the future.');
      } else if (row.depreciated_to && ctx.provided.has('depreciated_to')) ctx.warn('depreciated_to', 'imp2|No depreciation was given, so this month is not used.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      if (ctx.id) {
        db.run('UPDATE acc_assets SET name = ?, location = ?, notes = ? WHERE id = ?', row.name, row.location || null, row.notes || null, ctx.id);
        ctx.log('Updated an asset', 'asset', ctx.id, row.name);
        return ctx.id;
      }
      const a = Lg().createAsset({ name: row.name, class: row.class, cost: r2(row.cost), acquired_on: row.acquired_on, life_months: row.life_months || null, residual: r2(row.residual), location: row.location || null, notes: row.notes || null, user: ctx.user });
      if (row.ref) db.run('UPDATE acc_assets SET ref = ? WHERE id = ?', row.ref, a.id);
      // depreciation charged before the start day: spread month by month, without entries (the trial
      // balance carries it), so the monthly run continues from the month after
      const dep = r2(row.depreciated);
      if (dep > 0 && row.depreciated_to) {
        const first = row.acquired_on.slice(0, 7);
        const n = monthsFrom(first, row.depreciated_to) + 1;
        const each = Math.floor((dep / n) * 100) / 100;
        let left = dep;
        for (let i = 0, p = first; i < n; i++, p = Lg().addMonthsYM(p, 1)) {
          const amt = i === n - 1 ? r2(left) : each;
          left = r2(left - amt);
          if (amt > 0) db.run('INSERT INTO acc_depreciation (asset_id, period, amount, entry_id) VALUES (?, ?, ?, NULL)', a.id, p, amt);
        }
      }
      ctx.log('Added an asset', 'asset', a.id, `${row.ref || a.ref} ${row.name}`);
      return a.id;
    },
    export: (db) => db.all("SELECT a.*, (SELECT COALESCE(SUM(amount), 0) FROM acc_depreciation d WHERE d.asset_id = a.id) dep, (SELECT MAX(period) FROM acc_depreciation d WHERE d.asset_id = a.id) dep_to FROM acc_assets a WHERE a.status = 'active' ORDER BY a.ref").map((a) => ({
      $id: a.id, ref: a.ref, name: a.name, class: a.class, cost: a.cost, acquired_on: a.acquired_on, life_months: a.life_months, residual: a.residual || null,
      depreciated: a.dep ? r2(a.dep) : null, depreciated_to: a.dep ? a.dep_to : null, location: a.location, notes: a.notes,
    })),
    uses(db, id) {
      const posted = db.value('SELECT COUNT(*) FROM acc_depreciation WHERE asset_id = ? AND entry_id IS NOT NULL', id);
      const out = posted ? [{ n: posted, what: L('posted depreciation months', 'أشهر إهلاك مُقيدة') }] : [];
      if (db.value("SELECT COUNT(*) FROM acc_assets WHERE id = ? AND status != 'active'", id)) out.push({ n: 1, what: L('disposals', 'عمليات استبعاد') });
      return out;
    },
    remove(db, id) {
      db.run('DELETE FROM acc_depreciation WHERE asset_id = ?', id);
      db.run('DELETE FROM acc_assets WHERE id = ?', id);
    },
    link: (id) => `/admin/accounting/assets/${id}`,
    label: (v) => `${v.ref ? `${v.ref} · ` : ''}${v.name || ''}`,
    examples: [
      { name: 'Escalator E2 – main atrium', class: 'mep', cost: 3200000, acquired_on: '2022-07-01', life_months: 180, depreciated: 693333.33, depreciated_to: '2025-12', location: 'Main atrium' },
      { name: 'Reception furniture', class: 'furniture', cost: 185000, acquired_on: '2024-03-15', depreciated: 64750, depreciated_to: '2025-12', location: 'Customer service desk' },
    ],
  });

  // =====================================================================================
  // Store items and their opening stock
  // =====================================================================================
  const UNIT_OPTS = opts(PUR.UNITS);
  const CAT_OPTS = opts(PUR.CATEGORIES);
  const openingMove = (db, itemId) => db.get("SELECT * FROM inv_moves WHERE item_id = ? AND kind = 'opening' ORDER BY id LIMIT 1", itemId);
  imports.register({
    key: 'stock_items',
    module: '/admin/purchasing',
    pages: ['/admin/purchasing/stock'],
    area: 'finance',
    order: 70,
    icon: 'wrench',
    table: 'inv_items',
    title: L('Store items and opening stock', 'أصناف المخزن والرصيد الافتتاحي'),
    summary: L('Spare parts and consumables: code, unit, reorder levels, and what is on the shelves today.', 'قطع الغيار والمستهلكات: الكود والوحدة وحدود إعادة الطلب، والموجود على الرفوف اليوم.'),
    notes: L('The quantity on hand of a new item comes in as opening stock at its unit cost, posted to inventory against Opening balances (3900): leave the inventory account out of the opening trial balance. Later counts are adjustments on the item’s page.', 'الكمية الموجودة لصنف جديد تُسجل رصيدًا افتتاحيًا بتكلفة الوحدة، وتُقيد في المخزون مقابل الأرصدة الافتتاحية (٣٩٠٠): لا تضع حساب المخزون في ميزان المراجعة الافتتاحي. الجرد اللاحق يتم بتسويات من صفحة الصنف.'),
    canView: buyer,
    allowed: buyer,
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Item code', 'كود الصنف'), type: 'code', required: true, max: 30, width: 14, keepOnUpdate: true, example: 'EL-0420', aliases: ['code', 'sku', 'part no', 'part number', 'الكود', 'رقم الصنف'] },
      { key: 'name', label: L('Item', 'الصنف'), type: 'text', required: true, max: 120, width: 30, example: 'LED panel 60×60 40W', aliases: ['item name', 'description', 'اسم الصنف', 'الوصف'] },
      { key: 'name_ar', label: L('Name in Arabic', 'الاسم بالعربية'), type: 'text', max: 120, width: 26, example: 'لوحة إضاءة ليد ٦٠×٦٠ ٤٠ وات' },
      { key: 'unit', label: L('Unit', 'الوحدة'), type: 'enum', enum: UNIT_OPTS, width: 12, example: 'pcs', help: L('Empty: pieces.', 'الفارغ: قطعة.') },
      { key: 'category', label: L('Category', 'الفئة'), type: 'enum', enum: CAT_OPTS, width: 18, example: 'electrical', help: L('Empty: General.', 'الفارغ: عام.') },
      { key: 'min_qty', label: L('Reorder when at or below', 'إعادة الطلب عند أو أقل من'), type: 'number', min: 0, width: 16, example: 10 },
      { key: 'reorder_qty', label: L('Quantity to order', 'الكمية المطلوبة'), type: 'number', min: 0, width: 14, example: 40 },
      { key: 'location', label: L('Shelf / location', 'الرف / المكان'), type: 'text', max: 80, width: 16, example: 'Store B · rack 3' },
      { key: 'active', label: L('In use', 'مستخدم'), type: 'bool', width: 10, example: 'yes' },
      { key: 'opening_qty', label: L('On hand today', 'الموجود اليوم'), type: 'number', min: 0, width: 14, keepOnUpdate: true, example: 24, aliases: ['qty', 'quantity', 'on hand', 'stock', 'الكميه', 'الرصيد'], help: L('New items only: the opening stock.', 'للأصناف الجديدة فقط: الرصيد الافتتاحي.') },
      { key: 'opening_cost', label: L('Unit cost', 'تكلفة الوحدة'), type: 'money', width: 14, keepOnUpdate: true, example: 950, help: L('What one unit cost (before VAT).', 'تكلفة الوحدة الواحدة (قبل الضريبة).') },
      { key: 'opening_date', label: L('Counted on', 'تاريخ الجرد'), type: 'date', width: 14, keepOnUpdate: true, help: L('Empty: today.', 'الفارغ: اليوم.') },
    ],
    find: (db, v) => {
      const it = db.get('SELECT id FROM inv_items WHERE code = ? COLLATE NOCASE', v.code);
      return it ? it.id : null;
    },
    rowCheck(row, ctx) {
      if (ctx.id) return;
      if (r2(row.opening_qty) > 0 && !(r2(row.opening_cost) > 0)) ctx.warn('opening_cost', 'imp2|No unit cost: the opening stock is valued at zero.');
      if (row.opening_cost && !r2(row.opening_qty) && ctx.provided.has('opening_cost')) ctx.warn('opening_cost', 'imp2|A unit cost without a quantity is not used.');
      if (row.opening_date && row.opening_date > today()) ctx.error('opening_date', 'imp2|A count cannot be dated in the future.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const unit = row.unit || 'pcs';
      const cat = row.category || 'general';
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO inv_items (code, name, name_ar, unit, category, min_qty, reorder_qty, location, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          String(row.code).toUpperCase(), row.name, row.name_ar || null, unit, cat, r3(row.min_qty), r3(row.reorder_qty), row.location || null, row.active === false ? 0 : 1, now(), now()).lastInsertRowid);
        const q = r3(row.opening_qty);
        if (q > 0) h.purchasing.move({ item_id: id, kind: 'opening', qty: q, unit_cost: r2(row.opening_cost), date: row.opening_date || today(), user: ctx.user });
        ctx.log('Added a stock item', 'stock_item', id, `${String(row.code).toUpperCase()} · ${row.name}`);
        return id;
      }
      db.run('UPDATE inv_items SET name = ?, name_ar = ?, category = ?, unit = ?, location = ?, min_qty = ?, reorder_qty = ?, active = ?, updated_at = ? WHERE id = ?',
        row.name, row.name_ar || null, cat, unit, row.location || null, r3(row.min_qty), r3(row.reorder_qty), row.active === false ? 0 : 1, now(), ctx.id);
      ctx.log('Edited a stock item', 'stock_item', ctx.id, row.code);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM inv_items ORDER BY code').map((i) => {
      const m = openingMove(db, i.id);
      return {
        $id: i.id, code: i.code, name: i.name, name_ar: i.name_ar, unit: i.unit, category: i.category, min_qty: i.min_qty, reorder_qty: i.reorder_qty, location: i.location, active: !!i.active,
        opening_qty: m ? m.qty : null, opening_cost: m ? m.unit_cost : null, opening_date: m ? m.date : null,
      };
    }),
    uses(db, id) {
      const out = [];
      const moves = db.value("SELECT COUNT(*) FROM inv_moves WHERE item_id = ? AND kind != 'opening'", id);
      if (moves) out.push({ n: moves, what: L('stock movements', 'حركات مخزون') });
      const lines = ['pur_request_lines', 'pur_order_lines'].reduce((s, t) => s + db.value(`SELECT COUNT(*) FROM ${t} WHERE item_id = ?`, id), 0);
      if (lines) out.push({ n: lines, what: L('purchase lines', 'بنود شراء') });
      for (const m of db.all("SELECT id FROM inv_moves WHERE item_id = ? AND kind = 'opening'", id)) out.push(...entryUses(db, `stock:${m.id}`));
      return out;
    },
    remove(db, id) {
      for (const m of db.all('SELECT id FROM inv_moves WHERE item_id = ?', id)) dropEntries(db, `stock:${m.id}`);
      db.run('DELETE FROM inv_moves WHERE item_id = ?', id);
      db.run('DELETE FROM inv_items WHERE id = ?', id);
    },
    link: (id) => `/admin/purchasing/stock/${id}`,
    label: (v) => `${v.code || ''} · ${v.name || ''}`,
    examples: [
      { code: 'EL-0420', name: 'LED panel 60×60 40W', name_ar: 'لوحة إضاءة ليد ٦٠×٦٠ ٤٠ وات', unit: 'pcs', category: 'electrical', min_qty: 10, reorder_qty: 40, location: 'Store B · rack 3', active: true, opening_qty: 24, opening_cost: 950 },
      { code: 'CL-0110', name: 'Floor cleaner 5 L', unit: 'l', category: 'cleaning', min_qty: 20, reorder_qty: 60, active: true, opening_qty: 35, opening_cost: 210 },
    ],
  });
};
