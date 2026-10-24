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

| English        | Arabic             | What                                                         |
| -------------- | ------------------ | ------------------------------------------------------------ |
| `/`            | `/ar/`             | Home: hero, manifesto, architecture panorama, four waves, the mark, location, leasing |
| `/the-wave/`   | `/ar/the-wave/`    | Story, gallery, the mark (tap to cycle colourways), palette, pattern |
| `/experience/` | `/ar/experience/`  | Four waves, a day at The Wave (day to night), categories     |
| `/location/`   | `/ar/location/`    | Satellite map with landmarks, stats, directions              |
| `/leasing/`    | `/ar/leasing/`     | Why, spaces, enquiry form                                    |

Also `/sitemap.xml`, `/robots.txt`, `/healthz`, `POST /api/enquiry`.

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

- Copy: `src/content.js` (English and Arabic side by side; Arabic is a draft for native review).
- Pages and sections: `src/pages.js`; shell, head, header, footer: `src/render.js`.
- Styles: `public/css/site.css`. Motion and navigation: `public/js/site.js`.
- Logo: `src/logo-paths.json` (vector paths pulled from the identity PDF), rendered inline so every letter can animate.
- Images: sources in `assets-src/` (client renders with the placeholder signage removed) and `../wave-posts/visuals/`; rebuild the responsive set with `python3 scripts/optimize-images.py`.

## Brand

Forest `#283833`, cocoa `#7c4d28`, sea glass `#a2c5b9`, sand `#d1c9b3`. Acumin Variable is Adobe-licensed, so the site uses Inter Display; Vladimir Script is replaced by Pinyon Script. Swap the `@font-face` rules in `site.css` if the licensed fonts become available.
