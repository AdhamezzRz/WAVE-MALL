'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { content, PALETTE } = require('./content');
const LOGO = require('./logo-paths.json');

const PUBLIC = path.join(__dirname, '..', 'public');

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Short content hash so css/js can be cached for a year and still update on deploy.
const version = (file) =>
  crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, file))).digest('hex').slice(0, 8);

const ASSET_V = { css: version('css/site.css'), js: version('js/site.js') };

// Widths available on disk for an image, e.g. [640, 1280, 1920].
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

function picture(name, alt, { sizes = '100vw', eager = false, cls = '' } = {}) {
  const ws = widths(name);
  const srcset = ws.map((w) => `/img/${name}-${w}.webp ${w}w`).join(', ');
  const fallback = ws[Math.min(1, ws.length - 1)];
  return `<img class="${cls}" src="/img/${name}-${fallback}.webp" srcset="${srcset}" sizes="${sizes}" alt="${esc(alt)}" ${
    eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"'
  }>`;
}

// The wordmark as inline SVG so every letter can be animated. The A–V
// ligature also gets an outline copy for the stroke-draw effect.
const LOGO_VB = '0 0 490 225.2';
function logoSvg({ cls = '', outline = false, label = 'The Wave' } = {}) {
  const letters = ['T', 'H', 'E2', 'W', 'AV', 'E']
    .map((k) => `<path class="l l-${k.toLowerCase()}" d="${LOGO[k]}"/>`)
    .join('');
  const draw = outline
    ? `<path class="l-draw" pathLength="1" fill="none" stroke="currentColor" stroke-width="1.2" d="${LOGO.AV}"/>`
    : '';
  return `<svg class="logo-svg ${cls}" viewBox="${LOGO_VB}" role="img" aria-label="${esc(label)}" fill="currentColor"><g class="logo-fill">${letters}</g>${draw}</svg>`;
}

// A wave-shaped edge. `flat` and `curve` share point structure so GSAP can morph between them.
const WAVE_CURVE = 'M0,120 L0,70 C240,10 480,10 720,60 C960,110 1200,110 1440,50 L1440,120 Z';
const WAVE_FLAT = 'M0,120 L0,120 C240,120 480,120 720,120 C960,120 1200,120 1440,120 L1440,120 Z';
const waveEdge = (cls = '') =>
  `<svg class="wave-edge ${cls}" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true"><path d="${WAVE_CURVE}" data-flat="${WAVE_FLAT}" data-curve="${WAVE_CURVE}"/></svg>`;

const kicker = (t) => `<p class="kicker" data-reveal="kicker"><span>${esc(t)}</span></p>`;
const heading = (title, script, { tag = 'h2', cls = '' } = {}) =>
  `<${tag} class="display ${cls}" data-reveal="lines">${esc(title)} <em class="script">${esc(script)}</em></${tag}>`;

const arrow = '<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function link(href, label, { cls = 'link', cursor = '' } = {}) {
  return `<a class="${cls}" href="${href}" ${cursor ? `data-cursor="${cursor}"` : ''} data-magnetic><span class="link__label">${esc(label)}</span>${arrow}</a>`;
}

function marquee(c) {
  const items = c.marquee.map((t) => `<span class="marquee__item">${esc(t)}<i class="marquee__sep" aria-hidden="true"><svg viewBox="163 97 207 128"><path fill="currentColor" d="${LOGO.AV}"/></svg></i></span>`).join('');
  return `<div class="marquee" data-marquee aria-hidden="true"><div class="marquee__track">${items}${items}</div></div>`;
}

function header(c, pathname) {
  const nav = c.nav
    .map(([href, label]) => `<a href="${href}" ${href === pathname ? 'aria-current="page"' : ''}><span>${esc(label)}</span></a>`)
    .join('');
  const home = c.lang === 'en' ? '/' : '/ar/';
  const other = c.lang === 'en' ? `/ar${pathname === '/' ? '/' : pathname}` : pathname.replace(/^\/ar/, '') || '/';
  return `
<header class="site-header" data-header>
  <a class="brand" href="${home}" aria-label="${esc(c.brand)}">${logoSvg({ cls: 'brand__logo' })}</a>
  <nav class="nav" aria-label="Main">${nav}</nav>
  <div class="header__tools">
    <a class="lang" href="${other}" hreflang="${c.otherLang}" lang="${c.otherLang}" data-full-nav>${esc(c.otherLabel)}</a>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="menu" data-menu-toggle>
      <span class="menu-btn__label" data-open="${esc(c.menu.open)}" data-close="${esc(c.menu.close)}">${esc(c.menu.open)}</span>
      <span class="menu-btn__icon" aria-hidden="true"><i></i><i></i></span>
    </button>
  </div>
</header>
<div class="menu" id="menu" data-menu aria-hidden="true">
  <div class="menu__bg"></div>
  <div class="menu__inner">
    <nav class="menu__nav" aria-label="${esc(c.menu.open)}">
      ${c.nav.map(([href, label], i) => `<a href="${href}" ${href === pathname ? 'aria-current="page"' : ''}><span class="menu__no">0${i + 1}</span><span class="menu__label">${esc(label)}</span></a>`).join('')}
    </nav>
    <div class="menu__aside">
      <p class="menu__hint">${esc(c.menu.hint)}</p>
      <a class="btn btn--sand" href="${c.lang === 'en' ? '/leasing/' : '/ar/leasing/'}">${esc(c.menu.cta)}</a>
      <a class="menu__lang" href="${other}" hreflang="${c.otherLang}" lang="${c.otherLang}" data-full-nav>${esc(c.otherLabel)}</a>
    </div>
    <div class="menu__pattern" aria-hidden="true"></div>
  </div>
</div>`;
}

