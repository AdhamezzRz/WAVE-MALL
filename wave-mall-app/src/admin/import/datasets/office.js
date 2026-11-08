'use strict';

// The office: staff accounts (each new email becomes an invitation; nobody's password is ever
// imported) and the newsletter subscribers. Accounts follow every rule of Users & permissions
// (routes/people.js, access.js): nobody gives a role with more than they hold, only an administrator
// makes an administrator, and a role that needs a second administrator is not given by an import.

const i18n = require('../../i18n');

const L = (en, ar) => ({ en, ar });
const LANGS = [['en', L('English', 'الإنجليزية')], ['ar', L('Arabic', 'العربية')]];

module.exports = function officeDatasets(imports, h) {
  const { M } = h;
  const engine = () => h.access.engine;
  const now = () => M.now();
  const canManage = (req) => !!req.user && engine().has(req.user, 'manage_users');
  const roleKeyOf = (u) => (u.role === 'admin' || !u.role_id ? u.role : `role:${u.role_id}`);
  const roleOf = (key) => (String(key).startsWith('role:') ? engine().customRole(Number(String(key).slice(5))) : engine().builtinRole(key));
  // every role that can be given: the built-in ones, then the office's own roles that are not archived
  const roleChoices = () => engine().roles().filter((r) => !r.archived).map((r) => [r.builtin ? r.key : `role:${r.id}`, { en: i18n.run('en', () => engine().roleName(r)), ar: i18n.run('ar', () => engine().roleName(r)) }]);
  const waitingInvite = (db, email) => db.get("SELECT id FROM ppl_invites WHERE email = ? COLLATE NOCASE AND kind = 'invite' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?", email, new Date().toISOString());

  // ============================ staff accounts ============================
  // New emails become invitations (ids are given negative, so one batch can hold invitations and
  // updated accounts and undo knows which is which); existing emails update the account.
  imports.register({
    key: 'staff-accounts',
    module: '/admin/people',
    pages: ['/admin/people', '/admin/people/invites'],
    area: 'setup',
    order: 10,
    icon: 'team',
    table: 'users',
    title: L('Staff accounts', 'حسابات فريق العمل'),
    summary: L('Who signs in to the office: a new email gets an invitation, an existing one has its name, title and role updated.', 'من يدخل إلى المكتب: البريد الجديد يحصل على دعوة، والموجود يُحدَّث اسمه ومسماه ودوره.'),
    notes: L('Passwords are never imported: each person chooses their own from the invitation link. The invitation email goes out only when “Send the invitation” is yes; otherwise get the link from Invitations (New link). A role with more than you hold, or one that needs a second administrator, is refused: give it from the person’s page.', 'لا تُستورد كلمات المرور أبدًا: يختار كل شخص كلمته من رابط الدعوة. لا يُرسل بريد الدعوة إلا إذا كان «إرسال الدعوة» نعم؛ وإلا فخذ الرابط من صفحة الدعوات (رابط جديد). الدور الذي يمنح أكثر مما لديك، أو الذي يحتاج موافقة مدير نظام ثانٍ، يُرفض: امنحه من صفحة الشخص.'),
    canView: (req) => canManage(req),
    allowed: (req) => canManage(req),
    keys: ['email'],
    count: (db) => db.value('SELECT COUNT(*) FROM users'),
    columns: [
      { key: 'email', label: L('Email', 'البريد الإلكتروني'), type: 'email', required: true, width: 28, example: 'sara.adel@thewavemall.com', help: L('Their sign-in. An email already in the system updates that account.', 'بريد الدخول. البريد الموجود في النظام يحدّث الحساب نفسه.') },
      { key: 'name', label: L('Name', 'الاسم'), type: 'text', max: 120, width: 22, example: 'Sara Adel', help: L('Optional for an invitation: they can type it.', 'اختياري للدعوة: يمكنه كتابته بنفسه.') },
      { key: 'title', label: L('Job title', 'المسمى الوظيفي'), type: 'text', max: 120, width: 22, example: 'Leasing executive' },
      { key: 'role', label: L('Role', 'الدور'), type: 'enum', enum: roleChoices, width: 20, example: 'agent', help: L('Empty means Leasing agent for a new person.', 'الفارغ يعني «وكيل تأجير» للشخص الجديد.') },
      { key: 'lang', label: L('Language', 'اللغة'), type: 'enum', enum: LANGS, width: 12, example: 'en', help: L('The language of the invitation email and of the office for them.', 'لغة بريد الدعوة ولغة المكتب لهم.') },
      { key: 'phone', label: L('Mobile', 'الموبايل'), type: 'phone', width: 15, help: L('Existing accounts only: a new person adds it after joining.', 'للحسابات الموجودة فقط: يضيفه الشخص الجديد بعد انضمامه.') },
      { key: 'send_invite', label: L('Send the invitation', 'إرسال الدعوة'), type: 'bool', width: 14, keepOnUpdate: true, help: L('Yes: the invitation email goes out now. Empty or no: it is only prepared.', 'نعم: يُرسل بريد الدعوة الآن. الفارغ أو لا: تُجهّز الدعوة فقط.') },
    ],
    find(db, v) {
      const u = db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', v.email);
      if (u) return u.id;
      if (waitingInvite(db, v.email)) return { error: 'imp3|That email already has an invitation waiting. Resend it from Invitations.' };
      return null;
    },
    rowCheck(row, ctx) {
      const actor = ctx.user;
      const cur = ctx.current;
      const key = row.role || (cur ? cur.role : 'agent');
      const r = roleOf(key);
      if (!r || r.archived) { ctx.error('role', 'imp3|That role is not available.'); return; }
      const changing = !cur || key !== cur.role;
      if (changing) {
        if (cur && actor && ctx.id === actor.id) ctx.error('role', 'imp3|You cannot change your own role.');
        if (cur && cur.role === 'admin' && (!actor || actor.role !== 'admin')) ctx.error('role', 'imp3|Only an administrator can change an administrator.');
        if (key === 'admin' && (!actor || actor.role !== 'admin')) ctx.error('role', 'imp3|Only an administrator can make an administrator.');
        const grant = engine().roleGrant(r);
        if (actor && engine().escalation(actor, grant).length) ctx.error('role', 'imp3|You cannot give this role: it has more than you have yourself.');
        else if (engine().twoPerson() && engine().sensitive(grant)) ctx.error('role', 'imp3|This role needs a second administrator: give it from Users & permissions.');
      }
      if (!ctx.id && row.phone) ctx.warn('phone', 'imp3|The mobile is added once they join, on their page.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const key = row.role || (ctx.id ? null : 'agent');
      if (!ctx.id) {
        const r = roleOf(key);
        const out = h.people.createInvite({ email: row.email, name: row.name || null, title: row.title || null, role: r.builtin ? r.key : r.base, role_id: r.builtin ? null : r.id, lang: row.lang === 'ar' ? 'ar' : 'en' }, ctx.user, { send: !!row.send_invite });
        return -out.id;
      }
      const u = db.get('SELECT * FROM users WHERE id = ?', ctx.id);
      db.run('UPDATE users SET name = ?, title = ?, phone = ?, lang = ? WHERE id = ?', row.name || u.name, row.title || null, row.phone || null, row.lang || u.lang || null, u.id);
      if (key && key !== roleKeyOf(u)) h.people.applyOp({ op: 'role', user_id: u.id, role: key }, ctx.user);
      ctx.log('Updated a team member', 'user', u.id, `${row.name || u.name}: imported from Excel`);
      return u.id;
    },
    export: (db) => db.all('SELECT * FROM users ORDER BY name').map((u) => ({ $id: u.id, email: u.email, name: u.name, title: u.title, role: roleKeyOf(u), lang: u.lang || null, phone: u.phone, send_invite: null })),
    // an invitation (negative id) or an account (positive id)
    snapshot: (db, id) => (id < 0 ? db.get('SELECT * FROM ppl_invites WHERE id = ?', -id) : db.get('SELECT * FROM users WHERE id = ?', id)),
    restore: (db, snap) => {
      db.run('UPDATE users SET name = ?, title = ?, phone = ?, lang = ?, role = ?, role_id = ?, hr = ?, finance = ? WHERE id = ?', snap.name, snap.title, snap.phone, snap.lang, snap.role, snap.role_id, snap.hr, snap.finance, snap.id);
      engine().touch();
    },
    remove: (db, id) => { if (id < 0) db.run("DELETE FROM ppl_invites WHERE id = ? AND accepted_at IS NULL", -id); },
    uses: (db, id) => {
      if (id >= 0) return [];
      const inv = db.get('SELECT accepted_at FROM ppl_invites WHERE id = ?', -id);
      return inv && inv.accepted_at ? [{ n: 1, what: L('account made from the invitation', 'حساب أُنشئ من الدعوة') }] : [];
    },
    link: (id) => (id < 0 ? '/admin/people/invites' : `/admin/people/${id}`),
    label: (v) => v.name || v.email || '',
    examples: [
      { email: 'sara.adel@thewavemall.com', name: 'Sara Adel', title: L('Leasing executive', 'مسؤولة تأجير'), role: 'agent', lang: 'en', send_invite: false },
      { email: 'omar.hany@thewavemall.com', name: 'Omar Hany', title: L('Operations supervisor', 'مشرف التشغيل'), role: 'viewer', lang: 'ar', send_invite: true },
    ],
  });

  // ============================ newsletter subscribers ============================
  imports.register({
    key: 'subscribers',
    module: '/admin/subscribers',
    pages: ['/admin/subscribers'],
    area: 'other',
    order: 50,
    icon: 'mail',
    table: 'subscribers',
    title: L('Newsletter subscribers', 'المشتركون في النشرة'),
    summary: L('People who agreed to receive the mall’s news, with the language and the day they agreed.', 'من وافقوا على تلقي أخبار المول، بلغتهم واليوم الذي وافقوا فيه.'),
    notes: L('Import only people who agreed to receive emails from The Wave; keep the day they agreed. An email already on the list is updated.', 'لا تستورد إلا من وافقوا على تلقي رسائل ذا ويف؛ واحتفظ بيوم الموافقة. البريد الموجود في القائمة يُحدَّث.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['email'],
    columns: [
      { key: 'email', label: L('Email', 'البريد الإلكتروني'), type: 'email', required: true, width: 30, example: 'nour@example.com' },
      { key: 'lang', label: L('Language', 'اللغة'), type: 'enum', enum: LANGS, width: 12, example: 'ar', help: L('Empty means English.', 'الفارغ يعني الإنجليزية.') },
      { key: 'source', label: L('Source', 'المصدر'), type: 'text', max: 60, width: 18, example: 'Opening event', help: L('Where they signed up. Empty means Imported.', 'مكان اشتراكهم. الفارغ يعني «مستورد».') },
      { key: 'joined', label: L('Agreed on', 'تاريخ الموافقة'), type: 'date', width: 14, example: '2026-09-15', aliases: ['joined', 'subscribed on', 'consent date', 'تاريخ الاشتراك'], help: L('The day they agreed. Empty means today.', 'يوم موافقتهم. الفارغ يعني اليوم.') },
    ],
    rowCheck(row, ctx) {
      if (row.joined && row.joined > M.today()) ctx.error('joined', 'imp3|The day they agreed cannot be in the future.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const at = (d) => (d ? `${d}T12:00:00.000Z` : now());
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO subscribers (email, lang, source, created_at) VALUES (?, ?, ?, ?)', row.email, row.lang || 'en', row.source || 'Imported', at(row.joined)).lastInsertRowid);
        ctx.log('Added a subscriber', 'subscriber', id, row.email);
        return id;
      }
      const s = db.get('SELECT * FROM subscribers WHERE id = ?', ctx.id);
      db.run('UPDATE subscribers SET email = ?, lang = ?, source = ?, created_at = ? WHERE id = ?', row.email, row.lang || 'en', row.source || s.source, row.joined && row.joined !== String(s.created_at).slice(0, 10) ? at(row.joined) : s.created_at, ctx.id);
      ctx.log('Updated a subscriber', 'subscriber', ctx.id, row.email);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM subscribers ORDER BY created_at DESC').map((s) => ({ $id: s.id, email: s.email, lang: s.lang || 'en', source: s.source, joined: String(s.created_at || '').slice(0, 10) || null })),
    uses: () => [],
    link: () => '/admin/subscribers',
    label: (v) => v.email || '',
    examples: [
      { email: 'nour@example.com', lang: 'ar', source: L('Opening event', 'حفل الافتتاح'), joined: '2026-09-15' },
      { email: 'mark@example.com', lang: 'en', source: L('Website', 'الموقع'), joined: '2026-10-02' },
    ],
  });
};
