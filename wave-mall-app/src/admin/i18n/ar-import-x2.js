'use strict';

// Arabic for the Excel import of finance, purchasing and people (imp2|): the messages of the
// datasets in src/admin/import/datasets/finance.js and people.js, and the activity-log actions
// they add.

module.exports = {
  // ---------- activity log ----------
  'Updated an asset': 'تعديل أصل',
  'Changed a leave record': 'تعديل سجل إجازة',

  // ---------- chart of accounts ----------
  'imp2|A group code has 2 to 6 digits.': 'رقم المجموعة من رقمين إلى ٦ أرقام.',
  'imp2|An account code has 3 to 6 digits.': 'رقم الحساب من ٣ إلى ٦ أرقام.',
  'imp2|Choose the group it sits under.': 'اختر المجموعة التي يندرج تحتها.',
  'imp2|That is an account, not a group.': 'هذا حساب وليس مجموعة.',
  'imp2|Give the type: its group is new in this file.': 'حدد النوع: مجموعته جديدة في هذا الملف.',
  'imp2|An account has the type of its group ({type}).': 'الحساب يأخذ نوع مجموعته ({type}).',
  'imp2|An account moves only to a group of the same type ({type}).': 'ينتقل الحساب فقط إلى مجموعة من النوع نفسه ({type}).',
  'imp2|A group cannot sit under itself.': 'لا يمكن أن تندرج المجموعة تحت نفسها.',
  'imp2|A system account stays active: the automatic postings use it.': 'حساب النظام يبقى نشطًا: تستخدمه القيود التلقائية.',

  // ---------- bank and cash accounts ----------
  'imp2|More than one bank account has this name; rename one of them first.': 'أكثر من حساب بنكي يحمل هذا الاسم؛ غيّر اسم أحدها أولًا.',
  'imp2|An account in the chart already has this name.': 'يوجد في الدليل حساب بهذا الاسم بالفعل.',
  'imp2|That month is closed: the balance is booked on the first open day.': 'هذا الشهر مغلق: يُقيد الرصيد في أول يوم مفتوح.',
  'imp2|A balance cannot be dated in the future.': 'لا يمكن أن يكون تاريخ الرصيد في المستقبل.',

  // ---------- opening trial balance ----------
  'imp2|Tenant receivables come from their unpaid invoices: if you import those, leave this account out or it counts twice.': 'ذمم المستأجرين تأتي من فواتيرهم غير المسددة: إن استوردتها فلا تضع هذا الحساب هنا، وإلا يُحسب مرتين.',
  'imp2|Supplier payables come from their unpaid bills: if you import those, leave this account out or it counts twice.': 'ذمم الموردين تأتي من فواتيرهم غير المسددة: إن استوردتها فلا تضع هذا الحساب هنا، وإلا يُحسب مرتين.',
  'imp2|Staff advances imported under Salary advances post their own balance here: leave it out if you import them.': 'السلف المستوردة في قائمة السلف تُقيد رصيدها هنا بنفسها: لا تضع هذا الحساب إن استوردتها.',
  'imp2|Tenant deposits come from deposit invoices: check you are not importing them twice.': 'تأمينات المستأجرين تأتي من فواتير التأمين: تأكد أنك لا تستوردها مرتين.',
  'imp2|VAT is worked out from invoices and bills from now on: bring in only what was still due on the start day.': 'ضريبة القيمة المضافة تُحسب من الآن من الفواتير: أدخل فقط ما كان مستحقًا يوم البدء.',
  'imp2|A line is a debit or a credit, not both.': 'السطر إما مدين أو دائن، لا الاثنين معًا.',
  'imp2|Give the debit or the credit balance.': 'أدخل الرصيد المدين أو الدائن.',
  'imp2|Opening balances (3900) balances the entry by itself: leave it out.': 'حساب الأرصدة الافتتاحية (٣٩٠٠) يوازن القيد تلقائيًا: لا تضعه.',
  'imp2|This account is inactive.': 'هذا الحساب غير نشط.',
  'imp2|This account already has an opening balance from another list (bank accounts or stock): it would count twice.': 'لهذا الحساب رصيد افتتاحي من قائمة أخرى (الحسابات البنكية أو المخزون): سيُحسب مرتين.',
  'imp2|The books are closed on {date}: reopen that month or choose a later date.': 'الدفاتر مغلقة في {date}: أعد فتح ذلك الشهر أو اختر تاريخًا لاحقًا.',
  'imp2|The books are closed on that date: reopen that month or choose a later date.': 'الدفاتر مغلقة في ذلك التاريخ: أعد فتح ذلك الشهر أو اختر تاريخًا لاحقًا.',
  'imp2|This date is in the future.': 'هذا التاريخ في المستقبل.',
  'imp2|The balances on {date} do not balance: debits {dr}, credits {cr}, a difference of {diff}.': 'أرصدة {date} غير متوازنة: المدين {dr} والدائن {cr}، بفرق {diff}.',

  // ---------- suppliers and their bills ----------
  'imp2|More than one supplier has this name; rename one of them first.': 'أكثر من مورد يحمل هذا الاسم؛ غيّر اسم أحدهم أولًا.',
  'imp2|Another supplier already has this name.': 'يوجد مورد آخر بهذا الاسم.',
  'imp2|Give the amount still owed.': 'أدخل المبلغ المتبقي.',
  'imp2|A bill on the start day cannot be dated in the future.': 'لا يمكن أن تكون فاتورة يوم البدء بتاريخ في المستقبل.',
  'imp2|The due date is before the bill date.': 'تاريخ الاستحقاق قبل تاريخ الفاتورة.',
  'imp2|This bill was entered in the office or is settled: change it there.': 'هذه الفاتورة أُدخلت من المكتب أو سُددت: عدّلها من هناك.',

  // ---------- fixed assets ----------
  'imp2|Give the cost.': 'أدخل التكلفة.',
  'imp2|The residual value must be below the cost.': 'يجب أن تكون القيمة التخريدية أقل من التكلفة.',
  'imp2|An asset cannot be acquired in the future.': 'لا يمكن أن يكون تاريخ اقتناء الأصل في المستقبل.',
  'imp2|More depreciation than the cost less the residual value.': 'الإهلاك أكبر من التكلفة مطروحًا منها القيمة التخريدية.',
  'imp2|Give the month the depreciation runs to.': 'حدد الشهر الذي يغطيه الإهلاك.',
  'imp2|That month is before the asset was acquired.': 'هذا الشهر قبل اقتناء الأصل.',
  'imp2|That month is in the future.': 'هذا الشهر في المستقبل.',
  'imp2|No depreciation was given, so this month is not used.': 'لم يُذكر إهلاك، لذلك لا يُستخدم هذا الشهر.',

  // ---------- store items ----------
  'imp2|No unit cost: the opening stock is valued at zero.': 'لا توجد تكلفة للوحدة: يُقيّم الرصيد الافتتاحي بصفر.',
  'imp2|A unit cost without a quantity is not used.': 'تكلفة الوحدة بدون كمية لا تُستخدم.',
  'imp2|A count cannot be dated in the future.': 'لا يمكن أن يكون تاريخ الجرد في المستقبل.',

  // ---------- salary advances ----------
  'imp2|Give the amount given.': 'أدخل المبلغ الممنوح.',
  'imp2|More was repaid than was given.': 'المسدد أكبر من المبلغ الممنوح.',
  'imp2|Fully repaid: it is saved as repaid.': 'مسددة بالكامل: تُحفظ على أنها مسددة.',
  'imp2|An advance on the start day cannot be dated in the future.': 'لا يمكن أن يكون تاريخ صرف السلفة في المستقبل.',
  'imp2|The next deduction cannot be before the advance was given.': 'لا يمكن أن يكون الخصم التالي قبل صرف السلفة.',
  'imp2|Repaid before the start day': 'مسدد قبل يوم البدء',
  'imp2|The employee of an advance cannot be changed.': 'لا يمكن تغيير موظف السلفة.',

  // ---------- leave ----------
  'imp2|This leave is still waiting for a decision: decide it in the office.': 'هذه الإجازة ما زالت تنتظر القرار: قرر بشأنها من المكتب.',
  'imp2|The leave ends before it starts.': 'تنتهي الإجازة قبل أن تبدأ.',
  'imp2|Those dates are all Fridays.': 'كل هذه التواريخ أيام جمعة.',
  'imp2|More days than the working days between the dates ({n}).': 'عدد الأيام أكبر من أيام العمل بين التاريخين ({n}).',
  'imp2|Days are whole or half days.': 'الأيام أيام كاملة أو أنصاف أيام.',
  'imp2|That overlaps leave already booked for this person.': 'تتداخل مع إجازة محجوزة لهذا الشخص.',
  'imp2|This overlaps the leave on row {line}.': 'تتداخل مع الإجازة في الصف {line}.',

  // ---------- shifts ----------
  'imp2|“{day}” is not a day of the week.': '«{day}» ليس يومًا من أيام الأسبوع.',
  'imp2|Give at least one day.': 'حدد يومًا واحدًا على الأقل.',
  'imp2|More than one shift has this name; rename one of them first.': 'أكثر من وردية تحمل هذا الاسم؛ غيّر اسم إحداها أولًا.',
  'imp2|A shift cannot end when it starts.': 'لا يمكن أن تنتهي الوردية عند بدايتها.',
  'imp2|It ends before it starts.': 'تنتهي قبل أن تبدأ.',
  'imp2|They already have “{shift}” from {date}: end this one before, or change that one on the Shifts page.': 'لديه بالفعل وردية «{shift}» من {date}: اجعل هذه تنتهي قبلها، أو غيّر تلك من صفحة الورديات.',
  'imp2|It must end before the shift on row {line} starts.': 'يجب أن تنتهي قبل بداية الوردية في الصف {line}.',
};
