// Storage tests (Phase 3). Uses fake-indexeddb to run IDB in Node.
import 'fake-indexeddb/auto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const storage = await import(pathToFileURL(path.resolve('shared/avscout/storage.js')).href);

let passes = 0, failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passes++; }
  catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.stack?.split('\n').slice(0, 5).join('\n  ')}`);
    failures++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Sample room codes use Stipl's building.wing.floor.room format.
// Storey identity is building + floor (skipping wing), so the SVG below
// for "17.A0.00.020" maps to storey "17.00".
const SVG_17_00     = '<svg><g class="space_text"><text><tspan>17.A0.00.020</tspan></text></g></svg>';
const SVG_17_01     = '<svg><g class="space_text"><text><tspan>17.A0.01.030</tspan></text></g></svg>';
const SVG_08_01     = '<svg><g class="space_text"><text><tspan>08.03.01.050</tspan></text></g></svg>';
// Different wing (04 vs 03) but same floor (01) — should produce the
// same storey id as SVG_08_01.
const SVG_08_01_W04 = '<svg><g class="space_text"><text><tspan>08.04.01.230</tspan></text></g></svg>';
// Alphanumeric floor: K1 = basement 1 (Dutch "kelder"). Real-world case.
const SVG_04_K1     = '<svg><g class="space_text"><text><tspan>04.00.K1.853</tspan></text></g></svg>';

await test('deriveStorey returns building.floor, skipping wing', async () => {
  assertEq(storage.deriveStorey(SVG_17_00, 'x.svg'), '17.00');
  assertEq(storage.deriveStorey(SVG_08_01, 'x.svg'), '08.01');
  // Same building+floor as SVG_08_01, different wing — same storey
  assertEq(storage.deriveStorey(SVG_08_01_W04, 'x.svg'), '08.01');
});

await test('deriveStorey accepts alphanumeric floor segments (e.g. K1 basement)', async () => {
  assertEq(storage.deriveStorey(SVG_04_K1, '04-k1.svg'), '04.K1');
});

await test('deriveStorey filename fallback accepts lowercase floor letters', async () => {
  // Filename "04-k1.svg" with no room codes in the SVG should still derive
  const svgEmpty = '<svg>no codes here</svg>';
  assertEq(storage.deriveStorey(svgEmpty, '04-k1.svg'), '04.K1');
});

await test('buildingOf returns the first segment', async () => {
  assertEq(storage.buildingOf('08.01'), '08');
  assertEq(storage.buildingOf('17.00'), '17');
});

await test('addStoreyFromSvg creates a new storey', async () => {
  const r = await storage.addStoreyFromSvg(SVG_17_00, 'storey17.svg');
  assertEq(r.status, 'created');
  assertEq(r.record.storey, '17.00');
  assertEq(r.record.building, '17');
  assertEq(r.record.title, 'storey17');
  assert(r.record.svg === SVG_17_00, 'svg stored');
});

await test('addStoreyFromSvg with same hash → unchanged', async () => {
  const r = await storage.addStoreyFromSvg(SVG_17_00, 'whatever.svg');
  assertEq(r.status, 'unchanged');
});

await test('addStoreyFromSvg with different SVG on same storey → svg-replaced', async () => {
  // Modify the SVG slightly to change the hash but keep room codes
  const modified = SVG_17_00 + '<!-- revision 2 -->';
  const r = await storage.addStoreyFromSvg(modified, 'rev2.svg');
  assertEq(r.status, 'svg-replaced');
  assertEq(r.record.storey, '17.00');
  assert(r.record.svg === modified, 'svg updated');
});

await test('listBuildings groups storeys by building (first segment)', async () => {
  await storage.addStoreyFromSvg(SVG_17_01, 'B.svg');
  await storage.addStoreyFromSvg(SVG_08_01, 'C.svg');

  const buildings = await storage.listBuildings();
  const bldgCodes = buildings.map(b => b.building).sort();
  assertEq(bldgCodes, ['08', '17']);
  const b17 = buildings.find(b => b.building === '17');
  assert(b17.storeys.length === 2, 'building 17 has 2 storeys');
  const codes = b17.storeys.map(s => s.storey).sort();
  assertEq(codes, ['17.00', '17.01']);
});

await test('two SVGs with different wings collapse to the same storey', async () => {
  // SVG_08_01_W04 has wing 04, but the existing storey 08.01 was created
  // from wing 03 — should be treated as the same storey (svg-replaced).
  const r = await storage.addStoreyFromSvg(SVG_08_01_W04, 'wing04.svg');
  assertEq(r.status, 'svg-replaced');
  assertEq(r.record.storey, '08.01');
});

await test('detachSvg keeps storey but drops svg', async () => {
  await storage.detachSvg('17.00');
  const r = await storage.getStorey('17.00');
  assert(r != null, 'storey still exists');
  assert(r.svg === null, 'svg is null');
  assert(r.svgHash === null, 'svgHash is null');
});

await test('attachSvg restores an svg to a detached storey', async () => {
  const r = await storage.attachSvg('17.00', SVG_17_00);
  assert(r.svg === SVG_17_00);
  assert(r.svgHash, 'hash set');
});

await test('attachSvg refuses an SVG whose storey doesn\'t match the target', async () => {
  // SVG_08_01 is for storey 08.01, but we're trying to attach it to 17.00.
  let threw = false;
  let msg = '';
  try { await storage.attachSvg('17.00', SVG_08_01); }
  catch (e) { threw = true; msg = e.message; }
  assert(threw, 'should have thrown');
  assert(/08-01/.test(msg) || /08\.01/.test(msg),
    `message should mention the derived floor: ${msg}`);
  // And the existing svg should be unchanged
  const r = await storage.getStorey('17.00');
  assert(r.svg === SVG_17_00, 'original SVG preserved');
});

await test('attachSvg refuses an SVG with no recognisable room codes', async () => {
  let threw = false;
  try { await storage.attachSvg('17.00', '<svg>no room codes here</svg>'); }
  catch (e) { threw = true; }
  assert(threw, 'should have rejected SVG with no room codes');
});

await test('SurveyKV: bind storey, set/get, persistence', async () => {
  await storage.SurveyKV.bindStorey('17.00');
  storage.SurveyKV.setItem('fp_state_x', '{"m":1}');
  assertEq(storage.SurveyKV.getItem('fp_state_x'), '{"m":1}');
  await storage.SurveyKV.drain();
  storage.SurveyKV.unbind();
  assertEq(storage.SurveyKV.getItem('fp_state_x'), null);
  await storage.SurveyKV.bindStorey('17.00');
  assertEq(storage.SurveyKV.getItem('fp_state_x'), '{"m":1}');
});

await test('SurveyKV isolates storeys', async () => {
  await storage.SurveyKV.bindStorey('17.00');
  storage.SurveyKV.setItem('k', 'A');
  await storage.SurveyKV.drain();
  await storage.SurveyKV.bindStorey('08.01');
  assertEq(storage.SurveyKV.getItem('k'), null, 'k from 17.00 not visible in 08.01');
  storage.SurveyKV.setItem('k', 'B');
  await storage.SurveyKV.drain();
  await storage.SurveyKV.bindStorey('17.00');
  assertEq(storage.SurveyKV.getItem('k'), 'A', 'still A here');
});

await test('deleteStorey removes both storey and survey state', async () => {
  await storage.SurveyKV.bindStorey('08.01');
  storage.SurveyKV.setItem('fp_state_x', 'val');
  await storage.SurveyKV.drain();
  storage.SurveyKV.unbind();
  await storage.deleteStorey('08.01');
  assert(!(await storage.getStorey('08.01')), 'storey gone');
  const remaining = await storage.getSurveyAll('08.01');
  assertEq(Object.keys(remaining).length, 0, 'no survey rows remain');
});

await test('exportPackage / importPackage round-trip', async () => {
  await storage.addStoreyFromSvg(SVG_08_01, 'src.svg');
  await storage.SurveyKV.bindStorey('08.01');
  storage.SurveyKV.setItem('fp_state_x', 'val');
  await storage.SurveyKV.drain();
  storage.SurveyKV.unbind();

  const pkg = await storage.exportPackage('08.01');
  assertEq(pkg.format, 'avscout-survey-v1');
  assertEq(pkg.storey.storey, '08.01');
  assertEq(pkg.survey.fp_state_x, 'val');

  await storage.deleteStorey('08.01');
  await storage.importPackage(pkg);
  const re = await storage.getStorey('08.01');
  assertEq(re.storey, '08.01');
  const sv = await storage.getSurveyAll('08.01');
  assertEq(sv.fp_state_x, 'val');
});

await test('addStoreyFromSvg rejects unrecognisable SVG', async () => {
  let threw = false;
  try { await storage.addStoreyFromSvg('<svg>no room codes</svg>', 'mystery.svg'); }
  catch (e) { threw = true; }
  assert(threw, 'should have rejected');
});

await test('createStoreyIfMissing creates a new storey with no SVG', async () => {
  const r = await storage.createStoreyIfMissing('19.00', '19.00');
  assertEq(r.status, 'created');
  assertEq(r.record.storey, '19.00');
  assertEq(r.record.building, '19');
  assert(r.record.svg === null, 'svg should be null');
  assert(r.record.svgHash === null, 'svgHash should be null');
});

await test('createStoreyIfMissing is a no-op when storey exists', async () => {
  const r = await storage.createStoreyIfMissing('19.00', 'ignored');
  assertEq(r.status, 'exists');
});

await test('setSurveyItem and getSurveyItem round-trip a non-active storey', async () => {
  await storage.setSurveyItem('19.00', 'fp_state_xyz', '{"importedAssets":[{"a":1}]}');
  const v = await storage.getSurveyItem('19.00', 'fp_state_xyz');
  assertEq(v, '{"importedAssets":[{"a":1}]}');
});

console.log('');
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
