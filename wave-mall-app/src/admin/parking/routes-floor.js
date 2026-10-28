'use strict';

// The live floor plans of the parking levels (/admin/parking/floor): every bay, free or taken, held
// for a booking, out of service; accessible, electric, VIP, bookable and valet bays; fines flagged.
// The page updates itself every 15 seconds. Bay sensors report to /ingest/parking/bays.

const { t: tr, tx, isAr } = require('../i18n');
const F = require('./floor');

const KINDS = { general: 'prk|Ordinary', accessible: 'prk|Accessible', ev: 'prk|Electric cars', vip: 'prk|VIP', reserved: 'prk|For bookings', valet: 'prk|Valet' };
const STATES = { free: 'prk|Space free', taken: 'prk|Space taken', held: 'prk|Held for a booking', off: 'prk|Out of service' };

module.exports = function floorRoutes(router, h, c) {
  const { db, ui } = h;
  const { P, esc } = c;
  const now = () => new Date().toISOString();

  // every level gets its bays; a level whose spaces changed is redrawn (bay types are kept)
  const levels = () => {
    const zs = P.zones().filter((z) => z.capacity > 0);
    for (const z of zs) if (db.value('SELECT COUNT(*) FROM pk_bays WHERE zone_id = ?', z.id) !== Math.min(z.capacity, F.layout(z, z.capacity).length)) F.drawBays(db, z);
    return zs;
  };
  levels();
  const zoneBy = (code) => P.zones().find((z) => z.code === String(code || '').toUpperCase());
  const labels = () => ({
    lifts: tr('prk|Lifts'), rampUp: tr('prk|Up to'), rampDown: tr('prk|Down to'), street: tr('prk|To the street'),
    states: Object.fromEntries(Object.entries(STATES).map(([k, v]) => [k, tr(v)])), kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, tr(v)])),
    estimated: tr('prk|estimated'),
  });
  const live = (z) => {
    const o = P.occupancy();
    const lz = o.zones.find((x) => x.id === z.id);
    return F.states(db, z, { cars: lz ? lz.cars : 0 });
  };
  const MODE = { sensors: ['prk|Bay sensors', 'ok'], mixed: ['prk|Some bays have sensors', 'sky'], estimate: ['prk|Estimated', 'amber'] };

  router.get('/parking/floor', (req, res) => {
    const zs = levels();
    const z = zoneBy(req.query.level) || zs[0];
    if (!z) return c.page(req, res, { title: tr('prk|Floor'), crumbs: c.crumbs([null, tr('prk|Floor')]), body: `${c.tabs('/admin/parking/floor')}${ui.empty(tr('prk|Add the car park levels in Set-up.'))}` });
    const st = live(z);
    const sel = req.query.bay ? st.bays.find((b) => b.code === String(req.query.bay).toUpperCase()) : null;
    const [modeLabel, modeTone] = MODE[st.mode];
    const kpis = [
      ui.kpi({ label: tr('prk|Space taken'), value: `<span data-count="taken">${ui.n0(st.counts.taken)}</span><small> / ${ui.n0(st.bays.length)}</small>`, bar: st.bays.length ? st.counts.taken / st.bays.length : null }),
      ui.kpi({ label: tr('prk|Space free'), value: `<span data-count="free">${ui.n0(st.counts.free)}</span>` }),
      ui.kpi({ label: tr('prk|Held for bookings'), value: `<span data-count="held">${ui.n0(st.counts.held)}</span>` }),
      ui.kpi({ label: tr('prk|Out of service'), value: `<span data-count="off">${ui.n0(st.counts.off)}</span>` }),
    ].join('');
    const legend = `<ul class="legend legend--row pkf-legend">
      <li><i class="pkf-sw s-free"></i><span>${esc(tr('prk|Space free'))}</span></li><li><i class="pkf-sw s-taken"></i><span>${esc(tr('prk|Space taken'))}</span></li>
      <li><i class="pkf-sw s-taken is-est"></i><span>${esc(tr('prk|Probably taken'))}</span></li><li><i class="pkf-sw s-held"></i><span>${esc(tr('prk|Held for a booking'))}</span></li>
      <li><i class="pkf-sw s-off"></i><span>${esc(tr('prk|Out of service'))}</span></li>
      <li><b>♿</b><span>${esc(tr('prk|Accessible'))}</span></li><li><b>⚡</b><span>${esc(tr('prk|Electric cars'))}</span></li><li><b>★</b><span>${esc(tr('prk|VIP'))}</span></li>
      <li><b>R</b><span>${esc(tr('prk|For bookings'))}</span></li><li><b>V</b><span>${esc(tr('prk|Valet'))}</span></li><li><i class="pkf-sw pkf-sw--viol"></i><span>${esc(tr('prk|Fine in the last day'))}</span></li></ul>`;
    const map = `<div class="pkf-wrap" data-floor="/admin/parking/floor.json?level=${esc(z.code)}" data-floor-base="/admin/parking/floor?level=${esc(z.code)}">${F.svg(z, st.bays, { labels: labels(), selected: sel ? sel.code : null })}</div>`;
    const explain = st.mode === 'sensors'
      ? tr('prk|Every bay reports from its sensor.')
      : tr('prk|Without bay sensors, cars counted on this level fill the bays nearest the lifts first, as drivers do. Bookings and valet cars are shown where they really are.');
    const panel = sel ? bayPanel(req, z, sel) : ui.card(tr('prk|A bay'), `<p class="muted">${esc(tr('prk|Choose a bay on the plan to see what is there, report a fine or change its type.'))}</p>`);
    const levelTabs = c.subtabs(`/admin/parking/floor?level=${z.code}`, zs.map((x) => [`/admin/parking/floor?level=${x.code}`, x.code]));
    const body = `${c.tabs('/admin/parking/floor')}${levelTabs}
<div class="kpis kpis--4">${kpis}</div>
<div class="grid pkf-grid">
  ${ui.card(`${c.zoneName(z)} · ${z.code}`, `${map}${legend}`, { sub: `${ui.badge(st.mode, tr(modeLabel), modeTone)} <span class="muted">${esc(explain)}</span>`, action: `<span class="pk-live">${esc(tr('prk|Live'))}</span>` })}
  <div class="stack">${panel}</div>
</div>`;
    c.page(req, res, { title: tr('prk|Floor'), crumbs: c.crumbs([null, tr('prk|Floor')]), body });
  });

  function bayPanel(req, z, b) {
    const mgr = h.can(req, 'manager');
    const csrf = req.session.csrf;
    const s = b.session ? P.sessionBy(b.session) : null;
    const viol = db.all("SELECT v.*, t.name tname, t.name_ar tname_ar FROM pk_violations v LEFT JOIN pk_violation_types t ON t.id = v.type_id WHERE v.bay_id = ? ORDER BY v.at DESC LIMIT 5", b.id);
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('prk|State'))}</dt><dd>${ui.badge(b.state, tr(STATES[b.state] || b.state), { free: 'ok', taken: 'mute', held: 'amber', off: 'rose' }[b.state])}${b.why === 'estimate' && b.state === 'taken' ? ` <small class="muted">${esc(tr('prk|estimated'))}</small>` : ''}${b.why === 'sensor' ? ` <small class="muted">${esc(tr('prk|from its sensor'))}</small>` : ''}</dd></div>
      <div><dt>${esc(tr('prk|Type'))}</dt><dd>${esc(tr(KINDS[b.kind] || b.kind))}</dd></div>
      ${b.plate ? `<div><dt>${esc(tr('prk|Plate'))}</dt><dd>${c.plate(b.plate, 'pk-plate--sm')}</dd></div>` : ''}
      ${s ? `<div><dt>${esc(tr('prk|Visit'))}</dt><dd><a href="/admin/parking/visits/${s.id}">${esc(s.ref)}</a> · ${esc(c.dur(c.minutesOf(s)))}</dd></div>` : ''}
      ${b.valet ? `<div><dt>${esc(tr('prk|Valet'))}</dt><dd><a href="/admin/parking/valet/${b.valet}">${esc(tr('prk|Key tag {n}', { n: b.tag }))}</a></dd></div>` : ''}
      ${b.booking ? `<div><dt>${esc(tr('prk|Booking'))}</dt><dd><a href="/admin/parking/bookings/${b.booking.id}">${esc(b.booking.ref)}</a> · ${esc(ui.local(b.booking.starts_at).slice(11, 16))}–${esc(ui.local(b.booking.ends_at).slice(11, 16))}</dd></div>` : ''}
      ${b.sensor ? `<div><dt>${esc(tr('prk|Sensor'))}</dt><dd><span class="ltr">${esc(b.sensor)}</span>${b.state_at ? ` · ${esc(ui.local(b.state_at).slice(11, 16))}` : ''}</dd></div>` : ''}</dl>`;
    const fines = viol.length ? `<ul class="list pk-list">${viol.map((v) => `<li><a href="/admin/parking/violations/${v.id}"><span class="what"><b>${esc(isAr() && v.tname_ar ? v.tname_ar : tx(v.tname || ''))}</b><small><bdi>${esc(v.plate || '')}</bdi> · ${esc(ui.dt(v.at))}</small></span><b>${c.money(v.fine)}</b></a></li>`).join('')}</ul>` : '';
    const acts = h.can(req, 'agent') ? `<div class="row">${ui.btn(esc(tr('prk|Report a fine here')), { href: `/admin/parking/violations/new?bay=${encodeURIComponent(b.code)}${b.plate ? `&plate=${encodeURIComponent(b.plate)}` : ''}`, cls: 'btn--ghost btn--sm', ic: 'shield' })}${ui.btn(esc(tr('prk|Report an incident here')), { href: `/admin/parking/incidents/new?bay=${encodeURIComponent(b.code)}`, cls: 'btn--ghost btn--sm', ic: 'log' })}</div>` : '';
    const edit = mgr ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${esc(tr('prk|Change this bay'))}</span></summary>${ui.form(`/admin/parking/bays/${encodeURIComponent(b.code)}`, csrf, `<div class="fields">${ui.select('kind', tr('prk|Type'), c.tmap(KINDS), b.kind)}${ui.input('sensor', tr('prk|Sensor ID'), b.sensor || '', { placeholder: 'S-B1-001', attrs: { autocomplete: 'off' } })}</div><label class="check"><input type="checkbox" name="active" value="1"${b.active ? ' checked' : ''}> ${esc(tr('prk|In service'))}</label>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    return ui.card(tr('prk|Bay {code}', { code: b.code }), `${facts}${fines}${acts}${edit}`, { action: `<a class="iconbtn" href="/admin/parking/floor?level=${esc(z.code)}" aria-label="${esc(tr('mob|Close'))}">${ui.icon('x')}</a>` });
  }

  router.get('/parking/floor.json', (req, res) => {
    const z = zoneBy(req.query.level) || levels()[0];
    if (!z) return res.json({ ok: false });
    const st = live(z);
    const L = labels();
    res.json({
      ok: true, mode: st.mode, counts: st.counts,
      bays: st.bays.map((b) => [b.code, b.state, b.why === 'estimate' && b.state === 'taken' ? 1 : 0, b.violation ? 1 : 0, [b.code, L.states[b.state], b.kind !== 'general' ? L.kinds[b.kind] : null, b.plate].filter(Boolean).join(' · ')]),
    });
  });

  router.post('/parking/bays/:code', c.RM, (req, res, next) => {
    const b = db.get('SELECT b.*, z.code zone FROM pk_bays b JOIN pk_zones z ON z.id = b.zone_id WHERE b.code = ?', String(req.params.code).toUpperCase());
    if (!b) return next();
    const sensor = h.str(req.body.sensor, 40) || null;
    if (sensor && db.get('SELECT id FROM pk_bays WHERE sensor = ? AND id != ?', sensor, b.id)) return c.back(req, res, `/admin/parking/floor?level=${b.zone}&bay=${b.code}`, 'error', tr('prk|That sensor is already on another bay.'));
    db.run('UPDATE pk_bays SET kind = ?, sensor = ?, active = ? WHERE id = ?', KINDS[req.body.kind] ? req.body.kind : 'general', sensor, req.body.active === '1' ? 1 : 0, b.id);
    h.log(req, 'Changed a parking bay', 'pk_bay', b.id, `${b.code} · ${req.body.kind}${req.body.active === '1' ? '' : ' · out of service'}`);
    c.back(req, res, `/admin/parking/floor?level=${b.zone}&bay=${b.code}`, 'ok', tr('Saved.'));
  });

  // ---------- bay sensors ----------
  // {"bays": [{"bay": "B1-A01" or "sensor": "S-17", "occupied": true, "plate": "…"}]}
  h.parkingApi.post('/bays', (req, res) => {
    const list = Array.isArray(req.body.bays) ? req.body.bays.slice(0, 2000) : [];
    let n = 0;
    const t = now();
    db.tx(() => {
      for (const x of list) {
        if (!x || typeof x !== 'object') continue;
        const b = x.sensor ? db.get('SELECT id FROM pk_bays WHERE sensor = ?', String(x.sensor).slice(0, 40)) : db.get('SELECT id, sensor FROM pk_bays WHERE code = ?', String(x.bay || '').toUpperCase().slice(0, 20));
        if (!b) continue;
        db.run('UPDATE pk_bays SET state = ?, state_at = ?, plate = ?, sensor = COALESCE(sensor, ?) WHERE id = ?', x.occupied ? 'taken' : 'free', t, x.occupied && x.plate ? P.plateShow(String(x.plate).slice(0, 30)) : null, x.sensor ? null : `bay:${String(x.bay).toUpperCase()}`, b.id);
        n++;
      }
    });
    res.json({ ok: true, updated: n });
  });
};

module.exports.KINDS = KINDS;
module.exports.STATES = STATES;
