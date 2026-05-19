// shared/avscout/boot.js
//
// PWA bootstrap. Runs once on page load:
//   1. Register the service worker (offline cache).
//   2. Open the IndexedDB.
//   3. Bind SurveyKV to the last-opened storey (if any).
//   4. Install a localStorage shim that routes `fp_state_*` (and similar
//      floor-scoped keys) through SurveyKV — the surveying app uses
//      `localStorage` sync API throughout, but persistence is per-storey
//      in IndexedDB.
//   5. Call initAVScout(...) with everything the surveying app needs to
//      mount itself — including the storage handles, so the surveying
//      app can manage its own floor-rail and storey switching.

import * as storage from './storage.js';
import { EQUIP_TYPES } from './equipment.js';
import { initAVScout } from './avscout.js';

// ── Service worker ─────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[boot] SW registration failed:', err);
    });
  });
}

// ── localStorage shim ──────────────────────────────────────────────────────
//
// The surveying app uses sync localStorage. We bind SurveyKV to the
// active storey before init runs, then redirect getItem/setItem/removeItem
// for floor-scoped keys to SurveyKV. Other keys (global preferences)
// continue to use real localStorage.

const FLOOR_PREFIXES = ['fp_state_', 'fp_equip_filter'];
function installLsShim() {
  const orig = {
    getItem: window.localStorage.getItem.bind(window.localStorage),
    setItem: window.localStorage.setItem.bind(window.localStorage),
    removeItem: window.localStorage.removeItem.bind(window.localStorage),
  };
  const isFloorScoped = (k) =>
    FLOOR_PREFIXES.some(p => typeof k === 'string' && k.startsWith(p));
  window.localStorage.getItem = (k) =>
    isFloorScoped(k) ? storage.SurveyKV.getItem(k) : orig.getItem(k);
  window.localStorage.setItem = (k, v) =>
    isFloorScoped(k) ? storage.SurveyKV.setItem(k, v) : orig.setItem(k, v);
  window.localStorage.removeItem = (k) =>
    isFloorScoped(k) ? storage.SurveyKV.removeItem(k) : orig.removeItem(k);
}

// ── App init ───────────────────────────────────────────────────────────────

// Sanity check: the body markup MUST contain #svg-wrap for the surveying
// app to mount. If it's missing, the page is from a stale service-worker
// cache (an older deploy whose index.html didn't include the inlined body).
// Self-heal by unregistering the SW + clearing caches + reloading once.
async function detectAndRecoverFromStaleCache() {
  if (document.getElementById('svg-wrap')) return false; // healthy

  console.warn('[boot] #svg-wrap missing — looks like a stale cache. Cleaning.');

  // Guard against an infinite reload loop. Use sessionStorage so the flag
  // dies with the tab.
  if (sessionStorage.getItem('avscout:cache-recovered') === '1') {
    document.body.innerHTML = `<pre style="padding:16px;color:#ff5f5f;font:14px/1.4 monospace">
AVScout couldn't recover from a stale cache automatically.

To fix manually:
  1. Open DevTools → Application → Storage → Clear site data
  2. Reload the page

(Detail: the inlined surveying-app body is missing from this index.html.)
</pre>`;
    return true; // we handled it (by giving up)
  }
  sessionStorage.setItem('avscout:cache-recovered', '1');

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) {
    console.warn('[boot] cache cleanup failed:', e);
  }
  location.reload();
  return true; // we are reloading
}

// ── External SVG import bridge ─────────────────────────────────────────────
//
// The Floorplan Chrome extension hands captured SVGs to AVScout by opening
// (or reusing) an AVScout tab and posting a message of the form:
//   { type: 'avscout:import', svg: '<svg>...', title: '17-00', source: 'floorplan-ext' }
// We listen for that message and persist the SVG via addStoreyFromSvg.
//
// We install the listener BEFORE app init so even if the message arrives
// during boot, it's queued by the browser and we'll handle it as soon as
// the listener is added. After init, future messages are handled too
// (the user can capture another floor and re-send without reloading).
//
// On a successful import the page reloads so the surveying app re-mounts
// onto the new floor. This is consistent with the rail's own
// "add SVG" flow (a reload is how floor switching works).

