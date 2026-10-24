#!/usr/bin/env python3
"""Second set: posts 07-12. Reuses the CSS and logo masks from posts.py. Output: posts2.html"""
import os, base64
import posts as P
here = os.path.dirname(os.path.abspath(__file__))
U = lambda f: 'data:image/png;base64,' + base64.b64encode(open(os.path.join(here, f), 'rb').read()).decode()
V = '../visuals/'
CSS = P.CSS + '''
.lig{position:absolute;-webkit-mask:url(@LIG@) center/contain no-repeat;mask:url(@LIG@) center/contain no-repeat;aspect-ratio:720/560}
.gold{background:linear-gradient(118deg,#7d5b22 0%,#c9a45a 22%,#f1d999 38%,#b58c40 55%,#e6c77f 72%,#8a6527 100%)}
.it{font-family:Bodoni;font-style:italic;font-weight:400}
.mono{font-weight:500;text-transform:uppercase;letter-spacing:.28em;font-size:20px}
'''.replace('@LIG@', U('ligature-alpha.png'))

posts = {}

# 07 The Autumn Edit: magazine layout, photo + cream panel
posts['07-the-autumn-edit'] = f'''
<div class="post grain" style="background:var(--cream);color:var(--cocoa)">
 <img src="{V}editorial-bag.png" style="position:absolute;left:0;top:0;width:1080px;height:930px;object-fit:cover;object-position:50% 40%">
 <div style="position:absolute;inset:0 0 auto 0;height:220px;background:linear-gradient(#0007,#0000)"></div>
 <div class="logo" style="background:var(--cream);width:180px;left:96px;top:72px"></div>
 <div class="mono" style="position:absolute;right:96px;top:96px;color:var(--cream)">Vol. 01</div>
 <div style="position:absolute;left:96px;top:968px">
  <div class="script" style="font-size:110px;line-height:.8">the</div>
  <div class="caps" style="font-size:118px;margin-top:-4px">Autumn Edit</div>
 </div>
 <div class="body" style="position:absolute;left:100px;bottom:72px;font-size:26px">Camel, cream and a touch of green.</div>
 <div class="mono" style="position:absolute;right:96px;bottom:76px;font-size:18px">Swipe →</div>
</div>'''

# 08 The story behind our mark: macro of the AV ligature in gold on forest
posts['08-the-story-of-our-mark'] = '''
<div class="post grain" style="background:radial-gradient(120% 90% at 30% 20%,#25483a,#14291f 70%);color:var(--cream)">
 <div class="lig gold" style="width:1060px;left:10px;top:150px"></div>
 <div class="mono" style="position:absolute;left:96px;top:96px;color:var(--gold)">The story behind our mark</div>
 <div style="position:absolute;left:96px;bottom:200px">
  <div class="script" style="font-size:112px;color:var(--cream)">one stroke,</div>
  <div class="caps" style="font-size:70px;margin-top:2px">two letters, one wave.</div>
 </div>
 <div class="body" style="position:absolute;left:100px;bottom:96px;font-size:26px;max-width:820px;color:#d9d2c3;text-transform:none;letter-spacing:0;font-weight:400;line-height:1.4">Where the A meets the V, a single line rises and falls like the sea. It is the moment our name becomes a shape.</div>
</div>'''

# 09 Colours of The Wave: arch swatches
sw = [('Sea Glass', '#B3DCCF', '#5A3B22'), ('Cocoa', '#5A3B22', '#F1E9DB'), ('Caramel', '#7A4826', '#F1E9DB'),
      ('Desert Sand', '#BBA286', '#3e2a18'), ('Palm Forest', '#1D3A2E', '#F1E9DB'), ('Gold Hour', 'linear-gradient(160deg,#9b7533,#e4c67e 45%,#b28a42)', '#2b1f10')]
cells = ''.join(f'''<div style="display:flex;flex-direction:column;gap:14px">
  <div style="height:300px;border-radius:999px 999px 18px 18px;background:{c};display:flex;align-items:flex-end;padding:0 0 22px 26px;color:{t}" class="mono">{"#" + c[1:] if c.startswith("#") else "Foil"}</div>
  <div class="it" style="font-size:34px">{n}</div></div>''' for n, c, t in sw)
