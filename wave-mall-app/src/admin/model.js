'use strict';

// Leasing logic: the pipeline, pricing, offer financials, lease billing and the numbers
// behind the dashboard and reports. Rents are per m² per month; money is in the settings currency.

const { now, today } = require('./db');
const { t: tr, english } = require('./i18n');

// Labels are stored in English and read through t(), so they follow the reader's language.
const labels = (o) => new Proxy(o, { get: (obj, k) => (typeof k === 'string' && Object.hasOwn(obj, k) ? tr(obj[k]) : obj[k]) });
const st = (id, en, p) => ({ id, en, p, get label() { return tr(en); } });

const STAGES = [
  st('new', 'stage|New', 10),
  st('contacted', 'stage|Contacted', 20),
  st('viewing', 'stage|Viewing', 35),
  st('proposal', 'stage|Proposal', 50),
  st('negotiation', 'stage|Negotiation', 70),
  st('reserved', 'stage|Reserved', 90),
  st('won', 'stage|Signed', 100),
  st('lost', 'stage|Lost', 0),
];
const OPEN_STAGES = STAGES.filter((s) => !['won', 'lost'].includes(s.id)).map((s) => s.id);
const stage = (id) => STAGES.find((s) => s.id === id) || STAGES[0];
// The English stage name, for text the system stores (shown later with tx()).
const stageEn = (id) => english(stage(id).en);

const CATEGORIES = labels({
  fashion: 'Fashion & accessories', fnb: 'Food & beverage', beauty: 'Beauty & wellness', leisure: 'Leisure & entertainment',
  services: 'Services & clinics', home: 'Home & lifestyle', health: 'Health & pharmacy', other: 'category|Other',
});
const SOURCES = labels({
  website: 'Website', referral: 'Referral', broker: 'Broker', walk_in: 'Walk-in', social: 'Social media', event: 'Event', direct: 'Direct outreach', phone: 'source|Phone',
});
const ZONES = labels({ plaza: 'Plaza level', street: 'Street level', upper: 'Upper floors', kiosk: 'Kiosk' });
const UNIT_STATUS = labels({ available: 'unit|Available', hold: 'unit|On hold', reserved: 'unit|Reserved', leased: 'unit|Leased', blocked: 'unit|Blocked' });
const OFFER_STATUS = labels({ draft: 'offer|Draft', pending: 'offer|Awaiting approval', approved: 'offer|Approved', sent: 'offer|Sent', accepted: 'offer|Accepted', rejected: 'offer|Rejected', expired: 'offer|Expired' });
const LEASE_STATUS = labels({ draft: 'lease|Draft', active: 'lease|Active', ended: 'lease|Ended', terminated: 'lease|Terminated' });
const INVOICE_STATUS = labels({ open: 'invoice|Open', partial: 'invoice|Part paid', paid: 'invoice|Paid', void: 'invoice|Void' });
const ACTIVITY_TYPES = labels({ note: 'activity|Note', call: 'activity|Call', email: 'activity|Email', whatsapp: 'activity|WhatsApp', meeting: 'activity|Meeting', viewing: 'activity|Viewing', task: 'activity|Task' });
// Stored in English (leads.lost_reason); shown with tx().
const LOST_REASONS = ['Price', 'Unit size', 'Location', 'Timing', 'Chose another mall', 'No response', 'Other'];
// What an invoice is for, and how money arrives (billing.js and every module that bills).
const INVOICE_KINDS = labels({
  rent: 'kind|Rent', deposit: 'kind|Deposit', key: 'kind|Key money', other: 'kind|Other charge', service: 'kind|Service charge',
  turnover: 'kind|Turnover rent', service_recon: 'kind|Service charge settlement', utility: 'kind|Utilities', specialty: 'kind|Short-term space',
  fitout: 'kind|Fit-out', penalty: 'kind|Penalty',
});
const PAY_METHODS = labels({
  transfer: 'pay|Bank transfer', cheque: 'pay|Cheque', card: 'pay|Card', cash: 'pay|Cash', online: 'pay|Online payment', instapay: 'pay|InstaPay', fawry: 'pay|Fawry', wallet: 'pay|Mobile wallet',
});

