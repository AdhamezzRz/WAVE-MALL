'use strict';

// Attendance & activity: the live board, one person's day, setting up the mall's circle and shifts,
// phones and PINs, timesheets and payroll, and clocking in on the staff phone app.

// the sample intern (EMP-0022) has no shift, PIN or phone: the staff-app lesson gives him a PIN and
// today's shift, and starts him on a fresh phone that has not seen the notice yet
const DEMO_CODE = 'EMP-0022';
const DEMO_PIN = '135790';

module.exports = [
  {
    id: 'attendance-board',
    area: 'people',
    module: '/admin/attendance',
    order: 60,
    roles: ['admin', 'management', 'operations'],
    title: { en: 'Who is at work right now', ar: 'من في العمل الآن' },
    summary: {
      en: 'Read the live board: who is in the mall, who is late or outside the circle, and what each person did last.',
      ar: 'اقرأ اللوحة المباشرة: من داخل المول، ومن تأخر أو خرج من الدائرة، وآخر ما فعله كل شخص.',
    },
    steps: [
      { go: '/admin/attendance', say: { en: 'Attendance & activity opens on the live board. It refreshes itself every thirty seconds.', ar: 'يُفتح «الحضور والنشاط» على اللوحة المباشرة، وهي تتحدث وحدها كل ثلاثين ثانية.' } },
      { point: '.att-chips', say: { en: 'The counters: in the mall, late, not in yet, on a break, outside the circle, app closed and on leave.', ar: 'العدادات: داخل المول، والمتأخرون، ومن لم يحضر بعد، وفي استراحة، وخارج الدائرة، والتطبيق مغلق، وفي إجازة.' } },
      { click: '.att-chip--late', nav: true, say: { en: 'Each counter is a filter. Late today shows only the people who came in late.', ar: 'كل عداد هو تصفية؛ «متأخرون اليوم» يعرض من حضر متأخرًا فقط.' } },
      { click: '.att-chip--all', nav: true, say: { en: 'Everyone brings the whole team back.', ar: 'واختر «الجميع» لتعود إلى الفريق كله.' } },
      { point: 'article.att-card--green', say: { en: 'A card per person: their shift, when they clocked in and how long they have worked so far.', ar: 'لكل شخص بطاقة: ورديته، ووقت حضوره، وكم عمل حتى الآن.' } },
      { point: 'article.att-card--green .att-card__loc', say: { en: 'Where their phone was at the last update: inside or outside the circle, and how far from the centre.', ar: 'وأين كان هاتفه عند آخر تحديث: داخل الدائرة أو خارجها، وعلى أي بعد من المركز.' } },
      { point: 'article.att-card--green .att-card__last', say: { en: 'Last activity is the latest thing they really did: clocking, a patrol scan, a work order or a page in the office.', ar: 'و«آخر نشاط» هو آخر ما قام به فعلًا: تسجيل حضور، أو مسح نقطة دورية، أو أمر عمل، أو صفحة في المكتب.' } },
      { point: 'article.att-card--green .att-av', say: { en: 'The light on the photo: green active in the last fifteen minutes, amber up to an hour, red longer.', ar: 'والضوء على الصورة: أخضر لنشاط خلال ربع ساعة، وكهرماني حتى ساعة، وأحمر لأكثر من ذلك.' } },
      { point: '.att-radarcard', say: { en: 'Who is where puts everyone clocked in on the mall\'s circle, north up and to true scale.', ar: 'و«من أين الآن» يضع كل من سجّل حضوره على دائرة المول، والشمال لأعلى وبالمقياس الحقيقي.' } },
      { point: 'section.card:has(.att-alerts)', say: { en: 'Alerts from the last two days: late starts, people who left the circle, forgotten clock-outs and new phones.', ar: 'وتنبيهات آخر يومين: التأخر عن بداية الوردية، ومن خرج من الدائرة، ومن نسي الانصراف، والهواتف الجديدة.' } },
    ],
  },
  {
    id: 'attendance-person',
    area: 'people',
    module: '/admin/attendance',
    also: ['/admin/attendance/people', '/admin/attendance/activity'],
    order: 61,
    roles: ['admin', 'management'],
    title: { en: 'One person\'s day, hour by hour', ar: 'يوم الموظف ساعة بساعة' },
    summary: {
      en: 'Open someone\'s day: their clocking and breaks, where they were, and everything they did, then follow the whole team\'s activity.',
      ar: 'افتح يوم أحد الموظفين: حضوره واستراحاته، وأين كان، وكل ما فعله، ثم تابع نشاط الفريق كله.',
    },
    steps: [
      { go: '/admin/attendance', say: { en: 'From the live board, open the person you want to look at.', ar: 'من اللوحة المباشرة، افتح الشخص الذي تريد متابعته.' } },
      { click: 'article.att-card--green .att-card__who a', nav: true, say: { en: 'Choose their name.', ar: 'اضغط على اسمه.' } },
      { point: '.att-hero__last', say: { en: 'At the top: their last activity, and how long ago it was.', ar: 'في الأعلى: آخر نشاط له، ومنذ متى كان.' } },
      { point: '.att-stats', say: { en: 'Today\'s figures: the shift, first in, last out, time worked against the schedule, breaks and overtime.', ar: 'وأرقام اليوم: الوردية، وأول حضور، وآخر انصراف، والوقت المعمول مقارنة بالجدول، والاستراحات والوقت الإضافي.' } },
      { point: '.att-tlcard', say: { en: 'The day, hour by hour: the shift, clocked time and breaks, inside or outside the circle, and every recorded action.', ar: '«اليوم ساعة بساعة»: الوردية، ووقت الحضور والاستراحات، وداخل الدائرة أو خارجها، وكل إجراء مسجّل.' } },
      { point: '.att-tl__rows', say: { en: 'Point at any bar or dot with the mouse to see exactly what happened and when.', ar: 'مرّر المؤشر على أي شريط أو نقطة لترى ما حدث بالضبط ومتى.' } },
      { point: 'table.att-punches', say: { en: 'Each clocking with its distance, precision and verdict. HR can add one or cancel a wrong one, with a note.', ar: 'كل تسجيل ببعده ودقته والحكم عليه، ويمكن للموارد البشرية إضافة تسجيل أو إلغاء الخاطئ مع ملاحظة.' } },
      { point: 'section.card:has(.att-feed)', say: { en: 'Everything they did, newest first. Filter it by date and source, and choose the order.', ar: 'كل ما فعله، الأحدث أولًا، ويمكنك تصفيته بالتاريخ والمصدر واختيار الترتيب.' } },
      { point: '.att-cal', say: { en: 'The month at a glance: each day coloured by how it went. Choose a day to open it.', ar: 'والشهر في لمحة: كل يوم ملوّن بحسب ما حدث فيه، واضغط على يوم لتفتحه.' } },
      { go: '/admin/attendance/activity', say: { en: 'Activity shows everything the whole team did, as it happens.', ar: 'وصفحة «النشاط» تعرض كل ما فعله الفريق كله أولًا بأول.' } },
      { point: 'form.filters', say: { en: 'Narrow it to one person, a department, a source or a range of dates.', ar: 'وضيّقها على شخص أو إدارة أو مصدر أو فترة من التواريخ.' } },
    ],
  },
  {
    id: 'attendance-setup',
    area: 'people',
    module: '/admin/attendance/settings',
    also: ['/admin/attendance/shifts'],
    order: 62,
    roles: ['admin'],
    title: { en: 'Setting the mall\'s circle and the shifts', ar: 'ضبط دائرة المول والورديات' },
    summary: {
      en: 'Put the mall\'s centre on the map, choose the circle and the precision, then set the shifts and who works them.',
      ar: 'حدّد مركز المول، واختر نصف قطر الدائرة والدقة المطلوبة، ثم اضبط الورديات ومن يعمل بها.',
    },
    steps: [
      { go: '/admin/attendance/settings', say: { en: 'Settings starts with the mall\'s circle. Nobody can clock in until its centre is set.', ar: 'تبدأ «الإعدادات» بدائرة المول، ولا يمكن لأحد تسجيل الحضور قبل تحديد مركزها.' } },
      { point: 'input[name=point]', say: { en: 'Paste the centre as two numbers, or a map link to the mall\'s pin.', ar: 'الصق المركز كرقمين، أو رابط الخريطة لموقع المول.' } },
      { point: 'button[data-att-here]', say: { en: 'Or stand in the middle of the mall with your phone and choose Use where I am standing.', ar: 'أو قف في منتصف المول بهاتفك واختر «استخدم مكان وقوفي».' } },
      { point: 'input[name=radius]', say: { en: 'The circle is a hundred metres by default. Make it bigger if far entrances fall outside.', ar: 'نصف قطر الدائرة مئة متر افتراضيًا، وكبّره إن كانت مداخل بعيدة خارجها.' } },
      { point: 'input[name=max_acc]', say: { en: 'Precision needed: a reading less precise than this is refused, so nobody clocks in on a vague signal.', ar: 'والدقة المطلوبة: تُرفض أي قراءة أقل دقة من هذا، فلا يسجّل أحد حضوره بإشارة غير واضحة.' } },
      { point: 'section.card:has(.att-radar)', say: { en: 'The preview shows the circle around the centre, to scale.', ar: 'والمعاينة تعرض الدائرة حول المركز بالمقياس الحقيقي.' } },
      { click: 'form:has(input[name=part][value=fence]) button.btn--primary', say: { en: 'Save.', ar: 'اضغط «حفظ».' } },
      { go: '/admin/attendance/shifts', say: { en: 'Shifts: when each group works, the grace minutes and the unpaid break.', ar: 'و«الورديات»: متى تعمل كل مجموعة، ودقائق السماح، والاستراحة غير المدفوعة.' } },
      { click: 'a.att-shift:has(.att-shift__time small)', nav: true, say: { en: 'A shift that ends after midnight counts for the day it started.', ar: 'الوردية التي تنتهي بعد منتصف الليل تُحسب لليوم الذي بدأت فيه.' } },
      { point: 'form[action$="/assign"] .att-pick', say: { en: 'Who works it: tick the people.', ar: 'ومن يعمل بها: حدّد الأشخاص.' } },
      { point: 'form[action$="/assign"] button.btn--primary', say: { en: 'Then assign them from a date. Their lateness and overtime follow this shift from then on.', ar: 'ثم عيّنهم من تاريخ محدد، ويُحسب تأخرهم ووقتهم الإضافي على هذه الوردية من بعده.' } },
    ],
  },
  {
    id: 'attendance-phones',
    area: 'people',
    module: '/admin/attendance/devices',
    also: ['/admin/attendance/exceptions'],
    order: 63,
    roles: ['admin'],
    title: { en: 'Phones, PINs and refused clocking', ar: 'الهواتف والأرقام السرية والتسجيلات المرفوضة' },
    summary: {
      en: 'Approve a new phone, give someone a PIN or unlock them, and see every refused or flagged clocking and why.',
      ar: 'وافق على هاتف جديد، وامنح أحدهم رقمًا سريًا أو افتح قفله، واطّلع على كل تسجيل مرفوض أو عليه ملاحظة وسببه.',
    },
    prepare: ({ db }) => {
      // someone typed a wrong PIN five times: locked for a while, so the lesson can unlock them
      const e = db.get("SELECT c.employee_id id FROM att_creds c JOIN employees e ON e.id = c.employee_id WHERE c.pin_hash IS NOT NULL AND e.status = 'active' ORDER BY e.code DESC LIMIT 1");
      if (e) db.run('UPDATE att_creds SET failed = 0, locked_until = ? WHERE employee_id = ?', new Date(Date.now() + 15 * 60000).toISOString(), e.id);
    },
    steps: [
      { go: '/admin/attendance/devices', say: { en: 'Each person clocks in from one registered phone, so nobody can clock in for someone else.', ar: 'يسجّل كل شخص حضوره من هاتف واحد مسجّل، فلا يستطيع أحد التسجيل نيابة عن غيره.' } },
      { point: 'section.card:has(form[action$="/approve"])', say: { en: 'A new phone waits here: who it is for, which phone, and when they tried.', ar: 'ينتظر الهاتف الجديد هنا: لمن، وأي هاتف، ومتى حاول الدخول.' } },
      { click: 'form[action$="/approve"] button', say: { en: 'Approve it if they really changed phones. The old phone stops working.', ar: 'وافق عليه إن كان قد غيّر هاتفه فعلًا، ويتوقف الهاتف القديم.' } },
      { point: 'form[action$="/unlock"] button', say: { en: 'Five wrong PINs lock the account for a while. Unlock frees it at once.', ar: 'خمسة أرقام سرية خاطئة تقفل الحساب لفترة، و«فتح القفل» يحرره فورًا.' } },
      { click: 'details:has(form[action$="/pin"]) > summary', say: { en: 'To give someone a PIN, open Set the PIN on their row.', ar: 'ولمنح أحدهم رقمًا سريًا، افتح «حفظ الرقم السري» في صفّه.' } },
      { point: 'details[open] form[action$="/pin"]', say: { en: 'Type six digits, or let the office make one. Tell it to them in person.', ar: 'اكتب ستة أرقام، أو دع المكتب ينشئ رقمًا، وأبلغه به شخصيًا.' } },
      { click: 'details[open] > summary', say: { en: 'Close it for now.', ar: 'وأغلقه الآن.' } },
      { go: '/admin/attendance/exceptions', say: { en: 'Exceptions lists every clocking that was refused or flagged.', ar: 'وتعرض «الاستثناءات» كل تسجيل رُفض أو عليه ملاحظة.' } },
      { point: 'table tbody tr', say: { en: 'Each row says why: outside the circle, a weak signal, an old reading, an unknown phone or a jump no one could make.', ar: 'ويذكر كل صف السبب: خارج الدائرة، أو إشارة ضعيفة، أو قراءة قديمة، أو هاتف غير معروف، أو قفزة مستحيلة في الموقع.' } },
      { point: 'form.filters', say: { en: 'Filter by refused or flagged, by person and by dates.', ar: 'ويمكنك التصفية بالمرفوض أو ذي الملاحظة، وبالشخص والتواريخ.' } },
    ],
  },
  {
    id: 'attendance-timesheets',
    area: 'people',
    module: '/admin/attendance/timesheets',
    also: ['/admin/attendance/payroll'],
    order: 64,
    roles: ['admin', 'management', 'finance'],
    title: { en: 'Timesheets and payroll', ar: 'كشوف الحضور والرواتب' },
    summary: {
      en: 'Read the month\'s timesheet, print one person\'s, and send overtime and absences to the draft payroll.',
      ar: 'اقرأ كشف حضور الشهر، واطبع كشف موظف، وأرسل الوقت الإضافي والغياب إلى مسودة الرواتب.',
    },
    steps: [
      { go: '/admin/attendance/timesheets', say: { en: 'Timesheets shows the month for everyone.', ar: 'تعرض «كشوف الحضور» الشهر للجميع.' } },
      { point: 'table thead', say: { en: 'Shift days, present, late, absent, leave, hours worked against the schedule, overtime and punctuality.', ar: 'أيام الوردية، والحضور، والتأخر، والغياب، والإجازات، والساعات المعمولة مقارنة بالجدول، والوقت الإضافي والالتزام بالمواعيد.' } },
      { point: 'form.filters', say: { en: 'Choose another month, a department, or the order.', ar: 'اختر شهرًا آخر، أو إدارة، أو الترتيب.' } },
      { point: '.bar__actions a[href*="timesheets.csv"]', say: { en: 'Export downloads the same figures as a spreadsheet.', ar: 'و«التصدير» ينزّل الأرقام نفسها في جدول بيانات.' } },
      { click: 'table tbody tr[data-href] a', nav: true, say: { en: 'Open someone to see their days.', ar: 'افتح أحد الموظفين لترى أيامه.' } },
      { point: 'a[href*="/timesheet?month="]', say: { en: 'Print the timesheet opens the month as a sheet to print and sign, in English or Arabic.', ar: 'و«طباعة كشف الحضور» يفتح كشف الشهر جاهزًا للطباعة والتوقيع، بالعربية أو الإنجليزية.' } },
      { go: '/admin/attendance/timesheets', say: { en: 'At the end of the month, send it to payroll.', ar: 'وفي نهاية الشهر، أرسله إلى الرواتب.' } },
      { click: '.bar__actions a[href^="/admin/attendance/payroll"]', nav: true, say: { en: 'Choose Send to payroll.', ar: 'اختر «إرسال إلى الرواتب».' } },
      { point: 'table', say: { en: 'First a preview: each person\'s overtime hours and pay, and absences that become unpaid days.', ar: 'أولًا معاينة: ساعات الوقت الإضافي لكل شخص وأجرها، والغياب الذي يتحول إلى أيام غير مدفوعة.' } },
      { point: 'form[action^="/admin/attendance/payroll"] button.btn--primary', say: { en: 'Apply changes only a draft payroll. Bonuses and deductions you typed stay as they are.', ar: 'و«تطبيق» يغيّر مسودة الرواتب فقط، وتبقى المكافآت والخصومات التي كتبتها كما هي.' } },
    ],
  },
  {
    id: 'attendance-staff-clock',
    area: 'people',
    module: '/admin/attendance',
    also: ['/admin/hr'],
    order: 65,
    roles: ['all'],
    title: { en: 'Clocking in on your phone', ar: 'تسجيل الحضور من هاتفك' },
    summary: {
      en: 'How staff sign in to the staff app, clock in inside the mall\'s circle, take a break and clock out.',
      ar: 'كيف يدخل الموظف إلى تطبيق الموظفين، ويسجّل حضوره داخل دائرة المول، ويأخذ استراحة، ويسجّل انصرافه.',
    },
    prepare: ({ db }) => {
      const e = db.get('SELECT * FROM employees WHERE code = ?', DEMO_CODE);
      if (!e) return;
      const now = new Date().toISOString();
      for (const t of ['att_logins', 'att_devices', 'att_punches', 'att_pings', 'att_alerts']) {
        try { db.run(`DELETE FROM ${t} WHERE employee_id = ?`, e.id); } catch { /* a table without employee_id */ }
      }
      // a PIN, and the notice not seen yet on this phone
      db.run('INSERT OR REPLACE INTO att_creds (employee_id, pin_hash, pin_set_at, failed, locked_until, consent_at, consent_version, demo) VALUES (?, ?, ?, 0, NULL, NULL, NULL, 1)', e.id, require('../../db').hashPassword(DEMO_PIN), now);
      // today's shift: a day shift that runs today (Cairo is a few hours ahead of the server's UTC at most)
      const cairo = new Date(Date.now() + 2 * 3600000);
      const dow = String(((cairo.getUTCDay() + 6) % 7) + 1);
      const shift = db.all('SELECT * FROM att_shifts WHERE active = 1 AND end_hm > start_hm ORDER BY start_hm').find((s) => String(s.days).includes(dow)) || db.get('SELECT * FROM att_shifts WHERE active = 1 ORDER BY id LIMIT 1');
      if (shift) {
        db.run('DELETE FROM att_assign WHERE employee_id = ?', e.id);
        db.run('INSERT INTO att_assign (employee_id, shift_id, starts, created_at, demo) VALUES (?, ?, ?, ?, 1)', e.id, shift.id, cairo.toISOString().slice(0, 10), now);
      }
      // the photo is optional; the video shows clocking without it
      db.setSetting('att_selfie', '0');
    },
    // the phone stands inside the circle, about 20 m north of the centre, with a good signal
    geo: ({ db }) => ({ latitude: Number(db.setting('att_lat') || 30.02624) + 20 / 111320, longitude: Number(db.setting('att_lng') || 31.46648), accuracy: 12 }),
    steps: [
      { go: '/staff/login', say: { en: 'Staff clock in with the staff app on their own phone. HR gives each person a code and a six-digit PIN.', ar: 'يسجّل الموظفون حضورهم بتطبيق الموظفين من هواتفهم، وتعطي الموارد البشرية كل شخص رمزًا ورقمًا سريًا من ستة أرقام.' } },
      { type: ['input[name=code]', DEMO_CODE], say: { en: 'Type your employee code.', ar: 'اكتب رمز الموظف.' } },
      { type: ['input[name=pin]', DEMO_PIN], say: { en: 'And your PIN.', ar: 'ثم الرقم السري.' } },
      { click: 'form[action="/staff/login"] button.btn--primary', nav: true, say: { en: 'Sign in. The first phone you sign in on becomes your phone.', ar: 'اضغط «تسجيل الدخول»، وأول هاتف تدخل منه يصبح هاتفك.' } },
      { point: '.att-consent__list', say: { en: 'The first time, it explains what is recorded: your position only when you clock and while you are clocked in.', ar: 'في المرة الأولى، يشرح ما يُسجَّل: موقعك فقط عند التسجيل وأثناء وجودك في العمل.' } },
      { click: 'form[action="/staff/consent"] button', nav: true, say: { en: 'Choose I understand and agree.', ar: 'اختر «فهمت وأوافق».' } },
      { point: '[data-where]', say: { en: 'The app finds you and shows how far you are from the mall. Inside the circle, the button wakes up.', ar: 'يحدد التطبيق موقعك ويعرض بعدك عن المول، وداخل الدائرة يصبح الزر جاهزًا.' } },
      { click: 'button.att-act--in', say: { en: 'Clock in. The office checks the distance, the signal and that this is your phone.', ar: 'اضغط «تسجيل الحضور»، ويتحقق المكتب من المسافة والإشارة ومن أن هذا هاتفك.' } },
      { wait: 'button.att-act--break_start' },
      { point: '.att-ring', say: { en: 'You are clocked in. Keep the app open while you work: it updates your position every few minutes.', ar: 'سُجّل حضورك. اترك التطبيق مفتوحًا أثناء العمل، فهو يحدّث موقعك كل بضع دقائق.' } },
      { click: 'button.att-act--break_start', say: { en: 'Going on a break? Start a break, and end it when you are back.', ar: 'ذاهب إلى استراحة؟ اضغط «بدء استراحة»، وأنهِها عند عودتك.' } },
      { wait: 'button.att-act--break_end' },
      { click: 'button.att-act--break_end', say: { en: 'End the break.', ar: 'اضغط «إنهاء الاستراحة».' } },
      { wait: 'button.att-act--out' },
      { point: 'button.att-act--out', say: { en: 'At the end of the shift, Clock out, inside the circle again.', ar: 'وفي نهاية الوردية، اضغط «تسجيل الانصراف» وأنت داخل الدائرة أيضًا.' } },
      { point: '.att-scard', say: { en: 'Today lists every clocking. My month and Fix a time are at the bottom, if you forgot one.', ar: 'ويعرض «اليوم» كل تسجيلاتك، وفي الأسفل «شهري» و«تصحيح وقت» إن نسيت تسجيلًا.' } },
    ],
  },
];
