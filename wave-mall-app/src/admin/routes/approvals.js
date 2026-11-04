'use strict';

// Approvals (/admin/approvals): one place where money decisions wait for the right person.
// A rule per kind of request (write-off, refund, purchase, salary advance, advertising discount,
// other) says from which amount it needs approval, in one or two steps, and who decides each step
// (a manager, an administrator, finance, or a named person). A request moves step by step:
//
//   pending (step 1 → step 2) → approved      the module that asked carries it out
//                             → rejected      with the reason
//                             → withdrawn     by the person who asked
//
// Every step, comment and decision is in the request's history; the people who can decide are
// emailed and see a badge in the sidebar. Other modules use it through h.approvals:
//
//   h.approvals.needs(kind, amount)                → true when a rule asks for approval
//   h.approvals.request({ kind, title, amount, entity, entity_id, link, payload, user, demo })
//                                                  → the request (pending; the approvers are told)
//   h.approvals.onDecision(kind, (request, decision, user) => {})
//                                                  → called once, on the final decision
//                                                    ('approved' or 'rejected'); request.payload is
//                                                    the payload given, parsed. Runs inside the
//                                                    decision's transaction: throwing undoes it.
//   h.approvals.onWithdraw(kind, (request, user) => {})   → the requester withdrew it
//   h.approvals.pendingFor(entity, entity_id)      → the pending request for a record, or null
//   h.approvals.describe(kind, (request) => text)  → how a kind's requests are named on screen
//   h.approvals.details(kind, (request) => html)   → extra facts on the request's page
//   h.approvals.relink(id, { entity, entity_id, link })  → point a request at the record it made
// A module that loads before this one queues its handlers: (h.approvalHooks = h.approvalHooks || []).push((A) => …).

const i18n = require('../i18n');

const { t: tr, tn } = i18n;

const SCHEMA = `
  CREATE TABLE apr_rules (
    kind TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1, min_amount REAL NOT NULL DEFAULT 0, steps TEXT NOT NULL DEFAULT '[]',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_at TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE apr_requests (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
    entity TEXT, entity_id INTEGER, link TEXT, payload TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'pending',
    step INTEGER NOT NULL DEFAULT 0, steps TEXT NOT NULL, requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_at TEXT, demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX apr_requests_status ON apr_requests(status, kind);
  CREATE INDEX apr_requests_entity ON apr_requests(entity, entity_id);
  CREATE TABLE apr_events (
    id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES apr_requests(id) ON DELETE CASCADE, action TEXT NOT NULL,
    step INTEGER, note TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, at TEXT NOT NULL
  );
  CREATE INDEX apr_events_request ON apr_events(request_id, id);
`;

const KINDS = {
  writeoff: 'apr|Write-off', refund: 'apr|Refund', purchase: 'apr|Purchase', advance: 'apr|Salary advance',
  media_discount: 'apr|Advertising discount', other: 'apr|Other request',
};
const STATUS = {
  pending: ['apr|Waiting', 'amber'], approved: ['apr|Approved', 'ok'], rejected: ['apr|Rejected', 'rose'], withdrawn: ['apr|Withdrawn', 'mute'],
};
const WHO = { manager: 'apr|A manager', admin: 'apr|An administrator', finance: 'apr|Finance' };
const ACTIONS = {
  submitted: 'apr|Asked for approval', approved: 'apr|Approved', rejected: 'apr|Rejected', withdrawn: 'apr|Withdrew the request', comment: 'apr|Commented',
};

