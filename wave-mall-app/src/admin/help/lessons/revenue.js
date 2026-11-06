'use strict';

// Revenue: leases, billing, cheques, collections, advertising, turnover rent, service charge and utilities.

// Each lesson plays in English and then in Arabic on the same copy of the office, so a lesson that changes
// the sample data puts it back first (prepare runs before each language).
const clear = (db, ...sql) => sql.forEach((q) => db.run(q));
// Rows a lesson adds: the first call notes the highest id of each table, later calls delete anything newer.
const baselines = new WeakMap();
function undo(db, ...tables) {
  if (!baselines.has(db)) baselines.set(db, {});
  const b = baselines.get(db);
  for (const t of tables) {
    if (!(t in b)) b[t] = db.value(`SELECT COALESCE(MAX(id), 0) FROM ${t}`);
    else db.run(`DELETE FROM ${t} WHERE id > ?`, b[t]);
  }
}

// Maison Lune's lease (LS-2026-001) has 13 open invoices without a cheque. For the "receiving cheques" video,
// mark all but the first three as already covered, so the form shows three rows to fill in.
function threeChequesToReceive({ db }) {
  clear(db, "DELETE FROM cheque_events WHERE cheque_id IN (SELECT id FROM cheques WHERE lease_id = 1 AND demo = 0)", 'DELETE FROM cheques WHERE lease_id = 1 AND demo = 0');
  const open = db.all("SELECT id, total, paid, due_date FROM invoices WHERE lease_id = 1 AND status IN ('open','partial') AND id NOT IN (SELECT invoice_id FROM cheques WHERE invoice_id IS NOT NULL AND status IN ('held','deposited','collected')) ORDER BY due_date");
  const t = new Date().toISOString();
  open.slice(3).forEach((inv, i) => {
    db.run(`INSERT INTO cheques (ref, number, bank, drawer, amount, due_date, brand_id, lease_id, invoice_id, status, received_on, received_by, created_at, updated_at)
      VALUES (?, ?, 'CIB', 'Maison Lune', ?, ?, 1, 1, ?, 'held', ?, NULL, ?, ?)`, db.nextRef('cheques', 'CQ', 5, true), String(40221 + i), Math.round((inv.total - inv.paid) * 100) / 100, inv.due_date, inv.id, t.slice(0, 10), t, t);
  });
}

// Two held cheques due today, so the portfolio has something ticked to deposit.
function chequesDueToday({ db }) {
  const today = new Date().toISOString().slice(0, 10);
  db.run("UPDATE cheques SET status = 'held', deposited_on = NULL, deposit_bank = NULL, deposit_ref = NULL WHERE status = 'deposited'");
  const ids = db.all("SELECT id FROM cheques WHERE status = 'held' ORDER BY due_date, id LIMIT 2").map((c) => c.id);
  for (const id of ids) db.run('UPDATE cheques SET due_date = ? WHERE id = ? AND due_date > ?', today, id, today);
}

