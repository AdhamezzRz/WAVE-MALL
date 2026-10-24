"""Rebuild public/img from the source visuals in the repo (needs Pillow)."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "wave-mall-app" / "public" / "img"
SRC = {
    "hero-golden": ROOT / "wave-mall-mockups/real-building/wave-only/01-golden-wave.png",
    "night": ROOT / "wave-mall-mockups/real-building/wave-only/02-night-wave.png",
    "architecture": ROOT / "wave-posts/visuals/architecture-curves.png",
    "fashion": ROOT / "wave-posts/visuals/editorial-trench.png",
    "bag": ROOT / "wave-posts/visuals/editorial-bag.png",
    "terrace": ROOT / "wave-posts/visuals/terrace-cafe.png",
    "ribbons": ROOT / "wave-posts/visuals/night-ribbons.png",
    "green": ROOT / "wave-posts/visuals/green-paper.png",
}
WIDTHS = (640, 1280, 1920)

for name, path in SRC.items():
    im = Image.open(path).convert("RGB")
    for w in WIDTHS:
        if w > im.width and w != WIDTHS[0]:
            continue
        h = round(im.height * w / im.width)
        im.resize((w, h), Image.LANCZOS).save(OUT / f"{name}-{w}.webp", quality=78, method=6)
    im.resize((24, round(24 * im.height / im.width)), Image.LANCZOS).save(OUT / f"{name}-lqip.jpg", quality=40)
    print(name, im.size)
