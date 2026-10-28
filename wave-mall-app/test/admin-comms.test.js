'use strict';

// Deal communication: offers signed online (and declined), links that expire or are tampered with,
// the WhatsApp webhook (signature, threading, delivery statuses), email through a real SMTP
// conversation and without SMTP, and the morning summary.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const { createApp } = require('../src/app');
const { mailer } = require('../src/admin/mailer');
const { whatsapp, normalizePhone, waLink } = require('../src/admin/whatsapp');
const { SIGNATURE } = require('../src/admin/demo-comms');
const i18n = require('../src/admin/i18n');

const SECRET = 'test-app-secret';
let server;
let base;
let app;
let db;
let h;
let csrf;
const jar = new Map();

before(async () => {
  app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  base = `http://127.0.0.1:${server.address().port}`;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  const setup = await (await go('/admin/setup')).text();
  await go('/admin/setup', form({ _token: setup.match(/name="_token" value="([^"]+)"/)[1], name: 'Office Admin', email: 'admin@thewave.test', password: 'long-enough-1' }));
  csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
  await go('/admin/settings/demo', form({ _csrf: csrf }));
});
after(() => server.close());

async function go(path, opts = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
    else jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}
const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
// the signing pages are public: no session cookie
const pub = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts });
const offerFor = (title) => db.get("SELECT o.* FROM offers o JOIN leads l ON l.id = o.lead_id WHERE l.title = ? AND o.status = 'sent'", title);
async function signingLink(offerId, lang = 'en') {
  const res = await go(`/admin/offers/${offerId}/link`, form({ _csrf: csrf, lang }));
  assert.equal(res.status, 200);
  const m = (await res.text()).match(/value="https:\/\/thewavemall\.com\/sign\/([A-Za-z0-9_-]{43})"/);
  assert.ok(m, 'the link is shown once');
  return m[1];
}
const fieldsOf = (html) => Object.fromEntries(['nonce', 'doc_hash', 'lang'].map((k) => [k, html.match(new RegExp(`name="${k}" value="([^"]*)"`))[1]]));
const sig = `data:image/jpeg;base64,${SIGNATURE}`;

test('comms: Egyptian numbers, click-to-chat links', () => {
  assert.equal(normalizePhone('010 1234 5678'), '201012345678');
  assert.equal(normalizePhone('+20 10 1234 5678'), '201012345678');
  assert.equal(normalizePhone('0020 115 555 0101'), '201155550101');
  assert.equal(normalizePhone('+20 010 1234 5678'), '201012345678');
  assert.equal(normalizePhone('1012345678'), '201012345678');
  assert.equal(normalizePhone('+44 7700 900123'), '447700900123');
  assert.equal(normalizePhone('call me'), '');
  assert.equal(waLink('01012345678', 'Hi there'), 'https://wa.me/201012345678?text=Hi%20there');
});

