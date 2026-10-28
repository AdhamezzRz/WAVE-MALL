'use strict';

// Footfall and parking: hourly visitor counts per entrance and car park entries, exits and
// occupancy, from people-counter CSV exports (with a column-mapping step) or pushed by the counters
// to /ingest/footfall. Dashboards compare periods, show the shape of a day and of a week, split
// the entrances, estimate parking stays, and set footfall against tenant sales and mall events.
// Hours are Cairo local time, as the counters report them.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { t: tr, tn, tx } = require('../i18n');
const { tmap, cairo, parseCsv, csvCell } = require('../ops-common');

const SCHEMA = `
  CREATE TABLE footfall_entrances (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'entrance',
    sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE footfall (
    id INTEGER PRIMARY KEY, ts_hour TEXT NOT NULL, entrance TEXT NOT NULL, visitors_in INTEGER NOT NULL DEFAULT 0,
    visitors_out INTEGER NOT NULL DEFAULT 0, source TEXT, demo INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    UNIQUE (ts_hour, entrance)
  );
  CREATE TABLE parking (
    id INTEGER PRIMARY KEY, ts_hour TEXT NOT NULL UNIQUE, entries INTEGER NOT NULL DEFAULT 0, exits INTEGER NOT NULL DEFAULT 0,
    occupancy INTEGER, capacity INTEGER, source TEXT, demo INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  );
  CREATE TABLE footfall_imports (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'footfall', via TEXT NOT NULL DEFAULT 'csv', status TEXT NOT NULL DEFAULT 'staged',
    file_name TEXT, content TEXT, rows INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
    unchanged INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, first_hour TEXT, last_hour TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
`;

const KINDS = { entrance: 'ftf|Entrance', zone: 'ftf|Zone' };
// a mall day starts at 06:00
const DAY_START = 6;
// SQL: the mall day an hour belongs to
const MALL_DAY = "date(substr(ts_hour, 1, 10) || ' ' || substr(ts_hour, 12, 2) || ':00', '-6 hours')";
const PERIODS = { today: 'ftf|Today', yesterday: 'ftf|Yesterday', week: 'ftf|Last 7 days', month: 'ftf|Last 30 days' };
// columns a CSV can map to
const FIELDS = {
  footfall: { time: 'ftf|Date and time', date: 'ftf|Date', hour: 'ftf|Hour', entrance: 'ftf|Entrance or zone', in: 'ftf|Visitors in', out: 'ftf|Visitors out' },
  parking: { time: 'ftf|Date and time', date: 'ftf|Date', hour: 'ftf|Hour', entries: 'ftf|Cars in', exits: 'ftf|Cars out', occupancy: 'ftf|Cars parked', capacity: 'ftf|Capacity' },
};
// header words that suggest a field (English and Arabic exports)
const GUESS = {
  time: /^(time|timestamp|date ?time|datetime|period|interval|الوقت|التاريخ والوقت)$/i,
  date: /^(date|day|التاريخ|اليوم)$/i,
  hour: /^(hour|hr|ساعة|الساعة)$/i,
  entrance: /(entrance|door|gate|zone|sensor|counter|location|site|مدخل|المدخل|بوابة|منطقة)/i,
  in: /(^in$|enter|entries|entr(y|ance)s? ?in|visitors? ?in|footfall|count|people|زوار|دخول|الداخل)/i,
  out: /(^out$|exit|left|خروج|الخارج)/i,
  entries: /(^in$|enter|entr(y|ies)|cars? ?in|دخول)/i,
  exits: /(^out$|exit|cars? ?out|خروج)/i,
  occupancy: /(occup|parked|present|inside|إشغال|متوقفة)/i,
  capacity: /(capacity|spaces|bays|السعة)/i,
};

