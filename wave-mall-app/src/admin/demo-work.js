'use strict';

// Sample data for the work hub: about forty tasks across the team — every column, every priority,
// labels, checklists half done, links to real records (a lease, an invoice, a work order, a
// tenant), comments that @mention people; a colleague away with someone covering; recurring
// tasks (a weekly fire extinguisher round, the monthly owner report check…); and approval
// requests that show the work hub's tricks: one overdue and escalated, one close to its SLA,
// one waiting for the requester's answer, one answered and taken on, one approved, one rejected.

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const DEMO = { demo: 'work' };

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  const W = h.work;
  const A = h.approvals;
  const M = h.M;
  if (!W || !A || !M || !has(db, 'wk_tasks') || db.value('SELECT COUNT(*) FROM wk_tasks WHERE demo = 1')) return;
  const boss = admin && admin.id ? db.get('SELECT * FROM users WHERE id = ?', admin.id) : db.get("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");
  if (!boss) return;
  const person = (name, fb) => db.get('SELECT * FROM users WHERE name = ? AND active = 1', name) || fb;
  const karim = person('Karim Mostafa', boss);
  const salma = person('Salma Adel', boss);
  const omar = person('Omar Fathy', boss);
  const nour = person('Nour Hassan', boss);
  const T = W.today();
  const day = (n) => M.addDays(T, n);
  const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
  const first = (sql, ...a) => {
    try {
      return db.get(sql, ...a);
    } catch {
      return null;
    }
  };
  // real records to link tasks to
  const lease = has(db, 'leases') ? first("SELECT s.id FROM leases s WHERE s.status = 'active' AND s.demo = 1 ORDER BY s.id LIMIT 1") : null;
  const lease2 = has(db, 'leases') ? first("SELECT s.id FROM leases s WHERE s.status = 'active' AND s.demo = 1 ORDER BY s.id DESC LIMIT 1") : null;
  const inv = has(db, 'invoices') ? first("SELECT id FROM invoices WHERE status IN ('open','partial') AND due_date < ? ORDER BY due_date LIMIT 1", T) : null;
  const wo = has(db, 'work_orders') ? first("SELECT id FROM work_orders WHERE status NOT IN ('closed','cancelled') ORDER BY id LIMIT 1") : null;
  const brand = has(db, 'brands') ? first('SELECT id FROM brands WHERE demo = 1 ORDER BY id LIMIT 1') : null;
  const link = (kind, r) => (r ? { lease: `/admin/leases/${r.id}`, invoice: `/admin/invoices/${r.id}`, wo: `/admin/maintenance/orders/${r.id}`, brand: `/admin/tenants/${r.id}` }[kind] : null);

  // title, status, priority, due (days from today, null = none), time, labels, link, assignees, watchers, checklist [text, done], comments [[who, text, hours ago]], created (days ago)
  const TASKS = [
    ['Chase the Q4 service charge for Kahwa House', 'doing', 'high', 0, '15:00', 'collections, tenants', link('invoice', inv), [salma], [karim], [['Call the finance manager', 1], ['Send the statement of account', 1], ['Agree a payment date', 0]], [[karim, '@Salma Adel they promised to pay on Thursday last time — please push for a cheque this week.', 26], [salma, 'Spoke to them: transfer tomorrow morning, I will confirm.', 3]], 5],
    ['Renewal offer for Maison Lune', 'todo', 'urgent', 2, null, 'leasing, renewals', link('lease', lease), [karim], [boss], [['Check sales per m² for the last 12 months', 1], ['Draft the new rent with 10% increase', 0], ['Send the offer letter', 0]], [[boss, '@Karim keep the increase at 10% if they sign before the end of the month.', 20]], 3],
    ['Fit-out handover pack for unit G12', 'todo', 'normal', 6, null, 'fit-out', null, [omar], [], [['Floor plan with services', 0], ['Design guidelines', 0], ['Contractor rules and permits', 0]], [], 2],
    ['Fix the escalator handrail at entrance B', 'doing', 'urgent', -1, '12:00', 'maintenance, safety', link('wo', wo), [nour], [karim, boss], [['Isolate the escalator', 1], ['Order the handrail kit', 1], ['Install and test', 0]], [[nour, 'Parts arrived this morning. Technician starts at 10.', 5], [karim, `@${boss.name.split(/\s+/)[0]} please approve the overtime if it runs late.`, 4]], 2],
    ['Prepare the October owner report', 'done', 'high', -3, null, 'reports, owner', '/admin/owner-report', [boss], [karim], [['Close the month in accounting', 1], ['Review occupancy and collections', 1], ['Send to the owner', 1]], [], 9],
    ['Quotes for the new parking signage', 'waiting', 'normal', 4, null, 'parking, purchasing', '/admin/parking', [omar], [], [['Ask three suppliers', 1], ['Compare the quotes', 0]], [[omar, 'Waiting for the third supplier — they promised the quote on Sunday.', 30]], 6],
    ['White Friday campaign: book the atrium screens', 'doing', 'high', 3, null, 'marketing, advertising', '/admin/media', [salma], [boss], [['Hold the slots', 1], ['Get the artwork from the tenants', 0], ['Confirm the bookings', 0]], [], 4],
    ['Insurance certificates missing for 3 tenants', 'todo', 'high', 1, null, 'tenants, safety', '/admin/compliance/insurance', [nour], [karim], [], [[karim, 'Send a reminder from Safety & licences first, then call.', 22]], 3],
    ['Civil defence visit: walk-through with the safety officer', 'todo', 'urgent', 5, '10:00', 'safety', '/admin/compliance', [karim], [boss, nour], [['Fire alarm test log up to date', 1], ['Emergency exits clear', 0], ['Extinguisher tags checked', 0], ['First aid boxes refilled', 0]], [], 4],
    ['Update the tenant directory on the website', 'done', 'low', -6, null, 'website', '/admin/website', [omar], [], [['New openings added', 1], ['Closed stores removed', 1]], [], 12],
    ['Reconcile the parking cash for last week', 'done', 'normal', -2, null, 'parking, finance', '/admin/parking', [salma], [], [['Count the safe', 1], ['Match bank deposits', 1]], [], 5],
    ['Brand pitch: sportswear anchor for the east wing', 'doing', 'high', 8, null, 'leasing', '/admin/leads', [karim, salma], [boss], [['Plans and footfall pack', 1], ['Rent proposal', 0], ['Site visit', 0]], [[salma, '@Karim Mostafa their regional director is in Cairo on the 20th — can we do the site visit then?', 18]], 7],
    ['Order uniforms for the new security team', 'todo', 'normal', 10, null, 'security, purchasing', '/admin/purchasing', [nour], [], [], [], 1],
    ['Water leak in the B1 store room', 'done', 'urgent', -4, null, 'maintenance', null, [nour], [karim], [['Find the source', 1], ['Repair the pipe', 1], ['Dry and check the stock', 1]], [[nour, 'Fixed. Two boxes of cleaning stock written off.', 90]], 6],
    ['Ramadan decorations: approve the design', 'todo', 'normal', 20, null, 'marketing', null, [boss], [salma], [], [], 1],
    ['Meet the new food court operator', 'doing', 'normal', 1, '13:30', 'tenants', link('brand', brand), [omar], [], [['Agenda', 1], ['Trading hours and delivery rules', 0]], [], 3],
    ['Check the generator fuel contract', 'todo', 'low', 14, null, 'energy, purchasing', '/admin/energy', [nour], [], [], [], 2],
    ['Collect the post-dated cheques from Kahwa House', 'waiting', 'normal', 2, null, 'cheques, collections', '/admin/cheques', [salma], [], [], [[salma, 'They will have them signed by the owner on Monday.', 12]], 4],
    ['Service charge budget 2027: first draft', 'todo', 'high', 12, null, 'finance, budget', '/admin/service-charge', [karim], [boss], [['Last year actuals', 1], ['Contracts renewing next year', 0], ['Energy forecast', 0], ['Draft per m²', 0]], [], 5],
    ['Clean the facade glass before the opening weekend', 'doing', 'normal', 2, null, 'cleaning', '/admin/security/cleaning', [nour], [], [['Book the rope access team', 1], ['Permit from the building manager', 1], ['Work done', 0]], [], 4],
    ['Close the September payroll queries', 'done', 'normal', -8, null, 'hr', '/admin/hr/payroll', [boss], [], [], [], 14],
    ['Tenant satisfaction survey: send to all store managers', 'todo', 'low', 9, null, 'tenants', null, [omar], [], [], [], 1],
    ['Fix the broken parking barrier at exit 2', 'done', 'urgent', -1, null, 'parking, maintenance', '/admin/parking', [nour], [], [], [[nour, 'Motor replaced, back in service.', 30]], 3],
    ['Lease signing: Bloom Pharmacy', 'waiting', 'high', 1, null, 'leasing', link('lease', lease2), [karim], [salma], [['Final lease sent', 1], ['Signed copy back', 0], ['Deposit received', 0]], [[karim, 'They asked for one more day for their lawyer.', 8]], 6],
    ['Write the parking subscriber newsletter', 'todo', 'low', 15, null, 'parking, marketing', null, [salma], [], [], [], 1],
    ['Monthly fire alarm test', 'done', 'normal', -5, null, 'safety, monthly', '/admin/compliance', [nour], [], [['Test all zones', 1], ['Log the results', 1]], [], 6],
    ['Overdue rent: legal letter for Studio Nine', 'doing', 'urgent', 0, null, 'collections, legal', '/admin/collections', [karim], [boss], [['Check the account', 1], ['Lawyer drafts the letter', 0], ['Send by courier', 0]], [[boss, 'Go ahead with the letter. @Karim Mostafa copy me on the courier receipt.', 6]], 3],
    ['New staff onboarding: two customer service agents', 'todo', 'normal', 7, null, 'hr', '/admin/hr', [boss], [], [['Contracts', 0], ['Accounts on the system', 0], ['Uniforms', 0]], [], 2],
    ['Replace the lobby plants', 'cancelled', 'low', null, null, 'cleaning', null, [omar], [], [], [[omar, 'Landscaping contract covers it — cancelled.', 120]], 10],
    ['Kids zone: safety inspection before the holidays', 'todo', 'high', 4, null, 'safety', null, [nour], [karim], [['Soft play padding', 0], ['Gates and latches', 0], ['First aid kit', 0]], [], 2],
    ['Prepare the WALE and occupancy slides for the bank', 'doing', 'normal', 3, null, 'reports, finance', '/admin/reports', [salma], [boss], [], [], 3],
    ['Valet: new key cabinet', 'waiting', 'low', 6, null, 'parking, security', null, [omar], [], [], [[omar, 'Waiting for the approval of the purchase.', 40]], 5],
    ['Energy: switch the car park lights to night mode', 'done', 'normal', -9, null, 'energy', '/admin/energy', [nour], [], [['Program the BMS', 1], ['Check the light levels', 1]], [], 15],
    ['Follow up on the unpaid media invoice', 'todo', 'normal', 2, null, 'advertising, collections', '/admin/media', [salma], [], [], [], 1],
    ['Shopper feedback: toilets on L1 — complaints this week', 'doing', 'high', 1, null, 'cleaning, feedback', '/admin/feedback', [nour], [karim], [['Check the cleaning log', 1], ['Talk to the supervisor', 0]], [[karim, '@Nour Hassan four low ratings since Sunday. Let us add a round at 14:00.', 10]], 2],
    ['Quarterly meeting with the owner', 'todo', 'high', 11, '11:00', 'owner', null, [boss], [karim], [['Agenda', 0], ['Owner report and forecast', 0]], [], 1],
    ['Unit G07: photos for the leasing brochure', 'done', 'low', -10, null, 'leasing, marketing', null, [omar], [], [], [], 16],
    ['Bank guarantee renewal for Urban Fit', 'todo', 'normal', 18, null, 'leasing, finance', null, [karim], [], [], [], 1],
    ['Check CCTV coverage of the new loading bay', 'todo', 'normal', 5, null, 'security', '/admin/security', [nour], [], [], [], 1],
    ['Collections call list for this week', 'doing', 'high', 0, null, 'collections', '/admin/collections', [salma, omar], [karim], [['Ten tenants over 30 days', 1], ['Log every promise', 0]], [], 2],
  ];

  const ids = [];
  db.tx(() => {
    for (const [title, status, priority, due, time, labels, lnk, asg, wat, checks, comments, createdAgo] of TASKS) {
      const created = ago(createdAgo * 24 + 3);
      const t = W.createTask({
        title, status: status === 'cancelled' ? 'todo' : status === 'done' ? 'todo' : status, priority, due_date: due === null ? null : day(due), due_time: time, labels, link: lnk,
        assignees: asg.filter(Boolean).map((u) => u.id), watchers: wat.filter(Boolean).map((u) => u.id), checklist: checks.map((c) => c[0]), user: [karim, boss, salma][title.length % 3], demo: 1, at: created,
      });
      ids.push(t.id);
      db.run('UPDATE wk_events SET at = ? WHERE task_id = ?', created, t.id);
      // ticked items
      const rows = db.all('SELECT id FROM wk_checks WHERE task_id = ? ORDER BY pos', t.id);
      checks.forEach((c, i) => { if (c[1] && rows[i]) db.run('UPDATE wk_checks SET done_at = ?, done_by = ? WHERE id = ?', ago(createdAgo * 12 + i), asg[0].id, rows[i].id); });
      for (const [who, text, hrs] of comments) {
        W.comment(t, who, text);
        db.run("UPDATE wk_events SET at = ? WHERE id = (SELECT MAX(id) FROM wk_events WHERE task_id = ? AND kind = 'comment')", ago(hrs), t.id);
      }
      if (status === 'done' || status === 'cancelled') {
        W.moveTask(W.taskOf(t.id), status, asg[0], { at: ago(Math.max(2, (due === null ? 2 : -due) * 24 - 5)) });
      }
      db.run('UPDATE wk_tasks SET updated_at = ? WHERE id = ?', ago(Math.min(createdAgo * 24, 20)), t.id);
    }

    // someone away, someone covering
    if (omar.id !== salma.id) A.delegate({ user_id: omar.id, delegate_id: salma.id, starts: day(-2), ends: day(5), note: 'Annual leave — reachable by phone for urgent matters.', by: omar, demo: 1 });

    // recurring tasks
    const tpl = (title, every, { weekday = null, monthday = null, assignee = null, priority = 'normal', labels = null, checklist = null, body = null, due_days = 0 } = {}) => {
      const t = { every, weekday, monthday };
      db.run(`INSERT INTO wk_templates (title, body, priority, assignee_id, labels, checklist, every, weekday, monthday, due_days, next_on, created_by, demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, title, body, priority, assignee ? assignee.id : null, labels, checklist, every, weekday, monthday, due_days, W.nextOn(t, day(1)), karim.id, ago(24 * 40));
    };
    tpl('Weekly fire extinguisher round', 'weekly', { weekday: 5, assignee: nour, priority: 'high', labels: 'safety, weekly', checklist: 'Ground floor\nLevel 1\nFood court kitchen corridor\nCar park B1\nCar park B2\nLog the tags', due_days: 1 });
    tpl('Monthly owner report check', 'monthly', { monthday: 3, assignee: boss, priority: 'high', labels: 'reports, owner', checklist: 'Month closed in accounting\nOccupancy and collections reviewed\nHighlights written\nSent to the owner', due_days: 2 });
    tpl('Opening walk-through', 'daily', { assignee: karim, labels: 'operations, daily', checklist: 'Entrances and doors\nEscalators running\nToilets clean\nFood court ready' });
    tpl('Cheque deposit run', 'monthly', { monthday: 1, assignee: salma, priority: 'high', labels: 'cheques, finance', checklist: 'Pull the cheques due this month\nDeposit at the bank\nRecord the deposit slips' });
  });

  // approval requests that show the hub's tricks (the rule for "other" decides who approves)
  const step = (fn) => {
    try {
      return fn();
    } catch (e) {
      console.warn('[work] sample step skipped:', e.message);
      return null;
    }
  };
  const req = (title, amount, note, user, hoursAgo, extra = {}) => step(() => A.request({ kind: 'other', title, amount, note, user, demo: 1, at: ago(hoursAgo), payload: DEMO, ...extra }));
  // overdue (the job escalates it below)
  req('Upgrade the food court Wi-Fi access points', 96000, 'Complaints every weekend; eight access points, installation included.', salma, 80);
  // close to its SLA
  req('Extra security guards for the Eid weekend', 64000, 'Twelve guards for three days, through our security contractor.', omar, 45);
  // fresh
  req('Rooftop cinema night: sound and screen rental', 42500, 'For the launch of the rooftop terrace; sponsor covers the snacks.', nour, 5, { priority: 'high' });
  // waiting for an answer
  const q = req('Parking ticket printer service contract', 18900, 'Annual service for six printers.', salma, 30);
  if (q) step(() => A.askInfo(q.id, karim.id === salma.id ? boss : karim, 'Is this the same supplier as last year? Please attach their quote and last year’s price.', { at: ago(20) }));
  // asked, answered, and taken on
  const qa = req('New cleaning machine for the car park', 135000, 'Ride-on scrubber; the old one is beyond repair.', nour, 40);
  if (qa) {
    const by = karim.id === nour.id ? boss : karim;
    step(() => A.askInfo(qa.id, by, 'Did you compare buying with renting one?', { at: ago(36) }));
    step(() => A.answerInfo(qa.id, nour, 'Yes: renting costs 9,000 a month, so buying pays back in fifteen months.', { at: ago(30) }));
    step(() => A.claim(qa.id, by, true));
  }
  // decided
  const ok = req('Sponsor the Cairo marathon water station', 25000, 'Brand on the bibs and the finish line.', omar, 24 * 10);
  if (ok) step(() => A.decide(ok.id, boss, 'approved', 'Good visibility for the price.', { at: ago(24 * 9) }));
  const no = req('Staff uniforms from a new designer', 140000, 'Higher quality, same supplier for three years.', salma, 24 * 5);
  if (no) step(() => A.decide(no.id, boss, 'rejected', 'Too expensive this year — ask the current supplier for a refresh instead.', { at: ago(24 * 4) }));
  // the clock: reminders and escalations as of now
  step(() => A.runSla());

  // the inbox: keep the five newest notifications of each person unread
  for (const u of db.all('SELECT DISTINCT user_id FROM wk_notes WHERE demo = 1')) {
    db.run(`UPDATE wk_notes SET read_at = ? WHERE demo = 1 AND user_id = ? AND read_at IS NULL AND id NOT IN (SELECT id FROM wk_notes WHERE user_id = ? AND demo = 1 ORDER BY id DESC LIMIT 5)`, new Date().toISOString(), u.user_id, u.user_id);
  }
  void ids;
}

function clear(db) {
  if (!has(db, 'wk_tasks')) return;
  db.tx(() => {
    db.run('DELETE FROM wk_notes WHERE demo = 1');
    db.run("DELETE FROM documents WHERE entity = 'wk_task' AND entity_id IN (SELECT id FROM wk_tasks WHERE demo = 1)");
    db.run('DELETE FROM wk_tasks WHERE demo = 1');
    db.run('DELETE FROM wk_templates WHERE demo = 1');
    db.run('DELETE FROM wk_delegations WHERE demo = 1');
    if (has(db, 'apr_requests')) db.run(`DELETE FROM apr_requests WHERE demo = 1 AND payload = ?`, JSON.stringify(DEMO));
  });
}

module.exports = { load, clear };
