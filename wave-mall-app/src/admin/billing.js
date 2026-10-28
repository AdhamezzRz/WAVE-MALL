'use strict';

// The one way to bill and to take money. Rent schedules, kiosks, utilities, turnover rent,
// service-charge settlements, fit-out deposits and online payments all go through here, so
// every invoice and payment is numbered, stored and announced the same way (see events.js).

const { now, today } = require('./db');

const KINDS = ['rent', 'deposit', 'key', 'other', 'service', 'turnover', 'service_recon', 'utility', 'specialty', 'fitout', 'penalty', 'parking'];

// Deposits are held, not sold: no VAT on them.
const NO_VAT = ['deposit', 'fitout'];

function billing(db, events) {
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  // VAT: an invoice's total is what the tenant pays. When VAT is on (Settings, vat_pct) the
  // invoice stores its VAT share in `vat` and the total includes it, so "outstanding = total − paid"
  // holds everywhere. Invoices created while VAT was 0 keep vat = 0.
  if (db.ensure) db.ensure('billing-vat-1', 'ALTER TABLE invoices ADD COLUMN vat REAL NOT NULL DEFAULT 0;');

  // Create an invoice. Needs a lease, a brand or a customer name. Returns the stored row.
  // v.vat_pct overrides the setting (0 for none). v.vat_included: the amount given already includes
  // VAT (prices for the public, like parking), so the total stays exactly that amount.
  function createInvoice(v, { user = null, emit = true } = {}) {
    const lease = v.lease_id ? db.get('SELECT id, brand_id FROM leases WHERE id = ?', v.lease_id) : null;
    const brandId = v.brand_id || (lease ? lease.brand_id : null);
    if (!lease && !brandId && !v.customer) throw new Error('An invoice needs a lease, a brand or a customer.');
    const kind = KINDS.includes(v.kind) ? v.kind : 'other';
    const rent = r2(v.rent);
    const service = r2(v.service);
    const other = r2(v.other);
    const net = r2(v.total ?? rent + service + other);
    if (!(net > 0)) throw new Error('An invoice needs an amount above zero.');
    const pct = NO_VAT.includes(kind) ? 0 : Math.max(0, Number(v.vat_pct ?? db.setting('vat_pct')) || 0);
    const vat = v.vat_included ? r2(net - net / (1 + pct / 100)) : r2((net * pct) / 100);
    const total = v.vat_included ? net : r2(net + vat);
    const id = Number(db.run(
      `INSERT INTO invoices (ref, lease_id, brand_id, customer, kind, period_start, period_end, due_date, rent, service, other, total, vat, note, source, source_id, demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      db.nextRef('invoices', 'IN', 4, true), lease ? lease.id : null, brandId, v.customer || null, kind, v.period_start || null, v.period_end || null,
      v.due_date || today(), rent, service, other, total, vat, v.note || null, v.source || null, v.source_id ?? null, v.demo ? 1 : 0, now(),
    ).lastInsertRowid);
    const invoice = db.get('SELECT * FROM invoices WHERE id = ?', id);
    if (emit) events.emit('invoice.created', { invoice, user });
    return invoice;
  }

  // Record money received against an invoice (full or part). Returns { payment, invoice }.
  function recordPayment({ invoice_id, amount, date, method, reference, provider, provider_ref, note, demo }, { user = null } = {}) {
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', invoice_id);
    if (!inv) throw new Error('That invoice no longer exists.');
    if (!['open', 'partial'].includes(inv.status)) throw new Error('This invoice is not open for payment.');
    const amt = r2(Math.min(Number(amount), inv.total - inv.paid));
    if (!(amt > 0)) throw new Error('Enter the amount received.');
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : today();
    const paid = r2(inv.paid + amt);
    const done = paid >= inv.total - 0.5;
    const out = db.tx(() => {
      const pid = Number(db.run(
        `INSERT INTO payments (ref, invoice_id, brand_id, amount, date, method, reference, provider, provider_ref, note, user_id, demo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('payments', 'RC', 5, true), inv.id, inv.brand_id, amt, d, method || null, reference || null, provider || null, provider_ref || null,
        note || null, user ? user.id : null, demo ? 1 : 0, now(),
      ).lastInsertRowid);
      db.run('UPDATE invoices SET paid = ?, status = ?, paid_at = ?, method = ? WHERE id = ?', paid, done ? 'paid' : 'partial', d, method || inv.method, inv.id);
      return { payment: db.get('SELECT * FROM payments WHERE id = ?', pid), invoice: db.get('SELECT * FROM invoices WHERE id = ?', inv.id) };
    });
    events.emit('payment.received', { ...out, user });
    return out;
  }

  // Undo a payment (bounced cheque, refund). The invoice goes back to open or part paid.
  function reversePayment(paymentId, { user = null, note = null } = {}) {
    const p = db.get('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p || p.status !== 'received') throw new Error('That payment cannot be reversed.');
    const out = db.tx(() => {
      db.run("UPDATE payments SET status = 'reversed', note = COALESCE(?, note) WHERE id = ?", note, p.id);
      const inv = p.invoice_id ? db.get('SELECT * FROM invoices WHERE id = ?', p.invoice_id) : null;
      if (inv) {
        const paid = r2(Math.max(0, inv.paid - p.amount));
        const last = db.get("SELECT date FROM payments WHERE invoice_id = ? AND status = 'received' ORDER BY date DESC LIMIT 1", inv.id);
        db.run('UPDATE invoices SET paid = ?, status = ?, paid_at = ? WHERE id = ?', paid, paid > 0 ? 'partial' : 'open', last ? last.date : null, inv.id);
      }
      return { payment: db.get('SELECT * FROM payments WHERE id = ?', p.id), invoice: inv ? db.get('SELECT * FROM invoices WHERE id = ?', inv.id) : null };
    });
    events.emit('payment.reversed', { ...out, user });
    return out;
  }

  // Void an open invoice (nothing paid on it).
  function voidInvoice(id, { user = null, note = null } = {}) {
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', id);
    if (!inv || inv.status !== 'open' || inv.paid > 0) return null;
    db.run("UPDATE invoices SET status = 'void', note = COALESCE(?, note) WHERE id = ?", note, inv.id);
    const invoice = db.get('SELECT * FROM invoices WHERE id = ?', inv.id);
    events.emit('invoice.voided', { invoice, user });
    return invoice;
  }

  // Who an invoice is for, for display: the brand, else the customer name.
  const party = (inv) => (inv.brand_id ? db.value('SELECT name FROM brands WHERE id = ?', inv.brand_id) : null) || inv.customer || '';

  return { KINDS, createInvoice, recordPayment, reversePayment, voidInvoice, party };
}

module.exports = { billing, KINDS };
