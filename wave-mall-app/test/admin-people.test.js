'use strict';

// Users & permissions: the permission matrix enforced on every request (view / edit / full /
// export), the sidebar, nobody giving more than they have, administrators made only by
// administrators, the two-person rule through Approvals, temporary access that ends by itself,
// invitations (single use, expiry), deactivation, lockout after failed sign-ins, where each cell of
// a person's access comes from, and the Team page's hidden modules moving into the new model.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let db;
let h;
let engine;
let admin;
let admin2;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  engine = h.access.engine;
  base = `http://127.0.0.1:${server.address().port}`;
  person('Office Admin', 'ppl-admin@thewave.test', 'admin', { hr: 1, finance: 1 });
  person('Second Admin', 'ppl-admin2@thewave.test', 'admin');
  admin = browser();
  await admin.signIn('ppl-admin@thewave.test', 'long-enough-1');
  admin2 = browser();
  await admin2.signIn('ppl-admin2@thewave.test', 'long-enough-1');
});
after(() => server.close());

function person(name, email, role, { roleId = null, hr = 0, finance = 0 } = {}) {
  const id = Number(db.run('INSERT INTO users (name, email, role, role_id, password_hash, hr, finance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))', name, email, role, roleId, hashPassword('long-enough-1'), hr, finance).lastInsertRowid);
  engine.touch();
  return id;
}
function makeRole(name, base, matrix, caps = {}, limits = {}) {
  const full = {};
  for (const e of engine.modules()) full[e.href] = matrix[e.href] || matrix['*'] || 'none';
  const id = Number(db.run("INSERT INTO ppl_roles (name, base, matrix, caps, default_level, created_at, updated_at) VALUES (?, ?, ?, ?, 'none', datetime('now'), datetime('now'))", name, base, JSON.stringify(full), JSON.stringify({ ...caps, limits })).lastInsertRowid);
  engine.touch();
  return id;
}
let ipN = 0;
function browser() {
  const jar = new Map();
  // each browser its own address, so the sign-in rate limit (12 per 15 minutes) never trips the tests
  const ip = `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}`;
  const go = async (p, opts = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': ip, ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const b = {
    go,
    csrf: null,
    flash: () => {
      const f = jar.get('wv_flash');
      try {
        return f ? JSON.parse(decodeURIComponent(f)).text : '';
      } catch {
        return '';
      }
    },
    form: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: b.csrf, ...data }).toString() }),
    async login(email, password) {
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      return go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
    },
    async signIn(email, password) {
      const r = await b.login(email, password);
      assert.equal(r.status, 303, `sign-in for ${email}`);
      const page = await (await go('/admin')).text();
      b.csrf = page.match(/name="csrf" content="([^"]+)"/)[1];
    },
  };
  return b;
}
const nav = (html) => html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>'));

