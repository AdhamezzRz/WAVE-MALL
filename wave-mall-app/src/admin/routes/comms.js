'use strict';

// Deal communication: offers by email with online e-signature, WhatsApp Business, one inbox for
// every conversation, notifications and the daily digest, and the Integrations page.
//
// Public pages (no sign-in) live on h.public: /sign/:token (review, sign or decline an offer) and
// /webhooks/whatsapp (Meta's webhook). Everything stored by the system is English; the reader's
// language comes from i18n at display time.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const { mailer, template, facts, escH } = require('../mailer');
const { whatsapp, normalizePhone, pretty, waLink } = require('../whatsapp');

const { t: tr, tn, tx } = i18n;

const SCHEMA = `
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'email', to_addr TEXT, cc TEXT, reply_to TEXT, subject TEXT,
    body_html TEXT, body_text TEXT, attachments TEXT, lang TEXT, status TEXT NOT NULL DEFAULT 'queued', error TEXT,
    provider_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, related_entity TEXT, related_id INTEGER, thread_id INTEGER,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, sent_at TEXT
  );
  CREATE INDEX outbox_status ON outbox(status, created_at);

  CREATE TABLE conv_threads (
    id INTEGER PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, name TEXT,
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL, brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL, assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    unread INTEGER NOT NULL DEFAULT 0, last_at TEXT, last_in_at TEXT, last_preview TEXT, status TEXT NOT NULL DEFAULT 'open',
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (channel, address)
  );
  CREATE INDEX conv_threads_last ON conv_threads(last_at);
  CREATE TABLE conv_messages (
    id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES conv_threads(id) ON DELETE CASCADE,
    direction TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', subject TEXT, body TEXT, template TEXT,
    status TEXT NOT NULL DEFAULT 'sent', provider_id TEXT, error TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    outbox_id INTEGER, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX conv_messages_thread ON conv_messages(thread_id, created_at);
  CREATE INDEX conv_messages_provider ON conv_messages(provider_id);
  CREATE TABLE snippets (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, body_en TEXT, body_ar TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );

  CREATE TABLE offer_signing (
    id INTEGER PRIMARY KEY, offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'en', sent_to TEXT, via TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0, first_viewed_at TEXT, last_viewed_at TEXT, status TEXT NOT NULL DEFAULT 'open',
    signed_at TEXT, signer_name TEXT, signer_title TEXT, signer_email TEXT, signature TEXT, signature_kind TEXT,
    ip TEXT, user_agent TEXT, doc_hash TEXT, snapshot TEXT, document_id INTEGER, decline_reason TEXT, decided_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX offer_signing_offer ON offer_signing(offer_id);

  CREATE TABLE notif_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    digest INTEGER NOT NULL DEFAULT 1, signed INTEGER NOT NULL DEFAULT 1, enquiry INTEGER NOT NULL DEFAULT 1, payment INTEGER NOT NULL DEFAULT 1
  );
`;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Pages for people outside the office (the signing page, the signed record): without the office
// app's manifest and service worker, and (for the record) without any script at all.
const outsider = (html, { scripts = true } = {}) => {
  let out = html.replace(/<link rel="manifest"[^>]*>\n?/, '').replace(/<meta name="(?:mobile-web-app-capable|apple-mobile-web-app-[a-z-]+)"[^>]*>\n?/g, '').replace(/<script src="\/admin\/app\/pwa\.js[^>]*><\/script>\n?/, '');
  if (!scripts) out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  return out;
};
const nowIso = () => new Date().toISOString();
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const ORDER = { queued: 0, manual: 1, sent: 1, delivered: 2, read: 3 };

// The size of a JPEG, read from its frame header; null when it is not a JPEG.
function jpegInfo(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    i += 2 + len;
  }
  return null;
}

// A signature image from the signing form: a JPEG data URL, sensibly sized.
function readSignature(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 600 || buf.length > 400 * 1024) return null;
  const info = jpegInfo(buf);
  if (!info || info.w < 80 || info.h < 30 || info.w > 2400 || info.h > 1400 || ![1, 3].includes(info.comps)) return null;
  return { buf, ...info, dataUrl: `data:image/jpeg;base64,${m[1]}` };
}

