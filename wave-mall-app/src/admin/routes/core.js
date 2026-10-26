'use strict';

// Sign-in, first-run setup, the dashboard, search and your own account.

const { hashPassword, verifyPassword } = require('../db');
const { t: tr, tn, tx, isAr } = require('../i18n');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function signinPage(ui, { token, error = '', next = '/admin', email = '', setup = false }) {
  const fields = setup
    ? `${ui.input('name', tr('Your name'), '', { required: true, attrs: { autocomplete: 'name' } })}
       ${ui.input('email', tr('Email'), email, { type: 'email', required: true, attrs: { autocomplete: 'email' } })}
       ${ui.input('password', tr('Password'), '', { type: 'password', required: true, hint: tr('At least 10 characters.'), attrs: { autocomplete: 'new-password', minlength: 10 } })}`
    : `${ui.input('email', tr('Email'), email, { type: 'email', required: true, attrs: { autocomplete: 'username', autofocus: true } })}
       ${ui.input('password', tr('Password'), '', { type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}`;
  const here = setup ? '/admin/setup' : `/admin/login${next && next !== '/admin' ? `?next=${encodeURIComponent(next)}` : ''}`;
  return ui.bare({
    title: setup ? tr('Set up') : tr('Sign in'),
    cls: 'signin',
    body: `<main class="signin__wrap">
  <section class="signin__art">${ui.logo('signin__logo')}<p class="signin__line">${ui.esc(tr('Where every line leads somewhere.'))}</p><p class="signin__foot">${ui.esc(tr('North 90 · New Cairo'))}</p></section>
  <section class="signin__form">
    <div class="signin__lang">${ui.langLink(here)}</div>
    <p class="eyebrow">${ui.esc(setup ? tr('First run') : tr('Leasing office'))}</p>
    <h1>${ui.esc(setup ? tr('Create the first administrator') : tr('Sign in'))}</h1>
    ${setup ? `<p class="muted">${ui.esc(tr('No one has an account yet. The person who sets up the office becomes its administrator and can invite the team.'))}</p>` : ''}
    ${error ? `<p class="alert alert--error">${ui.esc(error)}</p>` : ''}
    <form method="post" action="${setup ? '/admin/setup' : '/admin/login'}" class="stack">
      <input type="hidden" name="_token" value="${ui.esc(token)}"><input type="hidden" name="next" value="${ui.esc(next)}">
      ${fields}
      ${ui.btn(ui.esc(setup ? tr('Create account') : tr('Sign in')), { cls: 'btn--primary btn--block', ic: 'arrow' })}
    </form>
  </section>
</main>`,
  });
}

const safeNext = (n) => (typeof n === 'string' && /^\/admin(\/|$|\?)/.test(n) && !n.startsWith('//') ? n : '/admin');

function publicRoutes(router, h, { loginLimit }) {
  const { db, ui, auth } = h;
  const noUsers = () => !db.value('SELECT COUNT(*) FROM users');

  router.get('/login', (req, res) => {
    if (noUsers()) return res.redirect(303, '/admin/setup');
    if (req.user) return res.redirect(303, safeNext(req.query.next));
    res.type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next: safeNext(req.query.next) }));
  });

  router.post('/login', loginLimit, (req, res) => {
    const email = h.str(req.body.email, 200);
    const next = safeNext(req.body.next);
    if (!auth.checkLoginToken(req)) return res.status(403).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next, email, error: tr('The form expired. Please try again.') }));
    const user = db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
    if (!user || !user.active || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      db.audit(null, 'Failed sign-in', 'user', user ? user.id : null, email, req.ip);
      return res.status(401).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next, email, error: tr('That email and password do not match.') }));
    }
    auth.startSession(db, req, res, user);
    // the language chosen on the sign-in page carries into the office
    const chosen = auth.cookies(req).wv_lang;
    if ((chosen === 'en' || chosen === 'ar') && chosen !== user.lang) db.run('UPDATE users SET lang = ? WHERE id = ?', chosen, user.id);
    db.audit(user, 'Signed in', 'user', user.id, null, req.ip);
    res.redirect(303, next);
  });

  router.get('/setup', (req, res) => {
    if (!noUsers()) return res.redirect(303, '/admin/login');
    res.type('html').send(signinPage(ui, { token: auth.loginToken(req, res), setup: true }));
  });

  router.post('/setup', loginLimit, (req, res) => {
    if (!noUsers()) return res.redirect(303, '/admin/login');
    const name = h.str(req.body.name, 120);
    const email = h.str(req.body.email, 200);
    const password = String(req.body.password || '');
    let error = '';
    if (!auth.checkLoginToken(req)) error = tr('The form expired. Please try again.');
    else if (!name || !EMAIL_RE.test(email)) error = tr('Enter your name and a valid email.');
    else if (password.length < 10) error = tr('Use a password of at least 10 characters.');
    if (error) return res.status(422).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), setup: true, email, error }));
    const r = db.run("INSERT INTO users (name, email, role, password_hash, lang, created_at) VALUES (?, ?, 'admin', ?, ?, ?)", name, email, hashPassword(password), req.lang || null, h.M.now());
    const user = db.get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
    db.audit(user, 'Created the office', 'user', user.id, null, req.ip);
    auth.startSession(db, req, res, user);
    auth.flash(req, res, 'ok', tr('Welcome, {name}. Start by setting your list rates in Settings.', { name }));
    res.redirect(303, '/admin');
  });
}

