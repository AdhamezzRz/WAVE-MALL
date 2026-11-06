'use strict';

// Operations, part A: maintenance (work orders) and parking (the booth, subscriptions, the floor).
// (lessons/operations.js holds the other operations lessons.)

// The parking booth lesson needs a car that has been inside for a few hours, and the cashier's till closed.
const BOOTH_PLATE = 'س ع د 2026';
function prepareBooth({ db, h }) {
  if (!h.parking) return;
  const admin = db.get("SELECT * FROM users WHERE email = 'admin@thewave.test'");
  const till = admin && h.parking.openTillOf(admin.id);
  if (till) h.parking.closeTill(till, { counted: null, user: admin });
  const key = h.parking.plateKey(BOOTH_PLATE);
  if (!db.get("SELECT id FROM pk_sessions WHERE plate_key = ? AND status = 'inside'", key)) {
    h.parking.entry({ lane: 'IN-1', plate: BOOTH_PLATE, at: new Date(Date.now() - (3 * 60 + 25) * 60000).toISOString(), force: true });
  }
}

module.exports = [
  // ---------------------------------------------------------------- maintenance
  {
    id: 'operations-workorder-new',
    area: 'operations',
    module: '/admin/maintenance',
    also: ['/admin/maintenance/orders', '/admin/maintenance/orders/new'],
    order: 10,
    roles: ['operations', 'all'],
    title: { en: 'Raising a work order', ar: 'إنشاء أمر عمل' },
    summary: {
      en: 'Report a fault as a work order with its priority, place and technician, so nothing gets forgotten.',
      ar: 'سجّل العطل كأمر عمل بأولويته ومكانه والفني المسؤول، حتى لا يُنسى شيء.',
    },
    steps: [
      { go: '/admin/maintenance', say: { en: 'Maintenance shows every open job in the mall, and which ones are late.', ar: 'تعرض «الصيانة» كل الأعمال المفتوحة في المول، والمتأخر منها.' } },
      { point: '.kpis', say: { en: 'Open work orders, how many are urgent, and how many are past their agreed time.', ar: 'أوامر العمل المفتوحة، وعدد العاجل منها، وعدد ما تجاوز المهلة المتفق عليها.' } },
      { point: '.card:has(a[href="/admin/maintenance/orders"])', say: { en: 'Most urgent lists what to do first: emergencies at the top.', ar: 'قائمة «الأكثر إلحاحًا» تعرض ما يجب البدء به، والطوارئ في الأعلى.' } },
      { click: '.bar__actions a[href="/admin/maintenance/orders/new"]', nav: true, say: { en: 'Choose New work order. Tenants\' requests from their portal arrive here by themselves.', ar: 'اختر «أمر عمل جديد». أما طلبات المستأجرين من بوابتهم فتصل هنا تلقائيًا.' } },
      { type: ['input[name=title]', { en: 'Water leak above the food court corridor', ar: 'تسريب مياه أعلى ممر ساحة المطاعم' }], say: { en: 'Say what is wrong, in a few words.', ar: 'اكتب المشكلة في كلمات قليلة.' } },
      { select: ['select[name=category]', 'plumbing'], say: { en: 'The trade: it decides who is told.', ar: 'نوع العمل، وهو الذي يحدد من يُبلَّغ.' } },
      { select: ['select[name=priority]', '2'], say: { en: 'The priority. Each one has its own time to respond and to fix.', ar: 'الأولوية، ولكل أولوية مهلة للاستجابة ومهلة للإصلاح.' } },
      { type: ['input[name=location]', { en: 'Level 1, by the cinema toilets', ar: 'الدور الأول، بجوار دورات مياه السينما' }], say: { en: 'Where it is: a unit, an asset, or a place in the common area.', ar: 'المكان: وحدة، أو معدّة، أو مكان في المناطق المشتركة.' } },
      { type: ['textarea[name=description]', { en: 'Dripping from a ceiling tile since 9 am. Bucket in place.', ar: 'تنقيط من بلاطة السقف منذ التاسعة صباحًا، ووُضع دلو مؤقتًا.' }], say: { en: 'What you saw and what was already done.', ar: 'ما رأيته وما تم عمله حتى الآن.' } },
      { select: ['select[name=assignee_id]', '11'], say: { en: 'Choose the technician now, or leave it for the supervisor.', ar: 'اختر الفني الآن، أو اتركه للمشرف.' } },
      { click: 'form[action="/admin/maintenance/orders"] button.btn--primary', nav: true, say: { en: 'Raise the work order. The technician is told at once, and the clocks start.', ar: 'اضغط «إنشاء أمر العمل». يُبلَّغ الفني فورًا، ويبدأ حساب المهلة.' } },
      { point: '.mnt-timers', say: { en: 'These two timers show the time left to respond and to fix.', ar: 'يعرض هذان المؤقتان الوقت المتبقي للاستجابة وللإصلاح.' } },
    ],
  },
  {
    id: 'operations-workorder-close',
    area: 'operations',
    module: '/admin/maintenance/orders',
    order: 20,
    roles: ['operations'],
    title: { en: 'Working a job to the end', ar: 'متابعة أمر العمل حتى الإنجاز' },
    summary: {
      en: 'Assign a work order, log the time and parts, and mark it resolved with a note.',
      ar: 'أسند أمر العمل، وسجّل الوقت وقطع الغيار، ثم أغلقه كمُنجَز مع ملاحظة.',
    },
    steps: [
      { go: '/admin/maintenance', say: { en: 'Start from the most urgent job.', ar: 'ابدأ بأكثر الأعمال إلحاحًا.' } },
      { click: '.card:has(a[href="/admin/maintenance/orders"]) .card__body a[href^="/admin/maintenance/orders/"]', nav: true, say: { en: 'Open it.', ar: 'افتحه.' } },
      { point: '.mnt-timers', say: { en: 'Red means the agreed time has passed. Managers are told when that happens.', ar: 'اللون الأحمر يعني أن المهلة المتفق عليها انتهت، ويُبلَّغ المديرون عند حدوث ذلك.' } },
      { click: 'details:has(form[action$="/assign"]) > summary', say: { en: 'Assign it to a technician, or to a contractor with a service contract.', ar: 'أسنده إلى فني، أو إلى مقاول لديه عقد صيانة.' } },
      { select: ['form[action$="/assign"] select[name=assignee_id]', '11'], say: { en: 'Choose who.', ar: 'اختر المسؤول.' } },
      { click: 'form[action$="/assign"] button.btn--primary', say: { en: 'Assign. They see it on their phone, in the office app.', ar: 'اضغط «إسناد»، فيظهر الأمر على هاتفه في تطبيق المكتب.' } },
      { click: 'details:has(form[action$="/time"]) > summary', say: { en: 'Log the time spent on the job.', ar: 'سجّل الوقت المستغرق في العمل.' } },
      { type: ['form[action$="/time"] input[name=hours]', '2'], say: { en: 'Two hours, for example.', ar: 'ساعتان، مثلًا.' } },
      { click: 'form[action$="/time"] button.btn--primary', say: { en: 'Log it.', ar: 'سجّله.' } },
      { point: 'a[href^="/admin/purchasing/stock?wo="]', say: { en: 'Parts taken from the store are issued here, and their cost is added to the job.', ar: 'تُصرف قطع الغيار من المخزن من هنا، وتُضاف تكلفتها إلى أمر العمل.' } },
      { select: ['form[action$="/status"] select[name=status]', 'resolved'], say: { en: 'When the work is done, set it to Resolved.', ar: 'عند انتهاء العمل، اجعل الحالة «تم الحل».' } },
      { type: ['form[action$="/status"] input[name=note]', { en: 'Step chain sensor realigned, tested for 30 minutes.', ar: 'تمت إعادة ضبط حساس السلسلة، واختباره لمدة ثلاثين دقيقة.' }], say: { en: 'Say what was done. The tenant who reported it sees this note.', ar: 'اكتب ما تم عمله، فهذه الملاحظة يراها المستأجر الذي أبلغ عن العطل.' } },
      { click: 'form[action$="/status"] button.btn--primary', say: { en: 'Update. The job is closed, with its full history, costs and times.', ar: 'اضغط «تحديث». يُغلق أمر العمل بسجله الكامل وتكاليفه وأوقاته.' } },
    ],
  },

  // ---------------------------------------------------------------- parking
  {
    id: 'operations-parking-booth',
    area: 'operations',
    module: '/admin/parking',
    also: ['/admin/parking/booth'],
    order: 30,
    roles: ['operations'],
    title: { en: 'Working the parking booth', ar: 'العمل في كابينة المحاسبة بالجراج' },
    summary: {
      en: 'Open your till, find a car by its ticket or plate, take the payment and let it out.',
      ar: 'افتح خزينتك، وابحث عن السيارة بالتذكرة أو باللوحة، وحصّل المبلغ واسمح لها بالخروج.',
    },
    prepare: prepareBooth,
    steps: [
      { go: '/admin/parking', say: { en: 'Parking shows the car park live: cars inside, free spaces and what happens at the gates.', ar: 'تعرض «المواقف» الجراج لحظة بلحظة: السيارات بالداخل، والأماكن الشاغرة، وما يحدث عند البوابات.' } },
      { click: '.bar__actions a[href="/admin/parking/booth"]', nav: true, say: { en: 'At the exit, cashiers work in the Booth. It is made for a tablet.', ar: 'عند المخرج، يعمل المحاسب من «كابينة المحاسبة»، وهي مصممة للأجهزة اللوحية.' } },
      { type: ['form[action="/admin/parking/till/open"] input[name=float]', '500'], say: { en: 'First open your till, with the cash you start with in the drawer.', ar: 'افتح خزينتك أولًا، بالمبلغ النقدي الموجود في الدرج عند البداية.' } },
      { click: 'form[action="/admin/parking/till/open"] button.btn--primary', say: { en: 'Every payment you take goes into your till.', ar: 'كل مبلغ تحصّله يدخل خزينتك.' } },
      { type: ['.pk-scan input[name=q]', BOOTH_PLATE], say: { en: 'Scan the ticket\'s code, tap the card, or type the plate.', ar: 'امسح رمز التذكرة، أو مرّر البطاقة، أو اكتب رقم اللوحة.' } },
      { click: '.pk-scan button.btn--primary', nav: true, say: { en: 'Find.', ar: 'بحث.' } },
      { point: '.pk-visit .pk-bill', say: { en: 'The car, when it came in, how long it stayed and the price. Shop validations are already taken off.', ar: 'السيارة، ووقت دخولها، ومدة بقائها، والمبلغ المستحق، بعد خصم أي اعتماد من المحلات.' } },
      { point: '.pk-pay', say: { en: 'Choose how they pay: cash, card, wallet or InstaPay.', ar: 'اختر طريقة الدفع: نقدًا أو بطاقة أو محفظة أو إنستاباي.' } },
      { click: '.pk-pay form button.btn--primary', say: { en: 'Cash. The receipt can be printed or sent by message.', ar: 'نقدًا. ويمكن طباعة الإيصال أو إرساله برسالة.' } },
      { click: 'form[action*="/exit"] button.btn--block', say: { en: 'Then open the barrier and close the visit.', ar: 'ثم افتح الحاجز وأنهِ الزيارة.' } },
      { say: { en: 'A lost ticket, or a guest of the mall? Those buttons are on the same screen, and every one is logged.', ar: 'تذكرة مفقودة أو ضيف للمول؟ تجد أزرارها في الشاشة نفسها، وكل إجراء يُسجَّل.' } },
    ],
  },
  {
    id: 'operations-parking-subscription',
    area: 'operations',
    module: '/admin/parking/subscriptions',
    also: ['/admin/parking/subscriptions/new'],
    order: 40,
    roles: ['operations', 'finance'],
    title: { en: 'Monthly parking subscriptions', ar: 'اشتراكات المواقف الشهرية' },
    summary: {
      en: 'Give a driver a monthly subscription so the gates open for their plate or card, and bill it every month.',
      ar: 'امنح السائق اشتراكًا شهريًا لتُفتح البوابات للوحته أو بطاقته، مع فاتورة شهرية.',
    },
    steps: [
      { go: '/admin/parking/subscriptions', say: { en: 'Subscriptions are for tenant staff, mall staff, VIPs and regular drivers.', ar: 'الاشتراكات مخصصة لموظفي المستأجرين وموظفي المول وكبار الزوار والسائقين الدائمين.' } },
      { click: 'a[href="/admin/parking/subscriptions/new"]', nav: true, say: { en: 'Choose New subscription.', ar: 'اختر «اشتراك جديد».' } },
      { select: ['select[name=plan_id]', '1'], say: { en: 'Choose the plan. The price comes with it.', ar: 'اختر الباقة، ويأتي السعر معها.' } },
      { select: ['select[name=holder]', 'tenant'], say: { en: 'Who it is for: here, a tenant\'s staff member.', ar: 'لمن الاشتراك: وهنا، موظف لدى أحد المستأجرين.' } },
      { select: ['select[name=brand_id]', '1'], say: { en: 'And which tenant. Their invoice can go to the brand.', ar: 'وأي مستأجر، ويمكن أن تصدر الفاتورة باسم العلامة.' } },
      { type: ['input[name=name]', { en: 'Hossam Adel', ar: 'حسام عادل' }], say: { en: 'The driver\'s name.', ar: 'اسم السائق.' } },
      { type: ['input[name=plates]', 'ق ص ر 1234'], say: { en: 'The plates. The camera at the gate reads them and opens by itself.', ar: 'أرقام اللوحات، وتقرأها كاميرا البوابة فتُفتح تلقائيًا.' } },
      { point: 'input[name=card_uid]', say: { en: 'Or give them a card: hold it on a phone to read its number.', ar: 'أو امنحه بطاقة: قرّبها من الهاتف لقراءة رقمها.' } },
      { point: 'input[name=auto_renew]', say: { en: 'Auto-renew keeps it going every month. An unpaid invoice suspends it.', ar: 'التجديد التلقائي يجدده كل شهر، والفاتورة غير المدفوعة توقفه.' } },
      { click: 'form[action="/admin/parking/subscriptions"] button.btn--primary', nav: true, say: { en: 'Create. The first invoice is issued, and the gates know the plate at once.', ar: 'اضغط «إنشاء». تصدر الفاتورة الأولى، وتتعرف البوابات على اللوحة فورًا.' } },
    ],
  },
  {
    id: 'operations-parking-floor',
    area: 'operations',
    module: '/admin/parking/floor',
    order: 50,
    level: 'advanced',
    roles: ['operations', 'management'],
    title: { en: 'The live floor map', ar: 'خريطة الجراج المباشرة' },
    summary: {
      en: 'See every bay on each level live, open a bay to see the car in it, and switch levels.',
      ar: 'شاهد كل مكان انتظار في كل دور لحظة بلحظة، وافتح أي مكان لترى السيارة فيه، وتنقّل بين الأدوار.',
    },
    steps: [
      { go: '/admin/parking/floor', say: { en: 'The floor map draws each level of the car park, and updates by itself.', ar: 'ترسم خريطة الجراج كل دور، وتتحدث تلقائيًا.' } },
      { point: '.kpis', say: { en: 'Taken, free, held for bookings and out of service.', ar: 'المشغول، والشاغر، والمحجوز للحجوزات، والخارج عن الخدمة.' } },
      { point: '.pkf-wrap', say: { en: 'Colours show each bay: free, taken, booked, reserved for VIPs, valet, electric cars and accessible bays.', ar: 'الألوان توضح حالة كل مكان: شاغر، أو مشغول، أو محجوز، أو مخصص لكبار الزوار أو للخدمة أو للسيارات الكهربائية أو لذوي الهمم.' } },
      { click: '.pkf-bay.s-taken:not(.is-est)', nav: true, say: { en: 'Click a bay to see what is there.', ar: 'اضغط على أي مكان لترى ما فيه.' } },
      { point: '.pkf-grid > .stack .card', say: { en: 'The car, how long it has been there, and actions: report a fine, or take the bay out of service.', ar: 'السيارة، ومدة بقائها، والإجراءات: تسجيل مخالفة، أو إخراج المكان من الخدمة.' } },
      { click: 'a.tab[href="/admin/parking/floor?level=B2"]', nav: true, say: { en: 'Switch to the level below.', ar: 'انتقل إلى الدور الأسفل.' } },
      { say: { en: 'Where there are no bay sensors, cars are placed nearest the lifts first, as drivers do.', ar: 'حيث لا توجد حساسات، تُوزَّع السيارات على الأماكن الأقرب إلى المصاعد أولًا، كما يفعل السائقون.' } },
    ],
  },
];
