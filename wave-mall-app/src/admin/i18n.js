'use strict';

// English and Arabic for the leasing office. Each request runs inside a language context
// (set in index.js), so t() and the formatters in ui.js need no language argument.
//
//   t('Save')                          → 'Save' or 'حفظ'
//   t('{n} units on hold', { n })      → placeholders are filled in both languages
//   tn(n, '{n} invoice', '{n} invoices') → English singular/plural; Arabic plurals live in the dictionary
//   t('invoice|Open')                  → text after "|" is the English; the full key picks the Arabic (context)
//   tx(stored)                         → text the system saved in English (activity notes, the audit log)
//                                        shown in the reader's language; anything else is returned as is
//
// Dictionaries are the files in ./i18n (ar-*.js), merged at start-up.

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const { plural } = require('./i18n/_util');

const LANGS = ['en', 'ar'];
const store = new AsyncLocalStorage();
const lang = () => (store.getStore() && store.getStore().lang) || 'en';
const isAr = () => lang() === 'ar';
const run = (l, fn) => store.run({ lang: LANGS.includes(l) ? l : 'en' }, fn);

const AR = {};
const SOURCES = {};
const DIR = path.join(__dirname, 'i18n');
for (const f of fs.readdirSync(DIR).filter((x) => /^ar-.*\.js$/.test(x)).sort()) {
  const dict = require(path.join(DIR, f));
  for (const [k, v] of Object.entries(dict)) {
    if (k in AR && String(AR[k]) !== String(v)) throw new Error(`i18n: "${k}" is translated differently in ${SOURCES[k]} and ${f}`);
    AR[k] = v;
    SOURCES[k] = f;
  }
}

const english = (key) => (key.includes('|') ? key.slice(key.indexOf('|') + 1) : key);
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] !== undefined && p[k] !== null ? p[k] : m)) : String(s));

const missing = new Set();
function t(key, p) {
  if (lang() === 'ar') {
    const ar = AR[key];
    if (ar !== undefined) return fill(typeof ar === 'function' ? ar(p || {}) : ar, p);
    missing.add(key);
  }
  return fill(english(key), p);
}
// English singular or plural; the Arabic entry (keyed by the plural) handles its own forms.
function tn(n, one, many, p = {}) {
  const params = { n, ...p };
  if (lang() === 'ar' && AR[many] !== undefined) return t(many, params);
  return fill(n === 1 ? english(one) : english(many), params);
}

// Patterns for tx(): every dictionary key with {placeholders} becomes an anchored regex.
const PATTERNS = Object.keys(AR)
  .filter((k) => /\{\w+\}/.test(k) && !k.includes('|'))
  .map((k) => {
    const names = [];
    // {n} (and other count-like names) only ever match a number, so typed text such as
    // "Need a few days" is never mistaken for "{n} days".
    const src = k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (m, name) => {
      names.push(name);
      return /^(n|count|days|months|years|leads|leases|units|invoices|amount|pct|area)$/.test(name) ? '(-?\\d[\\d,.]*)' : '(.+?)';
    });
    return { key: k, names, re: new RegExp(`^${src}$`, 's') };
  })
  // longest literal text first, so specific patterns win over general ones
  .sort((a, b) => b.key.replace(/\{\w+\}/g, '').length - a.key.replace(/\{\w+\}/g, '').length);

function tx(s) {
  if (s === null || s === undefined || s === '' || lang() !== 'ar') return s;
  const str = String(s);
  if (AR[str] !== undefined) return t(str);
  for (const p of PATTERNS) {
    const m = str.match(p.re);
    if (m) return t(p.key, Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]])));
  }
  return str;
}


const dir = () => (isAr() ? 'rtl' : 'ltr');

module.exports = { t, tn, tx, lang, isAr, run, dir, plural, LANGS, AR, missing, english };
