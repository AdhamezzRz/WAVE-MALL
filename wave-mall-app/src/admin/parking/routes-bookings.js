'use strict';

// Booked spaces and subscriptions sold online.
//
// Bookings: a visitor books a space for a day and a few hours (a concert, a Friday evening, a VIP
// night) on /parking/book and pays online; the office books for guests at /admin/parking/bookings.
// A booked space is one of the bays set aside "for bookings" on the floor plan. The price is the
// parking for the booked hours (at that day's prices, event prices included) plus a booking fee.
// At the gate the plate is recognised from a little before the booking starts: the booked hours are
// already paid, any time after them is charged as usual. A booking nobody arrives for is released
// after a while (a no-show); one never paid is cancelled.
//
// Online subscriptions: plans marked "sold online" can be bought on /parking/subscribe. The first
// period is paid online; the subscription starts once it is paid, and the subscriber gets a private
// page (/parking/my/…) to see it, change plates, pay renewals and print receipts.

const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const T = require('./tariff');
const qr = require('../qr');
const { publicRouter, shell, cairoToUtc } = require('./shell');

const { t: tr, tn, tx, isAr } = i18n;
const B_STATUS = {
  pending: ['prk|Waiting for payment', 'sky'], confirmed: ['prk|Confirmed', 'ok'], arrived: ['prk|Arrived', 'forest'],
  completed: ['prk|Completed', 'mute'], no_show: ['prk|Did not come', 'rose'], cancelled: ['prk|Cancelled', 'mute'],
};
const LIVE = ['pending', 'confirmed', 'arrived'];
const SLOTS = Array.from({ length: 36 }, (_, i) => `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`); // 06:00 … 23:30

