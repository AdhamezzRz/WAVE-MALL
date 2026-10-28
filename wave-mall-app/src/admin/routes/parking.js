'use strict';

// Parking at /admin/parking: the live car park, the exit booth (a cashier's screen for tablets and
// phones), every visit, subscriptions, shop validations, tills, reports and the set-up (levels,
// gates, prices, plans). The rules live in parking/core.js; the visitors' pages, the gates' API and
// the shops' validation screen in the tenant portal in parking/public.js.
//
// Who does what: everyone signed in sees the car park; agents work the booth (payments, lost
// tickets, letting cars out, the mall's own validations); managers also open the barrier for an
// unpaid car, cancel visits and set prices, gates, plans and rules.

const { t: tr, tn, tx, isAr } = require('../i18n');
const { parking } = require('../parking/core');
const T = require('../parking/tariff');
const qr = require('../qr');
const { cairo, csvCell } = require('../ops-common');


// labels ('prk|English' keys, translated when shown)
const KIND = { visitor: 'prk|Visitor', subscriber: 'prk|Subscriber', tenant: 'prk|Tenant staff', staff: 'prk|Mall staff', vip: 'prk|VIP' };
const KIND_TONE = { visitor: 'sea', subscriber: 'forest', tenant: 'cocoa', staff: 'sky', vip: 'amber' };
const STATUS = { inside: ['prk|Parked', 'ok'], left: ['prk|Left', 'mute'], void: ['prk|Cancelled', 'rose'] };
const HOLDER = { tenant: 'prk|Tenant staff', staff: 'prk|Mall staff', vip: 'prk|VIP', individual: 'prk|Individual' };
const P_STATUS = { active: ['prk|Active', 'ok'], suspended: ['prk|Suspended', 'amber'], cancelled: ['prk|Cancelled', 'mute'], expired: ['prk|Expired', 'mute'] };
const METHOD = { cash: 'prk|Cash', card: 'prk|Card', wallet: 'prk|Mobile wallet', instapay: 'prk|InstaPay', online: 'prk|Online' };
const ZONE_KIND = { general: 'prk|General', reserved: 'prk|Reserved', vip: 'prk|VIP', accessible: 'prk|Accessible', ev: 'prk|Electric cars', staff: 'prk|Staff' };
const LANE_DIR = { in: 'prk|Entry', out: 'prk|Exit' };
const PAYER = { mall: 'prk|The mall', tenant: 'prk|The shop', split: 'prk|Shared' };
const VIA = { anpr: 'prk|Plate camera', ticket: 'prk|Ticket', card: 'prk|NFC card', manual: 'prk|By hand', qr: 'prk|QR scan', nfc: 'prk|NFC tap', code: 'prk|Code', plate: 'prk|Plate', booth: 'prk|Booth', machine: 'prk|Pay machine' };
const EVENT = {
  entry: ['prk|Entry', 'ok'], exit: ['prk|Exit', 'sea'], deny: ['prk|Refused', 'rose'], manual: ['prk|Opened by hand', 'amber'],
  alarm: ['prk|Alarm', 'rose'], lost: ['prk|Lost ticket', 'amber'], validate: ['prk|Validated', 'forest'], unvalidate: ['prk|Validation removed', 'mute'],
};
const REASON = {
  blocked: 'prk|Plate on the block list', full: 'prk|Car park full', unknown: 'prk|No entry on record', unpaid: 'prk|Not paid', 'no-exit': 'prk|No exit was recorded',
  repeat: 'prk|Same car read again', visitor: 'prk|Visitor', subscriber: 'prk|Subscriber', tenant: 'prk|Tenant staff', staff: 'prk|Mall staff', vip: 'prk|VIP',
  shop: 'prk|By a shop', mall: 'prk|By the mall', lost: 'prk|Ticket lost', void: 'prk|Removed', manual: 'prk|By hand',
};
const VAL_MINUTES = [[0, 'prk|The whole visit'], [60, 'prk|1 hour'], [120, 'prk|2 hours'], [180, 'prk|3 hours'], [240, 'prk|4 hours'], [360, 'prk|6 hours']];
const PERIODS = { 7: 'prk|Last 7 days', 30: 'prk|Last 30 days', 90: 'prk|Last 90 days' };

