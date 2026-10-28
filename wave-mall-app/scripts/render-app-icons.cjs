// App icons for the leasing office and tenant portal (PWA): the AV ligature in sand on forest.
// PW=/path/to/playwright node scripts/render-app-icons.cjs
const path = require('node:path');
const { chromium } = require(process.env.PW || 'playwright');
const L = require('../src/logo-paths.json');
const OUT = path.join(__dirname, '..', 'public', 'admin', 'app');
// size, mark width as a share of the icon, file
const ICONS = [
  [192, 0.62, 'icon-192.png'],
  [512, 0.62, 'icon-512.png'],
  [512, 0.46, 'icon-maskable-512.png'], // inside the 80% safe circle
  [180, 0.6, 'apple-touch-icon.png'],
  [96, 0.64, 'shortcut-96.png'],
];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const [size, share, file] of ICONS) {
    await p.setViewportSize({ width: size, height: size });
    const w = size * share;
    await p.setContent(`<body style="margin:0;background:#283833;width:${size}px;height:${size}px;display:grid;place-items:center">
      <svg id="m" viewBox="163 97 207 128" width="${w}" style="display:block"><path fill="#d1c9b3" d="${L.AV}"/></svg></body>`);
    // fit the viewBox to the mark's own outline so it sits optically centred
    await p.evaluate(() => {
      const svg = document.getElementById('m');
      const bb = svg.querySelector('path').getBBox();
      svg.setAttribute('viewBox', `${bb.x} ${bb.y} ${bb.width} ${bb.height}`);
      svg.setAttribute('height', String((svg.width.baseVal.value * bb.height) / bb.width));
    });
    await p.screenshot({ path: path.join(OUT, file) });
  }
  await b.close();
  console.log('icons written to', OUT);
})();