module.exports = function bookingRoutes(router, h, c) {
  const { db, ui } = h;
  const { P, esc } = c;
  const now = () => new Date().toISOString();
  const r2 = T.r2;
  const page = shell(h);
  const badge = (s) => ui.badge(s, tr((B_STATUS[s] || [s])[0]), (B_STATUS[s] || [])[1]);
  const fee = () => Math.max(0, Number(db.setting('prk_booking_fee') || 30));
  const maxHours = () => Math.max(1, Number(db.setting('prk_booking_max_hours') || 8));
  const bookingBy = (id) => db.get('SELECT b.*, y.code bay_code, z.code zone_code FROM pk_bookings b LEFT JOIN pk_bays y ON y.id = b.bay_id LEFT JOIN pk_zones z ON z.id = b.zone_id WHERE b.id = ?', id);
  const byCode = (code) => db.get('SELECT b.*, y.code bay_code FROM pk_bookings b LEFT JOIN pk_bays y ON y.id = b.bay_id WHERE b.code = ?', String(code || '').toUpperCase().replace(/-/g, ''));
  const newCode = () => { let x = P.newCode(); while (byCode(x)) x = P.newCode(); return x; };
  const hours = (b) => Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 360000) / 10;

  // ---------- rules ----------
  // the bays set aside for bookings, and the first one free for a time window
  const bookable = () => db.all("SELECT * FROM pk_bays WHERE active = 1 AND kind = 'reserved' ORDER BY code");
  const overlapping = (a, b, except = 0) => db.all(`SELECT * FROM pk_bookings WHERE status IN (${LIVE.map(() => '?').join(',')}) AND starts_at < ? AND ends_at > ? AND id != ?`, ...LIVE, b, a, except);
  function freeBay(a, b, except = 0) {
    const taken = new Set(overlapping(a, b, except).map((x) => x.bay_id));
    return bookable().find((y) => !taken.has(y.id)) || null;
  }
  function priceFor(a, b) {
    const t = P.tariffAt(a);
    return r2(T.cost({ ...t, grace_min: 0 }, T.minutesBetween(a, b)) + fee());
  }
  // a booking, checked: { starts_at, ends_at, bay, price } or an error
  function plan({ date, time, hours: hrs }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !SLOTS.includes(time)) throw P.fail('prk|Choose the day and the time.');
    const h2 = Math.round(Number(hrs) * 2) / 2;
    if (!(h2 >= 1 && h2 <= maxHours())) throw P.fail('prk|Book between 1 and {n} hours.', { n: maxHours() });
    const starts = cairoToUtc(date, time, ui);
    if (Date.parse(starts) < Date.now() - 30 * 60000) throw P.fail('prk|That time has passed.');
    if (Date.parse(starts) > Date.now() + 60 * 86400000) throw P.fail('prk|Bookings open 60 days ahead.');
    const ends = new Date(Date.parse(starts) + h2 * 3600000).toISOString();
    const bay = freeBay(starts, ends);
    if (!bay) throw P.fail('prk|No space is free to book then. Try another time.');
    return { starts_at: starts, ends_at: ends, bay, price: priceFor(starts, ends) };
  }
  function book(v, { source = 'office', user = null, status = 'pending', demo = 0, at = now() } = {}) {
    const key = P.plateKey(v.plate);
    if (!key) throw P.fail('prk|Type the plate.');
    if (!String(v.name || '').trim()) throw P.fail('prk|Type your name.');
    const p = v.starts_at ? { starts_at: v.starts_at, ends_at: v.ends_at, bay: v.bay || freeBay(v.starts_at, v.ends_at), price: v.price ?? priceFor(v.starts_at, v.ends_at) } : plan(v);
    if (!p.bay) throw P.fail('prk|No space is free to book then. Try another time.');
    if (db.get(`SELECT id FROM pk_bookings WHERE plate_key = ? AND status IN (${LIVE.map(() => '?').join(',')}) AND starts_at < ? AND ends_at > ?`, key, ...LIVE, p.ends_at, p.starts_at)) throw P.fail('prk|This car already has a booking then.');
    return db.tx(() => {
      const id = Number(db.run(`INSERT INTO pk_bookings (ref, code, plate, plate_key, name, phone, email, zone_id, bay_id, starts_at, ends_at, price, status, source, note, user_id, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, db.nextRef('pk_bookings', 'PB', 5, true), newCode(), P.plateShow(v.plate), key, String(v.name).trim().slice(0, 80),
      v.phone || null, v.email || null, p.bay.zone_id, p.bay.id, p.starts_at, p.ends_at, p.price, status, source, v.note || null, user ? user.id : null, demo ? 1 : 0, at, at).lastInsertRowid);
      // what the booking costs, as an invoice to pay (online, or at the booth for office bookings)
      if (p.price > 0 && h.billing) {
        const inv = h.billing.createInvoice({ kind: 'parking', customer: String(v.name).trim(), total: p.price, vat_included: true, due_date: c.today(), note: `Parking booking ${db.value('SELECT ref FROM pk_bookings WHERE id = ?', id)}`, source: 'parking-booking', source_id: id, demo }, { user });
        db.run('UPDATE pk_bookings SET invoice_id = ? WHERE id = ?', inv.id, id);
      }
      return bookingBy(id);
    });
  }
  // paid online: confirmed
  h.events.on('payment.received', ({ invoice }) => {
    if (!invoice || invoice.source !== 'parking-booking' || invoice.status !== 'paid') return;
    db.run("UPDATE pk_bookings SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'pending'", now(), invoice.source_id);
  });
  (h.parkingReturns = h.parkingReturns || []).push((inv, q) => {
    if (inv.source === 'parking-booking') { const b = bookingBy(inv.source_id); return b ? `/parking/booking/${P.codeShow(b.code)}?${q}` : null; }
    if (inv.source === 'parking-permit') { const p = db.get('SELECT access_token FROM pk_permits WHERE id = ?', inv.source_id); return p && p.access_token ? `/parking/my/${p.access_token}?${q}` : null; }
    return null;
  });
  // unpaid bookings are released after 30 minutes; bookings nobody came for, after the hold time
  function sweep() {
    const out = { cancelled: 0, noShow: 0 };
    for (const b of db.all("SELECT * FROM pk_bookings WHERE status = 'pending' AND source = 'online' AND created_at < ?", new Date(Date.now() - 30 * 60000).toISOString())) {
      db.run("UPDATE pk_bookings SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), b.id);
      if (b.invoice_id && h.billing) h.billing.voidInvoice(b.invoice_id, { note: 'Parking booking not paid in time' });
      out.cancelled++;
    }
    const hold = Number(P.S('prk_booking_hold_min')) || 30;
    for (const b of db.all("SELECT id FROM pk_bookings WHERE status = 'confirmed' AND starts_at < ?", new Date(Date.now() - hold * 60000).toISOString())) {
      db.run("UPDATE pk_bookings SET status = 'no_show', updated_at = ? WHERE id = ?", now(), b.id);
      out.noShow++;
    }
    return out;
  }
  h.every('parking-bookings', 5 * 60 * 1000, sweep);
  h.parking.bookings = { book, plan, sweep, priceFor, freeBay };

  // ---------- the office ----------
  router.get('/parking/bookings', (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? req.query.day : c.today();
    const from = c.dayStart(day);
    const to = c.dayStart(P.addDays(day, 1));
    const rows = db.all('SELECT b.*, y.code bay_code FROM pk_bookings b LEFT JOIN pk_bays y ON y.id = b.bay_id WHERE b.starts_at < ? AND b.ends_at > ? ORDER BY b.starts_at', to, from);
    const month = day.slice(0, 7);
    const st = db.get(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status IN ('confirmed','arrived','completed','no_show') THEN price END), 0) revenue, SUM(status = 'no_show') no_show FROM pk_bookings WHERE substr(starts_at, 1, 7) = ?`, month);
    const bays = bookable().length;
    const kpis = [
      ui.kpi({ label: tr('prk|Bookings this day'), value: ui.n0(rows.filter((b) => b.status !== 'cancelled').length), sub: esc(tr('prk|{n} spaces for bookings', { n: bays })) }),
      ui.kpi({ label: tr('prk|Arrived'), value: ui.n0(rows.filter((b) => ['arrived', 'completed'].includes(b.status)).length) }),
      ui.kpi({ label: tr('prk|Booked this month'), value: c.money(st.revenue), sub: esc(tn(st.n, 'prk|{n} booking', 'prk|{n} bookings')) }),
      ui.kpi({ label: tr('prk|Did not come this month'), value: ui.n0(st.no_show || 0) }),
    ].join('');
    // the day as a timeline of the bookable bays
    const H0 = 8;
    const H1 = 24;
    const line = bays ? `<div class="pkb-day">${bookable().map((y) => {
      const mine = rows.filter((b) => b.bay_id === y.id && b.status !== 'cancelled');
      return `<div class="pkb-row"><span class="pkb-bay">${esc(y.code)}</span><div class="pkb-track">${mine.map((b) => {
        const a = Math.max(H0, Number(ui.local(b.starts_at).slice(11, 13)) + Number(ui.local(b.starts_at).slice(14, 16)) / 60);
        const e = Math.min(H1, c.cairoDate(b.ends_at) > day ? H1 : Number(ui.local(b.ends_at).slice(11, 13)) + Number(ui.local(b.ends_at).slice(14, 16)) / 60);
        return `<a class="pkb-slot pkb-slot--${b.status}" href="/admin/parking/bookings/${b.id}" style="inset-inline-start:${(((a - H0) / (H1 - H0)) * 100).toFixed(2)}%;width:${(((e - a) / (H1 - H0)) * 100).toFixed(2)}%" title="${esc(`${b.plate} · ${ui.local(b.starts_at).slice(11, 16)}–${ui.local(b.ends_at).slice(11, 16)}`)}"><bdi>${esc(b.plate || '')}</bdi></a>`;
      }).join('')}</div></div>`;
    }).join('')}<div class="pkb-row pkb-row--hours"><span></span><div class="pkb-track">${Array.from({ length: (H1 - H0) / 2 + 1 }, (_, i) => `<i style="inset-inline-start:${((i * 2 / (H1 - H0)) * 100).toFixed(2)}%">${String(H0 + i * 2).padStart(2, '0')}</i>`).join('')}</div></div></div>` : ui.empty(tr('prk|Set some bays aside "for bookings" on the floor plan first.'), ui.btn(esc(tr('prk|Open the floor plan')), { href: '/admin/parking/floor', cls: 'btn--ghost btn--sm' }));
    const table = ui.table([
      { label: tr('prk|Booking'), render: (b) => `<b>${esc(b.name)}</b><small class="sub">${esc(b.ref)}</small>` },
      { label: tr('prk|Plate'), render: (b) => c.plate(b.plate, 'pk-plate--sm') },
      { label: tr('prk|Time'), render: (b) => esc(`${ui.local(b.starts_at).slice(11, 16)}–${ui.local(b.ends_at).slice(11, 16)}`) },
      { label: tr('prk|Bay'), render: (b) => esc(b.bay_code || '—') },
      { label: tr('prk|Price'), num: true, render: (b) => c.money(b.price) },
      { label: tr('Status'), render: (b) => badge(b.status) },
    ], rows, { href: (b) => `/admin/parking/bookings/${b.id}`, empty: esc(tr('prk|No bookings this day.')) });
    const pick = `<form method="get" class="filters">${ui.input('day', tr('prk|Day'), day, { type: 'date' })}${ui.btn(esc(tr('prk|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    const form = h.can(req, 'agent') ? ui.card(tr('prk|Book for a guest'), ui.form('/admin/parking/bookings', req.session.csrf, `<div class="fields">
      ${ui.input('date', tr('prk|Day'), day, { type: 'date', required: true })}${ui.select('time', tr('prk|Arrives at'), SLOTS.map((x) => [x, x]), '19:00')}
      ${ui.input('hours', tr('prk|Hours'), 3, { type: 'number', min: 1, max: maxHours(), step: '0.5', required: true })}${ui.input('plate', tr('prk|Plate'), '', { required: true })}
      ${ui.input('name', tr('Name'), '', { required: true })}${ui.input('phone', tr('prk|Mobile'), '', { type: 'tel' })}
      ${ui.select('pay', tr('prk|Payment'), [['link', tr('prk|Send the payment link')], ['invoice', tr('prk|Invoice now, collect later')], ['free', tr('prk|Free (a guest of the mall)')]], 'link')}
      ${ui.input('note', tr('prk|Notes'), '', { placeholder: tr('prk|e.g. Guest of the management, concert night') })}</div>${ui.btn(esc(tr('prk|Book')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }), { sub: esc(tr('prk|Online bookings: {link}', { link: `${c.site(req)}/parking/book` })) }) : '';
    c.page(req, res, { title: tr('prk|Bookings'), crumbs: c.crumbs([null, tr('prk|Bookings')]), body: `${c.tabs('/admin/parking/bookings')}${pick}<div class="kpis kpis--4">${kpis}</div>${ui.card(tr('prk|The day'), line, { sub: esc(ui.date(day)) })}<div class="grid grid--side">${ui.card(tr('prk|Bookings'), table)}${form}</div>` });
  });
  // the office books: with a payment link to send (held until paid), invoiced to collect later, or free
  router.post('/parking/bookings', c.RA, (req, res) => {
    const pay = ['link', 'invoice', 'free'].includes(req.body.pay) ? req.body.pay : 'link';
    try {
      const p = plan({ date: req.body.date, time: req.body.time, hours: req.body.hours });
      const b = book({
        plate: h.str(req.body.plate, 30), name: h.str(req.body.name, 80), phone: h.str(req.body.phone, 30) || null, note: h.str(req.body.note, 300) || null,
        ...p, price: pay === 'free' ? 0 : p.price,
      }, { source: 'office', user: req.user, status: pay === 'link' ? 'pending' : 'confirmed' });
      h.log(req, 'Booked a parking space', 'pk_booking', b.id, `${b.ref} · ${b.plate} · ${b.bay_code}`);
      c.back(req, res, `/admin/parking/bookings/${b.id}`, 'ok', pay === 'link' ? tr('prk|Booked: bay {bay}. Send the guest the payment link.', { bay: b.bay_code }) : tr('prk|Booked: bay {bay}.', { bay: b.bay_code }));
    } catch (e) {
      c.fail(req, res, '/admin/parking/bookings', e);
    }
  });
  router.get('/parking/bookings/:id', (req, res, next) => {
    const b = bookingBy(h.int(req.params.id));
    if (!b) return next();
    const inv = b.invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', b.invoice_id) : null;
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('Name'))}</dt><dd>${esc(b.name)}${b.phone ? ` · ${esc(b.phone)}` : ''}${b.email ? ` · ${esc(b.email)}` : ''}</dd></div>
      <div><dt>${esc(tr('prk|Plate'))}</dt><dd>${c.plate(b.plate, 'pk-plate--sm')}</dd></div>
      <div><dt>${esc(tr('prk|When'))}</dt><dd>${esc(ui.dt(b.starts_at))} – ${esc(ui.local(b.ends_at).slice(11, 16))} · ${esc(tr('prk|{n} h', { n: hours(b) }))}</dd></div>
      <div><dt>${esc(tr('prk|Bay'))}</dt><dd>${b.bay_code ? `<a href="/admin/parking/floor?level=${esc(b.zone_code || '')}&bay=${esc(b.bay_code)}">${esc(b.bay_code)}</a>` : '—'}</dd></div>
      <div><dt>${esc(tr('prk|Price'))}</dt><dd>${c.money(b.price)}${inv ? ` · <a href="/admin/invoices/${inv.id}/print">${esc(inv.ref)}</a> ${ui.badge(inv.status, M_STATUS(inv.status))}` : ''}</dd></div>
      <div><dt>${esc(tr('prk|Booked'))}</dt><dd>${esc(b.source === 'online' ? tr('prk|On the website') : tr('prk|By the office'))} · ${esc(ui.dt(b.created_at))}</dd></div>
      ${b.session_id ? `<div><dt>${esc(tr('prk|Visit'))}</dt><dd><a href="/admin/parking/visits/${b.session_id}">${esc(db.value('SELECT ref FROM pk_sessions WHERE id = ?', b.session_id) || '')}</a></dd></div>` : ''}
      ${b.note ? `<div><dt>${esc(tr('prk|Notes'))}</dt><dd>${esc(b.note)}</dd></div>` : ''}</dl>`;
    const link = `${c.site(req)}/parking/booking/${P.codeShow(b.code)}`;
    const share = b.status === 'pending' ? `<p class="alert alert--warn">${esc(tr('prk|Waiting for payment. Send the guest this link:'))} <a class="ltr" href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a></p>` : '';
    const acts = h.can(req, 'agent') && ['pending', 'confirmed'].includes(b.status) ? `<div class="row">${ui.form(`/admin/parking/bookings/${b.id}/cancel`, req.session.csrf, ui.btn(esc(tr('prk|Cancel the booking')), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('prk|Cancel this booking? If it was paid, refund it from the invoice.') } }))}</div>` : '';
    c.page(req, res, { title: b.ref, crumbs: c.crumbs(['/admin/parking/bookings', tr('prk|Bookings')], [null, b.ref]), body: `<div class="grid grid--side"><div class="stack">${ui.card(b.ref, `${share}${facts}${acts}`, { action: badge(b.status) })}</div><div class="stack">${ui.card(tr('prk|Booking code'), `<div class="pk-qrbox">${qr.svg(`${c.site(req)}/parking/booking/${P.codeShow(b.code)}`, { ecl: 'M', cls: 'pk-qr' })}<p class="pk-ticket__code ltr">${esc(P.codeShow(b.code))}</p></div>`)}</div></div>` });
  });
  const M_STATUS = (s) => h.M.INVOICE_STATUS[s] || s;
  router.post('/parking/bookings/:id/cancel', c.RA, (req, res, next) => {
    const b = bookingBy(h.int(req.params.id));
    if (!b) return next();
    if (!['pending', 'confirmed'].includes(b.status)) return c.back(req, res, `/admin/parking/bookings/${b.id}`, 'error', tr('prk|This booking cannot be cancelled now.'));
    db.run("UPDATE pk_bookings SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), b.id);
    if (b.invoice_id && h.billing) h.billing.voidInvoice(b.invoice_id, { note: 'Parking booking cancelled' });
    h.log(req, 'Cancelled a parking booking', 'pk_booking', b.id, b.ref);
    c.back(req, res, `/admin/parking/bookings/${b.id}`, 'ok', tr('prk|Booking cancelled.'));
  });

  // ---------- visitors: book a space ----------
  const pub = publicRouter(h, '/parking');
  const limit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const days = () => Array.from({ length: 30 }, (_, i) => P.addDays(c.today(), i));
  const bookForm = (req, v = {}, error = '') => `${error ? `<p class="alert alert--error">${esc(error)}</p>` : ''}<form method="post" action="/parking/book" class="stack"><input type="hidden" name="lang" value="${req.lang}"><div class="fields">
    ${ui.select('date', tr('prk|Day'), days().map((d) => [d, ui.date(d)]), v.date || c.today())}
    ${ui.select('time', tr('prk|Arriving at'), SLOTS.map((x) => [x, x]), v.time || '19:00')}
    ${ui.select('hours', tr('prk|For'), [1, 2, 3, 4, 5, 6, 8].filter((x) => x <= maxHours()).map((x) => [x, tn(x, 'prk|{n} hour', 'prk|{n} hours')]), v.hours || 3)}
    ${ui.input('plate', tr('prk|Plate'), v.plate || '', { required: true, placeholder: 'ق ص ر 1234', attrs: { autocomplete: 'off' } })}
    ${ui.input('name', tr('Name'), v.name || '', { required: true, attrs: { autocomplete: 'name' } })}
    ${ui.input('phone', tr('prk|Mobile'), v.phone || '', { type: 'tel', required: true, attrs: { autocomplete: 'tel' } })}
    ${ui.input('email', tr('Email'), v.email || '', { type: 'email', attrs: { autocomplete: 'email' } })}</div>
    <p class="muted small">${esc(tr('prk|You pay for the booked hours and a booking fee of {fee}. Time after the booking is charged at the normal price.', { fee: ui.money(fee()) }))}</p>
    ${ui.btn(esc(tr('prk|Continue to payment')), { cls: 'btn--primary btn--block', ic: 'arrow' })}</form>`;
  pub.get('/book', (req, res) => {
    const free = bookable().length;
    page(req, res, { title: tr('prk|Book a parking space'), body: `<section class="payhead"><p class="eyebrow">${esc(tr('prk|Parking at The Wave'))}</p><h1>${esc(tr('prk|Book a parking space'))}</h1></section>${free ? ui.card(tr('prk|When are you coming?'), bookForm(req), { sub: esc(tr('prk|Your space is kept for you. The camera opens the gate for your plate.')) }) : `<p class="alert alert--warn">${esc(tr('prk|Online booking is not open right now.'))}</p>`}` });
  });
  pub.post('/book', limit, (req, res) => {
    const v = { date: String(req.body.date || ''), time: String(req.body.time || ''), hours: Number(req.body.hours) || 0, plate: String(req.body.plate || '').slice(0, 30), name: String(req.body.name || '').trim().slice(0, 80), phone: String(req.body.phone || '').trim().slice(0, 30), email: String(req.body.email || '').trim().slice(0, 160) };
    try {
      if (!/^[+\d\s-]{8,20}$/.test(v.phone)) throw P.fail('prk|Type your mobile number.');
      if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) throw P.fail('prk|Check the email address.');
      const b = book({ ...v, ...plan(v) }, { source: 'online' });
      db.audit(null, 'Parking booked online', 'pk_booking', b.id, `${b.ref} · ${b.plate}`, req.ip);
      res.redirect(303, `/parking/booking/${P.codeShow(b.code)}?lang=${req.lang}`);
    } catch (e) {
      page(req, res, { status: 422, title: tr('prk|Book a parking space'), body: ui.card(tr('prk|When are you coming?'), bookForm(req, v, tr(e.message, e.params))) });
    }
  });
  pub.get('/booking/:code', (req, res, next) => {
    const b = byCode(req.params.code);
    if (!b) return next();
    const inv = b.invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', b.invoice_id) : null;
    const payable = b.status === 'pending' && inv && ['open', 'partial'].includes(inv.status) && h.payments && h.payments.canPayOnline(inv);
    const paid = req.query.paid === '1' ? 1 : req.query.paid === '0' ? 0 : null;
    const methods = `<fieldset class="paymethods"><legend class="f__l">${esc(tr('por|How would you like to pay?'))}</legend>${[['card', tr('por|Bank card'), tr('por|Visa, Mastercard or Meeza'), 'wallet'], ['wallet', tr('por|Mobile wallet'), tr('por|Vodafone Cash, Orange, Etisalat, WE Pay'), 'phone']].map(([m, l, hint, ic], i) => `<label class="paymethod"><input type="radio" name="method" value="${m}"${i === 0 ? ' checked' : ''}>${ui.icon(ic)}<span><b>${esc(l)}</b><small>${esc(hint)}</small></span></label>`).join('')}</fieldset>${ui.input('wallet_phone', tr('por|Wallet mobile number'), b.phone || '', { type: 'tel', hint: tr('por|Only for mobile wallet payments.') })}`;
    const body = `<section class="payhead"><p class="eyebrow">${esc(tr('prk|Your booking'))}</p><h1>${esc(ui.dt(b.starts_at))}</h1></section>
