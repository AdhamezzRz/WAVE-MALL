'use strict';

// The arithmetic of the revenue modules, kept pure so it can be tested by hand:
// turnover (percentage) rent, base rent by month, service-charge apportionment with vacancy
// borne by the landlord, and utility meter consumption and cost.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

// ---------- periods: YYYY-MM (month), YYYY-Qn (quarter), YYYY (year) ----------
const ymOf = (iso) => String(iso).slice(0, 7);
const ymIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const ymFromIndex = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const ymAdd = (ym, n) => ymFromIndex(ymIndex(ym) + n);
const ymDiff = (a, b) => ymIndex(b) - ymIndex(a);
function ymRange(from, to) {
  const out = [];
  for (let i = ymIndex(from); i <= ymIndex(to); i++) out.push(ymFromIndex(i));
  return out;
}
const daysIn = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const quarterOf = (ym) => `${ym.slice(0, 4)}-Q${Math.floor((Number(ym.slice(5, 7)) - 1) / 3) + 1}`;
// The months of a billing period.
function periodMonths(period) {
  if (/^\d{4}-\d{2}$/.test(period)) return [period];
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) {
    const first = (Number(q[2]) - 1) * 3 + 1;
    return [0, 1, 2].map((k) => `${q[1]}-${String(first + k).padStart(2, '0')}`);
  }
  if (/^\d{4}$/.test(period)) return ymRange(`${period}-01`, `${period}-12`);
  return [];
}
const periodOf = (ym, frequency) => (frequency === 'quarterly' ? quarterOf(ym) : ym);
const isPeriod = (p) => periodMonths(p).length > 0;

// ---------- leases: base rent and service by month ----------
// Monthly rent at the lease's rates for its units (indoor + terrace), before escalation.
function monthlyRent(lease, units) {
  const indoor = units.reduce((s, u) => s + (u.indoor_m2 || 0), 0);
  const terrace = units.reduce((s, u) => s + (u.terrace_m2 || 0), 0);
  return { indoor, terrace, rent: indoor * (lease.rent_m2 || 0) + terrace * (lease.terrace_rent_m2 || 0), service: indoor * (lease.service_m2 || 0) };
}
// Share of a month the lease covers (first and last months pro rata by days).
function monthCover(lease, ym) {
  const s = String(lease.start_date).slice(0, 10);
  const e = String(lease.end_date).slice(0, 10);
  if (ym < ymOf(s) || ym > ymOf(e)) return 0;
  const d = daysIn(ym);
  const from = ym === ymOf(s) ? Number(s.slice(8, 10)) : 1;
  const to = ym === ymOf(e) ? Number(e.slice(8, 10)) : d;
  return Math.max(0, to - from + 1) / d;
}
// The base rent due for one month: escalated each lease year, nothing in rent-free months.
function baseRentMonth(lease, units, ym) {
  const cover = monthCover(lease, ym);
  if (!cover) return 0;
  const k = ymDiff(ymOf(lease.start_date), ym);
  if (k < (lease.rent_free_months || 0)) return 0;
  const factor = (1 + (lease.escalation_pct || 0) / 100) ** Math.floor(k / 12);
  return r2(monthlyRent(lease, units).rent * factor * cover);
}
function serviceMonth(lease, units, ym) {
  return r2(monthlyRent(lease, units).service * monthCover(lease, ym));
}

// ---------- turnover (percentage) rent ----------
// natural breakpoint: the tenant pays pct of sales above the point where pct × sales equals base rent,
//   i.e. max(0, sales × pct − base);
// fixed breakpoint: pct of sales above an agreed amount for the period, i.e. max(0, (sales − breakpoint) × pct).
function pctRent({ sales, pct, base = 0, type = 'natural', breakpoint = 0 }) {
  const p = (Number(pct) || 0) / 100;
  if (!p || !(sales > 0)) return 0;
  return type === 'fixed' ? r2(Math.max(0, (sales - (breakpoint || 0)) * p)) : r2(Math.max(0, sales * p - (base || 0)));
}
// The breakpoint for a period of n months: natural = base ÷ pct; fixed = the yearly amount × n / 12.
function breakpointFor(terms, base, months) {
  if (terms.breakpoint_type === 'fixed') return r2((terms.breakpoint || 0) * months / 12);
  const p = (Number(terms.pct) || 0) / 100;
  return p ? r2(base / p) : 0;
}

