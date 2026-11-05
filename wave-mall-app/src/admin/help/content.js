'use strict';

// The written side of Help & training: frequent questions, the glossary, what's new and the
// keyboard shortcuts. Every text is { en, ar }.

const FAQ = [
  { area: 'start', q: { en: 'I forgot my password. What do I do?', ar: 'نسيت كلمة المرور، ماذا أفعل؟' }, a: { en: 'Ask an administrator to send you a password link from Users & permissions. The link works once and expires; open it and choose a new password.', ar: 'اطلب من مسؤول النظام إرسال رابط كلمة مرور من صفحة المستخدمين والصلاحيات. يعمل الرابط مرة واحدة وتنتهي صلاحيته؛ افتحه واختر كلمة مرور جديدة.' } },
  { area: 'start', q: { en: 'Why can I not see a module my colleague sees?', ar: 'لماذا لا أرى قسمًا يراه زميلي؟' }, a: { en: 'Each person sees only the modules their role allows. If you need one, ask an administrator: they can change your role or give you access, also for a limited time.', ar: 'يرى كل شخص الأقسام التي يسمح بها دوره فقط. إن احتجت قسمًا فاطلب من مسؤول النظام: يمكنه تغيير دورك أو منحك صلاحية، حتى لفترة محددة.' } },
  { area: 'start', q: { en: 'Can I use the office on my phone?', ar: 'هل يمكنني استخدام المكتب على هاتفي؟' }, a: { en: 'Yes. Open the office in your phone browser and choose "Add to home screen". It opens full screen like an app, with a tab bar for the dashboard, pipeline, calendar, search and the full menu.', ar: 'نعم. افتح المكتب من متصفح الهاتف واختر «إضافة إلى الشاشة الرئيسية». سيفتح بملء الشاشة كتطبيق، مع شريط تبويب للوحة التحكم ومسار الصفقات والتقويم والبحث والقائمة الكاملة.' } },
  { area: 'start', q: { en: 'How do I switch between Arabic and English?', ar: 'كيف أبدّل بين العربية والإنجليزية؟' }, a: { en: 'Use the language button in the top bar. The office remembers your choice; documents such as invoices and proposals can also be printed in either language from their own switch.', ar: 'استخدم زر اللغة في الشريط العلوي، وسيتذكر المكتب اختيارك. ويمكن أيضًا طباعة المستندات مثل الفواتير والعروض بأي لغة من زر التبديل الخاص بها.' } },
  { area: 'sales', q: { en: 'An offer is below the allowed discount. What happens?', ar: 'العرض أقل من الخصم المسموح به، ماذا يحدث؟' }, a: { en: 'It waits for a manager to approve it before it can be sent. Managers see it in Offers and on the dashboard under "Needs attention".', ar: 'ينتظر موافقة مدير قبل إرساله. ويراه المديرون في صفحة العروض وعلى لوحة التحكم تحت «يحتاج إلى متابعة».' } },
  { area: 'overview', q: { en: 'Where do I approve requests?', ar: 'أين أوافق على الطلبات؟' }, a: { en: 'In Approvals & tasks. "My day" lists everything waiting for your decision; open a request to approve, reject or ask for more information. On a phone the buttons are large and come first.', ar: 'في صفحة الموافقات والمهام. تعرض «يومي» كل ما ينتظر قرارك؛ افتح الطلب لتوافق أو ترفض أو تطلب معلومات إضافية. وعلى الهاتف تظهر الأزرار كبيرة في الأعلى.' } },
  { area: 'overview', q: { en: 'I am going on leave. Who decides my approvals?', ar: 'سأحصل على إجازة، فمن يقرر الموافقات المطلوبة مني؟' }, a: { en: 'Open Approvals & tasks, choose "Away" and pick a colleague and the dates. While you are away they decide your approvals and see your tasks; the history shows they acted for you.', ar: 'افتح الموافقات والمهام واختر «الغياب»، ثم حدد زميلًا والتواريخ. أثناء غيابك يقرر موافقاتك ويرى مهامك، ويُسجَّل في السجل أنه تصرف نيابةً عنك.' } },
  { area: 'revenue', q: { en: 'A tenant paid by cheque. How do I record it?', ar: 'دفع مستأجر بشيك، كيف أسجله؟' }, a: { en: 'Receive the cheque in Cheques against the open invoices. When you deposit it and it is collected, the invoices are paid automatically, oldest first. A bounced cheque reverses the payment and the tenant is told.', ar: 'سجّل استلام الشيك في صفحة الشيكات مقابل الفواتير المفتوحة. عند إيداعه وتحصيله تُسدَّد الفواتير تلقائيًا بدءًا من الأقدم. وإذا ارتد الشيك يُعكس السداد ويُبلَّغ المستأجر.' } },
  { area: 'revenue', q: { en: 'How are late payment reminders sent?', ar: 'كيف تُرسل تذكيرات التأخر في السداد؟' }, a: { en: 'Collections sends reminders on a schedule before and after each due date, by portal notice, email and WhatsApp, and never the same step twice. You can change the schedule and the late charges in Collections → Settings.', ar: 'يرسل قسم التحصيل التذكيرات وفق جدول قبل كل تاريخ استحقاق وبعده، عبر إشعار البوابة والبريد الإلكتروني وواتساب، دون تكرار نفس الخطوة. ويمكنك تعديل الجدول وغرامات التأخير من التحصيل ← الإعدادات.' } },
  { area: 'office', q: { en: 'Is my data backed up?', ar: 'هل توجد نسخة احتياطية من بياناتي؟' }, a: { en: 'Every night a checked copy of the database is kept on the server, and it can also be emailed or sent to off-site storage. Administrators see the last backup and can take one now in Settings.', ar: 'كل ليلة تُحفظ نسخة مفحوصة من قاعدة البيانات على الخادم، ويمكن أيضًا إرسالها بالبريد أو إلى تخزين خارجي. ويرى مسؤولو النظام آخر نسخة ويمكنهم أخذ نسخة فورًا من الإعدادات.' } },
  { area: 'office', q: { en: 'Something does not work. How do I get help?', ar: 'هناك شيء لا يعمل، كيف أحصل على المساعدة؟' }, a: { en: 'Use "Contact support" in Help & training. The page you were on and your browser are filled in for you, and you can add a screenshot. You will see the reply in Help & training and by email.', ar: 'استخدم «تواصل مع الدعم» في المساعدة والتدريب. تُملأ الصفحة التي كنت عليها ونوع متصفحك تلقائيًا، ويمكنك إضافة لقطة شاشة. وسترى الرد في المساعدة والتدريب وعبر البريد الإلكتروني.' } },
  { area: 'portal', q: { en: 'How does a tenant get into the portal?', ar: 'كيف يدخل المستأجر إلى البوابة؟' }, a: { en: 'From the tenant file, invite the tenant\'s contact to the portal. They receive a link to set their password and can then see invoices, pay online, report sales and open maintenance requests.', ar: 'من ملف المستأجر، ادعُ جهة اتصاله إلى البوابة. يصله رابط لتعيين كلمة المرور، ثم يمكنه رؤية الفواتير والدفع إلكترونيًا والإبلاغ عن المبيعات وفتح طلبات الصيانة.' } },
];

