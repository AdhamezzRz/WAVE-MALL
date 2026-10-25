'use strict';

// Page copy, English and Arabic. Short by design. Numbers come from ./data.js.
// Arabic is a draft for native review.

const KEEP = require('./content-keep.json');

const content = {
  en: {
    lang: 'en',
    dir: 'ltr',
    otherLang: 'ar',
    otherLabel: 'عربي',
    brand: 'The Wave',
    nav: [
      ['/', 'Home'],
      ['/the-wave/', 'The Building'],
      ['/experience/', 'Experience'],
      ['/leasing/', 'Leasing'],
      ['/journal/', 'Journal'],
      ['/visit/', 'Visit'],
      ['/contact/', 'Contact'],
    ],
    menu: { open: 'Menu', close: 'Close', write: 'Write to us', follow: 'Follow' },
    floorNames: { R: 'Roof', 4: 'Fourth', 3: 'Third', 2: 'Second', 1: 'First', G: 'Plaza', B1: 'Lower ground', B2: 'Parking' },
    unit: 'm²',
    skip: 'Skip to content',
    footer: {
      line: 'More than a destination.',
      address: 'North 90 Street, First Sector, New Cairo',
      email: 'leasing@thewavemall.com',
      instagram: '@thewavemall',
      hours: 'Opening soon',
      newsletter: { title: 'Opening news, first.', placeholder: 'Your email', button: 'Subscribe', ok: 'You are on the list.', fail: 'Please check the email address.' },
      legal: [['/privacy/', 'Privacy'], ['/terms/', 'Terms']],
      rights: 'The Wave, New Cairo',
      note: 'Images are photographs and design renders for illustration. Areas are indicative.',
      top: 'Back to top',
    },
    crumbs: { home: 'Home' },

    home: {
      title: 'The Wave, New Cairo | More than a destination',
      description: 'The Wave is a new destination on North 90, New Cairo: two curved wings around an open court, plaza shops with their own terraces, dining and long evenings. Opening soon.',
      hero: { kicker: 'North 90 · New Cairo', a: 'More than', b: 'a destination.', meta: 'Opening soon', scroll: 'Scroll' },
      lights: {
        kicker: 'One building, from day to evening',
        items: [
          { img: 'facade', time: '11:00', name: 'Day', text: 'White ribbons against a clear sky.' },
          { img: 'corner', time: '18:30', name: 'Dusk', text: 'The corner on North 90 as the lights come on.' },
          { img: 'aerial', time: '20:00', name: 'Evening', text: 'The plaza fills under the sails.' },
        ],
      },
      statement: 'Two curved wings around an open court, on the busiest block in New Cairo.',
      figures: [
        ['plazaUnits', 'shops on the plaza, each with its own terrace'],
        ['upperFloors', 'm² across four floors and a roof'],
        ['parkingArea', 'm² of parking on two levels below'],
        ['employees', 'people work around the block every day'],
      ],
      scenes: [
        { img: 'boutique', name: 'Shop', text: 'Quiet rooms, curved stone, the season’s edit.' },
        { img: 'terrace', name: 'Dine', text: 'Breakfast under the sails, dinner on the terrace.' },
        { img: 'steps', name: 'Stay', text: 'The plaza steps face west for golden hour.' },
      ],
      directory: { kicker: 'Floor by floor', title: 'From the parking to the roof.', more: 'Explore the building' },
      place: { kicker: 'North 90, First Sector', text: 'Between the two Teseen roads. Banks, offices and two hospitals next door; the monorail a short walk away.', more: 'Plan your visit' },
      journal: { kicker: 'Journal', more: 'All stories' },
      lease: { kicker: 'Leasing', text: 'Units from 61 to 301 m², most with a terrace of their own.', more: 'View the units' },
    },

    building: {
      title: 'The Building | The Wave, New Cairo',
      description: 'Two curved wings around an open court, a ribbon balcony on every floor, four floors and a roof above a plaza of shops. Floor areas and plans.',
      hero: { a: 'Two wings,', b: 'one court.' },
      intro: 'The plan is an hourglass: two wings that curve towards each other around an open court. Every floor is edged by a ribbon balcony that follows the curve.',
      gallery: [
        { img: 'night', cap: 'The North 90 façade at night' },
        { img: 'ribbon', cap: 'The ribbon, after sunset' },
        { img: 'corner', cap: 'The corner at dusk · design render' },
        { img: 'aerial', cap: 'The plaza from above · design render' },
      ],
      directory: { kicker: 'Directory', title: 'Floor by floor.', hint: 'Select a floor', area: 'Floor area', spaces: 'parking spaces', units: 'plaza shops', street: 'street-level shops', terraces: 'Terraces on both wings', indicative: 'Plans simplified from the architect’s drawings. Indicative.' },
      mark: { kicker: 'The mark', text: 'Where the A meets the V, a single line rises and falls like the sea. The same curve runs through the building.' },
    },

    experience: {
      title: 'Experience | The Wave, New Cairo',
      description: 'Shopping, dining and long evenings at The Wave, New Cairo: plaza shops with terraces, cafés under the sails and a court open to the sky.',
      hero: { a: 'Slow mornings,', b: 'golden evenings.' },
      chapters: [
        { img: 'terrace', time: '09:00', name: 'Morning', text: 'Coffee under the sails on the plaza, before the city gets loud.' },
        { img: 'boutique', time: '12:00', name: 'Midday', text: 'Fashion, beauty and the things you keep, in rooms built around stone and light.' },
        { img: 'steps', time: '17:00', name: 'Golden hour', text: 'The plaza steps face west. This is the hour the building was drawn for.' },
        { img: 'night', time: '21:00', name: 'Evening', text: 'Dinner on the terraces while the ribbons glow.' },
      ],
      note: 'The opening line-up will be announced in the Journal.',
      list: { title: 'What you will find', items: ['Fashion and accessories', 'Cafés and restaurants', 'Beauty and wellness', 'Home and lifestyle', 'Services and clinics'] },
    },

    leasing: {
      title: 'Leasing | The Wave, New Cairo',
      description: 'Shops from 61 to 301 m² at The Wave, New Cairo, most with a private terrace. Plaza and street-level unit schedule, floor areas and leasing enquiries.',
      hero: { a: 'A place', b: 'for your brand.' },
      intro: 'Sixteen shops face the plaza and seven more open onto the street. Most come with a terrace of their own.',
      tabs: { ground: 'Plaza level', street: 'Street level' },
      table: { unit: 'Unit', indoor: 'Indoor', outdoor: 'Terrace', total: 'Total', note: 'Areas from the developer’s schedule, in m². Indicative and subject to final survey.' },
      why: [
        ['6,000+', 'people work around the block'],
        ['2', 'hospitals and a row of banks next door'],
        ['19,069', 'm² of parking below'],
      ],
      form: {
        title: 'Enquire',
        fields: { name: 'Name', brand: 'Brand', email: 'Email', phone: 'Phone or WhatsApp', message: 'Concept and space you have in mind', submit: 'Send enquiry', sending: 'Sending' },
        ok: 'Thank you. Our leasing team will be in touch.',
        fail: 'Something is missing. Please check the form.',
        privacy: 'Used only to reply to this enquiry.',
      },
    },

    visit: {
      title: 'Visit | The Wave, North 90, New Cairo',
      description: 'The Wave is on North 90 Street in New Cairo’s First Sector, between the two Teseen roads, beside the Air Force Hospital and a short walk from the monorail.',
      hero: { a: 'North 90,', b: 'First Sector.' },
      intro: 'On the block between the two Teseen roads, among the banks, offices and hospitals that keep the First Sector busy every day.',
      labels: { plot: 'The Wave', north90: 'North 90', south90: 'South 90 · Monorail', airforce: 'Air Force Hospital', nasaaem: 'Nasaaem Hospital', nbk: 'NBK', fab: 'FABMISR' },
      mapAlt: 'Satellite view of the First Sector, New Cairo, with The Wave between North 90 and South 90.',
      address: 'North 90 Street, First Sector, New Cairo, Egypt',
      button: 'Open in Google Maps',
      rows: [
        ['By car', 'From North 90 or South 90. Two levels of parking below the building.'],
        ['By monorail', 'East Nile line, Air Force Hospital station.'],
        ['By ride-hail', 'Search “The Wave, North 90”.'],
      ],
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
      ['/ar/the-wave/', 'المبنى'],
      ['/ar/experience/', 'التجربة'],
      ['/ar/leasing/', 'التأجير'],
      ['/ar/journal/', 'المدونة'],
      ['/ar/visit/', 'الزيارة'],
      ['/ar/contact/', 'تواصل'],
    ],
    menu: { open: 'القائمة', close: 'إغلاق', write: 'اكتب إلينا', follow: 'تابعونا' },
    floorNames: { R: 'السطح', 4: 'الرابع', 3: 'الثالث', 2: 'الثاني', 1: 'الأول', G: 'الساحة', B1: 'الأرضي السفلي', B2: 'المواقف' },
    unit: 'م²',
    skip: 'انتقل إلى المحتوى',
    footer: {
      line: 'أكثر من وجهة.',
      address: 'شارع التسعين الشمالي، القطاع الأول، القاهرة الجديدة',
      email: 'leasing@thewavemall.com',
      instagram: '@thewavemall',
      hours: 'قريباً',
      newsletter: { title: 'أخبار الافتتاح أولاً.', placeholder: 'بريدك الإلكتروني', button: 'اشترك', ok: 'أنت على القائمة.', fail: 'يرجى التحقق من البريد الإلكتروني.' },
      legal: [['/ar/privacy/', 'الخصوصية'], ['/ar/terms/', 'الشروط']],
      rights: 'ذا ويف، القاهرة الجديدة',
      note: 'الصور فوتوغرافية وتصاميم توضيحية. المساحات استرشادية.',
      top: 'العودة للأعلى',
    },
    crumbs: { home: 'الرئيسية' },

    home: {
      title: 'ذا ويف، القاهرة الجديدة | أكثر من وجهة',
      description: 'ذا ويف وجهة جديدة على التسعين الشمالي بالقاهرة الجديدة: جناحان منحنيان حول ساحة مفتوحة، ومحلات على الساحة بتراسات خاصة، ومطاعم وأمسيات طويلة. قريباً.',
      hero: { kicker: 'التسعين الشمالي · القاهرة الجديدة', a: 'أكثر من', b: 'وجهة.', meta: 'قريباً', scroll: 'مرر' },
      lights: {
        kicker: 'مبنى واحد، من النهار إلى المساء',
        items: [
          { img: 'facade', time: '11:00', name: 'النهار', text: 'شرائط بيضاء أمام سماء صافية.' },
          { img: 'corner', time: '18:30', name: 'الغسق', text: 'الزاوية على التسعين الشمالي مع إضاءة الأنوار.' },
          { img: 'aerial', time: '20:00', name: 'المساء', text: 'الساحة تمتلئ تحت المظلات.' },
        ],
      },
      statement: 'جناحان منحنيان حول ساحة مفتوحة، في أكثر كتل القاهرة الجديدة حركة.',
      figures: [
        ['plazaUnits', 'محلاً على الساحة، لكل منها تراسه الخاص'],
        ['upperFloors', 'م² على أربعة طوابق وسطح'],
        ['parkingArea', 'م² مواقف على مستويين'],
        ['employees', 'شخص يعملون حول الكتلة كل يوم'],
      ],
      scenes: [
        { img: 'boutique', name: 'تسوّق', text: 'غرف هادئة، وحجر منحنٍ، ومختارات الموسم.' },
        { img: 'terrace', name: 'تناول', text: 'إفطار تحت المظلات، وعشاء على التراس.' },
        { img: 'steps', name: 'ابقَ', text: 'درج الساحة يواجه الغرب للساعة الذهبية.' },
      ],
      directory: { kicker: 'طابقاً طابقاً', title: 'من المواقف إلى السطح.', more: 'استكشف المبنى' },
      place: { kicker: 'التسعين الشمالي، القطاع الأول', text: 'بين طريقي التسعين. بنوك ومكاتب ومستشفيان بجوارنا، والمونوريل على بُعد خطوات.', more: 'خطط لزيارتك' },
      journal: { kicker: 'المدونة', more: 'كل القصص' },
      lease: { kicker: 'التأجير', text: 'وحدات من 61 إلى 301 م²، ومعظمها بتراس خاص.', more: 'اطّلع على الوحدات' },
    },

    building: {
      title: 'المبنى | ذا ويف، القاهرة الجديدة',
      description: 'جناحان منحنيان حول ساحة مفتوحة، وشرفة شريطية في كل طابق، وأربعة طوابق وسطح فوق ساحة من المحلات. مساحات الطوابق والمخططات.',
      hero: { a: 'جناحان،', b: 'وساحة واحدة.' },
      intro: 'المخطط على شكل ساعة رملية: جناحان ينحنيان نحو بعضهما حول ساحة مفتوحة. وكل طابق تحده شرفة شريطية تتبع المنحنى.',
      gallery: [
        { img: 'night', cap: 'واجهة التسعين الشمالي ليلاً' },
        { img: 'ribbon', cap: 'الشريط بعد الغروب' },
        { img: 'corner', cap: 'الزاوية عند الغسق · تصميم توضيحي' },
        { img: 'aerial', cap: 'الساحة من الأعلى · تصميم توضيحي' },
      ],
      directory: { kicker: 'الدليل', title: 'طابقاً طابقاً.', hint: 'اختر طابقاً', area: 'مساحة الطابق', spaces: 'مكان انتظار', units: 'محلاً على الساحة', street: 'محلات على الشارع', terraces: 'تراسات على الجناحين', indicative: 'مخططات مبسطة عن رسومات المعماري. استرشادية.' },
      mark: { kicker: 'الشعار', text: 'حيث يلتقي حرف A بحرف V، يرتفع خط واحد وينخفض مثل البحر. المنحنى نفسه يسري في المبنى.' },
    },

    experience: {
      title: 'التجربة | ذا ويف، القاهرة الجديدة',
      description: 'التسوق والمطاعم والأمسيات الطويلة في ذا ويف، القاهرة الجديدة: محلات على الساحة بتراسات، ومقاهٍ تحت المظلات، وساحة مفتوحة على السماء.',
      hero: { a: 'صباحات هادئة،', b: 'وأمسيات ذهبية.' },
      chapters: [
        { img: 'terrace', time: '09:00', name: 'الصباح', text: 'قهوة تحت المظلات في الساحة، قبل أن تعلو المدينة.' },
        { img: 'boutique', time: '12:00', name: 'الظهيرة', text: 'الموضة والجمال والأشياء التي تحتفظ بها، في غرف بُنيت حول الحجر والضوء.' },
        { img: 'steps', time: '17:00', name: 'الساعة الذهبية', text: 'درج الساحة يواجه الغرب. هذه هي الساعة التي رُسم المبنى من أجلها.' },
        { img: 'night', time: '21:00', name: 'المساء', text: 'عشاء على التراسات بينما تتوهج الشرائط.' },
      ],
      note: 'تُعلن قائمة الافتتاح في المدونة.',
      list: { title: 'ماذا ستجد', items: ['الأزياء والإكسسوارات', 'المقاهي والمطاعم', 'الجمال والعناية', 'المنزل وأسلوب الحياة', 'الخدمات والعيادات'] },
    },

    leasing: {
      title: 'التأجير | ذا ويف، القاهرة الجديدة',
      description: 'محلات من 61 إلى 301 م² في ذا ويف، القاهرة الجديدة، معظمها بتراس خاص. جدول وحدات الساحة والشارع، ومساحات الطوابق، واستفسارات التأجير.',
      hero: { a: 'مكان', b: 'لعلامتك.' },
      intro: 'ستة عشر محلاً تطل على الساحة، وسبعة أخرى تفتح على الشارع. ومعظمها بتراس خاص.',
      tabs: { ground: 'مستوى الساحة', street: 'مستوى الشارع' },
      table: { unit: 'الوحدة', indoor: 'داخلي', outdoor: 'تراس', total: 'الإجمالي', note: 'المساحات من جدول المطوّر بالمتر المربع. استرشادية وتخضع للقياس النهائي.' },
      why: [
        ['+6,000', 'شخص يعملون حول الكتلة'],
        ['2', 'مستشفيان وصف من البنوك بجوارنا'],
        ['19,069', 'م² مواقف أسفل المبنى'],
      ],
      form: {
        title: 'استفسر',
        fields: { name: 'الاسم', brand: 'العلامة التجارية', email: 'البريد الإلكتروني', phone: 'الهاتف أو واتساب', message: 'المفهوم والمساحة التي تفكر فيها', submit: 'أرسل الاستفسار', sending: 'جارٍ الإرسال' },
        ok: 'شكراً لك. سيتواصل معك فريق التأجير.',
        fail: 'هناك شيء ناقص. يرجى مراجعة النموذج.',
        privacy: 'تُستخدم للرد على هذا الاستفسار فقط.',
      },
    },

    visit: {
      title: 'الزيارة | ذا ويف، التسعين الشمالي، القاهرة الجديدة',
      description: 'يقع ذا ويف على شارع التسعين الشمالي في القطاع الأول بالقاهرة الجديدة، بين طريقي التسعين، بجوار مستشفى القوات الجوية وعلى بُعد خطوات من المونوريل.',
      hero: { a: 'التسعين الشمالي،', b: 'القطاع الأول.' },
      intro: 'في الكتلة بين طريقي التسعين، وسط البنوك والمكاتب والمستشفيات التي تُبقي القطاع الأول نابضاً كل يوم.',
      labels: { plot: 'ذا ويف', north90: 'التسعين الشمالي', south90: 'التسعين الجنوبي · المونوريل', airforce: 'مستشفى القوات الجوية', nasaaem: 'مستشفى نسائم', nbk: 'بنك الكويت الوطني', fab: 'بنك أبوظبي الأول' },
      mapAlt: 'صورة فضائية للقطاع الأول بالقاهرة الجديدة مع ذا ويف بين التسعين الشمالي والجنوبي.',
      address: 'شارع التسعين الشمالي، القطاع الأول، القاهرة الجديدة، مصر',
      button: 'افتح في خرائط جوجل',
      rows: [
        ['بالسيارة', 'من التسعين الشمالي أو الجنوبي. مستويان من المواقف أسفل المبنى.'],
        ['بالمونوريل', 'خط شرق النيل، محطة مستشفى القوات الجوية.'],
        ['بتطبيقات النقل', 'ابحث عن «ذا ويف، التسعين الشمالي».'],
      ],
    },
  },
};

for (const l of ['en', 'ar']) Object.assign(content[l], KEEP[l]);

module.exports = { content };
