'use strict';

// Security and cleaning (/admin/security): the guards' patrols, the cleaners' rounds, and the
// security office's books for the whole mall.
//
//   Patrols     checkpoints (a QR sticker each) and routes (checkpoints in order, a round every N
//               minutes during set hours). A guard scans each sticker with the phone: the first scan
//               starts a round, the last one closes it. Each day shows the rounds done, the rounds
//               missed and the checkpoints skipped or reached late, per guard and per shift.
//   Cleaning    areas (toilets, food court, entrances…) cleaned every N minutes during set hours.
//               The cleaner scans the area's QR and marks it cleaned, with a photo; a supervisor
//               checks it. Areas past their time show as overdue; each day gets a cleaning score.
//               Other modules raise cleaning alerts on an area (shopper feedback about cleanliness).
//   Incidents   mall-wide (security, safety, medical, theft, damage, fire alarm), with a timeline,
//               the people involved, the CCTV reference, photos and a status.
//   Lost & found, keys (issued and returned, with when they are due back) and the shift handover log.
// Times are stored in UTC and shown in Cairo time; the schedules are Cairo clock times.

const crypto = require('node:crypto');
const { t: tr, tn } = require('../i18n');
const { tmap, registerDocs, uploadRoute } = require('../ops-common');
const { cairoToUtc } = require('../parking/shell');
const QR = require('../qr');

const SCHEMA = `
  CREATE TABLE sec_checkpoints (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, place TEXT, token TEXT NOT NULL UNIQUE,
    sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE sec_routes (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, checkpoints TEXT NOT NULL DEFAULT '[]', every_min INTEGER NOT NULL DEFAULT 120,
    window_min INTEGER NOT NULL DEFAULT 45, start_hm TEXT NOT NULL DEFAULT '00:00', end_hm TEXT NOT NULL DEFAULT '24:00',
    active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE sec_rounds (
    id INTEGER PRIMARY KEY, route_id INTEGER NOT NULL REFERENCES sec_routes(id) ON DELETE CASCADE, slot_at TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, guard_name TEXT, status TEXT NOT NULL DEFAULT 'open',
    started_at TEXT NOT NULL, finished_at TEXT, note TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sec_rounds_day ON sec_rounds(started_at);
  CREATE TABLE sec_scans (
    id INTEGER PRIMARY KEY, round_id INTEGER REFERENCES sec_rounds(id) ON DELETE CASCADE, checkpoint_id INTEGER NOT NULL REFERENCES sec_checkpoints(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, guard_name TEXT, at TEXT NOT NULL, late INTEGER NOT NULL DEFAULT 0, note TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sec_scans_round ON sec_scans(round_id);
  CREATE TABLE sec_clean_areas (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, place TEXT, kind TEXT NOT NULL DEFAULT 'other',
    every_min INTEGER NOT NULL DEFAULT 60, start_hm TEXT NOT NULL DEFAULT '10:00', end_hm TEXT NOT NULL DEFAULT '24:00',
    token TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE sec_clean_logs (
    id INTEGER PRIMARY KEY, area_id INTEGER NOT NULL REFERENCES sec_clean_areas(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cleaner_name TEXT, at TEXT NOT NULL, note TEXT, check_status TEXT NOT NULL DEFAULT 'pending', checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    checked_at TEXT, check_note TEXT, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sec_clean_logs_area ON sec_clean_logs(area_id, at);
  CREATE TABLE sec_clean_alerts (
    id INTEGER PRIMARY KEY, area_id INTEGER REFERENCES sec_clean_areas(id) ON DELETE CASCADE, place TEXT, source TEXT NOT NULL DEFAULT 'staff',
    source_id INTEGER, note TEXT, created_at TEXT NOT NULL, resolved_at TEXT, resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sec_incidents (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium', title TEXT NOT NULL,
    place TEXT, at TEXT NOT NULL, description TEXT, people TEXT, cctv_ref TEXT, police_ref TEXT, status TEXT NOT NULL DEFAULT 'open',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL, outcome TEXT, resolved_at TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE sec_incident_notes (
    id INTEGER PRIMARY KEY, incident_id INTEGER NOT NULL REFERENCES sec_incidents(id) ON DELETE CASCADE, body TEXT, status_to TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, at TEXT NOT NULL
  );
  CREATE TABLE sec_lost (
    id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, item TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', description TEXT,
    found_at TEXT NOT NULL, found_where TEXT, found_by TEXT, stored_at TEXT, status TEXT NOT NULL DEFAULT 'held',
    owner_contact TEXT, returned_to TEXT, returned_id TEXT, returned_at TEXT, returned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE sec_keys (
    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'key', opens TEXT NOT NULL, place TEXT,
    copies INTEGER NOT NULL DEFAULT 1, kept_at TEXT, note TEXT, active INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE sec_key_loans (
    id INTEGER PRIMARY KEY, key_id INTEGER NOT NULL REFERENCES sec_keys(id) ON DELETE CASCADE, issued_to TEXT NOT NULL, company TEXT,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, purpose TEXT, issued_at TEXT NOT NULL, due_at TEXT NOT NULL,
    returned_at TEXT, issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL, returned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sec_handover (
    id INTEGER PRIMARY KEY, shift TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, to_name TEXT,
    summary TEXT NOT NULL, open_items TEXT, at TEXT NOT NULL, ack_by INTEGER REFERENCES users(id) ON DELETE SET NULL, ack_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0
  );
`;

const SHIFTS = { morning: ['sec|Morning (7:00–15:00)', 420, 900], evening: ['sec|Evening (15:00–23:00)', 900, 1380], night: ['sec|Night (23:00–7:00)', 1380, 420] };
const AREA_KINDS = {
  toilets: 'sec|Toilets', food_court: 'sec|Food court', entrance: 'sec|Entrance', corridor: 'sec|Corridor', prayer: 'sec|Prayer room',
  parking: 'sec|Car park', outdoor: 'sec|Outdoor and plaza', lifts: 'sec|Lifts and escalators', other: 'sec|Other',
};
const I_KINDS = { security: 'sec|Security', safety: 'sec|Safety', medical: 'sec|Medical', theft: 'sec|Theft', damage: 'sec|Damage', fire_alarm: 'sec|Fire alarm', other: 'sec|Other' };
const SEVERITY = { low: ['sec|Low', 'mute'], medium: ['sec|Medium', 'amber'], high: ['sec|High', 'rose'], critical: ['sec|Critical', 'rose'] };
const I_STATUS = { open: ['sec|Open', 'sky'], investigating: ['sec|Investigating', 'amber'], resolved: ['sec|Resolved', 'ok'], closed: ['sec|Closed', 'mute'] };
const L_CATS = {
  phone: 'sec|Phone', wallet: 'sec|Wallet or purse', bag: 'sec|Bag', keys: 'sec|Keys', jewellery: 'sec|Jewellery or watch',
  documents: 'sec|ID or papers', clothing: 'sec|Clothing', child: 'sec|Child’s item', other: 'sec|Other',
};
const L_STATUS = { held: ['sec|Kept', 'sky'], returned: ['sec|Returned', 'ok'], disposed: ['sec|Donated or disposed', 'mute'] };
const K_KINDS = { key: 'sec|Key', master: 'sec|Master key', card: 'sec|Access card' };
const CHECK = { pending: ['sec|To check', 'amber'], ok: ['sec|Checked', 'ok'], redo: ['sec|Redo', 'rose'] };
const R_STATUS = { open: ['sec|In progress', 'sky'], done: ['sec|Complete', 'ok'], incomplete: ['sec|Incomplete', 'rose'] };
// a round that starts more than this after its slot is late
const GRACE_MIN = 15;

