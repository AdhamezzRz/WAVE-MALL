'use strict';

// The work hub (/admin/work): approvals and the team's tasks on one board.
//
// Every approval request is a task card, next to tasks people give each other: assignees and
// watchers, a priority, a due date and time, labels, a checklist, a link to the record it is
// about (a lease, an invoice, a work order, a tenant…), files, comments that @mention people, and
// a timeline of everything that happened. Views:
//
//   My day     everything on one person's plate: approvals waiting for them, overdue, today, the
//              next 7 days, mentions, what they asked others for, and their sales calendar tasks
//   Board      To do · In progress · Waiting · Done, drag and drop (public/admin/work.js; a menu
//              on each card does the same without JavaScript)
//   List       filters, sorting and bulk actions (assign, priority, done, approve with one note)
//   Calendar   a month of due dates
//   Team       workload per person: open, overdue, due this week, approvals waiting, how fast
//              they decide and how often within the SLA
//   Recurring  task templates (daily, weekly, monthly) that a job turns into tasks
//   Inbox      notifications: mentions, assignments, decisions, questions, answers, escalations
//   Away       delegation: while someone is out, a colleague decides their approvals and sees
//              their tasks
//
// Other modules: h.work.createTask({ title, ... }) and h.work.notify(userId, kind, {...}).

const i18n = require('../i18n');
const { cairo, registerDocs, uploadRoute } = require('../ops-common');

const { t: tr, tn, tx } = i18n;

const SCHEMA = `
  CREATE TABLE wk_tasks (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'normal', due_date TEXT, due_time TEXT, labels TEXT, link TEXT, link_label TEXT,
    private INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0, template_id INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, done_at TEXT, done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_noted TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX wk_tasks_status ON wk_tasks(status, due_date);
  CREATE TABLE wk_people (
    task_id INTEGER NOT NULL REFERENCES wk_tasks(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'assignee', PRIMARY KEY (task_id, user_id)
  );
  CREATE INDEX wk_people_user ON wk_people(user_id, role);
  CREATE TABLE wk_checks (
    id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES wk_tasks(id) ON DELETE CASCADE, text TEXT NOT NULL,
    done_at TEXT, done_by INTEGER REFERENCES users(id) ON DELETE SET NULL, pos INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX wk_checks_task ON wk_checks(task_id, pos);
  CREATE TABLE wk_events (
    id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES wk_tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL, body TEXT, data TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, at TEXT NOT NULL
  );
  CREATE INDEX wk_events_task ON wk_events(task_id, id);
  CREATE TABLE wk_notes (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, params TEXT, link TEXT,
    task_id INTEGER REFERENCES wk_tasks(id) ON DELETE CASCADE, request_id INTEGER REFERENCES apr_requests(id) ON DELETE CASCADE,
    by_id INTEGER REFERENCES users(id) ON DELETE SET NULL, read_at TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX wk_notes_user ON wk_notes(user_id, read_at);
  CREATE TABLE wk_templates (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, priority TEXT NOT NULL DEFAULT 'normal',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL, labels TEXT, checklist TEXT, every TEXT NOT NULL,
    weekday INTEGER, monthday INTEGER, due_days INTEGER NOT NULL DEFAULT 0, next_on TEXT NOT NULL, last_on TEXT,
    active INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
`;

const STATUS = { todo: ['wk|To do', 'mute'], doing: ['wk|In progress', 'sea'], waiting: ['wk|Waiting', 'sky'], done: ['wk|Done', 'ok'], cancelled: ['wk|Cancelled', 'mute'] };
const LANES = ['todo', 'doing', 'waiting', 'done'];
const OPEN = ['todo', 'doing', 'waiting'];
const PRIORITY = { urgent: ['wk|Urgent', 'rose'], high: ['wk|High', 'amber'], normal: ['wk|Normal', 'sea'], low: ['wk|Low', 'mute'] };
const P_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
const EVERY = { daily: 'wk|Every day', weekly: 'wk|Every week', monthly: 'wk|Every month' };
const TONES = ['forest', 'sea', 'cocoa', 'sand', 'amber', 'sky', 'rose'];
// what each notification says (the actor and the title are filled in when it is read)
const NOTE = {
  mention: 'wk|{name} mentioned you on {title}',
  assigned: 'wk|{name} gave you {title}',
  comment: 'wk|{name} commented on {title}',
  done: 'wk|{name} completed {title}',
  due: 'wk|{title} is due today',
  approval: 'wk|{name} asks you to approve {title}',
  approved: 'wk|{name} approved {title}',
  rejected: 'wk|{name} did not approve {title}',
  info_asked: 'wk|{name} asked you a question about {title}',
  info_given: 'wk|{name} answered your question on {title}',
  escalated: 'wk|{title} is overdue and was escalated to you',
  reminded: 'wk|{title} is due soon and waits for your decision',
  delegated: 'wk|{name} asked you to cover for them until {date}',
};
const NOTE_ICON = { mention: 'chat', assigned: 'people', comment: 'chat', done: 'check', due: 'cal', approval: 'check', approved: 'check', rejected: 'x', info_asked: 'chat', info_given: 'chat', escalated: 'flow', reminded: 'cal', delegated: 'people' };
const DOW = ['wk|Monday', 'wk|Tuesday', 'wk|Wednesday', 'wk|Thursday', 'wk|Friday', 'wk|Saturday', 'wk|Sunday'];

const HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

