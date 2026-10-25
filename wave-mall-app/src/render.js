'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { content } = require('./content');
const { FLOORS } = require('./data');
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

function picture(name, alt, { sizes = '100vw', eager = false, cls = '' } = {}) {
  const ws = widths(name);
  const fallback = ws[Math.min(1, ws.length - 1)];
  return `<img class="${cls}" src="/img/${name}-${fallback}.webp" srcset="${srcset(name)}" sizes="${sizes}" alt="${esc(alt)}" ${
    eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"'
  }>`;
}

// Image in a frame that wipes open on scroll.
const frame = (name, alt, { sizes, cls = '', cap = '' } = {}) =>
  `<figure class="frame ${cls}" data-wipe><div class="frame__clip">${picture(name, alt, { sizes })}</div>${cap ? `<figcaption class="label">${esc(cap)}</figcaption>` : ''}</figure>`;

const LOGO_VB = '0 0 490 225.2';
function logoSvg({ cls = '', outline = false, label = 'The Wave' } = {}) {
  const letters = ['T', 'H', 'E2', 'W', 'AV', 'E'].map((k) => `<path class="l l-${k.toLowerCase()}" d="${LOGO[k]}"/>`).join('');
  const draw = outline ? `<path class="l-draw" pathLength="1" fill="none" stroke="currentColor" stroke-width="1" d="${LOGO.AV}"/>` : '';
  return `<svg class="logo ${cls}" viewBox="${LOGO_VB}" role="img" aria-label="${esc(label)}" fill="currentColor"><g class="logo__fill">${letters}</g>${draw}</svg>`;
}

const arrow = '<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const link = (href, label, cls = '', attrs = '') => `<a class="link ${cls}" href="${href}" ${attrs}><span>${esc(label)}</span>${arrow}</a>`;
const label = (t, cls = '') => `<p class="label ${cls}" data-rise>${esc(t)}</p>`;
const fmtDate = (iso, lang) => new Date(iso + 'T00:00:00Z').toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const num = (n, lang) => Number(n).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-US');

// A two-part serif title: plain then italic.
const title = (a, b, tag = 'h2', cls = '') => `<${tag} class="title ${cls}" data-rise>${esc(a)}${b ? ` <em>${esc(b)}</em>` : ''}</${tag}>`;

function crumbs(items) {
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items
    .map(([href, l], i) => (i === items.length - 1 ? `<li aria-current="page">${esc(l)}</li>` : `<li><a href="${href}">${esc(l)}</a></li>`))
    .join('')}</ol></nav>`;
}
const crumbsLd = (items, base) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([href, name], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${base}${href}` })),
});

function newsletter(c, id = 'f') {
  const n = c.footer.newsletter;
  return `
<form class="news" method="post" action="/api/subscribe" novalidate data-form="subscribe" data-ok="${esc(n.ok)}" data-fail="${esc(n.fail)}" data-sending="…">
  <input type="hidden" name="lang" value="${c.lang}">
  <p class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
  <label class="sr" for="news-${id}">${esc(n.placeholder)}</label>
  <div class="news__row">
    <input id="news-${id}" type="email" name="email" required placeholder="${esc(n.placeholder)}" autocomplete="email" dir="ltr">
    <button type="submit"><span>${esc(n.button)}</span>${arrow}</button>
  </div>
  <p class="status" role="status" data-form-status hidden></p>
</form>`;
}

// One photograph per page for the menu; it changes as you hover the list.
const MENU_IMG = ['morning', 'aerial', 'plaza', 'axis', 'sculpture', 'north90', 'golden'];

