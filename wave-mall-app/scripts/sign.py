"""Put the official wordmark on the building photographs.

For each scene: find the old sign letters inside a box (brighter than the band
behind them), erase them by diffusion fill, then mount the vector wordmark at
the same angle with lighting to match the scene. Outputs to assets-src/.
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter, ImageChops

APP = Path(__file__).resolve().parents[1]
SRC = APP.parent / "wave-mall-mockups/real-building/wave-only"
LOGO = Image.open(APP / "assets-src/logo-white.png").split()[3]

def box_blur(a, r):
    for ax in (0, 1):
        p = np.pad(a, [(r, r) if i == ax else (0, 0) for i in range(2)], mode="edge")
        c = np.cumsum(p, axis=ax)
        c = np.concatenate([np.zeros_like(np.take(c, [0], axis=ax)), c], axis=ax)
        n = a.shape[ax]
        a = (np.take(c, range(2 * r + 1, 2 * r + 1 + n), axis=ax) - np.take(c, range(0, n), axis=ax)) / (2 * r + 1)
    return a

def inpaint(rgb, mask, passes=6):
    a = rgb.astype(np.float32)
    known = (~mask).astype(np.float32)
    out = a.copy()
    for r in (24, 12, 6, 3)[:passes]:
        wb = box_blur(box_blur(known, r), r)
        fill = np.stack([box_blur(box_blur(out[..., c] * known, r), r) for c in range(3)], -1) / np.maximum(wb, 1e-3)[..., None]
        out = np.where(mask[..., None], fill, out)
    return out

def row_fill(rgb, mask):
    """Fill masked pixels by interpolating along each row between known neighbours."""
    out = rgb.copy()
    h, w = mask.shape
    xs = np.arange(w)
    for y in range(h):
        m = mask[y]
        if not m.any() or m.all():
            continue
        for c in range(3):
            out[y, m, c] = np.interp(xs[m], xs[~m], rgb[y, ~m, c])
    return out

def place(name, letters, thresh, colour, angle=0.0, height=1.15, glow=0, glow_colour=None, relief=0, pad=60, dy=0, grain=0.01):
    im = Image.open(name if Path(name).is_absolute() else SRC / name).convert("RGB")
    x0, y0, x1, y1 = letters
    X0, Y0, X1, Y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    reg = im.crop((X0, Y0, X1, Y1))
    # work in a frame where the band runs horizontally
    rot = reg.rotate(-angle, resample=Image.BICUBIC, expand=True)
    a = np.asarray(rot).astype(np.float32)
    lum = a @ np.array([0.3, 0.59, 0.11])
    inner = np.zeros(lum.shape, bool)
    ch, cw = lum.shape
    # the letters box, rotated with the region, approximated by the central area
    bw, bh = x1 - x0, y1 - y0
    import math
    rw = int(abs(bw * math.cos(math.radians(angle))) + abs(bh * math.sin(math.radians(angle))) * 0.35)
    rh = int(bh * 0.95 / max(math.cos(math.radians(angle)), 0.5) * 0.75)
    inner[ch // 2 - rh // 2: ch // 2 + rh // 2, cw // 2 - rw // 2: cw // 2 + rw // 2] = True
    m = inner & (lum > thresh)
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MaxFilter(5))) > 0
    filled = row_fill(a, m)
    # soften the filled area slightly so it reads as continuous material
    soft = np.stack([box_blur(box_blur(filled[..., c], 2), 2) for c in range(3)], -1)
    filled = np.where(m[..., None], soft, filled)
    back = Image.fromarray(np.clip(filled, 0, 255).astype(np.uint8)).rotate(angle, resample=Image.BICUBIC, expand=True)
    # crop back to the region size and paste, using a feathered mask of the inpainted area only
    bx = (back.width - reg.width) // 2
    by = (back.height - reg.height) // 2
    back = back.crop((bx, by, bx + reg.width, by + reg.height))
    mm = Image.fromarray((m * 255).astype(np.uint8)).rotate(angle, expand=True)
    mm = mm.crop((bx, by, bx + reg.width, by + reg.height)).filter(ImageFilter.GaussianBlur(1.5))
    reg = Image.composite(back, reg, mm)
    base = im.copy()
    base.paste(reg, (X0, Y0))

    # the wordmark
    lh = int(bh * height / max(math.cos(math.radians(angle)), 0.5) * 0.85)
    lw = int(LOGO.width * lh / LOGO.height)
    logo = LOGO.resize((lw, lh), Image.LANCZOS).rotate(angle, resample=Image.BICUBIC, expand=True)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2 + dy
    ox, oy = int(cx - logo.width / 2), int(cy - logo.height / 2)
    if glow:
        g = logo.filter(ImageFilter.GaussianBlur(glow))
        gm = Image.new("L", base.size, 0); gm.paste(g, (ox, oy))
        base = Image.composite(Image.new("RGB", base.size, glow_colour or colour), base, gm.point(lambda v: int(v * 0.8)))
    if relief:
        sh = logo.filter(ImageFilter.GaussianBlur(relief * 0.7))
        sm = Image.new("L", base.size, 0); sm.paste(sh, (ox + relief, oy + relief))
        base = Image.composite(Image.new("RGB", base.size, (18, 16, 12)), base, sm.point(lambda v: int(v * 0.5)))
    face = np.asarray(Image.new("RGB", base.size, colour)).astype(np.float32)
    grad = np.linspace(1.0, 1.0, base.height)[:, None, None]
    yy = np.arange(base.height)[:, None, None]
    grad = 1.06 - 0.16 * np.clip((yy - oy) / max(logo.height, 1), 0, 1)
    face = Image.fromarray(np.clip(face * grad, 0, 255).astype(np.uint8))
    fm = Image.new("L", base.size, 0); fm.paste(logo, (ox, oy))
    base = Image.composite(face, base, fm)
    rng = np.random.default_rng(3)
    b = np.asarray(base).astype(np.float32) / 255
    b = b + rng.normal(0, grain, b.shape[:2])[..., None]
    return Image.fromarray((np.clip(b, 0, 1) * 255).astype(np.uint8))

if __name__ == "__main__":
    pres = APP / "assets-src/presentation"
    out = APP / "assets-src"
    # Presentation renders: the "LOGO" placeholders replaced by the official wordmark.
    place(str(pres / "render-dusk.png"), (1028, 356, 1100, 392), 120, (246, 244, 236), glow=2, glow_colour=(255, 236, 200), height=1.45, pad=14, grain=0.006).save(out / "render-dusk.webp", quality=95)
    place(str(pres / "render-aerial.webp"), (1700, 400, 1845, 472), 112, (244, 242, 236), angle=-5, glow=3, glow_colour=(255, 236, 200), height=1.05, pad=20, grain=0.006).save(out / "render-aerial.webp", quality=95)
    # the day render has no placeholder: mount the mark on the white canopy band in the gold of the trim
    place(str(pres / "render-day.png"), (478, 214, 556, 252), 999, (196, 160, 82), angle=3, relief=1, height=1.0, pad=8, grain=0.004).save(out / "render-day.webp", quality=95)
    print("ok")
