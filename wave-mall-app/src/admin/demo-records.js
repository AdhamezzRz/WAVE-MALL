'use strict';

// Sample data for the document vault and the contracts register: the mall's service contracts
// (an Egyptian mall in its opening year), the mall's own papers, and signed copies for the sample
// leases (one left missing on purpose). Text is stored in English and shown in Arabic through tx()
// (see i18n/ar-records.js). Every row carries demo = 1.

const M = require('./model');
const { samplePdf } = require('./files');

const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

// [title, counterparty, kind, status, start (days from today), end, notice days, value, billing, auto renew, contact, notes]
const CONTRACTS = [
  ['Security guarding for the mall', 'Sentinel Guard Services', 'security', 'active', -200, 165, 90, 385000, 'monthly', 0, ['Tarek Mansour', '+20 100 555 0101', 'tarek@sentinelguard.example'], 'Twenty-four guards in three shifts, CCTV control room staffed around the clock.'],
  ['Cleaning and housekeeping', 'Brightway Cleaning', 'cleaning', 'active', -300, 50, 60, 240000, 'monthly', 0, ['Mona Fawzy', '+20 101 555 0144', 'mona@brightway.example'], 'Common areas, terraces, toilets and the court; night deep clean twice a week.'],
  ['MEP maintenance', 'Meridian MEP', 'maintenance', 'active', -120, 610, 90, 175000, 'monthly', 1, ['Eng. Karim Adel', '+20 102 555 0177', 'karim@meridianmep.example'], 'Preventive maintenance for HVAC, electrical and plumbing; four-hour response for critical faults.'],
  ['Landscaping of the court and terraces', 'Green Terrace Landscaping', 'landscaping', 'active', -90, 275, 30, 48000, 'monthly', 0, ['Hany Samir', '+20 106 555 0109', null], null],
  ['Property all-risk insurance', 'Nile Shield Insurance', 'insurance', 'active', -345, 20, 45, 1850000, 'annual', 0, ['Rana Hegazy', '+20 2 2555 0190', 'rana@nileshield.example'], 'All-risk property cover and third-party liability for the building and common areas.'],
  ['Parking operations', 'ParkLane Operations', 'parking', 'draft', 30, 30 + 3 * 365 - 1, 90, 95000, 'monthly', 0, ['Sherif Lotfy', '+20 112 555 0160', 'sherif@parklane.example'], 'Draft under review: ticketless entry, valet on weekends.'],
  ['Wi-Fi and building network', 'Orbit Networks', 'it', 'active', -60, 305, 60, 210000, 'quarterly', 0, ['Omar Zaki', '+20 109 555 0131', 'support@orbitnetworks.example'], null],
  ['Launch marketing campaign', 'Studio Raml', 'marketing', 'active', -400, -35, 30, 160000, 'monthly', 0, ['Laila Mostafa', '+20 122 555 0118', 'laila@studioraml.example'], 'Opening campaign, social media and the press preview.'],
  ['Waste collection and recycling', 'EcoCycle Waste', 'waste', 'active', -150, 215, 30, 36000, 'monthly', 1, ['Ahmed Wahba', '+20 111 555 0175', null], null],
  ['Lifts and escalators maintenance', 'Atlas Lifts & Escalators', 'elevators', 'active', -30, 700, 90, 960000, 'annual', 0, ['Eng. Nadia Saleh', '+20 100 555 0188', 'service@atlaslifts.example'], 'Full maintenance for six lifts and four escalators, monthly inspection reports.'],
];

// [title, kind, issued (days from today), expires, lines]
const OFFICE = [
  ['Mall operating licence', 'licence', -200, 240, ['Licence to operate a commercial centre', 'North 90 Street, First Sector, New Cairo', 'Issued by the New Cairo City Authority']],
  ['Civil defence certificate', 'permit', -100, 265, ['Fire safety systems inspected and approved', 'Sprinklers, alarms, emergency exits and lighting']],
  ['Property insurance policy', 'insurance', -345, 20, ['All-risk property cover and third-party liability', 'Insurer: Nile Shield Insurance']],
  ['Temporary signage permit', 'permit', -192, -12, ['Hoarding and temporary signage during fit-out', 'Valid for six months']],
  ['Health and safety policy', 'policy', -60, null, ['Mall-wide health and safety rules', 'Applies to staff, tenants and contractors']],
];