module.exports = function security(router, h) {
  const { db, ui, M } = h;
  const R = h.auth.requireRole;
  db.ensure('security-1', SCHEMA);
  const esc = ui.esc;
  const now = () => new Date().toISOString();
  const token = () => crypto.randomBytes(9).toString('base64url');
  const site = (req) => String((h.env && h.env.SITE_URL) || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const badge = (map, k) => ui.badge(k, tr((map[k] || [k])[0]), (map[k] || [])[1]);
  const userName = (id) => (id ? db.value('SELECT name FROM users WHERE id = ?', id) : null);

  // ---------- Cairo clock ----------
  const hmMin = (hm) => { const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Math.min(1440, Number(m[1]) * 60 + Number(m[2])) : null; };
  const hmOk = (v, fb) => (hmMin(v) !== null ? String(v).padStart(5, '0') : fb);
  const localDay = (iso = now()) => ui.local(iso).slice(0, 10);
  const localMin = (iso = now()) => { const l = ui.local(iso); return Number(l.slice(11, 13)) * 60 + Number(l.slice(14, 16)); };
  // a Cairo day and minute of that day (may run past midnight) as a UTC moment
  const atLocal = (day, min) => {
    const d = M.addDays(day, Math.floor(min / 1440));
    const m = ((min % 1440) + 1440) % 1440;
    return cairoToUtc(d, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, ui);
  };
  const dayRange = (day) => [atLocal(day, 0), atLocal(day, 1440)];
  const shiftOf = (iso) => { const m = localMin(iso); return m >= 420 && m < 900 ? 'morning' : m >= 900 && m < 1380 ? 'evening' : 'night'; };
  const fromLocal = (v) => {
    const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
    return m ? cairoToUtc(m[1], `${m[2]}:${m[3]}`, ui) : now();
  };
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const span = (a, b) => `${a}–${b}`;
  const mins = (n) => (n >= 60 && n % 60 === 0 ? tn(n / 60, 'sec|every hour', 'sec|every {n} hours') : tr('sec|every {n} minutes', { n }));

  // ---------- documents ----------
  registerDocs(M, 'sec_round', 'sec|Patrol round', { patrol_photo: 'sec|Photo' });
  registerDocs(M, 'sec_clean', 'sec|Cleaning', { clean_photo: 'sec|Photo' });
  registerDocs(M, 'sec_incident', 'sec|Incident', { incident_photo: 'sec|Photo', incident_cctv: 'sec|CCTV still or clip', incident_report: 'sec|Report or statement' });
  registerDocs(M, 'sec_lost', 'sec|Lost item', { lost_photo: 'sec|Photo', lost_receipt: 'sec|Signed receipt' });
  const anyone = { canUpload: (req) => !!req.user };
  const roundDocs = uploadRoute(router, h, '/security/rounds/upload', { sec_round: 'sec_rounds' }, anyone);
  const cleanDocs = uploadRoute(router, h, '/security/cleaning/upload', { sec_clean: 'sec_clean_logs' }, anyone);
  const incDocs = uploadRoute(router, h, '/security/incidents/upload', { sec_incident: 'sec_incidents' });
  const lostDocs = uploadRoute(router, h, '/security/lost/upload', { sec_lost: 'sec_lost' });

  // what people type here, for the Arabic audit
  (h.auditTyped = h.auditTyped || []).push(
    'SELECT code, name, place FROM sec_checkpoints', 'SELECT name FROM sec_routes', 'SELECT guard_name, note FROM sec_rounds', 'SELECT guard_name, note FROM sec_scans',
    'SELECT code, name, place FROM sec_clean_areas', 'SELECT cleaner_name, note, check_note FROM sec_clean_logs', 'SELECT place, note FROM sec_clean_alerts',
    'SELECT ref, title, place, description, people, cctv_ref, police_ref, outcome FROM sec_incidents', 'SELECT body FROM sec_incident_notes',
    'SELECT ref, item, description, found_where, found_by, stored_at, owner_contact, returned_to, returned_id FROM sec_lost',
    'SELECT code, opens, place, kept_at, note FROM sec_keys', 'SELECT issued_to, company, purpose FROM sec_key_loans', 'SELECT to_name, summary, open_items FROM sec_handover',
  );

  // ================= patrols: the schedule =================
  const routes = () => db.all('SELECT * FROM sec_routes WHERE active = 1 ORDER BY name');
  const cpsOf = (route) => { try { return JSON.parse(route.checkpoints || '[]').map(Number).filter(Boolean); } catch { return []; } };
  const cpMap = () => new Map(db.all('SELECT * FROM sec_checkpoints').map((c) => [c.id, c]));
  // the slots of a route on a Cairo day: [utc start, …]
  function slotsOf(route, day) {
    const a = hmMin(route.start_hm) ?? 0;
    let b = hmMin(route.end_hm) ?? 1440;
    if (b <= a) b += 1440;
    const out = [];
    for (let m = a; m < b; m += Math.max(15, route.every_min)) out.push(atLocal(day, m));
    return out;
  }
  // the slot a round starting at t belongs to (today's or yesterday's, for routes past midnight)
  function slotFor(route, t) {
    const day = localDay(t);
    const all = [...slotsOf(route, M.addDays(day, -1)), ...slotsOf(route, day)];
    const ms = Date.parse(t);
    const hit = all.filter((s) => Date.parse(s) <= ms && ms < Date.parse(s) + route.every_min * 60000).pop();
    return hit || null;
  }
  // rounds past their time limit are closed as incomplete
  function settle() {
    const n = Date.now();
    for (const r of db.all("SELECT r.id, r.started_at, t.window_min FROM sec_rounds r JOIN sec_routes t ON t.id = r.route_id WHERE r.status = 'open'")) {
      const end = Date.parse(r.started_at) + r.window_min * 60000;
      if (end < n) db.run("UPDATE sec_rounds SET status = 'incomplete', finished_at = ? WHERE id = ? AND status = 'open'", new Date(end).toISOString(), r.id);
    }
  }
  const scansOf = (roundId) => db.all('SELECT * FROM sec_scans WHERE round_id = ? ORDER BY at', roundId);
  // a Cairo day of patrols: per route, its slots and what was done in each
  function patrolDay(day) {
    settle();
    const [a, b] = dayRange(day);
    const t = Date.now();
    const out = { day, expected: 0, scanned: 0, late: 0, missedRounds: 0, lateRounds: 0, rounds: 0, routes: [] };
    for (const route of routes()) {
      const cps = cpsOf(route);
      const rounds = db.all('SELECT r.*, u.name user_name FROM sec_rounds r LEFT JOIN users u ON u.id = r.user_id WHERE r.route_id = ? AND r.started_at >= ? AND r.started_at < ? ORDER BY r.started_at', route.id, a, b);
      const slots = slotsOf(route, day).filter((s) => Date.parse(s) < Date.parse(b) + 86400000).map((s) => {
        const mine = rounds.filter((r) => r.slot_at === s);
        const scans = mine.flatMap((r) => scansOf(r.id));
        const got = new Set(scans.map((x) => x.checkpoint_id).filter((id) => cps.includes(id)));
        const due = Date.parse(s) + route.window_min * 60000 <= t;
        const started = Date.parse(s) <= t;
        return { at: s, rounds: mine, due, started, got: got.size, late: scans.filter((x) => x.late).length, lateStart: mine.some((r) => Date.parse(r.started_at) > Date.parse(s) + GRACE_MIN * 60000) };
      }).filter((s) => s.started);
      const counted = slots.filter((s) => s.due || s.rounds.length);
      const r = {
        route, cps, slots, rounds,
        expected: counted.length * cps.length, scanned: counted.reduce((x, s) => x + s.got, 0),
        missed: slots.filter((s) => s.due && !s.rounds.length).length, lateRounds: slots.filter((s) => s.lateStart).length,
        late: slots.reduce((x, s) => x + s.late, 0),
      };
      out.routes.push(r);
      out.expected += r.expected; out.scanned += r.scanned; out.missedRounds += r.missed; out.lateRounds += r.lateRounds; out.late += r.late; out.rounds += rounds.length;
    }
    out.pct = out.expected ? out.scanned / out.expected : null;
    return out;
  }

  // ---- scanning a checkpoint ----
  function startRound(route, { user = null, guard = null, at = now(), demo = 0 } = {}) {
    return Number(db.run("INSERT INTO sec_rounds (route_id, slot_at, user_id, guard_name, status, started_at, demo) VALUES (?, ?, ?, ?, 'open', ?, ?)",
      route.id, slotFor(route, at), user ? user.id : null, guard || (user ? user.name : null), at, demo ? 1 : 0).lastInsertRowid);
  }
  // record a scan; finds (or starts) the guard's round on a route through this checkpoint
  function scan(cp, { user = null, guard = null, routeId = null, note = null, at = now(), demo = 0 } = {}) {
    settle();
    const through = routes().filter((r) => cpsOf(r).includes(cp.id));
    const who = guard || (user ? user.name : null);
    const open = db.all("SELECT r.* FROM sec_rounds r WHERE r.status = 'open' AND (r.user_id IS ? OR r.guard_name IS ?) ORDER BY r.started_at DESC", user ? user.id : null, who)
      .filter((r) => through.some((t) => t.id === r.route_id) && (!routeId || r.route_id === routeId) && !scansOf(r.id).some((s) => s.checkpoint_id === cp.id));
    let round = open[0] || null;
    if (!round) {
      const route = through.find((t) => t.id === routeId) || (through.length === 1 ? through[0] : null) || through[0] || null;
      if (route) round = db.get('SELECT * FROM sec_rounds WHERE id = ?', startRound(route, { user, guard: who, at, demo }));
    }
    const route = round ? db.get('SELECT * FROM sec_routes WHERE id = ?', round.route_id) : null;
    const late = round && Date.parse(at) > Date.parse(round.started_at) + route.window_min * 60000 ? 1 : 0;
    const id = Number(db.run('INSERT INTO sec_scans (round_id, checkpoint_id, user_id, guard_name, at, late, note, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      round ? round.id : null, cp.id, user ? user.id : null, who, at, late, note, demo ? 1 : 0).lastInsertRowid);
    if (round) {
      const got = new Set(scansOf(round.id).map((s) => s.checkpoint_id));
      if (cpsOf(route).every((c) => got.has(c))) db.run("UPDATE sec_rounds SET status = 'done', finished_at = ? WHERE id = ?", at, round.id);
    }
    return { id, round: round ? db.get('SELECT * FROM sec_rounds WHERE id = ?', round.id) : null, route };
  }

  // ================= cleaning =================
  // an area's state now: closed (outside its hours), alert, overdue, due (soon) or ok
  function areaState(a, t = now()) {
    const day = localDay(t);
    const open = hmMin(a.start_hm) ?? 0;
    let close = hmMin(a.end_hm) ?? 1440;
    if (close <= open) close += 1440;
    let m = localMin(t);
    if (m < open && close > 1440 && m + 1440 < close) m += 1440;
    const opened = atLocal(m >= 1440 ? M.addDays(day, -1) : day, open);
    const last = db.get("SELECT * FROM sec_clean_logs WHERE area_id = ? AND check_status != 'redo' ORDER BY at DESC LIMIT 1", a.id);
    const alert = db.value('SELECT COUNT(*) FROM sec_clean_alerts WHERE area_id = ? AND resolved_at IS NULL', a.id);
    const inHours = m >= open && m < close;
    // a clean shortly before opening (or before midnight, for an area open all day) still counts
    const from = last && Date.parse(last.at) > Date.parse(opened) - a.every_min * 60000 ? last.at : opened;
    const dueAt = new Date(Date.parse(from) + a.every_min * 60000).toISOString();
    const left = (Date.parse(dueAt) - Date.parse(t)) / 60000;
    const state = alert ? 'alert' : !inHours ? 'closed' : left < 0 ? 'overdue' : left <= 15 ? 'due' : 'ok';
    return { state, last, dueAt, late: left < 0 ? Math.round(-left) : 0, alert };
  }
  const A_STATE = { alert: ['sec|Alert', 'rose'], overdue: ['sec|Overdue', 'rose'], due: ['sec|Due now', 'amber'], ok: ['sec|Clean', 'ok'], closed: ['sec|Outside hours', 'mute'] };
  // a Cairo day's cleaning score: cleans done (not sent back) against cleans scheduled, per area
  function cleanDay(day) {
    const [a, b] = dayRange(day);
    const tnow = Date.now();
    let expected = 0;
    let done = 0;
    const areas = db.all('SELECT * FROM sec_clean_areas WHERE active = 1 ORDER BY sort, name').map((x) => {
      const open = hmMin(x.start_hm) ?? 0;
      let close = hmMin(x.end_hm) ?? 1440;
      if (close <= open) close += 1440;
      const from = Date.parse(atLocal(day, open));
      const to = Math.min(Date.parse(atLocal(day, close)), tnow);
      const exp = to > from ? Math.floor((to - from) / (x.every_min * 60000)) : 0;
      const n = db.value("SELECT COUNT(*) FROM sec_clean_logs WHERE area_id = ? AND at >= ? AND at < ? AND check_status != 'redo'", x.id, atLocal(day, open), atLocal(day, close));
      expected += exp;
      done += Math.min(n, exp);
      return { area: x, expected: exp, done: n, pct: exp ? Math.min(1, n / exp) : null };
    });
    return { day, expected, done, score: expected ? Math.round((done / expected) * 100) : null, areas, range: [a, b] };
  }
  function markClean(area, { user = null, cleaner = null, note = null, at = now(), demo = 0 } = {}) {
    return db.tx(() => {
      const id = Number(db.run('INSERT INTO sec_clean_logs (area_id, user_id, cleaner_name, at, note, demo) VALUES (?, ?, ?, ?, ?, ?)', area.id, user ? user.id : null, cleaner || (user ? user.name : null), at, note, demo ? 1 : 0).lastInsertRowid);
      db.run('UPDATE sec_clean_alerts SET resolved_at = ?, resolved_by = ? WHERE area_id = ? AND resolved_at IS NULL', at, user ? user.id : null, area.id);
      return id;
    });
  }
  // other modules: a cleaning alert on an area (or just a place)
  function cleaningAlert({ area_id = null, place = null, note = null, source = 'staff', source_id = null, demo = 0, at = now() } = {}) {
    const area = area_id ? db.get('SELECT * FROM sec_clean_areas WHERE id = ?', area_id) : null;
    const id = Number(db.run('INSERT INTO sec_clean_alerts (area_id, place, source, source_id, note, created_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?)', area ? area.id : null, place || (area ? area.name : null), source, source_id, note, at, demo ? 1 : 0).lastInsertRowid);
    h.events.emit('cleaning.alert', { id, area, place, source, source_id });
    return id;
  }
  h.security = { scan, startRound, markClean, cleaningAlert, patrolDay, cleanDay, areaState, settle, slotsOf, slotFor, atLocal, localDay, shiftOf, SHIFTS, AREA_KINDS, I_KINDS };

  // the sidebar count: open incidents, keys overdue, open cleaning alerts
  h.count('security', () => db.value("SELECT COUNT(*) FROM sec_incidents WHERE status IN ('open','investigating')")
    + db.value('SELECT COUNT(*) FROM sec_key_loans WHERE returned_at IS NULL AND due_at < ?', now())
    + db.value('SELECT COUNT(*) FROM sec_clean_alerts WHERE resolved_at IS NULL'));

  // ---------- the frame ----------
  const TABS = [['/admin/security', 'sec|Today'], ['/admin/security/patrols', 'sec|Patrols'], ['/admin/security/cleaning', 'sec|Cleaning'], ['/admin/security/incidents', 'sec|Incidents'], ['/admin/security/lost', 'sec|Lost & found'], ['/admin/security/keys', 'sec|Keys'], ['/admin/security/handover', 'sec|Handover log']];
  const tabs = (on) => `<nav class="tabs sec-tabs">${TABS.map(([href, label]) => `<a class="tab${on === href ? ' is-on' : ''}" href="${href}">${esc(tr(label))}</a>`).join('')}</nav>`;
  const page = (req, res, { title, on, crumbs = [], body, actions = '', wide = true }) => h.page(req, res, {
    title, active: '/admin/security', wide, actions,
    crumbs: on === '/admin/security' && !crumbs.length ? undefined : [['/admin/security', tr('nav|Security & cleaning')], ...crumbs],
    body: `${tabs(on)}${body}`,
  });
  const pctTxt = (p) => (p === null || p === undefined ? '—' : ui.pct(p));
  const back = (req, res, url, kind, msg) => h.back(req, res, url, kind, msg);

  // ================= today =================
  router.get('/security', (req, res) => {
    const day = localDay();
    const p = patrolDay(day);
    const c = cleanDay(day);
    const areas = db.all('SELECT * FROM sec_clean_areas WHERE active = 1 ORDER BY sort, name').map((a) => ({ a, s: areaState(a) }));
    const bad = areas.filter((x) => ['alert', 'overdue'].includes(x.s.state));
    const openInc = db.all("SELECT * FROM sec_incidents WHERE status IN ('open','investigating') ORDER BY at DESC LIMIT 8");
    const keysOut = db.all('SELECT l.*, k.code, k.opens FROM sec_key_loans l JOIN sec_keys k ON k.id = l.key_id WHERE l.returned_at IS NULL ORDER BY l.due_at LIMIT 10');
    const overdueKeys = keysOut.filter((l) => l.due_at < now()).length;
    const kpis = [
      ui.kpi({ label: tr('sec|Patrol checkpoints today'), value: pctTxt(p.pct), bar: p.pct, sub: esc(tr('sec|{done} of {all} · {missed} rounds missed', { done: p.scanned, all: p.expected, missed: p.missedRounds })), tone: p.missedRounds ? 'kpi--alert' : '', href: '/admin/security/patrols' }),
      ui.kpi({ label: tr('sec|Cleaning score today'), value: c.score === null ? '—' : `${c.score}`, bar: c.score === null ? null : c.score / 100, sub: esc(tr('sec|{done} of {all} cleans done', { done: c.done, all: c.expected })), href: '/admin/security/cleaning' }),
      ui.kpi({ label: tr('sec|Areas overdue'), value: ui.n0(bad.length), tone: bad.length ? 'kpi--alert' : '', sub: esc(tr('sec|{n} cleaning alerts', { n: areas.filter((x) => x.s.alert).length })), href: '/admin/security/cleaning' }),
      ui.kpi({ label: tr('sec|Open incidents'), value: ui.n0(openInc.length), tone: openInc.some((i) => ['high', 'critical'].includes(i.severity)) ? 'kpi--alert' : '', href: '/admin/security/incidents' }),
      ui.kpi({ label: tr('sec|Keys out'), value: ui.n0(keysOut.length), sub: esc(tr('sec|{n} overdue', { n: overdueKeys })), tone: overdueKeys ? 'kpi--alert' : '', href: '/admin/security/keys' }),
      ui.kpi({ label: tr('sec|Items in lost & found'), value: ui.n0(db.value("SELECT COUNT(*) FROM sec_lost WHERE status = 'held'")), href: '/admin/security/lost' }),
    ].join('');
    const routeRows = p.routes.length ? `<ul class="list">${p.routes.map((r) => `<li><a href="/admin/security/patrols?day=${day}#route-${r.route.id}"><span class="what"><b>${esc(r.route.name)}</b><small>${esc(tr('sec|{n} checkpoints', { n: r.cps.length }))} · ${esc(mins(r.route.every_min))} · ${esc(span(r.route.start_hm, r.route.end_hm))}</small></span><span class="sec-meter"><i style="width:${r.expected ? Math.round((r.scanned / r.expected) * 100) : 0}%"></i></span><b>${pctTxt(r.expected ? r.scanned / r.expected : null)}</b>${r.missed ? ui.badge('missed', tn(r.missed, 'sec|{n} round missed', 'sec|{n} rounds missed'), 'rose') : ''}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('sec|No patrol routes yet.'))}</p>`;
    const areaRows = bad.length ? `<ul class="list">${bad.map(({ a, s }) => `<li><a href="/admin/security/cleaning/areas/${a.id}"><span class="what"><b>${esc(a.name)}</b><small>${esc(s.last ? tr('sec|last cleaned {time}', { time: ui.dt(s.last.at) }) : tr('sec|not cleaned yet today'))}</small></span>${badge(A_STATE, s.state)}${s.late ? `<small class="late">${esc(tr('sec|{n} min late', { n: s.late }))}</small>` : ''}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('sec|Every area is on time.'))}</p>`;
    const incRows = openInc.length ? `<ul class="list">${openInc.map((i) => `<li><a href="/admin/security/incidents/${i.id}"><span class="what"><b>${esc(i.title)}</b><small>${esc([i.ref, tr(I_KINDS[i.kind] || i.kind), i.place, ui.dt(i.at)].filter(Boolean).join(' · '))}</small></span>${badge(SEVERITY, i.severity)}${badge(I_STATUS, i.status)}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('sec|No open incidents.'))}</p>`;
    const keyRows = keysOut.length ? `<ul class="list">${keysOut.map((l) => `<li><a href="/admin/security/keys/${l.key_id}"><span class="what"><b>${esc(l.code)} · ${esc(l.opens)}</b><small>${esc([l.issued_to, l.company].filter(Boolean).join(' · '))}</small></span><span class="${l.due_at < now() ? 'late' : 'muted'}">${esc(tr('sec|back by {time}', { time: ui.dt(l.due_at) }))}</span></a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('sec|All keys are in the cabinet.'))}</p>`;
    const last = db.get('SELECT x.*, u.name user_name FROM sec_handover x LEFT JOIN users u ON u.id = x.user_id ORDER BY x.at DESC LIMIT 1');
    const hand = last ? `<div class="pad"><p><b>${esc(tr(SHIFTS[last.shift] ? SHIFTS[last.shift][0] : last.shift))}</b> · ${esc(ui.dt(last.at))} · ${esc(last.user_name || '—')}${last.to_name ? ` → ${esc(last.to_name)}` : ''}</p><p class="sec-pre">${esc(last.summary)}</p>${last.open_items ? `<p class="sec-pre muted">${esc(last.open_items)}</p>` : ''}</div>` : `<p class="muted pad">${esc(tr('sec|No handover written yet.'))}</p>`;
    page(req, res, {
      title: tr('nav|Security & cleaning'), on: '/admin/security',
      actions: h.can(req, 'agent') ? `${ui.btn(esc(tr('sec|Report an incident')), { href: '/admin/security/incidents/new', cls: 'btn--primary', ic: 'plus' })}${ui.btn(esc(tr('sec|Write the handover')), { href: '/admin/security/handover', cls: 'btn--ghost', ic: 'log' })}` : '',
      body: `<div class="kpis kpis--3 sec-kpis">${kpis}</div><div class="grid grid--2">${ui.card(tr('sec|Patrols today'), routeRows, { action: ui.btn(esc(tr('sec|Guards and shifts')), { href: '/admin/security/patrols/report', cls: 'btn--ghost btn--sm' }) })}${ui.card(tr('sec|Cleaning needed'), areaRows)}${ui.card(tr('sec|Open incidents'), incRows)}${ui.card(tr('sec|Keys out'), keyRows)}</div>${ui.card(tr('sec|Last handover'), hand)}`,
    });
  });

  // ================= patrols =================
  router.get('/security/patrols', (req, res) => {
    const day = isDay(req.query.day) ? req.query.day : localDay();
    const p = patrolDay(day);
    const cps = cpMap();
    const csrf = req.session.csrf;
    const nav = `<form method="get" class="filters">${ui.input('day', tr('sec|Day'), day, { type: 'date' })}${ui.btn(esc(tr('sec|Show')), { cls: 'btn--ghost btn--sm' })}${day > M.addDays(localDay(), -45) ? `<a class="btn btn--ghost btn--sm" href="/admin/security/patrols?day=${M.addDays(day, -1)}">${esc(tr('sec|Day before'))}</a>` : ''}${day < localDay() ? `<a class="btn btn--ghost btn--sm" href="/admin/security/patrols?day=${M.addDays(day, 1)}">${esc(tr('sec|Day after'))}</a>` : ''}</form>`;
    const kpis = [
      ui.kpi({ label: tr('sec|Checkpoints reached'), value: pctTxt(p.pct), bar: p.pct, sub: esc(tr('sec|{done} of {all}', { done: p.scanned, all: p.expected })) }),
      ui.kpi({ label: tr('sec|Rounds walked'), value: ui.n0(p.rounds) }),
      ui.kpi({ label: tr('sec|Rounds missed'), value: ui.n0(p.missedRounds), tone: p.missedRounds ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('sec|Late'), value: ui.n0(p.lateRounds + p.late), sub: esc(tr('sec|{a} rounds started late · {b} checkpoints reached late', { a: p.lateRounds, b: p.late })) }),
    ].join('');
    const routeCards = p.routes.map((r) => {
      const grid = r.slots.length ? `<div class="sec-slots">${r.slots.map((s) => {
        const pc = r.cps.length ? s.got / r.cps.length : 0;
        const cls = !s.rounds.length ? (s.due ? 'is-missed' : 'is-wait') : pc >= 1 ? (s.lateStart || s.late ? 'is-late' : 'is-ok') : s.due ? 'is-part' : 'is-run';
        const label = !s.rounds.length ? (s.due ? tr('sec|Missed') : tr('sec|Not yet')) : `${s.got}/${r.cps.length}`;
        const link = s.rounds.length ? `/admin/security/rounds/${s.rounds[0].id}` : null;
        const inner = `<b>${esc(ui.local(s.at).slice(11, 16))}</b><span>${esc(label)}</span>${s.rounds.length ? `<small>${esc(s.rounds[0].guard_name || s.rounds[0].user_name || '')}</small>` : ''}`;
        return link ? `<a class="sec-slot ${cls}" href="${link}">${inner}</a>` : `<span class="sec-slot ${cls}">${inner}</span>`;
      }).join('')}</div>` : `<p class="muted pad">${esc(tr('sec|No rounds due yet on this day.'))}</p>`;
      const order = `<ol class="sec-route">${r.cps.map((id) => cps.get(id)).filter(Boolean).map((c) => `<li><b class="ltr">${esc(c.code)}</b> ${esc(c.name)}</li>`).join('')}</ol>`;
      return `<div id="route-${r.route.id}">${ui.card(r.route.name, `${grid}<details class="pad"><summary>${esc(tr('sec|Checkpoints in order'))}</summary>${order}</details>`, { sub: esc(`${tr('sec|{n} checkpoints', { n: r.cps.length })} · ${mins(r.route.every_min)} · ${span(r.route.start_hm, r.route.end_hm)} · ${tr('sec|{n} minutes to finish', { n: r.route.window_min })}`), action: `${pctTxt(r.expected ? r.scanned / r.expected : null)}${h.can(req, 'manager') ? ` ${ui.btn(esc(tr('Edit')), { href: `/admin/security/patrols/routes/${r.route.id}`, cls: 'btn--ghost btn--sm' })}` : ''}` })}</div>`;
    }).join('') || ui.card(tr('sec|Patrol routes'), `<p class="muted pad">${esc(tr('sec|Add checkpoints, then a route through them.'))}</p>`);
    const list = db.all('SELECT * FROM sec_checkpoints ORDER BY sort, code');
    const cpTable = ui.table([
      { label: tr('sec|Code'), render: (c) => `<b class="ltr">${esc(c.code)}</b>` },
      { label: tr('sec|Checkpoint'), render: (c) => `${esc(c.name)}${c.place ? `<small class="sub">${esc(c.place)}</small>` : ''}` },
      { label: tr('sec|Last scanned'), render: (c) => { const s = db.get('SELECT at, guard_name FROM sec_scans WHERE checkpoint_id = ? ORDER BY at DESC LIMIT 1', c.id); return s ? `${esc(ui.dt(s.at))}<small class="sub">${esc(s.guard_name || '')}</small>` : '—'; } },
      { label: tr('Status'), render: (c) => (c.active ? ui.badge('active', tr('sec|In use'), 'ok') : ui.badge('off', tr('sec|Not in use'), 'mute')) },
    ], list, { href: (c) => `/admin/security/scan/${c.token}`, empty: esc(tr('sec|No checkpoints yet.')) });
    const addCp = h.can(req, 'manager') ? ui.form('/admin/security/patrols/checkpoints', csrf, `<div class="fields">${ui.input('code', tr('sec|Code'), `CP-${String(list.length + 1).padStart(2, '0')}`, { required: true })}${ui.input('name', tr('sec|Checkpoint'), '', { required: true, placeholder: tr('sec|e.g. Fire exit, east stairs') })}${ui.input('place', tr('sec|Floor or zone'), '', { placeholder: tr('sec|e.g. Ground floor') })}</div>${ui.btn(esc(tr('sec|Add checkpoint')), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' }) : '';
    const addRoute = h.can(req, 'manager') && list.length ? ui.form('/admin/security/patrols/routes', csrf, `<div class="fields">${ui.input('name', tr('sec|Route'), '', { required: true, placeholder: tr('sec|e.g. Night perimeter') })}${ui.input('every_min', tr('sec|A round every (minutes)'), 120, { type: 'number', min: 15, step: 15 })}${ui.input('window_min', tr('sec|Minutes to finish a round'), 45, { type: 'number', min: 5, step: 5 })}${ui.input('start_hm', tr('sec|From'), '00:00', { type: 'time' })}${ui.input('end_hm', tr('sec|To'), '23:59', { type: 'time' })}</div>
      <fieldset class="sec-pick"><legend>${esc(tr('sec|Checkpoints, in the order walked'))}</legend>${list.filter((c) => c.active).map((c) => `<label class="check"><input type="checkbox" name="cp" value="${c.id}"> <b class="ltr">${esc(c.code)}</b> ${esc(c.name)}</label>`).join('')}</fieldset>${ui.btn(esc(tr('sec|Add route')), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' }) : '';
    page(req, res, {
      title: tr('sec|Patrols'), on: '/admin/security/patrols', crumbs: [[null, tr('sec|Patrols')]],
      actions: `${ui.btn(esc(tr('sec|Guards and shifts')), { href: `/admin/security/patrols/report?from=${M.addDays(day, -6)}&to=${day}`, cls: 'btn--ghost', ic: 'report' })}${ui.btn(esc(tr('sec|Print QR stickers')), { href: '/admin/security/patrols/qr', cls: 'btn--ghost', ic: 'print' })}`,
      body: `${nav}<div class="kpis kpis--4">${kpis}</div><p class="muted small sec-legend"><span class="sec-slot is-ok"></span>${esc(tr('sec|complete'))} <span class="sec-slot is-late"></span>${esc(tr('sec|complete, late'))} <span class="sec-slot is-part"></span>${esc(tr('sec|checkpoints skipped'))} <span class="sec-slot is-missed"></span>${esc(tr('sec|missed'))} <span class="sec-slot is-run"></span>${esc(tr('sec|in progress'))}</p>${routeCards}
        <div class="grid grid--2">${ui.card(tr('sec|Checkpoints'), cpTable, { sub: esc(tr('sec|Stick each QR at its place. The guard scans it with the phone camera; the office sign-in on the phone records who.')) })}<div class="stack">${addCp ? ui.card(tr('sec|Add checkpoint'), addCp) : ''}${addRoute ? ui.card(tr('sec|Add route'), addRoute) : ''}</div></div>`,
    });
  });
  router.post('/security/patrols/checkpoints', R('manager'), (req, res) => {
    const code = h.str(req.body.code, 20).toUpperCase();
    const name = h.str(req.body.name, 120);
    if (!code || !name) return back(req, res, '/admin/security/patrols', 'error', tr('sec|Enter the code and the name.'));
    if (db.get('SELECT id FROM sec_checkpoints WHERE code = ?', code)) return back(req, res, '/admin/security/patrols', 'error', tr('sec|The code {code} is already used.', { code }));
    const id = Number(db.run('INSERT INTO sec_checkpoints (code, name, place, token, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)', code, name, h.str(req.body.place, 120) || null, token(), db.value('SELECT COALESCE(MAX(sort), 0) + 1 FROM sec_checkpoints'), now()).lastInsertRowid);
    h.log(req, 'Added a patrol checkpoint', 'sec_checkpoint', id, `${code} · ${name}`);
    back(req, res, '/admin/security/patrols', 'ok', tr('sec|Checkpoint added. Print its QR sticker.'));
  });
  const readRoute = (b) => ({
    name: h.str(b.name, 120), every: Math.max(15, Math.min(1440, h.int(b.every_min) || 120)), window: Math.max(5, Math.min(720, h.int(b.window_min) || 45)),
    start: hmOk(b.start_hm, '00:00'), end: hmOk(b.end_hm, '24:00') === '23:59' ? '24:00' : hmOk(b.end_hm, '24:00'),
    cps: h.list(b.cp).map(Number).filter((id) => db.get('SELECT id FROM sec_checkpoints WHERE id = ?', id)),
  });
  router.post('/security/patrols/routes', R('manager'), (req, res) => {
    const v = readRoute(req.body);
    if (!v.name || !v.cps.length) return back(req, res, '/admin/security/patrols', 'error', tr('sec|Name the route and tick its checkpoints.'));
    const id = Number(db.run('INSERT INTO sec_routes (name, checkpoints, every_min, window_min, start_hm, end_hm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', v.name, JSON.stringify(v.cps), v.every, v.window, v.start, v.end, now()).lastInsertRowid);
    h.log(req, 'Added a patrol route', 'sec_route', id, v.name);
    back(req, res, `/admin/security/patrols#route-${id}`, 'ok', tr('Saved.'));
  });
  router.get('/security/patrols/routes/:id', R('manager'), (req, res, next) => {
    const r = db.get('SELECT * FROM sec_routes WHERE id = ?', h.int(req.params.id));
    if (!r) return next();
    const order = cpsOf(r);
    const list = db.all('SELECT * FROM sec_checkpoints WHERE active = 1 ORDER BY sort, code');
    const pos = (id) => (order.includes(id) ? order.indexOf(id) + 1 : '');
    const form = ui.form(`/admin/security/patrols/routes/${r.id}`, req.session.csrf, `<div class="fields">${ui.input('name', tr('sec|Route'), r.name, { required: true })}${ui.input('every_min', tr('sec|A round every (minutes)'), r.every_min, { type: 'number', min: 15, step: 15 })}${ui.input('window_min', tr('sec|Minutes to finish a round'), r.window_min, { type: 'number', min: 5, step: 5 })}${ui.input('start_hm', tr('sec|From'), r.start_hm, { type: 'time' })}${ui.input('end_hm', tr('sec|To'), r.end_hm === '24:00' ? '23:59' : r.end_hm, { type: 'time' })}</div>
      <div class="tablewrap"><table class="table"><thead><tr><th>${esc(tr('sec|Order'))}</th><th>${esc(tr('sec|Checkpoint'))}</th></tr></thead><tbody>${list.map((c) => `<tr><td><input class="sec-num" type="number" min="1" max="99" name="pos_${c.id}" value="${pos(c.id)}" aria-label="${esc(tr('sec|Order'))}"></td><td><b class="ltr">${esc(c.code)}</b> ${esc(c.name)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">${esc(tr('sec|Number the checkpoints in the order the guard walks them; leave empty to leave one out.'))}</p>
      <label class="check"><input type="checkbox" name="active" value="1"${r.active ? ' checked' : ''}> ${esc(tr('sec|In use'))}</label>${ui.btn(esc(tr('Save')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    page(req, res, { title: r.name, on: '/admin/security/patrols', crumbs: [['/admin/security/patrols', tr('sec|Patrols')], [null, r.name]], body: ui.card(r.name, form) });
  });
  router.post('/security/patrols/routes/:id', R('manager'), (req, res, next) => {
    const r = db.get('SELECT * FROM sec_routes WHERE id = ?', h.int(req.params.id));
    if (!r) return next();
    const v = readRoute(req.body);
    const cps = db.all('SELECT id FROM sec_checkpoints').map((c) => [c.id, h.int(req.body[`pos_${c.id}`])]).filter(([, p]) => p > 0).sort((a, b) => a[1] - b[1]).map(([id]) => id);
    if (!v.name || !cps.length) return back(req, res, `/admin/security/patrols/routes/${r.id}`, 'error', tr('sec|Name the route and tick its checkpoints.'));
    db.run('UPDATE sec_routes SET name = ?, checkpoints = ?, every_min = ?, window_min = ?, start_hm = ?, end_hm = ?, active = ? WHERE id = ?', v.name, JSON.stringify(cps), v.every, v.window, v.start, v.end, req.body.active ? 1 : 0, r.id);
    h.log(req, 'Changed a patrol route', 'sec_route', r.id, v.name);
    back(req, res, `/admin/security/patrols#route-${r.id}`, 'ok', tr('Saved.'));
  });

  // printable QR stickers (checkpoints or cleaning areas)
  const stickers = (req, res, { title, rows, path, hint }) => {
    const cells = rows.map((x) => `<figure class="sec-sticker">${QR.svg(`${site(req)}${path}${x.token}`, { ecl: 'M', cls: 'qr' })}<figcaption><b class="ltr">${esc(x.code)}</b><span>${esc(x.name)}</span>${x.place ? `<small>${esc(x.place)}</small>` : ''}<em>${esc(hint)}</em></figcaption></figure>`).join('');
    res.type('html').send(ui.bare({ title, cls: 'sec-print', body: `<div class="sec-printbar noprint"><button class="btn btn--primary" type="button" data-print>${ui.icon('print')}<span>${esc(tr('sec|Print'))}</span></button></div><main class="sec-sheet">${cells || `<p>${esc(tr('Nothing here yet.'))}</p>`}</main>` }));
  };
  router.get('/security/patrols/qr', (req, res) => stickers(req, res, { title: tr('sec|Patrol QR stickers'), rows: db.all('SELECT * FROM sec_checkpoints WHERE active = 1 ORDER BY sort, code'), path: '/admin/security/scan/', hint: tr('sec|Guards: scan at every round') }));
  router.get('/security/cleaning/qr', (req, res) => stickers(req, res, { title: tr('sec|Cleaning QR stickers'), rows: db.all('SELECT * FROM sec_clean_areas WHERE active = 1 ORDER BY sort, code'), path: '/admin/security/clean/', hint: tr('sec|Cleaners: scan when done') }));

  // ---- the guard's phone ----
  router.get('/security/scan/:token', (req, res, next) => {
    const cp = db.get('SELECT * FROM sec_checkpoints WHERE token = ?', String(req.params.token));
    if (!cp) return next();
    settle();
    const through = routes().filter((r) => cpsOf(r).includes(cp.id));
    const mine = db.all("SELECT r.*, t.name route_name FROM sec_rounds r JOIN sec_routes t ON t.id = r.route_id WHERE r.status = 'open' AND r.user_id = ? ORDER BY r.started_at DESC", req.user.id).filter((r) => through.some((t) => t.id === r.route_id));
    const last = db.get('SELECT s.*, u.name user_name FROM sec_scans s LEFT JOIN users u ON u.id = s.user_id WHERE s.checkpoint_id = ? ORDER BY s.at DESC LIMIT 1', cp.id);
    const form = ui.form(`/admin/security/scan/${esc(cp.token)}`, req.session.csrf, `${through.length > 1 ? ui.select('route_id', tr('sec|Route'), through.map((r) => [r.id, r.name]), mine.length ? mine[0].route_id : through[0].id) : through.length ? `<input type="hidden" name="route_id" value="${through[0].id}">` : ''}
      ${ui.input('guard', tr('sec|Guard'), req.user.name, { hint: tr('sec|Change it if you are using a colleague’s phone.') })}${ui.textarea('note', tr('sec|Anything to report?'), '', { rows: 2, placeholder: tr('sec|e.g. Door found unlocked, locked it') })}
      ${ui.btn(esc(tr('sec|Record this checkpoint')), { cls: 'btn--primary sec-big', ic: 'check' })}`, { cls: 'stack' });
    page(req, res, {
      title: cp.name, on: '/admin/security/patrols', crumbs: [['/admin/security/patrols', tr('sec|Patrols')], [null, cp.code]], wide: false,
      body: `<section class="sec-phone">${ui.card(`${cp.code} · ${cp.name}`, `<div class="pad">${cp.place ? `<p class="muted">${esc(cp.place)}</p>` : ''}${mine.length ? `<p class="alert alert--ok">${esc(tr('sec|Round in progress: {route}', { route: mine[0].route_name }))}</p>` : through.length ? `<p class="muted">${esc(tr('sec|This scan starts a new round.'))}</p>` : `<p class="alert alert--warn">${esc(tr('sec|This checkpoint is on no route; the scan is recorded on its own.'))}</p>`}${last ? `<p class="muted small">${esc(tr('sec|Last scanned {time} by {name}', { time: ui.dt(last.at), name: last.guard_name || last.user_name || '—' }))}</p>` : ''}</div>${form}`)}</section>`,
    });
  });
  router.post('/security/scan/:token', (req, res, next) => {
    const cp = db.get('SELECT * FROM sec_checkpoints WHERE token = ?', String(req.params.token));
    if (!cp) return next();
    const out = db.tx(() => scan(cp, { user: req.user, guard: h.str(req.body.guard, 80) || req.user.name, routeId: h.int(req.body.route_id), note: h.str(req.body.note, 500) || null }));
    h.log(req, 'Scanned a patrol checkpoint', 'sec_checkpoint', cp.id, cp.code);
    if (!out.round) return back(req, res, '/admin/security/patrols', 'ok', tr('sec|Checkpoint {code} recorded.', { code: cp.code }));
    const cps = cpsOf(out.route);
    const got = new Set(scansOf(out.round.id).map((s) => s.checkpoint_id));
    const after = cps.find((c) => !got.has(c));
    const nextCp = after ? db.get('SELECT * FROM sec_checkpoints WHERE id = ?', after) : null;
    back(req, res, `/admin/security/rounds/${out.round.id}`, 'ok', out.round.status === 'done' ? tr('sec|Round complete. Thank you.') : tr('sec|Checkpoint {code} recorded. Next: {next}.', { code: cp.code, next: nextCp ? `${nextCp.code} · ${nextCp.name}` : '—' }));
  });

  // ---- one round ----
  router.get('/security/rounds/:id', (req, res, next) => {
    settle();
    const r = db.get('SELECT r.*, t.name route_name, t.window_min, t.checkpoints, u.name user_name FROM sec_rounds r JOIN sec_routes t ON t.id = r.route_id LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?', h.int(req.params.id));
    if (!r) return next();
    const scans = scansOf(r.id);
    const cps = cpMap();
    const order = cpsOf(r);
    const rows = order.map((id, i) => {
      const c = cps.get(id);
      const s = scans.find((x) => x.checkpoint_id === id);
      return `<li class="${s ? (s.late ? 'is-late' : 'is-ok') : r.status === 'open' ? 'is-wait' : 'is-missed'}"><span class="sec-step">${i + 1}</span><span class="what"><b>${esc(c ? `${c.code} · ${c.name}` : '—')}</b><small>${s ? esc([ui.dt(s.at), s.late ? tr('sec|late') : null, s.note].filter(Boolean).join(' · ')) : esc(r.status === 'open' ? tr('sec|Not yet') : tr('sec|Missed'))}</small></span></li>`;
    }).join('');
    const got = new Set(scans.map((s) => s.checkpoint_id));
    const pct = order.length ? order.filter((c) => got.has(c)).length / order.length : 0;
    const facts = `<dl class="dl"><div><dt>${esc(tr('sec|Guard'))}</dt><dd>${esc(r.guard_name || r.user_name || '—')}</dd></div><div><dt>${esc(tr('sec|Shift'))}</dt><dd>${esc(tr(SHIFTS[shiftOf(r.started_at)][0]))}</dd></div><div><dt>${esc(tr('sec|Started'))}</dt><dd>${esc(ui.dt(r.started_at))}${r.slot_at && Date.parse(r.started_at) > Date.parse(r.slot_at) + GRACE_MIN * 60000 ? ` <small class="late">${esc(tr('sec|due at {time}', { time: ui.local(r.slot_at).slice(11, 16) }))}</small>` : ''}</dd></div><div><dt>${esc(tr('sec|Finished'))}</dt><dd>${esc(r.finished_at ? ui.dt(r.finished_at) : '—')}</dd></div><div><dt>${esc(tr('sec|Checkpoints reached'))}</dt><dd><b>${ui.pct(pct)}</b></dd></div></dl>`;
    const close = r.status === 'open' && h.can(req, 'agent') ? ui.form(`/admin/security/rounds/${r.id}/close`, req.session.csrf, `${ui.input('note', tr('sec|Why it ends here'), '', { placeholder: tr('sec|e.g. Called to an incident') })}${ui.btn(esc(tr('sec|End the round')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' }) : '';
    page(req, res, {
      title: r.route_name, on: '/admin/security/patrols', crumbs: [['/admin/security/patrols', tr('sec|Patrols')], [null, tr('sec|Round {n}', { n: r.id })]],
      body: `<div class="grid grid--side"><div class="stack">${ui.card(r.route_name, `<ol class="sec-steps">${rows}</ol>`, { action: badge(R_STATUS, r.status), sub: r.note ? esc(r.note) : '' })}${roundDocs(req, 'sec_round', r.id, { title: tr('sec|Photos') })}</div><div class="stack">${ui.card(tr('sec|Round'), facts)}${close ? ui.card(tr('sec|End early'), close) : ''}</div></div>`,
    });
  });
  router.post('/security/rounds/:id/close', R('agent'), (req, res, next) => {
    const r = db.get("SELECT * FROM sec_rounds WHERE id = ? AND status = 'open'", h.int(req.params.id));
    if (!r) return next();
    db.run("UPDATE sec_rounds SET status = 'incomplete', finished_at = ?, note = ? WHERE id = ?", now(), h.str(req.body.note, 300) || null, r.id);
    h.log(req, 'Ended a patrol round early', 'sec_round', r.id, '');
    back(req, res, `/admin/security/rounds/${r.id}`, 'ok', tr('Saved.'));
  });

  // ---- per guard and shift ----
  router.get('/security/patrols/report', (req, res) => {
    const to = isDay(req.query.to) ? req.query.to : localDay();
    const from = isDay(req.query.from) && req.query.from <= to ? req.query.from : M.addDays(to, -6);
    settle();
    const rounds = db.all('SELECT r.*, t.checkpoints, t.window_min, u.name user_name FROM sec_rounds r JOIN sec_routes t ON t.id = r.route_id LEFT JOIN users u ON u.id = r.user_id WHERE r.started_at >= ? AND r.started_at < ? ORDER BY r.started_at', dayRange(from)[0], dayRange(to)[1]);
    const by = new Map();
    for (const r of rounds) {
      const key = `${r.guard_name || r.user_name || '—'}|${shiftOf(r.started_at)}`;
      const g = by.get(key) || { guard: r.guard_name || r.user_name || '—', shift: shiftOf(r.started_at), rounds: 0, done: 0, expected: 0, scanned: 0, late: 0, lateStart: 0 };
      const cps = cpsOf(r);
      const sc = scansOf(r.id);
      const got = new Set(sc.map((s) => s.checkpoint_id).filter((c) => cps.includes(c)));
      g.rounds++; g.done += r.status === 'done' ? 1 : 0; g.expected += cps.length; g.scanned += got.size; g.late += sc.filter((s) => s.late).length;
      g.lateStart += r.slot_at && Date.parse(r.started_at) > Date.parse(r.slot_at) + GRACE_MIN * 60000 ? 1 : 0;
      by.set(key, g);
    }
    const sf = h.listFilters(req, { sorts: [['guard', 'sort|Name: A to Z', ''], ['rounds', 'sort|Most rounds first', ''], ['reach', 'sort|Lowest checkpoint reach first', ''], ['late', 'sort|Most late first', '']] });
    const rate = (g) => (g.expected ? g.scanned / g.expected : 0);
    const rows = [...by.values()].sort((a, b) => a.guard.localeCompare(b.guard) || Object.keys(SHIFTS).indexOf(a.shift) - Object.keys(SHIFTS).indexOf(b.shift));
    if (sf.sortKey === 'rounds') rows.sort((a, b) => b.rounds - a.rounds);
    else if (sf.sortKey === 'reach') rows.sort((a, b) => rate(a) - rate(b));
    else if (sf.sortKey === 'late') rows.sort((a, b) => (b.late + b.lateStart) - (a.late + a.lateStart));
    // rounds nobody walked, per shift
    const missed = { morning: 0, evening: 0, night: 0 };
    for (let d = from; d <= to; d = M.addDays(d, 1)) for (const r of patrolDay(d).routes) for (const s of r.slots) if (s.due && !s.rounds.length) missed[shiftOf(s.at)]++;
    const table = ui.table([
      { label: tr('sec|Guard'), sort: (g) => g.guard, render: (g) => `<b>${esc(g.guard)}</b>` },
      { label: tr('sec|Shift'), render: (g) => esc(tr(SHIFTS[g.shift][0])) },
      { label: tr('sec|Rounds'), num: true, sort: (g) => g.rounds, render: (g) => `${ui.n0(g.rounds)}<small class="sub">${esc(tr('sec|{n} complete', { n: g.done }))}</small>` },
      { label: tr('sec|Checkpoints reached'), num: true, sort: (g) => (g.expected ? g.scanned / g.expected : 0), render: (g) => `<b>${pctTxt(g.expected ? g.scanned / g.expected : null)}</b><small class="sub">${esc(tr('sec|{done} of {all}', { done: g.scanned, all: g.expected }))}</small>` },
      { label: tr('sec|Late'), num: true, sort: (g) => g.late + g.lateStart, render: (g) => `<span class="${g.late + g.lateStart ? 'late' : ''}">${ui.n0(g.late + g.lateStart)}</span>` },
    ], rows, { empty: esc(tr('sec|No rounds in these days.')) });
    const filters = `<form method="get" class="filters">${ui.input('from', tr('From'), from, { type: 'date' })}${ui.input('to', tr('To'), to, { type: 'date' })}${sf.fields}${ui.btn(esc(tr('sec|Show')), { cls: 'btn--ghost btn--sm' })}${h.listFilters(req, { cols: { date: 'x' } }).quick}</form>`;
    const missedCard = `<ul class="list">${Object.keys(SHIFTS).map((k) => `<li><span class="what"><b>${esc(tr(SHIFTS[k][0]))}</b></span><b class="${missed[k] ? 'late' : ''}">${esc(tn(missed[k], 'sec|{n} round missed', 'sec|{n} rounds missed'))}</b></li>`).join('')}</ul>`;
    page(req, res, { title: tr('sec|Guards and shifts'), on: '/admin/security/patrols', crumbs: [['/admin/security/patrols', tr('sec|Patrols')], [null, tr('sec|Guards and shifts')]], body: `${filters}<div class="grid grid--side"><div>${ui.card(tr('sec|Per guard and shift'), table)}</div><div>${ui.card(tr('sec|Rounds nobody walked'), missedCard)}</div></div>` });
  });

  // ================= cleaning =================
  router.get('/security/cleaning', (req, res) => {
    const day = isDay(req.query.day) ? req.query.day : localDay();
    const today = day === localDay();
    const c = cleanDay(day);
    const csrf = req.session.csrf;
    const states = new Map(c.areas.map((x) => [x.area.id, areaState(x.area)]));
    const week = Array.from({ length: 7 }, (_, i) => M.addDays(day, i - 6)).map((d) => { const s = cleanDay(d); return { d, score: s.score || 0, label: ui.date(d).split(' ').slice(0, 2).join(' ') }; });
    const alerts = db.all('SELECT x.*, a.name area_name FROM sec_clean_alerts x LEFT JOIN sec_clean_areas a ON a.id = x.area_id WHERE x.resolved_at IS NULL ORDER BY x.created_at DESC');
    const pending = db.all("SELECT l.*, a.name area_name, a.code FROM sec_clean_logs l JOIN sec_clean_areas a ON a.id = l.area_id WHERE l.check_status = 'pending' ORDER BY l.at DESC LIMIT 30");
    const kpis = [
      ui.kpi({ label: today ? tr('sec|Cleaning score today') : tr('sec|Cleaning score'), value: c.score === null ? '—' : String(c.score), bar: c.score === null ? null : c.score / 100, sub: esc(tr('sec|{done} of {all} cleans done', { done: c.done, all: c.expected })) }),
      ui.kpi({ label: tr('sec|Areas overdue'), value: ui.n0([...states.values()].filter((s) => s.state === 'overdue' || s.state === 'alert').length), tone: [...states.values()].some((s) => s.state === 'overdue' || s.state === 'alert') ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('sec|Cleaning alerts'), value: ui.n0(alerts.length), tone: alerts.length ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('sec|Waiting for a check'), value: ui.n0(pending.length) }),
    ].join('');
    const table = ui.table([
      { label: tr('sec|Area'), sort: (x) => x.area.name, render: (x) => `<b>${esc(x.area.name)}</b><small class="sub">${esc([x.area.code, tr(AREA_KINDS[x.area.kind] || x.area.kind), x.area.place].filter(Boolean).join(' · '))}</small>` },
      { label: tr('sec|Schedule'), render: (x) => `${esc(mins(x.area.every_min))}<small class="sub">${esc(span(x.area.start_hm, x.area.end_hm))}</small>` },
      { label: tr('sec|Last cleaned'), render: (x) => { const s = states.get(x.area.id); return s.last ? `${esc(ui.dt(s.last.at))}<small class="sub">${esc(s.last.cleaner_name || '')}</small>` : '—'; } },
      { label: today ? tr('sec|Today') : ui.date(day), num: true, sort: (x) => x.pct ?? -1, render: (x) => `<b>${esc(`${x.done}/${x.expected}`)}</b><small class="sub">${pctTxt(x.pct)}</small>` },
      { label: tr('Status'), sort: (x) => Object.keys(A_STATE).indexOf(states.get(x.area.id).state), render: (x) => { const s = states.get(x.area.id); return `${badge(A_STATE, s.state)}${s.late ? `<small class="sub late">${esc(tr('sec|{n} min late', { n: s.late }))}</small>` : ''}`; } },
    ], c.areas, { href: (x) => `/admin/security/cleaning/areas/${x.area.id}`, empty: esc(tr('sec|No cleaning areas yet.')) });
    const alertList = alerts.length ? `<ul class="list">${alerts.map((a) => `<li><a href="${a.area_id ? `/admin/security/cleaning/areas/${a.area_id}` : '/admin/security/cleaning'}"><span class="what"><b>${esc(a.area_name || a.place || '—')}</b><small>${esc([ui.dt(a.created_at), a.source === 'feedback' ? tr('sec|from shopper feedback') : null].filter(Boolean).join(' · '))}</small>${a.note ? `<small>${esc(a.note)}</small>` : ''}</span>${ui.badge('alert', tr('sec|Alert'), 'rose')}</a></li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('sec|No cleaning alerts.'))}</p>`;
    const checks = pending.length ? `<ul class="list">${pending.slice(0, 10).map((l) => `<li><a href="/admin/security/cleaning/logs/${l.id}"><span class="what"><b>${esc(l.area_name)}</b><small>${esc([ui.dt(l.at), l.cleaner_name].filter(Boolean).join(' · '))}</small></span>${db.value("SELECT COUNT(*) FROM documents WHERE entity = 'sec_clean' AND entity_id = ? AND archived = 0", l.id) ? ui.icon('cam') : ''}${badge(CHECK, l.check_status)}</a></li>`).join('')}</ul>${pending.length > 10 ? `<p class="muted small pad">${esc(tr('sec|and {n} more', { n: pending.length - 10 }))}</p>` : ''}` : `<p class="muted pad">${esc(tr('sec|Nothing waiting for a check.'))}</p>`;
    const add = h.can(req, 'manager') ? ui.form('/admin/security/cleaning/areas', csrf, `<div class="fields">${ui.input('code', tr('sec|Code'), `CL-${String(db.value('SELECT COUNT(*) FROM sec_clean_areas') + 1).padStart(2, '0')}`, { required: true })}${ui.input('name', tr('sec|Area'), '', { required: true, placeholder: tr('sec|e.g. Ladies’ toilets, food court') })}${ui.select('kind', tr('sec|Kind'), tmap(AREA_KINDS), 'toilets')}${ui.input('place', tr('sec|Floor or zone'), '')}${ui.input('every_min', tr('sec|Clean every (minutes)'), 60, { type: 'number', min: 10, step: 5 })}${ui.input('start_hm', tr('sec|From'), '10:00', { type: 'time' })}${ui.input('end_hm', tr('sec|To'), '23:59', { type: 'time' })}</div>${ui.btn(esc(tr('sec|Add area')), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' }) : '';
    const filters = `<form method="get" class="filters">${ui.input('day', tr('sec|Day'), day, { type: 'date' })}${ui.btn(esc(tr('sec|Show')), { cls: 'btn--ghost btn--sm' })}</form>`;
    page(req, res, {
      title: tr('sec|Cleaning'), on: '/admin/security/cleaning', crumbs: [[null, tr('sec|Cleaning')]],
      actions: ui.btn(esc(tr('sec|Print QR stickers')), { href: '/admin/security/cleaning/qr', cls: 'btn--ghost', ic: 'print' }),
      body: `${filters}<div class="kpis kpis--4">${kpis}</div><div class="grid grid--side"><div class="stack">${ui.card(tr('sec|Areas'), table, { sub: esc(tr('sec|The cleaner scans the area’s QR when done and adds a photo; a supervisor checks it.')) })}${ui.card(tr('sec|Cleaning score, last 7 days'), ui.bars(week, { key: 'score', label: 'label', h: 140, fmtv: (v) => String(Math.round(v)) }))}</div><div class="stack">${ui.card(tr('sec|Cleaning alerts'), alertList)}${ui.card(tr('sec|Waiting for a check'), checks)}${add ? ui.card(tr('sec|Add area'), add) : ''}</div></div>`,
    });
  });
  const readArea = (b) => ({ name: h.str(b.name, 120), kind: AREA_KINDS[b.kind] ? b.kind : 'other', place: h.str(b.place, 120) || null, every: Math.max(10, Math.min(1440, h.int(b.every_min) || 60)), start: hmOk(b.start_hm, '10:00'), end: hmOk(b.end_hm, '24:00') === '23:59' ? '24:00' : hmOk(b.end_hm, '24:00') });
  router.post('/security/cleaning/areas', R('manager'), (req, res) => {
    const code = h.str(req.body.code, 20).toUpperCase();
    const v = readArea(req.body);
    if (!code || !v.name) return back(req, res, '/admin/security/cleaning', 'error', tr('sec|Enter the code and the name.'));
    if (db.get('SELECT id FROM sec_clean_areas WHERE code = ?', code)) return back(req, res, '/admin/security/cleaning', 'error', tr('sec|The code {code} is already used.', { code }));
    const id = Number(db.run('INSERT INTO sec_clean_areas (code, name, place, kind, every_min, start_hm, end_hm, token, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', code, v.name, v.place, v.kind, v.every, v.start, v.end, token(), db.value('SELECT COALESCE(MAX(sort), 0) + 1 FROM sec_clean_areas'), now()).lastInsertRowid);
    h.log(req, 'Added a cleaning area', 'sec_clean_area', id, `${code} · ${v.name}`);
    back(req, res, `/admin/security/cleaning/areas/${id}`, 'ok', tr('sec|Area added. Print its QR sticker.'));
  });
  router.get('/security/cleaning/areas/:id', (req, res, next) => {
    const a = db.get('SELECT * FROM sec_clean_areas WHERE id = ?', h.int(req.params.id));
    if (!a) return next();
    const s = areaState(a);
    const csrf = req.session.csrf;
    const logs = db.all('SELECT l.*, u.name checker FROM sec_clean_logs l LEFT JOIN users u ON u.id = l.checked_by WHERE l.area_id = ? ORDER BY l.at DESC LIMIT 60', a.id);
    const alerts = db.all('SELECT * FROM sec_clean_alerts WHERE area_id = ? ORDER BY created_at DESC LIMIT 10', a.id);
    const table = ui.table([
      { label: tr('sec|When'), render: (l) => esc(ui.dt(l.at)) },
      { label: tr('sec|Cleaner'), render: (l) => `${esc(l.cleaner_name || '—')}${l.note ? `<small class="sub">${esc(l.note)}</small>` : ''}` },
      { label: tr('sec|Photo'), render: (l) => (db.value("SELECT COUNT(*) FROM documents WHERE entity = 'sec_clean' AND entity_id = ? AND archived = 0", l.id) ? ui.icon('cam') : '—') },
      { label: tr('sec|Check'), render: (l) => `${badge(CHECK, l.check_status)}${l.checker ? `<small class="sub">${esc(l.checker)}</small>` : ''}` },
    ], logs, { href: (l) => `/admin/security/cleaning/logs/${l.id}`, empty: esc(tr('sec|Not cleaned yet.')) });
    const edit = h.can(req, 'manager') ? `<details class="pad"><summary>${esc(tr('Edit'))}</summary>${ui.form(`/admin/security/cleaning/areas/${a.id}`, csrf, `<div class="fields">${ui.input('name', tr('sec|Area'), a.name, { required: true })}${ui.select('kind', tr('sec|Kind'), tmap(AREA_KINDS), a.kind)}${ui.input('place', tr('sec|Floor or zone'), a.place || '')}${ui.input('every_min', tr('sec|Clean every (minutes)'), a.every_min, { type: 'number', min: 10, step: 5 })}${ui.input('start_hm', tr('sec|From'), a.start_hm, { type: 'time' })}${ui.input('end_hm', tr('sec|To'), a.end_hm === '24:00' ? '23:59' : a.end_hm, { type: 'time' })}</div><label class="check"><input type="checkbox" name="active" value="1"${a.active ? ' checked' : ''}> ${esc(tr('sec|In use'))}</label>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    const raise = h.can(req, 'agent') ? ui.form(`/admin/security/cleaning/areas/${a.id}/alert`, csrf, `${ui.input('note', tr('sec|What needs cleaning'), '', { required: true, placeholder: tr('sec|e.g. Spill by the sinks') })}${ui.btn(esc(tr('sec|Raise a cleaning alert')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' }) : '';
    const facts = `<dl class="dl"><div><dt>${esc(tr('Status'))}</dt><dd>${badge(A_STATE, s.state)}${s.late ? ` <small class="late">${esc(tr('sec|{n} min late', { n: s.late }))}</small>` : ''}</dd></div><div><dt>${esc(tr('sec|Schedule'))}</dt><dd>${esc(`${mins(a.every_min)} · ${span(a.start_hm, a.end_hm)}`)}</dd></div><div><dt>${esc(tr('sec|Next clean due'))}</dt><dd>${esc(ui.dt(s.dueAt))}</dd></div><div><dt>${esc(tr('sec|Kind'))}</dt><dd>${esc(tr(AREA_KINDS[a.kind] || a.kind))}${a.place ? ` · ${esc(a.place)}` : ''}</dd></div></dl>
      <p class="pad">${ui.btn(esc(tr('sec|Mark as cleaned')), { href: `/admin/security/clean/${esc(a.token)}`, cls: 'btn--primary btn--sm', ic: 'check' })}</p>`;
    const alertList = alerts.length ? `<ul class="list">${alerts.map((x) => `<li><span class="what"><b>${esc(x.note || '—')}</b><small>${esc([ui.dt(x.created_at), x.source === 'feedback' ? tr('sec|from shopper feedback') : null, x.resolved_at ? tr('sec|cleaned {time}', { time: ui.dt(x.resolved_at) }) : null].filter(Boolean).join(' · '))}</small></span>${x.resolved_at ? ui.badge('ok', tr('sec|Done'), 'ok') : ui.badge('alert', tr('sec|Alert'), 'rose')}</li>`).join('')}</ul>` : `<p class="muted pad">${esc(tr('sec|No cleaning alerts.'))}</p>`;
    page(req, res, { title: a.name, on: '/admin/security/cleaning', crumbs: [['/admin/security/cleaning', tr('sec|Cleaning')], [null, a.code]], body: `<div class="grid grid--side"><div class="stack">${ui.card(tr('sec|Cleans'), table)}</div><div class="stack">${ui.card(a.name, `${facts}${edit}`)}${ui.card(tr('sec|Cleaning alerts'), `${alertList}${raise ? `<div class="pad">${raise}</div>` : ''}`)}<figure class="sec-sticker sec-sticker--card">${QR.svg(`${site(req)}/admin/security/clean/${a.token}`, { ecl: 'M', cls: 'qr' })}<figcaption><small>${esc(tr('sec|Cleaners: scan when done'))}</small></figcaption></figure></div></div>` });
  });
  router.post('/security/cleaning/areas/:id', R('manager'), (req, res, next) => {
    const a = db.get('SELECT * FROM sec_clean_areas WHERE id = ?', h.int(req.params.id));
    if (!a) return next();
    const v = readArea(req.body);
    if (!v.name) return back(req, res, `/admin/security/cleaning/areas/${a.id}`, 'error', tr('sec|Enter the code and the name.'));
    db.run('UPDATE sec_clean_areas SET name = ?, kind = ?, place = ?, every_min = ?, start_hm = ?, end_hm = ?, active = ? WHERE id = ?', v.name, v.kind, v.place, v.every, v.start, v.end, req.body.active ? 1 : 0, a.id);
    h.log(req, 'Changed a cleaning area', 'sec_clean_area', a.id, v.name);
    back(req, res, `/admin/security/cleaning/areas/${a.id}`, 'ok', tr('Saved.'));
  });
  router.post('/security/cleaning/areas/:id/alert', R('agent'), (req, res, next) => {
    const a = db.get('SELECT * FROM sec_clean_areas WHERE id = ?', h.int(req.params.id));
    if (!a) return next();
    cleaningAlert({ area_id: a.id, note: h.str(req.body.note, 300) || null, source: 'staff' });
    h.log(req, 'Raised a cleaning alert', 'sec_clean_area', a.id, a.name);
    back(req, res, `/admin/security/cleaning/areas/${a.id}`, 'ok', tr('sec|Cleaning alert raised.'));
  });
  // the cleaner's phone
  router.get('/security/clean/:token', (req, res, next) => {
    const a = db.get('SELECT * FROM sec_clean_areas WHERE token = ?', String(req.params.token));
    if (!a) return next();
    const s = areaState(a);
    const form = ui.form(`/admin/security/clean/${esc(a.token)}`, req.session.csrf, `${ui.input('cleaner', tr('sec|Cleaner'), req.user.name, { hint: tr('sec|Change it if you are using a colleague’s phone.') })}${ui.textarea('note', tr('sec|Note'), '', { rows: 2, placeholder: tr('sec|e.g. Refilled soap and paper') })}${ui.btn(esc(tr('sec|Mark as cleaned')), { cls: 'btn--primary sec-big', ic: 'check' })}<p class="muted small">${esc(tr('sec|Next you can add a photo of the clean area.'))}</p>`, { cls: 'stack' });
    page(req, res, {
      title: a.name, on: '/admin/security/cleaning', crumbs: [['/admin/security/cleaning', tr('sec|Cleaning')], [null, a.code]], wide: false,
      body: `<section class="sec-phone">${ui.card(`${a.code} · ${a.name}`, `<div class="pad"><p>${badge(A_STATE, s.state)} ${s.last ? `<span class="muted small">${esc(tr('sec|last cleaned {time}', { time: ui.dt(s.last.at) }))}</span>` : ''}</p>${s.alert ? `<p class="alert alert--warn">${esc(tr('sec|There is a cleaning alert on this area.'))}</p>` : ''}</div>${form}`)}</section>`,
    });
  });
  router.post('/security/clean/:token', (req, res, next) => {
    const a = db.get('SELECT * FROM sec_clean_areas WHERE token = ?', String(req.params.token));
    if (!a) return next();
    const id = markClean(a, { user: req.user, cleaner: h.str(req.body.cleaner, 80) || req.user.name, note: h.str(req.body.note, 500) || null });
    h.log(req, 'Marked an area as cleaned', 'sec_clean_area', a.id, a.code);
    back(req, res, `/admin/security/cleaning/logs/${id}`, 'ok', tr('sec|Marked as cleaned. Add a photo below.'));
  });
  router.get('/security/cleaning/logs/:id', (req, res, next) => {
    const l = db.get('SELECT l.*, a.name area_name, a.code, a.id area_id, u.name checker FROM sec_clean_logs l JOIN sec_clean_areas a ON a.id = l.area_id LEFT JOIN users u ON u.id = l.checked_by WHERE l.id = ?', h.int(req.params.id));
    if (!l) return next();
    const csrf = req.session.csrf;
    const facts = `<dl class="dl"><div><dt>${esc(tr('sec|Area'))}</dt><dd><a href="/admin/security/cleaning/areas/${l.area_id}">${esc(`${l.code} · ${l.area_name}`)}</a></dd></div><div><dt>${esc(tr('sec|When'))}</dt><dd>${esc(ui.dt(l.at))}</dd></div><div><dt>${esc(tr('sec|Cleaner'))}</dt><dd>${esc(l.cleaner_name || '—')}</dd></div>${l.note ? `<div><dt>${esc(tr('sec|Note'))}</dt><dd>${esc(l.note)}</dd></div>` : ''}<div><dt>${esc(tr('sec|Check'))}</dt><dd>${badge(CHECK, l.check_status)}${l.checker ? ` · ${esc(l.checker)} · ${esc(ui.dt(l.checked_at))}` : ''}${l.check_note ? `<small class="sub">${esc(l.check_note)}</small>` : ''}</dd></div></dl>`;
    const check = h.can(req, 'agent') ? ui.form(`/admin/security/cleaning/logs/${l.id}/check`, csrf, `${ui.input('check_note', tr('sec|Supervisor’s note'), l.check_note || '')}<div class="row">${ui.btn(esc(tr('sec|Checked, it is clean')), { cls: 'btn--primary btn--sm', ic: 'check', attrs: { name: 'result', value: 'ok' } })}${ui.btn(esc(tr('sec|Not good enough, redo')), { cls: 'btn--danger btn--sm', attrs: { name: 'result', value: 'redo' } })}</div>`, { cls: 'stack' }) : '';
    page(req, res, { title: l.area_name, on: '/admin/security/cleaning', crumbs: [['/admin/security/cleaning', tr('sec|Cleaning')], [`/admin/security/cleaning/areas/${l.area_id}`, l.code], [null, ui.dt(l.at)]], wide: false, body: `<div class="stack sec-phone">${ui.card(tr('sec|Clean'), facts)}${cleanDocs(req, 'sec_clean', l.id, { title: tr('sec|Photo of the clean area') })}${check ? ui.card(tr('sec|Supervisor check'), check) : ''}</div>` });
  });
  router.post('/security/cleaning/logs/:id/check', R('agent'), (req, res, next) => {
    const l = db.get('SELECT * FROM sec_clean_logs WHERE id = ?', h.int(req.params.id));
    if (!l) return next();
    const result = req.body.result === 'redo' ? 'redo' : 'ok';
    db.run('UPDATE sec_clean_logs SET check_status = ?, checked_by = ?, checked_at = ?, check_note = ? WHERE id = ?', result, req.user.id, now(), h.str(req.body.check_note, 300) || null, l.id);
    // sent back: the area needs cleaning again
    if (result === 'redo') cleaningAlert({ area_id: l.area_id, note: h.str(req.body.check_note, 300) || null, source: 'check', source_id: l.id });
    h.log(req, result === 'ok' ? 'Checked a clean' : 'Sent a clean back', 'sec_clean_log', l.id, '');
    back(req, res, '/admin/security/cleaning', 'ok', result === 'ok' ? tr('sec|Checked.') : tr('sec|Sent back. The area shows a cleaning alert.'));
  });

  // ================= incidents =================
  const incidentBy = (id) => db.get('SELECT i.*, u.name assignee_name, r.name reporter FROM sec_incidents i LEFT JOIN users u ON u.id = i.assignee_id LEFT JOIN users r ON r.id = i.user_id WHERE i.id = ?', id);
  function reportIncident(v, { user = null, demo = 0 } = {}) {
    const t = now();
    const id = Number(db.run(`INSERT INTO sec_incidents (ref, kind, severity, title, place, at, description, people, cctv_ref, police_ref, status, assignee_id, user_id, demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`, db.nextRef('sec_incidents', 'SI', 4, true), I_KINDS[v.kind] ? v.kind : 'other', SEVERITY[v.severity] ? v.severity : 'medium', v.title, v.place || null, v.at || t,
    v.description || null, v.people || null, v.cctv_ref || null, v.police_ref || null, v.assignee_id || null, user ? user.id : null, demo ? 1 : 0, t, t).lastInsertRowid);
    db.run("INSERT INTO sec_incident_notes (incident_id, body, status_to, user_id, at) VALUES (?, NULL, 'open', ?, ?)", id, user ? user.id : null, t);
    h.events.emit('security.incident', { incident: incidentBy(id) });
    return incidentBy(id);
  }
  h.security.reportIncident = reportIncident;
  router.get('/security/incidents', (req, res) => {
    const st = I_STATUS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'open';
    const kind = I_KINDS[req.query.kind] ? req.query.kind : '';
    const where = [st === 'all' ? '1 = 1' : st === 'open' ? "status IN ('open','investigating')" : 'status = ?', ...(kind ? ['kind = ?'] : [])];
    const args = [...(['all', 'open'].includes(st) ? [] : [st]), ...(kind ? [kind] : [])];
    const f = h.listFilters(req, { cols: { date: 'at' }, dateLabel: tr('sec|When'), sort: { date: 'at' }, sorts: [['severity', 'sort|Severity: highest first', "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, at DESC"]] });
    where.push(...f.where); args.push(...f.args);
    const rows = db.all(`SELECT * FROM sec_incidents WHERE ${where.join(' AND ')} ORDER BY ${f.order} LIMIT 300`, ...args);
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const by = db.all('SELECT kind, COUNT(*) n FROM sec_incidents WHERE at >= ? GROUP BY kind ORDER BY n DESC', since);
    const kpis = [
      ui.kpi({ label: tr('sec|Open'), value: ui.n0(db.value("SELECT COUNT(*) FROM sec_incidents WHERE status IN ('open','investigating')")), href: '/admin/security/incidents' }),
      ui.kpi({ label: tr('sec|High or critical, open'), value: ui.n0(db.value("SELECT COUNT(*) FROM sec_incidents WHERE status IN ('open','investigating') AND severity IN ('high','critical')")), tone: db.value("SELECT COUNT(*) FROM sec_incidents WHERE status IN ('open','investigating') AND severity IN ('high','critical')") ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('sec|Last 30 days'), value: ui.n0(by.reduce((s, x) => s + x.n, 0)), sub: esc(by.slice(0, 3).map((x) => `${tr(I_KINDS[x.kind] || x.kind)} ${x.n}`).join(' · ')) }),
    ].join('');
    const table = ui.table([
      { label: tr('sec|Incident'), render: (i) => `<b>${esc(i.title)}</b><small class="sub">${esc(i.ref)} · ${esc(tr(I_KINDS[i.kind] || i.kind))}</small>` },
      { label: tr('sec|When'), sort: (i) => i.at, render: (i) => esc(ui.dt(i.at)) },
      { label: tr('sec|Where'), render: (i) => esc(i.place || '—') },
      { label: tr('sec|Severity'), sort: (i) => Object.keys(SEVERITY).indexOf(i.severity), render: (i) => badge(SEVERITY, i.severity) },
      { label: tr('Status'), render: (i) => badge(I_STATUS, i.status) },
    ], rows, { href: (i) => `/admin/security/incidents/${i.id}`, empty: esc(tr('sec|No incidents.')) });
    const filters = `<form method="get" class="filters">${ui.select('status', tr('Status'), [['open', tr('sec|Not finished')], ...Object.entries(I_STATUS).map(([k, v]) => [k, tr(v[0])]), ['all', tr('All')]], st)}${ui.select('kind', tr('sec|Kind'), tmap(I_KINDS), kind, { blank: tr('All') })}${f.fields}${ui.btn(esc(tr('sec|Show')), { cls: 'btn--ghost btn--sm' })}${f.quick}</form>`;
    page(req, res, { title: tr('sec|Incidents'), on: '/admin/security/incidents', crumbs: [[null, tr('sec|Incidents')]], actions: h.can(req, 'agent') ? ui.btn(esc(tr('sec|Report an incident')), { href: '/admin/security/incidents/new', cls: 'btn--primary', ic: 'plus' }) : '', body: `<div class="kpis kpis--3">${kpis}</div>${filters}${ui.card(tr('sec|Incidents'), table, { sub: esc(tr('sec|Car park incidents are under Parking.')) })}` });
  });
  router.get('/security/incidents/new', R('agent'), (req, res) => {
    const form = ui.form('/admin/security/incidents', req.session.csrf, `<div class="fields">
      ${ui.select('kind', tr('sec|Kind'), tmap(I_KINDS), I_KINDS[req.query.kind] ? req.query.kind : 'security')}
      ${ui.select('severity', tr('sec|Severity'), Object.entries(SEVERITY).map(([k, v]) => [k, tr(v[0])]), 'medium')}
      ${ui.input('title', tr('sec|In a few words'), '', { required: true, placeholder: tr('sec|e.g. Shoplifting at a fashion store') })}
      ${ui.input('at', tr('sec|When'), ui.local(now()).slice(0, 16), { type: 'datetime-local', required: true })}
      ${ui.input('place', tr('sec|Where'), '', { placeholder: tr('sec|e.g. Ground floor, by the fountain') })}
      ${ui.input('cctv_ref', tr('sec|CCTV reference'), '', { placeholder: tr('sec|e.g. Camera 14, 18:42–18:55') })}
      ${ui.input('police_ref', tr('sec|Police report number'), '')}
      ${ui.select('assignee_id', tr('sec|Handled by'), h.users().map((u) => [u.id, u.name]), req.user.id, { blank: tr('sec|Nobody yet') })}
      ${ui.textarea('people', tr('sec|People involved'), '', { rows: 2, cls: 'span-all', placeholder: tr('sec|Names, phone numbers, ID numbers, witnesses') })}
      ${ui.textarea('description', tr('sec|What happened'), '', { rows: 4, cls: 'span-all' })}</div>${ui.btn(esc(tr('sec|Report')), { cls: 'btn--primary' })}`, { cls: 'stack' });
    page(req, res, { title: tr('sec|Report an incident'), on: '/admin/security/incidents', crumbs: [['/admin/security/incidents', tr('sec|Incidents')], [null, tr('sec|New')]], body: ui.card(tr('sec|Report an incident'), form, { sub: esc(tr('sec|Add photos and CCTV stills on the next page.')) }) });
  });
  router.post('/security/incidents', R('agent'), (req, res) => {
    const title = h.str(req.body.title, 160);
    if (!title) return back(req, res, '/admin/security/incidents/new', 'error', tr('sec|Say in a few words what happened.'));
    const i = reportIncident({
      kind: req.body.kind, severity: req.body.severity, title, at: fromLocal(req.body.at), place: h.str(req.body.place, 160), description: h.str(req.body.description, 4000),
      people: h.str(req.body.people, 2000), cctv_ref: h.str(req.body.cctv_ref, 160), police_ref: h.str(req.body.police_ref, 80), assignee_id: h.int(req.body.assignee_id),
    }, { user: req.user });
    h.log(req, 'Reported an incident', 'sec_incident', i.id, `${i.ref} · ${title}`);
    back(req, res, `/admin/security/incidents/${i.id}`, 'ok', tr('sec|Incident {ref} recorded.', { ref: i.ref }));
  });
  router.get('/security/incidents/:id', (req, res, next) => {
    const i = incidentBy(h.int(req.params.id));
    if (!i) return next();
    const notes = db.all('SELECT n.*, u.name user_name FROM sec_incident_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.incident_id = ? ORDER BY n.at, n.id', i.id);
    const facts = `<dl class="dl">
      <div><dt>${esc(tr('sec|Kind'))}</dt><dd>${esc(tr(I_KINDS[i.kind] || i.kind))} · ${badge(SEVERITY, i.severity)}</dd></div>
      <div><dt>${esc(tr('sec|When'))}</dt><dd>${esc(ui.dt(i.at))}</dd></div>
      <div><dt>${esc(tr('sec|Where'))}</dt><dd>${esc(i.place || '—')}</dd></div>
      ${i.people ? `<div><dt>${esc(tr('sec|People involved'))}</dt><dd class="sec-pre">${esc(i.people)}</dd></div>` : ''}
      ${i.cctv_ref ? `<div><dt>${esc(tr('sec|CCTV reference'))}</dt><dd>${esc(i.cctv_ref)}</dd></div>` : ''}
      ${i.police_ref ? `<div><dt>${esc(tr('sec|Police report number'))}</dt><dd>${esc(i.police_ref)}</dd></div>` : ''}
      <div><dt>${esc(tr('sec|Handled by'))}</dt><dd>${esc(i.assignee_name || '—')}</dd></div>
      <div><dt>${esc(tr('sec|Reported by'))}</dt><dd>${esc(i.reporter || '—')} · ${esc(ui.dt(i.created_at))}</dd></div>
      ${i.description ? `<div><dt>${esc(tr('sec|What happened'))}</dt><dd class="sec-pre">${esc(i.description)}</dd></div>` : ''}
      ${i.outcome ? `<div><dt>${esc(tr('sec|Outcome'))}</dt><dd class="sec-pre">${esc(i.outcome)}</dd></div>` : ''}</dl>`;
    const timeline = `<ol class="tl">${notes.map((n) => `<li><span class="tl__ic">${ui.icon(n.status_to ? 'flow' : 'chat')}</span><div><p>${n.status_to ? `<b>${esc(tr((I_STATUS[n.status_to] || [n.status_to])[0]))}</b>` : ''}${n.status_to && n.body ? ' · ' : ''}${n.body ? esc(n.body) : ''}</p><small class="muted">${esc([ui.dt(n.at), n.user_name].filter(Boolean).join(' · '))}</small></div></li>`).join('')}</ol>`;
    const update = h.can(req, 'agent') ? ui.form(`/admin/security/incidents/${i.id}/note`, req.session.csrf, `<div class="fields">${ui.select('status', tr('Status'), Object.entries(I_STATUS).map(([k, v]) => [k, tr(v[0])]), i.status)}${ui.select('severity', tr('sec|Severity'), Object.entries(SEVERITY).map(([k, v]) => [k, tr(v[0])]), i.severity)}${ui.select('assignee_id', tr('sec|Handled by'), h.users().map((u) => [u.id, u.name]), i.assignee_id || '', { blank: tr('sec|Nobody yet') })}${ui.input('cctv_ref', tr('sec|CCTV reference'), i.cctv_ref || '')}${ui.input('police_ref', tr('sec|Police report number'), i.police_ref || '')}
      ${ui.textarea('body', tr('sec|Add to the timeline'), '', { rows: 3, cls: 'span-all' })}${ui.textarea('people', tr('sec|People involved'), i.people || '', { rows: 2, cls: 'span-all' })}${ui.textarea('outcome', tr('sec|Outcome'), i.outcome || '', { rows: 2, cls: 'span-all' })}</div>${ui.btn(esc(tr('Save')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    page(req, res, { title: i.title, on: '/admin/security/incidents', crumbs: [['/admin/security/incidents', tr('sec|Incidents')], [null, i.ref]], body: `<div class="grid grid--side"><div class="stack">${ui.card(i.ref, facts, { action: badge(I_STATUS, i.status) })}${incDocs(req, 'sec_incident', i.id, { title: tr('sec|Photos, CCTV and statements') })}${ui.card(tr('sec|Timeline'), timeline)}</div><div class="stack">${update ? ui.card(tr('sec|Update'), update) : ''}</div></div>` });
  });
  router.post('/security/incidents/:id/note', R('agent'), (req, res, next) => {
    const i = incidentBy(h.int(req.params.id));
    if (!i) return next();
    const status = I_STATUS[req.body.status] ? req.body.status : i.status;
    const body = h.str(req.body.body, 2000) || null;
    const t = now();
    db.tx(() => {
      db.run(`UPDATE sec_incidents SET status = ?, severity = ?, assignee_id = ?, cctv_ref = ?, police_ref = ?, people = ?, outcome = ?, resolved_at = CASE WHEN ? IN ('resolved','closed') THEN COALESCE(resolved_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?`,
        status, SEVERITY[req.body.severity] ? req.body.severity : i.severity, h.int(req.body.assignee_id), h.str(req.body.cctv_ref, 160) || null, h.str(req.body.police_ref, 80) || null,
        h.str(req.body.people, 2000) || null, h.str(req.body.outcome, 2000) || null, status, t, t, i.id);
      if (body || status !== i.status) db.run('INSERT INTO sec_incident_notes (incident_id, body, status_to, user_id, at) VALUES (?, ?, ?, ?, ?)', i.id, body, status !== i.status ? status : null, req.user.id, t);
    });
    h.log(req, 'Updated an incident', 'sec_incident', i.id, `${i.ref} · ${status}`);
    back(req, res, `/admin/security/incidents/${i.id}`, 'ok', tr('Saved.'));
  });

  // ================= lost and found =================
  router.get('/security/lost', (req, res) => {
    const st = L_STATUS[req.query.status] ? req.query.status : req.query.status === 'all' ? 'all' : 'held';
    const q = h.str(req.query.q, 80);
    const where = [...(st === 'all' ? [] : ['status = ?']), ...(q ? ['(item LIKE ? OR description LIKE ? OR ref LIKE ?)'] : [])];
    const args = [...(st === 'all' ? [] : [st]), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])];
    const f = h.listFilters(req, { cols: { date: 'found_at' }, dateLabel: tr('sec|Found'), sort: { date: 'found_at', name: 'item' } });
    where.push(...f.where); args.push(...f.args);
    const rows = db.all(`SELECT * FROM sec_lost ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${f.order} LIMIT 300`, ...args);
    const table = ui.table([
      { label: tr('sec|Item'), render: (l) => `<b>${esc(l.item)}</b><small class="sub">${esc(l.ref)} · ${esc(tr(L_CATS[l.category] || l.category))}</small>` },
      { label: tr('sec|Found'), sort: (l) => l.found_at, render: (l) => `${esc(ui.dt(l.found_at))}${l.found_where ? `<small class="sub">${esc(l.found_where)}</small>` : ''}` },
      { label: tr('sec|Kept at'), render: (l) => esc(l.stored_at || '—') },
      { label: tr('sec|Returned to'), render: (l) => (l.returned_to ? `${esc(l.returned_to)}<small class="sub">${esc(ui.dt(l.returned_at))}</small>` : '—') },
      { label: tr('Status'), render: (l) => badge(L_STATUS, l.status) },
    ], rows, { href: (l) => `/admin/security/lost/${l.id}`, empty: esc(tr('sec|Nothing here.')) });
    const filters = `<form method="get" class="filters">${ui.select('status', tr('Status'), [...Object.entries(L_STATUS).map(([k, v]) => [k, tr(v[0])]), ['all', tr('All')]], st)}${ui.input('q', tr('sec|Search'), q, { placeholder: tr('sec|e.g. black wallet') })}${f.fields}${ui.btn(esc(tr('sec|Show')), { cls: 'btn--ghost btn--sm' })}${f.quick}</form>`;
    const add = h.can(req, 'agent') ? ui.form('/admin/security/lost', req.session.csrf, `<div class="fields">${ui.input('item', tr('sec|Item'), '', { required: true, placeholder: tr('sec|e.g. Black leather wallet') })}${ui.select('category', tr('sec|Kind'), tmap(L_CATS), 'wallet')}${ui.input('found_at', tr('sec|Found'), ui.local(now()).slice(0, 16), { type: 'datetime-local' })}${ui.input('found_where', tr('sec|Found where'), '', { placeholder: tr('sec|e.g. Food court, table 12') })}${ui.input('found_by', tr('sec|Found by'), '')}${ui.input('stored_at', tr('sec|Kept at'), db.setting('sec_lost_store') || '', { placeholder: tr('sec|e.g. Security office, locker 3') })}${ui.textarea('description', tr('sec|Description'), '', { rows: 2, cls: 'span-all', placeholder: tr('sec|Colour, brand, what is inside (do not write card numbers)') })}</div>${ui.btn(esc(tr('sec|Log the item')), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' }) : '';
    page(req, res, { title: tr('sec|Lost & found'), on: '/admin/security/lost', crumbs: [[null, tr('sec|Lost & found')]], actions: ui.btn(esc(tr('sec|Car park lost & found')), { href: '/admin/parking/lost', cls: 'btn--ghost', ic: 'car' }), body: `${filters}<div class="grid grid--side"><div>${ui.card(tr('sec|Items'), table, { sub: esc(tr('sec|Write down who an item is returned to, with their ID.')) })}</div><div>${add ? ui.card(tr('sec|An item was found'), add) : ''}</div></div>` });
  });
  router.post('/security/lost', R('agent'), (req, res) => {
    const item = h.str(req.body.item, 160);
    if (!item) return back(req, res, '/admin/security/lost', 'error', tr('sec|Describe the item.'));
    const stored = h.str(req.body.stored_at, 120) || null;
    if (stored) db.setSetting('sec_lost_store', stored);
    const id = Number(db.run('INSERT INTO sec_lost (ref, item, category, description, found_at, found_where, found_by, stored_at, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      db.nextRef('sec_lost', 'LF', 4, true), item, L_CATS[req.body.category] ? req.body.category : 'other', h.str(req.body.description, 1000) || null, req.body.found_at ? fromLocal(req.body.found_at) : now(),
      h.str(req.body.found_where, 160) || null, h.str(req.body.found_by, 120) || null, stored, req.user.id, now()).lastInsertRowid);
    h.log(req, 'Logged a found item', 'sec_lost', id, item);
    back(req, res, `/admin/security/lost/${id}`, 'ok', tr('sec|Item logged. Add a photo.'));
  });
  router.get('/security/lost/:id', (req, res, next) => {
    const l = db.get('SELECT l.*, u.name returned_name, f.name logged_by FROM sec_lost l LEFT JOIN users u ON u.id = l.returned_by LEFT JOIN users f ON f.id = l.user_id WHERE l.id = ?', h.int(req.params.id));
    if (!l) return next();
    const facts = `<dl class="dl"><div><dt>${esc(tr('sec|Item'))}</dt><dd><b>${esc(l.item)}</b> · ${esc(tr(L_CATS[l.category] || l.category))}</dd></div>${l.description ? `<div><dt>${esc(tr('sec|Description'))}</dt><dd>${esc(l.description)}</dd></div>` : ''}<div><dt>${esc(tr('sec|Found'))}</dt><dd>${esc(ui.dt(l.found_at))}${l.found_where ? ` · ${esc(l.found_where)}` : ''}${l.found_by ? ` · ${esc(l.found_by)}` : ''}</dd></div><div><dt>${esc(tr('sec|Kept at'))}</dt><dd>${esc(l.stored_at || '—')}</dd></div>${l.owner_contact ? `<div><dt>${esc(tr('sec|Owner’s contact'))}</dt><dd>${esc(l.owner_contact)}</dd></div>` : ''}${l.returned_to ? `<div><dt>${esc(tr('sec|Returned to'))}</dt><dd>${esc(l.returned_to)}${l.returned_id ? ` · ${esc(tr('sec|ID {id}', { id: l.returned_id }))}` : ''} · ${esc(ui.dt(l.returned_at))}${l.returned_name ? ` · ${esc(l.returned_name)}` : ''}</dd></div>` : ''}<div><dt>${esc(tr('sec|Logged by'))}</dt><dd>${esc(l.logged_by || '—')}</dd></div></dl>`;
    const act = h.can(req, 'agent') && l.status === 'held' ? `${ui.form(`/admin/security/lost/${l.id}/return`, req.session.csrf, `<div class="fields">${ui.input('returned_to', tr('sec|Returned to (name)'), '', { required: true })}${ui.input('returned_id', tr('sec|Their national ID or passport'), '', { required: true })}${ui.input('owner_contact', tr('sec|Their mobile'), l.owner_contact || '', { type: 'tel' })}</div>${ui.btn(esc(tr('sec|Hand it back')), { cls: 'btn--primary btn--sm', ic: 'check' })}`, { cls: 'stack' })}<details class="pad"><summary>${esc(tr('sec|Donated or disposed'))}</summary>${ui.form(`/admin/security/lost/${l.id}/dispose`, req.session.csrf, `${ui.input('note', tr('sec|How'), '', { placeholder: tr('sec|e.g. Donated to charity after 90 days') })}${ui.btn(esc(tr('Save')), { cls: 'btn--ghost btn--sm' })}`, { cls: 'stack' })}</details>` : '';
    page(req, res, { title: l.item, on: '/admin/security/lost', crumbs: [['/admin/security/lost', tr('sec|Lost & found')], [null, l.ref]], body: `<div class="grid grid--side"><div class="stack">${ui.card(l.ref, facts, { action: badge(L_STATUS, l.status) })}${lostDocs(req, 'sec_lost', l.id, { title: tr('sec|Photos and signed receipt') })}</div><div class="stack">${act ? ui.card(tr('sec|The owner came'), act) : ''}</div></div>` });
  });
  router.post('/security/lost/:id/return', R('agent'), (req, res, next) => {
    const l = db.get("SELECT * FROM sec_lost WHERE id = ? AND status = 'held'", h.int(req.params.id));
    if (!l) return next();
    const to = h.str(req.body.returned_to, 120);
    const idNo = h.str(req.body.returned_id, 40);
    if (!to || !idNo) return back(req, res, `/admin/security/lost/${l.id}`, 'error', tr('sec|Enter the name and ID of the person collecting it.'));
    db.run("UPDATE sec_lost SET status = 'returned', returned_to = ?, returned_id = ?, owner_contact = COALESCE(?, owner_contact), returned_at = ?, returned_by = ? WHERE id = ?", to, idNo, h.str(req.body.owner_contact, 40) || null, now(), req.user.id, l.id);
    h.log(req, 'Returned a found item', 'sec_lost', l.id, `${l.ref} · ${to}`);
    back(req, res, `/admin/security/lost/${l.id}`, 'ok', tr('sec|Handed back.'));
  });
  router.post('/security/lost/:id/dispose', R('agent'), (req, res, next) => {
    const l = db.get("SELECT * FROM sec_lost WHERE id = ? AND status = 'held'", h.int(req.params.id));
    if (!l) return next();
    db.run("UPDATE sec_lost SET status = 'disposed', returned_to = ?, returned_at = ?, returned_by = ? WHERE id = ?", h.str(req.body.note, 160) || null, now(), req.user.id, l.id);
    h.log(req, 'Disposed of a found item', 'sec_lost', l.id, l.ref);
    back(req, res, `/admin/security/lost/${l.id}`, 'ok', tr('Saved.'));
  });

  // ================= keys =================
  const keyOut = (id) => db.value('SELECT COUNT(*) FROM sec_key_loans WHERE key_id = ? AND returned_at IS NULL', id);
  router.get('/security/keys', (req, res) => {
    const keys = db.all('SELECT * FROM sec_keys WHERE active = 1 ORDER BY code');
    const f = h.listFilters(req, { cols: { date: 'l.issued_at' }, dateLabel: tr('sec|Issued'), sort: { due: 'l.due_at', date: 'l.issued_at', name: 'l.issued_to' }, defaultSort: 'due' });
    const loans = db.all(`SELECT l.*, k.code, k.opens, u.name issuer FROM sec_key_loans l JOIN sec_keys k ON k.id = l.key_id LEFT JOIN users u ON u.id = l.issued_by WHERE l.returned_at IS NULL${f.sql} ORDER BY ${f.order}`, ...f.args);
    const t = now();
    const csrf = req.session.csrf;
    const loanTable = ui.table([
      { label: tr('sec|Key'), render: (l) => `<b class="ltr">${esc(l.code)}</b><small class="sub">${esc(l.opens)}</small>` },
      { label: tr('sec|With'), render: (l) => `${esc(l.issued_to)}${l.company ? `<small class="sub">${esc(l.company)}</small>` : ''}` },
      { label: tr('sec|Issued'), render: (l) => `${esc(ui.dt(l.issued_at))}${l.purpose ? `<small class="sub">${esc(l.purpose)}</small>` : ''}` },
      { label: tr('sec|Due back'), sort: (l) => l.due_at, render: (l) => `<span class="${l.due_at < t ? 'late' : ''}">${esc(ui.dt(l.due_at))}</span>${l.due_at < t ? `<small class="sub late">${esc(tr('sec|overdue'))}</small>` : ''}` },
      { label: '', render: (l) => (h.can(req, 'agent') ? ui.form(`/admin/security/keys/loans/${l.id}/return`, csrf, ui.btn(esc(tr('sec|Returned')), { cls: 'btn--ghost btn--sm', ic: 'check' })) : '') },
    ], loans, { empty: esc(tr('sec|All keys are in the cabinet.')) });
    const keyTable = ui.table([
      { label: tr('sec|Key'), sort: (k) => k.code, render: (k) => `<b class="ltr">${esc(k.code)}</b><small class="sub">${esc(tr(K_KINDS[k.kind] || k.kind))}</small>` },
      { label: tr('sec|Opens'), render: (k) => `${esc(k.opens)}${k.place ? `<small class="sub">${esc(k.place)}</small>` : ''}` },
      { label: tr('sec|Kept at'), render: (k) => esc(k.kept_at || '—') },
      { label: tr('sec|In the cabinet'), num: true, render: (k) => { const out = keyOut(k.id); return `<b class="${out >= k.copies ? 'late' : ''}">${k.copies - out}/${k.copies}</b>`; } },
    ], keys, { href: (k) => `/admin/security/keys/${k.id}`, empty: esc(tr('sec|No keys registered yet.')) });
    const issue = h.can(req, 'agent') && keys.length ? ui.form('/admin/security/keys/issue', csrf, `<div class="fields">${ui.select('key_id', tr('sec|Key'), keys.map((k) => [k.id, `${k.code} · ${k.opens} (${k.copies - keyOut(k.id)}/${k.copies})`]), h.int(req.query.key) || '', { required: true })}${ui.input('issued_to', tr('sec|Given to'), '', { required: true, placeholder: tr('sec|Name') })}${ui.input('company', tr('sec|Company or shop'), '', { placeholder: tr('sec|e.g. Cool Air contractors') })}${ui.input('purpose', tr('sec|What for'), '', { placeholder: tr('sec|e.g. AC maintenance, roof') })}${ui.input('due_at', tr('sec|Due back'), ui.local(new Date(Date.now() + 4 * 3600000).toISOString()).slice(0, 16), { type: 'datetime-local', required: true })}</div>${ui.btn(esc(tr('sec|Issue the key')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    const add = h.can(req, 'manager') ? `<details class="pad"><summary>${esc(tr('sec|Register a key'))}</summary>${ui.form('/admin/security/keys', csrf, `<div class="fields">${ui.input('code', tr('sec|Code'), `K-${String(db.value('SELECT COUNT(*) FROM sec_keys') + 1).padStart(3, '0')}`, { required: true })}${ui.select('kind', tr('sec|Kind'), tmap(K_KINDS), 'key')}${ui.input('opens', tr('sec|Opens'), '', { required: true, placeholder: tr('sec|e.g. Roof plant room door') })}${ui.input('place', tr('sec|Floor or zone'), '')}${ui.input('copies', tr('sec|Copies'), 1, { type: 'number', min: 1, max: 50 })}${ui.input('kept_at', tr('sec|Kept at'), '', { placeholder: tr('sec|e.g. Key cabinet, hook 14') })}</div>${ui.btn(esc(tr('sec|Register')), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' })}</details>` : '';
    const overdue = loans.filter((l) => l.due_at < t).length;
    page(req, res, { title: tr('sec|Keys'), on: '/admin/security/keys', crumbs: [[null, tr('sec|Keys')]], body: `<div class="kpis kpis--3">${ui.kpi({ label: tr('sec|Keys out'), value: ui.n0(loans.length) })}${ui.kpi({ label: tr('sec|Overdue'), value: ui.n0(overdue), tone: overdue ? 'kpi--alert' : '' })}${ui.kpi({ label: tr('sec|Master keys out'), value: ui.n0(loans.filter((l) => db.value('SELECT kind FROM sec_keys WHERE id = ?', l.key_id) === 'master').length) })}</div>
      ${f.html}<div class="grid grid--side"><div class="stack">${ui.card(tr('sec|Keys out'), loanTable)}${ui.card(tr('sec|Key register'), `${keyTable}${add}`)}</div><div>${issue ? ui.card(tr('sec|Issue a key'), issue) : ''}</div></div>` });
  });
  router.post('/security/keys', R('manager'), (req, res) => {
    const code = h.str(req.body.code, 20).toUpperCase();
    const opens = h.str(req.body.opens, 160);
    if (!code || !opens) return back(req, res, '/admin/security/keys', 'error', tr('sec|Enter the code and what it opens.'));
    if (db.get('SELECT id FROM sec_keys WHERE code = ?', code)) return back(req, res, '/admin/security/keys', 'error', tr('sec|The code {code} is already used.', { code }));
    const id = Number(db.run('INSERT INTO sec_keys (code, kind, opens, place, copies, kept_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', code, K_KINDS[req.body.kind] ? req.body.kind : 'key', opens, h.str(req.body.place, 120) || null, Math.max(1, Math.min(50, h.int(req.body.copies) || 1)), h.str(req.body.kept_at, 120) || null, now()).lastInsertRowid);
    h.log(req, 'Registered a key', 'sec_key', id, `${code} · ${opens}`);
    back(req, res, '/admin/security/keys', 'ok', tr('Saved.'));
  });
  router.post('/security/keys/issue', R('agent'), (req, res) => {
    const k = db.get('SELECT * FROM sec_keys WHERE id = ? AND active = 1', h.int(req.body.key_id));
    const to = h.str(req.body.issued_to, 120);
    if (!k || !to) return back(req, res, '/admin/security/keys', 'error', tr('sec|Choose the key and who it is given to.'));
    if (keyOut(k.id) >= k.copies) return back(req, res, '/admin/security/keys', 'error', tr('sec|Every copy of {code} is out.', { code: k.code }));
    const due = req.body.due_at ? fromLocal(req.body.due_at) : new Date(Date.now() + 4 * 3600000).toISOString();
    db.run('INSERT INTO sec_key_loans (key_id, issued_to, company, purpose, issued_at, due_at, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?)', k.id, to, h.str(req.body.company, 120) || null, h.str(req.body.purpose, 200) || null, now(), due, req.user.id);
    h.log(req, 'Issued a key', 'sec_key', k.id, `${k.code} · ${to}`);
    back(req, res, '/admin/security/keys', 'ok', tr('sec|{code} issued to {name}.', { code: k.code, name: to }));
  });
  router.post('/security/keys/loans/:id/return', R('agent'), (req, res, next) => {
    const l = db.get('SELECT l.*, k.code FROM sec_key_loans l JOIN sec_keys k ON k.id = l.key_id WHERE l.id = ? AND l.returned_at IS NULL', h.int(req.params.id));
    if (!l) return next();
    db.run('UPDATE sec_key_loans SET returned_at = ?, returned_by = ? WHERE id = ?', now(), req.user.id, l.id);
    h.log(req, 'Key returned', 'sec_key', l.key_id, `${l.code} · ${l.issued_to}`);
    back(req, res, h.safeBack(req, '/admin/security/keys'), 'ok', tr('sec|{code} is back in the cabinet.', { code: l.code }));
  });
  router.get('/security/keys/:id', (req, res, next) => {
    const k = db.get('SELECT * FROM sec_keys WHERE id = ?', h.int(req.params.id));
    if (!k) return next();
    const loans = db.all('SELECT l.*, a.name issuer, b.name receiver FROM sec_key_loans l LEFT JOIN users a ON a.id = l.issued_by LEFT JOIN users b ON b.id = l.returned_by WHERE l.key_id = ? ORDER BY l.issued_at DESC LIMIT 100', k.id);
    const t = now();
    const table = ui.table([
      { label: tr('sec|With'), render: (l) => `${esc(l.issued_to)}${l.company ? `<small class="sub">${esc(l.company)}</small>` : ''}` },
      { label: tr('sec|Issued'), render: (l) => `${esc(ui.dt(l.issued_at))}<small class="sub">${esc([l.issuer, l.purpose].filter(Boolean).join(' · '))}</small>` },
      { label: tr('sec|Due back'), render: (l) => esc(ui.dt(l.due_at)) },
      { label: tr('sec|Returned'), render: (l) => (l.returned_at ? `${esc(ui.dt(l.returned_at))}${l.returned_at > l.due_at ? `<small class="sub late">${esc(tr('sec|late'))}</small>` : ''}` : `<span class="${l.due_at < t ? 'late' : ''}">${esc(l.due_at < t ? tr('sec|overdue') : tr('sec|out'))}</span>`) },
    ], loans, { empty: esc(tr('sec|Never issued.')) });
    const out = keyOut(k.id);
    const facts = `<dl class="dl"><div><dt>${esc(tr('sec|Kind'))}</dt><dd>${esc(tr(K_KINDS[k.kind] || k.kind))}</dd></div><div><dt>${esc(tr('sec|Opens'))}</dt><dd>${esc(k.opens)}${k.place ? ` · ${esc(k.place)}` : ''}</dd></div><div><dt>${esc(tr('sec|Kept at'))}</dt><dd>${esc(k.kept_at || '—')}</dd></div><div><dt>${esc(tr('sec|In the cabinet'))}</dt><dd><b>${k.copies - out}/${k.copies}</b></dd></div></dl>${h.can(req, 'agent') && out < k.copies ? `<p class="pad">${ui.btn(esc(tr('sec|Issue the key')), { href: `/admin/security/keys?key=${k.id}`, cls: 'btn--primary btn--sm' })}</p>` : ''}`;
    page(req, res, { title: `${k.code} · ${k.opens}`, on: '/admin/security/keys', crumbs: [['/admin/security/keys', tr('sec|Keys')], [null, k.code]], body: `<div class="grid grid--side"><div>${ui.card(tr('sec|Issue and return log'), table)}</div><div>${ui.card(k.code, facts)}</div></div>` });
  });

  // ================= handover log =================
  router.get('/security/handover', (req, res) => {
    const f = h.listFilters(req, { cols: { date: 'x.at' }, dateLabel: tr('sec|Handover log'), sort: { date: 'x.at' } });
    const rows = db.all(`SELECT x.*, u.name user_name, a.name ack_name FROM sec_handover x LEFT JOIN users u ON u.id = x.user_id LEFT JOIN users a ON a.id = x.ack_by ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''} ORDER BY ${f.order} LIMIT 60`, ...f.args);
    const shift = shiftOf(now());
    const day = localDay();
    const p = patrolDay(day);
    const facts = [
      tr('sec|Open incidents: {n}', { n: db.value("SELECT COUNT(*) FROM sec_incidents WHERE status IN ('open','investigating')") }),
      tr('sec|Keys out: {n} ({late} overdue)', { n: db.value('SELECT COUNT(*) FROM sec_key_loans WHERE returned_at IS NULL'), late: db.value('SELECT COUNT(*) FROM sec_key_loans WHERE returned_at IS NULL AND due_at < ?', now()) }),
      tr('sec|Patrol checkpoints today: {pct}', { pct: pctTxt(p.pct) }),
      tr('sec|Cleaning alerts: {n}', { n: db.value('SELECT COUNT(*) FROM sec_clean_alerts WHERE resolved_at IS NULL') }),
    ];
    const csrf = req.session.csrf;
    const form = h.can(req, 'agent') ? ui.form('/admin/security/handover', csrf, `<div class="fields">${ui.select('shift', tr('sec|Shift ending'), Object.entries(SHIFTS).map(([k, v]) => [k, tr(v[0])]), shift)}${ui.input('to_name', tr('sec|Handed to'), '', { attrs: { list: 'sec-users' } })}</div><datalist id="sec-users">${h.users().map((u) => `<option value="${esc(u.name)}">`).join('')}</datalist>
      <ul class="sec-facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${ui.textarea('summary', tr('sec|What happened on the shift'), '', { rows: 5 })}${ui.textarea('open_items', tr('sec|Open items for the next shift'), '', { rows: 3 })}${ui.btn(esc(tr('sec|Write the handover')), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' }) : '';
    const list = rows.length ? `<ol class="sec-log">${rows.map((x) => `<li><header><b>${esc(tr(SHIFTS[x.shift] ? SHIFTS[x.shift][0] : x.shift))}</b><span class="muted">${esc(ui.dt(x.at))} · ${esc(x.user_name || '—')}${x.to_name ? ` → ${esc(x.to_name)}` : ''}</span>${x.ack_at ? ui.badge('ok', tr('sec|Read by {name}', { name: x.ack_name || '—' }), 'ok') : h.can(req, 'agent') && x.user_id !== req.user.id ? ui.form(`/admin/security/handover/${x.id}/ack`, csrf, ui.btn(esc(tr('sec|I have read it')), { cls: 'btn--ghost btn--sm', ic: 'check' })) : ui.badge('pending', tr('sec|Not read yet'), 'amber')}</header><p class="sec-pre">${esc(x.summary)}</p>${x.open_items ? `<p class="sec-pre sec-open"><b>${esc(tr('sec|Open items'))}:</b> ${esc(x.open_items)}</p>` : ''}</li>`).join('')}</ol>` : `<p class="muted pad">${esc(tr('sec|No handover written yet.'))}</p>`;
    page(req, res, { title: tr('sec|Handover log'), on: '/admin/security/handover', crumbs: [[null, tr('sec|Handover log')]], body: `${f.html}<div class="grid grid--side"><div>${ui.card(tr('sec|Handover log'), list)}</div><div>${form ? ui.card(tr('sec|Write the handover'), form) : ''}</div></div>` });
  });
  router.post('/security/handover', R('agent'), (req, res) => {
    const summary = h.str(req.body.summary, 4000);
    if (!summary) return back(req, res, '/admin/security/handover', 'error', tr('sec|Write what happened on the shift.'));
    const id = Number(db.run('INSERT INTO sec_handover (shift, user_id, to_name, summary, open_items, at) VALUES (?, ?, ?, ?, ?, ?)', SHIFTS[req.body.shift] ? req.body.shift : shiftOf(now()), req.user.id, h.str(req.body.to_name, 120) || null, summary, h.str(req.body.open_items, 2000) || null, now()).lastInsertRowid);
    h.log(req, 'Wrote the shift handover', 'sec_handover', id, '');
    back(req, res, '/admin/security/handover', 'ok', tr('Saved.'));
  });
  router.post('/security/handover/:id/ack', R('agent'), (req, res, next) => {
    const x = db.get('SELECT * FROM sec_handover WHERE id = ? AND ack_at IS NULL', h.int(req.params.id));
    if (!x) return next();
    db.run('UPDATE sec_handover SET ack_by = ?, ack_at = ? WHERE id = ?', req.user.id, now(), x.id);
    back(req, res, '/admin/security/handover', 'ok', tr('Saved.'));
  });
};

module.exports.SCHEMA = SCHEMA;
module.exports.SHIFTS = SHIFTS;
module.exports.AREA_KINDS = AREA_KINDS;
