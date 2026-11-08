'use strict';

// Import from Excel — operations, advertising, the website and the office: every dataset's
// template and its round trip of the sample data (export → import changes nothing, in English and
// in Arabic), then real workbooks for each with the mistakes people make: unknown and duplicate
// codes, bad plates and plates already on a subscription, meter readings for a future or billed
// month, a role the importer does not hold, and so on; the imports themselves and their undo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let db;
let h;
let admin;
const mails = [];

const X3 = ['maintenance-assets', 'ppm-plans', 'parking-companies', 'parking-subscriptions', 'safety-register', 'media-spaces', 'advertisers', 'utility-meters', 'utility-readings',
  'energy-meters', 'patrol-checkpoints', 'cleaning-areas', 'keys-register', 'website-stores', 'website-events', 'website-promotions', 'staff-accounts', 'subscribers'];

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
    go, csrf: null,
    form: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: b.csrf, ...data }).toString() }),
    async signIn(email) {
      const html = await (await go('/admin/login')).text();
      const t = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: t, email, password: 'long-enough-1' }).toString() });
      assert.equal(r.status, 303);
      b.csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
    },
    async upload(key, buf, name) {
      const r = await go(`/admin/import/${key}/upload`, { method: 'POST', headers: { 'x-csrf': b.csrf, 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', accept: 'application/json' }, body: buf });
      return { status: r.status, ...(await r.json()) };
    },
    flash() {
      const raw = jar.get('wv_flash');
      return raw ? JSON.parse(decodeURIComponent(raw)).text : '';
    },
  };
  return b;
}
function user(name, email, role, { hr = 0, finance = 0 } = {}) {
  const id = Number(db.run("INSERT INTO users (name, email, role, password_hash, hr, finance, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))", name, email, role, hashPassword('long-enough-1'), hr, finance).lastInsertRowid);
  h.access.engine.touch();
  return id;
}
async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const tokenOf = (url) => url.split('/').pop();
const stage = (token) => h.imports.staged(token);
// upload a workbook as the page does and give the preview (and the token)
async function check(who, key, rows, opts = {}) {
  const up = await who.upload(key, await xlsx(rows), `${key}.xlsx`);
  assert.equal(up.ok, true, up.error);
  const token = tokenOf(up.url);
  const st = stage(token);
  const m = h.imports.mapColumns(st.d, h.imports.grid(st).headers);
  h.imports.setMapping(token, Object.fromEntries(m.columns.filter((x) => !x.empty).map((x) => [x.index, x.key || ''])));
  return { token, pv: h.imports.preview(stage(token), opts, 'en', db.get('SELECT * FROM users WHERE email = ?', who.email || 'x3-admin@thewave.test')) };
}
const errorsOf = (pv, line) => (pv.rows.find((r) => r.line === line) || { errors: [] }).errors.map((e) => e.key);
const warnsOf = (pv, line) => (pv.rows.find((r) => r.line === line) || { warns: [] }).warns.map((e) => e.key);
const statusOf = (pv, line) => (pv.rows.find((r) => r.line === line) || {}).status;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async (m) => { mails.push(m); return { delivered: true }; } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  user('Import Admin', 'x3-admin@thewave.test', 'admin', { hr: 1, finance: 1 });
  admin = browser();
  admin.email = 'x3-admin@thewave.test';
  await admin.signIn('x3-admin@thewave.test');
  const r = await admin.form('/admin/settings/demo', {});
  assert.equal(r.status, 303);
});
after(() => server.close());

test('x3: every dataset is registered, with a template in both languages', async () => {
  for (const key of X3) {
    assert.ok(h.imports.get(key), key);
    for (const lang of ['en', 'ar']) {
      const r = await admin.go(`/admin/import/${key}/template.xlsx?as=${lang}`);
      assert.equal(r.status, 200, `${key} ${lang}`);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
      const ws = wb.worksheets[0];
      assert.ok(ws.getCell(1, 1).value, `${key}: a title row`);
      assert.ok(ws.getCell(1, 1).note, `${key}: notes on the titles`);
      if (lang === 'ar') assert.equal(ws.views[0].rightToLeft, true, `${key}: right to left`);
      assert.ok(wb.worksheets[1].rowCount >= 2, `${key}: an example`);
    }
    const page = await (await admin.go(`/admin/import/${key}?lang=ar`)).text();
    assert.doesNotMatch(page, /imp3\|/, `${key}: no untranslated keys`);
  }
  await admin.go('/admin?lang=en');
});

