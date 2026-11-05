'use strict';

// The office: reports, CSV exports, the team and targets, subscribers, settings and the activity log.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashPassword } = require('../db');
const demo = require('../demo');
const { t: tr, tn, tx, isAr, english: i18nEnglish } = require('../i18n');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function csv(rows, cols) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  return `﻿${[cols.map(([, l]) => cell(l)).join(','), ...rows.map((r) => cols.map(([k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\r\n')}\r\n`;
}

// Stored in English in the audit log; the role names come from model.js.
const ROLE_EN = { admin: 'Administrator', manager: 'Sales manager', agent: 'Leasing agent', viewer: 'Viewer' };
// What each export is called (CSV buttons, the audit log).
const EXPORT_LABELS = { leads: 'Leads', units: 'Units', rentroll: 'Rent roll', invoices: 'Invoices', offers: 'Offers', activities: 'Activities', subscribers: 'Subscribers' };
const INVOICE_KINDS = { rent: 'kind|Rent', deposit: 'kind|Deposit', key: 'kind|Key money', other: 'kind|Other charge' };

module.exports = function office(router, h) {
  const { db, ui, M, auth } = h;
  const R = auth.requireRole;

  // ---------- automatic backups (see backups.js) ----------
  const env = h.env || process.env;
  const backups = require('../backups').create({ db, env });
  h.backups = backups;
  // checked every 20 minutes; runs once a day after the chosen hour (Cairo time)
  h.every('daily-backup', 20 * 60 * 1000, () => backups.tick(), { first: 4 * 60 * 1000 });
  (h.integrationCards = h.integrationCards || []).push({
    key: 'backups',
    get title() { return tr('bak|Off-site backups'); },
    get help() { return tr('bak|A copy of the database is taken every night and kept on the server. With these settings a copy also goes to private S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi). Backups can also be emailed: set the addresses in Settings.'); },
    env: ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY', 'BACKUP_S3_SECRET', 'BACKUP_S3_REGION'],
    href: '/admin/settings#backups',
    get hrefLabel() { return tr('bak|Backup settings'); },
    status: () => {
      const s3 = backups.s3().ok;
      const mail = backups.emails().length && backups.smtp();
      const last = backups.lastGood();
      return { ok: !!(s3 || mail), okText: tr('bak|Copies leave the server'), offText: tr('bak|Kept on the server only'), detail: last ? tr('bak|Last backup {when}.', { when: ui.rel(last.started_at) }) : tr('bak|No backup has been taken yet.') };
    },
  });

  // ---------- reports ----------
  router.get('/reports', (req, res) => {
    const r = M.reports(db);
    const d = M.dashboard(db, null);
    const occ = r.zones.map((z) => `<div class="stack-bar"><p><b>${ui.esc(z.label)}</b><span>${ui.esc(tn(z.units, '{n} unit', '{n} units'))} · ${ui.m2(z.total)}</span></p>
      <div class="sbar"><i class="t-forest" style="width:${(z.leased / z.total) * 100}%" title="${ui.esc(tr('Leased {area}', { area: ui.m2(z.leased) }))}"></i><i class="t-cocoa" style="width:${(z.reserved / z.total) * 100}%" title="${ui.esc(tr('Reserved / on hold {area}', { area: ui.m2(z.reserved) }))}"></i><i class="t-sand" style="width:${(z.available / z.total) * 100}%" title="${ui.esc(tr('Available {area}', { area: ui.m2(z.available) }))}"></i></div>
      <ul class="legend legend--row"><li><i class="t-forest"></i>${ui.esc(tr('Leased {pct}', { pct: ui.pct(z.leased / z.total) }))}</li><li><i class="t-cocoa"></i>${ui.esc(tr('Reserved or held {pct}', { pct: ui.pct(z.reserved / z.total) }))}</li><li><i class="t-sand"></i>${ui.esc(tr('Available {pct}', { pct: ui.pct(z.available / z.total) }))}</li></ul></div>`).join('');
    const rentRoll = ui.table(
      [
        { label: tr('o|Tenant'), render: (x) => `<a href="/admin/leases/${x.id}"><b>${ui.esc(x.brand)}</b></a><small class="sub">${ui.esc(M.CATEGORIES[x.category])}</small>` },
        { label: tr('Units'), render: (x) => ui.esc(x.units) },
        { label: tr('Area'), num: true, render: (x) => ui.m2(x.area) },
        { label: tr('Annual rent'), num: true, render: (x) => ui.money(x.annual, { cur: false }) },
        { label: tr('Rent / m² / month'), num: true, render: (x) => ui.money(x.area ? x.annual / 12 / x.area : 0, { cur: false }) },
        { label: tr('Expires'), render: (x) => ui.date(x.end_date) },
        { label: tr('Years left'), num: true, render: (x) => x.remaining.toFixed(1) },
      ],
      r.rentRoll,
      { empty: ui.esc(tr('No active leases yet.')) },
    );
    const agents = ui.table(
      [
        { label: tr('Agent'), render: (a) => `<span class="who"><span class="avatar avatar--sm">${ui.esc(ui.initials(a.name))}</span>${ui.esc(a.name)}</span>` },
        { label: tr('Open deals'), num: true, render: (a) => ui.n0(a.open) },
        { label: tr('o|Weighted pipeline'), num: true, render: (a) => ui.money(a.weighted, { compact: true }) },
        { label: tr('New leads this month'), render: (a) => `${a.leadsMonth}${a.target && a.target.leads ? ` / ${a.target.leads} ${ui.meter(a.leadsMonth / a.target.leads, 'sea')}` : ''}` },
        { label: tr('Viewings this month'), render: (a) => `${a.viewings}${a.target && a.target.viewings ? ` / ${a.target.viewings} ${ui.meter(a.viewings / a.target.viewings, 'sand')}` : ''}` },
        { label: tr('Offers this month'), num: true, render: (a) => ui.n0(a.offers) },
        { label: tr('Signed (all time)'), num: true, render: (a) => `${a.won} · ${ui.money(a.wonValue, { compact: true })}` },
      ],
      r.agents,
      { empty: ui.esc(tr('Add your team to see their numbers.')) },
    );
    const sources = ui.table(
      [
        { label: tr('Source'), render: (s) => ui.esc(s.label) },
        { label: tr('Leads'), num: true, render: (s) => ui.n0(s.leads) },
        { label: tr('report|Signed'), num: true, render: (s) => ui.n0(s.won) },
        { label: tr('Conversion'), render: (s) => `${ui.pct(s.rate)} ${ui.meter(s.rate, 'forest')}` },
        { label: tr('Signed value / yr'), num: true, render: (s) => ui.money(s.value, { compact: true }) },
      ],
      r.sources,
      { empty: ui.esc(tr('o|No leads yet.')) },
    );
    const forecast = ui.table(
      [
        { label: tr('Stage'), render: (s) => ui.stageBadge(s.id) },
        { label: tr('Deals'), num: true, render: (s) => ui.n0(s.count) },
        { label: tr('o|Probability'), num: true, render: (s) => `${s.p}%` },
        { label: tr('o|Annual value'), num: true, render: (s) => ui.money(s.value, { compact: true }) },
        { label: tr('o|Weighted'), num: true, render: (s) => `<b>${ui.money(s.weighted, { compact: true })}</b>` },
      ],
      r.forecast,
    ) + `<p class="total">${ui.esc(tr('Weighted annual rent in the pipeline:'))} <b>${ui.money(r.forecast.reduce((s, f) => s + f.weighted, 0))}</b></p>`;
    const lost = r.lostReasons.length ? ui.donut(r.lostReasons.map((x) => ({ label: tx(x.reason), value: x.n })), { label: ui.n0(r.lostReasons.reduce((s, x) => s + x.n, 0)) }) : `<p class="muted pad">${tr('No lost deals. Long may it last.')}</p>`;
    const mix = r.mix.length ? ui.donut(r.mix.map((m) => ({ label: m.label, value: m.area, display: ui.m2(m.area) })), { label: ui.n0(r.mix.reduce((s, m) => s + m.area, 0)) }) : `<p class="muted pad">${tr('The mix appears as leases are signed.')}</p>`;
    const expiries = r.expiries.length ? `<ul class="list">${r.expiries.map((x) => `<li><a href="/admin/leases/${x.id}"><span class="what"><b>${ui.esc(x.brand)}</b><small>${ui.esc(x.units)} · ${ui.esc(tr('{amount} a year', { amount: ui.money(x.annual, { compact: true }) }))}</small></span><span class="late">${ui.date(x.end_date)}</span></a></li>`).join('')}</ul>` : `<p class="muted pad">${tr('No lease ends in the next 12 months.')}</p>`;
    const exports = `<div class="row wrap">${['leads', 'units', 'rentroll', 'invoices', 'offers', 'activities'].map((k) => ui.btn(tr(EXPORT_LABELS[k]), { href: `/admin/export/${k}.csv`, cls: 'btn--ghost btn--sm', ic: 'dl' })).join('')}</div>`;
    const body = `<div class="kpis">
  ${ui.kpi({ label: tr('o|Occupancy'), value: ui.pct(d.occupancy, 1), bar: d.occupancy, sub: ui.esc(tr('{leased} of {total}', { leased: ui.m2(d.leased), total: ui.m2(d.gla) })) })}
  ${ui.kpi({ label: tr('Contracted rent'), value: ui.money(r.totalAnnual, { compact: true }), sub: ui.esc(tr('a year, current rates')) })}
  ${ui.kpi({ label: tr('WALE'), value: tn(Number(r.wale.toFixed(1)), '{n} <small>year</small>', '{n} <small>years</small>'), sub: ui.esc(tr('Weighted average lease expiry')) })}
  ${ui.kpi({ label: tr('o|Weighted pipeline'), value: ui.money(d.weighted, { compact: true }), sub: ui.esc(tn(d.openCount, 'o|{n} open deal', 'o|{n} open deals')) })}
  ${ui.kpi({ label: tr('Win rate'), value: d.conversion === null ? '—' : ui.pct(d.conversion), sub: ui.esc(tr('Signed of all closed deals')) })}
  ${ui.kpi({ label: tr('kpi|Overdue'), value: ui.money(d.overdue.amount, { compact: true }), tone: d.overdue.amount ? 'kpi--alert' : '' })}
</div>
<div class="grid">
  ${ui.card(tr('Occupancy by level'), occ, { cls: 'span-2' })}
  ${ui.card(tr('Tenant mix'), mix, { sub: ui.esc(tr('Leased area by category')) })}
  ${ui.card(tr('Rent roll'), rentRoll, { cls: 'span-3', action: ui.btn(tr('CSV'), { href: '/admin/export/rentroll.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}
  ${ui.card(tr('Forecast'), forecast, { cls: 'span-2', sub: ui.esc(tr('Annual rent by stage, weighted by probability')) })}
  ${ui.card(tr('Why deals are lost'), lost)}
  ${ui.card(tr('Team this month'), agents, { cls: 'span-3', action: h.can(req, 'manager') ? ui.btn(tr('Set targets'), { href: '/admin/team#targets', cls: 'btn--ghost btn--sm' }) : '' })}
  ${ui.card(tr('Lead sources'), sources, { cls: 'span-2' })}
  ${ui.card(tr('o|Receivables aging'), ui.bars(r.aging, { key: 'amount', label: 'label', fmtv: (n) => ui.money(n, { compact: true, cur: false }), tone: 'cocoa' }))}
  ${ui.card(tr('Leases ending within a year'), expiries, { cls: 'span-2' })}
  ${ui.card(tr('Export'), `<p class="muted">${tr('Spreadsheet-ready CSV files.')}</p>${exports}`)}
</div>`;
    h.page(req, res, { title: tr('Reports'), active: '/admin/reports', wide: true, body, actions: ui.btn(tr('Print'), { type: 'button', cls: 'btn--ghost', ic: 'print', attrs: { 'data-print': true } }) });
  });

  // ---------- CSV exports ----------
  // Column headers follow the reader's language; values that are labels go through the label maps.
  const EXPORTS = {
    leads: () => [db.all('SELECT l.*, b.name brand, u.name owner FROM leads l LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN users u ON u.id = l.owner_id ORDER BY l.id'), [['ref', 'Ref'], ['title', 'Lead'], ['brand', 'Brand'], [(r) => M.CATEGORIES[r.category], 'Category'], [(r) => M.SOURCES[r.source], 'Source'], [(r) => M.stage(r.stage).label, 'Stage'], ['probability', 'Probability %'], ['area_min', 'Area from'], ['area_max', 'Area to'], ['budget_m2', 'Budget / m²'], ['value_est', 'Annual value'], ['owner', 'Owner'], [(r) => tx(r.next_step), 'Next step'], ['next_step_at', 'Next step due'], [(r) => tx(r.lost_reason), 'Lost reason'], ['created_at', 'Created']]],
    units: () => [db.all("SELECT * FROM units WHERE status != 'retired' ORDER BY sort"), [['code', 'Unit'], [(u) => M.ZONES[u.zone], 'Level'], ['indoor_m2', 'Indoor m²'], ['terrace_m2', 'Terrace m²'], [(u) => M.UNIT_STATUS[u.status], 'Status'], [(u) => M.listRates(db, u).rent, 'List rent / m²'], [(u) => M.listRates(db, u).terrace, 'Terrace / m²'], ['hold_until', 'Hold until']]],
    rentroll: () => [M.reports(db).rentRoll, [['ref', 'Lease'], ['brand', 'Tenant'], [(x) => M.CATEGORIES[x.category], 'Category'], ['units', 'Units'], ['area', 'Area m²'], [(x) => Math.round(x.annual), 'Annual rent'], ['start_date', 'Start'], ['end_date', 'End'], [(x) => x.remaining.toFixed(2), 'Years left']]],
    invoices: () => [db.all('SELECT i.*, s.ref lease, COALESCE(b.name, i.customer) tenant FROM invoices i LEFT JOIN leases s ON s.id = i.lease_id LEFT JOIN brands b ON b.id = i.brand_id ORDER BY i.due_date'), [['ref', 'Invoice'], ['tenant', 'Tenant'], ['lease', 'Lease'], [(i) => tr(INVOICE_KINDS[i.kind] || i.kind), 'Kind'], ['period_start', 'From'], ['period_end', 'To'], ['due_date', 'Due'], ['rent', 'Rent'], ['service', 'Service'], ['other', 'Other'], ['total', 'Total'], ['paid', 'Paid'], [(i) => M.INVOICE_STATUS[i.status], 'Status'], ['paid_at', 'Paid on']]],
    offers: () => [db.all('SELECT o.*, l.title lead FROM offers o JOIN leads l ON l.id = o.lead_id ORDER BY o.id'), [['ref', 'Offer'], ['lead', 'Lead'], [(o) => M.offerUnits(db, o.id).map((u) => u.code).join(' '), 'Units'], ['rent_m2', 'Rent / m²'], ['term_years', 'Years'], ['escalation_pct', 'Increase %'], ['rent_free_months', 'Rent-free'], [(o) => M.OFFER_STATUS[o.status], 'Status'], ['valid_until', 'Valid until'], ['created_at', 'Created']]],
    activities: () => [db.all('SELECT a.*, l.title lead, u.name user FROM activities a LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id'), [[(a) => M.ACTIVITY_TYPES[a.type] || a.type, 'Type'], [(a) => tx(a.subject), 'Subject'], ['lead', 'Lead'], ['user', 'By'], ['due_at', 'Due'], ['done_at', 'Done'], ['created_at', 'Created']]],
    subscribers: () => [db.all('SELECT * FROM subscribers ORDER BY created_at DESC'), [['email', 'Email'], [(x) => (x.lang === 'ar' ? tr('o|Arabic') : tr('English')), 'Language'], [(x) => (x.source === 'website' ? tr('Website') : x.source), 'Source'], ['created_at', 'Joined']]],
  };
  router.get('/export/:what.csv', (req, res, next) => {
    const make = EXPORTS[req.params.what];
    if (!make) return next();
    const [rows, raw] = make();
    const cols = raw.map(([k, l]) => [k, tr(`o|${l}`)]);
    h.log(req, 'Exported', 'export', null, EXPORT_LABELS[req.params.what] || req.params.what);
    res.set('Content-Disposition', `attachment; filename="the-wave-${req.params.what}-${M.today()}.csv"`).type('text/csv; charset=utf-8').send(csv(rows, cols));
  });

  // ---------- team & targets ----------
  router.get('/team', (req, res) => {
    const users = db.all('SELECT * FROM users ORDER BY active DESC, name');
    const hiddenCount = (u) => (u.role === 'admin' ? 0 : [...ui.hiddenModules(u)].filter((href) => ui.NAV_ENTRIES.some((e) => e.href === href && ui.roleAllows(u, e.min))).length);
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : M.today().slice(0, 7);
    const isAdmin = h.can(req, 'admin');
    const csrf = req.session.csrf;
    const stats = (u) => ({
      open: db.value(`SELECT COUNT(*) FROM leads WHERE owner_id = ? AND stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')})`, u.id),
      won: db.value("SELECT COUNT(*) FROM leads WHERE owner_id = ? AND stage = 'won'", u.id),
    });
    const table = ui.table(
      [
        { label: tr('Person'), render: (u) => `<span class="who"><span class="avatar avatar--sm">${ui.esc(ui.initials(u.name))}</span><span><b>${ui.esc(u.name)}</b>${u.title ? `<small class="sub">${ui.esc(tx(u.title))}</small>` : ''}<small class="sub ltr">${ui.esc(u.email)}</small></span></span>` },
        { label: tr('Role'), render: (u) => `${u.role_id && u.role !== 'admin' && h.access ? ui.badge(u.role, h.access.roleName(h.access.roleOf(u)), 'sea') : ui.badge(u.role, M.ROLES[u.role])}${u.role === 'admin' || u.hr ? ` ${ui.badge('hr', tr('HR access'), 'sand')}` : ''}${u.role === 'admin' || u.finance ? ` ${ui.badge('finance', tr('Finance access'), 'sky')}` : ''}${hiddenCount(u) ? ` ${isAdmin ? `<a href="/admin/team/${u.id}/access" class="badgelink">${ui.badge('limited', tn(hiddenCount(u), 'acc2|{n} module hidden', 'acc2|{n} modules hidden'), 'amber')}</a>` : ui.badge('limited', tn(hiddenCount(u), 'acc2|{n} module hidden', 'acc2|{n} modules hidden'), 'amber')}` : ''}` },
        { label: tr('Open deals'), num: true, render: (u) => ui.n0(stats(u).open) },
        { label: tr('report|Signed'), num: true, render: (u) => ui.n0(stats(u).won) },
        { label: tr('Last sign-in'), render: (u) => (u.last_login_at ? ui.rel(u.last_login_at) : tr('Never')) },
        { label: tr('Status'), render: (u) => (u.active ? ui.badge('active', tr('user|Active')) : ui.badge('void', tr('user|Disabled'))) },
        ...(isAdmin ? [{ label: '', render: (u) => (u.id === req.user.id ? `<span class="muted">${tr('You')}</span>` : `<details class="pop"><summary class="btn btn--ghost btn--xs">${tr('Manage')}</summary>${ui.form(`/admin/team/${u.id}`, csrf, `${ui.select('role', tr('Role'), M.ROLES, u.role)}<label class="check"><input type="checkbox" name="hr" value="1" ${u.hr ? 'checked' : ''}> ${tr('HR access (staff, pay, leave)')}</label><label class="check"><input type="checkbox" name="finance" value="1" ${u.finance ? 'checked' : ''}> ${tr('Finance access (accounting, banks, reports)')}</label><label class="check"><input type="checkbox" name="active" value="1" ${u.active ? 'checked' : ''}> ${tr('Can sign in')}</label><label class="check"><input type="checkbox" name="reset" value="1"> ${tr('Reset password')}</label>${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}<p class="pop__more">${ui.btn(ui.esc(tr('acc2|Module access')), { href: `/admin/team/${u.id}/access`, cls: 'btn--ghost btn--sm btn--block', ic: 'shield' })}</p></details>`) }] : []),
      ],
      users,
    );
    const invite = isAdmin
      ? ui.card(tr('Add someone'), ui.form('/admin/team', csrf, `<div class="fields">${ui.input('name', tr('Name'), '', { required: true })}${ui.input('email', tr('Email'), '', { type: 'email', required: true })}${ui.select('role', tr('Role'), M.ROLES, 'agent')}${ui.input('title', tr('Job title'), '', { placeholder: tr('e.g. Leasing executive') })}</div><label class="check"><input type="checkbox" name="hr" value="1"> ${tr('HR access (staff, pay, leave)')}</label><label class="check"><input type="checkbox" name="finance" value="1"> ${tr('Finance access (accounting, banks, reports)')}</label><p class="muted">${tr('A password is generated and shown to you once, to pass on securely.')}</p>${ui.btn(tr('Add to the team'), { cls: 'btn--primary' })}`, { cls: 'stack' }), { sub: tr('<b>Agents</b> work their leads and offers. <b>Managers</b> approve discounts, sign leases and record payments. <b>Viewers</b> can only look.') + ` ${tr('<b>HR access</b> opens the People section (salaries, leave, employee files); administrators always have it.')}` })
      : '';
    const agents = users.filter((u) => u.active && u.role !== 'viewer');
    const targets = h.can(req, 'manager')
      ? ui.card(tr('Targets for {month}', { month: ui.monthYear(period) }), ui.form(`/admin/team/targets?period=${period}`, csrf, `<input type="hidden" name="period" value="${period}"><div class="tablewrap"><table class="table"><thead><tr><th>${tr('Person')}</th><th>${tr('New leads')}</th><th>${tr('Viewings')}</th><th>${tr('Signed m²')}</th><th>${tr('Signed rent / yr')}</th></tr></thead><tbody>${agents.map((u) => {
          const t = db.get('SELECT * FROM targets WHERE period = ? AND user_id = ?', period, u.id) || {};
          return `<tr><td>${ui.esc(u.name)}</td>${['leads', 'viewings', 'signed_m2', 'revenue'].map((k) => `<td><input class="cellin" type="number" min="0" name="${k}_${u.id}" value="${t[k] ?? ''}"></td>`).join('')}</tr>`;
        }).join('')}</tbody></table></div><div class="row">${ui.btn(tr('Save targets'), { cls: 'btn--primary btn--sm' })}<a class="btn btn--ghost btn--sm" href="/admin/team?period=${M.addMonths(`${period}-01`, -1).slice(0, 7)}#targets">${isAr() ? '→' : '←'} ${tr('o|Previous month')}</a><a class="btn btn--ghost btn--sm" href="/admin/team?period=${M.addMonths(`${period}-01`, 1).slice(0, 7)}#targets">${tr('o|Next month')} ${isAr() ? '←' : '→'}</a></div>`, { cls: 'stack', attrs: { id: 'targets' } }))
      : '';
    const peopleLink = h.access && (h.access.has(req.user, 'manage_users') || h.access.has(req.user, 'grant')) ? ui.btn(ui.esc(tr('nav|Users & permissions')), { href: '/admin/people', cls: 'btn--ghost', ic: 'shield' }) : '';
    h.page(req, res, { title: tr('Team & targets'), active: '/admin/team', wide: true, actions: peopleLink, body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('The leasing team'), table)}${targets}</div><div class="stack">${invite}${ui.card(tr('Your account'), `<p>${ui.btn(tr('Change your password'), { href: '/admin/me', cls: 'btn--ghost btn--sm' })}</p>`)}</div></div>` });
  });

  router.post('/team', R('admin'), (req, res) => {
    const name = h.str(req.body.name, 120);
    const email = h.str(req.body.email, 200).toLowerCase();
    const role = M.ROLES[req.body.role] ? req.body.role : 'agent';
    if (!name || !EMAIL_RE.test(email)) return h.back(req, res, '/admin/team', 'error', tr('Enter a name and a valid email.'));
    if (db.get('SELECT id FROM users WHERE email = ?', email)) return h.back(req, res, '/admin/team', 'error', tr('Someone already uses that email.'));
    const password = auth.token(9);
    const hrAccess = req.body.hr ? 1 : 0;
    const financeAccess = req.body.finance ? 1 : 0;
    const r = db.run('INSERT INTO users (name, email, role, title, password_hash, hr, finance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', name, email, role, h.str(req.body.title, 120) || null, hashPassword(password), hrAccess, financeAccess, M.now());
    if (financeAccess) h.log(req, 'Granted finance access', 'user', Number(r.lastInsertRowid), name);
    h.log(req, 'Added a team member', 'user', Number(r.lastInsertRowid), `${name}, role: ${ROLE_EN[role]}`);
    if (hrAccess) h.log(req, 'Granted HR access', 'user', Number(r.lastInsertRowid), name);
    h.back(req, res, '/admin/team', 'ok', tr('{name} added. Their temporary password is {password} (shown once). They can change it under Your account.', { name, password }));
  });

  router.post('/team/targets', R('manager'), (req, res) => {
    const period = /^\d{4}-\d{2}$/.test(req.body.period || '') ? req.body.period : M.today().slice(0, 7);
    for (const u of db.all("SELECT id FROM users WHERE active = 1 AND role != 'viewer'")) {
      const v = (k) => Math.max(0, h.numv(req.body[`${k}_${u.id}`]) || 0);
      db.run('INSERT INTO targets (period, user_id, leads, viewings, signed_m2, revenue) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(period, user_id) DO UPDATE SET leads = excluded.leads, viewings = excluded.viewings, signed_m2 = excluded.signed_m2, revenue = excluded.revenue', period, u.id, v('leads'), v('viewings'), v('signed_m2'), v('revenue'));
    }
    h.log(req, 'Set targets', 'targets', null, period);
    h.back(req, res, `/admin/team?period=${period}#targets`, 'ok', tr('Targets saved.'));
  });

  router.post('/team/:id', R('admin'), (req, res, next) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!u) return next();
    if (u.id === req.user.id) return h.back(req, res, '/admin/team', 'error', tr('Change your own account under Your account.'));
    const role = M.ROLES[req.body.role] ? req.body.role : u.role;
    const active = req.body.active ? 1 : 0;
    if (u.role === 'admin' && (role !== 'admin' || !active) && db.value("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1") <= 1) return h.back(req, res, '/admin/team', 'error', tr('Keep at least one active administrator.'));
    const hrAccess = req.body.hr ? 1 : 0;
    const financeAccess = req.body.finance ? 1 : 0;
    db.run('UPDATE users SET role = ?, active = ?, hr = ?, finance = ? WHERE id = ?', role, active, hrAccess, financeAccess, u.id);
    // a different built-in role chosen here replaces a custom role (Users & permissions)
    if (role !== u.role) db.run('UPDATE users SET role_id = NULL WHERE id = ?', u.id);
    if (financeAccess !== (u.finance ? 1 : 0)) h.log(req, financeAccess ? 'Granted finance access' : 'Removed finance access', 'user', u.id, u.name);
    if (hrAccess !== (u.hr ? 1 : 0)) h.log(req, hrAccess ? 'Granted HR access' : 'Removed HR access', 'user', u.id, u.name);
    let msg = tr('{name} updated.', { name: u.name });
    if (!active || req.body.reset) db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    if (req.body.reset) {
      const password = auth.token(9);
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
      msg = tr("{name}'s new temporary password is {password} (shown once).", { name: u.name, password });
    }
    h.log(req, 'Updated a team member', 'user', u.id, `${u.name}: role ${ROLE_EN[role]}${active ? '' : ', disabled'}${req.body.reset ? ', password reset' : ''}`);
    h.back(req, res, '/admin/team', 'ok', msg);
  });

  // the AI assistant was taken out of the office: its conversations and usage log go with it
  db.ensure('assistant-removed', 'DROP TABLE IF EXISTS ai_turns; DROP TABLE IF EXISTS ai_usage; DROP TABLE IF EXISTS ai_conversations;');

  // ---------- module access ----------
  // Which sidebar modules a person may open, on top of what their role allows. Unticking hides the
  // module from their sidebar, refuses its pages by address (routes/core.js).
  // Administrators always keep everything.
  const NEEDS = { hr: 'acc2|Needs HR access', finance: 'acc2|Needs finance access', admin: 'acc2|Administrators only', manager: 'acc2|Managers and administrators' };
  router.get('/team/:id/access', R('admin'), (req, res, next) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!u) return next();
    const hidden = ui.hiddenModules(u);
    const isAdminUser = u.role === 'admin';
    const groups = ui.NAV.map(([group, items]) => {
      const rows = items.map(([href]) => ui.NAV_ENTRIES.find((e) => e.href === href)).map((e) => {
        const always = e.href === '/admin' || isAdminUser;
        const roleOk = ui.roleAllows(u, e.min);
        const on = always || (roleOk && !hidden.has(e.href));
        const note = e.href === '/admin' ? tr('acc2|Always available') : !roleOk ? tr(NEEDS[e.min] || 'acc2|Not for this role') : '';
        return `<label class="modpick${!roleOk ? ' is-off' : ''}"><input type="checkbox" name="m" value="${ui.esc(e.href)}"${on ? ' checked' : ''}${always || !roleOk ? ' disabled' : ''}>${ui.icon(e.ic)}<span><b>${ui.esc(tr(e.label))}</b>${note ? `<small>${ui.esc(note)}</small>` : ''}</span></label>`;
      }).join('');
      return `<fieldset class="modgroup"><legend>${ui.esc(tr(group))}</legend><div class="modgroup__list">${rows}</div></fieldset>`;
    }).join('');
    const allowedN = ui.NAV_ENTRIES.filter((e) => ui.roleAllows(u, e.min)).length;
    const openN = ui.NAV_ENTRIES.filter((e) => ui.canOpen(u, e.href)).length;
    const intro = isAdminUser
      ? `<p class="notice">${ui.icon('shield')}<span>${ui.esc(tr('acc2|{name} is an administrator. Administrators always have every module; change the role on the Team page to limit what they see.', { name: u.name }))}</span></p>`
      : `<p class="muted">${ui.esc(tr('acc2|Untick a module to hide it from {name}: it leaves their menu, its pages answer "no access" even by direct link. Greyed modules are outside their role.', { name: u.name }))}</p>`;
    const form = isAdminUser
      ? groups.replace(/<input /g, '<input disabled ')
      : ui.form(`/admin/team/${u.id}/access`, req.session.csrf, `${groups}<div class="row">${ui.btn(ui.esc(tr('Save')), { cls: 'btn--primary' })}${ui.btn(ui.esc(tr('acc2|Open every module')), { cls: 'btn--ghost', attrs: { name: 'reset', value: '1' } })}</div>`, { cls: 'stack modaccess' });
    const side = ui.card(tr('acc2|At a glance'), `<dl class="dl"><div><dt>${ui.esc(tr('Role'))}</dt><dd>${ui.badge(u.role, M.ROLES[u.role])}</dd></div><div><dt>${ui.esc(tr('acc2|Modules open'))}</dt><dd><b>${ui.n0(openN)}</b> / ${ui.n0(allowedN)}</dd></div><div><dt>${ui.esc(tr('HR access'))}</dt><dd>${isAdminUser || u.hr ? ui.esc(tr('acc2|Yes')) : ui.esc(tr('acc2|No'))}</dd></div><div><dt>${ui.esc(tr('Finance access'))}</dt><dd>${isAdminUser || u.finance ? ui.esc(tr('acc2|Yes')) : ui.esc(tr('acc2|No'))}</dd></div></dl><p class="muted small">${ui.esc(tr('acc2|New modules added to the office later are open by default; untick them here if needed.'))}</p>`);
    const fuller = `<p class="notice">${ui.icon('shield')}<span>${ui.esc(tr('ppl|For levels per module (view, edit, full), permissions and temporary access, use Users & permissions.'))} <a href="/admin/people/${u.id}/access">${ui.esc(tr('ppl|Open effective access'))}</a></span></p>`;
    h.page(req, res, { title: tr('acc2|Module access'), crumbs: [['/admin/team', tr('Team & targets')], [null, u.name]], active: '/admin/team', wide: true, body: `${fuller}<div class="grid grid--side"><div class="stack">${ui.card(tr('acc2|What {name} can open', { name: u.name }), `${intro}${form}`)}</div><div class="stack">${side}</div></div>` });
  });
  router.post('/team/:id/access', R('admin'), (req, res, next) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!u) return next();
    if (u.role === 'admin') return h.back(req, res, `/admin/team/${u.id}/access`, 'error', tr('acc2|Administrators always have every module.'));
    const ticked = new Set(h.list(req.body.m).map(String));
    const before = ui.hiddenModules(u);
    // modules outside the role keep their earlier choice (they are greyed out on the page)
    const hidden = req.body.reset ? [] : ui.NAV_ENTRIES.filter((e) => e.href !== '/admin' && (ui.roleAllows(u, e.min) ? !ticked.has(e.href) : before.has(e.href))).map((e) => e.href);
    db.run('UPDATE users SET hidden_modules = ? WHERE id = ?', hidden.length ? JSON.stringify(hidden) : null, u.id);
    const english = (href) => i18nEnglish((ui.NAV_ENTRIES.find((e) => e.href === href) || {}).label || href);
    h.log(req, 'Updated a team member', 'user', u.id, `${u.name}: module access${hidden.length ? `, hidden: ${hidden.map(english).join(', ')}` : ', every module open'}`.slice(0, 480));
    h.back(req, res, `/admin/team/${u.id}/access`, 'ok', hidden.length ? tn(hidden.length, 'acc2|Saved. {n} module is hidden from {name}.', 'acc2|Saved. {n} modules are hidden from {name}.', { name: u.name }) : tr('acc2|Saved. {name} can open every module their role allows.', { name: u.name }));
  });

  // ---------- subscribers ----------
  router.get('/subscribers', (req, res) => {
    const rows = db.all('SELECT * FROM subscribers ORDER BY created_at DESC LIMIT 1000');
    const total = db.value('SELECT COUNT(*) FROM subscribers');
    const month = db.value('SELECT COUNT(*) FROM subscribers WHERE substr(created_at, 1, 7) = ?', M.today().slice(0, 7));
    const ar = db.value("SELECT COUNT(*) FROM subscribers WHERE lang = 'ar'");
    const body = `<div class="kpis kpis--3">${ui.kpi({ label: tr('Subscribers'), value: ui.n0(total) })}${ui.kpi({ label: tr('Joined this month'), value: ui.n0(month) })}${ui.kpi({ label: tr('Arabic / English'), value: `${ui.pct(total ? ar / total : 0)} <small>${tr('o|Arabic')}</small>` })}</div>
${ui.card(tr('Opening news list'), ui.table([{ label: tr('Email'), render: (s) => `<a href="mailto:${ui.esc(s.email)}">${ui.esc(s.email)}</a>` }, { label: tr('o|Language'), render: (s) => (s.lang === 'ar' ? tr('o|Arabic') : tr('English')) }, { label: tr('Source'), render: (s) => ui.esc(!s.source || s.source === 'website' ? tr('Website') : s.source) }, { label: tr('Joined'), render: (s) => ui.date(s.created_at) }], rows, { empty: ui.esc(tr('Sign-ups from the website footer appear here.')) }), { action: ui.btn(tr('Export CSV'), { href: '/admin/export/subscribers.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`;
    h.page(req, res, { title: tr('Subscribers'), active: '/admin/subscribers', body });
  });

  // ---------- backups: the Settings card ----------
  const MB = (n) => `${(Number(n || 0) / 1048576).toLocaleString(isAr() ? 'ar-EG-u-nu-latn' : 'en-US', { maximumFractionDigits: n < 10485760 ? 2 : 1 })} ${isAr() ? 'ميجابايت' : 'MB'}`;
  const BAK_STATUS = { ok: ['bak|Complete', 'ok'], partial: ['bak|Saved, a copy failed', 'amber'], failed: ['bak|Failed', 'rose'], running: ['bak|Running', 'sky'] };
  const OFF = { sent: ['bak|Sent', 'ok'], failed: ['bak|Failed', 'rose'], skipped: ['bak|Skipped', 'amber'] };
  function backupCard(req) {
    const csrf = req.session.csrf;
    const st = backups.settings();
    const last = backups.last();
    const list = backups.list();
    const s3 = backups.s3();
    const emails = backups.emails();
    // why a copy was skipped, in the reader's language (server and provider errors stay as they came)
    const why = (d) => {
      if (d === 'SMTP is not configured') return tr('bak|Email is not set up (SMTP).');
      const m = String(d).match(/^The backup \(([\d.]+) MB\) is over the (\d+) MB email limit$/);
      return m ? tr('bak|Too large to email ({size} MB; the limit is {max} MB).', { size: m[1], max: m[2] }) : d;
    };
    const off = (status, detail, label) => `<li>${ui.esc(label)} ${status ? ui.badge(status, tr(OFF[status][0]), OFF[status][1]) : ui.badge('off', tr('bak|Not set up'), 'mute')}${detail ? `<small class="sub${status === 'sent' || status === 'failed' ? ' ltr' : ''}">${ui.esc(status === 'skipped' ? why(detail) : detail)}</small>` : ''}</li>`;
    const lastHtml = last
      ? `<div class="bak__last bak__last--${ui.esc(last.status)}">
          <p class="bak__when">${ui.badge(last.status, tr(BAK_STATUS[last.status][0]), BAK_STATUS[last.status][1])} <b>${ui.esc(ui.dt(last.started_at))}</b> <span class="muted">· ${ui.esc(ui.rel(last.started_at))} · ${ui.esc(last.trigger === 'daily' ? tr('bak|Nightly') : last.user_name ? tr('bak|By {name}', { name: last.user_name }) : tr('bak|By hand'))}</span></p>
          ${last.status === 'failed' ? `<p class="late">${ui.esc(tx(last.error || ''))}</p>` : `<ul class="bak__where">
            <li>${ui.esc(tr('bak|On the server'))} ${ui.badge('ok', MB(last.bytes), 'ok')}${last.raw_bytes ? `<small class="sub">${ui.esc(tr('bak|{size} before compression', { size: MB(last.raw_bytes) }))}</small>` : ''}</li>
            ${off(last.email_status, last.email_detail, tr('Email'))}
            ${off(last.s3_status, last.s3_detail, tr('bak|Off-site storage'))}
          </ul>`}
        </div>`
      : `<p class="muted">${ui.esc(tr('bak|No backup has been taken yet.'))}</p>`;
    const files = list.length
      ? `<ul class="bak__files">${list.slice(0, 14).map((b) => `<li><span>${ui.icon('file')}<b>${ui.esc(ui.date(b.date))}</b> <span class="muted">${ui.esc(b.time)} · ${ui.esc(b.trigger === 'daily' ? tr('bak|Nightly') : tr('bak|By hand'))}</span></span><span class="muted">${ui.esc(MB(b.bytes))}</span><a class="iconbtn" href="/admin/settings/backups/file/${encodeURIComponent(b.name)}" title="${ui.esc(tr('Download'))}" aria-label="${ui.esc(tr('Download'))}">${ui.icon('dl')}</a></li>`).join('')}</ul>${list.length > 14 ? `<p class="muted small">${ui.esc(tn(list.length - 14, 'bak|and {n} older backup', 'bak|and {n} older backups'))}</p>` : ''}`
      : `<p class="muted small">${ui.esc(tr('bak|Backups appear here after the first one.'))}</p>`;
    const hours = Array.from({ length: 24 }, (_, i) => [i, `${String(i).padStart(2, '0')}:00`]);
    const form = ui.form('/admin/settings/backups', csrf, `
      <label class="check"><input type="checkbox" name="backup_auto" value="1" ${st.backup_auto !== '0' ? 'checked' : ''}> ${ui.esc(tr('bak|Back up automatically every night'))}</label>
      <div class="fields">
        ${ui.select('backup_hour', tr('bak|After (Cairo time)'), hours, Number(st.backup_hour) || 0)}
        ${ui.input('backup_keep_days', tr('bak|Keep on the server (days)'), st.backup_keep_days, { type: 'number', min: 1, max: 365 })}
        ${ui.input('backup_email_to', tr('bak|Email a copy to'), st.backup_email_to, { cls: 'span-all', placeholder: 'it@thewavemall.com', hint: tr('bak|Up to five addresses, separated by commas. Only addresses you control: the file holds every record, salaries included.') })}
        ${ui.input('backup_email_max_mb', tr('bak|Email it when smaller than (MB)'), st.backup_email_max_mb, { type: 'number', min: 1, max: 40, hint: tr('bak|Most mail servers refuse attachments over 20–25 MB.') })}
      </div>
      ${ui.btn(ui.esc(tr('bak|Save backup settings')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' });
    const offsite = s3.ok
      ? `<p class="intstate intstate--on">${ui.icon('check')}${ui.esc(tr('bak|Off-site storage is set up: {where}', { where: `${new URL(s3.endpoint.replace('{bucket}', s3.bucket)).host}/${s3.bucket}` }))}</p>`
      : `<p class="muted small">${tr('bak|For a copy away from this server, set {vars} in the hosting panel (see Integrations).', { vars: ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY', 'BACKUP_S3_SECRET', 'BACKUP_S3_REGION'].map((v) => `<code>${v}</code>`).join(' ') })}</p>`;
    const restore = `<details class="bak__restore"><summary>${ui.icon('back')}<span>${ui.esc(tr('bak|How to restore a backup'))}</span></summary><ol class="bak__steps">
      <li>${tr('bak|Download the backup you want (the download is the ready database file; an emailed or off-site copy ends in {ext}: unzip it first with 7-Zip or your computer\'s built-in tool).', { ext: '<code>.gz</code>' })}</li>
      <li>${ui.esc(tr('bak|In the hosting panel, stop the application.'))}</li>
      <li>${tr('bak|In the data folder, rename the current database file to keep it, delete the files next to it ending in {wal} and {shm}, and upload the backup under the database file\'s name:', { wal: '<code>-wal</code>', shm: '<code>-shm</code>' })} <code>${ui.esc(path.basename(db.file === ':memory:' ? 'leasing.db' : db.file))}</code></li>
      <li>${ui.esc(tr('bak|Start the application again and check the dashboard. Anything entered after the backup was taken has to be entered again.'))}</li>
    </ol><p class="muted small">${tr('Stored at {path}', { path: `<code>${ui.esc(db.file)}</code>` })}</p></details>`;
    return `<section id="backups">${ui.card(tr('Backup'), `${lastHtml}
      <div class="row wrap">${ui.form('/admin/settings/backups/run', csrf, ui.btn(ui.esc(tr('bak|Back up now')), { cls: 'btn--primary btn--sm', ic: 'check' }))}${ui.btn(tr('Download backup'), { href: '/admin/settings/backup', cls: 'btn--ghost btn--sm', ic: 'dl' })}</div>
      ${offsite}
      <h3 class="card__h3">${ui.esc(tr('bak|Kept on the server'))}</h3>${files}
      <h3 class="card__h3">${ui.esc(tr('bak|Schedule and copies'))}</h3>${form}
      ${restore}`, { sub: ui.esc(tr('bak|Every night a checked, compressed copy of the whole database is kept here and, when set up, sent off the server.')) })}</section>`;
  }

  // ---------- settings ----------
  router.get('/settings', R('admin'), (req, res) => {
    const s = db.settings();
    const csrf = req.session.csrf;
    const hasDemo = db.value('SELECT COUNT(*) FROM leads WHERE demo = 1') > 0;
    const cur = ui.curLabel();
    const body = `<div class="grid grid--side">
<div class="stack">${ui.form('/admin/settings', csrf, `
  ${ui.card(tr('List rates'), `<div class="fields">
    ${ui.input('rate_plaza', tr('Plaza units: rent per m² / month ({cur})', { cur }), s.rate_plaza, { type: 'number', min: 0, step: '0.01', hint: tr('The default for G01–G16. Any unit can override it.') })}
    ${ui.input('rate_street', tr('Street units: rent per m² / month ({cur})', { cur }), s.rate_street, { type: 'number', min: 0, step: '0.01' })}
    ${ui.input('rate_terrace_share', tr('Terraces, as % of the indoor rate'), s.rate_terrace_share, { type: 'number', min: 0, max: 100, step: 1 })}
    ${ui.input('service_m2', tr('o|Service charge per m² / month'), s.service_m2, { type: 'number', min: 0, step: '0.01' })}
  </div>`)}
  ${ui.card(tr('Deal rules'), `<div class="fields">
    ${ui.input('default_term_years', tr('Standard term (years)'), s.default_term_years, { type: 'number', min: 1, max: 30 })}
    ${ui.input('default_escalation', tr('Standard yearly increase (%)'), s.default_escalation, { type: 'number', min: 0, step: '0.5' })}
    ${ui.input('default_deposit_months', tr('Standard deposit (months)'), s.default_deposit_months, { type: 'number', min: 0 })}
    ${ui.input('max_discount_pct', tr('Agents may discount up to (%)'), s.max_discount_pct, { type: 'number', min: 0, max: 100, hint: tr('Deeper discounts go to a manager for approval.') })}
    ${ui.input('offer_valid_days', tr('Offers valid for (days)'), s.offer_valid_days, { type: 'number', min: 1 })}
    ${ui.input('hold_days', tr('Unit holds last (days)'), s.hold_days, { type: 'number', min: 1, max: 60 })}
    ${ui.input('vat_pct', tr('VAT on invoices (%)'), s.vat_pct, { type: 'number', min: 0, max: 30, step: '0.5', hint: tr('Added to new invoices (deposits excluded) and posted to the books. 0 to leave it off.') })}
    ${ui.input('currency', tr('Currency'), s.currency, { required: true, hint: tr('A three-letter code, e.g. EGP.'), attrs: { maxlength: 3 } })}
  </div>`)}
  <section id="people">${ui.card(tr('People & payroll'), `<div class="fields">
    ${ui.input('si_employee_pct', tr('Social insurance, employee share (%)'), s.si_employee_pct, { type: 'number', min: 0, max: 50, step: '0.01' })}
    ${ui.input('si_employer_pct', tr('Social insurance, employer share (%)'), s.si_employer_pct, { type: 'number', min: 0, max: 50, step: '0.01' })}
    ${ui.input('si_min_wage', tr('Minimum insured wage ({cur})', { cur }), s.si_min_wage, { type: 'number', min: 0, step: 1 })}
    ${ui.input('si_max_wage', tr('Maximum insured wage ({cur})', { cur }), s.si_max_wage, { type: 'number', min: 0, step: 1 })}
    ${ui.input('annual_leave_days', tr('Annual leave (days)'), s.annual_leave_days, { type: 'number', min: 0, max: 60, hint: tr('30 days apply automatically after ten years of service or from age 50.') })}
    ${ui.input('work_days_month', tr('Working days a month'), s.work_days_month, { type: 'number', min: 1, max: 31, hint: tr('Used for the daily rate of unpaid leave.') })}
  </div><p class="muted small">${tr('Egyptian social-insurance shares and the insured-wage limits are revised each January. Check them against the latest decree before running January payroll.')}</p>`)}</section>
  ${ui.card(tr('Document vault'), `<div class="fields">
    ${ui.input('doc_warn_days', tr('Warn before a document expires (days)'), s.doc_warn_days, { type: 'number', min: 1, max: 365 })}
  </div>`)}
  ${ui.card(tr('On proposals and invoices'), `<div class="fields">
    ${ui.input('legal_name', tr('Company name'), s.legal_name, { required: true })}
    ${ui.input('company', tr('Display name'), s.company)}
    ${ui.input('address', tr('Address'), s.address, { cls: 'span-all' })}
    ${ui.input('leasing_email', tr('Leasing email'), s.leasing_email, { type: 'email' })}
    ${ui.input('leasing_phone', tr('Leasing phone'), s.leasing_phone, { type: 'tel' })}
  </div>`)}
  <div class="row">${ui.btn(tr('Save settings'), { cls: 'btn--primary' })}</div>`, { cls: 'stack' })}</div>
<div class="stack">
  ${backupCard(req)}
  ${ui.card(tr('Sample data'), hasDemo
    ? `<p class="muted">${tr('The office has sample brands, leads, offers and leases in it. Clear them before you start for real; your own records stay.')}</p>${ui.form('/admin/settings/demo/clear', csrf, ui.btn(tr('Clear sample data'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('Remove all sample data?') } }))}`
    : `<p class="muted">${tr('Fill the office with a realistic sample pipeline to explore every screen. You can clear it with one click.')}</p>${ui.form('/admin/settings/demo', csrf, ui.btn(tr('Load sample data'), { cls: 'btn--ghost btn--sm' }))}`)}
</div>
</div>`;
    h.page(req, res, { title: tr('Settings'), active: '/admin/settings', body });
  });

  // numbers that must stay within sensible limits; anything else keeps its saved value
  const NUM_KEYS = { si_employee_pct: [0, 50], si_employer_pct: [0, 50], si_min_wage: [0, 1e7], si_max_wage: [0, 1e7], annual_leave_days: [0, 60], work_days_month: [1, 31], doc_warn_days: [1, 365] };
  const KEYS = [...Object.keys(NUM_KEYS), 'rate_plaza', 'rate_street', 'rate_terrace_share', 'service_m2', 'default_term_years', 'default_escalation', 'default_deposit_months', 'max_discount_pct', 'offer_valid_days', 'hold_days', 'vat_pct', 'currency', 'legal_name', 'company', 'address', 'leasing_email', 'leasing_phone'];
  router.post('/settings', R('admin'), (req, res) => {
    for (const k of KEYS) {
      if (req.body[k] === undefined) continue;
      if (NUM_KEYS[k]) {
        const n = h.numv(req.body[k]);
        if (n !== null && n >= NUM_KEYS[k][0] && n <= NUM_KEYS[k][1]) db.setSetting(k, String(n));
        continue;
      }
      db.setSetting(k, k === 'currency' ? h.str(req.body[k], 3).toUpperCase() || 'EGP' : h.str(req.body[k], 300));
    }
    if (Number(db.setting('si_min_wage')) > Number(db.setting('si_max_wage'))) db.setSetting('si_max_wage', db.setting('si_min_wage'));
    ui.setCurrency(db.setting('currency'));
    for (const l of db.all(`SELECT * FROM leads WHERE stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')}) AND id NOT IN (SELECT lead_id FROM offers)`)) db.run('UPDATE leads SET value_est = ? WHERE id = ?', M.estimateValue(db, l), l.id);
    h.log(req, 'Updated settings', 'settings');
    h.back(req, res, '/admin/settings', 'ok', tr('Settings saved. Lead values were recalculated with the new rates.'));
  });

  router.get('/settings/backup', R('admin'), (req, res) => {
    const file = path.join(os.tmpdir(), `the-wave-leasing-${Date.now()}.db`);
    db.backup(file);
    h.log(req, 'Downloaded a backup', 'settings');
    res.download(file, `the-wave-leasing-${M.today()}.db`, () => fs.rm(file, { force: true }, () => {}));
  });

  router.post('/settings/backups/run', R('admin'), async (req, res) => {
    const r = await backups.run({ trigger: 'manual', user: req.user });
    if (r.busy) return h.back(req, res, '/admin/settings#backups', 'error', tr('bak|A backup is already running. Try again in a minute.'));
    h.log(req, 'Backed up the database', 'settings', null, r.file || r.error || '');
    if (r.status === 'failed') return h.back(req, res, '/admin/settings#backups', 'error', tr('bak|The backup failed: {error}', { error: r.error }));
    const copies = [r.email_status === 'sent' ? tr('bak|emailed') : '', r.s3_status === 'sent' ? tr('bak|sent to off-site storage') : ''].filter(Boolean);
    if (r.status === 'partial') return h.back(req, res, '/admin/settings#backups', 'error', tr('bak|Backup saved on the server, but a copy could not be sent. See the details below.'));
    h.back(req, res, '/admin/settings#backups', 'ok', copies.length ? tr('bak|Backup saved ({size}) and {copies}.', { size: MB(r.bytes), copies: copies.join(isAr() ? ' و' : ' and ') }) : tr('bak|Backup saved ({size}).', { size: MB(r.bytes) }));
  });
  router.post('/settings/backups', R('admin'), (req, res) => {
    const n = (v, lo, hi, d) => {
      const x = h.int(v);
      return x === null || x < lo || x > hi ? d : x;
    };
    const cur = backups.settings();
    db.setSetting('backup_auto', req.body.backup_auto ? '1' : '0');
    db.setSetting('backup_hour', String(n(req.body.backup_hour, 0, 23, Number(cur.backup_hour))));
    db.setSetting('backup_keep_days', String(n(req.body.backup_keep_days, 1, 365, Number(cur.backup_keep_days))));
    db.setSetting('backup_email_max_mb', String(n(req.body.backup_email_max_mb, 1, 40, Number(cur.backup_email_max_mb))));
    const raw = h.str(req.body.backup_email_to, 400);
    const emails = raw.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const bad = emails.filter((x) => !EMAIL_RE.test(x));
    if (bad.length) return h.back(req, res, '/admin/settings#backups', 'error', tr('bak|Not a valid email address: {email}', { email: bad[0] }));
    db.setSetting('backup_email_to', emails.slice(0, 5).join(', '));
    h.log(req, 'Updated settings', 'settings', null, 'Backups');
    h.back(req, res, '/admin/settings#backups', 'ok', tr('Saved.'));
  });
  // a kept backup, unzipped into the ready database file (?gz=1 for the compressed file as kept)
  router.get('/settings/backups/file/:name', R('admin'), (req, res, next) => {
    const file = backups.file(req.params.name);
    if (!file) return next();
    h.log(req, 'Downloaded a backup', 'settings', null, req.params.name);
    if (req.query.gz) return res.download(file, req.params.name);
    res.attachment(req.params.name.replace(/\.gz$/, '')).type('application/vnd.sqlite3');
    fs.createReadStream(file).pipe(require('node:zlib').createGunzip()).on('error', () => res.destroy()).pipe(res);
  });

  router.post('/settings/demo', R('admin'), (req, res) => {
    demo.load(db, req.user, { files: h.files, billing: h.billing, h });
    h.log(req, 'Loaded sample data', 'settings');
    h.back(req, res, '/admin', 'ok', tr('Sample data loaded. Explore freely, then clear it in Settings.'));
  });
  router.post('/settings/demo/clear', R('admin'), (req, res) => {
    demo.clear(db, { files: h.files, billing: h.billing, h });
    h.log(req, 'Cleared sample data', 'settings');
    h.back(req, res, '/admin/settings', 'ok', tr('Sample data cleared.'));
  });

  // ---------- activity log ----------
  router.get('/audit', R('manager'), (req, res) => {
    const who = h.int(req.query.user);
    const rows = db.all(`SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id ${who ? 'WHERE a.user_id = ?' : ''} ORDER BY a.id DESC LIMIT 400`, ...(who ? [who] : []));
    const link = (a) => ({ lead: `/admin/leads/${a.entity_id}`, offer: `/admin/offers/${a.entity_id}`, lease: `/admin/leases/${a.entity_id}`, unit: `/admin/units/${a.entity_id}`, brand: `/admin/brands/${a.entity_id}`, invoice: `/admin/invoices/${a.entity_id}` })[a.entity];
    const filter = `<form class="filters" method="get">${ui.select('user', tr('Person'), db.all('SELECT id, name FROM users ORDER BY name').map((u) => [u.id, u.name]), who, { blank: tr('o|Everyone'), cls: 'f--inline' })}${ui.btn(tr('o|Filter'), { cls: 'btn--ghost btn--sm' })}</form>`;
    const detail = (a) => (a.entity === 'export' && EXPORT_LABELS[a.detail] ? tr(EXPORT_LABELS[a.detail]) : a.entity === 'export' ? tr(a.detail) : tx(a.detail));
    const table = ui.table(
      [
        { label: tr('log|When'), render: (a) => ui.dt(a.created_at) },
        { label: tr('Who'), render: (a) => ui.esc(a.user_name || tr('System / website')) },
        { label: tr('What'), render: (a) => `<b>${ui.esc(tx(a.action))}</b>` },
        { label: tr('Detail'), render: (a) => (link(a) && a.entity_id ? `<a href="${link(a)}">${ui.esc(detail(a) || tr('link|Open'))}</a>` : ui.esc(detail(a) || '')) },
        { label: tr('IP'), render: (a) => `<span class="muted ltr">${ui.esc(a.ip || '')}</span>` },
      ],
      rows,
    );
    h.page(req, res, { title: tr('Activity log'), active: '/admin/audit', wide: true, body: `${filter}${ui.card(tr('Every change, sign-in and export'), table, { sub: ui.esc(tr('The latest 400 entries')) })}` });
  });
};
