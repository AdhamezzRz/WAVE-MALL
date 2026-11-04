'use strict';

// Sample data for advertising and media sales: 26 spaces around the mall (screens sold by slots,
// hanging banners, promotion zones, lift and escalator wraps, ATM spaces, sampling stands, car
// display spots, parking barrier arms, lightboxes, the façade billboard), the seasons of this year
// and the next (Ramadan, the Eids, summer, White Friday, the holidays), duration and volume
// discounts, outside advertisers and agencies, and 34 campaigns from last spring to next year:
// ended with proof photos and paid invoices, live, confirmed waiting for artwork, holds (one about to
// run out), proposals, a discount waiting for approval and two cancellations.

const zlib = require('node:zlib');
const M = require('./model');
const media = require('./routes/media');

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);

// ---------- small real PNG images (a mock photo of each space, artwork and proof shots) ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// paint(x, y) → [r, g, b]
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
const PALETTE = [[40, 56, 51], [162, 197, 185], [176, 132, 92], [214, 170, 92], [92, 132, 176], [196, 98, 92], [120, 96, 160], [70, 140, 110]];
// a space in the mall: a warm wall, the floor, and the advertising face in its proportions
function spacePhoto(seed, ratio, digital) {
  const W = 300;
  const H = 200;
  const face = PALETTE[seed % PALETTE.length];
  const glow = PALETTE[(seed + 3) % PALETTE.length];
  const fw = Math.min(220, Math.max(60, Math.round(125 * Math.sqrt(ratio))));
  const fh = Math.min(128, Math.max(34, Math.round(fw / ratio)));
  const x0 = (W - fw) >> 1;
  const y0 = Math.max(14, 92 - (fh >> 1));
  return png(W, H, (x, y) => {
    if (y > 164) return mix([214, 206, 190], [176, 166, 150], (y - 164) / 36);
    const inFace = x >= x0 && x < x0 + fw && y >= y0 && y < y0 + fh;
    const frame = x >= x0 - 4 && x < x0 + fw + 4 && y >= y0 - 4 && y < y0 + fh + 4;
    if (inFace) {
      const f = (x - x0) / fw;
      const band = y - y0 > fh * 0.62 && y - y0 < fh * 0.74 && f > 0.12 && f < 0.7;
      if (band) return [250, 248, 242];
      return digital ? mix(face, glow, (f + (y - y0) / fh) / 2) : mix(face, [250, 248, 242], (y - y0) / fh * 0.25);
    }
    if (frame) return [34, 38, 36];
    return mix([238, 233, 222], [222, 214, 198], y / 164);
  });
}
// artwork and proof shots: a poster with a headline band
function poster(seed, proof) {
  const W = 240;
  const H = 320;
  const a = PALETTE[seed % PALETTE.length];
  const b = PALETTE[(seed + 2) % PALETTE.length];
  return png(W, H, (x, y) => {
    const m = proof ? 22 : 0;
    if (proof && (x < m || x >= W - m || y < m || y >= H - m)) return mix([200, 194, 182], [150, 142, 130], y / H);
    if (y > H * 0.68 && y < H * 0.78 && x > W * 0.14 && x < W * 0.86) return [250, 248, 242];
    if (Math.hypot(x - W * 0.5, y - H * 0.36) < W * 0.22) return mix(b, [250, 248, 242], 0.35);
    return mix(a, b, y / H);
  });
}

// ---------- the seasons: fixed Islamic calendar dates, and the yearly ones ----------
const ISLAMIC = [
  ['Ramadan', 'رمضان', '2025-03-01', '2025-03-29', 35], ['Eid al-Fitr', 'عيد الفطر', '2025-03-30', '2025-04-03', 40], ['Eid al-Adha', 'عيد الأضحى', '2025-06-05', '2025-06-10', 30],
  ['Ramadan', 'رمضان', '2026-02-18', '2026-03-19', 35], ['Eid al-Fitr', 'عيد الفطر', '2026-03-20', '2026-03-24', 40], ['Eid al-Adha', 'عيد الأضحى', '2026-05-26', '2026-05-30', 30],
  ['Ramadan', 'رمضان', '2027-02-08', '2027-03-09', 35], ['Eid al-Fitr', 'عيد الفطر', '2027-03-10', '2027-03-14', 40], ['Eid al-Adha', 'عيد الأضحى', '2027-05-16', '2027-05-20', 30],
  ['Ramadan', 'رمضان', '2028-01-28', '2028-02-26', 35], ['Eid al-Fitr', 'عيد الفطر', '2028-02-27', '2028-03-02', 40], ['Eid al-Adha', 'عيد الأضحى', '2028-05-04', '2028-05-08', 30],
];
const YEARLY = [
  ['Summer', 'الصيف', '07-01', '08-31', 15], ['Back to school', 'العودة إلى المدارس', '09-01', '09-20', 10],
  ['White Friday', 'الجمعة البيضاء', '11-20', '11-30', 30], ['Year-end holidays', 'عطلات نهاية العام', '12-20', '12-31', 20],
];