${paid === 1 ? `<p class="alert alert--ok">${esc(tr('prk|Payment received. Your space is booked.'))}</p>` : paid === 0 ? `<p class="alert alert--error">${esc(tr('prk|The payment did not go through. Nothing was charged.'))}</p>` : ''}
<section class="card paycard"><div class="card__body stack">
  <dl class="dl"><div><dt>${esc(tr('prk|Plate'))}</dt><dd><bdi>${esc(b.plate)}</bdi></dd></div><div><dt>${esc(tr('prk|From'))}</dt><dd>${esc(ui.dt(b.starts_at))}</dd></div><div><dt>${esc(tr('prk|To'))}</dt><dd>${esc(ui.dt(b.ends_at))}</dd></div>
  <div><dt>${esc(tr('prk|Your space'))}</dt><dd><b>${esc(b.bay_code || '—')}</b></dd></div><div><dt>${esc(tr('prk|Price'))}</dt><dd>${c.money(b.price)}</dd></div><div><dt>${esc(tr('Status'))}</dt><dd>${badge(b.status)}</dd></div></dl>
  ${payable ? `<form method="post" action="/parking/booking/${P.codeShow(b.code)}/pay" class="stack"><input type="hidden" name="lang" value="${req.lang}">${methods}${ui.btn(esc(tr('prk|Pay {amount}', { amount: c.money(inv.total - inv.paid) })), { cls: 'btn--primary btn--block', ic: 'shield' })}<p class="muted small">${esc(tr('prk|The space is held for 30 minutes while you pay.'))}</p></form>` : ''}
  ${b.status === 'confirmed' ? `<p class="muted">${esc(tr('prk|Drive in from {time}: the camera reads your plate and opens the gate. Your space is kept until {hold} after the booking starts.', { time: ui.local(new Date(Date.parse(b.starts_at) - P.N('prk_booking_early_min') * 60000).toISOString()).slice(11, 16), hold: tn(P.N('prk_booking_hold_min'), 'prk|{n} minute', 'prk|{n} minutes') }))}</p>` : ''}
