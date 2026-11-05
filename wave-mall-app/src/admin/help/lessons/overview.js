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
];