function footer(c) {
  const home = c.lang === 'en' ? '/' : '/ar/';
  return `
<footer class="site-footer" data-footer>
  <div class="footer__mark" aria-hidden="true">${logoSvg({ cls: 'footer__logo' })}</div>
  <div class="wrap footer__grid">
    <div class="footer__col footer__col--brand">
      <p class="script footer__tag">${esc(c.footer.tag)}</p>
    </div>
    <div class="footer__col">
      <p class="footer__head">${esc(c.footer.explore)}</p>
      ${c.nav.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}
    </div>
    <div class="footer__col">
      <p class="footer__head">${esc(c.footer.contact)}</p>
      <a href="mailto:${c.footer.email}">${esc(c.footer.email)}</a>
      <a href="https://www.instagram.com/thewavemall" target="_blank" rel="noopener">Instagram</a>
      <a href="${home}">${esc(c.brand)}</a>
    </div>
  </div>
  <div class="wrap footer__legal">
    <p>© <span data-year>${new Date().getFullYear()}</span> ${esc(c.footer.rights)} <span class="footer__credit">${esc(c.footer.credits)}</span></p>
    <p>${esc(c.footer.disclaimer)}</p>
    <button class="footer__top" type="button" data-top>${esc(c.footer.top)} ${arrow}</button>
  </div>
</footer>`;
}

function layout({ lang, pathname, title, description, body, siteUrl, nonce, image = 'aerial', loader = true, theme = 'forest' }) {
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
<html lang="${c.lang}" dir="${c.dir}" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#283833">
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
<link rel="preload" href="/fonts/InterDisplay-Medium.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/PinyonScript-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" as="image" href="/img/${image}-1280.webp" imagesrcset="${widths(image).map((w) => `/img/${image}-${w}.webp ${w}w`).join(', ')}" imagesizes="100vw">
<link rel="stylesheet" href="/css/site.css?v=${ASSET_V.css}">
<script nonce="${nonce}">document.documentElement.classList.add('js');</script>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<a class="skip" href="#main">${lang === 'en' ? 'Skip to content' : 'انتقل إلى المحتوى'}</a>
${loader ? `<div class="loader" data-loader aria-hidden="true"><div class="loader__logo">${logoSvg({ outline: true })}</div><p class="loader__line">${esc(c.loader.line)}</p><div class="loader__bar"><i></i></div>${waveEdge('loader__edge')}</div>` : ''}
<div class="curtain" data-curtain aria-hidden="true">${waveEdge('curtain__edge curtain__edge--top')}<div class="curtain__body">${logoSvg({ cls: 'curtain__logo' })}</div>${waveEdge('curtain__edge curtain__edge--bottom')}</div>
<div class="cursor" data-cursor aria-hidden="true"><div class="cursor__dot"></div><div class="cursor__ring"><span class="cursor__label"></span></div></div>
${header(c, pathname)}
<main id="main" class="page" data-page="${pathname}" data-lang="${lang}">
${body}
</main>
${footer(c)}
<script src="/js/vendor/gsap.min.js" defer></script>
<script src="/js/vendor/ScrollTrigger.min.js" defer></script>
<script src="/js/vendor/SplitText.min.js" defer></script>
<script src="/js/vendor/CustomEase.min.js" defer></script>
<script src="/js/vendor/lenis.min.js" defer></script>
<script src="/js/site.js?v=${ASSET_V.js}" defer></script>
</body>
</html>`;
}

module.exports = { esc, picture, logoSvg, waveEdge, kicker, heading, link, marquee, layout, arrow, PALETTE, LOGO };