const GLOSSARY = [
  { term: { en: 'GLA (gross leasable area)', ar: 'المساحة الإجمالية القابلة للتأجير' }, def: { en: 'The total floor area of the units that can be let to tenants, in square metres. Occupancy and cost per m² are measured against it.', ar: 'إجمالي مساحة الوحدات التي يمكن تأجيرها بالمتر المربع، وتُقاس عليها نسبة الإشغال والتكلفة لكل متر.' } },
  { term: { en: 'Occupancy', ar: 'نسبة الإشغال' }, def: { en: 'The share of the leasable area under an active lease. "Committed" also counts reserved units and signed leases that have not started.', ar: 'نسبة المساحة القابلة للتأجير المؤجَّرة بعقود سارية. و«المتعاقد عليه» يشمل أيضًا الوحدات المحجوزة والعقود الموقعة التي لم تبدأ بعد.' } },
  { term: { en: 'WALE', ar: 'متوسط مدة العقود المتبقية (WALE)' }, def: { en: 'Weighted average lease expiry: how many years the leases have left, weighted by their rent. A longer WALE means steadier income.', ar: 'المتوسط المرجّح للمدة المتبقية من العقود بالسنوات، مرجّحًا بقيمة الإيجار. وكلما طال كان الدخل أكثر استقرارًا.' } },
  { term: { en: 'Escalation', ar: 'الزيادة السنوية' }, def: { en: 'The yearly increase of the rent, for example 10% a year, or stepped: 10% for years 2 to 5 and 12.5% after.', ar: 'نسبة زيادة الإيجار كل سنة، مثل 10% سنويًا، أو بشكل متدرج: 10% من السنة الثانية إلى الخامسة ثم 12.5% بعدها.' } },
  { term: { en: 'Rent-free period', ar: 'فترة السماح من الإيجار' }, def: { en: 'Months at the start of a lease when the tenant pays no rent, usually to fit out the unit.', ar: 'أشهر في بداية العقد لا يدفع فيها المستأجر إيجارًا، غالبًا لتجهيز الوحدة.' } },
  { term: { en: 'Key money', ar: 'مقدّم التعاقد (خلو الرجل)' }, def: { en: 'A one-off amount the tenant pays to secure a unit, on top of the rent and deposit.', ar: 'مبلغ يُدفع مرة واحدة لضمان الوحدة، بالإضافة إلى الإيجار والتأمين.' } },
  { term: { en: 'Service charge', ar: 'رسوم الخدمات' }, def: { en: 'What tenants pay towards running the mall: cleaning, security, common-area power and maintenance. Charged per m² or as a share of the rent, and reconciled with the actual costs at year end.', ar: 'ما يدفعه المستأجرون مقابل تشغيل المول: النظافة والأمن وكهرباء المناطق المشتركة والصيانة. تُحسب بالمتر المربع أو كنسبة من الإيجار، وتُسوّى مع التكاليف الفعلية في نهاية السنة.' } },
  { term: { en: 'Turnover rent', ar: 'إيجار نسبة المبيعات' }, def: { en: 'Rent based on a share of the tenant\'s sales, either on top of the base rent or instead of it, sometimes with a minimum guarantee: the tenant pays the higher of the two.', ar: 'إيجار يُحسب كنسبة من مبيعات المستأجر، إما فوق الإيجار الأساسي أو بدلًا منه، وأحيانًا مع حد أدنى مضمون يدفع فيه المستأجر القيمة الأعلى منهما.' } },
  { term: { en: 'Aging', ar: 'أعمار الديون' }, def: { en: 'Unpaid invoices grouped by how late they are: current, 1–30 days, 31–60, 61–90 and over 90 days.', ar: 'الفواتير غير المدفوعة مصنفة حسب مدة تأخرها: غير مستحقة، ومن 1 إلى 30 يومًا، و31–60، و61–90، وأكثر من 90 يومًا.' } },
  { term: { en: 'DSO (days sales outstanding)', ar: 'متوسط فترة التحصيل' }, def: { en: 'On average, how many days it takes to collect what is billed. Lower is better.', ar: 'متوسط عدد الأيام اللازمة لتحصيل ما يُفوتَر. وكلما قل كان أفضل.' } },
  { term: { en: 'Weighted pipeline', ar: 'قيمة المسار المرجّحة' }, def: { en: 'The yearly rent of the open deals multiplied by the chance of each stage closing: a realistic view of what the pipeline may bring.', ar: 'الإيجار السنوي للصفقات المفتوحة مضروبًا في احتمال إغلاق كل مرحلة، وهي صورة واقعية لما قد يحققه المسار.' } },
  { term: { en: 'Addendum', ar: 'ملحق العقد' }, def: { en: 'A numbered change to a signed lease, such as new rent from a date, extra units or a longer term. Only future unpaid invoices are reissued.', ar: 'تعديل مرقّم على عقد موقع، مثل إيجار جديد من تاريخ معين أو وحدات إضافية أو مدة أطول. ولا يُعاد إصدار إلا الفواتير المستقبلية غير المدفوعة.' } },
  { term: { en: 'Write-off', ar: 'إعدام الدين' }, def: { en: 'Recording an amount a tenant owes as lost. It goes through approvals when a rule requires it.', ar: 'تسجيل مبلغ مستحق على مستأجر كدين معدوم، ويمر عبر الموافقات عندما تتطلب القاعدة ذلك.' } },
  { term: { en: 'SLA', ar: 'زمن الاستجابة المتفق عليه' }, def: { en: 'The time allowed to respond to or finish something, such as a maintenance request or an approval. Late items are flagged and escalated.', ar: 'الوقت المسموح للاستجابة لأمر ما أو إنجازه، مثل طلب صيانة أو موافقة. وتُميَّز العناصر المتأخرة وتُصعَّد.' } },
  { term: { en: 'Two-person rule', ar: 'قاعدة الشخصين' }, def: { en: 'Sensitive access changes, such as making someone an administrator, need a second person\'s approval before they apply.', ar: 'تغييرات الصلاحيات الحساسة، مثل جعل شخص مسؤولًا للنظام، تحتاج إلى موافقة شخص ثانٍ قبل تطبيقها.' } },
];

