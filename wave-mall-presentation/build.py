#!/usr/bin/env python3
"""Concatenate src/head.html + src/slides/*.html + src/tail.html into index.html.
Inline bilingual markup: [[English||العربية]] becomes two language spans."""
import re, glob, os
here = os.path.dirname(os.path.abspath(__file__))
def rd(p): return open(os.path.join(here, p), encoding='utf-8').read()
def bi(m):
    en, ar = m.group(1), m.group(2)
    return f'<span class="l-en">{en}</span><span class="l-ar">{ar}</span>'
body = rd('src/head.html')
for f in sorted(glob.glob(os.path.join(here, 'src/slides/*.html'))):
    body += open(f, encoding='utf-8').read() + '\n'
body += rd('src/tail.html')
body = re.sub(r'\[\[(.+?)\|\|(.+?)\]\]', bi, body, flags=re.S)
open(os.path.join(here, 'index.html'), 'w', encoding='utf-8').write(body)
print('index.html', len(body), 'bytes,', len(glob.glob(os.path.join(here, 'src/slides/*.html'))), 'slides')
