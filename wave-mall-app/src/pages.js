'use strict';

const { content } = require('./content');
const { COORDS, FLOORS, GROUND_UNITS, STREET_UNITS, FACTS } = require('./data');
const journal = require('./journal');
const { floorSvg } = require('./plan');
const { areaMap } = require('./map');
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

  const body = `
<section class="hero" data-hero>
  <div class="hero__media" data-hero-frame>
    ${h.hero.slides.map((sl, i) => `<figure class="hero__slide${i ? '' : ' is-on'}" data-hero-slide>${picture(sl.img, sl.alt, { eager: !i, cls: 'hero__img' })}</figure>`).join('')}
    <svg class="hero__window" data-hero-window viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><path fill-rule="evenodd" d="M0 0H1V1H0Z"/></svg>
  </div>
  <div class="wrap hero__content">
    <p class="label hero__kicker" data-hero-kicker>${esc(h.hero.kicker)}</p>
    <h1 class="title title--hero" data-hero-title><span class="hero__a">${esc(h.hero.a)}</span> <em class="hero__b">${esc(h.hero.b)}</em></h1>
    <div class="hero__foot">
      <p class="label hero__meta" data-hero-meta><i></i>${esc(h.hero.meta)}</p>
      <ol class="hero__times" data-hero-times>${h.hero.slides.map((sl, i) => `<li${i ? '' : ' class="is-on"'}><b>${esc(sl.time)}</b><span>${esc(sl.name)}</span><i><u></u></i></li>`).join('')}</ol>
      <a class="label hero__scroll" href="#statement" data-hero-scroll><span>${esc(h.hero.scroll)}</span><i></i></a>
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
  <div class="wrap place__text">${label(h.place.kicker)}<p class="lead" data-rise>${esc(h.place.text)}</p>${link(p(lang, '/visit/'), h.place.more)}</div>
  <div class="wrap">${areaMap(lang)}</div>
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
  return layout({ lang, pathname: p(lang, '/'), title: h.title, description: h.description, body, image: 'morning', seo: { image: 'morning' }, ...ctx });
}

/* ---------- the building ---------- */
function building(lang, ctx) {
  const c = content[lang];
  const b = c.building;
  const [g1, g2, g3, g4] = b.gallery;
  const body = `
${opener(c.nav[1][1], b.hero, null)}
<section class="wide">${frame(g3.img, g3.cap, { cls: 'frame--wide', cap: g3.cap })}</section>
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
  return layout({ lang, pathname: p(lang, '/the-wave/'), title: b.title, description: b.description, body, image: 'aerial', seo: { image: 'aerial', jsonld }, ...ctx });
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
  return layout({ lang, pathname: p(lang, '/experience/'), title: e.title, description: e.description, body, image: null, seo: { image: 'axis', jsonld }, ...ctx });
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
<section class="wide wide--pad">${frame('axis', lang === 'en' ? 'The plaza stair and shopfronts' : 'درج الساحة والواجهات', { cls: 'frame--wide', cap: lang === 'en' ? 'The plaza stair and shopfronts' : 'درج الساحة والواجهات' })}</section>
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
  return layout({ lang, pathname: p(lang, '/leasing/'), title: L.title, description: L.description, body, seo: { image: 'shopfronts', jsonld }, ...ctx });
}

