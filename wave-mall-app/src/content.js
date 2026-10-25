'use strict';

// Copy for every page, English and Arabic side by side. Kept short on purpose.
// Arabic is a draft for native review.

const COORDS = { lat: 30.0194714, lng: 31.4319505 };

// Landmarks on the cleaned satellite crop, as % of its width/height.
const LANDMARKS = [
  { id: 'plot', x: 55.2, y: 44 },
  { id: 'north90', x: 50, y: 15 },
  { id: 'south90', x: 50, y: 90 },
  { id: 'airforce', x: 76, y: 70 },
];

const content = {
  en: {
    lang: 'en',
    dir: 'ltr',
    otherLang: 'ar',
    otherLabel: 'عربي',
    brand: 'The Wave',
    nav: [
      ['/', 'Home'],
      ['/the-wave/', 'The Wave'],
      ['/experience/', 'Experience'],
      ['/journal/', 'Journal'],
      ['/visit/', 'Visit'],
      ['/leasing/', 'Leasing'],
      ['/contact/', 'Contact'],
    ],
    menu: { open: 'Menu', close: 'Close', hours: 'Opening soon', follow: 'Follow', contact: 'Contact', language: 'Language' },
    skip: 'Skip to content',
    footer: {
      line: 'More than a destination.',
      about: 'A new address on North 90, New Cairo, for fashion, flavour and long golden afternoons.',
      explore: 'Explore',
      visit: 'Visit',
      follow: 'Follow',
      email: 'leasing@thewavemall.com',
      instagram: '@thewavemall',
      address: 'North 90 Street, First Sector, New Cairo',
      hours: 'Opening soon. Hours to be announced.',
      newsletter: { title: 'Be first to know', text: 'The opening date, the first names and the Journal. One email a month, no more.', placeholder: 'Email address', button: 'Subscribe', ok: 'Thank you. You are on the list.', fail: 'Please check the email address.' },
      legal: [['/privacy/', 'Privacy'], ['/terms/', 'Terms']],
      rights: 'The Wave, New Cairo Mall',
      note: 'Renders and artist’s impressions; the finished building may differ.',
      top: 'Back to top',
    },
    crumbs: { home: 'Home' },
    notFound: { title: 'This page drifted out to sea.', back: 'Back to The Wave' },

    experience: {
      title: 'Experience The Wave',
      description: 'Fashion, dining and long evenings at The Wave, New Cairo: plaza shopfronts, terrace cafés and the lifestyle floors above.',
      hero: { a: 'Which wave', b: 'are you?' },
      intro: 'Some come for the morning coffee, some for the new season, some for dinner under the lights. The building was drawn for all three.',
      blocks: [
        { img: 'fashion', title: 'Shop', text: 'Plaza shopfronts and the style edit of the season: fashion, accessories, beauty and the things you keep.' },
        { img: 'terrace', title: 'Dine', text: 'Terrace cafés in the morning, long lunches in the shade of the ribbons, dinner when the lines of light come on.' },
        { img: 'ribbons', title: 'Stay late', text: 'The plaza steps face west for golden hour. After dark the curves glow, and the evening takes its time.' },
      ],
      list: {
        title: 'What you will find',
        items: ['Fashion and accessories', 'Cafés and restaurants', 'Beauty and wellness', 'Home and lifestyle', 'Services and clinics'],
      },
      note: 'The opening line-up will be announced here and in the Journal.',
    },

    journal: {
      title: 'The Wave Journal',
      description: 'Stories from The Wave, New Cairo: the building, the identity, the neighbourhood, the seasons. Updated as we move towards opening.',
      hero: { a: 'The', b: 'Journal.' },
      intro: 'Notes on the building, the identity and the neighbourhood as we move towards opening.',
      latest: 'Latest',
      read: 'Read',
      minutes: 'min read',
      more: 'More from the Journal',
      all: 'All articles',
      share: 'Share',
      copy: 'Copy link',
      copied: 'Link copied',
      by: 'The Wave',
      feed: 'RSS feed',
    },

    contact: {
      title: 'Contact The Wave',
      description: 'Write to The Wave, New Cairo: general enquiries, leasing, press and careers. We reply personally.',
      hero: { a: 'Say', b: 'hello.' },
      intro: 'For anything at all: a question, a brand, a story, a job. We read everything and reply personally.',
      fields: { name: 'Name', email: 'Email', subject: 'Subject', message: 'Message', submit: 'Send', sending: 'Sending' },
      subjects: [['general', 'General'], ['leasing', 'Leasing'], ['press', 'Press'], ['careers', 'Careers'], ['other', 'Something else']],
      ok: 'Thank you. We will be in touch soon.',
      fail: 'Something went wrong. Please check the form and try again.',
      privacy: 'Used only to reply to your message.',
      details: { title: 'Details', email: 'leasing@thewavemall.com', address: 'North 90 Street, First Sector, New Cairo, Egypt', hours: 'Opening soon. Hours to be announced.', maps: 'Open in Google Maps' },
      faq: {
        title: 'Questions',
        items: [
          ['When does The Wave open?', 'The opening date will be announced here, in the Journal and on Instagram. Subscribe below to hear first.'],
          ['Where exactly is it?', 'On the block between North 90 and South 90 in New Cairo’s First Sector, beside the Air Force Hospital and a short walk from the monorail station.'],
          ['Is there parking?', 'Yes, on site, with access from both Teseen roads.'],
          ['How do I lease a space?', 'Tell us about your concept on the Leasing page. Our leasing team replies personally.'],
        ],
      },
    },

    legal: {
      updated: 'Last updated',
      privacy: {
        title: 'Privacy',
        description: 'How The Wave handles the personal data you share with us.',
        sections: [
          ['What we collect', 'When you write to us or subscribe, we keep the details you give us: your name, email address, phone number if you add it, and your message. The site itself sets no tracking cookies.'],
          ['Why we use it', 'To answer your enquiry, to follow up on a leasing conversation you started, or to send the newsletter you asked for. Nothing else.'],
          ['Who sees it', 'The Wave’s team and the service providers that deliver our email. We do not sell or share your details with advertisers.'],
          ['How long we keep it', 'Enquiries for as long as the conversation is live and a reasonable time after; newsletter addresses until you unsubscribe.'],
          ['Your choices', 'Write to leasing@thewavemall.com to see, correct or delete what we hold, or to unsubscribe at any time.'],
        ],
      },
      terms: {
        title: 'Terms of use',
        description: 'The terms that apply to your use of thewavemall.com.',
        sections: [
          ['The site', 'thewavemall.com is published by The Wave, New Cairo Mall. The information on it is offered in good faith and may change as the project develops.'],
          ['Renders and figures', 'Images are design renders and artist’s impressions. Distances, areas and dates are indicative and are not a contractual commitment.'],
          ['Content', 'Text, photographs, renders and the wordmark are the property of The Wave or its licensors and may not be reproduced without permission.'],
          ['Leasing', 'A leasing enquiry through this site is a request for information and does not constitute an offer or a reservation.'],
          ['Law', 'These terms are governed by the laws of the Arab Republic of Egypt.'],
        ],
      },
    },

    home: {
      title: 'The Wave, New Cairo',
      description: 'The Wave is a new mall on North 90, New Cairo: fashion, flavour and long golden afternoons. Opening soon.',
      hero: { a: 'More than a destination,', b: 'a lifestyle.', meta: ['The Wave', 'New Cairo', 'Opening soon'] },
      intro: 'A new address on North 90 for fashion, flavour and long golden afternoons. Built around the way a good day actually unfolds.',
      chapters: [
        { img: 'terrace', time: 'Morning', text: 'Coffee on the terrace, the city waking up below.', alt: 'A marble café table with two espressos and a croissant on a sunlit terrace.' },
        { img: 'architecture', time: 'Golden hour', text: 'Curves that catch the last light, and steps made for lingering.', alt: 'Curved cream balconies and glass bands at golden hour.' },
        { img: 'ribbons', time: 'After dark', text: 'The curves become lines of light, and the evening begins.', alt: 'Curved balconies traced by warm lines of light at night.' },
      ],
      mark: { text: 'One stroke, two letters, one wave.', hint: 'Tap the mark', more: 'The building' },
      visit: { text: 'North 90 Street, First Sector, New Cairo.', more: 'Find us' },
      leasing: { text: 'Bring your brand to The Wave.', more: 'Leasing enquiries' },
    },

    story: {
      title: 'The Wave, the building',
      description: 'Designed to flow: a building drawn from the movement of the sea, with a ribbon balcony on every floor and a plaza of open-air terraces.',
      hero: { a: 'Designed', b: 'to flow.' },
      intro: 'Every floor is wrapped in a ribbon balcony that bends with the plan. From the plaza the façade reads as one continuous curve; from the street it opens into a stone portal that anchors the glass.',
      frames: [
        { img: 'aerial', cap: 'The plaza from above' },
        { img: 'dusk', cap: 'The corner at dusk' },
        { img: 'side', cap: 'Glass and stone' },
      ],
      facts: [
        ['Floors', 'Ground + 4'],
        ['Ground floor', 'Shopfronts opening onto the plaza'],
        ['Upper floors', 'Dining, lifestyle, services'],
        ['Plaza', 'Open-air terraces and steps'],
      ],
      mark: { text: 'Where the A meets the V, a single line rises and falls like the sea. That curve is the whole idea: a place that flows.', hint: 'Tap the mark' },
    },

    visit: {
      title: 'Visit The Wave',
      description: 'The Wave sits between North 90 and South 90 in New Cairo’s First Sector, a short walk from the Air Force Hospital monorail station.',
      hero: { a: 'North 90,', b: 'First Sector.' },
      intro: 'Between the two Teseen roads, among the hospitals, banks and offices that bring the First Sector to life every day. The East Nile monorail runs along South 90.',
      labels: { plot: 'The Wave', north90: 'North 90', south90: 'South 90 · Monorail', airforce: 'Air Force Hospital' },
      mapAlt: 'Satellite view of the First Sector with The Wave between North 90 and South 90.',
      address: 'North 90 Street, First Sector, New Cairo, Egypt',
      button: 'Open in Google Maps',
      rows: [
        ['By car', 'From North 90 or South 90. Parking on site.'],
        ['By monorail', 'East Nile line, Air Force Hospital station.'],
        ['By ride-hail', 'Search “The Wave, North 90”.'],
      ],
    },

    leasing: {
      title: 'Leasing at The Wave',
      description: 'Retail, dining and lifestyle spaces at The Wave, New Cairo. Tell us about your concept.',
      hero: { a: 'Bring your brand', b: 'to The Wave.' },
      intro: 'Plaza shopfronts, terrace dining and lifestyle floors above. Tell us about your concept and the space you have in mind; our leasing team replies personally.',
      fields: { name: 'Name', brand: 'Brand', email: 'Email', phone: 'Phone or WhatsApp', message: 'Your concept', submit: 'Send', sending: 'Sending' },
      ok: 'Thank you. We will be in touch soon.',
      fail: 'Something went wrong. Please check the form and try again.',
      privacy: 'Used only to reply to this enquiry.',
    },
  },

  ar: {
    lang: 'ar',
    dir: 'rtl',
    otherLang: 'en',
    otherLabel: 'English',
    brand: 'ذا ويف',
    nav: [
      ['/ar/', 'الرئيسية'],
      ['/ar/the-wave/', 'ذا ويف'],
      ['/ar/experience/', 'التجربة'],
      ['/ar/journal/', 'المدونة'],
      ['/ar/visit/', 'الموقع'],
      ['/ar/leasing/', 'التأجير'],
      ['/ar/contact/', 'تواصل'],
    ],
    menu: { open: 'القائمة', close: 'إغلاق', hours: 'قريباً', follow: 'تابعونا', contact: 'تواصل', language: 'اللغة' },
    skip: 'انتقل إلى المحتوى',
    footer: {
      line: 'أكثر من وجهة.',
      about: 'عنوان جديد على التسعين الشمالي بالقاهرة الجديدة، للموضة والمذاق والأمسيات الذهبية الطويلة.',
      explore: 'استكشف',
      visit: 'الزيارة',
      follow: 'تابعونا',
      email: 'leasing@thewavemall.com',
      instagram: '@thewavemall',
      address: 'شارع التسعين الشمالي، القطاع الأول، القاهرة الجديدة',
      hours: 'قريباً. تُعلن مواعيد العمل لاحقاً.',
      newsletter: { title: 'كن أول من يعرف', text: 'موعد الافتتاح، وأولى العلامات، والمدونة. رسالة واحدة في الشهر، لا أكثر.', placeholder: 'البريد الإلكتروني', button: 'اشترك', ok: 'شكراً لك. أنت على القائمة.', fail: 'يرجى التحقق من البريد الإلكتروني.' },
      legal: [['/ar/privacy/', 'الخصوصية'], ['/ar/terms/', 'الشروط']],
      rights: 'ذا ويف، مول القاهرة الجديدة',
      note: 'الصور تصاميم وتصورات فنية وقد يختلف المبنى النهائي عنها.',
      top: 'العودة للأعلى',
    },
    crumbs: { home: 'الرئيسية' },
    notFound: { title: 'هذه الصفحة جرفها الموج.', back: 'العودة إلى ذا ويف' },

    experience: {
      title: 'تجربة ذا ويف',
      description: 'الموضة والمطاعم والأمسيات الطويلة في ذا ويف، القاهرة الجديدة: واجهات الساحة ومقاهي التراس وطوابق أسلوب الحياة.',
      hero: { a: 'أي موجة', b: 'أنت؟' },
      intro: 'بعضهم يأتي لقهوة الصباح، وبعضهم للموسم الجديد، وبعضهم لعشاء تحت الأضواء. رُسم المبنى للثلاثة.',
      blocks: [
        { img: 'fashion', title: 'تسوّق', text: 'واجهات الساحة ومختارات الموسم: الموضة والإكسسوارات والجمال والأشياء التي تحتفظ بها.' },
        { img: 'terrace', title: 'تناول', text: 'مقاهي التراس في الصباح، وغداء طويل في ظل الشرفات، وعشاء حين تضيء خطوط النور.' },
        { img: 'ribbons', title: 'ابقَ حتى وقت متأخر', text: 'يواجه درج الساحة الغرب للساعة الذهبية. بعد الغروب تتوهج المنحنيات، وتأخذ الأمسية وقتها.' },
      ],
      list: {
        title: 'ماذا ستجد',
        items: ['الأزياء والإكسسوارات', 'المقاهي والمطاعم', 'الجمال والعناية', 'المنزل وأسلوب الحياة', 'الخدمات والعيادات'],
      },
      note: 'تُعلن قائمة الافتتاح هنا وفي المدونة.',
    },

    journal: {
      title: 'مدونة ذا ويف',
      description: 'قصص من ذا ويف، القاهرة الجديدة: المبنى والهوية والحي والمواسم. تتجدد مع اقتراب الافتتاح.',
      hero: { a: 'المدونة', b: '.' },
      intro: 'ملاحظات عن المبنى والهوية والحي مع اقترابنا من الافتتاح.',
      latest: 'الأحدث',
      read: 'اقرأ',
      minutes: 'دقائق قراءة',
      more: 'المزيد من المدونة',
      all: 'كل المقالات',
      share: 'مشاركة',
      copy: 'نسخ الرابط',
      copied: 'تم نسخ الرابط',
      by: 'ذا ويف',
      feed: 'خلاصة RSS',
    },

    contact: {
      title: 'تواصل مع ذا ويف',
      description: 'اكتب إلى ذا ويف، القاهرة الجديدة: استفسارات عامة، التأجير، الصحافة والوظائف. نرد شخصياً.',
      hero: { a: 'قل', b: 'مرحباً.' },
      intro: 'لأي شيء: سؤال، علامة تجارية، قصة، وظيفة. نقرأ كل شيء ونرد شخصياً.',
      fields: { name: 'الاسم', email: 'البريد الإلكتروني', subject: 'الموضوع', message: 'الرسالة', submit: 'إرسال', sending: 'جارٍ الإرسال' },
      subjects: [['general', 'عام'], ['leasing', 'التأجير'], ['press', 'الصحافة'], ['careers', 'الوظائف'], ['other', 'شيء آخر']],
      ok: 'شكراً لك. سنتواصل معك قريباً.',
      fail: 'حدث خطأ ما. يرجى مراجعة النموذج والمحاولة مرة أخرى.',
      privacy: 'تُستخدم للرد على رسالتك فقط.',
      details: { title: 'التفاصيل', email: 'leasing@thewavemall.com', address: 'شارع التسعين الشمالي، القطاع الأول، القاهرة الجديدة، مصر', hours: 'قريباً. تُعلن مواعيد العمل لاحقاً.', maps: 'افتح في خرائط جوجل' },
      faq: {
        title: 'أسئلة',
        items: [
          ['متى يفتتح ذا ويف؟', 'يُعلن موعد الافتتاح هنا وفي المدونة وعلى إنستغرام. اشترك في الأسفل لتعرف أولاً.'],
          ['أين يقع بالضبط؟', 'في الكتلة بين التسعين الشمالي والجنوبي في القطاع الأول بالقاهرة الجديدة، بجوار مستشفى القوات الجوية وعلى بُعد خطوات من محطة المونوريل.'],
          ['هل توجد مواقف؟', 'نعم، داخل المشروع، بمداخل من طريقي التسعين.'],
          ['كيف أستأجر مساحة؟', 'حدثنا عن مفهومك في صفحة التأجير. يرد فريق التأجير شخصياً.'],
        ],
      },
    },

    legal: {
      updated: 'آخر تحديث',
      privacy: {
        title: 'الخصوصية',
        description: 'كيف يتعامل ذا ويف مع البيانات الشخصية التي تشاركها معنا.',
        sections: [
          ['ما نجمعه', 'عندما تكتب إلينا أو تشترك، نحتفظ بالتفاصيل التي تقدمها: اسمك وبريدك الإلكتروني ورقم هاتفك إن أضفته ورسالتك. الموقع نفسه لا يضع ملفات تعريف تتبّع.'],
          ['لماذا نستخدمها', 'للرد على استفسارك، أو لمتابعة حديث تأجير بدأته، أو لإرسال النشرة التي طلبتها. لا شيء غير ذلك.'],
          ['من يراها', 'فريق ذا ويف ومزودو الخدمة الذين يوصلون بريدنا. لا نبيع بياناتك ولا نشاركها مع المعلنين.'],
          ['كم نحتفظ بها', 'الاستفسارات ما دام الحديث قائماً ولفترة معقولة بعده؛ وعناوين النشرة حتى تلغي اشتراكك.'],
          ['خياراتك', 'اكتب إلى leasing@thewavemall.com للاطلاع على ما نحتفظ به أو تصحيحه أو حذفه، أو لإلغاء الاشتراك في أي وقت.'],
        ],
      },
      terms: {
        title: 'شروط الاستخدام',
        description: 'الشروط التي تنطبق على استخدامك لموقع thewavemall.com.',
        sections: [
          ['الموقع', 'يُنشر موقع thewavemall.com بواسطة ذا ويف، مول القاهرة الجديدة. المعلومات فيه مقدمة بحسن نية وقد تتغير مع تطور المشروع.'],
          ['الصور والأرقام', 'الصور تصاميم وتصورات فنية. المسافات والمساحات والتواريخ استرشادية وليست التزاماً تعاقدياً.'],
          ['المحتوى', 'النصوص والصور والتصاميم والشعار ملك لذا ويف أو لمرخّصيه ولا يجوز إعادة إنتاجها دون إذن.'],
          ['التأجير', 'استفسار التأجير عبر هذا الموقع طلب للمعلومات ولا يُعد عرضاً أو حجزاً.'],
          ['القانون', 'تخضع هذه الشروط لقوانين جمهورية مصر العربية.'],
        ],
      },
    },

    home: {
      title: 'ذا ويف، القاهرة الجديدة',
      description: 'ذا ويف مول جديد على التسعين الشمالي بالقاهرة الجديدة: الموضة والمذاق والأمسيات الذهبية. قريباً.',
      hero: { a: 'أكثر من وجهة،', b: 'أسلوب حياة.', meta: ['ذا ويف', 'القاهرة الجديدة', 'قريباً'] },
      intro: 'عنوان جديد على التسعين الشمالي للموضة والمذاق والأمسيات الذهبية الطويلة. بُني حول الطريقة التي يمضي بها يوم جميل.',
      chapters: [
        { img: 'terrace', time: 'الصباح', text: 'قهوة على التراس، والمدينة تستيقظ تحتك.', alt: 'طاولة رخامية عليها فنجانا إسبريسو وكرواسون على تراس مشمس.' },
        { img: 'architecture', time: 'الساعة الذهبية', text: 'منحنيات تلتقط آخر الضوء، ودرج صُنع للبقاء.', alt: 'شرفات كريمية منحنية وأشرطة زجاجية وقت الغروب.' },
        { img: 'ribbons', time: 'بعد الغروب', text: 'تتحول المنحنيات إلى خطوط من الضوء، وتبدأ الأمسية.', alt: 'شرفات منحنية مرسومة بخطوط ضوء دافئة ليلاً.' },
      ],
      mark: { text: 'ضربة واحدة، حرفان، موجة واحدة.', hint: 'المس الشعار', more: 'المبنى' },
      visit: { text: 'شارع التسعين الشمالي، القطاع الأول، القاهرة الجديدة.', more: 'موقعنا' },
      leasing: { text: 'أحضر علامتك إلى ذا ويف.', more: 'استفسارات التأجير' },
    },

    story: {
      title: 'ذا ويف، المبنى',
      description: 'صُمّم لينساب: مبنى مرسوم من حركة البحر، بشرفة شريطية في كل طابق وساحة من التراسات المفتوحة.',
      hero: { a: 'صُمّم', b: 'لينساب.' },
      intro: 'كل طابق يلتف حوله شريط من الشرفات ينحني مع المخطط. من الساحة تبدو الواجهة منحنى واحداً متصلاً، ومن الشارع تنفتح على بوابة حجرية ترسّخ الزجاج.',
      frames: [
        { img: 'aerial', cap: 'الساحة من الأعلى' },
        { img: 'dusk', cap: 'الزاوية عند الغروب' },
        { img: 'side', cap: 'زجاج وحجر' },
      ],
      facts: [
        ['الطوابق', 'أرضي + 4'],
        ['الطابق الأرضي', 'واجهات تفتح على الساحة'],
        ['الطوابق العليا', 'مطاعم وأسلوب حياة وخدمات'],
        ['الساحة', 'تراسات ودرج في الهواء الطلق'],
      ],
      mark: { text: 'حيث يلتقي حرف A بحرف V، يرتفع خط واحد وينخفض مثل البحر. هذا المنحنى هو الفكرة كلها: مكان ينساب.', hint: 'المس الشعار' },
    },

    visit: {
      title: 'زيارة ذا ويف',
      description: 'يقع ذا ويف بين التسعين الشمالي والجنوبي في القطاع الأول بالقاهرة الجديدة، على بُعد خطوات من محطة مونوريل مستشفى القوات الجوية.',
      hero: { a: 'التسعين الشمالي،', b: 'القطاع الأول.' },
      intro: 'بين طريقي التسعين، وسط المستشفيات والبنوك والمكاتب التي تمنح القطاع الأول حياته كل يوم. يمر مونوريل شرق النيل على التسعين الجنوبي.',
      labels: { plot: 'ذا ويف', north90: 'التسعين الشمالي', south90: 'التسعين الجنوبي · المونوريل', airforce: 'مستشفى القوات الجوية' },
      mapAlt: 'صورة فضائية للقطاع الأول مع ذا ويف بين التسعين الشمالي والجنوبي.',
      address: 'شارع التسعين الشمالي، القطاع الأول، القاهرة الجديدة، مصر',
      button: 'افتح في خرائط جوجل',
      rows: [
        ['بالسيارة', 'من التسعين الشمالي أو الجنوبي. مواقف داخل المشروع.'],
        ['بالمونوريل', 'خط شرق النيل، محطة مستشفى القوات الجوية.'],
        ['بتطبيقات النقل', 'ابحث عن «ذا ويف، التسعين الشمالي».'],
      ],
    },

    leasing: {
      title: 'التأجير في ذا ويف',
      description: 'مساحات للتجزئة والمطاعم وأسلوب الحياة في ذا ويف، القاهرة الجديدة. حدثنا عن مفهومك.',
      hero: { a: 'أحضر علامتك', b: 'إلى ذا ويف.' },
      intro: 'واجهات على الساحة، ومطاعم على التراس، وطوابق لأسلوب الحياة في الأعلى. حدثنا عن مفهومك والمساحة التي تفكر فيها، ويردّ فريق التأجير شخصياً.',
      fields: { name: 'الاسم', brand: 'العلامة التجارية', email: 'البريد الإلكتروني', phone: 'الهاتف أو واتساب', message: 'مفهومك', submit: 'إرسال', sending: 'جارٍ الإرسال' },
      ok: 'شكراً لك. سنتواصل معك قريباً.',
      fail: 'حدث خطأ ما. يرجى مراجعة النموذج والمحاولة مرة أخرى.',
      privacy: 'تُستخدم للرد على هذا الاستفسار فقط.',
    },
  },
};

module.exports = { content, COORDS, LANDMARKS };
