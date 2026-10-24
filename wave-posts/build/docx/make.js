const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, LevelFormat, PageBreak, Footer, PageNumber, VerticalAlign } = require('docx');
const S = __dirname;
const OUT = process.argv[2];
const FOREST = '1D3A2E', COCOA = '5A3B22', CARAMEL = '7A4826', MUTED = '6F6A60';

const posts = [
 { n: '07', file: '07-the-autumn-edit', title: 'The Autumn Edit', type: 'Fashion · carousel cover',
   visual: 'Magazine-cover style. The top 70% is a photo of hands carrying a cream shopping bag with green ribbon handles and a green leather bag, walking down stone steps at golden hour. Below is a cream panel with cocoa text, a small logo top left and "VOL. 01" top right.',
   on: ['the AUTUMN EDIT', 'CAMEL, CREAM AND A TOUCH OF GREEN.', 'SWIPE →'],
   en: ['The Autumn Edit, Vol. 01.', "Camel, cream and a touch of green: the colours of the season, and of The Wave. Swipe for the pieces we're loving now."],
   ar: ['مختارات الخريف، العدد الأول.', 'درجات الكاميل والكريمي ولمسة من الأخضر، ألوان الموسم وألوان ذا ويف. اسحب لترى القطع المفضلة لدينا.'],
   extra: [['Carousel slides 2–5', 'One look or product per slide from a tenant, tagged with their handle.']],
   goal: 'Fashion authority and tenant promotion, aiming for saves and shares.' },
 { n: '08', file: '08-the-story-of-our-mark', title: 'The Story Behind Our Mark', type: 'Brand story',
   visual: 'A gold-foil close-up of the A–V curve from the logo on deep forest green.',
   on: ['THE STORY BEHIND OUR MARK', 'one stroke, TWO LETTERS, ONE WAVE.', 'Where the A meets the V, a single line rises and falls like the sea. It is the moment our name becomes a shape.'],
   en: ['One stroke, two letters, one wave.', 'Look closely at our logo: where the A meets the V, a single line rises and falls like the sea. That curve is the whole idea of The Wave, a place that flows.'],
   ar: ['ضربة واحدة، حرفان، موجة واحدة.', 'انظر عن قرب إلى شعارنا: حيث يلتقي حرف A بحرف V، يرتفع خط واحد وينخفض مثل البحر. هذا المنحنى هو فكرة ذا ويف كلها، مكان ينساب.'],
   extra: [['Reel idea', 'A slow camera pan across the gold foil, ending on the full logo.']],
   goal: 'Give the new logo a meaning people remember and repeat.' },
 { n: '09', file: '09-colours-of-the-wave', title: 'Colours of The Wave', type: 'Identity',
   visual: "Cream background with six arch-shaped swatches (the arches echo the building's curves). Each swatch has a name and colour code.",
   on: ['COLOURS OF The Wave', 'Sea Glass #B3DCCF', 'Cocoa #5A3B22', 'Caramel #7A4826', 'Desert Sand #BBA286', 'Palm Forest #1D3A2E', 'Gold Hour (foil)'],
   en: ['The colours of The Wave.', 'Sea Glass, Cocoa, Caramel, Desert Sand, Palm Forest and Gold Hour: six shades taken from the sea, the desert and the light of New Cairo. Which one is yours?'],
   ar: ['ألوان ذا ويف.', 'زجاج البحر، الكاكاو، الكراميل، رمال الصحراء، غابة النخيل، والساعة الذهبية: ستة ألوان مستوحاة من البحر والصحراء وضوء القاهرة الجديدة. أي لون يشبهك؟'],
   extra: [],
   goal: 'Comments and recall of the new identity. The palette also works as a guide for tenants and content creators.' },
 { n: '10', file: '10-a-day-at-the-wave', title: 'A Day at The Wave', type: 'Lifestyle itinerary',
   visual: 'Warm sand background with a timeline. Times are in an elegant italic serif and activities in capitals, separated by fine lines.',
   on: ['a day at THE WAVE', '10:00 COFFEE ON THE TERRACE', '12:30 THE STYLE EDIT', '17:00 GOLDEN HOUR ON THE STEPS', '20:30 DINNER UNDER THE LIGHTS', 'SAVE THIS FOR YOUR WEEKEND'],
   en: ['A day at The Wave.', 'Coffee on the terrace at ten, the style edit at half past twelve, golden hour on the steps at five, dinner under the lights at half past eight. Save this for your weekend.'],
   ar: ['يوم في ذا ويف.', 'قهوة على التراس في العاشرة، جولة تسوق في الثانية عشرة والنصف، الساعة الذهبية على الدرج في الخامسة، وعشاء تحت الأضواء في الثامنة والنصف. احفظ المنشور لعطلة نهاية الأسبوع.'],
   extra: [['Story idea', 'Four story frames, one per time, each tagging a real tenant.'], ['Note', 'The times are illustrative. Check them against real opening hours before posting.']],
   goal: 'Saves and planned visits.' },
 { n: '11', file: '11-after-dark', title: 'After Dark', type: 'Architecture at night',
   visual: "The building's curved balconies traced by warm LED lines against a deep night sky, with blurred figures on the wet plaza and no signage.",
   on: ['AFTER DARK, the wave glows.'],
   en: ['After dark, The Wave glows.', 'The curves turn into lines of light, and the evening begins.'],
   ar: ['بعد الغروب، تتوهج ذا ويف.', 'تتحول المنحنيات إلى خطوط من الضوء، وتبدأ الأمسية.'],
   extra: [['Reel idea', 'A time-lapse of the LED lines switching on at dusk.']],
   goal: 'Position The Wave as an evening destination for dining and nights out.' },
 { n: '12', file: '12-which-wave-are-you', title: 'Which Wave Are You?', type: 'Engagement',
   visual: 'Forest-green stripes with a cream arch-shaped card holding four lettered options.',
   on: ['WHICH WAVE are you?', 'A · THE MORNING WAVE, coffee and calm', 'B · THE STYLE WAVE, new season, new looks', 'C · THE GOLDEN WAVE, sunset on the terrace', 'D · THE NIGHT WAVE, dinner and city lights', 'TELL US YOUR LETTER IN THE COMMENTS'],
   en: ['Which wave are you? A, B, C or D?', 'Tell us your letter in the comments and tag the friend who shares your wave.'],
   ar: ['أي موجة أنت؟', 'أ: موجة الصباح، قهوة وهدوء.', 'ب: موجة الأناقة، موسم جديد وإطلالات جديدة.', 'ج: الموجة الذهبية، غروب على التراس.', 'د: موجة الليل، عشاء وأضواء المدينة.', 'اكتب حرفك في التعليقات وشارك صديقاً يشبهك.'],
   extra: [['Follow-up', 'Reply to each comment with a matching tenant recommendation, and run a story poll with the same four options.']],
   goal: 'Comments, tags and reach.' },
];

