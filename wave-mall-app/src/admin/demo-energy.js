'use strict';

// Sample energy and ESG data: five landlord electricity meters (cooling, lighting, lifts, the car
// park, pumps) with hourly readings from the start of the same month last year up to the last full
// hour, shaped by the season, the opening hours and the weekend; utility-bill figures for the months
// before the meters were connected; monthly water, diesel and waste; and this year's targets.
// Everything is marked demo = 1. Needs the energy module (opts.h.energy); skipped otherwise.

const M = require('./model');
const C = require('./revenue/calc');
const { cairo } = require('./ops-common');

const METERS = [
  ['E-LL-HVAC', 'Chillers and air handling units', 'hvac'],
  ['E-LL-LGT', 'Common-area lighting', 'lighting'],
  ['E-LL-VT', 'Lifts and escalators', 'lifts'],
  ['E-LL-PRK', 'Car park B1 and B2 lighting and fans', 'parking'],
  ['E-LL-PMP', 'Pumps, fountains and services', 'pumps'],
];
// how hard the cooling works, January to December
const SEASON = [0.55, 0.58, 0.7, 0.85, 1.05, 1.25, 1.4, 1.42, 1.25, 1.0, 0.75, 0.6];

const rnd = (seed) => {
  let x = seed % 2147483647 || 7;
  return () => ((x = (x * 48271) % 2147483647) / 2147483647);
};
const pad = (n) => String(n).padStart(2, '0');

// kW drawn by a system in an hour (Cairo local), before the noise
function load(system, hr, wd, s) {
  const weekend = wd === 5 || wd === 6; // Friday and Saturday
  const open = hr >= 10 || (weekend && hr === 0);
  switch (system) {
    case 'hvac':
      if (hr < 6) return 8 + 4 * s;
      if (hr < 10) return 20 + 25 * s;
      if (hr === 23 && !weekend) return 25 * s + 12;
      return (35 + 55 * s) * (1 + 0.18 * Math.max(0, Math.sin(((hr - 11) / 9) * Math.PI))) * (weekend ? 1.08 : 1);
    case 'lighting':
      if (!open && hr < 6) return 6;
      if (hr < 10) return 14;
      return hr < 17 ? 30 : 44;
    case 'lifts':
      if (!open && hr < 8) return 1.5;
      if (hr < 10) return 5;
      return weekend ? 14 : 11;
    case 'parking':
      if (!open) return 6;
      return hr >= 18 ? 15 : 12;
    default:
      return (hr >= 6 && hr <= 22 ? 5.5 : 3) + (hr >= 19 && hr <= 22 ? 4 : 0);
  }
}

