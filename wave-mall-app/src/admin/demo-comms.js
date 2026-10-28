'use strict';

// Sample deal communication: WhatsApp and email conversations with the sample brands (one from an
// unknown number, ready to become a lead), quick replies, an offer signed online with its
// certificate in the vault, one opened twice and not signed yet, and what the outbox sent.
// Everything carries demo = 1 so clear() removes exactly it. English text the system stores has
// Arabic in i18n/ar-comms.js (shown through tx()).

const crypto = require('node:crypto');
const { template } = require('./mailer');
const { pretty } = require('./whatsapp');

const DAY = 86400000;
const HOUR = 3600000;
const at = (ms) => new Date(Date.now() - ms).toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A signature for the sample signed offer (typed in The Wave's italic serif, then underlined).
const SIGNATURE = [
  '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',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//Z',
].join('');

const ready = (db) => !!db.value("SELECT COUNT(*) FROM _modules WHERE name = 'comms-1'");

function load(db, admin, opts = {}) {
  const h = opts.h;
  if (!ready(db) || !h || !h.conversations || !h.signing || !h.offers) return;
  if (db.value('SELECT COUNT(*) FROM conv_threads WHERE demo = 1')) return;
  const lead = (title) => db.get('SELECT l.*, c.name contact_name, c.title contact_title, c.email contact_email, c.phone contact_phone FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id WHERE l.title = ? AND l.demo = 1', title);
  const offerOf = (l, status) => (l ? db.get('SELECT * FROM offers WHERE lead_id = ? AND status = ? ORDER BY id LIMIT 1', l.id, status) : null);
  const { thread, addMessage } = h.conversations;
  const site = String((h.env && h.env.SITE_URL) || 'https://thewavemall.com').replace(/\/$/, '');
  const fakeLink = () => `${site}/sign/${crypto.randomBytes(32).toString('base64url')}`;
  const msg = (t, direction, ms, body, extra = {}) => addMessage(t, { direction, body, at: at(ms), demo: 1, ...extra });

  db.tx(() => {
    // ---------- quick replies ----------
    const snippet = (title, en, ar) => db.run('INSERT INTO snippets (title, body_en, body_ar, created_by, demo, created_at) VALUES (?, ?, ?, ?, 1, ?)', title, en, ar, admin ? admin.id : null, at(20 * DAY));
    snippet('Viewing confirmed', 'Your viewing at The Wave is confirmed. Please come to the leasing suite at the North 90 entrance; parking is free for visitors.', 'تم تأكيد زيارتكم لذا ويف. نرجو التوجه إلى جناح التأجير عند مدخل التسعين الشمالي، والانتظار مجاني للزوار.');
    snippet('Proposal follow-up', 'Just checking in on the proposal we sent. Happy to walk you through the terms or adjust anything that does not work for you.', 'نود الاطمئنان بخصوص العرض الذي أرسلناه. يسعدنا شرح الشروط أو تعديل ما لا يناسبكم.');
    snippet('Thank you', 'Thank you for your time today. We will send the floor plans and the unit schedule shortly.', 'شكرًا لوقتكم اليوم. سنرسل المخططات وجدول الوحدات قريبًا.');

    // ---------- Olive & Oak Kitchen: WhatsApp, a proposal opened twice ----------
    const oo = lead('Olive & Oak Kitchen');
    const ooOffer = offerOf(oo, 'sent');
    if (oo && oo.contact_phone) {
      const t = thread('whatsapp', oo.contact_phone, { name: oo.contact_name, lead_id: oo.id, brand_id: oo.brand_id, contact_id: oo.contact_id, demo: 1 });
      const by = oo.owner_id;
      msg(t, 'out', 3 * DAY + 5 * HOUR, 'Hello Youssef, it was great to walk G05 with you today. I will send the revised proposal by Thursday.', { status: 'read', user_id: by });
      msg(t, 'in', 3 * DAY + 4 * HOUR, 'Thanks! The team loved the terrace. Can we get four months rent-free for the fit-out?');
      msg(t, 'out', 2 * DAY + 2 * HOUR, `We can do four months. Here is the updated proposal to review and sign: ${fakeLink()}`, { status: 'read', user_id: by });
      msg(t, 'in', 5 * HOUR, 'Received, thank you. Our board meets on Sunday and we will come back to you right after.');
      db.run('UPDATE conv_threads SET unread = 1 WHERE id = ?', t.id);
    }
    if (ooOffer) {
      db.run(
        `INSERT INTO offer_signing (offer_id, token_hash, nonce, lang, sent_to, via, created_by, created_at, expires_at, views, first_viewed_at, last_viewed_at, demo)
         VALUES (?, ?, ?, 'en', ?, 'email', ?, ?, ?, 2, ?, ?, 1)`,
        ooOffer.id, sha(crypto.randomBytes(32).toString('hex')), crypto.randomBytes(18).toString('base64url'), oo.contact_email, oo.owner_id, at(2 * DAY + 2 * HOUR),
        `${ooOffer.valid_until}T21:59:59.000Z`, at(DAY + 3 * HOUR), at(5 * HOUR + 20 * 60000),
      );
      const subject = `Leasing proposal ${ooOffer.ref} · The Wave`;
      const body = 'Please find our leasing proposal for Olive & Oak Kitchen at The Wave below. You can review the full proposal and accept it online in a few minutes.';
      db.run(`INSERT INTO outbox (channel, to_addr, subject, body_html, body_text, lang, status, provider_id, attempts, related_entity, related_id, user_id, demo, created_at, sent_at)
              VALUES ('email', ?, ?, ?, ?, 'en', 'sent', ?, 1, 'offer', ?, ?, 1, ?, ?)`,
      oo.contact_email, subject, template({ title: subject, intro: body }), body, `<${crypto.randomBytes(8).toString('hex')}@thewavemall.com>`, ooOffer.id, oo.owner_id, at(2 * DAY + 2 * HOUR), at(2 * DAY + 2 * HOUR - 4000));
    }

    // ---------- Desert Rose Perfumery: WhatsApp in Arabic, sent from a phone ----------
    const dr = lead('Desert Rose Perfumery');
    const drOffer = offerOf(dr, 'sent');
    if (dr && dr.contact_phone) {
      const t = thread('whatsapp', dr.contact_phone, { name: dr.contact_name, lead_id: dr.id, brand_id: dr.brand_id, contact_id: dr.contact_id, demo: 1 });
      msg(t, 'out', 8 * DAY + 3 * HOUR, `أهلاً ريم، مرفق عرض ذا ويف للوحدة S05. تقدري تراجعيه وتوقعيه من هنا: ${fakeLink()}`, { status: 'manual', user_id: dr.owner_id });
      msg(t, 'in', 8 * DAY + HOUR, 'شكرًا جدًا، هراجعه مع شريكتي وأرد عليكم.');
      msg(t, 'in', 20 * HOUR, 'هل ممكن نعمل زيارة للموقع يوم الأحد الساعة ١٢ الظهر؟');
      db.run('UPDATE conv_threads SET unread = 1 WHERE id = ?', t.id);
      if (drOffer) {
        db.run(
          `INSERT INTO offer_signing (offer_id, token_hash, nonce, lang, sent_to, via, created_by, created_at, expires_at, demo)
           VALUES (?, ?, ?, 'ar', ?, 'whatsapp', ?, ?, ?, 1)`,
          drOffer.id, sha(crypto.randomBytes(32).toString('hex')), crypto.randomBytes(18).toString('base64url'), pretty(dr.contact_phone), dr.owner_id, at(8 * DAY + 3 * HOUR), `${drOffer.valid_until}T21:59:59.000Z`,
        );
      }
    }

    // ---------- an unknown number: a new brand asking about a kiosk ----------
    const k = thread('whatsapp', '+20 11 2345 6789', { name: 'كريم عادل', demo: 1 });
    if (k) {
      msg(k, 'in', 2 * HOUR + 10 * 60000, 'مساء الخير، عندي براند قهوة مختصة ومحتاج كشك حوالي ٢٠ متر. إيه الأسعار المتاحة؟');
      db.run('UPDATE conv_threads SET unread = 1 WHERE id = ?', k.id);
    }

    // ---------- Atelier Nour: the proposal by email, signed online ----------
    const an = lead('Atelier Nour');
    const anOffer = offerOf(an, 'accepted');
    if (an && anOffer && an.contact_email) {
      const t = thread('email', an.contact_email, { name: an.contact_name, lead_id: an.id, brand_id: an.brand_id, contact_id: an.contact_id, demo: 1 });
      const decided = anOffer.decided_at || at(24 * DAY);
      const signedAt = new Date(Date.parse(decided) - 40 * 60000).toISOString();
      const sentAt = new Date(Date.parse(signedAt) - 26 * HOUR).toISOString();
      const subject = `Leasing proposal ${anOffer.ref} · The Wave`;
      const body = 'Please find our leasing proposal for Atelier Nour at The Wave below. You can review the full proposal and accept it online in a few minutes.';
      msg(t, 'out', Date.now() - Date.parse(sentAt), body, { kind: 'email', subject, status: 'sent', user_id: an.owner_id });
      msg(t, 'in', Date.now() - Date.parse(signedAt) - 15 * 60000, 'Signed online just now. Looking forward to opening at The Wave!', { kind: 'email', subject: `Re: ${subject}` });
      db.run('UPDATE conv_threads SET unread = 0 WHERE id = ?', t.id);
      db.run(`INSERT INTO outbox (channel, to_addr, subject, body_html, body_text, lang, status, provider_id, attempts, related_entity, related_id, thread_id, user_id, demo, created_at, sent_at)
              VALUES ('email', ?, ?, ?, ?, 'en', 'sent', ?, 1, 'offer', ?, ?, ?, 1, ?, ?)`,
      an.contact_email, subject, template({ title: subject, intro: body }), body, `<${crypto.randomBytes(8).toString('hex')}@thewavemall.com>`, anOffer.id, t.id, an.owner_id, sentAt, sentAt);

      // the signature, with the exact proposal it accepted and a certificate in the vault
      const o = h.offers.of(anOffer.id);
      const sig = h.signing.readSignature(`data:image/jpeg;base64,${SIGNATURE}`);
      const docHash = require('./i18n').run('en', () => sha(h.offers.proposal(o)));
      const id = Number(db.run(
        `INSERT INTO offer_signing (offer_id, token_hash, nonce, lang, sent_to, via, created_by, created_at, expires_at, views, first_viewed_at, last_viewed_at, status,
           signed_at, decided_at, signer_name, signer_title, signer_email, signature, signature_kind, ip, user_agent, doc_hash, demo)
         VALUES (?, ?, ?, 'en', ?, 'email', ?, ?, ?, 3, ?, ?, 'signed', ?, ?, ?, ?, ?, ?, 'typed', ?, ?, ?, 1)`,
        o.id, sha(crypto.randomBytes(32).toString('hex')), crypto.randomBytes(18).toString('base64url'), an.contact_email, an.owner_id, sentAt,
        new Date(Date.parse(sentAt) + 21 * DAY).toISOString(), new Date(Date.parse(sentAt) + 3 * HOUR).toISOString(), signedAt, signedAt, signedAt,
        an.contact_name, an.contact_title, an.contact_email, sig ? sig.dataUrl : null, '41.233.18.72',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', docHash,
      ).lastInsertRowid);
      const s = db.get('SELECT * FROM offer_signing WHERE id = ?', id);
      db.run('UPDATE offer_signing SET snapshot = ? WHERE id = ?', h.signing.signedRecord(o, s, 'en'), id);
      if (sig) h.signing.storeCertificate(o, s, sig);
      db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, body, done_at, demo, created_at) VALUES (?, ?, NULL, 'note', ?, ?, ?, 1, ?)",
        an.id, an.brand_id, `Offer ${o.ref} signed online by ${an.contact_name}`, an.contact_title ? `Title: ${an.contact_title}` : null, signedAt, signedAt);
    }

    // ---------- Oud & Amber: an email thread about floor plans ----------
    const oa = lead('Oud & Amber');
    if (oa && oa.contact_email) {
      const t = thread('email', oa.contact_email, { name: oa.contact_name, lead_id: oa.id, brand_id: oa.brand_id, contact_id: oa.contact_id, demo: 1 });
      msg(t, 'out', 5 * DAY + 2 * HOUR, 'As promised, here are the floor plans and the fit-out guide for S01.', { kind: 'email', subject: 'Floor plans for S01', status: 'sent', user_id: oa.owner_id });
      msg(t, 'in', 4 * DAY + 6 * HOUR, 'Thank you. Could you also share the signage guidelines?', { kind: 'email', subject: 'Re: Floor plans for S01' });
      db.run('UPDATE conv_threads SET unread = 0 WHERE id = ?', t.id);
    }

    // ---------- the outbox: one that failed, one waiting for email to be set up ----------
    const out = (to, subject, body, status, error, ms, attempts) => db.run(
      `INSERT INTO outbox (channel, to_addr, subject, body_html, body_text, lang, status, error, attempts, demo, created_at)
       VALUES ('email', ?, ?, ?, ?, 'en', ?, ?, ?, 1, ?)`,
      to, subject, template({ title: subject, intro: body }), body, status, error, attempts, at(ms),
    );
    out('press@example.com', 'Your visit to The Wave', 'Thank you for your interest. We would be glad to host you at the leasing suite.', 'failed', 'Connection timed out', 6 * DAY, 2);
    out('salma@example.com', 'Thank you for your enquiry', 'Thank you for your enquiry. A member of the leasing team will call you within one working day.', 'not_configured', 'SMTP is not configured', 3 * DAY, 0);
  });
}

function clear(db, { files } = {}) {
  if (!ready(db)) return;
  const docs = db.all('SELECT d.id, d.stored FROM documents d JOIN offer_signing s ON s.document_id = d.id WHERE s.demo = 1');
  db.tx(() => {
    db.run('DELETE FROM conv_messages WHERE demo = 1 OR thread_id IN (SELECT id FROM conv_threads WHERE demo = 1)');
    db.run('DELETE FROM conv_threads WHERE demo = 1');
    db.run('DELETE FROM snippets WHERE demo = 1');
    db.run('DELETE FROM outbox WHERE demo = 1');
    db.run('DELETE FROM offer_signing WHERE demo = 1');
    for (const d of docs) db.run('DELETE FROM documents WHERE id = ?', d.id);
  });
  if (files) for (const d of docs) files.release(db, d.stored);
}

module.exports = { load, clear, SIGNATURE };
