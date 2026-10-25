"""Mount the exact identity wordmark on the rooftop steel frame of each photograph.

Each base image (assets-src/hf/frames/) is a Higgsfield photograph of the building
with the sign frame left empty; the wordmark comes from src/logo-paths.json (rendered
to a mask with scripts/render-sign-mask.cjs), so the letters match the identity file
exactly.

    python3 scripts/mount-sign.py mask.png assets-src/hf/frames out/ [name ...]
"""
import json, sys
import numpy as np
import cv2
from PIL import Image

MASK, SRC, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
only = sys.argv[4:]

# WAVE cap-height box (TL, TR, BR, BL) in image pixels, measured on the frame.
SIGNS = {
    'morning':      dict(q=[(1178,332),(1524,332),(1524,424),(1178,424)], mode='day'),
    'axis':         dict(q=[(1172,122),(1497,122),(1497,206),(1172,206)], mode='day'),
    'aerial-day':   dict(q=[(1186,384),(1500,384),(1500,448),(1186,448)], mode='day', depth=(1.5,3.5), side=(.55,.56,.57)),
    'golden':       dict(q=[(1199,300),(1508,300),(1508,380),(1199,380)], mode='lit', glow=.45),
    'plaza':        dict(q=[(1243,219),(1452,211),(1452,264),(1243,271)], mode='lit', glow=.8),
    'north90':      dict(q=[(1201,282),(1432,304),(1432,372),(1201,359)], mode='lit', glow=.8),
    'corner-dusk':  dict(q=[(1395,481),(1650,500),(1650,571),(1395,562)], mode='lit', glow=.9),
    'tower':        dict(q=[(452,790),(1060,796),(1060,951),(452,948)], mode='lit', glow=1.0),
    'night':        dict(q=[(1194,367),(1534,367),(1534,460),(1194,460)], mode='lit', glow=1.0),
    'aerial-night': dict(q=[(1222,440),(1486,440),(1486,492),(1222,492)], mode='lit', glow=.9, depth=(0,2)),
}

m = np.asarray(Image.open(MASK).convert('L')).astype(np.float32) / 255
rows = np.where(m.max(1) > .5)[0]
gap = np.where(np.diff(rows) > 1)[0][0]
wy0, wy1 = rows[gap + 1], rows[-1]
cols = np.where(m[wy0:wy1].max(0) > .5)[0]
wx0, wx1 = cols[0], cols[-1]
srcq = np.float32([(wx0, wy0), (wx1, wy0), (wx1, wy1), (wx0, wy1)])


def warp(img, H, size, ss):
    S = np.diag([ss, ss, 1]).astype(np.float64)
    big = cv2.warpPerspective(img, S @ H, (size[0] * ss, size[1] * ss), flags=cv2.INTER_LINEAR)
    return cv2.resize(big, size, interpolation=cv2.INTER_AREA)


for name, s in SIGNS.items():
    if only and name not in only:
        continue
    base = np.asarray(Image.open(f'{SRC}/{name}.webp').convert('RGB')).astype(np.float32) / 255
    h, w, _ = base.shape
    q = np.float32(s['q'])
    H = cv2.getPerspectiveTransform(srcq, q)
    cap = np.linalg.norm(q[3] - q[0])
    face = warp(m, H, (w, h), 3)
    dx, dy = s.get('depth', (max(1, cap * .02), max(1.5, cap * .035)))
    T = np.float64([[1, 0, dx], [0, 1, dy], [0, 0, 1]])
    side = np.clip(warp(m, T @ H, (w, h), 3) - face, 0, 1)

    out = base.copy()
    if s['mode'] == 'day':
        # sunlit fabricated letters: bright face with shaded returns; aerials also
        # throw a shadow onto the roof behind the frame
        if 'shadow' in s:
            sx, sy, sa = s['shadow']
            sh = cv2.GaussianBlur(warp(m, np.float64([[1, 0, sx], [0, 1, sy], [0, 0, 1]]) @ H, (w, h), 2), (0, 0), 2.5)
            out *= 1 - sa * np.clip(sh - face, 0, 1)[..., None]
        ys = np.linspace(0, 1, h)[:, None]
        top, bot = q[:, 1].min() - cap, q[:, 1].max()
        g = np.clip((ys - top) / (bot - top), 0, 1)
        col = np.stack([.985 - .06 * g, .975 - .06 * g, .955 - .06 * g], -1)
        col = np.broadcast_to(col, (h, w, 3))
        out = out * (1 - side[..., None]) + np.float32(s.get('side', (.58, .58, .57))) * side[..., None]
        out = out * (1 - face[..., None]) + col * face[..., None]
    else:
        # internally lit channel letters: warm white face with halo
        k = s['glow']
        r1, r2 = max(1.5, cap * .05), max(6, cap * .35)
        halo = cv2.GaussianBlur(face, (0, 0), r1) * .55 + cv2.GaussianBlur(face, (0, 0), r2) * .35
        warm = np.float32([1.0, .74, .42])
        out = out * (1 - side[..., None]) + np.float32([.32, .25, .18]) * side[..., None]
        out = 1 - (1 - out) * (1 - np.clip(halo[..., None] * warm * k, 0, 1))
        col = np.float32([1.0, .965, .9])
        out = out * (1 - face[..., None]) + col * face[..., None]

    # match the photograph's softness and grain inside the sign area
    x0, y0 = int(q[:, 0].min() - cap * 1.5), int(q[:, 1].min() - cap * 1.6)
    x1, y1 = int(q[:, 0].max() + cap * 1.5), int(q[:, 1].max() + cap * 1.0)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    roi = out[y0:y1, x0:x1]
    roi = cv2.GaussianBlur(roi, (0, 0), .55)
    rng = np.random.default_rng(7)
    roi = roi + rng.normal(0, .005, roi.shape).astype(np.float32)
    blend = np.clip(cv2.GaussianBlur(np.maximum(face, side)[y0:y1, x0:x1], (0, 0), 6) * 4, 0, 1)[..., None]
    if s['mode'] == 'lit':
        blend = np.maximum(blend, np.clip(cv2.GaussianBlur(face[y0:y1, x0:x1], (0, 0), cap * .35) * 6, 0, 1)[..., None])
    out[y0:y1, x0:x1] = roi * blend + out[y0:y1, x0:x1] * (1 - blend)

    Image.fromarray((np.clip(out, 0, 1) * 255 + .5).astype(np.uint8)).save(f'{OUT}/{name}.png')
    print('mounted', name)