module.exports = function approvals(router, h) {
  const { db, ui, M } = h;
  db.ensure('approvals-1', SCHEMA);
  (h.auditTyped = h.auditTyped || []).push("SELECT title, note FROM apr_requests WHERE kind = 'other'", 'SELECT note FROM apr_events WHERE note IS NOT NULL');
  const esc = ui.esc;
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const allowed = (u, min) => h.auth.allowed(u, min);
  const isOverseer = (u) => !!u && (allowed(u, 'manager') || !!u.finance);
  const badge = (s) => ui.badge(s, tr((STATUS[s] || [s])[0]), (STATUS[s] || [])[1]);
  const kindLabel = (k) => tr(KINDS[k] || 'apr|Other request');
  const parse = (s, fb) => {
    try {
      return s ? JSON.parse(s) : fb;
    } catch {
      return fb;
    }
  };

  // ---------- rules ----------
  const cleanSteps = (steps) => (Array.isArray(steps) ? steps : []).filter((s) => s && typeof s.who === 'string' && (WHO[s.who] || /^user:\d+$/.test(s.who))).slice(0, 2);
  const ruleOf = (kind) => {
    const r = db.get('SELECT * FROM apr_rules WHERE kind = ?', kind);
    return r ? { ...r, steps: cleanSteps(parse(r.steps, [])) } : null;
  };
  function setRule(kind, { active = 1, min_amount = 0, steps = [{ who: 'manager' }], user = null, demo = 0 } = {}) {
    if (!KINDS[kind]) throw new Error('Unknown approval kind');
    const s = cleanSteps(steps);
    db.run(`INSERT INTO apr_rules (kind, active, min_amount, steps, updated_by, updated_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET active = excluded.active, min_amount = excluded.min_amount, steps = excluded.steps, updated_by = excluded.updated_by, updated_at = excluded.updated_at, demo = excluded.demo`,
    kind, active ? 1 : 0, Math.max(0, r2(min_amount)), JSON.stringify(s.length ? s : [{ who: 'manager' }]), user ? user.id : null, now(), demo ? 1 : 0);
    return ruleOf(kind);
  }
  function needs(kind, amount) {
    const r = ruleOf(kind);
    return !!(r && r.active && r.steps.length && r2(amount) >= r2(r.min_amount));
  }

  // ---------- requests ----------
  const handlers = {};
  const withdrawers = {};
  const describers = {};
  const detailers = {};
  const hydrate = (r) => (r ? { ...r, payload: parse(r.payload, null), steps: cleanSteps(parse(r.steps, [])) } : null);
  const requestOf = (id) => hydrate(db.get(`SELECT r.*, u.name requester, u.email requester_email, u.lang requester_lang, d.name decider
    FROM apr_requests r LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by WHERE r.id = ?`, id));
  const titleOf = (r) => {
    if (describers[r.kind]) {
      try {
        const s = describers[r.kind](r);
        if (s) return s;
      } catch { /* fall back to the stored title */ }
    }
    return r.title;
  };
  const event = (id, action, step, note, user, at = now()) => db.run('INSERT INTO apr_events (request_id, action, step, note, user_id, at) VALUES (?, ?, ?, ?, ?, ?)', id, action, step, note || null, user ? user.id : null, at);
  const approvedBy = (id) => db.all("SELECT user_id FROM apr_events WHERE request_id = ? AND action = 'approved' AND user_id IS NOT NULL", id).map((e) => e.user_id);

  // May this person decide the request's current step? Administrators always may; nobody else
  // decides their own request, or two steps of the same request.
  function canDecide(user, r) {
    if (!user || !r || r.status !== 'pending') return false;
    const step = r.steps[r.step];
    if (!step) return false;
    if (user.role === 'admin') return true;
    if (r.requested_by === user.id) return false;
    if (approvedBy(r.id).includes(user.id)) return false;
    return fits(user, step.who);
  }
  const fits = (user, who) => {
    if (who === 'manager') return allowed(user, 'manager');
    if (who === 'finance') return !!user.finance || user.role === 'admin';
    if (who === 'admin') return user.role === 'admin';
    if (/^user:\d+$/.test(who)) return Number(who.slice(5)) === user.id;
    return false;
  };
  const whoLabel = (who) => {
    if (WHO[who]) return tr(WHO[who]);
    const u = /^user:\d+$/.test(who) ? db.get('SELECT name FROM users WHERE id = ?', Number(who.slice(5))) : null;
    return u ? u.name : tr('apr|Someone no longer on the team');
  };
  // the people to tell about a step (with an email, active, not the requester)
  function approversFor(r) {
    const step = r.steps[r.step];
    if (!step) return [];
    return db.all('SELECT * FROM users WHERE active = 1 AND email IS NOT NULL').filter((u) => u.id !== r.requested_by && (fits(u, step.who) || (u.role === 'admin' && step.who === 'admin')));
  }

  const site = () => String((h.env && h.env.SITE_URL) || '').replace(/\/$/, '');
  function mailTo(u, subjectKey, bodyKey, params, r) {
    if (!h.mail || r.demo || !u || !u.email) return;
    const lang = u.lang === 'ar' ? 'ar' : 'en';
    i18n.run(lang, () => {
      const p = { ...params, title: titleOf(r), ref: r.ref, kind: kindLabel(r.kind), amount: ui.money(r.amount) };
      const url = `${site()}/admin/approvals/${r.id}`;
      const text = `${tr(bodyKey, p)}\n\n${url}`;
      const html = `<p>${esc(tr(bodyKey, p))}</p><p><a href="${esc(url)}">${esc(tr('apr|Open the request'))}</a></p>`;
      try {
        h.mail.send({ to: u.email, subject: tr(subjectKey, p), text, html, lang, related: { entity: 'approval', id: r.id } });
      } catch (e) {
        console.error('[approvals] mail not sent:', e.message);
      }
    });
  }
  const notifyApprovers = (r) => {
    for (const u of approversFor(r)) mailTo(u, 'apr|Approval needed: {title}', 'apr|{name} asks you to approve {title} ({kind}, {amount}). Request {ref}, step {step} of {steps}.', { name: r.requester || '—', step: r.step + 1, steps: r.steps.length }, r);
  };
  const tellRequester = (r, decision, by, note) => {
    if (!r.requested_by) return;
    const u = db.get('SELECT * FROM users WHERE id = ? AND active = 1', r.requested_by);
    if (!u || (by && u.id === by.id)) return;
    mailTo(u, decision === 'approved' ? 'apr|Approved: {title}' : 'apr|Not approved: {title}',
      decision === 'approved' ? 'apr|{name} approved your request {ref}: {title}.' : 'apr|{name} did not approve your request {ref}: {title}. Reason: {note}', { name: by ? by.name : '—', note: note || '—' }, r);
  };

  function request({ kind, title, amount = 0, entity = null, entity_id = null, link = null, payload = null, note = null, user = null, demo = 0, at = null }) {
    if (!KINDS[kind]) throw new Error(`Unknown approval kind: ${kind}`);
    const rule = ruleOf(kind);
    const steps = rule && rule.steps.length ? rule.steps : [{ who: 'manager' }];
    const t = at || now();
    const id = db.tx(() => {
      const rid = Number(db.run(`INSERT INTO apr_requests (ref, kind, title, amount, entity, entity_id, link, payload, note, status, step, steps, requested_by, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
      db.nextRef('apr_requests', 'AP', 4, true), kind, String(title || kindLabel(kind)).slice(0, 200), r2(amount), entity, entity_id === null || entity_id === undefined ? null : Number(entity_id),
      link, payload === null || payload === undefined ? null : JSON.stringify(payload), note ? String(note).slice(0, 1000) : null, JSON.stringify(steps), user ? user.id : null, demo ? 1 : 0, t, t).lastInsertRowid);
      event(rid, 'submitted', 0, note, user, t);
      return rid;
    });
    const r = requestOf(id);
    notifyApprovers(r);
    return r;
  }

  // The decision on the current step. Throws (with an apr| message) when it is not allowed.
  function decide(id, user, decision, note = null, { at = null } = {}) {
    const r = requestOf(id);
    if (!r) throw new Error('apr|There is no such request.');
    if (r.status !== 'pending') throw new Error('apr|This request has already been decided.');
    if (!['approved', 'rejected'].includes(decision)) throw new Error('apr|Choose approve or reject.');
    if (!canDecide(user, r)) throw new Error('apr|This step is not yours to decide.');
    if (decision === 'rejected' && !String(note || '').trim()) throw new Error('apr|Say why it is not approved.');
    const t = at || now();
    let final = null;
    db.tx(() => {
      event(r.id, decision, r.step, note, user, t);
      if (decision === 'rejected') final = 'rejected';
      else if (r.step + 1 < r.steps.length) db.run('UPDATE apr_requests SET step = step + 1, updated_at = ? WHERE id = ?', t, r.id);
      else final = 'approved';
      if (final) {
        db.run('UPDATE apr_requests SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?', final, user ? user.id : null, t, t, r.id);
        for (const fn of handlers[r.kind] || []) fn(requestOf(r.id), final, user);
      }
    });
    const after = requestOf(r.id);
    if (final) tellRequester(after, final, user, note);
    else notifyApprovers(after);
    return after;
  }
  function withdraw(id, user, note = null) {
    const r = requestOf(id);
    if (!r || r.status !== 'pending') throw new Error('apr|Only a request still waiting can be withdrawn.');
    if (!user || (user.id !== r.requested_by && user.role !== 'admin')) throw new Error('apr|Only the person who asked can withdraw it.');
    db.tx(() => {
      const t = now();
      event(r.id, 'withdrawn', r.step, note, user, t);
      db.run("UPDATE apr_requests SET status = 'withdrawn', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?", user.id, t, t, r.id);
      for (const fn of withdrawers[r.kind] || []) fn(requestOf(r.id), user);
    });
    return requestOf(r.id);
  }
  const pendingFor = (entity, entityId) => hydrate(db.get("SELECT * FROM apr_requests WHERE entity = ? AND entity_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", entity, Number(entityId)));
  const latestFor = (entity, entityId) => hydrate(db.get('SELECT * FROM apr_requests WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1', entity, Number(entityId)));
  // what is waiting for this person
  const waitingFor = (user) => db.all("SELECT * FROM apr_requests WHERE status = 'pending' ORDER BY created_at").map(hydrate).filter((r) => canDecide(user, r));

  h.approvals = {
    KINDS, needs, request, decide, withdraw, pendingFor, latestFor, waitingFor, canDecide, ruleOf, setRule, requestOf, titleOf,
    onDecision: (kind, fn) => { (handlers[kind] = handlers[kind] || []).push(fn); },
    onWithdraw: (kind, fn) => { (withdrawers[kind] = withdrawers[kind] || []).push(fn); },
    describe: (kind, fn) => { describers[kind] = fn; },
    details: (kind, fn) => { detailers[kind] = fn; },
    relink: (id, { entity = null, entity_id = null, link = null } = {}) => db.run('UPDATE apr_requests SET entity = ?, entity_id = ?, link = ?, updated_at = ? WHERE id = ?', entity, entity_id, link, now(), id),
  };
  h.count('approve', (user) => waitingFor(user).length);
  // modules loaded before this one queued their handlers: (h.approvalHooks = h.approvalHooks || []).push((A) => …)
  const queued = Array.isArray(h.approvalHooks) ? h.approvalHooks : [];
  h.approvalHooks = { push: (fn) => fn(h.approvals) };
  for (const fn of queued) fn(h.approvals);

  // ---------- pages ----------
  const canSee = (user, r) => isOverseer(user) || r.requested_by === user.id || r.steps.some((s) => fits(user, s.who)) || db.value('SELECT COUNT(*) FROM apr_events WHERE request_id = ? AND user_id = ?', r.id, user.id) > 0;
  const stepText = (r) => (r.status === 'pending' ? tr('apr|Step {n} of {total} · {who}', { n: r.step + 1, total: r.steps.length, who: whoLabel((r.steps[r.step] || {}).who) }) : '');
  const hours = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / 3600000);
  const waited = (iso) => {
    const hrs = hours(iso, now());
    return hrs < 24 ? tn(Math.max(1, Math.round(hrs)), 'apr|{n} hour', 'apr|{n} hours') : tn(Math.round(hrs / 24), 'apr|{n} day', 'apr|{n} days');
  };

  router.get('/approvals', (req, res) => {
    const u = req.user;
    const q = req.query;
    const over = isOverseer(u);
    const todo = waitingFor(u);
    const tab = ['todo', 'mine', 'all'].includes(q.tab) && (q.tab !== 'all' || over) ? q.tab : todo.length || !db.value('SELECT COUNT(*) FROM apr_requests WHERE requested_by = ?', u.id) ? 'todo' : 'mine';
    const status = STATUS[q.status] || q.status === 'any' ? q.status : tab === 'todo' ? 'pending' : 'any';
    const kind = KINDS[q.kind] ? q.kind : '';
    const f = h.listFilters(req, { cols: { date: 'r.created_at' }, dateLabel: tr('apr|Asked on'), keep: ['tab', 'status', 'kind'] });
    let rows;
    if (tab === 'todo') rows = todo.filter((r) => (!kind || r.kind === kind) && (!f.from || r.created_at.slice(0, 10) >= f.from) && (!f.to || r.created_at.slice(0, 10) <= f.to));
    else {
      const where = [...f.where];
      const args = [...f.args];
      if (tab === 'mine') { where.push('r.requested_by = ?'); args.push(u.id); }
      if (status !== 'any') { where.push('r.status = ?'); args.push(status); }
      if (kind) { where.push('r.kind = ?'); args.push(kind); }
      rows = db.all(`SELECT r.* FROM apr_requests r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.status = 'pending' DESC, r.created_at DESC LIMIT 500`, ...args).map(hydrate);
    }
    const names = Object.fromEntries(db.all('SELECT id, name FROM users').map((x) => [x.id, x.name]));
    const mine = db.value("SELECT COUNT(*) FROM apr_requests WHERE requested_by = ? AND status = 'pending'", u.id);
    const month = M.today().slice(0, 7);
    const decidedRows = db.all("SELECT created_at, decided_at FROM apr_requests WHERE status IN ('approved','rejected') AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 100");
    const avg = decidedRows.length ? decidedRows.reduce((s, x) => s + hours(x.created_at, x.decided_at), 0) / decidedRows.length : null;
    const kpis = [
      ui.kpi({ label: tr('apr|Waiting for you'), value: String(todo.length), tone: todo.length ? 'kpi--alert' : '', href: '/admin/approvals?tab=todo', sub: todo.length ? esc(tr('apr|{amount} in total', { amount: ui.money(r2(todo.reduce((s, r) => s + r.amount, 0)), { compact: true }) })) : '' }),
      ui.kpi({ label: tr('apr|Your requests waiting'), value: String(mine), href: '/admin/approvals?tab=mine&status=pending' }),
      ui.kpi({ label: tr('apr|Approved this month'), value: ui.money(r2(db.value("SELECT COALESCE(SUM(amount), 0) FROM apr_requests WHERE status = 'approved' AND substr(decided_at, 1, 7) = ?", month)), { compact: true }), sub: esc(tn(db.value("SELECT COUNT(*) FROM apr_requests WHERE status = 'approved' AND substr(decided_at, 1, 7) = ?", month), 'apr|{n} request', 'apr|{n} requests')) }),
      ui.kpi({ label: tr('apr|Average time to decide'), value: avg === null ? '—' : esc(avg < 24 ? tn(Math.max(1, Math.round(avg)), 'apr|{n} hour', 'apr|{n} hours') : tn(Math.round(avg / 24), 'apr|{n} day', 'apr|{n} days')) }),
    ].join('');
    const link = (o) => `/admin/approvals?${new URLSearchParams(Object.entries({ tab, status: q.status || '', kind, from: f.from, to: f.to, ...o }).filter(([, v]) => v)).toString()}`;
    const tabs = `<nav class="tabs">${[['todo', tr('apr|To approve'), todo.length], ['mine', tr('apr|My requests'), mine], ...(over ? [['all', tr('apr|All requests'), null]] : [])]
      .map(([k, l, n]) => `<a class="tab${tab === k ? ' is-on' : ''}" href="/admin/approvals?tab=${k}">${esc(l)}${n ? ` <b class="nav__count">${n}</b>` : ''}</a>`).join('')}</nav>`;
    const sub = tab === 'todo' ? '' : `<nav class="tabs tabs--sub">${['pending', 'approved', 'rejected', 'withdrawn', 'any'].map((s) => `<a class="tab${status === s ? ' is-on' : ''}" href="${esc(link({ status: s }))}">${esc(s === 'any' ? tr('All') : tr(STATUS[s][0]))}</a>`).join('')}</nav>`;
    const kindSel = `<form method="get" action="/admin/approvals" class="filters apr-kinds"><input type="hidden" name="tab" value="${esc(tab)}">${q.status ? `<input type="hidden" name="status" value="${esc(q.status)}">` : ''}${ui.select('kind', tr('apr|Kind'), Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, tr(v)])), kind, { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}</form>`;
    const table = ui.table([
      { label: tr('apr|Request'), sort: (r) => titleOf(r), render: (r) => `<b>${esc(titleOf(r))}</b><small class="sub"><bdi>${esc(r.ref)}</bdi> · ${esc(kindLabel(r.kind))}</small>` },
      { label: tr('apr|Amount'), num: true, sort: (r) => r.amount, render: (r) => (r.amount ? ui.money(r.amount, { cur: false }) : '—') },
      { label: tr('apr|Asked by'), sort: (r) => names[r.requested_by] || '', render: (r) => `${esc(names[r.requested_by] || '—')}<small class="sub">${esc(ui.date(r.created_at))}</small>` },
      { label: tr('apr|Where it is'), sort: (r) => r.status + r.step, render: (r) => `${badge(r.status)}${r.status === 'pending' ? `<small class="sub">${esc(stepText(r))}</small>` : r.decided_at ? `<small class="sub">${esc(ui.date(r.decided_at))}</small>` : ''}` },
      { label: tr('apr|Waiting'), sort: (r) => (r.status === 'pending' ? r.created_at : ''), render: (r) => (r.status === 'pending' ? esc(waited(r.created_at)) : '—') },
    ], rows, { empty: esc(tab === 'todo' ? tr('apr|Nothing is waiting for you.') : tr('apr|No requests here.')), href: (r) => `/admin/approvals/${r.id}` });
    const actions = [
      ui.btn(esc(tr('apr|New request')), { href: '/admin/approvals/new', cls: 'btn--primary btn--sm', ic: 'plus' }),
      ...(allowed(u, 'manager') ? [ui.btn(esc(tr('apr|Approval rules')), { href: '/admin/approvals/rules', cls: 'btn--ghost btn--sm', ic: 'gear' })] : []),
    ].join('');
    h.page(req, res, {
      title: tr('apr|Approvals'), active: '/admin/approvals', actions, wide: true,
      body: `<div class="kpis kpis--4">${kpis}</div>${tabs}${sub}<div class="apr-bar">${f.html}${kindSel}</div>${ui.card(tab === 'todo' ? tr('apr|To approve') : tab === 'mine' ? tr('apr|My requests') : tr('apr|All requests'), table, { sub: esc(tn(rows.length, 'apr|{n} request', 'apr|{n} requests')) })}`,
    });
  });

  // ---------- rules ----------
  const whoOptions = () => [
    ...Object.entries(WHO).map(([k, v]) => [k, tr(v)]),
    ...db.all('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').map((x) => [`user:${x.id}`, x.name]),
  ];
  router.get('/approvals/rules', h.R('manager'), (req, res) => {
    const csrf = req.session.csrf;
    const opts = whoOptions();
    const rows = Object.entries(KINDS).map(([k, label]) => {
      const r = ruleOf(k) || { active: 0, min_amount: 0, steps: [{ who: 'manager' }] };
      const s1 = (r.steps[0] || { who: 'manager' }).who;
      const s2 = r.steps[1] ? r.steps[1].who : '';
      return `<fieldset class="apr-rule${r.active ? ' is-on' : ''}"><legend><label class="check"><input type="checkbox" name="${k}_active" value="1"${r.active ? ' checked' : ''}> <b>${esc(tr(label))}</b></label></legend>
        <div class="fields">
          ${ui.input(`${k}_min`, tr('apr|Needs approval from (amount)'), r.min_amount || 0, { type: 'number', min: 0, step: '0.01' })}
          ${ui.select(`${k}_who1`, tr('apr|Step 1 · decided by'), opts, s1)}
          ${ui.select(`${k}_who2`, tr('apr|Step 2 · decided by'), opts, s2, { blank: tr('apr|No second step') })}
        </div></fieldset>`;
    }).join('');
    const body = `${ui.form('/admin/approvals/rules', csrf, `<p class="muted small">${esc(tr('apr|A kind that is switched off, or below its amount, goes ahead without approval. Administrators can always decide; nobody else decides their own request or two steps of the same one.'))}</p><div class="apr-rules">${rows}</div>${ui.btn(esc(tr('apr|Save the rules')), { cls: 'btn--primary' })}`, { cls: 'stack' })}`;
    h.page(req, res, { title: tr('apr|Approval rules'), crumbs: [['/admin/approvals', tr('apr|Approvals')], [null, tr('apr|Rules')]], active: '/admin/approvals', body: ui.card(tr('apr|Who approves what'), body) });
  });
  router.post('/approvals/rules', h.R('manager'), (req, res) => {
    const b = req.body;
    const valid = new Set(whoOptions().map((o) => o[0]));
    for (const k of Object.keys(KINDS)) {
      const steps = [b[`${k}_who1`], b[`${k}_who2`]].filter((w) => w && valid.has(String(w))).map((w) => ({ who: String(w) }));
      setRule(k, { active: b[`${k}_active`] === '1', min_amount: h.numv(b[`${k}_min`]) || 0, steps: steps.length ? steps : [{ who: 'manager' }], user: req.user });
    }
    h.log(req, 'Changed the approval rules', 'settings', null, Object.keys(KINDS).filter((k) => b[`${k}_active`] === '1').join(', '));
    h.back(req, res, '/admin/approvals/rules', 'ok', tr('apr|Approval rules saved.'));
  });

  // ---------- a request of any other kind ----------
  router.get('/approvals/new', (req, res) => {
    if (!allowed(req.user, 'agent')) return h.auth.denied(req, res);
    const csrf = req.session.csrf;
    const r = ruleOf('other');
    const form = ui.form('/admin/approvals/new', csrf, `<div class="fields">
      ${ui.input('title', tr('apr|What needs approval'), '', { required: true, cls: 'span-all', placeholder: tr('apr|e.g. Replace the food court chairs') })}
      ${ui.input('amount', tr('apr|Amount'), '', { type: 'number', min: 0, step: '0.01' })}
      ${ui.input('link', tr('apr|Link to the record (optional)'), '')}
      ${ui.textarea('note', tr('apr|Why'), '', { rows: 4, cls: 'span-all' })}
    </div><p class="muted small">${esc(r && r.active ? tr('apr|Decided by: {who}.', { who: r.steps.map((s) => whoLabel(s.who)).join(' → ') }) : tr('apr|Decided by: {who}.', { who: tr(WHO.manager) }))}</p>${ui.btn(esc(tr('apr|Send for approval')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    h.page(req, res, { title: tr('apr|New request'), crumbs: [['/admin/approvals', tr('apr|Approvals')], [null, tr('apr|New request')]], active: '/admin/approvals', body: `<div class="grid grid--side"><div>${ui.card(tr('apr|Ask for approval'), form)}</div><div></div></div>` });
  });
  router.post('/approvals/new', (req, res) => {
    if (!allowed(req.user, 'agent')) return h.auth.denied(req, res);
    const title = h.str(req.body.title, 200);
    if (!title) return h.back(req, res, '/admin/approvals/new', 'error', tr('apr|Say what needs approval.'));
    const link = h.str(req.body.link, 300);
    const r = request({ kind: 'other', title, amount: Math.max(0, h.numv(req.body.amount) || 0), link: /^\/admin\//.test(link) && !link.startsWith('//') ? link : null, note: h.str(req.body.note, 1000) || null, user: req.user });
    h.log(req, 'Asked for approval', 'approval', r.id, `${r.ref} · ${title}`);
    h.back(req, res, `/admin/approvals/${r.id}`, 'ok', tr('apr|Sent for approval. The approvers have been told.'));
  });

  // ---------- one request ----------
  router.get('/approvals/:id', (req, res, next) => {
    const r = requestOf(h.int(req.params.id));
    if (!r) return next();
    const u = req.user;
    if (!canSee(u, r)) return h.auth.denied(req, res);
    const csrf = req.session.csrf;
    const events = db.all('SELECT e.*, u.name FROM apr_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.request_id = ? ORDER BY e.at, e.id', r.id);
    const mayDecide = canDecide(u, r);
    // the steps, each with who decided it
    const stepItems = r.steps.map((s, i) => {
      const ev = events.filter((e) => e.step === i && ['approved', 'rejected'].includes(e.action)).at(-1);
      const state = ev ? ev.action : r.status === 'pending' && i === r.step ? 'current' : r.status === 'pending' && i > r.step ? 'later' : 'skipped';
      const tone = { approved: 'ok', rejected: 'rose', current: 'amber', later: 'mute', skipped: 'mute' }[state];
      const label = { approved: tr('apr|Approved'), rejected: tr('apr|Rejected'), current: tr('apr|Waiting'), later: tr('apr|Next'), skipped: '—' }[state];
      return `<li class="apr-step apr-step--${state}"><span class="apr-step__n">${i + 1}</span><span class="what"><b>${esc(whoLabel(s.who))}</b><small>${ev ? esc(`${ev.name || '—'} · ${ui.dt(ev.at)}`) : state === 'current' ? esc(tr('apr|Waiting {time}', { time: waited(events.filter((e) => e.action !== 'comment').at(-1).at) })) : ''}</small></span>${ui.badge(state, label, tone)}</li>`;
    }).join('');
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('apr|Kind'))}</dt><dd>${esc(kindLabel(r.kind))}</dd></div>
      <div><dt>${esc(tr('apr|Amount'))}</dt><dd><b class="apr-amt">${r.amount ? ui.money(r.amount) : '—'}</b></dd></div>
      <div><dt>${esc(tr('apr|Asked by'))}</dt><dd>${esc(r.requester || '—')} · ${esc(ui.dt(r.created_at))}</dd></div>
      ${r.link ? `<div><dt>${esc(tr('apr|Record'))}</dt><dd><a href="${esc(r.link)}">${esc(tr('apr|Open the record'))}</a></dd></div>` : ''}
      ${r.note ? `<div><dt>${esc(tr('apr|Why'))}</dt><dd>${esc(r.note)}</dd></div>` : ''}
      ${r.decided_at ? `<div><dt>${esc(r.status === 'withdrawn' ? tr('apr|Withdrawn') : tr('apr|Decided'))}</dt><dd>${esc(r.decider || '—')} · ${esc(ui.dt(r.decided_at))}</dd></div>` : ''}
    </dl>`;
    let extra = '';
    if (detailers[r.kind]) {
      try {
        extra = detailers[r.kind](r) || '';
      } catch (e) {
        extra = '';
      }
    }
    const history = `<ul class="feed apr-feed">${events.map((e) => `<li class="apr-ev apr-ev--${esc(e.action)}">${ui.icon(e.action === 'approved' ? 'check' : e.action === 'rejected' ? 'x' : e.action === 'comment' ? 'chat' : e.action === 'withdrawn' ? 'back' : 'arrow')}<p><b>${esc(e.name || '—')}</b> <span>${esc(tr(ACTIONS[e.action] || e.action))}${e.step !== null && ['approved', 'rejected'].includes(e.action) && r.steps.length > 1 ? ` · ${esc(tr('apr|step {n}', { n: e.step + 1 }))}` : ''}</span>${e.note ? `<q class="apr-note">${esc(e.note)}</q>` : ''}</p><time datetime="${esc(e.at)}" title="${esc(ui.dt(e.at))}">${esc(ui.rel(e.at))}</time></li>`).join('')}</ul>`;
    const decideCard = mayDecide ? `<section class="card apr-decide"><header class="card__head"><div><h2>${esc(tr('apr|Your decision'))}</h2><p>${esc(stepText(r))}${u.role === 'admin' && !fits(u, r.steps[r.step].who) ? ` · ${esc(tr('apr|as an administrator'))}` : ''}</p></div></header><div class="card__body">${ui.form(`/admin/approvals/${r.id}/decide`, csrf, `
      ${ui.textarea('note', tr('apr|Note (needed to reject)'), '', { rows: 3 })}
      <div class="apr-btns">${ui.btn(esc(tr('apr|Approve')), { cls: 'btn--primary apr-yes', ic: 'check', attrs: { name: 'decision', value: 'approved' } })}${ui.btn(esc(tr('apr|Reject')), { cls: 'btn--danger apr-no', ic: 'x', attrs: { name: 'decision', value: 'rejected' } })}</div>`, { cls: 'stack' })}</div></section>` : '';
    const withdrawForm = r.status === 'pending' && (u.id === r.requested_by || u.role === 'admin')
      ? `<details class="danger"><summary>${esc(tr('apr|Withdraw the request'))}</summary>${ui.form(`/admin/approvals/${r.id}/withdraw`, csrf, `${ui.input('note', tr('apr|Why (optional)'), '')}${ui.btn(esc(tr('apr|Withdraw the request')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('apr|Withdraw this request? Nothing will be done.') } })}`, { cls: 'stack' })}</details>` : '';
    const comment = ui.card(tr('apr|Add a comment'), ui.form(`/admin/approvals/${r.id}/comment`, csrf, `${ui.textarea('note', tr('apr|Comment'), '', { rows: 2 })}${ui.btn(esc(tr('apr|Add the comment')), { cls: 'btn--ghost btn--sm', ic: 'chat' })}`, { cls: 'stack' }));
    h.page(req, res, {
      title: titleOf(r), crumbs: [['/admin/approvals', tr('apr|Approvals')], [null, r.ref]], active: '/admin/approvals',
      body: `<div class="apr-detail">
        <div class="apr-detail__act stack">${decideCard}${r.status === 'pending' && !mayDecide ? `<div class="alert alert--warn">${esc(r.requested_by === u.id ? tr('apr|Waiting for {who}.', { who: whoLabel(r.steps[r.step].who) }) : tr('apr|This step is for {who}.', { who: whoLabel(r.steps[r.step].who) }))}</div>` : ''}${comment}${withdrawForm}</div>
        <div class="apr-detail__main stack">${ui.card(titleOf(r), facts + extra, { action: badge(r.status), sub: `<bdi>${esc(r.ref)}</bdi> · ${esc(kindLabel(r.kind))}` })}${ui.card(tr('apr|Steps'), `<ol class="list apr-steps">${stepItems}</ol>`)}${ui.card(tr('apr|History'), history)}</div>
      </div>`,
    });
  });
  router.post('/approvals/:id/decide', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    const decision = req.body.decision === 'approved' ? 'approved' : req.body.decision === 'rejected' ? 'rejected' : null;
    try {
      const after = decide(id, req.user, decision, h.str(req.body.note, 1000) || null);
      h.log(req, decision === 'approved' ? 'Approved a request' : 'Rejected a request', 'approval', id, `${r.ref} · ${r.title}`);
      const msg = after.status === 'approved' ? tr('apr|Approved. {name} has been told.', { name: r.requester || '—' })
        : after.status === 'rejected' ? tr('apr|Not approved. {name} has been told.', { name: r.requester || '—' })
          : tr('apr|Approved for step {n}. It now goes to {who}.', { n: r.step + 1, who: whoLabel(after.steps[after.step].who) });
      h.back(req, res, waitingFor(req.user).length ? '/admin/approvals?tab=todo' : `/admin/approvals/${id}`, 'ok', msg);
    } catch (e) {
      h.back(req, res, `/admin/approvals/${id}`, 'error', String(e.message).startsWith('apr|') ? tr(e.message) : tr('apr|That could not be done: {error}', { error: e.message }));
    }
  });
  router.post('/approvals/:id/withdraw', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    try {
      withdraw(id, req.user, h.str(req.body.note, 500) || null);
    } catch (e) {
      return h.back(req, res, `/admin/approvals/${id}`, 'error', String(e.message).startsWith('apr|') ? tr(e.message) : e.message);
    }
    h.log(req, 'Withdrew a request', 'approval', id, r.ref);
    h.back(req, res, `/admin/approvals/${id}`, 'ok', tr('apr|Request withdrawn.'));
  });
  router.post('/approvals/:id/comment', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    if (!canSee(req.user, r)) return h.auth.denied(req, res);
    const note = h.str(req.body.note, 1000);
    if (!note) return h.back(req, res, `/admin/approvals/${id}`, 'error', tr('apr|Write the comment first.'));
    event(id, 'comment', r.step, note, req.user);
    db.run('UPDATE apr_requests SET updated_at = ? WHERE id = ?', now(), id);
    // the requester hears about comments from others
    if (r.requested_by && r.requested_by !== req.user.id) {
      const who = db.get('SELECT * FROM users WHERE id = ? AND active = 1', r.requested_by);
      mailTo(who, 'apr|New comment on {title}', 'apr|{name} commented on your request {ref}: {note}', { name: req.user.name, note }, r);
    }
    h.back(req, res, `/admin/approvals/${id}`, 'ok', tr('apr|Comment added.'));
  });
};

module.exports.KINDS = KINDS;
module.exports.STATUS = STATUS;
