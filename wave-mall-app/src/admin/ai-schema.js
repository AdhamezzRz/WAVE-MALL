'use strict';

// The database as the assistant sees it: every table this person may read (from sqlite_master),
// with its columns, links between tables, the codes a status-like column holds, and a short
// meaning for the tables and columns that matter most (the glossary below, kept by hand).
// Modules can describe their own tables: h.assistantTables[name] = { note, cols: { col: note } }.

const crypto = require('node:crypto');

// table → [meaning, { column: note }]
const GLOSSARY = {
  units: ['The mall\'s shop units (the building). code G01–G16 are plaza (ground) shops, S01–S07 street level. A merged or split unit is retired (status retired) and replaced.', { indoor_m2: 'indoor area m²', terrace_m2: 'terrace area m²', rent_m2: 'list rent per m² per month (NULL = the default rate in Settings)', status: 'available, hold, reserved, leased, blocked, retired', level: 'G = plaza level, B1 = street level' }],
  brands: ['Brands and tenants (companies), prospects included. A tenant is a brand with an active lease.', { category: 'trade category code', tier: 'brand tier' }],
  contacts: ['People at a brand (decision makers, store managers).', {}],
  leads: ['Leasing deals in the pipeline, one per brand opportunity.', { stage: 'new → contacted → viewing → proposal → negotiation → reserved → won (signed) or lost', probability: '% chance of signing', value_est: 'estimated annual rent', owner_id: 'the agent (users.id)', closed_at: 'when won or lost' }],
  activities: ['Calls, emails, viewings, meetings and tasks logged on leads.', { due_at: 'when a task or meeting is due', done_at: 'NULL = still open' }],
  offers: ['Rent proposals sent to a lead. offer_units lists their units.', { rent_m2: 'rent per m² per month', status: 'draft, pending (waiting for manager approval), approved, sent, accepted, rejected, expired', valid_until: 'date' }],
  leases: ['Signed leases (tenancy contracts). lease_units links a lease to its units (one lease can cover several units).', { status: 'draft, active, ended, terminated', start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD (expiry)', rent_m2: 'base rent per m² per month in the first year', escalation_pct: 'yearly increase %', escalation_steps: 'JSON list of stepped increases (overrides escalation_pct)', service_mode: 'how the service charge is set (per m² or % of rent)', vat_pct: 'VAT % on this lease', revenue_share: '1 = pays a % of sales', revenue_pct: '% of sales', min_guarantee: 'minimum rent guaranteed when on revenue share', take_higher: '1 = the higher of base rent and the sales %', deposit: 'security deposit amount', term_years: 'years' }],
  lease_units: ['Which units each lease covers.', {}],
  invoices: ['Everything billed: rent, service charge, deposits, parking, utilities, short-term space… One row per invoice.', { total: 'amount billed incl. VAT', paid: 'amount paid so far', status: 'open, partial (part paid), paid, void. Outstanding = total - paid where status IN (\'open\',\'partial\'). Overdue = that, with due_date before today.', due_date: 'YYYY-MM-DD', period_start: 'first day billed', period_end: 'last day billed', customer: 'name when not a brand', vat: 'VAT included in total' }],
  payments: ['Money received against invoices (one row per receipt).', { date: 'YYYY-MM-DD received' }],
  cheques: ['Post-dated and other cheques received from tenants, and where each one is.', { status: 'where the cheque is now (received, deposited, collected, bounced, returned…)', due_date: 'the date on the cheque', amount: 'cheque amount' }],
  cheque_events: ['Each step in a cheque\'s life (received, deposited, collected, bounced…).', { at: 'when' }],
  contracts: ['Supplier and service contracts of the mall (cleaning, security, lifts…), not tenant leases.', { notice_days: 'notice period before end_date', auto_renew: '1 = renews itself' }],
  documents: ['Files on record (tenant documents, licences, employee files) with their expiry dates.', { entity: 'what the file is about (brand, lease, employee, office…)', expires_on: 'expiry date', archived: '1 = replaced or removed' }],
  employees: ['The mall\'s own staff (HR).', { basic_salary: 'monthly basic salary', allowances: 'monthly allowances', hire_date: 'YYYY-MM-DD' }],
  leave_requests: ['Staff leave requests.', { days: 'working days' }],
  payroll_runs: ['Monthly payrolls.', { period: 'YYYY-MM' }],
  payroll_lines: ['Each person\'s pay in a payroll run.', { net: 'net pay', insurance_employee: 'employee social insurance', advance: 'salary advance installment taken off' }],
  hr_advances: ['Salary advances (loans to staff), repaid from pay.', {}],
  work_orders: ['Maintenance jobs (reactive and planned).', { resolve_due: 'deadline (SLA)', cost_labour: 'cost', cost_parts: 'cost', cost_contractor: 'cost' }],
  assets: ['Building equipment (chillers, lifts, pumps…).', {}],
  ppm_plans: ['Planned preventive maintenance schedules.', { next_due: 'next date due' }],
  footfall: ['Visitors counted at each entrance, per hour.', { ts_hour: 'Cairo local hour as text \'YYYY-MM-DDTHH\' (e.g. 2026-10-07T18). The day is substr(ts_hour,1,10).', visitors_in: 'people coming in that hour' }],
  footfall_entrances: ['The mall\'s entrances with counters.', {}],
  parking: ['Car park totals per hour.', { ts_hour: 'Cairo local hour \'YYYY-MM-DDTHH\'', entries: 'cars in', exits: 'cars out', occupancy: 'cars inside at the end of the hour' }],
  pk_sessions: ['Car park visits (one per car stay).', { entry_at: 'UTC timestamp', exit_at: 'UTC timestamp', fee: 'parking fee', paid: 'amount paid' }],
  pk_payments: ['Car park takings: each payment at a booth, pay machine, online or exit lane.', { at: 'UTC timestamp of the payment', amount: 'amount taken', status: 'only status ok counts as money taken' }],
  pk_permits: ['Monthly parking subscriptions (staff, tenants, residents).', {}],
  pk_validations: ['Parking validated (paid for) by a shop for its customer.', { value: 'value of the validation', payer: 'who pays: the shop or the mall' }],
  pk_valet: ['Valet parking tickets.', {}],
  pk_violations: ['Parking violations and fines.', {}],
  pk_incidents: ['Car park incidents (damage, lost items, accidents).', {}],
  pk_tills: ['Cashier shifts at the car park (float, counted cash, differences).', {}],
  tenant_sales: ['Monthly sales reported by tenants (for turnover rent).', { period: 'YYYY-MM', amount: 'net sales' }],
  turnover_bills: ['Turnover (percentage) rent billed on tenant sales.', {}],
  sc_budgets: ['Yearly service charge budgets.', {}],
  sc_actuals: ['Actual service charge costs by category.', {}],
  utl_meters: ['Electricity, water and gas meters.', {}],
  utl_readings: ['Monthly meter readings.', { period: 'YYYY-MM', consumption: 'units used in the month' }],
  utl_bills: ['Utility recharges billed to tenants.', {}],
  spaces: ['Short-term spaces (kiosks, promotional spots, event areas).', {}],
  space_bookings: ['Bookings of short-term spaces.', { price: 'price charged', days: 'days booked' }],
  fitout_projects: ['Tenant fit-out works from handover to opening.', { planned_opening: 'date', actual_opening: 'date' }],
  conv_threads: ['WhatsApp and email conversations with leads and tenants.', {}],
  messages: ['Website enquiries in the inbox.', {}],
  portal_users: ['Tenant staff with access to the tenant portal.', {}],
  portal_notices: ['Notices published to tenants on the portal.', {}],
  users: ['The office team (people who sign in here).', { role: 'admin, manager, agent, viewer', hr: '1 = HR access', finance: '1 = finance access' }],
  targets: ['Monthly sales targets per agent.', { period: 'YYYY-MM' }],
  subscribers: ['People subscribed to the mall\'s news from the website.', {}],
  web_stores: ['Store pages on the public website.', {}],
  web_events: ['Events listed on the public website.', {}],
  acc_accounts: ['Chart of accounts.', {}],
  acc_entries: ['Journal entries (double entry). acc_lines holds their debit/credit lines.', { date: 'YYYY-MM-DD' }],
  acc_lines: ['Journal lines.', { debit: 'amount', credit: 'amount' }],
  acc_bills: ['Supplier bills (payables).', {}],
  acc_vendors: ['Suppliers.', {}],
  acc_banks: ['Bank accounts of the mall.', {}],
  acc_budgets: ['Budgets per account per month.', { period: 'YYYY-MM' }],
};

// status-like text columns whose distinct codes are listed for the model
const CODE_COL = /^(status|kind|type|stage|method|category|source|channel|level|zone|direction|utility|role|priority|tier|frequency|via|payer|service_mode|class|employment_type|gender|criticality|breakpoint_type|every_unit|list)$/;
const CODE_VAL = /^[a-z0-9][a-z0-9_ -]{0,29}$/; // codes only: nobody's typed text reaches the prompt
const DATE_VAL = /^\d{4}-\d{2}(-\d{2}([T ]\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?Z?)?)?$/;
const DATEISH = /(_at|_on|_date|^date|^period|_period|ts_hour|^at|_until|_from|_to|_due|^due|^next_due|^last_done)$/;

// the format of a date-like value, by an example (stable wording, so the prompt does not change with the data)
const dateKind = (v) => (/Z$/.test(v) && v.length > 16 ? 'UTC timestamp' : /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(v) ? "Cairo hour 'YYYY-MM-DDTHH'" : /^\d{4}-\d{2}-\d{2}$/.test(v) ? "date 'YYYY-MM-DD'" : /^\d{4}-\d{2}$/.test(v) ? "month 'YYYY-MM'" : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) ? 'local date and time' : 'date');
const qi = (n) => `"${String(n).replace(/"/g, '""')}"`;

// The schema text for these allowed tables (see ai-sql.js allowedTables). Deterministic for the
// same database shape and codes, so the prompt cache keeps hitting.
function describe(db, allowed, extra = {}) {
  const lines = [];
  for (const t of [...allowed.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const g = GLOSSARY[t.name] || [extra[t.name] && extra[t.name].note ? extra[t.name].note : '', {}];
    const colNotes = { ...(g[1] || {}), ...((extra[t.name] && extra[t.name].cols) || {}) };
    let fks = [];
    try {
      fks = db.all('SELECT "from" AS f, "table" AS t, "to" AS c FROM pragma_foreign_key_list(?)', t.name);
    } catch {
      fks = [];
    }
    const fk = Object.fromEntries(fks.map((k) => [k.f, `${k.t}.${k.c || 'id'}`]));
    let rows = null;
    try {
      rows = db.value(`SELECT COUNT(*) FROM ${qi(t.name)}`);
    } catch {
      rows = null;
    }
    const cols = t.cols.filter((c) => !c.secret).map((c) => {
      const bits = [];
      if (fk[c.name]) bits.push(`→ ${fk[c.name]}`);
      if (colNotes[c.name]) bits.push(colNotes[c.name]);
      if (CODE_COL.test(c.name) && /TEXT/i.test(c.type)) {
        try {
          const vals = db.all(`SELECT DISTINCT ${qi(c.name)} v FROM ${qi(t.name)} WHERE ${qi(c.name)} IS NOT NULL ORDER BY 1 LIMIT 13`).map((r) => String(r.v)).filter((v) => CODE_VAL.test(v));
          if (vals.length && vals.length <= 12) bits.push(`codes: ${vals.join(', ')}`);
        } catch { /* ignore */ }
      }
      if (DATEISH.test(c.name) && !colNotes[c.name]) {
        try {
          const ex = db.value(`SELECT ${qi(c.name)} FROM ${qi(t.name)} WHERE ${qi(c.name)} IS NOT NULL LIMIT 1`);
          if (ex !== undefined && ex !== null && DATE_VAL.test(String(ex))) bits.push(dateKind(String(ex)));
        } catch { /* ignore */ }
      }
      return `${c.name}${c.pk ? ' PK' : ''}${c.type ? ` ${c.type}` : ''}${bits.length ? ` (${bits.join('; ')})` : ''}`;
    });
    const secret = t.cols.some((c) => c.secret) ? ' Some columns are withheld.' : '';
    // row counts are rounded so small changes do not alter the prompt (and its cache)
    const approx = rows === null ? '' : rows === 0 ? ', empty' : rows < 10 ? `, ${rows} rows` : `, ~${Number(String(rows).slice(0, 1).padEnd(String(rows).length, '0')).toLocaleString('en-US')}+ rows`;
    lines.push(`## ${t.name}${approx}${g[0] ? ` — ${g[0]}` : ''}${secret}\n${cols.join(', ')}`);
  }
  return lines.join('\n\n');
}

const fingerprint = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

module.exports = { describe, fingerprint, GLOSSARY };
