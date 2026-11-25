// node render.mjs <file.html> <selector> <outdir> <transparent 0|1>
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
const [file, sel, outdir, transparent] = process.argv.slice(2);
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1080, height: 1350 } });
await pg.goto('file://' + process.cwd() + '/' + file);
await pg.evaluate(() => document.fonts.ready);
await pg.waitForTimeout(600);
for (const el of await pg.$$(sel)) {
  const id = (await el.getAttribute('id')).slice(2);
  await el.screenshot({ path: `${outdir}/${id}.png`, omitBackground: transparent === '1' });
  console.log(id);
}
await b.close();
