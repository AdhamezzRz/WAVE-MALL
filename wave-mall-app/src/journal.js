'use strict';

// Journal articles. Body is a small markup: blank-line paragraphs, "## " headings, "> " pull quotes.
// Dates are ISO; the newest post leads the index.

const posts = [
  {
    slug: 'the-story-behind-our-mark',
    date: '2026-10-20',
    img: 'sculpture',
    tag: { en: 'Identity', ar: 'الهوية' },
    en: {
      title: 'The story behind our mark',
      excerpt: 'Where the A meets the V, a single line rises and falls like the sea. How The Wave’s wordmark came to be, and the four colourways it lives in.',
      body: `Look closely at the logo. Where the A meets the V, a single line rises and falls like the sea. It is the moment our name becomes a shape, and it is the whole idea of the place: somewhere that flows.

## One stroke, two letters

The wordmark is set in a high-contrast serif, the kind you find on the cover of a fashion magazine. Thin hairlines, heavy stems, generous curves. We asked for one change: the crossbar of the A should not stop. It should carry on, dip, and climb into the V as a single wave.

That stroke now sits everywhere, from the façade signage to the stitching on a shopping bag.

## Four colourways

The identity lives in four colours taken from the sea, the desert and the light of New Cairo: palm forest, cocoa, sea glass and desert sand. Each colourway pairs two of them, so the mark can sit on a dark storefront, a paper bag or a sunlit wall and still feel like itself.

> A place that flows, drawn in one line.

## The pattern

Repeat the A–V ligature, offset every second row, and you get a pattern that reads as water from across the room and as letters up close. You will find it on wrapping paper, in the lifts, and on the inside of the gift boxes.`,
    },
    ar: {
      title: 'القصة وراء شعارنا',
      excerpt: 'حيث يلتقي حرف A بحرف V، يرتفع خط واحد وينخفض مثل البحر. كيف وُلد شعار ذا ويف، وألوانه الأربعة.',
      body: `انظر عن قرب إلى الشعار. حيث يلتقي حرف A بحرف V، يرتفع خط واحد وينخفض مثل البحر. إنها اللحظة التي يصبح فيها اسمنا شكلاً، وهي فكرة المكان كلها: مكان ينساب.

## ضربة واحدة، حرفان

كُتب الشعار بخط سيريف عالي التباين، من النوع الذي تجده على غلاف مجلة أزياء. خطوط رفيعة وسيقان ثقيلة ومنحنيات سخية. طلبنا تغييراً واحداً: ألا يتوقف الخط الأفقي لحرف A، بل يستمر وينخفض ثم يصعد إلى حرف V كموجة واحدة.

## أربعة ألوان

تعيش الهوية في أربعة ألوان مستوحاة من البحر والصحراء وضوء القاهرة الجديدة: غابة النخيل، والكاكاو، وزجاج البحر، ورمال الصحراء. كل تركيبة تجمع لونين منها، ليبقى الشعار نفسه على واجهة داكنة أو كيس ورقي أو جدار مشمس.

> مكان ينساب، مرسوم بخط واحد.

## النقش

كرّر الحرفين A وV مع إزاحة كل صف ثانٍ، فتحصل على نقش يبدو ماءً من بعيد وحروفاً من قريب. ستجده على ورق التغليف وداخل المصاعد وعلى بطانة علب الهدايا.`,
    },
  },
  {
    slug: 'designed-to-flow',
    date: '2026-10-12',
    img: 'cornerdusk',
    tag: { en: 'Architecture', ar: 'العمارة' },
    en: {
      title: 'Designed to flow',
      excerpt: 'A ribbon balcony on every floor, a stone portal on the street and a plaza of open-air terraces. The thinking behind the building.',
      body: `The brief was simple to say and hard to do: make a building that moves. The answer was a ribbon.

## The ribbon

Every floor of The Wave is wrapped in a continuous balcony that bends with the plan. From the plaza the façade reads as one curve folding back on itself; from the street it is a stack of soft horizontal lines that catch the sun at the end of the day.

The ribbons do practical work too. They shade the glass below them, carry the planting, and give every upper-floor terrace a place to sit outside.

## The portal

Where the curve meets the street, a stone portal anchors the glass. It is the one straight thing in the composition, and it marks the main entrance from North 90.

## The plaza

Ground-floor shopfronts open directly onto a plaza of terraces and shallow steps. Cafés spill outside; the steps double as seating at golden hour. It is designed to be the slowest part of the building.

> Curves that move like the sea, light that follows you in.`,
    },
    ar: {
      title: 'صُمّم لينساب',
      excerpt: 'شرفة شريطية في كل طابق، وبوابة حجرية على الشارع، وساحة من التراسات المفتوحة. الفكرة وراء المبنى.',
      body: `كان الطلب بسيطاً في قوله صعباً في تنفيذه: مبنى يتحرك. وكان الجواب شريطاً.

## الشريط

كل طابق في ذا ويف يلتف حوله شريط متصل من الشرفات ينحني مع المخطط. من الساحة تبدو الواجهة منحنى واحداً ينطوي على نفسه، ومن الشارع هي طبقات من الخطوط الأفقية الناعمة تلتقط الشمس في آخر النهار.

للشرائط عمل عملي أيضاً: تظلل الزجاج تحتها، وتحمل النباتات، وتمنح كل تراس في الطوابق العليا مكاناً للجلوس في الخارج.

## البوابة

حيث يلتقي المنحنى بالشارع، ترسّخ بوابة حجرية الزجاج. إنها الشيء المستقيم الوحيد في التكوين، وتحدد المدخل الرئيسي من التسعين الشمالي.

## الساحة

تفتح واجهات الطابق الأرضي مباشرة على ساحة من التراسات والدرج المنخفض. المقاهي تمتد إلى الخارج، والدرج يصبح مقاعد وقت الغروب. صُمّمت لتكون أبطأ جزء في المبنى.

> منحنيات تتحرك مثل البحر، وضوء يرافقك إلى الداخل.`,
    },
  },
  {
    slug: 'a-day-at-the-wave',
    date: '2026-10-05',
    img: 'axis',
    tag: { en: 'Lifestyle', ar: 'أسلوب الحياة' },
    en: {
      title: 'A day at The Wave',
      excerpt: 'From first coffee to last light: an unhurried itinerary for a Saturday in New Cairo.',
      body: `Times below are a way of thinking about the place, not opening hours. Those come with the opening date.

## 10:00, coffee on the terrace

Start upstairs, where the ribbons face east. The terrace catches the morning before the heat does. Order slowly.

## 12:30, the style edit

Walk the plaza floor while the light is high and the shopfronts are at their brightest. Camel, cream and a touch of green are the season’s colours, and ours.

## 17:00, golden hour on the steps

The plaza steps face west for a reason. This is the hour the building was drawn for, when the curves turn gold and everyone slows down.

## 20:30, dinner under the lights

After dark the balconies become lines of light. Dinner on the terrace, dessert on the steps, and the city glittering beyond South 90.

> Save this for your weekend.`,
    },
    ar: {
      title: 'يوم في ذا ويف',
      excerpt: 'من أول قهوة إلى آخر ضوء: برنامج هادئ ليوم سبت في القاهرة الجديدة.',
      body: `المواعيد أدناه طريقة للتفكير في المكان، وليست مواعيد العمل. تلك تأتي مع موعد الافتتاح.

## 10:00، قهوة على التراس

ابدأ في الأعلى، حيث تواجه الشرفات الشرق. يلتقط التراس الصباح قبل الحر. اطلب على مهل.

## 12:30، جولة التسوق

تمشَّ في طابق الساحة والضوء عالٍ والواجهات في أبهى حالاتها. الكاميل والكريمي ولمسة من الأخضر ألوان الموسم، وألواننا.

## 17:00، الساعة الذهبية على الدرج

يواجه درج الساحة الغرب لسبب. هذه هي الساعة التي رُسم المبنى من أجلها، حين تتحول المنحنيات إلى ذهب ويتباطأ الجميع.

## 20:30، عشاء تحت الأضواء

بعد الغروب تصبح الشرفات خطوطاً من الضوء. عشاء على التراس، وحلوى على الدرج، والمدينة تتلألأ وراء التسعين الجنوبي.

> احفظ هذا لعطلة نهاية الأسبوع.`,
    },
  },
  {
    slug: 'north-90-a-short-guide',
    date: '2026-09-26',
    img: 'north90',
    tag: { en: 'Neighbourhood', ar: 'الحي' },
    en: {
      title: 'North 90, a short guide',
      excerpt: 'Hospitals, banks, schools and a monorail station: why the First Sector is one of the busiest blocks in New Cairo, every day of the week.',
      body: `The Wave sits on the block between North 90 and South 90, in the First Sector of New Cairo. It is not a quiet address, and that is the point.

## The working day

Within a few hundred metres are the Air Force Specialized Hospital, Nasaaem Hospital and a row of bank headquarters. Offices fill the surrounding blocks. The First Sector has a weekday crowd that most malls have to wait until the weekend for.

## Schools and families

More than five international schools sit within about 1.3 km, which shapes the rhythm of the afternoon: a school run, a coffee, an errand, an early dinner.

## Getting here

The East Nile monorail runs along South 90, with the Air Force Hospital station a short walk from the plaza. By car, both Teseen roads lead to the door, and parking is on site. Cairo Festival City is 2.5 km away.

> Between the two Teseen roads, in the middle of the working week.`,
    },
    ar: {
      title: 'التسعين الشمالي، دليل قصير',
      excerpt: 'مستشفيات وبنوك ومدارس ومحطة مونوريل: لماذا يُعد القطاع الأول من أكثر أحياء القاهرة الجديدة حركة كل يوم.',
      body: `يقع ذا ويف في الكتلة بين التسعين الشمالي والتسعين الجنوبي، في القطاع الأول بالقاهرة الجديدة. ليس عنواناً هادئاً، وهذا هو المقصود.

## يوم العمل

على بُعد مئات الأمتار يقع مستشفى القوات الجوية التخصصي ومستشفى نسائم وصف من مقرات البنوك. المكاتب تملأ الكتل المحيطة. للقطاع الأول جمهور في أيام الأسبوع تنتظره معظم المولات حتى عطلة نهاية الأسبوع.

## المدارس والعائلات

أكثر من خمس مدارس دولية في نطاق نحو 1.3 كم، وهو ما يرسم إيقاع فترة الظهيرة: مشوار المدرسة، قهوة، مهمة، وعشاء مبكر.

## كيف تصل

يمر مونوريل شرق النيل على التسعين الجنوبي، ومحطة مستشفى القوات الجوية على بُعد خطوات من الساحة. بالسيارة، يقود طريقا التسعين إلى الباب، والمواقف داخل المشروع. كايرو فستيفال سيتي على بُعد 2.5 كم.

> بين طريقي التسعين، في منتصف أسبوع العمل.`,
    },
  },
  {
    slug: 'the-autumn-edit',
    date: '2026-09-18',
    img: 'shopfronts',
    tag: { en: 'Style', ar: 'الأناقة' },
    en: {
      title: 'The Autumn Edit, Vol. 01',
      excerpt: 'Camel, cream and a touch of green: the colours of the season, and of The Wave.',
      body: `Every season we will put together a short edit of what we are wearing, carrying and coveting. The first one is about three colours.

## Camel

A trench, a knit, a pair of loafers. Camel does the work of a neutral while being warmer than one. It photographs beautifully against stone, which is convenient.

## Cream

The colour of the plaza at noon. Cream next to camel is the whole autumn palette in two pieces.

## A touch of green

Our own green, the deep palm forest of the identity, shows up this season as a bag, a scarf, a single lacquered nail. One piece is enough.

> New season, new looks. Your next one starts with a walk through The Wave.`,
    },
    ar: {
      title: 'مختارات الخريف، العدد الأول',
      excerpt: 'الكاميل والكريمي ولمسة من الأخضر: ألوان الموسم، وألوان ذا ويف.',
      body: `كل موسم سنجمع مختارات قصيرة مما نرتديه ونحمله ونشتهيه. الأولى عن ثلاثة ألوان.

## الكاميل

معطف ترنش، وكنزة، وحذاء لوفر. يقوم الكاميل بعمل اللون المحايد وهو أدفأ منه. ويُصوَّر بجمال أمام الحجر، وهذا مناسب.

## الكريمي

لون الساحة عند الظهيرة. الكريمي بجانب الكاميل هو لوحة الخريف كلها في قطعتين.

## لمسة من الأخضر

أخضرنا، غابة النخيل العميقة في الهوية، يظهر هذا الموسم في حقيبة أو وشاح أو طلاء ظفر واحد. قطعة واحدة تكفي.

> موسم جديد وإطلالات جديدة. إطلالتك القادمة تبدأ بجولة في ذا ويف.`,
    },
  },
  {
    slug: 'after-dark',
    date: '2026-09-10',
    img: 'tower',
    tag: { en: 'Evenings', ar: 'الأمسيات' },
    en: {
      title: 'After dark, The Wave glows',
      excerpt: 'How the building was lit so that the curves turn into lines of light, and the evening begins.',
      body: `Most buildings are designed for the daytime and lit as an afterthought. The Wave was drawn with the evening in mind.

## Lines, not floods

Each ribbon balcony carries a continuous warm line of light along its underside. There are no floodlights on the façade. At dusk the lines switch on one floor at a time, and the building redraws itself.

## Warm, not white

The colour temperature is close to candlelight. It flatters the stone, the terraces and the people on them.

## The plaza at night

Lanterns in the planting, the glow of the shopfronts and the reflections on the wet steps after the evening wash-down. It is the quietest, best-looking hour of the day.

> The curves become lines of light, and the evening begins.`,
    },
    ar: {
      title: 'بعد الغروب، تتوهج ذا ويف',
      excerpt: 'كيف أُضيء المبنى لتتحول المنحنيات إلى خطوط من الضوء، وتبدأ الأمسية.',
      body: `تُصمَّم معظم المباني للنهار وتُضاء كفكرة لاحقة. أما ذا ويف فرُسم والمساء في البال.

## خطوط لا كشافات

يحمل كل شريط من الشرفات خطاً متصلاً من الضوء الدافئ على جانبه السفلي. لا كشافات على الواجهة. عند الغسق تضيء الخطوط طابقاً بعد طابق، ويعيد المبنى رسم نفسه.

## دافئ لا أبيض

درجة حرارة اللون قريبة من ضوء الشموع. تُجمّل الحجر والتراسات ومن عليها.

## الساحة ليلاً

فوانيس بين النباتات، وتوهج الواجهات، وانعكاسات على الدرج المبلل بعد غسل المساء. إنها أهدأ ساعات اليوم وأجملها.

> تتحول المنحنيات إلى خطوط من الضوء، وتبدأ الأمسية.`,
    },
  },
];

const sorted = () => [...posts].sort((a, b) => (a.date < b.date ? 1 : -1));
const bySlug = (slug) => posts.find((p) => p.slug === slug);
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const readingMinutes = (text) => Math.max(1, Math.round(words(text) / 180));
const related = (post, n = 2) => sorted().filter((p) => p.slug !== post.slug).slice(0, n);

// Body markup to HTML. `esc` is injected to keep render.js the single escaping place.
function renderBody(body, esc) {
  return body
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const b = block.trim();
      if (b.startsWith('## ')) return `<h2>${esc(b.slice(3))}</h2>`;
      if (b.startsWith('> ')) return `<blockquote><p>${esc(b.slice(2))}</p></blockquote>`;
      return `<p>${esc(b)}</p>`;
    })
    .join('\n');
}

module.exports = { posts, sorted, bySlug, readingMinutes, related, renderBody };
