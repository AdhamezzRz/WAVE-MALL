'use strict';

// Energy and ESG. The landlord's own meters (cooling, common-area lighting, lifts, the car park)
// send interval readings to /ingest/energy or arrive as CSV files; tenants' consumption comes from
// the utilities module (the meters billed to them). The dashboard shows a month: what it cost and
// per m² of GLA, when in the week the energy is used (an hour heat map), the peak demand, the night
// baseload and the same month a year before. The ESG page adds water, gas, diesel and waste entered
// by month, works out CO₂ with editable emission factors, tracks yearly targets and prints a report.
// Interval times are Cairo local time ("2026-11-04T14:00"), as the building systems report them.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const C = require('../revenue/calc');
const { cairo, parseCsv, docLang, docSwitch } = require('../ops-common');

const { t: tr, tx } = i18n;

const SCHEMA = `
  CREATE TABLE nrg_meters (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, utility TEXT NOT NULL DEFAULT 'electricity',
    system TEXT NOT NULL DEFAULT 'other', sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE nrg_readings (
    id INTEGER PRIMARY KEY, meter_id INTEGER NOT NULL REFERENCES nrg_meters(id) ON DELETE CASCADE, ts TEXT NOT NULL,
    value REAL NOT NULL, source TEXT NOT NULL DEFAULT 'api', demo INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    UNIQUE (meter_id, ts)
  );
  CREATE INDEX nrg_readings_ts ON nrg_readings(ts);
  CREATE TABLE nrg_entries (
    id INTEGER PRIMARY KEY, period TEXT NOT NULL, kind TEXT NOT NULL, quantity REAL NOT NULL, note TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    UNIQUE (period, kind)
  );
  CREATE TABLE nrg_targets (
    id INTEGER PRIMARY KEY, year INTEGER NOT NULL, metric TEXT NOT NULL, target REAL NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE (year, metric)
  );
  CREATE TABLE nrg_imports (
    id INTEGER PRIMARY KEY, via TEXT NOT NULL DEFAULT 'csv', file_name TEXT, rows INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0, first_ts TEXT, last_ts TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
`;

const UTILITIES = { electricity: 'nrg|Electricity', water: 'nrg|Water', gas: 'nrg|Gas' };
const UNITS = { electricity: 'nrg|kWh', water: 'nrg|m³', gas: 'nrg|m³' };
const SYSTEMS = {
  hvac: 'nrg|Cooling and ventilation', lighting: 'nrg|Lighting', lifts: 'nrg|Lifts and escalators', parking: 'nrg|Car park',
  pumps: 'nrg|Pumps and services', other: 'nrg|Other',
};
// figures entered by month (electricity, water and gas only where no meter sends readings)
const ENTRY_KINDS = {
  electricity: ['nrg|Electricity from the bill', 'nrg|kWh'], water: ['nrg|Water', 'nrg|m³'], gas: ['nrg|Natural gas', 'nrg|m³'],
  diesel: ['nrg|Diesel (generators)', 'nrg|litres'], waste_general: ['nrg|General waste', 'nrg|tonnes'], waste_recycled: ['nrg|Recycled waste', 'nrg|tonnes'],
};
const METRICS = {
  electricity: ['nrg|Landlord electricity', 'nrg|kWh', 'max'], water: ['nrg|Water', 'nrg|m³', 'max'],
  co2: ['nrg|Emissions (scopes 1 and 2)', 'nrg|t CO₂e', 'max'], recycling: ['nrg|Recycling rate', '%', 'min'],
};
const FACTORS = { grid: ['nrg_co2_factor', 0.47], diesel: ['nrg_diesel_factor', 2.68], gas: ['nrg_gas_factor', 2.02] };
const NIGHT = ['01', '02', '03', '04'];

const pad = (n) => String(n).padStart(2, '0');
const r1 = (x) => Math.round(x * 10) / 10;
const CAIRO_TS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