module.exports = function work(router, h) {
  const { db, ui, M } = h;
  db.ensure('work-1', SCHEMA);
  registerDocs(M, 'wk_task', 'wk|Task', {});
  (h.auditTyped = h.auditTyped || []).push(
    'SELECT title, body, labels, link_label FROM wk_tasks', 'SELECT text FROM wk_checks', 'SELECT body FROM wk_events WHERE body IS NOT NULL',
    'SELECT title, body, labels, checklist FROM wk_templates',
    // the quoted bit of a comment in a notification
    "SELECT json_extract(params, '$.excerpt') excerpt FROM wk_notes WHERE params LIKE '%excerpt%'",
    // each label on its own (they show one by one)
    `SELECT DISTINCT trim(j.value) label FROM wk_tasks t, json_each('["' || replace(replace(t.labels, '"', ''), ',', '","') || '"]') j WHERE t.labels IS NOT NULL`,
    `SELECT DISTINCT trim(j.value) label FROM wk_templates t, json_each('["' || replace(replace(t.labels, '"', ''), ',', '","') || '"]') j WHERE t.labels IS NOT NULL`,
  );
  const esc = ui.esc;
  const A = () => h.approvals;
  const now = () => new Date().toISOString();
  const today = () => cairo().date;
  const nowHM = () => HM.format(new Date());
  const allowed = (u, min) => h.auth.allowed(u, min);
  const access = () => (h.access && typeof h.access.can === 'function' ? h.access : null);
  const accessCan = (u, level) => {
    try {
      return access() ? !!access().can(u, '/admin/work', level) : null;
    } catch {
      return null;
    }
  };
  // may create tasks / runs the team's work (sees private tasks, edits anyone's). The rank decides
  // inside the module (as everywhere in the office); Users & permissions can only narrow it further.
  const canUse = (u) => !!u && allowed(u, 'agent') && accessCan(u, 'edit') !== false;
  const isLead = (u) => !!u && allowed(u, 'manager') && accessCan(u, 'full') !== false;
  const parse = (s, fb) => {
    try {
      return s ? JSON.parse(s) : fb;
    } catch {
      return fb;
    }
  };
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const isTime = (t) => /^\d{2}:\d{2}$/.test(String(t || ''));
  const users = () => db.all('SELECT id, name, email, lang, role, finance, hr, active FROM users WHERE active = 1 ORDER BY name');
  const userOf = (id) => (id ? db.get('SELECT id, name, email, lang, role, finance, hr, active FROM users WHERE id = ?', id) : null);
  const nameOf = (id) => (userOf(id) || {}).name || '—';
  const pBadge = (p) => ui.badge(`p-${p}`, tr((PRIORITY[p] || PRIORITY.normal)[0]), (PRIORITY[p] || PRIORITY.normal)[1]);
  const sBadge = (s) => ui.badge(`s-${s}`, tr((STATUS[s] || STATUS.todo)[0]), (STATUS[s] || STATUS.todo)[1]);
  const avatar = (name, extra = '') => `<span class="avatar avatar--sm wk-av" title="${esc(name)}"${extra}>${esc(ui.initials(name))}</span>`;
  const labelsOf = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);
  const tone = (s) => TONES[[...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length];
  const labelChips = (s) => labelsOf(s).map((l) => `<span class="wk-label wk-label--${tone(l.toLowerCase())}">${esc(l)}</span>`).join('');
  const cleanLabels = (s) => [...new Set(String(s || '').split(',').map((x) => x.trim().slice(0, 30)).filter(Boolean))].slice(0, 8).join(', ') || null;

  // ---------- tasks ----------
  const taskOf = (id) => db.get('SELECT t.*, c.name creator FROM wk_tasks t LEFT JOIN users c ON c.id = t.created_by WHERE t.id = ?', id);
  const peopleOf = (id) => db.all('SELECT p.user_id, p.role, u.name, u.email, u.lang FROM wk_people p JOIN users u ON u.id = p.user_id WHERE p.task_id = ? ORDER BY p.role, u.name', id);
  const assigneesOf = (id) => peopleOf(id).filter((p) => p.role === 'assignee');
  // who this person is covering for today (their approvals and tasks)
  const coveringFor = (u) => (A() ? A().delegatorsOf(u.id) : []);
  const onTask = (u, t, people = peopleOf(t.id)) => t.created_by === u.id || people.some((p) => p.user_id === u.id);
  const covers = (u, t, people = peopleOf(t.id)) => coveringFor(u).some((d) => people.some((p) => p.user_id === d.id && p.role === 'assignee'));
  const canSeeTask = (u, t, people) => !t.private || isLead(u) || onTask(u, t, people) || covers(u, t, people);
  const canEditTask = (u, t, people) => isLead(u) || t.created_by === u.id || (people || peopleOf(t.id)).some((p) => p.user_id === u.id && p.role === 'assignee') || covers(u, t, people);
  const ev = (taskId, kind, user, { body = null, data = null, at = null } = {}) => db.run('INSERT INTO wk_events (task_id, kind, body, data, user_id, at) VALUES (?, ?, ?, ?, ?, ?)', taskId, kind, body, data ? JSON.stringify(data) : null, user ? user.id : null, at || now());
  const touch = (id) => db.run('UPDATE wk_tasks SET updated_at = ? WHERE id = ?', now(), id);
  const dueState = (t) => {
    if (!t.due_date || !OPEN.includes(t.status)) return '';
    const d = today();
    if (t.due_date < d || (t.due_date === d && t.due_time && t.due_time < nowHM())) return 'late';
    if (t.due_date === d) return 'today';
    if (t.due_date <= M.addDays(d, 7)) return 'soon';
    return 'later';
  };
  const dueChip = (t) => {
    if (!t.due_date) return '';
    const st = dueState(t);
    const d = today();
    const when = t.due_date === d ? tr('wk|Today') : t.due_date === M.addDays(d, 1) ? tr('wk|Tomorrow') : t.due_date === M.addDays(d, -1) ? tr('wk|Yesterday') : ui.date(t.due_date);
    const text = `${when}${t.due_time ? ` ${t.due_time}` : ''}`;
    return `<span class="wk-due wk-due--${st || 'done'}">${ui.icon('cal')}${esc(st === 'late' ? tr('wk|Overdue · {when}', { when: text }) : text)}</span>`;
  };

  function notify(userId, kind, { by = null, task = null, request = null, params = {}, link = null, demo = 0 } = {}) {
    if (!userId || (by && by.id === userId && kind !== 'due')) return;
    const u = userOf(userId);
    if (!u || !u.active) return;
    const lnk = link || (task ? `/admin/work/tasks/${task.id}` : request ? `/admin/approvals/${request.id}` : '/admin/work');
    db.run('INSERT INTO wk_notes (user_id, kind, params, link, task_id, request_id, by_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      u.id, kind, JSON.stringify(params || {}), lnk, task ? task.id : null, request ? request.id : null, by ? by.id : null, demo || (task && task.demo) || (request && request.demo) ? 1 : 0, now());
    // tasks: mentions and assignments also go by email (approvals send their own)
    if (task && ['mention', 'assigned'].includes(kind) && !task.demo && h.mail && u.email) {
      const lang = u.lang === 'ar' ? 'ar' : 'en';
      i18n.run(lang, () => {
        const text = tr(NOTE[kind], { name: by ? by.name : '—', title: task.title });
        const url = `${String((h.env && h.env.SITE_URL) || '').replace(/\/$/, '')}${lnk}`;
        try {
          h.mail.send({ to: u.email, subject: text, text: `${text}${params.excerpt ? `\n\n“${params.excerpt}”` : ''}\n\n${url}`, html: `<p>${esc(text)}</p>${params.excerpt ? `<blockquote>${esc(params.excerpt)}</blockquote>` : ''}<p><a href="${esc(url)}">${esc(tr('wk|Open the task'))}</a></p>`, lang, related: { entity: 'wk_task', id: task.id } });
        } catch (e) {
          console.error('[work] mail not sent:', e.message);
        }
      });
    }
  }
  // everyone to tell about a task's news: creator, assignees, watchers (and who covers for them)
  const audience = (t, except = null) => {
    const ids = new Set([t.created_by, ...peopleOf(t.id).map((p) => p.user_id)].filter(Boolean));
    if (A()) for (const id of [...ids]) for (const d of A().delegatesOf(id)) ids.add(d.id);
    if (except) ids.delete(except.id);
    return [...ids];
  };

  // @mentions: "@Salma Adel" or, when no one else shares it, "@Salma"
  function mentioned(body) {
    const text = String(body || '');
    if (!text.includes('@')) return [];
    const list = users();
    const first = {};
    for (const u of list) {
      const f = u.name.split(/\s+/)[0].toLowerCase();
      first[f] = first[f] ? -1 : u.id;
    }
    const found = new Set();
    const low = text.toLowerCase();
    for (const u of [...list].sort((a, b) => b.name.length - a.name.length)) {
      if (low.includes(`@${u.name.toLowerCase()}`)) found.add(u.id);
    }
    for (const m of low.matchAll(/@([^\s@.,;:!?()]+)/gu)) if (first[m[1]] > 0) found.add(first[m[1]]);
    return [...found];
  }

  function setPeople(task, ids, role, by) {
    const want = new Set(ids.map(Number).filter((x) => x > 0 && userOf(x)));
    const had = new Set(db.all('SELECT user_id FROM wk_people WHERE task_id = ? AND role = ?', task.id, role).map((p) => p.user_id));
    for (const id of had) if (!want.has(id)) {
      db.run('DELETE FROM wk_people WHERE task_id = ? AND user_id = ?', task.id, id);
      ev(task.id, role === 'assignee' ? 'unassigned' : 'unwatched', by, { data: { user: id } });
    }
    for (const id of want) if (!had.has(id)) {
      db.run(`INSERT INTO wk_people (task_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(task_id, user_id) DO UPDATE SET role = CASE WHEN wk_people.role = 'assignee' THEN 'assignee' ELSE excluded.role END`, task.id, id, role);
      ev(task.id, role === 'assignee' ? 'assigned' : 'watched', by, { data: { user: id } });
      if (role === 'assignee') {
        notify(id, 'assigned', { by, task });
        if (A()) for (const d of A().delegatesOf(id)) notify(d.id, 'assigned', { by, task, params: { for: id } });
      }
    }
  }

  function createTask({ title, body = null, status = 'todo', priority = 'normal', due_date = null, due_time = null, labels = null, link = null, link_label = null, private: priv = 0, assignees = [], watchers = [], checklist = [], user = null, template_id = null, demo = 0, at = null }) {
    const t = at || now();
    const clean = String(title || '').trim().slice(0, 200);
    if (!clean) throw new Error('wk|Give the task a title.');
    const id = db.tx(() => {
      const tid = Number(db.run(`INSERT INTO wk_tasks (ref, title, body, status, priority, due_date, due_time, labels, link, link_label, private, position, template_id, created_by, done_at, done_by, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      db.nextRef('wk_tasks', 'TK', 4, true), clean, body ? String(body).slice(0, 4000) : null, STATUS[status] ? status : 'todo', PRIORITY[priority] ? priority : 'normal',
      isDate(due_date) ? due_date : null, isDate(due_date) && isTime(due_time) ? due_time : null, cleanLabels(labels), safeLink(link), link_label ? String(link_label).slice(0, 120) : null,
      priv ? 1 : 0, -Date.parse(t) / 1000, template_id, user ? user.id : null, status === 'done' ? t : null, status === 'done' && user ? user.id : null, demo ? 1 : 0, t, t).lastInsertRowid);
      ev(tid, 'created', user, { at: t });
      const task = taskOf(tid);
      setPeople(task, assignees, 'assignee', user);
      setPeople(task, watchers.filter((w) => !assignees.map(Number).includes(Number(w))), 'watcher', user);
      checklist.map((c) => String(c || '').trim().slice(0, 200)).filter(Boolean).slice(0, 40).forEach((c, i) => db.run('INSERT INTO wk_checks (task_id, text, pos) VALUES (?, ?, ?)', tid, c, i));
      if (body) for (const m of mentioned(body)) notify(m, 'mention', { by: user, task, params: { excerpt: String(body).slice(0, 160) } });
      return tid;
    });
    return taskOf(id);
  }
  function moveTask(task, status, user, { at = null } = {}) {
    if (!STATUS[status] || task.status === status) return task;
    const t = at || now();
    db.tx(() => {
      db.run('UPDATE wk_tasks SET status = ?, done_at = ?, done_by = ?, position = ?, updated_at = ? WHERE id = ?', status, status === 'done' ? t : null, status === 'done' && user ? user.id : null, -Date.parse(t) / 1000, t, task.id);
      ev(task.id, 'status', user, { data: { from: task.status, to: status }, at: t });
    });
    if (status === 'done' && task.created_by && (!user || task.created_by !== user.id)) notify(task.created_by, 'done', { by: user, task });
    return taskOf(task.id);
  }
  function comment(task, user, body) {
    const text = String(body || '').trim().slice(0, 4000);
    if (!text) throw new Error('wk|Write the comment first.');
    ev(task.id, 'comment', user, { body: text });
    touch(task.id);
    const who = mentioned(text);
    // mentioned people start watching
    for (const id of who) if (!db.get('SELECT 1 FROM wk_people WHERE task_id = ? AND user_id = ?', task.id, id)) db.run("INSERT INTO wk_people (task_id, user_id, role) VALUES (?, ?, 'watcher')", task.id, id);
    for (const id of who) notify(id, 'mention', { by: user, task, params: { excerpt: text.slice(0, 160) } });
    for (const id of audience(task, user)) if (!who.includes(id)) notify(id, 'comment', { by: user, task, params: { excerpt: text.slice(0, 160) } });
    return who;
  }

  // a link inside the office, with a readable name for known records
  function safeLink(l) {
    let s = String(l || '').trim();
    if (!s) return null;
    s = s.replace(/^https?:\/\/[^/]+/i, '');
    return /^\/admin\/[\w\-/?=&.%]*$/.test(s) && !s.startsWith('//') ? s.slice(0, 300) : null;
  }
  const has = (t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  const LINKS = [
    [/^\/admin\/leases\/(\d+)$/, 'leases', (id) => db.get("SELECT s.ref || ' · ' || b.name x FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.id = ?", id)],
    [/^\/admin\/invoices\/(\d+)$/, 'invoices', (id) => db.get('SELECT ref x FROM invoices WHERE id = ?', id)],
    [/^\/admin\/maintenance\/orders\/(\d+)$/, 'work_orders', (id) => db.get("SELECT ref || ' · ' || title x FROM work_orders WHERE id = ?", id)],
    [/^\/admin\/(?:tenants|brands)\/(\d+)$/, 'brands', (id) => db.get('SELECT name x FROM brands WHERE id = ?', id)],
    [/^\/admin\/leads\/(\d+)$/, 'leads', (id) => db.get('SELECT title x FROM leads WHERE id = ?', id)],
    [/^\/admin\/units\/(\d+)$/, 'units', (id) => db.get('SELECT code x FROM units WHERE id = ?', id)],
    [/^\/admin\/approvals\/(\d+)$/, 'apr_requests', (id) => db.get('SELECT ref x FROM apr_requests WHERE id = ?', id)],
    [/^\/admin\/purchasing\/orders\/(\d+)$/, 'pur_orders', (id) => db.get('SELECT ref x FROM pur_orders WHERE id = ?', id)],
    [/^\/admin\/media\/campaigns\/(\d+)$/, 'media_campaigns', (id) => db.get("SELECT ref || ' · ' || title x FROM media_campaigns WHERE id = ?", id)],
  ];
  const linkName = (t) => {
    if (!t.link) return '';
    if (t.link_label) return t.link_label;
    for (const [re, table, fn] of LINKS) {
      const m = t.link.match(re);
      if (m && has(table)) {
        try {
          const r = fn(Number(m[1]));
          if (r && r.x) return r.x;
        } catch { /* fall through to the address */ }
      }
    }
    // otherwise the module it belongs to, by its sidebar name
    const path = t.link.split('?')[0];
    const nav = (ui.NAV_ENTRIES || []).filter((n) => n.href !== '/admin' && (path === n.href || path.startsWith(`${n.href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
    return nav ? tr(nav.label) : tr('wk|An office page');
  };
  // the picker: recent records people link tasks to
  const linkOptions = () => {
    const out = [];
    const add = (rows, href) => rows.forEach((r) => out.push([href(r), r.x]));
    try {
      if (has('leases')) add(db.all("SELECT s.id, s.ref || ' · ' || b.name x FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.status IN ('active','draft') ORDER BY s.id DESC LIMIT 40"), (r) => `/admin/leases/${r.id}`);
      if (has('work_orders')) add(db.all("SELECT id, ref || ' · ' || title x FROM work_orders WHERE status NOT IN ('closed','cancelled') ORDER BY id DESC LIMIT 30"), (r) => `/admin/maintenance/orders/${r.id}`);
      if (has('invoices')) add(db.all("SELECT id, ref x FROM invoices WHERE status IN ('open','partial') ORDER BY due_date LIMIT 30"), (r) => `/admin/invoices/${r.id}`);
      if (has('brands')) add(db.all('SELECT id, name x FROM brands ORDER BY name LIMIT 60'), (r) => `/admin/tenants/${r.id}`);
    } catch { /* a module may be missing */ }
    return `<datalist id="wk-links">${out.map(([v, l]) => `<option value="${esc(v)}" label="${esc(l)}"></option>`).join('')}</datalist>`;
  };

  // ---------- approvals on the board ----------
  const approvalLane = (r) => {
    if (r.status !== 'pending') return 'done';
    if (r.info_at) return 'waiting';
    return r.claimed_by || r.step > 0 ? 'doing' : 'todo';
  };
  const visibleApprovals = (u, { who = 'all', days = 14 } = {}) => {
    if (!A()) return [];
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return db.all("SELECT * FROM apr_requests WHERE status = 'pending' OR decided_at >= ? ORDER BY created_at DESC LIMIT 400", since)
      .map((r) => A().requestOf(r.id))
      .filter((r) => A().canSee(u, r))
      .filter((r) => who === 'all' || (who === 'me' ? A().canDecide(u, r) || r.requested_by === u.id || r.claimed_by === u.id
        : A().canDecide(userOf(Number(who)) || {}, r) || r.requested_by === Number(who)));
  };

  // ---------- notifications from approvals ----------
  if (A()) {
    A().onEvent((type, r, user, extra = {}) => {
      const base = { by: user, request: r, demo: r.demo };
      if (type === 'submitted' || type === 'step' || type === 'reassigned') for (const u of A().approversFor(r)) notify(u.id, 'approval', base);
      else if (type === 'decided') notify(r.requested_by, extra.decision === 'approved' ? 'approved' : 'rejected', base);
      else if (type === 'info_asked') notify(r.requested_by, 'info_asked', { ...base, params: { excerpt: String(extra.note || '').slice(0, 160) } });
      else if (type === 'info_given') notify(extra.to, 'info_given', { ...base, params: { excerpt: String(extra.note || '').slice(0, 160) } });
      else if (type === 'escalated') for (const u of A().approversFor(r)) notify(u.id, 'escalated', base);
      else if (type === 'reminded') for (const u of A().approversFor(r)) notify(u.id, 'reminded', base);
      else if (type === 'comment' && user && r.requested_by !== user.id) notify(r.requested_by, 'comment', { ...base, params: { excerpt: String(extra.note || '').slice(0, 160) } });
    });
  }
  const unread = (u) => db.value('SELECT COUNT(*) FROM wk_notes WHERE user_id = ? AND read_at IS NULL', u.id);

  // ---------- jobs: recurring tasks, due today ----------
  const dow = (d) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  // the first date on or after `from` that the template falls on
  function nextOn(tpl, from) {
    if (tpl.every === 'daily') return from;
    if (tpl.every === 'weekly') {
      const w = Number.isInteger(tpl.weekday) ? tpl.weekday : 0;
      return M.addDays(from, (w - dow(from) + 7) % 7);
    }
    const md = Math.max(1, Math.min(31, Number(tpl.monthday) || 1));
    let [y, m] = from.split('-').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(md, daysIn(y, m))).padStart(2, '0')}`;
      if (d >= from) return d;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return from;
  }
  // Each template that is due makes one task (missed days are not made up), then moves on.
  function runRecurring(day = today()) {
    let made = 0;
    for (const tpl of db.all('SELECT * FROM wk_templates WHERE active = 1 AND next_on <= ?', day)) {
      db.tx(() => {
        const on = tpl.next_on;
        const by = userOf(tpl.created_by);
        createTask({
          title: tpl.title, body: tpl.body, priority: tpl.priority, labels: tpl.labels, due_date: M.addDays(on < day ? day : on, tpl.due_days || 0),
          assignees: tpl.assignee_id ? [tpl.assignee_id] : [], checklist: String(tpl.checklist || '').split('\n'), user: by, template_id: tpl.id, demo: tpl.demo,
        });
        db.run('UPDATE wk_templates SET last_on = ?, next_on = ? WHERE id = ?', day, nextOn(tpl, M.addDays(day, 1)), tpl.id);
        made++;
      });
    }
    return made;
  }
  // a note to each assignee (and who covers for them) on the day a task is due
  function runDue(day = today()) {
    let n = 0;
    for (const t of db.all("SELECT * FROM wk_tasks WHERE status IN ('todo','doing','waiting') AND due_date = ? AND (due_noted IS NULL OR due_noted <> ?)", day, day)) {
      db.run('UPDATE wk_tasks SET due_noted = ? WHERE id = ?', day, t.id);
      for (const p of assigneesOf(t.id)) {
        notify(p.user_id, 'due', { task: t });
        if (A()) for (const d of A().delegatesOf(p.user_id)) notify(d.id, 'due', { task: t, params: { for: p.user_id } });
        n++;
      }
    }
    return n;
  }
  if (h.every) {
    h.every('work-recurring', 60 * 60 * 1000, () => runRecurring(), { first: 60 * 1000 });
    h.every('work-due', 60 * 60 * 1000, () => runDue(), { first: 90 * 1000 });
  }

  // ---------- my plate (shared by My day, the badge and the team view) ----------
  function myTasks(u, { cover = true } = {}) {
    const ids = [u.id, ...(cover ? coveringFor(u).map((d) => d.id) : [])];
    return db.all(`SELECT DISTINCT t.*, p.user_id for_id FROM wk_tasks t JOIN wk_people p ON p.task_id = t.id AND p.role = 'assignee'
      WHERE p.user_id IN (${ids.map(() => '?').join(',')}) AND t.status IN ('todo','doing','waiting') ORDER BY t.due_date IS NULL, t.due_date, t.due_time`, ...ids)
      .filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i);
  }
  const salesTasks = (u) => (has('activities') ? db.all(`SELECT a.*, l.title lead_title FROM activities a LEFT JOIN leads l ON l.id = a.lead_id
    WHERE a.user_id = ? AND a.done_at IS NULL AND a.due_at IS NOT NULL AND substr(a.due_at, 1, 10) <= ? ORDER BY a.due_at LIMIT 30`, u.id, M.addDays(today(), 7)) : []);

  h.count('work', (u) => {
    const d = today();
    const mine = myTasks(u).filter((t) => t.due_date && t.due_date <= d).length;
    return (A() ? A().waitingFor(u).length : 0) + mine + unread(u);
  });

  h.work = { createTask, moveTask, comment, notify, mentioned, runRecurring, runDue, nextOn, taskOf, peopleOf, myTasks, today, STATUS, PRIORITY };

  // ---------- page frame ----------
  const TABS = [['/admin/work', 'wk|My day', 'home'], ['/admin/work/board', 'wk|Board', 'pipe'], ['/admin/work/list', 'wk|List', 'report'], ['/admin/work/calendar', 'wk|Calendar', 'cal'], ['/admin/work/team', 'wk|Team', 'team'], ['/admin/work/recurring', 'wk|Recurring', 'flow'], ['/admin/work/inbox', 'wk|Inbox', 'inbox']];
  const VERSION = (() => {
    try {
      return require('node:crypto').createHash('sha1').update(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', 'public', 'admin', 'work.js'))).digest('hex').slice(0, 10);
    } catch {
      return '1';
    }
  })();
  function frame(req, res, { tab, title, body, actions = '', crumbs = null }) {
    const u = req.user;
    const n = unread(u);
    const waiting = A() ? A().waitingFor(u).length : 0;
    const nav = `<nav class="tabs wk-tabs">${TABS.map(([href, label, ic]) => {
      const count = href === '/admin/work/inbox' ? n : href === '/admin/work' ? waiting : 0;
      return `<a class="tab${tab === href ? ' is-on' : ''}" href="${href}">${ui.icon(ic)}<span>${esc(tr(label))}</span>${count ? ` <b class="nav__count">${count}</b>` : ''}</a>`;
    }).join('')}</nav>`;
    const acts = actions || [
      canUse(u) ? ui.btn(esc(tr('wk|New task')), { href: '/admin/work/tasks/new', cls: 'btn--primary btn--sm', ic: 'plus' }) : '',
      allowed(u, 'agent') ? ui.btn(esc(tr('wk|Ask for approval')), { href: '/admin/approvals/new', cls: 'btn--ghost btn--sm', ic: 'check' }) : '',
      ui.btn(esc(tr('wk|Away')), { href: '/admin/work/away', cls: 'btn--ghost btn--sm', ic: 'leave' }),
    ].join('');
    h.page(req, res, { title, crumbs: crumbs || (tab === '/admin/work' ? undefined : [['/admin/work', tr('nav|Approvals & tasks')]]), active: '/admin/work', actions: acts, wide: true, body: `${nav}${body}<script src="/admin/work.js?v=${VERSION}" defer></script>` });
  }
  const peopleJson = () => esc(JSON.stringify(users().map((x) => x.name)));
  const quickAdd = (req, { status = 'todo', back = '/admin/work' } = {}) => (canUse(req.user) ? ui.form('/admin/work/tasks', req.session.csrf, `<input type="hidden" name="quick" value="1"><input type="hidden" name="status" value="${esc(status)}"><input type="hidden" name="back" value="${esc(back)}"><input type="hidden" name="assignees" value="${req.user.id}"><label class="wk-quick__in"><span class="wk-sr">${esc(tr('wk|New task'))}</span><input name="title" required maxlength="200" placeholder="${esc(tr('wk|Add a task… (Enter to save)'))}"></label><button class="btn btn--ghost btn--sm" type="submit">${ui.icon('plus')}<span>${esc(tr('wk|Add'))}</span></button>`, { cls: 'wk-quick' }) : '');

  // ---------- cards ----------
  const checkCounts = (ids) => {
    if (!ids.length) return {};
    const out = {};
    for (const r of db.all(`SELECT task_id, COUNT(*) n, SUM(done_at IS NOT NULL) d FROM wk_checks WHERE task_id IN (${ids.map(() => '?').join(',')}) GROUP BY task_id`, ...ids)) out[r.task_id] = r;
    return out;
  };
  const commentCounts = (ids) => {
    if (!ids.length) return {};
    return Object.fromEntries(db.all(`SELECT task_id, COUNT(*) n FROM wk_events WHERE kind = 'comment' AND task_id IN (${ids.map(() => '?').join(',')}) GROUP BY task_id`, ...ids).map((r) => [r.task_id, r.n]));
  };
  function taskCard(req, t, { checks = {}, comments = {}, people = null, draggable = true } = {}) {
    const u = req.user;
    const ppl = people || peopleOf(t.id);
    const asg = ppl.filter((p) => p.role === 'assignee');
    const editable = canEditTask(u, t, ppl);
    const c = checks[t.id];
    const forOther = coveringFor(u).find((d) => asg.some((p) => p.user_id === d.id) && !asg.some((p) => p.user_id === u.id));
    const moves = editable ? `<details class="wk-move"><summary title="${esc(tr('wk|Move'))}"><span aria-hidden="true">⋯</span><span class="wk-sr">${esc(tr('wk|Move'))}</span></summary>${ui.form(`/admin/work/tasks/${t.id}/move`, req.session.csrf, `<input type="hidden" name="back" value="${esc(req.originalUrl)}">${[...LANES, 'cancelled'].filter((s) => s !== t.status).map((s) => `<button class="wk-move__b" type="submit" name="status" value="${s}">${esc(tr(STATUS[s][0]))}</button>`).join('')}`)}</details>` : '';
    return `<article class="wk-card wk-card--task wk-card--${esc(t.priority)}${t.status === 'done' ? ' is-done' : ''}" data-wk-task="${t.id}"${editable && draggable ? ' draggable="true"' : ''}>
      <header class="wk-card__top"><span class="wk-prio wk-prio--${esc(t.priority)}" title="${esc(tr(PRIORITY[t.priority][0]))}"></span><small class="wk-card__ref"><bdi>${esc(t.ref)}</bdi>${t.private ? ` · ${esc(tr('wk|Private'))}` : ''}</small>${moves}</header>
      <a class="wk-card__title" href="/admin/work/tasks/${t.id}">${esc(t.title)}</a>
      ${t.labels ? `<div class="wk-labels">${labelChips(t.labels)}</div>` : ''}
      ${forOther ? `<p class="wk-cover">${ui.icon('people')}${esc(tr('wk|Covering for {name}', { name: forOther.name }))}</p>` : ''}
      <footer class="wk-card__foot">${dueChip(t)}${c ? `<span class="wk-meta${c.d === c.n ? ' is-ok' : ''}">${ui.icon('check')}${c.d}/${c.n}</span>` : ''}${comments[t.id] ? `<span class="wk-meta">${ui.icon('chat')}${comments[t.id]}</span>` : ''}${t.link ? `<span class="wk-meta" title="${esc(linkName(t))}">${ui.icon('file')}</span>` : ''}<span class="wk-avs">${asg.slice(0, 3).map((p) => avatar(p.name)).join('')}${asg.length > 3 ? `<span class="wk-more">+${asg.length - 3}</span>` : ''}</span></footer>
    </article>`;
  }
  function approvalCard(req, r) {
    const u = req.user;
    const as = A().decideAs(u, r);
    const prio = A().priorityOf(r);
    const dots = r.steps.map((s, i) => `<i class="wk-dot${r.status === 'pending' ? (i < r.step ? ' is-ok' : i === r.step ? ' is-now' : '') : r.status === 'approved' ? ' is-ok' : r.status === 'rejected' && i === r.step ? ' is-no' : i < r.step ? ' is-ok' : ''}" title="${esc(A().whoLabel(s.who))}"></i>`).join('');
    const claimer = r.claimed_by ? nameOf(r.claimed_by) : null;
    return `<article class="wk-card wk-card--approval wk-card--${esc(prio)}${r.status !== 'pending' ? ' is-done' : ''}${as ? ' is-mine' : ''}" data-wk-approval="${r.id}">
      <header class="wk-card__top"><span class="wk-prio wk-prio--${esc(prio)}" title="${esc(tr(PRIORITY[prio][0]))}"></span><small class="wk-card__ref"><bdi>${esc(r.ref)}</bdi> · ${esc(A().kindLabel(r.kind))}</small><span class="wk-steps" aria-label="${esc(tr('apr|Steps'))}">${dots}</span></header>
      <a class="wk-card__title" href="/admin/approvals/${r.id}">${esc(A().titleOf(r))}</a>
      <p class="wk-card__amt">${r.amount ? ui.money(r.amount) : ''}${as ? ` <span class="wk-you">${esc(as.onBehalf ? tr('wk|For you · covering {name}', { name: as.onBehalf.name }) : tr('wk|For you'))}</span>` : ''}</p>
      <footer class="wk-card__foot">${r.status === 'pending' ? A().slaChip(r) : A().badge(r.status)}${claimer && r.status === 'pending' ? `<span class="wk-meta">${ui.icon('people')}${esc(claimer)}</span>` : ''}${r.escalated && r.status === 'pending' ? ui.badge('esc', tr('wk|Escalated'), 'rose') : ''}<span class="wk-avs">${avatar(r.requester || '—')}</span></footer>
    </article>`;
  }

  // ---------- My day ----------
  router.get('/work', (req, res) => {
    const u = req.user;
    const d = today();
    const csrf = req.session.csrf;
    const decide = A() ? A().waitingFor(u).map((r) => A().requestOf(r.id)).sort((a, b) => P_ORDER[A().priorityOf(a)] - P_ORDER[A().priorityOf(b)] || A().sla(a).left - A().sla(b).left) : [];
    const tasks = myTasks(u);
    const late = tasks.filter((t) => dueState(t) === 'late');
    const tday = tasks.filter((t) => dueState(t) === 'today');
    const week = tasks.filter((t) => dueState(t) === 'soon');
    const rest = tasks.filter((t) => !t.due_date || dueState(t) === 'later');
    const notes = db.all('SELECT * FROM wk_notes WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 6', u.id);
    const asked = A() ? db.all("SELECT * FROM apr_requests WHERE requested_by = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 20", u.id).map((r) => A().requestOf(r.id)) : [];
    const gave = db.all(`SELECT t.* FROM wk_tasks t WHERE t.created_by = ? AND t.status IN ('todo','doing','waiting')
      AND NOT EXISTS (SELECT 1 FROM wk_people p WHERE p.task_id = t.id AND p.user_id = ? AND p.role = 'assignee') ORDER BY t.due_date IS NULL, t.due_date LIMIT 20`, u.id, u.id);
    const sales = salesTasks(u);
    const ids = [...tasks, ...gave].map((t) => t.id);
    const checks = checkCounts(ids);
    const comments = commentCounts(ids);
    const cover = coveringFor(u);
    const away = A() ? A().delegatesOf(u.id) : [];
    const lateApprovals = decide.filter((r) => (A().sla(r) || {}).overdue).length;
    const hour = cairo().hour;
    const hello = tr(hour < 12 ? 'wk|Good morning, {name}' : hour < 17 ? 'wk|Good afternoon, {name}' : 'wk|Good evening, {name}', { name: u.name.split(/\s+/)[0] });
    const kpis = `<div class="kpis kpis--4">
      ${ui.kpi({ label: tr('wk|Waiting for your decision'), value: String(decide.length), tone: decide.length ? 'kpi--alert' : '', href: '#wk-decide', sub: lateApprovals ? esc(tr('wk|{n} overdue', { n: lateApprovals })) : decide.length ? esc(ui.money(decide.reduce((s, r) => s + r.amount, 0), { compact: true })) : '' })}
      ${ui.kpi({ label: tr('wk|Overdue'), value: String(late.length), tone: late.length ? 'kpi--alert' : '', href: '#wk-late' })}
      ${ui.kpi({ label: tr('wk|Due today'), value: String(tday.length), href: '#wk-today' })}
      ${ui.kpi({ label: tr('wk|Unread'), value: String(unread(u)), href: '/admin/work/inbox' })}
    </div>`;
    const banners = [
      ...cover.map((x) => `<div class="alert alert--ok wk-banner">${ui.icon('people')}<span>${esc(tr('wk|You are covering for {name} until {date}: their approvals and tasks show here.', { name: x.name, date: ui.date(x.deleg_ends) }))}</span></div>`),
      ...away.map((x) => `<div class="alert alert--warn wk-banner">${ui.icon('leave')}<span>${esc(tr('wk|You are away until {date}. {name} covers for you.', { name: x.name, date: ui.date(x.deleg_ends) }))}</span><a class="btn btn--ghost btn--sm" href="/admin/work/away">${esc(tr('wk|Change'))}</a></div>`),
    ].join('');
    const decideList = decide.length ? `<ul class="wk-decide-list">${decide.slice(0, 12).map((r) => {
      const as = A().decideAs(u, r);
      return `<li class="wk-dl wk-dl--${esc(A().priorityOf(r))}"><a class="wk-dl__main" href="/admin/approvals/${r.id}"><span class="wk-prio wk-prio--${esc(A().priorityOf(r))}"></span><span class="what"><b>${esc(A().titleOf(r))}</b><small><bdi>${esc(r.ref)}</bdi> · ${esc(A().kindLabel(r.kind))} · ${esc(r.requester || '—')}${as && as.onBehalf ? ` · ${esc(tr('wk|covering {name}', { name: as.onBehalf.name }))}` : ''}</small></span><b class="num">${r.amount ? ui.money(r.amount, { compact: true }) : ''}</b></a><span class="wk-dl__sla">${A().slaChip(r)}</span>
        ${r.info_at ? '' : ui.form(`/admin/approvals/${r.id}/decide`, csrf, `<input type="hidden" name="back" value="/admin/work"><button class="btn btn--primary btn--sm wk-dl__yes" type="submit" name="decision" value="approved" data-confirm="${esc(tr('wk|Approve {title}?', { title: A().titleOf(r) }))}">${ui.icon('check')}<span>${esc(tr('apr|Approve'))}</span></button>`, { cls: 'wk-dl__go' })}</li>`;
    }).join('')}</ul>${decide.length > 12 ? `<p class="pad"><a href="/admin/work/list?type=approvals&who=me">${esc(tr('wk|See all {n}', { n: decide.length }))}</a></p>` : ''}` : `<div class="wk-zero">${ui.icon('check')}<p>${esc(tr('wk|Nothing waits for your decision.'))}</p></div>`;
    const taskList = (list, empty) => (list.length ? `<div class="wk-stack">${list.map((t) => taskCard(req, t, { checks, comments, draggable: false })).join('')}</div>` : `<p class="muted pad">${esc(empty)}</p>`);
    const notesHtml = notes.length ? `<ul class="list wk-notes">${notes.map((n) => noteItem(n)).join('')}</ul>` : `<p class="muted pad">${esc(tr('wk|All caught up.'))}</p>`;
    const askedHtml = asked.length || gave.length ? `<ul class="list">${asked.map((r) => `<li><a href="/admin/approvals/${r.id}"><span class="what"><b>${esc(A().titleOf(r))}</b><small><bdi>${esc(r.ref)}</bdi> · ${esc(r.info_at ? tr('wk|A question waits for your answer') : A().whoLabel((r.steps[r.step] || {}).who))}</small></span>${r.info_at ? ui.badge('q', tr('wk|Answer'), 'amber') : A().slaChip(r)}</a></li>`).join('')}${gave.map((t) => `<li><a href="/admin/work/tasks/${t.id}"><span class="what"><b>${esc(t.title)}</b><small><bdi>${esc(t.ref)}</bdi> · ${esc(assigneesOf(t.id).map((p) => p.name).join(', ') || tr('wk|Nobody yet'))}</small></span>${sBadge(t.status)}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('wk|Nothing you asked for is open.'))}</p>`;
    const salesHtml = sales.length ? `<ul class="list">${sales.map((a) => `<li><a href="${a.lead_id ? `/admin/leads/${a.lead_id}` : '/admin/calendar'}"><span class="what"><b>${esc(tx(a.subject))}</b><small>${esc(M.ACTIVITY_TYPES[a.type] || a.type)}${a.lead_title ? ` · ${esc(a.lead_title)}` : ''}</small></span><span class="wk-due wk-due--${String(a.due_at).slice(0, 10) < d ? 'late' : String(a.due_at).slice(0, 10) === d ? 'today' : 'soon'}">${ui.icon('cal')}${esc(ui.dt(a.due_at))}</span></a></li>`).join('')}</ul>` : '';
    const body = `<div class="wk-hello"><h2>${esc(hello)}</h2><p class="muted">${esc(ui.date(d))} · ${esc(tn(tasks.length, 'wk|{n} open task', 'wk|{n} open tasks'))}</p></div>${banners}${kpis}${quickAdd(req)}
      <div class="wk-day">
        <div class="stack">
          <section id="wk-decide">${ui.card(tr('wk|Waiting for your decision'), decideList, { sub: decide.length ? esc(tn(decide.length, 'apr|{n} request', 'apr|{n} requests')) : '', action: decide.length ? ui.btn(esc(tr('wk|Board')), { href: '/admin/work/board?type=approvals&who=me', cls: 'btn--ghost btn--sm' }) : '' })}</section>
          ${late.length ? `<section id="wk-late">${ui.card(tr('wk|Overdue'), taskList(late, ''), { cls: 'wk-card-late' })}</section>` : ''}
          <section id="wk-today">${ui.card(tr('wk|Today'), taskList(tday, tr('wk|Nothing due today.')))}</section>
          ${ui.card(tr('wk|Next 7 days'), taskList(week, tr('wk|Nothing due this week.')))}
          ${rest.length ? ui.card(tr('wk|Later or no date'), taskList(rest, '')) : ''}
        </div>
        <div class="stack">
          ${ui.card(tr('wk|Notifications'), notesHtml, { action: ui.btn(esc(tr('wk|Inbox')), { href: '/admin/work/inbox', cls: 'btn--ghost btn--sm' }) })}
          ${ui.card(tr('wk|What you asked for'), askedHtml)}
          ${salesHtml ? ui.card(tr('wk|From the sales calendar'), salesHtml, { action: ui.btn(esc(tr('wk|Calendar')), { href: '/admin/calendar', cls: 'btn--ghost btn--sm' }) }) : ''}
        </div>
      </div>`;
    frame(req, res, { tab: '/admin/work', title: tr('nav|Approvals & tasks'), body });
  });

  // ---------- board ----------
  const whoSelect = (u, who, extra = {}) => ui.select('who', tr('wk|Whose'), [['me', tr('wk|Mine')], ['all', tr('wk|Everyone')], ...users().map((x) => [String(x.id), x.name])], who, { attrs: { 'data-autosubmit': '' }, ...extra });
  const typeSelect = (type) => ui.select('type', tr('wk|Show'), [['all', tr('wk|Tasks and approvals')], ['tasks', tr('wk|Tasks')], ['approvals', tr('wk|Approvals')]], type, { attrs: { 'data-autosubmit': '' } });
  const prioSelect = (p) => ui.select('priority', tr('wk|Priority'), Object.fromEntries(Object.entries(PRIORITY).map(([k, v]) => [k, tr(v[0])])), p, { blank: tr('All'), attrs: { 'data-autosubmit': '' } });
  const allLabels = () => [...new Set(db.all("SELECT labels FROM wk_tasks WHERE labels IS NOT NULL AND status <> 'cancelled'").flatMap((r) => labelsOf(r.labels)))].sort((a, b) => a.localeCompare(b));
  function taskQuery(u, { who = 'all', priority = '', label = '', statuses = LANES, q = '' } = {}) {
    const where = [`t.status IN (${statuses.map(() => '?').join(',')})`];
    const args = [...statuses];
    if (statuses.includes('done')) { where.push("(t.status <> 'done' OR t.done_at >= ?)"); args.push(new Date(Date.now() - 14 * 86400000).toISOString()); }
    if (PRIORITY[priority]) { where.push('t.priority = ?'); args.push(priority); }
    if (label) { where.push("(',' || REPLACE(LOWER(t.labels), ', ', ',') || ',') LIKE ?"); args.push(`%,${label.toLowerCase()},%`); }
    if (q) { where.push('(LOWER(t.title) LIKE ? OR LOWER(t.ref) LIKE ? OR LOWER(COALESCE(t.body, \'\')) LIKE ?)'); args.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`); }
    if (who !== 'all') {
      const ids = who === 'me' ? [u.id, ...coveringFor(u).map((d) => d.id)] : [Number(who)];
      where.push(`(EXISTS (SELECT 1 FROM wk_people p WHERE p.task_id = t.id AND p.role = 'assignee' AND p.user_id IN (${ids.map(() => '?').join(',')}))${who === 'me' ? ' OR t.created_by = ?' : ''})`);
      args.push(...ids, ...(who === 'me' ? [u.id] : []));
    }
    return db.all(`SELECT t.* FROM wk_tasks t WHERE ${where.join(' AND ')} ORDER BY t.position, t.id DESC LIMIT 600`, ...args)
      .filter((t) => canSeeTask(u, t));
  }

  router.get('/work/board', (req, res) => {
    const u = req.user;
    const q = req.query;
    const type = ['all', 'tasks', 'approvals'].includes(q.type) ? q.type : 'all';
    const who = q.who === 'all' || q.who === 'me' || /^\d+$/.test(String(q.who || '')) ? String(q.who) : isLead(u) ? 'all' : 'me';
    const priority = PRIORITY[q.priority] ? q.priority : '';
    const label = String(q.label || '').slice(0, 30);
    const tasks = type === 'approvals' ? [] : taskQuery(u, { who, priority, label });
    const approvals = type === 'tasks' || label ? [] : visibleApprovals(u, { who }).filter((r) => !priority || A().priorityOf(r) === priority);
    const ids = tasks.map((t) => t.id);
    const checks = checkCounts(ids);
    const comments = commentCounts(ids);
    const peopleBy = {};
    if (ids.length) for (const p of db.all(`SELECT p.task_id, p.user_id, p.role, u.name FROM wk_people p JOIN users u ON u.id = p.user_id WHERE p.task_id IN (${ids.map(() => '?').join(',')})`, ...ids)) (peopleBy[p.task_id] = peopleBy[p.task_id] || []).push(p);
    const lanes = LANES.map((lane) => {
      const ts = tasks.filter((t) => t.status === lane).sort((a, b) => (lane === 'done' ? String(b.done_at).localeCompare(String(a.done_at)) : P_ORDER[a.priority] - P_ORDER[b.priority] || a.position - b.position));
      const as = approvals.filter((r) => approvalLane(r) === lane).sort((a, b) => (lane === 'done' ? String(b.decided_at).localeCompare(String(a.decided_at)) : P_ORDER[A().priorityOf(a)] - P_ORDER[A().priorityOf(b)]));
      const n = ts.length + as.length;
      const cards = [...as.map((r) => approvalCard(req, r)), ...ts.map((t) => taskCard(req, t, { checks, comments, people: peopleBy[t.id] || [] }))].join('');
      return `<section class="wk-lane wk-lane--${lane}" data-wk-lane="${lane}"><header class="wk-lane__head"><b>${esc(tr(STATUS[lane][0]))}</b><span class="wk-lane__n" data-wk-count>${n}</span></header>
        <div class="wk-lane__cards" data-wk-drop>${cards || `<p class="wk-lane__empty">${esc(lane === 'done' ? tr('wk|Finished work of the last 14 days shows here.') : tr('wk|Nothing here.'))}</p>`}</div>
        ${lane === 'todo' && type !== 'approvals' ? quickAdd(req, { status: 'todo', back: req.originalUrl }) : ''}</section>`;
    }).join('');
    const labels = allLabels();
    const filters = `<form method="get" action="/admin/work/board" class="filters wk-filters">${typeSelect(type)}${whoSelect(u, who)}${prioSelect(priority)}${labels.length ? ui.select('label', tr('wk|Label'), labels.map((l) => [l, l]), label, { blank: tr('All'), attrs: { 'data-autosubmit': '' } }) : ''}<noscript>${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm' })}</noscript></form>`;
    frame(req, res, { tab: '/admin/work/board', title: tr('wk|Board'), body: `${filters}<p class="muted small wk-hint">${esc(tr('wk|Drag a task to another column, or use the ⋯ menu on the card. Approvals move as they are decided: open one to decide it.'))}</p><div class="wk-board" data-wk-board>${lanes}</div>` });
  });

  // ---------- list (with bulk actions) ----------
  router.get('/work/list', (req, res) => {
    const u = req.user;
    const q = req.query;
    const type = ['all', 'tasks', 'approvals'].includes(q.type) ? q.type : 'all';
    const who = q.who === 'all' || q.who === 'me' || /^\d+$/.test(String(q.who || '')) ? String(q.who) : isLead(u) ? 'all' : 'me';
    const priority = PRIORITY[q.priority] ? q.priority : '';
    const label = String(q.label || '').slice(0, 30);
    const state = ['open', 'todo', 'doing', 'waiting', 'done', 'cancelled', 'any'].includes(q.state) ? q.state : 'open';
    const due = ['late', 'today', 'week', 'none'].includes(q.due) ? q.due : '';
    const search = String(q.q || '').trim().slice(0, 80);
    const f = h.listFilters(req, { cols: { date: 'x' }, dateLabel: tr('wk|Due'), keep: ['type', 'who', 'priority', 'label', 'state', 'due', 'q'], sorts: [['priority', 'sort|Priority', ''], ['due', 'sort|Due date: soonest first', ''], ['due_late', 'sort|Due date: latest first', ''], ['updated', 'sort|Recently updated', ''], ['name', 'sort|Name: A to Z', '']] });
    const statuses = state === 'open' ? OPEN : state === 'any' ? Object.keys(STATUS) : [state];
    let rows = [];
    if (type !== 'approvals') {
      rows.push(...taskQuery(u, { who, priority, label, statuses, q: search }).map((t) => ({ kind: 'task', id: t.id, key: `t:${t.id}`, t, title: t.title, ref: t.ref, status: t.status, prio: t.priority, due: t.due_date ? `${t.due_date}${t.due_time ? `T${t.due_time}` : ''}` : '', dueState: dueState(t), updated: t.updated_at })));
    }
    if (type !== 'tasks' && !label && A()) {
      const want = (r) => (state === 'open' ? r.status === 'pending' : state === 'any' ? true : state === 'done' ? ['approved', 'rejected'].includes(r.status) : state === 'cancelled' ? r.status === 'withdrawn' : approvalLane(r) === state && r.status === 'pending');
      rows.push(...visibleApprovals(u, { who, days: state === 'open' ? 1 : 90 }).filter(want).filter((r) => !priority || A().priorityOf(r) === priority)
        .filter((r) => !search || `${A().titleOf(r)} ${r.ref}`.toLowerCase().includes(search.toLowerCase()))
        .map((r) => {
          const s = A().sla(r);
          return { kind: 'approval', id: r.id, key: `a:${r.id}`, r, title: A().titleOf(r), ref: r.ref, status: r.status, prio: A().priorityOf(r), due: s ? s.due : '', dueState: s ? (s.overdue ? 'late' : s.left < 24 ? 'today' : 'soon') : '', updated: r.updated_at };
        }));
    }
    if (due) rows = rows.filter((x) => (due === 'none' ? !x.due : due === 'late' ? x.dueState === 'late' : due === 'today' ? x.dueState === 'today' || (x.kind === 'task' && x.t.due_date === today()) : x.due && x.due.slice(0, 10) <= M.addDays(today(), 7)));
    if (f.from) rows = rows.filter((x) => x.due && x.due.slice(0, 10) >= f.from);
    if (f.to) rows = rows.filter((x) => x.due && x.due.slice(0, 10) <= f.to);
    const SORTS = {
      priority: (a, b) => P_ORDER[a.prio] - P_ORDER[b.prio] || (a.due || '9999').localeCompare(b.due || '9999'),
      due: (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || P_ORDER[a.prio] - P_ORDER[b.prio],
      due_late: (a, b) => (b.due || '').localeCompare(a.due || '') || P_ORDER[a.prio] - P_ORDER[b.prio],
      updated: (a, b) => String(b.updated || '').localeCompare(String(a.updated || '')),
      name: (a, b) => String(a.title).localeCompare(String(b.title)),
    };
    rows.sort(SORTS[f.sortKey] || SORTS.priority);
    const ids = rows.filter((x) => x.kind === 'task').map((x) => x.id);
    const peopleBy = {};
    if (ids.length) for (const p of db.all(`SELECT p.task_id, p.user_id, p.role, u.name FROM wk_people p JOIN users u ON u.id = p.user_id WHERE p.task_id IN (${ids.map(() => '?').join(',')}) AND p.role = 'assignee'`, ...ids)) (peopleBy[p.task_id] = peopleBy[p.task_id] || []).push(p.name);
    const table = ui.table([
      { label: '', render: (x) => `<input type="checkbox" name="ids" value="${esc(x.key)}" form="wk-bulk" aria-label="${esc(tr('wk|Select'))}" class="wk-pick">` },
      { label: tr('wk|Title'), sort: (x) => x.title, render: (x) => `<b>${esc(x.title)}</b><small class="sub"><bdi>${esc(x.ref)}</bdi> · ${esc(x.kind === 'task' ? tr('wk|Task') : A().kindLabel(x.r.kind))}${x.kind === 'task' && x.t.labels ? ` · ${esc(x.t.labels)}` : ''}</small>` },
      { label: tr('wk|Status'), sort: (x) => x.status, render: (x) => (x.kind === 'task' ? sBadge(x.status) : `${A().badge(x.status)}${x.r.info_at ? ` ${ui.badge('q', tr('wk|Waiting for an answer'), 'sky')}` : ''}`) },
      { label: tr('wk|Priority'), sort: (x) => P_ORDER[x.prio], render: (x) => pBadge(x.prio) },
      { label: tr('wk|Who'), sort: (x) => (x.kind === 'task' ? (peopleBy[x.id] || []).join(', ') : A().whoLabel((x.r.steps[x.r.step] || {}).who)), render: (x) => esc(x.kind === 'task' ? (peopleBy[x.id] || []).join(', ') || '—' : x.status === 'pending' ? A().whoLabel((x.r.steps[x.r.step] || {}).who) : x.r.decider || '—') },
      { label: tr('wk|Due'), sort: (x) => x.due || '9999', render: (x) => (x.kind === 'task' ? dueChip(x.t) || '—' : x.status === 'pending' ? A().slaChip(x.r) : '—') },
    ], rows, { empty: esc(tr('wk|Nothing matches.')), href: (x) => (x.kind === 'task' ? `/admin/work/tasks/${x.id}` : `/admin/approvals/${x.id}`) });
    const labels = allLabels();
    const filters = `<form method="get" action="/admin/work/list" class="filters wk-filters">
      ${typeSelect(type)}${whoSelect(u, who)}
      ${ui.select('state', tr('wk|Status'), [['open', tr('wk|Open')], ...LANES.map((s) => [s, tr(STATUS[s][0])]), ['cancelled', tr('wk|Cancelled')], ['any', tr('All')]], state, { attrs: { 'data-autosubmit': '' } })}
      ${prioSelect(priority)}
      ${ui.select('due', tr('wk|Due'), [['late', tr('wk|Overdue')], ['today', tr('wk|Today')], ['week', tr('wk|This week')], ['none', tr('wk|No date')]], due, { blank: tr('All'), attrs: { 'data-autosubmit': '' } })}
      ${labels.length ? ui.select('label', tr('wk|Label'), labels.map((l) => [l, l]), label, { blank: tr('All'), attrs: { 'data-autosubmit': '' } }) : ''}
      ${f.fields}
      ${ui.input('q', tr('wk|Search'), search, { type: 'search', cls: 'wk-search' })}
      <div class="filters__go">${ui.btn(esc(tr('Filter')), { cls: 'btn--ghost btn--sm', ic: 'search' })}</div>${f.quick}</form>`;
    const userOpts = users().map((x) => [x.id, x.name]);
    const bulk = canUse(u) || (A() && A().waitingFor(u).length) ? ui.form('/admin/work/bulk', req.session.csrf, `<input type="hidden" name="back" value="${esc(req.originalUrl)}">
      <label class="check wk-all"><input type="checkbox" data-wk-all> <span>${esc(tr('wk|All'))}</span></label><b class="wk-sel" data-wk-selected>0</b>
      ${ui.select('action', tr('wk|With the selected'), [['assign', tr('wk|Give to')], ['priority', tr('wk|Set the priority')], ['done', tr('wk|Mark done')], ['cancel', tr('wk|Cancel tasks')], ['approve', tr('wk|Approve the approvals')]], 'assign', { attrs: { 'data-wk-action': '' } })}
      <span data-wk-for="assign">${ui.select('user_id', tr('wk|Person'), userOpts, u.id)}</span>
      <span data-wk-for="priority">${ui.select('priority', tr('wk|Priority'), Object.fromEntries(Object.entries(PRIORITY).map(([k, v]) => [k, tr(v[0])])), 'normal')}</span>
      <span data-wk-for="approve">${ui.input('note', tr('wk|Note for all'), '', { placeholder: tr('wk|Optional') })}</span>
      ${ui.btn(esc(tr('wk|Apply')), { cls: 'btn--primary btn--sm', attrs: { 'data-confirm': tr('wk|Apply to the selected items?') } })}`, { cls: 'wk-bulk', attrs: { id: 'wk-bulk' } }) : '';
    frame(req, res, { tab: '/admin/work/list', title: tr('wk|List'), body: `${filters}${ui.card(tr('wk|Tasks and approvals'), `${bulk}${table}`, { sub: esc(tn(rows.length, 'wk|{n} item', 'wk|{n} items')) })}` });
  });

  router.post('/work/bulk', (req, res) => {
    const u = req.user;
    const back = /^\/admin\/work/.test(String(req.body.back || '')) ? String(req.body.back) : '/admin/work/list';
    const keys = [].concat(req.body.ids || []).map(String).slice(0, 200);
    const action = String(req.body.action || '');
    if (!keys.length) return h.back(req, res, back, 'error', tr('wk|Select at least one item.'));
    let done = 0;
    let skipped = 0;
    for (const k of keys) {
      const [kind, raw] = k.split(':');
      const id = Number(raw);
      try {
        if (kind === 't') {
          const t = taskOf(id);
          if (!t || !canEditTask(u, t)) { skipped++; continue; }
          if (action === 'assign') {
            const to = Number(req.body.user_id);
            if (!userOf(to)) { skipped++; continue; }
            setPeople(t, [to], 'assignee', u);
            touch(t.id);
          } else if (action === 'priority' && PRIORITY[req.body.priority]) {
            db.run('UPDATE wk_tasks SET priority = ?, updated_at = ? WHERE id = ?', req.body.priority, now(), t.id);
            ev(t.id, 'priority', u, { data: { to: req.body.priority } });
          } else if (action === 'done') moveTask(t, 'done', u);
          else if (action === 'cancel') moveTask(t, 'cancelled', u);
          else { skipped++; continue; }
          done++;
        } else if (kind === 'a' && A()) {
          const r = A().requestOf(id);
          if (!r) { skipped++; continue; }
          if (action === 'approve') {
            if (!A().canDecide(u, r)) { skipped++; continue; }
            A().decide(id, u, 'approved', h.str(req.body.note, 1000) || null);
            h.log(req, 'Approved a request', 'approval', id, `${r.ref} · ${r.title}`);
          } else if (action === 'priority' && isLead(u)) A().setPriority(id, u, String(req.body.priority || ''));
          else { skipped++; continue; }
          done++;
        } else skipped++;
      } catch (e) {
        skipped++;
      }
    }
    if (done) h.log(req, action === 'approve' ? 'Bulk approved requests' : 'Updated tasks in bulk', 'wk_task', null, `${action} · ${done}`);
    h.back(req, res, back, done ? 'ok' : 'error', `${tr('wk|{n} done.', { n: done })}${skipped ? ` ${tr('wk|{n} skipped (not yours or not possible).', { n: skipped })}` : ''}`);
  });

  // ---------- calendar ----------
  router.get('/work/calendar', (req, res) => {
    const u = req.user;
    const m = /^\d{4}-\d{2}$/.test(String(req.query.m || '')) ? req.query.m : today().slice(0, 7);
    const who = req.query.who === 'all' || /^\d+$/.test(String(req.query.who || '')) ? String(req.query.who) : 'me';
    const first = `${m}-01`;
    const start = M.addDays(first, -dow(first));
    const days = Array.from({ length: 42 }, (_, i) => M.addDays(start, i));
    const end = days.at(-1);
    const tasks = taskQuery(u, { who, statuses: [...LANES] }).filter((t) => t.due_date && t.due_date >= start && t.due_date <= end);
    const apps = visibleApprovals(u, { who, days: 1 }).filter((r) => r.status === 'pending').map((r) => ({ r, d: (A().sla(r) || {}).due ? cairo(new Date(A().sla(r).due)).date : null })).filter((x) => x.d && x.d >= start && x.d <= end);
    const by = {};
    for (const t of tasks) (by[t.due_date] = by[t.due_date] || []).push(`<a class="wk-cal__item wk-cal__item--${esc(t.priority)}${t.status === 'done' ? ' is-done' : ''}" href="/admin/work/tasks/${t.id}" title="${esc(t.title)}">${t.due_time ? `<time>${esc(t.due_time)}</time>` : ''}${esc(t.title)}</a>`);
    for (const x of apps) (by[x.d] = by[x.d] || []).push(`<a class="wk-cal__item wk-cal__item--approval" href="/admin/approvals/${x.r.id}" title="${esc(A().titleOf(x.r))}">${ui.icon('check')}${esc(A().titleOf(x.r))}</a>`);
    const d0 = today();
    const prev = M.addMonths(first, -1).slice(0, 7);
    const next = M.addMonths(first, 1).slice(0, 7);
    const grid = `<div class="wk-cal"><div class="wk-cal__dows">${ui.weekdays().map((w) => `<b>${esc(w)}</b>`).join('')}</div><div class="wk-cal__grid">${days.map((d) => `<div class="wk-cal__day${d.slice(0, 7) !== m ? ' is-out' : ''}${d === d0 ? ' is-today' : ''}"><span class="wk-cal__n">${Number(d.slice(8))}</span>${(by[d] || []).slice(0, 4).join('')}${(by[d] || []).length > 4 ? `<a class="wk-cal__more" href="/admin/work/list?from=${d}&to=${d}&state=any&who=${esc(who)}">${esc(tr('wk|+{n} more', { n: by[d].length - 4 }))}</a>` : ''}</div>`).join('')}</div></div>`;
    const head = `<div class="wk-calbar"><a class="btn btn--ghost btn--sm" href="/admin/work/calendar?m=${prev}&who=${esc(who)}">${ui.icon('back')}<span class="wk-sr">${esc(tr('wk|Previous month'))}</span></a><h2>${esc(ui.monthYear(m))}</h2><a class="btn btn--ghost btn--sm" href="/admin/work/calendar?m=${next}&who=${esc(who)}"><span class="wk-sr">${esc(tr('wk|Next month'))}</span>${ui.icon('arrow')}</a><a class="btn btn--ghost btn--sm" href="/admin/work/calendar?who=${esc(who)}">${esc(tr('wk|Today'))}</a><form method="get" action="/admin/work/calendar" class="filters wk-filters"><input type="hidden" name="m" value="${esc(m)}">${whoSelect(u, who)}</form></div>`;
    frame(req, res, { tab: '/admin/work/calendar', title: tr('wk|Calendar'), body: `${head}${grid}` });
  });

  // ---------- team workload ----------
  router.get('/work/team', (req, res) => {
    const d = today();
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    const evs = A() ? db.all(`SELECT e.*, r.kind FROM apr_events e JOIN apr_requests r ON r.id = e.request_id WHERE e.request_id IN (SELECT request_id FROM apr_events WHERE action IN ('approved','rejected') AND at >= ?) ORDER BY e.request_id, e.at, e.id`, since) : [];
    // how long each decision took from the moment its step started (minus time waiting for answers)
    const speed = {};
    let start = null;
    let paused = 0;
    let askedAt = null;
    let last = null;
    for (const e of evs) {
      if (e.request_id !== last) { start = null; paused = 0; askedAt = null; last = e.request_id; }
      if (['submitted', 'reassigned'].includes(e.action)) { start = e.at; paused = 0; }
      if (e.action === 'info_asked') askedAt = e.at;
      if (e.action === 'info_given' && askedAt) { paused += Date.parse(e.at) - Date.parse(askedAt); askedAt = null; }
      if (['approved', 'rejected'].includes(e.action)) {
        if (start && e.at >= since && e.user_id) {
          const hrs = Math.max(0, (Date.parse(e.at) - Date.parse(start) - paused) / 3600000);
          const s = (speed[e.user_id] = speed[e.user_id] || { n: 0, hrs: 0, ok: 0 });
          s.n++;
          s.hrs += hrs;
          if (hrs <= A().slaHours(e.kind)) s.ok++;
        }
        start = e.at;
        paused = 0;
      }
    }
    const rows = users().filter((x) => x.role !== 'viewer' || db.value("SELECT COUNT(*) FROM wk_people WHERE user_id = ? AND role = 'assignee'", x.id)).map((x) => {
      const open = db.all(`SELECT t.* FROM wk_tasks t JOIN wk_people p ON p.task_id = t.id AND p.role = 'assignee' AND p.user_id = ? WHERE t.status IN ('todo','doing','waiting')`, x.id);
      const s = speed[x.id];
      const away = A() ? A().delegatesOf(x.id)[0] : null;
      return {
        x, open: open.length, late: open.filter((t) => dueState(t) === 'late').length, week: open.filter((t) => t.due_date && t.due_date >= d && t.due_date <= M.addDays(d, 7)).length,
        approvals: A() ? A().waitingFor(x).length : 0, avg: s ? s.hrs / s.n : null, hit: s ? s.ok / s.n : null, decided: s ? s.n : 0,
        doneMonth: db.value("SELECT COUNT(*) FROM wk_tasks WHERE done_by = ? AND substr(done_at, 1, 7) = ?", x.id, d.slice(0, 7)), away,
      };
    });
    const span = (hrs) => (hrs === null ? '—' : A() ? A().span(hrs) : `${Math.round(hrs)}h`);
    const table = ui.table([
      { label: tr('wk|Person'), sort: (r) => r.x.name, render: (r) => `<span class="wk-who">${avatar(r.x.name)}<span><b>${esc(r.x.name)}</b>${r.away ? `<small class="sub">${esc(tr('wk|Away · {name} covers', { name: r.away.name }))}</small>` : ''}</span></span>` },
      { label: tr('wk|Open tasks'), num: true, sort: (r) => r.open, render: (r) => `<a href="/admin/work/list?who=${r.x.id}">${r.open}</a>` },
      { label: tr('wk|Overdue'), num: true, sort: (r) => r.late, render: (r) => (r.late ? `<b class="wk-bad">${r.late}</b>` : '0') },
      { label: tr('wk|Due this week'), num: true, sort: (r) => r.week, render: (r) => String(r.week) },
      { label: tr('wk|Approvals waiting'), num: true, sort: (r) => r.approvals, render: (r) => (r.approvals ? `<b>${r.approvals}</b>` : '0') },
      { label: tr('wk|Decisions'), num: true, sort: (r) => (r.hit === null ? -1 : r.hit), render: (r) => (r.hit === null ? '—' : `<span class="wk-hit${r.hit >= 0.9 ? ' is-ok' : r.hit < 0.6 ? ' is-bad' : ''}">${esc(tr('wk|{pct} within the SLA', { pct: `${Math.round(r.hit * 100)}%` }))}</span><small class="sub">${esc(tr('wk|{time} on average · {n}', { time: span(r.avg), n: tn(r.decided, 'apr|{n} request', 'apr|{n} requests') }))}</small>`) },
      { label: tr('wk|Done this month'), num: true, sort: (r) => r.doneMonth, render: (r) => String(r.doneMonth) },
    ], rows.filter((r) => r.open || r.approvals || r.decided || r.doneMonth || r.away));
    const idle = rows.filter((r) => !(r.open || r.approvals || r.decided || r.doneMonth || r.away)).length;
    const loadBars = ui.bars(rows.filter((r) => r.open + r.approvals).sort((a, b) => b.open + b.approvals - (a.open + a.approvals)).slice(0, 12).map((r) => ({ v: r.open + r.approvals, l: r.x.name.split(/\s+/)[0] })), { key: 'v', label: 'l', tone: 'sea', h: 160 });
    const speedBars = ui.bars(rows.filter((r) => r.avg !== null).sort((a, b) => a.avg - b.avg).slice(0, 12).map((r) => ({ v: Math.round(r.avg * 10) / 10, l: r.x.name.split(/\s+/)[0] })), { key: 'v', label: 'l', tone: 'forest', h: 160, fmtv: (n) => span(n) });
    const totalOpen = rows.reduce((s, r) => s + r.open, 0);
    const totalLate = rows.reduce((s, r) => s + r.late, 0);
    const allDecided = Object.values(speed).reduce((s, x) => s + x.n, 0);
    const allOk = Object.values(speed).reduce((s, x) => s + x.ok, 0);
    const kpis = `<div class="kpis kpis--4">${ui.kpi({ label: tr('wk|Open tasks'), value: String(totalOpen) })}${ui.kpi({ label: tr('wk|Overdue'), value: String(totalLate), tone: totalLate ? 'kpi--alert' : '' })}${ui.kpi({ label: tr('wk|Approvals waiting'), value: String(A() ? db.value("SELECT COUNT(*) FROM apr_requests WHERE status = 'pending'") : 0) })}${ui.kpi({ label: tr('wk|Decided within the SLA'), value: allDecided ? `${Math.round((allOk / allDecided) * 100)}%` : '—', sub: esc(tr('wk|last 90 days')), bar: allDecided ? allOk / allDecided : null })}</div>`;
    frame(req, res, { tab: '/admin/work/team', title: tr('wk|Team workload'), body: `${kpis}<div class="grid grid--2">${ui.card(tr('wk|On each plate'), loadBars, { sub: esc(tr('wk|Open tasks and approvals waiting')) })}${ui.card(tr('wk|Average time to decide'), speedBars || '', { sub: esc(tr('wk|last 90 days, clock paused while waiting for answers')) })}</div>${ui.card(tr('wk|The team'), table, { sub: idle ? esc(tn(idle, 'wk|{n} more with nothing on their plate', 'wk|{n} more with nothing on their plate')) : '' })}` });
  });

  // ---------- inbox ----------
  function noteItem(n) {
    const p = parse(n.params, {});
    let title = '';
    if (n.task_id) title = (taskOf(n.task_id) || {}).title || '';
    else if (n.request_id && A()) {
      const r = A().requestOf(n.request_id);
      title = r ? A().titleOf(r) : '';
    }
    const by = n.by_id ? nameOf(n.by_id) : tr('wk|The office');
    // other modules' notifications carry their own words (params.vars: who, …; who_ar in Arabic)
    const vars = p.vars && typeof p.vars === 'object' ? { ...p.vars, ...(i18n.isAr() && p.vars.who_ar ? { who: p.vars.who_ar } : {}) } : {};
    const text = tr(NOTE[n.kind] || 'wk|{title}', { ...vars, name: by, title, date: p.date ? ui.date(p.date) : '' });
    const forName = p.for ? ` · ${tr('wk|for {name}', { name: nameOf(p.for) })}` : '';
    return `<li class="wk-note${n.read_at ? '' : ' is-new'}"><a href="/admin/work/inbox/${n.id}">${ui.icon(NOTE_ICON[n.kind] || 'inbox')}<span class="what"><b>${esc(text)}</b>${p.excerpt ? `<small class="wk-excerpt">“${esc(p.excerpt)}”</small>` : ''}<small>${esc(ui.rel(n.created_at))}${esc(forName)}</small></span></a></li>`;
  }
  router.get('/work/inbox', (req, res) => {
    const u = req.user;
    const f = h.listFilters(req, { cols: { date: 'created_at' }, dateLabel: tr('wk|Notifications'), keep: ['all'], sorts: [['newest', 'sort|Newest first', 'id DESC'], ['oldest', 'sort|Oldest first', 'id ASC'], ['unread', 'sort|Unread first', 'read_at IS NOT NULL, id DESC']] });
    const all = req.query.all === '1' || !!(f.from || f.to);
    const list = db.all(`SELECT * FROM wk_notes WHERE user_id = ? ${all ? '' : 'AND (read_at IS NULL OR created_at >= ?)'}${f.sql} ORDER BY ${f.order} LIMIT 200`, u.id, ...(all ? [] : [new Date(Date.now() - 14 * 86400000).toISOString()]), ...f.args);
    const n = unread(u);
    const actions = n ? ui.form('/admin/work/inbox/read', req.session.csrf, ui.btn(esc(tr('wk|Mark all as read')), { cls: 'btn--ghost btn--sm', ic: 'check' })) : '';
    frame(req, res, {
      tab: '/admin/work/inbox', title: tr('wk|Inbox'),
      body: f.html + ui.card(tr('wk|Notifications'), list.length ? `<ul class="list wk-notes">${list.map(noteItem).join('')}</ul>${all ? '' : `<p class="pad"><a href="/admin/work/inbox?all=1">${esc(tr('wk|Show older'))}</a></p>`}` : `<div class="wk-zero">${ui.icon('inbox')}<p>${esc(tr('wk|All caught up.'))}</p></div>`, { sub: esc(tn(n, 'wk|{n} unread', 'wk|{n} unread')), action: actions }),
    });
  });
  router.post('/work/inbox/read', (req, res) => {
    db.run('UPDATE wk_notes SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), req.user.id);
    h.back(req, res, '/admin/work/inbox', 'ok', tr('wk|All read.'));
  });
  router.get('/work/inbox/:id', (req, res, next) => {
    const n = db.get('SELECT * FROM wk_notes WHERE id = ? AND user_id = ?', h.int(req.params.id), req.user.id);
    if (!n) return next();
    if (!n.read_at) db.run('UPDATE wk_notes SET read_at = ? WHERE id = ?', now(), n.id);
    res.redirect(303, /^\/admin\//.test(String(n.link || '')) ? n.link : '/admin/work');
  });

  // ---------- away (delegation) ----------
  router.get('/work/away', (req, res) => {
    const u = req.user;
    const lead = isLead(u);
    const d = today();
    const list = db.all(`SELECT w.*, a.name who, b.name delegate FROM wk_delegations w JOIN users a ON a.id = w.user_id JOIN users b ON b.id = w.delegate_id
      WHERE w.cancelled_at IS NULL AND w.ends >= ? ${lead ? '' : 'AND (w.user_id = ? OR w.delegate_id = ?)'} ORDER BY w.starts`, d, ...(lead ? [] : [u.id, u.id]));
    const opts = users().map((x) => [x.id, x.name]);
    const form = ui.form('/admin/work/away', req.session.csrf, `<div class="fields">
      ${lead ? ui.select('user_id', tr('wk|Who is away'), opts, u.id) : `<input type="hidden" name="user_id" value="${u.id}">`}
      ${ui.select('delegate_id', tr('wk|Who covers'), opts.filter((o) => o[0] !== u.id || lead), '', { required: true, blank: tr('wk|Choose a colleague') })}
      ${ui.input('starts', tr('wk|From'), d, { type: 'date', required: true })}
      ${ui.input('ends', tr('wk|Until (last day away)'), M.addDays(d, 6), { type: 'date', required: true })}
      ${ui.input('note', tr('wk|Note'), '', { cls: 'span-all', placeholder: tr('wk|e.g. Annual leave, reachable by phone for urgent matters') })}
    </div><p class="muted small">${esc(tr('wk|While you are away, the person covering decides your approvals (shown as “for you”) and sees your tasks in their day. Your requests keep going to their approvers.'))}</p>${ui.btn(esc(tr('wk|Save')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    const rows = list.length ? `<ul class="list">${list.map((w) => `<li><span class="what"><b>${esc(w.who)} → ${esc(w.delegate)}</b><small>${esc(ui.date(w.starts))} – ${esc(ui.date(w.ends))}${w.note ? ` · ${esc(w.note)}` : ''}</small></span>${w.starts <= d ? ui.badge('now', tr('wk|Now'), 'amber') : ui.badge('later', tr('wk|Planned'), 'mute')}${w.user_id === u.id || lead ? ui.form(`/admin/work/away/${w.id}/end`, req.session.csrf, ui.btn(esc(tr('wk|End')), { cls: 'btn--ghost btn--sm' })) : ''}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('wk|Nobody is away.'))}</p>`;
    frame(req, res, { tab: '', title: tr('wk|Away and cover'), body: `<div class="grid grid--side"><div>${ui.card(tr('wk|Set who covers'), form)}</div><div>${ui.card(tr('wk|Away now and planned'), rows)}</div></div>` });
  });
  router.post('/work/away', (req, res) => {
    const u = req.user;
    const userId = isLead(u) ? h.int(req.body.user_id) || u.id : u.id;
    try {
      A().delegate({ user_id: userId, delegate_id: h.int(req.body.delegate_id), starts: String(req.body.starts || ''), ends: String(req.body.ends || ''), note: h.str(req.body.note, 300) || null, by: u });
    } catch (e) {
      return h.back(req, res, '/admin/work/away', 'error', /^wk\|/.test(e.message) ? tr(e.message) : e.message);
    }
    const del = userOf(h.int(req.body.delegate_id));
    notify(del.id, 'delegated', { by: userOf(userId), params: { date: String(req.body.ends) }, link: '/admin/work' });
    h.log(req, 'Set a delegate', 'user', userId, `${nameOf(userId)} → ${del.name} · ${req.body.starts} – ${req.body.ends}`);
    h.back(req, res, '/admin/work/away', 'ok', tr('wk|Saved. {name} has been told.', { name: del.name }));
  });
  router.post('/work/away/:id/end', (req, res, next) => {
    const w = db.get('SELECT * FROM wk_delegations WHERE id = ?', h.int(req.params.id));
    if (!w) return next();
    if (w.user_id !== req.user.id && !isLead(req.user)) return h.auth.denied(req, res);
    db.run('UPDATE wk_delegations SET cancelled_at = ? WHERE id = ?', now(), w.id);
    h.log(req, 'Ended a delegation', 'user', w.user_id, nameOf(w.delegate_id));
    h.back(req, res, '/admin/work/away', 'ok', tr('wk|Ended.'));
  });

  // ---------- recurring tasks ----------
  router.get('/work/recurring', (req, res) => {
    const u = req.user;
    const f = h.listFilters(req, { cols: { date: 't.next_on' }, dateLabel: tr('wk|Next'), sorts: [['next', 'sort|Due date: soonest first', 't.active DESC, t.next_on'], ['next_late', 'sort|Due date: latest first', 't.active DESC, t.next_on DESC'], ['name', 'sort|Name: A to Z', 't.title COLLATE NOCASE'], ['newest', 'sort|Newest first', 't.created_at DESC']] });
    const list = db.all(`SELECT t.*, a.name assignee FROM wk_templates t LEFT JOIN users a ON a.id = t.assignee_id ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''} ORDER BY ${f.order}`, ...f.args);
    const opts = users().map((x) => [x.id, x.name]);
    const when = (t) => (t.every === 'weekly' ? `${tr(EVERY.weekly)} · ${tr(DOW[t.weekday || 0])}` : t.every === 'monthly' ? tr('wk|Every month on day {n}', { n: t.monthday || 1 }) : tr(EVERY.daily));
    const rows = ui.table([
      { label: tr('wk|Task'), sort: (t) => t.title, render: (t) => `<b>${esc(t.title)}</b>${t.labels ? `<div class="wk-labels">${labelChips(t.labels)}</div>` : ''}` },
      { label: tr('wk|Repeats'), render: (t) => esc(when(t)) },
      { label: tr('wk|Given to'), render: (t) => esc(t.assignee || '—') },
      { label: tr('wk|Next'), sort: (t) => t.next_on, render: (t) => (t.active ? esc(ui.date(t.next_on)) : ui.badge('off', tr('wk|Paused'), 'mute')) },
      { label: '', render: (t) => (t.created_by === u.id || isLead(u) ? `<span class="wk-row-acts">${ui.form(`/admin/work/recurring/${t.id}/toggle`, req.session.csrf, ui.btn(esc(t.active ? tr('wk|Pause') : tr('wk|Resume')), { cls: 'btn--ghost btn--sm' }))}${t.active ? ui.form(`/admin/work/recurring/${t.id}/run`, req.session.csrf, ui.btn(esc(tr('wk|Make one now')), { cls: 'btn--ghost btn--sm' })) : ''}${ui.form(`/admin/work/recurring/${t.id}/delete`, req.session.csrf, ui.btn(esc(tr('wk|Delete')), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('wk|Delete this recurring task? Tasks it already made stay.') } }))}</span>` : '') },
    ], list, { empty: esc(tr('wk|No recurring tasks yet.')) });
    const form = canUse(u) ? ui.form('/admin/work/recurring', req.session.csrf, `<div class="fields">
      ${ui.input('title', tr('wk|Title'), '', { required: true, cls: 'span-all', placeholder: tr('wk|e.g. Weekly fire extinguisher round') })}
      ${ui.select('every', tr('wk|Repeats'), Object.fromEntries(Object.entries(EVERY).map(([k, v]) => [k, tr(v)])), 'weekly')}
      ${ui.select('weekday', tr('wk|On (weekly)'), DOW.map((x, i) => [i, tr(x)]), 6)}
      ${ui.input('monthday', tr('wk|Day of the month (monthly)'), 1, { type: 'number', min: 1, max: 28 })}
      ${ui.input('due_days', tr('wk|Days to do it'), 0, { type: 'number', min: 0, max: 60, hint: tr('wk|0 = due the same day') })}
      ${ui.select('assignee_id', tr('wk|Given to'), opts, u.id, { blank: tr('wk|Nobody') })}
      ${ui.select('priority', tr('wk|Priority'), Object.fromEntries(Object.entries(PRIORITY).map(([k, v]) => [k, tr(v[0])])), 'normal')}
      ${ui.input('labels', tr('wk|Labels'), '', { placeholder: tr('wk|e.g. safety, weekly') })}
      ${ui.textarea('checklist', tr('wk|Checklist (one item a line)'), '', { rows: 4, cls: 'span-all' })}
      ${ui.textarea('body', tr('wk|Details'), '', { rows: 3, cls: 'span-all' })}
    </div>${ui.btn(esc(tr('wk|Add the recurring task')), { cls: 'btn--primary' })}`, { cls: 'stack' }) : '';
    frame(req, res, { tab: '/admin/work/recurring', title: tr('wk|Recurring tasks'), body: `${f.html}${ui.card(tr('wk|Recurring tasks'), rows, { sub: esc(tr('wk|A task is made on each date, given to the person chosen, with its checklist.')) })}${form ? ui.card(tr('wk|New recurring task'), form) : ''}` });
  });
  router.post('/work/recurring', (req, res) => {
    if (!canUse(req.user)) return h.auth.denied(req, res);
    const b = req.body;
    const title = h.str(b.title, 200);
    if (!title) return h.back(req, res, '/admin/work/recurring', 'error', tr('wk|Give the task a title.'));
    const every = EVERY[b.every] ? b.every : 'weekly';
    const tpl = { every, weekday: Math.max(0, Math.min(6, h.int(b.weekday) || 0)), monthday: Math.max(1, Math.min(28, h.int(b.monthday) || 1)) };
    const id = Number(db.run(`INSERT INTO wk_templates (title, body, priority, assignee_id, labels, checklist, every, weekday, monthday, due_days, next_on, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, title, h.str(b.body, 2000) || null, PRIORITY[b.priority] ? b.priority : 'normal', userOf(h.int(b.assignee_id)) ? h.int(b.assignee_id) : null,
    cleanLabels(b.labels), h.str(b.checklist, 4000) || null, every, every === 'weekly' ? tpl.weekday : null, every === 'monthly' ? tpl.monthday : null, Math.max(0, Math.min(60, h.int(b.due_days) || 0)), nextOn(tpl, today()), req.user.id, now()).lastInsertRowid);
    h.log(req, 'Added a recurring task', 'wk_template', id, title);
    h.back(req, res, '/admin/work/recurring', 'ok', tr('wk|Saved. The first one is made on {date}.', { date: ui.date(nextOn(tpl, today())) }));
  });
  const tplGuard = (req, res, next) => {
    const t = db.get('SELECT * FROM wk_templates WHERE id = ?', h.int(req.params.id));
    if (!t) return next('route');
    if (t.created_by !== req.user.id && !isLead(req.user)) return h.auth.denied(req, res);
    req.tpl = t;
    next();
  };
  router.post('/work/recurring/:id/toggle', tplGuard, (req, res) => {
    const t = req.tpl;
    db.run('UPDATE wk_templates SET active = ?, next_on = ? WHERE id = ?', t.active ? 0 : 1, t.active ? t.next_on : nextOn(t, today()), t.id);
    h.log(req, 'Changed a recurring task', 'wk_template', t.id, t.title);
    h.back(req, res, '/admin/work/recurring', 'ok', t.active ? tr('wk|Paused.') : tr('wk|Resumed.'));
  });
  router.post('/work/recurring/:id/run', tplGuard, (req, res) => {
    const t = req.tpl;
    const task = createTask({ title: t.title, body: t.body, priority: t.priority, labels: t.labels, due_date: M.addDays(today(), t.due_days || 0), assignees: t.assignee_id ? [t.assignee_id] : [], checklist: String(t.checklist || '').split('\n'), user: req.user, template_id: t.id });
    h.log(req, 'Created a task', 'wk_task', task.id, `${task.ref} · ${task.title}`);
    h.back(req, res, `/admin/work/tasks/${task.id}`, 'ok', tr('wk|Task made.'));
  });
  router.post('/work/recurring/:id/delete', tplGuard, (req, res) => {
    db.run('UPDATE wk_tasks SET template_id = NULL WHERE template_id = ?', req.tpl.id);
    db.run('DELETE FROM wk_templates WHERE id = ?', req.tpl.id);
    h.log(req, 'Changed a recurring task', 'wk_template', req.tpl.id, req.tpl.title);
    h.back(req, res, '/admin/work/recurring', 'ok', tr('wk|Deleted.'));
  });

  // ---------- one task ----------
  const panel = uploadRoute(router, h, '/work/files', { wk_task: 'wk_tasks' }, {
    canUpload: (req) => {
      const t = taskOf(h.int(req.query.entity_id));
      return !!t && canEditTask(req.user, t);
    },
  });
  const taskForm = (req, t = {}, { action, people = [] } = {}) => {
    const opts = users().map((x) => [x.id, x.name]);
    const asg = people.filter((p) => p.role === 'assignee').map((p) => p.user_id);
    const wat = people.filter((p) => p.role === 'watcher').map((p) => p.user_id);
    const multi = (name, label, chosen) => `<fieldset class="f wk-people-pick"><legend class="f__l">${esc(label)}</legend><div class="wk-picks">${opts.map(([id, n]) => `<label class="wk-pick-p${chosen.includes(id) ? ' is-on' : ''}"><input type="checkbox" name="${name}" value="${id}"${chosen.includes(id) ? ' checked' : ''}>${avatar(n)}<span>${esc(n)}</span></label>`).join('')}</div></fieldset>`;
    return ui.form(action, req.session.csrf, `<div class="fields">
      ${ui.input('title', tr('wk|Title'), t.title || '', { required: true, cls: 'span-all', attrs: { maxlength: 200, autofocus: !t.id } })}
      <label class="f span-all"><span class="f__l">${esc(tr('wk|Details'))}</span><textarea name="body" rows="4" data-wk-people="${peopleJson()}" placeholder="${esc(tr('wk|Type @ and a name to mention someone'))}">${esc(t.body || '')}</textarea></label>
      ${ui.select('priority', tr('wk|Priority'), Object.fromEntries(Object.entries(PRIORITY).map(([k, v]) => [k, tr(v[0])])), t.priority || 'normal')}
      ${t.id ? '' : ui.select('status', tr('wk|Status'), Object.fromEntries(LANES.map((s) => [s, tr(STATUS[s][0])])), 'todo')}
      ${ui.input('due_date', tr('wk|Due date'), t.due_date || '', { type: 'date' })}
      ${ui.input('due_time', tr('wk|Time'), t.due_time || '', { type: 'time' })}
      ${ui.input('labels', tr('wk|Labels'), t.labels || '', { placeholder: tr('wk|e.g. finance, tenants'), attrs: { list: 'wk-labels' } })}
      <datalist id="wk-labels">${allLabels().map((l) => `<option value="${esc(l)}"></option>`).join('')}</datalist>
      ${ui.input('link', tr('wk|About (a page in the office)'), t.link || req.query.link || '', { placeholder: '/admin/leases/12', attrs: { list: 'wk-links' }, hint: tr('wk|Pick a record or paste an office address.') })}${linkOptions()}
      ${multi('assignees', tr('wk|Given to'), t.id ? asg : [req.user.id])}
      ${multi('watchers', tr('wk|Watching'), wat)}
      ${t.id ? '' : ui.textarea('checklist', tr('wk|Checklist (one item a line)'), '', { rows: 3, cls: 'span-all' })}
      <label class="check span-all"><input type="checkbox" name="private" value="1"${t.private ? ' checked' : ''}> ${esc(tr('wk|Private: only the people on it and managers see it'))}</label>
    </div>${ui.btn(esc(t.id ? tr('wk|Save') : tr('wk|Create the task')), { cls: 'btn--primary' })}`, { cls: 'stack wk-form' });
  };
  router.get('/work/tasks/new', (req, res) => {
    if (!canUse(req.user)) return h.auth.denied(req, res);
    frame(req, res, { tab: '', title: tr('wk|New task'), body: `<div class="wk-narrow">${ui.card(tr('wk|New task'), taskForm(req, {}, { action: '/admin/work/tasks' }))}</div>` });
  });
  router.post('/work/tasks', (req, res) => {
    const u = req.user;
    if (!canUse(u)) return h.auth.denied(req, res);
    const b = req.body;
    const back = /^\/admin\/work/.test(String(b.back || '')) ? String(b.back) : null;
    try {
      const t = createTask({
        title: h.str(b.title, 200), body: h.str(b.body, 4000) || null, status: b.status, priority: b.priority, due_date: b.due_date, due_time: b.due_time, labels: b.labels,
        link: b.link, private: b.private === '1', assignees: [].concat(b.assignees || []), watchers: [].concat(b.watchers || []), checklist: String(b.checklist || '').split('\n'), user: u,
      });
      h.log(req, 'Created a task', 'wk_task', t.id, `${t.ref} · ${t.title}`);
      h.back(req, res, b.quick === '1' && back ? back : `/admin/work/tasks/${t.id}`, 'ok', tr('wk|Task {ref} created.', { ref: t.ref }));
    } catch (e) {
      h.back(req, res, back || '/admin/work/tasks/new', 'error', /^wk\|/.test(e.message) ? tr(e.message) : e.message);
    }
  });
  const load = (req, res, next) => {
    const t = taskOf(h.int(req.params.id));
    if (!t) return next('route');
    const people = peopleOf(t.id);
    if (!canSeeTask(req.user, t, people)) return h.auth.denied(req, res);
    req.task = t;
    req.people = people;
    next();
  };
  const editable = (req, res, next) => (canEditTask(req.user, req.task, req.people) ? next() : h.auth.denied(req, res));
  const json = (req) => /json/.test(String(req.get('accept') || ''));

  const EV_TEXT = {
    created: 'wk|created the task', status: 'wk|moved it from {from} to {to}', assigned: 'wk|gave it to {user}', unassigned: 'wk|took it off {user}',
    watched: 'wk|added {user} as a watcher', unwatched: 'wk|removed {user} from the watchers', priority: 'wk|set the priority to {to}', due: 'wk|set the due date to {to}',
    edited: 'wk|edited the task', check: 'wk|ticked', uncheck: 'wk|unticked', checkadd: 'wk|added to the checklist', file: 'wk|added a file', comment: 'wk|commented',
  };
  router.get('/work/tasks/:id', load, (req, res) => {
    const u = req.user;
    const t = req.task;
    const csrf = req.session.csrf;
    const may = canEditTask(u, t, req.people);
    const checks = db.all('SELECT c.*, u.name done_name FROM wk_checks c LEFT JOIN users u ON u.id = c.done_by WHERE c.task_id = ? ORDER BY c.pos, c.id', t.id);
    const done = checks.filter((c) => c.done_at).length;
    const events = db.all('SELECT e.*, u.name FROM wk_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = ? ORDER BY e.at, e.id', t.id);
    const asg = req.people.filter((p) => p.role === 'assignee');
    const wat = req.people.filter((p) => p.role === 'watcher');
    const watching = req.people.some((p) => p.user_id === u.id);
    // mark this task's notifications read
    db.run('UPDATE wk_notes SET read_at = ? WHERE user_id = ? AND task_id = ? AND read_at IS NULL', now(), u.id, t.id);
    const stepper = `<ol class="wk-flow">${LANES.map((s, i) => {
      const at = LANES.indexOf(t.status);
      const cls = t.status === 'cancelled' ? '' : i < at ? ' is-past' : i === at ? ' is-now' : '';
      return `<li class="wk-flow__s${cls}">${may && s !== t.status ? ui.form(`/admin/work/tasks/${t.id}/move`, csrf, `<button type="submit" name="status" value="${s}">${esc(tr(STATUS[s][0]))}</button>`) : `<span>${esc(tr(STATUS[s][0]))}</span>`}</li>`;
    }).join('')}</ol>`;
    const checklist = `${checks.length ? `<div class="wk-progress"><i style="width:${Math.round((done / checks.length) * 100)}%"></i></div><p class="muted small">${esc(tr('wk|{done} of {n} done', { done, n: checks.length }))}</p>` : ''}<ul class="wk-checks">${checks.map((c) => `<li class="${c.done_at ? 'is-done' : ''}">${may ? ui.form(`/admin/work/tasks/${t.id}/checks/${c.id}`, csrf, `<button class="wk-tick" type="submit" aria-label="${esc(c.done_at ? tr('wk|Untick') : tr('wk|Tick'))}">${c.done_at ? ui.icon('check') : ''}</button>`) : `<span class="wk-tick">${c.done_at ? ui.icon('check') : ''}</span>`}<span class="wk-checks__t"><span class="wk-checks__x">${esc(c.text)}</span>${c.done_at ? `<small>${esc(c.done_name || '')} · ${esc(ui.rel(c.done_at))}</small>` : ''}</span>${may ? ui.form(`/admin/work/tasks/${t.id}/checks/${c.id}/delete`, csrf, `<button class="wk-x" type="submit" aria-label="${esc(tr('wk|Remove'))}">${ui.icon('x')}</button>`) : ''}</li>`).join('')}</ul>${may ? ui.form(`/admin/work/tasks/${t.id}/checks`, csrf, `<label class="wk-quick__in"><span class="wk-sr">${esc(tr('wk|Add an item'))}</span><input name="text" required maxlength="200" placeholder="${esc(tr('wk|Add an item…'))}"></label><button class="btn btn--ghost btn--sm" type="submit">${ui.icon('plus')}<span>${esc(tr('wk|Add'))}</span></button>`, { cls: 'wk-quick' }) : ''}`;
    const timeline = `<ul class="feed wk-feed">${events.map((e) => {
      const d = parse(e.data, {});
      const p = { from: d.from ? tr(STATUS[d.from][0]) : '', to: d.to ? (STATUS[d.to] ? tr(STATUS[d.to][0]) : PRIORITY[d.to] ? tr(PRIORITY[d.to][0]) : isDate(d.to) ? ui.date(d.to) : d.to) : tr('wk|no date'), user: d.user ? nameOf(d.user) : '' };
      if (e.kind === 'comment') return `<li class="wk-ev wk-ev--comment"><span class="avatar avatar--sm">${esc(ui.initials(e.name || '—'))}</span><div class="wk-bubble"><p><b>${esc(e.name || '—')}</b> <time datetime="${esc(e.at)}" title="${esc(ui.dt(e.at))}">${esc(ui.rel(e.at))}</time></p><div class="wk-comment">${mentionHtml(e.body)}</div></div></li>`;
      return `<li class="wk-ev">${ui.icon(e.kind === 'status' ? 'flow' : e.kind.includes('check') ? 'check' : e.kind.includes('assign') || e.kind.includes('watch') ? 'people' : 'log')}<p><b>${esc(e.name || tr('wk|The office'))}</b> <span>${esc(tr(EV_TEXT[e.kind] || 'wk|edited the task', p))}</span>${e.body && e.kind !== 'comment' ? ` <q class="apr-note">${esc(e.body)}</q>` : ''}</p><time datetime="${esc(e.at)}" title="${esc(ui.dt(e.at))}">${esc(ui.rel(e.at))}</time></li>`;
    }).join('')}</ul>`;
    const commentForm = ui.form(`/admin/work/tasks/${t.id}/comment`, csrf, `<label class="f"><span class="f__l">${esc(tr('wk|Comment'))}</span><textarea name="body" rows="3" required data-wk-people="${peopleJson()}" placeholder="${esc(tr('wk|Write a comment… type @ to mention someone'))}"></textarea></label>${ui.btn(esc(tr('wk|Post')), { cls: 'btn--primary btn--sm', ic: 'chat' })}`, { cls: 'stack wk-comment-form' });
    const facts = `<dl class="dl wk-facts">
      <div><dt>${esc(tr('wk|Status'))}</dt><dd>${sBadge(t.status)}</dd></div>
      <div><dt>${esc(tr('wk|Priority'))}</dt><dd>${pBadge(t.priority)}</dd></div>
      <div><dt>${esc(tr('wk|Due'))}</dt><dd>${dueChip(t) || '—'}</dd></div>
      <div><dt>${esc(tr('wk|Given to'))}</dt><dd>${asg.length ? asg.map((p) => `<span class="wk-who">${avatar(p.name)}<span>${esc(p.name)}</span></span>`).join('') : esc(tr('wk|Nobody yet'))}</dd></div>
      ${wat.length ? `<div><dt>${esc(tr('wk|Watching'))}</dt><dd>${wat.map((p) => avatar(p.name)).join('')}</dd></div>` : ''}
      ${t.labels ? `<div><dt>${esc(tr('wk|Labels'))}</dt><dd><div class="wk-labels">${labelChips(t.labels)}</div></dd></div>` : ''}
      ${t.link ? `<div><dt>${esc(tr('wk|About'))}</dt><dd><a href="${esc(t.link)}">${ui.icon('file')} ${esc(linkName(t))}</a></dd></div>` : ''}
      <div><dt>${esc(tr('wk|Created'))}</dt><dd>${esc(t.creator || '—')} · ${esc(ui.dt(t.created_at))}</dd></div>
      ${t.done_at ? `<div><dt>${esc(tr('wk|Finished'))}</dt><dd>${esc(nameOf(t.done_by))} · ${esc(ui.dt(t.done_at))}</dd></div>` : ''}
      ${t.template_id ? `<div><dt>${esc(tr('wk|Repeats'))}</dt><dd><a href="/admin/work/recurring">${esc(tr('wk|From a recurring task'))}</a></dd></div>` : ''}
    </dl>`;
    const actions = [
      ui.form(`/admin/work/tasks/${t.id}/watch`, csrf, ui.btn(esc(watching ? tr('wk|Stop watching') : tr('wk|Watch')), { cls: 'btn--ghost btn--sm', ic: 'people' })),
      may && OPEN.includes(t.status) ? ui.form(`/admin/work/tasks/${t.id}/move`, csrf, `<input type="hidden" name="status" value="done">${ui.btn(esc(tr('wk|Mark done')), { cls: 'btn--primary btn--sm', ic: 'check' })}`) : '',
      may && t.status === 'done' ? ui.form(`/admin/work/tasks/${t.id}/move`, csrf, `<input type="hidden" name="status" value="todo">${ui.btn(esc(tr('wk|Reopen')), { cls: 'btn--ghost btn--sm' })}`) : '',
      allowed(u, 'agent') ? ui.btn(esc(tr('wk|Ask for approval')), { href: `/admin/approvals/new?link=${encodeURIComponent(`/admin/work/tasks/${t.id}`)}`, cls: 'btn--ghost btn--sm', ic: 'check' }) : '',
    ].join('');
    const edit = may ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${esc(tr('wk|Edit the task'))}</span></summary>${taskForm(req, t, { action: `/admin/work/tasks/${t.id}`, people: req.people })}</details>` : '';
    const danger = may && t.status !== 'cancelled' ? `<details class="danger"><summary>${esc(tr('wk|Cancel the task'))}</summary>${ui.form(`/admin/work/tasks/${t.id}/move`, csrf, `<input type="hidden" name="status" value="cancelled">${ui.btn(esc(tr('wk|Cancel the task')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('wk|Cancel this task? It stays in the history.') } })}`)}</details>` : '';
    frame(req, res, {
      tab: '', title: t.title, crumbs: [['/admin/work', tr('nav|Approvals & tasks')], ['/admin/work/board', tr('wk|Board')], [null, t.ref]], actions,
      body: `<div class="wk-task">
        <div class="stack wk-task__main">
          ${ui.card(t.title, `${stepper}${t.body ? `<div class="wk-body">${mentionHtml(t.body)}</div>` : `<p class="muted">${esc(tr('wk|No details.'))}</p>`}`, { sub: `<bdi>${esc(t.ref)}</bdi>${t.private ? ` · ${esc(tr('wk|Private'))}` : ''}`, action: pBadge(t.priority) })}
          ${ui.card(tr('wk|Checklist'), checklist)}
          ${ui.card(tr('wk|Comments and history'), `${timeline}${commentForm}`)}
        </div>
        <div class="stack wk-task__side">${ui.card(tr('wk|Details'), facts)}${panel(req, 'wk_task', t.id, { title: tr('wk|Files') })}${edit}${danger}</div>
      </div>`,
    });
  });
  // mentions shown as chips; everything else as text with line breaks
  function mentionHtml(text) {
    const who = mentioned(text);
    return `<p class="wk-text">${esc(String(text || ''))}</p>${who.length ? `<p class="wk-mentions">${ui.icon('chat')}${who.map((id) => `<span class="wk-who">${avatar(nameOf(id))}<span>${esc(nameOf(id))}</span></span>`).join('')}</p>` : ''}`;
  }
  router.post('/work/tasks/:id', load, editable, (req, res) => {
    const t = req.task;
    const b = req.body;
    const u = req.user;
    const title = h.str(b.title, 200);
    if (!title) return h.back(req, res, `/admin/work/tasks/${t.id}`, 'error', tr('wk|Give the task a title.'));
    const fresh = {
      title, body: h.str(b.body, 4000) || null, priority: PRIORITY[b.priority] ? b.priority : t.priority, due_date: isDate(b.due_date) ? b.due_date : null,
      due_time: isDate(b.due_date) && isTime(b.due_time) ? b.due_time : null, labels: cleanLabels(b.labels), link: safeLink(b.link), private: b.private === '1' ? 1 : 0,
    };
    db.tx(() => {
      db.run('UPDATE wk_tasks SET title = ?, body = ?, priority = ?, due_date = ?, due_time = ?, labels = ?, link = ?, link_label = CASE WHEN link = ? THEN link_label ELSE NULL END, private = ?, due_noted = CASE WHEN due_date = ? THEN due_noted ELSE NULL END, updated_at = ? WHERE id = ?',
        fresh.title, fresh.body, fresh.priority, fresh.due_date, fresh.due_time, fresh.labels, fresh.link, fresh.link, fresh.private, fresh.due_date, now(), t.id);
      if (fresh.priority !== t.priority) ev(t.id, 'priority', u, { data: { to: fresh.priority } });
      if (fresh.due_date !== t.due_date) ev(t.id, 'due', u, { data: { to: fresh.due_date } });
      if (fresh.title !== t.title || fresh.body !== t.body || fresh.labels !== t.labels || fresh.link !== t.link) ev(t.id, 'edited', u);
      const task = taskOf(t.id);
      setPeople(task, [].concat(b.assignees || []), 'assignee', u);
      const asg = [].concat(b.assignees || []).map(Number);
      setPeople(task, [].concat(b.watchers || []).filter((w) => !asg.includes(Number(w))), 'watcher', u);
      if (fresh.body && fresh.body !== t.body) {
        const before = new Set(mentioned(t.body));
        for (const m of mentioned(fresh.body)) if (!before.has(m)) notify(m, 'mention', { by: u, task, params: { excerpt: fresh.body.slice(0, 160) } });
      }
    });
    h.log(req, 'Updated a task', 'wk_task', t.id, `${t.ref} · ${title}`);
    h.back(req, res, `/admin/work/tasks/${t.id}`, 'ok', tr('wk|Saved.'));
  });
  router.post('/work/tasks/:id/move', load, (req, res) => {
    const t = req.task;
    if (!canEditTask(req.user, t, req.people)) {
      if (json(req)) return res.status(403).json({ ok: false, error: tr('Your role does not allow that.') });
      return h.auth.denied(req, res);
    }
    const status = String(req.body.status || '');
    if (!STATUS[status]) {
      if (json(req)) return res.status(422).json({ ok: false, error: tr('wk|Choose a column.') });
      return h.back(req, res, `/admin/work/tasks/${t.id}`, 'error', tr('wk|Choose a column.'));
    }
    const after = moveTask(t, status, req.user);
    h.log(req, status === 'done' ? 'Completed a task' : status === 'cancelled' ? 'Cancelled a task' : 'Moved a task', 'wk_task', t.id, `${t.ref} · ${tr(STATUS[status][0])}`);
    if (json(req)) return res.json({ ok: true, status: after.status, label: tr(STATUS[after.status][0]) });
    const back = /^\/admin\/work/.test(String(req.body.back || '')) ? String(req.body.back) : `/admin/work/tasks/${t.id}`;
    h.back(req, res, back, 'ok', tr('wk|Moved to {to}.', { to: tr(STATUS[status][0]) }));
  });
  router.post('/work/tasks/:id/comment', load, (req, res) => {
    const t = req.task;
    if (!canUse(req.user) && !canEditTask(req.user, t, req.people)) return h.auth.denied(req, res);
    try {
      const who = comment(t, req.user, h.str(req.body.body, 4000));
      h.log(req, 'Commented on a task', 'wk_task', t.id, t.ref);
      h.back(req, res, `/admin/work/tasks/${t.id}`, 'ok', who.length ? tr('wk|Posted. {names} told.', { names: who.map(nameOf).join(', ') }) : tr('wk|Posted.'));
    } catch (e) {
      h.back(req, res, `/admin/work/tasks/${t.id}`, 'error', /^wk\|/.test(e.message) ? tr(e.message) : e.message);
    }
  });
  router.post('/work/tasks/:id/watch', load, (req, res) => {
    const t = req.task;
    const mine = req.people.find((p) => p.user_id === req.user.id);
    if (mine && mine.role === 'watcher') db.run('DELETE FROM wk_people WHERE task_id = ? AND user_id = ?', t.id, req.user.id);
    else if (!mine) db.run("INSERT INTO wk_people (task_id, user_id, role) VALUES (?, ?, 'watcher')", t.id, req.user.id);
    h.back(req, res, `/admin/work/tasks/${t.id}`, 'ok', mine ? tr('wk|You no longer watch it.') : tr('wk|You will hear about changes.'));
  });
  router.post('/work/tasks/:id/checks', load, editable, (req, res) => {
    const t = req.task;
    const text = h.str(req.body.text, 200);
    if (!text) return h.back(req, res, `/admin/work/tasks/${t.id}`, 'error', tr('wk|Write the item first.'));
    db.run('INSERT INTO wk_checks (task_id, text, pos) VALUES (?, ?, ?)', t.id, text, (db.value('SELECT MAX(pos) FROM wk_checks WHERE task_id = ?', t.id) ?? -1) + 1);
    ev(t.id, 'checkadd', req.user, { body: text });
    touch(t.id);
    h.back(req, res, `/admin/work/tasks/${t.id}`, 'ok', tr('wk|Added.'));
  });
  router.post('/work/tasks/:id/checks/:cid', load, editable, (req, res, next) => {
    const t = req.task;
    const c = db.get('SELECT * FROM wk_checks WHERE id = ? AND task_id = ?', h.int(req.params.cid), t.id);
    if (!c) return next('route');
    db.run('UPDATE wk_checks SET done_at = ?, done_by = ? WHERE id = ?', c.done_at ? null : now(), c.done_at ? null : req.user.id, c.id);
    ev(t.id, c.done_at ? 'uncheck' : 'check', req.user, { body: c.text });
    touch(t.id);
    // the last item ticked moves a task that was still to do into progress
    if (!c.done_at && t.status === 'todo') moveTask(t, 'doing', req.user);
    h.back(req, res, `/admin/work/tasks/${t.id}`, 'ok', c.done_at ? tr('wk|Unticked.') : tr('wk|Ticked.'));
  });
  router.post('/work/tasks/:id/checks/:cid/delete', load, editable, (req, res, next) => {
    const t = req.task;
    const c = db.get('SELECT * FROM wk_checks WHERE id = ? AND task_id = ?', h.int(req.params.cid), t.id);
    if (!c) return next('route');
    db.run('DELETE FROM wk_checks WHERE id = ?', c.id);
    touch(t.id);
    h.back(req, res, `/admin/work/tasks/${t.id}`, 'ok', tr('wk|Removed.'));
  });
};

module.exports.NOTE = NOTE;
module.exports.NOTE_ICON = NOTE_ICON;
module.exports.STATUS = STATUS;
module.exports.PRIORITY = PRIORITY;
