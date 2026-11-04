'use strict';

// The work hub: tasks (who may create, see and change them, private ones), the board's moves (by
// drag and drop and without JavaScript), bulk actions with one shared approval note, the SLA job
// (reminder before, escalation after), asking the requester for more information (the clock stops),
// delegation while someone is away, @mentions that notify, recurring tasks, the due-today note,
// the h.approvals contract unchanged, every page in English and Arabic, and the sample data.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/admin/db');

let server;
let base;
let db;
let h;
let admin;
let manager;
let salma;
let omar;
let nour;
let viewer;

before(async () => {
  const app = createApp({ env: { SITE_URL: 'https://thewavemall.test', ADMIN_DB: ':memory:', ADMIN_JOBS: '0' }, mail: async () => ({ delivered: true }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await app.locals.admin.ready;
  db = app.locals.admin.db;
  h = app.locals.admin.h;
  base = `http://127.0.0.1:${server.address().port}`;
  const user = (name, email, role) => db.run("INSERT INTO users (name, email, role, password_hash, finance, hr, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))", name, email, role, hashPassword('long-enough-1'), role === 'admin' ? 1 : 0, role === 'admin' ? 1 : 0);
  user('Work Admin', 'wk-admin@thewave.test', 'admin');
  user('Karim Lead', 'wk-manager@thewave.test', 'manager');
  user('Salma Adel', 'wk-salma@thewave.test', 'agent');
  user('Omar Fathy', 'wk-omar@thewave.test', 'agent');
  user('Nour Hassan', 'wk-nour@thewave.test', 'agent');
  user('Vera Viewer', 'wk-viewer@thewave.test', 'viewer');
  admin = browser();
  manager = browser();
  salma = browser();
  omar = browser();
  nour = browser();
  viewer = browser();
  for (const [b, e] of [[admin, 'admin'], [manager, 'manager'], [salma, 'salma'], [omar, 'omar'], [nour, 'nour'], [viewer, 'viewer']]) {
    await b.signIn(`wk-${e}@thewave.test`, 'long-enough-1');
    b.user = db.get('SELECT * FROM users WHERE email = ?', `wk-${e}@thewave.test`);
  }
});
after(() => server.close());

function browser() {
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
  const b = {
    go,
    csrf: null,
    form: (p, data) => {
      const body = new URLSearchParams({ _csrf: b.csrf });
      for (const [k, v] of Object.entries(data)) for (const x of [].concat(v)) body.append(k, String(x));
      return go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    },
    json: (p, data) => go(p, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf': b.csrf }, body: JSON.stringify(data) }),
    async page(p) {
      const r = await go(p);
      return { status: r.status, html: await r.text() };
    },
    async signIn(email, password) {
      const html = await (await go('/admin/login')).text();
      const token = html.match(/name="_token" value="([^"]+)"/)[1];
      const r = await go('/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _token: token, email, password }).toString() });
      assert.equal(r.status, 303);
      const page = await (await go('/admin')).text();
      b.csrf = (page.match(/name="csrf" content="([^"]+)"/) || page.match(/name="_csrf" value="([^"]+)"/))[1];
    },
  };
  return b;
}
const lastTask = () => db.get('SELECT * FROM wk_tasks ORDER BY id DESC LIMIT 1');
const notes = (u, kind) => db.all('SELECT * FROM wk_notes WHERE user_id = ? AND kind = ?', u.user.id, kind);
const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();
const rule = (who, sla = 48) => h.approvals.setRule('other', { active: 1, min_amount: 0, steps: [].concat(who).map((w) => ({ who: w })), sla_hours: sla });

test('tasks: an agent creates one with people and a checklist; a viewer cannot; private ones stay private', async () => {
  const r = await salma.form('/admin/work/tasks', {
    title: 'Chase the Q4 service charge', body: 'Call them before Thursday.', priority: 'high', status: 'todo', due_date: '2030-01-15', due_time: '14:30',
    labels: 'collections, Tenants, collections', link: 'https://thewavemall.test/admin/leases/3', assignees: [omar.user.id], watchers: [nour.user.id], checklist: 'Call\nSend the statement\n\n',
  });
  assert.equal(r.status, 303);
  const t = lastTask();
  assert.match(r.headers.get('location'), new RegExp(`/admin/work/tasks/${t.id}$`));
  assert.equal(t.title, 'Chase the Q4 service charge');
  assert.equal(t.priority, 'high');
  assert.equal(t.labels, 'collections, Tenants', 'labels are trimmed and kept once');
  assert.equal(t.link, '/admin/leases/3', 'a full office address becomes a path');
  assert.equal(t.due_time, '14:30');
  assert.match(t.ref, /^TK-\d{4}-\d{4}$/);
  assert.deepEqual(db.all('SELECT user_id, role FROM wk_people WHERE task_id = ? ORDER BY role', t.id).map((p) => [p.user_id, p.role]), [[omar.user.id, 'assignee'], [nour.user.id, 'watcher']]);
  assert.deepEqual(db.all('SELECT text FROM wk_checks WHERE task_id = ? ORDER BY pos', t.id).map((c) => c.text), ['Call', 'Send the statement']);
  assert.equal(notes(omar, 'assigned').length, 1, 'the assignee is told');
  // a viewer reads but does not create
  const n0 = db.value('SELECT COUNT(*) FROM wk_tasks');
  await viewer.form('/admin/work/tasks', { title: 'Nope' });
  assert.equal(db.value('SELECT COUNT(*) FROM wk_tasks'), n0, 'a viewer cannot create');
  assert.equal((await viewer.page(`/admin/work/tasks/${t.id}`)).status, 200);
  // someone not on it cannot change it; the assignee can
  await nour.form(`/admin/work/tasks/${t.id}`, { title: 'Changed', priority: 'low' });
  assert.equal(db.get('SELECT title FROM wk_tasks WHERE id = ?', t.id).title, 'Chase the Q4 service charge', 'a watcher does not edit');
  const ok = await omar.form(`/admin/work/tasks/${t.id}`, { title: 'Chase the Q4 service charge (Kahwa)', priority: 'urgent', due_date: '2030-01-16', assignees: [omar.user.id], watchers: [nour.user.id] });
  assert.equal(ok.status, 303);
  assert.equal(db.get('SELECT priority FROM wk_tasks WHERE id = ?', t.id).priority, 'urgent');
  assert.ok(db.get("SELECT 1 FROM wk_events WHERE task_id = ? AND kind = 'priority'", t.id), 'the timeline records the change');
  // private: only the people on it and managers
  await salma.form('/admin/work/tasks', { title: 'Salary review notes', private: '1', assignees: [salma.user.id] });
  const p = lastTask();
  assert.equal(p.private, 1);
  assert.doesNotMatch((await omar.page(`/admin/work/tasks/${p.id}`)).html, /Salary review notes/);
  assert.equal((await manager.page(`/admin/work/tasks/${p.id}`)).status, 200);
  assert.doesNotMatch((await omar.page('/admin/work/list?who=all&state=any')).html, /Salary review notes/);
  // checklist: ticking moves a task still to do into progress
  const c = db.get('SELECT id FROM wk_checks WHERE task_id = ? ORDER BY pos LIMIT 1', t.id);
  await omar.form(`/admin/work/tasks/${t.id}/checks/${c.id}`, {});
  assert.ok(db.get('SELECT done_at FROM wk_checks WHERE id = ?', c.id).done_at);
  assert.equal(db.get('SELECT status FROM wk_tasks WHERE id = ?', t.id).status, 'doing');
});

test('the board: drag and drop (JSON) and the card menu (a form) move tasks; someone else cannot', async () => {
  const t = h.work.createTask({ title: 'Book the atrium screens', assignees: [omar.user.id], user: salma.user });
  const r = await omar.json(`/admin/work/tasks/${t.id}/move`, { status: 'waiting' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.label, 'Waiting');
  assert.equal(db.get('SELECT status FROM wk_tasks WHERE id = ?', t.id).status, 'waiting');
  assert.equal((await nour.json(`/admin/work/tasks/${t.id}/move`, { status: 'done' })).status, 403);
  assert.equal((await omar.json(`/admin/work/tasks/${t.id}/move`, { status: 'nowhere' })).status, 422);
  const f = await omar.form(`/admin/work/tasks/${t.id}/move`, { status: 'done', back: '/admin/work/board' });
  assert.equal(f.status, 303);
  assert.equal(f.headers.get('location'), '/admin/work/board');
  const done = db.get('SELECT * FROM wk_tasks WHERE id = ?', t.id);
  assert.equal(done.status, 'done');
  assert.equal(done.done_by, omar.user.id);
  assert.equal(notes(salma, 'done').filter((n) => n.task_id === t.id).length, 1, 'whoever created it hears it is done');
  const board = await omar.page('/admin/work/board?who=me');
  assert.equal(board.status, 200);
  assert.match(board.html, /data-wk-board/);
  assert.match(board.html, /\/admin\/work\.js\?v=/);
  assert.match(board.html, /Book the atrium screens/);
});

test('bulk: assign, priority and done for tasks; approve with one note, skipping what is not yours', async () => {
  rule('manager');
  const a1 = h.approvals.request({ kind: 'other', title: 'Bulk one', amount: 1000, user: salma.user });
  const a2 = h.approvals.request({ kind: 'other', title: 'Bulk two', amount: 2000, user: salma.user });
  const mine = h.approvals.request({ kind: 'other', title: 'Asked by the manager', amount: 3000, user: manager.user });
  const r = await manager.form('/admin/work/bulk', { ids: [`a:${a1.id}`, `a:${a2.id}`, `a:${mine.id}`], action: 'approve', note: 'Within budget.', back: '/admin/work/list' });
  assert.equal(r.status, 303);
  assert.equal(h.approvals.requestOf(a1.id).status, 'approved');
  assert.equal(h.approvals.requestOf(a2.id).status, 'approved');
  assert.equal(h.approvals.requestOf(mine.id).status, 'pending', 'nobody approves their own request');
  assert.equal(db.get("SELECT note FROM apr_events WHERE request_id = ? AND action = 'approved'", a1.id).note, 'Within budget.');
  const t1 = h.work.createTask({ title: 'Bulk task one', user: manager.user });
  const t2 = h.work.createTask({ title: 'Bulk task two', user: manager.user });
  await manager.form('/admin/work/bulk', { ids: [`t:${t1.id}`, `t:${t2.id}`], action: 'assign', user_id: nour.user.id });
  assert.equal(db.value("SELECT COUNT(*) FROM wk_people WHERE user_id = ? AND role = 'assignee' AND task_id IN (?, ?)", nour.user.id, t1.id, t2.id), 2);
  await manager.form('/admin/work/bulk', { ids: [`t:${t1.id}`], action: 'priority', priority: 'urgent' });
  assert.equal(db.get('SELECT priority FROM wk_tasks WHERE id = ?', t1.id).priority, 'urgent');
  await nour.form('/admin/work/bulk', { ids: [`t:${t1.id}`, `t:${t2.id}`], action: 'done' });
  assert.equal(db.value("SELECT COUNT(*) FROM wk_tasks WHERE status = 'done' AND id IN (?, ?)", t1.id, t2.id), 2, 'the assignee closes both');
});

test('the SLA: a reminder once before the deadline, escalation to managers then administrators after it', async () => {
  rule(`user:${nour.user.id}`, 10);
  const soon = h.approvals.request({ kind: 'other', title: 'Due soon', amount: 500, user: salma.user, at: hoursAgo(8) });
  const late = h.approvals.request({ kind: 'other', title: 'Late', amount: 500, user: salma.user, at: hoursAgo(13) });
  const later = h.approvals.request({ kind: 'other', title: 'Very late', amount: 500, user: salma.user, at: hoursAgo(25) });
  assert.equal(h.approvals.canDecide(manager.user, h.approvals.requestOf(late.id)), false, 'before escalation the step is Nour’s');
  assert.equal(h.approvals.priorityOf(h.approvals.requestOf(late.id)), 'urgent', 'overdue means urgent');
  h.approvals.runSla();
  assert.equal(db.value("SELECT COUNT(*) FROM apr_events WHERE request_id = ? AND action = 'reminded'", soon.id), 1);
  assert.equal(h.approvals.requestOf(soon.id).escalated, 0);
  assert.equal(h.approvals.requestOf(late.id).escalated, 1, 'late: to the managers');
  assert.equal(h.approvals.canDecide(manager.user, h.approvals.requestOf(late.id)), true);
  assert.equal(h.approvals.requestOf(later.id).escalated, 2, 'late by a whole SLA more: to the administrators too');
  assert.ok(notes(manager, 'escalated').some((n) => n.request_id === late.id));
  assert.ok(notes(nour, 'reminded').some((n) => n.request_id === soon.id));
  h.approvals.runSla();
  assert.equal(db.value("SELECT COUNT(*) FROM apr_events WHERE request_id = ? AND action = 'reminded'", soon.id), 1, 'never twice');
  assert.equal(db.value("SELECT COUNT(*) FROM apr_events WHERE request_id = ? AND action = 'escalated'", late.id), 1);
  // a manager hands the step to someone else: the clock and the escalation start again
  const r = await manager.form(`/admin/approvals/${late.id}/reassign`, { who: `user:${omar.user.id}` });
  assert.equal(r.status, 303);
  const moved = h.approvals.requestOf(late.id);
  assert.deepEqual(moved.steps, [{ who: `user:${omar.user.id}` }]);
  assert.equal(moved.escalated, 0);
  assert.ok(h.approvals.sla(moved).left > 9);
  assert.equal(h.approvals.canDecide(omar.user, moved), true);
});

test('asking for more information stops the clock until the requester answers', async () => {
  rule('manager', 48);
  const r = h.approvals.request({ kind: 'other', title: 'Printer contract', amount: 18900, user: salma.user, at: hoursAgo(40) });
  const leftBefore = h.approvals.sla(h.approvals.requestOf(r.id)).left;
  const noNote = await manager.form(`/admin/approvals/${r.id}/decide`, { decision: 'info', note: '' });
  assert.equal(noNote.status, 303);
  assert.equal(h.approvals.requestOf(r.id).info_at, null, 'a question needs words');
  h.approvals.askInfo(r.id, manager.user, 'Same supplier as last year?', { at: hoursAgo(39) });
  const waiting = h.approvals.requestOf(r.id);
  assert.ok(waiting.info_at);
  assert.equal(h.approvals.sla(waiting).paused, true);
  assert.equal(notes(salma, 'info_asked').filter((n) => n.request_id === r.id).length, 1);
  assert.throws(() => h.approvals.answerInfo(r.id, omar.user, 'Me?'), /Only the person who asked/);
  h.approvals.runSla();
  assert.equal(h.approvals.requestOf(r.id).escalated, 0, 'no escalation while the clock is stopped');
  // the requester answers on the page; 30 of the hours waited do not count
  db.run('UPDATE apr_requests SET info_at = ? WHERE id = ?', hoursAgo(39), r.id);
  const ans = await salma.form(`/admin/approvals/${r.id}/answer`, { answer: 'Yes, same price.' });
  assert.equal(ans.status, 303);
  const after = h.approvals.requestOf(r.id);
  assert.equal(after.info_at, null);
  assert.ok(after.paused_s >= 39 * 3600 - 60);
  assert.ok(Math.abs(h.approvals.sla(after).left - (leftBefore + 39)) < 0.2, 'the deadline moved by the time waited');
  assert.equal(notes(manager, 'info_given').filter((n) => n.request_id === r.id).length, 1);
  const page = await manager.page(`/admin/approvals/${r.id}`);
  assert.match(page.html, /Same supplier as last year\?/);
  assert.match(page.html, /Yes, same price\./);
});

test('delegation: while someone is away, the colleague covering decides for them', async () => {
  rule(`user:${omar.user.id}`);
  const r = h.approvals.request({ kind: 'other', title: 'Valet key cabinet', amount: 7000, user: salma.user });
  assert.equal(h.approvals.canDecide(nour.user, r), false);
  const today = h.work.today();
  const set = await omar.form('/admin/work/away', { user_id: omar.user.id, delegate_id: nour.user.id, starts: today, ends: h.M.addDays(today, 3), note: 'Leave' });
  assert.equal(set.status, 303);
  assert.equal(notes(nour, 'delegated').length, 1);
  const as = h.approvals.decideAs(nour.user, h.approvals.requestOf(r.id));
  assert.equal(as.onBehalf.id, omar.user.id);
  const day = await nour.page('/admin/work');
  assert.match(day.html, /Valet key cabinet/);
  assert.match(day.html, /covering for Omar Fathy/i);
  // Omar's tasks show in Nour's day too
  h.work.createTask({ title: 'Omar task while away', assignees: [omar.user.id], due_date: today, user: manager.user });
  assert.match((await nour.page('/admin/work')).html, /Omar task while away/);
  await nour.form(`/admin/approvals/${r.id}/decide`, { decision: 'approved', note: 'For Omar' });
  assert.equal(h.approvals.requestOf(r.id).status, 'approved');
  assert.equal(db.get("SELECT on_behalf FROM apr_events WHERE request_id = ? AND action = 'approved'", r.id).on_behalf, omar.user.id);
  // nobody covers for themselves; the dates must make sense
  assert.throws(() => h.approvals.delegate({ user_id: omar.user.id, delegate_id: omar.user.id, starts: today, ends: today }), /someone else/);
  assert.throws(() => h.approvals.delegate({ user_id: omar.user.id, delegate_id: nour.user.id, starts: today, ends: h.M.addDays(today, -1) }), /cannot be before/);
  // ended: no longer
  const w = db.get('SELECT id FROM wk_delegations WHERE user_id = ? AND cancelled_at IS NULL', omar.user.id);
  await omar.form(`/admin/work/away/${w.id}/end`, {});
  const r2 = h.approvals.request({ kind: 'other', title: 'After the leave', amount: 100, user: salma.user });
  assert.equal(h.approvals.canDecide(nour.user, r2), false);
});

test('mentions: the person mentioned is told (and emailed) and starts watching', async () => {
  const t = h.work.createTask({ title: 'Kids zone inspection', assignees: [nour.user.id], user: manager.user });
  const before = db.value('SELECT COUNT(*) FROM outbox WHERE to_addr = ?', 'wk-salma@thewave.test');
  const r = await nour.form(`/admin/work/tasks/${t.id}/comment`, { body: '@Salma Adel can you check the gates? @Karim please sign off.' });
  assert.equal(r.status, 303);
  assert.equal(notes(salma, 'mention').filter((n) => n.task_id === t.id).length, 1);
  assert.equal(notes(manager, 'mention').filter((n) => n.task_id === t.id).length, 1, 'a unique first name is enough');
  assert.equal(notes(manager, 'comment').filter((n) => n.task_id === t.id).length, 0, 'mentioned, not told twice');
  assert.ok(db.value('SELECT COUNT(*) FROM outbox WHERE to_addr = ?', 'wk-salma@thewave.test') > before, 'emailed');
  assert.ok(db.get("SELECT 1 FROM wk_people WHERE task_id = ? AND user_id = ? AND role = 'watcher'", t.id, salma.user.id));
  assert.deepEqual(h.work.mentioned('mail me at a@b.c, @nobody'), []);
  // the inbox: opening a notification marks it read and goes to the task
  const n = notes(salma, 'mention').find((x) => x.task_id === t.id);
  const open = await salma.go(`/admin/work/inbox/${n.id}`);
  assert.equal(open.status, 303);
  assert.equal(open.headers.get('location'), `/admin/work/tasks/${t.id}`);
  assert.ok(db.get('SELECT read_at FROM wk_notes WHERE id = ?', n.id).read_at);
  assert.equal((await omar.go(`/admin/work/inbox/${n.id}`)).status, 404, 'only your own notifications');
});

test('recurring tasks: one task on each date with its checklist; next date moves on; due-today note once', async () => {
  const today = h.work.today();
  const r = await manager.form('/admin/work/recurring', { title: 'Weekly fire extinguisher round', every: 'weekly', weekday: '0', assignee_id: nour.user.id, priority: 'high', labels: 'safety', checklist: 'Ground floor\nCar park', due_days: '0' });
  assert.equal(r.status, 303);
  const tpl = db.get('SELECT * FROM wk_templates ORDER BY id DESC LIMIT 1');
  assert.ok(tpl.next_on >= today);
  db.run('UPDATE wk_templates SET next_on = ? WHERE id = ?', today, tpl.id);
  assert.equal(h.work.runRecurring(today), 1);
  const t = lastTask();
  assert.equal(t.title, 'Weekly fire extinguisher round');
  assert.equal(t.template_id, tpl.id);
  assert.equal(t.due_date, today);
  assert.equal(db.value('SELECT COUNT(*) FROM wk_checks WHERE task_id = ?', t.id), 2);
  assert.equal(h.work.runRecurring(today), 0, 'once a date');
  const next = db.get('SELECT next_on FROM wk_templates WHERE id = ?', tpl.id).next_on;
  assert.ok(next > today && next <= h.M.addDays(today, 7));
  assert.equal(h.work.nextOn({ every: 'monthly', monthday: 31 }, '2027-02-10'), '2027-02-28', 'short months use their last day');
  assert.equal(h.work.nextOn({ every: 'monthly', monthday: 5 }, '2027-02-10'), '2027-03-05');
  assert.equal(h.work.nextOn({ every: 'weekly', weekday: 4 }, '2027-02-10'), '2027-02-12', 'Wednesday → Friday');
  // due today: the assignee hears once
  const n0 = notes(nour, 'due').length;
  h.work.runDue(today);
  h.work.runDue(today);
  assert.equal(notes(nour, 'due').length - n0, db.value("SELECT COUNT(*) FROM wk_tasks t JOIN wk_people p ON p.task_id = t.id AND p.user_id = ? AND p.role = 'assignee' WHERE t.due_date = ? AND t.status IN ('todo','doing','waiting')", nour.user.id, today));
});

test('the h.approvals contract is unchanged: needs, request, onDecision once, pendingFor, withdraw', () => {
  rule(['manager', 'admin']);
  const calls = [];
  h.approvals.onDecision('other', (r, d) => calls.push([r.id, d, r.payload]));
  assert.equal(h.approvals.needs('other', 1), true);
  const r = h.approvals.request({ kind: 'other', title: 'Contract check', amount: 10, entity: 'thing', entity_id: 99, payload: { x: 1 }, user: salma.user });
  assert.equal(h.approvals.pendingFor('thing', 99).id, r.id);
  h.approvals.decide(r.id, manager.user, 'approved');
  assert.equal(calls.filter((c) => c[0] === r.id).length, 0, 'not on the first of two steps');
  h.approvals.decide(r.id, admin.user, 'approved');
  assert.deepEqual(calls.filter((c) => c[0] === r.id), [[r.id, 'approved', { x: 1 }]]);
  assert.equal(h.approvals.pendingFor('thing', 99), null);
  const w = h.approvals.request({ kind: 'other', title: 'Withdraw me', amount: 10, user: salma.user });
  h.approvals.withdraw(w.id, salma.user);
  assert.equal(h.approvals.requestOf(w.id).status, 'withdrawn');
});

test('pages: every view in English and Arabic; the old approvals addresses still open; the badge counts', async () => {
  const t = lastTask();
  const a = db.get("SELECT id FROM apr_requests WHERE status = 'pending' ORDER BY id DESC LIMIT 1");
  const pages = ['/admin/work', '/admin/work/board', '/admin/work/board?type=approvals', '/admin/work/list', '/admin/work/list?state=any&due=late', '/admin/work/calendar', '/admin/work/calendar?m=2030-01', '/admin/work/team', '/admin/work/recurring', '/admin/work/inbox', '/admin/work/inbox?all=1', '/admin/work/away', '/admin/work/tasks/new', `/admin/work/tasks/${t.id}`, '/admin/approvals', '/admin/approvals/rules', `/admin/approvals/${a.id}`];
  for (const lang of ['en', 'ar']) {
    await admin.form('/admin/lang', { lang, back: '/admin' });
    for (const p of pages) {
      const r = await admin.page(p);
      assert.equal(r.status, 200, `${lang} ${p}`);
    }
  }
  await admin.form('/admin/lang', { lang: 'en', back: '/admin' });
  const work = await manager.page('/admin/work');
  assert.match(work.html, /href="\/admin\/work"/);
  assert.match(work.html, /Approvals &amp; tasks/);
  // a viewer sees the hub but no create buttons
  const v = await viewer.page('/admin/work');
  assert.equal(v.status, 200);
  assert.doesNotMatch(v.html, /href="\/admin\/work\/tasks\/new"/);
});

test('sample data: tasks in every column, a delegation, recurring tasks, escalated and waiting approvals; cleared cleanly', () => {
  const demo = require('../src/admin/demo-work');
  const purchasing = require('../src/admin/demo-purchasing');
  purchasing.load(db, admin.user, { h });
  demo.load(db, admin.user, { h });
  assert.ok(db.value('SELECT COUNT(*) FROM wk_tasks WHERE demo = 1') >= 35);
  for (const s of ['todo', 'doing', 'waiting', 'done', 'cancelled']) assert.ok(db.value('SELECT COUNT(*) FROM wk_tasks WHERE demo = 1 AND status = ?', s) > 0, s);
  assert.ok(db.value('SELECT COUNT(*) FROM wk_templates WHERE demo = 1') >= 3);
  assert.ok(db.value("SELECT COUNT(*) FROM wk_events e JOIN wk_tasks t ON t.id = e.task_id WHERE t.demo = 1 AND e.kind = 'comment'") > 5);
  assert.ok(db.value('SELECT COUNT(*) FROM apr_requests WHERE demo = 1 AND info_at IS NOT NULL') >= 1, 'one waits for an answer');
  assert.ok(db.value('SELECT COUNT(*) FROM apr_requests WHERE demo = 1 AND escalated > 0') >= 1, 'one is escalated');
  demo.load(db, admin.user, { h });
  assert.ok(db.value('SELECT COUNT(*) FROM wk_tasks WHERE demo = 1') < 60, 'loading twice adds nothing');
  demo.clear(db);
  purchasing.clear(db);
  assert.equal(db.value('SELECT COUNT(*) FROM wk_tasks WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM wk_notes WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM wk_templates WHERE demo = 1'), 0);
  assert.equal(db.value('SELECT COUNT(*) FROM wk_delegations WHERE demo = 1'), 0);
});