test('people: the matrix decides view, edit, full and export on every request', async () => {
  const rid = makeRole('Matrix tester', 'manager', { '/admin': 'view', '/admin/billing': 'view', '/admin/leads': 'edit', '/admin/maintenance': 'edit', '/admin/reports': 'view' }, {});
  person('Matrix Person', 'ppl-matrix@thewave.test', 'manager', { roleId: rid });
  const p = browser();
  await p.signIn('ppl-matrix@thewave.test', 'long-enough-1');
  const home = await (await p.go('/admin')).text();
  assert.match(nav(home), /href="\/admin\/billing"/);
  assert.match(nav(home), /href="\/admin\/leads"/);
  assert.doesNotMatch(nav(home), /href="\/admin\/parking"/, 'none: not in the menu');
  assert.doesNotMatch(nav(home), /href="\/admin\/people"/, 'people: only with manage or give access');
  // none
  const parking = await p.go('/admin/parking');
  assert.equal(parking.status, 403);
  assert.match(await parking.text(), /Parking is not part of your access/);
  // view: opens, but cannot post
  assert.equal((await p.go('/admin/billing')).status, 200);
  // (the guard answers before the module looks for the invoice)
  const pay = await p.form('/admin/invoices/1/pay', { amount: '10' });
  assert.equal(pay.status, 403);
  assert.match(await pay.text(), /You have View access to Billing; this action needs Edit/);
  // edit: posts pass the guard, but deleting/cancelling needs full
  const newLead = await p.form('/admin/leads', { title: 'Matrix lead', category: 'fashion', source: 'direct' });
  assert.notEqual(newLead.status, 403, 'edit may create');
  const cancel = await p.form('/admin/maintenance/orders/1/cancel', {});
  assert.equal(cancel.status, 403, 'full actions need full');
  // export: a download needs the permission
  const csv = await p.go('/admin/export/leads.csv');
  assert.equal(csv.status, 403);
  assert.match(await csv.text(), /Downloads are not part of your access/);
  // HR and finance follow the role: off here, so the person's switches are off for the request too
  assert.equal(engine.has(db.get('SELECT * FROM users WHERE email = ?', 'ppl-matrix@thewave.test'), 'finance'), false);
  // built-in roles are unchanged: an agent opens billing and everything the rank allows
  person('Plain Agent', 'ppl-agent@thewave.test', 'agent');
  const a = browser();
  await a.signIn('ppl-agent@thewave.test', 'long-enough-1');
  assert.equal((await a.go('/admin/billing')).status, 200);
  assert.equal((await a.go('/admin/parking')).status, 200);
  assert.equal((await a.go('/admin/export/leads.csv')).status, 200);
  assert.equal((await a.go('/admin/people')).status, 403, 'not for a plain agent');
});

test('people: nobody gives more than they have, and only administrators make administrators', async () => {
  const rid = makeRole('People lead', 'manager', { '*': 'view', '/admin/leads': 'edit', '/admin/team': 'view' }, { manage_users: true, grant: true });
  person('People Lead', 'ppl-lead@thewave.test', 'manager', { roleId: rid });
  const target = person('Some Agent', 'ppl-target@thewave.test', 'agent');
  const lead = browser();
  await lead.signIn('ppl-lead@thewave.test', 'long-enough-1');
  assert.equal((await lead.go('/admin/people')).status, 200);
  // cannot open accounting fully for someone (has none themselves)
  await lead.form(`/admin/people/${target}/overrides`, { 'lvl:/admin/accounting': 'full' });
  assert.match(lead.flash(), /cannot give more than you have/);
  assert.equal(db.value("SELECT COUNT(*) FROM ppl_overrides WHERE user_id = ? AND key = '/admin/accounting'", target), 0);
  // can lower something they have
  await lead.form(`/admin/people/${target}/overrides`, { 'lvl:/admin/leads': 'view' });
  assert.match(lead.flash(), /Saved/);
  assert.equal(engine.levelOf(db.get('SELECT * FROM users WHERE id = ?', target), '/admin/leads'), 'view');
  // a role with finance is beyond them
  const roleForm = { name: 'Finance clone', base: 'agent', default_level: 'none', color: 'sea', cap_finance: '1', confirm: '1' };
  await lead.form('/admin/people/roles', roleForm);
  assert.match(lead.flash(), /cannot give more than you have/);
  assert.equal(db.value("SELECT COUNT(*) FROM ppl_roles WHERE name = 'Finance clone'"), 0);
  // not an administrator
  await lead.form(`/admin/people/${target}/role`, { role: 'admin' });
  assert.match(lead.flash(), /Choose a role you are allowed to give/);
  assert.equal(db.value('SELECT role FROM users WHERE id = ?', target), 'agent');
  await lead.form('/admin/people/invite', { email: 'new-admin@thewave.test', role: 'admin' });
  assert.match(lead.flash(), /Choose a role you are allowed to give/);
  // not themselves, and not an administrator
  const self = db.value("SELECT id FROM users WHERE email = 'ppl-lead@thewave.test'");
  await lead.form(`/admin/people/${self}/overrides`, { 'lvl:/admin/accounting': 'view' });
  assert.match(lead.flash(), /cannot change your own access/);
  const adm = db.value("SELECT id FROM users WHERE email = 'ppl-admin@thewave.test'");
  await lead.form(`/admin/people/${adm}/deactivate`, {});
  assert.match(lead.flash(), /Only administrators can change an administrator/);
  // an administrator can
  await admin.form(`/admin/people/${target}/role`, { role: 'admin' });
  assert.equal(db.value('SELECT role FROM users WHERE id = ?', target), 'admin');
  await admin.form(`/admin/people/${target}/role`, { role: 'agent' });
});

