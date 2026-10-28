'use strict';

// Records: the document vault (every file on record, the mall's own papers, one page per document)
// and the contracts register (the mall's service contracts next to its tenant leases).
// Employee files and anything marked confidential stay invisible to people without HR access.

const { t: tr, tn, tx, isAr } = require('../i18n');

// ---------- contract labels (stored as keys, read through tr) ----------
const KINDS = {
  security: 'ckind|Security', cleaning: 'ckind|Cleaning', maintenance: 'ckind|Maintenance & MEP', elevators: 'ckind|Lifts & escalators', landscaping: 'ckind|Landscaping',
  insurance: 'ckind|Insurance', utilities: 'ckind|Utilities', waste: 'ckind|Waste management', parking: 'ckind|Parking operations', it: 'ckind|IT & systems',
  marketing: 'ckind|Marketing & events', consultancy: 'ckind|Consultancy', supplies: 'ckind|Supplies', other: 'ckind|Other',
};
const STATUS = { draft: 'contract|Draft', active: 'contract|Active', expired: 'contract|Expired', terminated: 'contract|Terminated' };
const BILLING = { monthly: 'bill|Monthly', quarterly: 'bill|Quarterly', annual: 'bill|Annually', one_off: 'bill|One-off' };
const TONES = { draft: 'mute', active: 'ok', expired: 'rose', terminated: 'mute' };
const tmap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tr(v)]));
const PER_YEAR = { monthly: 12, quarterly: 4, annual: 1, one_off: 1 };

