'use strict';

// The dashboard's period bar and sorting: with no period it is exactly the usual dashboard; with one,
// the flows (new leads, leases signed, cash collected, won and lost) count inside the period and are
// compared with the same number of days before it, the charts follow it, figures that are always as
// of today carry a "now" tag, and each card's Sort by reorders it.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const M = require('../src/admin/model');

let server;
let base;
let db;
let h;
let admin;
let adminId;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  adminId = Number(db.run("INSERT INTO users (name, email, role, password_hash, lang, created_at) VALUES ('Dash Admin', 'dash-admin@thewave.test', 'admin', ?, 'en', datetime('now'))", hashPassword('long-enough-1')).lastInsertRowid);
  if (h.access && h.access.engine) h.access.engine.touch();
  admin = browser();
  await admin.signIn('dash-admin@thewave.test', 'long-enough-1');
  // leads: two in March 2025, one in the 31 days before it, one long before
  const lead = (ref, title, created, stage = 'new', closed = null) => db.run(
    "INSERT INTO leads (ref, title, source, stage, value_est, created_at, updated_at, stage_at, closed_at) VALUES (?, ?, 'website', ?, 100000, ?, ?, ?, ?)",
    ref, title, stage, created, created, created, closed,
  );
  lead('DP-1', 'Period lead one', '2025-03-05T09:00:00.000Z');
  lead('DP-2', 'Period lead two', '2025-03-28T09:00:00.000Z', 'won', '2025-03-29T09:00:00.000Z');
  lead('DP-3', 'Before lead', '2025-02-10T09:00:00.000Z', 'lost', '2025-02-12T09:00:00.000Z');
  lead('DP-4', 'Old lead', '2024-06-10T09:00:00.000Z');
});
after(() => server.close());

let ipN = 0;
function browser() {
  const jar = new Map();
  const ip = `10.8.${Math.floor(++ipN / 250)}.${ipN % 250}`;
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
  return {
    go,
    text: async (p) => { const r = await go(p); assert.equal(r.status, 200, p); return r.text(); },
    async signIn(email, password) {
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303, `sign-in for ${email}`);
    },
  };
}
// the value of the KPI with this label
const kpi = (html, label) => {
  const i = html.indexOf(`<p class="kpi__label">${label}</p>`);
  assert.ok(i >= 0, `the KPI "${label}" is on the page`);
  return html.slice(i).match(/<p class="kpi__value">([^<]*)<\/p>/)[1];
};
const order = (html, marks) => marks.map((m) => [m, html.indexOf(m)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]).map(([m]) => m);

test('dashboard: with no period it is the usual dashboard, with the period bar on top', async () => {
  const html = await admin.text('/admin');
  const d = M.dashboard(db, db.get('SELECT * FROM users WHERE id = ?', adminId));
  assert.equal(d.period, null, 'no period by default');
  assert.equal(kpi(html, 'New leads · 30 days'), String(d.leads30), 'the 30-day lead count is unchanged');
  for (const label of ['Occupancy', 'Committed', 'Weighted pipeline', 'Signed this month', 'Overdue rent']) kpi(html, label);
  assert.doesNotMatch(html, /class="dash2-now"/, 'no "now" tags without a period');
  assert.match(html, /class="filters dash2-period"/, 'the period bar');
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/);
  assert.match(html, /class="chip is-on"[^>]*>Usual view</, 'the usual view is the chosen chip');
  for (const chip of ['Today', 'Last 7 days', 'This month', 'Last month', 'This quarter', 'This year']) assert.match(html, new RegExp(`>${chip}</a>`), chip);
  assert.match(html, /Leads per month/);
  // the usual view still answers the same as the model without options
  assert.deepEqual(M.dashboard(db, null, {}).leads30, M.dashboard(db, null).leads30);
});

test('dashboard: a custom period counts inside it and compares with the days before', async () => {
  const html = await admin.text('/admin?from=2025-03-01&to=2025-03-31');
  assert.equal(kpi(html, 'New leads'), '2', 'two leads in March 2025');
  assert.match(html, /▲ 100%<\/span> vs the previous 31 days/, 'one lead in the 31 days before');
  assert.match(html, /href="\/admin\/leads\?from=2025-03-01&amp;to=2025-03-31"/, 'the KPI opens the leads of the period');
  assert.match(html, /class="dash2-now"/, 'figures as of today are tagged');
  assert.match(html, /1 won, 0 lost in the period/);
  assert.match(html, /1 won and 0 lost in the period \(0 and 1 before\)/);
  assert.match(html, /Leads per day/, 'a month is drawn day by day');
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/, 'nothing missing on the period page');
  assert.match(html, /bars__ghost/, 'with the period before as faded bars');
  assert.match(html, /1 Mar 2025 – 31 Mar 2025/);
  assert.match(html, /31 days · compared with 29 Jan 2025 – 28 Feb 2025/);
  // reversed dates are swapped; a long range is drawn by month, then by quarter
  const rev = await admin.text('/admin?from=2025-03-31&to=2025-03-01');
  assert.equal(kpi(rev, 'New leads'), '2');
  assert.match(await admin.text('/admin?from=2024-06-01&to=2025-03-31'), /Leads per month/);
  assert.match(await admin.text('/admin?from=2023-01-01&to=2025-03-31'), /Leads per quarter/);
  assert.match(await admin.text('/admin?from=2025-01-01&to=2025-03-31'), /Leads per week/);
  // the model agrees
  const P = M.dashboard(db, null, { from: '2025-03-01', to: '2025-03-31' }).period;
  assert.equal(P.now.leads, 2);
  assert.equal(P.before.leads, 1);
  assert.equal(P.now.won, 1);
  assert.equal(P.before.lost, 1);
  assert.equal(P.series.length, 31);
  assert.equal(P.series.reduce((s, b) => s + b.leads, 0), 2);
  assert.equal(P.series.reduce((s, b) => s + b.leadsPrev, 0), 1);
  // a nonsense date is ignored: the usual view
  assert.match(await admin.text('/admin?from=2025-13-45&to=nope'), /New leads · 30 days/);
});

