#!/usr/bin/env python3
"""Hand-built vector recreation of the lit 'The WAVE' sign (wave-stroke lettering).
All lettering is monoline strokes with round caps, so it scales and recolours cleanly."""
SW = 44          # stroke width of the WAVE letters
H = 150          # letter height (centre-line)

def wave_paths():
    # W: two valleys, built as one sine with 4 half-waves
    W = "M0,0 C48,0 47,150 95,150 C143,150 142,0 190,0 C238,0 237,150 285,150 C333,150 332,0 380,0"
    # A: a hump
    A = "M0,150 C75,150 75,0 150,0 C225,0 225,150 300,150"
    # V: a valley
    V = "M0,0 C62,0 63,150 125,150 C187,150 188,0 250,0"
    # E: spine + three softly waving bars
    E = ("M24,0 C2,0 2,150 24,150 "
         "M24,0 C72,-12 122,12 190,0 "
         "M24,75 C72,63 122,87 190,75 "
         "M24,150 C72,138 122,162 190,150")
    return W, A, V, E

def the_paths():
    # small bold rounded 'The' (monoline), cap height ~ 100
    T = "M0,8 H66 M33,8 V100"
    h = "M104,-14 V100 M104,58 C104,36 120,30 134,30 C152,30 160,42 160,60 V100"
    e = "M184,66 H232 C232,44 216,30 204,30 C188,30 176,46 176,66 C176,86 188,100 206,100 C220,100 230,94 236,86"
    return T, h, e

def group(color, glow=False):
    W, A, V, E = wave_paths(); T, h, e = the_paths()
    st = f'fill="none" stroke="{color}" stroke-linecap="round" stroke-linejoin="round"'
    big = f'<g {st} stroke-width="{SW}">'
    # x offsets (centre-line coordinates); letters nearly touch like the lit sign
    big += f'<path transform="translate(310,60)" d="{W}"/>'
    big += f'<path transform="translate(712,60)" d="{A}"/>'
    big += f'<path transform="translate(1018,60)" d="{V}"/>'
    big += '</g>'
    big += f'<g {st} stroke-width="48"><path transform="translate(1312,60)" d="{E}"/></g>'
    small = f'<g {st} stroke-width="30" transform="translate(12,116) scale(.9)">'
    small += f'<path d="{T}"/><path d="{h}"/><path d="{e}"/></g>'
    return big + small

VB = "0 0 1650 280"
def svg(bg=None, color="#0B0B0B", glow=False, name="The WAVE"):
    defs = ''
    body = group(color)
    if glow:
        defs = ('<defs><filter id="g" filterUnits="userSpaceOnUse" x="-120" y="-120" width="1890" height="520">'
                '<feGaussianBlur stdDeviation="14" result="b1"/><feGaussianBlur stdDeviation="34" result="b2"/>'
                '<feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>')
        body = f'<g filter="url(#g)">{body}</g>'
    rect = f'<rect x="-120" y="-120" width="1890" height="520" fill="{bg}"/>' if bg else ''
    vb = "-120 -120 1890 520" if bg else VB
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{name}">{defs}{rect}{body}</svg>'

if __name__ == '__main__':
    out = {
        '01-neon-sign-look': dict(bg='#0A0A0A', color='#FFF2B0', glow=True),
        '02-flat-gold-on-black': dict(bg='#0B0B0B', color='#D9A441'),
        '03-flat-black-on-ivory': dict(bg='#F3F4F1', color='#151515'),
        '04-flat-forest-on-ivory': dict(bg='#F3F4F1', color='#0E3319'),
        '05-flat-ivory-on-emerald': dict(bg='#046146', color='#F3F4F1'),
        '06-transparent-black': dict(color='#151515'),
        '07-transparent-ivory': dict(color='#F3F4F1'),
        '08-transparent-gold': dict(color='#D9A441'),
    }
    for n, kw in out.items():
        open(n + '.svg', 'w').write(svg(**kw))
    print(len(out), 'files')
