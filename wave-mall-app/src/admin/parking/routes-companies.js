'use strict';

// Company accounts (/admin/parking/companies): offices, hotels and clinics nearby with many plates.
// Two ways to bill:
//   fixed   a monthly price for each plate on the account, billed in advance on one invoice
//   usage   the company pays for the time its cars actually park, at a discount, billed after the month
//           (with an optional monthly cap)
// The account's plates open the gate like any subscription; suspending the account stops them.

const { t: tr, tn } = require('../i18n');
const T = require('./tariff');

const A_STATUS = { active: ['prk|Active', 'ok'], suspended: ['prk|Suspended', 'amber'], closed: ['prk|Closed', 'mute'] };
const MODE = { fixed: 'prk|A monthly price per plate', usage: 'prk|What they park, at a discount' };

module.exports = function companyRoutes(router, h, c) {
  const { db, ui } = h;
  const { P, esc } = c;
  const now = () => new Date().toISOString();
  const r2 = T.r2;
  const badge = (s) => ui.badge(s, tr((A_STATUS[s] || [s])[0]), (A_STATUS[s] || [])[1]);
  const accountBy = (id) => db.get('SELECT a.*, b.name brand_name FROM pk_accounts a LEFT JOIN brands b ON b.id = a.brand_id WHERE a.id = ?', id);
  const platesOf = (a) => db.all("SELECT * FROM pk_permits WHERE account_id = ? AND status IN ('active','suspended') ORDER BY name", a.id);
  const monthStart = (d = c.today()) => `${d.slice(0, 7)}-01`;

  // ---------- billing ----------
  // One invoice per account and month: plates × price (fixed, in advance) or last month's time (usage).
  function billAccounts(today = c.today(), { user = null } = {}) {
    const B = h.billing;
    if (!B) return [];
    const out = [];
    for (const a of db.all("SELECT * FROM pk_accounts WHERE status = 'active' AND next_bill_on IS NOT NULL AND next_bill_on <= ?", today)) {
      db.tx(() => {
        const start = a.next_bill_on;
        const end = P.addDays(P.addMonths(start, 1), -1);
        let total = 0;
        let note;
        let charges = [];
        if (a.mode === 'usage') {
          // the month before this bill
          const from = P.addMonths(start, -1);
          charges = db.all('SELECT * FROM pk_account_charges WHERE account_id = ? AND invoice_id IS NULL AND at < ?', a.id, c.dayStart(start));
          total = r2(charges.reduce((s, x) => s + x.amount, 0));
          note = `Company parking ${a.ref}: ${charges.length} visits, ${from} to ${P.addDays(start, -1)}`;
        } else {
          const n = platesOf(a).filter((p) => p.status === 'active').length;
          total = r2(n * a.price);
          note = `Company parking ${a.ref}: ${n} plates for ${start.slice(0, 7)}`;
        }
        if (total > 0) {
          const inv = B.createInvoice({
            kind: 'parking', brand_id: a.brand_id || null, customer: a.brand_id ? null : a.name, total, vat_included: true,
            period_start: a.mode === 'usage' ? P.addMonths(start, -1) : start, period_end: a.mode === 'usage' ? P.addDays(start, -1) : end,
            due_date: P.addDays(start, a.terms_days || 0), note, source: 'parking-account', source_id: a.id, demo: a.demo,
          }, { user });
          if (charges.length) db.run(`UPDATE pk_account_charges SET invoice_id = ? WHERE id IN (${charges.map(() => '?').join(',')})`, inv.id, ...charges.map((x) => x.id));
          out.push(inv);
        }
        db.run('UPDATE pk_accounts SET next_bill_on = ?, updated_at = ? WHERE id = ?', P.addMonths(start, 1), now(), a.id);
      });
    }
    return out;
  }
  h.every('parking-companies', 6 * 3600000, () => billAccounts());
  h.parking.billAccounts = billAccounts;

  // ---------- pages ----------
  router.get('/parking/companies', (req, res) => {
    const rows = db.all(`SELECT a.*, b.name brand_name, (SELECT COUNT(*) FROM pk_permits p WHERE p.account_id = a.id AND p.status = 'active') plates,
      (SELECT COALESCE(SUM(amount), 0) FROM pk_account_charges x WHERE x.account_id = a.id AND x.at >= ?) used,
      (SELECT COALESCE(SUM(total - paid), 0) FROM invoices i WHERE i.source = 'parking-account' AND i.source_id = a.id AND i.status IN ('open','partial')) owed
      FROM pk_accounts a LEFT JOIN brands b ON b.id = a.brand_id ORDER BY a.status = 'active' DESC, a.name`, c.dayStart(monthStart()));
    const kpis = [
      ui.kpi({ label: tr('prk|Company accounts'), value: ui.n0(rows.filter((a) => a.status === 'active').length) }),
      ui.kpi({ label: tr('prk|Their plates'), value: ui.n0(rows.reduce((s, a) => s + a.plates, 0)) }),
      ui.kpi({ label: tr('prk|Billed each month'), value: c.money(r2(rows.filter((a) => a.mode === 'fixed' && a.status === 'active').reduce((s, a) => s + a.plates * a.price, 0))) }),
      ui.kpi({ label: tr('prk|Owed by companies'), value: c.money(r2(rows.reduce((s, a) => s + a.owed, 0))) }),
    ].join('');
    const table = ui.table([
      { label: tr('prk|Company'), render: (a) => `<b>${esc(a.name)}</b><small class="sub">${esc(a.ref)}${a.brand_name ? ` · ${esc(a.brand_name)}` : ''}</small>` },
      { label: tr('prk|Billing'), render: (a) => `${esc(tr(MODE[a.mode]))}<small class="sub">${esc(a.mode === 'fixed' ? tr('prk|{amount} a plate', { amount: ui.money(a.price) }) : tr('prk|{n}% off', { n: a.discount }))}</small>` },
      { label: tr('prk|Plates'), num: true, render: (a) => ui.n0(a.plates) },
      { label: tr('prk|This month'), num: true, render: (a) => (a.mode === 'usage' ? c.money(a.used) : c.money(r2(a.plates * a.price))) },
      { label: tr('prk|Owed'), num: true, render: (a) => (a.owed ? `<b class="late">${c.money(a.owed)}</b>` : '—') },
      { label: tr('Status'), render: (a) => badge(a.status) },
    ], rows, { href: (a) => `/admin/parking/companies/${a.id}`, empty: esc(tr('prk|No company accounts yet.')) });
    c.page(req, res, { title: tr('prk|Companies'), crumbs: c.crumbs([null, tr('prk|Companies')]), actions: h.can(req, 'manager') ? ui.btn(esc(tr('prk|New company')), { href: '/admin/parking/companies/new', cls: 'btn--primary', ic: 'plus' }) : '', body: `${c.tabs('/admin/parking/companies')}<div class="kpis kpis--4">${kpis}</div>${ui.card(tr('prk|Companies'), table, { sub: esc(tr('prk|Offices, hotels and clinics nearby with many cars, on one monthly invoice.')) })}` });
  });
  const form = (req, a = {}) => `<div class="fields">
    ${ui.input('name', tr('prk|Company'), a.name || '', { required: true })}
    ${ui.select('brand_id', tr('prk|A tenant of the mall'), c.tenants().map((b) => [b.id, b.name]), a.brand_id || '', { blank: tr('prk|No') })}
    ${ui.input('contact_name', tr('prk|Contact'), a.contact_name || '')}${ui.input('phone', tr('prk|Mobile'), a.phone || '', { type: 'tel' })}
    ${ui.input('email', tr('Email'), a.email || '', { type: 'email' })}${ui.input('tax_id', tr('prk|Tax ID'), a.tax_id || '')}
    ${ui.input('address', tr('prk|Address'), a.address || '', { cls: 'span-all' })}
    ${ui.select('mode', tr('prk|Billing'), c.tmap(MODE), a.mode || 'fixed')}
    ${ui.input('price', tr('prk|Monthly price per plate'), a.price ?? 600, { type: 'number', min: 0, step: 1, hint: tr('prk|For a monthly price per plate.') })}
    ${ui.input('discount', tr('prk|Discount (%)'), a.discount ?? 20, { type: 'number', min: 0, max: 100, step: 1, hint: tr('prk|For what they park.') })}
    ${ui.input('cap', tr('prk|Most a month'), a.cap ?? '', { type: 'number', min: 0, step: 1, hint: tr('prk|For what they park. Empty: no cap.') })}
    ${ui.input('terms_days', tr('prk|Days to pay'), a.terms_days ?? 15, { type: 'number', min: 0, max: 90 })}
    ${ui.textarea('notes', tr('prk|Notes'), a.notes || '', { rows: 2, cls: 'span-all' })}</div>`;
  const values = (b) => ({
    name: h.str(b.name, 120), brand_id: h.int(b.brand_id), contact_name: h.str(b.contact_name, 80) || null, phone: h.str(b.phone, 30) || null, email: h.str(b.email, 160) || null,
    tax_id: h.str(b.tax_id, 40) || null, address: h.str(b.address, 200) || null, mode: MODE[b.mode] ? b.mode : 'fixed', price: Math.max(0, h.numv(b.price) || 0),
    discount: Math.min(100, Math.max(0, h.numv(b.discount) || 0)), cap: h.numv(b.cap) || null, terms_days: Math.min(90, Math.max(0, h.int(b.terms_days) ?? 15)), notes: h.str(b.notes, 1000) || null,
  });
  router.get('/parking/companies/new', c.RM, (req, res) => {
    c.page(req, res, { title: tr('prk|New company'), crumbs: c.crumbs(['/admin/parking/companies', tr('prk|Companies')], [null, tr('prk|New')]), body: ui.card(tr('prk|New company'), ui.form('/admin/parking/companies', req.session.csrf, `${form(req)}${ui.btn(esc(tr('prk|Create')), { cls: 'btn--primary' })}`, { cls: 'stack' })) });
  });
  router.post('/parking/companies', c.RM, (req, res) => {
    const v = values(req.body);
    if (!v.name) return c.back(req, res, '/admin/parking/companies/new', 'error', tr('prk|Type the company’s name.'));
    const t = now();
    const id = Number(db.run(`INSERT INTO pk_accounts (ref, name, brand_id, contact_name, phone, email, tax_id, address, mode, price, discount, cap, terms_days, notes, next_bill_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, db.nextRef('pk_accounts', 'PC', 4, true), v.name, v.brand_id, v.contact_name, v.phone, v.email, v.tax_id, v.address, v.mode, v.price, v.discount, v.cap, v.terms_days, v.notes,
    v.mode === 'usage' ? P.addMonths(monthStart(), 1) : c.today(), t, t).lastInsertRowid);
    h.log(req, 'Opened a company parking account', 'pk_account', id, v.name);
    c.back(req, res, `/admin/parking/companies/${id}`, 'ok', tr('prk|Account opened. Add its plates.'));
  });
  router.get('/parking/companies/:id', (req, res, next) => {
    const a = accountBy(h.int(req.params.id));
    if (!a) return next();
    const csrf = req.session.csrf;
    const mgr = h.can(req, 'manager');
    const plates = platesOf(a);
    const month = db.get('SELECT COUNT(*) n, COALESCE(SUM(amount), 0) amount, COALESCE(SUM(minutes), 0) minutes FROM pk_account_charges WHERE account_id = ? AND at >= ?', a.id, c.dayStart(monthStart()));
    const invs = db.all("SELECT * FROM invoices WHERE source = 'parking-account' AND source_id = ? ORDER BY due_date DESC LIMIT 24", a.id);
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('Status'))}</dt><dd>${badge(a.status)}</dd></div>
      <div><dt>${esc(tr('prk|Billing'))}</dt><dd>${esc(tr(MODE[a.mode]))} · ${esc(a.mode === 'fixed' ? tr('prk|{amount} a plate', { amount: ui.money(a.price) }) : `${tr('prk|{n}% off', { n: a.discount })}${a.cap ? ` · ${tr('prk|at most {amount} a month', { amount: ui.money(a.cap) })}` : ''}`)}</dd></div>
      ${a.brand_name ? `<div><dt>${esc(tr('prk|Tenant'))}</dt><dd><a href="/admin/brands/${a.brand_id}">${esc(a.brand_name)}</a></dd></div>` : ''}
      <div><dt>${esc(tr('prk|Contact'))}</dt><dd>${esc([a.contact_name, a.phone, a.email].filter(Boolean).join(' · ') || '—')}</dd></div>
      ${a.tax_id ? `<div><dt>${esc(tr('prk|Tax ID'))}</dt><dd>${esc(a.tax_id)}</dd></div>` : ''}
      <div><dt>${esc(tr('prk|Next invoice'))}</dt><dd>${esc(a.next_bill_on ? ui.date(a.next_bill_on) : '—')} · ${esc(tr('prk|due in {n} days', { n: a.terms_days }))}</dd></div>
      ${a.mode === 'usage' ? `<div><dt>${esc(tr('prk|This month so far'))}</dt><dd>${esc(tn(month.n, 'prk|{n} visit', 'prk|{n} visits'))} · ${esc(c.dur(month.minutes))} · <b>${c.money(month.amount)}</b></dd></div>` : ''}
      ${a.notes ? `<div><dt>${esc(tr('prk|Notes'))}</dt><dd>${esc(a.notes)}</dd></div>` : ''}</dl>`;
    const plateList = plates.length ? `<ul class="list pk-list">${plates.map((p) => `<li><a href="/admin/parking/subscriptions/${p.id}"><span class="what"><b>${esc(p.name)}</b><small><bdi>${esc(p.plates || p.card_uid || '')}</bdi></small></span>${p.status === 'active' ? ui.badge('a', tr('prk|Active'), 'ok') : ui.badge('s', tr('prk|Suspended'), 'amber')}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('prk|No plates yet.'))}</p>`;
    const add = mgr && a.status === 'active' ? ui.form(`/admin/parking/companies/${a.id}/plates`, csrf, `${ui.textarea('lines', tr('prk|Add plates, one per line'), '', { rows: 4, placeholder: 'ق ص ر 1234, Ahmed Samir\nس ع د 777, Mona Adel' })}<p class="muted small">${esc(tr('prk|A plate, and the driver’s name after a comma if you like.'))}</p>${ui.btn(esc(tr('prk|Add the plates')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' }) : '';
    const invTable = ui.table([
      { label: tr('Invoice'), render: (i) => `<a href="/admin/invoices/${i.id}/print">${esc(i.ref)}</a>` },
      { label: tr('prk|Period'), render: (i) => esc(`${ui.date(i.period_start)} – ${ui.date(i.period_end)}`) },
      { label: tr('prk|Amount'), num: true, render: (i) => c.money(i.total) },
      { label: tr('Status'), render: (i) => ui.badge(i.status, h.M.INVOICE_STATUS[i.status] || i.status) },
    ], invs, { empty: esc(tr('prk|No invoices yet.')) });
    const usage = a.mode === 'usage' ? ui.card(tr('prk|Latest visits'), ui.table([
      { label: tr('prk|When'), render: (x) => esc(ui.dt(x.at)) },
      { label: tr('prk|Plate'), render: (x) => `<bdi>${esc(x.plate || '')}</bdi>` },
      { label: tr('prk|Time parked'), render: (x) => esc(c.dur(x.minutes || 0)) },
      { label: tr('prk|Amount'), num: true, render: (x) => c.money(x.amount) },
    ], db.all('SELECT * FROM pk_account_charges WHERE account_id = ? ORDER BY at DESC LIMIT 30', a.id), { empty: esc(tr('prk|No visits yet.')) })) : '';
    const status = mgr ? `<div class="row">${a.status === 'active' ? ui.form(`/admin/parking/companies/${a.id}/status`, csrf, `<input type="hidden" name="status" value="suspended">${ui.btn(esc(tr('prk|Suspend')), { cls: 'btn--ghost btn--sm', attrs: { 'data-confirm': tr('prk|Suspend this account? Its plates park as visitors until it is active again.') } })}`) : ui.form(`/admin/parking/companies/${a.id}/status`, csrf, `<input type="hidden" name="status" value="active">${ui.btn(esc(tr('prk|Reactivate')), { cls: 'btn--ghost btn--sm' })}`)}${ui.btn(esc(tr('prk|Edit')), { href: `/admin/parking/companies/${a.id}/edit`, cls: 'btn--ghost btn--sm' })}</div>` : '';
    c.page(req, res, { title: a.name, crumbs: c.crumbs(['/admin/parking/companies', tr('prk|Companies')], [null, a.ref]), body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('prk|Plates'), `${plateList}${add}`, { sub: esc(tn(plates.length, 'prk|{n} plate', 'prk|{n} plates')) })}${usage}${ui.card(tr('prk|Invoices'), invTable)}</div><div class="stack">${ui.card(a.name, `${facts}${status}`)}</div></div>` });
  });
  router.get('/parking/companies/:id/edit', c.RM, (req, res, next) => {
    const a = accountBy(h.int(req.params.id));
    if (!a) return next();
    c.page(req, res, { title: a.name, crumbs: c.crumbs(['/admin/parking/companies', tr('prk|Companies')], [`/admin/parking/companies/${a.id}`, a.ref], [null, tr('prk|Edit')]), body: ui.card(a.name, ui.form(`/admin/parking/companies/${a.id}`, req.session.csrf, `${form(req, a)}${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' })) });
  });
  router.post('/parking/companies/:id', c.RM, (req, res, next) => {
    const a = accountBy(h.int(req.params.id));
    if (!a) return next();
    const v = values(req.body);
    if (!v.name) return c.back(req, res, `/admin/parking/companies/${a.id}/edit`, 'error', tr('prk|Type the company’s name.'));
    db.run('UPDATE pk_accounts SET name = ?, brand_id = ?, contact_name = ?, phone = ?, email = ?, tax_id = ?, address = ?, mode = ?, price = ?, discount = ?, cap = ?, terms_days = ?, notes = ?, updated_at = ? WHERE id = ?',
      v.name, v.brand_id, v.contact_name, v.phone, v.email, v.tax_id, v.address, v.mode, v.price, v.discount, v.cap, v.terms_days, v.notes, now(), a.id);
    h.log(req, 'Changed a company parking account', 'pk_account', a.id, v.name);
    c.back(req, res, `/admin/parking/companies/${a.id}`, 'ok', tr('Saved.'));
  });
  router.post('/parking/companies/:id/status', c.RM, (req, res, next) => {
    const a = accountBy(h.int(req.params.id));
    if (!a) return next();
    const st = req.body.status === 'active' ? 'active' : 'suspended';
    db.run('UPDATE pk_accounts SET status = ?, updated_at = ? WHERE id = ?', st, now(), a.id);
    h.log(req, 'Changed a company parking account', 'pk_account', a.id, `${a.name} · ${st}`);
    c.back(req, res, `/admin/parking/companies/${a.id}`, 'ok', tr('Saved.'));
  });
  router.post('/parking/companies/:id/plates', c.RM, (req, res, next) => {
    const a = accountBy(h.int(req.params.id));
    if (!a) return next();
    const lines = String(req.body.lines || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 200);
    let added = 0;
    const skipped = [];
    for (const line of lines) {
      const [plate, ...rest] = line.split(/[,،]/);
      const key = P.plateKey(plate);
      if (!key) { skipped.push(line); continue; }
      if (db.get("SELECT id FROM pk_permits WHERE plate_keys LIKE ? AND status IN ('active','suspended','pending')", `%,${key},%`)) { skipped.push(line); continue; }
      try {
        const p = P.savePermit({ holder: 'individual', name: (rest.join(',').trim() || a.name).slice(0, 120), plates: plate, starts_on: c.today(), price: 0, months: 1, cars: 1, auto_renew: true, demo: a.demo });
        db.run("UPDATE pk_permits SET account_id = ?, source = 'company', next_bill_on = NULL WHERE id = ?", a.id, p.id);
        added++;
      } catch {
        skipped.push(line);
      }
    }
    h.log(req, 'Added plates to a company parking account', 'pk_account', a.id, `${a.name} · ${added}`);
    c.back(req, res, `/admin/parking/companies/${a.id}`, skipped.length ? 'error' : 'ok', skipped.length ? tr('prk|{n} added. Not added (already on a subscription, or not a plate): {list}', { n: added, list: skipped.slice(0, 5).join(' · ') }) : tn(added, 'prk|{n} plate added.', 'prk|{n} plates added.'));
  });
};

module.exports.MODE = MODE;
module.exports.A_STATUS = A_STATUS;
