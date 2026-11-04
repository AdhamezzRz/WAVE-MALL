'use strict';

// Contract terms beyond one flat rate, shared by the rent schedule, invoicing, turnover rent and the
// reports (pure functions, no database, except ensure()).
//
//   Stepped increases   escalation_pct applies from year 2; escalation_steps changes it from a given
//                       year on, e.g. [{ from: 6, pct: 12.5 }]: +10% a year for years 2–5, then +12.5%.
//   Service charge      per m² of indoor area (service_m2), or a percentage of the month's rent
//                       (service_mode 'pct', service_pct), following the rent's increases.
//   VAT                 vat_pct per contract (null: the office setting) and whether the contract's
//                       amounts already include it (vat_included).
//   Revenue share       a percentage of the tenant's sales (revenue_pct) with an optional minimum
//                       guarantee per month (min_guarantee, which then is the base rent); take_higher:
//                       the tenant pays whichever is higher, else the base plus the percentage.

const SCHEMA = `
  ALTER TABLE leases ADD COLUMN escalation_steps TEXT;
  ALTER TABLE leases ADD COLUMN service_mode TEXT NOT NULL DEFAULT 'm2';
  ALTER TABLE leases ADD COLUMN service_pct REAL NOT NULL DEFAULT 0;
  ALTER TABLE leases ADD COLUMN vat_pct REAL;
  ALTER TABLE leases ADD COLUMN vat_included INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE leases ADD COLUMN revenue_share INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE leases ADD COLUMN revenue_pct REAL NOT NULL DEFAULT 0;
  ALTER TABLE leases ADD COLUMN min_guarantee REAL;
  ALTER TABLE leases ADD COLUMN take_higher INTEGER NOT NULL DEFAULT 1;
`;
const ensure = (db) => db.ensure && db.ensure('contract-terms-1', SCHEMA);

// [{ from, pct }] sorted by year, from a stored JSON string or an array; bad entries dropped.
function steps(v) {
  let list = v;
  if (typeof v === 'string') {
    try {
      list = JSON.parse(v);
    } catch {
      list = [];
    }
  }
  return (Array.isArray(list) ? list : [])
    .map((s) => ({ from: Math.round(Number(s && s.from)), pct: Number(s && s.pct) }))
    .filter((s) => s.from >= 2 && s.from <= 60 && Number.isFinite(s.pct) && s.pct >= 0 && s.pct <= 100)
    .sort((a, b) => a.from - b.from)
    .filter((s, i, a) => i === a.length - 1 || a[i + 1].from !== s.from);
}
// The increase that applies at the start of contract year n (n ≥ 2).
function pctFor(terms, n) {
  let pct = Number(terms.escalation_pct) || 0;
  for (const s of steps(terms.escalation_steps)) if (s.from <= n) pct = s.pct;
  return pct;
}
// Rent multiplier in contract year y (0-based): the product of every increase so far.
function factor(terms, y) {
  let f = 1;
  for (let n = 2; n <= y + 1; n++) f *= 1 + pctFor(terms, n) / 100;
  return f;
}
// "10% a year", or "10% for years 2–5, then 12.5%".
function describe(terms, tr = (k, p) => k.replace(/\{(\w+)\}/g, (_, x) => p[x])) {
  const list = steps(terms.escalation_steps);
  const base = Number(terms.escalation_pct) || 0;
  if (!list.length) return tr('{pct}% a year', { pct: base });
  const parts = [tr('{pct}% a year until year {to}', { pct: base, to: list[0].from - 1 })];
  list.forEach((s, i) => parts.push(list[i + 1]
    ? tr('{pct}% from year {from} to {to}', { pct: s.pct, from: s.from, to: list[i + 1].from - 1 })
    : tr('{pct}% from year {from}', { pct: s.pct, from: s.from })));
  return parts.join(' · ');
}

const hasGuarantee = (terms) => !!terms.revenue_share && Number(terms.min_guarantee) > 0;
// Monthly base rent before increases: the minimum guarantee when there is one, else the rates × the area.
function baseMonthly(terms, units, rates = {}) {
  const indoor = units.reduce((t, u) => t + (u.indoor_m2 || 0), 0);
  const outdoor = units.reduce((t, u) => t + (u.terrace_m2 || 0), 0);
  const rent = hasGuarantee(terms)
    ? Number(terms.min_guarantee)
    : indoor * (rates.rent ?? terms.rent_m2 ?? 0) + outdoor * (rates.terrace ?? terms.terrace_rent_m2 ?? 0);
  return { indoor, outdoor, area: indoor + outdoor, rent };
}
// Monthly service charge given the month's (increased) rent before any rent-free discount.
function serviceMonthly(terms, units, rentThisMonth) {
  if (terms.service_mode === 'pct') return (Number(rentThisMonth) || 0) * (Number(terms.service_pct) || 0) / 100;
  return units.reduce((t, u) => t + (u.indoor_m2 || 0), 0) * (Number(terms.service_m2) || 0);
}

module.exports = { SCHEMA, ensure, steps, pctFor, factor, describe, hasGuarantee, baseMonthly, serviceMonthly };
