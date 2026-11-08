'use strict';

// The datasets' titles in both languages, for the activity log ("Brands: 3 new…" read in Arabic):
// the engine fills it as datasets register; i18n/ar-import.js reads it.

const map = new Map();
module.exports = {
  set: (en, ar) => map.set(en, ar),
  ar: (en) => map.get(en) || en,
};
