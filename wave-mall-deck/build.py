#!/usr/bin/env python3
"""Single-file HTML deck: Wave Mall logo options A vs B with mockups.
Run: python3 build.py  ->  ../wave-mall-logo-deck.html"""
import re, io, os, json, base64
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
P = lambda *a: os.path.join(here, *a)
U = '/root/.claude/uploads/be9dde7a-4204-5a77-aa94-14cffa81f8a2/'
bb = json.load(open(P('build/bbox.json')))
SRC = {'A': 'logoA_raw.svg', 'B': 'logoB_raw.svg'}

def symbol(n):
    s = open(P('build', SRC[n])).read()
    paths = re.findall(r'<path .*?/>', s, flags=re.S)
    paths = [p for p in paths if 'rgb(243,244,241)' not in p]          # drop background rect
    out = []
    for p in paths:
        p = p.replace(' transform="translate(0,0)"', '')
        p = p.replace('rgb(14,51,25)', 'var(--ink)').replace('url(#Gradient1)', 'var(--ink)')
        p = p.replace('rgb(91,101,77)', 'var(--ink2)').replace('rgb(159,163,148)', 'var(--ink2)')
        out.append(p)
    x0, y0, x1, y1 = bb[n]; pad = 18
    vb = f'{x0-pad} {y0-pad} {x1-x0+2*pad} {y1-y0+2*pad}'
    return f'<symbol id="lg{n}" viewBox="{vb}">{"".join(out)}</symbol>', (x1-x0+2*pad)/(y1-y0+2*pad)

SYM = {}; RATIO = {}
for n in 'AB':
    SYM[n], RATIO[n] = symbol(n)

def logo(n, h=None, w=None, cls=''):
    st = f'height:{h}px;' if h else f'width:{w}px;'
    return f'<svg class="lg {cls}" style="{st}aspect-ratio:{RATIO[n]:.4f}" role="img" aria-label="Wave logo {n}"><use href="#lg{n}"/></svg>'

def img(path, w=1600, crop=None, q=80):
    im = Image.open(path).convert('RGB')
    if crop: im = im.crop((0, 0, im.width, int(im.height*crop)))
    if im.width > w: im = im.resize((w, int(im.height*w/im.width)), Image.LANCZOS)
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()

M = os.path.join(root, 'wave-mall-mockups')
RB = os.path.join(M, 'real-building', 'full')
MF = os.path.join(M, 'full')
WO = os.path.join(M, 'real-building', 'wave-only')

CHROME = '<div class="foot"><span>WAVE MALL · LOGO DIRECTIONS</span><span>POWERED BY NAJ</span></div>'

def ab(eyebrow, title, cap, a, b, contain=False):
    c = ' contain' if contain else ''
    return f'''<section class="slide cmp{c} sp" data-title="{title}">
<div class="imgs"><figure class="ia"><img src="{a}" alt="{title} with logo A"><figcaption>A · Stacked</figcaption></figure>
<figure class="ib"><img src="{b}" alt="{title} with logo B"><figcaption>B · Horizontal</figcaption></figure></div>
<div class="head"><div class="eyebrow">{eyebrow}</div><h2>{title}</h2></div>
<div class="tog" role="group" aria-label="Compare"><button data-m="a">A</button><button data-m="split">A | B</button><button data-m="b">B</button></div>
<p class="cap">{cap}</p>{CHROME}</section>'''

def tiles(eyebrow, title, cap, items, contain=False):
    ts = ''.join(f'<figure><img src="{s}" alt="{t}"><figcaption>{t}</figcaption></figure>' for s, t in items)
    return f'''<section class="slide tiles" data-title="{title}"><div class="head"><div class="eyebrow">{eyebrow}</div><h2>{title}</h2></div>
<div class="tgrid">{ts}</div><p class="cap">{cap}</p>{CHROME}</section>'''

slides = []

# 1 cover
slides.append(f'''<section class="slide cover" data-title="Cover">
<div class="eyebrow">Brand direction · Logo options and mockups</div>
<div class="cv">{logo('A', h=470)}</div>
<div class="covfoot"><span>New Cairo · October 2026</span><span>Prepared by NAJ</span></div></section>''')

