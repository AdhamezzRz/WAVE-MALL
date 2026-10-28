'use strict';

// The tenant portal (/portal), online payments (Paymob and the sandbox, payment links) and
// e-invoicing (ETA): accounts and their links, tenant isolation, CSRF, signed callbacks that record
// a payment exactly once, and the ETA document, its canonical string and its submission.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const paymob = require('../src/admin/paymob');
const eta = require('../src/admin/eta');
const { samplePdf } = require('../src/admin/files');
const i18n = require('../src/admin/i18n');

const SECRET = 'test-hmac-secret';
const ENV = {
  SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:', ADMIN_JOBS: '0',
  PAYMOB_API_KEY: 'test-key', PAYMOB_HMAC_SECRET: SECRET, PAYMOB_IFRAME_ID: '4242',
  PAYMOB_INTEGRATION_CARD: '11', PAYMOB_INTEGRATION_WALLET: '12', PAYMOB_INTEGRATION_KIOSK: '13',
  ETA_CLIENT_ID: 'client', ETA_CLIENT_SECRET: 'secret', ETA_SIGNER_URL: 'http://signer.test/sign',
};

// a fake Paymob and ETA (and signing service) behind fetch
const calls = [];
let orderSeq = 9000;
function fakeFetch(url, opts = {}) {
  calls.push({ url, opts });
  const ok = (body, status = 200) => Promise.resolve({ ok: status < 300, status, json: async () => body });
  if (url.endsWith('/api/auth/tokens')) return ok({ token: 'auth-token' });
  if (url.endsWith('/api/ecommerce/orders')) return ok({ id: ++orderSeq });
  if (url.endsWith('/api/acceptance/payment_keys')) return ok({ token: 'payment-key' });
  if (url.endsWith('/api/acceptance/payments/pay')) {
    const b = JSON.parse(opts.body);
    return b.source.subtype === 'WALLET' ? ok({ redirect_url: 'https://accept.paymob.com/wallet/redirect' }) : ok({ data: { bill_reference: 7788123 } });
  }
  if (url === ENV.ETA_SIGNER_URL) return ok({ signature: 'MIAGCSqGSIb3DQEHAqCAMIACAQEx' });
  if (url.endsWith('/connect/token')) return ok({ access_token: 'eta-token', expires_in: 3600 });
  if (url.endsWith('/api/v1.0/documentsubmissions')) {
    const docs = JSON.parse(opts.body).documents;
    return ok({ submissionId: 'SUB1', acceptedDocuments: docs.map((d, i) => ({ uuid: `UUID${i}${d.internalID}`, longId: `LONG${i}`, internalId: d.internalID })), rejectedDocuments: [] }, 202);
  }
  if (/\/api\/v1\.0\/documents\/[^/]+\/details$/.test(url)) return ok({ status: 'Valid', longId: 'LONGX' });
  if (/\/documents\/state\//.test(url)) return ok({});
  return ok({ error: 'unexpected' }, 404);
}

let app;
let server;
let base;
let db;
let h;
const jarOf = () => new Map();
const staff = jarOf();
function client(jar) {
  return async (path, opts = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
}
const go = client(staff);
const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const csrfOf = (html) => html.match(/name="csrf" content="([^"]+)"/)[1];
const tokenOf = (html) => html.match(/name="_token" value="([^"]+)"/)[1];
const revealedLink = (html) => (html.match(/<input readonly value="([^"]+)" class="ltr" data-select>/) || [])[1];
let csrf;
let brandA;
let brandB;

