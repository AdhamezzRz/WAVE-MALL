'use strict';

// Sample data for exploring the leasing office. Every brand and person here is fictional.
// Sample rows carry demo = 1 (users: an @demo.thewave.local email) so clear() removes only them.

const crypto = require('node:crypto');
const M = require('./model');
const { hashPassword } = require('./db');

const DEMO_MAIL = '@demo.thewave.local';

const TEAM = [
  ['Karim Mostafa', 'manager', 'Head of leasing'],
  ['Salma Adel', 'agent', 'Senior leasing executive'],
  ['Omar Fathy', 'agent', 'Leasing executive'],
  ['Nour Hassan', 'agent', 'Leasing executive'],
];

// title, category, source, stage, owner (index into TEAM), area [min,max], unit, days ago, contact, tier
const LEADS = [
  ['Maison Lune', 'fashion', 'referral', 'won', 1, [350, 520], 'G01', 150, ['Laila Saber', 'Expansion director'], 'premium'],
  ['Kahwa House', 'fnb', 'direct', 'won', 2, [280, 320], 'G04', 140, ['Tarek Nabil', 'Founder'], 'premium'],
  ['Lumière Beauty', 'beauty', 'website', 'won', 3, [50, 80], 'S02', 120, ['Dina Farouk', 'Retail manager'], 'mid'],
  ['Saffron Table', 'fnb', 'broker', 'won', 1, [280, 320], 'G12', 110, ['Hany Gamal', 'Operations director'], 'premium'],
  ['Atelier Nour', 'fashion', 'event', 'reserved', 1, [170, 210], 'G08', 75, ['Mariam Zaki', 'Creative director'], 'luxury'],
  ['Olive & Oak Kitchen', 'fnb', 'referral', 'negotiation', 2, [280, 320], 'G05', 60, ['Youssef Amin', 'Managing partner'], 'premium'],
  ['Cedar Fitness', 'leisure', 'direct', 'negotiation', 3, [180, 220], 'G03', 55, ['Ahmed Kamel', 'Development manager'], 'mid'],
  ['Desert Rose Perfumery', 'beauty', 'website', 'proposal', 2, [55, 70], 'S05', 40, ['Reem Ashraf', 'Brand owner'], 'luxury'],
  ['Nile Optics', 'health', 'phone', 'proposal', 3, [55, 70], 'S04', 35, ['Sherif Lotfy', 'Regional manager'], 'mid'],
  ['Petit Pas Kids', 'fashion', 'social', 'viewing', 1, [150, 200], 'G07', 28, ['Hana Mourad', 'Brand manager'], 'mid'],
  ['The Linen Room', 'home', 'event', 'viewing', 2, [160, 200], 'G10', 26, ['Nadia Salem', 'Co-founder'], 'premium'],
  ['Ember Grill', 'fnb', 'broker', 'viewing', 3, [180, 220], 'G11', 22, ['Mostafa Ragab', 'Franchise director'], 'mid'],
  ['Oud & Amber', 'beauty', 'referral', 'proposal', 1, [60, 120], 'S01', 30, ['Khaled Wahba', 'CEO'], 'luxury'],
  ['Habibi Gelato', 'fnb', 'social', 'contacted', 2, [40, 70], null, 18, ['Farida Hosny', 'Founder'], 'mid'],
  ['Azure Swim', 'fashion', 'website', 'contacted', 3, [60, 90], null, 15, ['Ali Ibrahim', 'Brand owner'], 'premium'],
  ['Pulse Pharmacy', 'health', 'direct', 'contacted', 2, [100, 160], null, 12, ['Rania Fouad', 'Expansion lead'], 'value'],
  ['Bloom Florals', 'home', 'website', 'new', null, [40, 70], null, 3, ['Salma Nasser', 'Founder'], 'premium'],
  ['Kiko Juice Bar', 'fnb', 'website', 'new', null, [40, 70], null, 2, ['Omar Rashad', 'Brand owner'], 'mid'],
  ['Marble & Brass', 'home', 'direct', 'new', 1, [160, 220], null, 6, ['Mona Sobhy', 'Partner'], 'luxury'],
  ['Cotton Trail', 'fashion', 'walk_in', 'new', 3, [100, 180], null, 1, ['Adel Samir', 'Store manager'], 'value'],
  ['Velvet Cinema Lounge', 'leisure', 'broker', 'lost', 1, [600, 900], null, 90, ['Ihab Galal', 'Development director'], 'premium'],
  ['Sands & Co.', 'fashion', 'website', 'lost', 2, [150, 200], null, 70, ['Yasmine Adly', 'Buyer'], 'mid'],
];

