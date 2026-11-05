'use strict';

// Sample data for Help & training: the sample staff's progress through the lessons (some finished
// paths, some halfway), a few "was this helpful?" answers, and support requests in every state, in
// English and Arabic, with replies from the office.

const help = require('./help');

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const ago = (days, hours = 0) => new Date(Date.now() - (days * 24 + hours) * 3600000).toISOString();

const TICKETS = [
  { subject: 'The proposal prints on two pages', category: 'problem', page: '/admin/offers/3/print', body: 'When I print the proposal for Cedar Fitness the rent schedule goes onto a second page. Can it fit on one?', status: 'answered', days: 6,
    replies: [[1, 'In the print dialog choose "Fit to page" (or scale 90%). A proposal with more than five years of schedule always takes two pages.', 5], [0, 'That worked, thank you.', 5]] },
  { subject: 'أحتاج صلاحية على قسم التحصيل', category: 'access', page: '/admin/collections', body: 'أتابع مع المستأجرين المتأخرين ولا أستطيع فتح صفحة التحصيل. هل يمكن إضافتها لدوري؟', status: 'open', days: 1, replies: [] },
  { subject: 'Can tenants upload their insurance in the portal?', category: 'question', page: '/admin/compliance/insurance', body: 'Some tenants ask where to send their insurance certificate.', status: 'closed', days: 12,
    replies: [[1, 'Yes: in the portal under Documents, "Upload a document". It lands in their file and the expiry is tracked in Safety & licences.', 11]] },
  { subject: 'فكرة: تذكير قبل انتهاء الحجز المؤقت بيوم', category: 'idea', page: '/admin/units', body: 'سيكون من المفيد أن يصلني تذكير قبل انتهاء الحجز المؤقت للوحدة بيوم واحد.', status: 'answered', days: 3,
    replies: [[1, 'فكرة جيدة، أضفناها إلى قائمة التحسينات. حاليًا تظهر الحجوزات المنتهية في «يحتاج إلى متابعة» على لوحة التحكم.', 2]] },
  { subject: 'The parking booth tablet logs out', category: 'problem', page: '/admin/parking/booth', body: 'The cashier tablet at the exit asks to sign in again after a few hours.', status: 'open', days: 0, replies: [] },
];

function load(db, admin, opts = {}) {
  if (!has(db, 'hlp_tickets')) return;
  clear(db);
  const staff = db.all("SELECT id, name, lang FROM users WHERE email LIKE '%@demo.thewave.local' AND active = 1 ORDER BY id");
  const supportId = admin && admin.id ? admin.id : db.value("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (!staff.length) return;
  const lessons = help.load().lessons.filter((l) => l.area !== 'portal');
  const r = rng(77);
  db.tx(() => {
    // progress: the first-day path for most people, more for some
    staff.forEach((u, i) => {
      const keen = i % 3 === 0;
      lessons.forEach((l, k) => {
        const p = r();
        const start = l.area === 'start' || l.area === 'overview';
        if (!(start ? p < 0.85 : keen ? p < 0.6 : p < 0.25)) return;
        const done = p < (start ? 0.65 : 0.4);
        const seen = done ? 1 : Math.round((0.15 + r() * 0.6) * 100) / 100;
        db.run('INSERT OR REPLACE INTO hlp_progress (user_id, lesson_id, lang, pos, dur, seen, done_at, demo, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
          u.id, l.id, u.lang === 'ar' ? 'ar' : 'en', done ? 0 : 20 + Math.round(r() * 30), 70, seen, done ? ago(1 + ((i + k) % 20)) : null, ago((i + k) % 14, k % 9));
      });
    });
    // was it helpful?
    lessons.slice(0, 6).forEach((l, k) => {
      for (let j = 0; j < 3; j++) {
        const u = staff[(k * 3 + j) % staff.length];
        db.run('INSERT INTO hlp_feedback (user_id, lesson_id, helpful, note, demo, created_at) VALUES (?, ?, ?, ?, 1, ?)', u.id, l.id, (k + j) % 5 === 4 ? 0 : 1, (k + j) % 5 === 4 ? 'A bit fast for me' : null, ago(k + j));
      }
    });
    // support requests
    TICKETS.forEach((t, i) => {
      const u = staff[(i * 2 + 1) % staff.length];
      const at = ago(t.days, 3 + i);
      const ref = `HLP-${new Date().getFullYear()}-${String(900 + i).padStart(4, '0')}`;
      const lastStaff = t.replies.filter(([s]) => s).map(([, , d]) => ago(d, 1)).pop() || null;
      const id = Number(db.run('INSERT INTO hlp_tickets (ref, user_id, subject, category, body, page, agent, status, staff_reply_at, user_seen_at, closed_at, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        ref, u.id, t.subject, t.category, t.body, t.page, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 · 1920×1080', t.status, lastStaff, t.status === 'answered' && i === 0 ? ago(t.days - 1) : null, t.status === 'closed' ? ago(t.days - 1) : null, at, lastStaff || at).lastInsertRowid);
      for (const [isStaff, body, d] of t.replies) db.run('INSERT INTO hlp_replies (ticket_id, user_id, body, staff, created_at) VALUES (?, ?, ?, ?, ?)', id, isStaff ? supportId : u.id, body, isStaff ? 1 : 0, ago(d, isStaff ? 1 : 0));
    });
  });
  void opts;
}

function clear(db) {
  if (!has(db, 'hlp_tickets')) return;
  db.tx(() => {
    db.run('DELETE FROM hlp_replies WHERE ticket_id IN (SELECT id FROM hlp_tickets WHERE demo = 1)');
    db.run('DELETE FROM hlp_tickets WHERE demo = 1');
    db.run('DELETE FROM hlp_progress WHERE demo = 1');
    db.run('DELETE FROM hlp_feedback WHERE demo = 1');
  });
}

module.exports = { load, clear };