// The document vault: what a document is, grouped by what it belongs to.
const DOC_KINDS = labels({
  commercial_register: 'Commercial register', tax_card: 'Tax card', vat_certificate: 'VAT certificate', signatory_id: 'Signatory ID',
  power_of_attorney: 'Power of attorney', insurance: 'Insurance policy', trademark: 'Trademark registration', fitout_drawings: 'Fit-out drawings',
  permit: 'Permit or licence', brand_profile: 'Brand profile',
  lease_contract: 'Signed lease', addendum: 'Addendum', handover: 'Handover report', guarantee: 'Bank guarantee', notice: 'Notice or letter',
  service_contract: 'Service contract',
  employment_contract: 'Employment contract', national_id: 'National ID', cv: 'CV', certificate: 'Certificate', medical: 'Medical certificate', insurance_form: 'Social insurance form',
  policy: 'Policy', licence: 'Mall licence',
  other: 'doc|Other',
});
const DOC_GROUPS = {
  brand: ['commercial_register', 'tax_card', 'vat_certificate', 'signatory_id', 'power_of_attorney', 'insurance', 'trademark', 'fitout_drawings', 'permit', 'brand_profile', 'other'],
  lease: ['lease_contract', 'addendum', 'handover', 'guarantee', 'notice', 'other'],
  contract: ['service_contract', 'addendum', 'insurance', 'guarantee', 'notice', 'other'],
  employee: ['employment_contract', 'national_id', 'cv', 'certificate', 'medical', 'insurance_form', 'other'],
  unit: ['fitout_drawings', 'handover', 'permit', 'other'],
  office: ['policy', 'licence', 'insurance', 'permit', 'other'],
};
// What every tenant must have on file (plus a signed lease on each active lease).
const TENANT_REQUIRED = ['commercial_register', 'tax_card', 'insurance', 'signatory_id'];
const DOC_ENTITIES = labels({ brand: 'Brand', lease: 'Lease', contract: 'Contract', employee: 'Employee', unit: 'Unit', office: 'The mall' });

const ROLES = labels({ admin: 'Administrator', manager: 'Sales manager', agent: 'Leasing agent', viewer: 'role|Viewer' });

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, '0');
function addMonths(iso, n) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}
const addDays = (iso, n) => new Date(Date.parse(iso.slice(0, 10)) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);
const monthKey = (iso) => iso.slice(0, 7);

// ---------- pricing ----------
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

function listRates(db, unit) {
  const s = db.settings();
  const base = num(unit.rent_m2) ?? num(unit.zone === 'street' ? s.rate_street : s.rate_plaza);
  const terrace = num(unit.terrace_rent_m2) ?? (base != null ? Math.round(base * (num(s.rate_terrace_share) ?? 40)) / 100 : null);
  const service = num(unit.service_m2) ?? num(s.service_m2) ?? 0;
  return { rent: base, terrace, service };
}

// Monthly rent for a set of units at the given rates.
function monthly(units, { rent = 0, terrace = 0, service = 0 }) {
  const indoor = units.reduce((t, u) => t + u.indoor_m2, 0);
  const outdoor = units.reduce((t, u) => t + u.terrace_m2, 0);
  return { indoor, outdoor, area: indoor + outdoor, rent: indoor * rent + outdoor * terrace, service: indoor * service };
}

