'use strict';

const nodemailer = require('nodemailer');

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CATEGORIES = ['fashion', 'fnb', 'beauty', 'leisure', 'services', 'other'];
const SUBJECTS = ['general', 'leasing', 'press', 'careers', 'other'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const lang = (v) => (v === 'ar' ? 'ar' : 'en');

// Leasing enquiry. Returns { ok: true, value } or { ok: false, errors: [...] }.
function validate(body = {}) {
  const value = {
    kind: 'leasing',
    name: clean(body.name, 120),
    brand: clean(body.brand, 160),
    email: clean(body.email, 200),
    phone: clean(body.phone, 40),
    category: clean(body.category, 20) || 'other',
    size: clean(body.size, 4),
    message: clean(body.message, 2000),
    lang: lang(body.lang),
  };
  const errors = [];
  if (!value.name) errors.push('name');
  if (!value.brand) errors.push('brand');
  if (!EMAIL_RE.test(value.email)) errors.push('email');
  if (!CATEGORIES.includes(value.category)) errors.push('category');
  if (!['', 's', 'm', 'l'].includes(value.size)) errors.push('size');
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// General contact form.
function validateContact(body = {}) {
  const value = {
    kind: 'contact',
    name: clean(body.name, 120),
    email: clean(body.email, 200),
    subject: clean(body.subject, 20) || 'general',
    message: clean(body.message, 3000),
    lang: lang(body.lang),
  };
  const errors = [];
  if (!value.name) errors.push('name');
  if (!EMAIL_RE.test(value.email)) errors.push('email');
  if (!SUBJECTS.includes(value.subject)) errors.push('subject');
  if (!value.message) errors.push('message');
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// Newsletter sign-up.
function validateSubscribe(body = {}) {
  const value = { kind: 'subscribe', email: clean(body.email, 200), lang: lang(body.lang) };
  return EMAIL_RE.test(value.email) ? { ok: true, value } : { ok: false, errors: ['email'] };
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

const SUBJECT = {
  leasing: (v) => `Leasing enquiry: ${v.brand} (${v.name})`,
  contact: (v) => `Contact (${v.subject}): ${v.name}`,
  subscribe: (v) => `New subscriber: ${v.email}`,
};

// Sends to LEASING_TO (or CONTACT_TO for contact/subscribe when set). Without
// SMTP settings the message is written to the application log instead.
async function deliver(value, env = process.env, log = console) {
  const t = getTransport(env);
  if (!t) {
    log.warn(`[${value.kind}] SMTP not configured, logging instead:`, JSON.stringify(value));
    return { delivered: false };
  }
  const rows = Object.entries(value)
    .filter(([k]) => k !== 'kind')
    .map(([k, v]) => `<tr><th align="left">${esc(k)}</th><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`)
    .join('');
  await t.sendMail({
    from: env.MAIL_FROM || env.SMTP_USER,
    to: (value.kind !== 'leasing' && env.CONTACT_TO) || env.LEASING_TO || env.SMTP_USER,
    replyTo: value.email,
    subject: SUBJECT[value.kind](value),
    text: Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n'),
    html: `<table cellpadding="6">${rows}</table>`,
  });
  return { delivered: true };
}

module.exports = { validate, validateContact, validateSubscribe, deliver };
