'use strict';

// Utilities: the meters (electricity, chilled water, water, gas) on tenant units and common areas,
// tariffs (flat or tiered, with a fixed monthly charge), the monthly reading round (a grid or a
// pasted sheet), consumption with checks (meter rollover, a drop, abnormal use), billing of each
// tenant's consumption once per meter and month, and the common areas' cost fed to the
// service charge's actual costs.

const i18n = require('../i18n');
const { t: tr, tn, tx } = i18n;

const UTIL = {
  electricity: { label: 'utl|Electricity', unit: 'utl|kWh', tone: 'amber' },
  chilled: { label: 'utl|Chilled water', unit: 'utl|RTh', tone: 'sky' },
  water: { label: 'utl|Water', unit: 'utl|m³', tone: 'sea' },
  gas: { label: 'utl|Gas', unit: 'utl|m³', tone: 'cocoa' },
};
const FLAGS = {
  first: ['utl|First reading', 'mute'], rollover: ['utl|Meter rolled over', 'sky'], negative: ['utl|Lower than last month', 'rose'], abnormal: ['utl|Unusual consumption', 'amber'],
};
// Starting tariffs (EGP, before VAT): placeholders to confirm against the supply contracts.
const DEFAULT_TARIFFS = [
  { utility: 'electricity', rate: 2.1, fixed_monthly: 0, tiers: null, vat_note: 'Electricity is billed without VAT' },
  { utility: 'chilled', rate: 9.5, fixed_monthly: 150, tiers: null, vat_note: null },
  { utility: 'water', rate: 21, fixed_monthly: 0, tiers: null, vat_note: null },
  { utility: 'gas', rate: 4.5, fixed_monthly: 0, tiers: null, vat_note: null },
];
const REVIEW = (flag) => !!flag && /negative|abnormal|rollover/.test(flag);

