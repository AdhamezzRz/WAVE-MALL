'use strict';

// Parking: the prices (hours, a day rate, grace, cap, lost ticket, validations), plates and tickets,
// the QR code, the gates' API (entry, exit refused until paid, a pay machine, levels, full car park,
// block list), the booth (a till, payments, letting a car out, opening by hand), shops validating
// through the tenant portal and being billed, subscriptions (recognised at the gate, billed, suspended
// when unpaid), paying online from the visitor's phone, and the books staying balanced.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const T = require('../src/admin/parking/tariff');
const { plateKey, plateShow, readCredential, cardKey } = require('../src/admin/parking/core');
const { matrix, svg } = require('../src/admin/qr');

const KEY = 'gate-key-0123456789';
let server;
let base;
let db;
let h;
let P;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0', PARKING_API_KEY: KEY, PAYMENTS_MODE: 'sandbox' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  P = h.parking;
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function browser(prefix = '/admin') {
  const jar = new Map();
  const go = async (p, opts = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const b = {
    go,
    csrf: null,
    form: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: b.csrf, ...data }).toString() }),
    async signIn(email, password) {
      const html = await (await go(`${prefix}/login`)).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go(`${prefix}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303, `sign-in ${email}`);
      const page = await (await go(prefix === '/portal' ? '/portal/parking' : prefix)).text();
      b.csrf = (page.match(/name="csrf" content="([^"]+)"/) || page.match(/name="_csrf" value="([^"]+)"/))[1];
    },
  };
  return b;
}
const user = (name, email, role) => Number(db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, datetime('now'))", name, email, role, hashPassword('long-enough-1')).lastInsertRowid);
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const gate = (path, body, key = KEY) => fetch(`${base}/ingest/parking${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
const tariff = () => P.tariffAt();

test('parking: prices for short, long, overnight and validated stays', () => {
  const t = { ...T.DEFAULT, grace_min: 15, first_hour: 20, next_hour: 10, round_min: 5, daily_cap: 100, day_rate: 120, lost_fee: 150, exit_min: 15 };
  assert.equal(T.cost(t, 10), 0, 'within the free minutes');
  assert.equal(T.cost(t, 16), 20);
  assert.equal(T.cost(t, 64), 20, 'five minutes of tolerance');
  assert.equal(T.cost(t, 66), 30);
  assert.equal(T.cost(t, 240), 50);
  assert.equal(T.cost(t, 600), 100, 'capped for the day');
  assert.equal(T.cost(t, 1440), 120, 'a full day at the day rate');
  assert.equal(T.cost(t, 1440 + 120), 150, 'a day and two hours');
  assert.equal(T.cost(t, 3 * 1440 + 700), 3 * 120 + 100);
  assert.equal(T.quote(t, { minutes: 180, free_min: 120 }).due, 10, 'two free hours off a three-hour stay');
  assert.equal(T.quote(t, { minutes: 90, free_min: 120 }).due, 0);
  assert.equal(T.quote(t, { minutes: 500, whole: true }).due, 0, 'the whole visit validated');
  assert.equal(T.quote(t, { minutes: 120, lost: true }).due, 180, 'lost ticket');
  const e = ago(200);
  assert.equal(T.quote(t, { entry_at: e, paid: 50, paid_at: ago(5) }).due, 0, 'paid five minutes ago: free to leave');
  assert.equal(T.quote(t, { entry_at: e, paid: 40, paid_at: ago(40) }).due, 10, 'paid long ago: the extra hour is due');
  assert.equal(T.duration(185), '3 h 05 min');
});

test('parking: plates, tickets and cards are recognised however they are read', () => {
  assert.equal(plateKey('ق ص ر ١٢٣٤'), plateKey('1234 قصر'));
  assert.equal(plateKey('أ ب ج 55'), plateKey('ا ب ج 55'));
  assert.equal(plateKey('abc-123'), 'ABC123');
  assert.equal(plateShow('قصر1234'), 'ق ص ر 1234');
  assert.deepEqual(readCredential('https://thewavemall.test/parking/t/ABCD-2345'), { raw: 'https://thewavemall.test/parking/t/ABCD-2345', code: 'ABCD2345' });
  assert.equal(readCredential('abcd-2345').code, 'ABCD2345');
  assert.equal(readCredential('04:a3:2b:1c').card, '04A32B1C');
  assert.equal(cardKey('04 A3 2B 1C'), '04A32B1C');
  assert.equal(readCredential('س ع د 777').plate, plateKey('سعد777'));
});

test('parking: QR codes are standard (same symbol as the reference encoder)', () => {
  const m = matrix('https://thewavemallcairo.com/parking/t/ABCD-2345', { ecl: 'M' });
  assert.equal(m.version, 4);
  assert.equal(m.mask, 3);
  const hash = crypto.createHash('sha256').update(m.rows.map((r) => r.map((x) => (x ? 1 : 0)).join('')).join('\n')).digest('hex');
  assert.equal(hash, '5c1cb72bb6f9b956418bfab0758d44553a564e58390ce871ea32a2eb7fcc5218');
  assert.match(svg('x', { label: 'A <ticket>' }), /^<svg [^>]*aria-label="A &lt;ticket&gt;"/);
  assert.equal(matrix('x'.repeat(400), { ecl: 'L' }).version, 13);
});

test('parking: the gates — entry, a repeat read, exit refused until paid at a machine', async () => {
  assert.equal((await gate('/gate', { lane: 'IN-1', plate: 'X 1' }, null)).status, 401);
  assert.equal((await gate('/gate', { lane: 'IN-1', plate: 'X 1' }, 'wrong-key-0000000000')).status, 401);
  assert.equal((await gate('/gate', { lane: 'NOPE', plate: 'X 1' })).status, 422);
  let r = await (await gate('/gate', { lane: 'IN-1', event: 'entry', plate: 'ق ص ر 1234', time: ago(130) })).json();
  assert.equal(r.open, true);
  assert.match(r.ticket, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(r.message.en, 'Welcome to The Wave.');
  const ticket = r.ticket;
  r = await (await gate('/gate', { lane: 'IN-1', event: 'entry', plate: '1234 قصر', time: ago(129) })).json();
  assert.equal(r.ticket, ticket, 'the camera read the same car twice');
  r = await (await gate('/gate', { lane: 'OUT-1', event: 'exit', plate: 'قصر 1234' })).json();
  assert.equal(r.open, false);
  assert.equal(r.reason, 'unpaid');
  assert.equal(r.due, T.cost(tariff(), 130));
  assert.match(r.message.ar, /ج\.م/);
  const quote = await (await fetch(`${base}/ingest/parking/quote?ticket=${ticket}`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.equal(quote.due, r.due);
  let pay = await (await gate('/pay', { device: 'PM-1', ticket, amount: quote.due, method: 'card', reference: 'TXN-1' })).json();
  assert.equal(pay.ok, true);
  assert.equal(pay.due, 0);
  pay = await (await gate('/pay', { device: 'PM-1', ticket, amount: quote.due, method: 'card', reference: 'TXN-1' })).json();
  assert.equal(pay.duplicate, true, 'the same machine payment twice is recorded once');
  r = await (await gate('/gate', { lane: 'OUT-1', event: 'exit', ticket })).json();
  assert.equal(r.open, true);
  assert.equal(r.message.en, 'Thank you. Drive safely.');
  const s = P.byCode(ticket.replace('-', ''));
  assert.equal(s.status, 'left');
  assert.equal(s.fee, quote.due);
  assert.equal(s.paid, quote.due);
  // a car without a readable plate gets a ticket to print
  r = await (await gate('/gate', { lane: 'IN-1', event: 'entry' })).json();
  assert.equal(r.print, true);
  assert.match(r.ticket_url, /\/parking\/t\/[2-9A-HJ-NP-Z]{4}-/);
  // the signs and the level sensors
  await gate('/levels', { levels: [{ zone: 'B1', cars: 100 }] });
  const st = await (await fetch(`${base}/ingest/parking/status`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.equal(st.capacity, 340);
  assert.equal(st.levels.find((l) => l.zone === 'B1').cars, 100);
  db.run('UPDATE pk_zones SET counted = NULL, counted_at = NULL');
  // the hourly counts the footfall module shows
  assert.ok(db.value("SELECT SUM(entries) FROM parking WHERE source = 'gates'") >= 2);
});

test('parking: a blocked plate and a full car park stay outside; subscribers still get in', async () => {
  P.savePermit({ holder: 'individual', name: 'Omar Said', plates: 'س ع د 777', card_uid: '04:A3:2B:1C:9F:61:80', starts_on: '2026-01-01', price: 0, months: 1 });
  db.run("INSERT INTO pk_lists (plate_key, plate, kind, reason, created_at) VALUES (?, 'ط ع م 4402', 'block', 'test', datetime('now'))", plateKey('طعم4402'));
  let r = await (await gate('/gate', { lane: 'IN-1', plate: 'طعم 4402' })).json();
  assert.equal(r.open, false);
  assert.equal(r.reason, 'blocked');
  db.run("UPDATE pk_zones SET capacity = 1 WHERE code = 'B1'");
  db.run("UPDATE pk_zones SET capacity = 0 WHERE code = 'B2'");
  r = await (await gate('/gate', { lane: 'IN-1', plate: 'م م 1' })).json();
  assert.equal(r.reason, 'full');
  r = await (await gate('/gate', { lane: 'IN-1', card: '04A32B1C9F6180' })).json();
  assert.equal(r.open, true, 'a subscriber’s card opens a full car park');
  assert.equal(r.kind, 'subscriber');
  r = await (await gate('/gate', { lane: 'OUT-1', event: 'exit', card: '04 A3 2B 1C 9F 61 80' })).json();
  assert.equal(r.open, true, 'and leaves without paying');
  db.run("UPDATE pk_zones SET capacity = 144 WHERE code = 'B1'");
  db.run("UPDATE pk_zones SET capacity = 196 WHERE code = 'B2'");
});

let mgr;
let agent;
let viewer;
test('parking: the booth — a till, cash, letting a car out, opening by hand, closing short', async () => {
  user('Park Manager', 'pk-mgr@thewave.test', 'manager');
  user('Park Cashier', 'pk-cash@thewave.test', 'agent');
  user('Park Viewer', 'pk-view@thewave.test', 'viewer');
  mgr = browser(); await mgr.signIn('pk-mgr@thewave.test', 'long-enough-1');
  agent = browser(); await agent.signIn('pk-cash@thewave.test', 'long-enough-1');
  viewer = browser(); await viewer.signIn('pk-view@thewave.test', 'long-enough-1');
  const a = P.entry({ lane: 'IN-1', plate: 'ن ي ل 2024', at: ago(95) }).session;
  const due = P.quoteOf(a).due;
  assert.ok(due > 0);
  // no till yet: no money
  let res = await agent.form(`/admin/parking/visits/${a.id}/pay`, { method: 'cash', amount: due });
  assert.equal(res.status, 303);
  assert.equal(P.sessionBy(a.id).paid, 0);
  await viewer.form('/admin/parking/till/open', { name: 'Exit booth', float: 500 });
  assert.equal(db.value("SELECT COUNT(*) FROM pk_tills t JOIN users u ON u.id = t.user_id WHERE u.email = 'pk-view@thewave.test'"), 0, 'a viewer cannot open a till');
  res = await agent.form('/admin/parking/till/open', { name: 'Exit booth', float: 500 });
  assert.equal(res.status, 303);
  const booth = await (await agent.go(`/admin/parking/booth?q=${encodeURIComponent('ني ل 2024')}`)).text();
  assert.match(booth, /To pay now/);
  assert.match(booth, /Cash <b>/);
  res = await agent.form(`/admin/parking/visits/${a.id}/pay?back=booth`, { method: 'cash', amount: due });
  assert.match(res.headers.get('location'), /\/admin\/parking\/booth\?q=/);
  assert.equal(P.sessionBy(a.id).paid, due);
  res = await agent.form(`/admin/parking/visits/${a.id}/exit`, {});
  assert.equal(P.sessionBy(a.id).status, 'left');
  // an unpaid car: the cashier cannot open by hand, a manager can, with a reason
  const b = P.entry({ lane: 'IN-1', plate: 'ع ر ب 9', at: ago(300) }).session;
  await agent.form(`/admin/parking/visits/${b.id}/exit`, { manual: '1', reason: 'Ambulance' });
  assert.equal(P.sessionBy(b.id).status, 'inside', 'a cashier cannot open by hand for an unpaid car');
  await mgr.form(`/admin/parking/visits/${b.id}/exit`, { manual: '1', reason: '' });
  assert.equal(P.sessionBy(b.id).status, 'inside', 'a reason is required');
  await mgr.form(`/admin/parking/visits/${b.id}/exit`, { manual: '1', reason: 'Ambulance' });
  const out = P.sessionBy(b.id);
  assert.equal(out.status, 'left');
  assert.equal(out.discount, out.fee, 'written off');
  assert.ok(db.get("SELECT id FROM pk_events WHERE session_id = ? AND kind = 'manual'", b.id));
  // close the till 20 short: one invoice for the takings, paid, and the shortage in the books
  const till = db.get("SELECT * FROM pk_tills WHERE status = 'open' AND kind = 'booth'");
  res = await agent.form(`/admin/parking/tills/${till.id}/close`, { counted: 500 + due - 20 });
  const closed = P.tillBy(till.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.difference, -20);
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', closed.invoice_id);
  assert.equal(inv.kind, 'parking');
  assert.equal(inv.total, due);
  assert.equal(inv.status, 'paid');
  // the invoice is dated by Cairo's day, which can be a day ahead of UTC around midnight
  h.ledger.sync({ upTo: P.addDays(inv.due_date, 1) });
  const tb = h.ledger.trialBalance({ from: '2000-01-01', to: '2100-12-31' });
  assert.ok(tb.balanced, 'the books balance');
  assert.ok(h.ledger.balance(h.ledger.idOf('inc_parking')) !== 0, 'parking income is in the books');
  assert.ok(db.get("SELECT id FROM acc_entries WHERE source = ?", `pktill:${till.id}#1`), 'the cash shortage is posted');
});

test('parking: a shop validates through the tenant portal and is billed for it', async () => {
  const brand = Number(db.run("INSERT INTO brands (name, category, created_at) VALUES ('Café Nour', 'fnb', datetime('now'))").lastInsertRowid);
  db.run("INSERT INTO portal_users (brand_id, name, email, password_hash, created_at) VALUES (?, 'Nour Staff', 'nour@cafe.test', ?, datetime('now'))", brand, hashPassword('long-enough-1'));
  await mgr.form(`/admin/parking/validations/rules/${brand}`, { active: '1', minutes: '0', min_purchase: '300', payer: 'tenant', share: '', monthly_cap: '' });
  const shop = browser('/portal');
  await shop.signIn('nour@cafe.test', 'long-enough-1');
  const s = P.entry({ lane: 'IN-1', plate: 'ف ن 3030', at: ago(150) }).session;
  const code = s.code;
  let page = await (await shop.go(`/portal/parking?q=${code}`)).text();
  assert.match(page, /At least EGP 300 to validate/);
  await shop.form('/portal/parking/validate', { code, purchase: '120', via: 'qr' });
  assert.equal(P.quoteOf(P.sessionBy(s.id)).whole, false, 'below the smallest purchase');
  await shop.form('/portal/parking/validate', { code, purchase: '450', receipt: '7781', via: 'qr' });
  const q = P.quoteOf(P.sessionBy(s.id));
  assert.equal(q.due, 0);
  assert.equal(q.validations[0].via, 'qr');
  page = await (await shop.go(`/portal/parking?q=${code}`)).text();
  assert.match(page, /Already validated by your store/);
  // out for free; what it was worth is billed to the shop for the month
  const r = P.exit({ code, via: 'anpr' });
  assert.equal(r.open, true);
  const value = db.value('SELECT value FROM pk_validations WHERE session_id = ?', s.id);
  assert.equal(value, T.cost(tariff(), 150));
  const month = new Date().toISOString().slice(0, 7);
  const monthNow = db.value('SELECT substr(at, 1, 7) FROM pk_validations WHERE session_id = ?', s.id);
  assert.equal(monthNow, month);
  await mgr.form('/admin/parking/validations/bill', { m: month });
  const inv = db.get("SELECT * FROM invoices WHERE source = 'parking-validations' AND brand_id = ?", brand);
  assert.equal(inv.total, value);
  assert.equal(inv.kind, 'parking');
  assert.equal(P.billValidations(month).length, 0, 'billed once');
  // a car on a subscription has nothing to validate
  assert.throws(() => P.validate(P.entry({ lane: 'IN-1', plate: 'سعد 777' }).session, { brandId: brand, purchase: 500 }), /prk\|This car parks on a subscription/);
});

test('parking: subscriptions are billed, suspended when unpaid, and then park as visitors', async () => {
  const start = new Date(Date.now() - 50 * 86400000).toISOString().slice(0, 10);
  await viewer.form('/admin/parking/subscriptions', { holder: 'individual', name: 'Late Payer', plates: 'ل ت 5050', starts_on: start, price: '900', months: '1' });
  assert.equal(db.value("SELECT COUNT(*) FROM pk_permits WHERE name = 'Late Payer'"), 0, 'a viewer cannot create subscriptions');
  const res = await mgr.form('/admin/parking/subscriptions', { holder: 'individual', name: 'Late Payer', plates: 'ل ت 5050', starts_on: start, price: '900', months: '1', auto_renew: '1' });
  assert.equal(res.status, 303);
  const id = Number(res.headers.get('location').match(/(\d+)$/)[1]);
  assert.match(await (await mgr.go(`/admin/parking/subscriptions/${id}`)).text(), /Late Payer/);
  assert.equal(P.billPermits(), 2, 'two months billed in advance');
  assert.equal(P.billPermits(), 0, 'and not twice');
  let e = P.entry({ lane: 'IN-1', plate: 'لت 5050' });
  assert.equal(e.kind, 'subscriber');
  P.exit({ plate: 'لت 5050' });
  const out = P.reviewPermits();
  assert.equal(out.suspended, 1, 'the first invoice is more than 30 days late');
  e = P.entry({ lane: 'IN-1', plate: 'لت 5050' });
  assert.equal(e.kind, 'visitor', 'suspended: parks as a visitor');
  P.exit({ plate: 'لت 5050', manual: true, reason: 'test' });
  // paid: back on
  for (const inv of db.all("SELECT * FROM invoices WHERE source = 'parking-permit' AND source_id = ? AND status = 'open'", id)) h.billing.recordPayment({ invoice_id: inv.id, amount: inv.total, method: 'transfer' });
  assert.equal(P.reviewPermits().restored, 1);
});

test('parking: a visitor finds the car by plate and pays online from the phone', async () => {
  const s = P.entry({ lane: 'IN-1', plate: 'و ي ف 8080', at: ago(200), demo: 0 }).session;
  const due = P.quoteOf(s).due;
  // by plate: what is due, never when it came in
  const visitor = browser('/parking');
  let res = await visitor.go('/parking/find', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: 'ويف 8080' }).toString() });
  let html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /To pay now/);
  assert.doesNotMatch(html, /Came in/);
  res = await visitor.go('/parking/find', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: 'غير موجود 1' }).toString() });
  assert.equal(res.status, 404);
  // the ticket page: the QR, the time, pay
  html = await (await visitor.go(`/parking/t/${s.code}`)).text();
  assert.match(html, /<svg class="pk-qr"/);
  assert.match(html, /Came in/);
  res = await visitor.go(`/parking/t/${s.code}/pay`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'method=card' });
  assert.equal(res.status, 303);
  const sandbox = res.headers.get('location');
  assert.match(sandbox, /^\/pay\/sandbox\//);
  res = await visitor.go(sandbox.replace(/\?.*$/, ''), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=approve' });
  res = await visitor.go(res.headers.get('location'));
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), new RegExp(`^/parking/t/${s.code.slice(0, 4)}-${s.code.slice(4)}\\?lang=en&paid=1`));
  const after = P.sessionBy(s.id);
  assert.equal(after.paid, due);
  assert.equal(db.value("SELECT method FROM pk_payments WHERE session_id = ?", s.id), 'online');
  assert.equal(db.value("SELECT status FROM invoices WHERE source = 'parking' AND source_id = ?", s.id), 'paid');
  assert.equal(P.exit({ plate: 'ويف8080' }).open, true);
  // visitors' parking is a retail sale: never an ETA e-invoice
  const inv = db.get("SELECT * FROM invoices WHERE source = 'parking' AND source_id = ?", s.id);
  assert.equal(inv.brand_id, null);
});

