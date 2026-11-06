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

  // ---------- the permission engine (access.js), for every module ----------
  const engine = require('../access').create({ db, ui });
  h.access = {
    engine,
    can: (user, href, level) => engine.can(user, href, level),
    has: (user, cap) => engine.has(user, cap),
    roles: (o) => engine.roles(o),
    roleOf: (user) => engine.roleOf(user),
    roleName: (role) => engine.roleName(role),
    usersWithRole: (id) => engine.usersWithRole(id),
    limitFor: (user, kind) => engine.limitFor(user, kind),
    effective: (user) => engine.effective(user),
    check: (user, method, url) => engine.check(user, method, url),
  };

  // ---------- sign-in history and lockout ----------
  const lockAfter = () => Math.max(3, Number(db.setting('ppl_lock_after')) || 5);
  const lockMinutes = () => Math.max(1, Number(db.setting('ppl_lock_minutes')) || 15);
  const logLogin = (req, user, email, ok, reason) => db.run('INSERT INTO ppl_logins (user_id, email, ok, reason, ip, agent, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    user ? user.id : null, String(email || '').slice(0, 200), ok ? 1 : 0, reason || null, req.ip || null, String(req.get('user-agent') || '').slice(0, 200), new Date().toISOString());
  h.logLogin = logLogin;

  router.get('/login', (req, res) => {
    if (noUsers()) return res.redirect(303, '/admin/setup');
    if (req.user) return res.redirect(303, safeNext(req.query.next));
    res.type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next: safeNext(req.query.next) }));
  });

  router.post('/login', loginLimit, (req, res) => {
    const email = h.str(req.body.email, 200);
    const next = safeNext(req.body.next);
    if (!auth.checkLoginToken(req)) return res.status(403).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next, email, error: tr('The form expired. Please try again.') }));
    let user = db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
    const nowIso = new Date().toISOString();
    // a lock that has run out starts the count again
    if (user && user.locked_until && user.locked_until <= nowIso) {
      db.run('UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = ?', user.id);
      user = db.get('SELECT * FROM users WHERE id = ?', user.id);
    }
    if (user && user.active && user.locked_until && user.locked_until > nowIso) {
      logLogin(req, user, email, false, 'locked');
      const mins = Math.max(1, Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60000));
      return res.status(423).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next, email, error: tr('ppl|This account is locked after too many failed sign-ins. Try again in {n} minutes, or ask an administrator to unlock it.', { n: mins }) }));
    }
    if (!user || !user.active || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      db.audit(null, 'Failed sign-in', 'user', user ? user.id : null, email, req.ip);
      logLogin(req, user, email, false, !user ? 'unknown' : !user.active ? 'deactivated' : 'password');
      if (user && user.active) {
        const fails = (user.failed_logins || 0) + 1;
        if (fails >= lockAfter()) {
          db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', fails, new Date(Date.now() + lockMinutes() * 60000).toISOString(), user.id);
          db.audit(null, 'Account locked', 'user', user.id, user.name, req.ip);
        } else db.run('UPDATE users SET failed_logins = ? WHERE id = ?', fails, user.id);
      }
      return res.status(401).type('html').send(signinPage(ui, { token: auth.loginToken(req, res), next, email, error: tr('That email and password do not match.') }));
    }
    db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
    logLogin(req, user, email, true, null);
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

  // ---------- invitations and password links (routes/people.js sends them) ----------
  const crypto = require('node:crypto');
  const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
  const inviteOf = (tok) => {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(tok || ''))) return { error: 'ppl|This link is not valid.' };
    const inv = db.get('SELECT * FROM ppl_invites WHERE token_hash = ?', sha(tok));
    if (!inv) return { error: 'ppl|This link is not valid.' };
    if (inv.revoked_at) return { error: 'ppl|This link was withdrawn. Ask for a new one.' };
    if (inv.accepted_at) return { error: 'ppl|This link has already been used. Sign in instead.' };
    if (inv.expires_at <= new Date().toISOString()) return { error: 'ppl|This link has expired. Ask for a new one.' };
    if (inv.kind === 'invite' && db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', inv.email)) return { error: 'ppl|Someone already uses that email. Sign in instead.' };
    if (inv.kind === 'reset' && !db.get('SELECT id FROM users WHERE id = ? AND active = 1', inv.user_id)) return { error: 'ppl|This account is not active.' };
    return { inv };
  };
  const invitePage = (req, res, tok, { inv = null, error = '', name = '' } = {}) => {
    const here = `/admin/invite/${tok}`;
    const fields = inv
      ? `${inv.kind === 'invite' ? ui.input('name', tr('Your name'), name || inv.name || '', { required: true, attrs: { autocomplete: 'name' } }) : ''}
         <label class="f"><span class="f__l">${ui.esc(tr('Email'))}</span><input type="email" value="${ui.esc(inv.email)}" disabled class="ltr"></label>
         ${ui.input('password', tr('ppl|Choose a password'), '', { type: 'password', required: true, hint: tr('At least 10 characters.'), attrs: { autocomplete: 'new-password', minlength: 10 } })}
         ${ui.input('password2', tr('ppl|Type it again'), '', { type: 'password', required: true, attrs: { autocomplete: 'new-password', minlength: 10 } })}`
      : '';
    const title = inv && inv.kind === 'reset' ? tr('ppl|Set a new password') : tr('ppl|Join the office');
    return ui.bare({
      title, cls: 'signin',
      body: `<main class="signin__wrap">
  <section class="signin__art">${ui.logo('signin__logo')}<p class="signin__line">${ui.esc(tr('Where every line leads somewhere.'))}</p><p class="signin__foot">${ui.esc(tr('North 90 · New Cairo'))}</p></section>
  <section class="signin__form">
    <div class="signin__lang">${ui.langLink(here)}</div>
    <p class="eyebrow">${ui.esc(tr('Leasing office'))}</p>
    <h1>${ui.esc(title)}</h1>
    ${inv && inv.kind === 'invite' ? `<p class="muted">${ui.esc(tr('ppl|You were invited to The Wave leasing office. Choose a password to finish setting up your account.'))}</p>` : ''}
    ${error ? `<p class="alert alert--error">${ui.esc(error)}</p>` : ''}
    ${inv ? `<form method="post" action="${ui.esc(here)}" class="stack"><input type="hidden" name="_token" value="${ui.esc(auth.loginToken(req, res))}">${fields}${ui.btn(ui.esc(inv.kind === 'reset' ? tr('ppl|Save the password') : tr('ppl|Create my account')), { cls: 'btn--primary btn--block', ic: 'arrow' })}</form>` : `<p>${ui.btn(ui.esc(tr('Sign in')), { href: '/admin/login', cls: 'btn--primary' })}</p>`}
  </section>
</main>`,
    });
  };
  router.get('/invite/:token', (req, res) => {
    const { inv, error } = inviteOf(req.params.token);
    res.status(inv ? 200 : 410).type('html').send(invitePage(req, res, req.params.token, { inv, error: error ? tr(error) : '' }));
  });
  router.post('/invite/:token', loginLimit, (req, res) => {
    const tok = req.params.token;
    const { inv, error } = inviteOf(tok);
    if (!inv) return res.status(410).type('html').send(invitePage(req, res, tok, { error: tr(error) }));
    const name = h.str(req.body.name, 120);
    const password = String(req.body.password || '');
    let problem = '';
    if (!auth.checkLoginToken(req)) problem = tr('The form expired. Please try again.');
    else if (inv.kind === 'invite' && !name) problem = tr('ppl|Enter your name.');
    else if (password.length < 10) problem = tr('Use a password of at least 10 characters.');
    else if (password !== String(req.body.password2 || '')) problem = tr('ppl|The two passwords are not the same.');
    if (problem) return res.status(422).type('html').send(invitePage(req, res, tok, { inv, error: problem, name }));
    const t = new Date().toISOString();
    let user;
    db.tx(() => {
      if (inv.kind === 'invite') {
        const r = db.run('INSERT INTO users (name, email, role, role_id, title, password_hash, lang, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          name, inv.email.toLowerCase(), inv.role, inv.role_id || null, inv.title || null, hashPassword(password), inv.lang || req.lang || null, inv.created_by || null, h.M.now());
        user = db.get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
        engine.syncFlags(user.id);
        db.run('INSERT INTO ppl_history (user_id, actor_id, action, changes, at) VALUES (?, ?, ?, ?, ?)', user.id, user.id, 'joined', JSON.stringify([{ kind: 'role', key: inv.role_id ? `role:${inv.role_id}` : inv.role, from: null, to: inv.role_id ? `role:${inv.role_id}` : inv.role }]), t);
        db.audit(user, 'Accepted an invitation', 'user', user.id, user.name, req.ip);
      } else {
        db.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', hashPassword(password), inv.user_id);
        db.run('DELETE FROM sessions WHERE user_id = ?', inv.user_id);
        user = db.get('SELECT * FROM users WHERE id = ?', inv.user_id);
        db.audit(user, 'Set a password from a link', 'user', user.id, user.name, req.ip);
      }
      db.run('UPDATE ppl_invites SET accepted_at = ?, user_id = ? WHERE id = ?', t, user.id, inv.id);
    });
    engine.touch();
    logLogin(req, user, user.email, true, inv.kind);
    auth.startSession(db, req, res, user);
    auth.flash(req, res, 'ok', inv.kind === 'invite' ? tr('ppl|Welcome to the office, {name}.', { name: user.name.split(' ')[0] }) : tr('ppl|Your new password is saved.'));
    res.redirect(303, '/admin');
  });
}

