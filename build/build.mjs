// build/build.mjs
//
// Builds everything into dist/.
//
//   dist/floorplan-ext/    — Chrome extension, renamed "(dev)" so it can
//                            load alongside the production one.
//   dist/avscout-harness/  — single-file HTML test harness for the
//                            extracted AVScout shared/ modules. Phase 1
//                            sanity check; superseded by the PWA in
//                            Phase 2.
//
// CLI:
//   node build/build.mjs                build everything
//   node build/build.mjs --only=ext     just the extension
//   node build/build.mjs --only=harness just the harness
//   node build/build.mjs --watch        rebuild on file change (polled)

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const onlyArg = [...args].find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;
const watch = args.has('--watch');

const targets = {
  ext:     only === null || only === 'ext',
  harness: only === null || only === 'harness',
  pwa:     only === null || only === 'pwa',
};

// ── Helpers ────────────────────────────────────────────────────────────────

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

function log(...args) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}]`, ...args);
}

// ── Targets ────────────────────────────────────────────────────────────────

async function buildExt() {
  const src = path.join(ROOT, 'floorplan-ext');
  const dst = path.join(ROOT, 'dist', 'floorplan-ext');

  if (!existsSync(src)) throw new Error(`Extension source not found: ${src}`);

  await rmrf(dst);
  await copyDir(src, dst);

  // Rename manifest so the dev build loads as a distinct extension
  // alongside the production one. Source manifest stays untouched.
  const manifestPath = path.join(dst, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!/\(dev\)$/.test(manifest.name)) {
    manifest.name = `${manifest.name} (dev)`;
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  log(`✓ built floorplan-ext → dist/floorplan-ext/ (loads as "${manifest.name}")`);
}

async function buildHarness() {
  // Delegated to a separate script (keeps both readable).
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'build-harness.mjs')],
      { stdio: 'inherit', cwd: ROOT }
    );
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`harness build exited ${code}`)));
  });
}

async function buildPwa() {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'build-pwa.mjs')],
      { stdio: 'inherit', cwd: ROOT }
    );
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`pwa build exited ${code}`)));
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function buildAll() {
  const tasks = [];
  if (targets.ext)     tasks.push(buildExt());
  if (targets.harness) tasks.push(buildHarness());
  if (targets.pwa)     tasks.push(buildPwa());
  await Promise.all(tasks);
}

async function watchLoop() {
  let lastMtime = 0;
  const watchedDirs = [];
  if (targets.ext)     watchedDirs.push(path.join(ROOT, 'floorplan-ext'));
  if (targets.harness) watchedDirs.push(path.join(ROOT, 'shared'));

  async function maxMtime(dir) {
    if (!existsSync(dir)) return 0;
    let m = 0;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of await fs.readdir(cur, { withFileTypes: true })) {
        const p = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else {
          const st = await fs.stat(p);
          if (st.mtimeMs > m) m = st.mtimeMs;
        }
      }
    }
    return m;
  }

  log('Watching for changes (Ctrl+C to stop)…');
  await buildAll();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise(r => setTimeout(r, 500));
    let m = 0;
    for (const d of watchedDirs) {
      const dm = await maxMtime(d);
      if (dm > m) m = dm;
    }
    if (lastMtime === 0) { lastMtime = m; continue; }
    if (m > lastMtime) {
      lastMtime = m;
      log('Change detected; rebuilding…');
      try { await buildAll(); }
      catch (e) { console.error('Build failed:', e); }
    }
  }
}

try {
  if (watch) await watchLoop();
  else { await buildAll(); log('Done.'); }
} catch (e) {
  console.error('Build failed:', e);
  process.exit(1);
}
