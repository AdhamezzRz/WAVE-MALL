'use strict';

// Parking, second wave: the live floor (bay sensors), booked spaces, valet, fines carried to the next
// visit, company accounts, the cash safe with bank collections, alerts, the forecast, offline gates
// (sync and an idempotent batch), and ETA e-receipts (the UUID chain, return receipts, sending).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const eta = require('../src/admin/eta');

const KEY = 'gate-key-0123456789';
let server;
let base;
let db;
let h;
let P;
let mgr;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0', PARKING_API_KEY: KEY, PAYMENTS_MODE: 'sandbox', ETA_RECEIPT_CLIENT_ID: 'pos-id', ETA_RECEIPT_CLIENT_SECRET: 'pos-secret' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  P = h.parking;
  base = `http://127.0.0.1:${server.address().port}`;
  db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES ('Floor Manager', 'pk2-mgr@thewave.test', 'manager', ?, datetime('now'))", hashPassword('long-enough-1'));
  mgr = browser();
  await mgr.signIn('pk2-mgr@thewave.test', 'long-enough-1');
  mgr.user = db.get("SELECT * FROM users WHERE email = 'pk2-mgr@thewave.test'");
});
after(() => server.close());

function browser() {
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
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303);
      const page = await (await go('/admin')).text();
      b.csrf = (page.match(/name="csrf" content="([^"]+)"/) || page.match(/name="_csrf" value="([^"]+)"/))[1];
    },
  };
  return b;
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const api = (method, path, body) => fetch(`${base}/ingest/parking${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: body ? JSON.stringify(body) : undefined });

test('parking floor: both levels are drawn, sensors report bays, and the map shows them', async () => {
  const html = await (await mgr.go('/admin/parking/floor')).text();
  assert.equal(db.value("SELECT COUNT(*) FROM pk_bays b JOIN pk_zones z ON z.id = b.zone_id WHERE z.code = 'B1'"), 144);
  assert.equal(db.value("SELECT COUNT(*) FROM pk_bays b JOIN pk_zones z ON z.id = b.zone_id WHERE z.code = 'B2'"), 196);
  assert.match(html, /data-floor/);
  assert.ok(db.value("SELECT COUNT(*) FROM pk_bays WHERE kind = 'reserved'") >= 5, 'bookable bays');
  const r = await (await api('POST', '/bays', { bays: [{ bay: 'B1-A01', occupied: true, plate: 'س ي ن 77' }, { bay: 'B1-A02', occupied: false }, { bay: 'NOPE', occupied: true }] })).json();
  assert.equal(r.updated, 2);
  const j = await (await mgr.go('/admin/parking/floor.json?level=B1')).json();
  const a01 = j.bays.find((x) => x[0] === 'B1-A01');
  assert.equal(a01[1], 'taken');
  assert.match(a01[4], /س ي ن 77/);
  assert.equal(j.bays.find((x) => x[0] === 'B1-A02')[1], 'free');
});

test('parking bookings: a booked car is recognised at the gate, its time is covered, and no-shows are released', async () => {
  const B = P.bookings;
  const starts = ago(20);
  const ends = new Date(Date.now() + 100 * 60000).toISOString();
  const b = B.book({ plate: 'ح ج ز 501', name: 'Booked Guest', starts_at: starts, ends_at: ends }, { status: 'confirmed', source: 'office' });
  assert.ok(b.bay_id, 'a reserved bay');
  assert.ok(b.invoice_id, 'an invoice for the booking');
  const e = P.entry({ lane: 'IN-1', plate: 'حجز 501', at: ago(10) });
  assert.equal(e.session.kind, 'booking');
  assert.equal(db.value('SELECT status FROM pk_bookings WHERE id = ?', b.id), 'arrived');
  assert.equal(P.quoteOf(P.sessionBy(e.session.id)).due, 0, 'the booked time is paid for');
  // the same bay cannot be booked twice at once
  const other = B.freeBay(starts, ends);
  assert.ok(!other || other.id !== b.bay_id);
  // nobody came: released after the hold time
  const late = B.book({ plate: 'ل م ن 9', name: 'No Show', starts_at: ago(90), ends_at: ago(-30) }, { status: 'confirmed' });
  B.sweep();
  assert.equal(db.value('SELECT status FROM pk_bookings WHERE id = ?', late.id), 'no_show');
  // the public page books and sends the visitor to pay
  assert.equal((await fetch(`${base}/parking/book`)).status, 200);
});

test('parking valet: take a car, the customer asks for it by link, keys back only when paid', async () => {
  await mgr.form('/admin/parking/till/open', { float: '0' });
  const res = await mgr.form('/admin/parking/valet', { plate: 'ف ل ي 3030', tag: '7', fee: '100', cond_front: '1' });
  assert.equal(res.status, 303);
  const v = db.get("SELECT * FROM pk_valet WHERE plate_key = ? AND status = 'received'", P.plateKey('فلي 3030'));
  assert.ok(v && v.token);
  const s = P.sessionBy(v.session_id);
  assert.equal(s.kind, 'valet');
  assert.equal(P.quoteOf(s).due, 100, 'the valet fee, parking included');
  await mgr.form(`/admin/parking/valet/${v.id}/status`, { status: 'parked', bay: 'B1-E01' });
  assert.equal(db.value('SELECT status FROM pk_valet WHERE id = ?', v.id), 'parked');
  // the customer's phone
  const page = await (await fetch(`${base}/parking/valet/${v.token}`)).text();
  assert.match(page, /Key tag 7/);
  assert.equal((await fetch(`${base}/parking/valet/${v.token}`, { method: 'POST', redirect: 'manual' })).status, 303);
  assert.equal(db.value('SELECT status FROM pk_valet WHERE id = ?', v.id), 'requested');
  await mgr.form(`/admin/parking/valet/${v.id}/status`, { status: 'ready' });
  await mgr.form(`/admin/parking/valet/${v.id}/status`, { status: 'delivered' });
  assert.equal(db.value('SELECT status FROM pk_valet WHERE id = ?', v.id), 'ready', 'not handed back before paying');
  await mgr.form(`/admin/parking/visits/${s.id}/pay`, { method: 'cash', amount: '100' });
  await mgr.form(`/admin/parking/valet/${v.id}/status`, { status: 'delivered' });
  assert.equal(db.value('SELECT status FROM pk_valet WHERE id = ?', v.id), 'delivered');
  assert.equal(db.value('SELECT token FROM pk_valet WHERE id = ?', v.id), null, 'the link stops working');
});

test('parking fines: charged on the visit inside, or waiting for the car’s next visit', async () => {
  const type = db.get("SELECT * FROM pk_violation_types WHERE code = 'ACCESSIBLE'");
  const s = P.entry({ lane: 'IN-1', plate: 'م خ ل 11', at: ago(30) }).session;
  const before = P.quoteOf(s).due;
  const v = P.fine({ type, plate: 'مخل 11', amount: type.fine });
  assert.equal(v.status, 'charged');
  assert.equal(P.quoteOf(P.sessionBy(s.id)).due, before + type.fine);
  // a car that has left: the fine waits
  const w = P.fine({ type, plate: 'غ ا ئ ب 22', amount: 300 });
  assert.equal(w.status, 'unpaid');
  const back = P.entry({ lane: 'IN-1', plate: 'غائب 22', at: ago(5) }).session;
  assert.equal(P.sessionBy(back.id).extra, 300);
  assert.equal(db.value('SELECT status FROM pk_violations WHERE id = ?', w.id), 'charged');
  assert.ok(P.quoteOf(P.sessionBy(back.id)).due >= 300, 'due at the exit, never validated away');
});

test('parking companies: usage is charged per visit at a discount, capped, and billed monthly', async () => {
  const res = await mgr.form('/admin/parking/companies', { name: 'Fleet Co', mode: 'usage', discount: '25', cap: '50', terms_days: '15', contact_name: 'Fleet Admin', email: 'fleet@co.test' });
  assert.equal(res.status, 303);
  const a = db.get("SELECT * FROM pk_accounts WHERE name = 'Fleet Co'");
  await mgr.form(`/admin/parking/companies/${a.id}/plates`, { lines: 'و ن ش 404, Driver One\nو ن ش 405, Driver Two' });
  assert.equal(db.value('SELECT COUNT(*) FROM pk_permits WHERE account_id = ?', a.id), 2);
  // (the plates start today, Cairo time: the visits start now and end later)
  const s = P.entry({ lane: 'IN-1', plate: 'ونش 404', at: ago(1) }).session;
  assert.equal(s.kind, 'company');
  assert.equal(P.quoteOf(s).due, 0, 'nothing to pay at the gate');
  assert.equal(P.exit({ lane: 'OUT-1', plate: 'ونش 404', at: ago(-199) }).open, true);
  const c1 = db.get('SELECT * FROM pk_account_charges WHERE account_id = ?', a.id);
  const t = P.tariffAt();
  assert.ok(c1.amount > 0 && c1.amount < require('../src/admin/parking/tariff').cost(t, 200) + 0.01);
  const s2 = P.entry({ lane: 'IN-1', plate: 'ونش 405', at: ago(1) }).session;
  P.exit({ lane: 'OUT-1', plate: 'ونش 405', at: ago(-599) });
  assert.ok(db.value('SELECT SUM(amount) FROM pk_account_charges WHERE account_id = ?', a.id) <= 50, 'the monthly cap');
  void s2;
  // the bill, next month
  db.run('UPDATE pk_accounts SET next_bill_on = ? WHERE id = ?', P.addDays(P.addMonths(`${new Date().toISOString().slice(0, 7)}-01`, 1), 0), a.id);
  db.run('UPDATE pk_account_charges SET at = ? WHERE account_id = ?', ago(60), a.id);
  const invs = P.billAccounts(P.addMonths(`${new Date().toISOString().slice(0, 7)}-01`, 1));
  const inv = invs.find((x) => x.source_id === a.id);
  assert.ok(inv, 'an invoice for the account');
  assert.equal(inv.total, db.value('SELECT SUM(amount) FROM pk_account_charges WHERE account_id = ?', a.id));
});

test('parking cash: drops and closed tills go into the safe, the bank collects, the books follow', async () => {
  const till = P.openTillOf(mgr.user.id);
  const s = P.entry({ lane: 'IN-1', plate: 'ك ا ش 1', at: ago(200) }).session;
  const due = P.quoteOf(s).due;
  await mgr.form(`/admin/parking/visits/${s.id}/pay`, { method: 'cash', amount: String(due) });
  const before = P.safeBalance();
  let res = await mgr.form(`/admin/parking/tills/${till.id}/drop`, { amount: String(due + 9999) });
  assert.equal(P.safeBalance(), before, 'cannot drop more than the drawer has');
  res = await mgr.form(`/admin/parking/tills/${till.id}/drop`, { amount: '20', witness: 'Supervisor' });
  assert.equal(res.status, 303);
  assert.equal(P.safeBalance(), before + 20);
  const expected = P.tillTotals(P.tillBy(till.id)).expectedCash;
  await mgr.form(`/admin/parking/tills/${till.id}/close`, { counted: String(expected) });
  assert.equal(P.safeBalance(), before + 20 + expected);
  // the bank collects it all, then counts 10 less
  const all = P.safeBalance();
  await mgr.form('/admin/parking/safe/collect', { amount: String(all), bag: 'SEAL-1', carrier: 'Bank' });
  assert.equal(P.safeBalance(), 0);
  const x = db.get("SELECT * FROM pk_safe WHERE kind = 'collection' AND bag = 'SEAL-1'");
  assert.equal(x.status, 'in_transit');
  await mgr.form(`/admin/parking/safe/${x.id}/confirm`, { confirmed: String(all - 10) });
  assert.equal(db.value('SELECT status FROM pk_safe WHERE id = ?', x.id), 'banked');
  assert.ok(db.get('SELECT id FROM acc_entries WHERE source = ?', `pksafe:${x.id}#1`), 'the collection is in the books');
  assert.ok(db.get('SELECT id FROM acc_entries WHERE source = ?', `pksafe-bank:${x.id}#1`), 'and the bank’s difference');
  h.ledger.sync({ upTo: '2100-12-31' });
  assert.ok(h.ledger.trialBalance({ from: '2000-01-01', to: '2100-12-31' }).balanced);
});

