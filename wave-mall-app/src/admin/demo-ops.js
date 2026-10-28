'use strict';

// Sample data for the operations modules: short-term spaces with a month of bookings (some
// invoiced and paid through billing), the mall's plant and equipment with preventive plans and
// a few weeks of work orders (tenant requests, late jobs, costs), and 90 days of hourly footfall
// and parking for a new Cairo mall (an opening ramp-up, Thursday nights, Friday after prayers,
// busy Saturdays). Text is stored in English and shown in Arabic through tx() (i18n/ar-ops.js).
// Every row carries demo = 1.

const M = require('./model');
const specialty = require('./routes/specialty');
const maintenance = require('./routes/maintenance');
const footfall = require('./routes/footfall');
const { cairo } = require('./ops-common');

const DAY = 86400000;
const has = (db, t) => !!db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t);
// a repeatable random series, so the sample looks the same on every load
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- short-term spaces ----------
// [code, name, type, level, location, m², power, water, day, week, month, weekend %, min days, deposit, notes]
const SPACES = [
  ['K-01', 'Plaza kiosk by the fountain', 'kiosk', 'Plaza', 'Central court, beside the fountain', 9, 1, 0, 1800, 10500, 36000, 15, 3, 10000, 'Open 10:00 to midnight. Branding within the kiosk frame only.'],
  ['K-02', 'North entrance kiosk', 'kiosk', 'Plaza', 'North entrance, inside the doors', 8, 1, 0, 1500, 9000, 30000, 15, 3, 10000, null],
  ['K-03', 'Food court bridge kiosk', 'kiosk', 'Level 1', 'Bridge to the food court', 8, 1, 1, 1400, 8400, 28000, 10, 3, 10000, 'Water point for drinks and desserts.'],
  ['P-01', 'Court pop-up unit', 'popup', 'Plaza', 'Central court, east side', 42, 1, 0, 4500, 28000, 95000, 15, 7, 25000, 'Glass box with lighting and storage. Fit-out by the customer within mall guidelines.'],
  ['P-02', 'Terrace walk pop-up unit', 'popup', 'Plaza', 'Terrace walk, by the cafés', 36, 1, 1, 3800, 23000, 80000, 15, 7, 25000, null],
  ['A-01', 'Central court activation area', 'promo', 'Plaza', 'Central court, under the skylight', 120, 1, 0, 12000, 70000, null, 20, 1, 30000, 'Up to 120 m². Stage, sound and screens can be booked with it.'],
  ['A-02', 'North entrance activation area', 'promo', 'Plaza', 'North entrance forecourt', 60, 1, 0, 7000, 42000, null, 20, 1, 20000, null],
  ['E-01', 'The court stage', 'event', 'Plaza', 'Central court', 200, 1, 1, 25000, 140000, null, 25, 1, 50000, 'Stage, sound, lighting and 300 seats. Rehearsal the evening before.'],
  ['D-01', 'LED screen, main entrance', 'screen', 'Plaza', 'Main entrance facade, facing North 90 Street', null, 1, 0, 3000, 18000, 60000, 0, 7, 0, 'Prices are for the whole loop. Each advertiser books a share of the loop.'],
  ['D-02', 'Digital totems, food court', 'screen', 'Level 1', 'Six totems around the food court', null, 1, 0, 1200, 7000, 24000, 0, 7, 0, null],
  ['B-01', 'Billboard face, North 90 Street', 'billboard', 'Outdoor', 'Street facade, westbound traffic', null, 0, 0, null, null, 120000, 0, 30, 0, null],
  ['C-01', 'Car display, main entrance plaza', 'car', 'Plaza', 'Main entrance plaza, under the canopy', 40, 1, 0, 6000, 35000, 110000, 10, 7, 30000, 'Up to two cars. Vehicles move in and out after closing.'],
  ['M-01', 'ATM spot, parking lobby', 'atm', 'Basement', 'Parking lobby, by the lifts', 3, 1, 0, null, null, 18000, 0, 30, 15000, null],
];
// [space, customer (brand name or company), start, days, status, extra]
const BOOKINGS = [
  ['K-01', 'Habibi Gelato', -40, 30, 'completed', { paid: true }],
  ['K-01', 'Kiko Juice Bar', -8, 21, 'live', { paid: true }],
  ['K-01', 'Bloom Florals', 16, 7, 'held', { holdIn: 4, purpose: 'Flowers for the White Friday weekend' }],
  ['K-02', 'Oud & Amber', -20, 14, 'completed', { paid: true, purpose: 'Fragrance sampling kiosk' }],
  ['K-02', 'Desert Rose Perfumery', 5, 10, 'confirmed', { depositPaid: true, purpose: 'Winter fragrance launch' }],
  ['K-03', 'Kiko Juice Bar', 20, 30, 'enquiry', { purpose: 'Fresh juice kiosk for the winter' }],
  ['P-01', 'Azure Swim', -25, 14, 'completed', { paid: true, purpose: 'End of summer sale pop-up' }],
  ['P-01', 'Petit Pas Kids', 2, 21, 'confirmed', { purpose: 'Back to school pop-up', discount: 12, reason: 'Three-week booking, first pop-up with us', approved: true }],
  ['P-02', 'Marble & Brass', -3, 14, 'live', { paid: true, purpose: 'Home accessories pop-up' }],
  ['P-02', 'The Linen Room', 28, 14, 'enquiry', { purpose: 'Winter bedding pop-up', discount: 25, reason: 'Matches their offer from another mall', needsApproval: true }],
  ['A-01', 'Aurora Motors', -12, 3, 'completed', { paid: true, purpose: 'New SUV launch weekend' }],
  ['A-01', 'Nile Crest Bank', 9, 2, 'confirmed', { purpose: 'Credit card sign-up drive' }],
  ['A-02', 'Cedar Fitness', 12, 2, 'held', { holdIn: 1, purpose: 'Free fitness classes and body scans' }],
  ['E-01', 'Kidzone Events', -6, 2, 'completed', { paid: true, purpose: 'Children\'s theatre, two shows a day' }],
  ['E-01', 'Cairo Jazz Collective', 23, 1, 'confirmed', { purpose: 'Evening jazz concert', discount: 8, reason: 'Community event, the mall shares the ticket income', approved: true }],
  ['E-01', 'Kidzone Events', 37, 2, 'cancelled', { reason2: 'The customer moved the show to the spring' }],
  ['D-01', 'Aurora Motors', -15, 30, 'live', { share: 40, paid: true, purpose: 'New SUV launch campaign' }],
  ['D-01', 'Nile Crest Bank', -4, 28, 'live', { share: 30, paid: false, purpose: 'Credit card campaign' }],
  ['D-01', 'Desert Rose Perfumery', 5, 14, 'confirmed', { share: 20, purpose: 'Winter fragrance launch' }],
  ['D-02', 'Saffron Table', -18, 14, 'completed', { share: 50, paid: true, purpose: 'New menu' }],
  ['D-02', 'Kahwa House', 3, 28, 'confirmed', { share: 50, purpose: 'Winter drinks' }],
  ['B-01', 'Aurora Motors', -30, 60, 'live', { paid: true, purpose: 'Brand campaign facing North 90 Street' }],
  ['C-01', 'Aurora Motors', -14, 21, 'live', { paid: true, purpose: 'Two cars on display with test drives' }],
  ['M-01', 'Nile Crest Bank', -60, 180, 'live', { paid: true, purpose: 'ATM in the parking lobby' }],
];
const PEAKS = [['White Friday weekend', 26, 29, 25], ['Winter holidays', 52, 71, 20]];
const CUSTOMERS = {
  'Aurora Motors': ['+20 2 2555 0141', 'marketing@auroramotors.example'],
  'Nile Crest Bank': ['+20 2 2555 0177', 'branding@nilecrest.example'],
  'Kidzone Events': ['+20 100 555 0123', 'hello@kidzone.example'],
  'Cairo Jazz Collective': ['+20 122 555 0164', null],
};