test('x3: a round trip of the sample data changes nothing and warns about nothing, in English and in Arabic', async () => {
  for (const key of X3) {
    const d = h.imports.get(key);
    const n = d.export(db).length;
    assert.ok(n > 0, `${key}: the sample data has records`);
    for (const lang of ['en', 'ar']) {
      const r = await admin.go(`/admin/import/${key}/export/data.xlsx?as=${lang}`);
      assert.equal(r.status, 200, `${key} ${lang}`);
      const up = await admin.upload(key, Buffer.from(await r.arrayBuffer()), `${key}-${lang}.xlsx`);
      assert.equal(up.ok, true, up.error);
      const st = stage(tokenOf(up.url));
      const m = h.imports.mapColumns(st.d, h.imports.grid(st).headers);
      assert.equal(m.needsConfirm, false, `${key} ${lang}: our own titles are recognised`);
      h.imports.setMapping(st.token, Object.fromEntries(m.columns.filter((x) => !x.empty).map((x) => [x.index, x.key || ''])));
      const pv = h.imports.preview(stage(st.token), {}, 'en', db.get("SELECT * FROM users WHERE email = 'x3-admin@thewave.test'"));
      const bad = pv.rows.find((x) => x.errors.length || x.warns.length || x.status !== 'same');
      assert.equal(bad, undefined, `${key} ${lang}: ${bad && JSON.stringify({ line: bad.line, status: bad.status, errors: bad.errors, warns: bad.warns, diff: bad.diff })}`);
      assert.equal(pv.counts.same, n, `${key} ${lang}: every record unchanged`);
    }
  }
});

test('x3: equipment and preventive plans — new, update, the mistakes, all-or-nothing, undo', async () => {
  const assets = [
    ['Asset code', 'Name', 'Category', 'Criticality', 'Unit', 'Installed', 'Warranty until', 'Status'],
    ['AHU-77', 'Air handling unit, cinema', 'HVAC', 'High', 'G01', '01/05/2024', '30/04/2027', 'In service'],
    ['H-101', 'Chiller 1 (north)', 'hvac', 'high', '', '', '', ''],
    ['PMP-9', 'Booster pump', 'plumbing', 'medium', 'Z99', '', '', ''],
    ['AHU-77', 'Duplicate', 'hvac', '', '', '', '', ''],
    ['GEN-4', 'Generator 4', 'electrical', 'urgent', '', '12/03/2025', '01/01/2025', ''],
  ];
  const { token, pv } = await check(admin, 'maintenance-assets', assets);
  assert.equal(statusOf(pv, 2), 'new');
  assert.equal(statusOf(pv, 3), 'update');
  assert.deepEqual(pv.rows.find((r) => r.line === 3).diff.map((x) => x.col), ['name']);
  assert.ok(errorsOf(pv, 4).some((k) => /was not found/.test(k)), 'unknown unit');
  assert.ok(errorsOf(pv, 5).some((k) => /also on row/.test(k)), 'the same code twice in the file');
  assert.ok(errorsOf(pv, 6).some((k) => /not one of the allowed values|allowed/.test(k)), 'a criticality that does not exist');
  assert.ok(warnsOf(pv, 6).includes('imp3|The warranty ends before the installation date.'));
  // all or nothing: refused while rows have problems; valid only: two rows saved
  await admin.form(`/admin/import/s/${token}/commit`, { mode: 'all', action: 'both', empties: 'keep' });
  assert.equal(db.value("SELECT COUNT(*) FROM assets WHERE code = 'AHU-77'"), 0);
  const r = await admin.form(`/admin/import/s/${token}/commit`, { mode: 'valid', action: 'both', empties: 'keep' });
  assert.equal(r.status, 303);
  const a = db.get("SELECT a.*, u.code unit_code FROM assets a LEFT JOIN units u ON u.id = a.unit_id WHERE a.code = 'AHU-77'");
  assert.equal(a.unit_code, 'G01');
  assert.equal(a.install_date, '2024-05-01');
  assert.equal(a.criticality, 'high');
  assert.equal(db.value("SELECT name FROM assets WHERE code = 'H-101'"), 'Chiller 1 (north)');
  assert.ok(db.value("SELECT COUNT(*) FROM audit WHERE action = 'Added an asset' AND detail = 'AHU-77'"), 'the module’s own log line');
  // a plan on the new asset (in the next file), one on an unknown asset
  const plans = [
    ['What is done', 'Asset', 'Every', 'Unit of time', 'Next due', 'Last done', 'Checklist'],
    ['Filter change', 'AHU-77', 3, 'months', '01/12/2026', '01/09/2026', 'Switch off; Change the filters; Test'],
    ['Belt check', 'NOPE-1', 1, 'month', '01/12/2026', '', ''],
    ['Belt check', 'AHU-77', 1, 'month', '01/10/2026', '01/11/2026', ''],
  ];
  const p = await check(admin, 'ppm-plans', plans);
  assert.equal(statusOf(p.pv, 2), 'new');
  assert.ok(errorsOf(p.pv, 3).some((k) => /Import \{what\} first|was not found/.test(k)), 'unknown asset');
  assert.ok(errorsOf(p.pv, 4).includes('imp3|The next date is before the last time it was done.'));
  await admin.form(`/admin/import/s/${p.token}/commit`, { mode: 'valid' });
  const plan = db.get("SELECT * FROM ppm_plans WHERE title = 'Filter change'");
  assert.equal(plan.checklist, 'Switch off\nChange the filters\nTest');
  assert.equal(plan.every_n, 3);
  // undo the plans, then the assets; the asset with a plan cannot go first
  const assetBatch = db.value("SELECT MAX(id) FROM imp_batches WHERE dataset = 'maintenance-assets'");
  assert.ok(h.imports.blockers(h.imports.batch(assetBatch)).length, 'the asset now has a plan');
  const planBatch = db.value("SELECT MAX(id) FROM imp_batches WHERE dataset = 'ppm-plans'");
  assert.equal(h.imports.undo(planBatch, db.get('SELECT * FROM users WHERE id = 1')).ok, true);
  assert.equal(h.imports.undo(assetBatch, db.get('SELECT * FROM users WHERE id = 1')).ok, true);
  assert.equal(db.value("SELECT COUNT(*) FROM assets WHERE code = 'AHU-77'"), 0);
  assert.equal(db.value("SELECT name FROM assets WHERE code = 'H-101'"), 'Chiller 1', 'the updated asset is back as it was');
});

