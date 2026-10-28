'use strict';

// Sample data for the tenant portal, online payments and e-invoicing: portal accounts for the
// sample tenants, notices, two sandbox payments, a payment link and prepared e-invoices.
// Sample tenants sign in with their email and a password made for this sample data only: from
// PORTAL_DEMO_PASSWORD, else random, kept in the settings and shown on /admin/portal until cleared.
// Every name here is fictional.

const crypto = require('node:crypto');
const M = require('./model');
const { hashPassword } = require('./db');

const MAIL = '@demo.thewave.local';
// brand → [name, language, joined]
const USERS = {
  'Maison Lune': ['Hana Fouad', 'en', true],
  'Kahwa House': ['Youssef Adly', 'ar', true],
  'Saffron Table': ['Mostafa Kamel', 'en', true],
  'Lumière Beauty': ['Rana Samir', 'ar', true],
  'Atelier Nour': ['Mariam Zaki', 'en', false],
};

const NOTICES = [
  {
    title_en: 'Extended trading hours for the holidays', title_ar: 'تمديد ساعات العمل خلال العطلات',
    body_en: 'From Thursday the mall stays open until 1:00 am every night of the holidays. Please plan your staff rotas, and let the operations desk know by Tuesday if your store keeps its usual hours.\n\nDeliveries stay limited to 7:00–10:00 am through the service corridor.',
    body_ar: 'اعتبارًا من الخميس يظل المول مفتوحًا حتى الواحدة صباحًا طوال أيام العطلات. يُرجى ترتيب جداول العاملين لديكم، وإبلاغ مكتب التشغيل قبل الثلاثاء إذا كان متجركم سيلتزم بمواعيده المعتادة.\n\nيظل استلام البضائع من ممر الخدمة بين السابعة والعاشرة صباحًا فقط.',
    days: -2,
  },
  {
    title_en: 'Fire and evacuation drill', title_ar: 'تدريب على الإخلاء ومكافحة الحريق',
    body_en: 'Civil Defence will run a full evacuation drill on Sunday at 9:00 am, before opening. Every store needs at least one person on site to follow the marshals and close the shutters.',
    body_ar: 'ينفّذ الدفاع المدني تدريبًا كاملًا على الإخلاء يوم الأحد في التاسعة صباحًا قبل الافتتاح. يجب أن يوجد شخص واحد على الأقل من كل متجر لاتباع تعليمات المشرفين وإغلاق الواجهات.',
    days: -6, expire: 20,
  },
  {
    title_en: 'Food court deep clean', title_ar: 'تنظيف شامل لمنطقة المطاعم',
    body_en: 'The food court kitchens’ grease ducts are cleaned on Monday night after closing. Please leave the hood access panels clear.',
    body_ar: 'تُنظَّف مجاري الدهون في مطابخ منطقة المطاعم ليلة الإثنين بعد الإغلاق. يُرجى ترك فتحات الوصول إلى الشفاطات خالية.',
    days: -1, brands: ['Kahwa House', 'Saffron Table'],
  },
  {
    title_en: 'Spring campaign: send us your offers', title_ar: 'حملة الربيع: أرسلوا لنا عروضكم',
    body_en: 'The spring campaign starts next month. Send your offers and a product photo to the marketing team to be featured on our social media and screens.',
    body_ar: 'تبدأ حملة الربيع الشهر المقبل. أرسلوا عروضكم مع صورة للمنتج إلى فريق التسويق لعرضها على صفحاتنا وشاشات المول.',
    draft: true,
  },
];

const ETA_SAMPLE = { eta_rin: '100234567', eta_name: 'The Wave Mall', eta_item_rent: 'RENT01', eta_item_service: 'SRVC01', eta_item_other: 'OTHR01' };

