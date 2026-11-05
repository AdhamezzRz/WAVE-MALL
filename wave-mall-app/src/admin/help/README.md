# Help & training lessons

Each lesson is a small script. The same script makes:

- the **video** in English and Arabic (`scripts/help-record.js` plays it in Chromium on a fresh copy of the office with the sample data, with an animated cursor, click ripples and a spotlight);
- the **transcript** under the video and the **captions** (every `say` becomes one timed line);
- the **live tour** ("Show me on the real page"), which points at each step on the person's own screen.

## Where lessons go

One file per area in `src/admin/help/lessons/<area>.js`, exporting an array. The registry (`src/admin/help/index.js`) loads every file in that folder, so a new file needs no other change.

Areas (the order of the academy page): `start`, `overview`, `sales`, `property`, `revenue`, `finance`, `operations`, `records`, `people`, `insight`, `office`, `portal`.

## A lesson

```js
{
  id: 'cheques-receive',            // unique, lower-case-with-hyphens; it is also the file name of the video
  area: 'revenue',
  module: '/admin/cheques',         // the sidebar address it belongs to (contextual "?" help and the live tour start here)
  also: ['/admin/invoices'],        // optional: other addresses whose "?" should show this lesson
  order: 20,                        // position inside the area
  level: 'basic',                   // or 'advanced'
  roles: ['finance'],               // learning paths: leasing, finance, operations, management, admin, tenant, or 'all' (every staff path)
  title: { en: 'Receiving cheques', ar: 'استلام الشيكات' },
  summary: { en: 'One sentence: what you will learn.', ar: 'جملة واحدة: ما الذي ستتعلمه.' },
  prepare: async ({ db, h, lang, base }) => {},   // optional: change the sample data before recording (runs before each language)
  steps: [ ... ],
}
```

## Steps

The first step must be `{ go }`. Every step may have `say: { en, ar }` (a line of the transcript, spoken while the step happens). At least one step must say something.

| Step | What it does |
| --- | --- |
| `{ go: '/admin/cheques', say }` | opens a page (an `/admin` or `/portal` address) |
| `{ say }` | just a line of narration, no pointing |
| `{ point: 'css', say }` | glides the cursor to the element and spotlights it |
| `{ click: 'css', say, nav: true }` | spotlights, then clicks. `nav: true` when the click opens another address (the recorder waits for it). A form that posts back to the same page is detected by itself: no `nav` |
| `{ type: ['css', { en: 'text', ar: 'نص' }], say }` | clicks into a field and types (character by character, with key sounds). The text may be a plain string. `clear: false` keeps what is there |
| `{ select: ['css', 'value'], say }` | chooses an option of a `<select>` by its **value** (same in both languages), or by label with `{ en, ar }` |
| `{ check: 'css', say }` | ticks a checkbox |
| `{ hover: 'css', say }` | moves over an element (tooltips) |
| `{ scroll: 'css' or 400, say }` | scrolls to an element, or by pixels |
| `{ key: 'Escape', say }` | presses a key |
| `{ pause: 800 }` | waits (ms) |
| `{ wait: 'css' }` | waits until the element is visible |

Options on any step with a selector:

- `has: 'text'` or `has: { en, ar }`: of the elements matching the selector, the first one containing that text (for buttons whose only difference is their label);
- `nth: 2`: the third match (0-based);
- `spot: 'css'`: spotlight a bigger area than the element clicked;
- `keep: true`: keep the spotlight on after the step.

### Selectors that last

- Plain CSS only (the live tour runs `document.querySelectorAll` in the person's browser). `:has()` is fine.
- Prefer addresses and names over looks: `a[href="/admin/leads/new"]`, `form[action="/admin/leads"] button.btn--primary`, `select[name=category]`, `.bar__actions a[href$="/access"]`, `tr[data-href^="/admin/leads/"]` (the first row of a list).
- Never select by visible text with CSS; use `has` (it has both languages).
- Record ids: open records from their list (`tr[data-href^=…]`) instead of typing `/admin/leases/7`, so the live tour works on real data too. Sample-data ids are stable for recording when you must (e.g. `/admin/people/5`).

## Writing the lines

- Speak to the person: "Choose New lead", "Your balance shows…". Short sentences, one idea per line; 8–25 words.
- The Arabic is written for Arabic readers (not word for word) and uses the office's own Arabic labels for buttons and pages (`node -e "console.log(require('./src/admin/i18n').AR['New lead'])"`).
- A line is shown for about 2.6 words a second (2.3 in Arabic), never under 2.2 s.
- 6–12 steps, 40–90 seconds a lesson. Split longer topics.

## Recording

```
node scripts/help-record.js --check --only=cheques-receive      # walk the steps fast in both languages: selectors, nothing recorded
node scripts/help-record.js --only=cheques-receive              # record English and Arabic
node scripts/help-record.js --area=revenue --lang=ar --port=3820
```

- Each lesson boots its own office in memory (about 8 s), so lessons never depend on each other. Use a free `--port` when several recorders run at once; the manifest is locked, so they can.
- A step whose element is missing stops that lesson with `lesson [lang] step N: nothing visible matches …`; the other lessons go on, and the exit code is 1.
- Output: `public/admin/help-media/<lang>/<id>.mp4` (H.264, 1280×720, about 0.85 MB a minute), `.vtt`, `.json` (the cues with times and the address after each step), `.jpg` (poster), and `public/admin/help-media/manifest.json`.
- Check a few frames: `ffmpeg -ss 20 -i public/admin/help-media/ar/<id>.mp4 -frames:v 1 /tmp/x.png`.
- `--verbose` prints each step as it plays. `--crf=28` for sharper (bigger) videos.
- Lessons without a recording still appear, with their steps as the transcript and the live tour.