const NEWS = [
  {
    date: '2026-11-05',
    title: { en: 'Help & training', ar: 'المساعدة والتدريب' },
    items: [
      { en: 'Video lessons for the office, in English and Arabic, with the transcript under every video.', ar: 'دروس بالفيديو للمكتب بالإنجليزية والعربية، مع النص المكتوب أسفل كل فيديو.' },
      { en: '"Show me on the real page": a guided tour that points at each step on the live screen.', ar: '«أرني على الصفحة الفعلية»: جولة إرشادية تشير إلى كل خطوة على الشاشة الحقيقية.' },
      { en: 'Learning paths by role, progress tracking, and a training report for managers.', ar: 'مسارات تعلّم حسب الدور، ومتابعة التقدم، وتقرير تدريب للمديرين.' },
      { en: 'Contact support from any page, with the page and a screenshot attached.', ar: 'التواصل مع الدعم من أي صفحة، مع إرفاق الصفحة ولقطة شاشة.' },
    ],
    link: '/admin/help',
  },
  {
    date: '2026-11-04',
    title: { en: 'Approvals & tasks, users & permissions', ar: 'الموافقات والمهام، والمستخدمون والصلاحيات' },
    items: [
      { en: 'A work hub where approvals behave like tasks: deadlines, reminders, escalation, stand-ins while someone is away.', ar: 'مركز عمل تعمل فيه الموافقات كالمهام: مواعيد نهائية وتذكيرات وتصعيد ومن ينوب أثناء الغياب.' },
      { en: 'Roles with a permission grid, invitations, temporary access and a full history of changes.', ar: 'أدوار مع جدول صلاحيات، ودعوات، وصلاحيات مؤقتة، وسجل كامل للتغييرات.' },
    ],
    link: '/admin/work',
  },
  {
    date: '2026-11-03',
    title: { en: 'Twelve new modules', ar: 'اثنا عشر قسمًا جديدًا' },
    items: [
      { en: 'Collections, lease addenda and renewals, purchasing and the parts store, advertising sales.', ar: 'التحصيل، وملاحق العقود والتجديد، والمشتريات والمخزن، ومبيعات الإعلانات.' },
      { en: 'Security & cleaning, safety & licences, shopper feedback, energy & ESG.', ar: 'الأمن والنظافة، والسلامة والتراخيص، وآراء الزوار، والطاقة والاستدامة.' },
      { en: 'The owner monthly report, the wall screen and automatic daily backups.', ar: 'تقرير المالك الشهري، وشاشة العرض، والنسخ الاحتياطي اليومي التلقائي.' },
    ],
    link: '/admin',
  },
];