test('comms: an offer is signed online, end to end', async () => {
  const o = offerFor('Olive & Oak Kitchen');
  assert.ok(o);
  const token = await signingLink(o.id);
  assert.equal(db.value('SELECT COUNT(*) FROM offer_signing WHERE token_hash = ?', token), 0, 'only a hash of the token is kept');

  let res = await pub(`/sign/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  let html = await res.text();
  assert.match(html, /Olive &amp; Oak Kitchen/);
  assert.match(html, /class="doc"/, 'the exact proposal');
  assert.match(html, /data-sigpad/);
  assert.match(html, /src="\/admin\/sign\.js"/);
  assert.doesNotMatch(html, /<script>/, 'no inline scripts (CSP)');
  assert.doesNotMatch(html, /rel="manifest"|pwa\.js/, 'the office app is not offered to brands');
  const f = fieldsOf(html);
  // in Arabic too
  const ar = await (await pub(`/sign/${token}?lang=ar`)).text();
  assert.match(ar, /<html lang="ar" dir="rtl"/);
  assert.match(ar, /القبول والتوقيع/);
  const s0 = db.get('SELECT * FROM offer_signing WHERE offer_id = ? ORDER BY id DESC LIMIT 1', o.id);
  assert.equal(s0.views, 2, 'each opening is counted');

  // what is refused: a wrong nonce, a changed document, no consent, no signature
  const post = (data) => pub(`/sign/${token}`, { ...form({ name: 'Youssef Amin', title: 'Managing partner', email: 'youssef@brand.test', consent: '1', signature: sig, signature_kind: 'typed', ...f, ...data }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'TestPhone/1.0' } });
  assert.equal((await post({ nonce: 'x'.repeat(24) })).status, 422);
  assert.equal((await post({ doc_hash: 'f'.repeat(64) })).status, 422);
  assert.equal((await post({ consent: '' })).status, 422);
  assert.equal((await post({ signature: 'data:image/png;base64,iVBORw0KGgo=' })).status, 422);
  assert.equal((await post({ name: 'Y' })).status, 422);
  assert.equal(db.get('SELECT status FROM offers WHERE id = ?', o.id).status, 'sent', 'nothing changed');

  const mails = db.value('SELECT COUNT(*) FROM outbox');
  res = await post({});
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/sign/${token}?lang=en`);
  const offer = db.get('SELECT * FROM offers WHERE id = ?', o.id);
  assert.equal(offer.status, 'accepted');
  const s = db.get('SELECT * FROM offer_signing WHERE id = ?', s0.id);
  assert.equal(s.status, 'signed');
  assert.equal(s.signer_name, 'Youssef Amin');
  assert.equal(s.user_agent, 'TestPhone/1.0');
  assert.ok(s.ip);
  assert.equal(s.doc_hash, f.doc_hash);
  assert.match(s.doc_hash, /^[0-9a-f]{64}$/);
  assert.match(s.snapshot, /Signed electronically/);
  assert.match(s.snapshot, /data:image\/jpeg;base64,/);
  assert.doesNotMatch(s.snapshot, /<script/, 'the signed record is a static page');
  // the certificate is in the vault, as a PDF with the signature in it
  const doc = db.get('SELECT * FROM documents WHERE id = ?', s.document_id);
  assert.equal(doc.entity, 'brand');
  assert.equal(doc.mime, 'application/pdf');
  const pdf = Buffer.from(await (await go(`/admin/documents/${doc.id}/file`)).arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/DCTDecode/);
  // the deal moved on, the team was told, and the signer got a copy
  const lead = db.get('SELECT * FROM leads WHERE id = ?', o.lead_id);
  assert.equal(lead.stage, 'reserved');
  assert.ok(db.value("SELECT COUNT(*) FROM activities WHERE lead_id = ? AND subject LIKE 'Offer % signed online by Youssef Amin'", o.lead_id));
  assert.ok(db.value('SELECT COUNT(*) FROM outbox') > mails);
  const copy = db.get("SELECT * FROM outbox WHERE to_addr = 'youssef@brand.test'");
  assert.ok(copy && JSON.parse(copy.attachments)[0].filename.endsWith('.pdf'));
  assert.ok(db.value("SELECT COUNT(*) FROM audit WHERE action = 'Offer signed online'"));

  // single use: the link now only shows the confirmation
  res = await post({});
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Signed\. Thank you\./);
  html = await (await pub(`/sign/${token}`)).text();
  assert.match(html, /Signed\. Thank you\./);
  assert.doesNotMatch(html, /data-sigpad/);
  // the office sees it
  const page = await (await go(`/admin/offers/${o.id}`)).text();
  assert.match(page, /Signed online by Youssef Amin/);
  const record = await go(`/admin/offers/${o.id}/signed/${s.id}`);
  assert.equal(record.status, 200);
  assert.match(record.headers.get('content-security-policy'), /default-src 'none'/);
});

