'use strict';

// Users & permissions (/admin/people): who works in the office and exactly what each person may do.
//
//   People      the directory: invite by email, add directly, edit, deactivate, reset passwords,
//               sign people out, unlock, see their sessions and sign-in history
//   Roles       built-in roles, ready templates and custom roles with a permission matrix
//               (every module × none / view / edit / full) and capabilities (export, HR, finance,
//               manage people, give access) and approval limits
//   Access      per person: the final matrix with where each cell comes from, permanent changes,
//               temporary access with an end date, and "can this person open …?"
//   Review      every person × module, dormant accounts, powerful rights, the quarterly certification
//   History     every change: who, when, before → after
//
// Who may do it: "Manage people" to invite and edit people; "Give access" to change roles, the matrix
// and anyone's access. Nobody gives more than they have, only administrators make administrators,
// and nobody changes their own access. With the two-person rule on, sensitive changes (an
// administrator, full access to accounting, HR, settings or people, the HR, finance, manage-people or
// give-access capabilities) wait for a second administrator in Approvals.
//
// The engine itself is access.js (h.access); routes/core.js enforces it on every request.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('../db');
const i18n = require('../i18n');

const { t: tr, tn, english } = i18n;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const LEVEL = { none: ['ppl|No access', 'mute'], view: ['ppl|View', 'sky'], edit: ['ppl|Edit', 'sea'], full: ['ppl|Full', 'forest'] };
const LEVEL_HINT = { none: 'ppl|Not in the menu; pages answer "no access"', view: 'ppl|Opens pages, changes nothing', edit: 'ppl|Creates and changes records', full: 'ppl|Also deletes, voids, cancels, reverses and approves' };
const CAP = {
  export: ['ppl|Export data', 'ppl|Download CSV files and print documents.'],
  hr: ['ppl|HR & salaries', 'ppl|Staff files, pay, leave and salary advances.'],
  finance: ['ppl|Finance', 'ppl|Accounting, banks and financial reports.'],
  manage_users: ['ppl|Manage people', 'ppl|Invite, edit, deactivate and sign out people.'],
  grant: ['ppl|Give access', 'ppl|Change roles, the permission matrix and what each person can open.'],
};
const SOURCE = {
  admin: 'ppl|Administrator', always: 'ppl|Always open', capability: 'ppl|From Manage people or Give access', role: 'ppl|From the role',
  hidden: 'ppl|Hidden on the Team page', override: 'ppl|Set for this person', temporary: 'ppl|Temporary', flag: 'ppl|Switched on for this person',
};
const BLOCK = { hr: 'ppl|Needs HR & salaries', finance: 'ppl|Needs Finance', manager: 'ppl|Needs the manager rank', admin: 'ppl|Administrators only' };
const RANK = { viewer: 'ppl|Viewer', agent: 'ppl|Agent', manager: 'ppl|Manager', admin: 'ppl|Administrator' };
const RANK_HINT = { viewer: 'ppl|Reads only, whatever the matrix says', agent: 'ppl|Works leads, offers and day-to-day records', manager: 'ppl|Also approves offers, signs leases and takes payments' };
const STATUS = { active: ['ppl|Active', 'ok'], deactivated: ['ppl|Deactivated', 'mute'], locked: ['ppl|Locked', 'rose'], invited: ['ppl|Invited', 'amber'] };
const HIST = {
  role: 'ppl|Role changed', access: 'ppl|Access changed', temp: 'ppl|Temporary access given', temp_ended: 'ppl|Temporary access ended', temp_removed: 'ppl|Temporary access removed',
  role_created: 'ppl|Role created', role_changed: 'ppl|Role changed (matrix)', role_archived: 'ppl|Role archived', role_restored: 'ppl|Role restored',
  deactivated: 'ppl|Deactivated', reactivated: 'ppl|Reactivated', invited: 'ppl|Invited', joined: 'ppl|Joined', unlocked: 'ppl|Unlocked', signed_out: 'ppl|Signed out everywhere',
  requested: 'ppl|Sent for approval', rejected: 'ppl|Not approved', certified: 'ppl|Access certified', created: 'ppl|Added', details: 'ppl|Details edited', reset: 'ppl|Password link sent',
};
const DECISION = { keep: ['ppl|Keep as is', 'ok'], change: ['ppl|Needs a change', 'amber'], remove: ['ppl|Remove access', 'rose'] };
const COLORS = ['sea', 'forest', 'cocoa', 'sky', 'amber', 'rose', 'sand'];
const COLOR_NAME = { sea: 'ppl|Sea green', forest: 'ppl|Forest', cocoa: 'ppl|Cocoa', sky: 'ppl|Sky blue', amber: 'ppl|Amber', rose: 'ppl|Rose', sand: 'ppl|Sand' };
const KIND_FALLBACK = { writeoff: 'apr|Write-off', refund: 'apr|Refund', purchase: 'apr|Purchase', advance: 'apr|Salary advance', media_discount: 'apr|Advertising discount' };

const VERSION = (() => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'admin', 'people.js'))).digest('hex').slice(0, 10);
  } catch {
    return '1';
  }
})();

