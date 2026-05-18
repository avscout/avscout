// build/extract-phase1.mjs
//
// One-shot extraction script: reads floorplan-ext/popup.js and writes
//   shared/avscout/avscout.css
//   shared/avscout/avscout.html
//   shared/avscout/avscout.js
//   shared/avscout/equipment.js
//
// Run once to produce shared/. After that, edit shared/ directly.
// This script lives in build/ but is NOT part of the regular `npm run build`
// pipeline — it's a migration helper. After Phase 1 is done it can be
// deleted or kept around for reference.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC_POPUP = path.join(ROOT, 'floorplan-ext', 'popup.js');
const OUT_DIR = path.join(ROOT, 'shared', 'avscout');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a substring bounded by two anchors. Asserts uniqueness.
 */
function between(text, startMarker, endMarker, { include = false } = {}) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Start marker not found: ${startMarker.slice(0, 60)}…`);
  if (text.indexOf(startMarker, start + 1) >= 0) {
    throw new Error(`Start marker not unique: ${startMarker.slice(0, 60)}…`);
  }
  const from = include ? start : start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  if (end < 0) throw new Error(`End marker not found: ${endMarker.slice(0, 60)}…`);
  return text.slice(from, end);
}

/**
 * Reverse the template-literal escaping done when the source was authored.
 * Inside JS template literals, you must double-escape backslashes (so a
 * regex \\s becomes \\\\s in the source) and escape backticks and ${.
 */
function unescapeTemplateLiteral(s) {
  // Order matters: do backslash-doubling LAST otherwise we'd un-escape
  // the escaped escapes.
  return s
    .replace(/\\`/g, '`')          // \` → `
    .replace(/\\\$/g, '$')         // \$ → $
    .replace(/\\\\/g, '\\');       // \\ → \
}

// ── Read source ─────────────────────────────────────────────────────────────

const popupJs = await fs.readFile(SRC_POPUP, 'utf8');

// ── Extract INTERACTIVE_CSS ─────────────────────────────────────────────────

const cssBody = between(
  popupJs,
  'const INTERACTIVE_CSS = `\n',
  '`;\n\nconst INTERACTIVE_SCRIPT_TEMPLATE',
);
const css = unescapeTemplateLiteral(cssBody);

// ── Extract INTERACTIVE_SCRIPT_TEMPLATE ─────────────────────────────────────

const scriptBody = between(
  popupJs,
  'const INTERACTIVE_SCRIPT_TEMPLATE = `',
  '`;\n\n// 21 equipment types',
);
const scriptRaw = unescapeTemplateLiteral(scriptBody);

// Strip the outer IIFE wrapper. The template starts with
//   (function(){
//   'use strict';
// and ends with
//   })();
// We replace the IIFE with a named function `initAVScout(config)` that
// the PWA bootstrapper will call. Config supplies the four values that
// were previously placeholder-substituted.

const IIFE_OPEN = "(function(){\n'use strict';\n";
const IIFE_CLOSE = "})();";

if (!scriptRaw.startsWith(IIFE_OPEN)) {
  throw new Error(`Script does not start with expected IIFE open. First 80 chars:\n${scriptRaw.slice(0, 80)}`);
}
if (!scriptRaw.endsWith(IIFE_CLOSE)) {
  throw new Error(`Script does not end with IIFE close. Last 80 chars:\n${scriptRaw.slice(-80)}`);
}

const innerScript = scriptRaw.slice(IIFE_OPEN.length, -IIFE_CLOSE.length);

// Replace the 4 placeholders with config-driven values.
//   const EQUIP = __EQUIP_JSON__;           → const EQUIP = __config.equipTypes;
//   const SVG_RAW = __SVG_RAW_LITERAL__;    → const SVG_RAW = __config.svgRaw;
//   "__SAFE_STOREY__"                       → __config.safeStorey  (string ctx)
//   '__TITLE__'                             → (kept as runtime ref)
//
// The placeholders appear in different syntactic contexts. Mapping each:
//
//   line 1729: `const EQUIP = __EQUIP_JSON__;`
//              → `const EQUIP = __config.equipTypes;`
//
//   line 1774: `const SVG_RAW = __SVG_RAW_LITERAL__;`
//              → `const SVG_RAW = __config.svgRaw;`
//              (Previously this was substituted as `\`<escaped-svg>\``,
//               i.e. a literal template-string expression. Now we just
//               pass the raw SVG string at runtime — no escaping needed.)
//
//   3 occurrences of `"__SAFE_STOREY__"` (in string context)
//              → `__config.safeStorey`
//              (The previous code substituted into the middle of a string
//               literal; we replace the entire `"..."` with a JS expression.)
//
//   1 occurrence of `'__TITLE__'` (in string context)
//              → `__config.title`

let transformed = innerScript;

// EQUIP
transformed = transformed.replace(
  /const EQUIP = __EQUIP_JSON__;/,
  'const EQUIP = __config.equipTypes;'
);

// SVG_RAW
transformed = transformed.replace(
  /const SVG_RAW = __SVG_RAW_LITERAL__;/,
  'const SVG_RAW = __config.svgRaw;'
);

// SAFE_STOREY — 3 occurrences, each wrapped in double quotes
const safeStoreyBefore = (transformed.match(/"__SAFE_STOREY__"/g) || []).length;
transformed = transformed.replace(/"__SAFE_STOREY__"/g, '__config.safeStorey');