// The signature certificate as a one-page PDF (A4), with the signature image embedded.
function certificatePdf({ title, lines, sig }) {
  const ascii = (s) => (/[^\x20-\x7e]/.test(String(s)) ? null : String(s));
  const esc = (s) => String(s).replace(/([()\\])/g, '\\$1');
  const ops = [
    'BT /F2 9 Tf 0.45 0.5 0.47 rg 56 790 Td (THE WAVE  |  NORTH 90, NEW CAIRO) Tj ET',
    '0.16 0.22 0.2 RG 1 w 56 774 m 539 774 l S',
    `BT /F2 20 Tf 0.12 0.16 0.15 rg 56 734 Td (${esc(title)}) Tj ET`,
  ];
  let y = 700;
  for (const [k, v] of lines) {
    const val = ascii(v) ?? '(written in Arabic; see the signed record in the leasing office)';
    ops.push(`BT /F2 9 Tf 0.45 0.5 0.47 rg 56 ${y} Td (${esc(k.toUpperCase())}) Tj ET`);
    const parts = val.match(/.{1,78}/g) || [''];
    parts.forEach((p, i) => ops.push(`BT /F1 11 Tf 0.12 0.16 0.15 rg 200 ${y - i * 14} Td (${esc(p)}) Tj ET`));
    y -= 14 * parts.length + 10;
  }
  let image = null;
  if (sig) {
    const w = 240;
    const hgt = Math.round((sig.h / sig.w) * w);
    y -= 10;
    ops.push(`BT /F2 9 Tf 0.45 0.5 0.47 rg 56 ${y} Td (SIGNATURE) Tj ET`);
    ops.push(`q 0.85 0.82 0.75 RG 0.6 w 196 ${y - hgt - 8} ${w + 8} ${hgt + 12} re S Q`);
    ops.push(`q ${w} 0 0 ${hgt} 200 ${y - hgt - 4} cm /Im1 Do Q`);
    image = sig;
  }
  ops.push('BT /F1 8 Tf 0.55 0.58 0.56 rg 56 60 Td (This certificate records an electronic acceptance made through The Wave leasing office.) Tj ET');
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >>${image ? ' /XObject << /Im1 7 0 R >>' : ''} >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    Buffer.concat([Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n`, 'latin1'), Buffer.from(content, 'latin1'), Buffer.from('\nendstream', 'latin1')]),
  ];
  if (image) {
    objs.push(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /${image.comps === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.buf.length} >>\nstream\n`, 'latin1'),
      image.buf, Buffer.from('\nendstream', 'latin1'),
    ]));
  }
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let len = chunks[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(b);
    len += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

module.exports = function comms(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  const env = h.env || process.env;
  db.ensure('comms-1', SCHEMA);

  const mail = mailer(db, env);
  const wa = whatsapp(env);
  h.mail = mail;
  h.whatsapp = wa;
  const site = (req) => String(env.SITE_URL || (req ? `${req.protocol}://${req.get('host')}` : 'https://thewavemall.com')).replace(/\/$/, '');
  const managers = () => db.all("SELECT * FROM users WHERE active = 1 AND role IN ('admin','manager') AND email IS NOT NULL");
  const prefs = (userId) => db.get('SELECT * FROM notif_prefs WHERE user_id = ?', userId) || { digest: 1, signed: 1, enquiry: 1, payment: 1 };
  const userLang = (u) => (u && u.lang === 'ar' ? 'ar' : 'en');
  const cairoNow = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  };
  const statusLabel = () => ({
    queued: tr('com|Queued'), sent: tr('com|Sent'), delivered: tr('com|Delivered'), read: tr('com|Read'), failed: tr('com|Failed'),
    not_configured: tr('com|Not sent (not set up)'), manual: tr('com|Sent from your phone'), received: tr('com|Received'),
  });
  const statusTone = { queued: 'mute', sent: 'sky', delivered: 'sea', read: 'ok', failed: 'rose', not_configured: 'amber', manual: 'sand', received: 'forest' };
  const ticks = (st) => (st === 'read' ? '<span class="tick tick--read" aria-hidden="true">✓✓</span>' : st === 'delivered' ? '<span class="tick" aria-hidden="true">✓✓</span>' : ['sent', 'manual'].includes(st) ? '<span class="tick" aria-hidden="true">✓</span>' : st === 'failed' ? '<span class="tick tick--bad" aria-hidden="true">!</span>' : '');

  // ---------- threads ----------
  function matchContact(channel, address) {
    if (channel === 'email') {
      const c = db.get('SELECT * FROM contacts WHERE email = ? COLLATE NOCASE ORDER BY primary_contact DESC, id DESC LIMIT 1', address);
      return c || null;
    }
    for (const c of db.all('SELECT * FROM contacts WHERE phone IS NOT NULL OR whatsapp IS NOT NULL ORDER BY primary_contact DESC, id DESC')) {
      if (normalizePhone(c.whatsapp) === address || normalizePhone(c.phone) === address) return c;
    }
    return null;
  }
  function leadFor(contact) {
    if (!contact) return null;
    return db.get(`SELECT * FROM leads WHERE (contact_id = ? OR brand_id = ?) ORDER BY CASE WHEN stage IN ('won','lost') THEN 1 ELSE 0 END, updated_at DESC LIMIT 1`, contact.id, contact.brand_id || -1);
  }
  function thread(channel, rawAddress, { name = null, lead_id = null, brand_id = null, contact_id = null, demo = 0 } = {}) {
    const address = channel === 'email' ? String(rawAddress || '').trim().toLowerCase() : normalizePhone(rawAddress);
    if (!address) return null;
    let t = db.get('SELECT * FROM conv_threads WHERE channel = ? AND address = ?', channel, address);
    if (!t) {
      const c = contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', contact_id) : matchContact(channel, address);
      const l = lead_id ? db.get('SELECT * FROM leads WHERE id = ?', lead_id) : leadFor(c);
      const id = Number(db.run(
        'INSERT INTO conv_threads (channel, address, name, lead_id, brand_id, contact_id, assigned_to, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        channel, address, name || (c && c.name) || null, l ? l.id : null, brand_id || (c && c.brand_id) || (l && l.brand_id) || null, c ? c.id : null, l ? l.owner_id : null, demo ? 1 : 0, nowIso(),
      ).lastInsertRowid);
      t = db.get('SELECT * FROM conv_threads WHERE id = ?', id);
    } else if (lead_id && !t.lead_id) {
      db.run('UPDATE conv_threads SET lead_id = ? WHERE id = ?', lead_id, t.id);
      t.lead_id = lead_id;
    }
    return t;
  }
  function addMessage(t, m) {
    const at = m.at || nowIso();
    const id = Number(db.run(
      'INSERT INTO conv_messages (thread_id, direction, kind, subject, body, template, status, provider_id, error, user_id, outbox_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      t.id, m.direction, m.kind || 'text', m.subject || null, m.body || null, m.template || null, m.status || (m.direction === 'in' ? 'received' : 'sent'),
      m.provider_id || null, m.error || null, m.user_id || null, m.outbox_id || null, m.demo ? 1 : 0, at,
    ).lastInsertRowid);
    const preview = String(m.subject && m.kind === 'email' ? `${m.subject} — ${m.body || ''}` : m.body || m.template || '').replace(/\s+/g, ' ').slice(0, 140);
    db.run(`UPDATE conv_threads SET last_at = ?, last_preview = ?, status = 'open'${m.direction === 'in' ? ', unread = unread + 1, last_in_at = ?' : ''} WHERE id = ?`,
      ...(m.direction === 'in' ? [at, preview, at, t.id] : [at, preview, t.id]));
    return db.get('SELECT * FROM conv_messages WHERE id = ?', id);
  }
  const inWindow = (t) => !!t.last_in_at && Date.now() - Date.parse(t.last_in_at) < 24 * 3600 * 1000;
  const templates = () => {
    try {
      const list = JSON.parse(db.setting('wa_templates') || '[]');
      return Array.isArray(list) ? list.filter((x) => x && x.name) : [];
    } catch {
      return [];
    }
  };

  // Sends on WhatsApp. Returns { ok, mode: 'api' | 'manual', link, message, error }.
  async function sendWhatsApp(t, { text = '', template: tpl = null, params = [], user = null, demo = 0 } = {}) {
    if (!wa.configured()) {
      const message = addMessage(t, { direction: 'out', kind: 'text', body: text, status: 'manual', user_id: user ? user.id : null, demo });
      return { ok: true, mode: 'manual', link: waLink(t.address, text), message };
    }
    let r;
    let message;
    if (tpl) {
      r = await wa.sendTemplate(t.address, tpl.name, tpl.lang, params);
      message = addMessage(t, { direction: 'out', kind: 'template', template: tpl.name, body: fillTemplate(tpl.body, params), status: r.ok ? 'sent' : 'failed', provider_id: r.id, error: r.ok ? null : r.error, user_id: user ? user.id : null, demo });
    } else {
      if (!inWindow(t)) return { ok: false, mode: 'api', error: 'window' };
      r = await wa.sendText(t.address, text);
      message = addMessage(t, { direction: 'out', kind: 'text', body: text, status: r.ok ? 'sent' : 'failed', provider_id: r.id, error: r.ok ? null : r.error, user_id: user ? user.id : null, demo });
    }
    return { ok: r.ok, mode: 'api', message, error: r.error };
  }
  const fillTemplate = (body, params) => String(body || '').replace(/\{\{(\d+)\}\}/g, (m, n) => (params[Number(n) - 1] !== undefined ? params[Number(n) - 1] : m));

  // Sends an email inside a thread; the message follows the outbox status.
  function sendEmail(t, { subject, html, text, user = null, attachments, related, demo = 0, lang }) {
    const out = mail.send({ to: t.address, subject, html, text, attachments, related, thread_id: t.id, user_id: user ? user.id : null, demo, lang });
    const message = addMessage(t, { direction: 'out', kind: 'email', subject, body: text || '', status: out.status === 'not_configured' ? 'not_configured' : 'queued', outbox_id: out.id, user_id: user ? user.id : null, demo });
    out.done.then((r) => {
      if (r) db.run('UPDATE conv_messages SET status = ?, error = ? WHERE id = ?', r.status === 'sent' ? 'sent' : r.status, r.error || null, message.id);
    }).catch(() => {});
    return { out, message };
  }
  h.conversations = { thread, addMessage, sendWhatsApp, sendEmail, inWindow };

  // ---------- emails ----------
  const emailText = (lines) => lines.filter(Boolean).join('\n\n');
  function offerEmail(o, { lang, link, note, contactName, expires }) {
    return i18n.run(lang, () => {
      const units = M.offerUnits(db, o.id);
      const sc = M.schedule({ rent_m2: o.rent_m2, terrace_rent_m2: o.terrace_rent_m2, service_m2: o.service_m2, term_years: o.term_years, escalation_pct: o.escalation_pct, rent_free_months: o.rent_free_months, deposit_months: o.deposit_months, key_money: o.key_money }, units);
      const greet = contactName ? tr('com|Dear {name},', { name: contactName }) : tr('com|Hello,');
      const intro = `${escH(greet)}<br><br>${note ? `${escH(note).replace(/\n/g, '<br>')}<br><br>` : ''}${escH(tr('com|Please find our leasing proposal for {brand} at The Wave below. You can review the full proposal and accept it online in a few minutes.', { brand: o.brand_name || o.lead_title }))}`;
      const body = facts([
        [tr('Units'), escH(units.map((u) => u.code).join(', '))],
        [tr('Area'), escH(ui.m2(sc.indoor) + (sc.outdoor ? ` + ${tr('plan|{a} + {b} terrace', { a: '', b: ui.m2(sc.outdoor) }).replace(/^\s*\+\s*/, '')}` : ''))],
        [tr('com|Rent per m² per month'), escH(ui.money(o.rent_m2))],
        [tr('Term'), escH(tr('{years}, +{pct}% yearly', { years: tn(o.term_years, '{n} year', '{n} years'), pct: o.escalation_pct }))],
        [tr('Contract value'), escH(ui.money(sc.total))],
        [tr('Valid until'), escH(ui.date(o.valid_until))],
      ], { lang }) + `<p style="margin:16px 0 0;font-size:12px;color:#56625d;">${escH(tr('com|This link is personal to you and works until {date}.', { date: ui.date(expires.slice(0, 10)) }))}</p>`;
      const subject = tr('com|Leasing proposal {ref} · The Wave', { ref: o.ref });
      const html = template({ lang, preheader: tr('com|Review and sign your proposal online'), eyebrow: tr('Leasing proposal'), title: tr('com|Your proposal for {brand}', { brand: o.brand_name || o.lead_title }), intro, body, button: { label: tr('com|Review and sign'), url: link }, site: env.SITE_URL || '' });
      const text = emailText([greet, note, tr('com|Please find our leasing proposal for {brand} at The Wave below. You can review the full proposal and accept it online in a few minutes.', { brand: o.brand_name || o.lead_title }), `${tr('com|Review and sign')}: ${link}`, tr('com|This link is personal to you and works until {date}.', { date: ui.date(expires.slice(0, 10)) })]);
      return { subject, html, text };
    });
  }
  function noticeEmail(lang, { title, intro, rows, button, eyebrow }) {
    return i18n.run(lang, () => {
      const t = typeof title === 'function' ? title() : title;
      const i = typeof intro === 'function' ? intro() : intro;
      const r = typeof rows === 'function' ? rows() : rows || [];
      const b = typeof button === 'function' ? button() : button;
      const e = typeof eyebrow === 'function' ? eyebrow() : eyebrow;
      return { subject: t, html: template({ lang, eyebrow: e, title: t, intro: escH(i), body: r.length ? facts(r.map(([k, v]) => [k, escH(v)]), { lang }) : '', button: b, site: env.SITE_URL || '' }), text: emailText([t, i, ...r.map(([k, v]) => `${k}: ${v}`), b ? `${b.label}: ${b.url}` : '']) };
    });
  }
  function notify(users, kind, build) {
    const seen = new Set();
    for (const u of users) {
      if (!u || !u.email || !u.active || seen.has(u.id)) continue;
      seen.add(u.id);
      if (!prefs(u.id)[kind]) continue;
      const m = build(userLang(u), u);
      mail.send({ to: u.email, subject: m.subject, html: m.html, text: m.text, lang: userLang(u), user_id: null, related: m.related });
    }
  }

  // ---------- offer signing ----------
  const signingOf = (token) => db.get('SELECT * FROM offer_signing WHERE token_hash = ?', sha(String(token || '')));
  function newSigning(o, { user = null, sentTo = null, via = 'link', lang = 'en', demo = 0 } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const end = o.valid_until && o.valid_until >= M.today() ? `${o.valid_until}T21:59:59.000Z` : new Date(Date.now() + 21 * 86400000).toISOString();
    db.run(
      'INSERT INTO offer_signing (offer_id, token_hash, nonce, lang, sent_to, via, created_by, created_at, expires_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      o.id, sha(token), crypto.randomBytes(18).toString('base64url'), lang === 'ar' ? 'ar' : 'en', sentTo, via, user ? user.id : null, nowIso(), end, demo ? 1 : 0,
    );
    return { token, expires: end };
  }
  const canShare = (o) => ['draft', 'approved', 'sent'].includes(o.status);
  // sending or sharing an offer counts as sending it
  const ensureSent = (o, req) => {
    if (['draft', 'approved'].includes(o.status)) h.offers.markSent(o, req);
    return h.offers.of(o.id);
  };
  const leadContacts = (o) => db.all('SELECT * FROM contacts WHERE brand_id = ? ORDER BY primary_contact DESC, id', o.brand_id || -1);

  // the card on the offer page
  h.offerPanels = h.offerPanels || [];
  h.offerPanels.push((req, o) => {
    const rows = db.all('SELECT s.*, u.name user_name FROM offer_signing s LEFT JOIN users u ON u.id = s.created_by WHERE s.offer_id = ? ORDER BY s.id DESC', o.id);
    const signed = rows.find((r) => r.status === 'signed');
    const declined = rows.find((r) => r.status === 'declined');
    const views = rows.reduce((a, r) => a + r.views, 0);
    const last = rows.map((r) => r.last_viewed_at).filter(Boolean).sort().pop();
    const csrf = req.session.csrf;
    const contacts = leadContacts(o);
    const primary = contacts.find((c) => c.email) || {};
    const phoneContact = contacts.find((c) => c.whatsapp || c.phone);
    let status = '';
    if (signed) {
      status = `<div class="esign esign--ok">${ui.icon('check')}<div><b>${ui.esc(tr('com|Signed online by {name}', { name: signed.signer_name }))}</b><small>${ui.dt(signed.signed_at)}${signed.signer_title ? ` · ${ui.esc(tx(signed.signer_title))}` : ''}</small><p class="row">${ui.btn(tr('com|Signed record'), { href: `/admin/offers/${o.id}/signed/${signed.id}?doc=${signed.lang}`, cls: 'btn--ghost btn--xs', attrs: { target: '_blank' } })}${signed.document_id ? ui.btn(tr('com|Certificate'), { href: `/admin/documents/${signed.document_id}/file`, cls: 'btn--ghost btn--xs', attrs: { target: '_blank' } }) : ''}</p></div></div>`;
    } else if (declined) {
      status = `<div class="esign esign--no">${ui.icon('log')}<div><b>${ui.esc(tr('com|Declined online'))}</b><small>${ui.dt(declined.decided_at)}</small>${declined.decline_reason ? `<p class="quote quote--sm">${ui.esc(declined.decline_reason)}</p>` : ''}</div></div>`;
    } else if (rows.length) {
      status = `<div class="esign">${ui.icon('mail')}<div><b>${ui.esc(views ? tn(views, 'com|Viewed {n} time', 'com|Viewed {n} times') : tr('com|Not opened yet'))}</b><small>${ui.esc(last ? tr('com|Last opened {when}', { when: ui.rel(last) }) : tr('com|Sent {when}', { when: ui.rel(rows[0].created_at) }))}</small></div></div>`;
    }
    const linkRows = rows.length
      ? `<ul class="list esign__links">${rows.slice(0, 6).map((r) => `<li><span class="what"><b>${ui.esc(r.sent_to || tr('com|Shared link'))}</b><small>${ui.esc(tr('com|{via} · {when} · {views}', { via: r.via === 'email' ? tr('Email') : r.via === 'whatsapp' ? tr('WhatsApp') : tr('com|Link'), when: ui.rel(r.created_at), views: tn(r.views, 'com|{n} view', 'com|{n} views') }))}</small></span>${ui.badge(r.status, { open: Date.parse(r.expires_at) < Date.now() ? tr('com|Expired') : tr('com|Open'), signed: tr('com|Signed'), declined: tr('com|Declined'), revoked: tr('com|Revoked') }[r.status], r.status === 'signed' ? 'ok' : r.status === 'declined' ? 'rose' : r.status === 'revoked' || Date.parse(r.expires_at) < Date.now() ? 'mute' : 'sky')}${r.status === 'open' && h.can(req, 'agent') ? ui.form(`/admin/offers/${o.id}/signing/${r.id}/revoke`, csrf, `<button class="iconbtn" title="${ui.esc(tr('com|Revoke link'))}" aria-label="${ui.esc(tr('com|Revoke link'))}" data-confirm="${ui.esc(tr('com|Revoke this link? It will stop working at once.'))}">×</button>`) : ''}</li>`).join('')}</ul>`
      : '';
    let forms = '';
    if (canShare(o) && h.can(req, 'agent') && !signed) {
      const langSel = ui.select('lang', tr('com|Language of the proposal'), [['en', 'English'], ['ar', 'العربية']], req.lang === 'ar' ? 'ar' : 'en');
      forms = `<details class="pop pop--inline esign__send"${rows.length ? '' : ' open'}><summary class="btn btn--primary btn--sm btn--block">${ui.icon('mail')}<span>${ui.esc(tr('com|Email for signature'))}</span></summary>${ui.form(`/admin/offers/${o.id}/send-email`, csrf, `
        ${ui.input('to', tr('com|To'), primary.email || '', { type: 'email', required: true, attrs: { multiple: true, list: `ct-${o.id}` } })}
        <datalist id="ct-${o.id}">${contacts.filter((c) => c.email).map((c) => `<option value="${ui.esc(c.email)}">${ui.esc(c.name)}</option>`).join('')}</datalist>
        ${ui.input('cc', tr('com|Copy to'), '', { type: 'email', attrs: { multiple: true } })}
        ${langSel}
        ${ui.textarea('note', tr('com|Personal note'), '', { rows: 3, placeholder: tr('com|Optional: a line from you above the proposal') })}
        ${ui.btn(tr('com|Send'), { cls: 'btn--primary btn--sm', ic: 'arrow' })}`, { cls: 'stack' })}</details>
      <div class="row esign__more">
        ${phoneContact ? ui.form(`/admin/offers/${o.id}/send-whatsapp`, csrf, `<input type="hidden" name="lang" value="${req.lang === 'ar' ? 'ar' : 'en'}">${ui.btn(tr('com|Send on WhatsApp'), { cls: 'btn--ghost btn--sm', ic: 'chat' })}`, { attrs: wa.configured() ? {} : { target: '_blank', 'data-wa': '' } }) : ''}
        ${ui.form(`/admin/offers/${o.id}/link`, csrf, `<input type="hidden" name="lang" value="${req.lang === 'ar' ? 'ar' : 'en'}">${ui.btn(tr('com|Signing link'), { cls: 'btn--ghost btn--sm', ic: 'plug' })}`)}
      </div>`;
    } else if (o.status === 'pending') {
      forms = `<p class="muted small">${ui.esc(tr('com|It can be sent for signature once a manager approves it.'))}</p>`;
    }
    if (!status && !forms && !linkRows) return '';
    return ui.card(tr('com|Online signature'), `${status}${forms}${linkRows}`, { cls: 'esign-card', sub: ui.esc(tr('com|The brand reviews the proposal and signs it on any device.')) });
  });

  router.post('/offers/:id/send-email', R('agent'), (req, res, next) => {
    let o = h.offers.of(h.int(req.params.id));
    if (!o) return next();
    const back = `/admin/offers/${o.id}`;
    if (!canShare(o)) return h.back(req, res, back, 'error', tr('com|This offer cannot be sent now.'));
    const split = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const to = split(req.body.to);
    const cc = split(req.body.cc);
    if (!to.length || [...to, ...cc].some((e) => !EMAIL_RE.test(e)) || to.length + cc.length > 10) return h.back(req, res, back, 'error', tr('com|Enter valid email addresses.'));
    const lang = req.body.lang === 'ar' ? 'ar' : 'en';
    o = ensureSent(o, req);
    const { token, expires } = newSigning(o, { user: req.user, sentTo: to.join(', '), via: 'email', lang });
    const link = `${site(req)}/sign/${token}`;
    const contact = db.get('SELECT * FROM contacts WHERE email = ? COLLATE NOCASE AND brand_id IS ?', to[0], o.brand_id) || {};
    const m = offerEmail(o, { lang, link, note: h.str(req.body.note, 1500), contactName: contact.name, expires });
    const t = thread('email', to[0], { name: contact.name, lead_id: o.lead_id, brand_id: o.brand_id });
    const { out } = sendEmail(t, { subject: m.subject, html: m.html, text: m.text, user: req.user, related: { entity: 'offer', id: o.id }, lang });
    if (cc.length) db.run('UPDATE outbox SET cc = ? WHERE id = ?', cc.join(', '), out.id);
    for (const extra of to.slice(1)) mail.send({ to: extra, cc: null, subject: m.subject, html: m.html, text: m.text, related: { entity: 'offer', id: o.id }, user_id: req.user.id, lang });
    db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, done_at, created_at) VALUES (?, ?, ?, 'email', ?, ?, ?)", o.lead_id, o.brand_id, req.user.id, `Offer ${o.ref} emailed for signature to ${to.join(', ')}`, M.now(), M.now());
    h.log(req, 'Emailed an offer for signature', 'offer', o.id, `${o.ref} · ${to.join(', ')}`);
    h.back(req, res, back, out.status === 'not_configured' ? 'error' : 'ok', out.status === 'not_configured'
      ? tr('com|Saved in the outbox, but email is not set up yet. Use Signing link or WhatsApp meanwhile.')
      : tr('com|Sent to {to}. You will be told when it is signed.', { to: to.join(', ') }));
  });

  router.post('/offers/:id/send-whatsapp', R('agent'), async (req, res, next) => {
    let o = h.offers.of(h.int(req.params.id));
    if (!o) return next();
    const back = `/admin/offers/${o.id}`;
    if (!canShare(o)) return h.back(req, res, back, 'error', tr('com|This offer cannot be sent now.'));
    const c = leadContacts(o).find((x) => normalizePhone(x.whatsapp || x.phone));
    if (!c) return h.back(req, res, back, 'error', tr('com|Add a mobile number to the brand’s contact first.'));
    const lang = req.body.lang === 'ar' ? 'ar' : 'en';
    o = ensureSent(o, req);
    const phone = c.whatsapp || c.phone;
    const { token } = newSigning(o, { user: req.user, sentTo: pretty(phone), via: 'whatsapp', lang });
    const link = `${site(req)}/sign/${token}`;
    const text = i18n.run(lang, () => tr('com|Hello {name}, here is The Wave’s leasing proposal {ref} for {brand}. You can review and sign it here: {link}', { name: (c.name || '').split(' ')[0], ref: o.ref, brand: o.brand_name || o.lead_title, link }));
    const t = thread('whatsapp', phone, { name: c.name, lead_id: o.lead_id, brand_id: o.brand_id, contact_id: c.id });
    let r;
    if (wa.configured() && !inWindow(t)) {
      const tpl = templates().find((x) => ['offer', 'عرض'].includes(x.use)) || templates()[0];
      if (!tpl) return h.back(req, res, back, 'error', tr('com|WhatsApp needs an approved template to start a conversation. Add one in Integrations.'));
      r = await sendWhatsApp(t, { template: tpl, params: [(c.name || '').split(' ')[0], o.ref, link], user: req.user });
    } else {
      r = await sendWhatsApp(t, { text, user: req.user });
    }
    db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, done_at, created_at) VALUES (?, ?, ?, 'whatsapp', ?, ?, ?)", o.lead_id, o.brand_id, req.user.id, `Offer ${o.ref} sent on WhatsApp for signature`, M.now(), M.now());
    h.log(req, 'Sent an offer on WhatsApp', 'offer', o.id, o.ref);
    if (r.mode === 'manual') return res.redirect(303, r.link);
    h.back(req, res, back, r.ok ? 'ok' : 'error', r.ok ? tr('com|Sent on WhatsApp.') : tr('com|WhatsApp did not accept it: {error}', { error: r.error }));
  });

  router.post('/offers/:id/link', R('agent'), (req, res, next) => {
    let o = h.offers.of(h.int(req.params.id));
    if (!o) return next();
    if (!canShare(o)) return h.back(req, res, `/admin/offers/${o.id}`, 'error', tr('com|This offer cannot be sent now.'));
    const lang = req.body.lang === 'ar' ? 'ar' : 'en';
    o = ensureSent(o, req);
    const { token, expires } = newSigning(o, { user: req.user, via: 'link', lang });
    const link = `${site(req)}/sign/${token}`;
    h.log(req, 'Created a signing link', 'offer', o.id, o.ref);
    h.page(req, res, {
      title: tr('com|Signing link'), crumbs: [['/admin/offers', tr('Offers')], [`/admin/offers/${o.id}`, o.ref], [null, tr('com|Signing link')]], active: '/admin/offers',
      body: `<div class="grid grid--2">${ui.card(tr('com|Signing link'), `<p class="muted">${ui.esc(tr('com|Share this link with {brand} only. It opens the proposal and lets them sign it. It works until {date} and is shown only once.', { brand: o.brand_name || o.lead_title, date: ui.date(expires.slice(0, 10)) }))}</p>
        <div class="copyfield"><input type="text" readonly value="${ui.esc(link)}" data-copy-src><button type="button" class="btn btn--primary btn--sm" data-copy>${ui.esc(tr('com|Copy'))}</button></div>
        <p class="row">${ui.btn(tr('com|Open it'), { href: link, cls: 'btn--ghost btn--sm', attrs: { target: '_blank' } })}${ui.btn(tr('Back'), { href: `/admin/offers/${o.id}`, cls: 'btn--ghost btn--sm' })}</p>`)}</div>`,
    });
  });

  router.post('/offers/:id/signing/:sid/revoke', R('agent'), (req, res) => {
    db.run("UPDATE offer_signing SET status = 'revoked', decided_at = ? WHERE id = ? AND offer_id = ? AND status = 'open'", nowIso(), h.int(req.params.sid), h.int(req.params.id));
    h.log(req, 'Revoked a signing link', 'offer', h.int(req.params.id));
    h.back(req, res, `/admin/offers/${h.int(req.params.id)}`, 'ok', tr('com|Link revoked.'));
  });

  // the exact proposal as signed, with its certificate
  router.get('/offers/:id/signed/:sid', (req, res, next) => {
    const s = db.get("SELECT * FROM offer_signing WHERE id = ? AND offer_id = ? AND status = 'signed'", h.int(req.params.sid), h.int(req.params.id));
    if (!s || !s.snapshot) return next();
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'");
    res.type('html').send(s.snapshot);
  });

  // ---------- the public signing pages ----------
  const pub = h.public;
  const signLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: true, legacyHeaders: false });
  const postLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const pageLang = (req, s) => (['en', 'ar'].includes(req.query.lang) ? req.query.lang : ['en', 'ar'].includes(req.body && req.body.lang) ? req.body.lang : (s && s.lang) || 'en');
  const pubPage = (res, status, title, body) => res.status(status).set({ 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }).type('html').send(outsider(ui.bare({ title, body, cls: 'print signpage' })));
  const shell = (inner, { token, lang }) => `<div class="signshell"><header class="signbar">${ui.logo('signbar__logo')}<span class="signbar__t">${ui.esc(tr('com|Leasing proposal'))}</span>${token ? `<a class="langbtn" href="/sign/${ui.esc(token)}?lang=${lang === 'ar' ? 'en' : 'ar'}" lang="${lang === 'ar' ? 'en' : 'ar'}">${ui.icon('globe')}<span>${lang === 'ar' ? 'English' : 'العربية'}</span></a>` : ''}</header>${inner}</div>`;
  const notice = (icon, title, text, extra = '') => `<main class="signnote">${ui.icon(icon)}<h1>${ui.esc(title)}</h1><p>${ui.esc(text)}</p>${extra}</main>`;

  // what a link can do now: 'ok' or why not
  function linkState(s) {
    if (!s) return 'missing';
    if (s.status === 'signed') return 'signed';
    if (s.status === 'declined') return 'declined';
    if (s.status === 'revoked') return 'revoked';
    if (Date.parse(s.expires_at) < Date.now()) return 'expired';
    const o = h.offers.of(s.offer_id);
    if (!o) return 'missing';
    if (o.status === 'accepted') return 'accepted';
    if (o.status !== 'sent') return 'closed';
    return 'ok';
  }
  function statePage(res, state, s, lang, token) {
    return i18n.run(lang, () => {
      const o = s ? h.offers.of(s.offer_id) : null;
      const map = {
        missing: ['log', tr('com|This link does not work'), tr('com|Please check the link, or ask your contact at The Wave for a new one.')],
        expired: ['log', tr('com|This link has expired'), tr('com|Proposals are valid for a limited time. Ask your contact at The Wave for a new link.')],
        revoked: ['log', tr('com|This link was withdrawn'), tr('com|A newer version of the proposal may be on its way. Ask your contact at The Wave.')],
        closed: ['log', tr('com|This proposal is no longer open'), tr('com|It has been replaced or closed. Your contact at The Wave can tell you more.')],
        accepted: ['check', tr('com|This proposal has been accepted'), tr('com|Thank you. The leasing team will be in touch about the next steps.')],
        signed: ['check', tr('com|Signed. Thank you.'), s ? tr('com|{name} accepted proposal {ref} on {date}. The leasing team will be in touch about the lease.', { name: s.signer_name || '', ref: o ? o.ref : '', date: ui.dt(s.signed_at || '') }) : ''],
        declined: ['log', tr('com|You declined this proposal'), tr('com|Thank you for letting us know. Your contact at The Wave may follow up with you.')],
      };
      const [icon, title, text] = map[state] || map.missing;
      const extra = state === 'signed' && s ? `<dl class="signnote__dl"><div><dt>${ui.esc(tr('com|Document fingerprint'))}</dt><dd><code>${ui.esc(s.doc_hash || '')}</code></dd></div></dl>` : '';
      return pubPage(res, state === 'missing' ? 404 : state === 'signed' || state === 'accepted' ? 200 : 410, title, shell(notice(icon, title, text, extra), { token: state === 'missing' ? null : token, lang }));
    });
  }
  const docHash = (o, lang) => i18n.run(lang, () => sha(h.offers.proposal(o)));

  pub.get('/sign/:token', signLimit, (req, res) => {
    const s = signingOf(req.params.token);
    const lang = pageLang(req, s);
    const state = linkState(s);
    if (state !== 'ok') return statePage(res, state, s, lang, req.params.token);
    const t = nowIso();
    db.run('UPDATE offer_signing SET views = views + 1, first_viewed_at = COALESCE(first_viewed_at, ?), last_viewed_at = ? WHERE id = ?', t, t, s.id);
    const o = h.offers.of(s.offer_id);
    const html = i18n.run(lang, () => {
      const doc = h.offers.proposal(o);
      const tok = ui.esc(req.params.token);
      const panel = `<section class="signpanel" id="sign" aria-labelledby="sign-h">
  <p class="eyebrow">${ui.esc(tr('com|Step 2 of 2'))}</p>
  <h2 id="sign-h">${ui.esc(tr('com|Accept and sign'))}</h2>
  <p class="muted">${ui.esc(tr('com|Signing accepts this proposal for {brand}. The lease itself follows, prepared by the leasing team.', { brand: o.brand_name || o.lead_title }))}</p>
  <form method="post" action="/sign/${tok}" class="stack" data-sign novalidate data-msg-name="${ui.esc(tr('com|Enter your full name.'))}" data-msg-email="${ui.esc(tr('com|Enter a valid email address, or leave it empty.'))}" data-msg-sig="${ui.esc(tr('com|Please sign in the box (or type your name) before accepting.'))}" data-msg-consent="${ui.esc(tr('com|Please confirm that you are authorised to accept this proposal.'))}">
    <input type="hidden" name="nonce" value="${ui.esc(s.nonce)}"><input type="hidden" name="doc_hash" value="${ui.esc(sha(doc))}"><input type="hidden" name="lang" value="${lang}">
    <input type="hidden" name="signature" data-sig-out><input type="hidden" name="signature_kind" value="drawn" data-sig-kind>
    <div class="fields">
      ${ui.input('name', tr('com|Full name'), '', { required: true, attrs: { autocomplete: 'name', maxlength: 120 } })}
      ${ui.input('title', tr('Job title'), '', { attrs: { autocomplete: 'organization-title', maxlength: 120 } })}
      ${ui.input('email', tr('Email'), '', { type: 'email', attrs: { autocomplete: 'email', maxlength: 160 }, hint: tr('com|We send you a copy.') })}
    </div>
    <div class="sigtabs" role="tablist"><button type="button" class="is-on" data-sig-tab="drawn" role="tab" aria-selected="true">${ui.esc(tr('com|Draw'))}</button><button type="button" data-sig-tab="typed" role="tab" aria-selected="false">${ui.esc(tr('com|Type'))}</button></div>
    <div class="sigpad" data-sig-pane="drawn"><canvas data-sigpad aria-label="${ui.esc(tr('com|Sign here'))}"></canvas><span class="sigpad__hint">${ui.esc(tr('com|Sign here with your finger or mouse'))}</span><button type="button" class="btn btn--ghost btn--xs sigpad__clear" data-sig-clear>${ui.esc(tr('com|Clear'))}</button></div>
    <div class="sigtype" data-sig-pane="typed" hidden><input type="text" maxlength="60" data-sig-type aria-label="${ui.esc(tr('com|Type your name'))}" placeholder="${ui.esc(tr('com|Type your name'))}"><div class="sigtype__preview" data-sig-preview lang="${lang}"></div></div>
    <label class="check"><input type="checkbox" name="consent" value="1" required> ${ui.esc(tr('com|I am authorised to accept this proposal on behalf of {brand}, and I agree that my electronic signature counts as my signature.', { brand: o.brand_name || o.lead_title }))}</label>
    <p class="alert alert--error" data-sign-err hidden></p>
    <button class="btn btn--primary btn--block signpanel__go" type="submit">${ui.icon('check')}<span>${ui.esc(tr('com|Accept and sign'))}</span></button>
    <p class="muted small">${ui.esc(tr('com|We record your name, the time, your IP address and a fingerprint of this exact proposal with your signature.'))}</p>
  </form>
  <details class="signdecline"><summary>${ui.esc(tr('com|Decline this proposal'))}</summary>
    <form method="post" action="/sign/${tok}/decline" class="stack"><input type="hidden" name="nonce" value="${ui.esc(s.nonce)}"><input type="hidden" name="lang" value="${lang}">
      ${ui.textarea('reason', tr('com|Tell us why (optional)'), '', { rows: 3 })}
      <button class="btn btn--ghost btn--sm" type="submit">${ui.esc(tr('com|Decline'))}</button></form>
  </details>
</section>
<a class="signjump" href="#sign">${ui.icon('arrow')}<span>${ui.esc(tr('com|Review, then sign'))}</span></a>`;
      const intro = `<div class="signintro"><p class="eyebrow">${ui.esc(tr('com|Step 1 of 2'))}</p><h1>${ui.esc(tr('com|Your proposal for {brand}', { brand: o.brand_name || o.lead_title }))}</h1><p>${ui.esc(tr('com|Read it through, then accept and sign at the end. It takes about two minutes.'))}</p></div>`;
      return outsider(ui.bare({ title: tr('Proposal {ref}', { ref: o.ref }), body: shell(`${intro}${doc}${panel}`, { token: req.params.token, lang }) + '<script src="/admin/sign.js" defer></script>', cls: 'print signpage' }));
    });
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }).type('html').send(html);
  });

  const formNonceOk = (s, n) => {
    const a = Buffer.from(String(s.nonce));
    const b = Buffer.from(String(n || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const signBody = express.urlencoded({ extended: false, limit: '700kb' });

  pub.post('/sign/:token', postLimit, signBody, (req, res) => {
    const s = signingOf(req.params.token);
    const lang = pageLang(req, s);
    const state = linkState(s);
    if (state !== 'ok') return statePage(res, state, s, lang, req.params.token);
    const fail = (msg) => i18n.run(lang, () => pubPage(res, 422, tr('com|Please check the form'), shell(notice('log', tr('com|Please check the form'), tr(msg), `<p><a class="btn btn--primary" href="/sign/${ui.esc(req.params.token)}?lang=${lang}">${ui.esc(tr('com|Back to the proposal'))}</a></p>`), { token: req.params.token, lang })));
    if (!formNonceOk(s, req.body.nonce)) return fail('com|This page has expired. Open the link again and sign.');
    const o = h.offers.of(s.offer_id);
    if (docHash(o, lang) !== String(req.body.doc_hash || '')) return fail('com|The proposal changed while you were reading it. Open the link again to see the latest version.');
    const name = h.str(req.body.name, 120);
    const title = h.str(req.body.title, 120);
    const email = h.str(req.body.email, 160);
    if (name.length < 2) return fail('com|Enter your full name.');
    if (email && !EMAIL_RE.test(email)) return fail('com|Enter a valid email address, or leave it empty.');
    if (!req.body.consent) return fail('com|Please confirm that you are authorised to accept this proposal.');
    const sig = readSignature(req.body.signature);
    if (!sig) return fail('com|Please sign in the box (or type your name) before accepting.');
    const kind = req.body.signature_kind === 'typed' ? 'typed' : 'drawn';
    const at = nowIso();
    const ua = String(req.get('user-agent') || '').slice(0, 300);
    const pseudo = { user: { id: null, name: name }, ip: req.ip };
    let ok = false;
    db.tx(() => {
      ok = h.offers.accept(o, pseudo);
      if (!ok) return;
      db.run("UPDATE offer_signing SET status = 'signed', signed_at = ?, decided_at = ?, signer_name = ?, signer_title = ?, signer_email = ?, signature = ?, signature_kind = ?, ip = ?, user_agent = ?, doc_hash = ? WHERE id = ?",
        at, at, name, title || null, email || null, sig.dataUrl, kind, req.ip || null, ua, String(req.body.doc_hash), s.id);
      db.run("UPDATE offer_signing SET status = 'revoked', decided_at = ? WHERE offer_id = ? AND id != ? AND status = 'open'", at, o.id, s.id);
      db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, body, done_at, created_at) VALUES (?, ?, NULL, 'note', ?, ?, ?, ?)",
        o.lead_id, o.brand_id, `Offer ${o.ref} signed online by ${name}`, title ? `Title: ${title}` : null, at, at);
      db.audit(null, 'Offer signed online', 'offer', o.id, `${o.ref} · ${name}`, req.ip);
    });
    if (!ok) return statePage(res, linkState(signingOf(req.params.token)), s, lang, req.params.token);
    // the signed record: the proposal exactly as shown, with the certificate under it
    const fresh = db.get('SELECT * FROM offer_signing WHERE id = ?', s.id);
    const snapshot = signedRecord(o, fresh, lang);
    db.run('UPDATE offer_signing SET snapshot = ? WHERE id = ?', snapshot, s.id);
    const pdf = storeCertificate(o, fresh, sig);
    h.events.emit('offer.signed', { offer: h.offers.of(o.id), signing: db.get('SELECT * FROM offer_signing WHERE id = ?', s.id) });
    // tell the team, and send the signer a copy
    const owner = db.get('SELECT * FROM users WHERE id = (SELECT owner_id FROM leads WHERE id = ?)', o.lead_id);
    notify([owner, ...managers()], 'signed', (l) => ({ ...noticeEmail(l, {
      eyebrow: () => tr('com|Signed online'),
      title: () => tr('com|{brand} signed offer {ref}', { brand: o.brand_name || o.lead_title, ref: o.ref }),
      intro: () => tr('com|{name} accepted the proposal online. The units are reserved; the next step is the lease.', { name }),
      rows: () => [[tr('com|Signed by'), `${name}${title ? `, ${title}` : ''}`], [tr('Email'), email || '—'], [tr('com|Signed at'), ui.dt(at)]],
      button: () => ({ label: tr('com|Open the offer'), url: `${site(req)}/admin/offers/${o.id}` }),
    }), related: { entity: 'offer', id: o.id } }));
    if (email) {
      const m = noticeEmail(lang, {
        eyebrow: () => tr('Leasing proposal'),
        title: () => tr('com|Thank you, {name}', { name: name.split(' ')[0] }),
        intro: () => tr('com|You accepted proposal {ref} for {brand}. Your signature certificate is attached. The leasing team will be in touch about the lease.', { ref: o.ref, brand: o.brand_name || o.lead_title }),
        rows: () => [[tr('com|Signed at'), ui.dt(at)], [tr('com|Document fingerprint'), fresh.doc_hash.slice(0, 16)]],
      });
      mail.send({ to: email, subject: m.subject, html: m.html, text: m.text, lang, related: { entity: 'offer', id: o.id }, attachments: pdf ? [{ filename: `signature-${o.ref}.pdf`, content: pdf, contentType: 'application/pdf' }] : [] });
    }
    res.redirect(303, `/sign/${encodeURIComponent(req.params.token)}?lang=${lang}`);
  });

  pub.post('/sign/:token/decline', postLimit, signBody, (req, res) => {
    const s = signingOf(req.params.token);
    const lang = pageLang(req, s);
    const state = linkState(s);
    if (state !== 'ok' || !formNonceOk(s, req.body.nonce)) return statePage(res, state === 'ok' ? 'expired' : state, s, lang, req.params.token);
    const o = h.offers.of(s.offer_id);
    const reason = h.str(req.body.reason, 600);
    const at = nowIso();
    let ok = false;
    db.tx(() => {
      ok = h.offers.decline(o, { user: { id: null }, ip: req.ip });
      if (!ok) return;
      db.run("UPDATE offer_signing SET status = 'declined', decided_at = ?, decline_reason = ?, ip = ?, user_agent = ? WHERE id = ?", at, reason || null, req.ip || null, String(req.get('user-agent') || '').slice(0, 300), s.id);
      db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, body, done_at, created_at) VALUES (?, ?, NULL, 'note', ?, ?, ?, ?)", o.lead_id, o.brand_id, `Offer ${o.ref} declined online`, reason || null, at, at);
      db.audit(null, 'Offer declined online', 'offer', o.id, o.ref, req.ip);
    });
    if (ok) {
      h.events.emit('offer.declined', { offer: h.offers.of(o.id), reason });
      const owner = db.get('SELECT * FROM users WHERE id = (SELECT owner_id FROM leads WHERE id = ?)', o.lead_id);
      notify([owner, ...managers()], 'signed', (l) => ({ ...noticeEmail(l, {
        eyebrow: () => tr('com|Declined online'),
        title: () => tr('com|{brand} declined offer {ref}', { brand: o.brand_name || o.lead_title, ref: o.ref }),
        intro: () => (reason ? tr('com|Their reason: {reason}', { reason }) : tr('com|They did not give a reason.')),
        button: () => ({ label: tr('com|Open the offer'), url: `${site(req)}/admin/offers/${o.id}` }),
      }), related: { entity: 'offer', id: o.id } }));
    }
    res.redirect(303, `/sign/${encodeURIComponent(req.params.token)}?lang=${lang}`);
  });

  function certBlock(o, s) {
    return `<section class="doc__cert"><h2>${ui.esc(tr('com|Signed electronically'))}</h2>
      <div class="doc__certgrid"><dl>
        <div><dt>${ui.esc(tr('com|Signed by'))}</dt><dd>${ui.esc(s.signer_name)}${s.signer_title ? `, ${ui.esc(s.signer_title)}` : ''}</dd></div>
        ${s.signer_email ? `<div><dt>${ui.esc(tr('Email'))}</dt><dd>${ui.esc(s.signer_email)}</dd></div>` : ''}
        <div><dt>${ui.esc(tr('com|Signed at'))}</dt><dd>${ui.dt(s.signed_at)} · <bdi>${ui.esc(s.signed_at)}</bdi></dd></div>
        <div><dt>${ui.esc(tr('com|IP address'))}</dt><dd><bdi>${ui.esc(s.ip || '—')}</bdi></dd></div>
        <div><dt>${ui.esc(tr('com|Document fingerprint'))}</dt><dd><code>${ui.esc(s.doc_hash)}</code></dd></div>
      </dl><figure><img src="${s.signature}" alt="${ui.esc(tr('com|Signature'))}"><figcaption>${ui.esc(s.signature_kind === 'typed' ? tr('com|Typed signature') : tr('com|Drawn signature'))}</figcaption></figure></div></section>`;
  }
  function signedRecord(o, s, lang) {
    return i18n.run(lang, () => outsider(ui.bare({ title: tr('Proposal {ref}', { ref: o.ref }), body: h.offers.proposal(o, { after: certBlock(o, s) }), cls: 'print' }), { scripts: false }));
  }
  function storeCertificate(o, s, sig) {
    const brand = o.brand_id;
    const pdf = certificatePdf({
      title: 'Electronic signature certificate',
      lines: [
        ['Offer', `${o.ref}  ·  ${o.brand_name || o.lead_title}`], ['Signed by', s.signer_name], ['Title', s.signer_title || '-'], ['Email', s.signer_email || '-'],
        ['Signed at (UTC)', s.signed_at.replace('T', ' ').slice(0, 19)], ['IP address', s.ip || '-'], ['Device', (s.user_agent || '-').slice(0, 150)],
        ['Proposal language', s.lang === 'ar' ? 'Arabic' : 'English'], ['Fingerprint (SHA-256)', s.doc_hash], ['Method', `${s.signature_kind === 'typed' ? 'Typed' : 'Drawn'} signature with recorded consent`],
      ],
      sig,
    });
    if (!brand || !h.files) return pdf;
    const saved = h.files.save(pdf, `signature-${o.ref}.pdf`);
    if (saved.error) return pdf;
    const id = Number(db.run(
      `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, notes, uploaded_by, demo, created_at)
       VALUES (?, 'brand', ?, 'other', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      db.nextRef('documents', 'DOC', 4, true), brand, `Signed offer ${o.ref}`, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored, s.signed_at.slice(0, 10),
      `Signed online by ${s.signer_name}`, s.demo ? 1 : 0, nowIso(),
    ).lastInsertRowid);
    db.run('UPDATE offer_signing SET document_id = ? WHERE id = ?', id, s.id);
    return pdf;
  }
  h.signing = { newSigning, signingOf, readSignature, certificatePdf, signedRecord, storeCertificate };

  // ---------- WhatsApp webhook ----------
  pub.get('/webhooks/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && wa.verifyToken(req.query['hub.verify_token'])) return res.type('text').send(String(req.query['hub.challenge'] || ''));
    res.sendStatus(403);
  });
  pub.post('/webhooks/whatsapp', express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!wa.verifySignature(raw, req.get('x-hub-signature-256'))) return res.sendStatus(403);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    const { messages, statuses } = wa.parse(body);
    for (const m of messages) {
      if (!m.from) continue;
      if (m.id && db.value('SELECT COUNT(*) FROM conv_messages WHERE provider_id = ?', m.id)) continue; // Meta retries
      const t = thread('whatsapp', m.from, { name: m.name });
      if (m.name && !t.name) db.run('UPDATE conv_threads SET name = ? WHERE id = ?', m.name, t.id);
      addMessage(t, { direction: 'in', kind: 'text', body: m.text, provider_id: m.id, at: m.at });
      h.events.emit('conversation.received', { thread: db.get('SELECT * FROM conv_threads WHERE id = ?', t.id) });
    }
    for (const st of statuses) {
      const msg = db.get('SELECT * FROM conv_messages WHERE provider_id = ?', st.id);
      if (!msg) continue;
      if (st.status === 'failed') db.run("UPDATE conv_messages SET status = 'failed', error = ? WHERE id = ?", st.error || 'Failed', msg.id);
      else if ((ORDER[st.status] ?? -1) > (ORDER[msg.status] ?? -1)) db.run('UPDATE conv_messages SET status = ? WHERE id = ?', st.status, msg.id);
    }
    res.sendStatus(200);
  });

  // ---------- the conversations inbox ----------
  h.count('conversations', (user) => db.value('SELECT COUNT(*) FROM conv_threads WHERE unread > 0 AND status = ? AND (assigned_to IS NULL OR assigned_to = ?)', 'open', user.id));

  const channelBadge = (c) => (c === 'whatsapp' ? ui.badge('wa', tr('WhatsApp'), 'ok') : ui.badge('email', tr('Email'), 'sky'));
  const threadName = (t) => t.name || (t.channel === 'whatsapp' ? pretty(t.address) : t.address);
  const threadList = (rows, active, qs) => (rows.length
    ? `<ul class="convlist">${rows.map((t) => `<li class="${t.id === active ? 'is-on' : ''}${t.unread ? ' is-unread' : ''}"><a href="/admin/conversations?${qs}t=${t.id}"><span class="avatar avatar--sm${t.channel === 'whatsapp' ? ' avatar--wa' : ''}">${ui.esc(ui.initials(threadName(t)))}</span><span class="what"><b>${ui.esc(threadName(t))}</b><small>${ui.esc(tx(t.last_text) || '')}</small></span><span class="convlist__meta"><time>${t.last_at ? ui.esc(ui.rel(t.last_at)) : ''}</time>${t.unread ? `<b class="nav__count">${t.unread}</b>` : t.channel === 'whatsapp' ? ui.icon('chat') : ui.icon('mail')}</span></a></li>`).join('')}</ul>`
    : ui.empty(tr('com|No conversations here yet. WhatsApp messages and emails with brands appear in this inbox.')));

  function bubbles(t) {
    const msgs = db.all('SELECT m.*, u.name user_name FROM conv_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.thread_id = ? ORDER BY m.created_at, m.id', t.id);
    if (!msgs.length) return `<p class="muted pad">${ui.esc(tr('com|No messages yet.'))}</p>`;
    let day = '';
    return msgs.map((m) => {
      const d = ui.local(m.created_at).slice(0, 10);
      const sep = d !== day ? `<p class="bubday"><span>${ui.date(d)}</span></p>` : '';
      day = d;
      const meta = `${m.user_name && m.direction === 'out' ? `${ui.esc(m.user_name.split(' ')[0])} · ` : ''}${ui.esc(ui.local(m.created_at).slice(11, 16))}${m.direction === 'out' ? ` ${ticks(m.status)}` : ''}${['failed', 'not_configured', 'queued'].includes(m.status) ? ` · <span class="${m.status === 'failed' ? 'late' : ''}">${ui.esc(statusLabel()[m.status])}</span>` : ''}`;
      return `${sep}<div class="bub bub--${m.direction}${m.kind === 'email' ? ' bub--email' : ''}">${m.kind === 'email' && m.subject ? `<b class="bub__subj">${ui.esc(tx(m.subject))}</b>` : ''}${m.kind === 'template' ? `<small class="bub__tpl">${ui.esc(tr('com|Template: {name}', { name: m.template }))}</small>` : ''}<p>${ui.esc(tx(m.body) || '').replace(/\n/g, '<br>')}</p><small class="bub__meta" title="${ui.esc(tx(m.error) || '')}">${meta}</small></div>`;
    }).join('');
  }

  function snippetOptions(lang) {
    const list = db.all('SELECT * FROM snippets ORDER BY title');
    if (!list.length) return '';
    return `<select class="snippets" data-snippet aria-label="${ui.esc(tr('com|Quick replies'))}"><option value="">${ui.esc(tr('com|Quick replies'))}</option>${list.map((s) => `<option value="${ui.esc((lang === 'ar' ? s.body_ar || s.body_en : s.body_en || s.body_ar) || '')}">${ui.esc(tx(s.title))}</option>`).join('')}</select>`;
  }

  function composer(req, t) {
    const csrf = req.session.csrf;
    const lang = req.lang;
    if (t.channel === 'email') {
      const lastSubj = db.value("SELECT subject FROM conv_messages WHERE thread_id = ? AND subject IS NOT NULL ORDER BY id DESC LIMIT 1", t.id);
      return ui.form(`/admin/conversations/${t.id}/reply`, csrf, `${ui.input('subject', tr('com|Subject'), lastSubj ? (/^re:/i.test(lastSubj) ? lastSubj : `Re: ${lastSubj}`) : '', { required: true })}<div class="composer__row"><textarea name="body" rows="3" required placeholder="${ui.esc(tr('com|Write your email…'))}" data-composer></textarea></div><div class="row">${snippetOptions(lang)}${ui.btn(tr('com|Send email'), { cls: 'btn--primary btn--sm', ic: 'arrow' })}</div>`, { cls: 'composer stack' });
    }
    if (wa.configured() && !inWindow(t)) {
      const tpls = templates();
      if (!tpls.length) return `<p class="alert alert--warn">${ui.esc(tr('com|More than 24 hours since their last message: WhatsApp only allows approved templates now. Add your templates in Integrations.'))}</p>`;
      return ui.form(`/admin/conversations/${t.id}/reply`, csrf, `<p class="muted small">${ui.esc(tr('com|More than 24 hours since their last message: send an approved template to restart the conversation.'))}</p>${ui.select('template', tr('com|Template'), tpls.map((x) => [x.name, `${x.name} · ${x.lang}`]), tpls[0].name)}${ui.input('params', tr('com|Values for the template, separated by |'), '', { placeholder: tr('com|e.g. Nour | OF-2026-004') })}${ui.btn(tr('com|Send template'), { cls: 'btn--primary btn--sm', ic: 'arrow' })}`, { cls: 'composer stack' });
    }
    const manual = !wa.configured();
    return ui.form(`/admin/conversations/${t.id}/reply`, csrf, `<div class="composer__row"><textarea name="body" rows="2" required placeholder="${ui.esc(tr('com|Write a message…'))}" data-composer></textarea>${ui.btn(manual ? tr('com|Open in WhatsApp') : tr('com|Send'), { cls: 'btn--primary', ic: 'arrow' })}</div><div class="row">${snippetOptions(lang)}${manual ? `<small class="muted">${ui.esc(tr('com|WhatsApp Business is not connected: this opens WhatsApp on your device and logs the message here.'))}</small>` : ''}</div>`, { cls: 'composer stack', attrs: manual ? { target: '_blank', 'data-wa': '' } : {} });
  }

  router.get('/conversations', (req, res) => {
    const f = ['unread', 'mine', 'whatsapp', 'email', 'closed'].includes(req.query.f) ? req.query.f : 'all';
    const where = { all: "t.status = 'open'", unread: "t.unread > 0 AND t.status = 'open'", mine: "t.assigned_to = ? AND t.status = 'open'", whatsapp: "t.channel = 'whatsapp' AND t.status = 'open'", email: "t.channel = 'email' AND t.status = 'open'", closed: "t.status = 'closed'" }[f];
    const q = h.str(req.query.q, 80);
    const rows = db.all(`SELECT t.*, (SELECT CASE WHEN m.kind = 'email' AND m.subject IS NOT NULL THEN m.subject ELSE COALESCE(m.body, m.template) END FROM conv_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) last_text FROM conv_threads t WHERE ${where}${q ? ' AND (t.name LIKE ? OR t.address LIKE ? OR t.last_preview LIKE ?)' : ''} ORDER BY COALESCE(t.last_at, t.created_at) DESC LIMIT 200`, ...(f === 'mine' ? [req.user.id] : []), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));
    const qs = `${f !== 'all' ? `f=${f}&` : ''}${q ? `q=${encodeURIComponent(q)}&` : ''}`;
    const activeId = h.int(req.query.t);
    const t = activeId ? db.get('SELECT * FROM conv_threads WHERE id = ?', activeId) : null;
    if (t && t.unread) db.run('UPDATE conv_threads SET unread = 0 WHERE id = ?', t.id);
    const tabs = [['all', tr('All')], ['unread', tr('com|Unread')], ['mine', tr('com|Mine')], ['whatsapp', tr('WhatsApp')], ['email', tr('Email')], ['closed', tr('com|Closed')]]
      .map(([k, l]) => `<a class="tab${f === k ? ' is-on' : ''}" href="/admin/conversations${k === 'all' ? '' : `?f=${k}`}">${ui.esc(l)}</a>`).join('');
    const search = `<form class="convsearch" method="get">${f !== 'all' ? `<input type="hidden" name="f" value="${f}">` : ''}<input type="search" name="q" value="${ui.esc(q)}" placeholder="${ui.esc(tr('com|Search conversations'))}" aria-label="${ui.esc(tr('com|Search conversations'))}"></form>`;
    let pane = `<div class="convpane convpane--empty">${ui.empty(tr('com|Choose a conversation.'))}<p class="muted small">${ui.esc(tr('com|Website forms arrive in the Inbox.'))} <a href="/admin/inbox">${ui.esc(tr('Inbox'))}</a></p></div>`;
    if (t) {
      const lead = t.lead_id ? db.get('SELECT id, ref, title FROM leads WHERE id = ?', t.lead_id) : null;
      const users = h.users().filter((u) => u.role !== 'viewer');
      const csrf = req.session.csrf;
      const link = lead
        ? `<a class="badge badge--forest" href="/admin/leads/${lead.id}">${ui.esc(`${tr('search|Lead')} ${lead.ref}`)}</a>`
        : h.can(req, 'agent') ? ui.form(`/admin/conversations/${t.id}/lead`, csrf, ui.btn(tr('com|Create lead'), { cls: 'btn--ghost btn--xs', ic: 'plus' })) : '';
      const assign = h.can(req, 'agent') ? ui.form(`/admin/conversations/${t.id}/assign`, csrf, `<select name="user" data-autosubmit aria-label="${ui.esc(tr('com|Assigned to'))}"><option value="">${ui.esc(tr('Unassigned'))}</option>${users.map((u) => `<option value="${u.id}"${u.id === t.assigned_to ? ' selected' : ''}>${ui.esc(u.name)}</option>`).join('')}</select>`, { cls: 'convassign' }) : '';
      const closeBtn = h.can(req, 'agent') ? ui.form(`/admin/conversations/${t.id}/status`, csrf, `<input type="hidden" name="status" value="${t.status === 'open' ? 'closed' : 'open'}"><button class="iconbtn" title="${ui.esc(t.status === 'open' ? tr('com|Close conversation') : tr('com|Reopen'))}" aria-label="${ui.esc(t.status === 'open' ? tr('com|Close conversation') : tr('com|Reopen'))}">${ui.icon(t.status === 'open' ? 'check' : 'arrow')}</button>`) : '';
      const windowNote = t.channel === 'whatsapp' && wa.configured() ? `<small class="muted">${ui.esc(inWindow(t) ? tr('com|Free replies allowed for {h} more hours', { h: Math.max(1, Math.round((24 * 3600 * 1000 - (Date.now() - Date.parse(t.last_in_at))) / 3600000)) }) : tr('com|Outside the 24-hour window'))}</small>` : '';
      pane = `<div class="convpane">
        <header class="convhead"><a class="iconbtn convback" href="/admin/conversations?${qs}" aria-label="${ui.esc(tr('Back'))}">${ui.icon('arrow', 'ic--back')}</a><span class="avatar${t.channel === 'whatsapp' ? ' avatar--wa' : ''}">${ui.esc(ui.initials(threadName(t)))}</span><div class="convhead__who"><b>${ui.esc(threadName(t))}</b><small>${channelBadge(t.channel)} <bdi>${ui.esc(t.channel === 'whatsapp' ? pretty(t.address) : t.address)}</bdi> ${link}</small>${windowNote}</div>${assign}${closeBtn}</header>
        <div class="convbody" data-convbody>${bubbles(t)}</div>
        ${h.can(req, 'agent') ? composer(req, t) : ''}
      </div>`;
    }
    const snippets = db.all('SELECT * FROM snippets ORDER BY title');
    const snipCard = h.can(req, 'agent') ? `<details class="convsnips"><summary>${ui.icon('chat')}<span>${ui.esc(tr('com|Quick replies'))} (${snippets.length})</span></summary>
      ${snippets.length ? `<ul class="list">${snippets.map((s) => `<li><span class="what"><b>${ui.esc(tx(s.title))}</b><small>${ui.esc((req.lang === 'ar' ? s.body_ar || s.body_en : s.body_en || s.body_ar) || '')}</small></span>${ui.form(`/admin/conversations/snippets/${s.id}/delete`, req.session.csrf, `<button class="iconbtn" aria-label="${ui.esc(tr('Delete'))}" title="${ui.esc(tr('Delete'))}" data-confirm="${ui.esc(tr('com|Delete this quick reply?'))}">×</button>`)}</li>`).join('')}</ul>` : ''}
      ${ui.form('/admin/conversations/snippets', req.session.csrf, `${ui.input('title', tr('Title'), '', { required: true, placeholder: tr('com|e.g. Viewing confirmed') })}${ui.textarea('body_en', tr('com|In English'), '', { rows: 2 })}${ui.textarea('body_ar', tr('com|In Arabic'), '', { rows: 2 })}${ui.btn(tr('Add'), { cls: 'btn--ghost btn--sm', ic: 'plus' })}`, { cls: 'stack' })}</details>` : '';
    const body = `<div class="conv${t ? ' conv--open' : ''}">
      <aside class="convside"><nav class="tabs tabs--tight">${tabs}</nav>${search}${threadList(rows, t ? t.id : null, qs)}${snipCard}</aside>
      ${pane}
    </div>`;
    h.page(req, res, { title: tr('nav|Conversations'), active: '/admin/conversations', wide: true, body });
  });

  const threadOf = (req) => db.get('SELECT * FROM conv_threads WHERE id = ?', h.int(req.params.id));
  router.post('/conversations/:id/reply', R('agent'), async (req, res, next) => {
    const t = threadOf(req);
    if (!t) return next();
    const back = `/admin/conversations?t=${t.id}`;
    if (t.channel === 'email') {
      const subject = h.str(req.body.subject, 200);
      const text = h.str(req.body.body, 8000);
      if (!subject || !text) return h.back(req, res, back, 'error', tr('com|Write a subject and a message.'));
      const lang = /[؀-ۿ]/.test(text) ? 'ar' : 'en';
      const html = template({ lang, title: subject, intro: escH(text).replace(/\n/g, '<br>'), site: env.SITE_URL || '' });
      const { out } = sendEmail(t, { subject, html, text, user: req.user, lang, related: t.lead_id ? { entity: 'lead', id: t.lead_id } : null });
      if (t.lead_id) db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, done_at, created_at) VALUES (?, ?, ?, 'email', ?, ?, ?)", t.lead_id, t.brand_id, req.user.id, `Email: ${subject}`, M.now(), M.now());
      return h.back(req, res, back, out.status === 'not_configured' ? 'error' : 'ok', out.status === 'not_configured' ? tr('com|Saved in the outbox, but email is not set up yet.') : tr('com|Email sent.'));
    }
    let r;
    if (req.body.template) {
      const tpl = templates().find((x) => x.name === req.body.template);
      if (!tpl) return h.back(req, res, back, 'error', tr('com|Choose a template.'));
      r = await sendWhatsApp(t, { template: tpl, params: String(req.body.params || '').split('|').map((x) => x.trim()).filter(Boolean), user: req.user });
    } else {
      const text = h.str(req.body.body, 4000);
      if (!text) return h.back(req, res, back, 'error', tr('com|Write a message.'));
      r = await sendWhatsApp(t, { text, user: req.user });
      if (t.lead_id) db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, done_at, created_at) VALUES (?, ?, ?, 'whatsapp', ?, ?, ?)", t.lead_id, t.brand_id, req.user.id, `WhatsApp: ${text.slice(0, 80)}`, M.now(), M.now());
    }
    if (r.mode === 'manual') return res.redirect(303, r.link);
    if (r.error === 'window') return h.back(req, res, back, 'error', tr('com|More than 24 hours since their last message: send an approved template instead.'));
    h.back(req, res, back, r.ok ? 'ok' : 'error', r.ok ? tr('com|Sent.') : tr('com|WhatsApp did not accept it: {error}', { error: r.error }));
  });

  router.post('/conversations/:id/assign', R('agent'), (req, res, next) => {
    const t = threadOf(req);
    if (!t) return next();
    const u = h.int(req.body.user);
    db.run('UPDATE conv_threads SET assigned_to = ? WHERE id = ?', u && db.get('SELECT id FROM users WHERE id = ? AND active = 1', u) ? u : null, t.id);
    h.back(req, res, `/admin/conversations?t=${t.id}`, 'ok', tr('Saved.'));
  });
  router.post('/conversations/:id/status', R('agent'), (req, res, next) => {
    const t = threadOf(req);
    if (!t) return next();
    db.run('UPDATE conv_threads SET status = ?, unread = 0 WHERE id = ?', req.body.status === 'closed' ? 'closed' : 'open', t.id);
    h.back(req, res, req.body.status === 'closed' ? '/admin/conversations' : `/admin/conversations?t=${t.id}`, 'ok', req.body.status === 'closed' ? tr('com|Conversation closed.') : tr('com|Conversation reopened.'));
  });
  // a new contact who wrote in: a brand, contact and lead from the conversation
  router.post('/conversations/:id/lead', R('agent'), (req, res, next) => {
    const t = threadOf(req);
    if (!t) return next();
    if (t.lead_id) return res.redirect(303, `/admin/leads/${t.lead_id}`);
    const name = t.name || (t.channel === 'whatsapp' ? pretty(t.address) : t.address);
    const at = M.now();
    const leadId = db.tx(() => {
      const brandId = t.brand_id || Number(db.run('INSERT INTO brands (name, category, created_at) VALUES (?, ?, ?)', name, 'other', at).lastInsertRowid);
      const contactId = t.contact_id || Number(db.run('INSERT INTO contacts (brand_id, name, email, phone, whatsapp, primary_contact, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        brandId, name, t.channel === 'email' ? t.address : null, t.channel === 'whatsapp' ? `+${t.address}` : null, t.channel === 'whatsapp' ? `+${t.address}` : null, at).lastInsertRowid);
      const lead = { brand_id: brandId, area_min: null, area_max: null };
      const id = Number(db.run(
        `INSERT INTO leads (ref, brand_id, contact_id, title, category, source, stage, probability, value_est, owner_id, next_step, next_step_at, created_at, updated_at, stage_at)
         VALUES (?, ?, ?, ?, 'other', ?, 'new', 10, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('leads', 'LD'), brandId, contactId, name, t.channel === 'whatsapp' ? 'phone' : 'direct', M.estimateValue(db, lead), req.user.id, 'Reply to the message', M.addDays(M.today(), 1), at, at, at,
      ).lastInsertRowid);
      db.run('UPDATE conv_threads SET lead_id = ?, brand_id = ?, contact_id = ?, assigned_to = COALESCE(assigned_to, ?) WHERE id = ?', id, brandId, contactId, req.user.id, t.id);
      return id;
    });
    h.log(req, 'Created a lead from a conversation', 'lead', leadId, name);
    h.back(req, res, `/admin/leads/${leadId}`, 'ok', tr('com|Lead created from the conversation.'));
  });
  router.post('/conversations/snippets', R('agent'), (req, res) => {
    const title = h.str(req.body.title, 80);
    const en = h.str(req.body.body_en, 1500);
    const ar = h.str(req.body.body_ar, 1500);
    if (!title || (!en && !ar)) return h.back(req, res, '/admin/conversations', 'error', tr('com|Give the quick reply a title and a text.'));
    db.run('INSERT INTO snippets (title, body_en, body_ar, created_by, created_at) VALUES (?, ?, ?, ?, ?)', title, en || null, ar || null, req.user.id, M.now());
    h.back(req, res, h.safeBack ? h.safeBack(req, '/admin/conversations') : '/admin/conversations', 'ok', tr('com|Quick reply saved.'));
  });
  router.post('/conversations/snippets/:sid/delete', R('agent'), (req, res) => {
    db.run('DELETE FROM snippets WHERE id = ?', h.int(req.params.sid));
    h.back(req, res, h.safeBack ? h.safeBack(req, '/admin/conversations') : '/admin/conversations', 'ok', tr('com|Quick reply deleted.'));
  });

  // ---------- the lead page: its conversation ----------
  h.leadPanels = h.leadPanels || [];
  h.leadPanels.push((req, l) => {
    const threads = db.all('SELECT * FROM conv_threads WHERE lead_id = ? ORDER BY COALESCE(last_at, created_at) DESC', l.id);
    const ids = threads.map((t) => t.id);
    const msgs = ids.length ? db.all(`SELECT m.*, t.channel FROM conv_messages m JOIN conv_threads t ON t.id = m.thread_id WHERE m.thread_id IN (${ids.map(() => '?').join(',')}) ORDER BY m.created_at DESC, m.id DESC LIMIT 4`, ...ids).reverse() : [];
    const c = l.contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', l.contact_id) : null;
    const phone = c && normalizePhone(c.whatsapp || c.phone);
    const email = c && c.email;
    const list = msgs.length
      ? `<div class="minithread">${msgs.map((m) => `<div class="bub bub--${m.direction} bub--mini${m.kind === 'email' ? ' bub--email' : ''}">${m.kind === 'email' && m.subject ? `<b class="bub__subj">${ui.esc(tx(m.subject))}</b>` : ''}<p>${ui.esc(String(tx(m.body) || '').slice(0, 220))}</p><small class="bub__meta">${m.channel === 'whatsapp' ? ui.esc(tr('WhatsApp')) : ui.esc(tr('Email'))} · ${ui.esc(ui.rel(m.created_at))}${m.direction === 'out' ? ` ${ticks(m.status)}` : ''}</small></div>`).join('')}</div>`
      : `<p class="muted pad">${ui.esc(tr('com|No messages with this brand yet.'))}</p>`;
    const can = h.can(req, 'agent') && (phone || email);
    const quick = can ? ui.form(`/admin/leads/${l.id}/message`, req.session.csrf, `<div class="composer__row"><select name="channel" aria-label="${ui.esc(tr('com|Channel'))}">${phone ? `<option value="whatsapp">${ui.esc(tr('WhatsApp'))}</option>` : ''}${email ? `<option value="email">${ui.esc(tr('Email'))}</option>` : ''}</select><input type="text" name="body" required placeholder="${ui.esc(tr('com|Quick message…'))}" aria-label="${ui.esc(tr('com|Quick message…'))}">${ui.btn(tr('com|Send'), { cls: 'btn--primary btn--sm' })}</div>`, { cls: 'composer composer--mini', attrs: !wa.configured() && phone ? { 'data-wa-maybe': '' } : {} }) : '';
    const open = threads.length ? ui.btn(tr('com|Open conversation'), { href: `/admin/conversations?t=${threads[0].id}`, cls: 'btn--ghost btn--sm' }) : '';
    return ui.card(tr('com|Conversation'), `${list}${quick}`, { action: open });
  });
  router.post('/leads/:id/message', R('agent'), async (req, res, next) => {
    const l = db.get('SELECT * FROM leads WHERE id = ?', h.int(req.params.id));
    if (!l) return next();
    const back = `/admin/leads/${l.id}`;
    const c = l.contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', l.contact_id) : null;
    const text = h.str(req.body.body, 4000);
    if (!c || !text) return h.back(req, res, back, 'error', tr('com|Write a message.'));
    if (req.body.channel === 'email' && c.email) {
      const t = thread('email', c.email, { name: c.name, lead_id: l.id, brand_id: l.brand_id, contact_id: c.id });
      const lang = /[؀-ۿ]/.test(text) ? 'ar' : 'en';
      const subject = i18n.run(lang, () => tr('com|A message from The Wave'));
      const { out } = sendEmail(t, { subject, html: template({ lang, title: subject, intro: escH(text).replace(/\n/g, '<br>'), site: env.SITE_URL || '' }), text, user: req.user, lang, related: { entity: 'lead', id: l.id } });
      db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, done_at, created_at) VALUES (?, ?, ?, 'email', ?, ?, ?)", l.id, l.brand_id, req.user.id, `Email: ${text.slice(0, 80)}`, M.now(), M.now());
      return h.back(req, res, back, out.status === 'not_configured' ? 'error' : 'ok', out.status === 'not_configured' ? tr('com|Saved in the outbox, but email is not set up yet.') : tr('com|Email sent.'));
    }
    const phone = c.whatsapp || c.phone;
    if (!normalizePhone(phone)) return h.back(req, res, back, 'error', tr('com|Add a mobile number to the brand’s contact first.'));
    const t = thread('whatsapp', phone, { name: c.name, lead_id: l.id, brand_id: l.brand_id, contact_id: c.id });
    const r = await sendWhatsApp(t, { text, user: req.user });
    db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, done_at, created_at) VALUES (?, ?, ?, 'whatsapp', ?, ?, ?)", l.id, l.brand_id, req.user.id, `WhatsApp: ${text.slice(0, 80)}`, M.now(), M.now());
    if (r.mode === 'manual') return res.redirect(303, r.link);
    if (r.error === 'window') return h.back(req, res, `/admin/conversations?t=${t.id}`, 'error', tr('com|More than 24 hours since their last message: send an approved template instead.'));
    h.back(req, res, back, r.ok ? 'ok' : 'error', r.ok ? tr('com|Sent.') : tr('com|WhatsApp did not accept it: {error}', { error: r.error }));
  });

  // ---------- notifications ----------
  h.mePanels = h.mePanels || [];
  h.mePanels.push((req) => {
    const p = prefs(req.user.id);
    const box = (k, label) => `<label class="check"><input type="checkbox" name="${k}" value="1"${p[k] ? ' checked' : ''}> ${ui.esc(label)}</label>`;
    return ui.card(tr('com|Email notifications'), ui.form('/admin/me/notifications', req.session.csrf, `${box('digest', tr('com|A morning summary of my day (7:30)'))}${box('signed', tr('com|When a brand signs or declines an offer'))}${box('enquiry', tr('com|New website enquiries'))}${box('payment', tr('com|Payments received online'))}${req.user.email ? '' : `<p class="muted small">${ui.esc(tr('com|Add an email address to receive these.'))}</p>`}${ui.btn(tr('Save'), { cls: 'btn--primary' })}`, { cls: 'stack' }), { sub: ui.esc(tr('com|Sent to {email}', { email: req.user.email })) });
  });
  router.post('/me/notifications', (req, res) => {
    const v = (k) => (req.body[k] ? 1 : 0);
    db.run('INSERT INTO notif_prefs (user_id, digest, signed, enquiry, payment) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET digest = excluded.digest, signed = excluded.signed, enquiry = excluded.enquiry, payment = excluded.payment',
      req.user.id, v('digest'), v('signed'), v('enquiry'), v('payment'));
    h.back(req, res, '/admin/me', 'ok', tr('Saved.'));
  });

  // What someone's morning looks like: sections of items (empty sections left out).
  function digestFor(u) {
    const t = M.today();
    const mgr = ['admin', 'manager'].includes(u.role);
    const sections = [];
    const add = (key, items) => { if (items.length) sections.push({ key, items }); };
    add('tasks', db.all("SELECT a.subject, a.due_at, l.title FROM activities a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.user_id = ? AND a.done_at IS NULL AND a.due_at IS NOT NULL AND substr(a.due_at, 1, 10) <= ? AND a.type NOT IN ('viewing','meeting') ORDER BY a.due_at LIMIT 12", u.id, t)
      .map((a) => ({ label: a.subject, sub: a.title, when: a.due_at })));
    add('viewings', db.all("SELECT a.subject, a.due_at, l.title FROM activities a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.done_at IS NULL AND a.type IN ('viewing','meeting') AND substr(a.due_at, 1, 10) = ? AND (a.user_id = ? OR l.owner_id = ?) ORDER BY a.due_at", t, u.id, u.id)
      .map((a) => ({ label: a.subject, sub: a.title, when: a.due_at })));
    if (mgr) {
      add('approvals', db.all("SELECT o.ref, l.title FROM offers o JOIN leads l ON l.id = o.lead_id WHERE o.status = 'pending' ORDER BY o.created_at").map((o) => ({ label: o.ref, sub: o.title })));
      add('overdue', db.all("SELECT i.ref, i.total - i.paid amount, i.due_date, COALESCE(b.name, i.customer) name FROM invoices i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.status IN ('open','partial') AND i.due_date < ? ORDER BY i.due_date LIMIT 10", t)
        .map((i) => ({ label: `${i.name || ''} · ${i.ref}`, sub: Math.round(i.amount), when: i.due_date, money: true })));
    }
    const warn = Number(db.setting('doc_warn_days')) || 30;
    const hrOk = u.role === 'admin' || u.hr;
    add('documents', db.all(`SELECT title, expires_on FROM documents WHERE archived = 0 AND expires_on IS NOT NULL AND expires_on <= ? ${hrOk ? '' : "AND confidential = 0 AND entity != 'employee'"} ORDER BY expires_on LIMIT 8`, M.addDays(t, warn))
      .filter(() => mgr || hrOk).map((d) => ({ label: d.title, when: d.expires_on })));
    if (mgr) add('contracts', db.all("SELECT ref, title, end_date FROM contracts WHERE status = 'active' AND end_date IS NOT NULL AND date(end_date, '-' || notice_days || ' days') <= ? ORDER BY end_date LIMIT 8", t).map((c) => ({ label: `${c.ref} · ${c.title}`, when: c.end_date })));
    add('enquiries', db.all("SELECT name, brand, created_at FROM messages WHERE status = 'new' ORDER BY created_at DESC LIMIT 8").filter(() => mgr || u.role === 'agent').map((m) => ({ label: m.brand || m.name, sub: m.name, when: m.created_at })));
    return { sections, count: sections.reduce((a, s) => a + s.items.length, 0) };
  }
  const SECTION = () => ({
    tasks: tr('com|Your tasks due'), viewings: tr('com|Viewings and meetings today'), approvals: tr('com|Offers waiting for your approval'),
    overdue: tr('com|Overdue rent'), documents: tr('com|Documents to renew'), contracts: tr('com|Contracts to renew'), enquiries: tr('com|New enquiries'),
  });
  function digestEmail(u, d, lang) {
    return i18n.run(lang, () => {
      const L = SECTION();
      const align = lang === 'ar' ? 'right' : 'left';
      const body = d.sections.map((s) => `<h2 style="margin:22px 0 6px;font-size:13px;letter-spacing:${lang === 'ar' ? 0 : '.14em'};text-transform:${lang === 'ar' ? 'none' : 'uppercase'};color:#7c4d28;" align="${align}">${escH(L[s.key])} · ${s.items.length}</h2>`
        + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${s.items.map((i) => `<tr><td style="padding:8px 0;border-bottom:1px solid #e6e1d5;font-size:14px;" align="${align}"><b>${escH(tx(i.label))}</b>${i.sub !== undefined && i.sub !== null && i.sub !== '' ? `<br><span style="color:#56625d;font-size:12px;">${escH(i.money ? ui.money(i.sub) : i.sub)}</span>` : ''}</td><td style="padding:8px 0;border-bottom:1px solid #e6e1d5;font-size:12px;color:#56625d;white-space:nowrap;" align="${lang === 'ar' ? 'left' : 'right'}">${i.when ? escH(ui.rel(i.when)) : ''}</td></tr>`).join('')}</table>`).join('');
      const first = String(u.name || '').split(' ')[0];
      const title = tr('com|Good morning, {name}', { name: first });
      return {
        subject: tr('com|Your day at The Wave · {date}', { date: ui.date(M.today()) }),
        html: template({ lang, preheader: tn(d.count, 'com|{n} thing for today', 'com|{n} things for today'), eyebrow: tr('com|Morning summary'), title, intro: escH(tn(d.count, 'com|{n} thing for today', 'com|{n} things for today')), body, button: { label: tr('com|Open the leasing office'), url: `${site()}/admin` }, site: env.SITE_URL || '' }),
        text: [title, ...d.sections.map((s) => `${L[s.key]}:\n${s.items.map((i) => `- ${tx(i.label)}${i.sub ? ` (${i.money ? ui.money(i.sub) : i.sub})` : ''}`).join('\n')}`)].join('\n\n'),
      };
    });
  }
  async function runDigest({ force = false } = {}) {
    const c = cairoNow();
    if (!force && (c.minutes < 7 * 60 + 30 || db.setting('digest_sent') === c.date)) return 0;
    db.setSetting('digest_sent', c.date);
    let n = 0;
    for (const u of db.all("SELECT * FROM users WHERE active = 1 AND email IS NOT NULL AND email NOT LIKE '%@demo.thewave.local'")) {
      if (!prefs(u.id).digest) continue;
      const d = digestFor(u);
      if (!d.count) continue;
      const m = digestEmail(u, d, userLang(u));
      mail.send({ to: u.email, subject: m.subject, html: m.html, text: m.text, lang: userLang(u), related: { entity: 'digest', id: u.id } });
      n++;
    }
    return n;
  }
  async function enquiryAlerts() {
    const since = db.setting('enquiry_alert_at');
    const t = nowIso();
    db.setSetting('enquiry_alert_at', t);
    if (!since) return 0;
    const list = db.all('SELECT * FROM messages WHERE created_at > ? AND created_at <= ? AND demo = 0 ORDER BY created_at', since, t);
    for (const m of list) {
      const lead = m.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', m.lead_id) : null;
      const owner = lead && lead.owner_id ? db.get('SELECT * FROM users WHERE id = ?', lead.owner_id) : null;
      notify([owner, ...managers()], 'enquiry', (l) => noticeEmail(l, {
        eyebrow: () => (m.kind === 'leasing' ? tr('Leasing enquiry') : tr('com|Website message')),
        title: () => tr('com|New enquiry from {name}', { name: m.brand || m.name }),
        intro: () => String(m.body || '').slice(0, 400),
        rows: () => [[tr('Name'), m.name || ''], [tr('Email'), m.email || ''], [tr('Phone'), m.phone || '—']],
        button: () => ({ label: tr('com|Open in the inbox'), url: `${site()}/admin/inbox/${m.id}` }),
      }));
    }
    return list.length;
  }
  h.events.on('payment.received', ({ payment, invoice }) => {
    if (!payment || !payment.provider || payment.demo) return;
    const lead = invoice && invoice.lease_id ? db.get('SELECT l.* FROM leads l JOIN leases s ON s.lead_id = l.id WHERE s.id = ?', invoice.lease_id) : null;
    const owner = lead && lead.owner_id ? db.get('SELECT * FROM users WHERE id = ?', lead.owner_id) : null;
    const finance = db.all("SELECT * FROM users WHERE active = 1 AND (role = 'admin' OR finance = 1)");
    const party = invoice ? h.billing.party(invoice) : '';
    notify([owner, ...finance], 'payment', (l) => noticeEmail(l, {
      eyebrow: () => tr('com|Payment received'),
      title: () => tr('com|{name} paid {amount} online', { name: party, amount: ui.money(payment.amount) }),
      intro: () => tr('com|Invoice {ref} · {provider}', { ref: invoice ? invoice.ref : '', provider: payment.provider }),
      button: () => (invoice ? { label: tr('com|Open the invoice'), url: `${site()}/admin/invoices/${invoice.id}` } : null),
    }));
  });
  h.comms = { digestFor, digestEmail, runDigest, enquiryAlerts, templates };
  h.every('email-retry', 10 * 60 * 1000, () => mail.retry(), { first: 2 * 60 * 1000 });
  h.every('daily-digest', 10 * 60 * 1000, () => runDigest(), { first: 3 * 60 * 1000 });
  h.every('enquiry-alerts', 5 * 60 * 1000, () => enquiryAlerts(), { first: 60 * 1000 });

  // ---------- integrations ----------
  h.integrationCards = h.integrationCards || [];
  const cardStatus = (c) => {
    try {
      return typeof c.status === 'function' ? c.status() : c.status || { ok: !!c.ok, detail: c.detail || '' };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  };
  router.get('/integrations', R('admin'), (req, res) => {
    const csrf = req.session.csrf;
    const yes = (ok, onText, offText) => `<span class="intstate intstate--${ok ? 'on' : 'off'}">${ui.icon(ok ? 'check' : 'log')}${ui.esc(ok ? onText : offText)}</span>`;
    // setting names are shown as read-only fields, easy to select and copy into the hosting panel
    const code = (k, label = tr('com|Setting name')) => `<input class="envname" type="text" readonly value="${ui.esc(k)}" size="${k.length}" aria-label="${ui.esc(label)}" data-select>`;
    const envList = (keys) => `<ul class="envlist">${keys.map(([k, set, hint]) => `<li>${code(k)}${set ? ui.badge('on', tr('com|set'), 'ok') : ui.badge('off', tr('com|missing'), 'mute')}${hint ? `<small>${ui.esc(hint)}</small>` : ''}</li>`).join('')}</ul>`;
    const emailCard = ui.card(tr('Email'), `${yes(mail.configured(), tr('com|Connected'), tr('com|Not set up'))}
      <p class="muted">${ui.esc(tr('com|Offers, notifications and the morning summary are sent from {from}. Without SMTP they wait in the outbox below.', { from: mail.from() }))}</p>
      ${envList([['SMTP_HOST', !!env.SMTP_HOST], ['SMTP_PORT', !!env.SMTP_PORT, tr('com|465 (default) or 587')], ['SMTP_USER', !!env.SMTP_USER], ['SMTP_PASS', !!env.SMTP_PASS], ['MAIL_FROM', !!env.MAIL_FROM]])}
      ${ui.form('/admin/integrations/test-email', csrf, ui.btn(tr('com|Send me a test email'), { cls: 'btn--ghost btn--sm', ic: 'mail' }))}`);
    const tplText = templates().map((x) => `${x.name} | ${x.lang || 'en'} | ${x.use || ''} | ${x.body || ''}`).join('\n');
    const waCard = ui.card(tr('WhatsApp'), `${yes(wa.configured(), tr('com|Connected to WhatsApp Business'), tr('com|Click-to-chat mode'))}
      <p class="muted">${ui.esc(wa.configured() ? tr('com|Messages go out from your WhatsApp Business number and replies arrive in Conversations.') : tr('com|Until WhatsApp Business is connected, messages open in WhatsApp on your own phone or computer and are logged here by hand.'))}</p>
      ${envList([['WHATSAPP_TOKEN', !!env.WHATSAPP_TOKEN], ['WHATSAPP_PHONE_ID', !!env.WHATSAPP_PHONE_ID], ['WHATSAPP_VERIFY_TOKEN', !!env.WHATSAPP_VERIFY_TOKEN], ['WHATSAPP_APP_SECRET', !!env.WHATSAPP_APP_SECRET]])}
      <dl class="dl"><div><dt>${ui.esc(tr('com|Webhook address'))}</dt><dd><code>${ui.esc(`${site(req)}/webhooks/whatsapp`)}</code></dd></div><div><dt>${ui.esc(tr('com|Webhook fields'))}</dt><dd>${code('messages')}</dd></div></dl>
      ${ui.form('/admin/integrations/test-whatsapp', csrf, `<div class="fields">${ui.input('to', tr('com|Test number'), req.user.phone || '', { type: 'tel', required: true, placeholder: '+20 10 1234 5678' })}</div>${ui.btn(tr('com|Send a test message'), { cls: 'btn--ghost btn--sm', ic: 'chat' })}`, { cls: 'stack', attrs: wa.configured() ? {} : { target: '_blank', 'data-wa': '' } })}
      ${ui.form('/admin/integrations/templates', csrf, `${ui.textarea('templates', tr('com|Approved templates, one per line: name | language | use | text with {{1}}'), tplText, { rows: 4 })}<small class="muted">${ui.esc(tr('com|Use “offer” for the template that sends proposals. Templates must be approved in Meta Business Manager first.'))}</small>${ui.btn(tr('Save'), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })}`);
    const others = h.integrationCards.map((c) => {
      const st = cardStatus(c);
      return ui.card(c.title, `${yes(!!st.ok, st.okText || tr('com|Connected'), st.offText || tr('com|Not set up'))}${st.detail ? `<p class="muted">${ui.esc(st.detail)}</p>` : ''}${c.env ? envList(c.env.map((k) => (Array.isArray(k) ? k : [k, !!env[k]]))) : ''}${c.help ? `<p class="muted small">${ui.esc(c.help)}</p>` : ''}${c.href ? `<p>${ui.btn(c.hrefLabel || tr('com|Open'), { href: c.href, cls: 'btn--ghost btn--sm' })}</p>` : ''}`);
    }).join('');
    const statusL = statusLabel();
    const out = db.all('SELECT * FROM outbox ORDER BY id DESC LIMIT 200');
    const outTable = ui.table([
      { label: tr('com|To'), render: (m) => `<b>${ui.esc(m.to_addr || '—')}</b><small class="sub">${ui.esc(tx(m.subject) || '')}</small>` },
      { label: tr('Status'), render: (m) => `${ui.badge(m.status, statusL[m.status] || m.status, statusTone[m.status])}${m.error ? `<small class="sub">${ui.esc(String(tx(m.error)).slice(0, 80))}</small>` : ''}` },
      { label: tr('Date'), render: (m) => ui.esc(ui.rel(m.created_at)) },
      { label: '', render: (m) => (['failed', 'not_configured', 'queued'].includes(m.status) && mail.configured() ? ui.form(`/admin/integrations/outbox/${m.id}/retry`, csrf, ui.btn(tr('com|Retry'), { cls: 'btn--ghost btn--xs' })) : '') },
    ], out, { empty: ui.esc(tr('com|Nothing sent yet.')) });
    const jobs = h.jobs ? h.jobs.list() : [];
    const JOB = { 'email-retry': tr('com|Retry failed emails'), 'daily-digest': tr('com|Morning summary'), 'enquiry-alerts': tr('com|Enquiry alerts') };
    const jobTable = ui.table([
      { label: tr('com|Job'), // other modules' jobs: their "job|name" dictionary entry, else the job's code name
      render: (j) => (JOB[j.name] ? `<b>${ui.esc(JOB[j.name])}</b>` : i18n.AR[`job|${j.name}`] !== undefined || !i18n.isAr() ? `<b>${ui.esc(i18n.AR[`job|${j.name}`] !== undefined ? tr(`job|${j.name}`) : j.name.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()))}</b>` : code(j.name, tr('com|Job'))) },
      { label: tr('com|Every'), render: (j) => ui.esc(tn(Math.round(j.ms / 60000), 'com|{n} minute', 'com|{n} minutes')) },
      { label: tr('com|Last run'), render: (j) => (j.lastStart ? ui.esc(ui.rel(j.lastStart)) : '—') },
      { label: tr('Status'), render: (j) => (j.lastError ? ui.badge('failed', tr('com|Failed'), 'rose') : j.lastOk ? ui.badge('ok', tr('com|OK'), 'ok') : ui.badge('wait', tr('com|Waiting'), 'mute')) },
    ], jobs, { empty: ui.esc(tr('com|Background jobs run on the live server.')) });
    const body = `<div class="grid grid--2">${emailCard}${waCard}${others}</div>
      <div class="grid grid--2">${ui.card(tr('com|Outbox'), outTable, { sub: ui.esc(tr('com|The last 200 messages sent by the office')) })}${ui.card(tr('com|Background jobs'), jobTable)}</div>`;
    h.page(req, res, { title: tr('nav|Integrations'), active: '/admin/integrations', wide: true, body });
  });
  router.post('/integrations/test-email', R('admin'), async (req, res) => {
    if (!req.user.email) return h.back(req, res, '/admin/integrations', 'error', tr('com|Add an email address to your account first.'));
    const lang = req.lang;
    const m = noticeEmail(lang, { eyebrow: () => tr('nav|Integrations'), title: () => tr('com|Email is working'), intro: () => tr('com|This test was sent from The Wave leasing office.') });
    const out = mail.send({ to: req.user.email, subject: m.subject, html: m.html, text: m.text, lang });
    const r = await out.done;
    h.back(req, res, '/admin/integrations', r && r.status === 'sent' ? 'ok' : 'error', r && r.status === 'sent' ? tr('com|Test email sent to {to}.', { to: req.user.email }) : r && r.status === 'not_configured' ? tr('com|Email is not set up yet: add the SMTP settings in the hosting panel.') : tr('com|The test email failed: {error}', { error: (r && r.error) || '' }));
  });
  router.post('/integrations/test-whatsapp', R('admin'), async (req, res) => {
    const to = normalizePhone(req.body.to);
    if (!to) return h.back(req, res, '/admin/integrations', 'error', tr('com|Enter a mobile number.'));
    const text = i18n.run(req.lang, () => tr('com|Test message from The Wave leasing office.'));
    if (!wa.configured()) return res.redirect(303, waLink(to, text));
    const tpl = templates()[0];
    const r = tpl ? await wa.sendTemplate(to, tpl.name, tpl.lang, []) : await wa.sendText(to, text);
    h.back(req, res, '/admin/integrations', r.ok ? 'ok' : 'error', r.ok ? tr('com|Test message sent.') : tr('com|WhatsApp did not accept it: {error}', { error: r.error }));
  });
  router.post('/integrations/templates', R('admin'), (req, res) => {
    const list = String(req.body.templates || '').split('\n').map((line) => line.split('|').map((x) => x.trim())).filter((p) => /^[a-z0-9_]{1,120}$/.test(p[0] || ''))
      .slice(0, 30).map(([name, lang, use, ...rest]) => ({ name, lang: /^[a-z]{2}(_[A-Z]{2})?$/.test(lang || '') ? lang : 'en', use: use || '', body: rest.join(' | ').slice(0, 1000) }));
    db.setSetting('wa_templates', JSON.stringify(list));
    h.log(req, 'Saved WhatsApp templates', 'settings', null, `${list.length}`);
    h.back(req, res, '/admin/integrations', 'ok', tr('Saved.'));
  });
  router.post('/integrations/outbox/:id/retry', R('admin'), async (req, res) => {
    const r = await mail.resend(h.int(req.params.id));
    h.back(req, res, '/admin/integrations', r && r.status === 'sent' ? 'ok' : 'error', r && r.status === 'sent' ? tr('com|Sent.') : tr('com|Still not sent: {error}', { error: (r && r.error) || '' }));
  });
};

module.exports.jpegInfo = jpegInfo;
module.exports.readSignature = readSignature;
module.exports.certificatePdf = certificatePdf;