// code, name, Arabic name, type, level, where, Arabic where, w, h, m², slots, s, day, week, month, min days, % passing, specs
const ITEMS = [
  ['DS-G-01', 'Atrium LED video wall', 'شاشة الفناء الرئيسية', 'videowall', 'ground', 'Central atrium, facing the main entrance', 'الفناء الرئيسي، مقابل المدخل الرئيسي', 8, 4.5, null, 6, 10, 1500, 9000, 32000, 1, 62, 'P3.9 LED, 2048 × 1152 px, MP4 (H.264), 10 s, no sound'],
  ['DS-G-02', 'North entrance screen', 'شاشة المدخل الشمالي', 'screen', 'ground', 'North entrance, inside the doors', 'المدخل الشمالي، بعد الأبواب', 1.2, 2.1, null, 6, 10, 900, 5400, 19000, 1, 36, '86-inch portrait, 2160 × 3840 px, MP4 or JPG'],
  ['DS-G-03', 'South entrance screen', 'شاشة المدخل الجنوبي', 'screen', 'ground', 'South entrance, by the taxi drop-off', 'المدخل الجنوبي، بجوار موقف التاكسي', 1.2, 2.1, null, 6, 10, 800, 4800, 17000, 1, 30, '86-inch portrait, 2160 × 3840 px, MP4 or JPG'],
  ['DS-L1-01', 'Food court screen network', 'شبكة شاشات ساحة المطاعم', 'screen', 'first', 'Four screens around the food court', 'أربع شاشات حول ساحة المطاعم', 1.9, 1.1, null, 8, 15, 700, 4200, 15000, 1, 42, '4 × 75-inch landscape, 3840 × 2160 px, 15 s'],
  ['DS-L1-02', 'Cinema lobby screen', 'شاشة ردهة السينما', 'screen', 'second', 'Cinema lobby, by the ticket desk', 'ردهة السينما، بجوار شباك التذاكر', 1.9, 1.1, null, 6, 10, 600, 3600, 13000, 1, 18, '75-inch landscape, 3840 × 2160 px'],
  ['DS-B1-01', 'Parking lift lobby screens', 'شاشات مصاعد المواقف', 'screen', 'b1', 'Lift lobbies of parking B1', 'ردهات المصاعد في مواقف B1', 0.9, 1.6, null, 6, 10, 350, 2100, 7500, 1, 26, '6 × 55-inch portrait, 1080 × 1920 px'],
  ['DS-OUT-01', 'Façade LED screen', 'شاشة الواجهة الخارجية', 'videowall', 'outdoor', 'Façade over the main entrance, seen from the ring road', 'الواجهة فوق المدخل الرئيسي، تُرى من الطريق الدائري', 12, 6, null, 10, 10, 2500, 15000, 52000, 1, 80, 'P6 outdoor LED, 2000 × 1000 px, no sound, 06:00–02:00'],
  ['HB-G-01', 'Atrium hanging banner', 'بانر معلّق في الفناء', 'hanging', 'ground', 'Hung from the atrium skylight', 'معلّق من سقف الفناء', 6, 12, null, 1, null, 2500, 14000, 45000, 7, 60, 'Mesh PVC, double-sided, eyelets every 50 cm'],
  ['HB-G-02', 'East skylight drop', 'بانر السقف الشرقي', 'hanging', 'ground', 'East court skylight', 'سقف الساحة الشرقية', 4, 8, null, 1, null, 1600, 9000, 30000, 7, 38, 'Mesh PVC, double-sided'],
  ['BN-L1-01', 'First-floor balustrade banner', 'بانر درابزين الدور الأول', 'banner', 'first', 'Balustrade over the atrium', 'الدرابزين المطل على الفناء', 12, 1.2, null, 1, null, 900, 5000, 16000, 7, 55, 'Printed PVC on a tension frame'],
  ['BN-L2-01', 'Second-floor balustrade banner', 'بانر درابزين الدور الثاني', 'banner', 'second', 'Balustrade over the atrium', 'الدرابزين المطل على الفناء', 12, 1.2, null, 1, null, 700, 4000, 13000, 7, 40, 'Printed PVC on a tension frame'],
  ['AZ-G-01', 'Central atrium promotion zone', 'منطقة العروض في الفناء الرئيسي', 'atrium', 'ground', 'Central atrium floor', 'أرضية الفناء الرئيسي', null, null, 120, 1, null, 12000, 70000, 220000, 3, 62, '120 m², 4 power points (32 A), set-up after 23:00'],
  ['AZ-G-02', 'North court promotion zone', 'منطقة العروض في الساحة الشمالية', 'atrium', 'ground', 'North court, by the fountain', 'الساحة الشمالية، بجوار النافورة', null, null, 60, 1, null, 6000, 36000, 120000, 3, 34, '60 m², 2 power points'],
  ['ST-G-01', 'Sampling stand, west mall', 'منصة تذوق، الممر الغربي', 'stand', 'ground', 'West mall, by the supermarket', 'الممر الغربي، بجوار السوبرماركت', null, null, 4, 1, null, 1200, 7000, 24000, 1, 28, '2 × 2 m, one power point, staff from the brand'],
  ['ST-L1-01', 'Sampling stand, food court', 'منصة تذوق، ساحة المطاعم', 'stand', 'first', 'Food court, centre aisle', 'ساحة المطاعم، الممر الأوسط', null, null, 4, 1, null, 1000, 6000, 20000, 1, 40, '2 × 2 m, one power point'],
  ['LW-G-01', 'Panoramic lift wrap', 'تغليف المصعد البانورامي', 'wrap', 'ground', 'Glass lift in the atrium, three floors', 'المصعد الزجاجي في الفناء، ثلاثة أدوار', 3, 9, null, 1, null, null, 12000, 40000, 14, 58, 'One-way vision film, installed overnight'],
  ['EW-G-01', 'Atrium escalator wrap', 'تغليف سلالم الفناء', 'wrap', 'ground', 'Escalators, ground to first', 'السلالم المتحركة من الأرضي إلى الأول', 1.2, 14, null, 1, null, null, 9000, 30000, 14, 50, 'Side panels and handrail skirts, vinyl'],
  ['ATM-G-01', 'ATM space, north entrance', 'مساحة صراف آلي، المدخل الشمالي', 'atm', 'ground', 'North entrance lobby', 'ردهة المدخل الشمالي', null, null, 3, 1, null, null, null, 18000, 30, 36, 'Room for two machines, power and data'],
  ['ATM-B1-01', 'ATM space, parking B1', 'مساحة صراف آلي، مواقف B1', 'atm', 'b1', 'By the B1 pay stations', 'بجوار ماكينات الدفع في B1', null, null, 2, 1, null, null, null, 12000, 30, 22, 'One machine, power and data'],
  ['CD-G-01', 'Car display, main entrance', 'عرض سيارة، المدخل الرئيسي', 'car', 'ground', 'Inside the main entrance', 'داخل المدخل الرئيسي', null, null, 30, 1, null, 3000, 18000, 60000, 7, 64, 'Floor load 1.5 t, one car, delivery after 23:00'],
  ['CD-OUT-01', 'Car display, forecourt', 'عرض سيارة، الساحة الأمامية', 'car', 'outdoor', 'Forecourt facing the ring road', 'الساحة الأمامية المطلة على الطريق الدائري', null, null, 40, 1, null, 2500, 15000, 50000, 7, 45, 'Up to two cars, shaded'],
  ['PB-B1-01', 'Barrier arms, parking entries', 'أذرع بوابات دخول المواقف', 'barrier', 'b1', 'The four entry gates', 'بوابات الدخول الأربع', 3.5, 0.12, null, 1, null, null, 4500, 15000, 14, 70, 'Four arms, printed vinyl sleeves'],
  ['PB-B2-01', 'Barrier arms, parking exits', 'أذرع بوابات خروج المواقف', 'barrier', 'b2', 'The four exit gates', 'بوابات الخروج الأربع', 3.5, 0.12, null, 1, null, null, 3500, 12000, 14, 65, 'Four arms, printed vinyl sleeves'],
  ['LB-G-01', 'Directory lightboxes', 'لوحات مضيئة بجوار الخرائط', 'lightbox', 'ground', 'Six lightboxes beside the mall maps', 'ست لوحات بجوار خرائط المول', 1.2, 1.8, null, 1, null, null, 6000, 20000, 7, 48, '6 × backlit fabric, 1185 × 1750 mm'],
  ['LB-B1-01', 'Parking column lightboxes', 'لوحات مضيئة على أعمدة المواقف', 'lightbox', 'b1', 'Twelve columns in parking B1', 'اثنا عشر عمودًا في مواقف B1', 0.8, 1.2, null, 1, null, null, 4000, 14000, 7, 24, '12 × backlit film'],
  ['FB-OUT-01', 'Ring-road façade billboard', 'لوحة الواجهة على الطريق الدائري', 'facade', 'outdoor', 'West façade, facing the ring road', 'الواجهة الغربية، تطل على الطريق الدائري', 20, 8, null, 1, null, null, 35000, 120000, 14, 50, 'Flex face, front-lit, 20 × 8 m'],
];

