'use strict';

// Who may do what in the office: roles, a permission matrix, per-person changes and temporary access.
//
// Every sidebar entry (ui.NAV) is a module. A person's access to a module is one of four levels:
//
//   none  — the module is not in their menu and its pages answer "no access"
//   view  — they can open its pages
//   edit  — they can also create and change records (forms that post)
//   full  — they can also delete, void, cancel, reverse and approve
//
// and capabilities sit beside the matrix: export (CSV and print), hr (staff files, salaries), finance
// (accounting, banks), manage_users (invite, edit, deactivate people), grant (change roles and access),
// assistant (the AI assistant), plus approval limits per kind of approval request.
//
// Where a person's access comes from, in order:
//   1. Administrators: everything, always.
//   2. Their role. Built-in roles (viewer, agent, manager) open every module their rank allows at
//      full, so their pages and actions behave exactly as before; inside a module the rank still
//      decides (a viewer only reads). Custom roles carry their own matrix and capabilities, and a base
//      rank (users.role) that the existing rank checks keep using.
//   3. Modules an administrator hid on the Team page (users.hidden_modules, the earlier switch).
//   4. Permanent changes for that person (ppl_overrides with no end date): set a module's level exactly.
//   5. Temporary access (an end date): raises a level until then, and ends by itself.
//   6. Ceilings: a module meant for HR, finance, managers or administrators stays closed without that.
//
// effective(user) returns all of it with the source of every cell, and check(user, method, url) is
// the guard routes/core.js runs before any module sees a request.

const i18n = require('./i18n');
const M = require('./model');

const LEVELS = ['none', 'view', 'edit', 'full'];
const RANKS = ['viewer', 'agent', 'manager', 'admin'];
const RANK = { viewer: 0, agent: 1, manager: 2, admin: 3 };
const CAPS = ['export', 'hr', 'finance', 'manage_users', 'grant', 'assistant'];
const BUILTIN = ['viewer', 'agent', 'manager', 'admin'];
const lv = (l) => Math.max(0, LEVELS.indexOf(l));
const maxLevel = (a, b) => (lv(a) >= lv(b) ? a : b);

// modules whose full level, and capabilities whose grant, need a second administrator when the
// two-person rule is on
const SENSITIVE_MODULES = ['/admin/accounting', '/admin/hr', '/admin/hr/payroll', '/admin/hr/leave', '/admin/hr/advances', '/admin/settings', '/admin/integrations', '/admin/people'];
const SENSITIVE_CAPS = ['grant', 'manage_users', 'hr', 'finance'];

// the pages that belong to a module without living under its address (on top of ui.NAV_ALIASES)
const ALIASES = { '/admin/approvals': '/admin/work' };

// a POST to one of these ends needs full access
const FULL_ACTION = /\/(delete|remove|void|cancel|reverse|decide|approve|reject|writeoff|write-off|archive)$/;
// downloads and printouts need the export capability
const isExport = (path, query) => /\.csv$/.test(path) || /\/(print|export)(\/|$)/.test(path) || /(^|&)format=csv(&|$)/.test(query);

