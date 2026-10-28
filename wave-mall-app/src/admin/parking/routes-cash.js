'use strict';

// The car park's cash safe (/admin/parking/safe). Cash moves: a till's starting float out of the safe,
// drops from a drawer during a shift into it, the counted cash of a closed till into it, and
// collections by the bank (or a cash-in-transit company) out of it, confirmed when the bank
// credits the account. Collections and differences go to the books:
//   collection   cash → bank clearing (money in transit)
//   short / over on the bank's count, or an adjustment of the safe   other expenses / other income

const { t: tr } = require('../i18n');

const KIND = {
  float: ['prk|Starting cash to a till', 'sky'], drop: ['prk|Drop from a drawer', 'sea'], till: ['prk|Till closed', 'forest'],
  collection: ['prk|Collected by the bank', 'cocoa'], adjust: ['prk|Adjustment', 'amber'],
};

module.exports = function cashRoutes(router, h, c) {
  const { db, ui } = h;
  const { P, esc } = c;
  const now = () => new Date().toISOString();
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const SUB = [['/admin/parking/tills', 'prk|Tills'], ['/admin/parking/safe', 'prk|Safe'], ['/admin/parking/ereceipts', 'prk|E-receipts']];
  const canMoney = (req) => h.can(req, 'manager') || h.canFinance(req);
  const RMF = (req, res, next) => (canMoney(req) ? next() : h.auth.denied(req, res));
  const kindBadge = (k) => ui.badge(k, tr((KIND[k] || [k])[0]), (KIND[k] || [])[1]);

  // the books: the account cash is kept in, and posting with the ledger when accounting is there
  const ledger = () => (h.ledger && typeof h.ledger.post === 'function' ? h.ledger : null);
  const cashAccount = (L) => {
    const code = L.S('method_cash', '');
    return code && L.byCode(code) ? L.byCode(code).id : 'petty_cash';
  };
  function book(memo, lines, { date = c.today(), source, user, demo = 0 }) {
    const L = ledger();
    if (!L) return null;
    try {
      return L.post({ date: L.firstOpen(date), memo, kind: 'auto', source, lines, user, demo });
    } catch (e) {
      console.error('[parking] cash not posted:', e.message);
      return null;
    }
  }

  // ---------- a drop during a shift ----------
  (h.parkingTillCards = h.parkingTillCards || []).push((req, t) => {
    if (t.status !== 'open' || !(t.user_id === req.user.id ? h.can(req, 'agent') : h.can(req, 'manager'))) return t.drops ? ui.card(tr('prk|Moved to the safe'), `<p><b>${c.money(t.drops)}</b></p>`) : '';
    return ui.card(tr('prk|Move cash to the safe'), ui.form(`/admin/parking/tills/${t.id}/drop`, req.session.csrf, `<div class="fields">${ui.input('amount', tr('prk|Amount'), '', { type: 'number', min: 1, step: 1, required: true })}${ui.input('witness', tr('prk|Witness'), '', { placeholder: tr('prk|Who saw it go in') })}</div>${ui.btn(esc(tr('prk|Into the safe')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' }), { sub: esc(tr('prk|Keep the drawer light during a busy shift. Already moved: {amount}.', { amount: c.money(t.drops || 0) })) });
  });
  router.post('/parking/tills/:id/drop', c.RA, (req, res, next) => {
    const t = P.tillBy(h.int(req.params.id));
    if (!t) return next();
    if (t.user_id !== req.user.id && !h.can(req, 'manager')) return h.auth.denied(req, res);
    try {
      const m = P.drop(t, { amount: h.numv(req.body.amount), user: req.user, witness: h.str(req.body.witness, 80) || null });
      h.log(req, 'Moved till cash to the safe', 'pk_till', t.id, `${t.ref} · ${m.amount}`);
      c.back(req, res, `/admin/parking/tills/${t.id}`, 'ok', tr('prk|{amount} moved to the safe.', { amount: c.money(m.amount) }));
    } catch (e) {
      c.fail(req, res, `/admin/parking/tills/${t.id}`, e);
    }
  });

  // ---------- the safe ----------
  router.get('/parking/safe', (req, res) => {
    const balance = P.safeBalance();
    const transit = db.all("SELECT * FROM pk_safe WHERE kind = 'collection' AND status = 'in_transit' ORDER BY at");
    const month = c.today().slice(0, 7);
    const collected = r2(-db.value("SELECT COALESCE(SUM(amount), 0) FROM pk_safe WHERE kind = 'collection' AND substr(at, 1, 7) = ?", month));
    const diffs = r2(db.value("SELECT COALESCE(SUM(confirmed_amount + amount), 0) FROM pk_safe WHERE kind = 'collection' AND status = 'banked' AND substr(at, 1, 7) = ?", month));
    const kpis = [
      ui.kpi({ label: tr('prk|In the safe now'), value: c.money(balance) }),
      ui.kpi({ label: tr('prk|On the way to the bank'), value: c.money(r2(-transit.reduce((s, x) => s + x.amount, 0))), sub: esc(transit.length ? tr('prk|{n} bags', { n: transit.length }) : '') }),
      ui.kpi({ label: tr('prk|Collected this month'), value: c.money(collected) }),
      ui.kpi({ label: tr('prk|Bank count differences'), value: c.money(diffs), tone: diffs < 0 ? 'kpi--alert' : '' }),
    ].join('');
    // the last two weeks, day by day: what the tills should have had, what was counted, drops, collections
    const days = Array.from({ length: 14 }, (_, i) => P.addDays(c.today(), -i));
    const from = c.dayStart(days[days.length - 1]);
    const tills = db.all("SELECT closed_at, expected_cash, counted, difference FROM pk_tills WHERE status = 'closed' AND closed_at >= ?", from);
    const moves = db.all("SELECT kind, amount, at FROM pk_safe WHERE at >= ? AND status != 'void'", from);
    const rows = days.map((d) => {
      const tt = tills.filter((x) => c.cairoDate(x.closed_at) === d);
      const mm = moves.filter((x) => c.cairoDate(x.at) === d);
      const sum = (arr, f) => r2(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));
      return { d, expected: sum(tt, (x) => x.expected_cash), counted: sum(tt, (x) => x.counted), diff: sum(tt, (x) => x.difference), drops: sum(mm.filter((x) => x.kind === 'drop'), (x) => x.amount), out: -sum(mm.filter((x) => x.kind === 'collection'), (x) => x.amount) };
    }).filter((x) => x.expected || x.counted || x.drops || x.out);
    const dayTable = ui.table([
      { label: tr('prk|Day'), render: (x) => esc(ui.date(x.d)) },
      { label: tr('prk|Cash expected'), num: true, render: (x) => c.money(x.expected) },
      { label: tr('prk|Cash counted'), num: true, render: (x) => c.money(x.counted) },
      { label: tr('prk|Difference'), num: true, render: (x) => (x.diff ? `<b class="${x.diff < 0 ? 'late' : ''}">${c.money(x.diff)}</b>` : '—') },
      { label: tr('prk|Drops'), num: true, render: (x) => (x.drops ? c.money(x.drops) : '—') },
      { label: tr('prk|To the bank'), num: true, render: (x) => (x.out ? c.money(x.out) : '—') },
    ], rows, { empty: esc(tr('prk|No cash in the last two weeks.')) });
    const list = db.all('SELECT s.*, u.name user_name, t.ref till_ref FROM pk_safe s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN pk_tills t ON t.id = s.till_id ORDER BY s.at DESC LIMIT 30');
    const table = ui.table([
      { label: tr('prk|When'), render: (x) => `${esc(ui.dt(x.at))}<small class="sub">${esc(x.ref)}</small>` },
      { label: tr('prk|What'), render: (x) => `${kindBadge(x.kind)}${x.till_ref ? ` <a href="/admin/parking/tills/${x.till_id}">${esc(x.till_ref)}</a>` : ''}${x.bag ? ` · <span class="ltr">${esc(x.bag)}</span>` : ''}` },
      { label: tr('prk|Who'), render: (x) => esc([x.user_name, x.witness, x.carrier].filter(Boolean).join(' · ') || '—') },
      { label: tr('prk|In'), num: true, render: (x) => (x.amount > 0 ? c.money(x.amount) : '') },
      { label: tr('prk|Out'), num: true, render: (x) => (x.amount < 0 ? c.money(-x.amount) : '') },
      { label: tr('Status'), render: (x) => (x.kind !== 'collection' ? '' : x.status === 'in_transit' ? ui.badge('t', tr('prk|On the way'), 'amber') : ui.badge('b', tr('prk|Banked'), 'ok')) },
    ], list, { empty: esc(tr('prk|The safe has not been used yet.')) });
    const csrf = req.session.csrf;
    const collect = canMoney(req) ? ui.card(tr('prk|Bank collection'), ui.form('/admin/parking/safe/collect', csrf, `<div class="fields">${ui.input('amount', tr('prk|Amount'), balance > 0 ? balance : '', { type: 'number', min: 1, step: '0.01', required: true })}${ui.input('bag', tr('prk|Bag or seal number'), '', { required: true, attrs: { autocomplete: 'off' } })}${ui.input('carrier', tr('prk|Collected by'), '', { placeholder: tr('prk|e.g. the bank’s cash-in-transit team') })}${ui.input('reference', tr('prk|Receipt number'), '')}</div>${ui.btn(esc(tr('prk|Hand over')), { cls: 'btn--primary btn--sm', attrs: { 'data-confirm': tr('prk|Hand this cash to the bank?') } })}`, { cls: 'stack' }), { sub: esc(tr('prk|The cash leaves the safe and is on its way to the bank until the bank confirms it.')) }) : '';
    const confirm = canMoney(req) && transit.length ? ui.card(tr('prk|Confirm what the bank counted'), transit.map((x) => ui.form(`/admin/parking/safe/${x.id}/confirm`, csrf, `<p><b>${esc(x.ref)}</b> · <span class="ltr">${esc(x.bag || '')}</span> · ${c.money(-x.amount)} · ${esc(ui.date(x.at))}</p><div class="fields">${ui.input('confirmed', tr('prk|The bank counted'), -x.amount, { type: 'number', min: 0, step: '0.01', required: true })}${ui.input('reference', tr('prk|Bank reference'), '')}</div>${ui.btn(esc(tr('prk|Confirm')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack pk-confirm' })).join('')) : '';
    const adjust = h.can(req, 'manager') ? `<details class="upload-box"><summary>${ui.icon('gear')}<span>${esc(tr('prk|Adjust the safe'))}</span></summary>${ui.form('/admin/parking/safe/adjust', csrf, `<div class="fields">${ui.input('amount', tr('prk|Amount (minus to take out)'), '', { type: 'number', step: '0.01', required: true })}${ui.input('note', tr('prk|Why'), '', { required: true, placeholder: tr('prk|e.g. Count of the safe at the start') })}</div>${ui.btn(esc(tr('Save')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    c.page(req, res, {
      title: tr('prk|Safe'), crumbs: c.crumbs([null, tr('prk|Safe')]),
      body: `${c.tabs('/admin/parking/safe')}${c.subtabs('/admin/parking/safe', SUB)}<div class="kpis kpis--4">${kpis}</div><div class="grid grid--side"><div class="stack">${ui.card(tr('prk|Day by day'), dayTable)}</div><div class="stack">${collect}${confirm}${adjust}</div></div>${ui.card(tr('prk|Movements'), table)}`,
    });
  });
  router.post('/parking/safe/collect', RMF, (req, res) => {
    const amount = r2(h.numv(req.body.amount));
    const bag = h.str(req.body.bag, 40);
    if (!(amount > 0) || !bag) return c.back(req, res, '/admin/parking/safe', 'error', tr('prk|Enter the amount and the bag number.'));
    if (amount > P.safeBalance()) return c.back(req, res, '/admin/parking/safe', 'error', tr('prk|The safe does not have that much cash.'));
    const m = db.tx(() => {
      const x = P.safe('collection', -amount, { user: req.user, bag, carrier: h.str(req.body.carrier, 80) || null, reference: h.str(req.body.reference, 60) || null, status: 'in_transit' });
      const L = ledger();
      if (L) book(`Parking cash to the bank ${x.ref} · bag ${bag}`, [{ account: 'bank_clearing', debit: amount }, { account: cashAccount(L), credit: amount }], { source: `pksafe:${x.id}#1`, user: req.user });
      return x;
    });
    h.log(req, 'Handed parking cash to the bank', 'pk_safe', m.id, `${m.ref} · ${amount} · ${bag}`);
    c.back(req, res, '/admin/parking/safe', 'ok', tr('prk|{amount} on its way to the bank.', { amount: c.money(amount) }));
  });
  router.post('/parking/safe/:id/confirm', RMF, (req, res, next) => {
    const x = db.get("SELECT * FROM pk_safe WHERE id = ? AND kind = 'collection' AND status = 'in_transit'", h.int(req.params.id));
    if (!x) return next();
    const confirmed = r2(h.numv(req.body.confirmed));
    if (!(confirmed >= 0)) return c.back(req, res, '/admin/parking/safe', 'error', tr('prk|Enter what the bank counted.'));
    const diff = r2(confirmed + x.amount); // amount is negative
    db.tx(() => {
      db.run("UPDATE pk_safe SET status = 'banked', confirmed_amount = ?, confirmed_at = ?, reference = COALESCE(?, reference) WHERE id = ?", confirmed, now(), h.str(req.body.reference, 60) || null, x.id);
      if (diff && ledger()) {
        const lines = diff < 0 ? [{ account: 'exp_other', debit: -diff, memo: 'Bank count short' }, { account: 'bank_clearing', credit: -diff }] : [{ account: 'bank_clearing', debit: diff }, { account: 'inc_other', credit: diff, memo: 'Bank count over' }];
        book(`Parking cash ${x.ref}: the bank counted ${confirmed}`, lines, { source: `pksafe-bank:${x.id}#1`, user: req.user });
      }
    });
    h.log(req, 'Confirmed a parking cash deposit', 'pk_safe', x.id, `${x.ref} · ${confirmed}`);
    c.back(req, res, '/admin/parking/safe', diff ? 'error' : 'ok', diff ? tr('prk|Banked with a difference of {amount}.', { amount: c.money(diff) }) : tr('prk|Banked. The count is right.'));
  });
  router.post('/parking/safe/adjust', c.RM, (req, res) => {
    const amount = r2(h.numv(req.body.amount));
    const note = h.str(req.body.note, 200);
    if (!amount || !note) return c.back(req, res, '/admin/parking/safe', 'error', tr('prk|Enter the amount and say why.'));
    if (amount < 0 && -amount > P.safeBalance()) return c.back(req, res, '/admin/parking/safe', 'error', tr('prk|The safe does not have that much cash.'));
    db.tx(() => {
      const x = P.safe('adjust', amount, { user: req.user, note });
      const L = ledger();
      if (L) book(`Parking safe adjusted ${x.ref}: ${note}`, amount > 0 ? [{ account: cashAccount(L), debit: amount }, { account: 'inc_other', credit: amount }] : [{ account: 'exp_other', debit: -amount }, { account: cashAccount(L), credit: -amount }], { source: `pksafe:${x.id}#1`, user: req.user });
    });
    h.log(req, 'Adjusted the parking safe', 'pk_safe', null, `${amount} · ${note}`);
    c.back(req, res, '/admin/parking/safe', 'ok', tr('Saved.'));
  });
};

module.exports.KIND = KIND;
