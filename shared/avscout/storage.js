// shared/avscout/storage.js
//
// IndexedDB-backed storage for the AVScout PWA.
//
// Data model (Phase 3):
//
//   STOREYS               keyed by storey code (e.g. "08.03.01")
//     { storey,           // canonical key, e.g. "08.03.01"
//       building,         // first 2 segments, e.g. "08.03"
//       title,            // user-editable display name
//       svg,              // SVG text, or null if floorplan is detached
//       svgHash,          // sha256 prefix of svg; null if no svg
//       addedAt,
//       lastOpenedAt }
//
//   SURVEY                keyed by [storey, key]
//     Per-storey key/value store used by the legacy surveying app
//     (markers, visited, etc. — see SurveyKV facade).
//
// All identity is now the storey code. A storey survives floorplan
// changes — you can detach the SVG and attach a different one later
// while keeping the survey state.
//
// Module API:
//   openDb()                              one-time DB setup
//   hashSvg(text)                         sha256(text), hex
//   deriveStorey(svgText, filename)       storey code from SVG
//   listStoreys()                         all storeys, newest-first
//   listBuildings()                       distinct buildings, each with storey count
//   getStorey(storey)                     fetch one
//   addStoreyFromSvg(svgText, filename)   create or refresh storey + svg
//   attachSvg(storey, svgText)            (re)attach a floorplan to existing storey
//   detachSvg(storey)                     drop the svg, keep survey data
//   deleteStorey(storey)                  storey + all survey state
//   touchStorey(storey)                   bump lastOpenedAt
//
//   SurveyKV.bindStorey(storey)           preload survey state into memory
//   SurveyKV.{get,set,remove}Item(k, v?)  localStorage-shaped sync API
//   SurveyKV.drain()                      await all pending writes
//   SurveyKV.unbind()                     clear active storey
//
//   exportPackage(storey)                 JSON package for one storey
//   importPackage(pkg)                    inverse of exportPackage

const DB_NAME = 'avscout';
const DB_VERSION = 3;            // v3 = building.floor (2 seg); v2 was 3 seg
const STORE_STOREYS = 'storeys';
const STORE_SURVEY  = 'survey';

// ── Open / upgrade ─────────────────────────────────────────────────────────

let _dbPromise = null;
export function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // Storey identity changed from 3 segments (building.floor.wing,
      // e.g. "08.03.01") to 2 segments (building.floor, e.g. "08.03").
      // Old records use keys that no longer match the new scheme — drop
      // both stores and rebuild empty. This is destructive; users with
      // existing data will start fresh.
      if (db.objectStoreNames.contains('floors')) {
        db.deleteObjectStore('floors');
      }
      if (db.objectStoreNames.contains(STORE_STOREYS)) {
        db.deleteObjectStore(STORE_STOREYS);
      }
      if (db.objectStoreNames.contains(STORE_SURVEY)) {
        db.deleteObjectStore(STORE_SURVEY);
      }
      const s = db.createObjectStore(STORE_STOREYS, { keyPath: 'storey' });
      s.createIndex('building', 'building');
      s.createIndex('lastOpenedAt', 'lastOpenedAt');
      db.createObjectStore(STORE_SURVEY, { keyPath: ['storey', 'key'] });
    };
  });
  return _dbPromise;
}

function tx(db, stores, mode = 'readonly') {
  return db.transaction(stores, mode);
}

function reqAsync(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Identity / parsing ────────────────────────────────────────────────────

export async function hashSvg(svgText) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(svgText));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Room codes use Stipl's 4-segment format: building.wing.floor.room
// e.g. "08.03.01.050" or "04.00.K1.853" (Dutch buildings use letters in
// the floor slot for basements: K1 = kelder 1, etc.).
// Segments:
//   [1] building — 2 digits (only structural constant)
//   [2] wing     — 2 alphanumerics (can be A0, 00, etc.)
//   [3] floor    — 2 alphanumerics (01, 17, K1, ground "00", etc.)
//   [4] room     — 3 digits (always numeric)
// Storey identity is building + floor (segments 1 and 3, skipping wing).
const ROOM_CODE_RE = /\b(\d{2})\.([A-Z0-9]{2})\.([A-Z0-9]{2})\.\d{3}\b/;

/**
 * Find the first Stipl room code inside an SVG and return the storey
 * identity = building + floor (segments 1 and 3, skipping the wing).
 *
 * Room codes are building.wing.floor.room. One floorplan SVG covers an
 * entire floor across all wings, so the floor identity is "building.floor"
 * regardless of wing.
 *
 * Returns null if no room code is found.
 */
