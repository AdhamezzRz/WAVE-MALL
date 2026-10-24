'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { renderPage, renderNotFound } = require('./render');
const { validate, deliver } = require('./enquiry');

const PUBLIC = path.join(__dirname, '..', 'public');
const DAY = 24 * 60 * 60 * 1000;

function createApp({ env = process.env, mail = deliver } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Hostinger terminates TLS in front of the app

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'media-src': ["'self'"],
          'style-src': ["'self'"],
          'script-src': ["'self'"],
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
  const html = (res, body, code = 200) =>
    res.status(code).set('Cache-Control', 'no-cache').type('html').send(body);

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.get('/', (req, res) => html(res, renderPage('en', { siteUrl: siteUrl(req), status: statusOf(req) })));
  app.get(['/ar', '/ar/'], (req, res) => html(res, renderPage('ar', { siteUrl: siteUrl(req), status: statusOf(req) })));
  app.get(['/en', '/en/'], (_req, res) => res.redirect(301, '/'));

  app.get('/robots.txt', (req, res) =>
    res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`),
  );
  app.get('/sitemap.xml', (req, res) => {
    const b = siteUrl(req);
    const alt = (l) => `<xhtml:link rel="alternate" hreflang="${l[0]}" href="${b}${l[1]}"/>`;
    const links = [['en', '/'], ['ar', '/ar/']];
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
        links.map((l) => `<url><loc>${b}${l[1]}</loc>${links.map(alt).join('')}</url>`).join('\n') +
        `\n</urlset>\n`,
    );
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
    if (body.website) return respond(req, res, 200, 'ok'); // honeypot: pretend success
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
        const long = /\.(woff2|mp4|webp|png|jpg|svg)$/.test(file) ? 30 * DAY : /\.(css|js)$/.test(file) ? 365 * DAY : 0;
        res.set('Cache-Control', long ? `public, max-age=${long / 1000}${/\.(css|js)$/.test(file) ? ', immutable' : ''}` : 'no-cache');
      },
    }),
  );

  app.use((req, res) => html(res, renderNotFound(req.path.startsWith('/ar') ? 'ar' : 'en'), 404));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).type('text').send('Something went wrong.');
  });

  return app;
}

const statusOf = (req) => (req.query.sent === '1' ? 'ok' : req.query.sent === '0' ? 'error' : undefined);

// JSON for fetch(), redirect back to the page for plain HTML form posts.
function respond(req, res, code, status, extra = {}, lang) {
  if (req.accepts(['json', 'html']) === 'json') return res.status(code).json({ ok: status === 'ok', ...extra });
  const l = lang === 'ar' || String(req.get('referer') || '').includes('/ar') ? 'ar' : 'en';
  return res.redirect(303, `${l === 'ar' ? '/ar/' : '/'}?sent=${status === 'ok' ? 1 : 0}#enquire`);
}

module.exports = { createApp };
