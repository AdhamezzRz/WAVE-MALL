'use strict';

// Help & training: the lesson registry (every lesson complete in both languages, recorded files
// where the manifest says so), the academy, lesson and transcript pages in English and Arabic,
// progress from the player, "watched", feedback, search, contextual help (?for=), the live tour
// data, support requests (emails both ways, unread badge, screenshots), the team training report,
// the portal's Help tab, and Help staying open to a custom role with no modules at all.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');
const help = require('../src/admin/help');

let server;
let base;
let db;
let h;
let admin;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  person('Help Admin', 'hlp-admin@thewave.test', 'admin');
  admin = browser();
  await admin.signIn('hlp-admin@thewave.test', 'long-enough-1');
});
after(() => server.close());

function person(name, email, role, { roleId = null, lang = 'en' } = {}) {
  const id = Number(db.run("INSERT INTO users (name, email, role, role_id, password_hash, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))", name, email, role, roleId, hashPassword('long-enough-1'), lang).lastInsertRowid);
  if (h.access && h.access.engine) h.access.engine.touch();
  return id;
}
let ipN = 0;
function browser() {
  const jar = new Map();
  const ip = `10.7.${Math.floor(++ipN / 250)}.${ipN % 250}`;
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
    form: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: b.csrf, ...data }).toString() }),
    json: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf': b.csrf }, body: JSON.stringify(data) }),
    async signIn(email, password) {
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303, `sign-in for ${email}`);
      const page = await (await go('/admin')).text();
      b.csrf = page.match(/name="csrf" content="([^"]+)"/)[1];
    },
  };
  return b;
}

test('help: every lesson is complete in both languages, and recorded files exist where the manifest says', () => {
  const { lessons, errors } = help.load({ fresh: true });
  assert.deepEqual(errors, [], 'lesson files without problems');
  assert.ok(lessons.length >= 8, 'the pilot lessons');
  for (const l of lessons) {
    for (const s of l.steps) if (s.say) for (const lang of ['en', 'ar']) assert.ok(String(s.say[lang] || '').trim().length > 3, `${l.id}: ${lang} line`);
    assert.ok(/[؀-ۿ]/.test(l.title.ar), `${l.id}: the Arabic title is Arabic`);
  }
  // a broken lesson is caught
  assert.ok(help.problems({ id: 'x', area: 'nowhere', title: {}, summary: {}, steps: [{ point: '.a' }] }).length >= 3);
  const m = help.manifest();
  for (const [id, langs] of Object.entries(m.lessons || {})) {
    for (const [lang, e] of Object.entries(langs)) {
      for (const ext of ['mp4', 'vtt', 'json', 'jpg']) assert.ok(fs.existsSync(path.join(help.MEDIA_DIR, lang, `${id}.${ext}`)), `${id} ${lang} .${ext}`);
      const doc = JSON.parse(fs.readFileSync(path.join(help.MEDIA_DIR, lang, `${id}.json`), 'utf8'));
      assert.ok(doc.cues.length >= 2 && doc.cues.every((c, i) => c.end >= c.start && (i === 0 || c.start >= doc.cues[i - 1].start)), `${id} ${lang}: ordered cues`);
      assert.ok(e.duration > 10 && e.size > 10000, `${id} ${lang}: a real video`);
      assert.match(fs.readFileSync(path.join(help.MEDIA_DIR, lang, `${id}.vtt`), 'utf8'), /^WEBVTT/);
    }
  }
});

