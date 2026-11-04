'use strict';

// Safety and licences (/admin/compliance): everything the mall must keep valid, and when.
//
//   The register     civil defence approval, fire alarm, sprinkler, extinguisher and emergency
//                    lighting tests, lift and escalator certificates, generator tests, pest control,
//                    water tank cleaning, the mall's licences and permits, its insurance policies.
//                    Each has how often it is due, when it was last done, when it is next due, who
//                    is responsible, and its certificates and evidence (uploaded).
//   Doing it         recording a test or renewal moves the next due date on and keeps the history.
//   Alerts           a job emails the responsible person (and the managers) when an item comes due,
//                    a week before, and when it is overdue — once each.
//   The calendar     the next 12 months, item by item, and what was done in the last 12.
//   Tenants          each tenant's insurance certificate (from their documents): missing, expired
//                    or expiring, with a reminder to the tenant (portal and email, seen or not).

const { t: tr, tn } = require('../i18n');
const { tmap, registerDocs, uploadRoute } = require('../ops-common');

const SCHEMA = `
  CREATE TABLE cmp_items (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, category TEXT NOT NULL DEFAULT 'other', title TEXT NOT NULL, provider TEXT, number TEXT,
    freq TEXT NOT NULL DEFAULT 'yearly', last_done TEXT, next_due TEXT, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    remind_days INTEGER NOT NULL DEFAULT 30, notes TEXT, active INTEGER NOT NULL DEFAULT 1, alerted TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX cmp_items_due ON cmp_items(next_due);
  CREATE TABLE cmp_done (
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES cmp_items(id) ON DELETE CASCADE, done_on TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'pass',
    by_name TEXT, cert_no TEXT, next_due TEXT, note TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX cmp_done_item ON cmp_done(item_id, done_on);
  CREATE TABLE cmp_reminders (
    id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'insurance',
    reason TEXT, notice_id INTEGER, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
  );
`;

const CATS = {
  civil_defence: 'cmp|Civil defence', fire_alarm: 'cmp|Fire alarm', sprinklers: 'cmp|Sprinklers', extinguishers: 'cmp|Fire extinguishers',
  emergency_lighting: 'cmp|Emergency lighting', lifts: 'cmp|Lifts', escalators: 'cmp|Escalators', generator: 'cmp|Generators',
  pest: 'cmp|Pest control', water_tanks: 'cmp|Water tanks', licence: 'cmp|Licences and permits', insurance: 'cmp|Mall insurance', other: 'cmp|Other',
};
const FREQ = {
  weekly: ['cmp|Every week', 0, 7], monthly: ['cmp|Every month', 1, 0], quarterly: ['cmp|Every 3 months', 3, 0], half: ['cmp|Every 6 months', 6, 0],
  yearly: ['cmp|Every year', 12, 0], two_years: ['cmp|Every 2 years', 24, 0], three_years: ['cmp|Every 3 years', 36, 0], once: ['cmp|Set by hand', 0, 0],
};
const RESULT = { pass: ['cmp|Passed', 'ok'], conditional: ['cmp|Passed with remarks', 'amber'], fail: ['cmp|Failed', 'rose'] };
const STATE = { overdue: ['cmp|Overdue', 'rose'], week: ['cmp|Due this week', 'rose'], soon: ['cmp|Due soon', 'amber'], ok: ['cmp|Valid', 'ok'], none: ['cmp|No date', 'mute'] };
const INS = { missing: ['cmp|Missing', 'rose'], expired: ['cmp|Expired', 'rose'], soon: ['cmp|Expiring soon', 'amber'], ok: ['cmp|Valid', 'ok'], nodate: ['cmp|No expiry date', 'mute'] };