posts['09-colours-of-the-wave'] = f'''
<div class="post" style="background:var(--cream);color:var(--cocoa)">
 <div style="position:absolute;left:96px;top:96px">
  <div class="caps" style="font-size:84px">Colours of</div>
  <div class="script" style="font-size:120px;margin:-6px 0 0 -6px">The Wave</div>
 </div>
 <div style="position:absolute;left:96px;right:96px;top:420px;display:grid;grid-template-columns:repeat(3,1fr);gap:44px 36px">{cells}</div>
 <div class="logo" style="background:var(--cocoa);width:150px;right:96px;top:110px"></div>
</div>'''

# 10 A day at The Wave: timeline
day = [('10:00', 'Coffee on the terrace'), ('12:30', 'The style edit'), ('17:00', 'Golden hour on the steps'), ('20:30', 'Dinner under the lights')]
rows = ''.join(f'''<div style="display:grid;grid-template-columns:230px 1fr;align-items:center;padding:30px 0;border-top:1.5px solid #5a3b2240">
  <div class="it" style="font-size:66px;color:var(--caramel)">{t}</div><div class="caps" style="font-size:42px;letter-spacing:.01em">{l}</div></div>''' for t, l in day)
posts['10-a-day-at-the-wave'] = f'''
<div class="post" style="background:#e9dfcf;color:var(--cocoa)">
 <div style="position:absolute;inset:0;background:radial-gradient(70% 50% at 100% 0%,#f4ecdf,#0000)"></div>
 <div style="position:absolute;left:96px;top:110px">
  <div class="script" style="font-size:120px;line-height:.8">a day at</div>
  <div class="caps" style="font-size:132px">The Wave</div>
 </div>
 <div style="position:absolute;left:96px;right:96px;top:520px">{rows}</div>
 <div class="mono" style="position:absolute;left:96px;bottom:96px;font-size:18px">Save this for your weekend</div>
 <div class="logo" style="background:var(--cocoa);width:160px;right:96px;bottom:80px"></div>
</div>'''

# 11 After dark
posts['11-after-dark'] = f'''
<div class="post grain" style="background:#000;color:var(--cream)">
 <img class="photo" src="{V}night-ribbons.png">
 <div style="position:absolute;inset:0;background:linear-gradient(#0009 0%,#0000 25%,#0000 55%,#000c 100%)"></div>
 <div class="logo" style="background:var(--cream);width:180px;left:96px;top:84px"></div>
 <div style="position:absolute;left:96px;bottom:120px">
  <div class="caps" style="font-size:100px">After dark,</div>
  <div class="script" style="font-size:136px;margin:0 0 0 60px">the wave glows.</div>
 </div>
</div>'''

# 12 Which wave are you? (engagement)
opts = [('A', 'The Morning Wave', 'coffee and calm'), ('B', 'The Style Wave', 'new season, new looks'),
        ('C', 'The Golden Wave', 'sunset on the terrace'), ('D', 'The Night Wave', 'dinner and city lights')]
ol = ''.join(f'''<div style="display:grid;grid-template-columns:86px 1fr;align-items:center;padding:24px 0;border-top:1.5px solid #1d3a2e30">
  <div class="it" style="font-size:64px;color:var(--caramel)">{k}</div>
  <div><div class="caps" style="font-size:38px">{t}</div><div class="script" style="font-size:44px;color:var(--caramel);margin-top:4px">{d}</div></div></div>''' for k, t, d in opts)
posts['12-which-wave-are-you'] = f'''
<div class="post" style="background:repeating-linear-gradient(90deg,var(--forest) 0 30px,#264a3b 30px 60px);color:var(--forest)">
 <div style="position:absolute;left:90px;right:90px;top:90px;bottom:90px;background:var(--cream);border-radius:420px 420px 24px 24px"></div>
 <div style="position:absolute;left:0;right:0;top:250px;text-align:center">
  <div class="caps" style="font-size:96px">Which wave</div>
  <div class="script" style="font-size:120px;margin-top:-6px">are you?</div>
 </div>
 <div style="position:absolute;left:170px;right:170px;top:560px">{ol}</div>
 <div class="mono" style="position:absolute;left:0;right:0;bottom:150px;text-align:center;font-size:19px;color:var(--caramel)">Tell us your letter in the comments</div>
</div>'''

html = '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>'
for k, v in posts.items():
    html += v.replace('<div class="post', f'<div id="p-{k}" class="post', 1)
open(os.path.join(here, 'posts2.html'), 'w').write(html + '</body></html>')
print(list(posts))