// Ready-made roles to start a custom role from. Levels: n v e f; '*' is every other module.
const TEMPLATES = {
  finance_officer: {
    name: 'ppl|Finance officer', en: 'Finance officer', base: 'manager',
    desc: 'ppl|Accounts, billing, cheques, collections and purchasing; reads leases and tenants.',
    matrix: { '*': 'v', '/admin/accounting': 'f', '/admin/billing': 'f', '/admin/cheques': 'f', '/admin/collections': 'f', '/admin/purchasing': 'f', '/admin/work': 'f', '/admin/reports': 'v', '/admin/owner-report': 'v', '/admin/hr': 'n', '/admin/hr/leave': 'n', '/admin/hr/payroll': 'n', '/admin/hr/advances': 'n' },
    caps: { export: 1, finance: 1, assistant: 1 }, limits: { writeoff: 50000, refund: 100000, purchase: 250000 },
  },
  hr_officer: {
    name: 'ppl|HR officer', en: 'HR officer', base: 'agent',
    desc: 'ppl|Employees, leave, payroll and salary advances; nothing financial beyond pay.',
    matrix: { '*': 'n', '/admin': 'v', '/admin/work': 'e', '/admin/hr': 'f', '/admin/hr/leave': 'f', '/admin/hr/payroll': 'e', '/admin/hr/advances': 'e', '/admin/documents': 'e', '/admin/team': 'v' },
    caps: { export: 1, hr: 1, assistant: 1 }, limits: { advance: 20000 },
  },
  collections_officer: {
    name: 'ppl|Collections officer', en: 'Collections officer', base: 'agent',
    desc: 'ppl|Chases what tenants owe: reminders, calls, plans and cheques; reads leases and billing.',
    matrix: { '*': 'n', '/admin': 'v', '/admin/work': 'e', '/admin/collections': 'e', '/admin/cheques': 'e', '/admin/billing': 'v', '/admin/leases': 'v', '/admin/tenants': 'v', '/admin/brands': 'v', '/admin/documents': 'v' },
    caps: { export: 1, assistant: 1 }, limits: {},
  },
  leasing_agent: {
    name: 'ppl|Leasing agent', en: 'Leasing agent', base: 'agent',
    desc: 'ppl|Leads, offers, conversations and the plan; reads leases and tenant files.',
    matrix: { '*': 'n', '/admin': 'v', '/admin/work': 'e', '/admin/inbox': 'e', '/admin/leads': 'e', '/admin/pipeline': 'e', '/admin/offers': 'e', '/admin/conversations': 'e', '/admin/calendar': 'e', '/admin/units': 'v', '/admin/brands': 'e', '/admin/tenants': 'v', '/admin/specialty': 'e', '/admin/leases': 'v', '/admin/reports': 'v', '/admin/assistant': 'e' },
    caps: { assistant: 1 }, limits: {},
  },
  security_supervisor: {
    name: 'ppl|Security supervisor', en: 'Security supervisor', base: 'agent',
    desc: 'ppl|Patrols, cleaning, incidents, keys, safety and licences, parking incidents and shopper feedback.',
    matrix: { '*': 'n', '/admin': 'v', '/admin/work': 'e', '/admin/security': 'f', '/admin/compliance': 'e', '/admin/feedback': 'e', '/admin/parking': 'v', '/admin/maintenance': 'v', '/admin/footfall': 'v' },
    caps: { assistant: 1 }, limits: {},
  },
  maintenance_coordinator: {
    name: 'ppl|Maintenance coordinator', en: 'Maintenance coordinator', base: 'agent',
    desc: 'ppl|Work orders, planned maintenance, the parts store, energy and safety checks.',
    matrix: { '*': 'n', '/admin': 'v', '/admin/work': 'e', '/admin/maintenance': 'f', '/admin/purchasing': 'e', '/admin/energy': 'e', '/admin/compliance': 'e', '/admin/utilities': 'e', '/admin/feedback': 'v', '/admin/units': 'v', '/admin/tenants': 'v', '/admin/fitout': 'e' },
    caps: { export: 1, assistant: 1 }, limits: { purchase: 25000 },
  },
  parking_cashier: {
    name: 'ppl|Parking cashier', en: 'Parking cashier', base: 'agent',
    desc: 'ppl|The car park only: the exit booth, tills and visits. No exports.',
    matrix: { '*': 'n', '/admin': 'v', '/admin/parking': 'e' },
    caps: {}, limits: {},
  },
  marketing_media: {
    name: 'ppl|Marketing & media', en: 'Marketing & media', base: 'agent',
    desc: 'ppl|Advertising sales, the website, short-term space, footfall and feedback.',
    matrix: { '*': 'n', '/admin': 'v', '/admin/work': 'e', '/admin/media': 'f', '/admin/website': 'f', '/admin/specialty': 'e', '/admin/footfall': 'v', '/admin/feedback': 'v', '/admin/subscribers': 'e', '/admin/brands': 'v', '/admin/reports': 'v' },
    caps: { export: 1, assistant: 1 }, limits: { media_discount: 15 },
  },
  owner_readonly: {
    name: 'ppl|Owner (read only)', en: 'Owner (read only)', base: 'viewer',
    desc: 'ppl|Sees everything that matters, changes nothing: reports, the owner report, revenue and operations.',
    matrix: { '*': 'v', '/admin/hr': 'n', '/admin/hr/leave': 'n', '/admin/hr/payroll': 'n', '/admin/hr/advances': 'n', '/admin/integrations': 'n', '/admin/settings': 'n', '/admin/audit': 'n', '/admin/people': 'n' },
    caps: { export: 1, finance: 1, assistant: 1 }, limits: {},
  },
};
const LETTER = { n: 'none', v: 'view', e: 'edit', f: 'full' };