test('parking watch: a blocked plate at the gate raises an alarm once; the forecast looks ahead two weeks', async () => {
  db.run("INSERT INTO pk_lists (plate_key, plate, kind, reason, created_at) VALUES (?, 'ب ل ك 1', 'block', 'Test', datetime('now'))", P.plateKey('بلك 1'));
  P.entry({ lane: 'IN-1', plate: 'بلك 1' });
  P.watch.check();
  P.watch.check();
  assert.equal(db.value("SELECT COUNT(*) FROM pk_alerts WHERE kind = 'blocked'"), 1);
  const f = P.forecast();
  assert.equal(f.days.length, 14);
  for (const d of f.days) assert.ok(Number.isFinite(d.cars) && d.cars >= 0 && d.day >= 0);
  assert.equal((await mgr.go('/admin/parking/insight')).status, 200);
});

test('parking offline gates: the agent syncs, and a batch replays once, keeping offline tickets', async () => {
  const sync = await (await api('GET', '/sync?device=edge-test')).json();
  assert.equal(sync.ok, true);
  assert.ok(sync.tariff && Array.isArray(sync.inside) && Array.isArray(sync.permits) && Array.isArray(sync.blocked));
  assert.ok(sync.blocked.includes(P.plateKey('بلك 1')));
  const ticket = 'EDGE2345';
  const t0 = Date.now() - 50 * 60000;
  const events = [
    { id: 'evt-0001', type: 'entry', lane: 'IN-1', ticket, time: new Date(t0).toISOString(), opened: true },
    { id: 'evt-0003', type: 'exit', lane: 'OUT-1', ticket, time: new Date(t0 + 40 * 60000).toISOString(), opened: true },
    { id: 'evt-0002', type: 'pay', device: 'PM-9', ticket, amount: 20, method: 'card', time: new Date(t0 + 38 * 60000).toISOString() },
  ];
  const r = await (await api('POST', '/batch', { device: 'edge-test', events })).json();
  assert.equal(r.accepted, 3);
  const s = P.byCode(ticket);
  assert.ok(s, 'the offline ticket code is kept');
  assert.equal(s.status, 'left');
  assert.equal(s.paid, 20);
  // sent again (the agent never heard back): nothing changes
  const again = await (await api('POST', '/batch', { device: 'edge-test', events })).json();
  assert.ok(again.results.every((x) => x.duplicate));
  assert.equal(db.value('SELECT COUNT(*) FROM pk_sessions WHERE code = ?', ticket), 1);
  assert.equal(db.value('SELECT COUNT(*) FROM pk_payments WHERE session_id = ?', s.id), 1);
  // the agent's download is for managers
  const js = await mgr.go('/admin/parking/edge-agent.js');
  assert.equal(js.status, 200);
  assert.match(await js.text(), /edge agent/);
});

