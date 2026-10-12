import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const pg = await b.newPage({viewport:{width:1920,height:1080}});
await pg.goto('file:///home/user/WAVE-MALL/wave-mall-logo-deck.html'); await pg.waitForTimeout(1000);
await pg.pdf({path:'/home/user/WAVE-MALL/wave-mall-logo-deck.pdf',width:'1920px',height:'1080px',printBackground:true,preferCSSPageSize:true});
await b.close();
