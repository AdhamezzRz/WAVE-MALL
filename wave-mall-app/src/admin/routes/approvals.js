'use strict';

// Approvals (/admin/approvals): one place where money decisions wait for the right person.
// A rule per kind of request (write-off, refund, purchase, salary advance, advertising discount,
// other) says from which amount it needs approval, in one or two steps, who decides each step
// (a manager, an administrator, finance, a named person, or a role from Users & permissions), and
// how many hours each step may take (its SLA). A request moves step by step:
//
//   pending (step 1 → step 2) → approved      the module that asked carries it out
//                             → rejected      with the reason
//                             → withdrawn     by the person who asked
//
// While it waits, an approver can ask the requester for more information (the clock stops until
// they answer), claim it, or — a manager — hand the step to someone else. A step past its SLA is
// escalated: a named person's or finance's step to the managers, then to the administrators.
// Someone out of office names a delegate for some dates; the delegate decides on their behalf.
// The work hub (/admin/work) shows every request as a task card next to the team's tasks.
//
// Other modules use it through h.approvals:
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
//   h.approvals.onEvent((type, request, user, extra) => {})  → everything that happens to requests
//                                                    (the work hub turns these into notifications)
// A module that loads before this one queues its handlers: (h.approvalHooks = h.approvalHooks || []).push((A) => …).

