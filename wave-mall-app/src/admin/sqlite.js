'use strict';

// The SQLite engine for the leasing office.
// Node 22.13+ has SQLite built in (node:sqlite); older Node versions (18, 20, early 22) use sql.js,
// SQLite compiled to WebAssembly, which needs no native build. Both are driven through the same
// small surface db.js uses: exec(sql), prepare(sql).all/get/run(...params), close(), backupTo(file).
// ADMIN_SQLITE=sqljs forces the WebAssembly engine (the tests run both).

const fs = require('node:fs');
const path = require('node:path');

function nativeEngine() {
  try {
    // node:sqlite prints an "experimental" notice on load; keep the logs clean.
    const emit = process.emitWarning;
    process.emitWarning = function quiet(warning, ...rest) {
      if (String((warning && warning.message) || warning).includes('SQLite is an experimental')) return undefined;
      return emit.call(this, warning, ...rest);
    };
    const { DatabaseSync } = require('node:sqlite');
    return DatabaseSync;
  } catch {
    return null;
  }
}

// ---------- sql.js, made to look like node:sqlite ----------
// sql.js keeps the database in memory; every change outside a transaction (and every COMMIT)
// writes the whole file back atomically (temporary file, then rename). The office's database is
// small, so this is quick, and a crash can never leave a half-written file.
class SqlJsDatabase {
  constructor(SQL, file) {
    this.file = file;
    this.memory = file === ':memory:';
    const existing = !this.memory && fs.existsSync(file) ? fs.readFileSync(file) : null;
    this.db = new SQL.Database(existing || undefined);
    this.depth = 0;
    this.db.exec('PRAGMA foreign_keys = ON;');
  }
  exec(sql) {
    const s = String(sql).trim();
    // WAL and busy timeouts mean nothing to an in-memory engine
    const cleaned = s.replace(/PRAGMA\s+(journal_mode|busy_timeout)\s*=\s*[^;]+;?/gi, '');
    if (cleaned.trim()) this.db.exec(cleaned);
    if (/^BEGIN\b/i.test(s)) this.depth++;
    else if (/^(COMMIT|END)\b/i.test(s) || /^ROLLBACK\s*;?\s*$/i.test(s)) this.depth = Math.max(0, this.depth - 1);
    this.touched(s);
  }
  prepare(sql) {
    return new SqlJsStatement(this, String(sql));
  }
  touched(sql) {
    if (this.depth === 0 && !/^\s*(SELECT|WITH)\b/i.test(sql) && !/^\s*PRAGMA\s+\w+\s*;?\s*$/i.test(sql)) this.save();
  }
  save() {
    if (this.memory) return;
    // export() reopens the database underneath; settings like foreign_keys must be set again
    const data = this.db.export();
    this.db.exec('PRAGMA foreign_keys = ON;');
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.file);
  }
  backupTo(dest) {
    const data = this.db.export();
    this.db.exec('PRAGMA foreign_keys = ON;');
    fs.writeFileSync(dest, Buffer.from(data));
  }
  close() {
    this.db.close();
  }
}

class SqlJsStatement {
  constructor(owner, sql) {
    this.owner = owner;
    this.sql = sql;
  }
  // statements are prepared per call: sql.js frees them whenever the database is saved
  each(params, fn) {
    const st = this.owner.db.prepare(this.sql);
    try {
      if (params.length) st.bind(params);
      while (st.step()) if (fn(st.getAsObject()) === false) break;
    } finally {
      st.free();
    }
  }
  all(...params) {
    const rows = [];
    this.each(params, (r) => { rows.push(r); });
    return rows;
  }
  get(...params) {
    let row;
    this.each(params, (r) => { row = r; return false; });
    return row;
  }
  run(...params) {
    const db = this.owner.db;
    const st = db.prepare(this.sql);
    try {
      st.run(params.length ? params : undefined);
    } finally {
      st.free();
    }
    const changes = db.getRowsModified();
    const last = db.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = last.length ? Number(last[0].values[0][0]) : 0;
    this.owner.touched(this.sql);
    return { changes, lastInsertRowid };
  }
}

let sqljs = null;
async function loadSqlJs() {
  if (!sqljs) {
    const init = require('sql.js');
    const wasm = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
    sqljs = init({ wasmBinary: fs.readFileSync(wasm) });
  }
  return sqljs;
}

// Which engine this Node has: { name, sync, open(file) } — open() returns the database,
// or a promise of it for sql.js.
function engine(env = process.env) {
  const Native = (env.ADMIN_SQLITE || process.env.ADMIN_SQLITE) === 'sqljs' ? null : nativeEngine();
  if (Native) {
    return {
      name: 'node:sqlite',
      sync: true,
      open: (file) => {
        const db = new Native(file);
        db.backupTo = (dest) => db.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`);
        return db;
      },
    };
  }
  return { name: 'sql.js', sync: false, open: async (file) => new SqlJsDatabase(await loadSqlJs(), file) };
}

module.exports = { engine };
