'use strict';

// The Excel import engine. A module registers a dataset (see README.md in this folder); the engine
// then gives it, with no more code:
//   - a live .xlsx template in English or Arabic (dropdowns from the real data, notes on every
//     column, an example sheet, a read-me), optionally filled with the current records;
//   - reading .xlsx and .csv files: the right sheet and header row, tolerant column matching (or a
//     matching step the person confirms, remembered next time), and careful value parsing (parse.js);
//   - a preview where every row is New / Update (with what changes) / Unchanged / Error, nothing
//     written yet, and a copy of the person's own workbook with the problems marked;
//   - the import in one transaction, kept as a batch that can be undone while nothing uses it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const P = require('./parse');
const i18n = require('../i18n');
const titles = require('./registry-titles');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20000;
const UNDO_DAYS = 14;
const LIST_SHEETS = new Set(['lists', 'القوائم', 'read me', 'readme', 'اقرأني', 'example', 'مثال', 'examples']);
const SHEET = { en: { data: 'Data', example: 'Example', readme: 'Read me', lists: 'Lists' }, ar: { data: 'البيانات', example: 'مثال', readme: 'اقرأني', lists: 'القوائم' } };
// words people use for the same thing in their own sheets (matched on top of each column's labels)
const SYNONYMS = {
  phone: ['mobile', 'mob', 'tel', 'telephone', 'phone number', 'mobile number', 'cell', 'whatsapp', 'موبايل', 'محمول', 'تليفون', 'هاتف', 'رقم الهاتف', 'رقم الموبايل', 'جوال'],
  email: ['e-mail', 'mail', 'email address', 'البريد', 'البريد الالكتروني', 'ايميل', 'الايميل'],
  name: ['full name', 'name en', 'english name', 'الاسم', 'الاسم بالكامل'],
  name_ar: ['arabic name', 'name arabic', 'name ar', 'الاسم بالعربي', 'الاسم بالعربية'],
  code: ['id', 'no', 'number', 'ref', 'reference', 'كود', 'الكود', 'رقم'],
  notes: ['note', 'remarks', 'comments', 'comment', 'ملاحظات', 'ملاحظه'],
  birth_date: ['dob', 'date of birth', 'birthday', 'تاريخ الميلاد'],
  national_id: ['nid', 'national id number', 'id number', 'الرقم القومي', 'رقم البطاقه'],
  hire_date: ['joining date', 'join date', 'start date', 'date joined', 'تاريخ التعيين', 'تاريخ الالتحاق'],
  basic_salary: ['salary', 'basic', 'basic pay', 'المرتب', 'الراتب', 'المرتب الاساسي', 'الراتب الاساسي'],
  department: ['dept', 'department name', 'القسم', 'الاداره'],
  website: ['web', 'site', 'url', 'الموقع'],
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const T = (x, lang) => (x && typeof x === 'object' ? x[lang] || x.en : x);

function create({ db, h }) {
  db.ensure('import-1', `
    CREATE TABLE imp_stage (
      token TEXT PRIMARY KEY, dataset TEXT NOT NULL, user_id INTEGER, file_name TEXT, sha TEXT NOT NULL, ext TEXT NOT NULL,
      sheet TEXT, header_row INTEGER, mapping TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE imp_batches (
      id INTEGER PRIMARY KEY, dataset TEXT NOT NULL, file_name TEXT, sha TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      options TEXT, created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
      created_ids TEXT, changes TEXT, status TEXT NOT NULL DEFAULT 'done', undone_at TEXT, undone_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX imp_batches_dataset ON imp_batches(dataset, created_at);
  `);

  const sets = new Map();
  // uploads wait here between the upload and the import (two days at most): next to the database,
  // never among the documents
  const env = h.env || {};
  const dir = env.ADMIN_DB === ':memory:' ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wave-imports-')) : path.join(require('../paths').dataDir(env), 'imports');
  fs.mkdirSync(dir, { recursive: true });

  // ---------- the registry ----------
  function register(def) {
    if (!def || !def.key || !def.title || !Array.isArray(def.columns) || typeof def.apply !== 'function') throw new Error(`import: dataset ${def && def.key} needs key, title, columns and apply()`);
    if (sets.has(def.key)) throw new Error(`import: dataset ${def.key} is registered twice`);
    for (const c of def.columns) {
      if (!c.key || !c.label || !c.type) throw new Error(`import: ${def.key}: every column needs key, label and type`);
      if (c.type === 'enum' && !c.enum) throw new Error(`import: ${def.key}.${c.key}: an enum needs its options`);
      if (c.type === 'ref' && !(c.ref && typeof c.ref.list === 'function')) throw new Error(`import: ${def.key}.${c.key}: a ref needs ref.list(db)`);
    }
    const d = {
      area: 'other', order: 100, depends: [], keys: [], pages: [def.module], icon: 'file', examples: [],
      ...def,
    };
    d.col = Object.fromEntries(d.columns.map((c) => [c.key, c]));
    sets.set(d.key, d);
    titles.set(T(d.title, 'en'), T(d.title, 'ar'));
    return d;
  }
  const get = (key) => sets.get(key) || null;
  const list = () => [...sets.values()].sort((a, b) => (AREA_ORDER[a.area] ?? 99) - (AREA_ORDER[b.area] ?? 99) || a.order - b.order || a.key.localeCompare(b.key));
  const forPage = (p) => list().filter((d) => (d.pages || []).includes(p));

  // who may do what with a dataset
  // canView: who may see the dataset at all (its template lists real data); allowed: who may import it
  const canSee = (req, d) => !!req.user && h.access.can(req.user, d.module, 'view') && (!d.canView || d.canView(req, h));
  const canImport = (req, d) => canSee(req, d) && h.access.can(req.user, d.module, 'edit') && (!d.allowed || d.allowed(req, h));
  const canUndo = (req, d) => canImport(req, d) && h.access.can(req.user, d.module, 'full');
  const canExport = (req, d) => canSee(req, d) && h.access.has(req.user, 'export');

  // ---------- options of enum and ref columns ----------
  const enumOf = (c) => (typeof c.enum === 'function' ? c.enum(db) : c.enum).map((o) => (Array.isArray(o) ? o : [o, { en: String(o), ar: String(o) }]));
  // ref: list(db) → [{ id, name, alt: [] }]; index by every name
  function refIndex(c) {
    const items = c.ref.list(db);
    const map = new Map();
    for (const it of items) {
      for (const n of [it.name, ...(it.alt || [])].filter((x) => x !== null && x !== undefined && x !== '')) {
        const k = P.norm(n);
        if (!map.has(k)) map.set(k, []);
        if (!map.get(k).some((x) => x.id === it.id)) map.get(k).push(it);
      }
    }
    return { items, map };
  }

  // ---------- reading a value of a column ----------
  function parseCell(c, raw, numFmt) {
    switch (c.type) {
      case 'text': case 'code': {
        const r = P.text(raw, { max: c.max || 500, multiline: !!c.multiline });
        if (r.value && c.type === 'code') r.value = r.value.toUpperCase().replace(/\s+/g, '');
        if (r.value && c.pattern && !c.pattern.re.test(r.value)) return { error: c.pattern.error, params: { value: r.value } };
        return r;
      }
      case 'int': return P.number(raw, { integer: true, min: c.min ?? null, max: c.maxValue ?? null, numFmt });
      case 'number': return P.number(raw, { min: c.min ?? null, max: c.maxValue ?? null, numFmt });
      case 'money': return P.number(raw, { min: c.min ?? 0, max: c.maxValue ?? null, numFmt });
      case 'percent': return P.number(raw, { percent: true, min: c.min ?? 0, max: c.maxValue ?? 100, numFmt });
      case 'date': return P.date(raw);
      case 'month': return P.month(raw);
      case 'time': return P.time(raw);
      case 'bool': return P.bool(raw);
      case 'enum': return P.choice(raw, enumOf(c));
      case 'email': return P.email(raw);
      case 'phone': return P.phone(raw);
      case 'list': return P.list(raw, { max: c.maxItems || 50 });
      case 'ref': return P.text(raw, { max: 300 });
      default: return P.text(raw, { max: c.max || 500 });
    }
  }

  // ---------- reading files ----------
  // → { ext, sheets: [{ name, rows: [[cell]] }] }; a cell is a value or { d: iso } for a date, or
  // { v, f } when its number format matters (percentages)
  async function readFile(buf, name = '') {
    if (!buf || !buf.length) return { error: 'imp|The file is empty.' };
    if (buf.length > MAX_BYTES) return { error: 'imp|The file is larger than 10 MB. Split it into smaller files.' };
    const lower = String(name).toLowerCase();
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return { error: 'imp|This is an old Excel file (.xls). Open it in Excel and use File › Save As › Excel Workbook (.xlsx), then upload that.' };
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      if (/\.(xlsb|ods|numbers|docx|pptx)$/.test(lower)) return { error: 'imp|Upload an Excel workbook (.xlsx) or a CSV file.' };
      return readXlsx(buf);
    }
    if (/\.(pdf|png|jpe?g|docx?)$/.test(lower)) return { error: 'imp|Upload an Excel workbook (.xlsx) or a CSV file.' };
    return readCsv(buf);
  }
  async function readXlsx(buf) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf);
    } catch {
      return { error: 'imp|This file could not be opened as an Excel workbook. Save it again as .xlsx and retry.' };
    }
    const sheets = [];
    wb.eachSheet((ws) => {
      if (ws.state && ws.state !== 'visible' && LIST_SHEETS.has(P.norm(ws.name))) return;
      const rows = [];
      const last = Math.min(ws.rowCount, MAX_ROWS + 30);
      const width = Math.min(ws.columnCount, 200);
      for (let r = 1; r <= last; r++) {
        const row = ws.getRow(r);
        const out = [];
        for (let c = 1; c <= width; c++) {
          const cell = row.getCell(c);
          const v = cell.isMerged && cell.master && cell.master !== cell ? cell.master.value : cell.value;
          const p = P.plain(v);
          if (p instanceof Date) out.push({ d: p.toISOString() });
          else if (typeof p === 'number' && /%/.test(cell.numFmt || '')) out.push({ v: p, f: '%' });
          else out.push(p === undefined ? null : p);
        }
        while (out.length && (out[out.length - 1] === null || (typeof out[out.length - 1] !== 'object' && P.isBlank(out[out.length - 1])))) out.pop();
        rows.push(out);
      }
      sheets.push({ name: ws.name, rows, hidden: !!(ws.state && ws.state !== 'visible') });
    });
    if (!sheets.length) return { error: 'imp|The workbook has no sheets.' };
    return { ext: 'xlsx', sheets };
  }
  function readCsv(buf) {
    let text;
    if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
    else if (buf[0] === 0xfe && buf[1] === 0xff) return { error: 'imp|Save the file as CSV UTF-8 or as .xlsx.' };
    else {
      text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      // not UTF-8 (Excel's old "CSV" in Windows Arabic): too many replacement characters
      if ((text.match(/�/g) || []).length > 3) return { error: 'imp|This CSV is not saved as UTF-8, so Arabic would be lost. In Excel choose File › Save As › CSV UTF-8, or upload the .xlsx.' };
    }
    if (/[\u0000-\u0008]/.test(text.slice(0, 4000))) return { error: 'imp|Upload an Excel workbook (.xlsx) or a CSV file.' };
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
    const count = (ch) => (firstLine.replace(/"[^"]*"/g, '').split(ch).length - 1);
    const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
        if (rows.length > MAX_ROWS + 30) break;
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return { ext: 'csv', sheets: [{ name: 'CSV', rows: rows.map((r) => r.map((x) => (x === '' ? null : x))) }] };
  }
  const cellValue = (x) => (x && typeof x === 'object' ? ('d' in x ? new Date(x.d) : x.v) : x);
  const cellFmt = (x) => (x && typeof x === 'object' && x.f) || '';
  const cellText = (x) => {
    const v = cellValue(x);
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return P.isoDate(v);
    return String(v);
  };

  // ---------- matching their columns to ours ----------
  const namesOf = (c) => [c.key, T(c.label, 'en'), T(c.label, 'ar'), ...(c.aliases || []), ...(SYNONYMS[c.key] || [])];
  function guess(d, header, remembered = {}) {
    const n = P.norm(header);
    if (!n) return null;
    if (n in remembered) return remembered[n] ? { key: remembered[n], score: 1, why: 'remembered' } : { key: null, score: 1, why: 'ignored' };
    let best = null;
    for (const c of d.columns) {
      for (const name of namesOf(c)) {
        const s = P.norm(name) === n ? 1 : P.likeness(name, header);
        if (!best || s > best.score) best = { key: c.key, score: s };
      }
    }
    return best && best.score >= 0.6 ? best : null;
  }
  // the sheet and header row that fit the dataset best
  function locate(d, file, sheetName = null) {
    let pick = null;
    for (const s of file.sheets) {
      if (sheetName && s.name !== sheetName) continue;
      if (!sheetName && LIST_SHEETS.has(P.norm(s.name)) && file.sheets.length > 1) continue;
      for (let r = 0; r < Math.min(15, s.rows.length); r++) {
        const cells = s.rows[r].map(cellText);
        const exact = cells.filter((x) => { const g = guess(d, x); return g && g.score === 1; }).length;
        const filled = cells.filter((x) => x.trim()).length;
        const score = exact * 10 + (filled >= 2 ? filled : 0) * 0.1;
        if (!pick || score > pick.score) pick = { sheet: s.name, headerRow: r, score };
      }
    }
    if (!pick && file.sheets.length) pick = { sheet: file.sheets[0].name, headerRow: 0, score: 0 };
    return pick;
  }
  const remembered = (d) => {
    try { return JSON.parse(db.setting(`imp_map:${d.key}`) || '{}') || {}; } catch { return {}; }
  };
  // headers → [{ index, header, key, score }]; needsConfirm when a guess is unsure or a required
  // column is missing
  function mapColumns(d, headers, saved = null) {
    const mem = remembered(d);
    const used = new Set();
    const out = headers.map((hd, index) => {
      const header = cellText(hd).trim();
      if (!header) return { index, header, key: null, score: 0, empty: true };
      if (saved && index in saved) return { index, header, key: saved[index] || null, score: 1, why: 'chosen' };
      const g = guess(d, header, mem);
      return { index, header, key: g ? g.key : null, score: g ? g.score : 0, why: g && g.why };
    });
    // one header per column: the best match keeps it
    for (const m of [...out].sort((a, b) => b.score - a.score)) {
      if (!m.key) continue;
      if (used.has(m.key)) { m.key = null; m.score = 0; m.dup = true; } else used.add(m.key);
    }
    const missing = d.columns.filter((c) => c.required && !used.has(c.key)).map((c) => c.key);
    const unsure = out.filter((m) => !m.empty && ((m.key && m.score < 1) || (!m.key && m.why !== 'ignored'))).length;
    return { columns: out, missing, needsConfirm: !saved && (unsure > 0 || missing.length > 0) };
  }
  function rememberMapping(d, mapped) {
    const mem = remembered(d);
    for (const m of mapped) if (m.header) mem[P.norm(m.header)] = m.key || '';
    const keys = Object.keys(mem);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete mem[k];
    db.setSetting(`imp_map:${d.key}`, JSON.stringify(mem));
  }

  // ---------- staging an upload ----------
  function cleanup() {
    const old = new Date(Date.now() - 2 * 86400000).toISOString();
    for (const s of db.all('SELECT token, ext FROM imp_stage WHERE created_at < ?', old)) {
      for (const f of [`${s.token}.${s.ext}`, `${s.token}.json`]) fs.rmSync(path.join(dir, f), { force: true });
      db.run('DELETE FROM imp_stage WHERE token = ?', s.token);
    }
  }
  async function stage(d, buf, fileName, user) {
    cleanup();
    const file = await readFile(buf, fileName);
    if (file.error) return file;
    const at = locate(d, file);
    const sheet = file.sheets.find((s) => s.name === at.sheet);
    const data = sheet.rows.slice(at.headerRow + 1).filter((r) => r.some((x) => !P.isBlank(cellValue(x) instanceof Date ? 'x' : cellValue(x))));
    if (!data.length) return { error: 'imp|No rows to import were found under the column titles.' };
    if (data.length > MAX_ROWS) return { error: 'imp|More than {max} rows. Split the file into smaller ones.', params: { max: MAX_ROWS } };
    const token = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(path.join(dir, `${token}.${file.ext}`), buf);
    fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify(file));
    db.run('INSERT INTO imp_stage (token, dataset, user_id, file_name, sha, ext, sheet, header_row, mapping, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      token, d.key, user ? user.id : null, String(fileName || '').replace(/[\\/]/g, '_').slice(-160) || null, sha(buf), file.ext, at.sheet, at.headerRow, null, nowIso());
    return { token };
  }
  function staged(token, user) {
    const s = db.get('SELECT * FROM imp_stage WHERE token = ?', String(token || ''));
    if (!s || (user && s.user_id && s.user_id !== user.id)) return null;
    const f = path.join(dir, `${s.token}.json`);
    if (!fs.existsSync(f)) return null;
    const file = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...s, file, mapping: s.mapping ? JSON.parse(s.mapping) : null, d: get(s.dataset) };
  }
  function setSheet(token, sheet) {
    const s = db.get('SELECT * FROM imp_stage WHERE token = ?', token);
    if (!s) return;
    const file = JSON.parse(fs.readFileSync(path.join(dir, `${s.token}.json`), 'utf8'));
    if (!file.sheets.some((x) => x.name === sheet)) return;
    const at = locate(get(s.dataset), file, sheet);
    db.run('UPDATE imp_stage SET sheet = ?, header_row = ?, mapping = NULL WHERE token = ?', sheet, at.headerRow, token);
  }
  function setMapping(token, mapping, headerRow = null) {
    db.run('UPDATE imp_stage SET mapping = ?, header_row = COALESCE(?, header_row) WHERE token = ?', JSON.stringify(mapping), headerRow, token);
  }
  // the header and data rows of the stage's sheet
  function grid(st) {
    const sheet = st.file.sheets.find((s) => s.name === st.sheet) || st.file.sheets[0];
    const headers = sheet.rows[st.header_row] || [];
    const rows = [];
    sheet.rows.forEach((r, i) => {
      if (i <= st.header_row) return;
      if (!r.some((x) => { const v = cellValue(x); return v instanceof Date || !P.isBlank(v); })) return;
      rows.push({ line: i + 1, cells: r });
    });
    return { sheet, headers, rows };
  }

  // ---------- the preview ----------
  // options: { mode: 'all'|'valid', action: 'both'|'create'|'update', empties: 'keep'|'clear' }
  function preview(st, options = {}, lang = 'en', user = null) {
    const d = st.d;
    const opt = { mode: options.mode === 'valid' ? 'valid' : 'all', action: ['create', 'update'].includes(options.action) ? options.action : 'both', empties: options.empties === 'clear' ? 'clear' : 'keep' };
    const g = grid(st);
    const map = st.mapping ? mapColumns(d, g.headers, st.mapping) : mapColumns(d, g.headers);
    const byKey = {};
    for (const m of map.columns) if (m.key) byKey[m.key] = m.index;
    const cols = d.columns.filter((c) => c.key in byKey);
    const refs = {};
    for (const c of cols) if (c.type === 'ref') refs[c.key] = refIndex(c);
    // every column with a ref index, for merging the current values of updated records
    const allRefs = {};
    for (const c of d.columns) if (c.type === 'ref') allRefs[c.key] = refs[c.key] || refIndex(c);
    const current = new Map((d.export ? d.export(db) : []).map((r) => [r.$id, r]));
    const keyCols = d.keys.flat();
    const seen = new Map();
    const selfKeys = new Map(); // value of the self-referenced column → line, for refs within the file
    const rows = [];
    // pass 1: read the values and the keys
    for (const r of g.rows) {
      const row = { line: r.line, v: {}, names: {}, raw: {}, errors: [], warns: [], provided: new Set() };
      for (const c of cols) {
        const cell = r.cells[byKey[c.key]];
        const raw = cellValue(cell);
        row.raw[c.key] = cellText(cell);
        let res = parseCell(c, raw, cellFmt(cell));
        // a column's own clean-up (an IBAN without spaces, https:// on a website): { value, warn?, error? }
        if (!res.error && res.value !== null && res.value !== undefined && c.transform) res = { ...res, ...c.transform(res.value) };
        if (res.error) row.errors.push({ col: c.key, key: res.error, params: res.params });
        else {
          if (res.warn) row.warns.push({ col: c.key, key: res.warn, params: res.params });
          if (res.value !== null && res.value !== undefined) { row.v[c.key] = res.value; row.provided.add(c.key); }
        }
      }
      for (const c of d.columns) if (c.ref && c.ref.self && row.v[c.ref.self] !== undefined) selfKeys.set(P.norm(row.v[c.ref.self]), r.line);
      rows.push(row);
    }
    // pass 2: references, keys, duplicates, existing records, the checks of the dataset
    for (const row of rows) {
      for (const c of cols.filter((x) => x.type === 'ref')) {
        if (row.v[c.key] === undefined) continue;
        const typed = row.v[c.key];
        const hits = refs[c.key].map.get(P.norm(typed)) || [];
        if (hits.length === 1) { row.v[c.key] = hits[0].id; row.names[c.key] = hits[0].name; continue; }
        if (hits.length > 1) { row.errors.push({ col: c.key, key: 'imp|More than one record is called “{typed}”. Use its code instead.', params: { typed } }); delete row.v[c.key]; continue; }
        if (c.ref.self && selfKeys.has(P.norm(typed))) { row.v[c.key] = { self: P.norm(typed) }; row.names[c.key] = typed; continue; }
        const near = refs[c.key].items.map((it) => ({ it, s: P.likeness(it.name, typed) })).sort((a, b) => b.s - a.s)[0];
        const what = T(c.ref.what || c.label, lang);
        if (near && near.s >= 0.8) row.errors.push({ col: c.key, key: 'imp|“{typed}” was not found in {what}. Did you mean “{near}”?', params: { typed, what, near: near.it.name } });
        else if (c.ref.dataset && c.ref.dataset !== d.key) row.errors.push({ col: c.key, key: 'imp|“{typed}” was not found in {what}. Import {what} first, or check the spelling.', params: { typed, what } });
        else row.errors.push({ col: c.key, key: 'imp|“{typed}” was not found in {what}.', params: { typed, what } });
        delete row.v[c.key];
      }
      // which record it is: the first key column with a value
      // (a key may be several columns together, e.g. ['meter', 'period']: the dataset's find() reads them)
      let keyCol = null;
      let keyDef = null;
      const has = (k) => row.v[k] !== undefined && row.v[k] !== null && !(row.v[k] && row.v[k].self);
      for (const k of d.keys) if ([].concat(k).every(has)) { keyDef = k; keyCol = [].concat(k)[0]; break; }
      if (keyCol) {
        const parts = [].concat(keyDef);
        const sig = `${parts.join('+')}:${parts.map((k) => P.norm(row.v[k])).join('|')}`;
        if (seen.has(sig)) row.errors.push({ col: keyCol, key: 'imp|The same {col} is also on row {line}.', params: { col: parts.map((k) => T(d.col[k].label, lang)).join(' + '), line: seen.get(sig) } });
        else seen.set(sig, row.line);
        const found = d.find ? d.find(db, row.v, keyDef) : findBy(d, keyCol, row.v[keyCol]);
        if (found && found.error) row.errors.push({ col: keyCol, key: found.error, params: found.params });
        else if (found) row.id = Number(found);
      }
      row.label = d.label ? d.label(row.v, row.names) : String(row.v[[].concat(d.keys[0])[0]] ?? row.v[d.columns[0].key] ?? '');
      // a new record needs its required columns; an update only what it changes
      if (!row.id) {
        for (const c of d.columns) {
          if (!c.required || row.provided.has(c.key) || row.errors.some((e) => e.col === c.key)) continue;
          row.errors.push({ col: c.key, key: 'imp|{col} is required for a new record.', params: { col: T(c.label, lang) } });
        }
      } else if (opt.empties === 'clear') {
        for (const c of cols) if (c.required && !row.provided.has(c.key) && !row.errors.some((e) => e.col === c.key)) row.errors.push({ col: c.key, key: 'imp|{col} cannot be emptied.', params: { col: T(c.label, lang) } });
      }
      // the full row the dataset will save: the current record, then what the file gives
      const cur = row.id ? current.get(row.id) : null;
      if (row.id && cur) {
        row.full = {};
        for (const c of d.columns) {
          // the column that found the record keeps its stored spelling (a different case finds it too)
          if (keyCols.includes(c.key) && row.provided.has(c.key) && P.norm(row.v[c.key]) === P.norm(cur[c.key])) row.full[c.key] = cur[c.key];
          else if (row.provided.has(c.key)) row.full[c.key] = row.v[c.key];
          else if (opt.empties === 'clear' && c.key in byKey && !c.keepOnUpdate) row.full[c.key] = null;
          else if (c.type === 'ref') {
            const hit = cur[c.key] === null || cur[c.key] === undefined ? null : (allRefs[c.key].map.get(P.norm(cur[c.key])) || [])[0];
            row.full[c.key] = hit ? hit.id : null;
          } else row.full[c.key] = cur[c.key] ?? null;
        }
        // what changes
        row.diff = [];
        for (const c of d.columns) {
          if (!(c.key in byKey) || c.keepOnUpdate) continue;
          const was = cur[c.key] ?? null;
          let now = row.full[c.key];
          if (c.type === 'ref') now = row.provided.has(c.key) ? row.names[c.key] : now === null ? null : was;
          if (keyCols.includes(c.key) && now !== null && P.norm(now) === P.norm(was)) continue;
          if (!equal(c, was, now)) row.diff.push({ col: c.key, was, now });
        }
        // a value that is already in the system: keep it exactly as stored, and no warnings about it
        for (const c of d.columns) if (row.provided.has(c.key) && c.type !== 'ref' && !c.keepOnUpdate && equal(c, cur[c.key], row.full[c.key])) row.full[c.key] = cur[c.key] ?? null;
        row.warns = row.warns.filter((w) => !w.col || !row.provided.has(w.col) || row.diff.some((x) => x.col === w.col));
        for (const c of d.columns) if (c.keepOnUpdate && row.provided.has(c.key) && !equal(c, cur[c.key], row.v[c.key])) row.warns.push({ col: c.key, key: 'imp|{col} cannot be changed by an import; it stays {value}.', params: { col: T(c.label, lang), value: show(c, cur[c.key], lang) } });
      } else {
        row.full = {};
        for (const c of d.columns) row.full[c.key] = row.provided.has(c.key) ? row.v[c.key] : null;
        if (row.id) row.errors.push({ col: keyCol, key: 'imp|This record cannot be updated by an import.' });
      }
      if (d.rowCheck) {
        const ctx = {
          db, h, lang, user, id: row.id || null, current: cur || null, provided: row.provided, line: row.line,
          can: (min) => !!user && h.auth.allowed(user, min),
          error: (col, key, params) => row.errors.push({ col, key, params }),
          warn: (col, key, params) => row.warns.push({ col, key, params }),
        };
        try { d.rowCheck(row.full, ctx); } catch (e) { row.errors.push({ col: null, key: String(e.message || e) }); }
      }
      row.status = row.errors.length ? 'error' : !row.id ? 'new' : row.diff && row.diff.length ? 'update' : 'same';
      if (row.status === 'new' && opt.action === 'update') row.status = 'skip';
      if (row.status === 'update' && opt.action === 'create') row.status = 'skip';
    }
    // rules across the whole file (an opening trial balance must balance, two leave rows must not
    // overlap): fileCheck(rows, ctx) sees every row still going in, with its full values
    if (d.fileCheck) {
      const live = rows.filter((r) => ['new', 'update', 'same'].includes(r.status));
      const fail = (r, col, key, params) => { r.errors.push({ col, key, params }); r.status = 'error'; };
      try {
        d.fileCheck(live.map((r) => ({ line: r.line, id: r.id || null, full: r.full, status: r.status, label: r.label, row: r })), {
          db, h, lang, user, error: (x, col, key, params) => fail(x.row || x, col, key, params), warn: (x, col, key, params) => (x.row || x).warns.push({ col, key, params }),
        });
      } catch (e) { for (const r of live) fail(r, null, String(e.message || e)); }
    }
    const count = (s) => rows.filter((r) => r.status === s).length;
    const counts = { total: rows.length, new: count('new'), update: count('update'), same: count('same'), error: count('error'), skip: count('skip'), warn: rows.filter((r) => r.warns.length && r.status !== 'error').length };
    const again = db.get("SELECT b.*, u.name user_name FROM imp_batches b LEFT JOIN users u ON u.id = b.user_id WHERE b.dataset = ? AND b.sha = ? AND b.status = 'done' ORDER BY b.id DESC LIMIT 1", d.key, st.sha);
    return { d, opt, map, rows, counts, again, sheet: g.sheet.name, sheets: st.file.sheets.map((s) => s.name), headerRow: st.header_row, canCommit: counts.new + counts.update > 0 && (opt.mode === 'valid' || !counts.error) };
  }
  function findBy(d, col, value) {
    if (!d.table) return null;
    const c = d.col[col];
    const sqlCol = (c && c.column) || col;
    const hits = db.all(`SELECT id FROM ${d.table} WHERE ${sqlCol} = ? COLLATE NOCASE`, value);
    if (hits.length > 1) return { error: 'imp|More than one record has this {col}; fix them in the system first.', params: { col } };
    return hits.length ? hits[0].id : null;
  }
  function equal(c, a, b) {
    const blank = (x) => x === null || x === undefined || x === '';
    if (blank(a) && blank(b)) return true;
    if (blank(a) || blank(b)) return false;
    if (['int', 'number', 'money', 'percent'].includes(c.type)) return Math.abs(Number(a) - Number(b)) < 1e-9;
    if (c.type === 'bool') return !!a === !!b;
    if (c.type === 'list') return same([].concat(a).map(String), [].concat(b).map(String));
    // phones: the same number, however it is written (+20 10 1234 5678 = 01012345678)
    if (c.type === 'phone') { const n = (x) => P.phone(x).value || String(x).replace(/\D/g, ''); return n(a) === n(b); }
    if (['ref', 'email', 'code', 'enum'].includes(c.type)) return P.norm(a) === P.norm(b);
    return String(a) === String(b);
  }
  // a value for people: enum labels, dates as 15 Mar 2025, yes/no
  function show(c, v, lang = 'en') {
    if (v === null || v === undefined || v === '') return '—';
    if (c.type === 'enum') { const o = enumOf(c).find(([k]) => String(k) === String(v)); return o ? T(o[1], lang) : String(v); }
    if (c.type === 'bool') return i18n.run(lang, () => i18n.t(v ? 'imp|Yes' : 'imp|No'));
    if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return i18n.run(lang, () => h.ui.date(v));
    if (c.type === 'list') return [].concat(v).join(', ');
    if (['money', 'number'].includes(c.type)) return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return String(v);
  }

  // ---------- the import ----------
  function commit(st, options, user, lang = 'en') {
    const pv = preview(st, options, lang, user);
    const d = pv.d;
    if (pv.opt.mode === 'all' && pv.counts.error) return { error: 'imp|Some rows have problems. Fix them, or choose to import only the valid rows.', pv };
    if (!(pv.counts.new + pv.counts.update)) return { error: 'imp|There is nothing new or changed to import.', pv };
    const created = [];
    const changes = [];
    const failed = [];
    const selfIds = new Map();
    const pending = [];
    const snap = (id) => (d.snapshot ? d.snapshot(db, id) : d.table ? db.get(`SELECT * FROM ${d.table} WHERE id = ?`, id) : null);
    const ctxFor = (row) => ({
      db, h, user, lang, id: row.id || null, line: row.line,
      log: (action, entity, id, detail) => db.audit(user, action, entity, id, detail),
    });
    db.tx(() => {
      for (const row of pv.rows) {
        if (!['new', 'update'].includes(row.status)) continue;
        const full = { ...row.full };
        for (const c of d.columns) if (full[c.key] && typeof full[c.key] === 'object' && full[c.key].self) { pending.push({ row, col: c, key: full[c.key].self }); full[c.key] = null; }
        const work = () => {
          if (row.status === 'new') {
            const id = Number(d.apply(full, ctxFor(row)));
            if (!id) throw new Error('imp|The record could not be saved.');
            row.id = id;
            created.push({ id, label: row.label });
          } else {
            const before = snap(row.id);
            d.apply(full, ctxFor(row));
            changes.push({ id: row.id, label: row.label, before, after: null });
          }
        };
        if (pv.opt.mode === 'valid') {
          try { db.tx(work); } catch (e) { failed.push({ line: row.line, key: String(e.message || e) }); row.status = 'error'; continue; }
        } else {
          try { work(); } catch (e) {
            const err = new Error(String(e.message || e));
            err.line = row.line;
            throw err;
          }
        }
        for (const c of d.columns) if (c.ref && c.ref.self && row.v[c.ref.self] !== undefined) selfIds.set(P.norm(row.v[c.ref.self]), row.id);
      }
      // references to rows of the same file, now that they exist
      for (const p of pending) {
        if (!p.row.id || p.row.status === 'error') continue;
        const target = selfIds.get(p.key);
        if (target && target !== p.row.id) p.col.ref.set(db, p.row.id, target);
      }
      for (const ch of changes) ch.after = snap(ch.id);
      for (const c of created) c.after = snap(c.id);
    });
    const counts = { created: created.length, updated: changes.length, unchanged: pv.counts.same, skipped: pv.counts.skip + pv.counts.error };
    const id = Number(db.run('INSERT INTO imp_batches (dataset, file_name, sha, user_id, options, created, updated, unchanged, skipped, created_ids, changes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      d.key, st.file_name, st.sha, user ? user.id : null, JSON.stringify(pv.opt), counts.created, counts.updated, counts.unchanged, counts.skipped,
      JSON.stringify(created), JSON.stringify(changes), 'done', nowIso()).lastInsertRowid);
    db.audit(user, 'Imported from Excel', 'imp_batch', id, `${T(d.title, 'en')}: ${counts.created} new, ${counts.updated} updated, ${counts.unchanged} unchanged`);
    if (d.after) d.after(db, h, { created, changes });
    h.access.engine.touch && h.access.engine.touch();
    return { batch: id, counts, failed };
  }

  // ---------- undo ----------
  function batch(id) {
    const b = db.get('SELECT b.*, u.name user_name, x.name undone_name FROM imp_batches b LEFT JOIN users u ON u.id = b.user_id LEFT JOIN users x ON x.id = b.undone_by WHERE b.id = ?', id);
    if (!b) return null;
    return { ...b, created_ids: JSON.parse(b.created_ids || '[]'), changes: JSON.parse(b.changes || '[]'), options: JSON.parse(b.options || '{}'), d: get(b.dataset) };
  }
  // why a batch cannot be undone: [{ id, label, key, params }]; [] when it can
  function blockers(b, lang = 'en') {
    const out = [];
    const d = b.d;
    if (!d) return [{ key: 'imp|This kind of import is no longer available.' }];
    if (b.status !== 'done') return [{ key: 'imp|This import was already undone.' }];
    if (Date.parse(b.created_at) < Date.now() - UNDO_DAYS * 86400000) return [{ key: 'imp|Imports can be undone for {n} days.', params: { n: UNDO_DAYS } }];
    const snap = (id) => (d.snapshot ? d.snapshot(db, id) : db.get(`SELECT * FROM ${d.table} WHERE id = ?`, id));
    const batchIds = b.created_ids.map((c) => c.id);
    for (const c of b.created_ids) {
      const nowSnap = snap(c.id);
      if (!nowSnap) continue;
      // a record the import created and someone changed since (a draft activated, a cheque deposited)
      if (c.after && !same(nowSnap, c.after)) out.push({ id: c.id, label: c.label, key: 'imp|{label} was changed again after the import.', params: { label: c.label } });
      const uses = d.uses ? d.uses(db, c.id, { skip: batchIds }) : d.table ? usesOf(d.table, c.id, { skip: batchIds }) : [];
      for (const u of uses) if (u.n) out.push({ id: c.id, label: c.label, key: 'imp|{label} is now used by {n} {what}.', params: { label: c.label, n: u.n, what: T(u.what, lang) } });
    }
    for (const ch of b.changes) {
      if (!same(snap(ch.id), ch.after)) out.push({ id: ch.id, label: ch.label, key: 'imp|{label} was changed again after the import.', params: { label: ch.label } });
    }
    return out;
  }
  function undo(id, user, lang = 'en') {
    const b = batch(id);
    if (!b) return { error: 'imp|That import was not found.' };
    const why = blockers(b, lang);
    if (why.length) return { error: 'imp|This import cannot be undone.', blockers: why };
    const d = b.d;
    db.tx(() => {
      for (const ch of [...b.changes].reverse()) {
        if (d.restore) d.restore(db, ch.before);
        else {
          const cols = Object.keys(ch.before).filter((k) => k !== 'id');
          db.run(`UPDATE ${d.table} SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => ch.before[k]), ch.id);
        }
      }
      for (const c of [...b.created_ids].reverse()) {
        if (d.remove) d.remove(db, c.id);
        else db.run(`DELETE FROM ${d.table} WHERE id = ?`, c.id);
      }
      db.run("UPDATE imp_batches SET status = 'undone', undone_at = ?, undone_by = ? WHERE id = ?", nowIso(), user ? user.id : null, b.id);
      db.audit(user, 'Undid an Excel import', 'imp_batch', b.id, `${T(d.title, 'en')}: ${b.created} new, ${b.updated} updated, ${b.unchanged} unchanged`);
    });
    h.access.engine.touch && h.access.engine.touch();
    return { ok: true, batch: b };
  }

  // ---------- the template ----------
  const C = { forest: 'FF283833', sand: 'FFE9E4D6', ink: 'FF1E2925', gold: 'FFC39136', paper: 'FFFBFAF6', line: 'FFD1C9B3', rose: 'FFFDE2E1', roseInk: 'FF9F2A22', amber: 'FFFFF1D6' };
  function headerCell(cell, c, lang) {
    cell.value = `${T(c.label, lang)}${c.required ? ' *' : ''}`;
    cell.font = { bold: true, color: { argb: c.required ? 'FFFFFFFF' : C.ink }, size: 11, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? C.forest : C.sand } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true, readingOrder: lang === 'ar' ? 'rtl' : 'ltr' };
    cell.border = { bottom: { style: 'medium', color: { argb: C.gold } }, right: { style: 'thin', color: { argb: C.line } } };
  }
  function allowedText(c, lang, max = 20) {
    if (c.type === 'enum') { const o = enumOf(c); return o.slice(0, max).map(([, l]) => T(l, lang)).join(' · ') + (o.length > max ? ' …' : ''); }
    if (c.type === 'ref') { const it = c.ref.list(db); return it.length ? it.slice(0, max).map((x) => x.name).join(' · ') + (it.length > max ? ' …' : '') : null; }
    if (c.type === 'bool') return lang === 'ar' ? 'نعم · لا' : 'Yes · No';
    return null;
  }
  const typeName = (c) => ({ text: 'imp|Text', code: 'imp|Code', int: 'imp|Whole number', number: 'imp|Number', money: 'imp|Amount', percent: 'imp|Percent', date: 'imp|Date (day/month/year)', month: 'imp|Month (month/year)', time: 'imp|Time (hh:mm)', bool: 'imp|Yes / no', enum: 'imp|One of a list', email: 'imp|Email', phone: 'imp|Phone', ref: 'imp|From the list', list: 'imp|Several values, separated by commas' })[c.type] || 'imp|Text';
  const toCell = (c, v, lang) => {
    if (v === null || v === undefined || v === '') return null;
    if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) { const [y, m, dd] = String(v).split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); }
    if (c.type === 'enum') { const o = enumOf(c).find(([k]) => String(k) === String(v)); return o ? T(o[1], lang) : String(v); }
    if (c.type === 'bool') return lang === 'ar' ? (v ? 'نعم' : 'لا') : v ? 'Yes' : 'No';
    if (c.type === 'list') return [].concat(v).join(', ');
    if (['int', 'number', 'money', 'percent'].includes(c.type)) return Number(v);
    return String(v);
  };
  async function template(d, { lang = 'en', withData = false } = {}) {
    const ExcelJS = require('exceljs');
    return i18n.run(lang, async () => {
      const t = i18n.t;
      const S = SHEET[lang];
      const rtl = lang === 'ar';
      const wb = new ExcelJS.Workbook();
      wb.creator = 'The Wave';
      wb.created = new Date();
      const ws = wb.addWorksheet(S.data, { views: [{ state: 'frozen', ySplit: 1, rightToLeft: rtl, zoomScale: 110 }], properties: { tabColor: { argb: C.forest } } });
      // the dropdown lists: one column per enum/ref/bool column of the Lists sheet, which is written
      // last so it is the last tab (Data, Example, Read me, Lists)
      const listCols = [];
      const listRange = {};
      const letter = (n) => { let x = ''; for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) x = String.fromCharCode(65 + ((k - 1) % 26)) + x; return x; };
      for (const c of d.columns) {
        let values = null;
        if (c.type === 'enum') values = enumOf(c).map(([, l]) => T(l, lang));
        else if (c.type === 'ref') values = c.ref.list(db).map((x) => x.name);
        else if (c.type === 'bool') values = rtl ? ['نعم', 'لا'] : ['Yes', 'No'];
        if (!values) continue;
        listCols.push({ c, values });
        const L = letter(listCols.length);
        if (values.length) listRange[c.key] = `'${S.lists}'!$${L}$2:$${L}$${values.length + 1}`;
      }
      // Data: headers, notes, formats, validations
      const rowsWith = withData && d.export ? d.export(db) : [];
      const until = Math.max(1000, rowsWith.length + 500) + 1;
      d.columns.forEach((c, i) => {
        const col = ws.getColumn(i + 1);
        col.width = c.width || Math.min(40, Math.max(14, T(c.label, lang).length + 6));
        if (c.type === 'date') col.numFmt = 'dd/mm/yyyy';
        else if (['text', 'code', 'phone', 'email', 'ref', 'enum', 'list'].includes(c.type)) col.numFmt = '@';
        else if (c.type === 'money') col.numFmt = '#,##0.00';
        headerCell(ws.getCell(1, i + 1), c, lang);
        const allowed = allowedText(c, lang);
        const parts = [
          { font: { bold: true, size: 10 }, text: `${T(c.label, lang)}${c.required ? ` — ${t('imp|required')}` : ''}\n` },
          { font: { size: 9 }, text: `${t(typeName(c))}\n` },
        ];
        if (c.help) parts.push({ font: { size: 9 }, text: `${T(c.help, lang)}\n` });
        if (allowed) parts.push({ font: { size: 9, italic: true }, text: `${t('imp|Allowed')}: ${allowed}\n` });
        if (c.example !== undefined) parts.push({ font: { size: 9, color: { argb: 'FF5B6B65' } }, text: `${t('imp|Example')}: ${show(c, typeof c.example === 'object' && c.example ? T(c.example, lang) : c.example, lang)}` });
        ws.getCell(1, i + 1).note = { texts: parts, margins: { insetmode: 'auto' } };
        const range = `${col.letter}2:${col.letter}${until}`;
        const prompt = { showInputMessage: true, promptTitle: T(c.label, lang).slice(0, 32), prompt: String(c.help ? T(c.help, lang) : t(typeName(c))).slice(0, 250) };
        const err = { showErrorMessage: true, errorStyle: 'stop', errorTitle: T(c.label, lang).slice(0, 32) };
        let v = null;
        if (listRange[c.key]) v = { type: 'list', allowBlank: true, formulae: [listRange[c.key]], ...prompt, ...err, error: t('imp|Choose a value from the list.') };
        else if (c.type === 'date') v = { type: 'date', operator: 'between', allowBlank: true, formulae: [new Date(Date.UTC(1900, 0, 2)), new Date(Date.UTC(2200, 11, 31))], ...prompt, ...err, error: t('imp|Enter a date as day/month/year.') };
        else if (c.type === 'int') v = { type: 'whole', operator: 'between', allowBlank: true, formulae: [c.min ?? -1e9, c.maxValue ?? 1e12], ...prompt, ...err, error: t('imp|Enter a whole number.') };
        else if (['number', 'money', 'percent'].includes(c.type)) v = { type: 'decimal', operator: 'between', allowBlank: true, formulae: [c.min ?? (c.type === 'number' ? -1e12 : 0), c.maxValue ?? (c.type === 'percent' ? 100 : 1e13)], ...prompt, ...err, error: t('imp|Enter a number.') };
        else if (c.max && ['text', 'code'].includes(c.type)) v = { type: 'textLength', operator: 'lessThanOrEqual', allowBlank: true, formulae: [c.max], ...prompt, ...err, error: t('imp|Too long: {max} characters at most.', { max: c.max }) };
        else v = { type: 'any', allowBlank: true, ...prompt };
        ws.dataValidations.add(range, v);
      });
      ws.getRow(1).height = 36;
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: d.columns.length } };
      rowsWith.forEach((r, ri) => {
        d.columns.forEach((c, ci) => {
          const v = toCell(c, r[c.key], lang);
          if (v !== null) ws.getCell(ri + 2, ci + 1).value = v;
        });
      });
      // Example
      const ex = wb.addWorksheet(S.example, { views: [{ rightToLeft: rtl, state: 'frozen', ySplit: 1 }], properties: { tabColor: { argb: 'FF8DB4A6' } } });
      d.columns.forEach((c, i) => {
        ex.getColumn(i + 1).width = c.width || Math.min(40, Math.max(14, T(c.label, lang).length + 6));
        if (c.type === 'date') ex.getColumn(i + 1).numFmt = 'dd/mm/yyyy';
        headerCell(ex.getCell(1, i + 1), c, lang);
      });
      ex.getRow(1).height = 36;
      (d.examples || []).forEach((r, ri) => d.columns.forEach((c, ci) => {
        const raw = r[c.key] && typeof r[c.key] === 'object' && !Array.isArray(r[c.key]) ? T(r[c.key], lang) : r[c.key];
        const v = toCell(c, raw, lang);
        if (v !== null) ex.getCell(ri + 2, ci + 1).value = v;
      }));
      // Read me, in both languages
      const rm = wb.addWorksheet(S.readme, { views: [{ rightToLeft: rtl }], properties: { tabColor: { argb: 'FFB98A5A' } } });
      rm.getColumn(1).width = 34;
      rm.getColumn(2).width = 14;
      rm.getColumn(3).width = 26;
      rm.getColumn(4).width = 46;
      rm.getColumn(5).width = 60;
      let r = 1;
      const line = (vals, style = {}) => {
        vals.forEach((v, i) => {
          const cell = rm.getCell(r, i + 1);
          cell.value = v;
          cell.alignment = { wrapText: true, vertical: 'top', readingOrder: rtl ? 'rtl' : 'ltr' };
          if (style.font) cell.font = style.font;
          if (style.fill) cell.fill = style.fill;
        });
        r++;
      };
      const both = (key, p) => [i18n.run('en', () => i18n.t(key, p)), i18n.run('ar', () => i18n.t(key, p))];
      line([`${T(d.title, lang)} — ${t('imp|import template')}`], { font: { bold: true, size: 18, color: { argb: C.forest } } });
      line([t('imp|The Wave · Leasing office')], { font: { size: 10, color: { argb: 'FF5B6B65' } } });
      r++;
      const steps = ['imp|1. Fill the “Data” sheet: one row for each record. Keep the first row (the column titles) as it is.', 'imp|2. Columns in dark green with * are required for new records. Pick values from the dropdowns where there is one.', 'imp|3. Dates as day/month/year. Amounts as plain numbers, without the currency.', 'imp|4. To change records that already exist, keep their key column (code, name…) exactly as in the system: those rows update them.', 'imp|5. Upload the file in the office: Import from Excel. Nothing is saved until you have seen the preview and confirmed.', 'imp|6. A mistake? Every import can be undone for 14 days, as long as nothing uses its records yet.'];
      line(['English', 'العربية'], { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: C.forest } } });
      rm.mergeCells(r - 1, 2, r - 1, 5);
      for (const s of steps) {
        const [en, ar] = both(s);
        line([en, ar]);
        rm.mergeCells(r - 1, 2, r - 1, 5);
        rm.getRow(r - 1).height = 34;
        rm.getCell(r - 1, 2).alignment = { wrapText: true, vertical: 'top', readingOrder: 'rtl', horizontal: 'right' };
      }
      if (d.notes) {
        r++;
        line([T(d.notes, 'en'), T(d.notes, 'ar')], { font: { italic: true } });
        rm.mergeCells(r - 1, 2, r - 1, 5);
        rm.getRow(r - 1).height = 48;
      }
      r++;
      line([t('imp|The order to import your data in')], { font: { bold: true, size: 13, color: { argb: C.forest } } });
      list().forEach((x, i) => line([`${i + 1}. ${T(x.title, lang)}`, x.key === d.key ? '◀' : '', T(x.summary || '', lang)], x.key === d.key ? { font: { bold: true } } : {}));
      r++;
      line([t('imp|Columns')], { font: { bold: true, size: 13, color: { argb: C.forest } } });
      line([t('imp|Column'), t('imp|Required'), t('imp|Type'), t('imp|Allowed values'), t('imp|Notes')], { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: C.forest } } });
      for (const c of d.columns) {
        line([`${T(c.label, lang)}${c.required ? ' *' : ''}`, c.required ? t('imp|Yes') : '', t(typeName(c)), allowedText(c, lang, 40) || '', c.help ? T(c.help, lang) : '']);
      }
      const lists = wb.addWorksheet(S.lists, { views: [{ rightToLeft: rtl, state: 'frozen', ySplit: 1 }], properties: { tabColor: { argb: C.gold } } });
      listCols.forEach(({ c, values }, i) => {
        const head = lists.getCell(1, i + 1);
        head.value = T(c.label, lang);
        head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.forest } };
        values.forEach((v, k) => { lists.getCell(k + 2, i + 1).value = v; });
        if (!values.length) lists.getCell(2, i + 1).value = t('imp|(none yet)');
        lists.getColumn(i + 1).width = Math.min(46, Math.max(16, ...values.map((v) => String(v).length + 2), T(c.label, lang).length + 4));
      });
      wb.views = [{ activeTab: 0, firstSheet: 0 }];
      return wb.xlsx.writeBuffer();
    });
  }

  // ---------- their workbook back, with the problems marked ----------
  async function errorsWorkbook(st, options, lang = 'en', user = null) {
    const ExcelJS = require('exceljs');
    const pv = preview(st, options, lang, user);
    const msg = (e) => i18n.run(lang, () => `${e.col && pv.d.col[e.col] ? `${T(pv.d.col[e.col].label, lang)}: ` : ''}${i18n.t(e.key, e.params)}`);
    const wb = new ExcelJS.Workbook();
    let ws;
    const colOf = {};
    for (const m of pv.map.columns) if (m.key) colOf[m.key] = m.index + 1;
    const raw = fs.readFileSync(path.join(dir, `${st.token}.${st.ext}`));
    if (st.ext === 'xlsx') {
      await wb.xlsx.load(raw);
      ws = wb.getWorksheet(pv.sheet) || wb.worksheets[0];
    } else {
      ws = wb.addWorksheet('CSV');
      const g = grid(st);
      g.sheet.rows.forEach((row, ri) => row.forEach((x, ci) => { ws.getCell(ri + 1, ci + 1).value = cellValue(x); }));
    }
    const hr = pv.headerRow + 1;
    const errCol = Math.max(ws.columnCount, ...Object.values(colOf), 1) + 1;
    const head = ws.getCell(hr, errCol);
    head.value = lang === 'ar' ? 'المشكلات' : 'Problems';
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.roseInk } };
    ws.getColumn(errCol).width = 70;
    for (const row of pv.rows) {
      const list = [...row.errors, ...row.warns];
      if (!list.length) continue;
      const cell = ws.getCell(row.line, errCol);
      cell.value = list.map(msg).join('\n');
      cell.alignment = { wrapText: true, vertical: 'top' };
      cell.font = { color: { argb: row.errors.length ? C.roseInk : 'FF8A5A00' } };
      for (const e of list) {
        if (!e.col || !colOf[e.col]) continue;
        const bad = ws.getCell(row.line, colOf[e.col]);
        const isErr = row.errors.includes(e);
        bad.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isErr ? C.rose : C.amber } };
        bad.note = msg(e);
      }
    }
    return wb.xlsx.writeBuffer();
  }

  // ---------- what uses a record (for undo) ----------
  // Every table whose foreign key points at `table`, with the rows that point at this id; plus
  // documents filed against it. ignore: tables that belong to the record itself (a brand's contacts).
  let fkCache = null;
  function references(table) {
    if (!fkCache) {
      fkCache = {};
      for (const t of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
        for (const fk of db.all(`PRAGMA foreign_key_list(${t.name})`)) {
          (fkCache[fk.table] = fkCache[fk.table] || []).push({ table: t.name, column: fk.from });
        }
      }
    }
    return fkCache[table] || [];
  }
  // skip: ids of the same table to leave out (records created by the same import, which go too)
  function usesOf(table, id, { ignore = [], entity = null, skip = [] } = {}) {
    const out = [];
    for (const r of references(table)) {
      if (ignore.includes(r.table) || r.table.startsWith('imp_')) continue;
      const self = r.table === table ? [id, ...skip] : [];
      const n = db.value(`SELECT COUNT(*) FROM ${r.table} WHERE ${r.column} = ?${self.length ? ` AND id NOT IN (${self.map(() => '?').join(',')})` : ''}`, id, ...self);
      if (n) out.push({ n, what: TABLE_WORDS[r.table] || { en: r.table.replace(/_/g, ' '), ar: 'سجلات أخرى' } });
    }
    if (entity) {
      const n = db.value('SELECT COUNT(*) FROM documents WHERE entity = ? AND entity_id = ?', entity, id);
      if (n) out.push({ n, what: TABLE_WORDS.documents });
    }
    return out;
  }

  // ---------- facts for the import centre ----------
  function status(d) {
    const n = d.count ? d.count(db) : d.table ? db.value(`SELECT COUNT(*) FROM ${d.table}`) : null;
    const last = db.get("SELECT b.*, u.name user_name FROM imp_batches b LEFT JOIN users u ON u.id = b.user_id WHERE b.dataset = ? AND b.status = 'done' ORDER BY b.id DESC LIMIT 1", d.key);
    return { n, last };
  }

  return {
    register, get, list, forPage, canSee, canImport, canUndo, canExport,
    readFile, locate, mapColumns, rememberMapping, stage, staged, setSheet, setMapping, grid, preview, commit, batch, blockers, undo,
    template, errorsWorkbook, status, show, enumOf, parseCell, cellText, usesOf, T, MAX_BYTES, MAX_ROWS, UNDO_DAYS,
  };
}

// how the records that use something are named in "cannot be undone" messages
const TABLE_WORDS = {
  leads: { en: 'leads', ar: 'فرص' }, leases: { en: 'leases', ar: 'عقود' }, offers: { en: 'offers', ar: 'عروض' }, contacts: { en: 'contacts', ar: 'جهات اتصال' },
  invoices: { en: 'invoices', ar: 'فواتير' }, payments: { en: 'payments', ar: 'مدفوعات' }, cheques: { en: 'cheques', ar: 'شيكات' }, lease_units: { en: 'leases', ar: 'عقود' },
  offer_units: { en: 'offers', ar: 'عروض' }, documents: { en: 'documents', ar: 'مستندات' }, employees: { en: 'employees', ar: 'موظفين' }, departments: { en: 'departments', ar: 'أقسام' },
  payroll_lines: { en: 'payslips', ar: 'قسائم رواتب' }, leave_requests: { en: 'leave requests', ar: 'طلبات إجازة' }, activities: { en: 'activities', ar: 'أنشطة' },
  messages: { en: 'messages', ar: 'رسائل' }, fitout_projects: { en: 'fit-out projects', ar: 'مشروعات تجهيز' }, contracts: { en: 'contracts', ar: 'عقود خدمات' },
  att_punches: { en: 'clock-ins', ar: 'تسجيلات حضور' }, att_assign: { en: 'shift assignments', ar: 'تعيينات ورديات' }, att_devices: { en: 'registered phones', ar: 'هواتف مسجلة' },
  att_creds: { en: 'staff app sign-ins', ar: 'بيانات دخول تطبيق الموظفين' }, hr_advances: { en: 'salary advances', ar: 'سلف' }, work_orders: { en: 'work orders', ar: 'أوامر عمل' },
  units: { en: 'units', ar: 'وحدات' }, brands: { en: 'brands', ar: 'علامات تجارية' },
};

// the go-live checklist, in this order
const AREA_ORDER = { setup: 0, people: 1, property: 2, sales: 3, revenue: 4, finance: 5, operations: 6, records: 7, other: 9 };
const AREAS = [
  ['setup', { en: 'Set-up', ar: 'الإعداد' }],
  ['people', { en: 'People', ar: 'الموظفون' }],
  ['property', { en: 'Property', ar: 'العقار' }],
  ['sales', { en: 'Sales', ar: 'المبيعات' }],
  ['revenue', { en: 'Revenue', ar: 'الإيرادات' }],
  ['finance', { en: 'Finance', ar: 'المالية' }],
  ['operations', { en: 'Operations', ar: 'التشغيل' }],
  ['records', { en: 'Records', ar: 'السجلات' }],
  ['other', { en: 'Other', ar: 'أخرى' }],
];

module.exports = { create, AREAS, AREA_ORDER, SYNONYMS };
