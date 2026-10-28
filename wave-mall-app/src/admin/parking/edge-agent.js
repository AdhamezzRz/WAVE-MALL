#!/usr/bin/env node
'use strict';

// The Wave · parking edge agent
//
// Runs on a computer in the car park, beside the gate controllers and pay machines, and keeps them
// working when the internet does not. Node.js 18 or newer, no packages to install.
//
//   WAVE_URL=https://thewave.example PARKING_API_KEY=… node wave-parking-edge.js
//
// Settings (environment):
//   WAVE_URL              the website (required)
//   PARKING_API_KEY       the gate key set on the server (required)
//   PARKING_HMAC_SECRET   when the server checks signatures
//   EDGE_DEVICE           this agent's name in the office (default: the computer's name)
//   EDGE_PORT             where the gates reach the agent (default 8787)
//   EDGE_DATA             folder for its copy and its queue (default ./wave-parking-data)
//   EDGE_TIMEOUT_MS       how long to wait for the server before deciding alone (default 2500)
//
// The gates send the agent the same requests they would send the server (POST /gate, GET /quote,
// POST /pay, GET /status) and get the same answers. While the server answers, the agent passes
// everything through. When it does not, the agent decides from its last copy (subscribers, blocked
// plates, bookings, the cars inside and what they paid, the tariff), prints tickets with codes of its
// own and queues each event; back online, it sends the queue (POST /ingest/parking/batch), which the
// server replays once.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL_ = String(process.env.WAVE_URL || '').replace(/\/+$/, '');
const KEY = process.env.PARKING_API_KEY || '';
const HMAC = process.env.PARKING_HMAC_SECRET || '';
const DEVICE = (process.env.EDGE_DEVICE || os.hostname() || 'edge').replace(/[^\w.-]/g, '-').slice(0, 40);
const PORT = Number(process.env.EDGE_PORT) || 8787;
const DATA = path.resolve(process.env.EDGE_DATA || './wave-parking-data');
const TIMEOUT = Number(process.env.EDGE_TIMEOUT_MS) || 2500;
if (!URL_ || !KEY) {
  console.error('Set WAVE_URL and PARKING_API_KEY.');
  process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });
const COPY = path.join(DATA, 'copy.json');
const QUEUE = path.join(DATA, 'queue.jsonl');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- the same rules as the server ----------
const AR_DIG = '٠١٢٣٤٥٦٧٨٩';
const FA_DIG = '۰۱۲۳۴۵۶۷۸۹';
function plateKey(s) {
  let x = String(s ?? '').normalize('NFKC');
  x = x.replace(/[٠-٩]/g, (d) => AR_DIG.indexOf(d)).replace(/[۰-۹]/g, (d) => FA_DIG.indexOf(d));
  x = x.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/[ً-ْـ]/g, '');
  x = x.toUpperCase().replace(/[^A-Z0-9ء-ي]/g, '');
  return (x.replace(/[0-9]/g, '') + x.replace(/[^0-9]/g, '')).slice(0, 16);
}
const cardKey = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 32);
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => Array.from(crypto.randomBytes(8), (x) => ALPHABET[x % 32]).join('');
const codeShow = (c) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : null);
const codeOf = (s) => {
  const m = String(s || '').match(/\/parking\/t\/([A-Za-z0-9-]{8,9})/);
  const c = (m ? m[1] : String(s || '')).toUpperCase().replace(/-/g, '');
  return /^[2-9A-HJ-NP-Z]{8}$/.test(c) ? c : null;
};
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const minutesBetween = (a, b) => Math.max(0, Math.ceil((Date.parse(b) - Date.parse(a)) / 60000));
function hourly(t, min) {
  if (min <= 0) return 0;
  const hours = Math.max(1, Math.ceil(Math.max(1, min - (Number(t.round_min) || 0)) / 60));
  const price = Number(t.first_hour || 0) + (hours - 1) * Number(t.next_hour || 0);
  return r2(Number(t.daily_cap) > 0 ? Math.min(price, Number(t.daily_cap)) : price);
}
function cost(t, min) {
  min = Math.max(0, Math.ceil(Number(min) || 0));
  if (min <= (Number(t.grace_min) || 0)) return 0;
  const days = Math.floor(min / 1440);
  return r2(days * (Number(t.day_rate) > 0 ? Number(t.day_rate) : hourly(t, 1440)) + hourly(t, min - days * 1440));
}
// what a car inside owes now (the server's quote, from the copy)
function quote(car, at) {
  const t = copy.tariff || {};
  const minutes = minutesBetween(car.entry_at, at);
  let net = 0;
  if (car.pays) {
    const gross = cost(t, minutes) + (car.lost ? Number(t.lost_fee) || 0 : 0);
    if (car.whole) net = car.lost ? Number(t.lost_fee) || 0 : 0;
    else net = car.free_min <= 0 ? gross : minutes <= car.free_min ? 0 : gross - cost(t, car.free_min);
  }
  const inWindow = car.paid_at && car.paid > 0 && Date.parse(at) - Date.parse(car.paid_at) <= (Number(t.exit_min) || 0) * 60000;
  const owed = (inWindow ? car.owed_at_pay ?? net : net) + (car.extra || 0);
  return { minutes, price: r2(net + (car.extra || 0)), due: r2(Math.max(0, owed - (car.paid || 0))), exit_minutes: Number(t.exit_min) || 0 };
}

