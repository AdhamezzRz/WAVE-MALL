'use strict';

// Deals: offers (with approval and a printable proposal), leases and billing.

const i18n = require('../i18n');

const { t: tr, tn, tx, isAr } = i18n;

module.exports = function deals(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  // payment methods are stored as keys
  const METHODS = () => ({ transfer: tr('Bank transfer'), cheque: tr('Cheque'), card: tr('Card'), cash: tr('Cash') });
  const KINDS = () => ({ rent: tr('Rent'), deposit: tr('Security deposit'), key: tr('Key money'), other: tr('Charge') });
  const FREQ = () => ({ monthly: tr('Monthly in advance'), quarterly: tr('Quarterly in advance'), annual: tr('Yearly in advance') });
  const months = (n) => tn(n, '{n} month', '{n} months');
  const years = (n) => tn(n, '{n} year', '{n} years');
  // the language of a printed document: ?doc=ar|en, else the reader's
  const docLang = (req) => (['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en');
  const docSwitch = (path, l) => (l === 'ar'
    ? `<a class="langbtn" href="${path}?doc=en" lang="en">${ui.icon('globe')}<span>English</span></a>`
    : `<a class="langbtn" href="${path}?doc=ar" lang="ar">${ui.icon('globe')}<span>العربية</span></a>`);

  const offerOf = (id) => db.get(
    `SELECT o.*, l.title lead_title, l.ref lead_ref, l.stage lead_stage, l.brand_id, l.id lead_id, b.name brand_name, c.name contact_name, c.email contact_email, c.title contact_title,
     u.name author, a.name approver FROM offers o JOIN leads l ON l.id = o.lead_id LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN contacts c ON c.id = l.contact_id
     LEFT JOIN users u ON u.id = o.created_by LEFT JOIN users a ON a.id = o.approved_by WHERE o.id = ?`, id);
  const leaseOf = (id) => db.get('SELECT s.*, b.name brand_name, b.category, l.title lead_title FROM leases s JOIN brands b ON b.id = s.brand_id LEFT JOIN leads l ON l.id = s.lead_id WHERE s.id = ?', id);
  const terms = (o) => ({ rent_m2: o.rent_m2, terrace_rent_m2: o.terrace_rent_m2, service_m2: o.service_m2, term_years: o.term_years, escalation_pct: o.escalation_pct, rent_free_months: o.rent_free_months, deposit_months: o.deposit_months, key_money: o.key_money });

  function scheduleTable(sc, { showRate = true } = {}) {
    return `<div class="tablewrap"><table class="table table--fin"><thead><tr><th>${tr('Year')}</th>${showRate ? `<th class="num">${tr('Rate / m²')}</th>` : ''}<th class="num">${tr('Monthly rent')}</th><th class="num">${tr('Rent-free')}</th><th class="num">${tr('Rent')}</th><th class="num">${tr('Service')}</th><th class="num">${tr('Total')}</th></tr></thead><tbody>
      ${sc.years.map((y) => `<tr><td>${tr('Year {n}', { n: y.year })}</td>${showRate ? `<td class="num">${ui.money(y.rate, { cur: false })}</td>` : ''}<td class="num">${ui.money(y.monthRent, { cur: false })}</td><td class="num">${y.free ? tn(y.free, '{n} mo', '{n} mo') : '—'}</td><td class="num">${ui.money(y.rent, { cur: false })}</td><td class="num">${ui.money(y.service, { cur: false })}</td><td class="num"><b>${ui.money(y.total, { cur: false })}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="${showRate ? 4 : 3}">${Math.round(sc.total - sc.totalRent - sc.totalService) ? tr('Contract total (incl. key money)') : tr('Contract total')}</td><td class="num">${ui.money(sc.totalRent, { cur: false })}</td><td class="num">${ui.money(sc.totalService, { cur: false })}</td><td class="num"><b>${ui.money(sc.total, { cur: false })}</b></td></tr></tfoot></table></div>`;
  }

  // ---------- offers ----------
  router.get('/offers', (req, res) => {
    const st = M.OFFER_STATUS[req.query.status] ? req.query.status : '';
    const rows = db.all(`SELECT o.*, l.title lead_title FROM offers o JOIN leads l ON l.id = o.lead_id ${st ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC LIMIT 400`, ...(st ? [st] : []))
      .map((o) => ({ ...o, units: M.offerUnits(db, o.id) }))
      .map((o) => ({ ...o, sc: M.schedule(terms(o), o.units) }));
    const tabs = [['', tr('All')], ...Object.entries(M.OFFER_STATUS)].map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/offers${k ? `?status=${k}` : ''}">${l}${k === 'pending' && db.value("SELECT COUNT(*) FROM offers WHERE status = 'pending'") ? ` <b class="nav__count">${db.value("SELECT COUNT(*) FROM offers WHERE status = 'pending'")}</b>` : ''}</a>`).join('');
    const table = ui.table(
      [
        { label: tr('Offer'), render: (o) => `<b>${ui.esc(o.ref)}</b><small class="sub">${ui.esc(o.lead_title)}</small>` },
        { label: tr('Units'), render: (o) => ui.esc(o.units.map((u) => u.code).join(', ')) },
        { label: tr('Area'), num: true, render: (o) => ui.m2(o.sc.indoor) },
        { label: tr('Rate / m²'), num: true, render: (o) => ui.money(o.rent_m2, { cur: false }) },
        { label: tr('Term'), render: (o) => tr('{n} yrs · {pct}%', { n: o.term_years, pct: o.escalation_pct }) },
        { label: tr('Year 1 rent'), num: true, render: (o) => ui.money(o.sc.years[0] ? o.sc.years[0].rent : 0, { compact: true }) },
        { label: tr('Contract value'), num: true, render: (o) => ui.money(o.sc.total, { compact: true }) },
        { label: tr('Status'), render: (o) => ui.badge(o.status, M.OFFER_STATUS[o.status]) },
        { label: tr('Valid until'), render: (o) => (o.valid_until ? `<span class="${o.valid_until < M.today() ? 'late' : ''}">${ui.date(o.valid_until)}</span>` : '—') },
      ],
      rows,
      { empty: tr('No offers yet. Open a lead and choose New offer.'), href: (o) => `/admin/offers/${o.id}` },
    );
    h.page(req, res, { title: tr('Offers'), active: '/admin/offers', wide: true, body: `<nav class="tabs">${tabs}</nav>${ui.card(tn(rows.length, '{n} offer', '{n} offers'), table)}` });
  });

  function offerForm(req, lead, o = {}) {
    const s = db.settings();
    const chosen = new Set((o.unit_ids || []).map(Number));
    if (!chosen.size && lead.unit_id) chosen.add(lead.unit_id);
    const units = db.all("SELECT * FROM units WHERE status IN ('available','hold') OR id IN (SELECT unit_id FROM offer_units WHERE offer_id = ?) ORDER BY sort", o.id || 0);
    const unitRows = units.map((u) => {
      const r = M.listRates(db, u);
      return `<label class="pick${chosen.has(u.id) ? ' is-on' : ''}"><input type="checkbox" name="units" value="${u.id}" ${chosen.has(u.id) ? 'checked' : ''} data-indoor="${u.indoor_m2}" data-terrace="${u.terrace_m2}" data-list="${r.rent ?? ''}">
        <b>${ui.esc(u.code)}</b><span>${u.terrace_m2 ? tr('deal|{a} + {b} terrace', { a: ui.m2(u.indoor_m2), b: ui.m2(u.terrace_m2) }) : ui.m2(u.indoor_m2)}</span><em>${r.rent ? tr('list {x}', { x: ui.money(r.rent, { cur: false }) }) : tr('no list rate')}</em>${u.status === 'hold' ? ui.unitBadge('hold') : ''}</label>`;
    }).join('');
    const firstList = units.filter((u) => chosen.has(u.id)).map((u) => M.listRates(db, u)).find((r) => r.rent) || M.listRates(db, units[0] || { zone: 'plaza' });
    const v = (k, d) => (o[k] !== undefined && o[k] !== null ? o[k] : d);
    return ui.form(o.id ? `/admin/offers/${o.id}` : '/admin/offers', req.session.csrf, `<input type="hidden" name="lead_id" value="${lead.id}">
      <div class="grid grid--side grid--offer" data-offer data-max-discount="${ui.esc(s.max_discount_pct)}" data-cur="${ui.esc(ui.curLabel())}">
        <div class="stack">
          <fieldset><legend>${tr('Units')}</legend><div class="picks">${unitRows || `<p class="muted">${tr('No available units.')}</p>`}</div></fieldset>
          <fieldset><legend>${tr('Rent')}</legend><div class="fields">
            ${ui.input('rent_m2', tr('Rent per m² / month'), v('rent_m2', firstList.rent ?? ''), { type: 'number', min: 0, step: '0.01', required: true, attrs: { 'data-calc': 'rent' } })}
            ${ui.input('terrace_rent_m2', tr('Terrace per m² / month'), v('terrace_rent_m2', firstList.terrace ?? ''), { type: 'number', min: 0, step: '0.01', attrs: { 'data-calc': 'terrace' } })}
            ${ui.input('service_m2', tr('Service charge per m² / month'), v('service_m2', firstList.service || ''), { type: 'number', min: 0, step: '0.01', attrs: { 'data-calc': 'service' } })}
            ${ui.input('key_money', tr('Key money (one-off)'), v('key_money', 0), { type: 'number', min: 0, step: 1, attrs: { 'data-calc': 'key' } })}
          </div></fieldset>
          <fieldset><legend>${tr('Terms')}</legend><div class="fields">
            ${ui.input('term_years', tr('Term (years)'), v('term_years', s.default_term_years), { type: 'number', min: 1, max: 30, step: 1, required: true, attrs: { 'data-calc': 'term' } })}
            ${ui.input('escalation_pct', tr('Yearly increase (%)'), v('escalation_pct', s.default_escalation), { type: 'number', min: 0, max: 50, step: '0.5', attrs: { 'data-calc': 'esc' } })}
            ${ui.input('rent_free_months', tr('Rent-free months'), v('rent_free_months', 0), { type: 'number', min: 0, max: 36, step: 1, attrs: { 'data-calc': 'free' } })}
            ${ui.input('fitout_months', tr('Fit-out period (months)'), v('fitout_months', 2), { type: 'number', min: 0, max: 24, step: 1 })}
            ${ui.input('deposit_months', tr('Deposit (months of rent)'), v('deposit_months', s.default_deposit_months), { type: 'number', min: 0, max: 24, step: 1, attrs: { 'data-calc': 'deposit' } })}
            ${ui.input('start_date', tr('Expected start'), v('start_date', M.addMonths(M.today(), 2)), { type: 'date' })}
            ${ui.input('valid_until', tr('Valid until'), v('valid_until', M.addDays(M.today(), Number(s.offer_valid_days) || 21)), { type: 'date' })}
            ${ui.textarea('notes', tr('Conditions and notes'), v('notes', ''), { rows: 3, cls: 'span-all', placeholder: tr('e.g. Signage per the design guidelines; trading hours 10:00–24:00') })}
          </div></fieldset>
        </div>
        <aside class="calc card" data-calc-out>
          <header class="card__head"><div><h2>${tr('The deal')}</h2><p>${tr('Updates as you type')}</p></div></header>
          <div class="card__body">
            <dl class="calc__dl">
              <div><dt>${tr('Area')}</dt><dd data-o="area">—</dd></div>
              <div><dt>${tr('Monthly rent, year 1')}</dt><dd data-o="month">—</dd></div>
              <div><dt>${tr('Annual rent, year 1')}</dt><dd data-o="annual">—</dd></div>
              <div><dt>${tr('Service charge / year')}</dt><dd data-o="service">—</dd></div>
              <div><dt>${tr('Deposit')}</dt><dd data-o="deposit">—</dd></div>
              <div class="calc__big"><dt>${tr('Contract value')}</dt><dd data-o="total">—</dd></div>
              <div><dt>${tr('Effective rate / m²')}</dt><dd data-o="eff">—</dd></div>
              <div><dt>${tr('Against list')}</dt><dd data-o="disc">—</dd></div>
            </dl>
            <p class="alert alert--warn" data-o="approval" hidden>${h.can(req, 'manager') ? tr('Below the allowed discount. As a manager, your offer needs no further approval.') : tr('Below the allowed discount: a sales manager will need to approve this offer.')}</p>
            <div class="calc__years" data-o="years"></div>
            ${ui.btn(o.id ? tr('Save offer') : tr('Create offer'), { cls: 'btn--primary btn--block' })}
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
    if (!lead) return h.back(req, res, '/admin/leads', 'error', tr('Open a lead first, then make an offer from it.'));
    const from = req.query.from ? db.get('SELECT * FROM offers WHERE id = ?', h.int(req.query.from)) : null;
    const pre = from ? { ...from, id: undefined, unit_ids: M.offerUnits(db, from.id).map((u) => u.id) } : {};
    void next;
    h.page(req, res, { title: tr('Offer for {name}', { name: lead.title }), crumbs: [['/admin/leads', tr('Leads')], [`/admin/leads/${lead.id}`, lead.ref], [null, tr('New offer')]], active: '/admin/offers', wide: true, body: offerForm(req, lead, pre) });
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
    if (!lead) return h.back(req, res, '/admin/leads', 'error', tr('That lead no longer exists.'));
    if (!o.unit_ids.length || !o.rent_m2) return h.back(req, res, `/admin/offers/new?lead=${lead.id}`, 'error', tr('Pick at least one unit and set the rent.'));
    const { offerId, approval } = saveOffer(req, o);
    if (M.stage(lead.stage).p < 50) h.changeStage(req, lead, 'proposal');
    if (approval) {
      for (const m of db.all("SELECT id FROM users WHERE active = 1 AND role IN ('manager','admin')")) {
        db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, due_at, created_at) VALUES (?, ?, ?, 'task', ?, ?, ?)", lead.id, lead.brand_id, m.id, `Approve offer for ${lead.title}`, M.today(), M.now());
      }
    }
    h.log(req, approval ? 'Sent an offer for approval' : 'Created an offer', 'offer', offerId, lead.title);
    h.back(req, res, `/admin/offers/${offerId}`, 'ok', approval ? tr('Offer created. It is below the allowed discount, so a manager will approve it.') : tr('Offer created.'));
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
    if (o.status === 'pending' && h.can(req, 'manager')) actions.push(act('approve', tr('Approve'), 'btn--primary'), act('reject', tr('Send back'), 'btn--ghost'));
    if (['draft', 'approved'].includes(o.status) && h.can(req, 'agent')) actions.push(act('sent', tr('Mark as sent'), 'btn--primary'));
    if (o.status === 'sent' && h.can(req, 'agent')) actions.push(act('accepted', tr('btn|Accepted'), 'btn--primary', tr('Mark accepted? The units will be reserved for this brand.')), act('rejected', tr('btn|Declined'), 'btn--ghost'));
    if (o.status === 'accepted' && h.can(req, 'manager') && !db.value('SELECT COUNT(*) FROM leases WHERE offer_id = ?', o.id)) actions.push(ui.btn(tr('Create lease'), { href: `/admin/leases/new?offer=${o.id}`, cls: 'btn--primary', ic: 'lease' }));
    if (['draft', 'pending'].includes(o.status) && h.can(req, 'agent')) actions.push(ui.btn(tr('Edit'), { href: `/admin/offers/${o.id}/edit`, cls: 'btn--ghost' }));
    if (h.can(req, 'agent')) actions.push(ui.btn(tr('Revise'), { href: `/admin/offers/new?lead=${o.lead_id}&from=${o.id}`, cls: 'btn--ghost' }));
    actions.push(ui.btn(tr('Proposal'), { href: `/admin/offers/${o.id}/print`, cls: 'btn--ghost', ic: 'print', attrs: { target: '_blank' } }));

    const banner = o.status === 'pending'
      ? `<p class="alert alert--warn">${tr('This offer is below the list rate by more than {pct}%.', { pct: ui.esc(db.setting('max_discount_pct')) })} ${h.can(req, 'manager') ? tr('Approve it to let the team send it.') : tr('A sales manager needs to approve it before it is sent.')}</p>`
      : o.approved_by ? `<p class="alert alert--ok">${tr('Approved by {name} on {date}.', { name: ui.esc(o.approver), date: ui.date(o.approved_at) })}</p>` : '';
    const rateSub = listAvg
      ? tr('{rate} / m² · list {list} ({diff})', { rate: ui.money(o.rent_m2), list: ui.money(listAvg, { cur: false }), diff: `${o.rent_m2 >= listAvg ? '+' : ''}${(((o.rent_m2 - listAvg) / listAvg) * 100).toFixed(1)}%` })
      : tr('{rate} / m²', { rate: ui.money(o.rent_m2) });
    const kpis = [
      ui.kpi({ label: tr('Area'), value: ui.m2(sc.indoor), sub: sc.outdoor ? tr('+ {area} terrace', { area: ui.m2(sc.outdoor) }) : tr('No terrace') }),
      ui.kpi({ label: tr('Monthly rent, year 1'), value: ui.money(sc.firstMonth, { compact: true }), sub: rateSub }),
      ui.kpi({ label: tr('Contract value'), value: ui.money(sc.total, { compact: true }), sub: tr('{years} · +{pct}% a year', { years: years(o.term_years), pct: o.escalation_pct }) }),
      ui.kpi({ label: tr('Deposit'), value: ui.money(sc.deposit, { compact: true }), sub: tr('{months} of rent', { months: months(o.deposit_months) }) }),
      ui.kpi({ label: tr('Effective rate'), value: ui.money(sc.effective, { cur: false }), sub: tn(o.rent_free_months, 'per m² / month after {n} rent-free month', 'per m² / month after {n} rent-free months') }),
    ].join('');
    const unitsTable = ui.table(
      [
        { label: tr('Unit'), render: (u) => `<a href="/admin/units/${u.id}"><b>${ui.esc(u.code)}</b></a>` },
        { label: tr('Level'), render: (u) => ui.esc(M.ZONES[u.zone]) },
        { label: tr('Indoor'), num: true, render: (u) => ui.m2(u.indoor_m2) },
        { label: tr('Terrace'), num: true, render: (u) => ui.m2(u.terrace_m2) },
        { label: tr('Monthly rent'), num: true, render: (u) => ui.money(u.indoor_m2 * o.rent_m2 + u.terrace_m2 * o.terrace_rent_m2) },
        { label: tr('Status'), render: (u) => ui.unitBadge(u.status) },
      ],
      units,
    );
    const facts = `<dl class="dl">
      <div><dt>${tr('For')}</dt><dd><a href="/admin/leads/${o.lead_id}">${ui.esc(o.lead_title)}</a> · ${ui.esc(o.lead_ref)}</dd></div>
      <div><dt>${tr('Status')}</dt><dd>${ui.badge(o.status, M.OFFER_STATUS[o.status])}</dd></div>
      <div><dt>${tr('Rent')}</dt><dd>${tr('{rate} / m² · terrace {terrace} · service {service}', { rate: ui.money(o.rent_m2), terrace: ui.money(o.terrace_rent_m2, { cur: false }), service: ui.money(o.service_m2, { cur: false }) })}</dd></div>
      <div><dt>${tr('Term')}</dt><dd>${tr('{years}, +{pct}% yearly', { years: years(o.term_years), pct: o.escalation_pct })}</dd></div>
      <div><dt>${tr('Incentives')}</dt><dd>${tr('{free} rent-free · {fit} fit-out', { free: months(o.rent_free_months), fit: months(o.fitout_months) })}</dd></div>
      <div><dt>${tr('Key money')}</dt><dd>${ui.money(o.key_money)}</dd></div>
      <div><dt>${tr('Start')}</dt><dd>${ui.date(o.start_date)}</dd></div>
      <div><dt>${tr('Valid until')}</dt><dd>${ui.date(o.valid_until)}${o.valid_until ? ` · ${ui.rel(o.valid_until)}` : ''}</dd></div>
      <div><dt>${tr('Prepared by')}</dt><dd>${ui.esc(o.author || '—')} · ${ui.date(o.created_at)}</dd></div>
      ${o.sent_at ? `<div><dt>${tr('sentdate|Sent')}</dt><dd>${ui.date(o.sent_at)}</dd></div>` : ''}
    </dl>${o.notes ? `<blockquote class="quote quote--sm">${ui.esc(tx(o.notes)).replace(/\n/g, '<br>')}</blockquote>` : ''}`;
    const body = `${banner}<div class="kpis kpis--5">${kpis}</div>
<div class="grid grid--side">
  <div class="stack">${ui.card(tr('Rent schedule'), scheduleTable(sc), { sub: ui.esc(tr('{cur}, before VAT', { cur: ui.curLabel() })) })}${ui.card(tr('Units'), unitsTable)}</div>
  <div class="stack">${ui.card(tr('Terms'), facts)}</div>
</div>`;
    h.page(req, res, { title: tr('Offer {ref}', { ref: o.ref }), crumbs: [['/admin/offers', tr('Offers')], [`/admin/leads/${o.lead_id}`, o.lead_title], [null, o.ref]], active: '/admin/offers', body, actions: `<div class="row">${actions.join('')}</div>` });
  });

  router.get('/offers/:id/edit', R('agent'), (req, res, next) => {
    const o = db.get('SELECT * FROM offers WHERE id = ?', req.params.id);
    if (!o) return next();
    if (!['draft', 'pending'].includes(o.status)) return h.back(req, res, `/admin/offers/${o.id}`, 'error', tr('Only draft offers can be edited. Use Revise to make a new version.'));
    const lead = db.get('SELECT * FROM leads WHERE id = ?', o.lead_id);
    h.page(req, res, { title: tr('Edit {ref}', { ref: o.ref }), crumbs: [['/admin/offers', tr('Offers')], [`/admin/offers/${o.id}`, o.ref], [null, tr('Edit')]], active: '/admin/offers', wide: true, body: offerForm(req, lead, { ...o, unit_ids: M.offerUnits(db, o.id).map((u) => u.id) }) });
  });

  router.post('/offers/:id', R('agent'), (req, res, next) => {
    const old = db.get('SELECT * FROM offers WHERE id = ?', req.params.id);
    if (!old) return next();
    if (!['draft', 'pending'].includes(old.status)) return h.back(req, res, `/admin/offers/${old.id}`, 'error', tr('Only draft offers can be edited.'));
    const o = { ...readOffer(req), lead_id: old.lead_id };
    if (!o.unit_ids.length || !o.rent_m2) return h.back(req, res, `/admin/offers/${old.id}/edit`, 'error', tr('Pick at least one unit and set the rent.'));
    const { approval } = saveOffer(req, o, old.id);
    h.log(req, 'Edited an offer', 'offer', old.id, old.ref);
    h.back(req, res, `/admin/offers/${old.id}`, 'ok', approval ? tr('Saved. It needs a manager’s approval.') : tr('Saved.'));
  });

  // what each move is called in the activity log (stored in English) and in the message
  const MOVED = { approved: 'Offer approved', draft: 'Offer sent back', sent: 'Offer sent', accepted: 'Offer accepted', rejected: 'Offer declined' };
  const transition = (from, to, min, after) => (req, res, next) => {
    const o = offerOf(req.params.id);
    if (!o) return next();
    if (!from.includes(o.status)) {
      const label = M.OFFER_STATUS[o.status];
      return h.back(req, res, `/admin/offers/${o.id}`, 'error', tr('This offer is {status}.', { status: isAr() ? label : label.toLowerCase() }));
    }
    db.tx(() => {
      db.run('UPDATE offers SET status = ? WHERE id = ?', to, o.id);
      if (after) after(req, o);
    });
    h.log(req, MOVED[to], 'offer', o.id, `${o.ref} · ${o.lead_title}`);
    h.back(req, res, `/admin/offers/${o.id}`, 'ok', tr(`${MOVED[to]}.`));
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
  // The proposal, in the reader's language or ?doc=ar|en for the tenant's.
  router.get('/offers/:id/print', (req, res, next) => {
    const o = offerOf(req.params.id);
    if (!o) return next();
    const lang = docLang(req);
    const html = i18n.run(lang, () => {
      const s = db.settings();
      const units = M.offerUnits(db, o.id);
      const sc = M.schedule(terms(o), units);
      const fit = o.rent_free_months ? tr('{fit}; {free} rent-free', { fit: months(o.fitout_months), free: months(o.rent_free_months) }) : months(o.fitout_months);
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="/admin/offers/${o.id}">${tr('Back')}</a>${docSwitch(`/admin/offers/${o.id}/print`, lang)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${tr('Leasing proposal')}</p><p class="doc__ref"><bdi>${ui.esc(o.ref)}</bdi> · ${ui.date(o.created_at)}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${tr('Prepared for')}</p><h1>${ui.esc(o.brand_name || o.lead_title)}</h1>${o.contact_name ? `<p>${ui.esc(o.contact_name)}${o.contact_title ? `${isAr() ? '، ' : ', '}${ui.esc(tx(o.contact_title))}` : ''}</p>` : ''}</section>
  <p class="doc__intro">${tr('Thank you for considering The Wave. Two curved wings around an open court on North 90, New Cairo, with plaza shops that each come with a terrace of their own. We are pleased to propose the following.')}</p>
  <h2>${tr('The space')}</h2>
  <table class="doc__t"><thead><tr><th>${tr('Unit')}</th><th>${tr('Level')}</th><th class="num">${tr('Indoor')}</th><th class="num">${tr('Terrace')}</th></tr></thead><tbody>${units.map((u) => `<tr><td>${ui.esc(u.code)}</td><td>${ui.esc(M.ZONES[u.zone])}</td><td class="num">${ui.m2(u.indoor_m2)}</td><td class="num">${ui.m2(u.terrace_m2)}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="2">${tr('Total')}</td><td class="num">${ui.m2(sc.indoor)}</td><td class="num">${ui.m2(sc.outdoor)}</td></tr></tfoot></table>
  <h2>${tr('Commercial terms')}</h2>
  <table class="doc__t doc__t--terms"><tbody>
    <tr><th>${tr('Base rent')}</th><td>${tr('{amount} per m² per month (indoor)', { amount: ui.money(o.rent_m2) })}</td></tr>
    <tr><th>${tr('Terrace')}</th><td>${tr('{amount} per m² per month', { amount: ui.money(o.terrace_rent_m2) })}</td></tr>
    <tr><th>${tr('Service charge')}</th><td>${tr('{amount} per m² per month', { amount: ui.money(o.service_m2) })}</td></tr>
    <tr><th>${tr('Term')}</th><td>${tr('{years}, from {date}', { years: years(o.term_years), date: ui.date(o.start_date) })}</td></tr>
    <tr><th>${tr('Yearly increase')}</th><td>${tr('{pct}% on the base rent each year', { pct: o.escalation_pct })}</td></tr>
    <tr><th>${tr('Fit-out')}</th><td>${fit}</td></tr>
    <tr><th>${tr('Security deposit')}</th><td>${tr('{months} of rent: {amount}', { months: months(o.deposit_months), amount: ui.money(sc.deposit) })}</td></tr>
    ${o.key_money ? `<tr><th>${tr('Key money')}</th><td>${ui.money(o.key_money)}</td></tr>` : ''}
  </tbody></table>
  <h2>${tr('Rent schedule')}</h2>
  ${scheduleTable(sc, { showRate: true }).replace('table table--fin', 'doc__t')}
  ${o.notes ? `<h2>${tr('Conditions')}</h2><p>${ui.esc(tx(o.notes)).replace(/\n/g, '<br>')}</p>` : ''}
  <p class="doc__small">${tr('Amounts in {cur}, exclusive of VAT and utilities. This proposal is valid until {date} and is subject to contract and to the landlord’s final approval.', { cur: ui.esc(ui.curLabel()), date: ui.date(o.valid_until) })}</p>
  <footer class="doc__sign"><div><span></span><p>${tr('For {name}', { name: ui.esc(tx(s.legal_name)) })}</p></div><div><span></span><p>${tr('For {name}', { name: ui.esc(o.brand_name || o.lead_title) })}</p></div></footer>
  <p class="doc__foot">${ui.esc(tx(s.address))} · ${ui.esc(s.leasing_email)}${s.leasing_phone ? ` · ${ui.esc(s.leasing_phone)}` : ''}</p>
</main>`;
      return ui.bare({ title: tr('Proposal {ref}', { ref: o.ref }), body, cls: 'print' });
    });
    res.type('html').send(html);
  });

  // ---------- leases ----------
  router.get('/leases', (req, res) => {
    const st = M.LEASE_STATUS[req.query.status] ? req.query.status : '';
    const rows = db.all(`SELECT s.*, b.name brand_name FROM leases s JOIN brands b ON b.id = s.brand_id ${st ? 'WHERE s.status = ?' : ''} ORDER BY s.status = 'active' DESC, s.start_date DESC`, ...(st ? [st] : []))
      .map((s) => ({ ...s, signed: !!db.value("SELECT COUNT(*) FROM documents WHERE entity = 'lease' AND entity_id = ? AND kind = 'lease_contract' AND archived = 0", s.id), units: M.leaseUnits(db, s.id), annual: s.status === 'active' ? M.currentAnnualRent(db, s) : null, next: db.get("SELECT due_date, total FROM invoices WHERE lease_id = ? AND status IN ('open','partial') ORDER BY due_date LIMIT 1", s.id) }));
    const tabs = [['', tr('All')], ...Object.entries(M.LEASE_STATUS)].map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/leases${k ? `?status=${k}` : ''}">${l}</a>`).join('');
    const table = ui.table(
      [
        { label: tr('Lease'), render: (s) => `<b>${ui.esc(s.brand_name)}</b><small class="sub">${ui.esc(s.ref)}</small>` },
        { label: tr('Units'), render: (s) => ui.esc(s.units.map((u) => u.code).join(', ')) },
        { label: tr('Area'), num: true, render: (s) => ui.m2(s.units.reduce((a, u) => a + u.indoor_m2, 0)) },
        { label: tr('Term'), render: (s) => `${ui.date(s.start_date)} – ${ui.date(s.end_date)}` },
        { label: tr('Annual rent now'), num: true, render: (s) => (s.annual !== null ? ui.money(s.annual, { compact: true }) : '—') },
        { label: tr('Next invoice'), render: (s) => (s.next ? `<span class="${s.next.due_date < M.today() ? 'late' : ''}">${ui.date(s.next.due_date)}<small class="sub">${ui.money(s.next.total, { compact: true })}</small></span>` : '—') },
        { label: tr('Signed copy'), render: (s) => (s.signed ? `<span class="paper is-ok">${ui.icon('check')}${ui.esc(tr('rec|On file'))}</span>` : `<span class="paper is-missing">${ui.esc(tr('rec|Missing'))}</span>`) },
        { label: tr('Status'), render: (s) => ui.badge(s.status, M.LEASE_STATUS[s.status]) },
      ],
      rows,
      { empty: tr('No leases yet. Accept an offer, then create a lease from it.'), href: (s) => `/admin/leases/${s.id}` },
    );
    h.page(req, res, { title: tr('Leases'), active: '/admin/leases', wide: true, body: `<nav class="tabs">${tabs}</nav>${ui.card(tn(rows.length, '{n} lease', '{n} leases'), table, { action: ui.btn(tr('Rent roll CSV'), { href: '/admin/export/rentroll.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}`, actions: h.can(req, 'manager') ? ui.btn(tr('New lease'), { href: '/admin/leases/new', cls: 'btn--primary', ic: 'plus' }) : '' });
  });

  router.get('/leases/new', R('manager'), (req, res) => {
    const o = req.query.offer ? offerOf(h.int(req.query.offer)) : null;
    const s = db.settings();
    const chosen = new Set(o ? M.offerUnits(db, o.id).map((u) => u.id) : []);
    const units = db.all("SELECT * FROM units WHERE status != 'leased' ORDER BY sort");
    const brands = db.all('SELECT id, name FROM brands ORDER BY name');
    const start = o ? (o.start_date && o.start_date > M.today() ? o.start_date : M.addMonths(M.today(), o.fitout_months || 0)) : M.addMonths(M.today(), 1);
    const sc = o ? M.schedule(terms(o), [...chosen].map((id) => units.find((u) => u.id === id)).filter(Boolean)) : null;
    const body = ui.card(tr('Lease terms'), ui.form('/admin/leases', req.session.csrf, `
      ${o ? `<input type="hidden" name="offer_id" value="${o.id}"><input type="hidden" name="lead_id" value="${o.lead_id}"><p class="alert alert--ok">${tr('From offer {ref}, accepted by {name}.', { ref: `<a href="/admin/offers/${o.id}">${ui.esc(o.ref)}</a>`, name: ui.esc(o.lead_title) })}</p>` : ''}
      <fieldset><legend>${tr('Tenant and units')}</legend><div class="fields">
        ${ui.select('brand_id', tr('Tenant (brand)'), brands.map((b) => [b.id, b.name]), o ? o.brand_id : '', { required: true, blank: tr('Choose…') })}
        <div class="picks span-all">${units.map((u) => `<label class="pick${chosen.has(u.id) ? ' is-on' : ''}"><input type="checkbox" name="units" value="${u.id}" ${chosen.has(u.id) ? 'checked' : ''}><b>${ui.esc(u.code)}</b><span>${u.terrace_m2 ? tr('deal|{a} + {b} terrace', { a: ui.m2(u.indoor_m2), b: ui.m2(u.terrace_m2) }) : ui.m2(u.indoor_m2)}</span>${ui.unitBadge(u.status)}</label>`).join('')}</div>
      </div></fieldset>
      <fieldset><legend>${tr('Rent')}</legend><div class="fields">
        ${ui.input('rent_m2', tr('Rent per m² / month'), o ? o.rent_m2 : '', { type: 'number', step: '0.01', min: 0, required: true })}
        ${ui.input('terrace_rent_m2', tr('Terrace per m² / month'), o ? o.terrace_rent_m2 : '', { type: 'number', step: '0.01', min: 0 })}
        ${ui.input('service_m2', tr('Service charge per m² / month'), o ? o.service_m2 : s.service_m2, { type: 'number', step: '0.01', min: 0 })}
        ${ui.input('escalation_pct', tr('Yearly increase (%)'), o ? o.escalation_pct : s.default_escalation, { type: 'number', step: '0.5', min: 0 })}
      </div></fieldset>
      <fieldset><legend>${tr('Term and payment')}</legend><div class="fields">
        ${ui.input('start_date', tr('Start date'), start, { type: 'date', required: true })}
        ${ui.input('term_years', tr('Term (years)'), o ? o.term_years : s.default_term_years, { type: 'number', min: 1, max: 30, required: true })}
        ${ui.input('rent_free_months', tr('Rent-free months'), o ? o.rent_free_months : 0, { type: 'number', min: 0 })}
        ${ui.select('payment_freq', tr('Invoiced'), FREQ(), 'quarterly')}
        ${ui.input('deposit', tr('Security deposit'), sc ? Math.round(sc.deposit) : '', { type: 'number', min: 0, step: 1 })}
        ${ui.input('key_money', tr('Key money'), o ? o.key_money : 0, { type: 'number', min: 0, step: 1 })}
        ${ui.input('signed_at', tr('Signed on'), M.today(), { type: 'date' })}
        ${ui.textarea('notes', tr('Notes'), '', { rows: 3, cls: 'span-all' })}
      </div></fieldset>
      <div class="row">${ui.btn(tr('Create lease'), { cls: 'btn--primary' })}<span class="muted">${tr('It starts as a draft. Activate it to let the units and start billing.')}</span></div>`, { cls: 'stack form' }));
    h.page(req, res, { title: tr('New lease'), crumbs: [['/admin/leases', tr('Leases')], [null, tr('lease|New')]], active: '/admin/leases', body });
  });

  router.post('/leases', R('manager'), (req, res) => {
    const b = req.body;
    const unitIds = h.list(b.units).map(Number).filter(Boolean);
    const brand = db.get('SELECT * FROM brands WHERE id = ?', h.int(b.brand_id));
    const rent = h.numv(b.rent_m2);
    const start = h.str(b.start_date, 10);
    const years = Math.max(1, Math.min(30, h.int(b.term_years) || 5));
    if (!brand || !unitIds.length || !rent || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return h.back(req, res, `/admin/leases/new${b.offer_id ? `?offer=${h.int(b.offer_id)}` : ''}`, 'error', tr('Choose the tenant and units, and set the rent and start date.'));
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
    h.back(req, res, `/admin/leases/${id}`, 'ok', tr('Lease drafted. Check it, then activate it.'));
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
    const leaseDocs = h.docs(req, 'lease', s.id);
    const signed = leaseDocs.some((d) => d.kind === 'lease_contract');
    const docPanel = ui.docPanel({
      docs: leaseDocs, entity: 'lease', entityId: s.id, csrf, canUpload: h.can(req, 'agent'), canDelete: h.can(req, 'manager'), canConfidential: h.canHR(req),
      required: ['lease_contract'], warnDays: Number(db.setting('doc_warn_days')) || 30,
      sub: ui.esc(signed ? tr('The signed lease is on file.') : tr('Upload the signed lease, addenda, the handover report and any bank guarantee.')),
    });
    const actions = [];
    if (s.status === 'draft' && h.can(req, 'manager')) actions.push(ui.form(`/admin/leases/${s.id}/activate`, csrf, ui.btn(tr('Activate lease'), { cls: 'btn--primary', ic: 'check', attrs: { 'data-confirm': tr('Activate? The units become leased and the invoices are created.') } })));
    if (s.status === 'active' && h.can(req, 'manager')) actions.push(`<details class="pop"><summary class="btn btn--ghost">${tr('End lease')}</summary>${ui.form(`/admin/leases/${s.id}/end`, csrf, `${ui.select('how', tr('How'), { ended: tr('Ended (term complete)'), terminated: tr('Terminated early') }, 'terminated')}${ui.input('date', tr('Last day'), t, { type: 'date' })}${ui.btn(tr('End lease'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('End this lease? Future invoices are voided and the units become available.') } })}`, { cls: 'stack' })}</details>`);
    if (s.status === 'active' && h.can(req, 'manager')) actions.push(`<details class="pop"><summary class="btn btn--ghost">${tr('Add a charge')}</summary>${ui.form(`/admin/leases/${s.id}/charge`, csrf, `${ui.input('note', tr('What for'), '', { required: true, placeholder: tr('e.g. Signage approval fee') })}${ui.input('amount', tr('Amount'), '', { type: 'number', min: 1, step: 1, required: true })}${ui.input('due', tr('Due'), M.addDays(t, 14), { type: 'date' })}${ui.btn(tr('Add charge'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>`);
    const kpis = [
      ui.kpi({ label: tr('Area'), value: ui.m2(sc.indoor), sub: units.map((u) => u.code).join(', ') }),
      ui.kpi({ label: tr('Annual rent now'), value: ui.money(s.status === 'active' ? M.currentAnnualRent(db, s) : sc.annual, { compact: true }), sub: tr('{rate} / m² at start, +{pct}%', { rate: ui.money(s.rent_m2), pct: s.escalation_pct }) }),
      ui.kpi({ label: tr('Contract value'), value: ui.money(sc.total, { compact: true }), sub: years(s.term_years) }),
      ui.kpi({ label: tr('Collected'), value: ui.money(paid, { compact: true }), bar: billed ? paid / billed : 0, sub: tr('of {amount} billed', { amount: ui.money(billed, { compact: true }) }) }),
      ui.kpi({ label: tr('Overdue'), value: ui.money(overdue, { compact: true }), tone: overdue ? 'kpi--alert' : '' }),
    ].join('');
    const invTable = ui.table(
      [
        { label: tr('Invoice'), render: (i) => `<b>${ui.esc(i.ref)}</b><small class="sub">${i.kind === 'rent' ? `${ui.date(i.period_start)} – ${ui.date(i.period_end)}` : ui.esc(tx(i.note) || KINDS()[i.kind] || tr('Charge'))}</small>` },
        { label: tr('Due'), render: (i) => `<span class="${['open', 'partial'].includes(i.status) && i.due_date < t ? 'late' : ''}">${ui.date(i.due_date)}</span>` },
        { label: tr('Rent'), num: true, render: (i) => ui.money(i.rent, { cur: false }) },
        { label: tr('Service'), num: true, render: (i) => ui.money(i.service, { cur: false }) },
        { label: tr('Total'), num: true, render: (i) => `<b>${ui.money(i.total, { cur: false })}</b>` },
        { label: tr('Paid'), num: true, render: (i) => ui.money(i.paid, { cur: false }) },
        { label: tr('Status'), render: (i) => (['open', 'partial'].includes(i.status) && i.due_date < t ? ui.badge('overdue', tr('invoice|Overdue')) : ui.badge(i.status, M.INVOICE_STATUS[i.status])) },
      ],
      inv,
      { empty: s.status === 'draft' ? tr('Invoices are created when the lease is activated.') : tr('No invoices.'), href: (i) => `/admin/invoices/${i.id}` },
    );
    const facts = `<dl class="dl">
      <div><dt>${tr('Tenant')}</dt><dd><a href="/admin/brands/${s.brand_id}">${ui.esc(s.brand_name)}</a> · ${ui.esc(M.CATEGORIES[s.category])}</dd></div>
      <div><dt>${tr('Status')}</dt><dd>${ui.badge(s.status, M.LEASE_STATUS[s.status])}</dd></div>
      <div><dt>${tr('Term')}</dt><dd>${ui.date(s.start_date)} – ${ui.date(s.end_date)} (${years(s.term_years)})</dd></div>
      <div><dt>${tr('Rent')}</dt><dd>${tr('{rate} / m² · terrace {terrace} · service {service}', { rate: ui.money(s.rent_m2), terrace: ui.money(s.terrace_rent_m2, { cur: false }), service: ui.money(s.service_m2, { cur: false }) })}</dd></div>
      <div><dt>${tr('Increase')}</dt><dd>${tr('{pct}% a year', { pct: s.escalation_pct })}</dd></div>
      <div><dt>${tr('Rent-free')}</dt><dd>${months(s.rent_free_months)}</dd></div>
      <div><dt>${tr('Invoiced')}</dt><dd>${FREQ()[s.payment_freq] || ''}</dd></div>
      <div><dt>${tr('Deposit')}</dt><dd>${ui.money(s.deposit)}</dd></div>
      ${s.key_money ? `<div><dt>${tr('Key money')}</dt><dd>${ui.money(s.key_money)}</dd></div>` : ''}
      <div><dt>${tr('Signed on')}</dt><dd>${ui.date(s.signed_at)}</dd></div>
      <div><dt>${tr('Signed copy')}</dt><dd>${signed ? `<span class="paper is-ok">${ui.icon('check')}${ui.esc(tr('rec|On file'))}</span>` : `<a class="paper is-missing" href="#documents">${ui.esc(tr('Missing: upload the signed lease'))}</a>`}</dd></div>
      ${s.offer_id ? `<div><dt>${tr('From offer')}</dt><dd><a href="/admin/offers/${s.offer_id}">${tr('View offer')}</a></dd></div>` : ''}
      ${s.lead_id ? `<div><dt>${tr('Lead')}</dt><dd><a href="/admin/leads/${s.lead_id}">${ui.esc(s.lead_title || tr('View lead'))}</a></dd></div>` : ''}
    </dl>${s.notes ? `<blockquote class="quote quote--sm">${ui.esc(tx(s.notes))}</blockquote>` : ''}`;
    const body = `<div class="kpis kpis--5">${kpis}</div>
<div class="grid grid--side"><div class="stack">${ui.card(tr('Invoices'), invTable, { sub: tn(inv.length, '{n} invoice', '{n} invoices') })}${ui.card(tr('Rent schedule'), scheduleTable(sc))}</div><div class="stack">${ui.card(tr('Lease'), facts)}<div id="documents">${docPanel}</div>${ui.card(tr('Units'), `${units.map((u) => `<p><a href="/admin/units/${u.id}"><b>${ui.esc(u.code)}</b></a> · ${u.terrace_m2 ? tr('deal|{a} + {b} terrace', { a: ui.m2(u.indoor_m2), b: ui.m2(u.terrace_m2) }) : ui.m2(u.indoor_m2)} ${ui.unitBadge(u.status)}</p>`).join('')}`)}</div></div>`;
    h.page(req, res, { title: `${s.brand_name}`, crumbs: [['/admin/leases', tr('Leases')], [null, s.ref]], active: '/admin/leases', body, actions: `<div class="row">${actions.join('')}</div>` });
  });

  router.post('/leases/:id/activate', R('manager'), (req, res, next) => {
    const s = leaseOf(req.params.id);
    if (!s) return next();
    if (s.status !== 'draft') return h.back(req, res, `/admin/leases/${s.id}`, 'error', tr('Only a draft lease can be activated.'));
    const units = M.leaseUnits(db, s.id);
    const clash = units.filter((u) => u.status === 'leased');
    if (clash.length) return h.back(req, res, `/admin/leases/${s.id}`, 'error', tr('{codes} already leased.', { codes: clash.map((u) => u.code).join(', ') }));
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
    h.back(req, res, `/admin/leases/${s.id}`, 'ok', tr('Lease active. {codes} leased and invoices created.', { codes: units.map((u) => u.code).join(', ') }));
  });

  router.post('/leases/:id/end', R('manager'), (req, res, next) => {
    const s = leaseOf(req.params.id);
    if (!s) return next();
    const how = req.body.how === 'ended' ? 'ended' : 'terminated';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : M.today();
    db.tx(() => {
      db.run('UPDATE leases SET status = ?, end_date = ? WHERE id = ?', how, date, s.id);
      db.run("UPDATE invoices SET status = 'void', note = CASE WHEN note IS NULL OR note = '' THEN 'Voided: lease ended' ELSE note || ' (lease ended)' END WHERE lease_id = ? AND status = 'open' AND due_date > ?", s.id, date);
      for (const u of M.leaseUnits(db, s.id)) db.run("UPDATE units SET status = 'available', updated_at = ? WHERE id = ?", M.now(), u.id);
    });
    h.log(req, `Lease ${how}`, 'lease', s.id, `${s.ref} · ${s.brand_name}`);
    h.back(req, res, `/admin/leases/${s.id}`, 'ok', tr('Lease ended. Its units are available again.'));
  });

  router.post('/leases/:id/charge', R('manager'), (req, res, next) => {
    const s = leaseOf(req.params.id);
    if (!s) return next();
    const amount = h.numv(req.body.amount);
    if (!amount || amount <= 0) return h.back(req, res, `/admin/leases/${s.id}`, 'error', tr('Enter an amount.'));
    db.run("INSERT INTO invoices (ref, lease_id, kind, due_date, other, total, note, created_at) VALUES (?, ?, 'other', ?, ?, ?, ?, ?)", db.nextRef('invoices', 'IN', 4, true), s.id, h.str(req.body.due, 10) || M.today(), amount, amount, h.str(req.body.note, 200), M.now());
    h.log(req, 'Added a charge', 'lease', s.id, `${s.ref} · ${amount}`);
    h.back(req, res, `/admin/leases/${s.id}`, 'ok', tr('Charge added.'));
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
      ui.kpi({ label: tr('Due now'), value: ui.money(outstanding, { compact: true }), sub: tr('Open invoices due today or earlier') }),
      ui.kpi({ label: tr('Overdue'), value: ui.money(overdue, { compact: true }), tone: overdue ? 'kpi--alert' : '', href: '/admin/billing?status=overdue' }),
      ui.kpi({ label: tr('Due in 30 days'), value: ui.money(next30, { compact: true }), href: '/admin/billing?status=upcoming' }),
      ui.kpi({ label: tr('Collected this month'), value: ui.money(collected, { compact: true }), bar: billedMonth ? Math.min(1, collected / billedMonth) : 0, sub: tr('of {amount} billed this month', { amount: ui.money(billedMonth, { compact: true }) }) }),
    ].join('');
    const tabs = [['open', tr('Due within 30 days')], ['overdue', tr('Overdue')], ['upcoming', tr('Upcoming')], ['paid', tr('invoice|Paid')], ['all', tr('All')]].map(([k, l]) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/billing?status=${k}">${l}</a>`).join('');
    const table = ui.table(
      [
        { label: tr('Invoice'), render: (i) => `<b>${ui.esc(i.ref)}</b><small class="sub">${ui.esc(i.brand_name)} · ${ui.esc(i.lease_ref)}</small>` },
        { label: tr('invoice|For'), render: (i) => (i.kind === 'rent' ? `${ui.date(i.period_start)} – ${ui.date(i.period_end)}` : ui.esc(tx(i.note) || KINDS()[i.kind] || i.kind)) },
        { label: tr('Due'), render: (i) => `<span class="${['open', 'partial'].includes(i.status) && i.due_date < t ? 'late' : ''}">${ui.date(i.due_date)}<small class="sub">${ui.rel(i.due_date)}</small></span>` },
        { label: tr('Total'), num: true, render: (i) => ui.money(i.total, { cur: false }) },
        { label: tr('Outstanding'), num: true, render: (i) => `<b>${ui.money(i.total - i.paid, { cur: false })}</b>` },
        { label: tr('Status'), render: (i) => (['open', 'partial'].includes(i.status) && i.due_date < t ? ui.badge('overdue', tr('invoice|Overdue')) : ui.badge(i.status, M.INVOICE_STATUS[i.status])) },
      ],
      rows,
      { empty: st === 'overdue' ? tr('Nothing overdue.') : tr('No invoices here.'), href: (i) => `/admin/invoices/${i.id}` },
    );
    const owed = db.all("SELECT b.id, b.name, s.id lease_id, s.ref, SUM(i.total - i.paid) amount, MIN(i.due_date) oldest, COUNT(*) n FROM invoices i JOIN leases s ON s.id = i.lease_id JOIN brands b ON b.id = s.brand_id WHERE i.status IN ('open','partial') AND i.due_date < ? GROUP BY s.id ORDER BY amount DESC LIMIT 6", t);
    const owedList = owed.length
      ? `<ul class="list">${owed.map((o) => `<li><a href="/admin/leases/${o.lease_id}"><span class="dot dot--rose"></span><span class="what"><b>${ui.esc(o.name)}</b><small>${tr('{ref} · {invoices} · oldest {when}', { ref: ui.esc(o.ref), invoices: tn(o.n, '{n} invoice', '{n} invoices'), when: ui.rel(o.oldest) })}</small></span><b>${ui.money(o.amount, { compact: true })}</b></a></li>`).join('')}</ul>`
      : `<p class="muted pad">${tr('No one is behind. Every invoice due so far is paid.')}</p>`;
    const body = `<div class="kpis kpis--4">${kpis}</div>
<nav class="tabs">${tabs}</nav>${ui.card(tn(rows.length, '{n} invoice', '{n} invoices'), table, { action: ui.btn(tr('Export CSV'), { href: '/admin/export/invoices.csv', cls: 'btn--ghost btn--sm', ic: 'dl' }) })}
<div class="grid grid--2">
  ${ui.card(tr('Receivables aging'), ui.bars(R2.aging, { key: 'amount', label: 'label', fmtv: (n) => ui.money(n, { compact: true, cur: false }), tone: 'cocoa' }), { sub: tr('Overdue amounts by days past due') })}
  ${ui.card(tr('Who is behind'), owedList, { sub: tr('Overdue balance by lease') })}
</div>`;
    h.page(req, res, { title: tr('Billing'), active: '/admin/billing', wide: true, body });
  });

  const invoiceOf = (id) => db.get('SELECT i.*, s.ref lease_ref, s.id lease_id, s.brand_id, b.name brand_name FROM invoices i JOIN leases s ON s.id = i.lease_id JOIN brands b ON b.id = s.brand_id WHERE i.id = ?', id);

  router.get('/invoices/:id', (req, res, next) => {
    const i = invoiceOf(req.params.id);
    if (!i) return next();
    const t = M.today();
    const open = ['open', 'partial'].includes(i.status);
    const pay = open && h.can(req, 'manager')
      ? ui.card(tr('Record a payment'), ui.form(`/admin/invoices/${i.id}/pay`, req.session.csrf, `<div class="fields">${ui.input('amount', tr('Amount'), i.total - i.paid, { type: 'number', min: 1, step: '0.01', required: true })}${ui.input('date', tr('Received on'), t, { type: 'date', required: true })}${ui.select('method', tr('Method'), METHODS(), 'transfer')}${ui.input('note', tr('Reference'), '', { placeholder: tr('e.g. transfer ref or cheque no.') })}</div>${ui.btn(tr('Record payment'), { cls: 'btn--primary' })}`, { cls: 'stack' }))
      : '';
    const voidForm = open && h.can(req, 'manager') ? `<details class="danger"><summary>${tr('Void invoice')}</summary>${ui.form(`/admin/invoices/${i.id}/void`, req.session.csrf, ui.btn(tr('Void invoice'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('Void this invoice?') } }))}</details>` : '';
    const paidAt = i.paid_at ? (i.method ? tr('{date} by {method}', { date: ui.date(i.paid_at), method: ui.esc(METHODS()[i.method] || i.method) }) : ui.date(i.paid_at)) : '';
    const body = `<div class="grid grid--side">
  ${ui.card(tr('Invoice'), `<dl class="dl">
    <div><dt>${tr('Tenant')}</dt><dd><a href="/admin/brands/${i.brand_id}">${ui.esc(i.brand_name)}</a></dd></div>
    <div><dt>${tr('Lease')}</dt><dd><a href="/admin/leases/${i.lease_id}">${ui.esc(i.lease_ref)}</a></dd></div>
    <div><dt>${tr('invoice|For')}</dt><dd>${i.kind === 'rent' ? tr('Rent and service, {start} – {end}', { start: ui.date(i.period_start), end: ui.date(i.period_end) }) : ui.esc(tx(i.note) || KINDS()[i.kind] || i.kind)}</dd></div>
    <div><dt>${tr('Due')}</dt><dd class="${open && i.due_date < t ? 'late' : ''}">${ui.date(i.due_date)} · ${ui.rel(i.due_date)}</dd></div>
    <div><dt>${tr('Rent')}</dt><dd>${ui.money(i.rent)}</dd></div><div><dt>${tr('Service')}</dt><dd>${ui.money(i.service)}</dd></div>${i.other ? `<div><dt>${tr('Other')}</dt><dd>${ui.money(i.other)}</dd></div>` : ''}
    <div><dt>${tr('Total')}</dt><dd><b>${ui.money(i.total)}</b></dd></div>
    <div><dt>${tr('Paid')}</dt><dd>${ui.money(i.paid)}${paidAt ? ` · ${paidAt}` : ''}</dd></div>
    <div><dt>${tr('Status')}</dt><dd>${open && i.due_date < t ? ui.badge('overdue', tr('invoice|Overdue')) : ui.badge(i.status, M.INVOICE_STATUS[i.status])}</dd></div>
    ${i.note && i.kind === 'rent' ? `<div><dt>${tr('Note')}</dt><dd>${ui.esc(tx(i.note))}</dd></div>` : ''}
  </dl>`)}
  <div class="stack">${pay}${voidForm}</div>
</div>`;
    h.page(req, res, { title: tr('Invoice {ref}', { ref: i.ref }), crumbs: [['/admin/billing', tr('Billing')], [`/admin/leases/${i.lease_id}`, i.brand_name], [null, i.ref]], active: '/admin/billing', body, actions: ui.btn(tr('Print'), { href: `/admin/invoices/${i.id}/print`, cls: 'btn--ghost', ic: 'print', attrs: { target: '_blank' } }) });
  });

  router.post('/invoices/:id/pay', R('manager'), (req, res, next) => {
    const i = invoiceOf(req.params.id);
    if (!i) return next();
    const amount = h.numv(req.body.amount);
    if (!amount || amount <= 0) return h.back(req, res, `/admin/invoices/${i.id}`, 'error', tr('Enter the amount received.'));
    const paid = Math.min(i.total, i.paid + amount);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : M.today();
    db.run('UPDATE invoices SET paid = ?, status = ?, paid_at = ?, method = ?, note = COALESCE(?, note) WHERE id = ?', paid, paid >= i.total - 0.5 ? 'paid' : 'partial', date, h.str(req.body.method, 20), h.str(req.body.note, 200) || null, i.id);
    h.log(req, 'Recorded a payment', 'invoice', i.id, `${i.ref} · ${amount}`);
    h.back(req, res, `/admin/invoices/${i.id}`, 'ok', paid >= i.total - 0.5 ? tr('Paid in full.') : tr('Part payment recorded.'));
  });

  router.post('/invoices/:id/void', R('manager'), (req, res) => {
    db.run("UPDATE invoices SET status = 'void' WHERE id = ? AND status IN ('open','partial')", req.params.id);
    h.log(req, 'Voided an invoice', 'invoice', h.int(req.params.id));
    h.back(req, res, `/admin/invoices/${req.params.id}`, 'ok', tr('Invoice voided.'));
  });

  router.get('/invoices/:id/print', (req, res, next) => {
    const i = invoiceOf(req.params.id);
    if (!i) return next();
    const lang = docLang(req);
    const html = i18n.run(lang, () => {
      const s = db.settings();
      const vat = Number(s.vat_pct) || 0;
      const lines = [i.rent ? [tr('Base rent'), i.rent] : null, i.service ? [tr('Service charge'), i.service] : null, i.other ? [tx(i.note) || KINDS()[i.kind] || tr('Other'), i.other] : null].filter(Boolean);
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${tr('Print or save as PDF')}</span></button><a class="btn btn--ghost" href="/admin/invoices/${i.id}">${tr('Back')}</a>${docSwitch(`/admin/invoices/${i.id}/print`, lang)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${tr('doc|Invoice')}</p><p class="doc__ref">${tr('{ref} · issued {date}', { ref: `<bdi>${ui.esc(i.ref)}</bdi>`, date: ui.date(i.created_at) })}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${tr('Billed to')}</p><h1>${ui.esc(i.brand_name)}</h1><p>${i.kind === 'rent' ? tr('Lease {ref} · period {start} – {end}', { ref: ui.esc(i.lease_ref), start: ui.date(i.period_start), end: ui.date(i.period_end) }) : tr('Lease {ref}', { ref: ui.esc(i.lease_ref) })}</p></section>
  <table class="doc__t"><thead><tr><th>${tr('Description')}</th><th class="num">${tr('Amount ({cur})', { cur: ui.esc(ui.curLabel()) })}</th></tr></thead><tbody>${lines.map(([l, a]) => `<tr><td>${ui.esc(l)}</td><td class="num">${ui.money(a, { cur: false })}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td>${tr('Subtotal')}</td><td class="num">${ui.money(i.total, { cur: false })}</td></tr>${vat ? `<tr><td>${tr('VAT {pct}%', { pct: vat })}</td><td class="num">${ui.money(i.total * vat / 100, { cur: false })}</td></tr>` : ''}<tr><td><b>${tr('Total due by {date}', { date: ui.date(i.due_date) })}</b></td><td class="num"><b>${ui.money(i.total * (1 + vat / 100))}</b></td></tr>${i.paid ? `<tr><td>${tr('Paid')}</td><td class="num">${ui.money(i.paid, { cur: false })}</td></tr>` : ''}</tfoot></table>
  <p class="doc__small">${tr('Please quote {ref} with your payment.', { ref: ui.esc(i.ref) })}</p>
  <p class="doc__foot">${ui.esc(tx(s.legal_name))} · ${ui.esc(tx(s.address))} · ${ui.esc(s.leasing_email)}</p>
</main>`;
      return ui.bare({ title: tr('Invoice {ref}', { ref: i.ref }), body, cls: 'print' });
    });
    res.type('html').send(html);
  });
};
