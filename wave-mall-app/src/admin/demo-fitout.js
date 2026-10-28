'use strict';

// Sample fit-out projects, one for each sample tenant, at different points on the road to opening:
// three shops already trading (one deposit refunded, one waiting for its refund), one on site with
// its works permits and a signage submission in review, and Atelier Nour, still in design, whose
// concept was sent back once and whose second round is now past the mall's review deadline.
// Atelier Nour's accepted offer becomes a draft lease here so it has a project.
// Deposits are billed and paid through the billing service. Every name here is fictional.

const M = require('./model');
const { samplePdf } = require('./files');

const DEMO_MAIL = '@demo.thewave.local';

// Contractors are local fit-out companies; their names are as registered (Arabic).
const SHOPS = {
  'Kahwa House': {
    stage: 'open', created: -150, handover: [-90, -88], opening: [-35, -30], deposit: [150000, -110, -104], refund: [142500, -12, 'Less 7,500 for a damaged floor tile and a hoarding repair'],
    rounds: [
      ['concept', -140, -134, 'approved_comments', 'Concept rev. A: café layout with bar on the plaza side', 'Approved. Keep the bar counter 1.2 m clear of the shopfront line; show the grease trap on the MEP drawings.'],
      ['detailed', -124, -117, 'approved', 'Detailed design and MEP, rev. B', null],
    ],
    contractor: ['شركة البنّاء للتشطيبات', 'محمود سعيد', '+20 10 4471 2290', 'site@albannaa.example', '2026/11834', 140],
    permits: [['work', -88, -32, '08:00–18:00', 'Fit-out works', 'closed'], ['hot_works', -70, -66, '23:00–05:00', 'Kitchen exhaust duct welding', 'closed']],
    checks: { handover: 'all', opening: 'all' },
  },
  'Saffron Table': {
    stage: 'open', created: -140, handover: [-80, -80], opening: [-25, -20], deposit: [150000, -100, -95],
    rounds: [
      ['concept', -130, -125, 'approved', 'Concept: dining room and terrace', null],
      ['detailed', -115, -110, 'approved_comments', 'Detailed design, rev. A', 'Approved with comments: terrace awning to match the plaza palette.'],
      ['mep', -112, -106, 'approved', 'Kitchen MEP and fire suppression', null],
    ],
    contractor: ['المتحدة للمقاولات والديكور', 'هشام عبد الله', '+20 12 2208 6634', 'projects@united-decor.example', '2026/09317', 200],
    permits: [['work', -80, -22, '08:00–18:00', 'Fit-out works', 'closed'], ['after_hours', -40, -26, '22:00–06:00', 'Terrace awning installation', 'closed']],
    checks: { handover: 'all', opening: 'all' },
  },
  'Maison Lune': {
    stage: 'open', created: -120, handover: [-70, -68], opening: [-15, -15], deposit: [120000, -95, -90],
    rounds: [
      ['concept', -112, -106, 'approved', 'Concept: boutique with central display island', null],
      ['detailed', -98, -92, 'approved', 'Detailed design and lighting plan', null],
      ['signage', -60, -55, 'approved_comments', 'Shopfront signage', 'Approved with comments: letters to be 450 mm, halo-lit, no flashing.'],
    ],
    contractor: ['دار التصميم للتجهيزات', 'أحمد رفعت', '+20 11 3390 1147', 'office@dar-design.example', '2026/10245', 160],
    permits: [['work', -68, -16, '08:00–18:00', 'Fit-out works', 'closed']],
    checks: { handover: 'all', opening: 6 },
  },
  'Lumière Beauty': {
    stage: 'works', created: -95, handover: [-22, -20], opening: [25, null], deposit: [60000, -45, -38],
    rounds: [
      ['concept', -80, -74, 'approved', 'Concept: beauty bar and testers wall', null],
      ['detailed', -60, -53, 'approved', 'Detailed design and MEP', null],
      ['signage', -3, null, 'in_review', 'Shopfront signage and window graphics', null],
    ],
    contractor: ['النخبة للديكور', 'كريم يوسف', '+20 10 9921 5530', 'site@elite-decor.example', '2026/12051', 12],
    permits: [['work', -20, 30, '08:00–18:00', 'Fit-out works', 'approved'], ['after_hours', -6, 10, '22:00–06:00', 'Ceiling and lighting works', 'approved'], ['hot_works', 2, 3, '23:00–04:00', 'Shopfront frame welding', 'requested']],
    checks: { handover: 'all', opening: 1 },
  },
  'Atelier Nour': {
    stage: 'review', created: -40, handover: [30, null], opening: [90, null], draft: { units: ['G08'], rent: 2300, years: 7, start: 90 },
    rounds: [
      ['concept', -30, -24, 'rejected', 'Concept rev. A', 'Please revise: the mezzanine is not allowed in unit G08, and the shopfront must keep 70% glazing. Resubmit with a single-level layout.'],
      ['concept', -12, null, 'in_review', 'Concept rev. B, single level', null],
    ],
    checks: { handover: 0, opening: 0 },
  },
};

