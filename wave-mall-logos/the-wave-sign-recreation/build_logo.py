#!/usr/bin/env python3
"""The WAVE sign as clean vector: each neon tube is one smooth round-capped stroke.
Coordinates are measured from the reference photo (838x408 px space)."""
import json, sys
SW = 25.5        # tube width for W, A, V
SW_E = 21.5      # tube width for the E bars
# (x, y) key points measured on the reference
W_PATH = "M176,199 C192,201 203,252 220,252 C246,252 262,187 296,187 C330,187 336,252 361,252 C391,252 400,190 424,184"
A_PATH = "M407,243 C436,243 438,185 467,185 C496,185 505,246 538,246"
V_PATH = "M523,182 C548,182 556,252 586,252 C616,252 622,177 664,176 L749,177"
E_MID = "M666,209 L752,204"
E_BOT = "M666,238 L752,233"
THE = ('<path d="M97,238 H119 M108,238 V269"/>'
       '<path d="M131,238 V269 M131,255 C131,249 135,247 140,247 C147,247 150,251 150,258 V269"/>'
       '<path d="M158,259 H176 C176,251 171,247 167,247 C161,247 157,252 157,259 C157,266 161,270 167,270 C171,270 174,268 176,265"/>')

def svg(color, bg=None, glow=False, preview=False):
    tubes = (f'<g fill="none" stroke="{color}" stroke-linecap="round" stroke-linejoin="round">'
             f'<g stroke-width="{SW}"><path d="{W_PATH}"/><path d="{A_PATH}"/><path d="{V_PATH}"/></g>'
             f'<g stroke-width="{SW_E}"><path d="{E_MID}"/><path d="{E_BOT}"/></g>'
             f'<g stroke-width="9">{THE}</g></g>')
    defs = ''
    if glow:
        defs = ('<defs><filter id="g" filterUnits="userSpaceOnUse" x="40" y="110" width="780" height="220">'
                '<feGaussianBlur stdDeviation="5" result="a"/><feGaussianBlur stdDeviation="13" result="b"/>'
                '<feMerge><feMergeNode in="b"/><feMergeNode in="a"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>')
        tubes = f'<g filter="url(#g)">{tubes}</g>'
    rect = f'<rect x="40" y="110" width="780" height="220" fill="{bg}"/>' if bg else ''
    vb = "40 110 780 220" if bg else "84 160 690 124"
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="The WAVE">{defs}{rect}{tubes}</svg>'

if __name__ == '__main__':
    OUT = '.'
    variants = {
     '01-neon-sign-look': dict(color='#FFF3B8', bg='#0A0A0A', glow=True),
     '02-flat-gold-on-black': dict(color='#D9A441', bg='#0B0B0B'),
     '03-flat-black-on-ivory': dict(color='#151515', bg='#F3F4F1'),
     '04-flat-forest-on-ivory': dict(color='#0E3319', bg='#F3F4F1'),
     '05-flat-ivory-on-emerald': dict(color='#F3F4F1', bg='#046146'),
     '06-transparent-black': dict(color='#151515'),
     '07-transparent-ivory': dict(color='#F3F4F1'),
     '08-transparent-gold': dict(color='#D9A441'),
    }
    for n, kw in variants.items(): open(f'{OUT}/{n}.svg', 'w').write(svg(**kw))
    pass
    print('written', len(variants))
