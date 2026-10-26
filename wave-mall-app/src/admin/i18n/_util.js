'use strict';

// Helpers for the Arabic dictionaries (files starting with _ are not dictionaries).

// Arabic plural forms: plural(n, 'وحدة واحدة', 'وحدتان', '{n} وحدات', '{n} وحدة'). Zero and 11+ use the last form.
function plural(n, one, two, few, many) {
  const x = Math.abs(Number(n));
  const s = x === 1 ? one : x === 2 ? two : x % 100 >= 3 && x % 100 <= 10 ? few : many;
  return String(s).replace(/\{n\}/g, n);
}

// An ISO date (2026-11-02) captured from stored English text, written the Arabic way.
const AR_DATE = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const arDate = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso)) ? AR_DATE.format(new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)) : iso);

// Translate inside a dictionary function (loaded lazily: dictionaries load before i18n.js finishes).
// e.g. 'Moved to {stage}': ({ stage }) => `نُقلت إلى ${stageAr(stage)}`
const tt = (key, p) => require('../i18n').t(key, p);
// An English stage name captured from stored text ("Proposal") in Arabic.
const stageAr = (en) => tt(`stage|${en}`);

module.exports = { plural, arDate, tt, stageAr };
