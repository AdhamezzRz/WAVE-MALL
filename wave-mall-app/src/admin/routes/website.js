'use strict';

// The website's store directory, events and promotions. The office keeps them at /admin/website;
// the public site shows them at /stores/ and /events/ (src/app.js and src/pages.js read them
// through h.website).
// A brand can be published once it has an active lease; when its lease ends it leaves the website
// by itself. Hours, phone, Instagram and website come from the tenant file unless the listing
// says otherwise. Everything is written in English and Arabic.
// Images (logos, covers, posters) are kept apart from the document vault (files-web beside it) and served
// at /media/web/<sha256>.<ext> only while something published uses them. Uploads must be real
// JPG, PNG or WebP images; the sample data draws its own SVG covers.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { sniff } = require('../files');
const { t: tr, tn, tx, isAr } = require('../i18n');

const MAX_IMAGE = 8 * 1024 * 1024;
const RASTER = ['png', 'jpg', 'webp'];

const SCHEMA = `
  CREATE TABLE web_images (
    id INTEGER PRIMARY KEY, stored TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    file_name TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE INDEX web_images_stored ON web_images(stored);
  CREATE TABLE web_stores (
    id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL UNIQUE REFERENCES brands(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_ar TEXT, category TEXT NOT NULL DEFAULT 'other',
    tagline TEXT, tagline_ar TEXT, description TEXT, description_ar TEXT,
    hours TEXT, phone TEXT, instagram TEXT, website TEXT,
    logo_id INTEGER REFERENCES web_images(id) ON DELETE SET NULL, cover_id INTEGER REFERENCES web_images(id) ON DELETE SET NULL,
    opening_soon INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0, published_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE web_events (
    id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, title_ar TEXT,
    starts_on TEXT NOT NULL, ends_on TEXT, time_from TEXT, time_to TEXT, location TEXT, location_ar TEXT,
    summary TEXT, summary_ar TEXT, description TEXT, description_ar TEXT, rsvp_url TEXT,
    cover_id INTEGER REFERENCES web_images(id) ON DELETE SET NULL, featured INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0, published_at TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE web_promos (
    id INTEGER PRIMARY KEY, brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE, title TEXT NOT NULL, title_ar TEXT,
    details TEXT, details_ar TEXT, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, link TEXT,
    image_id INTEGER REFERENCES web_images(id) ON DELETE SET NULL, published INTEGER NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

// "Maison Lune" → "maison-lune"; Arabic-only names fall back to a number
const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const cleanUrl = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null;
  } catch {
    return null;
  }
};
// "@maisonlune", "maisonlune" or an instagram.com link → "maisonlune"
const cleanHandle = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:\?.*)?$/i) || s.match(/^@?([A-Za-z0-9._]{1,30})$/);
  return m ? m[1] : null;
};

module.exports = function website(router, h) {
  const { db, ui, M } = h;
  const R = h.R;
  db.ensure('website-1', SCHEMA);
  // beside the document vault, not inside it: the vault holds only documents' files
  const dir = (h.env && h.env.ADMIN_WEB_FILES) || `${h.files.dir.replace(/[\\/]+$/, '')}-web`;
  fs.mkdirSync(dir, { recursive: true });
  const T = () => M.today();
  // the public site's address, as visitors see it
  const siteOf = (req) => String((h.env && h.env.SITE_URL) || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const pubLink = (req, p) => `<a class="ltr" href="${ui.esc(p)}" target="_blank" rel="noopener">${ui.esc(siteOf(req) + p)}</a>`;

  // ---------- images ----------
  const imageUrl = (img) => (img ? `/media/web/${img.stored}` : null);
  const imageOf = (id) => (id ? db.get('SELECT * FROM web_images WHERE id = ?', id) : null);
  function saveImage(buf, name, { demo = 0, svg = false } = {}) {
    if (!buf || !buf.length) return { error: 'empty' };
    if (buf.length > MAX_IMAGE) return { error: 'too_big' };
    let ext;
    let mime;
    if (svg) {
      ext = 'svg';
      mime = 'image/svg+xml';
    } else {
      const type = sniff(buf, name);
      if (!type || !RASTER.includes(type.ext)) return { error: 'type' };
      ext = type.ext;
      mime = type.mime;
    }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const stored = `${sha256}.${ext}`;
    const file = path.join(dir, stored);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { mode: 0o644 });
    const id = Number(db.run('INSERT INTO web_images (stored, mime, size, sha256, file_name, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      stored, mime, buf.length, sha256, String(name || '').slice(0, 160) || null, demo ? 1 : 0, M.now()).lastInsertRowid);
    return { id, stored };
  }
  // An image nothing points to any more is removed (its file too, once no other row shares it).
  function releaseImage(id) {
    if (!id) return;
    const used = db.value('SELECT (SELECT COUNT(*) FROM web_stores WHERE logo_id = ? OR cover_id = ?) + (SELECT COUNT(*) FROM web_events WHERE cover_id = ?) + (SELECT COUNT(*) FROM web_promos WHERE image_id = ?)', id, id, id, id);
    if (used) return;
    const img = imageOf(id);
    if (!img) return;
    db.run('DELETE FROM web_images WHERE id = ?', id);
    if (!db.value('SELECT COUNT(*) FROM web_images WHERE stored = ?', img.stored)) {
      const p = path.join(dir, path.basename(img.stored));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  const ACTIVE = "EXISTS (SELECT 1 FROM leases l WHERE l.brand_id = s.brand_id AND l.status = 'active')";
  // Public: an image is served only while a published store, event or promotion uses it.
  h.public.get('/media/web/:file', (req, res, next) => {
    const file = String(req.params.file);
    if (!/^[a-f0-9]{64}\.(png|jpg|webp|svg)$/.test(file)) return next();
    const img = db.get(`SELECT i.* FROM web_images i WHERE i.stored = ? AND (
        EXISTS (SELECT 1 FROM web_stores s WHERE s.published = 1 AND ${ACTIVE} AND (s.logo_id = i.id OR s.cover_id = i.id))
        OR EXISTS (SELECT 1 FROM web_events e WHERE e.published = 1 AND e.cover_id = i.id)
        OR EXISTS (SELECT 1 FROM web_promos p WHERE p.published = 1 AND p.image_id = i.id)) LIMIT 1`, file);
    const p = img && path.join(dir, file);
    if (!img || !fs.existsSync(p)) return next();
    res.set({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': img.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    return res.sendFile(p);
  });
  // The office sees every image, published or not.
  router.get('/website/img/:id', (req, res, next) => {
    const img = imageOf(h.int(req.params.id));
    const p = img && path.join(dir, path.basename(img.stored));
    if (!img || !fs.existsSync(p)) return next();
    res.set({ 'Content-Type': img.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    return res.sendFile(p);
  });

  // ---------- reading ----------
  const STORE_SELECT = `SELECT s.*, b.name brand_name, b.category brand_category, b.trading_hours b_hours, b.store_phone b_phone, b.instagram b_instagram,
      b.website b_website, b.opening_date, ${ACTIVE} active_lease,
      (SELECT COUNT(*) FROM leases l WHERE l.brand_id = s.brand_id AND l.status = 'draft') draft_lease
    FROM web_stores s JOIN brands b ON b.id = s.brand_id`;
  const storeOf = (id) => db.get(`${STORE_SELECT} WHERE s.id = ?`, id);
  const unitsOf = (brandId) => db.all(
    `SELECT u.code, u.level, u.zone FROM leases l JOIN lease_units lu ON lu.lease_id = l.id JOIN units u ON u.id = lu.unit_id
     WHERE l.brand_id = ? AND l.status IN ('active','draft') ORDER BY l.status = 'active' DESC, u.sort`, brandId,
  ).filter((u, i, all) => all.findIndex((x) => x.code === u.code) === i);
  const handleOf = (v) => cleanHandle(v) || null;
  const stateOf = (s) => (!s.published ? 'draft' : s.active_lease ? 'live' : 'paused');
  const STATE = { live: ['web|Live', 'ok'], draft: ['web|Draft', 'mute'], paused: ['web|Hidden: no active lease', 'amber'] };
  const stateBadge = (s) => ui.badge(stateOf(s), tr(STATE[stateOf(s)][0]), STATE[stateOf(s)][1]);
  const pick = (en, ar) => (isAr() && ar ? ar : en);

  // A store as the public site shows it, in both languages.
  function publicStore(s) {
    const units = unitsOf(s.brand_id).map((u) => ({ code: u.code, level: u.level, zone: u.zone, n: Number(String(u.code).replace(/\D+/g, '')) || null }));
    const cover = imageOf(s.cover_id);
    const logo = imageOf(s.logo_id);
    const soon = !!s.opening_soon || (s.opening_date && s.opening_date > T());
    return {
      id: s.id, brandId: s.brand_id, slug: s.slug, category: s.category,
      name: { en: s.name, ar: s.name_ar || s.name },
      tagline: { en: s.tagline || '', ar: s.tagline_ar || s.tagline || '' },
      description: { en: s.description || '', ar: s.description_ar || s.description || '' },
      hours: s.hours || s.b_hours || '', phone: s.phone || s.b_phone || '',
      instagram: handleOf(s.instagram || s.b_instagram), website: cleanUrl(s.website || s.b_website) || null,
      logo: imageUrl(logo), cover: imageUrl(cover), featured: !!s.featured,
      openingSoon: soon, openingDate: s.opening_date && s.opening_date > T() ? s.opening_date : null,
      units, updated: String(s.updated_at || s.created_at).slice(0, 10),
    };
  }
  function publicEvent(e) {
    return {
      id: e.id, slug: e.slug, title: { en: e.title, ar: e.title_ar || e.title },
      summary: { en: e.summary || '', ar: e.summary_ar || e.summary || '' },
      description: { en: e.description || '', ar: e.description_ar || e.description || '' },
      location: { en: e.location || '', ar: e.location_ar || e.location || '' },
      startsOn: e.starts_on, endsOn: e.ends_on || e.starts_on, timeFrom: e.time_from || '', timeTo: e.time_to || '',
      rsvp: cleanUrl(e.rsvp_url) || null, cover: imageUrl(imageOf(e.cover_id)), featured: !!e.featured,
      updated: String(e.updated_at || e.created_at).slice(0, 10),
    };
  }
  function publicPromo(p) {
    return {
      id: p.id, brandId: p.brand_id, title: { en: p.title, ar: p.title_ar || p.title }, details: { en: p.details || '', ar: p.details_ar || p.details || '' },
      startsOn: p.starts_on, endsOn: p.ends_on, link: cleanUrl(p.link) || null, image: imageUrl(imageOf(p.image_id)),
      store: p.slug ? { slug: p.slug, name: { en: p.store_name, ar: p.store_name_ar || p.store_name } } : null,
    };
  }
  const live = () => db.all(`${STORE_SELECT} WHERE s.published = 1 AND ${ACTIVE} ORDER BY s.featured DESC, s.name COLLATE NOCASE`);
  const PROMO_SELECT = `SELECT p.*, s.slug, s.name store_name, s.name_ar store_name_ar FROM web_promos p
    LEFT JOIN web_stores s ON s.brand_id = p.brand_id AND s.published = 1 AND ${ACTIVE}`;
  const site = {
    stores: () => live().map(publicStore),
    store: (slug) => {
      const s = db.get(`${STORE_SELECT} WHERE s.slug = ? AND s.published = 1 AND ${ACTIVE}`, String(slug));
      return s ? publicStore(s) : null;
    },
    events: () => {
      const t = T();
      const all = db.all('SELECT * FROM web_events WHERE published = 1 ORDER BY starts_on, time_from, id').map(publicEvent);
      return { upcoming: all.filter((e) => e.endsOn >= t), past: all.filter((e) => e.endsOn < t).reverse().slice(0, 6) };
    },
    event: (slug) => {
      const e = db.get('SELECT * FROM web_events WHERE slug = ? AND published = 1', String(slug));
      return e ? publicEvent(e) : null;
    },
    // offers running now or starting within two weeks; a store's offers only while it is listed
    promos: (brandId = null) => db.all(`${PROMO_SELECT} WHERE p.published = 1 AND p.ends_on >= ? AND p.starts_on <= ? ${brandId ? 'AND p.brand_id = ?' : ''} ORDER BY p.starts_on, p.id`,
      T(), M.addDays(T(), 14), ...(brandId ? [brandId] : [])).filter((p) => !p.brand_id || p.slug).map(publicPromo),
    intro: (lang) => ({
      stores: db.setting(`web_stores_intro_${lang}`) || '',
      events: db.setting(`web_events_intro_${lang}`) || '',
    }),
    sitemap: () => ({
      stores: live().map((s) => ({ slug: s.slug, updated: String(s.updated_at).slice(0, 10) })),
      events: db.all('SELECT slug, updated_at FROM web_events WHERE published = 1').map((e) => ({ slug: e.slug, updated: String(e.updated_at).slice(0, 10) })),
    }),
  };

  // ---------- for the tenant file ----------
  function tenantCard(req, brandId) {
    const s = db.get(`${STORE_SELECT} WHERE s.brand_id = ?`, brandId);
    const active = db.value("SELECT COUNT(*) FROM leases WHERE brand_id = ? AND status = 'active'", brandId);
    const draft = db.value("SELECT COUNT(*) FROM leases WHERE brand_id = ? AND status = 'draft'", brandId);
    if (!s && !active && !draft) return '';
    let body;
    let action = '';
    if (s) {
      const st = stateOf(s);
      body = `<p class="webline">${stateBadge(s)} ${st === 'live' ? pubLink(req, `/stores/${s.slug}/`) : `<span class="muted">${ui.esc(tr(st === 'draft' ? 'web|Not on the website yet.' : 'web|Shown again once a lease is active.'))}</span>`}</p>`;
      action = ui.btn(tr('web|Edit listing'), { href: `/admin/website/stores/${s.id}`, cls: 'btn--ghost btn--sm', ic: 'globe' });
    } else {
      body = `<p class="muted">${ui.esc(tr(active ? 'web|Not on the website yet.' : 'web|The listing can be prepared now and published when the lease is active.'))}</p>`;
      if (h.can(req, 'agent')) action = ui.form('/admin/website/stores', req.session.csrf, `<input type="hidden" name="brand_id" value="${brandId}">${ui.btn(tr('web|Create listing'), { cls: 'btn--ghost btn--sm', ic: 'globe' })}`);
    }
    return ui.card(tr('web|Website directory'), body, { action });
  }
  const status = (brandId) => {
    const s = db.get(`${STORE_SELECT} WHERE s.brand_id = ?`, brandId);
    return s ? { id: s.id, slug: s.slug, state: stateOf(s) } : null;
  };
  h.website = { ...site, publicStore, tenantCard, status, saveImage, releaseImage, slugify };
  // the tenant file shows whether the brand is on the website
  (h.tenantCards = h.tenantCards || []).push((req, b) => tenantCard(req, b.id));

  // ---------- the admin ----------
  const TABS = [['stores', 'web|Stores'], ['events', 'web|Events'], ['promos', 'web|Promotions'], ['settings', 'Settings']];
  const tabsNav = (on) => `<nav class="tabs">${TABS.map(([k, l]) => `<a class="tab${on === k ? ' is-on' : ''}" href="/admin/website${k === 'stores' ? '' : `?tab=${k}`}">${ui.esc(tr(l))}</a>`).join('')}</nav>`;
  const thumb = (img, cls = '') => (img ? `<img class="webthumb ${cls}" src="/admin/website/img/${img.id}" alt="">` : `<span class="webthumb webthumb--none ${cls}">${ui.icon('globe')}</span>`);
  const arText = (name, label, value, { rows = 4, input = false } = {}) => (input
    ? `<label class="f"><span class="f__l">${ui.esc(label)}</span><input type="text" name="${name}" value="${ui.esc(value || '')}" dir="rtl" lang="ar"></label>`
    : `<label class="f"><span class="f__l">${ui.esc(label)}</span><textarea name="${name}" rows="${rows}" dir="rtl" lang="ar">${ui.esc(value || '')}</textarea></label>`);
  const check = (name, label, on) => `<label class="check"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}> ${ui.esc(label)}</label>`;
  const uploader = (url, label) => `<form class="upload" data-upload="${url}" novalidate><label class="drop drop--sm"><input type="file" name="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp">${ui.icon('upload')}<span data-drop-label>${ui.esc(label)}</span><small>${ui.esc(tr('web|JPG, PNG or WebP, up to 8 MB'))}</small><i class="drop__bar" hidden><b></b></i></label><p class="upload__msg" data-upload-msg hidden></p></form>`;

  router.get('/website', (req, res) => {
    const tab = TABS.some(([k]) => k === req.query.tab) ? req.query.tab : 'stores';
    const csrf = req.session.csrf;
    const agent = h.can(req, 'agent');
    const t = T();
    const counts = {
      live: live().length,
      soon: live().filter((s) => s.opening_soon || (s.opening_date && s.opening_date > t)).length,
      events: db.value('SELECT COUNT(*) FROM web_events WHERE published = 1 AND COALESCE(ends_on, starts_on) >= ?', t),
      promos: db.value('SELECT COUNT(*) FROM web_promos WHERE published = 1 AND starts_on <= ? AND ends_on >= ?', t, t),
    };
    const kpis = `<div class="kpis">${[
      ui.kpi({ label: tr('web|Stores live'), value: String(counts.live), href: '/admin/website' }),
      ui.kpi({ label: tr('web|Opening soon'), value: String(counts.soon) }),
      ui.kpi({ label: tr('web|Upcoming events'), value: String(counts.events), href: '/admin/website?tab=events' }),
      ui.kpi({ label: tr('web|Promotions running'), value: String(counts.promos), href: '/admin/website?tab=promos' }),
    ].join('')}</div>`;
    let body = '';
    if (tab === 'stores') {
      const listings = db.all(`${STORE_SELECT} ORDER BY s.published DESC, s.name COLLATE NOCASE`);
      const ready = db.all(`SELECT b.id, b.name, b.category, (SELECT COUNT(*) FROM leases l WHERE l.brand_id = b.id AND l.status = 'active') active
        FROM brands b WHERE EXISTS (SELECT 1 FROM leases l WHERE l.brand_id = b.id AND l.status IN ('active','draft')) AND NOT EXISTS (SELECT 1 FROM web_stores s WHERE s.brand_id = b.id) ORDER BY active DESC, b.name`);
      const readyCard = ready.length ? ui.card(tr('web|Ready to list'), `<ul class="list">${ready.map((b) => `<li><span class="what"><b>${ui.esc(b.name)}</b><small>${ui.esc(M.CATEGORIES[b.category] || b.category)} · ${ui.esc(tr(b.active ? 'web|Lease active' : 'web|Lease in draft'))}</small></span>${agent ? ui.form('/admin/website/stores', csrf, `<input type="hidden" name="brand_id" value="${b.id}">${ui.btn(tr('web|Create listing'), { cls: 'btn--ghost btn--sm', ic: 'plus' })}`) : ''}</li>`).join('')}</ul>`, { sub: tr('web|Tenants with a lease and no listing yet. The listing starts from the tenant file.') }) : '';
      const table = ui.table([
        { label: tr('web|Store'), render: (s) => `<span class="webrow">${thumb(imageOf(s.logo_id), 'webthumb--logo')}<span><b>${ui.esc(pick(s.name, s.name_ar))}</b><small class="sub ltr">${ui.esc(`${siteOf(req)}/stores/${s.slug}/`)}</small></span></span>` },
        { label: tr('Category'), render: (s) => ui.esc(M.CATEGORIES[s.category] || s.category) },
        { label: tr('Units'), render: (s) => ui.esc(unitsOf(s.brand_id).map((u) => u.code).join(', ') || '—') },
        { label: tr('Status'), render: (s) => `${stateBadge(s)}${s.opening_soon ? ` ${ui.badge('soon', tr('web|Opening soon'), 'sea')}` : ''}${s.featured ? ` ${ui.badge('featured', tr('web|Featured'), 'cocoa')}` : ''}` },
        { label: tr('web|Updated'), render: (s) => ui.rel(s.updated_at) },
      ], listings, { empty: tr('web|No store listings yet. Create one from a tenant with a lease.'), href: (s) => `/admin/website/stores/${s.id}` });
      body = `${kpis}${tabsNav(tab)}<div class="stack">${readyCard}${ui.card(tn(listings.length, 'web|{n} listing', 'web|{n} listings'), table, { action: counts.live ? ui.btn(tr('web|View the directory'), { href: '/stores/', cls: 'btn--ghost btn--sm', ic: 'globe', attrs: { target: '_blank', rel: 'noopener' } }) : '' })}</div>`;
    } else if (tab === 'events') {
      const list = db.all('SELECT * FROM web_events ORDER BY starts_on DESC, id DESC');
      const table = ui.table([
        { label: tr('web|Event'), render: (e) => `<span class="webrow">${thumb(imageOf(e.cover_id))}<span><b>${ui.esc(pick(e.title, e.title_ar))}</b><small class="sub">${ui.esc(pick(e.location, e.location_ar) || '')}</small></span></span>` },
        { label: tr('Date'), render: (e) => `${ui.date(e.starts_on)}${e.ends_on && e.ends_on !== e.starts_on ? ` – ${ui.date(e.ends_on)}` : ''}${e.time_from ? `<small class="sub ltr">${ui.esc(e.time_from)}${e.time_to ? `–${ui.esc(e.time_to)}` : ''}</small>` : ''}` },
        { label: tr('Status'), render: (e) => (e.published ? ((e.ends_on || e.starts_on) < t ? ui.badge('past', tr('web|Past'), 'mute') : ui.badge('live', tr('web|Live'), 'ok')) : ui.badge('draft', tr('web|Draft'), 'mute')) },
      ], list, { empty: tr('web|No events yet.'), href: (e) => `/admin/website/events/${e.id}` });
      const add = agent ? ui.form('/admin/website/events', csrf, `<div class="fields">${ui.input('title', tr('web|Title (English)'), '', { required: true })}${ui.input('starts_on', tr('web|Date'), M.addDays(t, 14), { type: 'date', required: true })}</div>${ui.btn(tr('web|Create event'), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' }) : '';
      body = `${kpis}${tabsNav(tab)}<div class="grid grid--side"><div>${ui.card(tr('web|Events'), table)}</div><div>${add ? ui.card(tr('web|New event'), add) : ''}</div></div>`;
    } else if (tab === 'promos') {
      const list = db.all('SELECT p.*, b.name brand_name FROM web_promos p LEFT JOIN brands b ON b.id = p.brand_id ORDER BY p.ends_on DESC, p.id DESC');
      const table = ui.table([
        { label: tr('web|Promotion'), render: (p) => `<span class="webrow">${thumb(imageOf(p.image_id))}<span><b>${ui.esc(pick(p.title, p.title_ar))}</b><small class="sub">${ui.esc(p.brand_name || tr('web|The Wave'))}</small></span></span>` },
        { label: tr('web|Valid'), render: (p) => `${ui.date(p.starts_on)} – ${ui.date(p.ends_on)}` },
        { label: tr('Status'), render: (p) => (!p.published ? ui.badge('draft', tr('web|Draft'), 'mute') : p.ends_on < t ? ui.badge('past', tr('web|Ended'), 'mute') : p.starts_on > t ? ui.badge('soon', tr('web|Scheduled'), 'sky') : ui.badge('live', tr('web|Live'), 'ok')) },
      ], list, { empty: tr('web|No promotions yet.'), href: (p) => `/admin/website/promos/${p.id}` });
      const brands = db.all("SELECT DISTINCT b.id, b.name FROM brands b JOIN leases l ON l.brand_id = b.id AND l.status = 'active' ORDER BY b.name");
      const add = agent ? ui.form('/admin/website/promos', csrf, `<div class="fields">${ui.select('brand_id', tr('web|Store'), brands.map((b) => [b.id, b.name]), h.int(req.query.brand) || '', { blank: tr('web|The Wave (mall-wide)') })}${ui.input('title', tr('web|Title (English)'), '', { required: true })}${ui.input('starts_on', tr('web|From'), t, { type: 'date', required: true })}${ui.input('ends_on', tr('web|Until'), M.addDays(t, 30), { type: 'date', required: true })}</div>${ui.btn(tr('web|Create promotion'), { cls: 'btn--primary btn--sm', ic: 'plus' })}`, { cls: 'stack' }) : '';
      body = `${kpis}${tabsNav(tab)}<div class="grid grid--side"><div>${ui.card(tr('web|Promotions'), table)}</div><div>${add ? ui.card(tr('web|New promotion'), add) : ''}</div></div>`;
    } else {
      const mgr = h.can(req, 'manager');
      const form = `<div class="fields fields--2">
        ${ui.textarea('stores_en', tr('web|Directory introduction (English)'), db.setting('web_stores_intro_en') || '', { rows: 3, placeholder: tr('web|Leave empty for the standard text') })}
        ${arText('stores_ar', tr('web|Directory introduction (Arabic)'), db.setting('web_stores_intro_ar'), { rows: 3 })}
        ${ui.textarea('events_en', tr('web|Events introduction (English)'), db.setting('web_events_intro_en') || '', { rows: 3, placeholder: tr('web|Leave empty for the standard text') })}
        ${arText('events_ar', tr('web|Events introduction (Arabic)'), db.setting('web_events_intro_ar'), { rows: 3 })}
      </div>${mgr ? ui.btn(tr('Save'), { cls: 'btn--primary' }) : ''}`;
      body = `${kpis}${tabsNav(tab)}${ui.card(tr('web|Website settings'), mgr ? ui.form('/admin/website/settings', csrf, form, { cls: 'stack' }) : form, { sub: tr('web|The text at the top of the public directory and events pages.') })}`;
    }
    h.page(req, res, { title: tr('nav|Website'), active: '/admin/website', body, wide: true, actions: ui.btn(tr('web|Open the website'), { href: '/stores/', cls: 'btn--ghost', ic: 'globe', attrs: { target: '_blank', rel: 'noopener' } }) });
  });

  router.post('/website/settings', R('manager'), (req, res) => {
    for (const [k, key] of [['stores_en', 'web_stores_intro_en'], ['stores_ar', 'web_stores_intro_ar'], ['events_en', 'web_events_intro_en'], ['events_ar', 'web_events_intro_ar']]) db.setSetting(key, h.str(req.body[k], 600));
    h.log(req, 'Changed the website settings', 'settings', null, null);
    h.back(req, res, '/admin/website?tab=settings', 'ok', tr('Saved.'));
  });

  // ---------- stores ----------
  function uniqueSlug(table, base, id = 0) {
    const root = base || `${table === 'web_stores' ? 'store' : 'event'}-${Date.now().toString(36)}`;
    let slug = root;
    for (let i = 2; db.get(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`, slug, id); i++) slug = `${root}-${i}`;
    return slug;
  }
  // a listing starts from the tenant file
  function createStore(brandId, { demo = 0, user = null } = {}) {
    const b = db.get('SELECT * FROM brands WHERE id = ?', brandId);
    if (!b) return null;
    const existing = db.get('SELECT id FROM web_stores WHERE brand_id = ?', b.id);
    if (existing) return existing.id;
    let fit = 0;
    try {
      fit = db.value("SELECT COUNT(*) FROM fitout_projects WHERE brand_id = ? AND stage != 'open'", b.id) || 0;
    } catch {
      fit = 0; // no fit-out module
    }
    const t = M.now();
    const id = Number(db.run(
      'INSERT INTO web_stores (brand_id, slug, name, category, opening_soon, demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      b.id, uniqueSlug('web_stores', slugify(b.name) || `store-${b.id}`), b.name, M.CATEGORIES[b.category] !== undefined ? b.category : 'other',
      fit || (b.opening_date && b.opening_date > T()) ? 1 : 0, demo ? 1 : 0, t, t,
    ).lastInsertRowid);
    db.audit(user, 'Created a website listing', 'web_store', id, b.name);
    return id;
  }
  h.website.createStore = createStore;

  router.post('/website/stores', R('agent'), (req, res) => {
    const brandId = h.int(req.body.brand_id);
    const hasLease = brandId && db.value("SELECT COUNT(*) FROM leases WHERE brand_id = ? AND status IN ('active','draft')", brandId);
    if (!hasLease) return h.back(req, res, '/admin/website', 'error', tr('web|Only tenants with a lease can be listed.'));
    const id = createStore(brandId, { user: req.user });
    if (!id) return h.back(req, res, '/admin/website', 'error', tr('That record no longer exists.'));
    h.back(req, res, `/admin/website/stores/${id}`, 'ok', tr('web|Listing created from the tenant file. Add the Arabic, a logo and a cover, then publish.'));
  });

  router.get('/website/stores/:id', (req, res, next) => {
    const s = storeOf(h.int(req.params.id));
    if (!s) return next();
    const csrf = req.session.csrf;
    const agent = h.can(req, 'agent');
    const v = publicStore(s);
    const st = stateOf(s);
    const units = v.units.map((u) => u.code).join(', ');
    const cover = imageOf(s.cover_id);
    const logo = imageOf(s.logo_id);
    const preview = `<div class="webprev">
      <div class="webprev__cover">${cover ? `<img src="/admin/website/img/${cover.id}" alt="">` : `<span class="webprev__pattern"></span>`}${s.opening_soon ? `<b class="webprev__tag">${ui.esc(tr('web|Opening soon'))}</b>` : ''}</div>
      <div class="webprev__body">${logo ? `<img class="webprev__logo" src="/admin/website/img/${logo.id}" alt="">` : `<span class="webprev__logo webprev__logo--none">${ui.esc(ui.initials(s.name))}</span>`}
        <div><b>${ui.esc(pick(s.name, s.name_ar))}</b><small>${ui.esc(M.CATEGORIES[s.category] || s.category)}${units ? ` · ${ui.esc(units)}` : ''}</small></div></div>
      ${s.tagline || s.tagline_ar ? `<p class="webprev__line">${ui.esc(pick(s.tagline, s.tagline_ar))}</p>` : ''}
    </div>`;
    const missing = [
      !s.name_ar && tr('web|Arabic name'), !s.description && tr('web|English description'), !s.description_ar && tr('web|Arabic description'), !s.logo_id && tr('web|Logo'), !s.cover_id && tr('web|Cover photo'),
    ].filter(Boolean);
    const publishBox = `<div class="webpub">${stateBadge(s)}
      ${st === 'live' ? pubLink(req, `/stores/${s.slug}/`) : ''}
      ${missing.length ? `<p class="muted small">${ui.esc(tr('web|Still to add: {list}', { list: missing.join(isAr() ? '، ' : ', ') }))}</p>` : `<p class="muted small">${ui.esc(tr('web|Everything a visitor needs is here.'))}</p>`}
      ${!s.active_lease ? `<p class="muted small">${ui.esc(tr('web|The listing can be prepared now and published when the lease is active.'))}</p>` : ''}
      ${agent ? `<div class="row">${s.published
    ? ui.form(`/admin/website/stores/${s.id}/publish`, csrf, `<input type="hidden" name="on" value="0">${ui.btn(tr('web|Unpublish'), { cls: 'btn--ghost btn--sm' })}`)
    : ui.form(`/admin/website/stores/${s.id}/publish`, csrf, `<input type="hidden" name="on" value="1">${ui.btn(tr('web|Publish'), { cls: 'btn--primary btn--sm', ic: 'globe', attrs: s.active_lease ? {} : { disabled: true } })}`)}</div>` : ''}
    </div>`;
    const hoursHint = s.b_hours ? tr('web|From the tenant file: {value}', { value: s.b_hours }) : tr('web|Leave empty to use the tenant file.');
    const form = ui.form(`/admin/website/stores/${s.id}`, csrf, `
      <fieldset><legend>${ui.esc(tr('web|Name and words'))}</legend><div class="fields fields--2">
        ${ui.input('name', tr('web|Name (English)'), s.name, { required: true })}
        ${arText('name_ar', tr('web|Name (Arabic)'), s.name_ar, { input: true })}
        ${ui.input('tagline', tr('web|Short line (English)'), s.tagline, { placeholder: tr('web|e.g. Parisian ready-to-wear, made for Cairo evenings') })}
        ${arText('tagline_ar', tr('web|Short line (Arabic)'), s.tagline_ar, { input: true })}
        ${ui.textarea('description', tr('web|Description (English)'), s.description || '', { rows: 6 })}
        ${arText('description_ar', tr('web|Description (Arabic)'), s.description_ar, { rows: 6 })}
      </div></fieldset>
      <fieldset><legend>${ui.esc(tr('web|Details'))}</legend><div class="fields">
        ${ui.select('category', tr('Category'), Object.keys(M.CATEGORIES).map((k) => [k, M.CATEGORIES[k]]), s.category)}
        ${ui.input('slug', tr('web|Web address'), s.slug, { required: true, hint: `${siteOf(req)}/stores/…`, attrs: { dir: 'ltr', pattern: '[a-z0-9-]+' } })}
        ${ui.input('hours', tr('web|Opening hours'), s.hours, { placeholder: s.b_hours || '10:00–24:00', hint: hoursHint, attrs: { dir: 'ltr' } })}
        ${ui.input('phone', tr('Phone'), s.phone, { type: 'tel', placeholder: s.b_phone || '', hint: s.b_phone ? tr('web|From the tenant file: {value}', { value: s.b_phone }) : '', attrs: { dir: 'ltr' } })}
        ${ui.input('instagram', tr('web|Instagram'), s.instagram, { placeholder: s.b_instagram || '@', attrs: { dir: 'ltr' } })}
        ${ui.input('website', tr('web|Website'), s.website, { placeholder: s.b_website || 'https://…', attrs: { dir: 'ltr' } })}
      </div>
      <div class="row">${check('opening_soon', tr('web|Show as opening soon'), s.opening_soon)}${check('featured', tr('web|Feature at the top of the directory'), s.featured)}</div></fieldset>
      ${agent ? ui.btn(tr('Save'), { cls: 'btn--primary' }) : ''}`, { cls: 'stack' });
    const imgCard = (slot, img, label, hint) => `<div class="webimg"><p class="grouphead">${ui.esc(label)}</p>${img ? `<div class="webimg__now">${thumb(img, slot === 'logo' ? 'webthumb--logo webthumb--lg' : 'webthumb--cover')}${agent ? ui.form(`/admin/website/stores/${s.id}/image/remove`, csrf, `<input type="hidden" name="slot" value="${slot}">${ui.btn(tr('Remove'), { cls: 'btn--ghost btn--xs' })}`) : ''}</div>` : ''}${agent ? uploader(`/admin/website/stores/${s.id}/image?slot=${slot}`, img ? tr('web|Replace') : hint) : ''}</div>`;
    const images = ui.card(tr('web|Images'), `${imgCard('logo', logo, tr('web|Logo'), tr('web|Drop the logo here (square works best)'))}${imgCard('cover', cover, tr('web|Cover photo'), tr('web|Drop a landscape photo of the store'))}`);
    const promos = db.all('SELECT * FROM web_promos WHERE brand_id = ? ORDER BY ends_on DESC', s.brand_id);
    const promoCard = ui.card(tr('web|Promotions'), promos.length ? `<ul class="list">${promos.map((p) => `<li><a href="/admin/website/promos/${p.id}"><span class="what"><b>${ui.esc(pick(p.title, p.title_ar))}</b><small>${ui.date(p.starts_on)} – ${ui.date(p.ends_on)}</small></span>${p.published ? ui.badge('live', tr('web|Published'), 'ok') : ui.badge('draft', tr('web|Draft'), 'mute')}</a></li>`).join('')}</ul>` : `<p class="muted pad">${ui.esc(tr('web|No promotions yet.'))}</p>`, { action: agent ? ui.btn(tr('web|New promotion'), { href: `/admin/website?tab=promos&brand=${s.brand_id}`, cls: 'btn--ghost btn--sm', ic: 'plus' }) : '' });
    const danger = h.can(req, 'manager') ? ui.form(`/admin/website/stores/${s.id}/delete`, csrf, ui.btn(tr('web|Delete listing'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('web|Delete this listing? It leaves the website at once.') } })) : '';
    const body = `<div class="grid grid--side">
      <div class="stack">${ui.card(tr('web|Listing'), form)}</div>
      <div class="stack">${ui.card(tr('web|On the website'), preview + publishBox, { action: ui.btn(tr('web|Tenant file'), { href: `/admin/tenants/${s.brand_id}`, cls: 'btn--ghost btn--sm' }) })}${images}${promoCard}${danger}</div>
    </div>`;
    h.page(req, res, { title: pick(s.name, s.name_ar), crumbs: [['/admin/website', tr('nav|Website')], [null, pick(s.name, s.name_ar)]], active: '/admin/website', body });
  });

  router.post('/website/stores/:id', R('agent'), (req, res, next) => {
    const s = storeOf(h.int(req.params.id));
    if (!s) return next();
    const b = req.body;
    const back = `/admin/website/stores/${s.id}`;
    const name = h.str(b.name, 120);
    if (!name) return h.back(req, res, back, 'error', tr('web|Enter the store name.'));
    const slug = slugify(b.slug) || slugify(name) || s.slug;
    if (db.get('SELECT id FROM web_stores WHERE slug = ? AND id != ?', slug, s.id)) return h.back(req, res, back, 'error', tr('web|Another store already uses that web address.'));
    const ig = cleanHandle(b.instagram);
    if (ig === null) return h.back(req, res, back, 'error', tr('web|Enter the Instagram handle, like @thewavemall.'));
    const site = cleanUrl(b.website);
    if (site === null) return h.back(req, res, back, 'error', tr('web|Enter a full website address.'));
    db.run(
      `UPDATE web_stores SET name = ?, name_ar = ?, tagline = ?, tagline_ar = ?, description = ?, description_ar = ?, category = ?, slug = ?, hours = ?, phone = ?,
        instagram = ?, website = ?, opening_soon = ?, featured = ?, updated_at = ? WHERE id = ?`,
      name, h.str(b.name_ar, 120) || null, h.str(b.tagline, 160) || null, h.str(b.tagline_ar, 160) || null, h.str(b.description, 3000) || null, h.str(b.description_ar, 3000) || null,
      M.CATEGORIES[b.category] !== undefined ? b.category : s.category, slug, h.str(b.hours, 80) || null, h.str(b.phone, 40) || null, ig || null, site || null,
      b.opening_soon ? 1 : 0, b.featured ? 1 : 0, M.now(), s.id,
    );
    h.log(req, 'Updated a website listing', 'web_store', s.id, name);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });

  router.post('/website/stores/:id/publish', R('agent'), (req, res, next) => {
    const s = storeOf(h.int(req.params.id));
    if (!s) return next();
    const back = `/admin/website/stores/${s.id}`;
    const on = req.body.on === '1';
    if (on && !s.active_lease) return h.back(req, res, back, 'error', tr('web|Only tenants with an active lease can be published.'));
    db.run('UPDATE web_stores SET published = ?, published_at = CASE WHEN ? = 1 THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?', on ? 1 : 0, on ? 1 : 0, M.now(), M.now(), s.id);
    h.log(req, on ? 'Published a store on the website' : 'Took a store off the website', 'web_store', s.id, s.name);
    h.events.emit('website.store', { store: storeOf(s.id), published: on });
    h.back(req, res, back, 'ok', tr(on ? 'web|{name} is live on the website.' : 'web|{name} is off the website.', { name: s.name }));
  });

  router.post('/website/stores/:id/delete', R('manager'), (req, res, next) => {
    const s = storeOf(h.int(req.params.id));
    if (!s) return next();
    db.run('DELETE FROM web_stores WHERE id = ?', s.id);
    releaseImage(s.logo_id);
    releaseImage(s.cover_id);
    h.log(req, 'Deleted a website listing', 'web_store', s.id, s.name);
    h.back(req, res, '/admin/website', 'ok', tr('web|Listing deleted.'));
  });

  // Images: the body is the file (admin.js's uploader); raster only.
  const raw = express.raw({ type: () => true, limit: MAX_IMAGE + 1024 });
  function receive(req) {
    const name = h.str(decodeURIComponent(String(req.get('x-file-name') || '')), 160);
    const saved = saveImage(Buffer.isBuffer(req.body) ? req.body : null, name);
    if (saved.error === 'empty') return { status: 422, error: tr('Choose a file to upload.') };
    if (saved.error === 'too_big') return { status: 413, error: tr('web|That image is larger than 8 MB.') };
    if (saved.error) return { status: 415, error: tr('web|Upload a JPG, PNG or WebP image.') };
    return saved;
  }
  const attachImage = (table, column, id, img, req, label) => {
    const before = db.value(`SELECT ${column} FROM ${table} WHERE id = ?`, id);
    db.run(`UPDATE ${table} SET ${column} = ?, updated_at = ? WHERE id = ?`, img.id, M.now(), id);
    releaseImage(before);
    h.log(req, 'Changed a website image', table === 'web_stores' ? 'web_store' : table === 'web_events' ? 'web_event' : 'web_promo', id, label);
  };
  router.post('/website/stores/:id/image', R('agent'), raw, (req, res) => {
    const s = storeOf(h.int(req.params.id));
    if (!s) return res.status(404).json({ ok: false, error: tr('That record no longer exists.') });
    const out = receive(req);
    if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
    attachImage('web_stores', req.query.slot === 'logo' ? 'logo_id' : 'cover_id', s.id, out, req, s.name);
    res.json({ ok: true, id: out.id });
  });
  router.post('/website/stores/:id/image/remove', R('agent'), (req, res, next) => {
    const s = storeOf(h.int(req.params.id));
    if (!s) return next();
    const col = req.body.slot === 'logo' ? 'logo_id' : 'cover_id';
    db.run(`UPDATE web_stores SET ${col} = NULL, updated_at = ? WHERE id = ?`, M.now(), s.id);
    releaseImage(s[col]);
    h.back(req, res, `/admin/website/stores/${s.id}`, 'ok', tr('web|Image removed.'));
  });

  // ---------- events ----------
  router.post('/website/events', R('agent'), (req, res) => {
    const title = h.str(req.body.title, 160);
    const on = isDate(req.body.starts_on) ? req.body.starts_on : null;
    if (!title || !on) return h.back(req, res, '/admin/website?tab=events', 'error', tr('web|Enter a title and a date.'));
    const t = M.now();
    const id = Number(db.run('INSERT INTO web_events (slug, title, starts_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', uniqueSlug('web_events', slugify(title)), title, on, t, t).lastInsertRowid);
    h.log(req, 'Created a website event', 'web_event', id, title);
    h.back(req, res, `/admin/website/events/${id}`, 'ok', tr('web|Event created. Add the details, then publish.'));
  });
  router.get('/website/events/:id', (req, res, next) => {
    const e = db.get('SELECT * FROM web_events WHERE id = ?', h.int(req.params.id));
    if (!e) return next();
    const csrf = req.session.csrf;
    const agent = h.can(req, 'agent');
    const cover = imageOf(e.cover_id);
    const form = ui.form(`/admin/website/events/${e.id}`, csrf, `
      <fieldset><legend>${ui.esc(tr('web|Name and words'))}</legend><div class="fields fields--2">
        ${ui.input('title', tr('web|Title (English)'), e.title, { required: true })}
        ${arText('title_ar', tr('web|Title (Arabic)'), e.title_ar, { input: true })}
        ${ui.input('summary', tr('web|Short line (English)'), e.summary, {})}
        ${arText('summary_ar', tr('web|Short line (Arabic)'), e.summary_ar, { input: true })}
        ${ui.textarea('description', tr('web|Description (English)'), e.description || '', { rows: 6 })}
        ${arText('description_ar', tr('web|Description (Arabic)'), e.description_ar, { rows: 6 })}
      </div></fieldset>
      <fieldset><legend>${ui.esc(tr('web|When and where'))}</legend><div class="fields">
        ${ui.input('starts_on', tr('web|First day'), e.starts_on, { type: 'date', required: true })}
        ${ui.input('ends_on', tr('web|Last day'), e.ends_on, { type: 'date' })}
        ${ui.input('time_from', tr('web|From'), e.time_from, { type: 'time' })}
        ${ui.input('time_to', tr('web|Until'), e.time_to, { type: 'time' })}
        ${ui.input('location', tr('web|Place (English)'), e.location, { placeholder: tr('web|e.g. The open court') })}
        ${arText('location_ar', tr('web|Place (Arabic)'), e.location_ar, { input: true })}
        ${ui.input('rsvp_url', tr('web|Booking link'), e.rsvp_url, { placeholder: 'https://…', hint: tr('web|Optional: where visitors reserve a place.'), attrs: { dir: 'ltr' } })}
        ${ui.input('slug', tr('web|Web address'), e.slug, { required: true, attrs: { dir: 'ltr', pattern: '[a-z0-9-]+' } })}
      </div>
      <div class="row">${check('featured', tr('web|Feature on the directory page'), e.featured)}</div></fieldset>
      ${agent ? ui.btn(tr('Save'), { cls: 'btn--primary' }) : ''}`, { cls: 'stack' });
    const pub = `<div class="webpub">${e.published ? ui.badge('live', tr('web|Published'), 'ok') : ui.badge('draft', tr('web|Draft'), 'mute')}
      ${e.published ? pubLink(req, `/events/${e.slug}/`) : ''}
      ${agent ? `<div class="row">${ui.form(`/admin/website/events/${e.id}/publish`, csrf, `<input type="hidden" name="on" value="${e.published ? 0 : 1}">${ui.btn(tr(e.published ? 'web|Unpublish' : 'web|Publish'), { cls: e.published ? 'btn--ghost btn--sm' : 'btn--primary btn--sm', ic: e.published ? '' : 'globe' })}`)}</div>` : ''}</div>`;
    const images = `<div class="webimg">${cover ? `<div class="webimg__now">${thumb(cover, 'webthumb--cover')}${agent ? ui.form(`/admin/website/events/${e.id}/image/remove`, csrf, ui.btn(tr('Remove'), { cls: 'btn--ghost btn--xs' })) : ''}</div>` : ''}${agent ? uploader(`/admin/website/events/${e.id}/image?x=1`, cover ? tr('web|Replace') : tr('web|Drop the event poster or a photo')) : ''}</div>`;
    const danger = h.can(req, 'manager') ? ui.form(`/admin/website/events/${e.id}/delete`, csrf, ui.btn(tr('web|Delete event'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('web|Delete this event?') } })) : '';
    const body = `<div class="grid grid--side"><div class="stack">${ui.card(tr('web|Event'), form)}</div><div class="stack">${ui.card(tr('web|On the website'), pub)}${ui.card(tr('web|Cover'), images)}${danger}</div></div>`;
    h.page(req, res, { title: pick(e.title, e.title_ar), crumbs: [['/admin/website?tab=events', tr('web|Events')], [null, pick(e.title, e.title_ar)]], active: '/admin/website', body });
  });
  router.post('/website/events/:id', R('agent'), (req, res, next) => {
    const e = db.get('SELECT * FROM web_events WHERE id = ?', h.int(req.params.id));
    if (!e) return next();
    const b = req.body;
    const back = `/admin/website/events/${e.id}`;
    const title = h.str(b.title, 160);
    if (!title || !isDate(b.starts_on)) return h.back(req, res, back, 'error', tr('web|Enter a title and a date.'));
    if (b.ends_on && (!isDate(b.ends_on) || b.ends_on < b.starts_on)) return h.back(req, res, back, 'error', tr('web|The last day cannot be before the first.'));
    const rsvp = cleanUrl(b.rsvp_url);
    if (rsvp === null) return h.back(req, res, back, 'error', tr('web|Enter a full website address.'));
    const slug = slugify(b.slug) || slugify(title) || e.slug;
    if (db.get('SELECT id FROM web_events WHERE slug = ? AND id != ?', slug, e.id)) return h.back(req, res, back, 'error', tr('web|Another event already uses that web address.'));
    db.run(
      `UPDATE web_events SET title = ?, title_ar = ?, summary = ?, summary_ar = ?, description = ?, description_ar = ?, starts_on = ?, ends_on = ?, time_from = ?, time_to = ?,
        location = ?, location_ar = ?, rsvp_url = ?, slug = ?, featured = ?, updated_at = ? WHERE id = ?`,
      title, h.str(b.title_ar, 160) || null, h.str(b.summary, 240) || null, h.str(b.summary_ar, 240) || null, h.str(b.description, 4000) || null, h.str(b.description_ar, 4000) || null,
      b.starts_on, isDate(b.ends_on) ? b.ends_on : null, isTime(b.time_from) ? b.time_from : null, isTime(b.time_to) ? b.time_to : null,
      h.str(b.location, 120) || null, h.str(b.location_ar, 120) || null, rsvp || null, slug, b.featured ? 1 : 0, M.now(), e.id,
    );
    h.log(req, 'Updated a website event', 'web_event', e.id, title);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });
  router.post('/website/events/:id/publish', R('agent'), (req, res, next) => {
    const e = db.get('SELECT * FROM web_events WHERE id = ?', h.int(req.params.id));
    if (!e) return next();
    const on = req.body.on === '1';
    db.run('UPDATE web_events SET published = ?, published_at = CASE WHEN ? = 1 THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?', on ? 1 : 0, on ? 1 : 0, M.now(), M.now(), e.id);
    h.log(req, on ? 'Published an event on the website' : 'Took an event off the website', 'web_event', e.id, e.title);
    h.back(req, res, `/admin/website/events/${e.id}`, 'ok', tr(on ? 'web|Published.' : 'web|Unpublished.'));
  });
  router.post('/website/events/:id/delete', R('manager'), (req, res, next) => {
    const e = db.get('SELECT * FROM web_events WHERE id = ?', h.int(req.params.id));
    if (!e) return next();
    db.run('DELETE FROM web_events WHERE id = ?', e.id);
    releaseImage(e.cover_id);
    h.log(req, 'Deleted a website event', 'web_event', e.id, e.title);
    h.back(req, res, '/admin/website?tab=events', 'ok', tr('web|Event deleted.'));
  });
  router.post('/website/events/:id/image', R('agent'), raw, (req, res) => {
    const e = db.get('SELECT * FROM web_events WHERE id = ?', h.int(req.params.id));
    if (!e) return res.status(404).json({ ok: false, error: tr('That record no longer exists.') });
    const out = receive(req);
    if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
    attachImage('web_events', 'cover_id', e.id, out, req, e.title);
    res.json({ ok: true, id: out.id });
  });
  router.post('/website/events/:id/image/remove', R('agent'), (req, res, next) => {
    const e = db.get('SELECT * FROM web_events WHERE id = ?', h.int(req.params.id));
    if (!e) return next();
    db.run('UPDATE web_events SET cover_id = NULL, updated_at = ? WHERE id = ?', M.now(), e.id);
    releaseImage(e.cover_id);
    h.back(req, res, `/admin/website/events/${e.id}`, 'ok', tr('web|Image removed.'));
  });

  // ---------- promotions ----------
  router.post('/website/promos', R('agent'), (req, res) => {
    const title = h.str(req.body.title, 160);
    const from = isDate(req.body.starts_on) ? req.body.starts_on : null;
    const to = isDate(req.body.ends_on) ? req.body.ends_on : null;
    const brandId = h.int(req.body.brand_id);
    if (!title || !from || !to || to < from) return h.back(req, res, h.safeBack(req, '/admin/website?tab=promos'), 'error', tr('web|Enter a title and valid dates.'));
    if (brandId && !db.get('SELECT id FROM brands WHERE id = ?', brandId)) return h.back(req, res, '/admin/website?tab=promos', 'error', tr('That record no longer exists.'));
    const t = M.now();
    const id = Number(db.run('INSERT INTO web_promos (brand_id, title, starts_on, ends_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', brandId || null, title, from, to, t, t).lastInsertRowid);
    h.log(req, 'Created a website promotion', 'web_promo', id, title);
    h.back(req, res, `/admin/website/promos/${id}`, 'ok', tr('web|Promotion created. Add the details, then publish.'));
  });
  router.get('/website/promos/:id', (req, res, next) => {
    const p = db.get('SELECT p.*, b.name brand_name FROM web_promos p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = ?', h.int(req.params.id));
    if (!p) return next();
    const csrf = req.session.csrf;
    const agent = h.can(req, 'agent');
    const img = imageOf(p.image_id);
    const brands = db.all("SELECT DISTINCT b.id, b.name FROM brands b JOIN leases l ON l.brand_id = b.id AND l.status IN ('active','draft') ORDER BY b.name");
    if (p.brand_id && !brands.some((b) => b.id === p.brand_id)) brands.push({ id: p.brand_id, name: p.brand_name });
    const form = ui.form(`/admin/website/promos/${p.id}`, csrf, `<div class="fields fields--2">
        ${ui.input('title', tr('web|Title (English)'), p.title, { required: true })}
        ${arText('title_ar', tr('web|Title (Arabic)'), p.title_ar, { input: true })}
        ${ui.textarea('details', tr('web|Details (English)'), p.details || '', { rows: 4 })}
        ${arText('details_ar', tr('web|Details (Arabic)'), p.details_ar, { rows: 4 })}
      </div><div class="fields">
        ${ui.select('brand_id', tr('web|Store'), brands.map((b) => [b.id, b.name]), p.brand_id || '', { blank: tr('web|The Wave (mall-wide)') })}
        ${ui.input('starts_on', tr('web|From'), p.starts_on, { type: 'date', required: true })}
        ${ui.input('ends_on', tr('web|Until'), p.ends_on, { type: 'date', required: true })}
        ${ui.input('link', tr('web|Link'), p.link, { placeholder: 'https://…', hint: tr('web|Optional: the offer on the brand\'s own site.'), attrs: { dir: 'ltr' } })}
      </div>${agent ? ui.btn(tr('Save'), { cls: 'btn--primary' }) : ''}`, { cls: 'stack' });
    const pub = `<div class="webpub">${p.published ? ui.badge('live', tr('web|Published'), 'ok') : ui.badge('draft', tr('web|Draft'), 'mute')}
      ${agent ? `<div class="row">${ui.form(`/admin/website/promos/${p.id}/publish`, csrf, `<input type="hidden" name="on" value="${p.published ? 0 : 1}">${ui.btn(tr(p.published ? 'web|Unpublish' : 'web|Publish'), { cls: p.published ? 'btn--ghost btn--sm' : 'btn--primary btn--sm', ic: p.published ? '' : 'globe' })}`)}</div>` : ''}
      <p class="muted small">${ui.esc(tr('web|Shown on the directory and on the store\'s page while it runs, and up to two weeks before.'))}</p></div>`;
    const images = `<div class="webimg">${img ? `<div class="webimg__now">${thumb(img, 'webthumb--cover')}${agent ? ui.form(`/admin/website/promos/${p.id}/image/remove`, csrf, ui.btn(tr('Remove'), { cls: 'btn--ghost btn--xs' })) : ''}</div>` : ''}${agent ? uploader(`/admin/website/promos/${p.id}/image?x=1`, img ? tr('web|Replace') : tr('web|Drop the offer visual')) : ''}</div>`;
    const danger = h.can(req, 'manager') ? ui.form(`/admin/website/promos/${p.id}/delete`, csrf, ui.btn(tr('web|Delete promotion'), { cls: 'btn--danger btn--sm', attrs: { 'data-confirm': tr('web|Delete this promotion?') } })) : '';
    const body = `<div class="grid grid--side"><div class="stack">${ui.card(tr('web|Promotion'), form)}</div><div class="stack">${ui.card(tr('web|On the website'), pub)}${ui.card(tr('web|Image'), images)}${danger}</div></div>`;
    h.page(req, res, { title: pick(p.title, p.title_ar), crumbs: [['/admin/website?tab=promos', tr('web|Promotions')], [null, pick(p.title, p.title_ar)]], active: '/admin/website', body });
  });
  router.post('/website/promos/:id', R('agent'), (req, res, next) => {
    const p = db.get('SELECT * FROM web_promos WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    const b = req.body;
    const back = `/admin/website/promos/${p.id}`;
    const title = h.str(b.title, 160);
    if (!title || !isDate(b.starts_on) || !isDate(b.ends_on) || b.ends_on < b.starts_on) return h.back(req, res, back, 'error', tr('web|Enter a title and valid dates.'));
    const link = cleanUrl(b.link);
    if (link === null) return h.back(req, res, back, 'error', tr('web|Enter a full website address.'));
    const brandId = h.int(b.brand_id);
    db.run('UPDATE web_promos SET title = ?, title_ar = ?, details = ?, details_ar = ?, brand_id = ?, starts_on = ?, ends_on = ?, link = ?, updated_at = ? WHERE id = ?',
      title, h.str(b.title_ar, 160) || null, h.str(b.details, 1000) || null, h.str(b.details_ar, 1000) || null, brandId && db.get('SELECT id FROM brands WHERE id = ?', brandId) ? brandId : null,
      b.starts_on, b.ends_on, link || null, M.now(), p.id);
    h.log(req, 'Updated a website promotion', 'web_promo', p.id, title);
    h.back(req, res, back, 'ok', tr('Saved.'));
  });
  router.post('/website/promos/:id/publish', R('agent'), (req, res, next) => {
    const p = db.get('SELECT * FROM web_promos WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    const on = req.body.on === '1';
    db.run('UPDATE web_promos SET published = ?, updated_at = ? WHERE id = ?', on ? 1 : 0, M.now(), p.id);
    h.log(req, on ? 'Published a promotion on the website' : 'Took a promotion off the website', 'web_promo', p.id, p.title);
    h.back(req, res, `/admin/website/promos/${p.id}`, 'ok', tr(on ? 'web|Published.' : 'web|Unpublished.'));
  });
  router.post('/website/promos/:id/delete', R('manager'), (req, res, next) => {
    const p = db.get('SELECT * FROM web_promos WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    db.run('DELETE FROM web_promos WHERE id = ?', p.id);
    releaseImage(p.image_id);
    h.log(req, 'Deleted a website promotion', 'web_promo', p.id, p.title);
    h.back(req, res, '/admin/website?tab=promos', 'ok', tr('web|Promotion deleted.'));
  });
  router.post('/website/promos/:id/image', R('agent'), raw, (req, res) => {
    const p = db.get('SELECT * FROM web_promos WHERE id = ?', h.int(req.params.id));
    if (!p) return res.status(404).json({ ok: false, error: tr('That record no longer exists.') });
    const out = receive(req);
    if (out.error) return res.status(out.status).json({ ok: false, error: out.error });
    attachImage('web_promos', 'image_id', p.id, out, req, p.title);
    res.json({ ok: true, id: out.id });
  });
  router.post('/website/promos/:id/image/remove', R('agent'), (req, res, next) => {
    const p = db.get('SELECT * FROM web_promos WHERE id = ?', h.int(req.params.id));
    if (!p) return next();
    db.run('UPDATE web_promos SET image_id = NULL, updated_at = ? WHERE id = ?', M.now(), p.id);
    releaseImage(p.image_id);
    h.back(req, res, `/admin/website/promos/${p.id}`, 'ok', tr('web|Image removed.'));
  });
};

module.exports.slugify = slugify;
module.exports.cleanHandle = cleanHandle;
module.exports.cleanUrl = cleanUrl;