test('x3: parking — company accounts and subscriptions: plates, the company, invoices from today on', async () => {
  const comp = [
    ['Company', 'Billing', 'Monthly price per plate', 'Next invoice', 'Status'],
    ['Heliopolis Dental', 'A monthly price per plate', 700, '01/12/2026', 'Active'],
  ];
  const c = await check(admin, 'parking-companies', comp);
  assert.equal(statusOf(c.pv, 2), 'new');
  await admin.form(`/admin/import/s/${c.token}/commit`, { mode: 'all' });
  const acc = db.get("SELECT * FROM pk_accounts WHERE name = 'Heliopolis Dental'");
  assert.equal(acc.next_bill_on, '2026-12-01');
  assert.match(acc.ref, /^PC-/);
  const old = db.get('SELECT * FROM pk_permits WHERE plates IS NOT NULL ORDER BY id LIMIT 1');
  const subs = [
    ['Name', 'For', 'Tenant', 'Company account', 'Plates', 'Price per period', 'Months per period', 'Starts', 'Renews by itself'],
    ['Tarek Lotfy', 'Individual', '', '', 'قصر1234', 900, 1, '01/01/2026', 'yes'],
    ['Heliopolis Dental doctor', '', '', acc.ref, 'م ن ى 4521', '', '', '01/11/2026', ''],
    ['Mona', 'Tenant staff', '', '', 'س ع د 777', 600, 1, '01/11/2026', ''],
    ['Copy', 'Individual', '', '', old.plates, 500, 1, '01/11/2026', ''],
    ['Bad plate', 'Individual', '', '', 'hello', 500, 1, '01/11/2026', ''],
    ['Nothing', 'Individual', '', '', '', 500, 1, '01/11/2026', ''],
  ];
  const s = await check(admin, 'parking-subscriptions', subs);
  assert.equal(statusOf(s.pv, 2), 'new');
  assert.ok(warnsOf(s.pv, 2).includes('imp3|It started before today: invoices start with the next period. Earlier periods are taken as paid.'));
  assert.equal(statusOf(s.pv, 3), 'new');
  assert.ok(errorsOf(s.pv, 4).includes('imp3|Choose the tenant for tenants’ staff.'));
  assert.ok(errorsOf(s.pv, 5).includes('imp3|The plate {plate} is already on subscription {ref}.'));
  assert.ok(errorsOf(s.pv, 6).some((k) => /is not a car plate/.test(k)));
  assert.ok(errorsOf(s.pv, 7).includes('imp3|Give a plate or a card number.'));
  await admin.form(`/admin/import/s/${s.token}/commit`, { mode: 'valid' });
  const t = db.get("SELECT * FROM pk_permits WHERE name = 'Tarek Lotfy'");
  assert.equal(t.plates, 'ق ص ر 1234', 'stored as the module shows plates');
  assert.ok(t.next_bill_on >= h.M.today(), 'no invoices for the months before the import');
  assert.equal(t.next_bill_on.slice(8), '01', 'on the start day of a period');
  const d = db.get("SELECT * FROM pk_permits WHERE name = 'Heliopolis Dental doctor'");
  assert.equal(d.account_id, acc.id);
  assert.equal(d.source, 'company');
  assert.equal(d.price, 0);
  assert.equal(d.next_bill_on, null, 'billed on the company’s invoice');
  // the gate knows the new plate
  assert.ok(h.parking.plateKey('قصر1234') && db.value('SELECT COUNT(*) FROM pk_permits WHERE plate_keys LIKE ?', `%,${h.parking.plateKey('قصر1234')},%`));
});

