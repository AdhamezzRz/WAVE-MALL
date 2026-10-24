'use strict';

const { content, COORDS, PALETTE, LANDMARKS } = require('./content');
const { esc, picture, logoSvg, waveEdge, kicker, heading, link, marquee, layout, arrow, LOGO } = require('./render');

const mapUrl = `https://www.google.com/maps?q=${COORDS.lat},${COORDS.lng}`;
const p = (lang, path) => (lang === 'en' ? path : `/ar${path}`);

/* ---------- shared sections ---------- */

function pageHero(c, h, img, alt, { tall = false } = {}) {
  return `
<section class="phero ${tall ? 'phero--tall' : ''}" data-theme="forest" data-hero>
  <div class="phero__media" data-parallax="0.25">${picture(img, alt, { eager: true, cls: 'phero__img' })}</div>
  <div class="phero__shade"></div>
  <div class="wrap phero__inner">
    ${kicker(h.kicker)}
    ${heading(h.title, h.script, { tag: 'h1', cls: 'display--xl' })}
    <p class="lede phero__sub" data-reveal="fade">${esc(h.sub)}</p>
  </div>
  ${waveEdge('phero__edge')}
</section>`;
}

function wavesStack(c, { withLink = false } = {}) {
  const themes = ['sand', 'seaglass', 'cocoa', 'forest'];
  const cards = c.waves
    .map(
      (w, i) => `
    <article class="stack__card stack__card--${themes[i]}" data-stack-card>
      <div class="stack__media">${picture(w.img, w.alt, { sizes: '(min-width: 900px) 50vw, 100vw' })}</div>
      <div class="stack__body">
        <span class="stack__no">0${i + 1}</span>
        <h3 class="stack__title">${esc(w.name)}</h3>
        <p class="script stack__line">${esc(w.line)}</p>
        <p class="stack__text">${esc(w.text)}</p>
      </div>
    </article>`,
    )
    .join('');
  return `
<section class="section waves" id="waves" data-theme="sand">
  <div class="wrap waves__head">
    ${kicker(c.home.waves.kicker)}
    ${heading(c.home.waves.title, c.home.waves.script)}
    ${withLink ? link(p(c.lang, '/experience/'), c.home.waves.more) : ''}
  </div>
  <div class="stack" data-stack>${cards}</div>
</section>`;
}

function markSection(c, m) {
  return `
<section class="section mark" id="mark" data-mark data-colorway="0" data-theme="forest">
  <div class="mark__bg"></div>
  <div class="wrap mark__inner">
    <div class="mark__text">
      ${kicker(m.kicker)}
      ${heading(m.title, m.script)}
      ${Array.isArray(m.body) ? m.body.map((t) => `<p class="lede" data-reveal="fade">${esc(t)}</p>`).join('') : `<p class="lede" data-reveal="fade">${esc(m.body)}</p>`}
      <button class="mark__hint" type="button" data-mark-cycle><i></i>${esc(m.hint || c.home.mark.hint)}</button>
    </div>
    <div class="mark__logo" data-mark-logo data-cursor="${esc(c.cursor.open)}">${logoSvg({ outline: true })}</div>
  </div>
</section>`;
}

/* ---------- home ---------- */

