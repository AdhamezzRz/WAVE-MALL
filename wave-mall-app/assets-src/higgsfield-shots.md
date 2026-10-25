# Higgsfield shot list (generated 25 Oct 2026; kept for reshoots)

Rule: the only logo on the building is the rooftop frame sign, exactly as in
`reference-night.webp` (THE WAVE in the official serif, on an open steel frame on
the roof above the central curve). No other signage anywhere.

Reference media ids (uploaded): night reference `4b436d72-4739-4689-9b8a-8071ea65f80f`,
aerial render `712faa8c-250c-407e-bc17-de6f0786f6df`, corner render `adbfbe8b-65cd-4c1b-b0b8-d301b521eed9`.
Model: gpt_image_2_5, quality high, 2k.

1. morning: reference-night, same framing, 9am clear sky, sign letters solid white by day, lights off. 21:9
2. golden: reference-night, same framing, 17:30 golden hour, sign just switching on. 21:9
3. plaza-eye: eye level on the plaza steps under the sails, sign visible on the roof above. 16:9 (aerial ref)
4. corner-day: corner render as a real photo, morning, no facade sign, rooftop sign visible if in view. 16:9
5. vertical-night: 9:16 crop-like view of the sign and lit ribbons for mobile hero. 9:16
6. court: inside the open court looking up between the wings, daylight. 4:5

## Round 2 (25 Oct 2026): full set of angles, from the architect's renders
aerial-day, aerial-night (sign on the FRONT wing roof above the open centre), corner-dusk,
axis (up the central stair), stone (portal block), lounge (front-wing terrace), north90
(full length at dusk), sculpture (the leaf on the stair), shopfronts (plaza terraces).

## Round 3 (25 Oct 2026)
The leaf sculpture is replaced everywhere by the A-V ligature of the mark in forest-green
patinated bronze on a travertine plinth on the stair landing (assets-src/ligature.jpg,
media c1ad7249-7f40-4978-8a4b-105f10bbacc8). Images that were not the building itself
(court, abstract ribbon, boutique, cafe, steps, lounge) are removed from the site.

## Round 4: the identity wordmark on the rooftop sign

Higgsfield could not draw the A–V ligature exactly, so each sign view was edited to leave
the steel frame empty (`hf/frames/`). `scripts/mount-sign.py` then mounts the wordmark from
`src/logo-paths.json` on the frame, sized to the frame in each view, with sunlit returns by
day and a warm internal glow at dusk and night. `night.webp` replaces the client's
reference photograph, which carried generic lettering.