// Year-by-year schedule for an offer or lease: escalation each year, rent-free months at the start.
function schedule(terms, units) {
  const m = monthly(units, { rent: terms.rent_m2, terrace: terms.terrace_rent_m2, service: terms.service_m2 });
  const years = [];
  let totalRent = 0;
  let totalService = 0;
  for (let y = 0; y < (terms.term_years || 1); y++) {
    const factor = (1 + (terms.escalation_pct || 0) / 100) ** y;
    const monthRent = m.rent * factor;
    const freeThisYear = Math.max(0, Math.min(12, (terms.rent_free_months || 0) - y * 12));
    const rent = monthRent * (12 - freeThisYear);
    const service = m.service * 12;
    years.push({ year: y + 1, rate: terms.rent_m2 * factor, monthRent, free: freeThisYear, rent, service, total: rent + service });
    totalRent += rent;
    totalService += service;
  }
  const months = (terms.term_years || 1) * 12;
  return {
    ...m,
    years,
    totalRent,
    totalService,
    total: totalRent + totalService + (terms.key_money || 0),
    firstMonth: m.rent,
    annual: m.rent * 12,
    deposit: m.rent * (terms.deposit_months || 0),
    effective: m.indoor ? totalRent / months / (m.indoor + m.outdoor * ((terms.terrace_rent_m2 || 0) / (terms.rent_m2 || 1))) : 0,
  };
}

// An offer below the list rate by more than the allowed discount needs a manager's approval.
function needsApproval(db, offer, units) {
  const allowed = Number(db.setting('max_discount_pct')) || 0;
  return units.some((u) => {
    const list = listRates(db, u).rent;
    return list && offer.rent_m2 < list * (1 - allowed / 100);
  });
}

// Billing: one invoice per period (monthly or quarterly, in advance) from start to end.
function invoicePlan(lease, units) {
  const m = monthly(units, { rent: lease.rent_m2, terrace: lease.terrace_rent_m2, service: lease.service_m2 });
  const step = lease.payment_freq === 'monthly' ? 1 : lease.payment_freq === 'annual' ? 12 : 3;
  const months = lease.term_years * 12;
  const out = [];
  for (let i = 0; i < months; i += step) {
    let rent = 0;
    let service = 0;
    for (let k = i; k < Math.min(i + step, months); k++) {
      const y = Math.floor(k / 12);
      if (k >= (lease.rent_free_months || 0)) rent += m.rent * (1 + (lease.escalation_pct || 0) / 100) ** y;
      service += m.service;
    }
    const start = addMonths(lease.start_date, i);
    const end = addDays(addMonths(lease.start_date, Math.min(i + step, months)), -1);
    out.push({ period_start: start, period_end: end, due_date: start, rent: Math.round(rent), service: Math.round(service) });
  }
  return out;
}

// ---------- leads ----------
// 0–100: how promising a lead looks from what we know.
function score(lead, extra = {}) {
  let s = 20;
  s += { fashion: 12, fnb: 14, beauty: 10, leisure: 8, home: 8, health: 6, services: 4, other: 2 }[lead.category] || 0;
  s += { referral: 14, broker: 10, website: 8, event: 8, direct: 6, walk_in: 6, social: 4, phone: 6 }[lead.source] || 0;
  if (lead.brand_id) s += 6;
  if (lead.area_min || lead.area_max) s += 6;
  if (lead.budget_m2) s += 8;
  if (extra.activities) s += Math.min(12, extra.activities * 3);
  if (extra.viewings) s += 10;
  if (lead.stage && stage(lead.stage).p >= 50) s += 10;
  return Math.max(0, Math.min(100, s));
}

function estimateValue(db, lead) {
  const unit = lead.unit_id ? db.get('SELECT * FROM units WHERE id = ?', lead.unit_id) : null;
  if (unit) {
    const r = listRates(db, unit);
    const rate = num(lead.budget_m2) ?? r.rent ?? 0;
    return Math.round((unit.indoor_m2 * rate + unit.terrace_m2 * (r.terrace ?? rate * 0.4)) * 12);
  }
  const area = num(lead.area_max) && num(lead.area_min) ? (Number(lead.area_min) + Number(lead.area_max)) / 2 : num(lead.area_max) ?? num(lead.area_min) ?? 0;
  const s = db.settings();
  const rate = num(lead.budget_m2) ?? num(lead.zone === 'street' ? s.rate_street : s.rate_plaza) ?? 0;
  return Math.round(area * rate * 12);
}