test('comms: a brand declines online, links expire and can be revoked', async () => {
  const o = offerFor('Desert Rose Perfumery');
  const token = await signingLink(o.id, 'ar');
  const html = await (await pub(`/sign/${token}`)).text();
  assert.match(html, /<html lang="ar"/, 'opens in the language it was sent in');
  const { nonce } = fieldsOf(html);
  let res = await pub(`/sign/${token}/decline`, form({ nonce, reason: 'Rent is above our budget' }));
  assert.equal(res.status, 303);
  assert.equal(db.get('SELECT status FROM offers WHERE id = ?', o.id).status, 'rejected');
  const s = db.get('SELECT * FROM offer_signing WHERE offer_id = ? ORDER BY id DESC LIMIT 1', o.id);
  assert.equal(s.status, 'declined');
  assert.equal(s.decline_reason, 'Rent is above our budget');
  res = await pub(`/sign/${token}`);
  assert.equal(res.status, 410);

  // an unknown token, an expired one, a revoked one
  assert.equal((await pub(`/sign/${'A'.repeat(43)}`)).status, 404);
  const other = db.get("SELECT o.id FROM offers o WHERE o.status IN ('approved','draft') AND o.demo = 1 LIMIT 1");
  const t2 = await signingLink(other.id);
  assert.equal(db.get('SELECT status FROM offers WHERE id = ?', other.id).status, 'sent', 'sharing a link sends the offer');
  const row = db.get('SELECT * FROM offer_signing WHERE offer_id = ? ORDER BY id DESC LIMIT 1', other.id);
  db.run('UPDATE offer_signing SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), row.id);
  res = await pub(`/sign/${t2}`);
  assert.equal(res.status, 410);
  assert.match(await res.text(), /This link has expired/);
  const t3 = await signingLink(other.id);
  const row3 = db.get('SELECT * FROM offer_signing WHERE offer_id = ? ORDER BY id DESC LIMIT 1', other.id);
  res = await go(`/admin/offers/${other.id}/signing/${row3.id}/revoke`, form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  assert.equal((await pub(`/sign/${t3}`)).status, 410);
});

test('comms: the WhatsApp webhook checks Meta’s signature, threads messages and tracks delivery', async () => {
  let res = await pub('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '12345');
  assert.equal((await pub('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);

  // a brand contact writes in: the message joins their lead's conversation
  const c = db.get("SELECT c.*, l.id lead_id FROM contacts c JOIN leads l ON l.contact_id = c.id WHERE l.title = 'Nile Optics'");
  const from = normalizePhone(c.phone);
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [{ profile: { name: 'Sherif' }, wa_id: from }], messages: [{ from, id: 'wamid.IN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Is S04 still available?' } }] } }] }] });
  const signed = (raw) => `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const hook = (raw, sigHeader) => pub('/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sigHeader }, body: raw });
  assert.equal((await hook(body, 'sha256=' + '0'.repeat(64))).status, 403, 'a wrong signature is refused');
  assert.equal((await hook(body, '')).status, 403);
  assert.equal((await hook(`${body} `, signed(body))).status, 403, 'the signature covers the exact bytes');
  assert.equal((await hook(body, signed(body))).status, 200);
  assert.equal((await hook(body, signed(body))).status, 200, 'Meta retries are accepted');
  const t = db.get("SELECT * FROM conv_threads WHERE channel = 'whatsapp' AND address = ?", from);
  assert.equal(t.lead_id, c.lead_id);
  assert.equal(t.contact_id, c.id);
  assert.equal(db.value('SELECT COUNT(*) FROM conv_messages WHERE provider_id = ?', 'wamid.IN1'), 1, 'stored once');
  assert.equal(t.unread, 1);
  assert.ok(t.last_in_at);
  let page = await (await go('/admin/conversations')).text();
  assert.match(page, /Is S04 still available\?/);
  page = await (await go(`/admin/conversations?t=${t.id}`)).text();
  assert.match(page, /bub bub--in/);
  assert.equal(db.get('SELECT unread FROM conv_threads WHERE id = ?', t.id).unread, 0, 'opening it marks it read');

  // a reply without WhatsApp Business: click-to-chat, logged in the thread
  res = await go(`/admin/conversations/${t.id}/reply`, form({ _csrf: csrf, body: 'Yes, it is. Shall we book a viewing?' }));
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^https:\/\/wa\.me\/\d+\?text=Yes/);
  assert.equal(db.get('SELECT status FROM conv_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1', t.id).status, 'manual');

  // delivery statuses move forward only
  h.conversations.addMessage(t, { direction: 'out', body: 'Sent through the API', status: 'sent', provider_id: 'wamid.OUT1' });
  const status = (st) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.OUT1', status: st, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: from }] } }] }] });
  for (const st of ['delivered', 'read', 'sent']) assert.equal((await hook(status(st), signed(status(st)))).status, 200);
  assert.equal(db.get("SELECT status FROM conv_messages WHERE provider_id = 'wamid.OUT1'").status, 'read');

  // an unknown number becomes a lead in one click
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'Hala Kiosk' }, wa_id: '201099988877' }], messages: [{ from: '201099988877', id: 'wamid.IN2', timestamp: '1700000000', type: 'text', text: { body: 'Do you have kiosks?' } }] } }] }] });
  await hook(raw, signed(raw));
  const unknown = db.get("SELECT * FROM conv_threads WHERE address = '201099988877'");
  assert.equal(unknown.lead_id, null);
  assert.equal(unknown.name, 'Hala Kiosk');
  res = await go(`/admin/conversations/${unknown.id}/lead`, form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  const lead = db.get('SELECT * FROM leads WHERE id = (SELECT lead_id FROM conv_threads WHERE id = ?)', unknown.id);
  assert.equal(lead.title, 'Hala Kiosk');
  assert.equal(lead.source, 'phone');
  assert.equal(db.get('SELECT whatsapp FROM contacts WHERE id = ?', lead.contact_id).whatsapp, '+201099988877');
});

test('comms: WhatsApp Business API calls (text and templates)', async () => {
  const calls = [];
  const graph = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      res.writeHead(calls.length === 3 ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(calls.length === 3 ? { error: { message: 'Re-engagement message' } } : { messages: [{ id: `wamid.T${calls.length}` }] }));
    });
  });
  await new Promise((r) => graph.listen(0, r));
  try {
    const wa = whatsapp({ WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_ID: '1234', WHATSAPP_API_BASE: `http://127.0.0.1:${graph.address().port}/v21.0` });
    assert.deepEqual(await wa.sendText('010 1234 5678', 'Hello'), { ok: true, id: 'wamid.T1' });
    assert.equal(calls[0].url, '/v21.0/1234/messages');
    assert.equal(calls[0].auth, 'Bearer tok');
    assert.equal(calls[0].body.to, '201012345678');
    assert.equal(calls[0].body.text.body, 'Hello');
    const r = await wa.sendTemplate('201012345678', 'wave_offer', 'ar', ['Nour', 'OF-1']);
    assert.equal(r.ok, true);
    assert.equal(calls[1].body.template.language.code, 'ar');
    assert.deepEqual(calls[1].body.template.components[0].parameters.map((p) => p.text), ['Nour', 'OF-1']);
    const bad = await wa.sendText('201012345678', 'late');
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'Re-engagement message');
    assert.equal(whatsapp({}).configured(), false);
    assert.deepEqual(await whatsapp({}).sendText('201012345678', 'x'), { ok: false, error: 'not_configured' });
  } finally {
    graph.close();
  }
});

