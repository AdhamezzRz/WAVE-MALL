'use strict';

const { content, COORDS, LANDMARKS } = require('./content');
const { esc, picture, link, arrow, hero, markSection, layout, logoSvg } = require('./render');

const mapUrl = `https://www.google.com/maps?q=${COORDS.lat},${COORDS.lng}`;
const p = (lang, path) => (lang === 'en' ? path : `/ar${path}`);

function home(lang, ctx) {
  const c = content[lang];
  const h = c.home;
  const chapters = h.chapters
    .map(
      (ch, i) => `
    <article class="chapter chapter--${i % 2 ? 'b' : 'a'}">
      <figure class="frame" data-r="img" data-thread-anchor>${picture(ch.img, ch.alt, { sizes: '(min-width: 900px) 58vw, 100vw' })}</figure>
      <div class="chapter__text">
        <p class="time" data-r>${esc(ch.time)}</p>
        <p class="lead" data-r>${esc(ch.text)}</p>
      </div>
    </article>`,
    )
    .join('');

  const body = `
${hero(h.hero, 'aerial', lang === 'en' ? 'The Wave at dusk: curved ribbon balconies around a plaza of terraces.' : 'ذا ويف عند الغروب: شرفات منحنية حول ساحة من التراسات.', { portrait: 'dusk', meta: h.hero.meta })}

<section class="intro">
  <div class="col"><p class="lead lead--big" data-r>${esc(h.intro)}</p></div>
</section>

<section class="chapters"><div class="col">${chapters}</div></section>

${markSection(c, h.mark, { more: { href: p(lang, '/the-wave/'), label: h.mark.more } })}

<section class="pair">
  <div class="col pair__col">
    <div data-r><p class="lead">${esc(h.visit.text)}</p>${link(p(lang, '/visit/'), h.visit.more)}</div>
    <div data-r><p class="lead">${esc(h.leasing.text)}</p>${link(p(lang, '/leasing/'), h.leasing.more)}</div>
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/'), title: h.title, description: h.description, body, ...ctx });
}

function story(lang, ctx) {
  const c = content[lang];
  const s = c.story;
  const frames = s.frames
    .map((f, i) => `<figure class="frame frame--${i + 1}" data-r="img" data-thread-anchor>${picture(f.img, f.cap, { sizes: '(min-width: 900px) 70vw, 100vw' })}<figcaption class="cap">${esc(f.cap)}</figcaption></figure>`)
    .join('');
  const facts = s.facts.map(([k, v]) => `<div class="row" data-r><span class="cap">${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  const body = `
${hero(s.hero, 'dusk', lang === 'en' ? 'The corner of The Wave at dusk.' : 'زاوية ذا ويف عند الغروب.')}
<section class="intro"><div class="col"><p class="lead lead--big" data-r>${esc(s.intro)}</p></div></section>
<section class="frames"><div class="col frames__col">${frames}</div></section>
<section class="rows"><div class="col rows__col">${facts}</div></section>
${markSection(c, s.mark)}`;
  return layout({ lang, pathname: p(lang, '/the-wave/'), title: s.title, description: s.description, body, image: 'dusk', ...ctx });
}

function visit(lang, ctx) {
  const c = content[lang];
  const v = c.visit;
  const pins = LANDMARKS.map((m) => `<span class="pin ${m.id === 'plot' ? 'pin--plot' : ''}" style="--x:${m.x}%;--y:${m.y}%" data-pin><i></i><b>${esc(v.labels[m.id])}</b></span>`).join('');
  const rows = v.rows.map(([k, t]) => `<div class="row" data-r><span class="cap">${esc(k)}</span><span>${esc(t)}</span></div>`).join('');
  const body = `
<section class="plain">
  <div class="col">
    <h1 class="h1" data-r><span>${esc(v.hero.a)}</span> <em>${esc(v.hero.b)}</em></h1>
    <p class="lead" data-r>${esc(v.intro)}</p>
  </div>
</section>
<section class="map-sec">
  <div class="col">
    <div class="map" data-r="img" data-thread-anchor>${picture('map', v.mapAlt, { eager: true, sizes: '(min-width: 900px) 80vw, 100vw' })}<div class="map__pins">${pins}</div></div>
    <div class="map__foot">
      <address class="cap">${esc(v.address)}</address>
      ${link(mapUrl, v.button, 'link--ext')}
    </div>
  </div>
</section>
<section class="rows"><div class="col rows__col">${rows}</div></section>`;
  return layout({ lang, pathname: p(lang, '/visit/'), title: v.title, description: v.description, body, image: 'map', ...ctx });
}

function leasing(lang, ctx) {
  const c = content[lang];
  const L = c.leasing;
  const f = L.fields;
  const status = ctx.status;
  const banner =
    status === 'ok'
      ? `<p class="status status--ok" role="status" data-form-status>${esc(L.ok)}</p>`
      : status === 'error'
        ? `<p class="status status--err" role="alert" data-form-status>${esc(L.fail)}</p>`
        : `<p class="status" role="status" data-form-status hidden></p>`;
  const field = (name, label, input) => `<div class="field" data-field><label for="f-${name}">${esc(label)}</label>${input}</div>`;
  const body = `
<section class="plain">
  <div class="col">
    <h1 class="h1" data-r><span>${esc(L.hero.a)}</span> <em>${esc(L.hero.b)}</em></h1>
    <p class="lead" data-r>${esc(L.intro)}</p>
  </div>
</section>
<section class="enquire">
  <div class="col enquire__col">
    <form class="form" method="post" action="/api/enquiry" novalidate data-enquiry data-sending="${esc(f.sending)}" data-ok="${esc(L.ok)}" data-fail="${esc(L.fail)}" data-r>
      <input type="hidden" name="lang" value="${lang}">
      <p class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
      ${field('name', f.name, `<input id="f-name" name="name" required maxlength="120" autocomplete="name">`)}
      ${field('brand', f.brand, `<input id="f-brand" name="brand" required maxlength="160" autocomplete="organization">`)}
      ${field('email', f.email, `<input id="f-email" type="email" name="email" required maxlength="200" autocomplete="email" dir="ltr">`)}
      ${field('phone', f.phone, `<input id="f-phone" type="tel" name="phone" maxlength="40" autocomplete="tel" dir="ltr">`)}
      ${field('message', f.message, `<textarea id="f-message" name="message" rows="3" maxlength="2000"></textarea>`)}
      <div class="form__foot">
        <button class="btn" type="submit"><span>${esc(f.submit)}</span>${arrow}</button>
        <p class="cap">${esc(L.privacy)}</p>
      </div>
      ${banner}
    </form>
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/leasing/'), title: L.title, description: L.description, body, image: null, ...ctx });
}

function notFound(lang, ctx) {
  const c = content[lang];
  const body = `
<section class="plain plain--tall">
  <div class="col">
    ${logoSvg({ cls: 'nf__logo' })}
    <h1 class="h1">${esc(c.notFound.title)}</h1>
    ${link(p(lang, '/'), c.notFound.back)}
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/404'), title: `The Wave`, description: c.notFound.title, body, loader: false, ...ctx });
}

module.exports = { home, story, visit, leasing, notFound };
