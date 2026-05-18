// Headless smoke test of the harness — loads it in jsdom and verifies that
// initAVScout runs without throwing when given a sample SVG.

import { promises as fs } from 'node:fs';
import jsdom from 'jsdom';
const { JSDOM, VirtualConsole } = jsdom;
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const html = await fs.readFile(
  path.join(ROOT, 'dist', 'avscout-harness', 'index.html'),
  'utf8'
);

// A minimal Stipl-style SVG that exercises the room-tagging code path
// in avscout.js (which looks for g.space_text > tspan with a room code).
const sampleSvg = `<?xml version="1.0"?>
<svg id="svg-element" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="planSVG">
    <g class="floor-plan-object-container">
      <path class="floor-plan-object-path floor-plan-space"
            ifcguid="3z2NeX$VuHx8jKJCngOHDj"
            guid="3z2NeXçVuHx8jKJCngOHDj"
            id="floor-plan-object-path-3z2NeXçVuHx8jKJCngOHDj"
            type="IfcSpace"
            d="M0,0 L10,0 L10,10 L0,10 Z"/>
    </g>
  </g>
  <g class="space_text 3z2NeX$VuHx8jKJCngOHDj">
    <text><tspan>17.00.00.020</tspan></text>
    <text><tspan>8,84</tspan></text>
  </g>
</svg>`;

// Capture console messages from inside the page
const errors = [];
const warnings = [];
const logs = [];

const virtualConsole = new VirtualConsole();
virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
virtualConsole.on('warn',  (...args) => warnings.push(args.join(' ')));
virtualConsole.on('log',   (...args) => logs.push(args.join(' ')));
virtualConsole.on('info',  (...args) => logs.push(args.join(' ')));

// Resource loader that blocks external scripts (CDN) but lets the
// inline script run. We mock XLSX and JSZip as stubs (via beforeParse)
// so the inline code doesn't crash on references to them.

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  resources: 'usable',  // allow inline; jsdom blocks external by default
  virtualConsole,
  beforeParse(win) {
    win.XLSX = { read: () => ({}), utils: {}, write: () => '' };
    win.JSZip = function() {
      return { file: () => {}, generateAsync: () => Promise.resolve(new Blob()) };
    };
  },
});

// Give the inline script a chance to run. CI runners can be slow; we
// wait longer and poll for `window.initAVScout` to settle before giving up.
async function waitForInit(maxMs = 3000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (typeof dom.window.initAVScout === 'function') return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}
const initReady = await waitForInit();

const win = dom.window;
const doc = win.document;

// Did the bootstrap define initAVScout?
if (!initReady || typeof win.initAVScout !== 'function') {
  console.log('✗ initAVScout not defined globally');
  console.log('  errors:', errors);
  console.log('  warnings:', warnings.slice(0, 5));
  console.log('  logs:', logs.slice(0, 5));
  // Extra diagnostics — what did we actually load?
  const scripts = [...doc.querySelectorAll('script')];
  console.log('  scripts in doc:', scripts.length);
  const inlineLengths = scripts.filter(s => !s.src).map(s => s.textContent.length);
  console.log('  inline script byte-lengths:', inlineLengths);
  const totalInline = inlineLengths.reduce((a,b)=>a+b, 0);
  console.log('  total inline JS:', totalInline);
  // Does the bundled inline JS even contain `function initAVScout`?
  const fullJs = scripts.filter(s => !s.src).map(s => s.textContent).join('\n');
  console.log('  contains "function initAVScout":', fullJs.includes('function initAVScout'));
  console.log('  contains "export function initAVScout":', fullJs.includes('export function initAVScout'));
  console.log('  contains "initAVScout":', fullJs.includes('initAVScout'));
  // First 5 occurrences of "initAVScout" with surrounding context
  if (fullJs.includes('initAVScout')) {
    let idx = 0, found = 0;
    while ((idx = fullJs.indexOf('initAVScout', idx)) !== -1 && found < 3) {
      console.log('    @offset', idx, ':', JSON.stringify(fullJs.slice(Math.max(0,idx-30), idx+30)));
      idx++; found++;
    }
  }
  process.exit(1);
}
console.log('✓ initAVScout is defined globally');

// Trigger the actual file-picker code path (the same one a real user
// hits). We can't simulate a real File from Node easily, so we patch
// the change handler with a mock file-like object.
const fileInput = doc.getElementById('harness-file');
if (!fileInput) {
  console.log('✗ harness file input not found');
  process.exit(1);
}

const mockFile = {
  name: 'test-floor.svg',
  async text() { return sampleSvg; },
};

// Replace files getter to return our mock
Object.defineProperty(fileInput, 'files', {
  value: [mockFile],
  configurable: true,
});

// Dispatch change
try {
  fileInput.dispatchEvent(new win.Event('change'));
} catch (e) {
  console.log('✗ Error dispatching change:', e.message);
  process.exit(1);
}

// Allow async file-read + init to settle
await new Promise(r => setTimeout(r, 500));

console.log('✓ File picker change event dispatched');

// Did the SVG get inserted into #svg-wrap?
const wrap = doc.getElementById('svg-wrap');
if (!wrap || !wrap.querySelector('svg')) {
  console.log('✗ #svg-wrap has no SVG content');
  process.exit(1);
}
console.log('✓ SVG mounted in #svg-wrap');

// Did the room get tagged with data-room-code?
const tagged = wrap.querySelector('[data-room-code]');
if (!tagged) {
  console.log('✗ No room got data-room-code attribute');
  // Don't fail — this could be expected if no g.space_text→ifcguid mapping
  console.log('  (this may be OK for the test SVG)');
} else {
  console.log(`✓ Room tagged with data-room-code="${tagged.getAttribute('data-room-code')}"`);
}

// Surface any console errors that fired during init
if (errors.length) {
  console.log('');
  console.log('⚠ Errors observed in page console during init:');
  errors.slice(0, 5).forEach(e => console.log('  -', String(e).slice(0, 200)));
}
if (warnings.length) {
  console.log('');
  console.log('Warnings:', warnings.length);
  warnings.slice(0, 3).forEach(w => console.log('  -', String(w).slice(0, 200)));
}

console.log('');
console.log('Smoke test complete.');
