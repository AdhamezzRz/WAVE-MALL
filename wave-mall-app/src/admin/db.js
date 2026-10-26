'use strict';

// The leasing office database: one SQLite file (Node's built-in node:sqlite on Node 22.13+,
// otherwise sql.js; see sqlite.js — no native build either way).
// The file lives in ADMIN_DB (a path, or ':memory:' for tests); by default in DATA_DIR or
// ../data next to the app. On Hostinger set DATA_DIR to a folder outside the deployed app so
// redeploys never touch it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { engine } = require('./sqlite');

const { GROUND_UNITS, STREET_UNITS } = require('../data');

const SCHEMA = [
  // 1: the whole leasing office
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL DEFAULT 'agent', password_hash TEXT NOT NULL, title TEXT, phone TEXT,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT, agent TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE units (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, level TEXT NOT NULL, zone TEXT NOT NULL,
    indoor_m2 REAL NOT NULL DEFAULT 0, terrace_m2 REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'available', hold_until TEXT, hold_lead_id INTEGER,
    rent_m2 REAL, terrace_rent_m2 REAL, service_m2 REAL,
    frontage TEXT, notes TEXT, sort INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  );

  CREATE TABLE brands (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other',
    origin TEXT, website TEXT, instagram TEXT, stores INTEGER, tier TEXT, notes TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY, brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    name TEXT NOT NULL, title TEXT, email TEXT, phone TEXT, whatsapp TEXT, primary_contact INTEGER NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );

  CREATE TABLE leads (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', source TEXT NOT NULL DEFAULT 'direct',
    stage TEXT NOT NULL DEFAULT 'new', probability INTEGER NOT NULL DEFAULT 10,
    area_min REAL, area_max REAL, budget_m2 REAL, zone TEXT, unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    value_est REAL NOT NULL DEFAULT 0, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    next_step TEXT, next_step_at TEXT, message TEXT, lost_reason TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, stage_at TEXT NOT NULL, closed_at TEXT
  );
  CREATE INDEX leads_stage ON leads(stage);
  CREATE INDEX leads_owner ON leads(owner_id);

  CREATE TABLE activities (
    id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE, unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, type TEXT NOT NULL, subject TEXT NOT NULL, body TEXT,
    due_at TEXT, done_at TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX activities_lead ON activities(lead_id);
  CREATE INDEX activities_due ON activities(due_at);

  CREATE TABLE offers (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft', rent_m2 REAL NOT NULL, terrace_rent_m2 REAL NOT NULL DEFAULT 0,
    service_m2 REAL NOT NULL DEFAULT 0, term_years INTEGER NOT NULL DEFAULT 5, escalation_pct REAL NOT NULL DEFAULT 0,
    rent_free_months INTEGER NOT NULL DEFAULT 0, fitout_months INTEGER NOT NULL DEFAULT 0, deposit_months INTEGER NOT NULL DEFAULT 3,
    key_money REAL NOT NULL DEFAULT 0, start_date TEXT, valid_until TEXT, notes TEXT,
    needs_approval INTEGER NOT NULL DEFAULT 0, approved_by INTEGER REFERENCES users(id), approved_at TEXT,
    created_by INTEGER REFERENCES users(id), demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, sent_at TEXT, decided_at TEXT
  );
  CREATE TABLE offer_units (offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE, unit_id INTEGER NOT NULL REFERENCES units(id), PRIMARY KEY (offer_id, unit_id));

  CREATE TABLE leases (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, brand_id INTEGER NOT NULL REFERENCES brands(id),
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL, offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft', start_date TEXT NOT NULL, end_date TEXT NOT NULL, term_years INTEGER NOT NULL,
    rent_m2 REAL NOT NULL, terrace_rent_m2 REAL NOT NULL DEFAULT 0, service_m2 REAL NOT NULL DEFAULT 0,
    escalation_pct REAL NOT NULL DEFAULT 0, rent_free_months INTEGER NOT NULL DEFAULT 0, payment_freq TEXT NOT NULL DEFAULT 'quarterly',
    deposit REAL NOT NULL DEFAULT 0, key_money REAL NOT NULL DEFAULT 0, signed_at TEXT, notes TEXT,
    created_by INTEGER REFERENCES users(id), demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE lease_units (lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE, unit_id INTEGER NOT NULL REFERENCES units(id), PRIMARY KEY (lease_id, unit_id));

  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'rent', period_start TEXT, period_end TEXT, due_date TEXT NOT NULL,
    rent REAL NOT NULL DEFAULT 0, service REAL NOT NULL DEFAULT 0, other REAL NOT NULL DEFAULT 0, total REAL NOT NULL,
    paid REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', paid_at TEXT, method TEXT, note TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX invoices_due ON invoices(due_date);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT, email TEXT, phone TEXT, brand TEXT, subject TEXT,
    category TEXT, size TEXT, body TEXT, lang TEXT, status TEXT NOT NULL DEFAULT 'new',
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE subscribers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, lang TEXT, source TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);

  CREATE TABLE targets (
    id INTEGER PRIMARY KEY, period TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    leads INTEGER NOT NULL DEFAULT 0, viewings INTEGER NOT NULL DEFAULT 0, signed_m2 REAL NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0,
    UNIQUE (period, user_id)
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
    entity TEXT, entity_id INTEGER, detail TEXT, ip TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX audit_created ON audit(created_at);
  `,
  // 2: each person's language for the office (en or ar)
  `ALTER TABLE users ADD COLUMN lang TEXT;`,
  // 3: tenant files, the document vault, the contracts register and HR
  `
  ALTER TABLE users ADD COLUMN hr INTEGER NOT NULL DEFAULT 0;

  ALTER TABLE brands ADD COLUMN legal_name TEXT;
  ALTER TABLE brands ADD COLUMN cr_number TEXT;
  ALTER TABLE brands ADD COLUMN tax_id TEXT;
  ALTER TABLE brands ADD COLUMN vat_number TEXT;
  ALTER TABLE brands ADD COLUMN legal_address TEXT;
  ALTER TABLE brands ADD COLUMN signatory_name TEXT;
  ALTER TABLE brands ADD COLUMN signatory_title TEXT;
  ALTER TABLE brands ADD COLUMN signatory_id TEXT;
  ALTER TABLE brands ADD COLUMN bank_name TEXT;
  ALTER TABLE brands ADD COLUMN iban TEXT;
  ALTER TABLE brands ADD COLUMN store_manager TEXT;
  ALTER TABLE brands ADD COLUMN store_phone TEXT;
  ALTER TABLE brands ADD COLUMN store_email TEXT;
  ALTER TABLE brands ADD COLUMN opening_date TEXT;
  ALTER TABLE brands ADD COLUMN trading_hours TEXT;
  ALTER TABLE brands ADD COLUMN emergency_name TEXT;
  ALTER TABLE brands ADD COLUMN emergency_phone TEXT;
  ALTER TABLE brands ADD COLUMN insurance_policy TEXT;
  ALTER TABLE brands ADD COLUMN insurance_expiry TEXT;
  ALTER TABLE brands ADD COLUMN updated_at TEXT;

  CREATE TABLE documents (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE,
    entity TEXT NOT NULL, entity_id INTEGER, kind TEXT NOT NULL DEFAULT 'other', title TEXT NOT NULL,
    file_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, stored TEXT NOT NULL,
    issued_on TEXT, expires_on TEXT, notes TEXT, confidential INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, replaces_id INTEGER REFERENCES documents(id) ON DELETE SET NULL, archived INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX documents_entity ON documents(entity, entity_id);
  CREATE INDEX documents_expiry ON documents(expires_on);

  CREATE TABLE contracts (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL, counterparty TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'service', status TEXT NOT NULL DEFAULT 'active',
    start_date TEXT, end_date TEXT, notice_days INTEGER NOT NULL DEFAULT 60, auto_renew INTEGER NOT NULL DEFAULT 0,
    value REAL NOT NULL DEFAULT 0, billing TEXT NOT NULL DEFAULT 'monthly',
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, contact_name TEXT, contact_phone TEXT, contact_email TEXT, notes TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, head_id INTEGER, sort INTEGER NOT NULL DEFAULT 0, demo INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE employees (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_ar TEXT,
    national_id TEXT, birth_date TEXT, gender TEXT, nationality TEXT, marital_status TEXT,
    phone TEXT, email TEXT, address TEXT,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL, position TEXT,
    manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    hire_date TEXT NOT NULL, employment_type TEXT NOT NULL DEFAULT 'full_time', contract_end TEXT, probation_end TEXT,
    status TEXT NOT NULL DEFAULT 'active', ended_at TEXT, end_reason TEXT,
    basic_salary REAL NOT NULL DEFAULT 0, allowances REAL NOT NULL DEFAULT 0,
    insurance_no TEXT, insured_wage REAL, bank_name TEXT, iban TEXT,
    emergency_name TEXT, emergency_phone TEXT, annual_leave_days INTEGER, shift TEXT, notes TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX employees_dept ON employees(department_id);
  CREATE TABLE leave_requests (
    id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'annual', start_date TEXT NOT NULL, end_date TEXT NOT NULL, days REAL NOT NULL,
    reason TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_at TEXT, decision_note TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX leave_employee ON leave_requests(employee_id);
  CREATE TABLE payroll_runs (
    id INTEGER PRIMARY KEY, period TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'draft',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at TEXT, paid_at TEXT, notes TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE payroll_lines (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    basic REAL NOT NULL DEFAULT 0, allowances REAL NOT NULL DEFAULT 0, overtime REAL NOT NULL DEFAULT 0, bonus REAL NOT NULL DEFAULT 0,
    deductions REAL NOT NULL DEFAULT 0, unpaid_days REAL NOT NULL DEFAULT 0, insurance_employee REAL NOT NULL DEFAULT 0,
    insurance_employer REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0, net REAL NOT NULL DEFAULT 0, notes TEXT,
    UNIQUE (run_id, employee_id)
  );
  `,
];

const DEFAULT_SETTINGS = {
  company: 'The Wave, New Cairo',
  legal_name: 'The Wave Mall',
  address: 'North 90 Street, First Sector, New Cairo, Egypt',
  leasing_email: 'leasing@thewavemall.com',
  leasing_phone: '',
  currency: 'EGP',
  // list rates (per m² per month); edit in Settings or per unit
  rate_plaza: '',
  rate_street: '',
  rate_terrace_share: '40',
  service_m2: '',
  default_term_years: '5',
  default_escalation: '10',
  default_deposit_months: '3',
  max_discount_pct: '10',
  offer_valid_days: '21',
  hold_days: '7',
  vat_pct: '0',
  // HR (Egypt): social insurance shares and the insurable wage limits change each January; edit in Settings
  si_employee_pct: '11',
  si_employer_pct: '18.75',
  si_min_wage: '2300',
  si_max_wage: '14500',
  annual_leave_days: '21',
  work_days_month: '26',
  // the document vault warns this many days before a document expires
  doc_warn_days: '30',
};

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

// Opens (and creates or upgrades) the database. Returns the api, or a promise of it when this
// Node needs the WebAssembly engine.
function open(env = process.env) {
  let file = env.ADMIN_DB;
  if (!file) {
    const dir = env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'leasing.db');
  }
  const eng = engine(env);
  const opened = eng.open(file);
  return eng.sync ? ready(opened, file, eng.name) : opened.then((db) => ready(db, file, eng.name));
}

function ready(db, file, engineName) {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < SCHEMA.length; v++) {
    db.exec('BEGIN');
    db.exec(SCHEMA[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  const api = wrap(db, file);
  api.engine = engineName;
  seed(api);
  return api;
}

function wrap(db, file) {
  const cache = new Map();
  const stmt = (sql) => {
    if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
    return cache.get(sql);
  };
  const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  const api = {
    file,
    raw: db,
    all: (sql, ...p) => stmt(sql).all(...norm(p)),
    get: (sql, ...p) => stmt(sql).get(...norm(p)),
    run: (sql, ...p) => stmt(sql).run(...norm(p)),
    value: (sql, ...p) => {
      const row = stmt(sql).get(...norm(p));
      return row ? Object.values(row)[0] : undefined;
    },
    tx(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    setting(key) {
      const row = stmt('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : DEFAULT_SETTINGS[key];
    },
    settings() {
      const out = { ...DEFAULT_SETTINGS };
      for (const r of stmt('SELECT key, value FROM settings').all()) out[r.key] = r.value;
      return out;
    },
    setSetting(key, value) {
      stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value ?? ''));
    },
    // LD-0001, OF-2026-001, LS-2026-001, IN-2026-0001
    nextRef(table, prefix, width = 4, yearly = false) {
      const head = yearly ? `${prefix}-${new Date().getFullYear()}-` : `${prefix}-`;
      const last = stmt(`SELECT ref FROM ${table} WHERE ref LIKE ? ORDER BY id DESC LIMIT 1`).get(`${head}%`);
      const n = last ? Number(last.ref.slice(head.length)) + 1 : 1;
      return head + String(n).padStart(width, '0');
    },
    audit(user, action, entity, entityId, detail, ip) {
      stmt('INSERT INTO audit (user_id, action, entity, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        user ? user.id : null, action, entity || null, entityId ?? null, detail ? String(detail).slice(0, 500) : null, ip || null, now(),
      );
    },
    // a consistent copy of the whole database, written to dest
    backup: (dest) => db.backupTo(dest),
    close: () => db.close(),
  };
  return api;
}

// The units are the building: plaza shops G01–G16 and street-level S01–S07, from the developer's schedule.
function seed(db) {
  if (db.value('SELECT COUNT(*) FROM units')) return;
  db.tx(() => {
    GROUND_UNITS.forEach(([n, indoor, terrace], i) =>
      db.run('INSERT INTO units (code, level, zone, indoor_m2, terrace_m2, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `G${String(n).padStart(2, '0')}`, 'G', 'plaza', indoor, terrace, i, now()),
    );
    STREET_UNITS.forEach(([n, indoor, terrace], i) =>
      db.run('INSERT INTO units (code, level, zone, indoor_m2, terrace_m2, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `S${String(n).padStart(2, '0')}`, 'B1', 'street', indoor, terrace, 100 + i, now()),
    );
  });
}

// Passwords: scrypt with a random salt, stored as scrypt$N$salt$hash.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [alg, n, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: 8, p: 1 });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = { open, now, today, hashPassword, verifyPassword, DEFAULT_SETTINGS };
