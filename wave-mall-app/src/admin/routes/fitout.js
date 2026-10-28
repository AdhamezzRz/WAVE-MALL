'use strict';

// Fit-out: every signed shop's road from design brief to opening day.
// One project per lease (draft or active). Design submissions go through review rounds with a
// review deadline (the mall's SLA); contractors, their insurance and work permits are tracked; the
// fit-out deposit is billed through the billing service and refunded on completion; handover and
// opening checklists come from editable templates. The timeline shows every shop at once.
// Tenants follow and submit through the tenant portal when it is there (h.portal).
//
// Events: fitout.stage { project, from, to, user }   fitout.deposit_refunded { project, amount, date, invoice }

const express = require('express');
const { t: tr, tn, tx, isAr } = require('../i18n');

const STAGES = ['kickoff', 'concept', 'review', 'detailed', 'approved', 'contractor', 'deposit', 'handover', 'works', 'inspection', 'completion', 'open'];
const STAGE_LABEL = {
  kickoff: 'fit|Kick-off & design brief', concept: 'fit|Concept design', review: 'fit|Mall review', detailed: 'fit|Detailed design & MEP',
  approved: 'fit|Design approved', contractor: 'fit|Contractor & insurance', deposit: 'fit|Fit-out deposit', handover: 'fit|Site handover',
  works: 'fit|Works on site', inspection: 'fit|Snagging & inspections', completion: 'fit|Completion certificate', open: 'fit|Open for trade',
};
const STAGE_SHORT = {
  kickoff: 'fit|Brief', concept: 'fit|Concept', review: 'fit|Review', detailed: 'fit|Detailed', approved: 'fit|Approved', contractor: 'fit|Contractor',
  deposit: 'fit|Deposit', handover: 'fit|Handover', works: 'fit|Works', inspection: 'fit|Inspections', completion: 'fit|Completion', open: 'fit|Open',
};
const ROUND_KINDS = { concept: 'fit|Concept design', detailed: 'fit|Detailed design', mep: 'fit|MEP drawings', signage: 'fit|Signage & shopfront', other: 'fit|Other submission' };
const DECISIONS = { in_review: 'fit|In review', approved: 'fit|Approved', approved_comments: 'fit|Approved with comments', rejected: 'fit|Revise and resubmit' };
const DECISION_TONE = { in_review: 'amber', approved: 'ok', approved_comments: 'sea', rejected: 'rose' };
const PERMIT_TYPES = { work: 'fit|Work permit', hot_works: 'fit|Hot works permit', after_hours: 'fit|After-hours works', delivery: 'fit|Delivery & loading' };
const PERMIT_STATUS = { requested: 'fit|Requested', approved: 'fit|permit|Approved', rejected: 'fit|permit|Refused', closed: 'fit|Closed' };
const PERMIT_TONE = { requested: 'amber', approved: 'ok', rejected: 'rose', closed: 'mute' };
const tmap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tr(v)]));
// the English of a 'fit|…' label, for text the system stores (the audit log, document notes)
const en = (key) => String(key).slice(String(key).indexOf('|') + 1).replace(/^permit\|/, '');
const idx = (s) => STAGES.indexOf(s);
const DESIGN = ['kickoff', 'concept', 'review', 'detailed'];
const SITE = ['handover', 'works', 'inspection', 'completion'];

// Checklist templates (stored in English, one item per line; shown through tx()).
const DEFAULT_HANDOVER = [
  'Approved drawings on file',
  'Contractor insurance (CAR) valid',
  'Fit-out deposit received',
  'Unit inspected with tenant; photos taken',
  'Meter readings recorded (power, water, chilled water)',
  'Keys and access cards issued',
  'Hoarding and signage approved',
];
const DEFAULT_OPENING = [
  'Completion certificate issued',
  'Civil defence (fire) approval',
  'MEP testing and commissioning signed off',
  'Signage installed as approved',
  'Store insurance policy on file',
  'Staff briefed on mall rules and security',
  'Opening date confirmed with marketing',
];

const SCHEMA = `
  CREATE TABLE fitout_projects (
    id INTEGER PRIMARY KEY, lease_id INTEGER NOT NULL UNIQUE REFERENCES leases(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, stage TEXT NOT NULL DEFAULT 'kickoff', stage_at TEXT NOT NULL,
    planned_handover TEXT, planned_opening TEXT, actual_handover TEXT, actual_opening TEXT, approved_at TEXT,
    review_days INTEGER, manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    deposit_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, deposit_refund REAL, deposit_refunded_at TEXT, deposit_refund_note TEXT,
    notes TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE fitout_rounds (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES fitout_projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'concept', round_no INTEGER NOT NULL DEFAULT 1, note TEXT,
    submitted_on TEXT NOT NULL, submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL, via TEXT NOT NULL DEFAULT 'office',
    due_on TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_review', reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_on TEXT, comments TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX fitout_rounds_project ON fitout_rounds(project_id);
  CREATE TABLE fitout_round_docs (round_id INTEGER NOT NULL REFERENCES fitout_rounds(id) ON DELETE CASCADE, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, PRIMARY KEY (round_id, document_id));
  CREATE TABLE fitout_contractors (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES fitout_projects(id) ON DELETE CASCADE,
    company TEXT NOT NULL, contact_name TEXT, phone TEXT, email TEXT, insurance_policy TEXT, insurance_expiry TEXT, notes TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE fitout_permits (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES fitout_projects(id) ON DELETE CASCADE,
    contractor_id INTEGER REFERENCES fitout_contractors(id) ON DELETE SET NULL, type TEXT NOT NULL DEFAULT 'work',
    from_on TEXT NOT NULL, to_on TEXT NOT NULL, hours TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'requested',
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_at TEXT, via TEXT NOT NULL DEFAULT 'office',
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE fitout_checks (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES fitout_projects(id) ON DELETE CASCADE,
    list TEXT NOT NULL, label TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, done_at TEXT, done_by TEXT
  );
  CREATE INDEX fitout_checks_project ON fitout_checks(project_id, list);
`;

