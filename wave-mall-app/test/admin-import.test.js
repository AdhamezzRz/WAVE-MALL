'use strict';

// Import from Excel: the value parsers, the templates (opened with exceljs: titles, notes,
// dropdowns, lists, right-to-left), uploads of real .xlsx and .csv files through the wizard
// (matching columns, the preview, the problems workbook, all-or-nothing and valid-only, updates
// with what changes, duplicates, references within the file and across datasets), the batch and
// undo (and undo refused when a record is used), re-uploading the same file, permissions, and the
// pages in both languages.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const P = require('../src/admin/import/parse');

let server;
let base;
let db;
let h;
let admin;

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
    // uploads a file the way the page does; returns the JSON answer
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
// a workbook from rows of values (the first row is the header)
async function xlsx(rows, { sheet = 'Data', before = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const r of [...before, ...rows]) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const tokenOf = (url) => url.split('/').pop();
const stage = (token) => h.imports.staged(token);

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  user('Import Admin', 'imp-admin@thewave.test', 'admin', { hr: 1, finance: 1 });
  admin = browser();
  await admin.signIn('imp-admin@thewave.test');
});
after(() => server.close());

test('import: value parsers read what people type in Excel', () => {
  const v = (r) => r.value;
  // dates
  assert.equal(v(P.date('15/03/2025')), '2025-03-15');
  assert.equal(v(P.date('2025-03-15')), '2025-03-15');
  assert.equal(v(P.date('١٥/٠٣/٢٠٢٥')), '2025-03-15');
  assert.equal(v(P.date('15 Mar 2025')), '2025-03-15');
  assert.equal(v(P.date('15 مارس 2025')), '2025-03-15');
  assert.equal(v(P.date('March 15, 2025')), '2025-03-15');
  assert.equal(v(P.date(45731)), '2025-03-15', 'an Excel day number');
  assert.equal(v(P.date(new Date(Date.UTC(2025, 2, 15)))), '2025-03-15');
  assert.equal(v(P.date(59)), '1900-02-28');
  assert.ok(P.date(60).error, '29 Feb 1900 (Excel’s leap-year bug) is refused');
  assert.equal(v(P.date(61)), '1900-03-01');
  assert.ok(P.date('31/02/2025').error, 'not a real date');
  assert.ok(P.date('soon').error);
  const us = P.date('03/15/2025');
  assert.equal(us.value, '2025-03-15');
  assert.equal(us.warn, 'imp|Read as month/day/year.');
  assert.equal(P.date('15-3-25').warn, 'imp|Read the two-digit year as {year}.');
  assert.equal(v(P.month('03/2025')), '2025-03');
  assert.equal(v(P.month('مارس 2025')), '2025-03');
  assert.equal(v(P.time('9:30 PM')), '21:30');
  assert.equal(v(P.time(0.5)), '12:00');
  // numbers
  assert.equal(v(P.numberOf('1,250.50')), 1250.5);
  assert.equal(v(P.numberOf('1.250,50')), 1250.5);
  assert.equal(v(P.numberOf('EGP 12,000')), 12000);
  assert.equal(v(P.numberOf('12 000 ج.م')), 12000);
  assert.equal(v(P.numberOf('(1,200)')), -1200);
  assert.equal(v(P.numberOf('١٢٬٥٠٠٫٧٥')), 12500.75);
  assert.equal(v(P.number(0.15, { percent: true, numFmt: '0%' })), 15);
  assert.ok(P.number('12.5', { integer: true }).error);
  assert.ok(P.number('-3', { min: 0 }).error);
  assert.ok(P.numberOf('abc').error);
  // phones and emails
  assert.equal(v(P.phone('+20 101 234 5678')), '01012345678');
  assert.equal(v(P.phone('00201012345678')), '01012345678');
  assert.equal(v(P.phone(1012345678)), '01012345678', 'Excel dropped the 0');
  assert.equal(v(P.phone('0223456789')), '0223456789');
  assert.ok(P.phone('0101234567').warn);
  assert.ok(P.phone('call me').error);
  assert.equal(v(P.email(' Laila@Maison.COM ')), 'laila@maison.com');
  assert.ok(P.email('laila@').error);
  // yes / no and choices in either language
  assert.equal(v(P.bool('نعم')), true);
  assert.equal(v(P.bool('No')), false);
  assert.equal(v(P.bool('✓')), true);
  assert.ok(P.bool('maybe').error);
  const opts = [['fnb', { en: 'Food & beverage', ar: 'مطاعم ومشروبات' }], ['fashion', { en: 'Fashion & accessories', ar: 'أزياء وإكسسوارات' }]];
  assert.equal(v(P.choice('fnb', opts)), 'fnb');
  assert.equal(v(P.choice('FOOD & BEVERAGE', opts)), 'fnb');
  assert.equal(v(P.choice('مطاعم و مشروبات', opts)), 'fnb', 'spacing and letter forms do not matter');
  assert.equal(P.choice('Food & beverages', opts).warn, 'imp|Read “{typed}” as “{label}”.');
  assert.ok(P.choice('sports', opts).error);
  // cells: rich text, formulas, Arabic letter variants
  assert.equal(P.plain({ richText: [{ text: 'Maison ' }, { text: 'Lune' }] }), 'Maison Lune');
  assert.equal(P.plain({ formula: 'A1*2', result: 42 }), 42);
  assert.equal(P.norm('الإدارة *'), P.norm('الادارة'));
});