before(async () => {
  app = createApp({ env: ENV, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  base = `http://127.0.0.1:${server.address().port}`;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  h.payments.fetchImpl = fakeFetch;
  const setup = await (await go('/admin/setup')).text();
  await go('/admin/setup', form({ _token: tokenOf(setup), name: 'Admin', email: 'admin@thewave.test', password: 'long-enough-1' }));
  csrf = csrfOf(await (await go('/admin')).text());
  const brand = (name, taxId) => Number(db.run("INSERT INTO brands (name, category, legal_name, tax_id, created_at) VALUES (?, 'fashion', ?, ?, ?)", name, `${name} LLC`, taxId, new Date().toISOString()).lastInsertRowid);
  brandA = brand('Alpha Store', '512-874-339');
  brandB = brand('Beta Café', null);
  // a lease each, so they count as tenants
  for (const b of [brandA, brandB]) db.run("INSERT INTO leases (ref, brand_id, status, start_date, end_date, term_years, rent_m2, created_at) VALUES (?, ?, 'active', '2026-01-01', '2030-12-31', 5, 1000, ?)", `LS-T${b}`, b, new Date().toISOString());
});
after(() => server.close());

const invoice = (brandId, amount, extra = {}) => h.billing.createInvoice({ brand_id: brandId, kind: 'other', other: amount, due_date: new Date().toISOString().slice(0, 10), note: 'Marketing contribution', ...extra });

// invite a tenant from the office, accept the invitation, return a signed-in client
async function inviteAndJoin(brandId, email, password = 'tenant-pass-1') {
  let res = await go('/admin/portal/invite', form({ _csrf: csrf, brand_id: brandId, name: 'Test Tenant', email, lang: 'en' }));
  assert.equal(res.status, 303);
  const link = revealedLink(await (await go(res.headers.get('location'))).text());
  assert.match(link, /^https:\/\/thewavemall\.com\/portal\/welcome\/[\w-]{40,}$/);
  const path = link.replace('https://thewavemall.com', '');
  const jar = jarOf();
  const t = client(jar);
  const page = await (await t(path)).text();
  res = await t(path, form({ _token: tokenOf(page), password, confirm: password }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/portal');
  return { t, path, jar };
}
const tenantCsrf = async (t) => csrfOf(await (await t('/portal/account')).text());

test('portal: invitations are single-use and expire, sign-in works, the staff see the link once', async () => {
  const anon = client(jarOf());
  let res = await anon('/portal');
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/portal\/login/);

  const { t, path } = await inviteAndJoin(brandA, 'alpha@tenant.test');
  let html = await (await t('/portal')).text();
  assert.match(html, /Alpha Store/);
  assert.match(html, /<meta name="csrf"/);
  // the invitation cannot be used twice
  res = await anon(path);
  assert.equal(res.status, 410);

  // an expired invitation is refused
  res = await go('/admin/portal/invite', form({ _csrf: csrf, brand_id: brandA, name: 'Second Person', email: 'second@tenant.test' }));
  const link = revealedLink(await (await go(res.headers.get('location'))).text()).replace('https://thewavemall.com', '');
  // the link is shown once only
  assert.equal(revealedLink(await (await go(res.headers.get('location'))).text()), undefined);
  db.run("UPDATE portal_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL");
  res = await anon(link);
  assert.equal(res.status, 410);

  // the cookie is limited to /portal, HttpOnly
  const login = await (await anon('/portal/login')).text();
  res = await anon('/portal/login', form({ _token: tokenOf(login), email: 'alpha@tenant.test', password: 'tenant-pass-1' }));
  assert.equal(res.status, 303);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('wv_tenant='));
  assert.match(cookie, /Path=\/portal/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  // a wrong password
  res = await client(jarOf())('/portal/login', form({ _token: 'x', email: 'alpha@tenant.test', password: 'nope' }));
  assert.equal(res.status, 403, 'needs its form token');
});

test('portal: password reset links are single-use and expire', async () => {
  const u = db.get("SELECT * FROM portal_users WHERE email = 'alpha@tenant.test'");
  let res = await go(`/admin/portal/users/${u.id}/link`, form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  const path = revealedLink(await (await go(res.headers.get('location'))).text()).replace('https://thewavemall.com', '');
  assert.match(path, /^\/portal\/reset\//);
  const t = client(jarOf());
  const page = await (await t(path)).text();
  res = await t(path, form({ _token: tokenOf(page), password: 'short', confirm: 'short' }));
  assert.equal(res.status, 422);
  res = await t(path, form({ _token: tokenOf(await res.text()), password: 'tenant-pass-2', confirm: 'tenant-pass-2' }));
  assert.equal(res.status, 303);
  res = await t(path);
  assert.equal(res.status, 410, 'used once');
  // a fresh link that has run out
  res = await go(`/admin/portal/users/${u.id}/link`, form({ _csrf: csrf }));
  const late = revealedLink(await (await go(res.headers.get('location'))).text()).replace('https://thewavemall.com', '');
  db.run("UPDATE portal_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL");
  assert.equal((await t(late)).status, 410);
  // the forgot-password form says the same whatever the email
  const anon = client(jarOf());
  const f = await (await anon('/portal/forgot')).text();
  res = await anon('/portal/forgot', form({ _token: tokenOf(f), email: 'nobody@nowhere.test' }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /If that email has a portal account/);
});

test('portal: a tenant sees only its own invoices, receipts and files; forms need CSRF', async () => {
  const a = await inviteAndJoin(brandA, 'alpha2@tenant.test');
  await inviteAndJoin(brandB, 'beta@tenant.test');
  const mine = invoice(brandA, 5000);
  const theirs = invoice(brandB, 7000);
  const theirPay = h.billing.recordPayment({ invoice_id: theirs.id, amount: 1000, method: 'transfer' }).payment;
  const theirDoc = Number(db.run("INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, created_at) VALUES ('DOC-X1', 'brand', ?, 'tax_card', 'Tax card', 'x.pdf', 'application/pdf', 10, 'abc', 'abc.pdf', ?)", brandB, new Date().toISOString()).lastInsertRowid);

  assert.equal((await a.t(`/portal/invoices/${mine.id}`)).status, 200);
  for (const p of [`/portal/invoices/${theirs.id}`, `/portal/invoices/${theirs.id}/print`, `/portal/payments/${theirPay.id}/receipt`, `/portal/documents/${theirDoc}/file`]) {
    assert.equal((await a.t(p)).status, 404, p);
  }
  const list = await (await a.t('/portal/invoices')).text();
  assert.match(list, new RegExp(mine.ref));
  assert.doesNotMatch(list, new RegExp(theirs.ref));
  const c = await tenantCsrf(a.t);
  let res = await a.t(`/portal/invoices/${theirs.id}/pay`, form({ _csrf: c, method: 'card' }));
  assert.equal(res.status, 404, 'cannot pay someone else’s invoice');

  // CSRF
  res = await a.t('/portal/account', form({ name: 'Changed', lang: 'en' }));
  assert.equal(res.status, 403);
  res = await a.t('/portal/account', form({ _csrf: c, name: 'Changed Name', lang: 'en' }));
  assert.equal(res.status, 303);
  assert.equal(db.value("SELECT name FROM portal_users WHERE email = 'alpha2@tenant.test'"), 'Changed Name');
  // the office's session does not open the portal, and the portal's does not open the office
  assert.equal((await go('/portal')).status, 303);
  assert.equal((await a.t('/admin')).status, 303);

  // a tenant uploads a renewal: filed on the brand, visible to the office, marked as from the tenant
  res = await a.t('/portal/documents/upload?kind=insurance&title=Insurance%202027&expires_on=2027-12-31', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-csrf': c, 'x-file-name': 'insurance.pdf', accept: 'application/json' }, body: samplePdf('Insurance', ['Policy 2027']),
  });
  assert.equal(res.status, 200);
  const doc = db.get('SELECT * FROM documents WHERE id = ?', (await res.json()).id);
  assert.equal(doc.entity, 'brand');
  assert.equal(doc.entity_id, brandA);
  assert.equal(doc.confidential, 0);
  assert.ok(doc.portal_user_id);
  assert.match(doc.notes, /Submitted by the tenant/);
  res = await a.t('/portal/documents/upload?kind=insurance', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'x.pdf', accept: 'application/json' }, body: samplePdf('x') });
  assert.equal(res.status, 403, 'uploads need the CSRF header');
});

test('payments: Paymob card checkout, signed callback, once only; bad signature and wrong amount refused', async () => {
  const { t } = await inviteAndJoin(brandA, 'payer@tenant.test');
  const inv = invoice(brandA, 12500);
  const events = [];
  h.events.on('payment.received', (p) => events.push(p));
  const c = await tenantCsrf(t);
  let res = await t(`/portal/invoices/${inv.id}/pay`, form({ _csrf: c, method: 'card' }));
  assert.equal(res.status, 303);
  const checkout = res.headers.get('location');
  assert.match(checkout, /^\/pay\/checkout\/[\w-]+\?lang=en$/);
  const html = await (await t(checkout)).text();
  assert.match(html, /http-equiv="refresh" content="1;url=https:\/\/accept\.paymob\.com\/api\/acceptance\/iframes\/4242\?payment_token=payment-key"/);
  const intent = db.get('SELECT * FROM payment_intents WHERE invoice_id = ?', inv.id);
  assert.equal(intent.status, 'pending');
  const order = JSON.parse(calls.find((x) => x.url.endsWith('/api/ecommerce/orders') && JSON.parse(x.opts.body).merchant_order_id === intent.merchant_order_id).opts.body);
  assert.equal(order.amount_cents, 1250000);

  const obj = (over = {}) => ({
    id: 777001, amount_cents: 1250000, created_at: '2026-10-28T10:00:00.000000', currency: 'EGP', error_occured: false, has_parent_transaction: false,
    integration_id: 11, is_3d_secure: true, is_auth: false, is_capture: false, is_refunded: false, is_standalone_payment: true, is_voided: false,
    order: { id: Number(intent.provider_order_id), merchant_order_id: intent.merchant_order_id }, owner: 5, pending: false,
    source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' }, success: true, data: { message: 'Approved' }, ...over,
  });
  const post = (o, hmac) => fetch(`${base}/payments/paymob/callback?hmac=${hmac}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'TRANSACTION', obj: o }) });
  const signed = (o) => paymob.sign(SECRET, paymob.hmacStringFromObject(o));

  // a forged callback
  res = await post(obj(), 'f'.repeat(128));
  assert.equal(res.status, 401);
  assert.equal(db.get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'open');
  // the right signature over the wrong amount
  const cheap = obj({ amount_cents: 100 });
  res = await post(cheap, signed(cheap));
  assert.equal((await res.json()).result, 'amount mismatch');
  assert.equal(db.get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'open');
  // the real one, twice
  res = await post(obj(), signed(obj()));
  assert.equal((await res.json()).result, 'paid');
  res = await post(obj(), signed(obj()));
  assert.equal((await res.json()).result, 'duplicate');
  const after = db.get('SELECT * FROM invoices WHERE id = ?', inv.id);
  assert.equal(after.status, 'paid');
  const pays = db.all('SELECT * FROM payments WHERE invoice_id = ?', inv.id);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].provider, 'paymob');
  assert.equal(pays[0].provider_ref, '777001');
  assert.equal(pays[0].method, 'online');
  assert.equal(events.filter((e) => e.invoice.id === inv.id).length, 1);

  // the payer comes back through the signed return URL
  const q = { id: '777001', amount_cents: '1250000', created_at: '2026-10-28T10:00:00.000000', currency: 'EGP', error_occured: 'false', has_parent_transaction: 'false', integration_id: '11', is_3d_secure: 'true', is_auth: 'false', is_capture: 'false', is_refunded: 'false', is_standalone_payment: 'true', is_voided: 'false', order: intent.provider_order_id, owner: '5', pending: 'false', 'source_data.pan': '2346', 'source_data.sub_type': 'MasterCard', 'source_data.type': 'card', success: 'true', merchant_order_id: intent.merchant_order_id };
  q.hmac = paymob.sign(SECRET, paymob.hmacStringFromQuery(q));
  res = await fetch(`${base}/payments/paymob/return?${new URLSearchParams(q)}`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/pay/result/${intent.token}`);
  const result = await (await fetch(base + res.headers.get('location'))).text();
  assert.match(result, /Payment received/);
  assert.equal(db.value('SELECT COUNT(*) FROM payments WHERE invoice_id = ?', inv.id), 1, 'still once');
  // a tampered return is not trusted
  res = await fetch(`${base}/payments/paymob/return?${new URLSearchParams({ ...q, amount_cents: '1' })}`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/pay/result/unknown');
});

test('payments: wallet and kiosk checkouts', async () => {
  const { t } = await inviteAndJoin(brandA, 'wallet@tenant.test');
  const inv = invoice(brandA, 900);
  const c = await tenantCsrf(t);
  let res = await t(`/portal/invoices/${inv.id}/pay`, form({ _csrf: c, method: 'wallet', wallet_phone: '123' }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/portal/invoices/${inv.id}`, 'a bad wallet number goes back with a message');
  res = await t(`/portal/invoices/${inv.id}/pay`, form({ _csrf: c, method: 'wallet', wallet_phone: '+20 100 123 4567' }));
  assert.match(await (await t(res.headers.get('location'))).text(), /wallet\/redirect/);
  res = await t(`/portal/invoices/${inv.id}/pay`, form({ _csrf: c, method: 'kiosk' }));
  assert.match(await (await t(res.headers.get('location'))).text(), /7788123/);
});

test('payments: sandbox checkout end to end (sample invoices never touch Paymob)', async () => {
  const { t } = await inviteAndJoin(brandB, 'sandbox@tenant.test');
  const inv = invoice(brandB, 3000, { demo: 1 });
  const events = [];
  h.events.on('payment.received', (p) => events.push(p));
  const before = calls.length;
  const c = await tenantCsrf(t);
  let res = await t(`/portal/invoices/${inv.id}/pay`, form({ _csrf: c, method: 'card' }));
  const page = res.headers.get('location');
  assert.match(page, /^\/pay\/sandbox\//);
  assert.match(await (await t(page)).text(), /no money moves/);
  res = await t(page.split('?')[0], form({ decision: 'approve' }));
  assert.equal(res.status, 303);
  assert.match(await (await t(res.headers.get('location'))).text(), /Payment received/);
  assert.equal(db.get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'paid');
  const p = db.get('SELECT * FROM payments WHERE invoice_id = ?', inv.id);
  assert.equal(p.provider, 'sandbox');
  assert.equal(events.length, 1);
  assert.equal(calls.length, before, 'no call to Paymob');
  // approving again changes nothing
  await t(page.split('?')[0], form({ decision: 'approve' }));
  assert.equal(db.value('SELECT COUNT(*) FROM payments WHERE invoice_id = ?', inv.id), 1);
  // a live (non-sample) invoice cannot be approved in the sandbox
  const live = invoice(brandB, 100);
  const tok = 'x'.repeat(43);
  db.run("INSERT INTO payment_intents (token, invoice_id, amount, method, provider, status, created_at, updated_at) VALUES (?, ?, 100, 'card', 'paymob', 'pending', ?, ?)", tok, live.id, new Date().toISOString(), new Date().toISOString());
  res = await t(`/pay/sandbox/${tok}`, form({ decision: 'approve' }));
  assert.equal(res.status, 404);
  assert.equal(db.get('SELECT status FROM invoices WHERE id = ?', live.id).status, 'open');
});

test('payments: a payment link works without signing in, and stops when it expires or is cancelled', async () => {
  const inv = invoice(brandB, 4200);
  let res = await go(`/admin/invoices/${inv.id}/payment-link`, form({ _csrf: csrf, amount: '', days: '14', email: '' }));
  assert.equal(res.status, 303);
  const page = await (await go(res.headers.get('location'))).text();
  const url = revealedLink(page);
  assert.match(url, /^https:\/\/thewavemall\.com\/pay\/[\w-]{40,}$/);
  const path = url.replace('https://thewavemall.com', '');
  const anon = client(jarOf());
  let html = await (await anon(path)).text();
  assert.match(html, new RegExp(inv.ref));
  assert.match(html, /Pay online/);
  res = await anon(path, form({ method: 'card' }));
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/pay\/checkout\//);
  assert.equal(db.get('SELECT source FROM payment_intents ORDER BY id DESC LIMIT 1').source, 'link');
  db.run('UPDATE payment_links SET expires_at = ? WHERE invoice_id = ?', '2000-01-01T00:00:00.000Z', inv.id);
  assert.equal((await anon(path)).status, 410);
  res = await anon(path, form({ method: 'card' }));
  assert.equal(res.status, 410, 'an expired link cannot start a payment');
  assert.equal((await anon('/pay/not-a-real-token-at-all-not-a-real-token-xx')).status, 404);
});

test('payments: a staff receipt and the online payments page render', async () => {
  for (const p of ['/admin/payments/online', '/admin/payments/online?view=links', '/admin/payments/online?view=events', '/admin/portal']) {
    const res = await go(p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, p);
  }
  const p = db.get("SELECT id FROM payments WHERE provider = 'paymob' LIMIT 1");
  const html = await (await go(`/admin/payments/${p.id}/receipt`)).text();
  assert.match(html, /Receipt/);
  assert.match(html, /Alpha Store LLC/);
});

test('eta: canonical serialization, totals and checks', () => {
  assert.equal(eta.serialize({ a: '1', list: [{ b: 2 }, { b: 3 }], signatures: [{ x: 1 }], n: { c: 'x' } }), '"A""1""LIST""LIST""B""2""LIST""B""3""N""C""x"');
  const inv = { ref: 'IN-2026-0001', rent: 10000, service: 2000, other: 0, total: 13680, vat: 1680, due_date: '2026-10-01', kind: 'rent' };
  const s = { eta_rin: '100234567', eta_name: 'The Wave Mall', eta_item_rent: 'RENT01', eta_item_service: 'SRVC01', eta_item_other: 'OTHR01' };
  const doc = eta.buildDocument(inv, { name: 'Alpha', legal_name: 'Alpha LLC', tax_id: '512-874-339' }, s, { issuedAt: '2026-10-01T08:00:00Z' });
  assert.equal(doc.invoiceLines.length, 2);
  assert.equal(doc.netAmount, 12000);
  assert.equal(doc.taxTotals[0].amount, 1680);
  assert.equal(doc.totalAmount, 13680, 'the e-invoice matches what the tenant was billed');
  assert.equal(doc.invoiceLines[0].taxableItems[0].rate, 14);
  assert.equal(doc.invoiceLines[0].itemCode, 'EG-100234567-RENT01');
  assert.equal(doc.receiver.type, 'B');
  assert.equal(doc.receiver.id, '512874339');
  assert.deepEqual(eta.validate(doc), []);
  assert.match(eta.serialize(doc), /^"ISSUER""ADDRESS""BRANCHID""0""COUNTRY""EG"/);
  assert.match(eta.serialize(doc), /"INVOICELINES""INVOICELINES""DESCRIPTION""Rent"/);
  assert.equal(eta.canonicalHash(doc).length, 64);
  // no VAT on the invoice: exempt lines
  const plain = eta.buildDocument({ ref: 'X', other: 500, total: 500, vat: 0 }, { name: 'Walk-in' }, s);
  assert.equal(plain.invoiceLines[0].taxableItems[0].subType, 'V003');
  assert.equal(plain.receiver.type, 'P');
  const bad = eta.buildDocument({ ref: 'Y', other: 60000, total: 60000 }, { name: 'Walk-in' }, { eta_rin: '12' });
  const errs = eta.validate(bad);
  assert.ok(errs.includes('The mall’s tax registration number (RIN) must be 9 digits.'));
  assert.ok(errs.some((e) => e.startsWith('A receiver without a tax ID')));
});

test('eta: the API client with a mocked fetch', async () => {
  const seen = [];
  const f = async (url, opts) => {
    seen.push(url);
    return fakeFetch(url, opts);
  };
  const api = eta.api({ env: 'preprod', clientId: 'a', clientSecret: 'b', fetchImpl: f });
  const out = await api.submit([{ internalID: 'IN-1' }]);
  assert.equal(out.acceptedDocuments[0].internalId, 'IN-1');
  await api.status('UUID0IN-1');
  assert.equal(seen.filter((u) => u.endsWith('/connect/token')).length, 1, 'the token is reused');
  assert.ok(seen.every((u) => u.includes('preprod')));
  assert.equal(await eta.signWithService(ENV.ETA_SIGNER_URL, '"A""1"', { fetchImpl: f }), 'MIAGCSqGSIb3DQEHAqCAMIACAQEx');
  await assert.rejects(eta.api({ clientId: 'a', clientSecret: 'b', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }).token(), /sign-in failed/);
});

test('eta: prepare, sign, submit, status and a voided invoice', async () => {
  let res = await go('/admin/eta/settings', form({ _csrf: csrf, eta_env: 'preprod', eta_rin: '100234567', eta_name: 'The Wave Mall', eta_branch: '0', eta_activity: '6810', eta_governate: 'Cairo', eta_city: 'New Cairo', eta_street: 'North 90', eta_building: '1', eta_item_rent: 'RENT01', eta_item_service: 'SRVC01', eta_item_other: 'OTHR01', eta_vat_rate: '' }));
  assert.equal(res.status, 303);
  const inv = invoice(brandA, 8000);
  res = await go(`/admin/eta/invoice/${inv.id}/prepare`, form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  let doc = db.get('SELECT * FROM eta_documents WHERE invoice_id = ?', inv.id);
  assert.equal(doc.status, 'ready', doc.errors);
  res = await go(`/admin/eta/doc/${doc.id}/submit`, form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  doc = db.get('SELECT * FROM eta_documents WHERE id = ?', doc.id);
  assert.equal(doc.status, 'submitted');
  assert.match(doc.uuid, /^UUID0IN-/);
  const sub = calls.filter((c) => c.url.endsWith('/documentsubmissions')).pop();
  assert.equal(JSON.parse(sub.opts.body).documents[0].signatures[0].signatureType, 'I');
  assert.equal(await h.eta.poll(), 1);
  assert.equal(db.get('SELECT status FROM eta_documents WHERE id = ?', doc.id).status, 'valid');
  // deposits are not sales
  const dep = invoice(brandA, 5000, { kind: 'deposit' });
  assert.equal(h.eta.prepare(dep), null);
  // voiding an invoice already at the ETA asks for a cancellation there
  h.billing.voidInvoice(inv.id);
  assert.equal(db.get('SELECT status FROM eta_documents WHERE id = ?', doc.id).status, 'cancel_needed');
  for (const p of ['/admin/eta', `/admin/eta/doc/${doc.id}`, `/admin/invoices/${inv.id}`]) {
    res = await go(p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, p);
  }
});

test('portal: pages are fully Arabic, with sample data; sample data clears again', { timeout: 120000 }, async () => {
  let res = await go('/admin/settings/demo', form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  const pw = db.setting('portal_demo_password');
  assert.ok(pw.length >= 10);
  assert.match(await (await go('/admin/portal')).text(), new RegExp(pw.replace(/[-]/g, '\\-')));
  assert.ok(db.value("SELECT COUNT(*) FROM payment_intents WHERE demo = 1 AND status = 'paid'") >= 1);
  assert.ok(db.value('SELECT COUNT(*) FROM portal_notices WHERE demo = 1') >= 3);
  const u = db.get("SELECT * FROM portal_users WHERE demo = 1 AND password_hash IS NOT NULL ORDER BY id LIMIT 1");
  const t = client(jarOf());
  const login = await (await t('/portal/login?lang=ar')).text();
  assert.match(login, /<html lang="ar" dir="rtl"/);
  res = await t('/portal/login', form({ _token: tokenOf(login), email: u.email, password: pw }));
  assert.equal(res.status, 303);

  // names, emails and references people typed are not expected in Arabic
  const typed = new Set();
  for (const r of db.all('SELECT name, legal_name, signatory_name, store_manager, legal_address FROM brands')) Object.values(r).forEach((v) => v && typed.add(v));
  for (const r of db.all('SELECT name, email FROM portal_users')) Object.values(r).forEach((v) => v && typed.add(v));
  for (const r of db.all('SELECT name FROM portal_users UNION SELECT signatory_name FROM brands')) for (const w of String(r.name || '').split(/\s+/)) if (w.length > 2) typed.add(w);
  // other modules' stored invoice notes and portal tabs are checked by their own tests (their keys show in i18n.missing)
  for (const r of db.all("SELECT DISTINCT note FROM invoices WHERE note IS NOT NULL")) typed.add(r.note);
  for (const r of db.all('SELECT ref FROM invoices UNION SELECT ref FROM payments UNION SELECT reference FROM payments UNION SELECT ref FROM leases UNION SELECT title FROM documents UNION SELECT file_name FROM documents UNION SELECT code FROM units')) Object.values(r).forEach((v) => v && typed.add(v));
  const list = [...typed].map(String).sort((a, b) => b.length - a.length);
  const OK = new Set(['The', 'Wave', 'English', 'PDF', 'JPG', 'PNG', 'WebP', 'Word', 'Excel', 'EGP', 'IBAN']);
  const leftovers = {};
  const n = db.get("SELECT id FROM portal_notices WHERE demo = 1 AND status = 'published' AND audience = 'all' LIMIT 1").id;
  const inv = db.get("SELECT id FROM invoices WHERE brand_id = ? AND status != 'void' ORDER BY due_date LIMIT 1", u.brand_id).id;
  const pay = db.get("SELECT id FROM payments WHERE brand_id = ? AND status = 'received' LIMIT 1", u.brand_id);
  for (const p of ['/portal', '/portal/invoices', '/portal/invoices?view=upcoming', '/portal/invoices?view=paid', `/portal/invoices/${inv}`, `/portal/invoices/${inv}/print`, '/portal/payments', ...(pay ? [`/portal/payments/${pay.id}/receipt`] : []), '/portal/documents', '/portal/notices', `/portal/notices/${n}`, '/portal/account']) {
    res = await t(`${p}${p.includes('?') ? '&' : '?'}lang=ar`);
    if (res.status === 303) res = await t(res.headers.get('location'));
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.match(html, /<html lang="ar" dir="rtl"/, p);
    let body = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<head>[\s\S]*?<\/head>/, ' ').replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/g, ' ');
    body = body.replace(/<option value="en"[^>]*>English<\/option>/g, ' ');
    const attrs = [...body.matchAll(/\s(?:title|placeholder|aria-label|data-confirm)="([^"]*)"/g)].map((m) => m[1]);
    const texts = body.replace(/<[^>]+>/g, '\n').split('\n').concat(attrs).map((x) => x.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()).filter(Boolean);
    const left = [];
    for (let s of texts) {
      for (const v of list) if (s.includes(v)) s = s.split(v).join(' ');
      for (const k of i18n.missing) if (!k.startsWith('por|') && s.includes(i18n.english(k))) s = s.split(i18n.english(k)).join(' ');
      s = s.replace(/\S+@\S+/g, ' ').replace(/https?:\/\/\S+/g, ' ');
      const words = (s.match(/[A-Za-z][A-Za-z'’-]*[A-Za-z]/g) || []).filter((w) => !OK.has(w));
      if (words.length && !/^[A-Z]{1,3}$/.test(s.trim())) left.push(s.trim());
    }
    if (left.length) leftovers[p] = left;
  }
  assert.deepEqual(leftovers, {}, 'English left on Arabic portal pages');

  // phone layout: the tab bar is there
  assert.match(await (await t('/portal')).text(), /class="tabbar"/);

  res = await go('/admin/settings/demo/clear', form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  assert.equal(db.value('SELECT COUNT(*) FROM portal_users WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM portal_notices WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM payment_intents WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM eta_documents WHERE demo = 1'), 0);
  assert.equal(db.setting('portal_demo_password'), '');
  assert.equal(db.setting('eta_rin'), '100234567', 'real ETA settings are kept');
});
