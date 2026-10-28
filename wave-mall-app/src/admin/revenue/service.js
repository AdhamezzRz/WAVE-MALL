'use strict';

// Service charge: the yearly budget by cost category with a management fee, the actual costs
// (entered, pasted from a spreadsheet, fed by the common-area meters or read from the books),
// apportionment to tenants by indoor area with weights, caps and exclusions (vacant space is the
// landlord's cost), and the year-end reconciliation: each lease's share of the actual costs
// against what it was billed on account, settled by invoice or by credit note.

const i18n = require('../i18n');
const { t: tr, tn, tx } = i18n;

const CATS = {
  security: 'svc|Security', cleaning: 'svc|Cleaning and waste', maintenance: 'svc|Maintenance and repairs', mep: 'svc|MEP and air conditioning',
  utilities: 'svc|Common-area utilities', landscaping: 'svc|Landscaping', insurance: 'svc|Insurance', marketing: 'svc|Marketing and events',
  staff: 'svc|Centre staff', admin: 'svc|Administration', other: 'svc|Other costs',
};
const BUDGET_STATUS = { draft: ['svc|Draft', 'mute'], approved: ['svc|Approved', 'ok'] };
const CREDIT_STATUS = { open: ['svc|Open', 'sky'], applied: ['svc|Applied', 'ok'], refunded: ['svc|Refunded', 'mute'] };
const SOURCES = { manual: 'svc|Entered', import: 'svc|Imported', utilities: 'svc|Meters', ledger: 'svc|Accounts' };

const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
const overlap = (a1, a2, b1, b2) => {
  const s = a1 > b1 ? a1 : b1;
  const e = a2 < b2 ? a2 : b2;
  return s > e ? 0 : days(s, e);
};