// ---------- the copy and the queue ----------
let copy = { inside: [], permits: [], blocked: [], bookings: [], lanes: [], tariff: null };
try { copy = JSON.parse(fs.readFileSync(COPY, 'utf8')); } catch { /* first run */ }
function saveCopy() {
  fs.writeFileSync(`${COPY}.tmp`, JSON.stringify(copy));
  fs.renameSync(`${COPY}.tmp`, COPY);
}
let queue = [];
try { queue = fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* empty */ }
const enqueue = (e) => {
  const ev = { id: `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`, time: new Date().toISOString(), ...e };
  queue.push(ev);
  fs.appendFileSync(QUEUE, `${JSON.stringify(ev)}\n`);
  return ev;
};
const saveQueue = () => fs.writeFileSync(QUEUE, queue.map((e) => `${JSON.stringify(e)}\n`).join(''));

// ---------- talking to the server ----------
let online = false;
let failedAt = 0;
async function server(method, p, body) {
  const raw = body ? JSON.stringify(body) : undefined;
  const headers = { 'x-api-key': KEY, 'content-type': 'application/json', 'x-edge-device': DEVICE };
  if (HMAC && raw) headers['x-signature'] = `sha256=${crypto.createHmac('sha256', HMAC).update(raw).digest('hex')}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${URL_}/ingest/parking${p}`, { method, headers, body: raw, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 500 || r.status === 429) throw new Error(`server ${r.status}`);
    if (!online) log('server reachable again');
    online = true;
    return { status: r.status, body: j };
  } catch (e) {
    if (online) log('server unreachable, deciding at the gate:', e.message);
    online = false;
    failedAt = Date.now();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
async function sync() {
  try {
    const r = await server('GET', `/sync?device=${encodeURIComponent(DEVICE)}`);
    if (r.status === 200 && r.body.ok) {
      // keep cars that entered offline and are not on the server yet
      const pending = copy.inside.filter((c) => c.offline && !r.body.inside.some((x) => x.ticket === c.ticket));
      copy = { ...r.body, inside: [...r.body.inside, ...pending], synced_at: new Date().toISOString() };
      saveCopy();
    }
  } catch { /* offline: keep the last copy */ }
}
let flushing = false;
async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    while (queue.length) {
      const batch = queue.slice(0, 100);
      const r = await server('POST', '/batch', { device: DEVICE, events: batch });
      if (r.status !== 200) { log('batch refused:', r.status, r.body.error || ''); break; }
      const done = new Set((r.body.results || []).map((x) => x.id));
      queue = queue.filter((e) => !done.has(e.id));
      saveQueue();
      log(`sent ${done.size} offline events, ${queue.length} left`);
      if (!done.size) break;
    }
    if (!queue.length) await sync();
  } catch { /* still offline */ } finally {
    flushing = false;
  }
}

