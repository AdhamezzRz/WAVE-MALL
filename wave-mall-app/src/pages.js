'use strict';

const { content } = require('./content');
const { COORDS, FLOORS, GROUND_UNITS, STREET_UNITS, FACTS } = require('./data');
const journal = require('./journal');
const { floorSvg } = require('./plan');
const { esc, picture, frame, imgUrl, link, arrow, label, title, num, crumbs, crumbsLd, newsletter, fmtDate, layout, logoSvg } = require('./render');

const mapUrl = `https://www.google.com/maps?q=${COORDS.lat},${COORDS.lng}`;
const p = (lang, path) => (lang === 'en' ? path : `/ar${path}`);
const postUrl = (lang, post) => p(lang, `/journal/${post.slug}/`);
const base = (ctx) => (ctx.siteUrl || '').replace(/\/$/, '');

const field = (name, l, input) => `<div class="field" data-field><label for="f-${name}">${esc(l)}</label>${input}</div>`;
const statusBanner = (status, ok, fail) =>
  status === 'ok'
    ? `<p class="status status--ok" role="status" data-form-status>${esc(ok)}</p>`
    : status === 'error'
      ? `<p class="status status--err" role="alert" data-form-status>${esc(fail)}</p>`
      : `<p class="status" role="status" data-form-status hidden></p>`;
const hp = '<p class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>';

// Page opener: label, two-part title and an optional line.
const opener = (kick, h, intro, extra = '') => `
<section class="opener">
  <div class="wrap">
    ${extra}
    ${kick ? label(kick) : ''}
    ${title(h.a, h.b, 'h1', 'title--xl')}
    ${intro ? `<p class="lead" data-rise>${esc(intro)}</p>` : ''}
  </div>
</section>`;

function card(lang, post, { big = false } = {}) {
  const c = content[lang];
  const t = post[lang];
  return `
<article class="card ${big ? 'card--big' : ''}">
  <a class="card__media" href="${postUrl(lang, post)}" tabindex="-1" aria-hidden="true" data-wipe><span class="frame__clip">${picture(post.img, '', { sizes: big ? '(min-width: 900px) 60vw, 100vw' : '(min-width: 900px) 33vw, 100vw' })}</span></a>
  <div class="card__body" data-rise>
    <p class="label"><span>${esc(post.tag[lang])}</span> · <time datetime="${post.date}">${fmtDate(post.date, lang)}</time> · <span>${journal.readingMinutes(t.body)} ${esc(c.journal.minutes)}</span></p>
    <h3 class="card__title"><a href="${postUrl(lang, post)}">${esc(t.title)}</a></h3>
    <p class="card__text">${esc(t.excerpt)}</p>
  </div>
</article>`;
}

// The floor directory: an elevator panel beside the plan of the chosen floor.
function directory(lang, { open = 'G', id = 'dir' } = {}) {
  const c = content[lang];
  const d = c.building.directory;
  const buttons = FLOORS.map(
    (f) => `<button type="button" class="dir__btn" data-floor-btn="${f.id}" aria-pressed="${f.id === open}"><b>${f.id}</b><span>${esc(c.floorNames[f.id])}</span><i>${f.area ? `${num(f.area, lang)} ${c.unit}` : `${f.units} ${esc(d.units)}`}</i></button>`,
  ).join('');
  const plans = FLOORS.map((f) => {
    const facts = [];
    if (f.area) facts.push(`<p class="dir__big"><span data-count="${f.area}">${num(f.area, lang)}</span> <small>${c.unit}</small></p><p class="label">${esc(d.area)}</p>`);
    if (f.units) facts.push(`<p class="dir__big"><span data-count="${f.units}">${f.units}</span></p><p class="label">${esc(d.units)}</p>`);
    const more = [f.spaces ? `${num(f.spaces, lang)} ${esc(d.spaces)}` : '', f.street ? `${f.street} ${esc(d.street)}` : '', f.terraces ? esc(d.terraces) : ''].filter(Boolean);
    return `<div class="dir__floor" data-floor-panel="${f.id}" ${f.id === open ? '' : 'hidden'}>
      ${floorSvg(f.id, { id: `${id}${f.id}`, label: `${c.floorNames[f.id]} · plan` })}
      <div class="dir__facts">${facts.join('')}${more.map((m) => `<p class="dir__more">${m}</p>`).join('')}</div>
    </div>`;
  }).join('');
  return `
<section class="dir" id="directory" data-directory>
  <div class="wrap dir__grid">
    <div class="dir__head">${label(d.kicker)}${title(d.title, '', 'h2')}<p class="dir__hint label">${esc(d.hint)}</p></div>
    <div class="dir__panel" role="group" aria-label="${esc(d.kicker)}">${buttons}</div>
    <div class="dir__stage">${plans}<p class="label dir__note">${esc(d.indicative)}</p></div>
  </div>
</section>`;
}