function load(db, admin, { h } = {}) {
  const has = (t) => db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  if (!has('portal_users')) return; // the portal module is not loaded (scripts)
  const now = new Date().toISOString();
  const T = M.today();
  const password = String(process.env.PORTAL_DEMO_PASSWORD || '') .length >= 10 ? process.env.PORTAL_DEMO_PASSWORD : `wave-${crypto.randomBytes(6).toString('base64url')}`;
  const hash = hashPassword(password);
  const users = {};
  db.tx(() => {
    db.setSetting('portal_demo_password', password);
    for (const [brand, [name, lang, joined]] of Object.entries(USERS)) {
      const b = db.get('SELECT * FROM brands WHERE name = ? AND demo = 1 ORDER BY id DESC LIMIT 1', brand);
      if (!b) continue;
      const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}${MAIL}`;
      if (db.get('SELECT id FROM portal_users WHERE email = ?', email)) continue;
      const id = Number(db.run('INSERT INTO portal_users (brand_id, name, email, lang, password_hash, invited_by, last_login_at, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
        b.id, name, email, lang, joined ? hash : null, admin ? admin.id : null, joined ? new Date(Date.now() - 2 * 86400000).toISOString() : null, now).lastInsertRowid);
      users[brand] = { id, brand_id: b.id, name, email, lang };
    }
    const brandIds = (names) => names.map((n) => users[n] && users[n].brand_id).filter(Boolean).join(',');
    for (const n of NOTICES) {
      const at = n.draft ? null : new Date(Date.now() + n.days * 86400000).toISOString();
      const audience = n.brands ? 'brands' : 'all';
      const id = Number(db.run('INSERT INTO portal_notices (title_en, title_ar, body_en, body_ar, audience, brand_ids, status, publish_at, expire_at, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
        n.title_en, n.title_ar, n.body_en, n.body_ar, audience, n.brands ? brandIds(n.brands) : null, n.draft ? 'draft' : 'published', at,
        n.expire ? `${M.addDays(T, n.expire)}T23:59:59.000Z` : null, admin ? admin.id : null, at || now).lastInsertRowid);
      if (n.days === -6 && users['Maison Lune']) db.run('INSERT INTO portal_notice_reads (notice_id, portal_user_id, read_at) VALUES (?, ?, ?)', id, users['Maison Lune'].id, now);
    }
  });

  if (!h || !h.payments) return;
  // two sandbox payments made "from the portal", and a payment link sent by the office
  // the oldest invoice due, else the next one (paid early)
  const firstOpen = (brand) => users[brand] && db.get("SELECT * FROM invoices WHERE brand_id = ? AND demo = 1 AND status IN ('open','partial') AND due_date <= ? ORDER BY due_date LIMIT 1", users[brand].brand_id, M.addDays(T, 45));
  let made = 0;
  const methods = ['card', 'wallet'];
  for (const brand of ['Maison Lune', 'Saffron Table', 'Lumière Beauty', 'Kahwa House']) {
    const inv = made < 2 && firstOpen(brand);
    if (!inv) continue;
    const method = methods[made++];
    const token = crypto.randomBytes(32).toString('base64url');
    const at = new Date(Date.now() - 86400000).toISOString();
    const id = Number(db.run(`INSERT INTO payment_intents (token, invoice_id, amount, currency, method, provider, status, source, portal_user_id, expires_at, created_at, updated_at, demo)
      VALUES (?, ?, ?, 'EGP', ?, 'sandbox', 'pending', 'portal', ?, ?, ?, ?, 1)`, token, inv.id, Math.round((inv.total - inv.paid) * 100) / 100, method, users[brand].id, at, at, at).lastInsertRowid);
    h.payments.settle({ id }, { txnId: `SBX-SAMPLE-${id}`, provider: 'sandbox' });
  }
  const linkInv = firstOpen('Kahwa House') || firstOpen('Lumière Beauty');
  if (linkInv) {
    db.run('INSERT INTO payment_links (token_hash, invoice_id, amount, expires_at, sent_to, created_by, demo, created_at) VALUES (?, ?, NULL, ?, ?, ?, 1, ?)',
      crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), linkInv.id, new Date(Date.now() + 12 * 86400000).toISOString(), 'thewave@kahwahouse.example', admin ? admin.id : null, now);
  }

  // e-invoices for this month's sample invoices, with sample issuer details if none are set
  if (!h.eta) return;
  if (!db.setting('eta_rin')) {
    for (const [k, v] of Object.entries(ETA_SAMPLE)) db.setSetting(k, v);
    db.setSetting('eta_demo', '1');
  }
  for (const inv of db.all("SELECT * FROM invoices WHERE demo = 1 AND status != 'void' AND substr(due_date, 1, 7) = ?", T.slice(0, 7))) h.eta.prepare(inv);
}

function clear(db) {
  const has = (t) => db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  db.tx(() => {
    if (has('eta_documents')) {
      db.run('DELETE FROM eta_log WHERE eta_document_id IN (SELECT id FROM eta_documents WHERE demo = 1 OR invoice_id IN (SELECT id FROM invoices WHERE demo = 1))');
      db.run('DELETE FROM eta_documents WHERE demo = 1 OR invoice_id IN (SELECT id FROM invoices WHERE demo = 1)');
      if (db.setting('eta_demo') === '1') for (const k of [...Object.keys(ETA_SAMPLE), 'eta_demo']) db.setSetting(k, '');
    }
    if (has('payment_intents')) {
      db.run('DELETE FROM payment_events WHERE intent_id IN (SELECT id FROM payment_intents WHERE demo = 1 OR invoice_id IN (SELECT id FROM invoices WHERE demo = 1))');
      db.run('DELETE FROM payment_intents WHERE demo = 1 OR invoice_id IN (SELECT id FROM invoices WHERE demo = 1)');
      db.run('DELETE FROM payment_links WHERE demo = 1 OR invoice_id IN (SELECT id FROM invoices WHERE demo = 1)');
    }
    if (has('portal_users')) {
      const ids = db.all('SELECT id FROM portal_users WHERE demo = 1 OR brand_id IN (SELECT id FROM brands WHERE demo = 1)').map((r) => r.id);
      for (const id of ids) {
        db.run('DELETE FROM portal_sessions WHERE portal_user_id = ?', id);
        db.run('DELETE FROM portal_tokens WHERE portal_user_id = ?', id);
        db.run('DELETE FROM portal_notice_reads WHERE portal_user_id = ?', id);
        db.run('UPDATE documents SET portal_user_id = NULL WHERE portal_user_id = ?', id);
        db.run('DELETE FROM portal_users WHERE id = ?', id);
      }
      db.run('DELETE FROM portal_notice_reads WHERE notice_id IN (SELECT id FROM portal_notices WHERE demo = 1)');
      db.run('DELETE FROM portal_notices WHERE demo = 1');
      db.setSetting('portal_demo_password', '');
    }
  });
}

module.exports = { load, clear };