const i18n = require('../i18n');
const { cairo } = require('../ops-common');

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
// SLA per kind, priority, the clock of the current step (paused while waiting for an answer),
// who claimed it, how far it was escalated; delegations while someone is away.
const SCHEMA_2 = `
  ALTER TABLE apr_rules ADD COLUMN sla_hours INTEGER NOT NULL DEFAULT 48;
  ALTER TABLE apr_requests ADD COLUMN priority TEXT;
  ALTER TABLE apr_requests ADD COLUMN step_at TEXT;
  ALTER TABLE apr_requests ADD COLUMN paused_s INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE apr_requests ADD COLUMN info_at TEXT;
  ALTER TABLE apr_requests ADD COLUMN info_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE apr_requests ADD COLUMN claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE apr_requests ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE apr_requests ADD COLUMN reminded_step INTEGER;
  ALTER TABLE apr_events ADD COLUMN on_behalf INTEGER REFERENCES users(id) ON DELETE SET NULL;
  CREATE TABLE wk_delegations (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delegate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, starts TEXT NOT NULL, ends TEXT NOT NULL, note TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, cancelled_at TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX wk_delegations_delegate ON wk_delegations(delegate_id, starts, ends);
  CREATE INDEX wk_delegations_user ON wk_delegations(user_id, starts, ends);
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
  info_asked: 'wk|Asked for more information', info_given: 'wk|Answered', escalated: 'wk|Escalated', reminded: 'wk|Reminder sent',
  claimed: 'wk|Took it on', released: 'wk|Let it go', reassigned: 'wk|Handed the step to', priority: 'wk|Set the priority',
};
const PRIORITY = { urgent: ['wk|Urgent', 'rose'], high: ['wk|High', 'amber'], normal: ['wk|Normal', 'sea'], low: ['wk|Low', 'mute'] };
const DEFAULT_SLA = 48;
// a step's escalation ladder: who joins at level 1, then level 2
const ladder = (who) => (who === 'admin' ? [] : who === 'manager' ? ['admin'] : ['manager', 'admin']);

module.exports = function approvals(router, h) {
  const { db, ui, M } = h;
  db.ensure('approvals-1', SCHEMA);
  db.ensure('approvals-2', SCHEMA_2);
  (h.auditTyped = h.auditTyped || []).push("SELECT title, note FROM apr_requests WHERE kind = 'other'", 'SELECT note FROM apr_events WHERE note IS NOT NULL', 'SELECT note FROM wk_delegations WHERE note IS NOT NULL');
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
  const listeners = [];
  const emit = (type, r, user, extra = {}) => {
    for (const fn of listeners) {
      try {
        fn(type, r, user, extra);
      } catch (e) {
        console.error('[approvals] listener:', e.message);
      }
    }
  };

  // ---------- roles from Users & permissions (when that module is there) ----------
  const access = () => (h.access && typeof h.access.roles === 'function' ? h.access : null);
  const roleList = () => {
    try {
      return access() ? access().roles() || [] : [];
    } catch {
      return [];
    }
  };
  const roleName = (role) => {
    try {
      return access() && typeof access().roleName === 'function' ? access().roleName(role) || role.name : role.name;
    } catch {
      return role.name;
    }
  };
  const inRole = (user, id) => {
    try {
      return !!access() && (access().usersWithRole(Number(id)) || []).some((x) => x.id === user.id);
    } catch {
      return false;
    }
  };

  // ---------- rules ----------
  const validWho = (w) => typeof w === 'string' && (!!WHO[w] || /^user:\d+$/.test(w) || /^role:\d+$/.test(w));
  const cleanSteps = (steps) => (Array.isArray(steps) ? steps : []).filter((s) => s && validWho(s.who)).slice(0, 2);
  const ruleOf = (kind) => {
    const r = db.get('SELECT * FROM apr_rules WHERE kind = ?', kind);
    return r ? { ...r, steps: cleanSteps(parse(r.steps, [])) } : null;
  };
  function setRule(kind, { active = 1, min_amount = 0, steps = [{ who: 'manager' }], sla_hours = null, user = null, demo = 0 } = {}) {
    if (!KINDS[kind]) throw new Error('Unknown approval kind');
    const s = cleanSteps(steps);
    db.run(`INSERT INTO apr_rules (kind, active, min_amount, steps, updated_by, updated_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET active = excluded.active, min_amount = excluded.min_amount, steps = excluded.steps, updated_by = excluded.updated_by, updated_at = excluded.updated_at, demo = excluded.demo`,
    kind, active ? 1 : 0, Math.max(0, r2(min_amount)), JSON.stringify(s.length ? s : [{ who: 'manager' }]), user ? user.id : null, now(), demo ? 1 : 0);
    if (sla_hours !== null && sla_hours !== undefined) db.run('UPDATE apr_rules SET sla_hours = ? WHERE kind = ?', Math.max(1, Math.min(24 * 30, Math.round(Number(sla_hours) || DEFAULT_SLA))), kind);
    return ruleOf(kind);
  }
  function needs(kind, amount) {
    const r = ruleOf(kind);
    return !!(r && r.active && r.steps.length && r2(amount) >= r2(r.min_amount));
  }
  const slaHours = (kind) => {
    const r = db.get('SELECT sla_hours FROM apr_rules WHERE kind = ?', kind);
    return r && r.sla_hours > 0 ? r.sla_hours : DEFAULT_SLA;
  };

  // ---------- delegation (out of office) ----------
  // the office works in Cairo time: a delegation from Sunday starts at Cairo midnight
  const today = () => cairo().date;
  const delegatesOf = (userId, day = today()) => db.all(`SELECT u.*, d.ends deleg_ends, d.id deleg_id FROM wk_delegations d JOIN users u ON u.id = d.delegate_id
    WHERE d.user_id = ? AND d.cancelled_at IS NULL AND d.starts <= ? AND d.ends >= ? AND u.active = 1`, userId, day, day);
  const delegatorsOf = (userId, day = today()) => db.all(`SELECT u.*, d.ends deleg_ends, d.id deleg_id FROM wk_delegations d JOIN users u ON u.id = d.user_id
    WHERE d.delegate_id = ? AND d.cancelled_at IS NULL AND d.starts <= ? AND d.ends >= ?`, userId, day, day);
  function delegate({ user_id, delegate_id, starts, ends, note = null, by = null, demo = 0 }) {
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    if (!isDate(starts) || !isDate(ends) || ends < starts) throw new Error('wk|Choose the dates: the last day cannot be before the first.');
    if (Number(user_id) === Number(delegate_id)) throw new Error('wk|Choose someone else to cover for you.');
    if (!db.get('SELECT id FROM users WHERE id = ? AND active = 1', delegate_id)) throw new Error('wk|Choose someone on the team.');
    // a new delegation replaces any that overlaps it
    db.run('UPDATE wk_delegations SET cancelled_at = ? WHERE user_id = ? AND cancelled_at IS NULL AND starts <= ? AND ends >= ?', now(), user_id, ends, starts);
    return Number(db.run('INSERT INTO wk_delegations (user_id, delegate_id, starts, ends, note, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      user_id, delegate_id, starts, ends, note ? String(note).slice(0, 300) : null, by ? by.id : null, demo ? 1 : 0, now()).lastInsertRowid);
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
  const event = (id, action, step, note, user, at = now(), onBehalf = null) => db.run('INSERT INTO apr_events (request_id, action, step, note, user_id, at, on_behalf) VALUES (?, ?, ?, ?, ?, ?, ?)', id, action, step, note || null, user ? user.id : null, at, onBehalf ? onBehalf.id : null);
  // everyone who already approved a step (and whoever a delegate approved for)
  const approvedBy = (id) => db.all("SELECT user_id, on_behalf FROM apr_events WHERE request_id = ? AND action = 'approved'", id).flatMap((e) => [e.user_id, e.on_behalf]).filter(Boolean);

  const fits = (user, who) => {
    if (!user) return false;
    if (who === 'manager') return allowed(user, 'manager');
    if (who === 'finance') return !!user.finance || user.role === 'admin';
    if (who === 'admin') return user.role === 'admin';
    if (/^user:\d+$/.test(who)) return Number(who.slice(5)) === user.id;
    if (/^role:\d+$/.test(who)) return inRole(user, who.slice(5));
    return false;
  };
  // fits the step through its escalation (level 1: the first rung of its ladder, level 2: both)
  const fitsEscalated = (user, r) => {
    const step = r.steps[r.step];
    return !!step && r.escalated > 0 && ladder(step.who).slice(0, r.escalated).some((w) => fits(user, w));
  };
  // May this person decide the request's current step, and on whose behalf? Administrators always
  // may; nobody else decides their own request, or two steps of the same request. A delegate decides
  // for the person they cover while that person is away.
  function decideAs(user, r) {
    if (!user || !r || r.status !== 'pending') return null;
    const step = r.steps[r.step];
    if (!step) return null;
    if (user.role === 'admin') return { self: true };
    if (r.requested_by === user.id) return null;
    const done = approvedBy(r.id);
    if (done.includes(user.id)) return null;
    if (fits(user, step.who) || fitsEscalated(user, r)) return { self: true };
    for (const d of delegatorsOf(user.id)) {
      if (d.id !== r.requested_by && !done.includes(d.id) && (fits(d, step.who) || fitsEscalated(d, r))) return { onBehalf: d };
    }
    return null;
  }
  const canDecide = (user, r) => !!decideAs(user, r);
  const whoLabel = (who) => {
    if (WHO[who]) return tr(WHO[who]);
    if (/^role:\d+$/.test(String(who))) {
      const role = roleList().find((x) => String(x.id) === who.slice(5));
      return role ? roleName(role) : tr('wk|A role that no longer exists');
    }
    const u = /^user:\d+$/.test(String(who)) ? db.get('SELECT name FROM users WHERE id = ?', Number(who.slice(5))) : null;
    return u ? u.name : tr('apr|Someone no longer on the team');
  };
  // the people who can decide the current step (with the delegates of those who are away)
  function approversFor(r) {
    const step = r.steps[r.step];
    if (!step) return [];
    const out = new Map();
    for (const u of db.all('SELECT * FROM users WHERE active = 1')) {
      if (u.id === r.requested_by) continue;
      if (fits(u, step.who) || fitsEscalated(u, r)) out.set(u.id, u);
    }
    for (const u of [...out.values()]) for (const d of delegatesOf(u.id)) if (d.id !== r.requested_by) out.set(d.id, d);
    return [...out.values()];
  }

  // ---------- the clock (SLA) ----------
  const stepStart = (r) => r.step_at || r.created_at;
  function sla(r, at = now()) {
    if (!r || r.status !== 'pending') return null;
    const hours = slaHours(r.kind);
    const pausedNow = r.info_at ? Math.max(0, (Date.parse(at) - Date.parse(r.info_at)) / 1000) : 0;
    const due = Date.parse(stepStart(r)) + hours * 3600000 + ((r.paused_s || 0) + pausedNow) * 1000;
    const left = (due - Date.parse(at)) / 3600000;
    return { due: new Date(due).toISOString(), hours, left, overdue: left < 0 && !r.info_at, paused: !!r.info_at };
  }
  // urgent when overdue; high when due within 8 hours or large; low when small; a manager can set it
  function priorityOf(r) {
    if (r.priority && PRIORITY[r.priority]) return r.priority;
    if (r.status !== 'pending') return 'normal';
    const s = sla(r);
    if (s && s.overdue) return 'urgent';
    if ((s && !s.paused && s.left <= 8) || r.amount >= 250000) return 'high';
    if (r.amount && r.amount < 5000) return 'low';
    return 'normal';
  }
  const span = (hrs) => {
    const a = Math.abs(hrs);
    if (a < 1) return tn(Math.max(1, Math.round(a * 60)), 'wk|{n} minute', 'wk|{n} minutes');
    if (a < 48) return tn(Math.round(a), 'apr|{n} hour', 'apr|{n} hours');
    return tn(Math.round(a / 24), 'apr|{n} day', 'apr|{n} days');
  };
  const slaChip = (r) => {
    const s = sla(r);
    if (!s) return '';
    if (s.paused) return ui.badge('paused', tr('wk|Clock paused · waiting for an answer'), 'sky');
    if (s.overdue) return ui.badge('late', tr('wk|Overdue by {time}', { time: span(s.left) }), 'rose');
    return ui.badge('due', tr('wk|Due in {time}', { time: span(s.left) }), s.left <= 8 ? 'amber' : 'mute');
  };
  const priorityBadge = (p) => ui.badge(`p-${p}`, tr(PRIORITY[p][0]), PRIORITY[p][1]);

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

  function request({ kind, title, amount = 0, entity = null, entity_id = null, link = null, payload = null, note = null, user = null, demo = 0, at = null, priority = null }) {
    if (!KINDS[kind]) throw new Error(`Unknown approval kind: ${kind}`);
    const rule = ruleOf(kind);
    const steps = rule && rule.steps.length ? rule.steps : [{ who: 'manager' }];
    const t = at || now();
    const id = db.tx(() => {
      const rid = Number(db.run(`INSERT INTO apr_requests (ref, kind, title, amount, entity, entity_id, link, payload, note, status, step, steps, requested_by, demo, created_at, updated_at, step_at, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)`,
      db.nextRef('apr_requests', 'AP', 4, true), kind, String(title || kindLabel(kind)).slice(0, 200), r2(amount), entity, entity_id === null || entity_id === undefined ? null : Number(entity_id),
      link, payload === null || payload === undefined ? null : JSON.stringify(payload), note ? String(note).slice(0, 1000) : null, JSON.stringify(steps), user ? user.id : null, demo ? 1 : 0, t, t, t,
      PRIORITY[priority] ? priority : null).lastInsertRowid);
      event(rid, 'submitted', 0, note, user, t);
      return rid;
    });
    const r = requestOf(id);
    notifyApprovers(r);
    emit('submitted', r, user);
    return r;
  }

  // The decision on the current step. Throws (with an apr|/wk| message) when it is not allowed.
  function decide(id, user, decision, note = null, { at = null } = {}) {
    const r = requestOf(id);
    if (!r) throw new Error('apr|There is no such request.');
    if (r.status !== 'pending') throw new Error('apr|This request has already been decided.');
    if (!['approved', 'rejected'].includes(decision)) throw new Error('apr|Choose approve or reject.');
    const as = decideAs(user, r);
    if (!as) throw new Error('apr|This step is not yours to decide.');
    if (decision === 'rejected' && !String(note || '').trim()) throw new Error('apr|Say why it is not approved.');
    const t = at || now();
    let final = null;
    db.tx(() => {
      event(r.id, decision, r.step, note, user, t, as.onBehalf || null);
      if (decision === 'rejected') final = 'rejected';
      else if (r.step + 1 < r.steps.length) {
        db.run('UPDATE apr_requests SET step = step + 1, step_at = ?, paused_s = 0, info_at = NULL, info_by = NULL, claimed_by = NULL, escalated = 0, updated_at = ? WHERE id = ?', t, t, r.id);
      } else final = 'approved';
      if (final) {
        db.run('UPDATE apr_requests SET status = ?, decided_by = ?, decided_at = ?, info_at = NULL, updated_at = ? WHERE id = ?', final, user ? user.id : null, t, t, r.id);
        for (const fn of handlers[r.kind] || []) fn(requestOf(r.id), final, user);
      }
    });
    const after = requestOf(r.id);
    if (final) tellRequester(after, final, user, note);
    else notifyApprovers(after);
    emit(final ? 'decided' : 'step', after, user, { decision, note, onBehalf: as.onBehalf || null });
    return after;
  }
  function withdraw(id, user, note = null) {
    const r = requestOf(id);
    if (!r || r.status !== 'pending') throw new Error('apr|Only a request still waiting can be withdrawn.');
    if (!user || (user.id !== r.requested_by && user.role !== 'admin')) throw new Error('apr|Only the person who asked can withdraw it.');
    db.tx(() => {
      const t = now();
      event(r.id, 'withdrawn', r.step, note, user, t);
      db.run("UPDATE apr_requests SET status = 'withdrawn', decided_by = ?, decided_at = ?, info_at = NULL, updated_at = ? WHERE id = ?", user.id, t, t, r.id);
      for (const fn of withdrawers[r.kind] || []) fn(requestOf(r.id), user);
    });
    const after = requestOf(r.id);
    emit('withdrawn', after, user, { note });
    return after;
  }

  // An approver asks the requester a question; the step's clock stops until they answer.
  function askInfo(id, user, question, { at = null } = {}) {
    const r = requestOf(id);
    if (!r || r.status !== 'pending') throw new Error('apr|This request has already been decided.');
    const as = decideAs(user, r);
    if (!as) throw new Error('apr|This step is not yours to decide.');
    if (!String(question || '').trim()) throw new Error('wk|Write the question first.');
    if (r.info_at) throw new Error('wk|A question is already waiting for an answer.');
    if (!r.requested_by || !db.get('SELECT id FROM users WHERE id = ? AND active = 1', r.requested_by)) throw new Error('wk|Nobody on the team can answer: the person who asked has left.');
    const t = at || now();
    db.tx(() => {
      event(r.id, 'info_asked', r.step, String(question).slice(0, 1000), user, t, as.onBehalf || null);
      db.run('UPDATE apr_requests SET info_at = ?, info_by = ?, updated_at = ? WHERE id = ?', t, user.id, t, r.id);
    });
    const after = requestOf(r.id);
    const asker = db.get('SELECT * FROM users WHERE id = ?', r.requested_by);
    mailTo(asker, 'wk|A question about your request {ref}', 'wk|{name} needs more information before deciding {title}: {note}', { name: user.name, note: question }, after);
    emit('info_asked', after, user, { note: question });
    return after;
  }
  // The requester answers; the clock starts again where it stopped.
  function answerInfo(id, user, answer, { at = null } = {}) {
    const r = requestOf(id);
    if (!r || r.status !== 'pending' || !r.info_at) throw new Error('wk|No question is waiting for an answer.');
    if (!user || (user.id !== r.requested_by && user.role !== 'admin')) throw new Error('wk|Only the person who asked can answer.');
    if (!String(answer || '').trim()) throw new Error('wk|Write the answer first.');
    const t = at || now();
    const paused = Math.max(0, Math.round((Date.parse(t) - Date.parse(r.info_at)) / 1000));
    db.tx(() => {
      event(r.id, 'info_given', r.step, String(answer).slice(0, 1000), user, t);
      db.run('UPDATE apr_requests SET info_at = NULL, paused_s = paused_s + ?, updated_at = ? WHERE id = ?', paused, t, r.id);
    });
    const after = requestOf(r.id);
    const asker = r.info_by ? db.get('SELECT * FROM users WHERE id = ? AND active = 1', r.info_by) : null;
    mailTo(asker, 'wk|Answer on {ref}', 'wk|{name} answered your question on {title}: {note}', { name: user.name, note: answer }, after);
    emit('info_given', after, user, { note: answer, to: r.info_by });
    return after;
  }
  // "I'm on it": the card shows who is looking at it (or let it go again)
  function claim(id, user, on = true) {
    const r = requestOf(id);
    if (!r || r.status !== 'pending') throw new Error('apr|This request has already been decided.');
    if (on && !canDecide(user, r)) throw new Error('apr|This step is not yours to decide.');
    if (!on && r.claimed_by !== user.id && user.role !== 'admin') throw new Error('apr|This step is not yours to decide.');
    db.tx(() => {
      db.run('UPDATE apr_requests SET claimed_by = ?, updated_at = ? WHERE id = ?', on ? user.id : null, now(), r.id);
      event(r.id, on ? 'claimed' : 'released', r.step, null, user);
    });
    return requestOf(r.id);
  }
  // A manager hands the current step to another approver (a person, a role, or a group).
  function reassign(id, user, who) {
    const r = requestOf(id);
    if (!r || r.status !== 'pending') throw new Error('apr|This request has already been decided.');
    if (!allowed(user, 'manager')) throw new Error('wk|Only a manager can hand a step to someone else.');
    if (!validWho(String(who || ''))) throw new Error('wk|Choose who decides this step.');
    if (who === `user:${r.requested_by}`) throw new Error('wk|The person who asked cannot decide their own request.');
    const steps = r.steps.map((s, i) => (i === r.step ? { ...s, who } : s));
    const t = now();
    db.tx(() => {
      db.run('UPDATE apr_requests SET steps = ?, claimed_by = NULL, escalated = 0, step_at = ?, paused_s = 0, reminded_step = NULL, updated_at = ? WHERE id = ?', JSON.stringify(steps), t, t, r.id);
      event(r.id, 'reassigned', r.step, who, user, t);
    });
    const after = requestOf(r.id);
    notifyApprovers(after);
    emit('reassigned', after, user, { who });
    return after;
  }
  function setPriority(id, user, p) {
    const r = requestOf(id);
    if (!r) throw new Error('apr|There is no such request.');
    if (!allowed(user, 'manager')) throw new Error('wk|Only a manager can change the priority.');
    db.run('UPDATE apr_requests SET priority = ?, updated_at = ? WHERE id = ?', PRIORITY[p] ? p : null, now(), r.id);
    event(r.id, 'priority', r.step, PRIORITY[p] ? p : 'auto', user);
    return requestOf(r.id);
  }

  // The clock's job: a reminder when a step is close to its SLA, escalation once it is past it
  // (level 1 when late, level 2 when late by another full SLA). Returns what it did.
  function runSla(at = now()) {
    const out = { reminded: 0, escalated: 0 };
    for (const raw of db.all("SELECT * FROM apr_requests WHERE status = 'pending' AND info_at IS NULL")) {
      const r = hydrate(raw);
      const s = sla(r, at);
      const step = r.steps[r.step];
      if (!s || !step) continue;
      if (!s.overdue && s.left <= Math.min(4, s.hours / 4) && r.reminded_step !== r.step) {
        db.run('UPDATE apr_requests SET reminded_step = ? WHERE id = ?', r.step, r.id);
        event(r.id, 'reminded', r.step, null, null, at);
        const fresh = requestOf(r.id);
        for (const u of approversFor(fresh)) mailTo(u, 'wk|Due soon: {title}', 'wk|{title} ({ref}) is due in {time}. It waits for your decision.', { time: span(s.left) }, fresh);
        emit('reminded', fresh, null, { left: s.left });
        out.reminded++;
      }
      const want = s.overdue ? Math.min(ladder(step.who).length, -s.left >= s.hours ? 2 : 1) : 0;
      if (want > r.escalated) {
        db.run('UPDATE apr_requests SET escalated = ?, updated_at = ? WHERE id = ?', want, at, r.id);
        event(r.id, 'escalated', r.step, ladder(step.who)[want - 1], null, at);
        const fresh = requestOf(r.id);
        for (const u of approversFor(fresh)) mailTo(u, 'wk|Escalated: {title}', 'wk|{title} ({ref}) is overdue by {time}. It has been escalated to you.', { time: span(s.left) }, fresh);
        emit('escalated', fresh, null, { level: want, to: ladder(step.who)[want - 1] });
        out.escalated++;
      }
    }
    return out;
  }

  const pendingFor = (entity, entityId) => hydrate(db.get("SELECT * FROM apr_requests WHERE entity = ? AND entity_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", entity, Number(entityId)));
  const latestFor = (entity, entityId) => hydrate(db.get('SELECT * FROM apr_requests WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1', entity, Number(entityId)));
  // what is waiting for this person
  const waitingFor = (user) => db.all("SELECT * FROM apr_requests WHERE status = 'pending' ORDER BY created_at").map(hydrate).filter((r) => canDecide(user, r));
  const canSee = (user, r) => !!user && (isOverseer(user) || r.requested_by === user.id || r.steps.some((s) => fits(user, s.who)) || canDecide(user, r)
    || db.value('SELECT COUNT(*) FROM apr_events WHERE request_id = ? AND (user_id = ? OR on_behalf = ?)', r.id, user.id, user.id) > 0);

  h.approvals = {
    KINDS, STATUS, PRIORITY, WHO, needs, request, decide, withdraw, pendingFor, latestFor, waitingFor, canDecide, decideAs, canSee, ruleOf, setRule, requestOf, titleOf,
    askInfo, answerInfo, claim, reassign, setPriority, runSla, sla, slaHours, priorityOf, slaChip, priorityBadge, span, whoLabel, kindLabel, approversFor, fits, validWho,
    delegate, delegatesOf, delegatorsOf, roleList, badge,
    onDecision: (kind, fn) => { (handlers[kind] = handlers[kind] || []).push(fn); },
    onWithdraw: (kind, fn) => { (withdrawers[kind] = withdrawers[kind] || []).push(fn); },
    onEvent: (fn) => { listeners.push(fn); },
    describe: (kind, fn) => { describers[kind] = fn; },
    details: (kind, fn) => { detailers[kind] = fn; },
    relink: (id, { entity = null, entity_id = null, link = null } = {}) => db.run('UPDATE apr_requests SET entity = ?, entity_id = ?, link = ?, updated_at = ? WHERE id = ?', entity, entity_id, link, now(), id),
  };
  h.count('approve', (user) => waitingFor(user).length);
  // modules loaded before this one queued their handlers: (h.approvalHooks = h.approvalHooks || []).push((A) => …)
  const queued = Array.isArray(h.approvalHooks) ? h.approvalHooks : [];
  h.approvalHooks = { push: (fn) => fn(h.approvals) };
  for (const fn of queued) fn(h.approvals);
  if (h.every) h.every('approvals-sla', 15 * 60 * 1000, () => runSla(), { first: 2 * 60 * 1000 });

  // ---------- pages ----------
  const stepText = (r) => (r.status === 'pending' ? tr('apr|Step {n} of {total} · {who}', { n: r.step + 1, total: r.steps.length, who: whoLabel((r.steps[r.step] || {}).who) }) : '');
  const hours = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / 3600000);
  const waited = (iso) => {
    const hrs = hours(iso, now());
    return hrs < 24 ? tn(Math.max(1, Math.round(hrs)), 'apr|{n} hour', 'apr|{n} hours') : tn(Math.round(hrs / 24), 'apr|{n} day', 'apr|{n} days');
  };
  const HUB = () => [['/admin/work', tr('nav|Approvals & tasks')]];
  const backTo = (req, fb) => {
    const b = String((req.body && req.body.back) || '');
    return /^\/admin\/(work|approvals)(?:[/?]|$)/.test(b) && !b.startsWith('//') ? b : fb;
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
    const late = todo.filter((r) => (sla(r) || {}).overdue).length;
    const kpis = [
      ui.kpi({ label: tr('apr|Waiting for you'), value: String(todo.length), tone: todo.length ? 'kpi--alert' : '', href: '/admin/approvals?tab=todo', sub: todo.length ? esc(tr('apr|{amount} in total', { amount: ui.money(r2(todo.reduce((s, r) => s + r.amount, 0)), { compact: true }) })) + (late ? ` · ${esc(tr('wk|{n} overdue', { n: late }))}` : '') : '' }),
      ui.kpi({ label: tr('apr|Your requests waiting'), value: String(mine), href: '/admin/approvals?tab=mine&status=pending' }),
      ui.kpi({ label: tr('apr|Approved this month'), value: ui.money(r2(db.value("SELECT COALESCE(SUM(amount), 0) FROM apr_requests WHERE status = 'approved' AND substr(decided_at, 1, 7) = ?", month)), { compact: true }), sub: esc(tn(db.value("SELECT COUNT(*) FROM apr_requests WHERE status = 'approved' AND substr(decided_at, 1, 7) = ?", month), 'apr|{n} request', 'apr|{n} requests')) }),
      ui.kpi({ label: tr('apr|Average time to decide'), value: avg === null ? '—' : esc(avg < 24 ? tn(Math.max(1, Math.round(avg)), 'apr|{n} hour', 'apr|{n} hours') : tn(Math.round(avg / 24), 'apr|{n} day', 'apr|{n} days')) }),
    ].join('');
    const link = (o) => `/admin/approvals?${new URLSearchParams(Object.entries({ tab, status: q.status || '', kind, from: f.from, to: f.to, ...o }).filter(([, v]) => v)).toString()}`;
    const tabs = `<nav class="tabs">${[['todo', tr('apr|To approve'), todo.length], ['mine', tr('apr|My requests'), mine], ...(over ? [['all', tr('apr|All requests'), null]] : [])]
      .map(([k, l, n]) => `<a class="tab${tab === k ? ' is-on' : ''}" href="/admin/approvals?tab=${k}">${esc(l)}${n ? ` <b class="nav__count">${n}</b>` : ''}</a>`).join('')}</nav>`;
    const sub = tab === 'todo' ? '' : `<nav class="tabs tabs--sub">${['pending', 'approved', 'rejected', 'withdrawn', 'any'].map((s) => `<a class="tab${status === s ? ' is-on' : ''}" href="${esc(link({ status: s }))}">${esc(s === 'any' ? tr('All') : tr(STATUS[s][0]))}</a>`).join('')}</nav>`;
    const kindSel = `<form method="get" action="/admin/approvals" class="filters apr-kinds"><input type="hidden" name="tab" value="${esc(tab)}">${q.status ? `<input type="hidden" name="status" value="${esc(q.status)}">` : ''}${ui.select('kind', tr('apr|Kind'), Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, tr(v)])), kind, { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}</form>`;
    const P_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
    const table = ui.table([
      { label: tr('apr|Request'), sort: (r) => titleOf(r), render: (r) => `<b>${esc(titleOf(r))}</b><small class="sub"><bdi>${esc(r.ref)}</bdi> · ${esc(kindLabel(r.kind))}</small>` },
      { label: tr('apr|Amount'), num: true, sort: (r) => r.amount, render: (r) => (r.amount ? ui.money(r.amount, { cur: false }) : '—') },
      { label: tr('apr|Asked by'), sort: (r) => names[r.requested_by] || '', render: (r) => `${esc(names[r.requested_by] || '—')}<small class="sub">${esc(ui.date(r.created_at))}</small>` },
      { label: tr('apr|Where it is'), sort: (r) => r.status + r.step, render: (r) => `${badge(r.status)}${r.status === 'pending' ? `<small class="sub">${esc(stepText(r))}</small>` : r.decided_at ? `<small class="sub">${esc(ui.date(r.decided_at))}</small>` : ''}` },
      { label: tr('wk|Priority'), sort: (r) => P_ORDER[priorityOf(r)], render: (r) => (r.status === 'pending' ? priorityBadge(priorityOf(r)) : '—') },
      { label: tr('wk|Due'), sort: (r) => (sla(r) ? sla(r).due : ''), render: (r) => (r.status === 'pending' ? slaChip(r) : '—') },
    ], rows, { empty: esc(tab === 'todo' ? tr('apr|Nothing is waiting for you.') : tr('apr|No requests here.')), href: (r) => `/admin/approvals/${r.id}` });
    const actions = [
      ui.btn(esc(tr('wk|Board')), { href: '/admin/work/board?type=approvals', cls: 'btn--ghost btn--sm', ic: 'pipe' }),
      ui.btn(esc(tr('apr|New request')), { href: '/admin/approvals/new', cls: 'btn--primary btn--sm', ic: 'plus' }),
      ...(allowed(u, 'manager') ? [ui.btn(esc(tr('apr|Approval rules')), { href: '/admin/approvals/rules', cls: 'btn--ghost btn--sm', ic: 'gear' })] : []),
    ].join('');
    h.page(req, res, {
      title: tr('apr|Approvals'), crumbs: HUB(), active: '/admin/work', actions, wide: true,
      body: `<div class="kpis kpis--4">${kpis}</div>${tabs}${sub}<div class="apr-bar">${f.html}${kindSel}</div>${ui.card(tab === 'todo' ? tr('apr|To approve') : tab === 'mine' ? tr('apr|My requests') : tr('apr|All requests'), table, { sub: esc(tn(rows.length, 'apr|{n} request', 'apr|{n} requests')) })}`,
    });
  });

  // ---------- rules ----------
  const whoOptions = () => [
    ...Object.entries(WHO).map(([k, v]) => [k, tr(v)]),
    ...roleList().map((x) => [`role:${x.id}`, tr('wk|Role: {name}', { name: roleName(x) })]),
    ...db.all('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').map((x) => [`user:${x.id}`, x.name]),
  ];
  router.get('/approvals/rules', h.R('manager'), (req, res) => {
    const csrf = req.session.csrf;
    const opts = whoOptions();
    const rows = Object.entries(KINDS).map(([k, label]) => {
      const r = ruleOf(k) || { active: 0, min_amount: 0, steps: [{ who: 'manager' }], sla_hours: DEFAULT_SLA };
      const s1 = (r.steps[0] || { who: 'manager' }).who;
      const s2 = r.steps[1] ? r.steps[1].who : '';
      return `<fieldset class="apr-rule${r.active ? ' is-on' : ''}"><legend><label class="check"><input type="checkbox" name="${k}_active" value="1"${r.active ? ' checked' : ''}> <b>${esc(tr(label))}</b></label></legend>
        <div class="fields">
          ${ui.input(`${k}_min`, tr('apr|Needs approval from (amount)'), r.min_amount || 0, { type: 'number', min: 0, step: '0.01' })}
          ${ui.select(`${k}_who1`, tr('apr|Step 1 · decided by'), opts, s1)}
          ${ui.select(`${k}_who2`, tr('apr|Step 2 · decided by'), opts, s2, { blank: tr('apr|No second step') })}
          ${ui.input(`${k}_sla`, tr('wk|Hours to decide each step'), r.sla_hours || DEFAULT_SLA, { type: 'number', min: 1, max: 720, step: 1, hint: tr('wk|Reminder before, escalation after.') })}
        </div></fieldset>`;
    }).join('');
    const body = `${ui.form('/admin/approvals/rules', csrf, `<p class="muted small">${esc(tr('apr|A kind that is switched off, or below its amount, goes ahead without approval. Administrators can always decide; nobody else decides their own request or two steps of the same one.'))} ${esc(tr('wk|A step past its hours goes to the managers, then to the administrators.'))}</p><div class="apr-rules">${rows}</div>${ui.btn(esc(tr('apr|Save the rules')), { cls: 'btn--primary' })}`, { cls: 'stack' })}`;
    h.page(req, res, { title: tr('apr|Approval rules'), crumbs: [...HUB(), ['/admin/approvals', tr('apr|Approvals')], [null, tr('apr|Rules')]], active: '/admin/work', body: ui.card(tr('apr|Who approves what'), body) });
  });
  router.post('/approvals/rules', h.R('manager'), (req, res) => {
    const b = req.body;
    const valid = new Set(whoOptions().map((o) => o[0]));
    for (const k of Object.keys(KINDS)) {
      const steps = [b[`${k}_who1`], b[`${k}_who2`]].filter((w) => w && valid.has(String(w))).map((w) => ({ who: String(w) }));
      setRule(k, { active: b[`${k}_active`] === '1', min_amount: h.numv(b[`${k}_min`]) || 0, steps: steps.length ? steps : [{ who: 'manager' }], sla_hours: h.numv(b[`${k}_sla`]) || DEFAULT_SLA, user: req.user });
    }
    h.log(req, 'Changed the approval rules', 'settings', null, Object.keys(KINDS).filter((k) => b[`${k}_active`] === '1').join(', '));
    h.back(req, res, '/admin/approvals/rules', 'ok', tr('apr|Approval rules saved.'));
  });

  // ---------- a request of any other kind ----------
  router.get('/approvals/new', (req, res) => {
    if (!allowed(req.user, 'agent')) return h.auth.denied(req, res);
    const csrf = req.session.csrf;
    const r = ruleOf('other');
    const link = /^\/admin\//.test(String(req.query.link || '')) ? String(req.query.link) : '';
    const form = ui.form('/admin/approvals/new', csrf, `<div class="fields">
      ${ui.input('title', tr('apr|What needs approval'), '', { required: true, cls: 'span-all', placeholder: tr('apr|e.g. Replace the food court chairs') })}
      ${ui.input('amount', tr('apr|Amount'), '', { type: 'number', min: 0, step: '0.01' })}
      ${ui.input('link', tr('apr|Link to the record (optional)'), link)}
      ${ui.textarea('note', tr('apr|Why'), '', { rows: 4, cls: 'span-all' })}
    </div><p class="muted small">${esc(r && r.active ? tr('apr|Decided by: {who}.', { who: r.steps.map((s) => whoLabel(s.who)).join(' → ') }) : tr('apr|Decided by: {who}.', { who: tr(WHO.manager) }))}</p>${ui.btn(esc(tr('apr|Send for approval')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    h.page(req, res, { title: tr('apr|New request'), crumbs: [...HUB(), [null, tr('apr|New request')]], active: '/admin/work', body: `<div class="grid grid--side"><div>${ui.card(tr('apr|Ask for approval'), form)}</div><div></div></div>` });
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
  const evNote = (e) => {
    if (!e.note) return '';
    if (e.action === 'reassigned') return `<q class="apr-note">${esc(whoLabel(e.note))}</q>`;
    if (e.action === 'escalated') return `<q class="apr-note">${esc(whoLabel(e.note))}</q>`;
    if (e.action === 'priority') return e.note === 'auto' ? `<q class="apr-note">${esc(tr('wk|Automatic'))}</q>` : PRIORITY[e.note] ? ` ${priorityBadge(e.note)}` : '';
    return `<q class="apr-note">${esc(e.note)}</q>`;
  };
  const EV_ICON = { approved: 'check', rejected: 'x', comment: 'chat', withdrawn: 'back', info_asked: 'chat', info_given: 'chat', escalated: 'flow', reminded: 'cal', claimed: 'people', released: 'people', reassigned: 'arrow', priority: 'flow' };

  router.get('/approvals/:id', (req, res, next) => {
    const r = requestOf(h.int(req.params.id));
    if (!r) return next();
    const u = req.user;
    if (!canSee(u, r)) return h.auth.denied(req, res);
    const csrf = req.session.csrf;
    const events = db.all('SELECT e.*, u.name, b.name behalf FROM apr_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users b ON b.id = e.on_behalf WHERE e.request_id = ? ORDER BY e.at, e.id', r.id);
    const as = decideAs(u, r);
    const mayDecide = !!as;
    const s = sla(r);
    const prio = priorityOf(r);
    const claimer = r.claimed_by ? db.get('SELECT name FROM users WHERE id = ?', r.claimed_by) : null;
    // the steps, each with who decided it
    const stepItems = r.steps.map((st, i) => {
      const ev = events.filter((e) => e.step === i && ['approved', 'rejected'].includes(e.action)).at(-1);
      const state = ev ? ev.action : r.status === 'pending' && i === r.step ? 'current' : r.status === 'pending' && i > r.step ? 'later' : 'skipped';
      const tone = { approved: 'ok', rejected: 'rose', current: 'amber', later: 'mute', skipped: 'mute' }[state];
      const label = { approved: tr('apr|Approved'), rejected: tr('apr|Rejected'), current: r.info_at ? tr('wk|Waiting for an answer') : tr('apr|Waiting'), later: tr('apr|Next'), skipped: '—' }[state];
      const by = ev ? `${ev.name || '—'}${ev.behalf ? ` · ${tr('wk|for {name}', { name: ev.behalf })}` : ''} · ${ui.dt(ev.at)}` : '';
      return `<li class="apr-step apr-step--${state}"><span class="apr-step__n">${i + 1}</span><span class="what"><b>${esc(whoLabel(st.who))}</b><small>${by ? esc(by) : state === 'current' ? esc(tr('apr|Waiting {time}', { time: waited(stepStart(r)) })) : ''}</small></span>${ui.badge(state, label, tone)}</li>`;
    }).join('');
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('apr|Kind'))}</dt><dd>${esc(kindLabel(r.kind))}</dd></div>
      <div><dt>${esc(tr('apr|Amount'))}</dt><dd><b class="apr-amt">${r.amount ? ui.money(r.amount) : '—'}</b></dd></div>
      <div><dt>${esc(tr('apr|Asked by'))}</dt><dd>${esc(r.requester || '—')} · ${esc(ui.dt(r.created_at))}</dd></div>
      ${r.status === 'pending' ? `<div><dt>${esc(tr('wk|Due'))}</dt><dd>${slaChip(r)}${s && !s.paused ? ` <small class="muted">${esc(ui.dt(s.due))}</small>` : ''}</dd></div>
      <div><dt>${esc(tr('wk|Priority'))}</dt><dd>${priorityBadge(prio)}${r.priority ? '' : ` <small class="muted">${esc(tr('wk|Automatic'))}</small>`}</dd></div>` : ''}
      ${r.escalated && r.status === 'pending' ? `<div><dt>${esc(tr('wk|Escalated'))}</dt><dd>${ui.badge('esc', tr('wk|to {who}', { who: whoLabel(ladder((r.steps[r.step] || {}).who)[r.escalated - 1]) }), 'rose')}</dd></div>` : ''}
      ${claimer && r.status === 'pending' ? `<div><dt>${esc(tr('wk|Being looked at by'))}</dt><dd>${esc(claimer.name)}</dd></div>` : ''}
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
    const history = `<ul class="feed apr-feed">${events.map((e) => `<li class="apr-ev apr-ev--${esc(e.action)}">${ui.icon(EV_ICON[e.action] || 'arrow')}<p><b>${esc(e.name || tr('wk|The office'))}</b>${e.behalf ? ` <small class="muted">${esc(tr('wk|for {name}', { name: e.behalf }))}</small>` : ''} <span>${esc(tr(ACTIONS[e.action] || e.action))}${e.step !== null && ['approved', 'rejected'].includes(e.action) && r.steps.length > 1 ? ` · ${esc(tr('apr|step {n}', { n: e.step + 1 }))}` : ''}</span>${evNote(e)}</p><time datetime="${esc(e.at)}" title="${esc(ui.dt(e.at))}">${esc(ui.rel(e.at))}</time></li>`).join('')}</ul>`;
    const question = r.info_at ? events.filter((e) => e.action === 'info_asked').at(-1) : null;
    const isRequester = r.requested_by === u.id || (u.role === 'admin' && r.requested_by !== u.id && !mayDecide);
    // the requester answers the question
    const answerCard = question && (r.requested_by === u.id || u.role === 'admin') ? `<section class="card wk-answer"><header class="card__head"><div><h2>${esc(tr('wk|A question for you'))}</h2><p>${esc(tr('wk|{name} asks:', { name: question.name || '—' }))}</p></div></header><div class="card__body"><q class="wk-q">${esc(question.note || '')}</q>${ui.form(`/admin/approvals/${r.id}/answer`, csrf, `${ui.textarea('answer', tr('wk|Your answer'), '', { rows: 3 })}${ui.btn(esc(tr('wk|Send the answer')), { cls: 'btn--primary', ic: 'chat' })}`, { cls: 'stack' })}</div></section>` : '';
    const decideCard = mayDecide ? `<section class="card apr-decide wk-decide"><header class="card__head"><div><h2>${esc(tr('apr|Your decision'))}</h2><p class="wk-decide__what"><b>${r.amount ? ui.money(r.amount) : ''}</b> ${esc(tr('wk|asked by {name}', { name: r.requester || '—' }))}</p><p>${esc(stepText(r))}${as.onBehalf ? ` · ${esc(tr('wk|for {name}, who is away', { name: as.onBehalf.name }))}` : u.role === 'admin' && !fits(u, r.steps[r.step].who) && !fitsEscalated(u, r) ? ` · ${esc(tr('apr|as an administrator'))}` : ''}</p></div>${slaChip(r)}</header><div class="card__body">
      ${question ? `<p class="alert alert--info">${esc(tr('wk|Waiting for {name} to answer: {q}', { name: r.requester || '—', q: question.note || '' }))}</p>` : ''}
      ${ui.form(`/admin/approvals/${r.id}/decide`, csrf, `
      ${ui.textarea('note', tr('wk|Note (needed to reject or ask)'), '', { rows: 3 })}
      <div class="apr-btns wk-btns">${ui.btn(esc(tr('apr|Approve')), { cls: 'btn--primary apr-yes', ic: 'check', attrs: { name: 'decision', value: 'approved' } })}${ui.btn(esc(tr('apr|Reject')), { cls: 'btn--danger apr-no', ic: 'x', attrs: { name: 'decision', value: 'rejected' } })}${question ? '' : ui.btn(esc(tr('wk|Ask for more info')), { cls: 'btn--ghost wk-ask', ic: 'chat', attrs: { name: 'decision', value: 'info' } })}</div>`, { cls: 'stack' })}
      <div class="wk-decide__more">${r.claimed_by === u.id ? ui.form(`/admin/approvals/${r.id}/claim`, csrf, `<input type="hidden" name="on" value="0">${ui.btn(esc(tr('wk|Let it go')), { cls: 'btn--ghost btn--sm', ic: 'people' })}`) : ui.form(`/admin/approvals/${r.id}/claim`, csrf, `<input type="hidden" name="on" value="1">${ui.btn(esc(tr("wk|I'm on it")), { cls: 'btn--ghost btn--sm', ic: 'people' })}`)}</div>
      </div></section>` : '';
    const manage = r.status === 'pending' && allowed(u, 'manager') ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${esc(tr('wk|Manage'))}</span></summary>
      ${ui.form(`/admin/approvals/${r.id}/reassign`, csrf, `${ui.select('who', tr('wk|Hand this step to'), whoOptions().filter((o) => o[0] !== `user:${r.requested_by}`), (r.steps[r.step] || {}).who)}${ui.btn(esc(tr('wk|Hand it over')), { cls: 'btn--ghost btn--sm', ic: 'arrow' })}`, { cls: 'stack' })}
      ${ui.form(`/admin/approvals/${r.id}/priority`, csrf, `${ui.select('priority', tr('wk|Priority'), Object.fromEntries(Object.entries(PRIORITY).map(([k, v]) => [k, tr(v[0])])), r.priority || '', { blank: tr('wk|Automatic') })}${ui.btn(esc(tr('wk|Set')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })}
    </details>` : '';
    const withdrawForm = r.status === 'pending' && (u.id === r.requested_by || u.role === 'admin')
      ? `<details class="danger"><summary>${esc(tr('apr|Withdraw the request'))}</summary>${ui.form(`/admin/approvals/${r.id}/withdraw`, csrf, `${ui.input('note', tr('apr|Why (optional)'), '')}${ui.btn(esc(tr('apr|Withdraw the request')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('apr|Withdraw this request? Nothing will be done.') } })}`, { cls: 'stack' })}</details>` : '';
    const comment = ui.card(tr('apr|Add a comment'), ui.form(`/admin/approvals/${r.id}/comment`, csrf, `${ui.textarea('note', tr('apr|Comment'), '', { rows: 2 })}${ui.btn(esc(tr('apr|Add the comment')), { cls: 'btn--ghost btn--sm', ic: 'chat' })}`, { cls: 'stack' }));
    const waitNote = r.status === 'pending' && !mayDecide && !answerCard
      ? `<div class="alert alert--warn">${esc(question ? tr('wk|Waiting for {name} to answer: {q}', { name: r.requester || '—', q: question.note || '' }) : r.requested_by === u.id ? tr('apr|Waiting for {who}.', { who: whoLabel(r.steps[r.step].who) }) : tr('apr|This step is for {who}.', { who: whoLabel(r.steps[r.step].who) }))}</div>` : '';
    void isRequester;
    h.page(req, res, {
      title: titleOf(r), crumbs: [...HUB(), ['/admin/approvals', tr('apr|Approvals')], [null, r.ref]], active: '/admin/work',
      body: `<div class="apr-detail">
        <div class="apr-detail__act stack">${answerCard}${decideCard}${waitNote}${comment}${manage}${withdrawForm}</div>
        <div class="apr-detail__main stack">${ui.card(titleOf(r), facts + extra, { action: `${r.status === 'pending' ? priorityBadge(prio) : ''} ${badge(r.status)}`, sub: `<bdi>${esc(r.ref)}</bdi> · ${esc(kindLabel(r.kind))}` })}${ui.card(tr('apr|Steps'), `<ol class="list apr-steps">${stepItems}</ol>`)}${ui.card(tr('apr|History'), history)}</div>
      </div>`,
    });
  });
  const fail = (req, res, id, e) => h.back(req, res, `/admin/approvals/${id}`, 'error', /^(apr|wk)\|/.test(String(e.message)) ? tr(e.message) : tr('apr|That could not be done: {error}', { error: e.message }));
  router.post('/approvals/:id/decide', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    const note = h.str(req.body.note, 1000) || null;
    if (req.body.decision === 'info') {
      try {
        askInfo(id, req.user, note);
      } catch (e) {
        return fail(req, res, id, e);
      }
      h.log(req, 'Asked for more information', 'approval', id, `${r.ref} · ${r.title}`);
      return h.back(req, res, backTo(req, `/admin/approvals/${id}`), 'ok', tr('wk|Question sent to {name}. The clock is paused until they answer.', { name: r.requester || '—' }));
    }
    const decision = req.body.decision === 'approved' ? 'approved' : req.body.decision === 'rejected' ? 'rejected' : null;
    try {
      const after = decide(id, req.user, decision, note);
      h.log(req, decision === 'approved' ? 'Approved a request' : 'Rejected a request', 'approval', id, `${r.ref} · ${r.title}`);
      const msg = after.status === 'approved' ? tr('apr|Approved. {name} has been told.', { name: r.requester || '—' })
        : after.status === 'rejected' ? tr('apr|Not approved. {name} has been told.', { name: r.requester || '—' })
          : tr('apr|Approved for step {n}. It now goes to {who}.', { n: r.step + 1, who: whoLabel(after.steps[after.step].who) });
      h.back(req, res, backTo(req, waitingFor(req.user).length ? '/admin/approvals?tab=todo' : `/admin/approvals/${id}`), 'ok', msg);
    } catch (e) {
      fail(req, res, id, e);
    }
  });
  router.post('/approvals/:id/answer', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    try {
      answerInfo(id, req.user, h.str(req.body.answer, 1000));
    } catch (e) {
      return fail(req, res, id, e);
    }
    h.log(req, 'Answered a question on a request', 'approval', id, r.ref);
    h.back(req, res, backTo(req, `/admin/approvals/${id}`), 'ok', tr('wk|Answer sent. The clock runs again.'));
  });
  router.post('/approvals/:id/claim', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    try {
      claim(id, req.user, req.body.on !== '0');
    } catch (e) {
      return fail(req, res, id, e);
    }
    h.back(req, res, backTo(req, `/admin/approvals/${id}`), 'ok', req.body.on !== '0' ? tr("wk|It's yours: the others see you are on it.") : tr('wk|Let go.'));
  });
  router.post('/approvals/:id/reassign', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    const who = String(req.body.who || '');
    if (!new Set(whoOptions().map((o) => o[0])).has(who)) return h.back(req, res, `/admin/approvals/${id}`, 'error', tr('wk|Choose who decides this step.'));
    try {
      reassign(id, req.user, who);
    } catch (e) {
      return fail(req, res, id, e);
    }
    h.log(req, 'Reassigned a request', 'approval', id, `${r.ref} → ${whoLabel(who)}`);
    h.back(req, res, `/admin/approvals/${id}`, 'ok', tr('wk|Handed to {who}. They have been told.', { who: whoLabel(who) }));
  });
  router.post('/approvals/:id/priority', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    try {
      setPriority(id, req.user, String(req.body.priority || ''));
    } catch (e) {
      return fail(req, res, id, e);
    }
    h.log(req, 'Changed a request priority', 'approval', id, r.ref);
    h.back(req, res, `/admin/approvals/${id}`, 'ok', tr('wk|Priority saved.'));
  });
  router.post('/approvals/:id/withdraw', (req, res, next) => {
    const id = h.int(req.params.id);
    const r = requestOf(id);
    if (!r) return next();
    try {
      withdraw(id, req.user, h.str(req.body.note, 500) || null);
    } catch (e) {
      return fail(req, res, id, e);
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
    emit('comment', requestOf(id), req.user, { note });
    h.back(req, res, backTo(req, `/admin/approvals/${id}`), 'ok', tr('apr|Comment added.'));
  });
};

module.exports.KINDS = KINDS;
module.exports.STATUS = STATUS;
module.exports.PRIORITY = PRIORITY;
