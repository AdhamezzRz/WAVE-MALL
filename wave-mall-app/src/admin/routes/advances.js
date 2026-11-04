'use strict';

// Salary advances (/admin/hr/advances): money lent to an employee and repaid in monthly
// installments taken off their pay. Each payroll run plans the installment of every advance still
// open (payroll_lines.advance, shown on the payslip); an installment counts as repaid once its run is
// approved. An employee can also repay early in cash. In the books: the advance is a receivable
// from staff (paid out of cash or the bank), settled by payroll deductions or the cash repaid.

const { t: tr, tn, isAr } = require('../i18n');

const SCHEMA = `
  CREATE TABLE hr_advances (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    amount REAL NOT NULL, installments INTEGER NOT NULL DEFAULT 1, monthly REAL NOT NULL, start_period TEXT NOT NULL,
    issued_on TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'cash', reason TEXT, status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX hr_advances_employee ON hr_advances(employee_id, status);
  CREATE TABLE hr_advance_repayments (
    id INTEGER PRIMARY KEY, advance_id INTEGER NOT NULL REFERENCES hr_advances(id) ON DELETE CASCADE,
    run_id INTEGER REFERENCES payroll_runs(id) ON DELETE CASCADE, period TEXT, amount REAL NOT NULL, source TEXT NOT NULL DEFAULT 'payroll',
    paid_on TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX hr_advance_repayments_advance ON hr_advance_repayments(advance_id);
`;
const STATUS = { active: ['adv|Being repaid', 'amber'], settled: ['adv|Repaid', 'ok'], cancelled: ['adv|Cancelled', 'mute'] };
const METHODS = { cash: 'pay|Cash', transfer: 'pay|Bank transfer' };