test('people: the two-person rule sends sensitive changes to a second administrator', async () => {
  db.setSetting('ppl_two_person', '1');
  try {
    const target = person('Promote Me', 'ppl-promote@thewave.test', 'agent');
    await admin.form(`/admin/people/${target}/role`, { role: 'admin' });
    assert.match(admin.flash(), /waits for a second administrator/);
    assert.equal(db.value('SELECT role FROM users WHERE id = ?', target), 'agent', 'not yet');
    const req = db.get("SELECT * FROM apr_requests WHERE kind = 'access' AND entity = 'user' AND entity_id = ? AND status = 'pending'", target);
    assert.ok(req);
    assert.match(h.approvals.titleOf(h.approvals.requestOf(req.id)), /Access change: Promote Me: Administrator/);
    // the one who asked cannot approve it
    const asker = db.get("SELECT * FROM users WHERE email = 'ppl-admin@thewave.test'");
    assert.throws(() => h.approvals.decide(req.id, asker, 'approved'), /second administrator/);
    assert.equal(db.value('SELECT status FROM apr_requests WHERE id = ?', req.id), 'pending', 'the decision was undone');
    // a second administrator approves: it happens, with both names in the history
    const second = db.get("SELECT * FROM users WHERE email = 'ppl-admin2@thewave.test'");
    h.approvals.decide(req.id, second, 'approved');
    assert.equal(db.value('SELECT role FROM users WHERE id = ?', target), 'admin');
    const hist = db.get("SELECT * FROM ppl_history WHERE user_id = ? AND action = 'role' ORDER BY id DESC LIMIT 1", target);
    assert.equal(hist.actor_id, asker.id);
    assert.equal(hist.approved_by, second.id);
    // not sensitive: applied at once
    const t2 = person('Plain Change', 'ppl-plain@thewave.test', 'agent');
    await admin.form(`/admin/people/${t2}/overrides`, { 'lvl:/admin/parking': 'none' });
    assert.match(admin.flash(), /Saved/);
    // a rejection is kept too
    await admin.form(`/admin/people/${t2}/overrides`, { 'cap:grant': 'on' });
    const r2 = db.get("SELECT * FROM apr_requests WHERE kind = 'access' AND entity_id = ? AND status = 'pending'", t2);
    h.approvals.decide(r2.id, second, 'rejected', 'Not needed');
    assert.equal(engine.has(db.get('SELECT * FROM users WHERE id = ?', t2), 'grant'), false);
    assert.ok(db.value("SELECT COUNT(*) FROM ppl_history WHERE user_id = ? AND action = 'rejected'", t2));
  } finally {
    db.setSetting('ppl_two_person', '0');
  }
});

