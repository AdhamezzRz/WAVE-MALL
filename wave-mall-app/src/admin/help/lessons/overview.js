'use strict';

// The dashboard and daily work: the dashboard, approvals and tasks.

module.exports = [
  {
    id: 'overview-dashboard',
    area: 'overview',
    module: '/admin',
    order: 10,
    roles: ['all', 'management'],
    title: { en: 'Reading the dashboard', ar: 'قراءة لوحة التحكم' },
    summary: {
      en: 'Occupancy, the pipeline, overdue rent, the plan of the mall and what needs your attention, at a glance.',
      ar: 'نسبة الإشغال ومسار الصفقات والإيجارات المتأخرة ومخطط المول وما يحتاج إلى متابعتك، في نظرة واحدة.',
    },
    steps: [
      { go: '/admin', say: { en: 'The dashboard is the first page you see. It always shows today\'s numbers.', ar: 'لوحة التحكم هي أول صفحة تراها، وتعرض دائمًا أرقام اليوم.' } },
      { point: 'a.kpi[href="/admin/units"]', say: { en: 'Occupancy is the share of the leasable area under an active lease. Click it to open the units and the plan.', ar: 'نسبة الإشغال هي حصة المساحة القابلة للتأجير المؤجَّرة بعقود سارية. اضغط عليها لفتح الوحدات والمخطط.' } },
      { point: 'a.kpi[href="/admin/pipeline"]', say: { en: 'The weighted pipeline is the yearly rent of the open deals, weighted by how likely each stage is to sign.', ar: 'قيمة المسار المرجّحة هي الإيجار السنوي للصفقات المفتوحة، مرجّحًا باحتمال توقيع كل مرحلة.' } },
      { point: 'a.kpi[href="/admin/billing"]', say: { en: 'Overdue rent turns red when invoices are past due. It also shows how much was collected this month.', ar: 'تتحول الإيجارات المتأخرة إلى اللون الأحمر عند تجاوز الفواتير موعدها، وتعرض أيضًا ما تم تحصيله هذا الشهر.' } },
      { point: '.card:has(.funnel__row)', say: { en: 'The pipeline shows how many deals are in each stage and their value. Each row opens those leads.', ar: 'يعرض مسار الصفقات عدد الصفقات في كل مرحلة وقيمتها، وكل صف يفتح تلك الفرص.' } },
      { point: '.card:has(.plan-wrap)', say: { en: 'The plan draws the plaza level coloured by status: available, on hold, reserved or leased.', ar: 'يرسم المخطط مستوى الساحة ملوّنًا حسب الحالة: متاحة أو محجوزة مؤقتًا أو محجوزة أو مؤجَّرة.' } },
      { point: '.card:has(a[href="/admin/billing?status=overdue"])', say: { en: 'Needs attention lists what to act on today: approvals, holds that end, overdue invoices, expiring documents.', ar: 'قائمة «يحتاج إلى متابعة» تعرض ما يجب التعامل معه اليوم: الموافقات، والحجوزات المنتهية، والفواتير المتأخرة، والمستندات التي تنتهي.' } },
      { point: '.card.span-3', say: { en: 'And the latest activity shows who did what, in your language.', ar: 'وتعرض أحدث النشاطات من فعل ماذا، بلغتك.' } },
    ],
  },
  {
    id: 'overview-approve',
    area: 'overview',
    module: '/admin/work',
    also: ['/admin/approvals'],
    order: 20,
    roles: ['management', 'finance', 'all'],
    title: { en: 'Deciding an approval', ar: 'اتخاذ قرار في طلب موافقة' },
    summary: {
      en: 'Find what waits for your decision, read the request, and approve, reject or ask for more information.',
      ar: 'اعثر على ما ينتظر قرارك، واقرأ الطلب، ثم وافق أو ارفض أو اطلب معلومات إضافية.',
    },
    steps: [
      { go: '/admin/work', say: { en: 'Approvals & tasks opens on My day: everything on your plate in one place.', ar: 'تُفتح الموافقات والمهام على «يومي»: كل ما يخصك في مكان واحد.' } },
      { point: '#wk-decide', say: { en: 'Requests waiting for your decision come first, the most urgent at the top. Overdue ones are marked in red.', ar: 'تأتي الطلبات التي تنتظر قرارك أولًا، والأكثر إلحاحًا في الأعلى، والمتأخرة مميزة باللون الأحمر.' } },
      { click: '#wk-decide .wk-dl__main', nav: true, say: { en: 'Open a request to see the details, the amount and who asked.', ar: 'افتح الطلب لترى التفاصيل والمبلغ ومن قدّمه.' } },
      { point: '.apr-decide', say: { en: 'Your decision is here. On a phone these buttons are large and come first.', ar: 'قرارك هنا، وعلى الهاتف تظهر هذه الأزرار كبيرة وفي الأعلى.' } },
      { type: ['.apr-decide textarea[name=note]', { en: 'Approved within this month\'s budget.', ar: 'موافق ضمن ميزانية هذا الشهر.' }], say: { en: 'Add a note. A note is required to reject or to ask a question.', ar: 'أضف ملاحظة، فهي مطلوبة عند الرفض أو طرح سؤال.' } },
      { point: '.apr-decide .wk-ask', say: { en: 'Not sure? Ask for more information: the request goes back to the person who asked, and the deadline clock pauses.', ar: 'لست متأكدًا؟ اطلب معلومات إضافية: يعود الطلب إلى مقدّمه ويتوقف حساب الموعد النهائي.' } },
      { click: '.apr-decide .apr-yes', say: { en: 'Approve. The person who asked is told at once, and the next step, if any, goes to its approver.', ar: 'اضغط موافقة. يُبلَّغ مقدّم الطلب فورًا، وتنتقل الخطوة التالية، إن وُجدت، إلى المسؤول عنها.' } },
      { say: { en: 'Every decision, comment and reminder stays in the request\'s history.', ar: 'يبقى كل قرار وتعليق وتذكير في سجل الطلب.' } },
    ],
  },
  {
    id: 'overview-task',
    area: 'overview',
    module: '/admin/work',
    order: 30,
    roles: ['all'],
    title: { en: 'Giving someone a task', ar: 'إسناد مهمة إلى زميل' },
    summary: {
      en: 'Create a task with a priority, an assignee, labels and a mention, and follow it on the board.',
      ar: 'أنشئ مهمة بأولوية ومسؤول ووسوم وإشارة إلى زميل، وتابعها على اللوحة.',
    },
    steps: [
      { go: '/admin/work', say: { en: 'Tasks live next to approvals, in Approvals & tasks.', ar: 'توجد المهام بجانب الموافقات، في الموافقات والمهام.' } },
      { point: '.wk-quick', say: { en: 'For a quick note to yourself, type here and press Enter.', ar: 'لملاحظة سريعة لنفسك، اكتبها هنا واضغط مفتاح الإدخال.' } },
      { click: '.bar__actions a[href="/admin/work/tasks/new"]', nav: true, say: { en: 'For a full task, choose New task.', ar: 'لمهمة كاملة، اختر «مهمة جديدة».' } },
      { type: ['.wk-form input[name=title]', { en: 'Prepare the handover pack for Kahwa House', ar: 'تجهيز ملف التسليم لكهوة هاوس' }], say: { en: 'Give it a clear title.', ar: 'اكتب لها عنوانًا واضحًا.' } },
      { type: ['.wk-form textarea[name=body]', { en: 'Floor plans and the fit-out guide. @Salma can you check the drawings?', ar: 'المخططات ودليل التجهيز. @Salma هل يمكنك مراجعة الرسومات؟' }], say: { en: 'Type @ and a name to mention a colleague: they are told by email and in their inbox.', ar: 'اكتب @ ثم الاسم للإشارة إلى زميل، فيصله إشعار بالبريد وفي صندوقه.' } },
      { select: ['.wk-form select[name=priority]', 'high'], say: { en: 'Set the priority.', ar: 'حدد الأولوية.' } },
      { type: ['.wk-form input[name=labels]', { en: 'fit-out, tenants', ar: 'تجهيز، مستأجرون' }], say: { en: 'Labels help you filter the board later.', ar: 'تساعدك الوسوم على تصفية اللوحة لاحقًا.' } },
      { click: '.wk-form label.wk-pick-p', has: 'Karim Mostafa', say: { en: 'Choose who does it. You can pick several people, and add watchers who are kept informed.', ar: 'اختر من سينفذها. يمكنك اختيار أكثر من شخص، وإضافة متابعين يُبلَّغون بالمستجدات.' } },
      { click: '.wk-form button.btn--primary', nav: true, say: { en: 'Create the task.', ar: 'أنشئ المهمة.' } },
      { say: { en: 'The task has its own page: a checklist, files, comments and a timeline of everything that happens.', ar: 'للمهمة صفحة خاصة بها: قائمة تحقق وملفات وتعليقات وسجل زمني لكل ما يحدث.' } },
      { go: '/admin/work/board', say: { en: 'On the board, drag cards between To do, In progress, Waiting and Done.', ar: 'على اللوحة، اسحب البطاقات بين «للتنفيذ» و«قيد التنفيذ» و«بانتظار» و«تم».' } },
    ],
  },
  {
    id: 'overview-board',
    area: 'overview',
    module: '/admin/work/board',
    also: ['/admin/work/list', '/admin/work/calendar', '/admin/work/team'],
    order: 40,
    roles: ['all'],
    title: { en: 'Working with the board', ar: 'العمل على لوحة المهام' },
    summary: {
      en: 'See tasks and approvals as cards by stage, move them along, and switch to the list, calendar and team views.',
      ar: 'اعرض المهام والموافقات كبطاقات حسب المرحلة، وانقلها بين المراحل، وانتقل إلى عرض القائمة والتقويم والفريق.',
    },
    steps: [
      { go: '/admin/work/board', say: { en: 'The board shows tasks and approvals as cards, one column per stage.', ar: 'تعرض اللوحة المهام والموافقات كبطاقات، عمود لكل مرحلة.' } },
      { point: '.wk-filters', say: { en: 'Filter by what to show, whose work it is, the priority or a label.', ar: 'صفِّ حسب ما تريد عرضه، وصاحب العمل، والأولوية، أو الوسم.' } },
      { point: 'section.wk-lane--todo', say: { en: 'Each card shows its reference, the amount or due date, and who has it. Overdue cards are marked in red.', ar: 'تعرض كل بطاقة رقمها والمبلغ أو موعد التسليم ومن يتولاها، والمتأخرة مميزة باللون الأحمر.' } },
      { click: 'details.wk-move > summary', say: { en: 'Drag a task to another column, or use the menu on its card.', ar: 'اسحب المهمة إلى عمود آخر، أو استخدم القائمة على بطاقتها.' } },
      { click: 'details.wk-move[open] button[value=doing]', say: { en: 'Move it to In progress. Everyone following the task sees the change.', ar: 'انقلها إلى «قيد التنفيذ»، فيرى التغيير كل من يتابع المهمة.' } },
      { say: { en: 'Approvals move by themselves as they are decided: open one to decide it.', ar: 'أما الموافقات فتنتقل وحدها عند البت فيها، افتح الطلب لتتخذ القرار.' } },
      { click: 'a.tab[href="/admin/work/list"]', nav: true, say: { en: 'List shows the same work as a table, with filters by state, due date, label and dates.', ar: 'تعرض «القائمة» العمل نفسه كجدول، مع تصفية حسب الحالة والموعد والوسم والتاريخ.' } },
      { click: 'a.tab[href="/admin/work/calendar"]', nav: true, say: { en: 'Calendar puts everything on its due date.', ar: 'ويضع «التقويم» كل شيء في موعد تسليمه.' } },
      { click: 'a.tab[href="/admin/work/team"]', nav: true, say: { en: 'Team shows what is on each person\'s plate, so work can be shared fairly.', ar: 'ويعرض «الفريق» ما لدى كل شخص من عمل، ليُوزَّع بعدل.' } },
      { point: 'a.tab[href="/admin/work/recurring"]', say: { en: 'And Recurring creates the tasks that come back every week or month, by themselves.', ar: 'و«المتكررة» تُنشئ المهام التي تتكرر كل أسبوع أو شهر تلقائيًا.' } },
    ],
  },
  {
    id: 'overview-away',
    area: 'overview',
    module: '/admin/work/away',
    order: 50,
    roles: ['all'],
    title: { en: 'Handing over while you are away', ar: 'تسليم العمل أثناء غيابك' },
    summary: {
      en: 'Choose who covers your approvals and tasks while you are on leave, from and until which day.',
      ar: 'اختر من ينوب عنك في الموافقات والمهام أثناء إجازتك، ومن أي يوم إلى أي يوم.',
    },
    steps: [
      { go: '/admin/work', say: { en: 'Going on leave? Hand over your approvals and tasks before you go.', ar: 'ستأخذ إجازة؟ سلّم موافقاتك ومهامك قبل أن تذهب.' } },
      { click: '.bar__actions a[href="/admin/work/away"]', nav: true, say: { en: 'Choose Away.', ar: 'اختر «الغياب».' } },
      { point: 'form[action="/admin/work/away"] select[name=user_id]', say: { en: 'It is filled in for you. A manager can also set it for someone on the team.', ar: 'يكون اسمك محددًا تلقائيًا، ويمكن للمدير ضبطه لأي شخص في الفريق.' } },
      { select: ['form[action="/admin/work/away"] select[name=delegate_id]', '6'], say: { en: 'Choose who covers for you.', ar: 'اختر من ينوب عنك.' } },
      { point: 'form[action="/admin/work/away"] input[name=starts]', say: { en: 'Set the first and the last day you are away.', ar: 'حدد أول يوم وآخر يوم في غيابك.' } },
      { type: ['form[action="/admin/work/away"] input[name=note]', { en: 'Annual leave, reachable by phone for urgent matters', ar: 'إجازة سنوية، ومتاح هاتفيًا للأمور العاجلة' }], say: { en: 'Add a note for your colleagues.', ar: 'أضف ملاحظة لزملائك.' } },
      { click: 'form[action="/admin/work/away"] button.btn--primary', say: { en: 'Save. Dina is told, decides your approvals while you are away, and sees your tasks in her day.', ar: 'احفظ. تصل رسالة إلى دينا، فتتخذ القرار في موافقاتك أثناء غيابك وترى مهامك في يومها.' } },
      { point: 'section.card:has(form[action$="/end"])', say: { en: 'Away now and planned lists every cover. End one early when you are back.', ar: 'تعرض «الغياب الحالي والمخطط» كل الإنابات، ويمكنك إنهاء أي منها مبكرًا عند عودتك.' } },
    ],
  },
  {
    id: 'overview-ask',
    area: 'overview',
    module: '/admin/approvals/new',
    also: ['/admin/approvals'],
    order: 60,
    roles: ['all'],
    title: { en: 'Asking for approval and answering questions', ar: 'طلب موافقة والرد على الأسئلة' },
    summary: {
      en: 'Send a request for approval with the amount and the reason, and answer when the approver asks for more information.',
      ar: 'أرسل طلب موافقة بالمبلغ والسبب، وأجب عندما يطلب صاحب القرار معلومات إضافية.',
    },
    prepare: ({ db, h, lang }) => {
      const A = h.approvals;
      const me = db.get("SELECT * FROM users WHERE email = 'admin@thewave.test'");
      const by = db.get("SELECT * FROM users WHERE name = 'Karim Mostafa'");
      const ar = lang === 'ar';
      const r = A.request({ kind: 'other', title: ar ? 'لافتات جديدة لمداخل الجراج' : 'New signs for the car park entrances', amount: 28500, note: ar ? 'ست لافتات مضيئة.' : 'Six lit signs.', user: me });
      A.askInfo(r.id, by, ar ? 'هل يشمل هذا السعر التركيب؟' : 'Does this price include installation?');
    },
    steps: [
      { go: '/admin/work', say: { en: 'Need a manager\'s agreement for something? Ask for approval from Approvals & tasks.', ar: 'تحتاج إلى موافقة المدير على شيء؟ اطلبها من الموافقات والمهام.' } },
      { click: '.bar__actions a[href="/admin/approvals/new"]', nav: true, say: { en: 'Choose Ask for approval.', ar: 'اختر «طلب موافقة».' } },
      { type: ['form[action="/admin/approvals/new"] input[name=title]', { en: 'Replace the food court chairs', ar: 'استبدال كراسي ساحة المطاعم' }], say: { en: 'Say what needs approval,', ar: 'اكتب ما يحتاج إلى موافقة،' } },
      { type: ['form[action="/admin/approvals/new"] input[name=amount]', '86000'], say: { en: 'the amount,', ar: 'والمبلغ،' } },
      { type: ['form[action="/admin/approvals/new"] textarea[name=note]', { en: 'Forty chairs are broken. Three quotes; this is the cheapest.', ar: 'أربعون كرسيًا تالفة، ولدينا ثلاثة عروض أسعار وهذا أرخصها.' }], say: { en: 'and why. A clear reason gets a faster answer.', ar: 'والسبب. السبب الواضح يأتي بالرد أسرع.' } },
      { click: 'form[action="/admin/approvals/new"] button.btn--primary', nav: true, say: { en: 'Send it. The approver is told at once, and the request page shows who has it now.', ar: 'أرسله. يُبلَّغ صاحب القرار فورًا، وتعرض صفحة الطلب لدى من هو الآن.' } },
      { go: '/admin/work', say: { en: 'If the approver has a question, you see it under What you asked for.', ar: 'إذا كان لدى صاحب القرار سؤال، تجده تحت «ما طلبته».' } },
      { click: 'section.card a[href^="/admin/approvals/"]', has: { en: 'New signs for the car park entrances', ar: 'لافتات جديدة لمداخل الجراج' }, nav: true },
      { point: '.wk-answer', say: { en: 'Here is the question. While it waits for your answer, the approver\'s clock is paused.', ar: 'هذا هو السؤال، وطالما ينتظر ردك يتوقف حساب المهلة لدى صاحب القرار.' } },
      { type: ['.wk-answer textarea[name=answer]', { en: 'Yes, installation and delivery are included.', ar: 'نعم، يشمل السعر التركيب والتوصيل.' }], say: { en: 'Write your answer.', ar: 'اكتب ردك.' } },
      { click: '.wk-answer button.btn--primary', say: { en: 'Send it. The request goes back to the approver and the clock runs again.', ar: 'أرسله، فيعود الطلب إلى صاحب القرار ويستأنف حساب المهلة.' } },
    ],
  },
];
