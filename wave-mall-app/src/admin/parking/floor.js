'use strict';

// The parking levels as live floor plans. Each level is drawn in the plan's coordinate system
// (1000 × 640, west on the left, like src/plan.js): the outline, the two lift cores, the ramps, the
// driving aisles and every bay, numbered by section (B1-A01). Bays are stored (pk_bays) so they can
// carry a type (accessible, electric, VIP, reserved for bookings, valet), a sensor and a state.
//
// What a bay shows, in order: switched off; taken or free from its sensor (when it reported in the
// last 10 minutes); taken by a car the office knows is there (a booking, a valet car); held for a
// booking about to start; otherwise an estimate from the level's count at the gates, filling the
// bays nearest the lifts first, as drivers do. The page says which it is.

const W = 1000;
const H = 640;
const BAY_W = 22;
const BAY_H = 40;
const GROUP = 3; // a structural column after every three bays
const COL = 6;
// six rows of bays in three double rows, with aisles between (y of each row's top edge)
const ROWS = [150, 190, 280, 320, 410, 450];
const SECTIONS = [['A', 'B'], ['C', 'D'], ['E', 'F']];
const CORES = [[440, 50, 120, 62], [440, 528, 120, 62]];
const FRESH_MS = 10 * 60000;

// Where each level's bays may go, and what else is drawn there.
const LEVELS = {
  B1: { x0: 168, x1: 872, shops: 7, ramps: [{ x: 890, y: 70, w: 58, h: 200, label: 'ramp-down', to: 'B2' }, { x: 890, y: 370, w: 58, h: 200, label: 'ramp-up', to: 'street' }] },
  B2: { x0: 60, x1: 872, shops: 0, ramps: [{ x: 890, y: 70, w: 58, h: 200, label: 'ramp-up', to: 'B1' }] },
};
const levelOf = (z) => LEVELS[String(z.level || z.code).toUpperCase()] || LEVELS.B2;
const r1 = (n) => Math.round(n * 10) / 10;

// The bays of a level with `n` spaces: spread over the six rows as evenly as they fit, each row
// centred in the level, in groups of three between columns. Returns [{ code, section, x, y, w, h }].
function layout(zone, n) {
  const L = levelOf(zone);
  const span = L.x1 - L.x0;
  const perRowMax = Math.floor((span + COL) / (GROUP * BAY_W + COL)) * GROUP;
  const rows = ROWS.length;
  const total = Math.min(n, perRowMax * rows);
  const base = Math.floor(total / rows);
  let extra = total - base * rows;
  const out = [];
  const counters = {};
  ROWS.forEach((y, ri) => {
    const count = base + (extra-- > 0 ? 1 : 0);
    const groups = Math.ceil(count / GROUP);
    const width = count * BAY_W + (groups - 1) * COL;
    let x = L.x0 + (span - width) / 2;
    const pair = SECTIONS[Math.floor(ri / 2)];
    for (let i = 0; i < count; i++) {
      if (i > 0 && i % GROUP === 0) x += COL;
      const section = x + BAY_W / 2 < (L.x0 + L.x1) / 2 ? pair[0] : pair[1];
      counters[section] = (counters[section] || 0) + 1;
      out.push({ code: `${zone.code}-${section}${String(counters[section]).padStart(2, '0')}`, section, x: r1(x), y, w: BAY_W, h: BAY_H });
      x += BAY_W;
    }
  });
  return out;
}

// Which bays are special when a level is first drawn: accessible and VIP next to the lifts,
// electric charging at the east end, bookable and valet bays on the lower ground.
function defaultKinds(zone, bays) {
  const kinds = new Map();
  const nearLifts = [...bays].sort((a, b) => liftDistance(a) - liftDistance(b));
  nearLifts.slice(0, 4).forEach((b) => kinds.set(b.code, 'accessible'));
  if (String(zone.code).toUpperCase() === 'B1') {
    nearLifts.slice(4, 8).forEach((b) => kinds.set(b.code, 'vip'));
    nearLifts.filter((b) => !kinds.has(b.code) && b.section === 'C').slice(0, 10).forEach((b) => kinds.set(b.code, 'reserved'));
    [...bays].filter((b) => b.section === 'E').sort((a, b) => a.x - b.x).slice(0, 12).forEach((b) => kinds.set(b.code, 'valet'));
  }
  [...bays].filter((b) => b.y === ROWS[2] || b.y === ROWS[3]).sort((a, b) => b.x - a.x).slice(0, 4).forEach((b) => { if (!kinds.has(b.code)) kinds.set(b.code, 'ev'); });
  return kinds;
}
function liftDistance(b) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return Math.min(...CORES.map(([x, y, w, h]) => Math.hypot(cx - (x + w / 2), cy - (y + h / 2))));
}

