// build/build-harness.mjs
//
// Phase 1 test harness builder.
//
// Produces a single, self-contained HTML file at:
//   dist/avscout-harness/index.html
//
// That file can be opened by double-clicking (file://) — no server,
// no service worker, no IndexedDB. It uses a file picker for the SVG
// and localStorage for state (which works fine on file:// in all
// modern desktop browsers).
//
// This is NOT the final PWA. It is a sanity check that the extracted
// shared/avscout/* files are functionally equivalent to what was
// embedded in popup.js. Once verified, Phase 2 replaces this with a
// real PWA shell (HTTPS, service worker, IndexedDB).

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHARED = path.join(ROOT, 'shared', 'avscout');
const OUT_DIR = path.join(ROOT, 'dist', 'avscout-harness');

// ── Read shared/avscout files ──────────────────────────────────────────────

const css      = await fs.readFile(path.join(SHARED, 'avscout.css'),    'utf8');
const bodyHtml = await fs.readFile(path.join(SHARED, 'avscout.html'),   'utf8');
const appJs    = await fs.readFile(path.join(SHARED, 'avscout.js'),     'utf8');
const equipJs  = await fs.readFile(path.join(SHARED, 'equipment.js'),   'utf8');

// ── Resolve HTML placeholders ──────────────────────────────────────────────
//
// The body template has 3 placeholders set at floor-load time:
//   {{TITLE}}         floor title — shown in the toolbar
//   {{EQUIP_OPTIONS}} <option> list for the marker editor's equip select
//   {{PIN_SVG_BTN}}   small pin SVG icon, appears 4× in modal buttons
//
// In the previous architecture these were string-substituted at HTML-bake
// time inside buildInteractiveHtml(). For the harness (and later the PWA),
// they're substituted at floor-load time by JS — we set up the document
// with the placeholders intact, then JS replaces them once the SVG is
// loaded and equipTypes is known.
//
// To make that work we keep the placeholders in the document but use
// data-tpl-* attributes so JS can find them deterministically.

// Convert {{X}} markers into <span data-tpl="X"></span> so they survive
// the initial DOM parse and JS can fill them in later.
const PIN_SVG_HTML = '<svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" style="flex-shrink:0"><path d="M5 0C2.24 0 0 2.24 0 5c0 3.75 5 8 5 8s5-4.25 5-8C10 2.24 7.76 0 5 0zm0 7A2 2 0 1 1 5 3a2 2 0 0 1 0 4z"/></svg>';

// For the harness, we know we can resolve PIN_SVG_BTN at build time
// (it's static). TITLE and EQUIP_OPTIONS are floor-specific so they
// stay as JS-replaced spans.
let resolvedBody = bodyHtml
  .replace(/\{\{PIN_SVG_BTN\}\}/g, PIN_SVG_HTML)
  .replace(/\{\{TITLE\}\}/g, '<span id="tpl-title"></span>')
  .replace(/\{\{EQUIP_OPTIONS\}\}/g, '');  // populated by JS

// ── Strip ES module syntax from app/equipment JS ───────────────────────────
//
// Because the harness must run from file://, we can't use ES module imports.
// We concatenate the modules in dependency order with module syntax stripped:
//   - equipment.js exports `EQUIP_TYPES` etc. → become plain globals
//   - avscout.js exports `initAVScout` → becomes a plain global function

function stripModuleSyntax(src) {
  return src
    // Drop "export { ... };" trailing lines
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    // "export function foo" → "function foo"
    .replace(/^export\s+function\s+/gm, 'function ')
    // "export const foo" → "const foo"
    .replace(/^export\s+const\s+/gm, 'const ')
    // "import ... from '...';" → drop entirely (we have no imports yet but
    // future-proofing)
    .replace(/^import\s+.+?;\s*$/gm, '');
}

const equipStripped = stripModuleSyntax(equipJs);
const appStripped   = stripModuleSyntax(appJs);

// ── Compose the harness HTML ───────────────────────────────────────────────

const HARNESS_CSS = `
/* Harness-only chrome (file picker bar). Hidden once a floor is loaded. */
#harness-bar {
  position: fixed; inset: 0 0 auto 0; z-index: 100000;
  background: #16181c; color: #f0f0ef;
  font-family: 'Syne', sans-serif;
  padding: 12px 16px; display: flex; gap: 12px; align-items: center;
  border-bottom: 1px solid #2a2d35;
}
#harness-bar h1 {
  font-size: 16px; font-weight: 700; margin: 0;
  color: #e8ff47;
}
#harness-bar .hint {
  font-size: 12px; color: #6b7280; margin-left: auto;
}
body.harness-loading { padding-top: 60px; }
body.harness-loaded #harness-bar { display: none; }
body.harness-loaded { padding-top: 0; }
`;

const harnessHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>AVScout (harness)</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet"/>
<style>${HARNESS_CSS}</style>
<style>${css}</style>
</head>
<body class="harness-loading">

<!-- Harness chrome: file picker (replaced by Phase 2 PWA shell) -->
<div id="harness-bar">
  <h1>AVScout · test harness</h1>
  <label class="tb-btn" style="cursor:pointer;">
    Pick floorplan SVG…
    <input id="harness-file" type="file" accept=".svg,image/svg+xml" style="display:none"/>
  </label>
  <span class="hint">Load a Stipl-style SVG to start a survey.</span>
</div>

<!-- AVScout body (from shared/avscout/avscout.html) -->
${resolvedBody}

<!-- SheetJS for Excel parsing -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<!-- JSZip for Bulk Snip zip export -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>

<script>
/* global XLSX, JSZip */
'use strict';

// ── equipment.js (module-stripped) ─────────────────────────────────────────
${equipStripped}

// ── avscout.js (module-stripped) ───────────────────────────────────────────
${appStripped}

// ── Harness bootstrap ──────────────────────────────────────────────────────

(function bootstrap(){
  const fileInput = document.getElementById('harness-file');

  function deriveStorey(svgText) {
    // Look for a g.space_text containing a tspan whose text is a room code
    // like "17.00.00.020", and take the first three segments as the storey
    // (matches the existing convention used in floorPrefix()).
    const m = svgText.match(/<tspan[^>]*>(\\d{2}\\.\\d{2}\\.\\d{2})\\./);
    return m ? m[1] : '';
  }

  function loadSvg(text, filename) {
    const safeStorey = deriveStorey(text);
    const title = filename.replace(/\\.svg$/i, '') || 'Floor';

    // Fill the {{TITLE}} placeholder span before initAVScout reads anything.
    const titleSpan = document.getElementById('tpl-title');
    if (titleSpan) titleSpan.textContent = title;

    // Build EQUIP_OPTIONS for the modal's <select id="modalEquip">
    const sel = document.getElementById('modalEquip');
    if (sel && !sel.options.length) {
      for (const t of EQUIP_TYPES) {
        const opt = document.createElement('option');
        opt.value = t.value;
        opt.textContent = t.emoji + ' ' + t.label;
        sel.appendChild(opt);
      }
    }

    // Hand the data to initAVScout. The script expects:
    //   equipTypes:    short-form array
    //   storage:       module (minimal stub here — harness uses localStorage)
    //   initialStorey: { storey, title, svgRaw }
    const equipShort = EQUIP_TYPES.map(t => ({
      v: t.value, l: t.label, e: t.emoji,
      x: t.excelMatch, p: !!t.preselected
    }));

    // Minimal storage stub. The harness doesn't persist across loads,
    // doesn't have buildings/rail, and just exists so initAVScout's
    // rail-setup section doesn't crash on a missing API.
    const storageStub = {
      listBuildings: async () => [],
      listStoreys: async () => [],
      getStorey: async () => null,
      touchStorey: async () => null,
      addStoreyFromSvg: async () => { throw new Error('Not supported in harness'); },
      attachSvg: async () => { throw new Error('Not supported in harness'); },
      detachSvg: async () => { throw new Error('Not supported in harness'); },
      deleteStorey: async () => { throw new Error('Not supported in harness'); },
      exportPackage: async () => { throw new Error('Not supported in harness'); },
      importPackage: async () => { throw new Error('Not supported in harness'); },
      createStoreyIfMissing: async () => ({ status: 'exists' }),
      setSurveyItem: async () => {},
      getSurveyItem: async () => null,
      getSurveyAll:  async () => ({}),
      SurveyKV: {
        bindStorey: async () => {},
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        drain: async () => {},
        unbind: () => {},
      },
    };

    document.body.classList.remove('harness-loading');
    document.body.classList.add('harness-loaded');

    try {
      initAVScout({
        equipTypes: equipShort,
        storage: storageStub,
        initialStorey: {
          storey: safeStorey,
          title: title,
          svgRaw: text,
        },
      });
    } catch (e) {
      console.error('[harness] initAVScout threw:', e);
      alert('AVScout failed to initialize: ' + e.message + '\\n\\nSee console for details.');
    }
  }

  fileInput.addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const text = await f.text();
    loadSvg(text, f.name);
  });

  console.log('[harness] Ready. Pick an SVG file to begin.');
})();
</script>
</body>
</html>
`;

// ── Write output ───────────────────────────────────────────────────────────

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, 'index.html'), harnessHtml);

console.log(`✓ Wrote ${path.relative(ROOT, path.join(OUT_DIR, 'index.html'))} (${harnessHtml.length.toLocaleString()} bytes)`);
console.log('');
console.log('Open this file in a browser (double-click works) and pick an SVG.');
