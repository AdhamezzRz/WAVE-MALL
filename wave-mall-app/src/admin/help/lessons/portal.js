'use strict';

// The tenant portal: what tenants see (shown to tenants under /portal/help, and to staff in the academy).

module.exports = [
  {
    id: 'portal-tour',
    area: 'portal',
    module: '/portal',
    order: 10,
    roles: ['tenant', 'leasing'],
    title: { en: 'Your tenant portal at a glance', ar: 'بوابة المستأجر في لمحة' },
    summary: {
      en: 'What you owe and when, receipts, documents, notices and maintenance requests, in one place.',
      ar: 'ما عليك ومتى، والإيصالات، والمستندات، والإشعارات، وطلبات الصيانة، في مكان واحد.',
    },
    steps: [
      { go: '/portal', say: { en: 'Welcome to your portal at The Wave. The home page shows what matters today.', ar: 'أهلًا بك في بوابتك في ذا ويف. تعرض الصفحة الرئيسية ما يهمك اليوم.' } },
      { point: 'a.kpi[href="/portal/invoices"]', say: { en: 'Your balance: what is due and whether anything is overdue.', ar: 'رصيدك: المستحق عليك وهل يوجد شيء متأخر.' } },
      { point: '.kpis a.kpi[href^="/portal/invoices/"]', say: { en: 'Your next invoice and its due date. Open it to see the details and pay online.', ar: 'فاتورتك القادمة وتاريخ استحقاقها. افتحها لترى التفاصيل وتدفع إلكترونيًا.' } },
      { point: '.side .nav', say: { en: 'The menu has everything: invoices, sales reports, cheques, receipts, maintenance, documents and notices.', ar: 'تحتوي القائمة على كل شيء: الفواتير وتقارير المبيعات والشيكات والإيصالات والصيانة والمستندات والإشعارات.' } },
      { click: '.side .nav a[href="/portal/invoices"]', nav: true, say: { en: 'Invoices are grouped into to pay, upcoming and paid.', ar: 'الفواتير مقسمة إلى: للدفع، والقادمة، والمدفوعة.' } },
      { point: '.tabs', say: { en: 'Switch between them here.', ar: 'تنقّل بينها من هنا.' } },
      { click: '.side .nav a[href="/portal/requests"]', nav: true, say: { en: 'Something needs fixing in your store? Open a maintenance request and follow it until it is done.', ar: 'هل يحتاج شيء في متجرك إلى إصلاح؟ افتح طلب صيانة وتابعه حتى ينتهي.' } },
      { click: '.side .nav a[href="/portal/notices"]', nav: true, say: { en: 'Notices from the mall arrive here and by email: trading hours, drills, events.', ar: 'تصل إشعارات المول إلى هنا وبالبريد: مواعيد العمل والتدريبات والفعاليات.' } },
      { point: '.langbtn', say: { en: 'The portal works in English and Arabic. And Help has these lessons any time.', ar: 'تعمل البوابة بالإنجليزية والعربية، وتجد هذه الدروس في «المساعدة» في أي وقت.' } },
    ],
  },
];