</div></section>
${['pending', 'confirmed'].includes(b.status) ? ui.card(tr('prk|Booking code'), `<div class="pk-qrbox">${qr.svg(`${c.site(req)}/parking/booking/${P.codeShow(b.code)}`, { ecl: 'M', cls: 'pk-qr' })}<p class="pk-ticket__code ltr">${esc(P.codeShow(b.code))}</p><p class="muted small">${esc(tr('prk|Keep this page. If the camera cannot read your plate, show the code at the gate.'))}</p></div>`) : ''}`;
    page(req, res, { title: tr('prk|Your booking'), body });
  });
  pub.post('/booking/:code/pay', limit, async (req, res, next) => {
    const b = byCode(req.params.code);
    if (!b) return next();
    const inv = b.invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', b.invoice_id) : null;
    if (b.status !== 'pending' || !inv || !h.payments) return res.redirect(303, `/parking/booking/${P.codeShow(b.code)}?lang=${req.lang}`);
    try {
      res.redirect(303, await h.payments.begin(inv, { method: req.body.method === 'wallet' ? 'wallet' : 'card', walletPhone: req.body.wallet_phone, source: 'parking-booking', lang: req.lang }));
    } catch (e) {
      res.redirect(303, `/parking/booking/${P.codeShow(b.code)}?lang=${req.lang}&paid=0`);
    }
  });

  // ================= subscriptions sold online =================
  const onlinePlans = () => db.all('SELECT p.*, (SELECT COUNT(*) FROM pk_permits x WHERE x.plan_id = p.id AND x.status IN (\'active\',\'pending\',\'suspended\')) used FROM pk_plans p WHERE p.active = 1 AND p.online = 1 AND p.price > 0 ORDER BY p.price');
  const planName = (p) => (isAr() && p.name_ar ? p.name_ar : tx(p.name));
  const planText = (p) => (isAr() && p.description_ar ? p.description_ar : p.description ? tx(p.description) : '');
  const soldOut = (p) => p.max_active && p.used >= p.max_active;
  const permitByToken = (t) => (/^[\w-]{20,60}$/.test(String(t)) ? db.get('SELECT p.*, pl.name plan_name, pl.name_ar plan_name_ar FROM pk_permits p LEFT JOIN pk_plans pl ON pl.id = p.plan_id WHERE p.access_token = ?', String(t)) : null);

  // the set-up card: which plans are sold online, and how many
  (h.parkingSetupCards = h.parkingSetupCards || []).push((req) => {
    const plans = db.all('SELECT * FROM pk_plans WHERE active = 1 AND price > 0 ORDER BY price');
    if (!plans.length) return '';
    const mgr = h.can(req, 'manager');
    return ui.card(tr('prk|Subscriptions sold online'), `${plans.map((p) => (mgr ? ui.form(`/admin/parking/plans/${p.id}/online`, req.session.csrf, `<p><b>${esc(planName(p))}</b> · ${c.money(p.price)}</p><div class="fields">${ui.input('max_active', tr('prk|At most (empty: no limit)'), p.max_active || '', { type: 'number', min: 1 })}${ui.input('description', tr('prk|What buyers read'), p.description || '', { placeholder: tr('prk|e.g. Monday to Sunday, any level, one car at a time') })}${ui.input('description_ar', tr('prk|In Arabic'), p.description_ar || '', { attrs: { dir: 'rtl' } })}</div><label class="check"><input type="checkbox" name="online" value="1"${p.online ? ' checked' : ''}> ${esc(tr('prk|Sold online'))}</label>${ui.btn(esc(tr('Save')), { cls: 'btn--ghost btn--xs' })}`, { cls: 'stack pk-plan-online' }) : `<p>${esc(planName(p))} · ${p.online ? ui.badge('on', tr('prk|Sold online'), 'ok') : ui.badge('off', tr('prk|Office only'), 'mute')}</p>`)).join('')}<p class="muted small">${esc(tr('prk|Buyers sign up at {link}', { link: `${c.site(req)}/parking/subscribe` }))}</p>`, { sub: esc(tr('prk|Plans people can buy on the website, paid online.')) });
  });
  router.post('/parking/plans/:id/online', c.RM, (req, res) => {
    db.run('UPDATE pk_plans SET online = ?, max_active = ?, description = ?, description_ar = ? WHERE id = ?', req.body.online === '1' ? 1 : 0, h.int(req.body.max_active) || null, h.str(req.body.description, 300) || null, h.str(req.body.description_ar, 300) || null, h.int(req.params.id));
    h.log(req, 'Changed an online parking plan', 'pk_plan', h.int(req.params.id), req.body.online === '1' ? 'online' : 'office only');
    c.back(req, res, '/admin/parking/setup', 'ok', tr('Saved.'));
  });

  const startOf = (choice) => (choice === 'next' ? `${P.addMonths(`${c.today().slice(0, 7)}-01`, 1)}` : c.today());
  const subForm = (req, v = {}, error = '') => {
    const plans = onlinePlans();
    return `${error ? `<p class="alert alert--error">${esc(error)}</p>` : ''}<form method="post" action="/parking/subscribe" class="stack"><input type="hidden" name="lang" value="${req.lang}">
    <fieldset class="paymethods"><legend class="f__l">${esc(tr('prk|Choose a plan'))}</legend>${plans.map((p, i) => `<label class="paymethod${soldOut(p) ? ' is-off' : ''}"><input type="radio" name="plan" value="${p.id}"${(v.plan ? Number(v.plan) === p.id : i === 0) && !soldOut(p) ? ' checked' : ''}${soldOut(p) ? ' disabled' : ''}>${ui.icon('car')}<span><b>${esc(planName(p))} · ${c.money(p.price)} ${esc(tn(p.months, 'prk|a month', 'prk|for {n} months'))}</b><small>${esc(soldOut(p) ? tr('prk|Sold out') : planText(p) || tn(p.cars, 'prk|{n} car at a time', 'prk|{n} cars at a time'))}</small></span></label>`).join('')}</fieldset>
    <div class="fields">${ui.input('plates', tr('prk|Plates'), v.plates || '', { required: true, placeholder: 'ق ص ر 1234', hint: tr('prk|Separate plates with commas.') })}
    ${ui.input('name', tr('Name'), v.name || '', { required: true, attrs: { autocomplete: 'name' } })}${ui.input('phone', tr('prk|Mobile'), v.phone || '', { type: 'tel', required: true, attrs: { autocomplete: 'tel' } })}
    ${ui.input('email', tr('Email'), v.email || '', { type: 'email', required: true, hint: tr('prk|We send your subscription page and invoices here.'), attrs: { autocomplete: 'email' } })}
    ${ui.select('start', tr('prk|Starts'), [['today', tr('prk|Today')], ['next', tr('prk|On the 1st of next month')]], v.start || 'today')}</div>
    <label class="check"><input type="checkbox" name="agree" value="1" required> ${esc(tr('prk|I agree that the subscription renews each period until I cancel it, and that it is for the plates above only.'))}</label>
    ${ui.btn(esc(tr('prk|Continue to payment')), { cls: 'btn--primary btn--block', ic: 'arrow' })}</form>`;
  };
  pub.get('/subscribe', (req, res) => {
    const plans = onlinePlans();
    page(req, res, { title: tr('prk|Monthly parking'), body: `<section class="payhead"><p class="eyebrow">${esc(tr('prk|Parking at The Wave'))}</p><h1>${esc(tr('prk|Monthly parking'))}</h1></section>${plans.length ? ui.card(tr('prk|Subscribe'), subForm(req), { sub: esc(tr('prk|The gate opens for your plate. No ticket, no queue.')) }) : `<p class="alert alert--warn">${esc(tr('prk|Subscriptions are sold at the parking office for now.'))}</p>`}` });
  });
  pub.post('/subscribe', limit, async (req, res) => {
    const v = { plan: h.int(req.body.plan), plates: String(req.body.plates || '').slice(0, 120), name: String(req.body.name || '').trim().slice(0, 80), phone: String(req.body.phone || '').trim().slice(0, 30), email: String(req.body.email || '').trim().slice(0, 160), start: req.body.start === 'next' ? 'next' : 'today' };
    const again = (msg, status = 422) => page(req, res, { status, title: tr('prk|Monthly parking'), body: ui.card(tr('prk|Subscribe'), subForm(req, v, msg)) });
    const plan = onlinePlans().find((p) => p.id === v.plan);
    if (!plan) return again(tr('prk|Choose a plan.'));
    if (soldOut(plan)) return again(tr('prk|That plan is sold out.'));
    if (req.body.agree !== '1') return again(tr('prk|Please agree to the terms.'));
    if (!v.name || !/^[+\d\s-]{8,20}$/.test(v.phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return again(tr('prk|Fill in your name, mobile and email.'));
    const plates = P.platesOf(v.plates);
    if (!plates.length) return again(tr('prk|Add a plate or a card number.'));
    if (plates.length > Math.max(1, plan.cars) + 1) return again(tr('prk|This plan is for up to {n} plates.', { n: plan.cars + 1 }));
    try {
      const starts = startOf(v.start);
      const out = db.tx(() => {
        const p = P.savePermit({ plan_id: plan.id, holder: 'individual', name: v.name, phone: v.phone, email: v.email, plates: plates.join(', '), price: plan.price, months: plan.months, cars: plan.cars, zone_id: plan.zone_id, starts_on: starts, auto_renew: true });
        const token = crypto.randomBytes(24).toString('base64url');
        db.run("UPDATE pk_permits SET status = 'pending', source = 'online', access_token = ?, next_bill_on = NULL WHERE id = ?", token, p.id);
        const end = P.addDays(P.addMonths(starts, plan.months), -1);
        const inv = h.billing.createInvoice({ kind: 'parking', customer: v.name, total: plan.price, vat_included: true, period_start: starts, period_end: end, due_date: c.today(), note: `Parking subscription ${p.ref} · ${plates.map(P.plateShow).join(', ')}`, source: 'parking-permit', source_id: p.id });
        return { p, token, inv };
      });
      db.audit(null, 'Parking subscription bought online', 'pk_permit', out.p.id, `${out.p.ref} · ${v.name}`, req.ip);
      res.redirect(303, await h.payments.begin(out.inv, { method: 'card', source: 'parking-permit', lang: req.lang }));
    } catch (e) {
      again(tr(e.message, e.params));
    }
  });
  // the first payment starts it; later payments of a suspended one restore it (reviewPermits)
  h.events.on('payment.received', ({ invoice }) => {
    if (!invoice || invoice.source !== 'parking-permit' || invoice.status !== 'paid') return;
    const p = db.get("SELECT * FROM pk_permits WHERE id = ? AND status = 'pending'", invoice.source_id);
    if (!p) return;
    db.run("UPDATE pk_permits SET status = 'active', next_bill_on = ?, updated_at = ? WHERE id = ?", P.addMonths(invoice.period_start || p.starts_on, p.months), now(), p.id);
    db.audit(null, 'Online parking subscription paid', 'pk_permit', p.id, p.ref);
    sendLink(p, 'welcome');
  });
  // the subscriber's link by email: when the subscription starts and when an invoice is due
  function sendLink(p, why) {
    if (!p.email || !p.access_token || p.demo || !h.mail || typeof h.mail.send !== 'function') return;
    const base = String((h.env && h.env.SITE_URL) || '').replace(/\/$/, '');
    if (!base) return;
    i18n.run('ar', () => {
      const link = `${base}/parking/my/${p.access_token}`;
      const subject = why === 'welcome' ? tr('prk|Your parking subscription at The Wave') : tr('prk|Your parking subscription invoice');
      const text = `${why === 'welcome' ? tr('prk|Your subscription {ref} is active. Your page, to change plates and pay renewals:', { ref: p.ref }) : tr('prk|A new invoice for your subscription {ref} is ready. Pay it here:', { ref: p.ref })}\n${link}`;
      Promise.resolve(h.mail.send({ to: p.email, subject, text, tag: 'parking' })).catch((e) => console.error('[parking] email:', e.message));
    });
  }
  h.events.on('invoice.created', ({ invoice }) => {
    if (!invoice || invoice.source !== 'parking-permit') return;
    const p = db.get("SELECT * FROM pk_permits WHERE id = ? AND source = 'online' AND status IN ('active','suspended')", invoice.source_id);
    if (p) sendLink(p, 'renewal');
  });
  // online sign-ups never paid are dropped after two hours
  h.every('parking-online-subscriptions', 30 * 60 * 1000, () => {
    for (const p of db.all("SELECT * FROM pk_permits WHERE status = 'pending' AND created_at < ?", new Date(Date.now() - 2 * 3600000).toISOString())) {
      db.run("UPDATE pk_permits SET status = 'cancelled', status_reason = 'unpaid', updated_at = ? WHERE id = ?", now(), p.id);
      for (const inv of db.all("SELECT id FROM invoices WHERE source = 'parking-permit' AND source_id = ? AND status = 'open' AND paid = 0", p.id)) h.billing.voidInvoice(inv.id, { note: 'Online subscription not paid' });
    }
  });

  // ---------- the subscriber's own page ----------
  pub.get('/my/:token', (req, res, next) => {
    const p = permitByToken(req.params.token);
    if (!p) return next();
    const invs = db.all("SELECT * FROM invoices WHERE source = 'parking-permit' AND source_id = ? AND status != 'void' ORDER BY due_date DESC LIMIT 24", p.id);
    const pays = db.all("SELECT y.* FROM payments y JOIN invoices i ON i.id = y.invoice_id WHERE i.source = 'parking-permit' AND i.source_id = ? AND y.status = 'received' ORDER BY y.date DESC LIMIT 24", p.id);
    const tok = esc(req.params.token);
    const paid = req.query.paid === '1' ? 1 : req.query.paid === '0' ? 0 : null;
    const changes = Math.max(0, 2 - (p.plate_changes || 0));
    const STATUS = { active: ['prk|Active', 'ok'], pending: ['prk|Waiting for payment', 'sky'], suspended: ['prk|Suspended: an invoice is not paid', 'amber'], cancelled: ['prk|Cancelled', 'mute'], expired: ['prk|Expired', 'mute'] };
    const open = invs.filter((i) => ['open', 'partial'].includes(i.status));
    const body = `<section class="payhead"><p class="eyebrow">${esc(tr('prk|Your parking subscription'))}</p><h1>${esc(isAr() && p.plan_name_ar ? p.plan_name_ar : tx(p.plan_name || p.ref))}</h1></section>
