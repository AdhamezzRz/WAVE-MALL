'use strict';

// Sales: the inbox, leads, the pipeline board, activities and the calendar.

const { t: tr, tn, tx, isAr } = require('../i18n');

module.exports = function sales(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;

  const ACT_ICON = { note: 'offer', call: 'phone', email: 'mail', whatsapp: 'phone', meeting: 'team', viewing: 'unit', task: 'check' };

  const leadOf = (id) =>
    db.get(
      `SELECT l.*, b.name brand_name, b.category brand_category, c.name contact_name, c.email contact_email, c.phone contact_phone, c.whatsapp contact_whatsapp, c.title contact_title,
       u.name owner_name, un.code unit_code FROM leads l LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN contacts c ON c.id = l.contact_id
       LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN units un ON un.id = l.unit_id WHERE l.id = ?`,
      id,
    );
  const canEdit = (req, lead) => h.can(req, 'manager') || (h.can(req, 'agent') && (!lead.owner_id || lead.owner_id === req.user.id));
  const area = (l) => (l.area_min || l.area_max ? `${l.area_min ? ui.n0(l.area_min) : ''}${l.area_min && l.area_max ? '–' : ''}${l.area_max ? ui.n0(l.area_max) : ''} ${tr('m²')}` : '—');
  const owner = (name) => (name ? `<span class="who"><span class="avatar avatar--sm">${ui.esc(ui.initials(name))}</span>${ui.esc(name.split(' ')[0])}</span>` : `<span class="muted">${ui.esc(tr('Unassigned'))}</span>`);
  const scoreOf = (l, extra) => M.score(l, extra);
  const scorePill = (s) => `<span class="score score--${s >= 70 ? 'hot' : s >= 45 ? 'warm' : 'cold'}" title="${ui.esc(tr('Lead score'))}">${s}</span>`;
  const markDone = () => `<button class="iconbtn" title="${ui.esc(tr('Mark done'))}" aria-label="${ui.esc(tr('Mark done'))}">${ui.icon('check')}</button>`;

  function changeStage(req, lead, stageId, extra = {}) {
    const st = M.stage(stageId);
    const closed = ['won', 'lost'].includes(st.id) ? M.now() : null;
    db.run(
      'UPDATE leads SET stage = ?, probability = ?, stage_at = ?, closed_at = ?, lost_reason = ?, updated_at = ? WHERE id = ?',
      st.id, st.p, M.now(), closed, st.id === 'lost' ? extra.reason || lead.lost_reason : null, M.now(), lead.id,
    );
    db.run(
      "INSERT INTO activities (lead_id, brand_id, user_id, type, subject, body, done_at, created_at) VALUES (?, ?, ?, 'note', ?, ?, ?, ?)",
      lead.id, lead.brand_id, req.user.id, `Moved to ${M.stageEn(st.id)}`, extra.note || (st.id === 'lost' && extra.reason ? `Reason: ${extra.reason}` : null), M.now(), M.now(),
    );
    h.log(req, `Moved lead to ${M.stageEn(st.id)}`, 'lead', lead.id, `${lead.ref} · ${lead.title}`);
  }
  h.changeStage = changeStage;

  // ---------- inbox ----------
  router.get('/inbox', (req, res) => {
    const tab = ['new', 'leasing', 'contact', 'archived'].includes(req.query.tab) ? req.query.tab : 'all';
    const where = { all: "status != 'archived'", new: "status = 'new'", leasing: "kind = 'leasing' AND status != 'archived'", contact: "kind = 'contact' AND status != 'archived'", archived: "status = 'archived'" }[tab];
    const rows = db.all(`SELECT m.*, l.ref lead_ref FROM messages m LEFT JOIN leads l ON l.id = m.lead_id WHERE ${where} ORDER BY m.created_at DESC LIMIT 300`);
    const tabs = [['all', tr('All')], ['new', tr('inbox|New')], ['leasing', tr('inbox|Leasing')], ['contact', tr('inbox|Contact')], ['archived', tr('inbox|Archived')]]
      .map(([k, l]) => `<a href="/admin/inbox?tab=${k}" class="tab${tab === k ? ' is-on' : ''}">${ui.esc(l)}</a>`).join('');
    const table = ui.table(
      [
        { label: tr('inbox|From'), render: (m) => `<b>${ui.esc(m.name)}</b><small class="sub">${ui.esc(m.email)}</small>` },
        { label: tr('Type'), render: (m) => ui.badge(m.kind, m.kind === 'leasing' ? tr('Leasing enquiry') : tr('inbox|Contact'), m.kind === 'leasing' ? 'forest' : 'sea') },
        { label: tr('inbox|About'), render: (m) => `${m.brand ? `<b>${ui.esc(m.brand)}</b> · ` : ''}<span class="clip">${ui.esc((m.body || m.subject || '').slice(0, 110))}</span>` },
        { label: tr('Status'), render: (m) => (m.lead_id ? `<a href="/admin/leads/${m.lead_id}">${ui.badge('accepted', `${tr('search|Lead')} ${m.lead_ref}`, 'ok')}</a>` : ui.badge(m.status, m.status === 'new' ? tr('inbox|New') : m.status === 'read' ? tr('inbox|Read') : tr('inbox|Archived'), m.status === 'new' ? 'amber' : 'mute')) },
        { label: tr('Received'), render: (m) => `<span title="${ui.esc(ui.dt(m.created_at))}">${ui.rel(m.created_at)}</span>` },
      ],
      rows,
      { empty: ui.esc(tr('No messages. Website enquiries and contact forms arrive here.')), href: (m) => `/admin/inbox/${m.id}` },
    );
    h.page(req, res, { title: tr('Inbox'), active: '/admin/inbox', body: `<nav class="tabs">${tabs}</nav>${ui.card(tr('Messages from the website'), table, { sub: ui.esc(tr('Leasing enquiries open a lead automatically.')) })}` });
  });

  router.get('/inbox/:id', (req, res, next) => {
    const m = db.get('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!m) return next();
    if (m.status === 'new' && h.can(req, 'agent')) db.run("UPDATE messages SET status = 'read' WHERE id = ?", m.id);
    const size = { s: tr('Under 100 m²'), m: tr('100–250 m²'), l: tr('Over 250 m²') }[m.size];
    const rows = [[tr('Name'), ui.esc(m.name)], [tr('Email'), m.email ? `<a href="mailto:${ui.esc(m.email)}">${ui.esc(m.email)}</a>` : '—'], [tr('Phone'), m.phone ? `<a href="tel:${ui.esc(m.phone)}">${ui.esc(m.phone)}</a>` : '—'], [tr('Brand'), ui.esc(m.brand || '—')], [tr('Category'), ui.esc(M.CATEGORIES[m.category] || m.category || '—')], [tr('Size'), ui.esc(size || '—')], [tr('Subject'), ui.esc(m.subject || '—')], [tr('Language'), ui.esc(m.lang === 'ar' ? tr('Arabic') : tr('lang|English'))], [tr('Received'), ui.dt(m.created_at)]]
      .map(([k, v]) => `<div><dt>${ui.esc(k)}</dt><dd>${v}</dd></div>`).join('');
    const replySubject = m.lang === 'ar' ? 'ذا ويف، القاهرة الجديدة' : 'The Wave, New Cairo';
    const actions = h.can(req, 'agent')
      ? `${m.lead_id ? ui.btn(ui.esc(tr('Open lead')), { href: `/admin/leads/${m.lead_id}`, cls: 'btn--primary', ic: 'arrow' }) : ui.form(`/admin/inbox/${m.id}/convert`, req.session.csrf, ui.btn(ui.esc(tr('Convert to lead')), { cls: 'btn--primary', ic: 'plus' }))}
         ${m.email ? ui.btn(ui.esc(tr('Reply by email')), { href: `mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent(replySubject)}`, cls: 'btn--ghost', ic: 'mail' }) : ''}
         ${ui.form(`/admin/inbox/${m.id}/archive`, req.session.csrf, ui.btn(ui.esc(m.status === 'archived' ? tr('Restore') : tr('Archive')), { cls: 'btn--ghost' }))}`
      : '';
    const body = `<div class="grid grid--side">${ui.card(tr('Message'), `<blockquote class="quote">${m.body ? ui.esc(m.body).replace(/\n/g, '<br>') : ui.esc(tr('(no message)'))}</blockquote>`)}${ui.card(tr('Details'), `<dl class="dl">${rows}</dl>`)}</div>`;
    h.page(req, res, { title: m.name || tr('Message'), crumbs: [['/admin/inbox', tr('Inbox')], [null, m.kind === 'leasing' ? tr('Leasing enquiry') : tr('inbox|Contact')]], active: '/admin/inbox', body, actions: `<div class="row">${actions}</div>` });
  });

  router.post('/inbox/:id/convert', R('agent'), (req, res, next) => {
    const m = db.get('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!m) return next();
    if (m.lead_id) return res.redirect(303, `/admin/leads/${m.lead_id}`);
    const t = M.now();
    const id = db.tx(() => {
      const brandName = m.brand || m.name;
      let brand = db.get('SELECT id FROM brands WHERE name = ? COLLATE NOCASE', brandName);
      if (!brand) brand = { id: Number(db.run('INSERT INTO brands (name, category, created_at) VALUES (?, ?, ?)', brandName, M.CATEGORIES[m.category] ? m.category : 'other', t).lastInsertRowid) };
      const c = db.run('INSERT INTO contacts (brand_id, name, email, phone, primary_contact, created_at) VALUES (?, ?, ?, ?, 1, ?)', brand.id, m.name, m.email, m.phone, t);
      const r = db.run(
        `INSERT INTO leads (ref, brand_id, contact_id, title, category, source, stage, probability, message, owner_id, next_step, next_step_at, created_at, updated_at, stage_at)
         VALUES (?, ?, ?, ?, ?, 'website', 'new', 10, ?, ?, 'First call', ?, ?, ?, ?)`,
        db.nextRef('leads', 'LD'), brand.id, Number(c.lastInsertRowid), brandName, M.CATEGORIES[m.category] ? m.category : 'other', m.body, req.user.id, M.addDays(M.today(), 1), t, t, t,
      );
      const leadId = Number(r.lastInsertRowid);
      db.run("UPDATE messages SET lead_id = ?, status = 'converted' WHERE id = ?", leadId, m.id);
      return leadId;
    });
    h.log(req, 'Converted a message to a lead', 'lead', id, m.name);
    h.back(req, res, `/admin/leads/${id}`, 'ok', tr('Lead created from the message.'));
  });

  router.post('/inbox/:id/archive', R('agent'), (req, res) => {
    const m = db.get('SELECT status FROM messages WHERE id = ?', req.params.id);
    if (m) db.run('UPDATE messages SET status = ? WHERE id = ?', m.status === 'archived' ? 'read' : 'archived', req.params.id);
    h.back(req, res, '/admin/inbox', 'ok', m && m.status === 'archived' ? tr('Restored.') : tr('Archived.'));
  });

  // ---------- leads ----------
  router.get('/leads', (req, res) => {
    const q = req.query;
    const where = [];
    const args = [];
    if (q.q) { where.push('(l.title LIKE ? OR l.ref LIKE ? OR b.name LIKE ? OR c.name LIKE ?)'); args.push(...Array(4).fill(`%${h.str(q.q, 80)}%`)); }
    if (q.stage === 'open') where.push(`l.stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')})`);
    else if (M.STAGES.some((s) => s.id === q.stage)) { where.push('l.stage = ?'); args.push(q.stage); }
    if (q.owner === 'me') { where.push('l.owner_id = ?'); args.push(req.user.id); } else if (q.owner) { where.push('l.owner_id = ?'); args.push(h.int(q.owner)); }
    if (M.SOURCES[q.source]) { where.push('l.source = ?'); args.push(q.source); }
    if (M.CATEGORIES[q.category]) { where.push('l.category = ?'); args.push(q.category); }
    if (q.view === 'stale') { where.push(`l.stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')}) AND l.updated_at < ?`); args.push(new Date(Date.now() - 14 * 86400000).toISOString()); }
    if (q.view === 'closing') where.push("l.stage IN ('negotiation','reserved')");
    if (q.view === 'overdue') { where.push(`l.next_step_at < ? AND l.stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')})`); args.push(M.today()); }
    const order = { value: 'l.value_est DESC', next: 'l.next_step_at IS NULL, l.next_step_at', created: 'l.created_at DESC' }[q.sort] || 'l.updated_at DESC';
    let rows = db.all(
      `SELECT l.*, b.name brand_name, c.name contact_name, u.name owner_name,
        (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id) acts, (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id AND a.type = 'viewing') views
       FROM leads l LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.owner_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 500`,
      ...args,
    ).map((l) => ({ ...l, score: scoreOf(l, { activities: l.acts, viewings: l.views }) }));
    if (q.view === 'hot') rows = rows.filter((l) => l.score >= 70 && M.OPEN_STAGES.includes(l.stage));
    if (q.sort === 'score') rows.sort((a, b) => b.score - a.score);

    const views = [['', tr('All')], ['open', tr('leads|Open'), 'stage'], ['me', tr('Mine'), 'owner'], ['hot', tr('Hot'), null], ['closing', tr('Closing'), null], ['overdue', tr('Follow-up overdue'), null], ['stale', tr('Quiet for 14 days'), null]]
      .map(([k, l, field]) => {
        const href = !k ? '/admin/leads' : field ? `/admin/leads?${field}=${k}` : `/admin/leads?view=${k}`;
        const on = (!k && !q.view && !q.stage && !q.owner) || (field === 'stage' && q.stage === k) || (field === 'owner' && q.owner === k) || (!field && k && q.view === k);
        return `<a class="tab${on ? ' is-on' : ''}" href="${href}">${ui.esc(l)}</a>`;
      }).join('');
    const filters = `<form class="filters" method="get" action="/admin/leads">
      <input type="search" name="q" value="${ui.esc(q.q || '')}" placeholder="${ui.esc(tr('Search name, ref, contact'))}" aria-label="${ui.esc(tr('Search'))}">
      ${ui.select('stage', tr('Stage'), M.STAGES.map((s) => [s.id, s.label]), q.stage, { blank: tr('Any stage'), cls: 'f--inline' })}
      ${ui.select('owner', tr('Owner'), [['me', tr('Me')], ...h.users().map((u) => [u.id, u.name])], q.owner, { blank: tr('Anyone'), cls: 'f--inline' })}
      ${ui.select('source', tr('Source'), M.SOURCES, q.source, { blank: tr('Any source'), cls: 'f--inline' })}
      ${ui.select('category', tr('Category'), M.CATEGORIES, q.category, { blank: tr('Any category'), cls: 'f--inline' })}
      ${ui.select('sort', tr('Sort'), [['', tr('Recently updated')], ['value', tr('Highest value')], ['score', tr('Best score')], ['next', tr('Next step')], ['created', tr('Newest')]], q.sort, { cls: 'f--inline' })}
      ${ui.btn(ui.esc(tr('Filter')), { cls: 'btn--ghost btn--sm' })}
    </form>`;
    const total = rows.reduce((s, l) => s + (M.OPEN_STAGES.includes(l.stage) ? l.value_est : 0), 0);
    const table = ui.table(
      [
        { label: tr('Lead'), render: (l) => `<b>${ui.esc(l.title)}</b><small class="sub">${ui.esc(l.ref)}${l.contact_name ? ` · ${ui.esc(l.contact_name)}` : ''}</small>` },
        { label: tr('Stage'), render: (l) => ui.stageBadge(l.stage) },
        { label: tr('Category'), render: (l) => ui.esc(M.CATEGORIES[l.category]) },
        { label: tr('Wants'), render: (l) => area(l) },
        { label: tr('Annual value'), num: true, render: (l) => ui.money(l.value_est, { compact: true }) },
        { label: tr('Owner'), render: (l) => owner(l.owner_name) },
        { label: tr('Next step'), render: (l) => (l.next_step_at ? `<span class="${l.next_step_at < M.today() && M.OPEN_STAGES.includes(l.stage) ? 'late' : ''}">${ui.esc(l.next_step ? tx(l.next_step) : tr('Follow up'))}<small class="sub">${ui.rel(l.next_step_at)}</small></span>` : '<span class="muted">—</span>') },
        { label: tr('Score'), num: true, render: (l) => scorePill(l.score) },
      ],
      rows,
      { empty: ui.esc(tr('No leads match. Try another view, or add a lead.')), href: (l) => `/admin/leads/${l.id}` },
    );
    h.page(req, res, {
      title: tr('Leads'), active: '/admin/leads', wide: true,
      body: `<nav class="tabs">${views}</nav>${filters}${ui.card(tn(rows.length, '{n} lead', '{n} leads'), table, { sub: ui.esc(tr('leads|{amount} of annual rent in the open ones', { amount: ui.money(total, { compact: true }) })), action: ui.btn(ui.esc(tr('Export CSV')), { href: '/admin/export/leads.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`,
      actions: h.can(req, 'agent') ? ui.btn(ui.esc(tr('New lead')), { href: '/admin/leads/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  function leadForm(req, l = {}) {
    const brands = db.all('SELECT id, name FROM brands ORDER BY name');
    const units = db.all("SELECT id, code, indoor_m2, status FROM units WHERE status IN ('available','hold') OR id = ? ORDER BY sort", l.unit_id || 0);
    const contacts = l.brand_id ? db.all('SELECT id, name FROM contacts WHERE brand_id = ? ORDER BY primary_contact DESC, name', l.brand_id) : [];
    const isNew = !l.id;
    return ui.form(isNew ? '/admin/leads' : `/admin/leads/${l.id}`, req.session.csrf, `
      <fieldset><legend>${ui.esc(tr('The brand'))}</legend><div class="fields">
        ${ui.input('title', tr('Lead name'), l.title, { required: true, placeholder: tr('e.g. Maison Lune flagship'), hint: tr('Usually the brand, or brand and concept.') })}
        ${ui.select('brand_id', tr('Existing brand'), brands.map((b) => [b.id, b.name]), l.brand_id, { blank: tr('— New brand (use the lead name) —') })}
        ${ui.select('category', tr('Category'), M.CATEGORIES, l.category || 'fashion', { required: true })}
        ${ui.select('source', tr('Source'), M.SOURCES, l.source || 'direct', { required: true })}
      </div></fieldset>
      ${isNew ? `<fieldset><legend>${ui.esc(tr('Contact'))}</legend><div class="fields">
        ${ui.input('contact_name', tr('Name'), '', { placeholder: tr('Who we talk to') })}${ui.input('contact_title', tr('Job title'), '', { placeholder: tr('e.g. Expansion manager') })}
        ${ui.input('contact_email', tr('Email'), '', { type: 'email' })}${ui.input('contact_phone', tr('Phone / WhatsApp'), '', { type: 'tel' })}
      </div></fieldset>` : contacts.length ? `<fieldset><legend>${ui.esc(tr('Contact'))}</legend><div class="fields">${ui.select('contact_id', tr('Main contact'), contacts.map((c) => [c.id, c.name]), l.contact_id, { blank: '—' })}</div></fieldset>` : ''}
      <fieldset><legend>${ui.esc(tr('What they need'))}</legend><div class="fields">
        ${ui.input('area_min', tr('Area from (m²)'), l.area_min, { type: 'number', min: 0, step: 1 })}${ui.input('area_max', tr('Area to (m²)'), l.area_max, { type: 'number', min: 0, step: 1 })}
        ${ui.input('budget_m2', tr('Budget (per m² / month)'), l.budget_m2, { type: 'number', min: 0, step: 1 })}
        ${ui.select('zone', tr('Preferred level'), { plaza: M.ZONES.plaza, street: M.ZONES.street, upper: M.ZONES.upper }, l.zone, { blank: tr('No preference') })}
        ${ui.select('unit_id', tr('Unit of interest'), units.map((u) => [u.id, `${u.code} · ${ui.m2(u.indoor_m2)}${u.status === 'hold' ? ` ${tr('(on hold)')}` : ''}`]), l.unit_id, { blank: '—' })}
      </div></fieldset>
      <fieldset><legend>${ui.esc(tr('lead|Next'))}</legend><div class="fields">
        ${ui.select('owner_id', tr('Owner'), h.users().map((u) => [u.id, u.name]), l.owner_id ?? req.user.id, { blank: tr('Unassigned') })}
        ${ui.input('next_step', tr('Next step'), l.next_step ? tx(l.next_step) : l.next_step, { placeholder: tr('e.g. Site viewing') })}
        ${ui.input('next_step_at', tr('lead|Due'), l.next_step_at ? l.next_step_at.slice(0, 10) : M.addDays(M.today(), 2), { type: 'date' })}
        ${ui.textarea('message', tr('Notes'), l.message, { rows: 4, cls: 'span-all' })}
      </div></fieldset>
      <div class="row">${ui.btn(ui.esc(isNew ? tr('Create lead') : tr('Save changes')), { cls: 'btn--primary' })}${ui.btn(ui.esc(tr('Cancel')), { href: isNew ? '/admin/leads' : `/admin/leads/${l.id}`, cls: 'btn--ghost' })}</div>`, { cls: 'stack form' });
  }

  function readLead(req) {
    const b = req.body;
    return {
      title: h.str(b.title, 160), brand_id: h.int(b.brand_id), category: M.CATEGORIES[b.category] ? b.category : 'other', source: M.SOURCES[b.source] ? b.source : 'direct',
      area_min: h.numv(b.area_min), area_max: h.numv(b.area_max), budget_m2: h.numv(b.budget_m2), zone: ['plaza', 'street', 'upper'].includes(b.zone) ? b.zone : null,
      unit_id: h.int(b.unit_id), owner_id: h.int(b.owner_id), next_step: h.str(b.next_step, 200) || null, next_step_at: h.str(b.next_step_at, 10) || null,
      message: h.str(b.message, 4000) || null, contact_id: h.int(b.contact_id),
    };
  }

  router.get('/leads/new', R('agent'), (req, res) => {
    h.page(req, res, { title: tr('New lead'), crumbs: [['/admin/leads', tr('Leads')], [null, tr('newlead|New')]], active: '/admin/leads', body: ui.card(tr('Lead details'), leadForm(req, { brand_id: h.int(req.query.brand) })) });
  });

  router.post('/leads', R('agent'), (req, res) => {
    const l = readLead(req);
    if (!l.title) return h.back(req, res, '/admin/leads/new', 'error', tr('Give the lead a name.'));
    const t = M.now();
    const id = db.tx(() => {
      if (!l.brand_id) {
        const existing = db.get('SELECT id FROM brands WHERE name = ? COLLATE NOCASE', l.title);
        l.brand_id = existing ? existing.id : Number(db.run('INSERT INTO brands (name, category, created_at) VALUES (?, ?, ?)', l.title, l.category, t).lastInsertRowid);
      }
      const cn = h.str(req.body.contact_name, 120);
      if (cn) l.contact_id = Number(db.run('INSERT INTO contacts (brand_id, name, title, email, phone, primary_contact, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', l.brand_id, cn, h.str(req.body.contact_title, 120) || null, h.str(req.body.contact_email, 200) || null, h.str(req.body.contact_phone, 40) || null, t).lastInsertRowid);
      l.value_est = M.estimateValue(db, l);
      const r = db.run(
        `INSERT INTO leads (ref, brand_id, contact_id, title, category, source, stage, probability, area_min, area_max, budget_m2, zone, unit_id, value_est, owner_id, next_step, next_step_at, message, created_at, updated_at, stage_at)
         VALUES (?, ?, ?, ?, ?, ?, 'new', 10, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('leads', 'LD'), l.brand_id, l.contact_id, l.title, l.category, l.source, l.area_min, l.area_max, l.budget_m2, l.zone, l.unit_id, l.value_est, l.owner_id, l.next_step, l.next_step_at, l.message, t, t, t,
      );
      return Number(r.lastInsertRowid);
    });
    h.log(req, 'Created a lead', 'lead', id, l.title);
    h.back(req, res, `/admin/leads/${id}`, 'ok', tr('Lead created.'));
  });

  router.get('/leads/:id', (req, res, next) => {
    const l = leadOf(req.params.id);
    if (!l) return next();
    const acts = db.all('SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY COALESCE(a.done_at, a.due_at, a.created_at) DESC, a.id DESC', l.id);
    const offers = db.all('SELECT * FROM offers WHERE lead_id = ? ORDER BY id DESC', l.id);
    const leases = db.all('SELECT * FROM leases WHERE lead_id = ? ORDER BY id DESC', l.id);
    const views = acts.filter((a) => a.type === 'viewing').length;
    const sc = scoreOf(l, { activities: acts.length, viewings: views });
    const edit = canEdit(req, l);
    const csrf = req.session.csrf;

    const stepper = `<ol class="stepper">${M.STAGES.filter((s) => s.id !== 'lost').map((s, i, all) => {
      const cur = all.findIndex((x) => x.id === l.stage);
      const state = l.stage === 'lost' ? '' : i < cur ? 'is-past' : i === cur ? 'is-on' : '';
      const inner = `<span class="stepper__dot"></span><span class="stepper__l">${s.label}</span>`;
      return `<li class="${state}">${edit && s.id !== l.stage ? ui.form(`/admin/leads/${l.id}/stage`, csrf, `<input type="hidden" name="stage" value="${s.id}"><button type="submit" title="${ui.esc(tr('lead|Move to {stage}', { stage: s.label }))}">${inner}</button>`) : `<span>${inner}</span>`}</li>`;
    }).join('')}</ol>`;

    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    const actForm = edit
      ? ui.form('/admin/activities', csrf, `<input type="hidden" name="lead_id" value="${l.id}">
        <div class="actform">
          ${ui.select('type', tr('Type'), M.ACTIVITY_TYPES, 'call', { cls: 'f--type' })}
          ${ui.input('subject', tr('What happened, or what to do'), '', { required: true, placeholder: tr('e.g. Called Sara, sending floor plans'), cls: 'f--grow' })}
          ${ui.input('due_at', tr('activity|When'), '', { type: 'datetime-local', hint: tr('Leave empty to log it as done now') })}
        </div>
        ${ui.textarea('body', tr('Details'), '', { rows: 2, placeholder: tr('Optional notes') })}
        <div class="row">${ui.btn(ui.esc(tr('Add to timeline')), { cls: 'btn--primary btn--sm' })}</div>`, { cls: 'stack' })
      : '';
    void local;
    const timeline = acts.length
      ? `<ol class="timeline">${acts.map((a) => {
          const open = !a.done_at;
          return `<li class="tl tl--${a.type}${open ? ' is-open' : ''}${open && a.due_at && a.due_at.slice(0, 10) < M.today() ? ' is-late' : ''}">
            <span class="tl__ic">${ui.icon(ACT_ICON[a.type] || 'offer')}</span>
            <div class="tl__body"><p><b>${ui.esc(tx(a.subject))}</b> ${open ? `<span class="badge badge--${a.due_at && a.due_at.slice(0, 10) < M.today() ? 'rose' : 'amber'}">${ui.esc(a.due_at ? tr('activity|Due {when}', { when: ui.rel(a.due_at) }) : tr('activity|Open'))}</span>` : ''}</p>
            ${a.body ? `<p class="tl__text">${ui.esc(tx(a.body)).replace(/\n/g, '<br>')}</p>` : ''}
            <p class="tl__meta">${ui.esc(M.ACTIVITY_TYPES[a.type])} · ${ui.esc(a.user_name || tr('System'))} · ${ui.dt(a.done_at || a.due_at || a.created_at)}</p></div>
            ${edit && open ? ui.form(`/admin/activities/${a.id}/done`, csrf, markDone()) : ''}
          </li>`;
        }).join('')}</ol>`
      : `<p class="muted pad">${ui.esc(tr('No activity yet. Log the first call.'))}</p>`;

    const contact = l.contact_name
      ? `<p><b>${ui.esc(l.contact_name)}</b>${l.contact_title ? `<br><span class="muted">${ui.esc(tx(l.contact_title))}</span>` : ''}</p>
         <p class="contact-links">${l.contact_email ? `<a href="mailto:${ui.esc(l.contact_email)}">${ui.icon('mail')}${ui.esc(l.contact_email)}</a>` : ''}${l.contact_phone ? `<a href="tel:${ui.esc(l.contact_phone)}">${ui.icon('phone')}${ui.esc(l.contact_phone)}</a><a href="https://wa.me/${ui.esc(String(l.contact_phone).replace(/\D/g, ''))}" target="_blank" rel="noopener">${ui.icon('phone')}${ui.esc(tr('WhatsApp'))}</a>` : ''}</p>`
      : `<p class="muted">${ui.esc(tr('No contact yet.'))}</p>`;
    const inStage = () => {
      if (!isAr()) return `in stage ${ui.rel(l.stage_at).replace(' ago', '')}`;
      const n = Math.max(0, M.daysBetween(l.stage_at, M.today()));
      return tr('lead|in stage {time}', { time: n ? tr('{n} days', { n }) : tr('lead|today') });
    };
    const details = `<dl class="dl">
      <div><dt>${ui.esc(tr('Brand'))}</dt><dd>${l.brand_id ? `<a href="/admin/brands/${l.brand_id}">${ui.esc(l.brand_name)}</a>` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('Category'))}</dt><dd>${ui.esc(M.CATEGORIES[l.category])}</dd></div>
      <div><dt>${ui.esc(tr('Source'))}</dt><dd>${ui.esc(M.SOURCES[l.source])}</dd></div>
      <div><dt>${ui.esc(tr('Wants'))}</dt><dd>${area(l)}${l.zone ? ` · ${ui.esc(M.ZONES[l.zone])}` : ''}</dd></div>
      <div><dt>${ui.esc(tr('Budget'))}</dt><dd>${l.budget_m2 ? ui.esc(tr('lead|{amount} / m² / month', { amount: ui.money(l.budget_m2) })) : '—'}</dd></div>
      <div><dt>${ui.esc(tr('Unit of interest'))}</dt><dd>${l.unit_id ? `<a href="/admin/units/${l.unit_id}">${ui.esc(l.unit_code)}</a>` : '—'}</dd></div>
      <div><dt>${ui.esc(tr('Owner'))}</dt><dd>${owner(l.owner_name)}</dd></div>
      <div><dt>${ui.esc(tr('Created'))}</dt><dd>${ui.date(l.created_at)} · ${ui.esc(inStage())}</dd></div>
      ${l.stage === 'lost' ? `<div><dt>${ui.esc(tr('Lost because'))}</dt><dd>${ui.esc(tx(l.lost_reason) || '—')}</dd></div>` : ''}
    </dl>${l.message ? `<blockquote class="quote quote--sm">${ui.esc(tx(l.message)).replace(/\n/g, '<br>')}</blockquote>` : ''}`;

    // units that fit what they want
    const fit = db.all("SELECT * FROM units WHERE status IN ('available','hold') ORDER BY sort").filter((u) => {
      if (l.zone && l.zone !== u.zone) return false;
      if (l.area_min && u.indoor_m2 < l.area_min * 0.85) return false;
      if (l.area_max && u.indoor_m2 > l.area_max * 1.15) return false;
      return true;
    }).slice(0, 8);
    const matches = fit.length
      ? `<ul class="units">${fit.map((u) => {
          const r = M.listRates(db, u);
          const mo = M.monthly([u], { rent: r.rent || 0, terrace: r.terrace || 0, service: 0 }).rent;
          return `<li><a href="/admin/units/${u.id}"><b>${ui.esc(u.code)}</b><span>${ui.esc(u.terrace_m2 ? tr('plan|{a} + {b} terrace', { a: ui.m2(u.indoor_m2), b: ui.m2(u.terrace_m2) }) : ui.m2(u.indoor_m2))}</span><em>${ui.esc(r.rent ? tr('lead|{amount}/mo', { amount: ui.money(mo, { compact: true }) }) : tr('Set rates'))}</em></a>${u.status === 'hold' ? ui.unitBadge('hold') : edit ? ui.form(`/admin/units/${u.id}/hold`, csrf, `<input type="hidden" name="lead_id" value="${l.id}"><button class="btn btn--ghost btn--xs" type="submit">${ui.esc(tr('unit|Hold'))}</button>`) : ''}</li>`;
        }).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('No available unit fits the brief right now.'))}</p>`;

    const offerList = offers.length
      ? `<ul class="list">${offers.map((o) => `<li><a href="/admin/offers/${o.id}"><span class="what"><b>${ui.esc(o.ref)}</b><small>${ui.esc(tr('lead|{rate}/m²', { rate: ui.money(o.rent_m2) }))} · ${ui.esc(tn(o.term_years, 'lead|{n} year', 'lead|{n} years'))} · ${ui.date(o.created_at)}</small></span>${ui.badge(o.status, M.OFFER_STATUS[o.status])}</a></li>`).join('')}${leases.map((s) => `<li><a href="/admin/leases/${s.id}"><span class="what"><b>${ui.esc(tr('search|Lease'))} ${ui.esc(s.ref)}</b><small>${ui.date(s.start_date)} – ${ui.date(s.end_date)}</small></span>${ui.badge(s.status, M.LEASE_STATUS[s.status])}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('No offers yet.'))}</p>`;

    const lostForm = edit && l.stage !== 'lost'
      ? `<details class="danger"><summary>${ui.esc(tr('Mark as lost'))}</summary>${ui.form(`/admin/leads/${l.id}/lost`, csrf, `${ui.select('reason', tr('Reason'), M.LOST_REASONS.map((r) => [r, tx(r)]), '', { required: true })}${ui.textarea('note', tr('Note'), '', { rows: 2 })}${ui.btn(ui.esc(tr('Mark lost')), { cls: 'btn--danger btn--sm' })}`, { cls: 'stack' })}</details>`
      : '';
    const del = h.can(req, 'manager') ? `<details class="danger"><summary>${ui.esc(tr('Delete lead'))}</summary>${ui.form(`/admin/leads/${l.id}/delete`, csrf, `<p class="muted">${ui.esc(tr('Deletes the lead, its timeline and offers. This cannot be undone.'))}</p>${ui.btn(ui.esc(tr('Delete for good')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('Delete this lead for good?') } })}`, { cls: 'stack' })}</details>` : '';

    const head = `<div class="leadhead">
      <div class="leadhead__stats">
        <div><small>${ui.esc(tr('Stage'))}</small>${ui.stageBadge(l.stage)}</div>
        <div><small>${ui.esc(tr('Annual value'))}</small><b>${ui.money(l.value_est, { compact: true })}</b></div>
        <div><small>${ui.esc(tr('Probability'))}</small><b>${l.probability}%</b></div>
        <div><small>${ui.esc(tr('lead|Weighted'))}</small><b>${ui.money((l.value_est * l.probability) / 100, { compact: true })}</b></div>
        <div><small>${ui.esc(tr('Score'))}</small>${scorePill(sc)}</div>
        <div><small>${ui.esc(tr('Next step'))}</small><b class="${l.next_step_at && l.next_step_at < M.today() ? 'late' : ''}">${ui.esc(tx(l.next_step) || '—')}</b>${l.next_step_at ? `<small>${ui.rel(l.next_step_at)}</small>` : ''}</div>
      </div>
      ${stepper}
    </div>`;

    const body = `${head}
<div class="grid grid--side">
  <div class="stack">${edit ? ui.card(tr('Log activity'), actForm) : ''}${ui.card(tr('Timeline'), timeline, { sub: ui.esc(`${tn(acts.length, 'lead|{n} entry', 'lead|{n} entries')} · ${tn(views, 'lead|{n} viewing', 'lead|{n} viewings')}`) })}</div>
  <div class="stack">
    ${ui.card(tr('Contact'), contact)}
    ${(h.leadPanels || []).map((fn) => fn(req, l) || '').join('')}
    ${ui.card(tr('Details'), details, { action: edit ? ui.btn(ui.esc(tr('Edit')), { href: `/admin/leads/${l.id}/edit`, cls: 'btn--ghost btn--sm' }) : '' })}
    ${ui.card(tr('Offers & lease'), offerList, { action: edit ? ui.btn(ui.esc(tr('New offer')), { href: `/admin/offers/new?lead=${l.id}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '' })}
    ${ui.card(tr('Units that fit'), matches)}
    ${lostForm}${del}
  </div>
</div>`;
    h.page(req, res, {
      title: l.title, crumbs: [['/admin/leads', tr('Leads')], [null, l.ref]], active: '/admin/leads', body,
      actions: edit ? `${ui.btn(ui.esc(tr('Edit')), { href: `/admin/leads/${l.id}/edit`, cls: 'btn--ghost' })}${ui.btn(ui.esc(tr('New offer')), { href: `/admin/offers/new?lead=${l.id}`, cls: 'btn--primary', ic: 'offer' })}` : '',
    });
  });

  router.get('/leads/:id/edit', R('agent'), (req, res, next) => {
    const l = leadOf(req.params.id);
    if (!l) return next();
    if (!canEdit(req, l)) return h.back(req, res, `/admin/leads/${l.id}`, 'error', tr('Only the owner or a manager can edit this lead.'));
    h.page(req, res, { title: tr('lead|Edit {name}', { name: l.title }), crumbs: [['/admin/leads', tr('Leads')], [`/admin/leads/${l.id}`, l.ref], [null, tr('Edit')]], active: '/admin/leads', body: ui.card(tr('Lead details'), leadForm(req, l)) });
  });

  router.post('/leads/:id', R('agent'), (req, res, next) => {
    const old = leadOf(req.params.id);
    if (!old) return next();
    if (!canEdit(req, old)) return h.back(req, res, `/admin/leads/${old.id}`, 'error', tr('Only the owner or a manager can edit this lead.'));
    const l = readLead(req);
    if (!l.title) return h.back(req, res, `/admin/leads/${old.id}/edit`, 'error', tr('Give the lead a name.'));
    // the form shows the next step in the reader's language; keep the stored English when it was not changed
    if (l.next_step && old.next_step && l.next_step === tx(old.next_step)) l.next_step = old.next_step;
    if (!l.brand_id) l.brand_id = old.brand_id;
    l.value_est = M.estimateValue(db, l);
    db.run(
      `UPDATE leads SET title = ?, brand_id = ?, contact_id = COALESCE(?, contact_id), category = ?, source = ?, area_min = ?, area_max = ?, budget_m2 = ?, zone = ?, unit_id = ?, value_est = ?, owner_id = ?, next_step = ?, next_step_at = ?, message = ?, updated_at = ? WHERE id = ?`,
      l.title, l.brand_id, l.contact_id, l.category, l.source, l.area_min, l.area_max, l.budget_m2, l.zone, l.unit_id, l.value_est, l.owner_id, l.next_step, l.next_step_at, l.message, M.now(), old.id,
    );
    if (l.owner_id && l.owner_id !== old.owner_id && l.owner_id !== req.user.id) {
      db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, due_at, created_at) VALUES (?, ?, ?, 'task', ?, ?, ?)", old.id, old.brand_id, l.owner_id, `New lead assigned to you: ${l.title}`, M.today(), M.now());
    }
    h.log(req, 'Updated a lead', 'lead', old.id, l.title);
    h.back(req, res, `/admin/leads/${old.id}`, 'ok', tr('Saved.'));
  });

  router.post('/leads/:id/stage', R('agent'), (req, res, next) => {
    const l = leadOf(req.params.id);
    if (!l) return next();
    const json = req.accepts(['html', 'json']) === 'json';
    if (!canEdit(req, l)) return json ? res.status(403).json({ ok: false, error: tr('Only the owner or a manager can move this lead.') }) : h.back(req, res, `/admin/leads/${l.id}`, 'error', tr('Only the owner or a manager can move this lead.'));
    const s = M.STAGES.find((x) => x.id === req.body.stage);
    if (!s) return json ? res.status(422).json({ ok: false, error: tr('Unknown stage.') }) : h.back(req, res, `/admin/leads/${l.id}`, 'error', tr('Unknown stage.'));
    if (s.id === 'lost' && !req.body.reason) {
      if (json) return res.status(422).json({ ok: false, error: tr('Open the lead to mark it lost with a reason.') });
      return h.back(req, res, `/admin/leads/${l.id}`, 'error', tr('Give a reason when marking a lead lost.'));
    }
    changeStage(req, l, s.id, { reason: h.str(req.body.reason, 80) });
    if (json) return res.json({ ok: true, stage: s.id, label: s.label, probability: s.p });
    h.back(req, res, `/admin/leads/${l.id}`, 'ok', tr('flash|Moved to {stage}.', { stage: s.label }));
  });

  router.post('/leads/:id/lost', R('agent'), (req, res, next) => {
    const l = leadOf(req.params.id);
    if (!l) return next();
    if (!canEdit(req, l)) return h.back(req, res, `/admin/leads/${l.id}`, 'error', tr('Only the owner or a manager can do that.'));
    changeStage(req, l, 'lost', { reason: h.str(req.body.reason, 80), note: h.str(req.body.note, 1000) || null });
    db.run("UPDATE units SET status = 'available', hold_until = NULL, hold_lead_id = NULL, updated_at = ? WHERE hold_lead_id = ? AND status IN ('hold','reserved')", M.now(), l.id);
    h.back(req, res, `/admin/leads/${l.id}`, 'ok', tr('Marked as lost. Any units held for it are available again.'));
  });

  router.post('/leads/:id/delete', R('manager'), (req, res) => {
    const l = db.get('SELECT * FROM leads WHERE id = ?', req.params.id);
    if (l) {
      db.tx(() => {
        db.run("UPDATE units SET status = 'available', hold_until = NULL, hold_lead_id = NULL WHERE hold_lead_id = ? AND status IN ('hold','reserved')", l.id);
        db.run('UPDATE messages SET lead_id = NULL WHERE lead_id = ?', l.id);
        db.run('DELETE FROM leads WHERE id = ?', l.id);
      });
      h.log(req, 'Deleted a lead', 'lead', l.id, `${l.ref} · ${l.title}`);
    }
    h.back(req, res, '/admin/leads', 'ok', tr('Lead deleted.'));
  });

  // ---------- pipeline board ----------
  router.get('/pipeline', (req, res) => {
    const who = req.query.owner === 'me' ? req.user.id : h.int(req.query.owner);
    const leads = db.all(
      `SELECT l.*, b.name brand_name, u.name owner_name, (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id) acts, (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id AND a.type = 'viewing') views
       FROM leads l LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN users u ON u.id = l.owner_id
       WHERE (l.stage != 'won' OR l.closed_at >= ?) AND l.stage != 'lost' ${who ? 'AND l.owner_id = ?' : ''} ORDER BY l.value_est DESC`,
      new Date(Date.now() - 60 * 86400000).toISOString(), ...(who ? [who] : []),
    );
    const cols = M.STAGES.filter((s) => s.id !== 'lost').map((s) => {
      const list = leads.filter((l) => l.stage === s.id);
      const val = list.reduce((a, l) => a + l.value_est, 0);
      const cards = list.map((l) => {
        const sc = scoreOf(l, { activities: l.acts, viewings: l.views });
        const late = l.next_step_at && l.next_step_at < M.today();
        return `<article class="kcard" draggable="${h.can(req, 'agent')}" data-id="${l.id}" data-href="/admin/leads/${l.id}">
          <header><b>${ui.esc(l.title)}</b>${scorePill(sc)}</header>
          <p class="kcard__meta">${ui.esc(M.CATEGORIES[l.category])}${l.area_min || l.area_max ? ` · ${area(l)}` : ''}</p>
          <p class="kcard__val">${ui.money(l.value_est, { compact: true })}<small> ${ui.esc(tr('/ yr'))}</small></p>
          <footer>${l.owner_name ? `<span class="avatar avatar--xs" title="${ui.esc(l.owner_name)}">${ui.esc(ui.initials(l.owner_name))}</span>` : `<span class="avatar avatar--xs avatar--empty" title="${ui.esc(tr('Unassigned'))}">?</span>`}${l.next_step_at ? `<span class="${late ? 'late' : 'muted'}">${ui.esc(l.next_step ? tx(l.next_step) : tr('Follow up'))} · ${ui.rel(l.next_step_at)}</span>` : ''}</footer>
        </article>`;
      }).join('');
      return `<section class="kcol" data-stage="${s.id}"><header class="kcol__head"><span class="badge badge--${ui.TONE[s.id]}">${ui.esc(s.label)}</span><b data-count>${list.length}</b><small>${ui.money(val, { compact: true })}${s.id !== 'won' ? ` · ${s.p}%` : ''}</small></header><div class="kcol__list" data-drop>${cards || ''}</div></section>`;
    }).join('');
    const filter = `<nav class="tabs"><a class="tab${!who ? ' is-on' : ''}" href="/admin/pipeline">${ui.esc(tr('Everyone'))}</a><a class="tab${req.query.owner === 'me' ? ' is-on' : ''}" href="/admin/pipeline?owner=me">${ui.esc(tr('My deals'))}</a>${h.users().filter((u) => u.role !== 'viewer').map((u) => `<a class="tab${who === u.id && req.query.owner !== 'me' ? ' is-on' : ''}" href="/admin/pipeline?owner=${u.id}">${ui.esc(u.name.split(' ')[0])}</a>`).join('')}</nav>`;
    h.page(req, res, {
      title: tr('Pipeline'), active: '/admin/pipeline', wide: true,
      body: `${filter}<p class="muted hint">${ui.esc(tr('Drag a card to move it to another stage. Signed deals stay on the board for 60 days. To mark one lost, open it.'))}</p><div class="kanban" data-kanban>${cols}</div>`,
      actions: h.can(req, 'agent') ? ui.btn(ui.esc(tr('New lead')), { href: '/admin/leads/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  // ---------- activities ----------
  router.post('/activities', R('agent'), (req, res) => {
    const leadId = h.int(req.body.lead_id);
    const lead = leadId ? db.get('SELECT * FROM leads WHERE id = ?', leadId) : null;
    const type = M.ACTIVITY_TYPES[req.body.type] ? req.body.type : 'note';
    const subject = h.str(req.body.subject, 200);
    const back = lead ? `/admin/leads/${lead.id}` : '/admin/calendar';
    if (!subject) return h.back(req, res, back, 'error', tr('Say what happened or what to do.'));
    const due = h.str(req.body.due_at, 16) || null;
    const future = due && due.slice(0, 10) >= M.today() && type !== 'note';
    db.run(
      'INSERT INTO activities (lead_id, brand_id, user_id, type, subject, body, due_at, done_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      lead ? lead.id : null, lead ? lead.brand_id : null, h.int(req.body.user_id) || req.user.id, type, subject, h.str(req.body.body, 4000) || null, due, future ? null : due || M.now(), M.now(),
    );
    if (lead) {
      const upd = ['UPDATE leads SET updated_at = ?'];
      const args = [M.now()];
      if (future) { upd.push('next_step = ?, next_step_at = ?'); args.push(subject, due.slice(0, 10)); }
      if (lead.stage === 'new' && ['call', 'email', 'whatsapp', 'meeting'].includes(type) && !future) { upd.push("stage = 'contacted', probability = 20, stage_at = ?"); args.push(M.now()); }
      if (type === 'viewing' && M.stage(lead.stage).p < 35) { upd.push("stage = 'viewing', probability = 35, stage_at = ?"); args.push(M.now()); }
      db.run(`${upd.join(', ')} WHERE id = ?`, ...args, lead.id);
    }
    h.log(req, `Logged ${type}`, 'lead', lead ? lead.id : null, subject);
    h.back(req, res, back, 'ok', future ? tr('Scheduled.') : tr('Added to the timeline.'));
  });

  router.post('/activities/:id/done', R('agent'), (req, res) => {
    const a = db.get('SELECT * FROM activities WHERE id = ?', req.params.id);
    if (a && !a.done_at) {
      db.run('UPDATE activities SET done_at = ? WHERE id = ?', M.now(), a.id);
      if (a.lead_id) {
        db.run('UPDATE leads SET updated_at = ? WHERE id = ?', M.now(), a.lead_id);
        const next = db.get('SELECT subject, due_at FROM activities WHERE lead_id = ? AND done_at IS NULL AND due_at IS NOT NULL ORDER BY due_at LIMIT 1', a.lead_id);
        db.run('UPDATE leads SET next_step = ?, next_step_at = ? WHERE id = ?', next ? next.subject : null, next ? next.due_at.slice(0, 10) : null, a.lead_id);
      }
      h.log(req, 'Completed', 'activity', a.id, a.subject);
    }
    if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
    h.back(req, res, req.get('referer') && req.get('referer').includes('/admin') ? req.get('referer') : '/admin', 'ok', tr('Done.'));
  });

  // ---------- calendar ----------
  router.get('/calendar', (req, res) => {
    const m = /^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : M.today().slice(0, 7);
    const mine = req.query.who === 'me';
    const [y, mo] = m.split('-').map(Number);
    const first = new Date(Date.UTC(y, mo - 1, 1));
    const startDow = (first.getUTCDay() + 6) % 7; // Monday first
    const gridStart = M.addDays(`${m}-01`, -startDow);
    const days = Array.from({ length: 42 }, (_, i) => M.addDays(gridStart, i));
    const acts = db.all(
      `SELECT a.*, l.title lead_title, u.name user_name FROM activities a LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id
       WHERE a.due_at >= ? AND a.due_at < ? ${mine ? 'AND a.user_id = ?' : ''} ORDER BY a.due_at`,
      days[0], M.addDays(days[41], 1), ...(mine ? [req.user.id] : []),
    );
    const prev = M.addMonths(`${m}-01`, -1).slice(0, 7);
    const next = M.addMonths(`${m}-01`, 1).slice(0, 7);
    const t = M.today();
    const cells = days.map((d) => {
      const list = acts.filter((a) => a.due_at.slice(0, 10) === d);
      const items = list.slice(0, 4).map((a) => `<a class="ev ev--${a.type}${a.done_at ? ' is-done' : ''}" href="/admin/leads/${a.lead_id || ''}" title="${ui.esc(`${tx(a.subject)} · ${a.lead_title || ''} · ${a.user_name || ''}`)}"><b>${ui.local(a.due_at).slice(11, 16) || ''}</b> ${ui.esc(tx(a.subject))}</a>`).join('');
      return `<div class="cal__d${d.slice(0, 7) !== m ? ' is-out' : ''}${d === t ? ' is-today' : ''}"><span class="cal__n">${Number(d.slice(8))}</span>${items}${list.length > 4 ? `<span class="muted">${ui.esc(tr('cal|+{n} more', { n: list.length - 4 }))}</span>` : ''}</div>`;
    }).join('');
    const tasks = db.all(
      `SELECT a.*, l.title lead_title FROM activities a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.done_at IS NULL ${mine || !h.can(req, 'manager') ? 'AND a.user_id = ?' : ''} ORDER BY a.due_at IS NULL, a.due_at LIMIT 60`,
      ...(mine || !h.can(req, 'manager') ? [req.user.id] : []),
    );
    const group = (label, list) => (list.length ? `<h3 class="grouphead">${ui.esc(label)} <small>${list.length}</small></h3><ul class="list">${list.map((a) => `<li class="${a.due_at && a.due_at.slice(0, 10) < t ? 'is-late' : ''}"><a href="/admin/leads/${a.lead_id || ''}"><span class="dot dot--${a.type === 'viewing' ? 'sea' : a.type === 'meeting' ? 'cocoa' : 'amber'}"></span><span class="what"><b>${ui.esc(tx(a.subject))}</b><small>${ui.esc(a.lead_title || tr('No lead'))} · ${ui.esc(M.ACTIVITY_TYPES[a.type])}${a.due_at ? ` · ${ui.dt(a.due_at)}` : ''}</small></span></a>${h.can(req, 'agent') ? ui.form(`/admin/activities/${a.id}/done`, req.session.csrf, markDone()) : ''}</li>`).join('')}</ul>` : '');
    const late = tasks.filter((a) => a.due_at && a.due_at.slice(0, 10) < t);
    const today = tasks.filter((a) => a.due_at && a.due_at.slice(0, 10) === t);
    const soon = tasks.filter((a) => a.due_at && a.due_at.slice(0, 10) > t);
    const undated = tasks.filter((a) => !a.due_at);
    const monthName = ui.monthYear(m);
    void first;
    const leads = db.all(`SELECT id, title FROM leads WHERE stage IN (${M.OPEN_STAGES.map((s) => `'${s}'`).join(',')}) ORDER BY title`);
    const quick = h.can(req, 'agent') ? ui.card(tr('Schedule'), ui.form('/admin/activities', req.session.csrf, `<div class="fields">
      ${ui.select('type', tr('Type'), ['viewing', 'meeting', 'call', 'task'].map((k) => [k, M.ACTIVITY_TYPES[k]]), 'viewing')}
      ${ui.select('lead_id', tr('Lead'), leads.map((l) => [l.id, l.title]), '', { blank: tr('No lead') })}
      ${ui.input('subject', tr('Title'), '', { required: true, placeholder: tr('e.g. Site viewing, plaza units'), cls: 'span-all' })}
      ${ui.input('due_at', tr('activity|When'), `${M.addDays(t, 1)}T11:00`, { type: 'datetime-local', required: true })}
      ${ui.select('user_id', tr('With'), h.users().map((u) => [u.id, u.name]), req.user.id)}
    </div>${ui.btn(ui.esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })) : '';
    const body = `<div class="grid grid--cal">
  <section class="card cal">
    <header class="card__head"><div><h2>${ui.esc(monthName)}</h2></div><div class="row">
      <a class="btn btn--ghost btn--sm" href="/admin/calendar?m=${prev}${mine ? '&who=me' : ''}" title="${ui.esc(tr('Previous month'))}" aria-label="${ui.esc(tr('Previous month'))}">${isAr() ? '→' : '←'}</a><a class="btn btn--ghost btn--sm" href="/admin/calendar${mine ? '?who=me' : ''}">${ui.esc(tr('cal|Today'))}</a><a class="btn btn--ghost btn--sm" href="/admin/calendar?m=${next}${mine ? '&who=me' : ''}" title="${ui.esc(tr('Next month'))}" aria-label="${ui.esc(tr('Next month'))}">${isAr() ? '←' : '→'}</a>
      <a class="btn btn--ghost btn--sm${mine ? ' is-on' : ''}" href="/admin/calendar?m=${m}${mine ? '' : '&who=me'}">${ui.esc(mine ? tr('Showing mine') : tr('Showing everyone'))}</a></div></header>
    <div class="cal__grid">${ui.weekdays().map((d) => `<span>${ui.esc(d)}</span>`).join('')}${cells}</div>
    <ul class="legend legend--row pad">${['viewing', 'meeting', 'call', 'task'].map((k) => `<li><i class="ev--${k}"></i>${ui.esc(M.ACTIVITY_TYPES[k])}</li>`).join('')}</ul>
  </section>
  <div class="stack">${quick}${ui.card(tr('Tasks'), `<div id="tasks">${group(tr('tasks|Overdue'), late)}${group(tr('cal|Today'), today)}${group(tr('Coming up'), soon)}${group(tr('No date'), undated)}${tasks.length ? '' : `<p class="muted pad">${ui.esc(tr('Nothing open. Enjoy it.'))}</p>`}</div>`)}</div>
</div>`;
    h.page(req, res, { title: tr('Calendar & tasks'), active: '/admin/calendar', wide: true, body });
  });
};