test('parking e-receipts: each payment chained by UUID, a return receipt on refund, sent to the ETA', async () => {
  for (const [k, v] of Object.entries({ eta_rin: '123456789', eta_name: 'The Wave Mall', vat_pct: '14' })) db.setSetting(k, v);
  await mgr.form('/admin/parking/ereceipts/settings', { prk_eta_receipts: '1', prk_eta_pos_serial: 'POS-1', prk_eta_pos_os: 'linux', prk_eta_item_code: 'EG-123456789-PARK', prk_eta_activity: '5221' });
  const s = P.entry({ lane: 'IN-1', plate: 'ا ي ص 1', at: ago(90) }).session;
  const till = P.openTill({ user: mgr.user, float: 0 });
  const p1 = P.pay(s, { amount: P.quoteOf(s).due, method: 'cash', till });
  const s2 = P.entry({ lane: 'IN-1', plate: 'ا ي ص 2', at: ago(90) }).session;
  const p2 = P.pay(s2, { amount: P.quoteOf(s2).due, method: 'card', till });
  const r1 = db.get("SELECT * FROM pk_ereceipts WHERE payment_id = ? AND kind = 's'", p1.id);
  const r2 = db.get("SELECT * FROM pk_ereceipts WHERE payment_id = ? AND kind = 's'", p2.id);
  assert.equal(r1.status, 'prepared');
  assert.equal(r2.previous_uuid, r1.uuid, 'chained');
  const doc = JSON.parse(r2.document);
  const copy = JSON.parse(r2.document);
  copy.header.uuid = '';
  assert.equal(crypto.createHash('sha256').update(eta.serialize(copy), 'utf8').digest('hex'), doc.header.uuid, 'the UUID is the hash of the receipt');
  assert.equal(doc.paymentMethod, 'V');
  assert.equal(doc.taxTotals[0].taxType, 'T1');
  assert.ok(Math.abs(doc.netAmount + doc.taxTotals[0].amount - doc.totalAmount) < 0.0001);
  // refunded: a return receipt pointing at the original
  db.run("UPDATE pk_payments SET status = 'refunded' WHERE id = ?", p2.id);
  h.events.emit('parking.refunded', { payment: db.get('SELECT * FROM pk_payments WHERE id = ?', p2.id) });
  const ret = db.get("SELECT * FROM pk_ereceipts WHERE payment_id = ? AND kind = 'r'", p2.id);
  assert.equal(ret.reference_uuid, r2.uuid);
  assert.equal(JSON.parse(ret.document).documentType.receiptType, 'R');
  // sending, against a pretend ETA
  const seen = [];
  h.payments.fetchImpl = async (url, opts = {}) => {
    seen.push([url, opts.headers || {}]);
    if (/connect\/token/.test(url)) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (/receiptsubmissions$/.test(url)) {
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify({ submissionId: 'SUB-1', acceptedDocuments: body.receipts.map((x) => ({ uuid: x.header.uuid, receiptNumber: x.header.receiptNumber })), rejectedDocuments: [] }), { status: 202 });
    }
    if (/receiptsubmissions\/SUB-1\/details/.test(url)) return new Response(JSON.stringify({ receipts: [{ uuid: r1.uuid, status: 'Valid' }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const res = await mgr.form('/admin/parking/ereceipts/send', {});
    assert.equal(res.status, 303);
  } finally {
    h.payments.fetchImpl = null;
  }
  assert.equal(seen[0][1].posserial, 'POS-1', 'the POS signs in with its serial');
  assert.equal(db.value('SELECT status FROM pk_ereceipts WHERE id = ?', r1.id), 'valid');
  assert.equal(db.value('SELECT status FROM pk_ereceipts WHERE id = ?', r2.id), 'submitted');
  // the printed receipt carries the ETA code
  assert.match(await (await mgr.go(`/admin/parking/payments/${p1.id}/receipt`)).text(), /ETA e-receipt/);
});
