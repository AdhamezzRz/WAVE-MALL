'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { content } = require('./content');
const LOGO = require('./logo-paths.json');

const PUBLIC = path.join(__dirname, '..', 'public');

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const version = (file) => crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, file))).digest('hex').slice(0, 8);
const ASSET_V = { css: version('css/site.css'), js: version('js/site.js') };

const widthsCache = new Map();
function widths(name) {
  if (!widthsCache.has(name)) {
    const found = fs
      .readdirSync(path.join(PUBLIC, 'img'))
      .map((f) => f.match(new RegExp(`^${name}-(\\d+)\\.webp$`)))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    widthsCache.set(name, found);
  }
  return widthsCache.get(name);
}
const srcset = (name) => widths(name).map((w) => `/img/${name}-${w}.webp ${w}w`).join(', ');
const imgUrl = (name) => `/img/${name}-${widths(name).at(-1)}.webp`;

function picture(name, alt, { sizes = '100vw', eager = false, cls = '', portrait } = {}) {
  const ws = widths(name);
  const fallback = ws[Math.min(1, ws.length - 1)];
  const source = portrait ? `<source media="(orientation: portrait)" srcset="${srcset(portrait)}" sizes="${sizes}">` : '';
  return `<picture>${source}<img class="${cls}" src="/img/${name}-${fallback}.webp" srcset="${srcset(name)}" sizes="${sizes}" alt="${esc(alt)}" ${
    eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"'
  }></picture>`;
}

const LOGO_VB = '0 0 490 225.2';
function logoSvg({ cls = '', outline = false, label = 'The Wave' } = {}) {
  const letters = ['T', 'H', 'E2', 'W', 'AV', 'E'].map((k) => `<path class="l l-${k.toLowerCase()}" d="${LOGO[k]}"/>`).join('');
  const draw = outline ? `<path class="l-draw" pathLength="1" fill="none" stroke="currentColor" stroke-width="1" d="${LOGO.AV}"/>` : '';
  return `<svg class="logo ${cls}" viewBox="${LOGO_VB}" role="img" aria-label="${esc(label)}" fill="currentColor"><g class="logo__fill">${letters}</g>${draw}</svg>`;
}
const ligature = (cls = '') => `<svg class="${cls}" viewBox="163 97 207 128" aria-hidden="true"><path fill="currentColor" d="${LOGO.AV}"/></svg>`;

const arrow = '<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const link = (href, label, cls = '', attrs = '') => `<a class="link ${cls}" href="${href}" ${attrs}><span>${esc(label)}</span>${arrow}</a>`;

const fmtDate = (iso, lang) => new Date(iso + 'T00:00:00Z').toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function hero(h, img, alt, { portrait, meta } = {}) {
  return `
<section class="hero" data-hero>
  <div class="hero__media">${picture(img, alt, { eager: true, portrait })}</div>
  <div class="hero__fade"></div>
  <div class="col hero__text">
    <h1 class="h-hero" data-hero-title><span>${esc(h.a)}</span> <em>${esc(h.b)}</em></h1>
    ${meta ? `<p class="hero__meta" data-hero-meta>${meta.map(esc).join('<i>·</i>')}</p>` : ''}
  </div>
</section>`;
}

const plainHero = (h, intro, extra = '') => `
<section class="plain">
  <div class="col">
    ${extra}
    <h1 class="h1" data-r><span>${esc(h.a)}</span> <em>${esc(h.b)}</em></h1>
    ${intro ? `<p class="lead" data-r>${esc(intro)}</p>` : ''}
  </div>
</section>`;

function markSection(c, m, { more } = {}) {
  return `
<section class="mark" data-mark>
  <div class="col mark__col">
    <button class="mark__logo" type="button" aria-label="${esc(m.hint)}" data-mark-toggle>${logoSvg({ outline: true })}</button>
    <p class="lead mark__text" data-r>${esc(m.text)}</p>
    <p class="cap mark__hint" data-r>${esc(m.hint)}</p>
    ${more ? link(more.href, more.label) : ''}
  </div>
</section>`;
}

