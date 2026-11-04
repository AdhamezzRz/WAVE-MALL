'use strict';

// Insight: the owner's monthly report (English and Arabic, the monthly email with the report
// attached, send now), the wall screen (its secret link, replaced and turned off, and the JSON it
// polls), and energy and ESG (interval readings pushed with a key and a signature, idempotent;
// CSV import; emissions, intensity and targets).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const demo = require('../src/admin/demo');
const C = require('../src/admin/revenue/calc');
const { cairo } = require('../src/admin/ops-common');

const KEY = 'k-energy-test-0123456789';
const SECRET = 's-energy-hmac-0123456789';
let server;
let base;
let db;
let h;
let admin;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0', ENERGY_API_KEY: KEY, ENERGY_HMAC_SECRET: SECRET }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  db.run("INSERT INTO users (name, email, role, password_hash, finance, hr, created_at) VALUES ('Insight Admin', 'ins-admin@thewave.test', 'admin', ?, 1, 1, datetime('now'))", hashPassword('long-enough-1'));
  // the sample data first (it takes a few seconds and holds the server), then sign in
  demo.load(db, db.get("SELECT * FROM users WHERE email = 'ins-admin@thewave.test'"), { files: h.files, billing: h.billing, h });
  admin = browser();
  await admin.signIn('ins-admin@thewave.test', 'long-enough-1');
  admin.user = db.get("SELECT * FROM users WHERE email = 'ins-admin@thewave.test'");
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
const lastMonth = () => C.ymAdd(cairo().date.slice(0, 7), -1);
const ingest = (body, { key = KEY, sign = true } = {}) => {
  const raw = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'x-api-key': key };
  if (sign) headers['x-signature'] = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  return fetch(`${base}/ingest/energy`, { method: 'POST', headers, body: raw });
};

