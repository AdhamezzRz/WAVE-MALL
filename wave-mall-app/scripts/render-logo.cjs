// Rasterise the wordmark to a transparent PNG (white on transparent) for compositing.
const { chromium } = require(process.env.PW || 'playwright');
const LOGO = require('../src/logo-paths.json');
(async () => {
  const out = process.argv[2];
  const W = 2450, H = 1126;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 490 225.2" width="${W}" height="${H}"><g fill="#fff">${Object.values(LOGO).map((d) => `<path d="${d}"/>`).join('')}</g></svg>`;
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: W, height: H } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await p.screenshot({ path: out, omitBackground: true });
  await b.close();
})();