// ---------- the numbers ----------
function dashboard(db, user) {
  const t = today();
  const units = db.all('SELECT * FROM units');
  const area = (list) => list.reduce((s, u) => s + u.indoor_m2, 0);
  const gla = area(units);
  const leased = area(units.filter((u) => u.status === 'leased'));
  const committed = area(units.filter((u) => ['leased', 'reserved'].includes(u.status)));
  const open = db.all(`SELECT * FROM leads WHERE stage IN (${OPEN_STAGES.map(() => '?').join(',')})`, ...OPEN_STAGES);
  const pipeline = open.reduce((s, l) => s + l.value_est, 0);
  const weighted = open.reduce((s, l) => s + (l.value_est * l.probability) / 100, 0);
  const since = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const leads30 = db.value('SELECT COUNT(*) FROM leads WHERE created_at >= ?', since(30));
  const leadsPrev = db.value('SELECT COUNT(*) FROM leads WHERE created_at >= ? AND created_at < ?', since(60), since(30));
  const won = db.value("SELECT COUNT(*) FROM leads WHERE stage = 'won'");
  const lost = db.value("SELECT COUNT(*) FROM leads WHERE stage = 'lost'");
  const month = monthKey(t);
  const signedMonth = db.all("SELECT l.* FROM leases l WHERE l.status IN ('active','draft') AND substr(COALESCE(l.signed_at, l.created_at), 1, 7) = ?", month);
  const signedArea = signedMonth.reduce((s, l) => s + leaseArea(db, l.id), 0);
  const overdue = db.get("SELECT COUNT(*) n, COALESCE(SUM(total - paid), 0) amount FROM invoices WHERE status IN ('open','partial') AND due_date < ?", t);
  const collected = db.value("SELECT COALESCE(SUM(paid), 0) FROM invoices WHERE paid_at IS NOT NULL AND substr(paid_at, 1, 7) = ?", month);
  const annualRent = db.all("SELECT * FROM leases WHERE status = 'active'").reduce((s, l) => s + currentAnnualRent(db, l), 0);

  const byStage = STAGES.map((s) => {
    const rows = db.all('SELECT value_est, probability FROM leads WHERE stage = ?', s.id);
    return { ...s, count: rows.length, value: rows.reduce((a, r) => a + r.value_est, 0) };
  });
  const bySource = db.all('SELECT source, COUNT(*) n FROM leads GROUP BY source ORDER BY n DESC');
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = d.toISOString().slice(0, 7);
    const leases = db.all("SELECT id FROM leases WHERE status != 'terminated' AND substr(COALESCE(signed_at, created_at), 1, 7) = ?", key);
    months.push({
      key,
      month: d.getUTCMonth() + 1,
      get label() { return require('./ui').monthName(this.month); },
      leads: db.value('SELECT COUNT(*) FROM leads WHERE substr(created_at, 1, 7) = ?', key),
      signed: leases.reduce((s, l) => s + leaseArea(db, l.id), 0),
    });
  }
  const mine = user && user.role === 'agent' ? ' AND (a.user_id = ? OR l.owner_id = ?)' : '';
  const mineArgs = user && user.role === 'agent' ? [user.id, user.id] : [];
  const upcoming = db.all(
    `SELECT a.*, l.title lead_title, l.ref lead_ref, u.name user_name FROM activities a LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id
     WHERE a.type IN ('viewing','meeting') AND a.done_at IS NULL AND a.due_at >= ? AND a.due_at < ?${mine} ORDER BY a.due_at LIMIT 8`,
    t, addDays(t, 15), ...mineArgs,
  );
  const tasks = db.all(
    `SELECT a.*, l.title lead_title, l.ref lead_ref FROM activities a LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.done_at IS NULL AND a.due_at IS NOT NULL AND a.type NOT IN ('viewing','meeting') AND a.due_at < ? ${user ? 'AND a.user_id = ?' : ''} ORDER BY a.due_at LIMIT 8`,
    addDays(t, 3), ...(user ? [user.id] : []),
  );
  const approvals = db.all("SELECT o.*, l.title lead_title FROM offers o JOIN leads l ON l.id = o.lead_id WHERE o.status = 'pending' ORDER BY o.created_at");
  const holds = db.all("SELECT u.*, l.title lead_title FROM units u LEFT JOIN leads l ON l.id = u.hold_lead_id WHERE u.status = 'hold' AND u.hold_until IS NOT NULL AND u.hold_until <= ? ORDER BY u.hold_until", addDays(t, 3));
  const inbox = db.value("SELECT COUNT(*) FROM messages WHERE status = 'new'");
  const feed = db.all('SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 12');
  return {
    gla, leased, committed, occupancy: gla ? leased / gla : 0, commitment: gla ? committed / gla : 0,
    openCount: open.length, pipeline, weighted, leads30, leadsPrev, conversion: won + lost ? won / (won + lost) : null,
    signedCount: signedMonth.length, signedArea, overdue, collected, annualRent,
    byStage, bySource, months, upcoming, tasks, approvals, holds, inbox, feed, units,
  };
}

