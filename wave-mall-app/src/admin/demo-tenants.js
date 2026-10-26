'use strict';

// Sample tenant files: legal and store details for the sample tenants, and their papers as small
// sample PDFs. Compliance is deliberately varied so every state shows: one complete file, one with
// an expired insurance policy, one missing its tax card, one with insurance about to expire, and a
// reserved brand still collecting its papers. Every name and number here is fictional.

const crypto = require('node:crypto');
const M = require('./model');
const { samplePdf } = require('./files');

const iban = (seed) => {
  const d = crypto.createHash('sha256').update(seed).digest().toString('hex').replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10));
  return `EG${d.slice(0, 27)}`;
};

// name → details; opening is days from today (negative: already trading)
const TENANTS = {
  'Maison Lune': {
    legal_name: 'Maison Lune for Ready-Made Garments S.A.E.', cr_number: '148203', tax_id: '512-874-339', vat_number: '512-874-339',
    legal_address: '14 El Merghany Street, Heliopolis, Cairo', signatory_name: 'Laila Saber', signatory_title: 'Expansion director', signatory_id: '28803150101234',
    bank_name: 'National Bank of Egypt', store_manager: 'Hana Fouad', store_phone: '+20 10 2234 5512', store_email: 'newcairo@maisonlune.example',
    trading_hours: '10:00–24:00', emergency_name: 'Sherif Lotfy', emergency_phone: '+20 12 0045 7781', insurance_policy: 'POL-2026-04417', opening: -15,
    docs: [['commercial_register', 'Commercial register', -400, 1425], ['tax_card', 'Tax card', -380, 700], ['insurance', 'Insurance policy 2026', -60, 300], ['signatory_id', 'Signatory ID · Laila Saber', -900, 1600], ['vat_certificate', 'VAT certificate', -380, null], ['fitout_drawings', 'Fit-out drawings, rev. C', -70, null]],
  },
  'Kahwa House': {
    legal_name: 'Kahwa House for Restaurants and Cafés LLC', cr_number: '201577', tax_id: '488-120-655', vat_number: '488-120-655',
    legal_address: '7 Road 9, Maadi, Cairo', signatory_name: 'Tarek Nabil', signatory_title: 'Founder', signatory_id: '29107010204411',
    bank_name: 'Commercial International Bank', store_manager: 'Youssef Adly', store_phone: '+20 11 5560 2190', store_email: 'thewave@kahwahouse.example',
    trading_hours: '08:00–01:00', emergency_name: 'Tarek Nabil', emergency_phone: '+20 10 9988 1123', insurance_policy: 'POL-2025-11802', opening: -30,
    docs: [['commercial_register', 'Commercial register', -500, 1300], ['tax_card', 'Tax card', -480, 600], ['insurance', 'Insurance policy 2025', -377, -12], ['signatory_id', 'Signatory ID · Tarek Nabil', -800, 1700]],
  },
  'Lumière Beauty': {
    legal_name: 'Lumière for Cosmetics Trading LLC', cr_number: '176340', tax_id: '539-002-871', vat_number: null,
    legal_address: '22 Sphinx Square, Mohandessin, Giza', signatory_name: 'Dina Farouk', signatory_title: 'Retail manager', signatory_id: '29502280105566',
    bank_name: 'Banque Misr', store_manager: 'Rana Samir', store_phone: '+20 10 6612 0457', store_email: 'store.newcairo@lumiere.example',
    trading_hours: '10:00–23:00', emergency_name: 'Dina Farouk', emergency_phone: '+20 10 3301 7765', insurance_policy: 'POL-2026-02291', opening: 25,
    docs: [['commercial_register', 'Commercial register', -300, 1500], ['insurance', 'Insurance policy 2026', -40, 325], ['signatory_id', 'Signatory ID · Dina Farouk', -600, 2000]],
  },
  'Saffron Table': {
    legal_name: 'Saffron Table Hospitality S.A.E.', cr_number: '163918', tax_id: '470-336-219', vat_number: '470-336-219',
    legal_address: '5 Abou El Feda Street, Zamalek, Cairo', signatory_name: 'Hany Gamal', signatory_title: 'Operations director', signatory_id: '28411090108872',
    bank_name: 'QNB Egypt', store_manager: 'Mostafa Kamel', store_phone: '+20 12 7745 3308', store_email: 'newcairo@saffrontable.example',
    trading_hours: '12:00–01:00', emergency_name: 'Hany Gamal', emergency_phone: '+20 10 1180 4462', insurance_policy: 'POL-2025-09934', opening: -20,
    docs: [['commercial_register', 'Commercial register', -450, 1350], ['tax_card', 'Tax card', -430, 650], ['insurance', 'Insurance policy 2025', -347, 18], ['signatory_id', 'Signatory ID · Hany Gamal', -700, 1800], ['permit', 'Civil defence approval', -90, 640]],
  },
  'Atelier Nour': {
    legal_name: 'Atelier Nour Design Studio LLC', cr_number: '219004', tax_id: null, vat_number: null,
    legal_address: '3 Ahmed Orabi Street, Agouza, Giza', signatory_name: 'Mariam Zaki', signatory_title: 'Creative director', signatory_id: '29609120109930',
    bank_name: null, store_manager: null, store_phone: null, store_email: null, trading_hours: '10:00–23:00', emergency_name: null, emergency_phone: null,
    insurance_policy: null, opening: 90,
    docs: [['commercial_register', 'Commercial register', -200, 1600], ['signatory_id', 'Signatory ID · Mariam Zaki', -500, 2100]],
  },
};

