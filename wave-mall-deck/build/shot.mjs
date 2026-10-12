import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const pg = await b.newPage({viewport:{width:1920,height:1080}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message)); pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await pg.goto('file:///home/user/WAVE-MALL/wave-logo-deck.html'.replace('wave-logo','wave-mall-logo'));
await pg.waitForTimeout(800);
for (let i=0;i<18;i++){ await pg.screenshot({path:`shots/s${String(i+1).padStart(2,'0')}.png`}); await pg.keyboard.press('ArrowRight'); await pg.waitForTimeout(600); }
// single mode checks
await pg.goto('file:///home/user/WAVE-MALL/wave-mall-logo-deck.html#6'); await pg.waitForTimeout(600);
await pg.keyboard.press('a'); await pg.waitForTimeout(500); await pg.screenshot({path:'shots/m06a.png'});
await pg.keyboard.press('b'); await pg.waitForTimeout(500); await pg.screenshot({path:'shots/m06b.png'});
console.log('errors',errs); await b.close();
