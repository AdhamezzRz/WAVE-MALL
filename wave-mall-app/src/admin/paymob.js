'use strict';

// Paymob (Accept) for Egypt: card checkout through the hosted iframe, mobile wallets, and
// kiosk/aggregator bill references (pay in cash at Aman, Masary and similar outlets).
//
// Flow: auth token → order → payment key → (card) iframe URL | (wallet) redirect URL | (kiosk) bill reference.
// Paymob then calls the "transaction processed" callback (POST JSON, ?hmac=) and sends the payer
// back through the "transaction response" callback (GET, query string with hmac). Both are signed
// with HMAC-SHA512 over a fixed list of fields, concatenated in this exact order.
//
// Configuration (environment): PAYMOB_API_KEY, PAYMOB_HMAC_SECRET, PAYMOB_IFRAME_ID,
// PAYMOB_INTEGRATION_CARD, PAYMOB_INTEGRATION_WALLET, PAYMOB_INTEGRATION_KIOSK, PAYMOB_BASE (optional).

const crypto = require('node:crypto');

const BASE = 'https://accept.paymob.com';

// The fields Paymob signs, in the order it concatenates them.
const HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id',
  'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner',
  'pending', 'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
];

const pick = (obj, dotted) => dotted.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
const str = (v) => (v === undefined || v === null ? '' : typeof v === 'boolean' ? String(v) : String(v));

// The string Paymob signs, from the processed-callback object (obj in the POST body).
function hmacStringFromObject(obj) {
  return HMAC_FIELDS.map((f) => str(pick(obj, f))).join('');
}

// The same string from the response-callback query string, where "order.id" arrives as "order"
// and nested fields keep their dotted names (source_data.pan …).
function hmacStringFromQuery(q) {
  return HMAC_FIELDS.map((f) => str(f === 'order.id' ? q.order : q[f])).join('');
}

const sign = (secret, s) => crypto.createHmac('sha512', String(secret)).update(s, 'utf8').digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '').toLowerCase());
  const y = Buffer.from(String(b || '').toLowerCase());
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
const verifyObject = (secret, obj, hmac) => !!secret && safeEqual(sign(secret, hmacStringFromObject(obj)), hmac);
const verifyQuery = (secret, q, hmac) => !!secret && safeEqual(sign(secret, hmacStringFromQuery(q)), hmac);

// Read a transaction from either callback into one shape.
function normalizeObject(obj) {
  const b = (v) => v === true || v === 'true';
  return {
    txnId: str(obj.id),
    orderId: str(pick(obj, 'order.id')),
    merchantOrderId: str(pick(obj, 'order.merchant_order_id')),
    amountCents: Number(obj.amount_cents),
    currency: str(obj.currency),
    success: b(obj.success),
    pending: b(obj.pending),
    voided: b(obj.is_voided),
    refunded: b(obj.is_refunded),
    subType: str(pick(obj, 'source_data.sub_type')),
    type: str(pick(obj, 'source_data.type')),
    pan: str(pick(obj, 'source_data.pan')),
    message: str(pick(obj, 'data.message') || obj['data.message'] || ''),
  };
}
function normalizeQuery(q) {
  return normalizeObject({
    ...q,
    order: { id: q.order, merchant_order_id: q.merchant_order_id },
    source_data: { pan: q['source_data.pan'], sub_type: q['source_data.sub_type'], type: q['source_data.type'] },
    data: { message: q['data.message'] },
  });
}

function config(env = process.env) {
  const c = {
    apiKey: env.PAYMOB_API_KEY || '',
    hmacSecret: env.PAYMOB_HMAC_SECRET || '',
    iframeId: env.PAYMOB_IFRAME_ID || '',
    integrations: { card: env.PAYMOB_INTEGRATION_CARD || '', wallet: env.PAYMOB_INTEGRATION_WALLET || '', kiosk: env.PAYMOB_INTEGRATION_KIOSK || '' },
    base: (env.PAYMOB_BASE || BASE).replace(/\/$/, ''),
  };
  c.ready = !!(c.apiKey && c.hmacSecret && (c.integrations.card && c.iframeId || c.integrations.wallet || c.integrations.kiosk));
  c.methods = ['card', 'wallet', 'kiosk'].filter((m) => c.integrations[m] && (m !== 'card' || c.iframeId));
  return c;
}

// The API client. fetchImpl is injectable for tests.
function client(cfg, { fetchImpl = globalThis.fetch } = {}) {
  async function call(path, body) {
    const r = await fetchImpl(`${cfg.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    let j = {};
    try {
      j = await r.json();
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new Error(`Paymob ${path} failed (${r.status})${j && (j.detail || j.message) ? `: ${j.detail || j.message}` : ''}`);
    return j;
  }
  // Starts a payment. method: card | wallet | kiosk. Returns { orderId, redirectUrl?, billReference? }.
  async function start({ method, amountCents, merchantOrderId, billing, walletPhone }) {
    const integrationId = Number(cfg.integrations[method]);
    if (!integrationId) throw new Error(`Paymob is not set up for ${method}.`);
    const auth = await call('/api/auth/tokens', { api_key: cfg.apiKey });
    const order = await call('/api/ecommerce/orders', {
      auth_token: auth.token, delivery_needed: false, amount_cents: amountCents, currency: 'EGP', merchant_order_id: merchantOrderId, items: [],
    });
    const na = 'NA';
    const key = await call('/api/acceptance/payment_keys', {
      auth_token: auth.token, amount_cents: amountCents, expiration: 3600, order_id: order.id, currency: 'EGP', integration_id: integrationId, lock_order_when_paid: true,
      billing_data: {
        first_name: billing.first_name || na, last_name: billing.last_name || na, email: billing.email || 'tenant@example.com', phone_number: billing.phone || '+201000000000',
        apartment: na, floor: na, street: na, building: na, shipping_method: na, postal_code: na, city: 'Cairo', country: 'EG', state: na,
      },
    });
    if (method === 'card') return { orderId: String(order.id), redirectUrl: `${cfg.base}/api/acceptance/iframes/${encodeURIComponent(cfg.iframeId)}?payment_token=${encodeURIComponent(key.token)}` };
    if (method === 'wallet') {
      const pay = await call('/api/acceptance/payments/pay', { source: { identifier: walletPhone, subtype: 'WALLET' }, payment_token: key.token });
      const url = pay.redirect_url || pay.iframe_redirection_url;
      if (!url) throw new Error('Paymob did not return a wallet page.');
      return { orderId: String(order.id), redirectUrl: url };
    }
    const pay = await call('/api/acceptance/payments/pay', { source: { identifier: 'AGGREGATOR', subtype: 'AGGREGATOR' }, payment_token: key.token });
    const ref = pay.data && (pay.data.bill_reference || pay.data.billingReference);
    if (!ref) throw new Error('Paymob did not return a payment reference.');
    return { orderId: String(order.id), billReference: String(ref) };
  }
  return { start };
}

module.exports = { HMAC_FIELDS, hmacStringFromObject, hmacStringFromQuery, sign, verifyObject, verifyQuery, normalizeObject, normalizeQuery, config, client };
