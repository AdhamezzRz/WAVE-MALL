'use strict';

const { content, COORDS, LANDMARKS } = require('./content');
const journal = require('./journal');
const { esc, picture, imgUrl, link, arrow, hero, plainHero, markSection, crumbs, crumbsLd, newsletter, fmtDate, layout, logoSvg } = require('./render');

const mapUrl = `https://www.google.com/maps?q=${COORDS.lat},${COORDS.lng}`;
const p = (lang, path) => (lang === 'en' ? path : `/ar${path}`);
const postUrl = (lang, post) => p(lang, `/journal/${post.slug}/`);

const field = (name, label, input) => `<div class="field" data-field><label for="f-${name}">${esc(label)}</label>${input}</div>`;
const statusBanner = (status, ok, fail) =>
  status === 'ok'
    ? `<p class="status status--ok" role="status" data-form-status>${esc(ok)}</p>`
    : status === 'error'
      ? `<p class="status status--err" role="alert" data-form-status>${esc(fail)}</p>`
      : `<p class="status" role="status" data-form-status hidden></p>`;

// A journal card used on the index, the home page and under an article.
function card(lang, post, { big = false } = {}) {
  const c = content[lang];
  const t = post[lang];
  return `
<article class="card ${big ? 'card--big' : ''}" data-r>
  <a class="card__media" href="${postUrl(lang, post)}" tabindex="-1" aria-hidden="true">${picture(post.img, '', { sizes: big ? '(min-width: 900px) 60vw, 100vw' : '(min-width: 900px) 30vw, 100vw' })}</a>
  <div class="card__body">
    <p class="cap"><span>${esc(post.tag[lang])}</span><i>·</i><time datetime="${post.date}">${fmtDate(post.date, lang)}</time><i>·</i><span>${journal.readingMinutes(t.body)} ${esc(c.journal.minutes)}</span></p>
    <h3 class="card__title"><a href="${postUrl(lang, post)}">${esc(t.title)}</a></h3>
    <p class="card__excerpt">${esc(t.excerpt)}</p>
  </div>
</article>`;
}

/* ---------- home ---------- */
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
  const latest = journal.sorted().slice(0, 2);
  const body = `
${hero(h.hero, 'aerial', lang === 'en' ? 'The Wave at dusk: curved ribbon balconies around a plaza of terraces.' : 'ذا ويف عند الغروب: شرفات منحنية حول ساحة من التراسات.', { portrait: 'dusk', meta: h.hero.meta })}
<section class="intro"><div class="col"><p class="lead lead--big" data-r>${esc(h.intro)}</p></div></section>
<section class="chapters"><div class="col">${chapters}</div></section>
${markSection(c, h.mark, { more: { href: p(lang, '/the-wave/'), label: h.mark.more } })}
<section class="pair">
  <div class="col pair__col">
    <div data-r><p class="lead">${esc(h.visit.text)}</p>${link(p(lang, '/visit/'), h.visit.more)}</div>
    <div data-r><p class="lead">${esc(h.leasing.text)}</p>${link(p(lang, '/leasing/'), h.leasing.more)}</div>
  </div>
</section>
<section class="teaser">
  <div class="col">
    <div class="teaser__head" data-r><p class="cap">${esc(c.journal.hero.a)} ${esc(c.journal.hero.b)}</p>${link(p(lang, '/journal/'), c.journal.all)}</div>
    <div class="cards cards--2">${latest.map((post) => card(lang, post)).join('')}</div>
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/'), title: h.title, description: h.description, body, ...ctx });
}

/* ---------- the wave ---------- */
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

/* ---------- experience ---------- */
function experience(lang, ctx) {
  const c = content[lang];
  const e = c.experience;
  const blocks = e.blocks
    .map(
      (b, i) => `
    <article class="chapter chapter--${i % 2 ? 'b' : 'a'}">
      <figure class="frame" data-r="img" data-thread-anchor>${picture(b.img, b.title, { sizes: '(min-width: 900px) 58vw, 100vw' })}</figure>
      <div class="chapter__text"><p class="time" data-r>${esc(b.title)}</p><p class="lead" data-r>${esc(b.text)}</p></div>
    </article>`,
    )
    .join('');
  const list = e.list.items.map((it) => `<div class="row" data-r><span>${esc(it)}</span></div>`).join('');
  const body = `