function load(db, admin, { files, billing, h } = {}) {
  const fit = h && h.fitout;
  if (!fit || !billing) return; // needs the running office (the fit-out module and billing)
  const T = M.today();
  const day = (n) => M.addDays(T, n);
  const at = (n, time = '10:15') => `${day(n)}T${time}:00.000Z`;
  const team = db.all('SELECT id, name, role FROM users WHERE email LIKE ? ORDER BY id', `%${DEMO_MAIL}`);
  const manager = team.find((u) => u.role === 'manager') || admin || null;
  const agent = team.find((u) => u.role === 'agent') || manager;
  const log = (pid, user, action, detail, n, time) => db.run('INSERT INTO audit (user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)', user ? user.id : null, action, 'fitout', pid, detail, at(n, time));

  for (const [name, s] of Object.entries(SHOPS)) {
    const b = db.get('SELECT * FROM brands WHERE name = ? AND demo = 1 ORDER BY id DESC LIMIT 1', name);
    if (!b) continue;
    let lease = db.get("SELECT * FROM leases WHERE brand_id = ? AND status IN ('draft','active') ORDER BY id DESC LIMIT 1", b.id);
    if (!lease && s.draft) lease = draftLease(db, b, s.draft, manager);
    if (!lease) continue;

    db.tx(() => {
      db.run('DELETE FROM fitout_projects WHERE lease_id = ?', lease.id); // one the office opened on a page visit
      const pid = fit.create(lease, { demo: 1 });
      db.run("DELETE FROM audit WHERE entity = 'fitout' AND entity_id = ?", pid);
      const idx = fit.STAGES.indexOf(s.stage);
      const approvedRound = s.rounds.filter((r) => r[3] !== 'in_review' && r[3] !== 'rejected' && r[0] !== 'concept' && r[0] !== 'signage').map((r) => r[2]).sort().pop();
      db.run(
        `UPDATE fitout_projects SET stage = ?, stage_at = ?, planned_handover = ?, actual_handover = ?, planned_opening = ?, actual_opening = ?, approved_at = ?, manager_id = ?, created_at = ?, updated_at = ? WHERE id = ?`,
        s.stage, at(s.stage === 'open' ? s.opening[1] : s.stage === 'works' ? s.handover[1] + 1 : s.rounds[s.rounds.length - 1][1]),
        day(s.handover[0]), s.handover[1] !== null ? day(s.handover[1]) : null, day(s.opening[0]), s.opening[1] !== null ? day(s.opening[1]) : null,
        idx >= fit.STAGES.indexOf('approved') && approvedRound !== undefined ? day(approvedRound) : null, manager ? manager.id : null, at(s.created, '09:20'), at(-1), pid,
      );
      if (s.stage === 'open') db.run('UPDATE brands SET opening_date = ? WHERE id = ?', day(s.opening[1]), b.id);
      log(pid, null, 'Fit-out project opened', lease.ref, s.created, '09:20');

      // design submissions, with their drawings
      const counts = {};
      for (const [kind, sub, decided, status, note, comments] of s.rounds) {
        counts[kind] = (counts[kind] || 0) + 1;
        const rid = Number(db.run(
          `INSERT INTO fitout_rounds (project_id, kind, round_no, note, submitted_on, submitted_by, via, due_on, status, reviewer_id, decided_on, comments, demo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          pid, kind, counts[kind], note, day(sub), name === 'Atelier Nour' && counts[kind] === 2 ? null : agent ? agent.id : null, name === 'Atelier Nour' && counts[kind] === 2 ? 'portal' : 'office', day(sub + 7), status,
          decided !== null ? (manager ? manager.id : null) : null, decided !== null ? day(decided) : null, comments, at(sub, '11:40'),
        ).lastInsertRowid);
        const kindEn = { concept: 'Concept design', detailed: 'Detailed design', mep: 'MEP drawings', signage: 'Signage & shopfront' }[kind];
        const portal = name === 'Atelier Nour' && counts[kind] === 2;
        log(pid, portal ? null : agent, portal ? 'Design submitted through the tenant portal' : 'Design submitted', `${kindEn}, round ${counts[kind]}`, sub, '11:40');
        if (decided !== null) log(pid, manager, 'Design reviewed', `${kindEn}, round ${counts[kind]}: ${{ approved: 'Approved', approved_comments: 'Approved with comments', rejected: 'Revise and resubmit' }[status]}`, decided, '15:05');
        if (!files) continue;
        const sheets = kind === 'concept' ? ['Layout plan', 'Shopfront elevation'] : kind === 'signage' ? ['Signage elevation'] : kind === 'mep' ? ['MEP layout'] : ['Detailed drawings', 'Reflected ceiling plan'];
        for (const sheet of sheets) {
          const title = `${name} · ${sheet}, rev. ${String.fromCharCode(64 + counts[kind])}`;
          const pdf = samplePdf(title, [`${name}, ${lease.ref}`, `${kindEn}, round ${counts[kind]}`, `Submitted ${day(sub)}`, 'Scale 1:50 · A1']);
          const saved = files.save(pdf, `${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.pdf`);
          if (saved.error) continue;
          const doc = Number(db.run(
            `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, notes, uploaded_by, demo, created_at)
             VALUES (?, 'lease', ?, 'fitout_drawings', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            db.nextRef('documents', 'DOC', 4, true), lease.id, title, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored, day(sub), `${kindEn}, round ${counts[kind]}`, agent ? agent.id : null, at(sub, '11:45'),
          ).lastInsertRowid);
          db.run('INSERT INTO fitout_round_docs (round_id, document_id) VALUES (?, ?)', rid, doc);
        }
      }

      // the contractor and the permits
      let cid = null;
      if (s.contractor) {
        const [company, contact, phone, email, policy, expires] = s.contractor;
        cid = Number(db.run('INSERT INTO fitout_contractors (project_id, company, contact_name, phone, email, insurance_policy, insurance_expiry, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
          pid, company, contact, phone, email, policy, day(expires), at(s.handover[0] - 12)).lastInsertRowid);
        log(pid, agent, 'Added a contractor', company, s.handover[0] - 12, '13:10');
      }
      for (const [type, from, to, hours, what, status] of s.permits || []) {
        db.run('INSERT INTO fitout_permits (project_id, contractor_id, type, from_on, to_on, hours, description, status, decided_by, decided_at, via, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
          pid, cid, type, day(from), day(to), hours, what, status, status === 'requested' ? null : manager ? manager.id : null, status === 'requested' ? null : at(from - 1), status === 'requested' ? 'portal' : 'office', at(from - 2));
        log(pid, status === 'requested' ? null : agent, status === 'requested' ? 'Tenant requested a permit' : 'Issued a permit', { work: 'Work permit', hot_works: 'Hot works permit', after_hours: 'After-hours works', delivery: 'Delivery & loading' }[type], from - 2, '10:30');
      }

      // checklists: ticked by the team on the day
      for (const list of ['handover', 'opening']) {
        const items = db.all('SELECT id FROM fitout_checks WHERE project_id = ? AND list = ? ORDER BY sort, id', pid, list);
        const n = s.checks[list] === 'all' ? items.length : s.checks[list];
        const when = list === 'handover' ? s.handover[1] ?? s.handover[0] : s.opening[1] ?? M.daysBetween(T, day(-1));
        items.slice(0, n).forEach((c, i) => db.run('UPDATE fitout_checks SET done_at = ?, done_by = ? WHERE id = ?', day(Math.min(-1, when - (n - i))), ((i % 2 ? manager : agent) || manager || agent || { name: 'Office' }).name, c.id));
      }

      // the fit-out deposit, billed and paid through billing
      if (s.deposit) {
        const [amount, billed, paid] = s.deposit;
        const inv = billing.createInvoice({ lease_id: lease.id, kind: 'fitout', due_date: day(billed + 7), other: amount, note: 'Fit-out deposit', source: 'fitout', source_id: pid, demo: 1 });
        db.run('UPDATE invoices SET created_at = ? WHERE id = ?', at(billed), inv.id);
        db.run('UPDATE fitout_projects SET deposit_invoice_id = ? WHERE id = ?', inv.id, pid);
        log(pid, manager, 'Billed the fit-out deposit', inv.ref, billed, '12:00');
        if (paid !== null) billing.recordPayment({ invoice_id: inv.id, amount, date: day(paid), method: 'transfer', reference: `TRF-${inv.ref.slice(-4)}`, demo: 1 });
        // the payment listener moves early projects to "deposit"; put the sample's stage back
        db.run('UPDATE fitout_projects SET stage = ? WHERE id = ?', s.stage, pid);
        if (s.refund) {
          const [back, on, note] = s.refund;
          fit.refund(fit.projectOf(pid), back, day(on), note, manager);
          log(pid, manager, 'Refunded the fit-out deposit', inv.ref, on, '14:20');
        }
      }
      for (const st of fit.STAGES.slice(1, idx + 1).filter((x) => ['approved', 'handover', 'works', 'completion', 'open'].includes(x))) {
        const n = { approved: approvedRound, handover: s.handover[1], works: s.handover[1] !== null ? s.handover[1] + 1 : null, completion: s.opening[1] !== null ? s.opening[1] - 4 : null, open: s.opening[1] }[st];
        if (n === null || n === undefined) continue;
        const prev = fit.STAGES[fit.STAGES.indexOf(st) - 1];
        log(pid, manager, 'Fit-out stage changed', `Stage: ${SHORT[prev]} → ${SHORT[st]}`, n, '16:30');
      }
    });
  }
}

