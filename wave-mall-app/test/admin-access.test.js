'use strict';

// Module access (hidden in the menu, refused by address, defaults unchanged), automatic backups
// (file written and checked, rotation, the S3 upload signed per AWS Signature V4, the email copy)
// and the assistant (tool call → SQL → answer with a mocked Claude API; writes refused; HR tables
// out of reach without HR access; secrets never readable).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const backupsMod = require('../src/admin/backups');
const aiSql = require('../src/admin/ai-sql');

const BDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-bak-test-'));
const ENV = {
  SITE_URL: 'https://thewavemall.com', ADMIN_DB: ':memory:', ADMIN_JOBS: '0', BACKUP_DIR: BDIR, ANTHROPIC_API_KEY: 'sk-ant-test',
  BACKUP_S3_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com', BACKUP_S3_BUCKET: 'wave-backups', BACKUP_S3_KEY: 'AKIDEXAMPLE', BACKUP_S3_SECRET: 'secret-example', BACKUP_S3_REGION: 'eu-central-1', SMTP_HOST: 'smtp.test',
};
let server;
let base;
let app;
function client() {
  const jar = new Map();
  const go = async (p, opts = {}) => {
    const res = await fetch(base + p, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
  const flash = () => {
    try { return JSON.parse(decodeURIComponent(jar.get('wv_flash') || '')).text; } catch { return ''; }
  };
  return { go, flash };
}
const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const csrfOf = (html) => html.match(/name="csrf" content="([^"]+)"/)[1];
const token = (html) => html.match(/name="_token" value="([^"]+)"/)[1];
async function signIn(email, password) {
  const c = client();
  const login = await (await c.go('/admin/login')).text();
  await c.go('/admin/login', form({ _token: token(login), email, password }));
  c.csrf = csrfOf(await (await c.go('/admin')).text());
  return c;
}

