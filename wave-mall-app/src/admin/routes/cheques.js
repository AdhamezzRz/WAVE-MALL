'use strict';

// Cheques (/admin/cheques): received from tenants (often a year of post-dated cheques when a lease
// is signed), kept in the cheque portfolio, deposited at the bank when due, then collected (the
// money is recorded against the tenant's invoices, oldest first), bounced (and deposited again or
// returned) or returned to the tenant. Each step is in the cheque's history; depositing, collecting,
// bouncing and returning tell the tenant (portal and email, with whether they saw it) and the
// finance team.
//
//   held        in the portfolio (the safe)        → deposited, returned
//   deposited   at the bank, being collected       → collected, bounced
//   collected   paid: payments recorded             → bounced (the bank reversed it: payments undone)
//   bounced     refused by the bank                 → deposited again, returned
//   returned    handed back to the tenant

const { t: tr, tn, tx } = require('../i18n');

const SCHEMA = `
  CREATE TABLE cheques (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, number TEXT NOT NULL, bank TEXT, drawer TEXT, amount REAL NOT NULL,
    due_date TEXT NOT NULL, brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, lease_id INTEGER REFERENCES leases(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'held',
    received_on TEXT NOT NULL, received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    deposited_on TEXT, deposit_bank TEXT, deposit_ref TEXT, collected_on TEXT, payments TEXT, unallocated REAL NOT NULL DEFAULT 0,
    bounced_on TEXT, bounce_reason TEXT, bounces INTEGER NOT NULL DEFAULT 0, returned_on TEXT, return_reason TEXT, returned_to TEXT,
    note TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX cheques_status ON cheques(status, due_date);
  CREATE INDEX cheques_brand ON cheques(brand_id);
  CREATE TABLE cheque_events (
    id INTEGER PRIMARY KEY, cheque_id INTEGER NOT NULL REFERENCES cheques(id) ON DELETE CASCADE, status TEXT NOT NULL, note TEXT,
    notice_id INTEGER, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, at TEXT NOT NULL
  );
`;

const STATUS = {
  held: ['chq|In the portfolio', 'sky'], deposited: ['chq|At the bank', 'amber'], collected: ['chq|Collected', 'ok'],
  bounced: ['chq|Bounced', 'rose'], returned: ['chq|Returned', 'mute'],
};
const NEXT = { held: ['deposited', 'returned'], deposited: ['collected', 'bounced'], collected: ['bounced'], bounced: ['deposited', 'returned'], returned: [] };
const REASONS = ['chq|Insufficient funds', 'chq|Signature does not match', 'chq|Account closed', 'chq|Post-dated', 'chq|Stopped by the drawer', 'chq|Other'];

