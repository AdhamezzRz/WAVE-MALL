'use strict';

// Egyptian Tax Authority (ETA) e-invoicing.
//
// From an office invoice this builds the ETA v1.0 document (issuer, receiver, one line per
// rent / service / other amount, taxable items and totals), checks it, and produces the
// canonical string the ETA signs. The legally binding signature is a CAdES-BES signature from the
// company's USB token or HSM, which a web server cannot hold: set ETA_SIGNER_URL to a small signing
// service on a machine with the token (it receives the canonical string and returns the signature).
// Without it, documents are prepared and checked here ("ready to sign") and never submitted.
//
// Submission uses OAuth2 client credentials (ETA_CLIENT_ID, ETA_CLIENT_SECRET) against the
// pre-production or production system chosen in the ETA settings.

const crypto = require('node:crypto');

const ENVS = {
  preprod: { id: 'https://id.preprod.eta.gov.eg', api: 'https://api.preprod.invoicing.eta.gov.eg', portal: 'https://preprod.invoicing.eta.gov.eg' },
  prod: { id: 'https://id.eta.gov.eg', api: 'https://api.invoicing.eta.gov.eg', portal: 'https://invoicing.eta.gov.eg' },
};

// The settings the ETA needs from the issuer (stored in the office settings table).
const SETTING_KEYS = [
  'eta_env', 'eta_rin', 'eta_name', 'eta_branch', 'eta_activity', 'eta_governate', 'eta_city', 'eta_street', 'eta_building',
  'eta_item_rent', 'eta_item_service', 'eta_item_other', 'eta_vat_rate',
];
const DEFAULTS = {
  eta_env: 'preprod', eta_rin: '', eta_name: '', eta_branch: '0', eta_activity: '6810', eta_governate: 'Cairo', eta_city: 'New Cairo',
  eta_street: 'North 90 Street', eta_building: '0', eta_item_rent: '', eta_item_service: '', eta_item_other: '', eta_vat_rate: '',
};

// ETA amounts: up to 5 decimals; the office bills in piastres, so 2 is exact.
const r5 = (n) => Math.round(Number(n || 0) * 100000) / 100000;
const digits = (s) => String(s || '').replace(/\D/g, '');

// The ETA canonical serialization (the signed string): every property name in upper case and
// quotes, followed by its value; an array repeats its property name before each element; plain
// values are quoted as written. The signatures property is left out.
function serialize(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value !== 'object') return `"${String(value)}"`;
  let out = '';
  for (const [name, v] of Object.entries(value)) {
    if (name === 'signatures') continue;
    const key = `"${name.toUpperCase()}"`;
    if (Array.isArray(v)) {
      out += key;
      for (const el of v) out += key + serialize(el);
    } else {
      out += key + serialize(v);
    }
  }
  return out;
}
const canonicalHash = (doc) => crypto.createHash('sha256').update(serialize(doc), 'utf8').digest('hex');

// ISO date-time the way the ETA wants it (UTC, no milliseconds).
const isoUtc = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Build the document. inv: the invoice row; brand: the brand row (legal data from the tenant file);
// s: settings; opts.issuedAt to fix the date (tests). Lines are rent, service and other amounts.
function buildDocument(inv, brand, s, { issuedAt = null, labels = {} } = {}) {
  const set = { ...DEFAULTS, ...Object.fromEntries(Object.entries(s || {}).filter(([k, v]) => SETTING_KEYS.includes(k) && v !== '' && v !== null && v !== undefined)) };
  // the VAT the invoice was issued with (billing.js stores it), so the e-invoice matches what the tenant
  // was billed; eta_vat_rate only applies to invoices that carry no VAT of their own
  const vatAmt = Number(inv.vat) || 0;
  const net = r5(Number(inv.total || 0) - vatAmt);
  const rate = vatAmt > 0 && net > 0
    ? Math.round((vatAmt / net) * 10000) / 100
    : r5(Number(set.eta_vat_rate) || 0);
  const rin = digits(set.eta_rin);
  let parts = [
    ['rent', inv.rent, labels.rent || 'Rent', set.eta_item_rent],
    ['service', inv.service, labels.service || 'Service charge', set.eta_item_service],
    ['other', inv.other, labels.other || 'Other charges', set.eta_item_other],
  ].filter(([, amount]) => Number(amount) > 0);
  // an invoice billed as one total (no breakdown, or a breakdown that does not add up) becomes a single line
  const sumParts = r5(parts.reduce((a, p) => a + Number(p[1]), 0));
  if ((!parts.length || Math.abs(sumParts - (vatAmt ? net : Number(inv.total))) > 0.01) && Number(inv.total) > 0) {
    parts = [['other', vatAmt ? net : inv.total, labels.other || 'Other charges', set.eta_item_other]];
  }
  const invoiceLines = parts.map(([code, amount, description, itemCode]) => {
    const unit = r5(amount);
    const salesTotal = r5(unit * 1);
    const netTotal = salesTotal;
    const tax = r5(netTotal * rate / 100);
    return {
      description,
      itemType: 'EGS',
      itemCode: itemCode ? (itemCode.startsWith('EG-') ? itemCode : `EG-${rin}-${itemCode}`) : '',
      unitType: 'EA',
      quantity: 1,
      internalCode: code.toUpperCase(),
      salesTotal,
      total: r5(netTotal + tax),
      valueDifference: 0,
      totalTaxableFees: 0,
      netTotal,
      itemsDiscount: 0,
      unitValue: { currencySold: 'EGP', amountEGP: unit },
      discount: { rate: 0, amount: 0 },
      taxableItems: [{ taxType: 'T1', amount: tax, subType: rate > 0 ? 'V009' : 'V003', rate }],
    };
  });
  const sum = (k) => r5(invoiceLines.reduce((a, l) => a + l[k], 0));
  const taxTotal = r5(invoiceLines.reduce((a, l) => a + l.taxableItems[0].amount, 0));
  const taxId = digits(brand && brand.tax_id);
  const today = new Date().toISOString().slice(0, 10);
  const issueDay = issuedAt ? null : (inv.due_date && inv.due_date <= today ? inv.due_date : today);
  return {
    issuer: {
      address: { branchID: String(set.eta_branch || '0'), country: 'EG', governate: set.eta_governate, regionCity: set.eta_city, street: set.eta_street, buildingNumber: String(set.eta_building || '0') },
      type: 'B',
      id: rin,
      name: set.eta_name || (s && s.legal_name) || '',
    },
    receiver: {
      address: { country: 'EG', governate: set.eta_governate, regionCity: set.eta_city, street: (brand && brand.legal_address) || set.eta_street, buildingNumber: '0' },
      type: taxId ? 'B' : 'P',
      id: taxId,
      name: (brand && (brand.legal_name || brand.name)) || inv.customer || '',
    },
    documentType: 'I',
    documentTypeVersion: '1.0',
    dateTimeIssued: issuedAt || isoUtc(`${issueDay}T08:00:00Z`),
    taxpayerActivityCode: String(set.eta_activity || ''),
    internalID: inv.ref,
    purchaseOrderReference: '',
    purchaseOrderDescription: '',
    salesOrderReference: '',
    salesOrderDescription: '',
    proformaInvoiceNumber: '',
    invoiceLines,
    totalDiscountAmount: 0,
    totalSalesAmount: sum('salesTotal'),
    netAmount: sum('netTotal'),
    taxTotals: [{ taxType: 'T1', amount: taxTotal }],
    totalAmount: r5(sum('netTotal') + taxTotal),
    extraDiscountAmount: 0,
    totalItemsDiscountAmount: 0,
  };
}