// Draw (or redraw) a level's bays to match its spaces. Bays keep their type and sensor when their
// code survives the redraw.
function drawBays(db, zone) {
  const bays = layout(zone, zone.capacity || 0);
  const old = new Map(db.all('SELECT * FROM pk_bays WHERE zone_id = ?', zone.id).map((b) => [b.code, b]));
  const kinds = old.size ? new Map() : defaultKinds(zone, bays);
  db.tx(() => {
    for (const b of bays) {
      const o = old.get(b.code);
      if (o) {
        db.run('UPDATE pk_bays SET section = ?, x = ?, y = ?, w = ?, h = ? WHERE id = ?', b.section, b.x, b.y, b.w, b.h, o.id);
        old.delete(b.code);
      } else {
        db.run('INSERT INTO pk_bays (zone_id, code, section, x, y, w, h, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', zone.id, b.code, b.section, b.x, b.y, b.w, b.h, kinds.get(b.code) || 'general');
      }
    }
    // bays the level no longer has
    for (const o of old.values()) {
      db.run('UPDATE pk_sessions SET bay_id = NULL WHERE bay_id = ?', o.id);
      db.run('DELETE FROM pk_bays WHERE id = ?', o.id);
    }
  });
  return bays.length;
}

// The state of every bay on a level, and how it was known.
// Returns { bays: [{ ...bay, state, why, plate, booking, valet, violation }], counts, mode }.
function states(db, zone, { cars = 0, now = Date.now() } = {}) {
  const bays = db.all('SELECT * FROM pk_bays WHERE zone_id = ? ORDER BY y, x', zone.id);
  const iso = new Date(now).toISOString();
  const soon = new Date(now + 2 * 3600000).toISOString();
  const by = new Map(bays.map((b) => [b.id, b]));
  const known = new Map();
  // cars the office knows are in a bay: arrived bookings, valet cars, visits placed on a bay
  for (const s of db.all("SELECT id, bay_id, plate, kind FROM pk_sessions WHERE status = 'inside' AND bay_id IS NOT NULL AND zone_id = ?", zone.id)) known.set(s.bay_id, { why: 'visit', plate: s.plate, session: s.id });
  for (const v of db.all("SELECT id, bay_id, plate, tag FROM pk_valet WHERE status IN ('parked','requested','ready') AND bay_id IS NOT NULL")) if (by.has(v.bay_id)) known.set(v.bay_id, { why: 'valet', plate: v.plate, valet: v.id, tag: v.tag });
  const held = new Map(db.all("SELECT id, bay_id, ref, starts_at, ends_at, plate FROM pk_bookings WHERE status = 'confirmed' AND bay_id IS NOT NULL AND starts_at <= ? AND ends_at > ?", soon, iso).map((b) => [b.bay_id, b]));
  const flagged = new Map(db.all("SELECT bay_id, COUNT(*) n FROM pk_violations WHERE bay_id IS NOT NULL AND status IN ('charged','unpaid','open') AND at >= ? GROUP BY bay_id", new Date(now - 86400000).toISOString()).map((v) => [v.bay_id, v.n]));
  const sensed = bays.filter((b) => b.sensor && b.state && b.state_at && now - Date.parse(b.state_at) < FRESH_MS).length;
  const mode = sensed >= bays.length * 0.8 && bays.length ? 'sensors' : sensed ? 'mixed' : 'estimate';
  const out = bays.map((b) => {
    const x = { ...b, flags: [], violation: flagged.get(b.id) || 0 };
    const k = known.get(b.id);
    if (!b.active) return { ...x, state: 'off', why: 'off' };
    if (b.sensor && b.state && b.state_at && now - Date.parse(b.state_at) < FRESH_MS) return { ...x, state: b.state === 'taken' ? 'taken' : 'free', why: 'sensor', plate: b.plate || (k && k.plate) || null, ...(k || {}) };
    if (k) return { ...x, state: 'taken', ...k };
    if (held.has(b.id)) return { ...x, state: 'held', why: 'booking', booking: held.get(b.id) };
    return { ...x, state: null, why: 'estimate' };
  });
  // the rest of the level's cars: the bays nearest the lifts, ordinary bays first
  let left = Math.max(0, cars - out.filter((b) => b.state === 'taken').length);
  const open = out.filter((b) => b.state === null).sort((a, b) => (a.kind === 'general' ? 0 : 1) - (b.kind === 'general' ? 0 : 1) || liftDistance(a) - liftDistance(b));
  for (const b of open) {
    if (left > 0 && b.kind !== 'reserved' && b.kind !== 'valet') { b.state = 'taken'; b.why = 'estimate'; left--; } else b.state = 'free';
  }
  const counts = out.reduce((c, b) => ({ ...c, [b.state]: (c[b.state] || 0) + 1 }), { taken: 0, free: 0, held: 0, off: 0 });
  return { bays: out, counts, mode };
}

