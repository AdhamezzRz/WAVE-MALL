'use strict';

// Revenue from Excel: opening balances (what tenants still owe at go-live), post-dated cheques (the
// portfolio) and tenants' monthly sales (turnover). Each saves what the module itself saves
// (billing.js, routes/cheques.js, revenue/turnover.js).
//
// Opening balances in the books: an unpaid invoice from the old system is not this year's income
// again. Each one is kept as an open invoice (so collections, reminders, statements and cheques work
// on it) and posted as Accounts receivable against Opening balances (3900) — so Accounts receivable
// must not also be in an opening trial balance, or it counts twice. Payments made later post as
// usual (bank against receivable).

const i18n = require('../../i18n');

const L = (en, ar) => ({ en, ar });
const lab = (key) => ({ en: i18n.english(key), ar: typeof i18n.AR[key] === 'string' ? i18n.AR[key] : i18n.english(key) });
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const blank = (x) => x === null || x === undefined || x === '';
function same(a, b) {
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  if (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && String(a).trim() !== '' && String(b).trim() !== '') return Math.abs(Number(a) - Number(b)) < 0.005;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
const OPENING_KINDS = ['rent', 'service', 'other', 'utility', 'penalty', 'deposit', 'key', 'turnover', 'service_recon', 'media', 'specialty', 'parking'];

module.exports = function revenueDatasets(imports, h) {
  const { M } = h;
  const now = () => M.now();
  const today = () => M.today();
  const systemRef = (prefix) => new RegExp(`^${prefix}-\\d{4}(-\\d+)?$`, 'i');
  const brandRef = { list: (db) => db.all('SELECT id, name FROM brands ORDER BY name').map((b) => ({ id: b.id, name: b.name })), dataset: 'brands', what: L('Brands', 'العلامات التجارية') };
  const leaseRef = { list: (db) => db.all("SELECT s.id, s.ref, b.name brand FROM leases s JOIN brands b ON b.id = s.brand_id ORDER BY s.status = 'active' DESC, s.ref DESC").map((s) => ({ id: s.id, name: s.ref, alt: [`${s.ref} · ${s.brand}`] })), dataset: 'leases', what: L('Leases', 'عقود الإيجار') };
  const kindOpts = () => OPENING_KINDS.filter((k) => Object.hasOwn(M.INVOICE_KINDS, k) || ['service_recon', 'media', 'specialty', 'parking', 'turnover', 'utility', 'penalty'].includes(k))
    .map((k) => [k, { en: i18n.run('en', () => M.INVOICE_KINDS[k]) || k, ar: i18n.run('ar', () => M.INVOICE_KINDS[k]) || k }]);

  // an invoice the import created goes, with its entries in the books
  function dropInvoice(db, inv) {
    for (const p of db.all('SELECT id FROM payments WHERE invoice_id = ?', inv.id)) {
      if (h.ledger) try { h.ledger.unpost(`pay:${p.id}`, { memo: 'Excel import undone' }); } catch { /* nothing posted */ }
      db.run('DELETE FROM payments WHERE id = ?', p.id);
    }
    if (h.ledger) try { h.ledger.unpost(`inv:${inv.id}`, { memo: `Invoice ${inv.ref}: Excel import undone` }); } catch { /* nothing posted */ }
    db.run('UPDATE cheques SET invoice_id = NULL WHERE invoice_id = ?', inv.id);
    db.run('DELETE FROM invoices WHERE id = ?', inv.id);
  }

  // ======================================================================== opening balances
  imports.register({
    key: 'opening-balances',
    module: '/admin/billing',
    pages: ['/admin/billing'],
    area: 'revenue',
    order: 10,
    depends: ['brands', 'leases'],
    icon: 'bill',
    table: 'invoices',
    title: L('Opening balances (unpaid invoices)', 'الأرصدة الافتتاحية (فواتير غير مسددة)'),
    summary: L('What each tenant still owes on the day the office goes live: one row per unpaid invoice from your old system.', 'ما يستحق على كل مستأجر يوم بدء العمل بالنظام: صف لكل فاتورة غير مسددة من نظامك القديم.'),
    notes: L('Each row becomes an open invoice under your own invoice number, so collections, reminders, statements and cheques work on it. In the books it is posted as Accounts receivable against Opening balances (3900), not as income: leave Accounts receivable out of any opening trial balance, or it counts twice. Give the full invoice amount and what was already paid on it.', 'يصبح كل صف فاتورة مفتوحة برقم فاتورتك نفسه، فتعمل عليها المتابعة والتذكيرات وكشوف الحساب والشيكات. وتُقيد في الدفاتر كذمم مدينة مقابل الأرصدة الافتتاحية (3900)، لا كإيراد: لا تُدرج الذمم المدينة في أي ميزان مراجعة افتتاحي، وإلا احتُسبت مرتين. أدخل قيمة الفاتورة كاملة وما سُدد منها.'),
    allowed: (req) => h.can(req, 'manager') || h.canFinance(req),
    keys: ['ref'],
    count: (db) => db.value("SELECT COUNT(*) FROM invoices WHERE source = 'opening'"),
    columns: [
      { key: 'ref', label: L('Invoice number', 'رقم الفاتورة'), type: 'code', required: true, max: 40, width: 16, example: 'INV-2026-0841', aliases: ['invoice', 'invoice no', 'invoice ref', 'رقم الفاتوره', 'الفاتورة'], help: L('The number in your old system. It stays the invoice’s number here.', 'الرقم في نظامك القديم، ويبقى رقم الفاتورة هنا.') },
      { key: 'lease', label: L('Lease', 'العقد'), type: 'ref', width: 18, ref: leaseRef, aliases: ['contract', 'lease ref', 'رقم العقد'], help: L('The lease it belongs to (its number). Empty for charges outside a lease.', 'العقد الذي تتبعه (رقمه). اتركه فارغًا للمطالبات خارج العقود.') },
      { key: 'brand', label: L('Tenant (brand)', 'المستأجر (العلامة)'), type: 'ref', width: 22, ref: brandRef, aliases: ['tenant', 'customer', 'المستاجر', 'العميل'], help: L('Needed when there is no lease; with a lease it must be the lease’s tenant.', 'مطلوب إن لم يوجد عقد؛ ومع العقد يجب أن يكون مستأجره.') },
      { key: 'kind', label: L('For', 'نوع المطالبة'), type: 'enum', enum: kindOpts, width: 16, example: 'rent', help: L('Empty means Rent when there is a lease, else Other charge.', 'الفارغ يعني «إيجار» مع العقد، و«مطالبة أخرى» بدونه.') },
      { key: 'period_start', label: L('Period from', 'الفترة من'), type: 'date', width: 14, example: '2026-10-01' },
      { key: 'period_end', label: L('Period to', 'الفترة إلى'), type: 'date', width: 14, example: '2026-12-31' },
      { key: 'due_date', label: L('Due date', 'تاريخ الاستحقاق'), type: 'date', required: true, width: 14, example: '2026-10-01' },
      { key: 'amount', label: L('Invoice amount', 'قيمة الفاتورة'), type: 'money', required: true, width: 15, example: 186000, help: L('The whole invoice, VAT included.', 'قيمة الفاتورة كاملة شاملة الضريبة.') },
      { key: 'paid', label: L('Already paid', 'المسدد منها'), type: 'money', width: 14, example: 60000, help: L('What the tenant has paid on it so far. Empty: nothing.', 'ما سدده المستأجر منها حتى الآن. الفارغ: لا شيء.') },
      { key: 'note', label: L('Note', 'ملاحظة'), type: 'text', max: 300, width: 28 },
    ],
    find(db, v) {
      const hit = db.get('SELECT id, source FROM invoices WHERE ref = ? COLLATE NOCASE', v.ref);
      if (!hit) return null;
      if (hit.source !== 'opening') return { error: 'imp1|{ref} is an invoice the office made; an opening balance needs your old invoice number.', params: { ref: v.ref } };
      return hit.id;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      const cur = ctx.current;
      if (cur) {
        for (const k of ['lease', 'brand', 'kind', 'amount', 'paid']) {
          if (!ctx.provided.has(k)) continue;
          const now_ = k === 'lease' ? db.value('SELECT ref FROM leases WHERE id = ?', row.lease) : k === 'brand' ? db.value('SELECT name FROM brands WHERE id = ?', row.brand) : row[k];
          if (!same(now_, cur[k])) ctx.error(k, 'imp1|The amounts and the tenant of an imported opening balance cannot change. Undo that import, or void the invoice and import it again.');
        }
        if (row.period_start && row.period_end && row.period_end < row.period_start) ctx.error('period_end', 'imp1|The end is before the start.');
        return;
      }
      if (systemRef('IN').test(row.ref)) ctx.error('ref', 'imp1|{ref} looks like a number the office gives; use the number from your old system.', { ref: row.ref });
      const lease = row.lease ? db.get('SELECT id, brand_id, status FROM leases WHERE id = ?', row.lease) : null;
      if (lease) {
        if (row.brand && row.brand !== lease.brand_id) ctx.error('brand', 'imp1|This is not the tenant of that lease.');
        row.brand = lease.brand_id;
      } else if (!row.brand) ctx.error('brand', 'imp1|Give the lease or the tenant.');
      if (!(row.amount > 0)) ctx.error('amount', 'imp1|The amount must be more than zero.');
      if (r2(row.paid) >= r2(row.amount) && row.amount > 0) ctx.error('paid', 'imp1|Nothing is left to pay on this invoice, so it is not an opening balance.');
      if (row.period_start && row.period_end && row.period_end < row.period_start) ctx.error('period_end', 'imp1|The end is before the start.');
      if (row.due_date > today()) ctx.warn('due_date', 'imp1|This invoice is not due yet; it is still an opening balance.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      if (ctx.id) {
        db.run('UPDATE invoices SET due_date = ?, period_start = ?, period_end = ?, note = ? WHERE id = ?', row.due_date, row.period_start || null, row.period_end || null, row.note || 'Opening balance', ctx.id);
        ctx.log('Updated an opening balance', 'invoice', ctx.id, row.ref);
        return ctx.id;
      }
      const lease = row.lease ? db.get('SELECT id, brand_id FROM leases WHERE id = ?', row.lease) : null;
      const kind = row.kind || (lease ? 'rent' : 'other');
      const amount = r2(row.amount);
      const part = kind === 'rent' ? { rent: amount } : kind === 'service' ? { service: amount } : { other: amount };
      const inv = h.billing.createInvoice({
        lease_id: lease ? lease.id : null, brand_id: lease ? lease.brand_id : row.brand, kind, period_start: row.period_start || null, period_end: row.period_end || null,
        due_date: row.due_date, ...part, vat_pct: 0, vat_included: false, note: row.note || 'Opening balance', source: 'opening',
      }, { user: ctx.user, emit: false });
      const paid = r2(row.paid);
      db.run('UPDATE invoices SET ref = ?, paid = ?, status = ? WHERE id = ?', row.ref, paid, paid > 0 ? 'partial' : 'open', inv.id);
      const owed = r2(amount - paid);
      if (h.ledger && owed > 0) {
        h.ledger.postOnce(`inv:${inv.id}`, () => ({
          date: today(), memo: `Opening balance · ${row.ref}`, kind: 'opening',
          lines: [{ account: 'ar', debit: owed, party_type: 'brand', party_id: inv.brand_id }, { account: 'opening_equity', credit: owed }],
        }));
      }
      ctx.log('Imported an opening balance', 'invoice', inv.id, `${row.ref} · ${owed}`);
      return inv.id;
    },
    export: (db) => db.all(`SELECT i.*, s.ref lease_ref, b.name brand_name FROM invoices i LEFT JOIN leases s ON s.id = i.lease_id LEFT JOIN brands b ON b.id = i.brand_id
      WHERE i.source = 'opening' ORDER BY i.due_date, i.id`).map((i) => ({
      $id: i.id, ref: i.ref, lease: i.lease_ref, brand: i.brand_name, kind: i.kind, period_start: i.period_start, period_end: i.period_end, due_date: i.due_date,
      amount: i.total, paid: i.paid, note: i.note === 'Opening balance' ? null : i.note,
    })),
    remove: (db, id) => { const inv = db.get('SELECT * FROM invoices WHERE id = ?', id); if (inv) dropInvoice(db, inv); },
    uses: (db, id, o) => imports.usesOf('invoices', id, { ...o, entity: 'invoice' }),
    link: (id) => `/admin/invoices/${id}`,
    label: (v, names) => `${v.ref || ''}${names.brand || names.lease ? ` · ${names.brand || names.lease}` : ''}`,
    examples: [
      { ref: 'INV-2026-0841', lease: 'C-2023-014', kind: 'rent', period_start: '2026-10-01', period_end: '2026-12-31', due_date: '2026-10-01', amount: 186000, paid: 60000 },
      { ref: 'INV-2026-0790', brand: 'Kahwa House', kind: 'utility', due_date: '2026-09-15', amount: 12450, note: 'Electricity August' },
    ],
  });

  // ======================================================================== cheques
  const CHQ = { held: 'chq|In the portfolio', deposited: 'chq|At the bank', collected: 'chq|Collected', bounced: 'chq|Bounced', returned: 'chq|Returned' };
  const OPEN_CHQ = ['held', 'deposited'];
  const event = (db, chequeId, status, note, user) => db.run('INSERT INTO cheque_events (cheque_id, status, note, user_id, at) VALUES (?, ?, ?, ?, ?)', chequeId, status, note || null, user ? user.id : null, new Date().toISOString());
  imports.register({
    key: 'cheques',
    module: '/admin/cheques',
    pages: ['/admin/cheques'],
    area: 'revenue',
    order: 20,
    depends: ['leases', 'opening-balances'],
    icon: 'coins',
    table: 'cheques',
    title: L('Cheques (portfolio)', 'الشيكات (الحافظة)'),
    summary: L('Post-dated cheques you hold from tenants, or that are at the bank for collection.', 'الشيكات الآجلة التي لديك من المستأجرين، أو المودعة في البنك للتحصيل.'),
    notes: L('Bring the cheques still in the portfolio or at the bank; collected cheques are history and stay in your old system. A cheque is found by its number and bank (or its CQ number). Tie it to the invoice it pays when you know it; when it is collected the money goes on that invoice first, then the oldest open ones.', 'استورد الشيكات التي ما زالت في الحافظة أو في البنك؛ الشيكات المحصلة تاريخ يبقى في نظامك القديم. يُعرف الشيك برقمه وبنكه (أو رقم سجله في النظام). اربطه بالفاتورة التي يسددها إن عرفتها؛ وعند تحصيله يُخصم المبلغ منها أولًا ثم من أقدم الفواتير المفتوحة.'),
    allowed: (req) => h.can(req, 'manager') || h.canFinance(req),
    keys: ['ref', ['number', 'bank']],
    columns: [
      { key: 'ref', label: L('Cheque record (CQ)', 'رقم سجل الشيك'), type: 'code', max: 30, width: 15, keepOnUpdate: true, help: L('Empty for new cheques; the office numbers them.', 'اتركه فارغًا للشيكات الجديدة؛ يرقّمها النظام.') },
      { key: 'number', label: L('Cheque number', 'رقم الشيك'), type: 'text', required: true, max: 40, width: 16, example: '10004521', aliases: ['cheque no', 'check number', 'cheque', 'رقم الشيك'] },
      { key: 'bank', label: L('Bank', 'البنك'), type: 'text', max: 80, width: 18, example: 'CIB', aliases: ['drawee bank', 'البنك المسحوب عليه'] },
      { key: 'drawer', label: L('Drawn by', 'الساحب'), type: 'text', max: 120, width: 22, help: L('Empty: the tenant’s name.', 'الفارغ: اسم المستأجر.') },
      { key: 'amount', label: L('Amount', 'المبلغ'), type: 'money', required: true, width: 14, example: 62000 },
      { key: 'due_date', label: L('Due date', 'تاريخ الاستحقاق'), type: 'date', required: true, width: 14, example: '2027-01-01', aliases: ['cheque date', 'date', 'تاريخ الشيك'] },
      { key: 'brand', label: L('Tenant (brand)', 'المستأجر (العلامة)'), type: 'ref', width: 22, ref: brandRef, help: L('Needed when there is no lease.', 'مطلوب إن لم يوجد عقد.') },
      { key: 'lease', label: L('Lease', 'العقد'), type: 'ref', width: 16, ref: leaseRef },
      { key: 'invoice', label: L('For invoice', 'للفاتورة'), type: 'ref', width: 18, ref: { list: (db) => db.all("SELECT id, ref FROM invoices ORDER BY status IN ('open','partial') DESC, status = 'void', due_date").map((i) => ({ id: i.id, name: i.ref })), dataset: 'opening-balances', what: L('Invoices', 'الفواتير') } },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: () => Object.entries(CHQ).map(([k, key]) => [k, lab(key)]), width: 16, example: 'held', help: L('In the portfolio or At the bank. Empty: in the portfolio.', 'في الحافظة أو في البنك. الفارغ: في الحافظة.') },
      { key: 'received_on', label: L('Received on', 'تاريخ الاستلام'), type: 'date', width: 14, help: L('Empty: today.', 'الفارغ: اليوم.') },
      { key: 'deposited_on', label: L('Deposited on', 'تاريخ الإيداع'), type: 'date', width: 14, help: L('For cheques at the bank.', 'للشيكات المودعة في البنك.') },
      { key: 'deposit_bank', label: L('Deposited into', 'أودع في حساب'), type: 'text', max: 80, width: 18 },
      { key: 'deposit_ref', label: L('Deposit slip', 'إيصال الإيداع'), type: 'text', max: 60, width: 14 },
      { key: 'note', label: L('Note', 'ملاحظة'), type: 'text', max: 300, width: 26 },
    ],
    find(db, v, key) {
      if (!Array.isArray(key)) { const hit = db.get('SELECT id FROM cheques WHERE ref = ? COLLATE NOCASE', v.ref); return hit ? hit.id : null; }
      const hits = db.all('SELECT id, brand_id FROM cheques WHERE number = ? AND lower(COALESCE(bank, \'\')) = lower(?)', String(v.number).trim(), String(v.bank || '').trim());
      const mine = v.brand ? hits.filter((x) => x.brand_id === v.brand) : hits;
      if (mine.length > 1) return { error: 'imp1|More than one cheque has this number and bank; use its CQ number.' };
      return mine.length ? mine[0].id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      const cur = ctx.current;
      const status = row.status || 'held';
      if (cur) {
        const locked = !OPEN_CHQ.includes(cur.status);
        for (const k of ['number', 'amount', 'brand', 'lease', ...(locked ? ['bank', 'drawer', 'due_date', 'invoice', 'deposited_on', 'deposit_bank', 'deposit_ref'] : [])]) {
          if (!ctx.provided.has(k)) continue;
          const now_ = k === 'brand' ? db.value('SELECT name FROM brands WHERE id = ?', row.brand) : k === 'lease' ? db.value('SELECT ref FROM leases WHERE id = ?', row.lease) : k === 'invoice' ? db.value('SELECT ref FROM invoices WHERE id = ?', row.invoice) : row[k];
          if (!same(now_, cur[k])) ctx.error(k, locked ? 'imp1|This cheque is already settled; it cannot change by an import.' : 'imp1|The number, amount and tenant of a cheque cannot change by an import.');
        }
        if (status !== cur.status && !(cur.status === 'held' && status === 'deposited')) ctx.error('status', 'imp1|An import can only send a cheque from the portfolio to the bank; other steps are on the cheque’s page.');
        if (status === 'deposited' && cur.status === 'held' && !row.deposited_on) ctx.error('deposited_on', 'imp1|Give the date it was deposited.');
        return;
      }
      if (row.ref) ctx.error('ref', 'imp1|{ref} is not a cheque in the system. Leave it empty for a new cheque.', { ref: row.ref });
      if (!OPEN_CHQ.includes(status)) ctx.error('status', 'imp1|Only cheques in the portfolio or at the bank are imported; collected ones stay in your old records.');
      const lease = row.lease ? db.get('SELECT id, brand_id FROM leases WHERE id = ?', row.lease) : null;
      if (lease) {
        if (row.brand && row.brand !== lease.brand_id) ctx.error('brand', 'imp1|This is not the tenant of that lease.');
        row.brand = lease.brand_id;
      } else if (!row.brand) ctx.error('brand', 'imp1|Give the lease or the tenant.');
      if (row.invoice) {
        const inv = db.get('SELECT * FROM invoices WHERE id = ?', row.invoice);
        if (!inv || (row.brand && inv.brand_id !== row.brand) || (lease && inv.lease_id && inv.lease_id !== lease.id)) ctx.error('invoice', 'imp1|That invoice is not this tenant’s.');
        else if (!['open', 'partial'].includes(inv.status)) ctx.error('invoice', 'imp1|That invoice is no longer open.');
        else if (r2(row.amount) > r2(inv.total - inv.paid) + 0.5) ctx.warn('amount', 'imp1|The cheque is more than what is left on that invoice; the rest goes on the tenant’s other open invoices when collected.');
      }
      if (status === 'deposited' && !row.deposited_on) ctx.error('deposited_on', 'imp1|Give the date it was deposited.');
      if (row.number && db.get('SELECT id FROM cheques WHERE number = ? AND lower(COALESCE(bank, \'\')) = lower(?) AND brand_id IS ?', row.number, row.bank || '', row.brand || null)) ctx.error('number', 'imp1|This cheque is already in the portfolio.');
      if (status === 'held' && row.due_date < M.addDays(today(), -180)) ctx.warn('due_date', 'imp1|This cheque is more than six months past its date; a bank may refuse it.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const t = new Date().toISOString();
      const status = row.status || 'held';
      if (ctx.id) {
        const old = db.get('SELECT * FROM cheques WHERE id = ?', ctx.id);
        if (OPEN_CHQ.includes(old.status)) {
          db.run('UPDATE cheques SET bank = ?, drawer = ?, due_date = ?, invoice_id = ?, note = ?, updated_at = ? WHERE id = ?', row.bank || null, row.drawer || old.drawer, row.due_date, row.invoice || null, row.note || null, t, old.id);
          if (status === 'deposited' && old.status === 'held') {
            db.run("UPDATE cheques SET status = 'deposited', deposited_on = ?, deposit_bank = ?, deposit_ref = ?, updated_at = ? WHERE id = ?", row.deposited_on, row.deposit_bank || null, row.deposit_ref || null, t, old.id);
            event(db, old.id, 'deposited', [row.deposit_bank, row.deposit_ref].filter(Boolean).join(' · ') || null, ctx.user);
          } else if (old.status === 'deposited') db.run('UPDATE cheques SET deposited_on = ?, deposit_bank = ?, deposit_ref = ? WHERE id = ?', row.deposited_on || old.deposited_on, row.deposit_bank || null, row.deposit_ref || null, old.id);
        }
        ctx.log('Updated a cheque', 'cheque', old.id, `${old.number} · ${old.ref}`);
        return old.id;
      }
      const brand = db.get('SELECT * FROM brands WHERE id = ?', row.brand);
      if (db.get('SELECT id FROM cheques WHERE number = ? AND lower(COALESCE(bank, \'\')) = lower(?) AND brand_id IS ?', row.number, row.bank || '', brand.id)) {
        throw new Error(i18n.run(ctx.lang, () => i18n.t('imp1|This cheque is already in the portfolio.')));
      }
      const id = Number(db.run(`INSERT INTO cheques (ref, number, bank, drawer, amount, due_date, brand_id, lease_id, invoice_id, status, received_on, received_by, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?)`, db.nextRef('cheques', 'CQ', 5, true), row.number, row.bank || null, row.drawer || brand.name, r2(row.amount), row.due_date,
      brand.id, row.lease || null, row.invoice || null, row.received_on || today(), ctx.user ? ctx.user.id : null, row.note || null, t, t).lastInsertRowid);
      event(db, id, 'held', null, ctx.user);
      if (status === 'deposited') {
        db.run("UPDATE cheques SET status = 'deposited', deposited_on = ?, deposit_bank = ?, deposit_ref = ?, updated_at = ? WHERE id = ?", row.deposited_on, row.deposit_bank || null, row.deposit_ref || null, t, id);
        event(db, id, 'deposited', [row.deposit_bank, row.deposit_ref].filter(Boolean).join(' · ') || null, ctx.user);
      }
      ctx.log('Received cheques', 'brand', brand.id, `${brand.name} · 1 · ${r2(row.amount)}`);
      return id;
    },
    export: (db) => db.all(`SELECT c.*, b.name brand_name, s.ref lease_ref, i.ref invoice_ref FROM cheques c LEFT JOIN brands b ON b.id = c.brand_id LEFT JOIN leases s ON s.id = c.lease_id
      LEFT JOIN invoices i ON i.id = c.invoice_id ORDER BY c.due_date, c.id`).map((c) => ({
      $id: c.id, ref: c.ref, number: c.number, bank: c.bank, drawer: c.drawer, amount: c.amount, due_date: c.due_date, brand: c.brand_name, lease: c.lease_ref, invoice: c.invoice_ref,
      status: c.status, received_on: c.received_on, deposited_on: c.deposited_on, deposit_bank: c.deposit_bank, deposit_ref: c.deposit_ref, note: c.note,
    })),
    snapshot: (db, id) => {
      const c = db.get('SELECT * FROM cheques WHERE id = ?', id);
      return c ? { cheque: c, events: db.all('SELECT id FROM cheque_events WHERE cheque_id = ?', id).map((e) => e.id) } : null;
    },
    restore: (db, snap) => {
      const cols = Object.keys(snap.cheque).filter((k) => k !== 'id');
      db.run(`UPDATE cheques SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => snap.cheque[k]), snap.cheque.id);
      const keep = new Set(snap.events);
      for (const e of db.all('SELECT id FROM cheque_events WHERE cheque_id = ?', snap.cheque.id)) if (!keep.has(e.id)) db.run('DELETE FROM cheque_events WHERE id = ?', e.id);
    },
    remove: (db, id) => {
      db.run('DELETE FROM cheque_events WHERE cheque_id = ?', id);
      db.run('DELETE FROM cheques WHERE id = ?', id);
    },
    uses: (db, id, o) => imports.usesOf('cheques', id, { ...o, ignore: ['cheque_events'], entity: 'cheque' }),
    link: (id) => `/admin/cheques/${id}`,
    label: (v, names) => `${v.number || ''}${v.bank ? ` · ${v.bank}` : ''}${names.brand ? ` · ${names.brand}` : ''}`,
    examples: [
      { number: '10004521', bank: 'CIB', amount: 62000, due_date: '2027-01-01', lease: 'C-2023-014', status: 'held', received_on: '2026-10-20' },
      { number: '10004522', bank: 'CIB', amount: 62000, due_date: '2027-04-01', lease: 'C-2023-014', status: 'held', received_on: '2026-10-20' },
      { number: '558120', bank: 'National Bank of Egypt', drawer: 'Kahwa House LLC', amount: 31500, due_date: '2026-11-01', brand: 'Kahwa House', status: 'deposited', deposited_on: '2026-11-02', deposit_bank: 'CIB current account' },
    ],
  });

  // ======================================================================== tenants' monthly sales
  const salesStatus = () => Object.entries({ submitted: 'trn|Submitted', verified: 'trn|Verified', draft: 'trn|Draft', disputed: 'trn|Disputed' }).map(([k, key]) => [k, lab(key)]);
  imports.register({
    key: 'tenant-sales',
    module: '/admin/turnover',
    pages: ['/admin/turnover/sales'],
    area: 'revenue',
    order: 30,
    depends: ['leases'],
    icon: 'percent',
    table: 'tenant_sales',
    title: L('Tenant sales (turnover)', 'مبيعات المستأجرين'),
    summary: L('Each tenant’s monthly sales: the history for reports, and what revenue-share rent is billed from.', 'المبيعات الشهرية لكل مستأجر: السجل للتقارير، وأساس فوترة الإيجار بنسبة من المبيعات.'),
    notes: L('One row per lease and month. A month already billed is locked. Verified needs a manager.', 'صف لكل عقد وشهر. الشهر الذي فوتر مغلق. «تم التحقق» يحتاج صلاحية مدير.'),
    allowed: (req) => h.can(req, 'agent'),
    keys: [['lease', 'period']],
    columns: [
      { key: 'lease', label: L('Lease', 'العقد'), type: 'ref', required: true, width: 18, ref: leaseRef, example: 'C-2023-014', aliases: ['contract', 'tenant', 'رقم العقد'] },
      { key: 'period', label: L('Month', 'الشهر'), type: 'month', required: true, width: 12, example: '2026-10', aliases: ['period', 'الفترة'] },
      { key: 'gross', label: L('Gross sales', 'إجمالي المبيعات'), type: 'money', required: true, width: 16, example: 1250000 },
      { key: 'returns', label: L('Returns', 'المرتجعات'), type: 'money', width: 13, example: 12000 },
      { key: 'transactions', label: L('Receipts', 'عدد الإيصالات'), type: 'int', min: 0, width: 12, example: 3150 },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: salesStatus, width: 14, example: 'submitted', help: L('Submitted or Verified. Empty: submitted.', 'مُرسلة أو تم التحقق. الفارغ: مُرسلة.') },
      { key: 'note', label: L('Note', 'ملاحظة'), type: 'text', max: 300, width: 26 },
    ],
    find: (db, v) => { const hit = db.get('SELECT id FROM tenant_sales WHERE lease_id = ? AND period = ?', v.lease, v.period); return hit ? hit.id : null; },
    rowCheck(row, ctx) {
      const { db } = ctx;
      const T = h.turnover;
      const lease = db.get('SELECT * FROM leases WHERE id = ?', row.lease);
      const status = row.status || 'submitted';
      const changing = !ctx.current || ['gross', 'returns', 'transactions', 'status'].some((k) => ctx.provided.has(k) && !same(row[k], ctx.current[k]));
      if (!lease || !changing) return;
      if (row.returns > row.gross) ctx.error('returns', 'imp1|Returns cannot be more than the gross sales.');
      if (row.period > today().slice(0, 7)) ctx.error('period', 'imp1|Sales cannot be reported for a future month.');
      else if (T && T.C.monthCover(lease, row.period) <= 0) ctx.error('period', 'imp1|The lease does not cover this month.');
      else if (T && T.isLocked(lease.id, row.period)) ctx.error('period', 'imp1|This month is already billed, so its sales are locked.');
      if (!ctx.current && !['submitted', 'verified'].includes(status)) ctx.error('status', 'imp1|New sales are Submitted or Verified.');
      if (status === 'verified' && (!ctx.current || ctx.current.status !== 'verified') && !ctx.can('manager')) ctx.error('status', 'imp1|Only a manager can mark sales as verified.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const lease = db.get('SELECT * FROM leases WHERE id = ?', row.lease);
      const status = row.status || 'submitted';
      const keep = ['draft', 'disputed'].includes(status) ? status : 'submitted';
      const sale = h.turnover.saveSales(lease, row.period, { gross: row.gross, returns: row.returns || 0, transactions: row.transactions ?? null, note: row.note || null }, { user: ctx.user, via: 'staff', by: ctx.user ? ctx.user.name : null, status: keep });
      if (status === 'verified') db.run("UPDATE tenant_sales SET status = 'verified', verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?", ctx.user ? ctx.user.id : null, now(), now(), sale.id);
      ctx.log('Recorded sales', 'turnover', null, `${row.period} · 1`);
      return sale.id;
    },
    export: (db) => db.all('SELECT t.*, s.ref lease_ref FROM tenant_sales t JOIN leases s ON s.id = t.lease_id ORDER BY t.period, s.ref').map((t) => ({
      $id: t.id, lease: t.lease_ref, period: t.period, gross: t.gross, returns: t.returns, transactions: t.transactions, status: t.status, note: t.note,
    })),
    uses: (db, id, o) => {
      const out = imports.usesOf('tenant_sales', id, o);
      const t = db.get('SELECT lease_id, period FROM tenant_sales WHERE id = ?', id);
      if (t && h.turnover && h.turnover.isLocked(t.lease_id, t.period)) out.push({ n: 1, what: L('turnover bill', 'فاتورة نسبة مبيعات') });
      return out;
    },
    link: (id) => { const t = h.db.get('SELECT lease_id FROM tenant_sales WHERE id = ?', id); return t ? `/admin/turnover/leases/${t.lease_id}` : '/admin/turnover/sales'; },
    label: (v, names) => `${names.lease || ''}${v.period ? ` · ${v.period}` : ''}`,
    examples: [
      { lease: 'C-2023-014', period: '2026-09', gross: 1250000, returns: 12000, transactions: 3150, status: 'submitted' },
      { lease: 'C-2023-014', period: '2026-10', gross: 1310000, returns: 9000, transactions: 3290, status: 'verified' },
    ],
  });
};
