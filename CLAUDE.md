# Herrin Choker Racing — Project Context

Team site for HRL hydroplane boat **#38**, driver **Adam Carruthers**.  
Live at **herrinchoker.ca** (Cloudflare Workers, custom domain).  
GitHub repo: HerrinChokerRacing (just created, pointed at this folder).

---

## Design system

```css
--maroon: #8b1a1a        /* primary brand */
--maroon-dark: #3d0808   /* hero bg */
--gold: #c8a040          /* accents, badges */
--white: #f5f0eb         /* body text */
--muted: #8a7a7a         /* secondary text */
--border: rgba(139,26,26,0.3)
background: #100202
```

Fonts: **Barlow Condensed** (headings, nav, numbers) + **Barlow** (body) — loaded from Google Fonts.

---

## File structure

```
index.html          single-page site
css/style.css       all styles
js/main.js          hamburger menu · race badge auto-compute · Google Sheets fetch
images/             folder exists; photo1.jpg + photo2.jpg still at root (manual move pending)
photo1.jpg
photo2.jpg
.gitignore
```

Photos are referenced at root level in HTML/CSS for now. Once moved to `images/`, update:
- `index.html`: `src="photo1.jpg"` → `src="images/photo1.jpg"` (×2)
- `css/style.css`: `url('../photo2.jpg')` → `url('../images/photo2.jpg')`
- hero bg in CSS: same change

---

## What's built

- Sticky nav with hamburger menu (wired up, animates to ✕)
- Hero: large #38, team name, pills, photo2.jpg side panel
- Race schedule — 6 races, 2026 season; badges **auto-compute from dates** (`data-start`/`data-end` on each row) — no manual updates needed as season progresses
- Race Weekend section — hidden until Google Sheet is populated (see js/main.js)
- Photo gallery — 2 photos + 1 placeholder slot
- Videos — 2 YouTube embeds (generic HRL highlights; swap in #38-specific videos when found)
- Driver card — Adam Carruthers, "AC" avatar placeholder (no headshot yet)
- Social — Facebook linked; Instagram placeholder (`https://instagram.com/YOURHANDLE`)
- Footer

---

## What's not done yet

- **Instagram handle** — update `href` in the `.social-card.ig` anchor in `index.html`
- **Google Sheet ID** — paste into `const SHEET_ID = ''` in `js/main.js`; sheet setup instructions are in that file's comments
- **Driver headshot** — replace the "AC" avatar div with an `<img>` when a photo is available
- **GitHub → Cloudflare Pages auto-deploy** — repo exists, connect it in Cloudflare dashboard (Workers & Pages → Create → Pages → Connect Git)
- **More photos** — gallery has one empty placeholder slot
- **Race results section** — not built; needed once season starts
- **Sponsor section** — not built; add if sponsors to showcase
- **YouTube videos** — swap in #38-specific videos when identified
- **`git init`** — needs to be run in this folder, then push to HerrinChokerRacing on GitHub

---

## Deployment

Cloudflare Workers (not Pages — landed there during setup). To switch to auto-deploy:
1. Connect GitHub repo → Cloudflare Pages project
2. Push to `main` → auto-deploys

## Race Weekend Google Sheet format

One tab named **"Weekend"**, columns:

| A: type | B: label | C: time | D: result |
|---------|----------|---------|-----------|
| event | Sorel-Tracy Grand Prix | June 6–7 | |
| heat | Heat 1 — F2500 | Sat 9:30 AM | 2nd |
| heat | Heat 2 — F2500 | Sun 10:15 AM | Pending |

When the tab is empty (header row only), the Race Weekend section stays hidden.  
Results auto-refresh every 2 minutes.
