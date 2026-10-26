'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const pages = require('./pages');
const journal = require('./journal');
const { content } = require('./content');
const { validate, validateContact, validateSubscribe, deliver } = require('./enquiry');
const { mount: mountAdmin } = require('./admin');

const PUBLIC = path.join(__dirname, '..', 'public');
const DAY = 24 * 60 * 60 * 1000;

const ROUTES = [
  ['/', 'home'],
  ['/the-wave/', 'story'],
  ['/experience/', 'experience'],
  ['/journal/', 'journalIndex'],
  ['/visit/', 'visit'],
  ['/leasing/', 'leasing'],
  ['/contact/', 'contact'],
  ['/privacy/', (lang, ctx) => pages.legal(lang, 'privacy', ctx)],
  ['/terms/', (lang, ctx) => pages.legal(lang, 'terms', ctx)],
];

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function createApp({ env = process.env, mail = deliver } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Hostinger terminates TLS in front of the app

  app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'media-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"], // GSAP writes inline styles
          'script-src': ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
        },
      },
    }),
  );
  app.use(compression());

  const siteUrl = (req) => env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  const ctx = (req, res) => ({ siteUrl: siteUrl(req), nonce: res.locals.nonce, status: statusOf(req) });
  const html = (res, body, code = 200) => res.status(code).set('Cache-Control', 'no-cache').type('html').send(body);
  const render = (name, lang, req, res) => (typeof name === 'function' ? name(lang, ctx(req, res)) : pages[name](lang, ctx(req, res)));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  for (const [route, name] of ROUTES) {
    app.get(route, (req, res) => html(res, render(name, 'en', req, res)));
    app.get(`/ar${route}`, (req, res) => html(res, render(name, 'ar', req, res)));
  }
  for (const [prefix, lang] of [['', 'en'], ['/ar', 'ar']]) {
    app.get(`${prefix}/journal/:slug/`, (req, res, next) => {
      const post = journal.bySlug(req.params.slug);
      if (!post) return next();
      return html(res, pages.journalPost(lang, post, ctx(req, res)));
    });
    app.get(`${prefix}/journal/feed.xml`, (req, res) => res.type('application/rss+xml').send(feed(lang, siteUrl(req))));
  }
  app.get(['/ar', '/en', '/en/'], (req, res) => res.redirect(301, req.path.startsWith('/ar') ? '/ar/' : '/'));
  // Earlier structure of the site.
  app.get(['/location', '/location/', '/ar/location', '/ar/location/'], (req, res) => res.redirect(301, req.path.startsWith('/ar') ? '/ar/visit/' : '/visit/'));
  app.get(['/blog', '/blog/', '/ar/blog', '/ar/blog/'], (req, res) => res.redirect(301, req.path.startsWith('/ar') ? '/ar/journal/' : '/journal/'));

  app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`));
  app.get('/sitemap.xml', (req, res) => {
    const b = siteUrl(req);
    const today = new Date().toISOString().slice(0, 10);
    const entry = (route, lastmod, priority) => {
      const en = `${b}${route}`;
      const ar = `${b}/ar${route}`;
      const alt = `<xhtml:link rel="alternate" hreflang="en" href="${en}"/><xhtml:link rel="alternate" hreflang="ar" href="${ar}"/>`;
      return [en, ar].map((loc) => `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><priority>${priority}</priority>${alt}</url>`);
    };
    const urls = [
      ...ROUTES.flatMap(([route]) => entry(route, today, route === '/' ? '1.0' : '0.7')),
      ...journal.sorted().flatMap((post) => entry(`/journal/${post.slug}/`, post.date, '0.6')),
    ];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
  });

  // The leasing office (sales ERP) lives at /admin, behind its own sign-in.
  const admin = mountAdmin(app, { env });
  app.locals.admin = admin;

  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, handler: (req, res) => respond(req, res, 429, 'error') });
  const parsers = [limiter, express.json({ limit: '16kb' }), express.urlencoded({ extended: false, limit: '16kb' })];

  const handle = (validator, back) => async (req, res) => {
    const body = req.body || {};
    if (body.website) return respond(req, res, 200, 'ok', {}, body.lang, back); // honeypot: pretend success
    const result = validator(body);
    if (!result.ok) return respond(req, res, 422, 'error', { errors: result.errors }, body.lang, back);
    // Saved in the leasing office first; the email is a courtesy copy, so a mail failure is not the visitor's problem once it is saved.
    let saved = false;
    try {
      saved = admin.record(result.value);
    } catch (err) {
      console.error(`[${result.value.kind}] could not save to the leasing office:`, err.message);
    }
    try {
      await mail(result.value, env, console);
      return respond(req, res, 200, 'ok', {}, result.value.lang, back);
    } catch (err) {
      console.error(`[${result.value.kind}] delivery failed:`, err.message);
      return saved ? respond(req, res, 200, 'ok', {}, result.value.lang, back) : respond(req, res, 502, 'error', {}, result.value.lang, back);
    }
  };
  app.post('/api/enquiry', ...parsers, handle(validate, '/leasing/'));
  app.post('/api/contact', ...parsers, handle(validateContact, '/contact/'));
  app.post('/api/subscribe', ...parsers, handle(validateSubscribe, '/journal/'));

  app.use(
    express.static(PUBLIC, {
      index: false,
      setHeaders(res, file) {
        const asset = /\.(woff2|mp4|webp|png|jpg|svg)$/.test(file);
        const versioned = /\.(css|js)$/.test(file);
        res.set('Cache-Control', versioned ? `public, max-age=${(365 * DAY) / 1000}, immutable` : asset ? `public, max-age=${(30 * DAY) / 1000}` : 'no-cache');
      },
    }),
  );

  app.use((req, res) => html(res, pages.notFound(req.path.startsWith('/ar') ? 'ar' : 'en', ctx(req, res)), 404));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).type('text').send('Something went wrong.');
  });

  return app;
}

function feed(lang, base) {
  const c = content[lang];
  const b = base.replace(/\/$/, '');
  const prefix = lang === 'en' ? '' : '/ar';
  const items = journal
    .sorted()
    .map((post) => {
      const t = post[lang];
      const url = `${b}${prefix}/journal/${post.slug}/`;
      return `<item><title>${esc(t.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><pubDate>${new Date(post.date).toUTCString()}</pubDate><category>${esc(post.tag[lang])}</category><description>${esc(t.excerpt)}</description><content:encoded><![CDATA[${journal.renderBody(t.body, esc)}]]></content:encoded></item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${esc(c.journal.title)}</title><link>${b}${prefix}/journal/</link><description>${esc(c.journal.description)}</description><language>${lang}</language><atom:link href="${b}${prefix}/journal/feed.xml" rel="self" type="application/rss+xml"/>\n${items}\n</channel></rss>\n`;
}

const statusOf = (req) => (req.query.sent === '1' ? 'ok' : req.query.sent === '0' ? 'error' : undefined);

// JSON for fetch(), redirect back to the page for plain HTML form posts.
function respond(req, res, code, status, extra = {}, lang, back = '/') {
  if (req.accepts(['json', 'html']) === 'json') return res.status(code).json({ ok: status === 'ok', ...extra });
  const l = lang === 'ar' || String(req.get('referer') || '').includes('/ar/') ? 'ar' : 'en';
  return res.redirect(303, `${l === 'ar' ? '/ar' : ''}${back}?sent=${status === 'ok' ? 1 : 0}`);
}

module.exports = { createApp, ROUTES };
