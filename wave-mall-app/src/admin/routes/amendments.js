'use strict';

// Lease amendments, renewals and the end-of-lease settlement.
//
//   Addenda       numbered per lease (Addendum 1, 2…) with an effective date, a reason and the signed
//                 copy: a new rent from a date (escalations go on from there), units added or given
//                 back, the term extended, the service charge or VAT changed. Shown as a preview first;
//                 applying it voids the unpaid rent invoices of billing periods starting on or after
//                 the effective date and issues them again on the new terms. Paid and part-paid
//                 invoices are never touched.
//   Options       renewal options and break clauses with their notice deadline; the office is emailed
//                 90, 60 and 30 days before each deadline, and an option lapses once it passes.
//   Renewals      an offer of new terms → accepted → a new draft lease linked to this one (the deposit
//                 carries over), or an extension of this lease (an addendum, applied at once).
//   Settlement    at the end: what is owed (invoices, late charges, typed deductions for damage or
//                 missing items) against the deposit held; the deposit pays what is owed and the rest
//                 is refunded (approvals kind 'refund' when a rule asks), or the tenant owes the
//                 difference. Printable in English and Arabic. Closing it ends the lease.

const i18n = require('../i18n');
const TM = require('../terms');
const { registerDocs, uploadRoute } = require('../ops-common');

const { t: tr, tn } = i18n;

const SCHEMA = `
  ALTER TABLE leases ADD COLUMN renewed_from INTEGER;
  CREATE TABLE lease_amendments (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE, n INTEGER NOT NULL,
    effective_date TEXT NOT NULL, reason TEXT, changes TEXT NOT NULL, before TEXT, status TEXT NOT NULL DEFAULT 'draft',
    voided INTEGER NOT NULL DEFAULT 0, issued INTEGER NOT NULL DEFAULT 0, applied_at TEXT, applied_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX lease_amendments_lease ON lease_amendments(lease_id, n);
  CREATE TABLE lease_options (
    id INTEGER PRIMARY KEY, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE, kind TEXT NOT NULL, party TEXT NOT NULL DEFAULT 'tenant',
    notice_by TEXT NOT NULL, effective_on TEXT, terms TEXT, status TEXT NOT NULL DEFAULT 'open', alerts TEXT NOT NULL DEFAULT '', decided_on TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX lease_options_due ON lease_options(status, notice_by);
  CREATE TABLE lease_renewals (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'lease',
    status TEXT NOT NULL DEFAULT 'offered', start_date TEXT NOT NULL, months INTEGER NOT NULL, rent_m2 REAL NOT NULL, terrace_rent_m2 REAL NOT NULL DEFAULT 0,
    escalation_pct REAL NOT NULL DEFAULT 0, service_m2 REAL, payment_freq TEXT, deposit_topup REAL NOT NULL DEFAULT 0, carry_deposit INTEGER NOT NULL DEFAULT 1,
    valid_until TEXT, note TEXT, new_lease_id INTEGER REFERENCES leases(id) ON DELETE SET NULL, amendment_id INTEGER, notice_id INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, decided_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE lease_settlements (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE, last_day TEXT NOT NULL, how TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', charge_penalties INTEGER NOT NULL DEFAULT 1, deductions TEXT, deposit_held REAL NOT NULL DEFAULT 0,
    outstanding REAL NOT NULL DEFAULT 0, penalties REAL NOT NULL DEFAULT 0, deductions_total REAL NOT NULL DEFAULT 0, applied REAL NOT NULL DEFAULT 0,
    refund REAL NOT NULL DEFAULT 0, carried REAL NOT NULL DEFAULT 0, due REAL NOT NULL DEFAULT 0, refund_method TEXT, refund_ref TEXT, refunded_at TEXT,
    approval_id INTEGER, deduction_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, done_by INTEGER REFERENCES users(id) ON DELETE SET NULL, done_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
`;

const A_STATUS = { draft: ['amd|Draft', 'mute'], applied: ['amd|Applied', 'ok'], cancelled: ['amd|Cancelled', 'rose'] };
const O_KIND = { renewal: 'amd|Renewal option', break: 'amd|Break clause' };
const O_PARTY = { tenant: 'amd|Tenant', landlord: 'amd|The Wave', either: 'amd|Either side' };
const O_STATUS = { open: ['amd|Open', 'sky'], exercised: ['amd|Exercised', 'ok'], waived: ['amd|Not used', 'mute'], lapsed: ['amd|Lapsed', 'rose'] };
const R_STATUS = { offered: ['amd|Offered', 'amber'], accepted: ['amd|Accepted', 'ok'], declined: ['amd|Declined', 'rose'], withdrawn: ['amd|Withdrawn', 'mute'] };
const S_STATUS = { draft: ['amd|Draft', 'mute'], refund_pending: ['amd|Refund awaiting approval', 'amber'], done: ['amd|Settled', 'ok'] };
const ALERT_DAYS = [90, 60, 30];

