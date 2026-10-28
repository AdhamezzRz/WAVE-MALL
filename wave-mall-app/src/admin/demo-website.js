'use strict';

// Sample website content: the four sample tenants listed in the directory (one of them still
// opening), Atelier Nour's listing in preparation, three events (one already past) and an opening
// offer. Logos and covers are drawn here as SVG so the sample needs no photographs.
// Every name here is fictional.

const M = require('./model');

const STORES = {
  'Maison Lune': {
    name_ar: 'ميزون لون', featured: 1, palette: ['#283833', '#a2c5b9', '#e9e4d6'],
    tagline: 'Fluid tailoring for long Cairo evenings', tagline_ar: 'تفصيل انسيابي لأمسيات القاهرة الطويلة',
    description: 'Maison Lune dresses the city for its evenings: fluid tailoring, linen for the long summers and soft knits for the cooler months.\n\nA small atelier at the back of the store takes care of alterations while you wait for your coffee on the plaza.',
    description_ar: 'تُلبس ميزون لون المدينة لأمسياتها: تفصيل انسيابي، وكتان للصيف الطويل، وتريكو ناعم للأشهر الأبرد.\n\nوفي آخر المتجر مشغل صغير يتولى تعديلات المقاس بينما تنتظر قهوتك على الساحة.',
  },
  'Kahwa House': {
    name_ar: 'قهوة هاوس', palette: ['#7c4d28', '#d1c9b3', '#fbfaf6'],
    tagline: 'Small-batch coffee, breakfast until late', tagline_ar: 'قهوة محمصة بكميات صغيرة وإفطار حتى وقت متأخر',
    description: 'Specialty coffee roasted in small batches, breakfast served until late and a terrace that faces the open court.\n\nThe first light of the morning at The Wave starts here.',
    description_ar: 'قهوة مختصة محمصة بكميات صغيرة، وإفطار يُقدَّم حتى وقت متأخر، وتراس يطل على الساحة المفتوحة.\n\nمن هنا يبدأ أول ضوء للصباح في ذا ويف.',
  },
  'Saffron Table': {
    name_ar: 'سافرون تيبل', palette: ['#212f2a', '#c39136', '#e9e4d6'],
    tagline: 'Charcoal grills and mezze to share', tagline_ar: 'مشويات على الفحم ومقبلات للمشاركة',
    description: 'A modern Levantine and Egyptian table: charcoal grills, mezze to share and slow-cooked dishes from family recipes.\n\nThe kitchen stays open late for the court\'s long evenings, and the terrace seats forty under the awning.',
    description_ar: 'مائدة شامية ومصرية بروح عصرية: مشويات على الفحم، ومقبلات للمشاركة، وأطباق مطهوة على مهل من وصفات العائلة.\n\nيبقى المطبخ مفتوحًا حتى وقت متأخر لأمسيات الساحة الطويلة، ويتسع التراس لأربعين ضيفًا تحت المظلة.',
  },
  'Lumière Beauty': {
    name_ar: 'لوميير بيوتي', palette: ['#a2c5b9', '#fbfaf6', '#283833'],
    tagline: 'Skincare, fragrance and a beauty bar', tagline_ar: 'العناية بالبشرة والعطور وركن للتجميل',
    description: 'Skincare and fragrance from independent houses, with a beauty bar for quick consultations and a testers wall to try before you choose.',
    description_ar: 'منتجات العناية بالبشرة والعطور من دور مستقلة، مع ركن للتجميل لاستشارات سريعة وحائط للتجربة قبل أن تختار.',
  },
  'Atelier Nour': {
    name_ar: 'أتيليه نور', palette: ['#d1c9b3', '#283833', '#fbfaf6'], draft: true,
    tagline: 'Hand-finished occasion wear', tagline_ar: 'أزياء المناسبات بلمسات يدوية',
  },
};