function privateRoutes(router, h) {
  const { db, ui, M, auth } = h;

  // ---------- access (access.js) ----------
  // Before any module sees a request: the person's level for the module the path belongs to (view to
  // open, edit to post, full to delete, void, cancel, reverse or approve) and, for downloads and
  // printouts, the export capability. Administrators always pass. On a built-in role the role's own
  // checks still decide what is outside its rank (as they always did); the guard only enforces what
  // was changed for the person: hidden modules, permanent or temporary changes. Custom roles are
  // enforced in full.
  const engine = h.access.engine;
  const LEVEL_NAME = { none: 'ppl|No access', view: 'ppl|View', edit: 'ppl|Edit', full: 'ppl|Full' };
  router.use((req, res, next) => {
    Object.defineProperty(req.user, '__access', { value: engine, enumerable: false, configurable: true });
    const eff = engine.effective(req.user);
    // custom roles: HR and finance follow the role (the rest of the office reads these switches)
    if (!eff.admin && req.user.role_id) {
      req.user.hr = eff.caps.hr.on ? 1 : 0;
      req.user.finance = eff.caps.finance.on ? 1 : 0;
    }
    const c = engine.check(req.user, req.method, req.originalUrl);
    if (c.ok) return next();
    const m = engine.effective(req.user).modules[c.module] || {};
    // built-in roles: what their rank leaves out is the module's own business (a flash and a way back)
    if (!req.user.role_id && c.reason !== 'export' && !['hidden', 'override', 'capability'].includes(m.source)) return next();
    const entry = ui.NAV_ENTRIES.find((e) => e.href === c.module);
    const name = entry ? tr(entry.label) : c.module;
    const grantors = db.all('SELECT * FROM users WHERE active = 1 ORDER BY role = \'admin\' DESC, name').filter((u) => engine.has(u, 'grant')).slice(0, 4);
    let headline;
    let why;
    if (c.reason === 'export') {
      headline = tr('ppl|Downloads are not part of your access');
      why = tr('ppl|Exports and printouts (CSV, PDF) need the "Export data" permission.');
    } else if (c.have === 'none') {
      headline = tr('acc2|{module} is not part of your access', { module: name });
      why = m.source === 'hidden' || m.source === 'override' ? tr('acc2|An administrator has not opened this module for your account, so its pages and records are hidden from you.') : tr('ppl|Your role does not include {module}.', { module: name });
    } else {
      headline = tr('ppl|This needs more access to {module}', { module: name });
      why = tr('ppl|You have {have} access to {module}; this action needs {need}.', { module: name, have: tr(LEVEL_NAME[c.have]), need: tr(LEVEL_NAME[c.level]) });
    }
    res.status(403);
    if ((req.method !== 'GET' && req.accepts(['html', 'json']) === 'json') || req.xhr) return res.json({ ok: false, error: c.have === 'none' && c.reason !== 'export' ? tr('acc2|{module} is not part of your access.', { module: name }) : headline });
    const who = grantors.length
      ? `<p class="muted">${ui.esc(tr('ppl|People who can give access:'))}</p><ul class="ppl-grantors">${grantors.map((u) => `<li><span class="avatar avatar--sm">${ui.esc(ui.initials(u.name))}</span><span><b>${ui.esc(u.name)}</b><small class="ltr">${ui.esc(u.email)}</small></span></li>`).join('')}</ul>`
      : '';
    const body = `<div class="noaccess">${ui.card(headline, `<div class="noaccess__body">${ui.icon('shield', 'noaccess__ic')}<div><p>${ui.esc(why)}</p>${who}<div class="row">${ui.btn(ui.esc(tr('acc2|Back to the dashboard')), { href: '/admin', cls: 'btn--primary btn--sm', ic: 'home' })}</div></div></div>`)}</div>`;
    return h.page(req, res, { title: tr('acc2|No access'), crumbs: [['/admin', tr('Dashboard')]], body });
  });

  router.post('/logout', (req, res) => {
    h.log(req, 'Signed out', 'user', req.user.id);
    auth.endSession(db, req, res);
    res.redirect(303, '/admin/login');
  });

  // ---------- dashboard ----------
  router.get('/', (req, res) => {
    h.sweep(req);
    const q = req.query || {};
    const isDay = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) && !Number.isNaN(Date.parse(x)) && new Date(Date.parse(x)).toISOString().slice(0, 10) === x; // a real calendar day
    // the period (both dates, or none: then the dashboard is as it always was)
    let from = isDay(q.from) ? q.from : '';
    let to = isDay(q.to) ? q.to : '';
    if (from && !to) to = M.today() < from ? from : M.today();
    if (to && !from) from = to;
    if (from > to) [from, to] = [to, from];
    // ten years at most (the charts count bucket by bucket)
    if (from && M.daysBetween(from, to) > 3652) from = M.addDays(to, -3652);
    const pick = (v, allowed) => (allowed.includes(v) ? v : allowed[0]);
    const sorts = { up: pick(q.up, ['soon', 'late']), tasks: pick(q.tasks, ['due', 'due_late', 'lead']), feed: pick(q.feed, ['newest', 'oldest']) };
    const d = M.dashboard(db, req.user, { from, to, sortUp: sorts.up, sortTasks: sorts.tasks, sortFeed: sorts.feed });
    const P = d.period;
    // the address of this dashboard with some parameters changed (empty values are dropped)
    const here = (change = {}) => {
      const p = new URLSearchParams();
      const all = { from, to, up: sorts.up === 'soon' ? '' : sorts.up, tasks: sorts.tasks === 'due' ? '' : sorts.tasks, feed: sorts.feed === 'newest' ? '' : sorts.feed, ...change };
      for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
      const qs = p.toString();
      return `/admin${qs ? `?${qs}` : ''}`;
    };
    const periodQs = P ? `from=${P.from}&to=${P.to}` : '';
    const trendP = (now, before) => {
      if (!before) return now ? `<span class="up">${ui.esc(tr('trend|new'))}</span> ${ui.esc(tr('dash2|vs the previous {n} days', { n: P.days }))}` : `<span class="muted">${ui.esc(tr('dash2|none in either period'))}</span>`;
      const x = (now - before) / before;
      return `<span class="${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '▲' : '▼'} ${Math.abs(x * 100).toFixed(0)}%</span> ${ui.esc(tr('dash2|vs the previous {n} days', { n: P.days }))}`;
    };
    const nowTag = `<span class="dash2-now" title="${ui.esc(tr('dash2|As of today, whatever period is chosen'))}">${ui.esc(tr('dash2|now'))}</span>`;
    const N = P && P.now;
    const B = P && P.before;
    const kpis = P ? [
      ui.kpi({ label: tr('Occupancy'), value: ui.pct(d.occupancy, 1), bar: d.occupancy, sub: `${nowTag} ${ui.esc(tr('dash2|{a} leased of {b} · {c} committed', { a: ui.m2(d.leased), b: ui.m2(d.gla), c: ui.pct(d.commitment, 1) }))}`, href: '/admin/units' }),
      ui.kpi({ label: tr('Weighted pipeline'), value: ui.money(d.weighted, { compact: true }), sub: `${nowTag} ${ui.esc(tr('dash2|{deals} · {won} won, {lost} lost in the period', { deals: tn(d.openCount, 'dash|{n} open deal', 'dash|{n} open deals'), won: ui.n0(N.won), lost: ui.n0(N.lost) }))}`, href: '/admin/pipeline' }),
      ui.kpi({ label: tr('dash2|New leads'), value: ui.n0(N.leads), sub: trendP(N.leads, B.leads), href: ui.esc(`/admin/leads?${periodQs}`) }),
      ui.kpi({ label: tr('dash2|Leases signed'), value: ui.n0(N.signedCount), sub: `${N.signedArea ? `${ui.esc(tr('dash|{area} let', { area: ui.m2(N.signedArea) }))} · ` : ''}${trendP(N.signedArea || N.signedCount, B.signedArea || B.signedCount)}`, href: '/admin/leases' }),
      ui.kpi({ label: tr('dash2|Collected'), value: ui.money(N.collected, { compact: true }), sub: `${N.billed ? `${ui.esc(tr('dash2|{rate} of {billed} falling due', { rate: ui.pct(Math.min(9.99, N.collected / N.billed)), billed: ui.money(N.billed, { compact: true }) }))} · ` : ''}${trendP(N.collected, B.collected)}`, href: '/admin/billing' }),
      ui.kpi({ label: tr('Overdue rent'), value: ui.money(d.overdue.amount, { compact: true }), tone: d.overdue.amount ? 'kpi--alert' : '', sub: `${nowTag} ${ui.esc(d.overdue.n ? tn(d.overdue.n, '{n} invoice', '{n} invoices') : tr('dash2|nothing past due'))}`, href: '/admin/billing?status=overdue' }),
    ].join('') : [
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
      // the document vault and the contracts register (routes/records.js)
      ...(() => {
        if (!h.records) return [];
        const a = h.records.docAlerts(req);
        return [
          a.expired ? `<li><a href="/admin/documents?status=expired"><span class="dot dot--rose"></span><span class="what"><b>${ui.esc(tn(a.expired, 'dash|{n} document has expired', 'dash|{n} documents have expired'))}</b><small>${ui.esc(tr('dash|Renew or replace them in the vault'))}</small></span></a></li>` : '',
          a.expiring ? `<li><a href="/admin/documents?status=expiring"><span class="dot dot--amber"></span><span class="what"><b>${ui.esc(tn(a.expiring, 'dash|{n} document expires soon', 'dash|{n} documents expire soon'))}</b><small>${ui.esc(tr('dash|Within {n} days', { n: Number(db.setting('doc_warn_days')) || 30 }))}</small></span></a></li>` : '',
          ...h.records.renewalsDue().slice(0, 3).map((c) => `<li><a href="/admin/contracts/${c.id}"><span class="dot dot--amber"></span><span class="what"><b>${ui.esc(tr('dash|Renewal due: {name}', { name: c.counterparty }))}</b><small>${ui.esc(c.ref)} · ${ui.esc(c.end_date < M.today() ? tr('dash|ended {when}', { when: ui.rel(c.end_date) }) : tr('dash|ends {when}', { when: ui.rel(c.end_date) }))}</small></span></a></li>`),
        ];
      })(),
      d.inbox ? `<li><a href="/admin/inbox"><span class="dot dot--sea"></span><span class="what"><b>${ui.esc(tn(d.inbox, 'dash|{n} new message from the website', 'dash|{n} new messages from the website'))}</b><small>${ui.esc(tr('Reply within a working day'))}</small></span></a></li>` : '',
    ].join('');
    const feed = d.feed.length
      ? `<ul class="feed">${d.feed.map((a) => `<li><span class="avatar avatar--sm">${ui.esc(ui.initials(a.user_name || 'Website'))}</span><p><b>${ui.esc(a.user_name || tr('System'))}</b> ${ui.esc(isAr() ? tx(a.action) : a.action.toLowerCase())}${a.detail ? ` <span>${ui.esc(tx(a.detail))}</span>` : ''}</p><time>${ui.rel(a.created_at)}</time></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(P ? tr('dash2|Nothing was recorded in this period.') : tr('Activity will appear here.'))}</p>`;

    // ---- the period bar: quick ranges, any two dates, back to the usual view
    const t0 = M.today();
    const [Y, Mo] = t0.slice(0, 7).split('-').map(Number);
    const ymd = (y, m, dd) => `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
    const prevM = Mo === 1 ? [Y - 1, 12] : [Y, Mo - 1];
    const qStart = Mo - ((Mo - 1) % 3);
    const presets = [
      ['dash2|Today', t0, t0],
      ['dash2|Last 7 days', M.addDays(t0, -6), t0],
      ['sort|This month', ymd(Y, Mo, 1), ymd(Y, Mo, lastDay(Y, Mo))],
      ['sort|Last month', ymd(prevM[0], prevM[1], 1), ymd(prevM[0], prevM[1], lastDay(prevM[0], prevM[1]))],
      ['dash2|This quarter', ymd(Y, qStart, 1), ymd(Y, qStart + 2, lastDay(Y, qStart + 2))],
      ['sort|This year', ymd(Y, 1, 1), ymd(Y, 12, 31)],
    ];
    const keepSorts = Object.entries({ up: sorts.up === 'soon' ? '' : sorts.up, tasks: sorts.tasks === 'due' ? '' : sorts.tasks, feed: sorts.feed === 'newest' ? '' : sorts.feed })
      .filter(([, v]) => v).map(([k, v]) => `<input type="hidden" name="${k}" value="${ui.esc(v)}">`).join('');
    const periodBar = `<form method="get" action="/admin" class="filters dash2-period" aria-label="${ui.esc(tr('dash2|Period'))}">${keepSorts}
      <div class="filters__quick"><a class="chip${P ? '' : ' is-on'}" href="${ui.esc(here({ from: '', to: '' }))}">${ui.esc(tr('dash2|Usual view'))}</a>${presets.map(([label, f, tt]) => `<a class="chip${P && P.from === f && P.to === tt ? ' is-on' : ''}" href="${ui.esc(here({ from: f, to: tt }))}">${ui.esc(tr(label))}</a>`).join('')}</div>
      ${ui.input('from', tr('dash2|From'), from, { type: 'date' })}${ui.input('to', tr('dash2|To'), to, { type: 'date' })}
      <div class="filters__go">${ui.btn(ui.esc(tr('dash2|Show this period')), { cls: 'btn--ghost btn--sm', ic: 'cal' })}${P ? `<a class="btn btn--ghost btn--sm" href="${ui.esc(here({ from: '', to: '' }))}">${ui.esc(tr('Clear'))}</a>` : ''}</div>
      <p class="dash2-period__note">${P ? `${ui.icon('cal')} <b>${ui.esc(P.from === P.to ? ui.date(P.from) : `${ui.date(P.from)} – ${ui.date(P.to)}`)}</b> · ${ui.esc(tn(P.days, 'dash2|{n} day', 'dash2|{n} days'))} · ${ui.esc(tr('dash2|compared with {a} – {b}', { a: ui.date(P.prev.from), b: ui.date(P.prev.to) }))}` : ui.esc(tr('dash2|Leads over the last 30 days, leases and cash this month. Choose a period to see any dates.'))}</p>
    </form>`;
    // a card's own "Sort by", kept with the period and the other cards' choices
    const sortForm = (name, options, current) => `<form method="get" action="/admin" class="dash2-sort">${Object.entries({ from, to, up: sorts.up === 'soon' ? '' : sorts.up, tasks: sorts.tasks === 'due' ? '' : sorts.tasks, feed: sorts.feed === 'newest' ? '' : sorts.feed })
      .filter(([k, v]) => v && k !== name).map(([k, v]) => `<input type="hidden" name="${k}" value="${ui.esc(v)}">`).join('')}<label><select name="${name}" data-autosubmit aria-label="${ui.esc(tr('sort|Sort by'))}">${options.map(([v, label]) => `<option value="${v}"${v === current ? ' selected' : ''}>${ui.esc(tr(label))}</option>`).join('')}</select></label><noscript><button class="btn btn--ghost btn--sm">${ui.esc(tr('dash2|Sort'))}</button></noscript></form>`;
    const withSort = (form, btn) => `<div class="dash2-act">${form}${btn}</div>`;
    const unitTitle = P ? { day: ['dash2|Leads per day', 'dash2|Area signed per day'], week: ['dash2|Leads per week', 'dash2|Area signed per week'], month: ['Leads per month', 'Area signed per month'], quarter: ['dash2|Leads per quarter', 'dash2|Area signed per quarter'] }[P.unit] : ['Leads per month', 'Area signed per month'];
    const chartSub = P ? ui.esc(tr('dash2|Faded bars: the {n} days before', { n: P.days })) : null;

    const hour = new Date().getUTCHours() + 2;
    const greet = hour < 12 ? 'Good morning, {name}.' : hour < 18 ? 'Good afternoon, {name}.' : 'Good evening, {name}.';
    const body = `
${periodBar}
<p class="hello">${ui.esc(tr(greet, { name: req.user.name.split(' ')[0] }))} ${d.tasks.length ? tn(d.tasks.length, 'You have <b>{n}</b> task due soon.', 'You have <b>{n}</b> tasks due soon.') : ui.esc(tr('Your desk is clear.'))}</p>
<div class="kpis kpis--six">${kpis}</div>
<div class="grid">
  ${start}
  ${ui.card(tr('Pipeline'), ui.funnel(stageRows), { cls: 'span-2', sub: P ? `${nowTag} ${ui.esc(tr('dash2|{won} won and {lost} lost in the period ({wonBefore} and {lostBefore} before)', { won: ui.n0(N.won), lost: ui.n0(N.lost), wonBefore: ui.n0(B.won), lostBefore: ui.n0(B.lost) }))}` : ui.esc(tr('dash|{n} lost · annual rent value per stage', { n: lostCount })), action: ui.btn(ui.esc(tr('Open board')), { href: '/admin/pipeline', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('Where leads come from'), sourceParts.length ? ui.donut(sourceParts, { label: ui.n0(sourceParts.reduce((s, p) => s + p.value, 0)) }) : `<p class="muted pad">${ui.esc(P ? tr('dash2|No new leads in this period.') : tr('No leads yet.'))}</p>`, P ? { sub: ui.esc(tr('dash2|New leads in the period')) } : {})}
  ${ui.card(tr(unitTitle[0]), `<div class="dash2-bars dash2-bars--${P ? P.unit : 'month'}${d.months.length > 8 ? ' dash2-bars--dense' : ''}">${ui.bars(d.months, { key: 'leads', label: 'label', tone: 'sea', compare: P ? 'leadsPrev' : null })}</div>`, { sub: chartSub || ui.esc(tr('Last six months')) })}
  ${ui.card(tr(unitTitle[1]), `<div class="dash2-bars dash2-bars--${P ? P.unit : 'month'}${d.months.length > 8 ? ' dash2-bars--dense' : ''}">${ui.bars(d.months, { key: 'signed', label: 'label', fmtv: (n) => `${ui.n0(n)}`, tone: 'forest', compare: P ? 'signedPrev' : null })}</div>`, { sub: chartSub ? `${ui.esc(tr('m² of leases signed'))} · ${chartSub}` : ui.esc(tr('m² of leases signed')) })}
  ${ui.card(tr('Plaza level'), `${ui.plan(d.units, 'G')}${ui.planLegend()}`, { action: ui.btn(ui.esc(tr('All units')), { href: '/admin/units', cls: 'btn--ghost btn--sm' }) })}
  ${ui.card(tr('Coming up'), upcoming, { sub: P ? ui.esc(tr('dash2|The next two weeks, whatever the period')) : '', action: withSort(sortForm('up', [['soon', 'sort|Soonest first'], ['late', 'sort|Latest first']], sorts.up), ui.btn(ui.esc(tr('Calendar')), { href: '/admin/calendar', cls: 'btn--ghost btn--sm' })) })}
  ${ui.card(tr('Your tasks'), tasks, { action: withSort(sortForm('tasks', [['due', 'sort|Due date: soonest first'], ['due_late', 'sort|Due date: latest first'], ['lead', 'dash2|By lead: A to Z']], sorts.tasks), ui.btn(ui.esc(tr('All tasks')), { href: '/admin/calendar#tasks', cls: 'btn--ghost btn--sm' })) })}
  ${ui.card(tr('Needs attention'), attention ? `<ul class="list">${attention}</ul>` : `<p class="muted pad">${ui.esc(tr('Nothing needs you right now.'))}</p>`)}
  ${ui.card(P ? tr('dash2|Activity in the period') : tr('Latest activity'), feed, { cls: 'span-3', sub: P ? ui.esc(tr(sorts.feed === 'oldest' ? 'dash2|The first 12 entries' : 'dash2|The latest 12 entries')) : '', action: withSort(sortForm('feed', [['newest', 'sort|Newest first'], ['oldest', 'sort|Oldest first']], sorts.feed), h.can(req, 'manager') ? ui.btn(ui.esc(tr('dash2|Full log')), { href: `/admin/audit${periodQs ? `?${periodQs}` : ''}`, cls: 'btn--ghost btn--sm' }) : '') })}
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
      ...db.all('SELECT id, ref, title, counterparty FROM contracts WHERE ref LIKE ? OR title LIKE ? OR counterparty LIKE ? LIMIT 4', like, like, like).map((r) => ({ type: tr('search|Contract'), label: tx(r.title), sub: `${r.ref} · ${r.counterparty}`, href: `/admin/contracts/${r.id}` })),
      ...db.all(`SELECT id, ref, title, kind FROM documents WHERE archived = 0 AND (ref LIKE ? OR title LIKE ? OR file_name LIKE ?)${h.canHR(req) ? '' : " AND confidential = 0 AND entity != 'employee'"} LIMIT 5`, like, like, like).map((r) => ({ type: tr('search|Document'), label: tx(r.title), sub: `${r.ref} · ${M.DOC_KINDS[r.kind] || r.kind}`, href: `/admin/documents/${r.id}` })),
    ];
    res.json(out);
  });

  // ---------- your account ----------
  router.get('/me', (req, res) => {
    const body = `<div class="grid grid--2">
${ui.card(tr('Your details'), ui.form('/admin/me', req.session.csrf, `<div class="fields">${ui.input('name', tr('Name'), req.user.name, { required: true })}${ui.input('title', tr('Job title'), req.user.title)}${ui.input('phone', tr('Phone'), req.user.phone, { type: 'tel' })}</div>${ui.btn(ui.esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' }))}
${ui.card(tr('Change password'), ui.form('/admin/me/password', req.session.csrf, `<div class="fields">${ui.input('current', tr('Current password'), '', { type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}${ui.input('password', tr('New password'), '', { type: 'password', required: true, hint: tr('At least 10 characters.'), attrs: { autocomplete: 'new-password', minlength: 10 } })}</div>${ui.btn(ui.esc(tr('Update password')), { cls: 'btn--primary' })}`, { cls: 'stack' }))}
${(h.mePanels || []).map((fn) => fn(req) || '').join('')}
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
