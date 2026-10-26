'use strict';

// The leasing office at /admin: sign-in, CSRF, website enquiries becoming leads, and the deal maths.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const M = require('../src/admin/model');

let server;
let base;
const jar = new Map();

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function go(path, opts = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
    else jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return res;
}
const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const token = (html) => html.match(/name="_token" value="([^"]+)"/)[1];
const csrfOf = (html) => html.match(/name="csrf" content="([^"]+)"/)[1];

test('admin: first-run setup, sign-in, roles and CSRF', async () => {
  let res = await go('/admin');
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/admin\/login/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');

  res = await go('/admin/login');
  assert.equal(res.headers.get('location'), '/admin/setup', 'no users yet: setup first');
  await go('/admin/setup');
  res = await go('/admin/setup', form({ _token: 'wrong', name: 'Admin', email: 'admin@thewave.test', password: 'long-enough-1' }));
  assert.equal(res.status, 422, 'setup needs its form token');
  res = await go('/admin/setup', form({ _token: token(await res.text()), name: 'Admin', email: 'admin@thewave.test', password: 'long-enough-1' }));
  assert.equal(res.status, 303);
  assert.match(jar.get('wv_sess') || '', /.{20,}/);

  res = await go('/admin/setup');
  assert.match(res.headers.get('location'), /\/admin\/login/, 'setup closes once someone exists');

  const dash = await (await go('/admin')).text();
  assert.match(dash, /Dashboard/);
  const csrf = csrfOf(dash);

  // a state change without the CSRF token is refused
  res = await go('/admin/leads', form({ title: 'No token', category: 'fnb' }));
  assert.equal(res.status, 403);
  res = await go('/admin/leads', form({ _csrf: csrf, title: 'Café Test', category: 'fnb', source: 'direct' }));
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/admin\/leads\/\d+$/);

  // sign out, then a wrong password is refused
  await go('/admin/logout', form({ _csrf: csrf }));
  res = await go('/admin');
  assert.equal(res.status, 303);
  const login = await (await go('/admin/login')).text();
  res = await go('/admin/login', form({ _token: token(login), email: 'admin@thewave.test', password: 'nope-nope-nope' }));
  assert.equal(res.status, 401);
  res = await go('/admin/login', form({ _token: token(await res.text()), email: 'admin@thewave.test', password: 'long-enough-1', next: '//evil.example' }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin', 'never redirects off the admin');
});

test('admin: a leasing enquiry on the website lands in the inbox as a lead', async () => {
  const res = await fetch(`${base}/api/enquiry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ name: 'Nour Hassan', email: 'nour@brand.test', brand: 'Atelier Nour', category: 'fashion', size: 'm', message: 'A plaza corner, please.', lang: 'en' }),
  });
  assert.equal(res.status, 200);
  const inbox = await (await go('/admin/inbox')).text();
  assert.match(inbox, /Atelier Nour/);
  const leads = await (await go('/admin/leads')).text();
  assert.match(leads, /Atelier Nour/);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/admin\//);
});

test('admin: sample data loads, every module renders, and it clears again', async () => {
  const csrf = csrfOf(await (await go('/admin')).text());
  let res = await go('/admin/settings/demo', form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  for (const path of ['/admin', '/admin/inbox', '/admin/leads', '/admin/pipeline', '/admin/calendar', '/admin/offers', '/admin/leases', '/admin/billing', '/admin/units', '/admin/brands', '/admin/reports', '/admin/team', '/admin/subscribers', '/admin/settings', '/admin/audit', '/admin/leads/1', '/admin/offers/1', '/admin/offers/1/print', '/admin/leases/1', '/admin/invoices/1/print']) {
    res = await go(path);
    assert.equal(res.status, 200, path);
    assert.doesNotMatch(await res.text(), /undefined|NaN|\[object Object\]/, path);
  }
  res = await go('/admin/export/rentroll.csv');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(await res.text(), /Maison Lune/);
  res = await go('/admin/settings/demo/clear', form({ _csrf: csrf }));
  assert.equal(res.status, 303);
  assert.doesNotMatch(await (await go('/admin/leads')).text(), /Maison Lune/);
});

test('admin: offer schedule and invoice plan', () => {
  const units = [{ indoor_m2: 100, terrace_m2: 50 }];
  const sc = M.schedule({ rent_m2: 1000, terrace_rent_m2: 400, service_m2: 100, term_years: 3, escalation_pct: 10, rent_free_months: 3, deposit_months: 3, key_money: 5000 }, units);
  assert.equal(sc.firstMonth, 120000); // 100 × 1000 + 50 × 400
  assert.equal(sc.deposit, 360000);
  assert.equal(Math.round(sc.years[0].rent), 120000 * 9); // three months free
  assert.equal(Math.round(sc.years[1].rent), 120000 * 1.1 * 12);
  assert.equal(Math.round(sc.years[2].rent), Math.round(120000 * 1.21 * 12));
  assert.equal(Math.round(sc.total), Math.round(sc.totalRent + 100 * 100 * 12 * 3 + 5000));

  const plan = M.invoicePlan({ rent_m2: 1000, terrace_rent_m2: 400, service_m2: 100, term_years: 2, escalation_pct: 10, rent_free_months: 1, payment_freq: 'quarterly', start_date: '2027-01-15' }, units);
  assert.equal(plan.length, 8);
  assert.deepEqual([plan[0].period_start, plan[0].period_end], ['2027-01-15', '2027-04-14']);
  assert.equal(plan[0].rent, 240000); // first month free
  assert.equal(plan[4].rent, Math.round(120000 * 1.1 * 3));
  assert.equal(plan[0].service, 30000);
  const billed = plan.reduce((s, p) => s + p.rent, 0);
  assert.equal(billed, Math.round(120000 * 11 + 120000 * 1.1 * 12));
});