function load_(db, admin, opts = {}) {
  const h = opts.h;
  if (!h || !h.energy) return;
  if (db.value('SELECT COUNT(*) FROM nrg_meters WHERE demo = 1')) return;
  const c = cairo();
  const thisMonth = c.date.slice(0, 7);
  const start = C.ymAdd(thisMonth, -12); // hourly readings from here
  const firstBill = `${Number(thisMonth.slice(0, 4)) - 1}-01`; // bill figures from here
  const lastMonth = C.ymAdd(thisMonth, -1);
  const opening = (db.get("SELECT MIN(start_date) d FROM leases WHERE demo = 1 AND status = 'active'") || {}).d || `${thisMonth}-01`;
  const r = rnd(20261104);
  const now = M.now();

  db.tx(() => {
    const ids = {};
    METERS.forEach(([code, name, system], i) => {
      if (db.get('SELECT id FROM nrg_meters WHERE code = ?', code)) return;
      ids[code] = [Number(db.run('INSERT INTO nrg_meters (code, name, utility, system, sort, demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', code, name, 'electricity', system, i + 1, now).lastInsertRowid), system];
    });
    // hourly readings, inserted in batches
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      db.run(`INSERT INTO nrg_readings (meter_id, ts, value, source, demo, updated_at) VALUES ${batch.map(() => "(?, ?, ?, 'api', 1, ?)").join(',')} ON CONFLICT(meter_id, ts) DO NOTHING`, ...batch.flat());
      batch = [];
    };
    const endTs = `${c.date}T${pad(c.hour)}:00`;
    for (let d = `${start}-01`; d <= c.date; d = M.addDays(d, 1)) {
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      const s = SEASON[Number(d.slice(5, 7)) - 1];
      const pre = d < opening;
      // one hot weekend last month the cooling was left running overnight
      const leftOn = d.slice(0, 7) === lastMonth && (wd === 5 || wd === 6) && Number(d.slice(8, 10)) >= 15 && Number(d.slice(8, 10)) <= 23;
      for (let hr = 0; hr < 24; hr++) {
        const ts = `${d}T${pad(hr)}:00`;
        if (ts >= endTs) break;
        for (const [id, system] of Object.values(ids)) {
          let kw = load(system, hr, wd, s) * (0.94 + r() * 0.12);
          if (pre) kw *= system === 'lifts' ? 0.4 : 0.7;
          if (leftOn && system === 'hvac' && hr < 6) kw *= 3.2;
          batch.push([id, ts, Math.round(kw * 100) / 100, now]);
          if (batch.length >= 150) flush();
        }
      }
    }
    flush();

    // monthly figures: bills before the meters were connected, water, diesel and waste
    const entry = (period, kind, quantity, note = null) => db.run(
      'INSERT INTO nrg_entries (period, kind, quantity, note, user_id, demo, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(period, kind) DO NOTHING',
      period, kind, Math.round(quantity * 10) / 10, note, admin ? admin.id : null, now,
    );
    for (const ym of C.ymRange(firstBill, lastMonth)) {
      const s = SEASON[Number(ym.slice(5, 7)) - 1];
      const pre = `${ym}-28` < opening;
      const days = C.daysIn(ym);
      if (ym < start) entry(ym, 'electricity', (1150 * s + 1450) * days * (pre ? 0.7 : 1) * (0.97 + r() * 0.06), 'From the electricity bill');
      entry(ym, 'water', (900 + 700 * s) * (pre ? 0.6 : 1) * (0.95 + r() * 0.1));
      entry(ym, 'diesel', ym.slice(5, 7) === '07' ? 1800 : 300 + r() * 200, ym.slice(5, 7) === '07' ? 'Grid outage on two evenings' : 'Monthly generator test runs');
      const general = pre ? 5 + r() * 2 : 38 + r() * 8;
      const share = pre ? 0.12 : Math.min(0.34, 0.2 + 0.015 * C.ymDiff(C.ymOf(opening), ym));
      entry(ym, 'waste_general', general);
      entry(ym, 'waste_recycled', (general * share) / (1 - share));
    }
    db.run("INSERT INTO nrg_imports (via, rows, inserted, updated, unchanged, skipped, first_ts, last_ts, demo, created_at) VALUES ('api', ?, ?, 0, 0, 0, ?, ?, 1, ?)",
      METERS.length, METERS.length, `${M.addDays(c.date, c.hour ? 0 : -1)}T${pad((c.hour + 23) % 24)}:00`, `${M.addDays(c.date, c.hour ? 0 : -1)}T${pad((c.hour + 23) % 24)}:00`, new Date(Date.now() - 40 * 60000).toISOString());
  });

  // this year's targets, set against the pace so far: electricity and emissions on track, water and recycling not
  const year = Number(thisMonth.slice(0, 4));
  const e = h.energy.esg(year, { compare: false });
  const pace = (v) => (e.targets.length || !e.months.length ? null : v / Math.max(0.05, (Date.parse(`${c.date}T12:00:00Z`) - Date.parse(`${year}-01-01T00:00:00Z`)) / (365 * 86400000)));
  const set = (metric, v) => v && db.run('INSERT INTO nrg_targets (year, metric, target, demo, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(year, metric) DO NOTHING', year, metric, v, now);
  set('electricity', pace(e.t.electricity) && Math.round((pace(e.t.electricity) * 1.04) / 1000) * 1000);
  set('co2', pace(e.t.co2) && Math.round(pace(e.t.co2) * 1.05));
  set('water', pace(e.t.water) && Math.round((pace(e.t.water) * 0.93) / 100) * 100);
  set('recycling', 30);
}

function clear(db) {
  if (!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nrg_meters'")) return;
  db.tx(() => {
    db.run('DELETE FROM nrg_readings WHERE demo = 1 OR meter_id IN (SELECT id FROM nrg_meters WHERE demo = 1)');
    db.run('DELETE FROM nrg_meters WHERE demo = 1');
    db.run('DELETE FROM nrg_entries WHERE demo = 1');
    db.run('DELETE FROM nrg_targets WHERE demo = 1');
    db.run('DELETE FROM nrg_imports WHERE demo = 1');
  });
}

module.exports = { load: load_, clear };
