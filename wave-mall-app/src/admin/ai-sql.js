'use strict';

// The assistant's read-only window on the office database (see routes/assistant.js).
//
// What a person may read through the assistant mirrors what they may open in the office:
//   - some tables are never readable (sessions, settings, tokens, raw payloads, the assistant's own);
//   - HR tables only with HR access, accounting tables only with finance access (as h.canHR /
//     h.canFinance);
//   - a table belongs to a sidebar module: if an administrator hid that module from the person
//     (users.hidden_modules), the assistant cannot read it either;
//   - secret columns (password hashes, tokens, signatures…) are never readable.
// A query is checked twice: as text (one SELECT/WITH statement; no PRAGMA, ATTACH, writes or file
// functions) and by SQLite itself: EXPLAIN shows every table and index the query would open and
// every column it would read, which catches views, subqueries and "SELECT *" alike. Then it runs
// with a row limit; on node:sqlite with a database file it runs in a worker thread on a separate
// read-only connection, with a time limit.

const path = require('node:path');

// tables nobody reads through the assistant
const NEVER = new Set(['sessions', 'settings', '_modules', 'portal_sessions', 'portal_tokens', 'payment_events', 'pk_edge_events', 'offer_signing', 'notice_emails', 'payment_links', 'payment_intents', 'outbox', 'web_images', 'footfall_imports', 'audit', 'backup_runs', 'notif_prefs', 'ppl_invites', 'ppl_logins']);
const NEVER_PREFIX = ['ai_', 'sqlite_'];
// columns nobody reads (any table)
const SECRET_COL = /^(password_hash|password|token|token_hash|access_token|csrf|reveal|signature|nonce|secret|api_key)$/i;
const HR = new Set(['employees', 'departments', 'leave_requests', 'payroll_runs', 'payroll_lines', 'hr_advances', 'hr_advance_repayments', 'documents']);
const HR_PREFIX = ['hr_', 'payroll_'];
const FINANCE_PREFIX = ['acc_', 'eta_'];
// the module each table belongs to (its sidebar entry); unknown tables by name prefix, or h.assistantTables
const MODULE = {
  messages: '/admin/inbox', leads: '/admin/leads', activities: '/admin/leads', offers: '/admin/offers', offer_units: '/admin/offers',
  conv_threads: '/admin/conversations', conv_messages: '/admin/conversations', snippets: '/admin/conversations',
  units: '/admin/units', brands: '/admin/brands', contacts: '/admin/brands', portal_users: '/admin/tenants', portal_notices: '/admin/tenants', portal_notice_reads: '/admin/tenants',
  spaces: '/admin/specialty', space_bookings: '/admin/specialty', space_peaks: '/admin/specialty',
  leases: '/admin/leases', lease_units: '/admin/leases', invoices: '/admin/billing', payments: '/admin/billing', revenue_credits: '/admin/billing', revenue_credit_uses: '/admin/billing',
  cheques: '/admin/cheques', cheque_events: '/admin/cheques', tenant_sales: '/admin/turnover', work_orders: '/admin/maintenance', wo_events: '/admin/maintenance',
  assets: '/admin/maintenance', ppm_plans: '/admin/maintenance', parking: '/admin/parking', footfall: '/admin/footfall', footfall_entrances: '/admin/footfall',
  subscribers: '/admin/subscribers', contracts: '/admin/contracts', documents: '/admin/documents', targets: '/admin/team',
  employees: '/admin/hr', departments: '/admin/hr', leave_requests: '/admin/hr/leave', payroll_runs: '/admin/hr/payroll', payroll_lines: '/admin/hr/payroll',
  hr_advances: '/admin/hr/advances', hr_advance_repayments: '/admin/hr/advances',
};
const MODULE_PREFIX = [['fitout_', '/admin/fitout'], ['turnover_', '/admin/turnover'], ['sc_', '/admin/service-charge'], ['utl_', '/admin/utilities'], ['acc_', '/admin/accounting'], ['eta_', '/admin/accounting'], ['pk_', '/admin/parking'], ['web_', '/admin/website'],
  ['col_', '/admin/collections'], ['lease_', '/admin/leases'], ['apr_', '/admin/approvals'], ['pur_', '/admin/purchasing'], ['inv_', '/admin/purchasing'],
  ['media_', '/admin/media'], ['sec_', '/admin/security'], ['cmp_', '/admin/compliance'], ['fb_', '/admin/feedback'], ['nrg_', '/admin/energy'], ['ppl_', '/admin/people'], ['users', '/admin/team']];

const startsWithAny = (name, list) => list.some((p) => name.startsWith(p));

