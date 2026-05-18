# AVScout workspace

Two apps:

- **Floorplan** — Chrome MV3 extension. Captures Stipl SVG floorplans.
  → [`floorplan-ext/`](./floorplan-ext/)

- **AVScout** — installable PWA for AV equipment surveying. **The PWA
  *is* the surveying app** — no shell layer, no wrapper. Visit the URL,
  see AVScout. Install to home screen. Add storeys, switch between them
  via the left rail.
  → [`shared/avscout/`](./shared/avscout/)

## Phase 3 status (this revision)

After a wrong turn in the previous Phase 3 (a separate PWA shell
wrapping the surveying app — two UIs nested awkwardly), this revision
**merges everything into the surveying app**:

- **Left rail** (collapsible): buildings → storeys, with `+ Add SVG`,
  `Import…`, and a per-storey `⋯` menu (Rename · Export · Replace ·
  Detach · Delete). Lives inside `avscout.html` / `.css` / `.js`,
  alongside the existing right-side imports panel.
- **Empty state**: when no storey has an SVG, the canvas area shows a
  "Load SVG" prompt instead.
- **Storey switching**: per-storey state in IndexedDB (via
  `storage.js`'s `SurveyKV`). Switching storeys reloads the page;
  state is preserved because each storey's data is stored under its
  own composite key.
- **PWA**: installable on iOS/Android/desktop. Service worker caches
  the app shell + CDN deps for offline use.

The architecture is now: one HTML page (`index.html`) loads one CSS
file (`avscout.css`) and one bootstrap module (`boot.js`) which itself
imports `avscout.js`. No second "PWA shell" exists.

---

## Workflow (no local Node needed)

GitHub Actions builds + tests + deploys to GitHub Pages on every push.

### One-time

1. `git init && git add . && git commit -m "Initial"`
2. Create empty repo at [github.com/new](https://github.com/new) (no
   README, no .gitignore — your folder has them)
3. `git remote add origin https://github.com/YOURNAME/avscout.git && git branch -M main && git push -u origin main`
4. **Make the repo public** (Settings → General → Danger Zone) **OR**
   upgrade to GitHub Pro, otherwise Pages won't work
5. Repo → Settings → Pages → Source → **GitHub Actions**

### Daily

1. Edit files in VS Code
2. Commit + push from the Source Control panel
3. Wait ~45s → visit `https://YOURNAME.github.io/REPONAME/`

### Install as a PWA

Visit the URL, then:
- **iOS Safari**: Share → "Add to Home Screen"
- **Android Chrome**: menu → "Install app"
- **Desktop Chrome/Edge**: install icon in URL bar

## Layout

```
.
├── floorplan-ext/             ← Chrome extension (unchanged in Phase 3)
├── shared/avscout/            ← THE PWA — surveying app + storage + assets
│   ├── index.html             ← PWA page (build script embeds avscout.html)
│   ├── avscout.html           ← body markup (toolbar, rail, modals, canvas)
│   ├── avscout.css            ← styles
│   ├── avscout.js             ← surveying logic + floor-rail at the end
│   ├── boot.js                ← bootstrap (DB, SurveyKV, initAVScout)
│   ├── equipment.js           ← equipment types
│   ├── storage.js             ← IndexedDB layer (storeys, SurveyKV facade)
│   ├── manifest.webmanifest   ← PWA install metadata
│   ├── sw.js                  ← service worker (offline cache)
│   └── icons/                 ← PWA icons
├── build/                     ← build scripts + tests
│   ├── build.mjs              ← orchestrator
│   ├── build-pwa.mjs          ← composes dist/avscout-pwa/index.html
│   ├── build-harness.mjs      ← legacy harness (Phase 1, still works)
│   ├── extract-phase1.mjs     ← one-shot migration (do not re-run)
│   ├── headless-smoke.mjs     ← jsdom-based harness smoke test
│   ├── storage-test.mjs       ← 13 IndexedDB tests
│   ├── pwa-check.mjs          ← module import/export cross-check
│   └── pwa-boot-test.mjs      ← jsdom integration: empty state, addStorey
├── .github/workflows/         ← CI + Pages deploy
└── dist/                      ← build output (gitignored)
```

## Roadmap

- **Phase 0–2** ✅ Folder layout, build pipeline, dev-renamed extension,
  Phase-1 module extraction, Phase-2 storage + PWA shell (later torn out).
- **Phase 3** ✅ Surveying app extended with floor rail, empty state,
  storage. PWA *is* the surveying app — no shell.
- **Phase 4** ⏭ Slim `floorplan-ext/popup.js` — drop the giant template
  strings (now in `shared/`). Add "Export SVG" + "Open in AVScout"
  buttons to the extension.
- **Phase 5** ⏭ Polish + docs.

## Optional: local builds

If you install Node (LTS from [nodejs.org](https://nodejs.org/)):

```bash
npm install
npm run build         # all targets → dist/
npm run smoke         # extracted-app smoke test (jsdom)
npm run storage-test  # IndexedDB layer
npm run pwa-check     # static module-resolution check
npm run pwa-boot      # jsdom PWA boot integration test
npm run watch         # rebuild on save
```

Local serve (PWA needs HTTP for service worker, http://localhost is fine):

```bash
npx serve dist/avscout-pwa   # → http://localhost:3000
```
