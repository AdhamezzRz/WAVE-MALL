'use strict';

// WhatsApp Business through Meta's Cloud API.
//   WHATSAPP_TOKEN         a permanent system-user access token
//   WHATSAPP_PHONE_ID      the business phone number's ID (not the number itself)
//   WHATSAPP_VERIFY_TOKEN  any secret string; Meta sends it back when you register the webhook
//   WHATSAPP_APP_SECRET    the app secret; signs every webhook (X-Hub-Signature-256)
//   WHATSAPP_API_BASE      optional, for tests (default https://graph.facebook.com/v21.0)
// Without a token and phone ID the office works in "click to chat" mode: messages open in the
// person's own WhatsApp (wa.me links) and are logged in the conversation by hand.

const crypto = require('node:crypto');

// Egyptian numbers to the international form WhatsApp uses (digits only, no +):
// 010 1234 5678 → 201012345678 · +20 10 … → 2010… · 0020… → 20…; other countries kept as given.
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (/^01[0125]\d{8}$/.test(d)) d = `2${d}`;          // 01x xxxx xxxx (mobile)
  else if (/^1[0125]\d{8}$/.test(d)) d = `20${d}`;          // 1x xxxx xxxx (leading 0 dropped)
  if (/^200(1[0125]\d{8})$/.test(d)) d = `20${d.slice(3)}`;  // +20 01x… (an extra 0)
  return /^\d{8,15}$/.test(d) ? d : '';
}

const pretty = (n) => {
  const d = normalizePhone(n);
  const m = d.match(/^20(1\d)(\d{4})(\d{4})$/);
  return m ? `+20 ${m[1]} ${m[2]} ${m[3]}` : d ? `+${d}` : String(n || '');
};

function whatsapp(env = process.env) {
  const base = (env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
  const configured = () => !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);

  async function call(payload) {
    if (!configured()) return { ok: false, error: 'not_configured' };
    try {
      const r = await fetch(`${base}/${encodeURIComponent(env.WHATSAPP_PHONE_ID)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: (j.error && (j.error.error_user_msg || j.error.message)) || `HTTP ${r.status}`, code: j.error && j.error.code };
      return { ok: true, id: j.messages && j.messages[0] ? j.messages[0].id : null };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  return {
    configured,
    // free text: only inside 24 hours of the person's last message
    sendText: (to, body) => call({ recipient_type: 'individual', to: normalizePhone(to), type: 'text', text: { preview_url: true, body: String(body).slice(0, 4096) } }),
    // an approved template: name, language code (en, ar, en_US…), body parameters in order
    sendTemplate: (to, name, language, params = []) => call({
      to: normalizePhone(to),
      type: 'template',
      template: { name, language: { code: language || 'en' }, components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] : [] },
    }),
    // Meta signs the raw request body with the app secret.
    verifySignature(rawBody, header) {
      if (!env.WHATSAPP_APP_SECRET) return false;
      const sig = String(header || '');
      if (!sig.startsWith('sha256=')) return false;
      const want = crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
      const got = sig.slice(7);
      return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
    },
    verifyToken: (t) => !!env.WHATSAPP_VERIFY_TOKEN && t === env.WHATSAPP_VERIFY_TOKEN,
    // flattens a webhook body into { messages: [{ from, name, id, at, type, text }], statuses: [{ id, status, at, error }] }
    parse(body) {
      const out = { messages: [], statuses: [] };
      for (const e of (body && body.entry) || []) {
        for (const ch of e.changes || []) {
          const v = ch.value || {};
          const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
          for (const m of v.messages || []) {
            const text = m.type === 'text' ? m.text && m.text.body
              : m.type === 'button' ? m.button && m.button.text
                : m.type === 'interactive' ? (m.interactive && (m.interactive.button_reply || m.interactive.list_reply || {}).title)
                  : `[${m.type}]`;
            out.messages.push({ from: normalizePhone(m.from), name: names[m.from] || null, id: m.id, at: new Date(Number(m.timestamp || 0) * 1000 || Date.now()).toISOString(), type: m.type, text: String(text || '') });
          }
          for (const s of v.statuses || []) {
            out.statuses.push({ id: s.id, status: s.status, at: new Date(Number(s.timestamp || 0) * 1000 || Date.now()).toISOString(), error: s.errors && s.errors[0] ? s.errors[0].title || s.errors[0].message : null });
          }
        }
      }
      return out;
    },
  };
}

// A click-to-chat link that opens WhatsApp with the text ready to send.
const waLink = (phone, text = '') => `https://wa.me/${normalizePhone(phone)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

module.exports = { whatsapp, normalizePhone, pretty, waLink };