// ---------- parsing (pure; exported for tests) ----------
const AR_DIGITS = /[٠-٩۰-۹]/g;
const western = (s) => String(s ?? '').replace(AR_DIGITS, (d) => String(Math.max('٠١٢٣٤٥٦٧٨٩'.indexOf(d), '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))));
function count(v) {
  let s = western(v).replace(/[,\s٬]/g, '').trim();
  if (s === '') return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 1.200 is twelve hundred
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : NaN;
}
const pad = (n) => String(n).padStart(2, '0');
const CAIRO_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
// The Cairo hour key 'YYYY-MM-DDTHH' of a date (and optional hour). Day-first for d/m/y.
function hourKey(dateIn, hourIn) {
  let s = western(dateIn).trim();
  if (!s) return null;
  // an instant with a zone: convert to Cairo time
  if (/\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s) && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T'));
    if (Number.isNaN(t)) return null;
    const p = Object.fromEntries(CAIRO_FMT.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}`;
  }
  let y;
  let m;
  let d;
  let rest = '';
  let mm = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/);
  if (mm) [, y, m, d, rest] = mm;
  else if ((mm = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(.*)$/))) {
    let a;
    let b;
    [, a, b, y, rest] = mm;
    // day first, unless that cannot be
    if (Number(b) > 12 && Number(a) <= 12) [m, d] = [a, b];
    else [d, m] = [a, b];
  } else return null;
  y = Number(y); m = Number(m); d = Number(d);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null;
  const hourText = hourIn !== undefined && hourIn !== null && String(hourIn).trim() !== '' ? western(hourIn).trim() : rest.replace(/^[T\s,]+/, '').trim();
  let hour = 0;
  if (hourText) {
    const hm = hourText.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(?:\.\d+)?\s*(am|pm|ص|م)?/i);
    if (!hm) return null;
    hour = Number(hm[1]);
    const ap = (hm[3] || '').toLowerCase();
    if ((ap === 'pm' || ap === 'م') && hour < 12) hour += 12;
    if ((ap === 'am' || ap === 'ص') && hour === 12) hour = 0;
    if (hour === 24) hour = 0;
    if (hour > 23) return null;
  }
  return `${y}-${pad(m)}-${pad(d)}T${pad(hour)}`;
}
// Guess the mapping from the headers: { field: column index }
function guessMap(headers, kind) {
  const out = {};
  const used = new Set();
  for (const f of Object.keys(FIELDS[kind])) {
    const i = headers.findIndex((hd, k) => !used.has(k) && GUESS[f] && GUESS[f].test(String(hd).trim()));
    if (i >= 0) { out[f] = i; used.add(i); }
  }
  if (out.time !== undefined && out.date !== undefined) delete out.date;
  return out;
}
// Rows → records, with what could not be read. map: { field: index }, fixedEntrance for files of one door.
function readRows(rows, kind, map, { fixedEntrance = null } = {}) {
  const good = [];
  const bad = [];
  const cell = (r, f) => (map[f] === undefined || map[f] === null || map[f] === '' ? undefined : r[Number(map[f])]);
  rows.forEach((r, i) => {
    const when = map.time !== undefined && map.time !== '' ? hourKey(cell(r, 'time'), cell(r, 'hour')) : hourKey(cell(r, 'date'), cell(r, 'hour'));
    if (!when) return bad.push({ row: i + 2, why: 'time' });
    if (kind === 'footfall') {
      const entrance = String(cell(r, 'entrance') ?? fixedEntrance ?? '').trim();
      const vin = count(cell(r, 'in'));
      const vout = cell(r, 'out') === undefined ? 0 : count(cell(r, 'out'));
      if (!entrance) return bad.push({ row: i + 2, why: 'entrance' });
      if (vin === null || Number.isNaN(vin) || Number.isNaN(vout)) return bad.push({ row: i + 2, why: 'number' });
      good.push({ ts_hour: when, entrance, in: vin, out: vout || 0 });
    } else {
      const e = count(cell(r, 'entries'));
      const x = cell(r, 'exits') === undefined ? 0 : count(cell(r, 'exits'));
      const o = cell(r, 'occupancy') === undefined ? null : count(cell(r, 'occupancy'));
      const c = cell(r, 'capacity') === undefined ? null : count(cell(r, 'capacity'));
      if (e === null || [e, x, o, c].some((v) => Number.isNaN(v))) return bad.push({ row: i + 2, why: 'number' });
      good.push({ ts_hour: when, entries: e, exits: x || 0, occupancy: o, capacity: c });
    }
  });
  // the same hour twice in one file: the counts add up (two sensors on one door)
  const merged = new Map();
  for (const g of good) {
    const k = kind === 'footfall' ? `${g.ts_hour}|${g.entrance.toLowerCase()}` : g.ts_hour;
    const prev = merged.get(k);
    if (!prev) merged.set(k, { ...g });
    else if (kind === 'footfall') { prev.in += g.in; prev.out += g.out; } else { prev.entries += g.entries; prev.exits += g.exits; prev.occupancy = g.occupancy ?? prev.occupancy; prev.capacity = g.capacity ?? prev.capacity; }
  }
  return { records: [...merged.values()], bad };
}

function ensure(db) {
  db.ensure('footfall-1', SCHEMA);
}

// Store records. Same hour and entrance again replaces the earlier count, so importing a file twice
// changes nothing. Returns { inserted, updated, unchanged, created: [new entrance codes] }.
function store(db, kind, records, { source = 'csv', demo = 0 } = {}) {
  const out = { inserted: 0, updated: 0, unchanged: 0, created: [], first: null, last: null };
  const t = new Date().toISOString();
  db.tx(() => {
    const doors = new Map(db.all('SELECT code, name FROM footfall_entrances').flatMap((e) => [[e.code.toLowerCase(), e.code], [String(e.name).toLowerCase(), e.code]]));
    for (const r of records) {
      if (!out.first || r.ts_hour < out.first) out.first = r.ts_hour;
      if (!out.last || r.ts_hour > out.last) out.last = r.ts_hour;
      if (kind === 'footfall') {
        let code = doors.get(r.entrance.toLowerCase());
        if (!code) {
          code = r.entrance.toUpperCase().replace(/[^A-Z0-9؀-ۿ]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'GATE';
          let k = 2;
          while (db.get('SELECT id FROM footfall_entrances WHERE code = ?', code)) code = `${code.slice(0, 17)}-${k++}`;
          db.run('INSERT INTO footfall_entrances (code, name, kind, sort, demo, created_at) VALUES (?, ?, ?, ?, ?, ?)', code, r.entrance.slice(0, 80), 'entrance', 99, demo, t);
          doors.set(r.entrance.toLowerCase(), code);
          doors.set(code.toLowerCase(), code);
          out.created.push(code);
        }
        const old = db.get('SELECT visitors_in, visitors_out FROM footfall WHERE ts_hour = ? AND entrance = ?', r.ts_hour, code);
        if (!old) { db.run('INSERT INTO footfall (ts_hour, entrance, visitors_in, visitors_out, source, demo, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', r.ts_hour, code, r.in, r.out, source, demo, t); out.inserted++; } else if (old.visitors_in === r.in && old.visitors_out === r.out) out.unchanged++;
        else { db.run('UPDATE footfall SET visitors_in = ?, visitors_out = ?, source = ?, updated_at = ? WHERE ts_hour = ? AND entrance = ?', r.in, r.out, source, t, r.ts_hour, code); out.updated++; }
      } else {
        const old = db.get('SELECT entries, exits, occupancy, capacity FROM parking WHERE ts_hour = ?', r.ts_hour);
        if (!old) { db.run('INSERT INTO parking (ts_hour, entries, exits, occupancy, capacity, source, demo, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.ts_hour, r.entries, r.exits, r.occupancy, r.capacity, source, demo, t); out.inserted++; } else if (old.entries === r.entries && old.exits === r.exits && old.occupancy === r.occupancy && old.capacity === r.capacity) out.unchanged++;
        else { db.run('UPDATE parking SET entries = ?, exits = ?, occupancy = ?, capacity = ?, source = ?, updated_at = ? WHERE ts_hour = ?', r.entries, r.exits, r.occupancy, r.capacity, source, t, r.ts_hour); out.updated++; }
      }
    }
  });
  return out;
}

module.exports = function footfall(router, h) {
  const { db, ui, M } = h;
  const R = h.R;
  ensure(db);
  const env = (k) => String((h.env && h.env[k]) || '');
  const now = () => new Date().toISOString();
  const tabs = (on) => `<nav class="tabs">${[['/admin/footfall', tr('ftf|Dashboard')], ['/admin/footfall/import', tr('ftf|Import')], ['/admin/footfall/setup', tr('ftf|Entrances and counters')]]
    .map(([href, l]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${ui.esc(l)}</a>`).join('')}</nav>`;
  const crumbs = (...rest) => [['/admin/footfall', tr('nav|Footfall')], ...rest];
  const doors = () => db.all('SELECT * FROM footfall_entrances WHERE active = 1 ORDER BY sort, code');
  const capacity = () => Number(db.setting('parking_capacity')) || 0;
  const addDays = (d, n) => M.addDays(d, n);
  const sumIn = (a, b) => db.value('SELECT COALESCE(SUM(visitors_in), 0) FROM footfall WHERE ts_hour >= ? AND ts_hour <= ?', a, b);
  const hasTable = (name) => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  const delta = (a, b) => {
    if (!b) return '';
    const d = (a - b) / b;
    return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}%</span>`;
  };
  const hourLabel = (hr) => `${pad(hr)}:00`;

  // the period on screen and the one it is compared with (ts_hour bounds)
  // The period on screen and the one it is compared with (ts_hour bounds). A mall day runs from
  // 06:00 to 05:59 the next morning, so the hours after midnight count with the evening before.
  function period(p, c) {
    const d = c.hour < DAY_START ? addDays(c.date, -1) : c.date;
    const H = pad(c.hour);
    const span = (a, b) => [`${a}T${pad(DAY_START)}`, `${addDays(b, 1)}T${pad(DAY_START - 1)}`];
    if (p === 'yesterday') {
      const y = addDays(d, -1);
      const [from, to] = span(y, y);
      const [pFrom, pTo] = span(addDays(y, -7), addDays(y, -7));
      return { from, to, pFrom, pTo, days: [y], vs: tr('ftf|vs the same day last week') };
    }
    if (p === 'week' || p === 'month') {
      const n = p === 'week' ? 7 : 30;
      const a = addDays(d, -n);
      const b = addDays(d, -1);
      const [from, to] = span(a, b);
      const [pFrom, pTo] = span(addDays(a, -n), addDays(b, -n));
      return { from, to, pFrom, pTo, days: Array.from({ length: n }, (_, i) => addDays(a, i)), vs: tr(p === 'week' ? 'ftf|vs the 7 days before' : 'ftf|vs the 30 days before') };
    }
    // today so far, against the same weekday last week up to the same hour
    const [from] = span(d, d);
    const [pFrom] = span(addDays(d, -7), addDays(d, -7));
    return { from, to: `${c.date}T${H}`, pFrom, pTo: `${addDays(c.date, -7)}T${H}`, days: [d], vs: tr('ftf|vs last week at this hour') };
  }
  // hours in mall-day order, 06:00 to 05:00
  const ORDER = Array.from({ length: 24 }, (_, i) => (i + DAY_START) % 24);

  // a line chart that stretches to its card: series [{ values, tone, label, dashed }], one label per point
  function lineChart(series, { labels, h: height = 180, fmt = ui.n0, band = null } = {}) {
    const W = 600;
    const H = 100;
    const n = labels.length;
    const max = Math.max(1, ...series.flatMap((s) => s.values.filter((v) => v !== null)), band || 0) * 1.12;
    const x = (i) => (n <= 1 ? 0 : (i / (n - 1)) * W);
    const y = (v) => H - (v / max) * H;
    const paths = series.map((s, si) => {
      const segs = [];
      let cur = [];
      s.values.forEach((v, i) => { if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
      if (cur.length) segs.push(cur);
      const d = segs.map((sg) => `M${sg.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(2)}`).join('L')}`).join(' ');
      const area = si === 0 && segs.length === 1 && segs[0].length > 1 ? `<path class="ftf-area t-${s.tone}" d="${d}L${segs[0][segs[0].length - 1][0].toFixed(1)},${H}L${segs[0][0][0].toFixed(1)},${H}Z"/>` : '';
      return `${area}<path class="ftf-line t-${s.tone}${s.dashed ? ' is-ghost' : ''}" d="${d}" vector-effect="non-scaling-stroke"/>`;
    }).join('');
    const at = (i, v) => `left:${((x(i) / W) * 100).toFixed(2)}%;top:${((y(v) / H) * 100).toFixed(2)}%`;
    const first = series[0].values;
    const peak = first.reduce((m, v, i) => (v !== null && (m === null || v > first[m]) ? i : m), null);
    const peakMark = peak !== null && first[peak] ? `<i class="ftf-dot t-${series[0].tone}" style="${at(peak, first[peak])}"></i><b class="ftf-pk" style="${at(peak, first[peak])}">${ui.esc(fmt(first[peak]))}</b>` : '';
    const bandLine = band ? `<line x1="0" x2="${W}" y1="${y(band).toFixed(2)}" y2="${y(band).toFixed(2)}" class="ftf-cap" vector-effect="non-scaling-stroke"/>` : '';
    const bandLabel = band ? `<small class="ftf-capl" style="top:${((y(band) / H) * 100).toFixed(2)}%">${ui.esc(tr('ftf|Capacity {n}', { n: ui.n0(band) }))}</small>` : '';
    const step = Math.max(1, Math.ceil(n / 8));
    const xl = `<div class="ftf-x">${labels.map((l, i) => `<span style="left:${((x(i) / W) * 100).toFixed(2)}%">${i % step === 0 ? ui.esc(l) : ''}</span>`).join('')}</div>`;
    const legend = series.length > 1 ? `<ul class="legend legend--row">${series.map((s) => `<li><i class="t-${s.tone}${s.dashed ? ' is-ghost' : ''}"></i><span>${ui.esc(s.label)}</span></li>`).join('')}</ul>` : '';
    return `<figure class="ftf-chart" dir="ltr" style="--h:${height}px"><div class="ftf-plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${ui.esc(series[0].label)}">${bandLine}${paths}</svg>${peakMark}${bandLabel}</div>${xl}</figure>${legend}`;
  }

  // ---------- dashboard ----------
  router.get('/footfall', (req, res) => {
    const c = cairo();
    const p = PERIODS[req.query.p] ? req.query.p : 'today';
    const per = period(p, c);
    const total = sumIn(per.from, per.to);
    const before = sumIn(per.pFrom, per.pTo);
    const hasData = db.value('SELECT COUNT(*) FROM footfall') > 0;
    const hourly = (a, b, days) => {
      const rows = db.all('SELECT CAST(substr(ts_hour, 12, 2) AS INTEGER) hr, SUM(visitors_in) n FROM footfall WHERE ts_hour >= ? AND ts_hour <= ? GROUP BY hr', a, b);
      return Array.from({ length: 24 }, (_, hr) => { const r = rows.find((x) => x.hr === hr); return r ? Math.round(r.n / days) : 0; });
    };
    const byHour = hourly(per.from, per.to, per.days.length);
    const prevByHour = hourly(per.pFrom, per.pTo, per.days.length);
    const nowAt = ORDER.indexOf(c.hour);
    const peakHr = byHour.reduce((m, v, i) => (v > byHour[m] ? i : m), 0);
    const byDoor = db.all('SELECT f.entrance, e.name, SUM(f.visitors_in) n FROM footfall f LEFT JOIN footfall_entrances e ON e.code = f.entrance WHERE f.ts_hour >= ? AND f.ts_hour <= ? GROUP BY f.entrance ORDER BY n DESC', per.from, per.to);
    // parking
    const park = db.all('SELECT * FROM parking WHERE ts_hour >= ? AND ts_hour <= ? ORDER BY ts_hour', per.from, per.to);
    const cap = capacity() || Math.max(0, ...park.map((x) => x.capacity || 0));
    const cars = park.reduce((s, x) => s + x.entries, 0);
    const carsBefore = db.value('SELECT COALESCE(SUM(entries), 0) FROM parking WHERE ts_hour >= ? AND ts_hour <= ?', per.pFrom, per.pTo);
    const peakOcc = Math.max(0, ...park.map((x) => x.occupancy || 0));
    // average stay (Little's law): cars parked on average ÷ cars arriving per hour
    const occHours = park.filter((x) => x.occupancy !== null);
    const stay = cars && occHours.length ? (occHours.reduce((s, x) => s + x.occupancy, 0) / occHours.length) / (cars / park.length) : null;
    const parkByHour = Array.from({ length: 24 }, (_, hr) => {
      const rows = park.filter((x) => Number(x.ts_hour.slice(11, 13)) === hr && x.occupancy !== null);
      return rows.length ? Math.round(rows.reduce((s2, x) => s2 + x.occupancy, 0) / rows.length) : 0;
    });
    // the hours the mall is busy (first to last hour with any count), in mall-day order
    const busy = ORDER.map((hr, i) => (byHour[hr] || prevByHour[hr] || parkByHour[hr] ? i : -1)).filter((i) => i >= 0);
    const lo = busy.length ? Math.max(0, busy[0] - 1) : 0;
    const hi = busy.length ? Math.min(23, busy[busy.length - 1] + 1) : 23;
    const shown = ORDER.slice(lo, hi + 1);
    const later = (hr) => p === 'today' && ORDER.indexOf(hr) > nowAt;
    const curve = shown.map((hr) => (later(hr) ? null : byHour[hr]));
    const prevCurve = shown.map((hr) => prevByHour[hr]);
    const parkCurve = shown.map((hr) => (later(hr) ? null : parkByHour[hr]));
    const stayText = stay === null ? '—' : tr('ftf|{h} h {m} min', { h: Math.floor(stay), m: Math.round((stay % 1) * 60) });

    const kpis = [
      ui.kpi({ label: p === 'today' ? tr('ftf|Visitors so far today') : tr('ftf|Visitors'), value: ui.n0(total), sub: `${delta(total, before)} ${ui.esc(per.vs)}` }),
      ui.kpi({ label: tr('ftf|Busiest hour'), value: byHour[peakHr] ? `${hourLabel(peakHr)}` : '—', sub: byHour[peakHr] ? ui.esc(tr('ftf|{n} visitors an hour', { n: ui.n0(byHour[peakHr]) })) : '' }),
      ui.kpi({ label: tr('ftf|Cars'), value: ui.n0(cars), sub: `${delta(cars, carsBefore)} ${ui.esc(per.vs)}` }),
      ui.kpi({ label: tr('ftf|Car park at its fullest'), value: cap ? ui.pct(peakOcc / cap) : ui.n0(peakOcc), bar: cap ? Math.min(1, peakOcc / cap) : null, sub: ui.esc(tr('ftf|Average stay {time}', { time: stayText })) }),
    ].join('');
    const periodTabs = `<nav class="tabs">${Object.entries(PERIODS).map(([k, l]) => `<a class="tab${p === k ? ' is-on' : ''}" href="/admin/footfall${k === 'today' ? '' : `?p=${k}`}">${ui.esc(tr(l))}</a>`).join('')}</nav>`;
    const hours = shown.map(hourLabel);
    const curveCard = ui.card(per.days.length > 1 ? tr('ftf|An average day, hour by hour') : tr('ftf|Hour by hour'), lineChart([
      { values: curve, tone: 'forest', label: tr(PERIODS[p]) },
      { values: prevCurve, tone: 'sand', label: tr('ftf|Comparison'), dashed: true },
    ], { labels: hours }));
    // daily trend with mall events
    let trend = '';
    let eventsHtml = '';
    const events = mallEvents(per.days[0], per.days[per.days.length - 1]);
    if (per.days.length > 1) {
      const daily = db.all(`SELECT ${MALL_DAY} d, SUM(visitors_in) n FROM footfall WHERE ts_hour >= ? AND ts_hour <= ? GROUP BY d`, per.from, per.to);
      const series = per.days.map((d) => {
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        const ev = events.some((e) => e.start <= d && e.end >= d);
        return { label: `${Number(d.slice(8))}${ev ? '★' : ''}`, n: (daily.find((x) => x.d === d) || {}).n || 0, we: dow === 5 || dow === 6 };
      });
      trend = ui.card(tr('ftf|Day by day'), `${ui.bars(series, { key: 'n', label: 'label', h: 150, fmtv: (v) => (v / 1000).toFixed(1) })}<p class="muted small">${ui.esc(tr('ftf|Thousands of visitors. ★ marks a day with a mall event.'))}</p>`);
    }
    if (events.length) eventsHtml = ui.card(tr('ftf|Mall events in this period'), `<ul class="list">${events.slice(0, 8).map((e) => `<li><span class="what"><b>${ui.esc(e.title)}</b><small>${ui.date(e.start)}${e.end !== e.start ? ` – ${ui.date(e.end)}` : ''}</small></span><b>${ui.n0(sumIn(`${e.start}T00`, `${e.end}T23`))}</b></li>`).join('')}</ul>`, { sub: ui.esc(tr('ftf|Visitors on the event days')) });
    const doorCard = ui.card(tr('ftf|By entrance'), byDoor.length ? ui.donut(byDoor.map((x) => ({ label: x.name ? tx(x.name) : x.entrance, value: x.n, display: ui.n0(x.n) })), { label: ui.n0(total) }) : `<p class="muted pad">${ui.esc(tr('ftf|No counts in this period.'))}</p>`);
    const parkCard = ui.card(tr('ftf|Car park'), park.length ? lineChart([{ values: parkCurve, tone: 'sea', label: tr('ftf|Cars parked') }], { labels: hours, band: cap || null, h: 160 }) : `<p class="muted pad">${ui.esc(tr('ftf|No parking counts in this period.'))}</p>`, { sub: ui.esc(per.days.length > 1 ? tr('ftf|Cars parked, average by hour') : tr('ftf|Cars parked, hour by hour')) });
    const body = !hasData
      ? `${tabs('/admin/footfall')}${ui.empty(tr('ftf|No footfall yet. Import a people-counter export, or connect the counters to send their counts every hour.'), `${ui.btn(tr('ftf|Import a file'), { href: '/admin/footfall/import', cls: 'btn--primary btn--sm' })} ${ui.btn(tr('ftf|Connect the counters'), { href: '/admin/footfall/setup', cls: 'btn--ghost btn--sm' })}`)}`
      : `${tabs('/admin/footfall')}${periodTabs}<div class="kpis kpis--4">${kpis}</div>
${curveCard}
<div class="grid grid--side">${trend || parkCard}${doorCard}</div>
${trend ? `<div class="grid grid--side">${parkCard}${eventsHtml || weekShape()}</div>` : ''}
<div class="grid grid--side">${heatmap()}${conversion()}</div>
${!trend && eventsHtml ? eventsHtml : ''}`;
    h.page(req, res, {
      title: tr('nav|Footfall'), active: '/admin/footfall', wide: true, body,
      actions: hasData ? ui.btn(tr('Export CSV'), { href: `/admin/footfall/export.csv?p=${p}`, cls: 'btn--ghost', ic: 'dl' }) : '',
    });
  });

  // the week's shape: weekday × hour, last 4 weeks
  function heatmap() {
    const c = cairo();
    const from = addDays(c.date, -28);
    const rows = db.all(`SELECT ${MALL_DAY} d, CAST(substr(ts_hour, 12, 2) AS INTEGER) hr, SUM(visitors_in) n FROM footfall WHERE ts_hour >= ? AND ts_hour < ? GROUP BY d, hr`, `${from}T06`, `${c.date}T06`);
    if (!rows.length) return ui.card(tr('ftf|The shape of a week'), `<p class="muted pad">${ui.esc(tr('ftf|Not enough counts yet.'))}</p>`);
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    const seen = Array.from({ length: 7 }, () => new Set());
    for (const r of rows) {
      const wd = (new Date(`${r.d}T00:00:00Z`).getUTCDay() + 6) % 7;
      grid[wd][r.hr] += r.n;
      seen[wd].add(r.d);
    }
    const avg = grid.map((row, wd) => row.map((v) => (seen[wd].size ? v / seen[wd].size : 0)));
    const max = Math.max(1, ...avg.flat());
    const hrs = ORDER.filter((i) => avg.some((r) => r[i] > max * 0.03));
    const names = ui.weekdays();
    const html = `<div class="ftf-heat" style="--c:${hrs.length}"><span></span>${hrs.map((hr) => `<span class="ftf-heat__h">${hr % 3 === 0 ? pad(hr) : ''}</span>`).join('')}${avg.map((row, wd) => `<span class="ftf-heat__d">${ui.esc(names[wd])}</span>${hrs.map((hr) => `<span class="ftf-heat__c" style="--f:${(row[hr] / max).toFixed(2)}" title="${ui.esc(`${names[wd]} ${hourLabel(hr)} · ${ui.n0(Math.round(row[hr]))}`)}"></span>`).join('')}`).join('')}</div>`;
    return ui.card(tr('ftf|The shape of a week'), html, { sub: ui.esc(tr('ftf|Average visitors by weekday and hour, last four weeks')) });
  }
  function weekShape() {
    const c = cairo();
    const from = addDays(c.date, -28);
    const rows = db.all(`SELECT ${MALL_DAY} d, SUM(visitors_in) n FROM footfall WHERE ts_hour >= ? AND ts_hour < ? GROUP BY d`, `${from}T06`, `${c.date}T06`);
    const by = Array.from({ length: 7 }, () => []);
    for (const r of rows) by[(new Date(`${r.d}T00:00:00Z`).getUTCDay() + 6) % 7].push(r.n);
    const names = ui.weekdays();
    const series = by.map((l, i) => ({ label: names[i], n: l.length ? Math.round(l.reduce((s, x) => s + x, 0) / l.length) : 0 }));
    return ui.card(tr('ftf|An average weekday'), ui.bars(series, { key: 'n', label: 'label', h: 150 }), { sub: ui.esc(tr('ftf|Visitors per day, last four weeks')) });
  }

  // mall events, from the website module's events table if there is one
  function mallEvents(a, b) {
    for (const table of ['website_events', 'events', 'mall_events']) {
      if (!hasTable(table)) continue;
      try {
        const cols = db.all(`PRAGMA table_info(${table})`).map((x) => x.name);
        const start = ['start_date', 'starts_at', 'starts_on', 'date', 'start'].find((k) => cols.includes(k));
        if (!start) continue;
        const end = ['end_date', 'ends_at', 'ends_on', 'end'].find((k) => cols.includes(k)) || start;
        const titleCol = (require('../i18n').isAr() ? ['title_ar', 'name_ar'] : []).concat(['title_en', 'title', 'name_en', 'name']).find((k) => cols.includes(k));
        if (!titleCol) continue;
        const pub = cols.includes('status') ? "AND (status IS NULL OR status NOT IN ('draft','archived','cancelled'))" : '';
        return db.all(`SELECT ${titleCol} title, substr(${start}, 1, 10) s, substr(COALESCE(${end}, ${start}), 1, 10) e FROM ${table} WHERE substr(${start}, 1, 10) <= ? AND substr(COALESCE(${end}, ${start}), 1, 10) >= ? ${pub} ORDER BY ${start} LIMIT 30`, b, a)
          .filter((r) => r.title && r.s).map((r) => ({ title: tx(r.title), start: r.s < a ? a : r.s, end: r.e > b ? b : r.e }));
      } catch {
        // a table of another shape: no overlay
      }
    }
    return [];
  }

  // footfall against tenant sales (tenant_sales: brand_id, period YYYY-MM, amount)
  function conversion() {
    const title = tr('ftf|Visitors and tenant sales');
    if (!hasTable('tenant_sales')) return ui.card(title, `<p class="muted pad">${ui.esc(tr('ftf|Tenant sales appear here once tenants report them.'))}</p>`);
    let sales = [];
    try {
      const cols = db.all('PRAGMA table_info(tenant_sales)').map((x) => x.name);
      const amount = ['amount', 'gross', 'net', 'total', 'sales'].find((k) => cols.includes(k));
      if (!cols.includes('period') || !amount) throw new Error('shape');
      sales = db.all(`SELECT period, SUM(${amount}) amount FROM tenant_sales GROUP BY period ORDER BY period DESC LIMIT 6`);
    } catch {
      sales = [];
    }
    const months = sales.reverse().map((s) => {
      const visitors = sumIn(`${s.period}-01T00`, `${s.period}-31T23`);
      return { period: s.period, amount: s.amount, visitors, per: visitors ? s.amount / visitors : null };
    }).filter((m) => m.visitors);
    if (!months.length) return ui.card(title, `<p class="muted pad">${ui.esc(tr('ftf|No month has both footfall and tenant sales yet.'))}</p>`);
    const rows = months.map((m) => `<tr><td>${ui.esc(ui.monthYear(m.period))}</td><td class="num">${ui.n0(m.visitors)}</td><td class="num">${ui.money(m.amount, { compact: true })}</td><td class="num"><b>${m.per === null ? '—' : ui.money(m.per)}</b></td></tr>`).join('');
    return ui.card(title, `<div class="tablewrap"><table class="table"><thead><tr><th>${ui.esc(tr('ftf|Month'))}</th><th class="num">${ui.esc(tr('ftf|Visitors'))}</th><th class="num">${ui.esc(tr('ftf|Tenant sales'))}</th><th class="num">${ui.esc(tr('ftf|Sales per visitor'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`, { sub: ui.esc(tr('ftf|What each visitor spends across the mall, on average')) });
  }

  // ---------- export ----------
  router.get('/footfall/export.csv', (req, res) => {
    const c = cairo();
    const p = PERIODS[req.query.p] ? req.query.p : 'month';
    const per = period(p, c);
    const ds = doors();
    const rows = db.all('SELECT ts_hour, entrance, visitors_in, visitors_out FROM footfall WHERE ts_hour >= ? AND ts_hour <= ? ORDER BY ts_hour', per.from, per.to);
    const park = new Map(db.all('SELECT * FROM parking WHERE ts_hour >= ? AND ts_hour <= ?', per.from, per.to).map((x) => [x.ts_hour, x]));
    const hoursList = [...new Set(rows.map((r) => r.ts_hour).concat([...park.keys()]))].sort();
    const head = [tr('ftf|Date'), tr('ftf|Hour'), ...ds.map((d) => `${tx(d.name)} (${tr('ftf|in')})`), tr('ftf|Visitors in'), tr('ftf|Visitors out'), tr('ftf|Cars in'), tr('ftf|Cars out'), tr('ftf|Cars parked')];
    const lines = hoursList.map((hk) => {
      const here = rows.filter((r) => r.ts_hour === hk);
      const pk = park.get(hk) || {};
      return [hk.slice(0, 10), `${hk.slice(11, 13)}:00`, ...ds.map((d) => (here.find((r) => r.entrance === d.code) || {}).visitors_in ?? ''), here.reduce((s, r) => s + r.visitors_in, 0), here.reduce((s, r) => s + r.visitors_out, 0), pk.entries ?? '', pk.exits ?? '', pk.occupancy ?? ''];
    });
    const csv = [head.map(csvCell).join(','), ...lines.map((l) => l.map(csvCell).join(','))].join('\r\n');
    h.log(req, 'Exported', 'export', null, `Footfall ${per.from.slice(0, 10)} to ${per.to.slice(0, 10)}`);
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="footfall-${per.from.slice(0, 10)}-${per.to.slice(0, 10)}.csv"`).send(`﻿${csv}`);
  });

  // ---------- CSV import: stage, map, preview, apply ----------
  const MAX_CSV = 8 * 1024 * 1024;
  const stage = (req, kind, name, text) => Number(db.run('INSERT INTO footfall_imports (kind, via, status, file_name, content, rows, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    kind, 'csv', 'staged', name, text, Math.max(0, parseCsv(text).rows.length), req.user.id, now()).lastInsertRowid);
  router.get('/footfall/import', R('agent'), (req, res) => {
    // straight after an upload (the page reloads), continue to the mapping
    const fresh = db.get("SELECT id FROM footfall_imports WHERE status = 'staged' AND user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 1", req.user.id, new Date(Date.now() - 60000).toISOString());
    if (fresh && req.query.stay !== '1') return res.redirect(303, `/admin/footfall/import/${fresh.id}`);
    const csrf = req.session.csrf;
    const kindSel = (name) => ui.select(name, tr('ftf|What the file holds'), { footfall: tr('ftf|Visitor counts'), parking: tr('ftf|Car park counts') }, 'footfall');
    const upload = `<form class="upload" data-upload="/admin/footfall/import/stage?via=file" novalidate><div class="fields">${kindSel('kind')}</div>
      <label class="drop"><input type="file" name="file" accept=".csv,.txt,text/csv,text/plain">${ui.icon('upload')}<span data-drop-label>${ui.esc(tr('ftf|Drop a CSV file here, or click to choose'))}</span><small>${ui.esc(tr('ftf|CSV or text export from the counters · up to 8 MB'))}</small><i class="drop__bar" hidden><b></b></i></label>
      <p class="upload__msg" data-upload-msg hidden></p></form>`;
    const paste = ui.form('/admin/footfall/import/stage-text', csrf, `<div class="fields">${kindSel('kind')}${ui.textarea('csv', tr('ftf|Or paste the rows'), '', { rows: 6, cls: 'span-all', placeholder: 'date,hour,entrance,in,out\n2026-10-01,10,North,412,380' })}</div>${ui.btn(tr('ftf|Continue'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' });
    const past = db.all("SELECT i.*, u.name user_name FROM footfall_imports i LEFT JOIN users u ON u.id = i.user_id WHERE i.status != 'staged' OR i.created_at >= ? ORDER BY i.id DESC LIMIT 15", new Date(Date.now() - 86400000).toISOString());
    const hist = ui.table([
      { label: tr('ftf|Import'), render: (i) => `<b>${ui.esc(i.via === 'api' ? tr('ftf|From the counters') : (i.file_name ? tx(i.file_name) : tr('ftf|Pasted rows')))}</b><small class="sub">${ui.esc(i.kind === 'parking' ? tr('ftf|Car park counts') : tr('ftf|Visitor counts'))} · ${ui.esc(ui.rel(i.created_at))}${i.user_name ? ` · ${ui.esc(i.user_name)}` : ''}</small>` },
      { label: tr('ftf|Hours covered'), render: (i) => (i.first_hour ? `${ui.date(i.first_hour.slice(0, 10))} – ${ui.date(i.last_hour.slice(0, 10))}` : '—') },
      { label: tr('ftf|New'), num: true, render: (i) => ui.n0(i.inserted) },
      { label: tr('ftf|Changed'), num: true, render: (i) => ui.n0(i.updated) },
      { label: tr('ftf|Already there'), num: true, render: (i) => ui.n0(i.unchanged) },
      { label: tr('ftf|Skipped'), num: true, render: (i) => (i.status === 'staged' ? `<a href="/admin/footfall/import/${i.id}">${ui.esc(tr('ftf|Continue'))}</a>` : ui.n0(i.skipped)) },
    ], past, { empty: ui.esc(tr('ftf|Nothing imported yet.')) });
    const body = `${tabs('/admin/footfall/import')}<div class="grid grid--side">
  ${ui.card(tr('ftf|Import counts'), `${upload}<div class="ftf-or"><span>${ui.esc(tr('ftf|or'))}</span></div>${paste}`, { sub: ui.esc(tr('ftf|Any export with a time, an entrance and a count. You choose the columns on the next step. Importing the same hours again replaces them, never doubles them.')) })}
  ${ui.card(tr('ftf|Recent imports'), hist)}
</div>`;
    h.page(req, res, { title: tr('ftf|Import counts'), crumbs: crumbs([null, tr('ftf|Import')]), active: '/admin/footfall', wide: true, body });
  });
  router.post('/footfall/import/stage', R('agent'), express.raw({ type: () => true, limit: MAX_CSV + 1024 }), (req, res) => {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!text.trim()) return res.status(422).json({ ok: false, error: tr('Choose a file to upload.') });
    if (/[\u0000-\u0008]/.test(text.slice(0, 2000))) return res.status(415).json({ ok: false, error: tr('ftf|That is not a CSV or text file.') });
    const kind = req.query.kind === 'parking' ? 'parking' : 'footfall';
    const id = stage(req, kind, h.str(decodeURIComponent(String(req.get('x-file-name') || '')), 160) || null, text);
    res.json({ ok: true, id, url: `/admin/footfall/import/${id}` });
  });
  router.post('/footfall/import/stage-text', R('agent'), (req, res) => {
    const text = String(req.body.csv || '');
    if (!text.trim()) return h.back(req, res, '/admin/footfall/import?stay=1', 'error', tr('ftf|Paste some rows first.'));
    const id = stage(req, req.body.kind === 'parking' ? 'parking' : 'footfall', null, text);
    res.redirect(303, `/admin/footfall/import/${id}`);
  });

  const mapFrom = (q, headers, kind) => {
    const guessed = guessMap(headers, kind);
    const out = {};
    let chosen = false;
    for (const f of Object.keys(FIELDS[kind])) {
      if (q[`m_${f}`] !== undefined) { chosen = true; if (q[`m_${f}`] !== '') out[f] = Number(q[`m_${f}`]); }
    }
    return chosen ? out : guessed;
  };
  router.get('/footfall/import/:id', R('agent'), (req, res, next) => {
    const imp = db.get("SELECT * FROM footfall_imports WHERE id = ? AND status = 'staged'", h.int(req.params.id));
    if (!imp) return next();
    const { headers, rows } = parseCsv(imp.content);
    const kind = imp.kind;
    const map = mapFrom(req.query, headers, kind);
    const fixed = h.str(req.query.fixed, 60) || '';
    const { records, bad } = readRows(rows, kind, map, { fixedEntrance: fixed || null });
    const opts = [['', tr('ftf|Not in the file')], ...headers.map((hd, i) => [String(i), hd || tr('ftf|Column {n}', { n: i + 1 })])];
    const fields = Object.entries(FIELDS[kind]).map(([f, label]) => ui.select(`m_${f}`, tr(label), opts, map[f] === undefined ? '' : String(map[f])));
    const doorOpts = doors().map((d) => [d.code, tx(d.name)]);
    const fixedSel = kind === 'footfall' ? ui.select('fixed', tr('ftf|If there is no entrance column, the whole file is for'), doorOpts, fixed, { blank: tr('ftf|Choose an entrance') }) : '';
    const preview = records.slice(0, 12);
    const known = new Set(doors().flatMap((d) => [d.code.toLowerCase(), String(d.name).toLowerCase()]));
    const newDoors = kind === 'footfall' ? [...new Set(records.map((r) => r.entrance).filter((e) => !known.has(e.toLowerCase())))] : [];
    const table = kind === 'footfall'
      ? ui.table([{ label: tr('ftf|Date'), render: (r) => ui.date(r.ts_hour.slice(0, 10)) }, { label: tr('ftf|Hour'), render: (r) => `${r.ts_hour.slice(11)}:00` }, { label: tr('ftf|Entrance or zone'), render: (r) => ui.esc(tx(r.entrance)) }, { label: tr('ftf|Visitors in'), num: true, render: (r) => ui.n0(r.in) }, { label: tr('ftf|Visitors out'), num: true, render: (r) => ui.n0(r.out) }], preview, { empty: ui.esc(tr('ftf|No row could be read with these columns.')) })
      : ui.table([{ label: tr('ftf|Date'), render: (r) => ui.date(r.ts_hour.slice(0, 10)) }, { label: tr('ftf|Hour'), render: (r) => `${r.ts_hour.slice(11)}:00` }, { label: tr('ftf|Cars in'), num: true, render: (r) => ui.n0(r.entries) }, { label: tr('ftf|Cars out'), num: true, render: (r) => ui.n0(r.exits) }, { label: tr('ftf|Cars parked'), num: true, render: (r) => ui.n0(r.occupancy) }], preview, { empty: ui.esc(tr('ftf|No row could be read with these columns.')) });
    const why = { time: tr('ftf|date or hour not readable'), entrance: tr('ftf|no entrance'), number: tr('ftf|count not a number') };
    const badList = bad.length ? `<p class="alert alert--warn">${ui.esc(tn(bad.length, 'ftf|{n} row will be skipped', 'ftf|{n} rows will be skipped'))}: ${bad.slice(0, 6).map((b) => ui.esc(tr('ftf|row {row} ({why})', { row: b.row, why: why[b.why] }))).join(', ')}${bad.length > 6 ? '…' : ''}</p>` : '';
    const span = records.length ? records.reduce((a, r) => [a[0] < r.ts_hour ? a[0] : r.ts_hour, a[1] > r.ts_hour ? a[1] : r.ts_hour], [records[0].ts_hour, records[0].ts_hour]) : null;
    const hidden = Object.entries(map).map(([f, i]) => `<input type="hidden" name="m_${f}" value="${i}">`).join('') + (fixed ? `<input type="hidden" name="fixed" value="${ui.esc(fixed)}">` : '');
    const body = `${tabs('/admin/footfall/import')}<div class="grid grid--side">
  <div class="stack">${ui.card(tr('ftf|Preview'), `${badList}${newDoors.length ? `<p class="alert alert--warn">${ui.esc(tr('ftf|New entrances will be added: {list}', { list: newDoors.slice(0, 8).join(', ') }))}</p>` : ''}${table}`, { sub: ui.esc(span ? tr('ftf|{n} hours of counts, {a} to {b}. The first 12 are shown.', { n: ui.n0(records.length), a: ui.date(span[0].slice(0, 10)), b: ui.date(span[1].slice(0, 10)) }) : tr('ftf|Choose the columns.')) })}
    ${records.length ? ui.form(`/admin/footfall/import/${imp.id}/run`, req.session.csrf, `${hidden}${ui.btn(tr('ftf|Import {n} hours', { n: ui.n0(records.length) }), { cls: 'btn--primary' })}`, { cls: 'row' }) : ''}</div>
  ${ui.card(tr('ftf|Columns'), `<form method="get" action="/admin/footfall/import/${imp.id}" class="stack"><div class="fields">${fields.join('')}${fixedSel}</div>${ui.btn(tr('ftf|Update the preview'), { cls: 'btn--ghost btn--sm' })}</form>`, { sub: ui.esc(tr('ftf|{file} · {n} rows · {kind}', { file: imp.file_name ? tx(imp.file_name) : tr('ftf|Pasted rows'), n: ui.n0(rows.length), kind: kind === 'parking' ? tr('ftf|Car park counts') : tr('ftf|Visitor counts') })) })}
</div>`;
    h.page(req, res, { title: tr('ftf|Match the columns'), crumbs: crumbs(['/admin/footfall/import', tr('ftf|Import')], [null, tr('ftf|Columns')]), active: '/admin/footfall', wide: true, body });
  });
  router.post('/footfall/import/:id/run', R('agent'), (req, res, next) => {
    const imp = db.get("SELECT * FROM footfall_imports WHERE id = ? AND status = 'staged'", h.int(req.params.id));
    if (!imp) return next();
    const { headers, rows } = parseCsv(imp.content);
    const map = mapFrom(req.body, headers, imp.kind);
    const { records, bad } = readRows(rows, imp.kind, map, { fixedEntrance: h.str(req.body.fixed, 60) || null });
    if (!records.length) return h.back(req, res, `/admin/footfall/import/${imp.id}`, 'error', tr('ftf|No row could be read with these columns.'));
    const r = store(db, imp.kind, records, { source: 'csv' });
    db.run("UPDATE footfall_imports SET status = 'done', content = NULL, rows = ?, inserted = ?, updated = ?, unchanged = ?, skipped = ?, first_hour = ?, last_hour = ? WHERE id = ?",
      rows.length, r.inserted, r.updated, r.unchanged, bad.length, r.first, r.last, imp.id);
    h.log(req, 'Imported footfall', 'footfall_import', imp.id, `${imp.kind} · ${r.inserted} new · ${r.updated} changed · ${r.unchanged} unchanged`);
    h.back(req, res, '/admin/footfall/import?stay=1', 'ok', tr('ftf|Imported: {a} new hours, {b} changed, {c} already there.', { a: r.inserted, b: r.updated, c: r.unchanged }));
  });
  // forget staged files nobody finished after a day
  h.every('footfall-imports-cleanup', 6 * 60 * 60 * 1000, () => db.run("DELETE FROM footfall_imports WHERE status = 'staged' AND created_at < ?", new Date(Date.now() - 86400000).toISOString()));

  // ---------- entrances, capacity and the counters' connection ----------
  router.get('/footfall/setup', (req, res) => {
    const csrf = req.session.csrf;
    const mgr = h.can(req, 'manager');
    const list = db.all('SELECT e.*, (SELECT MAX(ts_hour) FROM footfall f WHERE f.entrance = e.code) last_hour FROM footfall_entrances e ORDER BY e.sort, e.code');
    const table = ui.table([
      { label: tr('ftf|Entrance or zone'), render: (e) => `<b>${ui.esc(tx(e.name))}</b><small class="sub"><bdi>${ui.esc(e.code)}</bdi> · ${ui.esc(tr(KINDS[e.kind] || KINDS.entrance))}${e.active ? '' : ` · ${ui.esc(tr('ftf|Hidden'))}`}</small>` },
      { label: tr('ftf|Last count'), render: (e) => (e.last_hour ? `${ui.date(e.last_hour.slice(0, 10))} ${e.last_hour.slice(11)}:00` : '—') },
      { label: '', render: (e) => (mgr ? ui.form(`/admin/footfall/entrances/${e.id}`, csrf, `<input type="hidden" name="active" value="${e.active ? 0 : 1}">${ui.btn(e.active ? tr('ftf|Hide') : tr('ftf|Show'), { cls: 'btn--ghost btn--xs' })}`) : '') },
    ], list, { empty: ui.esc(tr('ftf|No entrances yet. They are added from the first import.')) });
    const add = mgr ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${ui.esc(tr('ftf|Add an entrance or zone'))}</span></summary>${ui.form('/admin/footfall/entrances', csrf, `<div class="fields">${ui.input('code', tr('ftf|Code used by the counters'), '', { required: true, placeholder: 'N1' })}${ui.input('name', tr('Name'), '', { required: true, placeholder: tr('ftf|e.g. North entrance') })}${ui.select('kind', tr('Type'), tmap(KINDS), 'entrance')}</div>${ui.btn(tr('Add'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const cap = mgr ? ui.form('/admin/footfall/capacity', csrf, `<div class="fields">${ui.input('capacity', tr('ftf|Car park spaces'), capacity() || '', { type: 'number', min: 0, step: 1 })}</div>${ui.btn(tr('Save'), { cls: 'btn--ghost btn--sm' })}`, { cls: 'row' }) : `<p>${ui.esc(tr('ftf|Car park spaces'))}: <b>${ui.n0(capacity())}</b></p>`;
    const site = (h.env && h.env.SITE_URL) || `${req.protocol}://${req.get('host')}`;
    const keyOn = !!env('FOOTFALL_API_KEY');
    const hmacOn = !!env('FOOTFALL_HMAC_SECRET');
    // setting names as read-only fields, easy to copy into the hosting panel
    const envName = (k) => `<input class="envname" type="text" readonly value="${k}" size="${k.length}" aria-label="${ui.esc(tr('ftf|Setting name'))}" data-select>`;
    const last = db.get("SELECT created_at, inserted, updated FROM footfall_imports WHERE via = 'api' ORDER BY id DESC LIMIT 1");
    const sample = `POST ${site}/ingest/footfall
Authorization: Bearer <FOOTFALL_API_KEY>
Content-Type: application/json${hmacOn ? '\nX-Signature: sha256=<HMAC-SHA256 of the body>' : ''}

{"records": [{"time": "2026-10-28T14:00+02:00", "entrance": "N1", "in": 412, "out": 380}],
 "parking": [{"time": "2026-10-28T14:00+02:00", "entries": 96, "exits": 71, "occupancy": 540}]}`;
    const api = `<p>${ui.badge(keyOn ? 'on' : 'off', keyOn ? tr('ftf|Ready to receive') : tr('ftf|Not set up'), keyOn ? 'ok' : 'mute')} ${hmacOn ? ui.badge('on', tr('ftf|Signed requests required'), 'sky') : ''}</p>
      <p class="muted">${ui.esc(tr('ftf|The counters (or their cloud) send each hour\'s counts to this address. Sending the same hour again replaces it.'))}</p>
      <dl class="dl"><div><dt>${ui.esc(tr('ftf|Address'))}</dt><dd><code>${ui.esc(`${site}/ingest/footfall`)}</code></dd></div>
      <div><dt>${ui.esc(tr('ftf|Settings on the server'))}</dt><dd>${envName('FOOTFALL_API_KEY')} ${keyOn ? ui.badge('on', tr('ftf|set'), 'ok') : ui.badge('off', tr('ftf|missing'), 'mute')}<br>${envName('FOOTFALL_HMAC_SECRET')} ${hmacOn ? ui.badge('on', tr('ftf|set'), 'ok') : ui.badge('off', tr('ftf|optional'), 'mute')}</dd></div>
      ${last ? `<div><dt>${ui.esc(tr('ftf|Last delivery'))}</dt><dd>${ui.esc(ui.rel(last.created_at))} · ${ui.esc(tr('ftf|{a} new, {b} changed', { a: last.inserted, b: last.updated }))}</dd></div>` : ''}</dl>
      <textarea class="ftf-code" dir="ltr" rows="9" readonly aria-label="${ui.esc(tr('ftf|Example request'))}" data-select>${ui.esc(sample)}</textarea>`;
    const body = `${tabs('/admin/footfall/setup')}<div class="grid grid--side">
  <div class="stack">${ui.card(tr('ftf|Entrances and zones'), `${table}${add}`)}${ui.card(tr('ftf|Car park'), cap)}</div>
  ${ui.card(tr('ftf|Connect the counters'), api)}
</div>`;
    h.page(req, res, { title: tr('ftf|Entrances and counters'), crumbs: crumbs([null, tr('ftf|Entrances and counters')]), active: '/admin/footfall', wide: true, body });
  });
  router.post('/footfall/entrances', R('manager'), (req, res) => {
    const code = h.str(req.body.code, 20).toUpperCase();
    const name = h.str(req.body.name, 80);
    if (!code || !name) return h.back(req, res, '/admin/footfall/setup', 'error', tr('ftf|Give the entrance a code and a name.'));
    if (db.get('SELECT id FROM footfall_entrances WHERE code = ?', code)) return h.back(req, res, '/admin/footfall/setup', 'error', tr('ftf|{code} is already used.', { code }));
    db.run('INSERT INTO footfall_entrances (code, name, kind, sort, created_at) VALUES (?, ?, ?, ?, ?)', code, name, KINDS[req.body.kind] ? req.body.kind : 'entrance', (db.value('SELECT MAX(sort) FROM footfall_entrances') || 0) + 1, now());
    h.log(req, 'Added a footfall entrance', 'footfall_entrance', null, code);
    h.back(req, res, '/admin/footfall/setup', 'ok', tr('Saved.'));
  });
  router.post('/footfall/entrances/:id', R('manager'), (req, res) => {
    db.run('UPDATE footfall_entrances SET active = ? WHERE id = ?', req.body.active === '1' ? 1 : 0, h.int(req.params.id));
    h.back(req, res, '/admin/footfall/setup', 'ok', tr('Saved.'));
  });
  router.post('/footfall/capacity', R('manager'), (req, res) => {
    const n = h.int(req.body.capacity);
    db.setSetting('parking_capacity', n && n > 0 ? String(n) : '');
    h.log(req, 'Set the car park capacity', 'setting', null, String(n || ''));
    h.back(req, res, '/admin/footfall/setup', 'ok', tr('Saved.'));
  });

  // ---------- ingest: the counters push their counts ----------
  const ingestLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  h.public.post('/ingest/footfall', ingestLimit, express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }), (req, res) => {
    const key = env('FOOTFALL_API_KEY');
    if (!key) return res.status(503).json({ ok: false, error: 'Footfall ingest is not configured (FOOTFALL_API_KEY).' });
    const sent = String(req.get('x-api-key') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '')).trim();
    if (!sent || !same(crypto.createHash('sha256').update(sent).digest('hex'), crypto.createHash('sha256').update(key).digest('hex'))) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const secret = env('FOOTFALL_HMAC_SECRET');
    if (secret) {
      const sig = String(req.get('x-signature') || '').replace(/^sha256=/i, '').trim().toLowerCase();
      const want = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
      if (!/^[0-9a-f]{64}$/.test(sig) || !same(sig, want)) return res.status(401).json({ ok: false, error: 'Bad signature' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const recs = Array.isArray(body.records) ? body.records.slice(0, 20000) : [];
    const cars = Array.isArray(body.parking) ? body.parking.slice(0, 20000) : [];
    if (!recs.length && !cars.length) return res.status(422).json({ ok: false, error: 'Send records and/or parking arrays.' });
    const rejected = [];
    const ff = readRows(recs.map((r) => [r && (r.time ?? r.hour_start ?? r.ts), r && (r.entrance ?? r.door ?? r.zone), r && (r.in ?? r.visitors_in ?? r.count), r && (r.out ?? r.visitors_out)]), 'footfall', { time: 0, entrance: 1, in: 2, out: 3 });
    const pk = readRows(cars.map((r) => [r && (r.time ?? r.ts), r && (r.entries ?? r.in), r && (r.exits ?? r.out), r && r.occupancy, r && r.capacity]), 'parking', { time: 0, entries: 1, exits: 2, occupancy: 3, capacity: 4 });
    for (const b of ff.bad) rejected.push({ list: 'records', index: b.row - 2, reason: b.why });
    for (const b of pk.bad) rejected.push({ list: 'parking', index: b.row - 2, reason: b.why });
    const a = ff.records.length ? store(db, 'footfall', ff.records, { source: 'api' }) : { inserted: 0, updated: 0, unchanged: 0, created: [] };
    const b = pk.records.length ? store(db, 'parking', pk.records, { source: 'api' }) : { inserted: 0, updated: 0, unchanged: 0 };
    db.run("INSERT INTO footfall_imports (kind, via, status, rows, inserted, updated, unchanged, skipped, first_hour, last_hour, created_at) VALUES (?, 'api', 'done', ?, ?, ?, ?, ?, ?, ?, ?)",
      recs.length && cars.length ? 'both' : recs.length ? 'footfall' : 'parking', recs.length + cars.length, a.inserted + b.inserted, a.updated + b.updated, a.unchanged + b.unchanged, rejected.length,
      [a.first, b.first].filter(Boolean).sort()[0] || null, [a.last, b.last].filter(Boolean).sort().pop() || null, now());
    res.json({ ok: true, footfall: { inserted: a.inserted, updated: a.updated, unchanged: a.unchanged, new_entrances: a.created }, parking: { inserted: b.inserted, updated: b.updated, unchanged: b.unchanged }, rejected: rejected.slice(0, 50) });
  });

  // the card on the Integrations page
  (h.integrationCards = h.integrationCards || []).push({
    key: 'footfall',
    get title() { return tr('ftf|People counters and parking'); },
    get help() { return tr('ftf|Counters send hourly counts to /ingest/footfall with the API key. Set FOOTFALL_HMAC_SECRET to also require signed requests.'); },
    env: ['FOOTFALL_API_KEY', 'FOOTFALL_HMAC_SECRET'],
    href: '/admin/footfall/setup',
    get hrefLabel() { return tr('ftf|Set up'); },
    status: () => {
      const keyOn = !!env('FOOTFALL_API_KEY');
      const last = db.get("SELECT created_at FROM footfall_imports WHERE via = 'api' ORDER BY id DESC LIMIT 1");
      return {
        ok: keyOn,
        detail: keyOn
          ? (last ? tr('ftf|Last delivery {when}.', { when: ui.rel(last.created_at) }) : tr('ftf|Waiting for the first delivery.'))
          : tr('ftf|Set FOOTFALL_API_KEY on the server, then give the key to the counter supplier.'),
      };
    },
  });
  h.footfall = { store, readRows, hourKey };
};

module.exports.SCHEMA = SCHEMA;
module.exports.ensure = ensure;
module.exports.store = store;
module.exports.readRows = readRows;
module.exports.hourKey = hourKey;
module.exports.guessMap = guessMap;
