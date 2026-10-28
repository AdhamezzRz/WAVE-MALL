'use strict';

// Background jobs for the leasing office (one Node process on Hostinger). Each job runs on an
// interval, never overlaps itself, and records when it last ran and how it went (shown on the
// Integrations page). Jobs do not run under tests (NODE_ENV=test or ADMIN_DB=:memory:) unless
// forced; call run(name) to run one on demand.

function scheduler({ enabled = true } = {}) {
  const jobs = new Map();
  const timers = [];
  async function run(name) {
    const j = jobs.get(name);
    if (!j || j.running) return false;
    j.running = true;
    j.lastStart = new Date().toISOString();
    try {
      await j.fn();
      j.lastOk = j.lastStart;
      j.lastError = null;
    } catch (err) {
      j.lastError = String(err && err.message ? err.message : err).slice(0, 300);
      console.error(`[admin] job ${name} failed:`, j.lastError);
    } finally {
      j.running = false;
      j.runs++;
    }
    return true;
  }
  return {
    // every('daily-digest', 60 * 60 * 1000, fn, { first: 5 * 60 * 1000 })
    every(name, ms, fn, { first = ms } = {}) {
      jobs.set(name, { name, ms, fn, running: false, runs: 0, lastStart: null, lastOk: null, lastError: null });
      if (!enabled) return;
      const start = setTimeout(() => {
        run(name);
        const t = setInterval(() => run(name), ms);
        if (t.unref) t.unref();
        timers.push(t);
      }, first);
      if (start.unref) start.unref();
      timers.push(start);
    },
    run,
    list: () => [...jobs.values()].map(({ fn, ...j }) => j),
    stop: () => timers.forEach((t) => clearTimeout(t)),
  };
}

module.exports = { scheduler };
