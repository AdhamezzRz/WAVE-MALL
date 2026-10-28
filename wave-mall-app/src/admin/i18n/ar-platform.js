'use strict';

// Arabic for the shared platform pieces added for the new modules: invoice kinds, payment methods,
// the payments ledger, the new menu sections and permissions.

module.exports = {
  // invoice kinds (kind|Rent … kind|Other charge live in ar-office.js)
  'kind|Service charge': 'رسوم الخدمات',
  'kind|Turnover rent': 'إيجار نسبة المبيعات',
  'kind|Service charge settlement': 'تسوية رسوم الخدمات',
  'kind|Utilities': 'المرافق',
  'kind|Short-term space': 'مساحة قصيرة الأجل',
  'kind|Fit-out': 'التجهيز',
  'kind|Penalty': 'غرامة',
  // payment methods
  'pay|Bank transfer': 'تحويل بنكي',
  'pay|Cheque': 'شيك',
  'pay|Card': 'بطاقة',
  'pay|Cash': 'نقدًا',
  'pay|Online payment': 'دفع إلكتروني',
  'pay|InstaPay': 'إنستاباي',
  'pay|Fawry': 'فوري',
  'pay|Mobile wallet': 'محفظة إلكترونية',
  // payments on an invoice
  Payments: 'المدفوعات',
  'No payments yet.': 'لا توجد مدفوعات بعد.',
  Reverse: 'عكس',
  'Reverse this payment? The invoice will be open again.': 'عكس هذه الدفعة؟ ستعود الفاتورة مستحقة.',
  'Payment reversed.': 'تم عكس الدفعة.',
  'pay|Reversed': 'معكوسة',
  'pay|Received': 'مستلمة',
  'That payment cannot be reversed.': 'لا يمكن عكس هذه الدفعة.',
  'This invoice is not open for payment.': 'هذه الفاتورة غير مفتوحة للدفع.',
  'Only an open invoice with nothing paid can be voided.': 'لا يمكن إلغاء إلا فاتورة مستحقة لم يُدفع منها شيء.',
  Customer: 'العميل',
  // stored audit text
  'Reversed a payment': 'عكس دفعة',
  'Recorded before the payments ledger': 'سُجِّلت قبل دفتر المدفوعات',
  // menu
  'nav|Finance': 'المالية',
  'nav|Accounting': 'المحاسبة',
  'nav|Operations': 'التشغيل',
  'nav|Conversations': 'المحادثات',
  'nav|Fit-out': 'التجهيز',
  'nav|Short-term space': 'المساحات المؤقتة',
  'nav|Turnover & sales': 'المبيعات وإيجار النسبة',
  'nav|Service charge': 'رسوم الخدمات',
  'nav|Utilities': 'المرافق',
  'nav|Maintenance': 'الصيانة',
  'nav|Footfall': 'حركة الزوار',
  'nav|Website': 'الموقع الإلكتروني',
  'nav|Tenant portal': 'بوابة المستأجرين',
  'nav|Integrations': 'التكاملات',
  // permissions
  'Finance access': 'صلاحية المالية',
  'Finance access (accounting, banks, reports)': 'صلاحية المالية (المحاسبة والبنوك والتقارير)',
  'Granted finance access': 'منح صلاحية المالية',
  'Removed finance access': 'سحب صلاحية المالية',
  'Only people with finance access can see this.': 'هذه الصفحة لأصحاب صلاحية المالية فقط.',
};