// policy(name, extra) → { never, hr, finance, module }
function policy(name, extra = {}) {
  const x = extra[name] || {};
  const never = x.never || NEVER.has(name) || startsWithAny(name, NEVER_PREFIX);
  const hr = x.hr || HR.has(name) || startsWithAny(name, HR_PREFIX);
  const finance = x.finance || startsWithAny(name, FINANCE_PREFIX);
  let module = x.module || MODULE[name] || null;
  if (!module) {
    const hit = MODULE_PREFIX.find(([p]) => name.startsWith(p));
    if (hit) module = hit[1];
  }
  return { never, hr, finance, module };
}

// The tables this person may read: Map name → { cols: [{ name, type, secret }], rootpage }.
// ctx: { hr, finance, canOpen(href), extra (h.assistantTables) }
function allowedTables(db, ctx) {
  const out = new Map();
  for (const t of db.all("SELECT name, rootpage FROM sqlite_master WHERE type = 'table' ORDER BY name")) {
    const p = policy(t.name, ctx.extra);
    if (p.never || (p.hr && !ctx.hr) || (p.finance && !ctx.finance) || (p.module && ctx.canOpen && !ctx.canOpen(p.module))) continue;
    const cols = db.all('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid', t.name).map((c) => ({ name: c.name, type: c.type || '', pk: !!c.pk, secret: SECRET_COL.test(c.name) }));
    out.set(t.name, { name: t.name, rootpage: t.rootpage, cols, module: p.module, hr: p.hr, finance: p.finance });
  }
  return out;
}