# 2 two directions
slides.append(f'''<section class="slide light" data-title="Two directions">
<div class="head"><div class="eyebrow">The options</div><h2>One wordmark, two sign-offs</h2></div>
<div class="two">
<div class="card"><div class="stage">{logo('A', h=300)}</div><h3>A · Stacked wordmark</h3><p>A hairline rule under the wordmark, then spaced capitals: MALL NEW CAIRO. Built to stand alone as a monument.</p></div>
<div class="card"><div class="stage">{logo('B', w=640)}</div><h3>B · Horizontal lockup</h3><p>A vertical divider, then MALL and NEW CAIRO on two lines. Built for wide bands and fascias.</p></div>
</div>{CHROME}</section>''')

def detail(n, name, role, best, watch):
    sizes = ''.join(f'<div class="sz">{logo(n, w=w)}<span>{w}px</span></div>' for w in (360, 190, 100))
    return f'''<section class="slide light" data-title="Logo {n}">
<div class="head"><div class="eyebrow">Option {n}</div><h2>{name}</h2></div>
<div class="det">
<div class="big stage">{logo(n, w=820 if n=='B' else None, h=None if n=='B' else 340)}</div>
<div class="side">
<div class="rev stage">{logo(n, w=420 if n=='B' else 360)}</div>
<div class="sizes">{sizes}</div>
</div></div>
<div class="notes"><div><b>Reads as</b><p>{role}</p></div><div><b>Best for</b><p>{best}</p></div><div><b>Watch</b><p>{watch}</p></div></div>
{CHROME}</section>'''
slides.append(detail('A', 'Stacked wordmark', 'Quiet luxury: a landmark, a hotel, a boutique.', 'Facade and atrium monuments, tall pylons, bags, gift boxes, tote bags, avatars.', 'The hairline rule and tagline need a minimum width of about 120px or they fill in.'))
slides.append(detail('B', 'Horizontal lockup', 'Modern and organised: a flagship, a campus, a district.', 'Wide fascias, billboards, door vinyl, valet desk, email headers, cards.', 'MALL and NEW CAIRO are small at distance, and the wordmark shrinks in square formats.'))

# real building
slides.append(ab('On your building · Golden hour', 'The ribbon facade, rebranded',
  'A has presence on the dark soffit. B stretches along the curve and reads as a strip of text.',
  img(f'{RB}/01-golden-A.png', crop=.68), img(f'{RB}/01-golden-B.png', crop=.68)))
slides.append(ab('On your building · Night', 'The LED ribbons at night',
  'The sign band is narrow, so both logos stay modest. A sits better in the centre bay.',
  img(f'{RB}/02-night-A.png'), img(f'{RB}/02-night-B.png'), contain=True))
slides.append(ab('On your building · Day', 'From the plaza steps',
  'Daylight reveals the problem with B: the descriptor is hard to read at this distance.',
  img(f'{RB}/03-day-A.png'), img(f'{RB}/03-day-B.png')))

# wave only
slides.append(f'''<section class="slide hero" data-title="Wave only · night"><img src="{img(f"{WO}/02-night-wave.png")}" alt="Night view with the word Wave only">
<div class="head"><div class="eyebrow">Word only</div><h2>Just "Wave"</h2></div>
<p class="cap">With the sign reduced to the word alone, the facade carries it from across the plaza.</p>{CHROME}</section>''')
slides.append(tiles('Word only', 'Wave on the building, three ways',
  'The same wordmark, with no tagline. It scales up cleanly where the full logo cannot.',
  [(img(f'{WO}/01-golden-wave.png', w=1100), 'Golden hour'), (img(f'{WO}/03-day-wave.png', w=1100), 'Daytime'), (img(f'{WO}/04-closeup-wave.png', w=1100), 'Close-up of the sign')]))