test('help: the academy, a lesson and its transcript in English and Arabic', async () => {
  const l = help.load().lessons.find((x) => x.area !== 'portal');
  let html = await (await admin.go('/admin/help')).text();
  assert.match(html, /Learn the office/);
  assert.match(html, /Learning paths/);
  assert.match(html, new RegExp(l.title.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /\/admin\/help\.js\?v=/);
  html = await (await admin.go(`/admin/help/l/${l.id}`)).text();
  assert.match(html, /Transcript/);
  assert.match(html, /Show me on the real page/);
  assert.match(html, new RegExp(`tour=${l.id}`));
  const said = l.steps.find((s) => s.say).say;
  assert.ok(html.includes(said.en.replace(/&/g, '&amp;').replace(/'/g, '&#39;').slice(0, 30)), 'the transcript lines are on the page');
  if (help.media(l.id, 'en')) assert.match(html, /data-hlp-player/);
  // Arabic
  await admin.go('/admin/help?lang=ar');
  html = await (await admin.go(`/admin/help/l/${l.id}`)).text();
  assert.match(html, /النص المكتوب/);
  assert.ok(html.includes(l.title.ar.slice(0, 8)));
  assert.match(html, /dir="rtl"/);
  // the other language's video and the text download
  const txt = await admin.go(`/admin/help/l/${l.id}/transcript.txt?doc=en`);
  assert.equal(txt.status, 200);
  assert.match(txt.headers.get('content-disposition'), /attachment/);
  assert.ok((await txt.text()).includes(l.title.en));
  assert.equal((await admin.go(`/admin/help/l/${l.id}/transcript?doc=ar`)).status, 200);
  for (const p of ['/admin/help/faq', '/admin/help/glossary', '/admin/help/new', '/admin/help/shortcuts', '/admin/help/support', '/admin/help/support/new', '/admin/help/paths/start', '/admin/help/training']) {
    assert.equal((await admin.go(p)).status, 200, p);
  }
  await admin.go('/admin/help?lang=en');
  assert.equal((await admin.go('/admin/help/l/no-such-lesson')).status, 404);
});

test('help: progress, watched, feedback, search, contextual help and the tour data', async () => {
  const l = help.load().lessons.find((x) => x.area !== 'portal');
  const me = db.get("SELECT id FROM users WHERE email = 'hlp-admin@thewave.test'");
  let r = await admin.json(`/admin/help/l/${l.id}/progress`, { pos: 20, dur: 60, seen: 0.4 });
  assert.equal(r.status, 200);
  let p = db.get('SELECT * FROM hlp_progress WHERE user_id = ? AND lesson_id = ?', me.id, l.id);
  assert.equal(p.seen, 0.4);
  assert.equal(p.done_at, null);
  // never goes backwards, and 90% counts as watched
  await admin.json(`/admin/help/l/${l.id}/progress`, { pos: 5, dur: 60, seen: 0.2 });
  assert.equal(db.value('SELECT seen FROM hlp_progress WHERE user_id = ? AND lesson_id = ?', me.id, l.id), 0.4);
  await admin.json(`/admin/help/l/${l.id}/progress`, { pos: 58, dur: 60, seen: 0.93 });
  assert.ok(db.value('SELECT done_at FROM hlp_progress WHERE user_id = ? AND lesson_id = ?', me.id, l.id));
  // "continue watching" and resuming
  const l2 = help.load().lessons.filter((x) => x.area !== 'portal')[1];
  await admin.json(`/admin/help/l/${l2.id}/progress`, { pos: 30, dur: 70, seen: 0.3 });
  assert.match(await (await admin.go('/admin/help')).text(), /Continue watching/);
  // marking by hand, both ways
  await admin.form(`/admin/help/l/${l2.id}/done`, { done: '1' });
  assert.ok(db.value('SELECT done_at FROM hlp_progress WHERE user_id = ? AND lesson_id = ?', me.id, l2.id));
  await admin.form(`/admin/help/l/${l2.id}/done`, { done: '0' });
  assert.equal(db.value('SELECT done_at FROM hlp_progress WHERE user_id = ? AND lesson_id = ?', me.id, l2.id), null);
  // feedback
  await admin.form(`/admin/help/l/${l.id}/feedback`, { helpful: '0', note: 'Show the Arabic labels too' });
  assert.equal(db.get('SELECT helpful, note FROM hlp_feedback WHERE lesson_id = ?', l.id).note, 'Show the Arabic labels too');
  assert.match(await (await admin.go(`/admin/help/l/${l.id}`)).text(), /We will make it clearer/);
  // search: titles, transcript lines (either language), questions and the glossary
  const line = l.steps.find((s) => s.say).say.en.split(' ').slice(2, 5).join(' ');
  let html = await (await admin.go(`/admin/help?q=${encodeURIComponent(line)}`)).text();
  assert.ok(html.includes(l.title.en), 'found by a transcript line');
  html = await (await admin.go(`/admin/help?q=${encodeURIComponent('WALE')}`)).text();
  assert.match(html, /Weighted average lease expiry/);
  // contextual help: the "?" of a page lists that module's lessons first
  const leads = help.forPage('/admin/leads/12');
  assert.ok(leads.length && leads.every((x) => [x.module, ...(x.also || [])].some((m) => '/admin/leads/12'.startsWith(m))));
  html = await (await admin.go('/admin/help?for=%2Fadmin%2Fleads%2F12')).text();
  assert.match(html, /Help for the page you were on/);
  assert.ok(html.includes(leads[0].title.en));
  assert.match(await (await admin.go('/admin')).text(), /data-help-btn/);
  // the live tour data
  const tour = await (await admin.go(`/admin/help/l/${l.id}/tour.json`, { headers: { accept: 'application/json' } })).json();
  assert.equal(tour.ok, true);
  assert.equal(tour.steps.length, l.steps.filter((s) => s.say).length);
  assert.ok(tour.steps.every((s) => s.text && s.page && s.page.startsWith('/')));
});

test('help: support requests, both ways, with the unread badge and emails', async () => {
  person('Help Agent', 'hlp-agent@thewave.test', 'agent', { lang: 'ar' });
  const agent = browser();
  await agent.signIn('hlp-agent@thewave.test', 'long-enough-1');
  const before = db.value('SELECT COUNT(*) FROM outbox');
  // a missing subject is refused
  await agent.form('/admin/help/support', { subject: '', body: 'x' });
  assert.equal(db.value('SELECT COUNT(*) FROM hlp_tickets'), 0);
  let r = await agent.form('/admin/help/support', { subject: 'Cannot print the invoice', category: 'problem', body: 'The print button shows an empty page.', page: '/admin/invoices/3', agent: 'Test browser 1.0' });
  assert.equal(r.status, 303);
  const t = db.get('SELECT * FROM hlp_tickets ORDER BY id DESC LIMIT 1');
  assert.equal(t.status, 'open');
  assert.equal(t.page, '/admin/invoices/3');
  assert.match(t.ref, /^HLP-/);
  assert.ok(db.value('SELECT COUNT(*) FROM outbox WHERE to_addr = ? AND id > 0', 'hlp-admin@thewave.test') >= 1, 'administrators are emailed');
  assert.ok(db.value('SELECT COUNT(*) FROM outbox') > before);
  // the administrators' badge in the sidebar
  assert.match(await (await admin.go('/admin')).text(), /href="\/admin\/help" class="nav__a[^"]*">[\s\S]*?<b class="nav__count">1<\/b>/);
  let html = await (await admin.go('/admin/help/support')).text();
  assert.match(html, /Cannot print the invoice/);
  // someone else cannot read it
  person('Other Agent', 'hlp-other@thewave.test', 'agent');
  const other = browser();
  await other.signIn('hlp-other@thewave.test', 'long-enough-1');
  assert.equal((await other.go(`/admin/help/support/${t.id}`)).status, 404);
  // support replies: the requester is emailed (in Arabic) and sees "new reply"
  r = await admin.form(`/admin/help/support/${t.id}/reply`, { body: 'Open it with Print, then choose Save as PDF.' });
  assert.equal(db.value('SELECT status FROM hlp_tickets WHERE id = ?', t.id), 'answered');
  const mail = db.get("SELECT * FROM outbox WHERE to_addr = 'hlp-agent@thewave.test' ORDER BY id DESC LIMIT 1");
  assert.ok(mail, 'the requester is emailed');
  assert.match(mail.subject, /رد على طلب الدعم/);
  html = await (await agent.go('/admin/help/support')).text();
  assert.match(html, /رد جديد/);
  // reading it clears "new reply"
  html = await (await agent.go(`/admin/help/support/${t.id}`)).text();
  assert.match(html, /Save as PDF/);
  assert.doesNotMatch(await (await agent.go('/admin/help/support')).text(), /رد جديد/);
  // the requester adds more: back to open; then closes it
  await agent.form(`/admin/help/support/${t.id}/reply`, { body: 'It works now, thank you.' });
  assert.equal(db.value('SELECT status FROM hlp_tickets WHERE id = ?', t.id), 'open');
  await agent.form(`/admin/help/support/${t.id}/status`, { status: 'closed' });
  assert.equal(db.value('SELECT status FROM hlp_tickets WHERE id = ?', t.id), 'closed');
  assert.ok(db.value("SELECT COUNT(*) FROM audit WHERE action = 'Closed a support request'") >= 1);
  // a screenshot upload on the request
  const up = await agent.go(`/admin/help/files?entity=hlp_ticket&entity_id=${t.id}`, { method: 'POST', headers: { 'x-csrf': agent.csrf, 'content-type': 'application/octet-stream', 'x-file-name': 'shot.png' }, body: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex') });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).ok, true);
});

test('help: open to everyone, even a custom role with no modules; the training report and the portal tab', async () => {
  const engine = h.access && h.access.engine;
  if (engine) {
    const full = {};
    for (const e of engine.modules()) full[e.href] = 'none';
    const rid = Number(db.run("INSERT INTO ppl_roles (name, base, matrix, caps, default_level, created_at, updated_at) VALUES ('Nothing at all', 'viewer', ?, '{}', 'none', datetime('now'), datetime('now'))", JSON.stringify(full)).lastInsertRowid);
    person('No Modules', 'hlp-none@thewave.test', 'viewer', { roleId: rid });
    const p = browser();
    await p.signIn('hlp-none@thewave.test', 'long-enough-1');
    const home = await (await p.go('/admin/help')).text();
    assert.match(home, /href="\/admin\/help" class="nav__a/, 'in the menu');
    assert.equal((await p.go('/admin/leads')).status, 403, 'other modules stay closed');
    const l = help.load().lessons.find((x) => x.module === '/admin/leads');
    if (l) assert.match(await (await p.go(`/admin/help/l/${l.id}`)).text(), /live tour is not available/, 'no tour into a closed module');
    // and support works for them too
    assert.equal((await p.form('/admin/help/support', { subject: 'Access please', category: 'access', body: 'I need Leads.' })).status, 303);
  }
  // the training report: managers only, with a CSV
  const report = await (await admin.go('/admin/help/training')).text();
  assert.match(report, /Who watched what/);
  assert.match(report, /Help Admin/);
  const csv = await admin.go('/admin/help/training/export.csv');
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Help Admin/);
  person('Viewer Only', 'hlp-viewer@thewave.test', 'viewer');
  const v = browser();
  await v.signIn('hlp-viewer@thewave.test', 'long-enough-1');
  assert.notEqual((await v.go('/admin/help/training')).status, 200);
  // the portal's Help tab
  const brand = db.get('SELECT id FROM brands LIMIT 1') || { id: Number(db.run("INSERT INTO brands (name, created_at) VALUES ('Help Brand', datetime('now'))").lastInsertRowid) };
  db.run("INSERT INTO portal_users (brand_id, name, email, password_hash, created_at) VALUES (?, 'Help Tenant', 'hlp@tenant.test', ?, datetime('now'))", brand.id, hashPassword('long-enough-1'));
  const tenant = browser();
  const lp = await (await tenant.go('/portal/login')).text();
  const token = lp.match(/name="_token" value="([^"]+)"/);
  await tenant.go('/portal/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...(token ? { _token: token[1] } : {}), email: 'hlp@tenant.test', password: 'long-enough-1' }).toString() });
  const ph = await tenant.go('/portal/help');
  assert.equal(ph.status, 200);
  const phtml = await ph.text();
  assert.match(phtml, /How to use your tenant portal/);
  const pl = help.load().lessons.find((x) => x.area === 'portal');
  if (pl) {
    assert.ok(phtml.includes(`/portal/help/${pl.id}`));
    assert.equal((await tenant.go(`/portal/help/${pl.id}`)).status, 200);
  }
  const staffLesson = help.load().lessons.find((x) => x.area !== 'portal');
  assert.equal((await tenant.go(`/portal/help/${staffLesson.id}`)).status, 404, 'staff lessons are not in the portal');
});
