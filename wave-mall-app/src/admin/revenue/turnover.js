'use strict';

// Turnover rent and tenant sales: each lease's turnover terms, monthly sales submissions (staff or
// the tenant portal), percentage rent per period with an annual true-up, reminders for late sales
// certificates, and the analytics a mall manager reads (sales per m², occupancy cost, trends).

const i18n = require('../i18n');
const { t: tr, tn, tx } = i18n;

const FREQ = { monthly: 'trn|Monthly', quarterly: 'trn|Quarterly' };
const BREAK = { natural: 'trn|Natural breakpoint', fixed: 'trn|Fixed breakpoint' };
const STATUS = { draft: ['trn|Draft', 'mute'], submitted: ['trn|Submitted', 'sky'], verified: ['trn|Verified', 'ok'], disputed: ['trn|Disputed', 'rose'] };
const COUNTED = ['submitted', 'verified']; // sales that count towards turnover rent
const OCR_RISK = 0.15;

module.exports = function turnover(router, h, X) {
  const { db, ui, M } = h;
  const { C } = X;
  const R = h.R;

  // ---------- facts ----------
  const termsOf = (leaseId) => db.get('SELECT * FROM turnover_terms WHERE lease_id = ?', leaseId);
  const salesMap = (leaseId) => Object.fromEntries(db.all('SELECT * FROM tenant_sales WHERE lease_id = ? ORDER BY period', leaseId).map((r) => [r.period, r]));
  // trading starts at the lease start or the store's opening date, whichever is later
  const tradingFrom = (lease) => {
    const opening = db.value('SELECT opening_date FROM brands WHERE id = ?', lease.brand_id);
    return opening && opening > lease.start_date ? opening : lease.start_date;
  };
  // the share of a month the store traded (from its opening to the lease end)
  const tradeCover = (lease, ym) => C.monthCover({ start_date: tradingFrom(lease), end_date: lease.end_date }, ym);
  // occupancy cost of a month: base rent and service charge for the days the store traded
  const costWhileTrading = (lease, ym) => {
    const cover = C.monthCover(lease, ym);
    return cover ? (C.baseRentMonth(lease, lease.units, ym) + C.serviceMonth(lease, lease.units, ym)) * Math.min(1, tradeCover(lease, ym) / cover) : 0;
  };
  const dueOf = (period, terms) => {
    const next = C.ymAdd(C.periodMonths(period).at(-1), 1);
    return `${next}-${String(Math.min(C.daysIn(next), terms ? terms.due_day || 10 : 10)).padStart(2, '0')}`;
  };
  // the months a lease should have reported up to last month
  function expectedMonths(lease) {
    const from = C.ymOf(tradingFrom(lease));
    const to = [X.lastMonth(), C.ymOf(lease.end_date)].sort()[0];
    return from > to ? [] : C.ymRange(from, to).filter((ym) => C.monthCover(lease, ym) > 0);
  }
  // sales certificates not in (or only saved as drafts), with whether they are late
  function missing() {
    const today = M.today();
    const out = [];
    for (const s of X.activeLeases()) {
      const terms = termsOf(s.id);
      if (!terms) continue;
      const have = salesMap(s.id);
      for (const ym of expectedMonths(s)) {
        if (have[ym] && have[ym].status !== 'draft') continue;
        const due = dueOf(ym, terms);
        out.push({ lease: s, period: ym, due, late: due < today, draft: !!have[ym] });
      }
    }
    return out;
  }
  const isLocked = (leaseId, ym) => !!db.get('SELECT id FROM turnover_bills WHERE lease_id = ? AND period IN (?, ?, ?)', leaseId, ym, C.quarterOf(ym), ym.slice(0, 4));

  // Turnover rent for a period (a month or a quarter), from the counted sales.
  function calcPeriod(lease, terms, period) {
    const months = C.periodMonths(period).filter((ym) => C.monthCover(lease, ym) > 0);
    const sales = salesMap(lease.id);
    const missingMonths = months.filter((ym) => !sales[ym] || !COUNTED.includes(sales[ym].status));
    const amount = C.r2(months.reduce((t, ym) => t + (sales[ym] && COUNTED.includes(sales[ym].status) ? sales[ym].amount : 0), 0));
    const base = C.r2(months.reduce((t, ym) => t + C.baseRentMonth(lease, lease.units, ym), 0));
    const cover = months.reduce((t, ym) => t + C.monthCover(lease, ym), 0);
    const breakpoint = C.breakpointFor(terms, base, cover);
    const due = C.pctRent({ sales: amount, pct: terms.pct, base, type: terms.breakpoint_type, breakpoint });
    const ended = months.length && months.at(-1) <= X.lastMonth();
    return { period, months, sales: amount, base, breakpoint, pct: terms.pct, due, missingMonths, ended };
  }
  // The yearly true-up: turnover rent on the year's sales, less what the periods already billed.
  function calcAnnual(lease, terms, year) {
    const c = calcPeriod(lease, terms, String(year));
    const previously = C.r2(db.value("SELECT COALESCE(SUM(due), 0) FROM turnover_bills WHERE lease_id = ? AND kind = 'period' AND substr(period, 1, 4) = ?", lease.id, String(year)));
    return { ...c, previously, diff: C.r2(c.due - previously), ended: `${year}-12` <= X.lastMonth() || C.ymOf(lease.end_date) <= X.lastMonth() };
  }
  // The periods of a lease that can be billed (ended, all sales in, not billed yet).
  function billable(lease, terms) {
    const seen = new Set();
    const out = [];
    for (const ym of expectedMonths(lease)) {
      const p = C.periodOf(ym, terms.frequency);
      if (seen.has(p)) continue;
      seen.add(p);
      if (db.get('SELECT id FROM turnover_bills WHERE lease_id = ? AND period = ?', lease.id, p)) continue;
      const c = calcPeriod(lease, terms, p);
      if (c.ended) out.push(c);
    }
    if (terms.annual_recon) {
      const years = [...new Set(expectedMonths(lease).map((ym) => ym.slice(0, 4)))];
      for (const y of years) {
        if (db.get('SELECT id FROM turnover_bills WHERE lease_id = ? AND period = ?', lease.id, y)) continue;
        const a = calcAnnual(lease, terms, y);
        if (a.ended) out.push({ ...a, annual: true });
      }
    }
    return out;
  }

  // Bill one period (or a year's true-up). Returns the turnover_bills row.
  function bill(lease, period, user, { demo = 0 } = {}) {
    const terms = termsOf(lease.id);
    if (!terms) throw new Error('trn|This lease has no turnover terms.');
    if (db.get('SELECT id FROM turnover_bills WHERE lease_id = ? AND period = ?', lease.id, period)) throw new Error('trn|This period is already billed.');
    const annual = /^\d{4}$/.test(period);
    const c = annual ? calcAnnual(lease, terms, period) : calcPeriod(lease, terms, period);
    if (!c.months.length) throw new Error('trn|The lease does not cover this period.');
    if (!c.ended) throw new Error('trn|This period has not ended yet.');
    if (c.missingMonths.length) throw new Error(tr('trn|Sales are missing for {months}.', { months: c.missingMonths.map(X.periodLabel).join(', ') }));
    const due = annual ? c.diff : c.due;
    return db.tx(() => {
      const id = Number(db.run(
        'INSERT INTO turnover_bills (lease_id, period, kind, sales, base, breakpoint, pct, due, previously, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        lease.id, period, annual ? 'annual' : 'period', c.sales, c.base, c.breakpoint, c.pct, due, annual ? c.previously : 0, user ? user.id : null, demo ? 1 : 0, M.now(),
      ).lastInsertRowid);
      if (due > 0) {
        const { net, uses } = X.takeCredits(lease.id, due);
        let invoiceId = null;
        if (net > 0) {
          const note = uses.length
            ? (annual ? `Turnover rent true-up ${period}, less credit ${X.creditNote(uses)}` : `Turnover rent ${period}, less credit ${X.creditNote(uses)}`)
            : (annual ? `Turnover rent true-up ${period}` : `Turnover rent ${period}`);
          const inv = h.billing.createInvoice({
            lease_id: lease.id, kind: 'turnover', other: net, due_date: M.addDays(M.today(), 14), note, source: 'turnover', source_id: id,
            period_start: `${c.months[0]}-01`, period_end: `${c.months.at(-1)}-${String(C.daysIn(c.months.at(-1))).padStart(2, '0')}`, demo,
          }, { user });
          invoiceId = inv.id;
        }
        X.recordUses(uses, invoiceId, 'turnover', `${lease.id}:${period}`);
        db.run('UPDATE turnover_bills SET amount = ?, credits = ?, invoice_id = ? WHERE id = ?', net, C.r2(due - net), invoiceId, id);
      } else if (due < 0) {
        const cn = X.addCredit({ lease_id: lease.id, brand_id: lease.brand_id, source: 'turnover', source_ref: `${lease.id}:${period}`, amount: -due, note: `Turnover rent true-up ${period}`, demo });
        db.run('UPDATE turnover_bills SET credit_id = ? WHERE id = ?', cn.id, id);
      }
      return db.get('SELECT * FROM turnover_bills WHERE id = ?', id);
    });
  }

  // Save one month's sales (staff or portal). Locked once the period is billed.
  function saveSales(lease, period, v, { user = null, via = 'staff', by = null, status } = {}) {
    if (!/^\d{4}-\d{2}$/.test(period) || C.monthCover(lease, period) <= 0) throw new Error('trn|The lease does not cover this period.');
    if (period > C.ymOf(M.today())) throw new Error('trn|Sales cannot be reported for a future month.');
    if (isLocked(lease.id, period)) throw new Error('trn|This month is already billed, so its sales are locked.');
    const gross = C.num(v.gross);
    const returns = C.num(v.returns) || 0;
    if (gross === null || gross < 0 || returns < 0 || returns > gross) throw new Error('trn|Enter gross sales, and returns no larger than them.');
    const net = C.r2(gross - returns);
    const tx_ = C.num(v.transactions);
    const st = status || 'submitted';
    const old = db.get('SELECT * FROM tenant_sales WHERE lease_id = ? AND period = ?', lease.id, period);
    const now = M.now();
    if (old) {
      db.run(
        `UPDATE tenant_sales SET gross = ?, returns = ?, amount = ?, transactions = ?, status = ?, submitted_via = ?, submitted_by = ?, submitted_at = ?, note = COALESCE(?, note),
         document_id = COALESCE(?, document_id), verified_by = CASE WHEN ? = 'verified' THEN verified_by ELSE NULL END, verified_at = CASE WHEN ? = 'verified' THEN verified_at ELSE NULL END, updated_at = ? WHERE id = ?`,
        C.r2(gross), C.r2(returns), net, tx_ === null ? null : Math.round(tx_), st, via, by, st === 'draft' ? old.submitted_at : now, v.note || null, v.document_id || null, st, st, now, old.id,
      );
      return db.get('SELECT * FROM tenant_sales WHERE id = ?', old.id);
    }
    const id = Number(db.run(
      `INSERT INTO tenant_sales (brand_id, lease_id, period, gross, returns, amount, transactions, status, submitted_via, submitted_by, submitted_at, note, document_id, demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      lease.brand_id, lease.id, period, C.r2(gross), C.r2(returns), net, tx_ === null ? null : Math.round(tx_), st, via, by, st === 'draft' ? null : now, v.note || null, v.document_id || null, v.demo ? 1 : 0, now, now,
    ).lastInsertRowid);
    h.events.emit('sales.submitted', { sale: db.get('SELECT * FROM tenant_sales WHERE id = ?', id), lease, user });
    return db.get('SELECT * FROM tenant_sales WHERE id = ?', id);
  }

  // ---------- analytics ----------
  function stats() {
    const LM = X.lastMonth();
    const months = C.ymRange(C.ymAdd(LM, -11), LM);
    const leases = X.activeLeases().filter((s) => s.start_date <= M.today());
    const rows = leases.map((s) => {
      const sales = salesMap(s.id);
      const val = (ym) => (sales[ym] && sales[ym].status !== 'draft' ? sales[ym].amount : null);
      const area = s.units.reduce((t, u) => t + u.indoor_m2, 0);
      const last3 = C.ymRange(C.ymAdd(LM, -2), LM).filter((ym) => val(ym) !== null && tradeCover(s, ym) > 0);
      const sum3 = last3.reduce((t, ym) => t + val(ym), 0);
      const cover3 = last3.reduce((t, ym) => t + tradeCover(s, ym), 0);
      const cost3 = last3.reduce((t, ym) => t + costWhileTrading(s, ym), 0);
      const ytdYear = LM.slice(0, 4);
      // month-on-month and year-on-year only between months traded in full
      const full = (ym) => tradeCover(s, ym) > 0.999 ? val(ym) : null;
      return {
        lease: s, area, terms: termsOf(s.id),
        last: val(LM), prev: full(LM) === null ? null : full(C.ymAdd(LM, -1)), lastYear: full(LM) === null ? null : full(C.ymAdd(LM, -12)),
        perM2: cover3 && area ? sum3 / cover3 / area : null,
        ocr: sum3 ? cost3 / sum3 : null,
        trend: months.map(val),
        ytd: Object.entries(sales).filter(([p, r]) => p.startsWith(ytdYear) && r.status !== 'draft').reduce((t, [, r]) => t + r.amount, 0),
        pctYtd: db.value("SELECT COALESCE(SUM(due), 0) FROM turnover_bills WHERE lease_id = ? AND substr(period, 1, 4) = ? AND due > 0", s.id, ytdYear),
      };
    });
    // the chart starts with the first sales reported (at least six months shown)
    const first = db.value("SELECT MIN(period) FROM tenant_sales WHERE status != 'draft'") || LM;
    const shown = months.filter((ym) => ym >= [first, C.ymAdd(LM, -5)].sort()[0]);
    const totals = shown.map((ym) => ({ ym, label: X.shortMonth(ym), amount: db.value("SELECT COALESCE(SUM(amount), 0) FROM tenant_sales WHERE period = ? AND status != 'draft'", ym) }));
    const reporting = rows.filter((r) => r.last !== null && tradeCover(r.lease, LM) > 0);
    const areaReporting = reporting.reduce((t, r) => t + r.area * tradeCover(r.lease, LM), 0);
    const lastTotal = totals.at(-1).amount;
    const cats = {};
    for (const r of rows.filter((x) => x.perM2 !== null)) {
      const c = (cats[r.lease.category] = cats[r.lease.category] || { n: 0, sum: 0, ocr: 0 });
      c.n++;
      c.sum += r.perM2;
      c.ocr += r.ocr || 0;
    }
    return {
      LM, months, rows, totals, lastTotal, prevTotal: totals.length > 1 ? totals.at(-2).amount : 0,
      avgPerM2: areaReporting ? reporting.reduce((t, r) => t + r.last, 0) / areaReporting : null,
      atRisk: rows.filter((r) => r.ocr !== null && r.ocr > OCR_RISK),
      categories: Object.entries(cats).map(([k, c]) => ({ id: k, label: M.CATEGORIES[k] || k, n: c.n, perM2: c.sum / c.n, ocr: c.ocr / c.n })).sort((a, b) => b.perM2 - a.perM2),
    };
  }

  // ---------- reminders ----------
  async function remind(user, { onlyStale = false } = {}) {
    const late = missing().filter((m) => m.late);
    let sent = 0;
    let logged = 0;
    for (const m of late) {
      const key = `${m.lease.id}:${m.period}`;
      if (onlyStale && db.get("SELECT id FROM turnover_reminders WHERE lease_id = ? AND period = ? AND created_at > ?", m.lease.id, m.period, new Date(Date.now() - 7 * 86400000).toISOString())) continue;
      const contact = db.get("SELECT name, email FROM contacts WHERE brand_id = ? AND email IS NOT NULL AND email != '' ORDER BY primary_contact DESC, id LIMIT 1", m.lease.brand_id);
      const to = db.value('SELECT store_email FROM brands WHERE id = ?', m.lease.brand_id) || (contact && contact.email);
      let channel = 'logged';
      if (to && h.mail && typeof h.mail.send === 'function') {
        try {
          await h.mail.send({
            to,
            subject: `The Wave · Sales certificate for ${m.period} / شهادة المبيعات`,
            text: `Dear ${m.lease.brand_name},\n\nYour sales certificate for ${m.period} was due on ${m.due}. Please submit it in the tenant portal or reply with your POS report.\n\nThank you,\nThe Wave leasing office\n\n—\nنرجو إرسال شهادة مبيعات شهر ${m.period} التي كان موعدها ${m.due}، عبر بوابة المستأجرين أو بالرد على هذه الرسالة مع تقرير نقاط البيع.\nمكتب التأجير · ذا ويف`,
            meta: { source: 'turnover', key },
          });
          channel = 'email';
          sent++;
        } catch (err) {
          channel = 'failed';
        }
      }
      if (channel !== 'email') logged++;
      db.run('INSERT INTO turnover_reminders (lease_id, period, channel, sent_to, created_at) VALUES (?, ?, ?, ?, ?)', m.lease.id, m.period, channel, to || null, M.now());
    }
    if (late.length) db.audit(user, 'Sent sales reminders', 'turnover', null, `${late.length}`);
    return { late: late.length, sent, logged };
  }
  if (h.every) h.every('turnover-reminders', 24 * 3600 * 1000, () => remind(null, { onlyStale: true }), { first: 15 * 60 * 1000 });
  h.count('turnover', () => missing().filter((m) => m.late).length);

  // ---------- pages ----------
  const nav = (active) => X.tabs([['/admin/turnover', tr('trn|Overview')], ['/admin/turnover/sales', tr('trn|Sales submissions')], ['/admin/turnover/billing', tr('trn|Turnover rent billing')], ['/admin/turnover/terms', tr('trn|Lease terms')]], active);
  const sbadge = (st) => ui.badge(st, tr(STATUS[st][0]), STATUS[st][1]);
  const perM2 = (n) => (n === null || n === undefined ? '—' : tr('trn|{amount}/m²', { amount: ui.money(n, { cur: false }) }));
  const ocrCell = (o) => (o === null ? '<span class="muted">—</span>' : `<span class="${o > OCR_RISK ? 'late' : o > 0.12 ? 'rev-warn' : 'up'}">${X.pct1(o)}</span>`);

  router.get('/turnover', (req, res) => {
    const st = stats();
    const miss = missing();
    const late = miss.filter((m) => m.late);
    const kpis = [
      ui.kpi({ label: tr('trn|Tenant sales, {month}', { month: ui.monthYear(st.LM) }), value: ui.money(st.lastTotal, { compact: true }), sub: st.prevTotal ? `${X.change(st.lastTotal, st.prevTotal)} ${ui.esc(tr('trn|on the month before'))}` : '' }),
      ui.kpi({ label: tr('trn|Average sales per m²'), value: st.avgPerM2 === null ? '—' : ui.money(st.avgPerM2, { compact: true }), sub: ui.esc(tr('trn|per month, indoor area of tenants reporting')) }),
      ui.kpi({ label: tr('trn|Tenants at risk'), value: ui.n0(st.atRisk.length), sub: ui.esc(tr('trn|occupancy cost above {pct} of sales', { pct: `${OCR_RISK * 100}%` })), tone: st.atRisk.length ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('trn|Late sales certificates'), value: ui.n0(late.length), sub: ui.esc(tn(miss.length, 'trn|{n} certificate outstanding', 'trn|{n} certificates outstanding')), tone: late.length ? 'kpi--alert' : '', href: '/admin/turnover#missing' }),
    ].join('');
    const chart = ui.bars(st.totals, { key: 'amount', label: 'label', fmtv: (n) => ui.money(n, { compact: true, cur: false }), tone: 'forest' });
    const ranking = ui.table(
      [
        { label: tr('trn|Tenant'), render: (r) => { const opens = tradingFrom(r.lease); return `<b>${ui.esc(r.lease.brand_name)}</b><small class="sub">${ui.esc(M.CATEGORIES[r.lease.category] || '')} · ${ui.m2(r.area)}${opens > M.today() ? ` · ${ui.esc(tr('trn|opens {date}', { date: ui.date(opens) }))}` : opens.slice(0, 7) > st.LM ? ` · ${ui.esc(tr('trn|opened {date}', { date: ui.date(opens) }))}` : ''}</small>`; } },
        { label: ui.monthYear(st.LM), num: true, render: (r) => (r.last === null ? '<span class="muted">—</span>' : ui.money(r.last, { cur: false })) },
        { label: tr('trn|Month on month'), num: true, render: (r) => X.change(r.last, r.prev) },
        { label: tr('trn|Year on year'), num: true, render: (r) => X.change(r.last, r.lastYear) },
        { label: tr('trn|Sales per m²'), num: true, render: (r) => perM2(r.perM2) },
        { label: tr('trn|Occupancy cost'), num: true, render: (r) => ocrCell(r.ocr) },
        { label: tr('trn|12 months'), render: (r) => X.sparkline(r.trend) },
        { label: tr('trn|Turnover rent this year'), num: true, render: (r) => (r.pctYtd ? ui.money(r.pctYtd, { cur: false }) : '<span class="muted">—</span>') },
      ],
      [...st.rows].sort((a, b) => (b.perM2 ?? -1) - (a.perM2 ?? -1)),
      { empty: ui.esc(tr('trn|No trading tenants yet.')), href: (r) => `/admin/turnover/leases/${r.lease.id}`, cls: 'trn-rank' },
    );
    const bench = st.categories.length
      ? `<ul class="legend trn-bench">${st.categories.map((c) => `<li><span>${ui.esc(c.label)}</span><small class="muted">${ui.esc(tn(c.n, 'trn|{n} tenant', 'trn|{n} tenants'))} · ${ui.esc(tr('trn|occupancy cost {pct}', { pct: X.pct1(c.ocr) }))}</small><b>${perM2(c.perM2)}</b></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('trn|Benchmarks appear once tenants report sales.'))}</p>`;
    const missList = miss.length
      ? `<ul class="list">${miss.slice(0, 12).map((m) => `<li><a href="/admin/turnover/leases/${m.lease.id}"><span class="dot dot--${m.late ? 'rose' : 'amber'}"></span><span class="what"><b>${ui.esc(m.lease.brand_name)} · ${ui.esc(X.periodLabel(m.period))}</b><small>${ui.esc(m.late ? tr('trn|Late since {date}', { date: ui.date(m.due) }) : tr('trn|Due {date}', { date: ui.date(m.due) }))}${m.draft ? ` · ${ui.esc(tr('trn|draft saved'))}` : ''}</small></span></a></li>`).join('')}</ul>${miss.length > 12 ? `<p class="muted small">${ui.esc(tr('trn|and {n} more', { n: miss.length - 12 }))}</p>` : ''}`
      : `<p class="muted pad">${ui.esc(tr('trn|Every sales certificate due is in.'))}</p>`;
    const remindBtn = late.length && h.can(req, 'agent') ? ui.form('/admin/turnover/remind', req.session.csrf, ui.btn(tr('trn|Send reminders'), { cls: 'btn--ghost btn--sm', ic: 'mail' })) : '';
    const body = `${nav('/admin/turnover')}<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side">
  ${ui.card(tr('trn|Tenant sales by month'), chart, { sub: ui.esc(tr('trn|Net sales reported, last 12 months')) })}
  ${ui.card(tr('trn|Category benchmarks'), bench, { sub: ui.esc(tr('trn|Average monthly sales per m², last 3 months')) })}
</div>
${ui.card(tr('trn|Tenant ranking'), ranking, { sub: ui.esc(tr('trn|Occupancy cost: base rent and service charge as a share of sales, last 3 months')), action: ui.btn(tr('Export CSV'), { href: '/admin/turnover/sales.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}
<div id="missing">${ui.card(tr('trn|Outstanding sales certificates'), missList, { action: remindBtn })}</div>`;
    h.page(req, res, { title: tr('trn|Turnover & sales'), active: '/admin/turnover', wide: true, body });
  });

  // the monthly entry grid
  router.get('/turnover/sales', (req, res) => {
    const period = /^\d{4}-\d{2}$/.test(String(req.query.period || '')) && req.query.period <= C.ymOf(M.today()) ? req.query.period : X.lastMonth();
    const leases = X.activeLeases().filter((s) => C.monthCover(s, period) > 0);
    const canEdit = h.can(req, 'agent');
    const canVerify = h.can(req, 'manager');
    const rows = leases.map((s) => ({ s, sale: db.get('SELECT * FROM tenant_sales WHERE lease_id = ? AND period = ?', s.id, period), locked: isLocked(s.id, period), terms: termsOf(s.id) }));
    const months = C.ymRange(C.ymAdd(X.lastMonth(), -11), C.ymOf(M.today())).reverse();
    const pick = `<form class="filters" method="get">${ui.select('period', tr('trn|Month'), months.map((m) => [m, ui.monthYear(m)]), period, { cls: 'f--inline', attrs: { 'data-autosubmit': true } })}${ui.btn(tr('trn|Show'), { cls: 'btn--ghost btn--sm' })}</form>`;
    const inp = (name, val, dis) => `<input class="cellin" type="number" min="0" step="0.01" name="${name}" value="${val ?? ''}" ${dis ? 'disabled' : ''} inputmode="decimal">`;
    const table = rows.length
      ? X.resp(`<div class="tablewrap"><table class="table trn-grid"><thead><tr><th>${tr('trn|Tenant')}</th><th class="num">${tr('trn|Gross sales')}</th><th class="num">${tr('trn|Returns')}</th><th class="num">${tr('trn|Net sales')}</th><th class="num">${tr('trn|Receipts')}</th><th>${tr('Status')}</th>${canVerify ? `<th>${tr('trn|Verify')}</th>` : ''}</tr></thead><tbody>${rows.map(({ s, sale, locked, terms }) => `<tr>
          <td><a href="/admin/turnover/leases/${s.id}"><b>${ui.esc(s.brand_name)}</b></a><small class="sub">${ui.esc(s.units.map((u) => u.code).join(' · '))}${terms ? ` · ${ui.esc(tr('trn|{pct}% turnover rent', { pct: terms.pct }))}` : ''}</small></td>
          <td class="num">${inp(`gross_${s.id}`, sale && sale.gross, !canEdit || locked)}</td>
          <td class="num">${inp(`returns_${s.id}`, sale && sale.returns, !canEdit || locked)}</td>
          <td class="num"><b>${sale ? ui.money(sale.amount, { cur: false }) : '—'}</b></td>
          <td class="num"><input class="cellin cellin--sm" type="number" min="0" step="1" name="tx_${s.id}" value="${sale && sale.transactions !== null ? sale.transactions : ''}" ${!canEdit || locked ? 'disabled' : ''} inputmode="numeric"></td>
          <td>${sale ? sbadge(sale.status) : ui.badge('missing', tr('trn|Not in'), 'amber')}${locked ? ` ${ui.badge('locked', tr('trn|Billed'), 'mute')}` : ''}${sale && sale.submitted_via === 'portal' ? ` <small class="muted">${ui.esc(tr('trn|via portal'))}</small>` : ''}</td>
          ${canVerify ? `<td>${sale && !locked && sale.status !== 'verified' ? `<label class="check"><input type="checkbox" name="verify_${s.id}" value="1"> ${tr('trn|Verify')}</label>` : sale && sale.status === 'verified' ? ui.icon('check') : ''}</td>` : ''}
        </tr>`).join('')}</tbody></table></div>`)
      : ui.empty(tr('trn|No lease was trading in this month.'));
    const form = canEdit && rows.length
      ? ui.form('/admin/turnover/sales', req.session.csrf, `<input type="hidden" name="period" value="${period}">${table}<div class="row trn-save">${ui.btn(tr('trn|Save sales'), { cls: 'btn--primary' })}<span class="muted small">${ui.esc(tr('trn|Amounts are monthly, before VAT. Net sales = gross sales − returns.'))}</span></div>`, { cls: 'stack' })
      : table;
    const body = `${nav('/admin/turnover/sales')}${pick}${ui.card(tr('trn|Sales for {month}', { month: ui.monthYear(period) }), form, { sub: ui.esc(tr('trn|Enter what each tenant certified, or check what they submitted in the portal.')) })}`;
    h.page(req, res, { title: tr('trn|Sales submissions'), crumbs: [['/admin/turnover', tr('trn|Turnover & sales')], [null, tr('trn|Sales submissions')]], active: '/admin/turnover', wide: true, body });
  });

  router.post('/turnover/sales', R('agent'), (req, res) => {
    const period = String(req.body.period || '');
    if (!/^\d{4}-\d{2}$/.test(period)) return h.back(req, res, '/admin/turnover/sales', 'error', tr('trn|Choose a month.'));
    const back = `/admin/turnover/sales?period=${period}`;
    let saved = 0;
    let verified = 0;
    const errors = [];
    for (const s of X.activeLeases()) {
      const g = req.body[`gross_${s.id}`];
      if (g === undefined || g === '') continue;
      try {
        const old = db.get('SELECT * FROM tenant_sales WHERE lease_id = ? AND period = ?', s.id, period);
        const verify = req.body[`verify_${s.id}`] && h.can(req, 'manager');
        const same = old && C.r2(old.gross) === C.r2(g) && C.r2(old.returns) === C.r2(req.body[`returns_${s.id}`] || 0) && String(old.transactions ?? '') === String(req.body[`tx_${s.id}`] ?? '');
        if (!same) {
          saveSales(s, period, { gross: g, returns: req.body[`returns_${s.id}`], transactions: req.body[`tx_${s.id}`] }, { user: req.user, via: 'staff', by: req.user.name });
          saved++;
        }
        if (verify) {
          db.run("UPDATE tenant_sales SET status = 'verified', verified_by = ?, verified_at = ?, updated_at = ? WHERE lease_id = ? AND period = ?", req.user.id, M.now(), M.now(), s.id, period);
          verified++;
        }
      } catch (err) {
        errors.push(`${s.brand_name}: ${tr(err.message)}`);
      }
    }
    if (saved) h.log(req, 'Recorded sales', 'turnover', null, `${period} · ${saved}`);
    if (verified) h.log(req, 'Verified sales', 'turnover', null, `${period} · ${verified}`);
    if (errors.length) return h.back(req, res, back, 'error', errors.join(' · '));
    h.back(req, res, back, 'ok', tr('trn|Saved: {saved} entered, {verified} verified.', { saved, verified }));
  });

  router.get('/turnover/sales.csv', (req, res) => {
    const year = /^\d{4}$/.test(String(req.query.year || '')) ? req.query.year : null;
    const rows = db.all(`SELECT t.*, b.name brand, s.ref lease FROM tenant_sales t JOIN brands b ON b.id = t.brand_id LEFT JOIN leases s ON s.id = t.lease_id ${year ? 'WHERE substr(t.period, 1, 4) = ?' : ''} ORDER BY t.period, b.name`, ...(year ? [year] : []));
    h.log(req, 'Exported', 'export', null, 'Tenant sales');
    res.type('text/csv').attachment(`the-wave-tenant-sales${year ? `-${year}` : ''}.csv`).send(X.csv(rows, [
      ['period', tr('trn|Month')], ['brand', tr('trn|Tenant')], ['lease', tr('Lease')], ['gross', tr('trn|Gross sales')], ['returns', tr('trn|Returns')], ['amount', tr('trn|Net sales')],
      ['transactions', tr('trn|Receipts')], [(r) => tr(STATUS[r.status][0]), tr('Status')], [(r) => (r.submitted_via === 'portal' ? tr('trn|Tenant portal') : tr('trn|Leasing office')), tr('trn|Entered by')],
    ]));
  });

  // lease terms list
  router.get('/turnover/terms', (req, res) => {
    const leases = db.all("SELECT s.*, b.name brand_name, b.category FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.status IN ('draft','active') ORDER BY b.name");
    const table = ui.table(
      [
        { label: tr('trn|Tenant'), render: (s) => `<b>${ui.esc(s.brand_name)}</b><small class="sub">${ui.esc(s.ref)} · ${ui.esc(M.LEASE_STATUS[s.status])}</small>` },
        { label: tr('trn|Turnover rent'), render: (s) => { const t = termsOf(s.id); return t ? `${t.pct}% · ${ui.esc(tr(BREAK[t.breakpoint_type]))}` : `<span class="muted">${ui.esc(tr('trn|No turnover clause'))}</span>`; } },
        { label: tr('trn|Reporting'), render: (s) => { const t = termsOf(s.id); return t ? ui.esc(`${tr(FREQ[t.frequency])} · ${tr('trn|due day {n}', { n: t.due_day })}`) : '—'; } },
        { label: tr('trn|Annual true-up'), render: (s) => { const t = termsOf(s.id); return t ? (t.annual_recon ? ui.icon('check') : '—') : '—'; } },
      ],
      leases,
      { empty: ui.esc(tr('trn|No leases yet.')), href: (s) => `/admin/turnover/leases/${s.id}` },
    );
    h.page(req, res, { title: tr('trn|Lease terms'), crumbs: [['/admin/turnover', tr('trn|Turnover & sales')], [null, tr('trn|Lease terms')]], active: '/admin/turnover', wide: true, body: `${nav('/admin/turnover/terms')}${ui.card(tr('trn|Turnover clauses'), table, { sub: ui.esc(tr('trn|Open a lease to set its percentage, breakpoint and reporting.')) })}` });
  });

  // billing: what can be billed now, and what was billed
  router.get('/turnover/billing', (req, res) => {
    const ready = [];
    for (const s of X.activeLeases()) {
      const terms = termsOf(s.id);
      if (!terms) continue;
      for (const c of billable(s, terms)) ready.push({ s, c });
    }
    const canBill = h.can(req, 'manager');
    const readyTable = ui.table(
      [
        { label: tr('trn|Tenant'), render: (r) => `<b>${ui.esc(r.s.brand_name)}</b><small class="sub">${ui.esc(r.s.ref)}</small>` },
        { label: tr('trn|Period'), render: (r) => `${ui.esc(r.c.annual ? tr('trn|True-up {year}', { year: r.c.period }) : X.periodLabel(r.c.period))}${r.c.missingMonths.length ? `<small class="sub late">${ui.esc(tr('trn|Missing: {months}', { months: r.c.missingMonths.map(X.periodLabel).join(', ') }))}</small>` : ''}` },
        { label: tr('trn|Net sales'), num: true, render: (r) => ui.money(r.c.sales, { cur: false }) },
        { label: tr('trn|Breakpoint'), num: true, render: (r) => ui.money(r.c.breakpoint, { cur: false }) },
        { label: tr('trn|Turnover rent'), num: true, render: (r) => { const v = r.c.annual ? r.c.diff : r.c.due; return `<b class="${v < 0 ? 'up' : ''}">${ui.money(v, { cur: false })}</b>${r.c.annual ? `<small class="sub">${ui.esc(tr('trn|less {amount} billed in the year', { amount: ui.money(r.c.previously, { cur: false }) }))}</small>` : ''}`; } },
        { label: '', render: (r) => (canBill && !r.c.missingMonths.length ? ui.form('/admin/turnover/bill', req.session.csrf, `<input type="hidden" name="lease_id" value="${r.s.id}"><input type="hidden" name="period" value="${r.c.period}">${ui.btn((r.c.annual ? r.c.diff : r.c.due) > 0 ? tr('trn|Bill') : (r.c.annual && r.c.diff < 0) ? tr('trn|Issue credit') : tr('trn|Record nil'), { cls: 'btn--primary btn--xs' })}`) : '') },
      ],
      ready,
      { empty: ui.esc(tr('trn|Nothing to bill: every ended period is billed.')) },
    );
    const done = db.all('SELECT t.*, b.name brand_name, s.ref lease_ref, i.ref invoice_ref, c.ref credit_ref FROM turnover_bills t JOIN leases s ON s.id = t.lease_id JOIN brands b ON b.id = s.brand_id LEFT JOIN invoices i ON i.id = t.invoice_id LEFT JOIN revenue_credits c ON c.id = t.credit_id ORDER BY t.created_at DESC, t.id DESC LIMIT 60');
    const doneTable = ui.table(
      [
        { label: tr('trn|Tenant'), render: (b) => `<b>${ui.esc(b.brand_name)}</b><small class="sub">${ui.esc(b.lease_ref)}</small>` },
        { label: tr('trn|Period'), render: (b) => ui.esc(b.kind === 'annual' ? tr('trn|True-up {year}', { year: b.period }) : X.periodLabel(b.period)) },
        { label: tr('trn|Net sales'), num: true, render: (b) => ui.money(b.sales, { cur: false }) },
        { label: tr('trn|Turnover rent'), num: true, render: (b) => ui.money(b.due, { cur: false }) },
        { label: tr('trn|Invoiced'), render: (b) => (b.invoice_id ? `<a href="/admin/invoices/${b.invoice_id}">${ui.esc(b.invoice_ref)}</a>${b.credits ? `<small class="sub">${ui.esc(tr('trn|after {amount} credit', { amount: ui.money(b.credits, { cur: false }) }))}</small>` : ''}` : b.credit_ref ? ui.badge('credit', tr('trn|Credit {ref}', { ref: b.credit_ref }), 'sea') : `<span class="muted">${ui.esc(tr('trn|Nothing due'))}</span>`) },
        { label: tr('Date'), render: (b) => ui.date(b.created_at) },
      ],
      done,
      { empty: ui.esc(tr('trn|No turnover rent billed yet.')) },
    );
    const body = `${nav('/admin/turnover/billing')}${ui.card(tr('trn|Ready to bill'), readyTable, { sub: ui.esc(tr('trn|Ended periods with all sales in. Turnover rent = sales above the breakpoint × the percentage.')) })}${ui.card(tr('trn|Billed'), doneTable)}`;
    h.page(req, res, { title: tr('trn|Turnover rent billing'), crumbs: [['/admin/turnover', tr('trn|Turnover & sales')], [null, tr('trn|Billing')]], active: '/admin/turnover', wide: true, body });
  });

  router.post('/turnover/bill', R('manager'), (req, res) => {
    const s = X.leaseOf(h.int(req.body.lease_id));
    const period = String(req.body.period || '');
    const back = h.safeBack(req, '/admin/turnover/billing');
    if (!s || !C.isPeriod(period)) return h.back(req, res, back, 'error', tr('That record no longer exists.'));
    let b;
    try {
      b = bill(s, period, req.user);
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    h.log(req, 'Billed turnover rent', 'lease', s.id, `${s.ref} · ${period}`);
    const msg = b.invoice_id ? tr('trn|Turnover rent billed: {amount}.', { amount: ui.money(b.amount) }) : b.credit_id ? tr('trn|Credit note issued for {amount}.', { amount: ui.money(-b.due) }) : tr('trn|Recorded: nothing due for this period.');
    h.back(req, res, back, 'ok', msg);
  });

  router.post('/turnover/remind', R('agent'), async (req, res) => {
    const r = await remind(req.user);
    h.back(req, res, '/admin/turnover#missing', 'ok', r.late ? tr('trn|{late} reminders: {sent} emailed, {logged} noted for follow-up.', r) : tr('trn|No sales certificate is late.'));
  });

  // one lease
  router.get('/turnover/leases/:id', (req, res, next) => {
    const s = X.leaseOf(h.int(req.params.id));
    if (!s) return next();
    const terms = termsOf(s.id);
    const sales = salesMap(s.id);
    const area = s.units.reduce((t, u) => t + u.indoor_m2, 0);
    const canMgr = h.can(req, 'manager');
    const canAgent = h.can(req, 'agent');
    const csrf = req.session.csrf;
    const from = C.ymOf(tradingFrom(s));
    const to = [C.ymOf(M.today()), C.ymOf(s.end_date)].sort()[0];
    const months = from <= to ? C.ymRange(from, to).reverse().slice(0, 24) : [];
    const termsForm = canMgr
      ? ui.form(`/admin/turnover/leases/${s.id}/terms`, csrf, `<div class="fields">
          ${ui.input('pct', tr('trn|Turnover rent (% of sales)'), terms ? terms.pct : '', { type: 'number', min: 0, max: 50, step: '0.1', required: true, hint: tr('trn|Typical: 6–10% fashion, 8–12% F&B') })}
          ${ui.select('breakpoint_type', tr('trn|Breakpoint'), Object.fromEntries(Object.entries(BREAK).map(([k, v]) => [k, tr(v)])), terms ? terms.breakpoint_type : 'natural')}
          ${ui.input('breakpoint', tr('trn|Fixed breakpoint (yearly sales)'), terms ? terms.breakpoint : '', { type: 'number', min: 0, step: '1', hint: tr('trn|Only for a fixed breakpoint. Natural = base rent ÷ percentage.') })}
          ${ui.select('frequency', tr('trn|Reporting and billing'), Object.fromEntries(Object.entries(FREQ).map(([k, v]) => [k, tr(v)])), terms ? terms.frequency : 'monthly')}
          ${ui.input('due_day', tr('trn|Sales certificate due on day'), terms ? terms.due_day : 10, { type: 'number', min: 1, max: 28, step: 1 })}
        </div>
        <label class="check"><input type="checkbox" name="annual_recon" value="1" ${!terms || terms.annual_recon ? 'checked' : ''}> ${tr('trn|Annual true-up on the year’s sales')}</label>
        <label class="check"><input type="checkbox" name="audit_rights" value="1" ${!terms || terms.audit_rights ? 'checked' : ''}> ${tr('trn|Landlord may audit the sales records')}</label>
        ${ui.textarea('notes', tr('Notes'), terms ? terms.notes || '' : '', { rows: 2 })}
        <div class="row">${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}${terms ? `<button type="submit" class="btn btn--ghost btn--sm" name="remove" value="1" data-confirm="${ui.esc(tr('trn|Remove the turnover clause from this lease?'))}">${tr('trn|Remove clause')}</button>` : ''}</div>`, { cls: 'stack' })
      : terms ? `<dl class="dl"><div><dt>${tr('trn|Turnover rent')}</dt><dd>${terms.pct}% · ${ui.esc(tr(BREAK[terms.breakpoint_type]))}</dd></div><div><dt>${tr('trn|Reporting')}</dt><dd>${ui.esc(tr(FREQ[terms.frequency]))}</dd></div></dl>` : `<p class="muted">${ui.esc(tr('trn|No turnover clause'))}</p>`;
    const monthRows = months.map((ym) => {
      const r = sales[ym];
      const base = C.baseRentMonth(s, s.units, ym);
      const occ = costWhileTrading(s, ym);
      const locked = isLocked(s.id, ym);
      const actions = r && canMgr && !locked
        ? `<div class="row">${r.status !== 'verified' ? ui.form(`/admin/turnover/sales/${r.id}/verify`, csrf, ui.btn(tr('trn|Verify'), { cls: 'btn--ghost btn--xs' })) : ''}${r.status !== 'disputed' ? ui.form(`/admin/turnover/sales/${r.id}/dispute`, csrf, ui.btn(tr('trn|Dispute'), { cls: 'btn--ghost btn--xs' })) : ''}</div>` : '';
      return `<tr><td>${ui.esc(X.periodLabel(ym))}</td><td class="num">${r ? ui.money(r.gross, { cur: false }) : '—'}</td><td class="num">${r ? ui.money(r.returns, { cur: false }) : '—'}</td><td class="num"><b>${r ? ui.money(r.amount, { cur: false }) : '—'}</b></td>
        <td class="num">${r && area ? ui.money(r.amount / area, { cur: false }) : '—'}</td><td class="num">${ui.money(base, { cur: false })}</td><td class="num">${r && r.amount ? ocrCell(occ / r.amount) : '—'}</td>
        <td>${r ? sbadge(r.status) : ui.badge('missing', tr('trn|Not in'), 'amber')}${locked ? ` ${ui.badge('locked', tr('trn|Billed'), 'mute')}` : ''}${r && r.document_id ? ` <a class="iconbtn" href="/admin/documents/${r.document_id}/file" target="_blank" rel="noopener" title="${ui.esc(tr('trn|Sales report'))}">${ui.icon('file')}</a>` : ''}</td><td>${actions}</td></tr>`;
    }).join('');
    const table = months.length
      ? X.resp(`<div class="tablewrap"><table class="table table--fin"><thead><tr><th>${tr('trn|Month')}</th><th class="num">${tr('trn|Gross sales')}</th><th class="num">${tr('trn|Returns')}</th><th class="num">${tr('trn|Net sales')}</th><th class="num">${tr('trn|Per m²')}</th><th class="num">${tr('trn|Base rent')}</th><th class="num">${tr('trn|Occupancy cost')}</th><th>${tr('Status')}</th><th></th></tr></thead><tbody>${monthRows}</tbody></table></div>`)
      : ui.empty(tr('trn|This lease has not started trading yet.'));
    const entry = canAgent && months.length
      ? ui.form(`/admin/turnover/leases/${s.id}/sales`, csrf, `<div class="fields">${ui.select('period', tr('trn|Month'), months.map((m) => [m, X.periodLabel(m)]), months[0])}${ui.input('gross', tr('trn|Gross sales'), '', { type: 'number', min: 0, step: '0.01', required: true })}${ui.input('returns', tr('trn|Returns'), '', { type: 'number', min: 0, step: '0.01' })}${ui.input('transactions', tr('trn|Receipts'), '', { type: 'number', min: 0, step: 1 })}</div>${ui.btn(tr('trn|Save sales'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })
      : '';
    const bills = db.all('SELECT t.*, i.ref invoice_ref, c.ref credit_ref FROM turnover_bills t LEFT JOIN invoices i ON i.id = t.invoice_id LEFT JOIN revenue_credits c ON c.id = t.credit_id WHERE t.lease_id = ? ORDER BY t.period DESC', s.id);
    const billList = bills.length
      ? `<ul class="list">${bills.map((b) => `<li><span class="what"><b>${ui.esc(b.kind === 'annual' ? tr('trn|True-up {year}', { year: b.period }) : X.periodLabel(b.period))} · ${ui.money(b.due)}</b><small>${ui.esc(tr('trn|sales {sales} · breakpoint {bp}', { sales: ui.money(b.sales, { cur: false }), bp: ui.money(b.breakpoint, { cur: false }) }))}</small></span>${b.invoice_id ? `<a class="badge badge--sky" href="/admin/invoices/${b.invoice_id}">${ui.esc(b.invoice_ref)}</a>` : b.credit_ref ? ui.badge('credit', b.credit_ref, 'sea') : ''}</li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('trn|No turnover rent billed yet.'))}</p>`;
    const ready = terms ? billable(s, terms) : [];
    const readyList = ready.length && canMgr
      ? `<ul class="list">${ready.map((c) => `<li><span class="what"><b>${ui.esc(c.annual ? tr('trn|True-up {year}', { year: c.period }) : X.periodLabel(c.period))}</b><small>${c.missingMonths.length ? ui.esc(tr('trn|Missing: {months}', { months: c.missingMonths.map(X.periodLabel).join(', ') })) : ui.esc(tr('trn|due {amount}', { amount: ui.money(c.annual ? c.diff : c.due) }))}</small></span>${c.missingMonths.length ? '' : ui.form('/admin/turnover/bill', csrf, `<input type="hidden" name="lease_id" value="${s.id}"><input type="hidden" name="period" value="${c.period}">${ui.btn(tr('trn|Bill'), { cls: 'btn--primary btn--xs' })}`)}</li>`).join('')}</ul>`
      : '';
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    const actions = years.length ? ui.btn(tr('trn|Sales statement'), { href: `/admin/turnover/leases/${s.id}/statement?year=${years[0]}`, cls: 'btn--ghost', ic: 'print' }) : '';
    const ytd = Object.values(sales).filter((r) => r.period.startsWith(String(X.thisYear())) && r.status !== 'draft').reduce((t, r) => t + r.amount, 0);
    const kpis = `<div class="kpis kpis--4">
      ${ui.kpi({ label: tr('trn|Sales this year'), value: ui.money(ytd, { compact: true }) })}
      ${ui.kpi({ label: tr('trn|Indoor area'), value: ui.m2(area) })}
      ${ui.kpi({ label: tr('trn|Turnover rent'), value: terms ? `${terms.pct}%` : '—', sub: terms ? ui.esc(tr(BREAK[terms.breakpoint_type])) : ui.esc(tr('trn|No turnover clause')) })}
      ${ui.kpi({ label: tr('trn|Turnover rent billed'), value: ui.money(bills.reduce((t, b) => t + Math.max(0, b.due), 0), { compact: true }) })}
    </div>`;
    const body = `${kpis}<div class="grid grid--side">
  <div class="stack">${ui.card(tr('trn|Monthly sales'), table, { sub: ui.esc(tr('trn|Occupancy cost: base rent and service charge as a share of net sales')) })}${ui.card(tr('trn|Turnover rent bills'), billList)}</div>
  <div class="stack">${readyList ? ui.card(tr('trn|Ready to bill'), readyList) : ''}${entry ? ui.card(tr('trn|Enter sales'), entry) : ''}${ui.card(tr('trn|Turnover terms'), termsForm)}</div>
</div>`;
    h.page(req, res, { title: s.brand_name, crumbs: [['/admin/turnover', tr('trn|Turnover & sales')], [`/admin/leases/${s.id}`, s.ref], [null, tr('trn|Sales')]], active: '/admin/turnover', wide: true, body, actions });
  });

  router.post('/turnover/leases/:id/terms', R('manager'), (req, res, next) => {
    const s = X.leaseOf(h.int(req.params.id));
    if (!s) return next();
    const back = `/admin/turnover/leases/${s.id}`;
    if (req.body.remove) {
      db.run('DELETE FROM turnover_terms WHERE lease_id = ?', s.id);
      h.log(req, 'Removed turnover terms', 'lease', s.id, s.ref);
      return h.back(req, res, back, 'ok', tr('trn|Turnover clause removed.'));
    }
    const pct = C.num(req.body.pct);
    if (pct === null || pct <= 0 || pct > 50) return h.back(req, res, back, 'error', tr('trn|Enter a percentage between 0 and 50.'));
    const type = BREAK[req.body.breakpoint_type] ? req.body.breakpoint_type : 'natural';
    const bp = C.num(req.body.breakpoint) || 0;
    if (type === 'fixed' && bp <= 0) return h.back(req, res, back, 'error', tr('trn|Enter the fixed breakpoint (yearly sales).'));
    const due = Math.min(28, Math.max(1, h.int(req.body.due_day) || 10));
    db.run(
      `INSERT INTO turnover_terms (lease_id, pct, breakpoint_type, breakpoint, frequency, due_day, annual_recon, audit_rights, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lease_id) DO UPDATE SET pct = excluded.pct, breakpoint_type = excluded.breakpoint_type, breakpoint = excluded.breakpoint, frequency = excluded.frequency, due_day = excluded.due_day,
       annual_recon = excluded.annual_recon, audit_rights = excluded.audit_rights, notes = excluded.notes, updated_at = excluded.updated_at`,
      s.id, pct, type, type === 'fixed' ? bp : 0, FREQ[req.body.frequency] ? req.body.frequency : 'monthly', due, req.body.annual_recon ? 1 : 0, req.body.audit_rights ? 1 : 0, h.str(req.body.notes, 500) || null, M.now(),
    );
    h.log(req, 'Saved turnover terms', 'lease', s.id, `${s.ref} · ${pct}%`);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  router.post('/turnover/leases/:id/sales', R('agent'), (req, res, next) => {
    const s = X.leaseOf(h.int(req.params.id));
    if (!s) return next();
    const back = `/admin/turnover/leases/${s.id}`;
    try {
      saveSales(s, String(req.body.period || ''), req.body, { user: req.user, via: 'staff', by: req.user.name });
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    h.log(req, 'Recorded sales', 'lease', s.id, `${s.ref} · ${req.body.period}`);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  const decide = (status, action) => (req, res, next) => {
    const r = db.get('SELECT * FROM tenant_sales WHERE id = ?', h.int(req.params.id));
    if (!r) return next();
    const back = h.safeBack(req, `/admin/turnover/leases/${r.lease_id}`);
    if (isLocked(r.lease_id, r.period)) return h.back(req, res, back, 'error', tr('trn|This month is already billed, so its sales are locked.'));
    db.run('UPDATE tenant_sales SET status = ?, verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?', status, status === 'verified' ? req.user.id : null, status === 'verified' ? M.now() : null, M.now(), r.id);
    h.log(req, action, 'lease', r.lease_id, r.period);
    h.back(req, res, back, 'ok', status === 'verified' ? tr('trn|Sales verified.') : tr('trn|Marked as disputed. The tenant should resubmit.'));
  };
  router.post('/turnover/sales/:id/verify', R('manager'), decide('verified', 'Verified sales'));
  router.post('/turnover/sales/:id/dispute', R('manager'), decide('disputed', 'Disputed sales'));

  // the yearly sales statement (printable, Arabic or English)
  router.get('/turnover/leases/:id/statement', (req, res, next) => {
    const s = X.leaseOf(h.int(req.params.id));
    if (!s) return next();
    const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : String(X.thisYear());
    const lang = ['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en';
    const html = i18n.run(lang, () => {
      const terms = termsOf(s.id);
      const sales = salesMap(s.id);
      const months = C.ymRange(`${year}-01`, `${year}-12`).filter((ym) => C.monthCover(s, ym) > 0 && ym <= C.ymOf(M.today()));
      const bills = db.all('SELECT t.*, i.ref invoice_ref, c.ref credit_ref FROM turnover_bills t LEFT JOIN invoices i ON i.id = t.invoice_id LEFT JOIN revenue_credits c ON c.id = t.credit_id WHERE t.lease_id = ? AND substr(t.period, 1, 4) = ? ORDER BY t.period', s.id, year);
      const tot = months.reduce((a, ym) => { const r = sales[ym]; return { gross: a.gross + (r ? r.gross : 0), returns: a.returns + (r ? r.returns : 0), net: a.net + (r ? r.amount : 0), base: a.base + C.baseRentMonth(s, s.units, ym) }; }, { gross: 0, returns: 0, net: 0, base: 0 });
      const st = settingsDoc();
      const sw = lang === 'ar' ? `<a class="langbtn" href="?year=${year}&doc=en" lang="en">${ui.icon('globe')}<span>English</span></a>` : `<a class="langbtn" href="?year=${year}&doc=ar" lang="ar">${ui.icon('globe')}<span>العربية</span></a>`;
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="/admin/turnover/leases/${s.id}">${tr('Back')}</a>${sw}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${tr('trn|Sales and turnover rent statement')}</p><p class="doc__ref">${tr('trn|{year} · issued {date}', { year, date: ui.date(M.today()) })}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${tr('trn|Tenant')}</p><h1>${ui.esc(s.brand_name)}</h1><p>${tr('trn|Lease {ref} · units {units} · {area}', { ref: `<bdi>${ui.esc(s.ref)}</bdi>`, units: ui.esc(s.units.map((u) => u.code).join(', ')), area: ui.m2(s.units.reduce((t, u) => t + u.indoor_m2, 0)) })}</p>
  ${terms ? `<p>${ui.esc(tr('trn|Turnover rent {pct}% of net sales · {bp}', { pct: terms.pct, bp: tr(BREAK[terms.breakpoint_type]) }))}</p>` : ''}</section>
  <table class="doc__t"><thead><tr><th>${tr('trn|Month')}</th><th class="num">${tr('trn|Gross sales')}</th><th class="num">${tr('trn|Returns')}</th><th class="num">${tr('trn|Net sales')}</th><th class="num">${tr('trn|Base rent')}</th></tr></thead>
  <tbody>${months.map((ym) => { const r = sales[ym]; return `<tr><td>${ui.esc(X.periodLabel(ym))}</td><td class="num">${r ? ui.money(r.gross, { cur: false }) : '—'}</td><td class="num">${r ? ui.money(r.returns, { cur: false }) : '—'}</td><td class="num">${r ? ui.money(r.amount, { cur: false }) : '—'}</td><td class="num">${ui.money(C.baseRentMonth(s, s.units, ym), { cur: false })}</td></tr>`; }).join('')}</tbody>
  <tfoot><tr><td>${tr('Total')}</td><td class="num">${ui.money(tot.gross, { cur: false })}</td><td class="num">${ui.money(tot.returns, { cur: false })}</td><td class="num">${ui.money(tot.net, { cur: false })}</td><td class="num">${ui.money(tot.base, { cur: false })}</td></tr></tfoot></table>
  <h2>${tr('trn|Turnover rent')}</h2>
  ${bills.length ? `<table class="doc__t"><thead><tr><th>${tr('trn|Period')}</th><th class="num">${tr('trn|Net sales')}</th><th class="num">${tr('trn|Breakpoint')}</th><th class="num">${tr('trn|Turnover rent')}</th><th>${tr('trn|Document')}</th></tr></thead><tbody>${bills.map((b) => `<tr><td>${ui.esc(b.kind === 'annual' ? tr('trn|True-up {year}', { year: b.period }) : X.periodLabel(b.period))}</td><td class="num">${ui.money(b.sales, { cur: false })}</td><td class="num">${ui.money(b.breakpoint, { cur: false })}</td><td class="num">${ui.money(b.due, { cur: false })}</td><td><bdi>${ui.esc(b.invoice_ref || b.credit_ref || '—')}</bdi></td></tr>`).join('')}</tbody></table>` : `<p>${ui.esc(tr('trn|No turnover rent billed yet.'))}</p>`}
  <p class="doc__small">${ui.esc(tr('trn|Net sales are the sales the tenant certified, less returns, before VAT. Turnover rent is billed on sales above the breakpoint at the agreed percentage.'))}</p>
  <p class="doc__foot">${ui.esc(tx(st.legal_name))} · ${ui.esc(tx(st.address))} · ${ui.esc(st.leasing_email)}</p>
</main>`;
      return ui.bare({ title: tr('trn|Sales statement'), body, cls: 'print' });
    });
    res.type('html').send(html);
  });
  const settingsDoc = () => db.settings();

  return { tradingFrom, tradeCover, costWhileTrading, termsOf, salesMap, saveSales, calcPeriod, calcAnnual, billable, bill, missing, stats, remind, expectedMonths, isLocked, STATUS, FREQ, BREAK };
};
