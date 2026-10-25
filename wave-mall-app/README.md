# The Wave, New Cairo Mall: website

Bilingual (English / Arabic) brand and leasing site for The Wave. Node.js + Express, server-rendered pages, GSAP + Lenis motion, no build step.

```
npm install
npm start          # http://localhost:3000
npm run dev        # restarts on changes
npm test           # routes, headers, enquiry API
npm run package    # builds release/the-wave-website.zip for Hostinger
```

## Pages

| English | Arabic | What |
| --- | --- | --- |
| `/` | `/ar/` | Preloader (the wordmark draws itself and settles into the header), full-screen hero that opens through the building's plan and moves from morning to golden hour to night, figures, scenes, plan, place, journal |
| `/the-wave/` | `/ar/the-wave/` | The building, gallery, interactive floor directory (R to B2), the mark |
| `/experience/` | `/ar/experience/` | A day from 09:00 to 21:00, what you will find |
| `/leasing/` | `/ar/leasing/` | Plaza and street-level unit schedules linked to the plan, enquiry form |
| `/journal/` | `/ar/journal/` | Journal index and articles (`src/journal.js`) |
| `/visit/` | `/ar/visit/` | Map, address, directions |
| `/contact/` | `/ar/contact/` | Contact form, details, FAQ |
| `/privacy/`, `/terms/` | `/ar/...` | Legal drafts |

Also `/sitemap.xml`, `/robots.txt`, `/journal/feed.xml`, `/healthz`, and `POST /api/enquiry`, `/api/contact`, `/api/subscribe`.

The header shows the floor you are on like a lift (R at the top of a page, B2 at the bottom). The menu lists the pages beside a photograph of each place, which changes as you hover.

## Deploy on Hostinger (Node.js web app)

1. Push this folder to a GitHub or **gitlab.com** repository (Hostinger connects to either; self-managed GitLab is not supported).
2. hPanel → Websites → Add website → **Node.js** → Import Git repository → connect the account and pick the repo and branch.
3. Build settings: framework **Express**, root directory `wave-mall-app` (or `/` if the folder is the repo root), build command empty, output directory empty, **entry file `server.js`**, Node 22.
4. Environment variables (optional, for the enquiry email): see below. Without SMTP settings, enquiries are written to the app's runtime log.
5. Deploy. Every push to the connected branch triggers a new build. Hostinger creates the Git webhook itself; if auto-deploys stop, check the repo's Settings → Webhooks.

Or upload `release/the-wave-website.zip` (made by `npm run package`) in the same flow with "Upload archive"; it contains everything except `node_modules`, which Hostinger installs.

The app reads `PORT` from the environment (Hostinger sets it) and trusts one proxy hop for HTTPS detection.

### Environment variables

| Name          | Purpose                                                     |
| ------------- | ----------------------------------------------------------- |
| `SITE_URL`    | Public origin, e.g. `https://thewavemall.com` (canonical, sitemap, OG) |
| `SMTP_HOST`   | SMTP server (Hostinger email: `smtp.hostinger.com`)         |
| `SMTP_PORT`   | `465` (TLS, default) or `587`                               |
| `SMTP_USER`   | Mailbox login, e.g. `leasing@thewavemall.com`               |
| `SMTP_PASS`   | Mailbox password                                            |
| `MAIL_FROM`   | From address (defaults to `SMTP_USER`)                      |
| `LEASING_TO`  | Where enquiries go (defaults to `SMTP_USER`)                |

## GitLab

`.gitlab-ci.yml` runs the test suite on every push and merge request. Hostinger deploys from the branch you connect (use `main`); the pipeline is a gate, not a deployer.

## Editing

- Copy: `src/content.js` and `src/content-keep.json` (English and Arabic; Arabic is a draft for native review).
- Figures: `src/data.js` holds every area and unit size from the developer's presentation. The plans in `src/plan.js` are drawn from the architect's floor plans.
- Pages and sections: `src/pages.js`; shell, head, header, footer: `src/render.js`.
- Styles: `public/css/site.css`. Motion and navigation: `public/js/site.js`.
- Logo: `src/logo-paths.json` (vector paths pulled from the identity PDF), rendered inline so every letter can animate.
- Images: `assets-src/reference-night.webp` is the client's night photograph; `assets-src/hf/` are Higgsfield photographs built from it and from the presentation renders (morning, golden hour, plaza, corner, tower, court, details). The rooftop frame sign is the only logo on the building, and it is the exact identity wordmark: Higgsfield produced each view with the steel frame empty (`assets-src/hf/frames/`), then `scripts/mount-sign.py` mounts the vector logo on the frame (daylight letters or lit at night). Rebuild with `python3 scripts/optimize-images.py`.

## Brand

White (`#fbfaf6`) ground with forest `#283833` ink; forest is used as the highlight (leasing band, active floor). Type: Bodoni Moda for display, Montserrat (the identity's typeface) for the header and menu, Archivo for labels, Almarai for all Arabic text. Sea glass and cocoa appear only inside photographs.