module.exports = function parkingModule(router, h) {
  const { db, ui, M } = h;
  const P = parking(db, h);
  const env = (k) => String((h.env && h.env[k]) || '');
  const now = () => new Date().toISOString();
  const r2 = T.r2;
  const esc = ui.esc;
  const tmap = (o) => Object.entries(o).map(([k, v]) => [k, tr(Array.isArray(v) ? v[0] : v)]);
  const dur = (min) => T.duration(min, tr);
  const err = (e) => tr(e.message, e.params);
  const RM = h.R('manager');
  const RA = h.R('agent');
  seed();

  // ---------- small pieces ----------
  const plate = (s, cls = '') => (s ? `<span class="pk-plate ${cls}"><i aria-hidden="true">EGYPT · مصر</i><bdi>${esc(s)}</bdi></span>` : `<span class="muted">${esc(tr('prk|No plate'))}</span>`);
  const kindBadge = (k) => ui.badge(k, tr(KIND[k] || KIND.visitor), KIND_TONE[k] || 'mute');
  const statusBadge = (s) => ui.badge(s, tr((STATUS[s] || [s])[0]), (STATUS[s] || [])[1]);
  const pBadge = (s) => ui.badge(s, tr((P_STATUS[s] || [s])[0]), (P_STATUS[s] || [])[1]);
  const code = (c) => `<b class="pk-code ltr">${esc(P.codeShow(c))}</b>`;
  const site = (req) => String((h.env && h.env.SITE_URL) || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const ticketUrl = (req, s) => `${site(req)}/parking/t/${P.codeShow(s.code)}`;
  const money = (n) => ui.money(n);
  const minutesOf = (s, at = now()) => T.minutesBetween(s.entry_at, s.exit_at || at);
  const today = () => cairo().date;
  // the UTC moment a Cairo day starts (Egypt keeps summer time, so the offset is +2 or +3)
  function dayStart(date) {
    for (const off of [2, 3, 1, 4]) {
      const t = Date.parse(`${date}T00:00:00Z`) - off * 3600000;
      const c = cairo(new Date(t));
      if (c.date === date && c.hour === 0) return new Date(t).toISOString();
    }
    return `${date}T00:00:00.000Z`;
  }
  const cairoDate = (iso) => cairo(new Date(iso)).date;
  const crumbs = (...rest) => [['/admin/parking', tr('nav|Parking')], ...rest];
  const TABS = [
    ['/admin/parking', 'prk|Live'], ['/admin/parking/booth', 'prk|Booth'], ['/admin/parking/visits', 'prk|Cars'], ['/admin/parking/subscriptions', 'prk|Subscriptions'],
    ['/admin/parking/validations', 'prk|Validations'], ['/admin/parking/tills', 'prk|Tills'], ['/admin/parking/reports', 'prk|Reports'], ['/admin/parking/setup', 'prk|Set-up'],
  ];
  const tabs = (on) => `<nav class="tabs pk-tabs">${TABS.map(([href, l]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${esc(tr(l))}</a>`).join('')}</nav>`;
  const script = `<script src="/admin/parking.js?v=${ui.ASSETS.parking}" defer></script>`;
  const page = (req, res, opts) => h.page(req, res, { active: '/admin/parking', wide: true, ...opts, body: `${opts.body}${script}` });
  const back = (req, res, url, type, text) => h.back(req, res, url, type, text);
  const fail = (req, res, url, e) => {
    if (!e.params && !String(e.message).startsWith('prk|')) console.error('[parking]', e);
    back(req, res, url, 'error', err(e));
  };
  const userName = (id) => (id ? db.value('SELECT name FROM users WHERE id = ?', id) : null);
  const brandName = (id) => (id ? db.value('SELECT name FROM brands WHERE id = ?', id) : null);
  const zoneName = (z) => (z ? (isAr() && z.name_ar ? z.name_ar : tx(z.name)) : '');
  const tenants = () => db.all("SELECT DISTINCT b.id, b.name FROM brands b JOIN leases l ON l.brand_id = b.id WHERE l.status IN ('active','signed') ORDER BY b.name");
  const hasTable = (n) => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", n);

  // the sidebar badge: cars parked far too long
  const overstayCount = () => db.value("SELECT COUNT(*) FROM pk_sessions WHERE status = 'inside' AND kind = 'visitor' AND entry_at < ?", new Date(Date.now() - P.N('prk_overstay_hours') * 3600000).toISOString());
  h.count('parking', () => overstayCount());

  // ---------- the live car park ----------
  router.get('/parking', (req, res) => {
    const o = P.occupancy();
    const d = today();
    const from = dayStart(d);
    const entries = db.value('SELECT COUNT(*) FROM pk_sessions WHERE entry_at >= ? AND status != ?', from, 'void');
    const yEntries = db.value('SELECT COUNT(*) FROM pk_sessions WHERE entry_at >= ? AND entry_at < ? AND status != ?', dayStart(P.addDays(d, -7)), new Date(Date.parse(dayStart(P.addDays(d, -7))) + (Date.now() - Date.parse(from))).toISOString(), 'void');
    const takings = db.all("SELECT method, SUM(amount) total, COUNT(*) n FROM pk_payments WHERE at >= ? AND status = 'ok' GROUP BY method", from);
    const revenue = r2(takings.reduce((s, x) => s + x.total, 0));
    const vals = db.get("SELECT COUNT(*) n FROM pk_validations WHERE at >= ? AND status = 'ok'", from).n;
    const stays = db.all("SELECT entry_at, exit_at FROM pk_sessions WHERE status = 'left' AND exit_at >= ? AND kind = 'visitor'", from);
    const avg = stays.length ? stays.reduce((s, x) => s + T.minutesBetween(x.entry_at, x.exit_at), 0) / stays.length : null;
    const delta = yEntries ? (entries - yEntries) / yEntries : null;
    const kpis = [
      ui.kpi({ label: tr('prk|Cars parked now'), value: `${ui.n0(o.cars)}<small> / ${ui.n0(o.capacity)}</small>`, bar: o.capacity ? o.cars / o.capacity : null, sub: esc(tr('prk|{n} spaces free', { n: ui.n0(o.free) })) }),
      ui.kpi({ label: tr('prk|Cars in today'), value: ui.n0(entries), sub: delta === null ? '' : `<span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta * 100).toFixed(0)}%</span> ${esc(tr('prk|vs last week at this hour'))}` }),
      ui.kpi({ label: tr('prk|Taken today'), value: money(revenue), sub: esc(takings.map((x) => `${tr(METHOD[x.method] || x.method)} ${ui.money(x.total, { cur: false })}`).join(' · ') || tr('prk|Nothing yet')) }),
      ui.kpi({ label: tr('prk|Average visit today'), value: avg === null ? '—' : esc(dur(avg)), sub: esc(tn(vals, 'prk|{n} validation', 'prk|{n} validations')) }),
    ].join('');
    // levels
    const levels = o.zones.length
      ? `<div class="pk-levels">${o.zones.map((z) => {
        const f = z.capacity ? z.cars / z.capacity : 0;
        const tone = f >= 0.95 ? 'rose' : f >= 0.8 ? 'amber' : 'ok';
        return `<div class="pk-level pk-level--${tone}"><div class="pk-level__head"><b>${esc(zoneName(z))}</b><small>${esc(z.level || z.code)}${z.kind !== 'general' ? ` · ${esc(tr(ZONE_KIND[z.kind] || z.kind))}` : ''}</small></div>
          <p class="pk-level__free"><b>${ui.n0(z.free)}</b><span>${esc(tr('prk|free of {n}', { n: ui.n0(z.capacity) }))}</span></p>
          <span class="pk-level__bar"><i style="width:${Math.min(100, f * 100).toFixed(1)}%"></i></span>
          <small class="muted">${esc(z.counted ? tr('prk|Counted by the level sensors') : tr('prk|Worked out from the gates'))}</small></div>`;
      }).join('')}</div>`
      : ui.empty(tr('prk|Add the car park levels in Set-up.'), ui.btn(esc(tr('prk|Set up the car park')), { href: '/admin/parking/setup', cls: 'btn--primary btn--sm' }));
    // today, hour by hour
    const todays = db.all('SELECT entry_at FROM pk_sessions WHERE entry_at >= ? AND status != ?', from, 'void');
    const byHour = Array(24).fill(0);
    for (const s of todays) byHour[cairo(new Date(s.entry_at)).hour]++;
    const hours = byHour.map((n, hr) => ({ n, label: hr % 3 === 0 ? String(hr).padStart(2, '0') : '' })).slice(7);
    // the gate feed
    const feed = db.all('SELECT e.*, l.name lane_name FROM pk_events e LEFT JOIN pk_lanes l ON l.id = e.lane_id ORDER BY e.at DESC, e.id DESC LIMIT 14');
    const feedHtml = feed.length ? `<ul class="list pk-feed">${feed.map((e) => {
      const [label, tone] = EVENT[e.kind] || [e.kind, 'mute'];
      const link = e.session_id ? `/admin/parking/visits/${e.session_id}` : null;
      const inner = `<span class="pk-feed__t ltr">${esc(ui.local(e.at).slice(11, 16))}</span>${ui.badge(e.kind, tr(label), tone)}<span class="what"><b>${e.plate ? `<bdi>${esc(e.plate)}</bdi>` : esc(e.credential ? P.codeShow(e.credential).length === 9 ? P.codeShow(e.credential) : e.credential : '—')}</b><small>${esc([e.lane_name ? tx(e.lane_name) : null, e.reason ? tr(REASON[e.reason] || e.reason) : null, e.amount ? ui.money(e.amount) : null].filter(Boolean).join(' · '))}</small></span>`;
      return `<li>${link ? `<a href="${link}">${inner}</a>` : inner}</li>`;
    }).join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|The gates have not reported anything yet.'))}</p>`;
    // needs attention
    const overstay = db.all("SELECT * FROM pk_sessions WHERE status = 'inside' AND kind = 'visitor' AND entry_at < ? ORDER BY entry_at LIMIT 6", new Date(Date.now() - P.N('prk_overstay_hours') * 3600000).toISOString());
    const refused = db.all("SELECT reason, COUNT(*) n FROM pk_events WHERE kind = 'deny' AND at >= ? GROUP BY reason", from);
    const suspended = db.value("SELECT COUNT(*) FROM pk_permits WHERE status = 'suspended'");
    const openTills = db.all("SELECT t.*, u.name user_name FROM pk_tills t LEFT JOIN users u ON u.id = t.user_id WHERE t.status = 'open' ORDER BY t.opened_at");
    const attention = [
      ...overstay.map((s) => `<li><a href="/admin/parking/visits/${s.id}"><span class="what"><b><bdi>${esc(s.plate || P.codeShow(s.code))}</bdi></b><small>${esc(tr('prk|Parked for {time}', { time: dur(minutesOf(s)) }))}</small></span>${ui.badge('late', tr('prk|Long stay'), 'amber')}</a></li>`),
      ...refused.map((r) => `<li><span class="what"><b>${esc(tr(REASON[r.reason] || r.reason))}</b><small>${esc(tr('prk|Refused at a gate today'))}</small></span><b>${ui.n0(r.n)}</b></li>`),
      suspended ? `<li><a href="/admin/parking/subscriptions?status=suspended"><span class="what"><b>${esc(tn(suspended, 'prk|{n} subscription suspended', 'prk|{n} subscriptions suspended'))}</b><small>${esc(tr('prk|Invoices not paid'))}</small></span>${ui.badge('suspended', tr('prk|Suspended'), 'amber')}</a></li>` : '',
      ...openTills.map((t) => `<li><a href="/admin/parking/tills/${t.id}"><span class="what"><b>${esc(tx(t.name))}</b><small>${esc([t.user_name, tr('prk|open since {time}', { time: ui.local(t.opened_at).slice(11, 16) })].filter(Boolean).join(' · '))}</small></span>${ui.badge('open', tr('prk|Open till'), 'sky')}</a></li>`),
    ].filter(Boolean);
    const body = `${tabs('/admin/parking')}
<div class="kpis kpis--4">${kpis}</div>
${ui.card(tr('prk|Levels'), levels, { sub: esc(o.full ? tr('prk|The car park is full: the entry is closed to visitors.') : tr('prk|Free spaces on each level, as the signs at the entrance show them.')), action: `<span class="pk-live" data-autoreload="30">${esc(tr('prk|Live'))}</span>` })}
<div class="grid grid--side">
  ${ui.card(tr('prk|Cars in, hour by hour'), ui.bars(hours, { key: 'n', label: 'label', h: 150, tone: 'sea' }), { sub: esc(tr('prk|Today, from 07:00')) })}
  ${ui.card(tr('prk|Needs attention'), attention.length ? `<ul class="list pk-list">${attention.join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|All clear.'))}</p>`)}
</div>
${ui.card(tr('prk|At the gates'), feedHtml, { action: ui.btn(esc(tr('prk|All cars')), { href: '/admin/parking/visits', cls: 'btn--ghost btn--sm' }) })}`;
    page(req, res, { title: tr('nav|Parking'), body, actions: h.can(req, 'agent') ? ui.btn(esc(tr('prk|Open the booth')), { href: '/admin/parking/booth', cls: 'btn--primary', ic: 'car' }) : '' });
  });

  // ---------- the booth ----------
  // Find a car by scanning its ticket, tapping its card or typing its plate; take the money; let it out.
  function visitPanel(req, s, { from = 'booth' } = {}) {
    const q = P.quoteOf(s);
    const csrf = req.session.csrf;
    const agent = h.can(req, 'agent');
    const mgr = h.can(req, 'manager');
    const till = agent ? P.openTillOf(req.user.id) : null;
    const backTo = from === 'booth' ? `?back=booth` : '';
    const vals = q.validations;
    const lines = [
      [tr('prk|Price for {time}', { time: dur(q.minutes) }), money(q.gross)],
      ...(q.free ? [[q.whole ? tr('prk|Validated: the whole visit is free') : tr('prk|Validated: {time} free', { time: dur(q.freeMin) }), `− ${money(q.free)}`]] : []),
      ...(q.paid ? [[tr('prk|Paid'), `− ${money(q.paid)}`]] : []),
    ];
    const breakdown = s.kind === 'visitor'
      ? `<dl class="pk-bill">${lines.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}<div class="pk-bill__due"><dt>${esc(q.inExitWindow ? tr('prk|Paid: free to leave for a few minutes') : tr('prk|To pay now'))}</dt><dd>${money(q.due)}</dd></div></dl>`
      : `<p class="alert alert--ok">${esc(tr('prk|Subscription: no charge.'))}</p>`;
    const payBtns = s.status === 'inside' && s.kind === 'visitor' && q.due > 0 && agent
      ? (till
        ? `<div class="pk-pay">${['cash', 'card', 'wallet', 'instapay'].map((m) => ui.form(`/admin/parking/visits/${s.id}/pay${backTo}`, csrf, `<input type="hidden" name="method" value="${m}"><input type="hidden" name="amount" value="${q.due}">${ui.btn(`${esc(tr(METHOD[m]))} <b>${ui.money(q.due, { cur: false })}</b>`, { cls: m === 'cash' ? 'btn--primary' : 'btn--ghost' })}`)).join('')}</div>`
        : `<p class="alert alert--warn">${esc(tr('prk|Open your till to take payments.'))} <a href="/admin/parking/booth">${esc(tr('prk|Open the till'))}</a></p>`)
      : '';
    const letOut = s.status === 'inside' && agent && (q.due <= 0 || s.kind !== 'visitor')
      ? ui.form(`/admin/parking/visits/${s.id}/exit${backTo}`, csrf, ui.btn(esc(tr('prk|Open the barrier and close the visit')), { cls: 'btn--primary btn--block', ic: 'arrow' }))
      : '';
    const writeOff = s.status === 'inside' && mgr && q.due > 0
      ? `<details class="upload-box"><summary>${ui.icon('shield')}<span>${esc(tr('prk|Let out without paying'))}</span></summary>${ui.form(`/admin/parking/visits/${s.id}/exit${backTo}`, csrf, `<input type="hidden" name="manual" value="1">${ui.input('reason', tr('prk|Why'), '', { required: true, placeholder: tr('prk|e.g. Ambulance, police, a guest of the management') })}${ui.btn(esc(tr('prk|Open and write off {amount}', { amount: money(q.due) })), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('prk|Open the barrier without payment? This is logged.') } })}`, { cls: 'stack' })}</details>`
      : '';
    const mallVal = s.status === 'inside' && s.kind === 'visitor' && agent && !q.whole
      ? `<details class="upload-box"><summary>${ui.icon('check')}<span>${esc(tr('prk|Validate for the mall'))}</span></summary>${ui.form(`/admin/parking/visits/${s.id}/validate${backTo}`, csrf, `<div class="fields">${ui.select('minutes', tr('prk|Free time'), VAL_MINUTES.map(([k, l]) => [k, tr(l)]), 0)}${ui.input('reason', tr('prk|Reason'), '', { required: true, placeholder: tr('prk|e.g. Customer service, event guest, complaint') })}</div>${ui.btn(esc(tr('prk|Validate')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })}</details>`
      : '';
    const lost = s.status === 'inside' && s.kind === 'visitor' && agent && !s.lost
      ? ui.form(`/admin/parking/visits/${s.id}/lost${backTo}`, csrf, ui.btn(esc(tr('prk|Ticket lost')), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('prk|Add the lost-ticket fee of {amount}?', { amount: money((q.tariff || T.DEFAULT).lost_fee) }) } }))
      : '';
    const valList = vals.length ? `<ul class="list pk-vals">${vals.map((v) => `<li><span class="what"><b>${esc(v.brand_id ? brandName(v.brand_id) : tr('prk|The mall'))}</b><small>${esc([v.whole ? tr('prk|The whole visit') : dur(v.minutes), tr(VIA[v.via] || v.via), v.reason ? tx(v.reason) : null, ui.local(v.at).slice(11, 16)].filter(Boolean).join(' · '))}</small></span>${s.status === 'inside' && agent ? ui.form(`/admin/parking/validations/${v.id}/void${backTo}`, csrf, `<button class="iconbtn" title="${esc(tr('prk|Remove'))}" aria-label="${esc(tr('prk|Remove'))}" data-confirm="${esc(tr('prk|Remove this validation?'))}">×</button>`) : ''}</li>`).join('')}</ul>` : '';
    return `<section class="card pk-visit">
  <header class="pk-visit__head">${plate(s.plate, 'pk-plate--big')}<div class="pk-visit__ids">${code(s.code)}<small>${esc(s.ref)}</small></div><div class="pk-visit__tags">${kindBadge(s.kind)} ${statusBadge(s.status)}${s.lost ? ` ${ui.badge('lost', tr('prk|Ticket lost'), 'amber')}` : ''}</div></header>
  <div class="card__body stack">
    <dl class="dl"><div><dt>${esc(tr('prk|Came in'))}</dt><dd>${esc(ui.dt(s.entry_at))}${s.entry_via ? ` · ${esc(tr(VIA[s.entry_via] || s.entry_via))}` : ''}</dd></div>
    ${s.exit_at ? `<div><dt>${esc(tr('prk|Left'))}</dt><dd>${esc(ui.dt(s.exit_at))}</dd></div>` : ''}
    <div><dt>${esc(tr('prk|Time parked'))}</dt><dd><b>${esc(dur(q.minutes))}</b></dd></div>
    ${s.permit_id ? `<div><dt>${esc(tr('prk|Subscription'))}</dt><dd><a href="/admin/parking/subscriptions/${s.permit_id}">${esc(db.value('SELECT ref FROM pk_permits WHERE id = ?', s.permit_id) || '')}</a></dd></div>` : ''}
    ${s.note ? `<div><dt>${esc(tr('prk|Note'))}</dt><dd>${esc(tx(s.note))}</dd></div>` : ''}</dl>
    ${breakdown}${valList}${payBtns}${letOut}
    <div class="row">${lost}${from === 'booth' ? ui.btn(esc(tr('prk|Details')), { href: `/admin/parking/visits/${s.id}`, cls: 'btn--ghost btn--sm' }) : ''}${ui.btn(esc(tr('prk|Print ticket')), { href: `/admin/parking/visits/${s.id}/ticket`, cls: 'btn--ghost btn--sm', ic: 'print', attrs: { target: '_blank' } })}</div>
    ${mallVal}${writeOff}
  </div></section>`;
  }
  const scanBox = (action, value = '', { label = tr('prk|Scan the ticket, tap the card or type the plate'), name = 'q', autofocus = true } = {}) => `<form method="get" action="${action}" class="pk-scan" data-scan data-msg-cam="${esc(tr('prk|Point the camera at the ticket’s QR code.'))}" data-msg-nfc="${esc(tr('prk|Hold the card against the back of the phone.'))}" data-msg-err="${esc(tr('prk|This device could not start the reader.'))}">
    <label class="pk-scan__in">${ui.icon('search')}<input type="search" name="${name}" value="${esc(value)}" placeholder="${esc(label)}" aria-label="${esc(label)}" autocomplete="off" autocapitalize="characters" spellcheck="false"${autofocus ? ' autofocus' : ''} data-scan-input></label>
    <button type="button" class="btn btn--ghost pk-scan__cam" data-scan-camera hidden>${ui.icon('cam')}<span>${esc(tr('prk|Camera'))}</span></button>
    <button type="button" class="btn btn--ghost pk-scan__nfc" data-scan-nfc hidden>${ui.icon('nfc')}<span>${esc(tr('prk|NFC'))}</span></button>
    <button class="btn btn--primary">${esc(tr('prk|Find'))}</button>
    <div class="pk-scan__video" data-scan-video hidden><video playsinline muted></video><button type="button" class="iconbtn" data-scan-stop aria-label="${esc(tr('mob|Close'))}">${ui.icon('x')}</button></div>
    <p class="pk-scan__msg" data-scan-msg hidden></p>
  </form>`;

  router.get('/parking/booth', (req, res) => {
    const q = h.str(req.query.q, 200);
    const csrf = req.session.csrf;
    const till = P.openTillOf(req.user.id);
    let result = '';
    if (q) {
      const cred = P.readCredential(q);
      const s = P.findInside(cred) || (cred.code ? P.byCode(cred.code) : null);
      if (s) result = visitPanel(req, s);
      else {
        result = `<section class="card"><div class="card__body stack"><p class="alert alert--warn">${esc(tr('prk|No car inside matches “{q}”.', { q }))}</p>
          ${h.can(req, 'agent') && cred.plate ? ui.form('/admin/parking/entry', csrf, `<input type="hidden" name="plate" value="${esc(q)}">${ui.btn(esc(tr('prk|Record it as parked now')), { cls: 'btn--ghost btn--sm' })}`) : ''}</div></section>`;
      }
    }
    const tillCard = h.can(req, 'agent')
      ? (till
        ? (() => {
          const tot = P.tillTotals(till);
          return ui.card(tr('prk|Your till'), `<dl class="dl"><div><dt>${esc(tr('prk|Opened'))}</dt><dd>${esc(ui.dt(till.opened_at))} · ${esc(tx(till.name))}</dd></div>
            ${Object.entries(tot.by).map(([m, v]) => `<div><dt>${esc(tr(METHOD[m] || m))}</dt><dd>${money(v.total)} <small class="muted">(${ui.n0(v.n)})</small></dd></div>`).join('')}
            <div><dt>${esc(tr('prk|Cash in the drawer'))}</dt><dd><b>${money(tot.expectedCash)}</b></dd></div></dl>
            ${ui.btn(esc(tr('prk|Close the till')), { href: `/admin/parking/tills/${till.id}`, cls: 'btn--ghost btn--sm btn--block' })}`, { sub: esc(till.ref) });
        })()
        : ui.card(tr('prk|Open your till'), ui.form('/admin/parking/till/open', csrf, `<div class="fields">${ui.select('name', tr('prk|Where'), [['Exit booth', tr('prk|Exit booth')], ['Entry booth', tr('prk|Entry booth')], ['Customer service', tr('prk|Customer service')]], 'Exit booth')}${ui.input('float', tr('prk|Cash in the drawer to start'), '0', { type: 'number', min: 0, step: 1 })}</div>${ui.btn(esc(tr('prk|Open the till')), { cls: 'btn--primary btn--block' })}`, { cls: 'stack' }), { sub: esc(tr('prk|Every payment you take goes into your till.')) }))
      : '';
    const manual = h.can(req, 'agent') ? ui.card(tr('prk|Car in by hand'), ui.form('/admin/parking/entry', csrf, `<div class="fields">${ui.input('plate', tr('prk|Plate'), '', { placeholder: 'ق ص ر 1234', attrs: { autocomplete: 'off' } })}${ui.select('lane', tr('prk|Gate'), db.all("SELECT code, name FROM pk_lanes WHERE direction = 'in' AND active = 1 ORDER BY code").map((l) => [l.code, tx(l.name)]), '', { blank: tr('prk|No gate') })}</div>${ui.btn(esc(tr('prk|Issue a ticket')), { cls: 'btn--ghost btn--sm', ic: 'print' })}`, { cls: 'stack' }), { sub: esc(tr('prk|When a camera cannot read the plate, or for a car without one.')) }) : '';
    const o = P.occupancy();
    const body = `${tabs('/admin/parking/booth')}<div class="grid grid--side pk-booth">
  <div class="stack">${scanBox('/admin/parking/booth', q)}${result || `<div class="pk-hint">${ui.icon('car')}<p>${esc(tr('prk|Scan a ticket’s QR code, tap an NFC card on the reader, or type the plate. A barcode or card reader plugged into this device types into the box by itself.'))}</p></div>`}</div>
  <div class="stack">${tillCard}<div class="kpis kpis--2">${ui.kpi({ label: tr('prk|Parked now'), value: ui.n0(o.cars) })}${ui.kpi({ label: tr('prk|Spaces free'), value: ui.n0(o.free) })}</div>${manual}</div>
</div>`;
    page(req, res, { title: tr('prk|Booth'), crumbs: crumbs([null, tr('prk|Booth')]), body });
  });
  const backFrom = (req, s) => (req.query.back === 'booth' ? `/admin/parking/booth?q=${encodeURIComponent(P.codeShow(s.code))}` : `/admin/parking/visits/${s.id}`);
  const visit = (req) => P.sessionBy(h.int(req.params.id));

  router.post('/parking/till/open', RA, (req, res) => {
    try {
      P.openTill({ user: req.user, name: h.str(req.body.name, 60) || 'Exit booth', float: h.numv(req.body.float) || 0 });
      h.log(req, 'Opened a parking till', 'pk_till', null, h.str(req.body.name, 60));
      back(req, res, '/admin/parking/booth', 'ok', tr('prk|Till open. You can take payments.'));
    } catch (e) {
      fail(req, res, '/admin/parking/booth', e);
    }
  });
  router.post('/parking/entry', RA, (req, res) => {
    const r = P.entry({ lane: h.str(req.body.lane, 20) || null, plate: h.str(req.body.plate, 30), via: 'manual', user: req.user, force: true });
    if (!r.open) return back(req, res, '/admin/parking/booth', 'error', tr(REASON[r.reason] || 'prk|The car could not be recorded.'));
    h.log(req, 'Recorded a car by hand', 'pk_session', r.session.id, `${r.session.ref} · ${r.session.plate || ''}`);
    back(req, res, `/admin/parking/booth?q=${encodeURIComponent(P.codeShow(r.session.code))}`, 'ok', tr('prk|Ticket {code} issued.', { code: P.codeShow(r.session.code) }));
  });
  router.post('/parking/visits/:id/pay', RA, (req, res, next) => {
    const s = visit(req);
    if (!s) return next();
    try {
      const till = P.openTillOf(req.user.id);
      const p = P.pay(s, { amount: h.numv(req.body.amount), method: h.str(req.body.method, 20), till, user: req.user, device: 'booth' });
      h.log(req, 'Took a parking payment', 'pk_session', s.id, `${s.ref} · ${p.amount} · ${p.method}`);
      back(req, res, backFrom(req, s), 'ok', tr('prk|{amount} received. Receipt {ref}.', { amount: money(p.amount), ref: p.ref }));
    } catch (e) {
      fail(req, res, backFrom(req, s), e);
    }
  });
  router.post('/parking/visits/:id/lost', RA, (req, res, next) => {
    const s = visit(req);
    if (!s) return next();
    try {
      P.markLost(s, { user: req.user });
      h.log(req, 'Marked a parking ticket lost', 'pk_session', s.id, s.ref);
      back(req, res, backFrom(req, s), 'ok', tr('prk|Lost-ticket fee added.'));
    } catch (e) {
      fail(req, res, backFrom(req, s), e);
    }
  });
  router.post('/parking/visits/:id/validate', RA, (req, res, next) => {
    const s = visit(req);
    if (!s) return next();
    try {
      P.validate(s, { brandId: null, via: 'manual', minutes: h.int(req.body.minutes) ?? 0, reason: h.str(req.body.reason, 200), user: req.user });
      h.log(req, 'Validated parking for the mall', 'pk_session', s.id, `${s.ref} · ${h.str(req.body.reason, 200)}`);
      back(req, res, backFrom(req, s), 'ok', tr('prk|Validated.'));
    } catch (e) {
      fail(req, res, backFrom(req, s), e);
    }
  });
  router.post('/parking/validations/:id/void', RA, (req, res, next) => {
    const v = db.get('SELECT * FROM pk_validations WHERE id = ?', h.int(req.params.id));
    if (!v) return next();
    const s = P.sessionBy(v.session_id);
    try {
      P.unvalidate(v.id, { user: req.user });
      h.log(req, 'Removed a parking validation', 'pk_session', s.id, s.ref);
      back(req, res, backFrom(req, s), 'ok', tr('prk|Validation removed.'));
    } catch (e) {
      fail(req, res, backFrom(req, s), e);
    }
  });
  router.post('/parking/visits/:id/exit', RA, (req, res, next) => {
    const s = visit(req);
    if (!s) return next();
    const manual = req.body.manual === '1';
    if (manual && !h.can(req, 'manager')) return h.auth.denied(req, res);
    const reason = h.str(req.body.reason, 200);
    if (manual && !reason) return back(req, res, backFrom(req, s), 'error', tr('prk|Say why the barrier is opened without payment.'));
    const r = P.exit({ code: s.code, via: 'booth', user: req.user, manual, reason });
    if (!r.open) return back(req, res, backFrom(req, s), 'error', r.reason === 'unpaid' ? tr('prk|{amount} still to pay.', { amount: money(r.due) }) : tr(REASON[r.reason] || 'prk|The barrier stays closed.'));
    h.log(req, manual ? 'Opened the parking barrier without payment' : 'Let a car out', 'pk_session', s.id, `${s.ref}${manual ? ` · ${reason}` : ''}`);
    back(req, res, req.query.back === 'booth' ? '/admin/parking/booth' : `/admin/parking/visits/${s.id}`, 'ok', tr('prk|Barrier open. Visit closed.'));
  });
  router.post('/parking/visits/:id/void', RM, (req, res, next) => {
    const s = visit(req);
    if (!s) return next();
    if (s.status !== 'inside') return back(req, res, `/admin/parking/visits/${s.id}`, 'error', tr('prk|Only a car still inside can be cancelled.'));
    if (s.paid > 0) return back(req, res, `/admin/parking/visits/${s.id}`, 'error', tr('prk|This visit has payments; let the car out instead.'));
    db.run("UPDATE pk_sessions SET status = 'void', note = TRIM(COALESCE(note, '') || ' ' || ?), updated_at = ? WHERE id = ?", `Cancelled: ${h.str(req.body.reason, 200) || 'no reason given'}`, now(), s.id);
    h.log(req, 'Cancelled a parking visit', 'pk_session', s.id, `${s.ref} · ${h.str(req.body.reason, 200)}`);
    back(req, res, `/admin/parking/visits/${s.id}`, 'ok', tr('prk|Visit cancelled.'));
  });

  // ---------- cars (every visit) ----------
  router.get('/parking/visits', (req, res) => {
    const status = STATUS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'inside';
    const kind = KIND[req.query.kind] ? req.query.kind : '';
    const q = h.str(req.query.q, 60);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? req.query.day : '';
    const pageNo = Math.max(1, h.int(req.query.page) || 1);
    const where = [];
    const args = [];
    if (status !== 'all') { where.push('s.status = ?'); args.push(status); }
    if (kind) { where.push('s.kind = ?'); args.push(kind); }
    if (day) { where.push('s.entry_at >= ? AND s.entry_at < ?'); args.push(dayStart(day), dayStart(P.addDays(day, 1))); }
    if (q) {
      const c = P.readCredential(q);
      where.push('(s.plate_key LIKE ? OR s.code = ? OR s.ref LIKE ? OR s.card_uid = ?)');
      args.push(`%${c.plate || q}%`, c.code || '', `%${q}%`, c.card || '');
    }
    const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.value(`SELECT COUNT(*) FROM pk_sessions s ${W}`, ...args);
    const per = 60;
    const rows = db.all(`SELECT s.* FROM pk_sessions s ${W} ORDER BY ${status === 'inside' ? 's.entry_at' : 's.entry_at DESC'} LIMIT ? OFFSET ?`, ...args, per, (pageNo - 1) * per);
    const table = ui.table([
      { label: tr('prk|Plate'), render: (s) => `${plate(s.plate)}<small class="sub ltr">${esc(P.codeShow(s.code))}</small>` },
      { label: tr('prk|Type'), render: (s) => kindBadge(s.kind) },
      { label: tr('prk|Came in'), render: (s) => esc(ui.dt(s.entry_at)) },
      { label: tr('prk|Time parked'), render: (s) => esc(dur(minutesOf(s))) },
      { label: tr('prk|Price'), num: true, render: (s) => (s.kind !== 'visitor' ? '—' : s.status === 'inside' ? money(P.quoteOf(s).due) : money(r2(s.fee - s.discount))) },
      { label: tr('Status'), render: (s) => `${statusBadge(s.status)}${s.lost ? ` ${ui.badge('lost', tr('prk|Ticket lost'), 'amber')}` : ''}` },
    ], rows, { href: (s) => `/admin/parking/visits/${s.id}`, empty: esc(tr('prk|No cars match.')) });
    const qs = (p) => `/admin/parking/visits?${new URLSearchParams({ status, ...(kind ? { kind } : {}), ...(q ? { q } : {}), ...(day ? { day } : {}), page: p })}`;
    const pager = total > per ? `<nav class="row pager">${pageNo > 1 ? ui.btn(esc(tr('ops|Previous')), { href: qs(pageNo - 1), cls: 'btn--ghost btn--sm' }) : ''}<span class="muted">${esc(tr('ops|Page {page} of {pages}', { page: pageNo, pages: Math.ceil(total / per) }))}</span>${pageNo * per < total ? ui.btn(esc(tr('ops|Next')), { href: qs(pageNo + 1), cls: 'btn--ghost btn--sm' }) : ''}</nav>` : '';
    const filters = `<form method="get" class="filters">${ui.select('status', tr('Status'), [['inside', tr('prk|Parked now')], ['left', tr('prk|Left')], ['void', tr('prk|Cancelled')], ['all', tr('prk|All')]], status)}${ui.select('kind', tr('prk|Type'), tmap(KIND), kind, { blank: tr('prk|All') })}${ui.input('day', tr('prk|Day'), day, { type: 'date' })}${ui.input('q', tr('prk|Plate, ticket or card'), q)}${ui.btn(esc(tr('prk|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    page(req, res, {
      title: tr('prk|Cars'), crumbs: crumbs([null, tr('prk|Cars')]),
      body: `${tabs('/admin/parking/visits')}${filters}${ui.card(tn(total, 'prk|{n} visit', 'prk|{n} visits'), `${table}${pager}`)}`,
      actions: ui.btn(esc(tr('Export CSV')), { href: `/admin/parking/visits.csv?${new URLSearchParams({ status, ...(day ? { day } : {}) })}`, cls: 'btn--ghost', ic: 'dl' }),
    });
  });
  router.get('/parking/visits.csv', (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? req.query.day : null;
    const from = day ? dayStart(day) : new Date(Date.now() - 31 * 86400000).toISOString();
    const to = day ? dayStart(P.addDays(day, 1)) : '9999';
    const rows = db.all('SELECT * FROM pk_sessions WHERE entry_at >= ? AND entry_at < ? ORDER BY entry_at', from, to);
    const head = [tr('prk|Visit'), tr('prk|Ticket'), tr('prk|Plate'), tr('prk|Type'), tr('prk|Came in'), tr('prk|Left'), tr('prk|Minutes'), tr('prk|Price'), tr('prk|Validated'), tr('prk|Paid'), tr('Status')];
    const lines = rows.map((s) => [s.ref, P.codeShow(s.code), s.plate || '', tr(KIND[s.kind] || s.kind), ui.local(s.entry_at), s.exit_at ? ui.local(s.exit_at) : '', minutesOf(s), s.fee, s.discount, s.paid, tr((STATUS[s.status] || [s.status])[0])]);
    h.log(req, 'Exported', 'export', null, `Parking visits ${day || 'last 31 days'}`);
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="parking-${day || cairo().date}.csv"`).send(`﻿${[head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n')}`);
  });
  router.get('/parking/visits/:id', (req, res, next) => {
    const s = visit(req);
    if (!s) return next();
    const pays = db.all('SELECT p.*, u.name user_name, t.ref till_ref FROM pk_payments p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN pk_tills t ON t.id = p.till_id WHERE p.session_id = ? ORDER BY p.at', s.id);
    const evs = db.all('SELECT e.*, l.name lane_name, u.name user_name FROM pk_events e LEFT JOIN pk_lanes l ON l.id = e.lane_id LEFT JOIN users u ON u.id = e.user_id WHERE e.session_id = ? ORDER BY e.at, e.id', s.id);
    const payTable = ui.table([
      { label: tr('prk|Receipt'), render: (p) => `<a href="/admin/parking/payments/${p.id}/receipt" target="_blank">${esc(p.ref)}</a>` },
      { label: tr('prk|When'), render: (p) => esc(ui.dt(p.at)) },
      { label: tr('prk|How'), render: (p) => `${esc(tr(METHOD[p.method] || p.method))}${p.status !== 'ok' ? ` ${ui.badge('refunded', tr('prk|Refunded'), 'mute')}` : ''}` },
      { label: tr('prk|By'), render: (p) => esc(p.user_name || (p.method === 'online' ? tr('prk|The visitor, online') : p.device || '')) },
      { label: tr('prk|Amount'), num: true, render: (p) => money(p.amount) },
    ], pays, { empty: esc(tr('prk|No payments.')) });
    const timeline = evs.length ? `<ul class="list pk-feed">${evs.map((e) => {
      const [label, tone] = EVENT[e.kind] || [e.kind, 'mute'];
      return `<li><span class="pk-feed__t ltr">${esc(ui.local(e.at).slice(5, 16).replace('T', ' '))}</span>${ui.badge(e.kind, tr(label), tone)}<span class="what"><b>${esc([e.lane_name ? tx(e.lane_name) : null, e.via ? tr(VIA[e.via] || e.via) : null].filter(Boolean).join(' · ') || '—')}</b><small>${esc([e.reason ? tr(REASON[e.reason] || e.reason) : null, e.amount ? ui.money(e.amount) : null, e.user_name].filter(Boolean).join(' · '))}</small></span></li>`;
    }).join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|No gate records.'))}</p>`;
    const cancel = s.status === 'inside' && h.can(req, 'manager') && !(s.paid > 0)
      ? `<details class="upload-box"><summary>${ui.icon('x')}<span>${esc(tr('prk|Cancel this visit'))}</span></summary>${ui.form(`/admin/parking/visits/${s.id}/void`, req.session.csrf, `${ui.input('reason', tr('prk|Why'), '', { required: true, placeholder: tr('prk|e.g. Test at the gate, read twice') })}${ui.btn(esc(tr('prk|Cancel the visit')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })}</details>`
      : '';
    page(req, res, {
      title: s.plate || P.codeShow(s.code), crumbs: crumbs(['/admin/parking/visits', tr('prk|Cars')], [null, s.ref]),
      body: `<div class="grid grid--side"><div class="stack">${visitPanel(req, s, { from: 'visit' })}${cancel}</div><div class="stack">${ui.card(tr('prk|Payments'), payTable)}${ui.card(tr('prk|At the gates'), timeline)}${s.photo_url && /^https:\/\//.test(s.photo_url) ? ui.card(tr('prk|Camera'), `<a href="${esc(s.photo_url)}" target="_blank" rel="noopener noreferrer">${esc(tr('prk|Open the camera picture'))}</a>`) : ''}</div></div>`,
    });
  });

  // ---------- printable ticket and receipt ----------
  const printPage = (title, body) => ui.bare({ title, cls: 'print pk-print', body: `<div class="pk-print__bar noprint"><button type="button" class="btn btn--primary" data-print>${ui.icon('print')}<span>${esc(tr('Print'))}</span></button></div>${body}` });
  router.get('/parking/visits/:id/ticket', (req, res, next) => {
    const s = visit(req);
    if (!s) return next();
    const t = P.tariffOf(s);
    res.type('html').send(printPage(tr('prk|Parking ticket'), `<article class="pk-ticket">
  ${ui.logo('pk-ticket__logo')}
  <p class="eyebrow">${esc(tr('prk|Parking ticket'))}</p>
  ${qr.svg(ticketUrl(req, s), { ecl: 'M', label: tr('prk|Ticket {code}', { code: P.codeShow(s.code) }), cls: 'pk-ticket__qr' })}
  <p class="pk-ticket__code ltr">${esc(P.codeShow(s.code))}</p>
  ${s.plate ? `<p class="pk-ticket__plate"><bdi>${esc(s.plate)}</bdi></p>` : ''}
  <p>${esc(tr('prk|In at {time}', { time: ui.dt(s.entry_at) }))}</p>
  <p class="pk-ticket__rates">${esc(tr('prk|{first} the first hour · {next} each hour after · up to {cap} a day', { first: money(t.first_hour), next: money(t.next_hour), cap: money(t.daily_cap) }))}</p>
  <p class="pk-ticket__help">${esc(tr('prk|Keep this ticket. Pay at a machine, at the exit booth, or scan the code to pay by phone. Shops can scan it to validate your parking.'))}</p>
</article>`));
  });
  router.get('/parking/payments/:id/receipt', (req, res, next) => {
    const p = db.get('SELECT * FROM pk_payments WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    const s = P.sessionBy(p.session_id);
    const vatPct = Number(db.setting('vat_pct')) || 0;
    const vat = vatPct ? r2(p.amount - p.amount / (1 + vatPct / 100)) : 0;
    const s2 = db.settings();
    res.type('html').send(printPage(tr('prk|Parking receipt'), `<article class="pk-ticket">
  ${ui.logo('pk-ticket__logo')}
  <p class="eyebrow">${esc(tr('prk|Parking receipt'))}</p>
  <p class="pk-ticket__code ltr">${esc(p.ref)}</p>
  <dl class="dl"><div><dt>${esc(tr('prk|Plate'))}</dt><dd><bdi>${esc(s.plate || P.codeShow(s.code))}</bdi></dd></div>
  <div><dt>${esc(tr('prk|Came in'))}</dt><dd>${esc(ui.dt(s.entry_at))}</dd></div>
  <div><dt>${esc(tr('prk|Paid at'))}</dt><dd>${esc(ui.dt(p.at))}</dd></div>
  <div><dt>${esc(tr('prk|How'))}</dt><dd>${esc(tr(METHOD[p.method] || p.method))}</dd></div>
  <div><dt>${esc(tr('prk|Amount'))}</dt><dd><b>${money(p.amount)}</b></dd></div>
  ${vat ? `<div><dt>${esc(tr('prk|Includes VAT {pct}%', { pct: vatPct }))}</dt><dd>${money(vat)}</dd></div>` : ''}</dl>
  <p class="pk-ticket__help">${esc([s2.company_name, s2.tax_id ? `${tr('prk|Tax ID')} ${s2.tax_id}` : null].filter(Boolean).join(' · '))}</p>
</article>`));
  });

  // ---------- tills ----------
  router.get('/parking/tills', (req, res) => {
    const rows = db.all('SELECT t.*, u.name user_name FROM pk_tills t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.status = \'open\' DESC, t.opened_at DESC LIMIT 120');
    const total = (t) => (t.status === 'open' ? P.tillTotals(t).total : Object.values(JSON.parse(t.totals || '{}')).reduce((s, x) => s + x.total, 0));
    const diffBadge = (t) => (t.status === 'open' ? ui.badge('open', tr('prk|Open'), 'sky') : !t.difference ? ui.badge('ok', tr('prk|Balanced'), 'ok') : ui.badge('diff', `${t.difference > 0 ? '+' : '−'}${ui.money(Math.abs(t.difference), { cur: false })}`, t.difference < 0 ? 'rose' : 'amber'));
    const table = ui.table([
      { label: tr('prk|Till'), render: (t) => `<b>${esc(t.ref)}</b><small class="sub">${esc(tx(t.name))}</small>` },
      { label: tr('prk|Who'), render: (t) => esc(t.user_name || (t.kind === 'machine' ? tr('prk|Pay machine') : '')) },
      { label: tr('prk|Opened'), render: (t) => esc(ui.dt(t.opened_at)) },
      { label: tr('prk|Closed'), render: (t) => esc(t.closed_at ? ui.dt(t.closed_at) : '—') },
      { label: tr('prk|Taken'), num: true, render: (t) => money(total(t)) },
      { label: tr('prk|Cash count'), render: diffBadge },
    ], rows, { href: (t) => `/admin/parking/tills/${t.id}`, empty: esc(tr('prk|No tills yet. Open one at the booth.')) });
    page(req, res, { title: tr('prk|Tills'), crumbs: crumbs([null, tr('prk|Tills')]), body: `${tabs('/admin/parking/tills')}${ui.card(tr('prk|Tills'), table, { sub: esc(tr('prk|A till is one cashier’s shift, or one pay machine’s day. Closing it counts the cash and sends the takings to the books.')) })}` });
  });
  router.get('/parking/tills/:id', (req, res, next) => {
    const t = P.tillBy(h.int(req.params.id));
    if (!t) return next();
    const tot = t.status === 'open' ? P.tillTotals(t) : { by: JSON.parse(t.totals || '{}'), expectedCash: t.expected_cash };
    const pays = db.all('SELECT p.*, s.plate, s.code FROM pk_payments p JOIN pk_sessions s ON s.id = p.session_id WHERE p.till_id = ? ORDER BY p.at DESC', t.id);
    const mine = t.user_id === req.user.id;
    const canClose = t.status === 'open' && (mine ? h.can(req, 'agent') : h.can(req, 'manager'));
    const sum = `<dl class="dl"><div><dt>${esc(tr('prk|Opened'))}</dt><dd>${esc(ui.dt(t.opened_at))}${t.user_id ? ` · ${esc(userName(t.user_id) || '')}` : ''}</dd></div>
      <div><dt>${esc(tr('prk|Starting cash'))}</dt><dd>${money(t.float)}</dd></div>
      ${Object.entries(tot.by).map(([m, v]) => `<div><dt>${esc(tr(METHOD[m] || m))}</dt><dd>${money(v.total)} <small class="muted">(${ui.n0(v.n)})</small></dd></div>`).join('')}
      <div><dt>${esc(tr('prk|Cash expected'))}</dt><dd><b>${money(tot.expectedCash)}</b></dd></div>
      ${t.status === 'closed' ? `<div><dt>${esc(tr('prk|Cash counted'))}</dt><dd>${money(t.counted)}</dd></div><div><dt>${esc(tr('prk|Difference'))}</dt><dd>${t.difference ? `<b class="${t.difference < 0 ? 'late' : ''}">${money(t.difference)}</b>` : esc(tr('prk|None'))}</dd></div>
      <div><dt>${esc(tr('prk|Closed'))}</dt><dd>${esc(ui.dt(t.closed_at))}${t.closed_by ? ` · ${esc(userName(t.closed_by) || '')}` : ''}</dd></div>
      ${t.invoice_id ? `<div><dt>${esc(tr('prk|In the books'))}</dt><dd><a href="/admin/invoices/${t.invoice_id}/print">${esc(db.value('SELECT ref FROM invoices WHERE id = ?', t.invoice_id) || '')}</a></dd></div>` : ''}` : ''}</dl>`;
    const close = canClose ? ui.card(tr('prk|Close the till'), ui.form(`/admin/parking/tills/${t.id}/close`, req.session.csrf, `<div class="fields">${ui.input('counted', tr('prk|Cash counted in the drawer'), '', { type: 'number', min: 0, step: '0.01', required: true })}${ui.input('note', tr('prk|Note'), '')}</div>${ui.btn(esc(tr('prk|Close and hand over')), { cls: 'btn--primary', attrs: { 'data-confirm': tr('prk|Close this till? No more payments can go into it.') } })}`, { cls: 'stack' }), { sub: esc(tr('prk|Count the cash, including the starting cash.')) }) : '';
    const table = ui.table([
      { label: tr('prk|Receipt'), render: (p) => `<a href="/admin/parking/payments/${p.id}/receipt" target="_blank">${esc(p.ref)}</a>` },
      { label: tr('prk|Plate'), render: (p) => `<bdi>${esc(p.plate || P.codeShow(p.code))}</bdi>` },
      { label: tr('prk|When'), render: (p) => esc(ui.local(p.at).slice(11, 16)) },
      { label: tr('prk|How'), render: (p) => esc(tr(METHOD[p.method] || p.method)) },
      { label: tr('prk|Amount'), num: true, render: (p) => money(p.amount) },
    ], pays, { empty: esc(tr('prk|No payments in this till.')) });
    page(req, res, { title: `${tr('prk|Till')} ${t.ref}`, crumbs: crumbs(['/admin/parking/tills', tr('prk|Tills')], [null, t.ref]), body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('prk|Payments'), table)}</div><div class="stack">${ui.card(tx(t.name), sum, { sub: t.status === 'open' ? ui.badge('open', tr('prk|Open'), 'sky') : ui.badge('closed', tr('prk|Closed'), 'mute') })}${close}</div></div>` });
  });
  router.post('/parking/tills/:id/close', RA, (req, res, next) => {
    const t = P.tillBy(h.int(req.params.id));
    if (!t) return next();
    if (t.user_id !== req.user.id && !h.can(req, 'manager')) return h.auth.denied(req, res);
    const counted = h.numv(req.body.counted);
    if (counted === null || counted < 0) return back(req, res, `/admin/parking/tills/${t.id}`, 'error', tr('prk|Enter the cash you counted.'));
    try {
      const c = P.closeTill(t, { counted, user: req.user, note: h.str(req.body.note, 300) || null });
      h.log(req, 'Closed a parking till', 'pk_till', t.id, `${t.ref} · difference ${c.difference}`);
      back(req, res, `/admin/parking/tills/${t.id}`, c.difference ? 'error' : 'ok', c.difference ? tr('prk|Till closed with a difference of {amount}.', { amount: money(c.difference) }) : tr('prk|Till closed. The cash is right.'));
    } catch (e) {
      fail(req, res, `/admin/parking/tills/${t.id}`, e);
    }
  });

  // ---------- subscriptions ----------
  const planOpts = () => db.all('SELECT * FROM pk_plans WHERE active = 1 ORDER BY kind, price');
  const planName = (p) => (p ? (isAr() && p.name_ar ? p.name_ar : tx(p.name)) : '');
  router.get('/parking/subscriptions', (req, res) => {
    const status = P_STATUS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'active';
    const holder = HOLDER[req.query.holder] ? req.query.holder : '';
    const q = h.str(req.query.q, 60);
    const where = [];
    const args = [];
    if (status !== 'all') { where.push('p.status = ?'); args.push(status); }
    if (holder) { where.push('p.holder = ?'); args.push(holder); }
    if (q) { where.push('(p.name LIKE ? OR p.ref LIKE ? OR p.plate_keys LIKE ? OR p.card_uid = ? OR b.name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${P.plateKey(q)}%`, P.cardKey(q), `%${q}%`); }
    const rows = db.all(`SELECT p.*, b.name brand_name, pl.name plan_name, pl.name_ar plan_name_ar,
      (SELECT COUNT(*) FROM pk_sessions s WHERE s.permit_id = p.id AND s.status = 'inside') inside FROM pk_permits p LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN pk_plans pl ON pl.id = p.plan_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.status = 'active' DESC, p.name LIMIT 300`, ...args);
    const stats = db.get("SELECT COUNT(*) n, COALESCE(SUM(price * 1.0 / months), 0) monthly, SUM(holder = 'tenant') tenants, SUM(holder = 'staff') staff FROM pk_permits WHERE status = 'active'");
    const kpis = [
      ui.kpi({ label: tr('prk|Active subscriptions'), value: ui.n0(stats.n) }),
      ui.kpi({ label: tr('prk|Billed each month'), value: money(r2(stats.monthly)) }),
      ui.kpi({ label: tr('prk|For tenants’ staff'), value: ui.n0(stats.tenants || 0) }),
      ui.kpi({ label: tr('prk|Suspended'), value: ui.n0(db.value("SELECT COUNT(*) FROM pk_permits WHERE status = 'suspended'")), href: '/admin/parking/subscriptions?status=suspended' }),
    ].join('');
    const table = ui.table([
      { label: tr('prk|Subscription'), render: (p) => `<b>${esc(tx(p.name))}</b><small class="sub">${esc(p.ref)}${p.brand_name ? ` · ${esc(p.brand_name)}` : ''}</small>` },
      { label: tr('prk|Type'), render: (p) => `${esc(tr(HOLDER[p.holder] || p.holder))}${p.plan_id ? `<small class="sub">${esc(isAr() && p.plan_name_ar ? p.plan_name_ar : tx(p.plan_name || ''))}</small>` : ''}` },
      { label: tr('prk|Plates and card'), render: (p) => `${(p.plates || '').split(', ').filter(Boolean).map((x) => plate(x, 'pk-plate--sm')).join(' ')}${p.card_uid ? `<small class="sub ltr">${ui.icon('nfc')} ${esc(p.card_uid)}</small>` : ''}` },
      { label: tr('prk|Price'), num: true, render: (p) => (p.price ? `${money(p.price)}<small class="sub">${esc(tn(p.months, 'prk|every month', 'prk|every {n} months'))}</small>` : esc(tr('prk|Free'))) },
      { label: tr('prk|Until'), render: (p) => esc(p.ends_on ? ui.date(p.ends_on) : tr('prk|Ongoing')) },
      { label: tr('Status'), render: (p) => `${pBadge(p.status)}${p.inside ? ` ${ui.badge('in', tr('prk|Parked'), 'ok')}` : ''}` },
    ], rows, { href: (p) => `/admin/parking/subscriptions/${p.id}`, empty: esc(tr('prk|No subscriptions match.')) });
    const filters = `<form method="get" class="filters">${ui.select('status', tr('Status'), [...tmap(P_STATUS), ['all', tr('prk|All')]], status)}${ui.select('holder', tr('prk|Type'), tmap(HOLDER), holder, { blank: tr('prk|All') })}${ui.input('q', tr('prk|Name, plate or card'), q)}${ui.btn(esc(tr('prk|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    const due = db.value("SELECT COUNT(*) FROM pk_permits WHERE status IN ('active','suspended') AND price > 0 AND next_bill_on IS NOT NULL AND next_bill_on <= ?", today());
    const actions = [
      h.can(req, 'manager') ? ui.btn(esc(tr('prk|New subscription')), { href: '/admin/parking/subscriptions/new', cls: 'btn--primary', ic: 'plus' }) : '',
      h.can(req, 'manager') && due ? ui.form('/admin/parking/subscriptions/bill', req.session.csrf, ui.btn(esc(tn(due, 'prk|Bill {n} due now', 'prk|Bill {n} due now')), { cls: 'btn--ghost' })) : '',
    ].join('');
    page(req, res, { title: tr('prk|Subscriptions'), crumbs: crumbs([null, tr('prk|Subscriptions')]), actions, body: `${tabs('/admin/parking/subscriptions')}<div class="kpis kpis--4">${kpis}</div>${filters}${ui.card(tr('prk|Subscriptions'), table, { sub: esc(tr('prk|Monthly parking on a plate or an NFC card. Invoices go out automatically at the start of each period; a subscription is suspended when its invoice is {n} days late.', { n: P.N('prk_suspend_days') })) })}` });
  });
  function permitForm(req, p = {}) {
    const plans = planOpts();
    const employees = hasTable('employees') ? db.all("SELECT id, name FROM employees WHERE status = 'active' ORDER BY name") : [];
    return `<div class="fields">
      ${ui.select('plan_id', tr('prk|Plan'), plans.map((x) => [x.id, `${planName(x)} · ${x.price ? `${ui.money(x.price)} / ${tn(x.months, 'prk|month', 'prk|{n} months')}` : tr('prk|Free')}`]), p.plan_id || '', { blank: tr('prk|No plan (set the price below)') })}
      ${ui.select('holder', tr('prk|For'), tmap(HOLDER), p.holder || 'individual')}
      ${ui.select('brand_id', tr('prk|Tenant'), tenants().map((b) => [b.id, b.name]), p.brand_id || '', { blank: tr('prk|Only for tenant staff') })}
      ${employees.length ? ui.select('employee_id', tr('prk|Employee'), employees.map((e) => [e.id, e.name]), p.employee_id || '', { blank: tr('prk|Only for mall staff') }) : ''}
      ${ui.input('name', tr('Name'), p.name || '', { required: true, placeholder: tr('prk|The driver, or the company') })}
      ${ui.input('phone', tr('prk|Mobile'), p.phone || '', { type: 'tel' })}
      ${ui.input('email', tr('Email'), p.email || '', { type: 'email' })}
      ${ui.input('plates', tr('prk|Plates'), p.plates || '', { placeholder: 'ق ص ر 1234، س ع د 777', hint: tr('prk|Up to six, separated by commas.') })}
      ${ui.input('card_uid', tr('prk|NFC card number'), p.card_uid || '', { placeholder: '04:A3:2B:1C:9F:61:80', hint: tr('prk|Tap the card on a reader plugged into this device, or type the number printed on it.'), attrs: { 'data-nfc-field': true, autocomplete: 'off' } })}
      ${ui.input('cars', tr('prk|Cars inside at once'), p.cars || 1, { type: 'number', min: 1, max: 10 })}
      ${ui.input('price', tr('prk|Price per period'), p.price ?? '', { type: 'number', min: 0, step: '0.01', hint: tr('prk|Including VAT. Leave empty to use the plan’s price.') })}
      ${ui.input('months', tr('prk|Months per period'), p.months || '', { type: 'number', min: 1, max: 12, hint: tr('prk|Leave empty to use the plan’s.') })}
      ${ui.input('starts_on', tr('prk|Starts'), p.starts_on || today(), { type: 'date', required: true })}
      ${ui.input('ends_on', tr('prk|Ends'), p.ends_on || '', { type: 'date', hint: tr('prk|Empty: until cancelled.') })}
      ${ui.textarea('notes', tr('prk|Notes'), p.notes || '', { rows: 2, cls: 'span-all' })}
    </div><label class="check"><input type="checkbox" name="auto_renew" value="1"${p.auto_renew === 0 ? '' : ' checked'}> ${esc(tr('prk|Renew by itself at the end of each period'))}</label>`;
  }
  const permitInput = (b) => {
    const plan = b.plan_id ? db.get('SELECT * FROM pk_plans WHERE id = ?', h.int(b.plan_id)) : null;
    const price = b.price === '' || b.price === undefined ? (plan ? plan.price : 0) : h.numv(b.price);
    return {
      plan_id: plan ? plan.id : null, holder: b.holder, brand_id: h.int(b.brand_id), employee_id: h.int(b.employee_id), name: h.str(b.name, 120), phone: h.str(b.phone, 40) || null,
      email: h.str(b.email, 160) || null, plates: h.str(b.plates, 200), card_uid: h.str(b.card_uid, 40), zone_id: plan ? plan.zone_id : null,
      cars: h.int(b.cars) || (plan ? plan.cars : 1), price, months: h.int(b.months) || (plan ? plan.months : 1), starts_on: h.str(b.starts_on, 10), ends_on: h.str(b.ends_on, 10) || null,
      auto_renew: b.auto_renew === '1', notes: h.str(b.notes, 1000) || null,
    };
  };
  router.get('/parking/subscriptions/new', RM, (req, res) => {
    page(req, res, { title: tr('prk|New subscription'), crumbs: crumbs(['/admin/parking/subscriptions', tr('prk|Subscriptions')], [null, tr('prk|New')]), body: ui.card(tr('prk|New subscription'), ui.form('/admin/parking/subscriptions', req.session.csrf, `${permitForm(req, { holder: req.query.holder, brand_id: h.int(req.query.brand) })}${ui.btn(esc(tr('prk|Create')), { cls: 'btn--primary' })}`, { cls: 'stack' })) });
  });
  router.post('/parking/subscriptions', RM, (req, res) => {
    try {
      const p = P.savePermit(permitInput(req.body), { user: req.user });
      h.log(req, 'Created a parking subscription', 'pk_permit', p.id, `${p.ref} · ${p.name}`);
      back(req, res, `/admin/parking/subscriptions/${p.id}`, 'ok', tr('prk|Subscription {ref} created.', { ref: p.ref }));
    } catch (e) {
      fail(req, res, '/admin/parking/subscriptions/new', e);
    }
  });
  router.get('/parking/subscriptions/:id', (req, res, next) => {
    const p = db.get('SELECT p.*, b.name brand_name, e.name employee_name FROM pk_permits p LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN employees e ON e.id = p.employee_id WHERE p.id = ?', h.int(req.params.id));
    if (!p) return next();
    const plan = p.plan_id ? db.get('SELECT * FROM pk_plans WHERE id = ?', p.plan_id) : null;
    const invoices = db.all("SELECT * FROM invoices WHERE source = 'parking-permit' AND source_id = ? ORDER BY due_date DESC LIMIT 24", p.id);
    const visits = db.all('SELECT * FROM pk_sessions WHERE permit_id = ? ORDER BY entry_at DESC LIMIT 20', p.id);
    const csrf = req.session.csrf;
    const mgr = h.can(req, 'manager');
    const facts = `<dl class="dl"><div><dt>${esc(tr('Status'))}</dt><dd>${pBadge(p.status)}${p.status_reason ? ` <small class="muted">${esc(tr({ unpaid: 'prk|Invoices not paid', left: 'prk|No longer works here' }[p.status_reason] || 'prk|Note'))}</small>` : ''}</dd></div>
      <div><dt>${esc(tr('prk|For'))}</dt><dd>${esc(tr(HOLDER[p.holder]))}${p.brand_name ? ` · <a href="/admin/brands/${p.brand_id}">${esc(p.brand_name)}</a>` : ''}${p.employee_name ? ` · ${esc(p.employee_name)}` : ''}</dd></div>
      ${plan ? `<div><dt>${esc(tr('prk|Plan'))}</dt><dd>${esc(planName(plan))}</dd></div>` : ''}
      <div><dt>${esc(tr('prk|Plates'))}</dt><dd>${(p.plates || '').split(', ').filter(Boolean).map((x) => plate(x, 'pk-plate--sm')).join(' ') || '—'}</dd></div>
      <div><dt>${esc(tr('prk|NFC card'))}</dt><dd>${p.card_uid ? `<span class="ltr">${esc(p.card_uid)}</span>` : '—'}</dd></div>
      <div><dt>${esc(tr('prk|Cars inside at once'))}</dt><dd>${ui.n0(p.cars)}</dd></div>
      <div><dt>${esc(tr('prk|Price'))}</dt><dd>${p.price ? `${money(p.price)} · ${esc(tn(p.months, 'prk|every month', 'prk|every {n} months'))}` : esc(tr('prk|Free'))}</dd></div>
      <div><dt>${esc(tr('prk|Valid'))}</dt><dd>${esc(ui.date(p.starts_on))} – ${esc(p.ends_on ? ui.date(p.ends_on) : tr('prk|Ongoing'))}${p.auto_renew ? ` · ${esc(tr('prk|renews by itself'))}` : ''}</dd></div>
      ${p.next_bill_on && p.price ? `<div><dt>${esc(tr('prk|Next invoice'))}</dt><dd>${esc(ui.date(p.next_bill_on))}</dd></div>` : ''}
      ${p.phone || p.email ? `<div><dt>${esc(tr('prk|Contact'))}</dt><dd>${esc([p.phone, p.email].filter(Boolean).join(' · '))}</dd></div>` : ''}
      ${p.notes ? `<div><dt>${esc(tr('prk|Notes'))}</dt><dd>${esc(tx(p.notes))}</dd></div>` : ''}</dl>`;
    const statusBtns = mgr ? `<div class="row">${[
      p.status === 'active' ? ['suspended', 'prk|Suspend'] : null,
      p.status !== 'active' && p.status !== 'cancelled' ? ['active', 'prk|Reactivate'] : null,
      p.status !== 'cancelled' ? ['cancelled', 'prk|Cancel'] : null,
    ].filter(Boolean).map(([s, l]) => ui.form(`/admin/parking/subscriptions/${p.id}/status`, csrf, `<input type="hidden" name="status" value="${s}">${ui.btn(esc(tr(l)), { cls: 'btn--ghost btn--sm', attrs: s === 'cancelled' ? { 'data-confirm': tr('prk|Cancel this subscription? Its plates park as visitors from now on.') } : {} })}`)).join('')}${ui.btn(esc(tr('prk|Edit')), { href: `/admin/parking/subscriptions/${p.id}/edit`, cls: 'btn--ghost btn--sm' })}</div>` : '';
    const invTable = ui.table([
      { label: tr('Invoice'), render: (i) => `<a href="/admin/invoices/${i.id}/print">${esc(i.ref)}</a>` },
      { label: tr('prk|Period'), render: (i) => esc(`${ui.date(i.period_start)} – ${ui.date(i.period_end)}`) },
      { label: tr('prk|Amount'), num: true, render: (i) => money(i.total) },
      { label: tr('Status'), render: (i) => ui.badge(i.status, M.INVOICE_STATUS[i.status] || i.status) },
    ], invoices, { empty: esc(tr('prk|No invoices yet.')) });
    const visTable = ui.table([
      { label: tr('prk|Came in'), render: (s) => esc(ui.dt(s.entry_at)) },
      { label: tr('prk|Plate'), render: (s) => `<bdi>${esc(s.plate || '')}</bdi>` },
      { label: tr('prk|Time parked'), render: (s) => esc(dur(minutesOf(s))) },
      { label: tr('Status'), render: (s) => statusBadge(s.status) },
    ], visits, { href: (s) => `/admin/parking/visits/${s.id}`, empty: esc(tr('prk|Has not parked yet.')) });
    page(req, res, { title: tx(p.name), crumbs: crumbs(['/admin/parking/subscriptions', tr('prk|Subscriptions')], [null, p.ref]), body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('prk|Invoices'), invTable)}${ui.card(tr('prk|Visits'), visTable)}</div><div class="stack">${ui.card(p.ref, `${facts}${statusBtns}`)}</div></div>` });
  });
  router.get('/parking/subscriptions/:id/edit', RM, (req, res, next) => {
    const p = db.get('SELECT * FROM pk_permits WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    page(req, res, { title: tr('prk|Edit subscription'), crumbs: crumbs(['/admin/parking/subscriptions', tr('prk|Subscriptions')], [`/admin/parking/subscriptions/${p.id}`, p.ref], [null, tr('prk|Edit')]), body: ui.card(p.ref, ui.form(`/admin/parking/subscriptions/${p.id}`, req.session.csrf, `${permitForm(req, p)}${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' })) });
  });
  router.post('/parking/subscriptions/bill', RM, (req, res) => {
    const n = P.billPermits(today(), { user: req.user });
    h.log(req, 'Billed parking subscriptions', 'pk_permit', null, String(n));
    back(req, res, '/admin/parking/subscriptions', 'ok', tn(n, 'prk|{n} invoice created.', 'prk|{n} invoices created.'));
  });
  router.post('/parking/subscriptions/:id', RM, (req, res, next) => {
    const p = db.get('SELECT * FROM pk_permits WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    try {
      P.savePermit(permitInput(req.body), { id: p.id, user: req.user });
      h.log(req, 'Updated a parking subscription', 'pk_permit', p.id, p.ref);
      back(req, res, `/admin/parking/subscriptions/${p.id}`, 'ok', tr('Saved.'));
    } catch (e) {
      fail(req, res, `/admin/parking/subscriptions/${p.id}/edit`, e);
    }
  });
  router.post('/parking/subscriptions/:id/status', RM, (req, res, next) => {
    const p = db.get('SELECT * FROM pk_permits WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    try {
      const s = P.setPermitStatus(p, String(req.body.status), req.body.status === 'active' ? null : 'manual');
      h.log(req, 'Changed a parking subscription', 'pk_permit', p.id, `${p.ref} · ${s.status}`);
      back(req, res, `/admin/parking/subscriptions/${p.id}`, 'ok', tr('Saved.'));
    } catch (e) {
      fail(req, res, `/admin/parking/subscriptions/${p.id}`, e);
    }
  });

  // ---------- validations ----------
  router.get('/parking/validations', (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.m || '')) ? req.query.m : today().slice(0, 7);
    const rows = db.all(`SELECT v.brand_id, b.name, COUNT(*) n, SUM(v.value) value, SUM(v.value * v.share / 100.0) shop, SUM(CASE WHEN v.invoice_id IS NOT NULL THEN v.value * v.share / 100.0 ELSE 0 END) billed
      FROM pk_validations v LEFT JOIN brands b ON b.id = v.brand_id WHERE v.status = 'ok' AND substr(v.at, 1, 7) = ? GROUP BY v.brand_id ORDER BY n DESC`, month);
    const tot = rows.reduce((s, r) => ({ n: s.n + r.n, value: s.value + (r.value || 0), shop: s.shop + (r.shop || 0) }), { n: 0, value: 0, shop: 0 });
    const toBill = db.value(`SELECT COALESCE(SUM(v.value * v.share / 100.0), 0) FROM pk_validations v JOIN pk_sessions s ON s.id = v.session_id WHERE v.status = 'ok' AND v.brand_id IS NOT NULL AND v.payer != 'mall' AND v.invoice_id IS NULL AND s.status = 'left' AND substr(v.at, 1, 7) = ?`, month);
    const kpis = [
      ui.kpi({ label: tr('prk|Validations'), value: ui.n0(tot.n) }),
      ui.kpi({ label: tr('prk|Parking given free'), value: money(r2(tot.value)) }),
      ui.kpi({ label: tr('prk|Paid by shops'), value: money(r2(tot.shop)) }),
      ui.kpi({ label: tr('prk|Paid by the mall'), value: money(r2(tot.value - tot.shop)) }),
    ].join('');
    const rule = (bid) => P.ruleFor(bid);
    const table = ui.table([
      { label: tr('prk|Shop'), render: (r) => (r.brand_id ? `<b>${esc(r.name)}</b>` : `<b>${esc(tr('prk|The mall'))}</b>`) },
      { label: tr('prk|Validations'), num: true, render: (r) => ui.n0(r.n) },
      { label: tr('prk|Worth'), num: true, render: (r) => money(r2(r.value || 0)) },
      { label: tr('prk|Shop pays'), num: true, render: (r) => (r.brand_id ? money(r2(r.shop || 0)) : '—') },
      { label: tr('prk|Billed'), num: true, render: (r) => (r.brand_id && r.billed ? money(r2(r.billed)) : '—') },
      { label: tr('prk|Rule'), render: (r) => {
        if (!r.brand_id) return '';
        const x = rule(r.brand_id);
        return `<small>${esc([x.minutes ? dur(x.minutes) : tr('prk|The whole visit'), x.min_purchase ? tr('prk|from {amount}', { amount: ui.money(x.min_purchase) }) : null, tr(PAYER[x.payer]), x.payer === 'split' ? `${x.share}%` : null].filter(Boolean).join(' · '))}</small>${h.can(req, 'manager') ? ` <a href="/admin/parking/validations/rules/${r.brand_id}">${esc(tr('prk|Change'))}</a>` : ''}`;
      } },
    ], rows, { empty: esc(tr('prk|No validations this month.')) });
    const months = [...new Set([today().slice(0, 7), ...db.all('SELECT DISTINCT substr(at, 1, 7) m FROM pk_validations ORDER BY m DESC LIMIT 12').map((x) => x.m)])].sort().reverse();
    const pick = `<form method="get" class="filters">${ui.select('m', tr('prk|Month'), months.map((m) => [m, ui.monthYear(m)]), month)}${ui.btn(esc(tr('prk|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    const recent = db.all(`SELECT v.*, s.plate, s.code, b.name brand FROM pk_validations v JOIN pk_sessions s ON s.id = v.session_id LEFT JOIN brands b ON b.id = v.brand_id WHERE substr(v.at, 1, 7) = ? ORDER BY v.at DESC LIMIT 30`, month);
    const recentTable = ui.table([
      { label: tr('prk|When'), render: (v) => esc(ui.dt(v.at)) },
      { label: tr('prk|Shop'), render: (v) => esc(v.brand || tr('prk|The mall')) },
      { label: tr('prk|Plate'), render: (v) => `<bdi>${esc(v.plate || P.codeShow(v.code))}</bdi>` },
      { label: tr('prk|Free time'), render: (v) => esc(v.whole ? tr('prk|The whole visit') : dur(v.minutes)) },
      { label: tr('prk|How'), render: (v) => esc(tr(VIA[v.via] || v.via)) },
      { label: tr('prk|Worth'), num: true, render: (v) => (v.status === 'ok' ? money(v.value) : ui.badge('void', tr('prk|Removed'), 'mute')) },
    ], recent, { href: (v) => `/admin/parking/visits/${v.session_id}`, empty: esc(tr('prk|No validations this month.')) });
    const billBtn = h.can(req, 'manager') && toBill > 0 ? ui.form('/admin/parking/validations/bill', req.session.csrf, `<input type="hidden" name="m" value="${month}">${ui.btn(esc(tr('prk|Bill the shops {amount}', { amount: money(r2(toBill)) })), { cls: 'btn--primary', attrs: { 'data-confirm': tr('prk|Create the shops’ invoices for {month}?', { month: ui.monthYear(month) }) } })}`) : '';
    const others = h.can(req, 'manager') ? `<form method="get" action="/admin/parking/validations/rules" class="row">${ui.select('brand', tr('prk|Set a shop’s rule'), tenants().map((b) => [b.id, b.name]), '', { blank: tr('prk|Choose a shop') })}${ui.btn(esc(tr('prk|Open')), { cls: 'btn--ghost btn--sm' })}</form>` : '';
    page(req, res, {
      title: tr('prk|Validations'), crumbs: crumbs([null, tr('prk|Validations')]), actions: billBtn,
      body: `${tabs('/admin/parking/validations')}${pick}<div class="kpis kpis--4">${kpis}</div><div class="grid grid--side">${ui.card(tr('prk|By shop'), `${table}${others}`, { sub: esc(tr('prk|Shops validate parking for their customers from the tenant portal, by scanning the ticket’s QR code, tapping the NFC card or typing the plate.')) })}${ui.card(tr('prk|Latest'), recentTable)}</div>`,
    });
  });
  router.get('/parking/validations/rules', RM, (req, res) => res.redirect(303, h.int(req.query.brand) ? `/admin/parking/validations/rules/${h.int(req.query.brand)}` : '/admin/parking/validations'));
  router.get('/parking/validations/rules/:brand', RM, (req, res, next) => {
    const b = db.get('SELECT id, name FROM brands WHERE id = ?', h.int(req.params.brand));
    if (!b) return next();
    const own = db.get('SELECT * FROM pk_validators WHERE brand_id = ?', b.id) || {};
    const form = ui.form(`/admin/parking/validations/rules/${b.id}`, req.session.csrf, `<label class="check"><input type="checkbox" name="active" value="1"${own.active === 0 ? '' : ' checked'}> ${esc(tr('prk|This shop can validate parking'))}</label>
      <div class="fields">${ui.select('minutes', tr('prk|Free time'), [['', tr('prk|The mall’s default')], ...VAL_MINUTES.map(([k, l]) => [k, tr(l)])], own.minutes ?? '')}
      ${ui.input('min_purchase', tr('prk|Smallest purchase'), own.min_purchase ?? '', { type: 'number', min: 0, step: 1, hint: tr('prk|Empty: the mall’s default ({amount}).', { amount: ui.money(Number(P.S('prk_val_min_purchase'))) }) })}
      ${ui.select('payer', tr('prk|Who pays'), [['', tr('prk|The mall’s default')], ...tmap(PAYER)], own.payer ?? '')}
      ${ui.input('share', tr('prk|Shop’s share when shared (%)'), own.share ?? '', { type: 'number', min: 0, max: 100, step: 1 })}
      ${ui.input('monthly_cap', tr('prk|Validations a month'), own.monthly_cap ?? '', { type: 'number', min: 0, step: 1, hint: tr('prk|Empty or 0: no limit.') })}</div>
      ${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    page(req, res, { title: b.name, crumbs: crumbs(['/admin/parking/validations', tr('prk|Validations')], [null, b.name]), body: ui.card(tr('prk|Validation rule'), form, { sub: esc(tr('prk|What a validation from {name} gives, and who pays for it.', { name: b.name })) }) });
  });
  router.post('/parking/validations/rules/:brand', RM, (req, res, next) => {
    const b = db.get('SELECT id, name FROM brands WHERE id = ?', h.int(req.params.brand));
    if (!b) return next();
    const num = (v) => (v === '' || v === undefined ? null : Math.max(0, Number(v) || 0));
    db.run(`INSERT INTO pk_validators (brand_id, active, minutes, min_purchase, payer, share, monthly_cap, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(brand_id) DO UPDATE SET active = excluded.active, minutes = excluded.minutes, min_purchase = excluded.min_purchase, payer = excluded.payer, share = excluded.share, monthly_cap = excluded.monthly_cap, updated_at = excluded.updated_at`,
    b.id, req.body.active === '1' ? 1 : 0, num(req.body.minutes), num(req.body.min_purchase), PAYER[req.body.payer] ? req.body.payer : null, num(req.body.share) === null ? null : Math.min(100, num(req.body.share)), num(req.body.monthly_cap), now());
    h.log(req, 'Set a parking validation rule', 'brand', b.id, b.name);
    back(req, res, '/admin/parking/validations', 'ok', tr('Saved.'));
  });
  router.post('/parking/validations/bill', RM, (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.body.m || '')) ? req.body.m : today().slice(0, 7);
    const list = P.billValidations(month, { user: req.user });
    h.log(req, 'Billed shops for parking validations', 'pk_validation', null, `${month} · ${list.length}`);
    back(req, res, `/admin/parking/validations?m=${month}`, 'ok', tn(list.length, 'prk|{n} invoice created.', 'prk|{n} invoices created.'));
  });

  // ---------- reports ----------
  router.get('/parking/reports', (req, res) => {
    const days = PERIODS[req.query.p] ? Number(req.query.p) : 30;
    const d = today();
    const from = dayStart(P.addDays(d, -(days - 1)));
    const visits = db.all("SELECT kind, entry_at, exit_at, fee, discount, paid, status FROM pk_sessions WHERE entry_at >= ? AND status != 'void'", from);
    const pays = db.all("SELECT amount, method, at FROM pk_payments WHERE at >= ? AND status = 'ok'", from);
    const dates = Array.from({ length: days }, (_, i) => P.addDays(d, -(days - 1) + i));
    const byDay = new Map(dates.map((x) => [x, { cars: 0, money: 0 }]));
    for (const v of visits) { const k = cairoDate(v.entry_at); if (byDay.has(k)) byDay.get(k).cars++; }
    for (const p of pays) { const k = cairoDate(p.at); if (byDay.has(k)) byDay.get(k).money += p.amount; }
    const series = dates.map((x) => ({ label: days <= 31 ? String(Number(x.slice(8))) : x.slice(8) === '01' ? ui.monthName(Number(x.slice(5, 7))) : '', ...byDay.get(x) }));
    const total = r2(pays.reduce((s, p) => s + p.amount, 0));
    const left = visits.filter((v) => v.status === 'left' && v.kind === 'visitor');
    const avg = left.length ? left.reduce((s, v) => s + T.minutesBetween(v.entry_at, v.exit_at), 0) / left.length : null;
    const free = r2(left.reduce((s, v) => s + (v.discount || 0), 0));
    const BUCKETS = [[60, 'prk|Under 1 h'], [120, 'prk|1–2 h'], [180, 'prk|2–3 h'], [300, 'prk|3–5 h'], [480, 'prk|5–8 h'], [1440, 'prk|8–24 h'], [Infinity, 'prk|Over a day']];
    const stays = BUCKETS.map(([max, l], i) => ({ label: tr(l), n: left.filter((v) => { const m = T.minutesBetween(v.entry_at, v.exit_at); return m < max && m >= (i ? BUCKETS[i - 1][0] : 0); }).length }));
    const methods = Object.entries(pays.reduce((o, p) => ({ ...o, [p.method]: (o[p.method] || 0) + p.amount }), {})).map(([m, v]) => ({ label: tr(METHOD[m] || m), value: r2(v), display: money(r2(v)) }));
    const kinds = Object.entries(visits.reduce((o, v) => ({ ...o, [v.kind]: (o[v.kind] || 0) + 1 }), {})).map(([k, n]) => ({ label: tr(KIND[k] || k), value: n }));
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const v of visits) { const c = cairo(new Date(v.entry_at)); const wd = (new Date(`${c.date}T00:00:00Z`).getUTCDay() + 6) % 7; heat[wd][c.hour]++; }
    const weeks = Math.max(1, days / 7);
    const hmax = Math.max(1, ...heat.flat());
    const hrs = Array.from({ length: 24 }, (_, i) => i).filter((hr) => heat.some((r) => r[hr] > 0));
    const names = ui.weekdays();
    const heatHtml = hrs.length ? `<div class="ftf-heat" style="--c:${hrs.length}"><span></span>${hrs.map((hr) => `<span class="ftf-heat__h">${hr % 3 === 0 ? String(hr).padStart(2, '0') : ''}</span>`).join('')}${heat.map((row, wd) => `<span class="ftf-heat__d">${esc(names[wd])}</span>${hrs.map((hr) => `<span class="ftf-heat__c" style="--f:${(row[hr] / hmax).toFixed(2)}" title="${esc(`${names[wd]} ${String(hr).padStart(2, '0')}:00 · ${(row[hr] / weeks).toFixed(1)}`)}"></span>`).join('')}`).join('')}</div>` : `<p class="muted pad">${esc(tr('prk|Not enough visits yet.'))}</p>`;
    const subs = db.value("SELECT COALESCE(SUM(total), 0) FROM invoices WHERE source = 'parking-permit' AND status != 'void' AND due_date >= ?", P.addDays(d, -(days - 1)));
    const kpis = [
      ui.kpi({ label: tr('prk|Visits'), value: ui.n0(visits.length), sub: esc(tr('prk|{n} a day on average', { n: ui.n0(Math.round(visits.length / days)) })) }),
      ui.kpi({ label: tr('prk|Parking takings'), value: money(total), sub: esc(tr('prk|plus {amount} in subscriptions', { amount: money(subs) })) }),
      ui.kpi({ label: tr('prk|Average visit'), value: avg === null ? '—' : esc(dur(avg)) }),
      ui.kpi({ label: tr('prk|Given free by validations'), value: money(free) }),
    ].join('');
    const periodTabs = `<nav class="tabs">${Object.entries(PERIODS).map(([k, l]) => `<a class="tab${String(days) === k ? ' is-on' : ''}" href="/admin/parking/reports?p=${k}">${esc(tr(l))}</a>`).join('')}</nav>`;
    const body = `${tabs('/admin/parking/reports')}${periodTabs}<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side">${ui.card(tr('prk|Takings by day'), ui.bars(series, { key: 'money', label: 'label', h: 160, fmtv: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : ui.n0(v)) }))}${ui.card(tr('prk|How visitors paid'), methods.length ? ui.donut(methods, { label: ui.money(total, { compact: true, cur: false }) }) : `<p class="muted pad">${esc(tr('prk|No payments in this period.'))}</p>`)}</div>
<div class="grid grid--side">${ui.card(tr('prk|Cars by day'), ui.bars(series, { key: 'cars', label: 'label', h: 160, tone: 'sea' }))}${ui.card(tr('prk|Who parks'), kinds.length ? ui.donut(kinds, { label: ui.n0(visits.length) }) : `<p class="muted pad">${esc(tr('prk|Not enough visits yet.'))}</p>`)}</div>
<div class="grid grid--side">${ui.card(tr('prk|When cars arrive'), heatHtml, { sub: esc(tr('prk|Arrivals by weekday and hour')) })}${ui.card(tr('prk|How long visitors stay'), ui.bars(stays, { key: 'n', label: 'label', h: 150, tone: 'cocoa' }))}</div>`;
    page(req, res, { title: tr('prk|Parking reports'), crumbs: crumbs([null, tr('prk|Reports')]), body, actions: ui.btn(esc(tr('Export CSV')), { href: '/admin/parking/visits.csv', cls: 'btn--ghost', ic: 'dl' }) });
  });

  // ---------- set-up ----------
  router.get('/parking/setup', (req, res) => {
    const csrf = req.session.csrf;
    const mgr = h.can(req, 'manager');
    const zs = P.zones({ all: true });
    const zoneTable = ui.table([
      { label: tr('prk|Level'), render: (z) => `<b>${esc(zoneName(z))}</b><small class="sub">${esc(z.code)}${z.level ? ` · ${esc(z.level)}` : ''} · ${esc(tr(ZONE_KIND[z.kind] || z.kind))}${z.active ? '' : ` · ${esc(tr('prk|Hidden'))}`}</small>` },
      { label: tr('prk|Spaces'), num: true, render: (z) => (mgr ? ui.form(`/admin/parking/zones/${z.id}`, csrf, `<input class="pk-num" type="number" name="capacity" min="0" value="${z.capacity}" aria-label="${esc(tr('prk|Spaces'))}"><input type="hidden" name="active" value="${z.active}">${ui.btn(esc(tr('Save')), { cls: 'btn--ghost btn--xs' })}`, { cls: 'row' }) : ui.n0(z.capacity)) },
      { label: '', render: (z) => (mgr ? ui.form(`/admin/parking/zones/${z.id}`, csrf, `<input type="hidden" name="capacity" value="${z.capacity}"><input type="hidden" name="active" value="${z.active ? 0 : 1}">${ui.btn(esc(z.active ? tr('prk|Hide') : tr('prk|Show')), { cls: 'btn--ghost btn--xs' })}`) : '') },
    ], zs, { empty: esc(tr('prk|No levels yet.')) });
    const addZone = mgr ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${esc(tr('prk|Add a level or area'))}</span></summary>${ui.form('/admin/parking/zones', csrf, `<div class="fields">${ui.input('code', tr('prk|Code'), '', { required: true, placeholder: 'B3' })}${ui.input('name', tr('Name'), '', { required: true, placeholder: tr('prk|e.g. Lower parking') })}${ui.input('name_ar', tr('prk|Name in Arabic'), '', { attrs: { dir: 'rtl' } })}${ui.input('level', tr('prk|Floor'), '', { placeholder: 'B3' })}${ui.input('capacity', tr('prk|Spaces'), '', { type: 'number', min: 0, required: true })}${ui.select('kind', tr('prk|Type'), tmap(ZONE_KIND), 'general')}</div>${ui.btn(esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const lanes = db.all('SELECT l.*, z.name zone FROM pk_lanes l LEFT JOIN pk_zones z ON z.id = l.zone_id ORDER BY l.direction, l.code');
    const laneTable = ui.table([
      { label: tr('prk|Gate'), render: (l) => `<b>${esc(tx(l.name))}</b><small class="sub ltr">${esc(l.code)}</small>` },
      { label: tr('prk|Direction'), render: (l) => esc(tr(LANE_DIR[l.direction])) },
      { label: tr('prk|Last heard from'), render: (l) => esc(l.last_seen_at ? `${ui.dt(l.last_seen_at)}` : tr('prk|Never')) },
      { label: '', render: (l) => (mgr ? ui.form(`/admin/parking/lanes/${l.id}`, csrf, `<input type="hidden" name="active" value="${l.active ? 0 : 1}">${ui.btn(esc(l.active ? tr('prk|Switch off') : tr('prk|Switch on')), { cls: 'btn--ghost btn--xs' })}`) : '') },
    ], lanes, { empty: esc(tr('prk|No gates yet.')) });
    const addLane = mgr ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${esc(tr('prk|Add a gate'))}</span></summary>${ui.form('/admin/parking/lanes', csrf, `<div class="fields">${ui.input('code', tr('prk|Code the gate sends'), '', { required: true, placeholder: 'IN-2' })}${ui.input('name', tr('Name'), '', { required: true, placeholder: tr('prk|e.g. South entry') })}${ui.select('direction', tr('prk|Direction'), tmap(LANE_DIR), 'in')}${ui.select('zone_id', tr('prk|Leads to'), zs.map((z) => [z.id, zoneName(z)]), '', { blank: tr('prk|Any level') })}</div>${ui.btn(esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    // prices
    const std = db.get("SELECT * FROM pk_tariffs WHERE kind = 'standard' ORDER BY id LIMIT 1");
    const tariffFields = (t) => `<div class="fields">
      ${ui.input('first_hour', tr('prk|First hour'), t.first_hour, { type: 'number', min: 0, step: '0.5', required: true })}
      ${ui.input('next_hour', tr('prk|Each hour after'), t.next_hour, { type: 'number', min: 0, step: '0.5', required: true })}
      ${ui.input('daily_cap', tr('prk|Most for one day'), t.daily_cap, { type: 'number', min: 0, step: 1, hint: tr('prk|0: no cap.') })}
      ${ui.input('day_rate', tr('prk|Each full day (24 h)'), t.day_rate, { type: 'number', min: 0, step: 1, hint: tr('prk|For cars left overnight or longer.') })}
      ${ui.input('grace_min', tr('prk|Free minutes'), t.grace_min, { type: 'number', min: 0, max: 120, hint: tr('prk|A stay this short is free.') })}
      ${ui.input('round_min', tr('prk|Minutes of tolerance per hour'), t.round_min, { type: 'number', min: 0, max: 30 })}
      ${ui.input('exit_min', tr('prk|Minutes to leave after paying'), t.exit_min, { type: 'number', min: 0, max: 60 })}
      ${ui.input('lost_fee', tr('prk|Lost ticket'), t.lost_fee, { type: 'number', min: 0, step: 1 })}
    </div>`;
    const examples = (t) => `<div class="tablewrap"><table class="table pk-examples"><thead><tr><th>${esc(tr('prk|Stay'))}</th>${T.examples(t).map((e) => `<th class="num">${esc(dur(e.minutes))}</th>`).join('')}</tr></thead><tbody><tr><td>${esc(tr('prk|Price'))}</td>${T.examples(t).map((e) => `<td class="num">${ui.money(e.price, { cur: false })}</td>`).join('')}</tr></tbody></table></div>`;
    const priceCard = std ? ui.card(tr('prk|Prices'), `${examples(std)}${mgr ? ui.form(`/admin/parking/tariffs/${std.id}`, csrf, `${tariffFields(std)}${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : ''}`, { sub: esc(tr('prk|Prices include VAT. The table shows what a stay costs.')) }) : '';
    const events = db.all("SELECT * FROM pk_tariffs WHERE kind = 'event' ORDER BY starts_on DESC LIMIT 20");
    const eventCard = ui.card(tr('prk|Event prices'), `${ui.table([
      { label: tr('Name'), render: (t) => `<b>${esc(tx(t.name))}</b><small class="sub">${esc(`${ui.date(t.starts_on)} – ${ui.date(t.ends_on || t.starts_on)}`)}</small>` },
      { label: tr('prk|First hour'), num: true, render: (t) => money(t.first_hour) },
      { label: tr('prk|Most for one day'), num: true, render: (t) => money(t.daily_cap) },
      { label: '', render: (t) => (mgr ? ui.form(`/admin/parking/tariffs/${t.id}/active`, csrf, `<input type="hidden" name="active" value="${t.active ? 0 : 1}">${ui.btn(esc(t.active ? tr('prk|Switch off') : tr('prk|Switch on')), { cls: 'btn--ghost btn--xs' })}`) : '') },
    ], events, { empty: esc(tr('prk|None. Add one for concerts, Ramadan nights or the holidays.')) })}${mgr && std ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${esc(tr('prk|Add event prices'))}</span></summary>${ui.form('/admin/parking/tariffs', csrf, `<div class="fields">${ui.input('name', tr('Name'), '', { required: true, placeholder: tr('prk|e.g. New Year’s Eve') })}${ui.input('starts_on', tr('prk|From'), '', { type: 'date', required: true })}${ui.input('ends_on', tr('prk|To'), '', { type: 'date', required: true })}</div>${tariffFields(std)}${ui.btn(esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}`, { sub: esc(tr('prk|For the days they cover, they replace the normal prices for cars that come in.')) });
    // plans
    const plans = db.all('SELECT * FROM pk_plans ORDER BY active DESC, kind, price');
    const planCard = ui.card(tr('prk|Subscription plans'), `${ui.table([
      { label: tr('prk|Plan'), render: (p) => `<b>${esc(planName(p))}</b><small class="sub">${esc(tr(HOLDER[p.kind] || p.kind))}${p.active ? '' : ` · ${esc(tr('prk|Hidden'))}`}</small>` },
      { label: tr('prk|Price'), num: true, render: (p) => (p.price ? `${money(p.price)}<small class="sub">${esc(tn(p.months, 'prk|every month', 'prk|every {n} months'))}</small>` : esc(tr('prk|Free'))) },
      { label: tr('prk|Cars'), num: true, render: (p) => ui.n0(p.cars) },
      { label: '', render: (p) => (mgr ? ui.form(`/admin/parking/plans/${p.id}`, csrf, `<input type="hidden" name="active" value="${p.active ? 0 : 1}">${ui.btn(esc(p.active ? tr('prk|Hide') : tr('prk|Show')), { cls: 'btn--ghost btn--xs' })}`) : '') },
    ], plans, { empty: esc(tr('prk|No plans yet.')) })}${mgr ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${esc(tr('prk|Add a plan'))}</span></summary>${ui.form('/admin/parking/plans', csrf, `<div class="fields">${ui.input('name', tr('Name'), '', { required: true, placeholder: tr('prk|e.g. Night shift monthly') })}${ui.input('name_ar', tr('prk|Name in Arabic'), '', { attrs: { dir: 'rtl' } })}${ui.select('kind', tr('prk|For'), tmap(HOLDER), 'individual')}${ui.input('price', tr('prk|Price per period'), '', { type: 'number', min: 0, step: 1, required: true })}${ui.input('months', tr('prk|Months per period'), 1, { type: 'number', min: 1, max: 12 })}${ui.input('cars', tr('prk|Cars inside at once'), 1, { type: 'number', min: 1, max: 10 })}${ui.select('zone_id', tr('prk|Level'), zs.map((z) => [z.id, zoneName(z)]), '', { blank: tr('prk|Any level') })}</div>${ui.btn(esc(tr('Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}`);
    // rules
    const rules = ui.card(tr('prk|Rules'), mgr ? ui.form('/admin/parking/settings', csrf, `<div class="fields">
      ${ui.select('prk_val_minutes', tr('prk|A validation gives'), VAL_MINUTES.map(([k, l]) => [k, tr(l)]), P.S('prk_val_minutes'))}
      ${ui.input('prk_val_min_purchase', tr('prk|Smallest purchase for a validation'), P.S('prk_val_min_purchase'), { type: 'number', min: 0, step: 1, hint: tr('prk|0: any purchase.') })}
      ${ui.select('prk_val_payer', tr('prk|Validations are paid by'), tmap(PAYER), P.S('prk_val_payer'))}
      ${ui.input('prk_val_share', tr('prk|Shop’s share when shared (%)'), P.S('prk_val_share'), { type: 'number', min: 0, max: 100 })}
      ${ui.input('prk_val_cap', tr('prk|Validations a shop may give a month'), P.S('prk_val_cap'), { type: 'number', min: 0, hint: tr('prk|0: no limit.') })}
      ${ui.input('prk_suspend_days', tr('prk|Suspend a subscription after (days late)'), P.S('prk_suspend_days'), { type: 'number', min: 1, max: 120 })}
      ${ui.input('prk_overstay_hours', tr('prk|Flag a car parked longer than (hours)'), P.S('prk_overstay_hours'), { type: 'number', min: 1, max: 720 })}
      ${ui.input('prk_repeat_min', tr('prk|Same plate read again within (minutes)'), P.S('prk_repeat_min'), { type: 'number', min: 0, max: 30 })}
    </div><label class="check"><input type="checkbox" name="prk_block_full" value="1"${P.N('prk_block_full') ? ' checked' : ''}> ${esc(tr('prk|Close the entry to visitors when the car park is full (subscribers still get in)'))}</label>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : `<p class="muted">${esc(tr('prk|Managers can change the rules.'))}</p>`);
    // block list
    const list = db.all('SELECT * FROM pk_lists ORDER BY created_at DESC LIMIT 100');
    const blockCard = ui.card(tr('prk|Block list'), `${ui.table([
      { label: tr('prk|Plate'), render: (x) => plate(x.plate, 'pk-plate--sm') },
      { label: tr('prk|Why'), render: (x) => esc(tx(x.reason || '')) },
      { label: tr('prk|Until'), render: (x) => esc(x.until ? ui.date(x.until) : tr('prk|Ongoing')) },
      { label: '', render: (x) => (mgr ? ui.form(`/admin/parking/lists/${x.id}/delete`, csrf, `<button class="iconbtn" aria-label="${esc(tr('prk|Remove'))}" title="${esc(tr('prk|Remove'))}">×</button>`) : '') },
    ], list, { empty: esc(tr('prk|No plates are blocked.')) })}${mgr ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${esc(tr('prk|Block a plate'))}</span></summary>${ui.form('/admin/parking/lists', csrf, `<div class="fields">${ui.input('plate', tr('prk|Plate'), '', { required: true })}${ui.input('reason', tr('prk|Why'), '', { required: true })}${ui.input('until', tr('prk|Until'), '', { type: 'date' })}</div>${ui.btn(esc(tr('prk|Block')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : ''}`, { sub: esc(tr('prk|The entry stays closed for these plates and security is told.')) });
    // the gates' connection
    const s = site(req);
    const keyOn = !!env('PARKING_API_KEY');
    const envName = (k) => `<input class="envname" type="text" readonly value="${k}" size="${k.length}" aria-label="${esc(tr('prk|Setting name'))}" data-select>`;
    const sample = `POST ${s}/ingest/parking/gate
Authorization: Bearer <PARKING_API_KEY>
Content-Type: application/json

{"lane": "IN-1", "event": "entry", "plate": "ق ص ر 1234", "photo_url": "https://…"}
{"lane": "OUT-1", "event": "exit", "ticket": "ABCD-2345"}
{"lane": "OUT-1", "event": "exit", "card": "04A32B1C9F6180"}

→ {"open": true, "message": {"en": "…", "ar": "…"}, "ticket": "ABCD-2345", "due": 0}

POST ${s}/ingest/parking/pay      {"device": "PM-1", "ticket": "ABCD-2345", "amount": 40, "method": "card", "reference": "…"}
POST ${s}/ingest/parking/levels   {"levels": [{"zone": "B1", "cars": 120}]}
GET  ${s}/ingest/parking/status   (free spaces for the signs)`;
    const api = `<p>${ui.badge(keyOn ? 'on' : 'off', keyOn ? tr('prk|Ready for the gates') : tr('prk|Not set up'), keyOn ? 'ok' : 'mute')}</p>
      <p class="muted">${esc(tr('prk|Plate cameras, ticket machines, card readers, pay machines and level sensors talk to the office here. Each answer tells the gate whether to open and what its display should say.'))}</p>
      <dl class="dl"><div><dt>${esc(tr('prk|Settings on the server'))}</dt><dd>${envName('PARKING_API_KEY')} ${keyOn ? ui.badge('on', tr('prk|set'), 'ok') : ui.badge('off', tr('prk|missing'), 'mute')}<br>${envName('PARKING_HMAC_SECRET')} ${env('PARKING_HMAC_SECRET') ? ui.badge('on', tr('prk|set'), 'ok') : ui.badge('off', tr('prk|optional'), 'mute')}</dd></div>
      <div><dt>${esc(tr('prk|Visitors’ page'))}</dt><dd><a class="ltr" href="/parking" target="_blank" rel="noopener">${esc(`${s}/parking`)}</a></dd></div></dl>
      <textarea class="ftf-code" dir="ltr" rows="14" readonly aria-label="${esc(tr('prk|Example requests'))}" data-select>${esc(sample)}</textarea>`;
    const body = `${tabs('/admin/parking/setup')}<div class="grid grid--side">
  <div class="stack">${ui.card(tr('prk|Levels'), `${zoneTable}${addZone}`, { sub: esc(tr('prk|{n} spaces in all', { n: ui.n0(P.capacity()) })) })}${priceCard}${eventCard}${planCard}</div>
  <div class="stack">${ui.card(tr('prk|Gates'), `${laneTable}${addLane}`)}${rules}${blockCard}${ui.card(tr('prk|Connect the gates'), api)}</div>
</div>`;
    page(req, res, { title: tr('prk|Parking set-up'), crumbs: crumbs([null, tr('prk|Set-up')]), body });
  });
  const okBack = (req, res, what, id, detail) => {
    h.log(req, what, 'parking', id, detail);
    back(req, res, '/admin/parking/setup', 'ok', tr('Saved.'));
  };
  router.post('/parking/zones', RM, (req, res) => {
    const code = h.str(req.body.code, 12).toUpperCase();
    const name = h.str(req.body.name, 60);
    if (!code || !name) return back(req, res, '/admin/parking/setup', 'error', tr('prk|Give the level a code and a name.'));
    if (db.get('SELECT id FROM pk_zones WHERE code = ?', code)) return back(req, res, '/admin/parking/setup', 'error', tr('prk|{code} is already used.', { code }));
    db.run('INSERT INTO pk_zones (code, name, name_ar, level, capacity, kind, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', code, name, h.str(req.body.name_ar, 60) || null, h.str(req.body.level, 12) || null,
      Math.max(0, h.int(req.body.capacity) || 0), ZONE_KIND[req.body.kind] ? req.body.kind : 'general', (db.value('SELECT MAX(sort) FROM pk_zones') || 0) + 1, now());
    okBack(req, res, 'Added a parking level', null, code);
  });
  router.post('/parking/zones/:id', RM, (req, res) => {
    db.run('UPDATE pk_zones SET capacity = ?, active = ? WHERE id = ?', Math.max(0, h.int(req.body.capacity) || 0), req.body.active === '0' ? 0 : 1, h.int(req.params.id));
    okBack(req, res, 'Changed a parking level', h.int(req.params.id), String(h.int(req.body.capacity)));
  });
  router.post('/parking/lanes', RM, (req, res) => {
    const code = h.str(req.body.code, 20).toUpperCase();
    const name = h.str(req.body.name, 60);
    if (!code || !name) return back(req, res, '/admin/parking/setup', 'error', tr('prk|Give the gate a code and a name.'));
    if (db.get('SELECT id FROM pk_lanes WHERE code = ?', code)) return back(req, res, '/admin/parking/setup', 'error', tr('prk|{code} is already used.', { code }));
    db.run('INSERT INTO pk_lanes (code, name, direction, zone_id, created_at) VALUES (?, ?, ?, ?, ?)', code, name, req.body.direction === 'out' ? 'out' : 'in', h.int(req.body.zone_id), now());
    okBack(req, res, 'Added a parking gate', null, code);
  });
  router.post('/parking/lanes/:id', RM, (req, res) => {
    db.run('UPDATE pk_lanes SET active = ? WHERE id = ?', req.body.active === '1' ? 1 : 0, h.int(req.params.id));
    okBack(req, res, 'Changed a parking gate', h.int(req.params.id), req.body.active === '1' ? 'on' : 'off');
  });
  const tariffValues = (b) => {
    const n = (k, max = 1e6) => Math.min(max, Math.max(0, Number(b[k]) || 0));
    return [n('grace_min', 120), n('first_hour'), n('next_hour'), n('round_min', 30), n('daily_cap'), n('day_rate'), n('lost_fee'), n('exit_min', 60)];
  };
  router.post('/parking/tariffs', RM, (req, res) => {
    const name = h.str(req.body.name, 80);
    const a = h.str(req.body.starts_on, 10);
    const b = h.str(req.body.ends_on, 10);
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b) || b < a) return back(req, res, '/admin/parking/setup', 'error', tr('prk|Give the event prices a name and the days they cover.'));
    db.run("INSERT INTO pk_tariffs (name, kind, starts_on, ends_on, grace_min, first_hour, next_hour, round_min, daily_cap, day_rate, lost_fee, exit_min, created_at, updated_at) VALUES (?, 'event', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", name, a, b, ...tariffValues(req.body), now(), now());
    okBack(req, res, 'Added event parking prices', null, name);
  });
  router.post('/parking/tariffs/:id', RM, (req, res) => {
    db.run('UPDATE pk_tariffs SET grace_min = ?, first_hour = ?, next_hour = ?, round_min = ?, daily_cap = ?, day_rate = ?, lost_fee = ?, exit_min = ?, updated_at = ? WHERE id = ?', ...tariffValues(req.body), now(), h.int(req.params.id));
    okBack(req, res, 'Changed the parking prices', h.int(req.params.id), JSON.stringify(tariffValues(req.body)));
  });
  router.post('/parking/tariffs/:id/active', RM, (req, res) => {
    db.run("UPDATE pk_tariffs SET active = ?, updated_at = ? WHERE id = ? AND kind = 'event'", req.body.active === '1' ? 1 : 0, now(), h.int(req.params.id));
    okBack(req, res, 'Changed event parking prices', h.int(req.params.id), req.body.active === '1' ? 'on' : 'off');
  });
  router.post('/parking/plans', RM, (req, res) => {
    const name = h.str(req.body.name, 80);
    if (!name) return back(req, res, '/admin/parking/setup', 'error', tr('prk|Give the plan a name.'));
    let c = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'PLAN';
    for (let k = 2; db.get('SELECT id FROM pk_plans WHERE code = ?', c); k++) c = `${c.slice(0, 13)}-${k}`;
    db.run('INSERT INTO pk_plans (code, name, name_ar, kind, price, months, zone_id, cars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', c, name, h.str(req.body.name_ar, 80) || null,
      HOLDER[req.body.kind] ? req.body.kind : 'individual', Math.max(0, h.numv(req.body.price) || 0), Math.min(12, Math.max(1, h.int(req.body.months) || 1)), h.int(req.body.zone_id), Math.min(10, Math.max(1, h.int(req.body.cars) || 1)), now());
    okBack(req, res, 'Added a parking plan', null, name);
  });
  router.post('/parking/plans/:id', RM, (req, res) => {
    db.run('UPDATE pk_plans SET active = ? WHERE id = ?', req.body.active === '1' ? 1 : 0, h.int(req.params.id));
    okBack(req, res, 'Changed a parking plan', h.int(req.params.id), req.body.active === '1' ? 'on' : 'off');
  });
  router.post('/parking/settings', RM, (req, res) => {
    const nums = { prk_val_minutes: [0, 1440], prk_val_min_purchase: [0, 1e6], prk_val_share: [0, 100], prk_val_cap: [0, 1e6], prk_suspend_days: [1, 120], prk_overstay_hours: [1, 720], prk_repeat_min: [0, 30] };
    for (const [k, [lo, hi]] of Object.entries(nums)) {
      if (req.body[k] !== undefined && req.body[k] !== '') db.setSetting(k, String(Math.min(hi, Math.max(lo, Math.round(Number(req.body[k]) || 0)))));
    }
    if (PAYER[req.body.prk_val_payer]) db.setSetting('prk_val_payer', req.body.prk_val_payer);
    db.setSetting('prk_block_full', req.body.prk_block_full === '1' ? '1' : '0');
    okBack(req, res, 'Changed the parking rules', null, '');
  });
  router.post('/parking/lists', RM, (req, res) => {
    const key = P.plateKey(req.body.plate);
    const reason = h.str(req.body.reason, 200);
    if (!key || !reason) return back(req, res, '/admin/parking/setup', 'error', tr('prk|Give the plate and the reason.'));
    db.run(`INSERT INTO pk_lists (plate_key, plate, kind, reason, until, user_id, created_at) VALUES (?, ?, 'block', ?, ?, ?, ?)
      ON CONFLICT(plate_key) DO UPDATE SET reason = excluded.reason, until = excluded.until, user_id = excluded.user_id`, key, P.plateShow(req.body.plate), reason, /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.until || '')) ? req.body.until : null, req.user.id, now());
    okBack(req, res, 'Blocked a plate', null, P.plateShow(req.body.plate));
  });
  router.post('/parking/lists/:id/delete', RM, (req, res) => {
    const x = db.get('SELECT * FROM pk_lists WHERE id = ?', h.int(req.params.id));
    if (x) db.run('DELETE FROM pk_lists WHERE id = ?', x.id);
    okBack(req, res, 'Unblocked a plate', x ? x.id : null, x ? x.plate : '');
  });

  // ---------- background jobs ----------
  h.every('parking-subscriptions', 3 * 60 * 60 * 1000, () => {
    P.billPermits();
    P.reviewPermits();
  });
  h.every('parking-online-sweep', 60 * 60 * 1000, () => P.sweepOnline());
  // pay machines' tills close each night; shops are billed for last month's validations early each month
  h.every('parking-close-day', 60 * 60 * 1000, () => {
    const d = today();
    for (const t of db.all("SELECT * FROM pk_tills WHERE kind = 'machine' AND status = 'open'")) if (cairoDate(t.opened_at) < d) P.closeTill(t, { counted: null });
    const last = P.addDays(`${d.slice(0, 7)}-01`, -1).slice(0, 7);
    if (Number(d.slice(8)) >= 2 && db.setting('prk_billed_month') !== last) {
      P.billValidations(last);
      db.setSetting('prk_billed_month', last);
    }
  });

  // ---------- the gates' card on the Integrations page ----------
  (h.integrationCards = h.integrationCards || []).push({
    key: 'parking',
    get title() { return tr('prk|Car park gates'); },
    get help() { return tr('prk|Plate cameras, ticket and card readers, pay machines and level sensors send their reads to /ingest/parking with the API key.'); },
    env: ['PARKING_API_KEY', 'PARKING_HMAC_SECRET'],
    href: '/admin/parking/setup',
    get hrefLabel() { return tr('prk|Set up'); },
    status: () => {
      const on = !!env('PARKING_API_KEY');
      const last = db.get('SELECT MAX(last_seen_at) at FROM pk_lanes');
      return { ok: on, detail: on ? (last && last.at ? tr('prk|A gate last reported {when}.', { when: ui.rel(last.at) }) : tr('prk|Waiting for the first gate.')) : tr('prk|Set PARKING_API_KEY on the server, then give it to the gate supplier.') };
    },
  });

  // ---------- shared with the rest of the office ----------
  h.parking = {
    ...P,
    afterPay: (intent, lang) => {
      const inv = db.get('SELECT * FROM invoices WHERE id = ?', intent.invoice_id);
      const s = inv && inv.source === 'parking' ? P.sessionBy(inv.source_id) : null;
      return s ? `/parking/t/${P.codeShow(s.code)}?lang=${lang === 'ar' ? 'ar' : 'en'}&paid=${intent.status === 'paid' ? 1 : 0}` : '/parking';
    },
  };
  require('../parking/public')(h, P);

  // The mall's real car park, and starting prices, the first time the module runs (all editable in Set-up).
  function seed() {
    if (db.value('SELECT COUNT(*) FROM pk_zones') || db.setting('prk_seeded')) return;
    const t = now();
    db.tx(() => {
      db.run("INSERT INTO pk_zones (code, name, name_ar, level, capacity, kind, sort, created_at) VALUES ('B1', 'Lower ground', 'الدور الأرضي السفلي', 'B1', 144, 'general', 1, ?), ('B2', 'Parking level', 'دور الجراج', 'B2', 196, 'general', 2, ?)", t, t);
      db.run("INSERT INTO pk_lanes (code, name, direction, created_at) VALUES ('IN-1', 'Main entry', 'in', ?), ('OUT-1', 'Main exit', 'out', ?)", t, t);
      const d = T.DEFAULT;
      db.run("INSERT INTO pk_tariffs (name, kind, grace_min, first_hour, next_hour, round_min, daily_cap, day_rate, lost_fee, exit_min, created_at, updated_at) VALUES ('Standard', 'standard', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        d.grace_min, d.first_hour, d.next_hour, d.round_min, d.daily_cap, d.day_rate, d.lost_fee, d.exit_min, t, t);
      db.run(`INSERT INTO pk_plans (code, name, name_ar, kind, price, months, cars, created_at) VALUES
        ('TENANT-STAFF', 'Tenant staff monthly', 'شهري لموظفي المستأجرين', 'tenant', 400, 1, 1, ?),
        ('MALL-STAFF', 'Mall staff', 'موظفو المول', 'staff', 0, 1, 1, ?),
        ('PUBLIC-MONTHLY', 'Monthly parking', 'اشتراك شهري', 'individual', 900, 1, 1, ?),
        ('VIP', 'VIP reserved', 'مكان محجوز لكبار الزوار', 'vip', 2500, 1, 1, ?)`, t, t, t, t);
      db.setSetting('prk_seeded', '1');
    });
  }
};
