'use strict';

// Tenant files: the directory of brands trading (or about to trade) in The Wave, each tenant's
// dossier (lease, legal registration, store operations, contacts, documents, units, activity),
// a compliance matrix with a CSV export, and a printable one-page fact sheet.

const i18n = require('../i18n');
const { t: tr, tn, tx, isAr } = i18n;
const T = require('../tenancy');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS = { trading: ['ten|Trading', 'ok'], opening: ['ten|Opening soon', 'amber'], signing: ['ten|Signing', 'sky'] };
// Stored in English (activity log), shown with tx().
const LOG_LEGAL = 'Updated tenant legal details';
const LOG_STORE = 'Updated tenant store details';

function csv(rows, cols) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@\t])/, "'$1")}"` : s;
  };
  return `﻿${[cols.map(([, l]) => cell(l)).join(','), ...rows.map((r) => cols.map(([k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\r\n')}\r\n`;
}

module.exports = function tenants(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  const warn = () => Number(db.setting('doc_warn_days')) || 30;
  const statusBadge = (s) => ui.badge(s, tr(STATUS[s][0]), STATUS[s][1]);
  const mark = (name) => `<span class="tmark" aria-hidden="true">${ui.esc(ui.initials(name))}</span>`;
  const codes = (units) => units.map((u) => u.code).join(' · ');
  const yearsLeft = (end) => Math.max(0, M.daysBetween(M.today(), end) / 365.25);
  const pctLabel = (x) => `${Math.round(x * 100)}%`;
  const scoreTone = (c) => (c.expired ? 'rose' : c.score >= 1 ? 'ok' : c.score >= 0.6 ? 'amber' : 'rose');
  // document titles the office typed stay as typed; standard ones (sample data) read in Arabic
  const titled = (docs) => docs.map((d) => ({ ...d, title: tx(d.title) }));
  const ltr = (v) => (v ? `<span class="ltr">${ui.esc(v)}</span>` : '—');
  const maskIban = (v) => (v ? `<span class="ltr">${ui.esc(`${v.slice(0, 4)} •••• •••• ${v.slice(-4)}`)}</span>` : '—');

  // ---------- the directory ----------
  router.get('/tenants', (req, res) => {
    const all = T.tenants(db, { warnDays: warn() });
    const view = ['table', 'compliance'].includes(req.query.view) ? req.query.view : 'cards';
    const q = h.str(req.query.q, 80).toLowerCase();
    const level = M.ZONES[req.query.level] ? req.query.level : '';
    const cat = M.CATEGORIES[req.query.category] ? req.query.category : '';
    const comp = ['complete', 'missing', 'expired', 'expiring'].includes(req.query.compliance) ? req.query.compliance : '';
    const sort = ['opening', 'end', 'compliance'].includes(req.query.sort) ? req.query.sort : 'name';
    let list = all.filter((x) => (!q || [x.name, x.legal_name, x.store_manager, codes(x.units)].some((v) => String(v || '').toLowerCase().includes(q)))
      && (!level || x.zones.includes(level)) && (!cat || x.category === cat)
      && (!comp || (comp === 'complete' ? x.compliance.score >= 1 && !x.compliance.expired : comp === 'missing' ? x.compliance.missing > 0 : comp === 'expired' ? x.compliance.expired > 0 : x.compliance.expiring > 0)));
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      opening: (a, b) => String(a.opening || a.lease?.start_date || '9999').localeCompare(String(b.opening || b.lease?.start_date || '9999')),
      end: (a, b) => String(a.lease?.end_date || '9999').localeCompare(String(b.lease?.end_date || '9999')),
      compliance: (a, b) => a.compliance.score - b.compliance.score || a.name.localeCompare(b.name),
    };
    list = list.sort(by[sort]);

    const today = M.today();
    const soon = M.addDays(today, 60);
    const trading = all.filter((x) => x.status === 'trading').length;
    const opening = all.filter((x) => x.status !== 'trading' && (x.opening || x.lease?.start_date) && (x.opening || x.lease.start_date) <= soon).length;
    const avg = all.length ? all.reduce((s, x) => s + x.compliance.score, 0) / all.length : 0;
    const flagged = all.reduce((s, x) => s + x.compliance.expired + x.compliance.expiring, 0);
    const arrears = all.reduce((s, x) => s + x.arrears, 0);
    const kpis = [
      ui.kpi({ label: tr('ten|Tenants'), value: ui.n0(all.length), sub: ui.esc(tr('ten|{area} in the mall', { area: ui.m2(all.reduce((s, x) => s + x.area, 0)) })) }),
      ui.kpi({ label: tr('ten|Trading now'), value: ui.n0(trading), sub: ui.esc(tr('ten|of {n}', { n: all.length })), bar: all.length ? trading / all.length : 0 }),
      ui.kpi({ label: tr('ten|Opening within 60 days'), value: ui.n0(opening), sub: ui.esc(tr('Fitting out or signing')) }),
      ui.kpi({ label: tr('ten|File completeness'), value: pctLabel(avg), sub: ui.esc(tr('Average across tenants')), bar: avg }),
      ui.kpi({ label: tr('ten|Documents to renew'), value: ui.n0(flagged), sub: ui.esc(tr('Expired or expiring within {n} days', { n: warn() })), tone: flagged ? 'kpi--alert' : '', href: '/admin/tenants?view=compliance' }),
      ui.kpi({ label: tr('ten|Arrears'), value: ui.money(arrears, { compact: true }), sub: ui.esc(tr('Overdue rent across tenants')), tone: arrears ? 'kpi--alert' : '', href: '/admin/billing?status=overdue' }),
    ].join('');

    const keep = (extra) => {
      const p = new URLSearchParams({ ...(q ? { q } : {}), ...(level ? { level } : {}), ...(cat ? { category: cat } : {}), ...(comp ? { compliance: comp } : {}), ...(sort !== 'name' ? { sort } : {}), ...extra });
      const s = p.toString();
      return `/admin/tenants${s ? `?${s}` : ''}`;
    };
    const tabs = `<nav class="tabs">${[['cards', tr('ten|Cards')], ['table', tr('ten|Table')], ['compliance', tr('ten|Compliance')]].map(([k, l]) => `<a class="tab${view === k ? ' is-on' : ''}" href="${keep(k === 'cards' ? {} : { view: k })}">${ui.esc(l)}</a>`).join('')}</nav>`;
    const levels = Object.fromEntries([...new Set(all.flatMap((x) => x.zones))].map((z) => [z, M.ZONES[z]]));
    const filters = `<form class="filters" method="get">${view !== 'cards' ? `<input type="hidden" name="view" value="${view}">` : ''}
      <input type="search" name="q" value="${ui.esc(req.query.q || '')}" placeholder="${ui.esc(tr('ten|Search tenants, legal names, units'))}">
      ${ui.select('level', tr('Level'), levels, level, { blank: tr('ten|All levels'), cls: 'f--inline' })}
      ${ui.select('category', tr('Category'), M.CATEGORIES, cat, { blank: tr('All categories'), cls: 'f--inline' })}
      ${ui.select('compliance', tr('ten|File'), { complete: tr('ten|Complete'), missing: tr('ten|Missing items'), expired: tr('ten|Expired items'), expiring: tr('ten|Expiring soon') }, comp, { blank: tr('ten|Any file status'), cls: 'f--inline' })}
      ${ui.select('sort', tr('ten|Sort by'), { name: tr('Name'), opening: tr('ten|Opening date'), end: tr('ten|Lease end'), compliance: tr('ten|File completeness') }, sort, { cls: 'f--inline' })}
      ${ui.btn(tr('ten|Apply'), { cls: 'btn--ghost btn--sm' })}</form>`;

    let main;
    if (!all.length) {
      main = ui.card(tr('ten|Tenants'), ui.empty(tr('No tenants yet. A brand appears here once its deal is reserved or its lease is drafted.'), ui.btn(tr('ten|Open the pipeline'), { href: '/admin/pipeline', cls: 'btn--ghost btn--sm' })));
    } else if (!list.length) {
      main = ui.card(tr('ten|Tenants'), ui.empty(tr('No tenant matches these filters.'), ui.btn(tr('ten|Clear filters'), { href: view === 'cards' ? '/admin/tenants' : `/admin/tenants?view=${view}`, cls: 'btn--ghost btn--sm' })));
    } else if (view === 'table') {
      main = ui.card(tn(list.length, '{n} tenant', '{n} tenants'), ui.table([
        { label: tr('ten|Tenant'), render: (x) => `<b>${ui.esc(x.name)}</b><small class="sub">${ui.esc(x.legal_name || M.CATEGORIES[x.category])}</small>` },
        { label: tr('Units'), render: (x) => ui.esc(codes(x.units) || '—') },
        { label: tr('Area'), num: true, render: (x) => ui.m2(x.area) },
        { label: tr('Status'), render: (x) => statusBadge(x.status) },
        { label: tr('ten|Lease ends'), render: (x) => (x.lease ? `${ui.date(x.lease.end_date)}<small class="sub">${ui.esc(tr('{n} years left', { n: yearsLeft(x.lease.end_date).toFixed(1) }))}</small>` : '—') },
        { label: tr('ten|Opening'), render: (x) => ui.date(x.opening || x.lease?.start_date) },
        { label: tr('Store manager'), render: (x) => (x.store_manager ? `${ui.esc(x.store_manager)}${x.store_phone ? `<small class="sub ltr">${ui.esc(x.store_phone)}</small>` : ''}` : '—') },
        { label: tr('ten|File'), render: (x) => `${pctLabel(x.compliance.score)} ${ui.meter(x.compliance.score, scoreTone(x.compliance))}` },
        { label: tr('ten|Arrears'), num: true, render: (x) => (x.arrears ? `<span class="late">${ui.money(x.arrears, { compact: true })}</span>` : '—') },
      ], list, { href: (x) => `/admin/tenants/${x.id}` }), { action: ui.btn(tr('Export CSV'), { href: '/admin/tenants/compliance.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) });
    } else if (view === 'compliance') {
      const cols = [...M.TENANT_REQUIRED.map((k) => M.DOC_KINDS[k]), M.DOC_KINDS.lease_contract];
      const cell = (items) => {
        if (!items.length) return '<td class="cm"><span class="cm__na">·</span></td>';
        const worst = ['missing', 'expired', 'expiring', 'ok'].find((s) => items.some((i) => i.state === s));
        const label = { ok: tr('ten|On file'), expiring: tr('ten|Expiring soon'), expired: tr('ten|Expired'), missing: tr('ten|Missing') }[worst];
        const exp = items.map((i) => i.doc?.expires_on).filter(Boolean).sort()[0];
        return `<td class="cm"><span class="cm__s cm--${worst}" title="${ui.esc(label)}">${worst === 'ok' || worst === 'expiring' ? '✓' : worst === 'expired' ? '!' : '—'}</span>${exp ? `<small>${ui.date(exp)}</small>` : ''}</td>`;
      };
      const rows = list.map((x) => `<tr data-href="/admin/tenants/${x.id}#compliance"><td><b>${ui.esc(x.name)}</b><small class="sub">${ui.esc(codes(x.units))}</small></td>${M.TENANT_REQUIRED.map((k) => cell(x.compliance.items.filter((i) => i.key === k))).join('')}${cell(x.compliance.items.filter((i) => i.key.startsWith('lease:')))}<td class="num"><b>${pctLabel(x.compliance.score)}</b> ${ui.meter(x.compliance.score, scoreTone(x.compliance))}</td></tr>`).join('');
      const legend = `<ul class="legend legend--row cm-legend"><li><span class="cm__s cm--ok">✓</span>${ui.esc(tr('ten|On file'))}</li><li><span class="cm__s cm--expiring">✓</span>${ui.esc(tr('ten|Expiring soon'))}</li><li><span class="cm__s cm--expired">!</span>${ui.esc(tr('ten|Expired'))}</li><li><span class="cm__s cm--missing">—</span>${ui.esc(tr('ten|Missing'))}</li></ul>`;
      main = ui.card(tr('What each tenant has on file'), `<div class="tablewrap"><table class="table cmatrix"><thead><tr><th>${ui.esc(tr('ten|Tenant'))}</th>${cols.map((c) => `<th>${ui.esc(c)}</th>`).join('')}<th class="num">${ui.esc(tr('ten|File'))}</th></tr></thead><tbody>${rows}</tbody></table></div>${legend}`, { sub: ui.esc(tr('Required for every tenant, plus a signed copy of each lease.')), action: ui.btn(tr('Export CSV'), { href: '/admin/tenants/compliance.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) });
    } else {
      main = `<div class="tgrid">${list.map((x) => {
        const c = x.compliance;
        const notes = [
          c.expired ? `<span class="tflag tflag--rose">${ui.esc(tn(c.expired, '{n} document expired', '{n} documents expired'))}</span>` : '',
          c.missing ? `<span class="tflag tflag--rose">${ui.esc(tn(c.missing, '{n} document missing', '{n} documents missing'))}</span>` : '',
          c.expiring ? `<span class="tflag tflag--amber">${ui.esc(tn(c.expiring, '{n} expiring soon', '{n} expiring soon'))}</span>` : '',
          x.arrears ? `<span class="tflag tflag--rose">${ui.esc(tr('{amount} overdue', { amount: ui.money(x.arrears, { compact: true }) }))}</span>` : '',
        ].join('');
        const opens = x.status === 'trading' ? tr('ten|Trading since {date}', { date: ui.date(x.opening || x.lease.start_date) }) : x.opening || x.lease ? tr('ten|Opens {date}', { date: ui.date(x.opening || x.lease.start_date) }) : tr('ten|Opening date to be set');
        return `<a class="tcard" href="/admin/tenants/${x.id}">
          <header>${mark(x.name)}<div><b>${ui.esc(x.name)}</b><small>${ui.esc(M.CATEGORIES[x.category])}</small></div>${statusBadge(x.status)}</header>
          <p class="tcard__units"><b>${ui.esc(codes(x.units) || '—')}</b><span>${ui.m2(x.area)}</span></p>
          <ul class="tcard__facts">
            <li><span>${ui.esc(tr('Lease'))}</span><b>${x.lease ? `${ui.esc(x.lease.ref)} · ${ui.esc(tr('ten|until {date}', { date: ui.date(x.lease.end_date) }))}` : ui.esc(tr('ten|To be signed'))}</b></li>
            <li><span>${ui.esc(tr('ten|Opening'))}</span><b>${ui.esc(opens)}</b></li>
            <li><span>${ui.esc(tr('Store manager'))}</span><b>${x.store_manager ? `${ui.esc(x.store_manager)}${x.store_phone ? ` · <span class="ltr">${ui.esc(x.store_phone)}</span>` : ''}` : '—'}</b></li>
          </ul>
          <div class="tcard__comp"><span>${ui.esc(tr('ten|File'))} <b>${pctLabel(c.score)}</b></span><span class="tbar"><i class="t-${scoreTone(c)}" style="width:${(c.score * 100).toFixed(1)}%"></i></span><small>${ui.esc(tr('{done} of {total} on file', { done: c.done, total: c.total }))}</small></div>
          ${notes ? `<footer>${notes}</footer>` : ''}
        </a>`;
      }).join('')}</div>`;
    }
    h.page(req, res, {
      title: tr('Tenant files'), active: '/admin/tenants', wide: true,
      body: `<div class="kpis">${kpis}</div>${tabs}${all.length ? filters : ''}${main}`,
      actions: `${h.portal ? ui.btn(tr('por|Tenant portal'), { href: '/admin/portal', cls: 'btn--ghost', ic: 'globe' }) : ''}${ui.btn(tr('ten|Compliance CSV'), { href: '/admin/tenants/compliance.csv', cls: 'btn--ghost', ic: 'dl' })}`,
    });
  });

  // ---------- compliance CSV ----------
  router.get('/tenants/compliance.csv', (req, res) => {
    const list = T.tenants(db, { warnDays: warn() });
    const state = (items) => {
      if (!items.length) return '';
      const worst = ['missing', 'expired', 'expiring', 'ok'].find((s) => items.some((i) => i.state === s));
      return { ok: tr('ten|On file'), expiring: tr('ten|Expiring soon'), expired: tr('ten|Expired'), missing: tr('ten|Missing') }[worst];
    };
    const cols = [
      ['name', tr('ten|Tenant')], [(x) => x.legal_name || '', tr('ten|Legal name')], [(x) => codes(x.units), tr('Units')], [(x) => tr(STATUS[x.status][0]), tr('Status')],
      [(x) => x.lease?.ref || '', tr('Lease')], [(x) => x.lease?.end_date || '', tr('ten|Lease ends')], [(x) => x.opening || '', tr('ten|Opening date')],
      ...M.TENANT_REQUIRED.map((k) => [(x) => state(x.compliance.items.filter((i) => i.key === k)), M.DOC_KINDS[k]]),
      [(x) => state(x.compliance.items.filter((i) => i.key.startsWith('lease:'))), M.DOC_KINDS.lease_contract],
      [(x) => Math.round(x.compliance.score * 100), tr('ten|File completeness %')], [(x) => Math.round(x.arrears), tr('ten|Arrears')],
    ];
    h.log(req, 'Exported', 'export', null, 'Tenant compliance');
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="the-wave-tenant-compliance-${M.today()}.csv"`).send(csv(list, cols));
  });

  // ---------- one tenant's file ----------
  const brandOf = (id) => db.get('SELECT * FROM brands WHERE id = ?', id);

  router.get('/tenants/:id', (req, res, next) => {
    const b = brandOf(req.params.id);
    if (!b) return next();
    const x = T.tenant(db, b, { warnDays: warn() });
    const csrf = req.session.csrf;
    const manager = h.can(req, 'manager');
    const agent = h.can(req, 'agent');
    const c = x.compliance;
    const today = M.today();
    const isTenant = T.isTenant(db, b.id);

    // the header: who, where, how complete
    const R0 = 34;
    const C0 = 2 * Math.PI * R0;
    const ring = `<svg class="tring" viewBox="0 0 84 84" role="img" aria-label="${ui.esc(tr('File {pct} complete', { pct: pctLabel(c.score) }))}"><circle cx="42" cy="42" r="${R0}" class="tring__bg"/><circle cx="42" cy="42" r="${R0}" class="tring__v t-${scoreTone(c)}" stroke-dasharray="${(c.score * C0).toFixed(1)} ${C0.toFixed(1)}" transform="rotate(-90 42 42)"/><text x="42" y="47">${pctLabel(c.score)}</text></svg>`;
    const head = `<section class="tfile__head card">
      ${mark(b.name)}
      <div class="tfile__who"><p class="eyebrow">${ui.esc(tr('ten|Tenant file'))}</p><h2>${ui.esc(b.name)}</h2>${b.legal_name ? `<p class="muted">${ui.esc(b.legal_name)}</p>` : ''}
        <p class="tfile__chips">${isTenant ? statusBadge(x.status) : ui.badge('none', tr('ten|Not a tenant'), 'mute')}<span>${ui.esc(M.CATEGORIES[b.category])}</span>${x.units.length ? `<span>${ui.esc(codes(x.units))}</span><span>${ui.m2(x.area)}</span>` : ''}${x.opening ? `<span>${ui.esc(x.status === 'trading' ? tr('ten|Trading since {date}', { date: ui.date(x.opening) }) : tr('ten|Opens {date}', { date: ui.date(x.opening) }))}</span>` : ''}</p></div>
      <div class="tfile__score">${ring}<div><b>${ui.esc(tr('ten|File completeness'))}</b><span>${ui.esc(tr('{done} of {total} on file', { done: c.done, total: c.total }))}</span>${c.expired ? `<span class="late">${ui.esc(tn(c.expired, '{n} document expired', '{n} documents expired'))}</span>` : ''}${c.missing ? `<span class="late">${ui.esc(tn(c.missing, '{n} document missing', '{n} documents missing'))}</span>` : ''}</div></div>
    </section>`;
    const nav = `<nav class="secnav">${[['overview', tr('ten|Overview')], ['compliance', tr('ten|Compliance')], ['legal', tr('ten|Legal')], ['store', tr('ten|Store')], ['contacts', tr('Contacts')], ['documents', tr('Documents')], ['units', tr('Units')], ['activity', tr('ten|Activity')]].map(([k, l]) => `<a href="#${k}">${ui.esc(l)}</a>`).join('')}</nav>`;

    // overview: the lease, money owed and what is next
    let overview;
    if (x.lease) {
      const s = x.lease;
      const annual = s.status === 'active' ? M.currentAnnualRent(db, s) : M.monthly(x.units, { rent: s.rent_m2, terrace: s.terrace_rent_m2 }).rent * 12;
      const deposit = db.value("SELECT COALESCE(SUM(paid), 0) FROM invoices WHERE lease_id = ? AND kind = 'deposit'", s.id);
      const next = db.get("SELECT * FROM invoices WHERE lease_id = ? AND status IN ('open','partial') AND due_date >= ? ORDER BY due_date LIMIT 1", s.id, today);
      const FREQ = { monthly: tr('Monthly in advance'), quarterly: tr('Quarterly in advance'), annual: tr('Yearly in advance') };
      overview = `<dl class="dl">
        <div><dt>${ui.esc(tr('Lease'))}</dt><dd><a href="/admin/leases/${s.id}">${ui.esc(s.ref)}</a> · ${ui.badge(s.status, M.LEASE_STATUS[s.status])}${x.leases.length > 1 ? ` <small class="muted">${ui.esc(tr('ten|+ {n} more', { n: x.leases.length - 1 }))}</small>` : ''}</dd></div>
        <div><dt>${ui.esc(tr('Term'))}</dt><dd>${ui.date(s.start_date)} – ${ui.date(s.end_date)} <small class="muted">· ${ui.esc(tr('{n} years left', { n: yearsLeft(s.end_date).toFixed(1) }))}</small></dd></div>
        <div><dt>${ui.esc(tr('ten|Rent now'))}</dt><dd>${ui.money(annual)} <small class="muted">${ui.esc(tr('a year · {month} a month', { month: ui.money(annual / 12, { compact: true }) }))}</small></dd></div>
        <div><dt>${ui.esc(tr('ten|Base rate'))}</dt><dd>${ui.esc(tr('{rate} per m² · +{pct}% a year', { rate: ui.money(s.rent_m2), pct: s.escalation_pct }))}</dd></div>
        <div><dt>${ui.esc(tr('Service charge'))}</dt><dd>${ui.esc(tr('{rate} per m² a month', { rate: ui.money(s.service_m2) }))}</dd></div>
        <div><dt>${ui.esc(tr('ten|Payment'))}</dt><dd>${ui.esc(FREQ[s.payment_freq] || s.payment_freq)}</dd></div>
        <div><dt>${ui.esc(tr('ten|Deposit held'))}</dt><dd>${deposit ? ui.money(deposit) : ui.esc(tr('ten|Not received yet'))}</dd></div>
        <div><dt>${ui.esc(tr('Next invoice'))}</dt><dd>${next ? `<a href="/admin/invoices/${next.id}">${ui.money(next.total - next.paid)}</a> · ${ui.esc(tr('ten|due {when}', { when: ui.rel(next.due_date) }))}` : '—'}</dd></div>
        <div><dt>${ui.esc(tr('ten|Arrears'))}</dt><dd>${x.arrears ? `<a class="late" href="/admin/billing?status=overdue">${ui.money(x.arrears)}</a>` : `<span class="up">${ui.esc(tr('ten|Nothing overdue'))}</span>`}</dd></div>
      </dl>`;
    } else if (x.deal) {
      const o = db.get("SELECT * FROM offers WHERE lead_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", x.deal.id);
      overview = `<p>${tr('Deal reserved, waiting for the lease to be signed.')}</p><dl class="dl">
        <div><dt>${ui.esc(tr('Lead'))}</dt><dd><a href="/admin/leads/${x.deal.id}">${ui.esc(x.deal.ref)} · ${ui.esc(x.deal.title)}</a></dd></div>
        ${o ? `<div><dt>${ui.esc(tr('ten|Accepted offer'))}</dt><dd><a href="/admin/offers/${o.id}">${ui.esc(o.ref)}</a> · ${ui.esc(tr('{rate} per m² · {years}', { rate: ui.money(o.rent_m2), years: tn(o.term_years, '{n} year', '{n} years') }))}</dd></div>` : ''}
        <div><dt>${ui.esc(tr('Units'))}</dt><dd>${ui.esc(codes(x.units) || '—')}</dd></div>
      </dl>${o && manager ? `<p>${ui.btn(tr('ten|Draft the lease'), { href: `/admin/leases/new?offer=${o.id}`, cls: 'btn--primary btn--sm' })}</p>` : ''}`;
    } else {
      overview = `<p class="muted">${ui.esc(tr('This brand has no lease in the mall. Its file stays here for reference.'))}</p>`;
    }

    // compliance: each requirement, what is on file, and a direct way to add it
    const stateBadge = (i) => {
      if (i.state === 'expiring') return ui.badge('soon', tr('Expires {when}', { when: ui.rel(i.doc.expires_on) }), 'amber');
      if (i.state === 'expired') return ui.badge('expired', tr('Expired {date}', { date: ui.date(i.doc.expires_on) }), 'rose');
      if (i.state === 'missing') return ui.badge('missing', tr('ten|Missing'), 'rose');
      return ui.badge('ok', tr('ten|On file'), 'ok');
    };
    const checklist = c.items.length ? `<ul class="clist">${c.items.map((i) => {
      const label = i.lease ? tr('Signed lease {ref}', { ref: i.lease.ref }) : M.DOC_KINDS[i.kind];
      const link = i.doc ? `<a href="/admin/documents/${i.doc.id}/file" target="_blank" rel="noopener">${ui.esc(tx(i.doc.title))}</a>` : `<span class="muted">${ui.esc(tr('ten|Nothing on file'))}</span>`;
      const fix = agent && i.state !== 'ok' ? (i.lease ? `<a class="btn btn--ghost btn--xs" href="#lease-docs-${i.lease.id}">${ui.esc(tr('ten|Upload'))}</a>` : `<a class="btn btn--ghost btn--xs" href="/admin/tenants/${b.id}?kind=${i.kind}#documents">${ui.esc(i.state === 'missing' ? tr('ten|Upload') : tr('ten|Renew'))}</a>`) : '';
      return `<li class="clist--${i.state}"><span class="clist__ic">${ui.icon(i.state === 'ok' || i.state === 'expiring' ? 'check' : 'log')}</span><div><b>${ui.esc(label)}</b><small>${link}</small></div>${stateBadge(i)}${fix}</li>`;
    }).join('')}</ul>` : '';

    // legal & registration
    const legal = `<dl class="dl">
      <div><dt>${ui.esc(tr('ten|Legal name'))}</dt><dd>${ui.esc(b.legal_name || '—')}</dd></div>
      <div><dt>${ui.esc(tr('Commercial register'))}</dt><dd>${ltr(b.cr_number)}</dd></div>
      <div><dt>${ui.esc(tr('ten|Tax ID'))}</dt><dd>${ltr(b.tax_id)}</dd></div>
      <div><dt>${ui.esc(tr('ten|VAT number'))}</dt><dd>${ltr(b.vat_number)}</dd></div>
      <div><dt>${ui.esc(tr('ten|Registered address'))}</dt><dd>${ui.esc(b.legal_address || '—')}</dd></div>
      <div><dt>${ui.esc(tr('ten|Authorised signatory'))}</dt><dd>${b.signatory_name ? `${ui.esc(b.signatory_name)}${b.signatory_title ? `<small class="sub">${ui.esc(tx(b.signatory_title))}</small>` : ''}` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('ten|Signatory ID no.'))}</dt><dd>${manager ? ltr(b.signatory_id) : b.signatory_id ? `<span class="ltr">•••• ${ui.esc(b.signatory_id.slice(-4))}</span>` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('ten|Bank'))}</dt><dd>${ui.esc(b.bank_name || '—')}</dd></div>
      <div><dt>${ui.esc(tr('ten|IBAN'))}</dt><dd>${manager ? ltr(b.iban) : maskIban(b.iban)}</dd></div>
    </dl>${!manager && (b.iban || b.signatory_id) ? `<p class="muted small">${ui.esc(tr('Bank and ID numbers are shown in full to managers.'))}</p>` : ''}`;
    const legalForm = manager ? `<details class="pop pop--inline"><summary class="btn btn--ghost btn--sm">${ui.esc(tr('Edit'))}</summary>${ui.form(`/admin/tenants/${b.id}/legal`, csrf, `<div class="fields">
      ${ui.input('legal_name', tr('ten|Legal name'), b.legal_name, { placeholder: tr('e.g. Maison Lune for Ready-Made Garments S.A.E.'), cls: 'span-all' })}
      ${ui.input('cr_number', tr('Commercial register'), b.cr_number, { placeholder: '123456' })}
      ${ui.input('tax_id', tr('ten|Tax ID'), b.tax_id, { placeholder: '123-456-789' })}
      ${ui.input('vat_number', tr('ten|VAT number'), b.vat_number)}
      ${ui.input('legal_address', tr('ten|Registered address'), b.legal_address, { cls: 'span-all' })}
      ${ui.input('signatory_name', tr('ten|Authorised signatory'), b.signatory_name)}
      ${ui.input('signatory_title', tr('ten|Signatory title'), b.signatory_title)}
      ${ui.input('signatory_id', tr('ten|Signatory ID no.'), b.signatory_id, { hint: tr('National ID or passport number.') })}
      ${ui.input('bank_name', tr('ten|Bank'), b.bank_name)}
      ${ui.input('iban', tr('ten|IBAN'), b.iban, { placeholder: 'EG00 0000 0000 0000 0000 0000 0000 0', hint: tr('Egyptian IBANs are EG followed by 27 digits.'), cls: 'span-all' })}
    </div>${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';

    // store operations
    const insurance = b.insurance_policy || b.insurance_expiry ? `${ltr(b.insurance_policy)} ${b.insurance_expiry ? ui.expiry(b.insurance_expiry, { warnDays: warn() }) : ''}` : '—';
    const store = `<dl class="dl">
      <div><dt>${ui.esc(tr('Store manager'))}</dt><dd>${ui.esc(b.store_manager || '—')}</dd></div>
      <div><dt>${ui.esc(tr('ten|Store phone'))}</dt><dd>${b.store_phone ? `<a href="tel:${ui.esc(b.store_phone.replace(/\s+/g, ''))}">${ui.esc(b.store_phone)}</a>` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('ten|Store email'))}</dt><dd>${b.store_email ? `<a href="mailto:${ui.esc(b.store_email)}">${ui.esc(b.store_email)}</a>` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('ten|Trading hours'))}</dt><dd>${b.trading_hours ? `<span class="ltr">${ui.esc(b.trading_hours)}</span>` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('ten|Opening date'))}</dt><dd>${ui.date(b.opening_date)}</dd></div>
      <div><dt>${ui.esc(tr('ten|Emergency contact'))}</dt><dd>${b.emergency_name || b.emergency_phone ? `${ui.esc(b.emergency_name || '')}${b.emergency_phone ? ` · <a href="tel:${ui.esc(b.emergency_phone.replace(/\s+/g, ''))}">${ui.esc(b.emergency_phone)}</a>` : ''}` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('Insurance policy'))}</dt><dd>${insurance}</dd></div>
    </dl>`;
    const storeForm = agent ? `<details class="pop pop--inline"><summary class="btn btn--ghost btn--sm">${ui.esc(tr('Edit'))}</summary>${ui.form(`/admin/tenants/${b.id}/store`, csrf, `<div class="fields">
      ${ui.input('store_manager', tr('Store manager'), b.store_manager)}
      ${ui.input('store_phone', tr('ten|Store phone'), b.store_phone, { type: 'tel' })}
      ${ui.input('store_email', tr('ten|Store email'), b.store_email, { type: 'email' })}
      ${ui.input('trading_hours', tr('ten|Trading hours'), b.trading_hours, { placeholder: '10:00–24:00' })}
      ${ui.input('opening_date', tr('ten|Opening date'), b.opening_date, { type: 'date' })}
      ${ui.input('emergency_name', tr('ten|Emergency contact'), b.emergency_name)}
      ${ui.input('emergency_phone', tr('ten|Emergency phone'), b.emergency_phone, { type: 'tel' })}
      ${ui.input('insurance_policy', tr('ten|Insurance policy no.'), b.insurance_policy)}
      ${ui.input('insurance_expiry', tr('ten|Insurance expires'), b.insurance_expiry, { type: 'date' })}
    </div>${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';

    // contacts (managed on the brand; the forms come back here)
    const contacts = db.all('SELECT * FROM contacts WHERE brand_id = ? ORDER BY primary_contact DESC, name', b.id);
    const contactList = contacts.length
      ? `<ul class="contacts">${contacts.map((ct) => `<li><span class="avatar">${ui.esc(ui.initials(ct.name))}</span><div><b>${ui.esc(ct.name)}</b>${ct.primary_contact ? ` <span class="badge badge--sea">${ui.esc(tr('contact|Main'))}</span>` : ''}<small>${ui.esc(tx(ct.title) || '')}</small><p class="contact-links">${ct.email ? `<a href="mailto:${ui.esc(ct.email)}">${ui.icon('mail')}${ui.esc(ct.email)}</a>` : ''}${ct.phone ? `<a href="tel:${ui.esc(ct.phone)}">${ui.icon('phone')}${ui.esc(ct.phone)}</a>` : ''}</p></div></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('No contacts yet.'))}</p>`;
    const addContact = agent ? `<details class="pop pop--inline"><summary class="btn btn--ghost btn--sm">${ui.esc(tr('Add contact'))}</summary>${ui.form(`/admin/brands/${b.id}/contacts`, csrf, `<div class="fields">${ui.input('name', tr('Name'), '', { required: true })}${ui.input('title', tr('Job title'))}${ui.input('email', tr('Email'), '', { type: 'email' })}${ui.input('phone', tr('o|Phone / WhatsApp'), '', { type: 'tel' })}</div><label class="check"><input type="checkbox" name="primary" value="1"> ${ui.esc(tr('o|Main contact'))}</label>${ui.btn(tr('Add'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';

    // documents: the brand's papers, and each lease's
    const preselect = (html, kind) => {
      if (!kind || !M.DOC_GROUPS.brand.includes(kind)) return html;
      return html.replace(/(<select name="kind"[^>]*>)([\s\S]*?)(<\/select>)/, (all, a, opts, z) => `${a}${opts.replace(/ selected/g, '').replace(`value="${kind}"`, `value="${kind}" selected`)}${z}`).replace('<details class="upload-box">', '<details class="upload-box" open>');
    };
    const docs = preselect(ui.docPanel({
      docs: titled(h.docs(req, 'brand', b.id)), entity: 'brand', entityId: b.id, csrf, canUpload: agent, canDelete: manager, canConfidential: h.canHR(req),
      title: tr('Brand documents'), required: M.TENANT_REQUIRED, warnDays: warn(), sub: ui.esc(tr('Registration, tax, insurance and the signatory’s ID.')),
    }), String(req.query.kind || ''));
    const leaseDocs = x.leases.map((s) => `<div id="lease-docs-${s.id}">${ui.docPanel({
      docs: titled(h.docs(req, 'lease', s.id)), entity: 'lease', entityId: s.id, csrf, canUpload: agent, canDelete: manager, canConfidential: h.canHR(req),
      title: tr('Lease {ref}', { ref: s.ref }), required: ['lease_contract'], warnDays: warn(), sub: ui.esc(`${codes(s.units)} · ${ui.date(s.start_date)} – ${ui.date(s.end_date)}`),
    })}</div>`).join('');

    // the units on the plan
    const allUnits = x.units.length ? db.all('SELECT * FROM units') : [];
    const focus = (svg) => x.units.reduce((s, u) => s.replace(`data-code="${u.code}"`, `data-code="${u.code}" data-focus`), svg);
    const plans = [['plaza', 'G'], ['street', 'B1']].filter(([z]) => x.zones.includes(z)).map(([z, lv]) => `<p class="eyebrow pad">${ui.esc(M.ZONES[z])}</p>${focus(ui.plan(allUnits, lv))}`).join('');
    const unitList = x.units.length ? `<ul class="units">${x.units.map((u) => `<li><a href="/admin/units/${u.id}"><b>${ui.esc(u.code)}</b><span>${ui.esc(M.ZONES[u.zone])} · ${ui.m2(u.indoor_m2)}${u.terrace_m2 ? ` + ${ui.esc(tr('ten|{area} terrace', { area: ui.m2(u.terrace_m2) }))}` : ''}</span>${ui.unitBadge(u.status)}</a></li>`).join('')}</ul>` : `<p class="muted pad">${ui.esc(tr('ten|No units yet.'))}</p>`;

    // recent activity: the deal's timeline and the office's changes to this tenant
    const acts = db.all('SELECT a.subject, a.type, a.done_at, a.due_at, a.created_at, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.brand_id = ? OR a.lead_id IN (SELECT id FROM leads WHERE brand_id = ?) ORDER BY COALESCE(a.done_at, a.created_at) DESC LIMIT 10', b.id, b.id)
      .map((a) => ({ at: a.done_at || a.created_at, who: a.user_name, what: tx(a.subject), kind: M.ACTIVITY_TYPES[a.type] }));
    const audit = db.all(
      `SELECT a.action, a.detail, a.created_at, u.name user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id
       WHERE (a.entity = 'brand' AND a.entity_id = ?) OR (a.entity = 'document' AND a.entity_id IN (SELECT id FROM documents WHERE entity = 'brand' AND entity_id = ?))
       ORDER BY a.id DESC LIMIT 10`, b.id, b.id,
    ).map((a) => ({ at: a.created_at, who: a.user_name, what: `${isAr() ? tx(a.action) : a.action}${a.detail ? ` · ${tx(a.detail)}` : ''}` }));
    const feed = [...acts, ...audit].sort((p, q2) => String(q2.at).localeCompare(String(p.at))).slice(0, 14);
    const activity = feed.length ? `<ul class="feed">${feed.map((a) => `<li><span class="avatar avatar--sm">${ui.esc(ui.initials(a.who || tr('System')))}</span><p><b>${ui.esc(a.who || tr('System'))}</b> <span>${ui.esc(a.what)}</span>${a.kind ? ` <small class="muted">· ${ui.esc(a.kind)}</small>` : ''}</p><time>${ui.rel(a.at)}</time></li>`).join('')}</ul>` : `<p class="muted pad">${ui.esc(tr('ten|No activity yet.'))}</p>`;

    const body = `${head}${nav}
<div class="grid grid--side tfile">
  <div class="stack">
    <div id="overview">${ui.card(tr('ten|Overview'), overview)}</div>
    <div id="compliance">${ui.card(tr('ten|Compliance'), checklist, { sub: ui.esc(tr('Required for every tenant, plus a signed copy of each lease.')), action: ui.btn(tr('ten|Matrix'), { href: '/admin/tenants?view=compliance', cls: 'btn--ghost btn--sm' }) })}</div>
    <div id="documents" class="stack">${docs}${leaseDocs}</div>
    <div id="units">${ui.card(tr('Units'), `${unitList}${plans ? `<div class="tplans">${plans}</div>${ui.planLegend()}` : ''}`)}</div>
    <div id="activity">${ui.card(tr('ten|Activity'), activity)}</div>
  </div>
  <div class="stack">
    <div id="legal">${ui.card(tr('ten|Legal & registration'), legal, { action: legalForm })}</div>
    <div id="store">${ui.card(tr('ten|Store operations'), store, { action: storeForm })}</div>
    <div id="contacts">${ui.card(tr('Contacts'), contactList, { action: addContact })}</div>
    ${(h.tenantCards || []).map((fn) => fn(req, b)).join('')}
    ${b.updated_at ? `<p class="muted small">${ui.esc(tr('File updated {when}', { when: ui.rel(b.updated_at) }))}</p>` : ''}
  </div>
</div>`;
    h.page(req, res, {
      title: b.name, crumbs: [['/admin/tenants', tr('Tenant files')], [null, b.name]], active: '/admin/tenants', wide: true, body,
      actions: `${ui.btn(tr('ten|Brand profile'), { href: `/admin/brands/${b.id}`, cls: 'btn--ghost', ic: 'brand' })}${ui.btn(tr('ten|Fact sheet'), { href: `/admin/tenants/${b.id}/print`, cls: 'btn--primary', ic: 'print' })}`,
    });
  });

  // ---------- edits ----------
  const date = (v) => (DATE_RE.test(String(v || '')) ? String(v) : null);
  router.post('/tenants/:id/legal', R('manager'), (req, res, next) => {
    const b = brandOf(req.params.id);
    if (!b) return next();
    const back = `/admin/tenants/${b.id}#legal`;
    let iban = h.str(req.body.iban, 60).replace(/[\s-]+/g, '').toUpperCase();
    if (iban && iban.startsWith('EG') && !/^EG\d{27}$/.test(iban)) return h.back(req, res, back, 'error', tr('Check the IBAN: an Egyptian IBAN is EG followed by 27 digits.'));
    if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return h.back(req, res, back, 'error', tr('Check the IBAN: two letters, two check digits, then the account number.'));
    if (!iban) iban = null;
    const v = (k, n = 160) => h.str(req.body[k], n) || null;
    db.run(
      'UPDATE brands SET legal_name = ?, cr_number = ?, tax_id = ?, vat_number = ?, legal_address = ?, signatory_name = ?, signatory_title = ?, signatory_id = ?, bank_name = ?, iban = ?, updated_at = ? WHERE id = ?',
      v('legal_name', 200), v('cr_number', 40), v('tax_id', 40), v('vat_number', 40), v('legal_address', 300), v('signatory_name', 120), v('signatory_title', 120), v('signatory_id', 40), v('bank_name', 120), iban, M.now(), b.id,
    );
    h.log(req, LOG_LEGAL, 'brand', b.id, b.name);
    h.back(req, res, back, 'ok', tr('Legal details saved.'));
  });

  router.post('/tenants/:id/store', R('agent'), (req, res, next) => {
    const b = brandOf(req.params.id);
    if (!b) return next();
    const back = `/admin/tenants/${b.id}#store`;
    const email = h.str(req.body.store_email, 200);
    if (email && !EMAIL_RE.test(email)) return h.back(req, res, back, 'error', tr('Check the store email address.'));
    for (const k of ['opening_date', 'insurance_expiry']) if (req.body[k] && !date(req.body[k])) return h.back(req, res, back, 'error', tr('ten|Check the dates.'));
    const v = (k, n = 120) => h.str(req.body[k], n) || null;
    db.run(
      'UPDATE brands SET store_manager = ?, store_phone = ?, store_email = ?, trading_hours = ?, opening_date = ?, emergency_name = ?, emergency_phone = ?, insurance_policy = ?, insurance_expiry = ?, updated_at = ? WHERE id = ?',
      v('store_manager'), v('store_phone', 40), email || null, v('trading_hours', 80), date(req.body.opening_date), v('emergency_name'), v('emergency_phone', 40), v('insurance_policy', 80), date(req.body.insurance_expiry), M.now(), b.id,
    );
    h.log(req, LOG_STORE, 'brand', b.id, b.name);
    h.back(req, res, back, 'ok', tr('Store details saved.'));
  });

  // ---------- the fact sheet ----------
  const docLang = (req) => (['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en');
  const docSwitch = (path, l) => (l === 'ar'
    ? `<a class="langbtn" href="${path}?doc=en" lang="en">${ui.icon('globe')}<span>English</span></a>`
    : `<a class="langbtn" href="${path}?doc=ar" lang="ar">${ui.icon('globe')}<span>العربية</span></a>`);

  router.get('/tenants/:id/print', (req, res, next) => {
    const b = brandOf(req.params.id);
    if (!b) return next();
    const lang = docLang(req);
    const manager = h.can(req, 'manager');
    const html = i18n.run(lang, () => {
      const s = db.settings();
      const x = T.tenant(db, b, { warnDays: warn() });
      const c = x.compliance;
      const l = x.lease;
      const row = (k, v) => `<tr><th>${ui.esc(k)}</th><td>${v || '—'}</td></tr>`;
      const FREQ = { monthly: tr('Monthly in advance'), quarterly: tr('Quarterly in advance'), annual: tr('Yearly in advance') };
      const stateText = (i) => (i.state === 'missing' ? tr('ten|Missing') : i.state === 'expired' ? tr('Expired {date}', { date: ui.date(i.doc.expires_on) }) : i.state === 'expiring' ? tr('Valid until {date}', { date: ui.date(i.doc.expires_on) }) : tr('ten|On file'));
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="/admin/tenants/${b.id}">${tr('Back')}</a>${docSwitch(`/admin/tenants/${b.id}/print`, lang)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${tr('ten|Tenant fact sheet')}</p><p class="doc__ref">${ui.date(M.today())}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${ui.esc(M.CATEGORIES[b.category])}${x.units.length ? ` · <bdi>${ui.esc(codes(x.units))}</bdi>` : ''}</p><h1>${ui.esc(b.name)}</h1>${b.legal_name ? `<p>${ui.esc(b.legal_name)}</p>` : ''}</section>
  <h2>${tr('The space')}</h2>
  <table class="doc__t"><thead><tr><th>${tr('Unit')}</th><th>${tr('Level')}</th><th class="num">${tr('Indoor')}</th><th class="num">${tr('Terrace')}</th></tr></thead><tbody>${x.units.map((u) => `<tr><td>${ui.esc(u.code)}</td><td>${ui.esc(M.ZONES[u.zone])}</td><td class="num">${ui.m2(u.indoor_m2)}</td><td class="num">${ui.m2(u.terrace_m2)}</td></tr>`).join('') || `<tr><td colspan="4">—</td></tr>`}</tbody></table>
  <h2>${tr('Lease')}</h2>
  <table class="doc__t doc__t--terms"><tbody>
    ${l ? `${row(tr('Reference'), `<bdi>${ui.esc(l.ref)}</bdi> · ${ui.esc(M.LEASE_STATUS[l.status])}`)}
    ${row(tr('Term'), `${ui.date(l.start_date)} – ${ui.date(l.end_date)}`)}
    ${row(tr('ten|Base rate'), ui.esc(tr('{rate} per m² · +{pct}% a year', { rate: ui.money(l.rent_m2), pct: l.escalation_pct })))}
    ${row(tr('Service charge'), ui.esc(tr('{rate} per m² a month', { rate: ui.money(l.service_m2) })))}
    ${row(tr('ten|Payment'), ui.esc(FREQ[l.payment_freq] || l.payment_freq))}` : row(tr('Status'), ui.esc(tr(STATUS[x.status][0])))}
    ${row(tr('ten|Opening date'), ui.date(b.opening_date))}
  </tbody></table>
  <h2>${tr('ten|Legal & registration')}</h2>
  <table class="doc__t doc__t--terms"><tbody>
    ${row(tr('ten|Legal name'), ui.esc(b.legal_name))}
    ${row(tr('Commercial register'), b.cr_number ? `<bdi>${ui.esc(b.cr_number)}</bdi>` : '')}
    ${row(tr('ten|Tax ID'), b.tax_id ? `<bdi>${ui.esc(b.tax_id)}</bdi>` : '')}
    ${row(tr('ten|VAT number'), b.vat_number ? `<bdi>${ui.esc(b.vat_number)}</bdi>` : '')}
    ${row(tr('ten|Registered address'), ui.esc(b.legal_address))}
    ${row(tr('ten|Authorised signatory'), b.signatory_name ? `${ui.esc(b.signatory_name)}${b.signatory_title ? ` · ${ui.esc(tx(b.signatory_title))}` : ''}` : '')}
    ${manager ? row(tr('ten|Bank'), b.bank_name ? `${ui.esc(b.bank_name)}${b.iban ? ` · <bdi>${ui.esc(b.iban)}</bdi>` : ''}` : '') : ''}
  </tbody></table>
  <h2>${tr('ten|Store operations')}</h2>
  <table class="doc__t doc__t--terms"><tbody>
    ${row(tr('Store manager'), ui.esc(b.store_manager))}
    ${row(tr('ten|Store phone'), b.store_phone ? `<bdi>${ui.esc(b.store_phone)}</bdi>` : '')}
    ${row(tr('ten|Store email'), b.store_email ? `<bdi>${ui.esc(b.store_email)}</bdi>` : '')}
    ${row(tr('ten|Trading hours'), b.trading_hours ? `<bdi>${ui.esc(b.trading_hours)}</bdi>` : '')}
    ${row(tr('ten|Emergency contact'), b.emergency_name || b.emergency_phone ? `${ui.esc(b.emergency_name || '')}${b.emergency_phone ? ` · <bdi>${ui.esc(b.emergency_phone)}</bdi>` : ''}` : '')}
    ${row(tr('Insurance policy'), b.insurance_policy ? `<bdi>${ui.esc(b.insurance_policy)}</bdi>${b.insurance_expiry ? ` · ${ui.esc(tr('ten|until {date}', { date: ui.date(b.insurance_expiry) }))}` : ''}` : '')}
  </tbody></table>
  <h2>${tr('ten|File completeness')} · ${pctLabel(c.score)}</h2>
  <table class="doc__t"><tbody>${c.items.map((i) => `<tr><td>${ui.esc(i.lease ? tr('Signed lease {ref}', { ref: i.lease.ref }) : M.DOC_KINDS[i.kind])}</td><td class="num">${ui.esc(stateText(i))}</td></tr>`).join('')}</tbody></table>
  <p class="doc__small">${tr('Prepared by the leasing office from the tenant file on {date}. For internal use.', { date: ui.date(M.today()) })}</p>
  <p class="doc__foot">${ui.esc(tx(s.legal_name))} · ${ui.esc(tx(s.address))} · ${ui.esc(s.leasing_email)}</p>
</main>`;
      return ui.bare({ title: tr('Fact sheet · {name}', { name: b.name }), body, cls: 'print' });
    });
    res.type('html').send(html);
  });
};