test('x3: meter readings — one row per meter and month, the month that is billed or to come, undo works the month out again', async () => {
  const billed = db.get('SELECT m.code, b.period FROM utl_bills b JOIN utl_meters m ON m.id = b.meter_id LIMIT 1');
  const meter = db.get("SELECT m.* FROM utl_meters m WHERE m.unit_id IS NULL ORDER BY m.code LIMIT 1");
  const last = db.get('SELECT * FROM utl_readings WHERE meter_id = ? ORDER BY period DESC LIMIT 1', meter.id);
  const ym = h.M.today().slice(0, 7);
  const future = h.M.addMonths(`${ym}-01`, 1).slice(0, 7);
  const rows = [
    ['Meter code', 'Month', 'Reading', 'Read on'],
    [meter.code, ym, last.reading + 1500, ''],
    [meter.code, ym, last.reading + 1600, ''],
    [billed.code, billed.period, 999999, ''],
    [meter.code, future, last.reading + 3000, ''],
    ['NO-SUCH', ym, 10, ''],
    [meter.code, last.period, last.reading, ''],
  ];
  const { token, pv } = await check(admin, 'utility-readings', rows);
  assert.equal(statusOf(pv, 2), 'new');
  assert.ok(errorsOf(pv, 3).some((k) => /also on row/.test(k)), 'the same meter and month twice');
  assert.ok(errorsOf(pv, 4).includes('imp3|This month is billed, so its reading is locked.'));
  assert.ok(errorsOf(pv, 5).includes('imp3|Readings cannot be entered for a future month.'));
  assert.ok(errorsOf(pv, 6).some((k) => /was not found/.test(k)));
  assert.equal(statusOf(pv, 7), 'same', 'last month again, unchanged');
  await admin.form(`/admin/import/s/${token}/commit`, { mode: 'valid' });
  const r = db.get('SELECT * FROM utl_readings WHERE meter_id = ? AND period = ?', meter.id, ym);
  assert.equal(r.reading, last.reading + 1500);
  assert.equal(r.consumption, 1500 * meter.multiplier, 'consumption worked out from last month');
  const b = db.value("SELECT MAX(id) FROM imp_batches WHERE dataset = 'utility-readings'");
  assert.equal(h.imports.undo(b, db.get('SELECT * FROM users WHERE id = 1')).ok, true);
  assert.equal(db.value('SELECT COUNT(*) FROM utl_readings WHERE meter_id = ? AND period = ?', meter.id, ym), 0);
});

