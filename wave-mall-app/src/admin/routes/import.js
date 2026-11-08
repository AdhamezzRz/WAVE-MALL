'use strict';

// Import from Excel (/admin/import): the go-live checklist of everything that can be imported, a
// live template for each (English or Arabic, empty or with the current records), and a wizard:
// choose → template → upload → match the columns → preview and fix → import → done (and undo).
//
// The engine and the parsers live in src/admin/import; each module's datasets in
// src/admin/import/datasets/*.js (every file there is loaded here). Writing a new one: README.md
// in that folder.

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const i18n = require('../i18n');
const { AREAS } = require('../import/engine');

const { t: tr, tn } = i18n;
const PAGE = 100;

module.exports = function importer(router, h) {
  const { db, ui } = h;
  const I = h.imports;
  const esc = ui.esc;
  const lang = () => i18n.lang();
  const T = (x) => I.T(x, lang());

  // every dataset file (this folder's core.js first, then the others in name order)
  const DIR = path.join(__dirname, '..', 'import', 'datasets');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.js')).sort((a, b) => (a === 'core.js' ? -1 : b === 'core.js' ? 1 : a.localeCompare(b)))) {
    require(path.join(DIR, f))(I, h);
  }

  // the "Import from Excel" button on the lists that have a dataset (index.js h.page)
  I.pageButton = (req) => {
    const p = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
    return I.forPage(p).filter((d) => I.canImport(req, d)).map((d) => ui.btn(esc(tr('imp|Import from Excel')), { href: `/admin/import/${d.key}`, cls: 'btn--ghost imp-pagebtn', ic: 'upload', attrs: { title: T(d.title) } })).join('');
  };

  const STEPS = ['imp|Choose', 'imp|Template', 'imp|Upload', 'imp|Match columns', 'imp|Check', 'imp|Import', 'imp|Done'];
  const stepper = (at) => `<ol class="imp-steps" aria-label="${esc(tr('imp|Steps'))}">${STEPS.map((s, i) => `<li class="${i + 1 < at ? 'is-done' : i + 1 === at ? 'is-on' : ''}"${i + 1 === at ? ' aria-current="step"' : ''}><i>${i + 1 < at ? ui.icon('check') : i + 1}</i><span>${esc(tr(s))}</span></li>`).join('')}</ol>`;
  const shell = (req, res, o) => h.page(req, res, { active: '/admin/import', wide: true, ...o, crumbs: o.crumbs || [['/admin/import', tr('nav|Import from Excel')]] });
  const bounce = (req, res, text) => h.back(req, res, '/admin/import', 'error', text);
  const dsOf = (req, key) => {
    const d = I.get(key);
    return d && I.canSee(req, d) ? d : null;
  };
  const statusBadge = (s) => ({
    new: ui.badge('new', tr('imp|New'), 'ok'), update: ui.badge('update', tr('imp|Update'), 'sky'), same: ui.badge('same', tr('imp|Unchanged'), 'mute'),
    error: ui.badge('error', tr('imp|Error'), 'rose'), skip: ui.badge('skip', tr('imp|Skipped'), 'sand'),
  })[s] || '';
  const msg = (d, e) => `${e.col && d.col[e.col] ? `<b>${esc(T(d.col[e.col].label))}:</b> ` : ''}${esc(tr(e.key, e.params))}`;
  const templateButtons = (req, d, { small = false } = {}) => {
    const sz = small ? ' btn--sm' : '';
    return `<span class="imp-tpl">${ui.btn(esc(tr('imp|English template')), { href: `/admin/import/${d.key}/template.xlsx?as=en`, cls: `btn--ghost${sz}`, ic: 'dl', attrs: { download: '' } })}${ui.btn(esc(tr('imp|Arabic template')), { href: `/admin/import/${d.key}/template.xlsx?as=ar`, cls: `btn--ghost${sz}`, ic: 'dl', attrs: { download: '' } })}${I.canExport(req, d) ? ui.btn(esc(tr('imp|With current data')), { href: `/admin/import/${d.key}/export/data.xlsx?as=${lang()}`, cls: `btn--ghost${sz}`, ic: 'dl', attrs: { download: '' } }) : ''}</span>`;
  };

  // ---------- the import centre ----------
  router.get('/import', (req, res) => {
    const visible = I.list().filter((d) => I.canSee(req, d));
    let step = 0;
    const groups = AREAS.map(([area, title]) => {
      const items = visible.filter((d) => d.area === area);
      if (!items.length) return '';
      const rows = items.map((d) => {
        step++;
        const s = I.status(d);
        const deps = (d.depends || []).map((k) => I.get(k)).filter(Boolean);
        const can = I.canImport(req, d);
        const last = s.last ? `${esc(tr('imp|Last import {when} by {who}', { when: ui.rel(s.last.created_at), who: s.last.user_name || tr('imp|someone') }))} · ${esc(tr('imp|{a} new, {b} updated', { a: s.last.created, b: s.last.updated }))}` : esc(tr('imp|Not imported yet'));
        return `<li class="imp-item${s.n ? ' has-data' : ''}">
          <span class="imp-item__n">${String(step).padStart(2, '0')}</span>
          <span class="imp-item__ic">${ui.icon(d.icon || 'file')}</span>
          <div class="imp-item__body">
            <h3><a href="/admin/import/${d.key}">${esc(T(d.title))}</a></h3>
            <p>${esc(T(d.summary || ''))}</p>
            <p class="imp-item__meta"><span class="imp-count">${s.n === null ? '' : esc(tn(s.n, 'imp|{n} record in the system', 'imp|{n} records in the system'))}</span><span>${last}</span>${deps.length ? `<span class="imp-dep">${ui.icon('arrow')}${esc(tr('imp|After {list}', { list: deps.map((x) => T(x.title)).join(i18n.isAr() ? '، ' : ', ') }))}</span>` : ''}</p>
          </div>
          <div class="imp-item__go">${templateButtons(req, d, { small: true })}${can ? ui.btn(esc(tr('imp|Import')), { href: `/admin/import/${d.key}`, cls: 'btn--primary btn--sm', ic: 'upload' }) : `<small class="muted">${esc(tr('imp|You can download the template; importing needs edit access.'))}</small>`}</div>
        </li>`;
      }).join('');
      return `<section class="imp-area"><h2 class="imp-area__h">${esc(T(title))}</h2><ol class="imp-list">${rows}</ol></section>`;
    }).join('');
    const recent = db.all('SELECT b.*, u.name user_name FROM imp_batches b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.id DESC LIMIT 6').filter((b) => { const d = I.get(b.dataset); return d && I.canSee(req, d); });
    const hero = `<section class="imp-hero">
      <div class="imp-hero__text">
        <p class="imp-hero__kicker">${esc(tr('imp|Getting started with your Excel data'))}</p>
        <h2>${esc(tr('imp|Bring everything you keep in Excel into the office, safely.'))}</h2>
        <p>${esc(tr('imp|Download a template, or upload your own sheet as it is: the office matches your columns, checks every cell and shows you exactly what will be added or changed before anything is saved. Every import can be undone.'))}</p>
      </div>
      <ol class="imp-hero__how">
        <li>${ui.icon('dl')}<b>${esc(tr('imp|Template'))}</b><span>${esc(tr('imp|Dropdowns from your real data, a note on every column, an example.'))}</span></li>
        <li>${ui.icon('upload')}<b>${esc(tr('imp|Upload'))}</b><span>${esc(tr('imp|.xlsx or CSV, in English or Arabic, our template or your own.'))}</span></li>
        <li>${ui.icon('search')}<b>${esc(tr('imp|Check'))}</b><span>${esc(tr('imp|Each row: new, update (with what changes) or a problem to fix.'))}</span></li>
        <li>${ui.icon('check')}<b>${esc(tr('imp|Import'))}</b><span>${esc(tr('imp|All at once, and undo within {n} days if needed.', { n: I.UNDO_DAYS }))}</span></li>
      </ol>
    </section>`;
    const history = recent.length ? ui.card(tr('imp|Recent imports'), `<ul class="list">${recent.map((b) => `<li><a href="/admin/import/b/${b.id}"><span class="what"><b>${esc(T(I.get(b.dataset).title))}</b><small>${esc(b.file_name || '—')} · ${esc(b.user_name || '—')} · ${ui.rel(b.created_at)}</small></span>${b.status === 'undone' ? ui.badge('undone', tr('imp|Undone'), 'mute') : ui.badge('done', tr('imp|{a} new, {b} updated', { a: b.created, b: b.updated }), 'ok')}</a></li>`).join('')}</ul>`, { action: ui.btn(esc(tr('imp|All imports')), { href: '/admin/import/history', cls: 'btn--ghost btn--sm' }) }) : '';
    const order = `<p class="imp-order">${ui.icon('flow')}<span>${esc(tr('imp|Import in this order: each step can refer to the ones before it (employees to their departments, leases to their brands and units).'))}</span></p>`;
    shell(req, res, {
      title: tr('nav|Import from Excel'), crumbs: [],
      body: `${hero}${order}<div class="imp-centre">${groups || ui.empty(tr('imp|There is nothing you can import yet.'))}</div>${history}`,
      actions: ui.btn(esc(tr('imp|All imports')), { href: '/admin/import/history', cls: 'btn--ghost', ic: 'log' }),
    });
  });

  // ---------- history ----------
  router.get('/import/history', (req, res) => {
    const f = h.listFilters(req, { cols: { date: 'b.created_at' }, dateLabel: tr('imp|Imported'), sort: { date: 'b.created_at' }, defaultSort: 'newest' });
    const rows = db.all(`SELECT b.*, u.name user_name FROM imp_batches b LEFT JOIN users u ON u.id = b.user_id WHERE 1 = 1${f.sql} ORDER BY ${f.order} LIMIT 500`, ...f.args)
      .filter((b) => { const d = I.get(b.dataset); return d && I.canSee(req, d); });
    const table = ui.table([
      { label: tr('imp|When'), sort: (b) => b.created_at, render: (b) => `${ui.dt(b.created_at)}` },
      { label: tr('imp|What'), render: (b) => `<b>${esc(T(I.get(b.dataset).title))}</b><small class="sub">${esc(b.file_name || '—')}</small>` },
      { label: tr('imp|By'), render: (b) => esc(b.user_name || '—') },
      { label: tr('imp|New'), num: true, render: (b) => ui.n0(b.created) },
      { label: tr('imp|Updated'), num: true, render: (b) => ui.n0(b.updated) },
      { label: tr('imp|Unchanged'), num: true, render: (b) => ui.n0(b.unchanged) },
      { label: tr('imp|Status'), render: (b) => (b.status === 'undone' ? ui.badge('undone', tr('imp|Undone'), 'mute') : ui.badge('done', tr('imp|Imported'), 'ok')) },
    ], rows, { href: (b) => `/admin/import/b/${b.id}`, empty: esc(tr('imp|No imports yet.')) });
    shell(req, res, { title: tr('imp|All imports'), body: `${f.html}${ui.card(tn(rows.length, 'imp|{n} import', 'imp|{n} imports'), table)}` });
  });

  // ---------- templates ----------
  const sendXlsx = (res, buf, name) => {
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]+/g, '-')}"; filename*=UTF-8''${encodeURIComponent(name)}`, 'X-Content-Type-Options': 'nosniff' });
    res.send(Buffer.from(buf));
  };
  router.get('/import/:key/template.xlsx', async (req, res, next) => {
    const d = dsOf(req, req.params.key);
    if (!d) return next();
    const l = req.query.as === 'ar' ? 'ar' : 'en';
    try {
      const buf = await I.template(d, { lang: l });
      sendXlsx(res, buf, `${l === 'ar' ? 'قالب' : 'template'}-${d.key}.xlsx`);
    } catch (e) { next(e); }
  });
  router.get('/import/:key/export/data.xlsx', async (req, res, next) => {
    const d = dsOf(req, req.params.key);
    if (!d) return next();
    if (!I.canExport(req, d)) return bounce(req, res, tr('imp|Downloading the current data needs the export permission.'));
    const l = req.query.as === 'ar' ? 'ar' : 'en';
    try {
      const buf = await I.template(d, { lang: l, withData: true });
      h.log(req, 'Downloaded data for Excel', 'imp_dataset', null, I.T(d.title, 'en'));
      sendXlsx(res, buf, `${d.key}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) { next(e); }
  });

  // ---------- 1–3: a dataset: about it, its template, the upload ----------
  router.get('/import/:key', (req, res, next) => {
    const d = dsOf(req, req.params.key);
    if (!d) return next();
    const can = I.canImport(req, d);
    const s = I.status(d);
    const deps = (d.depends || []).map((k) => I.get(k)).filter(Boolean);
    const depWarn = deps.filter((x) => !I.status(x).n);
    const dict = `<div class="tablewrap"><table class="table table--resp imp-dict"><thead><tr><th>${esc(tr('imp|Column'))}</th><th>${esc(tr('imp|Type'))}</th><th>${esc(tr('imp|Allowed values / notes'))}</th></tr></thead><tbody>${d.columns.map((c) => {
      const allowed = c.type === 'enum' ? I.enumOf(c).map(([, l]) => T(l)).join(' · ') : c.type === 'ref' ? tr('imp|One of the {what} in the system', { what: T(c.ref.what || c.label) }) : '';
      return `<tr><td data-label=""><b>${esc(T(c.label))}</b>${c.required ? ` <span class="imp-req">${esc(tr('imp|required'))}</span>` : ''}${d.keys.includes(c.key) ? ` <span class="imp-key">${esc(tr('imp|finds the record'))}</span>` : ''}</td><td data-label="${esc(tr('imp|Type'))}">${esc(tr(TYPE[c.type] || 'imp|Text'))}</td><td data-label="">${allowed ? `<span>${esc(allowed)}</span>` : ''}${c.help ? `<small class="sub">${esc(T(c.help))}</small>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    const upload = can ? `<section class="card imp-drop" data-imp-upload="/admin/import/${esc(d.key)}/upload" data-max="${I.MAX_BYTES}">
        <div class="imp-drop__zone" data-imp-zone tabindex="0" role="button" aria-label="${esc(tr('imp|Choose a file to upload'))}">
          <span class="imp-drop__ic">${ui.icon('upload')}</span>
          <b>${esc(tr('imp|Drop your Excel file here'))}</b>
          <span>${esc(tr('imp|or click to choose it · .xlsx or .csv, up to 10 MB'))}</span>
          <input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" data-imp-file hidden>
        </div>
        <div class="imp-drop__busy" data-imp-busy hidden><span class="imp-spin"></span><b data-imp-name></b><small>${esc(tr('imp|Reading every row…'))}</small></div>
        <p class="imp-drop__err alert alert--warn" data-imp-err hidden></p>
        <p class="muted small">${esc(tr('imp|Nothing is saved yet: the next step shows you every row first.'))}</p>
      </section>` : `<p class="alert alert--warn">${esc(tr('imp|You can download the template; importing needs edit access.'))}</p>`;
    const body = `${stepper(can ? 3 : 2)}
      <div class="grid grid--side">
        <div class="stack">
          ${depWarn.length ? `<p class="alert alert--warn">${esc(tr('imp|Import {list} first: rows that refer to them can only be matched once they are in the system.', { list: depWarn.map((x) => T(x.title)).join(i18n.isAr() ? '، ' : ', ') }))}</p>` : ''}
          ${upload}
          ${ui.card(tr('imp|The columns'), dict, { sub: esc(tr('imp|Your own sheet works too: column titles are matched in English or Arabic, and you can match the rest by hand.')) })}
        </div>
        <div class="stack">
          ${ui.card(tr('imp|1 · Get the template'), `<p class="muted">${esc(tr('imp|Fill the Data sheet. Dropdowns, formats and a note on each column title guide you; the Read me sheet explains the rest.'))}</p><div class="imp-tpl-col">${templateButtons(req, d)}</div>`)}
          ${ui.card(tr('imp|In the system now'), `<p class="imp-big">${s.n === null ? '—' : ui.n0(s.n)}</p><p class="muted small">${s.last ? esc(tr('imp|Last import {when} by {who}', { when: ui.rel(s.last.created_at), who: s.last.user_name || tr('imp|someone') })) : esc(tr('imp|Not imported yet'))}</p>${d.notes ? `<p class="imp-note">${esc(T(d.notes))}</p>` : ''}<p>${ui.btn(esc(tr('imp|Open the list')), { href: d.pages[0] || d.module, cls: 'btn--ghost btn--sm', ic: 'arrow' })}</p>`)}
        </div>
      </div><script src="/admin/import.js?v=${ui.ASSETS.imp || '1'}" defer></script>`;
    shell(req, res, { title: tr('imp|Import {what}', { what: T(d.title) }), body, crumbs: [['/admin/import', tr('nav|Import from Excel')], [null, T(d.title)]] });
  });

  router.post('/import/:key/upload', express.raw({ type: () => true, limit: I.MAX_BYTES + 1024 }), async (req, res) => {
    const d = I.get(req.params.key);
    const fail = (status, key, params) => res.status(status).json({ ok: false, error: tr(key, params) });
    if (!d || !I.canSee(req, d)) return fail(404, 'imp|That import was not found.');
    if (!I.canImport(req, d)) return fail(403, 'imp|You can download the template; importing needs edit access.');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let name = '';
    try { name = decodeURIComponent(String(req.get('x-file-name') || '')).slice(0, 200); } catch { name = ''; }
    try {
      const r = await I.stage(d, buf, name, req.user);
      if (r.error) return fail(422, r.error, r.params);
      res.json({ ok: true, url: `/admin/import/s/${r.token}` });
    } catch (e) {
      console.error('[import] upload', e);
      fail(422, 'imp|This file could not be read. Save it again as .xlsx and retry.');
    }
  });

  // ---------- a staged upload ----------
  const stagedOf = (req) => {
    const st = I.staged(req.params.token, req.user);
    return st && st.d && I.canImport(req, st.d) ? st : null;
  };
  const optsOf = (q) => ({ mode: q.mode === 'valid' ? 'valid' : 'all', action: ['create', 'update'].includes(q.action) ? q.action : 'both', empties: q.empties === 'clear' ? 'clear' : 'keep' });
  const optQs = (o) => `mode=${o.mode}&action=${o.action}&empties=${o.empties}`;

  // 4: match the columns
  router.get('/import/s/:token/map', (req, res, next) => {
    const st = stagedOf(req);
    if (!st) return next();
    const d = st.d;
    const g = I.grid(st);
    const m = I.mapColumns(d, g.headers, st.mapping);
    const samples = (i) => g.rows.map((r) => I.cellText(r.cells[i])).filter((x) => x.trim()).slice(0, 3);
    const choices = [['', tr('imp|— Don’t import —')], ...d.columns.map((c) => [c.key, `${T(c.label)}${c.required ? ' *' : ''}`])];
    const conf = (x) => (x.empty ? '' : !x.key ? ui.badge('none', tr('imp|Not matched'), 'sand') : x.score === 1 ? ui.badge('sure', tr('imp|Matched'), 'ok') : x.score >= 0.8 ? ui.badge('likely', tr('imp|Likely'), 'sky') : ui.badge('guess', tr('imp|A guess: check it'), 'amber'));
    const rowsHtml = m.columns.filter((x) => !x.empty).map((x) => `<tr class="${!x.key ? 'is-off' : x.score < 1 ? 'is-guess' : ''}"><td data-label=""><b>${esc(x.header)}</b><small class="sub imp-samples">${samples(x.index).map((v) => `<span>${esc(v.slice(0, 40))}</span>`).join('')}</small></td><td class="imp-arrow" data-label="">${ui.icon('arrow')}</td><td data-label="">${ui.select(`col_${x.index}`, tr('imp|Goes into'), choices, x.key || '', { cls: 'f--inline' })}</td><td data-label="">${conf(x)}</td></tr>`).join('');
    const missing = m.missing.map((k) => T(d.col[k].label));
    const sheetPick = st.file.sheets.length > 1 ? ui.form(`/admin/import/s/${st.token}/sheet`, req.session.csrf, `${ui.select('sheet', tr('imp|Sheet'), st.file.sheets.map((s) => [s.name, s.name]), st.sheet, { attrs: { 'data-autosubmit': '' } })}<noscript>${ui.btn(esc(tr('imp|Use this sheet')), { cls: 'btn--ghost btn--sm' })}</noscript>`, { cls: 'imp-inline' }) : '';
    const sheet = st.file.sheets.find((s) => s.name === st.sheet) || st.file.sheets[0];
    const headerPick = ui.select('header_row', tr('imp|Column titles are on row'), Array.from({ length: Math.min(15, sheet.rows.length) }, (_, i) => [i, String(i + 1)]), st.header_row, {});
    const body = `${stepper(4)}
      <div class="grid grid--side">
        <div class="stack">
          ${missing.length ? `<p class="alert alert--warn">${esc(tr('imp|Not found in your sheet yet: {list}. Match them below, or new records will be refused.', { list: missing.join(i18n.isAr() ? '، ' : ', ') }))}</p>` : ''}
          ${ui.card(tr('imp|Match your columns'), ui.form(`/admin/import/s/${st.token}/map`, req.session.csrf, `<div class="tablewrap"><table class="table table--resp imp-map"><thead><tr><th>${esc(tr('imp|Your column'))}</th><th></th><th>${esc(tr('imp|Our field'))}</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
            <div class="fields">${headerPick}<label class="f imp-check"><input type="checkbox" name="remember" value="1" checked><span>${esc(tr('imp|Remember these choices for the next file'))}</span></label></div>
            <div class="row">${ui.btn(esc(tr('imp|Check the rows')), { cls: 'btn--primary', ic: 'arrow' })}${ui.btn(esc(tr('imp|Upload another file')), { href: `/admin/import/${d.key}`, cls: 'btn--ghost' })}</div>`, { cls: 'stack' }), { sub: esc(tr('imp|{file} · sheet “{sheet}”', { file: st.file_name || '—', sheet: st.sheet })), action: sheetPick })}
        </div>
        <div class="stack">${ui.card(tr('imp|How matching works'), `<p class="muted">${esc(tr('imp|Titles in English or Arabic are recognised, with or without “*”, in any order. Columns you leave as “Don’t import” are ignored. Your choices are remembered for this kind of file.'))}</p>`)}</div>
      </div>`;
    shell(req, res, { title: tr('imp|Import {what}', { what: T(d.title) }), body, crumbs: [['/admin/import', tr('nav|Import from Excel')], [`/admin/import/${d.key}`, T(d.title)], [null, tr('imp|Match columns')]] });
  });
  router.post('/import/s/:token/map', (req, res, next) => {
    const st = stagedOf(req);
    if (!st) return next();
    const d = st.d;
    const headerRow = Math.max(0, Math.min(14, Number(req.body.header_row) || 0));
    const changedRow = headerRow !== st.header_row;
    const g = I.grid({ ...st, header_row: headerRow });
    const mapping = {};
    const taken = new Set();
    g.headers.forEach((hd, i) => {
      const k = changedRow ? undefined : req.body[`col_${i}`];
      if (k === undefined) return;
      mapping[i] = d.col[k] && !taken.has(k) ? k : '';
      if (mapping[i]) taken.add(k);
    });
    if (changedRow) {
      db.run('UPDATE imp_stage SET header_row = ?, mapping = NULL WHERE token = ?', headerRow, st.token);
      return h.back(req, res, `/admin/import/s/${st.token}/map`, 'ok', tr('imp|Column titles read from row {n}.', { n: headerRow + 1 }));
    }
    I.setMapping(st.token, mapping, headerRow);
    if (req.body.remember === '1') I.rememberMapping(d, g.headers.map((hd, i) => ({ header: I.cellText(hd).trim(), key: mapping[i] || null })).filter((x) => x.header));
    res.redirect(303, `/admin/import/s/${st.token}`);
  });
  router.post('/import/s/:token/sheet', (req, res, next) => {
    const st = stagedOf(req);
    if (!st) return next();
    I.setSheet(st.token, String(req.body.sheet || ''));
    res.redirect(303, `/admin/import/s/${st.token}`);
  });

  // 5: the preview
  router.get('/import/s/:token', (req, res, next) => {
    const st = stagedOf(req);
    if (!st) return next();
    const d = st.d;
    const g = I.grid(st);
    if (!st.mapping) {
      const m = I.mapColumns(d, g.headers);
      if (m.needsConfirm) return res.redirect(303, `/admin/import/s/${st.token}/map`);
      I.setMapping(st.token, Object.fromEntries(m.columns.filter((x) => !x.empty).map((x) => [x.index, x.key || ''])));
      st.mapping = JSON.parse(db.value('SELECT mapping FROM imp_stage WHERE token = ?', st.token));
    }
    const opt = optsOf(req.query);
    const pv = I.preview(st, opt, lang(), req.user);
    const show = ['new', 'update', 'same', 'error', 'skip', 'warn'].includes(req.query.status) ? req.query.status : '';
    const q = String(req.query.q || '').trim().toLowerCase();
    let rows = pv.rows.filter((r) => (!show ? true : show === 'warn' ? r.warns.length && r.status !== 'error' : r.status === show));
    if (q) rows = rows.filter((r) => String(r.label || '').toLowerCase().includes(q) || Object.values(r.raw).some((v) => String(v).toLowerCase().includes(q)));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
    const slice = rows.slice((page - 1) * PAGE, page * PAGE);
    const base = `/admin/import/s/${st.token}?${optQs(opt)}`;
    const chip = (key, label, n, tone) => `<a class="imp-chip imp-chip--${tone}${show === key ? ' is-on' : ''}" href="${esc(`${base}${key ? `&status=${key}` : ''}`)}"><b>${ui.n0(n)}</b><span>${esc(label)}</span></a>`;
    const chips = `<nav class="imp-chips" aria-label="${esc(tr('imp|Filter the rows'))}">${chip('', tr('imp|All rows'), pv.counts.total, 'all')}${chip('new', tr('imp|New'), pv.counts.new, 'ok')}${chip('update', tr('imp|Updates'), pv.counts.update, 'sky')}${chip('same', tr('imp|Unchanged'), pv.counts.same, 'mute')}${chip('error', tr('imp|Problems'), pv.counts.error, 'rose')}${pv.counts.warn ? chip('warn', tr('imp|Warnings'), pv.counts.warn, 'amber') : ''}${pv.counts.skip ? chip('skip', tr('imp|Skipped'), pv.counts.skip, 'sand') : ''}</nav>`;
    const fieldsOf = (r) => d.columns.filter((c) => r.provided.has(c.key)).slice(0, 5).map((c) => `<span class="imp-kv"><i>${esc(T(c.label))}</i>${esc(c.type === 'ref' ? r.names[c.key] || r.raw[c.key] : I.show(c, r.v[c.key], lang()))}</span>`).join('');
    const diffOf = (r) => (r.diff || []).map((x) => { const c = d.col[x.col]; return `<span class="imp-diff"><i>${esc(T(c.label))}</i><s>${esc(I.show(c, x.was, lang()))}</s>${ui.icon('arrow')}<b>${esc(I.show(c, x.now, lang()))}</b></span>`; }).join('');
    const table = slice.length ? `<div class="tablewrap"><table class="table table--resp imp-rows"><thead><tr><th>${esc(tr('imp|Row'))}</th><th>${esc(tr('imp|Status'))}</th><th>${esc(tr('imp|Record'))}</th><th>${esc(tr('imp|Details'))}</th></tr></thead><tbody>${slice.map((r) => `<tr class="imp-row imp-row--${r.status}">
        <td class="num" data-label="${esc(tr('imp|Row'))}">${r.line}</td>
        <td data-label="${esc(tr('imp|Status'))}">${statusBadge(r.status)}${r.warns.length && r.status !== 'error' ? ` ${ui.badge('warn', tr('imp|Check this'), 'amber')}` : ''}</td>
        <td data-label="${esc(tr('imp|Record'))}"><b>${r.id && d.link ? `<a href="${esc(d.link(r.id))}" target="_blank" rel="noopener">${esc(r.label || '—')}</a>` : esc(r.label || '—')}</b></td>
        <td data-label="" class="imp-details">${r.status === 'update' ? `<div class="imp-diffs">${diffOf(r)}</div>` : r.status === 'new' ? `<div class="imp-kvs">${fieldsOf(r)}</div>` : r.status === 'same' ? `<small class="muted">${esc(tr('imp|Already exactly like this in the system.'))}</small>` : ''}
          ${r.errors.length ? `<ul class="imp-msgs imp-msgs--err">${r.errors.map((e) => `<li>${msg(d, e)}</li>`).join('')}</ul>` : ''}
          ${r.warns.length ? `<ul class="imp-msgs imp-msgs--warn">${r.warns.map((e) => `<li>${msg(d, e)}</li>`).join('')}</ul>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : ui.empty(tr('imp|No rows here.'));
    const pager = pages > 1 ? `<nav class="imp-pager">${page > 1 ? `<a class="btn btn--ghost btn--sm" href="${esc(`${base}${show ? `&status=${show}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}&page=${page - 1}`)}">${esc(tr('imp|Previous'))}</a>` : ''}<span>${esc(tr('imp|Page {a} of {b}', { a: page, b: pages }))}</span>${page < pages ? `<a class="btn btn--ghost btn--sm" href="${esc(`${base}${show ? `&status=${show}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}&page=${page + 1}`)}">${esc(tr('imp|Next'))}</a>` : ''}</nav>` : '';
    const search = `<form method="get" class="imp-search" action="/admin/import/s/${esc(st.token)}"><input type="hidden" name="mode" value="${opt.mode}"><input type="hidden" name="action" value="${opt.action}"><input type="hidden" name="empties" value="${opt.empties}">${show ? `<input type="hidden" name="status" value="${show}">` : ''}<input type="search" name="q" value="${esc(req.query.q || '')}" placeholder="${esc(tr('imp|Search the rows'))}"></form>`;
    const options = `<form method="get" class="imp-opts" action="/admin/import/s/${esc(st.token)}">
      ${ui.select('mode', tr('imp|If some rows have problems'), [['all', tr('imp|Import nothing until all are fixed')], ['valid', tr('imp|Import the good rows, skip the rest')]], opt.mode, { attrs: { 'data-autosubmit': '' } })}
      ${ui.select('action', tr('imp|What to do'), [['both', tr('imp|Add new and update existing')], ['create', tr('imp|Only add new records')], ['update', tr('imp|Only update existing records')]], opt.action, { attrs: { 'data-autosubmit': '' } })}
      ${ui.select('empties', tr('imp|Empty cells on existing records'), [['keep', tr('imp|Keep what is in the system')], ['clear', tr('imp|Clear that field')]], opt.empties, { attrs: { 'data-autosubmit': '' } })}
      <noscript>${ui.btn(esc(tr('imp|Apply')), { cls: 'btn--ghost btn--sm' })}</noscript></form>`;
    const n = pv.counts.new + pv.counts.update;
    const commit = pv.canCommit
      ? ui.form(`/admin/import/s/${st.token}/commit`, req.session.csrf, `<input type="hidden" name="mode" value="${opt.mode}"><input type="hidden" name="action" value="${opt.action}"><input type="hidden" name="empties" value="${opt.empties}">${ui.btn(esc(tn(n, 'imp|Import {n} record', 'imp|Import {n} records')), { cls: 'btn--primary btn--block', ic: 'check', attrs: { 'data-imp-commit': '', 'data-busy': tr('imp|Importing…') } })}`, { cls: 'imp-commit' })
      : `<p class="alert alert--warn">${esc(pv.counts.error && opt.mode === 'all' ? tr('imp|Fix the rows with problems (download them marked in your workbook), or choose to import only the good rows.') : tr('imp|There is nothing new or changed to import.'))}</p>`;
    const side = `${ui.card(tr('imp|Ready to import'), `<div class="imp-sum">
        <p><b>${ui.n0(pv.counts.new)}</b><span>${esc(tr('imp|new'))}</span></p><p><b>${ui.n0(pv.counts.update)}</b><span>${esc(tr('imp|updated'))}</span></p><p><b>${ui.n0(pv.counts.same)}</b><span>${esc(tr('imp|unchanged'))}</span></p><p class="${pv.counts.error ? 'is-bad' : ''}"><b>${ui.n0(pv.counts.error)}</b><span>${esc(tr('imp|with problems'))}</span></p>
      </div>${options}${commit}<p class="muted small">${esc(tr('imp|Everything is saved in one go, and can be undone for {n} days.', { n: I.UNDO_DAYS }))}</p>`)}
      ${ui.card(tr('imp|Your file'), `<dl class="dl"><div><dt>${esc(tr('imp|File'))}</dt><dd>${esc(st.file_name || '—')}</dd></div><div><dt>${esc(tr('imp|Sheet'))}</dt><dd>${esc(pv.sheet)}</dd></div><div><dt>${esc(tr('imp|Column titles'))}</dt><dd>${esc(tr('imp|row {n}', { n: pv.headerRow + 1 }))}</dd></div><div><dt>${esc(tr('imp|Columns used'))}</dt><dd>${pv.map.columns.filter((x) => x.key).length} / ${pv.map.columns.filter((x) => !x.empty).length}</dd></div></dl>
        <div class="imp-side-actions">${pv.counts.error || pv.counts.warn ? ui.btn(esc(tr('imp|Download the problems marked in your workbook')), { href: `/admin/import/s/${st.token}/errors.xlsx?${optQs(opt)}`, cls: 'btn--ghost btn--sm', ic: 'dl' }) : ''}${ui.btn(esc(tr('imp|Change the column matching')), { href: `/admin/import/s/${st.token}/map`, cls: 'btn--ghost btn--sm' })}${ui.btn(esc(tr('imp|Upload another file')), { href: `/admin/import/${d.key}`, cls: 'btn--ghost btn--sm' })}</div>`)}`;
    const again = pv.again ? `<p class="alert alert--warn">${esc(tr('imp|You already imported this exact file {when} (by {who}). Importing it again only changes what differs now.', { when: ui.rel(pv.again.created_at), who: pv.again.user_name || tr('imp|someone') }))} <a href="/admin/import/b/${pv.again.id}">${esc(tr('imp|See that import'))}</a></p>` : '';
    const missing = pv.map.missing.length ? `<p class="alert alert--warn">${esc(tr('imp|Not in your file: {list}. Existing records keep theirs; new records need them.', { list: pv.map.missing.map((k) => T(d.col[k].label)).join(i18n.isAr() ? '، ' : ', ') }))}</p>` : '';
    const body = `${stepper(5)}${again}${missing}<div class="grid grid--side imp-preview"><div class="stack">${ui.card(tr('imp|Every row, before anything is saved'), `${chips}${search}${table}${pager}`, { sub: esc(tr('imp|Click a filter to see only those rows. Problems say exactly which cell and why.')) })}</div><div class="stack imp-side">${side}</div></div><script src="/admin/import.js?v=${ui.ASSETS.imp || '1'}" defer></script>`;
    shell(req, res, { title: tr('imp|Check: {what}', { what: T(d.title) }), body, crumbs: [['/admin/import', tr('nav|Import from Excel')], [`/admin/import/${d.key}`, T(d.title)], [null, tr('imp|Check')]] });
  });

  router.get('/import/s/:token/errors.xlsx', async (req, res, next) => {
    const st = stagedOf(req);
    if (!st) return next();
    try {
      const buf = await I.errorsWorkbook(st, optsOf(req.query), lang(), req.user);
      const base = String(st.file_name || 'import').replace(/\.(xlsx|csv)$/i, '');
      sendXlsx(res, buf, `${base} - ${lang() === 'ar' ? 'المشكلات' : 'problems'}.xlsx`);
    } catch (e) { next(e); }
  });

  // 6: the import
  router.post('/import/s/:token/commit', (req, res, next) => {
    const st = stagedOf(req);
    if (!st) return next();
    let r;
    try {
      r = I.commit(st, optsOf(req.body), req.user, lang());
    } catch (e) {
      const text = String(e.message || e);
      const why = text.startsWith('imp|') ? tr(text) : tr('imp|A row could not be saved.');
      return h.back(req, res, `/admin/import/s/${st.token}?${optQs(optsOf(req.body))}`, 'error', e.line ? tr('imp|Nothing was imported: row {line} — {why}', { line: e.line, why }) : `${tr('imp|Nothing was imported.')} ${why}`);
    }
    if (r.error) return h.back(req, res, `/admin/import/s/${st.token}?${optQs(optsOf(req.body))}`, 'error', tr(r.error));
    h.back(req, res, `/admin/import/b/${r.batch}`, 'ok', tr('imp|Imported: {a} new, {b} updated.', { a: r.counts.created, b: r.counts.updated }));
  });

  // 7: done (and undo)
  router.get('/import/b/:id', (req, res, next) => {
    const b = I.batch(req.params.id);
    if (!b || !b.d || !I.canSee(req, b.d)) return next();
    const d = b.d;
    const why = b.status === 'done' ? I.blockers(b, lang()) : [];
    const link = (x) => (d.link ? `<a href="${esc(d.link(x.id))}">${esc(x.label || `#${x.id}`)}</a>` : esc(x.label || `#${x.id}`));
    const listOf = (items) => (items.length ? `<ul class="imp-made">${items.slice(0, 200).map((x) => `<li>${link(x)}</li>`).join('')}${items.length > 200 ? `<li class="muted">${esc(tr('imp|and {n} more', { n: items.length - 200 }))}</li>` : ''}</ul>` : `<p class="muted">${esc(tr('imp|None.'))}</p>`);
    const undoCard = b.status === 'undone'
      ? `<p class="alert">${esc(tr('imp|Undone {when} by {who}.', { when: ui.rel(b.undone_at), who: b.undone_name || '—' }))}</p>`
      : I.canUndo(req, d)
        ? why.length
          ? `<p class="alert alert--warn">${esc(tr('imp|This import cannot be undone any more:'))}</p><ul class="imp-msgs imp-msgs--err">${why.slice(0, 30).map((w) => `<li>${esc(tr(w.key, w.params))}</li>`).join('')}</ul>`
          : `${ui.form(`/admin/import/b/${b.id}/undo`, req.session.csrf, ui.btn(esc(tr('imp|Undo this import')), { cls: 'btn--ghost', ic: 'back', attrs: { 'data-confirm': tr('imp|Remove the {a} new records and put back the {b} updated ones as they were?', { a: b.created, b: b.updated }) } }))}<p class="muted small">${esc(tr('imp|Possible for {n} days, while nothing uses the new records and nobody changed the updated ones.', { n: I.UNDO_DAYS }))}</p>`
        : `<p class="muted small">${esc(tr('imp|Undoing an import needs full access to {what}.', { what: T(d.title) }))}</p>`;
    const body = `${stepper(7)}<section class="imp-done ${b.status === 'undone' ? 'is-undone' : ''}">
        <span class="imp-done__ic">${ui.icon(b.status === 'undone' ? 'back' : 'check')}</span>
        <div><h2>${esc(b.status === 'undone' ? tr('imp|This import was undone') : tr('imp|{what} imported', { what: T(d.title) }))}</h2><p>${esc(tr('imp|{file} · {when} · by {who}', { file: b.file_name || '—', when: ui.dt(b.created_at), who: b.user_name || '—' }))}</p></div>
        <div class="imp-done__n"><p><b>${ui.n0(b.created)}</b><span>${esc(tr('imp|new'))}</span></p><p><b>${ui.n0(b.updated)}</b><span>${esc(tr('imp|updated'))}</span></p><p><b>${ui.n0(b.unchanged)}</b><span>${esc(tr('imp|unchanged'))}</span></p>${b.skipped ? `<p><b>${ui.n0(b.skipped)}</b><span>${esc(tr('imp|skipped'))}</span></p>` : ''}</div>
      </section>
      <div class="grid grid--side"><div class="stack">${ui.card(tr('imp|Added'), listOf(b.created_ids))}${ui.card(tr('imp|Updated'), listOf(b.changes))}</div>
      <div class="stack">${ui.card(tr('imp|Undo'), undoCard)}${ui.card(tr('imp|Next'), `<p>${ui.btn(esc(tr('imp|Open the list')), { href: d.pages[0] || d.module, cls: 'btn--ghost btn--sm', ic: 'arrow' })}</p><p>${ui.btn(esc(tr('imp|Back to the checklist')), { href: '/admin/import', cls: 'btn--ghost btn--sm' })}</p>`)}</div></div>`;
    shell(req, res, { title: tr('imp|Import {what}', { what: T(d.title) }), body, crumbs: [['/admin/import', tr('nav|Import from Excel')], ['/admin/import/history', tr('imp|All imports')], [null, `#${b.id}`]] });
  });
  router.post('/import/b/:id/undo', (req, res, next) => {
    const b = I.batch(req.params.id);
    if (!b || !b.d || !I.canSee(req, b.d)) return next();
    if (!I.canUndo(req, b.d)) return h.back(req, res, `/admin/import/b/${b.id}`, 'error', tr('imp|Undoing an import needs full access to {what}.', { what: T(b.d.title) }));
    const r = I.undo(b.id, req.user, lang());
    if (r.error) return h.back(req, res, `/admin/import/b/${b.id}`, 'error', tr(r.error));
    h.back(req, res, `/admin/import/b/${b.id}`, 'ok', tr('imp|The import was undone.'));
  });
};

const TYPE = { text: 'imp|Text', code: 'imp|Code', int: 'imp|Whole number', number: 'imp|Number', money: 'imp|Amount', percent: 'imp|Percent', date: 'imp|Date (day/month/year)', month: 'imp|Month (month/year)', time: 'imp|Time (hh:mm)', bool: 'imp|Yes / no', enum: 'imp|One of a list', email: 'imp|Email', phone: 'imp|Phone', ref: 'imp|From the list', list: 'imp|Several values, separated by commas' };