module.exports = function fitout(router, h) {
  const { db, ui, M } = h;
  const R = h.R;
  db.ensure('fitout-1', SCHEMA);
  // fit-out paperwork is filed on the lease
  for (const k of ['fitout_drawings', 'permit', 'insurance']) if (!M.DOC_GROUPS.lease.includes(k)) M.DOC_GROUPS.lease.splice(M.DOC_GROUPS.lease.length - 1, 0, k);

  const reviewDays = () => Math.max(1, Number(db.setting('fitout_review_days')) || 7);
  const template = (list) => {
    const raw = db.setting(list === 'handover' ? 'fitout_handover_items' : 'fitout_opening_items');
    const items = String(raw || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return items.length ? items : list === 'handover' ? DEFAULT_HANDOVER : DEFAULT_OPENING;
  };
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const stageLabel = (s) => tr(STAGE_LABEL[s] || s);
  const stageBadge = (s) => ui.badge(s, stageLabel(s), s === 'open' ? 'ok' : idx(s) >= idx('handover') ? 'cocoa' : idx(s) >= idx('approved') ? 'sky' : 'sand');

  // ---------- the projects ----------
  const SELECT = `SELECT p.*, s.ref lease_ref, s.status lease_status, s.start_date lease_start, b.name brand_name, b.category, u.name manager_name,
      (SELECT COUNT(*) FROM fitout_rounds r WHERE r.project_id = p.id AND r.status = 'in_review') in_review,
      (SELECT MIN(r.due_on) FROM fitout_rounds r WHERE r.project_id = p.id AND r.status = 'in_review') review_due
    FROM fitout_projects p JOIN leases s ON s.id = p.lease_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN users u ON u.id = p.manager_id`;
  const projectOf = (id) => db.get(`${SELECT} WHERE p.id = ?`, id);
  const units = (p) => M.leaseUnits(db, p.lease_id);

  // Every draft or active lease gets a project; dates follow the lease (fit-out before rent starts).
  function ensureProjects() {
    const missing = db.all("SELECT s.* FROM leases s WHERE s.status IN ('draft','active') AND NOT EXISTS (SELECT 1 FROM fitout_projects p WHERE p.lease_id = s.id)");
    for (const s of missing) create(s);
  }
  function create(s, { demo = 0 } = {}) {
    const months = s.offer_id ? db.value('SELECT fitout_months FROM offers WHERE id = ?', s.offer_id) : null;
    const opening = s.start_date;
    const handover = M.addMonths(opening, -(Number(months) > 0 ? Number(months) : 2));
    const t = M.now();
    return db.tx(() => {
      const id = Number(db.run(
        'INSERT INTO fitout_projects (lease_id, brand_id, stage, stage_at, planned_handover, planned_opening, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        s.id, s.brand_id, 'kickoff', t, handover, opening, demo ? 1 : 0, t, t,
      ).lastInsertRowid);
      for (const list of ['handover', 'opening']) template(list).forEach((label, i) => db.run('INSERT INTO fitout_checks (project_id, list, label, sort) VALUES (?, ?, ?, ?)', id, list, label, i));
      db.audit(null, 'Fit-out project opened', 'fitout', id, s.ref);
      return id;
    });
  }

  function setStage(p, stage, { user = null, via = 'office' } = {}) {
    if (!STAGES.includes(stage) || p.stage === stage) return false;
    const t = M.today();
    const sets = ['stage = ?', 'stage_at = ?', 'updated_at = ?'];
    const args = [stage, M.now(), M.now()];
    if (stage === 'approved' && !p.approved_at) { sets.push('approved_at = ?'); args.push(t); }
    if (idx(stage) >= idx('handover') && !p.actual_handover) { sets.push('actual_handover = ?'); args.push(t); }
    if (stage === 'open' && !p.actual_opening) { sets.push('actual_opening = ?'); args.push(t); }
    db.run(`UPDATE fitout_projects SET ${sets.join(', ')} WHERE id = ?`, ...args, p.id);
    if (stage === 'open' && p.brand_id) db.run('UPDATE brands SET opening_date = COALESCE(opening_date, ?) WHERE id = ?', p.actual_opening || t, p.brand_id);
    db.audit(user, 'Fit-out stage changed', 'fitout', p.id, `Stage: ${en(STAGE_SHORT[p.stage])} → ${en(STAGE_SHORT[stage])}`);
    h.events.emit('fitout.stage', { project: projectOf(p.id), from: p.stage, to: stage, user });
    return true;
  }

  function addRound(p, { kind, note, via = 'office', user = null, submitted_on = null, demo = 0 }) {
    const k = ROUND_KINDS[kind] ? kind : 'concept';
    const on = date(submitted_on) || M.today();
    const no = db.value('SELECT COUNT(*) FROM fitout_rounds WHERE project_id = ? AND kind = ?', p.id, k) + 1;
    const id = Number(db.run(
      'INSERT INTO fitout_rounds (project_id, kind, round_no, note, submitted_on, submitted_by, via, due_on, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      p.id, k, no, note || null, on, user ? user.id : null, via, M.addDays(on, p.review_days || reviewDays()), demo ? 1 : 0, M.now(),
    ).lastInsertRowid);
    if (idx(p.stage) < idx('approved')) setStage(p, 'review', { user, via });
    db.audit(user, via === 'portal' ? 'Design submitted through the tenant portal' : 'Design submitted', 'fitout', p.id, `${en(ROUND_KINDS[k])}, round ${no}`);
    notify(p, 'submitted', { kind: k, no });
    return id;
  }

  function decide(round, status, comments, user) {
    const p = projectOf(round.project_id);
    db.run('UPDATE fitout_rounds SET status = ?, comments = ?, reviewer_id = ?, decided_on = ? WHERE id = ?', status, comments || null, user ? user.id : null, M.today(), round.id);
    if (status === 'rejected') {
      if (idx(p.stage) <= idx('approved')) setStage(p, round.kind === 'concept' ? 'concept' : 'detailed', { user });
    } else if (round.kind === 'concept' && idx(p.stage) < idx('detailed')) setStage(p, 'detailed', { user });
    else if (['detailed', 'mep'].includes(round.kind) && idx(p.stage) < idx('approved')) setStage(projectOf(p.id), 'approved', { user });
    db.audit(user, 'Design reviewed', 'fitout', p.id, `${en(ROUND_KINDS[round.kind])}, round ${round.round_no}: ${en(DECISIONS[status])}`);
    notify(p, 'decided', { kind: round.kind, no: round.round_no, status, comments });
  }

  // Emails the tenant's main contact and the project manager, when the office can send mail.
  function notify(p, what, info) {
    if (!h.mail || typeof h.mail.send !== 'function') return;
    try {
      const contact = db.get('SELECT name, email FROM contacts WHERE brand_id = ? AND email IS NOT NULL ORDER BY primary_contact DESC, id LIMIT 1', p.brand_id);
      const manager = p.manager_id ? db.get('SELECT name, email FROM users WHERE id = ?', p.manager_id) : null;
      const kind = en(ROUND_KINDS[info.kind] || 'fit|Submission');
      const lines = what === 'submitted'
        ? { subject: `Fit-out submission received: ${p.brand_name} (${kind}, round ${info.no})`, text: `We have received the ${kind.toLowerCase()} submission (round ${info.no}) for ${p.brand_name}, ${p.lease_ref}. The mall will review it within ${p.review_days || reviewDays()} days.` }
        : { subject: `Fit-out review: ${p.brand_name} (${kind}, round ${info.no}) ${en(DECISIONS[info.status]).toLowerCase()}`, text: `The ${kind.toLowerCase()} submission (round ${info.no}) for ${p.brand_name} has been reviewed: ${en(DECISIONS[info.status])}.${info.comments ? `\n\nComments:\n${info.comments}` : ''}` };
      // the tenant hears about reviews (its main contact and portal users); the office about submissions
      let portalUsers = [];
      try {
        portalUsers = what === 'decided' ? db.all('SELECT email FROM portal_users WHERE brand_id = ? AND active = 1', p.brand_id).map((u) => u.email) : [];
      } catch {
        portalUsers = []; // no tenant portal
      }
      const office = manager ? [manager.email] : db.all("SELECT email FROM users WHERE active = 1 AND role IN ('admin','manager') AND email IS NOT NULL").map((u) => u.email);
      const to = what === 'decided' ? [contact ? contact.email : null, ...portalUsers] : office;
      for (const addr of [...new Set(to.filter(Boolean))]) {
        const r = h.mail.send({ to: addr, subject: lines.subject, text: lines.text, related: { entity: 'fitout', id: p.id } });
        if (r && r.done && typeof r.done.catch === 'function') r.done.catch(() => {});
      }
    } catch (err) {
      console.error('[fitout] notify failed:', err.message);
    }
  }

  // ---------- facts about a project ----------
  function facts(p) {
    const t = M.today();
    const inv = p.deposit_invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', p.deposit_invoice_id) : null;
    const checks = db.all('SELECT * FROM fitout_checks WHERE project_id = ? ORDER BY list, sort, id', p.id);
    const done = (list) => checks.filter((c) => c.list === list && c.done_at).length;
    const all = (list) => checks.filter((c) => c.list === list).length;
    const late = p.stage !== 'open' && p.planned_opening && p.planned_opening < t;
    const overdueReview = p.review_due && p.review_due < t;
    return {
      deposit: inv && inv.status !== 'void' ? inv : null,
      handover: { done: done('handover'), total: all('handover') },
      opening: { done: done('opening'), total: all('opening') },
      progress: idx(p.stage) / (STAGES.length - 1),
      late, overdueReview,
    };
  }
  const nextMilestone = (p) => {
    if (p.stage === 'open') return { label: tr('fit|Opened'), date: p.actual_opening };
    if (idx(p.stage) < idx('handover')) return { label: tr('fit|Site handover'), date: p.planned_handover };
    return { label: tr('fit|Opening'), date: p.planned_opening };
  };

  h.count('fitout', () => db.value("SELECT COUNT(*) FROM fitout_rounds WHERE status = 'in_review' AND due_on < ?", M.today()) + db.value("SELECT COUNT(*) FROM fitout_permits WHERE status = 'requested'"));

  // ---------- the timeline ----------
  function gantt(list) {
    if (!list.length) return ui.empty(tr('fit|No fit-out projects yet. They start when a lease is drafted.'));
    const t = M.today();
    const dates = list.flatMap((p) => [p.created_at.slice(0, 10), p.planned_handover, p.planned_opening, p.actual_handover, p.actual_opening]).filter(Boolean).sort();
    let from = M.addDays(dates[0], -10);
    let to = M.addDays(dates[dates.length - 1], 20);
    if (t < from) from = M.addDays(t, -10);
    if (t > to) to = M.addDays(t, 20);
    if (M.daysBetween(from, to) < 120) to = M.addDays(from, 120);
    from = `${from.slice(0, 7)}-01`;
    const span = M.daysBetween(from, to);
    const pos = (d) => Math.max(0, Math.min(100, (M.daysBetween(from, d) / span) * 100));
    const months = [];
    for (let m = from; m <= to; m = M.addMonths(m, 1)) months.push(m);
    const head = months.map((m) => `<span style="inset-inline-start:${pos(m).toFixed(2)}%">${ui.esc(ui.monthName(Number(m.slice(5, 7))))}${m.slice(5, 7) === '01' || m === months[0] ? ` ${m.slice(2, 4)}` : ''}</span>`).join('');
    const bar = (a, b, cls, title) => (a && b && b >= a ? `<i class="gantt__bar ${cls}" style="inset-inline-start:${pos(a).toFixed(2)}%;width:${Math.max(0.6, pos(b) - pos(a)).toFixed(2)}%" title="${ui.esc(title)}"></i>` : '');
    const rows = list.map((p) => {
      const f = facts(p);
      const start = p.created_at.slice(0, 10);
      const designEnd = p.approved_at || (idx(p.stage) < idx('approved') ? (t > p.planned_handover ? t : p.planned_handover) : p.planned_handover);
      const siteStart = p.actual_handover || p.planned_handover;
      const siteEnd = p.actual_opening || (p.stage !== 'open' && t > p.planned_opening && idx(p.stage) >= idx('handover') ? t : p.planned_opening);
      return `<a class="gantt__row${f.late ? ' is-late' : ''}" href="/admin/fitout/${p.id}">
        <span class="gantt__name"><b>${ui.esc(p.brand_name || p.lease_ref)}</b><small>${stageLabel(p.stage)}</small></span>
        <span class="gantt__track">
          ${bar(start, designEnd, 'gantt__bar--design', tr('fit|Design'))}
          ${bar(p.planned_handover, p.planned_opening, 'gantt__bar--plan', tr('fit|Planned works'))}
          ${idx(p.stage) >= idx('handover') ? bar(siteStart, siteEnd, `gantt__bar--site${f.late ? ' is-late' : ''}`, tr('fit|Works on site')) : ''}
          ${p.planned_opening ? `<i class="gantt__flag${p.stage === 'open' ? ' is-open' : ''}" style="inset-inline-start:${pos(p.actual_opening || p.planned_opening).toFixed(2)}%" title="${ui.esc(tr('fit|Opening'))} · ${ui.esc(ui.date(p.actual_opening || p.planned_opening))}"></i>` : ''}
        </span></a>`;
    }).join('');
    const today = t >= from && t <= to ? `<i class="gantt__today" style="inset-inline-start:${pos(t).toFixed(2)}%"><b>${ui.esc(tr('fit|Today'))}</b></i>` : '';
    return `<div class="gantt"><div class="gantt__head"><span class="gantt__name"></span><span class="gantt__track gantt__months">${head}</span></div>
      <div class="gantt__body"><div class="gantt__grid"><span class="gantt__name"></span><span class="gantt__track">${months.map((m) => `<i style="inset-inline-start:${pos(m).toFixed(2)}%"></i>`).join('')}${today}</span></div>${rows}</div>
      <ul class="legend legend--row"><li><i class="gantt-key gantt-key--design"></i><span>${tr('fit|Design')}</span></li><li><i class="gantt-key gantt-key--plan"></i><span>${tr('fit|Planned works')}</span></li><li><i class="gantt-key gantt-key--site"></i><span>${tr('fit|Works on site')}</span></li><li><i class="gantt-key gantt-key--late"></i><span>${tr('fit|Opening overdue')}</span></li></ul></div>`;
  }

  // ---------- list ----------
  router.get('/fitout', (req, res) => {
    ensureProjects();
    const t = M.today();
    const view = ['all', 'design', 'site', 'open', 'attention'].includes(req.query.view) ? req.query.view : 'all';
    const all = db.all(`${SELECT} WHERE s.status IN ('draft','active') OR p.stage = 'open' ORDER BY COALESCE(p.actual_opening, p.planned_opening), b.name`);
    const withF = all.map((p) => ({ ...p, f: facts(p) }));
    const pick = {
      all: () => withF,
      design: () => withF.filter((p) => idx(p.stage) < idx('handover')),
      site: () => withF.filter((p) => SITE.includes(p.stage)),
      open: () => withF.filter((p) => p.stage === 'open'),
      attention: () => withF.filter((p) => p.f.late || p.f.overdueReview),
    }[view]();
    const overdueReviews = db.value("SELECT COUNT(*) FROM fitout_rounds r JOIN fitout_projects p ON p.id = r.project_id WHERE r.status = 'in_review' AND r.due_on < ?", t);
    const kpis = [
      ui.kpi({ label: tr('fit|In design'), value: String(withF.filter((p) => idx(p.stage) < idx('approved')).length), href: '/admin/fitout?view=design' }),
      ui.kpi({ label: tr('fit|Awaiting review'), value: String(db.value("SELECT COUNT(*) FROM fitout_rounds WHERE status = 'in_review'")), sub: overdueReviews ? tr('fit|{n} past the review deadline', { n: overdueReviews }) : tr('fit|All within the review deadline'), tone: overdueReviews ? 'kpi--alert' : '', href: '/admin/fitout?view=attention' }),
      ui.kpi({ label: tr('fit|On site'), value: String(withF.filter((p) => SITE.includes(p.stage)).length), href: '/admin/fitout?view=site' }),
      ui.kpi({ label: tr('fit|Opening in 30 days'), value: String(withF.filter((p) => p.stage !== 'open' && p.planned_opening && p.planned_opening >= t && p.planned_opening <= M.addDays(t, 30)).length) }),
      ui.kpi({ label: tr('fit|Opened'), value: String(withF.filter((p) => p.stage === 'open').length), href: '/admin/fitout?view=open' }),
    ].join('');
    const tabs = [['all', tr('All')], ['design', tr('fit|Design')], ['site', tr('fit|On site')], ['open', tr('fit|Opened')], ['attention', tr('fit|Needs attention')]]
      .map(([k, l]) => `<a class="tab${view === k ? ' is-on' : ''}" href="/admin/fitout?view=${k}">${l}</a>`).join('');
    const table = ui.table(
      [
        { label: tr('Tenant'), render: (p) => `<b>${ui.esc(p.brand_name || '')}</b><small class="sub">${ui.esc(p.lease_ref)} · ${ui.esc(units(p).map((u) => u.code).join(', '))}</small>` },
        { label: tr('Stage'), render: (p) => `${stageBadge(p.stage)}<span class="fit-progress">${ui.meter(p.f.progress, p.f.late ? 'rose' : 'forest')}</span>` },
        { label: tr('fit|Review'), render: (p) => (p.in_review ? `<span class="${p.f.overdueReview ? 'late' : ''}">${tr('fit|Due {when}', { when: ui.rel(p.review_due) })}</span>` : '<span class="muted">—</span>') },
        { label: tr('fit|Handover'), render: (p) => ui.date(p.actual_handover || p.planned_handover) },
        { label: tr('fit|Opening'), render: (p) => `<span class="${p.f.late ? 'late' : ''}">${ui.date(p.actual_opening || p.planned_opening)}</span><small class="sub">${p.stage === 'open' ? tr('fit|Opened') : ui.rel(p.planned_opening)}</small>` },
        { label: tr('fit|Deposit'), render: (p) => (p.f.deposit ? ui.badge(p.f.deposit.status, M.INVOICE_STATUS[p.f.deposit.status]) : '<span class="muted">—</span>') },
      ],
      pick,
      { empty: tr('fit|Nothing here.'), href: (p) => `/admin/fitout/${p.id}` },
    );
    const body = `<div class="kpis kpis--5">${kpis}</div>
${ui.card(tr('fit|Timeline'), gantt(withF.filter((p) => view === 'all' || pick.includes(p))), { sub: tr('fit|Design, handover and works for every shop, against today'), cls: 'fit-gantt' })}
<nav class="tabs">${tabs}</nav>
${ui.card(tn(pick.length, 'fit|{n} project', 'fit|{n} projects'), table)}`;
    h.page(req, res, {
      title: tr('nav|Fit-out'), active: '/admin/fitout', wide: true, body,
      actions: h.can(req, 'manager') ? ui.btn(tr('Settings'), { href: '/admin/fitout/settings', cls: 'btn--ghost', ic: 'gear' }) : '',
    });
  });

  // ---------- settings: review deadline and checklist templates ----------
  router.get('/fitout/settings', R('manager'), (req, res) => {
    const body = ui.card(tr('fit|Fit-out settings'), ui.form('/admin/fitout/settings', req.session.csrf, `<div class="fields">
      ${ui.input('review_days', tr('fit|Mall review deadline (days)'), reviewDays(), { type: 'number', min: 1, max: 60, step: 1, hint: tr('fit|How long the mall has to review a design submission.') })}
    </div>
    <div class="fields">
      ${ui.textarea('handover', tr('fit|Handover checklist'), template('handover').join('\n'), { rows: 8 })}
      ${ui.textarea('opening', tr('fit|Opening checklist'), template('opening').join('\n'), { rows: 8 })}
    </div>
    <p class="muted small">${tr('fit|One item per line. New projects start with these lists; existing projects keep theirs.')}</p>
    ${ui.btn(tr('Save'), { cls: 'btn--primary' })}`, { cls: 'stack' }));
    h.page(req, res, { title: tr('fit|Fit-out settings'), crumbs: [['/admin/fitout', tr('nav|Fit-out')], [null, tr('Settings')]], active: '/admin/fitout', body });
  });
  router.post('/fitout/settings', R('manager'), (req, res) => {
    const days = h.int(req.body.review_days);
    if (days && days >= 1 && days <= 60) db.setSetting('fitout_review_days', days);
    for (const list of ['handover', 'opening']) {
      const lines = String(req.body[list] || '').split('\n').map((s) => h.str(s, 160)).filter(Boolean).slice(0, 40);
      db.setSetting(list === 'handover' ? 'fitout_handover_items' : 'fitout_opening_items', lines.join('\n'));
    }
    h.log(req, 'Changed fit-out settings', 'settings', null, null);
    h.back(req, res, '/admin/fitout/settings', 'ok', tr('Saved.'));
  });

  // ---------- one project ----------
  router.get('/fitout/:id', (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    const t = M.today();
    const csrf = req.session.csrf;
    const f = facts(p);
    const mgr = h.can(req, 'manager');
    const agent = h.can(req, 'agent');
    const us = units(p);
    const stepper = `<ol class="stepper stepper--fit">${STAGES.map((s, i) => {
      const state = i < idx(p.stage) ? 'is-past' : s === p.stage ? 'is-on' : '';
      const inner = `<span class="stepper__dot"></span><span class="stepper__l">${ui.esc(tr(STAGE_SHORT[s]))}</span>`;
      return `<li class="${state}" title="${ui.esc(stageLabel(s))}">${mgr && s !== p.stage ? ui.form(`/admin/fitout/${p.id}/stage`, csrf, `<input type="hidden" name="stage" value="${s}"><button type="submit">${inner}</button>`) : `<span>${inner}</span>`}</li>`;
    }).join('')}</ol>`;
    const nm = nextMilestone(p);
    const head = `<div class="leadhead"><div class="leadhead__stats">
      <div><small>${tr('Stage')}</small><b>${ui.esc(stageLabel(p.stage))}</b></div>
      <div><small>${ui.esc(nm.label)}</small><b class="${f.late ? 'late' : ''}">${ui.date(nm.date)}</b></div>
      <div><small>${tr('fit|Review')}</small><b class="${f.overdueReview ? 'late' : ''}">${p.in_review ? tr('fit|Due {when}', { when: ui.rel(p.review_due) }) : '—'}</b></div>
      <div><small>${tr('fit|Deposit')}</small><b>${f.deposit ? ui.money(f.deposit.total, { compact: true }) : '—'}</b></div>
      <div><small>${tr('fit|Handover checklist')}</small><b>${f.handover.done}/${f.handover.total}</b></div>
      <div><small>${tr('fit|Opening checklist')}</small><b>${f.opening.done}/${f.opening.total}</b></div>
    </div>${stepper}</div>`;

    // submissions
    const rounds = db.all('SELECT r.*, u.name by_name, v.name reviewer_name FROM fitout_rounds r LEFT JOIN users u ON u.id = r.submitted_by LEFT JOIN users v ON v.id = r.reviewer_id WHERE r.project_id = ? ORDER BY r.submitted_on DESC, r.id DESC', p.id);
    const docsOf = (r) => db.all('SELECT d.id, d.title, d.mime, d.size FROM fitout_round_docs x JOIN documents d ON d.id = x.document_id WHERE x.round_id = ? ORDER BY d.id', r.id);
    const roundHtml = rounds.map((r) => {
      const docs = docsOf(r);
      const late = r.status === 'in_review' && r.due_on < t;
      const upload = agent && r.status === 'in_review'
        ? `<form class="upload upload--inline" data-upload="/admin/fitout/rounds/${r.id}/upload?x=1" novalidate><label class="drop drop--sm"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,application/pdf,image/*">${ui.icon('upload')}<span data-drop-label>${tr('fit|Add drawings to this round')}</span><i class="drop__bar" hidden><b></b></i></label><p class="upload__msg" data-upload-msg hidden></p></form>`
        : '';
      const decideForm = mgr && r.status === 'in_review'
        ? `<details class="pop pop--inline"><summary class="btn btn--primary btn--sm">${tr('fit|Record the review')}</summary>${ui.form(`/admin/fitout/rounds/${r.id}/decide`, csrf, `${ui.select('status', tr('fit|Decision'), { approved: tr(DECISIONS.approved), approved_comments: tr(DECISIONS.approved_comments), rejected: tr(DECISIONS.rejected) }, 'approved')}${ui.textarea('comments', tr('fit|Comments for the tenant'), '', { rows: 4, placeholder: tr('fit|e.g. Raise the bulkhead to 3.2 m; signage letters max 600 mm') })}${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>`
        : '';
      return `<li class="fround fround--${r.status}${late ? ' is-late' : ''}">
        <div class="fround__head"><b>${ui.esc(tr(ROUND_KINDS[r.kind]))} · ${tr('fit|round {n}', { n: r.round_no })}</b>${ui.badge(r.status, tr(DECISIONS[r.status]), DECISION_TONE[r.status])}</div>
        <p class="fround__meta">${tr('fit|Submitted {date}', { date: ui.date(r.submitted_on) })}${r.via === 'portal' ? ` · ${tr('fit|via the tenant portal')}` : r.by_name ? ` · ${ui.esc(r.by_name)}` : ''}${r.status === 'in_review' ? ` · <span class="${late ? 'late' : ''}">${tr('fit|review due {when}', { when: ui.rel(r.due_on) })}</span>` : r.decided_on ? ` · ${tr('fit|reviewed {date}', { date: ui.date(r.decided_on) })}${r.reviewer_name ? ` · ${ui.esc(r.reviewer_name)}` : ''}` : ''}</p>
        ${r.note ? `<p class="fround__note">${ui.esc(tx(r.note))}</p>` : ''}
        ${docs.length ? `<ul class="fround__docs">${docs.map((d) => `<li>${ui.fileIcon(d.mime)}<a href="/admin/documents/${d.id}/file" target="_blank" rel="noopener">${ui.esc(tx(d.title))}</a><small>${ui.KB(d.size)}</small></li>`).join('')}</ul>` : ''}
        ${r.comments ? `<blockquote class="quote quote--sm">${ui.esc(tx(r.comments))}</blockquote>` : ''}
        ${upload}${decideForm}
      </li>`;
    }).join('');
    const newRound = agent
      ? `<details class="upload-box"${rounds.length ? '' : ' open'}><summary>${ui.icon('plus')}<span>${tr('fit|Log a new submission')}</span></summary>${ui.form(`/admin/fitout/${p.id}/rounds`, csrf, `<div class="fields">${ui.select('kind', tr('fit|Submission'), tmap(ROUND_KINDS), idx(p.stage) <= idx('review') && !rounds.some((r) => r.kind === 'concept' && r.status !== 'rejected') ? 'concept' : 'detailed')}${ui.input('submitted_on', tr('fit|Received on'), t, { type: 'date' })}</div>${ui.textarea('note', tr('Notes'), '', { rows: 2, placeholder: tr('fit|e.g. Rev. B with the revised kitchen layout') })}${ui.btn(tr('fit|Log submission'), { cls: 'btn--primary btn--sm' })}<p class="muted small">${tr('fit|Then add the drawings to the new round.')}</p>`, { cls: 'stack' })}</details>`
      : '';
    const subsCard = ui.card(tr('fit|Design submissions'), `${rounds.length ? `<ul class="frounds">${roundHtml}</ul>` : `<p class="muted pad">${tr('fit|No submissions yet.')}</p>`}${newRound}`, { sub: tr('fit|The mall reviews each round within {n} days.', { n: p.review_days || reviewDays() }) });

    // contractors and permits
    const contractors = db.all('SELECT * FROM fitout_contractors WHERE project_id = ? ORDER BY id', p.id);
    const permits = db.all('SELECT x.*, c.company FROM fitout_permits x LEFT JOIN fitout_contractors c ON c.id = x.contractor_id WHERE x.project_id = ? ORDER BY x.from_on DESC, x.id DESC', p.id);
    const cHtml = contractors.length
      ? `<ul class="contacts">${contractors.map((c) => `<li><span class="avatar">${ui.esc(ui.initials(c.company))}</span><div><b>${ui.esc(c.company)}</b><small>${ui.esc([c.contact_name, c.insurance_policy ? tr('fit|Policy {no}', { no: c.insurance_policy }) : ''].filter(Boolean).join(' · '))}</small><p class="contact-links">${c.phone ? `<a href="tel:${ui.esc(c.phone)}">${ui.icon('phone')}${ui.esc(c.phone)}</a>` : ''}${c.email ? `<a href="mailto:${ui.esc(c.email)}">${ui.icon('mail')}${ui.esc(c.email)}</a>` : ''}</p></div>${c.insurance_expiry ? ui.expiry(c.insurance_expiry) : ui.badge('missing', tr('fit|No insurance on file'), 'rose')}${mgr ? ui.form(`/admin/fitout/contractors/${c.id}/delete`, csrf, `<button class="iconbtn" title="${ui.esc(tr('Remove'))}" aria-label="${ui.esc(tr('Remove'))}" data-confirm="${ui.esc(tr('fit|Remove {name}?', { name: c.company }))}">×</button>`) : ''}</li>`).join('')}</ul>`
      : `<p class="muted pad">${tr('fit|No contractor yet.')}</p>`;
    const cForm = agent
      ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${tr('fit|Add a contractor')}</span></summary>${ui.form(`/admin/fitout/${p.id}/contractors`, csrf, `<div class="fields">${ui.input('company', tr('fit|Company'), '', { required: true })}${ui.input('contact_name', tr('fit|Site manager'), '')}${ui.input('phone', tr('Phone'), '', { type: 'tel' })}${ui.input('email', tr('Email'), '', { type: 'email' })}${ui.input('insurance_policy', tr('fit|Insurance policy (CAR)'), '')}${ui.input('insurance_expiry', tr('fit|Insurance expires'), '', { type: 'date' })}</div>${ui.btn(tr('Add'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>`
      : '';
    const pHtml = permits.length
      ? `<ul class="list">${permits.map((x) => `<li><span class="what"><b>${ui.esc(tr(PERMIT_TYPES[x.type]))}${x.company ? ` · ${ui.esc(x.company)}` : ''}</b><small>${ui.date(x.from_on)}${x.to_on !== x.from_on ? ` – ${ui.date(x.to_on)}` : ''}${x.hours ? ` · <span class="ltr">${ui.esc(x.hours)}</span>` : ''}${x.description ? ` · ${ui.esc(tx(x.description))}` : ''}${x.via === 'portal' ? ` · ${tr('fit|via the tenant portal')}` : ''}</small></span>${ui.badge(x.status, tr(PERMIT_STATUS[x.status]), PERMIT_TONE[x.status])}${mgr && x.status === 'requested' ? `<span class="row">${ui.form(`/admin/fitout/permits/${x.id}`, csrf, `<input type="hidden" name="status" value="approved">${ui.btn(tr('fit|Approve'), { cls: 'btn--ghost btn--xs' })}`)}${ui.form(`/admin/fitout/permits/${x.id}`, csrf, `<input type="hidden" name="status" value="rejected">${ui.btn(tr('fit|Refuse'), { cls: 'btn--ghost btn--xs' })}`)}</span>` : mgr && x.status === 'approved' ? ui.form(`/admin/fitout/permits/${x.id}`, csrf, `<input type="hidden" name="status" value="closed">${ui.btn(tr('fit|Close'), { cls: 'btn--ghost btn--xs' })}`) : ''}</li>`).join('')}</ul>`
      : `<p class="muted pad">${tr('fit|No permits yet.')}</p>`;
    const pForm = agent
      ? `<details class="upload-box"><summary>${ui.icon('plus')}<span>${tr('fit|Issue a permit')}</span></summary>${ui.form(`/admin/fitout/${p.id}/permits`, csrf, `<div class="fields">${ui.select('type', tr('Type'), tmap(PERMIT_TYPES), 'work')}${ui.select('contractor_id', tr('fit|Contractor'), contractors.map((c) => [c.id, c.company]), '', { blank: '—' })}${ui.input('from_on', tr('fit|From'), t, { type: 'date', required: true })}${ui.input('to_on', tr('fit|To'), M.addDays(t, 6), { type: 'date', required: true })}${ui.input('hours', tr('fit|Hours'), '', { placeholder: '22:00–06:00' })}</div>${ui.textarea('description', tr('fit|Scope'), '', { rows: 2, placeholder: tr('fit|e.g. Welding of shopfront frame') })}${ui.btn(tr('fit|Issue permit'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>`
      : '';

    // checklists
    const checks = db.all('SELECT * FROM fitout_checks WHERE project_id = ? ORDER BY sort, id', p.id);
    const checklist = (list, titleText) => {
      const items = checks.filter((c) => c.list === list);
      const done = items.filter((c) => c.done_at).length;
      return ui.card(titleText, `${ui.meter(items.length ? done / items.length : 0, done === items.length && items.length ? 'ok' : 'forest')}<span class="muted small"> ${done}/${items.length}</span>
        <ul class="fchecks">${items.map((c) => `<li class="${c.done_at ? 'is-done' : ''}">${agent ? ui.form(`/admin/fitout/checks/${c.id}`, csrf, `<button type="submit" class="fcheck" aria-pressed="${c.done_at ? 'true' : 'false'}">${c.done_at ? ui.icon('check') : ''}</button>`) : `<span class="fcheck">${c.done_at ? ui.icon('check') : ''}</span>`}<span>${ui.esc(tx(c.label))}${c.done_at ? `<small>${tr('fit|{who}, {when}', { who: ui.esc(tx(c.done_by || '')), when: ui.date(c.done_at) })}</small>` : ''}</span></li>`).join('')}</ul>
        ${agent ? ui.form(`/admin/fitout/${p.id}/checks`, csrf, `<input type="hidden" name="list" value="${list}"><div class="row fcheck-add">${ui.input('label', tr('fit|Add an item'), '', { cls: 'f--inline f--grow' })}${ui.btn(tr('Add'), { cls: 'btn--ghost btn--sm' })}</div>`) : ''}`);
    };

    // dates, deposit, documents, history
    const datesCard = ui.card(tr('fit|Dates'), mgr
      ? ui.form(`/admin/fitout/${p.id}`, csrf, `<div class="fields fields--2">${ui.input('planned_handover', tr('fit|Planned handover'), p.planned_handover, { type: 'date' })}${ui.input('actual_handover', tr('fit|Actual handover'), p.actual_handover, { type: 'date' })}${ui.input('planned_opening', tr('fit|Planned opening'), p.planned_opening, { type: 'date' })}${ui.input('actual_opening', tr('fit|Actual opening'), p.actual_opening, { type: 'date' })}${ui.input('review_days', tr('fit|Review deadline (days)'), p.review_days || reviewDays(), { type: 'number', min: 1, max: 60 })}${ui.select('manager_id', tr('fit|Fit-out manager'), h.users().filter((u) => u.role !== 'viewer').map((u) => [u.id, u.name]), p.manager_id || '', { blank: '—' })}</div>${ui.textarea('notes', tr('Notes'), p.notes ? tx(p.notes) : '', { rows: 2 })}${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })
      : `<dl class="dl"><div><dt>${tr('fit|Planned handover')}</dt><dd>${ui.date(p.planned_handover)}</dd></div><div><dt>${tr('fit|Planned opening')}</dt><dd>${ui.date(p.planned_opening)}</dd></div><div><dt>${tr('fit|Fit-out manager')}</dt><dd>${ui.esc(p.manager_name || '—')}</dd></div></dl>`);
    const dep = f.deposit;
    const refundable = dep ? Math.max(0, dep.paid - (p.deposit_refund || 0)) : 0;
    const depositCard = ui.card(tr('fit|Fit-out deposit'), dep
      ? `<dl class="dl"><div><dt>${tr('Invoice')}</dt><dd><a href="/admin/invoices/${dep.id}">${ui.esc(dep.ref)}</a> ${ui.badge(dep.status, M.INVOICE_STATUS[dep.status])}</dd></div><div><dt>${tr('Total')}</dt><dd>${ui.money(dep.total)}</dd></div><div><dt>${tr('fit|Received')}</dt><dd>${ui.money(dep.paid)}</dd></div>${p.deposit_refunded_at ? `<div><dt>${tr('fit|Refunded')}</dt><dd>${ui.money(p.deposit_refund)} · ${ui.date(p.deposit_refunded_at)}${p.deposit_refund_note ? `<small class="sub">${ui.esc(tx(p.deposit_refund_note))}</small>` : ''}</dd></div>` : ''}</dl>
        ${mgr && refundable > 0 && !p.deposit_refunded_at ? `<details class="pop pop--inline"><summary class="btn btn--ghost btn--sm">${tr('fit|Refund deposit')}</summary>${ui.form(`/admin/fitout/${p.id}/refund`, csrf, `<div class="fields">${ui.input('amount', tr('Amount'), refundable, { type: 'number', min: 1, max: refundable, step: '0.01', required: true })}${ui.input('date', tr('Date'), t, { type: 'date' })}</div>${ui.textarea('note', tr('Notes'), '', { rows: 2, placeholder: tr('fit|e.g. Less 5,000 for damaged floor tiles') })}${ui.btn(tr('fit|Record refund'), { cls: 'btn--primary btn--sm', attrs: { 'data-confirm': tr('fit|Record the deposit refund?') } })}`, { cls: 'stack' })}</details>` : ''}`
      : mgr
        ? ui.form(`/admin/fitout/${p.id}/deposit`, csrf, `<p class="muted">${tr('fit|A refundable deposit held against damage during the works, billed to the tenant.')}</p><div class="fields fields--2">${ui.input('amount', tr('Amount'), '', { type: 'number', min: 1, step: '0.01', required: true })}${ui.input('due', tr('Due'), t, { type: 'date' })}</div>${ui.btn(tr('fit|Bill the deposit'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })
        : `<p class="muted pad">${tr('fit|No deposit billed yet.')}</p>`);
    const docs = h.docs(req, 'lease', p.lease_id).filter((d) => ['fitout_drawings', 'handover', 'permit', 'insurance', 'other'].includes(d.kind));
    const docsCard = ui.docPanel({ docs, entity: 'lease', entityId: p.lease_id, csrf, canUpload: agent, canDelete: mgr, title: tr('fit|Fit-out documents'), sub: tr('fit|Drawings, permits, inspection reports and certificates, filed on the lease.'), warnDays: Number(db.setting('doc_warn_days')) || 30 });
    const hist = db.all("SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'fitout' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 30", p.id);
    const histCard = ui.card(tr('History'), hist.length ? `<ul class="feed">${hist.map((a) => `<li><span class="avatar avatar--sm">${ui.esc(ui.initials(a.user_name || tr('System')))}</span><p><b>${ui.esc(a.user_name || tr('System'))}</b> ${ui.esc(tx(a.action))}${a.detail ? ` <span>${ui.esc(tx(a.detail))}</span>` : ''}</p><time>${ui.rel(a.created_at)}</time></li>`).join('')}</ul>` : `<p class="muted pad">${tr('fit|Nothing yet.')}</p>`);
    const unitLine = us.map((u) => `<a href="/admin/units/${u.id}">${ui.esc(u.code)}</a>`).join(', ');

    const body = `${head}
<p class="muted fit-sub">${tr('fit|{lease} · units {units}', { lease: `<a href="/admin/leases/${p.lease_id}">${ui.esc(p.lease_ref)}</a>`, units: unitLine })}${p.brand_id ? ` · <a href="/admin/tenants/${p.brand_id}">${tr('fit|Tenant file')}</a>` : ''}</p>
<div class="grid grid--side">
  <div class="stack">${subsCard}${ui.card(tr('fit|Contractors'), cHtml + cForm)}${ui.card(tr('fit|Permits'), pHtml + pForm, { sub: tr('fit|Work, hot works and after-hours permits for the site.') })}${docsCard}</div>
  <div class="stack">${datesCard}${depositCard}${checklist('handover', tr('fit|Handover checklist'))}${checklist('opening', tr('fit|Opening checklist'))}${histCard}</div>
</div>`;
    h.page(req, res, {
      title: p.brand_name || p.lease_ref, crumbs: [['/admin/fitout', tr('nav|Fit-out')], [null, p.brand_name || p.lease_ref]], active: '/admin/fitout', body,
      actions: mgr && p.stage !== 'open' && idx(p.stage) < STAGES.length - 1 ? ui.form(`/admin/fitout/${p.id}/stage`, csrf, `<input type="hidden" name="stage" value="${STAGES[idx(p.stage) + 1]}">${ui.btn(tr('fit|Move to {stage}', { stage: tr(STAGE_SHORT[STAGES[idx(p.stage) + 1]]) }), { cls: 'btn--primary', ic: 'arrow' })}`) : '',
    });
  });

  router.post('/fitout/:id', R('manager'), (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    const b = req.body;
    const days = h.int(b.review_days);
    const mgr = h.int(b.manager_id);
    const notes = h.str(b.notes, 1000);
    db.run(
      'UPDATE fitout_projects SET planned_handover = ?, actual_handover = ?, planned_opening = ?, actual_opening = ?, review_days = ?, manager_id = ?, notes = ?, updated_at = ? WHERE id = ?',
      date(b.planned_handover) || p.planned_handover, date(b.actual_handover), date(b.planned_opening) || p.planned_opening, date(b.actual_opening),
      days && days >= 1 && days <= 60 ? days : p.review_days, mgr && db.get('SELECT id FROM users WHERE id = ?', mgr) ? mgr : null,
      notes && notes === tx(p.notes) ? p.notes : notes || null, M.now(), p.id,
    );
    h.log(req, 'Updated fit-out dates', 'fitout', p.id, p.lease_ref);
    h.back(req, res, `/admin/fitout/${p.id}`, 'ok', tr('Saved.'));
  });

  router.post('/fitout/:id/stage', R('manager'), (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    if (!STAGES.includes(req.body.stage)) return h.back(req, res, `/admin/fitout/${p.id}`, 'error', tr('fit|Unknown stage.'));
    setStage(p, req.body.stage, { user: req.user });
    h.back(req, res, `/admin/fitout/${p.id}`, 'ok', tr('fit|Moved to {stage}.', { stage: stageLabel(req.body.stage) }));
  });

  router.post('/fitout/:id/rounds', R('agent'), (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    addRound(p, { kind: req.body.kind, note: h.str(req.body.note, 1000), submitted_on: req.body.submitted_on, user: req.user });
    h.back(req, res, `/admin/fitout/${p.id}`, 'ok', tr('fit|Submission logged. Add its drawings, then review it.'));
  });

  // Files for a round: the request body is the file (like the document vault), filed on the lease.
  function attach(round, req, { via = 'office' } = {}) {
    const p = projectOf(round.project_id);
    const name = h.str(decodeURIComponent(String(req.get('x-file-name') || '')), 200);
    const saved = h.files.save(Buffer.isBuffer(req.body) ? req.body : null, name);
    if (saved.error === 'empty') return { status: 422, error: tr('Choose a file to upload.') };
    if (saved.error === 'too_big') return { status: 413, error: tr('That file is larger than 25 MB.') };
    if (saved.error) return { status: 415, error: tr('Upload a PDF, JPG, PNG, WebP, Word (.docx) or Excel (.xlsx) file.') };
    const title = h.str(req.query.title, 160) || saved.file_name.replace(/\.[a-z0-9]+$/i, '');
    const id = db.tx(() => {
      const docId = Number(db.run(
        `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, notes, uploaded_by, created_at)
         VALUES (?, 'lease', ?, 'fitout_drawings', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('documents', 'DOC', 4, true), p.lease_id, title, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored,
        `${en(ROUND_KINDS[round.kind])}, round ${round.round_no}${via === 'portal' ? ', from the tenant portal' : ''}`, req.user ? req.user.id : null, M.now(),
      ).lastInsertRowid);
      db.run('INSERT OR IGNORE INTO fitout_round_docs (round_id, document_id) VALUES (?, ?)', round.id, docId);
      return docId;
    });
    db.audit(req.user || null, via === 'portal' ? 'Tenant added drawings' : 'Added drawings', 'fitout', p.id, title);
    return { id };
  }
  router.post('/fitout/rounds/:id/upload', R('agent'), express.raw({ type: () => true, limit: h.files.MAX_BYTES + 1024 }), (req, res) => {
    const round = db.get('SELECT * FROM fitout_rounds WHERE id = ?', h.int(req.params.id));
    if (!round) return res.status(404).json({ ok: false, error: tr('That record no longer exists.') });
    const out = attach(round, req);
    if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
    res.json({ ok: true, id: out.id });
  });

  router.post('/fitout/rounds/:id/decide', R('manager'), (req, res, next) => {
    const round = db.get('SELECT * FROM fitout_rounds WHERE id = ?', h.int(req.params.id));
    if (!round) return next();
    const back = `/admin/fitout/${round.project_id}`;
    if (round.status !== 'in_review') return h.back(req, res, back, 'error', tr('fit|This round has already been reviewed.'));
    const status = ['approved', 'approved_comments', 'rejected'].includes(req.body.status) ? req.body.status : null;
    if (!status) return h.back(req, res, back, 'error', tr('fit|Choose a decision.'));
    const comments = h.str(req.body.comments, 3000);
    if (status !== 'approved' && !comments) return h.back(req, res, back, 'error', tr('fit|Add comments so the tenant knows what to change.'));
    decide(round, status, comments, req.user);
    h.back(req, res, back, 'ok', tr('fit|Review recorded.'));
  });

  router.post('/fitout/:id/contractors', R('agent'), (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    const company = h.str(req.body.company, 160);
    if (!company) return h.back(req, res, `/admin/fitout/${p.id}`, 'error', tr('fit|Enter the contractor company.'));
    db.run('INSERT INTO fitout_contractors (project_id, company, contact_name, phone, email, insurance_policy, insurance_expiry, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      p.id, company, h.str(req.body.contact_name, 120) || null, h.str(req.body.phone, 40) || null, h.str(req.body.email, 160) || null, h.str(req.body.insurance_policy, 80) || null, date(req.body.insurance_expiry), M.now());
    if (p.stage === 'approved') setStage(p, 'contractor', { user: req.user });
    h.log(req, 'Added a contractor', 'fitout', p.id, company);
    h.back(req, res, `/admin/fitout/${p.id}`, 'ok', tr('fit|Contractor added.'));
  });
  router.post('/fitout/contractors/:id/delete', R('manager'), (req, res, next) => {
    const c = db.get('SELECT * FROM fitout_contractors WHERE id = ?', h.int(req.params.id));
    if (!c) return next();
    db.run('DELETE FROM fitout_contractors WHERE id = ?', c.id);
    h.log(req, 'Removed a contractor', 'fitout', c.project_id, c.company);
    h.back(req, res, `/admin/fitout/${c.project_id}`, 'ok', tr('fit|Contractor removed.'));
  });

  function addPermit(p, b, { via = 'office', user = null } = {}) {
    const from = date(b.from_on);
    const to = date(b.to_on) || from;
    if (!from || to < from) return tr('fit|Enter valid permit dates.');
    const contractor = h.int(b.contractor_id);
    db.run('INSERT INTO fitout_permits (project_id, contractor_id, type, from_on, to_on, hours, description, status, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      p.id, contractor && db.get('SELECT id FROM fitout_contractors WHERE id = ? AND project_id = ?', contractor, p.id) ? contractor : null,
      PERMIT_TYPES[b.type] ? b.type : 'work', from, to, h.str(b.hours, 40) || null, h.str(b.description, 500) || null, via === 'portal' ? 'requested' : 'approved', via, M.now());
    db.audit(user, via === 'portal' ? 'Tenant requested a permit' : 'Issued a permit', 'fitout', p.id, en(PERMIT_TYPES[PERMIT_TYPES[b.type] ? b.type : 'work']));
    return null;
  }
  router.post('/fitout/:id/permits', R('agent'), (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    const err = addPermit(p, req.body, { user: req.user });
    if (err) return h.back(req, res, `/admin/fitout/${p.id}`, 'error', err);
    h.back(req, res, `/admin/fitout/${p.id}`, 'ok', tr('fit|Permit issued.'));
  });
  router.post('/fitout/permits/:id', R('manager'), (req, res, next) => {
    const x = db.get('SELECT * FROM fitout_permits WHERE id = ?', h.int(req.params.id));
    if (!x) return next();
    const status = ['approved', 'rejected', 'closed'].includes(req.body.status) ? req.body.status : null;
    if (!status) return h.back(req, res, `/admin/fitout/${x.project_id}`, 'error', tr('fit|Choose a decision.'));
    db.run('UPDATE fitout_permits SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', status, req.user.id, M.now(), x.id);
    h.log(req, { approved: 'Permit approved', rejected: 'Permit refused', closed: 'Permit closed' }[status], 'fitout', x.project_id, en(PERMIT_TYPES[x.type]));
    h.back(req, res, `/admin/fitout/${x.project_id}`, 'ok', tr('Saved.'));
  });

  router.post('/fitout/checks/:id', R('agent'), (req, res, next) => {
    const c = db.get('SELECT * FROM fitout_checks WHERE id = ?', h.int(req.params.id));
    if (!c) return next();
    if (c.done_at) db.run('UPDATE fitout_checks SET done_at = NULL, done_by = NULL WHERE id = ?', c.id);
    else db.run('UPDATE fitout_checks SET done_at = ?, done_by = ? WHERE id = ?', M.today(), req.user.name, c.id);
    db.audit(req.user, c.done_at ? 'Reopened a checklist item' : 'Ticked a checklist item', 'fitout', c.project_id, c.label);
    res.redirect(303, `/admin/fitout/${c.project_id}#check-${c.list}`);
  });
  router.post('/fitout/:id/checks', R('agent'), (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    const label = h.str(req.body.label, 160);
    const list = req.body.list === 'opening' ? 'opening' : 'handover';
    if (label) db.run('INSERT INTO fitout_checks (project_id, list, label, sort) VALUES (?, ?, ?, ?)', p.id, list, label, (db.value('SELECT MAX(sort) FROM fitout_checks WHERE project_id = ? AND list = ?', p.id, list) || 0) + 1);
    h.back(req, res, `/admin/fitout/${p.id}`, 'ok', label ? tr('fit|Item added.') : '');
  });

  router.post('/fitout/:id/deposit', R('manager'), (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    const back = `/admin/fitout/${p.id}`;
    if (facts(p).deposit) return h.back(req, res, back, 'error', tr('fit|A deposit is already billed for this project.'));
    const amount = h.numv(req.body.amount);
    if (!amount || amount <= 0) return h.back(req, res, back, 'error', tr('Enter an amount.'));
    let inv;
    try {
      inv = billDeposit(p, amount, date(req.body.due) || M.today(), { user: req.user });
    } catch (err) {
      return h.back(req, res, back, 'error', tr(err.message));
    }
    h.log(req, 'Billed the fit-out deposit', 'fitout', p.id, `${inv.ref} · ${amount}`);
    h.back(req, res, back, 'ok', tr('fit|Deposit billed as {ref}.', { ref: inv.ref }));
  });
  function billDeposit(p, amount, due, { user = null, demo = 0 } = {}) {
    const inv = h.billing.createInvoice({ lease_id: p.lease_id, kind: 'fitout', due_date: due, other: amount, note: 'Fit-out deposit', source: 'fitout', source_id: p.id, demo }, { user });
    db.run('UPDATE fitout_projects SET deposit_invoice_id = ?, updated_at = ? WHERE id = ?', inv.id, M.now(), p.id);
    return inv;
  }
  // Paid deposits move the project on.
  h.events.on('payment.received', ({ invoice }) => {
    if (!invoice || invoice.source !== 'fitout' || invoice.status !== 'paid') return;
    const p = projectOf(invoice.source_id);
    if (p && ['approved', 'contractor', 'deposit'].includes(p.stage)) setStage(p, 'deposit', {});
    if (p) {
      const c = db.get("SELECT id FROM fitout_checks WHERE project_id = ? AND list = 'handover' AND label = 'Fit-out deposit received' AND done_at IS NULL", p.id);
      if (c) db.run("UPDATE fitout_checks SET done_at = ?, done_by = 'Billing' WHERE id = ?", invoice.paid_at || M.today(), c.id);
    }
  });

  router.post('/fitout/:id/refund', R('manager'), (req, res, next) => {
    const p = projectOf(h.int(req.params.id));
    if (!p) return next();
    const back = `/admin/fitout/${p.id}`;
    const dep = facts(p).deposit;
    const amount = h.numv(req.body.amount);
    if (!dep || p.deposit_refunded_at) return h.back(req, res, back, 'error', tr('fit|There is no deposit to refund.'));
    if (!amount || amount <= 0 || amount > dep.paid + 0.001) return h.back(req, res, back, 'error', tr('fit|The refund cannot be more than the deposit received.'));
    refund(p, amount, date(req.body.date) || M.today(), h.str(req.body.note, 500), req.user);
    h.log(req, 'Refunded the fit-out deposit', 'fitout', p.id, `${dep.ref} · ${amount}`);
    h.back(req, res, back, 'ok', tr('fit|Deposit refund recorded.'));
  });
  function refund(p, amount, on, note, user) {
    db.run('UPDATE fitout_projects SET deposit_refund = ?, deposit_refunded_at = ?, deposit_refund_note = ?, updated_at = ? WHERE id = ?', amount, on, note || null, M.now(), p.id);
    const fresh = projectOf(p.id);
    h.events.emit('fitout.deposit_refunded', { project: fresh, amount, date: on, invoice: fresh.deposit_invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', fresh.deposit_invoice_id) : null, user });
  }

  // ---------- for other pages (tenant file, unit page, demo, tests) ----------
  function summaryCard(req, { brandId = null, unitId = null } = {}) {
    ensureProjects();
    const list = brandId
      ? db.all(`${SELECT} WHERE p.brand_id = ? AND (s.status IN ('draft','active') OR p.stage = 'open') ORDER BY p.id DESC`, brandId)
      : db.all(`${SELECT} WHERE p.lease_id IN (SELECT lease_id FROM lease_units WHERE unit_id = ?) AND (s.status IN ('draft','active') OR p.stage = 'open') ORDER BY p.id DESC`, unitId);
    if (!list.length) return '';
    return ui.card(tr('nav|Fit-out'), `<ul class="list">${list.map((p) => {
      const f = facts(p);
      const nm = nextMilestone(p);
      return `<li><a href="/admin/fitout/${p.id}"><span class="what"><b>${ui.esc(stageLabel(p.stage))}</b><small>${ui.esc(p.lease_ref)} · ${ui.esc(nm.label)} ${ui.date(nm.date)}${p.in_review ? ` · ${tr('fit|review due {when}', { when: ui.rel(p.review_due) })}` : ''}</small></span><span class="fit-progress">${ui.meter(f.progress, f.late ? 'rose' : 'forest')}</span></a></li>`;
    }).join('')}</ul>`, { action: ui.btn(tr('fit|Open project'), { href: `/admin/fitout/${list[0].id}`, cls: 'btn--ghost btn--sm' }) });
  }
  // the tenant file shows where its fit-out stands
  (h.tenantCards = h.tenantCards || []).push((req, b) => summaryCard(req, { brandId: b.id }));
  h.fitout = { STAGES, ensureProjects, create, setStage, addRound, decide, billDeposit, refund, addPermit, projectOf, facts, summaryCard, stageLabel };

  // ---------- the tenant portal ----------
  if (h.portal && h.portal.router && typeof h.portal.tab === 'function') {
    const P = h.portal;
    const need = P.requireTenant || ((req, res, next) => next());
    const brandOf = (req) => (typeof P.brandId === 'function' ? P.brandId(req) : req.tenant && req.tenant.brand_id) || null;
    const csrfOf = (req) => (req.psession && req.psession.csrf) || '';
    const pback = (req, res, url, type, text) => (typeof P.back === 'function' ? P.back(req, res, url, type, text) : res.redirect(303, url));
    const pform = (action, req, inner, opts = {}) => `<form method="post" action="${action}" class="${opts.cls || ''}"><input type="hidden" name="_csrf" value="${ui.esc(csrfOf(req))}">${inner}</form>`;
    const render = (req, res, opts) => (typeof P.page === 'function' ? P.page(req, res, opts) : res.type('html').send(ui.bare({ title: opts.title, body: `<main class="content">${opts.body}</main>` })));
    P.tab({ key: 'fitout', href: '/portal/fitout', label: 'nav|Fit-out', icon: 'hammer', order: 40, badge: (req) => db.value("SELECT COUNT(*) FROM fitout_rounds r JOIN fitout_projects p ON p.id = r.project_id WHERE p.brand_id = ? AND r.status = 'rejected' AND NOT EXISTS (SELECT 1 FROM fitout_rounds x WHERE x.project_id = r.project_id AND x.kind = r.kind AND x.round_no > r.round_no)", brandOf(req)) });
    const mine = (req) => {
      ensureProjects();
      return db.all(`${SELECT} WHERE p.brand_id = ? AND (s.status IN ('draft','active') OR p.stage = 'open') ORDER BY p.id DESC`, brandOf(req));
    };
    P.router.get('/fitout', need, (req, res) => {
      const list = mine(req);
      const t = M.today();
      const body = list.length ? list.map((p) => {
        const f = facts(p);
        const rounds = db.all('SELECT * FROM fitout_rounds WHERE project_id = ? ORDER BY submitted_on DESC, id DESC', p.id);
        const permits = db.all('SELECT * FROM fitout_permits WHERE project_id = ? ORDER BY from_on DESC', p.id);
        const checks = db.all('SELECT * FROM fitout_checks WHERE project_id = ? ORDER BY list, sort, id', p.id);
        const steps = `<ol class="fit-steps">${STAGES.map((s, i) => `<li class="${i < idx(p.stage) ? 'is-past' : s === p.stage ? 'is-on' : ''}"><i></i><span>${ui.esc(tr(STAGE_SHORT[s]))}</span></li>`).join('')}</ol>`;
        const roundsHtml = rounds.length ? `<ul class="frounds">${rounds.map((r) => `<li class="fround fround--${r.status}"><div class="fround__head"><b>${ui.esc(tr(ROUND_KINDS[r.kind]))} · ${tr('fit|round {n}', { n: r.round_no })}</b>${ui.badge(r.status, tr(DECISIONS[r.status]), DECISION_TONE[r.status])}</div><p class="fround__meta">${tr('fit|Submitted {date}', { date: ui.date(r.submitted_on) })}${r.status === 'in_review' ? ` · ${tr('fit|review due {when}', { when: ui.rel(r.due_on) })}` : ''}</p>${r.comments ? `<blockquote class="quote quote--sm">${ui.esc(tx(r.comments))}</blockquote>` : ''}${r.status === 'in_review' ? `<form class="upload upload--inline" data-upload="/portal/fitout/rounds/${r.id}/upload?x=1" novalidate><label class="drop drop--sm"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,application/pdf,image/*">${ui.icon('upload')}<span data-drop-label>${tr('fit|Add drawings to this round')}</span><i class="drop__bar" hidden><b></b></i></label><p class="upload__msg" data-upload-msg hidden></p></form>` : ''}</li>`).join('')}</ul>` : `<p class="muted pad">${tr('fit|No submissions yet.')}</p>`;
        const submit = pform(`/portal/fitout/${p.id}/rounds`, req, `<div class="fields">${ui.select('kind', tr('fit|Submission'), tmap(ROUND_KINDS), idx(p.stage) <= idx('review') ? 'concept' : 'detailed')}</div>${ui.textarea('note', tr('Notes'), '', { rows: 2 })}${ui.btn(tr('fit|Start a new submission'), { cls: 'btn--primary btn--sm' })}<p class="muted small">${tr('fit|Then add your drawings to it.')}</p>`, { cls: 'stack' });
        const permitForm = pform(`/portal/fitout/${p.id}/permits`, req, `<div class="fields">${ui.select('type', tr('Type'), tmap(PERMIT_TYPES), 'work')}${ui.input('from_on', tr('fit|From'), t, { type: 'date', required: true })}${ui.input('to_on', tr('fit|To'), M.addDays(t, 6), { type: 'date', required: true })}${ui.input('hours', tr('fit|Hours'), '', { placeholder: '22:00–06:00' })}</div>${ui.textarea('description', tr('fit|Scope'), '', { rows: 2 })}${ui.btn(tr('fit|Request a permit'), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' });
        const dep = f.deposit;
        return `${ui.card(`${tr('nav|Fit-out')} · ${ui.esc(p.lease_ref)}`, `${steps}<dl class="dl"><div><dt>${tr('Stage')}</dt><dd>${ui.esc(stageLabel(p.stage))}</dd></div><div><dt>${tr('fit|Site handover')}</dt><dd>${ui.date(p.actual_handover || p.planned_handover)}</dd></div><div><dt>${tr('fit|Opening')}</dt><dd>${ui.date(p.actual_opening || p.planned_opening)}</dd></div><div><dt>${tr('fit|Deposit')}</dt><dd>${dep ? `${ui.money(dep.total)} · ${ui.esc(M.INVOICE_STATUS[dep.status])}` : '—'}</dd></div></dl>`)}
          <div class="grid grid--2">${ui.card(tr('fit|Design submissions'), roundsHtml + `<details class="upload-box"><summary>${ui.icon('plus')}<span>${tr('fit|Start a new submission')}</span></summary>${submit}</details>`)}
          <div class="stack">${ui.card(tr('fit|Permits'), (permits.length ? `<ul class="list">${permits.map((x) => `<li><span class="what"><b>${ui.esc(tr(PERMIT_TYPES[x.type]))}</b><small>${ui.date(x.from_on)} – ${ui.date(x.to_on)}</small></span>${ui.badge(x.status, tr(PERMIT_STATUS[x.status]), PERMIT_TONE[x.status])}</li>`).join('')}</ul>` : `<p class="muted pad">${tr('fit|No permits yet.')}</p>`) + `<details class="upload-box"><summary>${ui.icon('plus')}<span>${tr('fit|Request a permit')}</span></summary>${permitForm}</details>`)}
          ${ui.card(tr('fit|Checklists'), ['handover', 'opening'].map((list) => `<p class="grouphead">${list === 'handover' ? tr('fit|Handover checklist') : tr('fit|Opening checklist')}</p><ul class="fchecks">${checks.filter((c) => c.list === list).map((c) => `<li class="${c.done_at ? 'is-done' : ''}"><span class="fcheck">${c.done_at ? ui.icon('check') : ''}</span><span>${ui.esc(tx(c.label))}</span></li>`).join('')}</ul>`).join(''))}</div></div>`;
      }).join('') : ui.empty(tr('fit|Your fit-out will appear here once your lease is drafted.'));
      render(req, res, { title: tr('nav|Fit-out'), active: 'fitout', body });
    });
    const owned = (req, id) => {
      const p = projectOf(h.int(id));
      return p && String(p.brand_id) === String(brandOf(req)) ? p : null;
    };
    P.router.post('/fitout/:id/rounds', need, (req, res) => {
      const p = owned(req, req.params.id);
      if (!p) return res.status(404).type('text').send(tr('That record no longer exists.'));
      addRound(p, { kind: req.body && req.body.kind, note: h.str(req.body && req.body.note, 1000), via: 'portal' });
      pback(req, res, '/portal/fitout', 'ok', tr('fit|Submission started. Add your drawings to it now.'));
    });
    P.router.post('/fitout/:id/permits', need, (req, res) => {
      const p = owned(req, req.params.id);
      if (!p) return res.status(404).type('text').send(tr('That record no longer exists.'));
      const err = addPermit(p, req.body || {}, { via: 'portal' });
      pback(req, res, '/portal/fitout', err ? 'error' : 'ok', err || tr('fit|Permit requested. The mall will confirm it.'));
    });
    P.router.post('/fitout/rounds/:id/upload', need, express.raw({ type: () => true, limit: h.files.MAX_BYTES + 1024 }), (req, res) => {
      const round = db.get('SELECT * FROM fitout_rounds WHERE id = ?', h.int(req.params.id));
      if (!round || !owned(req, round.project_id)) return res.status(404).json({ ok: false, error: tr('That record no longer exists.') });
      if (round.status !== 'in_review') return res.status(422).json({ ok: false, error: tr('fit|This round has already been reviewed.') });
      const out = attach(round, req, { via: 'portal' });
      if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
      res.json({ ok: true, id: out.id });
    });
  }
};

module.exports.STAGES = STAGES;