// ---------- deciding at the gate ----------
const nowIso = () => new Date().toISOString();
const findCar = ({ ticket, card, plate }) => {
  const code = codeOf(ticket);
  const ck = cardKey(card);
  const pk = plateKey(plate);
  return copy.inside.find((c) => (code && c.ticket === code) || (ck && c.card === ck) || (pk && c.plate === pk)) || null;
};
const MSG = {
  welcome: ['Welcome to The Wave.', 'أهلًا بك في ذا ويف.'], back: ['Welcome back.', 'أهلًا بعودتك.'], bye: ['Thank you. Drive safely.', 'شكرًا لك. قُد بأمان.'],
  blocked: ['Please wait: security will assist you.', 'من فضلك انتظر: سيساعدك الأمن.'], unknown: ['No entry found. Please press the help button.', 'لم نجد دخولًا. من فضلك اضغط زر المساعدة.'],
  full: ['Car park full. Please come back shortly.', 'الجراج ممتلئ. من فضلك عد بعد قليل.'],
};
const msg = (k, extra) => ({ en: MSG[k][0], ar: MSG[k][1], ...(extra || {}) });
function localGate(b) {
  const lane = (copy.lanes || []).find((l) => l.code === String(b.lane || '')) || { code: String(b.lane || ''), direction: 'in', prints: true };
  const event = b.event === 'exit' || (b.event !== 'entry' && lane.direction === 'out') ? 'exit' : 'entry';
  const pk = plateKey(b.plate);
  const ck = cardKey(b.card);
  const at = nowIso();
  if (event === 'entry') {
    if (pk && copy.blocked.includes(pk)) {
      enqueue({ type: 'entry', lane: lane.code, plate: b.plate, card: b.card, opened: false });
      return { ok: true, open: false, reason: 'blocked', message: msg('blocked'), offline: true };
    }
    const permit = copy.permits.find((p) => (ck && p.card === ck) || (pk && p.plates.includes(pk)));
    const before = findCar({ card: ck, plate: pk });
    if (before && minutesBetween(before.entry_at, at) <= (copy.repeat_min || 5)) return { ok: true, open: true, reason: 'repeat', message: msg('back'), ticket: codeShow(before.ticket), offline: true };
    if (!permit && copy.block_full && copy.capacity && copy.inside.length >= copy.capacity) return { ok: true, open: false, reason: 'full', message: msg('full'), offline: true };
    const code = newCode();
    copy.inside = copy.inside.filter((c) => c !== before);
    copy.inside.push({ ticket: code, plate: pk || null, card: ck || null, kind: permit ? permit.kind : 'visitor', entry_at: at, pays: !permit, free_min: 0, whole: false, extra: 0, paid: 0, paid_at: null, offline: true });
    saveCopy();
    enqueue({ type: 'entry', lane: lane.code, plate: b.plate || '', card: b.card || '', ticket: code, opened: true });
    return {
      ok: true, open: true, reason: permit ? permit.kind : 'visitor', message: msg(permit ? 'back' : 'welcome'), ticket: codeShow(code), ticket_url: `${URL_}/parking/t/${codeShow(code)}`,
      print: !permit && !pk && lane.prints !== false, kind: permit ? permit.kind : 'visitor', due: 0, offline: true,
    };
  }
  const car = findCar({ ticket: b.ticket, card: ck, plate: pk });
  if (!car) return { ok: true, open: false, reason: 'unknown', message: msg('unknown'), offline: true };
  const q = quote(car, at);
  if (q.due > 0) {
    enqueue({ type: 'exit', lane: lane.code, plate: b.plate || '', card: b.card || '', ticket: car.ticket, opened: false });
    return { ok: true, open: false, reason: 'unpaid', due: q.due, message: { en: `Please pay ${q.due} at a machine or the booth.`, ar: `من فضلك ادفع ${q.due} عند الماكينة أو الكشك.` }, ticket: codeShow(car.ticket), offline: true };
  }
  copy.inside = copy.inside.filter((c) => c !== car);
  saveCopy();
  enqueue({ type: 'exit', lane: lane.code, plate: b.plate || '', card: b.card || '', ticket: car.ticket, opened: true });
  return { ok: true, open: true, reason: car.kind, message: msg('bye'), ticket: codeShow(car.ticket), kind: car.kind, due: 0, offline: true };
}
function localQuote(q) {
  const car = findCar({ ticket: q.ticket, card: q.card, plate: q.plate });
  if (!car) return [404, { ok: false, error: 'No car inside matches.' }];
  const x = quote(car, nowIso());
  return [200, { ok: true, ticket: codeShow(car.ticket), entered: car.entry_at, minutes: x.minutes, price: x.price, paid: car.paid, due: x.due, exit_minutes: x.exit_minutes, offline: true }];
}
function localPay(b) {
  if (!b.device) return [422, { ok: false, error: 'Send the machine’s device id.' }];
  const car = findCar({ ticket: b.ticket, card: b.card, plate: b.plate });
  if (!car) return [404, { ok: false, error: 'No car inside matches.' }];
  const amount = r2(b.amount);
  const before = quote(car, nowIso());
  if (!(amount > 0) || amount > before.due + 0.001) return [422, { ok: false, error: 'The amount is more than is due.' }];
  car.owed_at_pay = before.price - (car.extra || 0);
  car.paid = r2((car.paid || 0) + amount);
  car.paid_at = nowIso();
  saveCopy();
  const ev = enqueue({ type: 'pay', device: String(b.device).slice(0, 30), ticket: car.ticket, amount, method: b.method || 'card', reference: b.reference || null });
  return [200, { ok: true, receipt: `OFF-${ev.id}`, paid: amount, due: quote(car, nowIso()).due, exit_minutes: before.exit_minutes, offline: true }];
}