const SHORT = { kickoff: 'Brief', concept: 'Concept', review: 'Review', detailed: 'Detailed', approved: 'Approved', contractor: 'Contractor', deposit: 'Deposit', handover: 'Handover', works: 'Works', inspection: 'Inspections', completion: 'Completion', open: 'Open' };

// Atelier Nour's accepted offer, drafted into a lease (as the office would from the offer page).
function draftLease(db, b, d, user) {
  const offer = db.get("SELECT o.id, o.lead_id FROM offers o JOIN leads l ON l.id = o.lead_id WHERE l.brand_id = ? AND o.status = 'accepted' ORDER BY o.id DESC LIMIT 1", b.id);
  const units = d.units.map((c) => db.get('SELECT * FROM units WHERE code = ?', c)).filter(Boolean);
  if (!units.length) return null;
  const start = M.addDays(M.today(), d.start);
  const id = Number(db.run(
    `INSERT INTO leases (ref, brand_id, lead_id, offer_id, status, start_date, end_date, term_years, rent_m2, terrace_rent_m2, service_m2, escalation_pct, rent_free_months, payment_freq, deposit, created_by, demo, created_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 140, 10, 3, 'quarterly', ?, ?, 1, ?)`,
    db.nextRef('leases', 'LS', 3, true), b.id, offer ? offer.lead_id : null, offer ? offer.id : null, start, M.addDays(M.addMonths(start, d.years * 12), -1), d.years,
    d.rent, Math.round(d.rent * 0.4), Math.round(M.monthly(units, { rent: d.rent, terrace: d.rent * 0.4 }).rent * 3), user ? user.id : null, new Date(Date.now() - 41 * 86400000).toISOString(),
  ).lastInsertRowid);
  for (const u of units) db.run('INSERT INTO lease_units (lease_id, unit_id) VALUES (?, ?)', id, u.id);
  return db.get('SELECT * FROM leases WHERE id = ?', id);
}

function clear(db) {
  const ids = db.all('SELECT id FROM fitout_projects WHERE demo = 1').map((r) => r.id);
  db.tx(() => {
    if (ids.length) {
      const list = ids.join(',');
      db.run(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE source = 'fitout' AND source_id IN (${list}))`);
      db.run(`UPDATE fitout_projects SET deposit_invoice_id = NULL WHERE id IN (${list})`);
      db.run(`DELETE FROM invoices WHERE source = 'fitout' AND source_id IN (${list})`);
      db.run(`DELETE FROM fitout_round_docs WHERE round_id IN (SELECT id FROM fitout_rounds WHERE project_id IN (${list}))`);
      for (const t of ['fitout_rounds', 'fitout_permits', 'fitout_contractors', 'fitout_checks']) db.run(`DELETE FROM ${t} WHERE project_id IN (${list})`);
      db.run(`DELETE FROM audit WHERE entity = 'fitout' AND entity_id IN (${list})`);
      db.run(`DELETE FROM fitout_projects WHERE id IN (${list})`);
    }
  });
}

module.exports = { load, clear, SHOPS };
