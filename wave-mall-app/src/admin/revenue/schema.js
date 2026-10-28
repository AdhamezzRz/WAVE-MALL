'use strict';

// Tables of the revenue modules (applied once with db.ensure('revenue-1', …)).
// tenant_sales is read by other modules (footfall): keep brand_id, period (YYYY-MM) and amount (net sales).

const REVENUE_1 = `
  CREATE TABLE turnover_terms (
    lease_id INTEGER PRIMARY KEY REFERENCES leases(id) ON DELETE CASCADE,
    pct REAL NOT NULL DEFAULT 0, breakpoint_type TEXT NOT NULL DEFAULT 'natural', breakpoint REAL NOT NULL DEFAULT 0,
    frequency TEXT NOT NULL DEFAULT 'monthly', due_day INTEGER NOT NULL DEFAULT 10, annual_recon INTEGER NOT NULL DEFAULT 1,
    audit_rights INTEGER NOT NULL DEFAULT 1, notes TEXT, demo INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  );
  CREATE TABLE tenant_sales (
    id INTEGER PRIMARY KEY, brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    lease_id INTEGER REFERENCES leases(id) ON DELETE CASCADE, period TEXT NOT NULL,
    gross REAL NOT NULL DEFAULT 0, returns REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, transactions INTEGER,
    status TEXT NOT NULL DEFAULT 'submitted', submitted_via TEXT NOT NULL DEFAULT 'staff', submitted_by TEXT, submitted_at TEXT,
    verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL, verified_at TEXT, note TEXT,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL, audited INTEGER NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (lease_id, period)
  );
  CREATE INDEX tenant_sales_period ON tenant_sales(period);
  CREATE INDEX tenant_sales_brand ON tenant_sales(brand_id, period);
  CREATE TABLE turnover_bills (
    id INTEGER PRIMARY KEY, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE, period TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'period', sales REAL NOT NULL DEFAULT 0, base REAL NOT NULL DEFAULT 0, breakpoint REAL NOT NULL DEFAULT 0,
    pct REAL NOT NULL DEFAULT 0, due REAL NOT NULL DEFAULT 0, previously REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
    credits REAL NOT NULL DEFAULT 0, invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, credit_id INTEGER,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    UNIQUE (lease_id, period)
  );
  CREATE TABLE turnover_reminders (
    id INTEGER PRIMARY KEY, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE, period TEXT NOT NULL,
    channel TEXT NOT NULL, sent_to TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );

  CREATE TABLE revenue_credits (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, lease_id INTEGER REFERENCES leases(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, source TEXT NOT NULL, source_ref TEXT, amount REAL NOT NULL,
    applied REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', note TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE revenue_credit_uses (
    id INTEGER PRIMARY KEY, credit_id INTEGER NOT NULL REFERENCES revenue_credits(id) ON DELETE CASCADE,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, source TEXT, source_ref TEXT, amount REAL NOT NULL, created_at TEXT NOT NULL
  );

  CREATE TABLE sc_budgets (
    id INTEGER PRIMARY KEY, year INTEGER NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'draft', mgmt_fee_pct REAL NOT NULL DEFAULT 10,
    notes TEXT, approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, approved_at TEXT, demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE sc_lines (
    id INTEGER PRIMARY KEY, budget_id INTEGER NOT NULL REFERENCES sc_budgets(id) ON DELETE CASCADE, category TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0, recoverable INTEGER NOT NULL DEFAULT 1, accounts TEXT, note TEXT, UNIQUE (budget_id, category)
  );
  CREATE TABLE sc_actuals (
    id INTEGER PRIMARY KEY, year INTEGER NOT NULL, period TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL,
    description TEXT, source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX sc_actuals_year ON sc_actuals(year, category);
  CREATE UNIQUE INDEX sc_actuals_source ON sc_actuals(source, source_ref) WHERE source_ref IS NOT NULL;
  CREATE TABLE sc_unit_rules (
    year INTEGER NOT NULL, unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE, weight REAL NOT NULL DEFAULT 1,
    excluded INTEGER NOT NULL DEFAULT 0, cap REAL, note TEXT, PRIMARY KEY (year, unit_id)
  );
  CREATE TABLE sc_recons (
    id INTEGER PRIMARY KEY, year INTEGER NOT NULL, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, share REAL NOT NULL DEFAULT 0, billed REAL NOT NULL DEFAULT 0,
    balance REAL NOT NULL DEFAULT 0, credits REAL NOT NULL DEFAULT 0, invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    credit_id INTEGER REFERENCES revenue_credits(id) ON DELETE SET NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (year, lease_id)
  );

  CREATE TABLE utl_tariffs (
    id INTEGER PRIMARY KEY, utility TEXT NOT NULL, rate REAL NOT NULL DEFAULT 0, fixed_monthly REAL NOT NULL DEFAULT 0,
    tiers TEXT, vat_note TEXT, valid_from TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE utl_meters (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, utility TEXT NOT NULL, unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    area TEXT, serial TEXT, multiplier REAL NOT NULL DEFAULT 1, digits INTEGER NOT NULL DEFAULT 6, active INTEGER NOT NULL DEFAULT 1,
    installed_on TEXT, notes TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE utl_readings (
    id INTEGER PRIMARY KEY, meter_id INTEGER NOT NULL REFERENCES utl_meters(id) ON DELETE CASCADE, period TEXT NOT NULL,
    reading REAL NOT NULL, read_on TEXT, consumption REAL, flag TEXT, accepted INTEGER NOT NULL DEFAULT 0, note TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    UNIQUE (meter_id, period)
  );
  CREATE TABLE utl_bills (
    id INTEGER PRIMARY KEY, meter_id INTEGER NOT NULL REFERENCES utl_meters(id) ON DELETE CASCADE, period TEXT NOT NULL,
    lease_id INTEGER REFERENCES leases(id) ON DELETE SET NULL, consumption REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    UNIQUE (meter_id, period)
  );
`;

module.exports = { REVENUE_1 };
