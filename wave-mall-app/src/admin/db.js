'use strict';

// The leasing office database: one SQLite file (Node's built-in node:sqlite, no native build).
// The file lives in ADMIN_DB (a path, or ':memory:' for tests); by default in DATA_DIR or
// ../data next to the app. On Hostinger set DATA_DIR to a folder outside the deployed app so
// redeploys never touch it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// node:sqlite prints an "experimental" notice on load; keep the logs clean.
const emit = process.emitWarning;
process.emitWarning = function quiet(warning, ...rest) {
  if (String((warning && warning.message) || warning).includes('SQLite is an experimental')) return undefined;
  return emit.call(this, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

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
};

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

function open(env = process.env) {
  let file = env.ADMIN_DB;
  if (!file) {
    const dir = env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'leasing.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < SCHEMA.length; v++) {
    db.exec('BEGIN');
    db.exec(SCHEMA[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  const api = wrap(db, file);
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
