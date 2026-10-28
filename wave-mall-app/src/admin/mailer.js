'use strict';

// Email for the leasing office. Every message is written to the outbox first and then delivered
// over SMTP (the same SMTP_* settings as the website's enquiry email). Without SMTP the message is
// kept as "not configured" so nothing is lost and the team can see what would have gone out.
// send() never throws: it returns the outbox row at once, and `done` resolves when delivery finished.

const nodemailer = require('nodemailer');

const MAX_ATTEMPTS = 5;

function mailer(db, env = process.env) {
  let transport = null;
  const configured = () => !!env.SMTP_HOST;
  const from = () => env.MAIL_FROM || env.SMTP_USER || 'leasing@thewavemall.com';
  function getTransport() {
    if (!configured()) return null;
    if (!transport) {
      const port = Number(env.SMTP_PORT) || 465;
      transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        // a local test server has no certificate; real servers are verified
        tls: env.SMTP_INSECURE === '1' ? { rejectUnauthorized: false } : undefined,
      });
    }
    return transport;
  }

  const row = (id) => db.get('SELECT * FROM outbox WHERE id = ?', id);

  async function deliver(id) {
    const m = row(id);
    if (!m) return null;
    const t = getTransport();
    if (!t) {
      db.run("UPDATE outbox SET status = 'not_configured', error = ? WHERE id = ?", 'SMTP is not configured', id);
      return row(id);
    }
    try {
      const atts = m.attachments ? JSON.parse(m.attachments) : [];
      const info = await t.sendMail({
        from: from(),
        to: m.to_addr,
        cc: m.cc || undefined,
        replyTo: m.reply_to || undefined,
        subject: m.subject,
        text: m.body_text || undefined,
        html: m.body_html || undefined,
        attachments: atts.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType })),
      });
      db.run("UPDATE outbox SET status = 'sent', error = NULL, provider_id = ?, sent_at = ?, attempts = attempts + 1 WHERE id = ?", String(info.messageId || ''), new Date().toISOString(), id);
    } catch (err) {
      const a = (m.attempts || 0) + 1;
      db.run('UPDATE outbox SET status = ?, error = ?, attempts = ? WHERE id = ?', 'failed', String(err.message || err).slice(0, 300), a, id);
    }
    return row(id);
  }

  // send({ to, cc, replyTo, subject, html, text, attachments: [{ filename, content: Buffer, contentType }],
  //        related: { entity, id }, thread_id, user_id, lang })
  function send(msg) {
    const atts = (msg.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content).toString('base64') }));
    const to = [].concat(msg.to || []).filter(Boolean).join(', ');
    const id = Number(db.run(
      `INSERT INTO outbox (channel, to_addr, cc, reply_to, subject, body_html, body_text, attachments, lang, status, related_entity, related_id, thread_id, user_id, demo, created_at)
       VALUES ('email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      to, [].concat(msg.cc || []).filter(Boolean).join(', ') || null, msg.replyTo || null, String(msg.subject || '').slice(0, 250), msg.html || null, msg.text || null,
      atts.length ? JSON.stringify(atts) : null, msg.lang || 'en', configured() ? 'queued' : 'not_configured',
      msg.related ? msg.related.entity : null, msg.related ? msg.related.id : null, msg.thread_id || null, msg.user_id || null, msg.demo ? 1 : 0, new Date().toISOString(),
    ).lastInsertRowid);
    if (!to) {
      db.run("UPDATE outbox SET status = 'failed', error = 'No recipient' WHERE id = ?", id);
      return { ...row(id), done: Promise.resolve(row(id)) };
    }
    if (!configured()) {
      db.run("UPDATE outbox SET error = 'SMTP is not configured' WHERE id = ?", id);
      return { ...row(id), done: Promise.resolve(row(id)) };
    }
    const done = deliver(id);
    return { ...row(id), done };
  }

  // Retry failed messages (and queued ones a crash may have left), oldest first.
  async function retry({ max = 20 } = {}) {
    const list = db.all("SELECT id FROM outbox WHERE channel = 'email' AND (status = 'failed' AND attempts < ? OR status = 'queued' AND created_at < ?) ORDER BY id LIMIT ?",
      MAX_ATTEMPTS, new Date(Date.now() - 5 * 60000).toISOString(), max);
    for (const m of list) await deliver(m.id);
    return list.length;
  }
  // Send one message again on request (the Retry button), whatever its state.
  async function resend(id) {
    const m = row(id);
    if (!m || m.channel !== 'email') return null;
    if (!configured()) return row(id);
    db.run("UPDATE outbox SET status = 'queued' WHERE id = ?", id);
    return deliver(id);
  }

  return { send, retry, resend, deliver, configured, from, MAX_ATTEMPTS, reset: () => { transport = null; } };
}

// ---------- the branded email ----------
// Table-based with inline styles so it renders in Gmail, Outlook and Apple Mail. The wordmark is
// set in type (images are often blocked); Arabic mail is right to left.
const C = { forest: '#283833', sand: '#d1c9b3', paper: '#fbfaf6', ink: '#1e2925', ink2: '#56625d', line: '#e6e1d5', stone: '#f3f0e8' };
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function template({ lang = 'en', preheader = '', eyebrow = '', title = '', intro = '', body = '', button = null, footer = '', site = '' }) {
  const ar = lang === 'ar';
  const dir = ar ? 'rtl' : 'ltr';
  const align = ar ? 'right' : 'left';
  const font = ar ? "Almarai, Tahoma, Arial, sans-serif" : "'Helvetica Neue', Helvetica, Arial, sans-serif";
  const serif = ar ? font : "Didot, 'Bodoni 72', Georgia, 'Times New Roman', serif";
  const btn = button
    ? `<tr><td style="padding:8px 40px 32px;" align="${align}"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="background:${C.forest};border-radius:4px;"><a href="${escH(button.url)}" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:14px;font-weight:600;letter-spacing:${ar ? 0 : '.06em'};color:${C.paper};text-decoration:none;">${escH(button.label)}</a></td></tr></table></td></tr>`
    : '';
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escH(title)}</title></head>
<body style="margin:0;padding:0;background:${C.stone};" dir="${dir}">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">${escH(preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.stone};"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:${C.paper};border:1px solid ${C.line};" dir="${dir}">
  <tr><td style="background:${C.forest};padding:34px 40px 30px;" align="${align}">
    <div style="font-family:${serif};font-size:13px;letter-spacing:.42em;color:${C.sand};line-height:1;">THE</div>
    <div style="font-family:${serif};font-size:38px;letter-spacing:.08em;color:${C.paper};line-height:1.05;margin-top:2px;">WAVE</div>
    <div style="font-family:${font};font-size:11px;letter-spacing:${ar ? 0 : '.28em'};color:${C.sand};opacity:.8;margin-top:12px;text-transform:${ar ? 'none' : 'uppercase'};">${ar ? 'مكتب التأجير · القاهرة الجديدة' : 'Leasing office · New Cairo'}</div>
  </td></tr>
  <tr><td style="padding:36px 40px 8px;font-family:${font};color:${C.ink};" align="${align}">
    ${eyebrow ? `<div style="font-size:11px;font-weight:600;letter-spacing:${ar ? 0 : '.22em'};text-transform:${ar ? 'none' : 'uppercase'};color:#7c4d28;margin-bottom:12px;">${escH(eyebrow)}</div>` : ''}
    <h1 style="margin:0 0 14px;font-family:${serif};font-weight:${ar ? 700 : 400};font-size:${ar ? 24 : 28}px;line-height:1.3;color:${C.ink};">${escH(title)}</h1>
    ${intro ? `<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:${C.ink2};">${intro}</p>` : ''}
  </td></tr>
  ${body ? `<tr><td style="padding:0 40px 18px;font-family:${font};font-size:14px;line-height:1.6;color:${C.ink};" align="${align}">${body}</td></tr>` : ''}
  ${btn}
  <tr><td style="padding:22px 40px 30px;border-top:1px solid ${C.line};font-family:${font};font-size:12px;line-height:1.6;color:${C.ink2};" align="${align}">
    ${footer || (ar ? 'ذا ويف · التسعين الشمالي، القاهرة الجديدة' : 'The Wave · North 90, New Cairo')}${site ? ` · <a href="${escH(site)}" style="color:${C.ink2};">${escH(site.replace(/^https?:\/\//, ''))}</a>` : ''}
  </td></tr>
</table></td></tr></table></body></html>`;
}

// A two-column facts table for the body of an email.
function facts(rows, { lang = 'en' } = {}) {
  const align = lang === 'ar' ? 'right' : 'left';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid ${C.line};margin:6px 0 10px;">${rows
    .filter(Boolean)
    .map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.line};color:${C.ink2};font-size:13px;width:42%;" align="${align}">${escH(k)}</td><td style="padding:10px 0;border-bottom:1px solid ${C.line};font-size:14px;font-weight:600;color:${C.ink};" align="${align}">${v}</td></tr>`)
    .join('')}</table>`;
}

module.exports = { mailer, template, facts, escH };