test('people: temporary access raises a level until its end date, then ends by itself', async () => {
  const id = person('Temp Person', 'ppl-temp@thewave.test', 'agent', { roleId: makeRole('Narrow', 'agent', { '/admin': 'view', '/admin/leads': 'edit' }) });
  const u = () => db.get('SELECT * FROM users WHERE id = ?', id);
  assert.equal(engine.levelOf(u(), '/admin/collections'), 'none');
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await admin.form(`/admin/people/${id}/temp`, { key: '/admin/collections', level: 'edit', until: day, reason: 'Cover' });
  assert.match(admin.flash(), /temporary access until/);
  const eff = engine.effective(u());
  assert.equal(eff.modules['/admin/collections'].level, 'edit');
  assert.equal(eff.modules['/admin/collections'].source, 'temporary');
  // the job ends it once the date has passed
  const ended = engine.sweep(new Date(Date.now() + 5 * 86400000).toISOString());
  assert.equal(ended.length, 1);
  assert.equal(engine.levelOf(u(), '/admin/collections'), 'none');
  assert.ok(db.value("SELECT COUNT(*) FROM ppl_history WHERE user_id = ? AND action = 'temp_ended'", id));
  // past dates are refused
  await admin.form(`/admin/people/${id}/temp`, { key: '/admin/collections', level: 'view', until: '2020-01-01' });
  assert.match(admin.flash(), /after today/);
});

test('people: invitations work once and expire', async () => {
  const rid = makeRole('Invite role', 'agent', { '/admin': 'view', '/admin/leads': 'edit' }, { finance: true });
  await admin.form('/admin/people/invite', { email: 'Invitee@TheWave.test', role: `role:${rid}`, lang: 'en', title: 'Analyst' });
  const link = admin.flash().match(/https?:\/\/\S+\/admin\/invite\/([A-Za-z0-9_-]+)/);
  assert.ok(link, admin.flash());
  const path = `/admin/invite/${link[1]}`;
  const guest = browser();
  const page = await guest.go(path);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /invitee@thewave\.test/);
  let token = html.match(/name="_token" value="([^"]+)"/)[1];
  const post = (data) => guest.go(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, ...data }).toString() });
  const bad = await post({ name: 'New Person', password: 'long-enough-1', password2: 'different-one-1' });
  assert.equal(bad.status, 422, 'passwords must match');
  token = (await bad.text()).match(/name="_token" value="([^"]+)"/)[1];
  const ok = await post({ name: 'New Person', password: 'long-enough-1', password2: 'long-enough-1' });
  assert.equal(ok.status, 303);
  const u = db.get("SELECT * FROM users WHERE email = 'invitee@thewave.test'");
  assert.equal(u.role_id, rid);
  assert.equal(u.finance, 1, 'the role\'s finance permission is synced');
  assert.equal((await guest.go('/admin')).status, 200, 'signed in');
  // used once
  assert.equal((await browser().go(path)).status, 410);
  // expiry
  await admin.form('/admin/people/invite', { email: 'late@thewave.test', role: 'agent', lang: 'ar' });
  const late = admin.flash().match(/\/admin\/invite\/([A-Za-z0-9_-]+)/)[1];
  db.run("UPDATE ppl_invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE email = 'late@thewave.test'");
  const exp = await browser().go(`/admin/invite/${late}`);
  assert.equal(exp.status, 410);
  assert.match(await exp.text(), /expired/);
  // a new link replaces the old one
  const inv = db.get("SELECT * FROM ppl_invites WHERE email = 'late@thewave.test'");
  await admin.form(`/admin/people/invites/${inv.id}/resend`, {});
  const fresh = admin.flash().match(/\/admin\/invite\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await browser().go(`/admin/invite/${fresh}`)).status, 200);
  assert.equal((await browser().go(`/admin/invite/${late}`)).status, 410);
});

