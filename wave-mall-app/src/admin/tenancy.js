'use strict';

// Tenant files: who trades (or is about to trade) in the mall, and how complete each tenant's file is.
// A tenant is a brand with a draft or active lease, or a deal reserved and waiting for signature.
// Its file is complete when every required document (M.TENANT_REQUIRED) is on record and in date,
// and each of its draft or active leases has a signed copy (a lease_contract document).

const M = require('./model');

// Every tenant, with what the directory and the dossier need.
function tenants(db, { warnDays = 30 } = {}) {
  const t = M.today();
  const brands = db.all(
    `SELECT b.* FROM brands b
     WHERE b.id IN (SELECT brand_id FROM leases WHERE status IN ('draft','active'))
        OR b.id IN (SELECT brand_id FROM leads WHERE stage = 'reserved' AND brand_id IS NOT NULL)
     ORDER BY b.name`,
  );
  return brands.map((b) => tenant(db, b, { warnDays, today: t }));
}

// One tenant's facts: leases, units, status, compliance, expiring documents, arrears.
function tenant(db, b, { warnDays = 30, today = M.today() } = {}) {
  const leases = db.all("SELECT * FROM leases WHERE brand_id = ? AND status IN ('draft','active') ORDER BY status = 'active' DESC, start_date", b.id)
    .map((s) => ({ ...s, units: M.leaseUnits(db, s.id) }));
  const lease = leases.find((s) => s.status === 'active') || leases[0] || null;
  let units = [...new Map(leases.flatMap((s) => s.units).map((u) => [u.id, u])).values()];
  // a reserved deal: the units held for it
  const deal = !leases.length ? db.get("SELECT * FROM leads WHERE brand_id = ? AND stage = 'reserved' ORDER BY updated_at DESC LIMIT 1", b.id) : null;
  if (deal) units = db.all("SELECT * FROM units WHERE hold_lead_id = ? AND status IN ('reserved','hold') ORDER BY sort", deal.id);
  const opening = b.opening_date || null;
  let status = 'signing';
  if (lease && lease.status === 'active') status = (opening && opening > today) || lease.start_date > today ? 'opening' : 'trading';
  const comp = compliance(db, b.id, leases, { warnDays, today });
  const arrears = leases.length
    ? db.value(`SELECT COALESCE(SUM(total - paid), 0) FROM invoices WHERE status IN ('open','partial') AND due_date < ? AND lease_id IN (${leases.map(() => '?').join(',')})`, today, ...leases.map((s) => s.id))
    : 0;
  return {
    ...b, leases, lease, deal, units, status, opening,
    area: units.reduce((s, u) => s + u.indoor_m2, 0),
    zones: [...new Set(units.map((u) => u.zone))],
    compliance: comp,
    arrears,
  };
}

// The checklist: one item per required document and per signed lease.
function compliance(db, brandId, leases, { warnDays = 30, today = M.today() } = {}) {
  const docs = db.all("SELECT id, kind, title, expires_on, created_at FROM documents WHERE entity = 'brand' AND entity_id = ? AND archived = 0 ORDER BY created_at DESC", brandId);
  const soon = M.addDays(today, warnDays);
  const state = (d) => (!d ? 'missing' : d.expires_on && d.expires_on < today ? 'expired' : d.expires_on && d.expires_on <= soon ? 'expiring' : 'ok');
  // the best document of a kind: one in date if any, else the latest
  const best = (list) => list.find((d) => !d.expires_on || d.expires_on >= today) || list[0] || null;
  const items = M.TENANT_REQUIRED.map((kind) => {
    const d = best(docs.filter((x) => x.kind === kind));
    return { key: kind, kind, doc: d, state: state(d) };
  });
  for (const s of leases) {
    const list = db.all("SELECT id, kind, title, expires_on, created_at FROM documents WHERE entity = 'lease' AND entity_id = ? AND kind = 'lease_contract' AND archived = 0 ORDER BY created_at DESC", s.id);
    const d = best(list);
    items.push({ key: `lease:${s.id}`, kind: 'lease_contract', lease: s, doc: d, state: state(d) });
  }
  const done = items.filter((i) => i.state === 'ok' || i.state === 'expiring').length;
  const expiring = docs.filter((d) => d.expires_on && d.expires_on >= today && d.expires_on <= soon).length;
  return {
    items,
    done,
    total: items.length,
    score: items.length ? done / items.length : 1,
    missing: items.filter((i) => i.state === 'missing').length,
    expired: items.filter((i) => i.state === 'expired').length,
    expiring,
  };
}

// For the brand and unit pages: is this brand a tenant (or was it)?
function isTenant(db, brandId) {
  return !!db.value("SELECT COUNT(*) FROM leases WHERE brand_id = ?", brandId) || !!db.value("SELECT COUNT(*) FROM leads WHERE brand_id = ? AND stage = 'reserved'", brandId);
}

module.exports = { tenants, tenant, compliance, isTenant };