const SHORTCUTS = [
  { group: { en: 'Anywhere in the office', ar: 'في أي مكان في المكتب' }, keys: [
    { k: 'Ctrl K / ⌘ K', what: { en: 'Search leads, brands, units, offers and leases', ar: 'البحث في الفرص والعلامات والوحدات والعروض والعقود' } },
    { k: 'Esc', what: { en: 'Close search or a dialog', ar: 'إغلاق البحث أو النافذة' } },
  ] },
  { group: { en: 'Watching a lesson', ar: 'أثناء مشاهدة درس' }, keys: [
    { k: 'Space / K', what: { en: 'Play or pause', ar: 'تشغيل أو إيقاف مؤقت' } },
    { k: '← / J', what: { en: 'Back 5 seconds', ar: 'رجوع 5 ثوانٍ' } },
    { k: '→ / L', what: { en: 'Forward 5 seconds', ar: 'تقديم 5 ثوانٍ' } },
    { k: ', / .', what: { en: 'Previous or next step', ar: 'الخطوة السابقة أو التالية' } },
    { k: 'C', what: { en: 'Captions on or off', ar: 'تشغيل الترجمة أو إيقافها' } },
    { k: 'R', what: { en: 'Read aloud on or off', ar: 'تشغيل القراءة الصوتية أو إيقافها' } },
    { k: 'F', what: { en: 'Full screen', ar: 'ملء الشاشة' } },
    { k: '< / >', what: { en: 'Slower or faster', ar: 'أبطأ أو أسرع' } },
  ] },
  { group: { en: 'Guided tour on the real page', ar: 'الجولة الإرشادية على الصفحة الفعلية' }, keys: [
    { k: '→ / Enter', what: { en: 'Next step', ar: 'الخطوة التالية' } },
    { k: '←', what: { en: 'Previous step', ar: 'الخطوة السابقة' } },
    { k: 'Esc', what: { en: 'End the tour', ar: 'إنهاء الجولة' } },
  ] },
];

module.exports = { FAQ, GLOSSARY, NEWS, SHORTCUTS };