/* ---------- home ---------- */
function home(lang, ctx) {
  const c = content[lang];
  const h = c.home;
  const figures = h.figures
    .map(([key, text]) => {
      const n = FACTS[key];
      return `<li data-rise><p class="fig__num"><span data-count="${n}">${num(n, lang)}</span>${key === 'employees' ? '+' : ''}</p><p class="fig__text">${esc(text)}</p></li>`;
    })
    .join('');
  const scenes = h.scenes
    .map((s, i) => `<article class="scene scene--${i + 1}">${frame(s.img, s.name, { sizes: '(min-width: 900px) 30vw, 82vw' })}<div class="scene__text" data-rise><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p></div></article>`)
    .join('');
  const latest = journal.sorted().slice(0, 2);

  const lights = h.lights.items
    .map(
      (it, i) => `<figure class="lights__slide" data-light="${i}">${picture(it.img, `${c.brand} · ${it.name}`, { eager: i === 0, sizes: '100vw' })}</figure>`,
    )
    .join('');
  const lightsText = h.lights.items
    .map((it, i) => `<li data-light-text="${i}" ${i ? '' : 'class="is-on"'}><span class="lights__time">${esc(it.time)}</span><span class="lights__name">${esc(it.name)}</span><span class="lights__text">${esc(it.text)}</span></li>`)
    .join('');

  const body = `
<section class="hero" data-hero>
  <div class="wrap hero__head">
    <p class="label" data-hero-kicker>${esc(h.hero.kicker)}</p>
    <h1 class="title title--hero" data-hero-title><span class="hero__a">${esc(h.hero.a)}</span> <em class="hero__b">${esc(h.hero.b)}</em></h1>
    <p class="label hero__meta" data-hero-meta><i></i>${esc(h.hero.meta)}</p>
  </div>
  <div class="hero__frame" data-hero-frame>
    ${picture('night', lang === 'en' ? 'The Wave on North 90, New Cairo, at night: lit ribbon balconies and the rooftop sign.' : 'ذا ويف على التسعين الشمالي ليلاً: شرفات مضاءة واللافتة على السطح.', { eager: true, cls: 'hero__img' })}
  </div>
</section>

<section class="lights" data-lights>
  <div class="lights__stage">
    <div class="lights__slides">${lights}</div>
    <div class="lights__ui">
      <p class="label">${esc(h.lights.kicker)}</p>
      <ol class="lights__list">${lightsText}</ol>
      <div class="lights__bar" aria-hidden="true"><i data-lights-bar></i></div>
    </div>
  </div>
</section>

<section class="statement" id="statement"><div class="wrap"><p class="statement__text" data-rise>${esc(h.statement)}</p></div></section>

<section class="figs"><div class="wrap"><ul class="figs__list">${figures}</ul></div></section>

<section class="scenes"><div class="wrap scenes__row" data-snap>${scenes}</div></section>

<section class="teaser-plan">
  <div class="wrap teaser-plan__grid">
    <div>${label(h.directory.kicker)}${title(h.directory.title, '', 'h2')}${link(p(lang, '/the-wave/#directory'), h.directory.more)}</div>
    <div class="teaser-plan__svg" data-draw>${floorSvg('G', { id: 'home', label: c.floorNames.G })}</div>
  </div>
</section>

<section class="place">
  <div class="place__map" data-wipe><div class="frame__clip">${picture('map', c.visit.mapAlt, { sizes: '100vw' })}</div><span class="place__pin" style="--x:55.2%;--y:44%"><i></i><b>${esc(c.brand)}</b></span></div>
  <div class="wrap place__text">${label(h.place.kicker)}<p class="lead" data-rise>${esc(h.place.text)}</p>${link(p(lang, '/visit/'), h.place.more)}</div>
</section>

<section class="journal-teaser">
  <div class="wrap">
    <div class="row-head">${label(h.journal.kicker)}${link(p(lang, '/journal/'), h.journal.more)}</div>
    <div class="cards cards--2">${latest.map((post) => card(lang, post)).join('')}</div>
  </div>
</section>

<section class="cta cta--sand">
  <div class="wrap cta__grid">
    ${label(h.lease.kicker)}
    <p class="cta__text" data-rise>${esc(h.lease.text)}</p>
    ${link(p(lang, '/leasing/'), h.lease.more, 'link--big')}
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/'), title: h.title, description: h.description, body, image: 'night', seo: { image: 'night' }, ...ctx });
}

/* ---------- the building ---------- */
function building(lang, ctx) {
  const c = content[lang];
  const b = c.building;
  const [g1, g2, g3, g4] = b.gallery;
  const body = `
${opener(c.nav[1][1], b.hero, null)}
<section class="wide">${frame('corner', g3.cap, { cls: 'frame--wide', cap: g3.cap })}</section>
<section class="statement"><div class="wrap"><p class="statement__text" data-rise>${esc(b.intro)}</p></div></section>
<section class="gallery"><div class="wrap gallery__grid">
  ${frame(g1.img, g1.cap, { cls: 'gallery__a', cap: g1.cap, sizes: '(min-width: 900px) 45vw, 100vw' })}
  ${frame(g2.img, g2.cap, { cls: 'gallery__b', cap: g2.cap, sizes: '(min-width: 900px) 35vw, 100vw' })}
  ${frame(g4.img, g4.cap, { cls: 'gallery__c', cap: g4.cap, sizes: '(min-width: 900px) 70vw, 100vw' })}
</div></section>
${directory(lang)}
<section class="mark" data-mark>
  <div class="wrap mark__grid">
    <div class="mark__logo">${logoSvg({ outline: true })}</div>
    <div>${label(b.mark.kicker)}<p class="lead" data-rise>${esc(b.mark.text)}</p></div>
  </div>
</section>
<section class="cta cta--sand"><div class="wrap cta__grid">${label(c.home.lease.kicker)}<p class="cta__text" data-rise>${esc(c.home.lease.text)}</p>${link(p(lang, '/leasing/'), c.home.lease.more, 'link--big')}</div></section>`;
  const jsonld = [crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/the-wave/'), c.nav[1][1]]], base(ctx))];
  return layout({ lang, pathname: p(lang, '/the-wave/'), title: b.title, description: b.description, body, image: 'corner', seo: { image: 'corner', jsonld }, ...ctx });
}

/* ---------- experience ---------- */
function experience(lang, ctx) {
  const c = content[lang];
  const e = c.experience;
  const chapters = e.chapters
    .map(
      (ch, i) => `
  <article class="hour hour--${i % 2 ? 'b' : 'a'}">
    <div class="hour__time" data-rise><span>${esc(ch.time)}</span><p class="label">${esc(ch.name)}</p></div>
    ${frame(ch.img, ch.name, { sizes: '(min-width: 900px) 50vw, 100vw' })}
    <p class="hour__text" data-rise>${esc(ch.text)}</p>
  </article>`,
    )
    .join('');
  const list = e.list.items.map((it, i) => `<li data-rise><i>0${i + 1}</i>${esc(it)}</li>`).join('');
  const body = `
${opener(c.nav[2][1], e.hero, null)}
<section class="hours"><div class="wrap">${chapters}</div></section>
<section class="list"><div class="wrap list__grid">${label(e.list.title)}<ol class="list__items">${list}</ol><p class="label list__note">${esc(e.note)}</p></div></section>`;
  const jsonld = [crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/experience/'), c.nav[2][1]]], base(ctx))];
  return layout({ lang, pathname: p(lang, '/experience/'), title: e.title, description: e.description, body, image: null, seo: { image: 'terrace', jsonld }, ...ctx });
}

/* ---------- leasing ---------- */
function unitTable(lang, rows, l, kind) {
  const total = rows.reduce((t, r) => [t[0] + r[1], t[1] + r[2]], [0, 0]);
  return `<table class="units" data-units="${kind}">
    <thead><tr><th scope="col">${esc(l.unit)}</th><th scope="col">${esc(l.indoor)}</th><th scope="col">${esc(l.outdoor)}</th><th scope="col">${esc(l.total)}</th></tr></thead>
    <tbody>${rows.map(([n, a, b]) => `<tr data-unit-row="${n}" tabindex="0"><th scope="row">${kind === 'street' ? 'S' : 'G'}${String(n).padStart(2, '0')}</th><td>${num(a, lang)}</td><td>${num(b, lang)}</td><td>${num(a + b, lang)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th scope="row">${esc(l.total)}</th><td>${num(total[0], lang)}</td><td>${num(total[1], lang)}</td><td>${num(total[0] + total[1], lang)}</td></tr></tfoot>
  </table>`;
}

function leasing(lang, ctx) {
  const c = content[lang];
  const L = c.leasing;
  const f = L.form.fields;
  const why = L.why.map(([n, t]) => `<li data-rise><p class="fig__num">${esc(n)}</p><p class="fig__text">${esc(t)}</p></li>`).join('');
  const body = `
${opener(c.nav[3][1], L.hero, L.intro)}
<section class="figs figs--3"><div class="wrap"><ul class="figs__list">${why}</ul></div></section>
<section class="schedule" data-schedule>
  <div class="wrap">
    <div class="tabs" role="tablist">
      <button role="tab" type="button" aria-selected="true" aria-controls="tab-ground" id="t-ground" data-tab="ground">${esc(L.tabs.ground)} <i>${GROUND_UNITS.length}</i></button>
      <button role="tab" type="button" aria-selected="false" aria-controls="tab-street" id="t-street" data-tab="street">${esc(L.tabs.street)} <i>${STREET_UNITS.length}</i></button>
    </div>
    <div class="schedule__pane" id="tab-ground" role="tabpanel" aria-labelledby="t-ground" data-pane="ground">
      <div class="schedule__plan" data-draw>${floorSvg('G', { id: 'lease', label: L.tabs.ground })}</div>
      <div class="schedule__table">${unitTable(lang, GROUND_UNITS, L.table, 'ground')}</div>
    </div>
    <div class="schedule__pane" id="tab-street" role="tabpanel" aria-labelledby="t-street" data-pane="street" hidden>
      <div class="schedule__plan" data-draw>${floorSvg('B1', { id: 'leaseb', label: L.tabs.street })}</div>
      <div class="schedule__table">${unitTable(lang, STREET_UNITS, L.table, 'street')}</div>
    </div>
    <p class="label schedule__note">${esc(L.table.note)}</p>
  </div>
</section>
<section class="enquire" id="enquire">
  <div class="wrap enquire__grid">
    <div>${title(L.form.title, '', 'h2')}</div>
    <form class="form" method="post" action="/api/enquiry" novalidate data-form="leasing" data-sending="${esc(f.sending)}" data-ok="${esc(L.form.ok)}" data-fail="${esc(L.form.fail)}">
      <input type="hidden" name="lang" value="${lang}">${hp}
      <div class="form__row">${field('name', f.name, '<input id="f-name" name="name" required maxlength="120" autocomplete="name">')}${field('brand', f.brand, '<input id="f-brand" name="brand" required maxlength="160" autocomplete="organization">')}</div>
      <div class="form__row">${field('email', f.email, '<input id="f-email" type="email" name="email" required maxlength="200" autocomplete="email" dir="ltr">')}${field('phone', f.phone, '<input id="f-phone" type="tel" name="phone" maxlength="40" autocomplete="tel" dir="ltr">')}</div>
      ${field('message', f.message, '<textarea id="f-message" name="message" rows="3" maxlength="2000"></textarea>')}
      <div class="form__foot"><button class="btn" type="submit"><span>${esc(f.submit)}</span>${arrow}</button><p class="label">${esc(L.form.privacy)}</p></div>
      ${statusBanner(ctx.status, L.form.ok, L.form.fail)}
    </form>
  </div>
</section>`;
  const jsonld = [crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/leasing/'), c.nav[3][1]]], base(ctx))];
  return layout({ lang, pathname: p(lang, '/leasing/'), title: L.title, description: L.description, body, seo: { image: 'boutique', jsonld }, ...ctx });
}

/* ---------- visit ---------- */
const PINS = [['plot', 55.2, 44], ['north90', 50, 15], ['south90', 46, 90], ['airforce', 74, 70], ['nasaaem', 74, 47], ['nbk', 55.5, 61], ['fab', 40, 56]];
function visit(lang, ctx) {
  const c = content[lang];
  const v = c.visit;
  const pins = PINS.map(([id, x, y]) => `<span class="pin ${id === 'plot' ? 'pin--plot' : ''}" style="--x:${x}%;--y:${y}%"><i></i><b>${esc(v.labels[id])}</b></span>`).join('');
  const rows = v.rows.map(([k, t]) => `<div class="row" data-rise><p class="label">${esc(k)}</p><p>${esc(t)}</p></div>`).join('');
  const body = `
${opener(c.nav[5][1], v.hero, v.intro)}
<section class="map"><div class="wrap"><div class="map__frame" data-wipe><div class="frame__clip">${picture('map', v.mapAlt, { sizes: '100vw' })}</div><div class="map__pins" data-pins>${pins}</div></div>
<div class="map__foot"><address class="label">${esc(v.address)}</address>${link(mapUrl, v.button, '', 'target="_blank" rel="noopener"')}</div></div></section>
<section class="rows"><div class="wrap rows__list">${rows}</div></section>`;
  const jsonld = [crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/visit/'), c.nav[5][1]]], base(ctx))];
  return layout({ lang, pathname: p(lang, '/visit/'), title: v.title, description: v.description, body, seo: { image: 'aerial', jsonld }, ...ctx });
}

/* ---------- journal ---------- */
function journalIndex(lang, ctx) {
  const c = content[lang];
  const j = c.journal;
  const [first, ...rest] = journal.sorted();
  const b = base(ctx);
  const jsonld = [
    {
      '@type': 'Blog',
      '@id': `${b}${p(lang, '/journal/')}#blog`,
      name: j.title,
      description: j.description,
      url: `${b}${p(lang, '/journal/')}`,
      inLanguage: lang,
      publisher: { '@id': `${b}/#org` },
      blogPost: journal.sorted().map((post) => ({ '@type': 'BlogPosting', headline: post[lang].title, url: `${b}${postUrl(lang, post)}`, datePublished: post.date, image: `${b}${imgUrl(post.img)}` })),
    },
    crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/journal/'), c.nav[4][1]]], b),
  ];
  const body = `
${opener(null, j.hero, j.intro)}
<section class="journal"><div class="wrap">
  ${card(lang, first, { big: true })}
  <div class="cards cards--3">${rest.map((post) => card(lang, post)).join('')}</div>
  <p class="label journal__feed"><a href="${p(lang, '/journal/feed.xml')}">${esc(j.feed)}</a></p>
</div></section>`;
  return layout({ lang, pathname: p(lang, '/journal/'), title: j.title, description: j.description, body, image: first.img, seo: { jsonld, image: first.img }, ...ctx });
}

function journalPost(lang, post, ctx) {
  const c = content[lang];
  const j = c.journal;
  const t = post[lang];
  const b = base(ctx);
  const url = `${b}${postUrl(lang, post)}`;
  const trail = [[p(lang, '/'), c.crumbs.home], [p(lang, '/journal/'), c.nav[4][1]], [postUrl(lang, post), t.title]];
  const jsonld = [
    {
      '@type': 'BlogPosting',
      '@id': `${url}#post`,
      headline: t.title,
      description: t.excerpt,
      image: `${b}${imgUrl(post.img)}`,
      datePublished: post.date,
      dateModified: post.date,
      inLanguage: lang,
      url,
      mainEntityOfPage: url,
      articleSection: post.tag[lang],
      wordCount: t.body.split(/\s+/).length,
      author: { '@type': 'Organization', name: 'The Wave', '@id': `${b}/#org` },
      publisher: { '@id': `${b}/#org` },
      isPartOf: { '@id': `${b}${p(lang, '/journal/')}#blog` },
    },
    crumbsLd(trail, b),
  ];
  const share = {
    wa: `https://wa.me/?text=${encodeURIComponent(`${t.title} ${url}`)}`,
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(t.title)}&url=${encodeURIComponent(url)}`,
  };
  const body = `
<article class="article">
  <header class="opener opener--article"><div class="wrap">
    ${crumbs(trail)}
    <p class="label" data-rise>${esc(post.tag[lang])} · <time datetime="${post.date}">${fmtDate(post.date, lang)}</time> · ${journal.readingMinutes(t.body)} ${esc(j.minutes)}</p>
    <h1 class="title title--article" data-rise>${esc(t.title)}</h1>
    <p class="lead" data-rise>${esc(t.excerpt)}</p>
  </div></header>
  <div class="wide">${frame(post.img, t.title, { cls: 'frame--wide' })}</div>
  <div class="wrap article__body">
    <div class="prose">${journal.renderBody(t.body, esc)}</div>
    <div class="share"><span class="label">${esc(j.share)}</span><button type="button" data-copy="${esc(url)}" data-copied="${esc(j.copied)}">${esc(j.copy)}</button><a href="${share.wa}" target="_blank" rel="noopener">WhatsApp</a><a href="${share.x}" target="_blank" rel="noopener">X</a></div>
  </div>
</article>
<section class="journal-teaser"><div class="wrap">
  <div class="row-head">${label(j.more)}${link(p(lang, '/journal/'), j.all)}</div>
  <div class="cards cards--2">${journal.related(post).map((r) => card(lang, r)).join('')}</div>
</div></section>`;
  return layout({ lang, pathname: postUrl(lang, post), title: `${t.title} | ${j.title}`, description: t.excerpt, body, image: post.img, seo: { type: 'article', published: post.date, image: post.img, jsonld }, ...ctx });
}

/* ---------- contact ---------- */
function contact(lang, ctx) {
  const c = content[lang];
  const k = c.contact;
  const f = k.fields;
  const subjects = k.subjects.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const faq = k.faq.items.map(([q, a]) => `<details class="faq"><summary>${esc(q)}<i aria-hidden="true"></i></summary><p>${esc(a)}</p></details>`).join('');
  const b = base(ctx);
  const jsonld = [
    { '@type': 'ContactPage', '@id': `${b}${p(lang, '/contact/')}#page`, url: `${b}${p(lang, '/contact/')}`, name: k.title, about: { '@id': `${b}/#org` } },
    { '@type': 'FAQPage', mainEntity: k.faq.items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/contact/'), c.nav[6][1]]], b),
  ];
  const body = `
${opener(null, k.hero, k.intro)}
<section class="contact"><div class="wrap contact__grid">
  <form class="form" method="post" action="/api/contact" novalidate data-form="contact" data-sending="${esc(f.sending)}" data-ok="${esc(k.ok)}" data-fail="${esc(k.fail)}">
    <input type="hidden" name="lang" value="${lang}">${hp}
    <div class="form__row">${field('name', f.name, '<input id="f-name" name="name" required maxlength="120" autocomplete="name">')}${field('email', f.email, '<input id="f-email" type="email" name="email" required maxlength="200" autocomplete="email" dir="ltr">')}</div>
    ${field('subject', f.subject, `<select id="f-subject" name="subject">${subjects}</select>`)}
    ${field('message', f.message, '<textarea id="f-message" name="message" rows="4" required maxlength="3000"></textarea>')}
    <div class="form__foot"><button class="btn" type="submit"><span>${esc(f.submit)}</span>${arrow}</button><p class="label">${esc(k.privacy)}</p></div>
    ${statusBanner(ctx.status, k.ok, k.fail)}
  </form>
  <aside class="contact__side">
    <p class="label">${esc(k.details.title)}</p>
    <a class="contact__mail" href="mailto:${k.details.email}">${esc(k.details.email)}</a>
    <p>${esc(k.details.address)}</p><p>${esc(k.details.hours)}</p>
    ${link(mapUrl, k.details.maps, '', 'target="_blank" rel="noopener"')}
  </aside>
</div></section>
<section class="faqs"><div class="wrap faqs__grid">${label(k.faq.title)}<div>${faq}</div></div></section>`;
  return layout({ lang, pathname: p(lang, '/contact/'), title: k.title, description: k.description, body, seo: { jsonld }, ...ctx });
}

/* ---------- legal ---------- */
function legal(lang, which, ctx) {
  const c = content[lang];
  const L = c.legal[which];
  const body = `
${opener(null, { a: L.title, b: '' }, null)}
<section class="legal"><div class="wrap"><p class="label">${esc(c.legal.updated)} <time datetime="2026-10-25">${fmtDate('2026-10-25', lang)}</time></p>
<div class="prose">${L.sections.map(([h, t]) => `<h2>${esc(h)}</h2><p>${esc(t)}</p>`).join('')}</div></div></section>`;
  return layout({ lang, pathname: p(lang, `/${which}/`), title: `${L.title} | The Wave`, description: L.description, body, ...ctx });
}

function notFound(lang, ctx) {
  const c = content[lang];
  const body = `
<section class="opener opener--tall"><div class="wrap">
  <p class="nf__floor" aria-hidden="true">B3</p>
  ${title(c.notFound.title, '', 'h1', 'title--xl')}
  ${link(p(lang, '/'), c.notFound.back)}
</div></section>`;
  return layout({ lang, pathname: p(lang, '/404'), title: 'The Wave', description: c.notFound.title, body, seo: { noindex: true }, ...ctx });
}

module.exports = { home, story: building, experience, leasing, visit, journalIndex, journalPost, contact, legal, notFound, postUrl };
