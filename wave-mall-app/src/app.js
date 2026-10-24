'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const pages = require('./pages');
const { validate, deliver } = require('./enquiry');

const PUBLIC = path.join(__dirname, '..', 'public');
const DAY = 24 * 60 * 60 * 1000;

const ROUTES = [
  ['/', 'home'],
  ['/the-wave/', 'story'],
  ['/experience/', 'experience'],
  ['/location/', 'location'],
  ['/leasing/', 'leasing'],
];

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
          'style-src': ["'self'", "'unsafe-inline'"], // GSAP/inline custom properties
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

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  for (const [route, name] of ROUTES) {
    app.get(route, (req, res) => html(res, pages[name]('en', ctx(req, res))));
    app.get(`/ar${route}`, (req, res) => html(res, pages[name]('ar', ctx(req, res))));
  }
  app.get(['/ar', '/en', '/en/'], (req, res) => res.redirect(301, req.path.startsWith('/ar') ? '/ar/' : '/'));

  app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`));
  app.get('/sitemap.xml', (req, res) => {
    const b = siteUrl(req);
    const urls = ROUTES.flatMap(([route]) => {
      const en = `${b}${route}`;
      const ar = `${b}/ar${route}`;
      const alt = `<xhtml:link rel="alternate" hreflang="en" href="${en}"/><xhtml:link rel="alternate" hreflang="ar" href="${ar}"/>`;
      return [`<url><loc>${en}</loc>${alt}</url>`, `<url><loc>${ar}</loc>${alt}</url>`];
    });
    res
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
  });

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 6,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => respond(req, res, 429, 'error'),
  });

  app.post('/api/enquiry', limiter, express.json({ limit: '16kb' }), express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    const body = req.body || {};
    if (body.website) return respond(req, res, 200, 'ok', {}, body.lang); // honeypot: pretend success
    const result = validate(body);
    if (!result.ok) return respond(req, res, 422, 'error', { errors: result.errors }, body.lang);
    try {
      await mail(result.value, env, console);
      return respond(req, res, 200, 'ok', {}, result.value.lang);
    } catch (err) {
      console.error('[enquiry] delivery failed:', err.message);
      return respond(req, res, 502, 'error', {}, result.value.lang);
    }
  });

  app.use(
    express.static(PUBLIC, {
      index: false,
      setHeaders(res, file) {
        const asset = /\.(woff2|mp4|webp|png|jpg|svg)$/.test(file);
        const versioned = /\.(css|js)$/.test(file);
        res.set('Cache-Control', versioned ? `public, max-age=${365 * DAY / 1000}, immutable` : asset ? `public, max-age=${30 * DAY / 1000}` : 'no-cache');
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

const statusOf = (req) => (req.query.sent === '1' ? 'ok' : req.query.sent === '0' ? 'error' : undefined);

// JSON for fetch(), redirect back to the leasing page for plain HTML form posts.
function respond(req, res, code, status, extra = {}, lang) {
  if (req.accepts(['json', 'html']) === 'json') return res.status(code).json({ ok: status === 'ok', ...extra });
  const l = lang === 'ar' || String(req.get('referer') || '').includes('/ar/') ? 'ar' : 'en';
  return res.redirect(303, `${l === 'ar' ? '/ar' : ''}/leasing/?sent=${status === 'ok' ? 1 : 0}#enquire`);
}

module.exports = { createApp, ROUTES };
