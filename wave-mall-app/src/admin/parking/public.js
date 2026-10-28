'use strict';

// Parking outside the office:
//   /parking               for visitors: free spaces on each level, the prices, find your car and pay
//   /parking/t/ABCD-2345   a visitor's ticket on the phone: the QR a shop scans, time parked, pay now
//   /ingest/parking/…      the gates: plate cameras, ticket and card readers, pay machines, level sensors
//   /portal/parking        for shops: validate a customer's parking (scan the QR, tap the card, type the plate)
// The visitors' pages need no account; finding a car by its plate shows only what is due, never when it came in.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const T = require('./tariff');
const qr = require('../qr');
const { cairo } = require('../ops-common');

const { t: tr, tn, tx } = i18n;

module.exports = function parkingPublic(h, P) {
  const { db, ui } = h;
  const esc = ui.esc;
  const env = (k) => String((h.env && h.env[k]) || '');
  const money = (n) => ui.money(n);
  const dur = (m) => T.duration(m, tr);
  const site = (req) => String((h.env && h.env.SITE_URL) || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const SCRIPT = `/admin/parking.js?v=${ui.ASSETS.parking}`;
  const zoneName = (z) => (i18n.isAr() && z.name_ar ? z.name_ar : tx(z.name));
  // a secret for the short-lived pay tokens (found by plate), made once
  const secret = () => {
    let s = db.setting('prk_secret');
    if (!s) { s = crypto.randomBytes(24).toString('base64url'); db.setSetting('prk_secret', s); }
    return s;
  };
  const sign = (id, exp) => crypto.createHmac('sha256', secret()).update(`${id}.${exp}`).digest('base64url').slice(0, 32);
  const payToken = (s) => { const exp = Date.now() + 30 * 60000; return `${s.id}.${exp}.${sign(s.id, exp)}`; };
  const fromToken = (t) => {
    const [id, exp, mac] = String(t || '').split('.');
    if (!id || !exp || !mac || Number(exp) < Date.now()) return null;
    const want = sign(Number(id), Number(exp));
    return mac.length === want.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want)) ? P.sessionBy(Number(id)) : null;
  };
  // online checkout: Paymob once it is set up (sample visits and sandbox mode use the pretend one)
  const onlineReady = (s) => !!(h.payments && h.payments.begin && h.payments.providerFor({ demo: s.demo })) && (db.setting('currency') || 'EGP') === 'EGP';

  // ================= visitors =================
  const pub = express.Router();
  h.public.use('/parking', pub);
  pub.use(express.urlencoded({ extended: false, limit: '8kb' }));
  pub.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex');
    const q = String(req.query.lang || (req.body && req.body.lang) || '');
    req.lang = q === 'ar' || q === 'en' ? q : /^ar\b/i.test(String(req.get('accept-language') || '')) ? 'ar' : 'en';
    i18n.run(req.lang, next);
  });
  const findLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  function shell(req, res, { title, body, status = 200 }) {
    ui.setCurrency(db.setting('currency'));
    const other = req.lang === 'ar' ? 'en' : 'ar';
    const self = req.originalUrl.replace(/([?&])lang=(en|ar)(&|$)/, '$1').replace(/[?&]$/, '');
    res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="${req.lang}" dir="${req.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#283833">
<title>${esc(title)} · The Wave</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ui.ASSETS.css}">
</head>
<body class="adm portal paypage pk-public" data-lang="${req.lang}">
<main class="paywrap pk-wrap">
  <header class="paywrap__head"><a href="/parking${req.lang === 'ar' ? '?lang=ar' : ''}" aria-label="The Wave">${ui.logo('paywrap__logo')}</a><a class="langbtn" href="${esc(self)}${self.includes('?') ? '&' : '?'}lang=${other}" lang="${other}">${ui.icon('globe')}<span>${other === 'ar' ? 'العربية' : 'English'}</span></a></header>
  ${body}
  <p class="paywrap__foot">${ui.icon('car')}<span>${esc(tr('prk|The Wave · North 90, New Cairo'))}</span></p>
