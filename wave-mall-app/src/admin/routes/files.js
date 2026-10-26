'use strict';

// The document vault's file routes: upload, view or download, replace with a new version,
// edit the details, delete. Pages embed ui.docPanel(); admin.js sends the file.
// Employee files and anything marked confidential are for people with HR access only.

const express = require('express');
const { t: tr } = require('../i18n');

module.exports = function files(router, h) {
  const { db, M, files: store } = h;

  // Can this person see this document?
  const canSee = (req, d) => !(d.confidential || d.entity === 'employee') || h.canHR(req);
  // Does the thing it belongs to exist?
  const OWNERS = { brand: 'brands', lease: 'leases', contract: 'contracts', employee: 'employees', unit: 'units' };
  const ownerExists = (entity, id) => (entity === 'office' ? true : OWNERS[entity] ? !!db.get(`SELECT id FROM ${OWNERS[entity]} WHERE id = ?`, id) : false);
  const docOf = (id) => db.get('SELECT * FROM documents WHERE id = ?', id);
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const fail = (res, status, error) => res.status(status).json({ ok: false, error });

  // Upload: the file is the request body; the details come in the query string.
  router.post('/documents/upload', h.R('agent'), express.raw({ type: () => true, limit: store.MAX_BYTES + 1024 }), (req, res) => {
    const q = req.query;
    const entity = String(q.entity || '');
    const entityId = entity === 'office' ? null : h.int(q.entity_id);
    if (!M.DOC_GROUPS[entity] || (entity !== 'office' && !entityId) || !ownerExists(entity, entityId)) return fail(res, 422, tr('That record no longer exists.'));
    const confidential = entity === 'employee' || q.confidential === '1' ? 1 : 0;
    if (confidential && !h.canHR(req)) return fail(res, 403, tr('Only people with HR access can file this.'));
    const kind = M.DOC_GROUPS[entity].includes(q.kind) ? q.kind : 'other';
    const name = h.str(decodeURIComponent(String(req.get('x-file-name') || '')), 200);
    const saved = store.save(Buffer.isBuffer(req.body) ? req.body : null, name);
    if (saved.error === 'empty') return fail(res, 422, tr('Choose a file to upload.'));
    if (saved.error === 'too_big') return fail(res, 413, tr('That file is larger than 25 MB.'));
    if (saved.error) return fail(res, 415, tr('Upload a PDF, JPG, PNG, WebP, Word (.docx) or Excel (.xlsx) file.'));
    const replaces = h.int(q.replaces);
    const old = replaces ? docOf(replaces) : null;
    if (old && (old.entity !== entity || String(old.entity_id) !== String(entityId))) return fail(res, 422, tr('That record no longer exists.'));
    const title = h.str(q.title, 160) || (old ? old.title : '') || saved.file_name.replace(/\.[a-z0-9]+$/i, '');
    const id = db.tx(() => {
      const r = db.run(
        `INSERT INTO documents (ref, entity, entity_id, kind, title, file_name, mime, size, sha256, stored, issued_on, expires_on, notes, confidential, version, replaces_id, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        db.nextRef('documents', 'DOC', 4, true), entity, entityId, old ? old.kind : kind, title, saved.file_name, saved.mime, saved.size, saved.sha256, saved.stored,
        // a new version is a new paper: its dates are its own (set them here or on the document page)
        date(q.issued_on), date(q.expires_on),
        h.str(q.notes, 1000) || null, confidential || (old ? old.confidential : 0), old ? old.version + 1 : 1, old ? old.id : null, req.user.id, M.now(),
      );
      if (old) db.run('UPDATE documents SET archived = 1 WHERE id = ?', old.id);
      return Number(r.lastInsertRowid);
    });
    h.log(req, old ? 'Uploaded a new version' : 'Uploaded a document', 'document', id, title);
    res.json({ ok: true, id, url: `/admin/documents/${id}/file` });
  });

  // View (inline) or download. Only PDFs and raster images are shown inline (their type is checked on
  // upload and fixed by nosniff); everything else downloads. The site-wide CSP is lifted for the file
  // itself because browsers' PDF viewers will not open under it.
  router.get('/documents/:id/file', (req, res, next) => {
    const d = docOf(req.params.id);
    if (!d) return next();
    if (!canSee(req, d)) return res.status(403).type('text').send(tr('Your role does not allow that.'));
    const file = store.path(d.stored);
    if (!file) return res.status(410).type('text').send(tr('This file is missing from the server. Upload it again.'));
    const inline = !req.query.download && /^(application\/pdf|image\/)/.test(d.mime);
    res.set({
      'Content-Type': d.mime,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${d.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(d.file_name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.removeHeader('Content-Security-Policy');
    res.sendFile(file);
  });

  // Edit the details.
  router.post('/documents/:id', h.R('agent'), (req, res, next) => {
    const d = docOf(req.params.id);
    if (!d) return next();
    if (!canSee(req, d)) return h.back(req, res, '/admin/documents', 'error', tr('Your role does not allow that.'));
    const kind = (M.DOC_GROUPS[d.entity] || []).includes(req.body.kind) ? req.body.kind : d.kind;
    const confidential = d.entity === 'employee' ? 1 : h.canHR(req) ? (req.body.confidential ? 1 : 0) : d.confidential;
    db.run('UPDATE documents SET title = ?, kind = ?, issued_on = ?, expires_on = ?, notes = ?, confidential = ? WHERE id = ?',
      h.str(req.body.title, 160) || d.title, kind, date(req.body.issued_on), date(req.body.expires_on), h.str(req.body.notes, 1000) || null, confidential, d.id);
    h.log(req, 'Edited a document', 'document', d.id, d.title);
    h.back(req, res, h.safeBack(req, `/admin/documents/${d.id}`), 'ok', tr('Saved.'));
  });

  // Delete (managers; HR files need HR access). The file goes once nothing uses it.
  router.post('/documents/:id/delete', h.R('manager'), (req, res, next) => {
    const d = docOf(req.params.id);
    if (!d) return next();
    if (!canSee(req, d)) return h.back(req, res, '/admin/documents', 'error', tr('Your role does not allow that.'));
    db.tx(() => {
      db.run('UPDATE documents SET replaces_id = NULL WHERE replaces_id = ?', d.id);
      db.run('DELETE FROM documents WHERE id = ?', d.id);
      // the previous version becomes current again
      if (d.replaces_id) db.run('UPDATE documents SET archived = 0 WHERE id = ?', d.replaces_id);
    });
    store.release(db, d.stored);
    h.log(req, 'Deleted a document', 'document', d.id, d.title);
    // from the document's own page, go to the version that is current now (or the vault)
    const back = h.safeBack(req, '/admin/documents');
    const own = new RegExp(`^/admin/documents/${d.id}(?:[?#].*)?$`).test(back);
    h.back(req, res, own ? (d.replaces_id ? `/admin/documents/${d.replaces_id}` : '/admin/documents') : back, 'ok', tr('Document deleted.'));
  });
};