${paid === 1 ? `<p class="alert alert--ok">${esc(tr('prk|Payment received. Thank you.'))}</p>` : paid === 0 ? `<p class="alert alert--error">${esc(tr('prk|The payment did not go through. Nothing was charged.'))}</p>` : ''}
<section class="card paycard"><div class="card__body stack"><dl class="dl">
  <div><dt>${esc(tr('Status'))}</dt><dd>${ui.badge(p.status, tr((STATUS[p.status] || [p.status])[0]), (STATUS[p.status] || [])[1])}</dd></div>
  <div><dt>${esc(tr('prk|Subscription'))}</dt><dd>${esc(p.ref)} · ${esc(p.name)}</dd></div>
  <div><dt>${esc(tr('prk|Plates'))}</dt><dd><bdi>${esc(p.plates || '—')}</bdi></dd></div>
  <div><dt>${esc(tr('prk|Price'))}</dt><dd>${c.money(p.price)} ${esc(tn(p.months, 'prk|a month', 'prk|for {n} months'))}</dd></div>
  ${p.next_bill_on ? `<div><dt>${esc(tr('prk|Next invoice'))}</dt><dd>${esc(ui.date(p.next_bill_on))}</dd></div>` : ''}
  <div><dt>${esc(tr('prk|Renews by itself'))}</dt><dd>${esc(p.auto_renew ? tr('prk|Yes') : tr('prk|No, it ends on {date}', { date: ui.date(p.ends_on || p.next_bill_on || c.today()) }))}</dd></div></dl>
  ${open.map((i) => `<form method="post" action="/parking/my/${tok}/pay/${i.id}" class="stack"><input type="hidden" name="lang" value="${req.lang}"><p class="alert alert--warn">${esc(tr('prk|Invoice {ref} for {period}: {amount} to pay.', { ref: i.ref, period: `${ui.date(i.period_start)} – ${ui.date(i.period_end)}`, amount: c.money(i.total - i.paid) }))}</p>${ui.btn(esc(tr('prk|Pay {amount}', { amount: c.money(i.total - i.paid) })), { cls: 'btn--primary btn--block', ic: 'shield' })}</form>`).join('')}
