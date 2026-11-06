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
  {
    id: 'portal-pay',
    area: 'portal',
    module: '/portal/invoices',
    also: ['/portal'],
    order: 20,
    roles: ['tenant'],
    title: { en: 'Paying an invoice online', ar: 'دفع فاتورة إلكترونيًا' },
    summary: {
      en: 'Pay what is due by card, mobile wallet or at a payment outlet, and get your receipt straight away.',
      ar: 'ادفع المستحق ببطاقة بنكية أو محفظة إلكترونية أو من منفذ دفع، واحصل على إيصالك فورًا.',
    },
    prepare: ({ db }) => {
      // one invoice due today, so the portal has something to pay
      const inv = db.get("SELECT id FROM invoices WHERE brand_id = 1 AND status = 'open' AND kind = 'parking' ORDER BY due_date LIMIT 1");
      if (inv) db.run("UPDATE invoices SET due_date = date('now') WHERE id = ?", inv.id);
    },
    steps: [
      { go: '/portal', say: { en: 'When something is due, the home page of your portal says so.', ar: 'عندما يحين موعد دفع، تخبرك به الصفحة الرئيسية لبوابتك.' } },
      { point: 'a.kpi[href="/portal/invoices"]', say: { en: 'Your balance shows what is due now.', ar: 'يعرض رصيدك المستحق عليك الآن.' } },
      { click: 'a.pquick__a--primary', nav: true, say: { en: 'Choose Pay now.', ar: 'اختر «ادفع الآن».' } },
      { point: 'main section.card', has: { en: 'Invoice', ar: 'الفاتورة' }, say: { en: 'The invoice shows what it is for, the due date and what is still outstanding.', ar: 'تعرض الفاتورة ما تخصه، وتاريخ استحقاقها، والمبلغ المتبقي.' } },
      { point: 'form.paycard', say: { en: 'Choose how to pay: a bank card, a mobile wallet, or cash at a payment outlet with a reference number.', ar: 'اختر طريقة الدفع: بطاقة بنكية، أو محفظة إلكترونية، أو نقدًا من منفذ دفع برقم مرجعي.' } },
      { click: 'form.paycard button[type=submit]', nav: true, say: { en: 'Pay. You go to the secure payment page of the bank.', ar: 'ادفع، فتنتقل إلى صفحة الدفع الآمنة الخاصة بالبنك.' } },
      { point: '.paycard', say: { en: 'Check the amount and the invoice, then confirm. In this practice office the bank page is a test page, so no money moves.', ar: 'تأكد من المبلغ والفاتورة ثم أكّد. في مكتب التدريب هذا صفحة البنك تجريبية، فلا تُخصم أي أموال.' } },
      { click: '.paycard form button.btn--primary', nav: true },
      { point: '.paycard', say: { en: 'Payment received. The receipt number is here, and a copy goes to your email.', ar: 'تم استلام الدفعة. رقم الإيصال هنا، وتصلك نسخة على بريدك.' } },
      { click: '.paycard a.btn--primary', nav: true, say: { en: 'Back in the portal, the invoice is paid and the receipt is ready to download any time.', ar: 'وعند العودة إلى البوابة تجد الفاتورة مدفوعة والإيصال جاهزًا للتنزيل في أي وقت.' } },
    ],
  },
  {
    id: 'portal-request',
    area: 'portal',
    module: '/portal/requests',
    order: 30,
    roles: ['tenant'],
    title: { en: 'Reporting a problem in your store', ar: 'الإبلاغ عن مشكلة في متجرك' },
    summary: {
      en: 'Send a maintenance request to the mall team and follow it until it is fixed.',
      ar: 'أرسل طلب صيانة إلى فريق المول وتابعه حتى يتم الإصلاح.',
    },
    steps: [
      { go: '/portal/requests', say: { en: 'Something needs fixing? Maintenance is where you tell the mall team.', ar: 'هل يحتاج شيء إلى إصلاح؟ من «الصيانة» تبلغ فريق المول.' } },
      { type: ['form[action="/portal/requests"] input[name=title]', { en: 'Air conditioning is not cooling the fitting rooms', ar: 'التكييف لا يبرّد غرف القياس' }], say: { en: 'Say in a few words what is wrong.', ar: 'اذكر المشكلة في كلمات قليلة.' } },
      { select: ['form[action="/portal/requests"] select[name=category]', 'hvac'], say: { en: 'Choose the kind of problem, so it goes straight to the right technician.', ar: 'اختر نوع المشكلة لتصل مباشرةً إلى الفني المختص.' } },
      { select: ['form[action="/portal/requests"] select[name=priority]', '2'], say: { en: 'Set how urgent it is. Emergency is for safety risks or when you cannot trade.', ar: 'حدد درجة الاستعجال. الطارئ للمخاطر على السلامة أو عندما لا تستطيع العمل.' } },
      { type: ['form[action="/portal/requests"] input[name=location]', { en: 'Back of the store, fitting rooms', ar: 'خلف المتجر، غرف القياس' }], say: { en: 'Tell them where to look.', ar: 'حدد مكان المشكلة.' } },
      { type: ['form[action="/portal/requests"] textarea[name=description]', { en: 'Since this morning the air is warm in all three rooms.', ar: 'منذ الصباح الهواء دافئ في الغرف الثلاث.' }], say: { en: 'Add any detail that helps.', ar: 'أضف أي تفاصيل مفيدة.' } },
      { click: 'form[action="/portal/requests"] button.btn--primary', nav: true, say: { en: 'Send the request.', ar: 'أرسل الطلب.' } },
      { point: 'main section.card', has: { en: 'Details', ar: 'التفاصيل' }, say: { en: 'Your request has a number and a status. You get an email as it is assigned, worked on and done.', ar: 'لطلبك رقم وحالة، وتصلك رسالة عند إسناده والعمل عليه وإنجازه.' } },
      { point: 'form[action$="/comment"]', say: { en: 'Write to the team here, and add photos below to show them the problem.', ar: 'راسل الفريق من هنا، وأضف صورًا في الأسفل لتوضح المشكلة.' } },
    ],
  },
  {
    id: 'portal-sales',
    area: 'portal',
    module: '/portal/sales',
    order: 40,
    roles: ['tenant', 'finance'],
    title: { en: 'Reporting your monthly sales', ar: 'إرسال مبيعاتك الشهرية' },
    summary: {
      en: 'Send your sales for the month from the portal. If your lease has turnover rent, it is worked out from them.',
      ar: 'أرسل مبيعات الشهر من البوابة. وإن كان عقدك يتضمن إيجارًا من المبيعات، فيُحسب منها.',
    },
    prepare: ({ db }) => {
      // last month not reported yet, so there is something to send
      db.run("DELETE FROM tenant_sales WHERE lease_id IN (SELECT id FROM leases WHERE brand_id = 1) AND period = strftime('%Y-%m', date('now', 'start of month', '-1 month'))");
    },
    steps: [
      { go: '/portal/sales', say: { en: 'Each month, report your store\'s sales here.', ar: 'كل شهر، أرسل مبيعات متجرك من هنا.' } },
      { point: '.alert', say: { en: 'The portal tells you which months are still to report.', ar: 'تخبرك البوابة بالأشهر التي لم تُرسل مبيعاتها بعد.' } },
      { point: 'select[name=period]', say: { en: 'The month is chosen for you.', ar: 'الشهر مختار لك.' } },
      { type: ['input[name=gross]', '4620000'], say: { en: 'Enter the gross sales, before VAT.', ar: 'أدخل إجمالي المبيعات قبل ضريبة القيمة المضافة.' } },
      { type: ['input[name=returns]', '85000'], say: { en: 'Then the returns. Net sales are gross sales minus returns.', ar: 'ثم المرتجعات. صافي المبيعات هو الإجمالي ناقص المرتجعات.' } },
      { type: ['input[name=transactions]', '6140'], say: { en: 'And the number of receipts, if you have it.', ar: 'وعدد الفواتير إن كان متاحًا.' } },
      { click: 'form[action="/portal/sales"] button.btn--primary', say: { en: 'Submit sales.', ar: 'أرسل المبيعات.' } },
      { point: 'main section.card', has: { en: 'Reported', ar: 'ما تم الإبلاغ عنه' }, say: { en: 'The month is listed as submitted. The leasing office checks it, and any turnover rent is invoiced from it.', ar: 'يظهر الشهر كمُرسل، ويراجعه مكتب التأجير، ويُصدر منه أي إيجار مستحق من المبيعات.' } },
    ],
  },
];
