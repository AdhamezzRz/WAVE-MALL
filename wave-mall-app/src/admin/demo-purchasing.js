'use strict';

// Sample data for approvals and purchasing: the approval rules; a store of spare parts and
// supplies with opening stock, parts issued to work orders and departments, an adjustment, and a
// few items running low; purchase requests in every state (approved in two steps, waiting for the
// second step, under the approval amount, not approved, withdrawn); purchase orders to six
// suppliers — one received, billed and paid, one partly delivered and late with a bill at a
// different price, one received and billed, one sent, one draft; and approval requests of other
// kinds (a salary advance waiting, a request approved, one rejected).

const M = require('./model');

const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const ITEMS = [
  // code, name, Arabic, category, unit, min, reorder, location, opening qty, unit cost
  ['EL-0101', 'LED panel 60×60, 40 W', 'لوحة إضاءة LED مقاس 60×60 قدرة 40 وات', 'electrical', 'pcs', 20, 40, 'Store B1 · rack A2', 34, 640],
  ['EL-0102', 'LED downlight 18 W', 'كشاف LED سقفي 18 وات', 'electrical', 'pcs', 30, 60, 'Store B1 · rack A2', 22, 185],
  ['EL-0110', 'Circuit breaker 32 A', 'قاطع كهربائي 32 أمبير', 'electrical', 'pcs', 10, 20, 'Store B1 · rack A3', 16, 410],
  ['EL-0120', 'Power cable 3×4 mm²', 'كابل كهرباء 3×4 مم²', 'electrical', 'm', 100, 300, 'Store B1 · cable reel', 240, 38],
  ['PL-0201', 'Concealed flush valve', 'محبس سيفون مدفون', 'plumbing', 'pcs', 6, 12, 'Store B1 · rack B1', 3, 1350],
  ['PL-0205', 'Sensor tap, washroom', 'خلاط حساس للحمامات', 'plumbing', 'pcs', 4, 8, 'Store B1 · rack B1', 7, 2950],
  ['HV-0301', 'AHU filter G4 592×592', 'فلتر وحدة مناولة الهواء G4 مقاس 592×592', 'hvac', 'pcs', 40, 80, 'Plant room store', 18, 420],
  ['HV-0305', 'Refrigerant R410A', 'غاز تبريد R410A', 'hvac', 'kg', 20, 40, 'Plant room store', 46, 520],
  ['HV-0310', 'Fan belt B-52', 'سير مروحة B-52', 'hvac', 'pcs', 8, 16, 'Plant room store', 11, 260],
  ['CL-0401', 'Floor cleaner, neutral', 'منظف أرضيات متعادل', 'cleaning', 'l', 120, 400, 'Housekeeping store', 310, 42],
  ['CL-0402', 'Hand soap refill', 'عبوة صابون أيدي', 'cleaning', 'l', 80, 200, 'Housekeeping store', 64, 55],
  ['CL-0410', 'Bin liners, heavy duty', 'أكياس قمامة سميكة', 'cleaning', 'roll', 60, 150, 'Housekeeping store', 140, 48],
  ['SF-0501', 'Fire extinguisher CO₂ 6 kg', 'طفاية حريق ثاني أكسيد الكربون 6 كجم', 'safety', 'pcs', 6, 10, 'Security store', 9, 1850],
  ['SF-0505', 'Emergency exit light', 'كشاف مخرج طوارئ', 'safety', 'pcs', 8, 16, 'Security store', 5, 980],
  ['IT-0601', 'CAT6 cable', 'كابل شبكة CAT6', 'it', 'm', 150, 300, 'IT room', 420, 14],
  ['IT-0610', 'Access cards, MIFARE', 'بطاقات دخول MIFARE', 'it', 'box', 3, 6, 'IT room', 4, 2200],
];

const VENDORS = [
  ['El Sewedy Electric Supplies', { tax_id: '204-118-336', phone: '+20 2 2759 1100', email: 'sales@sewedy-supplies.example', terms: 45 }],
  ['Delta HVAC Parts', { tax_id: '311-905-447', phone: '+20 2 2618 4400', email: 'orders@deltahvac.example', terms: 30 }],
  ['Nile Cleaning Solutions', { tax_id: '418-220-019', phone: '+20 10 0123 4567', email: 'accounts@nileclean.example', terms: 30 }],
  ['Cairo Safety Equipment', { tax_id: '512-337-801', phone: '+20 2 2405 8800', email: 'tenders@cairosafety.example', terms: 30 }],
  ['Pyramids Plumbing Supplies', { tax_id: '609-114-552', phone: '+20 2 3385 2200', email: 'info@pyramidsplumbing.example', terms: 30 }],
  ['TechNet Systems', { tax_id: '715-660-238', phone: '+20 2 2290 7300', email: 'billing@technet.example', terms: 30 }],
];