module.exports = function amendments(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  TM.ensure(db);
  db.ensure('amendments-1', SCHEMA);
  const esc = ui.esc;
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const today = () => M.today();
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const dayDiff = (a, b) => Math.round((Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`)) / 864e5);
  const badgeOf = (map, s) => ui.badge(s, tr((map[s] || [s])[0]), (map[s] || [])[1]);
  const tmap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tr(Array.isArray(v) ? v[0] : v)]));
  const enMoney = (n) => i18n.run('en', () => ui.money(n));
  const enDate = (d) => i18n.run('en', () => ui.date(d));
  const json = (s, d) => {
    try {
      return s ? JSON.parse(s) : d;
    } catch {
      return d;
    }
  };
  const docLang = (req) => (['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en');
  const docSwitch = (path, l) => (l === 'ar'
    ? `<a class="langbtn" href="${path}?doc=en" lang="en">${ui.icon('globe')}<span>English</span></a>`
    : `<a class="langbtn" href="${path}?doc=ar" lang="ar">${ui.icon('globe')}<span>العربية</span></a>`);
  h.auditTyped = h.auditTyped || [];
  h.auditTyped.push('SELECT reason FROM lease_amendments', 'SELECT terms FROM lease_options', 'SELECT note FROM lease_renewals', 'SELECT notes, deductions FROM lease_settlements');

  const leaseOf = (id) => db.get('SELECT s.*, b.name brand_name FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.id = ?', id);

  // ---------- months and plans ----------
  // whole months from a to b (b exclusive), e.g. 2026-01-01 → 2031-01-01 = 60
  const monthsBetween = (a, b) => {
    const [ya, ma, da] = a.split('-').map(Number);
    const [yb, mb, db2] = b.split('-').map(Number);
    return (yb - ya) * 12 + (mb - ma) + (db2 - da) / 30;
  };
  const termMonths = (s) => Math.max(1, Math.round(monthsBetween(s.start_date, M.addDays(s.end_date, 1))));
  const yearIndex = (s, date) => Math.max(0, Math.floor(monthsBetween(s.start_date, date) / 12 + 1e-9));
  const stepOf = (s) => (s.payment_freq === 'monthly' ? 1 : s.payment_freq === 'annual' ? 12 : 3);
  // the rent invoices of the whole term, the last one cut short when the term ends inside it
  function planFor(s, units) {
    const months = termMonths(s);
    const step = stepOf(s);
    return M.invoicePlan({ ...s, term_years: Math.ceil(months / 12) }, units).filter((p) => p.period_start <= s.end_date).map((p) => {
      if (p.period_end <= s.end_date) return p;
      const f = Math.min(1, Math.max(0, monthsBetween(p.period_start, M.addDays(s.end_date, 1)) / step));
      return { ...p, period_end: s.end_date, rent: Math.round(p.rent * f), service: Math.round(p.service * f) };
    });
  }
  // the rent per m² a lease charges on a date (after increases)
  const rateOn = (s, date) => r2((s.rent_m2 || 0) * TM.factor(s, yearIndex(s, date)));

  // ---------- addenda ----------
  const unitsOf = (ids) => (ids.length ? db.all(`SELECT * FROM units WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : []);
  // what an addendum does: the lease and units after it, the invoices voided and those issued again
  function impact(s, a) {
    const c = typeof a.changes === 'string' ? json(a.changes, {}) : a.changes || {};
    const eff = a.effective_date;
    const next = { ...s };
    const warnings = [];
    if (c.rent) {
      const f = TM.factor(s, yearIndex(s, eff));
      if (c.rent.rate !== null && c.rent.rate !== undefined) {
        const old = s.rent_m2 || 0;
        next.rent_m2 = r2(c.rent.rate / f);
        if (c.rent.terrace === null || c.rent.terrace === undefined) next.terrace_rent_m2 = old > 0 ? r2((s.terrace_rent_m2 || 0) * (next.rent_m2 / old)) : s.terrace_rent_m2;
      }
      if (c.rent.terrace !== null && c.rent.terrace !== undefined) next.terrace_rent_m2 = r2(c.rent.terrace / f);
      if (c.rent.min_guarantee !== null && c.rent.min_guarantee !== undefined) next.min_guarantee = r2(c.rent.min_guarantee / f);
    }
    if (c.service) {
      next.service_mode = c.service.mode === 'pct' ? 'pct' : 'm2';
      if (next.service_mode === 'pct') { next.service_pct = c.service.pct ?? s.service_pct; next.service_m2 = 0; } else { next.service_m2 = c.service.m2 ?? s.service_m2; next.service_pct = 0; }
    }
    if (c.vat) {
      if (c.vat.pct !== null && c.vat.pct !== undefined) next.vat_pct = c.vat.pct;
      if (c.vat.included !== null && c.vat.included !== undefined) next.vat_included = c.vat.included ? 1 : 0;
    }
    if (c.extend_months > 0) {
      const months = termMonths(s) + c.extend_months;
      next.end_date = M.addDays(M.addMonths(s.start_date, months), -1);
      next.term_years = Math.ceil(months / 12);
    }
    const current = M.leaseUnits(db, s.id);
    const remove = new Set((c.remove_units || []).map(Number));
    const add = unitsOf((c.add_units || []).map(Number)).filter((u) => !current.some((x) => x.id === u.id));
    const units = [...current.filter((u) => !remove.has(u.id)), ...add];
    if (!units.length) warnings.push('amd|A lease keeps at least one unit.');
    for (const u of add) if (u.status === 'leased') warnings.push(tr('amd|{code} is leased to someone else.', { code: u.code }));
    // invoices: unpaid rent from the effective date is issued again; paid and part-paid stay
    const inv = db.all("SELECT * FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status != 'void' ORDER BY period_start", s.id);
    const from = (i) => i.period_start || i.due_date;
    const voids = inv.filter((i) => from(i) >= eff && i.status === 'open' && !i.paid);
    const kept = inv.filter((i) => !voids.includes(i));
    if (kept.some((i) => from(i) >= eff)) warnings.push('amd|Some invoices after the effective date are already paid or part paid. They stay as they are; settle any difference with a charge.');
    const issues = s.status === 'active' ? planFor(next, units).filter((p) => p.period_start >= eff && p.rent + p.service > 0 && !kept.some((i) => from(i) === p.period_start)) : [];
    return { changes: c, lease: next, units, add, remove: current.filter((u) => remove.has(u.id)), voids, issues, warnings };
  }
  function describeChanges(s, a) {
    const c = typeof a.changes === 'string' ? json(a.changes, {}) : a.changes || {};
    const out = [];
    // the rent it replaced is kept with the addendum (the lease itself changes when it is applied)
    if (c.rent && c.rent.rate !== null && c.rent.rate !== undefined) out.push(tr('amd|Rent {from} → {to} per m² a month', { from: ui.money(c.rent.from ?? rateOn(s, a.effective_date), { cur: false }), to: ui.money(c.rent.rate) }));
    if (c.rent && c.rent.terrace !== null && c.rent.terrace !== undefined) out.push(tr('amd|Terrace rent {to} per m² a month', { to: ui.money(c.rent.terrace) }));
    if (c.rent && c.rent.min_guarantee !== null && c.rent.min_guarantee !== undefined) out.push(tr('amd|Minimum guarantee {to} a month', { to: ui.money(c.rent.min_guarantee) }));
    if (c.add_units && c.add_units.length) out.push(tr('amd|Units added: {codes}', { codes: unitsOf(c.add_units.map(Number)).map((u) => u.code).join(', ') }));
    if (c.remove_units && c.remove_units.length) out.push(tr('amd|Units given back: {codes}', { codes: unitsOf(c.remove_units.map(Number)).map((u) => u.code).join(', ') }));
    if (c.extend_months > 0) out.push(tn(c.extend_months, 'amd|Term extended by {n} month', 'amd|Term extended by {n} months'));
    if (c.service) out.push(c.service.mode === 'pct' ? tr('amd|Service charge {pct}% of the rent', { pct: c.service.pct }) : tr('amd|Service charge {amount} per m² a month', { amount: ui.money(c.service.m2) }));
    if (c.vat && c.vat.pct !== null && c.vat.pct !== undefined) out.push(tr(c.vat.included ? 'amd|VAT {pct}%, included' : 'amd|VAT {pct}%, added', { pct: c.vat.pct }));
    else if (c.vat && c.vat.included !== null && c.vat.included !== undefined) out.push(tr(c.vat.included ? 'amd|Amounts include VAT' : 'amd|VAT added to the amounts'));
    return out;
  }
  function applyAmendment(a, { user = null } = {}) {
    const s = leaseOf(a.lease_id);
    if (!s || a.status !== 'draft') throw new Error('amd|Only a draft addendum can be applied.');
    if (s.status !== 'active') throw new Error('amd|Only an active lease can be amended.');
    const x = impact(s, a);
    if (!x.units.length) throw new Error('amd|A lease keeps at least one unit.');
    const taken = x.add.find((u) => u.status === 'leased');
    if (taken) throw new Error(tr('amd|{code} is leased to someone else.', { code: taken.code }));
    const L = x.lease;
    const before = { rent_m2: s.rent_m2, terrace_rent_m2: s.terrace_rent_m2, min_guarantee: s.min_guarantee, service_mode: s.service_mode, service_m2: s.service_m2, service_pct: s.service_pct, vat_pct: s.vat_pct, vat_included: s.vat_included, end_date: s.end_date, term_years: s.term_years, units: M.leaseUnits(db, s.id).map((u) => u.code) };
    db.tx(() => {
      db.run('UPDATE leases SET rent_m2 = ?, terrace_rent_m2 = ?, min_guarantee = ?, service_mode = ?, service_m2 = ?, service_pct = ?, vat_pct = ?, vat_included = ?, end_date = ?, term_years = ? WHERE id = ?',
        L.rent_m2, L.terrace_rent_m2, L.min_guarantee, L.service_mode, L.service_m2, L.service_pct, L.vat_pct, L.vat_included, L.end_date, L.term_years, s.id);
      for (const u of x.remove) {
        db.run('DELETE FROM lease_units WHERE lease_id = ? AND unit_id = ?', s.id, u.id);
        db.run("UPDATE units SET status = 'available', updated_at = ? WHERE id = ?", M.now(), u.id);
      }
      for (const u of x.add) {
        db.run('INSERT OR IGNORE INTO lease_units (lease_id, unit_id) VALUES (?, ?)', s.id, u.id);
        db.run("UPDATE units SET status = 'leased', hold_until = NULL, hold_lead_id = NULL, updated_at = ? WHERE id = ?", M.now(), u.id);
      }
      for (const i of x.voids) h.billing.voidInvoice(i.id, { user, note: `Replaced by addendum ${a.ref}` });
      for (const p of x.issues) h.billing.createInvoice({ lease_id: s.id, kind: 'rent', period_start: p.period_start, period_end: p.period_end, due_date: p.due_date, rent: p.rent, service: p.service, demo: s.demo }, { user });
      db.run("UPDATE lease_amendments SET status = 'applied', before = ?, voided = ?, issued = ?, applied_at = ?, applied_by = ? WHERE id = ?", JSON.stringify(before), x.voids.length, x.issues.length, now(), user ? user.id : null, a.id);
    });
    if (h.tenantNotify) {
      h.tenantNotify(s.brand_id, { kind: 'lease', title: 'amd|Addendum {n} to lease {ref}', body: 'amd|Addendum {n} to your lease {ref} takes effect on {date}. Your invoices from that date were updated; you can see them in the portal.', params: { n: a.n, ref: s.ref, date: enDate(a.effective_date), iso: a.effective_date }, link: '/portal/invoices', entity: 'lease', entity_id: s.id, demo: s.demo });
    }
    return db.get('SELECT * FROM lease_amendments WHERE id = ?', a.id);
  }
  function createAmendment(s, { effective_date, reason, changes }, { user = null, demo = 0 } = {}) {
    const n = (db.value('SELECT MAX(n) FROM lease_amendments WHERE lease_id = ?', s.id) || 0) + 1;
    if (changes.rent && changes.rent.rate !== null && changes.rent.rate !== undefined) changes = { ...changes, rent: { ...changes.rent, from: rateOn(s, effective_date) } };
    return Number(db.run('INSERT INTO lease_amendments (ref, lease_id, n, effective_date, reason, changes, status, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      db.nextRef('lease_amendments', 'AM', 4, true), s.id, n, effective_date, reason || null, JSON.stringify(changes), 'draft', user ? user.id : null, demo ? 1 : 0, now()).lastInsertRowid);
  }

  registerDocs(M, 'lease_amendment', 'amd|Lease addendum', { addendum_signed: 'amd|Signed addendum' });
  registerDocs(M, 'lease_settlement', 'amd|End-of-lease settlement', { handover_report: 'amd|Handover report', settlement_signed: 'amd|Signed settlement', damage_photos: 'amd|Photos of damage' });
  const amdDocs = uploadRoute(router, h, '/leases/amendments/upload', { lease_amendment: 'lease_amendments' });
  const stlDocs = uploadRoute(router, h, '/leases/settlements/upload', { lease_settlement: 'lease_settlements' });

  router.get('/leases/:id/amend', R('manager'), (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    if (!s) return next();
    if (s.status !== 'active') return h.back(req, res, `/admin/leases/${s.id}`, 'error', tr('amd|Only an active lease can be amended.'));
    const units = M.leaseUnits(db, s.id);
    const free = db.all("SELECT * FROM units WHERE status IN ('available','hold') ORDER BY code LIMIT 120");
    const t = today();
    const nextPeriod = (db.get("SELECT period_start FROM invoices WHERE lease_id = ? AND kind = 'rent' AND status = 'open' AND paid = 0 AND period_start >= ? ORDER BY period_start LIMIT 1", s.id, t) || {}).period_start || t;
    const guarantee = s.revenue_share && s.min_guarantee;
    const form = ui.form(`/admin/leases/${s.id}/amendments`, req.session.csrf, `<div class="fields">
        ${ui.input('effective_date', tr('amd|Effective from'), nextPeriod, { type: 'date', required: true, hint: tr('amd|Changes apply to billing periods that start on or after this date.') })}
        ${ui.input('reason', tr('amd|Reason'), '', { cls: 'span-all', placeholder: tr('amd|e.g. Tenant takes the unit next door; rent reviewed') })}
      </div>
      <fieldset class="amd-set"><legend>${esc(tr('Rent'))}</legend><div class="fields">
        ${ui.input('rate', tr('amd|New rent per m² a month'), '', { type: 'number', min: 0, step: '0.01', placeholder: String(rateOn(s, t)), hint: tr('amd|Now {amount}. Yearly increases carry on from the new rent.', { amount: ui.money(rateOn(s, t)) }) })}
        ${ui.input('terrace', tr('amd|New terrace rent per m²'), '', { type: 'number', min: 0, step: '0.01', hint: tr('amd|Blank: changes in step with the rent.') })}
        ${guarantee ? ui.input('min_guarantee', tr('amd|New minimum guarantee a month'), '', { type: 'number', min: 0, step: '0.01', placeholder: String(s.min_guarantee) }) : ''}
      </div></fieldset>
      <fieldset class="amd-set"><legend>${esc(tr('Units'))}</legend>
        <div class="amd-units">${units.map((u) => `<label class="check"><input type="checkbox" name="remove_units" value="${u.id}"><span>${esc(tr('amd|Give back {code}', { code: u.code }))} · ${ui.m2(u.indoor_m2)}</span></label>`).join('')}</div>
        ${free.length ? `<label class="f"><span class="f__l">${esc(tr('amd|Add units'))}</span><select name="add_units" multiple size="5">${free.map((u) => `<option value="${u.id}">${esc(`${u.code} · ${ui.m2(u.indoor_m2)}`)}</option>`).join('')}</select><small>${esc(tr('amd|Hold Ctrl or ⌘ to choose more than one.'))}</small></label>` : ''}
      </fieldset>
      <fieldset class="amd-set"><legend>${esc(tr('Term'))}</legend><div class="fields">
        ${ui.input('extend_months', tr('amd|Extend by (months)'), '', { type: 'number', min: 0, max: 120, hint: tr('amd|Ends {date} now.', { date: ui.date(s.end_date) }) })}
      </div></fieldset>
      <fieldset class="amd-set"><legend>${esc(tr('amd|Service charge and VAT'))}</legend><div class="fields">
        ${ui.select('service_mode', tr('Service charge'), { m2: tr('amd|Per m² a month'), pct: tr('amd|A share of the rent') }, '', { blank: tr('amd|No change') })}
        ${ui.input('service_value', tr('amd|Amount per m², or %'), '', { type: 'number', min: 0, step: '0.01' })}
        ${ui.input('vat_pct', tr('amd|VAT %'), '', { type: 'number', min: 0, max: 100, step: '0.01', placeholder: String(s.vat_pct ?? db.setting('vat_pct') ?? '') })}
        ${ui.select('vat_included', tr('amd|Amounts'), { 0: tr('amd|VAT added'), 1: tr('amd|VAT included') }, '', { blank: tr('amd|No change') })}
      </div></fieldset>
      ${ui.btn(esc(tr('amd|Preview the addendum')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    h.page(req, res, { title: tr('amd|New addendum'), crumbs: [['/admin/leases', tr('Leases')], [`/admin/leases/${s.id}`, s.brand_name], [null, tr('amd|New addendum')]], active: '/admin/leases', body: `<div class="grid grid--side"><div>${ui.card(tr('amd|What changes'), form, { sub: esc(tr('amd|Leave blank what stays the same. You see the effect on the invoices before anything changes.')) })}</div><div>${ui.card(s.ref, `<dl class="dl"><div><dt>${esc(tr('Units'))}</dt><dd>${esc(units.map((u) => u.code).join(', '))}</dd></div><div><dt>${esc(tr('amd|Rent now'))}</dt><dd>${esc(tr('amd|{amount} per m² a month', { amount: ui.money(rateOn(s, t)) }))}</dd></div><div><dt>${esc(tr('Increase'))}</dt><dd>${esc(TM.describe(s, tr))}</dd></div><div><dt>${esc(tr('Term'))}</dt><dd>${esc(ui.date(s.start_date))} – ${esc(ui.date(s.end_date))}</dd></div></dl>`)}</div></div>` });
  });
  router.post('/leases/:id/amendments', R('manager'), (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    if (!s) return next();
    const b = req.body;
    const back = `/admin/leases/${s.id}/amend`;
    if (s.status !== 'active') return h.back(req, res, `/admin/leases/${s.id}`, 'error', tr('amd|Only an active lease can be amended.'));
    const eff = isDate(b.effective_date) ? b.effective_date : null;
    if (!eff || eff < s.start_date || eff > s.end_date) return h.back(req, res, back, 'error', tr('amd|The effective date must fall within the lease term.'));
    const n = (k) => { const v = h.numv(b[k]); return v === null || v < 0 ? null : v; };
    const changes = {};
    if (n('rate') !== null || n('terrace') !== null || n('min_guarantee') !== null) changes.rent = { rate: n('rate'), terrace: n('terrace'), min_guarantee: n('min_guarantee') };
    const current = M.leaseUnits(db, s.id).map((u) => u.id);
    const remove = h.list(b.remove_units).map(Number).filter((x) => current.includes(x));
    const add = h.list(b.add_units).map(Number).filter((x) => x && !current.includes(x));
    if (remove.length) changes.remove_units = remove;
    if (add.length) changes.add_units = add;
    const ext = Math.min(120, Math.max(0, h.int(b.extend_months) || 0));
    if (ext) changes.extend_months = ext;
    if (['m2', 'pct'].includes(b.service_mode) && n('service_value') !== null) changes.service = b.service_mode === 'pct' ? { mode: 'pct', pct: Math.min(100, n('service_value')) } : { mode: 'm2', m2: n('service_value') };
    if (n('vat_pct') !== null || ['0', '1'].includes(b.vat_included)) changes.vat = { pct: n('vat_pct') === null ? null : Math.min(100, n('vat_pct')), included: ['0', '1'].includes(b.vat_included) ? b.vat_included === '1' : null };
    if (!Object.keys(changes).length) return h.back(req, res, back, 'error', tr('amd|Nothing changes. Fill in at least one change.'));
    if (remove.length && remove.length === current.length && !add.length) return h.back(req, res, back, 'error', tr('amd|A lease keeps at least one unit.'));
    const id = createAmendment(s, { effective_date: eff, reason: h.str(b.reason, 500), changes }, { user: req.user });
    h.log(req, 'Drafted a lease addendum', 'lease', s.id, `${s.ref} · ${Object.keys(changes).join(', ')}`);
    h.back(req, res, `/admin/leases/${s.id}/amendments/${id}`, 'ok', tr('amd|Addendum drafted. Check its effect, then apply it.'));
  });
  const amendmentOf = (leaseId, id) => db.get('SELECT a.*, u.name by_name, p.name applied_name FROM lease_amendments a LEFT JOIN users u ON u.id = a.created_by LEFT JOIN users p ON p.id = a.applied_by WHERE a.id = ? AND a.lease_id = ?', id, leaseId);
  router.get('/leases/:id/amendments/:aid', (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    const a = s && amendmentOf(s.id, h.int(req.params.aid));
    if (!a) return next();
    const csrf = req.session.csrf;
    const x = a.status === 'draft' ? impact(s, a) : null;
    const lines = describeChanges(s, a);
    const before = json(a.before, null);
    const invTable = (rows, empty, totalLabel) => ui.table([
      { label: tr('amd|Period'), render: (p) => `${esc(ui.date(p.period_start))} – ${esc(ui.date(p.period_end))}${p.ref ? `<small class="sub"><bdi>${esc(p.ref)}</bdi></small>` : ''}` },
      { label: tr('Rent'), num: true, render: (p) => ui.money(p.rent, { cur: false }) },
      { label: tr('Service'), num: true, render: (p) => ui.money(p.service, { cur: false }) },
      { label: totalLabel, num: true, render: (p) => `<b>${ui.money(p.total ?? p.rent + p.service, { cur: false })}</b>` },
    ], rows, { empty: esc(empty) });
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('amd|Addendum'))}</dt><dd><b>${esc(tr('amd|Addendum {n}', { n: a.n }))}</b> · <bdi>${esc(a.ref)}</bdi></dd></div>
      <div><dt>${esc(tr('amd|Effective from'))}</dt><dd>${esc(ui.date(a.effective_date))}</dd></div>
      <div><dt>${esc(tr('amd|Changes'))}</dt><dd>${lines.map((l) => `<span class="amd-chg">${esc(l)}</span>`).join('')}</dd></div>
      ${a.reason ? `<div><dt>${esc(tr('amd|Reason'))}</dt><dd>${esc(a.reason)}</dd></div>` : ''}
      <div><dt>${esc(tr('Status'))}</dt><dd>${badgeOf(A_STATUS, a.status)}${a.applied_at ? ` <small class="muted">${esc(ui.dt(a.applied_at))}${a.applied_name ? ` · ${esc(a.applied_name)}` : ''}</small>` : ''}</dd></div>
      ${a.status === 'applied' ? `<div><dt>${esc(tr('Invoices'))}</dt><dd>${esc(tr('amd|{v} voided, {i} issued again', { v: a.voided, i: a.issued }))}</dd></div>` : ''}
      ${before ? `<div><dt>${esc(tr('amd|Before'))}</dt><dd><small>${esc(tr('amd|Units {units} · ends {date}', { units: (before.units || []).join(', '), date: ui.date(before.end_date) }))}</small></dd></div>` : ''}
      <div><dt>${esc(tr('amd|Drafted'))}</dt><dd>${esc(ui.dt(a.created_at))}${a.by_name ? ` · ${esc(a.by_name)}` : ''}</dd></div>
    </dl>`;
    const warn = x && x.warnings.length ? `<div class="flash flash--error amd-warn">${x.warnings.map((w) => `<p>${esc(tr(w))}</p>`).join('')}</div>` : '';
    const acts = a.status === 'draft' && h.can(req, 'manager') ? `<div class="row">${ui.form(`/admin/leases/${s.id}/amendments/${a.id}/apply`, csrf, ui.btn(esc(tr('amd|Apply the addendum')), { cls: 'btn--primary', ic: 'check', attrs: { 'data-confirm': tr('amd|Apply? {v} unpaid invoices are voided and {i} issued on the new terms.', { v: x.voids.length, i: x.issues.length }) } }))}${ui.form(`/admin/leases/${s.id}/amendments/${a.id}/cancel`, csrf, ui.btn(esc(tr('amd|Cancel the draft')), { cls: 'btn--ghost' }))}</div>` : '';
    const body = `${warn}<div class="grid grid--side"><div class="stack">${x ? `${ui.card(tr('amd|Invoices voided'), invTable(x.voids, tr('amd|No unpaid invoices are affected.'), tr('Total')), { sub: esc(tr('amd|Unpaid rent invoices of periods from the effective date.')) })}${ui.card(tr('amd|Invoices issued on the new terms'), invTable(x.issues, tr('amd|No new invoices.'), tr('amd|Before VAT')), { sub: esc(tr('amd|VAT is added as the lease says when they are issued.')) })}` : ''}${amdDocs(req, 'lease_amendment', a.id, { title: tr('amd|Signed addendum') })}</div><div class="stack">${ui.card(s.brand_name, facts)}${acts ? ui.card(tr('amd|Apply'), acts) : ''}</div></div>`;
    h.page(req, res, { title: tr('amd|Addendum {n}', { n: a.n }), crumbs: [['/admin/leases', tr('Leases')], [`/admin/leases/${s.id}`, s.brand_name], [null, a.ref]], active: '/admin/leases', body, actions: ui.btn(esc(tr('Print')), { href: `/admin/leases/${s.id}/amendments/${a.id}/print`, cls: 'btn--ghost', ic: 'print', attrs: { target: '_blank' } }) });
  });
  router.post('/leases/:id/amendments/:aid/apply', R('manager'), (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    const a = s && amendmentOf(s.id, h.int(req.params.aid));
    if (!a) return next();
    let done;
    try {
      done = applyAmendment(a, { user: req.user });
    } catch (e) {
      return h.back(req, res, `/admin/leases/${s.id}/amendments/${a.id}`, 'error', tr(e.message));
    }
    h.log(req, 'Applied a lease addendum', 'lease', s.id, `${s.ref} · ${a.ref} · ${done.voided} voided, ${done.issued} issued`);
    h.back(req, res, `/admin/leases/${s.id}`, 'ok', tr('amd|Addendum {n} applied. {v} invoices voided, {i} issued on the new terms. The tenant was told.', { n: a.n, v: done.voided, i: done.issued }));
  });
  router.post('/leases/:id/amendments/:aid/cancel', R('manager'), (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    const a = s && amendmentOf(s.id, h.int(req.params.aid));
    if (!a) return next();
    if (a.status === 'draft') db.run("UPDATE lease_amendments SET status = 'cancelled' WHERE id = ?", a.id);
    h.back(req, res, `/admin/leases/${s.id}`, 'ok', tr('amd|Draft cancelled.'));
  });
  router.get('/leases/:id/amendments/:aid/print', (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    const a = s && amendmentOf(s.id, h.int(req.params.aid));
    if (!a) return next();
    const lang = docLang(req);
    const self = `/admin/leases/${s.id}/amendments/${a.id}/print`;
    const html = i18n.run(lang, () => {
      const set = db.settings();
      const units = M.leaseUnits(db, s.id);
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${esc(tr('Print or save as PDF'))}</span></button><a class="btn btn--ghost" href="/admin/leases/${s.id}/amendments/${a.id}">${esc(tr('Back'))}</a>${docSwitch(self, lang)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${esc(tr('amd|Lease addendum'))}</p><p class="doc__ref">${esc(tr('amd|Addendum {n}', { n: a.n }))} · <bdi>${esc(a.ref)}</bdi></p></div></header>
  <section class="doc__to"><p class="eyebrow">${esc(tr('Tenant'))}</p><h1>${esc(s.brand_name)}</h1><p>${esc(tr('amd|To lease {ref}, units {codes}, signed {date}.', { ref: s.ref, codes: units.map((u) => u.code).join(', '), date: ui.date(s.signed_at || s.start_date) }))}</p></section>
  <p>${esc(tr('amd|The parties agree that, from {date}, the lease is changed as follows. Everything else in the lease stays as it is.', { date: ui.date(a.effective_date) }))}</p>
  <ol class="amd-doc">${describeChanges(s, a).map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
  ${a.reason ? `<p class="doc__small">${esc(a.reason)}</p>` : ''}
  <div class="doc__sign"><div><p>${esc(tr('amd|For The Wave'))}</p><span></span></div><div><p>${esc(tr('amd|For the tenant'))}</p><span></span></div></div>
  <p class="doc__foot">${esc(i18n.tx(set.legal_name))} · ${esc(i18n.tx(set.address))} · ${esc(set.leasing_email)}</p>
</main>`;
      return ui.bare({ title: `${a.ref} · ${s.brand_name}`, body, cls: 'print' });
    });
    res.type('html').send(html);
  });

  // ---------- options (renewal, break) ----------
  router.post('/leases/:id/options', R('manager'), (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    if (!s) return next();
    const b = req.body;
    const back = `/admin/leases/${s.id}#options`;
    if (!isDate(b.notice_by)) return h.back(req, res, back, 'error', tr('amd|Set the last day to give notice.'));
    db.run('INSERT INTO lease_options (lease_id, kind, party, notice_by, effective_on, terms, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      s.id, O_KIND[b.kind] ? b.kind : 'renewal', O_PARTY[b.party] ? b.party : 'tenant', b.notice_by, isDate(b.effective_on) ? b.effective_on : null, h.str(b.terms, 500) || null, b.notice_by < today() ? 'lapsed' : 'open', req.user.id, now());
    h.log(req, 'Added a lease option', 'lease', s.id, `${s.ref} · ${b.kind} · notice by ${b.notice_by}`);
    h.back(req, res, back, 'ok', tr('amd|Option added. The office is emailed 90, 60 and 30 days before the notice date.'));
  });
  router.post('/leases/options/:oid', R('manager'), (req, res, next) => {
    const o = db.get('SELECT * FROM lease_options WHERE id = ?', h.int(req.params.oid));
    if (!o) return next();
    const to = ['exercised', 'waived', 'open'].includes(req.body.status) ? req.body.status : null;
    if (to) db.run('UPDATE lease_options SET status = ?, decided_on = ? WHERE id = ?', to, to === 'open' ? null : today(), o.id);
    h.log(req, 'Updated a lease option', 'lease', o.lease_id, `${o.kind} · ${to}`);
    h.back(req, res, `/admin/leases/${o.lease_id}#options`, 'ok', tr('Saved.'));
  });
  function optionAlerts() {
    const t = today();
    db.run("UPDATE lease_options SET status = 'lapsed' WHERE status = 'open' AND notice_by < ?", t);
    for (const o of db.all("SELECT o.*, s.ref, s.brand_id, s.demo lease_demo, b.name brand_name, u.email owner_email FROM lease_options o JOIN leases s ON s.id = o.lease_id JOIN brands b ON b.id = s.brand_id LEFT JOIN users u ON u.id = o.created_by WHERE o.status = 'open' AND s.status = 'active'")) {
      const left = dayDiff(t, o.notice_by);
      const sent = String(o.alerts || '').split(',').filter(Boolean).map(Number);
      const due = ALERT_DAYS.filter((d) => left <= d && !sent.includes(d));
      if (!due.length) continue;
      const to = [...new Set([o.owner_email, db.setting('leasing_email')].filter(Boolean))];
      if (to.length && h.mail && typeof h.mail.send === 'function' && !o.demo && !o.lease_demo) {
        const what = o.kind === 'break' ? 'break clause' : 'renewal option';
        h.mail.send({ to, subject: `${o.brand_name}: ${what} notice due ${o.notice_by} (${left} days)`, text: `Lease ${o.ref} (${o.brand_name}) has a ${what} for the ${o.party === 'landlord' ? 'landlord' : o.party === 'either' ? 'either side' : 'tenant'}. Notice must be given by ${o.notice_by}, in ${left} days.${o.terms ? `\nTerms: ${o.terms}` : ''}`, related: { entity: 'lease', id: o.lease_id } });
      }
      db.run('UPDATE lease_options SET alerts = ? WHERE id = ?', [...sent, ...due].sort((a, b) => b - a).join(','), o.id);
    }
  }
  h.every('lease-options', 12 * 3600 * 1000, optionAlerts, { first: 12 * 60 * 1000 });

  // ---------- renewals ----------
  const renewalOf = (id) => db.get('SELECT r.*, s.ref lease_ref, s.brand_id, s.end_date lease_end, b.name brand_name FROM lease_renewals r JOIN leases s ON s.id = r.lease_id JOIN brands b ON b.id = s.brand_id WHERE r.id = ?', id);
  router.post('/leases/:id/renewals', R('manager'), (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    if (!s) return next();
    const b = req.body;
    const back = `/admin/leases/${s.id}#renewal`;
    const kind = b.kind === 'extension' ? 'extension' : 'lease';
    const months = Math.min(240, Math.max(1, h.int(b.months) || 12));
    const rate = h.numv(b.rent_m2);
    if (!(rate > 0)) return h.back(req, res, back, 'error', tr('amd|Enter the rent per m² offered.'));
    const start = M.addDays(s.end_date, 1);
    const id = Number(db.run(`INSERT INTO lease_renewals (ref, lease_id, kind, status, start_date, months, rent_m2, terrace_rent_m2, escalation_pct, service_m2, payment_freq, deposit_topup, carry_deposit, valid_until, note, created_by, created_at)
      VALUES (?, ?, ?, 'offered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, db.nextRef('lease_renewals', 'RN', 4, true), s.id, kind, start, months, rate, h.numv(b.terrace_rent_m2) ?? r2((s.terrace_rent_m2 || 0) * (rate / Math.max(0.01, rateOn(s, s.end_date)))),
    h.numv(b.escalation_pct) ?? s.escalation_pct, h.numv(b.service_m2) ?? s.service_m2, ['monthly', 'quarterly', 'annual'].includes(b.payment_freq) ? b.payment_freq : s.payment_freq,
    Math.max(0, h.numv(b.deposit_topup) || 0), b.carry_deposit === '0' ? 0 : 1, isDate(b.valid_until) ? b.valid_until : M.addDays(today(), 30), h.str(b.note, 500) || null, req.user.id, now()).lastInsertRowid);
    const r = renewalOf(id);
    if (b.send === '1' && h.tenantNotify) {
      const nid = h.tenantNotify(s.brand_id, { kind: 'lease', title: 'amd|Renewal offer for lease {ref}', body: 'amd|We would like to renew your lease {ref}: {months} months from {date} at {rate} per m² a month. The offer is open until {until}; reply to the leasing team to accept.', params: { ref: s.ref, months, date: enDate(start), iso: start, rate: enMoney(rate), until: enDate(r.valid_until) }, rows: [['amd|Starts', enDate(start)], ['amd|Months', String(months)], ['amd|Rent per m² a month', enMoney(rate)]], entity: 'lease', entity_id: s.id });
      db.run('UPDATE lease_renewals SET notice_id = ? WHERE id = ?', nid, id);
    }
    h.log(req, 'Offered a lease renewal', 'lease', s.id, `${r.ref} · ${kind} · ${months} months at ${rate}`);
    h.back(req, res, back, 'ok', b.send === '1' ? tr('amd|Renewal offered and sent to the tenant.') : tr('amd|Renewal offer saved.'));
  });
  router.post('/leases/renewals/:rid/:act', R('manager'), (req, res, next) => {
    const r = renewalOf(h.int(req.params.rid));
    if (!r || !['accept', 'decline', 'withdraw'].includes(req.params.act)) return next();
    const back = `/admin/leases/${r.lease_id}#renewal`;
    if (r.status !== 'offered') return h.back(req, res, back, 'error', tr('amd|This offer was already decided.'));
    if (req.params.act !== 'accept') {
      db.run('UPDATE lease_renewals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', req.params.act === 'decline' ? 'declined' : 'withdrawn', req.user.id, now(), r.id);
      h.log(req, `Renewal ${req.params.act === 'decline' ? 'declined' : 'withdrawn'}`, 'lease', r.lease_id, r.ref);
      return h.back(req, res, back, 'ok', tr('Saved.'));
    }
    const s = leaseOf(r.lease_id);
    let out;
    try {
      out = db.tx(() => {
        if (r.kind === 'extension') {
          // the same lease runs on: an addendum, applied now
          // the new rent applies from the day after the current end
          const aid = createAmendment(s, { effective_date: M.addDays(s.end_date, 1), reason: `Renewal ${r.ref}`, changes: { extend_months: r.months, rent: { rate: r.rent_m2, terrace: r.terrace_rent_m2, min_guarantee: null } } }, { user: req.user, demo: s.demo });
          const done = applyAmendment(db.get('SELECT * FROM lease_amendments WHERE id = ?', aid), { user: req.user });
          db.run("UPDATE lease_renewals SET status = 'accepted', amendment_id = ?, decided_by = ?, decided_at = ? WHERE id = ?", aid, req.user.id, now(), r.id);
          return { url: `/admin/leases/${s.id}/amendments/${aid}`, msg: tr('amd|Accepted. The lease is extended by addendum {n}.', { n: done.n }) };
        }
        // a new lease from the day after this one ends, as a draft to check and activate
        const years = Math.ceil(r.months / 12);
        const lid = Number(db.run(`INSERT INTO leases (ref, brand_id, lead_id, offer_id, status, start_date, end_date, term_years, rent_m2, terrace_rent_m2, service_m2, escalation_pct, rent_free_months, payment_freq, deposit, key_money, signed_at, notes, created_by, created_at,
          escalation_steps, service_mode, service_pct, vat_pct, vat_included, revenue_share, revenue_pct, min_guarantee, take_higher, renewed_from)
          VALUES (?, ?, ?, NULL, 'draft', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('leases', 'LS', 3, true), s.brand_id, s.lead_id, r.start_date, M.addDays(M.addMonths(r.start_date, r.months), -1), years, r.rent_m2, r.terrace_rent_m2,
        s.service_mode === 'pct' ? 0 : r.service_m2 ?? s.service_m2, r.escalation_pct, r.payment_freq || s.payment_freq, r.deposit_topup, `Renewal of ${s.ref} (${r.ref})`, req.user.id, M.now(),
        s.service_mode, s.service_pct, s.vat_pct, s.vat_included, s.revenue_share, s.revenue_pct, s.min_guarantee, s.take_higher, s.id).lastInsertRowid);
        for (const u of M.leaseUnits(db, s.id)) db.run('INSERT INTO lease_units (lease_id, unit_id) VALUES (?, ?)', lid, u.id);
        if (s.revenue_share) {
          try {
            db.run(`INSERT INTO turnover_terms (lease_id, pct, breakpoint_type, breakpoint, frequency, due_day, annual_recon, audit_rights, updated_at)
              SELECT ?, pct, breakpoint_type, breakpoint, frequency, due_day, annual_recon, audit_rights, ? FROM turnover_terms WHERE lease_id = ?`, lid, M.now(), s.id);
          } catch (e) {
            console.error('[renewal] turnover terms:', e.message);
          }
        }
        db.run("UPDATE lease_renewals SET status = 'accepted', new_lease_id = ?, decided_by = ?, decided_at = ? WHERE id = ?", lid, req.user.id, now(), r.id);
        db.run("UPDATE lease_options SET status = 'exercised', decided_on = ? WHERE lease_id = ? AND kind = 'renewal' AND status = 'open'", today(), s.id);
        return { url: `/admin/leases/${lid}`, msg: tr('amd|Accepted. The new lease is drafted; check it, then activate it.') };
      });
    } catch (e) {
      return h.back(req, res, back, 'error', tr(e.message));
    }
    h.log(req, 'Renewal accepted', 'lease', s.id, `${r.ref} · ${r.kind}`);
    h.back(req, res, out.url, 'ok', out.msg);
  });
  router.get('/leases/renewals/:rid/print', (req, res, next) => {
    const r = renewalOf(h.int(req.params.rid));
    if (!r) return next();
    const lang = docLang(req);
    const s = leaseOf(r.lease_id);
    const html = i18n.run(lang, () => {
      const set = db.settings();
      const units = M.leaseUnits(db, s.id);
      const rows = [
        [tr('Units'), units.map((u) => u.code).join(', ')], [tr('amd|Starts'), ui.date(r.start_date)], [tr('Term'), tn(r.months, '{n} month', '{n} months')],
        [tr('amd|Rent per m² a month'), ui.money(r.rent_m2)], [tr('amd|Terrace per m² a month'), ui.money(r.terrace_rent_m2)], [tr('Increase'), tr('{pct}% a year', { pct: r.escalation_pct })],
        [tr('amd|Deposit'), r.carry_deposit ? tr('amd|Carried over from the current lease{plus}', { plus: r.deposit_topup ? ` + ${ui.money(r.deposit_topup)}` : '' }) : ui.money(r.deposit_topup)],
        [tr('amd|Offer open until'), ui.date(r.valid_until)],
      ];
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${esc(tr('Print or save as PDF'))}</span></button><a class="btn btn--ghost" href="/admin/leases/${s.id}#renewal">${esc(tr('Back'))}</a>${docSwitch(`/admin/leases/renewals/${r.id}/print`, lang)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${esc(tr('amd|Renewal offer'))}</p><p class="doc__ref"><bdi>${esc(r.ref)}</bdi> · ${esc(ui.date(r.created_at))}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${esc(tr('Tenant'))}</p><h1>${esc(s.brand_name)}</h1><p>${esc(tr('amd|Lease {ref} ends on {date}. We are pleased to offer you a new term:', { ref: s.ref, date: ui.date(s.end_date) }))}</p></section>
  <table class="doc__t"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${esc(v)}</td></tr>`).join('')}</tbody></table>
  ${r.note ? `<p class="doc__small">${esc(r.note)}</p>` : ''}
  <div class="doc__sign"><div><p>${esc(tr('amd|For The Wave'))}</p><span></span></div><div><p>${esc(tr('amd|Accepted by the tenant'))}</p><span></span></div></div>
  <p class="doc__foot">${esc(i18n.tx(set.legal_name))} · ${esc(i18n.tx(set.address))} · ${esc(set.leasing_email)}</p>
</main>`;
      return ui.bare({ title: `${r.ref} · ${s.brand_name}`, body, cls: 'print' });
    });
    res.type('html').send(html);
  });

  // leases coming to an end, their renewal and their notice dates
  router.get('/leases/renewals', (req, res) => {
    const t = today();
    const within = [3, 6, 12, 24].includes(h.int(req.query.months)) ? h.int(req.query.months) : 12;
    const rows = db.all("SELECT s.*, b.name brand_name FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.status = 'active' AND s.end_date <= ? ORDER BY s.end_date", M.addMonths(t, within))
      .map((s) => ({ ...s, left: dayDiff(t, s.end_date), renewal: db.get('SELECT * FROM lease_renewals WHERE lease_id = ? ORDER BY id DESC LIMIT 1', s.id), option: db.get("SELECT * FROM lease_options WHERE lease_id = ? AND status = 'open' ORDER BY notice_by LIMIT 1", s.id), annual: M.currentAnnualRent(db, s) }));
    const options = db.all("SELECT o.*, s.ref, s.brand_id, b.name brand_name FROM lease_options o JOIN leases s ON s.id = o.lease_id JOIN brands b ON b.id = s.brand_id WHERE o.status = 'open' AND s.status = 'active' ORDER BY o.notice_by LIMIT 60");
    const offers = db.all("SELECT r.*, s.ref lease_ref, b.name brand_name FROM lease_renewals r JOIN leases s ON s.id = r.lease_id JOIN brands b ON b.id = s.brand_id WHERE r.status = 'offered' ORDER BY r.valid_until");
    const sub = `<nav class="tabs tabs--sub">${[3, 6, 12, 24].map((m) => `<a class="tab${within === m ? ' is-on' : ''}" href="/admin/leases/renewals?months=${m}">${esc(tn(m, 'amd|Next {n} month', 'amd|Next {n} months'))}</a>`).join('')}</nav>`;
    const kpis = [
      ui.kpi({ label: tr('amd|Ending in 6 months'), value: String(rows.filter((s) => s.left <= 183).length), sub: esc(ui.money(rows.filter((s) => s.left <= 183).reduce((a, s) => a + s.annual, 0), { compact: true })) + ' ' + esc(tr('amd|a year at stake')) }),
      ui.kpi({ label: tr('amd|Ending in 12 months'), value: String(db.value("SELECT COUNT(*) FROM leases WHERE status = 'active' AND end_date <= ?", M.addMonths(t, 12))) }),
      ui.kpi({ label: tr('amd|Offers waiting'), value: String(offers.length) }),
      ui.kpi({ label: tr('amd|Notice dates in 90 days'), value: String(options.filter((o) => dayDiff(t, o.notice_by) <= 90).length), tone: options.some((o) => dayDiff(t, o.notice_by) <= 30) ? 'kpi--alert' : '' }),
    ].join('');
    const table = ui.table([
      { label: tr('Lease'), render: (s) => `<b>${esc(s.brand_name)}</b><small class="sub"><bdi>${esc(s.ref)}</bdi></small>` },
      { label: tr('amd|Ends'), sort: (s) => s.end_date, render: (s) => `${esc(ui.date(s.end_date))}<small class="sub ${s.left <= 90 ? 'late' : ''}">${esc(tn(s.left, 'amd|in {n} day', 'amd|in {n} days'))}</small>` },
      { label: tr('Annual rent now'), num: true, sort: (s) => s.annual, render: (s) => ui.money(s.annual, { compact: true }) },
      { label: tr('amd|Notice date'), render: (s) => (s.option ? `${esc(ui.date(s.option.notice_by))}<small class="sub">${esc(tr(O_KIND[s.option.kind]))}</small>` : '—') },
      { label: tr('amd|Renewal'), render: (s) => (s.renewal ? `${badgeOf(R_STATUS, s.renewal.status)}<small class="sub"><bdi>${esc(s.renewal.ref)}</bdi></small>` : `<span class="muted">${esc(tr('amd|No offer yet'))}</span>`) },
    ], rows, { empty: esc(tr('amd|No leases end in this period.')), href: (s) => `/admin/leases/${s.id}#renewal` });
    const optList = options.length ? `<ul class="list">${options.map((o) => { const d = dayDiff(t, o.notice_by); return `<li class="${d <= 30 ? 'is-late' : ''}"><a href="/admin/leases/${o.lease_id}#options"><span class="what"><b>${esc(o.brand_name)}</b><small>${esc(tr(O_KIND[o.kind]))} · ${esc(tr(O_PARTY[o.party]))} · ${esc(ui.date(o.notice_by))}</small></span><b>${esc(tn(d, 'amd|{n} day', 'amd|{n} days'))}</b></a></li>`; }).join('')}</ul>` : `<p class="muted pad">${esc(tr('amd|No open options.'))}</p>`;
    const offerList = offers.length ? `<ul class="list">${offers.map((r) => `<li><a href="/admin/leases/${r.lease_id}#renewal"><span class="what"><b>${esc(r.brand_name)}</b><small><bdi>${esc(r.ref)}</bdi> · ${esc(tr('amd|open until {date}', { date: ui.date(r.valid_until) }))}</small></span><b>${ui.money(r.rent_m2, { cur: false })}</b></a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('amd|No offers waiting.'))}</p>`;
    h.page(req, res, { title: tr('amd|Renewals and notice dates'), active: '/admin/leases', wide: true, crumbs: [['/admin/leases', tr('Leases')], [null, tr('amd|Renewals')]], body: `<div class="kpis kpis--4">${kpis}</div>${sub}<div class="grid grid--side"><div>${ui.card(tr('amd|Leases ending'), table)}</div><div class="stack">${ui.card(tr('amd|Notice deadlines'), optList, { sub: esc(tr('amd|Renewal options and break clauses still open. The office is emailed 90, 60 and 30 days before.')) })}${ui.card(tr('amd|Offers waiting'), offerList)}</div></div>` });
  });

  // ---------- settlement ----------
  const isOpen = (i) => ['open', 'partial'].includes(i.status);
  const bal = (i) => r2(i.total - i.paid);
  const settlementOf = (id) => db.get('SELECT x.*, s.ref lease_ref, s.brand_id, s.status lease_status, s.renewed_from, b.name brand_name, u.name by_name, d.name done_name FROM lease_settlements x JOIN leases s ON s.id = x.lease_id JOIN brands b ON b.id = s.brand_id LEFT JOIN users u ON u.id = x.created_by LEFT JOIN users d ON d.id = x.done_by WHERE x.id = ?', id);
  // the deposit held for a lease: deposits paid on it, plus any carried over from the lease it renewed
  function depositHeld(s) {
    const paid = r2(db.value("SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.lease_id = ? AND i.kind = 'deposit' AND p.status = 'received' AND COALESCE(p.method, '') NOT IN ('writeoff','deposit')", s.id));
    const carried = s.renewed_from ? r2(db.value("SELECT COALESCE(SUM(carried), 0) FROM lease_settlements WHERE lease_id = ? AND status IN ('done','refund_pending')", s.renewed_from)) : 0;
    return r2(paid + carried);
  }
  // the renewal this lease's deposit carries over to (an accepted renewal into a new lease)
  const carriesTo = (s) => db.get("SELECT r.*, n.ref new_ref FROM lease_renewals r JOIN leases n ON n.id = r.new_lease_id WHERE r.lease_id = ? AND r.status = 'accepted' AND r.carry_deposit = 1 AND n.status IN ('draft','active') ORDER BY r.id DESC LIMIT 1", s.id);
  function compute(s, { last_day, charge_penalties, deductions }) {
    const inv = db.all("SELECT * FROM invoices WHERE lease_id = ? AND status IN ('open','partial') AND kind != 'deposit' ORDER BY due_date, id", s.id);
    const after = (i) => (i.period_start || i.due_date) > last_day;
    // unpaid invoices for after the last day are voided; anything else still open is owed
    const voids = inv.filter((i) => after(i) && i.status === 'open' && !i.paid);
    const owed = inv.filter((i) => !voids.includes(i));
    const outstanding = r2(owed.reduce((a, i) => a + bal(i), 0));
    const pen = charge_penalties && h.collections ? Math.round(owed.reduce((a, i) => a + h.collections.pendingPenalty(i), 0)) : 0;
    const ded = (deductions || []).filter((d) => d.amount > 0);
    const dedTotal = r2(ded.reduce((a, d) => a + d.amount, 0));
    const held = depositHeld(s);
    const total = r2(outstanding + pen + dedTotal);
    const applied = r2(Math.min(held, total));
    const rest = r2(held - applied);
    const carry = rest > 0 ? carriesTo(s) : null;
    return { owed, voids, outstanding, penalties: pen, deductions: ded, deductions_total: dedTotal, held, total, applied, refund: carry ? 0 : rest, carried: carry ? rest : 0, carry, due: r2(total - applied) };
  }
  const parseDeductions = (b) => [1, 2, 3, 4, 5, 6].map((k) => ({ label: h.str(b[`ded_label_${k}`], 160), amount: r2(Math.max(0, h.numv(b[`ded_amount_${k}`]) || 0)) })).filter((d) => d.label && d.amount > 0);

  router.get('/leases/:id/settle', R('manager'), (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    if (!s) return next();
    const open = db.get("SELECT id FROM lease_settlements WHERE lease_id = ? AND status != 'draft' LIMIT 1", s.id);
    if (open) return h.back(req, res, `/admin/settlements/${open.id}`, 'ok', tr('amd|This lease is already settled.'));
    const draft = db.get("SELECT * FROM lease_settlements WHERE lease_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1", s.id);
    if (draft && !req.query.new) return res.redirect(303, `/admin/settlements/${draft.id}`);
    const t = today();
    const last = s.status === 'active' ? (s.end_date < t ? s.end_date : t) : s.end_date;
    const x = compute(s, { last_day: last, charge_penalties: true, deductions: [] });
    const form = ui.form(`/admin/leases/${s.id}/settlement`, req.session.csrf, `<div class="fields">
        ${s.status === 'active' ? ui.select('how', tr('How'), { ended: tr('Ended (term complete)'), terminated: tr('Terminated early') }, s.end_date <= t ? 'ended' : 'terminated') : ''}
        ${ui.input('last_day', tr('Last day'), last, { type: 'date', required: true })}
        ${ui.select('charge_penalties', tr('amd|Late charges built up'), { 1: tr('amd|Charge them ({amount})', { amount: ui.money(x.penalties) }), 0: tr('amd|Do not charge') }, x.penalties ? 1 : 0)}
        ${ui.select('refund_method', tr('amd|Refund paid by'), { transfer: M.PAY_METHODS.transfer, cheque: M.PAY_METHODS.cheque, cash: M.PAY_METHODS.cash }, 'transfer')}
      </div>
      <fieldset class="amd-set"><legend>${esc(tr('amd|Deductions from the deposit'))}</legend><p class="muted small">${esc(tr('amd|Damage, missing items, cleaning or reinstatement found at handover.'))}</p>
        <div class="amd-ded">${[1, 2, 3, 4, 5, 6].map((k) => `<div class="amd-ded__row">${ui.input(`ded_label_${k}`, k === 1 ? tr('amd|What for') : '', '', { placeholder: k === 1 ? tr('amd|e.g. Broken shopfront glass') : '' })}${ui.input(`ded_amount_${k}`, k === 1 ? tr('Amount') : '', '', { type: 'number', min: 0, step: '0.01' })}</div>`).join('')}</div>
      </fieldset>
      ${ui.textarea('notes', tr('amd|Notes'), '', { rows: 2 })}
      ${ui.btn(esc(tr('amd|Work out the settlement')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    const summary = `<dl class="dl">
      <div><dt>${esc(tr('amd|Owed on invoices'))}</dt><dd>${ui.money(x.outstanding)} <small class="muted">${esc(tn(x.owed.length, '{n} invoice', '{n} invoices'))}</small></dd></div>
      <div><dt>${esc(tr('amd|Deposit held'))}</dt><dd><b>${ui.money(x.held)}</b></dd></div>
      <div><dt>${esc(tr('amd|Voided at the end'))}</dt><dd>${esc(tn(x.voids.length, 'amd|{n} unpaid invoice after the last day', 'amd|{n} unpaid invoices after the last day'))}</dd></div>
      ${x.carry ? `<div><dt>${esc(tr('amd|Deposit'))}</dt><dd>${esc(tr('amd|Carries over to {ref}', { ref: x.carry.new_ref }))}</dd></div>` : ''}
    </dl>`;
    h.page(req, res, { title: tr('amd|End-of-lease settlement'), crumbs: [['/admin/leases', tr('Leases')], [`/admin/leases/${s.id}`, s.brand_name], [null, tr('amd|Settlement')]], active: '/admin/leases', body: `<div class="grid grid--side"><div>${ui.card(tr('amd|Settle the lease'), form, { sub: esc(tr('amd|Nothing changes until you confirm the settlement on the next page.')) })}</div><div>${ui.card(s.ref, summary)}</div></div>` });
  });
  router.post('/leases/:id/settlement', R('manager'), (req, res, next) => {
    const s = leaseOf(h.int(req.params.id));
    if (!s) return next();
    const b = req.body;
    const back = `/admin/leases/${s.id}/settle?new=1`;
    const last = isDate(b.last_day) ? b.last_day : null;
    if (!last || last < s.start_date) return h.back(req, res, back, 'error', tr('amd|Set the last day of the lease.'));
    if (db.get("SELECT id FROM lease_settlements WHERE lease_id = ? AND status != 'draft'", s.id)) return h.back(req, res, `/admin/leases/${s.id}`, 'error', tr('amd|This lease is already settled.'));
    db.run("DELETE FROM lease_settlements WHERE lease_id = ? AND status = 'draft'", s.id);
    const ded = parseDeductions(b);
    const how = s.status === 'active' ? (b.how === 'ended' ? 'ended' : 'terminated') : s.status;
    const id = Number(db.run('INSERT INTO lease_settlements (ref, lease_id, last_day, how, status, charge_penalties, deductions, refund_method, notes, created_by, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      db.nextRef('lease_settlements', 'ST', 4, true), s.id, last, how, 'draft', b.charge_penalties === '0' ? 0 : 1, JSON.stringify(ded), ['transfer', 'cheque', 'cash'].includes(b.refund_method) ? b.refund_method : 'transfer', h.str(b.notes, 1000) || null, req.user.id, s.demo ? 1 : 0, now()).lastInsertRowid);
    h.back(req, res, `/admin/settlements/${id}`, 'ok', tr('amd|Settlement worked out. Check it, then confirm.'));
  });

  // the statement: rows of what is owed and what the deposit covers (stored once settled)
  function statement(x, st) {
    const done = st.status !== 'draft';
    const v = done ? { outstanding: st.outstanding, penalties: st.penalties, deductions: json(st.deductions, []), deductions_total: st.deductions_total, held: st.deposit_held, applied: st.applied, refund: st.refund, carried: st.carried, due: st.due } : x;
    return v;
  }
  router.get('/settlements/:id', (req, res, next) => {
    const st = settlementOf(h.int(req.params.id));
    if (!st) return next();
    const s = leaseOf(st.lease_id);
    const csrf = req.session.csrf;
    const x = st.status === 'draft' ? compute(s, { last_day: st.last_day, charge_penalties: !!st.charge_penalties, deductions: json(st.deductions, []) }) : null;
    const v = statement(x, st);
    const owedRows = x ? x.owed : db.all("SELECT * FROM invoices WHERE lease_id = ? AND kind != 'deposit' AND status != 'void' AND (status IN ('open','partial') OR id IN (SELECT invoice_id FROM payments WHERE method = 'deposit' AND status = 'received')) ORDER BY due_date", s.id);
    const lines = `<table class="table table--fin stl"><tbody>
      <tr><td>${esc(tr('amd|Owed on invoices up to the last day'))}</td><td class="num">${ui.money(v.outstanding, { cur: false })}</td></tr>
      ${v.penalties ? `<tr><td>${esc(tr('amd|Late payment charges'))}</td><td class="num">${ui.money(v.penalties, { cur: false })}</td></tr>` : ''}
      ${v.deductions.map((d) => `<tr><td>${esc(tr('amd|Deduction'))}: ${esc(d.label)}</td><td class="num">${ui.money(d.amount, { cur: false })}</td></tr>`).join('')}
      <tr class="stl__sum"><td>${esc(tr('amd|Total owed'))}</td><td class="num"><b>${ui.money(r2(v.outstanding + v.penalties + v.deductions_total), { cur: false })}</b></td></tr>
      <tr><td>${esc(tr('amd|Deposit held'))}</td><td class="num">${ui.money(v.held, { cur: false })}</td></tr>
      <tr><td>${esc(tr('amd|Taken from the deposit'))}</td><td class="num">− ${ui.money(v.applied, { cur: false })}</td></tr>
      ${v.carried ? `<tr class="stl__sum"><td>${esc(tr('amd|Deposit carried over to the new lease'))}</td><td class="num"><b>${ui.money(v.carried, { cur: false })}</b></td></tr>` : ''}
      ${v.refund ? `<tr class="stl__sum stl__ok"><td>${esc(tr('amd|Refund to the tenant'))}</td><td class="num"><b>${ui.money(v.refund)}</b></td></tr>` : ''}
      ${v.due ? `<tr class="stl__sum stl__due"><td>${esc(tr('amd|Still owed by the tenant'))}</td><td class="num"><b>${ui.money(v.due)}</b></td></tr>` : ''}
      ${!v.refund && !v.due && !v.carried ? `<tr class="stl__sum"><td>${esc(tr('amd|Nothing owed either way'))}</td><td class="num">0</td></tr>` : ''}
    </tbody></table>`;
    const invTable = ui.table([
      { label: tr('Invoice'), render: (i) => `<a href="/admin/invoices/${i.id}"><bdi>${esc(i.ref)}</bdi></a><small class="sub">${esc(M.INVOICE_KINDS[i.kind] || i.kind)}</small>` },
      { label: tr('Due'), render: (i) => esc(ui.date(i.due_date)) },
      { label: tr('Total'), num: true, render: (i) => ui.money(i.total, { cur: false }) },
      { label: tr(x ? 'amd|Owed' : 'Paid'), num: true, render: (i) => ui.money(x ? bal(i) : i.paid, { cur: false }) },
    ], owedRows, { empty: esc(tr('amd|Every invoice is paid.')) });
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('Lease'))}</dt><dd><a href="/admin/leases/${s.id}">${esc(s.ref)}</a> · ${esc(s.brand_name)}</dd></div>
      <div><dt>${esc(tr('Last day'))}</dt><dd>${esc(ui.date(st.last_day))} · ${esc(M.LEASE_STATUS[st.how] || st.how)}</dd></div>
      <div><dt>${esc(tr('Status'))}</dt><dd>${badgeOf(S_STATUS, st.status)}${st.done_at ? ` <small class="muted">${esc(ui.dt(st.done_at))}${st.done_name ? ` · ${esc(st.done_name)}` : ''}</small>` : ''}</dd></div>
      ${st.refund ? `<div><dt>${esc(tr('amd|Refund'))}</dt><dd>${esc(M.PAY_METHODS[st.refund_method] || st.refund_method)}${st.refunded_at ? ` · ${esc(tr('amd|paid {date}', { date: ui.date(st.refunded_at) }))}` : st.refund_ref === 'not_approved' ? ` · ${ui.badge('no', tr('amd|Not approved'), 'rose')}` : ''}</dd></div>` : ''}
      ${st.notes ? `<div><dt>${esc(tr('amd|Notes'))}</dt><dd>${esc(st.notes)}</dd></div>` : ''}
    </dl>`;
    const may = h.can(req, 'manager');
    const confirm = st.status === 'draft' && may ? `${x.voids.length ? `<p class="muted small">${esc(tn(x.voids.length, 'amd|{n} unpaid invoice after the last day is voided.', 'amd|{n} unpaid invoices after the last day are voided.'))}</p>` : ''}<div class="row">${ui.form(`/admin/settlements/${st.id}/confirm`, csrf, ui.btn(esc(tr(s.status === 'active' ? 'amd|Confirm and end the lease' : 'amd|Confirm the settlement')), { cls: 'btn--primary', ic: 'check', attrs: { 'data-confirm': tr('amd|Confirm? The deposit is applied, the refund is made or asked for, and the lease is closed.') } }))}${ui.btn(esc(tr('amd|Change')), { href: `/admin/leases/${s.id}/settle?new=1`, cls: 'btn--ghost' })}</div>` : '';
    const refundAct = st.status === 'refund_pending' ? `<p class="muted">${esc(tr('amd|The refund waits for approval. It is booked once approved.'))}</p>` : '';
    h.page(req, res, {
      title: tr('amd|Settlement {ref}', { ref: st.ref }), crumbs: [['/admin/leases', tr('Leases')], [`/admin/leases/${s.id}`, s.brand_name], [null, st.ref]], active: '/admin/leases',
      actions: ui.btn(esc(tr('Print')), { href: `/admin/settlements/${st.id}/print`, cls: 'btn--ghost', ic: 'print', attrs: { target: '_blank' } }),
      body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('amd|Statement'), lines)}${ui.card(tr(x ? 'amd|Invoices still owed' : 'amd|Invoices settled'), invTable)}${stlDocs(req, 'lease_settlement', st.id, { title: tr('amd|Handover papers') })}</div><div class="stack">${ui.card(s.brand_name, facts)}${confirm || refundAct ? ui.card(tr('amd|Confirm'), `${confirm}${refundAct}`) : ''}</div></div>`,
    });
  });

  const ledger = () => (h.ledger && typeof h.ledger.post === 'function' ? h.ledger : null);
  function bookRefund(st, { user = null } = {}) {
    const L = ledger();
    if (L && st.refund > 0) {
      try {
        const code = L.S(`method_${st.refund_method || 'transfer'}`, '');
        const cash = code && L.byCode(code) ? L.byCode(code).id : L.idOf(st.refund_method === 'cash' ? 'petty_cash' : 'bank_clearing');
        L.post({ date: L.firstOpen(today()), memo: `Deposit refund ${st.ref} · ${st.brand_name || ''}`.trim(), kind: 'auto', source: `settlement:${st.id}`, user, demo: st.demo,
          lines: [{ account: 'deposits', debit: st.refund, party_type: 'brand', party_id: st.brand_id }, { account: cash, credit: st.refund }] });
      } catch (e) {
        console.error('[settlement] refund not posted:', e.message);
      }
    }
    db.run("UPDATE lease_settlements SET status = 'done', refunded_at = ? WHERE id = ?", st.refund > 0 ? today() : null, st.id);
  }
  if (h.refunds) {
    h.refunds.on('settlement', (r, decision, user, p) => {
      const st = settlementOf(h.int(p.settlement_id));
      if (!st || st.status !== 'refund_pending') return;
      if (decision === 'approved') bookRefund(st, { user });
      else db.run("UPDATE lease_settlements SET status = 'done', refund_ref = 'not_approved' WHERE id = ?", st.id);
    });
  }
  router.post('/settlements/:id/confirm', R('manager'), (req, res, next) => {
    const st = settlementOf(h.int(req.params.id));
    if (!st) return next();
    const back = `/admin/settlements/${st.id}`;
    if (st.status !== 'draft') return h.back(req, res, back, 'error', tr('amd|This lease is already settled.'));
    const s = leaseOf(st.lease_id);
    if (h.ensureMethodAccounts) h.ensureMethodAccounts();
    let out;
    try {
      out = db.tx(() => {
        // the lease ends (deals.js: future unpaid invoices voided, units free again)
        if (s.status === 'active' && h.endLease) h.endLease(s, { how: st.how, date: st.last_day, user: req.user });
        else if (s.status === 'active') db.run('UPDATE leases SET status = ?, end_date = ? WHERE id = ?', st.how, st.last_day, s.id);
        const x = compute(leaseOf(s.id), { last_day: st.last_day, charge_penalties: !!st.charge_penalties, deductions: json(st.deductions, []) });
        for (const i of x.voids) h.billing.voidInvoice(i.id, { user: req.user, note: `Voided: settlement ${st.ref}` });
        let penalties = 0;
        if (st.charge_penalties && h.collections) for (const i of x.owed) { const p = h.collections.chargePenalty(i, { user: req.user, notify: false }); if (p) penalties = r2(penalties + p.invoice.other); }
        let dedInv = null;
        if (x.deductions_total > 0) dedInv = h.billing.createInvoice({ lease_id: s.id, kind: 'other', due_date: st.last_day, other: x.deductions_total, note: `End-of-lease deductions (${st.ref})`, source: 'settlement', source_id: st.id, vat_pct: 0, vat_included: false, demo: s.demo }, { user: req.user });
        // deposit invoices never paid are not owed once the lease is over
        for (const d of db.all("SELECT id FROM invoices WHERE lease_id = ? AND kind = 'deposit' AND status = 'open' AND paid = 0", s.id)) h.billing.voidInvoice(d.id, { user: req.user, note: `Voided: settlement ${st.ref}` });
        // the deposit pays what is owed, oldest first
        let left = x.held;
        let applied = 0;
        for (const i of db.all("SELECT * FROM invoices WHERE lease_id = ? AND status IN ('open','partial') AND kind != 'deposit' ORDER BY due_date, id", s.id)) {
          if (left < 0.01) break;
          const amt = r2(Math.min(left, bal(i)));
          if (!(amt > 0)) continue;
          h.billing.recordPayment({ invoice_id: i.id, amount: amt, date: st.last_day < today() ? today() : st.last_day, method: 'deposit', reference: st.ref, note: 'Taken from the security deposit', demo: s.demo }, { user: req.user });
          left = r2(left - amt);
          applied = r2(applied + amt);
        }
        const owedAfter = r2(db.value("SELECT COALESCE(SUM(total - paid), 0) FROM invoices WHERE lease_id = ? AND status IN ('open','partial') AND kind != 'deposit'", s.id));
        const carry = left > 0 ? carriesTo(s) : null;
        const refund = carry ? 0 : left;
        db.run('UPDATE lease_settlements SET deposit_held = ?, outstanding = ?, penalties = ?, deductions_total = ?, applied = ?, refund = ?, carried = ?, due = ?, deduction_invoice_id = ?, done_by = ?, done_at = ? WHERE id = ?',
          x.held, x.outstanding, penalties, x.deductions_total, applied, refund, carry ? left : 0, owedAfter, dedInv ? dedInv.id : null, req.user.id, now(), st.id);
        return { refund, carry, owedAfter };
      });
    } catch (e) {
      return h.back(req, res, back, 'error', tr(e.message));
    }
    const fresh = settlementOf(st.id);
    let msg;
    if (out.refund > 0) {
      const ask = h.refunds ? h.refunds.ask({ type: 'settlement', title: `Deposit refund ${st.ref} · ${s.brand_name}`, amount: out.refund, entity: 'lease', entity_id: s.id, link: `/admin/settlements/${st.id}`, payload: { settlement_id: st.id }, user: req.user, demo: s.demo }) : null;
      if (ask) {
        db.run("UPDATE lease_settlements SET status = 'refund_pending', approval_id = ? WHERE id = ?", ask.id || null, st.id);
        msg = tr('amd|Settled. The refund of {amount} waits for approval.', { amount: ui.money(out.refund) });
      } else {
        bookRefund(fresh, { user: req.user });
        msg = tr('amd|Settled. Refund {amount} to the tenant.', { amount: ui.money(out.refund) });
      }
    } else {
      db.run("UPDATE lease_settlements SET status = 'done' WHERE id = ?", st.id);
      msg = out.owedAfter > 0 ? tr('amd|Settled. The tenant still owes {amount}; it stays in collections.', { amount: ui.money(out.owedAfter) }) : out.carry ? tr('amd|Settled. The rest of the deposit carries over to {ref}.', { ref: out.carry.new_ref }) : tr('amd|Settled.');
    }
    const done = settlementOf(st.id);
    if (h.tenantNotify) {
      h.tenantNotify(s.brand_id, {
        kind: 'lease', title: 'amd|End-of-lease settlement for {ref}', body: done.refund > 0 ? 'amd|Your lease {ref} is settled. After what was owed, {amount} of your deposit is refunded to you.' : done.due > 0 ? 'amd|Your lease {ref} is settled. After the deposit, {amount} is still owed; please pay it in the portal.' : 'amd|Your lease {ref} is settled. Nothing is owed either way.',
        params: { ref: s.ref, amount: enMoney(done.refund > 0 ? done.refund : done.due) }, rows: [['amd|Deposit held', enMoney(done.deposit_held)], ['amd|Taken from the deposit', enMoney(done.applied)]], link: '/portal/invoices', entity: 'lease', entity_id: s.id, demo: s.demo,
      });
    }
    h.log(req, 'Settled a lease', 'lease', s.id, `${st.ref} · applied ${done.applied} · refund ${done.refund} · due ${done.due}`);
    h.back(req, res, back, 'ok', msg);
  });
  router.get('/settlements/:id/print', (req, res, next) => {
    const st = settlementOf(h.int(req.params.id));
    if (!st) return next();
    const s = leaseOf(st.lease_id);
    const lang = docLang(req);
    const x = st.status === 'draft' ? compute(s, { last_day: st.last_day, charge_penalties: !!st.charge_penalties, deductions: json(st.deductions, []) }) : null;
    const v = statement(x, st);
    const html = i18n.run(lang, () => {
      const set = db.settings();
      const rows = [
        [tr('amd|Owed on invoices up to the last day'), v.outstanding], ...(v.penalties ? [[tr('amd|Late payment charges'), v.penalties]] : []),
        ...v.deductions.map((d) => [`${tr('amd|Deduction')}: ${d.label}`, d.amount]),
      ];
      const body = `<main class="doc">
  <div class="doc__bar noprint"><button class="btn btn--primary" data-print>${ui.icon('print')}<span>${esc(tr('Print or save as PDF'))}</span></button><a class="btn btn--ghost" href="/admin/settlements/${st.id}">${esc(tr('Back'))}</a>${docSwitch(`/admin/settlements/${st.id}/print`, lang)}</div>
  <header class="doc__head">${ui.logo('doc__logo')}<div><p class="eyebrow">${esc(tr('amd|End-of-lease settlement'))}</p><p class="doc__ref"><bdi>${esc(st.ref)}</bdi> · ${esc(ui.date(st.done_at || st.created_at))}${st.status === 'draft' ? ` · ${esc(tr('amd|Draft'))}` : ''}</p></div></header>
  <section class="doc__to"><p class="eyebrow">${esc(tr('Tenant'))}</p><h1>${esc(s.brand_name)}</h1><p>${esc(tr('amd|Lease {ref}, units {codes}. Last day {date}.', { ref: s.ref, codes: M.leaseUnits(db, s.id).map((u) => u.code).join(', '), date: ui.date(st.last_day) }))}</p></section>
  <table class="doc__t"><thead><tr><th>${esc(tr('Description'))}</th><th class="num">${esc(tr('Amount ({cur})', { cur: ui.curLabel() }))}</th></tr></thead><tbody>${rows.map(([l, a]) => `<tr><td>${esc(l)}</td><td class="num">${ui.money(a, { cur: false })}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td><b>${esc(tr('amd|Total owed'))}</b></td><td class="num"><b>${ui.money(r2(v.outstanding + v.penalties + v.deductions_total), { cur: false })}</b></td></tr>
  <tr><td>${esc(tr('amd|Deposit held'))}</td><td class="num">${ui.money(v.held, { cur: false })}</td></tr>
  <tr><td>${esc(tr('amd|Taken from the deposit'))}</td><td class="num">${ui.money(v.applied, { cur: false })}</td></tr>
  ${v.carried ? `<tr><td><b>${esc(tr('amd|Deposit carried over to the new lease'))}</b></td><td class="num"><b>${ui.money(v.carried, { cur: false })}</b></td></tr>` : ''}
  ${v.refund ? `<tr><td><b>${esc(tr('amd|Refund to the tenant'))}</b></td><td class="num"><b>${ui.money(v.refund)}</b></td></tr>` : ''}
  ${v.due ? `<tr><td><b>${esc(tr('amd|Still owed by the tenant'))}</b></td><td class="num"><b>${ui.money(v.due)}</b></td></tr>` : ''}</tfoot></table>
  ${st.notes ? `<p class="doc__small">${esc(st.notes)}</p>` : ''}
  <p class="doc__small">${esc(tr('amd|Both parties agree this settles the lease, apart from what is shown as still owed.'))}</p>
  <div class="doc__sign"><div><p>${esc(tr('amd|For The Wave'))}</p><span></span></div><div><p>${esc(tr('amd|For the tenant'))}</p><span></span></div></div>
  <p class="doc__foot">${esc(i18n.tx(set.legal_name))} · ${esc(i18n.tx(set.address))} · ${esc(set.leasing_email)}</p>
</main>`;
      return ui.bare({ title: `${st.ref} · ${s.brand_name}`, body, cls: 'print' });
    });
    res.type('html').send(html);
  });

  // ---------- on the lease page ----------
  (h.leaseCards = h.leaseCards || []).push((req, s) => {
    const csrf = req.session.csrf;
    const may = h.can(req, 'manager');
    const t = today();
    const amds = db.all('SELECT * FROM lease_amendments WHERE lease_id = ? AND status != \'cancelled\' ORDER BY n', s.id);
    const opts = db.all('SELECT * FROM lease_options WHERE lease_id = ? ORDER BY notice_by', s.id);
    const rens = db.all('SELECT r.*, n.ref new_ref FROM lease_renewals r LEFT JOIN leases n ON n.id = r.new_lease_id WHERE r.lease_id = ? ORDER BY r.id DESC', s.id);
    const st = db.get('SELECT * FROM lease_settlements WHERE lease_id = ? ORDER BY id DESC LIMIT 1', s.id);
    const from = s.renewed_from ? db.get('SELECT id, ref FROM leases WHERE id = ?', s.renewed_from) : null;
    const out = [];
    // addenda
    const amdList = amds.length ? `<ul class="list">${amds.map((a) => `<li><a href="/admin/leases/${s.id}/amendments/${a.id}"><span class="what"><b>${esc(tr('amd|Addendum {n}', { n: a.n }))} · ${esc(ui.date(a.effective_date))}</b><small>${esc(describeChanges(s, a).join(' · '))}</small></span>${badgeOf(A_STATUS, a.status)}</a></li>`).join('')}</ul>` : '';
    if (amdList || (may && s.status === 'active')) out.push(ui.card(tr('amd|Addenda'), amdList || `<p class="muted pad">${esc(tr('amd|No addenda.'))}</p>`, { action: may && s.status === 'active' ? ui.btn(esc(tr('amd|New addendum')), { href: `/admin/leases/${s.id}/amend`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '' }));
    // options and renewal
    const optList = opts.length ? `<ul class="list">${opts.map((o) => { const d = dayDiff(t, o.notice_by); return `<li class="${o.status === 'open' && d <= 30 ? 'is-late' : ''}"><span class="what"><b>${esc(tr(O_KIND[o.kind]))} · ${esc(tr(O_PARTY[o.party]))}</b><small>${esc(tr('amd|Notice by {date}', { date: ui.date(o.notice_by) }))}${o.status === 'open' ? ` · ${esc(tn(d, 'amd|in {n} day', 'amd|in {n} days'))}` : ''}${o.terms ? ` · ${esc(o.terms)}` : ''}</small></span>${badgeOf(O_STATUS, o.status)}${o.status === 'open' && may ? `<details class="pop-inline"><summary class="btn btn--ghost btn--xs">${ui.icon('more')}</summary>${ui.form(`/admin/leases/options/${o.id}`, csrf, `<input type="hidden" name="status" value="exercised">${ui.btn(esc(tr('amd|Exercised')), { cls: 'btn--ghost btn--xs' })}`)}${ui.form(`/admin/leases/options/${o.id}`, csrf, `<input type="hidden" name="status" value="waived">${ui.btn(esc(tr('amd|Not used')), { cls: 'btn--ghost btn--xs' })}`)}</details>` : ''}</li>`; }).join('')}</ul>` : '';
    const optForm = may && s.status === 'active' ? `<details class="pop-block"><summary class="btn btn--ghost btn--sm">${ui.icon('plus')}<span>${esc(tr('amd|Add an option'))}</span></summary>${ui.form(`/admin/leases/${s.id}/options`, csrf, `<div class="fields">${ui.select('kind', tr('amd|Option'), tmap(O_KIND), 'renewal')}${ui.select('party', tr('amd|Who can use it'), tmap(O_PARTY), 'tenant')}${ui.input('notice_by', tr('amd|Notice by'), M.addMonths(s.end_date, -6), { type: 'date', required: true })}${ui.input('effective_on', tr('amd|Takes effect'), M.addDays(s.end_date, 1), { type: 'date' })}${ui.input('terms', tr('amd|Terms'), '', { cls: 'span-all', placeholder: tr('amd|e.g. 3 more years at the rent then +10%') })}</div>${ui.btn(esc(tr('amd|Add')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    if (optList || optForm) out.push(`<div id="options">${ui.card(tr('amd|Options and notice dates'), `${optList}${optForm}`)}</div>`);
    const renList = rens.length ? `<ul class="list">${rens.map((r) => `<li><span class="what"><b><bdi>${esc(r.ref)}</bdi> · ${esc(tr(r.kind === 'extension' ? 'amd|Extension' : 'amd|New lease'))} · ${esc(tn(r.months, '{n} month', '{n} months'))}</b><small>${esc(tr('amd|From {date} at {rate} per m²', { date: ui.date(r.start_date), rate: ui.money(r.rent_m2, { cur: false }) }))}${r.new_lease_id ? ` · <a href="/admin/leases/${r.new_lease_id}">${esc(r.new_ref)}</a>` : ''}</small></span>${r.notice_id && h.seenBadge && h.noticeSeen && r.status === 'offered' ? h.seenBadge((h.noticeSeen(r.notice_id) || {}).seen) : ''}${badgeOf(R_STATUS, r.status)}<a class="btn btn--ghost btn--xs" href="/admin/leases/renewals/${r.id}/print" target="_blank">${ui.icon('print')}</a>${r.status === 'offered' && may ? `<details class="pop-inline"><summary class="btn btn--ghost btn--xs">${ui.icon('more')}</summary>${ui.form(`/admin/leases/renewals/${r.id}/accept`, csrf, ui.btn(esc(tr('amd|Accepted')), { cls: 'btn--primary btn--xs', attrs: { 'data-confirm': tr(r.kind === 'extension' ? 'amd|Accept? The lease is extended now and its invoices issued.' : 'amd|Accept? A new draft lease is created from these terms.') } }))}${ui.form(`/admin/leases/renewals/${r.id}/decline`, csrf, ui.btn(esc(tr('amd|Declined')), { cls: 'btn--ghost btn--xs' }))}${ui.form(`/admin/leases/renewals/${r.id}/withdraw`, csrf, ui.btn(esc(tr('amd|Withdraw')), { cls: 'btn--ghost btn--xs' }))}</details>` : ''}</li>`).join('')}</ul>` : '';
    const renForm = may && s.status === 'active' && !rens.some((r) => ['offered', 'accepted'].includes(r.status)) ? `<details class="pop-block"><summary class="btn btn--ghost btn--sm">${ui.icon('contract')}<span>${esc(tr('amd|Offer a renewal'))}</span></summary>${ui.form(`/admin/leases/${s.id}/renewals`, csrf, `<div class="fields">
      ${ui.select('kind', tr('amd|As'), { lease: tr('amd|A new lease'), extension: tr('amd|An extension of this lease') }, 'lease')}${ui.input('months', tr('amd|Months'), 36, { type: 'number', min: 1, max: 240, required: true })}
      ${ui.input('rent_m2', tr('amd|Rent per m² a month'), Math.round(rateOn(s, s.end_date) * (1 + (Number(s.escalation_pct) || 0) / 100)), { type: 'number', min: 0, step: '0.01', required: true })}${ui.input('escalation_pct', tr('amd|Yearly increase %'), s.escalation_pct, { type: 'number', min: 0, max: 50, step: '0.1' })}
      ${ui.input('deposit_topup', tr('amd|Extra deposit'), 0, { type: 'number', min: 0 })}${ui.select('carry_deposit', tr('amd|Deposit'), { 1: tr('amd|Carries over'), 0: tr('amd|Refunded at the end') }, 1)}
      ${ui.input('valid_until', tr('amd|Offer open until'), M.addDays(t, 30), { type: 'date' })}${ui.select('send', tr('amd|Send to the tenant'), { 1: tr('amd|Yes, by the portal and email'), 0: tr('amd|Not yet') }, 1)}
      ${ui.input('note', tr('amd|Note'), '', { cls: 'span-all' })}</div>${ui.btn(esc(tr('amd|Make the offer')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    if (renList || renForm || from) out.push(`<div id="renewal">${ui.card(tr('amd|Renewal'), `${from ? `<p class="small pad">${esc(tr('amd|Renews lease'))} <a href="/admin/leases/${from.id}">${esc(from.ref)}</a></p>` : ''}${renList}${renForm}`, { action: s.end_date <= M.addMonths(t, 12) && s.status === 'active' ? ui.badge('soon', tn(dayDiff(t, s.end_date), 'amd|Ends in {n} day', 'amd|Ends in {n} days'), dayDiff(t, s.end_date) <= 90 ? 'rose' : 'amber') : '' })}</div>`);
    // settlement
    if (st) out.push(ui.card(tr('amd|Settlement'), `<ul class="list"><li><a href="/admin/settlements/${st.id}"><span class="what"><b><bdi>${esc(st.ref)}</bdi> · ${esc(ui.date(st.last_day))}</b><small>${esc(st.status === 'draft' ? tr('amd|Not confirmed yet') : st.refund ? tr('amd|Refund {amount}', { amount: ui.money(st.refund, { compact: true }) }) : st.due ? tr('amd|Owed {amount}', { amount: ui.money(st.due, { compact: true }) }) : tr('amd|Nothing owed either way'))}</small></span>${badgeOf(S_STATUS, st.status)}</a></li></ul>`));
    else if (may && ['active', 'ended', 'terminated'].includes(s.status) && (s.status !== 'active' || s.end_date <= M.addMonths(t, 3))) out.push(ui.card(tr('amd|Settlement'), `<p class="muted pad">${esc(tr('amd|Work out what is owed against the deposit and close the lease.'))}</p>${ui.btn(esc(tr('amd|End and settle')), { href: `/admin/leases/${s.id}/settle`, cls: 'btn--ghost btn--sm' })}`));
    return out.join('');
  });

  h.amendments = { impact, applyAmendment, createAmendment, planFor, rateOn, depositHeld, compute, optionAlerts, termMonths };
};

module.exports.SCHEMA = SCHEMA;