</main>
<script src="/admin/admin.js?v=${ui.ASSETS.js}" defer></script>
<script src="${SCRIPT}" defer></script>
</body>
</html>`);
  }
  const L = (req, p) => `${p}${req.lang === 'ar' ? `${p.includes('?') ? '&' : '?'}lang=ar` : ''}`;
  const findForm = (req, value = '', error = '') => `<form method="post" action="/parking/find" class="stack pk-find"><input type="hidden" name="lang" value="${req.lang}">
    ${error ? `<p class="alert alert--error">${esc(error)}</p>` : ''}
    ${ui.input('q', tr('prk|Your plate or ticket number'), value, { required: true, placeholder: tr('prk|e.g. ق ص ر 1234 or ABCD-2345'), attrs: { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' } })}
    ${ui.btn(esc(tr('prk|Find my car')), { cls: 'btn--primary btn--block', ic: 'search' })}</form>`;

  pub.get('/', (req, res) => {
    const o = P.occupancy();
    const t = P.tariffAt();
    const levels = `<div class="pk-signs" data-autoreload="60">${o.zones.map((z) => `<div class="pk-sign${z.free === 0 ? ' is-full' : z.capacity && z.free / z.capacity < 0.1 ? ' is-low' : ''}"><small>${esc(z.level || z.code)}</small><b>${z.free === 0 ? esc(tr('prk|Full')) : ui.n0(z.free)}</b><span>${esc(zoneName(z))}</span></div>`).join('')}</div>`;
    const rates = `<dl class="dl pk-rates">
      <div><dt>${esc(tr('prk|First hour'))}</dt><dd><b>${money(t.first_hour)}</b></dd></div>
      <div><dt>${esc(tr('prk|Each hour after'))}</dt><dd>${money(t.next_hour)}</dd></div>
      ${t.daily_cap ? `<div><dt>${esc(tr('prk|Most for one day'))}</dt><dd>${money(t.daily_cap)}</dd></div>` : ''}
      ${t.day_rate ? `<div><dt>${esc(tr('prk|Each full day (24 h)'))}</dt><dd>${money(t.day_rate)}</dd></div>` : ''}
      ${t.grace_min ? `<div><dt>${esc(tr('prk|Free minutes'))}</dt><dd>${esc(tr('prk|The first {n} minutes', { n: t.grace_min }))}</dd></div>` : ''}
      ${t.lost_fee ? `<div><dt>${esc(tr('prk|Lost ticket'))}</dt><dd>${money(t.lost_fee)}</dd></div>` : ''}</dl>
      ${t.kind === 'event' ? `<p class="alert alert--warn">${esc(tr('prk|Event prices today: {name}.', { name: tx(t.name) }))}</p>` : ''}
      <p class="muted small">${esc(tr('prk|Prices include VAT.'))}</p>`;
    const how = `<ol class="pk-how"><li>${ui.icon('car')}<span>${esc(tr('prk|Drive in. The camera reads your plate, or take a ticket.'))}</span></li><li>${ui.icon('store')}<span>${esc(tr('prk|Shopping with us? Show your ticket’s QR code or your plate at the till: participating stores make your parking free.'))}</span></li><li>${ui.icon('wallet')}<span>${esc(tr('prk|Pay by phone here, at a pay machine, or at the exit.'))}</span></li><li>${ui.icon('arrow')}<span>${esc(tr('prk|Drive out: the barrier opens by itself.'))}</span></li></ol>`;
    shell(req, res, {
      title: tr('prk|Parking'),
      body: `<section class="payhead"><p class="eyebrow">${esc(tr('prk|Parking at The Wave'))}</p><h1>${o.full ? esc(tr('prk|The car park is full right now')) : esc(tr('prk|{n} spaces free now', { n: ui.n0(o.free) }))}</h1></section>
${levels}
${ui.card(tr('prk|Find your car and pay'), findForm(req), { sub: esc(tr('prk|No app, no sign-in.')) })}
${ui.card(tr('prk|Prices'), rates)}
${ui.card(tr('prk|How it works'), how)}
${ui.card(tr('prk|Monthly parking'), `<p>${esc(tr('prk|Work nearby or visit often? Ask about a monthly subscription on your plate or an NFC card.'))}</p><p><a href="mailto:${esc(db.setting('leasing_email') || '')}">${esc(db.setting('leasing_email') || '')}</a></p>`)}`,
    });
  });
  pub.post('/find', findLimit, (req, res) => {
    const q = String(req.body.q || '').slice(0, 60);
    const c = P.readCredential(q);
    const byCode = c.code ? P.byCode(c.code) : null;
    if (byCode) return res.redirect(303, L(req, `/parking/t/${P.codeShow(byCode.code)}`));
    const s = c.plate && c.plate.length >= 3 ? P.findInside({ plate: c.plate }) : null;
    if (!s) return shell(req, res, { status: 404, title: tr('prk|Parking'), body: ui.card(tr('prk|Find your car and pay'), findForm(req, q, tr('prk|We could not find a car parked with that plate or ticket. Check it and try again, or ask at the exit booth.'))) });
    // found by plate: only what is due (no times), and a short-lived token to pay it
    const qt = P.quoteOf(s);
    shell(req, res, { title: tr('prk|Parking'), body: payBody(req, s, qt, { token: payToken(s), byPlate: true }) });
  });
  function payBody(req, s, q, { token = null, byPlate = false, paid = null, error = '' } = {}) {
    const methods = [['card', tr('por|Bank card'), tr('por|Visa, Mastercard or Meeza'), 'wallet'], ['wallet', tr('por|Mobile wallet'), tr('por|Vodafone Cash, Orange, Etisalat, WE Pay'), 'phone']];
    const can = s.status === 'inside' && s.kind === 'visitor' && q.due > 0 && onlineReady(s);
    const action = token ? '/parking/pay' : `/parking/t/${P.codeShow(s.code)}/pay`;
    const form = can ? `<form method="post" action="${action}" class="stack paycard"><input type="hidden" name="lang" value="${req.lang}">${token ? `<input type="hidden" name="token" value="${esc(token)}">` : ''}
      <fieldset class="paymethods"><legend class="f__l">${esc(tr('por|How would you like to pay?'))}</legend>${methods.map(([m, l, hint, ic], i) => `<label class="paymethod"><input type="radio" name="method" value="${m}"${i === 0 ? ' checked' : ''}>${ui.icon(ic)}<span><b>${esc(l)}</b><small>${esc(hint)}</small></span></label>`).join('')}</fieldset>
      ${ui.input('wallet_phone', tr('por|Wallet mobile number'), '', { type: 'tel', placeholder: '01XXXXXXXXX', hint: tr('por|Only for mobile wallet payments.'), attrs: { inputmode: 'tel', autocomplete: 'tel' } })}
      ${ui.btn(esc(tr('prk|Pay {amount}', { amount: money(q.due) })), { cls: 'btn--primary btn--block', ic: 'shield' })}
      <p class="muted small">${esc(tr('prk|After paying you have {n} minutes to reach the exit.', { n: (q.tariff || T.DEFAULT).exit_min }))}</p></form>` : '';
    const state = s.status !== 'inside'
      ? `<p class="alert alert--ok">${esc(tr('prk|This visit is closed. Thank you for visiting The Wave.'))}</p>`
      : s.kind !== 'visitor'
        ? `<p class="alert alert--ok">${esc(tr('prk|You park on a subscription: nothing to pay.'))}</p>`
        : q.due <= 0
          ? `<div class="pk-paid">${ui.icon('check')}<div><b>${esc(q.whole ? tr('prk|Your parking is free today.') : q.inExitWindow ? tr('prk|Paid. Thank you.') : tr('prk|Nothing to pay.'))}</b><small>${esc(q.inExitWindow ? tr('prk|Please drive to the exit within {n} minutes.', { n: (q.tariff || T.DEFAULT).exit_min }) : tr('prk|Drive to the exit: the barrier opens by itself.'))}</small></div></div>`
          : !can ? `<p class="alert alert--warn">${esc(tr('prk|Pay at a pay machine or at the exit booth.'))}</p>` : '';
    return `<section class="payhead"><p class="eyebrow">${esc(tr('prk|Your parking'))}</p>${s.plate ? `<p>${`<span class="pk-plate pk-plate--big"><i aria-hidden="true">EGYPT · مصر</i><bdi>${esc(s.plate)}</bdi></span>`}</p>` : ''}</section>
${paid === 1 ? `<p class="alert alert--ok">${esc(tr('prk|Payment received. Thank you.'))}</p>` : paid === 0 ? `<p class="alert alert--error">${esc(tr('prk|The payment did not go through. Nothing was charged.'))}</p>` : ''}
${error ? `<p class="alert alert--error">${esc(error)}</p>` : ''}
<section class="card paycard"><div class="card__body stack">
  ${byPlate ? '' : `<dl class="dl"><div><dt>${esc(tr('prk|Came in'))}</dt><dd>${esc(ui.dt(s.entry_at))}</dd></div><div><dt>${esc(tr('prk|Time parked'))}</dt><dd><b>${esc(dur(q.minutes))}</b></dd></div></dl>`}
  ${s.kind === 'visitor' && s.status === 'inside' ? `<dl class="pk-bill"><div><dt>${esc(tr('prk|Parking'))}</dt><dd>${money(q.gross)}</dd></div>${q.free ? `<div><dt>${esc(q.whole ? tr('prk|Validated by a store: free') : tr('prk|Validated: {time} free', { time: dur(q.freeMin) }))}</dt><dd>− ${money(q.free)}</dd></div>` : ''}${q.paid ? `<div><dt>${esc(tr('prk|Paid'))}</dt><dd>− ${money(q.paid)}</dd></div>` : ''}<div class="pk-bill__due"><dt>${esc(tr('prk|To pay now'))}</dt><dd>${money(q.due)}</dd></div></dl>` : ''}
  ${state}${form}
</div></section>`;
  }
  pub.get('/t/:code', (req, res, next) => {
    const s = P.byCode(String(req.params.code));
    if (!s) return next();
    const q = P.quoteOf(s);
    const paid = req.query.paid === '1' ? 1 : req.query.paid === '0' ? 0 : null;
    const ticket = s.status === 'inside' && s.kind === 'visitor' ? ui.card(tr('prk|Your ticket'), `<div class="pk-qrbox">${qr.svg(`${site(req)}/parking/t/${P.codeShow(s.code)}`, { ecl: 'M', label: tr('prk|Ticket {code}', { code: P.codeShow(s.code) }), cls: 'pk-qr' })}<p class="pk-ticket__code ltr">${esc(P.codeShow(s.code))}</p><p class="muted small">${esc(tr('prk|Shopping? Show this code at the till: participating stores validate your parking.'))}</p></div>`) : '';
    shell(req, res, { title: tr('prk|Your parking'), body: `<div data-autoreload="60"></div>${payBody(req, s, q, { paid })}${ticket}` });
  });
  const startPay = async (req, res, s, back) => {
    try {
      res.redirect(303, await P.payOnline(s, { method: req.body.method === 'wallet' ? 'wallet' : 'card', walletPhone: req.body.wallet_phone, lang: req.lang }));
    } catch (e) {
      shell(req, res, { status: 422, title: tr('prk|Your parking'), body: payBody(req, s, P.quoteOf(s), { ...back, error: tr(e.message, e.params) }) });
    }
  };
  pub.post('/t/:code/pay', findLimit, (req, res, next) => {
    const s = P.byCode(String(req.params.code));
    if (!s) return next();
    return startPay(req, res, s, {});
  });
  pub.post('/pay', findLimit, (req, res) => {
    const s = fromToken(req.body.token);
    if (!s) return shell(req, res, { status: 410, title: tr('prk|Parking'), body: ui.card(tr('prk|Find your car and pay'), findForm(req, '', tr('prk|That page has expired. Find your car again.'))) });
    return startPay(req, res, s, { token: req.body.token, byPlate: true });
  });

  // ================= the gates =================
  const api = express.Router();
  h.public.use('/ingest/parking', api);
  const gateLimit = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false });
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  api.use(gateLimit, express.json({ limit: '64kb', verify: (req, res, buf) => { req.rawBody = buf; } }), (req, res, next) => {
    const key = env('PARKING_API_KEY');
    if (!key) return res.status(503).json({ ok: false, error: 'Parking gates are not configured (PARKING_API_KEY).' });
    const sent = String(req.get('x-api-key') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '')).trim();
    if (!sent || !same(hash(sent), hash(key))) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const sec = env('PARKING_HMAC_SECRET');
    if (sec && req.method === 'POST') {
      const sig = String(req.get('x-signature') || '').replace(/^sha256=/i, '').trim().toLowerCase();
      const want = crypto.createHmac('sha256', sec).update(req.rawBody || Buffer.alloc(0)).digest('hex');
      if (!/^[0-9a-f]{64}$/.test(sig) || !same(sig, want)) return res.status(401).json({ ok: false, error: 'Bad signature' });
    }
    req.body = req.body && typeof req.body === 'object' ? req.body : {};
    return next();
  });
  const when = (v) => {
    const t = v ? Date.parse(v) : NaN;
    // a gate's clock may be off: accept its time only within a day of ours
    return Number.isFinite(t) && Math.abs(t - Date.now()) < 86400000 ? new Date(t).toISOString() : new Date().toISOString();
  };
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  api.post('/gate', (req, res) => {
    const b = req.body;
    const lane = P.laneBy(str(b.lane, 20));
    if (!lane) return res.status(422).json({ ok: false, error: 'Unknown lane. Add it under Parking → Set-up → Gates.' });
    if (!lane.active) return res.status(409).json({ ok: false, error: 'This lane is switched off in the office.' });
    const event = b.event === 'exit' || (b.event !== 'entry' && lane.direction === 'out') ? 'exit' : 'entry';
    const photo = /^https:\/\/\S+$/.test(str(b.photo_url, 500)) ? str(b.photo_url, 500) : null;
    const at = when(b.time);
    const r = event === 'entry'
      ? P.entry({ lane, plate: str(b.plate, 30), card: str(b.card, 40), via: b.card ? 'card' : b.plate ? 'anpr' : 'ticket', at, photo })
      : P.exit({ lane, plate: str(b.plate, 30), card: str(b.card, 40), code: str(b.ticket, 20).replace(/^.*\/parking\/t\//, ''), at, photo });
    const s = r.session || null;
    res.json({
      ok: true, open: !!r.open, reason: r.reason || null, message: P.message(r, i18n),
      ticket: s ? P.codeShow(s.code) : null, ticket_url: s && event === 'entry' ? `${site(req)}/parking/t/${P.codeShow(s.code)}` : null,
      print: !!(event === 'entry' && r.open && s && s.kind === 'visitor' && !s.plate_key && lane.prints),
      visit: s ? s.ref : null, kind: s ? s.kind : null, due: r.due || 0,
    });
  });
  // what a pay machine shows before taking money
  api.get('/quote', (req, res) => {
    const s = P.findInside(P.readCredential(str(req.query.ticket || req.query.card || req.query.plate, 60)));
    if (!s) return res.status(404).json({ ok: false, error: 'No car inside matches.' });
    const q = P.quoteOf(s);
    res.json({ ok: true, ticket: P.codeShow(s.code), plate: s.plate, entered: s.entry_at, minutes: q.minutes, price: q.gross, validated: q.free, paid: q.paid, due: q.due, exit_minutes: (q.tariff || T.DEFAULT).exit_min });
  });
  api.post('/pay', (req, res) => {
    const b = req.body;
    const device = str(b.device, 30);
    if (!device) return res.status(422).json({ ok: false, error: 'Send the machine’s device id.' });
    const s = P.findInside(P.readCredential(str(b.ticket || b.card || b.plate, 60)));
    if (!s) return res.status(404).json({ ok: false, error: 'No car inside matches.' });
    const ref = str(b.reference, 80) || null;
    if (ref && db.get('SELECT id FROM pk_payments WHERE reference = ? AND session_id = ?', ref, s.id)) return res.json({ ok: true, duplicate: true, due: P.quoteOf(s).due });
    try {
      const till = P.machineTill(device);
      const method = ['cash', 'card', 'wallet', 'instapay'].includes(b.method) ? b.method : 'card';
      const p = P.pay(s, { amount: Number(b.amount), method, till, device, reference: ref });
      res.json({ ok: true, receipt: p.ref, paid: p.amount, due: P.quoteOf(P.sessionBy(s.id)).due, exit_minutes: (P.tariffOf(s) || T.DEFAULT).exit_min });
    } catch (e) {
      res.status(422).json({ ok: false, error: i18n.run('en', () => tr(e.message, e.params)) });
    }
  });
  api.post('/levels', (req, res) => {
    const list = Array.isArray(req.body.levels) ? req.body.levels.slice(0, 50) : [];
    let n = 0;
    for (const l of list) {
      const z = db.get('SELECT id FROM pk_zones WHERE code = ?', str(l && l.zone, 12).toUpperCase());
      const cars = Number(l && l.cars);
      if (z && Number.isFinite(cars) && cars >= 0) { db.run('UPDATE pk_zones SET counted = ?, counted_at = ? WHERE id = ?', Math.round(cars), new Date().toISOString(), z.id); n++; }
    }
    res.json({ ok: true, updated: n });
  });
  api.get('/status', (req, res) => {
    const o = P.occupancy();
    res.json({ ok: true, capacity: o.capacity, cars: o.cars, free: o.free, full: o.full, levels: o.zones.map((z) => ({ zone: z.code, name: z.name, capacity: z.capacity, cars: z.cars, free: z.free })) });
  });

  // ================= shops: validate in the tenant portal =================
  if (h.portal && h.portal.router && h.portal.requireTenant) {
    const Pt = h.portal;
    const pr = Pt.router;
    const need = Pt.requireTenant;
    const brandOf = (req) => (Pt.brandId ? Pt.brandId(req) : req.tenant.brand_id);
    const pBack = (req, res, url, type, text) => (Pt.back ? Pt.back(req, res, url, type, text) : res.redirect(303, url));
    const month = () => cairo().date.slice(0, 7);
    Pt.tab({ key: 'parking', href: '/portal/parking', label: 'prk|Parking', icon: 'car', order: 35 });
    pr.get('/parking', need, (req, res) => {
      const bid = brandOf(req);
      const rule = P.ruleFor(bid);
      const csrf = req.psession.csrf;
      const q = String(req.query.q || '').slice(0, 200);
      let found = '';
      if (q) {
        const c = P.readCredential(q);
        const s = P.findInside(c);
        if (!s || s.kind !== 'visitor') {
          found = `<p class="alert alert--warn">${esc(s ? tr('prk|This car parks on a subscription: nothing to validate.') : tr('prk|No car parked now matches. Check the code or the plate.'))}</p>`;
        } else {
          const qt = P.quoteOf(s);
          const done = db.get("SELECT * FROM pk_validations WHERE session_id = ? AND brand_id = ? AND status = 'ok'", s.id, bid);
          found = `<section class="card pk-visit"><header class="pk-visit__head"><span class="pk-plate pk-plate--big"><i aria-hidden="true">EGYPT · مصر</i><bdi>${esc(s.plate || P.codeShow(s.code))}</bdi></span><div class="pk-visit__ids"><b class="pk-code ltr">${esc(P.codeShow(s.code))}</b><small>${esc(tr('prk|Parked for {time}', { time: dur(qt.minutes) }))}</small></div></header><div class="card__body stack">
            ${done ? `<p class="alert alert--ok">${esc(tr('prk|Already validated by your store.'))}</p>` : qt.whole ? `<p class="alert alert--ok">${esc(tr('prk|This visit is already free.'))}</p>` : `<form method="post" action="/portal/parking/validate" class="stack"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="code" value="${esc(s.code)}"><input type="hidden" name="via" value="${esc(String(req.query.via || 'code').slice(0, 10))}">
              <div class="fields">${ui.input('purchase', tr('prk|Purchase amount'), '', { type: 'number', min: 0, step: '0.01', required: rule.min_purchase > 0, hint: rule.min_purchase > 0 ? tr('prk|At least {amount} to validate.', { amount: money(rule.min_purchase) }) : tr('prk|Optional.') })}${ui.input('receipt', tr('prk|Receipt number'), '', { attrs: { autocomplete: 'off' } })}</div>
              ${ui.btn(esc(rule.minutes ? tr('prk|Validate {time} free', { time: dur(rule.minutes) }) : tr('prk|Validate: parking free')), { cls: 'btn--primary btn--block', ic: 'check' })}</form>`}
          </div></section>`;
        }
      }
      const used = db.get("SELECT COUNT(*) n, COALESCE(SUM(value), 0) v, COALESCE(SUM(value * share / 100.0), 0) mine FROM pk_validations WHERE brand_id = ? AND status = 'ok' AND substr(at, 1, 7) = ?", bid, month());
      const recent = db.all("SELECT v.*, s.plate, s.code FROM pk_validations v JOIN pk_sessions s ON s.id = v.session_id WHERE v.brand_id = ? ORDER BY v.at DESC LIMIT 15", bid);
      const permits = db.all("SELECT * FROM pk_permits WHERE brand_id = ? AND status IN ('active','suspended') ORDER BY name", bid);
      const ruleText = rule.active
        ? [rule.minutes ? tr('prk|Each validation gives {time} free.', { time: dur(rule.minutes) }) : tr('prk|Each validation makes the whole visit free.'), rule.min_purchase ? tr('prk|For purchases from {amount}.', { amount: money(rule.min_purchase) }) : null,
          rule.payer === 'tenant' ? tr('prk|Your store is billed for it each month.') : rule.payer === 'split' ? tr('prk|Your store pays {n}% of it, billed each month.', { n: rule.share }) : tr('prk|The mall pays for it.'),
          rule.monthly_cap ? tr('prk|{n} of {cap} validations used this month.', { n: used.n, cap: rule.monthly_cap }) : null].filter(Boolean).join(' ')
        : tr('prk|Parking validation is not switched on for your store. Ask the mall management.');
      const scan = rule.active ? `<form method="get" action="/portal/parking" class="pk-scan" data-scan data-msg-cam="${esc(tr('prk|Point the camera at the ticket’s QR code.'))}" data-msg-nfc="${esc(tr('prk|Hold the card against the back of the phone.'))}" data-msg-err="${esc(tr('prk|This device could not start the reader.'))}">
        <label class="pk-scan__in">${ui.icon('search')}<input type="search" name="q" value="${esc(q)}" placeholder="${esc(tr('prk|Scan the QR, tap the card or type the plate'))}" aria-label="${esc(tr('prk|Scan the QR, tap the card or type the plate'))}" autocomplete="off" autocapitalize="characters" spellcheck="false" autofocus data-scan-input></label><input type="hidden" name="via" value="code" data-scan-via>
        <button type="button" class="btn btn--ghost pk-scan__cam" data-scan-camera hidden>${ui.icon('cam')}<span>${esc(tr('prk|Camera'))}</span></button>
        <button type="button" class="btn btn--ghost pk-scan__nfc" data-scan-nfc hidden>${ui.icon('nfc')}<span>${esc(tr('prk|NFC'))}</span></button>
        <button class="btn btn--primary">${esc(tr('prk|Find'))}</button>
        <div class="pk-scan__video" data-scan-video hidden><video playsinline muted></video><button type="button" class="iconbtn" data-scan-stop aria-label="${esc(tr('mob|Close'))}">${ui.icon('x')}</button></div>
        <p class="pk-scan__msg" data-scan-msg hidden></p></form>` : '';
      const recentList = recent.length ? `<ul class="list pk-list">${recent.map((v) => `<li><span class="what"><b><bdi>${esc(v.plate || P.codeShow(v.code))}</bdi></b><small>${esc([ui.dt(v.at), v.receipt_ref ? `#${v.receipt_ref}` : null, v.purchase ? money(v.purchase) : null].filter(Boolean).join(' · '))}</small></span>${v.status === 'ok' ? (v.value ? `<b>${money(v.value)}</b>` : ui.badge('ok', tr('prk|Validated'), 'ok')) : ui.badge('void', tr('prk|Removed'), 'mute')}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|No validations yet.'))}</p>`;
      const staff = permits.length ? `<ul class="list pk-list">${permits.map((p) => `<li><span class="what"><b>${esc(tx(p.name))}</b><small><bdi>${esc(p.plates || p.card_uid || '')}</bdi>${p.ends_on ? ` · ${esc(tr('prk|until {date}', { date: ui.date(p.ends_on) }))}` : ''}</small></span>${p.status === 'active' ? ui.badge('active', tr('prk|Active'), 'ok') : ui.badge('suspended', tr('prk|Suspended'), 'amber')}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|Ask the mall management for monthly parking for your team.'))}</p>`;
      const kpis = `<div class="kpis kpis--3">${ui.kpi({ label: tr('prk|Validated this month'), value: ui.n0(used.n) })}${ui.kpi({ label: tr('prk|Parking given free'), value: money(T.r2(used.v)) })}${ui.kpi({ label: tr('prk|Your store’s share'), value: money(T.r2(used.mine)) })}</div>`;
      Pt.page(req, res, {
        title: tr('prk|Parking validation'), active: 'parking',
        body: `<p class="muted">${esc(ruleText)}</p>${kpis}<div class="grid grid--side"><div class="stack">${scan}${found}</div><div class="stack">${ui.card(tr('prk|Latest validations'), recentList)}${ui.card(tr('prk|Your team’s subscriptions'), staff)}</div></div><script src="${SCRIPT}" defer></script>`,
      });
    });
    pr.post('/parking/validate', need, (req, res) => {
      const bid = brandOf(req);
      const s = P.byCode(String(req.body.code || ''));
      const via = { qr: 'qr', nfc: 'nfc', plate: 'plate' }[req.body.via] || 'code';
      try {
        const r = P.validate(s, { brandId: bid, via, purchase: req.body.purchase === '' ? null : Number(req.body.purchase), receipt: String(req.body.receipt || '').trim().slice(0, 40) || null, portalUser: req.tenant });
        db.audit(null, 'Shop validated parking', 'pk_session', s.id, `${s.ref} · ${req.brand ? req.brand.name : ''}`, req.ip);
        pBack(req, res, '/portal/parking', 'ok', r.quote.due > 0 ? tr('prk|Validated. {amount} left to pay.', { amount: money(r.quote.due) }) : tr('prk|Validated: parking is free for this visit.'));
      } catch (e) {
        pBack(req, res, s ? `/portal/parking?q=${encodeURIComponent(P.codeShow(s.code))}` : '/portal/parking', 'error', tr(e.message, e.params));
      }
    });
  }
};