function load(db, admin, opts = {}) {
  const h = opts.h || {};
  const P = h.purchasing;
  const A = h.approvals;
  const L = h.ledger;
  if (!has(db, 'inv_items') || !P || !A || db.value('SELECT COUNT(*) FROM inv_items WHERE demo = 1')) return;
  const T = M.today();
  const day = (n) => M.addDays(T, -n);
  const at = (n, hh = 9) => `${day(n)}T${String(hh).padStart(2, '0')}:${String((n * 7) % 60).padStart(2, '0')}:00.000Z`;
  const boss = admin && admin.id ? db.get('SELECT * FROM users WHERE id = ?', admin.id) : db.get("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");
  if (!boss) return;
  const person = (name, fb) => db.get('SELECT * FROM users WHERE name = ? AND active = 1', name) || fb;
  const manager = person('Karim Mostafa', boss);
  const salma = person('Salma Adel', boss);
  const omar = person('Omar Fathy', boss);
  const dept = (name) => (db.get('SELECT id FROM departments WHERE name = ?', name) || {}).id || null;
  const step = (fn) => {
    try {
      return fn();
    } catch (e) {
      console.warn('[purchasing] sample step skipped:', e.message);
      return null;
    }
  };

  // ---------- the rules ----------
  const rule = (kind, min, steps) => { if (!db.get('SELECT kind FROM apr_rules WHERE kind = ?', kind)) A.setRule(kind, { active: 1, min_amount: min, steps: steps.map((who) => ({ who })), demo: 1 }); };
  rule('purchase', 10000, ['manager', 'finance']);
  rule('advance', 15000, ['manager']);
  rule('writeoff', 0, ['manager', 'admin']);
  rule('refund', 5000, ['finance']);
  rule('media_discount', 20000, ['manager']);
  rule('other', 0, ['manager']);

  db.tx(() => {
    // ---------- the store ----------
    const item = {};
    for (const [code, name, ar, category, unit, min, reorder, location, qty, cost] of ITEMS) {
      const id = Number(db.run('INSERT INTO inv_items (code, name, name_ar, unit, category, min_qty, reorder_qty, location, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        code, name, ar, unit, category, min, reorder, location, at(95), at(95)).lastInsertRowid);
      item[code] = id;
      step(() => P.move({ item_id: id, kind: 'opening', qty, unit_cost: cost, date: day(90), user: boss, demo: 1 }));
    }

    // ---------- suppliers ----------
    const vendor = {};
    if (L) {
      for (const [name, x] of VENDORS) {
        const v = L.vendorFor(name, { demo: 1 });
        db.run('UPDATE acc_vendors SET tax_id = ?, phone = ?, email = ?, terms_days = ?, demo = 1 WHERE id = ?', x.tax_id, x.phone, x.email, x.terms, v.id);
        vendor[name] = v.id;
      }
    }

    // ---------- requests, orders, deliveries, bills ----------
    const line = (code, qty, price) => {
      const it = db.get('SELECT * FROM inv_items WHERE id = ?', item[code]);
      return { item_id: it.id, description: it.name, qty, unit: it.unit, est_price: price, price };
    };
    const request = (n, by, title, deptName, lines, reason, neededIn = 14) => step(() => P.createRequest({ title, department_id: dept(deptName), needed_by: M.addDays(day(n), neededIn), reason, lines, user: by, demo: 1, at: at(n, 8) }));
    const decide = (pr, who, decision, n, note = null) => step(() => A.decide(pr.approval_id, who, decision, note, { at: at(n, 12) }));
    const order = (pr, vendorName, n, deliverIn, lines, { send = true, terms = null, deptName = null } = {}) => step(() => {
      if (!vendor[vendorName]) return null;
      const o = P.createOrder({
        vendor_id: vendor[vendorName], request_id: pr ? pr.id : null, department_id: pr ? pr.department_id : dept(deptName), order_date: day(n), delivery_date: M.addDays(day(n), deliverIn),
        terms: terms || 'Prices include delivery to site. Goods are inspected on receipt; anything damaged or not as ordered is returned at the supplier\'s cost. Quote the order number on the delivery note and the invoice.',
        payment_days: 30, deliver_to: 'The Wave Mall · goods receiving, service yard B1', vat_pct: 14, lines, status: send ? 'sent' : 'draft', user: manager, demo: 1,
      });
      db.run('UPDATE pur_orders SET created_at = ?, updated_at = ?, sent_at = ? WHERE id = ?', at(n, 11), at(n, 11), send ? at(n, 11) : null, o.id);
      return o;
    });
    const lineIds = (o) => db.all('SELECT * FROM pur_order_lines WHERE order_id = ? ORDER BY sort, id', o.id);
    const receive = (o, n, qtys, note) => step(() => {
      const ls = lineIds(o);
      const r = P.receive(o.id, { date: day(n), delivery_note: `DN-${4100 + o.id * 7 + n}`, note, lines: Object.fromEntries(ls.map((l, i) => [l.id, qtys[i] ?? l.qty])), user: manager, demo: 1 });
      db.run('UPDATE pur_receipts SET created_at = ? WHERE id = ?', at(n, 13), r.id);
      return r;
    });
    const bill = (o, n, prices, { approve = false, pay = false, qtys = null } = {}) => step(() => {
      const st = P.lineState(o.id);
      const out = P.billOrder(o.id, { vendor_ref: `INV-${String(7300 + o.id * 13).padStart(5, '0')}`, date: day(n), lines: st.map((l, i) => ({ order_line_id: l.id, qty: qtys ? qtys[i] : l.received - l.billed, price: prices && prices[i] !== undefined ? prices[i] : l.price })), approve, user: boss, demo: 1 });
      if (pay && L) {
        const b = db.get('SELECT * FROM acc_bills WHERE id = ?', out.bill.id);
        L.payBill(b.id, { amount: b.total, date: M.addDays(day(n), 20) > T ? T : M.addDays(day(n), 20), account: 'bank_clearing', reference: String(880100 + b.id), user: boss, demo: 1 });
      }
      return out;
    });

    // 1. lighting spares: approved in two steps, ordered, delivered, billed and paid
    const pr1 = request(62, salma, 'Lighting spares for the food court and the mall street', 'Facilities & maintenance',
      [line('EL-0101', 40, 620), line('EL-0102', 60, 180), line('EL-0110', 12, 400)], 'Monthly replacement rate is up since the summer; the store is below the minimum on panels.');
    if (pr1) {
      decide(pr1, manager, 'approved', 61, 'Agreed, the food court is a priority.');
      decide(pr1, boss, 'approved', 60);
      const o1 = order(pr1, 'El Sewedy Electric Supplies', 59, 12, [line('EL-0101', 40, 620), line('EL-0102', 60, 180), line('EL-0110', 12, 400)].map((l) => ({ ...l, price: l.est_price })));
      if (o1) {
        receive(o1, 48, [], 'All boxes checked, no damage.');
        bill(o1, 46, null, { approve: true, pay: true });
      }
    }
    // 2. AHU filters and refrigerant: partly delivered, now late, billed at a higher price than ordered
    const pr2 = request(38, omar, 'AHU filters and refrigerant for the quarterly service', 'Facilities & maintenance',
      [line('HV-0301', 120, 415), line('HV-0305', 40, 510)], 'Quarterly filter change on all twelve air handling units.');
    if (pr2) {
      decide(pr2, manager, 'approved', 37);
      decide(pr2, boss, 'approved', 36, 'Approved. Please ask for the price to be held for the next quarter.');
      const o2 = order(pr2, 'Delta HVAC Parts', 35, 14, [line('HV-0301', 120, 415), line('HV-0305', 40, 510)].map((l) => ({ ...l, price: l.est_price })));
      if (o2) {
        receive(o2, 24, [60, 40], 'First batch of filters; the rest promised next week.');
        bill(o2, 22, [440, 510]);
      }
    }
    // 3. cleaning supplies: received in full, billed (to approve in accounting)
    const pr3 = request(22, salma, 'Housekeeping consumables for the month', 'Housekeeping',
      [line('CL-0401', 400, 41), line('CL-0402', 200, 54), line('CL-0410', 150, 47)], 'Monthly consumables.');
    if (pr3) {
      decide(pr3, manager, 'approved', 21);
      decide(pr3, boss, 'approved', 21);
      const o3 = order(pr3, 'Nile Cleaning Solutions', 20, 7, [line('CL-0401', 400, 41), line('CL-0402', 200, 54), line('CL-0410', 150, 47)].map((l) => ({ ...l, price: l.est_price })));
      if (o3) {
        receive(o3, 13, [], null);
        bill(o3, 12, null);
      }
    }
    // 4. safety equipment: the manager approved, finance has not decided yet
    const pr4 = request(6, omar, 'Fire extinguishers and exit lights for the new cinema wing', 'Security',
      [line('SF-0501', 14, 1850), line('SF-0505', 18, 960)], 'Civil defence inspection on the new wing is due next month.', 21);
    if (pr4) decide(pr4, manager, 'approved', 5, 'Needed for the civil defence visit.');
    // 5. plumbing: under the approval amount, approved at once and waiting for an order
    request(3, salma, 'Flush valves for the ground floor washrooms', 'Facilities & maintenance', [line('PL-0201', 6, 1350)], 'Two valves leaking; keep a stock of spares.', 7);
    // 6. not approved
    const pr6 = request(27, omar, 'Branded umbrellas for the customer service desk', 'Customer service',
      [{ description: 'Golf umbrella with The Wave logo', qty: 300, unit: 'pcs', est_price: 240 }], 'Lending umbrellas on rainy days.');
    if (pr6) decide(pr6, manager, 'rejected', 26, 'Not this season; the marketing fund covers giveaways in spring.');
    // 7. withdrawn by the person who asked
    const pr7 = request(16, salma, 'Spare escalator handrail', 'Facilities & maintenance', [{ description: 'Escalator handrail, 32 m, OEM', qty: 1, unit: 'set', est_price: 185000 }], 'Handrail on escalator 3 is worn.');
    if (pr7) step(() => A.withdraw(pr7.approval_id, salma, 'Covered by the lift contractor under warranty.'));
    // 8. a sent order still to come, and a draft
    order(null, 'TechNet Systems', 4, 10, [{ ...line('IT-0601', 305, 13.5), price: 13.5 }, { ...line('IT-0610', 4, 2150), price: 2150 }], { deptName: 'IT' });
    order(null, 'Pyramids Plumbing Supplies', 1, 14, [{ ...line('PL-0205', 4, 2900), price: 2900 }, { description: 'Pressure reducing valve 1"', qty: 2, unit: 'pcs', price: 1650, account: 'exp_maintenance' }], { send: false, deptName: 'Facilities & maintenance' });

    // ---------- parts issued, an adjustment ----------
    const wos = has(db, 'work_orders') ? db.all('SELECT id, category FROM work_orders ORDER BY id DESC LIMIT 12') : [];
    const wo = (cat, k = 0) => (wos.filter((w) => w.category === cat)[k] || wos[k % Math.max(1, wos.length)] || {}).id || null;
    const issue = (code, qty, n, { woId = null, deptName = null, note = null } = {}) => step(() => P.issue({ item_id: item[code], qty, work_order_id: woId, department_id: woId ? null : dept(deptName), date: day(n), reason: note, user: manager, demo: 1 }));
    issue('EL-0101', 8, 52, { woId: wo('electrical') });
    issue('EL-0102', 14, 44, { woId: wo('electrical', 1) });
    issue('EL-0110', 3, 30, { woId: wo('electrical') });
    issue('EL-0120', 85, 18, { woId: wo('electrical', 1), note: 'New circuit for the kiosk at the plaza' });
    issue('EL-0101', 52, 9, { deptName: 'Facilities & maintenance', note: 'Food court relamping, phase 1' });
    issue('HV-0301', 64, 20, { woId: wo('hvac'), note: 'Quarterly filter change, AHU 1–6' });
    issue('HV-0305', 14, 15, { woId: wo('hvac', 1) });
    issue('HV-0310', 4, 11, { woId: wo('hvac') });
    issue('PL-0201', 2, 6, { woId: wo('plumbing') });
    issue('CL-0401', 290, 25, { deptName: 'Housekeeping' });
    issue('CL-0402', 170, 10, { deptName: 'Housekeeping' });
    issue('CL-0410', 120, 8, { deptName: 'Housekeeping' });
    issue('SF-0505', 2, 12, { deptName: 'Security', note: 'Car park level B2' });
    issue('IT-0601', 160, 28, { deptName: 'IT', note: 'CCTV cameras at the north gate' });
    issue('IT-0610', 2, 14, { deptName: 'Security' });
    step(() => P.move({ item_id: item['CL-0402'], kind: 'adjust', qty: -6, date: day(5), reason: 'Damaged · two cartons split in the store', user: manager, demo: 1 }));
    step(() => P.move({ item_id: item['EL-0120'], kind: 'adjust', qty: 12, unit_cost: 38, date: day(40), reason: 'Stock count · reel measured', user: manager, demo: 1 }));

    // ---------- other approvals ----------
    const emp = has(db, 'employees') ? db.get("SELECT * FROM employees WHERE demo = 1 AND status = 'active' AND name = 'Mahmoud Adel'") || db.get("SELECT * FROM employees WHERE demo = 1 AND status = 'active' ORDER BY id LIMIT 1") : null;
    if (emp) {
      const amount = 24000;
      step(() => A.request({
        kind: 'advance', title: `Salary advance for ${emp.name}`, amount, entity: 'employee', entity_id: emp.id, link: `/admin/hr/employees/${emp.id}`,
        payload: { employee_id: emp.id, employee_name: emp.name, amount, installments: 6, start_period: M.addMonths(`${T.slice(0, 7)}-01`, 1).slice(0, 7), issued_on: T, method: 'transfer', reason: 'Family wedding' },
        note: 'Family wedding', user: boss, demo: 1, at: at(1, 10),
      }));
    }
    const chairs = step(() => A.request({ kind: 'other', title: 'Replace 40 food court chairs', amount: 96000, note: 'Twelve chairs are broken and the rest are worn; quote from Hub Furniture attached to the email.', user: salma, demo: 1, at: at(9, 10) }));
    if (chairs) step(() => A.decide(chairs.id, manager, 'approved', 'Go ahead, before the holiday season.', { at: at(8, 15) }));
    const event = step(() => A.request({ kind: 'other', title: 'Sponsor the school robotics fair in the atrium', amount: 150000, note: 'Three-day event, good footfall, but outside the marketing plan.', user: omar, demo: 1, at: at(19, 11) }));
    if (event) {
      step(() => db.run("INSERT INTO apr_events (request_id, action, step, note, user_id, at) VALUES (?, 'comment', 0, ?, ?, ?)", event.id, 'Do we have the visitor numbers from last year?', manager.id, at(18, 10)));
      step(() => A.decide(event.id, manager, 'rejected', 'Not in this year\'s plan; bring it to the marketing budget review.', { at: at(17, 16) }));
    }
    const late = step(() => A.request({ kind: 'other', title: 'Overtime for the stock count weekend', amount: 18500, note: 'Six people, two days.', user: salma, demo: 1, at: at(2, 9) }));
    if (late) step(() => db.run("INSERT INTO apr_events (request_id, action, step, note, user_id, at) VALUES (?, 'comment', 0, ?, ?, ?)", late.id, 'Includes the security team on the loading bay.', salma.id, at(2, 11)));
  });
}

function clear(db) {
  if (!has(db, 'inv_items')) return;
  db.tx(() => {
    if (has(db, 'acc_bills')) {
      db.run("DELETE FROM acc_bill_payments WHERE bill_id IN (SELECT id FROM acc_bills WHERE source = 'purchase' AND demo = 1)");
      db.run("DELETE FROM acc_bill_lines WHERE bill_id IN (SELECT id FROM acc_bills WHERE source = 'purchase' AND demo = 1)");
      db.run("DELETE FROM acc_bills WHERE source = 'purchase' AND demo = 1");
    }
    db.run('DELETE FROM pur_bills WHERE demo = 1 OR order_id IN (SELECT id FROM pur_orders WHERE demo = 1)');
    db.run('DELETE FROM inv_moves WHERE demo = 1 OR item_id IN (SELECT id FROM inv_items WHERE demo = 1)');
    db.run('DELETE FROM pur_receipts WHERE demo = 1 OR order_id IN (SELECT id FROM pur_orders WHERE demo = 1)');
    db.run('DELETE FROM pur_orders WHERE demo = 1');
    db.run('DELETE FROM pur_requests WHERE demo = 1');
    db.run('DELETE FROM inv_items WHERE demo = 1 AND id NOT IN (SELECT item_id FROM inv_moves)');
    db.run('DELETE FROM apr_requests WHERE demo = 1');
    db.run('DELETE FROM apr_rules WHERE demo = 1');
  });
}

module.exports = { load, clear };
