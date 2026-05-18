// Lightweight smoke test of shared/avscout/avscout.js. We don't have a
// real DOM, so we mock just enough that the module parses and we can
// import it without crashing in the first lines. Real verification
// happens in the browser.

import { promises as fs } from 'node:fs';

const code = await fs.readFile('shared/avscout/avscout.js', 'utf8');

// 1. Module parses?
try {
  // Strip ES module syntax for the Function() ctor check
  const stripped = code
    .replace(/^export function /m, 'function ')
    .replace(/^import .+;$/gm, '');
  new Function(stripped);
  console.log('✓ Parses as JS');
} catch (e) {
  console.log('✗ Parse error:', e.message);
  process.exit(1);
}

// 2. Has the expected initAVScout export?
if (!/export function initAVScout\(__config\)/.test(code)) {
  console.log('✗ initAVScout export not found');
  process.exit(1);
}
console.log('✓ initAVScout export present');

// 3. No leftover template-literal placeholders?
const placeholders = code.match(/__(?:EQUIP_JSON|SVG_RAW_LITERAL|SAFE_STOREY|TITLE)__/g);
if (placeholders) {
  console.log('✗ Leftover placeholders:', [...new Set(placeholders)]);
  process.exit(1);
}
console.log('✓ No leftover placeholders');

// 4. Config references look right?
for (const ref of ['__config.equipTypes', '__config.svgRaw', '__config.safeStorey', '__config.title']) {
  if (!code.includes(ref)) {
    console.log(`✗ Missing config reference: ${ref}`);
    process.exit(1);
  }
}
console.log('✓ All 4 config references present');

// 5. Sanity: equipment.js exports
const eq = await fs.readFile('shared/avscout/equipment.js', 'utf8');
for (const fn of ['EQUIP_TYPES', 'equipEmoji', 'equipLabel', 'normaliseExcelType', 'excelTypeToValue']) {
  if (!eq.includes(fn)) {
    console.log(`✗ equipment.js missing: ${fn}`);
    process.exit(1);
  }
}
console.log('✓ equipment.js exports look right');

// 6. HTML has the 3 placeholders
const html = await fs.readFile('shared/avscout/avscout.html', 'utf8');
for (const p of ['{{TITLE}}', '{{EQUIP_OPTIONS}}', '{{PIN_SVG_BTN}}']) {
  if (!html.includes(p)) {
    console.log(`✗ HTML missing placeholder: ${p}`);
    process.exit(1);
  }
}
console.log('✓ HTML placeholders present');

console.log('\nAll smoke checks passed.');
