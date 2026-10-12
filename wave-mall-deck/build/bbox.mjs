import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const pg = await b.newPage({viewport:{width:2560,height:1664}});
for (const n of 'AB') { await pg.goto(`file:///home/user/WAVE-MALL/wave-mall-deck/build/logo${n}_raw.svg`); await pg.screenshot({path:`raw${n}.png`}); }
await b.close();
