'use strict';

// The tenant portal's Sales and Utilities tabs: a brand reports its monthly sales (the turnover
// rent certificate) and sees its meters and utility bills. Everything is limited to the signed-in
// tenant's own brand.

const { t: tr, tn } = require('../i18n');

module.exports = function revenuePortal(h, X, T, U) {
  const P = h.portal;
  if (!P) return;
  const { db, ui, M } = h;
  const { C } = X;

  const leasesOf = (req) => X.activeLeases().filter((s) => s.brand_id === P.brandId(req));
  const lateFor = (req) => T.missing().filter((m) => m.late && m.lease.brand_id === P.brandId(req)).length;

  P.tab({ key: 'sales', href: '/portal/sales', label: 'trn|Sales', icon: 'percent', order: 20, badge: lateFor, show: (req) => leasesOf(req).length > 0 });
  P.tab({ key: 'utilities', href: '/portal/utilities', label: 'utl|Utilities', icon: 'gauge', order: 25, mobile: false, show: (req) => db.value(`SELECT COUNT(*) FROM utl_meters m JOIN lease_units lu ON lu.unit_id = m.unit_id JOIN leases s ON s.id = lu.lease_id WHERE s.brand_id = ? AND s.status = 'active' AND m.active = 1`, P.brandId(req)) > 0 });

  P.router.get('/sales', P.requireTenant, (req, res) => {
    const leases = leasesOf(req);
    const csrf = req.psession.csrf;
    const sections = leases.map((s) => {
      const terms = T.termsOf(s.id);
      const sales = T.salesMap(s.id);
      const open = T.expectedMonths(s).filter((ym) => !T.isLocked(s.id, ym) && !(sales[ym] && sales[ym].status === 'verified')).reverse();
      const missing = T.missing().filter((m) => m.lease.id === s.id);
      const form = open.length
        ? `<form method="post" action="/portal/sales" class="stack"><input type="hidden" name="_csrf" value="${ui.esc(csrf)}"><input type="hidden" name="lease_id" value="${s.id}">
            <div class="fields">${ui.select('period', tr('trn|Month'), open.map((ym) => [ym, `${X.periodLabel(ym)}${sales[ym] ? ` · ${tr(T.STATUS[sales[ym].status][0])}` : ''}`]), (missing[0] && missing[0].period) || open[0])}
            ${ui.input('gross', tr('trn|Gross sales'), '', { type: 'number', min: 0, step: '0.01', required: true, attrs: { inputmode: 'decimal' } })}
            ${ui.input('returns', tr('trn|Returns'), '', { type: 'number', min: 0, step: '0.01', attrs: { inputmode: 'decimal' } })}
            ${ui.input('transactions', tr('trn|Receipts'), '', { type: 'number', min: 0, step: 1, attrs: { inputmode: 'numeric' } })}</div>
            ${ui.textarea('note', tr('Notes'), '', { rows: 2 })}
            <p class="small muted">${ui.esc(tr('trn|Amounts are monthly, before VAT. Net sales = gross sales − returns.'))}</p>
            ${ui.btn(tr('trn|Submit sales'), { cls: 'btn--primary', ic: 'check' })}</form>`
        : `<p class="muted">${ui.esc(tr('trn|Every month is reported. Thank you.'))}</p>`;
      const months = Object.values(sales).sort((a, b) => (a.period < b.period ? 1 : -1)).slice(0, 18);
      const hist = ui.table(
        [
          { label: tr('trn|Month'), render: (r) => ui.esc(X.periodLabel(r.period)) },
          { label: tr('trn|Net sales'), num: true, render: (r) => ui.money(r.amount, { cur: false }) },
          { label: tr('Status'), render: (r) => ui.badge(r.status, tr(T.STATUS[r.status][0]), T.STATUS[r.status][1]) },
        ],
        months,
        { empty: ui.esc(tr('trn|No sales reported yet.')) },
      );
      const alert = missing.length
        ? `<p class="alert alert--${missing.some((m) => m.late) ? 'error' : 'warn'}">${ui.esc(tn(missing.length, 'trn|{n} month to report', 'trn|{n} months to report'))}: ${ui.esc(missing.map((m) => X.periodLabel(m.period)).join(', '))}</p>`
        : '';
      const sub = terms
        ? tr('trn|Turnover rent {pct}% of net sales · certificate due on day {n} of the next month', { pct: terms.pct, n: terms.due_day })
        : tr('trn|Monthly sales help us plan marketing and events with you.');
      return `${alert}<div class="grid grid--side">${ui.card(tr('trn|Report sales · {units}', { units: s.units.map((u) => u.code).join(', ') }), form, { sub: ui.esc(sub) })}${ui.card(tr('trn|Reported'), hist)}</div>`;
    }).join('');
    P.page(req, res, { title: tr('trn|Sales'), active: 'sales', body: sections || ui.empty(tr('trn|No lease is trading yet.')) });
  });

  P.router.post('/sales', P.requireTenant, (req, res) => {
    const s = leasesOf(req).find((x) => x.id === h.int(req.body.lease_id));
    if (!s) return P.back(req, res, '/portal/sales', 'error', tr('That record no longer exists.'));
    const period = String(req.body.period || '');
    if (!T.expectedMonths(s).includes(period)) return P.back(req, res, '/portal/sales', 'error', tr('trn|Choose a month.'));
    const old = db.get('SELECT status FROM tenant_sales WHERE lease_id = ? AND period = ?', s.id, period);
    if (old && old.status === 'verified') return P.back(req, res, '/portal/sales', 'error', tr('trn|This month is verified. Contact the leasing office to change it.'));
    try {
      T.saveSales(s, period, { gross: req.body.gross, returns: req.body.returns, transactions: req.body.transactions, note: h.str(req.body.note, 500) || null }, { via: 'portal', by: req.tenant.name, status: 'submitted' });
    } catch (err) {
      return P.back(req, res, '/portal/sales', 'error', tr(err.message));
    }
    db.audit(null, 'Sales submitted in the portal', 'lease', s.id, `${s.ref} · ${period} · ${req.tenant.email}`);
    P.back(req, res, '/portal/sales', 'ok', tr('trn|Thank you. Your sales for {month} are submitted.', { month: X.periodLabel(period) }));
  });

  P.router.get('/utilities', P.requireTenant, (req, res) => {
    const bid = P.brandId(req);
    const meters = db.all(
      `SELECT DISTINCT m.*, u.code unit_code FROM utl_meters m JOIN units u ON u.id = m.unit_id JOIN lease_units lu ON lu.unit_id = m.unit_id JOIN leases s ON s.id = lu.lease_id
       WHERE s.brand_id = ? AND s.status = 'active' AND m.active = 1 ORDER BY m.utility, m.code`, bid,
    );
    const cards = meters.map((m) => {
      // only the months this brand held the unit, and only its own bills
      const rows = db.all(
        `SELECT r.period, r.reading, r.consumption, b.amount, b.invoice_id, i.ref invoice_ref FROM utl_readings r
         LEFT JOIN utl_bills b ON b.meter_id = r.meter_id AND b.period = r.period LEFT JOIN invoices i ON i.id = b.invoice_id AND i.brand_id = ?
         WHERE r.meter_id = ? ORDER BY r.period DESC LIMIT 12`, bid, m.id,
      ).filter((r) => { const l = X.leaseForUnit(m.unit_id, r.period); return l && l.brand_id === bid; });
      const chron = [...rows].reverse().filter((r) => r.consumption !== null);
      const chart = chron.length > 1 ? ui.bars(chron.map((r) => ({ label: X.shortMonth(r.period), v: r.consumption })), { key: 'v', label: 'label', tone: U.UTIL[m.utility].tone, fmtv: (n) => ui.n0(Math.round(n)), h: 120 }) : '';
      const table = ui.table(
        [
          { label: tr('utl|Month'), render: (r) => ui.esc(ui.monthYear(r.period)) },
          { label: tr('utl|Reading'), num: true, render: (r) => ui.n0(r.reading) },
          { label: tr('utl|Consumption'), num: true, render: (r) => (r.consumption === null ? '—' : `${ui.n0(Math.round(r.consumption))} ${ui.esc(tr(U.UTIL[m.utility].unit))}`) },
          { label: tr('utl|Invoice'), render: (r) => (r.invoice_id && r.invoice_ref ? `<a href="/portal/invoices/${r.invoice_id}">${ui.esc(r.invoice_ref)}</a>` : '—') },
        ],
        rows,
        { empty: ui.esc(tr('utl|No readings yet.')) },
      );
      return ui.card(`${tr(U.UTIL[m.utility].label)} · ${m.code}`, `${chart}${table}`, { sub: ui.esc(tr('utl|Unit {code}', { code: m.unit_code })) });
    }).join('');
    P.page(req, res, { title: tr('utl|Utilities'), active: 'utilities', body: cards || ui.empty(tr('utl|No meters on your units yet.')) });
  });

  return { leasesOf };
};