// What is wrong with a document before it can be signed; [] when it is ready.
// Messages are English keys the caller translates.
function validate(doc) {
  const e = [];
  if (!/^\d{9}$/.test(doc.issuer.id)) e.push('The mall’s tax registration number (RIN) must be 9 digits.');
  if (!doc.issuer.name) e.push('Set the issuer name in the ETA settings.');
  if (!/^\d{4}$/.test(doc.taxpayerActivityCode)) e.push('The activity code must be 4 digits.');
  if (doc.receiver.type === 'B' && !/^\d{9}$/.test(doc.receiver.id)) e.push('The tenant’s tax ID must be 9 digits.');
  if (doc.receiver.type === 'P' && doc.totalAmount >= 50000) e.push('A receiver without a tax ID is only allowed under EGP 50,000: add the tenant’s tax ID in the tenant file.');
  if (!doc.receiver.name) e.push('The receiver has no name.');
  if (!doc.invoiceLines.length || !(doc.totalAmount > 0)) e.push('The invoice has no amount.');
  if (doc.invoiceLines.some((l) => !l.itemCode)) e.push('Set the item codes (EGS) for rent, service and other charges in the ETA settings.');
  return e;
}

// OAuth2 token, submission and status. fetchImpl injectable for tests.
function api({ env = 'preprod', clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  const urls = ENVS[env] || ENVS.preprod;
  let cached = null;
  async function token() {
    if (cached && cached.until > Date.now() + 30000) return cached.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'InvoicingAPI' });
    const r = await fetchImpl(`${urls.id}/connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`ETA sign-in failed (${r.status})${j.error_description ? `: ${j.error_description}` : ''}`);
    cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return cached.token;
  }
  async function submit(documents) {
    const r = await fetchImpl(`${urls.api}/api/v1.0/documentsubmissions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify({ documents }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new Error(`ETA submission failed (${r.status})${j.error && j.error.message ? `: ${j.error.message}` : ''}`);
    return j;
  }
  async function status(uuid) {
    const r = await fetchImpl(`${urls.api}/api/v1.0/documents/${encodeURIComponent(uuid)}/details`, { headers: { authorization: `Bearer ${await token()}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`ETA status check failed (${r.status})`);
    return j;
  }
  async function cancel(uuid, reason) {
    const r = await fetchImpl(`${urls.api}/api/v1.0/documents/state/${encodeURIComponent(uuid)}/state`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify({ status: 'cancelled', reason }),
    });
    if (!r.ok) throw new Error(`ETA cancellation failed (${r.status})`);
    return true;
  }
  return { token, submit, status, cancel, urls };
}

// Ask the signing service (beside the USB token) to sign the canonical string.
async function signWithService(url, canonical, { fetchImpl = globalThis.fetch } = {}) {
  const r = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ canonical, sha256: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex') }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.signature) throw new Error(`The signing service did not sign (${r.status})`);
  return j.signature;
}

module.exports = { ENVS, SETTING_KEYS, DEFAULTS, serialize, canonicalHash, buildDocument, validate, api, signWithService, isoUtc };