// Comments, string literals and quoted identifiers out of the way, for the text checks.
function strip(sql) {
  let out = '';
  let i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '-' && n === '-') {
      const e = s.indexOf('\n', i);
      i = e < 0 ? s.length : e + 1;
      out += ' ';
    } else if (c === '/' && n === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? s.length : e + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === close) {
          if (close !== ']' && s[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += c === "'" ? " '' " : ' _q_ ';
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const DENY = /\b(pragma|attach|detach|insert|update|delete|create|drop|alter|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension|readfile|writefile|edit|fts3_tokenizer|sqlite_dbpage|dbstat|zipfile|sqlar|fsdir)\b|\breplace\b(?!\s*\()|\binto\b/i;

// Text checks. Returns { ok, sql, error } with the statement's trailing semicolon removed.
function checkText(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '').trim();
  if (!s) return { ok: false, error: 'Empty query.' };
  if (s.length > 8000) return { ok: false, error: 'The query is too long (8,000 characters at most).' };
  const bare = strip(s);
  if (bare.includes(';')) return { ok: false, error: 'One statement at a time: remove the semicolons.' };
  if (!/^\s*(select|with)\b/i.test(bare)) return { ok: false, error: 'Only a SELECT (or WITH … SELECT) statement can run: the assistant reads, it never changes records.' };
  const m = bare.match(DENY);
  if (m) return { ok: false, error: `Not allowed in a read-only query: ${m[0].toUpperCase()}.` };
  return { ok: true, sql: s };
}

const wrapLimit = (sql, limit) => `SELECT * FROM (\n${sql}\n) LIMIT ${Math.max(1, Number(limit) || 1) + 1}`;

// What the query would touch, from SQLite's own plan (EXPLAIN). Returns { ok, tables, error }.
function checkPlan(db, sql, allowed) {
  let ops;
  try {
    ops = db.raw.prepare(`EXPLAIN ${sql}`).all();
  } catch (err) {
    return { ok: false, error: `SQLite: ${String(err.message || err).replace(/^SQLITE_ERROR:\s*/i, '')}` };
  }
  const master = db.all('SELECT type, name, tbl_name, rootpage FROM sqlite_master WHERE rootpage IS NOT NULL AND rootpage > 0');
  const byRoot = new Map(master.map((m) => [Number(m.rootpage), m]));
  const cursors = new Map();
  const tables = new Set();
  const idxCols = new Map();
  const indexColumns = (name) => {
    if (!idxCols.has(name)) idxCols.set(name, db.all('SELECT name FROM pragma_index_xinfo(?) ORDER BY seqno', name).map((r) => r.name));
    return idxCols.get(name);
  };
  for (const op of ops) {
    const code = String(op.opcode);
    const p1 = Number(op.p1);
    const p2 = Number(op.p2);
    const p3 = Number(op.p3);
    if (['OpenWrite', 'VUpdate', 'VOpen', 'VCreate', 'VDestroy', 'Destroy', 'Clear', 'CreateBtree', 'ParseSchema', 'DropTable', 'DropIndex', 'DropTrigger', 'SqlExec', 'Vacuum', 'IncrVacuum', 'JournalMode', 'Pagecount', 'MaxPgcnt', 'Expire', 'TableLock'].includes(code)) {
      return { ok: false, error: code === 'VOpen' ? 'Virtual tables and table-valued functions are not available.' : 'The query would change the database, which the assistant may not do.' };
    }
    if (code === 'Transaction' && p2 !== 0) return { ok: false, error: 'The query would change the database, which the assistant may not do.' };
    if (code === 'OpenRead' || code === 'ReopenIdx') {
      if (p3 !== 0) return { ok: false, error: 'Only the office database can be read.' };
      const m = byRoot.get(p2);
      if (!m) return { ok: false, error: 'The query reads something that is not an office table.' };
      if (!allowed.has(m.tbl_name)) return { ok: false, error: `The table ${m.tbl_name} is not available to this person (their access does not include it).`, denied: m.tbl_name };
      tables.add(m.tbl_name);
      cursors.set(p1, m.type === 'index' ? { table: m.tbl_name, index: m.name } : { table: m.tbl_name });
    } else if (code === 'OpenDup') {
      if (cursors.has(p2)) cursors.set(p1, cursors.get(p2));
    } else if (code === 'Column') {
      const c = cursors.get(p1);
      if (!c) continue; // an ephemeral (sorter, subquery) cursor
      const t = allowed.get(c.table);
      const name = c.index ? indexColumns(c.index)[p2] : (t.cols[p2] || {}).name;
      if (name && SECRET_COL.test(name)) return { ok: false, error: `The column ${c.table}.${name} is never available to the assistant.` };
    }
  }
  return { ok: true, tables: [...tables] };
}

// Full check. Returns { ok, sql (wrapped with the row limit), tables, error }.
function check(db, sql, allowed, { limit = 200 } = {}) {
  const t = checkText(sql);
  if (!t.ok) return t;
  const wrapped = wrapLimit(t.sql, limit);
  const p = checkPlan(db, wrapped, allowed);
  if (!p.ok) return p;
  return { ok: true, sql: wrapped, inner: t.sql, tables: p.tables };
}

// one value, made safe for JSON and a page (binary out, long text cut)
function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return `[binary, ${v.length} bytes]`;
  const s = String(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

// The worker that runs a query on its own read-only connection (node:sqlite with a database file).
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const emit = process.emitWarning;
process.emitWarning = function (w, ...r) { if (String((w && w.message) || w).includes('SQLite is an experimental')) return; return emit.call(this, w, ...r); };
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true });
  db.exec('PRAGMA query_only = 1; PRAGMA busy_timeout = 2000;');
  const st = db.prepare(workerData.sql);
  const rows = [];
  for (const r of st.iterate()) { rows.push(r); if (rows.length > workerData.limit) break; }
  parentPort.postMessage({ rows: JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? '[binary, ' + v.length + ' bytes]' : v))) });
} catch (err) {
  parentPort.postMessage({ error: String(err.message || err) });
} finally {
  try { db && db.close(); } catch {}
}
`;

function inWorker(file, sql, limit, timeoutMs) {
  const { Worker } = require('node:worker_threads');
  return new Promise((resolve) => {
    const w = new Worker(WORKER, { eval: true, workerData: { file, sql, limit } });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
      w.terminate().catch(() => {});
    };
    const timer = setTimeout(() => finish({ error: `The query took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. Make it simpler (filter by date, aggregate).`, timeout: true }), timeoutMs);
    w.once('message', finish);
    w.once('error', (err) => finish({ error: String(err.message || err) }));
    w.once('exit', () => finish({ error: 'The query stopped unexpectedly.' }));
  });
}

// Runs a checked query. Returns { columns, rows (arrays), rowCount, truncated, ms } or { error }.
async function run(db, checked, { limit = 200, timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  let objs;
  const file = db.file && db.file !== ':memory:' ? path.resolve(db.file) : null;
  if (db.engine === 'node:sqlite' && file) {
    const r = await inWorker(file, checked.sql, limit, timeoutMs);
    if (r.error) return { error: r.error, ms: Date.now() - t0 };
    objs = r.rows;
  } else {
    // sql.js, or an in-memory database: in-process (the row limit bounds the work for listings)
    try {
      objs = db.raw.prepare(checked.sql).all();
    } catch (err) {
      return { error: `SQLite: ${String(err.message || err)}`, ms: Date.now() - t0 };
    }
  }
  const truncated = objs.length > limit;
  const rows = objs.slice(0, limit);
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((r) => columns.map((c) => cell(r[c]))), rowCount: rows.length, truncated, ms: Date.now() - t0 };
}

module.exports = { policy, allowedTables, strip, checkText, checkPlan, check, run, cell, SECRET_COL, NEVER };
