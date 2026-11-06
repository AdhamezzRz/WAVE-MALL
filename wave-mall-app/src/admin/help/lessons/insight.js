'use strict';

// Insight: reports, the owner report and the wall screen.

module.exports = [
  {
    id: 'insight-reports',
    area: 'insight',
    module: '/admin/reports',
    order: 10,
    roles: ['management', 'leasing'],
    title: { en: 'Reading the reports', ar: 'قراءة التقارير' },
    summary: {
      en: 'Occupancy, the rent roll, the forecast, why deals are lost and unpaid invoices, on one page, ready to print or export.',
      ar: 'الإشغال وكشف الإيجارات والتوقعات وأسباب خسارة الصفقات والفواتير غير المسددة في صفحة واحدة، جاهزة للطباعة أو التصدير.',
    },
    steps: [
      { go: '/admin/reports', say: { en: 'Reports gathers the numbers that matter for leasing on one page, always up to date.', ar: 'تجمع صفحة التقارير الأرقام المهمة للتأجير في مكان واحد، محدّثة دائمًا.' } },
      { point: '.kpis', say: { en: 'At the top, the headline figures: occupancy, contracted rent, the average lease length left, the pipeline, the win rate and overdue rent.', ar: 'في الأعلى الأرقام الرئيسية: الإشغال والإيجار المتعاقد عليه ومتوسط المدة المتبقية للعقود والصفقات المفتوحة ونسبة الفوز والمتأخرات.' } },
      { point: 'section.card', has: { en: 'Occupancy by level', ar: 'نسبة الإشغال حسب المستوى' }, say: { en: 'Occupancy by level shows how full each floor is, by area.', ar: 'تعرض نسبة الإشغال حسب المستوى مدى امتلاء كل طابق بالمساحة.' } },
      { point: 'section.card', has: { en: 'Rent roll', ar: 'كشف الإيجارات' }, say: { en: 'The rent roll lists every lease with its rent, area and end date. Download it as a spreadsheet from its corner.', ar: 'يعرض كشف الإيجارات كل عقد بإيجاره ومساحته وتاريخ انتهائه، ويمكن تنزيله كجدول بيانات من زاويته.' } },
      { point: 'section.card', has: { en: 'Forecast', ar: 'التوقعات' }, say: { en: 'The forecast shows the rent expected in the months ahead from the leases already signed.', ar: 'تعرض التوقعات الإيجار المنتظر في الأشهر القادمة من العقود الموقّعة.' } },
      { point: 'section.card', has: { en: 'Why deals are lost', ar: 'أسباب خسارة الصفقات' }, say: { en: 'Why deals are lost counts the reasons given when a lead is closed as lost.', ar: 'وتحصي «أسباب خسارة الصفقات» الأسباب المسجلة عند إغلاق فرصة كخاسرة.' } },
      { point: 'section.card', has: { en: 'Receivables aging', ar: 'أعمار' }, say: { en: 'Receivables aging shows how old the unpaid invoices are, so the oldest are chased first.', ar: 'وتوضح «أعمار الديون» عمر الفواتير غير المسددة، لتُتابَع الأقدم أولًا.' } },
      { point: 'section.card', has: { en: 'Leases ending within a year', ar: 'عقود تنتهي خلال عام' }, say: { en: 'Leases ending within a year, so renewals start in good time.', ar: 'والعقود التي تنتهي خلال عام، ليبدأ التجديد في وقت مناسب.' } },
      { point: 'section.card:has(a[href="/admin/export/leads.csv"])', say: { en: 'Export the leads, units, rent roll or invoices for your own analysis.', ar: 'صدّر الفرص أو الوحدات أو كشف الإيجارات أو الفواتير لتحليلك الخاص.' } },
      { point: '.bar__actions button[data-print]', say: { en: 'Or print the whole page for a meeting.', ar: 'أو اطبع الصفحة كاملة لاجتماع.' } },
    ],
  },
  {
    id: 'insight-owner',
    area: 'insight',
    module: '/admin/owner-report',
    order: 20,
    roles: ['management'],
    title: { en: 'The owner\'s monthly report', ar: 'التقرير الشهري للمالك' },
    summary: {
      en: 'One page for the owners each month: the figures, highlights and risks, sent by email on the day you choose.',
      ar: 'صفحة واحدة للملاك كل شهر: الأرقام والإيجابيات والمخاطر، تُرسل بالبريد في اليوم الذي تختاره.',
    },
    steps: [
      { go: '/admin/owner-report', say: { en: 'The owner report sums up a month for the owners: billing, collections, occupancy, sales, visitors and parking.', ar: 'يلخّص تقرير المالك الشهر للملاك: الفواتير والتحصيل والإشغال والمبيعات والزوار والجراج.' } },
      { point: '.own-pick', say: { en: 'It opens on the last full month. Choose another month here.', ar: 'يُفتح على آخر شهر مكتمل، ويمكنك اختيار شهر آخر من هنا.' } },
      { point: '.kpis', say: { en: 'Each figure is compared with the month before.', ar: 'كل رقم مقارن بالشهر السابق.' } },
      { point: 'section.card', has: { en: 'Highlights and risks', ar: 'الإيجابيات والمخاطر' }, say: { en: 'Highlights and risks are written for you from the numbers. The same sentences open the report.', ar: 'تُكتب الإيجابيات والمخاطر تلقائيًا من الأرقام، وبالجمل نفسها يبدأ التقرير.' } },
      { type: ['form[action="/admin/owner-report/settings"] textarea[name=recipients]', 'board@thewavemall.com'], say: { en: 'Under Monthly email, enter who receives it.', ar: 'في «البريد الشهري»، أدخل من يستلم التقرير.' } },
      { select: ['form[action="/admin/owner-report/settings"] select[name=lang]', 'both'], say: { en: 'Choose the language, or both, and the day of the month it goes out.', ar: 'اختر اللغة، أو اللغتين معًا، واليوم الذي يُرسل فيه من كل شهر.' } },
      { click: 'form[action="/admin/owner-report/settings"] button.btn--primary', say: { en: 'Save. From now on it is sent by itself.', ar: 'احفظ، ومن الآن يُرسل التقرير تلقائيًا.' } },
      { point: 'form[action="/admin/owner-report/send"]', say: { en: 'Send now sends this month\'s report straight away.', ar: 'وزر «إرسال الآن» يرسل تقرير هذا الشهر فورًا.' } },
      { go: '/admin/owner-report/print', say: { en: 'And this is the report itself, ready to print or save as a document.', ar: 'وهذا هو التقرير نفسه، جاهز للطباعة أو الحفظ كمستند.' } },
      { point: 'button[data-print]', say: { en: 'Print it, or save it as a document to attach.', ar: 'اطبعه، أو احفظه كمستند لإرفاقه.' } },
    ],
  },
  {
    id: 'insight-wall',
    area: 'insight',
    module: '/admin/wallboard',
    order: 30,
    roles: ['management', 'operations'],
    title: { en: 'Putting the wall screen on a TV', ar: 'عرض شاشة الحائط على التلفاز' },
    summary: {
      en: 'Show the mall\'s live numbers on a TV in the office or control room, with a private link that needs no sign-in.',
      ar: 'اعرض أرقام المول المباشرة على تلفاز في المكتب أو غرفة التحكم، برابط خاص لا يحتاج إلى تسجيل دخول.',
    },
    steps: [
      { go: '/admin/wallboard', say: { en: 'The wall screen puts the mall\'s live numbers on a TV in the office or the control room.', ar: 'تعرض شاشة الحائط أرقام المول المباشرة على تلفاز في المكتب أو غرفة التحكم.' } },
      { point: 'section.card:has(a[href="/admin/wallboard/screen"])', say: { en: 'It turns through these panels: visitors, the car park, takings, work orders and cheques due.', ar: 'تتنقّل الشاشة بين هذه اللوحات: الزوار والجراج والتحصيل وأوامر العمل والشيكات المستحقة.' } },
      { click: 'form[action="/admin/wallboard/token"] button', say: { en: 'Create a link for the TV. It works without signing in, so use it only on a screen you trust.', ar: 'أنشئ رابطًا للتلفاز. يعمل دون تسجيل دخول، فاستخدمه فقط على شاشة تثق بها.' } },
      { point: 'section.card:has(form[action="/admin/wallboard/token"])', say: { en: 'Open this address in the TV\'s browser. Make a new link or switch it off at any time.', ar: 'افتح هذا العنوان في متصفح التلفاز، ويمكنك إنشاء رابط جديد أو إيقافه في أي وقت.' } },
      { select: ['form[action="/admin/wallboard/settings"] select[name=lang]', { en: 'English', ar: 'العربية' }], say: { en: 'Choose the screen\'s language and how long each panel stays.', ar: 'اختر لغة الشاشة ومدة بقاء كل لوحة.' } },
      { type: ['form[action="/admin/wallboard/settings"] input[name=rotate]', '20'] },
      { click: 'form[action="/admin/wallboard/settings"] button.btn--primary', say: { en: 'Save.', ar: 'احفظ.' } },
      { go: '/admin/wallboard/screen', say: { en: 'And this is the screen. It refreshes every thirty seconds by itself.', ar: 'وهذه هي الشاشة، وتتحدّث تلقائيًا كل ثلاثين ثانية.' } },
      { pause: 2500 },
    ],
  },
];
