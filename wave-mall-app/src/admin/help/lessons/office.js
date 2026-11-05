'use strict';

// Office and administration: users and permissions.

module.exports = [
  {
    id: 'office-invite',
    area: 'office',
    module: '/admin/people',
    order: 10,
    roles: ['admin'],
    title: { en: 'Inviting a new colleague', ar: 'دعوة زميل جديد' },
    summary: {
      en: 'Send an invitation by email with the right role; the person sets their own password.',
      ar: 'أرسل دعوة بالبريد الإلكتروني بالدور المناسب، ويختار الشخص كلمة مروره بنفسه.',
    },
    steps: [
      { go: '/admin/people', say: { en: 'Users & permissions lists everyone with an account, their role and when they last signed in.', ar: 'تعرض صفحة المستخدمين والصلاحيات كل من لديه حساب ودوره وآخر تسجيل دخول له.' } },
      { point: '.kpis', say: { en: 'At the top: invitations waiting, temporary access, locked and dormant accounts.', ar: 'في الأعلى: الدعوات المنتظرة والصلاحيات المؤقتة والحسابات المقفلة وغير النشطة.' } },
      { click: '.bar__actions a[href="/admin/people/new"]', nav: true, say: { en: 'Choose Invite someone.', ar: 'اختر «دعوة شخص».' } },
      { type: ['form[action="/admin/people/invite"] input[name=email]', { en: 'laila.mansour@thewavemall.com', ar: 'laila.mansour@thewavemall.com' }], say: { en: 'Enter their work email and, if you like, their name.', ar: 'أدخل بريده الإلكتروني للعمل، واسمه إن شئت.' } },
      { type: ['form[action="/admin/people/invite"] input[name=name]', { en: 'Laila Mansour', ar: 'ليلى منصور' }] },
      { select: ['form[action="/admin/people/invite"] select[name=role]', 'role:3'], say: { en: 'Pick the role. It decides what they can see and do; the guide on the right explains each role.', ar: 'اختر الدور، فهو يحدد ما يمكنه رؤيته وفعله، ويشرح الدليل على اليمين كل دور.' } },
      { select: ['form[action="/admin/people/invite"] select[name=lang]', 'ar'], say: { en: 'Choose the language of the invitation email.', ar: 'اختر لغة رسالة الدعوة.' } },
      { click: 'form[action="/admin/people/invite"] button.btn--primary', nav: true, say: { en: 'Send the invitation. The link works once and expires after a week.', ar: 'أرسل الدعوة. يعمل الرابط مرة واحدة وتنتهي صلاحيته بعد أسبوع.' } },
      { say: { en: 'You can resend or cancel an invitation from the Invitations tab until it is used.', ar: 'يمكنك إعادة إرسال الدعوة أو إلغاؤها من تبويب «الدعوات» حتى تُستخدم.' } },
    ],
  },
  {
    id: 'office-role',
    area: 'office',
    module: '/admin/people',
    order: 20,
    roles: ['admin'],
    title: { en: 'Changing what someone can do', ar: 'تغيير صلاحيات شخص' },
    summary: {
      en: 'Give a person another role, check their effective access, and see why they can or cannot open a page.',
      ar: 'امنح شخصًا دورًا آخر، وراجع صلاحياته الفعلية، واعرف لماذا يستطيع أو لا يستطيع فتح صفحة.',
    },
    steps: [
      { go: '/admin/people', say: { en: 'Open the person whose access you want to change.', ar: 'افتح الشخص الذي تريد تغيير صلاحياته.' } },
      { click: 'tr[data-href="/admin/people/5"]', nav: true },
      { point: 'form[action$="/role"]', say: { en: 'The role card shows their current role. Built-in roles follow the rank; custom roles follow their permission grid.', ar: 'تعرض بطاقة الدور دوره الحالي. الأدوار الأساسية تتبع الرتبة، والأدوار المخصصة تتبع جدول صلاحياتها.' } },
      { select: ['form[action$="/role"] select[name=role]', 'role:5'], say: { en: 'Choose the new role.', ar: 'اختر الدور الجديد.' } },
      { click: 'form[action$="/role"] button[type=submit]', say: { en: 'Save. Nobody can give more than they hold, and sensitive changes can need a second administrator\'s approval.', ar: 'احفظ. لا يستطيع أحد منح صلاحيات أكثر مما لديه، وقد تحتاج التغييرات الحساسة إلى موافقة مسؤول ثانٍ.' } },
      { click: '.bar__actions a[href$="/access"]', nav: true, say: { en: 'Effective access shows the final result for every module, and where each level comes from.', ar: 'تعرض الصلاحيات الفعلية النتيجة النهائية لكل قسم، ومصدر كل مستوى.' } },
      { say: { en: 'Use the tester on this page to ask: can this person open a given address, and if not, why?', ar: 'استخدم أداة الاختبار في هذه الصفحة لتعرف: هل يستطيع هذا الشخص فتح عنوان معين، وإن لم يستطع فلماذا؟' } },
    ],
  },
];
