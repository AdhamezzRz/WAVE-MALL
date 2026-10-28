'use strict';

// Valet (/admin/parking/valet): the car is handed over at the valet point with a key tag, its
// condition is recorded (with photos), a runner parks it in a valet bay, the customer asks for it
// back from the link on the valet ticket (or by WhatsApp, or by phone), and it is delivered once
// the visit is paid. The valet fee goes on the visit and is paid at the booth with the parking.
//   received → parked → requested → ready → delivered (or cancelled)

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const i18n = require('../i18n');
const qr = require('../qr');
const { registerDocs, uploadRoute } = require('../ops-common');

const { t: tr } = i18n;
const STATUS = {
  received: ['prk|Handed over', 'sky'], parked: ['prk|Parked', 'forest'], requested: ['prk|Asked for', 'amber'],
  ready: ['prk|Ready', 'ok'], delivered: ['prk|Delivered', 'mute'], cancelled: ['prk|Cancelled', 'mute'],
};
const SIDES = { front: 'prk|Front', back: 'prk|Back', left: 'prk|Left side', right: 'prk|Right side', roof: 'prk|Roof', inside: 'prk|Inside', wheels: 'prk|Wheels' };
const ACTIVE = ['received', 'parked', 'requested', 'ready'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = function valetRoutes(router, h, c) {
  const { db, ui, M } = h;
  const { P, esc } = c;
  const now = () => new Date().toISOString();
  const badge = (s) => ui.badge(s, tr((STATUS[s] || [s])[0]), (STATUS[s] || [])[1]);
  registerDocs(M, 'pk_valet', 'prk|Valet car', { valet_photo: 'prk|Photo of the car' });
  const docs = uploadRoute(router, h, '/parking/valet/upload', { pk_valet: 'pk_valet' });
  const tags = () => Math.max(20, Number(db.setting('prk_valet_tags')) || 150);
  const freeTag = () => {
    const used = new Set(db.all(`SELECT tag FROM pk_valet WHERE status IN (${ACTIVE.map(() => '?').join(',')})`, ...ACTIVE).map((x) => x.tag));
    for (let t = 1; t <= tags(); t++) if (!used.has(t)) return t;
    return null;
  };
  const valetBy = (id) => db.get('SELECT v.*, b.code bay_code FROM pk_valet v LEFT JOIN pk_bays b ON b.id = v.bay_id WHERE v.id = ?', id);
  const linkOf = (req, token) => `${c.site(req)}/parking/valet/${token}`;
  const minutes = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : null);
  // the customer hears from us on WhatsApp when it is set up (a 24-hour conversation, or approved templates)
  const tell = (v, text) => {
    if (!v.phone || !h.whatsapp || !h.whatsapp.configured || !h.whatsapp.configured() || v.demo) return;
    Promise.resolve(h.whatsapp.sendText(v.phone, text)).catch((e) => console.error('[valet] WhatsApp:', e.message));
  };

  // ---------- the board ----------
  router.get('/parking/valet', (req, res) => {
    const list = db.all(`SELECT v.*, b.code bay_code, u.name runner FROM pk_valet v LEFT JOIN pk_bays b ON b.id = v.bay_id LEFT JOIN users u ON u.id = v.runner_id WHERE v.status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY v.received_at`, ...ACTIVE);
    const from = c.dayStart(c.today());
    const done = db.all("SELECT * FROM pk_valet WHERE delivered_at >= ? AND requested_at IS NOT NULL", from);
    const waits = done.map((v) => minutes(v.requested_at, v.delivered_at)).filter((x) => x !== null);
    const avg = waits.length ? Math.round(waits.reduce((s, x) => s + x, 0) / waits.length) : null;
    const today = db.get("SELECT COUNT(*) n, COALESCE(SUM(fee), 0) fees FROM pk_valet WHERE received_at >= ? AND status != 'cancelled'", from);
    const kpis = [
      ui.kpi({ label: tr('prk|Valet cars now'), value: ui.n0(list.length), sub: esc(tr('prk|{n} key tags free', { n: tags() - list.length })) }),
      ui.kpi({ label: tr('prk|Waiting for their car'), value: ui.n0(list.filter((v) => v.status === 'requested').length), tone: list.some((v) => v.status === 'requested' && minutes(v.requested_at, now()) > 10) ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('prk|Average wait today'), value: avg === null ? '—' : esc(c.dur(avg)) }),
      ui.kpi({ label: tr('prk|Valet today'), value: ui.n0(today.n), sub: esc(c.money(today.fees)) }),
    ].join('');
    const col = (st, title) => {
      const items = list.filter((v) => v.status === st);
      return `<section class="pkv-col pkv-col--${st}"><header><b>${esc(tr(title))}</b><span>${ui.n0(items.length)}</span></header>${items.map((v) => {
        const wait = st === 'requested' ? minutes(v.requested_at, now()) : null;
        return `<a class="pkv-card${wait !== null && wait > 10 ? ' is-late' : ''}" href="/admin/parking/valet/${v.id}"><span class="pkv-tag">${v.tag}</span><span class="what"><b><bdi>${esc(v.plate || '—')}</bdi></b><small>${esc([v.name, v.bay_code, wait !== null ? tr('prk|waiting {time}', { time: c.dur(wait) }) : null].filter(Boolean).join(' · '))}</small></span></a>`;
      }).join('') || `<p class="muted small pad">${esc(tr('prk|None'))}</p>`}</section>`;
    };
    const board = `<div class="pkv-board" data-autoreload="20">${col('requested', 'prk|Asked for')}${col('ready', 'prk|Ready')}${col('received', 'prk|To park')}${col('parked', 'prk|Parked')}</div>`;
    const tag = freeTag();
    const form = h.can(req, 'agent') ? ui.card(tr('prk|Take a car'), ui.form('/admin/parking/valet', req.session.csrf, `<div class="fields">
        ${ui.input('plate', tr('prk|Plate'), '', { required: true, placeholder: 'ق ص ر 1234', attrs: { autocomplete: 'off' } })}
        ${ui.input('tag', tr('prk|Key tag'), tag || '', { type: 'number', min: 1, max: tags(), required: true })}
        ${ui.input('name', tr('Name'), '')}
        ${ui.input('phone', tr('prk|Mobile'), '', { type: 'tel', placeholder: '01012345678' })}
        ${ui.input('fee', tr('prk|Valet fee'), P.S('prk_valet_fee'), { type: 'number', min: 0, step: 1 })}
      </div>
      <fieldset class="pkv-cond"><legend class="f__l">${esc(tr('prk|Marks already on the car'))}</legend>${Object.entries(SIDES).map(([k, l]) => `<label class="check"><input type="checkbox" name="cond_${k}" value="1"> ${esc(tr(l))}</label>`).join('')}</fieldset>
      ${ui.textarea('notes', tr('prk|Notes'), '', { rows: 2, placeholder: tr('prk|e.g. Scratch on the rear bumper, a laptop bag on the back seat') })}
      ${ui.btn(esc(tr('prk|Take the car and print the ticket')), { cls: 'btn--primary btn--block', ic: 'print' })}`, { cls: 'stack' }), { sub: esc(tr('prk|Add photos of the car on the next page.')) }) : '';
    c.page(req, res, { title: tr('prk|Valet'), crumbs: c.crumbs([null, tr('prk|Valet')]), body: `${c.tabs('/admin/parking/valet')}<div class="kpis kpis--4">${kpis}</div><div class="grid grid--side"><div>${board}</div><div class="stack">${form}</div></div>` });
  });

  router.post('/parking/valet', c.RA, (req, res) => {
    const plate = h.str(req.body.plate, 30);
    const key = P.plateKey(plate);
    if (!key) return c.back(req, res, '/admin/parking/valet', 'error', tr('prk|Type the plate.'));
    const tag = h.int(req.body.tag);
    if (!tag || tag < 1 || tag > tags()) return c.back(req, res, '/admin/parking/valet', 'error', tr('prk|Choose a key tag between 1 and {n}.', { n: tags() }));
    if (db.get(`SELECT id FROM pk_valet WHERE tag = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`, tag, ...ACTIVE)) return c.back(req, res, '/admin/parking/valet', 'error', tr('prk|Key tag {n} is already on another car.', { n: tag }));
    if (db.get(`SELECT id FROM pk_valet WHERE plate_key = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`, key, ...ACTIVE)) return c.back(req, res, '/admin/parking/valet', 'error', tr('prk|This car is already with the valet.'));
    const fee = Math.max(0, h.numv(req.body.fee) ?? Number(P.S('prk_valet_fee')));
    const condition = Object.keys(SIDES).filter((k) => req.body[`cond_${k}`] === '1');
    const token = crypto.randomBytes(18).toString('base64url');
    const id = db.tx(() => {
      // the car's visit: the one inside, or a new one from the valet point
      let s = P.findInside({ plate: key });
      if (!s) s = P.entry({ plate, via: 'manual', user: req.user, force: true }).session;
      if (['visitor', 'booking'].includes(s.kind)) db.run("UPDATE pk_sessions SET kind = 'valet', updated_at = ? WHERE id = ?", now(), s.id);
      if (fee > 0) P.addExtra(s, fee);
      // the customer's link (on the valet ticket) works until the keys are handed back
      return Number(db.run(`INSERT INTO pk_valet (ref, tag, session_id, plate, plate_key, name, phone, condition, notes, fee, status, token_hash, token, received_at, received_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?)`, db.nextRef('pk_valet', 'VL', 5, true), tag, s.id, P.plateShow(plate), key, h.str(req.body.name, 80) || null,
      h.str(req.body.phone, 30) || null, JSON.stringify(condition), h.str(req.body.notes, 1000) || null, fee, sha(token), token, now(), req.user.id).lastInsertRowid);
    });
    const v = valetBy(id);
    h.log(req, 'Took a valet car', 'pk_valet', id, `${v.ref} · ${v.plate} · tag ${tag}`);
    tell(v, i18n.run('ar', () => tr('prk|The Wave valet: your key tag is {n}. When you want your car, open {link}', { n: tag, link: linkOf(req, token) })));
    res.redirect(303, `/admin/parking/valet/${id}?print=1`);
  });

  router.get('/parking/valet/:id', (req, res, next) => {
    const v = valetBy(h.int(req.params.id));
    if (!v) return next();
    const s = v.session_id ? P.sessionBy(v.session_id) : null;
    const q = s ? P.quoteOf(s) : null;
    const csrf = req.session.csrf;
    const agent = h.can(req, 'agent');
    const step = (st, label, extra = '', attrs = {}) => ui.form(`/admin/parking/valet/${v.id}/status`, csrf, `<input type="hidden" name="status" value="${st}">${extra}${ui.btn(esc(tr(label)), { cls: 'btn--primary btn--block', attrs })}`, { cls: 'stack' });
    const valetBays = db.all("SELECT b.id, b.code FROM pk_bays b WHERE b.active = 1 AND b.kind = 'valet' AND b.id NOT IN (SELECT bay_id FROM pk_valet WHERE bay_id IS NOT NULL AND status IN ('parked','requested','ready')) ORDER BY b.code");
    let action = '';
    if (agent) {
      if (v.status === 'received') action = step('parked', 'prk|Parked', `<div class="fields">${ui.select('bay', tr('prk|Valet bay'), valetBays.map((b) => [b.code, b.code]), valetBays[0] ? valetBays[0].code : '', { blank: tr('prk|Another place') })}${ui.input('place', tr('prk|Or where'), '', { placeholder: tr('prk|e.g. B2-C14') })}</div>`);
      else if (v.status === 'parked') action = step('requested', 'prk|The customer asked for the car');
      else if (v.status === 'requested') action = step('ready', 'prk|The car is at the valet point');
      else if (v.status === 'ready') {
        action = q && q.due > 0
          ? `<p class="alert alert--warn">${esc(tr('prk|{amount} to pay before the keys are handed back.', { amount: c.money(q.due) }))} <a href="/admin/parking/booth?q=${encodeURIComponent(P.codeShow(s.code))}">${esc(tr('prk|Take payment at the booth'))}</a></p>`
          : step('delivered', 'prk|Keys handed back');
      }
    }
    const times = [['received_at', 'prk|Handed over'], ['parked_at', 'prk|Parked'], ['requested_at', 'prk|Asked for'], ['ready_at', 'prk|Ready'], ['delivered_at', 'prk|Delivered']].filter(([k]) => v[k]);
    const cond = JSON.parse(v.condition || '[]');
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('prk|Key tag'))}</dt><dd><b class="pkv-tag pkv-tag--big">${v.tag}</b></dd></div>
      <div><dt>${esc(tr('prk|Plate'))}</dt><dd>${c.plate(v.plate, 'pk-plate--sm')}</dd></div>
      ${v.name || v.phone ? `<div><dt>${esc(tr('prk|Customer'))}</dt><dd>${esc([v.name, v.phone].filter(Boolean).join(' · '))}</dd></div>` : ''}
      <div><dt>${esc(tr('prk|Where'))}</dt><dd>${esc(v.bay_code || v.place || '—')}</dd></div>
      <div><dt>${esc(tr('prk|Marks already on the car'))}</dt><dd>${cond.length ? esc(cond.map((k) => tr(SIDES[k])).join(i18n.isAr() ? '، ' : ', ')) : esc(tr('prk|None'))}${v.notes ? `<br><small>${esc(v.notes)}</small>` : ''}</dd></div>
      <div><dt>${esc(tr('prk|Valet fee'))}</dt><dd>${c.money(v.fee)}</dd></div>
      ${s ? `<div><dt>${esc(tr('prk|Visit'))}</dt><dd><a href="/admin/parking/visits/${s.id}">${esc(s.ref)}</a>${q ? ` · ${esc(tr('prk|to pay {amount}', { amount: c.money(q.due) }))}` : ''}</dd></div>` : ''}</dl>
      <ol class="pkv-times">${times.map(([k, l]) => `<li><b>${esc(tr(l))}</b><span>${esc(ui.local(v[k]).slice(11, 16))}</span></li>`).join('')}</ol>`;
    const token = v.token;
    const ticket = token && ACTIVE.includes(v.status) ? ui.card(tr('prk|Valet ticket'), `<div class="pk-qrbox">${qr.svg(linkOf(req, token), { ecl: 'M', cls: 'pk-qr' })}<p class="pkv-tag pkv-tag--big">${v.tag}</p><p class="muted small">${esc(tr('prk|The customer scans this to ask for the car.'))}</p>${ui.btn(esc(tr('prk|Print the valet ticket')), { href: `/admin/parking/valet/${v.id}/ticket`, cls: 'btn--ghost btn--sm', ic: 'print', attrs: { target: '_blank' } })}</div>`) : '';
    const cancel = agent && ACTIVE.includes(v.status) ? `<details class="upload-box"><summary>${ui.icon('x')}<span>${esc(tr('prk|Cancel the valet'))}</span></summary>${step('cancelled', 'prk|Cancel the valet', ui.input('reason', tr('prk|Why'), '', { required: true }), { 'data-confirm': tr('prk|Cancel the valet for this car?') })}</details>` : '';
    c.page(req, res, {
      title: tr('prk|Key tag {n}', { n: v.tag }), crumbs: c.crumbs(['/admin/parking/valet', tr('prk|Valet')], [null, v.ref]),
      body: `${req.query.print ? `<p class="alert alert--ok">${esc(tr('prk|Car taken. Print the valet ticket for the customer.'))} <a href="/admin/parking/valet/${v.id}/ticket" target="_blank">${esc(tr('prk|Print the valet ticket'))}</a></p>` : ''}<div class="grid grid--side"><div class="stack">${ui.card(v.ref, `${facts}`, { action: badge(v.status) })}${docs(req, 'pk_valet', v.id, { title: tr('prk|Photos of the car'), sub: esc(tr('prk|Take them before the car is parked.')) })}</div><div class="stack">${action ? ui.card(tr('prk|Next'), action) : ''}${ticket}${cancel}</div></div>`,
    });
  });

  router.post('/parking/valet/:id/status', c.RA, (req, res, next) => {
    const v = valetBy(h.int(req.params.id));
    if (!v) return next();
    const to = String(req.body.status);
    const order = { received: ['parked', 'cancelled'], parked: ['requested', 'cancelled'], requested: ['ready', 'cancelled'], ready: ['delivered', 'cancelled'] };
    if (!(order[v.status] || []).includes(to)) return c.back(req, res, `/admin/parking/valet/${v.id}`, 'error', tr('prk|That step is not possible now.'));
    const t = now();
    if (to === 'parked') {
      const bay = req.body.bay ? db.get('SELECT * FROM pk_bays WHERE code = ?', String(req.body.bay).toUpperCase()) : null;
      db.run("UPDATE pk_valet SET status = 'parked', parked_at = ?, bay_id = ?, place = ?, runner_id = ? WHERE id = ?", t, bay ? bay.id : null, bay ? null : h.str(req.body.place, 40) || null, req.user.id, v.id);
      if (bay && v.session_id) db.run('UPDATE pk_sessions SET bay_id = ?, zone_id = ? WHERE id = ?', bay.id, bay.zone_id, v.session_id);
    } else if (to === 'requested') db.run("UPDATE pk_valet SET status = 'requested', requested_at = ? WHERE id = ?", t, v.id);
    else if (to === 'ready') {
      db.run("UPDATE pk_valet SET status = 'ready', ready_at = ? WHERE id = ?", t, v.id);
      tell(v, i18n.run('ar', () => tr('prk|The Wave valet: your car (key tag {n}) is ready at the valet point.', { n: v.tag })));
    } else if (to === 'delivered') {
      const s = v.session_id ? P.sessionBy(v.session_id) : null;
      if (s && s.status === 'inside' && P.quoteOf(s).due > 0) return c.back(req, res, `/admin/parking/valet/${v.id}`, 'error', tr('prk|{amount} to pay before the keys are handed back.', { amount: c.money(P.quoteOf(s).due) }));
      db.run("UPDATE pk_valet SET status = 'delivered', delivered_at = ?, delivered_by = ?, token = NULL WHERE id = ?", t, req.user.id, v.id);
    } else if (to === 'cancelled') {
      const s = v.session_id ? P.sessionBy(v.session_id) : null;
      if (s && s.status === 'inside' && v.fee > 0) P.addExtra(s, -v.fee);
      if (s && s.kind === 'valet' && s.status === 'inside') db.run("UPDATE pk_sessions SET kind = 'visitor' WHERE id = ?", s.id);
      db.run("UPDATE pk_valet SET status = 'cancelled', token = NULL, notes = TRIM(COALESCE(notes, '') || ' ' || ?) WHERE id = ?", `Cancelled: ${h.str(req.body.reason, 200)}`, v.id);
    }
    h.log(req, 'Valet', 'pk_valet', v.id, `${v.ref} · ${to}`);
    c.back(req, res, `/admin/parking/valet/${v.id}`, 'ok', tr((STATUS[to] || [to])[0]));
  });

  router.get('/parking/valet/:id/ticket', (req, res, next) => {
    const v = valetBy(h.int(req.params.id));
    const token = v && v.token;
    if (!v || !token) return next();
    res.type('html').send(ui.bare({ title: tr('prk|Valet ticket'), cls: 'print pk-print', body: `<div class="pk-print__bar noprint"><button type="button" class="btn btn--primary" data-print>${ui.icon('print')}<span>${esc(tr('Print'))}</span></button></div><article class="pk-ticket">
  ${ui.logo('pk-ticket__logo')}<p class="eyebrow">${esc(tr('prk|Valet ticket'))}</p>
  <p class="pkv-tag pkv-tag--big">${v.tag}</p>
  ${qr.svg(linkOf(req, token), { ecl: 'M', cls: 'pk-ticket__qr', label: tr('prk|Key tag {n}', { n: v.tag }) })}
  <p class="pk-ticket__plate"><bdi>${esc(v.plate || '')}</bdi></p>
  <p>${esc(tr('prk|Handed over at {time}', { time: ui.dt(v.received_at) }))}</p>
  <p class="pk-ticket__help">${esc(tr('prk|Scan the code when you want your car. We bring it to the valet point and tell you when it is ready.'))}</p></article>` }));
  });

  // ---------- the customer: ask for the car ----------
  const pub = express.Router();
  h.public.use('/parking/valet', pub);
  pub.use(express.urlencoded({ extended: false, limit: '4kb' }));
  pub.use((req, res, nxt) => {
    const q = String(req.query.lang || (req.body && req.body.lang) || '');
    req.lang = q === 'ar' || q === 'en' ? q : /^ar\b/i.test(String(req.get('accept-language') || '')) ? 'ar' : 'en';
    res.set('X-Robots-Tag', 'noindex');
    i18n.run(req.lang, nxt);
  });
  const askLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const byToken = (t) => (/^[\w-]{20,40}$/.test(String(t)) ? db.get('SELECT * FROM pk_valet WHERE token_hash = ?', sha(t)) : null);
  const shell = (req, res, body, status = 200) => {
    ui.setCurrency(db.setting('currency'));
    const other = req.lang === 'ar' ? 'en' : 'ar';
    res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="${req.lang}" dir="${req.lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#283833"><meta name="robots" content="noindex"><title>${esc(tr('prk|Valet'))} · The Wave</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/admin/admin.css?v=${ui.ASSETS.css}"></head>
<body class="adm portal paypage pk-public"><main class="paywrap pk-wrap"><header class="paywrap__head">${ui.logo('paywrap__logo')}<a class="langbtn" href="?lang=${other}" lang="${other}">${ui.icon('globe')}<span>${other === 'ar' ? 'العربية' : 'English'}</span></a></header>${body}</main><script src="/admin/parking.js?v=${ui.ASSETS.parking}" defer></script></body></html>`);
  };
  pub.get('/:token', (req, res, nxt) => {
    const v = byToken(req.params.token);
    if (!v) return nxt();
    const s = v.session_id ? P.sessionBy(v.session_id) : null;
    const due = s && s.status === 'inside' ? P.quoteOf(s).due : 0;
    const recent = db.all("SELECT requested_at, ready_at FROM pk_valet WHERE ready_at IS NOT NULL AND requested_at IS NOT NULL ORDER BY id DESC LIMIT 20").map((x) => minutes(x.requested_at, x.ready_at));
    const eta = recent.length ? Math.max(3, Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)) : 8;
    const state = {
      received: tr('prk|We have your car. A valet is parking it now.'), parked: tr('prk|Your car is parked safely.'),
      requested: tr('prk|We are bringing your car. It is usually ready in about {n} minutes.', { n: eta }), ready: tr('prk|Your car is ready at the valet point.'),
      delivered: tr('prk|Your car has been handed back. Thank you.'), cancelled: tr('prk|This valet ticket is no longer in use.'),
    }[v.status];
    const ask = v.status === 'parked' || v.status === 'received'
      ? `<form method="post" action="/parking/valet/${esc(req.params.token)}" class="stack"><input type="hidden" name="lang" value="${req.lang}">${ui.btn(esc(tr('prk|Bring my car')), { cls: 'btn--primary btn--block', ic: 'car' })}</form>` : '';
    shell(req, res, `<section class="payhead"><p class="eyebrow">${esc(tr('prk|The Wave valet'))}</p><h1>${esc(tr('prk|Key tag {n}', { n: v.tag }))}</h1></section>
<section class="card paycard" data-autoreload="30"><div class="card__body stack"><p class="pkv-state pkv-state--${v.status}">${esc(state)}</p>
${due > 0 && ACTIVE.includes(v.status) ? `<p class="muted">${esc(tr('prk|To pay at the valet point: {amount}.', { amount: c.money(due) }))}</p>` : ''}${ask}</div></section>`);
  });
  pub.post('/:token', askLimit, (req, res, nxt) => {
    const v = byToken(req.params.token);
    if (!v) return nxt();
    if (v.status === 'parked' || v.status === 'received') {
      db.run("UPDATE pk_valet SET status = 'requested', requested_at = ? WHERE id = ?", now(), v.id);
      db.audit(null, 'Valet car asked for', 'pk_valet', v.id, `${v.ref} · tag ${v.tag}`, req.ip);
    }
    res.redirect(303, `/parking/valet/${req.params.token}?lang=${req.lang}`);
  });
};

module.exports.STATUS = STATUS;
module.exports.SIDES = SIDES;
