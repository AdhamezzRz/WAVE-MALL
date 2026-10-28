'use strict';

// Shared pieces for the operations modules (short-term space, maintenance, footfall):
// label maps read through tr(), file uploads for records the vault does not know yet,
// bilingual printable documents, Cairo-local dates and a tolerant CSV reader.

const express = require('express');
const { t: tr } = require('./i18n');

// { key: 'prefix|English' } → { key: translated }
const tmap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tr(v)]));

// Cairo-local date and hour (the office and the people counters work in Cairo time).
const CAIRO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function cairo(d = new Date()) {
  const p = Object.fromEntries(CAIRO.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// Teach the document vault about new kinds of record (labels are 'prefix|English' keys).
function registerDocs(M, entity, entityLabel, kinds) {
  M.DOC_ENTITIES[entity] = entityLabel;
  for (const [k, label] of Object.entries(kinds)) if (!Object.hasOwn(M.DOC_KINDS, k)) M.DOC_KINDS[k] = label;
  M.DOC_GROUPS[entity] = [...Object.keys(kinds), 'other'];
}

// An upload route for these records (same protocol as /admin/documents/upload, used by admin.js).
// owners: { entity: 'table' }
function uploadRoute(router, h, path, owners, { canUpload = (req) => h.can(req, 'agent') } = {}) {
  const { db, M, files: store } = h;
  const fail = (res, status, error) => res.status(status).json({ ok: false, error });
  router.post(path, express.raw({ type: () => true, limit: store.MAX_BYTES + 1024 }), (req, res) => {
    if (!canUpload(req)) return fail(res, 403, tr('Your role does not allow that.'));
    const entity = String(req.query.entity || '');
    const id = h.int(req.query.entity_id);
    if (!owners[entity] || !id || !db.get(`SELECT id FROM ${owners[entity]} WHERE id = ?`, id)) return fail(res, 422, tr('That record no longer exists.'));
    const saved = store.save(Buffer.isBuffer(req.body) ? req.body : null, h.str(decodeURIComponent(String(req.get('x-file-name') || '')), 200));
    if (saved.error === 'empty') return fail(res, 422, tr('Choose a file to upload.'));
    if (saved.error === 'too_big') return fail(res, 413, tr('That file is larger than 25 MB.'));
    if (saved.error) return fail(res, 415, tr('Upload a PDF, JPG, PNG, WebP, Word (.docx) or Excel (.xlsx) file.'));
    const kind = (M.DOC_GROUPS[entity] || []).includes(req.query.kind) ? req.query.kind : 'other';
    const title = h.str(req.query.title, 160) || saved.file_name.replace(/\.[a-z0-9]+$/i, '');
    const docId = Number(db.run(
      `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, expires_on, notes, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      db.nextRef('documents', 'DOC', 4, true), entity, id, kind, title, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored,
      /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.issued_on || '')) ? req.query.issued_on : null,
      /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.expires_on || '')) ? req.query.expires_on : null,
      h.str(req.query.notes, 1000) || null, req.user ? req.user.id : null, h.M.now(),
    ).lastInsertRowid);
    h.log(req, 'Uploaded a document', 'document', docId, title);
    res.json({ ok: true, id: docId, url: `/admin/documents/${docId}/file` });
  });
  // the documents panel, pointed at this route
  return (req, entity, id, opts = {}) => h.ui.docPanel({
    docs: h.docs(req, entity, id), entity, entityId: id, csrf: req.session.csrf,
    canUpload: canUpload(req), canDelete: h.can(req, 'manager'), ...opts,
  }).replace(/\/admin\/documents\/upload\?/g, `/admin${path}?`);
}

// Printed documents: ?doc=ar|en, else the reader's language.
const docLang = (req) => (['ar', 'en'].includes(req.query.doc) ? req.query.doc : req.lang || 'en');
const docSwitch = (ui, path, l) => (l === 'ar'
  ? `<a class="langbtn" href="${path}?doc=en" lang="en">${ui.icon('globe')}<span>English</span></a>`
  : `<a class="langbtn" href="${path}?doc=ar" lang="ar">${ui.icon('globe')}<span>العربية</span></a>`);

// CSV: commas, semicolons or tabs; quoted fields; a header row. Returns { headers, rows }.
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const first = src.split('\n', 1)[0] || '';
  const sep = [',', ';', '\t'].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const out = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell.trim()); cell = ''; } else if (c === '\n') {
      row.push(cell.trim());
      if (row.some((x) => x !== '')) out.push(row);
      row = []; cell = '';
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x !== '')) out.push(row);
  const headers = out.shift() || [];
  return { headers, rows: out };
}

// A CSV cell that cannot start a spreadsheet formula.
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// Pager links: keeps the other query values. Returns '' for a single page.
function pager(ui, base, query, page, pages) {
  if (pages <= 1) return '';
  const q = (p) => {
    const u = new URLSearchParams({ ...query, page: String(p) });
    return `${base}?${u}`;
  };
  return `<nav class="pager">${page > 1 ? `<a class="btn btn--ghost btn--sm" href="${ui.esc(q(page - 1))}">${ui.esc(tr('ops|Previous'))}</a>` : ''}<span class="muted">${ui.esc(tr('ops|Page {page} of {pages}', { page, pages }))}</span>${page < pages ? `<a class="btn btn--ghost btn--sm" href="${ui.esc(q(page + 1))}">${ui.esc(tr('ops|Next'))}</a>` : ''}</nav>`;
}

module.exports = { tmap, cairo, registerDocs, uploadRoute, docLang, docSwitch, parseCsv, csvCell, pager };
