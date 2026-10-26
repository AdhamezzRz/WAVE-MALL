'use strict';

// Deals: offers (with approval and a printable proposal), leases and billing.

module.exports = function deals(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;

  const offerOf = (id) => db.get(
    `SELECT o.*, l.title lead_title, l.ref lead_ref, l.stage lead_stage, l.brand_id, l.id lead_id, b.name brand_name, c.name contact_name, c.email contact_email, c.title contact_title,
     u.name author, a.name approver FROM offers o JOIN leads l ON l.id = o.lead_id LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN contacts c ON c.id = l.contact_id
     LEFT JOIN users u ON u.id = o.created_by LEFT JOIN users a ON a.id = o.approved_by WHERE o.id = ?`, id);
  const leaseOf = (id) => db.get('SELECT s.*, b.name brand_name, b.category, l.title lead_title FROM leases s JOIN brands b ON b.id = s.brand_id LEFT JOIN leads l ON l.id = s.lead_id WHERE s.id = ?', id);
  const terms = (o) => ({ rent_m2: o.rent_m2, terrace_rent_m2: o.terrace_rent_m2, service_m2: o.service_m2, term_years: o.term_years, escalation_pct: o.escalation_pct, rent_free_months: o.rent_free_months, deposit_months: o.deposit_months, key_money: o.key_money });

  function scheduleTable(sc, { showRate = true } = {}) {
    return `<div class="tablewrap"><table class="table table--fin"><thead><tr><th>Year</th>${showRate ? '<th class="num">Rate / m²</th>' : ''}<th class="num">Monthly rent</th><th class="num">Rent-free</th><th class="num">Rent</th><th class="num">Service</th><th class="num">Total</th></tr></thead><tbody>
      ${sc.years.map((y) => `<tr><td>Year ${y.year}</td>${showRate ? `<td class="num">${ui.money(y.rate, { cur: false })}</td>` : ''}<td class="num">${ui.money(y.monthRent, { cur: false })}</td><td class="num">${y.free ? `${y.free} mo` : '—'}</td><td class="num">${ui.money(y.rent, { cur: false })}</td><td class="num">${ui.money(y.service, { cur: false })}</td><td class="num"><b>${ui.money(y.total, { cur: false })}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="${showRate ? 4 : 3}">Contract total${Math.round(sc.total - sc.totalRent - sc.totalService) ? ' (incl. key money)' : ''}</td><td class="num">${ui.money(sc.totalRent, { cur: false })}</td><td class="num">${ui.money(sc.totalService, { cur: false })}</td><td class="num"><b>${ui.money(sc.total, { cur: false })}</b></td></tr></tfoot></table></div>`;
  }

  // ---------- offers ----------
  router.get('/offers', (req, res) => {
    const st = M.OFFER_STATUS[req.query.status] ? req.query.status : '';
    const rows = db.all(`SELECT o.*, l.title lead_title FROM offers o JOIN leads l ON l.id = o.lead_id ${st ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC LIMIT 400`, ...(st ? [st] : []))
      .map((o) => ({ ...o, units: M.offerUnits(db, o.id) }))
      .map((o) => ({ ...o, sc: M.schedule(terms(o), o.units) }));
    const tabs = [['', 'All'], ...Object.entries(M.OFFER_STATUS)].map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/offers${k ? `?status=${k}` : ''}">${l}${k === 'pending' && db.value("SELECT COUNT(*) FROM offers WHERE status = 'pending'") ? ` <b class="nav__count">${db.value("SELECT COUNT(*) FROM offers WHERE status = 'pending'")}</b>` : ''}</a>`).join('');
    const table = ui.table(
      [
        { label: 'Offer', render: (o) => `<b>${ui.esc(o.ref)}</b><small class="sub">${ui.esc(o.lead_title)}</small>` },
        { label: 'Units', render: (o) => ui.esc(o.units.map((u) => u.code).join(', ')) },
        { label: 'Area', num: true, render: (o) => ui.m2(o.sc.indoor) },
        { label: 'Rate / m²', num: true, render: (o) => ui.money(o.rent_m2, { cur: false }) },
        { label: 'Term', render: (o) => `${o.term_years} yrs · ${o.escalation_pct}%` },
        { label: 'Year 1 rent', num: true, render: (o) => ui.money(o.sc.years[0] ? o.sc.years[0].rent : 0, { compact: true }) },
        { label: 'Contract value', num: true, render: (o) => ui.money(o.sc.total, { compact: true }) },
        { label: 'Status', render: (o) => ui.badge(o.status, M.OFFER_STATUS[o.status]) },
        { label: 'Valid until', render: (o) => (o.valid_until ? `<span class="${o.valid_until < M.today() ? 'late' : ''}">${ui.date(o.valid_until)}</span>` : '—') },
      ],
      rows,
      { empty: 'No offers yet. Open a lead and choose New offer.', href: (o) => `/admin/offers/${o.id}` },
    );
    h.page(req, res, { title: 'Offers', active: '/admin/offers', wide: true, body: `<nav class="tabs">${tabs}</nav>${ui.card(`${rows.length} offers`, table)}` });
  });

  function offerForm(req, lead, o = {}) {
    const s = db.settings();
    const chosen = new Set((o.unit_ids || []).map(Number));
    if (!chosen.size && lead.unit_id) chosen.add(lead.unit_id);
    const units = db.all("SELECT * FROM units WHERE status IN ('available','hold') OR id IN (SELECT unit_id FROM offer_units WHERE offer_id = ?) ORDER BY sort", o.id || 0);
    const unitRows = units.map((u) => {
      const r = M.listRates(db, u);
      return `<label class="pick${chosen.has(u.id) ? ' is-on' : ''}"><input type="checkbox" name="units" value="${u.id}" ${chosen.has(u.id) ? 'checked' : ''} data-indoor="${u.indoor_m2}" data-terrace="${u.terrace_m2}" data-list="${r.rent ?? ''}">
        <b>${ui.esc(u.code)}</b><span>${ui.n0(u.indoor_m2)} m²${u.terrace_m2 ? ` + ${ui.n0(u.terrace_m2)} terrace` : ''}</span><em>${r.rent ? `list ${ui.money(r.rent, { cur: false })}` : 'no list rate'}</em>${u.status === 'hold' ? ui.unitBadge('hold') : ''}</label>`;
    }).join('');
    const firstList = units.filter((u) => chosen.has(u.id)).map((u) => M.listRates(db, u)).find((r) => r.rent) || M.listRates(db, units[0] || { zone: 'plaza' });
    const v = (k, d) => (o[k] !== undefined && o[k] !== null ? o[k] : d);
    return ui.form(o.id ? `/admin/offers/${o.id}` : '/admin/offers', req.session.csrf, `<input type="hidden" name="lead_id" value="${lead.id}">
      <div class="grid grid--side grid--offer" data-offer data-max-discount="${ui.esc(s.max_discount_pct)}" data-cur="${ui.esc(s.currency)}">
        <div class="stack">
          <fieldset><legend>Units</legend><div class="picks">${unitRows || '<p class="muted">No available units.</p>'}</div></fieldset>
          <fieldset><legend>Rent</legend><div class="fields">
            ${ui.input('rent_m2', 'Rent per m² / month', v('rent_m2', firstList.rent ?? ''), { type: 'number', min: 0, step: '0.01', required: true, attrs: { 'data-calc': 'rent' } })}
            ${ui.input('terrace_rent_m2', 'Terrace per m² / month', v('terrace_rent_m2', firstList.terrace ?? ''), { type: 'number', min: 0, step: '0.01', attrs: { 'data-calc': 'terrace' } })}
            ${ui.input('service_m2', 'Service charge per m² / month', v('service_m2', firstList.service || ''), { type: 'number', min: 0, step: '0.01', attrs: { 'data-calc': 'service' } })}
            ${ui.input('key_money', 'Key money (one-off)', v('key_money', 0), { type: 'number', min: 0, step: 1, attrs: { 'data-calc': 'key' } })}
          </div></fieldset>
          <fieldset><legend>Terms</legend><div class="fields">
            ${ui.input('term_years', 'Term (years)', v('term_years', s.default_term_years), { type: 'number', min: 1, max: 30, step: 1, required: true, attrs: { 'data-calc': 'term' } })}
            ${ui.input('escalation_pct', 'Yearly increase (%)', v('escalation_pct', s.default_escalation), { type: 'number', min: 0, max: 50, step: '0.5', attrs: { 'data-calc': 'esc' } })}
            ${ui.input('rent_free_months', 'Rent-free months', v('rent_free_months', 0), { type: 'number', min: 0, max: 36, step: 1, attrs: { 'data-calc': 'free' } })}
            ${ui.input('fitout_months', 'Fit-out period (months)', v('fitout_months', 2), { type: 'number', min: 0, max: 24, step: 1 })}
            ${ui.input('deposit_months', 'Deposit (months of rent)', v('deposit_months', s.default_deposit_months), { type: 'number', min: 0, max: 24, step: 1, attrs: { 'data-calc': 'deposit' } })}
            ${ui.input('start_date', 'Expected start', v('start_date', M.addMonths(M.today(), 2)), { type: 'date' })}
            ${ui.input('valid_until', 'Valid until', v('valid_until', M.addDays(M.today(), Number(s.offer_valid_days) || 21)), { type: 'date' })}
            ${ui.textarea('notes', 'Conditions and notes', v('notes', ''), { rows: 3, cls: 'span-all', placeholder: 'e.g. Signage per the design guidelines; trading hours 10:00–24:00' })}
          </div></fieldset>
        </div>
        <aside class="calc card" data-calc-out>
          <header class="card__head"><div><h2>The deal</h2><p>Updates as you type</p></div></header>
          <div class="card__body">
            <dl class="calc__dl">
              <div><dt>Area</dt><dd data-o="area">—</dd></div>
              <div><dt>Monthly rent, year 1</dt><dd data-o="month">—</dd></div>
              <div><dt>Annual rent, year 1</dt><dd data-o="annual">—</dd></div>
              <div><dt>Service charge / year</dt><dd data-o="service">—</dd></div>
              <div><dt>Deposit</dt><dd data-o="deposit">—</dd></div>
              <div class="calc__big"><dt>Contract value</dt><dd data-o="total">—</dd></div>
              <div><dt>Effective rate / m²</dt><dd data-o="eff">—</dd></div>
              <div><dt>Against list</dt><dd data-o="disc">—</dd></div>
            </dl>
            <p class="alert alert--warn" data-o="approval" hidden>${h.can(req, 'manager') ? 'Below the allowed discount. As a manager, your offer needs no further approval.' : 'Below the allowed discount: a sales manager will need to approve this offer.'}</p>
            <div class="calc__years" data-o="years"></div>
            ${ui.btn(o.id ? 'Save offer' : 'Create offer', { cls: 'btn--primary btn--block' })}
          </div>
        </aside>
      </div>`, { cls: 'form' });
  }

  function readOffer(req) {
    const b = req.body;
    return {
      lead_id: h.int(b.lead_id), unit_ids: h.list(b.units).map(Number).filter(Boolean),
      rent_m2: h.numv(b.rent_m2), terrace_rent_m2: h.numv(b.terrace_rent_m2) ?? 0, service_m2: h.numv(b.service_m2) ?? 0, key_money: h.numv(b.key_money) ?? 0,
      term_years: Math.max(1, Math.min(30, h.int(b.term_years) || 5)), escalation_pct: Math.max(0, Math.min(50, h.numv(b.escalation_pct) ?? 0)),
      rent_free_months: Math.max(0, h.int(b.rent_free_months) || 0), fitout_months: Math.max(0, h.int(b.fitout_months) || 0), deposit_months: Math.max(0, h.int(b.deposit_months) || 0),
      start_date: h.str(b.start_date, 10) || null, valid_until: h.str(b.valid_until, 10) || null, notes: h.str(b.notes, 3000) || null,
    };
  }

  router.get('/offers/new', R('agent'), (req, res, next) => {
    const lead = db.get('SELECT * FROM leads WHERE id = ?', h.int(req.query.lead));
    if (!lead) return h.back(req, res, '/admin/leads', 'error', 'Open a lead first, then make an offer from it.');
    const from = req.query.from ? db.get('SELECT * FROM offers WHERE id = ?', h.int(req.query.from)) : null;
    const pre = from ? { ...from, id: undefined, unit_ids: M.offerUnits(db, from.id).map((u) => u.id) } : {};
    void next;
    h.page(req, res, { title: `Offer for ${lead.title}`, crumbs: [['/admin/leads', 'Leads'], [`/admin/leads/${lead.id}`, lead.ref], [null, 'New offer']], active: '/admin/offers', wide: true, body: offerForm(req, lead, pre) });
  });

  function saveOffer(req, o, id) {
    const units = o.unit_ids.length ? db.all(`SELECT * FROM units WHERE id IN (${o.unit_ids.map(() => '?').join(',')})`, ...o.unit_ids) : [];
    const approval = M.needsApproval(db, o, units) && !h.can(req, 'manager');
    const status = approval ? 'pending' : 'draft';
    return db.tx(() => {
      let offerId = id;
      if (id) {
        db.run(
          `UPDATE offers SET status = ?, rent_m2 = ?, terrace_rent_m2 = ?, service_m2 = ?, term_years = ?, escalation_pct = ?, rent_free_months = ?, fitout_months = ?, deposit_months = ?, key_money = ?, start_date = ?, valid_until = ?, notes = ?, needs_approval = ?, approved_by = NULL, approved_at = NULL WHERE id = ?`,
          status, o.rent_m2, o.terrace_rent_m2, o.service_m2, o.term_years, o.escalation_pct, o.rent_free_months, o.fitout_months, o.deposit_months, o.key_money, o.start_date, o.valid_until, o.notes, approval ? 1 : 0, id,
        );
        db.run('DELETE FROM offer_units WHERE offer_id = ?', id);
      } else {
        offerId = Number(db.run(
          `INSERT INTO offers (ref, lead_id, status, rent_m2, terrace_rent_m2, service_m2, term_years, escalation_pct, rent_free_months, fitout_months, deposit_months, key_money, start_date, valid_until, notes, needs_approval, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          db.nextRef('offers', 'OF', 3, true), o.lead_id, status, o.rent_m2, o.terrace_rent_m2, o.service_m2, o.term_years, o.escalation_pct, o.rent_free_months, o.fitout_months, o.deposit_months, o.key_money, o.start_date, o.valid_until, o.notes, approval ? 1 : 0, req.user.id, M.now(),
        ).lastInsertRowid);
      }
      for (const u of units) db.run('INSERT INTO offer_units (offer_id, unit_id) VALUES (?, ?)', offerId, u.id);
      const sc = M.schedule(o, units);
      db.run('UPDATE leads SET value_est = ?, updated_at = ? WHERE id = ?', Math.round(sc.years[0] ? sc.years[0].rent + sc.years[0].free * sc.years[0].monthRent : 0), M.now(), o.lead_id);
      return { offerId, approval };
    });
  }

  router.post('/offers', R('agent'), (req, res) => {
    const o = readOffer(req);
    const lead = db.get('SELECT * FROM leads WHERE id = ?', o.lead_id);
    if (!lead) return h.back(req, res, '/admin/leads', 'error', 'That lead no longer exists.');
    if (!o.unit_ids.length || !o.rent_m2) return h.back(req, res, `/admin/offers/new?lead=${lead.id}`, 'error', 'Pick at least one unit and set the rent.');
    const { offerId, approval } = saveOffer(req, o);
    if (M.stage(lead.stage).p < 50) h.changeStage(req, lead, 'proposal');
    if (approval) {
      for (const m of db.all("SELECT id FROM users WHERE active = 1 AND role IN ('manager','admin')")) {
        db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, due_at, created_at) VALUES (?, ?, ?, 'task', ?, ?, ?)", lead.id, lead.brand_id, m.id, `Approve offer for ${lead.title}`, M.today(), M.now());
      }
    }
    h.log(req, approval ? 'Sent an offer for approval' : 'Created an offer', 'offer', offerId, lead.title);
    h.back(req, res, `/admin/offers/${offerId}`, 'ok', approval ? 'Offer created. It is below the allowed discount, so a manager will approve it.' : 'Offer created.');
  });

  router.get('/offers/:id', (req, res, next) => {
    const o = offerOf(req.params.id);
    if (!o) return next();
    const units = M.offerUnits(db, o.id);
    const sc = M.schedule(terms(o), units);
    const list = units.map((u) => M.listRates(db, u).rent).filter(Boolean);
    const listAvg = list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
    const csrf = req.session.csrf;
    const act = (path, label, cls = 'btn--ghost', confirm) => ui.form(`/admin/offers/${o.id}/${path}`, csrf, ui.btn(label, { cls, attrs: confirm ? { 'data-confirm': confirm } : {} }));
    const actions = [];
    if (o.status === 'pending' && h.can(req, 'manager')) actions.push(act('approve', 'Approve', 'btn--primary'), act('reject', 'Send back', 'btn--ghost'));
    if (['draft', 'approved'].includes(o.status) && h.can(req, 'agent')) actions.push(act('sent', 'Mark as sent', 'btn--primary'));
    if (o.status === 'sent' && h.can(req, 'agent')) actions.push(act('accepted', 'Accepted', 'btn--primary', 'Mark accepted? The units will be reserved for this brand.'), act('rejected', 'Declined', 'btn--ghost'));
    if (o.status === 'accepted' && h.can(req, 'manager') && !db.value('SELECT COUNT(*) FROM leases WHERE offer_id = ?', o.id)) actions.push(ui.btn('Create lease', { href: `/admin/leases/new?offer=${o.id}`, cls: 'btn--primary', ic: 'lease' }));
    if (['draft', 'pending'].includes(o.status) && h.can(req, 'agent')) actions.push(ui.btn('Edit', { href: `/admin/offers/${o.id}/edit`, cls: 'btn--ghost' }));
    if (h.can(req, 'agent')) actions.push(ui.btn('Revise', { href: `/admin/offers/new?lead=${o.lead_id}&from=${o.id}`, cls: 'btn--ghost' }));
    actions.push(ui.btn('Proposal', { href: `/admin/offers/${o.id}/print`, cls: 'btn--ghost', ic: 'print', attrs: { target: '_blank' } }));

    const banner = o.status === 'pending'
      ? `<p class="alert alert--warn">This offer is below the list rate by more than ${ui.esc(db.setting('max_discount_pct'))}%. ${h.can(req, 'manager') ? 'Approve it to let the team send it.' : 'A sales manager needs to approve it before it is sent.'}</p>`
      : o.approved_by ? `<p class="alert alert--ok">Approved by ${ui.esc(o.approver)} on ${ui.date(o.approved_at)}.</p>` : '';
    const kpis = [
      ui.kpi({ label: 'Area', value: ui.m2(sc.indoor), sub: sc.outdoor ? `+ ${ui.m2(sc.outdoor)} terrace` : 'No terrace' }),
      ui.kpi({ label: 'Monthly rent, year 1', value: ui.money(sc.firstMonth, { compact: true }), sub: `${ui.money(o.rent_m2)} / m²${listAvg ? ` · list ${ui.money(listAvg, { cur: false })} (${o.rent_m2 >= listAvg ? '+' : ''}${(((o.rent_m2 - listAvg) / listAvg) * 100).toFixed(1)}%)` : ''}` }),
      ui.kpi({ label: 'Contract value', value: ui.money(sc.total, { compact: true }), sub: `${o.term_years} years · +${o.escalation_pct}% a year` }),
      ui.kpi({ label: 'Deposit', value: ui.money(sc.deposit, { compact: true }), sub: `${o.deposit_months} months of rent` }),
      ui.kpi({ label: 'Effective rate', value: ui.money(sc.effective, { cur: false }), sub: `per m² / month after ${o.rent_free_months} rent-free months` }),
    ].join('');
    const unitsTable = ui.table(
      [
        { label: 'Unit', render: (u) => `<a href="/admin/units/${u.id}"><b>${ui.esc(u.code)}</b></a>` },
        { label: 'Level', render: (u) => ui.esc(M.ZONES[u.zone]) },
        { label: 'Indoor', num: true, render: (u) => ui.m2(u.indoor_m2) },
        { label: 'Terrace', num: true, render: (u) => ui.m2(u.terrace_m2) },
        { label: 'Monthly rent', num: true, render: (u) => ui.money(u.indoor_m2 * o.rent_m2 + u.terrace_m2 * o.terrace_rent_m2) },
        { label: 'Status', render: (u) => ui.unitBadge(u.status) },
      ],
      units,
    );
    const facts = `<dl class="dl">
      <div><dt>For</dt><dd><a href="/admin/leads/${o.lead_id}">${ui.esc(o.lead_title)}</a> · ${ui.esc(o.lead_ref)}</dd></div>
      <div><dt>Status</dt><dd>${ui.badge(o.status, M.OFFER_STATUS[o.status])}</dd></div>
      <div><dt>Rent</dt><dd>${ui.money(o.rent_m2)} / m² · terrace ${ui.money(o.terrace_rent_m2, { cur: false })} · service ${ui.money(o.service_m2, { cur: false })}</dd></div>
      <div><dt>Term</dt><dd>${o.term_years} years, +${o.escalation_pct}% yearly</dd></div>
      <div><dt>Incentives</dt><dd>${o.rent_free_months} months rent-free · ${o.fitout_months} months fit-out</dd></div>
      <div><dt>Key money</dt><dd>${ui.money(o.key_money)}</dd></div>
      <div><dt>Start</dt><dd>${ui.date(o.start_date)}</dd></div>
      <div><dt>Valid until</dt><dd>${ui.date(o.valid_until)}${o.valid_until ? ` · ${ui.rel(o.valid_until)}` : ''}</dd></div>
      <div><dt>Prepared by</dt><dd>${ui.esc(o.author || '—')} · ${ui.date(o.created_at)}</dd></div>
      ${o.sent_at ? `<div><dt>Sent</dt><dd>${ui.date(o.sent_at)}</dd></div>` : ''}
    </dl>${o.notes ? `<blockquote class="quote quote--sm">${ui.esc(o.notes).replace(/\n/g, '<br>')}</blockquote>` : ''}`;
    const body = `${banner}<div class="kpis kpis--5">${kpis}</div>
<div class="grid grid--side">
  <div class="stack">${ui.card('Rent schedule', scheduleTable(sc), { sub: `${ui.esc(db.setting('currency'))}, before VAT` })}${ui.card('Units', unitsTable)}</div>
  <div class="stack">${ui.card('Terms', facts)}</div>
</div>`;
    h.page(req, res, { title: `Offer ${o.ref}`, crumbs: [['/admin/offers', 'Offers'], [`/admin/leads/${o.lead_id}`, o.lead_title], [null, o.ref]], active: '/admin/offers', body, actions: `<div class="row">${actions.join('')}</div>` });
  });

  router.get('/offers/:id/edit', R('agent'), (req, res, next) => {
    const o = db.get('SELECT * FROM offers WHERE id = ?', req.params.id);
    if (!o) return next();
    if (!['draft', 'pending'].includes(o.status)) return h.back(req, res, `/admin/offers/${o.id}`, 'error', 'Only draft offers can be edited. Use Revise to make a new version.');
    const lead = db.get('SELECT * FROM leads WHERE id = ?', o.lead_id);
    h.page(req, res, { title: `Edit ${o.ref}`, crumbs: [['/admin/offers', 'Offers'], [`/admin/offers/${o.id}`, o.ref], [null, 'Edit']], active: '/admin/offers', wide: true, body: offerForm(req, lead, { ...o, unit_ids: M.offerUnits(db, o.id).map((u) => u.id) }) });
  });

  router.post('/offers/:id', R('agent'), (req, res, next) => {
    const old = db.get('SELECT * FROM offers WHERE id = ?', req.params.id);
    if (!old) return next();
    if (!['draft', 'pending'].includes(old.status)) return h.back(req, res, `/admin/offers/${old.id}`, 'error', 'Only draft offers can be edited.');
    const o = { ...readOffer(req), lead_id: old.lead_id };
    if (!o.unit_ids.length || !o.rent_m2) return h.back(req, res, `/admin/offers/${old.id}/edit`, 'error', 'Pick at least one unit and set the rent.');
    const { approval } = saveOffer(req, o, old.id);
    h.log(req, 'Edited an offer', 'offer', old.id, old.ref);
    h.back(req, res, `/admin/offers/${old.id}`, 'ok', approval ? 'Saved. It needs a manager’s approval.' : 'Saved.');
  });

  const transition = (from, to, min, after) => (req, res, next) => {
    const o = offerOf(req.params.id);
    if (!o) return next();
    if (!from.includes(o.status)) return h.back(req, res, `/admin/offers/${o.id}`, 'error', `This offer is ${M.OFFER_STATUS[o.status].toLowerCase()}.`);
    db.tx(() => {
      db.run('UPDATE offers SET status = ? WHERE id = ?', to, o.id);
      if (after) after(req, o);
    });
    h.log(req, `Offer ${M.OFFER_STATUS[to].toLowerCase()}`, 'offer', o.id, `${o.ref} · ${o.lead_title}`);
    h.back(req, res, `/admin/offers/${o.id}`, 'ok', `Offer ${M.OFFER_STATUS[to].toLowerCase()}.`);
  };
  const leadRow = (o) => db.get('SELECT * FROM leads WHERE id = ?', o.lead_id);
  router.post('/offers/:id/approve', R('manager'), transition(['pending'], 'approved', 'manager', (req, o) => {
    db.run('UPDATE offers SET approved_by = ?, approved_at = ? WHERE id = ?', req.user.id, M.now(), o.id);
    db.run("UPDATE activities SET done_at = ? WHERE lead_id = ? AND type = 'task' AND done_at IS NULL AND subject LIKE 'Approve offer%'", M.now(), o.lead_id);
  }));
  router.post('/offers/:id/reject', R('manager'), transition(['pending'], 'draft', 'manager', (req, o) => {
    db.run("UPDATE activities SET done_at = ? WHERE lead_id = ? AND type = 'task' AND done_at IS NULL AND subject LIKE 'Approve offer%'", M.now(), o.lead_id);
    db.run("INSERT INTO activities (lead_id, user_id, type, subject, due_at, created_at) VALUES (?, ?, 'task', ?, ?, ?)", o.lead_id, o.created_by, `Revise offer ${o.ref}: not approved at this rate`, M.today(), M.now());
  }));
  router.post('/offers/:id/sent', R('agent'), transition(['draft', 'approved'], 'sent', 'agent', (req, o) => {
    db.run('UPDATE offers SET sent_at = ? WHERE id = ?', M.now(), o.id);
    const l = leadRow(o);
    if (M.stage(l.stage).p < 50) h.changeStage(req, l, 'proposal');
    db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, due_at, created_at) VALUES (?, ?, ?, 'call', ?, ?, ?)", o.lead_id, o.brand_id, req.user.id, `Follow up on offer ${o.ref}`, M.addDays(M.today(), 3), M.now());
    db.run('UPDATE leads SET next_step = ?, next_step_at = ? WHERE id = ?', `Follow up on offer ${o.ref}`, M.addDays(M.today(), 3), o.lead_id);
  }));
  router.post('/offers/:id/accepted', R('agent'), transition(['sent'], 'accepted', 'agent', (req, o) => {
    db.run('UPDATE offers SET decided_at = ? WHERE id = ?', M.now(), o.id);
    for (const u of M.offerUnits(db, o.id)) {
      if (u.status !== 'leased') db.run("UPDATE units SET status = 'reserved', hold_lead_id = ?, hold_until = NULL, updated_at = ? WHERE id = ?", o.lead_id, M.now(), u.id);
    }
    const l = leadRow(o);
    if (M.stage(l.stage).p < 90) h.changeStage(req, l, 'reserved');
    for (const other of db.all("SELECT id FROM offers WHERE lead_id = ? AND id != ? AND status IN ('draft','pending','approved','sent')", o.lead_id, o.id)) db.run("UPDATE offers SET status = 'expired' WHERE id = ?", other.id);
  }));
  router.post('/offers/:id/rejected', R('agent'), transition(['sent'], 'rejected', 'agent', (req, o) => {
    db.run('UPDATE offers SET decided_at = ? WHERE id = ?', M.now(), o.id);
    const l = leadRow(o);
    if (l.stage === 'proposal') h.changeStage(req, l, 'negotiation');
  }));

  // The proposal, printable and on brand.
  router.get('/offers/:id/print', (req, res, next) => {
    const o = offerOf(req.params.id);
    if (!o) return next();
    const s = db.settings();
    const units = M.offerUnits(db, o.id);
    const sc = M.schedule(terms(o), units);
    const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>Print or save as PDF</span></button><a class="btn btn--ghost" href="/admin/offers/${o.id}">Back</a></div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">Leasing proposal</p><p class="doc__ref">${ui.esc(o.ref)} · ${ui.date(o.created_at)}</p></div></header>
  <section class="doc__to"><p class="eyebrow">Prepared for</p><h1>${ui.esc(o.brand_name || o.lead_title)}</h1>${o.contact_name ? `<p>${ui.esc(o.contact_name)}${o.contact_title ? `, ${ui.esc(o.contact_title)}` : ''}</p>` : ''}</section>
  <p class="doc__intro">Thank you for considering The Wave. Two curved wings around an open court on North 90, New Cairo, with plaza shops that each come with a terrace of their own. We are pleased to propose the following.</p>
  <h2>The space</h2>
  <table class="doc__t"><thead><tr><th>Unit</th><th>Level</th><th class="num">Indoor</th><th class="num">Terrace</th></tr></thead><tbody>${units.map((u) => `<tr><td>${ui.esc(u.code)}</td><td>${ui.esc(M.ZONES[u.zone])}</td><td class="num">${ui.m2(u.indoor_m2)}</td><td class="num">${ui.m2(u.terrace_m2)}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="2">Total</td><td class="num">${ui.m2(sc.indoor)}</td><td class="num">${ui.m2(sc.outdoor)}</td></tr></tfoot></table>
  <h2>Commercial terms</h2>
  <table class="doc__t doc__t--terms"><tbody>
    <tr><th>Base rent</th><td>${ui.money(o.rent_m2)} per m² per month (indoor)</td></tr>
    <tr><th>Terrace</th><td>${ui.money(o.terrace_rent_m2)} per m² per month</td></tr>
    <tr><th>Service charge</th><td>${ui.money(o.service_m2)} per m² per month</td></tr>
    <tr><th>Term</th><td>${o.term_years} years, from ${ui.date(o.start_date)}</td></tr>
    <tr><th>Yearly increase</th><td>${o.escalation_pct}% on the base rent each year</td></tr>
    <tr><th>Fit-out</th><td>${o.fitout_months} months${o.rent_free_months ? `; ${o.rent_free_months} months rent-free` : ''}</td></tr>
    <tr><th>Security deposit</th><td>${o.deposit_months} months of rent: ${ui.money(sc.deposit)}</td></tr>
    ${o.key_money ? `<tr><th>Key money</th><td>${ui.money(o.key_money)}</td></tr>` : ''}
  </tbody></table>
  <h2>Rent schedule</h2>
  ${scheduleTable(sc, { showRate: true }).replace('table table--fin', 'doc__t')}
  ${o.notes ? `<h2>Conditions</h2><p>${ui.esc(o.notes).replace(/\n/g, '<br>')}</p>` : ''}
  <p class="doc__small">Amounts in ${ui.esc(s.currency)}, exclusive of VAT and utilities. This proposal is valid until ${ui.date(o.valid_until)} and is subject to contract and to the landlord's final approval.</p>
  <footer class="doc__sign"><div><span></span><p>For ${ui.esc(s.legal_name)}</p></div><div><span></span><p>For ${ui.esc(o.brand_name || o.lead_title)}</p></div></footer>
  <p class="doc__foot">${ui.esc(s.address)} · ${ui.esc(s.leasing_email)}${s.leasing_phone ? ` · ${ui.esc(s.leasing_phone)}` : ''}</p>
</main>`;
    res.type('html').send(ui.bare({ title: `Proposal ${o.ref}`, body, cls: 'print' }));
  });

  // ---------- leases ----------
  router.get('/leases', (req, res) => {
    const st = M.LEASE_STATUS[req.query.status] ? req.query.status : '';
    const rows = db.all(`SELECT s.*, b.name brand_name FROM leases s JOIN brands b ON b.id = s.brand_id ${st ? 'WHERE s.status = ?' : ''} ORDER BY s.status = 'active' DESC, s.start_date DESC`, ...(st ? [st] : []))
      .map((s) => ({ ...s, units: M.leaseUnits(db, s.id), annual: s.status === 'active' ? M.currentAnnualRent(db, s) : null, next: db.get("SELECT due_date, total FROM invoices WHERE lease_id = ? AND status IN ('open','partial') ORDER BY due_date LIMIT 1", s.id) }));
    const tabs = [['', 'All'], ...Object.entries(M.LEASE_STATUS)].map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/leases${k ? `?status=${k}` : ''}">${l}</a>`).join('');
    const table = ui.table(
      [
        { label: 'Lease', render: (s) => `<b>${ui.esc(s.brand_name)}</b><small class="sub">${ui.esc(s.ref)}</small>` },
        { label: 'Units', render: (s) => ui.esc(s.units.map((u) => u.code).join(', ')) },
        { label: 'Area', num: true, render: (s) => ui.m2(s.units.reduce((a, u) => a + u.indoor_m2, 0)) },
        { label: 'Term', render: (s) => `${ui.date(s.start_date)} – ${ui.date(s.end_date)}` },
        { label: 'Annual rent now', num: true, render: (s) => (s.annual !== null ? ui.money(s.annual, { compact: true }) : '—') },
        { label: 'Next invoice', render: (s) => (s.next ? `<span class="${s.next.due_date < M.today() ? 'late' : ''}">${ui.date(s.next.due_date)}<small class="sub">${ui.money(s.next.total, { compact: true })}</small></span>` : '—') },
        { label: 'Status', render: (s) => ui.badge(s.status, M.LEASE_STATUS[s.status]) },
      ],
      rows,
      { empty: 'No leases yet. Accept an offer, then create a lease from it.', href: (s) => `/admin/leases/${s.id}` },
    );
    h.page(req, res, { title: 'Leases', active: '/admin/leases', wide: true, body: `<nav class="tabs">${tabs}</nav>${ui.card(`${rows.length} leases`, table, { action: ui.btn('Rent roll CSV', { href: '/admin/export/rentroll.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`, actions: h.can(req, 'manager') ? ui.btn('New lease', { href: '/admin/leases/new', cls: 'btn--primary', ic: 'plus' }) : '' });
  });

  router.get('/leases/new', R('manager'), (req, res) => {
    const o = req.query.offer ? offerOf(h.int(req.query.offer)) : null;
    const s = db.settings();
    const chosen = new Set(o ? M.offerUnits(db, o.id).map((u) => u.id) : []);
    const units = db.all("SELECT * FROM units WHERE status != 'leased' ORDER BY sort");
    const brands = db.all('SELECT id, name FROM brands ORDER BY name');
    const start = o ? (o.start_date && o.start_date > M.today() ? o.start_date : M.addMonths(M.today(), o.fitout_months || 0)) : M.addMonths(M.today(), 1);
    const sc = o ? M.schedule(terms(o), [...chosen].map((id) => units.find((u) => u.id === id)).filter(Boolean)) : null;
    const body = ui.card('Lease terms', ui.form('/admin/leases', req.session.csrf, `
      ${o ? `<input type="hidden" name="offer_id" value="${o.id}"><input type="hidden" name="lead_id" value="${o.lead_id}"><p class="alert alert--ok">From offer <a href="/admin/offers/${o.id}">${ui.esc(o.ref)}</a>, accepted by ${ui.esc(o.lead_title)}.</p>` : ''}
      <fieldset><legend>Tenant and units</legend><div class="fields">
        ${ui.select('brand_id', 'Tenant (brand)', brands.map((b) => [b.id, b.name]), o ? o.brand_id : '', { required: true, blank: 'Choose…' })}
        <div class="picks span-all">${units.map((u) => `<label class="pick${chosen.has(u.id) ? ' is-on' : ''}"><input type="checkbox" name="units" value="${u.id}" ${chosen.has(u.id) ? 'checked' : ''}><b>${ui.esc(u.code)}</b><span>${ui.n0(u.indoor_m2)} m²${u.terrace_m2 ? ` + ${ui.n0(u.terrace_m2)}` : ''}</span>${ui.unitBadge(u.status)}</label>`).join('')}</div>
      </div></fieldset>
      <fieldset><legend>Rent</legend><div class="fields">
        ${ui.input('rent_m2', 'Rent per m² / month', o ? o.rent_m2 : '', { type: 'number', step: '0.01', min: 0, required: true })}
        ${ui.input('terrace_rent_m2', 'Terrace per m² / month', o ? o.terrace_rent_m2 : '', { type: 'number', step: '0.01', min: 0 })}
        ${ui.input('service_m2', 'Service charge per m² / month', o ? o.service_m2 : s.service_m2, { type: 'number', step: '0.01', min: 0 })}
        ${ui.input('escalation_pct', 'Yearly increase (%)', o ? o.escalation_pct : s.default_escalation, { type: 'number', step: '0.5', min: 0 })}
      </div></fieldset>
      <fieldset><legend>Term and payment</legend><div class="fields">
        ${ui.input('start_date', 'Start date', start, { type: 'date', required: true })}
        ${ui.input('term_years', 'Term (years)', o ? o.term_years : s.default_term_years, { type: 'number', min: 1, max: 30, required: true })}
        ${ui.input('rent_free_months', 'Rent-free months', o ? o.rent_free_months : 0, { type: 'number', min: 0 })}
        ${ui.select('payment_freq', 'Invoiced', { monthly: 'Monthly in advance', quarterly: 'Quarterly in advance', annual: 'Yearly in advance' }, 'quarterly')}
        ${ui.input('deposit', 'Security deposit', sc ? Math.round(sc.deposit) : '', { type: 'number', min: 0, step: 1 })}
        ${ui.input('key_money', 'Key money', o ? o.key_money : 0, { type: 'number', min: 0, step: 1 })}
        ${ui.input('signed_at', 'Signed on', M.today(), { type: 'date' })}
        ${ui.textarea('notes', 'Notes', '', { rows: 3, cls: 'span-all' })}
      </div></fieldset>
      <div class="row">${ui.btn('Create lease', { cls: 'btn--primary' })}<span class="muted">It starts as a draft. Activate it to let the units and start billing.</span></div>`, { cls: 'stack form' }));
    h.page(req, res, { title: 'New lease', crumbs: [['/admin/leases', 'Leases'], [null, 'New']], active: '/admin/leases', body });
  });

  router.post('/leases', R('manager'), (req, res) => {
    const b = req.body;
    const unitIds = h.list(b.units).map(Number).filter(Boolean);
    const brand = db.get('SELECT * FROM brands WHERE id = ?', h.int(b.brand_id));
    const rent = h.numv(b.rent_m2);
    const start = h.str(b.start_date, 10);
    const years = Math.max(1, Math.min(30, h.int(b.term_years) || 5));
    if (!brand || !unitIds.length || !rent || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return h.back(req, res, `/admin/leases/new${b.offer_id ? `?offer=${h.int(b.offer_id)}` : ''}`, 'error', 'Choose the tenant and units, and set the rent and start date.');
    const id = db.tx(() => {
      const r = db.run(
        `INSERT INTO leases (ref, brand_id, lead_id, offer_id, status, start_date, end_date, term_years, rent_m2, terrace_rent_m2, service_m2, escalation_pct, rent_free_months, payment_freq, deposit, key_money, signed_at, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('leases', 'LS', 3, true), brand.id, h.int(b.lead_id), h.int(b.offer_id), start, M.addDays(M.addMonths(start, years * 12), -1), years, rent,
        h.numv(b.terrace_rent_m2) ?? 0, h.numv(b.service_m2) ?? 0, h.numv(b.escalation_pct) ?? 0, h.int(b.rent_free_months) || 0,
        ['monthly', 'quarterly', 'annual'].includes(b.payment_freq) ? b.payment_freq : 'quarterly', h.numv(b.deposit) ?? 0, h.numv(b.key_money) ?? 0, h.str(b.signed_at, 10) || null, h.str(b.notes, 3000) || null, req.user.id, M.now(),
      );
      const leaseId = Number(r.lastInsertRowid);
      for (const u of unitIds) db.run('INSERT INTO lease_units (lease_id, unit_id) VALUES (?, ?)', leaseId, u);
      return leaseId;
    });
    h.log(req, 'Drafted a lease', 'lease', id, brand.name);
    h.back(req, res, `/admin/leases/${id}`, 'ok', 'Lease drafted. Check it, then activate it.');
  });

  router.get('/leases/:id', (req, res, next) => {
    const s = leaseOf(req.params.id);
    if (!s) return next();
    const units = M.leaseUnits(db, s.id);
    const sc = M.schedule({ ...s, deposit_months: 0 }, units);
    const inv = db.all('SELECT * FROM invoices WHERE lease_id = ? ORDER BY due_date, id', s.id);
    const t = M.today();
    const billed = inv.filter((i) => i.status !== 'void').reduce((a, i) => a + i.total, 0);
    const paid = inv.reduce((a, i) => a + i.paid, 0);
    const overdue = inv.filter((i) => ['open', 'partial'].includes(i.status) && i.due_date < t).reduce((a, i) => a + i.total - i.paid, 0);
    const csrf = req.session.csrf;
    const actions = [];
    if (s.status === 'draft' && h.can(req, 'manager')) actions.push(ui.form(`/admin/leases/${s.id}/activate`, csrf, ui.btn('Activate lease', { cls: 'btn--primary', ic: 'check', attrs: { 'data-confirm': 'Activate? The units become leased and the invoices are created.' } })));
    if (s.status === 'active' && h.can(req, 'manager')) actions.push(`<details class="pop"><summary class="btn btn--ghost">End lease</summary>${ui.form(`/admin/leases/${s.id}/end`, csrf, `${ui.select('how', 'How', { ended: 'Ended (term complete)', terminated: 'Terminated early' }, 'terminated')}${ui.input('date', 'Last day', t, { type: 'date' })}${ui.btn('End lease', { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': 'End this lease? Future invoices are voided and the units become available.' } })}`, { cls: 'stack' })}</details>`);
    if (s.status === 'active' && h.can(req, 'manager')) actions.push(`<details class="pop"><summary class="btn btn--ghost">Add a charge</summary>${ui.form(`/admin/leases/${s.id}/charge`, csrf, `${ui.input('note', 'What for', '', { required: true, placeholder: 'e.g. Signage approval fee' })}${ui.input('amount', 'Amount', '', { type: 'number', min: 1, step: 1, required: true })}${ui.input('due', 'Due', M.addDays(t, 14), { type: 'date' })}${ui.btn('Add charge', { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>`);
    const kpis = [
      ui.kpi({ label: 'Area', value: ui.m2(sc.indoor), sub: units.map((u) => u.code).join(', ') }),
      ui.kpi({ label: 'Annual rent now', value: ui.money(s.status === 'active' ? M.currentAnnualRent(db, s) : sc.annual, { compact: true }), sub: `${ui.money(s.rent_m2)} / m² at start, +${s.escalation_pct}%` }),
      ui.kpi({ label: 'Contract value', value: ui.money(sc.total, { compact: true }), sub: `${s.term_years} years` }),
      ui.kpi({ label: 'Collected', value: ui.money(paid, { compact: true }), bar: billed ? paid / billed : 0, sub: `of ${ui.money(billed, { compact: true })} billed` }),
      ui.kpi({ label: 'Overdue', value: ui.money(overdue, { compact: true }), tone: overdue ? 'kpi--alert' : '' }),
    ].join('');
    const invTable = ui.table(
      [
        { label: 'Invoice', render: (i) => `<b>${ui.esc(i.ref)}</b><small class="sub">${i.kind === 'rent' ? `${ui.date(i.period_start)} – ${ui.date(i.period_end)}` : ui.esc(i.note || 'Charge')}</small>` },
        { label: 'Due', render: (i) => `<span class="${['open', 'partial'].includes(i.status) && i.due_date < t ? 'late' : ''}">${ui.date(i.due_date)}</span>` },
        { label: 'Rent', num: true, render: (i) => ui.money(i.rent, { cur: false }) },
        { label: 'Service', num: true, render: (i) => ui.money(i.service, { cur: false }) },
        { label: 'Total', num: true, render: (i) => `<b>${ui.money(i.total, { cur: false })}</b>` },
        { label: 'Paid', num: true, render: (i) => ui.money(i.paid, { cur: false }) },
        { label: 'Status', render: (i) => (['open', 'partial'].includes(i.status) && i.due_date < t ? ui.badge('overdue', 'Overdue') : ui.badge(i.status, M.INVOICE_STATUS[i.status])) },
      ],
      inv,
      { empty: s.status === 'draft' ? 'Invoices are created when the lease is activated.' : 'No invoices.', href: (i) => `/admin/invoices/${i.id}` },
    );
    const facts = `<dl class="dl">
      <div><dt>Tenant</dt><dd><a href="/admin/brands/${s.brand_id}">${ui.esc(s.brand_name)}</a> · ${ui.esc(M.CATEGORIES[s.category])}</dd></div>
      <div><dt>Status</dt><dd>${ui.badge(s.status, M.LEASE_STATUS[s.status])}</dd></div>
      <div><dt>Term</dt><dd>${ui.date(s.start_date)} – ${ui.date(s.end_date)} (${s.term_years} years)</dd></div>
      <div><dt>Rent</dt><dd>${ui.money(s.rent_m2)} / m² · terrace ${ui.money(s.terrace_rent_m2, { cur: false })} · service ${ui.money(s.service_m2, { cur: false })}</dd></div>
      <div><dt>Increase</dt><dd>${s.escalation_pct}% a year</dd></div>
      <div><dt>Rent-free</dt><dd>${s.rent_free_months} months</dd></div>
      <div><dt>Invoiced</dt><dd>${{ monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Yearly' }[s.payment_freq]} in advance</dd></div>
      <div><dt>Deposit</dt><dd>${ui.money(s.deposit)}</dd></div>
      ${s.key_money ? `<div><dt>Key money</dt><dd>${ui.money(s.key_money)}</dd></div>` : ''}
      <div><dt>Signed</dt><dd>${ui.date(s.signed_at)}</dd></div>
      ${s.offer_id ? `<div><dt>From offer</dt><dd><a href="/admin/offers/${s.offer_id}">View offer</a></dd></div>` : ''}
      ${s.lead_id ? `<div><dt>Lead</dt><dd><a href="/admin/leads/${s.lead_id}">${ui.esc(s.lead_title || 'View lead')}</a></dd></div>` : ''}
    </dl>${s.notes ? `<blockquote class="quote quote--sm">${ui.esc(s.notes)}</blockquote>` : ''}`;
    const body = `<div class="kpis kpis--5">${kpis}</div>
<div class="grid grid--side"><div class="stack">${ui.card('Invoices', invTable, { sub: `${inv.length} invoices` })}${ui.card('Rent schedule', scheduleTable(sc))}</div><div class="stack">${ui.card('Lease', facts)}${ui.card('Units', `${units.map((u) => `<p><a href="/admin/units/${u.id}"><b>${ui.esc(u.code)}</b></a> · ${ui.m2(u.indoor_m2)}${u.terrace_m2 ? ` + ${ui.m2(u.terrace_m2)} terrace` : ''} ${ui.unitBadge(u.status)}</p>`).join('')}`)}</div></div>`;
    h.page(req, res, { title: `${s.brand_name}`, crumbs: [['/admin/leases', 'Leases'], [null, s.ref]], active: '/admin/leases', body, actions: `<div class="row">${actions.join('')}</div>` });
  });

  router.post('/leases/:id/activate', R('manager'), (req, res, next) => {
    const s = leaseOf(req.params.id);
    if (!s) return next();
    if (s.status !== 'draft') return h.back(req, res, `/admin/leases/${s.id}`, 'error', 'Only a draft lease can be activated.');
    const units = M.leaseUnits(db, s.id);
    const clash = units.filter((u) => u.status === 'leased');
    if (clash.length) return h.back(req, res, `/admin/leases/${s.id}`, 'error', `${clash.map((u) => u.code).join(', ')} already leased.`);
    db.tx(() => {
      db.run("UPDATE leases SET status = 'active', signed_at = COALESCE(signed_at, ?) WHERE id = ?", M.today(), s.id);
      for (const u of units) db.run("UPDATE units SET status = 'leased', hold_until = NULL, hold_lead_id = NULL, updated_at = ? WHERE id = ?", M.now(), u.id);
      for (const p of M.invoicePlan(s, units)) {
        db.run('INSERT INTO invoices (ref, lease_id, kind, period_start, period_end, due_date, rent, service, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', db.nextRef('invoices', 'IN', 4, true), s.id, 'rent', p.period_start, p.period_end, p.due_date, p.rent, p.service, p.rent + p.service, M.now());
      }
      if (s.deposit) db.run("INSERT INTO invoices (ref, lease_id, kind, due_date, other, total, note, created_at) VALUES (?, ?, 'deposit', ?, ?, ?, 'Security deposit', ?)", db.nextRef('invoices', 'IN', 4, true), s.id, s.signed_at || M.today(), s.deposit, s.deposit, M.now());
      if (s.key_money) db.run("INSERT INTO invoices (ref, lease_id, kind, due_date, other, total, note, created_at) VALUES (?, ?, 'key', ?, ?, ?, 'Key money', ?)", db.nextRef('invoices', 'IN', 4, true), s.id, s.signed_at || M.today(), s.key_money, s.key_money, M.now());
      if (s.lead_id) {
        const l = db.get('SELECT * FROM leads WHERE id = ?', s.lead_id);
        if (l && l.stage !== 'won') h.changeStage(req, l, 'won');
        if (l) db.run('UPDATE leads SET value_est = ? WHERE id = ?', Math.round(M.monthly(units, { rent: s.rent_m2, terrace: s.terrace_rent_m2 }).rent * 12), l.id);
      }
    });
    h.log(req, 'Activated a lease', 'lease', s.id, `${s.ref} · ${s.brand_name}`);
    h.back(req, res, `/admin/leases/${s.id}`, 'ok', `Lease active. ${units.map((u) => u.code).join(', ')} leased and invoices created.`);
  });

  router.post('/leases/:id/end', R('manager'), (req, res, next) => {
    const s = leaseOf(req.params.id);
    if (!s) return next();
    const how = req.body.how === 'ended' ? 'ended' : 'terminated';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : M.today();
    db.tx(() => {
      db.run('UPDATE leases SET status = ?, end_date = ? WHERE id = ?', how, date, s.id);
      db.run("UPDATE invoices SET status = 'void', note = COALESCE(note, '') || ' (lease ended)' WHERE lease_id = ? AND status = 'open' AND due_date > ?", s.id, date);
      for (const u of M.leaseUnits(db, s.id)) db.run("UPDATE units SET status = 'available', updated_at = ? WHERE id = ?", M.now(), u.id);
    });
    h.log(req, `Lease ${how}`, 'lease', s.id, `${s.ref} · ${s.brand_name}`);
    h.back(req, res, `/admin/leases/${s.id}`, 'ok', 'Lease ended. Its units are available again.');
  });

  router.post('/leases/:id/charge', R('manager'), (req, res, next) => {
    const s = leaseOf(req.params.id);
    if (!s) return next();
    const amount = h.numv(req.body.amount);
    if (!amount || amount <= 0) return h.back(req, res, `/admin/leases/${s.id}`, 'error', 'Enter an amount.');
    db.run("INSERT INTO invoices (ref, lease_id, kind, due_date, other, total, note, created_at) VALUES (?, ?, 'other', ?, ?, ?, ?, ?)", db.nextRef('invoices', 'IN', 4, true), s.id, h.str(req.body.due, 10) || M.today(), amount, amount, h.str(req.body.note, 200), M.now());
    h.log(req, 'Added a charge', 'lease', s.id, `${s.ref} · ${amount}`);
    h.back(req, res, `/admin/leases/${s.id}`, 'ok', 'Charge added.');
  });

  // ---------- billing ----------
  router.get('/billing', (req, res) => {
    const t = M.today();
    const st = ['open', 'overdue', 'paid', 'all', 'upcoming'].includes(req.query.status) ? req.query.status : 'open';
    const where = { open: "i.status IN ('open','partial') AND i.due_date <= ?", overdue: "i.status IN ('open','partial') AND i.due_date < ?", paid: "i.status = 'paid' AND ? IS NOT NULL", all: "i.status != 'void' AND ? IS NOT NULL", upcoming: "i.status IN ('open','partial') AND i.due_date > ?" }[st];
    const rows = db.all(`SELECT i.*, s.ref lease_ref, b.name brand_name FROM invoices i JOIN leases s ON s.id = i.lease_id JOIN brands b ON b.id = s.brand_id WHERE ${where} ORDER BY ${st === 'paid' ? 'i.paid_at DESC' : 'i.due_date'} LIMIT 400`, st === 'open' ? M.addDays(t, 30) : t);
    const R2 = M.reports(db);
    const outstanding = db.value("SELECT COALESCE(SUM(total - paid), 0) FROM invoices WHERE status IN ('open','partial') AND due_date <= ?", t);
    const overdue = db.value("SELECT COALESCE(SUM(total - paid), 0) FROM invoices WHERE status IN ('open','partial') AND due_date < ?", t);
    const next30 = db.value("SELECT COALESCE(SUM(total - paid), 0) FROM invoices WHERE status IN ('open','partial') AND due_date > ? AND due_date <= ?", t, M.addDays(t, 30));
    const collected = db.value('SELECT COALESCE(SUM(paid), 0) FROM invoices WHERE paid_at IS NOT NULL AND substr(paid_at, 1, 7) = ?', t.slice(0, 7));
    const billedMonth = db.value("SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status != 'void' AND substr(due_date, 1, 7) = ?", t.slice(0, 7));
    const kpis = [
      ui.kpi({ label: 'Due now', value: ui.money(outstanding, { compact: true }), sub: 'Open invoices due today or earlier' }),
      ui.kpi({ label: 'Overdue', value: ui.money(overdue, { compact: true }), tone: overdue ? 'kpi--alert' : '', href: '/admin/billing?status=overdue' }),
      ui.kpi({ label: 'Due in 30 days', value: ui.money(next30, { compact: true }), href: '/admin/billing?status=upcoming' }),
      ui.kpi({ label: 'Collected this month', value: ui.money(collected, { compact: true }), bar: billedMonth ? Math.min(1, collected / billedMonth) : 0, sub: `of ${ui.money(billedMonth, { compact: true })} billed this month` }),
    ].join('');
    const tabs = [['open', 'Due within 30 days'], ['overdue', 'Overdue'], ['upcoming', 'Upcoming'], ['paid', 'Paid'], ['all', 'All']].map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/billing?status=${k}">${l}</a>`).join('');
    const table = ui.table(
      [
        { label: 'Invoice', render: (i) => `<b>${ui.esc(i.ref)}</b><small class="sub">${ui.esc(i.brand_name)} · ${ui.esc(i.lease_ref)}</small>` },
        { label: 'For', render: (i) => (i.kind === 'rent' ? `${ui.date(i.period_start)} – ${ui.date(i.period_end)}` : ui.esc(i.note || i.kind)) },
        { label: 'Due', render: (i) => `<span class="${['open', 'partial'].includes(i.status) && i.due_date < t ? 'late' : ''}">${ui.date(i.due_date)}<small class="sub">${ui.rel(i.due_date)}</small></span>` },
        { label: 'Total', num: true, render: (i) => ui.money(i.total, { cur: false }) },
        { label: 'Outstanding', num: true, render: (i) => `<b>${ui.money(i.total - i.paid, { cur: false })}</b>` },
        { label: 'Status', render: (i) => (['open', 'partial'].includes(i.status) && i.due_date < t ? ui.badge('overdue', 'Overdue') : ui.badge(i.status, M.INVOICE_STATUS[i.status])) },
      ],
      rows,
      { empty: st === 'overdue' ? 'Nothing overdue.' : 'No invoices here.', href: (i) => `/admin/invoices/${i.id}` },
    );
    const owed = db.all("SELECT b.id, b.name, s.id lease_id, s.ref, SUM(i.total - i.paid) amount, MIN(i.due_date) oldest, COUNT(*) n FROM invoices i JOIN leases s ON s.id = i.lease_id JOIN brands b ON b.id = s.brand_id WHERE i.status IN ('open','partial') AND i.due_date < ? GROUP BY s.id ORDER BY amount DESC LIMIT 6", t);
    const owedList = owed.length
      ? `<ul class="list">${owed.map((o) => `<li><a href="/admin/leases/${o.lease_id}"><span class="dot dot--rose"></span><span class="what"><b>${ui.esc(o.name)}</b><small>${ui.esc(o.ref)} · ${o.n} invoice${o.n === 1 ? '' : 's'} · oldest ${ui.rel(o.oldest)}</small></span><b>${ui.money(o.amount, { compact: true })}</b></a></li>`).join('')}</ul>`
      : '<p class="muted pad">No one is behind. Every invoice due so far is paid.</p>';
    const body = `<div class="kpis kpis--4">${kpis}</div>
<nav class="tabs">${tabs}</nav>${ui.card(`${rows.length} invoices`, table, { action: ui.btn('Export CSV', { href: '/admin/export/invoices.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}
<div class="grid grid--2">
  ${ui.card('Receivables aging', ui.bars(R2.aging, { key: 'amount', label: 'label', fmtv: (n) => ui.money(n, { compact: true, cur: false }), tone: 'cocoa' }), { sub: 'Overdue amounts by days past due' })}
  ${ui.card('Who is behind', owedList, { sub: 'Overdue balance by lease' })}
</div>`;
    h.page(req, res, { title: 'Billing', active: '/admin/billing', wide: true, body });
  });

  const invoiceOf = (id) => db.get('SELECT i.*, s.ref lease_ref, s.id lease_id, s.brand_id, b.name brand_name FROM invoices i JOIN leases s ON s.id = i.lease_id JOIN brands b ON b.id = s.brand_id WHERE i.id = ?', id);

  router.get('/invoices/:id', (req, res, next) => {
    const i = invoiceOf(req.params.id);
    if (!i) return next();
    const t = M.today();
    const open = ['open', 'partial'].includes(i.status);
    const pay = open && h.can(req, 'manager')
      ? ui.card('Record a payment', ui.form(`/admin/invoices/${i.id}/pay`, req.session.csrf, `<div class="fields">${ui.input('amount', 'Amount', i.total - i.paid, { type: 'number', min: 1, step: '0.01', required: true })}${ui.input('date', 'Received on', t, { type: 'date', required: true })}${ui.select('method', 'Method', { transfer: 'Bank transfer', cheque: 'Cheque', card: 'Card', cash: 'Cash' }, 'transfer')}${ui.input('note', 'Reference', '', { placeholder: 'e.g. transfer ref or cheque no.' })}</div>${ui.btn('Record payment', { cls: 'btn--primary' })}`, { cls: 'stack' }))
      : '';
    const voidForm = open && h.can(req, 'manager') ? `<details class="danger"><summary>Void invoice</summary>${ui.form(`/admin/invoices/${i.id}/void`, req.session.csrf, ui.btn('Void', { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': 'Void this invoice?' } }))}</details>` : '';
    const body = `<div class="grid grid--side">
  ${ui.card('Invoice', `<dl class="dl">
    <div><dt>Tenant</dt><dd><a href="/admin/brands/${i.brand_id}">${ui.esc(i.brand_name)}</a></dd></div>
    <div><dt>Lease</dt><dd><a href="/admin/leases/${i.lease_id}">${ui.esc(i.lease_ref)}</a></dd></div>
    <div><dt>For</dt><dd>${i.kind === 'rent' ? `Rent and service, ${ui.date(i.period_start)} – ${ui.date(i.period_end)}` : ui.esc(i.note || i.kind)}</dd></div>
    <div><dt>Due</dt><dd class="${open && i.due_date < t ? 'late' : ''}">${ui.date(i.due_date)} · ${ui.rel(i.due_date)}</dd></div>
    <div><dt>Rent</dt><dd>${ui.money(i.rent)}</dd></div><div><dt>Service</dt><dd>${ui.money(i.service)}</dd></div>${i.other ? `<div><dt>Other</dt><dd>${ui.money(i.other)}</dd></div>` : ''}
    <div><dt>Total</dt><dd><b>${ui.money(i.total)}</b></dd></div>
    <div><dt>Paid</dt><dd>${ui.money(i.paid)}${i.paid_at ? ` · ${ui.date(i.paid_at)}${i.method ? ` by ${ui.esc(i.method)}` : ''}` : ''}</dd></div>
    <div><dt>Status</dt><dd>${open && i.due_date < t ? ui.badge('overdue', 'Overdue') : ui.badge(i.status, M.INVOICE_STATUS[i.status])}</dd></div>
    ${i.note && i.kind === 'rent' ? `<div><dt>Note</dt><dd>${ui.esc(i.note)}</dd></div>` : ''}
  </dl>`)}
  <div class="stack">${pay}${voidForm}</div>
</div>`;
    h.page(req, res, { title: `Invoice ${i.ref}`, crumbs: [['/admin/billing', 'Billing'], [`/admin/leases/${i.lease_id}`, i.brand_name], [null, i.ref]], active: '/admin/billing', body, actions: ui.btn('Print', { href: `/admin/invoices/${i.id}/print`, cls: 'btn--ghost', ic: 'print', attrs: { target: '_blank' } }) });
  });

  router.post('/invoices/:id/pay', R('manager'), (req, res, next) => {
    const i = invoiceOf(req.params.id);
    if (!i) return next();
    const amount = h.numv(req.body.amount);
    if (!amount || amount <= 0) return h.back(req, res, `/admin/invoices/${i.id}`, 'error', 'Enter the amount received.');
    const paid = Math.min(i.total, i.paid + amount);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : M.today();
    db.run('UPDATE invoices SET paid = ?, status = ?, paid_at = ?, method = ?, note = COALESCE(?, note) WHERE id = ?', paid, paid >= i.total - 0.5 ? 'paid' : 'partial', date, h.str(req.body.method, 20), h.str(req.body.note, 200) || null, i.id);
    h.log(req, 'Recorded a payment', 'invoice', i.id, `${i.ref} · ${amount}`);
    h.back(req, res, `/admin/invoices/${i.id}`, 'ok', paid >= i.total - 0.5 ? 'Paid in full.' : 'Part payment recorded.');
  });

  router.post('/invoices/:id/void', R('manager'), (req, res) => {
    db.run("UPDATE invoices SET status = 'void' WHERE id = ? AND status IN ('open','partial')", req.params.id);
    h.log(req, 'Voided an invoice', 'invoice', h.int(req.params.id));
    h.back(req, res, `/admin/invoices/${req.params.id}`, 'ok', 'Invoice voided.');
  });

  router.get('/invoices/:id/print', (req, res, next) => {
    const i = invoiceOf(req.params.id);
    if (!i) return next();
    const s = db.settings();
    const vat = Number(s.vat_pct) || 0;
    const lines = [i.rent ? ['Base rent', i.rent] : null, i.service ? ['Service charge', i.service] : null, i.other ? [i.note || 'Other', i.other] : null].filter(Boolean);
    const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>Print or save as PDF</span></button><a class="btn btn--ghost" href="/admin/invoices/${i.id}">Back</a></div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">Invoice</p><p class="doc__ref">${ui.esc(i.ref)} · issued ${ui.date(i.created_at)}</p></div></header>
  <section class="doc__to"><p class="eyebrow">Billed to</p><h1>${ui.esc(i.brand_name)}</h1><p>Lease ${ui.esc(i.lease_ref)}${i.kind === 'rent' ? ` · period ${ui.date(i.period_start)} – ${ui.date(i.period_end)}` : ''}</p></section>
  <table class="doc__t"><thead><tr><th>Description</th><th class="num">Amount (${ui.esc(s.currency)})</th></tr></thead><tbody>${lines.map(([l, a]) => `<tr><td>${ui.esc(l)}</td><td class="num">${ui.money(a, { cur: false })}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td>Subtotal</td><td class="num">${ui.money(i.total, { cur: false })}</td></tr>${vat ? `<tr><td>VAT ${vat}%</td><td class="num">${ui.money(i.total * vat / 100, { cur: false })}</td></tr>` : ''}<tr><td><b>Total due by ${ui.date(i.due_date)}</b></td><td class="num"><b>${ui.money(i.total * (1 + vat / 100))}</b></td></tr>${i.paid ? `<tr><td>Paid</td><td class="num">${ui.money(i.paid, { cur: false })}</td></tr>` : ''}</tfoot></table>
  <p class="doc__small">Please quote ${ui.esc(i.ref)} with your payment.</p>
  <p class="doc__foot">${ui.esc(s.legal_name)} · ${ui.esc(s.address)} · ${ui.esc(s.leasing_email)}</p>
</main>`;
    res.type('html').send(ui.bare({ title: `Invoice ${i.ref}`, body, cls: 'print' }));
  });
};
