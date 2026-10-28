'use strict';

// Sample data for the revenue modules: turnover clauses on the sample leases and the sales each
// store reported since it opened, this year's service charge budget and costs, and the meters
// with their readings (fit-out, then trading; one spike held for review, one meter that rolled
// over) and a first month of utility invoices. Everything is dated from today and marked demo = 1.
// Needs the office running (opts.h with the revenue module); skipped otherwise.

const M = require('./model');
const C = require('./revenue/calc');

// turnover clause, and the sales profile: occupancy cost target (base rent ÷ sales), returns, average ticket
const PROFILE = {
  'Maison Lune': { pct: 10, type: 'natural', ocr: 0.09, returns: 0.045, ticket: 2600 },
  'Kahwa House': { pct: 12, type: 'natural', ocr: 0.105, returns: 0.004, ticket: 310 },
  'Lumière Beauty': { pct: 8, type: 'natural', ocr: 0.11, returns: 0.02, ticket: 720 },
  'Saffron Table': { pct: 10, type: 'fixed', ocr: 0.185, returns: 0.003, ticket: 950 },
};
const SEASON = [0.86, 0.84, 0.95, 1.08, 0.93, 0.9, 0.97, 1.02, 0.96, 1.0, 1.06, 1.24]; // Ramadan / Eid and December lift
// kWh per m² a month: fit-out, then trading
const KWH = { fashion: 46, fnb: 112, beauty: 38, other: 40 };

// the year's budget: amount, recoverable from tenants
const BUDGET = {
  security: [1560000, 1], cleaning: [1020000, 1], maintenance: [540000, 1], mep: [960000, 1], utilities: [1140000, 1],
  landscaping: [300000, 1], insurance: [264000, 1], marketing: [480000, 1], staff: [720000, 1], admin: [180000, 1], other: [120000, 0],
};
// the suppliers' invoice prefixes (the description of each cost is the supplier's invoice number)
const SUPPLIERS = { security: 'NG', cleaning: 'CP', maintenance: 'FF', mep: 'DM', landscaping: 'GO', insurance: 'MI', marketing: 'WE', staff: 'PR', admin: 'OF', other: 'OW' };

// a steady pseudo-random series, so the sample looks the same each time it loads
const rnd = (seed) => {
  let x = seed % 2147483647 || 7;
  return () => ((x = (x * 48271) % 2147483647) / 2147483647);
};

