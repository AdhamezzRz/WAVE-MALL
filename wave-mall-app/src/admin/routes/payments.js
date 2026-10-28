'use strict';

// Online payments and e-invoicing.
//
// Payments: tenants pay an invoice from the portal, or from a payment link the office sends (/pay/…,
// no sign-in), by card, mobile wallet or cash at a payment outlet, through Paymob Accept. Paymob's
// signed callbacks (/payments/paymob/…) record the payment through the billing service, once.
// PAYMENTS_MODE=sandbox (and the sample data, always) uses a pretend checkout instead: no money moves.
//
// E-invoicing: each invoice becomes an Egyptian Tax Authority (ETA) document (eta.js), checked here,
// signed by the signing service beside the company's token (ETA_SIGNER_URL) and submitted.
//
// Hooks used: h.invoiceCards (cards on the office invoice page), h.integrationCards, h.portal.
// Provides: h.payments { canPayOnline, payCard, adminCard, providerFor, begin, settle }, h.receiptDoc, h.eta.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const paymob = require('../paymob');
const eta = require('../eta');

const { t: tr, tn, tx } = i18n;

const SCHEMA_PAY = `
  CREATE TABLE payment_links (
    id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, reveal TEXT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, amount REAL,
    expires_at TEXT NOT NULL, sent_to TEXT, cancelled INTEGER NOT NULL DEFAULT 0, opened_at TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX payment_links_invoice ON payment_links(invoice_id);
  CREATE TABLE payment_intents (
    id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, link_id INTEGER REFERENCES payment_links(id) ON DELETE SET NULL,
    amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'EGP', method TEXT NOT NULL, provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created', provider_order_id TEXT, merchant_order_id TEXT, provider_txn_id TEXT UNIQUE,
    redirect_url TEXT, bill_reference TEXT, error TEXT, source TEXT NOT NULL DEFAULT 'portal',
    portal_user_id INTEGER, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
    expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX payment_intents_invoice ON payment_intents(invoice_id);
  CREATE INDEX payment_intents_order ON payment_intents(provider, provider_order_id);
  CREATE TABLE payment_events (
    id INTEGER PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL, txn_id TEXT, intent_id INTEGER,
    payload TEXT, hmac_ok INTEGER NOT NULL DEFAULT 0, result TEXT, created_at TEXT NOT NULL
  );
`;

const SCHEMA_ETA = `
  CREATE TABLE eta_documents (
    id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE CASCADE,
    internal_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'prepared', document TEXT, canonical_sha256 TEXT,
    uuid TEXT, long_id TEXT, submission_id TEXT, errors TEXT,
    submitted_at TEXT, checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX eta_documents_status ON eta_documents(status);
  CREATE TABLE eta_log (
    id INTEGER PRIMARY KEY, eta_document_id INTEGER REFERENCES eta_documents(id) ON DELETE CASCADE,
    action TEXT NOT NULL, detail TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
  );
`;

// how each checkout method is recorded on the payment (M.PAY_METHODS keys)
const PAY_METHOD = { card: 'online', wallet: 'wallet', kiosk: 'fawry' };
const ICON = { card: 'wallet', wallet: 'phone', kiosk: 'store' };
const LINK_DAYS = 14;
// invoices the ETA never sees: refundable deposits and fit-out deposits are not sales
const ETA_SKIP = ['deposit', 'fitout'];

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const now = () => new Date().toISOString();
const tok = () => crypto.randomBytes(32).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const json = (s, d = null) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