module.exports = function cheques(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  db.ensure('cheques-1', SCHEMA);
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const esc = ui.esc;
  const canMoney = (req) => h.can(req, 'manager') || h.canFinance(req);
  const RM = (req, res, next) => (canMoney(req) ? next() : h.auth.denied(req, res));
  const badge = (s) => ui.badge(s, tr((STATUS[s] || [s])[0]), (STATUS[s] || [])[1]);
  const chequeOf = (id) => db.get(`SELECT c.*, b.name brand_name, s.ref lease_ref, i.ref invoice_ref, u.name received_name FROM cheques c
    LEFT JOIN brands b ON b.id = c.brand_id LEFT JOIN leases s ON s.id = c.lease_id LEFT JOIN invoices i ON i.id = c.invoice_id LEFT JOIN users u ON u.id = c.received_by WHERE c.id = ?`, id);
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const dateOr = (d, fb = M.today()) => (isDate(d) ? d : fb);

  h.count('cheques', () => db.value("SELECT COUNT(*) FROM cheques WHERE (status = 'held' AND due_date <= ?) OR status = 'bounced'", M.today()));

  // ---------- the steps ----------
  function event(c, status, { note = null, user = null, notice = null } = {}) {
    db.run('INSERT INTO cheque_events (cheque_id, status, note, notice_id, user_id, at) VALUES (?, ?, ?, ?, ?, ?)', c.id, status, note, notice, user ? user.id : null, now());
  }
  // Tell the tenant (portal + email, tracked) and the finance team (email).
  const TELL = {
    deposited: ['chq|Your cheque {number} was deposited', 'chq|Your cheque {number} from {bank} for {amount}, due {due}, has been deposited at the bank for collection.'],
    collected: ['chq|Your cheque {number} was collected', 'chq|Thank you. Your cheque {number} for {amount} has been collected and applied to your account.'],
    bounced: ['chq|Your cheque {number} was returned by the bank', 'chq|Your cheque {number} for {amount}, due {due}, was returned unpaid by the bank ({reason}). Please contact the leasing office to settle it.'],
    returned: ['chq|Your cheque {number} is ready to collect', 'chq|Your cheque {number} for {amount} is being returned to you ({reason}). Please collect it from the leasing office.'],
  };
  function tell(c, status, reason) {
    if (!TELL[status] || !c.brand_id || !h.tenantNotify) return null;
    const params = { number: c.number, bank: c.bank || '—', amount: ui.money(c.amount), due: c.due_date, reason: reason || '—' };
    const notice = h.tenantNotify(c.brand_id, {
      kind: 'cheque', title: TELL[status][0], body: TELL[status][1], params, entity: 'cheque', entity_id: c.id, link: '/portal/cheques', demo: c.demo,
      rows: [['chq|Cheque', c.number], ['chq|Bank', c.bank || '—'], ['chq|Amount', ui.money(c.amount)], ['chq|Due', c.due_date]],
    });
    // the finance team hears about a bounced cheque at once
    if (status === 'bounced' && h.mail && !c.demo) {
      for (const u of db.all("SELECT * FROM users WHERE active = 1 AND email IS NOT NULL AND (role IN ('admin','manager') OR finance = 1)")) {
        h.mail.send({ to: u.email, subject: tr('chq|Cheque {number} from {brand} bounced', { number: c.number, brand: c.brand_name || '' }), text: tr('chq|Cheque {number} for {amount} bounced: {reason}.', { number: c.number, amount: ui.money(c.amount), reason: reason || '—' }), lang: u.lang === 'ar' ? 'ar' : 'en' });
      }
    }
    return notice;
  }
  // Collected: the money goes on the tenant's invoices — the cheque's own invoice first, then the
  // oldest open ones of the lease (or the brand). Whatever is left is noted as unallocated.
  function allocate(c, { user = null, date = M.today() } = {}) {
    let left = r2(c.amount);
    const pays = [];
    const open = c.lease_id
      ? db.all("SELECT * FROM invoices WHERE lease_id = ? AND status IN ('open','partial') ORDER BY due_date, id", c.lease_id)
      : c.brand_id ? db.all("SELECT * FROM invoices WHERE brand_id = ? AND status IN ('open','partial') ORDER BY due_date, id", c.brand_id) : [];
    const own = c.invoice_id ? db.get("SELECT * FROM invoices WHERE id = ? AND status IN ('open','partial')", c.invoice_id) : null;
    const targets = own ? [own, ...open.filter((i) => i.id !== own.id)] : open;
    for (const inv of targets) {
      if (left <= 0) break;
      const amt = r2(Math.min(left, inv.total - inv.paid));
      if (amt <= 0) continue;
      const out = h.billing.recordPayment({ invoice_id: inv.id, amount: amt, date, method: 'cheque', reference: `Cheque ${c.number}`, note: c.bank ? `Cheque ${c.number} · ${c.bank}` : `Cheque ${c.number}`, demo: c.demo }, { user });
      pays.push(out.payment.id);
      left = r2(left - amt);
    }
    return { pays, left };
  }
  // Move a cheque to its next step. Throws an error key when the step is not possible.
  function move(c, to, { user = null, date = M.today(), bank = null, ref = null, reason = null, returnedTo = null } = {}) {
    if (!(NEXT[c.status] || []).includes(to)) throw new Error('chq|That step is not possible for this cheque now.');
    return db.tx(() => {
      const t = now();
      let note = null;
      if (to === 'deposited') {
        db.run("UPDATE cheques SET status = 'deposited', deposited_on = ?, deposit_bank = COALESCE(?, deposit_bank), deposit_ref = COALESCE(?, deposit_ref), updated_at = ? WHERE id = ?", date, bank, ref, t, c.id);
        note = [bank, ref].filter(Boolean).join(' · ') || null;
      } else if (to === 'collected') {
        const a = allocate(c, { user, date });
        db.run("UPDATE cheques SET status = 'collected', collected_on = ?, payments = ?, unallocated = ?, updated_at = ? WHERE id = ?", date, JSON.stringify(a.pays), a.left, t, c.id);
        note = a.left > 0 ? `Unallocated: ${a.left}` : null;
      } else if (to === 'bounced') {
        // a cheque the bank reverses after collection: its payments are undone
        if (c.status === 'collected') for (const pid of JSON.parse(c.payments || '[]')) { try { h.billing.reversePayment(pid, { user, note: `Cheque ${c.number} bounced` }); } catch { /* already reversed */ } }
        db.run("UPDATE cheques SET status = 'bounced', bounced_on = ?, bounce_reason = ?, bounces = bounces + 1, payments = NULL, unallocated = 0, updated_at = ? WHERE id = ?", date, reason, t, c.id);
        note = reason;
      } else if (to === 'returned') {
        db.run("UPDATE cheques SET status = 'returned', returned_on = ?, return_reason = ?, returned_to = ?, updated_at = ? WHERE id = ?", date, reason, returnedTo, t, c.id);
        note = [reason, returnedTo].filter(Boolean).join(' · ') || null;
      }
      const fresh = chequeOf(c.id);
      const notice = tell(fresh, to, reason ? tx(reason) : null);
      event(fresh, to, { note, user, notice });
      return fresh;
    });
  }
  h.cheques = { move, allocate, chequeOf, STATUS };

  // ---------- receive ----------
  router.get('/cheques/receive', RM, (req, res) => {
    const brands = db.all("SELECT DISTINCT b.id, b.name FROM brands b JOIN leases s ON s.brand_id = b.id WHERE s.status IN ('active','draft') ORDER BY b.name");
    const lease = req.query.lease ? db.get('SELECT s.*, b.name brand_name FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.id = ?', h.int(req.query.lease)) : null;
    const brandId = lease ? lease.brand_id : h.int(req.query.brand);
    const leases = brandId ? db.all("SELECT id, ref FROM leases WHERE brand_id = ? AND status IN ('active','draft') ORDER BY start_date DESC", brandId) : [];
    // one row per open invoice of the lease: the cheques a tenant usually hands over at signing
    const invoices = lease ? db.all("SELECT * FROM invoices WHERE lease_id = ? AND status IN ('open','partial') AND id NOT IN (SELECT invoice_id FROM cheques WHERE invoice_id IS NOT NULL AND status IN ('held','deposited','collected')) ORDER BY due_date LIMIT 24", lease.id) : [];
    const n = Math.max(6, invoices.length);
    const rows = Array.from({ length: n }, (_, i) => {
      const inv = invoices[i];
      return `<tr><td>${i + 1}</td><td><input name="number_${i}" class="ltr" autocomplete="off"></td><td><input name="bank_${i}" list="banks"></td><td><input type="number" name="amount_${i}" step="0.01" min="0" value="${inv ? r2(inv.total - inv.paid) : ''}"></td><td><input type="date" name="due_${i}" value="${inv ? inv.due_date : ''}"></td><td>${inv ? `<input type="hidden" name="invoice_${i}" value="${inv.id}"><small class="ltr">${esc(inv.ref)}</small>` : ''}</td></tr>`;
    }).join('');
    const pick = `<form method="get" action="/admin/cheques/receive" class="stack"><div class="fields">${ui.select('brand', tr('Tenant'), brands.map((b) => [b.id, b.name]), brandId || '', { blank: tr('Choose…') })}${leases.length ? ui.select('lease', tr('Lease'), leases.map((l) => [l.id, l.ref]), lease ? lease.id : '', { blank: tr('chq|No lease') }) : ''}</div>${ui.btn(esc(tr('chq|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    const banks = db.all("SELECT DISTINCT bank FROM cheques WHERE bank IS NOT NULL ORDER BY bank LIMIT 40").map((x) => x.bank);
    const form = brandId ? ui.form('/admin/cheques', req.session.csrf, `<input type="hidden" name="brand_id" value="${brandId}">${lease ? `<input type="hidden" name="lease_id" value="${lease.id}">` : ''}<input type="hidden" name="rows" value="${n}">
      <div class="fields">${ui.input('drawer', tr('chq|Drawn by'), lease ? lease.brand_name : '', { placeholder: tr('chq|Company or person on the cheque') })}${ui.input('received_on', tr('chq|Received on'), M.today(), { type: 'date', required: true })}</div>
      <datalist id="banks">${['National Bank of Egypt', 'Banque Misr', 'CIB', 'QNB', 'HSBC', 'Banque du Caire', 'AAIB', 'Emirates NBD', ...banks].filter((x, i, a) => a.indexOf(x) === i).map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
      <div class="tablewrap"><table class="table chq-rows"><thead><tr><th>#</th><th>${esc(tr('chq|Cheque number'))}</th><th>${esc(tr('chq|Bank'))}</th><th>${esc(tr('chq|Amount'))}</th><th>${esc(tr('chq|Due'))}</th><th>${esc(tr('chq|For invoice'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">${esc(tr('chq|Fill a row for each cheque; empty rows are skipped. With a lease chosen, its open invoices fill the amounts and dates.'))}</p>
      ${ui.btn(esc(tr('chq|Put in the portfolio')), { cls: 'btn--primary' })}`, { cls: 'stack' }) : `<p class="muted">${esc(tr('chq|Choose the tenant first.'))}</p>`;
    h.page(req, res, {
      title: tr('chq|Receive cheques'), crumbs: [['/admin/cheques', tr('chq|Cheques')], [null, tr('chq|Receive')]], active: '/admin/cheques', wide: true,
      body: `${ui.card(tr('chq|From'), pick)}${ui.card(tr('chq|Cheques received'), form)}`,
    });
  });
  router.post('/cheques', RM, (req, res) => {
    const b = req.body;
    const brand = db.get('SELECT * FROM brands WHERE id = ?', h.int(b.brand_id));
    const lease = b.lease_id ? db.get('SELECT * FROM leases WHERE id = ? AND brand_id = ?', h.int(b.lease_id), brand ? brand.id : -1) : null;
    if (!brand) return h.back(req, res, '/admin/cheques/receive', 'error', tr('chq|Choose the tenant first.'));
    const n = Math.min(60, h.int(b.rows) || 6);
    const back = `/admin/cheques/receive?brand=${brand.id}${lease ? `&lease=${lease.id}` : ''}`;
    const list = [];
    for (let i = 0; i < n; i++) {
      const number = h.str(b[`number_${i}`], 40);
      const amount = h.numv(b[`amount_${i}`]);
      if (!number && !amount) continue;
      if (!number || !(amount > 0) || !isDate(b[`due_${i}`])) return h.back(req, res, back, 'error', tr('chq|Row {n}: enter the cheque number, the amount and the due date.', { n: i + 1 }));
      list.push({ number, amount: r2(amount), bank: h.str(b[`bank_${i}`], 80) || null, due: b[`due_${i}`], invoice: h.int(b[`invoice_${i}`]) || null });
    }
    if (!list.length) return h.back(req, res, back, 'error', tr('chq|Enter at least one cheque.'));
    const received = dateOr(b.received_on);
    const ids = db.tx(() => list.map((c) => {
      const t = now();
      const id = Number(db.run(`INSERT INTO cheques (ref, number, bank, drawer, amount, due_date, brand_id, lease_id, invoice_id, status, received_on, received_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`, db.nextRef('cheques', 'CQ', 5, true), c.number, c.bank, h.str(b.drawer, 120) || brand.name, c.amount, c.due, brand.id, lease ? lease.id : null, c.invoice, received, req.user.id, t, t).lastInsertRowid);
      event({ id }, 'held', { user: req.user });
      return id;
    }));
    h.log(req, 'Received cheques', 'brand', brand.id, `${brand.name} · ${ids.length} · ${r2(list.reduce((s, c) => s + c.amount, 0))}`);
    h.back(req, res, `/admin/cheques?brand=${brand.id}`, 'ok', tn(ids.length, 'chq|{n} cheque put in the portfolio.', 'chq|{n} cheques put in the portfolio.'));
  });

  // ---------- the portfolio ----------
  router.get('/cheques', (req, res) => {
    const st = STATUS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'held';
    const f = h.listFilters(req, {
      cols: { date: 'c.due_date', brand: 'c.brand_id', lease: 'c.lease_id' }, dateLabel: tr('chq|Due'), keep: ['status'],
      sorts: [['default', st === 'held' ? 'sort|Due date: soonest first' : 'sort|Recently updated', st === 'held' ? 'c.due_date' : 'c.updated_at DESC'],
        ['due', 'sort|Due date: soonest first', 'c.due_date'], ['due_late', 'sort|Due date: latest first', 'c.due_date DESC'], ['received', 'sort|Received: newest first', 'c.received_on DESC'],
        ['amount', 'sort|Amount: highest first', 'c.amount DESC'], ['amount_asc', 'sort|Amount: lowest first', 'c.amount ASC'], ['tenant', 'sort|Name: A to Z', 'b.name COLLATE NOCASE']],
    });
    const where = [...(st === 'all' ? [] : ['c.status = ?']), ...f.where];
    const args = [...(st === 'all' ? [] : [st]), ...f.args];
    const sort = f.order;
    const rows = db.all(`SELECT c.*, b.name brand_name, s.ref lease_ref FROM cheques c LEFT JOIN brands b ON b.id = c.brand_id LEFT JOIN leases s ON s.id = c.lease_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${sort} LIMIT 500`, ...args);
    const t = M.today();
    const sum = (q, ...a) => r2(db.value(`SELECT COALESCE(SUM(amount), 0) FROM cheques WHERE ${q}`, ...a));
    const kpis = [
      ui.kpi({ label: tr('chq|In the portfolio'), value: ui.money(sum("status = 'held'"), { compact: true }), sub: esc(tn(db.value("SELECT COUNT(*) FROM cheques WHERE status = 'held'"), 'chq|{n} cheque', 'chq|{n} cheques')), href: '/admin/cheques?status=held' }),
      ui.kpi({ label: tr('chq|Due to deposit'), value: ui.money(sum("status = 'held' AND due_date <= ?", M.addDays(t, 7)), { compact: true }), sub: esc(tr('chq|due today or in the next 7 days')), tone: db.value("SELECT COUNT(*) FROM cheques WHERE status = 'held' AND due_date <= ?", t) ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('chq|At the bank'), value: ui.money(sum("status = 'deposited'"), { compact: true }), href: '/admin/cheques?status=deposited' }),
      ui.kpi({ label: tr('chq|Bounced'), value: ui.money(sum("status = 'bounced'"), { compact: true }), tone: sum("status = 'bounced'") ? 'kpi--alert' : '', href: '/admin/cheques?status=bounced' }),
    ].join('');
    const keep = (k) => (req.query[k] ? `&${k}=${encodeURIComponent(req.query[k])}` : '');
    const qs = `${keep('brand')}${keep('lease')}${keep('from')}${keep('to')}${keep('sort')}`;
    const tabs = `<nav class="tabs">${[...Object.keys(STATUS), 'all'].map((k) => `<a class="tab${st === k ? ' is-on' : ''}" href="/admin/cheques?status=${k}${qs}">${esc(k === 'all' ? tr('All') : tr(STATUS[k][0]))}${k === 'bounced' && db.value("SELECT COUNT(*) FROM cheques WHERE status = 'bounced'") ? ` <b class="nav__count">${db.value("SELECT COUNT(*) FROM cheques WHERE status = 'bounced'")}</b>` : ''}</a>`).join('')}</nav>`;
    const csrf = req.session.csrf;
    const selectable = st === 'held' && canMoney(req);
    const table = ui.table([
      ...(selectable ? [{ label: '', render: (c) => `<input type="checkbox" name="ids" value="${c.id}" form="bulk-deposit" aria-label="${esc(c.number)}"${c.due_date <= t ? ' checked' : ''}>` }] : []),
      { label: tr('chq|Cheque'), render: (c) => `<b class="ltr">${esc(c.number)}</b><small class="sub">${esc([c.bank, c.ref].filter(Boolean).join(' · '))}</small>` },
      { label: tr('Tenant'), render: (c) => `${esc(c.brand_name || c.drawer || '—')}${c.lease_ref ? `<small class="sub">${esc(c.lease_ref)}</small>` : ''}` },
      { label: tr('chq|Due'), render: (c) => `<span class="${c.status === 'held' && c.due_date <= t ? 'late' : ''}">${esc(ui.date(c.due_date))}</span><small class="sub">${ui.rel(c.due_date)}</small>` },
      { label: tr('chq|Amount'), num: true, render: (c) => `<b>${ui.money(c.amount, { cur: false })}</b>` },
      { label: tr('Status'), render: (c) => `${badge(c.status)}${c.bounces && c.status !== 'bounced' ? ` <small class="late">${esc(tn(c.bounces, 'chq|bounced once', 'chq|bounced {n} times'))}</small>` : ''}` },
    ], rows, { empty: esc(tr('chq|No cheques here.')), href: (c) => `/admin/cheques/${c.id}` });
    const bulk = selectable && rows.length ? ui.form('/admin/cheques/deposit', csrf, `<div class="fields">${ui.input('date', tr('chq|Deposited on'), t, { type: 'date', required: true })}${ui.input('bank', tr('chq|Into the account at'), db.setting('chq_bank') || '', { placeholder: tr('e.g. CIB current account') })}${ui.input('ref', tr('chq|Deposit slip'), '', {})}</div>${ui.btn(esc(tr('chq|Deposit the ticked cheques')), { cls: 'btn--primary btn--sm', ic: 'check' })}`, { cls: 'stack', attrs: { id: 'bulk-deposit' } }) : '';
    const total = r2(rows.reduce((s, c) => s + c.amount, 0));
    h.page(req, res, {
      title: tr('chq|Cheques'), active: '/admin/cheques', wide: true,
      actions: canMoney(req) ? ui.btn(esc(tr('chq|Receive cheques')), { href: '/admin/cheques/receive', cls: 'btn--primary', ic: 'plus' }) : '',
      body: `<div class="kpis kpis--4">${kpis}</div>${tabs}${f.html}${ui.card(tr('chq|{n} cheques · {amount}', { n: rows.length, amount: ui.money(total) }), table, { sub: esc(st === 'held' ? tr('chq|Tick the cheques to take to the bank. Those due today or earlier are ticked.') : '') })}${bulk ? ui.card(tr('chq|Deposit at the bank'), bulk) : ''}`,
    });
  });

  router.post('/cheques/deposit', RM, (req, res) => {
    const ids = h.list(req.body.ids).map(Number).filter(Boolean);
    let n = 0;
    for (const id of ids) {
      const c = chequeOf(id);
      if (!c || c.status !== 'held') continue;
      move(c, 'deposited', { user: req.user, date: dateOr(req.body.date), bank: h.str(req.body.bank, 80) || null, ref: h.str(req.body.ref, 60) || null });
      n++;
    }
    if (h.str(req.body.bank, 80)) db.setSetting('chq_bank', h.str(req.body.bank, 80));
    h.log(req, 'Deposited cheques', 'cheque', null, String(n));
    h.back(req, res, '/admin/cheques?status=deposited', n ? 'ok' : 'error', n ? tn(n, 'chq|{n} cheque deposited. The tenant was told.', 'chq|{n} cheques deposited. The tenants were told.') : tr('chq|Tick the cheques to deposit.'));
  });

  // ---------- one cheque ----------
  router.get('/cheques/:id', (req, res, next) => {
    const c = chequeOf(h.int(req.params.id));
    if (!c) return next();
    const csrf = req.session.csrf;
    const events = db.all('SELECT e.*, u.name user_name FROM cheque_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.cheque_id = ? ORDER BY e.id', c.id);
    const pays = JSON.parse(c.payments || '[]').map((id) => db.get('SELECT p.*, i.ref invoice_ref, i.id invoice_id FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?', id)).filter(Boolean);
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('chq|Cheque'))}</dt><dd><b class="ltr">${esc(c.number)}</b> · ${esc(c.bank || '—')}</dd></div>
      <div><dt>${esc(tr('chq|Amount'))}</dt><dd><b>${ui.money(c.amount)}</b></dd></div>
      <div><dt>${esc(tr('chq|Due'))}</dt><dd>${esc(ui.date(c.due_date))} · ${ui.rel(c.due_date)}</dd></div>
      <div><dt>${esc(tr('Tenant'))}</dt><dd>${c.brand_id ? `<a href="/admin/tenants/${c.brand_id}">${esc(c.brand_name)}</a>` : esc(c.drawer || '—')}${c.drawer && c.drawer !== c.brand_name ? `<small class="sub">${esc(tr('chq|Drawn by {name}', { name: c.drawer }))}</small>` : ''}</dd></div>
      ${c.lease_id ? `<div><dt>${esc(tr('Lease'))}</dt><dd><a href="/admin/leases/${c.lease_id}">${esc(c.lease_ref)}</a></dd></div>` : ''}
      ${c.invoice_id ? `<div><dt>${esc(tr('chq|For invoice'))}</dt><dd><a href="/admin/invoices/${c.invoice_id}">${esc(c.invoice_ref)}</a></dd></div>` : ''}
      <div><dt>${esc(tr('Status'))}</dt><dd>${badge(c.status)}</dd></div>
      <div><dt>${esc(tr('chq|Received on'))}</dt><dd>${esc(ui.date(c.received_on))}${c.received_name ? ` · ${esc(c.received_name)}` : ''}</dd></div>
      ${c.deposited_on ? `<div><dt>${esc(tr('chq|Deposited on'))}</dt><dd>${esc(ui.date(c.deposited_on))}${c.deposit_bank ? ` · ${esc(c.deposit_bank)}` : ''}${c.deposit_ref ? ` · <span class="ltr">${esc(c.deposit_ref)}</span>` : ''}</dd></div>` : ''}
      ${c.status === 'bounced' || c.bounces ? `<div><dt>${esc(tr('chq|Bounced'))}</dt><dd>${esc(c.bounced_on ? ui.date(c.bounced_on) : '')}${c.bounce_reason ? ` · ${esc(tr(c.bounce_reason))}` : ''}${c.bounces > 1 ? ` · ${esc(tn(c.bounces, 'chq|bounced once', 'chq|bounced {n} times'))}` : ''}</dd></div>` : ''}
      ${c.returned_on ? `<div><dt>${esc(tr('chq|Returned'))}</dt><dd>${esc(ui.date(c.returned_on))}${c.return_reason ? ` · ${esc(tr(c.return_reason))}` : ''}${c.returned_to ? ` · ${esc(c.returned_to)}` : ''}</dd></div>` : ''}
    </dl>`;
    const payList = pays.length ? ui.card(tr('chq|Applied to'), `<ul class="list">${pays.map((p) => `<li><a href="/admin/invoices/${p.invoice_id}"><span class="what"><b class="ltr">${esc(p.invoice_ref || '')}</b><small>${esc(p.ref)} · ${esc(ui.date(p.date))}</small></span><b>${ui.money(p.amount)}</b>${p.status === 'reversed' ? ui.badge('void', tr('pay|Reversed')) : ''}</a></li>`).join('')}</ul>${c.unallocated > 0 ? `<p class="alert alert--warn">${esc(tr('chq|{amount} of this cheque is not on any invoice yet.', { amount: ui.money(c.unallocated) }))}</p>` : ''}`) : '';
    const timeline = `<ol class="tl">${events.map((e) => {
      const seen = e.notice_id && h.noticeSeen ? h.noticeSeen(e.notice_id) : null;
      return `<li><span class="tl__ic">${ui.icon(e.status === 'bounced' ? 'log' : 'check')}</span><div><p><b>${esc(tr(STATUS[e.status] ? STATUS[e.status][0] : e.status))}</b>${e.note ? ` · ${esc(tx(e.note))}` : ''}</p><small class="muted">${esc([ui.dt(e.at), e.user_name].filter(Boolean).join(' · '))}</small>${e.notice_id ? `<p class="small"><a href="/admin/portal/notices/${e.notice_id}">${esc(tr('chq|Tenant told'))}</a> ${h.seenBadge ? h.seenBadge(seen && seen.seen) : ''}</p>` : ''}</div></li>`;
    }).join('')}</ol>`;
    const steps = canMoney(req) ? NEXT[c.status].map((to) => {
      if (to === 'deposited') return ui.form(`/admin/cheques/${c.id}/move`, csrf, `<input type="hidden" name="to" value="deposited"><div class="fields">${ui.input('date', tr('chq|Deposited on'), M.today(), { type: 'date' })}${ui.input('bank', tr('chq|Into the account at'), c.deposit_bank || db.setting('chq_bank') || '')}${ui.input('ref', tr('chq|Deposit slip'), '')}</div>${ui.btn(esc(c.status === 'bounced' ? tr('chq|Deposit again') : tr('chq|Deposit at the bank')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' });
      if (to === 'collected') return ui.form(`/admin/cheques/${c.id}/move`, csrf, `<input type="hidden" name="to" value="collected">${ui.input('date', tr('chq|Collected on'), M.today(), { type: 'date' })}<p class="muted small">${esc(tr('chq|The amount is recorded as paid on the tenant’s invoices, this cheque’s invoice first, then the oldest.'))}</p>${ui.btn(esc(tr('chq|Mark as collected')), { cls: 'btn--primary btn--sm', ic: 'check' })}`, { cls: 'stack' });
      if (to === 'bounced') return `<details class="danger"><summary>${esc(tr('chq|The bank returned it'))}</summary>${ui.form(`/admin/cheques/${c.id}/move`, csrf, `<input type="hidden" name="to" value="bounced">${ui.input('date', tr('chq|Returned by the bank on'), M.today(), { type: 'date' })}${ui.select('reason', tr('chq|Reason'), REASONS.map((r) => [r, tr(r)]), REASONS[0])}${c.status === 'collected' ? `<p class="alert alert--warn">${esc(tr('chq|The payments recorded from it are reversed.'))}</p>` : ''}${ui.btn(esc(tr('chq|Mark as bounced')), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('chq|Mark this cheque as bounced? The tenant is told.') } })}`, { cls: 'stack' })}</details>`;
      if (to === 'returned') return `<details class="pop-inline"><summary class="btn btn--ghost btn--sm">${esc(tr('chq|Return to the tenant'))}</summary>${ui.form(`/admin/cheques/${c.id}/move`, csrf, `<input type="hidden" name="to" value="returned">${ui.input('date', tr('chq|Returned on'), M.today(), { type: 'date' })}${ui.select('reason', tr('chq|Reason'), [['chq|Replaced by another payment', tr('chq|Replaced by another payment')], ['chq|Lease ended', tr('chq|Lease ended')], ['chq|Bounced, settled another way', tr('chq|Bounced, settled another way')], ['chq|Other', tr('chq|Other')]], c.status === 'bounced' ? 'chq|Bounced, settled another way' : 'chq|Replaced by another payment')}${ui.input('returned_to', tr('chq|Handed to (name and ID)'), '')}${ui.btn(esc(tr('chq|Return the cheque')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })}</details>`;
      return '';
    }).join('') : '';
    h.page(req, res, {
      title: tr('chq|Cheque {number}', { number: c.number }), crumbs: [['/admin/cheques', tr('chq|Cheques')], [null, c.ref]], active: '/admin/cheques',
      body: `<div class="grid grid--side"><div class="stack">${ui.card(c.ref, facts, { action: badge(c.status) })}${payList}${ui.card(tr('chq|History'), timeline)}</div><div class="stack">${steps ? ui.card(tr('chq|Next step'), `<div class="stack">${steps}</div>`) : ''}</div></div>`,
    });
  });
  router.post('/cheques/:id/move', RM, (req, res, next) => {
    const c = chequeOf(h.int(req.params.id));
    if (!c) return next();
    const to = String(req.body.to || '');
    try {
      move(c, to, { user: req.user, date: dateOr(req.body.date), bank: h.str(req.body.bank, 80) || null, ref: h.str(req.body.ref, 60) || null, reason: h.str(req.body.reason, 120) || null, returnedTo: h.str(req.body.returned_to, 120) || null });
    } catch (e) {
      return h.back(req, res, `/admin/cheques/${c.id}`, 'error', tr(e.message));
    }
    h.log(req, `Cheque ${to}`, 'cheque', c.id, `${c.number} · ${c.amount}`);
    h.back(req, res, `/admin/cheques/${c.id}`, 'ok', tr({ deposited: 'chq|Deposited. The tenant was told.', collected: 'chq|Collected and recorded as paid.', bounced: 'chq|Marked as bounced. The tenant and the finance team were told.', returned: 'chq|Returned. The tenant was told.' }[to] || 'Saved.'));
  });

  // ---------- on other pages ----------
  const listOf = (rows) => (rows.length ? `<ul class="list">${rows.map((c) => `<li><a href="/admin/cheques/${c.id}"><span class="what"><b class="ltr">${esc(c.number)}</b><small>${esc([c.bank, ui.date(c.due_date)].filter(Boolean).join(' · '))}</small></span><b>${ui.money(c.amount, { compact: true })}</b>${badge(c.status)}</a></li>`).join('')}</ul>` : '');
  (h.leaseCards = h.leaseCards || []).push((req, s) => {
    const rows = db.all('SELECT * FROM cheques WHERE lease_id = ? ORDER BY due_date LIMIT 24', s.id);
    const add = canMoney(req) && ['active', 'draft'].includes(s.status) ? ui.btn(esc(tr('chq|Receive cheques')), { href: `/admin/cheques/receive?lease=${s.id}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '';
    if (!rows.length && !add) return '';
    return ui.card(tr('chq|Cheques'), rows.length ? listOf(rows) : `<p class="muted pad">${esc(tr('chq|No cheques received for this lease.'))}</p>`, { action: add });
  });
  (h.invoiceCards = h.invoiceCards || []).push((req, i) => {
    const rows = db.all('SELECT * FROM cheques WHERE invoice_id = ? ORDER BY id', i.id);
    return rows.length ? ui.card(tr('chq|Cheques'), listOf(rows)) : '';
  });
  (h.tenantCards = h.tenantCards || []).push((req, b) => {
    const rows = db.all("SELECT * FROM cheques WHERE brand_id = ? AND status IN ('held','deposited','bounced') ORDER BY due_date LIMIT 12", b.id);
    return rows.length ? ui.card(tr('chq|Cheques'), listOf(rows), { action: ui.btn(esc(tr('All')), { href: `/admin/cheques?status=all&brand=${b.id}`, cls: 'btn--ghost btn--sm' }) }) : '';
  });
  // the tenant's own cheques in the portal
  if (h.portal && h.portal.tab) {
    h.portal.tab({ key: 'cheques', href: '/portal/cheques', label: 'chq|Cheques', icon: 'bill', order: 25 });
    h.portal.router.get('/cheques', h.portal.requireTenant, (req, res) => {
      const rows = db.all('SELECT * FROM cheques WHERE brand_id = ? ORDER BY due_date DESC LIMIT 100', h.portal.brandId ? h.portal.brandId(req) : req.tenant.brand_id);
      const table = ui.table([
        { label: tr('chq|Cheque'), render: (c) => `<b class="ltr">${esc(c.number)}</b><small class="sub">${esc(c.bank || '')}</small>` },
        { label: tr('chq|Due'), render: (c) => esc(ui.date(c.due_date)) },
        { label: tr('chq|Amount'), num: true, render: (c) => ui.money(c.amount) },
        { label: tr('Status'), render: (c) => badge(c.status) },
      ], rows, { empty: esc(tr('chq|No cheques with The Wave.')) });
      h.portal.page(req, res, { title: tr('chq|Cheques'), active: 'cheques', body: ui.card(tr('chq|Your cheques'), table, { sub: esc(tr('chq|The cheques you gave The Wave and where each one is.')) }) });
    });
  }
};

module.exports.STATUS = STATUS;
module.exports.SCHEMA = SCHEMA;
