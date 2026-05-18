// Static cross-reference check for PWA modules. Each module's imports
// must resolve against another module's exports.
//
// This catches typos like "import { foo } from './bar.js'" where bar.js
// exports `Foo` not `foo`, which would otherwise only surface at runtime.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('shared');
const FILES = [
  'avscout/boot.js',
  'avscout/avscout.js',
  'avscout/equipment.js',
  'avscout/storage.js',
];

const modules = {};
for (const f of FILES) {
  const src = await fs.readFile(path.join(ROOT, f), 'utf8');
  // Parse exports — naive but effective for our codebase
  const exports = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) exports.add(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+(\w+)/gm)) exports.add(m[1]);
  for (const m of src.matchAll(/^export\s+\{\s*([^}]+)\s*\}/gm)) {
    for (const name of m[1].split(',')) {
      const clean = name.trim().split(/\s+as\s+/)[1] || name.trim().split(/\s+/)[0];
      if (clean) exports.add(clean);
    }
  }
  // Parse imports
  const imports = [];
  for (const m of src.matchAll(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm)) {
    const fromPath = m[2];
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    imports.push({ from: fromPath, names, host: f });
  }
  modules[f] = { src, exports, imports };
}

// Resolve imports
let failures = 0;
function resolve(host, relativePath) {
  const baseDir = path.dirname(host);
  const target = path.normalize(path.join(baseDir, relativePath));
  // Match against FILES list
  for (const f of FILES) {
    if (path.normalize(f) === target) return f;
  }
  return null;
}

for (const [host, info] of Object.entries(modules)) {
  for (const imp of info.imports) {
    const resolved = resolve(host, imp.from);
    if (!resolved) {
      console.log(`✗ ${host}: cannot resolve import ${imp.from}`);
      failures++;
      continue;
    }
    const provided = modules[resolved].exports;
    for (const want of imp.names) {
      const cleanWant = want.split(/\s+as\s+/)[0].trim();
      if (!provided.has(cleanWant)) {
        console.log(`✗ ${host}: imports "${cleanWant}" from ${imp.from}, but that module doesn't export it`);
        console.log(`  ${resolved} exports: ${[...provided].join(', ')}`);
        failures++;
      }
    }
  }
}

// Sanity: each PWA module is syntactically valid as a module
for (const f of FILES) {
  try {
    // Use Function() on the source after stripping ES module syntax
    const stripped = modules[f].src
      .replace(/^export\s+function /gm, 'function ')
      .replace(/^export\s+async\s+function /gm, 'async function ')
      .replace(/^export\s+const /gm, 'const ')
      .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
      .replace(/^import\s[^;]+;\s*$/gm, '');
    new Function(stripped);
  } catch (e) {
    console.log(`✗ ${f}: syntax error: ${e.message}`);
    failures++;
  }
}

if (failures === 0) {
  console.log(`✓ All ${FILES.length} PWA modules parse cleanly and imports resolve`);
}
process.exit(failures > 0 ? 1 : 0);