module.exports = function payments(router, h) {
  const { db, ui, M } = h;
  db.ensure('payments-1', SCHEMA_PAY);
  db.ensure('eta-1', SCHEMA_ETA);
  const env = h.env || process.env;
  const R = h.auth.requireRole;
  const cfg = () => paymob.config(env);
  const sandboxMode = () => env.PAYMENTS_MODE === 'sandbox';
  if (sandboxMode() && process.env.NODE_ENV === 'production') console.warn('[payments] PAYMENTS_MODE=sandbox: online payments are pretend payments; no money moves.');
  const mailReady = () => !!h.mail && typeof h.mail.send === 'function' && (typeof h.mail.configured !== 'function' || h.mail.configured());
  const fetchImpl = () => (h.payments && h.payments.fetchImpl) || globalThis.fetch;
  // who may see online payments and e-invoicing in the office: managers and finance
  const canMoney = (req) => h.can(req, 'manager') || h.canFinance(req);
  const RM = (req, res, next) => (canMoney(req) ? next() : h.auth.denied(req, res));

  // ================= payments =================

  // Which checkout an invoice gets: sample invoices and sandbox mode use the pretend one; else Paymob
  // once it is set up; else none (tenants see the bank and InstaPay details instead).
  const providerFor = (inv) => (inv.demo || sandboxMode() ? 'sandbox' : cfg().ready ? 'paymob' : null);
  const methodsFor = (provider) => (provider === 'sandbox' ? ['card', 'wallet', 'kiosk'] : provider === 'paymob' ? cfg().methods : []);
  const outstanding = (inv) => r2(inv.total - inv.paid);
  const canPayOnline = (inv) => ['open', 'partial'].includes(inv.status) && outstanding(inv) >= 1 && !!providerFor(inv) && (db.setting('currency') || 'EGP') === 'EGP';
  const methodLabel = (m) => ({ card: tr('por|Bank card'), wallet: tr('por|Mobile wallet'), kiosk: tr('por|Cash at a payment outlet') })[m] || m;
  const methodHint = (m) => ({ card: tr('por|Visa, Mastercard or Meeza'), wallet: tr('por|Vodafone Cash, Orange, Etisalat, WE Pay'), kiosk: tr('por|Pay at Aman, Masary or another outlet with a reference number') })[m] || '';
  const STATUS = () => ({
    created: [tr('por|Started'), 'mute'], pending: [tr('por|Waiting'), 'amber'], paid: [tr('por|Paid'), 'ok'], failed: [tr('por|Failed'), 'rose'],
    expired: [tr('offer|Expired'), 'mute'], cancelled: [tr('por|Cancelled'), 'mute'], refunded: [tr('por|Refunded'), 'mute'], paid_unapplied: [tr('por|Paid, not applied'), 'rose'],
  });
  // what happened to a message from Paymob (payment_events.result)
  const resultLabel = (x) => {
    const map = {
      'bad signature': tr('por|Rejected: bad signature'), 'unknown order': tr('por|Unknown order'), 'currency mismatch': tr('por|Rejected: wrong currency'),
      'amount mismatch': tr('por|Rejected: wrong amount'), 'order mismatch': tr('por|Rejected: wrong order'), refunded: tr('por|Refunded'), paid: tr('por|Paid'),
      duplicate: tr('por|Already recorded'), 'paid, not applied': tr('por|Paid, not applied'), pending: tr('por|Waiting'), declined: tr('por|Declined'),
    };
    return map[x] || (String(x).startsWith('ignored') ? tr('por|Ignored') : String(x || ''));
  };
  const statusBadge = (s) => ui.badge(s, (STATUS()[s] || [s])[0], (STATUS()[s] || [])[1]);

  // The "Pay online" card: on the portal invoice page and on a payment link page.
  function payCard(req, inv, { csrf = null, action, amount = null } = {}) {
    if (!canPayOnline(inv)) return '';
    const provider = providerFor(inv);
    const due = amount ? r2(Math.min(amount, outstanding(inv))) : outstanding(inv);
    const methods = methodsFor(provider);
    if (!methods.length) return '';
    const waiting = db.get("SELECT * FROM payment_intents WHERE invoice_id = ? AND method = 'kiosk' AND status = 'pending' AND bill_reference IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 1", inv.id, now());
    const phone = req.tenant ? req.tenant.phone || '' : '';
    return ui.card(tr('por|Pay online'), `${waiting ? `<div class="alert alert--warn"><p>${ui.esc(tr('por|Your payment reference'))}: <b class="ltr payref">${ui.esc(waiting.bill_reference)}</b></p><p class="small">${ui.esc(tr('por|Pay {amount} at any Aman or Masary outlet with this reference. We confirm it here automatically.', { amount: ui.money(waiting.amount) }))}</p></div>` : ''}
<form method="post" action="${action}" class="stack paycard">${csrf ? ui.hidden(csrf) : ''}
  <p class="paycard__amt"><small>${ui.esc(tr('por|Amount to pay'))}</small><b>${ui.money(due)}</b></p>
  <fieldset class="paymethods"><legend class="f__l">${ui.esc(tr('por|How would you like to pay?'))}</legend>${methods.map((m, n) => `<label class="paymethod"><input type="radio" name="method" value="${m}"${n === 0 ? ' checked' : ''}>${ui.icon(ICON[m])}<span><b>${ui.esc(methodLabel(m))}</b><small>${ui.esc(methodHint(m))}</small></span></label>`).join('')}</fieldset>
  ${methods.includes('wallet') ? ui.input('wallet_phone', tr('por|Wallet mobile number'), phone, { type: 'tel', placeholder: '01XXXXXXXXX', hint: tr('por|Only for mobile wallet payments.'), attrs: { inputmode: 'tel', autocomplete: 'tel' } }) : ''}
  ${ui.btn(ui.esc(tr('por|Pay {amount}', { amount: ui.money(due) })), { cls: 'btn--primary btn--block', ic: 'shield' })}
  <p class="muted small paycard__note">${provider === 'sandbox' ? `<b>${ui.esc(tr('por|Sandbox'))}</b> · ${ui.esc(tr('por|A pretend checkout for testing: no money moves.'))}` : ui.esc(tr('por|You pay on Paymob’s secure page. Card details never reach The Wave.'))}</p>
</form>`, { sub: ui.esc(tr('por|Invoice {ref}', { ref: inv.ref })) });
  }

  // Starts a payment and returns where to send the payer next.
  async function begin(inv, { method, walletPhone = '', source = 'portal', portalUser = null, link = null, user = null, lang = 'en' }) {
    const provider = providerFor(inv);
    if (!canPayOnline(inv)) throw new Error('Online payment is not available for this invoice.');
    if (!methodsFor(provider).includes(method)) throw new Error('Choose how you want to pay.');
    const amount = link && link.amount ? r2(Math.min(link.amount, outstanding(inv))) : outstanding(inv);
    let phone = null;
    if (method === 'wallet') {
      phone = String(walletPhone || '').replace(/[^\d]/g, '').replace(/^20(?=1)/, '0');
      if (!/^01[0-25]\d{8}$/.test(phone)) throw new Error('Enter the wallet’s mobile number: 11 digits starting with 01.');
    }
    const token = tok();
    const t = now();
    const life = method === 'kiosk' ? 3 * 86400000 : 60 * 60 * 1000;
    const id = Number(db.run(
      `INSERT INTO payment_intents (token, invoice_id, link_id, amount, currency, method, provider, status, source, portal_user_id, created_by, expires_at, created_at, updated_at, demo)
       VALUES (?, ?, ?, ?, 'EGP', ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?)`,
      token, inv.id, link ? link.id : null, amount, method, provider, source, portalUser ? portalUser.id : null, user ? user.id : null,
      new Date(Date.now() + life).toISOString(), t, t, inv.demo ? 1 : 0,
    ).lastInsertRowid);
    const q = `?lang=${lang === 'ar' ? 'ar' : 'en'}`;
    if (provider === 'sandbox') {
      db.run("UPDATE payment_intents SET status = 'pending', updated_at = ? WHERE id = ?", now(), id);
      return `/pay/sandbox/${token}${q}`;
    }
    const brand = inv.brand_id ? db.get('SELECT * FROM brands WHERE id = ?', inv.brand_id) : null;
    const who = String((portalUser && portalUser.name) || (brand && (brand.store_manager || brand.name)) || inv.customer || 'Tenant').trim().split(/\s+/);
    const merchant = `WAVE-${id}-${token.slice(0, 6)}`;
    try {
      const r = await paymob.client(cfg(), { fetchImpl: fetchImpl() }).start({
        method, amountCents: Math.round(amount * 100), merchantOrderId: merchant, walletPhone: phone,
        billing: {
          first_name: who[0], last_name: who.slice(1).join(' ') || who[0],
          email: (portalUser && portalUser.email) || (brand && brand.store_email) || db.setting('leasing_email'),
          phone: phone || (portalUser && portalUser.phone) || (brand && brand.store_phone) || '',
        },
      });
      db.run("UPDATE payment_intents SET status = 'pending', provider_order_id = ?, merchant_order_id = ?, redirect_url = ?, bill_reference = ?, updated_at = ? WHERE id = ?",
        r.orderId, merchant, r.redirectUrl || null, r.billReference || null, now(), id);
    } catch (err) {
      db.run("UPDATE payment_intents SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", String(err.message).slice(0, 300), now(), id);
      console.error('[payments] Paymob:', err.message);
      throw new Error('The payment service is not answering. Try again in a few minutes.');
    }
    return `/pay/checkout/${token}${q}`;
  }

  // Money confirmed by the provider: record it against the invoice, once.
  function settle(intent, { txnId, provider }) {
    const out = db.tx(() => {
      const cur = db.get('SELECT * FROM payment_intents WHERE id = ?', intent.id);
      if (['paid', 'paid_unapplied', 'refunded'].includes(cur.status)) return { already: true, intent: cur };
      if (db.get('SELECT id FROM payment_intents WHERE provider_txn_id = ?', String(txnId))) return { already: true, intent: cur };
      let payment = null;
      let status = 'paid';
      let error = null;
      try {
        const r = h.billing.recordPayment({
          invoice_id: cur.invoice_id, amount: cur.amount, date: M.today(), method: PAY_METHOD[cur.method],
          reference: `${provider === 'sandbox' ? 'Sandbox' : 'Paymob'} ${txnId}`, provider, provider_ref: String(txnId),
          note: cur.source === 'link' ? 'Paid online through a payment link' : 'Paid online through the tenant portal', demo: cur.demo,
        });
        payment = r.payment;
        if (payment.amount < cur.amount - 0.005) error = `Received ${cur.amount}; ${payment.amount} applied to the invoice. Refund or credit the rest.`;
      } catch (err) {
        // the invoice was paid another way or voided meanwhile: the money is in, but not applied
        status = 'paid_unapplied';
        error = err.message;
      }
      db.run('UPDATE payment_intents SET status = ?, provider_txn_id = ?, payment_id = ?, error = ?, updated_at = ? WHERE id = ?', status, String(txnId), payment ? payment.id : null, error, now(), cur.id);
      return { intent: db.get('SELECT * FROM payment_intents WHERE id = ?', cur.id), payment };
    });
    if (out.payment) {
      db.audit(null, 'Online payment received', 'invoice', out.intent.invoice_id, `${out.payment.ref} · ${out.payment.amount} · ${out.payment.reference}`);
      notifyPaid(out.intent, out.payment);
    } else if (!out.already) {
      db.audit(null, 'Online payment could not be applied', 'invoice', out.intent.invoice_id, out.intent.error);
    }
    return out;
  }
  // a confirmation email to the tenant who paid in the portal (when email is set up)
  function notifyPaid(intent, payment) {
    if (intent.demo || !intent.portal_user_id || !mailReady()) return;
    const u = db.get('SELECT * FROM portal_users WHERE id = ?', intent.portal_user_id);
    if (!u) return;
    const inv = db.get('SELECT ref FROM invoices WHERE id = ?', intent.invoice_id);
    i18n.run(u.lang || 'en', () => {
      try {
        Promise.resolve(h.mail.send({
          to: u.email, tag: 'portal',
          subject: tr('por|Payment received: {ref}', { ref: payment.ref }),
          text: tr('por|Thank you. We received {amount} for invoice {invoice}. Your receipt {ref} is in the tenant portal.', { amount: ui.money(payment.amount), invoice: inv ? inv.ref : '', ref: payment.ref }),
        })).catch((err) => console.error('[payments] receipt email failed:', err.message));
      } catch (err) {
        console.error('[payments] receipt email failed:', err.message);
      }
    });
  }

  // A transaction reported by Paymob (callback or return): check it against the intent, then act.
  function apply(t) {
    const intent = db.get("SELECT * FROM payment_intents WHERE provider = 'paymob' AND provider_order_id = ?", t.orderId);
    if (!intent) return { result: 'unknown order' };
    const mismatch = (what) => {
      db.run('UPDATE payment_intents SET error = ?, updated_at = ? WHERE id = ?', `Paymob reported a different ${what}; nothing recorded.`, now(), intent.id);
      db.audit(null, 'Online payment rejected', 'invoice', intent.invoice_id, `Paymob reported a different ${what}; nothing recorded.`);
      return { intent, result: `${what} mismatch` };
    };
    if (t.currency && t.currency !== intent.currency) return mismatch('currency');
    if (t.amountCents !== Math.round(intent.amount * 100)) return mismatch('amount');
    if (t.merchantOrderId && intent.merchant_order_id && t.merchantOrderId !== intent.merchant_order_id) return mismatch('order');
    if ((t.refunded || t.voided) && intent.payment_id && intent.status === 'paid') {
      try {
        h.billing.reversePayment(intent.payment_id, { note: 'Refunded through Paymob' });
      } catch {
        /* already reversed */
      }
      db.run("UPDATE payment_intents SET status = 'refunded', updated_at = ? WHERE id = ?", now(), intent.id);
      return { intent, result: 'refunded' };
    }
    if (t.success && !t.pending && !t.voided && !t.refunded) {
      const out = settle(intent, { txnId: t.txnId, provider: 'paymob' });
      return { intent: out.intent, result: out.already ? 'duplicate' : out.payment ? 'paid' : 'paid, not applied' };
    }
    if (t.pending) return { intent, result: 'pending' };
    if (!['paid', 'paid_unapplied', 'refunded'].includes(intent.status)) {
      db.run("UPDATE payment_intents SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", String(t.message || 'Declined').slice(0, 200), now(), intent.id);
    }
    return { intent, result: 'declined' };
  }
  const logEvent = (kind, txnId, payload, ok, result, intentId = null) => db.run(
    'INSERT INTO payment_events (provider, kind, txn_id, intent_id, payload, hmac_ok, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'paymob', kind, txnId ? String(txnId) : null, intentId, JSON.stringify(payload || {}).slice(0, 20000), ok ? 1 : 0, result, now(),
  );

  // ---------- public: Paymob callbacks ----------
  const cb = express.Router();
  h.public.use('/payments/paymob', cb);
  // "Transaction processed": Paymob's server calls this (JSON body, ?hmac=)
  cb.post('/callback', express.json({ limit: '256kb' }), (req, res) => {
    const obj = req.body && req.body.obj;
    const ok = !!obj && typeof obj === 'object' && paymob.verifyObject(cfg().hmacSecret, obj, req.query.hmac);
    if (!ok) {
      logEvent('callback', obj && obj.id, req.body, false, 'bad signature');
      return res.status(401).json({ ok: false });
    }
    if (req.body.type && req.body.type !== 'TRANSACTION') {
      logEvent('callback', obj.id, req.body, true, `ignored ${req.body.type}`);
      return res.json({ ok: true });
    }
    const out = apply(paymob.normalizeObject(obj));
    logEvent('callback', obj.id, req.body, true, out.result, out.intent ? out.intent.id : null);
    res.json({ ok: true, result: out.result });
  });
  // "Transaction response": the payer's browser comes back here (query string, signed)
  cb.get('/return', (req, res) => {
    const q = req.query;
    const ok = paymob.verifyQuery(cfg().hmacSecret, q, q.hmac);
    let intent = null;
    if (ok) {
      const out = apply(paymob.normalizeQuery(q));
      logEvent('return', q.id, q, true, out.result, out.intent ? out.intent.id : null);
      intent = out.intent || null;
    } else {
      logEvent('return', q.id, q, false, 'bad signature');
    }
    if (!intent) return res.redirect(303, '/pay/result/unknown');
    res.redirect(303, `/pay/result/${intent.token}`);
  });

  // ---------- public: checkout pages and payment links (/pay) ----------
  const pay = express.Router();
  h.public.use('/pay', pay);
  pay.use(express.urlencoded({ extended: false, limit: '16kb' }));
  pay.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const q = String(req.query.lang || req.body && req.body.lang || '');
    req.lang = q === 'ar' || q === 'en' ? q : /^ar\b/i.test(String(req.get('accept-language') || '')) ? 'ar' : 'en';
    i18n.run(req.lang, next);
  });
  const payLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const intentBy = (token) => (/^[\w-]{20,80}$/.test(String(token)) ? db.get('SELECT * FROM payment_intents WHERE token = ?', String(token)) : null);
  const invoiceBy = (id) => db.get('SELECT i.*, COALESCE(b.name, i.customer) party FROM invoices i LEFT JOIN brands b ON b.id = i.brand_id WHERE i.id = ?', id);
  // the page around checkout steps: logo, language, no navigation
  function payPage(req, res, { title, body, status = 200, refresh = null }) {
    ui.setCurrency(db.setting('currency'));
    const other = req.lang === 'ar' ? 'en' : 'ar';
    const self = req.originalUrl.replace(/([?&])lang=(en|ar)(&|$)/, '$1').replace(/[?&]$/, '');
    res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="${req.lang}" dir="${req.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
${refresh ? `<meta http-equiv="refresh" content="${ui.esc(refresh)}">` : ''}
<title>${ui.esc(title)} · The Wave</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ui.ASSETS.css}">
</head>
<body class="adm portal paypage" data-lang="${req.lang}">
<main class="paywrap">
  <header class="paywrap__head">${ui.logo('paywrap__logo')}<a class="langbtn" href="${ui.esc(self)}${self.includes('?') ? '&' : '?'}lang=${other}" lang="${other}">${ui.icon('globe')}<span>${other === 'ar' ? 'العربية' : 'English'}</span></a></header>
  ${body}
  <p class="paywrap__foot">${ui.icon('shield')}<span>${ui.esc(tr('por|The Wave · North 90, New Cairo'))}</span></p>