// The level as an SVG. labels: { lifts, rampUp, rampDown, street, shops } in the reader's language.
function svg(zone, list, { labels = {}, selected = null } = {}) {
  const L = levelOf(zone);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let s = `<rect class="pkf-outline" x="40" y="40" width="${W - 80}" height="${H - 80}" rx="18"/>`;
  // aisles with the direction of travel
  for (const [y, dir] of [[104, 1], [234, -1], [364, 1], [494, -1]]) {
    s += `<rect class="pkf-aisle" x="${L.x0 - 8}" y="${y}" width="${L.x1 - L.x0 + 16}" height="42" rx="6"/>`;
    for (let x = L.x0 + 40; x < L.x1 - 20; x += 120) s += `<path class="pkf-arrow" d="${dir > 0 ? `M${x} ${y + 21}h18l-6 -5m6 5l-6 5` : `M${x + 18} ${y + 21}h-18l6 -5m-6 5l6 5`}"/>`;
  }
  for (const [x, y, w, h] of CORES) s += `<rect class="pkf-core" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/><text class="pkf-label" x="${x + w / 2}" y="${y + h / 2 + 4}">${esc(labels.lifts || 'Lifts')}</text>`;
  for (const r of L.ramps) {
    s += `<rect class="pkf-ramp" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8"/>`;
    const text = r.label === 'ramp-up' ? (r.to === 'street' ? labels.street || 'To the street' : `${labels.rampUp || 'Up to'} ${r.to}`) : `${labels.rampDown || 'Down to'} ${r.to}`;
    s += `<text class="pkf-label pkf-label--v" transform="translate(${r.x + r.w / 2 + 4} ${r.y + r.h / 2}) rotate(-90)">${esc(text)}</text>`;
  }
  if (L.shops) {
    for (let i = 0; i < L.shops; i++) s += `<rect class="pkf-shop" x="52" y="${70 + i * 72}" width="96" height="66" rx="4"/><text class="pkf-label" x="100" y="${108 + i * 72}">S${String(i + 1).padStart(2, '0')}</text>`;
  }
  // section letters in the aisles
  const secs = {};
  for (const b of list) (secs[b.section] = secs[b.section] || []).push(b);
  for (const [sec, bs] of Object.entries(secs)) {
    const xs = bs.map((b) => b.x);
    const ys = bs.map((b) => b.y);
    const cx = (Math.min(...xs) + Math.max(...xs) + BAY_W) / 2;
    const cy = Math.min(...ys) - 20;
    s += `<text class="pkf-sec" x="${r1(cx)}" y="${cy}">${sec}</text>`;
  }
  // the bays
  const ICON = { accessible: '♿', ev: '⚡', vip: '★', valet: 'V', reserved: 'R' };
  for (const b of list) {
    const tip = [b.code, labels.states && labels.states[b.state], b.kind !== 'general' && labels.kinds ? labels.kinds[b.kind] : null, b.plate, b.why === 'estimate' && b.state === 'taken' && labels.estimated ? labels.estimated : null].filter(Boolean).join(' · ');
    s += `<g class="pkf-bay k-${b.kind} s-${b.state}${b.violation ? ' has-violation' : ''}${selected === b.code ? ' is-sel' : ''}${b.why === 'estimate' && b.state === 'taken' ? ' is-est' : ''}" data-bay="${esc(b.code)}" tabindex="0" role="link" aria-label="${esc(tip)}"><title>${esc(tip)}</title>`;
    s += `<rect x="${b.x + 1}" y="${b.y + 1}" width="${b.w - 2}" height="${b.h - 2}" rx="2.5"/>`;
    if (b.state === 'taken') s += `<rect class="pkf-car" x="${b.x + 4}" y="${b.y + (b.y === ROWS[0] || b.y === ROWS[2] || b.y === ROWS[4] ? 6 : 8)}" width="${b.w - 8}" height="${b.h - 14}" rx="4"/>`;
    if (ICON[b.kind]) s += `<text class="pkf-ico" x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 4}">${ICON[b.kind]}</text>`;
    if (b.violation) s += `<circle class="pkf-viol" cx="${b.x + b.w - 3}" cy="${b.y + 3}" r="4"/>`;
    s += '</g>';
  }
  return `<svg class="pkf" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(zone.code)}">${s}</svg>`;
}

module.exports = { layout, drawBays, states, svg, LEVELS, ROWS, FRESH_MS, liftDistance };