export function deriveStorey(svgText, fallbackFromFilename) {
  // Match tspans first (most reliable in Stipl SVGs) then anywhere
  const tspanIter = svgText.matchAll(/<tspan[^>]*>([^<]+)<\/tspan>/g);
  for (const m of tspanIter) {
    const cm = ROOM_CODE_RE.exec(m[1]);
    if (cm) return `${cm[1]}.${cm[3]}`;
  }
  const anywhere = ROOM_CODE_RE.exec(svgText);
  if (anywhere) return `${anywhere[1]}.${anywhere[3]}`;
  // Try the filename as a last resort — accept either "building.floor"
  // (2 segments, with `.`, `-` or `_` separator) or a full room code we
  // can extract from. Filenames are sometimes lowercase even when the
  // canonical room codes use uppercase (e.g. "04-k1.svg" matching
  // codes like "04.00.K1.050"), so the fallback is case-insensitive
  // and normalizes to uppercase.
  if (fallbackFromFilename) {
    const fn = fallbackFromFilename.replace(/\.svg$/i, '');
    const full = /\b(\d{2})\.([A-Za-z0-9]{2})\.([A-Za-z0-9]{2})\.\d{3}\b/.exec(fn);
    if (full) return `${full[1]}.${full[3].toUpperCase()}`;
    const twoSeg = /^(\d{2})[.\-_]([A-Za-z0-9]{2})/.exec(fn);
    if (twoSeg) return `${twoSeg[1]}.${twoSeg[2].toUpperCase()}`;
  }
  return null;
}

/**
 * Building code for a given storey. A storey is "building.floor"
 * (e.g. "08.01"), so the building is the first segment.
 */
export function buildingOf(storey) {
  return (storey || '').split('.').slice(0, 1).join('.') || 'unknown';
}

// ── Storey CRUD ───────────────────────────────────────────────────────────