module.exports = function utilities(router, h, X) {
  const { db, ui, M } = h;
  const { C } = X;
  const R = h.R;

  if (!db.value('SELECT COUNT(*) FROM utl_tariffs')) {
    for (const t of DEFAULT_TARIFFS) db.run('INSERT INTO utl_tariffs (utility, rate, fixed_monthly, tiers, vat_note, valid_from, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)', t.utility, t.rate, t.fixed_monthly, t.tiers, t.vat_note, '2020-01-01', M.now());
  }

  const uLabel = (k) => tr((UTIL[k] || UTIL.electricity).label);
  const uUnit = (k) => tr((UTIL[k] || UTIL.electricity).unit);
  const qty = (n, k) => (n === null || n === undefined ? '—' : `${ui.n0(Math.round(n))} ${uUnit(k)}`);
  const flagBadges = (flag) => String(flag || '').split(',').filter((f) => FLAGS[f]).map((f) => ui.badge(f, tr(FLAGS[f][0]), FLAGS[f][1])).join(' ');

  // ---------- facts ----------
  const meterOf = (id) => db.get('SELECT m.*, u.code unit_code, u.indoor_m2 FROM utl_meters m LEFT JOIN units u ON u.id = m.unit_id WHERE m.id = ?', id);
  const meters = ({ active = true } = {}) => db.all(`SELECT m.*, u.code unit_code, u.indoor_m2 FROM utl_meters m LEFT JOIN units u ON u.id = m.unit_id ${active ? 'WHERE m.active = 1' : ''} ORDER BY m.utility, m.unit_id IS NULL, u.sort, m.code`);
  const readingOf = (meterId, period) => db.get('SELECT * FROM utl_readings WHERE meter_id = ? AND period = ?', meterId, period);
  const prevReading = (meterId, period) => db.get('SELECT * FROM utl_readings WHERE meter_id = ? AND period < ? ORDER BY period DESC LIMIT 1', meterId, period);
  const history = (meterId, period) => db.all('SELECT consumption FROM utl_readings WHERE meter_id = ? AND period < ? AND consumption IS NOT NULL ORDER BY period DESC LIMIT 3', meterId, period).map((r) => r.consumption).reverse();
  const isBilled = (meterId, period) => !!db.get('SELECT id FROM utl_bills WHERE meter_id = ? AND period = ?', meterId, period);
  // the tariff in force at the end of a month
  const tariffFor = (utility, period) => db.get('SELECT * FROM utl_tariffs WHERE utility = ? AND valid_from <= ? ORDER BY valid_from DESC, id DESC LIMIT 1', utility, `${period}-${String(C.daysIn(period)).padStart(2, '0')}`);
  const costOf = (meter, consumption, period) => C.tariffCost(consumption, tariffFor(meter.utility, period));

  // (Re)work out a reading's consumption and flag from the reading before it.
  function compute(meter, period) {
    const r = readingOf(meter.id, period);
    if (!r) return null;
    const prev = prevReading(meter.id, period);
    const c = C.consumption({ previous: prev ? prev.reading : null, reading: r.reading, digits: meter.digits, multiplier: meter.multiplier, history: history(meter.id, period) });
    // a first reading only sets the starting point; nothing to bill
    const accepted = r.accepted && r.flag === c.flag ? 1 : REVIEW(c.flag) ? 0 : 1;
    db.run('UPDATE utl_readings SET consumption = ?, flag = ?, accepted = ? WHERE id = ?', c.consumption, c.flag, accepted, r.id);
    feedCommon(meter, period);
    return readingOf(meter.id, period);
  }
  // Common-area meters: the month's cost becomes a service-charge actual (category: common-area utilities).
  function feedCommon(meter, period) {
    if (meter.unit_id || !X.svc) return;
    const r = readingOf(meter.id, period);
    const ref = `meter:${meter.id}:${period}`;
    const year = Number(period.slice(0, 4));
    if (db.get('SELECT id FROM sc_recons WHERE year = ? LIMIT 1', year)) return; // the year is settled
    if (!r || r.consumption === null || !r.accepted) {
      db.run("DELETE FROM sc_actuals WHERE source = 'utilities' AND source_ref = ?", ref);
      return;
    }
    const cost = costOf(meter, r.consumption, period);
    if (cost > 0) X.svc.addActual({ year, period, category: 'utilities', amount: cost, description: `Meter ${meter.code}, ${Math.round(r.consumption)} ${UTIL[meter.utility].unit.slice(4)}`, source: 'utilities', source_ref: ref, demo: meter.demo });
  }

  // Save one reading (grid, import or the meter page). Returns the reading with its consumption.
  function saveReading(meter, period, value, { user = null, readOn = null, note = null, demo = 0 } = {}) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('utl|Choose a month.');
    if (period > C.ymOf(M.today())) throw new Error('utl|Readings cannot be entered for a future month.');
    const v = C.num(value);
    if (v === null || v < 0) throw new Error('utl|Enter the meter reading.');
    if (v >= 10 ** meter.digits) throw new Error('utl|The reading has more digits than the meter.');
    if (isBilled(meter.id, period)) throw new Error('utl|This month is billed, so its reading is locked.');
    const old = readingOf(meter.id, period);
    if (old && old.reading === v) return old;
    if (old) db.run('UPDATE utl_readings SET reading = ?, read_on = COALESCE(?, read_on), note = COALESCE(?, note), accepted = 0, flag = NULL, user_id = ? WHERE id = ?', v, readOn, note, user ? user.id : null, old.id);
    else db.run('INSERT INTO utl_readings (meter_id, period, reading, read_on, note, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', meter.id, period, v, readOn || M.today(), note, user ? user.id : null, demo ? 1 : 0, M.now());
    const r = compute(meter, period);
    // the next month's consumption depends on this reading
    const next = db.get('SELECT period FROM utl_readings WHERE meter_id = ? AND period > ? ORDER BY period LIMIT 1', meter.id, period);
    if (next && !isBilled(meter.id, next.period)) compute(meter, next.period);
    return r;
  }

  // What billing a month would produce: for each tenant meter, its lease and cost.
  function preview(period) {
    const out = { lines: [], blocked: [], vacant: [], done: [] };
    for (const m of meters().filter((x) => x.unit_id)) {
      const r = readingOf(m.id, period);
      if (isBilled(m.id, period)) { out.done.push({ m, r }); continue; }
      if (!r) { out.blocked.push({ m, why: 'missing' }); continue; }
      if (r.consumption === null) { if (r.flag !== 'first') out.blocked.push({ m, r, why: 'negative' }); continue; }
      if (!r.accepted) { out.blocked.push({ m, r, why: 'review' }); continue; }
      const lease = X.leaseForUnit(m.unit_id, period);
      const cost = costOf(m, r.consumption, period);
      if (!lease) out.vacant.push({ m, r, cost });
      else out.lines.push({ m, r, lease, cost });
    }
    return out;
  }
  // Bill a month: one invoice per lease (all its meters), recorded per meter so a meter-month is
  // never billed twice. Consumption of vacant units is recorded as the landlord's.
  function bill(period, user, { demo = 0 } = {}) {
    if (!/^\d{4}-\d{2}$/.test(period) || period > C.ymOf(M.today())) throw new Error('utl|Choose a month.');
    const p = preview(period);
    const byLease = {};
    for (const l of p.lines) (byLease[l.lease.id] = byLease[l.lease.id] || { lease: l.lease, lines: [] }).lines.push(l);
    let invoices = 0;
    let total = 0;
    db.tx(() => {
      for (const { lease, lines } of Object.values(byLease)) {
        const sum = C.r2(lines.reduce((t, l) => t + l.cost, 0));
        let invoiceId = null;
        if (sum > 0) {
          const { net, uses } = X.takeCredits(lease.id, sum);
          if (net > 0) {
            const detail = lines.map((l) => `${l.m.code} ${Math.round(l.r.consumption)}`).join(', ');
            const inv = h.billing.createInvoice({
              lease_id: lease.id, kind: 'utility', other: net, due_date: M.addDays(M.today(), 14), source: 'utility', source_id: lines[0].r.id, demo,
              period_start: `${period}-01`, period_end: `${period}-${String(C.daysIn(period)).padStart(2, '0')}`,
              note: uses.length ? `Utilities ${period} (${detail}), less credit ${X.creditNote(uses)}` : `Utilities ${period} (${detail})`,
            }, { user });
            invoiceId = inv.id;
            invoices++;
            total += net;
          }
          X.recordUses(uses, invoiceId, 'utility', `${period}:${lease.id}`);
        }
        for (const l of lines) db.run('INSERT INTO utl_bills (meter_id, period, lease_id, consumption, amount, invoice_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', l.m.id, period, lease.id, l.r.consumption, l.cost, invoiceId, demo ? 1 : 0, M.now());
      }
      for (const v of p.vacant) db.run('INSERT INTO utl_bills (meter_id, period, lease_id, consumption, amount, invoice_id, demo, created_at) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)', v.m.id, period, v.r.consumption, v.cost, demo ? 1 : 0, M.now());
    });
    return { invoices, total: C.r2(total), blocked: p.blocked.length, vacant: p.vacant.length };
  }

  // monthly consumption by utility, tenants and common areas
  function series(utility, months) {
    return months.map((ym) => {
      const row = db.get(
        'SELECT COALESCE(SUM(CASE WHEN m.unit_id IS NOT NULL THEN r.consumption END), 0) tenants, COALESCE(SUM(CASE WHEN m.unit_id IS NULL THEN r.consumption END), 0) common FROM utl_readings r JOIN utl_meters m ON m.id = r.meter_id WHERE m.utility = ? AND r.period = ? AND r.consumption IS NOT NULL',
        utility, ym,
      );
      return { ym, label: X.shortMonth(ym), total: C.r2(row.tenants + row.common), tenants: C.r2(row.tenants), common: C.r2(row.common) };
    });
  }
  const toReview = () => db.all("SELECT r.*, m.code, m.utility FROM utl_readings r JOIN utl_meters m ON m.id = r.meter_id WHERE r.accepted = 0 AND m.active = 1 AND NOT EXISTS (SELECT 1 FROM utl_bills b WHERE b.meter_id = r.meter_id AND b.period = r.period) ORDER BY r.period DESC");

  // ---------- pages ----------
  const nav = (active) => X.tabs([['/admin/utilities', tr('utl|Overview')], ['/admin/utilities/readings', tr('utl|Readings')], ['/admin/utilities/billing', tr('utl|Billing')], ['/admin/utilities/meters', tr('utl|Meters')], ['/admin/utilities/tariffs', tr('utl|Tariffs')]], active);
  const unconfirmed = () => db.value('SELECT COUNT(*) FROM utl_tariffs t WHERE confirmed = 0 AND id = (SELECT id FROM utl_tariffs x WHERE x.utility = t.utility ORDER BY valid_from DESC, id DESC LIMIT 1)');
  const tariffBanner = () => (unconfirmed() ? `<p class="alert alert--warn">${ui.icon('gauge')} ${ui.esc(tr('utl|Some tariffs are starting values, not yet checked against the supply contracts.'))} <a href="/admin/utilities/tariffs">${ui.esc(tr('utl|Check the tariffs'))}</a></p>` : '');
  const monthPick = (path, period) => {
    const months = C.ymRange(C.ymAdd(C.ymOf(M.today()), -17), C.ymOf(M.today())).reverse();
    return `<form class="filters" method="get" action="${path}">${ui.select('period', tr('utl|Month'), months.map((m) => [m, ui.monthYear(m)]), period, { cls: 'f--inline', attrs: { 'data-autosubmit': true } })}${ui.btn(tr('utl|Show'), { cls: 'btn--ghost btn--sm' })}</form>`;
  };
  const periodOfReq = (req) => (/^\d{4}-\d{2}$/.test(String(req.query.period || req.body.period || '')) && String(req.query.period || req.body.period) <= C.ymOf(M.today()) ? String(req.query.period || req.body.period) : X.lastMonth());
  const where = (m) => (m.unit_id ? `${tr('utl|Unit {code}', { code: m.unit_code })}` : tx(m.area) || tr('utl|Common area'));

  router.get('/utilities', (req, res) => {
    const LM = X.lastMonth();
    const months = C.ymRange(C.ymAdd(LM, -11), LM);
    const all = meters();
    const read = db.value('SELECT COUNT(*) FROM utl_readings r JOIN utl_meters m ON m.id = r.meter_id WHERE m.active = 1 AND r.period = ?', LM);
    // the chart starts with the first consumption (at least six months shown)
    const first = db.value('SELECT MIN(period) FROM utl_readings WHERE consumption IS NOT NULL') || LM;
    const elec = series('electricity', months.filter((ym) => ym >= [first, C.ymAdd(LM, -5)].sort()[0]));
    const year = String(X.thisYear());
    const billed = db.value("SELECT COALESCE(SUM(total), 0) FROM invoices WHERE kind = 'utility' AND status != 'void' AND substr(period_start, 1, 4) = ?", year);
    const review = toReview();
    const kpis = [
      ui.kpi({ label: tr('utl|Electricity, {month}', { month: ui.monthYear(LM) }), value: qty(elec.at(-1).total, 'electricity'), sub: elec.length > 1 && elec.at(-2).total ? `${X.change(elec.at(-1).total, elec.at(-2).total)} ${ui.esc(tr('utl|on the month before'))}` : '' }),
      ui.kpi({ label: tr('utl|Readings in for {month}', { month: ui.monthYear(LM) }), value: `${ui.n0(read)} / ${ui.n0(all.length)}`, bar: all.length ? read / all.length : null, href: `/admin/utilities/readings?period=${LM}` }),
      ui.kpi({ label: tr('utl|Readings to review'), value: ui.n0(review.length), tone: review.length ? 'kpi--alert' : '', href: '/admin/utilities/readings#review', sub: ui.esc(tr('utl|rollover, drops and unusual use')) }),
      ui.kpi({ label: tr('utl|Utilities billed in {year}', { year }), value: ui.money(billed, { compact: true }), href: '/admin/utilities/billing' }),
    ].join('');
    const stack = (s) => `<div class="bars utl-stack" style="--h:170px">${s.map((x) => { const max = Math.max(1, ...s.map((y) => y.total)); return `<div class="bars__c"><b>${x.total ? ui.n0(Math.round(x.total / 1000)) + (i18n.isAr() ? ' ألف' : 'k') : ''}</b><div class="bars__t"><i class="t-forest" style="height:${(x.tenants / max) * 100}%"></i><i class="t-sand" style="height:${(x.common / max) * 100}%"></i></div><span>${ui.esc(x.label)}</span></div>`; }).join('')}</div><p class="rev-key small muted"><i class="rev-key__sw t-forest"></i>${ui.esc(tr('utl|Tenants'))} <i class="rev-key__sw t-sand"></i>${ui.esc(tr('utl|Common areas'))}</p>`;
    const util = Object.keys(UTIL).map((k) => {
      const s = series(k, [C.ymAdd(LM, -1), LM]);
      const n = all.filter((m) => m.utility === k).length;
      return n ? `<li><span class="dot dot--${UTIL[k].tone}"></span><span>${ui.esc(uLabel(k))}<small class="muted"> · ${ui.esc(tn(n, 'utl|{n} meter', 'utl|{n} meters'))}</small></span><b>${qty(s[1].total, k)}</b><small>${X.change(s[1].total, s[0].total)}</small></li>` : '';
    }).join('');
    // intensity: electricity per m² of tenant units (last month)
    const top = all.filter((m) => m.unit_id && m.utility === 'electricity').map((m) => {
      const r = readingOf(m.id, LM);
      const lease = X.leaseForUnit(m.unit_id, LM);
      const trend = months.map((ym) => { const x = readingOf(m.id, ym); return x ? x.consumption : null; });
      return { m, r, lease, perM2: r && r.consumption !== null && m.indoor_m2 ? r.consumption / m.indoor_m2 : null, trend };
    }).filter((x) => x.r && x.r.consumption !== null).sort((a, b) => (b.perM2 ?? 0) - (a.perM2 ?? 0));
    const topTable = ui.table(
      [
        { label: tr('utl|Meter'), render: (x) => `<b>${ui.esc(x.m.code)}</b><small class="sub">${ui.esc(where(x.m))}</small>` },
        { label: tr('utl|Tenant'), render: (x) => (x.lease ? ui.esc(db.value('SELECT name FROM brands WHERE id = ?', x.lease.brand_id)) : `<span class="muted">${ui.esc(tr('utl|Vacant'))}</span>`) },
        { label: ui.monthYear(LM), num: true, render: (x) => qty(x.r.consumption, 'electricity') },
        { label: tr('utl|Per m²'), num: true, render: (x) => (x.perM2 === null ? '—' : `${ui.n0(Math.round(x.perM2 * 10) / 10)}`) },
        { label: tr('utl|12 months'), render: (x) => X.sparkline(x.trend, { tone: 'amber' }) },
        { label: '', render: (x) => (x.r.flag ? flagBadges(x.r.flag) : '') },
      ],
      top,
      { empty: ui.esc(tr('utl|No electricity readings for this month yet.')), href: (x) => `/admin/utilities/meters/${x.m.id}` },
    );
    const body = `${nav('/admin/utilities')}${tariffBanner()}<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side">
  ${ui.card(tr('utl|Electricity by month'), all.length ? stack(elec) : ui.empty(tr('utl|Add the meters to start.'), ui.btn(tr('utl|Add a meter'), { href: '/admin/utilities/meters', cls: 'btn--primary btn--sm' })), { sub: ui.esc(tr('utl|kWh, tenants and common areas')) })}
  ${ui.card(tr('utl|By utility, {month}', { month: ui.monthYear(LM) }), util ? `<ul class="legend utl-list">${util}</ul>` : `<p class="muted pad">${ui.esc(tr('utl|No meters yet.'))}</p>`)}
</div>
${ui.card(tr('utl|Electricity intensity'), topTable, { sub: ui.esc(tr('utl|Tenant meters, kWh per m² of indoor area')) })}`;
    h.page(req, res, { title: tr('utl|Utilities'), active: '/admin/utilities', wide: true, body });
  });

  // the reading round
  router.get('/utilities/readings', (req, res) => {
    const period = periodOfReq(req);
    const canEdit = h.can(req, 'agent');
    const canMgr = h.can(req, 'manager');
    const csrf = req.session.csrf;
    const rows = meters().map((m) => ({ m, r: readingOf(m.id, period), prev: prevReading(m.id, period), billed: isBilled(m.id, period) }));
    const grid = rows.length
      ? X.resp(`<div class="tablewrap"><table class="table utl-grid"><thead><tr><th>${ui.esc(tr('utl|Meter'))}</th><th>${ui.esc(tr('utl|Where'))}</th><th class="num">${ui.esc(tr('utl|Previous'))}</th><th class="num">${ui.esc(tr('utl|Reading'))}</th><th class="num">${ui.esc(tr('utl|Consumption'))}</th><th class="num">${ui.esc(tr('utl|Cost'))}</th><th></th></tr></thead><tbody>${rows.map(({ m, r, prev, billed }) => `<tr class="${r && REVIEW(r.flag) && !r.accepted ? 'is-flag' : ''}">
          <td><a href="/admin/utilities/meters/${m.id}"><b>${ui.esc(m.code)}</b></a><small class="sub">${ui.esc(uLabel(m.utility))}${m.multiplier !== 1 ? ` · ×${m.multiplier}` : ''}</small></td>
          <td>${ui.esc(where(m))}</td>
          <td class="num muted">${prev ? `${ui.n0(prev.reading)}<small class="sub">${ui.esc(X.shortMonth(prev.period))}</small>` : '—'}</td>
          <td class="num"><input class="cellin" type="number" min="0" step="0.01" name="r_${m.id}" value="${r ? r.reading : ''}" ${!canEdit || billed ? 'disabled' : ''} inputmode="decimal"></td>
          <td class="num">${r ? qty(r.consumption, m.utility) : '—'}</td>
          <td class="num">${r && r.consumption !== null ? ui.money(costOf(m, r.consumption, period), { cur: false }) : '—'}</td>
          <td>${r ? flagBadges(r.flag) : ''}${r && REVIEW(r.flag) && r.accepted ? ` ${ui.badge('ok', tr('utl|Accepted'), 'ok')}` : ''}${billed ? ` ${ui.badge('billed', tr('utl|Billed'), 'mute')}` : ''}</td></tr>`).join('')}</tbody></table></div>`)
      : ui.empty(tr('utl|Add the meters to start.'), ui.btn(tr('utl|Add a meter'), { href: '/admin/utilities/meters', cls: 'btn--primary btn--sm' }));
    const form = canEdit && rows.length
      ? ui.form('/admin/utilities/readings', csrf, `<input type="hidden" name="period" value="${period}">${grid}<div class="row">${ui.btn(tr('utl|Save readings'), { cls: 'btn--primary' })}<span class="small muted">${ui.esc(tr('utl|Consumption = this reading − the previous one, × the meter’s multiplier.'))}</span></div>`, { cls: 'stack' })
      : grid;
    const review = toReview();
    const reviewList = review.length
      ? `<ul class="list">${review.map((r) => { const m = meterOf(r.meter_id); return `<li><span class="what"><b>${ui.esc(r.code)} · ${ui.esc(ui.monthYear(r.period))}</b><small>${flagBadges(r.flag)} ${ui.esc(tr('utl|reading {reading}, consumption {use}', { reading: ui.n0(r.reading), use: qty(r.consumption, r.utility) }))}</small></span>${canMgr && r.consumption !== null ? ui.form(`/admin/utilities/readings/${r.id}/accept`, csrf, ui.btn(tr('utl|Accept'), { cls: 'btn--ghost btn--xs' })) : `<a class="btn btn--ghost btn--xs" href="/admin/utilities/readings?period=${r.period}">${ui.esc(tr('utl|Correct'))}</a>`}</li>${m ? '' : ''}`; }).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('utl|Nothing to review.'))}</p>`;
    const importForm = canEdit
      ? ui.form('/admin/utilities/readings/import', csrf, `<input type="hidden" name="period" value="${period}">
          <label class="f"><span class="f__l">${ui.esc(tr('utl|Paste rows from a spreadsheet'))}</span><textarea name="rows" rows="5" dir="ltr" placeholder="E-G01, 48210&#10;E-G02, 30115"></textarea><small>${ui.esc(tr('utl|Columns: meter code, reading (for {month}). Or choose a CSV file:', { month: ui.monthYear(period) }))}</small></label>
          <input type="file" accept=".csv,.txt,text/csv" data-csv-into="rows">${ui.btn(tr('utl|Import'), { cls: 'btn--ghost btn--sm', ic: 'upload' })}`, { cls: 'stack' })
      : '';
    const body = `${nav('/admin/utilities/readings')}${monthPick('/admin/utilities/readings', period)}
<div class="grid grid--side">${ui.card(tr('utl|Readings for {month}', { month: ui.monthYear(period) }), form)}
<div class="stack"><div id="review">${ui.card(tr('utl|To review'), reviewList, { sub: ui.esc(tr('utl|Unusual readings are held back from billing until accepted or corrected.')) })}</div>${importForm ? ui.card(tr('utl|Import readings'), importForm) : ''}</div></div>`;
    h.page(req, res, { title: tr('utl|Meter readings'), crumbs: [['/admin/utilities', tr('utl|Utilities')], [null, tr('utl|Readings')]], active: '/admin/utilities', wide: true, body });
  });
  router.post('/utilities/readings', R('agent'), (req, res) => {
    const period = periodOfReq(req);
    const back = `/admin/utilities/readings?period=${period}`;
    let saved = 0;
    const errors = [];
    let flagged = 0;
    db.tx(() => {
      for (const m of meters()) {
        const v = req.body[`r_${m.id}`];
        if (v === undefined || v === '') continue;
        try {
          const old = readingOf(m.id, period);
          if (old && old.reading === Number(v)) continue;
          const r = saveReading(m, period, v, { user: req.user });
          saved++;
          if (r && !r.accepted) flagged++;
        } catch (err) {
          errors.push(`${m.code}: ${tr(err.message)}`);
        }
      }
    });
    if (saved) h.log(req, 'Recorded meter readings', 'utilities', null, `${period} · ${saved}`);
    if (errors.length) return h.back(req, res, back, 'error', errors.join(' · '));
    h.back(req, res, back, flagged ? 'error' : 'ok', flagged ? tr('utl|{saved} readings saved; {flagged} need a look.', { saved, flagged }) : tr('utl|{saved} readings saved.', { saved }));
  });
  router.post('/utilities/readings/import', R('agent'), (req, res) => {
    const period = periodOfReq(req);
    const back = `/admin/utilities/readings?period=${period}`;
    const byCode = Object.fromEntries(meters().map((m) => [m.code.toUpperCase(), m]));
    const rows = X.parseTable(String(req.body.rows || '').slice(0, 200000), (r) => X.amountOf(r[1]) !== null);
    let saved = 0;
    const bad = [];
    db.tx(() => {
      rows.forEach((r, i) => {
        const m = byCode[String(r[0] || '').trim().toUpperCase()];
        try {
          if (!m) throw new Error('utl|Unknown meter.');
          saveReading(m, /^\d{4}-\d{2}$/.test(r[2] || '') ? r[2] : period, X.amountOf(r[1]), { user: req.user });
          saved++;
        } catch {
          bad.push(i + 1);
        }
      });
    });
    if (saved) h.log(req, 'Imported meter readings', 'utilities', null, `${period} · ${saved}`);
    if (!saved) return h.back(req, res, back, 'error', tr('utl|Nothing imported. Check the columns: meter code, reading.'));
    h.back(req, res, back, bad.length ? 'error' : 'ok', bad.length ? tr('utl|{saved} readings imported; rows {rows} were skipped.', { saved, rows: bad.slice(0, 20).join(', ') }) : tr('utl|{saved} readings saved.', { saved }));
  });
  router.post('/utilities/readings/:id/accept', R('manager'), (req, res, next) => {
    const r = db.get('SELECT * FROM utl_readings WHERE id = ?', h.int(req.params.id));
    if (!r) return next();
    const back = h.safeBack(req, `/admin/utilities/readings?period=${r.period}`);
    if (r.consumption === null) return h.back(req, res, back, 'error', tr('utl|Correct the reading first: it is lower than last month.'));
    db.run('UPDATE utl_readings SET accepted = 1 WHERE id = ?', r.id);
    feedCommon(meterOf(r.meter_id), r.period);
    h.log(req, 'Accepted meter reading', 'utilities', r.meter_id, `${r.period} · ${r.flag}`);
    h.back(req, res, back, 'ok', tr('utl|Reading accepted.'));
  });

  // billing
  router.get('/utilities/billing', (req, res) => {
    const period = periodOfReq(req);
    const p = preview(period);
    const canBill = h.can(req, 'manager');
    const byLease = {};
    for (const l of p.lines) (byLease[l.lease.id] = byLease[l.lease.id] || { lease: X.leaseOf(l.lease.id), lines: [], total: 0 }).lines.push(l);
    Object.values(byLease).forEach((g) => { g.total = C.r2(g.lines.reduce((t, l) => t + l.cost, 0)); });
    const ready = ui.table(
      [
        { label: tr('utl|Tenant'), render: (g) => `<b>${ui.esc(g.lease.brand_name)}</b><small class="sub">${ui.esc(g.lease.ref)}</small>` },
        { label: tr('utl|Meters'), render: (g) => g.lines.map((l) => `<span class="rev-chip">${ui.esc(l.m.code)} · ${qty(l.r.consumption, l.m.utility)}</span>`).join(' ') },
        { label: tr('utl|Amount (before VAT)'), num: true, render: (g) => `<b>${ui.money(g.total, { cur: false })}</b>` },
      ],
      Object.values(byLease),
      { empty: ui.esc(p.done.length ? tr('utl|This month is billed.') : tr('utl|Nothing ready to bill for this month.')) },
    );
    const blocked = p.blocked.length
      ? `<ul class="list">${p.blocked.map((b) => `<li><span class="what"><b>${ui.esc(b.m.code)}</b><small>${ui.esc(b.why === 'missing' ? tr('utl|No reading') : b.why === 'review' ? tr('utl|Reading to review') : tr('utl|Lower than last month'))}</small></span></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('utl|Every tenant meter is ready.'))}</p>`;
    const total = Object.values(byLease).reduce((t, g) => t + g.total, 0);
    const action = canBill && p.lines.length
      ? ui.form('/admin/utilities/bill', req.session.csrf, `<input type="hidden" name="period" value="${period}">${ui.btn(tr('utl|Bill utilities'), { cls: 'btn--primary btn--sm', ic: 'bill', attrs: { 'data-confirm': tr('utl|Issue {n} utility invoices for {month}?', { n: Object.keys(byLease).length, month: ui.monthYear(period) }) } })}`)
      : '';
    const done = db.all('SELECT b.*, m.code, m.utility, i.ref invoice_ref, br.name brand_name FROM utl_bills b JOIN utl_meters m ON m.id = b.meter_id LEFT JOIN invoices i ON i.id = b.invoice_id LEFT JOIN leases s ON s.id = b.lease_id LEFT JOIN brands br ON br.id = s.brand_id WHERE b.period = ? ORDER BY br.name, m.code', period);
    const doneTable = ui.table(
      [
        { label: tr('utl|Meter'), render: (b) => `<b>${ui.esc(b.code)}</b>` },
        { label: tr('utl|Tenant'), render: (b) => (b.brand_name ? ui.esc(b.brand_name) : `<span class="muted">${ui.esc(tr('utl|Vacant: landlord’s cost'))}</span>`) },
        { label: tr('utl|Consumption'), num: true, render: (b) => qty(b.consumption, b.utility) },
        { label: tr('utl|Cost'), num: true, render: (b) => ui.money(b.amount, { cur: false }) },
        { label: tr('utl|Invoice'), render: (b) => (b.invoice_id ? `<a href="/admin/invoices/${b.invoice_id}">${ui.esc(b.invoice_ref)}</a>` : '—') },
      ],
      done,
      { empty: ui.esc(tr('utl|Nothing billed for this month yet.')) },
    );
    const body = `${nav('/admin/utilities/billing')}${tariffBanner()}${monthPick('/admin/utilities/billing', period)}