</div></section>
${['active', 'suspended'].includes(p.status) ? ui.card(tr('prk|Change your plates'), changes ? `<form method="post" action="/parking/my/${tok}/plates" class="stack"><input type="hidden" name="lang" value="${req.lang}">${ui.input('plates', tr('prk|Plates'), p.plates || '', { required: true, hint: tr('prk|{n} changes left this month.', { n: changes }) })}${ui.btn(esc(tr('Save')), { cls: 'btn--ghost btn--sm' })}</form>` : `<p class="muted">${esc(tr('prk|You have changed your plates twice this month. Ask the parking office for more.'))}</p>`) : ''}
${pays.length ? ui.card(tr('prk|Receipts'), `<ul class="list pk-list">${pays.map((y) => `<li><a href="/parking/my/${tok}/receipt/${y.id}?lang=${req.lang}" target="_blank"><span class="what"><b>${esc(y.ref)}</b><small>${esc(ui.date(y.date))}</small></span><b>${c.money(y.amount)}</b></a></li>`).join('')}</ul>`) : ''}
${p.status === 'active' && p.auto_renew ? ui.card(tr('prk|Stop renewing'), `<form method="post" action="/parking/my/${tok}/stop" class="stack"><input type="hidden" name="lang" value="${req.lang}"><p class="muted">${esc(tr('prk|Your subscription stays active until the end of the period you paid for.'))}</p>${ui.btn(esc(tr('prk|Stop renewing')), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('prk|Stop renewing your subscription?') } })}</form>`) : ''}`;
    page(req, res, { title: tr('prk|Your parking subscription'), body });
  });
  pub.post('/my/:token/pay/:invoice', limit, async (req, res, next) => {
    const p = permitByToken(req.params.token);
    const inv = p && db.get("SELECT * FROM invoices WHERE id = ? AND source = 'parking-permit' AND source_id = ? AND status IN ('open','partial')", h.int(req.params.invoice), p.id);
    if (!inv) return next();
    try {
      res.redirect(303, await h.payments.begin(inv, { method: 'card', source: 'parking-permit', lang: req.lang }));
    } catch {
      res.redirect(303, `/parking/my/${req.params.token}?lang=${req.lang}&paid=0`);
    }
  });
  pub.post('/my/:token/plates', limit, (req, res, next) => {
    const p = permitByToken(req.params.token);
    if (!p || !['active', 'suspended'].includes(p.status) || (p.plate_changes || 0) >= 2) return next();
    try {
      const plates = P.platesOf(req.body.plates);
      if (plates.length > p.cars + 1) throw P.fail('prk|This plan is for up to {n} plates.', { n: p.cars + 1 });
      P.savePermit({ ...p, plates: plates.join(', '), auto_renew: !!p.auto_renew }, { id: p.id });
      db.run('UPDATE pk_permits SET plate_changes = plate_changes + 1 WHERE id = ?', p.id);
      db.audit(null, 'Subscriber changed plates', 'pk_permit', p.id, `${p.ref} · ${plates.join(', ')}`, req.ip);
    } catch (e) {
      console.error('[parking] plates:', e.message);
    }
    res.redirect(303, `/parking/my/${req.params.token}?lang=${req.lang}`);
  });
  pub.post('/my/:token/stop', limit, (req, res, next) => {
    const p = permitByToken(req.params.token);
    if (!p) return next();
    const end = p.next_bill_on ? P.addDays(p.next_bill_on, -1) : c.today();
    db.run('UPDATE pk_permits SET auto_renew = 0, ends_on = ?, updated_at = ? WHERE id = ?', end, now(), p.id);
    db.audit(null, 'Subscriber stopped renewing', 'pk_permit', p.id, p.ref, req.ip);
    res.redirect(303, `/parking/my/${req.params.token}?lang=${req.lang}`);
  });
  pub.get('/my/:token/receipt/:payment', (req, res, next) => {
    const p = permitByToken(req.params.token);
    const y = p && db.get("SELECT y.id FROM payments y JOIN invoices i ON i.id = y.invoice_id WHERE y.id = ? AND i.source = 'parking-permit' AND i.source_id = ?", h.int(req.params.payment), p.id);
    if (!y || !h.receiptDoc) return next();
    res.type('html').send(h.receiptDoc(y.id, { lang: req.lang, back: null, self: req.originalUrl }));
  });
  // monthly plate changes start again each month
  h.every('parking-plate-changes', 6 * 3600000, () => {
    if (c.today().slice(8) === '01' && db.setting('prk_plate_reset') !== c.today()) {
      db.run('UPDATE pk_permits SET plate_changes = 0 WHERE plate_changes > 0');
      db.setSetting('prk_plate_reset', c.today());
    }
  });
};

module.exports.B_STATUS = B_STATUS;