function insertDoc(db, files, { entity, entityId, kind, title, issued, expires, by, lines }) {
  const pdf = samplePdf(title, lines);
  const saved = files.save(pdf, `${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.pdf`);
  if (saved.error) return null;
  return db.run(
    `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, expires_on, uploaded_by, demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    db.nextRef('documents', 'DOC', 4, true), entity, entityId, kind, title, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored,
    issued, expires, by, `${issued}T09:30:00.000Z`,
  );
}

function load(db, admin, { files } = {}) {
  const T = M.today();
  const day = (n) => M.addDays(T, n);
  db.tx(() => {
    for (const [name, d] of Object.entries(TENANTS)) {
      const b = db.get('SELECT * FROM brands WHERE name = ? AND demo = 1 ORDER BY id DESC LIMIT 1', name);
      if (!b) continue;
      const insuranceDoc = d.docs.find(([k]) => k === 'insurance');
      db.run(
        `UPDATE brands SET legal_name = ?, cr_number = ?, tax_id = ?, vat_number = ?, legal_address = ?, signatory_name = ?, signatory_title = ?, signatory_id = ?,
           bank_name = ?, iban = ?, store_manager = ?, store_phone = ?, store_email = ?, opening_date = ?, trading_hours = ?, emergency_name = ?, emergency_phone = ?,
           insurance_policy = ?, insurance_expiry = ?, updated_at = ? WHERE id = ?`,
        d.legal_name, d.cr_number, d.tax_id, d.vat_number, d.legal_address, d.signatory_name, d.signatory_title, d.signatory_id,
        d.bank_name, d.bank_name ? iban(name) : null, d.store_manager, d.store_phone, d.store_email, day(d.opening), d.trading_hours, d.emergency_name, d.emergency_phone,
        d.insurance_policy, insuranceDoc && insuranceDoc[3] !== null ? day(insuranceDoc[3]) : null, new Date(Date.now() - 3 * 86400000).toISOString(), b.id,
      );
      if (!files) continue;
      for (const [kind, title, issued, expires] of d.docs) {
        insertDoc(db, files, {
          entity: 'brand', entityId: b.id, kind, title, issued: day(issued), expires: expires === null ? null : day(expires), by: admin ? admin.id : null,
          lines: [`${d.legal_name}`, `${M.DOC_KINDS[kind] ? title : kind}`, `Issued ${day(issued)}${expires !== null ? ` · valid until ${day(expires)}` : ''}`, d.cr_number ? `Commercial register no. ${d.cr_number}` : ''],
        });
      }
      // a signed copy of each lease (only if the office does not have one yet)
      for (const s of db.all("SELECT * FROM leases WHERE brand_id = ? AND status IN ('draft','active')", b.id)) {
        if (db.value("SELECT COUNT(*) FROM documents WHERE entity = 'lease' AND entity_id = ? AND kind = 'lease_contract'", s.id)) continue;
        insertDoc(db, files, {
          entity: 'lease', entityId: s.id, kind: 'lease_contract', title: `Signed lease ${s.ref}`, issued: (s.signed_at || s.start_date).slice(0, 10), expires: s.end_date, by: admin ? admin.id : null,
          lines: [`Lease ${s.ref} between The Wave Mall and ${d.legal_name}`, `Term ${s.start_date} to ${s.end_date}`, `Signed copy, all pages initialled`],
        });
      }
    }
  });
}

function clear(db, { files } = {}) {
  const ids = db.all('SELECT id FROM brands WHERE demo = 1').map((r) => r.id);
  if (!ids.length) return;
  const docs = db.all(`SELECT id, stored FROM documents WHERE demo = 1 AND ((entity = 'brand' AND entity_id IN (${ids.join(',')})) OR (entity = 'lease' AND entity_id IN (SELECT id FROM leases WHERE demo = 1)))`);
  db.tx(() => {
    for (const d of docs) {
      db.run('UPDATE documents SET replaces_id = NULL WHERE replaces_id = ?', d.id);
      db.run('DELETE FROM documents WHERE id = ?', d.id);
    }
    db.run(`UPDATE brands SET legal_name = NULL, cr_number = NULL, tax_id = NULL, vat_number = NULL, legal_address = NULL, signatory_name = NULL, signatory_title = NULL,
      signatory_id = NULL, bank_name = NULL, iban = NULL, store_manager = NULL, store_phone = NULL, store_email = NULL, opening_date = NULL, trading_hours = NULL,
      emergency_name = NULL, emergency_phone = NULL, insurance_policy = NULL, insurance_expiry = NULL, updated_at = NULL WHERE demo = 1`);
  });
  if (files) for (const d of docs) files.release(db, d.stored);
}

module.exports = { load, clear, TENANTS };
