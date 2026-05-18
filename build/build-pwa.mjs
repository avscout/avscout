// build/build-pwa.mjs
//
// Composes the AVScout PWA into dist/avscout-pwa/.
//
// Phase 3 layout: there is no "PWA shell". The PWA is the surveying app.
// We copy shared/avscout/ verbatim, then embed the body markup from
// avscout.html into index.html (between the AVSCOUT_BODY_BEGIN /
// AVSCOUT_BODY_END markers). The resulting dist/avscout-pwa/index.html
// is a single self-contained HTML page that loads avscout.css + boot.js.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'shared', 'avscout');
const OUT = path.join(ROOT, 'dist', 'avscout-pwa');

async function rmrf(p) { await fs.rm(p, { recursive: true, force: true }); }

async function copyDir(src, dst, { skip } = {}) {
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    if (skip && skip(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(s, d, { skip });
    else if (ent.isFile()) await fs.copyFile(s, d);
  }
}

// PIN_SVG_BTN appears 4× in the body markup. Resolve at build time.
const PIN_SVG_HTML =
  '<svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" ' +
  'style="flex-shrink:0"><path d="M5 0C2.24 0 0 2.24 0 5c0 3.75 5 8 5 8s5-' +
  '4.25 5-8C10 2.24 7.76 0 5 0zm0 7A2 2 0 1 1 5 3a2 2 0 0 1 0 4z"/></svg>';

await rmrf(OUT);
await copyDir(SRC, OUT, {
  skip: n => n === 'README.md'
            // avscout.html is inlined into index.html; don't ship separately
            || n === 'avscout.html'
            // index.html is generated below
            || n === 'index.html',
});

const indexTpl = await fs.readFile(path.join(SRC, 'index.html'), 'utf8');
const body     = await fs.readFile(path.join(SRC, 'avscout.html'), 'utf8');

// Substitute build-time placeholders in the body markup.
let resolvedBody = body
  .replace(/\{\{PIN_SVG_BTN\}\}/g, PIN_SVG_HTML)
  // TITLE: empty span that JS can fill at storey-mount time
  .replace(/\{\{TITLE\}\}/g, '<span id="tpl-title"></span>')
  // EQUIP_OPTIONS: empty — avscout.js populates the dropdown
  .replace(/\{\{EQUIP_OPTIONS\}\}/g, '');

const BEGIN_MARK = '<!-- AVSCOUT_BODY_BEGIN -->';
const END_MARK   = '<!-- AVSCOUT_BODY_END -->';
if (!indexTpl.includes(BEGIN_MARK) || !indexTpl.includes(END_MARK)) {
  throw new Error('index.html missing AVSCOUT_BODY_BEGIN / AVSCOUT_BODY_END markers');
}
const finalHtml = indexTpl.replace(
  new RegExp(BEGIN_MARK + '[\\s\\S]*?' + END_MARK),
  BEGIN_MARK + '\n' + resolvedBody + '\n' + END_MARK
);
await fs.writeFile(path.join(OUT, 'index.html'), finalHtml);

console.log(`✓ Built avscout-pwa → dist/avscout-pwa/ (${finalHtml.length.toLocaleString()} bytes index.html)`);
