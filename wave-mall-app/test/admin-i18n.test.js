'use strict';

// The leasing office in Arabic: language switching, right-to-left pages, Arabic formatting,
// stored system text shown in the reader's language, and a full crawl with nothing left in English.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/admin/i18n');
const ui = require('../src/admin/ui');
const M = require('../src/admin/model');
const { audit } = require('../scripts/i18n-audit');
const { createApp } = require('../src/app');

test('i18n: translation, placeholders, plurals and context keys', () => {
  i18n.run('ar', () => {
    assert.equal(i18n.t('Save'), 'حفظ');
    assert.equal(i18n.tn(1, '{n} invoice', '{n} invoices'), 'فاتورة واحدة');
    assert.equal(i18n.tn(2, '{n} invoice', '{n} invoices'), 'فاتورتان');
    assert.equal(i18n.tn(7, '{n} invoice', '{n} invoices'), '7 فواتير');
    assert.equal(i18n.tn(14, '{n} invoice', '{n} invoices'), '14 فاتورة');
    assert.equal(M.stage('won').label, 'تم التوقيع');
    assert.equal(M.UNIT_STATUS.leased, 'مؤجَّرة');
    assert.ok(Object.values(M.CATEGORIES).every((x) => /[؀-ۿ]/.test(x)));
  });
  i18n.run('en', () => {
    assert.equal(i18n.t('Save'), 'Save');
    assert.equal(i18n.t('invoice|Open'), 'Open');
    assert.equal(i18n.tn(1, '{n} invoice', '{n} invoices'), '1 invoice');
    assert.equal(i18n.tn(3, '{n} invoice', '{n} invoices'), '3 invoices');
    assert.equal(M.stage('won').label, 'Signed');
  });
  assert.equal(M.stageEn('proposal'), 'Proposal');
});

test('i18n: stored English system text reads in Arabic, typed text is left alone', () => {
  i18n.run('ar', () => {
    assert.equal(i18n.tx('Not given'), 'غير مذكور');
    assert.equal(i18n.tx('Price'), 'السعر');
    assert.equal(i18n.tx('A note somebody typed'), 'A note somebody typed');
    assert.equal(i18n.tx(null), null);
  });
  i18n.run('en', () => assert.equal(i18n.tx('Price'), 'Price'));
});

test('i18n: Arabic numbers, money, areas and dates (Western digits)', () => {
  const plain = (fn) => (...a) => fn(...a).replace(/\u200f/g, '');
  const money = plain(ui.money);
  const m2 = plain(ui.m2);
  const date = plain(ui.date);
  i18n.run('ar', () => {
    ui.setCurrency('EGP');
    assert.ok(ui.money(1234).startsWith('\u200f'), 'Arabic amounts start with a right-to-left mark');
    assert.equal(money(1234), '1,234 ج.م');
    assert.match(money(32400000, { compact: true }), /^32\.4\sمليون ج\.م$/);
    assert.equal(m2(210), '210 م²');
    assert.equal(date('2026-10-26'), '26 أكتوبر 2026');
    assert.equal(ui.monthYear('2026-10'), 'أكتوبر 2026');
    assert.equal(ui.rel(new Date().toISOString()), 'اليوم');
  });
  i18n.run('en', () => {
    assert.equal(ui.money(32400000, { compact: true }), 'EGP 32.4M');
    assert.equal(ui.date('2026-10-26'), '26 Oct 2026');
  });
});

test('i18n: the language switch is remembered per person', async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:' }, mail: async () => ({ delivered: true }) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready; // the office opens in the background on older Node (sql.js)
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const go = async (path, opts = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  try {
    let html = await (await go('/admin/setup?lang=ar')).text();
    assert.match(html, /<html lang="ar" dir="rtl"/);
    await go('/admin/setup', form({ _token: html.match(/name="_token" value="([^"]+)"/)[1], name: 'Admin', email: 'a@thewave.test', password: 'long-enough-1' }));
    html = await (await go('/admin')).text();
    assert.match(html, /<html lang="ar" dir="rtl"/);
    assert.match(html, /لوحة التحكم/);
    const csrf = html.match(/name="csrf" content="([^"]+)"/)[1];

    // switch to English from the top bar, back to the same page
    let res = await go('/admin/lang', form({ _csrf: csrf, lang: 'en', back: '/admin/leads' }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/leads');
    html = await (await go('/admin/leads')).text();
    assert.match(html, /<html lang="en" dir="ltr"/);

    // the choice follows the person, not just the browser
    jar.delete('wv_lang');
    html = await (await go('/admin')).text();
    assert.match(html, /<html lang="en"/);
    res = await go('/admin/lang', form({ _csrf: csrf, lang: 'ar', back: 'https://evil.example/' }));
    assert.equal(res.headers.get('location'), '/admin', 'never redirects off the admin');
    jar.delete('wv_lang');
    html = await (await go('/admin/pipeline')).text();
    assert.match(html, /<html lang="ar" dir="rtl"/);

    // JSON answers speak the same language
    const r = await go('/admin/leads/999/stage', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /[؀-ۿ]/);
  } finally {
    server.close();
  }
});

test('i18n: every admin page is fully Arabic, with sample data loaded', { timeout: 300000 }, async () => {
  const r = await audit({ quiet: true });
  assert.deepEqual(r.errors, [], 'pages failed or were not Arabic');
  assert.deepEqual(r.missing, [], 'keys without Arabic');
  assert.deepEqual(r.pages, {}, 'English left on pages');
  assert.ok(r.visited > 100, `only ${r.visited} pages visited`);
});
