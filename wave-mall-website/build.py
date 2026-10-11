#!/usr/bin/env python3
"""Build one self-contained file per language:
  ../wave-mall.html     (English first, Arabic one click away)
  ../wave-mall-ar.html  (Arabic first, English one click away)
Everything (CSS, JS, three.js, fonts, the film and its poster) is inlined.
Slide copy: src/slides/*.html with inline bilingual markup [[English||العربية]].
Sources: src/refs.json; use {{src:1,2,3}} in a slide to list reference numbers."""
import re, glob, os, base64, json, html as H

here = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(here, *a)
rd = lambda p: open(p, encoding='utf-8').read()
b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()


def bi(m):
    return f'<span class="l-en">{m.group(1)}</span><span class="l-ar">{m.group(2)}</span>'


R = json.load(open(P('src/refs.json'), encoding='utf-8'))
REF = {r['n']: r for r in R['refs']}


def srcs(m):
    ns = [int(x) for x in m.group(1).split(',') if x.strip()]
    for n in ns:
        assert n in REF, ('unknown ref', n)
    links = ' '.join(f'<a href="#ref-{n}" title="{H.escape(REF[n]["t"])}">{n}</a>' for n in ns)
    return f'<p class="srcs"><span class="mono">[[Sources||المصادر]]</span> {links}</p>'


ANALYSIS = ('<p class="srcs"><span class="mono">[[Basis||الأساس]]</span> '
            '[[NAJ analysis built on the sourced slides above; a recommendation, not measured data.||'
            'تحليل من NAJ مبني على الشرائح الموثّقة أعلاه؛ توصية وليست بيانات مقيسة.]]</p>')


def refs_slide():
    o = ['<section class="slide" id="s-references" data-title="Sources and references||المصادر والمراجع" '
         'data-sec="Sources||المصادر" data-cam="far" data-dim=".25" data-labels="none"><div class="in">',
         '<div class="eyebrow rv">[[Sources and references||المصادر والمراجع]]</div>',
         '<h2 class="rv">[[Where every number comes from||من أين جاءت كل الأرقام]]</h2>',
         '<p class="lead rv">[[Each slide lists its sources as numbers; tap one to jump here. Links were collected on 11 Oct 2026. '
         'Broker listings are marketing claims and often conflict, so verify before quoting.||'
         'كل شريحة تعرض مصادرها بأرقام؛ اضغط على الرقم للوصول إلى هنا. جُمعت الروابط في 11 أكتوبر 2026. '
         'إعلانات الوسطاء ادعاءات تسويقية وكثيرًا ما تتضارب، فتُراجع قبل الاستشهاد بها.]]</p>',
         '<div class="legend rv">' + ''.join(
             f'<span><span class="tag k-{k}">{k}</span> [[{v["en"]}||{v["ar"]}]]</span>' for k, v in R['kinds'].items()) + '</div>',
         '<div class="refgrid">']
    for g in R['groups']:
        items = [r for r in R['refs'] if r['g'] == g['id']]
        if not items:
            continue
        lis = ''.join(
            f'<li id="ref-{r["n"]}"><span class="rn">{r["n"]}</span>'
            f'<a href="{H.escape(r["u"])}" target="_blank" rel="noopener">{H.escape(r["t"])}</a>'
            f'<span class="tag k-{r["k"]}">{r["k"]}</span></li>' for r in items)
        o.append(f'<div class="glass rv"><h3>[[{g["en"]}||{g["ar"]}]]</h3><ol class="reflist">{lis}</ol></div>')
    o.append('</div>')
    o.append('<div class="glass top-a rv"><h3>[[Method notes||ملاحظات المنهجية]]</h3><ul class="plain">'
             '<li>[[Distances are straight-line from the pin using OpenStreetMap coordinates [14].||المسافات خطية من الموقع بإحداثيات OpenStreetMap [14].]]</li>'
             '<li>[[Drive times are OSRM free-flow [15]; the peak range is our 1.5–2× assumption, consistent with World Bank congestion findings [23].||أزمنة القيادة من OSRM بدون زحمة [15]؛ ونطاق الذروة افتراض منا بمعامل 1.5–2× يتفق مع نتائج البنك الدولي [23].]]</li>'
             '<li>[[Population is the JRC GHSL model [16] (households = people ÷ 4.0, our assumption); it likely under-counts new compounds.||السكان من نموذج JRC GHSL [16] (الأسر = السكان ÷ 4.0 افتراض منا)؛ وغالبًا يقل عن الواقع في الكمبوندات الجديدة.]]</li>'
             '<li>[[The day-in-the-life grid, audience matrix, positioning, campaigns and roadmap are NAJ analysis, not measured data.||شبكة اليوم ومصفوفة الجمهور والتموضع والحملات وخارطة الطريق تحليل من NAJ وليست بيانات مقيسة.]]</li>'
             '<li>[[The 3D scene uses OSM positions; roads and the building massing are schematic, and the building size is a visual estimate from the client’s screenshot [17].||المجسم ثلاثي الأبعاد يستخدم مواقع OSM؛ الطرق وكتلة المبنى توضيحية، وحجم المبنى تقدير بصري من لقطة العميل [17].]]</li>'
             '<li>[[Some pages (for example Aqarmap) blocked automated reading; their facts came through search snippets and need confirmation.||بعض الصفحات (مثل عقار ماب) منعت القراءة الآلية؛ فجاءت بياناتها من مقتطفات البحث وتحتاج تأكيدًا.]]</li>'
             '</ul></div>')
    o.append('</div></section>')
    return '\n'.join(o)


def build(lang):
    html = rd(P('src/head.html'))
    for f in sorted(glob.glob(P('src/slides/*.html'))):
        html += rd(f) + '\n'
    html += refs_slide() + '\n' + rd(P('src/tail.html'))
    html = re.sub(r'\{\{src:([0-9, ]+)\}\}', srcs, html)
    html = html.replace('{{analysis}}', ANALYSIS)
    html = re.sub(r'\[\[(.+?)\|\|(.+?)\]\]', bi, html, flags=re.S)
    html = html.replace('@LANG@', lang).replace('@DIR@', 'rtl' if lang == 'ar' else 'ltr')
    poster = 'data:image/jpeg;base64,' + b64(P('assets/film-poster-web.jpg'))
    html = html.replace('src="assets/film-web.mp4" poster="assets/film-poster-web.jpg"', f'poster="{poster}"')
    fonts = rd(P('assets/fonts.css'))
    fonts = re.sub(r'url\((fonts/[^)]+\.woff2)\)',
                   lambda m: 'url(data:font/woff2;base64,' + b64(P('assets', m.group(1))) + ')', fonts)
    css = '\n'.join([fonts, rd(P('assets/app.css')), rd(P('assets/slides.css')), rd(P('assets/site.css'))])
    html = html.replace('<!--INLINE_CSS-->', '<style>' + css + '</style>')

    def js(p):
        s = rd(P(p))
        assert '</script' not in s.lower(), p
        return s
    scripts = '<script type="text/plain" id="filmData">' + b64(P('assets/film-web.mp4')) + '</script>\n'
    scripts += '<script>' + js('assets/three.min.js') + '</script>\n<script>' + js('assets/scene.js') + '</script>\n<script>' + js('assets/app.js') + '</script>'
    html = html.replace('<!--INLINE_JS-->', scripts)
    out = os.path.join(os.path.dirname(here), 'wave-mall.html' if lang == 'en' else 'wave-mall-ar.html')
    open(out, 'w', encoding='utf-8').write(html)
    print(out, round(len(html.encode()) / 1e6, 2), 'MB')


for L in ('en', 'ar'):
    build(L)
