'use strict';

// Simplified plans of The Wave, drawn from the architect's floor plans in the
// developer's presentation. One coordinate system for every floor: 1000 × 640,
// west wing on the left, the open court in the middle.

const { FLOORS, GROUND_UNITS } = require('./data');

const VB = '0 0 1000 640';
const C = [500, 320];

// The hourglass footprint of the upper floors: lobes at the four corners,
// both long sides curving in towards the court.
const OUTER =
  'M140 40 L860 40 Q960 40 960 110 C960 165 862 228 862 320 C862 412 960 475 960 530 Q960 600 860 600 L140 600 Q40 600 40 530 C40 475 138 412 138 320 C138 228 40 165 40 110 Q40 40 140 40 Z';
const COURT = 'M400 140 L600 140 C652 250 652 380 600 490 L400 490 C348 380 348 250 400 140 Z';
const CORES = [
  'M400 140 L352 40', 'M600 140 L648 40', 'M400 490 L352 600', 'M600 490 L648 600',
  'M440 40 L440 140', 'M500 40 L500 140', 'M560 40 L560 140',
  'M440 490 L440 600', 'M500 490 L500 600', 'M560 490 L560 600',
];

const rad = (deg) => (deg * Math.PI) / 180;
const pt = (deg, r) => [C[0] + r * Math.cos(rad(deg)), C[1] + r * Math.sin(rad(deg))];
const f = (n) => Math.round(n * 10) / 10;

// Plaza units: eight per wing, radiating from the court, an entrance between 4|5 and 12|13.
const LEFT = [[236, 218], [218, 203], [203, 191], [191, 184], [176, 169], [169, 157], [157, 142], [142, 124]];
const units = () =>
  GROUND_UNITS.map(([n], i) => {
    const [a0, a1] = i < 8 ? LEFT[i] : LEFT[i - 8].map((a) => 180 - a);
    const [x0, y0] = pt(a0, 900);
    const [x1, y1] = pt(a1, 900);
    // label halfway between where the bisector leaves the court and meets the outer edge
    const mid = (a0 + a1) / 2;
    const cx = Math.abs(Math.cos(rad(mid))) || 1e-6;
    const sy = Math.abs(Math.sin(rad(mid))) || 1e-6;
    const rIn = Math.min(150 / cx, 180 / sy);
    const rOut = Math.min(400 / cx, 262 / sy);
    const [lx, ly] = pt(mid, (rIn + rOut) / 2 + 6);
    return { n, d: `M${C[0]} ${C[1]} L${f(x0)} ${f(y0)} L${f(x1)} ${f(y1)} Z`, label: [f(lx), f(ly)] };
  });

const defs = (id) =>
  `<defs><clipPath id="${id}-wing"><path clip-rule="evenodd" d="${OUTER} ${COURT}"/></clipPath></defs>`;

function upper(id, { terraces = false, lights = false } = {}) {
  let extra = '';
  if (terraces) {
    extra += `<ellipse class="plan__terrace" cx="120" cy="320" rx="96" ry="74"/><ellipse class="plan__terrace" cx="880" cy="320" rx="96" ry="74"/>`;
    extra += `<path class="plan__line" d="M40 290 L345 290 M40 350 L345 350 M655 290 L960 290 M655 350 L960 350" clip-path="url(#${id}-wing)"/>`;
  }
  if (lights) extra += `<rect class="plan__line" x="250" y="290" width="60" height="60"/><rect class="plan__line" x="690" y="290" width="60" height="60"/>`;
  return extra;
}

function ground(id) {
  return units()
    .map(
      (u) =>
        `<path class="plan__unit" data-unit="${u.n}" d="${u.d}" clip-path="url(#${id}-wing)"/><text class="plan__num" x="${u.label[0]}" y="${u.label[1]}">${u.n}</text>`,
    )
    .join('');
}

function basement(id, { street = false } = {}) {
  let s = `<rect class="plan__outline" x="40" y="40" width="920" height="560" pathLength="1"/>`;
  // parking bays: short ticks along rows
  for (let row = 0; row < 4; row++) {
    const y = 130 + row * 120;
    for (let x = street ? 190 : 90; x < 920; x += 34) {
      if (x > 410 && x < 590 && (row === 0 || row === 3)) continue;
      s += `<line class="plan__tick" x1="${x}" y1="${y}" x2="${x}" y2="${y + 42}"/>`;
    }
  }
  s += `<rect class="plan__line" x="420" y="60" width="160" height="60"/><rect class="plan__line" x="420" y="520" width="160" height="60"/>`;
  if (street) {
    for (let i = 0; i < 7; i++) s += `<rect class="plan__unit plan__unit--street" data-unit="${i + 1}" x="52" y="${92 + i * 66}" width="92" height="66"/><text class="plan__num" x="98" y="${130 + i * 66}">${i + 1}</text>`;
  }
  return s;
}

// One floor as an SVG string.
function floorSvg(floorId, { id = `p${floorId}`, label = '' } = {}) {
  const fl = FLOORS.find((x) => x.id === floorId);
  let body;
  if (fl.spaces) body = basement(id, { street: !!fl.street });
  else {
    body = `<path class="plan__outline" pathLength="1" d="${OUTER}"/><path class="plan__court" pathLength="1" d="${COURT}"/>`;
    body += CORES.map((d) => `<path class="plan__line" d="${d}"/>`).join('');
    if (floorId === 'G') body = ground(id) + body;
    else body += upper(id, { terraces: !!fl.terraces, lights: floorId === '4' });
  }
  return `<svg class="plan" viewBox="${VB}" role="img" aria-label="${label}">${defs(id)}${body}</svg>`;
}

// The footprint in objectBoundingBox units for the hero mask. t = 0 is the plan
// at the centre of the frame, t = 1 opens it to the full frame.
function heroPath(t, aspect = 1) {
  const lerp = (a, b) => a + (b - a) * t;
  // plan box inside the frame at t = 0
  const w0 = aspect > 1 ? 0.5 : 0.8;
  const h0 = aspect > 1 ? 0.62 : 0.5;
  const x = (u) => { const a = 0.5 + (u / 1000 - 0.5) * w0; return lerp(a, u / 1000 < 0.5 ? -0.02 : 1.02); };
  const y = (v) => { const a = 0.5 + (v / 640 - 0.5) * h0; return lerp(a, v / 640 < 0.5 ? -0.02 : 1.02); };
  // waist moves out to the edges as t → 1
  const wx = (u, edge) => lerp(0.5 + (u / 1000 - 0.5) * w0, edge);
  return `M${x(140)} ${y(40)} L${x(860)} ${y(40)} Q${x(960)} ${y(40)} ${x(960)} ${y(110)} C${x(960)} ${y(165)} ${wx(862, 1.02)} ${y(228)} ${wx(862, 1.02)} ${0.5} C${wx(862, 1.02)} ${y(412)} ${x(960)} ${y(475)} ${x(960)} ${y(530)} Q${x(960)} ${y(600)} ${x(860)} ${y(600)} L${x(140)} ${y(600)} Q${x(40)} ${y(600)} ${x(40)} ${y(530)} C${x(40)} ${y(475)} ${wx(138, -0.02)} ${y(412)} ${wx(138, -0.02)} ${0.5} C${wx(138, -0.02)} ${y(228)} ${x(40)} ${y(165)} ${x(40)} ${y(110)} Q${x(40)} ${y(40)} ${x(140)} ${y(40)} Z`.replace(/(\d\.\d{4})\d+/g, '$1');
}

module.exports = { floorSvg, heroPath, OUTER, COURT, VB };
