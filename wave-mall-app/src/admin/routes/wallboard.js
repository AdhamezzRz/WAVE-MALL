'use strict';

// The wall screen: a full-screen dark dashboard for the management office or the security room TV.
// Visitors today and the car park levels, today's takings, this month's sales, open work orders and
// alerts, cheques falling due, and the common areas' electricity. It refreshes itself every 30
// seconds (public/admin/wallboard.js reads the JSON) and rotates through detail panels. A TV signs in
// with a secret link (/wall/<token>, read-only, not indexed) that the office creates, replaces or
// turns off on /admin/wallboard; signed-in staff can open it from there without the link.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const { cairo } = require('../ops-common');

const { t: tr, tx } = i18n;

const OPEN_WO = ['new', 'assigned', 'in_progress', 'on_hold', 'reopened'];
const JS_FILE = path.join(__dirname, '..', '..', '..', 'public', 'admin', 'wallboard.js');
const DAY_START = 6; // the mall day starts at 06:00 (as on the footfall pages)
const pad = (n) => String(n).padStart(2, '0');

module.exports = function wallboard(router, h) {
  const { db, ui, M } = h;
  // staff type the work orders shown on the screen (the Arabic audit leaves them as typed)
  (h.auditTyped = h.auditTyped || []).push('SELECT title, location FROM work_orders');
  const has = (name) => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  const jsVersion = (() => { try { return crypto.createHash('sha1').update(fs.readFileSync(JS_FILE)).digest('hex').slice(0, 8); } catch { return '0'; } })();
  const token = () => String(db.setting('wall_token') || '');
  const langOf = (q) => (q === 'ar' || q === 'en' ? q : db.setting('wall_lang') === 'en' ? 'en' : 'ar');
  const rotate = () => Math.min(120, Math.max(5, Number(db.setting('wall_rotate')) || 15));
  const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const tokenOk = (sent) => {
    const t = token();
    return !!t && !!sent && crypto.timingSafeEqual(Buffer.from(hashOf(sent)), Buffer.from(hashOf(t)));
  };
  const siteUrl = (req) => String((h.env && h.env.SITE_URL) || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  // UTC bounds of a Cairo calendar day (Egypt keeps summer time, so the offset is worked out)
  const cairoOffset = (iso) => {
    const d = new Date(iso);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - d.getTime();
  };
  const dayUtc = (date) => {
    const guess = Date.parse(`${date}T00:00:00Z`);
    const from = new Date(guess - cairoOffset(new Date(guess).toISOString())).toISOString();
    const nextGuess = Date.parse(`${M.addDays(date, 1)}T00:00:00Z`);
    const to = new Date(nextGuess - cairoOffset(new Date(nextGuess).toISOString())).toISOString();
    return [from, to];
  };
  const big = (v) => ui.money(v, { compact: true });
  const bigTile = (v) => `${ui.esc(ui.money(v, { compact: true, cur: false }))}<small> ${ui.esc(ui.curLabel())}</small>`;
  const HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const hm = () => HM.format(new Date());

  // ---------- the numbers on the screen ----------
  function data() {
    const c = cairo();
    const today = c.date;
    const [uFrom, uTo] = dayUtc(today);
    const mallDay = c.hour < DAY_START ? M.addDays(today, -1) : today;
    const tiles = {};
    const panels = [];
    const ticker = [];

    // visitors
    if (has('footfall')) {
      const from = `${mallDay}T${pad(DAY_START)}`;
      const to = `${M.addDays(mallDay, 1)}T${pad(DAY_START - 1)}`;
      const t = db.get('SELECT COALESCE(SUM(visitors_in), 0) i, COALESCE(SUM(visitors_out), 0) o FROM footfall WHERE ts_hour >= ? AND ts_hour <= ?', from, to);
      const nowH = `${today}T${pad(c.hour)}`;
      const lw = db.value('SELECT COALESCE(SUM(visitors_in), 0) FROM footfall WHERE ts_hour >= ? AND ts_hour <= ?', `${M.addDays(mallDay, -7)}T${pad(DAY_START)}`, `${M.addDays(today, -7)}T${pad(c.hour)}`);
      const last = db.get('SELECT ts_hour, SUM(visitors_in) n FROM footfall WHERE ts_hour <= ? GROUP BY ts_hour ORDER BY ts_hour DESC LIMIT 1', nowH);
      const d = lw ? (t.i - lw) / lw : null;
      tiles.visitors = {
        label: tr('wall|Visitors today'), value: ui.n0(t.i), tone: 'sea',
        sub: `${d === null ? '' : `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}%</span> ${ui.esc(tr('wall|vs last week'))} · `}${ui.esc(tr('wall|about {n} inside', { n: ui.n0(Math.max(0, t.i - t.o)) }))}`,
      };
      const byHour = new Map(db.all('SELECT ts_hour, SUM(visitors_in) n FROM footfall WHERE (ts_hour >= ? AND ts_hour <= ?) OR (ts_hour >= ? AND ts_hour <= ?) GROUP BY ts_hour',
        from, to, `${M.addDays(mallDay, -7)}T${pad(DAY_START)}`, `${M.addDays(mallDay, -6)}T${pad(DAY_START - 1)}`).map((r) => [r.ts_hour, r.n]));
      const order = Array.from({ length: 18 }, (_, i) => (i + DAY_START + 4) % 24); // 10:00 to 03:00
      const tsOf = (day, hr) => `${hr >= DAY_START ? day : M.addDays(day, 1)}T${pad(hr)}`;
      const val = (hr, lastWeek) => byHour.get(tsOf(lastWeek ? M.addDays(mallDay, -7) : mallDay, hr)) || 0;
      const series = order.map((hr) => ({ label: pad(hr), v: val(hr, false), lw: val(hr, true) }));
      panels.push({
        key: 'footfall', title: tr('wall|Visitors by the hour'),
        sub: last ? tr('wall|Last hour: {n} visitors at {time}', { n: ui.n0(last.n), time: `${last.ts_hour.slice(11, 13)}:00` }) : '',
        html: `${ui.bars(series, { key: 'v', label: 'label', compare: 'lw', h: 300, fmtv: (v) => ui.n0(v), tone: 'sea' })}<ul class="legend legend--row"><li><i class="t-sea"></i><span>${ui.esc(tr('wall|Today'))}</span></li><li><i class="x-ghost"></i><span>${ui.esc(tr('wall|Same day last week'))}</span></li></ul>`,
      });
    }

    // the car park
    if (h.parking && typeof h.parking.occupancy === 'function') {
      const o = h.parking.occupancy();
      const share = o.capacity ? o.cars / o.capacity : 0;
      tiles.parking = {
        label: tr('wall|Car park'), value: `${ui.n0(o.cars)}<small> / ${ui.n0(o.capacity)}</small>`, tone: share >= 0.9 ? 'rose' : share >= 0.75 ? 'amber' : 'forest',
        sub: o.zones.map((z) => `<bdi>${ui.esc(z.code)}</bdi> ${ui.n0(z.cars)}/${ui.n0(z.capacity)}`).join(' · ') || ui.esc(tr('wall|{n} free', { n: ui.n0(o.free) })),
        bar: share,
      };
      const entries = has('pk_sessions') ? db.value('SELECT COUNT(*) FROM pk_sessions WHERE entry_at >= ? AND entry_at < ?', uFrom, uTo) : 0;
      panels.push({
        key: 'parking', title: tr('wall|Car park levels'),
        sub: tr('wall|{n} cars came in today', { n: ui.n0(entries) }),
        html: `<div class="wall-levels">${o.zones.map((z) => {
          const s = z.capacity ? z.cars / z.capacity : 0;
          return `<div class="wall-level"><b><bdi>${ui.esc(z.code)}</bdi></b><div class="wall-level__bar"><i class="t-${s >= 0.9 ? 'rose' : s >= 0.75 ? 'amber' : 'forest'}" style="width:${(Math.min(1, s) * 100).toFixed(1)}%"></i></div><span>${ui.esc(tr('wall|{a} of {b} · {free} free', { a: ui.n0(z.cars), b: ui.n0(z.capacity), free: ui.n0(z.free) }))}</span><em>${ui.pct(s)}</em></div>`;
        }).join('')}</div>${o.full ? `<p class="wall-flag">${ui.esc(tr('wall|The car park is full.'))}</p>` : ''}`,
      });
    }

    // money in today
    const pk = has('pk_payments') ? db.value("SELECT COALESCE(SUM(amount), 0) FROM pk_payments WHERE status = 'ok' AND at >= ? AND at < ?", uFrom, uTo) : 0;
    const coll = has('payments') ? db.value("SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'received' AND COALESCE(method, '') NOT IN ('writeoff', 'deposit') AND date = ?", today) : 0;
    tiles.takings = {
      label: tr('wall|Taken today'), value: bigTile(pk + coll), tone: 'forest',
      sub: ui.esc(tr('wall|Parking {a} · tenants {b}', { a: big(pk), b: big(coll) })),
    };

    // tenant sales: this month, or the last month reported
    if (has('tenant_sales')) {
      const ym = today.slice(0, 7);
      const counted = "status IN ('submitted','verified')";
      const p = db.value(`SELECT MAX(period) FROM tenant_sales WHERE ${counted} AND period <= ?`, ym);
      if (p) {
        const amount = db.value(`SELECT COALESCE(SUM(amount), 0) FROM tenant_sales WHERE ${counted} AND period = ?`, p);
        const n = db.value(`SELECT COUNT(*) FROM tenant_sales WHERE ${counted} AND period = ?`, p);
        tiles.sales = { label: p === ym ? tr('wall|Sales this month') : tr('wall|Sales in {month}', { month: ui.monthYear(p) }), value: bigTile(amount), tone: 'cocoa', sub: ui.esc(tr('wall|from {n} tenants', { n })) };
      } else tiles.sales = { label: tr('wall|Sales this month'), value: '—', tone: 'cocoa', sub: ui.esc(tr('wall|No sales reported yet')) };
    }

    // work orders and alerts
    if (has('work_orders')) {
      const q = `status IN (${OPEN_WO.map(() => '?').join(',')})`;
      const open = db.value(`SELECT COUNT(*) FROM work_orders WHERE ${q}`, ...OPEN_WO);
      const urgent = db.value(`SELECT COUNT(*) FROM work_orders WHERE ${q} AND priority <= 2`, ...OPEN_WO);
      const late = db.value(`SELECT COUNT(*) FROM work_orders WHERE ${q} AND resolve_due IS NOT NULL AND resolve_due < ?`, ...OPEN_WO, new Date().toISOString());
      tiles.orders = { label: tr('wall|Open work orders'), value: ui.n0(open), tone: urgent ? 'rose' : late ? 'amber' : 'forest', sub: ui.esc(tr('wall|{a} urgent · {b} late', { a: urgent, b: late })) };
      const list = db.all(`SELECT * FROM work_orders WHERE ${q} ORDER BY priority, COALESCE(resolve_due, '9999'), created_at LIMIT 7`, ...OPEN_WO);
      panels.push({
        key: 'orders', title: tr('wall|Open work orders'), sub: tr('wall|Most urgent first'),
        html: list.length ? `<ul class="wall-list">${list.map((w) => {
          const lateW = w.resolve_due && w.resolve_due < new Date().toISOString();
          return `<li class="${w.priority <= 2 ? 'is-hot' : ''}"><b>P${w.priority}</b><span><bdi>${ui.esc(w.ref)}</bdi> · ${ui.esc(w.title)}${w.location ? `<small>${ui.esc(w.location)}</small>` : ''}</span><em class="${lateW ? 'down' : ''}">${ui.esc(lateW ? tr('wall|late') : ui.rel(w.created_at))}</em></li>`;
        }).join('')}</ul>` : `<p class="wall-calm">${ui.esc(tr('wall|No open work orders.'))}</p>`,
      });
      if (urgent) ticker.push(tr('wall|{n} urgent work orders open', { n: urgent }));
    }
    if (has('pk_alerts')) for (const a of db.all('SELECT * FROM pk_alerts WHERE acked_at IS NULL ORDER BY at DESC LIMIT 4')) ticker.push(tx(a.title));
    if (has('invoices')) {
      const od = db.get("SELECT COUNT(*) n, COALESCE(SUM(total - paid), 0) a FROM invoices WHERE status IN ('open','partial') AND due_date < ?", today);
      if (od.n) ticker.push(tr('wall|{n} invoices overdue, {amount} in all', { n: od.n, amount: big(od.a) }));
    }

    // cheques
    if (has('cheques')) {
      const soon = db.get("SELECT COUNT(*) n, COALESCE(SUM(amount), 0) a FROM cheques WHERE status = 'held' AND due_date >= ? AND due_date <= ?", today, M.addDays(today, 7));
      const late = db.value("SELECT COUNT(*) FROM cheques WHERE status = 'held' AND due_date < ?", today);
      tiles.cheques = { label: tr('wall|Cheques due this week'), value: ui.n0(soon.n), tone: late ? 'amber' : 'sand', sub: ui.esc(late ? tr('wall|{amount} · {n} waiting to be deposited', { amount: big(soon.a), n: late }) : big(soon.a)) };
      const list = db.all("SELECT c.*, b.name brand_name FROM cheques c LEFT JOIN brands b ON b.id = c.brand_id WHERE c.status = 'held' AND c.due_date <= ? ORDER BY c.due_date LIMIT 7", M.addDays(today, 30));
      panels.push({
        key: 'cheques', title: tr('wall|Cheques falling due'), sub: tr('wall|Held cheques, the next 30 days'),
        html: list.length ? `<ul class="wall-list">${list.map((x) => `<li class="${x.due_date < today ? 'is-hot' : ''}"><b>${ui.esc(ui.date(x.due_date))}</b><span>${ui.esc(x.brand_name || x.drawer || '—')}<small><bdi>${ui.esc(x.number)}</bdi>${x.bank ? ` · ${ui.esc(x.bank)}` : ''}</small></span><em>${ui.money(x.amount)}</em></li>`).join('')}</ul>` : `<p class="wall-calm">${ui.esc(tr('wall|No cheques due in the next 30 days.'))}</p>`,
      });
      if (late) ticker.push(tr('wall|{n} cheques are past their date and not yet deposited', { n: late }));
    }

    // the common areas' electricity today
    if (h.energy && has('nrg_readings')) {
      const rows = db.all("SELECT CAST(substr(r.ts, 12, 2) AS INTEGER) hr, substr(r.ts, 1, 10) d, SUM(r.value) k FROM nrg_readings r JOIN nrg_meters m ON m.id = r.meter_id WHERE m.utility = 'electricity' AND r.ts >= ? AND r.ts < ? GROUP BY substr(r.ts, 1, 13)", `${M.addDays(today, -1)}T00:00`, `${M.addDays(today, 1)}T00:00`);
      if (rows.length) {
        const todayKwh = rows.filter((r) => r.d === today).reduce((s, r) => s + r.k, 0);
        const ydSame = rows.filter((r) => r.d !== today && r.hr < c.hour).reduce((s, r) => s + r.k, 0);
        const lastRow = rows.filter((r) => r.d === today).sort((x, y) => y.hr - x.hr)[0];
        const series = Array.from({ length: 24 }, (_, hr) => ({ label: pad(hr), v: Math.round((rows.find((r) => r.d === today && r.hr === hr) || {}).k || 0), y: Math.round((rows.find((r) => r.d !== today && r.hr === hr) || {}).k || 0) }));
        panels.push({
          key: 'energy', title: tr('wall|Common-area electricity today'),
          sub: tr('wall|{n} kWh so far{vs}', { n: ui.n0(todayKwh), vs: ydSame ? ` · ${todayKwh <= ydSame ? '▼' : '▲'} ${Math.abs(((todayKwh - ydSame) / ydSame) * 100).toFixed(0)}% ${tr('wall|vs yesterday')}` : '' }),
          html: `${ui.bars(series, { key: 'v', label: 'label', compare: 'y', h: 300, fmtv: () => '', tone: 'amber' })}<ul class="legend legend--row"><li><i class="t-amber"></i><span>${ui.esc(tr('wall|Today'))}</span></li><li><i class="x-ghost"></i><span>${ui.esc(tr('wall|Yesterday'))}</span></li>${lastRow ? `<li><span>${ui.esc(tr('wall|Now drawing about {n} kW', { n: ui.n0(lastRow.k) }))}</span></li>` : ''}</ul>`,
        });
      }
    }
    if (!ticker.length) ticker.push(tr('wall|No alerts. All quiet.'));
    return { ok: true, at: new Date().toISOString(), date: today, tiles, panels, ticker, rotate: rotate() };
  }
  const TILE_ORDER = ['visitors', 'parking', 'takings', 'sales', 'orders', 'cheques'];
  const tileHtml = (k, t) => `<div class="wall-tile t-${t.tone || 'forest'}" data-tile="${k}"><p class="wall-tile__l">${ui.esc(t.label)}</p><p class="wall-tile__v">${t.value}</p>${t.bar !== undefined ? `<span class="wall-tile__bar"><i style="width:${(Math.min(1, t.bar) * 100).toFixed(1)}%"></i></span>` : ''}<p class="wall-tile__s">${t.sub || ''}</p></div>`;
  const json = (lang) => i18n.run(lang, () => {
    const d = data();
    return { ...d, updated: tr('wall|Updated {time}', { time: hm() }), tiles: Object.fromEntries(TILE_ORDER.filter((k) => d.tiles[k]).map((k) => [k, tileHtml(k, d.tiles[k])])), panels: d.panels.map((p) => ({ key: p.key, title: p.title, sub: p.sub, html: p.html })) };
  });

  // the page itself (its own frame: no menu, no admin.js)
  function screen(res, { lang, src, other }) {
    const html = i18n.run(lang, () => {
      ui.setCurrency(db.setting('currency'));
      const d = data();
      const s = db.settings();
      return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0f1714">
<title>${ui.esc(tr('wall|Wall screen'))} · ${ui.esc(tx(s.brand_name) || 'The Wave')}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/admin/admin.css?v=${ui.ASSETS.css}">
</head>
<body class="adm wall" data-src="${ui.esc(src)}" data-rotate="${d.rotate}" data-lang="${lang}" data-offline="${ui.esc(tr('wall|Offline · showing the last figures'))}">
<header class="wall-head">${ui.logo('wall-logo')}<div class="wall-when"><b data-clock>${ui.esc(cairo().date)}</b><span data-date>${ui.esc(ui.date(d.date))}</span></div><div class="wall-tools"><span class="wall-live" data-live><i></i>${ui.esc(tr('wall|Live'))}</span>${other}<button type="button" class="wall-fs" data-fullscreen title="${ui.esc(tr('wall|Full screen'))}">⛶</button></div></header>
<section class="wall-tiles" data-tiles>${TILE_ORDER.filter((k) => d.tiles[k]).map((k) => tileHtml(k, d.tiles[k])).join('')}</section>
<section class="wall-stage" data-stage>${d.panels.map((p, i) => `<article class="wall-panel${i === 0 ? ' is-on' : ''}" data-panel="${p.key}"><header><h2>${ui.esc(p.title)}</h2><p>${ui.esc(p.sub || '')}</p></header><div class="wall-panel__b">${p.html}</div></article>`).join('')}
<nav class="wall-dots" data-dots>${d.panels.map((p, i) => `<i class="${i === 0 ? 'is-on' : ''}"></i>`).join('')}</nav></section>
<footer class="wall-ticker"><b>${ui.esc(tr('wall|Alerts'))}</b><p data-ticker>${d.ticker.map((x) => `<span>${ui.esc(x)}</span>`).join('')}</p><small data-updated>${ui.esc(tr('wall|Updated {time}', { time: hm() }))}</small></footer>
<script src="/admin/wallboard.js?v=${jsVersion}" defer></script>
</body>
</html>`;
    });
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html').send(html);
  }
  const langSwitch = (base, lang) => `<a class="wall-lang" href="${base}?lang=${lang === 'ar' ? 'en' : 'ar'}" lang="${lang === 'ar' ? 'en' : 'ar'}">${lang === 'ar' ? 'English' : 'العربية'}</a>`;

  // ---------- the secret link (read-only, for the TV) ----------
  const wallLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const notFound = (res) => res.status(404).set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }).type('text').send('Not found');
  h.public.get('/wall/:token', wallLimit, (req, res) => {
    if (!tokenOk(req.params.token)) return notFound(res);
    const lang = langOf(req.query.lang);
    const base = `/wall/${encodeURIComponent(req.params.token)}`;
    screen(res, { lang, src: `${base}/data.json?lang=${lang}`, other: langSwitch(base, lang) });
  });
  h.public.get('/wall/:token/data.json', wallLimit, (req, res) => {
    if (!tokenOk(req.params.token)) return res.status(404).set('X-Robots-Tag', 'noindex').json({ ok: false });
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }).json(json(langOf(req.query.lang)));
  });

  // ---------- the office page ----------
  router.get('/wallboard', (req, res) => {
    const csrf = req.session.csrf;
    const mgr = h.can(req, 'manager');
    const t = token();
    const link = t ? `${siteUrl(req)}/wall/${t}` : '';
    const lang = langOf();
    const d = i18n.run(req.lang || 'en', () => data());
    const preview = `<div class="wall-mini">${TILE_ORDER.filter((k) => d.tiles[k]).map((k) => `<div class="wall-mini__t t-${d.tiles[k].tone || 'forest'}"><p>${ui.esc(d.tiles[k].label)}</p><b>${d.tiles[k].value}</b><small>${d.tiles[k].sub || ''}</small></div>`).join('')}</div>`;
    const linkCard = t
      ? `<p class="muted">${ui.esc(tr('wall|Open this link on the TV\'s browser and press full screen. Anyone with the link can see the screen (it cannot change anything), so keep it to the office.'))}</p>
        <div class="wall-link"><input type="text" readonly value="${ui.esc(`${link}?lang=${lang}`)}" aria-label="${ui.esc(tr('wall|Screen link'))}" data-copy-src><a class="btn btn--ghost btn--sm" href="${ui.esc(`/wall/${t}?lang=${lang}`)}" target="_blank" rel="noopener">${ui.esc(tr('wall|Open'))}</a></div>
        ${mgr ? `<div class="row">${ui.form('/admin/wallboard/token', csrf, ui.btn(tr('wall|Replace the link'), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('wall|The old link stops working at once. Replace it?') } }), { cls: 'wall-inline' })}${ui.form('/admin/wallboard/token/off', csrf, ui.btn(tr('wall|Turn the link off'), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('wall|Screens using the link will stop updating. Turn it off?') } }), { cls: 'wall-inline' })}</div>` : ''}`
      : `<p class="muted">${ui.esc(tr('wall|No link yet. Create one to show the screen on a TV without signing in.'))}</p>${mgr ? ui.form('/admin/wallboard/token', csrf, ui.btn(tr('wall|Create the link'), { cls: 'btn--primary btn--sm' })) : ''}`;
    const settings = mgr ? ui.form('/admin/wallboard/settings', csrf, `<div class="fields">
      ${ui.select('lang', tr('wall|Screen language'), [['ar', 'العربية'], ['en', 'English']], lang)}
      ${ui.input('rotate', tr('wall|Seconds on each panel'), String(rotate()), { type: 'number', min: 5, max: 120 })}
    </div>${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    const body = `<div class="grid grid--side">
  <div class="stack">${ui.card(tr('wall|On the screen now'), preview, { sub: ui.esc(tr('wall|The screen refreshes every 30 seconds and turns through: {list}.', { list: d.panels.map((p) => p.title).join(' · ') })), action: ui.btn(tr('wall|Open the screen'), { href: '/admin/wallboard/screen', cls: 'btn--primary btn--sm', ic: 'dash', attrs: { target: '_blank', rel: 'noopener' } }) })}</div>
  <div class="stack">${ui.card(tr('wall|Link for the TV'), linkCard)}${settings ? ui.card(tr('wall|Screen settings'), settings) : ''}</div>
</div>`;
    h.page(req, res, { title: tr('nav|Wall screen'), crumbs: [[null, tr('nav|Wall screen')]], active: '/admin/wallboard', wide: true, body });
  });
  // the same screen for signed-in staff, without the link
  router.get('/wallboard/screen', (req, res) => {
    const lang = langOf(req.query.lang || req.lang);
    screen(res, { lang, src: `/admin/wallboard/data.json?lang=${lang}`, other: langSwitch('/admin/wallboard/screen', lang) });
  });
  router.get('/wallboard/data.json', (req, res) => res.json(json(langOf(req.query.lang || req.lang))));
  router.post('/wallboard/token', h.R('manager'), (req, res) => {
    const fresh = crypto.randomBytes(24).toString('base64url');
    const had = !!token();
    db.setSetting('wall_token', fresh);
    h.log(req, had ? 'Replaced the wall screen link' : 'Created the wall screen link', 'setting', null, 'wall_token');
    h.back(req, res, '/admin/wallboard', 'ok', had ? tr('wall|New link made. The old one no longer works.') : tr('wall|Link created.'));
  });
  router.post('/wallboard/token/off', h.R('manager'), (req, res) => {
    db.setSetting('wall_token', '');
    h.log(req, 'Turned off the wall screen link', 'setting', null, 'wall_token');
    h.back(req, res, '/admin/wallboard', 'ok', tr('wall|Link turned off.'));
  });
  router.post('/wallboard/settings', h.R('manager'), (req, res) => {
    db.setSetting('wall_lang', req.body.lang === 'en' ? 'en' : 'ar');
    db.setSetting('wall_rotate', String(Math.min(120, Math.max(5, h.int(req.body.rotate) || 15))));
    h.back(req, res, '/admin/wallboard', 'ok', tr('Saved.'));
  });
  h.wallboard = { data, json, tokenOk };
};
