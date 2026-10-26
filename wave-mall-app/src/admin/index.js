'use strict';

// The Wave leasing office: an admin panel at /admin for the leasing team.
// mount(app) adds the routes; record() files website form submissions as inbox messages and leads.

const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const dbm = require('./db');
const auth = require('./auth');
const ui = require('./ui');
const M = require('./model');

function mount(app, { env = process.env } = {}) {
  const db = dbm.open(env);
  ui.setCurrency(db.setting('currency'));
  owner(db, env);

  const h = helpers(db);
  h.files = require('./files').store(env);
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.urlencoded({ extended: false, limit: '256kb' }));
  router.use(express.json({ limit: '64kb' }));
  router.use(auth.load(db));
  router.use(auth.language(db));

  const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
  require('./routes/core').public(router, h, { loginLimit });

  router.use(auth.requireUser);
  router.use(auth.csrf);
  // the language switch in the top bar
  router.post('/lang', (req, res) => {
    auth.setLanguage(db, req, res, req.body.lang);
    const back = String(req.body.back || '');
    res.redirect(303, /^\/admin(\/|$|\?)/.test(back) && !back.startsWith('//') ? back.replace(/([?&])lang=(en|ar)(&|$)/, '$1').replace(/[?&]$/, '') : '/admin');
  });
  require('./routes/core').private(router, h);
  require('./routes/sales')(router, h);
  require('./routes/deals')(router, h);
  require('./routes/property')(router, h);
  require('./routes/office')(router, h);
  require('./routes/files')(router, h);
  for (const mod of ['records', 'tenants', 'hr']) {
    try {
      require.resolve(`./routes/${mod}`);
    } catch {
      continue;
    }
    require(`./routes/${mod}`)(router, h);
  }

  app.use('/admin', express.static(path.join(__dirname, '..', '..', 'public', 'admin'), { index: false, redirect: false, maxAge: '365d', immutable: true }));
  app.use('/admin', router);
  return { db, record: (value) => record(db, value) };
}