test('people: deactivating signs a person out and keeps them out; lockout after failed sign-ins', async () => {
  const id = person('Leaving Soon', 'ppl-leave@thewave.test', 'agent');
  const p = browser();
  await p.signIn('ppl-leave@thewave.test', 'long-enough-1');
  assert.ok(db.value('SELECT COUNT(*) FROM sessions WHERE user_id = ?', id));
  await admin.form(`/admin/people/${id}/deactivate`, { reason: 'Left' });
  assert.equal(db.value('SELECT COUNT(*) FROM sessions WHERE user_id = ?', id), 0);
  assert.equal((await p.go('/admin')).status, 303, 'session gone');
  assert.equal((await browser().login('ppl-leave@thewave.test', 'long-enough-1')).status, 401);
  assert.equal(db.value("SELECT reason FROM ppl_logins WHERE user_id = ? ORDER BY id DESC LIMIT 1", id), 'deactivated');
  await admin.form(`/admin/people/${id}/reactivate`, {});
  assert.equal((await browser().login('ppl-leave@thewave.test', 'long-enough-1')).status, 303);

  // five wrong passwords lock the account, even for the right one afterwards
  const lid = person('Lock Me', 'ppl-lock@thewave.test', 'agent');
  for (let i = 0; i < 5; i++) assert.equal((await browser().login('ppl-lock@thewave.test', 'wrong-password-1')).status, 401);
  const locked = await browser().login('ppl-lock@thewave.test', 'long-enough-1');
  assert.equal(locked.status, 423);
  assert.match(await locked.text(), /locked/);
  assert.equal(db.value("SELECT COUNT(*) FROM ppl_logins WHERE user_id = ? AND ok = 0", lid), 6);
  await admin.form(`/admin/people/${lid}/unlock`, {});
  assert.equal((await browser().login('ppl-lock@thewave.test', 'long-enough-1')).status, 303);
  // a reset link ends the old password and every session
  await admin.form(`/admin/people/${lid}/reset`, {});
  assert.match(admin.flash(), /old password no longer works/);
  assert.equal((await browser().login('ppl-lock@thewave.test', 'long-enough-1')).status, 401);
});

test('people: effective access shows where each cell comes from', async () => {
  const rid = makeRole('Sourced', 'agent', { '/admin': 'view', '/admin/leads': 'edit', '/admin/billing': 'view' }, { export: true });
  const id = person('Sources Person', 'ppl-src@thewave.test', 'agent', { roleId: rid });
  db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, created_at) VALUES (?, 'module', '/admin/billing', 'none', datetime('now'))", id);
  db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, expires_at, created_at) VALUES (?, 'module', '/admin/media', 'view', ?, datetime('now'))", id, new Date(Date.now() + 86400000).toISOString());
  db.run('UPDATE users SET hidden_modules = ? WHERE id = ?', JSON.stringify(['/admin/leads']), id);
  engine.touch();
  const eff = engine.effective(db.get('SELECT * FROM users WHERE id = ?', id));
  assert.deepEqual([eff.modules['/admin/leads'].source, eff.modules['/admin/leads'].level], ['hidden', 'none']);
  assert.deepEqual([eff.modules['/admin/billing'].source, eff.modules['/admin/billing'].level], ['override', 'none']);
  assert.deepEqual([eff.modules['/admin/media'].source, eff.modules['/admin/media'].level], ['temporary', 'view']);
  assert.equal(eff.modules['/admin/hr'].blocked, 'hr', 'HR modules stay closed without HR');
  assert.equal(eff.caps.export.source, 'role');
  const adm = engine.effective(db.get("SELECT * FROM users WHERE email = 'ppl-admin@thewave.test'"));
  assert.equal(adm.modules['/admin/settings'].source, 'admin');
  // the page and the tester
  const html = await (await admin.go(`/admin/people/${id}/access?test=/admin/billing/x&method=GET`)).text();
  assert.match(html, /Hidden on the Team page/);
  assert.match(html, /Set for this person/);
  assert.match(html, /No\. \/admin\/billing\/x belongs to Billing/);
});