// Breadcrumbs: visible trail plus the matching schema.
function crumbs(items) {
  const html = `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items
    .map(([href, label], i) => (i === items.length - 1 ? `<li aria-current="page">${esc(label)}</li>` : `<li><a href="${href}">${esc(label)}</a></li>`))
    .join('')}</ol></nav>`;
  return html;
}
const crumbsLd = (items, base) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([href, name], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${base}${href}` })),
});

function newsletter(c, { compact = false } = {}) {
  const n = c.footer.newsletter;
  return `
<form class="news ${compact ? 'news--compact' : ''}" method="post" action="/api/subscribe" novalidate data-form="subscribe" data-ok="${esc(n.ok)}" data-fail="${esc(n.fail)}" data-sending="…">
  <input type="hidden" name="lang" value="${c.lang}">
  <p class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
  ${compact ? '' : `<p class="news__title">${esc(n.title)}</p><p class="news__text">${esc(n.text)}</p>`}
  <div class="news__row">
    <label class="sr" for="news-${compact ? 'c' : 'f'}">${esc(n.placeholder)}</label>
    <input id="news-${compact ? 'c' : 'f'}" type="email" name="email" required placeholder="${esc(n.placeholder)}" autocomplete="email" dir="ltr">
    <button type="submit"><span>${esc(n.button)}</span>${arrow}</button>
  </div>
  <p class="status" role="status" data-form-status hidden></p>
</form>`;
}

function header(c, pathname) {
  const home = c.lang === 'en' ? '/' : '/ar/';
  const other = c.lang === 'en' ? `/ar${pathname === '/' ? '/' : pathname}` : pathname.replace(/^\/ar/, '') || '/';
  const isCurrent = (href) => (href === home ? pathname === home : pathname.startsWith(href));
  const main = c.nav.slice(1, -1);
  const contact = c.nav[c.nav.length - 1];
  const navLink = ([href, label]) => `<a href="${href}" ${isCurrent(href) ? 'aria-current="page"' : ''}>${esc(label)}</a>`;
  return `
<header class="top" data-top>
  <a class="top__brand" href="${home}" aria-label="${esc(c.brand)}">${logoSvg()}</a>
  <nav class="top__nav" aria-label="Main">${main.map(navLink).join('')}</nav>
  <div class="top__right">
    <a class="top__contact" href="${contact[0]}" ${isCurrent(contact[0]) ? 'aria-current="page"' : ''}>${esc(contact[1])}</a>
    <a class="top__lang" href="${other}" hreflang="${c.otherLang}" lang="${c.otherLang}" data-full-nav>${esc(c.otherLabel)}</a>
    <button class="top__menu" type="button" aria-expanded="false" aria-controls="menu" data-menu-toggle><span data-open="${esc(c.menu.open)}" data-close="${esc(c.menu.close)}">${esc(c.menu.open)}</span><i aria-hidden="true"><b></b><b></b></i></button>
  </div>
</header>
<div class="menu" id="menu" data-menu aria-hidden="true">
  <div class="col menu__inner">
    <nav class="menu__nav" aria-label="${esc(c.menu.open)}">${c.nav.map(([href, label]) => `<a href="${href}" ${isCurrent(href) ? 'aria-current="page"' : ''}><span>${esc(label)}</span></a>`).join('')}</nav>
    <div class="menu__side">
      <p class="cap">${esc(c.menu.contact)}</p>
      <a href="mailto:${c.footer.email}">${esc(c.footer.email)}</a>
      <p>${esc(c.footer.address)}</p>
      <p class="cap">${esc(c.menu.follow)}</p>
      <a href="https://www.instagram.com/thewavemall" target="_blank" rel="noopener">${esc(c.footer.instagram)}</a>
      <p class="cap">${esc(c.menu.language)}</p>
      <a href="${other}" hreflang="${c.otherLang}" lang="${c.otherLang}" data-full-nav>${esc(c.otherLabel)}</a>
    </div>
  </div>
</div>`;
}

function footer(c) {
  const f = c.footer;
  const home = c.lang === 'en' ? '/' : '/ar/';
  return `
<footer class="foot">
  <div class="col">
    <div class="foot__grid">
      <div class="foot__brand">
        <a href="${home}" aria-label="${esc(c.brand)}">${logoSvg({ cls: 'foot__logo' })}</a>
        <p class="foot__line">${esc(f.line)}</p>
        <p class="foot__about">${esc(f.about)}</p>
      </div>
      <div class="foot__col">
        <p class="cap">${esc(f.explore)}</p>
        ${c.nav.slice(1).map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}
      </div>
      <div class="foot__col">
        <p class="cap">${esc(f.visit)}</p>
        <p>${esc(f.address)}</p>
        <p>${esc(f.hours)}</p>
        <a href="mailto:${f.email}">${esc(f.email)}</a>
      </div>
      <div class="foot__col foot__col--news">
        <p class="cap">${esc(f.follow)}</p>
        <a href="https://www.instagram.com/thewavemall" target="_blank" rel="noopener">${esc(f.instagram)}</a>
        ${newsletter(c)}
      </div>
    </div>
    <div class="foot__mark" aria-hidden="true">${logoSvg()}</div>
    <div class="foot__legal">
      <p>© ${new Date().getFullYear()} ${esc(f.rights)} ${f.legal.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}</p>
      <p>${esc(f.note)}</p>
      <button type="button" data-top-btn>${esc(f.top)}${arrow}</button>
    </div>
  </div>
</footer>`;
}

function layout({ lang, pathname, title, description, body, siteUrl, nonce, image = 'aerial', loader = true, thread = true, seo = {} }) {
  const c = content[lang];
  const base = (siteUrl || '').replace(/\/$/, '');
  const enPath = lang === 'en' ? pathname : pathname.replace(/^\/ar/, '') || '/';
  const arPath = lang === 'ar' ? pathname : `/ar${pathname === '/' ? '/' : pathname}`;
  const ogImage = seo.image ? `${base}${imgUrl(seo.image)}` : `${base}/img/og-image.jpg`;
  const org = {
    '@type': 'ShoppingCenter',
    '@id': `${base}/#org`,
    name: 'The Wave',
    alternateName: ['The Wave New Cairo Mall', 'ذا ويف'],
    slogan: 'More than a destination.',
    url: `${base}/`,
    logo: `${base}/img/logo.svg`,
    image: `${base}/img/og-image.jpg`,
    email: c.footer.email,
    sameAs: ['https://www.instagram.com/thewavemall'],
    address: { '@type': 'PostalAddress', streetAddress: 'North 90 Street, First Sector', addressLocality: 'New Cairo', addressRegion: 'Cairo Governorate', addressCountry: 'EG' },
    geo: { '@type': 'GeoCoordinates', latitude: 30.0194714, longitude: 31.4319505 },
  };
  const site = { '@type': 'WebSite', '@id': `${base}/#site`, url: `${base}/`, name: 'The Wave', inLanguage: lang, publisher: { '@id': `${base}/#org` } };
  const graph = [org, site, ...(seo.jsonld || [])];
  const feed = `${lang === 'en' ? '' : '/ar'}/journal/feed.xml`;
  return `<!doctype html>
<html lang="${c.lang}" dir="${c.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${seo.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}">
<meta name="theme-color" content="#ede7da">
<link rel="canonical" href="${base}${pathname}">
<link rel="alternate" hreflang="en" href="${base}${enPath}">
<link rel="alternate" hreflang="ar" href="${base}${arPath}">
<link rel="alternate" hreflang="x-default" href="${base}${enPath}">
<link rel="alternate" type="application/rss+xml" title="${esc(c.journal.title)}" href="${base}${feed}">
<meta property="og:type" content="${seo.type || 'website'}">
<meta property="og:site_name" content="The Wave">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${base}${pathname}">
<meta property="og:image" content="${ogImage}">
<meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'ar_EG'}">
<meta property="og:locale:alternate" content="${lang === 'en' ? 'ar_EG' : 'en_US'}">
${seo.published ? `<meta property="article:published_time" content="${seo.published}">` : ''}
${seo.modified ? `<meta property="article:modified_time" content="${seo.modified}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ogImage}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/BodoniModa-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/BodoniModa-italic.woff2" as="font" type="font/woff2" crossorigin>
${image ? `<link rel="preload" as="image" href="/img/${image}-1280.webp" imagesrcset="${srcset(image)}" imagesizes="100vw">` : ''}
<link rel="stylesheet" href="/css/site.css?v=${ASSET_V.css}">
<script nonce="${nonce}">document.documentElement.classList.add('js');</script>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script>
</head>
<body>
<a class="skip" href="#main">${esc(c.skip)}</a>
${loader ? `<div class="veil" data-veil aria-hidden="true">${ligature('veil__mark')}</div>` : ''}
${header(c, pathname)}
<main id="main" class="page" data-page="${pathname}">
${thread ? '<svg class="thread" data-thread aria-hidden="true"><path pathLength="1" fill="none" stroke="currentColor" stroke-width="1"/></svg>' : ''}
${body}
</main>
${footer(c)}
<script src="/js/vendor/gsap.min.js" defer></script>
<script src="/js/vendor/ScrollTrigger.min.js" defer></script>
<script src="/js/vendor/lenis.min.js" defer></script>
<script src="/js/site.js?v=${ASSET_V.js}" defer></script>
</body>
</html>`;
}

module.exports = { esc, picture, imgUrl, logoSvg, ligature, link, arrow, hero, plainHero, markSection, crumbs, crumbsLd, newsletter, fmtDate, layout, LOGO };