test('import: templates in English and Arabic, with notes, dropdowns, lists and an example', async () => {
  db.run("INSERT INTO departments (name, sort) VALUES ('Security', 1), ('Housekeeping', 2)");
  for (const lang of ['en', 'ar']) {
    const r = await admin.go(`/admin/import/employees/template.xlsx?as=${lang}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const names = wb.worksheets.map((w) => w.name);
    assert.deepEqual(names, lang === 'ar' ? ['البيانات', 'مثال', 'اقرأني', 'القوائم'] : ['Data', 'Example', 'Read me', 'Lists']);
    const ws = wb.worksheets[0];
    assert.equal(!!ws.views[0].rightToLeft, lang === 'ar', 'Arabic sheets read right to left');
    assert.equal(ws.views[0].state, 'frozen');
    const heads = ws.getRow(1).values.slice(1);
    assert.ok(heads.includes(lang === 'ar' ? 'الاسم بالكامل *' : 'Full name *'), 'required columns carry *');
    const deptCol = heads.indexOf(lang === 'ar' ? 'الإدارة' : 'Department') + 1;
    assert.ok(deptCol > 0);
    const dv = ws.getCell(5, deptCol).dataValidation;
    assert.equal(dv.type, 'list');
    assert.match(dv.formulae[0], lang === 'ar' ? /'القوائم'!\$[A-Z]+\$2:\$[A-Z]+\$3/ : /'Lists'!\$[A-Z]+\$2:\$[A-Z]+\$3/, 'the dropdown points at the real departments');
    const hireCol = heads.indexOf(lang === 'ar' ? 'تاريخ التعيين *' : 'Hire date *') + 1;
    assert.equal(ws.getCell(3, hireCol).dataValidation.type, 'date');
    assert.equal(ws.getColumn(hireCol).numFmt, 'dd/mm/yyyy');
    assert.ok(ws.getCell(1, hireCol).note, 'every title has a note');
    const lists = wb.worksheets[3];
    const listHeads = lists.getRow(1).values.slice(1);
    const at = listHeads.indexOf(lang === 'ar' ? 'الإدارة' : 'Department') + 1;
    assert.deepEqual([lists.getCell(2, at).value, lists.getCell(3, at).value], ['Security', 'Housekeeping']);
    assert.ok(wb.worksheets[1].rowCount >= 3, 'the example has rows');
  }
  // with the current data: needs the export right; the 23 units of the building are in it
  const r = await admin.go('/admin/import/units/export/data.xlsx?as=en');
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  assert.equal(wb.worksheets[0].actualRowCount - 1, db.value('SELECT COUNT(*) FROM units'));
});

test('import: a round trip of the current data changes nothing', async () => {
  const b = Number(db.run("INSERT INTO brands (name, category, tier, stores, website, legal_name, iban, opening_date, created_at) VALUES ('Round Trip Co', 'beauty', 'luxury', 2, 'https://rt.example', 'Round Trip S.A.E.', 'EG380019000500000000263180002', '2026-01-15', datetime('now'))").lastInsertRowid);
  db.run("INSERT INTO contacts (brand_id, name, email, phone, primary_contact, created_at) VALUES (?, 'Nadia Samy', 'nadia@rt.example', '01001112222', 1, datetime('now'))", b);
  if (!db.value('SELECT COUNT(*) FROM departments')) db.run("INSERT INTO departments (name, sort) VALUES ('Security', 1)");
  for (const key of ['units', 'brands', 'departments']) {
    const r = await admin.go(`/admin/import/${key}/export/data.xlsx?as=ar`);
    const up = await admin.upload(key, Buffer.from(await r.arrayBuffer()), `${key}.xlsx`);
    assert.equal(up.ok, true, up.error);
    const st = stage(tokenOf(up.url));
    const m = h.imports.mapColumns(st.d, h.imports.grid(st).headers);
    assert.equal(m.needsConfirm, false, `${key}: our own Arabic titles are recognised`);
    h.imports.setMapping(st.token, Object.fromEntries(m.columns.filter((x) => !x.empty).map((x) => [x.index, x.key || ''])));
    const pv = h.imports.preview(stage(st.token), {}, 'en');
    assert.equal(pv.counts.error, 0, `${key}: ${JSON.stringify(pv.rows.find((x) => x.errors.length)?.errors)}`);
    assert.equal(pv.counts.new + pv.counts.update, 0, `${key}: nothing to change`);
    assert.equal(pv.counts.same, db.value(`SELECT COUNT(*) FROM ${key}`));
  }
});

test('import: brands from a workbook — preview, problems workbook, all-or-nothing, valid-only, undo', async () => {
  const head = ['Brand *', 'Category', 'Positioning', 'Stores in Egypt', 'Website', 'Main contact', 'Contact email', 'Contact phone', 'Opening date'];
  const rows = [
    head,
    ['Nile Bloom', 'Food & beverage', 'Premium', 3, 'nilebloom.com', 'Hana Ali', 'Hana@NileBloom.com', '+20 100 111 2233', '01/09/2026'],
    ['Cairo Threads', 'أزياء وإكسسوارات', 'Mid-market', '1,200', 'https://cairothreads.com', 'Omar Said', 'omar@ct.com', 1001112233, '31/02/2026'],
    ['Nile Bloom', 'fnb', '', '', '', '', '', '', ''],
    ['Sun Spa', 'Sports', '', '', '', '', '', '', ''],
  ];
  const up = await admin.upload('brands', await xlsx(rows), 'brands.xlsx');
  assert.equal(up.ok, true, up.error);
  const token = tokenOf(up.url);
  const page = await (await admin.go(up.url)).text();
  assert.match(page, /Every row, before anything is saved/);
  const pv = h.imports.preview(stage(token), {}, 'en');
  const byLine = Object.fromEntries(pv.rows.map((r) => [r.line, r]));
  assert.equal(byLine[2].status, 'new');
  assert.equal(byLine[2].full.website, 'https://nilebloom.com', 'https:// added');
  assert.ok(byLine[2].warns.some((w) => w.key === 'imp|Added https:// to the website.'));
  assert.equal(byLine[2].full.contact_email, 'hana@nilebloom.com');
  assert.equal(byLine[2].full.contact_phone, '01001112233');
  assert.equal(byLine[2].full.opening_date, '2026-09-01');
  assert.equal(byLine[2].full.category, 'fnb');
  assert.equal(byLine[3].status, 'error', 'a date that does not exist');
  assert.ok(byLine[3].errors.some((e) => e.col === 'opening_date'));
  assert.equal(byLine[3].v.stores, 1200);
  assert.equal(byLine[3].v.contact_phone, '01001112233');
  assert.ok(byLine[4].errors.some((e) => e.key === 'imp|The same {col} is also on row {line}.'), 'duplicates in the file');
  assert.ok(byLine[5].errors.some((e) => e.col === 'category'), 'not an allowed category');
  // the problems, marked in their own workbook
  const er = await admin.go(`/admin/import/s/${token}/errors.xlsx`);
  assert.equal(er.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await er.arrayBuffer()));
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell(1, 10).value, 'Problems');
  assert.match(String(ws.getCell(3, 10).value), /Opening date: 31\/02\/2026 is not a real date/);
  assert.equal(ws.getCell(3, 9).fill.fgColor.argb, 'FFFDE2E1', 'the bad cell is red');
  assert.ok(ws.getCell(3, 9).note);
  // all or nothing: refused, nothing written
  const before = db.value('SELECT COUNT(*) FROM brands');
  await admin.form(`/admin/import/s/${token}/commit`, { mode: 'all', action: 'both', empties: 'keep' });
  assert.match(admin.flash(), /Some rows have problems/);
  assert.equal(db.value('SELECT COUNT(*) FROM brands'), before);
  // only the good rows
  const r = await admin.form(`/admin/import/s/${token}/commit`, { mode: 'valid', action: 'both', empties: 'keep' });
  assert.equal(r.status, 303);
  const batchUrl = r.headers.get('location');
  assert.match(batchUrl, /\/admin\/import\/b\/\d+$/);
  const nb = db.get("SELECT * FROM brands WHERE name = 'Nile Bloom'");
  assert.equal(nb.category, 'fnb');
  assert.equal(nb.tier, 'premium');
  assert.equal(nb.opening_date, '2026-09-01');
  assert.equal(db.value("SELECT COUNT(*) FROM brands WHERE name IN ('Cairo Threads','Sun Spa')"), 0);
  const c = db.get('SELECT * FROM contacts WHERE brand_id = ?', nb.id);
  assert.equal(c.primary_contact, 1);
  assert.equal(c.email, 'hana@nilebloom.com');
  assert.ok(db.value("SELECT COUNT(*) FROM audit WHERE action = 'Imported from Excel' AND detail = 'Brands: 1 new, 0 updated, 0 unchanged'"));
  assert.ok(db.value("SELECT COUNT(*) FROM audit WHERE action = 'Added a brand' AND entity_id = ?", nb.id), 'each record keeps its own history line');
  const done = await (await admin.go(batchUrl)).text();
  assert.match(done, /Brands imported/);
  assert.match(done, /Undo this import/);
  // the same file again is recognised
  const again = await admin.upload('brands', await xlsx(rows), 'brands.xlsx');
  assert.match(await (await admin.go(again.url)).text(), /You already imported this exact file/);
  // undo: the brand and its contact go
  const id = batchUrl.split('/').pop();
  await admin.form(`/admin/import/b/${id}/undo`, {});
  assert.equal(admin.flash(), 'The import was undone.');
  assert.equal(db.value("SELECT COUNT(*) FROM brands WHERE name = 'Nile Bloom'"), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM contacts WHERE brand_id = ?', nb.id), 0);
  assert.equal(db.value('SELECT status FROM imp_batches WHERE id = ?', id), 'undone');
});

test('import: updates show what changes, empty cells keep or clear, and undo puts it back', async () => {
  const bid = Number(db.run("INSERT INTO brands (name, category, tier, stores, website, created_at) VALUES ('Kahwa Lab', 'fnb', 'mid', 4, 'https://kahwalab.com', datetime('now'))").lastInsertRowid);
  db.run("INSERT INTO contacts (brand_id, name, email, phone, primary_contact, created_at) VALUES (?, 'Ola Nabil', 'ola@kahwalab.com', '01000000001', 1, datetime('now'))", bid);
  const head = ['Brand', 'Stores in Egypt', 'Website', 'Main contact', 'Contact email', 'Contact phone'];
  const up = await admin.upload('brands', await xlsx([head, ['kahwa lab', 6, '', 'Ola Nabil', 'ola@kahwalab.com', '01000000002']]), 'update.xlsx');
  const token = tokenOf(up.url);
  const pv = h.imports.preview(stage(token), {}, 'en');
  const row = pv.rows[0];
  assert.equal(row.status, 'update');
  assert.equal(row.id, bid, 'found by name, whatever the case');
  assert.deepEqual(row.diff.map((d) => [d.col, d.was, d.now]), [['stores', 4, 6], ['contact_phone', '01000000001', '01000000002']], 'the empty website keeps its value');
  const clear = h.imports.preview(stage(token), { empties: 'clear' }, 'en');
  assert.ok(clear.rows[0].diff.some((d) => d.col === 'website' && d.now === null), 'or clears it when asked');
  const only = h.imports.preview(stage(token), { action: 'create' }, 'en');
  assert.equal(only.rows[0].status, 'skip');
  const r = await admin.form(`/admin/import/s/${token}/commit`, { mode: 'all', action: 'both', empties: 'keep' });
  const id = r.headers.get('location').split('/').pop();
  assert.equal(db.value('SELECT stores FROM brands WHERE id = ?', bid), 6);
  assert.equal(db.value('SELECT website FROM brands WHERE id = ?', bid), 'https://kahwalab.com');
  assert.equal(db.value('SELECT phone FROM contacts WHERE brand_id = ?', bid), '01000000002');
  // undo puts the brand and its contact back as they were
  await admin.form(`/admin/import/b/${id}/undo`, {});
  assert.equal(db.value('SELECT stores FROM brands WHERE id = ?', bid), 4);
  assert.equal(db.value('SELECT phone FROM contacts WHERE brand_id = ?', bid), '01000000001');
});

test('import: undo is refused once a record is used, or changed since', async () => {
  const up = await admin.upload('brands', await xlsx([['Brand', 'Category'], ['Atlas Optics', 'Health & pharmacy'], ['Bean & Leaf', 'Food & beverage']]), 'two.xlsx');
  const r = await admin.form(`/admin/import/s/${tokenOf(up.url)}/commit`, { mode: 'all' });
  const id = r.headers.get('location').split('/').pop();
  const atlas = db.value("SELECT id FROM brands WHERE name = 'Atlas Optics'");
  db.run("INSERT INTO leads (ref, brand_id, title, stage, probability, created_at, updated_at, stage_at) VALUES ('LD-9001', ?, 'Atlas Optics', 'new', 10, datetime('now'), datetime('now'), datetime('now'))", atlas);
  const page = await (await admin.go(`/admin/import/b/${id}`)).text();
  assert.match(page, /This import cannot be undone any more/);
  assert.match(page, /Atlas Optics is now used by 1 leads/);
  await admin.form(`/admin/import/b/${id}/undo`, {});
  assert.equal(admin.flash(), 'This import cannot be undone.');
  assert.equal(db.value("SELECT COUNT(*) FROM brands WHERE name IN ('Atlas Optics','Bean & Leaf')"), 2, 'nothing was removed');
  // an updated record changed again after the import
  const up2 = await admin.upload('brands', await xlsx([['Brand', 'Stores in Egypt'], ['Bean & Leaf', 9]]), 'upd.xlsx');
  const r2 = await admin.form(`/admin/import/s/${tokenOf(up2.url)}/commit`, { mode: 'all' });
  const id2 = r2.headers.get('location').split('/').pop();
  db.run("UPDATE brands SET stores = 10 WHERE name = 'Bean & Leaf'");
  const b2 = h.imports.batch(id2);
  assert.deepEqual(h.imports.blockers(b2).map((x) => x.key), ['imp|{label} was changed again after the import.']);
});

test('import: employees — departments by name, managers in the same file, HR rules, references', async () => {
  const head = ['Employee code', 'Full name', 'Name in Arabic', 'National ID', 'Department', 'Position', 'Manager', 'Hire date', 'Basic salary', 'IBAN', 'Status', 'Last day'];
  const rows = [
    head,
    ['EMP-0501', 'Tamer Gaber', 'تامر جابر', '28805121234567', 'الأمن', 'Security supervisor', '', '01/02/2024', '15,000', 'EG38 0019 0005 0000 0000 2631 8000 2', 'Active', ''],
    ['EMP-0502', 'Rana Fouad', '', '29912011234561', 'Security', 'Guard', 'EMP-0501', '15/03/2025', 9000, '', '', ''],
    ['', 'Yasser Lotfy', '', '', 'Marketing', 'Designer', '', '2025-05-01', 8000, '', '', ''],
    ['EMP-0503', 'Old Timer', '', '', 'Housekeeping', 'Cleaner', '', '2020-01-01', 5000, '', 'left', ''],
  ];
  db.run("INSERT INTO departments (name, sort) VALUES ('Security Ops', 9)");
  const up = await admin.upload('employees', await xlsx(rows, { before: [['The Wave staff list — October'], []] }), 'staff.xlsx');
  assert.equal(up.ok, true, up.error);
  const token = tokenOf(up.url);
  const st = stage(token);
  assert.equal(st.header_row, 2, 'the title rows above the column titles are skipped');
  const pv = h.imports.preview(st, {}, 'en');
  const L = Object.fromEntries(pv.rows.map((r) => [r.line, r]));
  assert.equal(L[4].status, 'new', JSON.stringify(L[4].errors));
  assert.equal(L[4].full.birth_date, '1988-05-12', 'the birth date read from the national ID');
  assert.equal(L[4].full.iban, 'EG380019000500000000263180002');
  assert.equal(L[4].full.basic_salary, 15000);
  assert.deepEqual(L[5].v.manager, { self: 'emp 0501' }, 'the manager is further up the same file');
  assert.equal(L[5].status, 'new');
  assert.ok(L[6].errors.some((e) => e.key === 'imp|“{typed}” was not found in {what}. Import {what} first, or check the spelling.'), 'an unknown department');
  assert.ok(L[7].errors.some((e) => e.col === 'ended_at'), 'someone who left needs the last day');
  const r = await admin.form(`/admin/import/s/${token}/commit`, { mode: 'valid' });
  assert.equal(r.status, 303);
  const tamer = db.get("SELECT * FROM employees WHERE code = 'EMP-0501'");
  const rana = db.get("SELECT * FROM employees WHERE code = 'EMP-0502'");
  assert.equal(tamer.department_id, db.value("SELECT id FROM departments WHERE name = 'Security'"), 'the Arabic department name found Security');
  assert.equal(rana.manager_id, tamer.id, 'linked once both exist');
  assert.equal(rana.employment_type, 'full_time');
  assert.equal(db.value("SELECT COUNT(*) FROM employees WHERE name = 'Yasser Lotfy'"), 0);
  // undo removes both, even though one manages the other
  const id = r.headers.get('location').split('/').pop();
  assert.deepEqual(h.imports.blockers(h.imports.batch(id)), []);
  await admin.form(`/admin/import/b/${id}/undo`, {});
  assert.equal(db.value("SELECT COUNT(*) FROM employees WHERE code IN ('EMP-0501','EMP-0502')"), 0);
});

test('import: their own column titles go through a matching step that is remembered', async () => {
  const head = ['Shop Name', 'Type of business', 'Mobile', 'Something else'];
  const up = await admin.upload('brands', await xlsx([head, ['Lotus Kids', 'Fashion & accessories', '01012345678', 'x']]), 'mine.xlsx');
  const token = tokenOf(up.url);
  const first = await admin.go(`/admin/import/s/${token}`);
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), `/admin/import/s/${token}/map`);
  const page = await (await admin.go(`/admin/import/s/${token}/map`)).text();
  assert.match(page, /Match your columns/);
  assert.match(page, /Lotus Kids/, 'sample values shown');
  await admin.form(`/admin/import/s/${token}/map`, { header_row: '0', col_0: 'name', col_1: 'category', col_2: 'contact_phone', col_3: '', remember: '1' });
  const pv = h.imports.preview(stage(token), {}, 'en');
  assert.equal(pv.rows[0].status, 'error', 'a phone without a contact name');
  assert.ok(pv.rows[0].errors.some((e) => e.col === 'contact_name'));
  assert.equal(pv.rows[0].v.category, 'fashion');
  // next time the same titles are matched by themselves
  const up2 = await admin.upload('brands', await xlsx([head, ['Lotus Kids 2', 'Fashion & accessories', '', 'y']]), 'mine2.xlsx');
  const r2 = await admin.go(up2.url);
  assert.equal(r2.status, 200, 'no matching step this time');
});

test('import: CSV (semicolons, BOM), old .xls refused, and permissions', async () => {
  const csv = Buffer.from('﻿Unit code;Level;Indoor area (m²);Status\nK-01;Kiosk;9,5;Available\nG01;Plaza level;120;Leased\n', 'utf8');
  const up = await admin.upload('units', csv, 'units.csv');
  assert.equal(up.ok, true, up.error);
  const pv = h.imports.preview(stage(tokenOf(up.url)), {}, 'en');
  assert.equal(pv.rows[0].status, 'new');
  assert.equal(pv.rows[0].v.indoor_m2, 9.5);
  assert.equal(pv.rows[0].v.zone, 'kiosk');
  assert.equal(pv.rows[1].status, 'error', 'an import does not lease a unit');
  const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  const bad = await admin.upload('units', xls, 'old.xls');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /old Excel file \(\.xls\)/);
  // an agent cannot import employees (HR) or units (managers); a viewer cannot import at all
  user('Agent', 'imp-agent@thewave.test', 'agent');
  const agent = browser();
  await agent.signIn('imp-agent@thewave.test');
  assert.equal((await agent.upload('employees', csv, 'x.csv')).status, 404);
  assert.equal((await agent.upload('units', csv, 'x.csv')).status, 403);
  const centre = await (await agent.go('/admin/import')).text();
  assert.doesNotMatch(centre, /\/admin\/import\/employees"/, 'HR data is not even listed');
  assert.match(centre, /\/admin\/import\/brands"/);
  // the agent's brand import cannot touch legal details (managers only)
  const up3 = await agent.upload('brands', await xlsx([['Brand', 'Legal name'], ['Lotus Kids', 'Lotus Kids LLC']]), 'legal.xlsx');
  const pv3 = h.imports.preview(h.imports.staged(tokenOf(up3.url)), {}, 'en', db.get("SELECT * FROM users WHERE email = 'imp-agent@thewave.test'"));
  assert.ok(pv3.rows[0].errors.some((e) => e.key === 'imp|Legal details need a manager.'));
  // someone else's upload is not theirs to see
  assert.equal((await agent.go(up.url)).status, 404);
  user('Viewer', 'imp-viewer@thewave.test', 'viewer');
  const viewer = browser();
  await viewer.signIn('imp-viewer@thewave.test');
  assert.notEqual((await viewer.upload('brands', csv, 'x.csv')).ok, true);
  // the list pages show the button to those who can import
  assert.match(await (await admin.go('/admin/brands')).text(), /href="\/admin\/import\/brands"/);
  assert.doesNotMatch(await (await viewer.go('/admin/brands')).text(), /href="\/admin\/import\/brands"/);
});

test('import: the pages in Arabic', async () => {
  const up = await admin.upload('departments', await xlsx([['الإدارة', 'الترتيب في القوائم'], ['التسويق', 3]]), 'إدارات.xlsx');
  const token = tokenOf(up.url);
  for (const p of ['/admin/import', '/admin/import/history', '/admin/import/brands', '/admin/import/employees', `/admin/import/s/${token}`]) {
    const r = await admin.go(`${p}${p.includes('?') ? '&' : '?'}lang=ar`);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /dir="rtl"/);
  }
  const html = await (await admin.go(`/admin/import/s/${token}`)).text();
  assert.match(html, /كل الصفوف، قبل حفظ أي شيء/);
  const r = await admin.form(`/admin/import/s/${token}/commit`, { mode: 'all' });
  const id = r.headers.get('location').split('/').pop();
  assert.match(await (await admin.go(`/admin/import/b/${id}`)).text(), /تم استيراد الإدارات/);
  assert.match(await (await admin.go('/admin/audit')).text(), /الإدارات: 1 جديد، 0 محدّث، 0 دون تغيير/, 'the activity log reads in Arabic');
  await admin.go('/admin?lang=en');
});