function home(lang, ctx) {
  const c = content[lang];
  const h = c.home;
  const slides = h.design.slides
    .map(
      (s, i) => `
      <figure class="pano__slide" data-pano-slide>
        <div class="pano__media">${picture(s.img, s.caption, { sizes: '(min-width: 900px) 70vw, 90vw' })}</div>
        <figcaption><span class="pano__no">0${i + 1}</span><strong>${esc(s.caption)}</strong><span>${esc(s.note)}</span></figcaption>
      </figure>`,
    )
    .join('');

  const body = `
<section class="hero" data-hero data-theme="forest">
  <div class="hero__media" data-hero-media>${picture('aerial', lang === 'en' ? 'The Wave from above at dusk: curved ribbon balconies around an open plaza of terraces.' : 'ذا ويف من الأعلى عند الغروب: شرفات شريطية منحنية حول ساحة من التراسات.', { eager: true, cls: 'hero__img' })}</div>
  <div class="hero__shade"></div>
  <div class="hero__pattern" aria-hidden="true"></div>
  <div class="wrap hero__inner">
    <p class="pill" data-hero-pill><i></i>${esc(h.hero.status)}</p>
    <h1 class="display display--xl hero__title" data-hero-title>
      <span class="hero__line"><span>${esc(h.hero.lines[0])}</span></span>
      <span class="hero__line"><span>${esc(h.hero.lines[1])}</span></span>
      <span class="hero__line hero__line--script"><em class="script">${esc(h.hero.script)}</em></span>
    </h1>
    <div class="hero__foot" data-hero-foot>
      <p class="hero__sub">${esc(h.hero.sub)}</p>
      <div class="hero__actions">
        <a class="btn btn--sand" href="${p(lang, '/the-wave/')}" data-magnetic>${esc(h.hero.primary)}</a>
        ${link(p(lang, '/leasing/'), h.hero.secondary, { cls: 'link link--light' })}
      </div>
    </div>
  </div>
  <a class="scroll-cue" href="#manifesto" data-hero-cue><span>${esc(h.hero.scroll)}</span><i></i></a>
  ${waveEdge('hero__edge')}
</section>

${marquee(c)}

<section class="section manifesto" id="manifesto" data-theme="sand">
  <div class="manifesto__pattern" data-parallax="-0.15" aria-hidden="true"></div>
  <div class="wrap manifesto__inner">
    ${kicker(h.manifesto.kicker)}
    <p class="manifesto__text" data-manifesto>${esc(h.manifesto.text)}</p>
  </div>
</section>

<section class="section pano" id="design" data-theme="cream" data-pano>
  <div class="wrap pano__head">
    ${kicker(h.design.kicker)}
    ${heading(h.design.title, h.design.script)}
    <p class="lede" data-reveal="fade">${esc(h.design.body)}</p>
    ${link(p(lang, '/the-wave/'), h.design.more)}
  </div>
  <div class="pano__viewport" data-pano-viewport data-cursor="${esc(c.cursor.drag)}">
    <div class="pano__track" data-pano-track>${slides}</div>
  </div>
  <div class="wrap pano__progress" aria-hidden="true"><i data-pano-progress></i></div>
</section>

${wavesStack(c, { withLink: true })}

${markSection(c, h.mark)}

<section class="section loc-teaser" id="location" data-theme="forest">
  <video class="loc-teaser__video" muted loop playsinline preload="none" poster="/video/hero-poster.jpg" data-lazy-video aria-hidden="true"><source src="/video/hero.mp4" type="video/mp4"></video>
  <div class="loc-teaser__shade"></div>
  <div class="wrap loc-teaser__inner">
    ${kicker(h.location.kicker)}
    ${heading(h.location.title, h.location.script)}
    <p class="lede" data-reveal="fade">${esc(h.location.body)}</p>
    <a class="btn btn--sand" href="${p(lang, '/location/')}" data-magnetic>${esc(h.location.more)}</a>
  </div>
</section>

<section class="section lease-teaser" id="leasing" data-theme="cocoa">
  <div class="wrap lease-teaser__inner">
    ${kicker(h.leasing.kicker)}
    ${heading(h.leasing.title, h.leasing.script)}
    <p class="lede" data-reveal="fade">${esc(h.leasing.body)}</p>
    <a class="btn btn--sand btn--big" href="${p(lang, '/leasing/')}" data-magnetic>${esc(h.leasing.more)} ${arrow}</a>
  </div>
  <div class="lease-teaser__pattern" aria-hidden="true"></div>
</section>`;

  return layout({ lang, pathname: p(lang, '/'), title: h.title, description: h.description, body, ...ctx });
}

/* ---------- the wave (story) ---------- */