<div class="grid grid--side">${ui.card(tr('utl|Ready to bill, {month}', { month: ui.monthYear(period) }), ready, { sub: ui.esc(tr('utl|Total {amount} before VAT', { amount: ui.money(total) })), action })}${ui.card(tr('utl|Held back'), blocked)}</div>
${ui.card(tr('utl|Billed'), doneTable)}`;
    h.page(req, res, { title: tr('utl|Utility billing'), crumbs: [['/admin/utilities', tr('utl|Utilities')], [null, tr('utl|Billing')]], active: '/admin/utilities', wide: true, body });
  });
  router.post('/utilities/bill', R('manager'), (req, res) => {
    const period = periodOfReq(req);
    const back = `/admin/utilities/billing?period=${period}`;
    let r;
    try {
      r = bill(period, req.user);
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    h.log(req, 'Billed utilities', 'utilities', null, `${period} · ${r.invoices}`);
    h.back(req, res, back, 'ok', tr('utl|{invoices} utility invoices issued, {amount} before VAT.', { invoices: r.invoices, amount: ui.money(r.total) }));
  });

  // meters
  router.get('/utilities/meters', (req, res) => {
    const list = meters({ active: false });
    const LM = X.lastMonth();
    const table = ui.table(
      [
        { label: tr('utl|Meter'), render: (m) => `<b>${ui.esc(m.code)}</b>${m.active ? '' : ` ${ui.badge('off', tr('utl|Retired'), 'mute')}`}<small class="sub">${ui.esc(m.serial || '')}</small>` },
        { label: tr('utl|Utility'), render: (m) => `<span class="dot dot--${UTIL[m.utility].tone}"></span> ${ui.esc(uLabel(m.utility))}` },
        { label: tr('utl|Where'), render: (m) => ui.esc(where(m)) },
        { label: tr('utl|Last reading'), num: true, render: (m) => { const r = db.get('SELECT * FROM utl_readings WHERE meter_id = ? ORDER BY period DESC LIMIT 1', m.id); return r ? `${ui.n0(r.reading)}<small class="sub">${ui.esc(ui.monthYear(r.period))}</small>` : '—'; } },
        { label: ui.monthYear(LM), num: true, render: (m) => { const r = readingOf(m.id, LM); return r ? qty(r.consumption, m.utility) : '—'; } },
      ],
      list,
      { empty: ui.esc(tr('utl|No meters yet.')), href: (m) => `/admin/utilities/meters/${m.id}` },
    );
    const units = db.all('SELECT id, code FROM units ORDER BY sort, code');
    const add = h.can(req, 'manager')
      ? ui.form('/admin/utilities/meters', req.session.csrf, `<div class="fields">
          ${ui.input('code', tr('utl|Meter code'), '', { required: true, placeholder: 'E-G05', attrs: { dir: 'ltr' } })}
          ${ui.select('utility', tr('utl|Utility'), Object.keys(UTIL).map((k) => [k, uLabel(k)]), 'electricity')}
          ${ui.select('unit_id', tr('utl|Unit'), units.map((u) => [u.id, u.code]), '', { blank: tr('utl|— Common area —') })}
          ${ui.input('area', tr('utl|Common area served'), '', { placeholder: tr('utl|e.g. Plaza lighting') })}
          ${ui.input('serial', tr('utl|Serial number'), '', { attrs: { dir: 'ltr' } })}
          ${ui.input('multiplier', tr('utl|Multiplier'), 1, { type: 'number', min: 0.001, step: '0.001', hint: tr('utl|CT ratio for large electricity meters') })}
          ${ui.input('digits', tr('utl|Dial digits'), 6, { type: 'number', min: 3, max: 9, step: 1, hint: tr('utl|For rollover: a 6-digit meter returns to 0 after 999999') })}
          ${ui.input('initial', tr('utl|Opening reading'), '', { type: 'number', min: 0, step: '0.01' })}
        </div>${ui.btn(tr('utl|Add meter'), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' })
      : '';
    const body = `${nav('/admin/utilities/meters')}<div class="grid grid--side">${ui.card(tn(list.length, 'utl|{n} meter', 'utl|{n} meters'), table)}${add ? ui.card(tr('utl|Add a meter'), add) : ''}</div>`;
    h.page(req, res, { title: tr('utl|Meters'), crumbs: [['/admin/utilities', tr('utl|Utilities')], [null, tr('utl|Meters')]], active: '/admin/utilities', wide: true, body });
  });
  function meterFields(b) {
    const code = h.str(b.code, 30).toUpperCase().replace(/\s+/g, '-');
    if (!code) throw new Error('utl|Enter the meter code.');
    const digits = Math.min(9, Math.max(3, h.int(b.digits) || 6));
    const mult = C.num(b.multiplier);
    return { code, utility: UTIL[b.utility] ? b.utility : 'electricity', unit_id: h.int(b.unit_id) || null, area: h.str(b.area, 120) || null, serial: h.str(b.serial, 60) || null, multiplier: mult && mult > 0 ? mult : 1, digits };
  }
  router.post('/utilities/meters', R('manager'), (req, res) => {
    let f;
    try {
      f = meterFields(req.body);
    } catch (err) {
      return h.back(req, res, '/admin/utilities/meters', 'error', tr(err.message));
    }
    if (db.get('SELECT id FROM utl_meters WHERE code = ?', f.code)) return h.back(req, res, '/admin/utilities/meters', 'error', tr('utl|A meter with this code already exists.'));
    const id = Number(db.run('INSERT INTO utl_meters (code, utility, unit_id, area, serial, multiplier, digits, installed_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', f.code, f.utility, f.unit_id, f.area, f.serial, f.multiplier, f.digits, M.today(), M.now()).lastInsertRowid);
    const init = C.num(req.body.initial);
    if (init !== null && init >= 0) {
      try {
        saveReading(meterOf(id), C.ymAdd(C.ymOf(M.today()), -1), init, { user: req.user, note: 'Opening reading' });
      } catch {
        // an opening reading is optional
      }
    }
    h.log(req, 'Added meter', 'utilities', id, f.code);
    h.back(req, res, `/admin/utilities/meters/${id}`, 'ok', tr('Saved.'));
  });
  router.get('/utilities/meters/:id', (req, res, next) => {
    const m = meterOf(h.int(req.params.id));
    if (!m) return next();
    const readings = db.all('SELECT r.*, b.amount billed, i.ref invoice_ref, b.invoice_id FROM utl_readings r LEFT JOIN utl_bills b ON b.meter_id = r.meter_id AND b.period = r.period LEFT JOIN invoices i ON i.id = b.invoice_id WHERE r.meter_id = ? ORDER BY r.period DESC LIMIT 24', m.id);
    const chronological = [...readings].reverse().filter((r) => r.consumption !== null);
    const chart = chronological.length
      ? ui.bars(chronological.map((r) => ({ label: X.shortMonth(r.period), v: r.consumption })), { key: 'v', label: 'label', tone: UTIL[m.utility].tone, fmtv: (n) => ui.n0(Math.round(n)), h: 150 })
      : ui.empty(tr('utl|Consumption appears after the second reading.'));
    const table = ui.table(
      [
        { label: tr('utl|Month'), render: (r) => ui.esc(ui.monthYear(r.period)) },
        { label: tr('utl|Reading'), num: true, render: (r) => ui.n0(r.reading) },
        { label: tr('utl|Consumption'), num: true, render: (r) => qty(r.consumption, m.utility) },
        { label: tr('utl|Cost'), num: true, render: (r) => (r.consumption !== null ? ui.money(r.billed ?? costOf(m, r.consumption, r.period), { cur: false }) : '—') },
        { label: '', render: (r) => `${flagBadges(r.flag)}${r.invoice_id ? ` <a class="badge badge--sky" href="/admin/invoices/${r.invoice_id}">${ui.esc(r.invoice_ref)}</a>` : r.billed !== null && r.billed !== undefined ? ` ${ui.badge('billed', tr('utl|Billed'), 'mute')}` : ''}` },
      ],
      readings,
      { empty: ui.esc(tr('utl|No readings yet.')) },
    );
    const units = db.all('SELECT id, code FROM units ORDER BY sort, code');
    const edit = h.can(req, 'manager')
      ? ui.form(`/admin/utilities/meters/${m.id}`, req.session.csrf, `<div class="fields">
          ${ui.input('code', tr('utl|Meter code'), m.code, { required: true, attrs: { dir: 'ltr' } })}
          ${ui.select('utility', tr('utl|Utility'), Object.keys(UTIL).map((k) => [k, uLabel(k)]), m.utility)}
          ${ui.select('unit_id', tr('utl|Unit'), units.map((u) => [u.id, u.code]), m.unit_id || '', { blank: tr('utl|— Common area —') })}
          ${ui.input('area', tr('utl|Common area served'), m.area || '')}
          ${ui.input('serial', tr('utl|Serial number'), m.serial || '', { attrs: { dir: 'ltr' } })}
          ${ui.input('multiplier', tr('utl|Multiplier'), m.multiplier, { type: 'number', min: 0.001, step: '0.001' })}
          ${ui.input('digits', tr('utl|Dial digits'), m.digits, { type: 'number', min: 3, max: 9, step: 1 })}
        </div><label class="check"><input type="checkbox" name="active" value="1" ${m.active ? 'checked' : ''}> ${ui.esc(tr('utl|In use'))}</label>${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })
      : '';
    const lease = m.unit_id ? X.leaseForUnit(m.unit_id, C.ymOf(M.today())) : null;
    const kpis = `<div class="kpis kpis--3">
      ${ui.kpi({ label: tr('utl|Utility'), value: ui.esc(uLabel(m.utility)), sub: ui.esc(where(m)) })}
      ${ui.kpi({ label: tr('utl|Tenant'), value: lease ? ui.esc(db.value('SELECT name FROM brands WHERE id = ?', lease.brand_id)) : ui.esc(m.unit_id ? tr('utl|Vacant') : tr('utl|Common area')), sub: m.unit_id ? '' : ui.esc(tr('utl|cost goes to the service charge')) })}
      ${ui.kpi({ label: tr('utl|Average a month'), value: chronological.length ? qty(chronological.slice(-6).reduce((t, r) => t + r.consumption, 0) / Math.min(6, chronological.length), m.utility) : '—', sub: ui.esc(tr('utl|last 6 months')) })}
    </div>`;
    const body = `${kpis}<div class="grid grid--side"><div class="stack">${ui.card(tr('utl|Consumption'), chart)}${ui.card(tr('utl|Readings'), table)}</div>${edit ? ui.card(tr('utl|Meter details'), edit) : ''}</div>`;
    h.page(req, res, { title: m.code, crumbs: [['/admin/utilities', tr('utl|Utilities')], ['/admin/utilities/meters', tr('utl|Meters')], [null, m.code]], active: '/admin/utilities', wide: true, body });
  });
  router.post('/utilities/meters/:id', R('manager'), (req, res, next) => {
    const m = meterOf(h.int(req.params.id));
    if (!m) return next();
    const back = `/admin/utilities/meters/${m.id}`;
    let f;
    try {
      f = meterFields(req.body);
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    if (db.get('SELECT id FROM utl_meters WHERE code = ? AND id != ?', f.code, m.id)) return h.back(req, res, back, 'error', tr('utl|A meter with this code already exists.'));
    db.run('UPDATE utl_meters SET code = ?, utility = ?, unit_id = ?, area = ?, serial = ?, multiplier = ?, digits = ?, active = ? WHERE id = ?', f.code, f.utility, f.unit_id, f.area, f.serial, f.multiplier, f.digits, req.body.active ? 1 : 0, m.id);
    h.log(req, 'Updated meter', 'utilities', m.id, f.code);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  // tariffs
  const tiersText = (t) => {
    try {
      const tiers = t.tiers ? JSON.parse(t.tiers) : null;
      return Array.isArray(tiers) ? tiers.map((x) => `${x.upto === null || x.upto === undefined ? '*' : x.upto}: ${x.rate}`).join('\n') : '';
    } catch {
      return '';
    }
  };
  function parseTiers(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const tiers = lines.map((l) => {
      const m = /^(\*|\d+(?:\.\d+)?)\s*[:=]\s*(\d+(?:\.\d+)?)$/.exec(l);
      if (!m) throw new Error('utl|Write each tier as “up to: rate”, e.g. 100: 0.85, and * for the rest.');
      return { upto: m[1] === '*' ? null : Number(m[1]), rate: Number(m[2]) };
    });
    return JSON.stringify(tiers);
  }
  router.get('/utilities/tariffs', (req, res) => {
    const canMgr = h.can(req, 'manager');
    const cards = Object.keys(UTIL).map((k) => {
      const list = db.all('SELECT * FROM utl_tariffs WHERE utility = ? ORDER BY valid_from DESC, id DESC', k);
      const cur = list[0];
      const hist = list.map((t, i) => `<li><span class="what"><b>${ui.esc(tiersText(t) ? tr('utl|Tiered') : `${t.rate} / ${uUnit(k)}`)}${t.fixed_monthly ? ` · ${ui.esc(tr('utl|+{amount} a month', { amount: ui.money(t.fixed_monthly, { cur: false }) }))}` : ''}</b><small>${ui.esc(tr('utl|from {date}', { date: ui.date(t.valid_from) }))}${i === 0 ? ` · ${ui.esc(tr('utl|current'))}` : ''}</small></span>${t.confirmed ? ui.badge('ok', tr('utl|Confirmed'), 'ok') : ui.badge('check', tr('utl|To check'), 'amber')}</li>`).join('');
      const f = canMgr
        ? ui.form('/admin/utilities/tariffs', req.session.csrf, `<input type="hidden" name="utility" value="${k}"><div class="fields">
            ${ui.input('rate', tr('utl|Rate per {unit}', { unit: uUnit(k) }), cur ? cur.rate : '', { type: 'number', min: 0, step: '0.0001', required: true })}
            ${ui.input('fixed_monthly', tr('utl|Fixed charge a month'), cur ? cur.fixed_monthly : 0, { type: 'number', min: 0, step: '0.01' })}
            ${ui.input('valid_from', tr('utl|Valid from'), M.today(), { type: 'date', required: true })}
          </div>${ui.textarea('tiers', tr('utl|Tiers (optional)'), cur ? tiersText(cur) : '', { rows: 3, placeholder: '100: 0.85\n250: 1.25\n*: 2.10' })}
          ${ui.input('vat_note', tr('utl|VAT note'), cur ? cur.vat_note || '' : '')}
          <label class="check"><input type="checkbox" name="confirmed" value="1" checked> ${ui.esc(tr('utl|Checked against the supply contract'))}</label>
          ${ui.btn(tr('utl|Save tariff'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })
        : '';
      return ui.card(uLabel(k), `<ul class="list">${hist}</ul>${f}`, { sub: cur && cur.vat_note ? ui.esc(tx(cur.vat_note)) : '' });
    }).join('');
    const body = `${nav('/admin/utilities/tariffs')}${tariffBanner()}<p class="rev-note">${ui.esc(tr('utl|A tariff applies to the months ending on or after its date. Tiers are charged in steps: the first units at the first rate, and so on. Amounts are before VAT.'))}</p><div class="grid grid--2">${cards}</div>`;
    h.page(req, res, { title: tr('utl|Tariffs'), crumbs: [['/admin/utilities', tr('utl|Utilities')], [null, tr('utl|Tariffs')]], active: '/admin/utilities', wide: true, body });
  });
  router.post('/utilities/tariffs', R('manager'), (req, res) => {
    const back = '/admin/utilities/tariffs';
    const utility = UTIL[req.body.utility] ? req.body.utility : null;
    const rate = C.num(req.body.rate);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.valid_from || '')) ? req.body.valid_from : null;
    if (!utility || rate === null || rate < 0 || !from) return h.back(req, res, back, 'error', tr('utl|Enter the rate and the date it applies from.'));
    let tiers;
    try {
      tiers = parseTiers(req.body.tiers);
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    db.run('INSERT INTO utl_tariffs (utility, rate, fixed_monthly, tiers, vat_note, valid_from, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', utility, rate, Math.max(0, C.num(req.body.fixed_monthly) || 0), tiers, h.str(req.body.vat_note, 200) || null, from, req.body.confirmed ? 1 : 0, M.now());
    h.log(req, `Saved ${utility === 'chilled' ? 'chilled water' : utility} tariff`, 'utilities', null, `${rate} · ${from}`);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  return { UTIL, FLAGS, meters, meterOf, readingOf, saveReading, compute, preview, bill, series, tariffFor, costOf, toReview };
};