module.exports = function compliance(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  db.ensure('compliance-1', SCHEMA);
  const esc = ui.esc;
  const now = () => new Date().toISOString();
  const today = () => M.today();
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const badge = (map, k) => ui.badge(k, tr((map[k] || [k])[0]), (map[k] || [])[1]);
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  registerDocs(M, 'cmp_item', 'cmp|Safety or licence item', { cmp_cert: 'cmp|Certificate or licence', cmp_report: 'cmp|Test or inspection report', cmp_photo: 'cmp|Photo', cmp_invoice: 'cmp|Invoice' });
  const docs = uploadRoute(router, h, '/compliance/files', { cmp_item: 'cmp_items' });
  (h.auditTyped = h.auditTyped || []).push('SELECT ref, title, provider, number, notes FROM cmp_items', 'SELECT by_name, cert_no, note FROM cmp_done');

  // the next due date after a test on `from`
  const after = (freq, from) => {
    const f = FREQ[freq] || FREQ.yearly;
    if (f[2]) return M.addDays(from, f[2]);
    if (f[1]) return M.addMonths(from, f[1]);
    return null;
  };
  const stateOf = (it, t = today()) => {
    if (!it.next_due) return 'none';
    const d = days(t, it.next_due);
    return d < 0 ? 'overdue' : d <= 7 ? 'week' : d <= (it.remind_days || 30) ? 'soon' : 'ok';
  };
  const itemBy = (id) => db.get('SELECT i.*, u.name owner_name, u.email owner_email FROM cmp_items i LEFT JOIN users u ON u.id = i.owner_id WHERE i.id = ?', id);
  const items = () => db.all('SELECT i.*, u.name owner_name FROM cmp_items i LEFT JOIN users u ON u.id = i.owner_id WHERE i.active = 1 ORDER BY i.next_due IS NULL, i.next_due, i.title');

  // record a test, inspection or renewal
  function recordDone(item, { done_on = today(), result = 'pass', by_name = null, cert_no = null, next_due = null, note = null, user = null, demo = 0 } = {}) {
    // a failed test stays due: it has to be done again
    const next = result === 'fail' ? item.next_due || done_on : next_due || after(item.freq, done_on) || item.next_due;
    return db.tx(() => {
      const id = Number(db.run('INSERT INTO cmp_done (item_id, done_on, result, by_name, cert_no, next_due, note, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        item.id, done_on, RESULT[result] ? result : 'pass', by_name, cert_no, next, note, user ? user.id : null, demo ? 1 : 0, now()).lastInsertRowid);
      if (result !== 'fail') db.run('UPDATE cmp_items SET last_done = ?, next_due = ?, alerted = NULL, updated_at = ? WHERE id = ?', done_on, next, now(), item.id);
      return id;
    });
  }

  // ---------- tenant insurance (read from the tenants' documents) ----------
  function insurance(t = today()) {
    const warn = Number(db.setting('cmp_ins_warn_days')) || 30;
    return db.all(`SELECT b.id, b.name, MIN(s.end_date) lease_end, GROUP_CONCAT(DISTINCT s.ref) leases FROM brands b JOIN leases s ON s.brand_id = b.id
      WHERE s.status = 'active' GROUP BY b.id ORDER BY b.name`).map((b) => {
      const doc = db.get("SELECT * FROM documents WHERE entity = 'brand' AND entity_id = ? AND kind = 'insurance' AND archived = 0 ORDER BY COALESCE(expires_on, '9999') DESC, created_at DESC LIMIT 1", b.id);
      const state = !doc ? 'missing' : !doc.expires_on ? 'nodate' : doc.expires_on < t ? 'expired' : days(t, doc.expires_on) <= warn ? 'soon' : 'ok';
      const last = db.get("SELECT r.*, u.name user_name FROM cmp_reminders r LEFT JOIN users u ON u.id = r.user_id WHERE r.brand_id = ? AND r.kind = 'insurance' ORDER BY r.at DESC LIMIT 1", b.id);
      return { ...b, doc, state, last };
    });
  }
  const REMIND = {
    missing: ['cmp|Please send your insurance certificate', 'cmp|We do not have a current insurance certificate for {brand} at The Wave. Please upload it in the tenant portal under Documents, or send it to the leasing office.'],
    expired: ['cmp|Your insurance certificate has expired', 'cmp|The insurance certificate we hold for {brand} expired on {date}. Please upload the renewed certificate in the tenant portal under Documents.'],
    soon: ['cmp|Your insurance certificate expires soon', 'cmp|The insurance certificate we hold for {brand} expires on {date}. Please upload the renewed certificate in the tenant portal under Documents before then.'],
    nodate: ['cmp|Please send your insurance certificate', 'cmp|We do not have a current insurance certificate for {brand} at The Wave. Please upload it in the tenant portal under Documents, or send it to the leasing office.'],
  };
  function remind(row, { user = null, demo = 0 } = {}) {
    const key = REMIND[row.state] ? row.state : 'missing';
    const notice = h.tenantNotify ? h.tenantNotify(row.id, {
      kind: 'insurance', title: REMIND[key][0], body: REMIND[key][1], params: { brand: row.name, date: row.doc && row.doc.expires_on ? row.doc.expires_on : '—' },
      rows: row.doc && row.doc.expires_on ? [['cmp|Expires', row.doc.expires_on]] : [], link: '/portal/documents', entity: 'brand', entity_id: row.id, demo,
    }) : null;
    db.run("INSERT INTO cmp_reminders (brand_id, kind, reason, notice_id, user_id, demo, at) VALUES (?, 'insurance', ?, ?, ?, ?, ?)", row.id, row.state, notice, user ? user.id : null, demo ? 1 : 0, now());
    return notice;
  }

  // ---------- alerts: due soon, due this week, overdue (each once per due date) ----------
  function alerts({ t = today() } = {}) {
    if (!h.mail) return 0;
    let sent = 0;
    const managers = db.all("SELECT * FROM users WHERE active = 1 AND email IS NOT NULL AND role IN ('admin','manager')");
    for (const it of db.all('SELECT * FROM cmp_items WHERE active = 1 AND next_due IS NOT NULL')) {
      const st = stateOf(it, t);
      if (!['soon', 'week', 'overdue'].includes(st)) continue;
      const mark = `${it.next_due}:${st}`;
      if (it.alerted === mark) continue;
      const owner = it.owner_id ? db.get('SELECT * FROM users WHERE id = ? AND active = 1', it.owner_id) : null;
      const to = [owner, ...managers].filter((u, i, a) => u && u.email && a.findIndex((x) => x && x.id === u.id) === i);
      for (const u of to) {
        const lang = u.lang === 'ar' ? 'ar' : 'en';
        const said = require('../i18n').run(lang, () => ({
          subject: tr(st === 'overdue' ? 'cmp|Overdue: {title}' : 'cmp|Due {date}: {title}', { title: it.title, date: ui.date(it.next_due) }),
          text: tr(st === 'overdue' ? 'cmp|{title} was due on {date} and has not been recorded as done. Record it in the office: {link}' : 'cmp|{title} is due on {date}. Record it in the office once done: {link}',
            { title: it.title, date: ui.date(it.next_due), link: `${String((h.env && h.env.SITE_URL) || '').replace(/\/$/, '')}/admin/compliance/items/${it.id}` }),
        }));
        h.mail.send({ to: u.email, subject: said.subject, text: said.text, lang, related: { entity: 'cmp_item', id: it.id }, demo: it.demo });
        sent++;
      }
      db.run('UPDATE cmp_items SET alerted = ? WHERE id = ?', mark, it.id);
    }
    return sent;
  }
  h.every('compliance-alerts', 6 * 60 * 60 * 1000, () => alerts(), { first: 4 * 60 * 1000 });
  h.compliance = { recordDone, after, stateOf, alerts, insurance, remind, CATS, FREQ };

  h.count('compliance', () => db.value('SELECT COUNT(*) FROM cmp_items WHERE active = 1 AND next_due IS NOT NULL AND next_due <= ?', M.addDays(today(), 7)));

  // ---------- the frame ----------
  const TABS = [['/admin/compliance', 'cmp|Register'], ['/admin/compliance/calendar', 'cmp|12-month calendar'], ['/admin/compliance/history', 'cmp|Done'], ['/admin/compliance/insurance', 'cmp|Tenant insurance']];
  const page = (req, res, { title, on, crumbs = [], body, actions = '' }) => h.page(req, res, {
    title, active: '/admin/compliance', wide: true, actions,
    crumbs: on === '/admin/compliance' && !crumbs.length ? undefined : [['/admin/compliance', tr('nav|Safety & licences')], ...crumbs],
    body: `<nav class="tabs">${TABS.map(([href, label]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${esc(tr(label))}</a>`).join('')}</nav>${body}`,
  });
  const dueTxt = (it) => (it.next_due ? `${esc(ui.date(it.next_due))}<small class="sub">${ui.rel(it.next_due)}</small>` : '—');
  const itemForm = (req, it = {}) => `<div class="fields">
    ${ui.select('category', tr('cmp|Kind'), tmap(CATS), it.category || 'fire_alarm')}
    ${ui.input('title', tr('cmp|What'), it.title || '', { required: true, placeholder: tr('cmp|e.g. Fire alarm system, quarterly test') })}
    ${ui.input('provider', tr('cmp|Done or issued by'), it.provider || '', { placeholder: tr('cmp|e.g. the civil defence, or the contractor') })}
    ${ui.input('number', tr('cmp|Certificate, licence or policy number'), it.number || '')}
    ${ui.select('freq', tr('cmp|How often'), Object.entries(FREQ).map(([k, v]) => [k, tr(v[0])]), it.freq || 'yearly')}
    ${ui.input('last_done', tr('cmp|Last done'), it.last_done || '', { type: 'date' })}
    ${ui.input('next_due', tr('cmp|Next due'), it.next_due || '', { type: 'date', hint: tr('cmp|Leave empty to count it from the last time.') })}
    ${ui.select('owner_id', tr('cmp|Responsible'), h.users().map((u) => [u.id, u.name]), it.owner_id || req.user.id, { blank: tr('cmp|Nobody') })}
    ${ui.input('remind_days', tr('cmp|Remind (days before)'), it.remind_days || 30, { type: 'number', min: 1, max: 180 })}
    ${ui.textarea('notes', tr('cmp|Notes'), it.notes || '', { rows: 2, cls: 'span-all' })}</div>`;
  const readItem = (b) => {
    const v = {
      category: CATS[b.category] ? b.category : 'other', title: h.str(b.title, 160), provider: h.str(b.provider, 160) || null, number: h.str(b.number, 80) || null,
      freq: FREQ[b.freq] ? b.freq : 'yearly', last_done: isDay(b.last_done) ? b.last_done : null, next_due: isDay(b.next_due) ? b.next_due : null,
      owner_id: h.int(b.owner_id) || null, remind_days: Math.max(1, Math.min(180, h.int(b.remind_days) || 30)), notes: h.str(b.notes, 2000) || null,
    };
    if (!v.next_due && v.last_done) v.next_due = after(v.freq, v.last_done);
    return v;
  };

  // ================= the register =================
  router.get('/compliance', (req, res) => {
    const t = today();
    const cat = CATS[req.query.cat] ? req.query.cat : '';
    const all = items();
    const list = cat ? all.filter((i) => i.category === cat) : all;
    const n = (s) => all.filter((i) => stateOf(i, t) === s).length;
    const ins = insurance(t);
    const insBad = ins.filter((x) => ['missing', 'expired'].includes(x.state)).length;
    const valid = all.filter((i) => ['ok', 'soon', 'week'].includes(stateOf(i, t))).length;
    const kpis = [
      ui.kpi({ label: tr('cmp|Overdue'), value: ui.n0(n('overdue')), tone: n('overdue') ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('cmp|Due in the next 30 days'), value: ui.n0(all.filter((i) => i.next_due && i.next_due >= t && i.next_due <= M.addDays(t, 30)).length), sub: esc(tr('cmp|{n} this week', { n: n('week') })) }),
      ui.kpi({ label: tr('cmp|In date'), value: ui.pct(all.length ? valid / all.length : null), bar: all.length ? valid / all.length : null, sub: esc(tr('cmp|{a} of {b} items', { a: valid, b: all.length })) }),
      ui.kpi({ label: tr('cmp|Tenant insurance missing or expired'), value: ui.n0(insBad), tone: insBad ? 'kpi--alert' : '', href: '/admin/compliance/insurance' }),
    ].join('');
    const table = ui.table([
      { label: tr('cmp|What'), sort: (i) => i.title, render: (i) => `<b>${esc(i.title)}</b><small class="sub">${esc([i.ref, tr(CATS[i.category] || i.category), i.provider].filter(Boolean).join(' · '))}</small>` },
      { label: tr('cmp|How often'), render: (i) => esc(tr((FREQ[i.freq] || FREQ.yearly)[0])) },
      { label: tr('cmp|Last done'), sort: (i) => i.last_done || '', render: (i) => esc(i.last_done ? ui.date(i.last_done) : '—') },
      { label: tr('cmp|Next due'), sort: (i) => i.next_due || '9999', render: dueTxt },
      { label: tr('cmp|Responsible'), render: (i) => esc(i.owner_name || '—') },
      { label: tr('Status'), sort: (i) => Object.keys(STATE).indexOf(stateOf(i, t)), render: (i) => badge(STATE, stateOf(i, t)) },
    ], list, { href: (i) => `/admin/compliance/items/${i.id}`, empty: esc(tr('cmp|Nothing in the register yet.')) });
    const filters = `<nav class="sec-chips"><a class="sec-chip${!cat ? ' is-on' : ''}" href="/admin/compliance">${esc(tr('All'))} <b>${all.length}</b></a>${Object.keys(CATS).filter((k) => all.some((i) => i.category === k)).map((k) => `<a class="sec-chip${cat === k ? ' is-on' : ''}" href="/admin/compliance?cat=${k}">${esc(tr(CATS[k]))} <b>${all.filter((i) => i.category === k).length}</b></a>`).join('')}</nav>`;
    const add = h.can(req, 'manager') ? `<details class="card cmp-add"><summary class="card__head"><h2>${esc(tr('cmp|Add to the register'))}</h2></summary><div class="card__body">${ui.form('/admin/compliance/items', req.session.csrf, `${itemForm(req)}${ui.btn(esc(tr('cmp|Add')), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' })}</div></details>` : '';
    page(req, res, { title: tr('nav|Safety & licences'), on: '/admin/compliance', body: `<div class="kpis kpis--4">${kpis}</div>${filters}${ui.card(tr('cmp|Register'), table, { sub: esc(tr('cmp|The responsible person and the managers get an email when an item comes due, a week before, and when it is overdue.')) })}${add}` });
  });
  router.post('/compliance/items', R('manager'), (req, res) => {
    const v = readItem(req.body);
    if (!v.title) return h.back(req, res, '/admin/compliance', 'error', tr('cmp|Say what it is.'));
    const t = now();
    const id = Number(db.run(`INSERT INTO cmp_items (ref, category, title, provider, number, freq, last_done, next_due, owner_id, remind_days, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, db.nextRef('cmp_items', 'SL', 3, false), v.category, v.title, v.provider, v.number, v.freq, v.last_done, v.next_due, v.owner_id, v.remind_days, v.notes, t, t).lastInsertRowid);
    h.log(req, 'Added a safety or licence item', 'cmp_item', id, v.title);
    h.back(req, res, `/admin/compliance/items/${id}`, 'ok', tr('cmp|Added. Upload the current certificate below.'));
  });
  router.get('/compliance/items/:id', (req, res, next) => {
    const it = itemBy(h.int(req.params.id));
    if (!it) return next();
    const csrf = req.session.csrf;
    const st = stateOf(it);
    const hist = db.all('SELECT d.*, u.name user_name FROM cmp_done d LEFT JOIN users u ON u.id = d.user_id WHERE d.item_id = ? ORDER BY d.done_on DESC, d.id DESC', it.id);
    const facts = `<dl class="dl"><div><dt>${esc(tr('cmp|Kind'))}</dt><dd>${esc(tr(CATS[it.category] || it.category))}</dd></div>${it.provider ? `<div><dt>${esc(tr('cmp|Done or issued by'))}</dt><dd>${esc(it.provider)}</dd></div>` : ''}${it.number ? `<div><dt>${esc(tr('cmp|Certificate, licence or policy number'))}</dt><dd class="ltr">${esc(it.number)}</dd></div>` : ''}
      <div><dt>${esc(tr('cmp|How often'))}</dt><dd>${esc(tr((FREQ[it.freq] || FREQ.yearly)[0]))}</dd></div><div><dt>${esc(tr('cmp|Last done'))}</dt><dd>${esc(it.last_done ? ui.date(it.last_done) : '—')}</dd></div>
      <div><dt>${esc(tr('cmp|Next due'))}</dt><dd>${dueTxt(it)}</dd></div><div><dt>${esc(tr('cmp|Responsible'))}</dt><dd>${esc(it.owner_name || '—')}</dd></div>${it.notes ? `<div><dt>${esc(tr('cmp|Notes'))}</dt><dd>${esc(it.notes)}</dd></div>` : ''}</dl>`;
    const table = ui.table([
      { label: tr('cmp|Done on'), render: (d) => esc(ui.date(d.done_on)) },
      { label: tr('cmp|Result'), render: (d) => badge(RESULT, d.result) },
      { label: tr('cmp|By'), render: (d) => `${esc(d.by_name || '—')}${d.cert_no ? `<small class="sub ltr">${esc(d.cert_no)}</small>` : ''}` },
      { label: tr('cmp|Next due'), render: (d) => esc(d.next_due ? ui.date(d.next_due) : '—') },
      { label: tr('cmp|Notes'), render: (d) => `${esc(d.note || '')}<small class="sub">${esc(d.user_name || '')}</small>` },
    ], hist, { empty: esc(tr('cmp|Not recorded yet.')) });
    const done = h.can(req, 'agent') ? ui.form(`/admin/compliance/items/${it.id}/done`, csrf, `<div class="fields">${ui.input('done_on', tr('cmp|Done on'), today(), { type: 'date', required: true })}${ui.select('result', tr('cmp|Result'), Object.entries(RESULT).map(([k, v]) => [k, tr(v[0])]), 'pass')}${ui.input('by_name', tr('cmp|By'), it.provider || '')}${ui.input('cert_no', tr('cmp|Certificate number'), '')}${ui.input('next_due', tr('cmp|Next due'), '', { type: 'date', hint: tr('cmp|Leave empty: {date}', { date: ui.date(after(it.freq, today()) || it.next_due || today()) }) })}${ui.textarea('note', tr('cmp|Notes'), '', { rows: 2, cls: 'span-all' })}</div>${ui.btn(esc(tr('cmp|Record as done')), { cls: 'btn--primary btn--sm', ic: 'check' })}<p class="muted small">${esc(tr('cmp|Then upload the certificate or report below.'))}</p>`, { cls: 'stack' }) : '';
    const edit = h.can(req, 'manager') ? `<details class="pad"><summary>${esc(tr('Edit'))}</summary>${ui.form(`/admin/compliance/items/${it.id}`, csrf, `${itemForm(req, it)}<label class="check"><input type="checkbox" name="active" value="1"${it.active ? ' checked' : ''}> ${esc(tr('cmp|Still required'))}</label>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    page(req, res, { title: it.title, on: '/admin/compliance', crumbs: [[null, it.ref]], body: `<div class="grid grid--side"><div class="stack">${ui.card(it.title, `${facts}${edit}`, { action: badge(STATE, st) })}${docs(req, 'cmp_item', it.id, { title: tr('cmp|Certificates and evidence') })}${ui.card(tr('cmp|History'), table)}</div><div class="stack">${done ? ui.card(tr('cmp|Record a test, inspection or renewal'), done) : ''}</div></div>` });
  });
  router.post('/compliance/items/:id', R('manager'), (req, res, next) => {
    const it = itemBy(h.int(req.params.id));
    if (!it) return next();
    const v = readItem(req.body);
    if (!v.title) return h.back(req, res, `/admin/compliance/items/${it.id}`, 'error', tr('cmp|Say what it is.'));
    db.run('UPDATE cmp_items SET category = ?, title = ?, provider = ?, number = ?, freq = ?, last_done = ?, next_due = ?, owner_id = ?, remind_days = ?, notes = ?, active = ?, alerted = CASE WHEN next_due IS ? THEN alerted ELSE NULL END, updated_at = ? WHERE id = ?',
      v.category, v.title, v.provider, v.number, v.freq, v.last_done, v.next_due, v.owner_id, v.remind_days, v.notes, req.body.active ? 1 : 0, v.next_due, now(), it.id);
    h.log(req, 'Changed a safety or licence item', 'cmp_item', it.id, v.title);
    h.back(req, res, `/admin/compliance/items/${it.id}`, 'ok', tr('Saved.'));
  });
  router.post('/compliance/items/:id/done', R('agent'), (req, res, next) => {
    const it = itemBy(h.int(req.params.id));
    if (!it) return next();
    const on = isDay(req.body.done_on) && req.body.done_on <= today() ? req.body.done_on : today();
    const result = RESULT[req.body.result] ? req.body.result : 'pass';
    recordDone(it, { done_on: on, result, by_name: h.str(req.body.by_name, 120) || null, cert_no: h.str(req.body.cert_no, 80) || null, next_due: isDay(req.body.next_due) ? req.body.next_due : null, note: h.str(req.body.note, 1000) || null, user: req.user });
    h.log(req, 'Recorded a safety test or renewal', 'cmp_item', it.id, `${it.title} · ${result}`);
    h.back(req, res, `/admin/compliance/items/${it.id}`, result === 'fail' ? 'error' : 'ok', result === 'fail' ? tr('cmp|Recorded as failed. It stays due until it passes.') : tr('cmp|Recorded. Next due {date}.', { date: ui.date(itemBy(it.id).next_due) }));
  });

  // ================= 12-month calendar =================
  router.get('/compliance/calendar', (req, res) => {
    const t = today();
    const start = `${t.slice(0, 7)}-01`;
    const months = Array.from({ length: 12 }, (_, i) => M.addMonths(start, i).slice(0, 7));
    const end = M.addMonths(start, 12);
    const all = items();
    // the due dates of each item over the next 12 months (repeating by its frequency)
    const dues = (it) => {
      const out = [];
      if (!it.next_due) return out;
      let d = it.next_due;
      for (let i = 0; i < 60 && d < end; i++) {
        out.push(d);
        const n = after(it.freq, d);
        if (!n || n <= d) break;
        d = n;
      }
      return out;
    };
    const head = `<tr><th>${esc(tr('cmp|What'))}</th>${months.map((m) => { const my = ui.monthYear(m); const sp = my.lastIndexOf(' '); return `<th class="cmp-m">${esc(my.slice(0, sp))}<small>${esc(my.slice(sp + 1))}</small></th>`; }).join('')}</tr>`;
    const rows = all.map((it) => {
      const ds = dues(it);
      const overdue = it.next_due && it.next_due < start;
      const cells = months.map((m, i) => {
        const here = ds.filter((d) => d.slice(0, 7) === m);
        const late = (i === 0 && overdue) || here.some((d) => d < t);
        return `<td class="cmp-cell">${here.length || (i === 0 && overdue) ? `<span class="cmp-dot${late ? ' is-late' : ''}" title="${esc(here.map((d) => ui.date(d)).join(', ') || ui.date(it.next_due))}">${esc(here.length ? here.map((d) => Number(d.slice(8, 10))).join('·') : '!')}</span>` : ''}</td>`;
      }).join('');
      return `<tr data-href="/admin/compliance/items/${it.id}" tabindex="0"><td><b>${esc(it.title)}</b><small class="sub">${esc(tr(CATS[it.category] || it.category))}</small></td>${cells}</tr>`;
    }).join('');
    const legend = `<p class="muted small pad"><span class="cmp-dot">12</span> ${esc(tr('cmp|due on that day'))} <span class="cmp-dot is-late">!</span> ${esc(tr('cmp|overdue'))}</p>`;
    page(req, res, { title: tr('cmp|12-month calendar'), on: '/admin/compliance/calendar', crumbs: [[null, tr('cmp|12-month calendar')]], body: ui.card(tr('cmp|The next 12 months'), all.length ? `<div class="tablewrap"><table class="table cmp-cal"><thead>${head}</thead><tbody>${rows}</tbody></table></div>${legend}` : `<p class="muted pad">${esc(tr('cmp|Nothing in the register yet.'))}</p>`) });
  });

  // ================= done (history) =================
  router.get('/compliance/history', (req, res) => {
    const from = M.addMonths(today(), -12);
    const rows = db.all('SELECT d.*, i.title, i.category, i.id item, u.name user_name FROM cmp_done d JOIN cmp_items i ON i.id = d.item_id LEFT JOIN users u ON u.id = d.user_id WHERE d.done_on >= ? ORDER BY d.done_on DESC, d.id DESC LIMIT 500', from);
    const byMonth = Array.from({ length: 12 }, (_, i) => M.addMonths(`${today().slice(0, 7)}-01`, i - 11).slice(0, 7)).map((m) => ({ m: ui.monthYear ? ui.monthYear(m) : m, n: rows.filter((r) => r.done_on.slice(0, 7) === m).length }));
    const table = ui.table([
      { label: tr('cmp|Done on'), sort: (d) => d.done_on, render: (d) => esc(ui.date(d.done_on)) },
      { label: tr('cmp|What'), render: (d) => `<b>${esc(d.title)}</b><small class="sub">${esc(tr(CATS[d.category] || d.category))}</small>` },
      { label: tr('cmp|Result'), render: (d) => badge(RESULT, d.result) },
      { label: tr('cmp|By'), render: (d) => `${esc(d.by_name || '—')}${d.cert_no ? `<small class="sub ltr">${esc(d.cert_no)}</small>` : ''}` },
      { label: tr('cmp|Recorded by'), render: (d) => esc(d.user_name || '—') },
    ], rows, { href: (d) => `/admin/compliance/items/${d.item}`, empty: esc(tr('cmp|Nothing done in the last 12 months.')) });
    page(req, res, { title: tr('cmp|Done'), on: '/admin/compliance/history', crumbs: [[null, tr('cmp|Done')]], body: `${ui.card(tr('cmp|Tests and renewals per month'), ui.bars(byMonth, { key: 'n', label: 'm', h: 130 }))}${ui.card(tr('cmp|The last 12 months'), table, { sub: esc(tn(rows.length, 'cmp|{n} test or renewal', 'cmp|{n} tests and renewals')) })}` });
  });

  // ================= tenant insurance =================
  router.get('/compliance/insurance', (req, res) => {
    const list = insurance();
    const st = INS[req.query.state] ? req.query.state : '';
    const rows = st ? list.filter((r) => r.state === st) : list;
    const csrf = req.session.csrf;
    const order = Object.keys(INS);
    const n = (s) => list.filter((r) => r.state === s).length;
    const kpis = order.slice(0, 4).map((s) => ui.kpi({ label: tr(INS[s][0]), value: ui.n0(n(s)), tone: ['missing', 'expired'].includes(s) && n(s) ? 'kpi--alert' : '', href: `/admin/compliance/insurance?state=${s}` })).join('');
    const table = ui.table([
      { label: tr('Tenant'), sort: (r) => r.name, render: (r) => `<a href="/admin/tenants/${r.id}"><b>${esc(r.name)}</b></a><small class="sub ltr">${esc(r.leases || '')}</small>` },
      { label: tr('cmp|Certificate'), render: (r) => (r.doc ? `<a href="/admin/documents/${r.doc.id}">${esc(r.doc.title)}</a>` : '—') },
      { label: tr('cmp|Expires'), sort: (r) => (r.doc && r.doc.expires_on) || '', render: (r) => (r.doc && r.doc.expires_on ? `${esc(ui.date(r.doc.expires_on))}<small class="sub">${ui.rel(r.doc.expires_on)}</small>` : '—') },
      { label: tr('Status'), sort: (r) => order.indexOf(r.state), render: (r) => badge(INS, r.state) },
      { label: tr('cmp|Last reminder'), render: (r) => { if (!r.last) return '—'; const seen = r.last.notice_id && h.noticeSeen ? h.noticeSeen(r.last.notice_id) : null; return `${esc(ui.dt(r.last.at))}${r.last.notice_id ? ` <a href="/admin/portal/notices/${r.last.notice_id}">${h.seenBadge ? h.seenBadge(seen && seen.seen) : ''}</a>` : ''}`; } },
      { label: '', render: (r) => (r.state !== 'ok' && h.can(req, 'agent') ? ui.form(`/admin/compliance/insurance/${r.id}/remind`, csrf, ui.btn(esc(tr('cmp|Remind')), { cls: 'btn--ghost btn--sm', ic: 'mail' })) : '') },
    ], rows, { empty: esc(tr('cmp|No tenants here.')) });
    const filters = `<nav class="sec-chips"><a class="sec-chip${!st ? ' is-on' : ''}" href="/admin/compliance/insurance">${esc(tr('All'))} <b>${list.length}</b></a>${order.filter((s) => n(s)).map((s) => `<a class="sec-chip${st === s ? ' is-on' : ''}" href="/admin/compliance/insurance?state=${s}">${esc(tr(INS[s][0]))} <b>${n(s)}</b></a>`).join('')}</nav>`;
    const bulkN = list.filter((r) => r.state !== 'ok').length;
    const bulk = h.can(req, 'agent') && bulkN ? ui.form('/admin/compliance/insurance/remind', csrf, ui.btn(esc(tn(bulkN, 'cmp|Remind {n} tenant', 'cmp|Remind {n} tenants')), { cls: 'btn--primary', ic: 'mail', attrs: { 'data-confirm': tr('cmp|Send a reminder to every tenant whose certificate is missing, expired or expiring?') } })) : '';
    page(req, res, { title: tr('cmp|Tenant insurance'), on: '/admin/compliance/insurance', crumbs: [[null, tr('cmp|Tenant insurance')]], actions: bulk, body: `<div class="kpis kpis--4">${kpis}</div>${filters}${ui.card(tr('cmp|Insurance certificates of tenants with an active lease'), table, { sub: esc(tr('cmp|From the documents on each tenant’s file (type: insurance policy). A reminder reaches the tenant in the portal and by email.')) })}` });
  });
  router.post('/compliance/insurance/remind', R('agent'), (req, res) => {
    const list = insurance().filter((r) => r.state !== 'ok');
    for (const r of list) remind(r, { user: req.user });
    h.log(req, 'Reminded tenants about insurance', 'brand', null, String(list.length));
    h.back(req, res, '/admin/compliance/insurance', 'ok', tn(list.length, 'cmp|{n} tenant reminded.', 'cmp|{n} tenants reminded.'));
  });
  router.post('/compliance/insurance/:id/remind', R('agent'), (req, res, next) => {
    const r = insurance().find((x) => x.id === h.int(req.params.id));
    if (!r) return next();
    remind(r, { user: req.user });
    h.log(req, 'Reminded a tenant about insurance', 'brand', r.id, r.name);
    h.back(req, res, h.safeBack(req, '/admin/compliance/insurance'), 'ok', tr('cmp|{name} reminded.', { name: r.name }));
  });

  // the tenant's page shows the insurance state
  (h.tenantCards = h.tenantCards || []).push((req, b) => {
    const r = insurance().find((x) => x.id === b.id);
    if (!r || r.state === 'ok') return '';
    return ui.card(tr('cmp|Insurance certificate'), `<p class="pad">${badge(INS, r.state)} ${r.doc && r.doc.expires_on ? esc(ui.date(r.doc.expires_on)) : ''}</p>${h.can(req, 'agent') ? `<div class="pad">${ui.form(`/admin/compliance/insurance/${r.id}/remind`, req.session.csrf, ui.btn(esc(tr('cmp|Remind')), { cls: 'btn--ghost btn--sm', ic: 'mail' }))}</div>` : ''}`);
  });
};

module.exports.SCHEMA = SCHEMA;
module.exports.CATS = CATS;
module.exports.FREQ = FREQ;