const EVENTS = [
  {
    slug: 'plaza-nights-live-jazz', start: 9, days: 3, from: '19:30', to: '23:00', featured: 1, palette: ['#212f2a', '#c39136', '#a2c5b9'],
    title: 'Plaza Nights: live jazz on the court', title_ar: 'ليالي الساحة: جاز حي في الساحة المفتوحة',
    location: 'The open court', location_ar: 'الساحة المفتوحة',
    summary: 'Three evenings of live jazz under the sky, with the terraces open late.', summary_ar: 'ثلاث أمسيات من موسيقى الجاز الحية تحت السماء، مع تراسات مفتوحة حتى وقت متأخر.',
    description: 'For three evenings the open court becomes a listening room. A quartet plays two sets a night, and the plaza terraces stay open until the last note.\n\nEntry is free; seats around the stage can be reserved.',
    description_ar: 'تتحول الساحة المفتوحة لثلاث أمسيات إلى قاعة استماع. يعزف رباعي موسيقي فقرتين كل ليلة، وتبقى تراسات الساحة مفتوحة حتى آخر نغمة.\n\nالدخول مجاني، ويمكن حجز المقاعد حول المسرح.',
    rsvp: 'https://thewavemall.com/contact/',
  },
  {
    slug: 'preview-weekend', start: 20, days: 2, from: '12:00', to: '22:00', palette: ['#283833', '#e9e4d6', '#a2c5b9'],
    title: 'Preview weekend: meet the first stores', title_ar: 'عطلة التعارف: تعرّف على أول المتاجر',
    location: 'Plaza level', location_ar: 'مستوى الساحة',
    summary: 'Walk the plaza before the opening and meet the brands moving in.', summary_ar: 'تجوّل في الساحة قبل الافتتاح وتعرّف على العلامات التي تنتقل إليها.',
    description: 'A first look at The Wave: guided walks of the plaza every hour, previews from the first stores and coffee on the court.',
    description_ar: 'نظرة أولى على ذا ويف: جولات مصحوبة في الساحة كل ساعة، وعروض أولى من المتاجر الأولى، وقهوة في الساحة.',
  },
  {
    slug: 'little-makers-workshops', start: -24, days: 2, from: '11:00', to: '15:00', palette: ['#7c4d28', '#fbfaf6', '#d1c9b3'],
    title: 'Little Makers: weekend workshops', title_ar: 'صُنّاع صغار: ورش عطلة نهاية الأسبوع',
    location: 'North terrace', location_ar: 'التراس الشمالي',
    summary: 'Clay, paper and paint for children aged five to twelve.', summary_ar: 'صلصال وورق وألوان للأطفال من خمس إلى اثنتي عشرة سنة.',
    description: 'Two mornings of hands-on workshops for children, led by local artists.', description_ar: 'صباحان من الورش العملية للأطفال بقيادة فنانين محليين.',
  },
];

const PROMO = {
  brand: 'Maison Lune', start: -3, end: 11, palette: ['#283833', '#a2c5b9', '#fbfaf6'],
  title: 'Opening weeks: 20% off the new collection', title_ar: 'أسابيع الافتتاح: خصم 20% على المجموعة الجديدة',
  details: 'On the autumn collection, in store at The Wave, while sizes last.', details_ar: 'على مجموعة الخريف، في متجر ذا ويف، حتى نفاد المقاسات.',
};

