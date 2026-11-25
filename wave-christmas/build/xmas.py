#!/usr/bin/env python3
"""Christmas teaser posts. Builds xmas.html (stills) and overlay.html (transparent text layers for the film)."""
import os, base64
here = os.path.dirname(os.path.abspath(__file__))
WP = os.path.join(here, '..', '..', 'wave-posts', 'build')
U = lambda p: 'data:image/png;base64,' + base64.b64encode(open(p, 'rb').read()).decode()
F = lambda p: 'data:font/woff2;base64,' + base64.b64encode(open(os.path.join(WP, 'fonts', p), 'rb').read()).decode()
LOGO = U(os.path.join(WP, 'logo-alpha.png'))
CSS = f'''
@font-face{{font-family:Pinyon;src:url({F('PinyonScript-normal.woff2')})}}
:root{{--cream:#f3ece0;--gold:#d9bd7a;--cocoa:#5a3b22}}
*{{margin:0;box-sizing:border-box}} body{{background:transparent;font-family:'Inter Display','Inter',sans-serif}}
.post,.ov{{position:relative;width:1080px;height:1350px;overflow:hidden;margin-bottom:40px}}
.ov{{background:transparent}}
.photo{{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}}
.logo{{position:absolute;-webkit-mask:url({LOGO}) center/contain no-repeat;mask:url({LOGO}) center/contain no-repeat;aspect-ratio:2044/1164}}
.caps{{font-weight:500;text-transform:uppercase;letter-spacing:-.01em;line-height:.98}}
.script{{font-family:Pinyon;line-height:1}}
.mono{{font-weight:500;text-transform:uppercase;letter-spacing:.3em;font-size:20px}}
.sh{{text-shadow:0 2px 24px #0008}}
'''
V = '../visuals/'
stills = {
'01-something-is-wrapping-up': f'''
<div class="post" style="background:#000;color:var(--cream)">
 <img class="photo" src="{V}gift.png" style="object-position:50% 40%">
 <div style="position:absolute;inset:0;background:linear-gradient(#0000 48%,#000b 100%)"></div>
 <div class="sh" style="position:absolute;left:84px;bottom:170px">
  <div class="caps" style="font-size:104px">Something</div>
  <div class="script" style="font-size:132px;margin:-4px 0 0 30px">is wrapping up.</div>
 </div>
 <div class="mono" style="position:absolute;left:88px;bottom:84px;color:var(--gold)">December · The Wave</div>
 <div class="logo" style="background:var(--cream);width:170px;right:84px;bottom:70px"></div>
</div>''',
'03-dear-december': f'''
<div class="post" style="background:#000;color:var(--cream)">
 <img class="photo" src="{V}bauble.png">
 <div style="position:absolute;inset:0;background:linear-gradient(#000a 0%,#0000 30%,#0000 70%,#000b 100%)"></div>
 <div class="sh" style="position:absolute;right:84px;top:96px;text-align:right">
  <div class="caps" style="font-size:96px">Dear December,</div>
  <div class="script" style="font-size:98px;margin-top:6px;white-space:nowrap">we’ve been expecting you.</div>
 </div>
 <div class="mono" style="position:absolute;left:88px;bottom:92px;color:var(--gold)">The season begins soon</div>
 <div class="logo" style="background:var(--cream);width:170px;right:84px;bottom:72px"></div>
</div>''',
}
overlays = {
'ov-intro': '''<div class="ov" style="color:var(--cream)"><div class="sh" style="position:absolute;left:0;right:0;top:130px;text-align:center">
  <div class="caps" style="font-size:92px">The Wave is</div><div class="script" style="font-size:132px;margin-top:2px">getting wrapped.</div></div></div>''',
'ov-end': '''<div class="ov" style="color:var(--cream)"><div style="position:absolute;inset:auto 0 0 0;height:420px;background:linear-gradient(#0000,#000c)"></div><div class="sh" style="position:absolute;left:0;right:0;top:120px;text-align:center">
  <div class="script" style="font-size:120px">see you under</div><div class="caps" style="font-size:92px;margin-top:4px">the lights.</div></div>
  <div class="logo" style="background:var(--cream);width:220px;left:430px;bottom:96px"></div>
  <div class="mono" style="position:absolute;left:0;right:0;bottom:60px;text-align:center;color:var(--gold);font-size:17px">Coming this December</div></div>''',
# unwrap film: lower-third title over the opening seconds
'ov-unwrap-intro': '''<div class="ov" style="color:var(--cream)"><div style="position:absolute;inset:auto 0 0 0;height:520px;background:linear-gradient(#0000,#000d)"></div>
  <div class="sh" style="position:absolute;left:84px;bottom:120px"><div class="caps" style="font-size:96px">Something</div>
  <div class="script" style="font-size:128px;margin:-4px 0 0 30px">is wrapping up.</div></div></div>''',
# behind-the-scenes timelapse: small top caption, native social style
'ov-bts-top': '''<div class="ov" style="color:#fff"><div style="position:absolute;inset:0 0 auto 0;height:360px;background:linear-gradient(#0008,#0000)"></div>
  <div style="position:absolute;left:72px;top:78px;text-shadow:0 2px 14px #000a">
  <div class="mono" style="font-size:19px;color:#f3ece0;opacity:.9">Behind the scenes</div>
  <div class="caps" style="font-size:66px;margin-top:14px">We're wrapping</div>
  <div class="script" style="font-size:92px;margin:-2px 0 0 6px">The Wave.</div></div></div>''',
# unwrap film: opaque end card on the gold-foil logo background from the brand posts
'ov-unwrap-end': f'''<div class="ov" style="color:var(--cream);background:url({U(os.path.join(WP, 'p6-bg.png'))}) center/cover">
  <div style="position:absolute;left:0;right:0;top:150px;text-align:center"><div class="script" style="font-size:118px;color:var(--cream)">see you under</div>
  <div class="caps" style="font-size:88px;margin-top:4px;color:var(--cream)">the lights.</div></div>
  <div class="mono" style="position:absolute;left:0;right:0;bottom:150px;text-align:center;color:var(--gold);font-size:20px">Coming this December</div></div>''',
}


def page(d, cls):
    h = '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>'
    for k, v in d.items():
        h += v.replace(f'<div class="{cls}"', f'<div id="p-{k}" class="{cls}"', 1)
    return h + '</body></html>'


open(os.path.join(here, 'xmas.html'), 'w').write(page(stills, 'post'))
open(os.path.join(here, 'overlay.html'), 'w').write(page(overlays, 'ov'))
print('ok')
