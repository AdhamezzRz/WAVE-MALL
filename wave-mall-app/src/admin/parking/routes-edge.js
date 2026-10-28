'use strict';

// Gates that keep working when the internet does not.
//
// A small edge agent (edge-agent.js, Node with no dependencies) runs on a computer in the car park
// beside the gate controllers, which talk to it instead of to the server. While the server answers,
// the agent passes everything through. When it does not, the agent decides at the gate from what it
// last synced (subscribers' plates and cards, blocked plates, bookings, the cars inside and what
// each has paid, the tariff), prints tickets with codes of its own, takes pay-machine payments, and
// queues every event. Back online, it sends the queue here:
//
//   GET  /ingest/parking/sync    what the agent needs to decide alone (every minute)
//   POST /ingest/parking/batch   the queued events: each has the agent's own id, so a batch sent twice
//                                changes nothing; replayed in time order (payments before the exit
//                                they paid for); tickets printed offline keep their codes.
//
// Both sit behind the gate key (PARKING_API_KEY, and PARKING_HMAC_SECRET when set).

const fs = require('node:fs');
const path = require('node:path');
const { t: tr } = require('../i18n');

const AGENT = path.join(__dirname, 'edge-agent.js');

module.exports = function edgeRoutes(router, h, c) {
  const { db, ui } = h;
  const { P, esc } = c;
  const api = h.parkingApi;
  const now = () => new Date().toISOString();
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  // an offline gate's events can be days old; anything older than a week, or in the future, is refused
  const timeOf = (v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) && t <= Date.now() + 5 * 60000 && Date.now() - t < 7 * 86400000 ? new Date(t).toISOString() : null;
  };

  // what the agent needs to decide at the gate on its own
  function sync() {
    const t = now();
    const d = c.today();
    const tariff = P.tariffAt(t);
    const permits = db.all("SELECT id, ref, holder, plate_keys, card_uid, cars, ends_on FROM pk_permits WHERE status = 'active' AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?)", d, d)
      .map((p) => ({ ref: p.ref, kind: p.holder, plates: String(p.plate_keys || '').split(',').filter(Boolean), card: p.card_uid || null, cars: p.cars, ends_on: p.ends_on }));
    const blocked = db.all("SELECT plate_key FROM pk_lists WHERE kind = 'block' AND (until IS NULL OR until >= ?)", d).map((x) => x.plate_key);
    const bookings = db.all("SELECT ref, plate_key, starts_at, ends_at FROM pk_bookings WHERE status IN ('confirmed', 'arrived') AND ends_at > ? AND starts_at < ?", t, new Date(Date.now() + 2 * 86400000).toISOString())
      .filter((b) => b.plate_key);
    const inside = db.all("SELECT * FROM pk_sessions WHERE status = 'inside'").map((s) => {
      const q = P.quoteOf(s, t);
      return {
        ticket: s.code, plate: s.plate_key || null, card: s.card_uid || null, kind: s.kind, entry_at: s.entry_at,
        pays: !!q.tariff, free_min: q.freeMin + (q.covered || 0), whole: q.whole, lost: !!s.lost, extra: q.extra, paid: q.paid, paid_at: s.paid_at || null,
      };
    });
    const lanes = db.all('SELECT code, direction, active, prints FROM pk_lanes').map((l) => ({ code: l.code, direction: l.direction, active: !!l.active, prints: !!l.prints }));
    const o = P.occupancy();
    return {
      ok: true, server_time: t, tariff: { grace_min: tariff.grace_min, first_hour: tariff.first_hour, next_hour: tariff.next_hour, round_min: tariff.round_min, daily_cap: tariff.daily_cap, day_rate: tariff.day_rate, lost_fee: tariff.lost_fee, exit_min: tariff.exit_min },
      capacity: o.capacity, block_full: !!P.N('prk_block_full'), repeat_min: P.N('prk_repeat_min'), lanes, permits, blocked, bookings, inside,
    };
  }
  api.get('/sync', (req, res) => {
    const device = str(req.query.device, 40) || 'edge';
    db.setSetting(`prk_edge_seen:${device}`, now());
    res.json(sync());
  });

  // one queued event, replayed; returns what happened (stored against the event's id)
  function replay(e, device) {
    const at = timeOf(e.time);
    if (!at) return { ok: false, error: 'time' };
    const lane = P.laneBy(str(e.lane, 20));
    const plate = str(e.plate, 30);
    const card = str(e.card, 40);
    const ticket = str(e.ticket, 20).replace(/^.*\/parking\/t\//, '');
    if (e.type === 'entry') {
      if (e.opened === false) return { ok: true, skipped: 'refused at the gate' };
      const r = P.entry({ lane, plate, card, code: ticket, at, force: true, via: card ? 'card' : plate ? 'anpr' : 'ticket' });
      return { ok: true, visit: r.session ? r.session.ref : null, ticket: r.session ? P.codeShow(r.session.code) : null, kept: !!(r.session && ticket && r.session.code === ticket.toUpperCase().replace(/-/g, '')) };
    }
    if (e.type === 'pay') {
      const s = P.findInside(P.readCredential(ticket || card || plate));
      if (!s) return { ok: false, error: 'no car inside' };
      const ref = str(e.reference, 80) || `edge:${e.id}`;
      if (db.get('SELECT id FROM pk_payments WHERE reference = ? AND session_id = ?', ref, s.id)) return { ok: true, duplicate: true };
      const method = ['cash', 'card', 'wallet', 'instapay'].includes(e.method) ? e.method : 'card';
      const p = P.pay(s, { amount: Number(e.amount), method, till: P.machineTill(str(e.device, 30) || device, at), device: str(e.device, 30) || device, reference: ref, at });
      return { ok: true, receipt: p.ref };
    }
    if (e.type === 'exit') {
      if (e.opened === false) return { ok: true, skipped: 'refused at the gate' };
      let r = P.exit({ lane, plate, card, code: ticket, at });
      // the barrier opened offline on what the agent knew; anything still due is written off, with the reason
      if (!r.open && r.reason === 'unpaid') r = P.exit({ lane, plate, card, code: ticket, at, manual: true, reason: 'Gate offline: opened by the edge agent' });
      return { ok: r.open || r.reason === 'unknown', reason: r.reason || null, visit: r.session ? r.session.ref : null };
    }
    return { ok: false, error: 'type' };
  }
  api.post('/batch', (req, res) => {
    const device = str(req.body.device, 40) || 'edge';
    const list = (Array.isArray(req.body.events) ? req.body.events : []).slice(0, 200).filter((e) => e && typeof e === 'object' && /^[\w.:-]{6,80}$/.test(String(e.id || '')));
    // payments before an exit at the same moment
    const order = { entry: 0, pay: 1, exit: 2 };
    list.sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0) || (order[a.type] ?? 3) - (order[b.type] ?? 3));
    const results = [];
    for (const e of list) {
      const id = `${device}:${e.id}`;
      const done = db.get('SELECT result FROM pk_edge_events WHERE id = ?', id);
      if (done) { results.push({ id: e.id, ...JSON.parse(done.result), duplicate: true }); continue; }
      let out;
      try {
        out = replay(e, device);
      } catch (err) {
        out = { ok: false, error: String(err.message).slice(0, 200) };
      }
      db.run('INSERT OR IGNORE INTO pk_edge_events (id, device, payload, result, at) VALUES (?, ?, ?, ?, ?)', id, device, JSON.stringify(e).slice(0, 4000), JSON.stringify(out), now());
      results.push({ id: e.id, ...out });
    }
    db.setSetting(`prk_edge_seen:${device}`, now());
    if (list.length) h.events.emit('parking.edge', { device, count: list.length });
    res.json({ ok: true, accepted: results.length, results });
  });

  // ---------- the office: download the agent, see the agents ----------
  router.get('/parking/edge-agent.js', c.RM, (req, res) => {
    h.log(req, 'Downloaded the parking edge agent', 'setting', null, '');
    res.set('Content-Disposition', 'attachment; filename="wave-parking-edge.js"').type('application/javascript').send(fs.readFileSync(AGENT, 'utf8'));
  });
  h.parking.edge = { sync, replay };

  (h.parkingSetupCards = h.parkingSetupCards || []).push((req) => {
    const devices = db.all("SELECT key, value FROM settings WHERE key LIKE 'prk_edge_seen:%' ORDER BY value DESC").map((x) => {
      const device = x.key.slice('prk_edge_seen:'.length);
      return { device, seen: x.value, events: db.value('SELECT COUNT(*) FROM pk_edge_events WHERE device = ?', device), last: db.get('SELECT at FROM pk_edge_events WHERE device = ? ORDER BY at DESC LIMIT 1', device) };
    });
    const list = devices.length ? `<ul class="list pk-list">${devices.map((d) => `<li><span class="what"><b class="ltr">${esc(d.device)}</b><small>${esc(tr('prk|Last in touch {when} · {n} offline events sent', { when: ui.rel(d.seen), n: d.events }))}</small></span>${Date.now() - Date.parse(d.seen) < 5 * 60000 ? ui.badge('on', tr('prk|Connected'), 'ok') : ui.badge('off', tr('prk|Not heard from'), 'rose')}</li>`).join('')}</ul>` : `<p class="muted small">${esc(tr('prk|No edge agent has connected yet.'))}</p>`;
    const steps = [
      'prk|On a computer in the car park with Node.js 18 or newer, save the agent and run it with the same gate key as the server:',
      'prk|Point the gate controllers and pay machines at the agent (port 8787) instead of the server: the same requests, the same answers.',
      'prk|If the server stops answering, the agent decides at the gate from its last copy (subscribers, blocked plates, cars inside, what they paid) and sends everything when the line is back.',
    ];
    const cmd = `WAVE_URL=${c.site(req)} PARKING_API_KEY=… node wave-parking-edge.js`;
    return ui.card(tr('prk|Gates that work offline'), `<ol class="pk-steps">${steps.map((s, i) => `<li>${esc(tr(s))}${i === 0 ? `<pre class="pk-code ltr">${esc(cmd)}</pre>` : ''}</li>`).join('')}</ol>${list}${h.can(req, 'manager') ? `<p>${ui.btn(esc(tr('prk|Download the edge agent')), { href: '/admin/parking/edge-agent.js', cls: 'btn--ghost btn--sm', ic: 'dl' })}</p>` : ''}`, { sub: esc(tr('prk|An edge agent beside the gates keeps them working without the internet.')) });
  });
};
