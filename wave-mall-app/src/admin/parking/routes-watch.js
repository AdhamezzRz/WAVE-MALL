'use strict';

// Security and fraud watch (/admin/parking/watch): what deserves a second look.
//   Alerts      a gate gone quiet, a camera reading few plates, a blocked plate at the gate, a till
//               closed with a big difference, many barriers opened by hand by one person, a plate
//               validated again and again. Checked every ten minutes; security can get them on WhatsApp.
//   Cashiers    per person: payments, barriers opened by hand and what was written off, the mall's
//               validations, lost tickets, till differences, measured against the team.
//   Shops       validations per shop, purchases, missing receipt numbers, against the other shops.
//   Gates       when each was last heard, how many plates its camera read, refusals.

const { t: tr, tn, tx } = require('../i18n');

module.exports = function watchRoutes(router, h, c) {
  const { db, ui } = h;
  const { P, esc } = c;
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const S = (k, d) => (db.setting(k) === undefined || db.setting(k) === null || db.setting(k) === '' ? d : db.setting(k));
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
  };
  const LEVEL = { alarm: ['prk|Urgent', 'rose'], warn: ['prk|Check', 'amber'], info: ['prk|Note', 'sky'] };

  // ---------- alerts ----------
  function raise(kind, key, { level = 'warn', title, detail = null, lane = null, session = null, demo = 0, at = now() }) {
    if (db.get('SELECT id FROM pk_alerts WHERE key = ?', key)) return null;
    const id = Number(db.run('INSERT INTO pk_alerts (kind, level, title, detail, key, lane_id, session_id, at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', kind, level, title, detail, key, lane, session, at, demo ? 1 : 0).lastInsertRowid);
    // urgent ones to security on WhatsApp
    const phone = S('prk_security_phone', '');
    if (level === 'alarm' && phone && !demo && h.whatsapp && h.whatsapp.configured && h.whatsapp.configured()) {
      Promise.resolve(h.whatsapp.sendText(phone, `The Wave parking: ${title}${detail ? `\n${detail}` : ''}`)).catch((e) => console.error('[parking] alert:', e.message));
    }
    return id;
  }
  // Look at the last hours and raise what is new. Returns how many alerts were raised.
  function check({ at = Date.now() } = {}) {
    let n = 0;
    const day = c.cairoDate(new Date(at).toISOString());
    const from = c.dayStart(day);
    const hour = Number(ui.local(new Date(at).toISOString()).slice(11, 13));
    const busy = hour >= 10 || hour < 1;
    // gates gone quiet while the mall is open
    const quiet = Number(S('prk_quiet_min', 30));
    if (busy) {
      for (const l of db.all('SELECT * FROM pk_lanes WHERE active = 1 AND last_seen_at IS NOT NULL')) {
        if (at - Date.parse(l.last_seen_at) > quiet * 60000 && raise('quiet', `quiet:${l.id}:${day}`, { title: `Gate ${l.code} has been quiet for ${Math.round((at - Date.parse(l.last_seen_at)) / 60000)} minutes`, detail: tx(l.name), lane: l.id, level: 'alarm' })) n++;
      }
    }
    // cameras reading few plates
    for (const r of db.all("SELECT entry_lane_id lane, COUNT(*) n, SUM(entry_via = 'anpr') anpr FROM pk_sessions WHERE entry_at >= ? AND entry_lane_id IS NOT NULL GROUP BY entry_lane_id", from)) {
      if (r.n >= 20 && r.anpr / r.n < 0.85) {
        const l = db.get('SELECT * FROM pk_lanes WHERE id = ?', r.lane);
        if (l && raise('readrate', `readrate:${l.id}:${day}`, { title: `The camera at ${l.code} read ${Math.round((r.anpr / r.n) * 100)}% of plates today`, detail: 'Clean the lens or check the lighting.', lane: l.id })) n++;
      }
    }
    // blocked plates at the gate
    for (const e of db.all("SELECT * FROM pk_events WHERE kind = 'deny' AND reason = 'blocked' AND at >= ?", new Date(at - 86400000).toISOString())) {
      if (raise('blocked', `blocked:${e.id}`, { title: `Blocked plate ${e.plate || '—'} at the gate`, detail: ui.local(e.at).slice(11, 16), lane: e.lane_id, level: 'alarm', demo: e.demo, at: e.at })) n++;
    }
    // tills closed with a big difference
    const big = Number(S('prk_till_alert', 50));
    for (const t of db.all("SELECT t.*, u.name user_name FROM pk_tills t LEFT JOIN users u ON u.id = t.user_id WHERE t.status = 'closed' AND ABS(t.difference) >= ? AND t.closed_at >= ?", big, new Date(at - 7 * 86400000).toISOString())) {
      if (raise('till', `till:${t.id}`, { title: t.difference < 0 ? `Till ${t.ref} closed short by ${Math.abs(t.difference)}` : `Till ${t.ref} closed over by ${t.difference}`, detail: t.user_name || null, demo: t.demo, at: t.closed_at })) n++;
    }
    // many barriers opened by hand by one person today
    for (const r of db.all("SELECT e.user_id, u.name, COUNT(*) n, COALESCE(SUM(e.amount), 0) amount FROM pk_events e JOIN users u ON u.id = e.user_id WHERE e.kind = 'manual' AND e.at >= ? GROUP BY e.user_id HAVING n >= 3", from)) {
      if (raise('manual', `manual:${r.user_id}:${day}`, { title: `${r.name} opened the barrier by hand ${r.n} times today`, detail: `Written off: ${r2(r.amount)}` })) n++;
    }
    // a plate validated again and again
    const month = day.slice(0, 7);
    for (const r of db.all("SELECT s.plate_key, s.plate, COUNT(*) n FROM pk_validations v JOIN pk_sessions s ON s.id = v.session_id WHERE v.status = 'ok' AND v.at >= ? AND s.plate_key IS NOT NULL GROUP BY s.plate_key HAVING n >= 6", new Date(at - 30 * 86400000).toISOString())) {
      if (raise('repeat', `repeat:${r.plate_key}:${month}`, { title: `Plate ${r.plate} was validated ${r.n} times in 30 days`, level: 'info' })) n++;
    }
    return n;
  }
  h.every('parking-watch', 10 * 60 * 1000, () => check());
  h.parking.watch = { check, raise };

  // ---------- the page ----------
  router.get('/parking/watch', (req, res) => {
    check();
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const csrf = req.session.csrf;
    const alerts = db.all('SELECT * FROM pk_alerts WHERE acked_at IS NULL ORDER BY at DESC LIMIT 40');
    const alertList = alerts.length ? `<ul class="list pk-list">${alerts.map((a) => `<li><span class="what"><b>${esc(tx(a.title))}</b><small>${esc([ui.dt(a.at), a.detail ? tx(a.detail) : null].filter(Boolean).join(' · '))}</small></span>${ui.badge(a.level, tr((LEVEL[a.level] || [a.level])[0]), (LEVEL[a.level] || [])[1])}${h.can(req, 'agent') ? ui.form(`/admin/parking/alerts/${a.id}/ack`, csrf, `<button class="btn btn--ghost btn--xs">${esc(tr('prk|Seen'))}</button>`) : ''}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|Nothing needs a second look.'))}</p>`;

    // cashiers
    const people = db.all(`SELECT u.id, u.name,
      (SELECT COUNT(*) FROM pk_payments p WHERE p.user_id = u.id AND p.at >= ? AND p.status = 'ok') pays,
      (SELECT COALESCE(SUM(amount), 0) FROM pk_payments p WHERE p.user_id = u.id AND p.at >= ? AND p.status = 'ok') taken,
      (SELECT COUNT(*) FROM pk_events e WHERE e.user_id = u.id AND e.kind = 'manual' AND e.at >= ?) manual,
      (SELECT COALESCE(SUM(amount), 0) FROM pk_events e WHERE e.user_id = u.id AND e.kind = 'manual' AND e.at >= ?) written,
      (SELECT COUNT(*) FROM pk_validations v WHERE v.user_id = u.id AND v.brand_id IS NULL AND v.at >= ?) mallvals,
      (SELECT COUNT(*) FROM pk_events e WHERE e.user_id = u.id AND e.kind = 'lost' AND e.at >= ?) lost,
      (SELECT COALESCE(SUM(difference), 0) FROM pk_tills t WHERE t.user_id = u.id AND t.status = 'closed' AND t.closed_at >= ?) diff,
      (SELECT COUNT(*) FROM pk_tills t WHERE t.user_id = u.id AND t.status = 'closed' AND t.difference < 0 AND t.closed_at >= ?) short
      FROM users u WHERE u.active = 1`, from, from, from, from, from, from, from, from).filter((p) => p.pays || p.manual || p.mallvals || p.lost || p.diff);
    const rate = (p, k) => (p.pays ? (p[k] / p.pays) * 100 : p[k] ? 100 : 0);
    const med = { manual: median(people.map((p) => rate(p, 'manual'))), mallvals: median(people.map((p) => rate(p, 'mallvals'))), lost: median(people.map((p) => rate(p, 'lost'))) };
    const flag = (p, k) => p[k] >= 3 && rate(p, k) > Math.max(2 * med[k], 1);
    const peopleTable = ui.table([
      { label: tr('prk|Person'), render: (p) => `<b>${esc(p.name)}</b>${['manual', 'mallvals', 'lost'].some((k) => flag(p, k)) || p.short >= 2 ? ` ${ui.badge('check', tr('prk|Check'), 'amber')}` : ''}` },
      { label: tr('prk|Payments'), num: true, render: (p) => `${ui.n0(p.pays)}<small class="sub">${c.money(p.taken)}</small>` },
      { label: tr('prk|Opened by hand'), num: true, render: (p) => `<span class="${flag(p, 'manual') ? 'late' : ''}">${ui.n0(p.manual)}</span>${p.written ? `<small class="sub">${c.money(p.written)}</small>` : ''}` },
      { label: tr('prk|Mall validations'), num: true, render: (p) => `<span class="${flag(p, 'mallvals') ? 'late' : ''}">${ui.n0(p.mallvals)}</span>` },
      { label: tr('prk|Lost tickets'), num: true, render: (p) => `<span class="${flag(p, 'lost') ? 'late' : ''}">${ui.n0(p.lost)}</span>` },
      { label: tr('prk|Till differences'), num: true, render: (p) => (p.diff ? `<b class="${p.diff < 0 ? 'late' : ''}">${c.money(r2(p.diff))}</b><small class="sub">${esc(tn(p.short, 'prk|{n} short', 'prk|{n} short'))}</small>` : '—') },
    ], people, { empty: esc(tr('prk|No cashier activity in this period.')) });

    // shops
    const shops = db.all(`SELECT b.id, b.name, COUNT(*) n, AVG(v.purchase) avgp, SUM(v.receipt_ref IS NULL OR v.receipt_ref = '') noreceipt, SUM(v.value) value
      FROM pk_validations v JOIN brands b ON b.id = v.brand_id WHERE v.status = 'ok' AND v.at >= ? GROUP BY b.id ORDER BY n DESC`, from);
    const medN = median(shops.map((x) => x.n));
    const shopTable = ui.table([
      { label: tr('prk|Shop'), render: (x) => `<b>${esc(x.name)}</b>${x.n > 3 * medN && x.n > 30 ? ` ${ui.badge('check', tr('prk|Far above the others'), 'amber')}` : ''}` },
      { label: tr('prk|Validations'), num: true, render: (x) => ui.n0(x.n) },
      { label: tr('prk|Average purchase'), num: true, render: (x) => (x.avgp ? c.money(Math.round(x.avgp)) : '—') },
      { label: tr('prk|No receipt number'), num: true, render: (x) => `<span class="${x.noreceipt / x.n > 0.3 ? 'late' : ''}">${Math.round((x.noreceipt / x.n) * 100)}%</span>` },
      { label: tr('prk|Worth'), num: true, render: (x) => c.money(r2(x.value || 0)) },
    ], shops, { empty: esc(tr('prk|No validations in this period.')) });
    const plates = db.all("SELECT s.plate, COUNT(*) n, COUNT(DISTINCT v.brand_id) shops FROM pk_validations v JOIN pk_sessions s ON s.id = v.session_id WHERE v.status = 'ok' AND v.at >= ? AND s.plate IS NOT NULL GROUP BY s.plate_key HAVING n >= 4 ORDER BY n DESC LIMIT 15", from);
    const plateList = plates.length ? `<ul class="list pk-list">${plates.map((p) => `<li><span class="what"><b><bdi>${esc(p.plate)}</bdi></b><small>${esc(tn(p.shops, 'prk|by {n} shop', 'prk|by {n} shops'))}</small></span><b>${ui.n0(p.n)}</b></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|No plate was validated more than three times.'))}</p>`;

    // gates
    const lanes = db.all(`SELECT l.*, (SELECT COUNT(*) FROM pk_sessions s WHERE s.entry_lane_id = l.id AND s.entry_at >= ?) entries,
      (SELECT COUNT(*) FROM pk_sessions s WHERE s.entry_lane_id = l.id AND s.entry_at >= ? AND s.entry_via = 'anpr') anpr,
      (SELECT COUNT(*) FROM pk_events e WHERE e.lane_id = l.id AND e.kind = 'deny' AND e.at >= ?) refused,
      (SELECT COUNT(*) FROM pk_events e WHERE e.lane_id = l.id AND e.kind = 'deny' AND e.reason = 'unknown' AND e.at >= ?) unknown
      FROM pk_lanes l ORDER BY l.direction, l.code`, from, from, from, from);
    const quiet = Number(S('prk_quiet_min', 30));
    const laneTable = ui.table([
      { label: tr('prk|Gate'), render: (l) => `<b>${esc(tx(l.name))}</b><small class="sub ltr">${esc(l.code)}</small>` },
      { label: tr('prk|Last heard from'), render: (l) => (l.last_seen_at ? `${esc(ui.dt(l.last_seen_at))}${Date.now() - Date.parse(l.last_seen_at) > quiet * 60000 ? ` ${ui.badge('q', tr('prk|Quiet'), 'rose')}` : ''}` : esc(tr('prk|Never'))) },
      { label: tr('prk|Plates read'), num: true, render: (l) => (l.direction === 'in' && l.entries ? `<span class="${l.anpr / l.entries < 0.85 ? 'late' : ''}">${Math.round((l.anpr / l.entries) * 100)}%</span>` : '—') },
      { label: tr('prk|Refused'), num: true, render: (l) => ui.n0(l.refused) },
      { label: tr('prk|Exits with no entry'), num: true, render: (l) => (l.direction === 'out' ? ui.n0(l.unknown) : '—') },
    ], lanes, { empty: esc(tr('prk|No gates yet.')) });
    const periodTabs = c.subtabs(`/admin/parking/watch?days=${days}`, [7, 30, 90].map((d) => [`/admin/parking/watch?days=${d}`, `prk|Last ${d} days`]));
    c.page(req, res, {
      title: tr('prk|Watch'), crumbs: c.crumbs([null, tr('prk|Watch')]),
      body: `${c.tabs('/admin/parking/watch')}${periodTabs}${ui.card(tr('prk|Alerts'), alertList, { sub: esc(tr('prk|Checked every ten minutes. Urgent ones go to security on WhatsApp when a number is set.')) })}
<div class="grid grid--side">${ui.card(tr('prk|Cashiers'), peopleTable, { sub: esc(tr('prk|“Check” marks someone well above the rest of the team for their number of payments.')) })}${ui.card(tr('prk|Plates validated often'), plateList)}</div>
<div class="grid grid--side">${ui.card(tr('prk|Shops’ validations'), shopTable)}${ui.card(tr('prk|Gates'), laneTable)}</div>`,
    });
  });
  router.post('/parking/alerts/:id/ack', c.RA, (req, res) => {
    db.run('UPDATE pk_alerts SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL', now(), req.user.id, h.int(req.params.id));
    c.back(req, res, '/admin/parking/watch', 'ok', tr('prk|Marked as seen.'));
  });

  // the set-up card: who hears about urgent alerts, and the thresholds
  (h.parkingSetupCards = h.parkingSetupCards || []).push((req) => ui.card(tr('prk|Security alerts'), h.can(req, 'manager') ? ui.form('/admin/parking/watch/settings', req.session.csrf, `<div class="fields">
    ${ui.input('prk_security_phone', tr('prk|Security’s WhatsApp number'), S('prk_security_phone', ''), { type: 'tel', placeholder: '01012345678' })}
    ${ui.input('prk_quiet_min', tr('prk|A gate is quiet after (minutes)'), S('prk_quiet_min', 30), { type: 'number', min: 5, max: 240 })}
    ${ui.input('prk_till_alert', tr('prk|Alert on a till difference from'), S('prk_till_alert', 50), { type: 'number', min: 0, step: 1 })}</div>${ui.btn(esc(tr('Save')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' }) : '', { sub: esc(tr('prk|Urgent alerts: a blocked plate at the gate, a gate gone quiet.')) }));
  router.post('/parking/watch/settings', c.RM, (req, res) => {
    db.setSetting('prk_security_phone', h.str(req.body.prk_security_phone, 30));
    db.setSetting('prk_quiet_min', String(Math.min(240, Math.max(5, h.int(req.body.prk_quiet_min) || 30))));
    db.setSetting('prk_till_alert', String(Math.max(0, h.int(req.body.prk_till_alert) ?? 50)));
    h.log(req, 'Changed the parking alerts', 'setting', null, '');
    c.back(req, res, '/admin/parking/setup', 'ok', tr('Saved.'));
  });
};
