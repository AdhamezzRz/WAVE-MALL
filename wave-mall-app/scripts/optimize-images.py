"""Rebuild public/img from the source visuals (needs Pillow).

Renders in assets-src/ are the client's design renders with the "LOGO"
placeholder painted out; the lifestyle images come from the launch posts.
"""
from pathlib import Path
from PIL import Image, ImageFilter

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
OUT = APP / "public" / "img"
SRC = {
    "aerial": APP / "assets-src/aerial.webp",
    "dusk": APP / "assets-src/dusk.webp",
    "side": APP / "assets-src/side.webp",
    "map": APP / "assets-src/map.webp",
    "architecture": ROOT / "wave-posts/visuals/architecture-curves.png",
    "fashion": ROOT / "wave-posts/visuals/editorial-trench.png",
    "bag": ROOT / "wave-posts/visuals/editorial-bag.png",
    "terrace": ROOT / "wave-posts/visuals/terrace-cafe.png",
    "ribbons": ROOT / "wave-posts/visuals/night-ribbons.png",
    "green": ROOT / "wave-posts/visuals/green-paper.png",
}
WIDTHS = (640, 1280, 1920)
MAX_UPSCALE = 1.6  # the renders are small; allow a mild upscale with sharpening
NO_UPSCALE = {"architecture", "fashion", "bag", "terrace", "ribbons", "green"}

for name, path in SRC.items():
    im = Image.open(path).convert("RGB")
    for w in WIDTHS:
        limit = 1 if name in NO_UPSCALE else MAX_UPSCALE
        if w > im.width * limit and w != WIDTHS[0]:
            continue
        h = round(im.height * w / im.width)
        r = im.resize((w, h), Image.LANCZOS)
        if w > im.width:
            r = r.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
        r.save(OUT / f"{name}-{w}.webp", quality=80, method=6)
    im.resize((24, round(24 * im.height / im.width)), Image.LANCZOS).save(OUT / f"{name}-lqip.jpg", quality=40)
    print(name, im.size)
