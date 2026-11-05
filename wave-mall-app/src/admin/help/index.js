'use strict';

// The Help & training lessons: one file per area in ./lessons (each exports an array of lessons),
// loaded and checked here. The same lesson script makes the video (scripts/help-record.js), its
// transcript and captions, and the live "Show me" tour on the real page (public/admin/help.js).
// Authoring rules: ./README.md.

const fs = require('node:fs');
const path = require('node:path');

const LESSONS_DIR = path.join(__dirname, 'lessons');
const MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'public', 'admin', 'help-media');
const MANIFEST = path.join(MEDIA_DIR, 'manifest.json');
const LANGS = ['en', 'ar'];

// Areas follow the sidebar; the order here is the order on the academy page.
const AREAS = [
  ['start', 'hlp|Getting started', 'home'],
  ['overview', 'hlp|Dashboard and daily work', 'dash'],
  ['sales', 'hlp|Sales and leasing', 'leads'],
  ['property', 'hlp|Property', 'unit'],
  ['revenue', 'hlp|Revenue', 'bill'],
  ['finance', 'hlp|Finance', 'coins'],
  ['operations', 'hlp|Operations', 'wrench'],
  ['records', 'hlp|Records', 'folder'],
  ['people', 'hlp|People and HR', 'people'],
  ['insight', 'hlp|Insight', 'report'],
  ['office', 'hlp|Office and administration', 'gear'],
  ['portal', 'hlp|Tenant portal', 'tenant'],
];

// Learning paths: a lesson joins a path when its roles list the path's key ('all' joins every staff path).
const PATHS = [
  { key: 'start', label: 'hlp|Everyone: first day', sub: 'hlp|Find your way around, your day and the basics.', icon: 'home', areas: ['start', 'overview'] },
  { key: 'leasing', label: 'hlp|Leasing agent', sub: 'hlp|Leads, offers, leases and the tenants you look after.', icon: 'leads' },
  { key: 'finance', label: 'hlp|Finance and collections', sub: 'hlp|Billing, cheques, collections, approvals and the books.', icon: 'coins' },
  { key: 'operations', label: 'hlp|Operations and security', sub: 'hlp|Maintenance, parking, security, cleaning and safety.', icon: 'wrench' },
  { key: 'management', label: 'hlp|Management', sub: 'hlp|Approvals, reports, the owner report and the team.', icon: 'report' },
  { key: 'admin', label: 'hlp|Administrator', sub: 'hlp|Users, permissions, settings and backups.', icon: 'shield' },
  { key: 'tenant', label: 'hlp|Tenant portal', sub: 'hlp|What tenants see and do in their portal.', icon: 'tenant', areas: ['portal'] },
];

const STEP_KINDS = ['go', 'say', 'point', 'click', 'type', 'select', 'check', 'scroll', 'hover', 'key', 'pause', 'wait'];
// the action of a step: say is only the action when nothing else is
const kindOf = (s) => STEP_KINDS.find((k) => k !== 'say' && Object.hasOwn(s, k)) || (Object.hasOwn(s, 'say') ? 'say' : null);
const isText = (x) => typeof x === 'string' || (x && typeof x.en === 'string' && typeof x.ar === 'string');

// Problems with a lesson (an empty list when it is fine).
function problems(l) {
  const out = [];
  if (!l || typeof l !== 'object') return ['not an object'];
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(String(l.id || ''))) out.push('id must be lower-case words with hyphens');
  if (!AREAS.some(([k]) => k === l.area)) out.push(`area "${l.area}" is not one of ${AREAS.map(([k]) => k).join(', ')}`);
  for (const f of ['title', 'summary']) if (!l[f] || !l[f].en || !l[f].ar) out.push(`${f} needs en and ar`);
  if (!Array.isArray(l.steps) || !l.steps.length) out.push('steps must be a non-empty array');
  (l.steps || []).forEach((s, i) => {
    const k = kindOf(s);
    if (!k) out.push(`step ${i + 1}: no action (${STEP_KINDS.join(', ')})`);
    if (s.say !== undefined && !(s.say && s.say.en && s.say.ar)) out.push(`step ${i + 1}: say needs en and ar`);
    if (s.has !== undefined && !isText(s.has)) out.push(`step ${i + 1}: has must be text or { en, ar }`);
    if (k === 'type' && !(Array.isArray(s.type) && typeof s.type[0] === 'string' && isText(s.type[1]))) out.push(`step ${i + 1}: type is [selector, text or { en, ar }]`);
    if (k === 'select' && !(Array.isArray(s.select) && typeof s.select[0] === 'string')) out.push(`step ${i + 1}: select is [selector, value]`);
    if (k === 'go' && !/^\/(admin|portal)(\/|$|\?)/.test(String(s.go))) out.push(`step ${i + 1}: go must be an /admin or /portal address`);
  });
  if (l.steps && !l.steps.some((s) => s.say)) out.push('at least one step must say something');
  if (l.steps && kindOf(l.steps[0]) !== 'go') out.push('the first step must be { go: ... }');
  return out;
}