// A reading's time as Cairo local "YYYY-MM-DDTHH:MM". Times with a zone (Z, +02:00) are converted;
// times without one are taken as local. A date and a separate hour also work (CSV exports).
function localTs(time, hour) {
  let s = String(time ?? '').trim().replace(/\//g, '-');
  if (!s) return null;
  if (hour !== undefined && hour !== null && String(hour).trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const hm = String(hour).trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!hm) return null;
    s = `${s}T${pad(hm[1])}:${hm[2] || '00'}`;
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m || !validDate(m[1])) return null;
  const hh = Number(m[2] || 0);
  const mm = Number(m[3] || 0);
  if (hh > 23 || mm > 59) return null;
  if (m[4]) {
    const d = new Date(`${m[1]}T${pad(hh)}:${pad(mm)}:00${m[4].toUpperCase() === 'Z' ? 'Z' : m[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`);
    if (Number.isNaN(d.getTime())) return null;
    const p = Object.fromEntries(CAIRO_TS.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  return `${m[1]}T${pad(hh)}:${pad(mm)}`;
}
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Store readings: [{ meter (code), ts, value }]. The same meter and time again replaces the value,
// so sending or importing the same readings twice changes nothing.
function store(db, rows, { source = 'api', demo = 0 } = {}) {
  const out = { inserted: 0, updated: 0, unchanged: 0, rejected: [], first: null, last: null };
  const now = new Date().toISOString();
  const meters = new Map(db.all('SELECT id, code FROM nrg_meters').map((m) => [m.code.toUpperCase(), m.id]));
  db.tx(() => {
    rows.forEach((r, i) => {
      const id = meters.get(String(r.meter || '').trim().toUpperCase());
      const ts = r.ts;
      const v = r.value;
      if (!id) return out.rejected.push({ index: i, reason: 'unknown meter', meter: String(r.meter || '').slice(0, 40) });
      if (!ts) return out.rejected.push({ index: i, reason: 'bad time' });
      if (v === null || v === undefined || !Number.isFinite(v) || v < 0) return out.rejected.push({ index: i, reason: 'bad value' });
      const val = Math.round(v * 1000) / 1000;
      const old = db.get('SELECT id, value FROM nrg_readings WHERE meter_id = ? AND ts = ?', id, ts);
      if (!old) { db.run('INSERT INTO nrg_readings (meter_id, ts, value, source, demo, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, ts, val, source, demo, now); out.inserted++; } else if (Math.abs(old.value - val) < 0.0005) out.unchanged++;
      else { db.run('UPDATE nrg_readings SET value = ?, source = ?, updated_at = ? WHERE id = ?', val, source, now, old.id); out.updated++; }
      if (!out.first || ts < out.first) out.first = ts;
      if (!out.last || ts > out.last) out.last = ts;
    });
  });
  return out;
}

// CSV: long (meter, time, value) or wide (time, then one column per meter code).
function readCsv(db, text) {
  const { headers, rows } = parseCsv(text);
  const H = headers.map((x) => String(x || '').trim().toLowerCase());
  const find = (re) => H.findIndex((x) => re.test(x));
  const meterCol = find(/^(meter|meter code|meter_code|code|meter id|العداد|كود العداد)$/);
  const timeCol = find(/^(time|timestamp|date ?time|datetime|interval|interval start|start|period|الوقت|التاريخ والوقت)$/);
  const dateCol = find(/^(date|day|التاريخ)$/);
  const hourCol = find(/^(hour|hr|الساعة)$/);
  const valueCol = find(/^(value|kwh|consumption|usage|m3|m³|energy|reading|الاستهلاك|القيمة)$/);
  const out = [];
  const when = (row) => (timeCol >= 0 ? localTs(row[timeCol]) : dateCol >= 0 ? localTs(row[dateCol], hourCol >= 0 ? row[hourCol] : 0) : null);
  if (meterCol >= 0 && valueCol >= 0) {
    for (const row of rows) out.push({ meter: String(row[meterCol] || '').trim(), ts: when(row), value: num(row[valueCol]) });
    return { rows: out, wide: false, columns: [] };
  }
  const codes = new Set(db.all('SELECT code FROM nrg_meters').map((m) => m.code.toUpperCase()));
  const cols = headers.map((x, i) => [String(x || '').trim(), i]).filter(([x, i]) => i !== timeCol && i !== dateCol && i !== hourCol && codes.has(x.toUpperCase()));
  for (const row of rows) for (const [code, i] of cols) if (String(row[i] ?? '').trim() !== '') out.push({ meter: code, ts: when(row), value: num(row[i]) });
  return { rows: out, wide: true, columns: cols.map(([c]) => c) };
}

function ensure(db) {
  db.ensure('energy-1', SCHEMA);
}

module.exports = function energy(router, h) {
  const { db, ui, M } = h;
  const R = h.R;
  ensure(db);
  (h.auditTyped = h.auditTyped || []).push('SELECT code, name FROM nrg_meters', 'SELECT note FROM nrg_entries', 'SELECT file_name FROM nrg_imports');
  const env = (k) => String((h.env && h.env[k]) || '');
  const now = () => new Date().toISOString();
  const hasTable = (name) => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  const thisYm = () => cairo().date.slice(0, 7);
  const nowTs = () => { const c = cairo(); return `${c.date}T${pad(c.hour)}:59`; };
  const factor = (k) => { const v = Number(db.setting(FACTORS[k][0])); return Number.isFinite(v) && v > 0 ? v : FACTORS[k][1]; };
  const gla = () => db.value("SELECT COALESCE(SUM(indoor_m2), 0) FROM units WHERE status != 'retired'") || 0;
  const tabs = (on) => `<nav class="tabs">${[['/admin/energy', tr('nrg|Dashboard')], ['/admin/energy/esg', tr('nrg|ESG')], ['/admin/energy/meters', tr('nrg|Meters and import')]]
    .map(([href, l]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${ui.esc(l)}</a>`).join('')}</nav>`;
  const crumbs = (...rest) => [['/admin/energy', tr('nav|Energy')], ...rest];
  const unitOf = (u) => tr(UNITS[u] || 'nrg|kWh');
  const qty = (v, u) => `${ui.n0(v)} <small>${ui.esc(unitOf(u))}</small>`;
  const delta = (a, b, { good = 'down' } = {}) => {
    if (!b || a === null || a === undefined) return '';
    const d = (a - b) / b;
    const better = good === 'down' ? d <= 0 : d >= 0;
    return `<span class="${better ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}%</span>`;
  };
  const shortYm = (ym) => `${ui.monthName(Number(ym.slice(5, 7)))} ${ym.slice(2, 4)}`;
  const validYm = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));

  // ---------- the numbers ----------
  // [from, to) as local timestamps for a month; the current month runs to now, and the same month a
  // year before is cut at the same day and hour so the two compare fairly.
  function span(ym) {
    const from = `${ym}-01T00:00`;
    const full = `${C.ymAdd(ym, 1)}-01T00:00`;
    const cur = ym === thisYm();
    const to = cur ? nowTs() : full;
    const ly = (s) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;
    return { from, to, lyFrom: ly(from), lyTo: cur ? ly(to) : ly(full), partial: cur };
  }
  const sumWhere = (utility, from, to, meterId = null) => db.value(
    `SELECT COALESCE(SUM(r.value), 0) FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.utility = ? AND r.ts >= ? AND r.ts < ?${meterId ? ' AND m.id = ?' : ''}`,
    utility, from, to, ...(meterId ? [meterId] : []),
  ) || 0;
  // a month's total for a utility: the meters' readings, else the figure entered from the bill
  function monthTotals(utility, months) {
    if (!months.length) return [];
    const rows = db.all(
      'SELECT substr(r.ts, 1, 7) ym, SUM(r.value) v, COUNT(*) n FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.utility = ? AND r.ts >= ? AND r.ts < ? GROUP BY ym',
      utility, `${months[0]}-01T00:00`, `${C.ymAdd(months[months.length - 1], 1)}-01T00:00`,
    );
    const by = new Map(rows.map((r) => [r.ym, r]));
    const entries = new Map(db.all(`SELECT period, quantity FROM nrg_entries WHERE kind = ? AND period IN (${months.map(() => '?').join(',')})`, utility, ...months).map((e) => [e.period, e.quantity]));
    return months.map((ym) => {
      const r = by.get(ym);
      if (r && r.n) return { ym, value: r.v, source: 'meters' };
      if (entries.has(ym)) return { ym, value: entries.get(ym), source: 'entry' };
      return { ym, value: 0, source: null };
    });
  }
  const entryOf = (kind, months) => {
    const m = new Map(db.all(`SELECT period, quantity FROM nrg_entries WHERE kind = ? AND period IN (${months.map(() => '?').join(',') || "''"})`, kind, ...months).map((e) => [e.period, e.quantity]));
    return months.map((ym) => m.get(ym) || 0);
  };
  const tariffCost = (kwh, ym) => {
    const tf = h.revenue && h.revenue.utilities ? h.revenue.utilities.tariffFor('electricity', ym) : null;
    return tf ? C.tariffCost(kwh, tf) : kwh * (Number(db.setting('nrg_kwh_rate')) || 0);
  };
  const tenantElectricity = (months) => {
    if (!months.length || !hasTable('utl_readings')) return months.map(() => 0);
    const m = new Map(db.all(`SELECT r.period ym, COALESCE(SUM(r.consumption), 0) v FROM utl_readings r JOIN utl_meters mt ON mt.id = r.meter_id WHERE mt.utility = 'electricity' AND mt.unit_id IS NOT NULL AND r.consumption IS NOT NULL AND r.period IN (${months.map(() => '?').join(',')}) GROUP BY r.period`, ...months).map((r) => [r.ym, r.v]));
    return months.map((ym) => m.get(ym) || 0);
  };
  const visitors = (months) => {
    if (!months.length || !hasTable('footfall')) return months.map(() => 0);
    const m = new Map(db.all(`SELECT substr(ts_hour, 1, 7) ym, SUM(visitors_in) v FROM footfall WHERE substr(ts_hour, 1, 7) IN (${months.map(() => '?').join(',')}) GROUP BY ym`, ...months).map((r) => [r.ym, r.v]));
    return months.map((ym) => m.get(ym) || 0);
  };

  // one month of landlord electricity: totals, cost, peak, baseload, the heat map and each meter
  function month(ym) {
    const s = span(ym);
    const kwh = sumWhere('electricity', s.from, s.to);
    const fromBill = !kwh ? (db.get("SELECT quantity FROM nrg_entries WHERE kind = 'electricity' AND period = ?", ym) || {}).quantity || 0 : 0;
    const total = kwh || fromBill;
    const lyKwh = sumWhere('electricity', s.lyFrom, s.lyTo) || (s.partial ? 0 : (db.get("SELECT quantity FROM nrg_entries WHERE kind = 'electricity' AND period = ?", C.ymAdd(ym, -12)) || {}).quantity || 0);
    const hourly = `SELECT substr(r.ts, 1, 13) hr, SUM(r.value) k FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.utility = 'electricity' AND r.ts >= ? AND r.ts < ?`;
    const peak = db.get(`${hourly} GROUP BY hr ORDER BY k DESC LIMIT 1`, s.from, s.to);
    const base = db.value(`SELECT AVG(k) FROM (${hourly} AND substr(r.ts, 12, 2) IN (${NIGHT.map(() => '?').join(',')}) GROUP BY hr)`, s.from, s.to, ...NIGHT);
    const hours = db.value(`SELECT COUNT(*) FROM (${hourly} GROUP BY hr)`, s.from, s.to) || 0;
    const heat = db.all(
      `SELECT CAST(strftime('%w', substr(r.ts, 1, 10)) AS INTEGER) wd, CAST(substr(r.ts, 12, 2) AS INTEGER) hr, SUM(r.value) k, COUNT(DISTINCT substr(r.ts, 1, 10)) days
       FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.utility = 'electricity' AND r.ts >= ? AND r.ts < ? GROUP BY wd, hr`, s.from, s.to,
    );
    const daily = db.all(`SELECT substr(r.ts, 1, 10) d, SUM(r.value) k FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.utility = 'electricity' AND r.ts >= ? AND r.ts < ? GROUP BY d ORDER BY d`, s.from, s.to);
    const meters = db.all('SELECT * FROM nrg_meters WHERE active = 1 OR id IN (SELECT meter_id FROM nrg_readings WHERE ts >= ? AND ts < ?) ORDER BY utility, sort, code', s.from, s.to).map((m) => {
      const k = sumWhere(m.utility, s.from, s.to, m.id);
      const pk = db.value('SELECT MAX(k) FROM (SELECT substr(ts, 1, 13) hr, SUM(value) k FROM nrg_readings WHERE meter_id = ? AND ts >= ? AND ts < ? GROUP BY hr)', m.id, s.from, s.to);
      const bl = db.value(`SELECT AVG(k) FROM (SELECT substr(ts, 1, 13) hr, SUM(value) k FROM nrg_readings WHERE meter_id = ? AND ts >= ? AND ts < ? AND substr(ts, 12, 2) IN (${NIGHT.map(() => '?').join(',')}) GROUP BY hr)`, m.id, s.from, s.to, ...NIGHT);
      return { ...m, kwh: k, peak: pk || 0, base: bl || 0, ly: sumWhere(m.utility, s.lyFrom, s.lyTo, m.id) };
    });
    const cost = tariffCost(total, ym);
    const area = gla();
    const tenants = tenantElectricity([ym])[0];
    return {
      ym, span: s, kwh: total, fromBill: !kwh && !!fromBill, ly: lyKwh, cost, area, costM2: area ? cost / area : 0, kwhM2: area ? total / area : 0,
      peak: peak ? { kw: peak.k, at: peak.hr } : null, base: base || 0, avg: hours ? kwh / hours : 0, heat, daily, meters, tenants,
      co2: (total * factor('grid')) / 1000,
    };
  }

  // a year of ESG figures (to the current month for this year), and the same months a year before
  function esg(year, { compare = true } = {}) {
    const last = Math.min(Number(`${year}12`), Number(thisYm().replace('-', '')));
    const months = Number(`${year}01`) > last ? [] : C.ymRange(`${year}-01`, `${String(last).slice(0, 4)}-${String(last).slice(4)}`);
    const el = monthTotals('electricity', months);
    const wa = monthTotals('water', months);
    const ga = monthTotals('gas', months);
    const diesel = entryOf('diesel', months);
    const wg = entryOf('waste_general', months);
    const wr = entryOf('waste_recycled', months);
    const ten = tenantElectricity(months);
    const vis = visitors(months);
    const f = { grid: factor('grid'), diesel: factor('diesel'), gas: factor('gas') };
    const rows = months.map((ym, i) => {
      const s1 = (diesel[i] * f.diesel + ga[i].value * f.gas) / 1000;
      const s2 = (el[i].value * f.grid) / 1000;
      const s3 = (ten[i] * f.grid) / 1000;
      return {
        ym, electricity: el[i].value, elSource: el[i].source, water: wa[i].value, gas: ga[i].value, diesel: diesel[i], wasteG: wg[i], wasteR: wr[i],
        tenants: ten[i], visitors: vis[i], s1, s2, s3, co2: s1 + s2,
      };
    });
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const area = gla();
    const t = {
      electricity: sum('electricity'), water: sum('water'), gas: sum('gas'), diesel: sum('diesel'), wasteG: sum('wasteG'), wasteR: sum('wasteR'),
      tenants: sum('tenants'), visitors: sum('visitors'), s1: sum('s1'), s2: sum('s2'), s3: sum('s3'), co2: sum('co2'),
    };
    t.recycling = t.wasteG + t.wasteR ? t.wasteR / (t.wasteG + t.wasteR) : null;
    t.kwhM2 = area ? t.electricity / area : null;
    t.co2M2 = area ? (t.co2 * 1000) / area : null;
    t.kwhVisitor = t.visitors ? t.electricity / t.visitors : null;
    t.co2Visitor = t.visitors ? (t.co2 * 1e6) / t.visitors : null; // grams
    t.waterVisitor = t.visitors ? (t.water * 1000) / t.visitors : null; // litres
    const out = { year, months, rows, t, area, factors: f };
    if (compare && months.length) {
      const before = esg(year - 1, { compare: false });
      const same = before.rows.filter((r) => months.includes(`${year}${r.ym.slice(4)}`));
      const s = (k) => same.reduce((a, r) => a + (r[k] || 0), 0);
      out.ly = { electricity: s('electricity'), water: s('water'), co2: s('co2'), wasteG: s('wasteG'), wasteR: s('wasteR'), visitors: s('visitors') };
      out.ly.recycling = out.ly.wasteG + out.ly.wasteR ? out.ly.wasteR / (out.ly.wasteG + out.ly.wasteR) : null;
      out.ly.kwhM2 = area ? out.ly.electricity / area : null;
      out.ly.kwhVisitor = out.ly.visitors ? out.ly.electricity / out.ly.visitors : null;
    }
    // targets and how the year is going (pro rata for the year in progress)
    const tg = new Map(db.all('SELECT metric, target FROM nrg_targets WHERE year = ?', year).map((x) => [x.metric, x.target]));
    const c = cairo();
    const elapsed = year < Number(c.date.slice(0, 4)) ? 1 : year > Number(c.date.slice(0, 4)) ? 0 : (Date.parse(`${c.date}T12:00:00Z`) - Date.parse(`${year}-01-01T00:00:00Z`)) / (Date.parse(`${year + 1}-01-01T00:00:00Z`) - Date.parse(`${year}-01-01T00:00:00Z`));
    const actual = { electricity: t.electricity, water: t.water, co2: t.co2, recycling: t.recycling === null ? null : t.recycling * 100 };
    out.targets = Object.keys(METRICS).filter((k) => tg.has(k)).map((k) => {
      const target = tg.get(k);
      const [, , way] = METRICS[k];
      const a = actual[k];
      const expected = way === 'max' ? target * elapsed : target;
      const ok = a === null ? null : way === 'max' ? a <= expected * 1.0001 : a >= target;
      return { metric: k, target, actual: a, expected, ok, share: way === 'max' ? (target ? a / target : 0) : (target ? Math.min(1, (a || 0) / target) : 0), elapsed };
    });
    return out;
  }
  h.energy = { month, esg, monthTotals, store, readCsv, localTs };

  // ---------- pieces ----------
  function heatmap(m) {
    if (!m.heat.length) return ui.empty(tr('nrg|No readings for this month yet.'));
    const cell = new Map(m.heat.map((x) => [`${x.wd}:${x.hr}`, x.days ? x.k / x.days : 0]));
    const max = Math.max(1, ...cell.values());
    const days = ui.weekdays(); // Monday first
    const order = [1, 2, 3, 4, 5, 6, 0];
    const head = `<span></span>${Array.from({ length: 24 }, (_, hr) => `<b>${hr % 3 === 0 ? pad(hr) : ''}</b>`).join('')}`;
    const rows = order.map((wd, i) => `<span>${ui.esc(days[i])}</span>${Array.from({ length: 24 }, (_, hr) => {
      const v = cell.get(`${wd}:${hr}`);
      return v === undefined ? '<i class="is-none"></i>' : `<i style="--a:${(0.08 + 0.92 * (v / max)).toFixed(2)}" title="${ui.esc(`${days[i]} ${pad(hr)}:00 · ${ui.n0(v)} ${tr('nrg|kWh')}`)}"></i>`;
    }).join('')}`).join('');
    return `<div class="nrg-heat" dir="ltr">${head}${rows}</div><p class="nrg-heat__key"><span>${ui.esc(tr('nrg|Less'))}</span><i></i><span>${ui.esc(tr('nrg|More'))}</span><small>${ui.esc(tr('nrg|Average kWh in each hour of the week'))}</small></p>`;
  }
  const monthNav = (ym, base) => {
    const prev = C.ymAdd(ym, -1);
    const next = C.ymAdd(ym, 1);
    return `<div class="nrg-nav"><a class="btn btn--ghost btn--sm" href="${base}?m=${prev}">‹ ${ui.esc(ui.monthYear(prev))}</a><b>${ui.esc(ui.monthYear(ym))}</b>${next <= thisYm() ? `<a class="btn btn--ghost btn--sm" href="${base}?m=${next}">${ui.esc(ui.monthYear(next))} ›</a>` : '<span></span>'}</div>`;
  };
  const targetList = (e) => (e.targets.length ? `<ul class="nrg-targets">${e.targets.map((x) => {
    const [label, unit, way] = METRICS[x.metric];
    const fmt = (v) => (v === null || v === undefined ? '—' : x.metric === 'recycling' ? `${r1(v)}%` : x.metric === 'co2' ? ui.n0(r1(v)) : ui.n0(v));
    const tone = x.ok === null ? 'mute' : x.ok ? 'forest' : 'rose';
    const note = way === 'max'
      ? tr('nrg|{a} of {b} {unit} · {pct} of the year gone', { a: fmt(x.actual), b: fmt(x.target), unit: unit === '%' ? '' : tr(unit), pct: ui.pct(x.elapsed) })
      : tr('nrg|{a} against a target of at least {b}', { a: fmt(x.actual), b: fmt(x.target) });
    return `<li><div><b>${ui.esc(tr(label))}</b><span class="badge badge--${x.ok === null ? 'mute' : x.ok ? 'ok' : 'rose'}">${ui.esc(x.ok === null ? tr('nrg|No data') : x.ok ? tr('nrg|On track') : tr('nrg|Off track'))}</span></div>${ui.meter(Math.min(1, x.share), tone)}<small>${ui.esc(note)}</small></li>`;
  }).join('')}</ul>` : ui.empty(tr('nrg|No targets set for this year.')));

  // ---------- dashboard ----------
  router.get('/energy', (req, res) => {
    const ym = validYm(req.query.m) && req.query.m <= thisYm() ? req.query.m : thisYm();
    const m = month(ym);
    const anyData = db.value('SELECT COUNT(*) FROM nrg_readings') > 0 || db.value('SELECT COUNT(*) FROM nrg_entries') > 0;
    const months = C.ymRange(C.ymAdd(ym, -11), ym);
    const series = monthTotals('electricity', months);
    const before = monthTotals('electricity', months.map((x) => C.ymAdd(x, -12)));
    const bars = series.map((x, i) => ({ label: shortYm(x.ym), v: Math.round(x.value), ly: Math.round(before[i].value) }));
    const kpis = `<div class="kpis kpis--3">
      ${ui.kpi({ label: tr('nrg|Landlord electricity'), value: qty(m.kwh, 'electricity'), sub: m.ly ? `${delta(m.kwh, m.ly)} ${ui.esc(tr('nrg|vs the same period last year'))}` : ui.esc(m.fromBill ? tr('nrg|From the bill') : m.span.partial ? tr('nrg|Month to date') : '') })}
      ${ui.kpi({ label: tr('nrg|Cost'), value: ui.money(m.cost, { compact: true }), sub: ui.esc(tr('nrg|{amount} per m² of GLA', { amount: ui.money(m.costM2) })) })}
      ${ui.kpi({ label: tr('nrg|Peak demand'), value: m.peak ? `${ui.n0(m.peak.kw)} <small>${ui.esc(tr('nrg|kW'))}</small>` : '—', sub: m.peak ? ui.esc(`${ui.date(m.peak.at.slice(0, 10))} · ${m.peak.at.slice(11, 13)}:00`) : '' })}
      ${ui.kpi({ label: tr('nrg|Night baseload'), value: m.base ? `${ui.n0(m.base)} <small>${ui.esc(tr('nrg|kW'))}</small>` : '—', sub: m.avg ? ui.esc(tr('nrg|{pct} of the average load, 01:00–05:00', { pct: ui.pct(m.base / m.avg) })) : '' })}
      ${ui.kpi({ label: tr('nrg|Tenants (billed)'), value: qty(m.tenants, 'electricity'), sub: m.tenants + m.kwh ? ui.esc(tr('nrg|The landlord uses {pct} of the total', { pct: ui.pct(m.kwh / (m.tenants + m.kwh)) })) : '' })}
      ${ui.kpi({ label: tr('nrg|Carbon'), value: `${ui.n0(r1(m.co2))} <small>${ui.esc(tr('nrg|t CO₂e'))}</small>`, sub: ui.esc(tr('nrg|{n} kWh per m² of GLA', { n: r1(m.kwhM2) })) })}
    </div>`;
    const trendCard = ui.card(tr('nrg|Last 12 months'), ui.bars(bars, { key: 'v', label: 'label', compare: 'ly', fmtv: (v) => ui.n0(Math.round(v / 1000)), tone: 'amber' }) + `<ul class="legend legend--row"><li><i class="t-amber"></i><span>${ui.esc(tr('nrg|MWh'))}</span></li><li><i class="x-ghost"></i><span>${ui.esc(tr('nrg|A year before'))}</span></li></ul>`, { sub: ui.esc(tr('nrg|Landlord electricity, against the same month a year before')), cls: 'x-bars' });
    const dailyCard = m.daily.length ? ui.card(tr('nrg|Day by day'), ui.bars(m.daily.map((d) => ({ label: d.d.slice(8, 10), v: Math.round(d.k) })), { key: 'v', label: 'label', h: 140, fmtv: () => '', tone: 'sea' }), { cls: 'x-bars', sub: ui.esc(tr('nrg|kWh each day of {month}', { month: ui.monthYear(ym) })) }) : '';
    const total = m.meters.filter((x) => x.utility === 'electricity').reduce((s, x) => s + x.kwh, 0) || 1;
    const meterTable = ui.table([
      { label: tr('nrg|Meter'), render: (x) => `<b><bdi>${ui.esc(x.code)}</bdi></b><small class="sub" title="${ui.esc(tr(SYSTEMS[x.system] || SYSTEMS.other))}">${ui.esc(x.name)}</small>` },
      { label: tr('nrg|Use'), num: true, sort: (x) => x.kwh, render: (x) => qty(x.kwh, x.utility) },
      { label: tr('nrg|Share'), render: (x) => (x.utility === 'electricity' ? `${ui.meter(x.kwh / total, 'amber')}<small>${ui.pct(x.kwh / total)}</small>` : '—') },
      { label: tr('nrg|Peak'), num: true, render: (x) => (x.utility === 'electricity' && x.peak ? `${ui.n0(x.peak)} ${ui.esc(tr('nrg|kW'))}` : '—') },
      { label: tr('nrg|Night'), num: true, render: (x) => (x.utility === 'electricity' && x.base ? `${ui.n0(x.base)} ${ui.esc(tr('nrg|kW'))}` : '—') },
      { label: tr('nrg|vs last year'), num: true, render: (x) => delta(x.kwh, x.ly) || '—' },
    ], m.meters.filter((x) => x.kwh || x.active), { empty: ui.esc(tr('nrg|No meters yet.')) });
    const split = m.kwh + m.tenants ? ui.donut([
      { label: tr('nrg|Landlord (common areas)'), value: Math.round(m.kwh), tone: 'amber' },
      { label: tr('nrg|Tenants (billed)'), value: Math.round(m.tenants), tone: 'sea' },
    ], { label: ui.n0(Math.round((m.kwh + m.tenants) / 1000)) }) + `<p class="muted small">${ui.esc(tr('nrg|MWh. Tenants\' figure is what their meters were billed for {month}.', { month: ui.monthYear(ym) }))}</p>` : ui.empty(tr('nrg|No readings for this month yet.'));
    const e = esg(Number(ym.slice(0, 4)), { compare: false });
    const body = `${tabs('/admin/energy')}${monthNav(ym, '/admin/energy')}
${anyData ? '' : `<p class="alert alert--warn">${ui.esc(tr('nrg|No readings yet. Add the landlord meters, then import a CSV or connect the building system.'))} <a href="/admin/energy/meters">${ui.esc(tr('nrg|Meters and import'))}</a></p>`}
${kpis}
<div class="grid grid--2">${trendCard}${ui.card(tr('nrg|When the energy is used'), heatmap(m), { sub: ui.esc(tr('nrg|Each square is an hour of the week; darker means more. Cooling follows the afternoon heat, lighting the opening hours.')) })}</div>
<div class="grid grid--side">${ui.card(tr('nrg|By meter'), meterTable)}<div class="stack">${ui.card(tr('nrg|Landlord and tenants'), split)}${ui.card(tr('nrg|Targets for {year}', { year: ym.slice(0, 4) }), targetList(e), { action: `<a class="btn btn--ghost btn--sm" href="/admin/energy/esg?year=${ym.slice(0, 4)}">${ui.esc(tr('nrg|ESG'))}</a>` })}</div></div>
${dailyCard}`;
    h.page(req, res, { title: tr('nav|Energy'), crumbs: crumbs([null, ui.monthYear(ym)]), active: '/admin/energy', wide: true, body });
  });

  // ---------- meters, CSV import and the building system's connection ----------
  router.get('/energy/meters', (req, res) => {
    const csrf = req.session.csrf;
    const mgr = h.can(req, 'manager');
    const list = db.all('SELECT m.*, (SELECT MAX(ts) FROM nrg_readings r WHERE r.meter_id = m.id) last_ts, (SELECT COUNT(*) FROM nrg_readings r WHERE r.meter_id = m.id AND r.ts >= ?) recent FROM nrg_meters m ORDER BY m.active DESC, m.utility, m.sort, m.code', `${M.addDays(cairo().date, -30)}T00:00`);
    const table = ui.table([
      { label: tr('nrg|Meter'), render: (m) => `<b><bdi>${ui.esc(m.code)}</bdi></b><small class="sub">${ui.esc(m.name)}</small>` },
      { label: tr('nrg|Measures'), render: (m) => `${ui.esc(tr(UTILITIES[m.utility] || m.utility))} · ${ui.esc(tr(SYSTEMS[m.system] || SYSTEMS.other))}` },
      { label: tr('nrg|Last reading'), render: (m) => (m.last_ts ? `${ui.date(m.last_ts.slice(0, 10))} ${ui.esc(m.last_ts.slice(11, 16))}` : '—') },
      { label: tr('nrg|Readings, last 30 days'), num: true, render: (m) => ui.n0(m.recent) },
      { label: tr('nrg|Status'), render: (m) => (mgr ? ui.form(`/admin/energy/meters/${m.id}`, csrf, `<input type="hidden" name="active" value="${m.active ? 0 : 1}">${ui.btn(m.active ? tr('nrg|In use') : tr('nrg|Not in use'), { cls: `btn--xs ${m.active ? 'btn--ghost' : ''}` })}`, { cls: 'nrg-inline' }) : ui.esc(m.active ? tr('nrg|In use') : tr('nrg|Not in use'))) },
    ], list, { empty: ui.esc(tr('nrg|No meters yet.')) });
    const add = mgr ? ui.form('/admin/energy/meters', csrf, `<div class="fields">
      ${ui.input('code', tr('nrg|Meter code'), '', { required: true, placeholder: 'E-LL-HVAC', hint: tr('nrg|The code the building system sends') })}
      ${ui.input('name', tr('nrg|Name'), '', { required: true })}
      ${ui.select('utility', tr('nrg|Measures'), Object.entries(UTILITIES).map(([k, v]) => [k, tr(v)]), 'electricity')}
      ${ui.select('system', tr('nrg|System'), Object.entries(SYSTEMS).map(([k, v]) => [k, tr(v)]), 'hvac')}
    </div>${ui.btn(tr('nrg|Add the meter'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    const upload = `<form class="upload" data-upload="/admin/energy/import/file?via=file" novalidate>
      <label class="drop"><input type="file" name="file" accept=".csv,.txt,text/csv,text/plain">${ui.icon('upload')}<span data-drop-label>${ui.esc(tr('nrg|Drop a CSV file here, or click to choose'))}</span><small>${ui.esc(tr('nrg|Up to 8 MB'))}</small><i class="drop__bar" hidden><b></b></i></label>
      <p class="upload__msg" data-upload-msg hidden></p></form>`;
    const paste = ui.form('/admin/energy/import/text', csrf, `${ui.textarea('csv', tr('nrg|Or paste the rows'), '', { rows: 5, placeholder: 'meter,time,kwh\nE-LL-HVAC,2026-11-01 14:00,96.4' })}${ui.btn(tr('nrg|Import'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' });
    const f = h.listFilters(req, { cols: { date: 'i.created_at' }, dateLabel: tr('nrg|Import'), sort: { date: 'i.created_at' }, sorts: [['rows', 'sort|Most rows first', 'i.inserted + i.updated DESC']] });
    const past = db.all(`SELECT i.*, u.name user_name FROM nrg_imports i LEFT JOIN users u ON u.id = i.user_id ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''} ORDER BY ${f.order}, i.id DESC LIMIT ${f.active ? 300 : 12}`, ...f.args);
    const hist = ui.table([
      { label: tr('nrg|Import'), render: (i) => `<b>${ui.esc(i.via === 'api' ? tr('nrg|From the building system') : i.file_name || tr('nrg|Pasted rows'))}</b><small class="sub">${ui.esc(ui.rel(i.created_at))}${i.user_name ? ` · ${ui.esc(i.user_name)}` : ''}</small>` },
      { label: tr('nrg|Period'), render: (i) => (i.first_ts ? `${ui.date(i.first_ts.slice(0, 10))} – ${ui.date(i.last_ts.slice(0, 10))}` : '—') },
      { label: tr('nrg|New'), num: true, render: (i) => ui.n0(i.inserted) },
      { label: tr('nrg|Changed'), num: true, render: (i) => ui.n0(i.updated) },
      { label: tr('nrg|Already there'), num: true, render: (i) => ui.n0(i.unchanged) },
      { label: tr('nrg|Skipped'), num: true, render: (i) => ui.n0(i.skipped) },
    ], past, { empty: ui.esc(tr('nrg|Nothing imported yet.')) });
    const keyOn = !!env('ENERGY_API_KEY');
    const api = `<p class="muted">${ui.esc(tr('nrg|The building management system sends interval readings with the API key in the X-Api-Key header. Sending the same reading again changes nothing.'))}</p>
      <p><span class="badge badge--${keyOn ? 'ok' : 'amber'}">${ui.esc(keyOn ? tr('nrg|Connected') : tr('nrg|Not set up'))}</span> ${keyOn ? '' : `<small class="muted">${ui.esc(tr('nrg|Set ENERGY_API_KEY on the server, and ENERGY_HMAC_SECRET to also require signed requests.'))}</small>`}</p>
      <pre class="nrg-code" dir="ltr">POST /ingest/energy
X-Api-Key: …
X-Signature: sha256=…   (${ui.esc(tr('nrg|when ENERGY_HMAC_SECRET is set'))})

{ "readings": [
  { "meter": "E-LL-HVAC", "time": "2026-11-01T14:00", "kwh": 96.4 },
  { "meter": "W-LL-01", "time": "2026-11-01T14:00:00+02:00", "m3": 1.8 }
] }</pre>`;
    const body = `${tabs('/admin/energy/meters')}<div class="grid grid--side">
  <div class="stack">${ui.card(tr('nrg|Landlord meters'), table, { sub: ui.esc(tr('nrg|Meters on the common areas and central plant. Tenants\' meters are read and billed under Utilities.')) })}${ui.card(tr('nrg|Recent imports'), `${f.html}${hist}`)}</div>
  <div class="stack">${mgr ? ui.card(tr('nrg|Add a meter'), add) : ''}${ui.card(tr('nrg|Import readings'), `${upload}${paste}<p class="muted small">${ui.esc(tr('nrg|Columns: meter, time and kWh (or m³); or a time column and one column per meter code. Times are Cairo time unless they carry a zone.'))}</p>`)}${ui.card(tr('nrg|Building system connection'), api)}</div>
</div>`;
    h.page(req, res, { title: tr('nrg|Meters and import'), crumbs: crumbs([null, tr('nrg|Meters and import')]), active: '/admin/energy', wide: true, body });
  });
  router.post('/energy/meters', R('manager'), (req, res) => {
    const code = h.str(req.body.code, 30).toUpperCase().replace(/\s+/g, '-');
    const name = h.str(req.body.name, 120);
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code) || !name) return h.back(req, res, '/admin/energy/meters', 'error', tr('nrg|Give the meter a code (letters, digits and dashes) and a name.'));
    if (db.get('SELECT id FROM nrg_meters WHERE code = ?', code)) return h.back(req, res, '/admin/energy/meters', 'error', tr('nrg|A meter with this code already exists.'));
    const utility = UTILITIES[req.body.utility] ? req.body.utility : 'electricity';
    const system = SYSTEMS[req.body.system] ? req.body.system : 'other';
    const id = Number(db.run('INSERT INTO nrg_meters (code, name, utility, system, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)', code, name, utility, system, (db.value('SELECT MAX(sort) FROM nrg_meters') || 0) + 1, now()).lastInsertRowid);
    h.log(req, 'Added an energy meter', 'nrg_meter', id, code);
    h.back(req, res, '/admin/energy/meters', 'ok', tr('nrg|Meter added.'));
  });
  router.post('/energy/meters/:id', R('manager'), (req, res, next) => {
    const m = db.get('SELECT * FROM nrg_meters WHERE id = ?', h.int(req.params.id));
    if (!m) return next();
    db.run('UPDATE nrg_meters SET active = ? WHERE id = ?', req.body.active === '1' ? 1 : 0, m.id);
    h.back(req, res, '/admin/energy/meters', 'ok', tr('Saved.'));
  });
  const runImport = (req, text, fileName) => {
    const { rows } = readCsv(db, text);
    const r = store(db, rows, { source: 'csv' });
    db.run('INSERT INTO nrg_imports (via, file_name, rows, inserted, updated, unchanged, skipped, first_ts, last_ts, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'csv', fileName, rows.length, r.inserted, r.updated, r.unchanged, r.rejected.length, r.first, r.last, req.user.id, now());
    h.log(req, 'Imported energy readings', 'nrg_import', null, `${r.inserted} new · ${r.updated} changed · ${r.unchanged} unchanged · ${r.rejected.length} skipped`);
    return { ...r, rows: rows.length };
  };
  const MAX_CSV = 8 * 1024 * 1024;
  router.post('/energy/import/file', R('agent'), express.raw({ type: () => true, limit: MAX_CSV + 1024 }), (req, res) => {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!text.trim()) return res.status(422).json({ ok: false, error: tr('Choose a file to upload.') });
    if (/[\u0000-\u0008]/.test(text.slice(0, 2000))) return res.status(415).json({ ok: false, error: tr('nrg|That is not a CSV or text file.') });
    const r = runImport(req, text, h.str(decodeURIComponent(String(req.get('x-file-name') || '')), 160) || null);
    if (!r.rows) return res.status(422).json({ ok: false, error: tr('nrg|No row could be read. Check the columns and the meter codes.') });
    res.json({ ok: true, inserted: r.inserted, updated: r.updated, unchanged: r.unchanged, skipped: r.rejected.length, url: '/admin/energy/meters' });
  });
  router.post('/energy/import/text', R('agent'), (req, res) => {
    const text = String(req.body.csv || '');
    if (!text.trim()) return h.back(req, res, '/admin/energy/meters', 'error', tr('nrg|Paste some rows first.'));
    const r = runImport(req, text, null);
    if (!r.rows) return h.back(req, res, '/admin/energy/meters', 'error', tr('nrg|No row could be read. Check the columns and the meter codes.'));
    h.back(req, res, '/admin/energy/meters', r.rejected.length ? 'error' : 'ok', tr('nrg|Imported: {a} new readings, {b} changed, {c} already there, {d} skipped.', { a: r.inserted, b: r.updated, c: r.unchanged, d: r.rejected.length }));
  });

  // ---------- ESG ----------
  const yearOf = (q) => { const y = h.int(q); const cy = Number(cairo().date.slice(0, 4)); return y && y >= 2000 && y <= cy ? y : cy; };
  const co2 = (t) => `${ui.n0(r1(t))} <small>${ui.esc(tr('nrg|t CO₂e'))}</small>`;
  function esgTable(e) {
    const val = (v, d = 0) => (v ? (d ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 }) : ui.n0(v)) : '—');
    return `<div class="tablewrap"><table class="table nrg-esg"><thead><tr><th>${ui.esc(tr('nrg|Month'))}</th><th class="num">${ui.esc(tr('nrg|Electricity'))}<small>${ui.esc(tr('nrg|kWh'))}</small></th><th class="num">${ui.esc(tr('nrg|Water'))}<small>${ui.esc(tr('nrg|m³'))}</small></th><th class="num">${ui.esc(tr('nrg|Gas'))}<small>${ui.esc(tr('nrg|m³'))}</small></th><th class="num">${ui.esc(tr('nrg|Diesel'))}<small>${ui.esc(tr('nrg|litres'))}</small></th><th class="num">${ui.esc(tr('nrg|Waste'))}<small>${ui.esc(tr('nrg|tonnes'))}</small></th><th class="num">${ui.esc(tr('nrg|Recycled'))}<small>${ui.esc(tr('nrg|tonnes'))}</small></th><th class="num">${ui.esc(tr('nrg|CO₂e'))}<small>${ui.esc(tr('nrg|tonnes'))}</small></th></tr></thead>
      <tbody>${e.rows.map((r) => `<tr><td>${ui.esc(shortYm(r.ym))}</td><td class="num">${val(r.electricity)}${r.elSource === 'entry' ? ` <small class="muted" title="${ui.esc(tr('nrg|From the bill'))}">*</small>` : ''}</td><td class="num">${val(r.water)}</td><td class="num">${val(r.gas)}</td><td class="num">${val(r.diesel)}</td><td class="num">${val(r.wasteG, 1)}</td><td class="num">${val(r.wasteR, 1)}</td><td class="num">${val(r.co2, 1)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>${ui.esc(tr('nrg|Total'))}</td><td class="num">${val(e.t.electricity)}</td><td class="num">${val(e.t.water)}</td><td class="num">${val(e.t.gas)}</td><td class="num">${val(e.t.diesel)}</td><td class="num">${val(e.t.wasteG, 1)}</td><td class="num">${val(e.t.wasteR, 1)}</td><td class="num">${val(e.t.co2, 1)}</td></tr></tfoot></table></div>`;
  }
  router.get('/energy/esg', (req, res) => {
    const year = yearOf(req.query.year);
    const e = esg(year);
    const ly = e.ly || {};
    const csrf = req.session.csrf;
    const mgr = h.can(req, 'manager');
    const years = Array.from({ length: 4 }, (_, i) => Number(cairo().date.slice(0, 4)) - i);
    const yearNav = `<div class="nrg-nav">${years.map((y) => `<a class="btn btn--sm ${y === year ? 'btn--primary' : 'btn--ghost'}" href="/admin/energy/esg?year=${y}">${y}</a>`).join('')}<span class="nrg-grow"></span><a class="btn btn--ghost btn--sm" href="/admin/energy/esg/print?year=${year}" target="_blank" rel="noopener">${ui.icon('print')}<span>${ui.esc(tr('nrg|Print the ESG report'))}</span></a></div>`;
    const kpis = `<div class="kpis kpis--3">
      ${ui.kpi({ label: tr('nrg|Emissions (scopes 1 and 2)'), value: co2(e.t.co2), sub: ly.co2 ? `${delta(e.t.co2, ly.co2)} ${ui.esc(tr('nrg|vs the same months last year'))}` : '' })}
      ${ui.kpi({ label: tr('nrg|Landlord electricity'), value: qty(e.t.electricity, 'electricity'), sub: ly.electricity ? `${delta(e.t.electricity, ly.electricity)} ${ui.esc(tr('nrg|vs the same months last year'))}` : '' })}
      ${ui.kpi({ label: tr('nrg|Water'), value: qty(e.t.water, 'water'), sub: ly.water ? `${delta(e.t.water, ly.water)} ${ui.esc(tr('nrg|vs the same months last year'))}` : '' })}
      ${ui.kpi({ label: tr('nrg|Recycling rate'), value: e.t.recycling === null ? '—' : ui.pct(e.t.recycling), sub: ly.recycling ? `${delta(e.t.recycling, ly.recycling, { good: 'up' })} ${ui.esc(tr('nrg|vs the same months last year'))}` : '' })}
      ${ui.kpi({ label: tr('nrg|Energy intensity'), value: e.t.kwhM2 === null ? '—' : `${ui.n0(r1(e.t.kwhM2))} <small>${ui.esc(tr('nrg|kWh/m²'))}</small>`, sub: ly.kwhM2 ? `${delta(e.t.kwhM2, ly.kwhM2)} · ${ui.esc(tr('nrg|per m² of GLA'))}` : ui.esc(tr('nrg|per m² of GLA')) })}
      ${ui.kpi({ label: tr('nrg|Per visitor'), value: e.t.kwhVisitor === null ? '—' : `${ui.n0(r1(e.t.kwhVisitor * 1000))} <small>${ui.esc(tr('nrg|Wh'))}</small>`, sub: e.t.co2Visitor === null ? '' : ui.esc(tr('nrg|{n} g CO₂e per visitor', { n: ui.n0(e.t.co2Visitor) })) })}
    </div>`;
    const scopes = ui.donut([
      { label: tr('nrg|Scope 1 · fuel burnt on site'), value: Math.round(e.t.s1 * 10) / 10, tone: 'cocoa', display: ui.n0(r1(e.t.s1)) },
      { label: tr('nrg|Scope 2 · electricity bought'), value: Math.round(e.t.s2 * 10) / 10, tone: 'amber', display: ui.n0(r1(e.t.s2)) },
      { label: tr('nrg|Scope 3 · tenants\' electricity'), value: Math.round(e.t.s3 * 10) / 10, tone: 'sea', display: ui.n0(r1(e.t.s3)) },
    ], { label: ui.n0(Math.round(e.t.s1 + e.t.s2 + e.t.s3)) }) + `<p class="muted small">${ui.esc(tr('nrg|Tonnes of CO₂e. Grid electricity at {grid} kg per kWh, diesel at {diesel} kg per litre, gas at {gas} kg per m³.', { grid: e.factors.grid, diesel: e.factors.diesel, gas: e.factors.gas }))}</p>`;
    const kindOpts = Object.entries(ENTRY_KINDS).map(([k, [l, u]]) => [k, `${tr(l)} (${tr(u)})`]);
    const lastYm = C.ymAdd(thisYm(), -1);
    const entryForm = mgr ? ui.form('/admin/energy/entries', csrf, `<div class="fields">
      ${ui.input('period', tr('nrg|Month'), lastYm, { type: 'month', required: true })}
      ${ui.select('kind', tr('nrg|What'), kindOpts, 'diesel')}
      ${ui.input('quantity', tr('nrg|Quantity'), '', { type: 'number', step: 'any', min: 0, required: true })}
      ${ui.input('note', tr('nrg|Note'), '', { placeholder: tr('nrg|Bill or delivery note number') })}
    </div>${ui.btn(tr('nrg|Save the figure'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    const recent = db.all('SELECT e.*, u.name user_name FROM nrg_entries e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.updated_at DESC, e.id DESC LIMIT 8');
    const recentList = recent.length ? `<ul class="nrg-recent">${recent.map((x) => `<li><span class="what"><b>${ui.esc(tr(ENTRY_KINDS[x.kind] ? ENTRY_KINDS[x.kind][0] : x.kind))}</b><small>${ui.esc(ui.monthYear(x.period))}${x.note ? ` · ${ui.esc(x.note)}` : ''}</small></span><b>${ui.n0(x.quantity)} <small>${ui.esc(tr(ENTRY_KINDS[x.kind] ? ENTRY_KINDS[x.kind][1] : ''))}</small></b></li>`).join('')}</ul>` : '';
    const tg = new Map(db.all('SELECT metric, target FROM nrg_targets WHERE year = ?', year).map((x) => [x.metric, x.target]));
    const targetForm = mgr ? ui.form('/admin/energy/targets', csrf, `<input type="hidden" name="year" value="${year}"><div class="fields">${Object.entries(METRICS).map(([k, [l, u]]) => ui.input(`t_${k}`, `${tr(l)} (${u === '%' ? '%' : tr(u)})`, tg.has(k) ? String(tg.get(k)) : '', { type: 'number', step: 'any', min: 0 })).join('')}</div>${ui.btn(tr('nrg|Save the targets'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    const factorForm = mgr ? ui.form('/admin/energy/factors', csrf, `<div class="fields">
      ${ui.input('grid', tr('nrg|Grid electricity (kg CO₂e per kWh)'), String(e.factors.grid), { type: 'number', step: 'any', min: 0 })}
      ${ui.input('diesel', tr('nrg|Diesel (kg CO₂e per litre)'), String(e.factors.diesel), { type: 'number', step: 'any', min: 0 })}
      ${ui.input('gas', tr('nrg|Natural gas (kg CO₂e per m³)'), String(e.factors.gas), { type: 'number', step: 'any', min: 0 })}
    </div>${ui.btn(tr('Save'), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' }) : `<p class="muted">${ui.esc(tr('nrg|Grid electricity at {grid} kg per kWh, diesel at {diesel} kg per litre, gas at {gas} kg per m³.', { grid: e.factors.grid, diesel: e.factors.diesel, gas: e.factors.gas }))}</p>`;
    const body = `${tabs('/admin/energy/esg')}${yearNav}${kpis}
<div class="grid grid--side">
  <div class="stack">${ui.card(tr('nrg|Month by month'), e.rows.length ? `${esgTable(e)}<p class="muted small">${ui.esc(tr('nrg|* electricity from the bill, for months the meters did not send readings.'))}</p>` : ui.empty(tr('nrg|Nothing recorded for this year yet.')))}
  ${ui.card(tr('nrg|Targets for {year}', { year }), `${targetList(e)}${targetForm ? `<details class="nrg-more" id="targets"><summary>${ui.esc(tr('nrg|Set targets'))}</summary>${targetForm}</details>` : ''}`)}</div>
  <div class="stack">${ui.card(tr('nrg|Emissions by scope'), scopes)}
  ${mgr ? ui.card(tr('nrg|Record a monthly figure'), `${entryForm}${recentList}`, { sub: ui.esc(tr('nrg|Diesel, gas, water and waste from bills and delivery notes. Saving the same month again replaces it.')) }) : ''}
  ${ui.card(tr('nrg|Emission factors'), factorForm)}</div>
</div>`;
    h.page(req, res, { title: tr('nrg|ESG {year}', { year }), crumbs: crumbs([null, tr('nrg|ESG')]), active: '/admin/energy', wide: true, body });
  });
  router.post('/energy/entries', R('manager'), (req, res) => {
    const period = String(req.body.period || '');
    const kind = ENTRY_KINDS[req.body.kind] ? req.body.kind : null;
    const q = h.numv(req.body.quantity);
    if (!validYm(period) || !kind || q === null || q < 0) return h.back(req, res, '/admin/energy/esg', 'error', tr('nrg|Choose a month, what it is and a quantity.'));
    db.run('INSERT INTO nrg_entries (period, kind, quantity, note, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(period, kind) DO UPDATE SET quantity = excluded.quantity, note = excluded.note, user_id = excluded.user_id, updated_at = excluded.updated_at',
      period, kind, q, h.str(req.body.note, 200) || null, req.user.id, now());
    h.log(req, 'Recorded an ESG figure', 'nrg_entry', null, `${period} ${kind} ${q}`);
    h.back(req, res, `/admin/energy/esg?year=${period.slice(0, 4)}`, 'ok', tr('Saved.'));
  });
  router.post('/energy/targets', R('manager'), (req, res) => {
    const year = h.int(req.body.year);
    if (!year || year < 2000 || year > 2100) return h.back(req, res, '/admin/energy/esg', 'error', tr('nrg|Choose a year.'));
    db.tx(() => {
      for (const k of Object.keys(METRICS)) {
        const v = h.numv(req.body[`t_${k}`]);
        if (v === null || v <= 0) db.run('DELETE FROM nrg_targets WHERE year = ? AND metric = ?', year, k);
        else db.run('INSERT INTO nrg_targets (year, metric, target, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(year, metric) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at', year, k, v, now());
      }
    });
    h.log(req, 'Set the ESG targets', 'nrg_targets', null, String(year));
    h.back(req, res, `/admin/energy/esg?year=${year}`, 'ok', tr('Saved.'));
  });
  router.post('/energy/factors', R('manager'), (req, res) => {
    for (const k of Object.keys(FACTORS)) {
      const v = h.numv(req.body[k]);
      if (v !== null && v > 0 && v < 100) db.setSetting(FACTORS[k][0], String(v));
    }
    h.log(req, 'Changed the emission factors', 'setting', null, Object.keys(FACTORS).map((k) => `${k} ${factor(k)}`).join(' · '));
    h.back(req, res, '/admin/energy/esg', 'ok', tr('Saved.'));
  });

  // ---------- the yearly ESG report, printable in either language ----------
  router.get('/energy/esg/print', (req, res) => {
    const year = yearOf(req.query.year);
    const lang = docLang(req);
    const html = i18n.run(lang, () => {
      const s = db.settings();
      const e = esg(year);
      const ly = e.ly || {};
      const row = (label, v, unit, lyv, good = 'down') => `<tr><th>${ui.esc(label)}</th><td class="num">${v}${unit ? ` ${ui.esc(unit)}` : ''}</td><td class="num">${lyv === undefined || lyv === null ? '—' : delta(Number(String(v).replace(/[^\d.-]/g, '')) || 0, lyv, { good }) || '—'}</td></tr>`;
      const through = e.months.length ? ui.monthYear(e.months[e.months.length - 1]) : '—';
      const body = `<main class="doc nrg-doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="/admin/energy/esg?year=${year}">${tr('Back')}</a>${docSwitch(ui, '/admin/energy/esg/print', lang).replace('?doc=', `?year=${year}&doc=`)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${ui.esc(tr('nrg|Environmental report'))}</p><p class="doc__ref">${year} · ${ui.esc(tr('nrg|January to {month}', { month: through }))}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${ui.esc(tx(s.legal_name) || 'The Wave')}</p><h1>${ui.esc(tr('nrg|Energy, water, waste and carbon in {year}', { year }))}</h1><p class="muted">${ui.esc(tr('nrg|Common areas and central plant run by the landlord, with tenants\' metered electricity shown separately. Gross leasable area: {area}.', { area: ui.m2(e.area) }))}</p></section>
  <h2>${ui.esc(tr('nrg|Headline figures'))}</h2>
  <table class="doc__t"><thead><tr><th></th><th class="num">${year}</th><th class="num">${ui.esc(tr('nrg|vs the same months last year'))}</th></tr></thead><tbody>
    ${row(tr('nrg|Emissions (scopes 1 and 2)'), ui.n0(r1(e.t.co2)), tr('nrg|t CO₂e'), ly.co2)}
    ${row(tr('nrg|Landlord electricity'), ui.n0(e.t.electricity), tr('nrg|kWh'), ly.electricity)}
    ${row(tr('nrg|Water'), ui.n0(e.t.water), tr('nrg|m³'), ly.water)}
    ${row(tr('nrg|Recycling rate'), e.t.recycling === null ? '—' : ui.pct(e.t.recycling), '', ly.recycling ? ly.recycling * 100 : null, 'up')}
    ${row(tr('nrg|Energy intensity'), e.t.kwhM2 === null ? '—' : ui.n0(r1(e.t.kwhM2)), tr('nrg|kWh/m²'), ly.kwhM2)}
    ${row(tr('nrg|Electricity per visitor'), e.t.kwhVisitor === null ? '—' : ui.n0(r1(e.t.kwhVisitor * 1000)), tr('nrg|Wh'), ly.kwhVisitor ? ly.kwhVisitor * 1000 : null)}
    ${row(tr('nrg|Carbon per m² of GLA'), e.t.co2M2 === null ? '—' : ui.n0(r1(e.t.co2M2)), tr('nrg|kg CO₂e'), null)}
  </tbody></table>
  <h2>${ui.esc(tr('nrg|Emissions by scope'))}</h2>
  <table class="doc__t"><tbody>
    <tr><th>${ui.esc(tr('nrg|Scope 1 · fuel burnt on site'))}</th><td>${ui.esc(tr('nrg|Diesel {d} litres, gas {g} m³', { d: ui.n0(e.t.diesel), g: ui.n0(e.t.gas) }))}</td><td class="num">${ui.n0(r1(e.t.s1))} ${ui.esc(tr('nrg|t CO₂e'))}</td></tr>
    <tr><th>${ui.esc(tr('nrg|Scope 2 · electricity bought'))}</th><td>${ui.esc(tr('nrg|{n} kWh for the common areas', { n: ui.n0(e.t.electricity) }))}</td><td class="num">${ui.n0(r1(e.t.s2))} ${ui.esc(tr('nrg|t CO₂e'))}</td></tr>
    <tr><th>${ui.esc(tr('nrg|Scope 3 · tenants\' electricity'))}</th><td>${ui.esc(tr('nrg|{n} kWh billed to tenants', { n: ui.n0(e.t.tenants) }))}</td><td class="num">${ui.n0(r1(e.t.s3))} ${ui.esc(tr('nrg|t CO₂e'))}</td></tr>
  </tbody></table>
  <h2>${ui.esc(tr('nrg|Month by month'))}</h2>
  ${e.rows.length ? esgTable(e) : `<p>${ui.esc(tr('nrg|Nothing recorded for this year yet.'))}</p>`}
  ${e.targets.length ? `<h2>${ui.esc(tr('nrg|Targets for {year}', { year }))}</h2>${targetList(e)}` : ''}
  <h2>${ui.esc(tr('nrg|How the figures are worked out'))}</h2>
  <ul class="doc__small">
    <li>${ui.esc(tr('nrg|Electricity and water come from the landlord\'s interval meters; for months without readings, from the utility bill.'))}</li>
    <li>${ui.esc(tr('nrg|Grid electricity at {grid} kg per kWh, diesel at {diesel} kg per litre, gas at {gas} kg per m³.', { grid: e.factors.grid, diesel: e.factors.diesel, gas: e.factors.gas }))}</li>
    <li>${ui.esc(tr('nrg|Visitors are counted at the entrances; intensity uses the gross leasable area.'))}</li>
  </ul>
  <p class="doc__foot">${ui.esc(tx(s.legal_name))} · ${ui.esc(tx(s.address))}</p>
</main>`;
      return ui.bare({ title: tr('nrg|ESG {year}', { year }), body, cls: 'print' });
    });
    res.type('html').send(html);
  });

  // ---------- ingest: the building management system pushes interval readings ----------
  const ingestLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  h.public.post('/ingest/energy', ingestLimit, express.json({ limit: '4mb', verify: (req, res, buf) => { req.rawBody = buf; } }), (req, res) => {
    const key = env('ENERGY_API_KEY');
    if (!key) return res.status(503).json({ ok: false, error: 'Energy ingest is not configured (ENERGY_API_KEY).' });
    const sent = String(req.get('x-api-key') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '')).trim();
    if (!sent || !same(crypto.createHash('sha256').update(sent).digest('hex'), crypto.createHash('sha256').update(key).digest('hex'))) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const secret = env('ENERGY_HMAC_SECRET');
    if (secret) {
      const sig = String(req.get('x-signature') || '').replace(/^sha256=/i, '').trim().toLowerCase();
      const want = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
      if (!/^[0-9a-f]{64}$/.test(sig) || !same(sig, want)) return res.status(401).json({ ok: false, error: 'Bad signature' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const list = Array.isArray(body.readings) ? body.readings.slice(0, 50000) : [];
    if (!list.length) return res.status(422).json({ ok: false, error: 'Send a readings array: [{ meter, time, kwh | m3 | value }].' });
    const rows = list.map((r) => ({ meter: r && (r.meter ?? r.code ?? r.meter_code), ts: r ? localTs(r.time ?? r.ts ?? r.timestamp ?? r.start) : null, value: r ? num(r.value ?? r.kwh ?? r.m3 ?? r.consumption) : null }));
    const r = store(db, rows, { source: 'api' });
    db.run("INSERT INTO nrg_imports (via, rows, inserted, updated, unchanged, skipped, first_ts, last_ts, created_at) VALUES ('api', ?, ?, ?, ?, ?, ?, ?, ?)",
      rows.length, r.inserted, r.updated, r.unchanged, r.rejected.length, r.first, r.last, now());
    res.json({ ok: true, inserted: r.inserted, updated: r.updated, unchanged: r.unchanged, rejected: r.rejected.slice(0, 50) });
  });

  // the card on the Integrations page
  (h.integrationCards = h.integrationCards || []).push({
    key: 'energy',
    get title() { return tr('nrg|Building energy meters'); },
    get help() { return tr('nrg|The building management system sends interval readings to /ingest/energy with the API key. Set ENERGY_HMAC_SECRET to also require signed requests.'); },
    env: ['ENERGY_API_KEY', 'ENERGY_HMAC_SECRET'],
    href: '/admin/energy/meters',
    get hrefLabel() { return tr('nrg|Set up'); },
    status: () => {
      const keyOn = !!env('ENERGY_API_KEY');
      const last = db.get("SELECT created_at FROM nrg_imports WHERE via = 'api' ORDER BY id DESC LIMIT 1");
      return { ok: keyOn, detail: keyOn ? (last ? tr('nrg|Last delivery {when}.', { when: ui.rel(last.created_at) }) : tr('nrg|Waiting for the first delivery.')) : tr('nrg|Set ENERGY_API_KEY on the server, then give the key to the building system\'s integrator.') };
    },
  });
};

module.exports.SCHEMA = SCHEMA;
module.exports.ensure = ensure;
module.exports.store = store;
module.exports.localTs = localTs;
module.exports.readCsv = readCsv;
module.exports.FACTORS = FACTORS;
