'use strict';

// The office: reports, CSV exports, the team and targets, subscribers, settings and the activity log.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashPassword } = require('../db');
const demo = require('../demo');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function csv(rows, cols) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  return `﻿${[cols.map(([, l]) => cell(l)).join(','), ...rows.map((r) => cols.map(([k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\r\n')}\r\n`;
}

module.exports = function office(router, h) {
  const { db, ui, M, auth } = h;
  const R = auth.requireRole;

  // ---------- reports ----------
  router.get('/reports', (req, res) => {
    const r = M.reports(db);
    const d = M.dashboard(db, null);
    const occ = r.zones.map((z) => `<div class="stack-bar"><p><b>${ui.esc(z.label)}</b><span>${z.units} units · ${ui.m2(z.total)}</span></p>
      <div class="sbar"><i class="t-forest" style="width:${(z.leased / z.total) * 100}%" title="Leased ${ui.m2(z.leased)}"></i><i class="t-cocoa" style="width:${(z.reserved / z.total) * 100}%" title="Reserved / on hold ${ui.m2(z.reserved)}"></i><i class="t-sand" style="width:${(z.available / z.total) * 100}%" title="Available ${ui.m2(z.available)}"></i></div>
      <ul class="legend legend--row"><li><i class="t-forest"></i>Leased ${ui.pct(z.leased / z.total)}</li><li><i class="t-cocoa"></i>Reserved or held ${ui.pct(z.reserved / z.total)}</li><li><i class="t-sand"></i>Available ${ui.pct(z.available / z.total)}</li></ul></div>`).join('');
    const rentRoll = ui.table(
      [
        { label: 'Tenant', render: (x) => `<a href="/admin/leases/${x.id}"><b>${ui.esc(x.brand)}</b></a><small class="sub">${ui.esc(M.CATEGORIES[x.category])}</small>` },
        { label: 'Units', render: (x) => ui.esc(x.units) },
        { label: 'Area', num: true, render: (x) => ui.m2(x.area) },
        { label: 'Annual rent', num: true, render: (x) => ui.money(x.annual, { cur: false }) },
        { label: 'Rent / m² / month', num: true, render: (x) => ui.money(x.area ? x.annual / 12 / x.area : 0, { cur: false }) },
        { label: 'Expires', render: (x) => ui.date(x.end_date) },
        { label: 'Years left', num: true, render: (x) => x.remaining.toFixed(1) },
      ],
      r.rentRoll,
      { empty: 'No active leases yet.' },
    );
    const agents = ui.table(
      [
        { label: 'Agent', render: (a) => `<span class="who"><span class="avatar avatar--sm">${ui.esc(ui.initials(a.name))}</span>${ui.esc(a.name)}</span>` },
        { label: 'Open deals', num: true, render: (a) => ui.n0(a.open) },
        { label: 'Weighted pipeline', num: true, render: (a) => ui.money(a.weighted, { compact: true }) },
        { label: 'New leads this month', render: (a) => `${a.leadsMonth}${a.target && a.target.leads ? ` / ${a.target.leads} ${ui.meter(a.leadsMonth / a.target.leads, 'sea')}` : ''}` },
        { label: 'Viewings this month', render: (a) => `${a.viewings}${a.target && a.target.viewings ? ` / ${a.target.viewings} ${ui.meter(a.viewings / a.target.viewings, 'sand')}` : ''}` },
        { label: 'Offers this month', num: true, render: (a) => ui.n0(a.offers) },
        { label: 'Signed (all time)', num: true, render: (a) => `${a.won} · ${ui.money(a.wonValue, { compact: true })}` },
      ],
      r.agents,
      { empty: 'Add your team to see their numbers.' },
    );
    const sources = ui.table(
      [
        { label: 'Source', render: (s) => ui.esc(s.label) },
        { label: 'Leads', num: true, render: (s) => ui.n0(s.leads) },
        { label: 'Signed', num: true, render: (s) => ui.n0(s.won) },
        { label: 'Conversion', render: (s) => `${ui.pct(s.rate)} ${ui.meter(s.rate, 'forest')}` },
        { label: 'Signed value / yr', num: true, render: (s) => ui.money(s.value, { compact: true }) },
      ],
      r.sources,
      { empty: 'No leads yet.' },
    );
    const forecast = ui.table(
      [
        { label: 'Stage', render: (s) => ui.stageBadge(s.id) },
        { label: 'Deals', num: true, render: (s) => ui.n0(s.count) },
        { label: 'Probability', num: true, render: (s) => `${s.p}%` },
        { label: 'Annual value', num: true, render: (s) => ui.money(s.value, { compact: true }) },
        { label: 'Weighted', num: true, render: (s) => `<b>${ui.money(s.weighted, { compact: true })}</b>` },
      ],
      r.forecast,
    ) + `<p class="total">Weighted annual rent in the pipeline: <b>${ui.money(r.forecast.reduce((s, f) => s + f.weighted, 0))}</b></p>`;
    const lost = r.lostReasons.length ? ui.donut(r.lostReasons.map((x) => ({ label: x.reason, value: x.n })), { label: ui.n0(r.lostReasons.reduce((s, x) => s + x.n, 0)) }) : '<p class="muted pad">No lost deals. Long may it last.</p>';
    const mix = r.mix.length ? ui.donut(r.mix.map((m) => ({ label: m.label, value: m.area, display: ui.m2(m.area) })), { label: ui.m2(r.mix.reduce((s, m) => s + m.area, 0)).replace(' m²', '') }) : '<p class="muted pad">The mix appears as leases are signed.</p>';
    const expiries = r.expiries.length ? `<ul class="list">${r.expiries.map((x) => `<li><a href="/admin/leases/${x.id}"><span class="what"><b>${ui.esc(x.brand)}</b><small>${ui.esc(x.units)} · ${ui.money(x.annual, { compact: true })} a year</small></span><span class="late">${ui.date(x.end_date)}</span></a></li>`).join('')}</ul>` : '<p class="muted pad">No lease ends in the next 12 months.</p>';
    const exports = `<div class="row wrap">${[['leads', 'Leads'], ['units', 'Units'], ['rentroll', 'Rent roll'], ['invoices', 'Invoices'], ['offers', 'Offers'], ['activities', 'Activities']].map(([k, l]) => ui.btn(l, { href: `/admin/export/${k}.csv`, cls: 'btn--ghost btn--sm', ic: 'dl' })).join('')}</div>`;
    const body = `<div class="kpis">
  ${ui.kpi({ label: 'Occupancy', value: ui.pct(d.occupancy, 1), bar: d.occupancy, sub: `${ui.m2(d.leased)} of ${ui.m2(d.gla)}` })}
  ${ui.kpi({ label: 'Contracted rent', value: ui.money(r.totalAnnual, { compact: true }), sub: 'a year, current rates' })}
  ${ui.kpi({ label: 'WALE', value: `${r.wale.toFixed(1)} <small>years</small>`, sub: 'Weighted average lease expiry' })}
  ${ui.kpi({ label: 'Weighted pipeline', value: ui.money(d.weighted, { compact: true }), sub: `${d.openCount} open deals` })}
  ${ui.kpi({ label: 'Win rate', value: d.conversion === null ? '—' : ui.pct(d.conversion), sub: 'Signed of all closed deals' })}
  ${ui.kpi({ label: 'Overdue', value: ui.money(d.overdue.amount, { compact: true }), tone: d.overdue.amount ? 'kpi--alert' : '' })}
</div>
<div class="grid">
  ${ui.card('Occupancy by level', occ, { cls: 'span-2' })}
  ${ui.card('Tenant mix', mix, { sub: 'Leased area by category' })}
  ${ui.card('Rent roll', rentRoll, { cls: 'span-3', action: ui.btn('CSV', { href: '/admin/export/rentroll.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}
  ${ui.card('Forecast', forecast, { cls: 'span-2', sub: 'Annual rent by stage, weighted by probability' })}
  ${ui.card('Why deals are lost', lost)}
  ${ui.card('Team this month', agents, { cls: 'span-3', action: h.can(req, 'manager') ? ui.btn('Set targets', { href: '/admin/team#targets', cls: 'btn--ghost btn--sm' }) : '' })}
  ${ui.card('Lead sources', sources, { cls: 'span-2' })}
  ${ui.card('Receivables aging', ui.bars(r.aging, { key: 'amount', label: 'label', fmtv: (n) => ui.money(n, { compact: true, cur: false }), tone: 'cocoa' }))}
  ${ui.card('Leases ending within a year', expiries, { cls: 'span-2' })}
  ${ui.card('Export', `<p class="muted">Spreadsheet-ready CSV files.</p>${exports}`)}
</div>`;
    h.page(req, res, { title: 'Reports', active: '/admin/reports', wide: true, body, actions: ui.btn('Print', { type: 'button', cls: 'btn--ghost', ic: 'print', attrs: { 'data-print': true } }) });
  });

  // ---------- CSV exports ----------
  const EXPORTS = {
    leads: () => [db.all('SELECT l.*, b.name brand, u.name owner FROM leads l LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN users u ON u.id = l.owner_id ORDER BY l.id'), [['ref', 'Ref'], ['title', 'Lead'], ['brand', 'Brand'], [(r) => M.CATEGORIES[r.category], 'Category'], [(r) => M.SOURCES[r.source], 'Source'], [(r) => M.stage(r.stage).label, 'Stage'], ['probability', 'Probability %'], ['area_min', 'Area from'], ['area_max', 'Area to'], ['budget_m2', 'Budget / m²'], ['value_est', 'Annual value'], ['owner', 'Owner'], ['next_step', 'Next step'], ['next_step_at', 'Next step due'], ['lost_reason', 'Lost reason'], ['created_at', 'Created']]],
    units: () => [db.all('SELECT * FROM units ORDER BY sort'), [['code', 'Unit'], [(u) => M.ZONES[u.zone], 'Level'], ['indoor_m2', 'Indoor m²'], ['terrace_m2', 'Terrace m²'], [(u) => M.UNIT_STATUS[u.status], 'Status'], [(u) => M.listRates(db, u).rent, 'List rent / m²'], [(u) => M.listRates(db, u).terrace, 'Terrace / m²'], ['hold_until', 'Hold until']]],
    rentroll: () => [M.reports(db).rentRoll, [['ref', 'Lease'], ['brand', 'Tenant'], [(x) => M.CATEGORIES[x.category], 'Category'], ['units', 'Units'], ['area', 'Area m²'], [(x) => Math.round(x.annual), 'Annual rent'], ['start_date', 'Start'], ['end_date', 'End'], [(x) => x.remaining.toFixed(2), 'Years left']]],
    invoices: () => [db.all('SELECT i.*, s.ref lease, b.name tenant FROM invoices i JOIN leases s ON s.id = i.lease_id JOIN brands b ON b.id = s.brand_id ORDER BY i.due_date'), [['ref', 'Invoice'], ['tenant', 'Tenant'], ['lease', 'Lease'], ['kind', 'Kind'], ['period_start', 'From'], ['period_end', 'To'], ['due_date', 'Due'], ['rent', 'Rent'], ['service', 'Service'], ['other', 'Other'], ['total', 'Total'], ['paid', 'Paid'], [(i) => M.INVOICE_STATUS[i.status], 'Status'], ['paid_at', 'Paid on']]],
    offers: () => [db.all('SELECT o.*, l.title lead FROM offers o JOIN leads l ON l.id = o.lead_id ORDER BY o.id'), [['ref', 'Offer'], ['lead', 'Lead'], [(o) => M.offerUnits(db, o.id).map((u) => u.code).join(' '), 'Units'], ['rent_m2', 'Rent / m²'], ['term_years', 'Years'], ['escalation_pct', 'Increase %'], ['rent_free_months', 'Rent-free'], [(o) => M.OFFER_STATUS[o.status], 'Status'], ['valid_until', 'Valid until'], ['created_at', 'Created']]],
    activities: () => [db.all('SELECT a.*, l.title lead, u.name user FROM activities a LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id'), [['type', 'Type'], ['subject', 'Subject'], ['lead', 'Lead'], ['user', 'By'], ['due_at', 'Due'], ['done_at', 'Done'], ['created_at', 'Created']]],
    subscribers: () => [db.all('SELECT * FROM subscribers ORDER BY created_at DESC'), [['email', 'Email'], ['lang', 'Language'], ['source', 'Source'], ['created_at', 'Joined']]],
  };
  router.get('/export/:what.csv', (req, res, next) => {
    const make = EXPORTS[req.params.what];
    if (!make) return next();
    const [rows, cols] = make();
    h.log(req, 'Exported', 'export', null, req.params.what);
    res.set('Content-Disposition', `attachment; filename="the-wave-${req.params.what}-${M.today()}.csv"`).type('text/csv; charset=utf-8').send(csv(rows, cols));
  });

  // ---------- team & targets ----------
  router.get('/team', (req, res) => {
    const users = db.all('SELECT * FROM users ORDER BY active DESC, name');
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : M.today().slice(0, 7);
    const isAdmin = h.can(req, 'admin');
    const csrf = req.session.csrf;
    const stats = (u) => ({
      open: db.value(`SELECT COUNT(*) FROM leads WHERE owner_id = ? AND stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')})`, u.id),
      won: db.value("SELECT COUNT(*) FROM leads WHERE owner_id = ? AND stage = 'won'", u.id),
    });
    const table = ui.table(
      [
        { label: 'Person', render: (u) => `<span class="who"><span class="avatar avatar--sm">${ui.esc(ui.initials(u.name))}</span><span><b>${ui.esc(u.name)}</b><small class="sub">${ui.esc(u.email)}</small></span></span>` },
        { label: 'Role', render: (u) => ui.badge(u.role, M.ROLES[u.role]) },
        { label: 'Open deals', num: true, render: (u) => ui.n0(stats(u).open) },
        { label: 'Signed', num: true, render: (u) => ui.n0(stats(u).won) },
        { label: 'Last sign-in', render: (u) => (u.last_login_at ? ui.rel(u.last_login_at) : 'Never') },
        { label: 'Status', render: (u) => (u.active ? ui.badge('active', 'Active') : ui.badge('void', 'Disabled')) },
        ...(isAdmin ? [{ label: '', render: (u) => (u.id === req.user.id ? '<span class="muted">You</span>' : `<details class="pop"><summary class="btn btn--ghost btn--xs">Manage</summary>${ui.form(`/admin/team/${u.id}`, csrf, `${ui.select('role', 'Role', M.ROLES, u.role)}<label class="check"><input type="checkbox" name="active" value="1" ${u.active ? 'checked' : ''}> Can sign in</label><label class="check"><input type="checkbox" name="reset" value="1"> Reset password</label>${ui.btn('Save', { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>`) }] : []),
      ],
      users,
    );
    const invite = isAdmin
      ? ui.card('Add someone', ui.form('/admin/team', csrf, `<div class="fields">${ui.input('name', 'Name', '', { required: true })}${ui.input('email', 'Email', '', { type: 'email', required: true })}${ui.select('role', 'Role', M.ROLES, 'agent')}${ui.input('title', 'Title', '', { placeholder: 'e.g. Leasing executive' })}</div><p class="muted">A password is generated and shown to you once, to pass on securely.</p>${ui.btn('Add to the team', { cls: 'btn--primary' })}`, { cls: 'stack' }), { sub: `<b>Agents</b> work their leads and offers. <b>Managers</b> approve discounts, sign leases and record payments. <b>Viewers</b> can only look.` })
      : '';
    const agents = users.filter((u) => u.active && u.role !== 'viewer');
    const targets = h.can(req, 'manager')
      ? ui.card(`Targets for ${new Date(`${period}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`, ui.form(`/admin/team/targets?period=${period}`, csrf, `<input type="hidden" name="period" value="${period}"><div class="tablewrap"><table class="table"><thead><tr><th>Person</th><th>New leads</th><th>Viewings</th><th>Signed m²</th><th>Signed rent / yr</th></tr></thead><tbody>${agents.map((u) => {
          const t = db.get('SELECT * FROM targets WHERE period = ? AND user_id = ?', period, u.id) || {};
          return `<tr><td>${ui.esc(u.name)}</td>${['leads', 'viewings', 'signed_m2', 'revenue'].map((k) => `<td><input class="cellin" type="number" min="0" name="${k}_${u.id}" value="${t[k] ?? ''}"></td>`).join('')}</tr>`;
        }).join('')}</tbody></table></div><div class="row">${ui.btn('Save targets', { cls: 'btn--primary btn--sm' })}<a class="btn btn--ghost btn--sm" href="/admin/team?period=${M.addMonths(`${period}-01`, -1).slice(0, 7)}#targets">← Previous month</a><a class="btn btn--ghost btn--sm" href="/admin/team?period=${M.addMonths(`${period}-01`, 1).slice(0, 7)}#targets">Next month →</a></div>`, { cls: 'stack', attrs: { id: 'targets' } }))
      : '';
    h.page(req, res, { title: 'Team & targets', active: '/admin/team', wide: true, body: `<div class="grid grid--side"><div class="stack">${ui.card('The leasing team', table)}${targets}</div><div class="stack">${invite}${ui.card('Your account', `<p>${ui.btn('Change your password', { href: '/admin/me', cls: 'btn--ghost btn--sm' })}</p>`)}</div></div>` });
  });

  router.post('/team', R('admin'), (req, res) => {
    const name = h.str(req.body.name, 120);
    const email = h.str(req.body.email, 200).toLowerCase();
    const role = M.ROLES[req.body.role] ? req.body.role : 'agent';
    if (!name || !EMAIL_RE.test(email)) return h.back(req, res, '/admin/team', 'error', 'Enter a name and a valid email.');
    if (db.get('SELECT id FROM users WHERE email = ?', email)) return h.back(req, res, '/admin/team', 'error', 'Someone already uses that email.');
    const password = auth.token(9);
    const r = db.run('INSERT INTO users (name, email, role, title, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', name, email, role, h.str(req.body.title, 120) || null, hashPassword(password), M.now());
    h.log(req, 'Added a team member', 'user', Number(r.lastInsertRowid), `${name} (${M.ROLES[role]})`);
    h.back(req, res, '/admin/team', 'ok', `${name} added. Their temporary password is ${password} (shown once). They can change it under Your account.`);
  });

  router.post('/team/targets', R('manager'), (req, res) => {
    const period = /^\d{4}-\d{2}$/.test(req.body.period || '') ? req.body.period : M.today().slice(0, 7);
    for (const u of db.all("SELECT id FROM users WHERE active = 1 AND role != 'viewer'")) {
      const v = (k) => Math.max(0, h.numv(req.body[`${k}_${u.id}`]) || 0);
      db.run('INSERT INTO targets (period, user_id, leads, viewings, signed_m2, revenue) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(period, user_id) DO UPDATE SET leads = excluded.leads, viewings = excluded.viewings, signed_m2 = excluded.signed_m2, revenue = excluded.revenue', period, u.id, v('leads'), v('viewings'), v('signed_m2'), v('revenue'));
    }
    h.log(req, 'Set targets', 'targets', null, period);
    h.back(req, res, `/admin/team?period=${period}#targets`, 'ok', 'Targets saved.');
  });

  router.post('/team/:id', R('admin'), (req, res, next) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!u) return next();
    if (u.id === req.user.id) return h.back(req, res, '/admin/team', 'error', 'Change your own account under Your account.');
    const role = M.ROLES[req.body.role] ? req.body.role : u.role;
    const active = req.body.active ? 1 : 0;
    if (u.role === 'admin' && (role !== 'admin' || !active) && db.value("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1") <= 1) return h.back(req, res, '/admin/team', 'error', 'Keep at least one active administrator.');
    db.run('UPDATE users SET role = ?, active = ? WHERE id = ?', role, active, u.id);
    let msg = `${u.name} updated.`;
    if (!active || req.body.reset) db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    if (req.body.reset) {
      const password = auth.token(9);
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
      msg = `${u.name}'s new temporary password is ${password} (shown once).`;
    }
    h.log(req, 'Updated a team member', 'user', u.id, `${u.name}: ${M.ROLES[role]}${active ? '' : ', disabled'}${req.body.reset ? ', password reset' : ''}`);
    h.back(req, res, '/admin/team', 'ok', msg);
  });

  // ---------- subscribers ----------
  router.get('/subscribers', (req, res) => {
    const rows = db.all('SELECT * FROM subscribers ORDER BY created_at DESC LIMIT 1000');
    const total = db.value('SELECT COUNT(*) FROM subscribers');
    const month = db.value('SELECT COUNT(*) FROM subscribers WHERE substr(created_at, 1, 7) = ?', M.today().slice(0, 7));
    const ar = db.value("SELECT COUNT(*) FROM subscribers WHERE lang = 'ar'");
    const body = `<div class="kpis kpis--3">${ui.kpi({ label: 'Subscribers', value: ui.n0(total) })}${ui.kpi({ label: 'Joined this month', value: ui.n0(month) })}${ui.kpi({ label: 'Arabic / English', value: `${ui.pct(total ? ar / total : 0)} <small>Arabic</small>` })}</div>
${ui.card('Opening news list', ui.table([{ label: 'Email', render: (s) => `<a href="mailto:${ui.esc(s.email)}">${ui.esc(s.email)}</a>` }, { label: 'Language', render: (s) => (s.lang === 'ar' ? 'Arabic' : 'English') }, { label: 'Source', render: (s) => ui.esc(s.source || 'website') }, { label: 'Joined', render: (s) => ui.date(s.created_at) }], rows, { empty: 'Sign-ups from the website footer appear here.' }), { action: ui.btn('Export CSV', { href: '/admin/export/subscribers.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`;
    h.page(req, res, { title: 'Subscribers', active: '/admin/subscribers', body });
  });

  // ---------- settings ----------
  router.get('/settings', R('admin'), (req, res) => {
    const s = db.settings();
    const csrf = req.session.csrf;
    const hasDemo = db.value('SELECT COUNT(*) FROM leads WHERE demo = 1') > 0;
    const body = `<div class="grid grid--side">
<div class="stack">${ui.form('/admin/settings', csrf, `
  ${ui.card('List rates', `<div class="fields">
    ${ui.input('rate_plaza', `Plaza units: rent per m² / month (${ui.esc(s.currency)})`, s.rate_plaza, { type: 'number', min: 0, step: '0.01', hint: 'The default for G01–G16. Any unit can override it.' })}
    ${ui.input('rate_street', `Street units: rent per m² / month (${ui.esc(s.currency)})`, s.rate_street, { type: 'number', min: 0, step: '0.01' })}
    ${ui.input('rate_terrace_share', 'Terraces, as % of the indoor rate', s.rate_terrace_share, { type: 'number', min: 0, max: 100, step: 1 })}
    ${ui.input('service_m2', 'Service charge per m² / month', s.service_m2, { type: 'number', min: 0, step: '0.01' })}
  </div>`)}
  ${ui.card('Deal rules', `<div class="fields">
    ${ui.input('default_term_years', 'Standard term (years)', s.default_term_years, { type: 'number', min: 1, max: 30 })}
    ${ui.input('default_escalation', 'Standard yearly increase (%)', s.default_escalation, { type: 'number', min: 0, step: '0.5' })}
    ${ui.input('default_deposit_months', 'Standard deposit (months)', s.default_deposit_months, { type: 'number', min: 0 })}
    ${ui.input('max_discount_pct', 'Agents may discount up to (%)', s.max_discount_pct, { type: 'number', min: 0, max: 100, hint: 'Deeper discounts go to a manager for approval.' })}
    ${ui.input('offer_valid_days', 'Offers valid for (days)', s.offer_valid_days, { type: 'number', min: 1 })}
    ${ui.input('hold_days', 'Unit holds last (days)', s.hold_days, { type: 'number', min: 1, max: 60 })}
    ${ui.input('vat_pct', 'VAT on invoices (%)', s.vat_pct, { type: 'number', min: 0, max: 30, step: '0.5', hint: 'Shown on printed invoices. 0 to leave it off.' })}
    ${ui.input('currency', 'Currency', s.currency, { required: true })}
  </div>`)}
  ${ui.card('On proposals and invoices', `<div class="fields">
    ${ui.input('legal_name', 'Company name', s.legal_name, { required: true })}
    ${ui.input('company', 'Display name', s.company)}
    ${ui.input('address', 'Address', s.address, { cls: 'span-all' })}
    ${ui.input('leasing_email', 'Leasing email', s.leasing_email, { type: 'email' })}
    ${ui.input('leasing_phone', 'Leasing phone', s.leasing_phone)}
  </div>`)}
  <div class="row">${ui.btn('Save settings', { cls: 'btn--primary' })}</div>`, { cls: 'stack' })}</div>
<div class="stack">
  ${ui.card('Backup', `<p class="muted">Download the whole database as one file. Keep a copy somewhere safe each week.</p>${ui.btn('Download backup', { href: '/admin/settings/backup', cls: 'btn--ghost btn--sm', ic: 'dl' })}<p class="muted small">Stored at <code>${ui.esc(db.file)}</code></p>`)}
  ${ui.card('Sample data', hasDemo
    ? `<p class="muted">The office has sample brands, leads, offers and leases in it. Clear them before you start for real; your own records stay.</p>${ui.form('/admin/settings/demo/clear', csrf, ui.btn('Clear sample data', { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': 'Remove all sample data?' } }))}`
    : `<p class="muted">Fill the office with a realistic sample pipeline to explore every screen. You can clear it with one click.</p>${ui.form('/admin/settings/demo', csrf, ui.btn('Load sample data', { cls: 'btn--ghost btn--sm' }))}`)}
</div>
</div>`;
    h.page(req, res, { title: 'Settings', active: '/admin/settings', body });
  });

  const KEYS = ['rate_plaza', 'rate_street', 'rate_terrace_share', 'service_m2', 'default_term_years', 'default_escalation', 'default_deposit_months', 'max_discount_pct', 'offer_valid_days', 'hold_days', 'vat_pct', 'currency', 'legal_name', 'company', 'address', 'leasing_email', 'leasing_phone'];
  router.post('/settings', R('admin'), (req, res) => {
    for (const k of KEYS) if (req.body[k] !== undefined) db.setSetting(k, h.str(req.body[k], 300));
    ui.setCurrency(db.setting('currency'));
    for (const l of db.all(`SELECT * FROM leads WHERE stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')}) AND id NOT IN (SELECT lead_id FROM offers)`)) db.run('UPDATE leads SET value_est = ? WHERE id = ?', M.estimateValue(db, l), l.id);
    h.log(req, 'Updated settings', 'settings');
    h.back(req, res, '/admin/settings', 'ok', 'Settings saved. Lead values were recalculated with the new rates.');
  });

  router.get('/settings/backup', R('admin'), (req, res) => {
    const file = path.join(os.tmpdir(), `the-wave-leasing-${Date.now()}.db`);
    db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    h.log(req, 'Downloaded a backup', 'settings');
    res.download(file, `the-wave-leasing-${M.today()}.db`, () => fs.rm(file, { force: true }, () => {}));
  });

  router.post('/settings/demo', R('admin'), (req, res) => {
    demo.load(db, req.user);
    h.log(req, 'Loaded sample data', 'settings');
    h.back(req, res, '/admin', 'ok', 'Sample data loaded. Explore freely, then clear it in Settings.');
  });
  router.post('/settings/demo/clear', R('admin'), (req, res) => {
    demo.clear(db);
    h.log(req, 'Cleared sample data', 'settings');
    h.back(req, res, '/admin/settings', 'ok', 'Sample data cleared.');
  });

  // ---------- activity log ----------
  router.get('/audit', R('manager'), (req, res) => {
    const who = h.int(req.query.user);
    const rows = db.all(`SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id ${who ? 'WHERE a.user_id = ?' : ''} ORDER BY a.id DESC LIMIT 400`, ...(who ? [who] : []));
    const link = (a) => ({ lead: `/admin/leads/${a.entity_id}`, offer: `/admin/offers/${a.entity_id}`, lease: `/admin/leases/${a.entity_id}`, unit: `/admin/units/${a.entity_id}`, brand: `/admin/brands/${a.entity_id}`, invoice: `/admin/invoices/${a.entity_id}` })[a.entity];
    const filter = `<form class="filters" method="get">${ui.select('user', 'Person', db.all('SELECT id, name FROM users ORDER BY name').map((u) => [u.id, u.name]), who, { blank: 'Everyone', cls: 'f--inline' })}${ui.btn('Filter', { cls: 'btn--ghost btn--sm' })}</form>`;
    const table = ui.table(
      [
        { label: 'When', render: (a) => `<span title="${ui.dt(a.created_at)}">${ui.dt(a.created_at)}</span>` },
        { label: 'Who', render: (a) => ui.esc(a.user_name || 'System / website') },
        { label: 'What', render: (a) => `<b>${ui.esc(a.action)}</b>` },
        { label: 'Detail', render: (a) => (link(a) && a.entity_id ? `<a href="${link(a)}">${ui.esc(a.detail || 'Open')}</a>` : ui.esc(a.detail || '')) },
        { label: 'IP', render: (a) => `<span class="muted">${ui.esc(a.ip || '')}</span>` },
      ],
      rows,
    );
    h.page(req, res, { title: 'Activity log', active: '/admin/audit', wide: true, body: `${filter}${ui.card('Every change, sign-in and export', table, { sub: 'The latest 400 entries' })}` });
  });
};