module.exports = function people(router, h) {
  const { db, ui, M, auth } = h;
  const engine = h.access.engine;
  const esc = ui.esc;
  const nowIso = () => new Date().toISOString();
  const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
  const site = () => String((h.env && h.env.SITE_URL) || '').replace(/\/$/, '');
  const setting = (k, d) => {
    const v = Number(db.setting(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const dormantDays = () => setting('ppl_dormant_days', 60);
  const inviteDays = () => setting('ppl_invite_days', 7);

  // ---------- typed fields, housekeeping ----------
  (h.auditTyped = h.auditTyped || []).push('SELECT name, description FROM ppl_roles', 'SELECT reason FROM ppl_overrides', 'SELECT note FROM ppl_history', 'SELECT note FROM ppl_reviews', 'SELECT name, title, email FROM ppl_invites');
  if (h.every) h.every('access-expiry', 5 * 60 * 1000, () => engine.sweep(), { first: 60 * 1000 });
  const canManage = (req) => engine.has(req.user, 'manage_users');
  const canGrant = (req) => engine.has(req.user, 'grant');
  const isAdmin = (u) => !!u && u.role === 'admin';
  const RM = (req, res, next) => (canManage(req) ? next() : auth.denied(req, res));
  const RG = (req, res, next) => (canGrant(req) ? next() : auth.denied(req, res));
  const RMG = (req, res, next) => (canManage(req) || canGrant(req) ? next() : auth.denied(req, res));
  h.count('people', (user) => {
    if (!engine.has(user, 'manage_users') && !engine.has(user, 'grant')) return 0;
    const locked = db.value('SELECT COUNT(*) FROM users WHERE active = 1 AND locked_until > ?', nowIso());
    const waiting = h.approvals && isAdmin(user) ? db.value("SELECT COUNT(*) FROM apr_requests WHERE kind = 'access' AND status = 'pending' AND COALESCE(requested_by, 0) != ?", user.id) : 0;
    return locked + waiting;
  });

  // ---------- labels ----------
  const levelPill = (l, extra = '') => `<span class="ppl-lv ppl-lv--${esc(l)}"${extra}>${esc(tr(LEVEL[l][0]))}</span>`;
  const capName = (c) => tr((CAP[c] || [c])[0]);
  const kinds = () => {
    const k = h.approvals && h.approvals.KINDS ? h.approvals.KINDS : KIND_FALLBACK;
    return Object.entries(k).filter(([key]) => !['access', 'other'].includes(key));
  };
  const kindName = (k) => tr((h.approvals && h.approvals.KINDS && h.approvals.KINDS[k]) || KIND_FALLBACK[k] || k);
  const moduleName = (href) => {
    const e = engine.moduleOf(href);
    return e ? tr(e.label) : href;
  };
  const roleKeyOf = (u) => (u.role === 'admin' || !u.role_id ? u.role : `role:${u.role_id}`);
  const roleByKey = (key) => (String(key).startsWith('role:') ? engine.customRole(Number(String(key).slice(5))) : engine.builtinRole(key));
  const roleNameByKey = (key) => {
    const r = key ? roleByKey(key) : null;
    return r ? engine.roleName(r) : tr('ppl|A role that no longer exists');
  };
  // a role's description; a template's untouched one in the reader's language
  const roleDesc = (role) => {
    if (!role || role.builtin) return '';
    const t = role.template && engine.TEMPLATES[role.template];
    return t && role.description === english(t.desc) ? tr(t.desc) : role.description || '';
  };
  const roleBadge = (role) => (role.builtin ? ui.badge(role.key, engine.roleName(role)) : `<span class="badge badge--${esc(role.color || 'sea')} ppl-rolebadge">${ui.icon('shield')}${esc(engine.roleName(role))}</span>`);
  const statusOf = (u) => (!u.active ? 'deactivated' : u.locked_until && u.locked_until > nowIso() ? 'locked' : 'active');
  const statusBadge = (u) => {
    const s = statusOf(u);
    return ui.badge(s, tr(STATUS[s][0]), STATUS[s][1]);
  };
  const avatar = (u, cls = '') => `<span class="avatar ${cls}">${esc(ui.initials(u.name || u.email || '?'))}</span>`;
  const dormant = (u) => u.active && (!u.last_login_at || u.last_login_at < new Date(Date.now() - dormantDays() * 86400000).toISOString());
  const capChips = (eff) => CAPS_SHOWN.filter((c) => eff.caps[c] && eff.caps[c].on).map((c) => `<span class="ppl-chip ppl-chip--${c}">${esc(capName(c))}</span>`).join('');
  const CAPS_SHOWN = ['hr', 'finance', 'manage_users', 'grant', 'export'];
  const countOpen = (eff) => Object.values(eff.modules).filter((m) => m.level !== 'none').length;
  // a person's device in a few words, from the browser's user agent
  const device = (ua) => {
    const s = String(ua || '');
    if (!s) return tr('ppl|Unknown device');
    const b = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : /node|undici|curl/i.test(s) ? 'Script' : 'Browser';
    const o = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
    const AR_NAMES = { Edge: 'إيدج', Opera: 'أوبرا', Chrome: 'كروم', Firefox: 'فايرفوكس', Safari: 'سفاري', Script: 'برنامج آلي', Browser: 'متصفح', iOS: 'آيفون', Android: 'أندرويد', Windows: 'ويندوز', macOS: 'ماك', Linux: 'لينكس' };
    const n = (x) => (i18n.isAr() ? AR_NAMES[x] || x : x);
    return o ? `${n(b)} · ${n(o)}` : n(b);
  };
  const until = (iso) => `<time class="ppl-until" data-until="${esc(iso)}" title="${esc(ui.dt(iso))}">${esc(tr('ppl|until {when}', { when: ui.dt(iso) }))}</time>`;

  // ---------- history ----------
  function history({ user_id = null, role_id = null, actor = null, approved_by = null, action, changes = [], note = null, demo = 0, at = null }) {
    db.run('INSERT INTO ppl_history (user_id, role_id, actor_id, approved_by, action, changes, note, at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      user_id, role_id, actor ? actor.id || actor : null, approved_by ? approved_by.id || approved_by : null, action, changes.length ? JSON.stringify(changes) : null, note ? String(note).slice(0, 500) : null, at || nowIso(), demo ? 1 : 0);
  }
  h.peopleHistory = history;
  const changeText = (c) => {
    const lvl = (l) => (l ? tr(LEVEL[l] ? LEVEL[l][0] : 'ppl|From the role') : tr('ppl|From the role'));
    if (c.kind === 'module') return `${moduleName(c.key)}: ${lvl(c.from)} → ${c.to === null && c.until === undefined ? lvl(null) : lvl(c.to)}${c.until ? ` (${tr('ppl|until {when}', { when: ui.dt(c.until) })})` : ''}`;
    if (c.kind === 'cap') {
      const v = (x) => (x === null || x === undefined ? tr('ppl|From the role') : x === 'on' || x === true ? tr('ppl|On') : tr('ppl|Off'));
      return `${capName(c.key)}: ${v(c.from)} → ${v(c.to)}${c.until ? ` (${tr('ppl|until {when}', { when: ui.dt(c.until) })})` : ''}`;
    }
    if (c.kind === 'role') return `${c.from ? roleNameByKey(c.from) : '—'} → ${roleNameByKey(c.to)}`;
    if (c.kind === 'base') return `${tr('ppl|Rank')}: ${tr(RANK[c.from] || 'ppl|Agent')} → ${tr(RANK[c.to] || 'ppl|Agent')}`;
    if (c.kind === 'limit') return `${kindName(c.key)}: ${c.from === null || c.from === undefined ? '—' : ui.money(c.from)} → ${c.to === null || c.to === undefined ? '—' : ui.money(c.to)}`;
    if (c.kind === 'flag') return `${capName(c.key)}: ${c.to ? tr('ppl|On') : tr('ppl|Off')}`;
    if (c.kind === 'name') return `${tr('ppl|Name')}: ${c.to}`;
    if (c.kind === 'review') return `${c.key}: ${tr((DECISION[c.to] || ['ppl|Keep as is'])[0])}`;
    return '';
  };
  const historyTable = (rows, { showUser = true } = {}) => ui.table([
    { label: tr('ppl|When'), sort: (r) => r.at, render: (r) => `<span class="nowrap">${esc(ui.dt(r.at))}</span>` },
    ...(showUser ? [{ label: tr('ppl|Who or what'), render: (r) => (r.user_id ? `<a href="/admin/people/${r.user_id}">${esc(r.user_name || '—')}</a>` : r.role_id ? `<a href="/admin/people/roles/${r.role_id}">${esc(r.role_name ? engine.roleName(engine.customRole(r.role_id) || { name: r.role_name }) : '—')}</a>` : '—') }] : []),
    { label: tr('ppl|Change'), render: (r) => {
      const list = (() => {
        try {
          return r.changes ? JSON.parse(r.changes) : [];
        } catch {
          return [];
        }
      })();
      return `<b>${esc(tr(HIST[r.action] || 'ppl|Access changed'))}</b>${list.length ? `<ul class="ppl-diff">${list.slice(0, 8).map((c) => `<li>${esc(changeText(c))}</li>`).join('')}${list.length > 8 ? `<li class="muted">${esc(tn(list.length - 8, 'ppl|and {n} more', 'ppl|and {n} more'))}</li>` : ''}</ul>` : ''}${r.note ? `<small class="sub">${esc(String(r.note).startsWith('ppl|') ? tr(r.note) : r.note)}</small>` : ''}`;
    } },
    { label: tr('ppl|By'), render: (r) => `${esc(r.actor_name || tr('System'))}${r.approver_name ? `<small class="sub">${esc(tr('ppl|approved by {name}', { name: r.approver_name }))}</small>` : ''}` },
  ], rows, { empty: esc(tr('ppl|No changes yet.')) });
  const historyRowsBy = (order, where = '', ...args) => db.all(`SELECT x.*, u.name user_name, a.name actor_name, p.name approver_name, r.name role_name FROM ppl_history x
    LEFT JOIN users u ON u.id = x.user_id LEFT JOIN users a ON a.id = x.actor_id LEFT JOIN users p ON p.id = x.approved_by LEFT JOIN ppl_roles r ON r.id = x.role_id
    ${where} ORDER BY ${order} LIMIT 300`, ...args);
  const historyRows = (where = '', ...args) => historyRowsBy('x.at DESC, x.id DESC', where, ...args);

  // ---------- applying changes (directly, or after a second administrator approved) ----------
  // op: { op: 'role', user_id, role, hr, finance } | { op: 'overrides', user_id, modules: {href: level|null}, caps: {cap: 'on'|'off'|null} }
  //     { op: 'temp', user_id, subject, key, level, until, reason } | { op: 'role_save', role_id|null, fields } | { op: 'invite', ... }
  function applyOp(op, actor, { approver = null } = {}) {
    let result = null;
    db.tx(() => {
      if (op.op === 'role') {
        const u = db.get('SELECT * FROM users WHERE id = ?', op.user_id);
        if (!u) throw new Error('ppl|There is no such person.');
        const before = roleKeyOf(u);
        const changes = [];
        if (String(op.role).startsWith('role:')) {
          const r = engine.customRole(Number(String(op.role).slice(5)));
          if (!r || r.archived) throw new Error('ppl|That role is not available.');
          db.run('UPDATE users SET role = ?, role_id = ? WHERE id = ?', r.base, r.id, u.id);
        } else {
          const key = engine.BUILTIN.includes(op.role) ? op.role : 'agent';
          db.run('UPDATE users SET role = ?, role_id = NULL WHERE id = ?', key, u.id);
          if (op.hr !== undefined && !!op.hr !== !!u.hr) changes.push({ kind: 'flag', key: 'hr', from: !!u.hr, to: !!op.hr });
          if (op.finance !== undefined && !!op.finance !== !!u.finance) changes.push({ kind: 'flag', key: 'finance', from: !!u.finance, to: !!op.finance });
          if (op.hr !== undefined) db.run('UPDATE users SET hr = ?, finance = ? WHERE id = ?', op.hr ? 1 : 0, op.finance ? 1 : 0, u.id);
        }
        engine.touch();
        engine.syncFlags(u.id);
        const after = roleKeyOf(db.get('SELECT * FROM users WHERE id = ?', u.id));
        if (before !== after) changes.unshift({ kind: 'role', key: after, from: before, to: after });
        if (changes.length) history({ user_id: u.id, actor, approved_by: approver, action: 'role', changes });
        db.audit(actor, 'Changed someone\'s role', 'user', u.id, `${u.name}: ${english(roleNameByKey(after))}`);
      } else if (op.op === 'overrides') {
        const u = db.get('SELECT * FROM users WHERE id = ?', op.user_id);
        if (!u) throw new Error('ppl|There is no such person.');
        const changes = [];
        const current = db.all('SELECT * FROM ppl_overrides WHERE user_id = ? AND expires_at IS NULL', u.id);
        const hidden = ui.hiddenModules(u);
        for (const [href, level] of Object.entries(op.modules || {})) {
          const old = current.find((o) => o.subject === 'module' && o.key === href);
          const from = old ? old.level : hidden.has(href) ? 'none' : null;
          if ((from || null) === (level || null)) continue;
          db.run("DELETE FROM ppl_overrides WHERE user_id = ? AND subject = 'module' AND key = ? AND expires_at IS NULL", u.id, href);
          if (level) db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, reason, granted_by, created_at) VALUES (?, 'module', ?, ?, ?, ?, ?)", u.id, href, level, op.reason || null, actor ? actor.id : null, nowIso());
          changes.push({ kind: 'module', key: href, from, to: level || null });
        }
        for (const [c, v] of Object.entries(op.caps || {})) {
          const old = current.find((o) => o.subject === 'cap' && o.key === c);
          const from = old ? old.level : null;
          if ((from || null) === (v || null)) continue;
          db.run("DELETE FROM ppl_overrides WHERE user_id = ? AND subject = 'cap' AND key = ? AND expires_at IS NULL", u.id, c);
          if (v) db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, reason, granted_by, created_at) VALUES (?, 'cap', ?, ?, ?, ?, ?)", u.id, c, v, op.reason || null, actor ? actor.id : null, nowIso());
          changes.push({ kind: 'cap', key: c, from, to: v || null });
        }
        // the Team page's hidden modules now live here
        if (u.hidden_modules) db.run('UPDATE users SET hidden_modules = NULL WHERE id = ?', u.id);
        for (const href of hidden) {
          if (op.modules && Object.prototype.hasOwnProperty.call(op.modules, href)) continue;
          db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, reason, granted_by, created_at) VALUES (?, 'module', ?, 'none', 'Hidden on the Team page', ?, ?)", u.id, href, actor ? actor.id : null, nowIso());
        }
        engine.touch();
        if (changes.length) {
          history({ user_id: u.id, actor, approved_by: approver, action: 'access', changes, note: op.reason });
          db.audit(actor, 'Changed access', 'user', u.id, u.name);
        }
        result = changes.length;
      } else if (op.op === 'temp') {
        const u = db.get('SELECT * FROM users WHERE id = ?', op.user_id);
        if (!u) throw new Error('ppl|There is no such person.');
        db.run('INSERT INTO ppl_overrides (user_id, subject, key, level, expires_at, reason, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', u.id, op.subject, op.key, op.level, op.until, op.reason || null, actor ? actor.id : null, nowIso());
        engine.touch();
        history({ user_id: u.id, actor, approved_by: approver, action: 'temp', changes: [{ kind: op.subject, key: op.key, from: null, to: op.level, until: op.until }], note: op.reason });
        db.audit(actor, 'Gave temporary access', 'user', u.id, u.name);
      } else if (op.op === 'role_save') {
        result = saveRole(op.role_id, op.fields, actor, approver);
      } else if (op.op === 'invite') {
        result = createInvite(op, actor);
      } else throw new Error('ppl|Unknown change.');
    });
    return result;
  }

  // ---------- roles ----------
  function readRoleForm(body, base = null) {
    const f = {
      name: h.str(body.name, 80) || (base ? base.name : ''),
      description: h.str(body.description, 300) || null,
      base: ['viewer', 'agent', 'manager'].includes(body.base) ? body.base : 'agent',
      default_level: engine.LEVELS.includes(body.default_level) ? body.default_level : 'none',
      color: COLORS.includes(body.color) ? body.color : 'sea',
      template: h.str(body.template, 40) || (base ? base.template : null) || null,
      matrix: {}, caps: {}, limits: {},
    };
    for (const e of engine.modules()) {
      if (e.href === '/admin' || e.href === '/admin/help' || e.href === '/admin/people') continue;
      const v = body[`m:${e.href}`];
      f.matrix[e.href] = engine.LEVELS.includes(v) ? v : 'none';
    }
    for (const c of engine.CAPS) f.caps[c] = body[`cap_${c}`] === '1';
    for (const [k] of kinds()) {
      const v = body[`lim_${k}`];
      if (v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) f.limits[k] = Math.round(Number(v) * 100) / 100;
    }
    return f;
  }
  const roleAsGrant = (f) => ({ base: f.base, modules: f.matrix, caps: f.caps, limits: f.limits });
  // what changes between a role as it is and as it would be (for the preview and the history)
  function roleDiff(before, f) {
    const out = [];
    if (!before) return out;
    if (before.base !== f.base) out.push({ kind: 'base', key: 'base', from: before.base, to: f.base });
    for (const [href, level] of Object.entries(f.matrix)) {
      const was = engine.roleLevel(before, href);
      if (was !== level) out.push({ kind: 'module', key: href, from: was, to: level });
    }
    for (const c of engine.CAPS) if (!!before.caps[c] !== !!f.caps[c]) out.push({ kind: 'cap', key: c, from: before.caps[c] ? 'on' : 'off', to: f.caps[c] ? 'on' : 'off' });
    const lims = new Set([...Object.keys(before.caps.limits || {}), ...Object.keys(f.limits)]);
    for (const k of lims) {
      const a = before.caps.limits ? before.caps.limits[k] : undefined;
      const b = f.limits[k];
      if ((a ?? null) !== (b ?? null)) out.push({ kind: 'limit', key: k, from: a ?? null, to: b ?? null });
    }
    return out;
  }
  function saveRole(roleId, f, actor, approver = null) {
    const t = nowIso();
    const caps = { ...f.caps, limits: f.limits };
    let id = roleId;
    if (id) {
      const before = engine.customRole(id);
      if (!before) throw new Error('ppl|There is no such role.');
      const diff = roleDiff(before, f);
      db.run('UPDATE ppl_roles SET name = ?, description = ?, base = ?, matrix = ?, caps = ?, default_level = ?, color = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        f.name, f.description, f.base, JSON.stringify(f.matrix), JSON.stringify(caps), f.default_level, f.color, actor ? actor.id : null, t, id);
      if (before.name !== f.name) diff.unshift({ kind: 'name', key: 'name', from: before.name, to: f.name });
      engine.touch();
      // the role's people take its rank and HR/finance switches
      for (const u of db.all('SELECT id FROM users WHERE role_id = ? AND role != \'admin\'', id)) {
        db.run('UPDATE users SET role = ? WHERE id = ?', f.base, u.id);
        engine.syncFlags(u.id);
      }
      if (diff.length) history({ role_id: id, actor, approved_by: approver, action: 'role_changed', changes: diff });
      db.audit(actor, 'Changed a role', 'ppl_role', id, f.name);
    } else {
      id = Number(db.run('INSERT INTO ppl_roles (name, description, base, matrix, caps, default_level, template, color, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        f.name, f.description, f.base, JSON.stringify(f.matrix), JSON.stringify(caps), f.default_level, f.template, f.color, actor ? actor.id : null, actor ? actor.id : null, t, t).lastInsertRowid);
      engine.touch();
      history({ role_id: id, actor, approved_by: approver, action: 'role_created', changes: [] });
      db.audit(actor, 'Created a role', 'ppl_role', id, f.name);
    }
    return id;
  }

  // ---------- invitations ----------
  function createInvite({ email, name = null, title = null, role = 'agent', role_id = null, lang = null }, actor, { demo = 0, send = true } = {}) {
    const token = crypto.randomBytes(24).toString('base64url');
    const t = nowIso();
    const expires = new Date(Date.now() + inviteDays() * 86400000).toISOString();
    const id = Number(db.run('INSERT INTO ppl_invites (kind, email, name, title, role, role_id, lang, token_hash, expires_at, created_by, created_at, demo) VALUES (\'invite\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      email.toLowerCase(), name, title, role, role_id, lang, sha(token), expires, actor ? actor.id : null, t, demo ? 1 : 0).lastInsertRowid);
    const link = `${site()}/admin/invite/${token}`;
    if (send) sendLink(id, link);
    if (!demo) db.audit(actor, 'Invited someone', 'ppl_invite', id, email);
    return { id, link };
  }
  // email the link (in the person's language) when email is set up
  function sendLink(inviteId, link) {
    const inv = db.get('SELECT * FROM ppl_invites WHERE id = ?', inviteId);
    if (!inv || inv.demo || !h.mail) return false;
    const lang = inv.lang === 'ar' ? 'ar' : 'en';
    i18n.run(lang, () => {
      const reset = inv.kind === 'reset';
      const subject = reset ? tr('ppl|Set a new password for The Wave leasing office') : tr('ppl|You are invited to The Wave leasing office');
      const line = reset ? tr('ppl|Use this link to set a new password. It works once and expires {when}.', { when: ui.dt(inv.expires_at) }) : tr('ppl|Use this link to choose your password and join. It works once and expires {when}.', { when: ui.dt(inv.expires_at) });
      try {
        h.mail.send({ to: inv.email, subject, text: `${line}\n\n${link}`, html: `<p>${esc(line)}</p><p><a href="${esc(link)}">${esc(reset ? tr('ppl|Set a new password') : tr('ppl|Join the office'))}</a></p>`, lang });
      } catch (e) {
        console.error('[people] mail not sent:', e.message);
      }
    });
    db.run('UPDATE ppl_invites SET sent_at = ?, sends = sends + 1 WHERE id = ?', nowIso(), inviteId);
    return true;
  }

  // ---------- the two-person rule (Approvals, kind 'access') ----------
  if (h.approvals && h.approvals.KINDS) {
    h.approvals.KINDS.access = 'ppl|Access change';
    if (!h.approvals.ruleOf('access')) h.approvals.setRule('access', { active: 1, min_amount: 0, steps: [{ who: 'admin' }] });
    h.approvals.onDecision('access', (r, decision, user) => {
      const op = r.payload || {};
      const requester = r.requested_by ? db.get('SELECT * FROM users WHERE id = ?', r.requested_by) : null;
      if (decision === 'approved') {
        if (!user || user.role !== 'admin') throw new Error(tr('ppl|Only an administrator can approve access changes.'));
        if (requester && requester.id === user.id) throw new Error(tr('ppl|A second administrator must approve this: you asked for it.'));
        applyOp(op, requester, { approver: user });
      } else history({ user_id: op.user_id || null, role_id: op.op === 'role_save' ? op.role_id || null : null, actor: user, action: 'rejected', changes: [], note: r.title, demo: r.demo });
    });
    if (h.approvals.describe) h.approvals.describe('access', (r) => `${tr('ppl|Access change')}: ${opText(r.payload || {})}`);
  }
  // a pending change in the reader's language
  function opText(op) {
    const u = op.user_id ? db.get('SELECT name FROM users WHERE id = ?', op.user_id) : null;
    const who = u ? u.name : op.email || '';
    if (op.op === 'role') return `${who}: ${roleNameByKey(op.role)}`;
    if (op.op === 'role_save') return `${tr('ppl|Role')}: ${op.fields ? op.fields.name : ''}`;
    if (op.op === 'invite') return `${op.email}: ${tr('ppl|Invitation as {role}', { role: roleNameByKey(op.role_id ? `role:${op.role_id}` : op.role) })}`;
    if (op.op === 'temp') return `${who}: ${changeText({ kind: op.subject, key: op.key, from: null, to: op.level, until: op.until })}`;
    if (op.op === 'overrides') {
      const list = [...Object.entries(op.caps || {}).filter(([, v]) => v).map(([k, v]) => changeText({ kind: 'cap', key: k, from: null, to: v })), ...Object.entries(op.modules || {}).filter(([, v]) => v).map(([k, v]) => changeText({ kind: 'module', key: k, from: null, to: v }))];
      return `${who}: ${list.length <= 2 ? list.join(i18n.isAr() ? '، ' : ', ') : tn(list.length, 'ppl|{n} change to the access', 'ppl|{n} changes to the access')}`;
    }
    return who;
  }
  const describeOp = (op) => {
    const u = op.user_id ? db.get('SELECT name FROM users WHERE id = ?', op.user_id) : null;
    const who = u ? u.name : op.email || '';
    if (op.op === 'role') return english(`${who}: ${roleNameByKey(op.role)}`);
    if (op.op === 'role_save') return `${op.fields.name}`;
    if (op.op === 'invite') return `${op.email}: ${english(roleNameByKey(op.role_id ? `role:${op.role_id}` : op.role))}`;
    return who;
  };
  // Give it, or send it to a second administrator. `want` is what the change gives (for the checks).
  function submit(req, res, op, want, back, okText) {
    const backTo = (out) => (typeof back === 'function' ? back(out) : back);
    const problems = engine.escalation(req.user, want);
    if (problems.length) {
      const p = problems[0];
      const what = p.kind === 'module' ? tr('ppl|{level} on {module}', { level: tr(LEVEL[p.want][0]), module: moduleName(p.key) }) : p.kind === 'cap' ? capName(p.key) : p.kind === 'base' ? tr(RANK[p.want]) : kindName(p.key);
      return h.back(req, res, backTo(null), 'error', tr('ppl|You cannot give more than you have yourself: {what}.', { what }));
    }
    if (engine.twoPerson() && engine.sensitive(want) && h.approvals) {
      const title = `${tr('ppl|Access change')}: ${describeOp(op)}`.slice(0, 190);
      const target = op.user_id ? { entity: 'user', entity_id: op.user_id, link: `/admin/people/${op.user_id}` } : op.op === 'role_save' && op.role_id ? { entity: 'ppl_role', entity_id: op.role_id, link: `/admin/people/roles/${op.role_id}` } : { entity: null, entity_id: null, link: '/admin/people' };
      const r = h.approvals.request({ kind: 'access', title, amount: 0, ...target, payload: op, user: req.user });
      history({ user_id: op.user_id || null, role_id: op.op === 'role_save' ? op.role_id || null : null, actor: req.user, action: 'requested', changes: [], note: r.ref });
      h.log(req, 'Asked to change access', op.user_id ? 'user' : 'ppl_role', op.user_id || op.role_id || null, describeOp(op));
      return h.back(req, res, backTo(null), 'ok', tr('ppl|This is a sensitive change, so it waits for a second administrator in Approvals ({ref}).', { ref: r.ref }));
    }
    try {
      const out = applyOp(op, req.user);
      return h.back(req, res, backTo(out), 'ok', typeof okText === 'function' ? okText(out) : okText);
    } catch (e) {
      return h.back(req, res, typeof back === 'function' ? '/admin/people' : back, 'error', String(e.message).startsWith('ppl|') ? tr(e.message) : e.message);
    }
  }
  // non-administrators never act on administrators, and nobody changes their own access here
  function targetProblem(req, u, { self = false } = {}) {
    if (!u) return 'ppl|There is no such person.';
    if (!self && u.id === req.user.id) return 'ppl|You cannot change your own access or status.';
    if (isAdmin(u) && !isAdmin(req.user)) return 'ppl|Only administrators can change an administrator.';
    return null;
  }
  const userOf = (id) => db.get('SELECT * FROM users WHERE id = ?', Number(id));
  // a role the actor may hand out (no escalation, administrators only by administrators)
  const roleOptions = (req, { current = null } = {}) => {
    const list = [];
    for (const r of engine.roles()) {
      if (r.builtin && r.key === 'admin' && !isAdmin(req.user)) continue;
      const key = r.builtin ? r.key : `role:${r.id}`;
      const over = engine.escalation(req.user, engine.roleGrant(r)).length > 0;
      if (over && key !== current) continue;
      list.push([key, `${engine.roleName(r)}${r.builtin ? '' : ` · ${tr('ppl|custom')}`}`]);
    }
    return list;
  };

  // ---------- the shell ----------
  const TABS = [['/admin/people', 'ppl|People'], ['/admin/people/roles', 'ppl|Roles'], ['/admin/people/invites', 'ppl|Invitations'], ['/admin/people/review', 'ppl|Access review'], ['/admin/people/history', 'ppl|History'], ['/admin/people/settings', 'ppl|Settings']];
  const tabs = (on) => `<nav class="tabs ppl-tabs">${TABS.map(([href, label]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${esc(tr(label))}</a>`).join('')}</nav>`;
  const script = `<script src="/admin/people.js?v=${VERSION}" defer></script>`;
  const shell = (req, res, { tab, title, body, actions = '', crumbs = null }) => h.page(req, res, {
    title, active: '/admin/people', wide: true, actions,
    crumbs: crumbs || (tab === '/admin/people' ? [] : [['/admin/people', tr('nav|Users & permissions')]]),
    body: `${tabs(tab)}${body}${script}`,
  });

  // ---------- people ----------
  router.get('/people', RMG, (req, res) => {
    const q = req.query;
    const search = h.str(q.q, 80).toLowerCase();
    const all = db.all('SELECT * FROM users ORDER BY active DESC, name');
    const effs = new Map(all.map((u) => [u.id, engine.effective(u)]));
    const f = h.listFilters(req, { cols: { date: 'x' }, dateLabel: tr('sort|Account created'), sorts: [['name', 'sort|Name: A to Z', ''], ['name_desc', 'sort|Name: Z to A', ''], ['login', 'sort|Last sign-in: most recent first', ''], ['newest', 'sort|Newest first', ''], ['oldest', 'sort|Oldest first', '']] });
    const rows = all.filter((u) => {
      if (f.from && String(u.created_at).slice(0, 10) < f.from) return false;
      if (f.to && String(u.created_at).slice(0, 10) > f.to) return false;
      if (search && !`${u.name} ${u.email} ${u.title || ''}`.toLowerCase().includes(search)) return false;
      if (q.role && roleKeyOf(u) !== q.role) return false;
      if (q.status === 'active' && statusOf(u) !== 'active') return false;
      if (q.status === 'deactivated' && u.active) return false;
      if (q.status === 'locked' && statusOf(u) !== 'locked') return false;
      if (q.status === 'dormant' && !dormant(u)) return false;
      if (q.status === 'temporary' && !effs.get(u.id).temp.length) return false;
      if (q.module && (!effs.get(u.id).modules[q.module] || effs.get(u.id).modules[q.module].level === 'none')) return false;
      if (q.last === 'never' && u.last_login_at) return false;
      if (['7', '30', '90'].includes(q.last) && (!u.last_login_at || u.last_login_at < new Date(Date.now() - Number(q.last) * 86400000).toISOString())) return false;
      return true;
    });
    if (f.sortKey === 'name_desc') rows.sort((a, b) => (b.active - a.active) || String(b.name).localeCompare(String(a.name)));
    else if (f.sortKey === 'login') rows.sort((a, b) => String(b.last_login_at || '').localeCompare(String(a.last_login_at || '')));
    else if (f.sortKey === 'newest') rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    else if (f.sortKey === 'oldest') rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const t = nowIso();
    const kpis = [
      ui.kpi({ label: tr('ppl|Active people'), value: ui.n0(all.filter((u) => u.active).length), href: '/admin/people?status=active', sub: esc(tn(all.filter((u) => u.active && isAdmin(u)).length, 'ppl|{n} administrator', 'ppl|{n} administrators')) }),
      ui.kpi({ label: tr('ppl|Invitations waiting'), value: ui.n0(db.value('SELECT COUNT(*) FROM ppl_invites WHERE kind = \'invite\' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', t)), href: '/admin/people/invites' }),
      ui.kpi({ label: tr('ppl|Temporary access'), value: ui.n0(db.value('SELECT COUNT(*) FROM ppl_overrides WHERE expires_at > ?', t)), href: '/admin/people?status=temporary' }),
      ui.kpi({ label: tr('ppl|Locked accounts'), value: ui.n0(db.value('SELECT COUNT(*) FROM users WHERE active = 1 AND locked_until > ?', t)), tone: db.value('SELECT COUNT(*) FROM users WHERE active = 1 AND locked_until > ?', t) ? 'kpi--alert' : '', href: '/admin/people?status=locked' }),
      ui.kpi({ label: tr('ppl|Dormant accounts'), value: ui.n0(all.filter(dormant).length), href: '/admin/people?status=dormant', sub: esc(tr('ppl|No sign-in for {n} days', { n: dormantDays() })) }),
    ].join('');
    const roleOpts = engine.roles().map((r) => [r.builtin ? r.key : `role:${r.id}`, engine.roleName(r)]);
    const filters = `<form method="get" action="/admin/people" class="filters ppl-filters">
      ${ui.input('q', tr('Search'), q.q || '', { placeholder: tr('ppl|Name, email or job title'), attrs: { type: 'search' } })}
      ${ui.select('role', tr('Role'), roleOpts, q.role || '', { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}
      ${ui.select('status', tr('Status'), [['active', tr('ppl|Active')], ['deactivated', tr('ppl|Deactivated')], ['locked', tr('ppl|Locked')], ['dormant', tr('ppl|Dormant')], ['temporary', tr('ppl|With temporary access')]], q.status || '', { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}
      ${ui.select('module', tr('ppl|Can open'), engine.modules().filter((e) => e.href !== '/admin').map((e) => [e.href, tr(e.label)]), q.module || '', { blank: tr('ppl|Any module'), attrs: { 'data-autosubmit': '' } })}
      ${ui.select('last', tr('Last sign-in'), [['7', tr('ppl|Within 7 days')], ['30', tr('ppl|Within 30 days')], ['90', tr('ppl|Within 90 days')], ['never', tr('Never')]], q.last || '', { blank: tr('ppl|Any time'), attrs: { 'data-autosubmit': '' } })}
      ${f.fields}
      <div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}${Object.values(q).some(Boolean) ? `<a class="btn btn--ghost btn--sm" href="/admin/people">${esc(tr('Clear'))}</a>` : ''}</div>${f.quick}</form>`;
    const total = engine.modules().length;
    const table = ui.table([
      { label: tr('Person'), sort: (u) => u.name, render: (u) => `<span class="who">${avatar(u, 'avatar--sm')}<span><b>${esc(u.name)}${u.id === req.user.id ? ` <span class="badge badge--mute ppl-you">${esc(tr('You'))}</span>` : ''}</b><small class="sub ltr">${esc(u.email)}</small>${u.title ? `<small class="sub">${esc(i18n.tx(u.title))}</small>` : ''}</span></span>` },
      { label: tr('Role'), sort: (u) => engine.roleName(engine.roleOf(u)), render: (u) => roleBadge(engine.roleOf(u)) },
      { label: tr('ppl|Access'), sort: (u) => countOpen(effs.get(u.id)), render: (u) => {
        const eff = effs.get(u.id);
        const n = countOpen(eff);
        return `<span class="ppl-meter" title="${esc(tr('ppl|{n} of {total} modules', { n, total }))}"><i style="width:${Math.round((n / total) * 100)}%"></i></span><small class="sub">${esc(tr('ppl|{n} of {total} modules', { n, total }))}${eff.temp.length ? ` · ${esc(tr('ppl|temporary access'))}` : ''}</small><span class="ppl-chips">${capChips(eff)}</span>`;
      } },
      { label: tr('Status'), sort: (u) => statusOf(u), render: (u) => `${statusBadge(u)}${dormant(u) ? ` ${ui.badge('dormant', tr('ppl|Dormant'), 'sand')}` : ''}` },
      { label: tr('Last sign-in'), sort: (u) => u.last_login_at || '', render: (u) => (u.last_login_at ? esc(ui.rel(u.last_login_at)) : `<span class="muted">${esc(tr('Never'))}</span>`) },
    ], rows, { href: (u) => `/admin/people/${u.id}`, empty: esc(tr('ppl|Nobody matches these filters.')) });
    const actions = [
      canManage(req) ? ui.btn(esc(tr('ppl|Invite someone')), { href: '/admin/people/new', cls: 'btn--primary', ic: 'plus' }) : '',
      canGrant(req) ? ui.btn(esc(tr('ppl|New role')), { href: '/admin/people/roles/new', cls: 'btn--ghost', ic: 'shield' }) : '',
    ].join('');
    shell(req, res, { tab: '/admin/people', title: tr('nav|Users & permissions'), actions, body: `<div class="kpis kpis--5">${kpis}</div>${filters}${ui.card(tr('ppl|Everyone with an account'), table, { sub: esc(tn(rows.length, 'ppl|{n} person', 'ppl|{n} people')) })}` });
  });

  // ---------- inviting and adding ----------
  router.get('/people/new', RM, (req, res) => {
    const csrf = req.session.csrf;
    const opts = roleOptions(req);
    const roleField = (name) => ui.select(name, tr('Role'), opts, opts.find(([k]) => k === 'agent') ? 'agent' : (opts[0] || [''])[0]);
    const invite = ui.card(tr('ppl|Invite by email'), ui.form('/admin/people/invite', csrf, `<p class="muted">${esc(tr('ppl|They get a link that works once and expires in {n} days. They choose their own password; you never see it.', { n: inviteDays() }))}</p>
      <div class="fields">${ui.input('email', tr('Email'), '', { type: 'email', required: true, attrs: { class: 'ltr' } })}${ui.input('name', tr('Name'), '', { placeholder: tr('ppl|Optional, they can type it') })}${roleField('role')}${ui.input('title', tr('Job title'), '', { placeholder: tr('e.g. Leasing executive') })}${ui.select('lang', tr('ppl|Email language'), [['en', 'English'], ['ar', 'العربية']], i18n.isAr() ? 'ar' : 'en')}</div>
      ${ui.btn(esc(tr('ppl|Send the invitation')), { cls: 'btn--primary', ic: 'mail' })}`, { cls: 'stack' }), { sub: esc(tr('ppl|Recommended')) });
    const direct = ui.card(tr('ppl|Add directly'), ui.form('/admin/people/create', csrf, `<p class="muted">${esc(tr('ppl|For someone without email at hand: a temporary password is shown to you once, to pass on in person.'))}</p>
      <div class="fields">${ui.input('name', tr('Name'), '', { required: true })}${ui.input('email', tr('Email'), '', { type: 'email', required: true, attrs: { class: 'ltr' } })}${roleField('role')}${ui.input('title', tr('Job title'), '')}</div>
      ${ui.btn(esc(tr('Add to the team')), { cls: 'btn--ghost' })}`, { cls: 'stack' }));
    const help = ui.card(tr('ppl|Which role?'), `<ul class="ppl-rolehelp">${engine.roles().filter((r) => opts.some(([k]) => k === (r.builtin ? r.key : `role:${r.id}`))).map((r) => {
      const eff = r.builtin ? null : r;
      return `<li>${roleBadge(r)}<span>${esc(r.builtin ? tr(RANK_HINT[r.key] || 'ppl|Everything, including settings and people') : roleDesc(eff) || tr('ppl|Custom role'))}</span></li>`;
    }).join('')}</ul>`);
    shell(req, res, { tab: '/admin/people', title: tr('ppl|Invite someone'), crumbs: [['/admin/people', tr('nav|Users & permissions')]], body: `<div class="grid grid--side"><div class="stack">${invite}${direct}</div><div class="stack">${help}</div></div>` });
  });
  const parseRole = (req, v) => {
    const opts = roleOptions(req);
    if (!opts.some(([k]) => k === v)) return null;
    if (String(v).startsWith('role:')) {
      const r = engine.customRole(Number(String(v).slice(5)));
      return r && !r.archived ? { role: r.base, role_id: r.id, obj: r } : null;
    }
    return { role: v, role_id: null, obj: engine.builtinRole(v) };
  };
  router.post('/people/invite', RM, (req, res) => {
    const email = h.str(req.body.email, 200).toLowerCase();
    if (!EMAIL_RE.test(email)) return h.back(req, res, '/admin/people/new', 'error', tr('ppl|Enter a valid email.'));
    if (db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', email)) return h.back(req, res, '/admin/people/new', 'error', tr('Someone already uses that email.'));
    if (db.get('SELECT id FROM ppl_invites WHERE email = ? COLLATE NOCASE AND kind = \'invite\' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', email, nowIso())) return h.back(req, res, '/admin/people/invites', 'error', tr('ppl|That email already has an invitation waiting. Resend it from Invitations.'));
    const r = parseRole(req, req.body.role);
    if (!r) return h.back(req, res, '/admin/people/new', 'error', tr('ppl|Choose a role you are allowed to give.'));
    const op = { op: 'invite', email, name: h.str(req.body.name, 120) || null, title: h.str(req.body.title, 120) || null, role: r.role, role_id: r.role_id, lang: req.body.lang === 'ar' ? 'ar' : 'en' };
    return submit(req, res, op, engine.roleGrant(r.obj), '/admin/people/invites', (out) => (h.mail ? tr('ppl|Invitation sent to {email}. The link (works once): {link}', { email, link: out.link }) : tr('ppl|Invitation ready. Send {email} this link (works once): {link}', { email, link: out.link })));
  });
  router.post('/people/create', RM, (req, res) => {
    const name = h.str(req.body.name, 120);
    const email = h.str(req.body.email, 200).toLowerCase();
    if (!name || !EMAIL_RE.test(email)) return h.back(req, res, '/admin/people/new', 'error', tr('Enter a name and a valid email.'));
    if (db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', email)) return h.back(req, res, '/admin/people/new', 'error', tr('Someone already uses that email.'));
    const r = parseRole(req, req.body.role);
    if (!r) return h.back(req, res, '/admin/people/new', 'error', tr('ppl|Choose a role you are allowed to give.'));
    const grant = engine.roleGrant(r.obj);
    if (engine.escalation(req.user, grant).length) return h.back(req, res, '/admin/people/new', 'error', tr('ppl|Choose a role you are allowed to give.'));
    if (engine.twoPerson() && engine.sensitive(grant)) return h.back(req, res, '/admin/people/new', 'error', tr('ppl|This role needs a second administrator. Send an invitation instead: it waits for approval.'));
    const password = auth.token(9);
    const id = Number(db.run('INSERT INTO users (name, email, role, role_id, title, password_hash, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', name, email, r.role, r.role_id, h.str(req.body.title, 120) || null, hashPassword(password), req.user.id, M.now()).lastInsertRowid);
    engine.syncFlags(id);
    engine.touch();
    history({ user_id: id, actor: req.user, action: 'created', changes: [{ kind: 'role', key: roleKeyOf({ role: r.role, role_id: r.role_id }), from: null, to: roleKeyOf({ role: r.role, role_id: r.role_id }) }] });
    h.log(req, 'Added a team member', 'user', id, name);
    h.back(req, res, `/admin/people/${id}`, 'ok', tr('{name} added. Their temporary password is {password} (shown once). They can change it under Your account.', { name, password }));
  });

  // ---------- invitations ----------
  router.get('/people/invites', RM, (req, res) => {
    const t = nowIso();
    const f = h.listFilters(req, { cols: { date: 'i.created_at' }, dateLabel: tr('sort|Sent'), sort: { date: 'i.created_at' }, sorts: [['email', 'sort|Email: A to Z', 'i.email COLLATE NOCASE'], ['expires', 'sort|Expiry: soonest first', 'i.expires_at ASC']] });
    const rows = db.all(`SELECT i.*, u.name by_name FROM ppl_invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.kind = 'invite'${f.sql} ORDER BY ${f.order} LIMIT 300`, ...f.args);
    const state = (i) => (i.accepted_at ? ['ppl|Joined', 'ok'] : i.revoked_at ? ['ppl|Withdrawn', 'mute'] : i.expires_at <= t ? ['ppl|Expired', 'rose'] : ['ppl|Waiting', 'amber']);
    const table = ui.table([
      { label: tr('Email'), sort: (i) => i.email, render: (i) => `<b class="ltr">${esc(i.email)}</b>${i.name ? `<small class="sub">${esc(i.name)}</small>` : ''}` },
      { label: tr('Role'), render: (i) => esc(roleNameByKey(i.role_id ? `role:${i.role_id}` : i.role)) },
      { label: tr('ppl|Invited'), sort: (i) => i.created_at, render: (i) => `${esc(ui.rel(i.created_at))}<small class="sub">${esc(i.by_name || '—')}</small>` },
      { label: tr('Status'), sort: (i) => state(i)[0], render: (i) => `${ui.badge('x', tr(state(i)[0]), state(i)[1])}${!i.accepted_at && !i.revoked_at && i.expires_at > t ? `<small class="sub">${esc(tr('ppl|expires {when}', { when: ui.rel(i.expires_at) }))}</small>` : ''}` },
      { label: '', render: (i) => (i.accepted_at ? (i.user_id ? `<a class="btn btn--ghost btn--xs" href="/admin/people/${i.user_id}">${esc(tr('ppl|Open'))}</a>` : '') : `<div class="row ppl-rowbtns">${ui.form(`/admin/people/invites/${i.id}/resend`, req.session.csrf, ui.btn(esc(tr('ppl|New link')), { cls: 'btn--ghost btn--xs', ic: 'mail' }))}${i.revoked_at ? '' : ui.form(`/admin/people/invites/${i.id}/revoke`, req.session.csrf, ui.btn(esc(tr('ppl|Withdraw')), { cls: 'btn--ghost btn--xs' }))}</div>`) },
    ], rows, { empty: esc(tr('ppl|No invitations yet.')) });
    shell(req, res, { tab: '/admin/people/invites', title: tr('ppl|Invitations'), actions: ui.btn(esc(tr('ppl|Invite someone')), { href: '/admin/people/new', cls: 'btn--primary', ic: 'plus' }), body: `${f.html}${ui.card(tr('ppl|Invitations'), table, { sub: esc(tr('ppl|A new link replaces the old one; the old link stops working.')) })}` });
  });
  router.post('/people/invites/:id/resend', RM, (req, res, next) => {
    const inv = db.get('SELECT * FROM ppl_invites WHERE id = ? AND kind = \'invite\'', req.params.id);
    if (!inv) return next();
    if (inv.accepted_at) return h.back(req, res, '/admin/people/invites', 'error', tr('ppl|This invitation was already used.'));
    const token = crypto.randomBytes(24).toString('base64url');
    db.run('UPDATE ppl_invites SET token_hash = ?, expires_at = ?, revoked_at = NULL WHERE id = ?', sha(token), new Date(Date.now() + inviteDays() * 86400000).toISOString(), inv.id);
    const link = `${site()}/admin/invite/${token}`;
    sendLink(inv.id, link);
    h.log(req, 'Resent an invitation', 'ppl_invite', inv.id, inv.email);
    h.back(req, res, '/admin/people/invites', 'ok', tr('ppl|New link for {email} (works once): {link}', { email: inv.email, link }));
  });
  router.post('/people/invites/:id/revoke', RM, (req, res, next) => {
    const inv = db.get('SELECT * FROM ppl_invites WHERE id = ?', req.params.id);
    if (!inv) return next();
    db.run('UPDATE ppl_invites SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL', nowIso(), inv.id);
    h.log(req, 'Revoked an invitation', 'ppl_invite', inv.id, inv.email);
    h.back(req, res, '/admin/people/invites', 'ok', tr('ppl|The invitation for {email} was withdrawn.', { email: inv.email }));
  });

  // ---------- one person ----------
  router.get('/people/:id(\\d+)', RMG, (req, res, next) => {
    const u = userOf(req.params.id);
    if (!u) return next();
    const csrf = req.session.csrf;
    const eff = engine.effective(u);
    const role = engine.roleOf(u);
    const t = nowIso();
    const pending = h.approvals ? h.approvals.pendingFor('user', u.id) : null;
    const editable = !targetProblem(req, u);
    const facts = `<div class="ppl-hero">${avatar(u, 'ppl-hero__av')}<div class="ppl-hero__who"><h2>${esc(u.name)}</h2><p class="ltr">${esc(u.email)}</p><p class="ppl-hero__tags">${roleBadge(role)} ${statusBadge(u)}${dormant(u) ? ` ${ui.badge('dormant', tr('ppl|Dormant'), 'sand')}` : ''}${eff.temp.length ? ` ${ui.badge('temp', tr('ppl|temporary access'), 'amber')}` : ''}</p></div></div>
      <dl class="dl ppl-dl"><div><dt>${esc(tr('Job title'))}</dt><dd>${esc(u.title ? i18n.tx(u.title) : '—')}</dd></div><div><dt>${esc(tr('Phone'))}</dt><dd class="ltr">${esc(u.phone || '—')}</dd></div><div><dt>${esc(tr('Last sign-in'))}</dt><dd>${u.last_login_at ? esc(ui.rel(u.last_login_at)) : esc(tr('Never'))}</dd></div><div><dt>${esc(tr('ppl|Account since'))}</dt><dd>${esc(ui.date(u.created_at))}</dd></div>${u.invited_by ? `<div><dt>${esc(tr('ppl|Invited by'))}</dt><dd>${esc((userOf(u.invited_by) || {}).name || '—')}</dd></div>` : ''}${!u.active && u.deactivated_at ? `<div><dt>${esc(tr('ppl|Deactivated'))}</dt><dd>${esc(ui.date(u.deactivated_at))}</dd></div>` : ''}${u.locked_until && u.locked_until > t ? `<div><dt>${esc(tr('ppl|Locked'))}</dt><dd>${until(u.locked_until)}</dd></div>` : ''}</dl>
      ${pending ? `<p class="notice">${ui.icon('check')}<span>${esc(pending.kind === 'access' ? tr('ppl|A change to this person waits for a second administrator: {title}.', { title: opText(pending.payload || {}) }) : h.approvals.titleOf(pending))} <a href="/admin/approvals/${pending.id}">${esc(tr('ppl|Open the request'))}</a></span></p>` : ''}`;
    // actions
    const manageActions = canManage(req) && editable ? `<div class="ppl-actions">
      ${u.active ? ui.form(`/admin/people/${u.id}/signout`, csrf, ui.btn(esc(tr('ppl|Sign out everywhere')), { cls: 'btn--ghost btn--sm', ic: 'out' })) : ''}
      ${u.active ? ui.form(`/admin/people/${u.id}/reset`, csrf, ui.btn(esc(tr('ppl|Send a password link')), { cls: 'btn--ghost btn--sm', ic: 'mail' })) : ''}
      ${u.locked_until && u.locked_until > t ? ui.form(`/admin/people/${u.id}/unlock`, csrf, ui.btn(esc(tr('ppl|Unlock')), { cls: 'btn--primary btn--sm', ic: 'shield' })) : ''}
      ${u.active ? `<details class="pop"><summary class="btn btn--ghost btn--sm ppl-danger">${esc(tr('ppl|Deactivate'))}</summary>${ui.form(`/admin/people/${u.id}/deactivate`, csrf, `${ui.input('reason', tr('ppl|Why (kept in the history)'), '')}${ui.btn(esc(tr('ppl|Deactivate now')), { cls: 'btn--primary btn--sm' })}<p class="muted small">${esc(tr('ppl|They are signed out at once and cannot sign in. Their records and history stay.'))}</p>`, { cls: 'stack' })}</details>` : ui.form(`/admin/people/${u.id}/reactivate`, csrf, ui.btn(esc(tr('ppl|Reactivate')), { cls: 'btn--primary btn--sm', ic: 'check' }))}
    </div>` : '';
    const details = canManage(req) && !targetProblem(req, u, { self: true }) ? `<details class="upload-box"><summary>${ui.icon('team')}<span>${esc(tr('ppl|Edit details'))}</span></summary>${ui.form(`/admin/people/${u.id}/details`, csrf, `<div class="fields">${ui.input('name', tr('Name'), u.name, { required: true })}${ui.input('email', tr('Email'), u.email, { type: 'email', required: true, attrs: { class: 'ltr' } })}${ui.input('title', tr('Job title'), u.title || '')}${ui.input('phone', tr('Phone'), u.phone || '', { type: 'tel' })}</div>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    // the role
    const curKey = roleKeyOf(u);
    const roleCard = ui.card(tr('Role'), `${roleBadge(role)}<p class="muted">${esc(role.builtin ? tr(RANK_HINT[role.key] || 'ppl|Everything, including settings and people') : roleDesc(role))}</p>
      ${canGrant(req) && editable ? ui.form(`/admin/people/${u.id}/role`, csrf, `${ui.select('role', tr('ppl|Change the role'), roleOptions(req, { current: curKey }), curKey)}
        <div class="ppl-flags" data-ppl-flags>${['hr', 'finance'].map((c) => `<label class="check"><input type="checkbox" name="${c}" value="1"${u[c] ? ' checked' : ''}${!engine.has(req.user, c) ? ' disabled' : ''}> ${esc(capName(c))} <small class="muted">${esc(tr('ppl|for built-in roles'))}</small></label>`).join('')}</div>
        ${ui.btn(esc(tr('ppl|Save the role')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : ''}`,
    { action: role.builtin ? '' : ui.btn(esc(tr('ppl|Open the role')), { href: `/admin/people/roles/${role.id}`, cls: 'btn--ghost btn--sm' }) });
    // access at a glance
    const byLevel = Object.fromEntries(engine.LEVELS.map((l) => [l, Object.values(eff.modules).filter((m) => m.level === l).length]));
    const total = engine.modules().length;
    const glance = ui.card(tr('ppl|Access at a glance'), `<div class="ppl-stack">${engine.LEVELS.slice().reverse().map((l) => (byLevel[l] ? `<i class="ppl-stack__seg ppl-lv--${l}" style="flex:${byLevel[l]}" title="${esc(tr(LEVEL[l][0]))}: ${byLevel[l]}"></i>` : '')).join('')}</div>
      <ul class="ppl-legend">${engine.LEVELS.slice().reverse().map((l) => `<li>${levelPill(l)} <b>${byLevel[l]}</b></li>`).join('')}</ul>
      <p class="muted small">${esc(tr('ppl|{n} of {total} modules', { n: total - byLevel.none, total }))}</p>
      <div class="ppl-chips">${engine.CAPS.map((c) => `<span class="ppl-chip${eff.caps[c].on ? ' is-on' : ''}" title="${esc(tr(CAP[c][1]))}">${eff.caps[c].on ? '✓' : '—'} ${esc(capName(c))}</span>`).join('')}</div>
      ${eff.overrides.length || eff.temp.length ? `<p class="small">${esc(tn(eff.overrides.length, 'ppl|{n} change for this person', 'ppl|{n} changes for this person'))}${eff.temp.length ? ` · ${esc(tn(eff.temp.length, 'ppl|{n} temporary', 'ppl|{n} temporary'))}` : ''}</p>` : ''}`,
    { action: ui.btn(esc(tr('ppl|Effective access')), { href: `/admin/people/${u.id}/access`, cls: 'btn--primary btn--sm', ic: 'shield' }) });
    // sessions
    const sessions = db.all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC', u.id, t);
    const TTL = 12 * 3600000;
    const sessCard = ui.card(tr('ppl|Signed in on'), sessions.length ? `<ul class="list ppl-sessions">${sessions.map((s) => `<li><span class="what"><b>${esc(device(s.agent))}${req.session && s.id === req.session.id ? ` · ${esc(tr('ppl|this browser'))}` : ''}</b><small><span class="ltr">${esc(s.ip || '—')}</span> · ${esc(tr('ppl|since {when}', { when: ui.rel(s.created_at) }))} · ${esc(tr('ppl|last seen {when}', { when: ui.rel(new Date(Date.parse(s.expires_at) - TTL).toISOString()) }))}</small></span>${canManage(req) && editable ? ui.form(`/admin/people/${u.id}/sessions/${s.id.slice(0, 16)}/end`, csrf, `<button class="iconbtn" title="${esc(tr('ppl|End this session'))}" aria-label="${esc(tr('ppl|End this session'))}">${ui.icon('x')}</button>`) : ''}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('ppl|Not signed in anywhere right now.'))}</p>`);
    const logins = db.all('SELECT * FROM ppl_logins WHERE user_id = ? ORDER BY at DESC LIMIT 15', u.id);
    const REASON = { password: 'ppl|Wrong password', locked: 'ppl|Account locked', deactivated: 'ppl|Account deactivated', unknown: 'ppl|Unknown email', invite: 'ppl|Joined from an invitation', reset: 'ppl|Set a password from a link' };
    const loginCard = ui.card(tr('ppl|Sign-in history'), logins.length ? `<ul class="list ppl-logins">${logins.map((l) => `<li class="${l.ok ? '' : 'is-fail'}"><span class="dot ${l.ok ? 'dot--ok' : 'dot--rose'}"></span><span class="what"><b>${esc(l.ok ? (l.reason ? tr(REASON[l.reason] || 'ppl|Signed in') : tr('ppl|Signed in')) : tr(REASON[l.reason] || 'ppl|Failed sign-in'))}</b><small>${esc(device(l.agent))} · <span class="ltr">${esc(l.ip || '—')}</span></small></span><time>${esc(ui.rel(l.at))}</time></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('ppl|No sign-ins recorded yet.'))}</p>`);
    const hist = ui.card(tr('ppl|Permission history'), historyTable(historyRows('WHERE x.user_id = ?', u.id).slice(0, 25), { showUser: false }));
    const body = `<div class="grid grid--side"><div class="stack">${ui.card(tr('ppl|Profile'), `${facts}${manageActions}${details}`)}${hist}${loginCard}</div><div class="stack">${roleCard}${glance}${sessCard}</div></div>`;
    shell(req, res, { tab: '/admin/people', title: u.name, crumbs: [['/admin/people', tr('nav|Users & permissions')]], body, actions: ui.btn(esc(tr('ppl|Effective access')), { href: `/admin/people/${u.id}/access`, cls: 'btn--ghost', ic: 'shield' }) });
  });

  const act = (fn) => (req, res, next) => {
    const u = userOf(req.params.id);
    if (!u) return next();
    const problem = targetProblem(req, u);
    if (problem) return h.back(req, res, `/admin/people/${u.id}`, 'error', tr(problem));
    return fn(req, res, u);
  };
  router.post('/people/:id(\\d+)/details', RM, (req, res, next) => {
    const u = userOf(req.params.id);
    if (!u) return next();
    const problem = targetProblem(req, u, { self: true });
    if (problem) return h.back(req, res, `/admin/people/${u.id}`, 'error', tr(problem));
    const name = h.str(req.body.name, 120);
    const email = h.str(req.body.email, 200).toLowerCase();
    if (!name || !EMAIL_RE.test(email)) return h.back(req, res, `/admin/people/${u.id}`, 'error', tr('Enter a name and a valid email.'));
    if (db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?', email, u.id)) return h.back(req, res, `/admin/people/${u.id}`, 'error', tr('Someone already uses that email.'));
    db.run('UPDATE users SET name = ?, email = ?, title = ?, phone = ? WHERE id = ?', name, email, h.str(req.body.title, 120) || null, h.str(req.body.phone, 40) || null, u.id);
    history({ user_id: u.id, actor: req.user, action: 'details' });
    h.log(req, 'Edited someone\'s details', 'user', u.id, name);
    h.back(req, res, `/admin/people/${u.id}`, 'ok', tr('Saved.'));
  });
  router.post('/people/:id(\\d+)/deactivate', RM, act((req, res, u) => {
    if (isAdmin(u) && db.value("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1") <= 1) return h.back(req, res, `/admin/people/${u.id}`, 'error', tr('Keep at least one active administrator.'));
    db.run('UPDATE users SET active = 0, deactivated_at = ?, deactivated_by = ? WHERE id = ?', nowIso(), req.user.id, u.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    history({ user_id: u.id, actor: req.user, action: 'deactivated', note: h.str(req.body.reason, 300) || null });
    h.log(req, 'Deactivated an account', 'user', u.id, u.name);
    h.back(req, res, `/admin/people/${u.id}`, 'ok', tr('ppl|{name} is deactivated and signed out everywhere.', { name: u.name }));
  }));
  router.post('/people/:id(\\d+)/reactivate', RM, act((req, res, u) => {
    db.run('UPDATE users SET active = 1, deactivated_at = NULL, deactivated_by = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
    history({ user_id: u.id, actor: req.user, action: 'reactivated' });
    h.log(req, 'Reactivated an account', 'user', u.id, u.name);
    h.back(req, res, `/admin/people/${u.id}`, 'ok', tr('ppl|{name} can sign in again.', { name: u.name }));
  }));
  router.post('/people/:id(\\d+)/signout', RM, act((req, res, u) => {
    const n = db.run('DELETE FROM sessions WHERE user_id = ?', u.id).changes || 0;
    history({ user_id: u.id, actor: req.user, action: 'signed_out' });
    h.log(req, 'Signed someone out', 'user', u.id, u.name);
    h.back(req, res, `/admin/people/${u.id}`, 'ok', tn(Number(n), 'ppl|{name} was signed out of {n} session.', 'ppl|{name} was signed out of {n} sessions.', { name: u.name }));
  }));
  router.post('/people/:id(\\d+)/sessions/:sid/end', RM, act((req, res, u) => {
    const sid = String(req.params.sid).replace(/[^a-f0-9]/g, '');
    if (sid.length < 12) return h.back(req, res, `/admin/people/${u.id}`, 'error', tr('ppl|That session is not there any more.'));
    db.run('DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, ?) = ?', u.id, sid.length, sid);
    h.log(req, 'Ended a session', 'user', u.id, u.name);
    h.back(req, res, `/admin/people/${u.id}`, 'ok', tr('ppl|Session ended.'));
  }));
  router.post('/people/:id(\\d+)/unlock', RM, act((req, res, u) => {
    db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
    history({ user_id: u.id, actor: req.user, action: 'unlocked' });
    h.log(req, 'Unlocked an account', 'user', u.id, u.name);
    h.back(req, res, `/admin/people/${u.id}`, 'ok', tr('ppl|{name} can try to sign in again.', { name: u.name }));
  }));
  router.post('/people/:id(\\d+)/reset', RM, act((req, res, u) => {
    const token = crypto.randomBytes(24).toString('base64url');
    db.run("UPDATE ppl_invites SET revoked_at = ? WHERE kind = 'reset' AND user_id = ? AND accepted_at IS NULL AND revoked_at IS NULL", nowIso(), u.id);
    const id = Number(db.run("INSERT INTO ppl_invites (kind, email, name, role, lang, token_hash, expires_at, user_id, created_by, created_at) VALUES ('reset', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      u.email, u.name, u.role, u.lang || null, sha(token), new Date(Date.now() + 2 * 86400000).toISOString(), u.id, req.user.id, nowIso()).lastInsertRowid);
    // the old password stops working now, and every session ends
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(crypto.randomBytes(18).toString('hex')), u.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    const link = `${site()}/admin/invite/${token}`;
    sendLink(id, link);
    history({ user_id: u.id, actor: req.user, action: 'reset' });
    h.log(req, 'Sent a password reset link', 'user', u.id, u.name);
    h.back(req, res, `/admin/people/${u.id}`, 'ok', tr('ppl|{name} is signed out and their old password no longer works. The link to set a new one (works once, 2 days): {link}', { name: u.name, link }));
  }));
  router.post('/people/:id(\\d+)/role', RG, act((req, res, u) => {
    const r = parseRole(req, req.body.role);
    if (!r) return h.back(req, res, `/admin/people/${u.id}`, 'error', tr('ppl|Choose a role you are allowed to give.'));
    if (isAdmin(u) && r.role !== 'admin' && db.value("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1") <= 1) return h.back(req, res, `/admin/people/${u.id}`, 'error', tr('Keep at least one active administrator.'));
    const op = { op: 'role', user_id: u.id, role: r.role_id ? `role:${r.role_id}` : r.role };
    const grant = engine.roleGrant(r.obj);
    if (!r.role_id) {
      const mayHr = engine.has(req.user, 'hr');
      const mayFin = engine.has(req.user, 'finance');
      op.hr = mayHr ? (req.body.hr === '1' ? 1 : 0) : u.hr ? 1 : 0;
      op.finance = mayFin ? (req.body.finance === '1' ? 1 : 0) : u.finance ? 1 : 0;
      grant.caps = { ...grant.caps, hr: !!op.hr, finance: !!op.finance };
    }
    // only what the person does not have yet counts as given
    const cur = engine.effective(u);
    const want = { base: engine.RANK[grant.base] > engine.RANK[cur.base] ? grant.base : null, modules: {}, caps: {}, limits: {} };
    for (const [href, l] of Object.entries(grant.modules)) if (engine.lv(l) > engine.lv((cur.modules[href] || {}).level || 'none')) want.modules[href] = l;
    for (const [c, on] of Object.entries(grant.caps)) if (on && engine.CAPS.includes(c) && !(cur.caps[c] && cur.caps[c].on)) want.caps[c] = true;
    for (const [k, v] of Object.entries(grant.limits || {})) if (cur.limits[k] === undefined || v > cur.limits[k]) want.limits[k] = v;
    if (op.role === roleKeyOf(u) && r.role_id) return h.back(req, res, `/admin/people/${u.id}`, 'ok', tr('ppl|Nothing changed.'));
    return submit(req, res, op, want, `/admin/people/${u.id}`, tr('ppl|{name} now has the role {role}.', { name: u.name, role: engine.roleName(r.obj) }));
  }));

  // ---------- effective access, changes and temporary access ----------
  router.get('/people/:id(\\d+)/access', RMG, (req, res, next) => {
    const u = userOf(req.params.id);
    if (!u) return next();
    const csrf = req.session.csrf;
    const eff = engine.effective(u);
    const role = engine.roleOf(u);
    const editable = canGrant(req) && !targetProblem(req, u) && !isAdmin(u);
    const perm = Object.fromEntries(db.all("SELECT * FROM ppl_overrides WHERE user_id = ? AND expires_at IS NULL AND subject = 'module'", u.id).map((o) => [o.key, o.level]));
    const hidden = ui.hiddenModules(u);
    const mine = engine.effective(req.user);
    const sourceText = (m) => {
      const s = tr(SOURCE[m.source] || 'ppl|From the role');
      return m.source === 'role' && !role.builtin ? `${s} · ${engine.roleName(role)}` : s;
    };
    const groups = ui.NAV.map(([group, items]) => {
      const rows = items.map(([href]) => engine.moduleOf(href)).filter(Boolean).map((e) => {
        const m = eff.modules[e.href];
        const fixed = e.href === '/admin' || e.href === '/admin/help' || e.href === '/admin/people';
        const roleLvl = engine.roleLevel(role, e.href);
        const current = perm[e.href] || (hidden.has(e.href) ? 'none' : '');
        const sel = editable && !fixed
          ? `<select name="lvl:${esc(e.href)}" class="ppl-sel" data-orig="${esc(current)}" aria-label="${esc(tr(e.label))}"><option value="">${esc(tr('ppl|Role decides ({level})', { level: tr(LEVEL[roleLvl][0]) }))}</option>${engine.LEVELS.map((l) => `<option value="${l}"${current === l ? ' selected' : ''}${engine.lv(l) > engine.lv((mine.modules[e.href] || {}).level || 'none') && !mine.admin ? ' disabled' : ''}>${esc(tr(LEVEL[l][0]))}</option>`).join('')}</select>`
          : '';
        return `<tr data-ppl-row="${esc(tr(e.label).toLowerCase())}"><th scope="row"><span class="ppl-mod">${ui.icon(e.ic)}<span>${esc(tr(e.label))}</span></span></th><td>${levelPill(m.level)}</td><td><span class="ppl-src ppl-src--${esc(m.source)}">${esc(sourceText(m))}</span>${m.until ? ` ${until(m.until)}` : ''}${m.blocked ? `<small class="sub ppl-blocked">${esc(tr(BLOCK[m.blocked] || 'ppl|Closed'))}</small>` : ''}</td>${editable ? `<td>${sel}</td>` : ''}</tr>`;
      }).join('');
      return `<tbody><tr class="ppl-grouprow"><th colspan="${editable ? 4 : 3}">${esc(tr(group))}</th></tr>${rows}</tbody>`;
    }).join('');
    const matrix = `<div class="ppl-tools"><input type="search" class="ppl-find" placeholder="${esc(tr('ppl|Find a module'))}" data-ppl-filter aria-label="${esc(tr('ppl|Find a module'))}">${editable ? `<span class="ppl-changes" data-ppl-changes data-one="${esc(tr('ppl|1 change not saved'))}" data-many="${esc(tr('ppl|{n} changes not saved'))}"></span>` : ''}</div>
      <div class="tablewrap ppl-scroll"><table class="table ppl-eff"><thead><tr><th>${esc(tr('ppl|Module'))}</th><th>${esc(tr('ppl|Level'))}</th><th>${esc(tr('ppl|Why'))}</th>${editable ? `<th>${esc(tr('ppl|Set for this person'))}</th>` : ''}</tr></thead>${groups}</table></div>`;
    const intro = isAdmin(u)
      ? `<p class="notice">${ui.icon('shield')}<span>${esc(tr('ppl|{name} is an administrator: every module and every permission, always.', { name: u.name }))}</span></p>`
      : role.builtin ? `<p class="muted">${esc(tr('ppl|{name} has a built-in role: every module the rank allows is open, and inside each module the rank decides what they can change. Set a level below to narrow or widen one module for them.', { name: u.name }))}</p>`
        : `<p class="muted">${esc(tr('ppl|The role {role} decides, unless you set a level for {name} here.', { role: engine.roleName(role), name: u.name }))}</p>`;
    const capRows = engine.CAPS.map((c) => {
      const x = eff.caps[c];
      const ov = db.get("SELECT level FROM ppl_overrides WHERE user_id = ? AND subject = 'cap' AND key = ? AND expires_at IS NULL", u.id, c);
      const canSet = editable && !['hr', 'finance'].includes(c);
      return `<tr><th scope="row"><b>${esc(capName(c))}</b><small class="sub">${esc(tr(CAP[c][1]))}</small></th><td>${x.on ? `<span class="ppl-lv ppl-lv--full">${esc(tr('ppl|On'))}</span>` : `<span class="ppl-lv ppl-lv--none">${esc(tr('ppl|Off'))}</span>`}</td><td><span class="ppl-src">${esc(tr(SOURCE[x.source] || 'ppl|From the role'))}</span>${x.until ? ` ${until(x.until)}` : ''}</td>${editable ? `<td>${canSet ? `<select name="cap:${c}" class="ppl-sel" data-orig="${esc(ov ? ov.level : '')}"><option value="">${esc(tr('ppl|Role decides'))}</option><option value="on"${ov && ov.level === 'on' ? ' selected' : ''}${!mine.admin && !(mine.caps[c] && mine.caps[c].on) ? ' disabled' : ''}>${esc(tr('ppl|On'))}</option><option value="off"${ov && ov.level === 'off' ? ' selected' : ''}>${esc(tr('ppl|Off'))}</option></select>` : `<small class="muted">${esc(tr(role.builtin ? 'ppl|Set with the role' : 'ppl|Set in the role'))}</small>`}</td>` : ''}</tr>`;
    }).join('');
    const caps = `<div class="tablewrap"><table class="table ppl-eff ppl-caps"><thead><tr><th>${esc(tr('ppl|Permission'))}</th><th>${esc(tr('ppl|Level'))}</th><th>${esc(tr('ppl|Why'))}</th>${editable ? `<th>${esc(tr('ppl|Set for this person'))}</th>` : ''}</tr></thead><tbody>${capRows}</tbody></table></div>
      ${kinds().length ? `<p class="small ppl-limits"><b>${esc(tr('ppl|Approval limits'))}:</b> ${kinds().map(([k]) => `${esc(kindName(k))} ${eff.admin ? esc(tr('ppl|no limit')) : eff.limits[k] !== undefined ? ui.money(eff.limits[k]) : esc(tr('ppl|by the approval rules'))}`).join(' · ')}</p>` : ''}`;
    const editForm = editable
      ? ui.form(`/admin/people/${u.id}/overrides`, csrf, `${matrix}<h3 class="ppl-h3">${esc(tr('ppl|Permissions'))}</h3>${caps}<div class="fields">${ui.input('reason', tr('ppl|Why (kept in the history)'), '', { cls: 'span-all' })}</div><div class="row">${ui.btn(esc(tr('ppl|Save the changes')), { cls: 'btn--primary' })}${ui.btn(esc(tr('ppl|Back to the role')), { cls: 'btn--ghost', attrs: { name: 'reset', value: '1' } })}</div>`, { cls: 'stack', attrs: { 'data-ppl-form': '' } })
      : `${matrix}<h3 class="ppl-h3">${esc(tr('ppl|Permissions'))}</h3>${caps}`;
    // temporary access
    const temps = db.all('SELECT o.*, g.name by_name FROM ppl_overrides o LEFT JOIN users g ON g.id = o.granted_by WHERE o.user_id = ? AND o.expires_at IS NOT NULL ORDER BY o.expires_at', u.id);
    const tempList = temps.length ? `<ul class="list ppl-temps">${temps.map((o) => `<li><span class="what"><b>${esc(o.subject === 'cap' ? capName(o.key) : moduleName(o.key))} · ${o.subject === 'cap' ? esc(tr('ppl|On')) : esc(tr(LEVEL[o.level] ? LEVEL[o.level][0] : 'ppl|View'))}</b><small>${until(o.expires_at)}${o.reason ? ` · ${esc(o.reason)}` : ''}${o.by_name ? ` · ${esc(o.by_name)}` : ''}</small></span>${editable ? ui.form(`/admin/people/${u.id}/temp/${o.id}/remove`, csrf, `<button class="iconbtn" title="${esc(tr('ppl|End it now'))}" aria-label="${esc(tr('ppl|End it now'))}">${ui.icon('x')}</button>`) : ''}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('ppl|No temporary access.'))}</p>`;
    const tomorrow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const tempForm = editable ? ui.form(`/admin/people/${u.id}/temp`, csrf, `<div class="fields">${ui.select('key', tr('ppl|Module or permission'), [
      ...engine.modules().filter((e) => e.href !== '/admin' && e.href !== '/admin/help' && e.href !== '/admin/people' && !(eff.modules[e.href] || {}).blocked).map((e) => [e.href, tr(e.label)]),
      ...['export', 'manage_users', 'grant'].map((c) => [`cap:${c}`, `${tr('ppl|Permission')}: ${capName(c)}`]),
    ], '')}${ui.select('level', tr('ppl|Level'), [['view', tr('ppl|View')], ['edit', tr('ppl|Edit')], ['full', tr('ppl|Full')]], 'view')}${ui.input('until', tr('ppl|Until'), tomorrow, { type: 'date', required: true, min: new Date().toISOString().slice(0, 10) })}${ui.input('reason', tr('ppl|Why'), '', { placeholder: tr('ppl|e.g. Covering for Salma during her leave') })}</div>${ui.btn(esc(tr('ppl|Give temporary access')), { cls: 'btn--primary btn--sm', ic: 'plus' })}<p class="muted small">${esc(tr('ppl|It ends by itself at the end of that day.'))}</p>`, { cls: 'stack' }) : '';
    // can this person open …?
    const testUrl = h.str(req.query.test, 300);
    const testMethod = req.query.method === 'POST' ? 'POST' : 'GET';
    let verdict = '';
    if (testUrl) {
      let p = testUrl.replace(/^https?:\/\/[^/]+/, '');
      if (!p.startsWith('/')) p = `/${p}`;
      if (!p.startsWith('/admin')) p = `/admin${p === '/' ? '' : p}`;
      const c = engine.check(u, testMethod, p);
      const need = engine.required(testMethod, p);
      const name = need ? moduleName(need.module) : '';
      let text;
      if (!need) text = tr('ppl|{path} is not part of a module: anyone signed in can open it, and the page itself decides.', { path: p });
      else if (c.ok) text = tr('ppl|Yes. {path} belongs to {module}; it needs {need} and {name} has {have}.', { path: p, module: name, need: tr(LEVEL[need.level][0]), have: tr(LEVEL[c.have][0]), name: u.name });
      else if (c.reason === 'export') text = tr('ppl|No. {path} is a download or printout, and {name} does not have Export data.', { path: p, name: u.name });
      else text = tr('ppl|No. {path} belongs to {module}; it needs {need} and {name} has {have}.', { path: p, module: name, need: tr(LEVEL[need.level][0]), have: tr(LEVEL[c.have][0]), name: u.name });
      const builtinNote = c.ok && role.builtin && !isAdmin(u) && need ? `<small class="sub">${esc(tr('ppl|Inside the module, the {rank} rank still decides what they can change.', { rank: tr(RANK[u.role]) }))}</small>` : '';
      verdict = `<p class="ppl-verdict ppl-verdict--${c.ok ? 'yes' : 'no'}">${ui.icon(c.ok ? 'check' : 'x')}<span>${esc(text)}${builtinNote}</span></p>`;
    }
    const tester = `<form method="get" action="/admin/people/${u.id}/access" class="stack ppl-tester"><div class="fields">${ui.input('test', tr('ppl|Address'), testUrl, { placeholder: '/admin/billing', attrs: { class: 'ltr' } })}${ui.select('method', tr('ppl|To'), [['GET', tr('ppl|open it')], ['POST', tr('ppl|change something there')]], testMethod)}</div>${ui.btn(esc(tr('ppl|Check')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</form>${verdict}`;
    const body = `<div class="grid grid--side"><div class="stack">${ui.card(tr('ppl|What {name} can do', { name: u.name }), `${intro}${editForm}`)}</div><div class="stack">${ui.card(tr('ppl|Can {name} open…?', { name: u.name }), tester)}${ui.card(tr('ppl|Temporary access'), `${tempList}${tempForm}`)}${ui.card(tr('Role'), `${roleBadge(role)}<p class="small muted">${esc(tr('ppl|Change it on the person\'s page.'))}</p>`, { action: ui.btn(esc(tr('ppl|Open')), { href: `/admin/people/${u.id}`, cls: 'btn--ghost btn--sm' }) })}</div></div>`;
    shell(req, res, { tab: '/admin/people', title: tr('ppl|Effective access'), crumbs: [['/admin/people', tr('nav|Users & permissions')], [`/admin/people/${u.id}`, u.name]], body });
  });
  router.post('/people/:id(\\d+)/overrides', RG, act((req, res, u) => {
    if (isAdmin(u)) return h.back(req, res, `/admin/people/${u.id}/access`, 'error', tr('ppl|Administrators always have everything.'));
    const modules = {};
    const caps = {};
    for (const e of engine.modules()) {
      if (e.href === '/admin' || e.href === '/admin/help' || e.href === '/admin/people') continue;
      const v = req.body.reset ? '' : req.body[`lvl:${e.href}`];
      if (v === undefined) continue;
      modules[e.href] = engine.LEVELS.includes(v) ? v : null;
    }
    for (const c of ['export', 'manage_users', 'grant']) {
      const v = req.body.reset ? '' : req.body[`cap:${c}`];
      if (v === undefined) continue;
      caps[c] = v === 'on' || v === 'off' ? v : null;
    }
    // what is given: whatever the person would have after the change and does not have now
    const perm = db.all('SELECT subject, key, level FROM ppl_overrides WHERE user_id = ? AND expires_at IS NULL', u.id);
    for (const href of ui.hiddenModules(u)) if (!perm.some((o) => o.subject === 'module' && o.key === href)) perm.push({ subject: 'module', key: href, level: 'none' });
    const next = perm.filter((o) => !(o.subject === 'module' && Object.prototype.hasOwnProperty.call(modules, o.key)) && !(o.subject === 'cap' && Object.prototype.hasOwnProperty.call(caps, o.key)));
    for (const [href, l] of Object.entries(modules)) if (l) next.push({ subject: 'module', key: href, level: l });
    for (const [c, v] of Object.entries(caps)) if (v) next.push({ subject: 'cap', key: c, level: v });
    const now = engine.effective(u);
    const after = engine.preview(u, next);
    const want = { modules: {}, caps: {} };
    for (const [href, m] of Object.entries(after.modules)) if (engine.lv(m.level) > engine.lv((now.modules[href] || {}).level || 'none')) want.modules[href] = m.level;
    for (const [c, x] of Object.entries(after.caps)) if (x.on && !(now.caps[c] && now.caps[c].on)) want.caps[c] = true;
    // asking for more than the ceilings allow is still asking for it
    for (const [href, l] of Object.entries(modules)) if (l && engine.lv(l) > engine.lv((now.modules[href] || {}).level || 'none')) want.modules[href] = engine.maxLevel(want.modules[href] || 'none', l);
    const op = { op: 'overrides', user_id: u.id, modules, caps, reason: h.str(req.body.reason, 300) || null };
    return submit(req, res, op, want, `/admin/people/${u.id}/access`, (n) => (n ? tn(n, 'ppl|Saved: {n} change.', 'ppl|Saved: {n} changes.') : tr('ppl|Nothing changed.')));
  }));
  router.post('/people/:id(\\d+)/temp', RG, act((req, res, u) => {
    if (isAdmin(u)) return h.back(req, res, `/admin/people/${u.id}/access`, 'error', tr('ppl|Administrators always have everything.'));
    const key = String(req.body.key || '');
    const isCap = key.startsWith('cap:');
    const k = isCap ? key.slice(4) : key;
    if (isCap ? !['export', 'manage_users', 'grant'].includes(k) : !engine.moduleOf(k) || k === '/admin' || k === '/admin/help' || k === '/admin/people') return h.back(req, res, `/admin/people/${u.id}/access`, 'error', tr('ppl|Choose a module or a permission.'));
    const level = isCap ? 'on' : engine.LEVELS.includes(req.body.level) && req.body.level !== 'none' ? req.body.level : 'view';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.until || '')) ? req.body.until : null;
    // the end of that day in Cairo (UTC+2/+3: end at 23:59 Cairo ≈ 21:59 UTC)
    const untilIso = day ? new Date(`${day}T21:59:00.000Z`).toISOString() : null;
    if (!untilIso || untilIso <= nowIso()) return h.back(req, res, `/admin/people/${u.id}/access`, 'error', tr('ppl|Choose an end date after today.'));
    if (untilIso > new Date(Date.now() + 366 * 86400000).toISOString()) return h.back(req, res, `/admin/people/${u.id}/access`, 'error', tr('ppl|Temporary access lasts a year at most.'));
    // a module behind a ceiling (HR, Finance, a rank) stays closed whatever is granted: say so instead of saving
    const blocked = !isCap && ((engine.effective(u).modules[k] || {}).blocked);
    if (blocked) return h.back(req, res, `/admin/people/${u.id}/access`, 'error', tr('ppl|{module} stays closed for {name} until this changes: {why}.', { module: moduleName(k), name: u.name, why: tr(BLOCK[blocked] || 'ppl|Closed') }));
    const want = isCap ? { caps: { [k]: true } } : { modules: { [k]: level } };
    const op = { op: 'temp', user_id: u.id, subject: isCap ? 'cap' : 'module', key: k, level, until: untilIso, reason: h.str(req.body.reason, 300) || null };
    return submit(req, res, op, want, `/admin/people/${u.id}/access`, tr('ppl|{name} has temporary access until {when}.', { name: u.name, when: ui.date(untilIso) }));
  }));
  router.post('/people/:id(\\d+)/temp/:oid(\\d+)/remove', RG, act((req, res, u) => {
    const o = db.get('SELECT * FROM ppl_overrides WHERE id = ? AND user_id = ? AND expires_at IS NOT NULL', req.params.oid, u.id);
    if (!o) return h.back(req, res, `/admin/people/${u.id}/access`, 'error', tr('ppl|That temporary access has already ended.'));
    db.run('DELETE FROM ppl_overrides WHERE id = ?', o.id);
    engine.touch();
    history({ user_id: u.id, actor: req.user, action: 'temp_removed', changes: [{ kind: o.subject, key: o.key, from: o.level, to: null }] });
    h.log(req, 'Changed access', 'user', u.id, u.name);
    h.back(req, res, `/admin/people/${u.id}/access`, 'ok', tr('ppl|Temporary access ended.'));
  }));

  // ---------- roles ----------
  router.get('/people/roles', RMG, (req, res) => {
    const list = engine.roles({ archived: true });
    const total = engine.modules().length;
    const cards = list.map((r) => {
      const n = r.builtin ? db.value('SELECT COUNT(*) FROM users WHERE role = ? AND role_id IS NULL AND active = 1', r.key) : db.value('SELECT COUNT(*) FROM users WHERE role_id = ? AND active = 1', r.id);
      const levels = engine.modules().map((e) => (r.builtin && r.key !== 'admin' ? (({ viewer: 'view', agent: 'edit', manager: 'full' })[r.key] && engine.roleLevel(r, e.href) !== 'none' ? ({ viewer: 'view', agent: 'edit', manager: 'full' })[r.key] : 'none') : engine.roleLevel(r, e.href)));
      const by = Object.fromEntries(engine.LEVELS.map((l) => [l, levels.filter((x) => x === l).length]));
      const href = r.builtin ? `/admin/people/roles/b/${r.key}` : `/admin/people/roles/${r.id}`;
      return `<a class="ppl-role${r.archived ? ' is-archived' : ''}" href="${href}">
        <span class="ppl-role__head">${roleBadge(r)}${r.builtin ? `<small class="badge badge--mute">${esc(tr('ppl|built-in'))}</small>` : ''}${r.archived ? `<small class="badge badge--mute">${esc(tr('ppl|archived'))}</small>` : ''}</span>
        <span class="ppl-role__desc">${esc(r.builtin ? tr(RANK_HINT[r.key] || 'ppl|Everything, including settings and people') : roleDesc(r) || tr('ppl|Custom role'))}</span>
        <span class="ppl-stack">${['full', 'edit', 'view', 'none'].map((l) => (by[l] ? `<i class="ppl-stack__seg ppl-lv--${l}" style="flex:${by[l]}" title="${esc(tr(LEVEL[l][0]))}: ${by[l]}"></i>` : '')).join('')}</span>
        <span class="ppl-role__foot"><span>${esc(tn(n, 'ppl|{n} person', 'ppl|{n} people'))}</span><span>${esc(tr('ppl|{n} of {total} modules', { n: total - by.none, total }))}</span><span>${esc(tr(RANK[r.base] || 'ppl|Agent'))}</span></span>
        <span class="ppl-chips">${engine.CAPS.filter((c) => r.caps[c]).map((c) => `<span class="ppl-chip">${esc(capName(c))}</span>`).join('')}</span>
      </a>`;
    }).join('');
    const templates = canGrant(req) ? ui.card(tr('ppl|Start from a template'), `<div class="ppl-templates">${Object.entries(engine.TEMPLATES).map(([k, t]) => `<a class="ppl-tpl" href="/admin/people/roles/new?template=${k}"><b>${esc(tr(t.name))}</b><small>${esc(tr(t.desc))}</small></a>`).join('')}</div>`) : '';
    shell(req, res, { tab: '/admin/people/roles', title: tr('ppl|Roles'), actions: canGrant(req) ? ui.btn(esc(tr('ppl|New role')), { href: '/admin/people/roles/new', cls: 'btn--primary', ic: 'plus' }) : '', body: `<div class="ppl-roles">${cards}</div>${templates}` });
  });

  // the matrix editor (new, from a template, from another role, or an existing custom role)
  function roleEditor(req, res, { role = null, start, title, action }) {
    const csrf = req.session.csrf;
    const mine = engine.effective(req.user);
    const readOnly = !canGrant(req) || (role && role.builtin) || (role && !isAdmin(req.user) && req.user.role_id === role.id);
    const groups = ui.NAV.map(([group, items], gi) => {
      const rows = items.map(([href]) => engine.moduleOf(href)).filter((e) => e && e.href !== '/admin' && e.href !== '/admin/help' && e.href !== '/admin/people').map((e) => {
        const cur = start.matrix[e.href] || 'none';
        const orig = role && !role.builtin ? engine.roleLevel(role, e.href) : cur;
        const note = e.min ? `<small class="sub ppl-blocked">${esc(tr(BLOCK[e.min] || 'ppl|Closed'))}</small>` : '';
        return `<tr data-ppl-row="${esc(tr(e.label).toLowerCase())}"><th scope="row"><span class="ppl-mod">${ui.icon(e.ic)}<span>${esc(tr(e.label))}</span></span>${note}</th>${engine.LEVELS.map((l) => {
          const over = !mine.admin && engine.lv(l) > engine.lv((mine.modules[e.href] || {}).level || 'none') && engine.lv(l) > engine.lv(orig);
          return `<td class="ppl-cell"><label class="ppl-radio ppl-radio--${l}" title="${esc(tr(LEVEL[l][0]))}: ${esc(tr(LEVEL_HINT[l]))}"><input type="radio" name="m:${esc(e.href)}" value="${l}"${cur === l ? ' checked' : ''}${readOnly || over ? ' disabled' : ''} data-orig="${orig === l ? '1' : ''}"><span>${esc(tr(LEVEL[l][0]))}</span></label></td>`;
        }).join('')}</tr>`;
      }).join('');
      if (!rows) return '';
      return `<tbody data-ppl-group="g${gi}"><tr class="ppl-grouprow"><th>${esc(tr(group))}</th>${engine.LEVELS.map((l) => `<td>${readOnly ? '' : `<button type="button" class="ppl-gbtn" data-ppl-set="${l}" title="${esc(tr('ppl|Set the whole group to {level}', { level: tr(LEVEL[l][0]) }))}">${esc(tr('ppl|all'))}</button>`}</td>`).join('')}</tr>${rows}</tbody>`;
    }).join('');
    const head = `<thead><tr><th>${esc(tr('ppl|Module'))}</th>${engine.LEVELS.map((l) => `<th><span class="ppl-lv ppl-lv--${l}">${esc(tr(LEVEL[l][0]))}</span><small>${esc(tr(LEVEL_HINT[l]))}</small></th>`).join('')}</tr></thead>`;
    const matrix = `<div class="ppl-tools"><input type="search" class="ppl-find" placeholder="${esc(tr('ppl|Find a module'))}" data-ppl-filter aria-label="${esc(tr('ppl|Find a module'))}"><span class="ppl-changes" data-ppl-changes data-one="${esc(tr('ppl|1 change not saved'))}" data-many="${esc(tr('ppl|{n} changes not saved'))}"></span></div><div class="tablewrap ppl-scroll"><table class="table ppl-matrix">${head}${groups}</table></div>`;
    const capBoxes = engine.CAPS.map((c) => {
      const over = !mine.admin && !(mine.caps[c] && mine.caps[c].on) && !(role && role.caps[c]);
      return `<label class="ppl-cap${start.caps[c] ? ' is-on' : ''}"><input type="checkbox" name="cap_${c}" value="1"${start.caps[c] ? ' checked' : ''}${readOnly || over ? ' disabled' : ''}><span><b>${esc(capName(c))}</b><small>${esc(tr(CAP[c][1]))}</small></span></label>`;
    }).join('');
    const limits = kinds().length ? `<div class="fields ppl-lims">${kinds().map(([k]) => ui.input(`lim_${k}`, kindName(k), start.caps.limits && start.caps.limits[k] !== undefined ? start.caps.limits[k] : '', { type: 'number', min: 0, step: '0.01', placeholder: tr('ppl|No personal limit'), attrs: readOnly ? { disabled: true } : {} })).join('')}</div><p class="muted small">${esc(tr('ppl|The most a person with this role may approve for each kind of request. Empty: the approval rules decide.'))}</p>` : '';
    const copyFrom = !readOnly ? `<form method="get" action="${esc(req.path === '/people/roles/new' ? '/admin/people/roles/new' : `/admin${req.path}`)}" class="row ppl-copy">${ui.select('copy', tr('ppl|Copy the matrix from'), engine.roles().filter((r) => !r.builtin || r.key !== 'admin').map((r) => [r.builtin ? `b:${r.key}` : String(r.id), engine.roleName(r)]), '', { blank: tr('ppl|Choose a role') })}${ui.btn(esc(tr('ppl|Copy')), { cls: 'btn--ghost btn--sm' })}</form>` : '';
    const settingsFields = `<div class="fields">${ui.input('name', tr('Name'), start.name || '', { required: true, attrs: readOnly ? { disabled: true } : {} })}${ui.select('base', tr('ppl|Rank'), ['viewer', 'agent', 'manager'].filter((b) => mine.admin || engine.RANK[b] <= engine.RANK[mine.base]).map((b) => [b, `${tr(RANK[b])} · ${tr(RANK_HINT[b])}`]), start.base || 'agent', { attrs: readOnly ? { disabled: true } : {} })}${ui.select('default_level', tr('ppl|Modules added later'), engine.LEVELS.map((l) => [l, tr(LEVEL[l][0])]), start.default_level || 'none', { attrs: readOnly ? { disabled: true } : {} })}${ui.select('color', tr('ppl|Colour'), COLORS.map((c) => [c, tr(COLOR_NAME[c])]), start.color || 'sea', { attrs: readOnly ? { disabled: true } : {} })}${ui.textarea('description', tr('ppl|What this role is for'), start.description || '', { rows: 2, cls: 'span-all' })}</div>${start.template ? `<input type="hidden" name="template" value="${esc(start.template)}">` : ''}`;
    const inner = `${ui.card(tr('ppl|The role'), settingsFields)}${ui.card(tr('ppl|Permission matrix'), `${copyFrom}${matrix}`, { sub: esc(tr('ppl|A level includes the ones before it. Greyed levels are above your own access.')) })}${ui.card(tr('ppl|Permissions'), `<div class="ppl-caps-grid">${capBoxes}</div><h3 class="ppl-h3">${esc(tr('ppl|Approval limits'))}</h3>${limits}`)}`;
    const people = role && !role.builtin ? db.all('SELECT * FROM users WHERE role_id = ? ORDER BY active DESC, name', role.id) : role && role.builtin ? engine.usersWithRole(role.key) : [];
    const side = `${ui.card(tr('ppl|People with this role'), people.length ? `<ul class="list">${people.map((p) => `<li><a href="/admin/people/${p.id}">${avatar(p, 'avatar--sm')}<span class="what"><b>${esc(p.name)}</b><small>${statusOf(p) === 'active' ? esc(p.title ? i18n.tx(p.title) : p.email) : esc(tr(STATUS[statusOf(p)][0]))}</small></span></a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('ppl|Nobody yet.'))}</p>`)}
      ${role && !role.builtin ? ui.card(tr('ppl|History'), historyTable(historyRows('WHERE x.role_id = ?', role.id).slice(0, 12), { showUser: false })) : ''}`;
    const buttons = readOnly ? '' : `<div class="row ppl-savebar">${ui.btn(esc(tr('ppl|Review and save')), { cls: 'btn--primary', ic: 'check' })}<span class="muted small">${esc(tr('ppl|You see exactly what changes, and for whom, before anything is saved.'))}</span></div>`;
    const form = readOnly ? `<div class="stack">${inner}</div>` : ui.form(action, csrf, `${inner}${buttons}`, { cls: 'stack', attrs: { 'data-ppl-form': '' } });
    const actions = role && !role.builtin && canGrant(req) ? [
      ui.form(`/admin/people/roles/${role.id}/clone`, csrf, ui.btn(esc(tr('ppl|Duplicate')), { cls: 'btn--ghost btn--sm' })),
      role.archived ? ui.form(`/admin/people/roles/${role.id}/restore`, csrf, ui.btn(esc(tr('ppl|Restore')), { cls: 'btn--ghost btn--sm' })) : ui.form(`/admin/people/roles/${role.id}/archive`, csrf, ui.btn(esc(tr('ppl|Archive')), { cls: 'btn--ghost btn--sm' })),
    ].join('') : role && role.builtin && canGrant(req) && role.key !== 'admin' ? ui.form(`/admin/people/roles/b/${role.key}/clone`, csrf, ui.btn(esc(tr('ppl|Duplicate to customise')), { cls: 'btn--primary btn--sm', ic: 'plus' })) : '';
    const note = role && role.builtin ? `<p class="notice">${ui.icon('shield')}<span>${esc(tr('ppl|Built-in roles cannot be edited: they open every module their rank allows, and the rank decides what can be changed. Duplicate one to make your own.'))}</span></p>` : readOnly && role ? `<p class="notice">${ui.icon('shield')}<span>${esc(tr('ppl|You hold this role yourself, so another person with Give access edits it.'))}</span></p>` : '';
    shell(req, res, { tab: '/admin/people/roles', title, crumbs: [['/admin/people', tr('nav|Users & permissions')], ['/admin/people/roles', tr('ppl|Roles')]], actions: `<div class="row">${actions}</div>`, body: `${note}<div class="stack ppl-editor">${form}<div class="grid grid--2">${side}</div></div>` });
  }
  // a starting point from ?template=, ?copy=, or the role itself
  const startFrom = (req, base) => {
    let s = base;
    const copy = String(req.query.copy || '');
    if (copy) {
      const src = copy.startsWith('b:') ? engine.builtinRole(copy.slice(2)) : engine.customRole(Number(copy));
      if (src) {
        const matrix = {};
        const asLevel = src.builtin ? ({ viewer: 'view', agent: 'edit', manager: 'full', admin: 'full' })[src.key] : null;
        for (const e of engine.modules()) matrix[e.href] = src.builtin ? (engine.roleLevel(src, e.href) === 'none' ? 'none' : asLevel) : engine.roleLevel(src, e.href);
        s = { ...s, matrix, caps: { ...src.caps, limits: { ...(src.caps.limits || {}) } }, base: src.builtin ? (src.key === 'admin' ? 'manager' : src.key) : src.base };
      }
    }
    return s;
  };
  router.get('/people/roles/new', RG, (req, res) => {
    const t = engine.templateRole(String(req.query.template || ''));
    const blank = { name: '', description: '', base: 'agent', default_level: 'none', color: 'sea', matrix: Object.fromEntries(engine.modules().map((e) => [e.href, e.href === '/admin' ? 'view' : 'none'])), caps: { ...Object.fromEntries(engine.CAPS.map((c) => [c, false])), limits: {} } };
    const base = t ? { ...blank, name: t.en, template: t.key, description: i18n.english(t.desc), base: t.base, matrix: t.matrix, caps: t.caps } : blank;
    roleEditor(req, res, { start: startFrom(req, base), title: t ? tr(t.name) : tr('ppl|New role'), action: '/admin/people/roles' });
  });
  router.get('/people/roles/b/:key', RMG, (req, res, next) => {
    if (!engine.BUILTIN.includes(req.params.key)) return next();
    const r = engine.builtinRole(req.params.key);
    const asLevel = ({ viewer: 'view', agent: 'edit', manager: 'full', admin: 'full' })[r.key];
    const matrix = Object.fromEntries(engine.modules().map((e) => [e.href, engine.roleLevel(r, e.href) === 'none' ? 'none' : asLevel]));
    roleEditor(req, res, { role: r, start: { name: engine.roleName(r), base: r.key === 'admin' ? 'manager' : r.key, matrix, caps: r.caps, default_level: asLevel }, title: engine.roleName(r), action: '' });
  });
  router.get('/people/roles/:id(\\d+)', RMG, (req, res, next) => {
    const r = engine.customRole(Number(req.params.id));
    if (!r) return next();
    const start = startFrom(req, { name: r.name, description: r.description, base: r.base, default_level: r.default_level, color: r.color, template: r.template, matrix: Object.fromEntries(engine.modules().map((e) => [e.href, engine.roleLevel(r, e.href)])), caps: r.caps });
    roleEditor(req, res, { role: r, start, title: engine.roleName(r), action: `/admin/people/roles/${r.id}` });
  });

  // Save: first a preview of what changes and for whom; the confirmed form posts again with confirm=1.
  function saveRoleRoute(req, res, role) {
    if (role && !isAdmin(req.user) && req.user.role_id === role.id) return h.back(req, res, `/admin/people/roles/${role.id}`, 'error', tr('ppl|You hold this role yourself, so another person with Give access edits it.'));
    const f = readRoleForm(req.body, role);
    if (!f.name) return h.back(req, res, role ? `/admin/people/roles/${role.id}` : '/admin/people/roles/new', 'error', tr('ppl|Give the role a name.'));
    if (db.get('SELECT id FROM ppl_roles WHERE name = ? COLLATE NOCASE AND archived = 0 AND id != ?', f.name, role ? role.id : 0)) return h.back(req, res, role ? `/admin/people/roles/${role.id}` : '/admin/people/roles/new', 'error', tr('ppl|Another role already has that name.'));
    // only what the change raises counts as given
    const want = role ? { base: engine.RANK[f.base] > engine.RANK[role.base] ? f.base : null, modules: {}, caps: {}, limits: {} } : roleAsGrant(f);
    if (role) {
      for (const [href, l] of Object.entries(f.matrix)) if (engine.lv(l) > engine.lv(engine.roleLevel(role, href))) want.modules[href] = l;
      for (const c of engine.CAPS) if (f.caps[c] && !role.caps[c]) want.caps[c] = true;
      for (const [k, v] of Object.entries(f.limits)) if (role.caps.limits[k] === undefined || v > role.caps.limits[k]) want.limits[k] = v;
    }
    const op = { op: 'role_save', role_id: role ? role.id : null, fields: f };
    if (!req.body.confirm) {
      const diff = role ? roleDiff(role, f) : [];
      const affected = role ? db.all("SELECT * FROM users WHERE role_id = ? AND active = 1 AND role != 'admin' ORDER BY name", role.id) : [];
      const problems = engine.escalation(req.user, want);
      const sensitive = engine.twoPerson() && engine.sensitive(want) && h.approvals;
      const hiddenInputs = Object.entries(req.body).filter(([k]) => k !== '_csrf' && k !== 'confirm').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
      const raised = diff.filter((c) => (c.kind === 'module' && engine.lv(c.to) > engine.lv(c.from)) || (c.kind === 'cap' && c.to === 'on'));
      const lowered = diff.filter((c) => (c.kind === 'module' && engine.lv(c.to) < engine.lv(c.from)) || (c.kind === 'cap' && c.to === 'off'));
      const other = diff.filter((c) => !raised.includes(c) && !lowered.includes(c));
      const list = (items, cls) => (items.length ? `<ul class="ppl-diff ppl-diff--${cls}">${items.map((c) => `<li>${esc(changeText(c))}</li>`).join('')}</ul>` : '');
      const body = `<div class="grid grid--side"><div class="stack">${ui.card(role ? tr('ppl|What changes in {role}', { role: f.name }) : tr('ppl|A new role: {role}', { role: f.name }), `
        ${problems.length ? `<p class="alert alert--error">${esc(tr('ppl|You cannot give more than you have yourself: {what}.', { what: problems.map((p) => (p.kind === 'module' ? tr('ppl|{level} on {module}', { level: tr(LEVEL[p.want][0]), module: moduleName(p.key) }) : p.kind === 'cap' ? capName(p.key) : p.kind === 'base' ? tr(RANK[p.want]) : kindName(p.key))).join(', ') }))}</p>` : ''}
        ${role ? (diff.length ? `${raised.length ? `<h3 class="ppl-h3 ppl-up">${esc(tn(raised.length, 'ppl|{n} more access', 'ppl|{n} more access'))}</h3>${list(raised, 'up')}` : ''}${lowered.length ? `<h3 class="ppl-h3 ppl-down">${esc(tn(lowered.length, 'ppl|{n} less access', 'ppl|{n} less access'))}</h3>${list(lowered, 'down')}` : ''}${other.length ? `<h3 class="ppl-h3">${esc(tr('ppl|Other changes'))}</h3>${list(other, 'other')}` : ''}` : `<p class="muted">${esc(tr('ppl|Nothing changes in the access; only the name or description.'))}</p>`)
    : `<p>${esc(tr('ppl|{n} of {total} modules', { n: Object.values(f.matrix).filter((l) => l !== 'none').length + 1, total: engine.modules().length }))} · ${esc(tr(RANK[f.base]))}</p><div class="ppl-chips">${engine.CAPS.filter((c) => f.caps[c]).map((c) => `<span class="ppl-chip is-on">${esc(capName(c))}</span>`).join('')}</div>`}
        ${sensitive ? `<p class="notice">${ui.icon('shield')}<span>${esc(tr('ppl|This is a sensitive change: it will wait for a second administrator in Approvals.'))}</span></p>` : ''}
        ${problems.length ? '' : ui.form(role ? `/admin/people/roles/${role.id}` : '/admin/people/roles', req.session.csrf, `${hiddenInputs}<input type="hidden" name="confirm" value="1"><div class="row">${ui.btn(esc(sensitive ? tr('ppl|Send for approval') : tr('ppl|Confirm and save')), { cls: 'btn--primary', ic: 'check' })}<a class="btn btn--ghost" href="${role ? `/admin/people/roles/${role.id}` : '/admin/people/roles/new'}">${esc(tr('ppl|Back to the editor'))}</a></div>`)}`)}</div>
        <div class="stack">${ui.card(tr('ppl|Who it affects'), affected.length ? `<p><b>${esc(tn(affected.length, 'ppl|{n} person', 'ppl|{n} people'))}</b> ${esc(tr('ppl|get these changes the moment it is saved.'))}</p><ul class="list">${affected.map((p) => `<li><span class="what"><b>${esc(p.name)}</b><small>${esc(p.title ? i18n.tx(p.title) : p.email)}</small></span></li>`).join('')}</ul>` : `<p class="muted pad">${esc(role ? tr('ppl|Nobody has this role yet.') : tr('ppl|Nobody yet: give it to people from their page.'))}</p>`)}</div></div>`;
      return shell(req, res, { tab: '/admin/people/roles', title: tr('ppl|Review the change'), crumbs: [['/admin/people', tr('nav|Users & permissions')], ['/admin/people/roles', tr('ppl|Roles')]], body });
    }
    return submit(req, res, op, want, (id) => `/admin/people/roles/${id || (role ? role.id : '')}`, role ? tr('ppl|The role {role} is saved.', { role: f.name }) : tr('ppl|The role {role} is created.', { role: f.name }));
  }
  router.post('/people/roles', RG, (req, res) => saveRoleRoute(req, res, null));
  router.post('/people/roles/:id(\\d+)', RG, (req, res, next) => {
    const r = engine.customRole(Number(req.params.id));
    if (!r) return next();
    return saveRoleRoute(req, res, r);
  });
  router.post('/people/roles/:id(\\d+)/clone', RG, (req, res, next) => {
    const r = engine.customRole(Number(req.params.id));
    if (!r) return next();
    if (engine.escalation(req.user, engine.roleGrant(r)).length) return h.back(req, res, `/admin/people/roles/${r.id}`, 'error', tr('ppl|You cannot give more than you have yourself: {what}.', { what: engine.roleName(r) }));
    let name = `${engine.roleName(r)} (2)`;
    for (let i = 3; db.get('SELECT id FROM ppl_roles WHERE name = ? COLLATE NOCASE', name); i++) name = `${engine.roleName(r)} (${i})`;
    const id = saveRole(null, { name, description: r.description, base: r.base, default_level: r.default_level, color: r.color, template: null, matrix: r.matrix, caps: Object.fromEntries(engine.CAPS.map((c) => [c, !!r.caps[c]])), limits: r.caps.limits || {} }, req.user);
    h.back(req, res, `/admin/people/roles/${id}`, 'ok', tr('ppl|A copy was made: {role}. Change it and save.', { role: name }));
  });
  router.post('/people/roles/b/:key/clone', RG, (req, res, next) => {
    if (!['viewer', 'agent', 'manager'].includes(req.params.key)) return next();
    const r = engine.builtinRole(req.params.key);
    const asLevel = ({ viewer: 'view', agent: 'edit', manager: 'full' })[r.key];
    const matrix = Object.fromEntries(engine.modules().map((e) => [e.href, engine.roleLevel(r, e.href) === 'none' ? 'none' : asLevel]));
    const want = { base: r.key, modules: matrix, caps: { export: true } };
    if (engine.escalation(req.user, want).length) return h.back(req, res, '/admin/people/roles', 'error', tr('ppl|You cannot give more than you have yourself: {what}.', { what: engine.roleName(r) }));
    let name = `${engine.roleName(r)} (2)`;
    for (let i = 3; db.get('SELECT id FROM ppl_roles WHERE name = ? COLLATE NOCASE', name); i++) name = `${engine.roleName(r)} (${i})`;
    const id = saveRole(null, { name, description: null, base: r.key, default_level: 'none', color: 'sea', template: null, matrix, caps: { export: true }, limits: {} }, req.user);
    h.back(req, res, `/admin/people/roles/${id}`, 'ok', tr('ppl|A copy was made: {role}. Change it and save.', { role: name }));
  });
  router.post('/people/roles/:id(\\d+)/archive', RG, (req, res, next) => {
    const r = engine.customRole(Number(req.params.id));
    if (!r) return next();
    const n = db.value('SELECT COUNT(*) FROM users WHERE role_id = ? AND active = 1', r.id);
    if (n) return h.back(req, res, `/admin/people/roles/${r.id}`, 'error', tn(n, 'ppl|Move its {n} person to another role first.', 'ppl|Move its {n} people to another role first.'));
    db.run('UPDATE ppl_roles SET archived = 1, updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), req.user.id, r.id);
    engine.touch();
    history({ role_id: r.id, actor: req.user, action: 'role_archived' });
    h.log(req, 'Archived a role', 'ppl_role', r.id, r.name);
    h.back(req, res, '/admin/people/roles', 'ok', tr('ppl|The role {role} is archived.', { role: engine.roleName(r) }));
  });
  router.post('/people/roles/:id(\\d+)/restore', RG, (req, res, next) => {
    const r = engine.customRole(Number(req.params.id));
    if (!r) return next();
    db.run('UPDATE ppl_roles SET archived = 0, updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), req.user.id, r.id);
    engine.touch();
    history({ role_id: r.id, actor: req.user, action: 'role_restored' });
    h.log(req, 'Restored a role', 'ppl_role', r.id, r.name);
    h.back(req, res, `/admin/people/roles/${r.id}`, 'ok', tr('ppl|The role {role} is back.', { role: engine.roleName(r) }));
  });

  // ---------- access review ----------
  const quarter = (d = new Date()) => `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  router.get('/people/review', RMG, (req, res) => {
    const csrf = req.session.csrf;
    const users = db.all('SELECT * FROM users WHERE active = 1 ORDER BY name');
    const mods = engine.modules();
    const period = /^\d{4}-Q[1-4]$/.test(String(req.query.period || '')) ? req.query.period : quarter();
    const reviews = Object.fromEntries(db.all('SELECT r.*, v.name reviewer_name FROM ppl_reviews r LEFT JOIN users v ON v.id = r.reviewer_id WHERE r.period = ?', period).map((r) => [r.user_id, r]));
    const effs = new Map(users.map((u) => [u.id, engine.effective(u)]));
    const done = users.filter((u) => reviews[u.id]).length;
    const powerful = users.filter((u) => {
      const e = effs.get(u.id);
      return e.admin || e.caps.grant.on || e.caps.manage_users.on || e.caps.finance.on || e.caps.hr.on;
    });
    const dormantList = users.filter(dormant);
    const kpis = [
      ui.kpi({ label: tr('ppl|People reviewed this quarter'), value: `${done} / ${users.length}`, bar: users.length ? done / users.length : 0, sub: esc(period) }),
      ui.kpi({ label: tr('ppl|Powerful rights'), value: ui.n0(powerful.length), sub: esc(tr('ppl|Administrators, give access, manage people, HR, finance')) }),
      ui.kpi({ label: tr('ppl|Dormant accounts'), value: ui.n0(dormantList.length), tone: dormantList.length ? 'kpi--alert' : '', sub: esc(tr('ppl|No sign-in for {n} days', { n: dormantDays() })) }),
      ui.kpi({ label: tr('ppl|Changes in 30 days'), value: ui.n0(db.value('SELECT COUNT(*) FROM ppl_history WHERE at >= ?', new Date(Date.now() - 30 * 86400000).toISOString())), href: '/admin/people/history' }),
    ].join('');
    const L = { none: '', view: 'V', edit: 'E', full: 'F' };
    const heat = `<div class="tablewrap ppl-scroll ppl-heatwrap"><table class="ppl-heat"><thead><tr><th class="ppl-heat__who">${esc(tr('Person'))}</th>${mods.map((e) => `<th title="${esc(tr(e.label))}"><span class="ppl-heat__ic">${ui.icon(e.ic)}</span><span class="ppl-heat__lbl">${esc(tr(e.label))}</span></th>`).join('')}</tr></thead><tbody>${users.map((u) => `<tr><th class="ppl-heat__who"><a href="/admin/people/${u.id}/access">${esc(u.name)}</a><small>${esc(engine.roleName(engine.roleOf(u)))}</small></th>${mods.map((e) => {
      const m = effs.get(u.id).modules[e.href];
      return `<td class="ppl-heat__c ppl-lv--${m.level}${m.source === 'temporary' ? ' is-temp' : ''}${m.source === 'override' || m.source === 'hidden' ? ' is-set' : ''}" title="${esc(`${u.name} · ${tr(e.label)}: ${tr(LEVEL[m.level][0])}`)}">${L[m.level]}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
      <ul class="ppl-legend">${['full', 'edit', 'view', 'none'].map((l) => `<li>${levelPill(l)}</li>`).join('')}<li><span class="ppl-key is-set"></span> ${esc(tr('ppl|set for the person'))}</li><li><span class="ppl-key is-temp"></span> ${esc(tr('ppl|temporary'))}</li></ul>`;
    const certify = canManage(req) || canGrant(req) ? ui.form('/admin/people/review/certify', csrf, `<input type="hidden" name="period" value="${esc(period)}"><div class="tablewrap"><table class="table table--resp ppl-cert"><thead><tr><th>${esc(tr('Person'))}</th><th>${esc(tr('ppl|Access'))}</th><th>${esc(tr('ppl|Decision'))}</th><th>${esc(tr('ppl|Note'))}</th></tr></thead><tbody>${users.map((u) => {
      const r = reviews[u.id];
      const e = effs.get(u.id);
      return `<tr><td data-label="${esc(tr('Person'))}"><b>${esc(u.name)}</b><small class="sub">${esc(engine.roleName(engine.roleOf(u)))}${dormant(u) ? ` · ${esc(tr('ppl|Dormant'))}` : ''}</small></td><td data-label="${esc(tr('ppl|Access'))}">${esc(tr('ppl|{n} of {total} modules', { n: countOpen(e), total: mods.length }))}<span class="ppl-chips">${capChips(e)}</span></td><td data-label="${esc(tr('ppl|Decision'))}"><select name="d_${u.id}" aria-label="${esc(tr('ppl|Decision'))}"><option value="">—</option>${Object.entries(DECISION).map(([k, [l]]) => `<option value="${k}"${r && r.decision === k ? ' selected' : ''}>${esc(tr(l))}</option>`).join('')}</select>${r ? `<small class="sub">${esc(tr('ppl|{name}, {when}', { name: r.reviewer_name || '—', when: ui.date(r.at) }))}</small>` : ''}</td><td data-label="${esc(tr('ppl|Note'))}"><input class="cellin" name="n_${u.id}" value="${esc(r ? r.note || '' : '')}" maxlength="200"></td></tr>`;
    }).join('')}</tbody></table></div><div class="row">${ui.btn(esc(tr('ppl|Save the review')), { cls: 'btn--primary', ic: 'check' })}<span class="muted small">${esc(tr('ppl|Every decision is kept with your name and the time.'))}</span></div>`, { cls: 'stack' }) : '';
    const dorm = dormantList.length ? ui.form('/admin/people/review/deactivate', csrf, `<ul class="list ppl-dormant">${dormantList.map((u) => `<li><label class="check"><input type="checkbox" name="u" value="${u.id}"${u.id === req.user.id || (isAdmin(u) && !isAdmin(req.user)) ? ' disabled' : ''}> <span class="what"><b>${esc(u.name)}</b><small>${u.last_login_at ? esc(tr('ppl|last sign-in {when}', { when: ui.rel(u.last_login_at) })) : esc(tr('ppl|never signed in'))} · ${esc(engine.roleName(engine.roleOf(u)))}</small></span></label></li>`).join('')}</ul>${canManage(req) ? ui.btn(esc(tr('ppl|Deactivate the ticked accounts')), { cls: 'btn--ghost btn--sm' }) : ''}`, { cls: 'stack' }) : `<p class="muted pad">${esc(tr('ppl|Everyone has signed in recently.'))}</p>`;
    const strong = powerful.length ? `<ul class="list">${powerful.map((u) => `<li><a href="/admin/people/${u.id}/access"><span class="what"><b>${esc(u.name)}</b><small>${effs.get(u.id).admin ? esc(tr('ppl|Administrator')) : ''}<span class="ppl-chips">${capChips(effs.get(u.id))}</span></small></span></a></li>`).join('')}</ul>` : '';
    const periods = [quarter(), quarter(new Date(Date.now() - 92 * 86400000)), quarter(new Date(Date.now() - 184 * 86400000))];
    const pnav = `<nav class="tabs tabs--sub">${[...new Set(periods)].map((p) => `<a class="tab${p === period ? ' is-on' : ''}" href="/admin/people/review?period=${p}">${esc(p)}</a>`).join('')}</nav>`;
    const changes = historyTable(historyRows().slice(0, 10));
    const actions = ui.btn(esc(tr('Export CSV')), { href: '/admin/people/review/export.csv', cls: 'btn--ghost', ic: 'dl' });
    shell(req, res, { tab: '/admin/people/review', title: tr('ppl|Access review'), actions, body: `<div class="kpis kpis--4">${kpis}</div>${ui.card(tr('ppl|Everyone × every module'), heat)}<div class="grid grid--side"><div class="stack">${ui.card(tr('ppl|Certify this quarter'), `${pnav}${certify}`)}</div><div class="stack">${ui.card(tr('ppl|Dormant accounts'), dorm)}${ui.card(tr('ppl|Powerful rights'), strong)}</div></div>${ui.card(tr('ppl|Recent changes'), changes, { action: ui.btn(esc(tr('ppl|All changes')), { href: '/admin/people/history', cls: 'btn--ghost btn--sm' }) })}` });
  });
  router.get('/people/review/export.csv', RMG, (req, res) => {
    const users = db.all('SELECT * FROM users ORDER BY active DESC, name');
    const mods = engine.modules();
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
    };
    const head = ['Name', 'Email', 'Role', 'Status', 'Last sign-in', ...engine.CAPS.map((c) => english(CAP[c][0])), ...mods.map((e) => english(e.label))];
    const lines = users.map((u) => {
      const e = engine.effective(u);
      return [u.name, u.email, english(engine.roleName(engine.roleOf(u))), english(STATUS[statusOf(u)][0]), u.last_login_at || '', ...engine.CAPS.map((c) => (e.caps[c].on ? 'yes' : '')), ...mods.map((m) => e.modules[m.href].level)].map(cell).join(',');
    });
    h.log(req, 'Exported', 'export', null, 'Access review');
    res.set('Content-Disposition', `attachment; filename="the-wave-access-${M.today()}.csv"`).type('text/csv; charset=utf-8').send(`﻿${[head.map(cell).join(','), ...lines].join('\r\n')}\r\n`);
  });
  router.post('/people/review/certify', RMG, (req, res) => {
    const period = /^\d{4}-Q[1-4]$/.test(String(req.body.period || '')) ? req.body.period : quarter();
    let n = 0;
    for (const u of db.all('SELECT id FROM users WHERE active = 1')) {
      const d = req.body[`d_${u.id}`];
      if (!DECISION[d]) continue;
      const note = h.str(req.body[`n_${u.id}`], 200) || null;
      const old = db.get('SELECT * FROM ppl_reviews WHERE period = ? AND user_id = ?', period, u.id);
      if (old && old.decision === d && (old.note || null) === note) continue;
      db.run('INSERT INTO ppl_reviews (period, user_id, reviewer_id, decision, note, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(period, user_id) DO UPDATE SET reviewer_id = excluded.reviewer_id, decision = excluded.decision, note = excluded.note, at = excluded.at',
        period, u.id, req.user.id, d, note, nowIso());
      history({ user_id: u.id, actor: req.user, action: 'certified', changes: [{ kind: 'review', key: period, from: old ? old.decision : null, to: d }], note });
      n++;
    }
    if (n) h.log(req, 'Certified access', 'ppl_review', null, period);
    h.back(req, res, `/admin/people/review?period=${period}`, 'ok', tn(n, 'ppl|Review saved: {n} decision.', 'ppl|Review saved: {n} decisions.'));
  });
  router.post('/people/review/deactivate', RM, (req, res) => {
    const ids = h.list(req.body.u).map(Number).filter(Boolean);
    let n = 0;
    for (const id of ids) {
      const u = userOf(id);
      if (!u || targetProblem(req, u) || !u.active) continue;
      if (isAdmin(u) && db.value("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1") <= 1) continue;
      db.run('UPDATE users SET active = 0, deactivated_at = ?, deactivated_by = ? WHERE id = ?', nowIso(), req.user.id, u.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      history({ user_id: u.id, actor: req.user, action: 'deactivated', note: 'ppl|Dormant account' });
      h.log(req, 'Deactivated an account', 'user', u.id, u.name);
      n++;
    }
    h.back(req, res, '/admin/people/review', 'ok', tn(n, 'ppl|{n} account deactivated.', 'ppl|{n} accounts deactivated.'));
  });

  // ---------- history ----------
  router.get('/people/history', RMG, (req, res) => {
    const who = Number(req.query.user) || null;
    const action = HIST[req.query.action] ? req.query.action : '';
    const where = [];
    const args = [];
    if (who) { where.push('x.user_id = ?'); args.push(who); }
    if (action) { where.push('x.action = ?'); args.push(action); }
    const f = h.listFilters(req, { cols: { date: 'x.at' }, dateLabel: tr('sort|Changed on'), sorts: [['newest', 'sort|Newest first', 'x.at DESC, x.id DESC'], ['oldest', 'sort|Oldest first', 'x.at ASC, x.id ASC'], ['person', 'sort|Person: A to Z', 'u.name IS NULL, u.name COLLATE NOCASE, x.at DESC']] });
    where.push(...f.where); args.push(...f.args);
    const rows = historyRowsBy(f.order, where.length ? `WHERE ${where.join(' AND ')}` : '', ...args);
    const filters = `<form method="get" action="/admin/people/history" class="filters">${ui.select('user', tr('Person'), db.all('SELECT id, name FROM users ORDER BY name').map((u) => [u.id, u.name]), who || '', { blank: tr('ppl|Everyone'), attrs: { 'data-autosubmit': '' } })}${ui.select('action', tr('ppl|Change'), Object.entries(HIST).map(([k, v]) => [k, tr(v)]), action, { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}${f.fields}<div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div>${f.quick}</form>`;
    shell(req, res, { tab: '/admin/people/history', title: tr('ppl|Permission history'), body: `${filters}${ui.card(f.sortKey === 'newest' ? tr('ppl|Every change, newest first') : tr('ppl|Permission history'), historyTable(rows), { sub: esc(tn(rows.length, 'ppl|{n} change', 'ppl|{n} changes')) })}` });
  });

  // ---------- settings ----------
  router.get('/people/settings', RMG, (req, res) => {
    const csrf = req.session.csrf;
    const admin = isAdmin(req.user);
    const on = engine.twoPerson();
    const admins = db.value("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1");
    const form = ui.form('/admin/people/settings', csrf, `
      <label class="ppl-switch${on ? ' is-on' : ''}"><input type="checkbox" name="two_person" value="1"${on ? ' checked' : ''}${!admin || !h.approvals ? ' disabled' : ''}><span><b>${esc(tr('ppl|Two-person rule'))}</b><small>${esc(tr('ppl|Sensitive changes wait for a second administrator in Approvals: making an administrator, full access to accounting, HR, settings or people, and the HR, finance, Manage people or Give access permissions.'))}</small>${admins < 2 ? `<small class="ppl-warn">${esc(tr('ppl|You have one administrator: add a second before turning this on, or changes will wait with nobody to approve them.'))}</small>` : ''}${!h.approvals ? `<small class="ppl-warn">${esc(tr('ppl|Needs the Approvals module.'))}</small>` : ''}</span></label>
      <div class="fields">${ui.input('lock_after', tr('ppl|Lock an account after this many failed sign-ins'), setting('ppl_lock_after', 5), { type: 'number', min: 3, max: 20 })}${ui.input('lock_minutes', tr('ppl|For this many minutes'), setting('ppl_lock_minutes', 15), { type: 'number', min: 1, max: 1440 })}${ui.input('dormant_days', tr('ppl|Dormant after this many days without a sign-in'), dormantDays(), { type: 'number', min: 7, max: 730 })}${ui.input('invite_days', tr('ppl|Invitation links work for this many days'), inviteDays(), { type: 'number', min: 1, max: 30 })}</div>
      ${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    const rules = ui.card(tr('ppl|How access works'), `<ol class="ppl-rules">
      <li>${esc(tr('ppl|Administrators can do everything, always.'))}</li>
      <li>${esc(tr('ppl|Everyone else gets what their role gives: a level per module and a set of permissions.'))}</li>
      <li>${esc(tr('ppl|A person can have changes on top of their role, permanent or until a date.'))}</li>
      <li>${esc(tr('ppl|Nobody gives more than they have, nobody changes their own access, and only administrators make administrators.'))}</li>
      <li>${esc(tr('ppl|Every change is in the history, with who made it and who approved it.'))}</li></ol>`);
    shell(req, res, { tab: '/admin/people/settings', title: tr('ppl|Access settings'), body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('ppl|Security'), form)}</div><div class="stack">${rules}</div></div>` });
  });
  router.post('/people/settings', RMG, (req, res) => {
    const clamp = (v, a, b, d) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d;
    };
    if (isAdmin(req.user) && h.approvals) {
      const want = req.body.two_person === '1' ? '1' : '0';
      if (want !== (engine.twoPerson() ? '1' : '0')) {
        db.setSetting('ppl_two_person', want);
        history({ actor: req.user, action: 'access', note: want === '1' ? 'ppl|Two-person rule turned on' : 'ppl|Two-person rule turned off' });
      }
    }
    db.setSetting('ppl_lock_after', String(clamp(req.body.lock_after, 3, 20, 5)));
    db.setSetting('ppl_lock_minutes', String(clamp(req.body.lock_minutes, 1, 1440, 15)));
    db.setSetting('ppl_dormant_days', String(clamp(req.body.dormant_days, 7, 730, 60)));
    db.setSetting('ppl_invite_days', String(clamp(req.body.invite_days, 1, 30, 7)));
    h.log(req, 'Changed the access settings', 'settings', null);
    h.back(req, res, '/admin/people/settings', 'ok', tr('Saved.'));
  });

  // for other modules and the sample data
  h.people = { applyOp, history, createInvite, saveRole };
};