module.exports = function advances(router, h) {
  const { db, ui, M } = h;
  const RH = h.RH;
  db.ensure('advances-1', SCHEMA);
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const esc = ui.esc;
  const badge = (s) => ui.badge(s, tr((STATUS[s] || [s])[0]), (STATUS[s] || [])[1]);
  const nm = (e) => (isAr() && e.name_ar ? e.name_ar : e.name);
  const ym = (d) => String(d).slice(0, 7);
  const isYm = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));

  // What has been repaid: cash repayments, and installments of approved or paid payroll runs.
  const repaid = (a, { exceptRun = null } = {}) => r2(db.value(`SELECT COALESCE(SUM(x.amount), 0) FROM hr_advance_repayments x LEFT JOIN payroll_runs r ON r.id = x.run_id
    WHERE x.advance_id = ? AND (x.source = 'cash' OR r.status IN ('approved','paid')) AND (x.run_id IS NULL OR x.run_id IS NOT ?)`, a.id, exceptRun));
  const remaining = (a, opts) => r2(Math.max(0, a.amount - repaid(a, opts)));
  // an advance fully repaid is settled; one with more to repay (a run reopened) is active again
  function refresh(a) {
    const left = remaining(a);
    const status = a.status === 'cancelled' ? 'cancelled' : left <= 0 ? 'settled' : 'active';
    if (status !== a.status) db.run('UPDATE hr_advances SET status = ? WHERE id = ?', status, a.id);
    return status;
  }

  // Called by the payroll (routes/hr.js) for each person in a draft run: plans this month's
  // installment of each of their open advances and returns the total to take off their pay.
  function plan(run, emp) {
    db.run('DELETE FROM hr_advance_repayments WHERE run_id = ? AND advance_id IN (SELECT id FROM hr_advances WHERE employee_id = ?)', run.id, emp.id);
    let total = 0;
    for (const a of db.all("SELECT * FROM hr_advances WHERE employee_id = ? AND status != 'cancelled' AND start_period <= ? ORDER BY issued_on, id", emp.id, run.period)) {
      // what earlier runs and cash have not covered yet (draft runs of other months count as planned)
      const planned = r2(db.value(`SELECT COALESCE(SUM(x.amount), 0) FROM hr_advance_repayments x LEFT JOIN payroll_runs r ON r.id = x.run_id
        WHERE x.advance_id = ? AND (x.source = 'cash' OR (x.run_id != ? AND r.period < ?))`, a.id, run.id, run.period));
      const due = r2(Math.min(a.monthly, Math.max(0, a.amount - planned)));
      if (due <= 0) continue;
      db.run("INSERT INTO hr_advance_repayments (advance_id, run_id, period, amount, source, created_at) VALUES (?, ?, ?, ?, 'payroll', ?)", a.id, run.id, run.period, due, now());
      total = r2(total + due);
    }
    return total;
  }
  h.advances = { plan, remaining, refresh };
  // payroll approved, paid or reopened: advances follow
  for (const ev of ['payroll.approved', 'payroll.reopened']) h.events.on(ev, () => { for (const a of db.all("SELECT * FROM hr_advances WHERE status != 'cancelled'")) refresh(a); });

  // ---------- the books ----------
  const ledger = () => (h.ledger && typeof h.ledger.post === 'function' ? h.ledger : null);
  const cashAccount = (L, method) => {
    const code = L.S(`method_${method}`, '');
    return code && L.byCode(code) ? L.byCode(code).id : L.idOf(method === 'cash' ? 'petty_cash' : 'bank_clearing');
  };
  function book(memo, lines, { date, source, user, demo = 0 }) {
    const L = ledger();
    if (!L) return null;
    try {
      return L.post({ date: L.firstOpen(date), memo, kind: 'auto', source, lines, user, demo });
    } catch (e) {
      console.error('[hr] advance not posted:', e.message);
      return null;
    }
  }

  // ---------- pages ----------
  const employees = () => db.all("SELECT id, name, name_ar, code, basic_salary FROM employees WHERE status = 'active' ORDER BY name");
  router.get('/hr/advances', RH, (req, res) => {
    const st = STATUS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'active';
    const emp = h.int(req.query.employee);
    const where = [...(st === 'all' ? [] : ['a.status = ?']), ...(emp ? ['a.employee_id = ?'] : [])];
    const rows = db.all(`SELECT a.*, e.name, e.name_ar, e.code FROM hr_advances a JOIN employees e ON e.id = a.employee_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.issued_on DESC, a.id DESC`, ...(st === 'all' ? [] : [st]), ...(emp ? [emp] : []))
      .map((a) => ({ ...a, repaid: repaid(a), left: remaining(a) }));
    const open = db.all("SELECT * FROM hr_advances WHERE status = 'active'");
    const month = M.today().slice(0, 7);
    const kpis = [
      ui.kpi({ label: tr('adv|Still to be repaid'), value: ui.money(r2(open.reduce((s, a) => s + remaining(a), 0)), { compact: true }), sub: esc(tn(open.length, 'adv|{n} advance', 'adv|{n} advances')) }),
      ui.kpi({ label: tr('adv|Taken off pay this month'), value: ui.money(r2(db.value("SELECT COALESCE(SUM(amount), 0) FROM hr_advance_repayments WHERE period = ? AND source = 'payroll'", month)), { compact: true }) }),
      ui.kpi({ label: tr('adv|Given this year'), value: ui.money(r2(db.value('SELECT COALESCE(SUM(amount), 0) FROM hr_advances WHERE substr(issued_on, 1, 4) = ? AND status != \'cancelled\'', month.slice(0, 4))), { compact: true }) }),
    ].join('');
    const tabs = `<nav class="tabs">${[...Object.keys(STATUS), 'all'].map((k) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/hr/advances?status=${k}${emp ? `&employee=${emp}` : ''}">${esc(k === 'all' ? tr('All') : tr(STATUS[k][0]))}</a>`).join('')}</nav>`;
    const table = ui.table([
      { label: tr('Employee'), render: (a) => `<b>${esc(nm(a))}</b><small class="sub">${esc(a.ref)} · <bdi>${esc(a.code)}</bdi></small>` },
      { label: tr('adv|Given on'), sort: (a) => a.issued_on, render: (a) => esc(ui.date(a.issued_on)) },
      { label: tr('adv|Amount'), num: true, sort: (a) => a.amount, render: (a) => ui.money(a.amount, { cur: false }) },
      { label: tr('adv|Each month'), num: true, render: (a) => `${ui.money(a.monthly, { cur: false })}<small class="sub">${esc(tr('adv|from {month}', { month: ui.monthYear(a.start_period) }))}</small>` },
      { label: tr('adv|Repaid'), num: true, render: (a) => `${ui.money(a.repaid, { cur: false })}${ui.meter ? `` : ''}` },
      { label: tr('adv|Left'), num: true, sort: (a) => a.left, render: (a) => `<b>${ui.money(a.left, { cur: false })}</b>` },
      { label: tr('Status'), render: (a) => badge(a.status) },
    ], rows, { empty: esc(tr('adv|No advances here.')), href: (a) => `/admin/hr/advances/${a.id}` });
    const csrf = req.session.csrf;
    const next = M.addMonths(`${month}-01`, 1).slice(0, 7);
    const form = ui.form('/admin/hr/advances', csrf, `<div class="fields">
      ${ui.select('employee_id', tr('Employee'), employees().map((e) => [e.id, `${nm(e)} · ${e.code}`]), emp || '', { required: true, blank: tr('Choose…') })}
      ${ui.input('amount', tr('adv|Amount'), '', { type: 'number', min: 1, step: '0.01', required: true })}
      ${ui.input('installments', tr('adv|Repaid over (months)'), 3, { type: 'number', min: 1, max: 36, required: true })}
      ${ui.input('start_period', tr('adv|First deduction'), next, { type: 'month', required: true })}
      ${ui.input('issued_on', tr('adv|Given on'), M.today(), { type: 'date', required: true })}
      ${ui.select('method', tr('adv|Paid out by'), Object.fromEntries(Object.entries(METHODS).map(([k, v]) => [k, tr(v)])), 'cash')}
      ${ui.input('reason', tr('adv|Reason'), '', { cls: 'span-all', placeholder: tr('adv|e.g. Family occasion') })}
    </div><p class="muted small">${esc(tr('adv|The monthly amount is taken off their pay from the first deduction month until it is repaid.'))}</p>${ui.btn(esc(tr('adv|Give the advance')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' });
    h.page(req, res, {
      title: tr('adv|Salary advances'), active: '/admin/hr/advances', wide: true,
      body: `<div class="kpis kpis--3">${kpis}</div>${tabs}<div class="grid grid--side"><div>${ui.card(tr('adv|Advances'), table)}</div><div>${ui.card(tr('adv|New advance'), form, { sub: esc(tr('adv|A loan against salary, repaid from payroll.')) })}</div></div>`,
    });
  });

  router.post('/hr/advances', RH, (req, res) => {
    const b = req.body;
    const e = db.get("SELECT * FROM employees WHERE id = ? AND status = 'active'", h.int(b.employee_id));
    const amount = r2(h.numv(b.amount));
    const n = Math.min(36, Math.max(1, h.int(b.installments) || 1));
    const start = isYm(b.start_period) ? b.start_period : M.addMonths(`${M.today().slice(0, 7)}-01`, 1).slice(0, 7);
    if (!e || !(amount > 0)) return h.back(req, res, '/admin/hr/advances', 'error', tr('adv|Choose the employee and enter the amount.'));
    const method = METHODS[b.method] ? b.method : 'cash';
    const issued = /^\d{4}-\d{2}-\d{2}$/.test(String(b.issued_on || '')) ? b.issued_on : M.today();
    const id = db.tx(() => {
      const aid = Number(db.run('INSERT INTO hr_advances (ref, employee_id, amount, installments, monthly, start_period, issued_on, method, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        db.nextRef('hr_advances', 'AD', 4, true), e.id, amount, n, r2(Math.ceil((amount / n) * 100) / 100), start, issued, method, h.str(b.reason, 200) || null, req.user.id, now()).lastInsertRowid);
      const L = ledger();
      if (L) book(`Salary advance to ${e.name}`, [{ account: 'other_receivables', debit: amount }, { account: cashAccount(L, method), credit: amount }], { date: issued, source: `advance:${aid}`, user: req.user });
      return aid;
    });
    // a draft payroll for a month it already covers picks it up now
    for (const run of db.all("SELECT * FROM payroll_runs WHERE status = 'draft' AND period >= ?", start)) {
      if (h.hrRecalc) h.hrRecalc(run);
    }
    h.log(req, 'Gave a salary advance', 'employee', e.id, `${e.name} · ${amount} over ${n} months`);
    h.back(req, res, `/admin/hr/advances/${id}`, 'ok', tr('adv|Advance recorded. {amount} a month comes off their pay from {month}.', { amount: ui.money(r2(amount / n)), month: ui.monthYear(start) }));
  });

  const advanceOf = (id) => db.get('SELECT a.*, e.name, e.name_ar, e.code, u.name by_name FROM hr_advances a JOIN employees e ON e.id = a.employee_id LEFT JOIN users u ON u.id = a.created_by WHERE a.id = ?', id);
  router.get('/hr/advances/:id', RH, (req, res, next) => {
    const a = advanceOf(h.int(req.params.id));
    if (!a) return next();
    refresh(a);
    const csrf = req.session.csrf;
    const left = remaining(a);
    const pays = db.all('SELECT x.*, r.status run_status, r.period run_period FROM hr_advance_repayments x LEFT JOIN payroll_runs r ON r.id = x.run_id WHERE x.advance_id = ? ORDER BY COALESCE(x.period, substr(x.paid_on, 1, 7)), x.id', a.id);
    // the months still to come, at the monthly amount
    const schedule = [];
    let rest = r2(left - pays.filter((p) => p.source === 'payroll' && !['approved', 'paid'].includes(p.run_status)).reduce((s, p) => s + p.amount, 0));
    const lastPlanned = pays.filter((p) => p.period).map((p) => p.period).sort().at(-1);
    let period = [lastPlanned ? M.addMonths(`${lastPlanned}-01`, 1).slice(0, 7) : a.start_period, a.start_period].sort().at(-1);
    while (rest > 0 && schedule.length < 40 && a.status !== 'cancelled') {
      const amt = r2(Math.min(a.monthly, rest));
      schedule.push({ period, amount: amt });
      rest = r2(rest - amt);
      period = M.addMonths(`${period}-01`, 1).slice(0, 7);
    }
    const lines = [
      ...pays.map((p) => `<li><span class="what"><b>${esc(p.source === 'cash' ? tr('adv|Repaid in cash') : tr('adv|Payroll {month}', { month: ui.monthYear(p.period) }))}</b><small>${esc(p.source === 'cash' ? ui.date(p.paid_on) : ['approved', 'paid'].includes(p.run_status) ? tr('adv|Taken off pay') : tr('adv|On the draft payroll'))}</small></span><b>${ui.money(p.amount)}</b>${p.source === 'cash' || ['approved', 'paid'].includes(p.run_status) ? ui.badge('ok', tr('adv|Repaid'), 'ok') : ui.badge('plan', tr('adv|Planned'), 'sky')}</li>`),
      ...schedule.map((x) => `<li class="is-future"><span class="what"><b>${esc(tr('adv|Payroll {month}', { month: ui.monthYear(x.period) }))}</b><small>${esc(tr('adv|To come'))}</small></span><b>${ui.money(x.amount)}</b></li>`),
    ];
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('Employee'))}</dt><dd><a href="/admin/hr/employees/${a.employee_id}">${esc(nm(a))}</a> · <bdi>${esc(a.code)}</bdi></dd></div>
      <div><dt>${esc(tr('adv|Amount'))}</dt><dd><b>${ui.money(a.amount)}</b></dd></div>
      <div><dt>${esc(tr('adv|Given on'))}</dt><dd>${esc(ui.date(a.issued_on))} · ${esc(tr(METHODS[a.method] || a.method))}${a.by_name ? ` · ${esc(a.by_name)}` : ''}</dd></div>
      <div><dt>${esc(tr('adv|Repayment'))}</dt><dd>${esc(tr('adv|{amount} a month for {n} months, from {month}', { amount: ui.money(a.monthly), n: a.installments, month: ui.monthYear(a.start_period) }))}</dd></div>
      <div><dt>${esc(tr('adv|Left'))}</dt><dd><b>${ui.money(left)}</b></dd></div>
      <div><dt>${esc(tr('Status'))}</dt><dd>${badge(advanceOf(a.id).status)}</dd></div>
      ${a.reason ? `<div><dt>${esc(tr('adv|Reason'))}</dt><dd>${esc(a.reason)}</dd></div>` : ''}
    </dl>`;
    const cashForm = left > 0 && a.status === 'active' ? ui.card(tr('adv|Repay in cash'), ui.form(`/admin/hr/advances/${a.id}/repay`, csrf, `<div class="fields">${ui.input('amount', tr('adv|Amount'), left, { type: 'number', min: 1, max: left, step: '0.01', required: true })}${ui.input('date', tr('adv|Received on'), M.today(), { type: 'date' })}</div>${ui.btn(esc(tr('adv|Record the repayment')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }), { sub: esc(tr('adv|The rest is still taken off their pay each month.')) }) : '';
    const cancel = a.status === 'active' && !repaid(a) ? `<details class="danger"><summary>${esc(tr('adv|Cancel the advance'))}</summary>${ui.form(`/admin/hr/advances/${a.id}/cancel`, csrf, ui.btn(esc(tr('adv|Cancel the advance')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('adv|Cancel this advance? Nothing has been repaid; the money should come back to the cash box.') } }))}</details>` : '';
    h.page(req, res, {
      title: tr('adv|Advance {ref}', { ref: a.ref }), crumbs: [['/admin/hr/advances', tr('adv|Salary advances')], [null, a.ref]], active: '/admin/hr/advances',
      body: `<div class="grid grid--side"><div class="stack">${ui.card(nm(a), facts, { action: badge(advanceOf(a.id).status) })}${ui.card(tr('adv|Repayments'), `<ul class="list adv-plan">${lines.join('')}</ul>`)}</div><div class="stack">${cashForm}${cancel}</div></div>`,
    });
  });
  router.post('/hr/advances/:id/repay', RH, (req, res, next) => {
    const a = advanceOf(h.int(req.params.id));
    if (!a) return next();
    const amount = r2(Math.min(h.numv(req.body.amount) || 0, remaining(a)));
    if (!(amount > 0)) return h.back(req, res, `/admin/hr/advances/${a.id}`, 'error', tr('adv|Enter the amount repaid.'));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || '')) ? req.body.date : M.today();
    const rid = Number(db.run("INSERT INTO hr_advance_repayments (advance_id, amount, source, paid_on, user_id, created_at) VALUES (?, ?, 'cash', ?, ?, ?)", a.id, amount, date, req.user.id, now()).lastInsertRowid);
    const L = ledger();
    if (L) book(`Salary advance ${a.ref} repaid in cash`, [{ account: cashAccount(L, 'cash'), debit: amount }, { account: 'other_receivables', credit: amount }], { date, source: `advance-repaid:${rid}`, user: req.user });
    refresh(a);
    // a draft payroll replans what is left
    for (const run of db.all("SELECT * FROM payroll_runs WHERE status = 'draft'")) if (h.hrRecalc) h.hrRecalc(run);
    h.log(req, 'Recorded an advance repayment', 'employee', a.employee_id, `${a.ref} · ${amount}`);
    h.back(req, res, `/admin/hr/advances/${a.id}`, 'ok', tr('adv|Repayment recorded.'));
  });
  router.post('/hr/advances/:id/cancel', RH, (req, res, next) => {
    const a = advanceOf(h.int(req.params.id));
    if (!a) return next();
    if (a.status !== 'active' || repaid(a)) return h.back(req, res, `/admin/hr/advances/${a.id}`, 'error', tr('adv|Only an advance with nothing repaid can be cancelled.'));
    db.tx(() => {
      db.run("UPDATE hr_advances SET status = 'cancelled' WHERE id = ?", a.id);
      db.run('DELETE FROM hr_advance_repayments WHERE advance_id = ?', a.id);
      const L = ledger();
      if (L && L.unpost) { try { L.unpost(`advance:${a.id}`, { memo: `Salary advance ${a.ref} cancelled` }); } catch { /* not posted */ } }
    });
    for (const run of db.all("SELECT * FROM payroll_runs WHERE status = 'draft'")) if (h.hrRecalc) h.hrRecalc(run);
    h.log(req, 'Cancelled a salary advance', 'employee', a.employee_id, a.ref);
    h.back(req, res, `/admin/hr/advances/${a.id}`, 'ok', tr('adv|Advance cancelled.'));
  });

  // the employee's file: their advances
  (h.employeeCards = h.employeeCards || []).push((req, e) => {
    const list = db.all('SELECT * FROM hr_advances WHERE employee_id = ? ORDER BY issued_on DESC LIMIT 10', e.id);
    const add = e.status === 'active' ? ui.btn(esc(tr('adv|New advance')), { href: `/admin/hr/advances?employee=${e.id}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '';
    if (!list.length) return add ? ui.card(tr('adv|Salary advances'), `<p class="muted pad">${esc(tr('adv|No advances.'))}</p>`, { action: add }) : '';
    return ui.card(tr('adv|Salary advances'), `<ul class="list">${list.map((a) => `<li><a href="/admin/hr/advances/${a.id}"><span class="what"><b>${ui.money(a.amount)}</b><small>${esc(ui.date(a.issued_on))} · ${esc(tr('adv|{amount} left', { amount: ui.money(remaining(a)) }))}</small></span>${badge(a.status)}</a></li>`).join('')}</ul>`, { action: add });
  });
};

module.exports.STATUS = STATUS;
