#!/usr/bin/env python3
"""Builds build/posts.html (six 1080x1350 posts). render.mjs screenshots each into ../posts/."""
import os
here = os.path.dirname(os.path.abspath(__file__))
import base64
U = lambda f: 'data:image/png;base64,' + base64.b64encode(open(os.path.join(here, f), 'rb').read()).decode()
V = '../visuals/'

CSS = '''
.logo{-webkit-mask-image:url(@MASK@)!important;mask-image:url(@MASK@)!important}
.wm{-webkit-mask-image:url(@WM@)!important;mask-image:url(@WM@)!important}
.wr{position:absolute;-webkit-mask:url(@WR@) center/contain no-repeat;mask:url(@WR@) center/contain no-repeat;aspect-ratio:1969/545}
@font-face{font-family:Pinyon;src:url(fonts/PinyonScript-normal.woff2)}
@font-face{font-family:Bodoni;src:url(fonts/BodoniModa-normal.woff2);font-weight:400 700}
@font-face{font-family:Bodoni;font-style:italic;src:url(fonts/BodoniModa-italic.woff2)}
:root{--mint:#b3dccf;--mint2:#c6e6dc;--cocoa:#5a3b22;--caramel:#7a4826;--sand:#bba286;--forest:#1d3a2e;--cream:#f1e9db;--gold:#d2b46e}
*{margin:0;box-sizing:border-box}
body{background:#333;font-family:'Inter Display','Inter',sans-serif}
.post{position:relative;width:1080px;height:1350px;overflow:hidden;margin:0 0 40px}
.logo{position:absolute;-webkit-mask:url(logo-mask-hd.png) center/contain no-repeat;mask:url(logo-mask-hd.png) center/contain no-repeat;aspect-ratio:2044/1164}
.wm{position:absolute;-webkit-mask:url(logo-wordmark.png) center/contain no-repeat;mask:url(logo-wordmark.png) center/contain no-repeat;aspect-ratio:1989/936}
.caps{font-weight:500;text-transform:uppercase;letter-spacing:-.01em;line-height:.98}
.script{font-family:Pinyon;font-weight:400;line-height:1}
.body{font-weight:500;text-transform:uppercase;letter-spacing:.01em;line-height:1.3}
.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.grain:after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.10;mix-blend-mode:overlay;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
'''

posts = {}

# 01 manifesto, mint with the WAVE watermark (after the client's artboard 1)
posts['01-more-than-a-destination'] = '''
<div class="post" style="background:var(--mint);color:var(--cocoa)">
 <div class="wr" style="background:var(--mint2);height:1560px;left:-260px;top:-110px"></div>
 <div style="position:absolute;left:104px;top:250px">
  <div class="caps" style="font-size:112px">More than a<br>destination,</div>
  <div class="script" style="font-size:150px;margin:8px 0 0 -10px">a lifestyle.</div>
 </div>
 <div class="body" style="position:absolute;left:108px;bottom:120px;font-size:34px;max-width:620px">Welcome to The Wave,<br>where every detail<br>makes a statement.</div>
 <div class="logo" style="background:var(--cocoa);width:230px;right:96px;bottom:112px"></div>
</div>'''

# 02 editorial, motion
posts['02-every-detail'] = f'''
<div class="post grain" style="background:#000;color:var(--cream)">
 <img class="photo" src="{V}editorial-trench.png" style="filter:saturate(.92) contrast(1.04)">
 <div style="position:absolute;inset:0;background:linear-gradient(#0000 52%,#000a 100%)"></div>
 <div style="position:absolute;inset:0;background:linear-gradient(#0008 0%,#0000 22%)"></div>
 <div class="logo" style="background:var(--cream);width:190px;left:96px;top:84px;opacity:.95"></div>
 <div style="position:absolute;left:96px;bottom:120px">
  <div class="script" style="font-size:132px;margin-left:-6px">in motion,</div>
  <div class="caps" style="font-size:84px;margin-top:6px">always in style.</div>
 </div>
</div>'''

# 03 badge on stripes (after the client's artboard 3)
r = 300
posts['03-badge'] = f'''
<div class="post" style="background:repeating-linear-gradient(90deg,var(--caramel) 0 30px,var(--sand) 30px 60px)">
 <svg width="1080" height="1350" style="position:absolute;inset:0">
  <defs><path id="top" d="M 300 675 A 220 220 0 0 1 780 675"/><path id="bot" d="M 270 675 A 250 250 0 0 0 810 675"/></defs>
  <circle cx="540" cy="675" r="{r}" fill="#1d3a2e"/>
  <text font-family="Inter Display, Inter" font-weight="500" font-size="36" letter-spacing="9" fill="#f1e9db"><textPath href="#top" startOffset="50%" text-anchor="middle">NEW CAIRO MALL</textPath></text>
  <text font-family="Inter Display, Inter" font-weight="500" font-size="34" letter-spacing="8" fill="#f1e9db"><textPath href="#bot" startOffset="50%" text-anchor="middle">MORE THAN A DESTINATION</textPath></text>
 </svg>
 <div class="wm" style="background:var(--cream);width:300px;left:390px;top:604px"></div>
</div>'''

# 04 architecture
posts['04-designed-to-flow'] = f'''
<div class="post grain" style="background:#000;color:#fff">
 <img class="photo" src="{V}architecture-curves.png">
 <div style="position:absolute;inset:0;background:linear-gradient(160deg,#0006 0%,#0000 38%),linear-gradient(#0000 70%,#0007)"></div>
 <div style="position:absolute;left:96px;top:110px">
  <div class="caps" style="font-size:104px">Designed</div>
  <div class="script" style="font-size:150px;margin:0 0 0 70px">to flow.</div>
 </div>
 <div class="body" style="position:absolute;left:100px;bottom:110px;font-size:32px;max-width:600px;color:#fff;text-shadow:0 2px 12px #0009">Curves that move like the sea,<br>light that follows you in.</div>
 <div class="logo" style="background:var(--cream);width:190px;right:96px;bottom:100px"></div>
</div>'''

# 05 dining
posts['05-golden-hour'] = f'''
<div class="post grain" style="background:#000;color:var(--cream)">
 <img class="photo" src="{V}terrace-cafe.png">
 <div style="position:absolute;inset:0;background:linear-gradient(#0000 45%,#000b 100%)"></div>
 <div style="position:absolute;inset:0;background:linear-gradient(#0008 0%,#0000 22%)"></div>
 <div class="logo" style="background:var(--cream);width:190px;left:96px;top:84px"></div>
 <div style="position:absolute;left:96px;bottom:120px">
  <div class="script" style="font-size:128px;margin-left:-6px">slow mornings,</div>
  <div class="caps" style="font-size:84px;margin-top:4px">golden evenings.</div>
 </div>
</div>'''

# 06 gold foil on forest
posts['06-gold-standard'] = '''
<div class="post" style="background:url(p6-bg.png) center/cover">
 <div class="body" style="position:absolute;left:0;right:0;bottom:150px;text-align:center;font-size:24px;letter-spacing:.32em;color:var(--gold);opacity:.9">More than a destination</div>
</div>'''

CSS = CSS.replace('@MASK@', U('logo-alpha.png')).replace('@WM@', U('wordmark-alpha.png')).replace('@WR@', U('wave-row-alpha.png'))
html = '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>'
for k, v in posts.items():
    html += v.replace('<div class="post', f'<div id="p-{k}" class="post', 1)
html += '</body></html>'
open(os.path.join(here, 'posts.html'), 'w').write(html)
print(list(posts))
