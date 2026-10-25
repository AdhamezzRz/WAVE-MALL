// Renders the wordmark as a white-on-black mask for scripts/mount-sign.py.
// PW=/path/to/playwright node scripts/render-sign-mask.cjs <out.png>
const { chromium } = require(process.env.PW || 'playwright');
const L = require('../src/logo-paths.json');
(async () => {
  const W = 4000, H = Math.round(4000 * 225.2 / 490);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: W, height: H } });
  await p.setContent(`<body style="margin:0;background:#000"><svg viewBox="0 0 490 225.2" width="${W}" height="${H}" style="display:block"><g fill="#fff">${Object.values(L).map(d=>`<path d="${d}"/>`).join('')}</g></svg></body>`);
  await p.screenshot({ path: process.argv[2] }); await b.close();
})();