function addDoc(db, files, admin, { entity, entityId, kind, title, name, issued, expires, lines, notes = null, created }) {
  const saved = files.save(samplePdf(title, lines), name);
  if (saved.error) return null;
  return db.run(
    `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, expires_on, notes, uploaded_by, demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    db.nextRef('documents', 'DOC', 4, true), entity, entityId, kind, title, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored,
    issued, expires, notes, admin ? admin.id : null, created || ago(20),
  );
}

function load(db, admin, { files } = {}) {
  if (db.value('SELECT COUNT(*) FROM contracts WHERE demo = 1')) return;
  const manager = db.get("SELECT id FROM users WHERE email LIKE '%@demo.thewave.local' AND role = 'manager' ORDER BY id LIMIT 1");
  const ownerId = (manager && manager.id) || (admin && admin.id) || null;
  db.tx(() => {
    const ids = CONTRACTS.map(([title, party, kind, status, start, end, notice, value, billing, auto, [cn, cp, ce], notes], i) => {
      const r = db.run(
        `INSERT INTO contracts (ref, title, counterparty, kind, status, start_date, end_date, notice_days, auto_renew, value, billing, owner_id, contact_name, contact_phone, contact_email, notes, demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        db.nextRef('contracts', 'SC', 3, true), title, party, kind, status, iso(start), iso(end), notice, auto, value, billing, ownerId, cn, cp, ce, notes, ago(Math.max(1, -start + 5)), ago(Math.max(1, -start)),
      );
      const id = Number(r.lastInsertRowid);
      db.run('INSERT INTO audit (user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', ownerId, 'Created a contract', 'contract', id, `${db.value('SELECT ref FROM contracts WHERE id = ?', id)} · ${party}`, ago(Math.max(1, -start + 5)));
      return { id, i, title, party, kind, status, start, end, value, billing };
    });
    if (!files) return;
    // signed service contracts (not the draft)
    for (const c of ids.filter((x) => x.status !== 'draft')) {
      addDoc(db, files, admin, {
        entity: 'contract', entityId: c.id, kind: 'service_contract', title: `Service contract — ${c.party}`, name: `${c.party.toLowerCase().replace(/[^a-z]+/g, '-')}-contract.pdf`,
        issued: iso(c.start - 7), expires: iso(c.end),
        lines: [`Between The Wave Mall and ${c.party}`, `Scope: ${c.title}`, `Term: ${iso(c.start)} to ${iso(c.end)}`, `Value: EGP ${c.value.toLocaleString('en-US')} ${c.billing.replace('_', '-')}`, 'Signed and stamped by both parties'],
        created: ago(Math.max(1, -c.start + 3)),
      });
    }
    // the mall's own papers
    for (const [title, kind, issued, expires, lines] of OFFICE) {
      addDoc(db, files, admin, { entity: 'office', entityId: null, kind, title, name: `${title.toLowerCase().replace(/[^a-z]+/g, '-')}.pdf`, issued: iso(issued), expires: expires === null ? null : iso(expires), lines, created: ago(Math.max(1, -issued)) });
    }
    // signed copies for the sample leases (unless already filed); the last one is left missing so the gap shows
    const leases = db.all('SELECT s.*, b.name brand FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.demo = 1 ORDER BY s.id');
    const hasSigned = (id) => db.value("SELECT COUNT(*) FROM documents WHERE entity = 'lease' AND entity_id = ? AND kind = 'lease_contract'", id);
    leases.forEach((s, i) => {
      if (i === leases.length - 1 || hasSigned(s.id)) return;
      const slug = s.brand.toLowerCase().replace(/[^a-z]+/g, '-');
      const units = M.leaseUnits(db, s.id).map((u) => u.code).join(', ');
      addDoc(db, files, admin, {
        entity: 'lease', entityId: s.id, kind: 'lease_contract', title: `Signed lease — ${s.brand}`, name: `${s.ref.toLowerCase()}-${slug}-signed.pdf`,
        issued: s.signed_at ? s.signed_at.slice(0, 10) : s.start_date, expires: s.end_date,
        lines: [`Lease ${s.ref} between The Wave Mall and ${s.brand}`, `Units: ${units}`, `Term: ${s.start_date} to ${s.end_date}`, `Rent: EGP ${s.rent_m2} per m2 per month, ${s.escalation_pct}% yearly increase`, 'Signed by both parties'],
        created: s.signed_at || ago(30),
      });
      if (i === 0) addDoc(db, files, admin, { entity: 'lease', entityId: s.id, kind: 'handover', title: `Handover report — ${s.brand}`, name: `${slug}-handover.pdf`, issued: s.start_date, expires: null, lines: [`Units ${units} handed over in shell and core`, 'Meter readings and keys recorded'], created: ago(10) });
      if (i === 1) addDoc(db, files, admin, { entity: 'lease', entityId: s.id, kind: 'guarantee', title: `Bank guarantee — ${s.brand}`, name: `${slug}-guarantee.pdf`, issued: iso(-60), expires: iso(300), lines: ['Unconditional bank guarantee for the security deposit', 'Valid for one year'], created: ago(60) });
    });
  });
}

function clear(db, { files } = {}) {
  const docs = db.all("SELECT id, stored FROM documents WHERE (demo = 1 AND entity IN ('contract', 'office', 'lease')) OR (entity = 'contract' AND entity_id IN (SELECT id FROM contracts WHERE demo = 1))");
  db.tx(() => {
    db.run("UPDATE documents SET replaces_id = NULL WHERE replaces_id IN (SELECT id FROM documents WHERE demo = 1 AND entity IN ('contract', 'office', 'lease'))");
    db.run("DELETE FROM documents WHERE demo = 1 AND entity IN ('contract', 'office', 'lease')");
    db.run("DELETE FROM audit WHERE entity = 'contract' AND entity_id IN (SELECT id FROM contracts WHERE demo = 1)");
    db.run("DELETE FROM documents WHERE entity = 'contract' AND entity_id IN (SELECT id FROM contracts WHERE demo = 1)");
    db.run('DELETE FROM contracts WHERE demo = 1');
  });
  if (files) for (const d of docs) files.release(db, d.stored);
}

module.exports = { load, clear, CONTRACTS, OFFICE };