const SCHEMA = `
  CREATE TABLE ppl_roles (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, base TEXT NOT NULL DEFAULT 'agent',
    matrix TEXT NOT NULL DEFAULT '{}', caps TEXT NOT NULL DEFAULT '{}', default_level TEXT NOT NULL DEFAULT 'none',
    template TEXT, color TEXT, archived INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE ppl_overrides (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL DEFAULT 'module', key TEXT NOT NULL, level TEXT NOT NULL, expires_at TEXT, reason TEXT,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ppl_overrides_user ON ppl_overrides(user_id, subject, key);
  CREATE TABLE ppl_invites (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'invite', email TEXT NOT NULL, name TEXT, title TEXT,
    role TEXT NOT NULL DEFAULT 'agent', role_id INTEGER REFERENCES ppl_roles(id) ON DELETE SET NULL, lang TEXT,
    token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, sent_at TEXT, sends INTEGER NOT NULL DEFAULT 0,
    accepted_at TEXT, revoked_at TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE ppl_logins (
    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, email TEXT, ok INTEGER NOT NULL,
    reason TEXT, ip TEXT, agent TEXT, at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ppl_logins_user ON ppl_logins(user_id, at);
  CREATE TABLE ppl_history (
    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, role_id INTEGER REFERENCES ppl_roles(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL, changes TEXT, note TEXT, at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ppl_history_user ON ppl_history(user_id, at);
  CREATE TABLE ppl_reviews (
    id INTEGER PRIMARY KEY, period TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL, decision TEXT NOT NULL, note TEXT, at TEXT NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0, UNIQUE(period, user_id)
  );
  ALTER TABLE users ADD COLUMN role_id INTEGER;
  ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until TEXT;
  ALTER TABLE users ADD COLUMN deactivated_at TEXT;
  ALTER TABLE users ADD COLUMN deactivated_by INTEGER;
  ALTER TABLE users ADD COLUMN invited_by INTEGER;
`;

const parse = (s, fb) => {
  try {
    const v = s ? JSON.parse(s) : fb;
    return v && typeof v === 'object' ? v : fb;
  } catch {
    return fb;
  }
};

