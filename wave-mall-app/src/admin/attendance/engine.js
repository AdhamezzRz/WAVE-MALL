'use strict';

// Attendance: the rules, with no database and no clock of their own (everything is passed in), so
// each one can be tested on its own.
//
//   distance(a, b)                    metres between two points on the Earth (haversine)
//   offset(center, p)                 { x: metres east, y: metres north } of p from center
//   parsePoint(text)                  { lat, lng } from "30.0, 31.4" or a Google Maps link, or null
//   verdict({ fence, reading, now, prev, sentAt, wifi })
//                                     accepted / flagged / rejected, with the reasons
//   shiftOn(shift, date)              the shift's times on a Cairo date, or null on its day off
//   workDate(t, shifts)               the work day a moment belongs to (a night shift's morning
//                                     belongs to the evening it started)
//   sessionsOf(punches, now)          punches folded into worked spans and breaks
//   computeDay({ … })                 one person's day: present, late, early, overtime, absent, …
//   nextAllowed(lastKind)             the punches allowed after the last one
//
// Moments are UTC ISO strings (…Z) or epoch milliseconds; days are Cairo dates (YYYY-MM-DD);
// shift times are Cairo wall-clock "HH:MM".

const R = 6371008.8; // mean Earth radius, metres
const rad = (d) => (d * Math.PI) / 180;

function distance(a, b) {
  if (!a || !b) return null;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
// Metres east (x) and north (y) of p from center. Over a few kilometres the error is far below GPS
// accuracy; the radar draws with it.
function offset(center, p) {
  return { x: rad(p.lng - center.lng) * R * Math.cos(rad((center.lat + p.lat) / 2)), y: rad(p.lat - center.lat) * R };
}
const validPoint = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// "30.0300, 31.4700", "30.03,31.47", a Google Maps link (…/@30.03,31.47,17z, ?q=30.03,31.47,
// ll=…, !3d30.03!4d31.47) or an Apple Maps link (?ll=…). Returns { lat, lng } or null.
function parsePoint(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const pick = (a, b) => {
    const lat = Number(a);
    const lng = Number(b);
    return validPoint(lat, lng) ? { lat, lng } : null;
  };
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  // the place pin (!3d…!4d…) is more exact than the map's centre (@…)
  let m = s.match(new RegExp(`!3d${num}!4d${num}`));
  if (m) return pick(m[1], m[2]);
  m = s.match(new RegExp(`[?&](?:q|query|ll|sll|daddr|destination)=${num}(?:,|%2C)\\s*${num}`, 'i'));
  if (m) return pick(m[1], m[2]);
  m = s.match(new RegExp(`@${num},${num}`));
  if (m) return pick(m[1], m[2]);
  m = s.match(new RegExp(`^${num}\\s*[,،\\s]\\s*${num}$`));
  if (m) return pick(m[1], m[2]);
  return null;
}

const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));

// The decision on a reading. fence: { lat, lng, radius, maxAccuracy } (lat null: not set yet).
// reading: { lat, lng, accuracy, at } (at: when the phone took it). now: the server's time.
// sentAt: the phone's clock when it sent the reading (the phone clock may be wrong: the age of the
// reading is measured on the phone's own clock, then the difference between the two clocks is
// checked separately). prev: the person's last accepted reading { lat, lng, accuracy, at }.
// wifi: { configured, matched } from the mall's public IP list.
// Returns { status: 'accepted'|'flagged'|'rejected', distance, reasons: [], flags: [] }.
const LIMITS = { maxAgeS: 120, maxFutureS: 60, maxSkewS: 300, maxSpeedKmh: 150, jumpM: 500 };
function verdict({ fence, reading, now, prev = null, sentAt = null, wifi = null }) {
  const reasons = [];
  const flags = [];
  const out = (status, d = null) => ({ status, distance: d === null ? null : Math.round(d * 10) / 10, reasons, flags });
  if (!fence || !validPoint(Number(fence.lat), Number(fence.lng))) { reasons.push('no_fence'); return out('rejected'); }
  const lat = Number(reading && reading.lat);
  const lng = Number(reading && reading.lng);
  const acc = Number(reading && reading.accuracy);
  if (!reading || !validPoint(lat, lng) || !Number.isFinite(acc) || acc < 0) { reasons.push('no_position'); return out('rejected'); }
  const d = distance({ lat: Number(fence.lat), lng: Number(fence.lng) }, { lat, lng });
  const nowMs = ms(now);
  const takenMs = ms(reading.at);
  const sentMs = sentAt === null || sentAt === undefined ? nowMs : ms(sentAt);
  if (!Number.isFinite(takenMs)) reasons.push('no_time');
  else {
    // age on the phone's own clock (taken → sent), then the network
    const age = (sentMs - takenMs) / 1000 + Math.max(0, (nowMs - sentMs) / 1000);
    if (Number.isFinite(sentMs) && Math.abs(nowMs - sentMs) / 1000 > LIMITS.maxSkewS) flags.push('clock');
    if ((Number.isFinite(sentMs) ? sentMs : nowMs) - takenMs < -LIMITS.maxFutureS * 1000) reasons.push('future');
    else if (age > LIMITS.maxAgeS) reasons.push('stale');
  }
  if (acc > Number(fence.maxAccuracy)) reasons.push('weak');
  // on the circle counts as inside (1 cm for floating-point error)
  if (d > Number(fence.radius) + 0.01) reasons.push('outside');
  if (prev && validPoint(Number(prev.lat), Number(prev.lng)) && Number.isFinite(ms(prev.at)) && Number.isFinite(takenMs)) {
    const moved = distance(prev, { lat, lng }) - acc - Number(prev.accuracy || 0);
    const hours = Math.max(1 / 3600, (takenMs - ms(prev.at)) / 3600000);
    if (moved > LIMITS.jumpM && moved / 1000 / hours > LIMITS.maxSpeedKmh) reasons.push('jump');
  }
  if (reasons.length) return out('rejected', d);
  // accepted, but worth a look
  if (d + acc > Number(fence.radius)) flags.push('edge');
  if (acc < 1) flags.push('exact');
  if (wifi && wifi.configured && !wifi.matched) flags.push('wifi');
  return out(flags.length ? 'flagged' : 'accepted', d);
}