function privateRoutes(router, h) {
  const { db, ui, M, auth } = h;

  router.post('/logout', (req, res) => {
    h.log(req, 'Signed out', 'user', req.user.id);
    auth.endSession(db, req, res);
    res.redirect(303, '/admin/login');
  });

  // ---------- dashboard ----------
  router.get('/', (req, res) => {
    h.sweep(req);
    const d = M.dashboard(db, req.user);
    const kpis = [
      ui.kpi({ label: tr('Occupancy'), value: ui.pct(d.occupancy, 1), bar: d.occupancy, sub: ui.esc(tr('dash|{a} leased of {b}', { a: ui.m2(d.leased), b: ui.m2(d.gla) })), href: '/admin/units' }),
      ui.kpi({ label: tr('Committed'), value: ui.pct(d.commitment, 1), bar: d.commitment, sub: ui.esc(tr('Leased and reserved')), href: '/admin/units' }),
      ui.kpi({ label: tr('Weighted pipeline'), value: ui.money(d.weighted, { compact: true }), sub: ui.esc(tr('dash|{deals} · {value} a year in play', { deals: tn(d.openCount, 'dash|{n} open deal', 'dash|{n} open deals'), value: ui.money(d.pipeline, { compact: true }) })), href: '/admin/pipeline' }),
      ui.kpi({ label: tr('New leads · 30 days'), value: ui.n0(d.leads30), sub: ui.trend(d.leads30, d.leadsPrev), href: '/admin/leads' }),
      ui.kpi({ label: tr('Signed this month'), value: ui.n0(d.signedCount), sub: ui.esc(d.signedArea ? tr('dash|{area} let', { area: ui.m2(d.signedArea) }) : tr('No leases yet this month')), href: '/admin/leases' }),
      ui.kpi({ label: tr('Overdue rent'), value: ui.money(d.overdue.amount, { compact: true }), tone: d.overdue.amount ? 'kpi--alert' : '', sub: ui.esc(d.overdue.n ? tr('dash|{invoices} past due · {amount} collected this month', { invoices: tn(d.overdue.n, '{n} invoice', '{n} invoices'), amount: ui.money(d.collected, { compact: true }) }) : tr('dash|{amount} collected this month', { amount: ui.money(d.collected, { compact: true }) })), href: '/admin/billing' }),
    ].join('');

    const starting = !db.value('SELECT COUNT(*) FROM leads');
    const start = starting
      ? ui.card(tr('Getting started'), `<ol class="steps">
          <li class="${db.setting('rate_plaza') ? 'is-done' : ''}"><b>${ui.esc(tr('Set your list rates'))}</b><span>${ui.esc(tr('Rent per m² for plaza and street units, terraces and service charge.'))}</span>${ui.btn(ui.esc(tr('Settings')), { href: '/admin/settings', cls: 'btn--ghost btn--sm' })}</li>
          <li class="${db.value('SELECT COUNT(*) FROM users') > 1 ? 'is-done' : ''}"><b>${ui.esc(tr('Invite your team'))}</b><span>${ui.esc(tr('Agents, a sales manager, read-only viewers.'))}</span>${ui.btn(ui.esc(tr('Team')), { href: '/admin/team', cls: 'btn--ghost btn--sm' })}</li>
          <li><b>${ui.esc(tr('Add your first lead'))}</b><span>${ui.esc(tr('Website enquiries arrive here by themselves.'))}</span>${ui.btn(ui.esc(tr('New lead')), { href: '/admin/leads/new', cls: 'btn--ghost btn--sm' })}</li>
          ${h.can(req, 'admin') ? `<li><b>${ui.esc(tr('Or explore with sample data'))}</b><span>${ui.esc(tr('Load a realistic demo pipeline, then clear it with one click.'))}</span>${ui.form('/admin/settings/demo', req.session.csrf, ui.btn(ui.esc(tr('Load demo data')), { cls: 'btn--ghost btn--sm' }))}</li>` : ''}
        </ol>`, { cls: 'span-3' })
      : '';

    const sourceParts = d.bySource.map((s) => ({ label: M.SOURCES[s.source] || s.source, value: s.n }));
    const stageRows = d.byStage.filter((s) => s.id !== 'lost');
    const lostCount = d.byStage.find((s) => s.id === 'lost').count;

    const list = (rows, render, emptyText) => (rows.length ? `<ul class="list">${rows.map(render).join('')}</ul>` : `<p class="muted pad">${emptyText}</p>`);
    const upcoming = list(
      d.upcoming,
      (a) => `<li><a href="/admin/leads/${a.lead_id}"><span class="when"><b>${ui.date(a.due_at).split(' ').slice(0, 2).join(' ')}</b><small>${ui.local(a.due_at).slice(11, 16) || ''}</small></span><span class="what"><b>${ui.esc(tx(a.subject))}</b><small>${ui.esc(a.lead_title || '')} · ${ui.esc(M.ACTIVITY_TYPES[a.type])}${a.user_name ? ` · ${ui.esc(a.user_name)}` : ''}</small></span></a></li>`,
      ui.esc(tr('No viewings or meetings in the next two weeks.')),
    );
    const tasks = list(
      d.tasks,
      (a) => `<li class="${a.due_at < M.today() ? 'is-late' : ''}"><a href="/admin/leads/${a.lead_id || ''}"><span class="dot"></span><span class="what"><b>${ui.esc(tx(a.subject))}</b><small>${ui.esc(a.lead_title || tr('No lead'))} · ${ui.esc(tr('task|due {when}', { when: ui.rel(a.due_at) }))}</small></span></a>${ui.form(`/admin/activities/${a.id}/done`, req.session.csrf, `<button class="iconbtn" title="${ui.esc(tr('Mark done'))}" aria-label="${ui.esc(tr('Mark done'))}">${ui.icon('check')}</button>`)}</li>`,
      ui.esc(tr('Nothing due. Good work.')),
    );
    const attention = [
      ...d.approvals.map((o) => `<li><a href="/admin/offers/${o.id}"><span class="dot dot--amber"></span><span class="what"><b>${ui.esc(tr('dash|Offer {ref} needs approval', { ref: o.ref }))}</b><small>${ui.esc(o.lead_title)} · ${ui.esc(tr('dash|{rate}/m² is below the allowed discount', { rate: ui.money(o.rent_m2) }))}</small></span></a></li>`),
      ...d.holds.map((u) => `<li><a href="/admin/units/${u.id}"><span class="dot dot--amber"></span><span class="what"><b>${ui.esc(tr('dash|Hold on {code} ends {when}', { code: u.code, when: ui.rel(u.hold_until) }))}</b><small>${ui.esc(u.lead_title || '')}</small></span></a></li>`),
      d.overdue.n ? `<li><a href="/admin/billing?status=overdue"><span class="dot dot--rose"></span><span class="what"><b>${ui.esc(tn(d.overdue.n, 'dash|{n} invoice overdue', 'dash|{n} invoices overdue'))}</b><small>${ui.esc(tr('dash|{amount} outstanding', { amount: ui.money(d.overdue.amount) }))}</small></span></a></li>` : '',
      d.inbox ? `<li><a href="/admin/inbox"><span class="dot dot--sea"></span><span class="what"><b>${ui.esc(tn(d.inbox, 'dash|{n} new message from the website', 'dash|{n} new messages from the website'))}</b><small>${ui.esc(tr('Reply within a working day'))}</small></span></a></li>` : '',
    ].join('');
    const feed = d.feed.length
      ? `<ul class="feed">${d.feed.map((a) => `<li><span class="avatar avatar--sm">${ui.esc(ui.initials(a.user_name || 'Website'))}</span><p><b>${ui.esc(a.user_name || tr('System'))}</b> ${ui.esc(isAr() ? tx(a.action) : a.action.toLowerCase())}${a.detail ? ` <span>${ui.esc(tx(a.detail))}</span>` : ''}</p><time>${ui.rel(a.created_at)}</time></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('Activity will appear here.'))}</p>`;

    const hour = new Date().getUTCHours() + 2;
    const greet = hour < 12 ? 'Good morning, {name}.' : hour < 18 ? 'Good afternoon, {name}.' : 'Good evening, {name}.';
    const body = `
<p class="hello">${ui.esc(tr(greet, { name: req.user.name.split(' ')[0] }))} ${d.tasks.length ? tn(d.tasks.length, 'You have <b>{n}</b> task due soon.', 'You have <b>{n}</b> tasks due soon.') : ui.esc(tr('Your desk is clear.'))}</p>
<div class="kpis">${kpis}</div>
<div class="grid">
  ${start}
  ${ui.card(tr('Pipeline'), ui.funnel(stageRows), { cls: 'span-2', sub: ui.esc(tr('dash|{n} lost · annual rent value per stage', { n: lostCount })), action: ui.btn(ui.esc(tr('Open board')), { href: '/admin/pipeline', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('Where leads come from'), sourceParts.length ? ui.donut(sourceParts, { label: ui.n0(sourceParts.reduce((s, p) => s + p.value, 0)) }) : `<p class="muted pad">${ui.esc(tr('No leads yet.'))}</p>`)}
  ${ui.card(tr('Leads per month'), ui.bars(d.months, { key: 'leads', label: 'label', tone: 'sea' }), { sub: ui.esc(tr('Last six months')) })}
  ${ui.card(tr('Area signed per month'), ui.bars(d.months, { key: 'signed', label: 'label', fmtv: (n) => `${ui.n0(n)}`, tone: 'forest' }), { sub: ui.esc(tr('m² of leases signed')) })}
  ${ui.card(tr('Plaza level'), `${ui.plan(d.units, 'G')}${ui.planLegend()}`, { action: ui.btn(ui.esc(tr('All units')), { href: '/admin/units', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('Coming up'), upcoming, { action: ui.btn(ui.esc(tr('Calendar')), { href: '/admin/calendar', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('Your tasks'), tasks, { action: ui.btn(ui.esc(tr('All tasks')), { href: '/admin/calendar#tasks', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('Needs attention'), attention ? `<ul class="list">${attention}</ul>` : `<p class="muted pad">${ui.esc(tr('Nothing needs you right now.'))}</p>`)}
  ${ui.card(tr('Latest activity'), feed, { cls: 'span-3' })}
</div>`;
    h.page(req, res, {
      title: tr('Dashboard'), active: '/admin', body,
      actions: ui.btn(ui.esc(tr('New lead')), { href: '/admin/leads/new', cls: 'btn--primary', ic: 'plus' }),
    });
  });

  // ---------- search (⌘K) ----------
  router.get('/search', (req, res) => {
    const q = h.str(req.query.q, 80);
    if (q.length < 1) return res.json([]);
    const like = `%${q}%`;
    const out = [
      ...db.all('SELECT id, ref, title, stage FROM leads WHERE title LIKE ? OR ref LIKE ? ORDER BY updated_at DESC LIMIT 6', like, like).map((r) => ({ type: tr('search|Lead'), label: r.title, sub: `${r.ref} · ${M.stage(r.stage).label}`, href: `/admin/leads/${r.id}` })),
      ...db.all('SELECT id, name, category FROM brands WHERE name LIKE ? LIMIT 5', like).map((r) => ({ type: tr('search|Brand'), label: r.name, sub: M.CATEGORIES[r.category], href: `/admin/brands/${r.id}` })),
      ...db.all('SELECT c.id, c.name, c.email, c.brand_id, b.name brand FROM contacts c LEFT JOIN brands b ON b.id = c.brand_id WHERE c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? LIMIT 5', like, like, like).map((r) => ({ type: tr('search|Contact'), label: r.name, sub: [r.brand, r.email].filter(Boolean).join(' · '), href: `/admin/brands/${r.brand_id}` })),
      ...db.all('SELECT id, code, status, indoor_m2 FROM units WHERE code LIKE ? LIMIT 5', like).map((r) => ({ type: tr('search|Unit'), label: r.code, sub: `${M.UNIT_STATUS[r.status]} · ${ui.m2(r.indoor_m2)}`, href: `/admin/units/${r.id}` })),
      ...db.all('SELECT o.id, o.ref, o.status, l.title FROM offers o JOIN leads l ON l.id = o.lead_id WHERE o.ref LIKE ? OR l.title LIKE ? LIMIT 4', like, like).map((r) => ({ type: tr('search|Offer'), label: r.ref, sub: `${r.title} · ${M.OFFER_STATUS[r.status]}`, href: `/admin/offers/${r.id}` })),
      ...db.all('SELECT l.id, l.ref, l.status, b.name FROM leases l JOIN brands b ON b.id = l.brand_id WHERE l.ref LIKE ? OR b.name LIKE ? LIMIT 4', like, like).map((r) => ({ type: tr('search|Lease'), label: r.ref, sub: `${r.name} · ${M.LEASE_STATUS[r.status]}`, href: `/admin/leases/${r.id}` })),
      ...db.all('SELECT id, ref, status FROM invoices WHERE ref LIKE ? LIMIT 3', like).map((r) => ({ type: tr('search|Invoice'), label: r.ref, sub: M.INVOICE_STATUS[r.status], href: `/admin/invoices/${r.id}` })),
    ];
    res.json(out);
  });

  // ---------- your account ----------
  router.get('/me', (req, res) => {
    const body = `<div class="grid grid--2">
${ui.card(tr('Your details'), ui.form('/admin/me', req.session.csrf, `<div class="fields">${ui.input('name', tr('Name'), req.user.name, { required: true })}${ui.input('title', tr('Job title'), req.user.title)}${ui.input('phone', tr('Phone'), req.user.phone, { type: 'tel' })}</div>${ui.btn(ui.esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' }))}
${ui.card(tr('Change password'), ui.form('/admin/me/password', req.session.csrf, `<div class="fields">${ui.input('current', tr('Current password'), '', { type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}${ui.input('password', tr('New password'), '', { type: 'password', required: true, hint: tr('At least 10 characters.'), attrs: { autocomplete: 'new-password', minlength: 10 } })}</div>${ui.btn(ui.esc(tr('Update password')), { cls: 'btn--primary' })}`, { cls: 'stack' }))}
</div>`;
    h.page(req, res, { title: tr('Your account'), crumbs: [['/admin', tr('Dashboard')], [null, tr('Account')]], active: '/admin/me', body });
  });
  router.post('/me', (req, res) => {
    const name = h.str(req.body.name, 120);
    if (!name) return h.back(req, res, '/admin/me', 'error', tr('Name is required.'));
    db.run('UPDATE users SET name = ?, title = ?, phone = ? WHERE id = ?', name, h.str(req.body.title, 120) || null, h.str(req.body.phone, 40) || null, req.user.id);
    h.back(req, res, '/admin/me', 'ok', tr('Saved.'));
  });
  router.post('/me/password', (req, res) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(String(req.body.current || ''), u.password_hash)) return h.back(req, res, '/admin/me', 'error', tr('Your current password is not right.'));
    if (String(req.body.password || '').length < 10) return h.back(req, res, '/admin/me', 'error', tr('Use at least 10 characters.'));
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(req.body.password)), u.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, req.session.id);
    h.log(req, 'Changed password', 'user', u.id);
    h.back(req, res, '/admin/me', 'ok', tr('Password updated. Other sessions were signed out.'));
  });
}


module.exports = { public: publicRoutes, private: privateRoutes };
