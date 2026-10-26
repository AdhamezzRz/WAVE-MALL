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
| `/visit/` | `/ar/visit/` | Area map (streets, malls, landmarks, distances), address, directions |
| `/contact/` | `/ar/contact/` | Contact form, details, FAQ |
| `/privacy/`, `/terms/` | `/ar/...` | Legal drafts |

Also `/sitemap.xml`, `/robots.txt`, `/journal/feed.xml`, `/healthz`, and `POST /api/enquiry`, `/api/contact`, `/api/subscribe`.

The header shows the floor you are on like a lift (R at the top of a page, B2 at the bottom). The menu lists the pages beside a photograph of each place, which changes as you hover.

## Deploy on Hostinger (Node.js web app)

1. Push this folder to a GitHub or **gitlab.com** repository (Hostinger connects to either; self-managed GitLab is not supported).
2. hPanel → Websites → Add website → **Node.js** → Import Git repository → connect the account and pick the repo and branch.
3. Build settings: framework **Express**, root directory `wave-mall-app` (or `/` if the folder is the repo root), build command empty, output directory empty, **entry file `server.js`**, Node 22 (22.13 or newer: the leasing office uses Node's built-in SQLite).
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
| `DATA_DIR`    | Folder for the leasing office database (default `./data`). **Set this on Hostinger** to a folder outside the app, e.g. `/home/<user>/wave-data`, so redeploys never touch it |
| `ADMIN_DB`    | Full path to the database file instead of `DATA_DIR` (tests use `:memory:`) |

## Leasing office (`/admin`)

A sales ERP for the leasing team, built into the same app. It is private (`noindex`, blocked in `robots.txt`, every page behind a sign-in) and stores everything in one SQLite file.

**First run:** open `https://thewavemall.com/admin`. With no accounts yet it asks you to create the first administrator. Then go to **Settings** to set list rates, deal rules and document details, and **Team & targets** to invite the team (each invite shows a one-time temporary password). **Settings → Sample data** fills the office with a realistic month of fictional brands, deals, leases and invoices so you can try every screen; one click removes it again.

| Module | What it does |
| --- | --- |
| Dashboard | Occupancy, committed space, weighted pipeline, new leads, signed this month and overdue rent; pipeline funnel, lead sources, the plaza plan by status, what's coming up, your tasks, what needs attention, latest activity |
| Inbox | Every form sent on the website. Leasing enquiries open a lead automatically (brand, contact, wanted size); contact messages can be turned into a lead or archived |
| Leads | Filters and saved views (mine, hot, closing, overdue, stale), a 0–100 lead score, stage stepper, activity timeline, units that fit with one-click holds, lost reasons |
| Pipeline | Kanban by stage with drag and drop, value and probability per column, per-agent view |
| Calendar & tasks | Month view of viewings, meetings, calls and tasks; quick scheduling; overdue / today / upcoming task lists |
| Offers | Unit picker with a live deal calculator (rent, terrace, service, escalation, rent-free, deposit, key money, effective rate, discount against list). Offers below the allowed discount go to a manager for approval. Branded proposal ready to print or save as PDF |
| Leases | Created from an accepted offer; activation leases the units and generates the invoice schedule (monthly, quarterly or yearly in advance) plus deposit and key money |
| Billing | Due, overdue and upcoming invoices, payments (full or partial), extra charges, receivables aging, who is behind, printable invoices |
| Units & plan | Both levels drawn from the real floor plans and coloured by status; holds with expiry, list rates per unit, history |
| Brands | Brand directory with contacts, their leads and leases |
| Reports | Occupancy by level, rent roll, WALE, forecast, tenant mix, why deals are lost, team against monthly targets, lead sources and conversion, aging, upcoming expiries; CSV exports |
| Team, subscribers, settings, audit log | Roles, targets, newsletter list, rates and rules, one-click backup, and a record of who did what |

**Roles:** *Viewer* reads everything; *Agent* works leads, activities, holds and offers; *Manager* also approves offers, writes leases, takes payments and sets targets; *Administrator* also manages the team and settings.

**Security:** passwords are hashed with scrypt, sessions live in the database (12 hours idle), every form carries a CSRF token, sign-in is rate-limited, and the audit log keeps sign-ins and every change.

**Backups:** Settings → Backup downloads a consistent copy of the database. Keep one off the server every week. To restore, stop the app and put the file back as `leasing.db` in `DATA_DIR`.

## GitLab

`.gitlab-ci.yml` runs the test suite on every push and merge request. Hostinger deploys from the branch you connect (use `main`); the pipeline is a gate, not a deployer.

## Editing

- Copy: `src/content.js` and `src/content-keep.json` (English and Arabic; Arabic is a draft for native review).
- Figures: `src/data.js` holds every area and unit size from the developer's presentation. The plans in `src/plan.js` are drawn from the architect's floor plans.
- Pages and sections: `src/pages.js`; shell, head, header, footer: `src/render.js`.
- Styles: `public/css/site.css`. Motion and navigation: `public/js/site.js`.
- Area map (home and Visit): drawn from OpenStreetMap data in `assets-src/osm/` by `python3 scripts/build-map.py`, which writes the base drawing `public/img/area-map.svg` and the street labels and places in `src/map-data.json` (`src/map.js` renders them). To add a place, add its name and coordinates to `PLACES` in the script and rebuild. Map data © OpenStreetMap contributors (ODbL); the credit is shown under the map.
- Logo: `src/logo-paths.json` (vector paths pulled from the identity PDF), rendered inline so every letter can animate.
- Images: `assets-src/reference-night.webp` is the client's night photograph; `assets-src/hf/` are Higgsfield photographs built from it and from the presentation renders (morning, golden hour, plaza, corner, tower, court, details). The rooftop frame sign is the only logo on the building, and it is the exact identity wordmark: Higgsfield produced each view with the steel frame empty (`assets-src/hf/frames/`), then `scripts/mount-sign.py` mounts the vector logo on the frame (daylight letters or lit at night). Rebuild with `python3 scripts/optimize-images.py`.

## Brand

White (`#fbfaf6`) ground with forest `#283833` ink; forest is used as the highlight (leasing band, active floor). Type: Bodoni Moda for display, Montserrat (the identity's typeface) for the header and menu, Archivo for labels, Almarai for all Arabic text. Sea glass and cocoa appear only inside photographs.