</main>
<script src="/admin/admin.js?v=${ui.ASSETS.js}" defer></script>
</body>
</html>`);
  }
  const summary = (inv) => `<dl class="dl paysum">
    <div><dt>${ui.esc(tr('Invoice'))}</dt><dd><b>${ui.esc(inv.ref)}</b></dd></div>
    <div><dt>${ui.esc(tr('por|For'))}</dt><dd>${ui.esc(inv.party || '')}</dd></div>
    <div><dt>${ui.esc(tr('Due'))}</dt><dd>${ui.date(inv.due_date)}</dd></div>
    <div><dt>${ui.esc(tr('Outstanding'))}</dt><dd><b>${ui.money(outstanding(inv))}</b></dd></div>
  </dl>`;
  const resultUrl = (i, req) => `/pay/result/${i.token}?lang=${req.lang}`;

  // checkout: off to Paymob (card, wallet) or the outlet reference (kiosk)
  pay.get('/checkout/:token', (req, res, next) => {
    const i = intentBy(req.params.token);
    if (!i || i.provider !== 'paymob') return next();
    if (i.status !== 'pending') return res.redirect(303, resultUrl(i, req));
    const inv = invoiceBy(i.invoice_id);
    if (i.bill_reference) {
      return payPage(req, res, {
        title: tr('por|Your payment reference'),
        body: `<section class="card paycard"><div class="card__body stack"><p class="eyebrow">${ui.esc(tr('por|Cash at a payment outlet'))}</p><h1>${ui.esc(tr('por|Your payment reference'))}</h1><p class="payref payref--big ltr">${ui.esc(i.bill_reference)}</p><p>${ui.esc(tr('por|Pay {amount} at any Aman or Masary outlet with this reference. We confirm it here automatically.', { amount: ui.money(i.amount) }))}</p><p class="muted small">${ui.esc(tr('por|The reference works until {date}.', { date: ui.date(i.expires_at) }))}</p>${summary(inv)}</div></section>`,
      });
    }
    if (!i.redirect_url || !/^https:\/\//.test(i.redirect_url)) return res.redirect(303, resultUrl(i, req));
    payPage(req, res, {
      title: tr('por|Secure payment'), refresh: `1;url=${i.redirect_url}`,
      body: `<section class="card paycard"><div class="card__body stack"><p class="eyebrow">${ui.esc(tr('por|Secure payment'))}</p><h1>${ui.esc(tr('por|Taking you to Paymob…'))}</h1><p>${ui.esc(tr('por|You will pay {amount} on Paymob’s secure page, then come back here.', { amount: ui.money(i.amount) }))}</p>${summary(inv)}<a class="btn btn--primary btn--block" href="${ui.esc(i.redirect_url)}" rel="noreferrer">${ui.icon('shield')}<span>${ui.esc(tr('por|Continue to payment'))}</span></a></div></section>`,
    });
  });

  // the pretend checkout (sandbox mode and the sample data)
  pay.get('/sandbox/:token', (req, res, next) => {
    const i = intentBy(req.params.token);
    if (!i || i.provider !== 'sandbox') return next();
    if (i.status !== 'pending') return res.redirect(303, resultUrl(i, req));
    const inv = invoiceBy(i.invoice_id);
    const form = (decision, label, cls) => `<form method="post" action="/pay/sandbox/${i.token}"><input type="hidden" name="lang" value="${req.lang}"><input type="hidden" name="decision" value="${decision}">${ui.btn(ui.esc(label), { cls: `${cls} btn--block` })}</form>`;
    payPage(req, res, {
      title: tr('por|Sandbox checkout'),
      body: `<section class="card paycard paycard--sandbox"><div class="card__body stack">
  <p class="eyebrow">${ui.esc(tr('por|Sandbox'))} · ${ui.esc(methodLabel(i.method))}</p>
  <h1>${ui.money(i.amount)}</h1>
  <p class="alert alert--warn">${ui.esc(tr('por|A pretend checkout for testing: no money moves.'))}</p>
  ${summary(inv)}
  <div class="row row--split">${form('approve', tr('por|Approve the payment'), 'btn--primary')}${form('decline', tr('por|Decline'), 'btn--ghost')}</div>