module.exports = function records(router, h) {
  const { db, ui, M } = h;
  const R = h.R;
  const warnDays = () => Number(db.setting('doc_warn_days')) || 30;
  // documents this person may see (SQL fragment)
  const vis = (req, a = 'd') => (h.canHR(req) ? '' : ` AND ${a}.confidential = 0 AND ${a}.entity != 'employee'`);

  // ---------- documents ----------
  const DOC_SELECT = (req) => `SELECT d.*, u.name uploader,
      CASE d.entity
        WHEN 'brand' THEN (SELECT name FROM brands WHERE id = d.entity_id)
        WHEN 'lease' THEN (SELECT s.ref || ' · ' || b.name FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.id = d.entity_id)
        WHEN 'contract' THEN (SELECT ref || ' · ' || counterparty FROM contracts WHERE id = d.entity_id)
        WHEN 'unit' THEN (SELECT code FROM units WHERE id = d.entity_id)
        WHEN 'employee' THEN (SELECT ${isAr() ? 'COALESCE(name_ar, name)' : 'name'} FROM employees WHERE id = d.entity_id)
      END owner_name,
      CASE WHEN d.entity = 'brand' THEN (SELECT COUNT(*) FROM leases WHERE brand_id = d.entity_id) ELSE 0 END brand_leases
    FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE 1 = 1${vis(req)}`;

  // Where a document belongs, as a link.
  function belongs(d) {
    const name = d.entity === 'office' ? tr('The mall') : d.owner_name;
    if (!name) return { href: null, label: '—' };
    const href = {
      brand: d.brand_leases ? `/admin/tenants/${d.entity_id}` : `/admin/brands/${d.entity_id}`,
      lease: `/admin/leases/${d.entity_id}`,
      contract: `/admin/contracts/${d.entity_id}`,
      unit: `/admin/units/${d.entity_id}`,
      employee: `/admin/hr/employees/${d.entity_id}`,
      office: '/admin/documents#mall',
    }[d.entity];
    return { href, label: name };
  }
  const belongsHtml = (d) => {
    const b = belongs(d);
    return `<span class="muted small">${ui.esc(M.DOC_ENTITIES[d.entity] || '')}</span><br>${b.href ? `<a href="${b.href}">${ui.esc(b.label)}</a>` : ui.esc(b.label)}`;
  };

  router.get('/documents', (req, res) => {
    const t = M.today();
    const warn = M.addDays(t, warnDays());
    const q = {
      entity: M.DOC_GROUPS[req.query.entity] && (req.query.entity !== 'employee' || h.canHR(req)) ? req.query.entity : '',
      kind: M.DOC_KINDS[req.query.kind] ? req.query.kind : '',
      status: ['valid', 'expiring', 'expired', 'none'].includes(req.query.status) ? req.query.status : '',
      q: h.str(req.query.q, 80),
    };
    const where = [];
    const args = [];
    if (q.entity) { where.push('d.entity = ?'); args.push(q.entity); }
    if (q.kind) { where.push('d.kind = ?'); args.push(q.kind); }
    if (q.status === 'expired') { where.push('d.expires_on < ?'); args.push(t); }
    if (q.status === 'expiring') { where.push('d.expires_on >= ? AND d.expires_on <= ?'); args.push(t, warn); }
    if (q.status === 'valid') { where.push('(d.expires_on > ?)'); args.push(warn); }
    if (q.status === 'none') where.push('d.expires_on IS NULL');
    if (q.q) { where.push('(d.title LIKE ? OR d.ref LIKE ? OR d.file_name LIKE ? OR d.notes LIKE ?)'); args.push(...Array(4).fill(`%${q.q}%`)); }
    const PER = 40;
    const filtered = `${where.length ? ` AND ${where.join(' AND ')}` : ''}`;
    const matching = db.value(`SELECT COUNT(*) FROM documents d WHERE d.archived = 0${vis(req)}${filtered}`, ...args);
    const pages = Math.max(1, Math.ceil(matching / PER));
    const page = Math.min(pages, Math.max(1, h.int(req.query.page) || 1));
    const rows = db.all(`${DOC_SELECT(req)} AND d.archived = 0${filtered} ORDER BY d.created_at DESC, d.id DESC LIMIT ${PER} OFFSET ${(page - 1) * PER}`, ...args);
    const link = (n) => `/admin/documents?${new URLSearchParams({ ...Object.fromEntries(Object.entries(q).filter(([, v]) => v)), ...(n > 1 ? { page: n } : {}) })}`.replace(/\?$/, '');
    const pager = pages > 1
      ? `<nav class="pager" aria-label="${ui.esc(tr('Pages'))}">${page > 1 ? `<a class="btn btn--ghost btn--sm" href="${ui.esc(link(page - 1))}">${ui.esc(tr('Newer'))}</a>` : '<span></span>'}<span class="muted small">${ui.esc(tr('{from}–{to} of {total}', { from: (page - 1) * PER + 1, to: Math.min(page * PER, matching), total: matching }))}</span>${page < pages ? `<a class="btn btn--ghost btn--sm" href="${ui.esc(link(page + 1))}">${ui.esc(tr('Older'))}</a>` : '<span></span>'}</nav>`
      : '';

    const count = (sql, ...a) => db.value(`SELECT COUNT(*) FROM documents d WHERE d.archived = 0${vis(req)}${sql}`, ...a);
    const total = count('');
    const expiring = count(' AND d.expires_on >= ? AND d.expires_on <= ?', t, warn);
    const expired = count(' AND d.expires_on < ?', t);
    const month = count(' AND substr(d.created_at, 1, 7) = ?', t.slice(0, 7));
    const kpis = [
      ui.kpi({ label: tr('rec|On file'), value: ui.n0(total), sub: tr('current documents'), href: '/admin/documents' }),
      ui.kpi({ label: tr('rec|Expiring soon'), value: ui.n0(expiring), sub: tr('within {n} days', { n: warnDays() }), href: '/admin/documents?status=expiring', tone: expiring ? '' : '' }),
      ui.kpi({ label: tr('rec|Expired'), value: ui.n0(expired), sub: expired ? tr('Renew or replace them') : tr('Nothing has expired'), href: '/admin/documents?status=expired', tone: expired ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('Filed this month'), value: ui.n0(month), sub: ui.monthYear(t.slice(0, 7)) }),
    ].join('');

    const entities = Object.keys(M.DOC_GROUPS).filter((e) => e !== 'employee' || h.canHR(req));
    const filters = `<form class="filters" method="get" action="/admin/documents">
      <input type="search" name="q" value="${ui.esc(q.q)}" placeholder="${ui.esc(tr('Search titles, references and file names…'))}" aria-label="${ui.esc(tr('Search'))}">
      ${ui.select('entity', tr('Belongs to'), entities.map((e) => [e, M.DOC_ENTITIES[e]]), q.entity, { blank: tr('All records'), cls: 'f--inline', attrs: { 'data-autosubmit': true } })}
      ${ui.select('kind', tr('Type'), Object.keys(M.DOC_KINDS).map((k) => [k, M.DOC_KINDS[k]]), q.kind, { blank: tr('All types'), cls: 'f--inline', attrs: { 'data-autosubmit': true } })}
      ${ui.select('status', tr('Status'), [['valid', tr('rec|Valid')], ['expiring', tr('rec|Expiring soon')], ['expired', tr('rec|Expired')], ['none', tr('No expiry date')]], q.status, { blank: tr('Any status'), cls: 'f--inline', attrs: { 'data-autosubmit': true } })}
      ${ui.btn(tr('Filter'), { cls: 'btn--ghost btn--sm' })}
      ${q.q || q.entity || q.kind || q.status ? `<a class="btn btn--ghost btn--sm" href="/admin/documents">${tr('rec|Clear')}</a>` : ''}
    </form>`;
    const table = ui.table(
      [
        { label: tr('rec|Document'), render: (d) => `<span class="docrow">${ui.fileIcon(d.mime)}<span><b>${ui.esc(tx(d.title))}</b><small class="sub">${ui.esc(d.ref)} · ${ui.esc(M.DOC_KINDS[d.kind] || d.kind)}${d.version > 1 ? ` · ${ui.esc(tr('version {n}', { n: d.version }))}` : ''}${d.confidential ? ` · ${ui.esc(tr('Confidential'))}` : ''}</small></span></span>` },
        { label: tr('Belongs to'), render: belongsHtml },
        { label: tr('rec|Expiry'), render: (d) => ui.expiry(d.expires_on, { warnDays: warnDays() }) || `<span class="muted">${ui.esc(tr('rec|No expiry'))}</span>` },
        { label: tr('rec|Size'), num: true, render: (d) => ui.KB(d.size) },
        { label: tr('rec|Filed'), render: (d) => `${ui.date(d.created_at)}<small class="sub">${ui.esc(d.uploader || tr('System'))}</small>` },
      ],
      rows,
      { empty: ui.esc(q.q || q.entity || q.kind || q.status ? tr('No documents match these filters.') : tr('Nothing on file yet. Upload papers from a tenant, lease, contract or the mall panel below.')), href: (d) => `/admin/documents/${d.id}` },
    );

    // what expires next, across everything this person may see
    const next = db.all(`${DOC_SELECT(req)} AND d.archived = 0 AND d.expires_on IS NOT NULL AND d.expires_on >= ? ORDER BY d.expires_on LIMIT 8`, t);
    const nextList = next.length
      ? `<ul class="list">${next.map((d) => `<li><a href="/admin/documents/${d.id}"><span class="when"><b>${ui.esc(ui.date(d.expires_on).replace(/\s\d{4}$/, ''))}</b><small>${ui.esc(d.expires_on.slice(0, 4))}</small></span><span class="what"><b>${ui.esc(tx(d.title))}</b><small>${ui.esc(belongs(d).label)} · ${ui.esc(ui.rel(d.expires_on))}</small></span></a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('No upcoming expiry dates.'))}</p>`;
    const mall = ui.docPanel({
      docs: h.docs(req, 'office'), entity: 'office', csrf: req.session.csrf, canUpload: h.can(req, 'agent'), canDelete: h.can(req, 'manager'), canConfidential: h.canHR(req),
      title: tr('Mall documents'), sub: ui.esc(tr('Licences, certificates, insurance and policies of the mall itself')), warnDays: warnDays(), cls: 'span-2',
    });
    const body = `<div class="kpis kpis--4">${kpis}</div>
<div class="grid" id="mall">${mall}${ui.card(tr('Expiring next'), nextList)}</div>
<div class="spacer"></div>${filters}
${ui.card(tn(matching, '{n} document', '{n} documents'), `${table}${pager}`, { sub: ui.esc(tr('Current versions; earlier versions are kept on each document page')) })}`;
    h.page(req, res, { title: tr('Documents'), active: '/admin/documents', wide: true, body });
  });

  // One document: preview, details, versions.
  router.get('/documents/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const d = db.get(`${DOC_SELECT(req)} AND d.id = ?`, Number(req.params.id));
    if (!d) {
      const exists = db.get('SELECT id FROM documents WHERE id = ?', Number(req.params.id));
      return exists ? h.auth.denied(req, res) : next();
    }
    const csrf = req.session.csrf;
    const file = `/admin/documents/${d.id}/file`;
    const preview = /pdf/.test(d.mime)
      ? `<iframe class="docview" src="${file}" title="${ui.esc(tx(d.title))}" loading="lazy"></iframe>`
      : /^image\//.test(d.mime)
        ? `<div class="docview docview--img"><img src="${file}" alt="${ui.esc(tx(d.title))}"></div>`
        : `<div class="docview docview--none">${ui.fileIcon(d.mime)}<p><b>${ui.esc(d.file_name)}</b><br><span class="muted">${ui.esc(tr('This file type opens in Word or Excel.'))}</span></p>${ui.btn(tr('Download'), { href: `${file}?download=1`, cls: 'btn--primary', ic: 'dl' })}</div>`;

    // the whole version chain: back to the first, then forward to the newest
    let first = d;
    const seen = new Set([d.id]);
    while (first.replaces_id && !seen.has(first.replaces_id)) {
      const p = db.get(`SELECT d.*, u.name uploader FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`, first.replaces_id);
      if (!p) break;
      seen.add(p.id);
      first = p;
    }
    const chain = [first];
    for (let cur = first, i = 0; i < 50; i++) {
      const n = db.get('SELECT d.*, u.name uploader FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.replaces_id = ? ORDER BY d.id LIMIT 1', cur.id);
      if (!n) break;
      chain.push(n);
      cur = n;
    }
    const versions = chain.length > 1
      ? `<ul class="list versions">${chain.slice().reverse().map((v) => `<li class="${v.id === d.id ? 'is-on' : ''}"><a href="/admin/documents/${v.id}"><span class="when"><b>v${v.version}</b><small>${ui.esc(ui.date(v.created_at).replace(/\s\d{4}$/, ''))}</small></span><span class="what"><b>${ui.esc(tx(v.title))}</b><small>${ui.esc(v.file_name)} · ${ui.KB(v.size)}${v.uploader ? ` · ${ui.esc(v.uploader)}` : ''}</small></span>${v.archived ? ui.badge('archived', tr('rec|Earlier version'), 'mute') : ui.badge('current', tr('rec|Current'), 'ok')}</a></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('This is the first version.'))}</p>`;

    const b = belongs(d);
    const facts = `<dl class="dl">
      <div><dt>${tr('rec|Reference')}</dt><dd>${ui.esc(d.ref)}</dd></div>
      <div><dt>${tr('Type')}</dt><dd>${ui.esc(M.DOC_KINDS[d.kind] || d.kind)}</dd></div>
      <div><dt>${tr('Belongs to')}</dt><dd>${ui.esc(M.DOC_ENTITIES[d.entity] || '')} · ${b.href ? `<a href="${b.href}">${ui.esc(b.label)}</a>` : ui.esc(b.label)}</dd></div>
      <div><dt>${tr('rec|File')}</dt><dd><span class="ltr">${ui.esc(d.file_name)}</span> · ${ui.KB(d.size)}</dd></div>
      <div><dt>${tr('Issued')}</dt><dd>${ui.date(d.issued_on)}</dd></div>
      <div><dt>${tr('rec|Expiry')}</dt><dd>${ui.expiry(d.expires_on, { warnDays: warnDays() }) || ui.esc(tr('rec|No expiry'))}</dd></div>
      <div><dt>${tr('rec|Version')}</dt><dd>${d.version}${d.archived ? ` · ${ui.badge('archived', tr('rec|Earlier version'), 'mute')}` : ''}</dd></div>
      <div><dt>${tr('rec|Filed')}</dt><dd>${ui.dt(d.created_at)}${d.uploader ? ` · ${ui.esc(d.uploader)}` : ''}</dd></div>
      <div><dt>${tr('rec|Access')}</dt><dd>${d.confidential || d.entity === 'employee' ? `<span class="inl">${ui.icon('shield')}${ui.esc(tr('HR and administrators only'))}</span>` : ui.esc(tr('Everyone in the office'))}</dd></div>
    </dl>${d.notes ? `<blockquote class="quote quote--sm">${ui.esc(tx(d.notes))}</blockquote>` : ''}`;

    const kinds = M.DOC_GROUPS[d.entity] || ['other'];
    const edit = h.can(req, 'agent')
      ? ui.form(`/admin/documents/${d.id}`, csrf, `<div class="fields">
          ${ui.input('title', tr('Title'), d.title, { required: true })}
          ${ui.select('kind', tr('Type'), kinds.map((k) => [k, M.DOC_KINDS[k]]), d.kind)}
          ${ui.input('issued_on', tr('Issued'), d.issued_on || '', { type: 'date' })}
          ${ui.input('expires_on', tr('Expires'), d.expires_on || '', { type: 'date' })}
          ${ui.textarea('notes', tr('Notes'), d.notes || '', { rows: 2, cls: 'span-all' })}
        </div>
        ${h.canHR(req) && d.entity !== 'employee' ? `<label class="check"><input type="checkbox" name="confidential" value="1"${d.confidential ? ' checked' : ''}> ${ui.esc(tr('Confidential: HR and administrators only'))}</label>` : ''}
        ${ui.btn(tr('Save'), { cls: 'btn--primary btn--sm' })}`, { cls: 'stack' })
      : '';
    const base = `/admin/documents/upload?entity=${encodeURIComponent(d.entity)}${d.entity === 'office' ? '' : `&entity_id=${encodeURIComponent(d.entity_id)}`}`;
    const current = chain[chain.length - 1];
    const upload = h.can(req, 'agent') && !d.archived
      ? `<section class="card docs"><header class="card__head"><div><h2>${ui.esc(tr('Upload a new version'))}</h2><p>${ui.esc(tr('The current file moves to the history; nothing is lost.'))}</p></div></header><div class="card__body">
          <form class="upload" data-upload="${ui.esc(base)}" novalidate><input type="hidden" name="replaces" value="${current.id}">
          <div class="fields">${ui.input('issued_on', tr('Issued'), '', { type: 'date' })}${ui.input('expires_on', tr('Expires'), '', { type: 'date' })}</div>
          <label class="drop"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,application/pdf,image/*">${ui.icon('upload')}<span data-drop-label>${ui.esc(tr('Drop the new version here, or click to choose'))}</span><small>${ui.esc(tr('PDF, JPG, PNG, WebP, Word or Excel · up to 25 MB'))}</small><i class="drop__bar" hidden><b></b></i></label>
          <p class="upload__msg" data-upload-msg hidden></p></form></div></section>`
      : '';
    const danger = h.can(req, 'manager')
      ? `<details class="danger"><summary>${ui.esc(tr('Delete this document'))}</summary>${ui.form(`/admin/documents/${d.id}/delete`, csrf, `<p class="muted small">${ui.esc(d.replaces_id ? tr('The previous version becomes current again.') : tr('The file is removed for good.'))}</p>${ui.btn(tr('Delete'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('Delete {name}? This cannot be undone.', { name: tx(d.title) }) } })}`, { cls: 'stack' })}</details>`
      : '';
    const notice = d.archived ? `<p class="alert alert--warn">${tr('This is an earlier version. {link}', { link: `<a href="/admin/documents/${current.id}">${ui.esc(tr('Open the current version'))}</a>` })}</p>` : '';
    const body = `${notice}<div class="grid grid--side">
  <div class="stack">${ui.card(tr('rec|Preview'), preview, { cls: 'card--flush', action: `<div class="row">${ui.btn(tr('rec|Open'), { href: file, cls: 'btn--ghost btn--sm', attrs: { target: '_blank', rel: 'noopener' } })}${ui.btn(tr('Download'), { href: `${file}?download=1`, cls: 'btn--ghost btn--sm', ic: 'dl' })}</div>` })}${ui.card(tr('rec|Versions'), versions)}</div>
  <div class="stack">${ui.card(tr('Details'), facts)}${edit ? ui.card(tr('rec|Edit details'), edit) : ''}${upload}${danger}</div>
</div>`;
    h.page(req, res, { title: tx(d.title), crumbs: [['/admin/documents', tr('Documents')], [null, d.ref]], active: '/admin/documents', body });
  });

  // ---------- contracts register ----------
  const annualOf = (c) => (PER_YEAR[c.billing] || 1) * (c.value || 0);
  const noticeOf = (c) => (c.end_date ? M.addDays(c.end_date, -(Number(c.notice_days) || 0)) : null);
  const stateOf = (c, t = M.today()) => (c.status === 'active' && c.end_date && c.end_date < t && !c.auto_renew ? 'expired' : c.status);
  const renewalDue = (c, t = M.today()) => c.status === 'active' && !!c.end_date && noticeOf(c) <= t;
  const contractOf = (id) => db.get('SELECT c.*, u.name owner_name FROM contracts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?', id);
  const statusBadge = (c) => {
    const s = stateOf(c);
    return ui.badge(s, tmap(STATUS)[s] || s, TONES[s]);
  };
  const leaseSigned = (id) => !!db.value("SELECT COUNT(*) FROM documents WHERE entity = 'lease' AND entity_id = ? AND kind = 'lease_contract' AND archived = 0", id);

  router.get('/contracts', (req, res) => {
    const t = M.today();
    const tab = ['service', 'leases', 'renewals', 'expired'].includes(req.query.tab) ? req.query.tab : 'all';
    const kinds = tmap(KINDS);
    const services = db.all(`SELECT c.*, u.name owner_name, (SELECT COUNT(*) FROM documents d WHERE d.entity = 'contract' AND d.entity_id = c.id AND d.archived = 0) docs
      FROM contracts c LEFT JOIN users u ON u.id = c.owner_id ORDER BY c.end_date IS NULL, c.end_date`);
    const leases = db.all(`SELECT s.*, b.name brand FROM leases s JOIN brands b ON b.id = s.brand_id ORDER BY s.end_date`);
    const soon = M.addDays(t, 180);
    const rows = [
      ...services.map((c) => ({
        type: 'service', id: c.id, href: `/admin/contracts/${c.id}`, ref: c.ref, title: tx(c.title), party: c.counterparty, kind: kinds[c.kind] || c.kind,
        start: c.start_date, end: c.end_date, annual: annualOf(c), notice: noticeOf(c), state: stateOf(c, t), due: renewalDue(c, t), auto: !!c.auto_renew,
        badge: statusBadge(c), paper: c.docs ? `<span class="paper is-ok">${ui.icon('check')}${ui.esc(tn(c.docs, '{n} file', '{n} files'))}</span>` : `<span class="paper is-missing">${ui.esc(tr('No file'))}</span>`,
      })),
      ...leases.map((s) => {
        const signed = leaseSigned(s.id);
        const state = s.status === 'active' && s.end_date < t ? 'expired' : s.status;
        return {
          type: 'lease', id: s.id, href: `/admin/leases/${s.id}`, ref: s.ref, title: s.brand, party: s.brand, kind: `${tr('Tenant lease')} · ${M.leaseUnits(db, s.id).map((u) => u.code).join(', ')}`,
          start: s.start_date, end: s.end_date, annual: s.status === 'active' ? M.currentAnnualRent(db, s) : M.schedule({ ...s, deposit_months: 0 }, M.leaseUnits(db, s.id)).annual,
          notice: null, state, due: ['active', 'draft'].includes(s.status) && s.end_date <= soon, auto: false,
          badge: ui.badge(s.status, M.LEASE_STATUS[s.status]),
          paper: signed ? `<span class="paper is-ok">${ui.icon('check')}${ui.esc(tr('Signed copy'))}</span>` : `<span class="paper is-missing">${ui.esc(tr('Signed copy missing'))}</span>`,
        };
      }),
    ];
    const pick = {
      all: () => true,
      service: (r) => r.type === 'service',
      leases: (r) => r.type === 'lease',
      renewals: (r) => r.due && !['terminated', 'expired'].includes(r.state),
      expired: (r) => r.state === 'expired',
    }[tab];
    const list = rows.filter(pick).sort((a, b) => (a.end || '9999').localeCompare(b.end || '9999'));

    const activeSvc = services.filter((c) => stateOf(c, t) === 'active');
    const kpis = [
      ui.kpi({ label: tr('Active contracts'), value: ui.n0(activeSvc.length + leases.filter((s) => s.status === 'active').length), sub: tr('{a} service · {b} leases', { a: activeSvc.length, b: leases.filter((s) => s.status === 'active').length }) }),
      ui.kpi({ label: tr('Service contracts a year'), value: ui.money(activeSvc.reduce((s, c) => s + annualOf(c), 0), { compact: true }), sub: tr('what the mall pays its suppliers') }),
      ui.kpi({ label: tr('Renewals due'), value: ui.n0(services.filter((c) => renewalDue(c, t)).length), sub: tr('notice date reached'), href: '/admin/contracts?tab=renewals', tone: services.some((c) => renewalDue(c, t)) ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('Ending in 90 days'), value: ui.n0(rows.filter((r) => r.end && r.end >= t && r.end <= M.addDays(t, 90) && !['terminated'].includes(r.state)).length), sub: tr('service contracts and leases') }),
    ].join('');
    const tabs = [['all', tr('rec|All')], ['service', tr('Service contracts')], ['leases', tr('Tenant leases')], ['renewals', tr('Renewals due')], ['expired', tr('rec|Expired')]]
      .map(([k, l]) => `<a class="tab${tab === k ? ' is-on' : ''}" href="/admin/contracts${k === 'all' ? '' : `?tab=${k}`}">${ui.esc(l)}</a>`).join('');
    const table = ui.table(
      [
        { label: tr('Contract'), render: (r) => `<b>${ui.esc(r.title)}</b><small class="sub">${ui.esc(r.ref)}${r.type === 'service' && r.party !== r.title ? ` · ${ui.esc(r.party)}` : ''}</small>` },
        { label: tr('Type'), render: (r) => ui.esc(r.kind) },
        { label: tr('Term'), render: (r) => `${ui.date(r.start)} – ${ui.date(r.end)}${r.auto ? `<small class="sub">${ui.esc(tr('Renews automatically'))}</small>` : ''}` },
        { label: tr('Value a year'), num: true, render: (r) => ui.money(r.annual, { compact: true }) },
        { label: tr('Notice by'), render: (r) => (r.notice ? `<span class="${r.due && r.state === 'active' ? 'late' : ''}">${ui.date(r.notice)}<small class="sub">${ui.esc(ui.rel(r.notice))}</small></span>` : '—') },
        { label: tr('rec|Paper'), render: (r) => r.paper },
        { label: tr('Status'), render: (r) => r.badge },
      ],
      list,
      { empty: ui.esc(tab === 'renewals' ? tr('Nothing needs renewing right now.') : tr('No contracts here yet.')), href: (r) => r.href },
    );

    // the next twelve months, by the month each contract ends
    const months = [];
    for (let i = 0; i < 12; i++) months.push(M.addMonths(`${t.slice(0, 7)}-01`, i).slice(0, 7));
    const ending = rows.filter((r) => r.end && r.end >= t && !['terminated'].includes(r.state));
    const strip = `<ol class="tline">${months.map((m) => {
      const items = ending.filter((r) => r.end.slice(0, 7) === m);
      return `<li class="${items.length ? 'has' : ''}"><p><b>${ui.esc(ui.monthName(Number(m.slice(5, 7))))}</b><small>${m.slice(0, 4)}</small></p>${items.map((r) => `<a class="tline__item tline__item--${r.type}" href="${r.href}" title="${ui.esc(`${r.title} · ${ui.date(r.end)}`)}">${ui.esc(r.title)}</a>`).join('')}</li>`;
    }).join('')}</ol>`;

    const body = `<div class="kpis kpis--4">${kpis}</div>
${ui.card(tr('The next twelve months'), strip, { sub: ui.esc(tr('Contracts and leases by the month they end')) })}
<div class="spacer"></div><nav class="tabs">${tabs}</nav>
${ui.card(tn(list.length, '{n} contract', '{n} contracts'), table)}`;
    h.page(req, res, {
      title: tr('Contracts'), active: '/admin/contracts', wide: true, body,
      actions: h.can(req, 'manager') ? ui.btn(tr('New service contract'), { href: '/admin/contracts/new', cls: 'btn--primary', ic: 'plus' }) : '',
    });
  });

  function contractForm(req, c = {}) {
    const users = h.users();
    const v = (k, d = '') => (c[k] !== undefined && c[k] !== null ? c[k] : d);
    return ui.form(c.id ? `/admin/contracts/${c.id}` : '/admin/contracts', req.session.csrf, `
      <fieldset><legend>${tr('The contract')}</legend><div class="fields">
        ${ui.input('title', tr('Title'), v('title'), { required: true, placeholder: tr('e.g. Security services for the mall') })}
        ${ui.input('counterparty', tr('Counterparty'), v('counterparty'), { required: true, placeholder: tr('Company name') })}
        ${ui.select('kind', tr('Type'), tmap(KINDS), v('kind', 'security'))}
        ${ui.select('status', tr('Status'), Object.fromEntries(['draft', 'active'].concat(c.id ? ['expired', 'terminated'] : []).map((k) => [k, tr(STATUS[k])])), v('status', 'active'))}
        ${ui.select('owner_id', tr('Managed by'), users.map((u) => [u.id, u.name]), v('owner_id', req.user.id), { blank: tr('Nobody yet') })}
      </div></fieldset>
      <fieldset><legend>${tr('Term and value')}</legend><div class="fields">
        ${ui.input('start_date', tr('rec|Starts'), v('start_date', M.today()), { type: 'date', required: true })}
        ${ui.input('end_date', tr('rec|Ends'), v('end_date', M.addDays(M.addMonths(M.today(), 12), -1)), { type: 'date' })}
        ${ui.input('notice_days', tr('Notice period (days)'), v('notice_days', 60), { type: 'number', min: 0, max: 730, step: 1, hint: tr('How long before the end you must give notice') })}
        ${ui.input('value', tr('rec|Value'), v('value', ''), { type: 'number', min: 0, step: '0.01' })}
        ${ui.select('billing', tr('rec|Billed'), tmap(BILLING), v('billing', 'monthly'))}
      </div>
      <label class="check"><input type="checkbox" name="auto_renew" value="1"${c.auto_renew ? ' checked' : ''}> ${ui.esc(tr('Renews automatically unless notice is given'))}</label></fieldset>
      <fieldset><legend>${tr('Their contact')}</legend><div class="fields">
        ${ui.input('contact_name', tr('Name'), v('contact_name'))}
        ${ui.input('contact_phone', tr('Phone'), v('contact_phone'), { type: 'tel' })}
        ${ui.input('contact_email', tr('Email'), v('contact_email'), { type: 'email' })}
        ${ui.textarea('notes', tr('Notes'), v('notes'), { rows: 3, cls: 'span-all', placeholder: tr('Scope, service levels, penalties, anything worth remembering') })}
      </div></fieldset>
      <div class="row">${ui.btn(c.id ? tr('Save changes') : tr('Create contract'), { cls: 'btn--primary' })}${ui.btn(tr('Cancel'), { href: c.id ? `/admin/contracts/${c.id}` : '/admin/contracts', cls: 'btn--ghost' })}</div>`, { cls: 'form stack' });
  }
  function readContract(req) {
    const b = req.body;
    const date = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
    return {
      title: h.str(b.title, 160), counterparty: h.str(b.counterparty, 160), kind: KINDS[b.kind] ? b.kind : 'other',
      status: STATUS[b.status] ? b.status : 'active', owner_id: h.int(b.owner_id) && db.get('SELECT id FROM users WHERE id = ?', h.int(b.owner_id)) ? h.int(b.owner_id) : null,
      start_date: date(b.start_date), end_date: date(b.end_date), notice_days: Math.max(0, Math.min(730, h.int(b.notice_days) ?? 60)),
      value: Math.max(0, h.numv(b.value) || 0), billing: BILLING[b.billing] ? b.billing : 'monthly', auto_renew: b.auto_renew ? 1 : 0,
      contact_name: h.str(b.contact_name, 120) || null, contact_phone: h.str(b.contact_phone, 40) || null, contact_email: h.str(b.contact_email, 160) || null, notes: h.str(b.notes, 2000) || null,
    };
  }
  const invalid = (c) => (!c.title || !c.counterparty ? tr('Give the contract a title and a counterparty.') : !c.start_date ? tr('Enter the start date.') : c.end_date && c.end_date < c.start_date ? tr('The end date is before the start date.') : null);

  router.get('/contracts/new', R('manager'), (req, res) => {
    h.page(req, res, { title: tr('New service contract'), crumbs: [['/admin/contracts', tr('Contracts')], [null, tr('rec|New')]], active: '/admin/contracts', body: ui.card(tr('Service contract'), contractForm(req)) });
  });
  router.post('/contracts', R('manager'), (req, res) => {
    const c = readContract(req);
    const bad = invalid(c);
    if (bad) return h.back(req, res, '/admin/contracts/new', 'error', bad);
    const ref = db.nextRef('contracts', 'SC', 3, true);
    const r = db.run(
      `INSERT INTO contracts (ref, title, counterparty, kind, status, start_date, end_date, notice_days, auto_renew, value, billing, owner_id, contact_name, contact_phone, contact_email, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ref, c.title, c.counterparty, c.kind, c.status, c.start_date, c.end_date, c.notice_days, c.auto_renew, c.value, c.billing, c.owner_id, c.contact_name, c.contact_phone, c.contact_email, c.notes, M.now(), M.now(),
    );
    const id = Number(r.lastInsertRowid);
    h.log(req, 'Created a contract', 'contract', id, `${ref} · ${c.counterparty}`);
    h.back(req, res, `/admin/contracts/${id}`, 'ok', tr('Contract {ref} created. Add the signed copy below.', { ref }));
  });

  router.get('/contracts/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const c = contractOf(Number(req.params.id));
    if (!c) return next();
    const t = M.today();
    const csrf = req.session.csrf;
    const state = stateOf(c, t);
    const notice = noticeOf(c);
    const due = renewalDue(c, t);
    const kpis = [
      ui.kpi({ label: tr('Value a year'), value: ui.money(annualOf(c), { compact: true }), sub: tr('{amount} {billing}', { amount: ui.money(c.value), billing: tr(BILLING[c.billing] || '').toLowerCase() }) }),
      ui.kpi({ label: tr('rec|Ends'), value: c.end_date ? ui.esc(ui.date(c.end_date)) : '—', sub: c.end_date ? ui.esc(c.auto_renew ? tr('Renews automatically') : ui.rel(c.end_date)) : ui.esc(tr('Open-ended')) }),
      ui.kpi({ label: tr('Notice by'), value: notice ? ui.esc(ui.date(notice)) : '—', sub: notice ? ui.esc(tr('{days} days notice · {when}', { days: c.notice_days, when: ui.rel(notice) })) : '', tone: due && state === 'active' ? 'kpi--alert' : '' }),
      ui.kpi({ label: tr('Status'), value: statusBadge(c), sub: c.owner_name ? ui.esc(tr('Managed by {name}', { name: c.owner_name })) : ui.esc(tr('Nobody manages it yet')) }),
    ].join('');
    const facts = `<dl class="dl">
      <div><dt>${tr('rec|Reference')}</dt><dd>${ui.esc(c.ref)}</dd></div>
      <div><dt>${tr('Counterparty')}</dt><dd><b>${ui.esc(c.counterparty)}</b></dd></div>
      <div><dt>${tr('Type')}</dt><dd>${ui.esc(tmap(KINDS)[c.kind] || c.kind)}</dd></div>
      <div><dt>${tr('Term')}</dt><dd>${ui.date(c.start_date)} – ${c.end_date ? ui.date(c.end_date) : ui.esc(tr('Open-ended'))}</dd></div>
      <div><dt>${tr('rec|Value')}</dt><dd>${ui.money(c.value)} · ${ui.esc(tr(BILLING[c.billing] || ''))}</dd></div>
      <div><dt>${tr('rec|Renewal')}</dt><dd>${ui.esc(c.auto_renew ? tr('Renews automatically unless notice is given') : tr('Ends unless renewed'))}</dd></div>
      ${c.contact_name || c.contact_phone || c.contact_email ? `<div><dt>${tr('Their contact')}</dt><dd>${ui.esc(c.contact_name || '')}<p class="contact-links">${c.contact_email ? `<a href="mailto:${ui.esc(c.contact_email)}">${ui.icon('mail')}${ui.esc(c.contact_email)}</a>` : ''}${c.contact_phone ? `<a href="tel:${ui.esc(c.contact_phone.replace(/\s+/g, ''))}">${ui.icon('phone')}${ui.esc(c.contact_phone)}</a>` : ''}</p></dd></div>` : ''}
    </dl>${c.notes ? `<blockquote class="quote quote--sm">${ui.esc(tx(c.notes))}</blockquote>` : ''}`;
    const history = db.all("SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'contract' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 30", c.id);
    const hist = history.length
      ? `<ul class="feed">${history.map((a) => `<li><span class="avatar avatar--sm">${ui.esc(ui.initials(a.user_name || tr('System')))}</span><p><b>${ui.esc(a.user_name || tr('System'))}</b> ${ui.esc(isAr() ? tx(a.action) : a.action.toLowerCase())}${a.detail ? ` <span>${ui.esc(tx(a.detail))}</span>` : ''}</p><time>${ui.rel(a.created_at)}</time></li>`).join('')}</ul>`
      : `<p class="muted pad">${ui.esc(tr('No changes yet.'))}</p>`;
    const docs = ui.docPanel({
      docs: h.docs(req, 'contract', c.id), entity: 'contract', entityId: c.id, csrf, canUpload: h.can(req, 'agent'), canDelete: h.can(req, 'manager'), canConfidential: h.canHR(req),
      required: ['service_contract'], warnDays: warnDays(),
    });
    const actions = [];
    if (h.can(req, 'manager')) {
      actions.push(ui.btn(tr('Edit'), { href: `/admin/contracts/${c.id}/edit`, cls: 'btn--ghost' }));
      if (state !== 'terminated') {
        const ext = c.end_date && c.start_date ? Math.max(1, Math.round(M.daysBetween(c.start_date, c.end_date) / 30.4)) : 12;
        actions.push(`<details class="pop"><summary class="btn btn--primary">${ui.esc(tr('rec|Renew'))}</summary>${ui.form(`/admin/contracts/${c.id}/renew`, csrf, `
          ${ui.input('end_date', tr('New end date'), c.end_date ? M.addDays(M.addMonths(M.addDays(c.end_date, 1), ext), -1) : M.addMonths(t, 12), { type: 'date', required: true })}
          ${ui.input('value', tr('New value (optional)'), '', { type: 'number', min: 0, step: '0.01', hint: tr('Leave empty to keep {amount}', { amount: ui.money(c.value) }) })}
          ${ui.btn(tr('Renew contract'), { cls: 'btn--primary btn--block' })}`, { cls: 'stack' })}</details>`);
        actions.push(`<details class="pop"><summary class="btn btn--ghost">${ui.esc(tr('rec|Terminate'))}</summary>${ui.form(`/admin/contracts/${c.id}/terminate`, csrf, `
          ${ui.input('date', tr('Last day'), t, { type: 'date', required: true })}
          ${ui.input('reason', tr('Reason'), '', { placeholder: tr('e.g. Service levels not met') })}
          ${ui.btn(tr('Terminate contract'), { cls: 'btn--danger btn--block', attrs: { 'data-confirm': tr('Terminate {ref}?', { ref: c.ref }) } })}`, { cls: 'stack' })}</details>`);
      }
    }
    const danger = h.can(req, 'admin')
      ? `<details class="danger"><summary>${ui.esc(tr('Delete this contract'))}</summary>${ui.form(`/admin/contracts/${c.id}/delete`, csrf, `<p class="muted small">${ui.esc(tr('Its documents are deleted with it. Terminate instead to keep the record.'))}</p>${ui.btn(tr('Delete'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('Delete {ref} and its documents? This cannot be undone.', { ref: c.ref }) } })}`, { cls: 'stack' })}</details>`
      : '';
    const alert = due && state === 'active' ? `<p class="alert alert--warn">${ui.esc(c.end_date < t ? tr('This contract ended {when}. Renew it, or mark it ended.', { when: ui.rel(c.end_date) }) : c.auto_renew ? tr('The notice date has passed: it will renew automatically on {date}.', { date: ui.date(M.addDays(c.end_date, 1)) }) : tr('Decide now: it ends {when} and needs {days} days notice.', { when: ui.rel(c.end_date), days: c.notice_days }))}</p>` : '';
    const body = `${alert}<div class="kpis kpis--4">${kpis}</div>
<div class="grid grid--side"><div class="stack">${docs}${h.opsPanels && h.opsPanels.contract ? h.opsPanels.contract(req, c.id) : ''}${ui.card(tr('History'), hist)}</div><div class="stack">${ui.card(tr('Details'), facts)}${danger}</div></div>`;
    h.page(req, res, { title: tx(c.title), crumbs: [['/admin/contracts', tr('Contracts')], [null, c.ref]], active: '/admin/contracts', body, actions: `<div class="row">${actions.join('')}</div>` });
  });

  router.get('/contracts/:id/edit', R('manager'), (req, res, next) => {
    const c = contractOf(h.int(req.params.id));
    if (!c) return next();
    h.page(req, res, { title: tr('Edit {ref}', { ref: c.ref }), crumbs: [['/admin/contracts', tr('Contracts')], [`/admin/contracts/${c.id}`, c.ref], [null, tr('Edit')]], active: '/admin/contracts', body: ui.card(tr('Service contract'), contractForm(req, c)) });
  });
  router.post('/contracts/:id', R('manager'), (req, res, next) => {
    const old = contractOf(h.int(req.params.id));
    if (!old) return next();
    const c = readContract(req);
    const bad = invalid(c);
    if (bad) return h.back(req, res, `/admin/contracts/${old.id}/edit`, 'error', bad);
    db.run(
      `UPDATE contracts SET title = ?, counterparty = ?, kind = ?, status = ?, start_date = ?, end_date = ?, notice_days = ?, auto_renew = ?, value = ?, billing = ?, owner_id = ?, contact_name = ?, contact_phone = ?, contact_email = ?, notes = ?, updated_at = ? WHERE id = ?`,
      c.title, c.counterparty, c.kind, c.status, c.start_date, c.end_date, c.notice_days, c.auto_renew, c.value, c.billing, c.owner_id, c.contact_name, c.contact_phone, c.contact_email, c.notes, M.now(), old.id,
    );
    h.log(req, 'Edited a contract', 'contract', old.id, `${old.ref} · ${c.counterparty}`);
    h.back(req, res, `/admin/contracts/${old.id}`, 'ok', tr('Saved.'));
  });
  router.post('/contracts/:id/renew', R('manager'), (req, res, next) => {
    const c = contractOf(h.int(req.params.id));
    if (!c) return next();
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.end_date || '')) ? req.body.end_date : null;
    if (!end || (c.end_date && end <= c.end_date) || (c.start_date && end <= c.start_date)) return h.back(req, res, `/admin/contracts/${c.id}`, 'error', tr('Choose an end date after the current one.'));
    const value = h.numv(req.body.value);
    db.run("UPDATE contracts SET end_date = ?, status = 'active', value = ?, updated_at = ? WHERE id = ?", end, value !== null && value >= 0 ? value : c.value, M.now(), c.id);
    h.log(req, 'Renewed a contract', 'contract', c.id, `${c.ref}: until ${end}`);
    h.back(req, res, `/admin/contracts/${c.id}`, 'ok', tr('Renewed until {date}.', { date: ui.date(end) }));
  });
  router.post('/contracts/:id/terminate', R('manager'), (req, res, next) => {
    const c = contractOf(h.int(req.params.id));
    if (!c) return next();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || '')) ? req.body.date : M.today();
    const reason = h.str(req.body.reason, 300);
    db.run("UPDATE contracts SET status = 'terminated', end_date = ?, updated_at = ? WHERE id = ?", date, M.now(), c.id);
    h.log(req, 'Terminated a contract', 'contract', c.id, reason ? `${c.ref} · ${reason}` : c.ref);
    h.back(req, res, `/admin/contracts/${c.id}`, 'ok', tr('Contract terminated.'));
  });
  router.post('/contracts/:id/delete', R('admin'), (req, res, next) => {
    const c = contractOf(h.int(req.params.id));
    if (!c) return next();
    const docs = db.all("SELECT stored FROM documents WHERE entity = 'contract' AND entity_id = ?", c.id);
    db.tx(() => {
      db.run("UPDATE documents SET replaces_id = NULL WHERE replaces_id IN (SELECT id FROM documents WHERE entity = 'contract' AND entity_id = ?)", c.id);
      db.run("DELETE FROM documents WHERE entity = 'contract' AND entity_id = ?", c.id);
      db.run('DELETE FROM contracts WHERE id = ?', c.id);
    });
    for (const d of docs) h.files.release(db, d.stored);
    h.log(req, 'Deleted a contract', 'contract', c.id, `${c.ref} · ${c.counterparty}`);
    h.back(req, res, '/admin/contracts', 'ok', tr('Contract deleted.'));
  });

  // for the dashboard and other modules
  h.records = {
    renewalsDue: () => db.all("SELECT * FROM contracts WHERE status = 'active' AND end_date IS NOT NULL AND date(end_date, '-' || notice_days || ' days') <= ? ORDER BY end_date", M.today()),
    docAlerts: (req) => {
      const t = M.today();
      const warn = M.addDays(t, warnDays());
      return {
        expired: db.value(`SELECT COUNT(*) FROM documents d WHERE d.archived = 0 AND d.expires_on < ?${vis(req)}`, t),
        expiring: db.value(`SELECT COUNT(*) FROM documents d WHERE d.archived = 0 AND d.expires_on >= ? AND d.expires_on <= ?${vis(req)}`, t, warn),
      };
    },
    leaseSigned,
  };
};

module.exports.KINDS = KINDS;
