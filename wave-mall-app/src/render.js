'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { content } = require('./content');
const LOGO = require('./logo-paths.json');

const PUBLIC = path.join(__dirname, '..', 'public');

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Content hash so css/js can be cached for a year and still update on deploy.
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

function picture(name, alt, { sizes = '100vw', eager = false, cls = '', portrait } = {}) {
  const ws = widths(name);
  const fallback = ws[Math.min(1, ws.length - 1)];
  const source = portrait ? `<source media="(orientation: portrait)" srcset="${srcset(portrait)}" sizes="${sizes}">` : '';
  return `<picture>${source}<img class="${cls}" src="/img/${name}-${fallback}.webp" srcset="${srcset(name)}" sizes="${sizes}" alt="${esc(alt)}" ${
    eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"'
  }></picture>`;
}

// The wordmark as inline SVG so the letters and the A–V stroke can animate.
const LOGO_VB = '0 0 490 225.2';
function logoSvg({ cls = '', outline = false, label = 'The Wave' } = {}) {
  const letters = ['T', 'H', 'E2', 'W', 'AV', 'E'].map((k) => `<path class="l l-${k.toLowerCase()}" d="${LOGO[k]}"/>`).join('');
  const draw = outline ? `<path class="l-draw" pathLength="1" fill="none" stroke="currentColor" stroke-width="1" d="${LOGO.AV}"/>` : '';
  return `<svg class="logo ${cls}" viewBox="${LOGO_VB}" role="img" aria-label="${esc(label)}" fill="currentColor"><g class="logo__fill">${letters}</g>${draw}</svg>`;
}
const ligature = (cls = '') => `<svg class="${cls}" viewBox="163 97 207 128" aria-hidden="true"><path fill="currentColor" d="${LOGO.AV}"/></svg>`;

const arrow = '<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const link = (href, label, cls = '') => `<a class="link ${cls}" href="${href}"><span>${esc(label)}</span>${arrow}</a>`;

// Hero: a full-height image fading into paper, one serif sentence at the foot.
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

function header(c, pathname) {
  const home = c.lang === 'en' ? '/' : '/ar/';
  const other = c.lang === 'en' ? `/ar${pathname === '/' ? '/' : pathname}` : pathname.replace(/^\/ar/, '') || '/';
  const links = c.nav.slice(1).map(([href, label]) => `<a href="${href}" ${href === pathname ? 'aria-current="page"' : ''}>${esc(label)}</a>`).join('');
  return `
<header class="top" data-top>
  <a class="top__brand" href="${home}" aria-label="${esc(c.brand)}">${logoSvg()}</a>
  <nav class="top__nav" aria-label="Main">${links}</nav>
  <a class="top__lang" href="${other}" hreflang="${c.otherLang}" lang="${c.otherLang}" data-full-nav>${esc(c.otherLabel)}</a>
</header>
<nav class="dock" aria-label="Pages" data-dock>
  ${c.nav.map(([href, label]) => `<a href="${href}" ${href === pathname ? 'aria-current="page"' : ''}><span>${esc(label)}</span></a>`).join('')}
</nav>`;
}

function footer(c) {
  const f = c.footer;
  return `
<footer class="foot">
  <div class="col foot__col">
    <p class="foot__line">${esc(f.line)}</p>
    <div class="foot__rows">
      <a href="mailto:${f.email}">${esc(f.email)}</a>
      <a href="https://www.instagram.com/thewavemall" target="_blank" rel="noopener">${esc(f.instagram)}</a>
      <span>${esc(f.address)}</span>
    </div>
    <div class="foot__mark" aria-hidden="true">${logoSvg()}</div>
    <p class="foot__legal">© ${new Date().getFullYear()} ${esc(f.rights)}<br>${esc(f.note)}</p>
  </div>
</footer>`;
}

function layout({ lang, pathname, title, description, body, siteUrl, nonce, image = 'aerial', loader = true }) {
  const c = content[lang];
  const base = (siteUrl || '').replace(/\/$/, '');
  const enPath = lang === 'en' ? pathname : pathname.replace(/^\/ar/, '') || '/';
  const arPath = lang === 'ar' ? pathname : `/ar${pathname === '/' ? '/' : pathname}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ShoppingCenter',
    name: 'The Wave',
    alternateName: ['The Wave New Cairo Mall', 'ذا ويف'],
    slogan: 'More than a destination.',
    url: `${base}${lang === 'en' ? '/' : '/ar/'}`,
    image: `${base}/img/og-image.jpg`,
    address: { '@type': 'PostalAddress', streetAddress: 'North 90 Street, First Sector', addressLocality: 'New Cairo', addressRegion: 'Cairo Governorate', addressCountry: 'EG' },
    geo: { '@type': 'GeoCoordinates', latitude: 30.0194714, longitude: 31.4319505 },
  };
  return `<!doctype html>
<html lang="${c.lang}" dir="${c.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#ede7da">
<link rel="canonical" href="${base}${pathname}">
<link rel="alternate" hreflang="en" href="${base}${enPath}">
<link rel="alternate" hreflang="ar" href="${base}${arPath}">
<link rel="alternate" hreflang="x-default" href="${base}${enPath}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The Wave">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${base}${pathname}">
<meta property="og:image" content="${base}/img/og-image.jpg">
<meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'ar_EG'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/BodoniModa-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/BodoniModa-italic.woff2" as="font" type="font/woff2" crossorigin>
${image ? `<link rel="preload" as="image" href="/img/${image}-1280.webp" imagesrcset="${srcset(image)}" imagesizes="100vw">` : ''}
<link rel="stylesheet" href="/css/site.css?v=${ASSET_V.css}">
<script nonce="${nonce}">document.documentElement.classList.add('js');</script>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<a class="skip" href="#main">${esc(c.skip)}</a>
${loader ? `<div class="veil" data-veil aria-hidden="true">${ligature('veil__mark')}</div>` : ''}
${header(c, pathname)}
<main id="main" class="page" data-page="${pathname}">
<svg class="thread" data-thread aria-hidden="true"><path pathLength="1" fill="none" stroke="currentColor" stroke-width="1"/></svg>
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

module.exports = { esc, picture, logoSvg, ligature, link, arrow, hero, markSection, layout, LOGO };