// ---------- service charge apportionment ----------
// costs: the recoverable total to share. units: [{ id, area, weight = 1, excluded, cap, occupied }]
//   occupied: [{ lease_id, fraction }] — the share of the year each lease held the unit (sum ≤ 1).
// Each unit in the pool carries costs × its weighted area ÷ the pool's weighted area. The tenant
// pays its share for the time it held the unit, up to any cap; the landlord bears the rest
// (vacancy and capped excess). Excluded units (e.g. an anchor on a fixed contribution) are out of
// the pool. Tenant and landlord shares always add up to the costs.
function apportion(costs, units) {
  const pool = units.filter((u) => !u.excluded && (u.area || 0) > 0);
  const total = pool.reduce((s, u) => s + u.area * (u.weight ?? 1), 0);
  const out = { costs: r2(costs), units: [], leases: {}, landlord: 0, vacancy: 0, capped: 0 };
  if (!total || !(costs > 0)) {
    out.landlord = r2(costs);
    out.vacancy = r2(costs);
    return out;
  }
  let assigned = 0;
  pool.forEach((u, i) => {
    // the last unit takes the rounding remainder, so the shares add up exactly
    const share = i === pool.length - 1 ? r2(costs - assigned) : r2(costs * (u.area * (u.weight ?? 1)) / total);
    assigned = r2(assigned + share);
    const parts = (u.occupied || []).map((o) => ({ id: o.lease_id, amt: r2(share * Math.min(1, Math.max(0, o.fraction))) }));
    const held = r2(parts.reduce((s, p) => s + p.amt, 0));
    let excess = 0;
    if (u.cap !== null && u.cap !== undefined && held > u.cap) {
      // the cap: scale the unit's leases down to it; the last one takes the rounding remainder
      excess = r2(held - u.cap);
      let left = r2(u.cap);
      parts.forEach((p, k) => {
        p.amt = k === parts.length - 1 ? left : r2(p.amt * u.cap / held);
        left = r2(left - p.amt);
      });
    }
    const tenantPart = r2(parts.reduce((s, p) => s + p.amt, 0));
    for (const p of parts) out.leases[p.id] = r2((out.leases[p.id] || 0) + p.amt);
    const vacancy = r2(share - held);
    out.vacancy = r2(out.vacancy + vacancy);
    out.capped = r2(out.capped + excess);
    out.units.push({ id: u.id, share, tenant: tenantPart, vacancy, capped: excess, pct: (u.area * (u.weight ?? 1)) / total });
  });
  out.landlord = r2(out.vacancy + out.capped);
  return out;
}

// ---------- utilities ----------
// Consumption from the previous reading. A meter that rolled over (reading below the previous one,
// with the previous reading near the top of the dial) wraps around; any other drop needs review.
// abnormal: more than 2.5× or under 0.3× the average of up to three previous months.
function consumption({ previous, reading, digits = 6, multiplier = 1, history = [] }) {
  if (previous === null || previous === undefined) return { consumption: null, flag: 'first' };
  let raw = reading - previous;
  let flag = null;
  if (raw < 0) {
    const max = 10 ** digits;
    if (previous >= max * 0.8 && reading <= max * 0.2) {
      raw = max - previous + reading;
      flag = 'rollover';
    } else return { consumption: null, flag: 'negative' };
  }
  const c = r2(raw * (multiplier || 1));
  const last = history.filter((x) => x !== null && x !== undefined && x > 0).slice(-3);
  if (last.length) {
    const avg = last.reduce((s, x) => s + x, 0) / last.length;
    if (avg > 0 && (c > avg * 2.5 || c < avg * 0.3)) flag = flag ? `${flag},abnormal` : 'abnormal';
  }
  return { consumption: c, flag };
}
// Cost of a consumption at a tariff: a flat rate or tiers [{ upto, rate }] (upto null = the rest),
// plus a fixed monthly charge.
function tariffCost(units, tariff) {
  if (!tariff || units === null || units === undefined) return 0;
  let cost = 0;
  let tiers = null;
  try {
    tiers = tariff.tiers ? JSON.parse(tariff.tiers) : null;
  } catch {
    tiers = null;
  }
  if (Array.isArray(tiers) && tiers.length) {
    let left = units;
    let from = 0;
    for (const t of tiers) {
      const cap = t.upto === null || t.upto === undefined ? Infinity : Number(t.upto) - from;
      const take = Math.min(left, Math.max(0, cap));
      cost += take * Number(t.rate || 0);
      left -= take;
      from = t.upto === null || t.upto === undefined ? from : Number(t.upto);
      if (left <= 0) break;
    }
    if (left > 0) cost += left * Number(tiers[tiers.length - 1].rate || 0);
  } else cost = units * Number(tariff.rate || 0);
  return r2(cost + Number(tariff.fixed_monthly || 0));
}

module.exports = {
  r2, num, ymOf, ymIndex, ymAdd, ymDiff, ymRange, daysIn, quarterOf, periodMonths, periodOf, isPeriod,
  monthlyRent, monthCover, baseRentMonth, serviceMonth, pctRent, breakpointFor, apportion, consumption, tariffCost,
};
