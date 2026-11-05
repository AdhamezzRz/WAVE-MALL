'use strict';

// Getting started: finding your way around the office.

module.exports = [
  {
    id: 'start-getting-around',
    area: 'start',
    module: '/admin',
    order: 10,
    roles: ['all'],
    title: { en: 'Getting around the office', ar: 'التنقل داخل المكتب' },
    summary: {
      en: 'The sidebar, quick search, switching language, help on every page and the office on your phone.',
      ar: 'القائمة الجانبية، والبحث السريع، وتغيير اللغة، والمساعدة في كل صفحة، والمكتب على هاتفك.',
    },
    steps: [
      { go: '/admin', say: { en: 'Welcome to The Wave leasing office. Everything starts from the dashboard.', ar: 'أهلًا بك في مكتب تأجير ذا ويف. كل شيء يبدأ من لوحة التحكم.' } },
      { point: '.side .nav', say: { en: 'The sidebar groups every module: sales, property, revenue, finance, operations and more. You only see what your role allows.', ar: 'تجمع القائمة الجانبية كل الأقسام: المبيعات والعقار والإيرادات والمالية والتشغيل وغيرها. ولا يظهر لك إلا ما يسمح به دورك.' } },
      { point: '.nav__a[href="/admin/work"]', say: { en: 'A number next to a module means something is waiting for you, like approvals or overdue invoices.', ar: 'الرقم بجانب أي قسم يعني أن هناك ما ينتظرك، مثل موافقات أو فواتير متأخرة.' } },
      { click: '.bar .search', say: { en: 'Search finds any lead, brand, unit, offer or lease. Press Ctrl and K from anywhere to open it.', ar: 'البحث يجد أي فرصة أو علامة تجارية أو وحدة أو عرض أو عقد. ولفتحه من أي مكان اضغط مفتاح التحكم مع حرف K.' } },
      { type: ['[data-cmdk-input]', { en: 'Oud', ar: 'Oud' }], say: { en: 'Start typing and the results appear instantly.', ar: 'ابدأ الكتابة وستظهر النتائج فورًا.' } },
      { key: 'Escape' },
      { point: '.bar .langbtn', say: { en: 'This button switches the whole office between English and Arabic. Your choice is remembered.', ar: 'هذا الزر يحوّل المكتب كله بين الإنجليزية والعربية، ويتذكر النظام اختيارك.' } },
      { point: '[data-help-btn]', say: { en: 'And this question mark opens the lessons for the page you are on, any time you need help.', ar: 'وعلامة الاستفهام هذه تفتح دروس الصفحة التي أنت عليها، في أي وقت تحتاج فيه إلى المساعدة.' } },
      { point: '.side__me', say: { en: 'Your name, your role and signing out are at the bottom of the sidebar.', ar: 'اسمك ودورك وتسجيل الخروج في أسفل القائمة الجانبية.' } },
      { say: { en: 'On a phone, open the office in the browser and add it to your home screen: it works like an app, with a tab bar at the bottom.', ar: 'على الهاتف، افتح المكتب في المتصفح وأضفه إلى الشاشة الرئيسية: سيعمل كتطبيق، مع شريط تبويب في الأسفل.' } },
    ],
  },
];
