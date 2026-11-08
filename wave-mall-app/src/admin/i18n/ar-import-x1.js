'use strict';

// Arabic for the leasing and revenue datasets of Import from Excel (imp1|): tenant contacts, leads,
// leases, service contracts, opening balances, cheques and tenants' sales (src/admin/import/datasets/
// leasing.js and revenue.js), plus the activity-log lines and stored notes those imports write.

module.exports = {
  // ---------- activity log ----------
  'Updated a contact': 'تعديل جهة اتصال',
  'Updated a cheque': 'تعديل شيك',
  'Opened a tenant portal account': 'فتح حساب في بوابة المستأجرين',
  'Imported a past lease': 'استيراد عقد سابق',
  'Imported an opening balance': 'استيراد رصيد افتتاحي',
  'Updated an opening balance': 'تعديل رصيد افتتاحي',
  // ---------- notes the imports store (shown on invoices and receipts) ----------
  'Opening balance': 'رصيد افتتاحي',
  'Security deposit (received before go-live)': 'مبلغ التأمين (استُلم قبل بدء العمل بالنظام)',
  'Received before go-live': 'استُلم قبل بدء العمل بالنظام',

  // ---------- shared ----------
  'imp1|The end is before the start.': 'تاريخ النهاية قبل تاريخ البداية.',
  'imp1|Give the lease or the tenant.': 'أدخل العقد أو المستأجر.',
  'imp1|This is not the tenant of that lease.': 'هذا ليس مستأجر ذلك العقد.',
  'imp1|The amount must be more than zero.': 'يجب أن يكون المبلغ أكبر من صفر.',

  // ---------- tenant contacts ----------
  'imp1|A portal account needs the person’s email.': 'حساب البوابة يحتاج إلى البريد الإلكتروني للشخص.',
  'imp1|This email already has a portal account with another brand.': 'هذا البريد له حساب في البوابة لدى علامة أخرى.',
  'imp1|Portal accounts are closed on the Tenant portal page; this one stays open.': 'تُغلق حسابات البوابة من صفحة بوابة المستأجرين؛ يبقى هذا الحساب مفتوحًا.',
  'imp1|This email is also a contact of {brand}.': 'هذا البريد مسجل أيضًا كجهة اتصال لدى {brand}.',
  'imp1|This brand has more than one contact with this name; add their email to tell them apart.': 'لدى هذه العلامة أكثر من جهة اتصال بهذا الاسم؛ أضف البريد الإلكتروني للتمييز بينها.',

  // ---------- leads ----------
  'imp1|{ref} looks like a number the office gives, but no lead has it. Leave it empty for a new lead.': '{ref} يشبه رقمًا يعطيه النظام، لكن لا توجد فرصة بهذا الرقم. اتركه فارغًا لفرصة جديدة.',
  'imp1|The largest area is smaller than the smallest.': 'أكبر مساحة أصغر من أصغر مساحة.',
  'imp1|Say why the lead was lost.': 'اذكر سبب خسارة الفرصة.',
  'imp1|A reason is only kept for lost leads.': 'السبب يُحفظ للفرص الخاسرة فقط.',
  'imp1|{ref} is already an open lead for this name.': 'توجد بالفعل فرصة مفتوحة بهذا الاسم ({ref}).',

  // ---------- leases ----------
  'imp1|The terms of a lease already in the system change through an amendment on the lease page, not an import.': 'شروط العقد الموجود في النظام تتغير بملحق من صفحة العقد، لا بالاستيراد.',
  'imp1|A lease can go from Draft to Active, or from Active to Ended or Terminated.': 'ينتقل العقد من مسودة إلى ساري، أو من ساري إلى منتهٍ أو مفسوخ.',
  'imp1|{codes} already leased.': '{codes} مؤجرة بالفعل.',
  'imp1|Give the lease’s last day.': 'أدخل آخر يوم في العقد.',
  'imp1|The last day must be between the start and the end of the lease.': 'يجب أن يكون آخر يوم بين بداية العقد ونهايته.',
  'imp1|{ref} looks like a number the office gives, but no lease has it. Leave it empty, or use your own contract number.': '{ref} يشبه رقمًا يعطيه النظام، لكن لا يوجد عقد بهذا الرقم. اتركه فارغًا، أو استخدم رقم عقدك.',
  'imp1|Unit {codes} is not in the system. Import Units first, or check the code.': 'الوحدة {codes} غير موجودة في النظام. استورد الوحدات أولًا، أو راجع الرمز.',
  'imp1|{codes} was merged or split and cannot be leased.': '{codes} دُمجت أو قُسمت ولا يمكن تأجيرها.',
  'imp1|Give at least one unit.': 'أدخل وحدة واحدة على الأقل.',
  'imp1|A {n}-year lease from this start ends on {date}. Leases run whole years: fix the term or the end date.': 'عقد مدته بالسنوات {n} ابتداءً من هذا التاريخ ينتهي في {date}. العقود تُحسب بسنوات كاملة: صحّح المدة أو تاريخ النهاية.',
  'imp1|This lease ended on {date}; import it as Ended.': 'انتهى هذا العقد في {date}؛ استورده بحالة «منتهٍ».',
  'imp1|Give the share of sales (more than 0%, up to 50%).': 'أدخل النسبة من المبيعات (أكبر من ٠٪ وحتى ٥٠٪).',
  'imp1|Give the rent per m², or mark the lease as a revenue share.': 'أدخل الإيجار للمتر، أو اجعل العقد بنسبة من المبيعات.',
  'imp1|The share and the guarantee are only used when Revenue share is Yes.': 'النسبة والحد الأدنى يُستخدمان فقط عندما تكون «نسبة من المبيعات» نعم.',
  'imp1|Service charge is a percentage, but no percentage is given.': 'رسوم الخدمات نسبة، لكن لم تُدخل النسبة.',
  'imp1|A stepped increase needs both the year and the percentage.': 'الزيادة المتدرجة تحتاج إلى السنة والنسبة معًا.',
  'imp1|Year {n} is after the end of the lease.': 'السنة {n} بعد نهاية العقد.',
  'imp1|More than the deposit itself.': 'أكبر من مبلغ التأمين نفسه.',
  'imp1|More than the key money itself.': 'أكبر من مقابل الخلو نفسه.',
  'imp1|Only used for Active leases.': 'يُستخدم للعقود السارية فقط.',
  'imp1|{code} is in lease {ref} at the same time.': '{code} مدرجة في العقد {ref} في الفترة نفسها.',
  'imp1|{codes} is blocked; the lease makes it leased.': '{codes} محجوبة؛ سيجعلها العقد مؤجرة.',

  // ---------- service contracts ----------
  'imp1|{ref} looks like a number the office gives, but no contract has it. Leave it empty, or use your own number.': '{ref} يشبه رقمًا يعطيه النظام، لكن لا يوجد عقد خدمة بهذا الرقم. اتركه فارغًا، أو استخدم رقمك.',

  // ---------- opening balances ----------
  'imp1|{ref} is an invoice the office made; an opening balance needs your old invoice number.': '{ref} فاتورة أصدرها النظام؛ الرصيد الافتتاحي يحتاج إلى رقم الفاتورة في نظامك القديم.',
  'imp1|The amounts and the tenant of an imported opening balance cannot change. Undo that import, or void the invoice and import it again.': 'لا يمكن تغيير مبالغ الرصيد الافتتاحي المستورد ولا مستأجره. تراجع عن ذلك الاستيراد، أو ألغِ الفاتورة واستوردها من جديد.',
  'imp1|{ref} looks like a number the office gives; use the number from your old system.': '{ref} يشبه رقمًا يعطيه النظام؛ استخدم الرقم من نظامك القديم.',
  'imp1|Nothing is left to pay on this invoice, so it is not an opening balance.': 'لم يتبقَّ شيء مستحق على هذه الفاتورة، فهي ليست رصيدًا افتتاحيًا.',
  'imp1|This invoice is not due yet; it is still an opening balance.': 'هذه الفاتورة لم تستحق بعد؛ وتبقى رصيدًا افتتاحيًا.',

  // ---------- cheques ----------
  'imp1|More than one cheque has this number and bank; use its CQ number.': 'يوجد أكثر من شيك بهذا الرقم والبنك؛ استخدم رقم سجله في النظام.',
  'imp1|This cheque is already settled; it cannot change by an import.': 'هذا الشيك تمت تسويته؛ لا يمكن تغييره بالاستيراد.',
  'imp1|The number, amount and tenant of a cheque cannot change by an import.': 'لا يمكن تغيير رقم الشيك ولا مبلغه ولا مستأجره بالاستيراد.',
  'imp1|An import can only send a cheque from the portfolio to the bank; other steps are on the cheque’s page.': 'الاستيراد ينقل الشيك من الحافظة إلى البنك فقط؛ الخطوات الأخرى من صفحة الشيك.',
  'imp1|Give the date it was deposited.': 'أدخل تاريخ الإيداع.',
  'imp1|{ref} is not a cheque in the system. Leave it empty for a new cheque.': '{ref} ليس شيكًا في النظام. اتركه فارغًا لشيك جديد.',
  'imp1|Only cheques in the portfolio or at the bank are imported; collected ones stay in your old records.': 'تُستورد الشيكات التي في الحافظة أو في البنك فقط؛ أما المحصلة فتبقى في سجلاتك القديمة.',
  'imp1|That invoice is not this tenant’s.': 'هذه الفاتورة لا تخص هذا المستأجر.',
  'imp1|That invoice is no longer open.': 'هذه الفاتورة لم تعد مفتوحة.',
  'imp1|The cheque is more than what is left on that invoice; the rest goes on the tenant’s other open invoices when collected.': 'قيمة الشيك أكبر من المتبقي على تلك الفاتورة؛ يُخصم الباقي من فواتير المستأجر المفتوحة الأخرى عند التحصيل.',
  'imp1|This cheque is already in the portfolio.': 'هذا الشيك موجود بالفعل في الحافظة.',
  'imp1|This cheque is more than six months past its date; a bank may refuse it.': 'مضى على تاريخ هذا الشيك أكثر من ستة أشهر؛ قد يرفضه البنك.',

  // ---------- tenant sales ----------
  'imp1|Returns cannot be more than the gross sales.': 'لا يمكن أن تزيد المرتجعات على إجمالي المبيعات.',
  'imp1|Sales cannot be reported for a future month.': 'لا يمكن تسجيل مبيعات لشهر لم يأتِ بعد.',
  'imp1|The lease does not cover this month.': 'العقد لا يغطي هذا الشهر.',
  'imp1|This month is already billed, so its sales are locked.': 'هذا الشهر فوتر بالفعل، فمبيعاته مغلقة.',
  'imp1|New sales are Submitted or Verified.': 'المبيعات الجديدة تكون «مُرسلة» أو «تم التحقق».',
  'imp1|Only a manager can mark sales as verified.': 'المدير فقط يمكنه اعتماد المبيعات كمُتحقق منها.',
};
