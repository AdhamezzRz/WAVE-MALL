'use strict';

// Sample data for shopper feedback: eight poster locations (linked to their cleaning areas) and
// about a hundred ratings over the last twelve weeks, in Arabic and English. Most are good; the first-floor
// toilets and the car park do worse. Older tickets are resolved with a reply; this week's are new or
// in progress. Cleanliness complaints raised cleaning alerts (cleared later) and facilities ones
// opened maintenance work orders.

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// [code, name, Arabic name, floor, cleaning area code, average mood 1–5]
const LOCATIONS = [
  ['food-court', 'Food court', 'ساحة المطاعم', 'First floor', 'CL-04', 4.1],
  ['toilets-gf', 'Toilets, ground floor', 'دورات المياه - الدور الأرضي', 'Ground floor', 'CL-01', 3.7],
  ['toilets-ff', 'Toilets, first floor', 'دورات المياه - الدور الأول', 'First floor', 'CL-03', 2.9],
  ['main-entrance', 'Main entrance', 'المدخل الرئيسي', 'Ground floor', 'CL-05', 4.4],
  ['car-park', 'Car park B1', 'الجراج B1', 'Car park B1', 'CL-07', 3.2],
  ['kids-area', 'Kids’ play area', 'منطقة ألعاب الأطفال', 'First floor', 'CL-08', 4.3],
  ['prayer-rooms', 'Prayer rooms', 'المصليات', 'First floor', 'CL-06', 4.0],
  ['cinema-lobby', 'Cinema lobby', 'بهو السينما', 'First floor', null, 4.5],
];
// comments by mood: [category, English, Arabic]
const GOOD = [
  ['staff', 'The guard at the entrance was very helpful with my stroller.', 'أمن المدخل ساعدني جدًا بعربة الأطفال.'],
  ['cleanliness', 'Very clean today, well done.', 'المكان نظيف جدًا النهارده، برافو.'],
  ['other', 'Lovely atmosphere in the evening.', 'الجو جميل جدًا بالليل.'],
  ['facilities', 'Good air conditioning everywhere.', 'التكييف ممتاز في كل مكان.'],
  ['parking', 'Easy to find a space, the signs help.', 'سهل ألاقي مكان، والإرشادات واضحة.'],
  ['staff', 'Customer service found my lost bag in minutes. Thank you!', 'خدمة العملاء لقوا شنطتي في دقايق. شكرًا!'],
  ['safety', 'I feel safe here with the kids.', 'بحس بالأمان هنا مع الأولاد.'],
];
const BAD = [
  ['cleanliness', 'No soap and the bins are full.', 'مفيش صابون والسلال مليانة.'],
  ['cleanliness', 'Floor is wet and slippery, no sign.', 'الأرض مبلولة وبتزحلق ومفيش علامة.'],
  ['facilities', 'One of the hand dryers is broken.', 'مجفف الأيدي بايظ.'],
  ['facilities', 'The lift to B1 took ages, one was out of service.', 'الأسانسير للجراج اتأخر جدًا وواحد عطلان.'],
  ['parking', 'Pay machine did not accept my card.', 'ماكينة الدفع مقبلتش الكارت.'],
  ['parking', 'Too long to get out of the car park on Friday night.', 'الخروج من الجراج أخد وقت طويل يوم الجمعة بالليل.'],
  ['staff', 'Nobody at the information desk.', 'مفيش حد في مكتب الاستعلامات.'],
  ['facilities', 'AC is too weak in the evening.', 'التكييف ضعيف بالليل.'],
  ['safety', 'Kids running on the escalator with no one watching.', 'أطفال بيجروا على السلم الكهربائي من غير ما حد يراقب.'],
];
const REPLIES = ['Cleaning team sent at once; area checked by the supervisor.', 'Thanked the shopper; passed to the team.', 'Called the shopper back and apologised; fixed the same day.', 'Maintenance fixed it; work order closed.', 'Shared with the parking operator; extra staff on Friday nights.'];

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  const F = h.feedback;
  if (!F || !has(db, 'fb_locations') || db.value('SELECT COUNT(*) FROM fb_locations WHERE demo = 1')) return;
  const rnd = rng(1104);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const uid = admin ? admin.id : null;
  const area = (code) => (code && has(db, 'sec_clean_areas') ? db.value('SELECT id FROM sec_clean_areas WHERE code = ?', code) : null);
  db.tx(() => {
    const locs = LOCATIONS.map(([code, name, ar, floor, cl, mood]) => {
      const id = Number(db.run('INSERT INTO fb_locations (code, name, name_ar, floor, area_id, demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', code, name, ar, floor, area(cl) || null, iso(nowMs - 40 * 86400000)).lastInsertRowid);
      return { loc: db.get('SELECT * FROM fb_locations WHERE id = ?', id), mood };
    });
    const users = db.all("SELECT id FROM users WHERE active = 1 AND role IN ('admin','manager','agent') ORDER BY id").map((u) => u.id);
    for (let i = 0; i < 96; i++) {
      // more recent days get a little more feedback
      const ageH = Math.pow(rnd(), 1.4) * 84 * 24 + 0.3;
      const at = nowMs - ageH * 3600000;
      const { loc, mood } = locs[Math.floor(rnd() * locs.length)];
      const rating = Math.max(1, Math.min(5, Math.round(mood + (rnd() - 0.5) * 3.2)));
      const good = rating >= 4;
      let [category, en, ar] = pick(good ? GOOD : BAD);
      if (!good && loc.code.startsWith('toilets') && rnd() < 0.7) [category, en, ar] = pick(BAD.slice(0, 3));
      if (!good && loc.code === 'car-park' && rnd() < 0.7) [category, en, ar] = pick(BAD.filter((b) => b[0] === 'parking'));
      const lang = rnd() < 0.62 ? 'ar' : 'en';
      const silent = rnd() < 0.22;
      const e = F.submit(loc, { rating, category, comment: silent ? null : lang === 'ar' ? ar : en, phone: !good && rnd() < 0.4 ? `010${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}` : null, lang, demo: 1, at: iso(at) });
      // what the office did with it
      if (ageH > 72 || (ageH > 6 && rnd() < 0.5)) {
        const act = at + (0.2 + rnd() * (good ? 20 : 6)) * 3600000;
        const done = ageH > 72 || rnd() < 0.5;
        const who = users.length ? users[Math.floor(rnd() * users.length)] : uid;
        const reply = good ? 'Thanked the shopper; passed to the team.' : pick(REPLIES);
        db.run('UPDATE fb_entries SET status = ?, assignee_id = ?, reply = ?, first_action_at = ?, resolved_at = ?, updated_at = ? WHERE id = ?', done ? 'resolved' : 'in_progress', who, done ? reply : null, iso(act), done ? iso(act + 3600000) : null, iso(act), e.id);
        db.run("INSERT INTO fb_events (entry_id, kind, body, user_id, at) VALUES (?, 'assigned', (SELECT name FROM users WHERE id = ?), ?, ?)", e.id, who, who, iso(act));
        db.run("INSERT INTO fb_events (entry_id, kind, body, user_id, at) VALUES (?, 'status', ?, ?, ?)", e.id, done ? 'resolved' : 'in_progress', who, iso(act + 60000));
        if (done) db.run("INSERT INTO fb_events (entry_id, kind, body, user_id, at) VALUES (?, 'reply', ?, ?, ?)", e.id, reply, who, iso(act + 3600000));
        // the alert or work order it raised was dealt with too
        if (e.routed_kind === 'cleaning') db.run('UPDATE sec_clean_alerts SET resolved_at = ?, resolved_by = ? WHERE id = ?', iso(act), who, e.routed_id);
        if (e.routed_kind === 'maintenance' && done) db.run("UPDATE work_orders SET status = 'closed', responded_at = COALESCE(responded_at, ?), resolved_at = ?, closed_at = ?, updated_at = ? WHERE id = ?", iso(act), iso(act + 3600000), iso(act + 3600000), iso(act + 3600000), e.routed_id);
      }
    }
  });
}

function clear(db) {
  if (!has(db, 'fb_entries')) return;
  db.tx(() => {
    if (has(db, 'work_orders')) {
      const ids = db.all("SELECT id FROM work_orders WHERE demo = 1 AND reported_by LIKE 'Shopper feedback%'").map((w) => w.id);
      for (const id of ids) {
        if (has(db, 'wo_events')) db.run('DELETE FROM wo_events WHERE wo_id = ?', id);
        db.run('DELETE FROM work_orders WHERE id = ?', id);
      }
    }
    if (has(db, 'sec_clean_alerts')) db.run("DELETE FROM sec_clean_alerts WHERE source = 'feedback' AND source_id IN (SELECT id FROM fb_entries WHERE demo = 1)");
    db.run('DELETE FROM fb_events WHERE entry_id IN (SELECT id FROM fb_entries WHERE demo = 1)');
    db.run('DELETE FROM fb_entries WHERE demo = 1');
    db.run('DELETE FROM fb_locations WHERE demo = 1');
  });
}

module.exports = { load, clear };
