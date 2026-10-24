import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const b = await chromium.launch(); const pg = await b.newPage({viewport:{width:1080,height:1350}});
await pg.goto('file://' + process.cwd() + '/' + (process.argv[2]||'posts.html')); await pg.evaluate(()=>document.fonts.ready); await pg.waitForTimeout(800);
fs.mkdirSync('../posts',{recursive:true});
for (const el of await pg.$$('.post')) { const id=(await el.getAttribute('id')).slice(2); await el.screenshot({path:`../posts/${id}.png`}); console.log(id); }
await b.close();
