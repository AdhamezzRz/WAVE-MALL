'use strict';

// Sample data for Users & permissions: custom roles made from the templates (finance, HR,
// collections, security, maintenance, parking, marketing, the owner's read-only view); a dozen staff
// on those roles with a month of sign-ins (and a few failed ones); a locked account after five wrong
// passwords; a dormant account and a deactivated one; permanent changes for two people; temporary
// access running out in a few days; invitations waiting and expired; a sensitive change waiting for a
// second administrator in Approvals; the permission history and part of this quarter's review.

const crypto = require('node:crypto');
const { hashPassword } = require('./db');

const MAIL = '@demo.thewave.local';
const ROLES = ['finance_officer', 'hr_officer', 'collections_officer', 'security_supervisor', 'maintenance_coordinator', 'parking_cashier', 'marketing_media', 'owner_readonly'];
const COLORS = { finance_officer: 'forest', hr_officer: 'cocoa', collections_officer: 'amber', security_supervisor: 'sky', maintenance_coordinator: 'sea', parking_cashier: 'sand', marketing_media: 'rose', owner_readonly: 'forest' };
// name, email, title, role (template key or built-in), last sign-in (days ago, null = never), extra
const STAFF = [
  ['Dina Samir', 'dina.samir', 'Deputy general manager', 'admin', 0.2],
  ['Hany Fawzy', 'hany.fawzy', 'Chief accountant', 'finance_officer', 0.5],
  ['Rania Adel', 'rania.adel', 'HR manager', 'hr_officer', 1.2],
  ['Mostafa Lotfy', 'mostafa.lotfy', 'Collections officer', 'collections_officer', 0.1],
  ['Nermeen Saad', 'nermeen.saad', 'Credit controller', 'collections_officer', 3, { locked: true }],
  ['Ayman Ragab', 'ayman.ragab', 'Security supervisor', 'security_supervisor', 0.3],
  ['Walid Hosny', 'walid.hosny', 'Maintenance coordinator', 'maintenance_coordinator', 0.7],
  ['Sherif Kamal', 'sherif.kamal', 'Parking cashier, night shift', 'parking_cashier', 0.4],
  ['Yasmin Farid', 'yasmin.farid', 'Marketing executive', 'marketing_media', 2],
  ['Tarek El Shazly', 'tarek.shazly', 'Owner representative', 'owner_readonly', 9],
  ['Mahmoud Zaki', 'mahmoud.zaki', 'Parking cashier, day shift', 'parking_cashier', 78, { dormant: true }],
  ['Heba Mansour', 'heba.mansour', 'Former leasing coordinator', 'agent', 130, { deactivated: true }],
];
const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
];
const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const emailOf = (key) => `${key}${MAIL}`;

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  if (!has(db, 'ppl_roles') || !h.access) return;
  if (db.value('SELECT COUNT(*) FROM ppl_roles WHERE demo = 1')) return;
  const engine = h.access.engine;
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const ahead = (d) => new Date(Date.now() + d * 86400000).toISOString();
  const adminId = admin ? admin.id : null;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  db.tx(() => {
    // roles from the templates
    const roleId = {};
    for (const key of ROLES) {
      const t = engine.templateRole(key);
      const caps = { ...t.caps };
      const limits = caps.limits || {};
      delete caps.limits;
      roleId[key] = Number(db.run(`INSERT INTO ppl_roles (name, description, base, matrix, caps, default_level, template, color, created_by, updated_by, created_at, updated_at, demo)
        VALUES (?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, 1)`,
      t.en, require('./i18n').english(t.desc), t.base, JSON.stringify(t.matrix), JSON.stringify({ ...caps, limits }), key, COLORS[key], adminId, adminId, ago(75), ago(75)).lastInsertRowid);
      db.run("INSERT INTO ppl_history (role_id, actor_id, action, at, demo) VALUES (?, ?, 'role_created', ?, 1)", roleId[key], adminId, ago(75));
    }
    // a later tweak: collections may now see the accounting receivables
    db.run("INSERT INTO ppl_history (role_id, actor_id, action, changes, at, demo) VALUES (?, ?, 'role_changed', ?, ?, 1)", roleId.collections_officer, adminId,
      JSON.stringify([{ kind: 'module', key: '/admin/leases', from: 'none', to: 'view' }, { kind: 'cap', key: 'export', from: 'off', to: 'on' }]), ago(31));

    // staff
    const ids = {};
    for (const [name, key, title, role, last, extra = {}] of STAFF) {
      const email = emailOf(key);
      const existing = db.get('SELECT id FROM users WHERE email = ?', email);
      if (existing) {
        ids[key] = existing.id;
        continue;
      }
      const custom = roleId[role] || null;
      const base = custom ? engine.templateRole(role).base : role;
      const t = engine.templateRole(role);
      ids[key] = Number(db.run(`INSERT INTO users (name, email, role, role_id, title, password_hash, hr, finance, active, created_at, last_login_at, invited_by, deactivated_at, deactivated_by, failed_logins, locked_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      name, email, base, custom, title, hashPassword(crypto.randomBytes(18).toString('hex')),
      role === 'admin' || (t && t.caps.hr) ? 1 : 0, role === 'admin' || (t && t.caps.finance) ? 1 : 0, extra.deactivated ? 0 : 1, ago(70 + Math.round(rnd() * 60)),
      last === null ? null : ago(last), adminId, extra.deactivated ? ago(40) : null, extra.deactivated ? adminId : null,
      extra.locked ? 5 : 0, extra.locked ? ahead(10 / 1440) : null).lastInsertRowid);
      db.run("INSERT INTO ppl_history (user_id, actor_id, action, changes, at, demo) VALUES (?, ?, 'created', ?, ?, 1)", ids[key], adminId,
        JSON.stringify([{ kind: 'role', key: custom ? `role:${custom}` : role, from: null, to: custom ? `role:${custom}` : role }]), ago(70));
      if (extra.deactivated) db.run("INSERT INTO ppl_history (user_id, actor_id, action, note, at, demo) VALUES (?, ?, 'deactivated', 'Left the company', ?, 1)", ids[key], adminId, ago(40));
      // a month of sign-ins
      if (last !== null && !extra.deactivated) {
        for (let d = Math.ceil(last); d < Math.max(last + 1, extra.dormant ? last + 20 : 32); d += 1 + Math.floor(rnd() * 3)) {
          db.run('INSERT INTO ppl_logins (user_id, email, ok, ip, agent, at, demo) VALUES (?, ?, 1, ?, ?, ?, 1)', ids[key], email, `41.233.${10 + Math.floor(rnd() * 200)}.${Math.floor(rnd() * 250)}`, UA[Math.floor(rnd() * UA.length)], ago(d + rnd() * 0.4));
        }
      }
      if (extra.locked) {
        for (let i = 0; i < 5; i++) db.run("INSERT INTO ppl_logins (user_id, email, ok, reason, ip, agent, at, demo) VALUES (?, ?, 0, 'password', '102.40.18.77', ?, ?, 1)", ids[key], email, UA[1], ago((5 - i) / 1440));
        db.run("INSERT INTO ppl_logins (user_id, email, ok, reason, ip, agent, at, demo) VALUES (?, ?, 0, 'locked', '102.40.18.77', ?, ?, 1)", ids[key], email, UA[1], ago(0.5 / 1440));
      }
    }
    // a wrong password now and then
    db.run("INSERT INTO ppl_logins (user_id, email, ok, reason, ip, agent, at, demo) VALUES (?, ?, 0, 'password', '41.233.88.14', ?, ?, 1)", ids['hany.fawzy'], emailOf('hany.fawzy'), UA[0], ago(4.1));
    db.run("INSERT INTO ppl_logins (user_id, email, ok, reason, ip, agent, at, demo) VALUES (NULL, 'm.lotfy@thewave.test', 0, 'unknown', '41.233.91.200', ?, ?, 1)", UA[3], ago(2.3));

    // changes for two people, and temporary access
    db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, reason, granted_by, created_at, demo) VALUES (?, 'module', '/admin/accounting', 'view', 'Reads the receivables ledger for collections', ?, ?, 1)", ids['mostafa.lotfy'], adminId, ago(20));
    db.run("INSERT INTO ppl_history (user_id, actor_id, action, changes, note, at, demo) VALUES (?, ?, 'access', ?, 'Reads the receivables ledger for collections', ?, 1)", ids['mostafa.lotfy'], adminId, JSON.stringify([{ kind: 'module', key: '/admin/accounting', from: null, to: 'view' }]), ago(20));
    db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, reason, granted_by, created_at, demo) VALUES (?, 'cap', 'export', 'off', 'No downloads on the night shift', ?, ?, 1)", ids['sherif.kamal'], adminId, ago(15));
    db.run("INSERT INTO ppl_history (user_id, actor_id, action, changes, note, at, demo) VALUES (?, ?, 'access', ?, 'No downloads on the night shift', ?, 1)", ids['sherif.kamal'], adminId, JSON.stringify([{ kind: 'cap', key: 'export', from: null, to: 'off' }]), ago(15));
    const tempUntil = ahead(4.4);
    db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, expires_at, reason, granted_by, created_at, demo) VALUES (?, 'module', '/admin/collections', 'edit', ?, 'Covering for Nermeen while she is on leave', ?, ?, 1)", ids['yasmin.farid'], tempUntil, adminId, ago(2));
    db.run("INSERT INTO ppl_history (user_id, actor_id, action, changes, note, at, demo) VALUES (?, ?, 'temp', ?, 'Covering for Nermeen while she is on leave', ?, 1)", ids['yasmin.farid'], adminId, JSON.stringify([{ kind: 'module', key: '/admin/collections', from: null, to: 'edit', until: tempUntil }]), ago(2));
    db.run("INSERT INTO ppl_overrides (user_id, subject, key, level, expires_at, reason, granted_by, created_at, demo) VALUES (?, 'module', '/admin/purchasing', 'full', ?, 'Year-end stock count', ?, ?, 1)", ids['walid.hosny'], ahead(1.2), adminId, ago(6));
    db.run("INSERT INTO ppl_history (user_id, actor_id, action, changes, note, at, demo) VALUES (?, ?, 'temp', ?, 'Year-end stock count', ?, 1)", ids['walid.hosny'], adminId, JSON.stringify([{ kind: 'module', key: '/admin/purchasing', from: null, to: 'full', until: ahead(1.2) }]), ago(6));
    db.run("INSERT INTO ppl_history (user_id, actor_id, action, changes, at, demo) VALUES (?, ?, 'temp_ended', ?, ?, 1)", ids['ayman.ragab'], null, JSON.stringify([{ kind: 'module', key: '/admin/maintenance', from: 'edit', to: null }]), ago(9));
    db.run("INSERT INTO ppl_history (user_id, actor_id, action, at, demo) VALUES (?, ?, 'unlocked', ?, 1)", ids['hany.fawzy'], adminId, ago(4));

    // invitations: one waiting, one expired
    db.run("INSERT INTO ppl_invites (kind, email, name, title, role, role_id, lang, token_hash, expires_at, created_by, created_at, sent_at, sends, demo) VALUES ('invite', ?, 'Omar Hegazy', 'Leasing executive', 'agent', NULL, 'ar', ?, ?, ?, ?, ?, 1, 1)",
      emailOf('omar.hegazy'), crypto.randomBytes(32).toString('hex'), ahead(5), adminId, ago(2), ago(2));
    db.run("INSERT INTO ppl_invites (kind, email, name, title, role, role_id, lang, token_hash, expires_at, created_by, created_at, sent_at, sends, demo) VALUES ('invite', ?, 'Salma Ezz', 'Accountant', 'manager', ?, 'en', ?, ?, ?, ?, ?, 2, 1)",
      emailOf('salma.ezz'), roleId.finance_officer, crypto.randomBytes(32).toString('hex'), ago(3), adminId, ago(10), ago(6));
    db.run("INSERT INTO ppl_history (actor_id, action, note, at, demo) VALUES (?, 'invited', ?, ?, 1)", adminId, emailOf('omar.hegazy'), ago(2));

    // this quarter's review, partly done
    const d = new Date();
    const period = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    for (const [key, decision, note] of [['hany.fawzy', 'keep', null], ['rania.adel', 'keep', null], ['mostafa.lotfy', 'keep', 'Accounting view still needed'], ['mahmoud.zaki', 'remove', 'Has not signed in since the summer'], ['tarek.shazly', 'keep', null]]) {
      if (!ids[key]) continue;
      db.run('INSERT OR IGNORE INTO ppl_reviews (period, user_id, reviewer_id, decision, note, at, demo) VALUES (?, ?, ?, ?, ?, ?, 1)', period, ids[key], adminId, decision, note, ago(3));
    }
  });
  engine.touch();

  // a sensitive change waiting for a second administrator: Dina asks to let Hany manage people
  if (h.approvals && h.approvals.KINDS && h.approvals.KINDS.access) {
    const dina = db.get('SELECT * FROM users WHERE email = ?', emailOf('dina.samir'));
    const hany = db.get('SELECT * FROM users WHERE email = ?', emailOf('hany.fawzy'));
    if (dina && hany) {
      const r = h.approvals.request({ kind: 'access', title: 'Access change: Hany Fawzy can manage people', amount: 0, entity: 'user', entity_id: hany.id, link: `/admin/people/${hany.id}`,
        payload: { op: 'overrides', user_id: hany.id, modules: {}, caps: { manage_users: 'on' }, reason: 'Onboards the new finance team' }, user: dina, demo: 1, at: ago(0.3) });
      db.run("INSERT INTO ppl_history (user_id, actor_id, action, note, at, demo) VALUES (?, ?, 'requested', ?, ?, 1)", hany.id, dina.id, r.ref, ago(0.3));
    }
  }
}

function clear(db) {
  if (!has(db, 'ppl_roles')) return;
  const emails = [...STAFF.map(([, key]) => emailOf(key))];
  db.tx(() => {
    const ids = db.all(`SELECT id FROM users WHERE email IN (${emails.map(() => '?').join(',')})`, ...emails).map((r) => r.id);
    if (has(db, 'apr_requests')) {
      db.run("DELETE FROM apr_events WHERE request_id IN (SELECT id FROM apr_requests WHERE kind = 'access' AND demo = 1)");
      db.run("DELETE FROM apr_requests WHERE kind = 'access' AND demo = 1");
    }
    for (const t of ['ppl_overrides', 'ppl_invites', 'ppl_logins', 'ppl_history', 'ppl_reviews']) db.run(`DELETE FROM ${t} WHERE demo = 1`);
    for (const id of ids) {
      for (const t of ['ppl_overrides', 'ppl_logins', 'ppl_history', 'ppl_reviews']) db.run(`DELETE FROM ${t} WHERE user_id = ?`, id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
      db.run('UPDATE audit SET user_id = NULL WHERE user_id = ?', id);
      if (has(db, 'apr_requests')) {
        db.run('UPDATE apr_requests SET requested_by = NULL WHERE requested_by = ?', id);
        db.run('UPDATE apr_requests SET decided_by = NULL WHERE decided_by = ?', id);
        db.run('UPDATE apr_events SET user_id = NULL WHERE user_id = ?', id);
      }
      db.run('DELETE FROM users WHERE id = ?', id);
    }
    // people now on a sample role go back to their base rank
    db.run('UPDATE users SET role_id = NULL WHERE role_id IN (SELECT id FROM ppl_roles WHERE demo = 1)');
    db.run('DELETE FROM ppl_roles WHERE demo = 1');
  });
}

module.exports = { load, clear };