function create({ db, ui }) {
  db.ensure('access-1', 'ALTER TABLE users ADD COLUMN hidden_modules TEXT;');
  db.ensure('people-1', SCHEMA);
  // Modules hidden on the Team page become permanent "none" changes, so the history and the access
  // pages show them; the column keeps working for anything that still writes it.
  if (db.setting('ppl_hidden_migrated') !== '1') {
    const t = new Date().toISOString();
    for (const u of db.all("SELECT id, role, hidden_modules FROM users WHERE hidden_modules IS NOT NULL AND hidden_modules != ''")) {
      let list = [];
      try {
        list = JSON.parse(u.hidden_modules);
      } catch { /* ignore */ }
      if (!Array.isArray(list) || u.role === 'admin') continue;
      for (const href of list.filter((x) => typeof x === 'string')) {
        if (!db.get("SELECT id FROM ppl_overrides WHERE user_id = ? AND subject = 'module' AND key = ? AND expires_at IS NULL", u.id, href)) {
          db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, reason, created_at) VALUES (?, 'module', ?, 'none', 'Hidden on the Team page', ?)", u.id, href, t);
        }
      }
      db.run('UPDATE users SET hidden_modules = NULL WHERE id = ?', u.id);
    }
    db.setSetting('ppl_hidden_migrated', '1');
  }

  let version = 1;
  const touch = () => { version++; };
  const cache = new WeakMap();
  const roleCache = new Map();

  const modules = () => ui.NAV_ENTRIES;
  const moduleOf = (href) => ui.NAV_ENTRIES.find((e) => e.href === href) || null;
  // the module a path belongs to
  function moduleFor(path) {
    const p = String(path || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/admin';
    for (const [a, to] of Object.entries(ALIASES)) if (p === a || p.startsWith(`${a}/`)) return to;
    return ui.navFor(p);
  }

  // ---------- roles ----------
  const hydrateRole = (r) => {
    if (!r) return null;
    const caps = parse(r.caps, {});
    return { ...r, builtin: false, matrix: parse(r.matrix, {}), caps: { ...Object.fromEntries(CAPS.map((c) => [c, !!caps[c]])), limits: caps.limits && typeof caps.limits === 'object' ? caps.limits : {} } };
  };
  function customRole(id) {
    if (!id) return null;
    const hit = roleCache.get(id);
    if (hit && hit.v === version) return hit.r;
    const r = hydrateRole(db.get('SELECT * FROM ppl_roles WHERE id = ?', Number(id)));
    roleCache.set(id, { v: version, r });
    return r;
  }
  // a built-in role as a role object (its matrix follows the rank)
  function builtinRole(key) {
    const matrix = {};
    for (const e of modules()) matrix[e.href] = key === 'admin' || !e.min || ['hr', 'finance'].includes(e.min) || RANK[key] >= RANK[e.min] ? 'full' : 'none';
    return {
      id: null, key, builtin: true, base: key, name: key, matrix, default_level: 'full',
      caps: { export: true, hr: key === 'admin', finance: key === 'admin', manage_users: key === 'admin', grant: key === 'admin', assistant: true, limits: {} },
    };
  }
  const roles = ({ archived = false } = {}) => [
    ...BUILTIN.map(builtinRole),
    ...db.all(`SELECT * FROM ppl_roles ${archived ? '' : 'WHERE archived = 0'} ORDER BY name`).map(hydrateRole),
  ];
  const roleOf = (user) => (user && user.role_id && user.role !== 'admin' ? customRole(user.role_id) || builtinRole(user.role) : builtinRole((user && user.role) || 'viewer'));
  const usersWithRole = (roleId) => (typeof roleId === 'string' && BUILTIN.includes(roleId)
    ? db.all('SELECT * FROM users WHERE role = ? AND role_id IS NULL ORDER BY name', roleId)
    : db.all('SELECT * FROM users WHERE role_id = ? ORDER BY name', Number(roleId)));
  // the matrix level a role gives a module, before the person's changes
  const roleLevel = (role, href) => {
    if (role.builtin) return role.matrix[href] || 'full';
    const v = role.matrix[href];
    return LEVELS.includes(v) ? v : role.default_level || 'none';
  };

  // ---------- one person ----------
  const hiddenOf = (user) => ui.hiddenModules(user);
  const overridesOf = (userId, at = new Date().toISOString()) => db.all('SELECT * FROM ppl_overrides WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id', userId, at);

  // Why a module stays closed whatever the matrix says (null when nothing stops it).
  function ceiling(eff, e) {
    if (!e || !e.min) return null;
    if (e.min === 'hr') return eff.caps.hr.on ? null : 'hr';
    if (e.min === 'finance') return eff.caps.finance.on ? null : 'finance';
    return RANK[eff.base] >= RANK[e.min] ? null : e.min;
  }

  // perm: permanent changes to use instead of the saved ones (a preview of an edit; hidden modules
  // are then taken as already moved into them)
  function compute(user, { perm = null } = {}) {
    const admin = user.role === 'admin';
    const role = roleOf(user);
    const at = new Date().toISOString();
    const eff = { admin, base: user.role || 'viewer', role, modules: {}, caps: {}, limits: {}, temp: [], overrides: [] };
    // capabilities
    for (const c of CAPS) {
      let on = admin || !!role.caps[c];
      let source = admin ? 'admin' : 'role';
      // built-in roles: HR and finance are the person's own switches
      if (!admin && role.builtin && (c === 'hr' || c === 'finance')) { on = !!user[c]; source = 'flag'; }
      eff.caps[c] = { on, source, until: null };
    }
    eff.limits = admin ? {} : { ...(role.caps.limits || {}) };
    const saved = admin ? [] : overridesOf(user.id, at);
    const rows = perm ? [...saved.filter((o) => o.expires_at), ...perm] : saved;
    for (const o of rows.filter((x) => x.subject === 'cap' && CAPS.includes(x.key) && !['hr', 'finance'].includes(x.key))) {
      const on = o.level === 'on' || o.level === 'full';
      if (o.expires_at) {
        if (on && !eff.caps[o.key].on) eff.caps[o.key] = { on: true, source: 'temporary', until: o.expires_at, id: o.id };
        eff.temp.push(o);
      } else {
        eff.caps[o.key] = { on, source: 'override', until: null, id: o.id };
        eff.overrides.push(o);
      }
    }
    // modules
    const hidden = admin || perm ? new Set() : hiddenOf(user);
    for (const e of modules()) {
      let level;
      let source;
      if (admin) { level = 'full'; source = 'admin'; } else if (e.href === '/admin') { level = 'full'; source = 'always'; } else if (e.href === '/admin/people') {
        level = eff.caps.manage_users.on || eff.caps.grant.on ? 'full' : 'none';
        source = 'capability';
      } else {
        level = roleLevel(role, e.href);
        source = 'role';
        if (hidden.has(e.href)) { level = 'none'; source = 'hidden'; }
      }
      eff.modules[e.href] = { level, source, until: null, blocked: null };
    }
    if (!admin) {
      for (const o of rows.filter((x) => x.subject === 'module' && eff.modules[x.key] && x.key !== '/admin' && x.key !== '/admin/people')) {
        const m = eff.modules[o.key];
        if (!LEVELS.includes(o.level)) continue;
        if (!o.expires_at) {
          eff.modules[o.key] = { ...m, level: o.level, source: 'override', id: o.id };
          eff.overrides.push(o);
        }
      }
      for (const o of rows.filter((x) => x.subject === 'module' && x.expires_at && eff.modules[x.key] && x.key !== '/admin')) {
        const m = eff.modules[o.key];
        eff.temp.push(o);
        if (lv(o.level) > lv(m.level)) eff.modules[o.key] = { ...m, level: o.level, source: 'temporary', until: o.expires_at, id: o.id };
      }
      // the assistant needs its capability
      if (eff.modules['/admin/assistant'] && !eff.caps.assistant.on) eff.modules['/admin/assistant'] = { ...eff.modules['/admin/assistant'], level: 'none', blocked: 'assistant' };
      for (const e of modules()) {
        const why = ceiling(eff, e);
        if (why) eff.modules[e.href] = { ...eff.modules[e.href], level: 'none', blocked: why };
      }
    }
    return eff;
  }

  function effective(user) {
    if (!user) return null;
    const hit = cache.get(user);
    if (hit && hit.v === version && hit.hm === user.hidden_modules && hit.role === user.role && hit.rid === user.role_id && hit.hr === user.hr && hit.fi === user.finance) return hit.eff;
    const eff = compute(user);
    cache.set(user, { v: version, hm: user.hidden_modules, role: user.role, rid: user.role_id, hr: user.hr, fi: user.finance, eff });
    return eff;
  }
  // what a person's access would be with these permanent changes: [{ subject, key, level }]
  const preview = (user, perm) => compute(user, { perm: perm.map((o, i) => ({ id: -1 - i, user_id: user.id, expires_at: null, ...o })) });
  const levelOf = (user, href) => {
    const eff = effective(user);
    if (!eff) return 'none';
    const m = eff.modules[href];
    return m ? m.level : 'full';
  };
  const can = (user, href, level = 'view') => lv(levelOf(user, href)) >= lv(level);
  const has = (user, cap) => {
    const eff = effective(user);
    return !!eff && !!(eff.caps[cap] && eff.caps[cap].on);
  };
  // the most this person may approve for a kind of request (null: no personal limit)
  const limitFor = (user, kind) => {
    const eff = effective(user);
    if (!eff || eff.admin) return null;
    const v = eff.limits[kind];
    return v === undefined || v === null || v === '' ? null : Number(v);
  };

  // What a request needs: { module, level, exportNeeded }; null when the path is not a module's.
  function required(method, url) {
    const [path, query = ''] = String(url || '').split('?');
    const module = moduleFor(path);
    if (!module) return null;
    const m = String(method || 'GET').toUpperCase();
    const read = m === 'GET' || m === 'HEAD';
    let level = read ? 'view' : 'edit';
    if (!read && FULL_ACTION.test(path.replace(/\/+$/, ''))) level = 'full';
    return { module, level, exportNeeded: read && isExport(path, query) };
  }
  // The guard: may this person make this request? { ok, need, have, module, reason }
  function check(user, method, url) {
    const need = required(method, url);
    if (!need) return { ok: true };
    const eff = effective(user);
    if (!eff) return { ok: false, ...need, have: 'none', reason: 'signin' };
    if (eff.admin) return { ok: true, ...need, have: 'full' };
    const m = eff.modules[need.module];
    const have = m ? m.level : 'full';
    if (lv(have) < lv(need.level)) return { ok: false, ...need, have, reason: have === 'none' ? (m && m.blocked ? m.blocked : 'module') : 'level', source: m ? m.source : null };
    if (need.exportNeeded && !eff.caps.export.on) return { ok: false, ...need, have, reason: 'export' };
    return { ok: true, ...need, have };
  }

  // ---------- granting ----------
  // Would giving `target` (a role object or {modules, caps, limits, base}) to someone exceed what the
  // actor has? Returns the list of problems: [{ kind: 'module'|'cap'|'base'|'limit', key, want, have }].
  function escalation(actor, want) {
    const a = effective(actor);
    if (!a || a.admin) return [];
    const out = [];
    if (want.base && RANK[want.base] > RANK[a.base]) out.push({ kind: 'base', key: want.base, want: want.base, have: a.base });
    for (const [href, level] of Object.entries(want.modules || {})) {
      const have = a.modules[href] ? a.modules[href].level : 'none';
      if (lv(level) > lv(have)) out.push({ kind: 'module', key: href, want: level, have });
    }
    for (const [c, on] of Object.entries(want.caps || {})) if (on && CAPS.includes(c) && !(a.caps[c] && a.caps[c].on)) out.push({ kind: 'cap', key: c, want: true, have: false });
    for (const [k, v] of Object.entries(want.limits || {})) {
      const mine = a.limits[k];
      if (v !== null && v !== '' && mine !== undefined && mine !== null && Number(v) > Number(mine)) out.push({ kind: 'limit', key: k, want: Number(v), have: Number(mine) });
    }
    return out;
  }
  // What a role gives, as { base, modules, caps, limits } (for escalation checks and diffs)
  const roleGrant = (role) => ({
    base: role.base,
    modules: Object.fromEntries(modules().map((e) => [e.href, roleLevel(role, e.href)])),
    caps: Object.fromEntries(CAPS.map((c) => [c, !!role.caps[c]])),
    limits: role.caps.limits || {},
  });
  // Is this change one a second administrator must approve (when the two-person rule is on)?
  function sensitive(want) {
    if (want.base === 'admin') return true;
    for (const [href, level] of Object.entries(want.modules || {})) if (level === 'full' && SENSITIVE_MODULES.includes(href)) return true;
    for (const [c, on] of Object.entries(want.caps || {})) if (on && SENSITIVE_CAPS.includes(c)) return true;
    return false;
  }
  const twoPerson = () => db.setting('ppl_two_person') === '1';

  // custom roles keep users.hr and users.finance in step with their capabilities, so every page
  // that checks those switches keeps working
  function syncFlags(userId) {
    const u = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!u || !u.role_id || u.role === 'admin') return;
    const r = customRole(u.role_id);
    if (!r) return;
    db.run('UPDATE users SET hr = ?, finance = ? WHERE id = ?', r.caps.hr ? 1 : 0, r.caps.finance ? 1 : 0, u.id);
  }
  // end temporary access that ran out; returns what ended
  function sweep(at = new Date().toISOString()) {
    const ended = db.all('SELECT o.*, u.name user_name FROM ppl_overrides o JOIN users u ON u.id = o.user_id WHERE o.expires_at IS NOT NULL AND o.expires_at <= ?', at);
    for (const o of ended) {
      db.run('DELETE FROM ppl_overrides WHERE id = ?', o.id);
      db.run('INSERT INTO ppl_history (user_id, action, changes, at, demo) VALUES (?, ?, ?, ?, ?)', o.user_id, 'temp_ended', JSON.stringify([{ kind: o.subject, key: o.key, from: o.level, to: null }]), at, o.demo || 0);
      db.audit(null, 'Temporary access ended', 'user', o.user_id, o.user_name);
    }
    if (ended.length) touch();
    return ended;
  }

  // a role's name in the reader's language: built-ins and untouched template names are translated
  const roleName = (role) => {
    if (!role) return '';
    if (role.builtin) return M.ROLES[role.key] || role.key;
    const t = role.template && TEMPLATES[role.template];
    return t && role.name === t.en ? i18n.t(t.name) : role.name;
  };

  const templateRole = (key) => {
    const t = TEMPLATES[key];
    if (!t) return null;
    const matrix = {};
    for (const e of modules()) {
      const l = t.matrix[e.href] || t.matrix['*'] || 'n';
      matrix[e.href] = LETTER[l] || 'none';
    }
    return { key, name: t.name, en: t.en, desc: t.desc, base: t.base, matrix, caps: { ...Object.fromEntries(CAPS.map((c) => [c, !!t.caps[c]])), limits: { ...t.limits } }, default_level: 'none' };
  };

  return {
    LEVELS, RANKS, RANK, CAPS, BUILTIN, TEMPLATES, SENSITIVE_MODULES, SENSITIVE_CAPS, lv, maxLevel,
    modules, moduleOf, moduleFor, roles, roleOf, roleName, customRole, builtinRole, roleLevel, usersWithRole, roleGrant, templateRole,
    effective, preview, levelOf, can, has, limitFor, required, check, escalation, sensitive, twoPerson, syncFlags, sweep, touch,
    overridesOf, version: () => version,
  };
}

module.exports = { create, LEVELS, CAPS, RANK, TEMPLATES, lv };
