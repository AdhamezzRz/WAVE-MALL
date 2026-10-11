# Wave Mall · Location & Market Study (website)

**Deliverables: `../wave-mall.html` (English first) and `../wave-mall-ar.html` (Arabic first)** — each one self-contained file; both have the EN | عربي switch (CSS, JS, 3D library, fonts and the
concept film are all inside). Upload it as `index.html` to any host, or just double-click it.

- Scroll to read; the sticky 3D site behind the page follows the section you are in.
- `L` switches English / عربي, `M` opens the section menu.
- Deep links: `wave-mall.html#s-explore`, `#s-catchment`, `#s-fork` ...

## Editing
Sources live in `src/refs.json` (use `{{src:1,2,3}}` in a slide to list reference numbers).
Copy lives in `src/slides/*.html` (inline bilingual markup `[[English||العربية]]`),
styles in `assets/*.css`, behaviour in `assets/app.js` and `assets/scene.js`.
Rebuild the single file with `python3 build.py` (needs only Python 3).

## Caveats shown on the page
- 3D uses real OpenStreetMap offsets around the pin; roads and the building massing are schematic.
- The film is AI-generated mood footage (Higgsfield), not the approved design.
- Most project and price data comes from broker listings and is unverified.
- Arabic copy needs a native review before client use.