// ---------- the agent's own small server, for the gates ----------
const read = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});
const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://edge');
  const p = u.pathname.replace(/^\/ingest\/parking/, '');
  // the gates use the same key with the agent as with the server
  const sent = String(req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (p !== '/health' && sent !== KEY) return send(res, 401, { ok: false, error: 'Unauthorized' });
  if (p === '/health') return send(res, 200, { ok: true, device: DEVICE, online, queued: queue.length, synced_at: copy.synced_at || null, inside: copy.inside.length });
  const body = req.method === 'POST' ? await read(req) : null;
  // queued events go first, so the server sees them in order
  if (queue.length && online) await flush();
  // just failed: the gate gets an answer at once instead of waiting for the server again
  const recentlyDown = !online && Date.now() - failedAt < 10000;
  if (!queue.length && !recentlyDown) {
    try {
      const r = await server(req.method, `${p}${u.search}`, body);
      // keep the copy current with what just happened
      if (p === '/gate' && r.body.ok && r.body.open) setImmediate(sync);
      if (p === '/pay' && r.body.ok) setImmediate(sync);
      return send(res, r.status, r.body);
    } catch { /* decide here */ }
  }
  if (req.method === 'POST' && p === '/gate') return send(res, 200, localGate(body || {}));
  if (req.method === 'GET' && p === '/quote') { const [s, b] = localQuote(Object.fromEntries(u.searchParams)); return send(res, s, b); }
  if (req.method === 'POST' && p === '/pay') { const [s, b] = localPay(body || {}); return send(res, s, b); }
  if (req.method === 'GET' && p === '/status') return send(res, 200, { ok: true, capacity: copy.capacity || 0, cars: copy.inside.length, free: Math.max(0, (copy.capacity || 0) - copy.inside.length), full: !!copy.capacity && copy.inside.length >= copy.capacity, offline: true });
  return send(res, 503, { ok: false, error: 'The server cannot be reached and this request needs it.', offline: true });
}).listen(PORT, () => log(`edge agent ${DEVICE} listening on ${PORT}; server ${URL_}; ${queue.length} events queued`));

sync().then(flush);
setInterval(sync, 60 * 1000);
setInterval(flush, 15 * 1000);
