'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { content, COORDS } = require('./content');

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
    eager ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'
  }>`;
}

const kicker = (t) => `<p class="kicker">${esc(t)}</p>`;
const heading = (title, script, id) =>
  `<h2 class="display" id="${id}">${esc(title)} <em class="script">${esc(script)}</em></h2>`;

function renderPage(lang, { siteUrl, status } = {}) {
  const c = content[lang];
  const base = (siteUrl || '').replace(/\/$/, '');
  const home = lang === 'en' ? '/' : '/ar/';
  const other = lang === 'en' ? '/ar/' : '/';
  const mapUrl = `https://www.google.com/maps?q=${COORDS.lat},${COORDS.lng}`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ShoppingCenter',
    name: 'The Wave',
    alternateName: ['The Wave New Cairo Mall', 'ذا ويف'],
    slogan: 'More than a destination.',
    url: `${base}${home}`,
    image: `${base}/img/og-image.jpg`,
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'New Cairo',
      addressRegion: 'Cairo Governorate',
      addressCountry: 'EG',
    },
    geo: { '@type': 'GeoCoordinates', latitude: COORDS.lat, longitude: COORDS.lng },
  };

  const nav = c.nav.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join('');

  const waves = c.waves.items
    .map(
      (w, i) => `
        <article class="wave-card reveal" tabindex="0">
          ${picture(w.img, w.alt, { sizes: '(min-width: 900px) 25vw, 90vw' })}
          <div class="wave-card__body">
            <span class="wave-card__no">0${i + 1}</span>
            <h3>${esc(w.name)}</h3>
            <p class="script wave-card__line">${esc(w.line)}</p>
            <p class="wave-card__text">${esc(w.text)}</p>
          </div>
        </article>`,
    )
    .join('');

  const steps = c.day.steps
    .map(([t, label]) => `<li class="reveal"><time>${esc(t)}</time><span>${esc(label)}</span></li>`)
    .join('');

  const facts = c.story.facts
    .map(([k, v]) => `<li class="reveal"><strong>${esc(k)}</strong><span>${esc(v)}</span></li>`)
    .join('');

  const f = c.enquire.fields;
  const cats = c.enquire.categories.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const banner =
    status === 'ok'
      ? `<p class="form-status form-status--ok" role="status">${esc(c.enquire.ok)}</p>`
      : status === 'error'
        ? `<p class="form-status form-status--err" role="alert">${esc(c.enquire.fail)}</p>`
        : `<p class="form-status" role="status" hidden></p>`;

  return `<!doctype html>
<html lang="${c.lang}" dir="${c.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(c.title)}</title>
<meta name="description" content="${esc(c.description)}">
<meta name="theme-color" content="#1D3A2E">
<link rel="canonical" href="${base}${home}">
<link rel="alternate" hreflang="en" href="${base}/">
<link rel="alternate" hreflang="ar" href="${base}/ar/">
<link rel="alternate" hreflang="x-default" href="${base}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The Wave">
<meta property="og:title" content="${esc(c.title)}">
<meta property="og:description" content="${esc(c.description)}">
<meta property="og:url" content="${base}${home}">
<meta property="og:image" content="${base}/img/og-image.jpg">
<meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'ar_EG'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/BodoniModa-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/PinyonScript-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css?v=${ASSET_V.css}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body class="lang-${c.lang}">
<a class="skip" href="#main">${lang === 'en' ? 'Skip to content' : 'انتقل إلى المحتوى'}</a>

<header class="site-header" data-header>
  <a class="brand" href="${home}" aria-label="The Wave"><img src="/img/logo-ivory.png" alt="The Wave" width="900" height="493"></a>
  <nav class="nav" id="nav" aria-label="Main">${nav}</nav>
  <div class="header-tools">
    <a class="lang-switch" href="${other}" hreflang="${c.otherLang}" lang="${c.otherLang}">${esc(c.otherLabel)}</a>
    <a class="btn btn--small" href="#enquire">${esc(c.cta)}</a>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="nav" data-menu><span class="sr">${esc(c.menu)}</span><i></i><i></i></button>
  </div>
</header>

<main id="main">

<section class="hero" aria-labelledby="hero-title">
  <div class="hero__media">${picture('hero-golden', lang === 'en' ? 'The curved façade of The Wave at golden hour.' : 'واجهة ذا ويف المنحنية وقت الساعة الذهبية.', { eager: true, cls: 'hero__img' })}</div>
  <div class="hero__shade"></div>
  <div class="hero__inner">
    <p class="pill">${esc(c.hero.status)}</p>
    <h1 id="hero-title" class="display display--xl">${esc(c.hero.lead)} <em class="script">${esc(c.hero.script)}</em></h1>
    <p class="hero__sub">${esc(c.hero.sub)}</p>
    <div class="hero__actions">
      <a class="btn" href="#enquire">${esc(c.hero.primary)}</a>
      <a class="btn btn--ghost" href="#visit">${esc(c.hero.secondary)}</a>
    </div>
  </div>
  <a class="scroll-cue" href="#story"><span>${esc(c.hero.scroll)}</span><i></i></a>
</section>

<section class="section story" id="story" aria-labelledby="story-title">
  <div class="wrap story__grid">
    <div class="story__text">
      ${kicker(c.story.kicker)}
      ${heading(c.story.title, c.story.script, 'story-title')}
      ${c.story.body.map((p) => `<p class="lede reveal">${esc(p)}</p>`).join('')}
      <ul class="facts">${facts}</ul>
    </div>
    <figure class="story__fig reveal">
      ${picture('architecture', lang === 'en' ? 'Curved cream balconies and glass bands of The Wave at golden hour.' : 'شرفات كريمية منحنية وأشرطة زجاجية في ذا ويف وقت الساعة الذهبية.', { sizes: '(min-width: 900px) 40vw, 90vw' })}
    </figure>
  </div>
</section>

<section class="section waves" id="waves" aria-labelledby="waves-title">
  <div class="wrap">
    ${kicker(c.waves.kicker)}
    ${heading(c.waves.title, c.waves.script, 'waves-title')}
  </div>
  <div class="waves__row">${waves}</div>
</section>

<section class="section day" id="day" aria-labelledby="day-title">
  <div class="wrap day__grid">
    <div>
      ${kicker(c.day.kicker)}
      ${heading(c.day.title, c.day.script, 'day-title')}
      <p class="note">${esc(c.day.note)}</p>
    </div>
    <ol class="timeline">${steps}</ol>
  </div>
</section>

<section class="section visit" id="visit" aria-labelledby="visit-title">
  <video class="visit__video" muted loop playsinline preload="none" poster="/video/hero-poster.jpg" data-lazy-video aria-hidden="true">
    <source src="/video/hero.mp4" type="video/mp4">
  </video>
  <div class="visit__shade"></div>
  <div class="wrap visit__inner">
    ${kicker(c.visit.kicker)}
    ${heading(c.visit.title, c.visit.script, 'visit-title')}
    <p class="lede">${esc(c.visit.body)}</p>
    <address>${esc(c.visit.address)}</address>
    <a class="btn" href="${mapUrl}" target="_blank" rel="noopener">${esc(c.visit.button)}</a>
  </div>
</section>

<section class="section enquire" id="enquire" aria-labelledby="enquire-title">
  <div class="wrap enquire__grid">
    <div>
      ${kicker(c.enquire.kicker)}
      ${heading(c.enquire.title, c.enquire.script, 'enquire-title')}
      <p class="lede">${esc(c.enquire.body)}</p>
    </div>
    <form class="form" method="post" action="/api/enquiry" novalidate data-enquiry data-sending="${esc(f.sending)}" data-ok="${esc(c.enquire.ok)}" data-fail="${esc(c.enquire.fail)}">
      <input type="hidden" name="lang" value="${c.lang}">
      <p class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
      <label>${esc(f.name)}<input name="name" required maxlength="120" autocomplete="name"></label>
      <label>${esc(f.brand)}<input name="brand" required maxlength="160" autocomplete="organization"></label>
      <div class="form__row">
        <label>${esc(f.email)}<input type="email" name="email" required maxlength="200" autocomplete="email" dir="ltr"></label>
        <label>${esc(f.phone)}<input type="tel" name="phone" maxlength="40" autocomplete="tel" dir="ltr"></label>
      </div>
      <label>${esc(f.category)}<select name="category" required>${cats}</select></label>
      <label>${esc(f.message)}<textarea name="message" rows="4" maxlength="2000"></textarea></label>
      <button class="btn btn--gold" type="submit">${esc(f.submit)}</button>
      ${banner}
      <p class="note">${esc(c.enquire.privacy)}</p>
    </form>
  </div>
</section>

</main>

<footer class="site-footer">
  <div class="wrap footer__grid">
    <div>
      <img class="footer__logo" src="/img/logo-gold.png" alt="The Wave" width="900" height="493" loading="lazy">
      <p class="script footer__tag">${esc(c.footer.tag)}</p>
    </div>
    <div class="footer__meta">
      <a href="https://www.instagram.com/thewavemall" target="_blank" rel="noopener">${esc(c.footer.follow)}</a>
      <p>${esc(c.footer.disclaimer)}</p>
      <p>© ${new Date().getFullYear()} ${esc(c.footer.rights)}</p>
    </div>
  </div>
</footer>

<script src="/js/site.js?v=${ASSET_V.js}" defer></script>
</body>
</html>`;
}

function renderNotFound(lang) {
  const c = content[lang];
  const home = lang === 'en' ? '/' : '/ar/';
  return `<!doctype html>
<html lang="${c.lang}" dir="${c.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(c.notFound.title)} | The Wave</title>
<link rel="stylesheet" href="/css/site.css?v=${ASSET_V.css}"></head>
<body class="lang-${c.lang} nf"><main class="nf__inner"><img src="/img/logo-gold.png" alt="The Wave" width="300" height="164">
<h1 class="display">${esc(c.notFound.title)}</h1><p class="lede">${esc(c.notFound.body)}</p>
<a class="btn" href="${home}">${esc(c.notFound.back)}</a></main></body></html>`;
}

module.exports = { renderPage, renderNotFound, esc };