function loadSpecialty(db, admin, bill) {
  specialty.ensure(db);
  const T = M.today();
  const now = new Date().toISOString();
  const day = (n) => M.addDays(T, n);
  const peaks = PEAKS.map(([name, a, b, pct]) => ({ name, start_date: day(a), end_date: day(b), pct }));
  db.tx(() => {
    for (const p of peaks) db.run('INSERT INTO space_peaks (name, start_date, end_date, pct, demo, created_at) VALUES (?, ?, ?, ?, 1, ?)', p.name, p.start_date, p.end_date, p.pct, now);
    SPACES.forEach(([code, name, type, level, location, size, power, water, d, w, m, we, min, deposit, notes], i) => {
      if (db.get('SELECT id FROM spaces WHERE code = ?', code)) return;
      db.run(`INSERT INTO spaces (code, name, type, level, location, size_m2, power, water, rate_day, rate_week, rate_month, weekend_pct, min_days, deposit, notes, sort, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, code, name, type, level, location, size, power, water, d, w, m, we, min, deposit, notes, i + 1, now, now);
    });
  });
  const user = db.get("SELECT id FROM users WHERE role = 'agent' AND email LIKE '%@demo.thewave.local' ORDER BY id LIMIT 1") || admin || null;
  const manager = db.get("SELECT id FROM users WHERE role = 'manager' AND email LIKE '%@demo.thewave.local' ORDER BY id LIMIT 1") || admin || null;
  for (const [code, who, start, days, status, x] of BOOKINGS) {
    const s = db.get('SELECT * FROM spaces WHERE code = ? AND demo = 1', code);
    if (!s) continue;
    const a = day(start);
    const b = day(start + days - 1);
    const q = specialty.quote(s, a, b, { peaks, share: x.share || 100 });
    if (q.error) continue;
    const price = x.discount ? Math.round(q.total * (1 - x.discount / 100) / 100) * 100 : q.total;
    const brand = db.get('SELECT id FROM brands WHERE name = ? ORDER BY demo DESC, id DESC LIMIT 1', who);
    const [phone, email] = CUSTOMERS[who] || [null, null];
    const created = new Date(Date.now() + (Math.min(start, 0) - 10) * DAY).toISOString();
    db.tx(() => {
      const id = Number(db.run(
        `INSERT INTO space_bookings (ref, space_id, brand_id, customer, phone, email, purpose, start_date, end_date, days, share_pct, list_price, price, override_reason, deposit, status, hold_until,
         needs_approval, approved_by, approved_at, cancel_reason, created_by, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        db.nextRef('space_bookings', 'SB', 4, true), s.id, brand ? brand.id : null, brand ? null : who, phone, email, x.purpose || null, a, b, q.days, q.share, q.total, price,
        price !== q.total ? x.reason : null, s.deposit, status, status === 'held' ? day(x.holdIn || 3) : null,
        x.needsApproval || x.approved ? 1 : 0, x.approved && manager ? manager.id : null, x.approved ? created : null, status === 'cancelled' ? x.reason2 : null, user ? user.id : null, created, created,
      ).lastInsertRowid);
      if (!bill || !['confirmed', 'live', 'completed'].includes(status)) return;
      const party = brand ? { brand_id: brand.id } : { customer: who };
      const inv = bill.createInvoice({ ...party, kind: 'specialty', period_start: a, period_end: b, due_date: a, other: price, note: `Short-term space ${code}, ${a} to ${b}`, source: 'space_booking', source_id: id, demo: 1 }, { user: admin });
      const dep = s.deposit ? bill.createInvoice({ ...party, kind: 'deposit', due_date: a < T ? a : T, other: s.deposit, note: `Space deposit ${code}`, source: 'space_booking', source_id: id, demo: 1 }, { user: admin }) : null;
      db.run('UPDATE space_bookings SET invoice_id = ?, deposit_invoice_id = ? WHERE id = ?', inv.id, dep ? dep.id : null, id);
      const paidOn = a < T ? a : T;
      if (x.paid) bill.recordPayment({ invoice_id: inv.id, amount: inv.total, date: paidOn, method: 'transfer', reference: `TRF ${id}${start < 0 ? 7 : 3}1`, demo: 1 }, { user: admin });
      if (dep && (x.paid || x.depositPaid)) bill.recordPayment({ invoice_id: dep.id, amount: dep.total, date: paidOn, method: 'transfer', demo: 1 }, { user: admin });
    });
  }
}

// ---------- maintenance ----------
// [code, name, category, location, make, model, installed (days ago), warranty (days from today), contract title, criticality]
const ASSETS = [
  ['H-101', 'Chiller 1', 'hvac', 'Roof plant area', 'Carrier', '30-1002', 400, 330, 'MEP maintenance', 'high'],
  ['H-102', 'Chiller 2', 'hvac', 'Roof plant area', 'Carrier', '30-1002', 400, 330, 'MEP maintenance', 'high'],
  ['H-103', 'Cooling tower', 'hvac', 'Roof plant area', 'Baltimore', '3000', 400, 330, 'MEP maintenance', 'high'],
  ['H-111', 'Air handling unit, central court', 'hvac', 'Roof, above the court', 'Daikin', '2040', 380, 350, 'MEP maintenance', 'high'],
  ['H-112', 'Air handling unit, food court', 'hvac', 'Roof, above the food court', 'Daikin', '2040', 380, 350, 'MEP maintenance', 'high'],
  ['H-113', 'Air handling unit, north mall', 'hvac', 'Roof, north', 'Daikin', '1630', 380, 350, 'MEP maintenance', 'medium'],
  ['H-121', 'Kitchen exhaust fans, food court', 'hvac', 'Roof, food court', 'Systemair', '750', 360, 5, 'MEP maintenance', 'medium'],
  ['E-201', 'Main switchboard', 'electrical', 'Main electrical room, basement', 'Schneider Electric', '6300', 420, 310, 'MEP maintenance', 'high'],
  ['E-202', 'Standby generator 1', 'electrical', 'Generator room, basement', 'Cummins', '1500', 420, 310, 'MEP maintenance', 'high'],
  ['E-203', 'Standby generator 2', 'electrical', 'Generator room, basement', 'Cummins', '1500', 420, 310, 'MEP maintenance', 'high'],
  ['E-204', 'UPS for the control room', 'electrical', 'Control room', 'Schneider Electric', '60', 390, -20, null, 'medium'],
  ['E-211', 'Court lighting control', 'electrical', 'Central court', 'Schneider Electric', '400', 380, 345, 'MEP maintenance', 'low'],
  ['P-301', 'Domestic water booster set', 'plumbing', 'Pump room, basement', 'Grundfos', '1200', 410, 320, 'MEP maintenance', 'high'],
  ['P-302', 'Fire pump set', 'plumbing', 'Pump room, basement', 'Grundfos', '2500', 410, 320, 'MEP maintenance', 'high'],
  ['P-303', 'Sewage ejector pumps', 'plumbing', 'Basement, east', 'Grundfos', '400', 410, 320, 'MEP maintenance', 'medium'],
  ['P-304', 'Grease separator, food court', 'plumbing', 'Basement, under the food court', 'ACO', '20', 400, 45, null, 'medium'],
  ['L-401', 'Passenger lift 1', 'lifts', 'North core', 'Otis', '2000', 395, 700, 'Lifts and escalators maintenance', 'high'],
  ['L-402', 'Passenger lift 2', 'lifts', 'North core', 'Otis', '2000', 395, 700, 'Lifts and escalators maintenance', 'high'],
  ['L-403', 'Panoramic lift, central court', 'lifts', 'Central court', 'Otis', '2000', 395, 700, 'Lifts and escalators maintenance', 'high'],
  ['L-404', 'Parking lift', 'lifts', 'Parking lobby', 'Otis', '1600', 395, 700, 'Lifts and escalators maintenance', 'medium'],
  ['L-411', 'Escalator 1, court up', 'lifts', 'Central court', 'Otis', '513', 395, 700, 'Lifts and escalators maintenance', 'high'],
  ['L-412', 'Escalator 2, court down', 'lifts', 'Central court', 'Otis', '513', 395, 700, 'Lifts and escalators maintenance', 'high'],
  ['L-413', 'Escalator 3, food court up', 'lifts', 'Food court', 'Otis', '513', 395, 700, 'Lifts and escalators maintenance', 'medium'],
  ['F-501', 'Fire alarm panel', 'security', 'Control room', 'Honeywell', '3000', 400, 330, 'Security guarding for the mall', 'high'],
  ['F-502', 'CCTV recorders', 'security', 'Control room', 'Hikvision', '9632', 400, 330, 'Security guarding for the mall', 'high'],
  ['F-503', 'Parking barriers and ticket machines', 'security', 'Parking entrance', 'Hikvision', '2200', 380, 320, null, 'medium'],
  ['I-601', 'Mall Wi-Fi core switch', 'it', 'Server room', 'Cisco', '9300', 360, 305, 'Wi-Fi and building network', 'medium'],
  ['I-602', 'People counters', 'it', 'Entrances', 'Xovis', '3000', 100, 630, 'Wi-Fi and building network', 'low'],
  ['C-701', 'Skylight, central court', 'civil', 'Roof, central court', 'Schüco', '50', 420, 1400, null, 'medium'],
  ['C-702', 'Automatic doors, north entrance', 'civil', 'North entrance', 'Dorma', '20', 400, 310, null, 'medium'],
];
// [asset code, title, every n, unit, first due (days from today, before the history), checklist, priority]
const PLANS = [
  ['H-101', 'Monthly chiller service', 1, 'month', -88, 'Check refrigerant pressures\nCheck oil level and compressor amps\nClean condenser coils\nLog leaving water temperatures', 3],
  ['H-102', 'Monthly chiller service', 1, 'month', -80, 'Check refrigerant pressures\nCheck oil level and compressor amps\nClean condenser coils\nLog leaving water temperatures', 3],
  ['H-103', 'Cooling tower water treatment', 2, 'week', -84, 'Test water and dose chemicals\nClean the basin strainer\nCheck the fan belts', 3],
  ['H-111', 'Air handling unit filters', 1, 'month', -75, 'Replace pre-filters\nCheck bag filters\nCheck belt tension\nClean the drain pan', 4],
  ['H-112', 'Air handling unit filters', 1, 'month', -70, 'Replace pre-filters\nCheck bag filters\nCheck belt tension\nClean the drain pan', 4],
  ['H-113', 'Air handling unit filters', 1, 'month', -65, 'Replace pre-filters\nCheck bag filters\nCheck belt tension\nClean the drain pan', 4],
  ['H-121', 'Kitchen exhaust duct cleaning', 3, 'month', -60, 'Degrease the ducts and hoods\nCheck the fire dampers\nPhotograph before and after', 3],
  ['E-201', 'Thermal scan of the switchboards', 3, 'month', -50, 'Thermal camera scan of all boards\nTighten hot connections\nReport findings', 3],
  ['E-202', 'Generator test run', 1, 'week', -89, 'Run on load for 30 minutes\nCheck fuel, oil and coolant\nLog voltage and frequency', 3],
  ['E-203', 'Generator test run', 1, 'week', -86, 'Run on load for 30 minutes\nCheck fuel, oil and coolant\nLog voltage and frequency', 3],
  ['P-301', 'Booster pumps inspection', 1, 'month', -72, 'Check pressures and vibration\nCheck the pressure vessel\nInspect for leaks', 4],
  ['P-302', 'Weekly fire pump churn test', 1, 'week', -88, 'Run the jockey, electric and diesel pumps\nLog pressures\nCheck the diesel fuel level', 2],
  ['P-304', 'Grease separator emptying', 2, 'week', -85, 'Empty and clean the separator\nKeep the waste transfer note', 3],
  ['L-401', 'Lift monthly service', 1, 'month', -78, 'Check doors and safety edges\nTest the alarm and intercom\nCheck the ride quality', 3],
  ['L-403', 'Lift monthly service', 1, 'month', -74, 'Check doors and safety edges\nTest the alarm and intercom\nCheck the ride quality', 3],
  ['L-411', 'Escalator monthly service', 1, 'month', -77, 'Check comb plates and step gaps\nTest the emergency stops\nClean and lubricate the chains', 3],
  ['L-412', 'Escalator monthly service', 1, 'month', -76, 'Check comb plates and step gaps\nTest the emergency stops\nClean and lubricate the chains', 3],
  ['F-501', 'Fire alarm weekly test', 1, 'week', -87, 'Test one call point per zone\nCheck the panel for faults\nLog the test', 2],
  ['F-502', 'CCTV health check', 1, 'month', -66, 'Check every camera view\nCheck recording days kept\nClean the dome covers', 4],
  ['C-701', 'Skylight cleaning and inspection', 3, 'month', -40, 'Clean the glass\nCheck seals and drainage', 4],
  ['C-702', 'Automatic doors service', 3, 'month', -45, 'Check sensors and safety beams\nAdjust the speed\nLubricate the tracks', 4],
];
// reactive work orders: [title, category, priority, source, asset code | null, unit code | null, location, brand, raised (days ago), status, details]
const ORDERS = [
  ['No cold air in the shop since this morning', 'hvac', 2, 'tenant', null, 'G01', 'Sales floor, back half', 'Maison Lune', 0.2, 'new', { body: 'The air conditioning blows warm air since we opened. Customers are complaining.' }],
  ['Water dripping from the ceiling near the fitting rooms', 'plumbing', 2, 'tenant', null, 'G01', 'Fitting rooms', 'Maison Lune', 3, 'resolved', { fixHours: 5, cost: [['parts', 850, 'Cairo Plumbing Supplies', 'Pipe coupling and sealant']], rating: 5, ratingNote: 'Quick and clean, thank you.' }],
  ['Extraction fan noisy in the kitchen', 'hvac', 3, 'tenant', 'H-121', 'G04', 'Kitchen', 'Kahwa House', 2, 'in_progress', { assignee: 1, comment: 'Bearing worn. Spare ordered, fitting tomorrow morning before opening.' }],
  ['Shop sign lights flicker in the evening', 'electrical', 3, 'tenant', null, 'S02', 'Shop front', 'Lumière Beauty', 6, 'closed', { fixHours: 30, cost: [['labour', 600, null, 'Electrician, two hours']], rating: 4 }],
  ['Grease smell at the back door', 'plumbing', 2, 'tenant', 'P-304', 'G12', 'Service corridor', 'Saffron Table', 1.5, 'on_hold', { assignee: 1, comment: 'Waiting for the waste contractor to empty the separator tonight.', late: true }],
  ['Back door does not lock', 'civil', 2, 'tenant', null, 'G04', 'Service door', 'Kahwa House', 9, 'resolved', { fixHours: 50, cost: [['parts', 1450, 'Delta Hardware', 'New lock body and cylinder']] }],
  ['Panoramic lift stuck at level 1', 'lifts', 1, 'staff', 'L-403', null, 'Central court', null, 0.06, 'assigned', { contractor: 'Atlas Lifts & Escalators' }],
  ['Escalator 2 stopped, step chain alarm', 'lifts', 1, 'staff', 'L-412', null, 'Central court', null, 0.4, 'in_progress', { contractor: 'Atlas Lifts & Escalators', late: true, comment: 'Technician on site. Step chain sensor misaligned.' }],
  ['Toilets by the cinema: two taps leaking', 'plumbing', 3, 'staff', null, null, 'Level 1, toilets by the cinema', null, 1, 'assigned', { assignee: 2 }],
  ['Court lights: six spotlights out', 'electrical', 4, 'staff', 'E-211', null, 'Central court', null, 5, 'in_progress', { assignee: 2, cost: [['parts', 2400, 'Cairo Electrical Supplies', 'Six LED spotlights']] }],
  ['UPS alarm in the control room', 'electrical', 2, 'staff', 'E-204', null, 'Control room', null, 4, 'resolved', { fixHours: 31, cost: [['contractor', 7800, 'PowerCare Egypt', 'Battery string replacement (out of warranty)'], ['labour', 400, null, 'Standby electrician']] }],
  ['Parking barrier not lifting at exit 2', 'security', 2, 'staff', 'F-503', null, 'Parking exit 2', null, 2.2, 'new', { late: true }],
  ['Chiller 2 tripped on high pressure', 'hvac', 1, 'staff', 'H-102', null, 'Roof plant area', null, 12, 'closed', { fixHours: 3, contractor: 'Meridian MEP', cost: [['contractor', 5200, 'Meridian MEP', 'Emergency call-out outside the contract hours']] }],
  ['Wi-Fi drops in the food court', 'it', 3, 'staff', 'I-601', null, 'Food court', null, 7, 'resolved', { fixHours: 80, contractor: 'Orbit Networks' }],
  ['Cracked floor tile at the north entrance', 'civil', 3, 'staff', null, null, 'North entrance', null, 15, 'closed', { fixHours: 60, cost: [['parts', 1100, 'Delta Hardware', 'Porcelain tiles and adhesive'], ['labour', 500, null, 'Tiler, half a day']] }],
  ['Automatic door slow to open', 'civil', 4, 'staff', 'C-702', null, 'North entrance', null, 20, 'closed', { fixHours: 100 }],
  ['Fire alarm fault on zone 7', 'security', 1, 'staff', 'F-501', null, 'Level 1, east', null, 25, 'closed', { fixHours: 6, contractor: 'Sentinel Guard Services' }],
  ['Water pressure low on level 1', 'plumbing', 2, 'staff', 'P-301', null, 'Level 1', null, 18, 'reopened', { comment: 'Pressure dropped again in the evening. Checking the pressure vessel.', late: true }],
  ['Bin area needs deep cleaning', 'cleaning', 4, 'staff', null, null, 'Loading bay', null, 3, 'resolved', { fixHours: 26 }],
  ['Escalator 3 handrail torn', 'lifts', 3, 'staff', 'L-413', null, 'Food court', null, 30, 'closed', { fixHours: 70, contractor: 'Atlas Lifts & Escalators' }],
];

function loadMaintenance(db, admin, h) {
  maintenance.ensure(db);
  const T = M.today();
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const day = (n) => M.addDays(T, n);
  const r = rng(7);
  const users = db.all("SELECT id, name FROM users WHERE email LIKE '%@demo.thewave.local' ORDER BY id");
  const userAt = (i) => (users.length ? users[i % users.length].id : admin ? admin.id : null);
  const contract = (title) => (title && has(db, 'contracts') ? db.get('SELECT id, counterparty FROM contracts WHERE title = ? ORDER BY demo DESC, id DESC LIMIT 1', title) : null);
  const contractBy = (party) => (party && has(db, 'contracts') ? db.get('SELECT id FROM contracts WHERE counterparty = ? ORDER BY demo DESC LIMIT 1', party) : null);
  const unit = (code) => (code ? db.get('SELECT id FROM units WHERE code = ?', code) : null);
  const sla = (() => {
    let v = {};
    try { v = JSON.parse(db.setting('maintenance_sla') || '{}'); } catch { v = {}; }
    return (p) => (Array.isArray(v[p]) ? v[p] : maintenance.SLA_DEFAULT[p]);
  })();
  const ev = (wo, kind, at, x = {}) => db.run('INSERT INTO wo_events (wo_id, kind, body, status_from, status_to, minutes, cost_type, amount, vendor, date, shared, user_id, portal_user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    wo, kind, x.body || null, x.from || null, x.to || null, x.minutes || null, x.cost_type || null, x.amount ?? null, x.vendor || null, x.date || null, x.shared ? 1 : 0, x.user ?? null, x.portal ?? null, iso(at));
  const costs = [];

  db.tx(() => {
    const now = iso(nowMs);
    for (const [code, name, category, location, make, model, installed, warranty, ctitle, crit] of ASSETS) {
      if (db.get('SELECT id FROM assets WHERE code = ?', code)) continue;
      const c = contract(ctitle);
      db.run(`INSERT INTO assets (code, name, category, location, level, make, model, serial, install_date, warranty_until, contract_id, criticality, status, demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_service', 1, ?, ?)`, code, name, category, location, null, make, model, `${4100 + Math.floor(r() * 5800)}-${String(Math.floor(r() * 9000) + 1000)}`,
      day(-installed), day(warranty), c ? c.id : null, crit, now, now);
    }

    // preventive plans, with three months of history
    for (const [code, title, n, unitName, first, checklist, priority] of PLANS) {
      const a = db.get('SELECT * FROM assets WHERE code = ? AND demo = 1', code);
      if (!a) continue;
      const pid = Number(db.run('INSERT INTO ppm_plans (title, asset_id, category, priority, every_n, every_unit, checklist, next_due, assignee_id, contractor, active, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
        title, a.id, a.category, priority, n, unitName, checklist, day(first), a.contract_id ? null : userAt(1), a.contract_id ? db.value('SELECT counterparty FROM contracts WHERE id = ?', a.contract_id) : null, iso(nowMs - 100 * DAY), now).lastInsertRowid);
      // five weeks of history
      let due = day(Math.max(first, -35));
      let lastDone = null;
      while (due < T) {
        const dueMs = Date.parse(`${due}T08:00:00Z`);
        const roll = r();
        // most on the day, some a day or two late, a few missed
        const done = roll < 0.07 ? null : dueMs + (roll < 0.82 ? -2 * 3600000 + r() * 6 * 3600000 : (1 + Math.floor(r() * 3)) * DAY);
        const end = `${due}T20:00:00.000Z`;
        // a visit missed long ago is closed when the next one is done
        const missed = !done && M.daysBetween(due, T) > 14;
        const status = done && done < nowMs ? (done < nowMs - 3 * DAY ? 'closed' : 'resolved') : missed ? 'closed' : (M.daysBetween(due, T) > 6 ? 'on_hold' : 'assigned');
        const id = Number(db.run(`INSERT INTO work_orders (ref, title, description, category, priority, source, status, asset_id, location, assignee_id, contractor, contract_id, ppm_id, due_date, checklist,
          response_due, resolve_due, responded_at, resolved_at, closed_at, cost_labour, minutes, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ppm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          db.nextRef('work_orders', 'WO', 4, true), title, 'Planned preventive maintenance', a.category, priority, status, a.id, a.location, a.contract_id ? null : userAt(1),
          a.contract_id ? db.value('SELECT counterparty FROM contracts WHERE id = ?', a.contract_id) : null, a.contract_id, pid, due, checklist, end, end,
          iso(dueMs - 7 * DAY + 3600000), done && done < nowMs ? iso(done) : null, status === 'closed' ? iso(done ? done + DAY : dueMs + 14 * DAY) : null, 0, done ? 60 + Math.floor(r() * 4) * 30 : 0,
          iso(dueMs - 7 * DAY), iso(Math.min(nowMs, done && done < nowMs ? done : dueMs))).lastInsertRowid);
        ev(id, 'status', dueMs - 7 * DAY + 3600000, { from: 'new', to: 'assigned', shared: 1 });
        if (done && done < nowMs) {
          ev(id, 'time', done - 1800000, { minutes: 60 + Math.floor(r() * 4) * 30, user: userAt(1) });
          ev(id, 'status', done, { from: 'assigned', to: 'resolved', user: userAt(1), shared: 1, body: 'Checklist completed' });
          if (status === 'closed') ev(id, 'status', done + DAY, { from: 'resolved', to: 'closed', user: userAt(0), shared: 1 });
          lastDone = due;
        } else if (missed) ev(id, 'status', dueMs + 14 * DAY, { from: 'assigned', to: 'closed', user: userAt(0), shared: 1, body: 'Not done: covered by the next visit' });
        else if (status === 'on_hold') ev(id, 'status', dueMs + DAY, { from: 'assigned', to: 'on_hold', user: userAt(1), shared: 1, body: 'Waiting for parts' });
        due = maintenance.nextDue(due, n, unitName);
      }
      db.run('UPDATE ppm_plans SET next_due = ?, last_done = ? WHERE id = ?', due, lastDone, pid);
    }

    // reactive work orders
    const portal = has(db, 'portal_users');
    for (const [title, category, priority, source, assetCode, unitCode, location, brandName, daysAgo, status, x] of ORDERS) {
      const a = assetCode ? db.get('SELECT * FROM assets WHERE code = ? AND demo = 1', assetCode) : null;
      const u = unit(unitCode);
      const brand = brandName ? db.get('SELECT id FROM brands WHERE name = ? ORDER BY demo DESC, id DESC LIMIT 1', brandName) : null;
      const pu = portal && brand ? db.get('SELECT id, name FROM portal_users WHERE brand_id = ? ORDER BY id LIMIT 1', brand.id) : null;
      const created = nowMs - daysAgo * DAY;
      const [resp, fix] = sla(priority);
      // late ones: past their targets; others: on time
      const responded = status === 'new' ? null : created + (x.late ? resp * 3600000 * 1.6 : resp * 3600000 * 0.4);
      const resolved = ['resolved', 'closed'].includes(status) ? created + (x.fixHours || fix * 0.6) * 3600000 : null;
      const closed = status === 'closed' ? (resolved || created) + DAY : null;
      const c = x.contractor ? contractBy(x.contractor) : null;
      const assignee = x.assignee !== undefined ? userAt(x.assignee) : null;
      const id = Number(db.run(`INSERT INTO work_orders (ref, title, description, category, priority, source, status, asset_id, unit_id, location, brand_id, reported_by, portal_user_id, assignee_id, contractor, contract_id,
        response_due, resolve_due, responded_at, resolved_at, closed_at, reopened, rating, rating_note, created_by, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        db.nextRef('work_orders', 'WO', 4, true), title, x.body || null, category, priority, source, status, a ? a.id : null, u ? u.id : null, location, brand ? brand.id : null,
        null, pu ? pu.id : null, assignee, x.contractor || null, c ? c.id : (a ? a.contract_id : null),
        iso(created + resp * 3600000), iso(created + fix * 3600000), responded ? iso(Math.min(responded, nowMs)) : null, resolved ? iso(Math.min(resolved, nowMs - 3600000)) : null, closed ? iso(Math.min(closed, nowMs)) : null,
        status === 'reopened' ? 1 : 0, x.rating || null, x.ratingNote || null, source === 'staff' ? userAt(0) : null, iso(created), iso(Math.min(nowMs, (resolved || responded || created) + 60000))).lastInsertRowid);
      if (assignee || x.contractor) ev(id, 'assignment', Math.min(responded || created, nowMs), { body: assignee ? users.find((v) => v.id === assignee)?.name : x.contractor, user: userAt(0) });
      if (responded && !['new'].includes(status)) ev(id, 'status', Math.min(responded, nowMs), { from: 'new', to: status === 'assigned' ? 'assigned' : 'in_progress', user: userAt(0), shared: 1 });
      if (x.comment) ev(id, 'comment', Math.min(nowMs - 600000, (responded || created) + 1800000), { body: x.comment, user: assignee || userAt(1), shared: source === 'tenant' ? 1 : 0 });
      if (status === 'on_hold') ev(id, 'status', Math.min(nowMs - 300000, (responded || created) + 3600000), { from: 'in_progress', to: 'on_hold', user: assignee || userAt(1), shared: 1 });
      if (resolved) ev(id, 'status', Math.min(resolved, nowMs - 3600000), { from: 'in_progress', to: 'resolved', user: assignee || userAt(1), shared: 1 });
      if (closed) ev(id, 'status', Math.min(closed, nowMs), { from: 'resolved', to: 'closed', user: userAt(0), shared: 1 });
      if (status === 'reopened') {
        ev(id, 'status', created + 2 * DAY, { from: 'in_progress', to: 'resolved', user: userAt(1), shared: 1 });
        ev(id, 'status', created + 4 * DAY, { from: 'resolved', to: 'reopened', user: userAt(0), shared: 1 });
      }
      if (x.rating) ev(id, 'rating', Math.min(nowMs, (resolved || created) + 5 * 3600000), { minutes: x.rating, body: x.ratingNote || null, portal: pu ? pu.id : null, shared: 1 });
      if (source === 'tenant' && pu && ['in_progress', 'on_hold'].includes(status)) ev(id, 'comment', Math.min(nowMs - 120000, created + 2 * 3600000), { body: 'Thank you. Please come before 11:00 if you can.', portal: pu.id, shared: 1 });
      for (const [type, amount, vendor, memo] of x.cost || []) {
        const col = { labour: 'cost_labour', parts: 'cost_parts', contractor: 'cost_contractor' }[type];
        const at = Math.min(nowMs - 1800000, (resolved || responded || created) - 3600000);
        db.run(`UPDATE work_orders SET ${col} = ${col} + ? WHERE id = ?`, amount, id);
        ev(id, 'cost', at, { cost_type: type, amount, vendor, date: iso(at).slice(0, 10), body: memo, user: assignee || userAt(1) });
        costs.push({ id, at, type, amount, vendor, memo, title });
      }
      if (['resolved', 'closed', 'in_progress'].includes(status)) ev(id, 'time', Math.min(nowMs - 900000, (resolved || responded || created) - 600000), { minutes: 30 + Math.floor(r() * 6) * 15, user: assignee || userAt(1) });
    }
  });

  // costs reach the accounts the same way as from the work order page
  if (h && h.events) {
    for (const c of costs) {
      const eventId = db.value("SELECT id FROM wo_events WHERE wo_id = ? AND kind = 'cost' AND amount = ? ORDER BY id DESC LIMIT 1", c.id, c.amount);
      const ref = db.value('SELECT ref FROM work_orders WHERE id = ?', c.id);
      h.events.emit('expense.incurred', { date: new Date(c.at).toISOString().slice(0, 10), amount: c.amount, vendor: c.vendor || 'Maintenance supplier', category: 'maintenance', source: 'work_order', source_id: eventId, memo: `${ref} · ${c.title}${c.memo ? ` · ${c.memo}` : ''} (${c.type})`, work_order_id: c.id, demo: 1 });
    }
  }
  // the week ahead's preventive work orders
  maintenance.generatePpm(db, { today: T });
  db.run("UPDATE work_orders SET demo = 1 WHERE ppm_id IN (SELECT id FROM ppm_plans WHERE demo = 1)");
}

// ---------- footfall ----------
const DOORS = [['N1', 'North entrance', 'entrance', 0.38], ['S1', 'Parking entrance', 'entrance', 0.30], ['E1', 'Terrace entrance', 'entrance', 0.19], ['W1', 'Street entrance', 'entrance', 0.13]];
// share of a day's visitors in each hour (10:00 to 01:00), by kind of day
const SHAPE = {
  weekday: { 10: 2, 11: 3, 12: 4.5, 13: 6, 14: 6.5, 15: 6, 16: 6, 17: 7, 18: 8.5, 19: 10, 20: 11, 21: 10.5, 22: 8, 23: 5.5, 0: 2.5, 1: 0.6 },
  thursday: { 10: 1.6, 11: 2.4, 12: 3.6, 13: 5, 14: 5.5, 15: 5.3, 16: 5.8, 17: 7, 18: 8.5, 19: 10, 20: 11.5, 21: 11.5, 22: 9.5, 23: 7, 0: 4, 1: 1.5 },
  friday: { 10: 0.5, 11: 0.7, 12: 0.9, 13: 2.5, 14: 6, 15: 7.5, 16: 8, 17: 8.5, 18: 9.5, 19: 10.5, 20: 11, 21: 10.5, 22: 8.5, 23: 6, 0: 3.5, 1: 1.2 },
  saturday: { 10: 1.8, 11: 3, 12: 4.5, 13: 6, 14: 7, 15: 7.2, 16: 7.5, 17: 8, 18: 8.8, 19: 9.5, 20: 10, 21: 9.5, 22: 7.5, 23: 5.5, 0: 2.5, 1: 0.7 },
};
const DAY_TOTAL = { weekday: 13500, thursday: 19000, friday: 24500, saturday: 22500 };
const CAPACITY = 1200;

function loadFootfall(db) {
  footfall.ensure(db);
  const r = rng(42);
  const c = cairo();
  const now = new Date().toISOString();
  const doors = [];
  db.tx(() => {
    DOORS.forEach(([code, name, kind], i) => {
      if (!db.get('SELECT id FROM footfall_entrances WHERE code = ?', code)) db.run('INSERT INTO footfall_entrances (code, name, kind, sort, demo, created_at) VALUES (?, ?, ?, ?, 1, ?)', code, name, kind, i + 1, now);
      doors.push(code);
    });
    if (!db.setting('parking_capacity')) {
      db.setSetting('parking_capacity', String(CAPACITY));
      db.setSetting('demo_parking_capacity', '1');
    }
    const insF = 'INSERT INTO footfall (ts_hour, entrance, visitors_in, visitors_out, source, demo, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(ts_hour, entrance) DO NOTHING';
    const insP = 'INSERT INTO parking (ts_hour, entries, exits, occupancy, capacity, source, demo, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(ts_hour) DO NOTHING';
    let occ = 0;
    for (let back = 90; back >= 0; back--) {
      const d = M.addDays(c.date, -back);
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      const kind = dow === 4 ? 'thursday' : dow === 5 ? 'friday' : dow === 6 ? 'saturday' : 'weekday';
      // the opening ramp-up: the mall opened 90 days ago, a grand-opening weekend, then growth
      const age = 90 - back;
      const ramp = age < 3 ? 1.35 : Math.min(1, 0.58 + age * 0.016);
      // paydays and the last week of the month
      const dom = Number(d.slice(8));
      const pay = dom >= 25 || dom <= 2 ? 1.08 : 1;
      const total = DAY_TOTAL[kind] * ramp * pay * (0.92 + r() * 0.16);
      const shape = SHAPE[kind];
      const sum = Object.values(shape).reduce((s, v) => s + v, 0);
      occ = Math.round(occ * 0.1);
      for (const hr of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1]) {
        // hours after midnight belong to the next calendar day
        const date = hr < 10 ? M.addDays(d, 1) : d;
        if (date > c.date || (date === c.date && hr >= c.hour)) continue;
        const key = `${date}T${String(hr).padStart(2, '0')}`;
        const visitors = total * (shape[hr] / sum) * (0.9 + r() * 0.2);
        const prevShare = hr === 10 ? 0 : shape[hr === 0 ? 23 : hr === 1 ? 0 : hr - 1] / sum;
        for (let i = 0; i < doors.length; i++) {
          // the parking entrance is busier in the evening, the street entrance at lunch
          const tilt = doors[i] === 'S1' ? (hr >= 18 || hr <= 1 ? 1.12 : 0.9) : doors[i] === 'W1' ? (hr >= 12 && hr <= 15 ? 1.2 : 0.95) : 1;
          const vin = Math.max(0, Math.round(visitors * DOORS[i][3] * tilt * (0.92 + r() * 0.16)));
          const vout = Math.max(0, Math.round(total * prevShare * DOORS[i][3] * (0.9 + r() * 0.2) * (hr === 1 ? 2.2 : 1)));
          if (vin || vout) db.run(insF, key, doors[i], vin, vout, back > 7 ? 'csv' : 'api', now);
        }
        // cars: about one car for every 2.6 visitors coming by car (half of them), stays about 2.3 hours
        const entries = Math.round(visitors * 0.5 / 2.6 * (0.9 + r() * 0.2));
        const leave = hr === 1 ? occ : Math.round(occ / 2.3);
        occ = Math.max(0, Math.min(CAPACITY, occ + entries - leave));
        db.run(insP, key, entries, leave, occ, CAPACITY, back > 7 ? 'csv' : 'api', now);
      }
    }
    // what the import history looks like
    const span = (a, b) => [`${M.addDays(c.date, -a)}T10`, `${M.addDays(c.date, -b)}T01`];
    const imp = (kind, via, file, rows, ins, upd, unch, skip, [fh, lh], ago) => db.run('INSERT INTO footfall_imports (kind, via, status, file_name, rows, inserted, updated, unchanged, skipped, first_hour, last_hour, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
      kind, via, 'done', file, rows, ins, upd, unch, skip, fh, lh, null, new Date(Date.now() - ago * 3600000).toISOString());
    imp('footfall', 'csv', 'عدادات-الزوار-الربع-الثالث.CSV', 5312, 5308, 0, 0, 4, span(90, 8), 7 * 24);
    imp('parking', 'csv', 'مواقف-السيارات-الربع-الثالث.CSV', 1328, 1328, 0, 0, 0, span(90, 8), 7 * 24 - 1);
    imp('footfall', 'csv', 'عدادات-الزوار-الربع-الثالث.CSV', 5312, 0, 2, 5306, 4, span(90, 8), 6 * 24);
    for (let k = 6; k >= 1; k--) imp('both', 'api', null, 5, 5, 0, 0, 0, [`${c.date}T${String(Math.max(10, c.hour - k)).padStart(2, '0')}`, `${c.date}T${String(Math.max(10, c.hour - k)).padStart(2, '0')}`], k);
  });
}

function load(db, admin, opts = {}) {
  if (db.value("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'spaces'") && db.value('SELECT COUNT(*) FROM spaces WHERE demo = 1')) return;
  const bill = opts.billing || (opts.h && opts.h.billing) || null;
  loadSpecialty(db, admin, bill);
  loadMaintenance(db, admin, opts.h);
  loadFootfall(db);
}

function clear(db) {
  db.tx(() => {
    if (has(db, 'space_bookings')) {
      db.run('DELETE FROM space_bookings WHERE demo = 1 OR space_id IN (SELECT id FROM spaces WHERE demo = 1)');
      db.run('DELETE FROM spaces WHERE demo = 1');
      db.run('DELETE FROM space_peaks WHERE demo = 1');
    }
    if (has(db, 'work_orders')) {
      db.run('DELETE FROM wo_events WHERE demo = 1 OR wo_id IN (SELECT id FROM work_orders WHERE demo = 1)');
      db.run('DELETE FROM work_orders WHERE demo = 1');
      db.run('UPDATE work_orders SET ppm_id = NULL WHERE ppm_id IN (SELECT id FROM ppm_plans WHERE demo = 1)');
      db.run('DELETE FROM ppm_plans WHERE demo = 1');
      db.run('UPDATE work_orders SET asset_id = NULL WHERE asset_id IN (SELECT id FROM assets WHERE demo = 1)');
      db.run('DELETE FROM assets WHERE demo = 1');
    }
    if (has(db, 'footfall')) {
      db.run('DELETE FROM footfall WHERE demo = 1');
      db.run('DELETE FROM parking WHERE demo = 1');
      db.run('DELETE FROM footfall_imports WHERE demo = 1');
      db.run('DELETE FROM footfall_entrances WHERE demo = 1 AND code NOT IN (SELECT DISTINCT entrance FROM footfall)');
      if (db.setting('demo_parking_capacity') === '1') {
        db.setSetting('parking_capacity', '');
        db.setSetting('demo_parking_capacity', '');
      }
    }
  });
}

module.exports = { load, clear };
