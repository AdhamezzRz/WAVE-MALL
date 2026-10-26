'use strict';

// Sign-in, first-run setup, the dashboard, search and your own account.

const { hashPassword, verifyPassword } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function signinPage(ui, { token, error = '', next = '/admin', email = '', setup = false }) {
  const fields = setup
    ? `${ui.input('name', 'Your name', '', { required: true, attrs: { autocomplete: 'name' } })}
       ${ui.input('email', 'Email', email, { type: 'email', required: true, attrs: { autocomplete: 'email' } })}
       ${ui.input('password', 'Password', '', { type: 'password', required: true, hint: 'At least 10 characters.', attrs: { autocomplete: 'new-password', minlength: 10 } })}`
    : `${ui.input('email', 'Email', email, { type: 'email', required: true, attrs: { autocomplete: 'username', autofocus: true } })}
       ${ui.input('password', 'Password', '', { type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}`;
  return ui.bare({
    title: setup ? 'Set up' : 'Sign in',
    cls: 'signin',
    body: `<main class="signin__wrap">
  <section class="signin__art">${ui.logo('signin__logo')}<p class="signin__line">Where every line leads somewhere.</p><p class="signin__foot">North 90 · New Cairo</p></section>
  <section class="signin__form">
    <p class="eyebrow">${setup ? 'First run' : 'Leasing office'}</p>
    <h1>${setup ? 'Create the first administrator' : 'Sign in'}</h1>
    ${setup ? '<p class="muted">No one has an account yet. The person who sets up the office becomes its administrator and can invite the team.</p>' : ''}
    ${error ? `<p class="alert alert--error">${ui.esc(error)}</p>` : ''}
    <form method="post" action="${setup ? '/admin/setup' : '/admin/login'}" class="stack">
      <input type="hidden" name="_token" value="${ui.esc(token)}"><input type="hidden" name="next" value="${ui.esc(next)}">
      ${fields}
      ${ui.btn(setup ? 'Create account' : 'Sign in', { cls: 'btn--primary btn--block', ic: 'arrow' })}
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
    if (!auth.checkLoginToken(req)) return res.status(403).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next, email, error: 'The form expired. Please try again.' }));
    const user = db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
    if (!user || !user.active || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      db.audit(null, 'Failed sign-in', 'user', user ? user.id : null, email, req.ip);
      return res.status(401).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next, email, error: 'That email and password do not match.' }));
    }
    auth.startSession(db, req, res, user);
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
    if (!auth.checkLoginToken(req)) error = 'The form expired. Please try again.';
    else if (!name || !EMAIL_RE.test(email)) error = 'Enter your name and a valid email.';
    else if (password.length < 10) error = 'Use a password of at least 10 characters.';
    if (error) return res.status(422).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), setup: true, email, error }));
    const r = db.run("INSERT INTO users (name, email, role, password_hash, created_at) VALUES (?, ?, 'admin', ?, ?)", name, email, hashPassword(password), h.M.now());
    const user = db.get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
    db.audit(user, 'Created the office', 'user', user.id, null, req.ip);
    auth.startSession(db, req, res, user);
    auth.flash(req, res, 'ok', `Welcome, ${name}. Start by setting your list rates in Settings.`);
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
      ui.kpi({ label: 'Occupancy', value: ui.pct(d.occupancy, 1), bar: d.occupancy, sub: `${ui.m2(d.leased)} leased of ${ui.m2(d.gla)}`, href: '/admin/units' }),
      ui.kpi({ label: 'Committed', value: ui.pct(d.commitment, 1), bar: d.commitment, sub: 'Leased and reserved', href: '/admin/units' }),
      ui.kpi({ label: 'Weighted pipeline', value: ui.money(d.weighted, { compact: true }), sub: `${d.openCount} open deals · ${ui.money(d.pipeline, { compact: true })} a year in play`, href: '/admin/pipeline' }),
      ui.kpi({ label: 'New leads · 30 days', value: ui.n0(d.leads30), sub: ui.trend(d.leads30, d.leadsPrev), href: '/admin/leads' }),
      ui.kpi({ label: 'Signed this month', value: ui.n0(d.signedCount), sub: d.signedArea ? `${ui.m2(d.signedArea)} let` : 'No leases yet this month', href: '/admin/leases' }),
      ui.kpi({ label: 'Overdue rent', value: ui.money(d.overdue.amount, { compact: true }), tone: d.overdue.amount ? 'kpi--alert' : '', sub: d.overdue.n ? `${d.overdue.n} invoices past due · ${ui.money(d.collected, { compact: true })} collected this month` : `${ui.money(d.collected, { compact: true })} collected this month`, href: '/admin/billing' }),
    ].join('');

    const starting = !db.value('SELECT COUNT(*) FROM leads');
    const start = starting
      ? ui.card('Getting started', `<ol class="steps">
          <li class="${db.setting('rate_plaza') ? 'is-done' : ''}"><b>Set your list rates</b><span>Rent per m² for plaza and street units, terraces and service charge.</span>${ui.btn('Settings', { href: '/admin/settings', cls: 'btn--ghost btn--sm' })}</li>
          <li class="${db.value('SELECT COUNT(*) FROM users') > 1 ? 'is-done' : ''}"><b>Invite your team</b><span>Agents, a sales manager, read-only viewers.</span>${ui.btn('Team', { href: '/admin/team', cls: 'btn--ghost btn--sm' })}</li>
          <li><b>Add your first lead</b><span>Website enquiries arrive here by themselves.</span>${ui.btn('New lead', { href: '/admin/leads/new', cls: 'btn--ghost btn--sm' })}</li>
          ${h.can(req, 'admin') ? `<li><b>Or explore with sample data</b><span>Load a realistic demo pipeline, then clear it with one click.</span>${ui.form('/admin/settings/demo', req.session.csrf, ui.btn('Load demo data', { cls: 'btn--ghost btn--sm' }))}</li>` : ''}
        </ol>`, { cls: 'span-3' })
      : '';

    const sourceParts = d.bySource.map((s) => ({ label: M.SOURCES[s.source] || s.source, value: s.n }));
    const stageRows = d.byStage.filter((s) => s.id !== 'lost');
    const lostCount = d.byStage.find((s) => s.id === 'lost').count;

    const list = (rows, render, emptyText) => (rows.length ? `<ul class="list">${rows.map(render).join('')}</ul>` : `<p class="muted pad">${emptyText}</p>`);
    const upcoming = list(
      d.upcoming,
      (a) => `<li><a href="/admin/leads/${a.lead_id}"><span class="when"><b>${ui.date(a.due_at).split(' ').slice(0, 2).join(' ')}</b><small>${ui.local(a.due_at).slice(11, 16) || ''}</small></span><span class="what"><b>${ui.esc(a.subject)}</b><small>${ui.esc(a.lead_title || '')} · ${ui.esc(M.ACTIVITY_TYPES[a.type])}${a.user_name ? ` · ${ui.esc(a.user_name)}` : ''}</small></span></a></li>`,
      'No viewings or meetings in the next two weeks.',
    );
    const tasks = list(
      d.tasks,
      (a) => `<li class="${a.due_at < M.today() ? 'is-late' : ''}"><a href="/admin/leads/${a.lead_id || ''}"><span class="dot"></span><span class="what"><b>${ui.esc(a.subject)}</b><small>${ui.esc(a.lead_title || 'No lead')} · due ${ui.rel(a.due_at)}</small></span></a>${ui.form(`/admin/activities/${a.id}/done`, req.session.csrf, `<button class="iconbtn" title="Mark done" aria-label="Mark done">${ui.icon('check')}</button>`)}</li>`,
      'Nothing due. Good work.',
    );
    const attention = [
      ...d.approvals.map((o) => `<li><a href="/admin/offers/${o.id}"><span class="dot dot--amber"></span><span class="what"><b>Offer ${ui.esc(o.ref)} needs approval</b><small>${ui.esc(o.lead_title)} · ${ui.money(o.rent_m2)}/m² is below the allowed discount</small></span></a></li>`),
      ...d.holds.map((u) => `<li><a href="/admin/units/${u.id}"><span class="dot dot--amber"></span><span class="what"><b>Hold on ${ui.esc(u.code)} ends ${ui.rel(u.hold_until)}</b><small>${ui.esc(u.lead_title || '')}</small></span></a></li>`),
      d.overdue.n ? `<li><a href="/admin/billing?status=overdue"><span class="dot dot--rose"></span><span class="what"><b>${d.overdue.n} invoices overdue</b><small>${ui.money(d.overdue.amount)} outstanding</small></span></a></li>` : '',
      d.inbox ? `<li><a href="/admin/inbox"><span class="dot dot--sea"></span><span class="what"><b>${d.inbox} new messages from the website</b><small>Reply within a working day</small></span></a></li>` : '',
    ].join('');
    const feed = d.feed.length
      ? `<ul class="feed">${d.feed.map((a) => `<li><span class="avatar avatar--sm">${ui.esc(ui.initials(a.user_name || 'Website'))}</span><p><b>${ui.esc(a.user_name || 'System')}</b> ${ui.esc(a.action.toLowerCase())}${a.detail ? ` <span>${ui.esc(a.detail)}</span>` : ''}</p><time>${ui.rel(a.created_at)}</time></li>`).join('')}</ul>`
      : '<p class="muted pad">Activity will appear here.</p>';

    const greet = new Date().getUTCHours() + 2 < 12 ? 'Good morning' : new Date().getUTCHours() + 2 < 18 ? 'Good afternoon' : 'Good evening';
    const body = `
<p class="hello">${greet}, ${ui.esc(req.user.name.split(' ')[0])}. ${d.tasks.length ? `You have <b>${d.tasks.length}</b> task${d.tasks.length > 1 ? 's' : ''} due soon.` : 'Your desk is clear.'}</p>
<div class="kpis">${kpis}</div>
<div class="grid">
  ${start}
  ${ui.card('Pipeline', ui.funnel(stageRows), { cls: 'span-2', sub: `${lostCount} lost · annual rent value per stage`, action: ui.btn('Open board', { href: '/admin/pipeline', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card('Where leads come from', sourceParts.length ? ui.donut(sourceParts, { label: ui.n0(sourceParts.reduce((s, p) => s + p.value, 0)) }) : '<p class="muted pad">No leads yet.</p>')}
  ${ui.card('Leads per month', ui.bars(d.months, { key: 'leads', label: 'label', tone: 'sea' }), { sub: 'Last six months' })}
  ${ui.card('Area signed per month', ui.bars(d.months, { key: 'signed', label: 'label', fmtv: (n) => `${ui.n0(n)}`, tone: 'forest' }), { sub: 'm² of leases signed' })}
  ${ui.card('Plaza level', `${ui.plan(d.units, 'G')}${ui.planLegend()}`, { action: ui.btn('All units', { href: '/admin/units', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card('Coming up', upcoming, { action: ui.btn('Calendar', { href: '/admin/calendar', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card('Your tasks', tasks, { action: ui.btn('All tasks', { href: '/admin/calendar#tasks', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card('Needs attention', attention ? `<ul class="list">${attention}</ul>` : '<p class="muted pad">Nothing needs you right now.</p>')}
  ${ui.card('Latest activity', feed, { cls: 'span-3' })}
</div>`;
    h.page(req, res, {
      title: 'Dashboard', active: '/admin', body,
      actions: ui.btn('New lead', { href: '/admin/leads/new', cls: 'btn--primary', ic: 'plus' }),
    });
  });

  // ---------- search (⌘K) ----------
  router.get('/search', (req, res) => {
    const q = h.str(req.query.q, 80);
    if (q.length < 1) return res.json([]);
    const like = `%${q}%`;
    const out = [
      ...db.all('SELECT id, ref, title, stage FROM leads WHERE title LIKE ? OR ref LIKE ? ORDER BY updated_at DESC LIMIT 6', like, like).map((r) => ({ type: 'Lead', label: r.title, sub: `${r.ref} · ${M.stage(r.stage).label}`, href: `/admin/leads/${r.id}` })),
      ...db.all('SELECT id, name, category FROM brands WHERE name LIKE ? LIMIT 5', like).map((r) => ({ type: 'Brand', label: r.name, sub: M.CATEGORIES[r.category], href: `/admin/brands/${r.id}` })),
      ...db.all('SELECT c.id, c.name, c.email, c.brand_id, b.name brand FROM contacts c LEFT JOIN brands b ON b.id = c.brand_id WHERE c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? LIMIT 5', like, like, like).map((r) => ({ type: 'Contact', label: r.name, sub: [r.brand, r.email].filter(Boolean).join(' · '), href: `/admin/brands/${r.brand_id}` })),
      ...db.all('SELECT id, code, status, indoor_m2 FROM units WHERE code LIKE ? LIMIT 5', like).map((r) => ({ type: 'Unit', label: r.code, sub: `${M.UNIT_STATUS[r.status]} · ${r.indoor_m2} m²`, href: `/admin/units/${r.id}` })),
      ...db.all('SELECT o.id, o.ref, o.status, l.title FROM offers o JOIN leads l ON l.id = o.lead_id WHERE o.ref LIKE ? OR l.title LIKE ? LIMIT 4', like, like).map((r) => ({ type: 'Offer', label: r.ref, sub: `${r.title} · ${M.OFFER_STATUS[r.status]}`, href: `/admin/offers/${r.id}` })),
      ...db.all('SELECT l.id, l.ref, l.status, b.name FROM leases l JOIN brands b ON b.id = l.brand_id WHERE l.ref LIKE ? OR b.name LIKE ? LIMIT 4', like, like).map((r) => ({ type: 'Lease', label: r.ref, sub: `${r.name} · ${M.LEASE_STATUS[r.status]}`, href: `/admin/leases/${r.id}` })),
      ...db.all('SELECT id, ref, status FROM invoices WHERE ref LIKE ? LIMIT 3', like).map((r) => ({ type: 'Invoice', label: r.ref, sub: M.INVOICE_STATUS[r.status], href: `/admin/invoices/${r.id}` })),
    ];
    res.json(out);
  });

  // ---------- your account ----------
  router.get('/me', (req, res) => {
    const body = `<div class="grid grid--2">
${ui.card('Your details', ui.form('/admin/me', req.session.csrf, `<div class="fields">${ui.input('name', 'Name', req.user.name, { required: true })}${ui.input('title', 'Title', req.user.title)}${ui.input('phone', 'Phone', req.user.phone)}</div>${ui.btn('Save', { cls: 'btn--primary' })}`, { cls: 'stack' }))}
${ui.card('Change password', ui.form('/admin/me/password', req.session.csrf, `<div class="fields">${ui.input('current', 'Current password', '', { type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}${ui.input('password', 'New password', '', { type: 'password', required: true, hint: 'At least 10 characters.', attrs: { autocomplete: 'new-password', minlength: 10 } })}</div>${ui.btn('Update password', { cls: 'btn--primary' })}`, { cls: 'stack' }))}
</div>`;
    h.page(req, res, { title: 'Your account', crumbs: [['/admin', 'Dashboard'], [null, 'Account']], active: '/admin/me', body });
  });
  router.post('/me', (req, res) => {
    const name = h.str(req.body.name, 120);
    if (!name) return h.back(req, res, '/admin/me', 'error', 'Name is required.');
    db.run('UPDATE users SET name = ?, title = ?, phone = ? WHERE id = ?', name, h.str(req.body.title, 120) || null, h.str(req.body.phone, 40) || null, req.user.id);
    h.back(req, res, '/admin/me', 'ok', 'Saved.');
  });
  router.post('/me/password', (req, res) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(String(req.body.current || ''), u.password_hash)) return h.back(req, res, '/admin/me', 'error', 'Your current password is not right.');
    if (String(req.body.password || '').length < 10) return h.back(req, res, '/admin/me', 'error', 'Use at least 10 characters.');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(req.body.password)), u.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, req.session.id);
    h.log(req, 'Changed password', 'user', u.id);
    h.back(req, res, '/admin/me', 'ok', 'Password updated. Other sessions were signed out.');
  });
}


module.exports = { public: publicRoutes, private: privateRoutes };