function setupExternalImportBridge() {
  let busy = false;
  window.addEventListener('message', async (ev) => {
    const data = ev.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'avscout:import') return;
    if (typeof data.svg !== 'string' || !data.svg) return;
    if (busy) return; // ignore the double-send retry from the extension
    busy = true;

    try {
      // Filename hint for deriveStorey's fallback path. We synthesize one
      // from the title (e.g. "17-00" → "17.00.svg") to maximize the chance
      // that deriveStorey can recover the storey id even from SVGs whose
      // room codes have been stripped. Inside addStoreyFromSvg the SVG's
      // own room codes are tried first; the filename is only a fallback.
      const titleHint = String(data.title || '').replace(/-/g, '.');
      const filename  = titleHint ? `${titleHint}.svg` : 'imported.svg';

      const result = await storage.addStoreyFromSvg(data.svg, filename);
      await storage.touchStorey(result.record.storey);

      // Stash a post-reload toast so the user sees confirmation after the
      // page comes back up on the imported floor.
      const verb = result.status === 'created' ? 'Loaded'
                 : result.status === 'svg-replaced' ? 'SVG replaced for'
                 : 'Refreshed';
      const label = result.record.storey.replace('.', '-');
      try {
        sessionStorage.setItem('avscout:postReloadToast',
          `✓ ${verb} floor ${label} (from Floorplan extension)`);
      } catch (_) {}

      // Drop the ?awaitImport=1 query if present, then reload so initAVScout
      // re-mounts onto the new floor.
      const u = new URL(location.href);
      u.searchParams.delete('awaitImport');
      location.replace(u.pathname + (u.search ? u.search : '') + u.hash);
    } catch (err) {
      console.error('[boot] external import failed:', err);
      // Surface the failure in-page. We can't toast yet (the surveying
      // app may not be mounted), so use alert as a last resort.
      try {
        alert('Could not load the floorplan from the Floorplan extension:\n\n' +
              (err && err.message ? err.message : String(err)));
      } catch (_) {}
      busy = false;
    }
  });
}

(async () => {
  // Wire the external-import listener as early as possible.
  setupExternalImportBridge();

  // Run the stale-cache check BEFORE we touch any other system. If it
  // fires, the page is about to reload — don't bother doing anything else.
  if (await detectAndRecoverFromStaleCache()) return;

  await storage.openDb();

  // Find the most recently opened storey, if any.
  const storeys = await storage.listStoreys();
  const activeStorey = storeys.length > 0 ? storeys[0] : null;

  if (activeStorey) {
    await storage.SurveyKV.bindStorey(activeStorey.storey);
    await storage.touchStorey(activeStorey.storey);
  }

  // Install the localStorage shim AFTER SurveyKV.bindStorey, so any
  // reads-on-init see the freshly-loaded storey state.
  installLsShim();

  // Build the short-form equipment list the surveying app expects.
  const equipTypes = EQUIP_TYPES.map(t => ({
    v: t.value, l: t.label, e: t.emoji,
    x: t.excelMatch, p: !!t.preselected,
  }));

  // Hand control to avscout.js. The surveying app owns the rail and the
  // storey lifecycle — boot.js only sets up the initial floor.
  await initAVScout({
    equipTypes,
    storage,
    initialStorey: activeStorey ? {
      storey: activeStorey.storey,
      title: activeStorey.title || activeStorey.storey,
      svgRaw: activeStorey.svg,
    } : null,
  });

  // Boot succeeded — clear the recovery flag so future stale-cache events
  // can recover (this one's been validated as a clean session).
  try { sessionStorage.removeItem('avscout:cache-recovered'); } catch(e){}
})().catch(err => {
  console.error('[boot] Fatal:', err);
  document.body.innerHTML = `<pre style="padding:16px;color:#ff5f5f;font:14px/1.4 monospace">
AVScout failed to start.

${(err && err.stack) || err}

Try reloading. If the problem persists, clear the site data and reload.
</pre>`;
});