// Shared helpers handed to every route module.
function helpers(db) {
  const counts = (user) => ({
    inbox: db.value("SELECT COUNT(*) FROM messages WHERE status = 'new'"),
    approvals: auth.allowed(user, 'manager') ? db.value("SELECT COUNT(*) FROM offers WHERE status = 'pending'") : 0,
    tasks: db.value("SELECT COUNT(*) FROM activities WHERE user_id = ? AND done_at IS NULL AND due_at IS NOT NULL AND due_at < ? AND type NOT IN ('viewing','meeting')", user.id, M.addDays(M.today(), 1)),
    overdue: db.value("SELECT COUNT(*) FROM invoices WHERE status IN ('open','partial') AND due_date < ?", M.today()),
    docs: db.value(`SELECT COUNT(*) FROM documents WHERE archived = 0 AND expires_on IS NOT NULL AND expires_on <= ? ${user.role === 'admin' || user.hr ? '' : "AND confidential = 0 AND entity != 'employee'"}`, M.addDays(M.today(), Number(db.setting('doc_warn_days')) || 30)),
    renewals: db.value("SELECT COUNT(*) FROM contracts WHERE status = 'active' AND end_date IS NOT NULL AND date(end_date, '-' || notice_days || ' days') <= ?", M.today()),
    leave: user.role === 'admin' || user.hr ? db.value("SELECT COUNT(*) FROM leave_requests WHERE status = 'pending'") : 0,
  });
  const h = {
    db, ui, M, auth,
    page(req, res, opts) {
      ui.setCurrency(db.setting('currency'));
      const html = ui.layout({ path: req.originalUrl, ...opts, user: req.user, csrf: req.session.csrf, nonce: res.locals.nonce, flash: auth.takeFlash(req, res), counts: counts(req.user) });
      res.type('html').send(html);
    },
    back(req, res, url, type, text) {
      if (text) auth.flash(req, res, type, text);
      res.redirect(303, url);
    },
    can: (req, min) => auth.allowed(req.user, min),
    R: (min) => auth.requireRole(min),
    // HR: administrators, and anyone given HR access on the Team page
    canHR: (req) => !!req.user && (req.user.role === 'admin' || !!req.user.hr),
    RH: (req, res, next) => (req.user && (req.user.role === 'admin' || req.user.hr) ? next() : auth.denied(req, res)),
    // where a form posted from, if it was an admin page; else the fallback
    safeBack: (req, fallback) => {
      const ref = String(req.get('referer') || '');
      const m = ref.match(/^https?:\/\/[^/]+(\/admin(?:[/?#].*)?)$/);
      return m && !m[1].startsWith('//') ? m[1].replace(/#.*$/, '') : fallback;
    },
    // the current documents filed against a record, as this person may see them
    docs: (req, entity, id) => db.all(
      `SELECT d.*, u.name uploader FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.entity = ? AND d.entity_id IS ? AND d.archived = 0 ${h.canHR(req) ? '' : "AND d.confidential = 0 AND d.entity != 'employee'"} ORDER BY d.kind, d.created_at DESC`,
      entity, entity === 'office' ? null : Number(id),
    ),
    log: (req, action, entity, id, detail) => db.audit(req.user, action, entity, id, detail, req.ip),
    str: (v, max = 500) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max),
    int: (v) => (v === '' || v === undefined || v === null || Number.isNaN(Number(v)) ? null : Math.round(Number(v))),
    numv: (v) => M.num(v),
    list: (v) => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]),
    // housekeeping on page loads: holds and offers that ran out
    sweep(req) {
      const t = M.today();
      for (const u of db.all("SELECT id, code FROM units WHERE status = 'hold' AND hold_until IS NOT NULL AND hold_until < ?", t)) {
        db.run("UPDATE units SET status = 'available', hold_until = NULL, hold_lead_id = NULL, updated_at = ? WHERE id = ?", M.now(), u.id);
        db.audit(null, 'Hold expired', 'unit', u.id, u.code);
      }
      for (const o of db.all("SELECT id, ref FROM offers WHERE status IN ('sent','approved','draft','pending') AND valid_until IS NOT NULL AND valid_until < ?", t)) {
        db.run("UPDATE offers SET status = 'expired' WHERE id = ?", o.id);
        db.audit(null, 'Offer expired', 'offer', o.id, o.ref);
      }
      return req;
    },
    users: () => db.all('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name'),
  };
  return h;
}

// A first account from the environment, so the owner can sign in without the setup page:
// OWNER_EMAIL and OWNER_PASSWORD (and optionally OWNER_NAME). Created once as an administrator
// with HR access; set OWNER_RESET=1 to reset that account's password to OWNER_PASSWORD.
function owner(db, env) {
  const email = String(env.OWNER_EMAIL || '').trim();
  const password = String(env.OWNER_PASSWORD || '');
  if (!email || !password) return;
  if (password.length < 10) {
    console.warn('[admin] OWNER_PASSWORD must be at least 10 characters; owner account not created.');
    return;
  }
  const u = db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', email);
  if (!u) {
    const r = db.run("INSERT INTO users (name, email, role, password_hash, hr, created_at) VALUES (?, ?, 'admin', ?, 1, ?)", String(env.OWNER_NAME || 'Owner').slice(0, 120), email, dbm.hashPassword(password), M.now());
    db.audit(null, 'Owner account created', 'user', Number(r.lastInsertRowid), email);
  } else if (env.OWNER_RESET === '1') {
    db.run("UPDATE users SET password_hash = ?, active = 1, role = 'admin', hr = 1 WHERE id = ?", dbm.hashPassword(password), u.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    db.audit(null, 'Owner password reset', 'user', u.id, email);
  }
}

// Website forms: every submission lands in the inbox; leasing enquiries also open a lead.
const SIZE = { s: [40, 100], m: [100, 250], l: [250, 800] };
function record(db, v) {
  const t = M.now();
  if (v.kind === 'subscribe') {
    db.run('INSERT INTO subscribers (email, lang, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING', v.email, v.lang, 'website', t);
    return;
  }
  db.tx(() => {
    const msg = db.run(
      'INSERT INTO messages (kind, name, email, phone, brand, subject, category, size, body, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      v.kind, v.name, v.email, v.phone || null, v.brand || null, v.subject || null, v.category || null, v.size || null, v.message || null, v.lang, t,
    );
    if (v.kind !== 'leasing') return;
    let brand = db.get('SELECT id FROM brands WHERE name = ? COLLATE NOCASE', v.brand);
    if (!brand) brand = { id: Number(db.run('INSERT INTO brands (name, category, created_at) VALUES (?, ?, ?)', v.brand, M.CATEGORIES[v.category] ? v.category : 'other', t).lastInsertRowid) };
    const contact = db.run('INSERT INTO contacts (brand_id, name, email, phone, primary_contact, created_at) VALUES (?, ?, ?, ?, 1, ?)', brand.id, v.name, v.email, v.phone || null, t);
    const [amin, amax] = SIZE[v.size] || [null, null];
    const lead = {
      ref: db.nextRef('leads', 'LD'), brand_id: brand.id, contact_id: Number(contact.lastInsertRowid), title: v.brand,
      category: M.CATEGORIES[v.category] ? v.category : 'other', source: 'website', area_min: amin, area_max: amax,
    };
    lead.value_est = M.estimateValue(db, lead);
    const res = db.run(
      `INSERT INTO leads (ref, brand_id, contact_id, title, category, source, stage, probability, area_min, area_max, value_est, message, next_step, next_step_at, created_at, updated_at, stage_at)
       VALUES (?, ?, ?, ?, ?, 'website', 'new', 10, ?, ?, ?, ?, 'Reply to the website enquiry', ?, ?, ?, ?)`,
      lead.ref, lead.brand_id, lead.contact_id, lead.title, lead.category, lead.area_min, lead.area_max, lead.value_est, v.message || null, M.addDays(M.today(), 1), t, t, t,
    );
    db.run("UPDATE messages SET lead_id = ?, status = 'converted' WHERE id = ?", Number(res.lastInsertRowid), Number(msg.lastInsertRowid));
    db.audit(null, 'Website enquiry', 'lead', Number(res.lastInsertRowid), `${lead.ref} · ${v.brand}`);
  });
}

module.exports = { mount, record };