</div></section>`,
    });
  });
  pay.post('/sandbox/:token', payLimit, (req, res, next) => {
    const i = intentBy(req.params.token);
    if (!i || i.provider !== 'sandbox') return next();
    if (i.status === 'pending') {
      if (req.body.decision === 'approve') settle(i, { txnId: `SBX-${i.id}-${Date.now().toString(36)}`, provider: 'sandbox' });
      else db.run("UPDATE payment_intents SET status = 'failed', error = 'Declined in the sandbox', updated_at = ? WHERE id = ?", now(), i.id);
    }
    res.redirect(303, resultUrl(i, req));
  });

  // where every checkout ends
  pay.get('/result/:token', (req, res) => {
    const i = intentBy(req.params.token);
    if (!i) {
      return payPage(req, res, { status: 404, title: tr('por|Payment'), body: `<section class="card paycard"><div class="card__body stack"><h1>${ui.esc(tr('por|We could not find this payment.'))}</h1><p class="muted">${ui.esc(tr('por|If money left your account, the leasing office will confirm it. Nothing is charged twice.'))}</p></div></section>` });
    }
    const inv = invoiceBy(i.invoice_id);
    const p = i.payment_id ? db.get('SELECT * FROM payments WHERE id = ?', i.payment_id) : null;
    const portalLink = i.source === 'portal' ? `<a class="btn btn--primary btn--block" href="/portal/invoices/${i.invoice_id}">${ui.icon('arrow')}<span>${ui.esc(tr('por|Back to the portal'))}</span></a>` : '';
    const again = i.source === 'portal' ? `/portal/invoices/${i.invoice_id}#pay` : null;
    let head;
    let text;
    let refresh = null;
    if (i.status === 'paid' || i.status === 'paid_unapplied') {
      head = `<span class="payok">${ui.icon('check')}</span><h1>${ui.esc(tr('por|Payment received'))}</h1>`;
      text = p ? tr('por|Thank you. {amount} is recorded against invoice {invoice}. Receipt {ref}.', { amount: ui.money(p.amount), invoice: inv.ref, ref: p.ref }) : tr('por|Thank you. The leasing office will confirm your payment shortly.');
    } else if (i.status === 'pending' || i.status === 'created') {
      head = `<h1>${ui.esc(tr('por|Waiting for confirmation…'))}</h1>`;
      text = tr('por|This page refreshes by itself. You can also close it: the payment is recorded as soon as it is confirmed.');
      refresh = '5';
    } else {
      head = `<h1>${ui.esc(tr('por|The payment did not go through'))}</h1>`;
      text = tr('por|Nothing was charged. You can try again or choose another way to pay.');
    }
    payPage(req, res, {
      title: tr('por|Payment'), refresh,
      body: `<section class="card paycard"><div class="card__body stack">${head}<p>${ui.esc(text)}</p>${summary(inv)}${p && i.source === 'link' ? `<a class="btn btn--ghost btn--block" href="/pay/receipt/${i.token}?lang=${req.lang}" target="_blank">${ui.icon('print')}<span>${ui.esc(tr('por|Print the receipt'))}</span></a>` : ''}${portalLink}${again && !['paid', 'paid_unapplied', 'pending', 'created'].includes(i.status) ? `<a class="btn btn--ghost btn--block" href="${again}">${ui.esc(tr('por|Try again'))}</a>` : ''}</div></section>`,
    });
  });
  // the receipt after paying by link (the token is the proof of having paid)
  pay.get('/receipt/:token', (req, res, next) => {
    const i = intentBy(req.params.token);
    if (!i || !i.payment_id || !h.receiptDoc) return next();
    res.type('html').send(h.receiptDoc(i.payment_id, { lang: req.lang, back: null, self: `/pay/receipt/${i.token}` }));
  });

  // a payment link: no sign-in, the token in the URL is the key
  const linkBy = (token) => (/^[\w-]{30,80}$/.test(String(token)) ? db.get('SELECT * FROM payment_links WHERE token_hash = ?', sha(token)) : null);
  function linkPage(req, res, l, error = '') {
    const inv = invoiceBy(l.invoice_id);
    const gone = l.cancelled || l.expires_at <= now() || !['open', 'partial'].includes(inv.status);
    if (gone) {
      const paid = inv.status === 'paid';
      return payPage(req, res, {
        status: paid ? 200 : 410, title: tr('por|Payment link'),
        body: `<section class="card paycard"><div class="card__body stack">${paid ? `<span class="payok">${ui.icon('check')}</span><h1>${ui.esc(tr('por|This invoice is paid. Thank you.'))}</h1>` : `<h1>${ui.esc(tr('por|This payment link has expired.'))}</h1><p class="muted">${ui.esc(tr('por|Ask the leasing office for a new link.'))}</p>`}${summary(inv)}</div></section>`,
      });
    }
    if (!l.opened_at) db.run('UPDATE payment_links SET opened_at = ? WHERE id = ?', now(), l.id);
    const card = canPayOnline(inv) ? payCard(req, inv, { action: `/pay/${req.params.token}`, amount: l.amount }) : `<p class="alert alert--warn">${ui.esc(tr('por|Online payment is not available right now. Use the bank details below.'))}</p>`;
    payPage(req, res, {
      title: tr('por|Pay invoice {ref}', { ref: inv.ref }),
      body: `<section class="payhead"><p class="eyebrow">${ui.esc(tr('por|Payment request'))}</p><h1>${ui.esc(inv.party || '')}</h1>${summary(inv)}</section>${error ? `<p class="alert alert--error">${ui.esc(error)}</p>` : ''}${card}${instructions()}`,
    });
  }
  function instructions() {
    const s = db.settings();
    const rows = [
      s.portal_instapay ? [tr('pay|InstaPay'), `<span class="ltr">${ui.esc(s.portal_instapay)}</span>${s.portal_instapay_name ? ` · ${ui.esc(s.portal_instapay_name)}` : ''}`] : null,
      s.portal_bank ? [tr('pay|Bank transfer'), `${ui.esc(s.portal_bank)}${s.portal_bank_account ? ` · ${ui.esc(s.portal_bank_account)}` : ''}${s.portal_iban ? `<br><span class="ltr">${ui.esc(s.portal_iban)}</span>` : ''}`] : null,
    ].filter(Boolean);
    return rows.length ? ui.card(tr('por|Other ways to pay'), `<dl class="dl">${rows.map(([k, v]) => `<div><dt>${ui.esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`) : '';
  }
  pay.get('/:token', (req, res, next) => {
    const l = linkBy(req.params.token);
    if (!l) return next();
    linkPage(req, res, l);
  });
  pay.post('/:token', payLimit, async (req, res, next) => {
    const l = linkBy(req.params.token);
    if (!l) return next();
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', l.invoice_id);
    if (l.cancelled || l.expires_at <= now()) return linkPage(req, res, l);
    try {
      res.redirect(303, await begin(inv, { method: req.body.method, walletPhone: req.body.wallet_phone, source: 'link', link: l, lang: req.lang }));
    } catch (err) {
      linkPage(req, res, l, tr(err.message));
    }
  });

  // ---------- the portal: pay from an invoice ----------
  if (h.portal) {
    h.portal.router.post('/invoices/:id/pay', h.portal.requireTenant, payLimit, async (req, res, next) => {
      const inv = db.get("SELECT * FROM invoices WHERE id = ? AND brand_id = ? AND status IN ('open','partial')", h.int(req.params.id), h.portal.brandId(req));
      if (!inv) return next();
      try {
        res.redirect(303, await begin(inv, { method: req.body.method, walletPhone: req.body.wallet_phone, source: 'portal', portalUser: req.tenant, lang: req.lang }));
      } catch (err) {
        h.portal.back(req, res, `/portal/invoices/${inv.id}`, 'error', tr(err.message));
      }
    });
  }

  // ---------- receipts ----------
  // h.receiptDoc(paymentId, { lang, back, self }) → a printable receipt page
  h.receiptDoc = (id, { lang = 'en', back = null, self = `/admin/payments/${id}/receipt` } = {}) => {
    const p = db.get('SELECT p.*, i.ref invoice_ref, i.total invoice_total, i.paid invoice_paid, i.status invoice_status, COALESCE(b.name, i.customer) party, b.legal_name FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = ?', id);
    if (!p) return null;
    return i18n.run(lang, () => {
      ui.setCurrency(db.setting('currency'));
      const s = db.settings();
      const sw = lang === 'ar' ? `<a class="langbtn" href="${self}?doc=en" lang="en">${ui.icon('globe')}<span>English</span></a>` : `<a class="langbtn" href="${self}?doc=ar" lang="ar">${ui.icon('globe')}<span>العربية</span></a>`;
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button>${back ? `<a class="btn btn--ghost" href="${back}">${tr('Back')}</a>` : ''}${sw}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${ui.esc(tr('por|Receipt'))}</p><p class="doc__ref">${tr('{ref} · issued {date}', { ref: `<bdi>${ui.esc(p.ref)}</bdi>`, date: ui.date(p.date) })}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${ui.esc(tr('por|Received from'))}</p><h1>${ui.esc(p.legal_name || p.party || '')}</h1>${p.legal_name && p.party && p.legal_name !== p.party ? `<p>${ui.esc(p.party)}</p>` : ''}</section>
  <table class="doc__t"><thead><tr><th>${tr('Description')}</th><th class="num">${tr('Amount ({cur})', { cur: ui.esc(ui.curLabel()) })}</th></tr></thead>
  <tbody><tr><td>${p.invoice_ref ? ui.esc(tr('por|Payment against invoice {ref}', { ref: p.invoice_ref })) : ui.esc(tr('por|Payment'))}<br><small>${ui.esc(M.PAY_METHODS[p.method] || p.method || '')}${p.reference ? ` · <bdi>${ui.esc(p.reference)}</bdi>` : ''}</small></td><td class="num">${ui.money(p.amount, { cur: false })}</td></tr></tbody>
  <tfoot><tr><td><b>${ui.esc(tr('por|Amount received'))}</b></td><td class="num"><b>${ui.money(p.amount)}</b></td></tr>${p.invoice_ref ? `<tr><td>${ui.esc(tr('por|Balance left on the invoice'))}</td><td class="num">${ui.money(Math.max(0, r2(p.invoice_total - p.invoice_paid)), { cur: false })}</td></tr>` : ''}</tfoot></table>
  ${p.status === 'reversed' ? `<p class="alert alert--error">${ui.esc(tr('por|This payment was reversed.'))}</p>` : ''}
  <p class="doc__small">${ui.esc(tr('por|This receipt confirms the amount above was received by {name}.', { name: tx(s.legal_name) }))}</p>
  <p class="doc__foot">${ui.esc(tx(s.legal_name))} · ${ui.esc(tx(s.address))} · ${ui.esc(s.leasing_email)}</p>
</main>`;
      return ui.bare({ title: tr('por|Receipt {ref}', { ref: p.ref }), body, cls: 'print' });
    });
  };
  router.get('/payments/:id/receipt', (req, res, next) => {
    const html = h.receiptDoc(h.int(req.params.id), { lang: ['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en', back: h.safeBack(req, '/admin/billing') });
    if (!html) return next();
    res.type('html').send(html);
  });

  // ---------- the office: links, the invoice card, the online payments page ----------
  function revealLink(req) {
    const id = h.int(req.query.plink);
    if (!id) return '';
    const l = db.get('SELECT * FROM payment_links WHERE id = ? AND reveal IS NOT NULL', id);
    if (!l) return '';
    db.run('UPDATE payment_links SET reveal = NULL WHERE id = ?', l.id);
    const url = `${(env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/pay/${l.reveal}`;
    return `<div class="alert alert--ok plink"><p>${ui.esc(tr('por|Payment link, valid until {date}:', { date: ui.date(l.expires_at) }))}</p><input readonly value="${ui.esc(url)}" class="ltr" data-select><p class="small">${ui.esc(tr('por|Copy it now: it is not shown again.'))}</p></div>`;
  }
  router.post('/invoices/:id/payment-link', RM, async (req, res, next) => {
    const inv = invoiceBy(h.int(req.params.id));
    if (!inv) return next();
    const back = `/admin/invoices/${inv.id}`;
    if (!['open', 'partial'].includes(inv.status)) return h.back(req, res, back, 'error', tr('This invoice is not open for payment.'));
    const amount = h.numv(req.body.amount);
    const days = Math.max(1, Math.min(60, h.int(req.body.days) || LINK_DAYS));
    const email = h.str(req.body.email, 200);
    const token = tok();
    const id = Number(db.run('INSERT INTO payment_links (token_hash, reveal, invoice_id, amount, expires_at, sent_to, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      sha(token), token, inv.id, amount > 0 && amount < outstanding(inv) ? r2(amount) : null, new Date(Date.now() + days * 86400000).toISOString(), email || null, req.user.id, inv.demo ? 1 : 0, now()).lastInsertRowid);
    let sent = false;
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && mailReady()) {
      const url = `${(env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/pay/${token}`;
      try {
        const r = await h.mail.send({
          to: email, tag: 'payment-link',
          subject: tr('por|Invoice {ref} from The Wave', { ref: inv.ref }),
          text: tr('por|Hello,\n\nYou can pay invoice {ref} ({amount}) online, by card, mobile wallet or cash at a payment outlet:\n{url}\n\nThe link works until {date}.\n\nThe Wave leasing office', { ref: inv.ref, amount: ui.money(amount > 0 && amount < outstanding(inv) ? amount : outstanding(inv)), url, date: ui.date(new Date(Date.now() + days * 86400000).toISOString()) }),
        });
        sent = r !== false && !(r && r.ok === false);
      } catch (err) {
        console.error('[payments] link email failed:', err.message);
      }
    }
    h.log(req, sent ? 'Emailed a payment link' : 'Created a payment link', 'invoice', inv.id, `${inv.ref}${email ? ` · ${email}` : ''}`);
    h.back(req, res, `${back}?plink=${id}#online`, 'ok', sent ? tr('por|Payment link emailed to {email}.', { email }) : tr('por|Payment link created. Copy it below.'));
  });
  router.post('/payment-links/:id/cancel', RM, (req, res, next) => {
    const l = db.get('SELECT * FROM payment_links WHERE id = ?', h.int(req.params.id));
    if (!l) return next();
    db.run('UPDATE payment_links SET cancelled = 1, reveal = NULL WHERE id = ?', l.id);
    h.log(req, 'Cancelled a payment link', 'invoice', l.invoice_id, null);
    h.back(req, res, `/admin/invoices/${l.invoice_id}#online`, 'ok', tr('por|Payment link cancelled.'));
  });

  const modeLine = () => {
    const c = cfg();
    if (sandboxMode()) return ui.badge('sandbox', tr('por|Sandbox'), 'amber');
    return c.ready ? ui.badge('live', tr('por|Paymob live'), 'ok') : ui.badge('off', tr('por|Not set up'), 'mute');
  };
  (h.invoiceCards = h.invoiceCards || []).push((req, inv) => {
    if (!canMoney(req)) return '';
    const csrf = req.session.csrf;
    const open = ['open', 'partial'].includes(inv.status);
    const links = db.all('SELECT l.*, u.name author FROM payment_links l LEFT JOIN users u ON u.id = l.created_by WHERE l.invoice_id = ? ORDER BY l.id DESC LIMIT 6', inv.id);
    const intents = db.all('SELECT * FROM payment_intents WHERE invoice_id = ? ORDER BY id DESC LIMIT 6', inv.id);
    const t = now();
    const linkState = (l) => (l.cancelled ? ui.badge('void', tr('por|Cancelled')) : l.expires_at <= t ? ui.badge('expired', tr('offer|Expired'), 'mute') : ui.badge('active', l.opened_at ? tr('por|Opened') : tr('por|Sent'), l.opened_at ? 'ok' : 'amber'));
    const brandEmail = inv.brand_id ? db.value('SELECT store_email FROM brands WHERE id = ?', inv.brand_id) || db.value("SELECT email FROM portal_users WHERE brand_id = ? AND active = 1 ORDER BY id LIMIT 1", inv.brand_id) || '' : '';
    const form = open ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${ui.esc(tr('por|New payment link'))}</span></summary>${ui.form(`/admin/invoices/${inv.id}/payment-link`, csrf, `<div class="fields">
      ${ui.input('amount', tr('Amount'), outstanding(inv), { type: 'number', min: 1, step: '0.01', hint: tr('por|Leave the full balance, or ask for part of it.') })}
      ${ui.input('days', tr('por|Valid for (days)'), LINK_DAYS, { type: 'number', min: 1, max: 60 })}
      ${ui.input('email', tr('por|Email it to'), brandEmail, { type: 'email', cls: 'span-all', hint: mailReady() ? tr('por|Optional. Leave empty to copy the link yourself.') : tr('por|Email is not set up: copy the link and send it yourself.') })}
    </div>${ui.btn(tr('por|Create the link'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const linkList = links.length ? `<ul class="list">${links.map((l) => `<li><span class="what"><b>${l.amount ? ui.money(l.amount) : ui.esc(tr('por|Full balance'))}</b><small>${ui.esc(tr('por|until {date}', { date: ui.date(l.expires_at) }))}${l.sent_to ? ` · ${ui.esc(l.sent_to)}` : ''}${l.author ? ` · ${ui.esc(l.author)}` : ''}</small></span>${linkState(l)}${!l.cancelled && l.expires_at > t ? ui.form(`/admin/payment-links/${l.id}/cancel`, csrf, `<button class="iconbtn" title="${ui.esc(tr('por|Cancel the link'))}" aria-label="${ui.esc(tr('por|Cancel the link'))}" data-confirm="${ui.esc(tr('por|Cancel this payment link?'))}">×</button>`) : ''}</li>`).join('')}</ul>` : '';
    const intentList = intents.length ? `<p class="eyebrow pad">${ui.esc(tr('por|Online attempts'))}</p><ul class="list">${intents.map((i) => `<li><span class="what"><b>${ui.money(i.amount)} · ${ui.esc(methodLabel(i.method))}</b><small>${ui.dt(i.created_at)} · ${ui.esc(i.provider === 'sandbox' ? tr('por|Sandbox') : tr('por|Paymob'))}${i.error ? ` · ${ui.esc(tx(i.error))}` : ''}</small></span>${statusBadge(i.status)}</li>`).join('')}</ul>` : '';
    const receipts = db.all("SELECT id, ref FROM payments WHERE invoice_id = ? AND status = 'received' ORDER BY id", inv.id);
    const rec = receipts.length ? `<p class="row pad">${receipts.map((p) => ui.btn(ui.esc(tr('por|Receipt {ref}', { ref: p.ref })), { href: `/admin/payments/${p.id}/receipt`, cls: 'btn--ghost btn--xs', ic: 'print', attrs: { target: '_blank' } })).join('')}</p>` : '';
    if (!open && !links.length && !intents.length && !rec) return '';
    return `<div id="online">${revealLink(req)}${ui.card(tr('por|Online payment'), `${linkList}${form}${intentList}${rec}`, { action: modeLine(), sub: ui.esc(tr('por|Send a link the tenant pays by card, wallet or cash at an outlet.')) })}</div>`;
  });

  // the online payments card on /admin/portal
  function adminCard(req) {
    if (!canMoney(req)) return '';
    const c = cfg();
    const m = M.today().slice(0, 7);
    const month = db.get("SELECT COUNT(*) n, COALESCE(SUM(amount), 0) total FROM payment_intents WHERE status = 'paid' AND substr(updated_at, 1, 7) = ?", m);
    return ui.card(tr('por|Online payments'), `<dl class="dl">
      <div><dt>${ui.esc(tr('Status'))}</dt><dd>${modeLine()}</dd></div>
      <div><dt>${ui.esc(tr('por|Methods'))}</dt><dd>${ui.esc((sandboxMode() ? ['card', 'wallet', 'kiosk'] : c.methods).map(methodLabel).join(' · ') || '—')}</dd></div>
      <div><dt>${ui.esc(tr('por|Paid online this month'))}</dt><dd>${ui.money(month.total)} · ${ui.esc(tn(month.n, 'por|{n} payment', 'por|{n} payments'))}</dd></div>
    </dl>`, { action: ui.btn(tr('All'), { href: '/admin/payments/online', cls: 'btn--ghost btn--sm' }) });
  }

  router.get('/payments/online', RM, (req, res) => {
    const view = ['intents', 'links', 'events'].includes(req.query.view) ? req.query.view : 'intents';
    const m = M.today().slice(0, 7);
    const k = (sql, ...a) => db.value(sql, ...a);
    const kpis = `<div class="kpis kpis--4">
      ${ui.kpi({ label: tr('por|Paid online this month'), value: ui.money(k("SELECT COALESCE(SUM(amount), 0) FROM payment_intents WHERE status = 'paid' AND substr(updated_at, 1, 7) = ?", m), { compact: true }) })}
      ${ui.kpi({ label: tr('por|Waiting'), value: String(k("SELECT COUNT(*) FROM payment_intents WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > ?)", now())) })}
      ${ui.kpi({ label: tr('por|Failed this month'), value: String(k("SELECT COUNT(*) FROM payment_intents WHERE status = 'failed' AND substr(updated_at, 1, 7) = ?", m)) })}
      ${ui.kpi({ label: tr('por|Paid, not applied'), value: String(k("SELECT COUNT(*) FROM payment_intents WHERE status = 'paid_unapplied'")), tone: k("SELECT COUNT(*) FROM payment_intents WHERE status = 'paid_unapplied'") ? 'kpi--alert' : '' })}
    </div>`;
    const tabs = [['intents', tr('por|Payments')], ['links', tr('por|Payment links')], ['events', tr('por|Provider messages')]].map(([x, l]) => `<a class="tab${view === x ? ' is-on' : ''}" href="/admin/payments/online?view=${x}">${ui.esc(l)}</a>`).join('');
    let table;
    if (view === 'intents') {
      const rows = db.all('SELECT p.*, i.ref invoice_ref, COALESCE(b.name, i.customer) party FROM payment_intents p JOIN invoices i ON i.id = p.invoice_id LEFT JOIN brands b ON b.id = i.brand_id ORDER BY p.id DESC LIMIT 300');
      table = ui.table([
        { label: tr('Date'), render: (r) => ui.dt(r.created_at) },
        { label: tr('Invoice'), render: (r) => `<b>${ui.esc(r.invoice_ref)}</b><small class="sub">${ui.esc(r.party || '')}</small>` },
        { label: tr('Method'), render: (r) => `${ui.esc(methodLabel(r.method))}<small class="sub">${ui.esc(r.provider === 'sandbox' ? tr('por|Sandbox') : tr('por|Paymob'))} · ${ui.esc(r.source === 'link' ? tr('por|Payment link') : tr('por|Tenant portal'))}</small>` },
        { label: tr('Amount'), num: true, render: (r) => ui.money(r.amount, { cur: false }) },
        { label: tr('Status'), render: (r) => `${statusBadge(r.status)}${r.error ? `<small class="sub">${ui.esc(tx(r.error))}</small>` : ''}` },
      ], rows, { empty: ui.esc(tr('por|No online payments yet.')), href: (r) => `/admin/invoices/${r.invoice_id}#online` });
    } else if (view === 'links') {
      const rows = db.all('SELECT l.*, i.ref invoice_ref, i.total - i.paid due, COALESCE(b.name, i.customer) party, u.name author FROM payment_links l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN brands b ON b.id = i.brand_id LEFT JOIN users u ON u.id = l.created_by ORDER BY l.id DESC LIMIT 300');
      const t = now();
      table = ui.table([
        { label: tr('Date'), render: (r) => ui.date(r.created_at) },
        { label: tr('Invoice'), render: (r) => `<b>${ui.esc(r.invoice_ref)}</b><small class="sub">${ui.esc(r.party || '')}</small>` },
        { label: tr('Amount'), num: true, render: (r) => ui.money(r.amount || r.due, { cur: false }) },
        { label: tr('por|Sent to'), render: (r) => ui.esc(r.sent_to || '—') },
        { label: tr('Status'), render: (r) => (r.cancelled ? ui.badge('void', tr('por|Cancelled')) : r.expires_at <= t ? ui.badge('expired', tr('offer|Expired'), 'mute') : ui.badge('active', r.opened_at ? tr('por|Opened') : tr('por|Sent'), r.opened_at ? 'ok' : 'amber')) },
      ], rows, { empty: ui.esc(tr('por|No payment links yet.')), href: (r) => `/admin/invoices/${r.invoice_id}#online` });
    } else {
      const rows = db.all('SELECT * FROM payment_events ORDER BY id DESC LIMIT 200');
      table = ui.table([
        { label: tr('Date'), render: (r) => ui.dt(r.created_at) },
        { label: tr('Type'), render: (r) => ui.esc(r.kind === 'callback' ? tr('por|Server callback') : tr('por|Payer returned')) },
        { label: tr('por|Transaction'), render: (r) => `<span class="ltr">${ui.esc(r.txn_id || '—')}</span>` },
        { label: tr('por|Signature'), render: (r) => (r.hmac_ok ? ui.badge('ok', tr('por|Valid'), 'ok') : ui.badge('bad', tr('por|Invalid'), 'rose')) },
        { label: tr('por|Result'), render: (r) => ui.esc(resultLabel(r.result)) },
      ], rows, { empty: ui.esc(tr('por|Nothing received from Paymob yet.')) });
    }
    const c = cfg();
    const setup = ui.card(tr('por|Set-up'), `<dl class="dl">
      <div><dt>${ui.esc(tr('Status'))}</dt><dd>${modeLine()}</dd></div>
      <div><dt>${ui.esc(tr('por|Callback URL'))}</dt><dd><span class="ltr small">${ui.esc((env.SITE_URL || '').replace(/\/$/, ''))}/payments/paymob/callback</span></dd></div>
      <div><dt>${ui.esc(tr('por|Return URL'))}</dt><dd><span class="ltr small">${ui.esc((env.SITE_URL || '').replace(/\/$/, ''))}/payments/paymob/return</span></dd></div>
      <div><dt>${ui.esc(tr('por|Methods'))}</dt><dd>${ui.esc(c.methods.map(methodLabel).join(' · ') || '—')}</dd></div>
    </dl><p class="muted small pad">${ui.esc(tr('por|Paymob is set up on the server (PAYMOB_API_KEY, PAYMOB_HMAC_SECRET, PAYMOB_IFRAME_ID and an integration ID per method). Keys never appear on screen.'))}</p>`);
    h.page(req, res, {
      title: tr('por|Online payments'), active: '/admin/billing', wide: true, crumbs: [['/admin/billing', tr('Billing')], [null, tr('por|Online payments')]],
      body: `${kpis}<div class="grid grid--side"><div class="stack"><nav class="tabs">${tabs}</nav>${ui.card(tr('por|Online payments'), table)}</div><div class="stack">${setup}</div></div>`,
    });
  });

  // expire checkouts nobody finished
  h.every('payments-expire', 15 * 60 * 1000, () => {
    db.run("UPDATE payment_intents SET status = 'expired', updated_at = ? WHERE status IN ('created','pending') AND expires_at IS NOT NULL AND expires_at < ?", now(), now());
  });

  h.payments = { canPayOnline, payCard, adminCard, providerFor, begin, settle, apply, fetchImpl: null };

  // ================= e-invoicing (ETA) =================
  const etaEnv = () => (db.setting('eta_env') === 'prod' ? 'prod' : 'preprod');
  const etaCreds = () => !!(env.ETA_CLIENT_ID && env.ETA_CLIENT_SECRET);
  const etaSigner = () => String(env.ETA_SIGNER_URL || '');
  let etaClient = null;
  const client = () => {
    const key = `${etaEnv()}|${env.ETA_CLIENT_ID}`;
    if (!etaClient || etaClient.key !== key) etaClient = { key, api: eta.api({ env: etaEnv(), clientId: env.ETA_CLIENT_ID, clientSecret: env.ETA_CLIENT_SECRET, fetchImpl: (...a) => fetchImpl()(...a) }) };
    return etaClient.api;
  };
  const ETA_STATUS = () => ({
    prepared: [tr('por|Prepared'), 'mute'], invalid_local: [tr('por|Needs fixing'), 'rose'], ready: [tr('por|Ready to sign'), 'amber'],
    submitted: [tr('por|Submitted'), 'amber'], valid: [tr('por|Valid'), 'ok'], invalid: [tr('por|Invalid'), 'rose'], rejected: [tr('por|Rejected'), 'rose'],
    cancelled: [tr('por|Cancelled'), 'mute'], cancel_needed: [tr('por|Cancel at the ETA'), 'rose'], error: [tr('por|Error'), 'rose'],
  });
  const etaBadge = (s) => ui.badge(`eta-${s}`, (ETA_STATUS()[s] || [s])[0], (ETA_STATUS()[s] || [])[1]);
  const etaLog = (docId, action, detail, user = null) => db.run('INSERT INTO eta_log (eta_document_id, action, detail, user_id, created_at) VALUES (?, ?, ?, ?, ?)', docId, action, detail ? String(detail).slice(0, 1000) : null, user ? user.id : null, now());
  const etaEligible = (inv) => inv && inv.status !== 'void' && !ETA_SKIP.includes(inv.kind) && inv.total > 0;
  const LOCKED = ['submitted', 'valid', 'cancel_needed'];

  // Build and check the document for an invoice; returns the eta_documents row.
  function prepare(inv, { user = null } = {}) {
    if (!etaEligible(inv)) return null;
    const cur = db.get('SELECT * FROM eta_documents WHERE invoice_id = ?', inv.id);
    if (cur && LOCKED.includes(cur.status)) return cur;
    const brand = inv.brand_id ? db.get('SELECT * FROM brands WHERE id = ?', inv.brand_id) : { name: inv.customer };
    const labels = i18n.run('en', () => ({ rent: tr('Base rent'), service: tr('Service charge'), other: inv.note || M.INVOICE_KINDS[inv.kind] || tr('Other') }));
    const doc = eta.buildDocument(inv, brand, db.settings(), { labels });
    const errors = eta.validate(doc);
    const status = errors.length ? 'invalid_local' : 'ready';
    const t = now();
    if (cur) {
      db.run('UPDATE eta_documents SET internal_id = ?, status = ?, document = ?, canonical_sha256 = ?, errors = ?, updated_at = ? WHERE id = ?', inv.ref, status, JSON.stringify(doc), eta.canonicalHash(doc), JSON.stringify(errors), t, cur.id);
    } else {
      db.run('INSERT INTO eta_documents (invoice_id, internal_id, status, document, canonical_sha256, errors, created_at, updated_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', inv.id, inv.ref, status, JSON.stringify(doc), eta.canonicalHash(doc), JSON.stringify(errors), t, t, inv.demo ? 1 : 0);
    }
    const row = db.get('SELECT * FROM eta_documents WHERE invoice_id = ?', inv.id);
    etaLog(row.id, errors.length ? 'E-invoice prepared with problems' : 'E-invoice prepared', errors[0] || null, user);
    return row;
  }

  // Sign and submit ready documents. Returns { submitted, rejected }.
  async function submit(rows, { user = null } = {}) {
    if (!etaSigner()) throw new Error('Documents are ready to sign. Set ETA_SIGNER_URL to the signing service beside the company’s e-signature token to submit them.');
    if (!etaCreds()) throw new Error('Set ETA_CLIENT_ID and ETA_CLIENT_SECRET (from the ETA portal) on the server to submit.');
    let submitted = 0;
    let rejected = 0;
    const ready = rows.filter((r) => r.status === 'ready');
    for (let n = 0; n < ready.length; n += 50) {
      const batch = ready.slice(n, n + 50);
      const docs = [];
      for (const r of batch) {
        const doc = json(r.document);
        doc.signatures = [{ signatureType: 'I', value: await eta.signWithService(etaSigner(), eta.serialize(doc), { fetchImpl: fetchImpl() }) }];
        docs.push(doc);
      }
      let out;
      try {
        out = await client().submit(docs);
      } catch (err) {
        for (const r of batch) {
          db.run("UPDATE eta_documents SET status = 'error', errors = ?, updated_at = ? WHERE id = ?", JSON.stringify([err.message]), now(), r.id);
          etaLog(r.id, 'E-invoice submission failed', err.message, user);
        }
        throw err;
      }
      const t = now();
      for (const a of out.acceptedDocuments || []) {
        const r = batch.find((x) => x.internal_id === a.internalId);
        if (!r) continue;
        db.run("UPDATE eta_documents SET status = 'submitted', uuid = ?, long_id = ?, submission_id = ?, errors = '[]', submitted_at = ?, updated_at = ? WHERE id = ?", a.uuid, a.longId || null, out.submissionId || out.submissionUUID || null, t, t, r.id);
        etaLog(r.id, 'E-invoice submitted', a.uuid, user);
        submitted += 1;
      }
      for (const x of out.rejectedDocuments || []) {
        const r = batch.find((y) => y.internal_id === x.internalId);
        if (!r) continue;
        const errs = [x.error && x.error.message, ...((x.error && x.error.details) || []).map((d) => `${d.propertyPath || d.target || ''}: ${d.message}`)].filter(Boolean);
        db.run("UPDATE eta_documents SET status = 'rejected', errors = ?, updated_at = ? WHERE id = ?", JSON.stringify(errs), t, r.id);
        etaLog(r.id, 'E-invoice rejected', errs.join(' '), user);
        rejected += 1;
      }
    }
    return { submitted, rejected };
  }

  // Ask the ETA how submitted documents fared.
  async function poll({ limit = 40 } = {}) {
    if (!etaCreds()) return 0;
    const rows = db.all("SELECT * FROM eta_documents WHERE status = 'submitted' AND uuid IS NOT NULL ORDER BY checked_at IS NOT NULL, checked_at LIMIT ?", limit);
    let changed = 0;
    for (const r of rows) {
      try {
        const j = await client().status(r.uuid);
        const st = String(j.status || (j.document && j.document.status) || '').toLowerCase();
        const map = { valid: 'valid', invalid: 'invalid', rejected: 'rejected', cancelled: 'cancelled' };
        const next = map[st] || 'submitted';
        const errs = ((j.validationResults && j.validationResults.validationSteps) || []).filter((s) => s.status === 'Invalid').flatMap((s) => (s.error && s.error.innerError ? s.error.innerError.map((e) => e.error || e.errorCode) : [s.name]));
        db.run('UPDATE eta_documents SET status = ?, long_id = COALESCE(?, long_id), errors = ?, checked_at = ?, updated_at = ? WHERE id = ?', next, j.longId || null, JSON.stringify(errs), now(), now(), r.id);
        if (next !== r.status) {
          etaLog(r.id, { valid: 'E-invoice accepted by the ETA', invalid: 'E-invoice found invalid by the ETA', rejected: 'E-invoice rejected by the ETA', cancelled: 'E-invoice cancelled at the ETA' }[next] || 'E-invoice status checked', errs[0] || null);
          changed += 1;
        }
      } catch (err) {
        db.run('UPDATE eta_documents SET checked_at = ? WHERE id = ?', now(), r.id);
        etaLog(r.id, 'E-invoice status check failed', err.message);
      }
    }
    return changed;
  }
  h.every('eta-status', 20 * 60 * 1000, () => poll());

  // a voided invoice: an e-invoice already at the ETA must be cancelled there too
  h.events.on('invoice.voided', ({ invoice }) => {
    const r = invoice && db.get('SELECT * FROM eta_documents WHERE invoice_id = ?', invoice.id);
    if (!r || r.status === 'cancelled') return;
    const next = ['submitted', 'valid'].includes(r.status) ? 'cancel_needed' : 'cancelled';
    db.run('UPDATE eta_documents SET status = ?, updated_at = ? WHERE id = ?', next, now(), r.id);
    etaLog(r.id, next === 'cancel_needed' ? 'Invoice voided: cancel the e-invoice at the ETA' : 'Invoice voided before the e-invoice was sent', null);
  });

  h.eta = { prepare, submit, poll, eligible: etaEligible };

  const etaErrors = (r) => (json(r.errors, []) || []).map((e) => `<li>${ui.esc(tr(e) === e ? tx(e) : tr(e))}</li>`).join('');
  const portalUrl = (r) => (r.uuid && r.long_id ? `${eta.ENVS[etaEnv()].portal}/print/documents/${encodeURIComponent(r.uuid)}/share/${encodeURIComponent(r.long_id)}` : null);
  const monthOf = (req) => (/^\d{4}-\d{2}$/.test(String(req.query.month || req.body.month || '')) ? String(req.query.month || req.body.month) : M.today().slice(0, 7));
  const monthInvoices = (month) => db.all(
    `SELECT i.*, COALESCE(b.name, i.customer) party, e.id eta_id, e.status eta_status, e.errors eta_errors, e.uuid FROM invoices i LEFT JOIN brands b ON b.id = i.brand_id LEFT JOIN eta_documents e ON e.invoice_id = i.id
     WHERE substr(i.due_date, 1, 7) = ? AND (i.status != 'void' OR e.id IS NOT NULL) AND i.kind NOT IN (${ETA_SKIP.map(() => '?').join(',')}) ORDER BY i.due_date, i.ref`, month, ...ETA_SKIP,
  );

  router.get('/eta', h.RF, (req, res) => {
    const month = monthOf(req);
    const csrf = req.session.csrf;
    const s = { ...eta.DEFAULTS, ...db.settings() };
    const rows = monthInvoices(month);
    const count = (st) => rows.filter((r) => (r.eta_status || 'none') === st).length;
    const kpis = `<div class="kpis kpis--4">
      ${ui.kpi({ label: tr('por|Invoices this month'), value: String(rows.length) })}
      ${ui.kpi({ label: tr('por|Not prepared yet'), value: String(count('none')) })}
      ${ui.kpi({ label: tr('por|Ready to sign'), value: String(count('ready')), tone: count('invalid_local') ? 'kpi--alert' : '', sub: count('invalid_local') ? ui.esc(tr('por|{n} need fixing', { n: count('invalid_local') })) : '' })}
      ${ui.kpi({ label: tr('por|Accepted by the ETA'), value: String(count('valid')), sub: count('submitted') ? ui.esc(tr('por|{n} waiting for the ETA', { n: count('submitted') })) : '' })}
    </div>`;
    const prev = M.addMonths(`${month}-01`, -1).slice(0, 7);
    const next = M.addMonths(`${month}-01`, 1).slice(0, 7);
    const monthNav = `<div class="row"><a class="btn btn--ghost btn--sm" href="/admin/eta?month=${prev}">${ui.icon('back')}</a><b class="pad">${ui.esc(ui.monthYear(month))}</b><a class="btn btn--ghost btn--sm" href="/admin/eta?month=${next}">${ui.icon('arrow')}</a></div>`;
    const actions = `${ui.form('/admin/eta/prepare', csrf, `<input type="hidden" name="month" value="${month}">${ui.btn(tr('por|Prepare the month'), { cls: 'btn--ghost btn--sm', ic: 'check' })}`)}${ui.form('/admin/eta/submit', csrf, `<input type="hidden" name="month" value="${month}">${ui.btn(tr('por|Sign and submit'), { cls: 'btn--primary btn--sm', ic: 'arrow', attrs: count('ready') ? { 'data-confirm': tr('por|Submit {n} documents to the ETA?', { n: count('ready') }) } : { disabled: true } })}`)}`;
    const table = ui.table([
      { label: tr('Invoice'), render: (r) => `<b>${ui.esc(r.ref)}</b><small class="sub">${ui.esc(r.party || '')}</small>` },
      { label: tr('Due'), render: (r) => ui.date(r.due_date) },
      { label: tr('Total'), num: true, render: (r) => ui.money(r.total, { cur: false }) },
      { label: tr('por|E-invoice'), render: (r) => (r.eta_status ? `${etaBadge(r.eta_status)}${(json(r.eta_errors, []) || []).length && ['invalid_local', 'rejected', 'invalid', 'error'].includes(r.eta_status) ? `<small class="sub">${ui.esc(tr(json(r.eta_errors)[0]))}</small>` : ''}` : `<span class="muted">${ui.esc(tr('por|Not prepared'))}</span>`) },
    ], rows, { empty: ui.esc(tr('por|No invoices due this month.')), href: (r) => (r.eta_id ? `/admin/eta/doc/${r.eta_id}` : `/admin/invoices/${r.id}`) });
    const status = ui.card(tr('por|Connection'), `<dl class="dl">
      <div><dt>${ui.esc(tr('por|System'))}</dt><dd>${ui.esc(etaEnv() === 'prod' ? tr('por|Production') : tr('por|Pre-production (testing)'))}</dd></div>
      <div><dt>${ui.esc(tr('por|API credentials'))}</dt><dd>${etaCreds() ? ui.badge('ok', tr('por|Set'), 'ok') : ui.badge('off', tr('por|Missing'), 'rose')}</dd></div>
      <div><dt>${ui.esc(tr('por|Signing service'))}</dt><dd>${etaSigner() ? ui.badge('ok', tr('por|Connected'), 'ok') : `${ui.badge('off', tr('por|Not set'), 'amber')}<small class="sub">${ui.esc(tr('por|Documents stop at “ready to sign”.'))}</small>`}</dd></div>
    </dl><p class="muted small pad">${ui.esc(tr('por|Credentials live on the server only: ETA_CLIENT_ID, ETA_CLIENT_SECRET and ETA_SIGNER_URL.'))}</p>`);
    const settingsForm = h.can(req, 'admin') ? ui.card(tr('por|Issuer details'), ui.form('/admin/eta/settings', csrf, `<div class="fields">
      ${ui.select('eta_env', tr('por|System'), [['preprod', tr('por|Pre-production (testing)')], ['prod', tr('por|Production')]], s.eta_env)}
      ${ui.input('eta_rin', tr('por|Tax registration number (RIN)'), s.eta_rin, { attrs: { inputmode: 'numeric', maxlength: 9 } })}
      ${ui.input('eta_name', tr('por|Issuer name (as registered)'), s.eta_name || s.legal_name, { cls: 'span-all' })}
      ${ui.input('eta_branch', tr('por|Branch code'), s.eta_branch)}
      ${ui.input('eta_activity', tr('por|Activity code'), s.eta_activity, { hint: tr('por|6810 is renting real estate.') })}
      ${ui.input('eta_governate', tr('por|Governorate'), s.eta_governate)}
      ${ui.input('eta_city', tr('por|City'), s.eta_city)}
      ${ui.input('eta_street', tr('por|Street'), s.eta_street)}
      ${ui.input('eta_building', tr('por|Building number'), s.eta_building)}
      ${ui.input('eta_item_rent', tr('por|Item code: rent (EGS)'), s.eta_item_rent)}
      ${ui.input('eta_item_service', tr('por|Item code: service charge (EGS)'), s.eta_item_service)}
      ${ui.input('eta_item_other', tr('por|Item code: other charges (EGS)'), s.eta_item_other)}
      ${ui.input('eta_vat_rate', tr('por|VAT rate for invoices without VAT (%)'), s.eta_vat_rate, { type: 'number', step: '0.01', min: 0, max: 100 })}
    </div>${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }), { sub: ui.esc(tr('por|From the mall’s ETA registration. Item codes are the EGS codes registered for each service.')) }) : '';
    const log = db.all('SELECT l.*, e.internal_id, u.name user_name FROM eta_log l LEFT JOIN eta_documents e ON e.id = l.eta_document_id LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 25');
    const logList = log.length ? `<ul class="list">${log.map((l) => `<li><span class="what"><b>${ui.esc(l.internal_id || '')} · ${ui.esc(tx(l.action))}</b><small>${ui.dt(l.created_at)}${l.user_name ? ` · ${ui.esc(l.user_name)}` : ''}${l.detail ? ` · ${ui.esc(String(tx(l.detail)).slice(0, 120))}` : ''}</small></span></li>`).join('')}</ul>` : `<p class="muted pad">${ui.esc(tr('por|Nothing yet.'))}</p>`;
    h.page(req, res, {
      title: tr('por|E-invoicing (ETA)'), active: '/admin/billing', wide: true, crumbs: [['/admin/billing', tr('Billing')], [null, tr('por|E-invoicing (ETA)')]],
      body: `${kpis}<div class="grid grid--side"><div class="stack">${ui.card(tr('por|Invoices'), `<div class="row row--split pad">${monthNav}<div class="row">${actions}</div></div>${table}`, { sub: ui.esc(tr('por|Deposits are not sales and are left out.')) })}${ui.card(tr('por|Log'), logList)}</div><div class="stack">${status}${settingsForm}</div></div>`,
    });
  });
  router.post('/eta/settings', R('admin'), (req, res) => {
    for (const k of eta.SETTING_KEYS) db.setSetting(k, h.str(req.body[k], 160));
    if (!['preprod', 'prod'].includes(db.setting('eta_env'))) db.setSetting('eta_env', 'preprod');
    h.log(req, 'Changed the e-invoicing settings', 'settings', null, null);
    h.back(req, res, '/admin/eta', 'ok', tr('Saved.'));
  });
  router.post('/eta/prepare', h.RF, (req, res) => {
    const month = monthOf(req);
    let ready = 0;
    let bad = 0;
    for (const inv of monthInvoices(month).filter((r) => r.status !== 'void')) {
      const r = prepare(inv, { user: req.user });
      if (r && r.status === 'ready') ready += 1;
      if (r && r.status === 'invalid_local') bad += 1;
    }
    h.log(req, 'Prepared e-invoices', 'eta', null, month);
    h.back(req, res, `/admin/eta?month=${month}`, bad ? 'error' : 'ok', bad ? tr('por|{ready} ready to sign, {bad} need fixing.', { ready, bad }) : tr('por|{ready} ready to sign.', { ready }));
  });
  router.post('/eta/submit', h.RF, async (req, res) => {
    const month = monthOf(req);
    const rows = db.all(`SELECT e.* FROM eta_documents e JOIN invoices i ON i.id = e.invoice_id WHERE substr(i.due_date, 1, 7) = ? AND e.status = 'ready'`, month);
    try {
      const out = await submit(rows, { user: req.user });
      h.log(req, 'Submitted e-invoices', 'eta', null, `${month} · ${out.submitted}/${rows.length}`);
      h.back(req, res, `/admin/eta?month=${month}`, out.rejected ? 'error' : 'ok', tr('por|{n} submitted, {bad} rejected.', { n: out.submitted, bad: out.rejected }));
    } catch (err) {
      h.back(req, res, `/admin/eta?month=${month}`, 'error', tr(err.message));
    }
  });
  router.post('/eta/invoice/:id/prepare', h.RF, (req, res, next) => {
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', h.int(req.params.id));
    if (!inv) return next();
    const r = prepare(inv, { user: req.user });
    if (!r) return h.back(req, res, `/admin/invoices/${inv.id}#eta`, 'error', tr('por|Deposits are not sales and are left out.'));
    h.back(req, res, `/admin/invoices/${inv.id}#eta`, r.status === 'ready' ? 'ok' : 'error', r.status === 'ready' ? tr('por|Ready to sign.') : tr('por|The e-invoice needs fixing.'));
  });
  router.post('/eta/doc/:id/submit', h.RF, async (req, res, next) => {
    const r = db.get('SELECT * FROM eta_documents WHERE id = ?', h.int(req.params.id));
    if (!r) return next();
    try {
      const out = await submit([r], { user: req.user });
      h.back(req, res, h.safeBack(req, `/admin/eta/doc/${r.id}`), out.submitted ? 'ok' : 'error', out.submitted ? tr('por|Submitted to the ETA.') : tr('por|The ETA rejected the document.'));
    } catch (err) {
      h.back(req, res, h.safeBack(req, `/admin/eta/doc/${r.id}`), 'error', tr(err.message));
    }
  });
  router.post('/eta/doc/:id/check', h.RF, async (req, res, next) => {
    const r = db.get('SELECT * FROM eta_documents WHERE id = ?', h.int(req.params.id));
    if (!r) return next();
    db.run('UPDATE eta_documents SET checked_at = NULL WHERE id = ?', r.id);
    await poll({ limit: 1 }).catch(() => 0);
    h.back(req, res, `/admin/eta/doc/${r.id}`, 'ok', tr('por|Status checked.'));
  });
  router.post('/eta/doc/:id/cancel', h.RF, async (req, res, next) => {
    const r = db.get('SELECT * FROM eta_documents WHERE id = ?', h.int(req.params.id));
    if (!r) return next();
    if (!r.uuid || !etaCreds()) return h.back(req, res, `/admin/eta/doc/${r.id}`, 'error', tr('Set ETA_CLIENT_ID and ETA_CLIENT_SECRET (from the ETA portal) on the server to submit.'));
    try {
      await client().cancel(r.uuid, h.str(req.body.reason, 200) || 'Invoice voided');
      db.run("UPDATE eta_documents SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), r.id);
      etaLog(r.id, 'E-invoice cancelled at the ETA', null, req.user);
      h.back(req, res, `/admin/eta/doc/${r.id}`, 'ok', tr('por|Cancelled at the ETA.'));
    } catch (err) {
      h.back(req, res, `/admin/eta/doc/${r.id}`, 'error', err.message);
    }
  });
  router.get('/eta/doc/:id', h.RF, (req, res, next) => {
    const r = db.get('SELECT e.*, i.ref, i.id invoice_id, i.total, COALESCE(b.name, i.customer) party FROM eta_documents e JOIN invoices i ON i.id = e.invoice_id LEFT JOIN brands b ON b.id = i.brand_id WHERE e.id = ?', h.int(req.params.id));
    if (!r) return next();
    const csrf = req.session.csrf;
    const doc = json(r.document, {});
    const log = db.all('SELECT l.*, u.name user_name FROM eta_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.eta_document_id = ? ORDER BY l.id DESC', r.id);
    const url = portalUrl(r);
    const facts = `<dl class="dl">
      <div><dt>${ui.esc(tr('Status'))}</dt><dd>${etaBadge(r.status)}</dd></div>
      <div><dt>${ui.esc(tr('Invoice'))}</dt><dd><a href="/admin/invoices/${r.invoice_id}">${ui.esc(r.ref)}</a> · ${ui.esc(r.party || '')}</dd></div>
      <div><dt>${ui.esc(tr('por|Receiver'))}</dt><dd>${ui.esc(doc.receiver ? doc.receiver.name : '')}${doc.receiver && doc.receiver.id ? ` · <span class="ltr">${ui.esc(doc.receiver.id)}</span>` : ''}</dd></div>
      <div><dt>${ui.esc(tr('por|Net'))}</dt><dd>${ui.money(doc.netAmount || 0)}</dd></div>
      <div><dt>${ui.esc(tr('por|VAT'))}</dt><dd>${ui.money(((doc.taxTotals || [])[0] || {}).amount || 0)}</dd></div>
      <div><dt>${ui.esc(tr('Total'))}</dt><dd><b>${ui.money(doc.totalAmount || 0)}</b></dd></div>
      ${r.uuid ? `<div><dt>${ui.esc(tr('por|ETA document ID'))}</dt><dd><span class="ltr small">${ui.esc(r.uuid)}</span></dd></div>` : ''}
    </dl>${etaErrors(r) ? `<ul class="alert alert--error errlist">${etaErrors(r)}</ul>` : ''}`;
    const buttons = `<div class="row pad">
      ${!LOCKED.includes(r.status) ? ui.form(`/admin/eta/invoice/${r.invoice_id}/prepare`, csrf, ui.btn(tr('por|Prepare again'), { cls: 'btn--ghost btn--sm', ic: 'check' })) : ''}
      ${r.status === 'ready' ? ui.form(`/admin/eta/doc/${r.id}/submit`, csrf, ui.btn(tr('por|Sign and submit'), { cls: 'btn--primary btn--sm', ic: 'arrow' })) : ''}
      ${r.status === 'submitted' ? ui.form(`/admin/eta/doc/${r.id}/check`, csrf, ui.btn(tr('por|Check now'), { cls: 'btn--ghost btn--sm' })) : ''}
      ${['valid', 'cancel_needed'].includes(r.status) ? ui.form(`/admin/eta/doc/${r.id}/cancel`, csrf, `<input type="hidden" name="reason" value="Invoice voided">${ui.btn(tr('por|Cancel at the ETA'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('por|Cancel this e-invoice at the ETA?') } })}`) : ''}
      ${url ? ui.btn(tr('por|Open at the ETA'), { href: url, cls: 'btn--ghost btn--sm', ic: 'arrow', attrs: { target: '_blank', rel: 'noopener' } }) : ''}
    </div>`;
    const lines = ui.table([
      { label: tr('Description'), render: (l) => `${ui.esc(tx(l.description))}<small class="sub ltr">${ui.esc(l.itemCode || '—')}</small>` },
      { label: tr('por|Net'), num: true, render: (l) => ui.money(l.netTotal, { cur: false }) },
      { label: tr('por|VAT'), num: true, render: (l) => ui.money(l.taxableItems[0].amount, { cur: false }) },
      { label: tr('Total'), num: true, render: (l) => ui.money(l.total, { cur: false }) },
    ], doc.invoiceLines || []);
    const logList = log.length ? `<ul class="list">${log.map((l) => `<li><span class="what"><b>${ui.esc(tx(l.action))}</b><small>${ui.dt(l.created_at)}${l.user_name ? ` · ${ui.esc(l.user_name)}` : ''}${l.detail ? ` · ${ui.esc(tx(l.detail))}` : ''}</small></span></li>`).join('')}</ul>` : '';
    h.page(req, res, {
      title: tr('por|E-invoice {ref}', { ref: r.ref }), active: '/admin/billing', crumbs: [['/admin/eta', tr('por|E-invoicing (ETA)')], [null, r.ref]],
      body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('por|E-invoice'), `${facts}${buttons}`)}${ui.card(tr('por|Lines'), lines)}<details class="upload-box"><summary>${ui.icon('file')}<span>${ui.esc(tr('por|The document as sent'))}</span></summary><textarea class="code ltr" readonly rows="18">SHA-256 ${ui.esc(r.canonical_sha256 || '')}\n\n${ui.esc(JSON.stringify(doc, null, 2))}</textarea></details></div><div class="stack">${ui.card(tr('por|Log'), logList || `<p class="muted pad">${ui.esc(tr('por|Nothing yet.'))}</p>`)}</div></div>`,
    });
  });

  // the e-invoice card on the office invoice page
  h.invoiceCards.push((req, inv) => {
    if (!h.canFinance(req) || (!etaEligible(inv) && !db.get('SELECT id FROM eta_documents WHERE invoice_id = ?', inv.id))) return '';
    const r = db.get('SELECT * FROM eta_documents WHERE invoice_id = ?', inv.id);
    const csrf = req.session.csrf;
    const body = r
      ? `<p class="pad">${etaBadge(r.status)}${r.uuid ? ` <span class="ltr small muted">${ui.esc(r.uuid)}</span>` : ''}</p>${etaErrors(r) ? `<ul class="alert alert--error errlist">${etaErrors(r)}</ul>` : ''}`
      : `<p class="muted pad">${ui.esc(tr('por|Not prepared yet.'))}</p>`;
    const act = `<div class="row pad">${!r || !LOCKED.includes(r.status) ? ui.form(`/admin/eta/invoice/${inv.id}/prepare`, csrf, ui.btn(r ? tr('por|Prepare again') : tr('por|Prepare'), { cls: 'btn--ghost btn--xs' })) : ''}${r && r.status === 'ready' ? ui.form(`/admin/eta/doc/${r.id}/submit`, csrf, ui.btn(tr('por|Sign and submit'), { cls: 'btn--primary btn--xs' })) : ''}${r ? ui.btn(tr('por|Details'), { href: `/admin/eta/doc/${r.id}`, cls: 'btn--ghost btn--xs' }) : ''}</div>`;
    return `<div id="eta">${ui.card(tr('por|E-invoice (ETA)'), `${body}${act}`, { action: ui.btn(tr('por|All'), { href: '/admin/eta', cls: 'btn--ghost btn--sm' }) })}</div>`;
  });

  // ---------- Integrations (rendered on the integrations page) ----------
  const cards = (h.integrationCards = h.integrationCards || []);
  cards.push({
    key: 'paymob',
    get title() { return tr('por|Online payments (Paymob)'); },
    status: () => {
      const c = cfg();
      if (sandboxMode()) return { ok: false, detail: tr('por|Sandbox: pretend payments only. Remove PAYMENTS_MODE=sandbox to take real payments.') };
      return c.ready ? { ok: true, detail: tr('por|Live · {methods}', { methods: c.methods.map(methodLabel).join(' · ') }) } : { ok: false, detail: tr('por|Not set up: tenants see your bank and InstaPay details instead.') };
    },
    env: ['PAYMOB_API_KEY', 'PAYMOB_HMAC_SECRET', 'PAYMOB_IFRAME_ID', 'PAYMOB_INTEGRATION_CARD', 'PAYMOB_INTEGRATION_WALLET', 'PAYMOB_INTEGRATION_KIOSK'],
    get help() { return tr('por|In the Paymob dashboard, set the transaction callbacks to /payments/paymob/callback and /payments/paymob/return on this website.'); },
    href: '/admin/payments/online',
    get hrefLabel() { return tr('por|Online payments'); },
  });
  cards.push({
    key: 'eta',
    get title() { return tr('por|E-invoicing (ETA)'); },
    status: () => {
      if (!etaCreds()) return { ok: false, detail: tr('por|Not set up') };
      if (!etaSigner()) return { ok: false, detail: tr('por|Credentials set; documents stop at “ready to sign” until a signing service is connected.') };
      return { ok: true, detail: etaEnv() === 'prod' ? tr('por|Production') : tr('por|Pre-production (testing)') };
    },
    env: ['ETA_CLIENT_ID', 'ETA_CLIENT_SECRET', 'ETA_SIGNER_URL'],
    get help() { return tr('por|The client ID and secret come from the ETA portal; the signing service runs on the computer that holds the company’s e-signature token.'); },
    href: '/admin/eta',
    get hrefLabel() { return tr('por|E-invoicing (ETA)'); },
  });
};
