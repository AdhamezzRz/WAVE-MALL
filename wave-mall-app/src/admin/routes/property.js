'use strict';

// Property: units (on the plan and in a table, with pricing and holds) and brands with their contacts.

const { t: tr, tn, tx, isAr } = require('../i18n');
const T = require('../tenancy');

// Brand positioning, stored as a key.
const TIERS = { luxury: 'Luxury', premium: 'Premium', mid: 'Mid-market', value: 'Value' };
const tiers = () => Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, tr(v)]));

module.exports = function property(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;

  // ---------- units ----------
  router.get('/units', (req, res) => {
    h.sweep(req);
    const view = req.query.view === 'table' ? 'table' : 'plan';
    const units = db.all(
      `SELECT u.*, l.title hold_title,
        (SELECT b.name FROM lease_units lu JOIN leases s ON s.id = lu.lease_id JOIN brands b ON b.id = s.brand_id WHERE lu.unit_id = u.id AND s.status = 'active' LIMIT 1) tenant
       FROM units u LEFT JOIN leads l ON l.id = u.hold_lead_id ORDER BY u.sort`,
    );
    const total = units.reduce((s, u) => s + u.indoor_m2, 0);
    const byStatus = Object.keys(M.UNIT_STATUS).map((k) => {
      const list = units.filter((u) => u.status === k);
      return { k, label: M.UNIT_STATUS[k], n: list.length, area: list.reduce((s, u) => s + u.indoor_m2, 0) };
    });
    const kpis = byStatus.filter((s) => s.k !== 'blocked' || s.n).map((s) => ui.kpi({ label: s.label, value: tn(s.n, '{n} <small>unit</small>', '{n} <small>units</small>'), sub: `${ui.m2(s.area)} · ${ui.pct(total ? s.area / total : 0)}`, bar: total ? s.area / total : 0 })).join('');
    const switcher = `<nav class="tabs"><a class="tab${view === 'plan' ? ' is-on' : ''}" href="/admin/units">${tr('On the plan')}</a><a class="tab${view === 'table' ? ' is-on' : ''}" href="/admin/units?view=table">${tr('Table')}</a></nav>`;
    const rate = (u) => M.listRates(db, u);
    let main;
    if (view === 'plan') {
      const side = (zone) => `<ul class="ulist">${units.filter((u) => u.zone === zone).map((u) => `<li><a href="/admin/units/${u.id}"><b>${ui.esc(u.code)}</b><span>${ui.m2(u.indoor_m2)}${u.terrace_m2 ? ` + ${ui.n0(u.terrace_m2)}` : ''}</span><em>${ui.esc(u.tenant || u.hold_title || '')}</em>${ui.unitBadge(u.status)}</a></li>`).join('')}</ul>`;
      main = `<div class="grid grid--side">${ui.card(tr('Plaza level · 16 shops around the court'), `${ui.plan(units, 'G')}${ui.planLegend()}`, { sub: ui.esc(tr('Hover a unit for details, click to open it.')) })}${ui.card(tr('Plaza units'), side('plaza'))}</div>
      <div class="grid grid--side">${ui.card(tr('Street level · 7 shops on North 90'), `${ui.plan(units, 'B1')}${ui.planLegend()}`)}${ui.card(tr('Street units'), side('street'))}</div>
      ${units.some((u) => !['plaza', 'street'].includes(u.zone)) ? ui.card(tr('Other units'), side('upper') + side('kiosk')) : ''}`;
    } else {
      main = ui.card(tr('{units} · {area} indoor', { units: tn(units.length, '{n} unit', '{n} units'), area: ui.m2(total) }), ui.table(
        [
          { label: tr('Unit'), render: (u) => `<b>${ui.esc(u.code)}</b>` },
          { label: tr('Level'), render: (u) => ui.esc(M.ZONES[u.zone]) },
          { label: tr('Indoor'), num: true, render: (u) => ui.m2(u.indoor_m2) },
          { label: tr('Terrace'), num: true, render: (u) => ui.m2(u.terrace_m2) },
          { label: tr('List / m²'), num: true, render: (u) => ui.money(rate(u).rent, { cur: false }) },
          { label: tr('List rent / month'), num: true, render: (u) => { const r = rate(u); return r.rent ? ui.money(M.monthly([u], { rent: r.rent, terrace: r.terrace || 0 }).rent, { cur: false }) : '—'; } },
          { label: tr('Status'), render: (u) => ui.unitBadge(u.status) },
          { label: tr('Tenant / held for'), render: (u) => ui.esc(u.tenant || u.hold_title || '—') },
          { label: tr('Hold ends'), render: (u) => (u.status === 'hold' && u.hold_until ? ui.rel(u.hold_until) : '—') },
        ],
        units,
        { href: (u) => `/admin/units/${u.id}` },
      ), { action: ui.btn(tr('Export CSV'), { href: '/admin/export/units.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) });
    }
    h.page(req, res, {
      title: tr('Units & plan'), active: '/admin/units', wide: true,
      body: `<div class="kpis kpis--${byStatus.filter((s) => s.k !== 'blocked' || s.n).length}">${kpis}</div>${switcher}${main}`,
      actions: h.can(req, 'manager') ? ui.btn(tr('Add unit'), { href: '/admin/units/new', cls: 'btn--ghost', ic: 'plus' }) : '',
    });
  });

  const unitFields = (u = {}) => `<div class="fields">
    ${ui.input('code', tr('Unit code'), u.code, { required: true, placeholder: tr('e.g. F1-04'), attrs: u.id ? { readonly: true } : {} })}
    ${ui.select('zone', tr('Level'), M.ZONES, u.zone || 'upper')}
    ${ui.input('level', tr('Floor'), u.level || '1', { placeholder: tr('G, B1, 1, 2…') })}
    ${ui.input('indoor_m2', tr('Indoor area (m²)'), u.indoor_m2, { type: 'number', min: 0, step: '0.1', required: true })}
    ${ui.input('terrace_m2', tr('Terrace (m²)'), u.terrace_m2 ?? 0, { type: 'number', min: 0, step: '0.1' })}
    ${ui.input('frontage', tr('Frontage / notes on position'), u.frontage)}
  </div>`;

  router.get('/units/new', R('manager'), (req, res) => {
    h.page(req, res, { title: tr('Add a unit'), crumbs: [['/admin/units', tr('Units')], [null, tr('o|New')]], active: '/admin/units', body: ui.card(tr('Unit'), ui.form('/admin/units', req.session.csrf, `${unitFields()}<div class="row">${ui.btn(tr('Add unit'), { cls: 'btn--primary' })}</div>`, { cls: 'stack form' }), { sub: ui.esc(tr('For units on the upper floors, kiosks, or a split or merged shop.')) }) });
  });
  router.post('/units', R('manager'), (req, res) => {
    const code = h.str(req.body.code, 20).toUpperCase();
    if (!code || db.get('SELECT id FROM units WHERE code = ?', code)) return h.back(req, res, '/admin/units/new', 'error', tr('Use a new, unique unit code.'));
    const r = db.run('INSERT INTO units (code, level, zone, indoor_m2, terrace_m2, frontage, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', code, h.str(req.body.level, 4) || '1', M.ZONES[req.body.zone] ? req.body.zone : 'upper', h.numv(req.body.indoor_m2) || 0, h.numv(req.body.terrace_m2) || 0, h.str(req.body.frontage, 200) || null, 500 + db.value('SELECT COUNT(*) FROM units'), M.now());
    h.log(req, 'Added a unit', 'unit', Number(r.lastInsertRowid), code);
    h.back(req, res, `/admin/units/${r.lastInsertRowid}`, 'ok', tr('{code} added.', { code }));
  });

  router.get('/units/:id', (req, res, next) => {
    const u = db.get('SELECT u.*, l.title hold_title FROM units u LEFT JOIN leads l ON l.id = u.hold_lead_id WHERE u.id = ?', req.params.id);
    if (!u) return next();
    const r = M.listRates(db, u);
    const mo = r.rent ? M.monthly([u], { rent: r.rent, terrace: r.terrace || 0, service: r.service || 0 }) : null;
    const lease = db.get("SELECT s.*, b.name brand_name FROM lease_units lu JOIN leases s ON s.id = lu.lease_id JOIN brands b ON b.id = s.brand_id WHERE lu.unit_id = ? AND s.status IN ('active','draft') ORDER BY s.status = 'active' DESC LIMIT 1", u.id);
    const offers = db.all('SELECT o.*, l.title lead_title FROM offer_units ou JOIN offers o ON o.id = ou.offer_id JOIN leads l ON l.id = o.lead_id WHERE ou.unit_id = ? ORDER BY o.id DESC', u.id);
    const interest = db.all(`SELECT l.*, us.name owner_name FROM leads l LEFT JOIN users us ON us.id = l.owner_id WHERE l.unit_id = ? AND l.stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')}) ORDER BY l.probability DESC`, u.id);
    const history = db.all("SELECT a.*, us.name user_name FROM audit a LEFT JOIN users us ON us.id = a.user_id WHERE a.entity = 'unit' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 20", u.id);
    const csrf = req.session.csrf;
    const openLeads = db.all(`SELECT id, title FROM leads WHERE stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')}) ORDER BY title`);
    const kpis = [
      ui.kpi({ label: tr('Status'), value: ui.unitBadge(u.status), sub: ui.esc(u.status === 'hold' ? tr('for {lead}, ends {when}', { lead: u.hold_title || '—', when: ui.rel(u.hold_until) }) : u.status === 'reserved' ? tr('for {lead}', { lead: u.hold_title || '—' }) : lease ? tr('{brand} until {date}', { brand: lease.brand_name, date: ui.date(lease.end_date) }) : '') }),
      ui.kpi({ label: tr('Area'), value: ui.m2(u.indoor_m2), sub: ui.esc(u.terrace_m2 ? tr('o|+ {area} terrace', { area: ui.m2(u.terrace_m2) }) : tr('o|No terrace')) }),
      ui.kpi({ label: tr('List rate'), value: r.rent ? ui.money(r.rent, { cur: false }) : '—', sub: ui.esc(r.rent ? tr('per m² / month · terrace {rate}', { rate: ui.money(r.terrace, { cur: false }) }) : tr('Set rates in Settings or below')) }),
      ui.kpi({ label: tr('List rent'), value: mo ? ui.money(mo.rent, { compact: true }) : '—', sub: mo ? ui.esc(tr('a month · {year} a year', { year: ui.money(mo.rent * 12, { compact: true }) })) : '' }),
    ].join('');
    const holdBox = h.can(req, 'agent') && ['available', 'hold'].includes(u.status)
      ? ui.card(u.status === 'hold' ? tr('unit|On hold') : tr('Hold this unit'), u.status === 'hold'
        ? `<p>${tr('Held for {lead} until {date}.', { lead: `<a href="/admin/leads/${u.hold_lead_id}">${ui.esc(u.hold_title || tr('a lead'))}</a>`, date: ui.date(u.hold_until) })}</p>${ui.form(`/admin/units/${u.id}/release`, csrf, ui.btn(tr('Release hold'), { cls: 'btn--ghost btn--sm' }))}`
        : ui.form(`/admin/units/${u.id}/hold`, csrf, `<div class="fields">${ui.select('lead_id', tr('hold|For'), openLeads.map((l) => [l.id, l.title]), '', { required: true, blank: tr('Choose a lead…') })}${ui.input('days', tr('Days'), db.setting('hold_days'), { type: 'number', min: 1, max: 60 })}</div>${ui.btn(tr('Place hold'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }))
      : '';
    const statusOpts = u.status === 'leased' ? { leased: M.UNIT_STATUS.leased } : { available: M.UNIT_STATUS.available, hold: M.UNIT_STATUS.hold, reserved: M.UNIT_STATUS.reserved, blocked: tr('Blocked (not for lease)') };
    const edit = h.can(req, 'manager')
      ? ui.card(tr('Pricing and status'), ui.form(`/admin/units/${u.id}`, csrf, `<div class="fields">
          ${ui.input('rent_m2', tr('List rent per m² / month'), u.rent_m2, { type: 'number', min: 0, step: '0.01', hint: tr('Empty uses the default for its level.') })}
          ${ui.input('terrace_rent_m2', tr('o|Terrace per m² / month'), u.terrace_rent_m2, { type: 'number', min: 0, step: '0.01', hint: tr('Empty uses the terrace share of the rent.') })}
          ${ui.input('service_m2', tr('Service per m² / month'), u.service_m2, { type: 'number', min: 0, step: '0.01' })}
          ${ui.select('status', tr('Status'), statusOpts, u.status)}
          ${ui.input('indoor_m2', tr('Indoor area (m²)'), u.indoor_m2, { type: 'number', min: 0, step: '0.1' })}
          ${ui.input('terrace_m2', tr('Terrace (m²)'), u.terrace_m2, { type: 'number', min: 0, step: '0.1' })}
          ${ui.input('frontage', tr('Frontage / position'), u.frontage, { cls: 'span-all' })}
          ${ui.textarea('notes', tr('Notes'), u.notes, { rows: 3, cls: 'span-all', placeholder: tr('Services, ceiling height, restrictions…') })}
        </div>${ui.btn(tr('Save'), { cls: 'btn--primary' })}`, { cls: 'stack' }))
      : '';
    const offersList = offers.length ? `<ul class="list">${offers.map((o) => `<li><a href="/admin/offers/${o.id}"><span class="what"><b>${ui.esc(o.ref)} · ${ui.esc(o.lead_title)}</b><small>${ui.esc(tr('{rate}/m²', { rate: ui.money(o.rent_m2) }))} · ${ui.date(o.created_at)}</small></span>${ui.badge(o.status, M.OFFER_STATUS[o.status])}</a></li>`).join('')}</ul>` : `<p class="muted pad">${tr('No offers on this unit yet.')}</p>`;
    const interestList = interest.length ? `<ul class="list">${interest.map((l) => `<li><a href="/admin/leads/${l.id}"><span class="what"><b>${ui.esc(l.title)}</b><small>${ui.esc(l.owner_name || tr('Unassigned'))} · ${l.probability}%</small></span>${ui.stageBadge(l.stage)}</a></li>`).join('')}</ul>` : `<p class="muted pad">${tr('No open lead has picked this unit.')}</p>`;
    const hist = history.length ? `<ul class="feed">${history.map((a) => `<li><span class="avatar avatar--sm">${ui.esc(ui.initials(a.user_name || tr('System')))}</span><p><b>${ui.esc(a.user_name || tr('System'))}</b> ${ui.esc(isAr() ? tx(a.action) : a.action.toLowerCase())} ${a.detail ? `<span>${ui.esc(tx(a.detail))}</span>` : ''}</p><time>${ui.rel(a.created_at)}</time></li>`).join('')}</ul>` : `<p class="muted pad">${tr('No changes yet.')}</p>`;
    const unitDocs = ui.docPanel({
      docs: h.docs(req, 'unit', u.id), entity: 'unit', entityId: u.id, csrf, canUpload: h.can(req, 'agent'), canDelete: h.can(req, 'manager'), canConfidential: h.canHR(req),
      title: tr('Unit documents'), warnDays: Number(db.setting('doc_warn_days')) || 30, sub: ui.esc(tr('Fit-out drawings, handover reports and permits for this unit.')),
    });
    const plan = ['plaza', 'street'].includes(u.zone) ? ui.card(tr('Where it is'), ui.plan(db.all('SELECT * FROM units'), u.zone === 'plaza' ? 'G' : 'B1').replace(`data-code="${u.code}"`, `data-code="${u.code}" data-focus`)) : '';
    const body = `<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side">
  <div class="stack">${plan}${unitDocs}${ui.card(tr('Leads interested'), interestList)}${ui.card(tr('Offers'), offersList)}${ui.card(tr('History'), hist)}</div>
  <div class="stack">${holdBox}${lease ? ui.card(tr('Lease'), `<p><a href="/admin/leases/${lease.id}"><b>${ui.esc(lease.brand_name)}</b></a> · ${ui.badge(lease.status, M.LEASE_STATUS[lease.status])}</p><p class="muted">${ui.date(lease.start_date)} – ${ui.date(lease.end_date)}</p><p>${ui.btn(tr('Open tenant file'), { href: `/admin/tenants/${lease.brand_id}`, cls: 'btn--ghost btn--sm', ic: 'tenant' })}</p>`) : ''}${edit}${u.notes && !edit ? ui.card(tr('Notes'), `<p>${ui.esc(tx(u.notes))}</p>`) : ''}</div>
</div>`;
    h.page(req, res, { title: tr('Unit {code}', { code: u.code }), crumbs: [['/admin/units', tr('Units')], [null, u.code]], active: '/admin/units', body });
  });

  router.post('/units/:id', R('manager'), (req, res, next) => {
    const u = db.get('SELECT * FROM units WHERE id = ?', req.params.id);
    if (!u) return next();
    const status = u.status === 'leased' ? 'leased' : M.UNIT_STATUS[req.body.status] && req.body.status !== 'leased' ? req.body.status : u.status;
    db.run(
      'UPDATE units SET rent_m2 = ?, terrace_rent_m2 = ?, service_m2 = ?, status = ?, indoor_m2 = ?, terrace_m2 = ?, frontage = ?, notes = ?, hold_until = CASE WHEN ? = \'available\' THEN NULL ELSE hold_until END, hold_lead_id = CASE WHEN ? = \'available\' THEN NULL ELSE hold_lead_id END, updated_at = ? WHERE id = ?',
      h.numv(req.body.rent_m2), h.numv(req.body.terrace_rent_m2), h.numv(req.body.service_m2), status, h.numv(req.body.indoor_m2) ?? u.indoor_m2, h.numv(req.body.terrace_m2) ?? u.terrace_m2,
      h.str(req.body.frontage, 200) || null, h.str(req.body.notes, 2000) || null, status, status, M.now(), u.id,
    );
    const changes = [];
    if (String(h.numv(req.body.rent_m2) ?? '') !== String(u.rent_m2 ?? '')) changes.push(`rent ${u.rent_m2 ?? '—'} → ${h.numv(req.body.rent_m2) ?? '—'}`);
    if (status !== u.status) changes.push(`${u.status} → ${status}`);
    h.log(req, 'Updated a unit', 'unit', u.id, `${u.code}${changes.length ? ` · ${changes.join(', ')}` : ''}`);
    h.back(req, res, `/admin/units/${u.id}`, 'ok', tr('o|Saved.'));
  });

  router.post('/units/:id/hold', R('agent'), (req, res, next) => {
    const u = db.get('SELECT * FROM units WHERE id = ?', req.params.id);
    if (!u) return next();
    const lead = db.get('SELECT * FROM leads WHERE id = ?', h.int(req.body.lead_id));
    const back = req.get('referer') && req.get('referer').includes('/admin/leads/') ? `/admin/leads/${lead ? lead.id : ''}` : `/admin/units/${u.id}`;
    if (!lead) return h.back(req, res, back, 'error', tr('Choose the lead to hold it for.'));
    if (u.status !== 'available') return h.back(req, res, back, 'error', tr('{code} is {status}.', { code: u.code, status: M.UNIT_STATUS[u.status].toLowerCase() }));
    const days = Math.max(1, Math.min(60, h.int(req.body.days) || Number(db.setting('hold_days')) || 7));
    const until = M.addDays(M.today(), days);
    db.run("UPDATE units SET status = 'hold', hold_until = ?, hold_lead_id = ?, updated_at = ? WHERE id = ?", until, lead.id, M.now(), u.id);
    db.run("INSERT INTO activities (lead_id, brand_id, unit_id, user_id, type, subject, done_at, created_at) VALUES (?, ?, ?, ?, 'note', ?, ?, ?)", lead.id, lead.brand_id, u.id, req.user.id, `Held ${u.code} until ${until}`, M.now(), M.now());
    if (!lead.unit_id) db.run('UPDATE leads SET unit_id = ? WHERE id = ?', u.id, lead.id);
    h.log(req, 'Placed a hold', 'unit', u.id, `${u.code} for ${lead.title}, ${days} days`);
    h.back(req, res, back, 'ok', tr('{code} on hold for {lead} until {date}.', { code: u.code, lead: lead.title, date: ui.date(until) }));
  });

  router.post('/units/:id/release', R('agent'), (req, res, next) => {
    const u = db.get('SELECT * FROM units WHERE id = ?', req.params.id);
    if (!u) return next();
    if (u.status === 'hold') {
      db.run("UPDATE units SET status = 'available', hold_until = NULL, hold_lead_id = NULL, updated_at = ? WHERE id = ?", M.now(), u.id);
      h.log(req, 'Released a hold', 'unit', u.id, u.code);
    }
    h.back(req, res, `/admin/units/${u.id}`, 'ok', tr('{code} is available.', { code: u.code }));
  });

  // ---------- brands ----------
  router.get('/brands', (req, res) => {
    const q = h.str(req.query.q, 80);
    const cat = M.CATEGORIES[req.query.category] ? req.query.category : '';
    const rows = db.all(
      `SELECT b.*, (SELECT COUNT(*) FROM leads l WHERE l.brand_id = b.id) leads,
        (SELECT COUNT(*) FROM leases s WHERE s.brand_id = b.id AND s.status = 'active') leases,
        (SELECT l.stage FROM leads l WHERE l.brand_id = b.id ORDER BY l.updated_at DESC LIMIT 1) stage,
        (SELECT c.name FROM contacts c WHERE c.brand_id = b.id ORDER BY c.primary_contact DESC LIMIT 1) contact
       FROM brands b WHERE (? = '' OR b.name LIKE ?) AND (? = '' OR b.category = ?) ORDER BY b.name`,
      q, `%${q}%`, cat, cat,
    );
    const filters = `<form class="filters" method="get"><input type="search" name="q" value="${ui.esc(q)}" placeholder="${ui.esc(tr('Search brands'))}">${ui.select('category', tr('Category'), M.CATEGORIES, cat, { blank: tr('All categories'), cls: 'f--inline' })}${ui.btn(tr('o|Filter'), { cls: 'btn--ghost btn--sm' })}</form>`;
    const table = ui.table(
      [
        { label: tr('Brand'), render: (b) => `<b>${ui.esc(b.name)}</b>${b.origin ? `<small class="sub">${ui.esc(tx(b.origin))}</small>` : ''}` },
        { label: tr('Category'), render: (b) => ui.esc(M.CATEGORIES[b.category]) },
        { label: tr('Contact'), render: (b) => ui.esc(b.contact || '—') },
        { label: tr('Leads'), num: true, render: (b) => ui.n0(b.leads) },
        { label: tr('Latest stage'), render: (b) => (b.stage ? ui.stageBadge(b.stage) : '—') },
        { label: tr('o|Tenant'), render: (b) => (b.leases ? ui.badge('active', tr('o|Tenant')) : '') },
      ],
      rows,
      { empty: ui.esc(tr('No brands yet.')), href: (b) => `/admin/brands/${b.id}` },
    );
    h.page(req, res, { title: tr('Brands'), active: '/admin/brands', wide: true, body: `${filters}${ui.card(tn(rows.length, '{n} brand', '{n} brands'), table)}`, actions: h.can(req, 'agent') ? ui.btn(tr('Add brand'), { href: '/admin/brands/new', cls: 'btn--primary', ic: 'plus' }) : '' });
  });

  const brandFields = (b = {}) => `<div class="fields">
    ${ui.input('name', tr('Name'), b.name, { required: true })}
    ${ui.select('category', tr('Category'), M.CATEGORIES, b.category || 'fashion')}
    ${ui.input('origin', tr('Origin / group'), b.origin, { placeholder: tr('e.g. Egyptian, franchise of…') })}
    ${ui.select('tier', tr('Positioning'), tiers(), b.tier, { blank: '—' })}
    ${ui.input('stores', tr('Stores in Egypt'), b.stores, { type: 'number', min: 0 })}
    ${ui.input('website', tr('Website'), b.website, { type: 'url', placeholder: isAr() ? 'https://…' : 'https://' })}
    ${ui.input('instagram', tr('Instagram'), b.instagram, { placeholder: tr('@handle') })}
    ${ui.textarea('notes', tr('Notes'), b.notes, { rows: 3, cls: 'span-all' })}
  </div>`;
  const readBrand = (req) => ({
    name: h.str(req.body.name, 160), category: M.CATEGORIES[req.body.category] ? req.body.category : 'other', origin: h.str(req.body.origin, 120) || null,
    tier: ['luxury', 'premium', 'mid', 'value'].includes(req.body.tier) ? req.body.tier : null, stores: h.int(req.body.stores),
    website: /^https?:\/\//.test(req.body.website || '') ? h.str(req.body.website, 200) : null, instagram: h.str(req.body.instagram, 80) || null, notes: h.str(req.body.notes, 3000) || null,
  });

  router.get('/brands/new', R('agent'), (req, res) => {
    h.page(req, res, { title: tr('Add a brand'), crumbs: [['/admin/brands', tr('Brands')], [null, tr('o|New')]], active: '/admin/brands', body: ui.card(tr('Brand'), ui.form('/admin/brands', req.session.csrf, `${brandFields()}<div class="row">${ui.btn(tr('Add brand'), { cls: 'btn--primary' })}</div>`, { cls: 'stack form' })) });
  });
  router.post('/brands', R('agent'), (req, res) => {
    const b = readBrand(req);
    if (!b.name) return h.back(req, res, '/admin/brands/new', 'error', tr('Name the brand.'));
    const r = db.run('INSERT INTO brands (name, category, origin, tier, stores, website, instagram, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', b.name, b.category, b.origin, b.tier, b.stores, b.website, b.instagram, b.notes, M.now());
    h.log(req, 'Added a brand', 'brand', Number(r.lastInsertRowid), b.name);
    h.back(req, res, `/admin/brands/${r.lastInsertRowid}`, 'ok', tr('Brand added.'));
  });

  router.get('/brands/:id', (req, res, next) => {
    const b = db.get('SELECT * FROM brands WHERE id = ?', req.params.id);
    if (!b) return next();
    const contacts = db.all('SELECT * FROM contacts WHERE brand_id = ? ORDER BY primary_contact DESC, name', b.id);
    const leads = db.all('SELECT l.*, u.name owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE l.brand_id = ? ORDER BY l.updated_at DESC', b.id);
    const leases = db.all('SELECT * FROM leases WHERE brand_id = ? ORDER BY start_date DESC', b.id).map((s) => ({ ...s, units: M.leaseUnits(db, s.id) }));
    const csrf = req.session.csrf;
    const can = h.can(req, 'agent');
    const contactList = contacts.length
      ? `<ul class="contacts">${contacts.map((c) => `<li><span class="avatar">${ui.esc(ui.initials(c.name))}</span><div><b>${ui.esc(c.name)}</b>${c.primary_contact ? ` <span class="badge badge--sea">${tr('contact|Main')}</span>` : ''}<small>${ui.esc(tx(c.title) || '')}</small><p class="contact-links">${c.email ? `<a href="mailto:${ui.esc(c.email)}">${ui.icon('mail')}${ui.esc(c.email)}</a>` : ''}${c.phone ? `<a href="tel:${ui.esc(c.phone)}">${ui.icon('phone')}${ui.esc(c.phone)}</a>` : ''}</p></div>${h.can(req, 'manager') ? ui.form(`/admin/contacts/${c.id}/delete`, csrf, `<button class="iconbtn" title="${ui.esc(tr('Remove'))}" aria-label="${ui.esc(tr('Remove contact'))}" data-confirm="${ui.esc(tr('Remove {name}?', { name: c.name }))}">×</button>`) : ''}</li>`).join('')}</ul>`
      : `<p class="muted pad">${tr('No contacts yet.')}</p>`;
    const addContact = can ? `<details class="pop pop--inline"><summary class="btn btn--ghost btn--sm">${tr('Add contact')}</summary>${ui.form(`/admin/brands/${b.id}/contacts`, csrf, `<div class="fields">${ui.input('name', tr('Name'), '', { required: true })}${ui.input('title', tr('Job title'))}${ui.input('email', tr('Email'), '', { type: 'email' })}${ui.input('phone', tr('o|Phone / WhatsApp'), '', { type: 'tel' })}</div><label class="check"><input type="checkbox" name="primary" value="1"> ${tr('o|Main contact')}</label>${ui.btn(tr('Add'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const leadList = leads.length ? `<ul class="list">${leads.map((l) => `<li><a href="/admin/leads/${l.id}"><span class="what"><b>${ui.esc(l.title)}</b><small>${ui.esc(l.ref)} · ${ui.esc(l.owner_name || tr('Unassigned'))} · ${ui.money(l.value_est, { compact: true })}</small></span>${ui.stageBadge(l.stage)}</a></li>`).join('')}</ul>` : `<p class="muted pad">${tr('o|No leads yet.')}</p>`;
    const leaseList = leases.length ? `<ul class="list">${leases.map((s) => `<li><a href="/admin/leases/${s.id}"><span class="what"><b>${ui.esc(s.ref)} · ${ui.esc(s.units.map((u) => u.code).join(', '))}</b><small>${ui.date(s.start_date)} – ${ui.date(s.end_date)}</small></span>${ui.badge(s.status, M.LEASE_STATUS[s.status])}</a></li>`).join('')}</ul>` : `<p class="muted pad">${tr('Not a tenant yet.')}</p>`;
    const info = `<dl class="dl"><div><dt>${tr('Category')}</dt><dd>${ui.esc(M.CATEGORIES[b.category])}</dd></div><div><dt>${tr('Origin')}</dt><dd>${ui.esc(tx(b.origin) || '—')}</dd></div><div><dt>${tr('Positioning')}</dt><dd>${ui.esc(tiers()[b.tier] || '—')}</dd></div><div><dt>${tr('Stores in Egypt')}</dt><dd>${b.stores ?? '—'}</dd></div><div><dt>${tr('Website')}</dt><dd>${b.website ? `<a class="ltr" href="${ui.esc(b.website)}" target="_blank" rel="noopener">${ui.esc(b.website.replace(/^https?:\/\//, ''))}</a>` : '—'}</dd></div><div><dt>${tr('Instagram')}</dt><dd><span class="ltr">${ui.esc(b.instagram || '—')}</span></dd></div></dl>${b.notes ? `<blockquote class="quote quote--sm">${ui.esc(tx(b.notes))}</blockquote>` : ''}`;
    const edit = can ? `<details class="pop pop--inline"><summary class="btn btn--ghost btn--sm">${tr('Edit')}</summary>${ui.form(`/admin/brands/${b.id}`, csrf, `${brandFields(b)}${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    let banner = '';
    if (T.isTenant(db, b.id)) {
      const x = T.tenant(db, b, { warnDays: Number(db.setting('doc_warn_days')) || 30 });
      const c = x.compliance;
      const tone = c.expired ? 'rose' : c.score >= 1 ? 'ok' : c.score >= 0.6 ? 'amber' : 'rose';
      banner = `<a class="tbanner" href="/admin/tenants/${b.id}">${ui.icon('tenant')}<div><b>${ui.esc(tr('ten|Tenant file'))}</b><small>${ui.esc(tr('{done} of {total} on file', { done: c.done, total: c.total }))}${c.expired ? ` · ${ui.esc(tn(c.expired, '{n} document expired', '{n} documents expired'))}` : ''}${c.missing ? ` · ${ui.esc(tn(c.missing, '{n} document missing', '{n} documents missing'))}` : ''}</small></div><span class="tbanner__pct">${Math.round(c.score * 100)}%</span>${ui.meter(c.score, tone)}<span class="btn btn--primary btn--sm">${ui.esc(tr('Open tenant file'))}</span></a>`;
    }
    const body = `${banner}<div class="grid grid--side"><div class="stack">${ui.card(tr('Leads'), leadList, { action: can ? ui.btn(tr('o|New lead'), { href: `/admin/leads/new?brand=${b.id}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '' })}${ui.card(tr('Leases'), leaseList)}</div><div class="stack">${ui.card(tr('Contacts'), contactList, { action: addContact })}${ui.card(tr('brand|About'), info, { action: edit })}</div></div>`;
    h.page(req, res, { title: b.name, crumbs: [['/admin/brands', tr('Brands')], [null, b.name]], active: '/admin/brands', body });
  });

  router.post('/brands/:id', R('agent'), (req, res, next) => {
    const old = db.get('SELECT * FROM brands WHERE id = ?', req.params.id);
    if (!old) return next();
    const b = readBrand(req);
    if (!b.name) return h.back(req, res, `/admin/brands/${old.id}`, 'error', tr('Name the brand.'));
    db.run('UPDATE brands SET name = ?, category = ?, origin = ?, tier = ?, stores = ?, website = ?, instagram = ?, notes = ? WHERE id = ?', b.name, b.category, b.origin, b.tier, b.stores, b.website, b.instagram, b.notes, old.id);
    h.log(req, 'Updated a brand', 'brand', old.id, b.name);
    h.back(req, res, `/admin/brands/${old.id}`, 'ok', tr('o|Saved.'));
  });

  router.post('/brands/:id/contacts', R('agent'), (req, res, next) => {
    const b = db.get('SELECT * FROM brands WHERE id = ?', req.params.id);
    if (!b) return next();
    const name = h.str(req.body.name, 120);
    if (!name) return h.back(req, res, h.safeBack(req, `/admin/brands/${b.id}`), 'error', tr('Name the contact.'));
    const primary = req.body.primary ? 1 : db.value('SELECT COUNT(*) FROM contacts WHERE brand_id = ?', b.id) ? 0 : 1;
    if (primary) db.run('UPDATE contacts SET primary_contact = 0 WHERE brand_id = ?', b.id);
    db.run('INSERT INTO contacts (brand_id, name, title, email, phone, primary_contact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', b.id, name, h.str(req.body.title, 120) || null, h.str(req.body.email, 200) || null, h.str(req.body.phone, 40) || null, primary, M.now());
    h.log(req, 'Added a contact', 'brand', b.id, `${name} · ${b.name}`);
    h.back(req, res, h.safeBack(req, `/admin/brands/${b.id}`), 'ok', tr('Contact added.'));
  });

  router.post('/contacts/:id/delete', R('manager'), (req, res) => {
    const c = db.get('SELECT * FROM contacts WHERE id = ?', req.params.id);
    if (c) {
      db.run('UPDATE leads SET contact_id = NULL WHERE contact_id = ?', c.id);
      db.run('DELETE FROM contacts WHERE id = ?', c.id);
      h.log(req, 'Removed a contact', 'brand', c.brand_id, c.name);
    }
    h.back(req, res, h.safeBack(req, c ? `/admin/brands/${c.brand_id}` : '/admin/brands'), 'ok', tr('Contact removed.'));
  });
};
