'use strict';

// ETA e-receipts for parking (/admin/parking/ereceipts).
//
// Visitors' parking is a retail sale, so instead of an e-invoice each payment becomes an Egyptian
// Tax Authority e-receipt (the B2C system for points of sale): built here the moment the money is
// taken, chained to the receipt before it (previousUUID), its UUID the SHA-256 of the receipt's
// canonical string, and sent in batches to the ETA by a background job. A refund issues a return
// receipt pointing at the original. The printed parking receipt carries the ETA QR code.
//
// Set-up: the issuer details from the ETA settings (tax number, name, branch, address), and here the
// POS serial number registered with the ETA, its OS version, and the item code for parking.
// Credentials of the registered POS go on the server: ETA_RECEIPT_CLIENT_ID, ETA_RECEIPT_CLIENT_SECRET
// (and ETA_RECEIPT_PRESHARED_KEY when the ETA issued one). Without them receipts are prepared and
// kept, ready to send.

const crypto = require('node:crypto');
const { t: tr } = require('../i18n');
const eta = require('../eta');
const qr = require('../qr');

const STATUS = {
  prepared: ['prk|Ready to send', 'amber'], invalid_local: ['prk|Needs set-up', 'rose'], submitted: ['prk|Sent', 'sky'],
  valid: ['prk|Accepted', 'ok'], invalid: ['prk|Refused', 'rose'], error: ['prk|Not sent', 'rose'],
};
const PAY = { cash: 'C', card: 'V', online: 'V', wallet: 'O', instapay: 'O' };