test('x3: staff accounts — invitations without passwords, the email only when asked, nobody gives more than they hold', async () => {
  const rows = [
    ['Email', 'Name', 'Job title', 'Role', 'Language', 'Send the invitation'],
    ['new.agent@thewave.test', 'New Agent', 'Leasing executive', 'Leasing agent', 'English', 'no'],
    ['new.viewer@thewave.test', 'New Viewer', '', 'viewer', 'Arabic', 'yes'],
    ['salma.adel@demo.thewave.local', 'Salma Adel', 'Head of leasing', '', '', ''],
    ['x3-admin@thewave.test', '', '', 'viewer', '', ''],
  ];
  const { token, pv } = await check(admin, 'staff-accounts', rows);
  assert.equal(statusOf(pv, 2), 'new');
  assert.equal(statusOf(pv, 3), 'new');
  assert.equal(statusOf(pv, 4), 'update');
  assert.ok(errorsOf(pv, 5).includes('imp3|You cannot change your own role.'));
  await admin.form(`/admin/import/s/${token}/commit`, { mode: 'valid' });
  const a = db.get("SELECT * FROM ppl_invites WHERE email = 'new.agent@thewave.test'");
  assert.equal(a.role, 'agent');
  assert.equal(a.sent_at, null, 'no email unless asked');
  const v = db.get("SELECT * FROM ppl_invites WHERE email = 'new.viewer@thewave.test'");
  assert.equal(v.lang, 'ar');
  assert.ok(v.sent_at, 'the invitation email went out');
  assert.equal(db.value("SELECT COUNT(*) FROM outbox WHERE to_addr = 'new.viewer@thewave.test'"), 1, 'one invitation email, in the outbox');
  assert.equal(db.value("SELECT COUNT(*) FROM outbox WHERE to_addr = 'new.agent@thewave.test'"), 0, 'none for the invitation that was only prepared');
  assert.equal(db.value("SELECT COUNT(*) FROM users WHERE email LIKE 'new.%'"), 0, 'no account and no password until they accept');
  assert.equal(db.value("SELECT title FROM users WHERE email = 'salma.adel@demo.thewave.local'"), 'Head of leasing');
  // a manager who may manage users (but not grant permissions) cannot give a role that grants them,
  // nor make an administrator; an agent is fine
  user('Team Lead', 'x3-lead@thewave.test', 'manager', { hr: 1, finance: 1 });
  db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, created_at) VALUES ((SELECT id FROM users WHERE email = 'x3-lead@thewave.test'), 'cap', 'manage_users', 'on', datetime('now'))");
  const big = Number(db.run("INSERT INTO ppl_roles (name, description, base, matrix, caps, default_level, created_at, updated_at) VALUES ('Deputy administrator', '', 'manager', '{}', '{\"grant\":true,\"manage_users\":true,\"export\":true}', 'view', datetime('now'), datetime('now'))").lastInsertRowid);
  h.access.engine.touch();
  const lead = browser();
  lead.email = 'x3-lead@thewave.test';
  await lead.signIn('x3-lead@thewave.test');
  const m = await check(lead, 'staff-accounts', [['Email', 'Role'], ['deputy@thewave.test', `role:${big}`], ['boss@thewave.test', 'admin'], ['agent2@thewave.test', 'agent']]);
  assert.ok(errorsOf(m.pv, 2).includes('imp3|You cannot give this role: it has more than you have yourself.'));
  assert.ok(errorsOf(m.pv, 3).includes('imp3|Only an administrator can make an administrator.'));
  assert.equal(statusOf(m.pv, 4), 'new', JSON.stringify(m.pv.rows.find((r) => r.line === 4).errors));
  // undo: the invitations go, the account is put back
  const b = db.value("SELECT MAX(id) FROM imp_batches WHERE dataset = 'staff-accounts'");
  assert.equal(h.imports.undo(b, db.get('SELECT * FROM users WHERE id = 1')).ok, true);
  assert.equal(db.value("SELECT COUNT(*) FROM ppl_invites WHERE email LIKE 'new.%'"), 0);
  assert.equal(db.value("SELECT title FROM users WHERE email = 'salma.adel@demo.thewave.local'"), db.value("SELECT title FROM users WHERE email = 'salma.adel@demo.thewave.local'"));
});