let admin;
let agentPw;
before(async () => {
  app = createApp({ env: ENV, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  const setup = await (await admin.go('/admin/setup')).text();
  await admin.go('/admin/setup', form({ _token: token(setup), name: 'Owner', email: 'owner@thewave.test', password: 'long-enough-1' }));
  admin.csrf = csrfOf(await (await admin.go('/admin')).text());
  await admin.go('/admin/team', form({ _csrf: admin.csrf, name: 'Salma Agent', email: 'agent@thewave.test', role: 'agent' }));
  agentPw = admin.flash().match(/password is (\S+)/)[1];
  await admin.go('/admin/settings/demo', form({ _csrf: admin.csrf }));
});
after(() => {
  server.close();
  fs.rmSync(BDIR, { recursive: true, force: true });
});

// ---------- module access ----------
test('access: nothing changes until an administrator hides a module', async () => {
  const agent = await signIn('agent@thewave.test', agentPw);
  const html = await (await agent.go('/admin')).text();
  for (const href of ['/admin/billing', '/admin/leases', '/admin/parking', '/admin/assistant']) assert.match(html, new RegExp(`href="${href}"`), href);
  assert.equal((await agent.go('/admin/billing')).status, 200);
  assert.equal(app.locals.admin.db.value("SELECT hidden_modules FROM users WHERE email = 'agent@thewave.test'"), null);
});

test('access: a hidden module leaves the menu and is refused by address, for every method', async () => {
  const { db } = app.locals.admin;
  const id = db.value("SELECT id FROM users WHERE email = 'agent@thewave.test'");
  const page = await (await admin.go(`/admin/team/${id}/access`)).text();
  assert.match(page, /name="m" value="\/admin\/billing" checked/);
  assert.match(page, /value="\/admin\/hr"[^>]*disabled/, 'HR modules are outside an agent\'s role');
  // untick Billing and Parking: post everything else the role allows
  const ticked = [...page.matchAll(/name="m" value="([^"]+)" checked(?! disabled)/g)].map((m) => m[1]).filter((h) => !['/admin/billing', '/admin/parking'].includes(h));
  const body = new URLSearchParams([['_csrf', admin.csrf], ...ticked.map((h) => ['m', h])]).toString();
  await admin.go(`/admin/team/${id}/access`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.deepEqual(JSON.parse(db.value('SELECT hidden_modules FROM users WHERE id = ?', id)).sort(), ['/admin/billing', '/admin/parking']);
  assert.match(await (await admin.go('/admin/team')).text(), /2 modules hidden/);
  assert.ok(db.value("SELECT COUNT(*) FROM audit WHERE action = 'Updated a team member' AND detail LIKE '%hidden: Billing, Parking%'"), 'audit-logged');

  const agent = await signIn('agent@thewave.test', agentPw);
  const html = await (await agent.go('/admin')).text();
  const nav = html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>'));
  assert.doesNotMatch(nav, /href="\/admin\/billing"/);
  assert.doesNotMatch(nav, /href="\/admin\/parking"/);
  assert.match(nav, /href="\/admin\/leases"/, 'other modules stay');
  assert.doesNotMatch(html, /href="\/admin\/billing" class="more__a/, 'nor in the phone menu');
  for (const p of ['/admin/billing', '/admin/parking', '/admin/parking/visits', '/admin/invoices/1', '/admin/payments']) {
    const r = await agent.go(p);
    assert.equal(r.status, 403, p);
    if (p === '/admin/billing') assert.match(await r.text(), /Billing is not part of your access/);
  }
  const post = await agent.go('/admin/invoices/1/pay', form({ _csrf: agent.csrf, amount: '1' }));
  assert.equal(post.status, 403, 'refused before the module sees it');
  // administrators are never limited
  const ownerId = db.value("SELECT id FROM users WHERE email = 'owner@thewave.test'");
  db.run('UPDATE users SET hidden_modules = ? WHERE id = ?', JSON.stringify(['/admin/billing']), ownerId);
  assert.equal((await admin.go('/admin/billing')).status, 200);
  db.run('UPDATE users SET hidden_modules = NULL WHERE id = ?', ownerId);
  // "Open every module" puts it back
  await admin.go(`/admin/team/${id}/access`, form({ _csrf: admin.csrf, reset: '1' }));
  assert.equal(db.value('SELECT hidden_modules FROM users WHERE id = ?', id), null);
  assert.equal((await agent.go('/admin/billing')).status, 200);
});

test('access: only administrators manage it', async () => {
  const agent = await signIn('agent@thewave.test', agentPw);
  const id = app.locals.admin.db.value("SELECT id FROM users WHERE email = 'owner@thewave.test'");
  assert.equal((await agent.go(`/admin/team/${id}/access`)).status, 303);
  await agent.go(`/admin/team/${id}/access`, form({ _csrf: agent.csrf }));
  assert.equal(app.locals.admin.db.value('SELECT hidden_modules FROM users WHERE id = ?', id), null);
});

// ---------- backups ----------
test('backups: AWS Signature V4 matches the documented examples', () => {
  const opts = { region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') };
  const put = backupsMod.sigv4({ ...opts, method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test%24file.text', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: crypto.createHash('sha256').update('Welcome to Amazon S3.').digest('hex') });
  assert.equal(put.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  const get = backupsMod.sigv4({ ...opts, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  assert.equal(get.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('backups: a checked, compressed copy is kept, emailed and uploaded with a signed PUT', async () => {
  const { h, db } = app.locals.admin;
  const puts = [];
  h.backups.fetch = async (url, opts) => { puts.push({ url, opts }); return new Response('', { status: 200 }); };
  const mails = [];
  h.backups.transport = { sendMail: async (m) => { mails.push(m); return { messageId: 'x' }; } };
  db.setSetting('backup_email_to', 'it@thewave.test');
  const r = await admin.go('/admin/settings/backups/run', form({ _csrf: admin.csrf }));
  assert.equal(r.status, 303);
  assert.match(admin.flash(), /Backup saved .* emailed and sent to off-site storage/);
  const run = db.get('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1');
  assert.equal(run.status, 'ok');
  assert.equal(run.email_status, 'sent');
  assert.equal(run.s3_status, 'sent');
  // the file: gzip of a real SQLite database with the office's tables
  const file = path.join(BDIR, run.file);
  const data = fs.readFileSync(file);
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), run.sha256);
  const raw = zlib.gunzipSync(data);
  assert.equal(raw.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  if (run.tables !== null) assert.ok(run.tables > 50);
  // the email carries it as an attachment
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'it@thewave.test');
  assert.equal(mails[0].attachments[0].filename, run.file);
  assert.ok(Buffer.compare(mails[0].attachments[0].content, data) === 0);
  assert.equal(db.value("SELECT COUNT(*) FROM outbox WHERE attachments LIKE '%' || ? || '%'", run.file), 0, 'never stored in the outbox');
  // the upload: path-style URL, payload hash and a signature that verifies
  assert.equal(puts.length, 1);
  const { url, opts } = puts[0];
  assert.equal(url, `https://s3.eu-central-1.amazonaws.com/wave-backups/the-wave/${run.file}`);
  assert.equal(opts.method, 'PUT');
  assert.equal(opts.headers['x-amz-content-sha256'], run.sha256);
  const amzDate = opts.headers['x-amz-date'];
  const date = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  const again = backupsMod.sigv4({ method: 'PUT', url, headers: { 'content-type': 'application/gzip' }, payloadHash: run.sha256, region: 'eu-central-1', accessKey: 'AKIDEXAMPLE', secretKey: 'secret-example', date });
  assert.equal(opts.headers.authorization, again.headers.authorization);
  assert.match(opts.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(opts.body.length, data.length);
  // the download is the ready database file
  const dl = await admin.go(`/admin/settings/backups/file/${run.file}`);
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString('latin1'), 'SQLite format 3');
  assert.equal((await admin.go('/admin/settings/backups/file/..%2F..%2Fetc%2Fpasswd')).status, 404);
  // the Settings card shows it
  const page = await (await admin.go('/admin/settings')).text();
  assert.match(page, /id="backups"/);
  assert.match(page, new RegExp(run.file.replace(/\./g, '\\.')));
});

test('backups: failures are recorded, size limit and rotation', async () => {
  const { h, db } = app.locals.admin;
  h.backups.fetch = async () => new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 });
  db.setSetting('backup_email_max_mb', '1');
  h.backups.transport = { sendMail: async () => { throw new Error('should not send'); } };
  const r = await h.backups.run({ trigger: 'manual' });
  assert.equal(r.s3_status, 'failed');
  assert.match(r.s3_detail, /403 AccessDenied: Access Denied/);
  assert.equal(r.status, 'partial');
  if (r.bytes > 1048576) assert.equal(r.email_status, 'skipped');
  else assert.equal(r.email_status, 'failed', 'small enough: tried, and the transport failed');
  // rotation: copies older than the days kept go, the newest always stays
  db.setSetting('backup_keep_days', '7');
  for (const d of ['2026-01-01', '2026-01-02']) fs.writeFileSync(path.join(BDIR, `the-wave-${d}-030000-daily.db.gz`), 'x');
  const before = h.backups.list().length;
  const removed = h.backups.rotate('2026-12-31');
  assert.ok(removed >= 2);
  assert.ok(h.backups.list().length >= 1 && h.backups.list().length < before);
  // the daily job: due once a day after the hour
  db.setSetting('backup_hour', '3');
  const at = (iso) => new Date(iso);
  assert.equal(h.backups.due(at('2031-01-05T00:30:00Z')), false, '02:30 Cairo: not yet');
  assert.equal(h.backups.due(at('2031-01-05T02:30:00Z')), true, '04:30 Cairo: due');
  db.run("INSERT INTO backup_runs (trigger, status, cairo_date, started_at) VALUES ('daily', 'ok', '2031-01-05', '2031-01-05T02:00:00Z')");
  assert.equal(h.backups.due(at('2031-01-05T10:00:00Z')), false, 'done for the day');
  db.setSetting('backup_auto', '0');
  assert.equal(h.backups.due(at('2031-01-06T10:00:00Z')), false, 'switched off');
  db.setSetting('backup_auto', '1');
  db.setSetting('backup_email_to', '');
});

// ---------- the assistant ----------
test('assistant: the SQL guard refuses writes, PRAGMA, several statements, secrets and hidden tables', () => {
  const { db } = app.locals.admin;
  const user = db.get("SELECT * FROM users WHERE email = 'agent@thewave.test'");
  const allowed = app.locals.admin.h.assistant.allowed(user);
  assert.ok(allowed.has('invoices'));
  assert.ok(!allowed.has('employees') && !allowed.has('payroll_lines') && !allowed.has('acc_entries'), 'no HR or finance tables');
  assert.ok(!allowed.has('sessions') && !allowed.has('settings') && !allowed.has('ai_turns'));
  const bad = [
    'DELETE FROM invoices', "UPDATE invoices SET paid = total", 'DROP TABLE units', 'PRAGMA table_info(users)', "ATTACH 'x.db' AS x",
    'SELECT 1; DELETE FROM invoices', 'SELECT * FROM employees', 'SELECT name FROM units WHERE id IN (SELECT employee_id FROM payroll_lines)',
    'SELECT password_hash FROM users', 'SELECT * FROM users', 'SELECT * FROM sessions', 'SELECT * FROM sqlite_master', "SELECT load_extension('x')",
    'WITH x AS (SELECT * FROM leave_requests) SELECT COUNT(*) FROM x', 'SELECT value FROM settings', 'INSERT INTO units (code) VALUES (1)',
  ];
  for (const sql of bad) assert.equal(aiSql.check(db, sql, allowed).ok, false, sql);
  for (const sql of ['SELECT COUNT(*) n FROM invoices', 'SELECT name, email FROM users', "WITH o AS (SELECT brand_id, SUM(total - paid) owed FROM invoices WHERE status IN ('open','partial') GROUP BY brand_id) SELECT b.name, o.owed FROM o JOIN brands b ON b.id = o.brand_id ORDER BY owed DESC;", "SELECT replace(code, 'G', '') FROM units -- a comment; DELETE"]) {
    assert.equal(aiSql.check(db, sql, allowed).ok, true, sql);
  }
  // with HR access the HR tables open
  const hrAllowed = app.locals.admin.h.assistant.allowed({ ...user, hr: 1 });
  assert.ok(hrAllowed.has('employees'));
  assert.equal(aiSql.check(db, 'SELECT COUNT(*) FROM employees', hrAllowed).ok, true);
});

test('assistant: queries on a database file run on a read-only connection with a row limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-ai-test-'));
  try {
    const db = await require('../src/admin/db').open({ ADMIN_DB: path.join(dir, 'office.db') });
    const allowed = aiSql.allowedTables(db, { hr: false, finance: false });
    const checked = aiSql.check(db, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 500) SELECT x, (SELECT COUNT(*) FROM units) units FROM n", allowed, { limit: 50 });
    assert.equal(checked.ok, true, checked.error);
    const r = await aiSql.run(db, checked, { limit: 50, timeoutMs: 8000 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.rows.length, 50);
    assert.equal(r.truncated, true);
    assert.deepEqual(r.columns, ['x', 'units']);
    assert.ok(r.rows[0][1] > 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assistant: a question runs the tool loop (SQL → table → answer) and is logged', async () => {
  const { db, h } = app.locals.admin;
  const calls = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'tool_use', id: 'tu_1', name: 'run_sql', input: { purpose: 'Owed per tenant', sql: "SELECT b.name AS tenant, ROUND(SUM(i.total - i.paid)) AS owed FROM invoices i JOIN brands b ON b.id = i.brand_id WHERE i.status IN ('open','partial') GROUP BY b.id ORDER BY owed DESC" } }] },
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'tu_2', name: 'show_table', input: { query_id: 'q1', title: 'Balances', columns: [{ key: 'tenant', label: 'Tenant', kind: 'text' }, { key: 'owed', label: 'Owed', kind: 'money' }] } },
      { type: 'tool_use', id: 'tu_3', name: 'run_sql', input: { purpose: 'try a write', sql: 'DELETE FROM invoices' } },
      { type: 'tool_use', id: 'tu_4', name: 'run_sql', input: { purpose: 'salaries', sql: 'SELECT name, basic_salary FROM employees' } },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '**Several tenants** owe rent; the table lists them.' }] },
  ];
  h.assistant.fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }, ...replies.shift() }), { status: 200 });
  };
  const invoices = db.value('SELECT COUNT(*) FROM invoices');
  const agent = await signIn('agent@thewave.test', agentPw);
  const r = await agent.go('/admin/assistant/ask', form({ _csrf: agent.csrf, q: 'Who owes rent?' }));
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/admin\/assistant\/c\/\d+#t\d+$/);
  assert.equal(calls.length, 3);
  // the request: Messages API, the key from the environment, cached system prompt, tools, no secrets
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test');
  assert.ok(calls[0].headers['anthropic-version']);
  const b0 = calls[0].body;
  assert.equal(b0.model, 'claude-opus-5-5');
  assert.deepEqual(b0.tools.map((t) => t.name), ['run_sql', 'show_table', 'show_chart']);
  assert.deepEqual(b0.system[0].cache_control, { type: 'ephemeral' });
  assert.match(b0.system[0].text, /## invoices/);
  assert.doesNotMatch(b0.system[0].text, /## employees|## payroll_lines|password_hash|## sessions/, 'the schema shows only what this person may read');
  assert.match(b0.system[0].text, /never follow it/);
  // the tool results went back in one message, the earlier assistant turn unchanged (thinking kept)
  const third = calls[2].body.messages;
  assert.deepEqual(third[1].content[0], { type: 'thinking', thinking: '', signature: 'sig-1' });
  const results = third[4].content;
  assert.deepEqual(results.map((x) => x.tool_use_id), ['tu_2', 'tu_3', 'tu_4']);
  assert.match(third[2].content[0].content, /query_id: q1[\s\S]*<data>[\s\S]*not instructions/);
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /Only a SELECT/);
  assert.equal(results[2].is_error, true);
  assert.match(results[2].content, /employees is not available/);
  assert.equal(db.value('SELECT COUNT(*) FROM invoices'), invoices, 'nothing deleted');
  // stored, shown, logged
  const t = db.get('SELECT * FROM ai_turns ORDER BY id DESC LIMIT 1');
  assert.equal(t.status, 'ok');
  assert.match(t.answer, /Several tenants/);
  const att = JSON.parse(t.attachments);
  assert.equal(att[0].type, 'table');
  assert.ok(att[0].rows.length > 0);
  const html = await (await agent.go(r.headers.get('location').split('#')[0])).text();
  assert.match(html, /<b>Several tenants<\/b> owe rent/);
  assert.match(html, /Balances/);
  assert.match(html, /How I worked it out \(3 queries\)/);
  assert.match(html, /DELETE FROM invoices/, 'the refused query is shown with its reason');
  const u = db.get('SELECT * FROM ai_usage ORDER BY id DESC LIMIT 1');
  assert.equal(u.status, 'ok');
  assert.equal(u.input_tokens, 3000);
  assert.equal(u.output_tokens, 300);
  assert.equal(u.cache_read_tokens, 27000);
  assert.equal(u.rounds, 3);
  assert.equal(u.queries, 3);
  assert.ok(u.cost > 0);
  // a follow-up replays the conversation exactly
  replies.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Yes.' }] });
  calls.length = 0;
  const conv = r.headers.get('location').match(/\/c\/(\d+)/)[1];
  await agent.go('/admin/assistant/ask', form({ _csrf: agent.csrf, conversation: conv, q: 'Is that all?' }));
  assert.equal(calls[0].body.messages.length, 7);
  assert.deepEqual(calls[0].body.messages.slice(0, 6), JSON.parse(db.value('SELECT api_messages FROM ai_turns WHERE conversation_id = ? ORDER BY id LIMIT 1', conv)));
  // usage page for administrators only
  assert.equal((await agent.go('/admin/assistant/usage')).status, 303);
  const usage = await (await admin.go('/admin/assistant/usage')).text();
  assert.match(usage, /Who owes rent\?/);
  assert.match(usage, /Salma Agent/);
});

