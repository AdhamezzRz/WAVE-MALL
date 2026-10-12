import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const pg = await b.newPage({viewport:{width:1920,height:1080}});
await pg.goto('file:///home/user/WAVE-MALL/wave-mall-logo-deck.html#5'); await pg.waitForTimeout(700);
await pg.screenshot({path:'shots/g_split.png'});
await pg.keyboard.press('a'); await pg.waitForTimeout(500); await pg.screenshot({path:'shots/g_a.png'});
await pg.click('.slide.on [data-m=b]'); await pg.waitForTimeout(500); await pg.screenshot({path:'shots/g_b.png'});
await pg.keyboard.press('ArrowRight'); await pg.waitForTimeout(600); await pg.keyboard.press('b'); await pg.waitForTimeout(500); await pg.screenshot({path:'shots/n_b.png'});
await b.close();