// TITLE — 1 occurrence, wrapped in single quotes
const titleBefore = (transformed.match(/'__TITLE__'/g) || []).length;
transformed = transformed.replace(/'__TITLE__'/g, '__config.title');

// Sanity checks: any leftover placeholders → fail loudly
const leftover = transformed.match(/__(EQUIP_JSON|SVG_RAW_LITERAL|SAFE_STOREY|TITLE)__/g);
if (leftover) {
  throw new Error(
    `Unexpected leftover placeholders: ${[...new Set(leftover)].join(', ')}.\n` +
    `safeStorey replaced: ${safeStoreyBefore}, title replaced: ${titleBefore}`
  );
}

console.log(`  - EQUIP, SVG_RAW: replaced`);
console.log(`  - SAFE_STOREY: ${safeStoreyBefore} replacements`);
console.log(`  - TITLE: ${titleBefore} replacements`);

const finalScript =
`// shared/avscout/avscout.js
//
// The AVScout surveying application. Loaded by the PWA (and by the dev
// build of Floorplan-extension's "Open captured plan" feature) into an
// HTML shell that provides #svg-wrap and the rest of the UI markup.
//
// Call initAVScout({ equipTypes, svgRaw, safeStorey, title }) once after
// the DOM is ready and the floorplan SVG / metadata are known.
//
// Extracted from the previous INTERACTIVE_SCRIPT_TEMPLATE in
// floorplan-ext/popup.js by build/extract-phase1.mjs. Source-of-truth
// edits happen HERE going forward.

/* global XLSX, JSZip */

export function initAVScout(__config) {
'use strict';
${transformed}
}
`;

// ── Extract the HTML body inside buildInteractiveHtml ──────────────────────

// The template literal in buildInteractiveHtml returns:
//   <!DOCTYPE html>...<body>
//     <toolbar/panels/modals/etc>
//     <script>...${scriptText}...</script>
//     <script src=cdn-xlsx></script>
//     <script src=cdn-jszip></script>
//   </body></html>
//
// We want just the body content between <body> and the first <script>
// — the static markup that the PWA's index.html will host.

const buildFn = between(
  popupJs,
  'function buildInteractiveHtml(',
  '\n}\n\n// ── Render',
  { include: true }
);

const bodyHtml = between(
  buildFn,
  '<body>\n',
  '\n<script>\n/* global XLSX */'
);

// Convert template-literal `${expr}` interpolations into placeholders the
// PWA's HTML shell will resolve at load time. There are a few:
//   ${escHtml(title)}              → __TITLE__ (multiple places)
//   ${equipOptionsHtml}            → __EQUIP_OPTIONS__
//   ${pinSvgBtn}                   → __PIN_SVG_BTN__
// Plus a literal AVScout logo SVG (no interpolations inside it).

const expectedInterps = [
  { pattern: /\$\{escHtml\(title\)\}/g, placeholder: '{{TITLE}}' },
  { pattern: /\$\{equipOptionsHtml\}/g, placeholder: '{{EQUIP_OPTIONS}}' },
  { pattern: /\$\{pinSvgBtn\}/g,        placeholder: '{{PIN_SVG_BTN}}' },
];

let html = bodyHtml;
const interpCounts = {};
for (const { pattern, placeholder } of expectedInterps) {
  const count = (html.match(pattern) || []).length;
  interpCounts[placeholder] = count;
  html = html.replace(pattern, placeholder);
}

// Any remaining ${...} is a surprise — fail.
const surprises = html.match(/\$\{[^}]+\}/g);
if (surprises) {
  throw new Error(
    `Unexpected template interpolations remaining in HTML body:\n` +
    [...new Set(surprises)].join('\n')
  );
}

console.log(`  - HTML interpolations:`, interpCounts);

// ── Extract EQUIP_TYPES + helper functions ──────────────────────────────────

// Start anchor: the comment block immediately before `const EQUIP_TYPES`.
// End anchor: the blank line before `function buildInteractiveHtml`.
const equipBlock = between(
  popupJs,
  '// 21 equipment types — alphabetical by label.\n',
  '\nfunction buildInteractiveHtml(',
);

// Strip trailing whitespace/blanks
const equipTrimmed = equipBlock.trimEnd();

const equipModule =
`// shared/avscout/equipment.js
//
// Single source of truth for AV equipment types. Used by both
// Floorplan-extension's Excel-import filter modal and the AVScout
// surveying app.

// 21 equipment types — alphabetical by label.
${equipTrimmed}

export { EQUIP_TYPES, equipEmoji, equipLabel, normaliseExcelType, excelTypeToValue };
`;

// ── Write files ─────────────────────────────────────────────────────────────

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, 'avscout.css'), css);
await fs.writeFile(path.join(OUT_DIR, 'avscout.js'), finalScript);
await fs.writeFile(path.join(OUT_DIR, 'avscout.html'), html);
await fs.writeFile(path.join(OUT_DIR, 'equipment.js'), equipModule);

console.log('');
console.log('Wrote:');
console.log('  shared/avscout/avscout.css  ', css.length, 'bytes');
console.log('  shared/avscout/avscout.js   ', finalScript.length, 'bytes');
console.log('  shared/avscout/avscout.html ', html.length, 'bytes');
console.log('  shared/avscout/equipment.js ', equipModule.length, 'bytes');
