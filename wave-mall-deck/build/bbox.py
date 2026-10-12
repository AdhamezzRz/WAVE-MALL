import asyncio, re, json
from playwright.async_api import async_playwright
from PIL import Image
import numpy as np
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':2560,'height':1664})
        out={}
        for n in 'AB':
            await pg.goto(f'file:///home/user/WAVE-MALL/wave-mall-deck/build/logo{n}_raw.svg')
            await pg.screenshot(path=f'raw{n}.png')
            a=np.array(Image.open(f'raw{n}.png').convert('RGB')).astype(int)
            m=(abs(a-np.array([243,244,241])).sum(2)>40)
            ys,xs=np.where(m); out[n]=[int(xs.min()),int(ys.min()),int(xs.max()),int(ys.max())]
        print(out); json.dump(out,open('bbox.json','w'))
        await b.close()
asyncio.run(main())