${hero(e.hero, 'fashion', lang === 'en' ? 'A woman in a camel trench coat walks past lit boutique windows.' : 'امرأة بمعطف كاميل تمشي أمام واجهات بوتيكات مضاءة.')}
<section class="intro"><div class="col"><p class="lead lead--big" data-r>${esc(e.intro)}</p></div></section>
<section class="chapters"><div class="col">${blocks}</div></section>
<section class="rows"><div class="col rows__col rows__col--list"><p class="cap rows__title" data-r>${esc(e.list.title)}</p>${list}<p class="cap rows__note" data-r>${esc(e.note)}</p></div></section>`;
  return layout({ lang, pathname: p(lang, '/experience/'), title: e.title, description: e.description, body, image: 'fashion', ...ctx });
}

/* ---------- journal ---------- */
function journalIndex(lang, ctx) {
  const c = content[lang];
  const j = c.journal;
  const [first, ...rest] = journal.sorted();
  const base = (ctx.siteUrl || '').replace(/\/$/, '');
  const jsonld = [
    {
      '@type': 'Blog',
      '@id': `${base}${p(lang, '/journal/')}#blog`,
      name: j.title,
      description: j.description,
      url: `${base}${p(lang, '/journal/')}`,
      inLanguage: lang,
      publisher: { '@id': `${base}/#org` },
      blogPost: journal.sorted().map((post) => ({ '@type': 'BlogPosting', headline: post[lang].title, url: `${base}${postUrl(lang, post)}`, datePublished: post.date, image: `${base}${imgUrl(post.img)}` })),
    },
    crumbsLd([[p(lang, '/'), c.crumbs.home], [p(lang, '/journal/'), j.hero.a + ' ' + j.hero.b]], base),
  ];
  const body = `
${plainHero(j.hero, j.intro)}
<section class="journal">
  <div class="col">
    <p class="cap journal__label" data-r>${esc(j.latest)}</p>
    ${card(lang, first, { big: true })}
    <div class="cards cards--3">${rest.map((post) => card(lang, post)).join('')}</div>
    <p class="cap journal__feed" data-r><a href="${p(lang, '/journal/feed.xml')}">${esc(j.feed)}</a></p>
  </div>
</section>
<section class="news-sec"><div class="col">${newsletter(c)}</div></section>`;
  return layout({ lang, pathname: p(lang, '/journal/'), title: j.title, description: j.description, body, image: first.img, seo: { jsonld }, thread: false, ...ctx });
}

