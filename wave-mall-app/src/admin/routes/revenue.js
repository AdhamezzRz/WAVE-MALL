'use strict';

// Revenue beyond base rent: turnover rent and tenant sales (/admin/turnover), the service charge
// budget and year-end reconciliation (/admin/service-charge), and utilities metering and
// recharge (/admin/utilities). The code lives in ../revenue; this file wires it in.
//
// Other modules may read:
//   tenant_sales (brand_id, lease_id, period 'YYYY-MM', amount = net sales before VAT)
//   h.revenue.leaseCard(req, lease) and h.revenue.tenantCard(req, brandId): summary cards (HTML)
// Events: 'sales.submitted' { sale, lease, user }.
//
// Invoices this module issues carry source 'turnover', 'service_recon' or 'utility'. Voiding one
// releases its period (it can be billed again) and any credit note that was set against it.

const { t: tr } = require('../i18n');
const { REVENUE_1 } = require('../revenue/schema');
const common = require('../revenue/common');

module.exports = function revenue(router, h) {
  const { db, ui } = h;
  db.ensure('revenue-1', REVENUE_1);

  const X = common(h);
  const T = require('../revenue/turnover')(router, h, X);
  X.svc = require('../revenue/service')(router, h, X);
  const U = require('../revenue/utilities')(router, h, X);
  require('../revenue/portal')(h, X, T, U);
  const { C } = X;

  // a voided invoice releases what it billed
  h.events.on('invoice.voided', ({ invoice }) => {
    if (!invoice || !['turnover', 'service_recon', 'utility'].includes(invoice.source)) return;
    db.tx(() => {
      for (const u of db.all('SELECT * FROM revenue_credit_uses WHERE invoice_id = ?', invoice.id)) {
        const c = db.get('SELECT * FROM revenue_credits WHERE id = ?', u.credit_id);
        if (c) db.run("UPDATE revenue_credits SET applied = ?, status = CASE WHEN status = 'refunded' THEN status ELSE 'open' END WHERE id = ?", C.r2(Math.max(0, c.applied - u.amount)), c.id);
        db.run('DELETE FROM revenue_credit_uses WHERE id = ?', u.id);
      }
      if (invoice.source === 'turnover') db.run('DELETE FROM turnover_bills WHERE invoice_id = ?', invoice.id);
      if (invoice.source === 'utility') db.run('DELETE FROM utl_bills WHERE invoice_id = ?', invoice.id);
      if (invoice.source === 'service_recon') db.run('DELETE FROM sc_recons WHERE invoice_id = ?', invoice.id);
    });
  });

  // ---------- summary cards for the lease page and the tenant dossier ----------
  function leaseCard(req, lease) {
    const terms = T.termsOf(lease.id);
    const sales = db.all("SELECT period, amount FROM tenant_sales WHERE lease_id = ? AND status != 'draft' ORDER BY period DESC LIMIT 12", lease.id).reverse();
    const billed = db.value('SELECT COALESCE(SUM(due), 0) FROM turnover_bills WHERE lease_id = ? AND due > 0', lease.id);
    const late = T.missing().filter((m) => m.lease.id === lease.id && m.late).length;
    const body = `<dl class="dl rev-dl">
      <div><dt>${ui.esc(tr('trn|Turnover rent'))}</dt><dd>${terms ? `${terms.pct}% · ${ui.esc(tr(T.BREAK[terms.breakpoint_type]))}` : `<span class="muted">${ui.esc(tr('trn|No turnover clause'))}</span>`}</dd></div>
      <div><dt>${ui.esc(tr('trn|Last reported'))}</dt><dd>${sales.length ? `${ui.money(sales.at(-1).amount, { cur: false })} <small class="muted">${ui.esc(X.periodLabel(sales.at(-1).period))}</small>` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('trn|Turnover rent billed'))}</dt><dd>${ui.money(billed)}</dd></div>
      ${late ? `<div><dt>${ui.esc(tr('trn|Late sales certificates'))}</dt><dd class="late">${ui.n0(late)}</dd></div>` : ''}
    </dl>${sales.length > 1 ? X.sparkline(sales.map((s) => s.amount), { w: 220, h: 36 }) : ''}`;
    return ui.card(tr('trn|Turnover & sales'), body, { action: ui.btn(tr('trn|Open'), { href: `/admin/turnover/leases/${lease.id}`, cls: 'btn--ghost btn--sm', ic: 'percent' }) });
  }
  function tenantCard(req, brandId) {
    const leases = X.activeLeases().filter((s) => s.brand_id === Number(brandId));
    if (!leases.length) return '';
    const LM = X.lastMonth();
    const rows = leases.map((s) => {
      const last3 = db.all("SELECT period, amount FROM tenant_sales WHERE lease_id = ? AND status != 'draft' AND period <= ? ORDER BY period DESC LIMIT 3", s.id, LM);
      const sum = last3.reduce((t, r) => t + r.amount, 0);
      const cover = last3.reduce((t, r) => t + T.tradeCover(s, r.period), 0);
      const cost = last3.reduce((t, r) => t + T.costWhileTrading(s, r.period), 0);
      const area = s.units.reduce((t, u) => t + u.indoor_m2, 0);
      // per month traded in full (a store that opened mid-month is counted for its days)
      return { s, avg: cover ? sum / cover : null, perM2: cover && area ? sum / cover / area : null, ocr: sum ? cost / sum : null };
    });
    const body = rows.map((r) => `<dl class="dl rev-dl">
      <div><dt>${ui.esc(tr('trn|Average monthly sales'))}</dt><dd>${r.avg === null ? '—' : ui.money(r.avg)}</dd></div>
      <div><dt>${ui.esc(tr('trn|Sales per m²'))}</dt><dd>${r.perM2 === null ? '—' : ui.money(r.perM2, { cur: false })}</dd></div>
      <div><dt>${ui.esc(tr('trn|Occupancy cost'))}</dt><dd class="${r.ocr !== null && r.ocr > 0.15 ? 'late' : ''}">${X.pct1(r.ocr)}</dd></div>
    </dl>`).join('');
    return ui.card(tr('trn|Sales and occupancy cost'), `${body}<p class="small muted">${ui.esc(tr('trn|Last 3 months reported. Occupancy cost: base rent and service charge as a share of sales.'))}</p>`, { action: ui.btn(tr('trn|Open'), { href: `/admin/turnover/leases/${leases[0].id}`, cls: 'btn--ghost btn--sm', ic: 'percent' }) });
  }

  // the lease page and the tenant dossier show a sales card (their extension points)
  (h.leaseCards = h.leaseCards || []).push((req, s) => (s.status === 'active' || T.termsOf(s.id) ? leaseCard(req, s) : ''));
  (h.tenantCards = h.tenantCards || []).push((req, b) => tenantCard(req, b.id));

  h.revenue = { turnover: T, service: X.svc, utilities: U, credits: { open: X.openCredits, add: X.addCredit }, leaseCard, tenantCard };
};