const CLIENTS = [
  ['Nile Telecom', 'company', 'Rania Fouad', '+20 100 555 0101', 'rania.fouad@niletelecom.example', '204-118-552'],
  ['Delta Motors', 'company', 'Karim Lotfy', '+20 122 555 0144', 'k.lotfy@deltamotors.example', '311-905-210'],
  ['Horizon Bank', 'company', 'Mai Sherif', '+20 111 555 0177', 'mai.sherif@horizonbank.example', '100-442-871'],
  ['Pyramid Media Agency', 'agency', 'Omar Nabil', '+20 106 555 0190', 'omar@pyramidmedia.example', '412-660-034'],
  ['Lotus Beverages', 'company', 'Heba Adel', '+20 127 555 0123', 'heba.adel@lotusbev.example', '287-331-419'],
  ['Sahel Developments', 'company', 'Tarek Hamdy', '+20 109 555 0166', 'tarek@saheldev.example', '355-218-007'],
  ['Orbit Electronics', 'company', 'Nadia Samy', '+20 155 555 0112', 'nadia@orbit-electronics.example', '198-004-562'],
];

// who (client index, or 'b<n>' for the nth sample tenant), title, start (days from today), days,
// spaces, slots on screens, extra %, what happened
const CAMPAIGNS = [
  [0, 'Spring 5G launch', -230, 42, ['DS-G-01', 'DS-OUT-01', 'HB-G-01'], 2, 5, 'ended'],
  [1, 'New crossover reveal', -205, 28, ['CD-G-01', 'DS-G-02'], 1, 0, 'ended'],
  [2, 'Ramadan savings account', -260, 30, ['ATM-G-01', 'LB-G-01', 'DS-B1-01'], 2, 8, 'ended'],
  ['b0', 'Eid collection', -225, 14, ['BN-L1-01', 'DS-L1-01'], 1, 0, 'ended'],
  [4, 'Summer refresh sampling', -125, 21, ['ST-G-01', 'ST-L1-01'], 1, 0, 'ended'],
  [3, 'Back-to-school (for a client)', -65, 21, ['DS-G-01', 'DS-L1-01', 'BN-L2-01'], 2, 10, 'ended'],
  [5, 'Coastal homes summer', -120, 56, ['FB-OUT-01', 'AZ-G-02'], 1, 12, 'ended'],
  ['b1', 'Store opening', -95, 14, ['HB-G-02', 'DS-G-03'], 1, 0, 'ended'],
  [6, 'Gaming week', -40, 7, ['AZ-G-01', 'DS-L1-02'], 2, 0, 'ended'],
  [2, 'Parking barrier sponsorship', -150, 196, ['PB-B1-01', 'PB-B2-01'], 1, 6, 'live'],
  [0, 'Unlimited data, autumn', -20, 35, ['DS-G-01', 'DS-G-02', 'DS-G-03', 'DS-B1-01'], 2, 8, 'live'],
  [1, 'Year-end test drives', -10, 30, ['CD-OUT-01', 'LW-G-01'], 1, 0, 'live'],
  ['b2', 'Autumn arrivals', -6, 14, ['BN-L1-01', 'DS-L1-01'], 1, 0, 'live'],
  [2, 'ATM network', -300, 365, ['ATM-B1-01'], 1, 0, 'live'],
  [3, 'Agency network buy (Cinema)', -3, 28, ['DS-L1-02', 'LB-B1-01'], 3, 5, 'live'],
  [4, 'Winter warmers sampling', -2, 10, ['ST-L1-01'], 1, 0, 'late'],
  [6, 'White Friday deals', 12, 14, ['DS-G-01', 'DS-OUT-01', 'HB-G-01', 'EW-G-01'], 2, 9, 'confirmed'],
  ['b0', 'White Friday in store', 15, 10, ['DS-G-02', 'BN-L2-01'], 1, 0, 'confirmed_art'],
  ['b3', 'Holiday gifting', 30, 21, ['LB-G-01', 'DS-L1-01'], 2, 0, 'confirmed_received'],
  [5, 'New phase launch', 5, 21, ['AZ-G-01', 'FB-OUT-01'], 1, 0, 'confirmed_approved'],
  [0, 'Holiday bundles', 46, 28, ['DS-G-03', 'DS-B1-01'], 2, 0, 'confirmed'],
  [1, 'New year sales event', 58, 14, ['CD-G-01'], 1, 0, 'held'],
  ['b4', 'Winter sale', 50, 21, ['HB-G-02', 'DS-G-02'], 1, 0, 'held_soon'],
  [3, 'Ramadan network (draft)', 96, 30, ['DS-G-01', 'DS-L1-01', 'DS-OUT-01', 'HB-G-01', 'LW-G-01', 'EW-G-01'], 2, 18, 'pending'],
  [4, 'Ramadan iftar sampling', 98, 28, ['ST-G-01', 'ST-L1-01', 'AZ-G-02'], 1, 5, 'proposal'],
  [6, 'Spring tech fair', 130, 7, ['AZ-G-01'], 1, 0, 'proposal'],
  ['b1', 'Brand anniversary', 75, 14, ['BN-L1-01'], 1, 0, 'proposal'],
  [2, 'Card cashback summer', 210, 60, ['DS-G-01', 'ATM-G-01'], 2, 0, 'proposal'],
  [5, 'Summer show units', 220, 28, ['CD-OUT-01'], 1, 25, 'rejected'],
  [1, 'Autumn SUV tour', -45, 14, ['CD-G-01'], 1, 0, 'cancelled'],
  [0, 'Roaming promotion', 20, 14, ['LB-B1-01'], 1, 0, 'cancelled'],
  ['b2', 'Summer clearance', -110, 14, ['DS-G-02', 'BN-L2-01'], 1, 0, 'ended'],
  [6, 'Smart home week', -170, 7, ['AZ-G-02', 'DS-G-03'], 1, 0, 'ended'],
  ['b3', 'Valentine\'s gifting', 100, 10, ['LB-G-01'], 1, 0, 'proposal'],
];

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  if (!has(db, 'media_items') || db.value('SELECT COUNT(*) FROM media_items WHERE demo = 1')) return;
  const B = opts.billing || h.billing;
  const files = opts.files || h.files;
  const T = M.today();
  const now = () => new Date().toISOString();
  const at = (d, time = '10:30') => `${M.addDays(T, d)}T${time}:00.000Z`;
  const user = admin ? { id: admin.id } : null;
  const uid = admin ? admin.id : null;
  const Y = Number(T.slice(0, 4));

  db.tx(() => {
    // the spaces
    for (const [k, x] of ITEMS.entries()) {
      const [code, name, nameAr, type, level, loc, locAr, w, hh, area, slots, secs, d, wk, mo, min, pct, specs] = x;
      db.run(`INSERT INTO media_items (code, name, name_ar, type, level, location, location_ar, width_m, height_m, area_m2, specs, slots, slot_seconds, loop_seconds,
        rate_day, rate_week, rate_month, min_days, exposure_pct, status, sort, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      code, name, nameAr, type, level, loc, locAr, w, hh, area, specs, slots, secs, secs ? secs * slots : null, d, wk, mo, min, pct, code === 'LB-B1-01' ? 'active' : 'active', k + 1, now(), now());
    }
    // one screen is being repaired
    db.run("UPDATE media_items SET status = 'maintenance', notes = 'Two panels replaced under warranty; back on sale next week.' WHERE code = 'DS-L1-02' AND demo = 1");
    // the seasons of last year, this year and the next
    for (const [name, ar, a, b, pct] of ISLAMIC) if (Number(a.slice(0, 4)) >= Y - 1 && Number(a.slice(0, 4)) <= Y + 1) db.run('INSERT INTO media_seasons (name, name_ar, start_date, end_date, pct, demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', name, ar, a, b, pct, now());
    for (const y of [Y - 1, Y, Y + 1]) for (const [name, ar, a, b, pct] of YEARLY) db.run('INSERT INTO media_seasons (name, name_ar, start_date, end_date, pct, demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', name, ar, `${y}-${a}`, `${y}-${b}`, pct, now());
    // discounts for long and large bookings
    for (const [kind, n, pct] of [['duration', 28, 10], ['duration', 84, 15], ['volume', 3, 5], ['volume', 6, 10]]) db.run('INSERT INTO media_tiers (kind, threshold, pct, demo, created_at) VALUES (?, ?, ?, 1, ?)', kind, n, pct, now());
    for (const [k, v] of [['media_hold_days', '5'], ['media_free_discount', '10'], ['media_artwork_days', '5']]) if (db.setting(k) === null || db.setting(k) === undefined || db.setting(k) === '') db.setSetting(k, v);
    // the advertisers
    for (const [name, kind, contact, phone, email, tax] of CLIENTS) db.run('INSERT INTO media_clients (name, kind, contact_name, phone, email, tax_id, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', name, kind, contact, phone, email, tax, now(), now());
  });

  // the spaces' photos
  const saveDoc = (entity, id, kind, title, buf, name, when) => {
    if (!files) return null;
    const saved = files.save(buf, name);
    if (saved.error) return null;
    return Number(db.run(`INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, uploaded_by, demo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, db.nextRef('documents', 'DOC', 4, true), entity, id, kind, title, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored, when.slice(0, 10), uid, when).lastInsertRowid);
  };
  const items = db.all('SELECT * FROM media_items WHERE demo = 1 ORDER BY sort');
  for (const [k, i] of items.entries()) {
    const ratio = i.width_m && i.height_m ? Math.max(0.25, Math.min(6, i.width_m / i.height_m)) : 1.6;
    saveDoc('media_item', i.id, 'media_photo', i.code, spacePhoto(k, ratio, ['screen', 'videowall'].includes(i.type)), `${i.code.toLowerCase()}-photo.png`, at(-400, '09:10'));
  }

  // the campaigns
  const byCode = Object.fromEntries(items.map((i) => [i.code, i]));
  const clients = db.all('SELECT id, name FROM media_clients WHERE demo = 1 ORDER BY id');
  let brands = db.all("SELECT DISTINCT b.id, b.name FROM brands b JOIN leases s ON s.brand_id = b.id WHERE s.status = 'active' ORDER BY b.id").slice(0, 5);
  if (brands.length < 5) brands = brands.concat(db.all('SELECT id, name FROM brands WHERE demo = 1 ORDER BY id').filter((b) => !brands.some((x) => x.id === b.id))).slice(0, 5);
  const seasons = db.all('SELECT * FROM media_seasons');
  const tiers = db.all('SELECT * FROM media_tiers');
  const manager = db.get("SELECT id FROM users WHERE role IN ('manager','admin') ORDER BY role = 'manager' DESC, id LIMIT 1");
  const mgr = manager ? manager.id : uid;
  const taken = [];
  let seq = 0;
  for (const [who, title, start, len, codes, slots, extra, fate] of CAMPAIGNS) {
    seq++;
    const brand = typeof who === 'string' && brands.length ? brands[Number(who.slice(1)) % brands.length] : null;
    const client = typeof who === 'number' ? clients[who] : null;
    if (!brand && !client) continue;
    const a = M.addDays(T, start);
    const b = M.addDays(T, start + len - 1);
    // the spaces that fit (a clash in the sample is skipped, never doubled up)
    const lines = [];
    for (const code of codes) {
      const i = byCode[code];
      if (!i) continue;
      const s = (i.slots || 1) > 1 ? Math.min(slots, i.slots) : 1;
      const takes = !['proposal', 'pending', 'rejected', 'cancelled'].includes(fate);
      if (takes && media.conflicts(taken, i, a, b, s).length) continue;
      const q = media.priceLine({ ...i, min_days: 1 }, a, b, { seasons, slots: s });
      if (q.error) continue;
      lines.push({ item_id: i.id, start_date: a, end_date: b, slots: s, days: q.days, rate: q.rate, base: q.base, season_days: q.seasonDays, list: q.list });
      if (takes) taken.push({ item_id: i.id, start_date: a, end_date: b, slots: s });
    }
    if (!lines.length) continue;
    const p = media.priceCampaign(lines, { tiers, extraPct: extra });
    const created = Math.min(start - 18, -2);
    const status = { ended: 'ended', live: 'live', late: 'confirmed', confirmed: 'confirmed', confirmed_art: 'confirmed', confirmed_received: 'confirmed', confirmed_approved: 'confirmed', held: 'held', held_soon: 'held', pending: 'proposal', proposal: 'proposal', rejected: 'proposal', cancelled: 'cancelled' }[fate];
    const artwork = { ended: 'approved', live: 'approved', late: 'received', confirmed: 'none', confirmed_art: 'none', confirmed_received: 'received', confirmed_approved: 'approved', held: 'none', held_soon: 'none' }[fate] || 'none';
    const hold = fate === 'held' ? M.addDays(T, 4) : fate === 'held_soon' ? M.addDays(T, 1) : null;
    const approval = fate === 'pending' ? 'pending' : fate === 'rejected' ? 'rejected' : extra > 10 && SOLD(status) ? 'approved' : 'none';
    const need = extra > 10 && approval !== 'approved' ? 1 : 0;
    const discount = p.list ? Math.round((1 - p.total / p.list) * 10000) / 100 : 0;
    const ref = db.nextRef('media_campaigns', 'MC', 4, true);
    const id = Number(db.run(`INSERT INTO media_campaigns (ref, title, brand_id, client_id, status, hold_until, start_date, end_date, list_total, duration_off, volume_pct, volume_off,
      extra_pct, extra_off, total, discount_pct, needs_approval, approval_state, approved_pct, approved_by, approved_at, approval_note, artwork_status, artwork_at, artwork_by, artwork_note,
      confirmed_at, live_at, ended_at, cancel_reason, created_by, demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ref, title, brand ? brand.id : null, client ? client.id : null, status, hold, a, b, p.list, p.durationOff, p.volumePct, p.volumeOff, p.extraPct, p.extraOff, p.total, discount,
    need, approval, approval === 'approved' ? extra : null, approval === 'approved' ? mgr : null, approval === 'approved' ? at(created + 2) : null,
    approval === 'rejected' ? 'Too deep for a summer booking: 15% at most.' : null,
    artwork, artwork !== 'none' ? at(Math.min(start - 6, -1), '14:20') : null, artwork !== 'none' ? mgr : null, fate === 'late' ? 'Received late: the sampling stand opens once the printer delivers.' : null,
    SOLD(status) || fate === 'cancelled' ? at(created + 3, '12:00') : null, ['live', 'ended'].includes(status) ? at(start, '08:00') : null, status === 'ended' ? at(start + len, '08:00') : null,
    fate === 'cancelled' ? (start < 0 ? 'The car model launch moved to next year.' : 'Budget moved to next quarter.') : null, uid, at(created, '11:00'), at(Math.min(-1, created + 3), '12:00')).lastInsertRowid);
    for (const l of p.lines) db.run('INSERT INTO media_lines (campaign_id, item_id, start_date, end_date, slots, days, rate, base, season_days, list, price, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', id, l.item_id, l.start_date, l.end_date, l.slots, l.days, l.rate, l.base, l.season_days, l.list, l.price);
    // history
    const log = (action, d, time) => db.run('INSERT INTO audit (user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', uid, action, 'media_campaign', id, ref, at(d, time));
    log('Created a media proposal', created, '11:00');
    if (approval === 'pending') log('Asked for a media discount approval', -1, '16:10');
    if (SOLD(status)) log('Confirmed a media campaign', created + 3, '12:00');
    if (status === 'held') log('Held media spaces', -1, '10:05');
    if (artwork !== 'none') log('Received media artwork', Math.min(start - 6, -1), '14:20');
    if (fate === 'cancelled') log('Cancelled a media campaign', Math.min(-1, created + 6), '09:40');
    // artwork and proof-of-posting photos
    if (artwork !== 'none') saveDoc('media_campaign', id, 'media_artwork', ref, poster(seq, false), `${ref.toLowerCase()}-artwork.png`, at(Math.min(start - 6, -1), '14:15'));
    if (status === 'ended' || (status === 'live' && start < -2)) {
      for (const l of lines.slice(0, 2)) {
        const i = items.find((x) => x.id === l.item_id);
        saveDoc('media_campaign', id, 'media_proof', `${ref} · ${i.code}`, poster(seq + 1, true), `${ref.toLowerCase()}-${i.code.toLowerCase()}-proof.png`, at(Math.min(start + 1, -1), '09:30'));
      }
    }
    // invoices: month by month for long campaigns, paid when the campaign is over
    if (B && SOLD(status)) {
      const plan = media.invoicePlan(p.lines, { monthly: len > 45 });
      for (const x of plan) {
        const due = x.period_start > T ? M.addDays(x.period_start, -5) : M.addDays(x.period_start, -5) < M.addDays(T, -400) ? M.addDays(T, -400) : M.addDays(x.period_start, -5);
        let inv;
        try {
          inv = B.createInvoice({ brand_id: brand ? brand.id : null, customer: brand ? null : client.name, kind: 'media', total: x.amount, due_date: due, period_start: x.period_start, period_end: x.period_end, note: `${ref} · ${title}`, source: 'media', source_id: id, demo: 1 }, { user });
        } catch { continue; }
        db.run('UPDATE invoices SET created_at = ? WHERE id = ?', at(Math.min(created + 3, -1), '12:05'), inv.id);
        const paid = status === 'ended' || (x.period_end < T && seq % 3 !== 0) || (x.period_start <= T && seq % 2 === 0);
        if (paid && due <= T && B.recordPayment) {
          try { B.recordPayment({ invoice_id: inv.id, amount: inv.total, date: due, method: seq % 2 ? 'transfer' : 'cheque', reference: `${ref}-${x.period_start.slice(5, 7)}`, demo: 1 }, { user }); } catch { /* left open */ }
        }
      }
    }
  }
  db.audit(admin || null, 'Loaded sample data', 'media', null, `${items.length} spaces, ${seq} campaigns`);
}
const SOLD = (s) => ['confirmed', 'live', 'ended'].includes(s);

function clear(db, opts = {}) {
  if (!has(db, 'media_items')) return;
  const docs = db.all("SELECT id, stored FROM documents WHERE demo = 1 AND entity IN ('media_item','media_campaign')");
  db.tx(() => {
    const ids = db.all('SELECT id FROM media_campaigns WHERE demo = 1').map((r) => r.id);
    for (const id of ids) {
      db.run("DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE source = 'media' AND source_id = ? AND demo = 1)", id);
      db.run("DELETE FROM invoices WHERE source = 'media' AND source_id = ? AND demo = 1", id);
    }
    db.run("DELETE FROM documents WHERE demo = 1 AND entity IN ('media_item','media_campaign')");
    db.run("DELETE FROM audit WHERE entity = 'media_campaign' AND entity_id IN (SELECT id FROM media_campaigns WHERE demo = 1)");
    db.run('DELETE FROM media_lines WHERE campaign_id IN (SELECT id FROM media_campaigns WHERE demo = 1) OR demo = 1');
    db.run('DELETE FROM media_campaigns WHERE demo = 1');
    db.run('DELETE FROM media_clients WHERE demo = 1');
    db.run('DELETE FROM media_items WHERE demo = 1');
    db.run('DELETE FROM media_seasons WHERE demo = 1');
    db.run('DELETE FROM media_tiers WHERE demo = 1');
  });
  if (opts.files) for (const d of docs) opts.files.release(db, d.stored);
}

module.exports = { load, clear };