// ---------- Cairo time ----------
const CAIRO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function cairo(t) {
  const p = Object.fromEntries(CAIRO.formatToParts(new Date(ms(t))).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), hm: `${p.hour}:${p.minute}`, sec: Number(p.second) };
}
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const hmMin = (hm) => {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) <= 24 && Number(m[2]) < 60 && v <= 1440 ? v : null;
};
// The UTC moment of a Cairo wall-clock time (Egypt moves between UTC+2 and UTC+3).
function cairoAt(date, hm) {
  const v = hmMin(hm);
  if (v === null) return null;
  const day = v >= 1440 ? addDays(date, 1) : date;
  const mm = v % 1440;
  const want = `${day} ${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
  for (const off of [2, 3]) {
    const t = Date.parse(`${day}T${want.slice(11)}:00Z`) - off * 3600000;
    const c = cairo(t);
    if (`${c.date} ${c.hm}` === want) return new Date(t).toISOString();
  }
  // the hour skipped when clocks go forward: take the moment just after
  return new Date(Date.parse(`${day}T${want.slice(11)}:00Z`) - 2 * 3600000).toISOString();
}
// ISO weekday of a date: 1 Monday … 7 Sunday
const isoDay = (date) => {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};
const daysOf = (shift) => new Set(String(shift.days || '1234567').split('').map(Number).filter((n) => n >= 1 && n <= 7));

// A shift on a date: { start, end (UTC ISO), minutes, net (minus the unpaid break), grace, … } or
// null when the date is not one of its days. A shift that ends at or before it starts ends the
// next morning and belongs to the day it started.
function shiftOn(shift, date) {
  if (!shift || !daysOf(shift).has(isoDay(date))) return null;
  const a = hmMin(shift.start_hm);
  let b = hmMin(shift.end_hm);
  if (a === null || b === null) return null;
  if (b <= a) b += 1440;
  const start = cairoAt(date, shift.start_hm);
  const end = cairoAt(b >= 1440 ? addDays(date, 1) : date, `${String(Math.floor((b % 1440) / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`);
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60000);
  const brk = Math.max(0, Number(shift.break_min) || 0);
  return { date, shift, start, end, minutes, net: Math.max(0, minutes - brk), grace: Math.max(0, Number(shift.grace_min ?? 0)), overnight: b > 1440 || (b === 1440 && a > 0) };
}

// The work day a moment belongs to. shiftFor(date) gives the person's shift on that date (or null).
// A moment inside yesterday's shift window (from 3 h before its start to `after` hours after its
// end) belongs to yesterday when that shift runs past midnight; otherwise to today's Cairo date.
function workDate(t, shiftFor, { before = 3, after = 3 } = {}) {
  const at = ms(t);
  const today = cairo(at).date;
  const y = addDays(today, -1);
  const ys = shiftFor(y);
  const yOn = ys && shiftOn(ys, y);
  const inWindow = (on) => on && at >= Date.parse(on.start) - before * 3600000 && at <= Date.parse(on.end) + after * 3600000;
  const ts = shiftFor(today);
  const tOn = ts && shiftOn(ts, today);
  // today's shift wins when the moment is already in its window (an early start)
  if (inWindow(tOn) && !(inWindow(yOn) && at <= Date.parse(yOn.end))) return today;
  if (inWindow(yOn)) return y;
  return today;
}

// The punches that may follow the last one.
const NEXT = { none: ['in'], out: ['in'], in: ['break_start', 'out'], break_end: ['break_start', 'out'], break_start: ['break_end', 'out'] };
const nextAllowed = (lastKind) => NEXT[lastKind || 'none'] || ['in'];

// Punches (accepted or flagged, not voided, in time order) folded into spans. A span is
// { in, out|null, breaks: [{ start, end|null }], open }. The time worked excludes breaks; an open
// span counts until now.
function sessionsOf(punches, now = null) {
  const spans = [];
  let cur = null;
  for (const p of [...punches].sort((a, b) => ms(a.at) - ms(b.at) || a.id - b.id)) {
    if (p.kind === 'in') {
      if (cur) continue; // a second "in" without an "out" is ignored (the verdict refuses it)
      cur = { in: p.at, out: null, breaks: [], open: true, inPunch: p };
      spans.push(cur);
    } else if (!cur) continue;
    else if (p.kind === 'break_start') {
      if (!cur.breaks.length || cur.breaks[cur.breaks.length - 1].end) cur.breaks.push({ start: p.at, end: null });
    } else if (p.kind === 'break_end') {
      const b = cur.breaks[cur.breaks.length - 1];
      if (b && !b.end) b.end = p.at;
    } else if (p.kind === 'out') {
      const b = cur.breaks[cur.breaks.length - 1];
      if (b && !b.end) b.end = p.at;
      cur.out = p.at;
      cur.open = false;
      cur.outPunch = p;
      cur = null;
    }
  }
  const nowMs = now === null ? null : ms(now);
  for (const s of spans) {
    const end = s.out ? ms(s.out) : nowMs;
    const breakMs = s.breaks.reduce((sum, b) => sum + Math.max(0, (b.end ? ms(b.end) : (s.out ? ms(s.out) : nowMs ?? ms(b.start))) - ms(b.start)), 0);
    s.grossMin = end === null ? 0 : Math.max(0, (end - ms(s.in)) / 60000);
    s.breakMin = breakMs / 60000;
    s.workedMin = Math.max(0, s.grossMin - s.breakMin);
    s.onBreak = !!(s.open && s.breaks.length && !s.breaks[s.breaks.length - 1].end);
  }
  return spans;
}

// One person's day. on: shiftOn(…) or null; punches: that work day's punches; leave: an approved
// leave type covering the date or null; holiday: its name or null; now: the moment to judge at.
// Returns { status, on, spans, firstIn, lastOut, workedMin, breakMin, lateMin, earlyMin,
// overtimeMin, incomplete, open, onBreak }.
// status: off · holiday · leave · upcoming · not_in · absent · working · on_break · done
function computeDay({ on, punches = [], leave = null, holiday = null, now, overtimeFrom = 15 }) {
  const nowMs = ms(now);
  const spans = sessionsOf(punches.filter((p) => p.status !== 'rejected' && !p.voided_at), now);
  const worked = spans.reduce((s, x) => s + x.workedMin, 0);
  const brk = spans.reduce((s, x) => s + x.breakMin, 0);
  const first = spans[0] || null;
  const last = spans[spans.length - 1] || null;
  const open = !!(last && last.open);
  const incomplete = spans.some((s) => s.outPunch && s.outPunch.source === 'auto');
  const r = {
    on, spans, firstIn: first ? first.in : null, lastOut: last && !open ? last.out : null, open, onBreak: !!(last && last.onBreak), incomplete,
    workedMin: Math.round(worked), breakMin: Math.round(brk), lateMin: 0, earlyMin: 0, overtimeMin: 0, scheduledMin: on ? on.net : 0, status: 'off',
  };
  if (on && first) {
    const late = (ms(first.in) - ms(on.start)) / 60000;
    if (late > on.grace) r.lateMin = Math.round(late);
    if (!open && last.out) {
      const early = (ms(on.end) - ms(last.out)) / 60000;
      if (early > on.grace) r.earlyMin = Math.round(early);
    }
  }
  const extra = worked - (on ? on.net : 0);
  if (!open && extra >= overtimeFrom) r.overtimeMin = Math.round(extra);
  if (spans.length) {
    r.status = open ? (r.onBreak ? 'on_break' : 'working') : 'done';
    return r;
  }
  if (holiday) { r.status = 'holiday'; return r; }
  if (leave) { r.status = 'leave'; r.leave = leave; return r; }
  if (!on) { r.status = 'off'; return r; }
  if (nowMs < ms(on.start) + on.grace * 60000) r.status = 'upcoming';
  else if (nowMs < ms(on.end)) r.status = 'not_in';
  else r.status = 'absent';
  return r;
}

module.exports = { distance, offset, parsePoint, validPoint, verdict, LIMITS, cairo, cairoAt, addDays, hmMin, isoDay, daysOf, shiftOn, workDate, nextAllowed, sessionsOf, computeDay };