test('people: the Team page\'s hidden modules move into the new model', () => {
  const id = person('Hidden Legacy', 'ppl-legacy@thewave.test', 'agent');
  db.run('UPDATE users SET hidden_modules = ? WHERE id = ?', JSON.stringify(['/admin/parking', '/admin/billing']), id);
  db.setSetting('ppl_hidden_migrated', '0');
  require('../src/admin/access').create({ db, ui: h.ui });
  assert.equal(db.value('SELECT hidden_modules FROM users WHERE id = ?', id), null);
  assert.deepEqual(db.all("SELECT key, level FROM ppl_overrides WHERE user_id = ? AND subject = 'module' ORDER BY key", id).map((r) => `${r.key}:${r.level}`), ['/admin/billing:none', '/admin/parking:none']);
  engine.touch();
  assert.equal(engine.levelOf(db.get('SELECT * FROM users WHERE id = ?', id), '/admin/parking'), 'none');
  assert.equal(engine.levelOf(db.get('SELECT * FROM users WHERE id = ?', id), '/admin/leads'), 'full');
});

test('people: roles are previewed before saving and keep their people in step', async () => {
  const rid = makeRole('Preview role', 'agent', { '/admin': 'view', '/admin/leads': 'view' });
  const pid = person('Role Holder', 'ppl-holder@thewave.test', 'agent', { roleId: rid });
  const editor = await (await admin.go(`/admin/people/roles/${rid}`)).text();
  assert.match(editor, /name="m:\/admin\/leads" value="view" checked/);
  const body = { name: 'Preview role', base: 'manager', default_level: 'none', color: 'forest', 'm:/admin/leads': 'full', 'm:/admin/billing': 'edit', cap_hr: '1' };
  const preview = await admin.form(`/admin/people/roles/${rid}`, body);
  const html = await preview.text();
  assert.equal(preview.status, 200);
  assert.match(html, /What changes in Preview role/);
  assert.match(html, /Role Holder/);
  assert.equal(db.value('SELECT base FROM ppl_roles WHERE id = ?', rid), 'agent', 'nothing saved yet');
  await admin.form(`/admin/people/roles/${rid}`, { ...body, confirm: '1' });
  assert.equal(db.value('SELECT base FROM ppl_roles WHERE id = ?', rid), 'manager');
  const u = db.get('SELECT * FROM users WHERE id = ?', pid);
  assert.equal(u.role, 'manager', 'the rank follows the role');
  assert.equal(u.hr, 1, 'and the HR switch');
  assert.equal(engine.levelOf(u, '/admin/leads'), 'full');
  assert.ok(db.value("SELECT COUNT(*) FROM ppl_history WHERE role_id = ? AND action = 'role_changed'", rid));
  // archiving waits until nobody holds it
  await admin.form(`/admin/people/roles/${rid}/archive`, {});
  assert.match(admin.flash(), /another role first/);
  // the review export and pages open in Arabic too
  assert.equal((await admin.go('/admin/people/review/export.csv')).status, 200);
  for (const p of ['/admin/people', '/admin/people/roles', '/admin/people/review', '/admin/people/history', '/admin/people/settings', `/admin/people/${pid}`]) assert.equal((await admin.go(`${p}${p.includes('?') ? '&' : '?'}lang=ar`)).status, 200, p);
  await admin.go('/admin?lang=en');
});

test('people: temporary access to a module behind a ceiling is refused with the reason', async () => {
  const pid = person('No Finance Agent', 'ppl-nofin@thewave.test', 'agent');
  const until = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const page = await (await admin.go(`/admin/people/${pid}/access`)).text();
  assert.doesNotMatch(page.match(/name="key"[\s\S]*?<\/select>/)[0], /value="\/admin\/accounting"/, 'Accounting is not offered while Finance is off');
  await admin.form(`/admin/people/${pid}/temp`, { key: '/admin/accounting', level: 'view', until, reason: 'audit week' });
  assert.match(admin.flash(), /stays closed/);
  assert.equal(db.value("SELECT COUNT(*) FROM ppl_overrides WHERE user_id = ? AND key = '/admin/accounting'", pid), 0);
  await admin.form(`/admin/people/${pid}/temp`, { key: '/admin/reports', level: 'view', until, reason: 'audit week' });
  assert.equal(db.value("SELECT COUNT(*) FROM ppl_overrides WHERE user_id = ? AND key = '/admin/reports'", pid), 1);
});