function story(lang, ctx) {
  const c = content[lang];
  const s = c.story;
  const facts = s.facts.map(([n, t]) => `<li data-reveal="fade"><strong class="serif" data-counter>${esc(n)}</strong><span>${esc(t)}</span></li>`).join('');
  const gallery = s.gallery
    .map((g, i) => `<figure class="gal__item gal__item--${i + 1}" data-reveal="mask"><div class="gal__media" data-parallax="0.12">${picture(g.img, g.caption, { sizes: '(min-width: 900px) 50vw, 100vw' })}</div><figcaption>${esc(g.caption)}</figcaption></figure>`)
    .join('');
  const swatches = PALETTE.map(
    (sw) => `
    <button class="swatch swatch--${sw.id}" type="button" data-swatch data-hex="${sw.hex}" style="--sw:${sw.hex}">
      <span class="swatch__name">${esc(s.palette.names[sw.id])}</span>
      <span class="swatch__meta"><b>${sw.hex}</b><i>RGB ${sw.rgb}</i><i>CMYK ${sw.cmyk}</i></span>
      <span class="swatch__copied">Copied</span>
    </button>`,
  ).join('');

  const body = `
${pageHero(c, s.hero, 'dusk', lang === 'en' ? 'The corner of The Wave at dusk.' : 'زاوية ذا ويف عند الغروب.')}

<section class="section intro" data-theme="sand">
  <div class="wrap intro__grid">
    <div class="intro__text">${s.intro.map((t) => `<p class="lede" data-reveal="fade">${esc(t)}</p>`).join('')}</div>
    <ul class="facts">${facts}</ul>
  </div>
</section>

<section class="section gal" data-theme="cream">
  <div class="wrap gal__grid">${gallery}</div>
</section>

${markSection(c, s.mark)}

<section class="section palette" data-theme="cream" data-palette>
  <div class="wrap">
    ${kicker(s.palette.kicker)}
    ${heading(s.palette.title, s.palette.script)}
  </div>
  <div class="wrap swatches">${swatches}</div>
</section>

<section class="section pattern" data-theme="seaglass">
  <div class="pattern__bg" data-parallax="-0.2" aria-hidden="true"></div>
  <div class="wrap pattern__inner">
    ${kicker(s.pattern.kicker)}
    ${heading(s.pattern.title, s.pattern.script)}
    ${link(p(lang, '/experience/'), c.home.waves.more)}
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/the-wave/'), title: s.title, description: s.description, body, image: 'dusk', ...ctx });
}

/* ---------- experience ---------- */

function experience(lang, ctx) {
  const c = content[lang];
  const e = c.experience;
  const themes = ['sand', 'seaglass', 'cocoa', 'forest'];
  const steps = e.day.steps
    .map(
      ([t, title, text], i) => `
    <li class="tl__step" data-theme="${themes[i]}" data-tl-step>
      <time class="serif">${esc(t)}</time>
      <div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>
    </li>`,
    )
    .join('');
  const cats = e.categories.items
    .map(([k, v], i) => `<li class="cat" data-reveal="fade"><span class="cat__no">0${i + 1}</span><h3>${esc(k)}</h3><p>${esc(v)}</p><i class="cat__glyph" aria-hidden="true"><svg viewBox="163 97 207 128"><path fill="currentColor" d="${LOGO.AV}"/></svg></i></li>`)
    .join('');
  const body = `
${pageHero(c, e.hero, 'fashion', lang === 'en' ? 'A woman in a camel trench coat walks past lit boutique windows.' : 'امرأة بمعطف كاميل تمشي أمام واجهات بوتيكات مضاءة.')}

${wavesStack(c)}

<section class="section tl" data-timeline>
  <div class="wrap tl__head">
    ${kicker(e.day.kicker)}
    ${heading(e.day.title, e.day.script)}
    <p class="note" data-reveal="fade">${esc(e.day.note)}</p>
  </div>
  <div class="wrap tl__body">
    <div class="tl__rail" aria-hidden="true"><i class="tl__fill" data-tl-fill></i><b class="tl__sun" data-tl-sun></b></div>
    <ol class="tl__steps">${steps}</ol>
  </div>
</section>

<section class="section cats" data-theme="cream">
  <div class="wrap">
    ${kicker(e.categories.kicker)}
    ${heading(e.categories.title, e.categories.script)}
    <ul class="cats__grid">${cats}</ul>
  </div>
</section>

<section class="section insta" data-theme="seaglass">
  <div class="wrap insta__inner">
    <h2 class="display" data-reveal="lines">${esc(e.cta.title)}</h2>
    <p class="lede" data-reveal="fade">${esc(e.cta.body)}</p>
    <a class="btn btn--forest" href="https://www.instagram.com/thewavemall" target="_blank" rel="noopener" data-magnetic>${esc(e.cta.button)}</a>
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/experience/'), title: e.title, description: e.description, body, image: 'fashion', ...ctx });
}

