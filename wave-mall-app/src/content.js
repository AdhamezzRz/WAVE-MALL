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
      ['/visit/', 'Visit'],
      ['/leasing/', 'Leasing'],
    ],
    skip: 'Skip to content',
    footer: {
      line: 'More than a destination.',
      email: 'leasing@thewavemall.com',
      instagram: '@thewavemall',
      address: 'North 90 Street, First Sector, New Cairo',
      rights: 'The Wave, New Cairo Mall',
      note: 'Renders and artist’s impressions; the finished building may differ.',
    },
    notFound: { title: 'This page drifted out to sea.', back: 'Back to The Wave' },

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
      ['/ar/visit/', 'الموقع'],
      ['/ar/leasing/', 'التأجير'],
    ],
    skip: 'انتقل إلى المحتوى',
    footer: {
      line: 'أكثر من وجهة.',
      email: 'leasing@thewavemall.com',
      instagram: '@thewavemall',
      address: 'شارع التسعين الشمالي، القطاع الأول، القاهرة الجديدة',
      rights: 'ذا ويف، مول القاهرة الجديدة',
      note: 'الصور تصاميم وتصورات فنية وقد يختلف المبنى النهائي عنها.',
    },
    notFound: { title: 'هذه الصفحة جرفها الموج.', back: 'العودة إلى ذا ويف' },

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