test('dashboard: the quick ranges link to their dates and show as chosen', async () => {
  const html = await admin.text('/admin');
  const t = M.today();
  const week = html.match(/href="([^"]+)">Last 7 days</)[1].replace(/&amp;/g, '&');
  assert.equal(week, `/admin?from=${M.addDays(t, -6)}&to=${t}`);
  const month = html.match(/href="([^"]+)">This month</)[1].replace(/&amp;/g, '&');
  assert.match(month, new RegExp(`from=${t.slice(0, 7)}-01&to=${t.slice(0, 7)}-\\d\\d$`));
  const chosen = await admin.text(week);
  assert.match(chosen, /class="chip is-on" href="[^"]+">Last 7 days</, 'the chip shows as chosen');
  assert.match(chosen, /7 days · compared with/);
  const today = await admin.text(html.match(/href="([^"]+)">Today</)[1].replace(/&amp;/g, '&'));
  assert.match(today, /1 day · compared with/);
});

test('dashboard: each card sorts, and the choices keep each other and the period', async () => {
  const t = M.today();
  const lead = db.value("SELECT id FROM leads WHERE ref = 'DP-1'");
  const add = (subject, due, type = 'call') => db.run('INSERT INTO activities (lead_id, user_id, type, subject, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', lead, adminId, type, subject, due, new Date().toISOString());
  add('Task due earlier', `${M.addDays(t, -1)}T09:00:00.000Z`);
  add('Task due later', `${M.addDays(t, 1)}T09:00:00.000Z`);
  add('Viewing sooner', `${M.addDays(t, 2)}T09:00:00.000Z`, 'viewing');
  add('Viewing further', `${M.addDays(t, 9)}T09:00:00.000Z`, 'viewing');
  let html = await admin.text('/admin');
  assert.deepEqual(order(html, ['Task due earlier', 'Task due later']), ['Task due earlier', 'Task due later'], 'soonest first by default');
  assert.deepEqual(order(html, ['Viewing sooner', 'Viewing further']), ['Viewing sooner', 'Viewing further']);
  html = await admin.text('/admin?tasks=due_late&up=late');
  assert.deepEqual(order(html, ['Task due earlier', 'Task due later']), ['Task due later', 'Task due earlier']);
  assert.deepEqual(order(html, ['Viewing sooner', 'Viewing further']), ['Viewing further', 'Viewing sooner']);
  assert.match(html, /<select name="tasks" data-autosubmit[^>]*><option value="due">[^<]*<\/option><option value="due_late" selected>/);
  // a card's form keeps the other choices and the period
  html = await admin.text('/admin?from=2025-03-01&to=2025-03-31&up=late');
  const feedForm = html.match(/<form method="get" action="\/admin" class="dash2-sort">((?:(?!<\/form>).)*name="feed"(?:(?!<\/form>).)*)<\/form>/s)[1];
  assert.match(feedForm, /name="from" value="2025-03-01"/);
  assert.match(feedForm, /name="up" value="late"/);
  // the activity feed: oldest first, and only the period's entries
  db.run("INSERT INTO audit (user_id, action, detail, created_at) VALUES (?, 'Viewed the first marker', NULL, '2025-03-02T10:00:00.000Z')", adminId);
  db.run("INSERT INTO audit (user_id, action, detail, created_at) VALUES (?, 'Viewed the second marker', NULL, '2025-03-20T10:00:00.000Z')", adminId);
  db.run("INSERT INTO audit (user_id, action, detail, created_at) VALUES (?, 'Viewed the outside marker', NULL, '2025-05-20T10:00:00.000Z')", adminId);
  const marks = ['viewed the first marker', 'viewed the second marker', 'viewed the outside marker'];
  html = await admin.text('/admin?from=2025-03-01&to=2025-03-31');
  assert.deepEqual(order(html, marks), ['viewed the second marker', 'viewed the first marker'], 'newest first, inside the period');
  html = await admin.text('/admin?from=2025-03-01&to=2025-03-31&feed=oldest');
  assert.deepEqual(order(html, marks), ['viewed the first marker', 'viewed the second marker']);
  assert.match(html, /Activity in the period/);
  // an unknown sort falls back to the usual order
  html = await admin.text('/admin?tasks=sideways');
  assert.deepEqual(order(html, ['Task due earlier', 'Task due later']), ['Task due earlier', 'Task due later']);
});

test('dashboard: the period bar and sorting in Arabic', async () => {
  const html = await admin.text('/admin?lang=ar&from=2025-03-01&to=2025-03-31');
  assert.match(html, /العرض المعتاد/);
  assert.match(html, /آخر 7 أيام/);
  assert.match(html, /هذا الربع/);
  assert.match(html, /الترتيب حسب/);
  assert.match(html, /مقارنةً بالأيام الـ31 السابقة/);
  assert.match(html, /class="dash2-now"[^>]*>الآن</);
  assert.match(html, /الفرص يوميًا/);
  assert.doesNotMatch(html, /dash2\|/, 'no untranslated keys');
  await admin.go('/admin?lang=en');
});

test('dashboard: a range longer than ten years is cut to the last ten', async () => {
  const html = await admin.text('/admin?from=1900-01-01&to=2025-03-31');
  assert.match(html, /name="from" value="2015-04-0[12]"/);
  assert.match(html, /Leads per quarter/);
});