module.exports = function ereceiptRoutes(router, h, c) {
  const { db, ui } = h;
  const { P, esc } = c;
  const env = h.env || process.env;
  const now = () => new Date().toISOString();
  const r5 = (n) => Math.round(Number(n || 0) * 100000) / 100000;
  // the sample data builds its receipts for a pretend issuer, leaving the real set-up alone
  let override = null;
  const S = (k, d = '') => (override && override[k] !== undefined ? override[k] : db.setting(k) ?? d);
  const on = () => S('prk_eta_receipts', '0') === '1';
  const creds = () => !!(env.ETA_RECEIPT_CLIENT_ID && env.ETA_RECEIPT_CLIENT_SECRET);
  const urls = () => eta.ENVS[S('eta_env', 'preprod') === 'prod' ? 'prod' : 'preprod'];
  const fetchImpl = () => (h.payments && h.payments.fetchImpl) || globalThis.fetch;
  const SUB = [['/admin/parking/tills', 'prk|Tills'], ['/admin/parking/safe', 'prk|Safe'], ['/admin/parking/ereceipts', 'prk|E-receipts']];
  const badge = (s) => ui.badge(s, tr((STATUS[s] || [s])[0]), (STATUS[s] || [])[1]);

  // ---------- building ----------
  // What is missing before the ETA will take a receipt.
  function missing() {
    const out = [];
    if (!/^\d{9}$/.test(String(S('eta_rin')).replace(/\D/g, ''))) out.push('prk|The company’s tax registration number (ETA settings)');
    if (!S('eta_name')) out.push('prk|The company’s registered name (ETA settings)');
    if (!S('prk_eta_pos_serial')) out.push('prk|The serial number of the POS registered with the ETA');
    if (!S('prk_eta_item_code')) out.push('prk|The item code for parking');
    return out;
  }
  function build(p, { kind, number, previous, reference, issuedAt }) {
    const vatPct = Number(S('vat_pct', 0)) || 0;
    const total = r5(p.amount);
    const net = vatPct ? r5(total / (1 + vatPct / 100)) : total;
    const vat = r5(total - net);
    const s = P.sessionBy(p.session_id) || {};
    const doc = {
      header: {
        dateTimeIssued: eta.isoUtc(issuedAt), receiptNumber: number, uuid: '', previousUUID: previous || '', referenceOldUUID: '',
        currency: 'EGP', exchangeRate: 0, sOrderNameCode: '', orderdeliveryMode: '', grossWeight: 0, netWeight: 0,
      },
      documentType: { receiptType: kind === 'r' ? 'R' : 'S', typeVersion: '1.2' },
      seller: {
        rin: String(S('eta_rin')).replace(/\D/g, ''), companyTradeName: S('eta_name'), branchCode: S('eta_branch', '0') || '0',
        branchAddress: { country: 'EG', governate: S('eta_governate', 'Cairo'), regionCity: S('eta_city', 'New Cairo'), street: S('eta_street', ''), buildingNumber: S('eta_building', '0') || '0' },
        deviceSerialNumber: S('prk_eta_pos_serial'), syndicateLicenseNumber: '', activityCode: S('prk_eta_activity') || S('eta_activity', '5221'),
      },
      buyer: { type: 'P', id: '', name: '', mobileNumber: '', paymentNumber: '' },
      itemData: [{
        internalCode: s.code ? P.codeShow(s.code) : p.ref, description: s.plate ? `Parking ${s.plate}` : 'Parking',
        itemType: String(S('prk_eta_item_code')).startsWith('EG-') ? 'EGS' : 'GS1', itemCode: S('prk_eta_item_code'), unitType: 'EA', quantity: 1,
        unitPrice: net, netSale: net, totalSale: net, total, commercialDiscountData: [], itemDiscountData: [], valueDifference: 0,
        taxableItems: vat ? [{ taxType: 'T1', amount: vat, subType: 'V009', rate: vatPct }] : [],
      }],
      totalSales: net, totalCommercialDiscount: 0, totalItemsDiscount: 0, extraReceiptDiscountData: [], netAmount: net, feesAmount: 0, totalAmount: total,
      taxTotals: vat ? [{ taxType: 'T1', amount: vat }] : [], paymentMethod: PAY[p.method] || 'O', adjustment: 0,
    };
    if (kind === 'r') doc.header.referenceUUID = reference || '';
    // the receipt's UUID: SHA-256 of its canonical string, written with the UUID left empty
    doc.header.uuid = crypto.createHash('sha256').update(eta.serialize(doc), 'utf8').digest('hex');
    return doc;
  }
  const lastUuid = () => (db.get("SELECT uuid FROM pk_ereceipts WHERE uuid IS NOT NULL AND status != 'invalid_local' ORDER BY id DESC LIMIT 1") || {}).uuid || '';
  const nextNumber = () => {
    const head = `PR-${new Date().getFullYear()}-`;
    const last = db.get('SELECT number FROM pk_ereceipts WHERE number LIKE ? ORDER BY id DESC LIMIT 1', `${head}%`);
    return head + String(last ? Number(last.number.slice(head.length)) + 1 : 1).padStart(7, '0');
  };
  function prepare(p, kind = 's', { issuedAt = now() } = {}) {
    if (!p || !(p.amount > 0)) return null;
    const cur = db.get('SELECT * FROM pk_ereceipts WHERE payment_id = ? AND kind = ?', p.id, kind);
    if (cur) return cur;
    const original = kind === 'r' ? db.get("SELECT uuid FROM pk_ereceipts WHERE payment_id = ? AND kind = 's'", p.id) : null;
    if (kind === 'r' && !(original && original.uuid)) return null;
    const errs = missing();
    const number = nextNumber();
    if (errs.length) {
      db.run("INSERT INTO pk_ereceipts (payment_id, kind, number, status, errors, issued_at, demo) VALUES (?, ?, ?, 'invalid_local', ?, ?, ?)", p.id, kind, number, JSON.stringify(errs), issuedAt, p.demo ? 1 : 0);
    } else {
      const previous = lastUuid();
      const doc = build(p, { kind, number, previous, reference: original && original.uuid, issuedAt });
      db.run("INSERT INTO pk_ereceipts (payment_id, kind, number, uuid, previous_uuid, reference_uuid, document, status, errors, issued_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', '[]', ?, ?)",
        p.id, kind, number, doc.header.uuid, previous || null, original ? original.uuid : null, JSON.stringify(doc), issuedAt, p.demo ? 1 : 0);
    }
    return db.get('SELECT * FROM pk_ereceipts WHERE payment_id = ? AND kind = ?', p.id, kind);
  }
  // Once the set-up is complete: build the receipts that were waiting for it, in order, on the chain.
  function rebuild() {
    if (missing().length) return 0;
    let n = 0;
    db.tx(() => {
      for (const r of db.all("SELECT * FROM pk_ereceipts WHERE status IN ('invalid_local', 'prepared') ORDER BY id")) {
        const p = db.get('SELECT * FROM pk_payments WHERE id = ?', r.payment_id);
        if (!p) continue;
        const original = r.kind === 'r' ? db.get("SELECT uuid FROM pk_ereceipts WHERE payment_id = ? AND kind = 's'", p.id) : null;
        const previous = (db.get("SELECT uuid FROM pk_ereceipts WHERE id < ? AND uuid IS NOT NULL ORDER BY id DESC LIMIT 1", r.id) || {}).uuid || '';
        const doc = build(p, { kind: r.kind, number: r.number, previous, reference: original && original.uuid, issuedAt: r.issued_at });
        db.run("UPDATE pk_ereceipts SET uuid = ?, previous_uuid = ?, reference_uuid = ?, document = ?, status = 'prepared', errors = '[]' WHERE id = ?", doc.header.uuid, previous || null, original ? original.uuid : null, JSON.stringify(doc), r.id);
        n++;
      }
    });
    return n;
  }

  h.events.on('parking.paid', ({ payment }) => {
    if (!on() || !payment) return;
    try {
      prepare(payment, 's', { issuedAt: payment.at });
    } catch (e) {
      console.error('[parking] e-receipt not prepared:', e.message);
    }
  });
  h.events.on('parking.refunded', ({ payment }) => {
    if (!on() || !payment) return;
    try {
      prepare(payment, 'r');
    } catch (e) {
      console.error('[parking] return receipt not prepared:', e.message);
    }
  });

  // ---------- sending ----------
  let cached = null;
  async function token() {
    if (cached && cached.until > Date.now() + 30000) return cached.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env.ETA_RECEIPT_CLIENT_ID, client_secret: env.ETA_RECEIPT_CLIENT_SECRET });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', posserial: S('prk_eta_pos_serial'), pososversion: S('prk_eta_pos_os', 'linux'), posmodelframework: 'wave-parking', presharedkey: env.ETA_RECEIPT_PRESHARED_KEY || '' };
    const r = await fetchImpl()(`${urls().id}/connect/token`, { method: 'POST', headers, body: body.toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`ETA sign-in failed (${r.status})${j.error_description ? `: ${j.error_description}` : ''}`);
    cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return cached.token;
  }
  let busy = false;
  async function send({ limit = 200 } = {}) {
    if (!creds()) throw new Error('prk|Set ETA_RECEIPT_CLIENT_ID and ETA_RECEIPT_CLIENT_SECRET on the server to send receipts.');
    if (busy) return { sent: 0, refused: 0 };
    busy = true;
    let sent = 0;
    let refused = 0;
    try {
      const rows = db.all("SELECT * FROM pk_ereceipts WHERE status IN ('prepared', 'error') AND demo = 0 ORDER BY id LIMIT ?", limit);
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        let out;
        try {
          const r = await fetchImpl()(`${urls().api}/api/v1/receiptsubmissions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify({ receipts: batch.map((x) => JSON.parse(x.document)) }) });
          out = await r.json().catch(() => ({}));
          if (!r.ok && r.status !== 202) throw new Error(`ETA submission failed (${r.status})${out.error && out.error.message ? `: ${out.error.message}` : ''}`);
        } catch (e) {
          for (const x of batch) db.run("UPDATE pk_ereceipts SET status = 'error', errors = ? WHERE id = ?", JSON.stringify([e.message]), x.id);
          throw e;
        }
        const t = now();
        const sub = out.submissionId || out.submissionUUID || null;
        for (const a of out.acceptedDocuments || []) {
          const x = batch.find((y) => y.uuid === a.uuid || y.number === a.receiptNumber);
          if (!x) continue;
          db.run("UPDATE pk_ereceipts SET status = 'submitted', submission_uuid = ?, errors = '[]', submitted_at = ? WHERE id = ?", sub, t, x.id);
          sent++;
        }
        for (const a of out.rejectedDocuments || []) {
          const x = batch.find((y) => y.uuid === a.uuid || y.number === a.receiptNumber);
          if (!x) continue;
          const errs = [a.error && a.error.message, ...((a.error && a.error.details) || []).map((d) => `${d.propertyPath || d.target || ''}: ${d.message}`)].filter(Boolean);
          db.run("UPDATE pk_ereceipts SET status = 'invalid', errors = ?, submitted_at = ? WHERE id = ?", JSON.stringify(errs), t, x.id);
          refused++;
        }
      }
      // the ETA's verdict on what was sent
      for (const sub of db.all("SELECT DISTINCT submission_uuid s FROM pk_ereceipts WHERE status = 'submitted' AND submission_uuid IS NOT NULL LIMIT 10").map((x) => x.s)) {
        const r = await fetchImpl()(`${urls().api}/api/v1/receiptsubmissions/${encodeURIComponent(sub)}/details?PageNo=1&PageSize=100`, { headers: { authorization: `Bearer ${await token()}` } });
        if (!r.ok) continue;
        const j = await r.json().catch(() => ({}));
        for (const x of j.receipts || []) {
          const st = String(x.status || '').toLowerCase();
          if (st === 'valid' || st === 'invalid') db.run('UPDATE pk_ereceipts SET status = ?, errors = ?, checked_at = ? WHERE uuid = ?', st, JSON.stringify((x.errors || []).map((e) => e.message || String(e))), now(), x.uuid);
        }
      }
    } finally {
      busy = false;
    }
    return { sent, refused };
  }
  h.every('parking-ereceipts', 5 * 60 * 1000, async () => {
    if (on() && creds()) await send().catch((e) => console.error('[parking] e-receipts:', e.message));
  });

  // the ETA's QR for a receipt: its public page, the total and the issuer
  function qrUrl(r) {
    if (!r || !r.uuid) return null;
    const doc = JSON.parse(r.document || '{}');
    const portal = urls().portal;
    return `${portal}/receipts/search/${r.uuid}/share/${doc.header ? doc.header.dateTimeIssued : ''}#Total:${doc.totalAmount ?? ''},IssuerRIN:${doc.seller ? doc.seller.rin : ''}`;
  }
  const SAMPLE = { eta_rin: '100200300', eta_name: 'The Wave (sample)', eta_branch: '0', prk_eta_pos_serial: 'WAVE-PK-01', prk_eta_item_code: 'EG-100200300-PARK', prk_eta_activity: '5221' };
  function sample(p, status = 'valid') {
    if (db.get("SELECT id FROM pk_ereceipts WHERE payment_id = ? AND kind = 's'", p.id)) return null;
    override = SAMPLE;
    try {
      const previous = lastUuid();
      const number = nextNumber();
      const doc = build(p, { kind: 's', number, previous, issuedAt: p.at });
      db.run("INSERT INTO pk_ereceipts (payment_id, kind, number, uuid, previous_uuid, document, status, errors, issued_at, submitted_at, checked_at, demo) VALUES (?, 's', ?, ?, ?, ?, ?, '[]', ?, ?, ?, 1)",
        p.id, number, doc.header.uuid, previous || null, JSON.stringify(doc), status, p.at, status === 'prepared' ? null : p.at, status === 'valid' ? p.at : null);
    } finally {
      override = null;
    }
    return true;
  }
  h.parking.ereceipt = {
    sample, prepare, rebuild, send, missing, qrUrl, of: (paymentId) => db.get("SELECT * FROM pk_ereceipts WHERE payment_id = ? AND kind = 's'", paymentId), qrSvg: (r) => (qrUrl(r) ? qr.svg(qrUrl(r), { ecl: 'M', label: tr('prk|ETA e-receipt'), cls: 'pk-ticket__qr pk-ticket__qr--eta' }) : '') };

  // ---------- the page ----------
  router.get('/parking/ereceipts', (req, res) => {
    const st = STATUS[req.query.status] ? req.query.status : '';
    const rows = db.all(`SELECT r.*, p.ref pay_ref, p.amount, p.method FROM pk_ereceipts r JOIN pk_payments p ON p.id = r.payment_id ${st ? 'WHERE r.status = ?' : ''} ORDER BY r.id DESC LIMIT 50`, ...(st ? [st] : []));
    const count = (s) => db.value('SELECT COUNT(*) FROM pk_ereceipts WHERE status = ?', s);
    const dayFrom = c.dayStart(c.today());
    const kpis = [
      ui.kpi({ label: tr('prk|Receipts today'), value: ui.n0(db.value('SELECT COUNT(*) FROM pk_ereceipts WHERE issued_at >= ?', dayFrom)) }),
      ui.kpi({ label: tr('prk|Waiting to be sent'), value: ui.n0(count('prepared') + count('error')), tone: count('error') ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('prk|Accepted by the ETA'), value: ui.n0(count('valid')) }),
      ui.kpi({ label: tr('prk|Need attention'), value: ui.n0(count('invalid') + count('invalid_local')), tone: count('invalid') + count('invalid_local') ? 'kpi--alert' : '' }),
    ].join('');
    const miss = missing();
    const state = !on()
      ? `<p class="alert alert--warn">${esc(tr('prk|E-receipts are off. Turn them on below once the POS is registered with the ETA.'))}</p>`
      : miss.length ? `<div class="alert alert--warn"><b>${esc(tr('prk|Receipts are kept until the set-up is complete:'))}</b><ul>${miss.map((m) => `<li>${esc(tr(m))}</li>`).join('')}</ul></div>`
        : !creds() ? `<p class="alert alert--warn">${esc(tr('prk|Receipts are prepared and kept. Set ETA_RECEIPT_CLIENT_ID and ETA_RECEIPT_CLIENT_SECRET on the server to send them.'))}</p>`
          : `<p class="alert alert--ok">${esc(tr('prk|Receipts go to the ETA every five minutes ({env}).', { env: S('eta_env', 'preprod') === 'prod' ? tr('prk|production') : tr('prk|pre-production') }))}</p>`;
    const csrf = req.session.csrf;
    const can = h.can(req, 'manager') || h.canFinance(req);
    const actions = can ? `<div class="row-actions">${creds() && on() ? ui.form('/admin/parking/ereceipts/send', csrf, ui.btn(esc(tr('prk|Send now')), { cls: 'btn--primary btn--sm', ic: 'send' })) : ''}${on() && !miss.length ? ui.form('/admin/parking/ereceipts/rebuild', csrf, ui.btn(esc(tr('prk|Prepare the waiting receipts again')), { cls: 'btn--ghost btn--sm' })) : ''}</div>` : '';
    const filters = c.subtabs(`/admin/parking/ereceipts${st ? `?status=${st}` : ''}`, [['/admin/parking/ereceipts', tr('All')], ...Object.keys(STATUS).map((k) => [`/admin/parking/ereceipts?status=${k}`, STATUS[k][0]])]);
    const table = ui.table([
      { label: tr('prk|Receipt'), render: (r) => `<b class="ltr">${esc(r.number)}</b>${r.kind === 'r' ? ` ${ui.badge('ret', tr('prk|Return'), 'cocoa')}` : ''}<small class="sub">${esc(ui.dt(r.issued_at))}</small>` },
      { label: tr('prk|Payment'), render: (r) => `<a href="/admin/parking/payments/${r.payment_id}/receipt" target="_blank">${esc(r.pay_ref)}</a>` },
      { label: tr('prk|Amount'), num: true, render: (r) => `${r.kind === 'r' ? '−' : ''}${c.money(r.amount)}` },
      { label: tr('prk|UUID'), render: (r) => (r.uuid ? `<code class="ltr small" title="${esc(r.uuid)}">${esc(r.uuid.slice(0, 12))}…</code>` : '—') },
      { label: tr('Status'), render: (r) => `${badge(r.status)}${(() => { const e = JSON.parse(r.errors || '[]'); return e.length ? `<small class="sub">${esc(e.map((x) => (String(x).startsWith('prk|') ? tr(x) : x)).join(' · ').slice(0, 200))}</small>` : ''; })()}` },
    ], rows, { empty: esc(tr('prk|No e-receipts yet.')) });
    const settings = h.can(req, 'manager') ? ui.card(tr('prk|E-receipt set-up'), ui.form('/admin/parking/ereceipts/settings', csrf, `<div class="fields">
      ${ui.select('prk_eta_receipts', tr('prk|E-receipts'), [['0', tr('prk|Off')], ['1', tr('prk|On: a receipt for every payment')]], S('prk_eta_receipts', '0'))}
      ${ui.input('prk_eta_pos_serial', tr('prk|POS serial number'), S('prk_eta_pos_serial'), { cls: 'ltr' })}
      ${ui.input('prk_eta_pos_os', tr('prk|POS operating system version'), S('prk_eta_pos_os', 'linux'), { cls: 'ltr' })}
      ${ui.input('prk_eta_item_code', tr('prk|Item code for parking (EGS or GS1)'), S('prk_eta_item_code'), { cls: 'ltr', placeholder: 'EG-123456789-1001' })}
      ${ui.input('prk_eta_activity', tr('prk|Activity code'), S('prk_eta_activity') || S('eta_activity', '5221'), { cls: 'ltr' })}
    </div>${ui.btn(esc(tr('Save')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' }), { sub: esc(tr('prk|The issuer (tax number, name, address) comes from the ETA settings under Payments. Check the receipt layout in pre-production before going live.')) }) : '';
    c.page(req, res, {
      title: tr('prk|E-receipts'), crumbs: c.crumbs(['/admin/parking/tills', tr('prk|Cash')], [null, tr('prk|E-receipts')]),
      body: `${c.tabs('/admin/parking/ereceipts')}${c.subtabs('/admin/parking/ereceipts', SUB)}${state}<div class="kpis kpis--4">${kpis}</div>${filters}${ui.card(tr('prk|Receipts'), table, { sub: esc(`${tr('prk|Each parking payment, sent to the Egyptian Tax Authority as an e-receipt. A refund sends a return receipt.')} ${tr('prk|The latest 50 are shown.')}`) })}${actions}${settings}`,
    });
  });
  const RMF = (req, res, next) => (h.can(req, 'manager') || h.canFinance(req) ? next() : h.auth.denied(req, res));
  router.post('/parking/ereceipts/settings', c.RM, (req, res) => {
    db.setSetting('prk_eta_receipts', req.body.prk_eta_receipts === '1' ? '1' : '0');
    db.setSetting('prk_eta_pos_serial', h.str(req.body.prk_eta_pos_serial, 60));
    db.setSetting('prk_eta_pos_os', h.str(req.body.prk_eta_pos_os, 40) || 'linux');
    db.setSetting('prk_eta_item_code', h.str(req.body.prk_eta_item_code, 60));
    db.setSetting('prk_eta_activity', h.str(req.body.prk_eta_activity, 10).replace(/\D/g, ''));
    h.log(req, 'Changed the parking e-receipt set-up', 'setting', null, '');
    const n = rebuild();
    c.back(req, res, '/admin/parking/ereceipts', 'ok', n ? tr('prk|Saved. {n} waiting receipts prepared.', { n }) : tr('Saved.'));
  });
  router.post('/parking/ereceipts/rebuild', RMF, (req, res) => {
    const n = rebuild();
    h.log(req, 'Prepared parking e-receipts again', 'pk_ereceipt', null, String(n));
    c.back(req, res, '/admin/parking/ereceipts', 'ok', tr('prk|{n} receipts prepared.', { n }));
  });
  router.post('/parking/ereceipts/send', RMF, async (req, res) => {
    try {
      const r = await send();
      h.log(req, 'Sent parking e-receipts', 'pk_ereceipt', null, `${r.sent} / ${r.refused}`);
      c.back(req, res, '/admin/parking/ereceipts', r.refused ? 'error' : 'ok', tr('prk|{sent} sent, {refused} refused.', r));
    } catch (e) {
      c.back(req, res, '/admin/parking/ereceipts', 'error', String(e.message).startsWith('prk|') ? tr(e.message) : e.message);
    }
  });
};
