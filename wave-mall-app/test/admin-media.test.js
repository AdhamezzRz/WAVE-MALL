'use strict';

// Advertising and media sales: rate-card pricing with seasons and discounts, clashes refused
// (exclusive spaces and screen slots), holds that run out, invoices of kind 'media' posted to
// advertising income with the books balanced, and discounts above the rule going through
// approvals (the approvals module when present, a stub here, or a manager on the campaign).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const MD = require('../src/admin/routes/media');

let server;
let base;
let db;
let h;
let M;
let admin;
let agent;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  M = h.M;
  base = `http://127.0.0.1:${server.address().port}`;
  db.run("INSERT INTO users (name, email, role, password_hash, finance, created_at) VALUES ('Media Admin', 'md-admin@thewave.test', 'admin', ?, 1, datetime('now'))", hashPassword('long-enough-1'));
  db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES ('Media Agent', 'md-agent@thewave.test', 'agent', ?, datetime('now'))", hashPassword('long-enough-1'));
  admin = browser();
  await admin.signIn('md-admin@thewave.test', 'long-enough-1');
  agent = browser();
  await agent.signIn('md-agent@thewave.test', 'long-enough-1');
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
const T = () => M.today();
const day = (n) => M.addDays(T(), n);
let seq = 0;
// an advertising space (a banner by default; slots > 1 makes a screen)
function item(o = {}) {
  seq++;
  const v = { code: `T-${seq}`, name: `Test space ${seq}`, type: 'banner', slots: 1, rate_day: 1000, rate_week: 6300, rate_month: 24000, min_days: 1, ...o };
  return Number(db.run(`INSERT INTO media_items (code, name, type, slots, slot_seconds, rate_day, rate_week, rate_month, min_days, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`, v.code, v.name, v.type, v.slots, v.slots > 1 ? 10 : null, v.rate_day, v.rate_week, v.rate_month, v.min_days).lastInsertRowid);
}
const client = (name) => Number(db.run("INSERT INTO media_clients (name, kind, created_at, updated_at) VALUES (?, 'company', datetime('now'), datetime('now'))", name).lastInsertRowid);
const campaignByTitle = (title) => db.get('SELECT * FROM media_campaigns WHERE title = ?', title);
// a proposal through the quote builder: POST /admin/media/campaigns
async function propose(b, { title, items, start, end, slots = {}, extra = 0, who }) {
  const body = new URLSearchParams({ _csrf: b.csrf, client: who, title, start, end, extra: String(extra) });
  for (const id of items) body.append('item', String(id));
  for (const [id, n] of Object.entries(slots)) body.append(`slots_${id}`, String(n));
  const r = await b.go('/admin/media/campaigns', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  assert.equal(r.status, 303);
  const c = campaignByTitle(title);
  assert.ok(c, `proposal ${title} saved`);
  return c;
}
const flash = async (b) => (await (await b.go('/admin')).text());

test('media: pricing from the rate card, seasons and discounts', () => {
  const banner = { id: 1, code: 'B', slots: 1, rate_day: 1000, rate_week: 6300, rate_month: 24000, min_days: 1 };
  // the day, week and month rates
  let q = MD.priceLine(banner, '2027-03-01', '2027-03-03');
  assert.deepEqual([q.days, q.rate, q.list], [3, 'day', 3000]);
  q = MD.priceLine(banner, '2027-03-01', '2027-03-10');
  assert.deepEqual([q.days, q.rate, q.list], [10, 'week', 9000], 'ten days at the weekly rate (900 a day)');
  q = MD.priceLine(banner, '2027-03-01', '2027-03-30');
  assert.deepEqual([q.days, q.rate, q.list], [30, 'month', 24000]);
  // a season on part of the range, the higher of two overlapping seasons
  const seasons = [{ start_date: '2027-03-02', end_date: '2027-03-03', pct: 50 }, { start_date: '2027-03-03', end_date: '2027-03-05', pct: 20 }];
  q = MD.priceLine(banner, '2027-03-01', '2027-03-04', { seasons });
  assert.equal(q.seasonDays, 3);
  assert.equal(q.list, 1000 + 1500 + 1500 + 1200, '+50% on the 2nd and 3rd (the higher wins), +20% on the 4th');
  // a quiet season lowers the price
  assert.equal(MD.priceLine(banner, '2027-03-01', '2027-03-01', { seasons: [{ start_date: '2027-03-01', end_date: '2027-03-01', pct: -25 }] }).list, 750);
  // a screen is priced per slot, never above its loop
  const screen = { id: 2, code: 'S', slots: 6, rate_day: 500 };
  assert.equal(MD.priceLine(screen, '2027-03-01', '2027-03-02', { slots: 2 }).list, 2000);
  assert.equal(MD.priceLine(screen, '2027-03-01', '2027-03-01', { slots: 9 }).slots, 6);
  // refusals
  assert.match(MD.priceLine({ ...banner, min_days: 7 }, '2027-03-01', '2027-03-03').error, /at least/);
  assert.match(MD.priceLine({ id: 3, code: 'X' }, '2027-03-01', '2027-03-03').error, /no rates/);
  assert.match(MD.priceLine(banner, '2027-03-05', '2027-03-01').error, /start and an end/);

  // discounts: duration per line, volume on the number of spaces, then the extra discount
  const tiers = [{ kind: 'duration', threshold: 28, pct: 10 }, { kind: 'duration', threshold: 84, pct: 15 }, { kind: 'volume', threshold: 2, pct: 5 }];
  const lines = [{ item_id: 1, days: 30, list: 24000 }, { item_id: 2, days: 10, list: 9000 }];
  const p = MD.priceCampaign(lines, { tiers, extraPct: 10 });
  assert.equal(p.list, 33000);
  assert.equal(p.durationOff, 2400, '10% off the month-long line only');
  assert.equal(p.volumePct, 5);
  assert.equal(p.volumeOff, 1530);
  assert.equal(p.total, Math.round((21600 + 9000) * 0.95 * 0.9));
  assert.equal(p.extraOff, Math.round((30600 * 0.95 - p.total) * 100) / 100);
  assert.equal(Math.round(p.lines.reduce((s, l) => s + l.price, 0) * 100) / 100, p.total, 'the lines add up to the total');
  assert.ok(p.pct > 20 && p.pct < 30);
  // monthly invoices split each line by its days, and add up
  const plan = MD.invoicePlan([{ start_date: '2027-01-20', end_date: '2027-02-18', days: 30, price: 3000 }], { monthly: true });
  assert.deepEqual(plan.map((x) => [x.period_start, x.period_end, x.amount]), [['2027-01-20', '2027-01-31', 1200], ['2027-02-01', '2027-02-18', 1800]]);
  assert.equal(MD.invoicePlan([{ start_date: '2027-01-20', end_date: '2027-02-18', days: 30, price: 3000 }]).length, 1);
});

test('media: clashes are refused, on an exclusive space and on a screen\'s slots', async () => {
  // the pure check
  const others = [{ item_id: 7, start_date: '2027-05-01', end_date: '2027-05-10', slots: 4 }];
  assert.equal(MD.conflicts(others, { id: 7, slots: 6 }, '2027-05-05', '2027-05-06', 2).length, 0, '4 + 2 fit a loop of 6');
  assert.equal(MD.conflicts(others, { id: 7, slots: 6 }, '2027-05-09', '2027-05-12', 3).length, 2, '4 + 3 do not, on the 9th and 10th');
  assert.equal(MD.conflicts(others, { id: 8, slots: 1 }, '2027-05-01', '2027-05-10', 1).length, 0, 'another space is free');

  const banner = item();
  const screen = item({ type: 'screen', slots: 3, rate_day: 400 });
  const a = client('Clash One');
  const b = client('Clash Two');
  const c1 = await propose(agent, { title: 'Clash A', items: [banner, screen], slots: { [screen]: 2 }, start: day(10), end: day(16), who: `c:${a}` });
  let r = await agent.form(`/admin/media/campaigns/${c1.id}/hold`, {});
  assert.equal(r.status, 303);
  assert.equal(campaignByTitle('Clash A').status, 'held');
  assert.equal(campaignByTitle('Clash A').hold_until, day(5));
  // a second campaign may be proposed on the same days, but not held or confirmed
  const c2 = await propose(agent, { title: 'Clash B', items: [banner], start: day(14), end: day(20), who: `c:${b}` });
  r = await agent.form(`/admin/media/campaigns/${c2.id}/hold`, {});
  assert.match(await flash(agent), /fully booked/);
  assert.equal(campaignByTitle('Clash B').status, 'proposal');
  r = await agent.form(`/admin/media/campaigns/${c2.id}/confirm`, { invoice: '' });
  assert.equal(campaignByTitle('Clash B').status, 'proposal', 'confirming a clash is refused too');
  // the screen: 2 of 3 slots taken, one more fits, two more do not
  const c3 = await propose(agent, { title: 'Clash C', items: [screen], slots: { [screen]: 1 }, start: day(12), end: day(13), who: `c:${b}` });
  await agent.form(`/admin/media/campaigns/${c3.id}/hold`, {});
  assert.equal(campaignByTitle('Clash C').status, 'held');
  const c4 = await propose(agent, { title: 'Clash D', items: [screen], slots: { [screen]: 1 }, start: day(13), end: day(14), who: `c:${a}` });
  await agent.form(`/admin/media/campaigns/${c4.id}/hold`, {});
  assert.equal(campaignByTitle('Clash D').status, 'proposal', 'the loop is full on the 13th');
  // the calendar and the builder show it
  const cal = await (await agent.go(`/admin/media/calendar?month=${day(12).slice(0, 7)}`)).text();
  assert.match(cal, /Clash One · 2\/3/);
  const qb = await (await agent.go(`/admin/media/quote?start=${day(12)}&end=${day(13)}&item=${banner}&item=${screen}`)).text();
  assert.match(qb, /Taken/);
  // cancelling frees the space
  await admin.form(`/admin/media/campaigns/${c1.id}/cancel`, { reason: 'Test' });
  await agent.form(`/admin/media/campaigns/${c2.id}/hold`, {});
  assert.equal(campaignByTitle('Clash B').status, 'held');
});

test('media: a hold runs out and frees the space', async () => {
  const banner = item();
  const a = client('Hold One');
  const b = client('Hold Two');
  const c1 = await propose(agent, { title: 'Hold A', items: [banner], start: day(30), end: day(35), who: `c:${a}` });
  await agent.form(`/admin/media/campaigns/${c1.id}/hold`, {});
  const c2 = await propose(agent, { title: 'Hold B', items: [banner], start: day(32), end: day(40), who: `c:${b}` });
  await agent.form(`/admin/media/campaigns/${c2.id}/hold`, {});
  assert.equal(campaignByTitle('Hold B').status, 'proposal');
  // yesterday was the last day of the hold
  db.run('UPDATE media_campaigns SET hold_until = ? WHERE id = ?', day(-1), c1.id);
  // an expired hold no longer takes the space, even before the sweep
  await agent.form(`/admin/media/campaigns/${c2.id}/hold`, {});
  assert.equal(campaignByTitle('Hold B').status, 'held');
  h.media.sweep();
  const x = campaignByTitle('Hold A');
  assert.equal(x.status, 'proposal');
  assert.equal(x.hold_until, null);
  assert.ok(db.get("SELECT id FROM audit WHERE action = 'Media hold expired' AND entity_id = ?", c1.id));
  // and the first one cannot take it back
  await agent.form(`/admin/media/campaigns/${c1.id}/hold`, {});
  assert.equal(campaignByTitle('Hold A').status, 'proposal');
});

test('media: confirming invoices kind media, posted to advertising income, books balanced', async () => {
  assert.ok(h.billing.KINDS.includes('media'));
  assert.equal(M.INVOICE_KINDS.media, 'Advertising');
  const L = h.ledger;
  assert.ok(L.byKey('inc_media'), 'the advertising income account is in the chart');
  const brand = Number(db.run("INSERT INTO brands (name, category, created_at) VALUES ('Media Brand', 'fashion', datetime('now'))").lastInsertRowid);
  const banner = item({ rate_day: 1000 });
  // starts tomorrow, runs into next month: month-by-month invoices
  const start = day(1);
  const end = M.addDays(`${M.addMonths(`${start.slice(0, 7)}-01`, 1).slice(0, 7)}-01`, 4);
  const c = await propose(agent, { title: 'Invoiced campaign', items: [banner], start, end, who: `b:${brand}` });
  const r = await agent.form(`/admin/media/campaigns/${c.id}/confirm`, { invoice: '1', monthly: '1' });
  assert.equal(r.status, 303);
  const x = campaignByTitle('Invoiced campaign');
  assert.equal(x.status, 'confirmed');
  const invs = db.all("SELECT * FROM invoices WHERE source = 'media' AND source_id = ? ORDER BY period_start", c.id);
  assert.equal(invs.length, 2, 'one invoice per month');
  assert.ok(invs.every((i) => i.kind === 'media' && i.brand_id === brand));
  assert.equal(Math.round(invs.reduce((s, i) => s + i.total - i.vat, 0) * 100) / 100, x.total, 'the invoices add up to the campaign');
  const vatPct = Number(db.setting('vat_pct')) || 0;
  if (vatPct) assert.ok(invs[0].vat > 0, 'VAT on top');
  // the first is due now: posted to advertising income; the books balance
  L.sync && L.sync();
  const income = db.value("SELECT COALESCE(SUM(l.credit - l.debit), 0) FROM acc_lines l JOIN acc_accounts a ON a.id = l.account_id WHERE a.key = 'inc_media'");
  assert.equal(Math.round(income * 100) / 100, Math.round((invs[0].total - invs[0].vat) * 100) / 100);
  const tb = db.get('SELECT ROUND(SUM(debit), 2) d, ROUND(SUM(credit), 2) c FROM acc_lines');
  assert.ok(Math.abs((tb.d || 0) - (tb.c || 0)) < 0.005, 'debits equal credits');
  // nothing left to invoice; a confirmed campaign cannot change
  await agent.form(`/admin/media/campaigns/${c.id}/invoice`, {});
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE source = 'media' AND source_id = ?", c.id), 2);
  await agent.form(`/admin/media/campaigns/${c.id}/discount`, { extra: '5' });
  assert.equal(campaignByTitle('Invoiced campaign').extra_pct, 0);
  // the tenant file shows the brand's advertising
  const file = await (await admin.go(`/admin/tenants/${brand}`)).text();
  assert.match(file, /Invoiced campaign/);
  // cancelling voids the unpaid invoices
  await admin.form(`/admin/media/campaigns/${c.id}/cancel`, { reason: 'Test' });
  assert.equal(db.value("SELECT COUNT(*) FROM invoices WHERE source = 'media' AND source_id = ? AND status = 'void'", c.id), 2);
  const tb2 = db.get('SELECT ROUND(SUM(debit), 2) d, ROUND(SUM(credit), 2) c FROM acc_lines');
  assert.ok(Math.abs((tb2.d || 0) - (tb2.c || 0)) < 0.005, 'still balanced after the void');
});

test('media: artwork is approved by marketing before the campaign goes live', async () => {
  const banner = item();
  const c = await propose(agent, { title: 'Artwork run', items: [banner], start: day(0), end: day(6), who: `c:${client('Art Co')}` });
  await agent.form(`/admin/media/campaigns/${c.id}/confirm`, { invoice: '' });
  assert.equal(campaignByTitle('Artwork run').status, 'confirmed', 'no artwork yet: confirmed, not live');
  // no file, no approval
  await admin.form(`/admin/media/campaigns/${c.id}/artwork/review`, { decision: 'approved' });
  assert.equal(campaignByTitle('Artwork run').artwork_status, 'none');
  db.run(`INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, created_at)
    VALUES ('DOC-T-1', 'media_campaign', ?, 'media_artwork', 'Art', 'art.png', 'image/png', 10, 'x', 'x.png', datetime('now'))`, c.id);
  await agent.form(`/admin/media/campaigns/${c.id}/artwork/received`, {});
  assert.equal(campaignByTitle('Artwork run').artwork_status, 'received');
  // an agent cannot approve
  const r = await agent.form(`/admin/media/campaigns/${c.id}/artwork/review`, { decision: 'approved' });
  assert.notEqual(campaignByTitle('Artwork run').artwork_status, 'approved', `agent refused (${r.status})`);
  await admin.form(`/admin/media/campaigns/${c.id}/artwork/review`, { decision: 'approved' });
  const x = campaignByTitle('Artwork run');
  assert.equal(x.artwork_status, 'approved');
  assert.equal(x.status, 'live', 'it starts today, so it goes live');
});

test('media: an extra discount above the rule needs approval (stubbed approvals module)', async () => {
  db.setSetting('media_free_discount', '10');
  const banner = item();
  const who = `c:${client('Discount Co')}`;
  // without the module: the campaign waits for a manager here
  const saved = h.approvals;
  delete h.approvals;
  try {
    const c = await propose(agent, { title: 'Local approval', items: [banner], start: day(50), end: day(56), extra: 20, who });
    let x = campaignByTitle('Local approval');
    assert.equal(x.needs_approval, 1);
    await agent.form(`/admin/media/campaigns/${c.id}/confirm`, { invoice: '' });
    assert.equal(campaignByTitle('Local approval').status, 'proposal', 'not confirmed before approval');
    await agent.form(`/admin/media/campaigns/${c.id}/request-approval`, {});
    assert.equal(campaignByTitle('Local approval').approval_state, 'pending');
    await agent.form(`/admin/media/campaigns/${c.id}/approve-discount`, {});
    assert.equal(campaignByTitle('Local approval').approval_state, 'pending', 'an agent cannot approve');
    await admin.form(`/admin/media/campaigns/${c.id}/approve-discount`, {});
    x = campaignByTitle('Local approval');
    assert.equal(x.approval_state, 'approved');
    assert.equal(x.needs_approval, 0);
    // a deeper discount needs a new approval
    await agent.form(`/admin/media/campaigns/${c.id}/discount`, { extra: '25' });
    assert.equal(campaignByTitle('Local approval').needs_approval, 1);
    await agent.form(`/admin/media/campaigns/${c.id}/discount`, { extra: '15' });
    assert.equal(campaignByTitle('Local approval').needs_approval, 0, 'back within what was approved');
    await agent.form(`/admin/media/campaigns/${c.id}/confirm`, { invoice: '' });
    assert.equal(campaignByTitle('Local approval').status, 'confirmed');
  } finally {
    if (saved) h.approvals = saved;
  }

  // with an approvals module (a stub with the shared contract)
  const requests = [];
  const handlers = {};
  h.approvals = {
    needs: (kind, amount) => kind === 'media_discount' && amount > 0,
    request: (r) => { requests.push(r); return { id: requests.length }; },
    onDecision: (kind, fn) => { handlers[kind] = fn; },
  };
  try {
    // within the free discount, the module still decides by amount
    const c = await propose(agent, { title: 'Queued approval', items: [banner], start: day(60), end: day(66), extra: 5, who });
    assert.equal(campaignByTitle('Queued approval').needs_approval, 1, 'the module asks for it');
    await agent.form(`/admin/media/campaigns/${c.id}/request-approval`, {});
    assert.equal(requests.length, 1);
    const q = requests[0];
    assert.equal(q.kind, 'media_discount');
    assert.equal(q.entity, 'media_campaign');
    assert.equal(q.entity_id, c.id);
    assert.equal(q.payload.pct, 5);
    assert.ok(q.amount > 0 && q.link === `/admin/media/campaigns/${c.id}`);
    assert.equal(campaignByTitle('Queued approval').approval_ref, '1');
    // the manager's button is not offered here: the queue decides
    await admin.form(`/admin/media/campaigns/${c.id}/approve-discount`, {});
    assert.equal(campaignByTitle('Queued approval').approval_state, 'pending');
    assert.equal(typeof handlers.media_discount, 'function', 'a decision handler is registered');
    // rejected, then approved on a second request
    handlers.media_discount(q, 'rejected', admin.user || null);
    assert.equal(campaignByTitle('Queued approval').approval_state, 'rejected');
    await agent.form(`/admin/media/campaigns/${c.id}/request-approval`, {});
    handlers.media_discount(requests[1], { status: 'approved', note: 'Fine for a new client' }, { id: db.value("SELECT id FROM users WHERE email = 'md-admin@thewave.test'") });
    const x = campaignByTitle('Queued approval');
    assert.equal(x.approval_state, 'approved');
    assert.equal(x.approval_note, 'Fine for a new client');
    await agent.form(`/admin/media/campaigns/${c.id}/confirm`, { invoice: '' });
    assert.equal(campaignByTitle('Queued approval').status, 'confirmed');
  } finally {
    delete h.approvals;
    if (saved) h.approvals = saved;
  }
});

test('media: the pages open, in English and Arabic, and the proposal prints in both languages', async () => {
  const c = db.get("SELECT * FROM media_campaigns WHERE title = 'Queued approval'");
  const pages = ['/admin/media', '/admin/media/calendar', '/admin/media/calendar?view=weeks', '/admin/media/inventory', `/admin/media/inventory/${c ? db.value('SELECT item_id FROM media_lines WHERE campaign_id = ?', c.id) : 1}`,
    '/admin/media/rates', '/admin/media/clients', '/admin/media/campaigns', '/admin/media/campaigns?status=attention', '/admin/media/quote', '/admin/media/reports', `/admin/media/campaigns/${c.id}`];
  for (const p of pages) {
    const r = await admin.go(p);
    assert.equal(r.status, 200, p);
  }
  const en = await (await admin.go(`/admin/media/campaigns/${c.id}/print?doc=en`)).text();
  assert.match(en, /Advertising proposal/);
  assert.match(en, /Total before VAT/);
  const ar = await (await admin.go(`/admin/media/campaigns/${c.id}/print?doc=ar`)).text();
  assert.match(ar, /<html lang="ar" dir="rtl"/);
  assert.match(ar, /عرض إعلاني/);
  const csv = await admin.go('/admin/media/reports.csv');
  assert.match(csv.headers.get('content-type'), /csv/);
  assert.match(await csv.text(), /Queued approval/);
  // the sidebar count: campaigns starting within a week whose artwork is not approved
  const soon = await propose(agent, { title: 'Starts soon', items: [item()], start: day(3), end: day(9), who: `c:${client('Soon Co')}` });
  await agent.form(`/admin/media/campaigns/${soon.id}/hold`, {});
  const before = db.value("SELECT COUNT(*) FROM media_campaigns WHERE status IN ('held','confirmed','live') AND artwork_status != 'approved' AND start_date <= ? AND end_date >= ?", day(7), day(0));
  assert.ok(before >= 1);
  assert.match(await (await admin.go('/admin/media')).text(), /href="\/admin\/media" class="nav__a[^"]*"[^>]*>(?:(?!<\/a>)[\s\S])*<b class="nav__count">\d+<\/b>/);
});
