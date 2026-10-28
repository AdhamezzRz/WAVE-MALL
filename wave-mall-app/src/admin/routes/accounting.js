'use strict';

// Accounting: the mall's books in double entry, at /admin/accounting (finance access only).
//   Overview · Journal · Accounts · Receivables · Payables · Banking · Assets · Budgets · Reports · Settings
// The engine is ../ledger.js. Invoices, receipts, payroll, supplier bills and depreciation post
// themselves (events from the rest of the office, an hourly job, every accounting page load and the
// Sync button), each exactly once. Reports print on A4 (?print=1, ?doc=ar|en) and export to CSV.

const i18n = require('../i18n');
const { ledger } = require('../ledger');

const { t: tr, tn, tx } = i18n;
// typed or imported text (bill notes, statement lines, asset names): translated only when it is a
// whole dictionary entry (the sample data), never by pattern
const txt = (s) => (s && i18n.AR[s] !== undefined ? tr(s) : s);

const TYPES = { asset: 'acc|Asset', liability: 'acc|Liability', equity: 'acc|Equity', income: 'acc|Income', expense: 'acc|Expense' };
const ENTRY_KINDS = { manual: 'acc|Manual', auto: 'acc|Automatic', reversal: 'acc|Reversal', opening: 'acc|Opening balance', closing: 'acc|Year-end close', depreciation: 'acc|Depreciation' };
const ENTRY_TONES = { manual: 'sea', auto: 'forest', reversal: 'rose', opening: 'sand', closing: 'cocoa', depreciation: 'amber' };
const BILL_STATUS = { draft: 'accbill|Draft', approved: 'accbill|Approved', partial: 'accbill|Part paid', paid: 'accbill|Paid', void: 'accbill|Void' };
const BILL_TONES = { draft: 'mute', approved: 'sky', partial: 'amber', paid: 'ok', void: 'mute' };
const INV_KINDS = {
  rent: 'acckind|Base rent', service: 'acckind|Service charge', turnover: 'acckind|Turnover rent', service_recon: 'acckind|Service charge settlement',
  utility: 'acckind|Utility recharges', specialty: 'acckind|Specialty leasing', key: 'acckind|Key money', penalty: 'acckind|Penalties',
  other: 'acckind|Other charges', deposit: 'acckind|Security deposits', fitout: 'acckind|Fit-out deposits', parking: 'acckind|Parking',
};
const METHODS = { transfer: 'accm|Bank transfer', cheque: 'accm|Cheque', card: 'accm|Card', cash: 'accm|Cash', online: 'accm|Online payment', instapay: 'accm|InstaPay', fawry: 'accm|Fawry', wallet: 'accm|Mobile wallet' };
const ASSET_CLASSES = { building: 'accfa|Buildings', fitout: 'accfa|Fit-out and improvements', mep: 'accfa|MEP and equipment', furniture: 'accfa|Furniture and fixtures', it: 'accfa|IT equipment', vehicles: 'accfa|Vehicles' };
const CHECKS = {
  invoices: 'acc|Issued invoices are in the books', payments: 'acc|Receipts are in the books', payroll: 'acc|Payroll is approved',
  depreciation: 'acc|Depreciation is posted', bank: 'acc|Bank lines are reconciled', bills: 'acc|Supplier bills are approved',
};
const REPORTS = {
  pl: ['acc|Profit and loss', 'acc|Income and expenses for a period, by month or against last year or the budget', 'period'],
  bs: ['acc|Balance sheet', 'acc|What the mall owns and owes on a date; assets equal liabilities plus equity', 'date'],
  cf: ['acc|Cash flow', 'acc|Where cash came from and went, from the result (indirect method)', 'period'],
  tb: ['acc|Trial balance', 'acc|Every account: opening, movement and closing; debits equal credits', 'period'],
  gl: ['acc|General ledger', 'acc|One account, line by line, with a running balance', 'period'],
  journal: ['acc|Journal listing', 'acc|Every entry and its lines for a period', 'period'],
  vat: ['acc|VAT summary', 'acc|VAT on sales and on purchases, and what is due to the Tax Authority', 'period'],
  ar: ['acc|Aged receivables', 'acc|What tenants owe, by how late it is', 'date'],
  ap: ['acc|Aged payables', 'acc|What the mall owes suppliers, by how late it is', 'date'],
};
const BUCKET_LABELS = ['acc|Not yet due', 'acc|1–30 days', 'acc|31–60 days', 'acc|61–90 days', 'acc|Over 90 days'];