function header(c, pathname) {
  const home = c.lang === 'en' ? '/' : '/ar/';
  const other = c.lang === 'en' ? `/ar${pathname === '/' ? '/' : pathname}` : pathname.replace(/^\/ar/, '') || '/';
  const isCurrent = (href) => (href === home ? pathname === home : pathname.startsWith(href));
  const cur = (href) => (isCurrent(href) ? 'aria-current="page"' : '');
  const [, ...pages] = c.nav;
  const main = pages.slice(0, -1);
  const contact = pages[pages.length - 1];
  const m = c.menu;
  const active = Math.max(0, c.nav.findIndex(([href]) => isCurrent(href)));
  return `
<header class="top" data-top>
  <a class="top__brand" href="${home}" aria-label="${esc(c.brand)}">${logoSvg()}</a>
  <nav class="top__nav" aria-label="Main">${main.map(([href, l]) => `<a href="${href}" ${cur(href)}>${esc(l)}</a>`).join('')}</nav>
  <div class="top__right">
    <a class="top__link" href="${contact[0]}" ${cur(contact[0])}>${esc(contact[1])}</a>
    <a class="top__link top__lang" href="${other}" hreflang="${c.otherLang}" lang="${c.otherLang}" data-full-nav>${esc(c.otherLabel)}</a>
    <span class="lift" aria-hidden="true"><span class="lift__arrow" data-lift-dir></span><span class="lift__floor" data-lift>R</span></span>
    <button class="top__menu" type="button" aria-expanded="false" aria-controls="menu" data-menu-toggle><span class="top__menu-label" data-open="${esc(m.open)}" data-close="${esc(m.close)}">${esc(m.open)}</span><i class="burger" aria-hidden="true"><b></b><b></b></i></button>
  </div>
</header>
<aside class="rail" aria-hidden="true" data-rail>${FLOORS.map((f) => `<span data-floor="${f.id}">${f.id}</span>`).join('')}</aside>
<div class="menu" id="menu" data-menu aria-hidden="true">
  <div class="menu__media" aria-hidden="true">
    ${MENU_IMG.map((img, i) => `<img data-menu-img="${i}" data-src="/img/${img}-1080.webp" alt=""${i === active ? ' class="is-on"' : ''}>`).join('')}
  </div>
  <div class="menu__body">
    <nav class="menu__nav" aria-label="${esc(m.open)}">
      ${c.nav.map(([href, l], i) => `<a href="${href}" ${cur(href)} data-menu-item="${i}"><i>${String(i + 1).padStart(2, '0')}</i><span class="menu__name"><span>${esc(l)}</span></span><small>${esc(m.notes[i])}</small></a>`).join('')}
    </nav>
    <div class="menu__foot">
      <div><p class="label">${esc(m.find)}</p><p>${esc(c.footer.address)}</p></div>
      <div><p class="label">${esc(m.write)}</p><a href="mailto:${c.footer.email}">${esc(c.footer.email)}</a></div>
      <div><p class="label">${esc(m.follow)}</p><a href="https://www.instagram.com/thewavemall" target="_blank" rel="noopener">${esc(c.footer.instagram)}</a></div>
      <div class="menu__lang"><a href="${other}" hreflang="${c.otherLang}" lang="${c.otherLang}" data-full-nav>${esc(c.otherLabel)}</a></div>
    </div>
  </div>
</div>`;
}

function footer(c) {
  const f = c.footer;
  const home = c.lang === 'en' ? '/' : '/ar/';
  return `
<footer class="foot">
  <div class="wrap">
    <div class="foot__top">
      <a class="foot__logo" href="${home}" aria-label="${esc(c.brand)}">${logoSvg()}</a>
      <p class="foot__line">${esc(f.newsletter.title)}</p>
      ${newsletter(c)}
    </div>
    <div class="foot__cols">
      <div class="foot__col">${c.nav.slice(1, 4).map(([href, l]) => `<a href="${href}">${esc(l)}</a>`).join('')}</div>
      <div class="foot__col">${c.nav.slice(4).map(([href, l]) => `<a href="${href}">${esc(l)}</a>`).join('')}</div>
      <div class="foot__col"><span>${esc(f.address)}</span><span>${esc(f.hours)}</span></div>
      <div class="foot__col"><a href="mailto:${f.email}">${esc(f.email)}</a><a href="https://www.instagram.com/thewavemall" target="_blank" rel="noopener">${esc(f.instagram)}</a></div>
    </div>
  </div>
  <div class="wrap foot__legal">
    <p>© ${new Date().getFullYear()} ${esc(f.rights)}${f.legal.map(([href, l]) => ` · <a href="${href}">${esc(l)}</a>`).join('')}</p>
    <p>${esc(f.note)}</p>
    <p class="foot__credit">${esc(f.powered)} <a href="https://najmarketing.co" target="_blank" rel="noopener">Najmarketing.co</a></p>
    <button type="button" data-top-btn>${esc(f.top)}</button>
  </div>
</footer>`;
}

