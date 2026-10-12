import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const pg = await b.newPage({viewport:{width:1920,height:1080}});
const errs=[];pg.on('pageerror',e=>errs.push(e.message));
for (const n of [1,2,3,4,17]) { await pg.goto('about:blank'); await pg.goto('file:///home/user/WAVE-MALL/wave-mall-logo-deck.html#'+n); await pg.waitForTimeout(700); await pg.screenshot({path:`shots/l${n}.png`}); }
console.log(errs); await b.close();