module.exports = function accounting(router, h) {
  const { db, ui, M } = h;
  const L = ledger(db, h.events);
  const { RF } = h;
  const esc = ui.esc;
  const today = () => M.today();
  const r2 = L.r2;
  const fmt = (n) => ui.money(n, { cur: false });
  const amt = (n) => (n === null || n === undefined || n === '' ? '' : Math.abs(n) < 0.005 ? '—' : fmt(n));
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const isYM = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));
  const lbl = (map, k) => (map[k] ? tr(map[k]) : k || '');
  const num = (v) => {
    const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? r2(n) : 0;
  };
  const errText = (err) => tx(String((err && err.message) || err));
  const docLang = (req) => (['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en');
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
  const canAdmin = (req) => h.can(req, 'admin');

  // ---------- keeping the books up to date ----------
  const syncQuiet = () => {
    try {
      return L.sync();
    } catch (err) {
      console.error('[accounting] sync failed:', err.message);
      return null;
    }
  };
  h.every('accounting-sync', 60 * 60 * 1000, () => L.sync(), { first: 90 * 1000 });
  router.use('/accounting', RF, (req, res, next) => {
    if (req.method === 'GET' && !req.query.format) syncQuiet();
    next();
  });
  // the sidebar badge: what needs a finance person (unposted items, supplier bills to approve or overdue)
  h.count('finance', (user) => {
    if (!(user.role === 'admin' || user.finance)) return 0;
    return L.pending().total + db.value("SELECT COUNT(*) FROM acc_bills WHERE status = 'draft' OR (status IN ('approved','partial') AND due_date < ?)", today());
  });

  // ---------- page frame ----------
  const TABS = [['', 'acc|Overview'], ['journal', 'acc|Journal'], ['accounts', 'acc|Accounts'], ['receivables', 'acc|Receivables'], ['payables', 'acc|Payables'], ['banking', 'acc|Banking'], ['assets', 'acc|Assets'], ['budgets', 'acc|Budgets'], ['reports', 'acc|Reports'], ['settings', 'acc|Settings']];
  const tabs = (on) => `<nav class="tabs acc-tabs" aria-label="${esc(tr('nav|Accounting'))}">${TABS.map(([k, l]) => `<a class="tab${on === k ? ' is-on' : ''}" href="/admin/accounting${k ? `/${k}` : ''}"${on === k ? ' aria-current="page"' : ''}>${esc(tr(l))}</a>`).join('')}</nav>`;
  function page(req, res, { tab, title, body, crumbs = null, actions = '', status = 200 }) {
    if (status !== 200) res.status(status);
    const home = [['/admin/accounting', tr('nav|Accounting')]];
    h.page(req, res, { title, active: '/admin/accounting', wide: true, actions, crumbs: crumbs === null ? (tab === '' ? [] : home) : [...home, ...crumbs], body: `<div class="acc">${tabs(tab)}${body}</div>` });
  }
  const sub = (s) => `<small class="sub">${s}</small>`;
  const pop = (label, inner, { cls = 'btn--ghost', align = '' } = {}) => `<details class="pop ${align}"><summary class="btn ${cls}">${esc(label)}</summary>${inner}</details>`;
  const accLink = (a) => (a ? `<a href="/admin/accounting/accounts/${a.id}"><bdi>${esc(a.code)}</bdi> · ${esc(L.name(a))}</a>` : '—');
  const accOptions = (filter = () => true) => L.accounts({ postable: true, activeOnly: true }).filter(filter).map((a) => [a.id, L.label(a)]);
  const cashOptions = () => L.cashAccounts().filter((a) => a.active).map((a) => [a.id, L.label(a)]);
  const bareSelect = (name, options, value, { blank = null, attrs = '' } = {}) => `<select name="${name}" ${attrs}>${blank !== null ? `<option value="">${esc(blank)}</option>` : ''}${options.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(value ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const yesNo = (ok) => (ok ? ui.badge('ok', tr('acc|Done'), 'ok') : ui.badge('pending', tr('acc|To do'), 'amber'));
  const fyLabel = (fy) => tr('acc|Fiscal year {label}', { label: fy.label });
  const periodText = (from, to) => tr('acc|{from} to {to}', { from: ui.date(from), to: ui.date(to) });
  const pager = (page, pages, link, total, per) => (pages > 1
    ? `<nav class="pager" aria-label="${esc(tr('Pages'))}">${page > 1 ? `<a class="btn btn--ghost btn--sm" href="${esc(link(page - 1))}">${esc(tr('Newer'))}</a>` : '<span></span>'}<span class="muted small">${esc(tr('{from}–{to} of {total}', { from: (page - 1) * per + 1, to: Math.min(page * per, total), total }))}</span>${page < pages ? `<a class="btn btn--ghost btn--sm" href="${esc(link(page + 1))}">${esc(tr('Older'))}</a>` : '<span></span>'}</nav>`
    : '');

  // Where an automatic entry came from, as a link.
  function sourceOf(e) {
    const base = String(e.source_base || '').replace(/^rev:/, '');
    if (!base) return null;
    const [kind, a] = base.split(':');
    const id = Number(a);
    const inv = (iid) => db.get('SELECT id, ref FROM invoices WHERE id = ?', iid);
    if (kind === 'inv' || kind === 'keyrec') { const i = inv(id); return i ? { href: `/admin/invoices/${i.id}`, label: tr('acc|Invoice {ref}', { ref: i.ref }) } : null; }
    if (kind === 'pay') {
      const p = db.get('SELECT id, ref, invoice_id FROM payments WHERE id = ?', id);
      return p ? { href: p.invoice_id ? `/admin/invoices/${p.invoice_id}` : null, label: tr('acc|Receipt {ref}', { ref: p.ref }) } : null;
    }
    if (kind === 'payroll' || kind === 'payroll-paid') {
      const r = db.get('SELECT id, period FROM payroll_runs WHERE id = ?', id);
      return r ? { href: `/admin/hr/payroll/${r.id}`, label: tr('acc|Payroll {month}', { month: ui.monthYear(r.period) }) } : null;
    }
    if (kind === 'bill') { const b = db.get('SELECT id, ref FROM acc_bills WHERE id = ?', id); return b ? { href: `/admin/accounting/bills/${b.id}`, label: tr('acc|Supplier bill {ref}', { ref: b.ref }) } : null; }
    if (kind === 'billpay') {
      const p = db.get('SELECT p.ref, b.id, b.ref bill FROM acc_bill_payments p JOIN acc_bills b ON b.id = p.bill_id WHERE p.id = ?', id);
      return p ? { href: `/admin/accounting/bills/${p.id}`, label: tr('acc|Payment {ref}', { ref: p.ref }) } : null;
    }
    if (kind === 'dep') return { href: '/admin/accounting/assets', label: tr('acc|Depreciation {month}', { month: ui.monthYear(a) }) };
    if (kind === 'asset' || kind === 'dispose') { const x = db.get('SELECT id, ref FROM acc_assets WHERE id = ?', id); return x ? { href: `/admin/accounting/assets/${x.id}`, label: tr('acc|Asset {ref}', { ref: x.ref }) } : null; }
    if (kind === 'bank-open') { const b = db.get('SELECT id, account_id FROM acc_banks WHERE id = ?', id); return b ? { href: `/admin/accounting/banking/${b.id}`, label: L.name(L.byId(b.account_id)) } : null; }
    if (kind === 'yearclose') return { href: '/admin/accounting/settings', label: tr('acc|Year-end close {year}', { year: a }) };
    return null;
  }
  const sourceHtml = (e) => {
    const s = sourceOf(e);
    if (!s) return '';
    return s.href ? `<a href="${s.href}">${esc(s.label)}</a>` : esc(s.label);
  };
  const kindBadge = (k) => ui.badge(k, lbl(ENTRY_KINDS, k), ENTRY_TONES[k]);

  // ---------- reports: one table model for the page, the print and the CSV ----------
  // { cols: [{ label, num }], rows: [{ cells, cls, href }], notes: [] }  (numbers stay numbers)
  const C = (label, isNum = false) => ({ label, num: isNum });
  function reportHtml(rep, { cls = '' } = {}) {
    if (!rep.rows.length) return ui.empty(tr('acc|Nothing to show for this period.'));
    const th = rep.cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
    const body = rep.rows.map((r) => `<tr class="${r.cls || ''}"${r.href ? ` data-href="${esc(r.href)}" tabindex="0"` : ''}>${rep.cols.map((c, i) => {
      const v = r.cells[i];
      const html = v && typeof v === 'object' ? v.html : c.num ? amt(v) : esc(v ?? '');
      return `<td${c.num ? ' class="num"' : ''} data-label="${esc(c.label)}">${html}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="tablewrap"><table class="table table--fin table--resp acc-rep ${cls}"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function reportCsv(rep) {
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(2) : String(v && typeof v === 'object' ? v.text ?? '' : v);
      return /[",\n\r]/.test(s) || /^[=+@]/.test(s) || (/^-/.test(s) && typeof v !== 'number') ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
    };
    return `﻿${[rep.cols.map((c) => cell(c.label)).join(','), ...rep.rows.map((r) => rep.cols.map((c, i) => cell(r.cells[i])).join(','))].join('\r\n')}\r\n`;
  }
  const sendCsv = (req, res, rep, name) => {
    h.log(req, 'Exported', 'export', null, `Accounting: ${name}`);
    res.set('Content-Disposition', `attachment; filename="${name}-${today()}.csv"`).type('text/csv; charset=utf-8').send(reportCsv(rep));
  };
  // An A4 document in the reader's language, or ?doc=ar|en.
  function printDoc(req, res, { title, sub: subtitle, build, back }) {
    const lang = docLang(req);
    const params = { ...req.query };
    delete params.doc;
    const self = `${req.baseUrl}${req.path}?${qs(params)}`;
    const html = i18n.run(lang, () => {
      const s = db.settings();
      const { rep, before = '', after = '', heading = null } = build();
      const sw = lang === 'ar' ? `<a class="langbtn" href="${esc(self)}&doc=en" lang="en">${ui.icon('globe')}<span>English</span></a>` : `<a class="langbtn" href="${esc(self)}&doc=ar" lang="ar">${ui.icon('globe')}<span>العربية</span></a>`;
      const body = `<main class="doc doc--acc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="${esc(back)}">${tr('Back')}</a>${sw}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${esc(title())}</p><p class="doc__ref">${esc(subtitle())}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${esc(tx(s.legal_name) || tr('The mall'))}</p>${heading ? `<h1>${esc(heading)}</h1>` : ''}</section>
  ${before}${reportHtml(rep, { cls: 'doc__t' })}${after}
  <p class="doc__foot">${esc(tr('acc|Prepared on {date} from the books of The Wave.', { date: ui.date(today()) }))}</p>
</main>`;
      return ui.bare({ title: title(), body, cls: 'print' });
    });
    res.type('html').send(html);
  }

  // =====================================================================================
  // Overview
  // =====================================================================================
  router.get('/accounting', RF, (req, res) => {
    const t = today();
    const fy = L.fiscalYear(t);
    const csrf = req.session.csrf;
    const p = L.pending();
    const cashAccs = L.cashAccounts();
    const cash = r2(cashAccs.reduce((s, a) => s + L.balance(a.id), 0));
    const ar = L.keyBalance('ar');
    const ap = L.keyBalance('ap');
    const vat = r2(L.keyBalance('vat_out') - L.keyBalance('vat_in'));
    const pl = L.profitLoss({ from: fy.from, to: t });
    const overdue = r2(db.value("SELECT COALESCE(SUM(total - paid),0) FROM invoices WHERE status IN ('open','partial') AND due_date < ?", t));
    // what issued invoices still ask for; the ledger's receivables are lower by what tenants paid ahead
    const owed = r2(db.value("SELECT COALESCE(SUM(total - paid),0) FROM invoices WHERE status IN ('open','partial') AND due_date <= ?", t));
    const advance = r2(owed - ar);
    const kpis = [
      ui.kpi({ label: tr('acc|Cash and banks'), value: fmt(cash), sub: esc(tn(cashAccs.length, 'acc|{n} account', 'acc|{n} accounts')), href: '/admin/accounting/banking' }),
      ui.kpi({ label: tr('acc|Tenants owe'), value: fmt(owed), sub: `${overdue ? `<span class="down">${esc(tr('acc|{amount} overdue', { amount: fmt(overdue) }))}</span>` : esc(tr('acc|Nothing overdue'))}${advance > 0.004 ? ` · ${esc(tr('acc|{amount} paid in advance', { amount: fmt(advance) }))}` : ''}`, href: '/admin/accounting/receivables', tone: overdue ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('acc|Owed to suppliers'), value: fmt(ap), sub: esc(tr('acc|Approved bills not yet paid')), href: '/admin/accounting/payables' }),
      ui.kpi({ label: vat >= 0 ? tr('acc|VAT due') : tr('acc|VAT to carry forward'), value: fmt(Math.abs(vat)), sub: esc(tr('acc|Output less input VAT')), href: '/admin/accounting/reports/vat' }),
      ui.kpi({ label: tr('acc|Result this year'), value: `<span class="${pl.result >= 0 ? 'up' : 'down'}">${fmt(pl.result)}</span>`, sub: esc(fyLabel(fy)), href: `/admin/accounting/reports/pl?${qs({ from: fy.from, to: t })}` }),
    ].join('');

    const syncBox = p.total
      ? `<div class="alert alert--warn acc-sync"><p>${esc(tr('acc|{n} items from billing are not in the books yet.', { n: p.total }))}</p>${ui.form('/admin/accounting/sync', csrf, ui.btn(esc(tr('acc|Sync now')), { cls: 'btn--primary btn--sm', ic: 'check' }))}</div>`
      : '';
    const months = L.monthly(6, t).map((m) => ({ ...m, m: ui.monthName(m.month) }));
    const chart = ui.card(tr('acc|Income and expenses'), `${ui.bars(months, { key: 'income', label: 'm', compare: 'expense', fmtv: (n) => ui.money(n, { compact: true, cur: false }) })}<ul class="legend legend--row acc-legend"><li><i class="t-forest"></i><span>${esc(tr('acc|Income'))}</span></li><li><i class="acc-ghost"></i><span>${esc(tr('acc|Expenses'))}</span></li></ul>`, { sub: esc(tr('acc|Last six months')), cls: 'span-2' });
    const parts = pl.income.slice().sort((a, b) => b.amount - a.amount).slice(0, 6).map((r) => ({ label: L.name(r), value: Math.max(0, r.amount), display: ui.money(r.amount, { compact: true, cur: false }) }));
    const mix = ui.card(tr('acc|Where income comes from'), parts.length ? ui.donut(parts, { label: ui.money(pl.totalIncome, { compact: true, cur: false }) }) : `<p class="muted pad">${esc(tr('acc|No income this year yet.'))}</p>`, { sub: esc(fyLabel(fy)) });

    const banks = db.all('SELECT * FROM acc_banks WHERE active = 1 ORDER BY kind, name');
    const bankList = banks.length
      ? `<ul class="list">${banks.map((b) => {
        const s = L.bankSummary(b);
        return `<li><a href="/admin/accounting/banking/${b.id}"><span class="what"><b>${esc(L.name(L.byId(b.account_id)))}</b><small>${s.open ? esc(tn(s.open, 'acc|{n} line to reconcile', 'acc|{n} lines to reconcile')) : esc(tr('acc|Reconciled'))}</small></span><b class="acc-amt">${fmt(s.book)}</b></a></li>`;
      }).join('')}</ul>`
      : `<p class="muted pad">${esc(tr('acc|No bank accounts yet.'))} <a href="/admin/accounting/banking">${esc(tr('acc|Add one'))}</a></p>`;
    const lock = L.lockDate();
    const next = L.nextToClose();
    const closeCard = ui.card(tr('acc|Month close'), `<dl class="dl"><div><dt>${esc(tr('acc|Books closed to'))}</dt><dd>${lock ? ui.date(lock) : esc(tr('acc|Nothing closed yet'))}</dd></div><div><dt>${esc(tr('acc|Next to close'))}</dt><dd>${esc(ui.monthYear(next))}</dd></div><div><dt>${esc(tr('acc|Fiscal year'))}</dt><dd>${esc(fy.label)} · ${periodText(fy.from, fy.to)}</dd></div></dl>`, { action: ui.btn(esc(tr('acc|Close a month')), { href: '/admin/accounting/settings#close', cls: 'btn--ghost btn--sm' }) });

    const recent = db.all('SELECT e.*, (SELECT SUM(debit) FROM acc_lines WHERE entry_id = e.id) amount FROM acc_entries e ORDER BY e.id DESC LIMIT 8');
    const recentTable = ui.table([
      { label: tr('acc|Date'), render: (e) => ui.date(e.date) },
      { label: tr('acc|Entry'), render: (e) => `<b><bdi>${esc(e.ref)}</bdi></b>${sub(esc(tx(e.memo) || ''))}` },
      { label: tr('acc|Type'), render: (e) => kindBadge(e.kind) },
      { label: tr('acc|Amount'), num: true, render: (e) => fmt(e.amount) },
    ], recent, { empty: esc(tr('acc|No entries yet.')), href: (e) => `/admin/accounting/journal/${e.id}` });
    const due = db.all("SELECT b.*, v.name vendor FROM acc_bills b JOIN acc_vendors v ON v.id = b.vendor_id WHERE b.status IN ('approved','partial') ORDER BY b.due_date LIMIT 6");
    const dueList = due.length
      ? `<ul class="list">${due.map((b) => `<li><a href="/admin/accounting/bills/${b.id}"><span class="when"><b>${esc(ui.date(b.due_date).replace(/\s\d{4}$/, ''))}</b><small>${esc(b.due_date.slice(0, 4))}</small></span><span class="what"><b>${esc(b.vendor)}</b><small><bdi>${esc(b.ref)}</bdi>${b.due_date < t ? ` · <span class="down">${esc(tr('acc|Overdue'))}</span>` : ''}</small></span><b class="acc-amt">${fmt(b.total - b.paid)}</b></a></li>`).join('')}</ul>`
      : `<p class="muted pad">${esc(tr('acc|No supplier bills waiting.'))}</p>`;

    const body = `${syncBox}<div class="kpis kpis--5">${kpis}</div>
<div class="grid">${chart}${mix}</div>
<div class="grid">${ui.card(tr('acc|Banks and cash'), bankList, { action: ui.btn(esc(tr('acc|Reconcile')), { href: '/admin/accounting/banking', cls: 'btn--ghost btn--sm' }) })}${ui.card(tr('acc|Bills to pay'), dueList, { action: ui.btn(esc(tr('acc|All bills')), { href: '/admin/accounting/payables', cls: 'btn--ghost btn--sm' }) })}${closeCard}</div>
<div class="grid">${ui.card(tr('acc|Latest entries'), recentTable, { cls: 'span-3', action: ui.btn(esc(tr('acc|Journal')), { href: '/admin/accounting/journal', cls: 'btn--ghost btn--sm' }) })}</div>`;
    const actions = `${ui.btn(esc(tr('acc|New entry')), { href: '/admin/accounting/journal/new', cls: 'btn--primary', ic: 'plus' })}`;
    page(req, res, { tab: '', title: tr('nav|Accounting'), body, actions });
  });

  router.post('/accounting/sync', RF, (req, res) => {
    try {
      const r = L.sync();
      const n = r.invoices + r.voided + r.payments + r.reversed + r.payroll + r.keyMoney + r.bills;
      h.log(req, 'Synced the books', 'accounting', null, `${n} postings`);
      h.back(req, res, h.safeBack(req, '/admin/accounting'), 'ok', n ? tr('acc|The books are up to date: {n} postings made.', { n }) : tr('acc|The books were already up to date.'));
    } catch (err) {
      h.back(req, res, h.safeBack(req, '/admin/accounting'), 'error', errText(err));
    }
  });

  // =====================================================================================
  // Journal
  // =====================================================================================
  router.get('/accounting/journal', RF, (req, res) => {
    const q = {
      q: h.str(req.query.q, 80), from: isDate(req.query.from) ? req.query.from : '', to: isDate(req.query.to) ? req.query.to : '',
      kind: ENTRY_KINDS[req.query.kind] ? req.query.kind : '', account: h.int(req.query.account) || '',
    };
    const where = [];
    const args = [];
    if (q.q) { where.push('(e.ref LIKE ? OR e.memo LIKE ? OR EXISTS (SELECT 1 FROM acc_lines l WHERE l.entry_id = e.id AND l.memo LIKE ?))'); args.push(...Array(3).fill(`%${q.q}%`)); }
    if (q.from) { where.push('e.date >= ?'); args.push(q.from); }
    if (q.to) { where.push('e.date <= ?'); args.push(q.to); }
    if (q.kind) { where.push('e.kind = ?'); args.push(q.kind); }
    if (q.account) { where.push('EXISTS (SELECT 1 FROM acc_lines l WHERE l.entry_id = e.id AND l.account_id = ?)'); args.push(q.account); }
    const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const PER = 50;
    const total = db.value(`SELECT COUNT(*) FROM acc_entries e ${W}`, ...args);
    const pages = Math.max(1, Math.ceil(total / PER));
    const pg = Math.min(pages, Math.max(1, h.int(req.query.page) || 1));
    const rows = db.all(`SELECT e.*, (SELECT SUM(debit) FROM acc_lines WHERE entry_id = e.id) amount, u.name user_name FROM acc_entries e LEFT JOIN users u ON u.id = e.user_id ${W} ORDER BY e.date DESC, e.id DESC LIMIT ${PER} OFFSET ${(pg - 1) * PER}`, ...args);
    const link = (n) => `/admin/accounting/journal?${qs({ ...q, page: n > 1 ? n : '' })}`.replace(/\?$/, '');
    const filters = `<form class="filters" method="get" action="/admin/accounting/journal">
      <input type="search" name="q" value="${esc(q.q)}" placeholder="${esc(tr('acc|Search references and descriptions…'))}" aria-label="${esc(tr('Search'))}">
      ${ui.input('from', tr('acc|From'), q.from, { type: 'date', cls: 'f--inline' })}
      ${ui.input('to', tr('acc|To'), q.to, { type: 'date', cls: 'f--inline' })}
      ${ui.select('kind', tr('acc|Type'), Object.keys(ENTRY_KINDS).map((k) => [k, lbl(ENTRY_KINDS, k)]), q.kind, { blank: tr('acc|All types'), cls: 'f--inline', attrs: { 'data-autosubmit': true } })}
      ${ui.select('account', tr('acc|Account'), accOptions(), q.account, { blank: tr('acc|All accounts'), cls: 'f--inline', attrs: { 'data-autosubmit': true } })}
      ${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm' })}
      ${Object.values(q).some(Boolean) ? `<a class="btn btn--ghost btn--sm" href="/admin/accounting/journal">${esc(tr('acc|Clear'))}</a>` : ''}
    </form>`;
    const table = ui.table([
      { label: tr('acc|Date'), render: (e) => ui.date(e.date) },
      { label: tr('acc|Entry'), render: (e) => `<b><bdi>${esc(e.ref)}</bdi></b>${sub(esc(tx(e.memo) || ''))}` },
      { label: tr('acc|Type'), render: (e) => `${kindBadge(e.kind)}${e.reversed_by ? ` ${ui.badge('void', tr('acc|Reversed'), 'mute')}` : ''}` },
      { label: tr('acc|Source'), render: (e) => sourceHtml(e) || `<span class="muted">${esc(e.user_name || tr('acc|System'))}</span>` },
      { label: tr('acc|Amount'), num: true, render: (e) => fmt(e.amount) },
    ], rows, { empty: esc(Object.values(q).some(Boolean) ? tr('acc|No entries match these filters.') : tr('acc|No entries yet.')), href: (e) => `/admin/accounting/journal/${e.id}` });
    const body = `${filters}${ui.card(tn(total, 'acc|{n} entry', 'acc|{n} entries'), `${table}${pager(pg, pages, link, total, PER)}`, { action: ui.btn(esc(tr('Export CSV')), { href: `/admin/accounting/reports/journal?${qs({ from: q.from || L.fiscalYear().from, to: q.to || today(), format: 'csv' })}`, cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`;
    page(req, res, { tab: 'journal', title: tr('acc|Journal'), body, actions: ui.btn(esc(tr('acc|New entry')), { href: '/admin/accounting/journal/new', cls: 'btn--primary', ic: 'plus' }) });
  });

  // A manual entry: lines balance as you type (admin.js); the server checks again.
  function entryForm(req, res, v = {}, error = null) {
    const opts = accOptions();
    const lines = v.lines && v.lines.length ? v.lines : [];
    while (lines.length < 4) lines.push({});
    const row = (l) => `<tr data-je-row>
      <td data-label="${esc(tr('acc|Account'))}">${bareSelect('account', opts, l.account, { blank: tr('acc|Choose an account'), attrs: `aria-label="${esc(tr('acc|Account'))}"` })}</td>
      <td data-label="${esc(tr('acc|Description'))}"><input name="line_memo" value="${esc(l.memo || '')}" maxlength="200" aria-label="${esc(tr('acc|Description'))}"></td>
      <td class="num" data-label="${esc(tr('acc|Debit'))}"><input type="number" name="debit" step="0.01" min="0" inputmode="decimal" value="${l.debit ? esc(l.debit) : ''}" data-je-debit aria-label="${esc(tr('acc|Debit'))}"></td>
      <td class="num" data-label="${esc(tr('acc|Credit'))}"><input type="number" name="credit" step="0.01" min="0" inputmode="decimal" value="${l.credit ? esc(l.credit) : ''}" data-je-credit aria-label="${esc(tr('acc|Credit'))}"></td>
      <td><button type="button" class="iconbtn" data-je-remove aria-label="${esc(tr('acc|Remove line'))}" title="${esc(tr('acc|Remove line'))}">×</button></td></tr>`;
    const lock = L.lockDate();
    const inner = `${error ? `<div class="alert alert--error"><p>${esc(error)}</p></div>` : ''}
      <div class="fields">
        ${ui.input('date', tr('acc|Date'), v.date || today(), { type: 'date', required: true, hint: lock ? tr('acc|The books are closed to {date}.', { date: ui.date(lock) }) : '' })}
        ${ui.input('memo', tr('acc|Description'), v.memo || '', { required: true, cls: 'span-2', placeholder: tr('acc|e.g. Bank charges for October') })}
      </div>
      <div class="tablewrap acc-je"><table class="table table--fin table--resp" data-je><thead><tr><th>${esc(tr('acc|Account'))}</th><th>${esc(tr('acc|Description'))}</th><th class="num">${esc(tr('acc|Debit'))}</th><th class="num">${esc(tr('acc|Credit'))}</th><th></th></tr></thead>
      <tbody>${lines.map(row).join('')}</tbody>
      <tfoot><tr><td colspan="2"><button type="button" class="btn btn--ghost btn--sm" data-je-add>${ui.icon('plus')}<span>${esc(tr('acc|Add a line'))}</span></button></td><td class="num" data-je-dr>0.00</td><td class="num" data-je-cr>0.00</td><td></td></tr></tfoot></table></div>
      <p class="acc-je__status" data-je-status data-ok="${esc(tr('acc|Balanced'))}" data-off="${esc(tr('acc|Out of balance by {n}'))}" aria-live="polite"></p>
      <div class="row">${ui.btn(esc(tr('acc|Post entry')), { cls: 'btn--primary' })}<a class="btn btn--ghost" href="/admin/accounting/journal">${esc(tr('Cancel'))}</a></div>`;
    const body = ui.card(tr('acc|New journal entry'), ui.form('/admin/accounting/journal', req.session.csrf, inner, { cls: 'stack' }), { sub: esc(tr('acc|Debits must equal credits. Each line is a debit or a credit.')) });
    page(req, res, { tab: 'journal', title: tr('acc|New entry'), crumbs: [['/admin/accounting/journal', tr('acc|Journal')]], body, status: error ? 422 : 200 });
  }
  router.get('/accounting/journal/new', RF, (req, res) => entryForm(req, res));
  router.post('/accounting/journal', RF, (req, res) => {
    const b = req.body;
    const accs = h.list(b.account);
    const dr = h.list(b.debit);
    const cr = h.list(b.credit);
    const memos = h.list(b.line_memo);
    const lines = accs.map((a, i) => ({ account: h.int(a), debit: num(dr[i]), credit: num(cr[i]), memo: h.str(memos[i], 200) || null }));
    const v = { date: b.date, memo: h.str(b.memo, 300), lines };
    const used = lines.filter((l) => l.debit || l.credit);
    if (!v.memo) return entryForm(req, res, v, tr('acc|Describe the entry.'));
    if (used.some((l) => !l.account || !L.byId(l.account))) return entryForm(req, res, v, tr('acc|Choose an account for every line with an amount.'));
    try {
      const e = L.post({ date: b.date, memo: v.memo, kind: 'manual', lines: used, user: req.user });
      h.log(req, 'Posted a journal entry', 'journal', e.id, e.ref);
      h.back(req, res, `/admin/accounting/journal/${e.id}`, 'ok', tr('acc|Entry {ref} posted.', { ref: e.ref }));
    } catch (err) {
      entryForm(req, res, v, errText(err));
    }
  });

  const entryOf = (id) => (/^\d+$/.test(String(id)) ? L.entry(Number(id)) : null);
  router.get('/accounting/journal/:id', RF, (req, res, next) => {
    const e = entryOf(req.params.id);
    if (!e) return next();
    const lines = L.linesOf(e.id);
    const user = e.user_id ? db.get('SELECT name FROM users WHERE id = ?', e.user_id) : null;
    const rev = e.reversed_by ? L.entry(e.reversed_by) : null;
    const of = e.reverses_id ? L.entry(e.reverses_id) : null;
    const partyName = (l) => (l.party_type === 'brand' ? db.value('SELECT name FROM brands WHERE id = ?', l.party_id) : l.party_type === 'vendor' ? db.value('SELECT name FROM acc_vendors WHERE id = ?', l.party_id) : null);
    const table = `<div class="tablewrap"><table class="table table--fin table--resp"><thead><tr><th>${esc(tr('acc|Account'))}</th><th>${esc(tr('acc|Description'))}</th><th class="num">${esc(tr('acc|Debit'))}</th><th class="num">${esc(tr('acc|Credit'))}</th></tr></thead><tbody>
      ${lines.map((l) => `<tr><td data-label="${esc(tr('acc|Account'))}">${accLink(L.byId(l.account_id))}</td><td data-label="${esc(tr('acc|Description'))}">${esc(tx(l.memo) || '')}${partyName(l) ? sub(esc(partyName(l))) : ''}</td><td class="num" data-label="${esc(tr('acc|Debit'))}">${amt(l.debit)}</td><td class="num" data-label="${esc(tr('acc|Credit'))}">${amt(l.credit)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">${esc(tr('acc|Total'))}</td><td class="num">${fmt(lines.reduce((s, l) => s + l.debit, 0))}</td><td class="num">${fmt(lines.reduce((s, l) => s + l.credit, 0))}</td></tr></tfoot></table></div>`;
    const dl = `<dl class="dl">
      <div><dt>${esc(tr('acc|Date'))}</dt><dd>${ui.date(e.date)}</dd></div>
      <div><dt>${esc(tr('acc|Type'))}</dt><dd>${kindBadge(e.kind)}</dd></div>
      ${sourceOf(e) ? `<div><dt>${esc(tr('acc|Source'))}</dt><dd>${sourceHtml(e)}</dd></div>` : ''}
      <div><dt>${esc(tr('acc|Posted by'))}</dt><dd>${esc(user ? user.name : tr('acc|System'))} · ${ui.dt(e.created_at)}</dd></div>
      ${rev ? `<div><dt>${esc(tr('acc|Reversed by'))}</dt><dd><a href="/admin/accounting/journal/${rev.id}"><bdi>${esc(rev.ref)}</bdi></a> · ${ui.date(rev.date)}</dd></div>` : ''}
      ${of ? `<div><dt>${esc(tr('acc|Reverses'))}</dt><dd><a href="/admin/accounting/journal/${of.id}"><bdi>${esc(of.ref)}</bdi></a></dd></div>` : ''}
    </dl>`;
    const canReverse = e.kind === 'manual' && !e.reversed_by && !e.reverses_id;
    const acts = [ui.btn(esc(tr('acc|Print voucher')), { href: `/admin/accounting/journal/${e.id}/print`, cls: 'btn--ghost', ic: 'print' })];
    if (canReverse) {
      acts.push(pop(tr('acc|Reverse'), ui.form(`/admin/accounting/journal/${e.id}/reverse`, req.session.csrf, `${ui.input('date', tr('acc|Reversal date'), L.firstOpen(today()), { type: 'date', required: true })}${ui.btn(esc(tr('acc|Post the reversal')), { cls: 'btn--primary btn--sm', attrs: { 'data-confirm': tr('acc|Post an entry that cancels {ref}?', { ref: e.ref }) } })}`, { cls: 'stack' }), { align: 'pop--end' }));
    }
    const note = e.kind === 'manual' || e.kind === 'reversal' ? '' : `<p class="hint muted">${esc(tr('acc|Automatic entries change at their source: void the invoice, reverse the receipt or reopen the payroll, and the books follow.'))}</p>`;
    const body = `<div class="grid grid--side">${ui.card(tx(e.memo) || e.ref, `${table}${note}`, { sub: `<bdi>${esc(e.ref)}</bdi>` })}${ui.card(tr('acc|Details'), dl)}</div>`;
    page(req, res, { tab: 'journal', title: tr('acc|Entry {ref}', { ref: e.ref }), crumbs: [['/admin/accounting/journal', tr('acc|Journal')]], body, actions: acts.join('') });
  });
  router.post('/accounting/journal/:id/reverse', RF, (req, res, next) => {
    const e = entryOf(req.params.id);
    if (!e) return next();
    if (e.kind !== 'manual') return h.back(req, res, `/admin/accounting/journal/${e.id}`, 'error', tr('acc|Only manual entries are reversed here.'));
    try {
      const r = L.reverse(e.id, { date: isDate(req.body.date) ? req.body.date : today(), user: req.user });
      h.log(req, 'Reversed a journal entry', 'journal', e.id, `${e.ref} → ${r.ref}`);
      h.back(req, res, `/admin/accounting/journal/${r.id}`, 'ok', tr('acc|Entry {ref} reversed.', { ref: e.ref }));
    } catch (err) {
      h.back(req, res, `/admin/accounting/journal/${e.id}`, 'error', errText(err));
    }
  });
  router.get('/accounting/journal/:id/print', RF, (req, res, next) => {
    const e = entryOf(req.params.id);
    if (!e) return next();
    printDoc(req, res, {
      title: () => tr('acc|Journal voucher'), sub: () => `${e.ref} · ${ui.date(e.date)}`, back: `/admin/accounting/journal/${e.id}`,
      build: () => {
        const lines = L.linesOf(e.id);
        const rows = lines.map((l) => ({ cells: [`${l.code} · ${L.name(l)}`, tx(l.memo) || '', l.debit, l.credit] }));
        rows.push({ cls: 'is-total', cells: [tr('acc|Total'), '', r2(lines.reduce((s, l) => s + l.debit, 0)), r2(lines.reduce((s, l) => s + l.credit, 0))] });
        const user = e.user_id ? db.value('SELECT name FROM users WHERE id = ?', e.user_id) : null;
        return {
          heading: tx(e.memo) || e.ref,
          rep: { cols: [C(tr('acc|Account')), C(tr('acc|Description')), C(tr('acc|Debit'), true), C(tr('acc|Credit'), true)], rows },
          after: `<div class="doc__sign acc-sign"><div><p class="eyebrow">${esc(tr('acc|Prepared by'))}</p><p>${esc(user || tr('acc|System'))}</p></div><div><p class="eyebrow">${esc(tr('acc|Reviewed by'))}</p><p>&nbsp;</p></div><div><p class="eyebrow">${esc(tr('acc|Approved by'))}</p><p>&nbsp;</p></div></div>`,
        };
      },
    });
  });

  // =====================================================================================
  // Chart of accounts
  // =====================================================================================
  router.get('/accounting/accounts', RF, (req, res) => {
    const all = L.accounts();
    const s = L.sums({ to: today() });
    const own = (a) => { const x = s[a.id] || { d: 0, c: 0 }; return r2((x.d - x.c) * L.natural(a.type)); };
    const kids = new Map();
    for (const a of all) { const k = a.parent_id || 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(a); }
    const total = (a) => (a.is_group ? r2((kids.get(a.id) || []).reduce((x, c) => x + total(c) * (L.natural(c.type) === L.natural(a.type) ? 1 : -1), 0)) : own(a));
    const rows = [];
    const walk = (parent, depth) => { for (const a of kids.get(parent) || []) { rows.push({ ...a, depth, bal: total(a) }); walk(a.id, depth + 1); } };
    walk(0, 0);
    const show = req.query.all === '1' ? rows : rows.filter((r) => r.active || r.bal);
    const table = ui.table([
      { label: tr('acc|Code'), render: (a) => `<bdi class="acc-code">${esc(a.code)}</bdi>` },
      { label: tr('acc|Account'), render: (a) => `<span class="acc-d acc-d${Math.min(a.depth, 3)}">${a.is_group ? `<b>${esc(L.name(a))}</b>` : esc(L.name(a))}${a.active ? '' : ` ${ui.badge('void', tr('acc|Inactive'), 'mute')}`}</span>` },
      { label: tr('acc|Type'), render: (a) => esc(lbl(TYPES, a.type)) },
      { label: tr('acc|Balance'), num: true, render: (a) => (a.is_group ? `<b>${amt(a.bal)}</b>` : amt(a.bal)) },
    ], show, { href: (a) => `/admin/accounting/accounts/${a.id}`, cls: 'acc-coa' });
    const groups = all.filter((a) => a.is_group).map((a) => [a.id, L.label(a)]);
    const form = ui.form('/admin/accounting/accounts', req.session.csrf, `<div class="fields">
      ${ui.input('code', tr('acc|Code'), '', { required: true, placeholder: '5250', attrs: { pattern: '\\d{3,6}', inputmode: 'numeric' } })}
      ${ui.select('parent_id', tr('acc|Under'), groups, '', { required: true })}
      ${ui.input('name_en', tr('acc|Name in English'), '', { required: true })}
      ${ui.input('name_ar', tr('acc|Name in Arabic'), '', { attrs: { dir: 'rtl', lang: 'ar' } })}
    </div>${ui.btn(esc(tr('acc|Add account')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    const body = `<div class="grid grid--side">${ui.card(tr('acc|Chart of accounts'), table, { sub: esc(tr('acc|Balances today. Click an account for its ledger.')), action: req.query.all === '1' ? `<a class="btn btn--ghost btn--sm" href="/admin/accounting/accounts">${esc(tr('acc|Hide unused'))}</a>` : `<a class="btn btn--ghost btn--sm" href="/admin/accounting/accounts?all=1">${esc(tr('acc|Show all'))}</a>` })}
      <div class="stack">${ui.card(tr('acc|New account'), form, { sub: esc(tr('acc|It takes the type of the group it sits under.')) })}${ui.card(tr('acc|How the codes work'), `<ul class="acc-key"><li><b>1</b> ${esc(tr('acc|Assets'))}</li><li><b>2</b> ${esc(tr('acc|Liabilities'))}</li><li><b>3</b> ${esc(tr('acc|Equity'))}</li><li><b>4</b> ${esc(tr('acc|Income'))}</li><li><b>5</b> ${esc(tr('acc|Expenses'))}</li></ul>`)}</div></div>`;
    page(req, res, { tab: 'accounts', title: tr('acc|Accounts'), body });
  });
  router.post('/accounting/accounts', RF, (req, res) => {
    const b = req.body;
    const code = h.str(b.code, 6);
    try {
      if (!/^\d{3,6}$/.test(code)) throw new Error('Use a code of 3 to 6 digits.');
      const parent = L.byId(h.int(b.parent_id));
      if (!parent || !parent.is_group) throw new Error('Choose the group the account sits under.');
      const id = L.createAccount({ code, name_en: h.str(b.name_en, 120), name_ar: h.str(b.name_ar, 120), parent_id: parent.id });
      h.log(req, 'Added an account', 'account', id, `${code} ${h.str(b.name_en, 120)}`);
      h.back(req, res, `/admin/accounting/accounts/${id}`, 'ok', tr('acc|Account added.'));
    } catch (err) {
      h.back(req, res, '/admin/accounting/accounts', 'error', errText(err));
    }
  });
  const accountOf = (id) => (/^\d+$/.test(String(id)) ? L.byId(Number(id)) : null);
  const periodOf = (req) => {
    const fy = L.fiscalYear(today());
    const from = isDate(req.query.from) ? req.query.from : fy.from;
    const to = isDate(req.query.to) ? req.query.to : today();
    return from <= to ? { from, to } : { from: to, to: from };
  };
  // an account's ledger page for a period (no query for the default period: fewer distinct links)
  const accHref = (id, q = {}) => {
    const fy = L.fiscalYear(today());
    return `/admin/accounting/accounts/${id}${q.from && (q.from !== fy.from || q.to !== today()) ? `?${qs({ from: q.from, to: q.to })}` : ''}`;
  };
  function glRep(a, q) {
    const gl = L.generalLedger(a.id, q);
    const rows = [{ cls: 'is-sub', cells: [q.from, '', tr('acc|Opening balance'), null, null, gl.opening] }];
    for (const r of gl.rows) rows.push({ href: `/admin/accounting/journal/${r.entry_id}`, cells: [{ html: ui.date(r.date), text: r.date }, r.ref, tx(r.memo) || tx(r.entry_memo) || '', r.debit, r.credit, r.running] });
    rows.push({ cls: 'is-total', cells: [q.to, '', tr('acc|Closing balance'), gl.debit, gl.credit, gl.closing] });
    rows[0].cells[0] = { html: ui.date(q.from), text: q.from };
    rows[rows.length - 1].cells[0] = { html: ui.date(q.to), text: q.to };
    return { gl, rep: { cols: [C(tr('acc|Date')), C(tr('acc|Reference')), C(tr('acc|Description')), C(tr('acc|Debit'), true), C(tr('acc|Credit'), true), C(tr('acc|Balance'), true)], rows } };
  }
  router.get('/accounting/accounts/:id', RF, (req, res, next) => {
    const a = accountOf(req.params.id);
    if (!a) return next();
    const q = periodOf(req);
    const csrf = req.session.csrf;
    if (a.is_group) {
      const kids = db.all('SELECT * FROM acc_accounts WHERE parent_id = ? ORDER BY code', a.id);
      const body = ui.card(L.label(a), ui.table([
        { label: tr('acc|Code'), render: (c) => `<bdi>${esc(c.code)}</bdi>` },
        { label: tr('acc|Account'), render: (c) => esc(L.name(c)) },
        { label: tr('acc|Balance'), num: true, render: (c) => (c.is_group ? '' : amt(L.balance(c.id))) },
      ], kids, { href: (c) => `/admin/accounting/accounts/${c.id}` }), { sub: esc(tr('acc|A group: post to the accounts under it.')) });
      return page(req, res, { tab: 'accounts', title: L.name(a), crumbs: [['/admin/accounting/accounts', tr('acc|Accounts')]], body });
    }
    const { gl, rep } = glRep(a, q);
    if (req.query.format === 'csv') return sendCsv(req, res, rep, `ledger-${a.code}`);
    const filters = `<form class="filters" method="get">${ui.input('from', tr('acc|From'), q.from, { type: 'date', cls: 'f--inline' })}${ui.input('to', tr('acc|To'), q.to, { type: 'date', cls: 'f--inline' })}${ui.btn(esc(tr('acc|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    const used = L.hasLines(a.id);
    const groups = db.all('SELECT * FROM acc_accounts WHERE is_group = 1 AND type = ? ORDER BY code', a.type).map((g) => [g.id, L.label(g)]);
    const edit = ui.form(`/admin/accounting/accounts/${a.id}`, csrf, `
      ${ui.input('name_en', tr('acc|Name in English'), a.name_en, { required: true })}
      ${ui.input('name_ar', tr('acc|Name in Arabic'), a.name_ar || '', { attrs: { dir: 'rtl', lang: 'ar' } })}
      ${ui.select('parent_id', tr('acc|Under'), groups, a.parent_id)}
      ${a.key ? `<p class="hint muted">${esc(tr('acc|A system account: the automatic postings use it, so it stays active.'))}</p>` : `<label class="check"><input type="checkbox" name="active" value="1"${a.active ? ' checked' : ''}> ${esc(tr('acc|Active: can be chosen for new entries'))}</label>`}
      ${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' });
    const del = !used && !a.key && !db.value('SELECT COUNT(*) FROM acc_banks WHERE account_id = ?', a.id)
      ? ui.form(`/admin/accounting/accounts/${a.id}/delete`, csrf, ui.btn(esc(tr('Delete')), { cls: 'btn--ghost btn--sm danger', attrs: { 'data-confirm': tr('acc|Delete account {code}?', { code: a.code }) } }))
      : `<p class="hint muted">${esc(used ? tr('acc|It has entries, so it cannot be deleted. Make it inactive instead.') : tr('acc|In use, so it cannot be deleted.'))}</p>`;
    const kpis = `<div class="kpis kpis--3">${ui.kpi({ label: tr('acc|Opening balance'), value: fmt(gl.opening), sub: esc(ui.date(q.from)) })}${ui.kpi({ label: tr('acc|Movement'), value: fmt(r2(gl.closing - gl.opening)), sub: esc(tr('acc|Debits {d} · credits {c}', { d: fmt(gl.debit), c: fmt(gl.credit) })) })}${ui.kpi({ label: tr('acc|Closing balance'), value: fmt(gl.closing), sub: esc(ui.date(q.to)) })}</div>`;
    const body = `${kpis}${filters}<div class="grid grid--side">${ui.card(tr('acc|Ledger'), reportHtml(rep), { sub: esc(periodText(q.from, q.to)), action: ui.btn(esc(tr('Export CSV')), { href: `/admin/accounting/accounts/${a.id}?${qs({ ...q, format: 'csv' })}`, cls: 'btn--ghost btn--sm', ic: 'dl' }) })}
      <div class="stack">${ui.card(tr('acc|Account details'), `<dl class="dl"><div><dt>${esc(tr('acc|Code'))}</dt><dd><bdi>${esc(a.code)}</bdi></dd></div><div><dt>${esc(tr('acc|Type'))}</dt><dd>${esc(lbl(TYPES, a.type))}</dd></div></dl>${edit}`)}${ui.card(tr('Delete'), del)}</div></div>`;
    page(req, res, { tab: 'accounts', title: L.label(a), crumbs: [['/admin/accounting/accounts', tr('acc|Accounts')]], body });
  });
  router.post('/accounting/accounts/:id', RF, (req, res, next) => {
    const a = accountOf(req.params.id);
    if (!a) return next();
    const b = req.body;
    const nameEn = h.str(b.name_en, 120);
    if (!nameEn) return h.back(req, res, `/admin/accounting/accounts/${a.id}`, 'error', tr('acc|Give the account a name.'));
    const parent = L.byId(h.int(b.parent_id));
    const parentId = parent && parent.is_group && parent.type === a.type && parent.id !== a.id ? parent.id : a.parent_id;
    db.run('UPDATE acc_accounts SET name_en = ?, name_ar = ?, parent_id = ?, active = ? WHERE id = ?', nameEn, h.str(b.name_ar, 120) || null, parentId, a.key ? 1 : b.active ? 1 : 0, a.id);
    h.log(req, 'Edited an account', 'account', a.id, `${a.code} ${nameEn}`);
    h.back(req, res, `/admin/accounting/accounts/${a.id}`, 'ok', tr('Saved.'));
  });
  router.post('/accounting/accounts/:id/delete', RF, (req, res, next) => {
    const a = accountOf(req.params.id);
    if (!a) return next();
    if (a.key || a.is_group || L.hasLines(a.id) || db.value('SELECT COUNT(*) FROM acc_banks WHERE account_id = ?', a.id) || db.value('SELECT COUNT(*) FROM acc_bill_lines WHERE account_id = ?', a.id)) {
      return h.back(req, res, `/admin/accounting/accounts/${a.id}`, 'error', tr('acc|In use, so it cannot be deleted.'));
    }
    db.tx(() => {
      db.run('DELETE FROM acc_budgets WHERE account_id = ?', a.id);
      db.run('UPDATE acc_vendors SET account_id = NULL WHERE account_id = ?', a.id);
      db.run('DELETE FROM acc_accounts WHERE id = ?', a.id);
    });
    h.log(req, 'Deleted an account', 'account', a.id, `${a.code} ${a.name_en}`);
    h.back(req, res, '/admin/accounting/accounts', 'ok', tr('acc|Account deleted.'));
  });

  // =====================================================================================
  // Receivables
  // =====================================================================================
  const buckets = () => BUCKET_LABELS.map((b) => tr(b));
  function agedRep(kind, asOf) {
    const a = kind === 'ar' ? L.agedReceivables(asOf) : L.agedPayables(asOf);
    const rows = a.rows.map((r) => ({
      href: kind === 'ar' ? (r.brand_id ? `/admin/accounting/receivables/${r.brand_id}` : null) : `/admin/accounting/vendors/${r.vendor_id}`,
      cells: [r.party, ...r.buckets, r.total],
    }));
    if (rows.length) rows.push({ cls: 'is-total', cells: [tr('acc|Total'), ...a.totals, a.total] });
    return { a, rep: { cols: [C(kind === 'ar' ? tr('acc|Tenant') : tr('acc|Supplier')), ...buckets().map((b) => C(b, true)), C(tr('acc|Total'), true)], rows } };
  }
  router.get('/accounting/receivables', RF, (req, res) => {
    const t = today();
    const { a, rep } = agedRep('ar', t);
    const overdue = r2(a.totals.slice(1).reduce((s, x) => s + x, 0));
    const collected = r2(db.value("SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'received' AND substr(date, 1, 7) = ?", t.slice(0, 7)));
    const billed90 = r2(db.value("SELECT COALESCE(SUM(total),0) FROM invoices WHERE status != 'void' AND due_date > ? AND due_date <= ? AND kind NOT IN ('deposit','fitout')", M.addDays(t, -90), t));
    const dso = billed90 > 0 ? Math.round((a.total / billed90) * 90) : null;
    const kpis = [
      ui.kpi({ label: tr('acc|Tenants owe'), value: fmt(a.total), sub: esc(tn(a.rows.length, 'acc|{n} tenant', 'acc|{n} tenants')) }),
      ui.kpi({ label: tr('acc|Overdue'), value: fmt(overdue), sub: esc(a.total ? tr('acc|{pct}% of what is owed', { pct: Math.round((overdue / a.total) * 100) }) : tr('acc|Nothing overdue')), tone: overdue ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('acc|Over 90 days'), value: fmt(a.totals[4]), sub: esc(tr('acc|Consider a provision or legal follow-up')) }),
      ui.kpi({ label: tr('acc|Collected this month'), value: fmt(collected), sub: esc(dso === null ? ui.monthYear(t.slice(0, 7)) : tr('acc|Days sales outstanding: {n}', { n: dso })) }),
    ].join('');
    const body = `<div class="kpis kpis--4">${kpis}</div>${ui.card(tr('acc|Aged receivables'), reportHtml(rep), {
      sub: esc(tr('acc|Issued invoices not yet paid, on {date}. Click a tenant for the statement.', { date: ui.date(t) })),
      action: `${ui.btn(esc(tr('Export CSV')), { href: `/admin/accounting/reports/ar?${qs({ date: t, format: 'csv' })}`, cls: 'btn--ghost btn--sm', ic: 'dl' })}${ui.btn(esc(tr('acc|Print')), { href: `/admin/accounting/reports/ar?${qs({ date: t, print: 1 })}`, cls: 'btn--ghost btn--sm', ic: 'print' })}`,
    })}`;
    page(req, res, { tab: 'receivables', title: tr('acc|Receivables'), body, actions: ui.btn(esc(tr('Billing')), { href: '/admin/billing', cls: 'btn--ghost', ic: 'bill' }) });
  });
  const brandOf = (id) => (/^\d+$/.test(String(id)) ? db.get('SELECT * FROM brands WHERE id = ?', Number(id)) : null);
  function statementRep(brand, q) {
    const st = L.tenantStatement(brand.id, q);
    const desc = (r) => {
      if (r.type === 'invoice') return `${lbl(INV_KINDS, r.kind)}${r.status === 'void' ? '' : ''}`;
      if (r.type === 'payment') return tr('acc|Payment received{method}', { method: r.method && METHODS[r.method] ? ` · ${lbl(METHODS, r.method)}` : '' });
      return tr('acc|Payment reversed');
    };
    const rows = [{ cls: 'is-sub', cells: [{ html: ui.date(q.from), text: q.from }, '', tr('acc|Opening balance'), null, null, st.opening] }];
    for (const r of st.rows) rows.push({ href: r.type === 'invoice' ? `/admin/invoices/${r.id}` : null, cells: [{ html: ui.date(r.date), text: r.date }, r.type === 'invoice' ? r.ref : r.ref, desc(r), r.debit, r.credit, r.running] });
    rows.push({ cls: 'is-total', cells: [{ html: ui.date(q.to), text: q.to }, '', tr('acc|Balance due'), st.invoiced, st.paid, st.closing] });
    return { st, rep: { cols: [C(tr('acc|Date')), C(tr('acc|Reference')), C(tr('acc|Description')), C(tr('acc|Charges'), true), C(tr('acc|Payments'), true), C(tr('acc|Balance'), true)], rows } };
  }
  router.get('/accounting/receivables/:id', RF, (req, res, next) => {
    const brand = brandOf(req.params.id);
    if (!brand) return next();
    const q = periodOf(req);
    const { st, rep } = statementRep(brand, q);
    if (req.query.format === 'csv') return sendCsv(req, res, rep, 'statement');
    const filters = `<form class="filters" method="get">${ui.input('from', tr('acc|From'), q.from, { type: 'date', cls: 'f--inline' })}${ui.input('to', tr('acc|To'), q.to, { type: 'date', cls: 'f--inline' })}${ui.btn(esc(tr('acc|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    const kpis = `<div class="kpis kpis--3">${ui.kpi({ label: tr('acc|Invoiced'), value: fmt(st.invoiced), sub: esc(periodText(q.from, q.to)) })}${ui.kpi({ label: tr('acc|Paid'), value: fmt(st.paid) })}${ui.kpi({ label: tr('acc|Balance due'), value: fmt(st.closing), tone: st.closing > 0.004 ? 'kpi--alert' : '' })}</div>`;
    const body = `${kpis}${filters}${ui.card(tr('acc|Statement of account'), reportHtml(rep), { action: ui.btn(esc(tr('Export CSV')), { href: `/admin/accounting/receivables/${brand.id}?${qs({ ...q, format: 'csv' })}`, cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`;
    page(req, res, {
      tab: 'receivables', title: brand.name, crumbs: [['/admin/accounting/receivables', tr('acc|Receivables')]], body,
      actions: `${ui.btn(esc(tr('acc|Print statement')), { href: `/admin/accounting/receivables/${brand.id}/print?${qs(q)}`, cls: 'btn--primary', ic: 'print' })}${ui.btn(esc(tr('acc|Tenant file')), { href: `/admin/tenants/${brand.id}`, cls: 'btn--ghost' })}`,
    });
  });
  router.get('/accounting/receivables/:id/print', RF, (req, res, next) => {
    const brand = brandOf(req.params.id);
    if (!brand) return next();
    const q = periodOf(req);
    printDoc(req, res, {
      title: () => tr('acc|Statement of account'), sub: () => periodText(q.from, q.to), back: `/admin/accounting/receivables/${brand.id}?${qs(q)}`,
      build: () => {
        const { st, rep } = statementRep(brand, q);
        return { heading: brand.name, rep, after: `<p class="acc-due">${esc(tr('acc|Balance due on {date}', { date: ui.date(q.to) }))} <b>${ui.money(st.closing)}</b></p>` };
      },
    });
  });

  // =====================================================================================
  // Payables: suppliers, bills, payments
  // =====================================================================================
  const vendorOf = (id) => (/^\d+$/.test(String(id)) ? db.get('SELECT * FROM acc_vendors WHERE id = ?', Number(id)) : null);
  const billOf = (id) => (/^\d+$/.test(String(id)) ? db.get('SELECT b.*, v.name vendor FROM acc_bills b JOIN acc_vendors v ON v.id = b.vendor_id WHERE b.id = ?', Number(id)) : null);
  const billBadge = (b) => (['approved', 'partial'].includes(b.status) && b.due_date < today() ? ui.badge('overdue', tr('acc|Overdue'), 'rose') : ui.badge(b.status, lbl(BILL_STATUS, b.status), BILL_TONES[b.status]));
  const vendorBalance = (id) => r2(db.value("SELECT COALESCE(SUM(total - paid),0) FROM acc_bills WHERE vendor_id = ? AND status IN ('approved','partial')", id));
  const expenseOptions = () => accOptions((a) => ['expense', 'asset'].includes(a.type) && a.sub !== 'cash' && a.sub !== 'accum' && a.key !== 'ar');
  function vendorForm(v = {}) {
    return `<div class="fields">
      ${ui.input('name', tr('acc|Supplier name'), v.name || '', { required: true })}
      ${ui.input('tax_id', tr('acc|Tax registration number'), v.tax_id || '')}
      ${ui.input('phone', tr('acc|Phone'), v.phone || '', { type: 'tel' })}
      ${ui.input('email', tr('acc|Email'), v.email || '', { type: 'email' })}
      ${ui.input('bank', tr('acc|Bank'), v.bank || '')}
      ${ui.input('iban', tr('acc|IBAN'), v.iban || '', { attrs: { dir: 'ltr' } })}
      ${ui.input('terms_days', tr('acc|Payment terms (days)'), v.terms_days ?? 30, { type: 'number', min: 0, max: 365 })}
      ${ui.select('account_id', tr('acc|Usual expense account'), expenseOptions(), v.account_id || '', { blank: tr('acc|Choose on each bill') })}
      ${ui.select('contract_id', tr('acc|Service contract'), db.all('SELECT id, ref, counterparty FROM contracts ORDER BY counterparty').map((c) => [c.id, `${c.ref} · ${c.counterparty}`]), v.contract_id || '', { blank: tr('acc|None') })}
    </div>`;
  }
  const vendorValues = (b) => ({
    name: h.str(b.name, 160), tax_id: h.str(b.tax_id, 40) || null, phone: h.str(b.phone, 40) || null, email: h.str(b.email, 160) || null,
    bank: h.str(b.bank, 120) || null, iban: h.str(b.iban, 40).replace(/\s+/g, '') || null, terms_days: Math.max(0, Math.min(365, h.int(b.terms_days) ?? 30)),
    account_id: L.byId(h.int(b.account_id)) ? h.int(b.account_id) : null, contract_id: h.int(b.contract_id) && db.value('SELECT id FROM contracts WHERE id = ?', h.int(b.contract_id)) ? h.int(b.contract_id) : null,
  });

  router.get('/accounting/payables', RF, (req, res) => {
    const t = today();
    const csrf = req.session.csrf;
    const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM acc_bills GROUP BY status').map((r) => [r.status, r.n]));
    const unpaidN = (counts.approved || 0) + (counts.partial || 0);
    const tab = ['draft', 'unpaid', 'paid', 'all'].includes(req.query.tab) ? req.query.tab : counts.draft && !unpaidN ? 'draft' : 'unpaid';
    const cond = { draft: "b.status = 'draft'", unpaid: "b.status IN ('approved','partial')", paid: "b.status = 'paid'", all: '1 = 1' }[tab];
    const bills = db.all(`SELECT b.*, v.name vendor FROM acc_bills b JOIN acc_vendors v ON v.id = b.vendor_id WHERE ${cond} ORDER BY ${tab === 'unpaid' ? 'b.due_date' : 'b.date DESC, b.id DESC'} LIMIT 200`);
    const owed = r2(db.value("SELECT COALESCE(SUM(total - paid),0) FROM acc_bills WHERE status IN ('approved','partial')"));
    const late = r2(db.value("SELECT COALESCE(SUM(total - paid),0) FROM acc_bills WHERE status IN ('approved','partial') AND due_date < ?", t));
    const soon = r2(db.value("SELECT COALESCE(SUM(total - paid),0) FROM acc_bills WHERE status IN ('approved','partial') AND due_date >= ? AND due_date <= ?", t, M.addDays(t, 14)));
    const kpis = [
      ui.kpi({ label: tr('acc|Owed to suppliers'), value: fmt(owed), sub: esc(tn(unpaidN, 'acc|{n} bill', 'acc|{n} bills')) }),
      ui.kpi({ label: tr('acc|Overdue'), value: fmt(late), tone: late ? 'kpi--alert' : '', sub: esc(late ? tr('acc|Past the due date') : tr('acc|Nothing overdue')) }),
      ui.kpi({ label: tr('acc|Due in 14 days'), value: fmt(soon), sub: esc(tr('acc|Plan the transfers')) }),
      ui.kpi({ label: tr('acc|To approve'), value: ui.n0(counts.draft || 0), sub: esc(tr('acc|Draft bills, incl. maintenance costs')), href: '/admin/accounting/payables?tab=draft', tone: counts.draft ? 'kpi--alert' : '' }),
    ].join('');
    const subTabs = `<nav class="tabs tabs--sub">${[['unpaid', tr('acc|To pay'), unpaidN], ['draft', tr('acc|To approve'), counts.draft], ['paid', tr('accbill|Paid'), 0], ['all', tr('acc|All'), 0]].map(([k, l, n]) => `<a class="tab${tab === k ? ' is-on' : ''}" href="/admin/accounting/payables?tab=${k}">${esc(l)}${n ? ` <b class="nav__count">${n}</b>` : ''}</a>`).join('')}</nav>`;
    const table = ui.table([
      { label: tr('acc|Bill'), render: (b) => `<b><bdi>${esc(b.ref)}</bdi></b>${b.vendor_ref ? sub(`<bdi>${esc(b.vendor_ref)}</bdi>`) : ''}` },
      { label: tr('acc|Supplier'), render: (b) => `${esc(b.vendor)}${b.memo ? sub(esc(txt(b.memo))) : ''}` },
      { label: tr('acc|Date'), render: (b) => ui.date(b.date) },
      { label: tr('acc|Due'), render: (b) => ui.date(b.due_date) },
      { label: tr('acc|Total'), num: true, render: (b) => fmt(b.total) },
      { label: tr('acc|Outstanding'), num: true, render: (b) => (b.status === 'void' ? '—' : amt(b.total - b.paid)) },
      { label: tr('acc|Status'), render: billBadge },
    ], bills, { empty: esc(tr('acc|No bills here.')), href: (b) => `/admin/accounting/bills/${b.id}` });
    const vendors = db.all('SELECT v.*, (SELECT COALESCE(SUM(total - paid),0) FROM acc_bills WHERE vendor_id = v.id AND status IN (\'approved\',\'partial\')) owed FROM acc_vendors v WHERE v.active = 1 ORDER BY owed DESC, v.name LIMIT 30');
    const vendorList = vendors.length
      ? `<ul class="list">${vendors.map((v) => `<li><a href="/admin/accounting/vendors/${v.id}"><span class="what"><b>${esc(v.name)}</b><small>${esc(v.owed > 0.004 ? tr('acc|Owed {amount}', { amount: fmt(v.owed) }) : tr('acc|Nothing owed'))}</small></span></a></li>`).join('')}</ul>`
      : `<p class="muted pad">${esc(tr('acc|No suppliers yet.'))}</p>`;
    const newVendor = pop(tr('acc|New supplier'), ui.form('/admin/accounting/vendors', csrf, `${vendorForm()}${ui.btn(esc(tr('acc|Add supplier')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }), { align: 'pop--end' });
    const { rep: aged } = agedRep('ap', t);
    const ym = t.slice(0, 7);
    const recurring = ui.form('/admin/accounting/payables/contracts', csrf, `<input type="hidden" name="month" value="${ym}">${ui.btn(esc(tr('acc|Bills from contracts')), { cls: 'btn--ghost', ic: 'contract', attrs: { title: tr('acc|Draft this month’s bills for active service contracts'), 'data-confirm': tr('acc|Draft {month} bills for every active service contract?', { month: ui.monthYear(ym) }) } })}`);
    const body = `<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side"><div class="stack">${subTabs}${ui.card(tn(bills.length, 'acc|{n} bill', 'acc|{n} bills'), table)}</div>
<div class="stack">${ui.card(tr('acc|Suppliers'), vendorList, { action: newVendor })}${ui.card(tr('acc|Aged payables'), reportHtml(aged, { cls: 'acc-mini' }), { action: ui.btn(esc(tr('acc|Report')), { href: '/admin/accounting/reports/ap', cls: 'btn--ghost btn--sm' }) })}</div></div>`;
    page(req, res, { tab: 'payables', title: tr('acc|Payables'), body, actions: `${recurring}${ui.btn(esc(tr('acc|New bill')), { href: '/admin/accounting/bills/new', cls: 'btn--primary', ic: 'plus' })}` });
  });

  router.post('/accounting/vendors', RF, (req, res) => {
    const v = vendorValues(req.body);
    if (!v.name) return h.back(req, res, '/admin/accounting/payables', 'error', tr('acc|Give the supplier a name.'));
    if (db.get('SELECT id FROM acc_vendors WHERE name = ? COLLATE NOCASE', v.name)) return h.back(req, res, '/admin/accounting/payables', 'error', tr('acc|A supplier with that name exists already.'));
    const id = Number(db.run('INSERT INTO acc_vendors (name, tax_id, phone, email, bank, iban, terms_days, account_id, contract_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      v.name, v.tax_id, v.phone, v.email, v.bank, v.iban, v.terms_days, v.account_id, v.contract_id, M.now()).lastInsertRowid);
    h.log(req, 'Added a supplier', 'vendor', id, v.name);
    h.back(req, res, `/admin/accounting/vendors/${id}`, 'ok', tr('acc|Supplier added.'));
  });
  router.get('/accounting/vendors/:id', RF, (req, res, next) => {
    const v = vendorOf(req.params.id);
    if (!v) return next();
    const csrf = req.session.csrf;
    const bills = db.all('SELECT * FROM acc_bills WHERE vendor_id = ? ORDER BY date DESC, id DESC', v.id);
    const pays = db.all('SELECT p.*, b.ref bill FROM acc_bill_payments p JOIN acc_bills b ON b.id = p.bill_id WHERE b.vendor_id = ? ORDER BY p.date', v.id);
    // statement: approved bills (credit) and payments (debit), oldest first
    const items = [
      ...bills.filter((b) => !['draft', 'void'].includes(b.status)).map((b) => ({ date: b.date, ref: b.ref, text: tr('acc|Bill'), bill: b.total, pay: 0, href: `/admin/accounting/bills/${b.id}` })),
      ...pays.map((p) => ({ date: p.date, ref: p.ref, text: tr('acc|Payment for {ref}', { ref: p.bill }), bill: 0, pay: p.amount, href: `/admin/accounting/bills/${p.bill_id}` })),
    ].sort((a, b) => (a.date === b.date ? b.bill - a.bill : a.date < b.date ? -1 : 1));
    let run = 0;
    const rep = { cols: [C(tr('acc|Date')), C(tr('acc|Reference')), C(tr('acc|Description')), C(tr('acc|Billed'), true), C(tr('acc|Paid'), true), C(tr('acc|Balance'), true)], rows: items.map((x) => { run = r2(run + x.bill - x.pay); return { href: x.href, cells: [{ html: ui.date(x.date), text: x.date }, x.ref, x.text, x.bill, x.pay, run] }; }) };
    const billTable = ui.table([
      { label: tr('acc|Bill'), render: (b) => `<b><bdi>${esc(b.ref)}</bdi></b>${b.vendor_ref ? sub(`<bdi>${esc(b.vendor_ref)}</bdi>`) : ''}` },
      { label: tr('acc|Date'), render: (b) => ui.date(b.date) },
      { label: tr('acc|Total'), num: true, render: (b) => fmt(b.total) },
      { label: tr('acc|Status'), render: billBadge },
    ], bills, { empty: esc(tr('acc|No bills yet.')), href: (b) => `/admin/accounting/bills/${b.id}` });
    const edit = ui.form(`/admin/accounting/vendors/${v.id}`, csrf, `${vendorForm(v)}<label class="check"><input type="checkbox" name="active" value="1"${v.active ? ' checked' : ''}> ${esc(tr('acc|Active supplier'))}</label>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' });
    const kpis = `<div class="kpis kpis--3">${ui.kpi({ label: tr('acc|Owed'), value: fmt(vendorBalance(v.id)) })}${ui.kpi({ label: tr('acc|Billed this year'), value: fmt(r2(bills.filter((b) => !['draft', 'void'].includes(b.status) && b.date >= L.fiscalYear().from).reduce((s, b) => s + b.total, 0))) })}${ui.kpi({ label: tr('acc|Paid this year'), value: fmt(r2(pays.filter((p) => p.date >= L.fiscalYear().from).reduce((s, p) => s + p.amount, 0))) })}</div>`;
    const body = `${kpis}<div class="grid grid--side"><div class="stack">${ui.card(tr('acc|Statement'), reportHtml(rep))}${ui.card(tr('acc|Bills'), billTable)}</div>${ui.card(tr('acc|Supplier details'), edit)}</div>`;
    page(req, res, { tab: 'payables', title: v.name, crumbs: [['/admin/accounting/payables', tr('acc|Payables')]], body, actions: ui.btn(esc(tr('acc|New bill')), { href: `/admin/accounting/bills/new?vendor=${v.id}`, cls: 'btn--primary', ic: 'plus' }) });
  });
  router.post('/accounting/vendors/:id', RF, (req, res, next) => {
    const old = vendorOf(req.params.id);
    if (!old) return next();
    const v = vendorValues(req.body);
    if (!v.name) return h.back(req, res, `/admin/accounting/vendors/${old.id}`, 'error', tr('acc|Give the supplier a name.'));
    db.run('UPDATE acc_vendors SET name = ?, tax_id = ?, phone = ?, email = ?, bank = ?, iban = ?, terms_days = ?, account_id = ?, contract_id = ?, active = ? WHERE id = ?',
      v.name, v.tax_id, v.phone, v.email, v.bank, v.iban, v.terms_days, v.account_id, v.contract_id, req.body.active ? 1 : 0, old.id);
    h.log(req, 'Edited a supplier', 'vendor', old.id, v.name);
    h.back(req, res, `/admin/accounting/vendors/${old.id}`, 'ok', tr('Saved.'));
  });

  function billForm(req, res, v = {}, error = null) {
    const vendors = db.all('SELECT id, name, account_id FROM acc_vendors WHERE active = 1 ORDER BY name');
    const pre = vendorOf(v.vendor_id || req.query.vendor);
    const opts = expenseOptions();
    const lines = v.lines && v.lines.length ? v.lines : [];
    while (lines.length < 3) lines.push({ account: lines.length === 0 && pre ? pre.account_id : '' });
    const pct = v.vat_pct ?? (Number(db.setting('vat_pct')) || 0);
    const inner = `${error ? `<div class="alert alert--error"><p>${esc(error)}</p></div>` : ''}<div class="fields">
      ${ui.select('vendor_id', tr('acc|Supplier'), vendors.map((x) => [x.id, x.name]), pre ? pre.id : '', { blank: tr('acc|Choose a supplier'), required: true })}
      ${ui.input('vendor_ref', tr('acc|Supplier invoice number'), v.vendor_ref || '')}
      ${ui.input('date', tr('acc|Bill date'), v.date || today(), { type: 'date', required: true })}
      ${ui.input('due_date', tr('acc|Due date'), v.due_date || '', { type: 'date', hint: tr('acc|Empty: the supplier’s payment terms') })}
    </div>
    <div class="tablewrap acc-je"><table class="table table--fin table--resp" data-bill><thead><tr><th>${esc(tr('acc|Expense account'))}</th><th>${esc(tr('acc|Description'))}</th><th class="num">${esc(tr('acc|Amount before VAT'))}</th></tr></thead><tbody>
    ${lines.map((l) => `<tr data-je-row><td data-label="${esc(tr('acc|Expense account'))}">${bareSelect('account', opts, l.account, { blank: tr('acc|Choose an account'), attrs: `aria-label="${esc(tr('acc|Expense account'))}"` })}</td><td data-label="${esc(tr('acc|Description'))}"><input name="line_memo" value="${esc(l.description || '')}" maxlength="200" aria-label="${esc(tr('acc|Description'))}"></td><td class="num" data-label="${esc(tr('acc|Amount before VAT'))}"><input type="number" name="amount" step="0.01" min="0" inputmode="decimal" value="${l.amount ? esc(l.amount) : ''}" data-je-debit aria-label="${esc(tr('acc|Amount before VAT'))}"></td></tr>`).join('')}
    </tbody><tfoot><tr><td><button type="button" class="btn btn--ghost btn--sm" data-je-add>${ui.icon('plus')}<span>${esc(tr('acc|Add a line'))}</span></button></td><td>${esc(tr('acc|Net'))}</td><td class="num" data-je-dr>0.00</td></tr></tfoot></table></div>
    <div class="fields">
      ${ui.input('vat_pct', tr('acc|VAT %'), pct, { type: 'number', step: '0.01', min: 0, max: 100, hint: tr('acc|Recoverable input VAT, posted to VAT input') })}
      ${ui.input('memo', tr('acc|Note'), v.memo || '', { cls: 'span-2' })}
    </div>
    <div class="row">${ui.btn(esc(tr('acc|Save as draft')), { cls: 'btn--ghost' })}${ui.btn(esc(tr('acc|Save and approve')), { cls: 'btn--primary', attrs: { name: 'approve', value: '1' } })}<a class="btn btn--ghost" href="/admin/accounting/payables">${esc(tr('Cancel'))}</a></div>`;
    const body = ui.card(tr('acc|New supplier bill'), ui.form('/admin/accounting/bills', req.session.csrf, inner, { cls: 'stack' }), { sub: esc(tr('acc|Approving a bill posts it: expense and VAT input against accounts payable.')) });
    page(req, res, { tab: 'payables', title: tr('acc|New bill'), crumbs: [['/admin/accounting/payables', tr('acc|Payables')]], body, status: error ? 422 : 200 });
  }
  router.get('/accounting/bills/new', RF, (req, res) => billForm(req, res));
  router.post('/accounting/bills', RF, (req, res) => {
    const b = req.body;
    const accs = h.list(b.account);
    const amts = h.list(b.amount);
    const memos = h.list(b.line_memo);
    const lines = accs.map((a, i) => ({ account: h.int(a), amount: num(amts[i]), description: h.str(memos[i], 200) || null }));
    const pct = Math.max(0, Math.min(100, num(b.vat_pct)));
    const v = { vendor_id: h.int(b.vendor_id), vendor_ref: h.str(b.vendor_ref, 60) || null, date: b.date, due_date: isDate(b.due_date) ? b.due_date : null, lines, vat_pct: pct, memo: h.str(b.memo, 300) || null };
    const used = lines.filter((l) => l.amount > 0);
    if (!vendorOf(v.vendor_id)) return billForm(req, res, v, tr('acc|Choose the supplier.'));
    if (used.some((l) => !l.account || !L.byId(l.account))) return billForm(req, res, v, tr('acc|Choose an account for every line with an amount.'));
    try {
      const net = r2(used.reduce((s, l) => s + l.amount, 0));
      const bill = L.createBill({ ...v, lines: used, vat: r2((net * pct) / 100), user: req.user });
      h.log(req, 'Added a supplier bill', 'bill', bill.id, bill.ref);
      if (b.approve) {
        try {
          L.approveBill(bill.id, { user: req.user });
          h.log(req, 'Approved a supplier bill', 'bill', bill.id, bill.ref);
        } catch (err) {
          return h.back(req, res, `/admin/accounting/bills/${bill.id}`, 'error', errText(err));
        }
      }
      h.back(req, res, `/admin/accounting/bills/${bill.id}`, 'ok', tr('acc|Bill {ref} saved.', { ref: bill.ref }));
    } catch (err) {
      billForm(req, res, v, errText(err));
    }
  });
  router.get('/accounting/bills/:id', RF, (req, res, next) => {
    const b = billOf(req.params.id);
    if (!b) return next();
    const csrf = req.session.csrf;
    const lines = db.all('SELECT l.*, a.code, a.name_en, a.name_ar FROM acc_bill_lines l JOIN acc_accounts a ON a.id = l.account_id WHERE l.bill_id = ? ORDER BY l.sort, l.id', b.id);
    const pays = db.all('SELECT p.*, a.code, a.name_en, a.name_ar FROM acc_bill_payments p JOIN acc_accounts a ON a.id = p.account_id WHERE p.bill_id = ? ORDER BY p.date, p.id', b.id);
    const posted = L.active(`bill:${b.id}`);
    const table = `<div class="tablewrap"><table class="table table--fin table--resp"><thead><tr><th>${esc(tr('acc|Account'))}</th><th>${esc(tr('acc|Description'))}</th><th class="num">${esc(tr('acc|Amount'))}</th></tr></thead><tbody>
      ${lines.map((l) => `<tr><td data-label="${esc(tr('acc|Account'))}"><bdi>${esc(l.code)}</bdi> · ${esc(L.name(l))}</td><td data-label="${esc(tr('acc|Description'))}">${esc(txt(l.description) || '')}</td><td class="num" data-label="${esc(tr('acc|Amount'))}">${fmt(l.amount)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">${esc(tr('acc|Net'))}</td><td class="num">${fmt(b.net)}</td></tr><tr><td colspan="2">${esc(tr('acc|VAT'))}</td><td class="num">${amt(b.vat)}</td></tr><tr><td colspan="2"><b>${esc(tr('acc|Total'))}</b></td><td class="num"><b>${fmt(b.total)}</b></td></tr></tfoot></table></div>`;
    const payTable = pays.length ? ui.table([
      { label: tr('acc|Payment'), render: (p) => `<b><bdi>${esc(p.ref)}</bdi></b>${p.reference ? sub(`<bdi>${esc(p.reference)}</bdi>`) : ''}` },
      { label: tr('acc|Date'), render: (p) => ui.date(p.date) },
      { label: tr('acc|Paid from'), render: (p) => `<bdi>${esc(p.code)}</bdi> · ${esc(L.name(p))}` },
      { label: tr('acc|Amount'), num: true, render: (p) => fmt(p.amount) },
    ], pays) : `<p class="muted pad">${esc(tr('acc|No payments yet.'))}</p>`;
    const dl = `<dl class="dl">
      <div><dt>${esc(tr('acc|Supplier'))}</dt><dd><a href="/admin/accounting/vendors/${b.vendor_id}">${esc(b.vendor)}</a></dd></div>
      ${b.vendor_ref ? `<div><dt>${esc(tr('acc|Supplier invoice number'))}</dt><dd><bdi>${esc(b.vendor_ref)}</bdi></dd></div>` : ''}
      <div><dt>${esc(tr('acc|Bill date'))}</dt><dd>${ui.date(b.date)}</dd></div>
      <div><dt>${esc(tr('acc|Due date'))}</dt><dd>${ui.date(b.due_date)}</dd></div>
      <div><dt>${esc(tr('acc|Status'))}</dt><dd>${billBadge(b)}</dd></div>
      <div><dt>${esc(tr('acc|Outstanding'))}</dt><dd>${b.status === 'void' ? '—' : fmt(b.total - b.paid)}</dd></div>
      ${b.source ? `<div><dt>${esc(tr('acc|Source'))}</dt><dd>${esc(b.source.startsWith('contract') ? tr('acc|Service contract') : tr('acc|Maintenance'))}</dd></div>` : ''}
      ${posted ? `<div><dt>${esc(tr('acc|In the books'))}</dt><dd><a href="/admin/accounting/journal/${posted.id}"><bdi>${esc(posted.ref)}</bdi></a></dd></div>` : ''}
      ${b.memo ? `<div><dt>${esc(tr('acc|Note'))}</dt><dd>${esc(txt(b.memo))}</dd></div>` : ''}
    </dl>`;
    const acts = [];
    if (b.status === 'draft') {
      acts.push(ui.form(`/admin/accounting/bills/${b.id}/approve`, csrf, ui.btn(esc(tr('acc|Approve')), { cls: 'btn--primary', ic: 'check' })));
      acts.push(ui.form(`/admin/accounting/bills/${b.id}/delete`, csrf, ui.btn(esc(tr('Delete')), { cls: 'btn--ghost', attrs: { 'data-confirm': tr('acc|Delete draft bill {ref}?', { ref: b.ref }) } })));
    }
    if (['approved', 'partial'].includes(b.status)) {
      const left = r2(b.total - b.paid);
      acts.push(pop(tr('acc|Pay'), ui.form(`/admin/accounting/bills/${b.id}/pay`, csrf, `${ui.input('amount', tr('acc|Amount'), left, { type: 'number', step: '0.01', min: '0.01', max: left, required: true })}${ui.input('date', tr('acc|Paid on'), L.firstOpen(today()), { type: 'date', required: true })}${ui.select('account', tr('acc|Paid from'), cashOptions(), L.S('payables_account', '') ? (L.byCode(L.S('payables_account')) || {}).id : '', { required: true })}${ui.input('reference', tr('acc|Transfer or cheque number'), '')}${ui.btn(esc(tr('acc|Record payment')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }), { cls: 'btn--primary', align: 'pop--end' }));
    }
    if (['draft', 'approved'].includes(b.status) && !b.paid) acts.push(ui.form(`/admin/accounting/bills/${b.id}/void`, csrf, ui.btn(esc(tr('acc|Void')), { cls: 'btn--ghost', attrs: { 'data-confirm': tr('acc|Void bill {ref}? An approved bill is reversed in the books.', { ref: b.ref }) } })));
    const body = `<div class="grid grid--side"><div class="stack">${ui.card(tr('acc|Lines'), table)}${ui.card(tr('acc|Payments'), payTable)}</div>${ui.card(tr('acc|Details'), dl)}</div>`;
    page(req, res, { tab: 'payables', title: tr('acc|Bill {ref}', { ref: b.ref }), crumbs: [['/admin/accounting/payables', tr('acc|Payables')]], body, actions: acts.join('') });
  });
  const billAction = (path, fn, okText, action) => router.post(`/accounting/bills/:id/${path}`, RF, (req, res, next) => {
    const b = billOf(req.params.id);
    if (!b) return next();
    try {
      const out = fn(b, req);
      h.log(req, action, 'bill', b.id, b.ref);
      h.back(req, res, out && out.redirect ? out.redirect : `/admin/accounting/bills/${b.id}`, 'ok', tr(okText, { ref: b.ref }));
    } catch (err) {
      h.back(req, res, `/admin/accounting/bills/${b.id}`, 'error', errText(err));
    }
  });
  billAction('approve', (b, req) => L.approveBill(b.id, { user: req.user }), 'acc|Bill {ref} approved and posted.', 'Approved a supplier bill');
  billAction('pay', (b, req) => {
    const acc = L.byId(h.int(req.body.account));
    if (!acc || acc.sub !== 'cash') throw new Error('Choose the bank or cash account it was paid from.');
    L.payBill(b.id, { amount: num(req.body.amount), date: isDate(req.body.date) ? req.body.date : today(), account: acc.id, reference: h.str(req.body.reference, 80) || null, user: req.user });
  }, 'acc|Payment recorded on {ref}.', 'Paid a supplier bill');
  billAction('void', (b) => L.voidBill(b.id), 'acc|Bill {ref} voided.', 'Voided a supplier bill');
  billAction('delete', (b) => {
    if (b.status !== 'draft') throw new Error('Only a draft bill can be deleted.');
    db.run('DELETE FROM acc_bills WHERE id = ?', b.id);
    return { redirect: '/admin/accounting/payables' };
  }, 'acc|Bill {ref} deleted.', 'Deleted a supplier bill');

  // Recurring bills: this month's charge for every active service contract, as drafts (once each).
  const PER_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };
  function contractBills(ym, { user = null, demo = null } = {}) {
    const start = `${ym}-01`;
    const end = L.monthEnd(ym);
    const pct = Number(db.setting('vat_pct')) || 0;
    let n = 0;
    db.tx(() => {
      const list = db.all(`SELECT * FROM contracts WHERE status = 'active' AND value > 0 AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) ${demo === null ? '' : 'AND demo = ?'}`, end, start, ...(demo === null ? [] : [demo]));
      for (const c of list) {
        const first = (c.start_date || start).slice(0, 7);
        const every = PER_MONTHS[c.billing];
        if (c.billing === 'one_off' ? first !== ym : !every || L.monthsBetween(first, ym) % every !== 0) continue;
        if (db.value('SELECT COUNT(*) FROM acc_bills WHERE source = ? AND source_id = ?', `contract:${ym}`, c.id)) continue;
        const v = db.get('SELECT * FROM acc_vendors WHERE contract_id = ?', c.id) || L.vendorFor(c.counterparty, { demo: c.demo, contract_id: c.id });
        const account = v.account_id || L.idOf(L.CATEGORY_ACCOUNTS[c.kind] || 'exp_other');
        L.createBill({
          vendor_id: v.id, date: start, lines: [{ account, description: `${c.ref} · ${ym}`, amount: c.value }], vat: r2((c.value * pct) / 100),
          memo: `Service contract ${c.ref}`, source: `contract:${ym}`, source_id: c.id, user, demo: c.demo,
        });
        n++;
      }
    });
    return n;
  }
  router.post('/accounting/payables/contracts', RF, (req, res) => {
    const ym = isYM(req.body.month) ? req.body.month : today().slice(0, 7);
    try {
      const n = contractBills(ym, { user: req.user });
      h.log(req, 'Created bills from contracts', 'bill', null, `${ym}: ${n}`);
      h.back(req, res, '/admin/accounting/payables?tab=draft', 'ok', n ? tn(n, 'acc|{n} draft bill created from contracts.', 'acc|{n} draft bills created from contracts.') : tr('acc|Every active contract already has its bill for {month}.', { month: ui.monthYear(ym) }));
    } catch (err) {
      h.back(req, res, '/admin/accounting/payables', 'error', errText(err));
    }
  });
  h.accountingContractBills = contractBills;

  // =====================================================================================
  // Banking: accounts, statement import, reconciliation
  // =====================================================================================
  const bankOf = (id) => (/^\d+$/.test(String(id)) ? db.get('SELECT * FROM acc_banks WHERE id = ?', Number(id)) : null);
  router.get('/accounting/banking', RF, (req, res) => {
    const banks = db.all('SELECT * FROM acc_banks ORDER BY active DESC, kind, name');
    const cards = banks.map((b) => {
      const s = L.bankSummary(b);
      const a = L.byId(b.account_id);
      return `<a class="card acc-bank${b.active ? '' : ' is-off'}" href="/admin/accounting/banking/${b.id}">
        <header class="card__head"><div><h2>${esc(L.name(a))}</h2><p>${esc(b.kind === 'cash' ? tr('acc|Cash') : b.bank || tr('acc|Bank account'))}${b.iban ? ` · <bdi>${esc(b.iban)}</bdi>` : ''}</p></div>${Math.abs(s.difference) < 0.01 && !s.open ? ui.badge('ok', tr('acc|Reconciled'), 'ok') : ui.badge('pending', tn(s.open, 'acc|{n} to match', 'acc|{n} to match'), 'amber')}</header>
        <div class="card__body"><dl class="dl"><div><dt>${esc(tr('acc|In the books'))}</dt><dd><b>${fmt(s.book)}</b></dd></div><div><dt>${esc(tr('acc|On the statement'))}</dt><dd>${s.lines ? fmt(s.statement) : esc(tr('acc|No statement yet'))}</dd></div>${s.last ? `<div><dt>${esc(tr('acc|Last line'))}</dt><dd>${ui.date(s.last.date)}</dd></div>` : ''}</dl></div></a>`;
    }).join('');
    const form = ui.form('/admin/accounting/banking', req.session.csrf, `<div class="fields">
      ${ui.input('name', tr('acc|Account name'), '', { required: true, placeholder: tr('acc|e.g. CIB current account') })}
      ${ui.input('name_ar', tr('acc|Name in Arabic'), '', { attrs: { dir: 'rtl', lang: 'ar' } })}
      ${ui.select('kind', tr('acc|Type'), [['bank', tr('acc|Bank account')], ['cash', tr('acc|Cash')]], 'bank')}
      ${ui.input('bank', tr('acc|Bank'), '')}
      ${ui.input('iban', tr('acc|IBAN'), '', { attrs: { dir: 'ltr' } })}
      ${ui.input('opening_balance', tr('acc|Opening balance'), '', { type: 'number', step: '0.01' })}
      ${ui.input('opening_date', tr('acc|Balance on'), L.firstOpen(today()), { type: 'date' })}
    </div>${ui.btn(esc(tr('acc|Add account')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    const total = r2(banks.filter((b) => b.active).reduce((s, b) => s + L.balance(b.account_id), 0));
    const body = `<div class="kpis kpis--3">${ui.kpi({ label: tr('acc|Cash and banks'), value: fmt(total), sub: esc(tn(banks.length, 'acc|{n} account', 'acc|{n} accounts')) })}${ui.kpi({ label: tr('acc|Lines to match'), value: ui.n0(db.value("SELECT COUNT(*) FROM acc_statement_lines WHERE status = 'open'")) })}${ui.kpi({ label: tr('acc|Not yet on a statement'), value: fmt(r2(banks.reduce((s, b) => s + L.bankSummary(b).inTransit, 0))), sub: esc(tr('acc|Booked, waiting for the bank')) })}</div>
<div class="grid grid--side"><div class="acc-banks">${cards || ui.empty(tr('acc|No bank accounts yet. Add the mall’s accounts to reconcile them.'))}</div>${ui.card(tr('acc|New bank or cash account'), form, { sub: esc(tr('acc|It gets its own account in the chart, under Cash and banks.')) })}</div>`;
    page(req, res, { tab: 'banking', title: tr('acc|Banking'), body });
  });
  router.post('/accounting/banking', RF, (req, res) => {
    const b = req.body;
    try {
      const bank = L.createBank({ name: h.str(b.name, 120), name_ar: h.str(b.name_ar, 120), bank: h.str(b.bank, 120) || null, iban: h.str(b.iban, 40).replace(/\s+/g, '') || null, opening_balance: num(b.opening_balance), opening_date: isDate(b.opening_date) ? b.opening_date : today(), kind: b.kind === 'cash' ? 'cash' : 'bank', user: req.user });
      h.log(req, 'Added a bank account', 'bank', bank.id, bank.name);
      h.back(req, res, `/admin/accounting/banking/${bank.id}`, 'ok', tr('acc|Account added.'));
    } catch (err) {
      h.back(req, res, '/admin/accounting/banking', 'error', errText(err));
    }
  });
  router.get('/accounting/banking/:id', RF, (req, res, next) => {
    const bank = bankOf(req.params.id);
    if (!bank) return next();
    const csrf = req.session.csrf;
    const a = L.byId(bank.account_id);
    const s = L.bankSummary(bank);
    const open = db.all("SELECT * FROM acc_statement_lines WHERE bank_id = ? AND status = 'open' ORDER BY date, id LIMIT 200", bank.id);
    const postTo = accOptions((x) => x.id !== bank.account_id);
    const openRows = open.map((l) => {
      const c = L.candidates(l, bank).slice(0, 3);
      const sugg = c.length
        ? c.map((x) => ui.form(`/admin/accounting/banking/${bank.id}/lines/${l.id}/match`, csrf, `<input type="hidden" name="line" value="${x.id}"><button class="acc-cand" type="submit" title="${esc(tr('acc|Match'))}">${ui.icon('check')}<span><bdi>${esc(x.ref)}</bdi> · ${ui.date(x.date)}<small>${esc(tx(x.entry_memo) || '')}</small></span></button>`)).join('')
        : `<span class="muted small">${esc(tr('acc|Nothing in the books matches.'))}</span>`;
      const post = `<details class="pop pop--end"><summary class="btn btn--ghost btn--xs">${esc(tr('acc|Post'))}</summary>${ui.form(`/admin/accounting/banking/${bank.id}/lines/${l.id}/post`, csrf, `${ui.select('account', tr('acc|Against account'), postTo, l.amount < 0 ? (L.byKey('exp_bank') || {}).id : '', { required: true })}${ui.input('memo', tr('acc|Description'), txt(l.description) || '')}${ui.btn(esc(tr('acc|Post and match')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>`;
      const ignore = ui.form(`/admin/accounting/banking/${bank.id}/lines/${l.id}/ignore`, csrf, ui.btn(esc(tr('acc|Ignore')), { cls: 'btn--ghost btn--xs', attrs: { title: tr('acc|Not for the books (a duplicate or a transfer already recorded)') } }));
      return `<tr><td data-label="${esc(tr('acc|Date'))}">${ui.date(l.date)}</td><td data-label="${esc(tr('acc|Description'))}">${esc(txt(l.description) || '')}${l.reference ? sub(`<bdi>${esc(l.reference)}</bdi>`) : ''}</td><td class="num" data-label="${esc(tr('acc|Amount'))}"><b class="${l.amount < 0 ? 'down' : 'up'}">${fmt(l.amount)}</b></td><td data-label="${esc(tr('acc|In the books'))}"><div class="acc-cands">${sugg}</div></td><td class="acc-acts">${post}${ignore}</td></tr>`;
    }).join('');
    const openTable = open.length
      ? `<div class="tablewrap"><table class="table table--fin table--resp acc-rec"><thead><tr><th>${esc(tr('acc|Date'))}</th><th>${esc(tr('acc|Description'))}</th><th class="num">${esc(tr('acc|Amount'))}</th><th>${esc(tr('acc|In the books'))}</th><th></th></tr></thead><tbody>${openRows}</tbody></table></div>`
      : ui.empty(s.lines ? tr('acc|Every statement line is matched.') : tr('acc|Import a statement to start reconciling.'));
    const unmatched = L.unmatchedLedger(bank).slice(-50);
    const unTable = ui.table([
      { label: tr('acc|Date'), render: (l) => ui.date(l.date) },
      { label: tr('acc|Entry'), render: (l) => `<a href="/admin/accounting/journal/${l.entry_id}"><bdi>${esc(l.ref)}</bdi></a>${sub(esc(tx(l.entry_memo) || ''))}` },
      { label: tr('acc|Amount'), num: true, render: (l) => fmt(l.debit - l.credit) },
    ], unmatched, { empty: esc(tr('acc|Everything in the books is on a statement.')) });
    const matched = db.all("SELECT s.*, e.ref, e.id entry_id FROM acc_statement_lines s LEFT JOIN acc_lines l ON l.id = s.matched_line_id LEFT JOIN acc_entries e ON e.id = l.entry_id WHERE s.bank_id = ? AND s.status IN ('matched','ignored') ORDER BY s.date DESC, s.id DESC LIMIT 30", bank.id);
    const doneTable = ui.table([
      { label: tr('acc|Date'), render: (l) => ui.date(l.date) },
      { label: tr('acc|Description'), render: (l) => esc(txt(l.description) || '') },
      { label: tr('acc|Amount'), num: true, render: (l) => fmt(l.amount) },
      { label: tr('acc|Status'), render: (l) => (l.status === 'ignored' ? ui.badge('void', tr('acc|Ignored'), 'mute') : `<a href="/admin/accounting/journal/${l.entry_id}"><bdi>${esc(l.ref || '')}</bdi></a>`) },
      { label: '', render: (l) => ui.form(`/admin/accounting/banking/${bank.id}/lines/${l.id}/${l.status === 'ignored' ? 'restore' : 'unmatch'}`, csrf, ui.btn(esc(l.status === 'ignored' ? tr('acc|Restore') : tr('acc|Unmatch')), { cls: 'btn--ghost btn--xs' })) },
    ], matched, { empty: esc(tr('acc|Nothing matched yet.')) });
    const imp = ui.form(`/admin/accounting/banking/${bank.id}/import`, csrf, `
      <label class="drop drop--sm"><input type="file" accept=".csv,.txt,text/csv" data-csv-into="statement">${ui.icon('upload')}<span>${esc(tr('acc|Choose the bank’s CSV export'))}</span><small>${esc(tr('acc|Date, description, reference and amount (or debit and credit) columns; English or Arabic headers'))}</small></label>
      ${ui.textarea('statement', tr('acc|Or paste the statement'), '', { rows: 5, placeholder: 'Date,Description,Reference,Amount' })}
      <input type="hidden" name="file_name" value="" data-csv-name>
      ${ui.btn(esc(tr('acc|Import')), { cls: 'btn--primary btn--sm', ic: 'upload' })}`, { cls: 'stack' });
    const diffOk = Math.abs(s.difference) < 0.01;
    const kpis = [
      ui.kpi({ label: tr('acc|In the books'), value: fmt(s.book), sub: `<bdi>${esc(a.code)}</bdi>` }),
      ui.kpi({ label: tr('acc|On the statement'), value: fmt(s.statement), sub: esc(s.last ? tr('acc|To {date}', { date: ui.date(s.last.date) }) : tr('acc|No statement yet')) }),
      ui.kpi({ label: tr('acc|Booked, not on the statement'), value: fmt(s.inTransit), sub: esc(tn(s.unmatchedLedger, 'acc|{n} ledger line', 'acc|{n} ledger lines')) }),
      ui.kpi({ label: tr('acc|On the statement, not booked'), value: fmt(s.openAmt), sub: esc(tn(s.open, 'acc|{n} line to reconcile', 'acc|{n} lines to reconcile')), tone: s.open ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('acc|Difference'), value: diffOk ? `<span class="up">${fmt(0)}</span>` : `<span class="down">${fmt(s.difference)}</span>`, sub: esc(diffOk ? tr('acc|Statement and books agree') : tr('acc|Check the opening balance and the lines')) }),
    ].join('');
    const acts = `${ui.form(`/admin/accounting/banking/${bank.id}/auto`, csrf, ui.btn(esc(tr('acc|Match automatically')), { cls: 'btn--primary', ic: 'check' }))}${ui.btn(esc(tr('acc|Ledger')), { href: `/admin/accounting/accounts/${a.id}`, cls: 'btn--ghost' })}`;
    const body = `<div class="kpis kpis--5">${kpis}</div>
<div class="grid grid--side"><div class="stack">${ui.card(tr('acc|Statement lines to match'), openTable, { sub: esc(tr('acc|Same amount within 10 days is suggested; a matching reference ranks first.')) })}${ui.card(tr('acc|In the books, not yet on a statement'), unTable)}${ui.card(tr('acc|Matched and ignored'), doneTable)}</div>
<div class="stack">${ui.card(tr('acc|Import a statement'), imp, { sub: esc(tr('acc|Lines already imported are skipped.')) })}${ui.card(tr('acc|Account'), `<dl class="dl"><div><dt>${esc(tr('acc|Bank'))}</dt><dd>${esc(bank.bank || '—')}</dd></div><div><dt>${esc(tr('acc|IBAN'))}</dt><dd><bdi>${esc(bank.iban || '—')}</bdi></dd></div><div><dt>${esc(tr('acc|Opening balance'))}</dt><dd>${fmt(bank.opening_balance)} · ${ui.date(bank.opening_date)}</dd></div></dl>`)}</div></div>`;
    page(req, res, { tab: 'banking', title: L.name(a), crumbs: [['/admin/accounting/banking', tr('acc|Banking')]], body, actions: acts });
  });
  const bankAction = (path, fn) => router.post(`/accounting/banking/:id/${path}`, RF, (req, res, next) => {
    const bank = bankOf(req.params.id);
    if (!bank) return next();
    const back = `/admin/accounting/banking/${bank.id}`;
    try {
      const msg = fn(bank, req);
      h.back(req, res, back, 'ok', msg);
    } catch (err) {
      h.back(req, res, back, 'error', errText(err));
    }
  });
  const stLine = (bank, id) => {
    const l = /^\d+$/.test(String(id)) ? db.get('SELECT * FROM acc_statement_lines WHERE id = ? AND bank_id = ?', Number(id), bank.id) : null;
    if (!l) throw new Error('That statement line no longer exists.');
    return l;
  };
  bankAction('import', (bank, req) => {
    const r = L.importStatement(bank.id, String(req.body.statement || '').slice(0, 2000000), { file_name: h.str(req.body.file_name, 160) || null, user: req.user });
    if (!r.added && !r.skipped) throw new Error(r.errors.includes('headers') ? 'The statement needs a date column and an amount (or debit and credit) column.' : 'No lines could be read from that statement.');
    h.log(req, 'Imported a bank statement', 'bank', bank.id, `${r.added} lines`);
    const auto = L.autoMatch(bank.id);
    return tr('acc|{added} lines imported, {skipped} already there, {auto} matched automatically.', { added: r.added, skipped: r.skipped, auto });
  });
  bankAction('auto', (bank, req) => {
    const n = L.autoMatch(bank.id);
    if (n) h.log(req, 'Reconciled bank lines', 'bank', bank.id, `${n} automatic`);
    return n ? tn(n, 'acc|{n} line matched.', 'acc|{n} lines matched.') : tr('acc|Nothing more could be matched automatically.');
  });
  bankAction('lines/:line/match', (bank, req) => {
    const l = stLine(bank, req.params.line);
    L.match(l.id, h.int(req.body.line));
    h.log(req, 'Reconciled bank lines', 'bank', bank.id, `line ${l.id}`);
    return tr('acc|Matched.');
  });
  bankAction('lines/:line/unmatch', (bank, req) => {
    const l = stLine(bank, req.params.line);
    db.run("UPDATE acc_statement_lines SET matched_line_id = NULL, status = 'open' WHERE id = ?", l.id);
    return tr('acc|Unmatched.');
  });
  bankAction('lines/:line/ignore', (bank, req) => {
    const l = stLine(bank, req.params.line);
    db.run("UPDATE acc_statement_lines SET status = 'ignored', matched_line_id = NULL WHERE id = ?", l.id);
    return tr('acc|Line ignored.');
  });
  bankAction('lines/:line/restore', (bank, req) => {
    const l = stLine(bank, req.params.line);
    db.run("UPDATE acc_statement_lines SET status = 'open' WHERE id = ?", l.id);
    return tr('acc|Line restored.');
  });
  bankAction('lines/:line/post', (bank, req) => {
    const l = stLine(bank, req.params.line);
    const acc = L.byId(h.int(req.body.account));
    if (!acc || acc.is_group) throw new Error('Choose the account.');
    const e = L.postFromLine(l.id, acc.id, { memo: h.str(req.body.memo, 200) || l.description || null, user: req.user });
    h.log(req, 'Posted a journal entry', 'journal', e.id, e.ref);
    return tr('acc|Entry {ref} posted.', { ref: e.ref });
  });

  // =====================================================================================
  // Fixed assets
  // =====================================================================================
  const assetOf = (id) => (/^\d+$/.test(String(id)) ? db.get('SELECT * FROM acc_assets WHERE id = ?', Number(id)) : null);
  router.get('/accounting/assets', RF, (req, res) => {
    const t = today();
    const fy = L.fiscalYear(t);
    const list = db.all('SELECT * FROM acc_assets ORDER BY status, acquired_on, id').map((a) => ({ ...a, acc: L.depreciated(a.id) }));
    const live = list.filter((a) => a.status === 'active');
    const cost = r2(live.reduce((s, a) => s + a.cost, 0));
    const accum = r2(live.reduce((s, a) => s + a.acc, 0));
    const yearDep = r2(db.value('SELECT COALESCE(SUM(amount),0) FROM acc_depreciation WHERE period >= ? AND period <= ?', fy.from.slice(0, 7), fy.to.slice(0, 7)));
    const kpis = [
      ui.kpi({ label: tr('acc|Cost'), value: fmt(cost), sub: esc(tn(live.length, 'acc|{n} asset in use', 'acc|{n} assets in use')) }),
      ui.kpi({ label: tr('acc|Accumulated depreciation'), value: fmt(accum) }),
      ui.kpi({ label: tr('acc|Net book value'), value: fmt(r2(cost - accum)), bar: cost ? (cost - accum) / cost : 0 }),
      ui.kpi({ label: tr('acc|Depreciation this year'), value: fmt(yearDep), sub: esc(fyLabel(fy)) }),
    ].join('');
    const table = ui.table([
      { label: tr('acc|Asset'), render: (a) => `<b>${esc(txt(a.name))}</b>${sub(`<bdi>${esc(a.ref)}</bdi>${a.location ? ` · ${esc(txt(a.location))}` : ''}`)}` },
      { label: tr('acc|Class'), render: (a) => esc(lbl(ASSET_CLASSES, a.class)) },
      { label: tr('acc|Acquired'), render: (a) => ui.date(a.acquired_on) },
      { label: tr('acc|Cost'), num: true, render: (a) => fmt(a.cost) },
      { label: tr('acc|Depreciated'), num: true, render: (a) => amt(a.acc) },
      { label: tr('acc|Book value'), num: true, render: (a) => (a.status === 'active' ? fmt(a.cost - a.acc) : '—') },
      { label: tr('acc|Life used'), render: (a) => (a.status === 'active' ? ui.meter((a.cost - a.residual) ? a.acc / (a.cost - a.residual) : 1) : ui.badge('void', tr('acc|Disposed'), 'mute')) },
    ], list, { empty: esc(tr('acc|No fixed assets registered yet.')), href: (a) => `/admin/accounting/assets/${a.id}` });
    const csrf = req.session.csrf;
    const prevMonth = L.addMonthsYM(t.slice(0, 7), -1);
    const run = ui.form('/admin/accounting/assets/depreciate', csrf, `${ui.input('month', tr('acc|Up to the month of'), prevMonth, { type: 'month', required: true })}${ui.btn(esc(tr('acc|Post depreciation')), { cls: 'btn--primary btn--sm' })}<p class="hint muted">${esc(tr('acc|Straight line, month by month; months already posted are skipped and any gap is caught up.'))}</p>`, { cls: 'stack' });
    const add = ui.form('/admin/accounting/assets', csrf, `<div class="fields">
      ${ui.input('name', tr('acc|Asset name'), '', { required: true, cls: 'span-all' })}
      ${ui.select('class', tr('acc|Class'), Object.keys(ASSET_CLASSES).map((k) => [k, `${lbl(ASSET_CLASSES, k)} · ${tn(L.ASSET_CLASSES[k][2] / 12, 'acc|{n} year', 'acc|{n} years')}`]), 'mep')}
      ${ui.input('cost', tr('acc|Cost'), '', { type: 'number', step: '0.01', min: '0.01', required: true })}
      ${ui.input('acquired_on', tr('acc|Acquired on'), t, { type: 'date', required: true })}
      ${ui.input('life_months', tr('acc|Useful life (months)'), '', { type: 'number', min: 1, max: 1200, hint: tr('acc|Empty: the class default') })}
      ${ui.input('residual', tr('acc|Residual value'), '', { type: 'number', step: '0.01', min: 0 })}
      ${ui.input('location', tr('acc|Location'), '')}
      ${ui.select('pay_from', tr('acc|Paid from'), cashOptions(), '', { blank: tr('acc|Already in the books (no entry)') })}
    </div>${ui.btn(esc(tr('acc|Register asset')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    const body = `<div class="kpis kpis--4">${kpis}</div><div class="grid grid--side">${ui.card(tr('acc|Fixed asset register'), table)}<div class="stack">${ui.card(tr('acc|Monthly depreciation'), run)}${ui.card(tr('acc|New asset'), add)}</div></div>`;
    page(req, res, { tab: 'assets', title: tr('acc|Assets'), body });
  });
  router.post('/accounting/assets', RF, (req, res) => {
    const b = req.body;
    try {
      const payFrom = h.int(b.pay_from) && L.byId(h.int(b.pay_from)) ? h.int(b.pay_from) : null;
      const a = L.createAsset({ name: h.str(b.name, 160), class: b.class, cost: num(b.cost), acquired_on: b.acquired_on, life_months: h.int(b.life_months), residual: num(b.residual), location: h.str(b.location, 120) || null, pay_from: payFrom, user: req.user });
      h.log(req, 'Added an asset', 'asset', a.id, `${a.ref} ${a.name}`);
      h.back(req, res, `/admin/accounting/assets/${a.id}`, 'ok', tr('acc|Asset {ref} registered.', { ref: a.ref }));
    } catch (err) {
      h.back(req, res, '/admin/accounting/assets', 'error', errText(err));
    }
  });
  router.post('/accounting/assets/depreciate', RF, (req, res) => {
    try {
      const n = L.runDepreciation(String(req.body.month || ''), { user: req.user });
      h.log(req, 'Ran depreciation', 'asset', null, `${req.body.month}: ${n}`);
      h.back(req, res, '/admin/accounting/assets', 'ok', n ? tn(n, 'acc|{n} depreciation entry posted.', 'acc|{n} depreciation entries posted.') : tr('acc|Depreciation was already posted up to that month.'));
    } catch (err) {
      h.back(req, res, '/admin/accounting/assets', 'error', errText(err));
    }
  });
  router.get('/accounting/assets/:id', RF, (req, res, next) => {
    const a = assetOf(req.params.id);
    if (!a) return next();
    const rows = db.all('SELECT d.*, e.ref FROM acc_depreciation d LEFT JOIN acc_entries e ON e.id = d.entry_id WHERE d.asset_id = ? ORDER BY d.period', a.id);
    let acc = 0;
    const sched = rows.map((r) => { acc = r2(acc + r.amount); return { ...r, acc, nbv: r2(a.cost - acc), done: true }; });
    if (a.status === 'active') {
      let p = sched.length ? L.addMonthsYM(sched[sched.length - 1].period, 1) : a.acquired_on.slice(0, 7);
      for (let k = 0; k < 6 && acc < a.cost - a.residual - 0.004; k++, p = L.addMonthsYM(p, 1)) {
        const amount = r2(Math.min(L.assetMonthly(a), a.cost - a.residual - acc));
        acc = r2(acc + amount);
        sched.push({ period: p, amount, acc, nbv: r2(a.cost - acc), done: false });
      }
    }
    const table = ui.table([
      { label: tr('acc|Month'), render: (r) => `${esc(ui.monthYear(r.period))}${r.done ? '' : sub(esc(tr('acc|Planned')))}` },
      { label: tr('acc|Depreciation'), num: true, render: (r) => fmt(r.amount) },
      { label: tr('acc|Accumulated'), num: true, render: (r) => fmt(r.acc) },
      { label: tr('acc|Book value'), num: true, render: (r) => fmt(r.nbv) },
      { label: tr('acc|Entry'), render: (r) => (r.entry_id ? `<a href="/admin/accounting/journal/${r.entry_id}"><bdi>${esc(r.ref)}</bdi></a>` : '') },
    ], sched.slice(-36), { empty: esc(tr('acc|No depreciation yet.')), cls: 'acc-sched' });
    const done = L.depreciated(a.id);
    const dl = `<dl class="dl">
      <div><dt>${esc(tr('acc|Class'))}</dt><dd>${esc(lbl(ASSET_CLASSES, a.class))}</dd></div>
      <div><dt>${esc(tr('acc|Acquired on'))}</dt><dd>${ui.date(a.acquired_on)}</dd></div>
      <div><dt>${esc(tr('acc|Cost'))}</dt><dd>${fmt(a.cost)}</dd></div>
      <div><dt>${esc(tr('acc|Useful life'))}</dt><dd>${esc(tn(a.life_months, 'acc|{n} month', 'acc|{n} months'))} · ${esc(tr('acc|{amount} a month', { amount: fmt(L.assetMonthly(a)) }))}</dd></div>
      <div><dt>${esc(tr('acc|Residual value'))}</dt><dd>${amt(a.residual)}</dd></div>
      <div><dt>${esc(tr('acc|Depreciated'))}</dt><dd>${fmt(done)}</dd></div>
      <div><dt>${esc(tr('acc|Book value'))}</dt><dd><b>${fmt(a.cost - done)}</b></dd></div>
      ${a.location ? `<div><dt>${esc(tr('acc|Location'))}</dt><dd>${esc(txt(a.location))}</dd></div>` : ''}
      ${a.status === 'disposed' ? `<div><dt>${esc(tr('acc|Disposed'))}</dt><dd>${ui.date(a.disposed_on)} · ${fmt(a.proceeds || 0)}</dd></div>` : ''}
    </dl>`;
    const dispose = a.status === 'active'
      ? pop(tr('acc|Dispose'), ui.form(`/admin/accounting/assets/${a.id}/dispose`, req.session.csrf, `${ui.input('date', tr('acc|Date'), L.firstOpen(today()), { type: 'date', required: true })}${ui.input('proceeds', tr('acc|Sale proceeds'), '0', { type: 'number', step: '0.01', min: 0 })}${ui.select('account', tr('acc|Received into'), cashOptions(), '')}${ui.btn(esc(tr('acc|Dispose of the asset')), { cls: 'btn--primary btn--sm', attrs: { 'data-confirm': tr('acc|Remove {name} from the register and post the gain or loss?', { name: txt(a.name) }) } })}`, { cls: 'stack' }), { align: 'pop--end' })
      : '';
    const body = `<div class="grid grid--side">${ui.card(tr('acc|Depreciation schedule'), table, { sub: esc(tr('acc|Posted months, then the next six planned')) })}${ui.card(tr('acc|Details'), dl)}</div>`;
    page(req, res, { tab: 'assets', title: txt(a.name), crumbs: [['/admin/accounting/assets', tr('acc|Assets')]], body, actions: dispose });
  });
  router.post('/accounting/assets/:id/dispose', RF, (req, res, next) => {
    const a = assetOf(req.params.id);
    if (!a) return next();
    try {
      const acc = L.byId(h.int(req.body.account));
      const r = L.disposeAsset(a.id, { date: req.body.date, proceeds: num(req.body.proceeds), account: acc && acc.sub === 'cash' ? acc.id : null, user: req.user });
      h.log(req, 'Disposed of an asset', 'asset', a.id, `${a.ref} ${r.gain >= 0 ? 'gain' : 'loss'} ${Math.abs(r.gain)}`);
      h.back(req, res, `/admin/accounting/assets/${a.id}`, 'ok', r.gain >= 0 ? tr('acc|Disposed with a gain of {amount}.', { amount: fmt(r.gain) }) : tr('acc|Disposed with a loss of {amount}.', { amount: fmt(-r.gain) }));
    } catch (err) {
      h.back(req, res, `/admin/accounting/assets/${a.id}`, 'error', errText(err));
    }
  });

  // =====================================================================================
  // Budgets
  // =====================================================================================
  const fyMonths = (fy) => Array.from({ length: 12 }, (_, i) => L.addMonthsYM(fy.from.slice(0, 7), i));
  const fyOf = (req) => {
    const y = h.int(req.query.year ?? req.body.year);
    const cur = L.fiscalYear(today());
    return y && y > 2000 && y < 2100 ? L.fiscalYear(`${y}-${String(L.fyStart()).padStart(2, '0')}-01`) : cur;
  };
  router.get('/accounting/budgets', RF, (req, res) => {
    const fy = fyOf(req);
    const months = fyMonths(fy);
    const accs = L.accounts({ postable: true, activeOnly: true }).filter((a) => ['income', 'expense'].includes(a.type));
    const saved = {};
    for (const r of db.all('SELECT * FROM acc_budgets WHERE period >= ? AND period <= ?', months[0], months[11])) saved[`${r.account_id}_${r.period}`] = r.amount;
    const t = today();
    const toYM = t.slice(0, 7) < months[0] ? null : t.slice(0, 7) > months[11] ? months[11] : t.slice(0, 7);
    const actual = toYM ? L.profitLoss({ from: fy.from, to: L.monthEnd(toYM) }) : { income: [], expense: [] };
    const act = Object.fromEntries([...actual.income, ...actual.expense].map((r) => [r.id, r.amount]));
    const grid = `<div class="tablewrap acc-budget"><table class="table table--fin"><thead><tr><th>${esc(tr('acc|Account'))}</th>${months.map((m) => `<th class="num">${esc(ui.monthName(Number(m.slice(5))))}</th>`).join('')}<th class="num">${esc(tr('acc|Year'))}</th></tr></thead><tbody>
      ${['income', 'expense'].map((type) => `<tr class="is-head"><td colspan="14"><b>${esc(type === 'income' ? tr('acc|Income') : tr('acc|Expenses'))}</b></td></tr>${accs.filter((a) => a.type === type).map((a) => `<tr><td><bdi>${esc(a.code)}</bdi> ${esc(L.name(a))}</td>${months.map((m) => `<td class="num"><input class="cellin cellin--sm" type="number" step="1" min="0" name="b_${a.id}_${m}" value="${saved[`${a.id}_${m}`] ? Math.round(saved[`${a.id}_${m}`]) : ''}" aria-label="${esc(`${L.name(a)} · ${ui.monthYear(m)}`)}" data-bud="${a.id}"></td>`).join('')}<td class="num" data-bud-total="${a.id}">${fmt(r2(months.reduce((s, m) => s + (saved[`${a.id}_${m}`] || 0), 0)))}</td></tr>`).join('')}`).join('')}
    </tbody></table></div>`;
    const csrf = req.session.csrf;
    const form = ui.form('/admin/accounting/budgets', csrf, `<input type="hidden" name="year" value="${fy.year}">${grid}<div class="row">${ui.btn(esc(tr('acc|Save budget')), { cls: 'btn--primary' })}</div>`, { cls: 'stack' });
    const copy = pop(tr('acc|Start from last year'), ui.form('/admin/accounting/budgets/copy', csrf, `<input type="hidden" name="year" value="${fy.year}">${ui.input('pct', tr('acc|Change against last year’s actuals (%)'), '10', { type: 'number', step: '0.1' })}${ui.btn(esc(tr('acc|Fill the budget')), { cls: 'btn--primary btn--sm', attrs: { 'data-confirm': tr('acc|Replace this year’s budget with last year’s actuals adjusted?') } })}`, { cls: 'stack' }), { align: 'pop--end' });
    // budget against actual, year to date
    const ytd = toYM ? months.filter((m) => m <= toYM) : [];
    const bva = accs.map((a) => {
      const b = r2(ytd.reduce((s, m) => s + (saved[`${a.id}_${m}`] || 0), 0));
      const year = r2(months.reduce((s, m) => s + (saved[`${a.id}_${m}`] || 0), 0));
      const x = act[a.id] || 0;
      return { a, b, year, x, v: r2(a.type === 'income' ? x - b : b - x) };
    }).filter((r) => r.b || r.x || r.year);
    const totalOf = (type, k) => r2(bva.filter((r) => r.a.type === type).reduce((s, r) => s + r[k], 0));
    const bvaRep = {
      cols: [C(tr('acc|Account')), C(tr('acc|Budget for the year'), true), C(tr('acc|Budget to date'), true), C(tr('acc|Actual to date'), true), C(tr('acc|Better or worse'), true), C(tr('acc|Used'))],
      rows: [
        ...['income', 'expense'].flatMap((type) => [
          ...bva.filter((r) => r.a.type === type).map((r) => ({ href: `/admin/accounting/accounts/${r.a.id}`, cells: [`${r.a.code} · ${L.name(r.a)}`, r.year, r.b, r.x, { html: `<span class="${r.v >= 0 ? 'up' : 'down'}">${fmt(r.v)}</span>`, text: r.v }, { html: r.b ? ui.meter(r.x / r.b, r.a.type === 'expense' && r.x > r.b ? 'rose' : 'forest') : '', text: r.b ? Math.round((r.x / r.b) * 100) : '' }] })),
          { cls: 'is-total', cells: [type === 'income' ? tr('acc|Total income') : tr('acc|Total expenses'), totalOf(type, 'year'), totalOf(type, 'b'), totalOf(type, 'x'), r2(type === 'income' ? totalOf(type, 'x') - totalOf(type, 'b') : totalOf(type, 'b') - totalOf(type, 'x')), ''] },
        ]),
      ],
    };
    const curYear = L.fiscalYear(t).year;
    const years = [curYear - 1, curYear, curYear + 1];
    const yearNav = `<nav class="tabs tabs--sub">${years.map((y) => `<a class="tab${y === fy.year ? ' is-on' : ''}" href="/admin/accounting/budgets?year=${y}">${esc(L.fiscalYear(`${y}-${String(L.fyStart()).padStart(2, '0')}-01`).label)}</a>`).join('')}</nav>`;
    const body = `${yearNav}${ui.card(tr('acc|Budget against actual'), bva.length ? reportHtml(bvaRep) : ui.empty(tr('acc|No budget for this year yet. Fill in the grid below, or start from last year.')), { sub: esc(toYM ? tr('acc|To the end of {month}', { month: ui.monthYear(toYM) }) : tr('acc|The year has not started')) })}
<div class="spacer"></div>${ui.card(tr('acc|Monthly budget'), form, { sub: esc(fyLabel(fy)), action: copy })}`;
    page(req, res, { tab: 'budgets', title: tr('acc|Budgets'), body });
  });
  router.post('/accounting/budgets', RF, (req, res) => {
    const fy = fyOf(req);
    const months = new Set(fyMonths(fy));
    const valid = new Set(L.accounts({ postable: true }).filter((a) => ['income', 'expense'].includes(a.type)).map((a) => a.id));
    db.tx(() => {
      for (const [k, v] of Object.entries(req.body)) {
        const m = k.match(/^b_(\d+)_(\d{4}-\d{2})$/);
        if (!m || !valid.has(Number(m[1])) || !months.has(m[2])) continue;
        const n = num(v);
        if (n > 0) db.run('INSERT INTO acc_budgets (period, account_id, amount) VALUES (?, ?, ?) ON CONFLICT(period, account_id) DO UPDATE SET amount = excluded.amount', m[2], Number(m[1]), n);
        else db.run('DELETE FROM acc_budgets WHERE period = ? AND account_id = ?', m[2], Number(m[1]));
      }
    });
    h.log(req, 'Saved the budget', 'budget', null, fy.label);
    h.back(req, res, `/admin/accounting/budgets?year=${fy.year}`, 'ok', tr('acc|Budget saved.'));
  });
  router.post('/accounting/budgets/copy', RF, (req, res) => {
    const fy = fyOf(req);
    const pct = num(req.body.pct);
    const months = fyMonths(fy);
    db.tx(() => {
      for (const m of months) {
        const prev = L.addMonthsYM(m, -12);
        const pl = L.profitLoss({ from: `${prev}-01`, to: L.monthEnd(prev) });
        db.run('DELETE FROM acc_budgets WHERE period = ?', m);
        for (const r of [...pl.income, ...pl.expense]) {
          const v = Math.round(r.amount * (1 + pct / 100));
          if (v > 0) db.run('INSERT INTO acc_budgets (period, account_id, amount) VALUES (?, ?, ?)', m, r.id, v);
        }
      }
    });
    h.log(req, 'Saved the budget', 'budget', null, `${fy.label} from last year`);
    h.back(req, res, `/admin/accounting/budgets?year=${fy.year}`, 'ok', tr('acc|Budget filled from last year’s actuals.'));
  });

  // =====================================================================================
  // Reports
  // =====================================================================================
  const shiftYear = (iso, n) => {
    const y = Number(iso.slice(0, 4)) + n;
    const md = iso.slice(5);
    return md === '02-29' ? `${y}-02-28` : `${y}-${md}`;
  };
  function repTB(q) {
    const tb = L.trialBalance(q);
    const rows = tb.rows.map((r) => ({
      href: accHref(r.id, q),
      cells: [r.code, L.name(r), Math.max(0, r.openNet), Math.max(0, -r.openNet), r.md, r.mc, Math.max(0, r.closeNet), Math.max(0, -r.closeNet)],
    }));
    if (rows.length) rows.push({ cls: 'is-total', cells: [tr('acc|Total'), '', tb.tot.od, tb.tot.oc, tb.tot.md, tb.tot.mc, tb.tot.cd, tb.tot.cc] });
    return {
      cols: [C(tr('acc|Code')), C(tr('acc|Account')), C(tr('acc|Opening debit'), true), C(tr('acc|Opening credit'), true), C(tr('acc|Debit'), true), C(tr('acc|Credit'), true), C(tr('acc|Closing debit'), true), C(tr('acc|Closing credit'), true)],
      rows, ok: tb.balanced, okText: tb.balanced ? tr('acc|Debits equal credits.') : tr('acc|Debits and credits differ: check the journal.'),
    };
  }
  function repPL(q) {
    if (q.view === 'monthly') {
      const months = [];
      for (let m = q.from.slice(0, 7); m <= q.to.slice(0, 7) && months.length < 12; m = L.addMonthsYM(m, 1)) months.push(m);
      const per = months.map((m) => L.profitLoss({ from: m === q.from.slice(0, 7) ? q.from : `${m}-01`, to: m === q.to.slice(0, 7) ? q.to : L.monthEnd(m) }));
      const total = L.profitLoss({ from: q.from, to: L.monthEnd(months[months.length - 1]) < q.to ? L.monthEnd(months[months.length - 1]) : q.to });
      const line = (type) => {
        const ids = [...new Set(per.flatMap((p) => p[type].map((r) => r.id)))];
        return L.accounts({ postable: true, type: type === 'income' ? 'income' : 'expense' }).filter((a) => ids.includes(a.id)).map((a) => ({ href: accHref(a.id, q), cells: [`${a.code} · ${L.name(a)}`, ...per.map((p) => (p[type].find((r) => r.id === a.id) || { amount: 0 }).amount), (total[type].find((r) => r.id === a.id) || { amount: 0 }).amount] }));
      };
      return {
        cols: [C(tr('acc|Account')), ...months.map((m) => C(`${ui.monthName(Number(m.slice(5)))} ${m.slice(2, 4)}`, true)), C(tr('acc|Total'), true)],
        rows: [
          { cls: 'is-head', cells: [tr('acc|Income')] }, ...line('income'),
          { cls: 'is-total', cells: [tr('acc|Total income'), ...per.map((p) => p.totalIncome), total.totalIncome] },
          { cls: 'is-head', cells: [tr('acc|Expenses')] }, ...line('expense'),
          { cls: 'is-total', cells: [tr('acc|Total expenses'), ...per.map((p) => p.totalExpense), total.totalExpense] },
          { cls: 'is-grand', cells: [tr('acc|Net result'), ...per.map((p) => p.result), total.result] },
        ],
      };
    }
    const cur = L.profitLoss(q);
    let cmp = null;
    let cmpLabel = '';
    if (q.compare === 'budget') {
      const b = L.budget(q.from, q.to);
      const mk = (type) => L.accounts({ postable: true, type }).map((a) => ({ ...a, amount: b[a.id] || 0 })).filter((r) => r.amount);
      const income = mk('income');
      const expense = mk('expense');
      const ti = r2(income.reduce((s, r) => s + r.amount, 0));
      const te = r2(expense.reduce((s, r) => s + r.amount, 0));
      cmp = { income, expense, totalIncome: ti, totalExpense: te, result: r2(ti - te) };
      cmpLabel = tr('acc|Budget');
    } else if (q.compare !== 'none') {
      cmp = L.profitLoss({ from: shiftYear(q.from, -1), to: shiftYear(q.to, -1) });
      cmpLabel = tr('acc|Last year');
    }
    const line = (type) => {
      const ids = [...new Set([...cur[type].map((r) => r.id), ...(cmp ? cmp[type].map((r) => r.id) : [])])];
      return L.accounts({ postable: true, type: type === 'income' ? 'income' : 'expense' }).filter((a) => ids.includes(a.id)).map((a) => {
        const x = (cur[type].find((r) => r.id === a.id) || { amount: 0 }).amount;
        const y = cmp ? (cmp[type].find((r) => r.id === a.id) || { amount: 0 }).amount : null;
        return { href: accHref(a.id, q), cells: [`${a.code} · ${L.name(a)}`, x, ...(cmp ? [y, r2(x - y), pctCell(x, y)] : []), pctOf(x, type === 'income' ? cur.totalIncome : cur.totalIncome)] };
      });
    };
    const totals = (label, x, y, cls) => ({ cls, cells: [label, x, ...(cmp ? [y, r2(x - y), pctCell(x, y)] : []), pctOf(x, cur.totalIncome)] });
    return {
      cols: [C(tr('acc|Account')), C(tr('acc|This period'), true), ...(cmp ? [C(cmpLabel, true), C(tr('acc|Change'), true), C(tr('acc|Change %'))] : []), C(tr('acc|% of income'))],
      rows: [
        { cls: 'is-head', cells: [tr('acc|Income')] }, ...line('income'),
        totals(tr('acc|Total income'), cur.totalIncome, cmp && cmp.totalIncome, 'is-total'),
        { cls: 'is-head', cells: [tr('acc|Expenses')] }, ...line('expense'),
        totals(tr('acc|Total expenses'), cur.totalExpense, cmp && cmp.totalExpense, 'is-total'),
        totals(tr('acc|Net result'), cur.result, cmp && cmp.result, 'is-grand'),
      ],
    };
  }
  const pctCell = (x, y) => (y ? { html: `<span class="${x >= y ? 'up' : 'down'}">${x >= y ? '▲' : '▼'} ${Math.abs(Math.round(((x - y) / Math.abs(y)) * 100))}%</span>`, text: `${Math.round(((x - y) / Math.abs(y)) * 100)}%` } : '');
  const pctOf = (x, total) => (total ? `${Math.round((x / total) * 1000) / 10}%` : '');
  function repBS(q) {
    const asOf = q.date;
    const cur = L.balanceSheet(asOf);
    const cmpDate = q.compare === 'none' ? null : L.addDays(L.fiscalYear(asOf).from, -1);
    const cmp = cmpDate ? L.balanceSheet(cmpDate) : null;
    const val = (list, id) => (list.find((r) => r.id === id) || { amount: 0 }).amount;
    const section = (key, title, totalLabel, total, cmpTotal) => {
      const ids = [...new Set([...cur[key].map((r) => r.id), ...(cmp ? cmp[key].map((r) => r.id) : [])])];
      const rows = L.accounts({ postable: true }).filter((a) => ids.includes(a.id)).map((a) => ({ href: `/admin/accounting/accounts/${a.id}`, cells: [`${a.code} · ${L.name(a)}`, val(cur[key], a.id), ...(cmp ? [val(cmp[key], a.id)] : [])] }));
      return [{ cls: 'is-head', cells: [title] }, ...rows, ...(key === 'equity' ? [
        { cells: [tr('acc|Result for the current year'), cur.currentResult, ...(cmp ? [cmp.currentResult] : [])] },
        ...(Math.abs(cur.earlierResult) > 0.004 || (cmp && Math.abs(cmp.earlierResult) > 0.004) ? [{ cells: [tr('acc|Earlier years, not yet closed'), cur.earlierResult, ...(cmp ? [cmp.earlierResult] : [])] }] : []),
      ] : []), { cls: 'is-total', cells: [totalLabel, total, ...(cmp ? [cmpTotal] : [])] }];
    };
    return {
      cols: [C(tr('acc|Account')), C(ui.date(asOf), true), ...(cmp ? [C(ui.date(cmpDate), true)] : [])],
      rows: [
        ...section('assets', tr('acc|Assets'), tr('acc|Total assets'), cur.totalAssets, cmp && cmp.totalAssets),
        ...section('liabilities', tr('acc|Liabilities'), tr('acc|Total liabilities'), cur.totalLiabilities, cmp && cmp.totalLiabilities),
        ...section('equity', tr('acc|Equity'), tr('acc|Total equity'), cur.totalEquity, cmp && cmp.totalEquity),
        { cls: 'is-grand', cells: [tr('acc|Total liabilities and equity'), r2(cur.totalLiabilities + cur.totalEquity), ...(cmp ? [r2(cmp.totalLiabilities + cmp.totalEquity)] : [])] },
      ],
      ok: cur.balanced, okText: cur.balanced ? tr('acc|Assets equal liabilities plus equity.') : tr('acc|The balance sheet does not balance: check the journal.'),
    };
  }
  function repCF(q) {
    const cf = L.cashFlow(q);
    const acc = (r) => ({ href: accHref(r.id, q), cells: [r.addback ? tr('acc|Add back: {name}', { name: L.name(r) }) : tr('acc|Change in {name}', { name: L.name(r) }), r.amount] });
    return {
      cols: [C(tr('acc|Item')), C(tr('acc|Amount'), true)],
      rows: [
        { cls: 'is-head', cells: [tr('acc|Operating activities')] },
        { cells: [tr('acc|Net result'), cf.result] },
        ...cf.lines.operating.map(acc),
        { cls: 'is-total', cells: [tr('acc|Cash from operations'), cf.operating] },
        { cls: 'is-head', cells: [tr('acc|Investing activities')] },
        ...cf.lines.investing.map(acc),
        { cls: 'is-total', cells: [tr('acc|Cash from investing'), cf.investing] },
        { cls: 'is-head', cells: [tr('acc|Financing activities')] },
        ...cf.lines.financing.map(acc),
        { cls: 'is-total', cells: [tr('acc|Cash from financing'), cf.financing] },
        { cls: 'is-grand', cells: [tr('acc|Net change in cash'), cf.change] },
        { cells: [tr('acc|Cash at the start'), cf.opening] },
        { cls: 'is-total', cells: [tr('acc|Cash at the end'), cf.closing] },
      ],
      ok: cf.ties, okText: cf.ties ? tr('acc|The cash flow ties to the movement on the bank and cash accounts.') : tr('acc|The cash flow does not tie: check the journal.'),
    };
  }
  function repVAT(q) {
    const v = L.vatSummary(q);
    const sales = db.get("SELECT COUNT(*) n, COALESCE(SUM(total - vat),0) net, COALESCE(SUM(vat),0) vat FROM invoices WHERE status != 'void' AND vat > 0 AND due_date >= ? AND due_date <= ?", q.from, q.to);
    const exempt = db.get("SELECT COALESCE(SUM(total),0) net FROM invoices WHERE status != 'void' AND vat = 0 AND kind NOT IN ('deposit','fitout') AND due_date >= ? AND due_date <= ?", q.from, q.to);
    const buys = db.get("SELECT COUNT(*) n, COALESCE(SUM(net),0) net, COALESCE(SUM(vat),0) vat FROM acc_bills WHERE status NOT IN ('draft','void') AND date >= ? AND date <= ?", q.from, q.to);
    return {
      cols: [C(tr('acc|Item')), C(tr('acc|Net amount'), true), C(tr('acc|VAT'), true)],
      rows: [
        { cls: 'is-head', cells: [tr('acc|Sales')] },
        { cells: [tn(sales.n, 'acc|{n} taxable invoice', 'acc|{n} taxable invoices'), r2(sales.net), r2(sales.vat)] },
        { cells: [tr('acc|Invoices without VAT'), r2(exempt.net), null] },
        { cls: 'is-total', cells: [tr('acc|Output VAT in the books'), null, v.output] },
        { cls: 'is-head', cells: [tr('acc|Purchases')] },
        { cells: [tn(buys.n, 'acc|{n} supplier bill', 'acc|{n} supplier bills'), r2(buys.net), r2(buys.vat)] },
        { cls: 'is-total', cells: [tr('acc|Input VAT in the books'), null, v.input] },
        { cls: 'is-grand', cells: [v.payable >= 0 ? tr('acc|VAT due to the Tax Authority') : tr('acc|VAT to carry forward'), null, Math.abs(v.payable)] },
      ],
      okText: tr('acc|Security and fit-out deposits carry no VAT. The VAT rate is set in Settings.'),
    };
  }
  function repJournal(q) {
    const entries = db.all('SELECT * FROM acc_entries WHERE date >= ? AND date <= ? ORDER BY date, id LIMIT 2000', q.from, q.to);
    const rows = [];
    for (const e of entries) {
      rows.push({ cls: 'is-head', href: `/admin/accounting/journal/${e.id}`, cells: [{ html: ui.date(e.date), text: e.date }, e.ref, tx(e.memo) || '', '', null, null] });
      for (const l of L.linesOf(e.id)) rows.push({ cells: ['', '', tx(l.memo) || '', `${l.code} · ${L.name(l)}`, l.debit, l.credit] });
    }
    return { cols: [C(tr('acc|Date')), C(tr('acc|Reference')), C(tr('acc|Description')), C(tr('acc|Account')), C(tr('acc|Debit'), true), C(tr('acc|Credit'), true)], rows };
  }
  function reportQuery(name, req) {
    const fy = L.fiscalYear(today());
    const p = periodOf(req);
    const date = isDate(req.query.date) ? req.query.date : today();
    return {
      ...(REPORTS[name][2] === 'date' ? { date } : p),
      ...(name === 'pl' ? { view: req.query.view === 'monthly' ? 'monthly' : 'summary', compare: ['budget', 'none'].includes(req.query.compare) ? req.query.compare : 'year' } : {}),
      ...(name === 'bs' ? { compare: req.query.compare === 'none' ? 'none' : 'year' } : {}),
      ...(name === 'gl' ? { account: (L.byId(h.int(req.query.account)) || L.byKey('ar')).id } : {}),
      fy,
    };
  }
  function buildReport(name, q) {
    if (name === 'tb') return repTB(q);
    if (name === 'pl') return repPL(q);
    if (name === 'bs') return repBS(q);
    if (name === 'cf') return repCF(q);
    if (name === 'vat') return repVAT(q);
    if (name === 'journal') return repJournal(q);
    if (name === 'ar' || name === 'ap') return agedRep(name, q.date).rep;
    if (name === 'gl') return glRep(L.byId(q.account), q).rep;
    return null;
  }
  const reportSub = (name, q) => (REPORTS[name][2] === 'date' ? tr('acc|On {date}', { date: ui.date(q.date) }) : periodText(q.from, q.to));

  router.get('/accounting/reports', RF, (req, res) => {
    const t = today();
    const fy = L.fiscalYear(t);
    const cards = Object.entries(REPORTS).map(([k, [title, desc]]) => `<a class="card acc-rcard" href="/admin/accounting/reports/${k}"><header class="card__head"><div><h2>${esc(tr(title))}</h2><p>${esc(tr(desc))}</p></div>${ui.icon('arrow')}</header></a>`).join('');
    const tb = L.trialBalance({ from: fy.from, to: t });
    const bs = L.balanceSheet(t);
    const checks = `<ul class="checklist">${[[tb.balanced, tr('acc|Debits equal credits.')], [bs.balanced, tr('acc|Assets equal liabilities plus equity.')], [!L.pending().total, tr('acc|Everything from billing is in the books.')]].map(([ok, l]) => `<li class="${ok ? 'is-ok' : 'is-missing'}">${ui.icon(ok ? 'check' : 'log')}<span>${esc(l)}</span></li>`).join('')}</ul>`;
    const body = `<div class="grid grid--side"><div class="acc-rgrid">${cards}</div>${ui.card(tr('acc|Integrity checks'), checks, { sub: esc(tr('acc|Run on every visit')) })}</div>`;
    page(req, res, { tab: 'reports', title: tr('acc|Reports'), body });
  });
  router.get('/accounting/reports/:name', RF, (req, res, next) => {
    const name = req.params.name;
    if (!REPORTS[name]) return next();
    const q = reportQuery(name, req);
    const [title] = REPORTS[name];
    const glTitle = () => (name === 'gl' ? `${tr(title)} · ${L.label(L.byId(q.account))}` : tr(title));
    if (req.query.format === 'csv') return sendCsv(req, res, buildReport(name, q), name === 'gl' ? `ledger-${L.byId(q.account).code}` : name);
    if (req.query.print) {
      return printDoc(req, res, {
        title: glTitle, sub: () => reportSub(name, q), back: `/admin/accounting/reports/${name}?${qs(Object.fromEntries(Object.entries(req.query).filter(([k]) => !['print', 'doc'].includes(k))))}`,
        build: () => { const rep = buildReport(name, q); return { rep, after: rep.okText ? `<p class="doc__small">${esc(rep.okText)}</p>` : '' }; },
      });
    }
    const rep = buildReport(name, q);
    const base = Object.fromEntries(Object.entries(req.query).filter(([k]) => !['print', 'doc', 'format'].includes(k)));
    const t = today();
    const lastM = L.addMonthsYM(t.slice(0, 7), -1);
    const presets = REPORTS[name][2] === 'period'
      ? [[tr('acc|This month'), `${t.slice(0, 7)}-01`, t], [tr('acc|Last month'), `${lastM}-01`, L.monthEnd(lastM)], [tr('acc|This year'), q.fy.from, t], [tr('acc|Last year'), shiftYear(q.fy.from, -1), shiftYear(q.fy.to, -1)]]
      : [];
    const presetNav = presets.length ? `<nav class="tabs tabs--sub">${presets.map(([l, f, to]) => `<a class="tab${q.from === f && q.to === to ? ' is-on' : ''}" href="/admin/accounting/reports/${name}?${qs({ ...base, from: f, to })}">${esc(l)}</a>`).join('')}</nav>` : '';
    const extra = [
      name === 'pl' ? ui.select('view', tr('acc|Show'), [['summary', tr('acc|Totals')], ['monthly', tr('acc|By month')]], q.view, { cls: 'f--inline', attrs: { 'data-autosubmit': true } }) : '',
      name === 'pl' && q.view !== 'monthly' ? ui.select('compare', tr('acc|Compare with'), [['year', tr('acc|Last year')], ['budget', tr('acc|Budget')], ['none', tr('acc|Nothing')]], q.compare, { cls: 'f--inline', attrs: { 'data-autosubmit': true } }) : '',
      name === 'bs' ? ui.select('compare', tr('acc|Compare with'), [['year', tr('acc|End of last year')], ['none', tr('acc|Nothing')]], q.compare, { cls: 'f--inline', attrs: { 'data-autosubmit': true } }) : '',
      name === 'gl' ? ui.select('account', tr('acc|Account'), accOptions(), q.account, { cls: 'f--inline', attrs: { 'data-autosubmit': true } }) : '',
    ].join('');
    const dates = REPORTS[name][2] === 'date'
      ? ui.input('date', tr('acc|On'), q.date, { type: 'date', cls: 'f--inline' })
      : `${ui.input('from', tr('acc|From'), q.from, { type: 'date', cls: 'f--inline' })}${ui.input('to', tr('acc|To'), q.to, { type: 'date', cls: 'f--inline' })}`;
    const filters = `<form class="filters" method="get" action="/admin/accounting/reports/${name}">${dates}${extra}${ui.btn(esc(tr('acc|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    const status = rep.okText ? `<p class="acc-check ${rep.ok === false ? 'is-bad' : rep.ok ? 'is-ok' : ''}">${ui.icon(rep.ok === false ? 'log' : 'check')}<span>${esc(rep.okText)}</span></p>` : '';
    const body = `${presetNav}${filters}${ui.card(glTitle(), `${reportHtml(rep)}${status}`, { sub: esc(reportSub(name, q)) })}`;
    page(req, res, {
      tab: 'reports', title: tr(title), crumbs: [['/admin/accounting/reports', tr('acc|Reports')]], body,
      actions: `${ui.btn(esc(tr('Export CSV')), { href: `/admin/accounting/reports/${name}?${qs({ ...base, format: 'csv' })}`, cls: 'btn--ghost', ic: 'dl' })}${ui.btn(esc(tr('acc|Print')), { href: `/admin/accounting/reports/${name}?${qs({ ...base, print: 1 })}`, cls: 'btn--primary', ic: 'print' })}`,
    });
  });

  // =====================================================================================
  // Settings and period close
  // =====================================================================================
  router.get('/accounting/settings', RF, (req, res) => {
    const csrf = req.session.csrf;
    const t = today();
    const lock = L.lockDate();
    const next = L.nextToClose();
    const lastEnded = L.addMonthsYM(t.slice(0, 7), -1);
    const ym = isYM(req.query.month) && req.query.month >= next ? req.query.month : next <= lastEnded ? next : lastEnded;
    const canClose = ym >= next && L.monthEnd(ym) < t;
    const list = L.checklist(ym);
    const checklist = `<ul class="checklist acc-checks">${list.map((c) => `<li class="${c.ok ? 'is-ok' : c.required ? 'is-missing' : 'is-warn'}">${ui.icon(c.ok ? 'check' : 'log')}<span>${esc(tr(CHECKS[c.key]))}${!c.ok && c.n && ['invoices', 'payments', 'bank', 'bills'].includes(c.key) ? ` <b>(${ui.n0(c.n)})</b>` : ''}${c.required && !c.ok ? ` · <small>${esc(tr('acc|Required'))}</small>` : ''}</span></li>`).join('')}</ul>`;
    const months = [];
    for (let m = next; m <= lastEnded && months.length < 24; m = L.addMonthsYM(m, 1)) months.push(m);
    const pick = months.length > 1 ? `<form method="get" class="row">${ui.select('month', tr('acc|Close up to'), months.map((m) => [m, ui.monthYear(m)]), ym, { cls: 'f--inline', attrs: { 'data-autosubmit': true } })}</form>` : '';
    const closeForm = canClose
      ? ui.form('/admin/accounting/close', csrf, `<input type="hidden" name="month" value="${ym}">${ui.input('note', tr('acc|Note'), '', { placeholder: tr('acc|e.g. Reviewed with the auditor') })}<label class="check"><input type="checkbox" name="force" value="1"> ${esc(tr('acc|Close anyway if optional checks are not done'))}</label>${ui.btn(esc(tr('acc|Close {month}', { month: ui.monthYear(ym) })), { cls: 'btn--primary', attrs: { 'data-confirm': tr('acc|Lock the books to {date}? Nothing can be posted on or before it.', { date: ui.date(L.monthEnd(ym)) }) } })}`, { cls: 'stack' })
      : `<p class="muted pad">${esc(tr('acc|The next month can be closed once it has ended.'))}</p>`;
    const reopen = lock && canAdmin(req) ? ui.form('/admin/accounting/reopen', csrf, ui.btn(esc(tr('acc|Reopen {month}', { month: ui.monthYear(lock.slice(0, 7)) })), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('acc|Reopen {month}? Entries can be posted in it again.', { month: ui.monthYear(lock.slice(0, 7)) }) } })) : '';
    const closeCard = ui.card(tr('acc|Month close'), `<dl class="dl"><div><dt>${esc(tr('acc|Books closed to'))}</dt><dd>${lock ? ui.date(lock) : esc(tr('acc|Nothing closed yet'))}</dd></div></dl>${pick}<p class="eyebrow acc-eyebrow">${esc(tr('acc|Checklist for {month}', { month: ui.monthYear(ym) }))}</p>${checklist}${closeForm}${reopen ? `<div class="spacer"></div>${reopen}` : ''}`, { sub: esc(tr('acc|Closing locks the month: nothing can be posted on or before its last day. Automatic postings that arrive late are dated the first open day.')) });
    // year-end close: the last three fiscal years
    const fy = L.fiscalYear(t);
    const years = [L.fiscalYear(L.addDays(fy.from, -1)), L.fiscalYear(L.addDays(L.fiscalYear(L.addDays(fy.from, -1)).from, -1))].reverse();
    const yearRows = years.map((y) => {
      const closed = L.active(`yearclose:${y.year}`);
      const ready = lock && lock >= y.to;
      const act = closed
        ? (canAdmin(req) ? ui.form('/admin/accounting/year/reopen', csrf, `<input type="hidden" name="year" value="${y.year}">${ui.btn(esc(tr('acc|Reopen the year')), { cls: 'btn--ghost btn--xs', attrs: { 'data-confirm': tr('acc|Reverse the year-end close of {label}?', { label: y.label }) } })}`) : '')
        : ready ? ui.form('/admin/accounting/year/close', csrf, `<input type="hidden" name="year" value="${y.year}">${ui.btn(esc(tr('acc|Close the year')), { cls: 'btn--primary btn--xs', attrs: { 'data-confirm': tr('acc|Move the {label} result to retained earnings?', { label: y.label }) } })}`) : `<span class="muted small">${esc(tr('acc|Close every month first'))}</span>`;
      return `<tr><td data-label="${esc(tr('acc|Fiscal year'))}"><b>${esc(y.label)}</b>${sub(periodText(y.from, y.to))}</td><td class="num" data-label="${esc(tr('acc|Net result'))}">${fmt(L.profitLoss({ from: y.from, to: y.to }).result)}</td><td data-label="${esc(tr('acc|Status'))}">${closed ? `<a href="/admin/accounting/journal/${closed.id}">${ui.badge('ok', tr('acc|Closed'), 'ok')}</a>` : ui.badge('open', tr('acc|Open'), 'sky')}</td><td>${act}</td></tr>`;
    }).join('');
    const yearCard = ui.card(tr('acc|Year-end close'), `<div class="tablewrap"><table class="table table--fin table--resp"><tbody>${yearRows}</tbody></table></div>`, { sub: esc(tr('acc|Moves the year’s income and expenses to retained earnings.')) });

    const s = (k, d) => L.S(k, d);
    const cash = cashOptions();
    const settingsForm = ui.form('/admin/accounting/settings', csrf, `
      <p class="eyebrow acc-eyebrow">${esc(tr('acc|Year and VAT'))}</p>
      <div class="fields">
        ${ui.select('fy_start', tr('acc|Fiscal year starts in'), Array.from({ length: 12 }, (_, i) => [i + 1, ui.monthName(i + 1, { short: false })]), L.fyStart())}
        ${ui.input('vat_pct', tr('acc|VAT rate on invoices (%)'), db.setting('vat_pct') || '0', { type: 'number', step: '0.01', min: 0, max: 100, hint: tr('acc|Egypt: 14%. New invoices include it; deposits never do.') })}
        ${ui.select('key_treatment', tr('acc|Key money'), [['income', tr('acc|Income when invoiced')], ['deferred', tr('acc|Spread over the lease term')]], s('key_treatment', 'income'), { })}
      </div>
      <p class="eyebrow acc-eyebrow">${esc(tr('acc|Where money arrives'))}</p>
      <div class="fields">
        ${Object.keys(METHODS).map((m) => ui.select(`method_${m}`, lbl(METHODS, m), cash.map(([id, l]) => [L.byId(id).code, l]), s(`method_${m}`, m === 'cash' ? '1110' : '1190'))).join('')}
        ${ui.select('payroll_account', tr('acc|Salaries are paid from'), cash.map(([id, l]) => [L.byId(id).code, l]), s('payroll_account', '') || '1190')}
        ${ui.select('payables_account', tr('acc|Suppliers are usually paid from'), cash.map(([id, l]) => [L.byId(id).code, l]), s('payables_account', '') || '1190')}
      </div>
      <p class="eyebrow acc-eyebrow">${esc(tr('acc|What each kind of invoice earns'))}</p>
      <div class="fields">
        ${Object.keys(INV_KINDS).map((k) => ui.select(`map_${k}`, lbl(INV_KINDS, k), L.accounts({ postable: true, activeOnly: true }).filter((a) => ['income', 'liability'].includes(a.type)).map((a) => [a.code, L.label(a)]), s(`map_${k}`, '') || (L.byKey(L.KIND_ACCOUNTS[k]) || {}).code)).join('')}
      </div>
      ${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    const p = L.pending();
    const syncCard = ui.card(tr('acc|Automatic postings'), `<p class="muted">${esc(tr('acc|Invoices are posted when they fall due, receipts when they arrive, payroll when approved and paid, supplier bills when approved. Sync posts anything missed, once.'))}</p>${p.total ? `<p><b>${esc(tr('acc|{n} items from billing are not in the books yet.', { n: p.total }))}</b></p>` : `<p class="up">${esc(tr('acc|Everything from billing is in the books.'))}</p>`}${ui.form('/admin/accounting/sync', csrf, ui.btn(esc(tr('acc|Sync everything')), { cls: 'btn--ghost', ic: 'check' }))}`);
    const body = `<div class="grid grid--2" id="close">${closeCard}<div class="stack">${yearCard}${syncCard}</div></div><div class="spacer"></div>${ui.card(tr('acc|Accounting settings'), settingsForm)}`;
    page(req, res, { tab: 'settings', title: tr('acc|Settings'), body });
  });
  router.post('/accounting/settings', RF, (req, res) => {
    const b = req.body;
    const fy = Math.min(12, Math.max(1, h.int(b.fy_start) || 1));
    L.setS('fy_start', fy);
    const pct = num(b.vat_pct);
    if (pct >= 0 && pct <= 100) db.setSetting('vat_pct', String(pct));
    L.setS('key_treatment', b.key_treatment === 'deferred' ? 'deferred' : 'income');
    const cashCodes = new Set(L.cashAccounts().map((a) => a.code));
    for (const m of Object.keys(METHODS)) if (cashCodes.has(b[`method_${m}`])) L.setS(`method_${m}`, b[`method_${m}`]);
    if (cashCodes.has(b.payroll_account)) L.setS('payroll_account', b.payroll_account);
    if (cashCodes.has(b.payables_account)) L.setS('payables_account', b.payables_account);
    for (const k of Object.keys(INV_KINDS)) {
      const a = L.byCode(String(b[`map_${k}`] || ''));
      if (a && !a.is_group && ['income', 'liability'].includes(a.type)) L.setS(`map_${k}`, a.code);
    }
    h.log(req, 'Saved accounting settings', 'settings', null, `FY ${fy}, VAT ${pct}%`);
    h.back(req, res, '/admin/accounting/settings', 'ok', tr('acc|Settings saved. They apply to new postings.'));
  });
  router.post('/accounting/close', RF, (req, res) => {
    const ym = String(req.body.month || '');
    try {
      L.sync();
      L.closeMonth(ym, { user: req.user, force: !!req.body.force, note: h.str(req.body.note, 300) || null });
      h.log(req, 'Closed a month', 'period', null, ym);
      h.back(req, res, '/admin/accounting/settings', 'ok', tr('acc|{month} is closed.', { month: ui.monthYear(ym) }));
    } catch (err) {
      h.back(req, res, `/admin/accounting/settings?month=${encodeURIComponent(ym)}`, 'error', errText(err));
    }
  });
  router.post('/accounting/reopen', RF, h.R('admin'), (req, res) => {
    try {
      const ym = L.reopenLast();
      h.log(req, 'Reopened a month', 'period', null, ym);
      h.back(req, res, '/admin/accounting/settings', 'ok', tr('acc|{month} is open again.', { month: ui.monthYear(ym) }));
    } catch (err) {
      h.back(req, res, '/admin/accounting/settings', 'error', errText(err));
    }
  });
  router.post('/accounting/year/close', RF, (req, res) => {
    const y = h.int(req.body.year);
    try {
      const fy = L.fiscalYear(`${y}-${String(L.fyStart()).padStart(2, '0')}-01`);
      const e = L.closeYear(fy.from, { user: req.user });
      h.log(req, 'Closed a year', 'period', e.id, fy.label);
      h.back(req, res, '/admin/accounting/settings', 'ok', tr('acc|{label} is closed to retained earnings.', { label: fy.label }));
    } catch (err) {
      h.back(req, res, '/admin/accounting/settings', 'error', errText(err));
    }
  });
  router.post('/accounting/year/reopen', RF, h.R('admin'), (req, res) => {
    const y = h.int(req.body.year);
    try {
      L.reopenYear(y, { user: req.user });
      h.log(req, 'Reopened a year', 'period', null, String(y));
      h.back(req, res, '/admin/accounting/settings', 'ok', tr('acc|The year-end close is reversed.'));
    } catch (err) {
      h.back(req, res, '/admin/accounting/settings', 'error', errText(err));
    }
  });

  // for other modules (and tests): the ledger itself
  h.ledger = L;
};