# mall scenes
S = [('01-facade', 'Facade at blue hour', 'On a travertine wall A feels monumental. B suits the wide entrance header above the glazing.'),
     ('02-atrium', 'Atrium feature wall', 'Both work on emerald fluted stone. A is more ceremonial; B is more corporate.'),
     ('03-brand-flatlay', 'Bags, boxes, cards', 'A fills bags and the tote better. B fits card and box lids.'),
     ('04-pylon', 'Roadside pylon and billboard', 'A fills the tall pylon face. B suits the billboard format, but its descriptor gets small.'),
     ('05-instagram', 'Instagram profile and story', 'The wordmark carries the avatar in both. A holds up better in square formats.'),
     ('06-wayfinding', 'Doors, directory, valet', 'A is stronger on the door vinyl. B matches the horizontal fascia of the valet desk.')]
for n, t, c in S:
    slides.append(ab('Inside and around the mall', t, c, img(f'{MF}/{n}-A.png'), img(f'{MF}/{n}-B.png')))

# verdict
slides.append(f'''<section class="slide dark" data-title="Verdict"><div class="head"><div class="eyebrow">Side by side</div><h2>Where each one wins</h2></div>
<table class="vt"><tr><th></th><th>A · Stacked</th><th>B · Horizontal</th></tr>
<tr><td>Facade and soffit sign</td><td class="win">Stronger</td><td>Works, reads thin</td></tr>
<tr><td>Wide fascias and billboards</td><td>Works</td><td class="win">Stronger</td></tr>
<tr><td>Square and tall formats</td><td class="win">Stronger</td><td>Wordmark shrinks</td></tr>
<tr><td>Packaging and gifts</td><td class="win">Stronger</td><td>Works</td></tr>
<tr><td>Distance legibility</td><td class="win">Better</td><td>Descriptor gets small</td></tr>
<tr><td>Digital headers and cards</td><td>Works</td><td class="win">Stronger</td></tr>
</table>{CHROME}</section>''')

# recommendation
slides.append(f'''<section class="slide light" data-title="Recommendation"><div class="head"><div class="eyebrow">Recommendation</div><h2>Lead with A. Keep B as the wide lockup.</h2></div>
<div class="rec"><div class="stage">{logo('A', h=240)}<small>Primary mark · facade, app icon, packaging</small></div>
<div class="stage">{logo('B', w=520)}<small>Secondary lockup · banners, fascias, headers</small></div></div>
<p class="lede">Use the word "Wave" alone where the sign band is narrow, as on this building's soffit at night.</p>{CHROME}</section>''')

# caveats
slides.append(f'''<section class="slide dark" data-title="Before this goes out"><div class="head"><div class="eyebrow">Before this goes to the client</div><h2>Open points</h2></div>
<ul class="pts">
<li><b>Mockups are AI renders.</b> Landscaping, crowds and exact sign position are illustrative, not survey-accurate.</li>
<li><b>Invented details.</b> Storefront names in some interiors and the Instagram handles are not real tenants or accounts.</li>
<li><b>Confirm the identity.</b> Please confirm the project name and the signboard on site before any of this is shown as final.</li>
<li><b>Trademark check.</b> "Wave" is a common name. A search is needed before the name or logo is locked.</li>
<li><b>Arabic lockup.</b> An Arabic version of the logo is not yet designed and needs a native review.</li>
</ul>{CHROME}</section>''')

body = '\n'.join(slides)
fonts = open(P('../wave-mall-website/assets/fonts.css')).read()
fonts = re.sub(r'url\((fonts/[^)]+\.woff2)\)', lambda m: 'url(data:font/woff2;base64,' + base64.b64encode(open(P('../wave-mall-website/assets', m.group(1)), 'rb').read()).decode() + ')', fonts)
# keep only the two latin faces used here
faces = re.findall(r'@font-face\s*\{.*?\}', fonts, flags=re.S)
fonts = '\n'.join(f for f in faces if ('Bricolage' in f) or ("IBM Plex Mono" in f and 'font-weight: 400' in f))

html = open(P('template.html')).read()
html = html.replace('/*FONTS*/', fonts).replace('<!--SYMBOLS-->', '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' + SYM['A'] + SYM['B'] + '</svg>').replace('<!--SLIDES-->', body)
out = os.path.join(root, 'wave-mall-logo-deck.html')
open(out, 'w', encoding='utf-8').write(html)
print(out, round(len(html.encode())/1e6, 1), 'MB', len(slides), 'slides')