let cache = null;
function load({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  const lessons = [];
  const errors = [];
  const files = fs.existsSync(LESSONS_DIR) ? fs.readdirSync(LESSONS_DIR).filter((f) => f.endsWith('.js')).sort() : [];
  for (const f of files) {
    const file = path.join(LESSONS_DIR, f);
    if (fresh) delete require.cache[require.resolve(file)];
    const list = require(file);
    (Array.isArray(list) ? list : []).forEach((l, i) => {
      const p = problems(l);
      if (p.length) errors.push(`${f} #${i + 1} (${l && l.id}): ${p.join('; ')}`);
      else lessons.push({ order: 100, level: 'basic', roles: [], ...l, file: f });
    });
  }
  const seen = new Set();
  for (const l of lessons) {
    if (seen.has(l.id)) errors.push(`duplicate lesson id ${l.id}`);
    seen.add(l.id);
  }
  const areaIndex = Object.fromEntries(AREAS.map(([k], i) => [k, i]));
  lessons.sort((a, b) => areaIndex[a.area] - areaIndex[b.area] || a.order - b.order || a.id.localeCompare(b.id));
  cache = { lessons, errors, byId: new Map(lessons.map((l) => [l.id, l])) };
  return cache;
}

// The recorded files of a lesson: { en: { mp4, vtt, json, jpg, duration, size, v }, ar: {...} }
let manifestCache = null;
let manifestStamp = 0;
function manifest() {
  try {
    const st = fs.statSync(MANIFEST);
    if (!manifestCache || st.mtimeMs !== manifestStamp) {
      manifestCache = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      manifestStamp = st.mtimeMs;
    }
  } catch {
    manifestCache = { lessons: {} };
  }
  return manifestCache;
}
function media(id, lang) {
  const m = (manifest().lessons || {})[id];
  const e = m && m[lang];
  if (!e) return null;
  const base = `/admin/help-media/${lang}/${id}`;
  return { ...e, mp4: `${base}.mp4?v=${e.v}`, vtt: `${base}.vtt?v=${e.v}`, json: `${base}.json?v=${e.v}`, jpg: `${base}.jpg?v=${e.v}`, file: path.join(MEDIA_DIR, lang, `${id}.json`) };
}
// the transcript cues of a recording: [{ start, end, text, step }]
function cues(id, lang) {
  const m = media(id, lang);
  if (!m) return null;
  try {
    return JSON.parse(fs.readFileSync(m.file, 'utf8')).cues || [];
  } catch {
    return null;
  }
}

const textOf = (x, lang) => (x === undefined || x === null ? '' : typeof x === 'string' ? x : x[lang] || x.en || '');
const said = (l, lang) => l.steps.filter((s) => s.say).map((s) => textOf(s.say, lang));
const inPath = (l, p) => (p.areas && p.areas.includes(l.area)) || (l.roles || []).includes(p.key) || (p.key !== 'tenant' && l.area !== 'portal' && (l.roles || []).includes('all'));
const forPath = (key) => {
  const p = PATHS.find((x) => x.key === key);
  return p ? load().lessons.filter((l) => inPath(l, p)) : [];
};
// lessons for an office page: the module whose address is the longest prefix of the page
function forPage(pagePath) {
  const p = String(pagePath || '').split('?')[0].replace(/\/+$/, '') || '/admin';
  const scored = load().lessons
    .map((l) => {
      const mods = [l.module, ...(l.also || [])].filter(Boolean);
      const best = Math.max(-1, ...mods.map((m) => (p === m || p.startsWith(`${m}/`) ? m.length : -1)));
      return [l, best];
    })
    .filter(([, s]) => s >= 0 && !(s === '/admin'.length && p !== '/admin'));
  const top = Math.max(-1, ...scored.map(([, s]) => s));
  return scored.filter(([, s]) => s === top).map(([l]) => l);
}

module.exports = { load, problems, kindOf, manifest, media, cues, textOf, said, forPath, forPage, inPath, AREAS, PATHS, LANGS, STEP_KINDS, MEDIA_DIR, MANIFEST };