function leaseUnits(db, leaseId) {
  return db.all('SELECT u.* FROM lease_units lu JOIN units u ON u.id = lu.unit_id WHERE lu.lease_id = ? ORDER BY u.sort', leaseId);
}
function offerUnits(db, offerId) {
  return db.all('SELECT u.* FROM offer_units ou JOIN units u ON u.id = ou.unit_id WHERE ou.offer_id = ? ORDER BY u.sort', offerId);
}
const leaseArea = (db, id) => leaseUnits(db, id).reduce((s, u) => s + u.indoor_m2, 0);

function currentAnnualRent(db, lease) {
  const units = leaseUnits(db, lease.id);
  const m = monthly(units, { rent: lease.rent_m2, terrace: lease.terrace_rent_m2, service: 0 });
  const y = Math.max(0, Math.floor(daysBetween(lease.start_date, today()) / 365.25));
  return m.rent * 12 * (1 + lease.escalation_pct / 100) ** Math.min(y, lease.term_years - 1);
}

function reports(db) {
  const t = today();
  const units = db.all('SELECT * FROM units ORDER BY sort');
  const zones = Object.keys(ZONES)
    .map((z) => {
      const list = units.filter((u) => u.zone === z);
      if (!list.length) return null;
      const a = (st) => list.filter((u) => st.includes(u.status)).reduce((s, u) => s + u.indoor_m2, 0);
      const total = list.reduce((s, u) => s + u.indoor_m2, 0);
      return { zone: z, label: ZONES[z], units: list.length, total, leased: a(['leased']), reserved: a(['reserved', 'hold']), available: a(['available']) };
    })
    .filter(Boolean);

  const leases = db.all("SELECT l.*, b.name brand, b.category FROM leases l JOIN brands b ON b.id = l.brand_id WHERE l.status = 'active' ORDER BY l.end_date");
  const rentRoll = leases.map((l) => {
    const list = leaseUnits(db, l.id);
    const annual = currentAnnualRent(db, l);
    return { ...l, units: list.map((u) => u.code).join(', '), area: list.reduce((s, u) => s + u.indoor_m2, 0), annual, remaining: Math.max(0, daysBetween(t, l.end_date) / 365.25) };
  });
  const totalAnnual = rentRoll.reduce((s, r) => s + r.annual, 0);
  const wale = totalAnnual ? rentRoll.reduce((s, r) => s + r.remaining * r.annual, 0) / totalAnnual : 0;

  const mix = Object.keys(CATEGORIES)
    .map((c) => ({ id: c, label: CATEGORIES[c], area: rentRoll.filter((r) => r.category === c).reduce((s, r) => s + r.area, 0) }))
    .filter((m) => m.area);

  const agents = db.all("SELECT * FROM users WHERE active = 1 AND role IN ('agent','manager','admin') ORDER BY name").map((u) => {
    const period = monthKey(t);
    const target = db.get('SELECT * FROM targets WHERE period = ? AND user_id = ?', period, u.id);
    return {
      ...u,
      open: db.value(`SELECT COUNT(*) FROM leads WHERE owner_id = ? AND stage IN (${OPEN_STAGES.map(() => '?').join(',')})`, u.id, ...OPEN_STAGES),
      weighted: db.value(`SELECT COALESCE(SUM(value_est * probability / 100.0), 0) FROM leads WHERE owner_id = ? AND stage IN (${OPEN_STAGES.map(() => '?').join(',')})`, u.id, ...OPEN_STAGES),
      viewings: db.value("SELECT COUNT(*) FROM activities WHERE user_id = ? AND type = 'viewing' AND done_at IS NOT NULL AND substr(done_at, 1, 7) = ?", u.id, period),
      offers: db.value("SELECT COUNT(*) FROM offers WHERE created_by = ? AND substr(created_at, 1, 7) = ?", u.id, period),
      won: db.value("SELECT COUNT(*) FROM leads WHERE owner_id = ? AND stage = 'won'", u.id),
      wonValue: db.value("SELECT COALESCE(SUM(value_est), 0) FROM leads WHERE owner_id = ? AND stage = 'won'", u.id),
      leadsMonth: db.value('SELECT COUNT(*) FROM leads WHERE owner_id = ? AND substr(created_at, 1, 7) = ?', u.id, period),
      target,
    };
  });

  const sources = Object.keys(SOURCES)
    .map((s) => {
      const n = db.value('SELECT COUNT(*) FROM leads WHERE source = ?', s);
      const w = db.value("SELECT COUNT(*) FROM leads WHERE source = ? AND stage = 'won'", s);
      const v = db.value("SELECT COALESCE(SUM(value_est), 0) FROM leads WHERE source = ? AND stage = 'won'", s);
      return { id: s, label: SOURCES[s], leads: n, won: w, value: v, rate: n ? w / n : 0 };
    })
    .filter((s) => s.leads);

  const lostReasons = db.all("SELECT COALESCE(lost_reason, 'Not given') reason, COUNT(*) n FROM leads WHERE stage = 'lost' GROUP BY reason ORDER BY n DESC");

  const open = db.all("SELECT due_date, total - paid outstanding FROM invoices WHERE status IN ('open','partial')");
  const aging = [
    { label: tr('1–30 days'), test: (d) => d >= 1 && d <= 30 },
    { label: tr('31–60 days'), test: (d) => d > 30 && d <= 60 }, { label: tr('61–90 days'), test: (d) => d > 60 && d <= 90 }, { label: tr('Over 90 days'), test: (d) => d > 90 },
  ].map((b) => {
    const rows = open.filter((r) => b.test(daysBetween(r.due_date, t)));
    return { label: b.label, count: rows.length, amount: rows.reduce((s, r) => s + r.outstanding, 0) };
  });

  const forecast = STAGES.filter((s) => OPEN_STAGES.includes(s.id)).map((s) => {
    const rows = db.all('SELECT value_est, probability FROM leads WHERE stage = ?', s.id);
    return { ...s, count: rows.length, value: rows.reduce((a, r) => a + r.value_est, 0), weighted: rows.reduce((a, r) => a + (r.value_est * r.probability) / 100, 0) };
  });

  const expiries = rentRoll.filter((r) => daysBetween(t, r.end_date) <= 365);
  return { zones, rentRoll, totalAnnual, wale, mix, agents, sources, lostReasons, aging, forecast, expiries };
}

module.exports = {
  STAGES, OPEN_STAGES, stage, stageEn, CATEGORIES, INVOICE_KINDS, PAY_METHODS, DOC_KINDS, DOC_GROUPS, TENANT_REQUIRED, DOC_ENTITIES, SOURCES, ZONES, UNIT_STATUS, OFFER_STATUS, LEASE_STATUS, INVOICE_STATUS, ACTIVITY_TYPES, LOST_REASONS, ROLES,
  addMonths, addDays, daysBetween, monthKey, num, listRates, monthly, schedule, needsApproval, invoicePlan, score, estimateValue,
  dashboard, reports, leaseUnits, offerUnits, leaseArea, currentAnnualRent, now, today,
};
