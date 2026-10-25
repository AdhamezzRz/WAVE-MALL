"""Rebuild public/img from source images (needs Pillow + numpy).

assets-src/hf/  photographs generated with Higgsfield for this site
assets-src/*.webp  the client's renders (placeholder signage painted out), graded warm
../wave-posts/visuals/  earlier Higgsfield photographs from the launch posts
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
OUT = APP / "public" / "img"
SRC = APP / "assets-src"
POSTS = ROOT / "wave-posts" / "visuals"

# name: (source, grade the render?)
IMAGES = {
    # the actual building (mockups from the client's site photos, official wordmark mounted by sign.py)
    "day": (SRC / "day.webp", False),
    "golden": (SRC / "golden.webp", False),
    "night": (SRC / "night.webp", False),
    # the presentation renders, official wordmark in place of the placeholder
    "aerial": (SRC / "render-aerial.webp", False),
    "corner": (SRC / "render-dusk.webp", False),
    "facade": (SRC / "render-day.webp", False),
    "map": (SRC / "map.webp", "map"),
    # details and life on the plaza (Higgsfield)
    "ribbon": (SRC / "hf/ribbon.webp", False),
    "boutique": (SRC / "hf/boutique.webp", False),
    "steps": (SRC / "hf/steps.webp", False),
    "terrace": (POSTS / "terrace-cafe.png", False),
}
WIDTHS = (640, 1080, 1600, 2200)


def grade(im, mode):
    """Warm the cool CG renders and add fine grain so they sit with the photographs."""
    a = np.asarray(im).astype(np.float32) / 255
    if mode == "map":
        lum = a @ np.array([0.3, 0.59, 0.11])
        ink = np.array([40, 56, 51]) / 255
        paper = np.array([246, 244, 238]) / 255
        a = ink + (paper - ink) * np.clip((lum[..., None] - 0.08) * 1.35, 0, 1) ** 0.8
    else:
        lum = (a @ np.array([0.3, 0.59, 0.11]))[..., None]
        a = lum + (a - lum) * 0.62                      # desaturate
        a = a * np.array([1.06, 1.0, 0.88])             # warm
        a = np.clip((a - 0.5) * 1.08 + 0.5, 0, 1)       # gentle contrast
    rng = np.random.default_rng(7)
    a = a + rng.normal(0, 0.018, a.shape[:2])[..., None]
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))


for name, (path, g) in IMAGES.items():
    im = Image.open(path).convert("RGB")
    if g:
        im = grade(im, g)
    for w in WIDTHS:
        if w > im.width * (1.35 if g else 1) and w != WIDTHS[0]:
            continue
        h = round(im.height * w / im.width)
        r = im.resize((w, h), Image.LANCZOS)
        if w > im.width:
            r = r.filter(ImageFilter.UnsharpMask(radius=1.1, percent=55, threshold=2))
        r.save(OUT / f"{name}-{w}.webp", quality=80, method=6)
    print(name, im.size)