test('parking: every screen renders, in English and Arabic, and the sample data loads and clears', async () => {
  const pages = ['/admin/parking', '/admin/parking/booth', '/admin/parking/visits', '/admin/parking/visits?status=left', '/admin/parking/subscriptions', '/admin/parking/subscriptions/new', '/admin/parking/validations',
    '/admin/parking/tills', '/admin/parking/reports', '/admin/parking/reports?p=90', '/admin/parking/setup',
    '/admin/parking/floor', '/admin/parking/floor?level=B2', '/admin/parking/valet', '/admin/parking/bookings', '/admin/parking/companies', '/admin/parking/companies/new',
    '/admin/parking/incidents', '/admin/parking/incidents/new', '/admin/parking/violations', '/admin/parking/violations/new', '/admin/parking/lost',
    '/admin/parking/safe', '/admin/parking/ereceipts', '/admin/parking/watch', '/admin/parking/forecast', '/admin/parking/insight'];
  const v = db.value('SELECT id FROM pk_sessions ORDER BY id DESC LIMIT 1');
  pages.push(`/admin/parking/visits/${v}`, `/admin/parking/visits/${v}/ticket`, `/admin/parking/payments/${db.value('SELECT id FROM pk_payments LIMIT 1')}/receipt`, `/admin/parking/tills/${db.value('SELECT id FROM pk_tills LIMIT 1')}`);
  for (const lang of ['en', 'ar']) {
    await mgr.form('/admin/lang', { lang, back: '/admin' });
    for (const p of pages) {
      const res = await mgr.go(p);
      assert.equal(res.status, 200, `${lang} ${p}`);
      const html = await res.text();
      assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /undefined|NaN|\[object Object\]/, `${lang} ${p}`);
      if (lang === 'ar') assert.match(html, /<html lang="ar" dir="rtl"/);
    }
  }
  await mgr.form('/admin/lang', { lang: 'en', back: '/admin' });
  const admin = browser();
  user('Park Admin', 'pk-admin@thewave.test', 'admin');
  await admin.signIn('pk-admin@thewave.test', 'long-enough-1');
  assert.equal((await admin.form('/admin/settings/demo', {})).status, 303);
  assert.ok(db.value('SELECT COUNT(*) FROM pk_sessions WHERE demo = 1') > 1000);
  assert.ok(db.value("SELECT COUNT(*) FROM pk_permits WHERE demo = 1 AND status = 'suspended'") >= 1);
  assert.ok(db.value("SELECT COUNT(*) FROM pk_tills WHERE demo = 1 AND status = 'closed' AND invoice_id IS NOT NULL") > 10);
  for (const p of ['/admin/parking', '/admin/parking/reports', '/admin/parking/validations', '/admin/footfall', '/admin/integrations', '/parking']) assert.equal((await admin.go(p)).status, 200, p);
  assert.match(await (await admin.go('/admin/integrations')).text(), /Car park gates/);
  // the second wave's sample data, and every screen with it, in both languages
  for (const t of ['pk_valet', 'pk_bookings', 'pk_accounts', 'pk_account_charges', 'pk_violations', 'pk_incidents', 'pk_safe', 'pk_alerts', 'pk_ereceipts']) assert.ok(db.value(`SELECT COUNT(*) FROM ${t} WHERE demo = 1`) > 0, t);
  assert.ok(db.value("SELECT COUNT(*) FROM pk_bays WHERE sensor LIKE 'demo:%'") > 20, 'sensors on the lower ground');
  const first = (t) => db.value(`SELECT id FROM ${t} WHERE demo = 1 ORDER BY id LIMIT 1`);
  const full = ['/admin/parking', '/admin/parking/floor', '/admin/parking/floor?level=B2', '/admin/parking/floor.json?level=B1', '/admin/parking/valet', `/admin/parking/valet/${first('pk_valet')}`, `/admin/parking/valet/${first('pk_valet')}/ticket`,
    '/admin/parking/bookings', `/admin/parking/bookings/${first('pk_bookings')}`, '/admin/parking/companies', `/admin/parking/companies/${first('pk_accounts')}`, '/admin/parking/incidents', `/admin/parking/incidents/${first('pk_incidents')}`,
    '/admin/parking/violations', `/admin/parking/violations/${first('pk_violations')}`, '/admin/parking/lost', '/admin/parking/safe', '/admin/parking/ereceipts', '/admin/parking/watch', '/admin/parking/forecast', '/admin/parking/insight',
    '/admin/parking/subscriptions', '/admin/parking/tills', '/admin/parking/reports', '/admin/parking/setup', `/admin/parking/payments/${db.value('SELECT payment_id FROM pk_ereceipts WHERE demo = 1 AND uuid IS NOT NULL LIMIT 1')}/receipt`];
  for (const lang of ['en', 'ar']) {
    await admin.form('/admin/lang', { lang, back: '/admin' });
    for (const p of full) {
      const res = await admin.go(p);
      assert.equal(res.status, 200, `${lang} ${p}`);
      assert.doesNotMatch((await res.text()).replace(/<script[\s\S]*?<\/script>/g, ''), /undefined|NaN|\[object Object\]/, `${lang} ${p}`);
    }
  }
  await admin.form('/admin/lang', { lang: 'en', back: '/admin' });
  assert.match(await (await admin.go('/admin/parking/forecast')).text(), /Cars expected/);
  h.ledger.sync();
  assert.ok(h.ledger.trialBalance({ from: '2000-01-01', to: '2100-12-31' }).balanced, 'the books balance with the sample data');
  assert.equal((await admin.form('/admin/settings/demo/clear', {})).status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM pk_sessions WHERE demo = 1'), 0);
  for (const t of ['pk_valet', 'pk_bookings', 'pk_accounts', 'pk_violations', 'pk_incidents', 'pk_safe', 'pk_alerts', 'pk_ereceipts']) assert.equal(db.value(`SELECT COUNT(*) FROM ${t} WHERE demo = 1`), 0, t);
  assert.equal(db.value('SELECT COUNT(*) FROM pk_zones'), 2, 'the real set-up stays');
});