test('comms: email waits in the outbox without SMTP, and is delivered over SMTP', async () => {
  // without SMTP: never throws, kept as "not configured"
  const o = db.get("SELECT o.* FROM offers o WHERE o.status IN ('approved','sent') AND o.demo = 1 ORDER BY id DESC LIMIT 1");
  const res = await go(`/admin/offers/${o.id}/send-email`, form({ _csrf: csrf, to: 'leasing@brand.test', cc: 'cfo@brand.test', lang: 'ar', note: 'Looking forward to it' }));
  assert.equal(res.status, 303);
  const row = db.get("SELECT * FROM outbox WHERE to_addr = 'leasing@brand.test'");
  assert.equal(row.status, 'not_configured');
  assert.equal(row.cc, 'cfo@brand.test');
  assert.match(row.subject, /عرض التأجير/, 'written in the language chosen');
  assert.match(row.body_html, /dir="rtl"/);
  assert.match(row.body_html, /https:\/\/thewavemall\.com\/sign\/[A-Za-z0-9_-]{43}/);
  assert.equal(db.get('SELECT via, sent_to, lang FROM offer_signing WHERE offer_id = ? ORDER BY id DESC LIMIT 1', o.id).via, 'email');
  assert.equal(db.value("SELECT COUNT(*) FROM conv_threads WHERE channel = 'email' AND address = 'leasing@brand.test'"), 1);
  const integrations = await (await go('/admin/integrations')).text();
  assert.match(integrations, /leasing@brand\.test/);
  assert.match(integrations, /SMTP_HOST/);

  // a minimal SMTP server on a local port
  const got = [];
  const smtp = net.createServer((sock) => {
    let data = false;
    let buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = data ? buf.indexOf('\r\n.\r\n') : buf.indexOf('\r\n')) >= 0) {
        if (data) {
          got.push(buf.slice(0, i));
          buf = buf.slice(i + 5);
          data = false;
          sock.write('250 2.0.0 queued as 42\r\n');
          continue;
        }
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^(EHLO|HELO)/i.test(line)) sock.write('250-test\r\n250 8BITMIME\r\n');
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go ahead\r\n'); } else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  try {
    const env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), MAIL_FROM: 'The Wave <leasing@thewave.test>' };
    const m = mailer(db, env);
    const sent = m.send({ to: 'brand@example.com', subject: 'Leasing proposal OF-TEST · The Wave', html: '<p>Hello</p>', text: 'Hello', attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }] });
    assert.equal(sent.status, 'queued');
    const r = await sent.done;
    assert.equal(r.status, 'sent');
    assert.equal(r.attempts, 1);
    assert.ok(r.sent_at);
    assert.match(got[0], /Subject: =\?UTF-8\?Q\?Leasing_proposal_OF-TEST/);
    assert.match(got[0], /^From: The Wave <leasing@thewave\.test>/);
    assert.match(got[0], /a\.pdf/);

    // a server that is down: failed, then delivered by the retry job once it is back
    const down = mailer(db, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
    const f = await down.send({ to: 'later@example.com', subject: 'Retry me', text: 'x' }).done;
    assert.equal(f.status, 'failed');
    assert.ok(f.error);
    assert.ok(await m.retry() >= 1);
    assert.equal(db.get('SELECT status FROM outbox WHERE id = ?', f.id).status, 'sent');
    assert.ok(got.some((x) => /Subject: Retry me/.test(x)));
  } finally {
    smtp.close();
  }
});

