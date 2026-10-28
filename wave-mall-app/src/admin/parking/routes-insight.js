'use strict';

// Looking ahead and looking deeper (/admin/parking/forecast, /admin/parking/insight).
//
// Forecast, for the next 14 days: how many cars, how full at the busiest time, and how many cashiers
// to put on. Each weekday is learnt from the last eight weeks (recent weeks count more), adjusted by
// the last fortnight's trend and by the mall's events (the extra an event day brought before). Its
// accuracy is shown: the same forecast made for each of the last seven days, against what happened.
//
// Parking and sales: does free parking bring spending? Purchases recorded with validations against
// how long visitors stayed; for each shop, purchases for each pound of parking it gave free; month by
// month, cars against the tenants' reported sales.

const { t: tr, tx, isAr } = require('../i18n');
const T = require('./tariff');
const { cairo } = require('../ops-common');

module.exports = function insightRoutes(router, h, c) {
  const { db, ui } = h;
  const { P, esc } = c;
  const r2 = T.r2;
  const SUB = [['/admin/parking/reports', 'prk|Overview'], ['/admin/parking/forecast', 'prk|Forecast'], ['/admin/parking/insight', 'prk|Parking and sales']];
  const head = (on) => `${c.tabs(on)}${c.subtabs(on, SUB)}`;
  const hasTable = (n) => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", n);
  const weekday = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0

  // ---------- the history, day by day ----------
  // For each Cairo day: cars in, cars in and out by hour, cars parked at the end of each hour.
  function history(days = 63, end = c.today()) {
    const first = P.addDays(end, -days);
    const rows = db.all("SELECT entry_at, exit_at FROM pk_sessions WHERE status != 'void' AND (exit_at IS NULL OR exit_at >= ?) AND entry_at < ?", c.dayStart(first), c.dayStart(P.addDays(end, 1)));
    const map = new Map();
    for (let i = 0; i <= days; i++) {
      const d = P.addDays(first, i);
      map.set(d, { d, entries: 0, inByHour: Array(24).fill(0), outByHour: Array(24).fill(0), occ: Array(24).fill(0) });
    }
    const evs = [];
    for (const s of rows) {
      const a = Date.parse(s.entry_at);
      const ca = cairo(new Date(a));
      if (map.has(ca.date)) { const x = map.get(ca.date); x.entries++; x.inByHour[ca.hour]++; }
      evs.push([a, 1]);
      if (s.exit_at) {
        const b = Date.parse(s.exit_at);
        const cb = cairo(new Date(b));
        if (map.has(cb.date)) map.get(cb.date).outByHour[cb.hour]++;
        evs.push([b, -1]);
      }
    }
    // cars parked at the end of each hour: one sweep through entries and exits
    evs.sort((x, y) => x[0] - y[0]);
    let i = 0;
    let inside = 0;
    for (const x of map.values()) {
      for (let hr = 0; hr < 24; hr++) {
        const until = Date.parse(c.dayStart(x.d)) + (hr + 1) * 3600000;
        while (i < evs.length && evs[i][0] < until) inside += evs[i++][1];
        x.occ[hr] = Math.max(0, inside);
      }
    }
    return map;
  }
  // the mall's published events (website), by day
  function eventDays(from, to) {
    if (!hasTable('web_events')) return new Map();
    const out = new Map();
    for (const e of db.all('SELECT title, title_ar, starts_on, COALESCE(ends_on, starts_on) ends_on FROM web_events WHERE published = 1 AND starts_on <= ? AND COALESCE(ends_on, starts_on) >= ?', to, from)) {
      for (let d = e.starts_on < from ? from : e.starts_on; d <= e.ends_on && d <= to; d = P.addDays(d, 1)) (out.get(d) || out.set(d, []).get(d)).push(isAr() && e.title_ar ? e.title_ar : tx(e.title));
    }
    return out;
  }

  // ---------- the model ----------
  // Forecast the days after `asOf` from the history before it.
  function model(hist, asOf, evDays) {
    // whole days only: today is still under way
    const past = [...hist.values()].filter((x) => x.d < asOf && x.d < c.today() && (x.entries > 0 || x.occ.some(Boolean)));
    const normal = past.filter((x) => !evDays.has(x.d));
    const sameDay = (wd) => normal.filter((x) => weekday(x.d) === wd).slice(-6);
    const weighted = (xs, f) => {
      let s = 0;
      let w = 0;
      xs.forEach((x, k) => { s += f(x) * (k + 1); w += k + 1; });
      return w ? s / w : 0;
    };
    const base = (wd) => weighted(sameDay(wd), (x) => x.entries);
    // the last fortnight against the one before, half weight, kept within ±15%
    const sum = (a, b) => past.filter((x) => x.d >= P.addDays(asOf, -a) && x.d < P.addDays(asOf, -b)).reduce((s, x) => s + x.entries, 0);
    const recent = sum(14, 0);
    const before = sum(28, 14);
    const trend = before > 0 ? Math.min(1.15, Math.max(0.85, 1 + (recent / before - 1) / 2)) : 1;
    // what an event day brought before
    const evPast = past.filter((x) => evDays.has(x.d) && base(weekday(x.d)) > 0);
    const uplift = evPast.length ? Math.min(2, Math.max(1, evPast.reduce((s, x) => s + x.entries / base(weekday(x.d)), 0) / evPast.length)) : 1.3;
    // how full, and when: the share of the day's cars parked at once, and the busiest hour
    const shape = (wd) => {
      const xs = sameDay(wd).filter((x) => x.entries > 0);
      const ratio = xs.length ? weighted(xs, (x) => Math.max(...x.occ) / x.entries) : 0.35;
      const occ = Array.from({ length: 24 }, (_, hr) => weighted(xs, (x) => x.occ[hr]));
      const out = Array.from({ length: 24 }, (_, hr) => weighted(xs, (x) => x.outByHour[hr] / Math.max(1, x.entries)));
      return { ratio, peakHour: occ.indexOf(Math.max(...occ)), exitShare: out };
    };
    return { base, trend, uplift, shape };
  }
  function forecast({ days = 14, from = P.addDays(c.today(), 1) } = {}) {
    const hist = history(63, c.today());
    const to = P.addDays(from, days - 1);
    const evDays = eventDays(P.addDays(c.today(), -70), to);
    const m = model(hist, from, evDays);
    const cap = P.capacity();
    // how many exits pay at the booth (the rest pay by phone, at a machine, or have nothing to pay)
    const since = c.dayStart(P.addDays(c.today(), -30));
    const exits = db.value("SELECT COUNT(*) FROM pk_sessions WHERE status = 'left' AND exit_at >= ?", since) || 1;
    const atBooth = db.value("SELECT COUNT(DISTINCT p.session_id) FROM pk_payments p JOIN pk_tills t ON t.id = p.till_id WHERE t.kind = 'booth' AND p.at >= ? AND p.status = 'ok'", since);
    const boothShare = Math.min(1, atBooth / exits);
    const rate = Math.max(20, Number(db.setting('prk_lane_rate')) || 90);
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = P.addDays(from, i);
      const wd = weekday(d);
      const ev = evDays.get(d) || [];
      const cars = Math.round(m.base(wd) * m.trend * (ev.length ? m.uplift : 1));
      const sh = m.shape(wd);
      const peak = Math.min(cap || Infinity, Math.round(cars * sh.ratio));
      const busiest = (lo, hi) => Math.max(0, ...sh.exitShare.slice(lo, hi)) * cars;
      const cashiers = (n) => (n > 0 ? Math.max(1, Math.ceil((n * boothShare) / rate)) : 0);
      out.push({ d, wd, cars, peak, pct: cap ? peak / cap : null, peakHour: sh.peakHour, events: ev, day: cashiers(busiest(8, 16)), evening: cashiers(Math.max(busiest(16, 24), busiest(0, 3))) });
    }
    // accuracy: the same forecast for each of the last seven days
    const errs = [];
    for (let k = 1; k <= 7; k++) {
      const d = P.addDays(c.today(), -k);
      const actual = hist.get(d);
      if (!actual || !actual.entries) continue;
      const mm = model(hist, d, evDays);
      const guess = mm.base(weekday(d)) * mm.trend * (evDays.has(d) ? mm.uplift : 1);
      if (guess > 0) errs.push(Math.abs(guess - actual.entries) / actual.entries);
    }
    return { days: out, trend: m.trend, uplift: m.uplift, boothShare, rate, accuracy: errs.length ? 1 - errs.reduce((s, x) => s + x, 0) / errs.length : null };
  }
  h.parking.forecast = forecast;

  router.get('/parking/forecast', (req, res) => {
    const f = forecast();
    const names = ui.weekdays();
    const series = f.days.map((x) => ({ label: `${names[x.wd]} ${Number(x.d.slice(8))}${x.events.length ? '★' : ''}`, cars: x.cars }));
    const risk = (x) => (x.pct === null ? '' : x.pct >= 0.95 ? ui.badge('full', tr('prk|Likely full'), 'rose') : x.pct >= 0.8 ? ui.badge('busy', tr('prk|Busy'), 'amber') : ui.badge('ok', tr('prk|Comfortable'), 'ok'));
    const table = ui.table([
      { label: tr('prk|Day'), render: (x) => `<b>${esc(names[x.wd])}</b> ${esc(ui.date(x.d))}${x.events.length ? `<small class="sub">★ ${esc(x.events.join(' · '))}</small>` : ''}` },
      { label: tr('prk|Cars expected'), num: true, render: (x) => ui.n0(x.cars) },
      { label: tr('prk|Busiest time'), render: (x) => esc(`${String(x.peakHour).padStart(2, '0')}:00`) },
      { label: tr('prk|Parked at once'), num: true, render: (x) => `${ui.n0(x.peak)}${x.pct !== null ? `<small class="sub">${ui.pct(x.pct)}</small>` : ''}` },
      { label: tr('prk|How full'), render: risk },
      { label: tr('prk|Cashiers, day / evening'), num: true, render: (x) => `${x.day} / ${x.evening}` },
    ], f.days, { empty: esc(tr('prk|Not enough visits yet.')) });
    const kpis = [
      ui.kpi({ label: tr('prk|Cars in the next 7 days'), value: ui.n0(f.days.slice(0, 7).reduce((s, x) => s + x.cars, 0)) }),
      ui.kpi({ label: tr('prk|Days likely to be full'), value: ui.n0(f.days.filter((x) => x.pct !== null && x.pct >= 0.95).length) }),
      ui.kpi({ label: tr('prk|Trend'), value: `${f.trend >= 1 ? '▲' : '▼'} ${Math.abs((f.trend - 1) * 100).toFixed(0)}%`, sub: esc(tr('prk|last two weeks against the two before')) }),
      ui.kpi({ label: tr('prk|Accuracy last week'), value: f.accuracy === null ? '—' : ui.pct(Math.max(0, f.accuracy)), sub: esc(tr('prk|how close the forecast came')) }),
    ].join('');
    const how = `<p class="muted small">${esc(tr('prk|Each weekday is learnt from the last eight weeks, recent weeks counting more, then adjusted by the trend and by the mall’s events on the website (an event day has brought {n}% more cars). Cashiers: the busiest hour’s exits paying at the booth ({share}%), {rate} cars an hour each.', { n: Math.round((f.uplift - 1) * 100), share: Math.round(f.boothShare * 100), rate: f.rate }))}</p>`;
    c.page(req, res, { title: tr('prk|Forecast'), crumbs: c.crumbs(['/admin/parking/reports', tr('prk|Reports')], [null, tr('prk|Forecast')]), body: `${head('/admin/parking/forecast')}<div class="kpis kpis--4">${kpis}</div>${ui.card(tr('prk|Cars expected, day by day'), `${ui.bars(series, { key: 'cars', label: 'label', h: 170, tone: 'sea' })}${how}`, { sub: esc(tr('prk|★ marks a day with a mall event.')) })}${ui.card(tr('prk|The next two weeks'), table)}` });
  });

  // ---------- parking and sales ----------
  router.get('/parking/insight', (req, res) => {
    const since = c.dayStart(P.addDays(c.today(), -90));
    const vals = db.all(`SELECT v.brand_id, v.purchase, v.value, v.share, s.entry_at, s.exit_at FROM pk_validations v JOIN pk_sessions s ON s.id = v.session_id
      WHERE v.status = 'ok' AND v.at >= ? AND s.status = 'left'`, since);
    const BUCKETS = [[60, 'prk|Under 1 h'], [120, 'prk|1–2 h'], [180, 'prk|2–3 h'], [300, 'prk|3–5 h'], [Infinity, 'prk|Over 5 h']];
    const withP = vals.filter((v) => v.purchase > 0);
    const buckets = BUCKETS.map(([max], i) => {
      const xs = withP.filter((v) => { const m = T.minutesBetween(v.entry_at, v.exit_at); return m < max && m >= (i ? BUCKETS[i - 1][0] : 0); });
      return { label: tr(BUCKETS[i][1]), n: xs.length, avg: xs.length ? Math.round(xs.reduce((s, v) => s + v.purchase, 0) / xs.length) : 0 };
    });
    const firstAvg = buckets.find((b) => b.n >= 5);
    const bestAvg = [...buckets].filter((b) => b.n >= 5).sort((a, b) => b.avg - a.avg)[0];
    // worth saying only when longer stays clearly spend more
    const mid = (l) => (isAr() ? l : l.charAt(0).toLowerCase() + l.slice(1));
    const headline = firstAvg && bestAvg && bestAvg !== firstAvg && firstAvg.avg > 0 && bestAvg.avg / firstAvg.avg >= 1.15
      ? tr('prk|Visitors who stay {b} spend {x} times as much as those who stay {a}.', { b: mid(bestAvg.label), a: mid(firstAvg.label), x: (bestAvg.avg / firstAvg.avg).toFixed(1) }) : '';
    // shops: purchases for each pound of parking given free
    const shops = db.all(`SELECT b.id, b.name, COUNT(*) n, COALESCE(SUM(v.purchase), 0) bought, COALESCE(SUM(v.value), 0) value, COALESCE(SUM(v.value * v.share / 100.0), 0) paid
      FROM pk_validations v JOIN brands b ON b.id = v.brand_id JOIN pk_sessions s ON s.id = v.session_id WHERE v.status = 'ok' AND v.at >= ? AND s.status = 'left' GROUP BY b.id ORDER BY n DESC`, since);
    const shopTable = ui.table([
      { label: tr('prk|Shop'), render: (x) => `<b>${esc(x.name)}</b>` },
      { label: tr('prk|Validations'), num: true, render: (x) => ui.n0(x.n) },
      { label: tr('prk|Purchases recorded'), num: true, render: (x) => c.money(x.bought) },
      { label: tr('prk|Parking given free'), num: true, render: (x) => c.money(r2(x.value)) },
      { label: tr('prk|Sales per pound of parking'), num: true, render: (x) => (x.value > 0 && x.bought > 0 ? `<b>${(x.bought / x.value).toFixed(1)}</b>` : '—') },
    ], shops, { empty: esc(tr('prk|No validations with purchases yet.')) });
    // month by month: cars against tenants' sales
    const months = Array.from({ length: 6 }, (_, i) => P.addMonths(`${c.today().slice(0, 7)}-01`, -5 + i).slice(0, 7));
    const sales = new Map(hasTable('tenant_sales') ? db.all(`SELECT period, SUM(amount) amount FROM tenant_sales WHERE period IN (${months.map(() => '?').join(',')}) GROUP BY period`, ...months).map((x) => [x.period, x.amount]) : []);
    const rows = months.map((m) => {
      const from = c.dayStart(`${m}-01`);
      const to = c.dayStart(P.addMonths(`${m}-01`, 1));
      const cars = db.value("SELECT COUNT(*) FROM pk_sessions WHERE status != 'void' AND entry_at >= ? AND entry_at < ?", from, to);
      const validated = db.value("SELECT COUNT(DISTINCT session_id) FROM pk_validations WHERE status = 'ok' AND at >= ? AND at < ?", from, to);
      const amount = sales.get(m) || 0;
      return { m, cars, validated, sales: amount, per: cars && amount ? amount / cars : null };
    }).filter((x) => x.cars || x.sales);
    // how closely cars and sales move together, month to month
    const both = rows.filter((x) => x.cars && x.sales);
    let corr = null;
    if (both.length >= 4) {
      const mx = both.reduce((s, x) => s + x.cars, 0) / both.length;
      const my = both.reduce((s, x) => s + x.sales, 0) / both.length;
      const cov = both.reduce((s, x) => s + (x.cars - mx) * (x.sales - my), 0);
      const vx = Math.sqrt(both.reduce((s, x) => s + (x.cars - mx) ** 2, 0));
      const vy = Math.sqrt(both.reduce((s, x) => s + (x.sales - my) ** 2, 0));
      corr = vx && vy ? cov / (vx * vy) : null;
    }
    const monthTable = ui.table([
      { label: tr('prk|Month'), render: (x) => esc(ui.monthYear(x.m)) },
      { label: tr('prk|Cars'), num: true, render: (x) => ui.n0(x.cars) },
      { label: tr('prk|Validated'), num: true, render: (x) => (x.cars ? ui.pct(x.validated / x.cars) : '—') },
      { label: tr('prk|Tenant sales'), num: true, render: (x) => (x.sales ? ui.money(x.sales, { compact: true }) : '—') },
      { label: tr('prk|Sales per car'), num: true, render: (x) => (x.per ? `<b>${c.money(Math.round(x.per))}</b>` : '—') },
    ], rows, { empty: esc(tr('prk|No months with cars yet.')) });
    const kpis = [
      ui.kpi({ label: tr('prk|Visits validated (90 days)'), value: ui.n0(vals.length) }),
      ui.kpi({ label: tr('prk|Average purchase'), value: withP.length ? c.money(Math.round(withP.reduce((s, v) => s + v.purchase, 0) / withP.length)) : '—' }),
      ui.kpi({ label: tr('prk|Sales per pound of parking'), value: (() => { const v = shops.reduce((s, x) => s + x.value, 0); const b = shops.reduce((s, x) => s + x.bought, 0); return v > 0 && b > 0 ? (b / v).toFixed(1) : '—'; })(), sub: esc(tr('prk|purchases recorded for each pound given free')) }),
      ui.kpi({ label: tr('prk|Cars and sales move together'), value: corr === null ? '—' : `${Math.round(corr * 100)}%`, sub: esc(corr === null ? tr('prk|needs four months of both') : corr > 0.6 ? tr('prk|strongly') : corr > 0.3 ? tr('prk|somewhat') : tr('prk|hardly')) }),
    ].join('');
    c.page(req, res, {
      title: tr('prk|Parking and sales'), crumbs: c.crumbs(['/admin/parking/reports', tr('prk|Reports')], [null, tr('prk|Parking and sales')]),
      body: `${head('/admin/parking/insight')}<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side">${ui.card(tr('prk|Time parked and spending'), `${ui.bars(buckets, { key: 'avg', label: 'label', h: 160, tone: 'cocoa', fmtv: (v) => ui.n0(v) })}${headline ? `<p class="pk-insight">${esc(headline)}</p>` : ''}`, { sub: esc(tr('prk|Average purchase recorded with a validation, by how long the visitor stayed (last 90 days)')) })}${ui.card(tr('prk|Month by month'), monthTable, { sub: esc(tr('prk|Cars against the sales tenants reported')) })}</div>
${ui.card(tr('prk|Free parking and shops’ sales'), shopTable, { sub: esc(tr('prk|For each shop, the purchases it recorded when validating, for each pound of parking it gave free (last 90 days).')) })}`,
    });
  });
};