// ---------- the owner report ----------
test('owner report: the printable report in English and in Arabic, with every section', async () => {
  const ym = lastMonth();
  const en = await admin.go(`/admin/owner-report/print?m=${ym}&doc=en`);
  assert.equal(en.status, 200);
  const html = await en.text();
  assert.match(html, /Owner&#39;s monthly report/);
  for (const s of ['Summary', 'Income', 'Occupancy and leasing', 'Collections', 'Tenant sales', 'Footfall', 'Parking', 'Operations', 'Cheques', 'Energy', 'Highlights', 'Risks to watch']) assert.ok(html.includes(`>${s}<`), `section ${s}`);
  assert.match(html, /<svg[^>]*role="img"/, 'an inline chart');
  assert.match(html, /class="bars"/);
  assert.match(html, /\?m=\d{4}-\d{2}&doc=ar/, 'switches to Arabic');
  const ar = await (await admin.go(`/admin/owner-report/print?m=${ym}&doc=ar`)).text();
  assert.match(ar, /<html lang="ar" dir="rtl">/);
  assert.match(ar, /التقرير الشهري للمالك/);
  assert.match(ar, /الإشغال والتأجير/);
  assert.match(ar, /أبرز الإيجابيات/);
  // the numbers behind it, against the month before and the same month last year
  const R = h.ownerReport.collect(ym);
  assert.equal(R.prev.ym, C.ymAdd(ym, -1));
  assert.equal(R.ly.ym, C.ymAdd(ym, -12));
  assert.ok(R.now.billed > 0 && R.now.footfall > 0, 'the sample month has bills and visitors');
  assert.ok(R.notes.good.length + R.notes.risk.length > 0, 'highlights or risks are written');
  const page = await admin.go(`/admin/owner-report?m=${ym}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Monthly email/);
});

test('owner report: the monthly job emails it once, with the report attached; send now works', async () => {
  const ym = lastMonth();
  let r = await admin.form('/admin/owner-report/settings', { recipients: 'owner@example.com, cfo@example.com', lang: 'both', day: '1', enabled: '1' });
  assert.equal(r.status, 303);
  assert.equal(db.setting('own_lang'), 'both');
  r = await admin.form('/admin/owner-report/settings', { recipients: 'not-an-address', lang: 'en', day: '1', enabled: '1' });
  assert.equal(db.setting('own_recipients'), 'owner@example.com, cfo@example.com', 'a bad address is refused');
  db.setSetting('own_last', '');
  const before = db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'owner_report'");
  await h.jobs.run('owner-report');
  const sent = db.all("SELECT * FROM outbox WHERE related_entity = 'owner_report' ORDER BY id DESC LIMIT 2");
  assert.equal(db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'owner_report'"), before + 2, 'one email per language');
  assert.equal(db.setting('own_last'), ym);
  const en = sent.find((m) => m.lang === 'en');
  const ar = sent.find((m) => m.lang === 'ar');
  assert.ok(en && ar);
  assert.match(en.to_addr, /owner@example\.com, cfo@example\.com/);
  assert.match(en.subject, /owner report for/);
  assert.match(en.body_html, new RegExp(`/admin/owner-report/print\\?m=${ym}&amp;doc=en`), 'a link to the printable page');
  assert.match(ar.body_html, /dir="rtl"/);
  const att = JSON.parse(en.attachments);
  assert.equal(att.length, 1);
  assert.equal(att[0].filename, `owner-report-${ym}-en.html`);
  const file = Buffer.from(att[0].content, 'base64').toString('utf8');
  assert.match(file, /^<!doctype html>/);
  assert.match(file, /<style>/, 'self-contained');
  assert.doesNotMatch(file, /<script/);
  assert.match(file, /Occupancy and leasing/);
  // the same month is not sent twice
  await h.jobs.run('owner-report');
  assert.equal(db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'owner_report'"), before + 2);
  // send now
  db.setSetting('own_lang', 'en');
  r = await admin.form('/admin/owner-report/send', { m: ym });
  assert.equal(r.status, 303);
  assert.equal(db.value("SELECT COUNT(*) FROM outbox WHERE related_entity = 'owner_report'"), before + 3);
  // off means off
  db.setSetting('own_enabled', '0');
  db.setSetting('own_last', '');
  assert.equal(h.ownerReport.tick(), null);
  db.setSetting('own_enabled', '1');
});

// ---------- the wall screen ----------
test('wall screen: the secret link works, is not indexed, rotates and turns off', async () => {
  assert.equal((await fetch(`${base}/wall/nothing-here`)).status, 404, 'no link yet');
  let r = await admin.form('/admin/wallboard/token', {});
  assert.equal(r.status, 303);
  const t1 = db.setting('wall_token');
  assert.ok(t1 && t1.length >= 30);
  const page = await fetch(`${base}/wall/${t1}?lang=en`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  const html = await page.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<body class="adm wall"/);
  assert.match(html, /<script src="\/admin\/wallboard\.js\?v=[0-9a-f]+" defer><\/script>/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline script');
  assert.doesNotMatch(html, /<form/, 'read-only');
  for (const k of ['visitors', 'parking', 'takings', 'sales', 'orders', 'cheques']) assert.match(html, new RegExp(`data-tile="${k}"`));
  const data = await (await fetch(`${base}/wall/${t1}/data.json?lang=ar`)).json();
  assert.equal(data.ok, true);
  assert.ok(data.panels.length >= 4);
  assert.match(data.tiles.parking, /B1/);
  assert.match(data.tiles.visitors, /زوار اليوم/);
  assert.ok(data.ticker.length >= 1);
  // replace: the old link stops at once
  r = await admin.form('/admin/wallboard/token', {});
  const t2 = db.setting('wall_token');
  assert.notEqual(t2, t1);
  assert.equal((await fetch(`${base}/wall/${t1}`)).status, 404);
  assert.equal((await fetch(`${base}/wall/${t1}/data.json`)).status, 404);
  assert.equal((await fetch(`${base}/wall/${t2}`)).status, 200);
  // the office page and the signed-in screen
  const office = await (await admin.go('/admin/wallboard')).text();
  assert.ok(office.includes(`/wall/${t2}`));
  assert.equal((await admin.go('/admin/wallboard/screen')).status, 200);
  assert.equal((await admin.go('/admin/wallboard/data.json')).status, 200);
  // off
  await admin.form('/admin/wallboard/token/off', {});
  assert.equal((await fetch(`${base}/wall/${t2}`)).status, 404);
});

// ---------- energy ----------
test('energy: readings pushed with the key and signature are stored once', async () => {
  let r = await admin.form('/admin/energy/meters', { code: 'T-INS-1', name: 'Test chiller', utility: 'electricity', system: 'hvac' });
  assert.equal(r.status, 303);
  assert.ok(db.get("SELECT id FROM nrg_meters WHERE code = 'T-INS-1'"));
  const body = { readings: [
    { meter: 'T-INS-1', time: '2019-03-04T10:00', kwh: 100 },
    { meter: 't-ins-1', time: '2019-03-04T11:00', kwh: 150.5 },
    { meter: 'T-INS-1', time: '2019-03-04T12:00:00Z', value: 120 }, // 14:00 in Cairo
    { meter: 'NOPE', time: '2019-03-04T10:00', kwh: 1 },
    { meter: 'T-INS-1', time: 'yesterday', kwh: 1 },
    { meter: 'T-INS-1', time: '2019-03-04T13:00', kwh: -5 },
  ] };
  assert.equal((await ingest(body, { key: 'wrong' })).status, 401);
  assert.equal((await ingest(body, { sign: false })).status, 401, 'the signature is required when a secret is set');
  r = await ingest(body);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.inserted, 3);
  assert.deepEqual(j.rejected.map((x) => x.reason), ['unknown meter', 'bad time', 'bad value']);
  assert.ok(db.get("SELECT r.id FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.code = 'T-INS-1' AND r.ts = '2019-03-04T14:00'"), 'UTC converted to Cairo time');
  // again: nothing changes
  j = await (await ingest(body)).json();
  assert.equal(j.inserted, 0);
  assert.equal(j.unchanged, 3);
  assert.equal(db.value("SELECT COUNT(*) FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.code = 'T-INS-1'"), 3);
  // a corrected value replaces the old one
  j = await (await ingest({ readings: [{ meter: 'T-INS-1', time: '2019-03-04T10:00', kwh: 110 }] })).json();
  assert.equal(j.updated, 1);
  assert.equal(db.value("SELECT value FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.code = 'T-INS-1' AND r.ts = '2019-03-04T10:00'"), 110);
  // CSV, long and wide, twice
  const csv = 'meter,time,kwh\nT-INS-1,2019-03-05 10:00,90\nT-INS-1,2019-03-05 11:00,95\n';
  await admin.form('/admin/energy/import/text', { csv });
  await admin.form('/admin/energy/import/text', { csv });
  assert.equal(db.value("SELECT COUNT(*) FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.code = 'T-INS-1'"), 5);
  const last = db.get("SELECT * FROM nrg_imports WHERE via = 'csv' ORDER BY id DESC LIMIT 1");
  assert.equal(last.unchanged, 2);
  await admin.form('/admin/energy/import/text', { csv: 'date,hour,T-INS-1\n2019-03-06,10,80\n2019-03-06,11,85\n' });
  assert.equal(db.value("SELECT COUNT(*) FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.code = 'T-INS-1'"), 7);
});

test('energy: ESG emissions, intensity, recycling and targets', async () => {
  // March 2019: 110 + 150.5 + 120 + 90 + 95 + 80 + 85 kWh from the meter above
  const kwh = 110 + 150.5 + 120 + 90 + 95 + 80 + 85;
  for (const [kind, q] of [['diesel', 100], ['gas', 50], ['waste_general', 3], ['waste_recycled', 1], ['water', 400]]) {
    const r = await admin.form('/admin/energy/entries', { period: '2019-03', kind, quantity: String(q), note: 'Test' });
    assert.equal(r.status, 303);
  }
  await admin.form('/admin/energy/entries', { period: '2019-03', kind: 'diesel', quantity: '120' }); // the same month again replaces it
  await admin.form('/admin/energy/factors', { grid: '0.5', diesel: '2.68', gas: '2.02' });
  await admin.form('/admin/energy/targets', { year: '2019', t_electricity: '1000', t_water: '300', t_co2: '', t_recycling: '30' });
  const e = h.energy.esg(2019);
  assert.equal(e.months.length, 12);
  assert.ok(Math.abs(e.t.electricity - kwh) < 0.01);
  assert.equal(e.t.diesel, 120);
  assert.ok(Math.abs(e.t.s2 - (kwh * 0.5) / 1000) < 1e-9, 'scope 2 = kWh × grid factor');
  assert.ok(Math.abs(e.t.s1 - (120 * 2.68 + 50 * 2.02) / 1000) < 1e-9, 'scope 1 = diesel and gas');
  assert.ok(Math.abs(e.t.co2 - (e.t.s1 + e.t.s2)) < 1e-9);
  assert.equal(e.t.recycling, 0.25);
  assert.equal(e.t.water, 400);
  assert.ok(Math.abs(e.t.kwhM2 - kwh / e.area) < 1e-9, 'kWh per m² of GLA');
  const tg = Object.fromEntries(e.targets.map((x) => [x.metric, x]));
  assert.equal(tg.electricity.ok, true, '730.5 kWh against 1,000 for a past year');
  assert.equal(tg.water.ok, false);
  assert.equal(tg.recycling.ok, false, '25% against at least 30%');
  assert.ok(!tg.co2, 'an empty target is not set');
  // the pages
  for (const p of ['/admin/energy', '/admin/energy?m=2019-03', '/admin/energy/esg?year=2019', '/admin/energy/meters', '/admin/energy/esg/print?year=2019&doc=ar']) {
    const r = await admin.go(p);
    assert.equal(r.status, 200, p);
  }
  const month = h.energy.month('2019-03');
  assert.equal(month.peak.kw, 150.5);
  assert.equal(month.peak.at, '2019-03-04T11');
  const print = await (await admin.go('/admin/energy/esg/print?year=2019&doc=en')).text();
  assert.match(print, /Energy, water, waste and carbon in 2019/);
  assert.match(print, /Grid electricity at 0.5 kg per kWh/);
  // the sample data: a year of hourly landlord readings and this year's targets
  assert.ok(db.value("SELECT COUNT(*) FROM nrg_readings WHERE demo = 1") > 5 * 24 * 360);
  assert.ok(db.value('SELECT COUNT(*) FROM nrg_targets WHERE demo = 1') >= 3);
});