module.exports = function service(router, h, X) {
  const { db, ui, M } = h;
  const { C } = X;
  const R = h.R;

  const catLabel = (k) => tr(CATS[k] || 'svc|Other costs');
  const catOf = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    if (CATS[s]) return s;
    for (const [k, key] of Object.entries(CATS)) {
      const en = key.slice(4).toLowerCase();
      const ar = i18n.AR[key];
      if (s === en || (ar && s === String(ar).toLowerCase()) || en.startsWith(s)) return k;
    }
    return null;
  };
  const yearOf = (req) => {
    const y = h.int(req.query.year || req.body.year);
    return y && y > 2000 && y < 2100 ? y : X.thisYear();
  };

  // ---------- budget ----------
  const budgetOf = (year) => db.get('SELECT * FROM sc_budgets WHERE year = ?', year);
  function budgetLines(year) {
    const b = budgetOf(year);
    const rows = b ? db.all('SELECT * FROM sc_lines WHERE budget_id = ?', b.id) : [];
    const by = Object.fromEntries(rows.map((r) => [r.category, r]));
    return Object.keys(CATS).map((k) => by[k] || { category: k, amount: 0, recoverable: 1, accounts: null, note: null, missing: true });
  }
  function ensureBudget(year, { demo = 0 } = {}) {
    let b = budgetOf(year);
    if (!b) {
      db.run('INSERT INTO sc_budgets (year, status, mgmt_fee_pct, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', year, 'draft', 10, demo ? 1 : 0, M.now(), M.now());
      b = budgetOf(year);
    }
    return b;
  }
  function saveLines(year, lines, { mgmt_fee_pct, notes } = {}) {
    return db.tx(() => {
      const b = ensureBudget(year);
      for (const l of lines) {
        db.run(
          `INSERT INTO sc_lines (budget_id, category, amount, recoverable, accounts, note) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(budget_id, category) DO UPDATE SET amount = excluded.amount, recoverable = excluded.recoverable, accounts = excluded.accounts, note = excluded.note`,
          b.id, l.category, C.r2(l.amount), l.recoverable ? 1 : 0, l.accounts || null, l.note || null,
        );
      }
      if (mgmt_fee_pct !== undefined) db.run('UPDATE sc_budgets SET mgmt_fee_pct = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?', mgmt_fee_pct, notes ?? null, M.now(), b.id);
      return budgetOf(year);
    });
  }

  // ---------- actual costs ----------
  const actualsOf = (year) => db.all('SELECT a.*, u.name user_name FROM sc_actuals a LEFT JOIN users u ON u.id = a.user_id WHERE a.year = ? ORDER BY a.period DESC, a.id DESC', year);
  function addActual({ year, period, category, amount, description, source = 'manual', source_ref = null, user = null, demo = 0 }) {
    if (!/^\d{4}-\d{2}$/.test(String(period || '')) || Number(period.slice(0, 4)) !== Number(year)) throw new Error('svc|Choose a month in the selected year.');
    if (!CATS[category]) throw new Error('svc|Choose a cost category.');
    const amt = C.num(amount);
    if (amt === null || amt === 0) throw new Error('svc|Enter the amount.');
    if (source_ref) db.run('DELETE FROM sc_actuals WHERE source = ? AND source_ref = ?', source, source_ref);
    return Number(db.run(
      'INSERT INTO sc_actuals (year, period, category, amount, description, source, source_ref, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      Number(year), period, category, C.r2(amt), description || null, source, source_ref, user ? user.id : null, demo ? 1 : 0, M.now(),
    ).lastInsertRowid);
  }
  // Rows pasted from a spreadsheet: month (2026-03 or a date), category, amount, description.
  function importRows(year, text, user) {
    const isData = (r) => /\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(r[0] || '');
    const rows = X.parseTable(text, isData);
    const bad = [];
    let added = 0;
    db.tx(() => {
      rows.forEach((r, i) => {
        const p = String(r[0] || '').trim();
        let ym = null;
        let m;
        if ((m = /^(\d{4})-(\d{1,2})/.exec(p))) ym = `${m[1]}-${m[2].padStart(2, '0')}`;
        else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(p))) ym = `${m[3]}-${m[2].padStart(2, '0')}`;
        else if ((m = /^(\d{1,2})[/.-](\d{4})$/.exec(p))) ym = `${m[2]}-${m[1].padStart(2, '0')}`;
        const cat = catOf(r[1]);
        const amt = X.amountOf(r[2]);
        try {
          if (!ym || !cat || amt === null) throw new Error('bad');
          addActual({ year, period: ym, category: cat, amount: amt, description: h.str(r[3] || '', 200) || null, source: 'import', user });
          added++;
        } catch {
          bad.push(i + 1);
        }
      });
    });
    return { added, bad };
  }
  // Costs from the general ledger, when the accounting module is installed: each budget line lists
  // account codes (a code also takes its sub-accounts); the expense booked to them each month
  // becomes that category's actual. Re-running replaces the previous import for the year.
  const hasLedger = () => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'acc_lines'");
  function importLedger(year, user) {
    if (!hasLedger()) throw new Error('svc|The accounting module is not installed.');
    const lines = budgetLines(year).filter((l) => l.accounts);
    if (!lines.length) throw new Error('svc|Add account codes to the budget lines first.');
    let added = 0;
    db.tx(() => {
      db.run("DELETE FROM sc_actuals WHERE year = ? AND source = 'ledger'", year);
      for (const l of lines) {
        const codes = String(l.accounts).split(/[\s,;]+/).filter(Boolean);
        if (!codes.length) continue;
        const rows = db.all(
          `SELECT substr(e.date, 1, 7) ym, SUM(l.debit - l.credit) amt FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id JOIN acc_accounts a ON a.id = l.account_id
           WHERE substr(e.date, 1, 4) = ? AND a.type = 'expense' AND (${codes.map(() => "a.code = ? OR a.code LIKE ? || '%'").join(' OR ')}) GROUP BY ym`,
          String(year), ...codes.flatMap((c) => [c, c]),
        );
        for (const r of rows) {
          if (!r.amt) continue;
          addActual({ year, period: r.ym, category: l.category, amount: r.amt, description: `General ledger: ${codes.join(', ')}`, source: 'ledger', source_ref: `ledger:${r.ym}:${l.category}`, user });
          added++;
        }
      }
    });
    return added;
  }

  // ---------- apportionment ----------
  function windowOf(year) {
    const today = M.today();
    const ty = Number(today.slice(0, 4));
    if (year < ty) return { from: `${year}-01-01`, to: `${year}-12-31`, mode: 'final' };
    if (year === ty) return { from: `${year}-01-01`, to: today, mode: 'ytd' };
    return { from: `${year}-01-01`, to: `${year}-12-31`, mode: 'forecast' };
  }
  const rulesOf = (year) => Object.fromEntries(db.all('SELECT * FROM sc_unit_rules WHERE year = ?', year).map((r) => [r.unit_id, r]));
  // Who held each unit in the window, as a share of the window.
  function occupancy(from, to) {
    const span = days(from, to);
    const out = {};
    for (const r of db.all("SELECT lu.unit_id, s.id lease_id, s.start_date, s.end_date FROM lease_units lu JOIN leases s ON s.id = lu.lease_id WHERE s.status IN ('active','ended','terminated')")) {
      const d = overlap(r.start_date.slice(0, 10), r.end_date.slice(0, 10), from, to);
      if (d > 0) (out[r.unit_id] = out[r.unit_id] || []).push({ lease_id: r.lease_id, fraction: d / span, days: d });
    }
    return out;
  }
  // The service charge a lease was billed on account in the window (rent invoices carry it; each
  // invoice counts for the days of its period inside the window).
  function billedOnAccount(leaseId, from, to) {
    let sum = 0;
    for (const i of db.all("SELECT * FROM invoices WHERE lease_id = ? AND status != 'void' AND kind IN ('rent','service') AND service > 0", leaseId)) {
      if (i.period_start && i.period_end) {
        const all = days(i.period_start.slice(0, 10), i.period_end.slice(0, 10));
        const inside = overlap(i.period_start.slice(0, 10), i.period_end.slice(0, 10), from, to);
        if (all > 0) sum += (i.service * inside) / all;
      } else if (i.due_date >= from && i.due_date <= to) sum += i.service;
    }
    return C.r2(sum);
  }

  function recon(year) {
    const w = windowOf(year);
    const budget = budgetOf(year);
    const lines = budgetLines(year);
    const recoverable = new Set(lines.filter((l) => l.recoverable).map((l) => l.category));
    const toYm = C.ymOf(w.to);
    const actualRows = db.all('SELECT category, SUM(amount) amount FROM sc_actuals WHERE year = ? AND period <= ? GROUP BY category', year, toYm);
    const actualBy = Object.fromEntries(actualRows.map((r) => [r.category, C.r2(r.amount)]));
    const budgetTotal = C.r2(lines.reduce((t, l) => t + l.amount, 0));
    const budgetRecoverable = C.r2(lines.filter((l) => l.recoverable).reduce((t, l) => t + l.amount, 0));
    const actualTotal = C.r2(Object.values(actualBy).reduce((t, v) => t + v, 0));
    const fee = budget ? budget.mgmt_fee_pct : 10;
    // forecast years share the budget; others the actual costs to date
    const base = w.mode === 'forecast' ? budgetRecoverable : C.r2(Object.entries(actualBy).filter(([k]) => recoverable.has(k)).reduce((t, [, v]) => t + v, 0));
    const feeAmt = C.r2((base * fee) / 100);
    const pool = C.r2(base + feeAmt);
    const rules = rulesOf(year);
    const occ = occupancy(w.from, w.to);
    const units = db.all('SELECT * FROM units ORDER BY sort, code');
    const appor = C.apportion(pool, units.map((u) => ({
      id: u.id, area: u.indoor_m2, weight: rules[u.id] ? rules[u.id].weight : 1, excluded: rules[u.id] ? !!rules[u.id].excluded : false,
      cap: rules[u.id] && rules[u.id].cap !== null ? rules[u.id].cap : null, occupied: occ[u.id] || [],
    })));
    const leaseIds = new Set(Object.keys(appor.leases).map(Number));
    // a lease billed on account but outside the pool (e.g. an excluded unit) still appears, at a zero share
    for (const r of db.all("SELECT DISTINCT lease_id FROM invoices WHERE lease_id IS NOT NULL AND status != 'void' AND kind IN ('rent','service') AND service > 0")) {
      if (billedOnAccount(r.lease_id, w.from, w.to) > 0) leaseIds.add(r.lease_id);
    }
    const rows = [...leaseIds].map((id) => {
      const lease = X.leaseOf(id);
      const share = appor.leases[id] || 0;
      const billed = billedOnAccount(id, w.from, w.to);
      return { lease, share, billed, balance: C.r2(share - billed), settled: db.get('SELECT r.*, i.ref invoice_ref, c.ref credit_ref FROM sc_recons r LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN revenue_credits c ON c.id = r.credit_id WHERE r.year = ? AND r.lease_id = ?', year, id) };
    }).filter((r) => r.lease).sort((a, b) => a.lease.brand_name.localeCompare(b.lease.brand_name));
    return {
      year, ...w, budget, lines, recoverable, actualBy, budgetTotal, budgetRecoverable, actualTotal, base, fee, feeAmt, pool, appor, rows, units, rules, occ,
      billed: C.r2(rows.reduce((t, r) => t + r.billed, 0)),
      tenants: C.r2(Object.values(appor.leases).reduce((t, v) => t + v, 0)),
    };
  }

  // Issue the year's settlements: an invoice for each lease that owes, a credit note for each
  // lease that overpaid. Once per lease and year.
  function settle(year, user, { demo = 0 } = {}) {
    const r = recon(year);
    if (r.mode !== 'final') throw new Error('svc|Settlements are issued once the year has ended.');
    if (!r.pool) throw new Error('svc|Enter the year’s actual costs first.');
    let invoices = 0;
    let credits = 0;
    let nil = 0;
    db.tx(() => {
      for (const row of r.rows) {
        if (row.settled) continue;
        const { lease } = row;
        const id = Number(db.run(
          'INSERT INTO sc_recons (year, lease_id, brand_id, share, billed, balance, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          year, lease.id, lease.brand_id, row.share, row.billed, row.balance, user ? user.id : null, demo ? 1 : 0, M.now(),
        ).lastInsertRowid);
        if (row.balance >= 1) {
          const { net, uses } = X.takeCredits(lease.id, row.balance);
          let invoiceId = null;
          if (net > 0) {
            const inv = h.billing.createInvoice({
              lease_id: lease.id, kind: 'service_recon', service: net, due_date: M.addDays(M.today(), 30), source: 'service_recon', source_id: id,
              period_start: `${year}-01-01`, period_end: `${year}-12-31`, demo,
              note: uses.length ? `Service charge settlement ${year}, less credit ${X.creditNote(uses)}` : `Service charge settlement ${year}`,
            }, { user });
            invoiceId = inv.id;
            invoices++;
          }
          X.recordUses(uses, invoiceId, 'service_recon', `${year}:${lease.id}`);
          db.run('UPDATE sc_recons SET invoice_id = ?, credits = ? WHERE id = ?', invoiceId, C.r2(row.balance - net), id);
        } else if (row.balance <= -1) {
          const cn = X.addCredit({ lease_id: lease.id, brand_id: lease.brand_id, source: 'service_recon', source_ref: `${year}:${lease.id}`, amount: -row.balance, note: `Service charge settlement ${year}`, demo });
          db.run('UPDATE sc_recons SET credit_id = ? WHERE id = ?', cn.id, id);
          credits++;
        } else nil++;
      }
    });
    return { invoices, credits, nil };
  }

  // ---------- pages ----------
  const nav = (active, year) => X.tabs([
    [`/admin/service-charge?year=${year}`, tr('svc|Overview')], [`/admin/service-charge/budget?year=${year}`, tr('svc|Budget')], [`/admin/service-charge/actuals?year=${year}`, tr('svc|Actual costs')],
    [`/admin/service-charge/rules?year=${year}`, tr('svc|Apportionment')], [`/admin/service-charge/reconciliation?year=${year}`, tr('svc|Reconciliation')], ['/admin/service-charge/credits', tr('svc|Credit notes')],
  ], active);
  const yearPick = (path, year) => {
    const years = [...new Set([X.thisYear() + 1, X.thisYear(), X.thisYear() - 1, X.thisYear() - 2, ...db.all('SELECT year FROM sc_budgets').map((r) => r.year)])].sort((a, b) => b - a);
    return `<form class="filters" method="get" action="${path}">${ui.select('year', tr('svc|Year'), years.map((y) => [y, String(y)]), year, { cls: 'f--inline', attrs: { 'data-autosubmit': true } })}${ui.btn(tr('svc|Show'), { cls: 'btn--ghost btn--sm' })}</form>`;
  };
  const modeNote = (r) => (r.mode === 'final'
    ? tr('svc|{year} has ended: these are the final figures.', { year: r.year })
    : r.mode === 'ytd' ? tr('svc|{year} to date ({date}): actual costs so far against the service charge billed for the same days.', { year: r.year, date: ui.date(r.to) })
      : tr('svc|{year} has not started: shares are forecast from the budget and the leases signed.', { year: r.year }));
  const m0 = (n) => ui.money(n, { cur: false });

  router.get('/service-charge', (req, res) => {
    const year = yearOf(req);
    const r = recon(year);
    const used = r.budgetTotal ? r.actualTotal / r.budgetTotal : null;
    const elapsed = r.mode === 'final' ? 1 : r.mode === 'forecast' ? 0 : days(r.from, r.to) / days(r.from, `${year}-12-31`);
    const totalArea = r.units.reduce((t, u) => t + u.indoor_m2, 0);
    const kpis = [
      ui.kpi({ label: tr('svc|Budget {year}', { year }), value: ui.money(r.budgetTotal, { compact: true }), sub: r.budget ? ui.badge(r.budget.status, tr(BUDGET_STATUS[r.budget.status][0]), BUDGET_STATUS[r.budget.status][1]) : ui.esc(tr('svc|No budget yet')), href: `/admin/service-charge/budget?year=${year}` }),
      ui.kpi({ label: r.mode === 'final' ? tr('svc|Actual costs') : tr('svc|Actual costs to date'), value: ui.money(r.actualTotal, { compact: true }), bar: used === null ? null : Math.min(1, used), sub: used === null ? '' : ui.esc(tr('svc|{pct} of budget · {time} of the year gone', { pct: X.pct1(used), time: X.pct1(elapsed) })), tone: used !== null && used > elapsed + 0.1 ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('svc|Billed on account'), value: ui.money(r.billed, { compact: true }), sub: ui.esc(tr('svc|service charge on rent invoices, same period')) }),
      ui.kpi({ label: tr('svc|Landlord’s cost (vacancy)'), value: ui.money(r.appor.landlord, { compact: true }), sub: ui.esc(r.pool ? tr('svc|{pct} of recoverable costs', { pct: X.pct1(r.appor.landlord / r.pool) }) : tr('svc|no recoverable costs yet')) }),
    ].join('');
    const byCat = Object.keys(CATS).map((k) => {
      const line = r.lines.find((l) => l.category === k);
      return { label: catLabel(k), budget: C.r2((line ? line.amount : 0) * (r.mode === 'ytd' ? elapsed : 1)), actual: r.actualBy[k] || 0 };
    }).filter((x) => x.budget || x.actual);
    const catChart = byCat.length
      ? `<div class="svc-cats">${byCat.map((x) => { const max = Math.max(...byCat.map((y) => Math.max(y.budget, y.actual))) || 1; const over = x.budget && x.actual > x.budget * 1.05; return `<div class="svc-cat"><span>${ui.esc(x.label)}</span><span class="svc-cat__bars"><i class="svc-cat__b" style="width:${((x.budget / max) * 100).toFixed(1)}%"></i><i class="svc-cat__a${over ? ' is-over' : ''}" style="width:${((x.actual / max) * 100).toFixed(1)}%"></i></span><b class="${over ? 'late' : ''}">${m0(x.actual)}</b><small class="muted">${m0(x.budget)}</small></div>`; }).join('')}</div><p class="rev-key small muted"><i class="rev-key__sw rev-key__sw--b"></i>${ui.esc(r.mode === 'ytd' ? tr('svc|Budget to date') : tr('svc|Budget'))} <i class="rev-key__sw rev-key__sw--a"></i>${ui.esc(tr('svc|Actual'))}</p>`
      : ui.empty(tr('svc|No budget or costs for this year yet.'), ui.btn(tr('svc|Set the budget'), { href: `/admin/service-charge/budget?year=${year}`, cls: 'btn--primary btn--sm' }));
    const months = C.ymRange(`${year}-01`, `${year}-12`).map((ym) => ({ ym, label: ui.monthName(Number(ym.slice(5, 7))), amount: C.r2(db.value('SELECT COALESCE(SUM(amount), 0) FROM sc_actuals WHERE year = ? AND period = ?', year, ym)) }));
    const monthly = ui.bars(months, { key: 'amount', label: 'label', fmtv: (n) => ui.money(n, { compact: true, cur: false }), tone: 'sea', h: 150 });
    const occupied = r.appor.units.reduce((t, u) => t + (u.share ? (u.share - u.vacancy) / u.share : 0) * (r.units.find((x) => x.id === u.id) || { indoor_m2: 0 }).indoor_m2, 0);
    const donut = r.pool
      ? ui.donut([{ label: tr('svc|Tenants'), value: r.tenants, tone: 'forest' }, { label: tr('svc|Vacancy'), value: r.appor.vacancy, tone: 'amber' }, { label: tr('svc|Above caps'), value: r.appor.capped, tone: 'rose' }].filter((p) => p.value > 0), { label: ui.money(r.pool, { compact: true }) })
      : '';
    const split = `${donut}<dl class="dl rev-dl">
      <div><dt>${ui.esc(tr('svc|Recoverable costs'))}</dt><dd>${m0(r.base)}</dd></div>
      <div><dt>${ui.esc(tr('svc|Management fee ({pct}%)', { pct: r.fee }))}</dt><dd>${m0(r.feeAmt)}</dd></div>
      <div><dt><b>${ui.esc(tr('svc|To share'))}</b></dt><dd><b>${m0(r.pool)}</b></dd></div>
      <div><dt>${ui.esc(tr('svc|Occupied area (time-weighted)'))}</dt><dd>${ui.m2(Math.round(occupied))} / ${ui.m2(totalArea)}</dd></div>
    </dl>`;
    const table = ui.table(
      [
        { label: tr('svc|Tenant'), render: (x) => `<b>${ui.esc(x.lease.brand_name)}</b><small class="sub">${ui.esc(x.lease.ref)} · ${ui.esc(x.lease.units.map((u) => u.code).join(' · '))}</small>` },
        { label: tr('svc|Share of costs'), num: true, render: (x) => `${m0(x.share)}<small class="sub">${r.pool ? X.pct1(x.share / r.pool) : '—'}</small>` },
        { label: tr('svc|Billed on account'), num: true, render: (x) => m0(x.billed) },
        { label: tr('svc|Balance'), num: true, render: (x) => `<b class="${x.balance > 0 ? 'late' : x.balance < 0 ? 'up' : ''}">${m0(x.balance)}</b><small class="sub">${ui.esc(x.balance > 0 ? tr('svc|tenant owes') : x.balance < 0 ? tr('svc|owed to tenant') : '')}</small>` },
        { label: tr('Status'), render: (x) => (x.settled ? ui.badge('settled', tr('svc|Settled'), 'ok') : r.mode === 'final' ? ui.badge('due', tr('svc|To settle'), 'amber') : ui.badge('ytd', r.mode === 'ytd' ? tr('svc|Year to date') : tr('svc|Forecast'), 'mute')) },
        { label: '', render: (x) => ui.btn(tr('svc|Statement'), { href: `/admin/service-charge/statement/${x.lease.id}?year=${year}`, cls: 'btn--ghost btn--xs', ic: 'print' }) },
      ],
      r.rows,
      { empty: ui.esc(tr('svc|No lease held space in this period.')) },
    );
    const body = `${nav(`/admin/service-charge?year=${year}`, year)}${yearPick('/admin/service-charge', year)}
<p class="rev-note">${ui.esc(modeNote(r))}</p>
<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side">
  ${ui.card(tr('svc|Budget and actual by category'), catChart, { sub: ui.esc(tr('svc|Bar: actual; band: budget')) })}
  ${ui.card(tr('svc|Who carries the costs'), split, { sub: ui.esc(tr('svc|Shared by indoor area; vacant space is the landlord’s cost')) })}
</div>
${ui.card(tr('svc|Actual costs by month'), monthly, { action: ui.btn(tr('svc|Add costs'), { href: `/admin/service-charge/actuals?year=${year}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) })}
${ui.card(tr('svc|Tenants'), table, { sub: ui.esc(tr('svc|Each lease’s share for the time it held its units, against the service charge it was billed')) })}`;
    h.page(req, res, { title: tr('svc|Service charge'), active: '/admin/service-charge', wide: true, body });
  });

  // budget
  router.get('/service-charge/budget', (req, res) => {
    const year = yearOf(req);
    const b = budgetOf(year);
    const lines = budgetLines(year);
    const prev = budgetOf(year - 1);
    const canEdit = h.can(req, 'manager') && (!b || b.status === 'draft');
    const total = lines.reduce((t, l) => t + l.amount, 0);
    const rec = lines.filter((l) => l.recoverable).reduce((t, l) => t + l.amount, 0);
    const fee = b ? b.mgmt_fee_pct : 10;
    const area = db.value('SELECT COALESCE(SUM(indoor_m2), 0) FROM units');
    const perM2 = area ? (rec * (1 + fee / 100)) / area / 12 : 0;
    const actualPrev = prev ? db.value('SELECT COALESCE(SUM(amount), 0) FROM sc_actuals WHERE year = ?', year - 1) : 0;
    const rows = lines.map((l) => {
      const prevLine = prev ? db.get('SELECT amount FROM sc_lines WHERE budget_id = ? AND category = ?', prev.id, l.category) : null;
      return `<tr><td><b>${ui.esc(catLabel(l.category))}</b></td>
        <td class="num">${canEdit ? `<input class="cellin" type="number" min="0" step="1" name="amount_${l.category}" value="${l.amount || ''}" inputmode="decimal">` : m0(l.amount)}</td>
        <td class="num muted">${prevLine ? m0(prevLine.amount) : '—'}</td>
        <td>${canEdit ? `<label class="check"><input type="checkbox" name="rec_${l.category}" value="1" ${l.recoverable ? 'checked' : ''}> ${ui.esc(tr('svc|Recoverable'))}</label>` : l.recoverable ? ui.esc(tr('svc|Recoverable')) : `<span class="muted">${ui.esc(tr('svc|Landlord only'))}</span>`}</td>
        <td>${canEdit ? `<input class="cellin cellin--wide" type="text" name="acc_${l.category}" value="${ui.esc(l.accounts || '')}" placeholder="${ui.esc(tr('svc|e.g. 5210, 5220'))}" dir="ltr">` : `<span class="muted">${ui.esc(l.accounts || '—')}</span>`}</td></tr>`;
    }).join('');
    const table = X.resp(`<div class="tablewrap"><table class="table svc-budget"><thead><tr><th>${ui.esc(tr('svc|Category'))}</th><th class="num">${ui.esc(tr('svc|Budget {year}', { year }))}</th><th class="num">${ui.esc(tr('svc|Budget {year}', { year: year - 1 }))}</th><th>${ui.esc(tr('svc|Recovery'))}</th><th>${ui.esc(tr('svc|Ledger accounts'))}</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td>${ui.esc(tr('Total'))}</td><td class="num"><b>${m0(total)}</b></td><td class="num muted">${prev ? m0(db.value('SELECT COALESCE(SUM(amount), 0) FROM sc_lines WHERE budget_id = ?', prev.id)) : '—'}</td><td colspan="2"></td></tr></tfoot></table></div>`);
    const settings = canEdit
      ? `<div class="fields">${ui.input('mgmt_fee_pct', tr('svc|Management fee (%)'), fee, { type: 'number', min: 0, max: 30, step: '0.5', hint: tr('svc|Added to the recoverable costs before they are shared') })}</div>${ui.textarea('notes', tr('Notes'), b ? b.notes || '' : '', { rows: 2 })}`
      : `<p>${ui.esc(tr('svc|Management fee ({pct}%)', { pct: fee }))}</p>`;
    const form = canEdit
      ? ui.form('/admin/service-charge/budget', req.session.csrf, `<input type="hidden" name="year" value="${year}">${table}${settings}<div class="row">${ui.btn(tr('Save'), { cls: 'btn--primary' })}</div>`, { cls: 'stack' })
      : `${table}${settings}`;
    const side = [];
    side.push(`<dl class="dl"><div><dt>${ui.esc(tr('svc|Recoverable budget'))}</dt><dd>${m0(rec)}</dd></div><div><dt>${ui.esc(tr('svc|With management fee'))}</dt><dd>${m0(rec * (1 + fee / 100))}</dd></div><div><dt>${ui.esc(tr('svc|Per m² a month (all indoor area)'))}</dt><dd><b>${m0(Math.round(perM2 * 100) / 100)}</b></dd></div>${prev ? `<div><dt>${ui.esc(tr('svc|Actual costs {year}', { year: year - 1 }))}</dt><dd>${m0(actualPrev)}</dd></div>` : ''}</dl>`);
    if (h.can(req, 'manager')) {
      if (b && b.status === 'draft' && total > 0) side.push(ui.form('/admin/service-charge/budget/approve', req.session.csrf, `<input type="hidden" name="year" value="${year}">${ui.btn(tr('svc|Approve the budget'), { cls: 'btn--primary btn--sm', ic: 'check' })}`));
      if (b && b.status === 'approved') side.push(ui.form('/admin/service-charge/budget/reopen', req.session.csrf, `<input type="hidden" name="year" value="${year}">${ui.btn(tr('svc|Reopen for changes'), { cls: 'btn--ghost btn--sm' })}`));
      if (prev && canEdit) side.push(ui.form('/admin/service-charge/budget/copy', req.session.csrf, `<input type="hidden" name="year" value="${year}"><div class="fields">${ui.input('uplift', tr('svc|Uplift on {year} (%)', { year: year - 1 }), 10, { type: 'number', min: -50, max: 100, step: '0.5' })}</div>${ui.btn(tr('svc|Start from last year'), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' }));
    }
    const body = `${nav(`/admin/service-charge/budget?year=${year}`, year)}${yearPick('/admin/service-charge/budget', year)}
<div class="grid grid--side">${ui.card(tr('svc|Budget {year}', { year }), form, { sub: b ? ui.badge(b.status, tr(BUDGET_STATUS[b.status][0]), BUDGET_STATUS[b.status][1]) : ui.esc(tr('svc|No budget yet')) })}${ui.card(tr('svc|Summary'), side.join(''))}</div>`;
    h.page(req, res, { title: tr('svc|Service charge budget'), crumbs: [['/admin/service-charge', tr('svc|Service charge')], [null, tr('svc|Budget')]], active: '/admin/service-charge', wide: true, body });
  });

  router.post('/service-charge/budget', R('manager'), (req, res) => {
    const year = yearOf(req);
    const back = `/admin/service-charge/budget?year=${year}`;
    const b = budgetOf(year);
    if (b && b.status !== 'draft') return h.back(req, res, back, 'error', tr('svc|The budget is approved. Reopen it to make changes.'));
    const lines = Object.keys(CATS).map((k) => ({ category: k, amount: Math.max(0, C.num(req.body[`amount_${k}`]) || 0), recoverable: !!req.body[`rec_${k}`], accounts: h.str(req.body[`acc_${k}`], 120) || null }));
    const fee = Math.min(30, Math.max(0, C.num(req.body.mgmt_fee_pct) ?? 10));
    saveLines(year, lines, { mgmt_fee_pct: fee, notes: h.str(req.body.notes, 1000) || null });
    h.log(req, 'Saved service charge budget', 'service_charge', year, `${year} · ${C.r2(lines.reduce((t, l) => t + l.amount, 0))}`);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });
  router.post('/service-charge/budget/approve', R('manager'), (req, res) => {
    const year = yearOf(req);
    db.run("UPDATE sc_budgets SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE year = ?", req.user.id, M.now(), M.now(), year);
    h.log(req, 'Approved service charge budget', 'service_charge', year, String(year));
    h.back(req, res, `/admin/service-charge/budget?year=${year}`, 'ok', tr('svc|Budget approved.'));
  });
  router.post('/service-charge/budget/reopen', R('manager'), (req, res) => {
    const year = yearOf(req);
    db.run("UPDATE sc_budgets SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = ? WHERE year = ?", M.now(), year);
    h.log(req, 'Reopened service charge budget', 'service_charge', year, String(year));
    h.back(req, res, `/admin/service-charge/budget?year=${year}`, 'ok', tr('svc|Budget reopened.'));
  });
  router.post('/service-charge/budget/copy', R('manager'), (req, res) => {
    const year = yearOf(req);
    const back = `/admin/service-charge/budget?year=${year}`;
    const prev = budgetOf(year - 1);
    const b = budgetOf(year);
    if (!prev) return h.back(req, res, back, 'error', tr('That record no longer exists.'));
    if (b && b.status !== 'draft') return h.back(req, res, back, 'error', tr('svc|The budget is approved. Reopen it to make changes.'));
    const k = 1 + (C.num(req.body.uplift) || 0) / 100;
    saveLines(year, db.all('SELECT * FROM sc_lines WHERE budget_id = ?', prev.id).map((l) => ({ ...l, amount: Math.round(l.amount * k) })), { mgmt_fee_pct: prev.mgmt_fee_pct });
    h.log(req, 'Saved service charge budget', 'service_charge', year, `${year} ← ${year - 1}`);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  // actual costs
  router.get('/service-charge/actuals', (req, res) => {
    const year = yearOf(req);
    const rows = actualsOf(year);
    const canEdit = h.can(req, 'agent');
    const csrf = req.session.csrf;
    const months = C.ymRange(`${year}-01`, `${year}-12`).filter((m) => m <= C.ymOf(M.today()) || year > X.thisYear());
    const addForm = canEdit
      ? ui.form('/admin/service-charge/actuals', csrf, `<input type="hidden" name="year" value="${year}"><div class="fields">
          ${ui.select('period', tr('svc|Month'), (months.length ? months : [`${year}-01`]).map((m) => [m, ui.monthYear(m)]), months.at(-1))}
          ${ui.select('category', tr('svc|Category'), Object.keys(CATS).map((k) => [k, catLabel(k)]), 'security')}
          ${ui.input('amount', tr('svc|Amount (before VAT)'), '', { type: 'number', step: '0.01', required: true })}
          ${ui.input('description', tr('svc|Description'), '', { placeholder: tr('svc|Supplier, invoice number') })}</div>${ui.btn(tr('svc|Add cost'), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' })
      : '';
    const importForm = canEdit
      ? ui.form('/admin/service-charge/actuals/import', csrf, `<input type="hidden" name="year" value="${year}">
          <label class="f"><span class="f__l">${ui.esc(tr('svc|Paste rows from a spreadsheet'))}</span><textarea name="rows" rows="5" dir="ltr" placeholder="${year}-03, security, 185000, GuardCo invoice 114&#10;${year}-03, cleaning, 92000, CleanPro"></textarea><small>${ui.esc(tr('svc|Columns: month, category, amount, description. Or choose a CSV file:'))}</small></label>
          <input type="file" accept=".csv,.txt,text/csv" data-csv-into="rows">
          ${ui.btn(tr('svc|Import'), { cls: 'btn--ghost btn--sm', ic: 'upload' })}`, { cls: 'stack' })
      : '';
    const ledgerForm = canEdit && hasLedger()
      ? ui.form('/admin/service-charge/actuals/ledger', csrf, `<input type="hidden" name="year" value="${year}"><p class="small muted">${ui.esc(tr('svc|Reads the expense booked to the accounts listed on each budget line, month by month. Running it again replaces the previous import.'))}</p>${ui.btn(tr('svc|Import from the accounts'), { cls: 'btn--ghost btn--sm', ic: 'report' })}`, { cls: 'stack' })
      : '';
    const table = ui.table(
      [
        { label: tr('svc|Month'), render: (a) => ui.esc(ui.monthYear(a.period)) },
        { label: tr('svc|Category'), render: (a) => ui.esc(catLabel(a.category)) },
        { label: tr('svc|Description'), render: (a) => `${ui.esc(tx(a.description) || '')}<small class="sub">${ui.esc(tr(SOURCES[a.source] || 'svc|Entered'))}${a.user_name ? ` · ${ui.esc(a.user_name)}` : ''}</small>` },
        { label: tr('svc|Amount'), num: true, render: (a) => m0(a.amount) },
        { label: '', render: (a) => (canEdit && ['manual', 'import'].includes(a.source) ? ui.form(`/admin/service-charge/actuals/${a.id}/delete`, csrf, `<button type="submit" class="iconbtn" title="${ui.esc(tr('Delete'))}" data-confirm="${ui.esc(tr('svc|Delete this cost?'))}">${ui.icon('x')}</button>`) : '') },
      ],
      rows,
      { empty: ui.esc(tr('svc|No costs entered for this year yet.')) },
    );
    const total = rows.reduce((t, a) => t + a.amount, 0);
    const body = `${nav(`/admin/service-charge/actuals?year=${year}`, year)}${yearPick('/admin/service-charge/actuals', year)}
<div class="grid grid--side">
  ${ui.card(tn(rows.length, 'svc|{n} cost line', 'svc|{n} cost lines'), table, { sub: ui.esc(tr('svc|Total {amount}', { amount: ui.money(total) })), action: ui.btn(tr('Export CSV'), { href: `/admin/service-charge/actuals.csv?year=${year}`, cls: 'btn--ghost btn--sm', ic: 'dl' }) })}
  <div class="stack">${addForm ? ui.card(tr('svc|Add a cost'), addForm) : ''}${importForm ? ui.card(tr('svc|Import costs'), importForm) : ''}${ledgerForm ? ui.card(tr('svc|From the accounts'), ledgerForm) : ''}</div>
</div>`;
    h.page(req, res, { title: tr('svc|Actual costs'), crumbs: [['/admin/service-charge', tr('svc|Service charge')], [null, tr('svc|Actual costs')]], active: '/admin/service-charge', wide: true, body });
  });
  router.post('/service-charge/actuals', R('agent'), (req, res) => {
    const year = yearOf(req);
    const back = `/admin/service-charge/actuals?year=${year}`;
    try {
      addActual({ year, period: String(req.body.period || ''), category: req.body.category, amount: req.body.amount, description: h.str(req.body.description, 200), user: req.user });
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    h.log(req, 'Added service charge cost', 'service_charge', year, `${req.body.period} · ${req.body.category} · ${req.body.amount}`);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });
  router.post('/service-charge/actuals/import', R('agent'), (req, res) => {
    const year = yearOf(req);
    const back = `/admin/service-charge/actuals?year=${year}`;
    const r = importRows(year, String(req.body.rows || '').slice(0, 200000), req.user);
    if (r.added) h.log(req, 'Imported service charge costs', 'service_charge', year, `${r.added}`);
    if (!r.added) return h.back(req, res, back, 'error', tr('svc|Nothing imported. Check the columns: month, category, amount.'));
    h.back(req, res, back, r.bad.length ? 'error' : 'ok', r.bad.length ? tr('svc|{added} rows imported; rows {rows} were skipped.', { added: r.added, rows: r.bad.slice(0, 20).join(', ') }) : tr('svc|{added} rows imported.', { added: r.added }));
  });
  router.post('/service-charge/actuals/ledger', R('agent'), (req, res) => {
    const year = yearOf(req);
    const back = `/admin/service-charge/actuals?year=${year}`;
    let n;
    try {
      n = importLedger(year, req.user);
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    h.log(req, 'Imported service charge costs', 'service_charge', year, `${n}`);
    h.back(req, res, back, 'ok', tr('svc|{added} rows imported.', { added: n }));
  });
  router.post('/service-charge/actuals/:id/delete', R('agent'), (req, res, next) => {
    const a = db.get('SELECT * FROM sc_actuals WHERE id = ?', h.int(req.params.id));
    if (!a) return next();
    const back = `/admin/service-charge/actuals?year=${a.year}`;
    if (db.get('SELECT id FROM sc_recons WHERE year = ? LIMIT 1', a.year)) return h.back(req, res, back, 'error', tr('svc|This year is settled; its costs can no longer change.'));
    db.run('DELETE FROM sc_actuals WHERE id = ?', a.id);
    h.log(req, 'Deleted service charge cost', 'service_charge', a.year, `${a.period} · ${a.category} · ${a.amount}`);
    h.back(req, res, back, 'ok', tr('svc|Cost deleted.'));
  });
  router.get('/service-charge/actuals.csv', (req, res) => {
    const year = yearOf(req);
    h.log(req, 'Exported', 'export', null, 'Service charge costs');
    res.type('text/csv').attachment(`the-wave-service-charge-costs-${year}.csv`).send(X.csv([...actualsOf(year)].reverse(), [
      ['period', tr('svc|Month')], [(a) => catLabel(a.category), tr('svc|Category')], ['amount', tr('svc|Amount')], [(a) => tx(a.description) || '', tr('svc|Description')], [(a) => tr(SOURCES[a.source] || 'svc|Entered'), tr('svc|Source')],
    ]));
  });

  // apportionment rules
  router.get('/service-charge/rules', (req, res) => {
    const year = yearOf(req);
    const r = recon(year);
    const canEdit = h.can(req, 'manager') && !db.get('SELECT id FROM sc_recons WHERE year = ? LIMIT 1', year);
    const byUnit = Object.fromEntries(r.appor.units.map((u) => [u.id, u]));
    const holder = (u) => {
      const occ = (r.occ[u.id] || []).map((o) => X.leaseOf(o.lease_id)).filter(Boolean);
      return occ.length ? occ.map((s) => ui.esc(s.brand_name)).join(', ') : `<span class="muted">${ui.esc(tr('svc|Vacant'))}</span>`;
    };
    const rows = r.units.map((u) => {
      const rule = r.rules[u.id] || {};
      const a = byUnit[u.id];
      return `<tr><td><b>${ui.esc(u.code)}</b><small class="sub">${ui.esc(M.ZONES[u.zone] || u.zone)}</small></td><td>${holder(u)}</td><td class="num">${ui.m2(u.indoor_m2)}</td>
        <td class="num">${canEdit ? `<input class="cellin cellin--sm" type="number" min="0" max="5" step="0.05" name="w_${u.id}" value="${rule.weight ?? 1}" inputmode="decimal">` : rule.weight ?? 1}</td>
        <td>${canEdit ? `<label class="check"><input type="checkbox" name="x_${u.id}" value="1" ${rule.excluded ? 'checked' : ''}> ${ui.esc(tr('svc|Excluded'))}</label>` : rule.excluded ? ui.esc(tr('svc|Excluded')) : ''}</td>
        <td class="num">${canEdit ? `<input class="cellin" type="number" min="0" step="1" name="c_${u.id}" value="${rule.cap ?? ''}" placeholder="—" inputmode="decimal">` : rule.cap !== undefined && rule.cap !== null ? m0(rule.cap) : '—'}</td>
        <td class="num">${a ? X.pct1(a.pct) : '—'}</td><td class="num">${a ? m0(a.share) : '—'}</td><td class="num">${a && a.vacancy ? `<span class="rev-warn">${m0(a.vacancy)}</span>` : '—'}</td></tr>`;
    }).join('');
    const table = X.resp(`<div class="tablewrap"><table class="table svc-rules"><thead><tr><th>${ui.esc(tr('svc|Unit'))}</th><th>${ui.esc(tr('svc|Held by'))}</th><th class="num">${ui.esc(tr('svc|Indoor area'))}</th><th class="num">${ui.esc(tr('svc|Weight'))}</th><th>${ui.esc(tr('svc|Pool'))}</th><th class="num">${ui.esc(tr('svc|Yearly cap'))}</th><th class="num">${ui.esc(tr('svc|Share'))}</th><th class="num">${ui.esc(tr('svc|Cost'))}</th><th class="num">${ui.esc(tr('svc|Vacancy'))}</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td colspan="6">${ui.esc(tr('Total'))}</td><td class="num">${r.appor.units.length ? '100.0%' : '—'}</td><td class="num">${m0(r.pool)}</td><td class="num">${m0(r.appor.vacancy)}</td></tr></tfoot></table></div>`);
    const form = canEdit
      ? ui.form('/admin/service-charge/rules', req.session.csrf, `<input type="hidden" name="year" value="${year}">${table}<div class="row">${ui.btn(tr('Save'), { cls: 'btn--primary' })}<span class="small muted">${ui.esc(tr('svc|Weight: 1 = standard; e.g. 0.5 for storage, 1.2 for heavy-use F&B. A cap limits what the unit’s tenant pays in the year; the rest is the landlord’s.'))}</span></div>`, { cls: 'stack' })
      : table;
    const body = `${nav(`/admin/service-charge/rules?year=${year}`, year)}${yearPick('/admin/service-charge/rules', year)}<p class="rev-note">${ui.esc(modeNote(r))}</p>${ui.card(tr('svc|How the costs are shared'), form, { sub: ui.esc(tr('svc|Each unit’s share = its indoor area × weight ÷ the pool’s weighted area. Excluded units (e.g. an anchor on a fixed contribution) are outside the pool.')) })}`;
    h.page(req, res, { title: tr('svc|Apportionment'), crumbs: [['/admin/service-charge', tr('svc|Service charge')], [null, tr('svc|Apportionment')]], active: '/admin/service-charge', wide: true, body });
  });
  router.post('/service-charge/rules', R('manager'), (req, res) => {
    const year = yearOf(req);
    const back = `/admin/service-charge/rules?year=${year}`;
    if (db.get('SELECT id FROM sc_recons WHERE year = ? LIMIT 1', year)) return h.back(req, res, back, 'error', tr('svc|This year is settled; its costs can no longer change.'));
    db.tx(() => {
      for (const u of db.all('SELECT id FROM units')) {
        const w = C.num(req.body[`w_${u.id}`]);
        const weight = w === null ? 1 : Math.min(5, Math.max(0, w));
        const cap = C.num(req.body[`c_${u.id}`]);
        const excluded = req.body[`x_${u.id}`] ? 1 : 0;
        if (weight === 1 && !excluded && cap === null) db.run('DELETE FROM sc_unit_rules WHERE year = ? AND unit_id = ?', year, u.id);
        else {
          db.run(
            `INSERT INTO sc_unit_rules (year, unit_id, weight, excluded, cap) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(year, unit_id) DO UPDATE SET weight = excluded.weight, excluded = excluded.excluded, cap = excluded.cap`,
            year, u.id, weight, excluded, cap === null ? null : Math.max(0, cap),
          );
        }
      }
    });
    h.log(req, 'Saved apportionment rules', 'service_charge', year, String(year));
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  // reconciliation
  router.get('/service-charge/reconciliation', (req, res) => {
    const year = yearOf(req);
    const r = recon(year);
    const pending = r.rows.filter((x) => !x.settled);
    const owe = pending.filter((x) => x.balance >= 1);
    const back = pending.filter((x) => x.balance <= -1);
    const canSettle = h.can(req, 'manager') && r.mode === 'final' && pending.length && r.pool > 0;
    const check = C.r2(r.tenants + r.appor.landlord);
    const proof = `<dl class="dl rev-dl svc-proof">
      <div><dt>${ui.esc(tr('svc|Recoverable costs'))}</dt><dd>${m0(r.base)}</dd></div>
      <div><dt>${ui.esc(tr('svc|Management fee ({pct}%)', { pct: r.fee }))}</dt><dd>${m0(r.feeAmt)}</dd></div>
      <div><dt><b>${ui.esc(tr('svc|To share'))}</b></dt><dd><b>${m0(r.pool)}</b></dd></div>
      <div><dt>${ui.esc(tr('svc|Tenants’ shares'))}</dt><dd>${m0(r.tenants)}</dd></div>
      <div><dt>${ui.esc(tr('svc|Vacant space (landlord)'))}</dt><dd>${m0(r.appor.vacancy)}</dd></div>
      <div><dt>${ui.esc(tr('svc|Above caps (landlord)'))}</dt><dd>${m0(r.appor.capped)}</dd></div>
      <div><dt><b>${ui.esc(tr('svc|Shared in full'))}</b></dt><dd><b class="${check === r.pool ? 'up' : 'late'}">${m0(check)} ${check === r.pool ? ui.icon('check') : ''}</b></dd></div>
    </dl>`;
    const table = ui.table(
      [
        { label: tr('svc|Tenant'), render: (x) => `<b>${ui.esc(x.lease.brand_name)}</b><small class="sub">${ui.esc(x.lease.ref)}</small>` },
        { label: tr('svc|Share of costs'), num: true, render: (x) => m0(x.share) },
        { label: tr('svc|Billed on account'), num: true, render: (x) => m0(x.billed) },
        { label: tr('svc|Balance'), num: true, render: (x) => `<b class="${x.balance > 0 ? 'late' : x.balance < 0 ? 'up' : ''}">${m0(x.balance)}</b>` },
        { label: tr('svc|Settlement'), render: (x) => (x.settled ? (x.settled.invoice_id ? `<a href="/admin/invoices/${x.settled.invoice_id}">${ui.esc(x.settled.invoice_ref)}</a>` : x.settled.credit_ref ? ui.badge('credit', tr('svc|Credit {ref}', { ref: x.settled.credit_ref }), 'sea') : `<span class="muted">${ui.esc(tr('svc|Nothing due'))}</span>`) : x.balance >= 1 ? ui.esc(tr('svc|Invoice')) : x.balance <= -1 ? ui.esc(tr('svc|Credit note')) : `<span class="muted">${ui.esc(tr('svc|Nothing due'))}</span>`) },
        { label: '', render: (x) => ui.btn(tr('svc|Statement'), { href: `/admin/service-charge/statement/${x.lease.id}?year=${year}`, cls: 'btn--ghost btn--xs', ic: 'print' }) },
      ],
      r.rows,
      { empty: ui.esc(tr('svc|No lease held space in this period.')) },
    );
    const action = canSettle
      ? ui.form('/admin/service-charge/settle', req.session.csrf, `<input type="hidden" name="year" value="${year}">${ui.btn(tr('svc|Issue settlements'), { cls: 'btn--primary btn--sm', ic: 'bill', attrs: { 'data-confirm': tr('svc|Issue {invoices} invoices and {credits} credit notes for {year}? Costs and rules for the year are then locked.', { invoices: owe.length, credits: back.length, year }) } })}`)
      : '';
    const body = `${nav(`/admin/service-charge/reconciliation?year=${year}`, year)}${yearPick('/admin/service-charge/reconciliation', year)}<p class="rev-note">${ui.esc(modeNote(r))}</p>
<div class="grid grid--side">${ui.card(tr('svc|Settlement by tenant'), table, { action })}${ui.card(tr('svc|Proof'), proof, { sub: ui.esc(tr('svc|Tenants and landlord together carry exactly the costs')) })}</div>`;
    h.page(req, res, { title: tr('svc|Reconciliation {year}', { year }), crumbs: [['/admin/service-charge', tr('svc|Service charge')], [null, tr('svc|Reconciliation')]], active: '/admin/service-charge', wide: true, body });
  });
  router.post('/service-charge/settle', R('manager'), (req, res) => {
    const year = yearOf(req);
    const back = `/admin/service-charge/reconciliation?year=${year}`;
    let r;
    try {
      r = settle(year, req.user);
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    h.log(req, 'Issued service charge settlements', 'service_charge', year, `${year} · ${r.invoices}/${r.credits}`);
    h.back(req, res, back, 'ok', tr('svc|Settlements issued: {invoices} invoices, {credits} credit notes.', r));
  });

  // the tenant's statement (printable, Arabic or English)
  router.get('/service-charge/statement/:id', (req, res, next) => {
    const s = X.leaseOf(h.int(req.params.id));
    if (!s) return next();
    const year = yearOf(req);
    const lang = ['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en';
    const html = i18n.run(lang, () => {
      const r = recon(year);
      const row = r.rows.find((x) => x.lease.id === s.id) || { share: 0, billed: 0, balance: 0, settled: null };
      const st = db.settings();
      const uses = row.settled && row.settled.invoice_id ? db.all('SELECT u.*, c.ref FROM revenue_credit_uses u JOIN revenue_credits c ON c.id = u.credit_id WHERE u.invoice_id = ?', row.settled.invoice_id) : [];
      const units = s.units.map((u) => {
        const a = r.appor.units.find((x) => x.id === u.id);
        const held = (r.occ[u.id] || []).find((o) => o.lease_id === s.id);
        return { u, a, held };
      });
      const sw = `<a class="langbtn" href="?year=${year}&doc=${lang === 'ar' ? 'en' : 'ar'}" lang="${lang === 'ar' ? 'en' : 'ar'}">${ui.icon('globe')}<span>${lang === 'ar' ? 'English' : 'العربية'}</span></a>`;
      const title = r.mode === 'final' ? tr('svc|Service charge statement {year}', { year }) : tr('svc|Service charge statement {year} (to date)', { year });
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="/admin/service-charge/reconciliation?year=${year}">${tr('Back')}</a>${sw}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${ui.esc(title)}</p><p class="doc__ref">${ui.esc(tr('svc|{from} – {to} · issued {date}', { from: ui.date(r.from), to: ui.date(r.to), date: ui.date(M.today()) }))}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${tr('svc|Tenant')}</p><h1>${ui.esc(s.brand_name)}</h1><p>${tr('svc|Lease {ref}', { ref: `<bdi>${ui.esc(s.ref)}</bdi>` })}</p></section>
  <h2>${tr('svc|The centre’s costs')}</h2>
  <table class="doc__t"><thead><tr><th>${tr('svc|Category')}</th><th class="num">${tr('svc|Budget')}</th><th class="num">${tr('svc|Actual')}</th></tr></thead>
  <tbody>${r.lines.filter((l) => l.recoverable && (l.amount || r.actualBy[l.category])).map((l) => `<tr><td>${ui.esc(catLabel(l.category))}</td><td class="num">${m0(l.amount)}</td><td class="num">${m0(r.actualBy[l.category] || 0)}</td></tr>`).join('')}
  <tr><td>${ui.esc(tr('svc|Management fee ({pct}%)', { pct: r.fee }))}</td><td class="num">${m0(C.r2((r.budgetRecoverable * r.fee) / 100))}</td><td class="num">${m0(r.feeAmt)}</td></tr></tbody>
  <tfoot><tr><td>${tr('svc|To share')}</td><td class="num">${m0(C.r2(r.budgetRecoverable * (1 + r.fee / 100)))}</td><td class="num">${m0(r.pool)}</td></tr></tfoot></table>
  <h2>${tr('svc|Your share')}</h2>
  <table class="doc__t"><thead><tr><th>${tr('svc|Unit')}</th><th class="num">${tr('svc|Indoor area')}</th><th class="num">${tr('svc|Share')}</th><th class="num">${tr('svc|Days held')}</th><th class="num">${tr('svc|Cost')}</th></tr></thead>
  <tbody>${units.map(({ u, a, held }) => `<tr><td>${ui.esc(u.code)}</td><td class="num">${ui.m2(u.indoor_m2)}</td><td class="num">${a ? X.pct1(a.pct) : ui.esc(tr('svc|Excluded'))}</td><td class="num">${held ? held.days : 0}</td><td class="num">${a && held ? m0(C.r2(a.share * held.fraction)) : '—'}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="4">${tr('svc|Your share of the costs')}</td><td class="num">${m0(row.share)}</td></tr></tfoot></table>
  <table class="doc__t rev-sum"><tbody>
    <tr><td>${tr('svc|Your share of the costs')}</td><td class="num">${m0(row.share)}</td></tr>
    <tr><td>${tr('svc|Service charge billed on account')}</td><td class="num">− ${m0(row.billed)}</td></tr>
    ${uses.map((u) => `<tr><td>${tr('svc|Credit {ref} applied', { ref: `<bdi>${ui.esc(u.ref)}</bdi>` })}</td><td class="num">− ${m0(u.amount)}</td></tr>`).join('')}
    <tr class="rev-sum__total"><td>${row.balance >= 0 ? tr('svc|Balance due from you') : tr('svc|Balance due to you')}</td><td class="num">${ui.money(Math.abs(C.r2(row.balance - uses.reduce((t, u) => t + u.amount, 0))))}</td></tr>
  </tbody></table>
  ${row.settled ? `<p>${row.settled.invoice_ref ? tr('svc|Invoiced on {ref} (plus VAT).', { ref: `<bdi>${ui.esc(row.settled.invoice_ref)}</bdi>` }) : row.settled.credit_ref ? tr('svc|Credited on {ref}; it is set against your next invoice from the centre.', { ref: `<bdi>${ui.esc(row.settled.credit_ref)}</bdi>` }) : ''}</p>` : r.mode !== 'final' ? `<p class="doc__small">${ui.esc(tr('svc|An interim statement: the final settlement is made once the year has ended.'))}</p>` : ''}
  <p class="doc__small">${ui.esc(tr('svc|Costs are shared by indoor area (with any agreed weights and caps) for the days each unit was held. The landlord carries the share of vacant space. Amounts exclude VAT.'))}</p>
  <p class="doc__foot">${ui.esc(tx(st.legal_name))} · ${ui.esc(tx(st.address))} · ${ui.esc(st.leasing_email)}</p>
</main>`;
      return ui.bare({ title, body, cls: 'print' });
    });
    res.type('html').send(html);
  });

  // credit notes (shared by the revenue modules)
  router.get('/service-charge/credits', (req, res) => {
    const rows = db.all('SELECT c.*, b.name brand_name, s.ref lease_ref FROM revenue_credits c LEFT JOIN brands b ON b.id = c.brand_id LEFT JOIN leases s ON s.id = c.lease_id ORDER BY c.created_at DESC, c.id DESC LIMIT 200');
    const canMgr = h.can(req, 'manager');
    const table = ui.table(
      [
        { label: tr('svc|Credit note'), render: (c) => `<b><bdi>${ui.esc(c.ref)}</bdi></b><small class="sub">${ui.esc(tx(c.note) || '')}</small>` },
        { label: tr('svc|Tenant'), render: (c) => `${ui.esc(c.brand_name || '—')}<small class="sub">${ui.esc(c.lease_ref || '')}</small>` },
        { label: tr('svc|Amount'), num: true, render: (c) => m0(c.amount) },
        { label: tr('svc|Used'), num: true, render: (c) => m0(c.applied) },
        { label: tr('Status'), render: (c) => ui.badge(c.status, tr(CREDIT_STATUS[c.status][0]), CREDIT_STATUS[c.status][1]) },
        { label: tr('Date'), render: (c) => ui.date(c.created_at) },
        { label: '', render: (c) => (canMgr && c.status === 'open' ? ui.form(`/admin/service-charge/credits/${c.id}/refund`, req.session.csrf, ui.btn(tr('svc|Mark refunded'), { cls: 'btn--ghost btn--xs', attrs: { 'data-confirm': tr('svc|Mark the unused {amount} as refunded to the tenant?', { amount: ui.money(C.r2(c.amount - c.applied)) }) } })) : '') },
      ],
      rows,
      { empty: ui.esc(tr('svc|No credit notes yet.')) },
    );
    const open = rows.filter((c) => c.status === 'open').reduce((t, c) => t + c.amount - c.applied, 0);
    const body = `${nav('/admin/service-charge/credits', X.thisYear())}${ui.card(tr('svc|Credit notes'), table, { sub: ui.esc(tr('svc|Open credit {amount}. Credits are set against the tenant’s next service charge, utilities or turnover rent invoice.', { amount: ui.money(open) })) })}`;
    h.page(req, res, { title: tr('svc|Credit notes'), crumbs: [['/admin/service-charge', tr('svc|Service charge')], [null, tr('svc|Credit notes')]], active: '/admin/service-charge', wide: true, body });
  });
  router.post('/service-charge/credits/:id/refund', R('manager'), (req, res, next) => {
    const c = db.get('SELECT * FROM revenue_credits WHERE id = ?', h.int(req.params.id));
    if (!c) return next();
    if (c.status !== 'open') return h.back(req, res, '/admin/service-charge/credits', 'error', tr('svc|This credit is already closed.'));
    db.run("UPDATE revenue_credits SET status = 'refunded' WHERE id = ?", c.id);
    h.log(req, 'Refunded credit note', 'lease', c.lease_id, `${c.ref} · ${C.r2(c.amount - c.applied)}`);
    h.back(req, res, '/admin/service-charge/credits', 'ok', tr('svc|Marked as refunded.'));
  });

  return { CATS, budgetOf, budgetLines, saveLines, ensureBudget, addActual, importRows, importLedger, recon, settle, billedOnAccount, windowOf };
};
