'use strict';

// Arabic coverage audit for the leasing office.
// Boots the app on an in-memory database, creates an administrator, loads the sample data,
// switches to Arabic and visits every admin page it can reach. It reports
//   - dictionary keys that were asked for but have no Arabic (i18n.missing), and
//   - English words still visible on a page (text and title/placeholder/aria-label/data-confirm/data-tip),
//     after removing what people typed (names, emails, brand names, references, codes…).
// Usage: node scripts/i18n-audit.js [--only=/admin/leads] [--max=500] [--verbose]
// Exit code 1 when anything is left.

const { createApp } = require('../src/app');
const i18n = require('../src/admin/i18n');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const ONLY = args.only ? String(args.only).split(',') : null;
const MAX = Number(args.max) || 700;

// Latin words that are fine in Arabic UI: product names, file formats, codes.
const OK_WORDS = new Set(['CSV', 'PDF', 'WALE', 'VAT', 'ID', 'The', 'Wave', 'K', 'English', 'EGP', 'JPG', 'PNG', 'WebP', 'Word', 'Excel', 'docx', 'xlsx', 'IBAN', 'EG']);

async function audit({ quiet = false } = {}) {
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
  const report = { missing: [], pages: {}, errors: [], visited: 0 };
  try {
    // a website enquiry, so the inbox has a real converted message
    await fetch(`${base}/api/enquiry`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ name: 'Nour Hassan', email: 'nour@brand.test', brand: 'Atelier Nour', category: 'fashion', size: 'm', message: 'A plaza corner, please.', lang: 'en' }) });
    const setup = await (await go('/admin/setup?lang=ar')).text();
    const tok = setup.match(/name="_token" value="([^"]+)"/)[1];
    await go('/admin/setup', form({ _token: tok, name: 'مدير المكتب', email: 'admin@thewave.test', password: 'long-enough-1' }));
    const csrf = (await (await go('/admin')).text()).match(/name="csrf" content="([^"]+)"/)[1];
    await go('/admin/settings/demo', form({ _csrf: csrf }));
    // what people typed: never expected to be translated
    const { db } = app.locals.admin || {};
    const typed = new Set();
    const add = (v) => { if (v && /[A-Za-z]/.test(String(v))) typed.add(String(v)); };
    if (db) {
      for (const r of db.all('SELECT name, email, phone FROM users')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT name, website, instagram FROM brands')) Object.values(r).forEach(add);
      // tenant files: legal and store details as typed, and document titles and file names
      for (const r of db.all('SELECT legal_name, cr_number, tax_id, vat_number, legal_address, signatory_name, signatory_id, bank_name, iban, store_manager, store_phone, store_email, trading_hours, emergency_name, emergency_phone, insurance_policy FROM brands')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT title, file_name FROM documents')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT name, email, phone FROM contacts')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT ref, title, message FROM leads')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT name, email, phone, brand, subject, body FROM messages')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT email FROM subscribers')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT ref FROM offers UNION SELECT ref FROM leases UNION SELECT ref FROM invoices')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT code FROM units')) Object.values(r).forEach(add);
      // contracts register and document vault: company names, their contacts, file names
      for (const r of db.all('SELECT ref, counterparty, contact_name, contact_phone, contact_email FROM contracts')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT ref, file_name FROM documents')) Object.values(r).forEach(add);
      // HR: what is typed about a person (names, contact details, bank and insurance numbers)
      for (const r of db.all('SELECT code, name, email, phone, address, emergency_name, emergency_phone, bank_name, iban, insurance_no, national_id FROM employees')) Object.values(r).forEach(add);
      for (const r of db.all('SELECT value FROM settings')) Object.values(r).forEach(add);
      add(db.file);
    }
    // single words of people's and brands' names (sample sentences mention first names)
    if (db) for (const r of db.all('SELECT name FROM users UNION SELECT name FROM contacts UNION SELECT name FROM brands')) for (const w of String(r.name || '').split(/\s+/)) if (w.length > 2 && /[A-Za-z]/.test(w)) typed.add(w);
    const longTyped = [...typed].filter((v) => v.length > 30);
    const typedList = [...typed].sort((a, b) => b.length - a.length);
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

    i18n.missing.clear();
    const seen = new Set();
    const queue = ONLY ? [...ONLY] : ['/admin'];
    while (queue.length && seen.size < MAX) {
      const path = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      const res = await go(path);
      if (res.status >= 500) { report.errors.push(`${path} → ${res.status}`); continue; }
      if (res.status >= 300) continue;
      const type = res.headers.get('content-type') || '';
      if (!type.includes('html')) continue;
      const html = await res.text();
      if (!/<html lang="ar" dir="rtl"/.test(html)) report.errors.push(`${path} is not rendered in Arabic`);
      for (const m of html.matchAll(/href="(\/admin[^"#]*)"/g)) {
        const h = decode(m[1]);
        if (/\.(css|js|csv)(\?|$)/.test(h) || /[?&](lang|doc)=/.test(h) || /\/export\//.test(h) || /\/settings\/backup/.test(h)) continue;
        if (ONLY && !ONLY.some((o) => h.startsWith(o))) continue;
        if (!seen.has(h)) queue.push(h);
      }
      // visible text and the attributes people read
      let body = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<head>[\s\S]*?<\/head>/, ' ');
      body = body.replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/g, ' ').replace(/<option value="(\d+)"[^>]*>[^<]*<\/option>/g, ' ');
      const attrs = [...body.matchAll(/\s(?:title|placeholder|aria-label|data-confirm|data-tip|alt)="([^"]*)"/g)].map((m) => m[1]);
      const texts = body.replace(/<[^>]+>/g, '\n').split('\n').concat(attrs).map((x) => decode(x).trim()).filter(Boolean);
      const left = [];
      for (let s of texts) {
        // a shortened customer message ("We are looking for a…")
        const cut = s.replace(/(…|\.\.\.)$/, '').trim();
        if ((cut !== s || cut.length > 60) && cut.length > 15 && longTyped.some((v) => v.replace(/\s+/g, ' ').startsWith(cut.replace(/\s+/g, ' ')))) continue;
        for (const v of typedList) if (s.includes(v)) s = s.split(v).join(' ');
        s = s.replace(/\S+@\S+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\b[A-Z]{2}-\d{4}(-\d+)?\b/g, ' ').replace(/\b[GS]\d{2}\b/g, ' ');
        const words = (s.match(/[A-Za-z][A-Za-z'’-]*[A-Za-z]|\b[A-Za-z]\b/g) || []).filter((w) => !OK_WORDS.has(w) && w.length > 1);
        if (/^[A-Z]{1,3}$/.test(s.trim())) continue; // avatar initials of Latin names
        if (words.length) left.push(s.replace(/\s+/g, ' ').trim().slice(0, 140));
      }
      if (left.length) report.pages[path] = [...new Set(left)];
      report.visited++;
    }
    report.missing = [...i18n.missing].sort();
  } finally {
    server.close();
  }
  if (!quiet) {
    const pages = Object.entries(report.pages);
    // group the same leftover across many pages
    const byText = new Map();
    for (const [p, list] of pages) for (const x of list) byText.set(x, [...(byText.get(x) || []), p]);
    console.log(`Visited ${report.visited} Arabic pages.`);
    if (report.errors.length) console.log(`\nErrors:\n  ${report.errors.join('\n  ')}`);
    if (report.missing.length) console.log(`\nMissing Arabic for ${report.missing.length} keys:\n  ${report.missing.map((k) => JSON.stringify(k)).join('\n  ')}`);
    if (byText.size) {
      console.log(`\nEnglish still visible (${byText.size}):`);
      for (const [x, ps] of [...byText].sort((a, b) => a[1][0].localeCompare(b[1][0]))) console.log(`  ${JSON.stringify(x)}  ← ${ps.slice(0, 3).join(', ')}${ps.length > 3 ? ` +${ps.length - 3}` : ''}`);
    }
    if (!report.errors.length && !report.missing.length && !byText.size) console.log('Everything is in Arabic.');
  }
  return report;
}

if (require.main === module) {
  audit().then((r) => process.exit(r.errors.length || r.missing.length || Object.keys(r.pages).length ? 1 : 0));
}
module.exports = { audit };