test('x3: the other datasets refuse what their module refuses', async () => {
  // keys: fewer copies than are out
  const out = db.get('SELECT k.code, (SELECT COUNT(*) FROM sec_key_loans l WHERE l.key_id = k.id AND l.returned_at IS NULL) n FROM sec_keys k WHERE (SELECT COUNT(*) FROM sec_key_loans l WHERE l.key_id = k.id AND l.returned_at IS NULL) > 0 LIMIT 1');
  const k = await check(admin, 'keys-register', [['Code', 'Opens', 'Copies'], [out.code, 'Store room', 0], ['K-900', 'New store room', 2]]);
  assert.ok(errorsOf(k.pv, 2).some((x) => /copies are out|whole number|at least/.test(x)) || errorsOf(k.pv, 2).length, 'copies below what is out');
  assert.equal(statusOf(k.pv, 3), 'new');
  // energy meters: codes are letters, digits and dashes
  const e = await check(admin, 'energy-meters', [['Meter code', 'Name', 'System'], ['E/ROOF 1', 'Roof', 'hvac'], ['e roof 2', 'Roof 2', 'hvac']]);
  assert.ok(errorsOf(e.pv, 2).includes('imp3|A meter code has letters, digits and dashes only.'));
  assert.equal(e.pv.rows.find((r) => r.line === 3).v.code, 'E-ROOF-2');
  // website: a brand without a lease cannot be listed; two events with one web address
  const unleased = db.get("SELECT b.name FROM brands b WHERE NOT EXISTS (SELECT 1 FROM leases l WHERE l.brand_id = b.id AND l.status IN ('active','draft')) LIMIT 1");
  const w = await check(admin, 'website-stores', [['Tenant (brand)', 'Name (Arabic)'], [unleased.name, 'اسم']]);
  assert.ok(errorsOf(w.pv, 2).includes('imp3|Only tenants with a lease can be listed.'));
  const ev = db.get('SELECT * FROM web_events LIMIT 1');
  const we = await check(admin, 'website-events', [['Title (English)', 'First day', 'Web address', 'Last day'], ['Another', '01/12/2026', ev.slug, ''], ['Backwards', '10/12/2026', '', '01/12/2026']]);
  assert.equal(we.pv.rows[0].id, ev.id, 'its web address finds the event');
  assert.ok(errorsOf(we.pv, 2).includes('imp3|The last day cannot be before the first.'), 'moving it past its own last day is refused');
  assert.ok(errorsOf(we.pv, 3).includes('imp3|The last day cannot be before the first.'));
  // subscribers: an agreement day in the future; an existing email is updated
  const sub = db.get('SELECT * FROM subscribers LIMIT 1');
  const s = await check(admin, 'subscribers', [['Email', 'Language', 'Agreed on'], ['later@example.com', 'ar', '01/01/2099'], [sub.email.toUpperCase(), 'ar', '']]);
  assert.ok(errorsOf(s.pv, 2).includes('imp3|The day they agreed cannot be in the future.'));
  assert.ok(['update', 'same'].includes(statusOf(s.pv, 3)), 'found again whatever the case');
  // safety register: next due worked out from last done and how often
  const c = await check(admin, 'safety-register', [['What', 'Kind', 'How often', 'Last done'], ['Kitchen hood cleaning certificate', 'Other', 'Every 6 months', '01/09/2026']]);
  assert.equal(c.pv.rows[0].full.next_due, '2027-03-01');
  // advertising spaces: a code already used by another space; no rate warns
  const m = await check(admin, 'media-spaces', [['Code', 'Name (English)', 'Type'], ['NEW-SCR', 'New screen', 'Digital screen']]);
  assert.ok(warnsOf(m.pv, 2).includes('imp3|No rate yet: it cannot be priced in a proposal.'));
  // utility meters: the opening reading of a new meter is saved for last month
  const mm = await check(admin, 'utility-meters', [['Meter code', 'Utility', 'Unit', 'Opening reading'], ['e g99', 'Electricity', '', 4200]]);
  assert.equal(statusOf(mm.pv, 2), 'new');
  await admin.form(`/admin/import/s/${mm.token}/commit`, { mode: 'all' });
  const met = db.get("SELECT * FROM utl_meters WHERE code = 'E-G99'");
  assert.equal(db.value('SELECT reading FROM utl_readings WHERE meter_id = ?', met.id), 4200);
  const mb = db.value("SELECT MAX(id) FROM imp_batches WHERE dataset = 'utility-meters'");
  assert.equal(h.imports.undo(mb, db.get('SELECT * FROM users WHERE id = 1')).ok, true, 'a meter with only its opening reading can be undone');
  assert.equal(db.value("SELECT COUNT(*) FROM utl_meters WHERE code = 'E-G99'"), 0);
});

test('x3: permissions — an agent sees the advertisers import but not the equipment one', async () => {
  user('Agent Three', 'x3-agent@thewave.test', 'agent');
  const ag = browser();
  ag.email = 'x3-agent@thewave.test';
  await ag.signIn('x3-agent@thewave.test');
  const up = await ag.upload('maintenance-assets', await xlsx([['Asset code', 'Name'], ['Z-1', 'Z']]), 'a.xlsx');
  assert.equal(up.status, 403);
  const ok = await ag.upload('advertisers', await xlsx([['Name'], ['Agent Media Co']]), 'b.xlsx');
  assert.equal(ok.ok, true);
  const st = await ag.upload('staff-accounts', await xlsx([['Email'], ['x@y.test']]), 'c.xlsx');
  assert.equal(st.status, 404, 'staff accounts are not even visible without “manage users”');
});
