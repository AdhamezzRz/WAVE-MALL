'use strict';

const nodemailer = require('nodemailer');
const { esc } = require('./render');

const CATEGORIES = ['fashion', 'fnb', 'beauty', 'leisure', 'services', 'other'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

// Returns { ok: true, value } or { ok: false, errors: [...] }.
function validate(body = {}) {
  const value = {
    name: clean(body.name, 120),
    brand: clean(body.brand, 160),
    email: clean(body.email, 200),
    phone: clean(body.phone, 40),
    category: clean(body.category, 20) || 'other',
    size: clean(body.size, 4),
    message: clean(body.message, 2000),
    lang: body.lang === 'ar' ? 'ar' : 'en',
  };
  const errors = [];
  if (!value.name) errors.push('name');
  if (!value.brand) errors.push('brand');
  if (!EMAIL_RE.test(value.email)) errors.push('email');
  if (!CATEGORIES.includes(value.category)) errors.push('category');
  if (!['', 's', 'm', 'l'].includes(value.size)) errors.push('size');
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

let transport;
function getTransport(env) {
  if (!env.SMTP_HOST) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 465,
      secure: (Number(env.SMTP_PORT) || 465) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

// Sends the enquiry to LEASING_TO. Without SMTP settings it is written to the
// application log instead (visible in Hostinger's runtime logs).
async function deliver(value, env = process.env, log = console) {
  const t = getTransport(env);
  if (!t) {
    log.warn('[enquiry] SMTP not configured, logging instead:', JSON.stringify(value));
    return { delivered: false };
  }
  const rows = Object.entries(value)
    .map(([k, v]) => `<tr><th align="left">${esc(k)}</th><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`)
    .join('');
  await t.sendMail({
    from: env.MAIL_FROM || env.SMTP_USER,
    to: env.LEASING_TO || env.SMTP_USER,
    replyTo: value.email,
    subject: `Leasing enquiry: ${value.brand} (${value.name})`,
    text: Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n'),
    html: `<table cellpadding="6">${rows}</table>`,
  });
  return { delivered: true };
}

module.exports = { validate, deliver };
