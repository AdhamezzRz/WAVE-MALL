'use strict';

// Figures from the developer's presentation (floor plans and unit schedules).
// Areas in square metres. Keep this file as the single source for numbers on the site.

const COORDS = { lat: 30.0194714, lng: 31.4319505 };

// Top to bottom, the order the site descends through.
const FLOORS = [
  { id: 'R', area: 4780 },
  { id: '4', area: 4070 },
  { id: '3', area: 4608, terraces: true },
  { id: '2', area: 5135 },
  { id: '1', area: 4381 },
  { id: 'G', units: 16 },
  { id: 'B1', area: 9469, spaces: 144, street: 7 },
  { id: 'B2', area: 9600, spaces: 196 },
];

// [unit, indoor m², outdoor m²]
const GROUND_UNITS = [
  [1, 190, 197], [2, 170, 125], [3, 210, 155], [4, 301, 483],
  [5, 301, 479], [6, 210, 156], [7, 168, 98], [8, 187, 189],
  [9, 187, 173], [10, 168, 105], [11, 210, 143], [12, 300, 397],
  [13, 301, 366], [14, 211, 142], [15, 168, 105], [16, 187, 171],
];
const STREET_UNITS = [
  [1, 111, 94], [2, 63, 40], [3, 61, 56], [4, 61, 55], [5, 62, 40], [6, 79, 27], [7, 120, 68],
];

const sum = (rows, i) => rows.reduce((t, r) => t + r[i], 0);
const range = (rows, i) => [Math.min(...rows.map((r) => r[i])), Math.max(...rows.map((r) => r[i]))];

const FACTS = {
  plazaUnits: GROUND_UNITS.length,
  streetUnits: STREET_UNITS.length,
  units: GROUND_UNITS.length + STREET_UNITS.length,
  unitRange: [Math.min(range(GROUND_UNITS, 1)[0], range(STREET_UNITS, 1)[0]), Math.max(range(GROUND_UNITS, 1)[1], range(STREET_UNITS, 1)[1])],
  terraceTotal: sum(GROUND_UNITS, 2) + sum(STREET_UNITS, 2),
  upperFloors: FLOORS.filter((f) => /^[1-4R]$/.test(f.id)).reduce((t, f) => t + f.area, 0),
  parkingArea: FLOORS.filter((f) => f.spaces).reduce((t, f) => t + f.area, 0),
  parkingLevels: FLOORS.filter((f) => f.spaces).length,
  employees: 6000,
};

module.exports = { COORDS, FLOORS, GROUND_UNITS, STREET_UNITS, FACTS };
