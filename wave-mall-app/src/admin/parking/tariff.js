'use strict';

// What a stay in the car park costs. Pure functions (no database), shared by the gates, the booth,
// the pay page and the tests.
//
// A tariff:
//   grace_min    minutes free for a short stay (drop-off, turned around): the whole stay is free
//   first_hour   price of the first hour
//   next_hour    price of each further hour (started hours count, after round_min minutes of tolerance)
//   daily_cap    the most one day (24 hours) can cost; 0 for no cap
//   day_rate     price of each full 24 hours (overnight and long stays); the hours after the last full
//                day are charged by the hour again, never more than daily_cap
//   lost_fee     added when the visitor has lost the ticket (and the plate is not readable)
//   exit_min     minutes allowed to reach the exit after paying
// Prices include VAT.
//
// Validations: a shop or the mall makes part or all of a stay free. Free minutes come off the start of
// the stay (two free hours make the first two hours free); `whole` makes the whole visit free.

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const DAY = 1440;

const DEFAULT = Object.freeze({ grace_min: 15, first_hour: 20, next_hour: 10, round_min: 5, daily_cap: 100, day_rate: 120, lost_fee: 150, exit_min: 15 });

const minutesBetween = (from, to) => Math.max(0, Math.ceil((Date.parse(to) - Date.parse(from)) / 60000));

// The price of the hourly part of a stay (under 24 hours).
function hourly(t, min) {
  if (min <= 0) return 0;
  const hours = Math.max(1, Math.ceil(Math.max(1, min - (Number(t.round_min) || 0)) / 60));
  const price = Number(t.first_hour || 0) + (hours - 1) * Number(t.next_hour || 0);
  const cap = Number(t.daily_cap) || 0;
  return r2(cap > 0 ? Math.min(price, cap) : price);
}

// The price of a stay of `min` minutes, before validations and payments.
function cost(t, min) {
  min = Math.max(0, Math.ceil(Number(min) || 0));
  if (min <= (Number(t.grace_min) || 0)) return 0;
  const days = Math.floor(min / DAY);
  const rest = min - days * DAY;
  const dayRate = Number(t.day_rate) || 0;
  // a day rate of 0 means each 24 hours is charged like a capped day
  const perDay = dayRate > 0 ? dayRate : hourly(t, DAY);
  return r2(days * perDay + hourly(t, rest));
}

// What is owed for a stay. stay = { minutes | entry_at + at, free_min, whole, paid, lost, paid_at }
// Returns { minutes, gross, free, net, paid, due, inExitWindow }.
function quote(t, stay) {
  const minutes = stay.minutes ?? minutesBetween(stay.entry_at, stay.at || new Date().toISOString());
  const gross = r2(cost(t, minutes) + (stay.lost ? Number(t.lost_fee) || 0 : 0));
  let net;
  if (stay.whole) net = stay.lost ? r2(Number(t.lost_fee) || 0) : 0;
  else {
    const free = Math.max(0, Number(stay.free_min) || 0);
    net = free <= 0 ? gross : minutes <= free ? r2(stay.lost ? Number(t.lost_fee) || 0 : 0) : r2(gross - cost(t, free));
  }
  net = Math.max(0, net);
  const paid = r2(stay.paid || 0);
  // just paid: the way to the exit is free
  const exitMin = Number(t.exit_min) || 0;
  const at = stay.at || new Date().toISOString();
  const inExitWindow = !!stay.paid_at && paid > 0 && Date.parse(at) - Date.parse(stay.paid_at) <= exitMin * 60000;
  const due = inExitWindow ? 0 : r2(Math.max(0, net - paid));
  return { minutes, gross, free: r2(gross - net), net, paid, due, inExitWindow };
}

// A table of example stays for the rates screen and the public page.
const EXAMPLES = [10, 45, 90, 150, 240, 360, 600, 1440, 1800, 2 * 1440 + 180];
const examples = (t) => EXAMPLES.map((m) => ({ minutes: m, price: cost(t, m) }));

// "2 h 05 min", "1 day 3 h"
function duration(min, tr = (k, p) => k.replace(/^\w+\|/, '').replace(/\{(\w+)\}/g, (_, x) => p[x])) {
  min = Math.max(0, Math.round(min));
  const d = Math.floor(min / DAY);
  const h = Math.floor((min % DAY) / 60);
  const m = min % 60;
  if (d) return h ? tr('prk|{d} d {h} h', { d, h }) : tr('prk|{d} d', { d });
  if (h) return m ? tr('prk|{h} h {m} min', { h, m: String(m).padStart(2, '0') }) : tr('prk|{h} h', { h });
  return tr('prk|{m} min', { m });
}

module.exports = { DEFAULT, cost, quote, hourly, examples, duration, minutesBetween, r2 };