// Sample data for the newer modules lives beside this file (demo-records.js, demo-tenants.js, demo-hr.js).
// Each exports load(db, admin, { files }) and clear(db, { files }).
// Order matters: accounting comes last so it can post everything the others created.
const EXTRAS = ['demo-tenants', 'demo-records', 'demo-hr', 'demo-comms', 'demo-portal', 'demo-fitout', 'demo-website', 'demo-ops', 'demo-revenue', 'demo-parking', 'demo-accounting'];
const extras = () => EXTRAS.flatMap((m) => {
  try {
    return [require(`./${m}`)];
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(m)) return [];
    throw err;
  }
});

function load(db, admin, opts = {}) {
  if (db.value('SELECT COUNT(*) FROM leads WHERE demo = 1')) return;
  // without the office's billing service (scripts, tests), bill quietly with no listeners
  const bill = opts.billing || require('./billing').billing(db, require('./events').bus());
  loadSales(db, admin, bill);
  for (const x of extras()) x.load(db, admin, opts);
}

function loadSales(db, admin, bill) {
  const T = M.today();
  // Past moments land in office hours (09:00–17:30 UTC+3) so the calendar reads like a real week.
  const ago = (d) => {
    const t = new Date(Date.now() - d * 86400000);
    const slot = Math.floor(Math.abs(d) * 7.3) % 17;
    t.setUTCHours(6 + Math.floor(slot / 2), slot % 2 ? 30 : 0, 0, 0);
    return (t > new Date() ? new Date(Date.now() - 3600000) : t).toISOString();
  };
  const day = (d) => M.addDays(T, d);
  const unit = (code) => db.get('SELECT * FROM units WHERE code = ?', code);

  db.tx(() => {
    if (!db.setting('rate_plaza')) {
      db.setSetting('rate_plaza', '2200');
      db.setSetting('rate_street', '1700');
      db.setSetting('service_m2', '140');
      db.setSetting('demo_rates', '1');
    }

    const team = TEAM.map(([name, role, title]) => {
      const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}${DEMO_MAIL}`;
      const existing = db.get('SELECT id FROM users WHERE email = ?', email);
      if (existing) return existing.id;
      return Number(db.run('INSERT INTO users (name, email, role, title, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)', name, email, role, title, hashPassword(crypto.randomBytes(18).toString('hex')), ago(200), ago(Math.random() * 3)).lastInsertRowid);
    });
    const ownerId = (i) => (i === null ? null : team[i]);

    const offer = (leadId, codes, terms, status, daysAgo, by) => {
      const units = codes.map(unit);
      const r = db.run(
        `INSERT INTO offers (ref, lead_id, status, rent_m2, terrace_rent_m2, service_m2, term_years, escalation_pct, rent_free_months, fitout_months, deposit_months, key_money, start_date, valid_until, notes, needs_approval, created_by, demo, created_at, sent_at, decided_at, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        db.nextRef('offers', 'OF', 3, true), leadId, status, terms.rent, Math.round(terms.rent * 0.4), 140, terms.years || 5, terms.esc ?? 10, terms.free || 0, terms.fitout ?? 2, 3, terms.key || 0,
        terms.start || M.addMonths(T, 2), terms.valid || day(14), terms.notes || 'Signage per The Wave design guidelines. Trading hours 10:00–24:00.', status === 'pending' ? 1 : 0, by, ago(daysAgo),
        ['sent', 'accepted', 'rejected'].includes(status) ? ago(daysAgo - 1) : null, ['accepted', 'rejected'].includes(status) ? ago(Math.max(1, daysAgo - 6)) : null,
        status === 'approved' ? team[0] : null, status === 'approved' ? ago(daysAgo - 1) : null,
      );
      const id = Number(r.lastInsertRowid);
      for (const u of units) db.run('INSERT INTO offer_units (offer_id, unit_id) VALUES (?, ?)', id, u.id);
      return id;
    };
    const act = (leadId, brandId, userId, type, subject, when, done = true, body = null) => {
      db.run('INSERT INTO activities (lead_id, brand_id, user_id, type, subject, body, due_at, done_at, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', leadId, brandId, userId, type, subject, body, when, done ? when : null, done ? when : ago(1));
    };

    const leads = {};
    for (const [title, cat, source, stage, owner, [amin, amax], code, daysAgo, [cname, ctitle], tier] of LEADS) {
      const b = Number(db.run('INSERT INTO brands (name, category, tier, origin, stores, notes, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', title, cat, tier, 'Egyptian', 1 + Math.floor(Math.random() * 9), null, ago(daysAgo + 5)).lastInsertRowid);
      const handle = cname.toLowerCase().split(' ')[0];
      const c = Number(db.run('INSERT INTO contacts (brand_id, name, title, email, phone, primary_contact, demo, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)', b, cname, ctitle, `${handle}@example.com`, `+20 10 ${String(10000000 + Math.floor(Math.random() * 89999999)).replace(/(\d{4})(\d{4})/, '$1 $2')}`, ago(daysAgo)).lastInsertRowid);
      const u = code ? unit(code) : null;
      const st = M.stage(stage);
      const lead = { brand_id: b, title, category: cat, source, area_min: amin, area_max: amax, unit_id: u ? u.id : null, zone: u ? u.zone : null };
      const value = M.estimateValue(db, lead);
      const nextAt = M.OPEN_STAGES.includes(stage) ? day(stage === 'new' ? 1 : Math.round(Math.random() * 8) - 2) : null;
      const next = { new: 'First call', contacted: 'Send the brochure and floor plans', viewing: 'Site viewing', proposal: 'Follow up on the proposal', negotiation: 'Agree final terms', reserved: 'Lease signature' }[stage] || null;
      const id = Number(db.run(
        `INSERT INTO leads (ref, brand_id, contact_id, title, category, source, stage, probability, area_min, area_max, zone, unit_id, value_est, owner_id, next_step, next_step_at, message, lost_reason, demo, created_at, updated_at, stage_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        db.nextRef('leads', 'LD'), b, c, title, cat, source, stage, st.p, amin, amax, lead.zone, lead.unit_id, value, ownerId(owner), next, nextAt,
        source === 'website' ? `We are looking for ${amin}–${amax} m² in New Cairo and love the terraces at The Wave.` : null,
        stage === 'lost' ? (title.startsWith('Velvet') ? 'Unit size' : 'Price') : null, ago(daysAgo), ago(Math.min(daysAgo, Math.random() * 6)), ago(Math.max(1, daysAgo / 3)), ['won', 'lost'].includes(stage) ? ago(Math.max(1, daysAgo - 40)) : null,
      ).lastInsertRowid);
      leads[title] = { id, b, owner: ownerId(owner) || team[0], stage, u, daysAgo };

      // a believable trail of activity
      const by = ownerId(owner) || team[0];
      if (stage !== 'new' || source === 'website') act(id, b, by, source === 'website' ? 'email' : 'call', source === 'website' ? 'Replied to the website enquiry' : `Intro call with ${cname.split(' ')[0]}`, ago(daysAgo - 1));
      if (M.stage(stage).p >= 20 && stage !== 'lost') act(id, b, by, 'email', 'Sent brochure, plans and unit schedule', ago(Math.max(1, daysAgo - 4)));
      if (M.stage(stage).p >= 35 && stage !== 'lost') act(id, b, by, 'viewing', `Site viewing${u ? `, ${u.code}` : ''}`, ago(Math.max(1, daysAgo - 9)), true, 'Walked the plaza and the terraces. Liked the frontage onto the court.');
      if (M.stage(stage).p >= 70 && stage !== 'lost') act(id, b, by, 'meeting', 'Terms meeting at the leasing suite', ago(Math.max(1, daysAgo - 20)));
      if (nextAt) act(id, b, by, stage === 'viewing' ? 'viewing' : stage === 'new' ? 'call' : 'task', next, `${nextAt}T${['10:30', '12:00', '14:00', '16:30'][id % 4]}`, false);
    }

    const L = (t) => leads[t];
    // offers in every state
    offer(L('Atelier Nour').id, ['G08'], { rent: 2300, years: 7, free: 3 }, 'accepted', 30, L('Atelier Nour').owner);
    offer(L('Olive & Oak Kitchen').id, ['G05'], { rent: 2150, years: 6, free: 4, key: 250000 }, 'sent', 12, L('Olive & Oak Kitchen').owner);
    offer(L('Cedar Fitness').id, ['G03'], { rent: 1750, years: 8, free: 6 }, 'pending', 3, L('Cedar Fitness').owner);
    offer(L('Desert Rose Perfumery').id, ['S05'], { rent: 1750, years: 5, free: 1 }, 'sent', 9, L('Desert Rose Perfumery').owner);
    offer(L('Nile Optics').id, ['S04'], { rent: 1650, years: 5, free: 2 }, 'draft', 2, L('Nile Optics').owner);
    offer(L('Oud & Amber').id, ['S01'], { rent: 1800, years: 5 }, 'approved', 6, L('Oud & Amber').owner);
    offer(L('Sands & Co.').id, ['G09'], { rent: 2100, years: 5 }, 'rejected', 60, L('Sands & Co.').owner);

    // units: reserved, held
    db.run("UPDATE units SET status = 'reserved', hold_lead_id = ? WHERE code = 'G08'", L('Atelier Nour').id);
    db.run("UPDATE units SET status = 'hold', hold_lead_id = ?, hold_until = ? WHERE code = 'G05'", L('Olive & Oak Kitchen').id, day(4));
    db.run("UPDATE units SET status = 'hold', hold_lead_id = ?, hold_until = ? WHERE code = 'S05'", L('Desert Rose Perfumery').id, day(1));

    // four tenants, with billing history
    const lease = (title, codes, rent, startAgo, freq, signedAgo, free = 0) => {
      const l = L(title);
      const units = codes.map(unit);
      const start = M.addDays(T, -startAgo);
      const oid = offer(l.id, codes, { rent, years: 5, free, start, valid: M.addDays(T, -startAgo + 10) }, 'accepted', signedAgo + 10, l.owner);
      const r = db.run(
        `INSERT INTO leases (ref, brand_id, lead_id, offer_id, status, start_date, end_date, term_years, rent_m2, terrace_rent_m2, service_m2, escalation_pct, rent_free_months, payment_freq, deposit, signed_at, created_by, demo, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, 5, ?, ?, 140, 10, ?, ?, ?, ?, ?, 1, ?)`,
        db.nextRef('leases', 'LS', 3, true), l.b, l.id, oid, start, M.addDays(M.addMonths(start, 60), -1), rent, Math.round(rent * 0.4), free, freq,
        Math.round(M.monthly(units, { rent, terrace: rent * 0.4 }).rent * 3), M.addDays(T, -signedAgo), team[0], ago(signedAgo),
      );
      const id = Number(r.lastInsertRowid);
      for (const u of units) {
        db.run('INSERT INTO lease_units (lease_id, unit_id) VALUES (?, ?)', id, u.id);
        db.run("UPDATE units SET status = 'leased', hold_lead_id = NULL, hold_until = NULL WHERE id = ?", u.id);
      }
      const s = db.get('SELECT * FROM leases WHERE id = ?', id);
      for (const p of M.invoicePlan(s, units)) {
        const due = p.due_date;
        const total = p.rent + p.service;
        const late = title === 'Saffron Table' && due < T && due > M.addDays(T, -60);
        const paid = due < M.addDays(T, -5) && !late ? total : 0;
        if (!(total > 0)) continue;
        const inv = bill.createInvoice({ lease_id: id, kind: 'rent', period_start: p.period_start, period_end: p.period_end, due_date: due, rent: p.rent, service: p.service, demo: 1 });
        if (paid) bill.recordPayment({ invoice_id: inv.id, amount: total, date: M.addDays(due, 4), method: 'transfer', reference: `TRF-${inv.ref.slice(-4)}`, demo: 1 });
      }
      const dep = bill.createInvoice({ lease_id: id, kind: 'deposit', due_date: M.addDays(T, -signedAgo), other: s.deposit, note: 'Security deposit', demo: 1 });
      bill.recordPayment({ invoice_id: dep.id, amount: s.deposit, date: M.addDays(T, -signedAgo + 3), method: 'transfer', reference: `TRF-${dep.ref.slice(-4)}`, demo: 1 });
    };
    lease('Maison Lune', ['G01', 'G02'], 2350, 75, 'quarterly', 100, 2);
    lease('Kahwa House', ['G04'], 2250, 95, 'monthly', 115, 1);
    lease('Lumière Beauty', ['S02'], 1800, 50, 'monthly', 70);
    lease('Saffron Table', ['G12'], 2200, 85, 'monthly', 100, 0);

    // the website inbox
    const msg = (kind, name, email, brand, body, daysAgo, leadTitle, extra = {}) => db.run(
      'INSERT INTO messages (kind, name, email, phone, brand, subject, category, size, body, lang, status, lead_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
      kind, name, email, extra.phone || null, brand, extra.subject || null, extra.category || null, extra.size || null, body, extra.lang || 'en', leadTitle ? 'converted' : extra.status || 'new', leadTitle ? L(leadTitle).id : null, ago(daysAgo),
    );
    msg('leasing', 'Salma Nasser', 'salma@example.com', 'Bloom Florals', 'We are a florist and gift studio looking for a small unit with a terrace for display. Is there anything around 50 m²?', 3, 'Bloom Florals', { category: 'home', size: 's' });
    msg('leasing', 'Omar Rashad', 'omar@example.com', 'Kiko Juice Bar', 'Fresh juice and bowls. Interested in a street-level unit near the entrance.', 2, 'Kiko Juice Bar', { category: 'fnb', size: 's' });
    msg('contact', 'Mai Hamdy', 'mai@example.com', null, 'When does The Wave open? I would love to know about the restaurants.', 1, null, { subject: 'general' });
    msg('contact', 'سارة عادل', 'sara@example.com', null, 'هل توجد فرص عمل في المول؟', 0.4, null, { subject: 'careers', lang: 'ar' });
    msg('contact', 'Press desk', 'press@example.com', null, 'We are preparing a feature on new destinations in New Cairo and would like to visit.', 6, null, { subject: 'press', status: 'read' });

    for (let i = 0; i < 34; i++) {
      db.run('INSERT INTO subscribers (email, lang, source, demo, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(email) DO NOTHING', `guest${i + 1}@example.com`, i % 3 === 0 ? 'ar' : 'en', 'website', ago(Math.random() * 120));
    }

    const period = T.slice(0, 7);
    for (const id of team.slice(1)) db.run('INSERT INTO targets (period, user_id, leads, viewings, signed_m2, revenue) VALUES (?, ?, 8, 6, 250, 6000000) ON CONFLICT(period, user_id) DO NOTHING', period, id);

    db.audit(admin, 'Loaded sample data', 'settings', null, `${LEADS.length} leads, 4 leases`);
  });
}

function clear(db, opts = {}) {
  for (const x of extras().reverse()) x.clear(db, opts);
  // any sample document left, and its file once nothing else uses it
  const docs = db.all('SELECT id, stored FROM documents WHERE demo = 1');
  db.run('UPDATE documents SET replaces_id = NULL WHERE replaces_id IN (SELECT id FROM documents WHERE demo = 1)');
  db.run('DELETE FROM documents WHERE demo = 1');
  if (opts.files) for (const d of docs) opts.files.release(db, d.stored);
  db.tx(() => {
    const leaseIds = db.all('SELECT id FROM leases WHERE demo = 1').map((r) => r.id);
    for (const id of leaseIds) {
      for (const u of M.leaseUnits(db, id)) db.run("UPDATE units SET status = 'available', hold_until = NULL, hold_lead_id = NULL WHERE id = ?", u.id);
    }
    const leadIds = db.all('SELECT id FROM leads WHERE demo = 1').map((r) => r.id);
    for (const id of leadIds) db.run("UPDATE units SET status = 'available', hold_until = NULL, hold_lead_id = NULL WHERE hold_lead_id = ?", id);
    db.run('DELETE FROM payments WHERE demo = 1 OR invoice_id IN (SELECT id FROM invoices WHERE demo = 1 OR lease_id IN (SELECT id FROM leases WHERE demo = 1))');
    db.run('DELETE FROM invoices WHERE demo = 1 OR lease_id IN (SELECT id FROM leases WHERE demo = 1)');
    db.run('DELETE FROM leases WHERE demo = 1');
    db.run('DELETE FROM offers WHERE demo = 1 OR lead_id IN (SELECT id FROM leads WHERE demo = 1)');
    db.run('DELETE FROM messages WHERE demo = 1');
    db.run('DELETE FROM activities WHERE demo = 1 OR lead_id IN (SELECT id FROM leads WHERE demo = 1)');
    db.run('DELETE FROM leads WHERE demo = 1');
    db.run('DELETE FROM contacts WHERE demo = 1');
    db.run('DELETE FROM brands WHERE demo = 1 AND id NOT IN (SELECT brand_id FROM leads WHERE brand_id IS NOT NULL) AND id NOT IN (SELECT brand_id FROM leases)');
    db.run('DELETE FROM subscribers WHERE demo = 1');
    const demoUsers = db.all('SELECT id FROM users WHERE email LIKE ?', `%${DEMO_MAIL}`).map((r) => r.id);
    for (const id of demoUsers) {
      db.run('UPDATE leads SET owner_id = NULL WHERE owner_id = ?', id);
      db.run('UPDATE audit SET user_id = NULL WHERE user_id = ?', id);
      db.run('UPDATE offers SET created_by = NULL WHERE created_by = ?', id);
      db.run('UPDATE offers SET approved_by = NULL WHERE approved_by = ?', id);
      db.run('UPDATE leases SET created_by = NULL WHERE created_by = ?', id);
      db.run('DELETE FROM users WHERE id = ?', id);
    }
    if (db.setting('demo_rates') === '1') {
      for (const k of ['rate_plaza', 'rate_street', 'service_m2', 'demo_rates']) db.setSetting(k, '');
    }
  });
}

module.exports = { load, clear };