function journalPost(lang, post, ctx) {
  const c = content[lang];
  const j = c.journal;
  const t = post[lang];
  const base = (ctx.siteUrl || '').replace(/\/$/, '');
  const url = `${base}${postUrl(lang, post)}`;
  const trail = [[p(lang, '/'), c.crumbs.home], [p(lang, '/journal/'), `${j.hero.a} ${j.hero.b}`.trim()], [postUrl(lang, post), t.title]];
  const jsonld = [
    {
      '@type': 'BlogPosting',
      '@id': `${url}#post`,
      headline: t.title,
      description: t.excerpt,
      image: `${base}${imgUrl(post.img)}`,
      datePublished: post.date,
      dateModified: post.date,
      inLanguage: lang,
      url,
      mainEntityOfPage: url,
      articleSection: post.tag[lang],
      wordCount: t.body.split(/\s+/).length,
      author: { '@type': 'Organization', name: 'The Wave', '@id': `${base}/#org` },
      publisher: { '@id': `${base}/#org` },
      isPartOf: { '@id': `${base}${p(lang, '/journal/')}#blog` },
    },
    crumbsLd(trail, base),
  ];
  const share = {
    wa: `https://wa.me/?text=${encodeURIComponent(t.title + ' ' + url)}`,
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(t.title)}&url=${encodeURIComponent(url)}`,
  };
  const body = `
<article class="article">
  <header class="plain article__head">
    <div class="col">
      ${crumbs(trail)}
      <p class="cap article__meta" data-r><span>${esc(post.tag[lang])}</span><i>·</i><time datetime="${post.date}">${fmtDate(post.date, lang)}</time><i>·</i><span>${journal.readingMinutes(t.body)} ${esc(j.minutes)}</span></p>
      <h1 class="h1 h1--article" data-r>${esc(t.title)}</h1>
      <p class="lead article__excerpt" data-r>${esc(t.excerpt)}</p>
    </div>
  </header>
  <div class="col"><figure class="frame frame--cover" data-r="img" data-thread-anchor>${picture(post.img, t.title, { eager: true, sizes: '(min-width: 900px) 80vw, 100vw' })}</figure></div>
  <div class="col"><div class="prose" data-r>${journal.renderBody(t.body, esc)}</div>
    <div class="share" data-r>
      <span class="cap">${esc(j.share)}</span>
      <button type="button" class="share__btn" data-copy="${esc(url)}" data-copied="${esc(j.copied)}">${esc(j.copy)}</button>
      <a class="share__btn" href="${share.wa}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="share__btn" href="${share.x}" target="_blank" rel="noopener">X</a>
    </div>
  </div>
</article>
<section class="teaser teaser--article">
  <div class="col">
    <div class="teaser__head" data-r><p class="cap">${esc(j.more)}</p>${link(p(lang, '/journal/'), j.all)}</div>
    <div class="cards cards--2">${journal.related(post).map((r) => card(lang, r)).join('')}</div>
  </div>
</section>
<section class="news-sec"><div class="col">${newsletter(c)}</div></section>`;
  return layout({
    lang,
    pathname: postUrl(lang, post),
    title: `${t.title} | ${j.title}`,
    description: t.excerpt,
    body,
    image: post.img,
    seo: { type: 'article', published: post.date, modified: post.date, image: post.img, jsonld },
    thread: false, ...ctx,
  });
}

/* ---------- visit ---------- */
function visit(lang, ctx) {
  const c = content[lang];
  const v = c.visit;
  const pins = LANDMARKS.map((m) => `<span class="pin ${m.id === 'plot' ? 'pin--plot' : ''}" style="--x:${m.x}%;--y:${m.y}%" data-pin><i></i><b>${esc(v.labels[m.id])}</b></span>`).join('');
  const rows = v.rows.map(([k, t]) => `<div class="row" data-r><span class="cap">${esc(k)}</span><span>${esc(t)}</span></div>`).join('');
  const body = `
${plainHero(v.hero, v.intro)}
<section class="map-sec">
  <div class="col">
    <div class="map" data-r="img" data-thread-anchor>${picture('map', v.mapAlt, { eager: true, sizes: '(min-width: 900px) 80vw, 100vw' })}<div class="map__pins">${pins}</div></div>
    <div class="map__foot">
      <address class="cap">${esc(v.address)}</address>
      ${link(mapUrl, v.button, 'link--ext', 'target="_blank" rel="noopener"')}
    </div>
  </div>
</section>
<section class="rows"><div class="col rows__col">${rows}</div></section>`;
  return layout({ lang, pathname: p(lang, '/visit/'), title: v.title, description: v.description, body, image: 'map', ...ctx });
}

/* ---------- leasing ---------- */
function leasing(lang, ctx) {
  const c = content[lang];
  const L = c.leasing;
  const f = L.fields;
  const body = `
${plainHero(L.hero, L.intro)}
<section class="enquire">
  <div class="col enquire__col">
    <form class="form" method="post" action="/api/enquiry" novalidate data-form="leasing" data-sending="${esc(f.sending)}" data-ok="${esc(L.ok)}" data-fail="${esc(L.fail)}" data-r>
      <input type="hidden" name="lang" value="${lang}">
      <p class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
      ${field('name', f.name, `<input id="f-name" name="name" required maxlength="120" autocomplete="name">`)}
      ${field('brand', f.brand, `<input id="f-brand" name="brand" required maxlength="160" autocomplete="organization">`)}
      ${field('email', f.email, `<input id="f-email" type="email" name="email" required maxlength="200" autocomplete="email" dir="ltr">`)}
      ${field('phone', f.phone, `<input id="f-phone" type="tel" name="phone" maxlength="40" autocomplete="tel" dir="ltr">`)}
      ${field('message', f.message, `<textarea id="f-message" name="message" rows="3" maxlength="2000"></textarea>`)}
      <div class="form__foot"><button class="btn" type="submit"><span>${esc(f.submit)}</span>${arrow}</button><p class="cap">${esc(L.privacy)}</p></div>
      ${statusBanner(ctx.status, L.ok, L.fail)}
    </form>
  </div>
</section>`;
  return layout({ lang, pathname: p(lang, '/leasing/'), title: L.title, description: L.description, body, image: null, thread: false, ...ctx });
}

/* ---------- contact ---------- */
function contact(lang, ctx) {
  const c = content[lang];
  const k = c.contact;
  const f = k.fields;
  const subjects = k.subjects.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const faq = k.faq.items.map(([q, a]) => `<details class="faq" data-r><summary>${esc(q)}<i aria-hidden="true"></i></summary><p>${esc(a)}</p></details>`).join('');
  const base = (ctx.siteUrl || '').replace(/\/$/, '');
  const jsonld = [
    { '@type': 'ContactPage', '@id': `${base}${p(lang, '/contact/')}#page`, url: `${base}${p(lang, '/contact/')}`, name: k.title, about: { '@id': `${base}/#org` } },
    { '@type': 'FAQPage', mainEntity: k.faq.items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ];
  const body = `
${plainHero(k.hero, k.intro)}
<section class="contact">
  <div class="col contact__grid">
    <form class="form" method="post" action="/api/contact" novalidate data-form="contact" data-sending="${esc(f.sending)}" data-ok="${esc(k.ok)}" data-fail="${esc(k.fail)}" data-r>
      <input type="hidden" name="lang" value="${lang}">
      <p class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
      ${field('name', f.name, `<input id="f-name" name="name" required maxlength="120" autocomplete="name">`)}
      ${field('email', f.email, `<input id="f-email" type="email" name="email" required maxlength="200" autocomplete="email" dir="ltr">`)}
      ${field('subject', f.subject, `<select id="f-subject" name="subject">${subjects}</select>`)}
      ${field('message', f.message, `<textarea id="f-message" name="message" rows="4" required maxlength="3000"></textarea>`)}
      <div class="form__foot"><button class="btn" type="submit"><span>${esc(f.submit)}</span>${arrow}</button><p class="cap">${esc(k.privacy)}</p></div>
      ${statusBanner(ctx.status, k.ok, k.fail)}
    </form>
    <aside class="contact__side" data-r>
      <p class="cap">${esc(k.details.title)}</p>
      <a class="contact__big" href="mailto:${k.details.email}">${esc(k.details.email)}</a>
      <p>${esc(k.details.address)}</p>
      <p>${esc(k.details.hours)}</p>
      ${link(mapUrl, k.details.maps, '', 'target="_blank" rel="noopener"')}
    </aside>
  </div>
</section>
<section class="faqs"><div class="col faqs__col"><p class="cap" data-r>${esc(k.faq.title)}</p>${faq}</div></section>`;
  return layout({ lang, pathname: p(lang, '/contact/'), title: k.title, description: k.description, body, image: null, seo: { jsonld }, thread: false, ...ctx });
}

/* ---------- legal ---------- */
function legal(lang, which, ctx) {
  const c = content[lang];
  const L = c.legal[which];
  const body = `
${plainHero({ a: L.title, b: '' }, null)}
<section class="legal"><div class="col"><p class="cap" data-r>${esc(c.legal.updated)} <time datetime="2026-10-25">${fmtDate('2026-10-25', lang)}</time></p>
<div class="prose prose--legal" data-r>${L.sections.map(([h, t]) => `<h2>${esc(h)}</h2><p>${esc(t)}</p>`).join('')}</div></div></section>`;
  return layout({ lang, pathname: p(lang, `/${which}/`), title: `${L.title} | The Wave`, description: L.description, body, image: null, loader: false, thread: false, ...ctx });
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
  return layout({ lang, pathname: p(lang, '/404'), title: 'The Wave', description: c.notFound.title, body, loader: false, image: null, seo: { noindex: true }, ...ctx });
}

module.exports = { home, story, experience, journalIndex, journalPost, visit, leasing, contact, legal, notFound, postUrl };