/* ---------- visit ---------- */
function visit(lang, ctx) {
  const c = content[lang];
  const v = c.visit;
  const rows = v.rows.map(([k, t]) => `<div class="row" data-rise><p class="label">${esc(k)}</p><p>${esc(t)}</p></div>`).join('');
  const body = `
${opener(c.nav[5][1], v.hero, v.intro)}
<section class="map"><div class="wrap">${areaMap(lang)}
<div class="map__foot"><address class="label">${esc(v.address)}</address>${link(mapUrl, v.button, '', 'target="_blank" rel="noopener"')}</div></div></section>
<section class="wide">${frame('north90', c.building.gallery[3].cap, { cls: 'frame--wide', cap: c.building.gallery[3].cap })}</section>
<section class="rows"><div class="wrap rows__list">${rows}</div></section>`;
  const jsonld = [crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/visit/'), c.nav[5][1]]], base(ctx))];
  return layout({ lang, pathname: p(lang, '/visit/'), title: v.title, description: v.description, body, seo: { image: 'plaza', jsonld }, ...ctx });
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
    crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/contact/'), c.nav.at(-1)[1]]], b),
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

/* ---------- the store directory, events and offers ----------
   Content comes from the leasing office (src/admin/routes/website.js) through src/app.js; each page
   gets plain data in both languages. When the office is not available the pages say "coming soon". */
const shopUrl = (lang, slug) => p(lang, `/stores/${slug}/`);
const eventUrl = (lang, slug) => p(lang, `/events/${slug}/`);
const LOCALE = (lang) => (lang === 'ar' ? 'ar-EG' : 'en-GB'); // Arabic digits in Arabic, like the journal and the rest of the site
const day = (iso, lang, opts = { day: 'numeric', month: 'long', year: 'numeric' }) => new Intl.DateTimeFormat(LOCALE(lang), { timeZone: 'UTC', ...opts }).format(new Date(`${iso}T00:00:00Z`));
const days = (a, b, lang) => (!b || b === a ? day(a, lang) : new Intl.DateTimeFormat(LOCALE(lang), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).formatRange(new Date(`${a}T00:00:00Z`), new Date(`${b}T00:00:00Z`)));
const hours = (e) => (e.timeFrom ? `${e.timeFrom}${e.timeTo ? `–${e.timeTo}` : ''}` : '');
const fill = (s, o) => String(s).replace(/\{(\w+)\}/g, (m, k) => (o[k] !== undefined ? o[k] : m));
const paras = (text) => String(text || '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).map((x) => `<p>${esc(x).replace(/\n/g, '<br>')}</p>`).join('');
const storeCount = (lang, n) => {
  const f = content[lang].shops.count;
  if (lang === 'en') return fill(n === 1 ? f[0] : f[1], { n });
  const x = n % 100;
  return fill(n === 1 ? f[0] : n === 2 ? f[1] : x >= 3 && x <= 10 ? f[2] : f[3], { n });
};
const catName = (lang, k) => content[lang].shops.categories[k] || content[lang].shops.categories.other;
const unitsLine = (lang, s) => {
  const t = content[lang].shops;
  if (!s.units.length) return '';
  const lv = s.units[0].level === 'B1' ? 'B1' : 'G';
  return `${t.levels[lv]} · ${s.units.map((u) => u.code).join(isAr(lang) ? '، ' : ', ')}`;
};
const isAr = (lang) => lang === 'ar';
const img = (src, alt, cls = '', eager = false) => (src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">` : '');
const initials = (name) => esc(String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
// The plan of a level with listed stores marked (is-shop) and, on a store's page, its own units (is-here).
function shopPlan(lang, level, stores, { id, here = null } = {}) {
  const c = content[lang];
  const mine = new Map();
  for (const s of stores) for (const u of s.units) if ((u.level === 'B1' ? 'B1' : 'G') === level && u.n) mine.set(u.n, s);
  const svg = floorSvg(level, { id, label: `${c.floorNames[level]} · ${c.shops.plan.kicker}` })
    .replace(/class="plan__unit( plan__unit--street)?" data-unit="(\d+)"/g, (all, street, n) => {
      const s = mine.get(Number(n));
      if (!s) return all;
      const isHere = here && here.id === s.id;
      return `class="plan__unit${street || ''} is-shop${isHere ? ' is-here' : ''}" data-unit="${n}" data-shop="${esc(s.slug)}"`;
    });
  return svg.replace('<svg class="plan"', `<svg class="plan plan--shops" data-level="${level}"`);
}
function shopCard(lang, s, { compact = false } = {}) {
  const t = content[lang].shops;
  const name = s.name[lang];
  const keys = [s.name.en, s.name.ar, s.tagline[lang], catName(lang, s.category), ...s.units.map((u) => u.code)].join(' ').toLowerCase();
  return `<li class="shop${compact ? ' shop--compact' : ''}" data-shop="${esc(s.slug)}" data-cat="${esc(s.category)}" data-keys="${esc(keys)}" data-units="${esc(s.units.map((u) => `${u.level === 'B1' ? 'B1' : 'G'}:${u.n}`).join(' '))}">
  <a class="shop__link" href="${shopUrl(lang, s.slug)}">
    <span class="shop__media">${s.cover ? img(s.cover, '', 'shop__cover') : '<span class="shop__cover shop__cover--blank"></span>'}
      <span class="shop__logo">${s.logo ? img(s.logo, '') : `<b>${initials(name)}</b>`}</span>
      ${s.openingSoon ? `<span class="shop__tag">${esc(t.soon)}</span>` : s.featured ? `<span class="shop__tag shop__tag--feat">${esc(t.featured)}</span>` : ''}</span>
    <span class="shop__body"><span class="label">${esc(catName(lang, s.category))}${s.units.length ? ` · ${esc(s.units.map((u) => u.code).join(', '))}` : ''}</span>
      <span class="shop__name">${esc(name)}</span>${s.tagline[lang] ? `<span class="shop__line">${esc(s.tagline[lang])}</span>` : ''}</span>
  </a>
</li>`;
}
function offerCards(lang, promos, { title: heading = null } = {}) {
  if (!promos.length) return '';
  const t = content[lang].shops;
  const today = new Date().toISOString().slice(0, 10);
  return `<section class="offers"><div class="wrap">
  <div class="row-head">${label(heading || t.offers)}</div>
  <ul class="offers__list">${promos.map((o) => `<li class="offer">
    ${o.image ? `<span class="offer__media">${img(o.image, '')}</span>` : ''}
    <div class="offer__body"><p class="label">${o.store ? `<a href="${shopUrl(lang, o.store.slug)}">${esc(o.store.name[lang])}</a> · ` : ''}${esc(fill(o.startsOn > today ? t.from : t.until, { date: day(o.startsOn > today ? o.startsOn : o.endsOn, lang) }))}</p>
      <h3 class="offer__title">${esc(o.title[lang])}</h3>${o.details[lang] ? `<p class="offer__text">${esc(o.details[lang])}</p>` : ''}
      ${o.link ? link(o.link, t.visit, '', 'target="_blank" rel="noopener"') : ''}</div>
  </li>`).join('')}</ul>
</div></section>`;
}
function eventRow(lang, e, { past = false } = {}) {
  const ev = content[lang].events;
  const d = new Date(`${e.startsOn}T00:00:00Z`);
  const fmt = (o) => new Intl.DateTimeFormat(LOCALE(lang), { timeZone: 'UTC', ...o }).format(d);
  return `<li class="ev${past ? ' ev--past' : ''}"><a class="ev__link" href="${eventUrl(lang, e.slug)}">
    <span class="ev__date" aria-hidden="true"><b>${fmt({ day: 'numeric' })}</b><span>${esc(fmt({ month: 'short' }))}</span></span>
    ${past ? '' : `<span class="ev__media">${e.cover ? img(e.cover, '') : '<span class="ev__blank"></span>'}</span>`}
    <span class="ev__body"><span class="label">${esc(days(e.startsOn, e.endsOn, lang))}${hours(e) ? ` · ${esc(hours(e))}` : ''}${e.location[lang] ? ` · ${esc(e.location[lang])}` : ''}</span>
      <span class="ev__title">${esc(e.title[lang])}</span>${!past && e.summary[lang] ? `<span class="ev__text">${esc(e.summary[lang])}</span>` : ''}
      <span class="sr">${esc(ev.when)}: ${esc(days(e.startsOn, e.endsOn, lang))}</span></span>
    ${arrow}
  </a></li>`;
}
const subnav = (lang, on) => {
  const t = content[lang].shops.tabs;
  return `<nav class="subnav" aria-label="${esc(content[lang].shops.kicker)}"><div class="wrap">${[['stores', '/stores/'], ['events', '/events/']].map(([k, href]) => `<a href="${p(lang, href)}"${k === on ? ' aria-current="page"' : ''}>${esc(t[k])}</a>`).join('')}</div></nav>`;
};
const storeLd = (lang, s, b) => {
  const url = `${b}${shopUrl(lang, s.slug)}`;
  const m = String(s.hours).match(/^(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})$/);
  const pad = (x) => String(x).padStart(2, '0');
  return {
    '@type': s.category === 'fnb' ? 'FoodEstablishment' : 'Store', '@id': `${url}#store`, name: s.name[lang], url,
    ...(s.description[lang] || s.tagline[lang] ? { description: s.tagline[lang] || s.description[lang].slice(0, 300) } : {}),
    ...(s.cover ? { image: `${b}${s.cover}` } : {}), ...(s.logo ? { logo: `${b}${s.logo}` } : {}),
    ...(s.phone ? { telephone: s.phone } : {}),
    ...(m ? { openingHours: `Mo-Su ${pad(m[1])}:${m[2]}-${pad(m[3])}:${m[4]}` } : {}),
    address: { '@type': 'PostalAddress', streetAddress: 'North 90 Street, First Sector', addressLocality: 'New Cairo', addressCountry: 'EG' },
    containedInPlace: { '@id': `${b}/#org` },
    ...(s.instagram || s.website ? { sameAs: [s.instagram ? `https://www.instagram.com/${s.instagram}` : null, s.website].filter(Boolean) } : {}),
  };
};
// Cairo's offset on a day (Egypt keeps summer time), for structured data and calendars.
function cairoOffset(iso) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', timeZoneName: 'longOffset' }).formatToParts(new Date(`${iso}T12:00:00Z`)).find((x) => x.type === 'timeZoneName');
    const m = part && part.value.match(/GMT([+-]\d{2}):?(\d{2})?/);
    return m ? `${m[1]}:${m[2] || '00'}` : '+02:00';
  } catch {
    return '+02:00';
  }
}
const eventStart = (e) => (e.timeFrom ? `${e.startsOn}T${e.timeFrom}:00${cairoOffset(e.startsOn)}` : e.startsOn);
const eventEnd = (e) => (e.timeTo ? `${e.endsOn}T${e.timeTo}:00${cairoOffset(e.endsOn)}` : e.endsOn);
const eventLd = (lang, e, b) => ({
  '@type': 'Event', '@id': `${b}${eventUrl(lang, e.slug)}#event`, name: e.title[lang], url: `${b}${eventUrl(lang, e.slug)}`,
  startDate: eventStart(e), endDate: eventEnd(e), eventStatus: 'https://schema.org/EventScheduled', eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  ...(e.summary[lang] ? { description: e.summary[lang] } : {}), ...(e.cover ? { image: [`${b}${e.cover}`] } : {}),
  location: { '@type': 'Place', name: e.location[lang] ? `${e.location[lang]}, The Wave` : 'The Wave', address: { '@type': 'PostalAddress', streetAddress: 'North 90 Street, First Sector', addressLocality: 'New Cairo', addressCountry: 'EG' } },
  organizer: { '@id': `${b}/#org` }, inLanguage: lang,
});

// The office is not available (or has nothing to show yet): a calm page, never an error.
function shopsSoon(lang, ctx, which = 'stores') {
  const c = content[lang];
  const t = c.shops;
  const body = `
${opener(which === 'events' ? c.events.kicker : t.kicker, { a: t.soonPage.a, b: t.soonPage.b }, t.soonPage.text)}
${subnav(lang, which)}
<section class="shops shops--soon"><div class="wrap"><div class="shops__soon">${link(p(lang, '/leasing/'), t.empty.cta)}${link(p(lang, '/contact/'), c.nav.at(-1)[1])}</div></div></section>`;
  return layout({ lang, pathname: p(lang, which === 'events' ? '/events/' : '/stores/'), title: which === 'events' ? c.events.title : t.title, description: which === 'events' ? c.events.description : t.description, body, seo: { image: 'shopfronts', noindex: true }, ...ctx });
}

function storesIndex(lang, ctx, data) {
  const c = content[lang];
  const t = c.shops;
  const b = base(ctx);
  const { stores, promos = [], events = [], intro = '', q = '', cat = '' } = data;
  const cats = [...new Set(stores.map((s) => s.category))].sort((x, y) => Object.keys(t.categories).indexOf(x) - Object.keys(t.categories).indexOf(y));
  const needle = String(q).trim().toLowerCase();
  const shown = stores.filter((s) => (!cat || s.category === cat) && (!needle || [s.name.en, s.name.ar, s.tagline[lang], catName(lang, s.category), ...s.units.map((u) => u.code)].join(' ').toLowerCase().includes(needle)));
  const levels = ['G', 'B1'].filter((lv) => stores.some((s) => s.units.some((u) => (u.level === 'B1' ? 'B1' : 'G') === lv)));
  const chip = (k, l) => `<a class="chip" href="${p(lang, '/stores/')}${k ? `?cat=${k}` : ''}" data-cat="${k}"${(cat || '') === k ? ' aria-current="true"' : ''}>${esc(l)}</a>`;
  const list = stores.length
    ? `<form class="shops__bar" role="search" method="get" action="${p(lang, '/stores/')}" data-shops-form>
    <label class="shops__search"><span class="sr">${esc(t.search)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><input type="search" name="q" value="${esc(q)}" placeholder="${esc(t.search)}" autocomplete="off" data-shops-q>${cat ? `<input type="hidden" name="cat" value="${esc(cat)}">` : ''}<button class="sr" type="submit">${esc(t.searchButton)}</button></label>
    <div class="chips" role="group" aria-label="${esc(t.kicker)}">${chip('', t.all)}${cats.map((k) => chip(k, catName(lang, k))).join('')}</div>
    <p class="label shops__count" role="status" data-shops-count data-forms="${esc(JSON.stringify(t.count))}">${esc(storeCount(lang, shown.length))}</p>
  </form>
  <div class="shops__grid">
    <ul class="shops__list" data-shops-list>${stores.map((s) => shopCard(lang, s).replace('<li class="shop', shown.includes(s) ? '<li class="shop' : '<li hidden class="shop')).join('')}</ul>
    <aside class="shops__plan" aria-label="${esc(t.plan.kicker)}">
      <p class="label">${esc(t.plan.kicker)}</p>
      ${levels.map((lv) => `<figure class="shops__level"><figcaption class="label">${esc(t.levels[lv])}</figcaption>${shopPlan(lang, lv, stores, { id: `sp${lv}` })}</figure>`).join('')}
      <p class="shops__hint">${esc(t.plan.hint)}</p>
      ${link(p(lang, '/the-wave/#directory'), t.plan.all)}
    </aside>
  </div>
  <div class="shops__none" data-shops-none${shown.length ? ' hidden' : ''}><p>${esc(t.none)}</p>${link(p(lang, '/stores/'), t.clear, '', 'data-shops-clear')}</div>`
    : `<div class="shops__empty">${title(t.empty.a, t.empty.b, 'h2')}<p class="lead">${esc(t.empty.text)}</p>${link(p(lang, '/leasing/'), t.empty.cta)}</div>`;
  const next = events.slice(0, 3);
  const body = `
${opener(t.kicker, t.hero, intro || t.intro)}
${subnav(lang, 'stores')}
<section class="shops" data-shops><div class="wrap">${list}</div></section>
${offerCards(lang, promos)}
${next.length ? `<section class="events events--teaser"><div class="wrap"><div class="row-head">${label(t.next)}${link(p(lang, '/events/'), t.allEvents)}</div><ul class="evlist">${next.map((e) => eventRow(lang, e)).join('')}</ul></div></section>` : ''}`;
  const jsonld = [
    crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/stores/'), c.nav.at(-2)[1]]], b),
    { '@type': 'ItemList', name: t.title, itemListElement: stores.map((s, i) => ({ '@type': 'ListItem', position: i + 1, url: `${b}${shopUrl(lang, s.slug)}`, name: s.name[lang] })) },
  ];
  return layout({ lang, pathname: p(lang, '/stores/'), title: t.title, description: t.description, body, seo: { image: 'shopfronts', jsonld, noindex: !!(q || cat) }, ...ctx });
}

function storePage(lang, ctx, s, { all = [], promos = [] } = {}) {
  const c = content[lang];
  const t = c.shops;
  const b = base(ctx);
  const name = s.name[lang];
  const trail = [[p(lang, '/'), c.crumbs.home], [p(lang, '/stores/'), c.nav.at(-2)[1]], [shopUrl(lang, s.slug), name]];
  const lv = s.units.length && s.units[0].level === 'B1' ? 'B1' : 'G';
  const facts = [
    s.units.length ? [t.where, `${esc(unitsLine(lang, s))}`] : null,
    s.hours ? [t.hours, `<span dir="ltr">${esc(s.hours)}</span>`] : null,
    s.phone ? [t.phone, `<a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}" dir="ltr">${esc(s.phone)}</a>`] : null,
    s.instagram ? [t.instagram, `<a href="https://www.instagram.com/${esc(s.instagram)}" target="_blank" rel="noopener" dir="ltr">@${esc(s.instagram)}</a>`] : null,
    s.website ? [t.website, `<a href="${esc(s.website)}" target="_blank" rel="noopener" dir="ltr">${esc(s.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`] : null,
  ].filter(Boolean);
  const more = all.filter((x) => x.id !== s.id && x.category === s.category).slice(0, 3);
  const others = more.length ? more : all.filter((x) => x.id !== s.id).slice(0, 3);
  const body = `
<section class="opener opener--shop"><div class="wrap">
  ${crumbs(trail)}
  <div class="shophero">
    <div class="shophero__text">
      <p class="label" data-rise>${esc(catName(lang, s.category))}${s.openingSoon ? ` · <span class="shophero__soon">${esc(s.openingDate ? fill(t.opens, { date: day(s.openingDate, lang) }) : t.soon)}</span>` : ''}</p>
      ${title(name, '', 'h1', 'title--xl shophero__name')}
      ${s.tagline[lang] ? `<p class="lead" data-rise>${esc(s.tagline[lang])}</p>` : ''}
    </div>
    <div class="shophero__logo" data-rise>${s.logo ? img(s.logo, name) : `<b>${initials(name)}</b>`}</div>
  </div>
</div></section>
${s.cover ? `<section class="wide"><figure class="frame frame--wide shophero__cover" data-wipe><div class="frame__clip">${img(s.cover, name, '', true)}</div></figure></section>` : ''}
<section class="shopinfo"><div class="wrap shopinfo__grid">
  <dl class="shopinfo__facts">${facts.map(([k, v]) => `<div><dt class="label">${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
  <div class="shopinfo__about">${s.description[lang] ? `<div class="prose">${paras(s.description[lang])}</div>` : ''}
    ${s.units.length ? `<figure class="shopinfo__plan">${shopPlan(lang, lv, [s], { id: 'here', here: s })}<figcaption class="label">${esc(unitsLine(lang, s))}</figcaption></figure>${link(p(lang, '/the-wave/#directory'), t.plan.all)}` : ''}
  </div>
</div></section>
${offerCards(lang, promos)}
${others.length ? `<section class="shops shops--more"><div class="wrap"><div class="row-head">${label(more.length ? fill(t.more, { cat: catName(lang, s.category) }) : t.back)}${link(p(lang, '/stores/'), t.back)}</div><ul class="shops__list shops__list--3">${others.map((x) => shopCard(lang, x)).join('')}</ul></div></section>` : ''}`;
  const jsonld = [crumbsLd(trail, b), storeLd(lang, s, b)];
  const desc = s.tagline[lang] || s.description[lang].split('\n')[0] || t.description;
  return layout({ lang, pathname: shopUrl(lang, s.slug), title: `${name} | ${t.title.split(' | ')[1] || 'The Wave'}`, description: desc.slice(0, 300), body, seo: { jsonld, ...(s.cover && !s.cover.endsWith('.svg') ? { imageUrl: s.cover } : { image: 'shopfronts' }) }, ...ctx });
}

function eventsIndex(lang, ctx, data) {
  const c = content[lang];
  const ev = c.events;
  const b = base(ctx);
  const { upcoming, past, intro = '' } = data;
  const body = `
${opener(ev.kicker, ev.hero, intro || ev.intro)}
${subnav(lang, 'events')}
<section class="events"><div class="wrap">
  <div class="row-head">${label(ev.upcoming)}</div>
  ${upcoming.length ? `<ul class="evlist">${upcoming.map((e) => eventRow(lang, e)).join('')}</ul>` : `<div class="events__none"><p class="lead">${esc(ev.none)}</p>${link(p(lang, '/journal/'), ev.subscribe)}</div>`}
  ${past.length ? `<div class="row-head events__past">${label(ev.past)}</div><ul class="evlist evlist--past">${past.map((e) => eventRow(lang, e, { past: true })).join('')}</ul>` : ''}
</div></section>`;
  const jsonld = [
    crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/events/'), c.shops.tabs.events]], b),
    ...upcoming.map((e) => eventLd(lang, e, b)),
  ];
  return layout({ lang, pathname: p(lang, '/events/'), title: ev.title, description: ev.description, body, seo: { image: 'plaza', jsonld }, ...ctx });
}

function eventPage(lang, ctx, e, { others = [] } = {}) {
  const c = content[lang];
  const ev = c.events;
  const b = base(ctx);
  const name = e.title[lang];
  const trail = [[p(lang, '/'), c.crumbs.home], [p(lang, '/events/'), c.shops.tabs.events], [eventUrl(lang, e.slug), name]];
  const over = e.endsOn < new Date().toISOString().slice(0, 10);
  const body = `
<section class="opener opener--event"><div class="wrap">
  ${crumbs(trail)}
  <p class="label" data-rise>${esc(days(e.startsOn, e.endsOn, lang))}${hours(e) ? ` · <span dir="ltr">${esc(hours(e))}</span>` : ''}</p>
  ${title(name, '', 'h1', 'title--xl')}
  ${e.summary[lang] ? `<p class="lead" data-rise>${esc(e.summary[lang])}</p>` : ''}
</div></section>
${e.cover ? `<section class="wide"><figure class="frame frame--wide" data-wipe><div class="frame__clip">${img(e.cover, name, '', true)}</div></figure></section>` : ''}
<section class="shopinfo"><div class="wrap shopinfo__grid">
  <dl class="shopinfo__facts">
    <div><dt class="label">${esc(ev.when)}</dt><dd>${esc(days(e.startsOn, e.endsOn, lang))}</dd></div>
    ${hours(e) ? `<div><dt class="label">${esc(ev.time)}</dt><dd dir="ltr">${esc(hours(e))}</dd></div>` : ''}
    <div><dt class="label">${esc(ev.where)}</dt><dd>${esc(e.location[lang] || ev.free)}</dd></div>
  </dl>
  <div class="shopinfo__about">${e.description[lang] ? `<div class="prose">${paras(e.description[lang])}</div>` : ''}
    ${over ? '' : `<div class="evactions">${e.rsvp ? `<a class="btn" href="${esc(e.rsvp)}" target="_blank" rel="noopener"><span>${esc(ev.rsvp)}</span>${arrow}</a>` : ''}${link(`${eventUrl(lang, e.slug)}calendar.ics`, ev.calendar, '', 'data-full-nav download')}</div>`}
  </div>
</div></section>
${others.length ? `<section class="events events--teaser"><div class="wrap"><div class="row-head">${label(ev.upcoming)}${link(p(lang, '/events/'), ev.all)}</div><ul class="evlist">${others.map((x) => eventRow(lang, x)).join('')}</ul></div></section>` : ''}`;
  const jsonld = [crumbsLd(trail, b), eventLd(lang, e, b)];
  return layout({ lang, pathname: eventUrl(lang, e.slug), title: `${name} | ${ev.title.split(' | ')[1] || 'The Wave'}`, description: (e.summary[lang] || e.description[lang] || ev.description).slice(0, 300), body, seo: { jsonld, ...(e.cover && !e.cover.endsWith('.svg') ? { imageUrl: e.cover } : { image: 'plaza' }) }, ...ctx });
}

// An event for the visitor's calendar.
function eventIcs(lang, e, siteUrl) {
  const stamp = (date, time) => {
    const d = new Date(`${date}T${time || '00:00'}:00${cairoOffset(date)}`);
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  const allDay = !e.timeFrom;
  const next = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const line = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const url = `${(siteUrl || '').replace(/\/$/, '')}${eventUrl(lang, e.slug)}`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Wave//Events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${e.slug}@thewavemall.com`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    allDay ? `DTSTART;VALUE=DATE:${e.startsOn.replace(/-/g, '')}` : `DTSTART:${stamp(e.startsOn, e.timeFrom)}`,
    allDay ? `DTEND;VALUE=DATE:${next(e.endsOn)}` : `DTEND:${stamp(e.endsOn, e.timeTo || e.timeFrom)}`,
    `SUMMARY:${line(e.title[lang])}`, `DESCRIPTION:${line(`${e.summary[lang] || ''}\n${url}`.trim())}`,
    `LOCATION:${line(`${e.location[lang] ? `${e.location[lang]}, ` : ''}The Wave, North 90 Street, New Cairo`)}`, `URL:${url}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

module.exports = { home, story: building, experience, leasing, visit, journalIndex, journalPost, contact, legal, notFound, postUrl, storesIndex, storePage, eventsIndex, eventPage, eventIcs, shopsSoon };
