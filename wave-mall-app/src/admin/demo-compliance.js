'use strict';

// Sample data for safety and licences: the mall's register (civil defence, fire systems, lifts and
// escalators, generators, pest control, water tanks, licences, insurance) with a year of tests and
// renewals behind it — two items overdue, a few due within the month, one failed test redone — and
// insurance reminders already sent to two tenants (one seen, one not).

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);

// [category, title, provider, number, freq, next due (days from today), remind days]
const ITEMS = [
  ['civil_defence', 'Civil defence operating approval', 'Civil Defence Authority, New Cairo', 'CD-NC-2025-1187', 'yearly', 74, 60],
  ['fire_alarm', 'Fire alarm system test (all zones)', 'SafeTech Fire Systems', null, 'quarterly', 12, 21],
  ['sprinklers', 'Sprinkler system and fire pumps inspection', 'SafeTech Fire Systems', null, 'half', 41, 30],
  ['extinguishers', 'Fire extinguishers service and refill', 'Nile Fire Equipment', null, 'yearly', -6, 30],
  ['emergency_lighting', 'Emergency lighting 3-hour discharge test', 'In-house electrical team', null, 'half', 23, 30],
  ['lifts', 'Passenger lifts annual certificate (6 lifts)', 'Schindler Egypt', 'LFT-2025-0442', 'yearly', 133, 45],
  ['escalators', 'Escalators annual certificate (4 escalators)', 'Schindler Egypt', 'ESC-2025-0119', 'yearly', 133, 45],
  ['generator', 'Generator load test', 'Power Gen Services', null, 'monthly', 4, 7],
  ['generator', 'Generator full service', 'Power Gen Services', null, 'half', 88, 30],
  ['pest', 'Pest control, all common areas and food court', 'Clean Pro Pest Control', null, 'monthly', 9, 7],
  ['water_tanks', 'Water tanks cleaning and lab test', 'Aqua Care', null, 'half', -19, 30],
  ['licence', 'Commercial licence of the mall', 'New Cairo City Authority', 'LIC-77310', 'yearly', 201, 60],
  ['licence', 'Signage and advertising permit', 'New Cairo City Authority', 'ADV-5521', 'yearly', 27, 45],
  ['insurance', 'Property all-risk insurance policy', 'Nile Shield Insurance', 'NS-PAR-2026-0091', 'yearly', 20, 45],
  ['insurance', 'Public liability insurance policy', 'Nile Shield Insurance', 'NS-PL-2026-0310', 'yearly', 20, 45],
  ['civil_defence', 'Evacuation drill with all tenants', 'In-house security team', null, 'half', 56, 30],
];

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  const C = h.compliance;
  if (!C || !has(db, 'cmp_items') || db.value('SELECT COUNT(*) FROM cmp_items WHERE demo = 1')) return;
  const M = h.M || require('./model');
  const T = M.today();
  const now = new Date().toISOString();
  const uid = admin ? admin.id : null;
  db.tx(() => {
    ITEMS.forEach(([category, title, provider, number, freq, due, remind], i) => {
      const next = M.addDays(T, due);
      // walk back over the past year to the first test, then record each one going forward
      const steps = [];
      let d = next;
      for (let k = 0; k < 14; k++) {
        const f = C.FREQ[freq];
        const prev = f[2] ? M.addDays(d, -f[2]) : M.addMonths(d, -f[1]);
        if (prev < M.addDays(T, -380)) break;
        steps.unshift(prev);
        d = prev;
      }
      const first = steps[0] || M.addDays(T, -300);
      const id = Number(db.run(`INSERT INTO cmp_items (ref, category, title, provider, number, freq, last_done, next_due, owner_id, remind_days, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?)`, `SL-${String(900 + i + 1)}`, category, title, provider, number, freq, first, uid, remind, now, now).lastInsertRowid);
      for (const [k, on] of steps.entries()) {
        if (on > T) break;
        const item = db.get('SELECT * FROM cmp_items WHERE id = ?', id);
        // the water tanks lab test failed once and was redone two weeks later
        if (category === 'water_tanks' && k === steps.length - 1) {
          C.recordDone(item, { done_on: on, result: 'fail', by_name: provider, note: 'Lab test above the limit for bacteria; tanks to be cleaned again', user: { id: uid }, demo: 1 });
          continue;
        }
        C.recordDone(item, {
          done_on: on, result: category === 'lifts' || category === 'sprinklers' ? (k === 0 ? 'conditional' : 'pass') : 'pass', by_name: provider,
          cert_no: number ? `${number.split('-')[0]}-${on.slice(0, 4)}-${100 + k}` : null, next_due: k === steps.length - 1 ? next : null,
          note: k === 0 && (category === 'lifts' || category === 'sprinklers') ? 'Minor remarks fixed within the month' : null, user: { id: uid }, demo: 1,
        });
      }
      // what the register shows now
      db.run('UPDATE cmp_items SET next_due = ?, alerted = NULL WHERE id = ?', next, id);
    });
    // insurance reminders already sent: one tenant saw it, one did not yet
    if (C.insurance && C.remind) {
      const late = C.insurance().filter((r) => ['expired', 'soon', 'missing'].includes(r.state)).slice(0, 2);
      const notices = late.map((r) => C.remind(r, { user: admin, demo: 1 }));
      db.run('UPDATE cmp_reminders SET at = ? WHERE demo = 1', new Date(Date.now() - 3 * 86400000).toISOString());
      const pu = late[0] && notices[0] ? db.get('SELECT id FROM portal_users WHERE brand_id = ? AND active = 1 LIMIT 1', late[0].id) : null;
      if (pu) db.run('INSERT OR IGNORE INTO portal_notice_reads (notice_id, portal_user_id, read_at) VALUES (?, ?, ?)', notices[0], pu.id, new Date(Date.now() - 2 * 86400000).toISOString());
    }
  });
}

function clear(db) {
  if (!has(db, 'cmp_items')) return;
  db.tx(() => {
    db.run('DELETE FROM cmp_done WHERE demo = 1 OR item_id IN (SELECT id FROM cmp_items WHERE demo = 1)');
    db.run('DELETE FROM cmp_items WHERE demo = 1');
    db.run('DELETE FROM cmp_reminders WHERE demo = 1');
  });
}

module.exports = { load, clear };