// ---------- the drawings ----------
const seed = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const rnd = (n) => () => {
  n = (n * 1664525 + 1013904223) >>> 0;
  return n / 4294967296;
};
// A landscape cover: soft bands of colour, the building's curve and a fine hourglass line.
function coverSvg(key, [a, b, c]) {
  const r = rnd(seed(key));
  const waves = [0, 1, 2, 3].map((i) => {
    const y = 380 + i * 120 + r() * 60;
    const k = 120 + r() * 160;
    return `<path d="M0 ${y.toFixed(0)} C 400 ${(y - k).toFixed(0)}, 1000 ${(y + k).toFixed(0)}, 1600 ${(y - 40).toFixed(0)} L1600 900 L0 900 Z" fill="${i % 2 ? b : c}" opacity="${(0.18 + i * 0.12).toFixed(2)}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}" stop-opacity=".85"/></linearGradient></defs>
<rect width="1600" height="900" fill="url(#g)"/>${waves}
<path d="M560 140 L1040 140 C1120 300 1120 600 1040 760 L560 760 C480 600 480 300 560 140 Z" fill="none" stroke="${c}" stroke-opacity=".55" stroke-width="2"/>
<circle cx="${(1200 + r() * 240).toFixed(0)}" cy="${(170 + r() * 120).toFixed(0)}" r="${(60 + r() * 50).toFixed(0)}" fill="${c}" opacity=".35"/>
</svg>`;
}
// A square logo: initials in a ring.
function logoSvg(name, [a, , c]) {
  const ini = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
<rect width="400" height="400" fill="${a}"/><circle cx="200" cy="200" r="150" fill="none" stroke="${c}" stroke-width="3"/><circle cx="200" cy="200" r="138" fill="none" stroke="${c}" stroke-opacity=".4" stroke-width="1"/>
<text x="200" y="228" text-anchor="middle" font-family="Didot, 'Bodoni 72', Georgia, serif" font-size="96" letter-spacing="4" fill="${c}">${ini}</text>
</svg>`;
}

function load(db, admin, { h } = {}) {
  const w = h && h.website;
  if (!w) return; // needs the running office
  const T = M.today();
  const day = (n) => M.addDays(T, n);
  const img = (svg, name) => w.saveImage(Buffer.from(svg), name, { demo: 1, svg: true }).id;
  db.tx(() => {
    for (const [name, s] of Object.entries(STORES)) {
      const b = db.get('SELECT * FROM brands WHERE name = ? AND demo = 1 ORDER BY id DESC LIMIT 1', name);
      if (!b) continue;
      const id = w.createStore(b.id, { demo: 1, user: admin });
      if (!id) continue;
      db.run("DELETE FROM audit WHERE entity = 'web_store' AND entity_id = ?", id);
      const live = !s.draft && db.value("SELECT COUNT(*) FROM leases WHERE brand_id = ? AND status = 'active'", b.id);
      db.run(
        `UPDATE web_stores SET name_ar = ?, tagline = ?, tagline_ar = ?, description = ?, description_ar = ?, logo_id = ?, cover_id = ?, featured = ?, published = ?, published_at = ?, demo = 1, updated_at = ? WHERE id = ?`,
        s.name_ar, s.tagline, s.tagline_ar, s.description || null, s.description_ar || null,
        img(logoSvg(name, s.palette), `${name} logo.svg`), s.draft ? null : img(coverSvg(name, s.palette), `${name} cover.svg`),
        s.featured ? 1 : 0, live ? 1 : 0, live ? `${day(-6)}T10:00:00.000Z` : null, `${day(-2)}T12:30:00.000Z`, id,
      );
    }
    for (const e of EVENTS) {
      const t = M.now();
      db.run(
        `INSERT INTO web_events (slug, title, title_ar, starts_on, ends_on, time_from, time_to, location, location_ar, summary, summary_ar, description, description_ar, rsvp_url, cover_id, featured, published, published_at, demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
        db.get('SELECT id FROM web_events WHERE slug = ?', e.slug) ? `${e.slug}-${Date.now().toString(36)}` : e.slug,
        e.title, e.title_ar, day(e.start), day(e.start + e.days - 1), e.from, e.to, e.location, e.location_ar, e.summary, e.summary_ar, e.description, e.description_ar,
        e.rsvp || null, img(coverSvg(e.slug, e.palette), `${e.slug}.svg`), e.featured ? 1 : 0, t, t, t,
      );
    }
    const pb = db.get('SELECT id FROM brands WHERE name = ? AND demo = 1 ORDER BY id DESC LIMIT 1', PROMO.brand);
    const t = M.now();
    db.run(
      'INSERT INTO web_promos (brand_id, title, title_ar, details, details_ar, starts_on, ends_on, image_id, published, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
      pb ? pb.id : null, PROMO.title, PROMO.title_ar, PROMO.details, PROMO.details_ar, day(PROMO.start), day(PROMO.end), img(coverSvg('promo', PROMO.palette), 'opening-offer.svg'), t, t,
    );
  });
}

function clear(db, { h } = {}) {
  const ids = (table) => db.all(`SELECT id FROM ${table} WHERE demo = 1`).map((r) => r.id);
  const stores = ids('web_stores');
  const images = db.all('SELECT id, stored FROM web_images WHERE demo = 1');
  db.tx(() => {
    if (stores.length) db.run(`DELETE FROM audit WHERE entity = 'web_store' AND entity_id IN (${stores.join(',')})`);
    db.run('DELETE FROM web_promos WHERE demo = 1');
    db.run('DELETE FROM web_events WHERE demo = 1');
    db.run('DELETE FROM web_stores WHERE demo = 1');
  });
  // the sample images and their files (release() keeps any the office now uses)
  if (h && h.website) for (const i of images) h.website.releaseImage(i.id);
  else db.run('DELETE FROM web_images WHERE demo = 1');
}

module.exports = { load, clear, STORES, EVENTS };
