'use strict';

// Records: the document library and the mall's service contracts.

module.exports = [
  {
    id: 'records-documents',
    area: 'records',
    module: '/admin/documents',
    order: 10,
    roles: ['all'],
    title: { en: 'Keeping documents up to date', ar: 'إبقاء المستندات محدّثة' },
    summary: {
      en: 'Find any document in the office, see what has expired, and replace it with a new version.',
      ar: 'اعثر على أي مستند في المكتب، واعرف ما انتهت صلاحيته، واستبدله بإصدار جديد.',
    },
    steps: [
      { go: '/admin/documents', say: { en: 'Documents is the library of every file in the office: tenant papers, leases, permits, contracts and staff files.', ar: '«المستندات» هي مكتبة كل ملفات المكتب: أوراق المستأجرين والعقود والتصاريح والعقود الخدمية وملفات الموظفين.' } },
      { point: '.kpis', say: { en: 'The top shows what is on file, what expires within thirty days and what has already expired.', ar: 'يعرض الأعلى ما هو محفوظ، وما ينتهي خلال ثلاثين يومًا، وما انتهت صلاحيته بالفعل.' } },
      { point: 'form.filters', say: { en: 'Search by title or reference, or filter by what the document belongs to: a brand, a lease, an employee or a unit.', ar: 'ابحث بالعنوان أو الرقم المرجعي، أو صفِّ حسب ما يتبعه المستند: علامة أو عقد أو موظف أو وحدة.' } },
      { click: '.kpis a.kpi[href$="status=expired"]', nav: true, say: { en: 'Let us deal with the expired ones.', ar: 'لنبدأ بالمستندات المنتهية.' } },
      { click: 'tr[data-href^="/admin/documents/"]', nav: true, say: { en: 'Open a document.', ar: 'افتح مستندًا.' } },
      { point: 'main section.card', has: { en: 'Preview', ar: 'معاينة' }, say: { en: 'You can read it right here, without downloading it.', ar: 'يمكنك قراءته هنا مباشرةً دون تنزيله.' } },
      { point: 'main section.card', has: { en: 'Details', ar: 'التفاصيل' }, say: { en: 'Its details show what it belongs to, when it was issued and when it expires.', ar: 'تعرض تفاصيله ما يتبعه، ومتى صدر، ومتى تنتهي صلاحيته.' } },
      { scroll: 'form.upload', say: { en: 'When the renewed copy arrives, use Upload a new version.', ar: 'عندما تصل النسخة المجددة، استخدم «رفع إصدار جديد».' } },
      { point: 'form.upload', say: { en: 'Set the new issue and expiry dates and drop in the file. The old one stays in Versions, and the reminders start again from the new date.', ar: 'حدد تاريخي الإصدار والانتهاء الجديدين وأضف الملف. يبقى القديم في «الإصدارات»، وتبدأ التذكيرات من التاريخ الجديد.' } },
      { say: { en: 'The office reminds the owner of each document thirty days before it expires, so nothing lapses by surprise.', ar: 'يذكّر المكتب المسؤول عن كل مستند قبل انتهائه بثلاثين يومًا، فلا ينتهي شيء دون أن تعلم.' } },
    ],
  },
  {
    id: 'records-contracts',
    area: 'records',
    module: '/admin/contracts',
    order: 20,
    roles: ['operations', 'finance', 'management'],
    title: { en: 'Renewing a service contract', ar: 'تجديد عقد خدمة' },
    summary: {
      en: 'Track what the mall pays its suppliers, see which contracts reach their notice date, and renew or end them on time.',
      ar: 'تابع ما يدفعه المول لمورديه، واعرف العقود التي بلغت موعد الإخطار، وجدّدها أو أنهها في الوقت المناسب.',
    },
    steps: [
      { go: '/admin/contracts', say: { en: 'Contracts holds the mall\'s service contracts, security, cleaning, insurance and more, next to the tenant leases.', ar: 'تحفظ «العقود الخدمية» عقود خدمات المول، كالأمن والنظافة والتأمين وغيرها، إلى جانب عقود المستأجرين.' } },
      { point: '.kpis', say: { en: 'What the mall pays a year, renewals due and what ends in the next ninety days.', ar: 'ما يدفعه المول سنويًا، والتجديدات المستحقة، وما ينتهي خلال التسعين يومًا القادمة.' } },
      { click: '.tabs a[href$="tab=renewals"]', nav: true, say: { en: 'Renewals due lists the contracts whose notice date has arrived. Decide now, before they renew or lapse by themselves.', ar: 'تعرض «تجديدات مستحقة» العقود التي حل موعد إخطارها. قرر الآن قبل أن تتجدد أو تنتهي تلقائيًا.' } },
      { click: 'tr[data-href^="/admin/contracts/"]', nav: true, say: { en: 'Open the contract.', ar: 'افتح العقد.' } },
      { point: 'main section.card', has: { en: 'Details', ar: 'التفاصيل' }, say: { en: 'The supplier, value, billing, notice period and who in the office owns it.', ar: 'المورد والقيمة وطريقة الدفع ومدة الإخطار والمسؤول عنه في المكتب.' } },
      { click: '.bar__actions details.pop > summary.btn--primary', say: { en: 'To keep it, choose Renew.', ar: 'للإبقاء عليه، اختر «تجديد».' } },
      { point: 'form[action$="/renew"] input[name=end_date]', say: { en: 'The new end date is a year on. Change it if you agreed a different term.', ar: 'تاريخ الانتهاء الجديد بعد عام، وغيّره إن اتفقتم على مدة أخرى.' } },
      { type: ['form[action$="/renew"] input[name=value]', '1950000'], say: { en: 'Enter the new value if the price changed.', ar: 'أدخل القيمة الجديدة إن تغيّر السعر.' } },
      { click: 'form[action$="/renew"] button.btn--primary', say: { en: 'Renew the contract.', ar: 'جدّد العقد.' } },
      { point: 'main section.card', has: { en: 'History', ar: 'السجل' }, say: { en: 'The renewal is recorded in its history. If it is not working out, Terminate ends it on a chosen day with the reason.', ar: 'يُسجَّل التجديد في سجله. وإن لم يكن العقد مناسبًا، فإن «إنهاء» يوقفه في يوم تختاره مع ذكر السبب.' } },
    ],
  },
];
