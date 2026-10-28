'use strict';

// Fines and incidents in the car park (/admin/parking/incidents, /violations, /lost).
//
// Fines: parking in an accessible, VIP or booked bay, blocking a lane, double parking… With the car
// still inside, the fine goes on its visit and is paid at the exit; if it has left, the fine waits
// and comes back with the plate's next visit. Managers can waive a fine (with a reason).
// Incidents: accidents, damage, theft, injuries, security matters, lost and found items, each with
// photos, the plates involved (and the entry camera's picture of them), notes and a status.

const { t: tr, tx, isAr } = require('../i18n');
const { registerDocs, uploadRoute } = require('../ops-common');

const V_STATUS = { charged: ['prk|On the visit', 'amber'], unpaid: ['prk|Waiting for the next visit', 'rose'], paid: ['prk|Paid', 'ok'], waived: ['prk|Waived', 'mute'], disputed: ['prk|Disputed', 'sky'] };
const I_KINDS = { accident: 'prk|Accident', damage: 'prk|Damage', theft: 'prk|Theft', injury: 'prk|Injury', security: 'prk|Security', lost: 'prk|Lost item', found: 'prk|Found item', other: 'prk|Other' };
const I_STATUS = { open: ['prk|Open', 'rose'], investigating: ['prk|Being looked into', 'amber'], resolved: ['prk|Resolved', 'ok'], closed: ['prk|Closed', 'mute'] };
const DEFAULT_TYPES = [
  ['ACCESSIBLE', 'Parked in an accessible bay', 'الوقوف في مكان مخصص لذوي الهمم', 500],
  ['VIP', 'Parked in a VIP bay', 'الوقوف في مكان كبار الزوار', 300],
  ['RESERVED', 'Parked in a booked bay', 'الوقوف في مكان محجوز', 300],
  ['EV', 'Electric bay used without charging', 'استخدام مكان الشحن الكهربائي دون شحن', 200],
  ['BLOCKING', 'Blocking a lane or another car', 'سد ممر أو سيارة أخرى', 250],
  ['DOUBLE', 'Taking two bays', 'الوقوف في مكانين', 150],
  ['NOPARK', 'Parked where parking is not allowed', 'الوقوف في مكان ممنوع', 200],
];