export async function listStoreys() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out = [];
    const cursor = tx(db, [STORE_STOREYS]).objectStore(STORE_STOREYS).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) { out.push(c.value); c.continue(); }
      else {
        out.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
        resolve(out);
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

/**
 * Distinct buildings with their storey counts. Ordered by the most
 * recently opened storey within each building.
 */
export async function listBuildings() {
  const storeys = await listStoreys();
  const map = new Map();
  for (const s of storeys) {
    if (!map.has(s.building)) {
      map.set(s.building, { building: s.building, storeys: [], lastOpenedAt: 0 });
    }
    const b = map.get(s.building);
    b.storeys.push(s);
    if ((s.lastOpenedAt || 0) > b.lastOpenedAt) b.lastOpenedAt = s.lastOpenedAt || 0;
  }
  // Sort storeys within building by their code, ascending; buildings by
  // most-recently-opened, descending.
  const buildings = [...map.values()];
  for (const b of buildings) b.storeys.sort((a, b) => a.storey.localeCompare(b.storey));
  buildings.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return buildings;
}

export async function getStorey(storey) {
  const db = await openDb();
  return reqAsync(tx(db, [STORE_STOREYS]).objectStore(STORE_STOREYS).get(storey));
}

export async function putStorey(record) {
  const db = await openDb();
  await reqAsync(tx(db, [STORE_STOREYS], 'readwrite').objectStore(STORE_STOREYS).put(record));
  return record;
}

export async function touchStorey(storey) {
  const r = await getStorey(storey);
  if (!r) return null;
  r.lastOpenedAt = Date.now();
  await putStorey(r);
  return r;
}

/**
 * Create-or-update a storey from a freshly-picked SVG file.
 *   - If no storey record exists yet → create it.
 *   - If a record exists with the same hash → just bump lastOpenedAt.
 *   - If a record exists with a different hash → replace the svg field
 *     (caller is responsible for warning the user / re-anchoring markers).
 */
export async function addStoreyFromSvg(svgText, filename) {
  const storey = deriveStorey(svgText, filename);
  if (!storey) {
    throw new Error('Could not detect a floor code in this SVG. Make sure it is a floorplan from app.stipl.org with room codes (e.g. "08.03.01.050").');
  }
  const building = buildingOf(storey);
  const svgHash = (await hashSvg(svgText)).slice(0, 16);
  const now = Date.now();

  const existing = await getStorey(storey);
  if (!existing) {
    const title = filename ? filename.replace(/\.svg$/i, '') : storey;
    const rec = { storey, building, title, svg: svgText, svgHash, addedAt: now, lastOpenedAt: now };
    await putStorey(rec);
    return { record: rec, status: 'created' };
  }

  // Existing storey — already has same SVG?
  if (existing.svgHash === svgHash) {
    existing.lastOpenedAt = now;
    await putStorey(existing);
    return { record: existing, status: 'unchanged' };
  }

  // Different SVG → replace the floorplan, keep survey data, keep title
  existing.svg = svgText;
  existing.svgHash = svgHash;
  existing.lastOpenedAt = now;
  await putStorey(existing);
  return { record: existing, status: 'svg-replaced' };
}

/**
 * Attach (or replace) the SVG on an existing storey. Verifies that the
 * SVG's room codes match the target storey: if the SVG is for a
 * different floor, throws an error rather than silently corrupting the
 * binding between markers and room codes.
 *
 * Throws if:
 *   - the storey doesn't exist
 *   - the SVG has no parseable room codes (we can't verify it)
 *   - the SVG's derived storey doesn't match the target
 */
export async function attachSvg(storey, svgText) {
  const rec = await getStorey(storey);
  if (!rec) throw new Error(`No such floor: ${storey}`);

  const derived = deriveStorey(svgText, '');
  if (!derived) {
    throw new Error('This SVG has no recognisable room codes (e.g. "08.03.01.050"). It cannot be attached because the floor it belongs to cannot be determined.');
  }
  if (derived !== storey) {
    throw new Error(`This SVG is for floor ${derived.replace('.', '-')}, not ${storey.replace('.', '-')}. Pick an SVG whose room codes match this floor, or attach this one to ${derived.replace('.', '-')} instead.`);
  }

  rec.svg = svgText;
  rec.svgHash = (await hashSvg(svgText)).slice(0, 16);
  rec.lastOpenedAt = Date.now();
  await putStorey(rec);
  return rec;
}

/**
 * Drop the SVG but keep the storey record + survey state. Used by the
 * "Detach floorplan" action.
 */
export async function detachSvg(storey) {
  const rec = await getStorey(storey);
  if (!rec) throw new Error(`No such storey: ${storey}`);
  rec.svg = null;
  rec.svgHash = null;
  await putStorey(rec);
  return rec;
}

/**
 * Delete a storey AND all its survey state. Destructive; the home-rail's
 * "Delete storey" action calls this after confirmation.
 */
export async function deleteStorey(storey) {
  const db = await openDb();
  const t = tx(db, [STORE_STOREYS, STORE_SURVEY], 'readwrite');
  await reqAsync(t.objectStore(STORE_STOREYS).delete(storey));
  const range = IDBKeyRange.bound([storey, ''], [storey, '\uffff']);
  await new Promise((resolve, reject) => {
    const cursor = t.objectStore(STORE_SURVEY).openCursor(range);
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) { c.delete(); c.continue(); }
      else resolve();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

// ── Per-storey survey state (raw) ─────────────────────────────────────────

async function _surveyGet(storey, key) {
  const db = await openDb();
  const v = await reqAsync(
    tx(db, [STORE_SURVEY]).objectStore(STORE_SURVEY).get([storey, key])
  );
  return v ? v.value : null;
}

async function _surveyPut(storey, key, value) {
  const db = await openDb();
  await reqAsync(
    tx(db, [STORE_SURVEY], 'readwrite').objectStore(STORE_SURVEY).put({ storey, key, value })
  );
}

async function _surveyDelete(storey, key) {
  const db = await openDb();
  await reqAsync(
    tx(db, [STORE_SURVEY], 'readwrite').objectStore(STORE_SURVEY).delete([storey, key])
  );
}

async function _surveyListAll(storey) {
  const db = await openDb();
  const range = IDBKeyRange.bound([storey, ''], [storey, '\uffff']);
  return new Promise((resolve, reject) => {
    const out = {};
    const cursor = tx(db, [STORE_SURVEY]).objectStore(STORE_SURVEY).openCursor(range);
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) { out[c.value.key] = c.value.value; c.continue(); }
      else resolve(out);
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export async function getSurveyAll(storey) { return _surveyListAll(storey); }

/**
 * Direct write into a (possibly non-active) storey's survey KV. Used by
 * the XLS-import-to-multiple-storeys path, which needs to drop rows
 * into storeys other than the currently-mounted one.
 */
export async function setSurveyItem(storey, key, value) {
  return _surveyPut(storey, key, value);
}

/**
 * Delete a single survey row from a (possibly non-active) storey.
 * Paired with setSurveyItem for cleanup workflows.
 */
export async function deleteSurveyItem(storey, key) {
  return _surveyDelete(storey, key);
}

/**
 * Drop every survey row for a (possibly non-active) storey, leaving the
 * storey record + its SVG intact. Used by the "Delete Assets on all
 * floors" action in the Data modal.
 */
export async function clearSurvey(storey) {
  const all = await _surveyListAll(storey);
  for (const k of Object.keys(all)) {
    await _surveyDelete(storey, k);
  }
}

/**
 * Direct read from a (possibly non-active) storey's survey KV. Paired
 * with setSurveyItem for read-modify-write workflows.
 */
export async function getSurveyItem(storey, key) {
  return _surveyGet(storey, key);
}

/**
 * Create a storey record without an SVG. Used by XLS-driven storey
 * auto-creation: the XLS knows the storey code, so we can list it in
 * the rail even before the user attaches a floorplan. If the storey
 * already exists, this is a no-op.
 */
export async function createStoreyIfMissing(storey, title) {
  const existing = await getStorey(storey);
  if (existing) return { record: existing, status: 'exists' };
  const rec = {
    storey,
    building: buildingOf(storey),
    title: title || storey,
    svg: null,
    svgHash: null,
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  await putStorey(rec);
  return { record: rec, status: 'created' };
}

// ── SurveyKV: localStorage-shaped sync facade over IDB ─────────────────────

export const SurveyKV = (() => {
  let active = null;        // active storey code
  let cache = {};
  let pending = new Map();  // unflushed writes
  let writeQueue = Promise.resolve();

  async function bindStorey(storey) {
    if (active === storey) return;
    // Drain any pending writes from the previous bind FIRST
    await writeQueue;
    active = storey;
    cache = storey ? await _surveyListAll(storey) : {};
    pending.clear();
  }

  function getItem(key) {
    if (!active) return null;
    if (pending.has(key)) {
      const v = pending.get(key);
      return v == null ? null : String(v);
    }
    const v = cache[key];
    return v == null ? null : String(v);
  }

  function setItem(key, value) {
    if (!active) return;
    const str = String(value);
    cache[key] = str;
    pending.set(key, str);
    flush();
  }

  function removeItem(key) {
    if (!active) return;
    delete cache[key];
    pending.set(key, undefined);
    flush();
  }

  function flush() {
    writeQueue = writeQueue.then(async () => {
      const batch = [...pending.entries()];
      pending.clear();
      if (batch.length === 0 || !active) return;
      for (const [k, v] of batch) {
        try {
          if (v === undefined) await _surveyDelete(active, k);
          else await _surveyPut(active, k, v);
        } catch (e) {
          console.error('[SurveyKV] write failed', k, e);
        }
      }
    });
  }

  async function drain() { await writeQueue; }

  function unbind() {
    active = null;
    cache = {};
    pending.clear();
  }

  return { bindStorey, unbind, getItem, setItem, removeItem, drain };
})();

// ── JSON package round-trip ────────────────────────────────────────────────

export async function exportPackage(storey) {
  const rec = await getStorey(storey);
  if (!rec) throw new Error(`No storey: ${storey}`);
  const survey = await _surveyListAll(storey);
  return {
    format: 'avscout-survey-v1',
    exportedAt: new Date().toISOString(),
    storey: rec,
    survey,
  };
}

export async function importPackage(pkg) {
  if (!pkg || pkg.format !== 'avscout-survey-v1') {
    throw new Error('Not an AVScout survey package (expected format=avscout-survey-v1).');
  }
  if (!pkg.storey || !pkg.storey.storey) {
    throw new Error('Package missing storey record.');
  }

  const incoming = { ...pkg.storey, lastOpenedAt: Date.now() };
  // Backfill `building` for older exports that didn't carry it
  if (!incoming.building) incoming.building = buildingOf(incoming.storey);

  const db = await openDb();
  const t = tx(db, [STORE_STOREYS, STORE_SURVEY], 'readwrite');
  await reqAsync(t.objectStore(STORE_STOREYS).put(incoming));

  // Wipe existing survey entries for this storey, then put new ones
  const range = IDBKeyRange.bound([incoming.storey, ''], [incoming.storey, '\uffff']);
  const surveyStore = t.objectStore(STORE_SURVEY);
  await new Promise((resolve, reject) => {
    const cursor = surveyStore.openCursor(range);
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) { c.delete(); c.continue(); }
      else resolve();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  for (const [k, v] of Object.entries(pkg.survey || {})) {
    await reqAsync(surveyStore.put({ storey: incoming.storey, key: k, value: v }));
  }

  return incoming;
}
