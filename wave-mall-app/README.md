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
3. Build settings: framework **Express**, root directory `wave-mall-app` (or `/` if the folder is the repo root), build command empty, output directory empty, **entry file `server.js`**, Node 22 or 24 recommended (20 and 18 also work: on Node 22.13+ the leasing office uses Node's built-in SQLite, on older versions the bundled sql.js engine, with nothing to build).
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
| `DATA_DIR`    | Folder for the leasing office database (default `./data`). **Set this on Hostinger** to `~/wave-data` (`~` is the hosting account's home folder), so redeploys never touch it. If the folder cannot be created, the same folder name in the account's home is used instead |
| `OWNER_EMAIL` | The owner's sign-in for the leasing office, e.g. `owner@thewavemallcairo.com`. Created on start-up as an administrator with HR access (only if no account has that email yet) |
| `OWNER_PASSWORD` | That account's password (10+ characters). Keep it only in Hostinger's environment variables, never in the code |
| `OWNER_NAME`  | Optional display name for that account (default "Owner") |
| `OWNER_RESET` | Set to `1` for one deploy to reset the owner's password to `OWNER_PASSWORD` (and sign them out everywhere); remove it afterwards |
| `ADMIN_FILES` | Optional folder for uploaded documents (default `DATA_DIR/files`) |
| `ADMIN_DB`    | Full path to the database file instead of `DATA_DIR` (tests use `:memory:`) |
| `ADMIN_WEB_FILES` | Optional folder for website images uploaded in the office (default: the documents folder with `-web` added, so under `DATA_DIR` too) |
| `ADMIN_JOBS`  | Background jobs (reminders, overdue notices, offer expiry, scheduled messages) run by default; `0` turns them off |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | WhatsApp Business Cloud API: a permanent access token and the sending number's ID (Meta Business → WhatsApp → API setup) |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | For replies: the Meta app secret (checks incoming messages) and any phrase you choose. Webhook URL: `https://<site>/webhooks/whatsapp` |
| `PAYMOB_API_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_IFRAME_ID` | Paymob online payments for the tenant portal. Callback URL: `https://<site>/payments/paymob/callback` |
| `PAYMOB_INTEGRATION_CARD`, `PAYMOB_INTEGRATION_WALLET`, `PAYMOB_INTEGRATION_KIOSK` | Paymob integration IDs per method (leave out the ones you do not use) |
| `PAYMENTS_MODE` | `sandbox` for pretend payments while testing; no money moves. Remove it for real payments |
| `ETA_CLIENT_ID`, `ETA_CLIENT_SECRET`, `ETA_SIGNER_URL` | Egyptian Tax Authority e-invoicing: the ERP system's credentials and the address of your signing service (USB token or HSM). Pre-production or production is chosen in *Finance → E-invoicing* |
| `FOOTFALL_API_KEY`, `FOOTFALL_HMAC_SECRET` | For people counters sending hourly counts to `/ingest/footfall` (the secret is optional and also requires signed requests) |
| `PARKING_API_KEY`, `PARKING_HMAC_SECRET` | For the car park's equipment: plate cameras, ticket and card readers, pay machines and level sensors send their reads to `/ingest/parking` with the key (the secret is optional and also requires signed requests). Set-up and examples: *Parking → Set-up* |
| `ETA_RECEIPT_CLIENT_ID`, `ETA_RECEIPT_CLIENT_SECRET`, `ETA_RECEIPT_PRESHARED_KEY` | ETA e-receipts for parking payments: the credentials of the POS registered with the Egyptian Tax Authority (the pre-shared key only if the ETA issued one). The POS serial, item code and activity are set in *Parking → Cash → E-receipts*. Without them receipts are prepared and kept, ready to send |
| `PORTAL_DEMO_PASSWORD` | Optional fixed password for the sample tenant-portal accounts (otherwise random, shown on *Tenant portal*) |

Nothing above is needed to start: each integration shows *not connected* in **Integrations** until its keys are set, and the office works without them (offers go by email or a copied link, payments are recorded by hand, e-invoices wait to be submitted).

## Leasing office (`/admin`)

A sales ERP for the leasing team, built into the same app. It is private (`noindex`, blocked in `robots.txt`, every page behind a sign-in) and stores everything in one SQLite file.

**If `/admin` says the office is not available:** the website keeps running whatever happens to the office, and that page shows the exact reason (usually a `DATA_DIR` that does not exist or is not writable: use `~/wave-data`, or remove the variable to keep the data inside the app folder). Fix it in the hosting panel and redeploy.

**Owner account:** set `OWNER_EMAIL` and `OWNER_PASSWORD` in Hostinger (Websites → your site → Environment variables) and redeploy; the account is created on start-up and you can sign in at `/admin` right away. Change the password later under *Your account*.

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
| Conversations | Offers sent by email or WhatsApp with a signing link: the brand reads the proposal and signs on screen (drawn signature, name, time, IP and a fingerprint of the document); WhatsApp chats with brands and tenants, templates and scheduled reminders |
| Tenant portal (`/portal`) | Each tenant signs in to see their lease, invoices and payments, pay online (Paymob card, wallet or kiosk), download receipts, report sales, open maintenance requests and follow their fit-out |
| Fit-out | From handover to opening: design submissions and approvals, the fit-out deposit, works permits, inspections and snags, the opening date, and the deposit refund |
| Short-term space | Kiosks, carts, pop-ups, promotional and event bookings by day or week, with a calendar, availability check and billing |
| Maintenance | Requests from tenants and staff, priorities and response targets, assignment, planned maintenance and the asset register |
| Footfall | Daily and hourly visitors by entrance (typed in, imported or sent by counters), trends and conversion against tenant sales |
| Turnover & sales | Monthly sales reported by tenants, percentage rent above the base rent, audits and sales per m² |
| Service charge & utilities | Yearly service charge budget, apportionment by area, actual costs and the year-end reconciliation; electricity, water and chilled-water meters, readings and recharge invoices |
| Website | Brands directory and events for the public site (`/stores/`, `/events/`), edited here with images |
| Finance & accounting | Chart of accounts, journal with automatic entries from invoices, payments, payroll and expenses, suppliers and bills, banks and reconciliation, VAT, period closing, trial balance, profit and loss, balance sheet and cash flow; ETA e-invoicing |
| Parking | The live car park (free spaces per level, cars in, takings, the gates' feed, cars parked too long), the exit booth for cashiers on a tablet or phone (scan the ticket's QR code, tap an NFC card or type the plate; cash, card, wallet or InstaPay; lost tickets; letting a car out), tills that close into the books, every visit, subscriptions on plates or NFC cards (billed monthly, suspended when unpaid), shops validating their customers' parking from the tenant portal (whole visit or some hours free, billed to the shop when it pays), prices by the hour with a day rate, event prices, reports and the gates' API. Visitors see free spaces and prices, find their car and pay by phone at `/parking`; each ticket's QR code opens its own page. Also: a live floor map of B1 and B2 (bay sensors, or estimated from the level counts), valet (key tags, the customer asks for the car by link), booked spaces and subscriptions bought online (`/parking/book`, `/parking/subscribe`, the subscriber's own page), company accounts on one monthly invoice, fines carried to the car's next visit, incidents and lost property, the cash safe (drops, floats, bank collections into the books), alerts for unusual activity, a two-week forecast with cashier staffing, parking against tenants' sales, ETA e-receipts, and an edge agent that keeps the gates working offline (download it from *Parking → Set-up*) |
| Phone app | Install the office (and the tenant portal) on a phone from the browser: home-screen icon, full screen, bottom tab bar, works offline for pages already opened |

**Finance permission:** accounting, payroll costs and bank details are visible only to people with *Finance* ticked under Team (administrators always have it).

**English and Arabic:** every page, message, document and export works in both languages. Each person switches with the language button in the top bar (or on the sign-in page) and the office remembers their choice. Arabic pages are fully right to left, set in Almarai, with Arabic dates, months, money (ج.م) and plurals; digits stay Western, as on Egyptian leasing documents. Notes the system writes itself (timeline entries, the activity log, next steps, invoice notes) are stored once and shown in each reader's language, so an Arabic and an English colleague see the same records. Proposals and invoices print in either language from the switch on the document (`?doc=ar` / `?doc=en`). The Arabic text lives in `src/admin/i18n/`; `node scripts/i18n-audit.js` visits every page in Arabic and lists anything still in English (the test suite runs it too).

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
