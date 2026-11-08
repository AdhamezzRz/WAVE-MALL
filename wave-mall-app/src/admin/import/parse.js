'use strict';

// Reading what people type in Excel: every parser takes a raw cell value (a string, a number, a
// Date, a boolean, or an exceljs object such as rich text or a formula) and returns
// { value } or { error: 'imp|…' message key, params } — never throws, never guesses silently.
// Where a value is read in a way the person may not expect (a two-digit year, a month/day order),
// it returns { value, warn } so the preview can say so.
//
// Everything here is pure (no database), so it is tested directly.

const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const digits = (s) => String(s).replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]);

// ---------- cells ----------
// The plain value of an exceljs cell value: rich text joined, a formula's cached result,
// a hyperlink's text, an error as null.
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('');
    if ('result' in v) return plain(v.result);
    if ('formula' in v || 'sharedFormula' in v) return null; // a formula with no cached result
    if ('text' in v) return plain(v.text);
    if ('error' in v) return null;
    return null;
  }
  return v;
}
const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.replace(/[\s‎‏ ]+/g, '') === '');
// trims, collapses runs of spaces (not new lines), drops direction marks and non-breaking spaces
const clean = (v) => String(v).replace(/[‎‏‪-‮﻿]/g, '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();

// ---------- comparing words ----------
// Lower case, Arabic letter variants folded (أ إ آ ٱ → ا, ة → ه, ى → ي, ؤ → و, ئ → ي), diacritics and
// tatweel removed, punctuation to spaces, "*" (required marks) dropped.
function norm(s) {
  return digits(String(s ?? ''))
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[*_\-–—/\\.,:;()[\]{}'"`’‘“”?!|#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// how alike two labels are, 0..1 (Dice coefficient on letter pairs of the normalised text)
function likeness(a, b) {
  const x = norm(a).replace(/ /g, '');
  const y = norm(b).replace(/ /g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
    return m;
  };
  const px = pairs(x);
  const py = pairs(y);
  let both = 0;
  for (const [k, n] of px) both += Math.min(n, py.get(k) || 0);
  return (2 * both) / (x.length - 1 + (y.length - 1));
}

// ---------- text ----------
function text(v, { max = 500, multiline = false } = {}) {
  const p = plain(v);
  if (isBlank(p)) return { value: null };
  let s;
  if (p instanceof Date) s = isoDate(p);
  else if (typeof p === 'number') s = Number.isInteger(p) ? String(p) : String(+p.toFixed(10));
  else s = clean(p);
  if (!multiline) s = s.replace(/\n+/g, ' ');
  if (s.length > max) return { error: 'imp|Longer than {max} characters.', params: { max } };
  return { value: s };
}

// ---------- numbers ----------
// "1,250.50", "1.250,50", "EGP 12,000", "12 000 ج.م", "(1,200)" → -1200, "15%", Arabic digits,
// Arabic separators (٫ decimal, ٬ thousands).
function numberOf(v, { percent = false } = {}) {
  const p = plain(v);
  if (isBlank(p)) return { value: null };
  if (typeof p === 'number') return Number.isFinite(p) ? { value: p } : { error: 'imp|Not a number.' };
  if (typeof p === 'boolean' || p instanceof Date) return { error: 'imp|Not a number.' };
  let s = digits(clean(p)).replace(/٫/g, '.').replace(/٬/g, ',');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/(?:egp|l\.?e\.?|le|e£|£|\$|usd|ج\.?\s*م\.?|جنيه(?:ا|ات)?(?:\s+مصري)?|مصري)/gi, '').trim();
  const hasPct = /%$/.test(s) || /^%/.test(s);
  s = s.replace(/%/g, '').replace(/\s+/g, '');
  if (/^-/.test(s)) { neg = !neg; s = s.slice(1); }
  if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return { error: 'imp|Not a number.' };
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    // the later separator is the decimal one: 1,250.50 or 1.250,50
    s = s.lastIndexOf('.') > s.lastIndexOf(',') ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (commas) {
    // 1,250 (thousands) or 12,5 (a decimal comma: one comma, not followed by exactly 3 digits)
    s = commas === 1 && !/,\d{3}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (dots > 1) {
    s = s.replace(/\./g, ''); // 1.250.000
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: 'imp|Not a number.' };
  const out = neg ? -n : n;
  return { value: out, percentSign: hasPct && !percent ? true : undefined };
}
function number(v, { min = null, max = null, integer = false, percent = false, numFmt = '' } = {}) {
  const r = numberOf(v, { percent });
  if (r.error || r.value === null) return r;
  let n = r.value;
  // a cell formatted as a percentage holds 0.15 for 15 %
  if (percent && typeof plain(v) === 'number' && /%/.test(numFmt || '')) n *= 100;
  n = Math.round(n * 1e6) / 1e6;
  if (integer && !Number.isInteger(n)) return { error: 'imp|A whole number is needed.' };
  if (min !== null && n < min) return { error: 'imp|Must be {min} or more.', params: { min } };
  if (max !== null && n > max) return { error: 'imp|Must be {max} or less.', params: { max } };
  return { value: n };
}

// ---------- dates ----------
const isoDate = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const realDate = (y, m, d) => {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? isoDate(t) : null;
};
// Excel's day numbers: 1 = 1 Jan 1900; Excel wrongly counts 29 Feb 1900 (60), so from 61 the
// epoch is 30 Dec 1899.
function fromSerial(n) {
  if (!(n >= 1 && n < 2958466)) return null;
  const whole = Math.floor(n);
  if (whole === 60) return null; // 29 Feb 1900 does not exist
  const base = whole < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return isoDate(new Date(base + whole * 86400000));
}
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  // Egyptian and Levantine Arabic names (normalised: أ→ا, ة→ه, ى→ي)
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يونيه: 6, يوليو: 7, يوليه: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
  'كانون الثاني': 1, شباط: 2, اذار: 3, نيسان: 4, ايار: 5, حزيران: 6, تموز: 7, اب: 8, ايلول: 9, 'تشرين الاول': 10, 'تشرين الثاني': 11, 'كانون الاول': 12,
};
const yearOf = (y) => {
  const n = Number(y);
  if (String(y).length <= 2) return { y: n < 70 ? 2000 + n : 1900 + n, two: true };
  return { y: n, two: false };
};
function date(v) {
  const p = plain(v);
  if (isBlank(p)) return { value: null };
  if (p instanceof Date) {
    if (Number.isNaN(p.getTime())) return { error: 'imp|Not a date.' };
    // Excel dates arrive as midnight UTC; a time part (rounding) is dropped
    return { value: isoDate(new Date(p.getTime() + 1000)) };
  }
  if (typeof p === 'number') {
    const d = fromSerial(p);
    return d ? { value: d } : { error: 'imp|Not a date.' };
  }
  const raw = clean(digits(p));
  const s = raw.replace(/[،]/g, ',').replace(/\s*(?:م|هـ)$/, '').trim();
  let m;
  // 2025-03-15, 2025/3/15, 2025.03.15 (with an optional time after it)
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/))) {
    const d = realDate(+m[1], +m[2], +m[3]);
    return d ? { value: d } : { error: 'imp|{value} is not a real date.', params: { value: raw } };
  }
  // 15/03/2025, 15-3-25, 15.03.2025 — day first, as in Egypt; month first only when the day
  // cannot be a month (03/15/2025), and then the preview says so
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[ T].*)?$/))) {
    const { y, two } = yearOf(m[3]);
    let a = +m[1];
    let b = +m[2];
    let warn = two ? 'imp|Read the two-digit year as {year}.' : null;
    if (b > 12 && a <= 12) {
      [a, b] = [b, a];
      warn = 'imp|Read as month/day/year.';
    }
    const d = realDate(y, b, a);
    if (!d) return { error: 'imp|{value} is not a real date.', params: { value: raw } };
    return warn ? { value: d, warn, params: { year: y } } : { value: d };
  }
  // 15 Mar 2025, 15-Mar-25, 15 مارس 2025, March 15, 2025
  const n = norm(s).replace(/,/g, ' ');
  if ((m = n.match(/^(\d{1,2}) ([a-zء-ي ]+?) (\d{2}|\d{4})$/))) {
    const mo = MONTHS[m[2].trim()];
    const { y } = yearOf(m[3]);
    if (mo) {
      const d = realDate(y, mo, +m[1]);
      return d ? { value: d } : { error: 'imp|{value} is not a real date.', params: { value: raw } };
    }
  }
  if ((m = n.match(/^([a-zء-ي ]+?) (\d{1,2}) (\d{2}|\d{4})$/))) {
    const mo = MONTHS[m[1].trim()];
    const { y } = yearOf(m[3]);
    if (mo) {
      const d = realDate(y, mo, +m[2]);
      return d ? { value: d } : { error: 'imp|{value} is not a real date.', params: { value: raw } };
    }
  }
  // a day number typed as text
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = fromSerial(Number(s));
    if (d) return { value: d };
  }
  return { error: 'imp|{value} is not a date. Use day/month/year, e.g. 15/03/2025.', params: { value: raw } };
}
// a month: 2025-03, 03/2025, Mar 2025, مارس 2025, or any date in it
function month(v) {
  const p = plain(v);
  if (isBlank(p)) return { value: null };
  if (typeof p === 'string') {
    const s = clean(digits(p));
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})$/)) && +m[2] >= 1 && +m[2] <= 12) return { value: `${m[1]}-${String(+m[2]).padStart(2, '0')}` };
    if ((m = s.match(/^(\d{1,2})[-/.](\d{4})$/)) && +m[1] >= 1 && +m[1] <= 12) return { value: `${m[2]}-${String(+m[1]).padStart(2, '0')}` };
    const n = norm(s);
    if ((m = n.match(/^([a-zء-ي ]+?) (\d{4})$/)) && MONTHS[m[1].trim()]) return { value: `${m[2]}-${String(MONTHS[m[1].trim()]).padStart(2, '0')}` };
  }
  const d = date(v);
  if (d.error) return { error: 'imp|{value} is not a month. Use month/year, e.g. 03/2025.', params: { value: typeof p === 'string' ? clean(p) : String(p) } };
  return { value: d.value ? d.value.slice(0, 7) : null };
}
// a time of day: 09:30, 9.30, 9:30 PM, ٩:٣٠ م, or Excel's fraction of a day
function time(v) {
  const p = plain(v);
  if (isBlank(p)) return { value: null };
  const hm = (h, mi) => (h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? { value: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` } : { error: 'imp|Not a time of day.' });
  if (p instanceof Date) {
    const mins = Math.round((p.getUTCHours() * 3600 + p.getUTCMinutes() * 60 + p.getUTCSeconds()) / 60) % 1440;
    return hm(Math.floor(mins / 60), mins % 60);
  }
  if (typeof p === 'number') {
    if (!(p >= 0 && p < 1)) return { error: 'imp|Not a time of day.' };
    const mins = Math.round(p * 1440);
    return hm(Math.floor(mins / 60) % 24, mins % 60);
  }
  const s = clean(digits(p)).toLowerCase();
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|ص|م|صباحا|مساء|مساءً|صباحًا)?$/);
  if (!m) return { error: 'imp|Not a time of day.' };
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  const ap = m[3];
  if (ap) {
    if (h < 1 || h > 12) return { error: 'imp|Not a time of day.' };
    const pm = /^(pm|م|مساء)/.test(ap);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return hm(h, mi);
}

// ---------- yes / no ----------
const YES = new Set(['yes', 'y', 'true', '1', 'x', '✓', '✔', 'on', 'نعم', 'اه', 'ايوه', 'صح', 'موافق']);
const NO = new Set(['no', 'n', 'false', '0', '-', '✗', '✘', 'off', 'لا', 'خطا']);
function bool(v) {
  const p = plain(v);
  if (isBlank(p)) return { value: null };
  if (typeof p === 'boolean') return { value: p };
  if (typeof p === 'number') return p === 1 ? { value: true } : p === 0 ? { value: false } : { error: 'imp|Use yes or no.' };
  const s = norm(p);
  if (YES.has(s) || YES.has(String(p).trim())) return { value: true };
  if (NO.has(s) || NO.has(String(p).trim())) return { value: false };
  return { error: 'imp|Use yes or no.' };
}

// ---------- a choice from a list ----------
// options: [[value, { en, ar }, [synonyms]]]; matches the stored value or either language's label
function choice(v, options) {
  const t = text(v, { max: 300 });
  if (t.error || t.value === null) return t;
  const n = norm(t.value);
  for (const [value, label, syn] of options) {
    const names = [value, label && label.en, label && label.ar, ...(syn || [])].filter(Boolean);
    if (names.some((x) => norm(x) === n)) return { value };
  }
  // a close spelling (one word wrong, a letter missing) is accepted with a warning
  let best = null;
  for (const [value, label, syn] of options) {
    for (const x of [value, label && label.en, label && label.ar, ...(syn || [])].filter(Boolean)) {
      const s = likeness(x, t.value);
      if (s >= 0.85 && (!best || s > best.s)) best = { value, s, label: label ? label.en : value };
    }
  }
  if (best) return { value: best.value, warn: 'imp|Read “{typed}” as “{label}”.', params: { typed: t.value, label: best.label } };
  return { error: 'imp|“{typed}” is not one of the allowed values.', params: { typed: t.value } };
}

// ---------- contact details ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function email(v) {
  const t = text(v, { max: 200 });
  if (t.error || t.value === null) return t;
  const s = t.value.replace(/^mailto:/i, '').replace(/\s+/g, '').toLowerCase();
  return EMAIL_RE.test(s) ? { value: s } : { error: 'imp|{value} is not an email address.', params: { value: t.value } };
}
// Egyptian numbers are kept as 01xxxxxxxxx (mobiles) or 0xxxxxxxx (land lines); +20 / 0020 / 20
// are turned into the leading 0. Other countries keep their + and digits.
function phone(v) {
  const p = plain(v);
  if (isBlank(p)) return { value: null };
  let s = typeof p === 'number' ? String(Math.round(p)) : digits(clean(p));
  s = s.replace(/^tel:/i, '').replace(/[\s\-().‎‏/]/g, '');
  if (!/^\+?\d{6,16}$/.test(s)) return { error: 'imp|{value} is not a phone number.', params: { value: clean(String(p)) } };
  const EG = /^(01[0125]\d{8}|0[2-9]\d{7,8})$/;
  const bad = (x) => ({ value: x, warn: 'imp|{value} does not look like an Egyptian mobile number (11 digits, 010/011/012/015).', params: { value: x } });
  // +20 / 0020 / 20 → the local 0…, but only when that makes a real Egyptian number
  const intl = s.startsWith('+20') ? s.slice(3) : s.startsWith('0020') ? s.slice(4) : null;
  if (intl !== null) return EG.test(`0${intl}`) ? { value: `0${intl}` } : bad(`+20${intl}`);
  if (/^20(1[0125]\d{8}|[2-9]\d{7,8})$/.test(s)) return { value: `0${s.slice(2)}` };
  // a mobile typed as a number loses its 0 in Excel: 1012345678 → 01012345678
  if (/^1[0125]\d{8}$/.test(s)) return { value: `0${s}` };
  if (s.startsWith('+')) return { value: s };
  if (/^01/.test(s) && !EG.test(s)) return bad(s);
  return { value: s };
}
// a list typed in one cell: "a, b; c" or one per line
function list(v, { max = 50 } = {}) {
  const t = text(v, { max: 4000, multiline: true });
  if (t.error || t.value === null) return t;
  const items = t.value.split(/[,;،؛\n]+/).map((x) => x.trim()).filter(Boolean);
  if (items.length > max) return { error: 'imp|More than {max} items.', params: { max } };
  return { value: items };
}

module.exports = { plain, isBlank, clean, norm, likeness, digits, text, numberOf, number, date, month, time, bool, choice, email, phone, list, fromSerial, isoDate, realDate, EMAIL_RE };
