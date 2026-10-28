'use strict';

// What the three revenue modules share: period labels, sparklines, lease facts, CSV and credit notes.
//
// Credit notes. The billing service refuses negative invoices, so money owed back to a tenant
// (a service-charge settlement in the tenant's favour, a turnover true-up below what was billed)
// is kept as a credit note (revenue_credits, CN-YYYY-0001). Open credits are applied when this
// module next bills the same lease (a settlement, utilities or turnover rent): the new invoice is
// reduced by the credit, each use is recorded (revenue_credit_uses) and printed on the statement.
// A credit can also be marked as refunded, which closes it.

const { t: tr } = require('../i18n');
const C = require('./calc');

module.exports = function common(h) {
  const { db, ui, M } = h;

  // "October 2026", "Q4 2026", "2026"
  const periodLabel = (p) => {
    if (/^\d{4}-\d{2}$/.test(p)) return ui.monthYear(p);
    const q = /^(\d{4})-Q([1-4])$/.exec(p);
    if (q) return tr('trn|Q{q} {year}', { q: q[2], year: q[1] });
    return String(p || '');
  };
  const shortMonth = (ym) => `${ui.monthName(Number(ym.slice(5, 7)))} ${ym.slice(2, 4)}`;
  const lastMonth = () => C.ymAdd(C.ymOf(M.today()), -1);
  const thisYear = () => Number(M.today().slice(0, 4));

  // A small trend line (no axes) for tables.
  function sparkline(values, { w = 96, h: ht = 26, tone = 'forest' } = {}) {
    const v = values.map((x) => (x === null || x === undefined ? null : Number(x)));
    const real = v.filter((x) => x !== null);
    if (real.length < 2) return '<span class="rev-spark rev-spark--empty">—</span>';
    const max = Math.max(...real);
    const min = Math.min(...real);
    const span = max - min || 1;
    const step = w / (v.length - 1);
    const pts = v.map((x, i) => (x === null ? null : [i * step, ht - 3 - ((x - min) / span) * (ht - 6)]));
    const segs = [];
    let cur = [];
    for (const p of pts) {
      if (p) cur.push(p);
      else if (cur.length) { segs.push(cur); cur = []; }
    }
    if (cur.length) segs.push(cur);
    const last = pts.filter(Boolean).at(-1);
    return `<svg class="rev-spark rev-spark--${tone}" viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}" aria-hidden="true">${segs.map((s) => `<polyline points="${s.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/>`).join('')}<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4"/></svg>`;
  }

  const pct1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`);
  const change = (now, before) => {
    if (!before || now === null || now === undefined) return '<span class="muted">—</span>';
    const d = (now - before) / before;
    return `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(1)}%</span>`;
  };

  // Leases with their brand and units.
  const leaseOf = (id) => {
    const s = db.get('SELECT s.*, b.name brand_name, b.category FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.id = ?', id);
    if (s) s.units = M.leaseUnits(db, s.id);
    return s;
  };
  const activeLeases = () => db.all("SELECT s.*, b.name brand_name, b.category FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.status = 'active' ORDER BY b.name")
    .map((s) => ({ ...s, units: M.leaseUnits(db, s.id) }));
  // The lease that held a unit in a month (active, ended or terminated leases).
  const leaseForUnit = (unitId, ym) => db.all(
    "SELECT s.* FROM lease_units lu JOIN leases s ON s.id = lu.lease_id WHERE lu.unit_id = ? AND s.status IN ('active','ended','terminated') ORDER BY s.start_date DESC", unitId,
  ).find((s) => C.monthCover(s, ym) > 0) || null;

  // ---------- credit notes ----------
  function openCredits(leaseId) {
    return db.all("SELECT * FROM revenue_credits WHERE lease_id = ? AND status = 'open' ORDER BY created_at, id", leaseId);
  }
  function addCredit({ lease_id, brand_id, source, source_ref, amount, note, demo = 0 }) {
    const id = Number(db.run(
      'INSERT INTO revenue_credits (ref, lease_id, brand_id, source, source_ref, amount, note, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      db.nextRef('revenue_credits', 'CN', 4, true), lease_id, brand_id, source, source_ref || null, C.r2(amount), note || null, demo ? 1 : 0, M.now(),
    ).lastInsertRowid);
    return db.get('SELECT * FROM revenue_credits WHERE id = ?', id);
  }
  // Takes open credits against an amount about to be billed. Returns { net, uses: [{ credit, amount }] };
  // call recordUses(uses, invoiceId) once the invoice exists (or with null when nothing was billed).
  function takeCredits(leaseId, amount) {
    let left = C.r2(amount);
    const uses = [];
    for (const c of openCredits(leaseId)) {
      if (left <= 0) break;
      const avail = C.r2(c.amount - c.applied);
      const take = C.r2(Math.min(avail, left));
      if (take > 0) {
        uses.push({ credit: c, amount: take });
        left = C.r2(left - take);
      }
    }
    return { net: left, uses };
  }
  function recordUses(uses, invoiceId, source, sourceRef) {
    for (const u of uses) {
      db.run('INSERT INTO revenue_credit_uses (credit_id, invoice_id, source, source_ref, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)', u.credit.id, invoiceId || null, source, sourceRef || null, u.amount, M.now());
      const applied = C.r2(u.credit.applied + u.amount);
      db.run('UPDATE revenue_credits SET applied = ?, status = ? WHERE id = ?', applied, applied >= u.credit.amount - 0.005 ? 'applied' : 'open', u.credit.id);
    }
  }
  const creditNote = (uses) => (uses.length ? uses.map((u) => `${u.credit.ref} −${u.amount}`).join(', ') : '');

  // ---------- CSV (exports) and pasted tables (imports) ----------
  function csv(rows, cols) {
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@\t])/, "'$1")}"` : s;
    };
    return `﻿${[cols.map(([, l]) => cell(l)).join(','), ...rows.map((r) => cols.map(([k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\r\n')}\r\n`;
  }
  // Rows from pasted CSV or tab-separated text (Excel copy); a header row is skipped when its
  // first cell is not data. Quoted fields with commas are understood.
  function parseTable(text, isData) {
    const rows = [];
    for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
      if (!line.trim()) continue;
      const sep = line.includes('\t') ? '\t' : line.includes(';') && !line.includes(',') ? ';' : ',';
      const cells = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
        } else if (ch === sep && !q) { cells.push(cur.trim()); cur = ''; } else cur += ch;
      }
      cells.push(cur.trim());
      rows.push(cells);
    }
    if (rows.length && isData && !isData(rows[0])) rows.shift();
    return rows;
  }
  const amountOf = (v) => {
    const n = Number(String(v ?? '').replace(/[\s,]/g, '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    return Number.isFinite(n) ? n : null;
  };

  // Hand-built tables (the entry grids) become card lists on phones like ui.table's: adds
  // table--resp and each body cell's data-label from its column heading.
  function resp(html) {
    return html.replace(/<table class="([^"]*)">([\s\S]*?)<\/table>/g, (all, cls, inner) => {
      const head = (inner.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
      const labels = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/"/g, '&quot;').trim());
      const body = inner.replace(/<tbody>([\s\S]*?)<\/tbody>/, (b, rows) => `<tbody>${rows.replace(/<tr([^>]*)>([\s\S]*?)<\/tr>/g, (r, attrs, cells) => {
        let i = 0;
        return `<tr${attrs}>${cells.replace(/<td([^>]*)>/g, (t, a) => `<td${a} data-label="${labels[i++] || ''}">`)}</tr>`;
      })}</tbody>`);
      return `<table class="${cls} table--resp">${body}</table>`;
    });
  }

  // A tab bar shared by each module's pages.
  const tabs = (items, active) => `<nav class="tabs">${items.map(([href, label]) => `<a class="tab${href === active ? ' is-on' : ''}" href="${href}">${ui.esc(label)}</a>`).join('')}</nav>`;

  return { C, periodLabel, shortMonth, lastMonth, thisYear, sparkline, pct1, change, leaseOf, activeLeases, leaseForUnit, openCredits, addCredit, takeCredits, recordUses, creditNote, csv, parseTable, amountOf, tabs, resp };
};