/* ---------- location ---------- */

function location(lang, ctx) {
  const c = content[lang];
  const l = c.location;
  const pins = LANDMARKS.map(
    (m) => `<div class="pin ${m.id === 'plot' ? 'pin--plot' : ''}" style="--x:${m.x}%;--y:${m.y}%" data-pin><i></i><span>${esc(l.labels[m.id])}</span></div>`,
  ).join('');
  const stats = l.stats.map(([n, t]) => `<li data-reveal="fade"><strong class="serif">${esc(n)}</strong><span>${esc(t)}</span></li>`).join('');
  const dirs = l.directions.items.map(([k, v]) => `<li data-reveal="fade"><h3>${esc(k)}</h3><p>${esc(v)}</p></li>`).join('');
  const body = `
<section class="phero phero--map" data-theme="forest" data-hero>
  <div class="wrap phero__grid">
    <div class="phero__inner phero__inner--map">
      ${kicker(l.hero.kicker)}
      ${heading(l.hero.title, l.hero.script, { tag: 'h1', cls: 'display--xl' })}
      <p class="lede phero__sub" data-reveal="fade">${esc(l.hero.sub)}</p>
    </div>
    <div class="map" data-map-frame>
      <div class="map__media">${picture('map', lang === 'en' ? 'Satellite view of the First Sector, New Cairo, with The Wave plot between North 90 and South 90.' : 'صورة فضائية للقطاع الأول في القاهرة الجديدة مع قطعة ذا ويف بين التسعين الشمالي والجنوبي.', { eager: true, sizes: '(min-width: 900px) 60vw, 100vw' })}</div>
      <div class="map__shade"></div>
      <div class="map__pins">${pins}</div>
    </div>
  </div>
  ${waveEdge('phero__edge')}
</section>

<section class="section locbody" data-theme="sand">
  <div class="wrap locbody__grid">
    <div>
      <p class="lede" data-reveal="fade">${esc(l.body)}</p>
      <address class="address" data-reveal="fade">${esc(l.address)}</address>
      <a class="btn btn--forest" href="${mapUrl}" target="_blank" rel="noopener" data-magnetic>${esc(l.button)} ${arrow}</a>
    </div>
    <ul class="stats">${stats}</ul>
  </div>
</section>

<section class="section dirs" data-theme="cream">
  <div class="wrap">
    ${kicker(l.directions.kicker)}
    <ul class="dirs__list">${dirs}</ul>
  </div>
</section>

<section class="section loc-teaser loc-teaser--short" data-theme="forest">
  <video class="loc-teaser__video" muted loop playsinline preload="none" poster="/video/hero-poster.jpg" data-lazy-video aria-hidden="true"><source src="/video/hero.mp4" type="video/mp4"></video>
  <div class="loc-teaser__shade"></div>
  <div class="wrap loc-teaser__inner">
    ${heading(c.home.leasing.title, c.home.leasing.script)}
    <a class="btn btn--sand" href="${p(lang, '/leasing/')}" data-magnetic>${esc(c.home.leasing.more)}</a>
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/location/'), title: l.title, description: l.description, body, image: 'map', ...ctx });
}

/* ---------- leasing ---------- */

function leasing(lang, ctx) {
  const c = content[lang];
  const L = c.leasing;
  const f = L.form;
  const why = L.why.items.map(([k, v], i) => `<li data-reveal="fade"><span class="serif">0${i + 1}</span><h3>${esc(k)}</h3><p>${esc(v)}</p></li>`).join('');
  const spaces = L.spaces.items.map(([k, v], i) => `<li data-reveal="fade"><h3><span class="serif">0${i + 1}</span>${esc(k)}</h3><p>${esc(v)}</p></li>`).join('');
  const cats = f.categories.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const sizes = f.sizes.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const status = ctx.status;
  const banner =
    status === 'ok'
      ? `<p class="form-status form-status--ok" role="status" data-form-status>${esc(f.ok)}</p>`
      : status === 'error'
        ? `<p class="form-status form-status--err" role="alert" data-form-status>${esc(f.fail)}</p>`
        : `<p class="form-status" role="status" data-form-status hidden></p>`;
  const field = (name, label, input) => `<div class="field" data-field><label for="f-${name}">${esc(label)}</label>${input}</div>`;
  const body = `
${pageHero(c, L.hero, 'ribbons', lang === 'en' ? 'Curved ribbon balconies traced by warm lines of light at night.' : 'شرفات منحنية مرسومة بخطوط ضوء دافئة ليلاً.')}

<section class="section why" data-theme="sand">
  <div class="wrap">
    ${kicker(L.why.kicker)}
    <ul class="why__grid">${why}</ul>
  </div>
</section>

<section class="section spaces" data-theme="cream">
  <div class="wrap spaces__grid">
    <div>${kicker(L.spaces.kicker)}</div>
    <ul class="spaces__list">${spaces}</ul>
  </div>
</section>

<section class="section enquire" id="enquire" data-theme="forest">
  <div class="wrap enquire__grid">
    <div class="enquire__text">
      ${kicker(f.kicker)}
      ${heading(f.title, f.script)}
      <p class="lede" data-reveal="fade">${esc(f.body)}</p>
    </div>
    <form class="form" method="post" action="/api/enquiry" novalidate data-enquiry data-sending="${esc(f.fields.sending)}" data-ok="${esc(f.ok)}" data-fail="${esc(f.fail)}">
      <input type="hidden" name="lang" value="${lang}">
      <p class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
      <div class="form__row">
        ${field('name', f.fields.name, `<input id="f-name" name="name" required maxlength="120" autocomplete="name">`)}
        ${field('brand', f.fields.brand, `<input id="f-brand" name="brand" required maxlength="160" autocomplete="organization">`)}
      </div>
      <div class="form__row">
        ${field('email', f.fields.email, `<input id="f-email" type="email" name="email" required maxlength="200" autocomplete="email" dir="ltr">`)}
        ${field('phone', f.fields.phone, `<input id="f-phone" type="tel" name="phone" maxlength="40" autocomplete="tel" dir="ltr">`)}
      </div>
      <div class="form__row">
        ${field('category', f.fields.category, `<select id="f-category" name="category" required>${cats}</select>`)}
        ${field('size', f.fields.size, `<select id="f-size" name="size">${sizes}</select>`)}
      </div>
      ${field('message', f.fields.message, `<textarea id="f-message" name="message" rows="4" maxlength="2000"></textarea>`)}
      <button class="btn btn--sand btn--big" type="submit" data-magnetic><span>${esc(f.fields.submit)}</span> ${arrow}</button>
      ${banner}
      <p class="note">${esc(f.privacy)}</p>
    </form>
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/leasing/'), title: L.title, description: L.description, body, image: 'ribbons', ...ctx });
}

function notFound(lang, ctx) {
  const c = content[lang];
  const body = `
<section class="section nf" data-theme="forest">
  <div class="wrap nf__inner">
    ${logoSvg({ cls: 'nf__logo' })}
    <h1 class="display">${esc(c.notFound.title)}</h1>
    <p class="lede">${esc(c.notFound.body)}</p>
    <a class="btn btn--sand" href="${p(lang, '/')}">${esc(c.notFound.back)}</a>
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/404'), title: `${c.notFound.title} | The Wave`, description: c.notFound.body, body, loader: false, ...ctx });
}

module.exports = { home, story, experience, location, leasing, notFound };
