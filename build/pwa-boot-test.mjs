// build/pwa-boot-test.mjs
//
// Integration test for the PWA's actual boot flow. jsdom doesn't run
// <script type=module>, so we set up the DOM manually then drive the
// modules ourselves — same logic, same DOM, no ES-module-script gap.

import 'fake-indexeddb/auto';
import jsdom from 'jsdom';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { JSDOM, VirtualConsole } = jsdom;

const PWA_DIR = path.resolve('dist/avscout-pwa');
const html = await fs.readFile(path.join(PWA_DIR, 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('error', (...a) => errors.push(a.join(' ')));
vc.on('warn',  (...a) => errors.push('[warn] ' + a.join(' ')));
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message || e)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',   // allow inline scripts (we don't load module ones)
  pretendToBeVisual: true,
  resources: 'usable',
  url: pathToFileURL(path.join(PWA_DIR, 'index.html')).href,
  virtualConsole: vc,
  beforeParse(win) {
    win.XLSX = { read: () => ({}), utils: {}, write: () => '' };
    win.JSZip = function () { return { file: () => {}, generateAsync: () => Promise.resolve(new Blob()) }; };
    win.crypto = globalThis.crypto;
    win.indexedDB = globalThis.indexedDB;
    win.IDBKeyRange = globalThis.IDBKeyRange;
    win.IDBOpenDBRequest = globalThis.IDBOpenDBRequest;
  },
});

await new Promise(r => setTimeout(r, 200));

// Establish the global DOM bindings the modules need (they import via
// path; we route them through Node's import resolution).
const win = dom.window;
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
// Skip navigator (Node 22 makes it a non-overridable getter). The
// surveying code only reads navigator.serviceWorker; we don't trip
// that path here.
globalThis.fetch = async (url) => {
  // Modules that fetch ('avscout/avscout.html' etc.) — serve from dist
  const rel = url.replace(/^[^?#]*\//, '');
  try {
    const text = await fs.readFile(path.join(PWA_DIR, url), 'utf8');
    return { ok: true, status: 200, text: async () => text };
  } catch {
    return { ok: false, status: 404, text: async () => 'Not found' };
  }
};
globalThis.alert = () => {};

// Now drive boot.js logic directly (its top-level await would not work
// in this synthetic environment, but we replicate it inline).
const storage = await import(pathToFileURL(path.join(PWA_DIR, 'storage.js')).href);
const { EQUIP_TYPES } = await import(pathToFileURL(path.join(PWA_DIR, 'equipment.js')).href);
const { initAVScout } = await import(pathToFileURL(path.join(PWA_DIR, 'avscout.js')).href);

let passes = 0, failures = 0;
function check(name, cond, info = '') {
  if (cond) { console.log(`✓ ${name}`); passes++; }
  else { console.log(`✗ ${name}${info ? ' — ' + info : ''}`); failures++; }
}

// 1. Cold start: no storeys at all → empty state should show
await storage.openDb();
let storeys = await storage.listStoreys();
check('cold start: no storeys', storeys.length === 0);

const equipShort = EQUIP_TYPES.map(t => ({
  v: t.value, l: t.label, e: t.emoji,
  x: t.excelMatch, p: !!t.preselected,
}));

try {
  initAVScout({
    equipTypes: equipShort,
    storage,
    initialStorey: null,
  });
  check('initAVScout(empty) ran without throwing', true);
} catch (e) {
  check('initAVScout(empty) ran without throwing', false, e.message);
  console.log('  stack:', e.stack.split('\n').slice(0,5).join('\n  '));
}

// Wait for rail render
await new Promise(r => setTimeout(r, 100));

const railTree = win.document.getElementById('rail-tree');
check('rail-tree exists in DOM', !!railTree);
check('rail-tree is empty when no floors (welcome screen speaks for itself)',
  railTree && railTree.children.length === 0,
  `children=${railTree?.children?.length}`);

const emptyState = win.document.getElementById('empty-state');
check('empty-state element exists', !!emptyState);
check('empty-state visible when no storey', emptyState && !emptyState.hidden,
  `hidden=${emptyState?.hidden}`);

const railEl = win.document.getElementById('floor-rail');
check('floor-rail element exists', !!railEl);

const toggleBtn = win.document.getElementById('fab-rail-toggle');
check('fab-rail-toggle button exists', !!toggleBtn);

// On cold start (no floors in DB), the rail starts collapsed so the
// welcome screen has the stage. Clicking the FAB toggles it open/closed.
if (toggleBtn) {
  // refreshRail is async; wait for it to settle before asserting initial state
  await new Promise(r => setTimeout(r, 50));
  check('rail starts collapsed on cold start (DB empty)',
    win.document.body.classList.contains('rail-collapsed'),
    `classList=${win.document.body.className}`);
  toggleBtn.click();
  check('clicking toggle opens the rail',
    !win.document.body.classList.contains('rail-collapsed'));
  toggleBtn.click();
  check('clicking toggle again collapses it',
    win.document.body.classList.contains('rail-collapsed'));
}

// On empty state we auto-open the right side panel
const sidePanel = win.document.getElementById('side-panel');
check('side-panel exists', !!sidePanel);
check('right panel auto-opens in empty state',
  sidePanel && sidePanel.classList.contains('open'),
  `classList=${sidePanel?.className}`);

// 2. Now simulate adding a storey via the storage layer (mimics what
//    the "Add SVG" button does, minus the page reload).
const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" id="svg-element">
  <g class="space_text abc"><text><tspan>17.00.00.020</tspan></text></g>
</svg>`;

const addResult = await storage.addStoreyFromSvg(SAMPLE_SVG, 'storey17.svg');
check('addStoreyFromSvg succeeded', addResult.status === 'created');
// Room code 17.00.00.020 = building 17, wing 00, floor 00, room 020.
// Storey identity is building.floor = "17.00", building is "17".
check('storey id derived correctly', addResult.record.storey === '17.00',
  `got "${addResult.record.storey}"`);
check('building derived correctly', addResult.record.building === '17',
  `got "${addResult.record.building}"`);

// 3. listBuildings shows it
const buildings = await storage.listBuildings();
check('listBuildings reports 1 building', buildings.length === 1);
check('building has 1 storey', buildings[0] && buildings[0].storeys.length === 1);

// Filter out errors that are expected in jsdom (no CDN fetch)
const realErrors = errors.filter(e =>
  !/Could not load (link|script): "https?:\/\//.test(e)
);
if (realErrors.length) {
  console.log('');
  console.log('⚠ Console errors during init:');
  realErrors.slice(0, 5).forEach(e => console.log('  -', String(e).slice(0, 250)));
}

console.log('');
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures > 0 || realErrors.length > 0 ? 1 : 0);
