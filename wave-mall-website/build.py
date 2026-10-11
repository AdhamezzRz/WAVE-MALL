#!/usr/bin/env python3
"""Build ONE self-contained file: ../wave-mall.html
Everything (CSS, JS, three.js, fonts, the film and its poster) is inlined.
Slide copy lives in src/slides/*.html; bilingual inline markup: [[English||العربية]]."""
import re, glob, os, base64
here = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(here, *a)
rd = lambda p: open(p, encoding='utf-8').read()
b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()

def bi(m): return f'<span class="l-en">{m.group(1)}</span><span class="l-ar">{m.group(2)}</span>'

html = rd(P('src/head.html'))
for f in sorted(glob.glob(P('src/slides/*.html'))): html += rd(f) + '\n'
html += rd(P('src/tail.html'))
html = re.sub(r'\[\[(.+?)\|\|(.+?)\]\]', bi, html, flags=re.S)

# media inline
poster = 'data:image/jpeg;base64,' + b64(P('assets/film-poster-web.jpg'))
html = html.replace('src="assets/film-web.mp4" poster="assets/film-poster-web.jpg"', f'poster="{poster}"')

# CSS inline (fonts as data URIs)
fonts = rd(P('assets/fonts.css'))
fonts = re.sub(r'url\((fonts/[^)]+\.woff2)\)', lambda m: 'url(data:font/woff2;base64,' + b64(P('assets', m.group(1))) + ')', fonts)
css = fonts + '\n' + rd(P('assets/app.css')) + '\n' + rd(P('assets/slides.css')) + '\n' + rd(P('assets/site.css'))
html = html.replace('<!--INLINE_CSS-->', '<style>' + css + '</style>')

# JS inline + film payload
def js(p):
    s = rd(P(p)); assert '</script' not in s.lower(), p; return s
scripts = '<script type="text/plain" id="filmData">' + b64(P('assets/film-web.mp4')) + '</script>\n'
scripts += '<script>' + js('assets/three.min.js') + '</script>\n<script>' + js('assets/scene.js') + '</script>\n<script>' + js('assets/app.js') + '</script>'
html = html.replace('<!--INLINE_JS-->', scripts)

out = os.path.join(os.path.dirname(here), 'wave-mall.html')
open(out, 'w', encoding='utf-8').write(html)
print(out, round(len(html.encode()) / 1e6, 2), 'MB')