function layout({ lang, pathname, title: pageTitle, description, body, siteUrl, nonce, image = null, seo = {} }) {
  const c = content[lang];
  const base = (siteUrl || '').replace(/\/$/, '');
  const enPath = lang === 'en' ? pathname : pathname.replace(/^\/ar/, '') || '/';
  const arPath = lang === 'ar' ? pathname : `/ar${pathname === '/' ? '/' : pathname}`;
  const ogImage = seo.image ? `${base}${imgUrl(seo.image)}` : `${base}/img/og-image.jpg`;
  const org = {
    '@type': 'ShoppingCenter',
    '@id': `${base}/#org`,
    name: 'The Wave',
    alternateName: ['The Wave New Cairo', 'ذا ويف'],
    slogan: 'More than a destination.',
    url: `${base}/`,
    logo: `${base}/img/logo.svg`,
    image: [`${base}/img/og-image.jpg`, `${base}${imgUrl('morning')}`, `${base}${imgUrl('night')}`],
    email: c.footer.email,
    sameAs: ['https://www.instagram.com/thewavemall'],
    address: { '@type': 'PostalAddress', streetAddress: 'North 90 Street, First Sector', addressLocality: 'New Cairo', addressRegion: 'Cairo Governorate', addressCountry: 'EG' },
    geo: { '@type': 'GeoCoordinates', latitude: 30.0194714, longitude: 31.4319505 },
    amenityFeature: [
      { '@type': 'LocationFeatureSpecification', name: 'Parking', value: true },
      { '@type': 'LocationFeatureSpecification', name: 'Outdoor terraces', value: true },
    ],
  };
  const site = { '@type': 'WebSite', '@id': `${base}/#site`, url: `${base}/`, name: 'The Wave', inLanguage: lang, publisher: { '@id': `${base}/#org` } };
  const feed = `${lang === 'en' ? '' : '/ar'}/journal/feed.xml`;
  return `<!doctype html>
<html lang="${c.lang}" dir="${c.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${seo.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}">
<meta name="theme-color" content="#fbfaf6">
<link rel="canonical" href="${base}${pathname}">
<link rel="alternate" hreflang="en" href="${base}${enPath}">
<link rel="alternate" hreflang="ar" href="${base}${arPath}">
<link rel="alternate" hreflang="x-default" href="${base}${enPath}">
<link rel="alternate" type="application/rss+xml" title="${esc(c.journal.title)}" href="${base}${feed}">
<meta property="og:type" content="${seo.type || 'website'}">
<meta property="og:site_name" content="The Wave">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${base}${pathname}">
<meta property="og:image" content="${ogImage}">
<meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'ar_EG'}">
<meta property="og:locale:alternate" content="${lang === 'en' ? 'ar_EG' : 'en_US'}">
${seo.published ? `<meta property="article:published_time" content="${seo.published}">\n<meta property="article:modified_time" content="${seo.modified || seo.published}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ogImage}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/BodoniModa-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/Archivo-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/Montserrat-var.woff2" as="font" type="font/woff2" crossorigin>
${lang === 'ar' ? '<link rel="preload" href="/fonts/PlexArabic-400.woff2" as="font" type="font/woff2" crossorigin>' : ''}
${image ? `<link rel="preload" as="image" href="/img/${image}-1080.webp" imagesrcset="${srcset(image)}" imagesizes="100vw">` : ''}
<link rel="stylesheet" href="/css/site.css?v=${ASSET_V.css}">
<script nonce="${nonce}">document.documentElement.classList.add('js');</script>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [org, site, ...(seo.jsonld || [])] })}</script>
</head>
<body>
<div class="pre" data-pre aria-hidden="true">
  <div class="pre__bg" data-pre-bg></div>
  <div class="pre__stage">
    <div class="pre__logo" data-pre-logo>
      <svg class="pre__lines" viewBox="${LOGO_VB}">${['T', 'H', 'E2', 'W', 'AV', 'E'].map((k) => `<path pathLength="1" d="${LOGO[k]}"/>`).join('')}</svg>
      <svg class="pre__fill" viewBox="${LOGO_VB}" fill="currentColor">${['T', 'H', 'E2', 'W', 'AV', 'E'].map((k) => `<path d="${LOGO[k]}"/>`).join('')}</svg>
    </div>
    <span class="pre__rule"><i data-pre-rule></i></span>
    <p class="pre__place" data-pre-place>${esc(c.home.hero.kicker)}</p>
  </div>
</div>
<a class="skip" href="#main">${esc(c.skip)}</a>
${header(c, pathname)}
<main id="main" class="page" data-page="${pathname}">
${body}
</main>
${footer(c)}
<svg class="curtain" data-curtain viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><path d=""/></svg>
<script src="/js/vendor/gsap.min.js" defer></script>
<script src="/js/vendor/ScrollTrigger.min.js" defer></script>
<script src="/js/vendor/lenis.min.js" defer></script>
<script src="/js/site.js?v=${ASSET_V.js}" defer></script>
</body>
</html>`;
}

module.exports = { esc, picture, frame, imgUrl, logoSvg, link, arrow, label, title, num, crumbs, crumbsLd, newsletter, fmtDate, layout, LOGO };