const label = (t) => new Paragraph({ spacing: { before: 200, after: 60 }, children: [new TextRun({ text: t.toUpperCase(), bold: true, size: 17, color: CARAMEL, characterSpacing: 40 })] });
const body = (t, o = {}) => new Paragraph({ spacing: { after: 80, line: 300 }, children: [new TextRun({ text: t, size: 21, ...o })] });
const bullet = (t) => new Paragraph({ numbering: { reference: 'b', level: 0 }, spacing: { after: 40 }, children: [new TextRun({ text: t, size: 21 })] });
const ar = (t) => new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, spacing: { after: 80, line: 320 }, children: [new TextRun({ text: t, size: 23, rightToLeft: true, font: { ascii: 'Arial', cs: 'Arial' } })] });
const rule = () => new Paragraph({ spacing: { before: 120, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D9D2C3', space: 1 } }, children: [] });
const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };

const children = [];
// Cover
children.push(new Paragraph({ spacing: { before: 1800, after: 120 }, children: [new TextRun({ text: 'THE WAVE · NEW CAIRO MALL', bold: true, size: 20, color: CARAMEL, characterSpacing: 60 })] }));
children.push(new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 200 }, children: [new TextRun({ text: 'Instagram Content, Set 2', font: 'Georgia', size: 64, color: FOREST })] }));
children.push(new Paragraph({ spacing: { after: 400 }, children: [new TextRun({ text: 'Posts 07–12: on-visual copy, captions in English and Arabic, visual direction and goals', size: 24, color: MUTED })] }));
children.push(label('Format'));
children.push(body('1080 × 1350 px (4:5). The image files are named 07–12 to match the posts below.'));
children.push(label('Brand line'));
children.push(body('More than a destination.', { italics: true }));
children.push(label('Hashtags (5–8 per post)'));
children.push(body('#TheWave #TheWaveMall #NewCairo #MoreThanADestination #NewCairoMall #ذا_ويف #القاهرة_الجديدة'));
children.push(label('Before posting'));
children.push(bullet('The Arabic captions are drafts and need a native copywriter’s review.'));
children.push(bullet('Post 10 uses illustrative times. Check them against real opening hours.'));
children.push(bullet('Posts 07 and 11 use AI photography made with Higgsfield. Posts 08, 09, 10 and 12 are designed posts built from the logo and palette.'));

for (const p of posts) {
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: `POST ${p.n} · ${p.type.toUpperCase()}`, bold: true, size: 18, color: CARAMEL, characterSpacing: 50 })] }));
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 160 }, children: [new TextRun({ text: p.title, font: 'Georgia', size: 44, color: FOREST })] }));
  const img = new ImageRun({ type: 'jpg', data: fs.readFileSync(path.join(S, p.file + '.jpg')), transformation: { width: 216, height: 270 } });
  const left = [label('Visual'), body(p.visual), label('On the post'), ...p.on.map(bullet)];
  children.push(new Table({ width: { size: 9026, type: WidthType.DXA }, columnWidths: [3400, 5626], borders: noBorders, rows: [new TableRow({ children: [
    new TableCell({ width: { size: 3400, type: WidthType.DXA }, borders: noBorders, verticalAlign: VerticalAlign.TOP, children: [new Paragraph({ children: [img] })] }),
    new TableCell({ width: { size: 5626, type: WidthType.DXA }, borders: noBorders, margins: { left: 200 }, children: left }),
  ] })] }));
  children.push(rule());
  children.push(label('Caption (English)'));
  p.en.forEach((t, i) => children.push(body(t, i === 0 ? { bold: true } : {})));
  children.push(label('Caption (Arabic)'));
  p.ar.forEach(t => children.push(ar(t)));
  for (const [k, v] of p.extra) { children.push(label(k)); children.push(body(v)); }
  children.push(label('Goal'));
  children.push(body(p.goal));
}

const doc = new Document({
  creator: 'NAJ', title: 'The Wave · Instagram Content, Set 2',
  styles: { default: { document: { run: { font: 'Calibri', size: 21, color: '2B2A27' } } } },
  numbering: { config: [{ reference: 'b', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } } } }] }] },
  sections: [{
    properties: { page: { margin: { top: 1300, bottom: 1200, left: 1440, right: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'The Wave · Instagram content, set 2 · ', size: 16, color: MUTED }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED })] })] }) },
    children,
  }],
});
Packer.toBuffer(doc).then(b => { fs.writeFileSync(OUT, b); console.log('wrote', OUT, b.length); });