function load(db, admin, opts = {}) {
  const h = opts.h;
  if (!h || !h.revenue) return;
  if (db.value('SELECT COUNT(*) FROM turnover_terms WHERE demo = 1') || db.value('SELECT COUNT(*) FROM utl_meters WHERE demo = 1')) return;
  const { turnover: T, service: S, utilities: U } = h.revenue;
  const today = M.today();
  const thisMonth = C.ymOf(today);
  const LM = C.ymAdd(thisMonth, -1);
  const year = Number(today.slice(0, 4));
  const r = rnd(20261028);
  const leases = db.all("SELECT s.*, b.name brand_name, b.category FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.demo = 1 AND s.status = 'active'")
    .map((s) => ({ ...s, units: M.leaseUnits(db, s.id) }))
    .filter((s) => PROFILE[s.brand_name]);

  db.tx(() => {
    // ---------- turnover clauses and sales ----------
    for (const s of leases) {
      const p = PROFILE[s.brand_name];
      const nominal = C.monthlyRent(s, s.units).rent; // the base rent of a full month, before any rent-free period
      const fullSales = nominal / p.ocr;
      const bp = p.type === 'fixed' ? Math.round((12 * fullSales * 0.92) / 100000) * 100000 : 0;
      db.run('INSERT INTO turnover_terms (lease_id, pct, breakpoint_type, breakpoint, frequency, due_day, annual_recon, audit_rights, notes, demo, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 1, ?)',
        s.id, p.pct, p.type, bp, 'monthly', 10, p.type === 'fixed' ? 'Breakpoint agreed at signing for the first lease year.' : null, M.now());
      const months = T.expectedMonths(s);
      months.forEach((ym, i) => {
        const cover = T.tradeCover(s, ym);
        const gross = Math.round((fullSales * cover * SEASON[Number(ym.slice(5, 7)) - 1] * (0.94 + r() * 0.12)) / (1 - p.returns) / 10) * 10;
        const returns = Math.round((gross * p.returns * (0.7 + r() * 0.6)) / 10) * 10;
        const last = i === months.length - 1;
        const sale = T.saveSales(s, ym, { gross, returns, transactions: Math.round((gross - returns) / p.ticket), demo: 1 }, { via: last && s.brand_name === 'Kahwa House' ? 'portal' : 'staff', by: last && s.brand_name === 'Kahwa House' ? 'Omar Sabry' : admin ? admin.name : null });
        if (!last) db.run("UPDATE tenant_sales SET status = 'verified', verified_by = ?, verified_at = ? WHERE id = ?", admin ? admin.id : null, M.now(), sale.id);
      });
      // every month but the latest is billed (nothing due below the breakpoint is recorded too)
      for (const ym of months.slice(0, -1)) T.bill(s, ym, admin, { demo: 1 });
    }

    // ---------- service charge: this year's budget and costs (unless the team has its own) ----------
    const ownBudget = !!S.budgetOf(year);
    if (!ownBudget) {
      S.saveLines(year, Object.entries(BUDGET).map(([category, [amount, recoverable]]) => ({ category, amount, recoverable })), { mgmt_fee_pct: 10, notes: 'Opening-year budget: centre fully staffed from July.' });
      db.run("UPDATE sc_budgets SET status = 'approved', approved_by = ?, approved_at = ?, demo = 1 WHERE year = ?", admin ? admin.id : null, `${year}-01-08T09:00:00.000Z`, year);
    }
    const opening = leases.length ? leases.map((s) => C.ymOf(s.start_date)).sort()[0] : thisMonth;
    for (const ym of ownBudget ? [] : C.ymRange(`${year}-01`, LM)) {
      const open = ym >= opening;
      for (const [cat, [amount]] of Object.entries(BUDGET)) {
        if (cat === 'utilities') continue; // from the common-area meters
        let k = 1;
        if (!open && ['cleaning', 'maintenance', 'mep', 'landscaping'].includes(cat)) k = 0.55;
        if (cat === 'marketing') k = open ? 1.6 : 0.45; // the opening campaign
        if (cat === 'staff' && !open) k = 0.7;
        const amt = Math.round((amount / 12) * k * (0.93 + r() * 0.16) / 100) * 100;
        S.addActual({ year, period: ym, category: cat, amount: amt, description: `${SUPPLIERS[cat]}-${year}-${String(Number(ym.slice(5, 7)) * 7 + Math.floor(r() * 6)).padStart(3, '0')}`, source: 'manual', user: admin, demo: 1 });
      }
    }
    // F&B kitchens weigh more in the shared costs
    for (const s of leases.filter((x) => x.category === 'fnb')) {
      for (const u of s.units) db.run('INSERT INTO sc_unit_rules (year, unit_id, weight, excluded, cap, note) VALUES (?, ?, 1.2, 0, NULL, ?) ON CONFLICT(year, unit_id) DO NOTHING', year, u.id, 'F&B: kitchen extract and grease traps');
    }

    // ---------- utilities: meters and readings ----------
    // a code the team already uses is left to them (no sample meter under it)
    const meter = (code, utility, unitId, area, digits = 6, mult = 1) => (db.get('SELECT id FROM utl_meters WHERE code = ?', code) ? null : Number(db.run(
      'INSERT INTO utl_meters (code, utility, unit_id, area, serial, multiplier, digits, installed_on, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
      code, utility, unitId, area, String(24100000 + Math.floor(r() * 899999)), mult, digits, `${year - 1}-11-20`, M.now(),
    ).lastInsertRowid));
    const read = (id, ym, v) => U.saveReading(U.meterOf(id), ym, Math.round(v * 100) / 100, { user: admin, readOn: `${ym}-${String(C.daysIn(ym)).padStart(2, '0')}`, demo: 1 });
    // common areas, from December last year (so January has a consumption); the lighting meter rolls over in spring
    const common = [
      [meter('E-100', 'electricity', null, 'Plaza and mall lighting'), 'electricity', 978200, 26000, 1000000],
      [meter('C-100', 'chilled', null, 'Common-area cooling'), 'chilled', 41200, 2900, 1000000],
      [meter('W-100', 'water', null, 'Landscape irrigation'), 'water', 8800, 610, 1000000],
    ];
    const SUMMER = [0.7, 0.72, 0.85, 1.0, 1.2, 1.38, 1.5, 1.52, 1.35, 1.1, 0.85, 0.75];
    for (const [id, utility, start, monthly, max] of common) {
      if (!id) continue;
      let v = start;
      read(id, `${year - 1}-12`, v);
      for (const ym of C.ymRange(`${year}-01`, LM)) {
        const k = utility === 'electricity' ? (ym >= opening ? 1.15 : 0.8) : SUMMER[Number(ym.slice(5, 7)) - 1];
        v = (v + monthly * k * (0.95 + r() * 0.1)) % max;
        const rd = read(id, ym, v);
        if (rd && /rollover/.test(rd.flag || '')) {
          db.run('UPDATE utl_readings SET accepted = 1, note = ? WHERE id = ?', 'Checked on site: the dial passed 999,999.', rd.id);
          U.compute(U.meterOf(id), ym);
        }
      }
    }
    // tenant units: an opening reading the month the lease started; fit-out use, then trading use
    for (const s of leases) {
      for (const u of s.units) {
        const kinds = [['electricity', `E-${u.code}`]];
        if (s.category === 'fnb') kinds.push(['chilled', `C-${u.code}`]);
        for (const [utility, code] of kinds) {
          const id = meter(code, utility, u.id, null, 6, utility === 'electricity' && u.indoor_m2 > 250 ? 10 : 1);
          if (!id) continue;
          const m = U.meterOf(id);
          let v = 1000 + Math.floor(r() * 9000);
          const first = C.ymOf(s.start_date);
          if (first > LM) continue;
          read(id, first, v);
          for (const ym of C.ymRange(C.ymAdd(first, 1), LM)) {
            const trading = T.tradeCover(s, ym);
            const perM2 = utility === 'electricity' ? (KWH[s.category] || KWH.other) : 9;
            const use = u.indoor_m2 * (perM2 * trading + (utility === 'electricity' ? 5 : 1.2) * (1 - trading)) * (0.94 + r() * 0.12);
            v += use / m.multiplier;
            read(id, ym, v);
          }
        }
      }
    }
    // the months before last are billed; last month waits for the team (and any spike to be reviewed)
    const billFrom = leases.length ? C.ymAdd(leases.map((s) => C.ymOf(s.start_date)).sort()[0], 1) : LM;
    for (const ym of C.ymRange(billFrom, C.ymAdd(LM, -1))) U.bill(ym, admin, { demo: 1 });
  });
}