test('comms: the morning summary', async () => {
  const admin = db.get("SELECT * FROM users WHERE email = 'admin@thewave.test'");
  const d = h.comms.digestFor(admin);
  assert.ok(d.count > 0);
  const keys = d.sections.map((s) => s.key);
  assert.ok(keys.includes('approvals'), 'a manager sees offers to approve');
  assert.ok(keys.includes('overdue'), 'and overdue rent');
  const en = h.comms.digestEmail(admin, d, 'en');
  assert.match(en.subject, /^Your day at The Wave · /);
  assert.match(en.html, /Good morning, Office/);
  assert.match(en.html, /Offers waiting for your approval/);
  assert.match(en.text, /Overdue rent:/);
  const ar = h.comms.digestEmail(admin, d, 'ar');
  assert.match(ar.subject, /يومك في ذا ويف/);
  assert.match(ar.html, /dir="rtl"/);
  // sent once a day, only to people who want it
  const before = db.value('SELECT COUNT(*) FROM outbox WHERE related_entity = ?', 'digest');
  assert.equal(await h.comms.runDigest({ force: true }), 1, 'sample users have no real inbox');
  assert.equal(db.value('SELECT COUNT(*) FROM outbox WHERE related_entity = ?', 'digest'), before + 1);
  await go('/admin/me/notifications', form({ _csrf: csrf, signed: '1' }));
  assert.equal(db.get('SELECT digest FROM notif_prefs WHERE user_id = ?', admin.id).digest, 0);
  assert.equal(await h.comms.runDigest({ force: true }), 0);
  i18n.run('ar', () => assert.match(i18n.tx(`Offer OF-2026-001 emailed for signature to a@b.test`), /أُرسل العرض/));
});