module.exports = function safetyRoutes(router, h, c) {
  const { db, ui, M } = h;
  const { P, esc } = c;
  const now = () => new Date().toISOString();
  if (!db.value('SELECT COUNT(*) FROM pk_violation_types')) for (const [code, name, ar, fine] of DEFAULT_TYPES) db.run('INSERT INTO pk_violation_types (code, name, name_ar, fine) VALUES (?, ?, ?, ?)', code, name, ar, fine);
  registerDocs(M, 'pk_violation', 'prk|Parking fine', { violation_photo: 'prk|Photo' });
  registerDocs(M, 'pk_incident', 'prk|Car park incident', { incident_photo: 'prk|Photo', incident_report: 'prk|Report', incident_claim: 'prk|Insurance claim' });
  const vDocs = uploadRoute(router, h, '/parking/violations/upload', { pk_violation: 'pk_violations' });
  const iDocs = uploadRoute(router, h, '/parking/incidents/upload', { pk_incident: 'pk_incidents' });
  const SUB = [['/admin/parking/incidents', 'prk|Incidents'], ['/admin/parking/violations', 'prk|Fines'], ['/admin/parking/lost', 'prk|Lost and found']];
  const head = (on) => `${c.tabs(on)}${c.subtabs(on, SUB)}`;
  const vBadge = (s) => ui.badge(s, tr((V_STATUS[s] || [s])[0]), (V_STATUS[s] || [])[1]);
  const iBadge = (s) => ui.badge(s, tr((I_STATUS[s] || [s])[0]), (I_STATUS[s] || [])[1]);
  const typeName = (t) => (t ? (isAr() && t.name_ar ? t.name_ar : tx(t.name)) : '');
  const types = () => db.all('SELECT * FROM pk_violation_types WHERE active = 1 ORDER BY fine DESC, id');
  const bayBy = (code) => (code ? db.get('SELECT * FROM pk_bays WHERE code = ?', String(code).toUpperCase().trim()) : null);
  const zoneOpts = () => P.zones().map((z) => [z.id, `${c.zoneName(z)} · ${z.code}`]);

  // ================= fines =================
  // Charge a fine: on the visit if the car is inside, else waiting for its next visit.
  function fine({ type, plate, bay = null, place = null, amount, note = null, user = null, at = now(), demo = 0 }) {
    const key = P.plateKey(plate);
    if (!key) throw P.fail('prk|Type the plate.');
    const s = P.findInside({ plate: key });
    return db.tx(() => {
      const id = Number(db.run(`INSERT INTO pk_violations (ref, type_id, plate, plate_key, session_id, charged_session_id, bay_id, place, note, fine, status, user_id, at, demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, db.nextRef('pk_violations', 'PV', 5, true), type ? type.id : null, P.plateShow(plate), key, s ? s.id : null, s ? s.id : null,
      bay ? bay.id : null, place, note, amount, s ? 'charged' : 'unpaid', user ? user.id : null, at, demo ? 1 : 0).lastInsertRowid);
      if (s && amount > 0) P.addExtra(s, amount);
      return db.get('SELECT * FROM pk_violations WHERE id = ?', id);
    });
  }
  function waive(v, { status = 'waived', reason, user }) {
    db.tx(() => {
      if (v.status === 'charged' && v.charged_session_id) {
        const s = P.sessionBy(v.charged_session_id);
        if (s && s.status === 'inside') P.addExtra(s, -v.fine);
      }
      db.run('UPDATE pk_violations SET status = ?, resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?', status, reason, now(), user ? user.id : null, v.id);
    });
  }
  h.parking.fine = fine;

  router.get('/parking/violations', (req, res) => {
    const status = V_STATUS[req.query.status] ? req.query.status : '';
    const rows = db.all(`SELECT v.*, t.name tname, t.name_ar tname_ar, b.code bay_code FROM pk_violations v LEFT JOIN pk_violation_types t ON t.id = v.type_id LEFT JOIN pk_bays b ON b.id = v.bay_id
      ${status ? 'WHERE v.status = ?' : ''} ORDER BY v.at DESC LIMIT 200`, ...(status ? [status] : []));
    const month = c.today().slice(0, 7);
    const st = db.get("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status = 'paid' THEN fine END), 0) paid, COALESCE(SUM(CASE WHEN status IN ('charged','unpaid') THEN fine END), 0) open FROM pk_violations WHERE substr(at, 1, 7) = ?", month);
    const kpis = [
      ui.kpi({ label: tr('prk|Fines this month'), value: ui.n0(st.n) }),
      ui.kpi({ label: tr('prk|Collected'), value: c.money(st.paid) }),
      ui.kpi({ label: tr('prk|Still to collect'), value: c.money(st.open) }),
      ui.kpi({ label: tr('prk|Waiting for the next visit'), value: ui.n0(db.value("SELECT COUNT(*) FROM pk_violations WHERE status = 'unpaid'")), href: '/admin/parking/violations?status=unpaid' }),
    ].join('');
    const table = ui.table([
      { label: tr('prk|Fine'), render: (v) => `<b>${esc(isAr() && v.tname_ar ? v.tname_ar : tx(v.tname || ''))}</b><small class="sub">${esc(v.ref)} · ${esc(ui.dt(v.at))}</small>` },
      { label: tr('prk|Plate'), render: (v) => c.plate(v.plate, 'pk-plate--sm') },
      { label: tr('prk|Where'), render: (v) => esc(v.bay_code || v.place || '—') },
      { label: tr('prk|Amount'), num: true, render: (v) => c.money(v.fine) },
      { label: tr('Status'), render: (v) => vBadge(v.status) },
    ], rows, { href: (v) => `/admin/parking/violations/${v.id}`, empty: esc(tr('prk|No fines.')) });
    const filters = `<form method="get" class="filters">${ui.select('status', tr('Status'), c.tmap(V_STATUS), status, { blank: tr('prk|All') })}${ui.btn(esc(tr('prk|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    c.page(req, res, { title: tr('prk|Fines'), crumbs: c.crumbs([null, tr('prk|Fines')]), actions: h.can(req, 'agent') ? ui.btn(esc(tr('prk|New fine')), { href: '/admin/parking/violations/new', cls: 'btn--primary', ic: 'plus' }) : '', body: `${head('/admin/parking/violations')}<div class="kpis kpis--4">${kpis}</div>${filters}${ui.card(tr('prk|Fines'), table, { sub: esc(tr('prk|A fine on a car inside is paid at the exit. If the car has left, it comes back with its next visit.')) })}` });
  });
  router.get('/parking/violations/new', c.RA, (req, res) => {
    const ts = types();
    const pre = h.str(req.query.plate, 30);
    const form = ui.form('/admin/parking/violations', req.session.csrf, `<div class="fields">
      ${ui.select('type', tr('prk|What'), ts.map((t) => [t.id, `${typeName(t)} · ${ui.money(t.fine)}`]), ts[0] ? ts[0].id : '')}
      ${ui.input('plate', tr('prk|Plate'), pre, { required: true, placeholder: 'ق ص ر 1234', attrs: { autocomplete: 'off' } })}
      ${ui.input('bay', tr('prk|Bay'), h.str(req.query.bay, 20), { placeholder: 'B1-A07' })}
      ${ui.input('place', tr('prk|Or where'), '', { placeholder: tr('prk|e.g. B2 ramp') })}
      ${h.can(req, 'manager') ? ui.input('amount', tr('prk|Amount'), '', { type: 'number', min: 0, step: 1, hint: tr('prk|Empty: the usual amount.') }) : ''}
      ${ui.textarea('note', tr('prk|Notes'), '', { rows: 3, cls: 'span-all' })}</div>${ui.btn(esc(tr('prk|Record the fine')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    c.page(req, res, { title: tr('prk|New fine'), crumbs: c.crumbs(['/admin/parking/violations', tr('prk|Fines')], [null, tr('prk|New')]), body: `${head('/admin/parking/violations')}${ui.card(tr('prk|New fine'), form, { sub: esc(tr('prk|Add photos on the next page.')) })}` });
  });
  router.post('/parking/violations', c.RA, (req, res) => {
    const type = db.get('SELECT * FROM pk_violation_types WHERE id = ?', h.int(req.body.type));
    if (!type) return c.back(req, res, '/admin/parking/violations/new', 'error', tr('prk|Choose what happened.'));
    const bay = bayBy(req.body.bay);
    if (req.body.bay && !bay) return c.back(req, res, '/admin/parking/violations/new', 'error', tr('prk|There is no bay {code}.', { code: h.str(req.body.bay, 20) }));
    const amount = h.can(req, 'manager') && req.body.amount !== '' && req.body.amount !== undefined ? Math.max(0, h.numv(req.body.amount) || 0) : type.fine;
    try {
      const v = fine({ type, plate: h.str(req.body.plate, 30), bay, place: h.str(req.body.place, 60) || null, amount, note: h.str(req.body.note, 1000) || null, user: req.user });
      h.log(req, 'Recorded a parking fine', 'pk_violation', v.id, `${v.ref} · ${v.plate} · ${v.fine}`);
      c.back(req, res, `/admin/parking/violations/${v.id}`, 'ok', v.status === 'charged' ? tr('prk|Fine added to the visit. It is paid at the exit.') : tr('prk|The car is not inside: the fine comes back with its next visit.'));
    } catch (e) {
      c.fail(req, res, '/admin/parking/violations/new', e);
    }
  });
  router.get('/parking/violations/:id', (req, res, next) => {
    const v = db.get('SELECT v.*, t.name tname, t.name_ar tname_ar, b.code bay_code, u.name user_name FROM pk_violations v LEFT JOIN pk_violation_types t ON t.id = v.type_id LEFT JOIN pk_bays b ON b.id = v.bay_id LEFT JOIN users u ON u.id = v.user_id WHERE v.id = ?', h.int(req.params.id));
    if (!v) return next();
    const csrf = req.session.csrf;
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('prk|What'))}</dt><dd><b>${esc(isAr() && v.tname_ar ? v.tname_ar : tx(v.tname || ''))}</b></dd></div>
      <div><dt>${esc(tr('prk|Plate'))}</dt><dd>${c.plate(v.plate, 'pk-plate--sm')}</dd></div>
      <div><dt>${esc(tr('prk|Where'))}</dt><dd>${v.bay_code ? `<a href="/admin/parking/floor?level=${esc(v.bay_code.split('-')[0])}&bay=${esc(v.bay_code)}">${esc(v.bay_code)}</a>` : esc(v.place || '—')}</dd></div>
      <div><dt>${esc(tr('prk|When'))}</dt><dd>${esc(ui.dt(v.at))}${v.user_name ? ` · ${esc(v.user_name)}` : ''}</dd></div>
      <div><dt>${esc(tr('prk|Amount'))}</dt><dd><b>${c.money(v.fine)}</b></dd></div>
      <div><dt>${esc(tr('Status'))}</dt><dd>${vBadge(v.status)}</dd></div>
      ${v.charged_session_id ? `<div><dt>${esc(tr('prk|Visit'))}</dt><dd><a href="/admin/parking/visits/${v.charged_session_id}">${esc(db.value('SELECT ref FROM pk_sessions WHERE id = ?', v.charged_session_id) || '')}</a></dd></div>` : ''}
      ${v.note ? `<div><dt>${esc(tr('prk|Notes'))}</dt><dd>${esc(v.note)}</dd></div>` : ''}
      ${v.resolution ? `<div><dt>${esc(tr('prk|Outcome'))}</dt><dd>${esc(v.resolution)}</dd></div>` : ''}</dl>`;
    const acts = h.can(req, 'manager') && ['charged', 'unpaid', 'disputed'].includes(v.status)
      ? ui.form(`/admin/parking/violations/${v.id}/resolve`, csrf, `<div class="fields">${ui.select('status', tr('prk|Outcome'), [['waived', tr('prk|Waive the fine')], ...(v.status !== 'disputed' ? [['disputed', tr('prk|The driver disputes it')]] : [])], 'waived')}${ui.input('reason', tr('prk|Why'), '', { required: true })}</div>${ui.btn(esc(tr('Save')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })
      : '';
    c.page(req, res, { title: v.ref, crumbs: c.crumbs(['/admin/parking/violations', tr('prk|Fines')], [null, v.ref]), body: `${head('/admin/parking/violations')}<div class="grid grid--side"><div class="stack">${ui.card(v.ref, facts)}${vDocs(req, 'pk_violation', v.id, { title: tr('prk|Photos') })}</div><div class="stack">${acts ? ui.card(tr('prk|Decide'), acts) : ''}</div></div>` });
  });
  router.post('/parking/violations/:id/resolve', c.RM, (req, res, next) => {
    const v = db.get('SELECT * FROM pk_violations WHERE id = ?', h.int(req.params.id));
    if (!v) return next();
    const reason = h.str(req.body.reason, 300);
    if (!reason) return c.back(req, res, `/admin/parking/violations/${v.id}`, 'error', tr('prk|Say why.'));
    const status = req.body.status === 'disputed' ? 'disputed' : 'waived';
    if (status === 'disputed') db.run("UPDATE pk_violations SET status = 'disputed', resolution = ? WHERE id = ?", reason, v.id);
    else waive(v, { reason, user: req.user });
    h.log(req, status === 'waived' ? 'Waived a parking fine' : 'Parking fine disputed', 'pk_violation', v.id, `${v.ref} · ${reason}`);
    c.back(req, res, `/admin/parking/violations/${v.id}`, 'ok', tr('Saved.'));
  });
  router.post('/parking/violation-types', c.RM, (req, res) => {
    for (const t of db.all('SELECT * FROM pk_violation_types')) {
      const f = req.body[`fine_${t.id}`];
      if (f !== undefined && f !== '') db.run('UPDATE pk_violation_types SET fine = ?, active = ? WHERE id = ?', Math.max(0, Number(f) || 0), req.body[`active_${t.id}`] === '1' ? 1 : 0, t.id);
    }
    const name = h.str(req.body.new_name, 80);
    if (name) db.run('INSERT INTO pk_violation_types (code, name, name_ar, fine) VALUES (?, ?, ?, ?)', `T${Date.now().toString(36).toUpperCase()}`, name, h.str(req.body.new_name_ar, 80) || null, Math.max(0, h.numv(req.body.new_fine) || 0));
    h.log(req, 'Changed the parking fines', 'pk_violation_type', null, '');
    c.back(req, res, '/admin/parking/setup', 'ok', tr('Saved.'));
  });
  // the fines card on the set-up page
  h.parkingSetupCards = h.parkingSetupCards || [];
  h.parkingSetupCards.push((req) => ui.card(tr('prk|Fines'), h.can(req, 'manager') ? ui.form('/admin/parking/violation-types', req.session.csrf, `<div class="tablewrap"><table class="table"><tbody>${db.all('SELECT * FROM pk_violation_types ORDER BY id').map((t) => `<tr><td>${esc(typeName(t))}</td><td class="num"><input class="pk-num" type="number" min="0" step="1" name="fine_${t.id}" value="${t.fine}" aria-label="${esc(tr('prk|Amount'))}"></td><td><label class="check"><input type="checkbox" name="active_${t.id}" value="1"${t.active ? ' checked' : ''}> ${esc(tr('prk|In use'))}</label></td></tr>`).join('')}</tbody></table></div>
      <div class="fields">${ui.input('new_name', tr('prk|Another kind of fine'), '', { placeholder: tr('prk|e.g. Smoking in the car park') })}${ui.input('new_name_ar', tr('prk|Name in Arabic'), '', { attrs: { dir: 'rtl' } })}${ui.input('new_fine', tr('prk|Amount'), '', { type: 'number', min: 0, step: 1 })}</div>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : `<ul class="list pk-list">${types().map((t) => `<li><span class="what"><b>${esc(typeName(t))}</b></span><b>${c.money(t.fine)}</b></li>`).join('')}</ul>`, { sub: esc(tr('prk|What each fine costs.')) }));

  // ================= incidents =================
  const incidentBy = (id) => db.get('SELECT i.*, z.code zone_code, b.code bay_code, u.name assigned_name FROM pk_incidents i LEFT JOIN pk_zones z ON z.id = i.zone_id LEFT JOIN pk_bays b ON b.id = i.bay_id LEFT JOIN users u ON u.id = i.assigned_to WHERE i.id = ?', id);
  router.get('/parking/incidents', (req, res) => {
    const status = I_STATUS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'open';
    const where = status === 'all' ? "i.kind NOT IN ('lost','found')" : status === 'open' ? "i.kind NOT IN ('lost','found') AND i.status IN ('open','investigating')" : "i.kind NOT IN ('lost','found') AND i.status = ?";
    const rows = db.all(`SELECT i.*, b.code bay_code, z.code zone_code FROM pk_incidents i LEFT JOIN pk_bays b ON b.id = i.bay_id LEFT JOIN pk_zones z ON z.id = i.zone_id WHERE ${where} ORDER BY i.at DESC LIMIT 200`, ...(['all', 'open'].includes(status) ? [] : [status]));
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const by = db.all("SELECT kind, COUNT(*) n FROM pk_incidents WHERE at >= ? AND kind NOT IN ('lost','found') GROUP BY kind ORDER BY n DESC", since);
    const kpis = [
      ui.kpi({ label: tr('prk|Open'), value: ui.n0(db.value("SELECT COUNT(*) FROM pk_incidents WHERE status IN ('open','investigating') AND kind NOT IN ('lost','found')")) }),
      ui.kpi({ label: tr('prk|Last 30 days'), value: ui.n0(by.reduce((s, x) => s + x.n, 0)), sub: esc(by.slice(0, 3).map((x) => `${tr(I_KINDS[x.kind])} ${x.n}`).join(' · ')) }),
      ui.kpi({ label: tr('prk|Items found, not returned'), value: ui.n0(db.value("SELECT COUNT(*) FROM pk_incidents WHERE kind = 'found' AND returned_at IS NULL AND status != 'closed'")), href: '/admin/parking/lost' }),
    ].join('');
    const table = ui.table([
      { label: tr('prk|Incident'), render: (i) => `<b>${esc(i.title)}</b><small class="sub">${esc(i.ref)} · ${esc(tr(I_KINDS[i.kind] || i.kind))}</small>` },
      { label: tr('prk|When'), render: (i) => esc(ui.dt(i.at)) },
      { label: tr('prk|Where'), render: (i) => esc(i.bay_code || [i.zone_code, i.place].filter(Boolean).join(' · ') || '—') },
      { label: tr('prk|Plates'), render: (i) => (i.plates ? `<bdi>${esc(i.plates)}</bdi>` : '—') },
      { label: tr('Status'), render: (i) => iBadge(i.status) },
    ], rows, { href: (i) => `/admin/parking/incidents/${i.id}`, empty: esc(tr('prk|No incidents.')) });
    const filters = `<form method="get" class="filters">${ui.select('status', tr('Status'), [['open', tr('prk|Not finished')], ...c.tmap(I_STATUS), ['all', tr('prk|All')]], status)}${ui.btn(esc(tr('prk|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    c.page(req, res, { title: tr('prk|Incidents'), crumbs: c.crumbs([null, tr('prk|Incidents')]), actions: h.can(req, 'agent') ? ui.btn(esc(tr('prk|Report an incident')), { href: '/admin/parking/incidents/new', cls: 'btn--primary', ic: 'plus' }) : '', body: `${head('/admin/parking/incidents')}<div class="kpis kpis--3">${kpis}</div>${filters}${ui.card(tr('prk|Incidents'), table)}` });
  });
  router.get('/parking/incidents/new', c.RA, (req, res) => {
    const kind = I_KINDS[req.query.kind] ? req.query.kind : 'accident';
    const bay = bayBy(req.query.bay);
    const local = ui.local(new Date().toISOString()).slice(0, 16);
    const form = ui.form('/admin/parking/incidents', req.session.csrf, `<div class="fields">
      ${ui.select('kind', tr('prk|What happened'), c.tmap(I_KINDS), kind)}
      ${ui.input('title', tr('prk|In a few words'), '', { required: true, placeholder: tr('prk|e.g. Two cars touched on the B2 ramp') })}
      ${ui.input('at', tr('prk|When'), local, { type: 'datetime-local', required: true })}
      ${ui.select('zone_id', tr('prk|Level'), zoneOpts(), bay ? bay.zone_id : '', { blank: tr('prk|Not on a level') })}
      ${ui.input('bay', tr('prk|Bay'), bay ? bay.code : '', { placeholder: 'B1-A07' })}
      ${ui.input('place', tr('prk|Or where'), '', { placeholder: tr('prk|e.g. Pay machine by the lifts') })}
      ${ui.input('plates', tr('prk|Plates involved'), h.str(req.query.plate, 30), { placeholder: 'ق ص ر 1234، س ع د 777' })}
      ${ui.input('reporter_name', tr('prk|Reported by'), '')}
      ${ui.input('reporter_phone', tr('prk|Their mobile'), '', { type: 'tel' })}
      ${ui.input('item', tr('prk|Item (lost or found)'), '', { placeholder: tr('prk|e.g. Black wallet, car keys') })}
      ${ui.input('value', tr('prk|Estimated value'), '', { type: 'number', min: 0, step: 1 })}
      ${ui.textarea('description', tr('prk|What happened'), '', { rows: 4, cls: 'span-all' })}</div>${ui.btn(esc(tr('prk|Report')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    c.page(req, res, { title: tr('prk|Report an incident'), crumbs: c.crumbs(['/admin/parking/incidents', tr('prk|Incidents')], [null, tr('prk|New')]), body: `${head(kind === 'lost' || kind === 'found' ? '/admin/parking/lost' : '/admin/parking/incidents')}${ui.card(tr('prk|Report an incident'), form, { sub: esc(tr('prk|Add photos on the next page. The cars involved are linked to their visits and entry camera pictures.')) })}` });
  });
  // a Cairo-local "2026-10-28T14:30" to UTC
  const fromLocal = (v) => {
    const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
    if (!m) return now();
    for (const off of [2, 3]) {
      const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) - off * 3600000;
      if (ui.local(new Date(t).toISOString()).slice(0, 16) === v) return new Date(t).toISOString();
    }
    return new Date(Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) - 2 * 3600000).toISOString();
  };
  function report(v, { user = null, demo = 0 } = {}) {
    const plates = P.platesOf(v.plates);
    const keys = plates.map(P.plateKey).filter(Boolean);
    const at = v.at || now();
    // the first car involved: its visit inside, or one that left in the last day
    const s = keys.length ? (P.findInside({ plate: keys[0] }) || db.get('SELECT * FROM pk_sessions WHERE plate_key = ? AND entry_at <= ? AND (exit_at IS NULL OR exit_at >= ?) ORDER BY entry_at DESC LIMIT 1', keys[0], at, new Date(Date.parse(at) - 86400000).toISOString())) : null;
    const bay = v.bay ? bayBy(v.bay) : null;
    const t = now();
    const id = Number(db.run(`INSERT INTO pk_incidents (ref, kind, title, at, zone_id, bay_id, place, plates, session_id, reporter_name, reporter_phone, description, item, value, status, user_id, demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`, db.nextRef('pk_incidents', 'PI', 5, true), I_KINDS[v.kind] ? v.kind : 'other', v.title, at,
    bay ? bay.zone_id : v.zone_id || null, bay ? bay.id : null, v.place || null, plates.map(P.plateShow).join('، ') || null, s ? s.id : null, v.reporter_name || null, v.reporter_phone || null,
    v.description || null, v.item || null, v.value || null, user ? user.id : null, demo ? 1 : 0, t, t).lastInsertRowid);
    return incidentBy(id);
  }
  h.parking.report = report;
  router.post('/parking/incidents', c.RA, (req, res) => {
    const title = h.str(req.body.title, 160);
    if (!title) return c.back(req, res, '/admin/parking/incidents/new', 'error', tr('prk|Say in a few words what happened.'));
    if (req.body.bay && !bayBy(req.body.bay)) return c.back(req, res, '/admin/parking/incidents/new', 'error', tr('prk|There is no bay {code}.', { code: h.str(req.body.bay, 20) }));
    const i = report({
      kind: req.body.kind, title, at: fromLocal(req.body.at), zone_id: h.int(req.body.zone_id), bay: h.str(req.body.bay, 20) || null, place: h.str(req.body.place, 80), plates: h.str(req.body.plates, 200),
      reporter_name: h.str(req.body.reporter_name, 80), reporter_phone: h.str(req.body.reporter_phone, 30), description: h.str(req.body.description, 4000), item: h.str(req.body.item, 160), value: h.numv(req.body.value),
    }, { user: req.user });
    h.log(req, 'Reported a car park incident', 'pk_incident', i.id, `${i.ref} · ${title}`);
    c.back(req, res, `/admin/parking/incidents/${i.id}`, 'ok', tr('prk|Incident {ref} recorded.', { ref: i.ref }));
  });
  router.get('/parking/incidents/:id', (req, res, next) => {
    const i = incidentBy(h.int(req.params.id));
    if (!i) return next();
    const csrf = req.session.csrf;
    const s = i.session_id ? P.sessionBy(i.session_id) : null;
    const notes = db.all('SELECT n.*, u.name user_name FROM pk_incident_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.incident_id = ? ORDER BY n.at', i.id);
    const lostFound = i.kind === 'lost' || i.kind === 'found';
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('prk|What happened'))}</dt><dd>${esc(tr(I_KINDS[i.kind] || i.kind))}</dd></div>
      <div><dt>${esc(tr('prk|When'))}</dt><dd>${esc(ui.dt(i.at))}</dd></div>
      <div><dt>${esc(tr('prk|Where'))}</dt><dd>${i.bay_code ? `<a href="/admin/parking/floor?level=${esc(i.bay_code.split('-')[0])}&bay=${esc(i.bay_code)}">${esc(i.bay_code)}</a>` : esc([i.zone_code, i.place].filter(Boolean).join(' · ') || '—')}</dd></div>
      ${i.plates ? `<div><dt>${esc(tr('prk|Plates involved'))}</dt><dd><bdi>${esc(i.plates)}</bdi></dd></div>` : ''}
      ${s ? `<div><dt>${esc(tr('prk|Visit'))}</dt><dd><a href="/admin/parking/visits/${s.id}">${esc(s.ref)}</a> · ${esc(tr('prk|in at {time}', { time: ui.dt(s.entry_at) }))}${s.photo_url && /^https:\/\//.test(s.photo_url) ? ` · <a href="${esc(s.photo_url)}" target="_blank" rel="noopener noreferrer">${esc(tr('prk|Entry camera picture'))}</a>` : ''}</dd></div>` : ''}
      ${i.reporter_name || i.reporter_phone ? `<div><dt>${esc(tr('prk|Reported by'))}</dt><dd>${esc([i.reporter_name, i.reporter_phone].filter(Boolean).join(' · '))}</dd></div>` : ''}
      ${i.item ? `<div><dt>${esc(tr('prk|Item'))}</dt><dd>${esc(i.item)}${i.stored_at ? ` · ${esc(tr('prk|kept at {place}', { place: i.stored_at }))}` : ''}</dd></div>` : ''}
      ${i.returned_to ? `<div><dt>${esc(tr('prk|Returned to'))}</dt><dd>${esc(i.returned_to)} · ${esc(ui.dt(i.returned_at))}</dd></div>` : ''}
      ${i.value ? `<div><dt>${esc(tr('prk|Estimated value'))}</dt><dd>${c.money(i.value)}</dd></div>` : ''}
      ${i.claim_ref ? `<div><dt>${esc(tr('prk|Insurance claim'))}</dt><dd>${esc(i.claim_ref)}</dd></div>` : ''}
      <div><dt>${esc(tr('prk|Handled by'))}</dt><dd>${esc(i.assigned_name || '—')}</dd></div>
      ${i.description ? `<div><dt>${esc(tr('prk|Details'))}</dt><dd>${esc(i.description)}</dd></div>` : ''}
      ${i.resolution ? `<div><dt>${esc(tr('prk|Outcome'))}</dt><dd>${esc(i.resolution)}</dd></div>` : ''}</dl>`;
    const timeline = notes.length ? `<ul class="list pk-list">${notes.map((n) => `<li><span class="what"><b>${esc(n.body)}</b><small>${esc([n.user_name, ui.dt(n.at), n.status_to ? tr((I_STATUS[n.status_to] || [n.status_to])[0]) : null].filter(Boolean).join(' · '))}</small></span></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|No notes yet.'))}</p>`;
    const update = h.can(req, 'agent') ? ui.form(`/admin/parking/incidents/${i.id}/note`, csrf, `<div class="fields">${ui.select('status', tr('Status'), c.tmap(I_STATUS), i.status)}${ui.select('assigned_to', tr('prk|Handled by'), h.users().map((u) => [u.id, u.name]), i.assigned_to || '', { blank: tr('prk|Nobody yet') })}
      ${ui.input('claim_ref', tr('prk|Insurance claim'), i.claim_ref || '')}${lostFound ? `${ui.input('stored_at', tr('prk|Kept at'), i.stored_at || '', { placeholder: tr('prk|e.g. Security office, shelf 2') })}${ui.input('returned_to', tr('prk|Returned to (name and ID)'), i.returned_to || '')}` : ''}
      ${ui.textarea('body', tr('prk|Note'), '', { rows: 3, cls: 'span-all' })}${ui.textarea('resolution', tr('prk|Outcome'), i.resolution || '', { rows: 2, cls: 'span-all' })}</div>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    c.page(req, res, { title: i.title, crumbs: c.crumbs([lostFound ? '/admin/parking/lost' : '/admin/parking/incidents', tr(lostFound ? 'prk|Lost and found' : 'prk|Incidents')], [null, i.ref]), body: `${head(lostFound ? '/admin/parking/lost' : '/admin/parking/incidents')}<div class="grid grid--side"><div class="stack">${ui.card(i.ref, facts, { action: iBadge(i.status) })}${iDocs(req, 'pk_incident', i.id, { title: tr('prk|Photos and papers') })}${ui.card(tr('prk|Notes'), timeline)}</div><div class="stack">${update ? ui.card(tr('prk|Update'), update) : ''}</div></div>` });
  });
  router.post('/parking/incidents/:id/note', c.RA, (req, res, next) => {
    const i = incidentBy(h.int(req.params.id));
    if (!i) return next();
    const status = I_STATUS[req.body.status] ? req.body.status : i.status;
    const body = h.str(req.body.body, 2000);
    const returnedTo = h.str(req.body.returned_to, 160) || null;
    db.tx(() => {
      db.run(`UPDATE pk_incidents SET status = ?, assigned_to = ?, claim_ref = ?, resolution = ?, stored_at = COALESCE(?, stored_at), returned_to = ?, returned_at = CASE WHEN ? IS NOT NULL AND returned_at IS NULL THEN ? ELSE returned_at END, updated_at = ? WHERE id = ?`,
        status, h.int(req.body.assigned_to), h.str(req.body.claim_ref, 80) || null, h.str(req.body.resolution, 2000) || null, h.str(req.body.stored_at, 120) || null, returnedTo, returnedTo, now(), now(), i.id);
      if (body || status !== i.status) db.run('INSERT INTO pk_incident_notes (incident_id, body, status_to, user_id, at) VALUES (?, ?, ?, ?, ?)', i.id, body || tr((I_STATUS[status] || [status])[0]), status !== i.status ? status : null, req.user.id, now());
    });
    h.log(req, 'Updated a car park incident', 'pk_incident', i.id, `${i.ref} · ${status}`);
    c.back(req, res, `/admin/parking/incidents/${i.id}`, 'ok', tr('Saved.'));
  });

  // ================= lost and found =================
  router.get('/parking/lost', (req, res) => {
    const rows = db.all("SELECT * FROM pk_incidents WHERE kind IN ('lost','found') ORDER BY CASE WHEN status IN ('open','investigating') THEN 0 ELSE 1 END, at DESC LIMIT 200");
    const table = ui.table([
      { label: tr('prk|Item'), render: (i) => `<b>${esc((i.item || i.title))}</b><small class="sub">${esc(i.ref)} · ${esc(tr(I_KINDS[i.kind]))}</small>` },
      { label: tr('prk|When'), render: (i) => esc(ui.dt(i.at)) },
      { label: tr('prk|Kept at'), render: (i) => esc(i.stored_at ? i.stored_at : '—') },
      { label: tr('prk|Returned to'), render: (i) => esc(i.returned_to || '—') },
      { label: tr('Status'), render: (i) => iBadge(i.status) },
    ], rows, { href: (i) => `/admin/parking/incidents/${i.id}`, empty: esc(tr('prk|Nothing lost or found.')) });
    const actions = h.can(req, 'agent') ? `${ui.btn(esc(tr('prk|An item was found')), { href: '/admin/parking/incidents/new?kind=found', cls: 'btn--primary', ic: 'plus' })}${ui.btn(esc(tr('prk|A visitor lost something')), { href: '/admin/parking/incidents/new?kind=lost', cls: 'btn--ghost' })}` : '';
    c.page(req, res, { title: tr('prk|Lost and found'), crumbs: c.crumbs([null, tr('prk|Lost and found')]), actions, body: `${head('/admin/parking/lost')}${ui.card(tr('prk|Lost and found'), table, { sub: esc(tr('prk|Write down who an item is returned to, with their ID.')) })}` });
  });

};

module.exports.I_KINDS = I_KINDS;
module.exports.V_STATUS = V_STATUS;
module.exports.I_STATUS = I_STATUS;