function clear(db) {
  if (!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turnover_terms'")) return;
  db.tx(() => {
    const leaseIds = 'SELECT id FROM leases WHERE demo = 1';
    db.run(`DELETE FROM revenue_credit_uses WHERE credit_id IN (SELECT id FROM revenue_credits WHERE demo = 1 OR lease_id IN (${leaseIds}))`);
    db.run(`DELETE FROM revenue_credits WHERE demo = 1 OR lease_id IN (${leaseIds})`);
    db.run(`DELETE FROM turnover_bills WHERE demo = 1 OR lease_id IN (${leaseIds})`);
    db.run(`DELETE FROM turnover_reminders WHERE demo = 1 OR lease_id IN (${leaseIds})`);
    db.run(`DELETE FROM tenant_sales WHERE demo = 1 OR lease_id IN (${leaseIds})`);
    db.run(`DELETE FROM turnover_terms WHERE demo = 1 OR lease_id IN (${leaseIds})`);
    db.run(`DELETE FROM sc_recons WHERE demo = 1 OR lease_id IN (${leaseIds})`);
    db.run('DELETE FROM sc_actuals WHERE demo = 1');
    db.run("DELETE FROM sc_actuals WHERE source = 'utilities' AND source_ref IN (SELECT 'meter:' || r.meter_id || ':' || r.period FROM utl_readings r JOIN utl_meters m ON m.id = r.meter_id WHERE m.demo = 1)");
    db.run("DELETE FROM sc_unit_rules WHERE note = 'F&B: kitchen extract and grease traps'");
    db.run('DELETE FROM sc_lines WHERE budget_id IN (SELECT id FROM sc_budgets WHERE demo = 1)');
    db.run('DELETE FROM sc_budgets WHERE demo = 1');
    db.run(`DELETE FROM utl_bills WHERE demo = 1 OR meter_id IN (SELECT id FROM utl_meters WHERE demo = 1) OR lease_id IN (${leaseIds})`);
    db.run('DELETE FROM utl_readings WHERE demo = 1 OR meter_id IN (SELECT id FROM utl_meters WHERE demo = 1)');
    db.run('DELETE FROM utl_meters WHERE demo = 1');
  });
}

module.exports = { load, clear };