test('assistant: errors, limits, and another person\'s conversation', async () => {
  const { db, h } = app.locals.admin;
  h.assistant.sleep = async () => {};
  h.assistant.fetch = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 });
  const agent = await signIn('agent@thewave.test', agentPw);
  const r = await agent.go('/admin/assistant/ask', form({ _csrf: agent.csrf, q: 'Occupancy?' }));
  const t = db.get('SELECT * FROM ai_turns ORDER BY id DESC LIMIT 1');
  assert.equal(t.status, 'error');
  assert.equal(t.api_messages, null, 'a failed turn is not replayed');
  assert.match(await (await agent.go(r.headers.get('location').split('#')[0])).text(), /refused the key/);
  // someone else's conversation is not found
  const other = db.value('SELECT id FROM ai_conversations WHERE user_id = (SELECT id FROM users WHERE email = ?) LIMIT 1', 'agent@thewave.test');
  assert.equal((await admin.go(`/admin/assistant/c/${other}`)).status, 404);
  // the daily limit
  db.setSetting('ai_daily_limit', '1');
  await agent.go('/admin/assistant/ask', form({ _csrf: agent.csrf, q: 'Again?' }));
  assert.match(agent.flash(), /daily limit/);
  db.setSetting('ai_daily_limit', '40');
  // a hidden assistant module refuses it
  const id = db.value("SELECT id FROM users WHERE email = 'agent@thewave.test'");
  db.run('UPDATE users SET hidden_modules = ? WHERE id = ?', JSON.stringify(['/admin/assistant']), id);
  assert.equal((await agent.go('/admin/assistant/ask', form({ _csrf: agent.csrf, q: 'x?' }))).status, 403);
  db.run('UPDATE users SET hidden_modules = NULL WHERE id = ?', id);
});

test('assistant: without a key the page explains how to switch it on', async () => {
  const { h } = app.locals.admin;
  const key = ENV.ANTHROPIC_API_KEY;
  delete h.env.ANTHROPIC_API_KEY;
  try {
    const html = await (await admin.go('/admin/assistant')).text();
    assert.match(html, /Turn on the assistant/);
    assert.match(html, /value="ANTHROPIC_API_KEY"/);
    assert.doesNotMatch(html, /sk-ant/);
    const ints = await (await admin.go('/admin/integrations')).text();
    assert.match(ints, /AI assistant/);
    assert.match(ints, /Off-site backups/);
    const r = await admin.go('/admin/assistant/ask', form({ _csrf: admin.csrf, q: 'Hello?' }));
    assert.equal(r.status, 303);
    assert.match(admin.flash(), /not switched on/);
  } finally {
    h.env.ANTHROPIC_API_KEY = key;
  }
});