module.exports = [
  // ------------------------------------------------------------------ leases
  {
    id: 'revenue-lease-create',
    area: 'revenue',
    module: '/admin/leases',
    also: ['/admin/offers'],
    order: 10,
    roles: ['leasing', 'management'],
    title: { en: 'Turning an accepted offer into a lease', ar: 'تحويل العرض المقبول إلى عقد' },
    summary: {
      en: 'Mark the offer accepted, draft the lease from it in one click, check the terms and activate it.',
      ar: 'سجّل قبول العرض، وأنشئ مسودة العقد منه بضغطة واحدة، ثم راجع الشروط وفعّل العقد.',
    },
    steps: [
      { go: '/admin/offers?status=sent', say: { en: 'A lease starts from the offer the brand agreed to. These are the offers you have sent.', ar: 'يبدأ العقد من العرض الذي وافقت عليه العلامة التجارية. هذه هي العروض التي أرسلتها.' } },
      { click: 'tr[data-href^="/admin/offers/"]', nav: true, say: { en: 'Open the offer the brand has said yes to.', ar: 'افتح العرض الذي وافقت عليه العلامة.' } },
      { click: 'form[action$="/accepted"] button', say: { en: 'Choose Accepted. The units are now reserved for this brand.', ar: 'اختر «قُبِل العرض». أصبحت الوحدات الآن محجوزة لهذه العلامة.' } },
      { click: '.bar__actions a[href^="/admin/leases/new?offer="]', nav: true, say: { en: 'A new button appears: Create lease.', ar: 'يظهر زر جديد: «إنشاء العقد».' } },
      { point: 'form[action="/admin/leases"] fieldset', say: { en: 'Everything comes from the offer: the brand, the units, the rent, the yearly increase and the deposit.', ar: 'كل شيء يأتي من العرض: العلامة والوحدات والإيجار والزيادة السنوية والتأمين.' } },
      { scroll: 'form[action="/admin/leases"] button.btn--primary', say: { en: 'Check the start date and the terms, and change anything agreed at signing.', ar: 'راجع تاريخ البداية والشروط، وعدّل أي شيء اتُّفق عليه عند التوقيع.' } },
      { click: 'form[action="/admin/leases"] button.btn--primary', nav: true, say: { en: 'Choose Create lease. It starts as a draft, so nothing is billed yet.', ar: 'اختر «إنشاء العقد». يبدأ العقد مسودة، فلا تصدر أي فواتير بعد.' } },
      { point: '.kpis', say: { en: 'The draft already shows the area, the rent and the value of the whole contract.', ar: 'تعرض المسودة المساحة والإيجار وقيمة العقد كاملة.' } },
      { point: 'section.card.docs', say: { en: 'Upload the signed copy here, so the lease is complete on file.', ar: 'ارفع النسخة الموقّعة هنا ليكتمل ملف العقد.' } },
      { click: 'form[action$="/activate"] button', say: { en: 'Then choose Activate lease. The units become leased and every invoice of the term is created.', ar: 'ثم اختر «تفعيل العقد». تصبح الوحدات مؤجرة وتُنشأ كل فواتير مدة العقد.' } },
      { wait: 'tr[data-href^="/admin/invoices/"]' },
      { point: '.kpis', say: { en: 'The lease is active, and its invoices follow the rent schedule automatically.', ar: 'أصبح العقد ساريًا، وتتبع فواتيره جدول الإيجار تلقائيًا.' } },
    ],
  },
  {
    id: 'revenue-lease-page',
    area: 'revenue',
    module: '/admin/leases',
    order: 20,
    roles: ['leasing', 'finance', 'management'],
    title: { en: 'Reading a lease page', ar: 'قراءة صفحة العقد' },
    summary: {
      en: 'Find a lease, then read its rent, invoices, documents, cheques, options and renewal in one place.',
      ar: 'ابحث عن عقد، ثم اقرأ إيجاره وفواتيره ومستنداته وشيكاته وخياراته وتجديده في مكان واحد.',
    },
    steps: [
      { go: '/admin/leases', say: { en: 'Leases lists every contract, with tabs for drafts, active, ended and terminated leases.', ar: 'تعرض صفحة العقود كل العقود، مع تبويبات للمسودات والسارية والمنتهية والمفسوخة.' } },
      { point: 'form.filters', say: { en: 'Filter by start date, tenant or contract.', ar: 'صفِّ القائمة حسب تاريخ البداية أو المستأجر أو العقد.' } },
      { point: 'tr[data-href^="/admin/leases/"]', say: { en: 'Each row shows the units, the term, the rent today, the next invoice and whether the signed copy is on file.', ar: 'يعرض كل صف الوحدات والمدة والإيجار الحالي والفاتورة التالية، وهل النسخة الموقّعة محفوظة.' } },
      { click: 'tr[data-href^="/admin/leases/"]', nav: true, say: { en: 'Open a lease.', ar: 'افتح عقدًا.' } },
      { point: '.kpis', say: { en: 'At the top: the area, the annual rent now, the contract value, what was collected and what is overdue.', ar: 'في الأعلى: المساحة والإيجار السنوي الحالي وقيمة العقد وما حُصّل وما تأخر.' } },
      { scroll: 'section.card:has(h2):has(table)', say: { en: 'Below are its invoices and the rent schedule year by year.', ar: 'وفي الأسفل فواتيره وجدول الإيجار سنة بسنة.' } },
      { point: 'section.card.docs', say: { en: 'The documents card keeps the signed lease, the guarantees and every attachment.', ar: 'تحفظ بطاقة المستندات العقد الموقّع والضمانات وكل المرفقات.' } },
      { scroll: '#options', say: { en: 'Further down are the addenda, the options with their notice dates, and the renewal.', ar: 'وفي الأسفل أيضًا الملاحق والخيارات بمواعيد الإخطار، ثم التجديد.' } },
      { point: '.bar__actions', say: { en: 'From the top bar you can add a one-off charge, or end the lease.', ar: 'ومن الشريط العلوي يمكنك إضافة رسوم لمرة واحدة أو إنهاء العقد.' } },
    ],
  },
  {
    id: 'revenue-lease-amend',
    area: 'revenue',
    module: '/admin/leases',
    order: 30,
    level: 'advanced',
    roles: ['leasing', 'management'],
    title: { en: 'Changing a lease with an addendum', ar: 'تعديل العقد بملحق' },
    summary: {
      en: 'Change the rent, add a unit or extend the term with an addendum, preview it, then apply it.',
      ar: 'غيّر الإيجار أو أضف وحدة أو مدّد المدة بملحق، ثم عاينه وطبّقه.',
    },
    steps: [
      { go: '/admin/leases?status=active', say: { en: 'A lease is never edited directly once it is active. Changes are made with an addendum.', ar: 'لا يُعدَّل العقد مباشرة بعد تفعيله، بل تتم التعديلات بملحق.' } },
      { click: 'tr[data-href^="/admin/leases/"]', nav: true },
      { click: 'a[href$="/amend"]', nav: true, say: { en: 'On the lease, find Addenda and choose New addendum.', ar: 'في صفحة العقد، ابحث عن «الملاحق» واختر «ملحق جديد».' } },
      { point: 'input[name=effective_date]', say: { en: 'The addendum takes effect from this date; earlier invoices stay as they are.', ar: 'يسري الملحق من هذا التاريخ، وتبقى الفواتير السابقة كما هي.' } },
      { type: ['input[name=reason]', { en: 'Expansion into the next unit', ar: 'التوسع في الوحدة المجاورة' }], say: { en: 'Write why the lease is changing.', ar: 'اكتب سبب تعديل العقد.' } },
      { type: ['input[name=rate]', '1650'], say: { en: 'Enter the new rent per square metre.', ar: 'أدخل الإيجار الجديد للمتر المربع.' } },
      { select: ['select[name=add_units]', '3'], say: { en: 'Add a unit, or tick a unit to give back.', ar: 'أضف وحدة، أو حدد وحدة لإعادتها.' } },
      { type: ['input[name=extend_months]', '12'], say: { en: 'You can also extend the term in the same addendum.', ar: 'ويمكنك أيضًا تمديد المدة في الملحق نفسه.' } },
      { click: 'form[action$="/amendments"] button.btn--primary', nav: true, say: { en: 'Choose Preview the addendum.', ar: 'اختر «معاينة الملحق».' } },
      { point: 'section.card:has(.amd-chg)', say: { en: 'The draft lists every change: the new rent, the unit added and the longer term.', ar: 'تعرض المسودة كل تغيير: الإيجار الجديد والوحدة المضافة والمدة الأطول.' } },
      { point: '.grid--side > .stack > section.card', say: { en: 'It also shows the invoices that will be voided, and the new ones issued in their place.', ar: 'وتعرض أيضًا الفواتير التي ستُلغى، والفواتير الجديدة التي تصدر بدلًا منها.' } },
      { point: 'section.card:has(form[action$="/apply"])', say: { en: 'Upload the signed addendum, then choose Apply the addendum. The old invoices stay in the history.', ar: 'ارفع الملحق الموقّع، ثم اختر «تطبيق الملحق». وتبقى الفواتير القديمة في السجل.' } },
    ],
  },
  {
    id: 'revenue-lease-renew',
    area: 'revenue',
    module: '/admin/leases/renewals',
    also: ['/admin/leases'],
    order: 40,
    roles: ['leasing', 'management'],
    title: { en: 'Renewing a lease', ar: 'تجديد العقد' },
    prepare: ({ db }) => undo(db, 'lease_renewals'),
    summary: {
      en: 'See which leases end soon and their notice dates, then send the tenant a renewal offer.',
      ar: 'اعرف العقود التي تنتهي قريبًا ومواعيد الإخطار، ثم أرسل للمستأجر عرض تجديد.',
    },
    steps: [
      { go: '/admin/leases/renewals', say: { en: 'Renewals shows the leases ending soon, the notice deadlines and the offers waiting for an answer.', ar: 'تعرض صفحة التجديدات العقود القريبة من الانتهاء ومواعيد الإخطار والعروض التي تنتظر ردًا.' } },
      { point: '.tabs--sub', say: { en: 'Look three, six, twelve or twenty-four months ahead.', ar: 'انظر إلى ثلاثة أو ستة أو اثني عشر أو أربعة وعشرين شهرًا مقبلة.' } },
      { go: '/admin/leases?status=active', say: { en: 'To offer a renewal, open the lease.', ar: 'لتقديم عرض تجديد، افتح العقد.' } },
      { click: 'tr[data-href^="/admin/leases/"]', nav: true },
      { click: '#renewal summary', say: { en: 'In the Renewal card, choose Offer a renewal.', ar: 'في بطاقة «التجديد»، اختر «تقديم عرض تجديد».' } },
      { select: ['#renewal select[name=kind]', 'extension'], say: { en: 'Offer a new lease, or an extension of this one.', ar: 'اعرض عقدًا جديدًا أو تمديدًا لهذا العقد.' } },
      { type: ['#renewal input[name=months]', '36'], say: { en: 'Set how many months, the new rent and the yearly increase.', ar: 'حدد عدد الأشهر والإيجار الجديد والزيادة السنوية.' } },
      { type: ['#renewal input[name=rent_m2]', '1750'] },
      { type: ['#renewal input[name=escalation_pct]', '8'] },
      { select: ['#renewal select[name=send]', '1'], say: { en: 'Send it now through the tenant portal, where they can accept it.', ar: 'أرسله الآن عبر بوابة المستأجر، حيث يمكنه قبوله.' } },
      { click: '#renewal button.btn--primary', say: { en: 'Choose Make the offer.', ar: 'اختر «تقديم العرض».' } },
      { point: '#renewal', say: { en: 'The offer waits here with its status. When it is accepted, the lease is extended or a new one is drafted for you.', ar: 'ينتظر العرض هنا مع حالته. وعند قبوله يُمدَّد العقد أو تُنشأ لك مسودة عقد جديد.' } },
    ],
  },
  {
    id: 'revenue-lease-settle',
    area: 'revenue',
    module: '/admin/leases',
    order: 50,
    level: 'advanced',
    roles: ['leasing', 'finance', 'management'],
    title: { en: 'Ending a lease and settling the deposit', ar: 'إنهاء العقد وتسوية التأمين' },
    prepare: ({ db }) => undo(db, 'lease_settlements'),
    summary: {
      en: 'End a lease early or at term, deduct what is owed from the deposit and print the settlement statement.',
      ar: 'أنهِ العقد مبكرًا أو في موعده، واخصم المستحقات من التأمين، واطبع كشف التسوية.',
    },
    steps: [
      { go: '/admin/leases?status=active', say: { en: 'When a tenant leaves, settle the lease so everyone agrees on what is owed.', ar: 'عندما يغادر المستأجر، قم بتسوية العقد ليتفق الجميع على المستحقات.' } },
      { click: 'tr[data-href^="/admin/leases/"]', nav: true },
      { click: '.bar__actions summary', has: { en: 'End lease', ar: 'إنهاء العقد' }, say: { en: 'Choose End lease. You can end it quickly here, or settle it properly.', ar: 'اختر «إنهاء العقد». يمكنك إنهاؤه سريعًا من هنا، أو تسويته بالكامل.' } },
      { click: '.bar__actions a[href$="/settle"]', nav: true, say: { en: 'Choose End and settle.', ar: 'اختر «إنهاء وتسوية».' } },
      { select: ['select[name=how]', 'terminated'], say: { en: 'Say whether the term is complete or the lease ends early, and the last day.', ar: 'حدد هل انتهت المدة أم يُنهى العقد مبكرًا، وآخر يوم.' } },
      { select: ['select[name=charge_penalties]', '1'], say: { en: 'Decide whether to charge the early-exit penalty in the lease.', ar: 'قرر هل تُحتسب غرامة الخروج المبكر الواردة في العقد.' } },
      { type: ['input[name=ded_label_1]', { en: 'Repainting the shopfront', ar: 'إعادة طلاء واجهة المحل' }], say: { en: 'List what comes off the deposit, such as repairs.', ar: 'اذكر ما يُخصم من التأمين، مثل الإصلاحات.' } },
      { type: ['input[name=ded_amount_1]', '45000'] },
      { select: ['select[name=refund_method]', 'cheque'], say: { en: 'Choose how the rest is refunded.', ar: 'اختر طريقة رد المبلغ المتبقي.' } },
      { click: 'form[action$="/settlement"] button.btn--primary', nav: true, say: { en: 'Choose Work out the settlement.', ar: 'اختر «احتساب التسوية».' } },
      { point: '.grid--side > .stack > section.card', say: { en: 'The statement nets the unpaid invoices, the penalties and the deductions against the deposit.', ar: 'يخصم الكشف الفواتير غير المسددة والغرامات والخصومات من التأمين.' } },
      { point: '.bar__actions', say: { en: 'Print it for the tenant to sign, and keep the handover papers with it.', ar: 'اطبعه ليوقّعه المستأجر، واحفظ معه أوراق التسليم.' } },
      { point: 'section.card:has(form[action$="/confirm"])', say: { en: 'Then confirm. The lease ends, future invoices are voided, the refund is recorded and the units become available.', ar: 'ثم أكّد. ينتهي العقد وتُلغى الفواتير المستقبلية ويُسجَّل المبلغ المردود وتصبح الوحدات متاحة.' } },
    ],
  },

  // ------------------------------------------------------------------ billing
  {
    id: 'revenue-billing',
    area: 'revenue',
    module: '/admin/billing',
    also: ['/admin/invoices'],
    order: 60,
    roles: ['finance', 'management'],
    title: { en: 'Following invoices on the Billing page', ar: 'متابعة الفواتير من صفحة الفواتير' },
    summary: {
      en: 'See what is open, overdue and coming up, filter by tenant or lease, and open an invoice.',
      ar: 'اعرف المفتوح والمتأخر والقادم، وصفِّ حسب المستأجر أو العقد، وافتح أي فاتورة.',
    },
    steps: [
      { go: '/admin/billing', say: { en: 'Invoices are created from each lease\'s rent schedule. You never type them in by hand.', ar: 'تُنشأ الفواتير من جدول إيجار كل عقد، فلا تكتبها يدويًا أبدًا.' } },
      { point: '.kpis', say: { en: 'The totals show what is open, what is overdue and what was collected this month.', ar: 'تعرض الإجماليات المفتوح والمتأخر وما حُصّل هذا الشهر.' } },
      { click: '.tabs a[href="/admin/billing?status=overdue"]', nav: true, say: { en: 'The tabs split the invoices. Here are the overdue ones.', ar: 'تقسّم التبويبات الفواتير. هذه هي المتأخرة.' } },
      { point: 'form.filters', say: { en: 'Narrow the list by due date, tenant or lease.', ar: 'ضيّق القائمة حسب تاريخ الاستحقاق أو المستأجر أو العقد.' } },
      { scroll: '.grid--2', say: { en: 'Further down, the aging shows how long money has been owed, and who is behind.', ar: 'وفي الأسفل يوضح تحليل أعمار الديون مدة التأخير، ومن المتأخرون في السداد.' } },
      { scroll: 'tr[data-href^="/admin/invoices/"]' },
      { click: 'tr[data-href^="/admin/invoices/"]', nav: true, say: { en: 'Open an invoice.', ar: 'افتح فاتورة.' } },
      { point: 'main .card', say: { en: 'The invoice shows its lines, VAT, what has been paid and the balance.', ar: 'تعرض الفاتورة بنودها وضريبة القيمة المضافة وما سُدّد والرصيد المتبقي.' } },
      { point: '.bar__actions', say: { en: 'Print it with your branding, or download it to send.', ar: 'اطبعها بهوية المول، أو نزّلها لإرسالها.' } },
    ],
  },
  {
    id: 'revenue-payment',
    area: 'revenue',
    module: '/admin/billing',
    also: ['/admin/invoices'],
    order: 70,
    roles: ['finance'],
    title: { en: 'Recording a payment', ar: 'تسجيل دفعة' },
    summary: {
      en: 'Record a transfer or cash payment against an invoice, or send the tenant a link to pay online.',
      ar: 'سجّل تحويلًا أو دفعة نقدية على فاتورة، أو أرسل للمستأجر رابطًا للدفع الإلكتروني.',
    },
    steps: [
      { go: '/admin/billing?status=overdue', say: { en: 'A tenant has paid. Find their invoice.', ar: 'سدّد أحد المستأجرين. ابحث عن فاتورته.' } },
      { click: 'tr[data-href^="/admin/invoices/"]', nav: true },
      { point: 'form[action$="/pay"]', say: { en: 'Record a payment is on the right. The amount is the balance still due.', ar: 'تجد «تسجيل دفعة» على اليمين، والمبلغ هو الرصيد المستحق.' } },
      { select: ['form[action$="/pay"] select[name=method]', 'transfer'], say: { en: 'Choose how they paid: transfer, cheque, card, cash, InstaPay, Fawry or a wallet.', ar: 'اختر طريقة الدفع: تحويل أو شيك أو بطاقة أو نقدًا أو إنستاباي أو فوري أو محفظة.' } },
      { type: ['form[action$="/pay"] input[name=reference]', 'CIB-778120'], say: { en: 'Add the bank reference, so it can be matched later.', ar: 'أضف مرجع البنك لتسهيل المطابقة لاحقًا.' } },
      { click: 'form[action$="/pay"] button.btn--primary', say: { en: 'Choose Record payment.', ar: 'اختر «تسجيل الدفعة».' } },
      { point: 'main .card', say: { en: 'The invoice is paid, the receipt is ready to print, and the accounts are updated by themselves.', ar: 'سُدّدت الفاتورة، والإيصال جاهز للطباعة، وتُحدَّث الحسابات تلقائيًا.' } },
      { go: '/admin/billing?status=open', say: { en: 'Prefer the tenant pays online? Open an unpaid invoice.', ar: 'تفضّل أن يدفع المستأجر إلكترونيًا؟ افتح فاتورة غير مسددة.' } },
      { click: 'tr[data-href^="/admin/invoices/"]', nav: true },
      { point: 'section.card:has(form[action$="/payment-link"])', say: { en: 'Under Online payment, create a link. The tenant pays by card, and the invoice is marked paid on its own.', ar: 'من «الدفع الإلكتروني» أنشئ رابطًا. يدفع المستأجر بالبطاقة، وتُسجَّل الفاتورة مسددة تلقائيًا.' } },
    ],
  },

  // ------------------------------------------------------------------ cheques
  {
    id: 'revenue-cheques-receive',
    area: 'revenue',
    module: '/admin/cheques',
    order: 80,
    roles: ['finance'],
    title: { en: 'Receiving post-dated cheques', ar: 'استلام الشيكات الآجلة' },
    summary: {
      en: 'Put a tenant\'s cheques in the portfolio, each one matched to the invoice it pays.',
      ar: 'ضع شيكات المستأجر في الحافظة، وكل شيك مربوط بالفاتورة التي يسددها.',
    },
    prepare: threeChequesToReceive,
    steps: [
      { go: '/admin/cheques', say: { en: 'Cheques keeps every post-dated cheque you hold, until it is collected.', ar: 'تحفظ صفحة الشيكات كل شيك آجل لديك حتى يُحصَّل.' } },
      { point: '.kpis', say: { en: 'You see what is due to deposit this week, what is at the bank and what bounced.', ar: 'ترى ما يجب إيداعه هذا الأسبوع، وما في البنك، وما ارتد.' } },
      { click: '.bar__actions a[href="/admin/cheques/receive"]', nav: true, say: { en: 'A tenant brings their cheques. Choose Receive cheques.', ar: 'أحضر المستأجر شيكاته. اختر «استلام شيكات».' } },
      { select: ['select[name=brand]', '1'], say: { en: 'Choose the tenant.', ar: 'اختر المستأجر.' } },
      { click: 'form[action="/admin/cheques/receive"] button', nav: true },
      { select: ['select[name=lease]', '1'], say: { en: 'Then the lease, and choose Show.', ar: 'ثم العقد، واختر «عرض».' } },
      { click: 'form[action="/admin/cheques/receive"] button', nav: true },
      { point: '.chq-rows', say: { en: 'One row for each open invoice: the amounts and due dates are already filled in.', ar: 'صف لكل فاتورة مفتوحة، والمبالغ وتواريخ الاستحقاق معبأة مسبقًا.' } },
      { type: ['input[name=number_0]', '40218'], say: { en: 'Type each cheque number and its bank.', ar: 'اكتب رقم كل شيك والبنك المسحوب عليه.' } },
      { type: ['input[name=bank_0]', { en: 'CIB', ar: 'البنك التجاري الدولي' }] },
      { type: ['input[name=number_1]', '40219'] },
      { type: ['input[name=bank_1]', { en: 'CIB', ar: 'البنك التجاري الدولي' }] },
      { type: ['input[name=number_2]', '40220'] },
      { type: ['input[name=bank_2]', { en: 'CIB', ar: 'البنك التجاري الدولي' }] },
      { click: 'form[action="/admin/cheques"] button.btn--primary', nav: true, say: { en: 'Choose Put in the portfolio.', ar: 'اختر «وضع في الحافظة».' } },
      { point: 'main .card', say: { en: 'The cheques are held, each one linked to its invoice. You are reminded when each is due to deposit.', ar: 'أصبحت الشيكات في الحافظة، وكل منها مربوط بفاتورته، وستُذكَّر بموعد إيداع كل شيك.' } },
    ],
  },
  {
    id: 'revenue-cheques-deposit',
    area: 'revenue',
    module: '/admin/cheques',
    order: 90,
    roles: ['finance'],
    title: { en: 'Depositing and collecting cheques', ar: 'إيداع الشيكات وتحصيلها' },
    prepare: chequesDueToday,
    summary: {
      en: 'Deposit the cheques that are due in one go, then mark each one collected, or bounced if it comes back.',
      ar: 'أودِع الشيكات المستحقة دفعة واحدة، ثم سجّل كل شيك محصّلًا، أو مرتدًا إن عاد.',
    },
    steps: [
      { go: '/admin/cheques', say: { en: 'The portfolio lists the cheques you hold, the earliest due first.', ar: 'تعرض الحافظة الشيكات التي لديك، الأقرب استحقاقًا أولًا.' } },
      { point: 'input[name=ids]', say: { en: 'Cheques that are due are already ticked. Tick or untick any others.', ar: 'الشيكات المستحقة محددة مسبقًا. حدد غيرها أو ألغِ تحديده.' } },
      { scroll: '#bulk-deposit', say: { en: 'Under Deposit at the bank, choose the account and the deposit slip number.', ar: 'من «الإيداع في البنك» اختر الحساب ورقم قسيمة الإيداع.' } },
      { type: ['#bulk-deposit input[name=bank]', { en: 'CIB current account', ar: 'الحساب الجاري لدى البنك التجاري الدولي' }] },
      { type: ['#bulk-deposit input[name=ref]', 'DS-1102'] },
      { click: '#bulk-deposit button.btn--primary', say: { en: 'Choose Deposit the ticked cheques.', ar: 'اختر «إيداع الشيكات المحددة».' } },
      { point: 'tr[data-href^="/admin/cheques/"]', say: { en: 'They move to Deposited, waiting for the bank.', ar: 'تنتقل إلى «المودعة» في انتظار البنك.' } },
      { click: 'tr[data-href^="/admin/cheques/"]', nav: true, say: { en: 'When the bank clears one, open it.', ar: 'عندما يصرف البنك شيكًا، افتحه.' } },
      { point: 'form[action$="/move"]', say: { en: 'Next step: mark it collected, and its invoice is paid. If it bounced, record that and the tenant is told.', ar: 'الخطوة التالية: سجّله محصّلًا فتُسدَّد فاتورته. وإن ارتد سجّل ذلك ويُبلَّغ المستأجر.' } },
      { click: 'form[action$="/move"] button.btn--primary', say: { en: 'This one cleared.', ar: 'هذا الشيك صُرف.' } },
      { point: 'main .card', say: { en: 'The history keeps every step of the cheque, with who did it and when.', ar: 'يحتفظ السجل بكل خطوة مر بها الشيك، ومن قام بها ومتى.' } },
    ],
  },

  // ------------------------------------------------------------------ collections
  {
    id: 'revenue-collections-day',
    area: 'revenue',
    module: '/admin/collections',
    order: 100,
    roles: ['finance'],
    title: { en: 'A day in collections: who to call', ar: 'يوم في التحصيل: بمن تتصل' },
    prepare: ({ db }) => undo(db, 'col_promises', 'col_calls'),
    summary: {
      en: 'Start from the list of who to call today, log the call and record a promise to pay.',
      ar: 'ابدأ من قائمة من تتصل بهم اليوم، وسجّل المكالمة ووعد السداد.',
    },
    steps: [
      { go: '/admin/collections', say: { en: 'Collections shows everything owed, and what to do about it today.', ar: 'تعرض صفحة التحصيل كل المستحقات، وما يجب فعله بشأنها اليوم.' } },
      { point: '.kpis', say: { en: 'The totals: overdue, days to collect, promises due and broken promises.', ar: 'الإجماليات: المتأخر وأيام التحصيل والوعود المستحقة والوعود التي لم يُوفَ بها.' } },
      { point: 'section.card:has(tr[data-href^="/admin/collections/tenants/"])', say: { en: 'Who to call today ranks the tenants by how much and how long they owe.', ar: 'ترتب قائمة «من نتصل به اليوم» المستأجرين حسب قيمة المتأخرات ومدتها.' } },
      { click: 'tr[data-href^="/admin/collections/tenants/"]', nav: true, say: { en: 'Open a tenant.', ar: 'افتح مستأجرًا.' } },
      { point: '.kpis', say: { en: 'Their balance, the oldest unpaid invoice and the calls so far, on one page.', ar: 'رصيده وأقدم فاتورة غير مسددة والمكالمات السابقة، في صفحة واحدة.' } },
      { point: 'form[action$="/call"]', say: { en: 'Call the number shown, then log what happened.', ar: 'اتصل بالرقم الظاهر، ثم سجّل ما حدث.' } },
      { select: ['form[action$="/call"] select[name=outcome]', 'promised'], say: { en: 'They promised to pay.', ar: 'وعد بالسداد.' } },
      { type: ['form[action$="/call"] input[name=promise_amount]', '37800'], say: { en: 'Enter how much, and by when.', ar: 'أدخل المبلغ والموعد.' } },
      { type: ['form[action$="/call"] input[name=promise_on]', '11202026'] },
      { type: ['form[action$="/call"] textarea[name=note]', { en: 'Spoke to the finance manager, transfer next week', ar: 'تحدثت مع المدير المالي، التحويل الأسبوع القادم' }] },
      { click: 'form[action$="/call"] button.btn--primary', say: { en: 'Choose Log the call.', ar: 'اختر «سجّل المكالمة».' } },
      { point: 'main', say: { en: 'The promise is tracked. If the date passes without payment, it comes back to the top of your list.', ar: 'يُتابَع الوعد، وإن مر موعده دون سداد يعود المستأجر إلى رأس قائمتك.' } },
    ],
  },
  {
    id: 'revenue-collections-plans',
    area: 'revenue',
    module: '/admin/collections',
    order: 110,
    level: 'advanced',
    roles: ['finance'],
    title: { en: 'Reminders and payment plans', ar: 'التذكيرات وخطط السداد' },
    prepare: ({ db }) => {
      const b = baselines.get(db);
      if (b && 'col_plans' in b) clear(db, `DELETE FROM col_plan_items WHERE plan_id > ${b.col_plans}`, `DELETE FROM col_plan_invoices WHERE plan_id > ${b.col_plans}`);
      undo(db, 'col_plans');
    },
    summary: {
      en: 'Send the due reminders in one go, then agree a payment plan that splits old invoices into instalments.',
      ar: 'أرسل التذكيرات المستحقة دفعة واحدة، ثم اتفق على خطة سداد تقسّم الفواتير القديمة إلى أقساط.',
    },
    steps: [
      { go: '/admin/collections/reminders', say: { en: 'Reminders go out by themselves before and after each due date, by email and WhatsApp.', ar: 'تُرسَل التذكيرات تلقائيًا قبل كل موعد استحقاق وبعده، بالبريد وواتساب.' } },
      { point: 'main .card', say: { en: 'Here is every reminder sent, to whom and for which invoice.', ar: 'هنا كل تذكير أُرسل، ولمن، وعن أي فاتورة.' } },
      { click: 'form[action="/admin/collections/reminders/run"] button', say: { en: 'To send the ones due right now, choose Send due reminders now.', ar: 'لإرسال المستحق منها الآن، اختر «إرسال التذكيرات المستحقة الآن».' } },
      { go: '/admin/collections', say: { en: 'A tenant cannot pay everything at once? Agree a payment plan.', ar: 'لا يستطيع المستأجر سداد كل شيء دفعة واحدة؟ اتفق معه على خطة سداد.' } },
      { click: 'tr[data-href^="/admin/collections/tenants/"]', nav: true },
      { click: 'summary', has: { en: 'New payment plan', ar: 'خطة سداد جديدة' }, say: { en: 'Choose New payment plan.', ar: 'اختر «خطة سداد جديدة».' } },
      { check: 'form[action$="/plans"] input[name=inv]', say: { en: 'Tick the invoices it covers.', ar: 'حدد الفواتير التي تشملها.' } },
      { check: 'form[action$="/plans"] input[name=inv]', nth: 1 },
      { type: ['form[action$="/plans"] input[name=installments]', '3'], say: { en: 'Split them into instalments, every month or quarter.', ar: 'قسّمها إلى أقساط، كل شهر أو كل ربع سنة.' } },
      { type: ['form[action$="/plans"] input[name=first_due]', '12012026'] },
      { click: 'form[action$="/plans"] button.btn--primary', nav: true, say: { en: 'Choose Agree the plan.', ar: 'اختر «اعتماد الخطة».' } },
      { point: 'main .card', say: { en: 'Each instalment has its date. Attach a cheque to each one, and late fees stop while the plan is kept.', ar: 'لكل قسط موعده. اربط بكل قسط شيكًا، وتتوقف غرامات التأخير ما دامت الخطة ملتزمًا بها.' } },
    ],
  },
  {
    id: 'revenue-collections-writeoff',
    area: 'revenue',
    module: '/admin/collections',
    also: ['/admin/invoices'],
    order: 120,
    level: 'advanced',
    roles: ['finance', 'management'],
    title: { en: 'Late fees and writing off a debt', ar: 'غرامات التأخير وإعدام الدين' },
    summary: {
      en: 'Charge a late fee, and ask for approval to write off what will never be paid.',
      ar: 'احتسب غرامة تأخير، واطلب الموافقة على إعدام الدين الذي لن يُسدَّد.',
    },
    steps: [
      { go: '/admin/billing?status=overdue', say: { en: 'Everything about collecting one invoice is on the invoice itself.', ar: 'كل ما يخص تحصيل الفاتورة موجود في الفاتورة نفسها.' } },
      { click: 'tr[data-href^="/admin/invoices/"]', nav: true },
      { point: 'section.card:has(form[action$="/writeoff"])', say: { en: 'Under Collections you can send a reminder, or charge the late fee set in the settings.', ar: 'من «التحصيل» يمكنك إرسال تذكير، أو احتساب غرامة التأخير المحددة في الإعدادات.' } },
      { click: 'summary', has: { en: 'Write off', ar: 'إعدام الدين' }, say: { en: 'If the money will never come, choose Write off.', ar: 'إن كان المبلغ لن يُسدَّد أبدًا، اختر «إعدام الدين».' } },
      { type: ['form[action$="/writeoff"] input[name=reason]', { en: 'Tenant left the country, no assets', ar: 'غادر المستأجر البلاد ولا توجد أصول' }], say: { en: 'Give the amount and the reason.', ar: 'أدخل المبلغ والسبب.' } },
      { click: 'form[action$="/writeoff"] button', say: { en: 'Write-offs always need a manager\'s approval, so choose Ask for approval.', ar: 'يحتاج إعدام الدين دائمًا إلى موافقة مدير، لذا اختر «اطلب الموافقة».' } },
      { point: 'section.card:has(form[action$="/writeoff"])', say: { en: 'The request goes to Approvals and tasks. Once approved, the debt is written off and the accounts are updated.', ar: 'يذهب الطلب إلى «الموافقات والمهام»، وبعد الموافقة يُعدَم الدين وتُحدَّث الحسابات.' } },
      { say: { en: 'Every write-off, and who approved it, is listed under Write-offs in Collections.', ar: 'وتجد كل دين معدوم، ومن وافق عليه، في «الديون المعدومة» داخل صفحة التحصيل.' } },
    ],
  },

  // ------------------------------------------------------------------ advertising
  {
    id: 'revenue-media-campaign',
    area: 'revenue',
    module: '/admin/media',
    order: 130,
    roles: ['leasing', 'management'],
    title: { en: 'Selling advertising: from quote to campaign', ar: 'بيع الإعلانات: من عرض السعر إلى الحملة' },
    summary: {
      en: 'Price screens, banners and promotion spaces for an advertiser and save the quote as a campaign.',
      ar: 'سعّر الشاشات واللافتات ومساحات الترويج لمعلن، واحفظ عرض السعر كحملة.',
    },
    steps: [
      { go: '/admin/media', say: { en: 'Advertising sells the mall\'s screens, banners, promotion spaces and car display spots.', ar: 'تبيع صفحة الإعلانات شاشات المول ولافتاته ومساحات الترويج وأماكن عرض السيارات.' } },
      { point: '.kpis', say: { en: 'You see this month\'s revenue, how full the spaces are, and what needs attention.', ar: 'ترى إيرادات هذا الشهر ونسبة إشغال المساحات وما يحتاج متابعة.' } },
      { click: '.bar__actions a[href="/admin/media/quote"]', nav: true, say: { en: 'Choose Build a quote.', ar: 'اختر «إعداد عرض سعر».' } },
      { select: ['select[name=client]', 'c:2'], say: { en: 'Choose the advertiser and name the campaign.', ar: 'اختر المعلن وسمِّ الحملة.' } },
      { type: ['input[name=title]', { en: 'Winter launch', ar: 'إطلاق الشتاء' }] },
      { click: 'label:has(input[name=item][value="2"])', say: { en: 'Tick the spaces. Busy dates show as taken, so you never double-book.', ar: 'حدد المساحات. تظهر التواريخ المحجوزة مشغولة، فلا يتكرر الحجز أبدًا.' } },
      { click: 'label:has(input[name=item][value="9"])' },
      { click: '.med-quote__acts button', nav: true, say: { en: 'Choose Update the price.', ar: 'اختر «تحديث السعر».' } },
      { point: '.med-ql', say: { en: 'The quote applies the rate card, the season and any package discount.', ar: 'يطبق عرض السعر قائمة الأسعار والموسم وأي خصم للباقة.' } },
      { click: '.med-quote__go', nav: true, say: { en: 'Choose Save as a proposal.', ar: 'اختر «حفظ كعرض».' } },
      { point: '.med-steps', say: { en: 'The campaign moves from proposal to confirmed, artwork approved, live and ended.', ar: 'تنتقل الحملة من عرض إلى مؤكدة، ثم اعتماد التصميم، ثم العرض المباشر، ثم الانتهاء.' } },
      { point: '.med-acts', say: { en: 'Hold the spaces while the client decides, then confirm the booking and raise the invoice. Print the proposal from the top.', ar: 'احجز المساحات مؤقتًا حتى يقرر العميل، ثم أكّد الحجز وأصدر الفاتورة. واطبع العرض من الأعلى.' } },
      { say: { en: 'The Calendar tab shows every space week by week, booked and free.', ar: 'ويعرض تبويب «التقويم» كل مساحة أسبوعًا بأسبوع، المحجوز منها والمتاح.' } },
    ],
  },

  // ------------------------------------------------------------------ turnover rent
  {
    id: 'revenue-turnover',
    area: 'revenue',
    module: '/admin/turnover',
    order: 140,
    roles: ['finance', 'management'],
    title: { en: 'Tenant sales and turnover rent', ar: 'مبيعات المستأجرين وإيجار النسبة' },
    summary: {
      en: 'Enter monthly sales, compare tenants, and bill the share of sales above the breakpoint.',
      ar: 'أدخل المبيعات الشهرية، وقارن بين المستأجرين، وأصدر فاتورة النسبة من المبيعات فوق الحد.',
    },
    steps: [
      { go: '/admin/turnover', say: { en: 'Turnover and sales follows what each tenant sells, and the rent they owe on it.', ar: 'تتابع صفحة المبيعات وإيجار النسبة ما يبيعه كل مستأجر، والإيجار المستحق عليه.' } },
      { point: '.kpis', say: { en: 'Total sales, sales per square metre, and the rent to sales ratio.', ar: 'إجمالي المبيعات، والمبيعات لكل متر مربع، ونسبة الإيجار إلى المبيعات.' } },
      { click: '.tabs a[href="/admin/turnover/sales"]', nav: true, say: { en: 'Each month, enter the sales on the Sales tab.', ar: 'كل شهر، أدخل المبيعات من تبويب «المبيعات».' } },
      { type: ['input[name=gross_3]', '1850000'], say: { en: 'Type the gross sales, the returns and the number of receipts.', ar: 'اكتب إجمالي المبيعات والمرتجعات وعدد الإيصالات.' } },
      { type: ['input[name=returns_3]', '42000'] },
      { type: ['input[name=tx_3]', '3120'] },
      { click: 'form[action="/admin/turnover/sales"] button.btn--primary', say: { en: 'Choose Save sales. Tenants can also send them from their portal.', ar: 'اختر «حفظ المبيعات». ويمكن للمستأجرين إرسالها من بوابتهم أيضًا.' } },
      { click: '.tabs a[href="/admin/turnover/billing"]', nav: true, say: { en: 'Then open Billing.', ar: 'ثم افتح «الفوترة».' } },
      { point: 'section.card:has(form[action="/admin/turnover/bill"])', say: { en: 'Turnover rent is the sales above the breakpoint, times the agreed percentage. When sales are below it, nothing is owed.', ar: 'إيجار النسبة هو المبيعات فوق الحد مضروبة في النسبة المتفق عليها، وإن كانت المبيعات أقل منه فلا شيء مستحق.' } },
      { click: 'form[action="/admin/turnover/bill"] button', say: { en: 'Bill each lease, or record nil, so the month is closed.', ar: 'أصدر فاتورة لكل عقد أو سجّله بلا مستحق، ليُغلق الشهر.' } },
      { point: 'main', say: { en: 'Billed months move down. On the overview, the ranking compares every tenant\'s sales.', ar: 'تنتقل الشهور المفوترة إلى الأسفل. وفي النظرة العامة يقارن الترتيب مبيعات كل المستأجرين.' } },
    ],
  },

  // ------------------------------------------------------------------ service charge
  {
    id: 'revenue-service-charge',
    area: 'revenue',
    module: '/admin/service-charge',
    order: 150,
    level: 'advanced',
    roles: ['finance', 'management'],
    title: { en: 'Service charge: budget, costs and year-end', ar: 'رسوم الخدمات: الموازنة والتكاليف ونهاية العام' },
    summary: {
      en: 'Plan the year\'s budget, record the real costs, and settle the difference with each tenant at year-end.',
      ar: 'خطط لموازنة العام، وسجّل التكاليف الفعلية، وسوِّ الفرق مع كل مستأجر في نهاية العام.',
    },
    steps: [
      { go: '/admin/service-charge', say: { en: 'Service charge shares the cost of running the mall among the tenants.', ar: 'تُوزّع رسوم الخدمات تكلفة تشغيل المول على المستأجرين.' } },
      { point: '.kpis', say: { en: 'The budget, the costs so far, what was billed and the expected balance.', ar: 'الموازنة، والتكاليف حتى الآن، وما فُوتر، والرصيد المتوقع.' } },
      { click: '.tabs a[href^="/admin/service-charge/budget"]', nav: true, say: { en: 'The budget sets the cost of each category for the year.', ar: 'تحدد الموازنة تكلفة كل بند للعام.' } },
      { select: ['select[name=year]', '2027'], say: { en: 'Choose next year.', ar: 'اختر العام القادم.' } },
      { wait: 'form[action="/admin/service-charge/budget/copy"]' },
      { type: ['form[action="/admin/service-charge/budget/copy"] input[name=uplift]', '12'], say: { en: 'Start from last year with an uplift, then adjust any line.', ar: 'ابدأ من العام السابق بنسبة زيادة، ثم عدّل أي بند.' } },
      { click: 'form[action="/admin/service-charge/budget/copy"] button', say: { en: 'Choose Start from last year.', ar: 'اختر «البدء من العام الماضي».' } },
      { go: '/admin/service-charge/actuals', say: { en: 'Through the year, record the real costs under Actual costs.', ar: 'وعلى مدار العام، سجّل التكاليف الحقيقية في «التكاليف الفعلية».' } },
      { select: ['form[action="/admin/service-charge/actuals"] select[name=category]', 'cleaning'], say: { en: 'Choose the month and the category, and the amount.', ar: 'اختر الشهر والبند والمبلغ.' } },
      { type: ['form[action="/admin/service-charge/actuals"] input[name=amount]', '186000'] },
      { click: 'form[action="/admin/service-charge/actuals"] button.btn--primary', say: { en: 'Choose Add cost. You can also import them, or bring them from the accounts.', ar: 'اختر «إضافة تكلفة». ويمكنك أيضًا استيرادها أو جلبها من الحسابات.' } },
      { click: '.tabs a[href^="/admin/service-charge/reconciliation"]', nav: true, say: { en: 'At year-end, Reconciliation compares what each tenant paid with their real share.', ar: 'في نهاية العام، تقارن «التسوية» ما دفعه كل مستأجر بحصته الفعلية.' } },
      { point: 'section.card:has(a[href^="/admin/service-charge/statement/"])', say: { en: 'Each tenant gets a statement to print: a refund, or a balance to pay.', ar: 'يحصل كل مستأجر على كشف للطباعة: مبلغ يُرد له أو رصيد عليه سداده.' } },
    ],
  },

  // ------------------------------------------------------------------ utilities
  {
    id: 'revenue-utilities',
    area: 'revenue',
    module: '/admin/utilities',
    order: 160,
    roles: ['finance', 'operations'],
    title: { en: 'Meter readings and utility bills', ar: 'قراءات العدادات وفواتير المرافق' },
    summary: {
      en: 'Enter the month\'s meter readings, check the unusual ones, and bill the tenants for what they used.',
      ar: 'أدخل قراءات العدادات للشهر، وراجع غير المعتاد منها، وأصدر فواتير المستأجرين حسب استهلاكهم.',
    },
    steps: [
      { go: '/admin/utilities', say: { en: 'Utilities follows electricity, water and gas, for the whole mall and each tenant.', ar: 'تتابع صفحة المرافق الكهرباء والمياه والغاز للمول كله ولكل مستأجر.' } },
      { point: '.kpis', say: { en: 'This month\'s use, the cost and the amount recovered from tenants.', ar: 'استهلاك هذا الشهر وتكلفته والمبلغ المسترد من المستأجرين.' } },
      { click: '.tabs a[href="/admin/utilities/readings"]', nav: true, say: { en: 'Each month, open Readings.', ar: 'كل شهر، افتح «القراءات».' } },
      { point: 'form[action="/admin/utilities/readings"][method=post]', say: { en: 'Type each meter\'s reading. The use and the cost are worked out as you go.', ar: 'اكتب قراءة كل عداد، ويُحسب الاستهلاك والتكلفة أولًا بأول.' } },
      { point: 'tr.is-flag', say: { en: 'A reading far from the usual is flagged, so a typing mistake is never billed.', ar: 'تُميَّز القراءة البعيدة عن المعتاد، فلا يُفوتر خطأ في الكتابة أبدًا.' } },
      { click: 'form[action$="/accept"] button', say: { en: 'Check it, and accept it if it is right.', ar: 'راجعها، واقبلها إن كانت صحيحة.' } },
      { click: '.tabs a[href="/admin/utilities/billing"]', nav: true, say: { en: 'Then open Billing.', ar: 'ثم افتح «الفوترة».' } },
      { point: 'section.card:has(form[action="/admin/utilities/bill"])', say: { en: 'Each tenant\'s use is priced with the tariff, ready to bill.', ar: 'يُسعَّر استهلاك كل مستأجر حسب التعريفة، وهو جاهز للفوترة.' } },
      { click: 'form[action="/admin/utilities/bill"] button', say: { en: 'Choose Bill utilities. The invoices go to the tenants with the readings on them.', ar: 'اختر «فوترة المرافق». تصل الفواتير إلى المستأجرين ومعها القراءات.' } },
      { point: 'main', say: { en: 'Billed meters move down, and readings held back wait for you to check them.', ar: 'تنتقل العدادات المفوترة إلى الأسفل، وتنتظر القراءات المستبعدة مؤقتًا مراجعتك.' } },
    ],
  },
];
