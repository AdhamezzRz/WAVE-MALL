'use strict';

// A small synchronous event bus for the leasing office. Modules announce what happened
// (h.events.emit('invoice.issued', {...})); others react (accounting posts journals, the
// tenant portal notifies, the website refreshes). A failing listener is logged and never breaks
// the action that emitted the event.
//
// Events in use (payload fields):
//   invoice.created   { invoice }               any new invoice (rent schedules create future ones)
//   invoice.voided    { invoice }
//   payment.received  { payment, invoice }      money in against an invoice
//   payment.reversed  { payment, invoice }
//   payroll.approved  { run, lines }            HR payroll locked
//   payroll.paid      { run, lines, date }
//   parking.entry     { session }               a car came in (parking/core.js)
//   parking.exit      { session }               a car left, its price final
//   parking.paid      { session, payment }      money for a visit (booth, machine or online)
//   parking.validated { session, validation }   a shop or the mall made a visit free
//   (modules may add their own: name them 'area.what' and document them here)

function bus() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(fn);
      return () => map.set(name, map.get(name).filter((f) => f !== fn));
    },
    emit(name, payload = {}) {
      for (const fn of [...(map.get(name) || []), ...(map.get('*') || [])]) {
        try {
          fn(payload, name);
        } catch (err) {
          console.error(`[admin] listener for ${name} failed:`, err.message);
        }
      }
    },
    names: () => [...map.keys()],
  };
}

module.exports = { bus };
