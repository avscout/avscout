// shared/avscout/avscout.js
//
// The AVScout surveying application + floor-rail navigation.
//
// Call initAVScout({ equipTypes, storage, initialStorey }) once after
// the DOM is ready. The host page (index.html for the PWA) provides:
//   - equipTypes: the equipment-type catalogue (short-form)
//   - storage:   the shared/avscout/storage.js module (live reference)
//   - initialStorey: { storey, title, svgRaw } | null
//     The storey to mount on launch. If null, the empty state is shown
//     and the rail offers "+ Add SVG" to create the first storey.
//
// Storey switching is handled by triggering location.reload() after
// committing the new active storey to storage. This sidesteps the
// complexity of re-mounting a 5500-line app live, with a ~200ms cost
// per switch — fine in practice.

/* global XLSX, JSZip */

export function initAVScout(__config) {
'use strict';

const __storage = __config.storage;
const __initialStorey = __config.initialStorey;  // {storey, title, svgRaw} | null
const __hasFloor = !!(__initialStorey && __initialStorey.svgRaw);

// Floor-specific identity. Both fall back to '' so downstream code that
// concatenates them into filenames/labels never produces "undefined".
const __safeStorey = __initialStorey ? String(__initialStorey.storey || '') : '';
const __floorTitle = __initialStorey ? String(__initialStorey.title || __initialStorey.storey || '') : '';

// Fill the toolbar h1 (which contains <span id="tpl-title"></span> as set
// by the build script). If no storey is loaded, the title shows as empty —
// the rail+empty-state communicate context instead.
(function fillTitle(){
  const titleEl = document.getElementById('tpl-title');
  if (titleEl) titleEl.textContent = __floorTitle;
  document.title = __floorTitle ? `AVScout · ${__floorTitle}` : 'AVScout';
})();

// Populate the marker modal's equipment-type dropdown. The dropdown is
// referenced as <select id="modalEquip"></select> in the HTML body and
// gets populated here once equipment data is available.
(function fillEquipOptions(){
  const sel = document.getElementById('modalEquip');
  if (!sel) return;
  // Clear any existing options (defensive — should be empty at boot)
  sel.innerHTML = '';
  for (const t of __config.equipTypes) {
    const opt = document.createElement('option');
    opt.value = t.v;
    opt.textContent = `${t.e} ${t.l}`;
    sel.appendChild(opt);
  }
})();

// ── Equipment types (inlined from extension) ──────────────
const EQUIP = __config.equipTypes;
function equipEmoji(v){ const t=EQUIP.find(t=>t.v===v); return t?t.e:'📍'; }
function equipLabel(v){ const t=EQUIP.find(t=>t.v===v); return t?t.l:v; }
function normaliseExcelType(str){
  if(str==null) return '';
  return String(str).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
}
// Stipl's newer XLSX export puts an admin URL in the Equipment Type
// column (e.g. "/admin/data/avrack/106/change/") rather than a
// human-readable label. Extract the slug between /data/ and the numeric
// id so the same alias table matches both old and new exports.
//   "/admin/data/avrack/106/change/"      -> "avrack"
//   "/admin/data/wirelesspresentation/3/" -> "wirelesspresentation"
// Returns null if the input doesn't look like an admin URL.
function extractStiplTypeSlug(str){
  if(!str) return null;
  const m=/\/admin\/data\/([a-z0-9_]+)\/\d+/i.exec(String(str));
  return m ? m[1].toLowerCase() : null;
}

// Numeric ID from the same URL form. Returns null if absent.
//   "/admin/data/avrack/106/change/" -> "106"
function extractStiplTypeId(str){
  if(!str) return null;
  const m=/\/admin\/data\/[a-z0-9_]+\/(\d+)/i.exec(String(str));
  return m ? m[1] : null;
}

// Match against any alias in t.x (excelMatch). Tries the URL-slug form
// first, then falls back to the legacy human-readable form. Returns null
// if no type matches — caller routes the row into the Unmatched bucket.
function excelTypeToValue(str){
  const slug=extractStiplTypeSlug(str);
  const norm=slug || normaliseExcelType(str);
  if(!norm) return null;
  for(const t of EQUIP){
    if(t.x.some(m=>norm===m)) return t.v;
  }
  return null;
}

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Marker pin SVG ────────────────────────────────────────
// The teardrop pin path is rendered in many places (asset rows, locate-by
// buttons, ack-modal markers, modal title jump pill, etc.). Single source
// for the path; pinSvg builds an <svg> string with the right size + fill.
// All callers use the same viewBox 0 0 10 13. Pass w:0 (or h:0) to omit
// inline width/height so CSS controls the size — used by the .jumpable
// asset-row pin where we want CSS to win on sizing.
const PIN_PATH='M5 0C2.24 0 0 2.24 0 5c0 3.75 5 8 5 8s5-4.25 5-8C10 2.24 7.76 0 5 0zm0 7A2 2 0 1 1 5 3a2 2 0 0 1 0 4z';
function pinSvg({cls='', fill='currentColor', w=10, h=13, attrs=''}={}){
  const sizeAttrs = (w && h) ? ' width="'+w+'" height="'+h+'"' : '';
  return '<svg'+(cls?' class="'+cls+'"':'')+sizeAttrs+
         ' viewBox="0 0 10 13"'+
         (attrs?' '+attrs:'')+
         '><path fill="'+fill+'" d="'+PIN_PATH+'"/></svg>';
}

// Collision-resistant ID generator. Date.now() alone collides if two markers
// are created in the same millisecond (e.g. fast double-click on Confirm, or a
// loop). Suffix with a per-session counter to guarantee uniqueness.
let _idCounter = 0;
function nextId(){ return Date.now().toString() + '_' + (++_idCounter); }

// ── Inject SVG ────────────────────────────────────────────
//
// If we have no floor (empty state), we don't inject anything. The rest
// of the surveying setup below STILL runs, but it'll find no rooms,
// no markers, and no imports — i.e. an empty-but-functional shell.
// The rail's "+ Add SVG" button will reload the page with a real floor.
const SVG_RAW = __hasFloor ? __initialStorey.svgRaw : '';
const wrap = document.getElementById('svg-wrap');
wrap.innerHTML = SVG_RAW;
const svgEl = wrap.querySelector('svg');
if(svgEl){
  svgEl.removeAttribute('width'); svgEl.removeAttribute('height');
  svgEl.style.cssText='display:block;width:100%;height:auto;min-width:900px;';
}

// ── Tag every room with data-room-code ────────────────────
// Stipl's SVG uses ifcguid as the join between a room polygon and its
// label group (g.space_text). For AVScout we want a single canonical
// attribute keyed off the human-readable room code instead — both so
// the rest of the code is simpler, and so a future PDF→SVG converter
// can produce the same schema without inventing fake ifcguids.
//
// Process: walk every g.space_text, read the room code from its first
// tspan, find the matching path via the shared ifcguid (encoded as a
// CSS class on the text group), set data-room-code on it. After this
// runs, no other code in AVScout needs to know about ifcguid.
(function tagRoomsByCode(){
  const textGroups = wrap.querySelectorAll('g.space_text');
  textGroups.forEach(g=>{
    const ts = g.querySelector('tspan');
    if(!ts) return;
    const code = ts.textContent.trim();
    if(!code) return;
    // Tag the label group itself for the snip-export pairing logic.
    g.setAttribute('data-room-code', code);
    // The ifcguid is one of the classes on the group (the long random one,
    // not 'space_text'). Use it to find the matching room path.
    const cls = [...g.classList].find(c => c!=='space_text' && c.length>5);
    if(!cls) return;
    const path = wrap.querySelector('[ifcguid="'+cls+'"]') ||
                 wrap.querySelector('.'+CSS.escape(cls));
    if(path) path.setAttribute('data-room-code', code);
  });
})();

// ── Collect all room codes present in this SVG ────────────
// Used for floor-prefix matching during Excel import
function getAllRoomCodes(){
  const codes=new Set();
  wrap.querySelectorAll('g.space_text tspan:first-child').forEach(ts=>{
    const c=ts.textContent.trim();
    if(c) codes.add(c);
  });
  return codes;
}

// Room codes use Stipl's 4-segment format: building.wing.floor.room
// e.g. "08.03.01.050" = building 08, wing 03, floor 01, room 050.
// The storey/floor identity is "building.floor" (segments 0 and 2),
// skipping the wing.

// Building code: first segment, e.g. "08" from "08.03.01.050".
function buildingCodeOf(code){
  const p=String(code||'').split('.');
  return p.length>=1 ? p[0] : '';
}

// Storey/floor identity: building + floor, skipping wing.
// "08.03.01.050" → "08.01"
// One floorplan SVG covers all wings on a floor, so codes for the same
// floor from different wings collapse to the same identity.
function floorPrefix(code){
  const p=String(code||'').split('.');
  if(p.length>=3) return p[0]+'.'+p[2];
  if(p.length===2) return p[0]+'.'+p[1]; // already in storey format
  return code;
}

// Same thing under a different name, for the multi-storey import path.
function storeyOf(code){
  return floorPrefix(String(code||''));
}

// Display label for a floor row in the rail: "08-01" (matches the
// data-model "08.01" but reads as a single token rather than a path).
function floorLabel(storey){
  return String(storey || '').replace('.', '-');
}

// ── State ─────────────────────────────────────────────────
let scale=1, tx=0, ty=0;
const MIN_S=0.08, MAX_S=12;

// markers: {id, x, y, label, equip, assetId|null, isNew}
let markers   = [];
// visited: array of path element IDs
let visited   = [];
// importedAssets: array from Excel — memory only, not persisted
// {assetId, spaceNumber, spaceName, equipType, model, serialNumber, details}
// where details is {dateInOperation, ipAddress, macAddress, hostname,
// firmware, firmwareInstalledOn, outlet, switchPortInfo, staging}
let importedAssets = [];
// newAssets: assets created via "New asset" mode — persisted
let newAssets = [];
// assetStatuses: survey status per imported asset ID — single source of truth
// {[assetId]: {status, room, storageLocation}}
let assetStatuses = {};

function getAssetStatus(assetId){
  return assetStatuses[String(assetId)]||null;
}
function setAssetStatus(assetId, status, room, storageLocation, customName, offmapLocation){
  const key=String(assetId);
  const existing=assetStatuses[key]||{};
  if(!status){
    // Clearing the survey status. Keep customName around if there is one —
    // the rename is asset-level metadata, separate from the marker/status.
    // If no rename exists, drop the entry entirely.
    const keepName = customName!==undefined ? customName : existing.customName;
    if(keepName){
      assetStatuses[key]={
        status:null, room:null, storageLocation:null, offmapLocation:null,
        customName: keepName
      };
    } else {
      delete assetStatuses[key];
    }
    return;
  }
  assetStatuses[key]={
    status,
    room:room||null,
    storageLocation:storageLocation||null,
    offmapLocation:offmapLocation!==undefined?offmapLocation:(existing.offmapLocation||null),
    customName:customName!==undefined?customName:(existing.customName||null)
  };
}

// ── Per-asset undo stack ─────────────────────────────────────
// A simple "history of mappable state" per asset. Each snapshot captures
// EVERYTHING we need to put one asset back to a prior state:
//
//   { marker: <full marker object | null>,
//     status: <full status entry  | null> }
//
// Single most-recent snapshot per asset. Originally a stack with MAX_UNDO_DEPTH
// (20), but only the most recent entry is ever consumed (via the toast Undo
// button after a mutation). The right-rail "reset" no longer pops snapshots
// — it just drops everything. So a single-slot lastSnapshot[id] does the job
// the stack did, with less ceremony.
let lastSnapshot = {}; // {[assetId]: snapshot}

// Capture a fresh snapshot of the asset's marker + status. Call BEFORE the
// mutation. Caller is responsible for persisting (saveToStorage) afterwards.
function pushUndoSnapshot(assetId){
  const idStr = String(assetId);
  const m = markers.find(mm => String(mm.assetId) === idStr);
  const s = assetStatuses[idStr] || null;
  lastSnapshot[idStr] = {
    marker: m ? { ...m } : null,
    status: s ? { ...s } : null
  };
}

// Apply the saved snapshot and clear it. Returns true if applied, false if
// no snapshot existed.
//
// IMPORTANT: customName is treated as asset-level metadata, INDEPENDENT of
// the marker/status that the snapshot tracks. Whatever the rename is right
// now, it stays. So before applying the snapshot we capture the live
// customName (from both the live status entry and any live marker) and
// re-apply it after the snapshot has overwritten everything.
function popUndoSnapshot(assetId){
  const idStr = String(assetId);
  const snap = lastSnapshot[idStr];
  if(!snap) return false;
  delete lastSnapshot[idStr];

  // Capture the live customName before anything is mutated.
  const liveStatus = assetStatuses[idStr] || null;
  const liveMarker = markers.find(mm => String(mm.assetId) === idStr) || null;
  const liveCustomName =
    (liveStatus && liveStatus.customName) ||
    (liveMarker && liveMarker.customName) || null;

  // Replace the marker (or remove if snapshot had none).
  markers = markers.filter(mm => String(mm.assetId) !== idStr);
  if(snap.marker){
    const restored = { ...snap.marker };
    if(liveCustomName) restored.customName = liveCustomName;
    else delete restored.customName;
    markers.push(restored);
  }

  // Replace the status entry (or clear if snapshot had none).
  if(snap.status){
    const restoredStatus = { ...snap.status };
    if(liveCustomName) restoredStatus.customName = liveCustomName;
    else restoredStatus.customName = null;
    assetStatuses[idStr] = restoredStatus;
  } else if(liveCustomName){
    // Snapshot had no status, but the asset has a live rename. Keep an entry
    // around so the rename isn't lost.
    assetStatuses[idStr] = {
      status:null, room:null, storageLocation:null, offmapLocation:null,
      customName: liveCustomName
    };
  } else {
    delete assetStatuses[idStr];
  }

  return true;
}


// ── Lookup helpers ────────────────────────────────────────
// Centralise the asset/marker lookups that appeared 12× and 8× in the
// codebase respectively. assetById ALWAYS string-coerces both sides so
// numeric vs string assetIds match.
function assetById(id){
  const s=String(id);
  return importedAssets.find(a=>String(a.assetId)===s);
}
// Find the marker for an imported asset (excludes newcomer markers).
function markerForAsset(id){
  const s=String(id);
  return markers.find(m=>String(m.assetId)===s && !m.isNew);
}
// Find the newcomer marker for a given newcomer assetId.
function newcomerMarkerFor(id){
  const s=String(id);
  return markers.find(m=>String(m.assetId)===s && m.isNew);
}
// Find a newcomer entry (in newAssets[]) by id. Newcomers may or may not
// have a corresponding markers[] entry — room-only newcomers have just the
// newAssets entry.
function newAssetById(id){
  const s=String(id);
  return newAssets.find(a=>String(a.assetId)===s);
}
// Whether a given id refers to a newcomer (vs an imported asset).
function isNewcomerId(id){
  return !!newAssetById(id);
}
// Next available newcomer ID. Format: "N-{seq}" where seq is the smallest
// positive integer not currently taken by any newAssets entry. Generated
// at commit time (Save or Set position auto-save), not when the modal
// opens — so cancellations don't leave gaps.
function nextNewcomerId(){
  const used=new Set(newAssets.map(a=>String(a.assetId||'')));
  let n=1;
  while(used.has('N-'+n)) n++;
  return 'N-'+n;
}

// Compute and store room-relative coordinates for a marker.
//
// Markers store m.x/m.y in WORLD-PIXEL space (the rendered SVG's local space,
// origin at the SVG's top-left). That's portable across the live session but
// becomes meaningless if the SVG is replaced or you want to know "where in
// the room is this marker?" — for that we want SVG-internal coords offset
// from the room polygon's top-left.
//
// On every successful create / move-into-a-room, we set:
//   m.roomCode  — e.g. "08.03.01.230"   (which room)
//   m.roomX     — SVG units, offset from the room polygon's bbox top-left X
//   m.roomY     — SVG units, offset from the room polygon's bbox top-left Y
//
// roomPath is optional. If null, all room-relative fields are cleared (the
// marker is implicitly outside any room — rare, but the marker still works
// via m.x/m.y).
function setMarkerRoomCoords(m, roomPath){
  if(!roomPath){
    m.roomCode = null; m.roomX = null; m.roomY = null;
    return;
  }

  const newCode = getRoomCode(roomPath);

  // Convert m.x/m.y (world-pixel space, i.e. wrap div's local coord space)
  // to the room polygon's own coord system, using getScreenCTM().inverse().
  let local;
  try {
    const wrapRect = wrap.getBoundingClientRect();
    const screenX = m.x + wrapRect.left;
    const screenY = m.y + wrapRect.top;
    const svg = wrap.querySelector('svg');
    if(!svg) throw new Error('no svg');
    const ctm = roomPath.getScreenCTM();
    if(!ctm) throw new Error('no ctm');
    const inv = ctm.inverse();
    const pt = svg.createSVGPoint();
    pt.x = screenX; pt.y = screenY;
    local = pt.matrixTransform(inv);
  } catch(_){
    // If the live SVG / CTM isn't available (e.g. during early init), just
    // skip the offset math — the marker keeps its world coords and roomCode.
    m.roomCode = newCode; m.roomX = null; m.roomY = null;
    return;
  }

  // Subtract the polygon's local-space bbox top-left to get the offset.
  const bbox = roomPath.getBBox();
  m.roomCode = newCode;
  m.roomX = local.x - bbox.x;
  m.roomY = local.y - bbox.y;
}

// Place a marker for an imported asset and set its survey status in one shot.
// Centralises what was 3 near-identical blocks across the codebase: undo-restore,
// Position-from-Imports fast-path, and the modal's link-mode save.
//   ia          — the importedAssets entry
//   x, y        — world coordinates
//   roomCode    — the room the marker landed in (may be null for undo-restore)
//   status      — 'confirmed', 'relocated', etc. Pass null to skip status set.
//                 Caller can pass derivedStatus(roomCode, ia.spaceNumber) for
//                 the auto behaviour, or a literal like 'confirmed'.
//   includeLabel— true on user placement (label shows the asset id), false on
//                 undo-restore (kept identical to original behaviour).
function placeImportedMarker(ia, x, y, roomCode, status, includeLabel){
  const m={ id:nextId(), x, y, equip:ia.equipType, assetId:String(ia.assetId), isNew:false };
  if(includeLabel) m.label=String(ia.assetId);
  // Resolve roomCode → polygon element so we can compute offset from its top-left.
  // findPathByRoomCode returns null for unknown codes (e.g. undo-restore from
  // a stale spaceNumber); setMarkerRoomCoords handles that gracefully.
  const roomPath = roomCode ? findPathByRoomCode(roomCode) : null;
  setMarkerRoomCoords(m, roomPath);
  markers.push(m);
  if(status) setAssetStatus(ia.assetId, status, roomCode, null, null, null);
}

// An asset is "handled" if it has a status in assetStatuses
function isAssetHandled(assetId){
  const s=assetStatuses[String(assetId)];
  return !!(s&&s.status);
}

// Undo the most recent change to this asset. Pops one snapshot off the
// per-asset undo stack and applies it (replaces the marker and status entry
// with whatever was captured by the matching pushUndoSnapshot call).
//
// No-op if the asset has nothing to undo (empty stack).
function undoAssetStatus(assetId){
  if(!popUndoSnapshot(assetId)) return;
  commit();
}

// Reset an imported asset to its imported baseline: drop any survey
// status entry and any marker. Single-click action — replaces the old
// multi-step undo flow on the right-rail button. Pushes an undo snapshot
// first so the user can recover via the 5s toast Undo if they hit reset
// by mistake. The customName (rename) is intentionally preserved per the
// rename-independence rule that setAssetStatus enforces.
function resetAssetToImported(assetId){
  const idStr=String(assetId);
  // Nothing to reset if the asset is already in its imported state.
  const hasStatus = !!assetStatuses[idStr];
  const hasMarker = markers.some(m=>String(m.assetId)===idStr && !m.isNew);
  if(!hasStatus && !hasMarker) return;

  pushUndoSnapshot(idStr);
  setAssetStatus(idStr, null);
  markers = markers.filter(m=>!(String(m.assetId)===idStr && !m.isNew));

  commit();

  // 5-second toast: lets the user undo the reset itself. The Movers
  // tab usually re-renders to remove the row, so the toast is the
  // user's only handle to walk it back.
  showUndoToast(`Reset ${idStr}`, ()=>{
    undoAssetStatus(idStr);
  });
}

let selectedPath    = null;
let editingId       = null;
let pendingPos      = null;
let pendingRoomCode = null;
let suppressNextClick = false;
let panelAssetId    = null; // set when modal opened from panel row (not from map)
let placingMode     = false;
let movingMarkerId  = null;
let modalMode       = 'link'; // 'link' | 'new'
let selectedAssetId = null;   // which asset is selected in the modal picker

// Draft state for the new + button flow:
//   - draftNcomerActive: a fresh newcomer is being composed in the main
//     modal but hasn't been saved yet. No newAssets entry exists.
//   - draftNcomerData: the in-flight values (name + equip), preserved
//     across the "Set position" round-trip (modal closes → user clicks
//     map → marker placed). When the click handler sees draftNcomerActive,
//     it commits the newcomer (creates newAssets + markers entries with a
//     generated ID) and skips reopening the modal — same auto-save model
//     the imported flow uses for Set position.
let draftNcomerActive = false;
let draftNcomerData = null;

const world  = document.getElementById('world');
const canvas = document.getElementById('canvas');

// ── Info bar elements ─────────────────────────────────────
const infobar      = document.getElementById('infobar');
const infoEmpty    = document.getElementById('info-empty');
const infoRoom     = document.getElementById('info-room');
const infoRoomCode = document.getElementById('info-room-code');
const infoRoomSpaceName = document.getElementById('info-room-space-name');
const infoRoomLink = document.getElementById('info-room-link');
const infoDevices  = document.getElementById('info-devices');
const infoVisited  = document.getElementById('info-visited');

// ── Compass state ─────────────────────────────────────────
let compassHeading=0, compassEnabled=false;

// ── Toast ─────────────────────────────────────────────────
let toastTimer=null;
function showFpToast(msg, isWarn=false, dur=3200){
  const el=document.getElementById('fp-toast');
  el.textContent=msg;
  el.className='show'+(isWarn?' warn':'');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),dur);
}

// Undoable toast: text + an Undo button. 5.5s window, then auto-dismiss.
// Used wherever an action could benefit from a chance to take it back.
let undoToastTimer=null;
function showUndoToast(msg, onUndo){
  const el=document.getElementById('fp-toast');
  if(!el) return;
  clearTimeout(undoToastTimer);
  el.innerHTML='';
  const text=document.createElement('span');
  text.textContent=msg;
  const btn=document.createElement('button');
  btn.textContent='Undo';
  btn.className='fp-toast-undo';
  btn.addEventListener('click',()=>{
    clearTimeout(undoToastTimer);
    el.classList.remove('show');
    try{ onUndo(); }catch(e){}
  });
  el.appendChild(text); el.appendChild(btn);
  el.className='show with-action';
  undoToastTimer=setTimeout(()=>el.classList.remove('show'),5500);
}

// ── Transform ─────────────────────────────────────────────
function markerFontSize(){
  const tspan=wrap.querySelector('g.space_text tspan');
  if(tspan){ const h=tspan.getBoundingClientRect().height; if(h>0) return h/scale; }
  const svg=wrap.querySelector('svg');
  return (svg?svg.clientWidth:900)*0.01;
}
function updateMarkerSizes(){
  const fs=markerFontSize()+'px';
  world.querySelectorAll('.marker').forEach(el=>el.style.fontSize=fs);
}
function applyT(){
  const rot=compassEnabled?` rotate(${-compassHeading}deg)`:'';
  world.style.transform=`translate(${tx}px,${ty}px) scale(${scale})${rot}`;
  document.getElementById('fab-zoom-pct').textContent=Math.round(scale*100)+'%';
  updateMarkerSizes();
}
function clampS(s){ return Math.min(MAX_S,Math.max(MIN_S,s)); }
function clientToWorld(cx,cy){
  const r=canvas.getBoundingClientRect();
  return {x:(cx-r.left-tx)/scale, y:(cy-r.top-ty)/scale};
}
function fitToView(){
  const sw=wrap.scrollWidth||900, sh=wrap.scrollHeight||600;
  const cw=canvas.clientWidth, ch=canvas.clientHeight;
  scale=clampS(Math.min(cw/sw,ch/sh)*0.88);
  tx=(cw-sw*scale)/2; ty=(ch-sh*scale)/2; applyT();
}
setTimeout(fitToView,80);

// Centre the canvas on a marker and zoom in. Uses the same framing as the
// snip tool's bulk export: fit the marker's room polygon's bounding box
// into the viewport with a 25% margin. That gives a comfortable, consistent
// zoom level — close enough to read the marker and its surroundings, far
// enough to see what room it's in.
function jumpToMarker(markerId){
  const m = markers.find(mm=>String(mm.id)===String(markerId));
  if(!m) return;
  const cw=canvas.clientWidth, ch=canvas.clientHeight;

  // Find the room polygon for this marker (so we can frame its bbox).
  // Falls back to centring on the marker alone if the room isn't found.
  const roomPath = m.roomCode ? findPathByRoomCode(m.roomCode) : null;

  if(roomPath){
    // World-px bbox of the room polygon, derived from its current screen
    // bounding box and the canvas transform — same path the snip tool takes.
    const cr = canvas.getBoundingClientRect();
    const r  = roomPath.getBoundingClientRect();
    const wx1 = (r.left  - cr.left - tx) / scale;
    const wy1 = (r.top   - cr.top  - ty) / scale;
    const wx2 = (r.right - cr.left - tx) / scale;
    const wy2 = (r.bottom- cr.top  - ty) / scale;
    const ww = wx2 - wx1, wh = wy2 - wy1;
    if(ww > 0 && wh > 0){
      // Inflate by 25% on each side (same constant as BULK_MARGIN_FRAC).
      const MARGIN = 0.25;
      const targetW = ww * (1 + 2*MARGIN);
      const targetH = wh * (1 + 2*MARGIN);
      // Pick the scale that fits the inflated bbox into the viewport.
      const ns = clampS(Math.min(cw/targetW, ch/targetH));
      // Centre the room's bbox in the viewport.
      const cxw = (wx1 + wx2)/2;
      const cyw = (wy1 + wy2)/2;
      tx = cw/2 - cxw*ns;
      ty = ch/2 - cyw*ns;
      scale = ns;
      applyT();
    }
  } else {
    // No room — just centre on the marker at a reasonable zoom.
    const sw=wrap.scrollWidth||900, sh=wrap.scrollHeight||600;
    const fitScale = Math.min(cw/sw,ch/sh)*0.88;
    scale = clampS(Math.max(fitScale*3, 1.5));
    tx = cw/2 - m.x*scale;
    ty = ch/2 - m.y*scale;
    applyT();
  }

  // Flash the marker so the user spots it.
  setTimeout(()=>{
    const el = world.querySelector(`.marker[data-id="${CSS.escape(String(m.id))}"]`);
    if(el){
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  },120);
}

// ── Zoom ──────────────────────────────────────────────────
function zoomAt(cx,cy,f){
  const r=canvas.getBoundingClientRect(), px=cx-r.left, py=cy-r.top;
  const ns=clampS(scale*f);
  tx=px-(px-tx)*(ns/scale); ty=py-(py-ty)*(ns/scale); scale=ns; applyT();
}
canvas.addEventListener('wheel',e=>{
  e.preventDefault(); zoomAt(e.clientX,e.clientY,e.deltaY<0?1.12:1/1.12);
},{passive:false});
const canvasCX=()=>canvas.clientWidth/2+canvas.getBoundingClientRect().left;
const canvasCY=()=>canvas.clientHeight/2+canvas.getBoundingClientRect().top;
document.getElementById('fab-zi')   .addEventListener('click',()=>zoomAt(canvasCX(),canvasCY(),1.25));
document.getElementById('fab-zo')   .addEventListener('click',()=>zoomAt(canvasCX(),canvasCY(),1/1.25));
document.getElementById('fab-reset').addEventListener('click',fitToView);

// ── Compass ───────────────────────────────────────────────
const fabCompass=document.getElementById('fab-compass');
const compassNeedle=document.getElementById('compass-needle');
function onOrientation(e){
  const h=e.webkitCompassHeading||(e.absolute?(360-e.alpha):e.alpha)||0;
  compassHeading=h;
  compassNeedle.style.transform=`rotate(${h}deg)`;
  if(compassEnabled) applyT();
}
window.addEventListener('deviceorientationabsolute',onOrientation,true);
window.addEventListener('deviceorientation',onOrientation,true);
fabCompass.addEventListener('click',()=>{
  if(!compassEnabled&&typeof DeviceOrientationEvent!=='undefined'&&typeof DeviceOrientationEvent.requestPermission==='function'){
    DeviceOrientationEvent.requestPermission().then(s=>{
      if(s==='granted'){compassEnabled=true;fabCompass.classList.add('active');applyT();}
    }).catch(()=>{});
    return;
  }
  compassEnabled=!compassEnabled;
  fabCompass.classList.toggle('active',compassEnabled);
  applyT();
});

// ── Pan ───────────────────────────────────────────────────
let drag=false, dragX=0, dragY=0, hasDragged=false;
canvas.addEventListener('mousedown',e=>{
  if(e.button!==0) return;
  hasDragged=false;
  drag=true; dragX=e.clientX; dragY=e.clientY;
  if(!placingMode) canvas.classList.add('dragging');
});
window.addEventListener('mousemove',e=>{
  if(!drag) return;
  const dx=e.clientX-dragX, dy=e.clientY-dragY;
  tx+=dx; ty+=dy; dragX=e.clientX; dragY=e.clientY;
  if(Math.abs(dx)+Math.abs(dy)>4){
    hasDragged=true;
    if(!placingMode) canvas.classList.add('dragging');
  }
  applyT();
});
window.addEventListener('mouseup',e=>{
  drag=false; canvas.classList.remove('dragging');
  if(movingMarkerId&&!hasDragged){
    const pos=clientToWorld(e.clientX,e.clientY);
    const m=markers.find(m=>m.id===movingMarkerId);
    const hitPath=e.target.closest('path.floor-plan-space');

    if(m&&!hitPath){
      // Dropped outside a room — snap back, no change
      movingMarkerId=null;
      canvas.classList.remove('moving-marker');
      endRepositionUI();
      suppressNextClick=true;
      showFpToast('Drop inside a room to reposition');
      renderMarkers();
      return;
    }

    if(m){
      // Snapshot before mutation so undo can restore the pre-drag position
      // and (if applicable) the previous status.
      if(m.assetId) pushUndoSnapshot(m.assetId);

      m.x=pos.x; m.y=pos.y;
      setMarkerRoomCoords(m, hitPath);
      if(m.isNew && m.assetId){
        // Newcomer — update room assignment
        const newRoom=hitPath?getRoomCode(hitPath):null;
        const na=newAssets.find(a=>a.assetId===m.assetId);
        if(na) na.spaceNumber=newRoom||'Unknown';
      } else if(!m.isNew && m.assetId){
        // Imported — auto-derive confirmed/relocated from new room vs registered room
        const newRoom=getRoomCode(hitPath);
        const ia=assetById(m.assetId);
        const auto=derivedStatus(newRoom, ia?.spaceNumber);
        const saved=getAssetStatus(m.assetId);
        if(!saved||saved.status==='confirmed'||saved.status==='relocated'||!saved.status){
          setAssetStatus(m.assetId, auto, newRoom, null, saved?.customName||null);
        }
      }
    }
    movingMarkerId=null;
    canvas.classList.remove('moving-marker');
    endRepositionUI();
    suppressNextClick=true;
    commit();
    // Highlight the destination room on the map AND jump the panel to the
    // moved asset's row (Imports for imported, Newcomers for newcomers) —
    // not the room's "best tab", which could flip away from the asset.
    const movedAssetId = m && m.assetId;
    focusAfterMarkerAction(hitPath, movedAssetId);
    if(!hitPath && selectedPath) showInfoBar(selectedPath);
  }
});
let lastT=null;
canvas.addEventListener('touchstart',e=>{lastT=[...e.touches];},{passive:true});
canvas.addEventListener('touchmove',e=>{
  e.preventDefault();
  const t=[...e.touches]; if(!lastT) return;
  if(t.length===1&&lastT.length===1){
    tx+=t[0].clientX-lastT[0].clientX; ty+=t[0].clientY-lastT[0].clientY; applyT();
  } else if(t.length>=2&&lastT.length>=2){
    const d0=Math.hypot(lastT[1].clientX-lastT[0].clientX,lastT[1].clientY-lastT[0].clientY);
    const d1=Math.hypot(t[1].clientX-t[0].clientX,t[1].clientY-t[0].clientY);
    if(d0>0) zoomAt((t[0].clientX+t[1].clientX)/2,(t[0].clientY+t[1].clientY)/2,d1/d0);
  }
  lastT=t;
},{passive:false});
canvas.addEventListener('touchend',()=>{lastT=null;},{passive:true});

// ── Eye buttons — hold to reveal highlights ───────────────
function makeEyeButton(btnId,openId,closedId,applyFn,removeFn){
  const btn=document.getElementById(btnId);
  if(!btn) return;
  const og=document.getElementById(openId), cg=document.getElementById(closedId);
  function show(){ if(og) og.setAttribute('display',''); if(cg) cg.setAttribute('display','none'); applyFn(); }
  function hide(){ if(og) og.setAttribute('display','none'); if(cg) cg.setAttribute('display',''); removeFn(); }
  btn.addEventListener('mousedown',e=>{ e.preventDefault(); show(); });
  btn.addEventListener('mouseup',()=>hide());
  btn.addEventListener('mouseleave',()=>hide());
  btn.addEventListener('touchstart',e=>{ e.preventDefault(); show(); },{passive:false});
  btn.addEventListener('touchend',()=>hide());
  btn.addEventListener('touchcancel',()=>hide());
  if(og) og.setAttribute('display','none');
  if(cg) cg.setAttribute('display','');
}
function applyImportHighlight(){
  const codes=new Set(importedAssets.map(a=>a.spaceNumber));
  wrap.querySelectorAll('path.floor-plan-space').forEach(p=>{ const c=getRoomCode(p); if(c&&codes.has(c)) p.classList.add('fp-imported'); });
}
function removeImportHighlight(){ wrap.querySelectorAll('.fp-imported').forEach(p=>p.classList.remove('fp-imported')); }
function applyDiscoHighlight(){
  const codes=new Set(newAssets.map(a=>a.spaceNumber));
  wrap.querySelectorAll('path.floor-plan-space').forEach(p=>{ const c=getRoomCode(p); if(c&&codes.has(c)) p.classList.add('fp-disco'); });
}
function removeDiscoHighlight(){ wrap.querySelectorAll('.fp-disco').forEach(p=>p.classList.remove('fp-disco')); }
makeEyeButton('btnEyeImports','eye-imports-open','eye-imports-closed',applyImportHighlight,removeImportHighlight);
makeEyeButton('btnEyeDisco','eye-disco-open','eye-disco-closed',applyDiscoHighlight,removeDiscoHighlight);

// Derive the room code a marker is currently sitting in
function getRoomFromMarker(m){
  if(!m) return null;
  let found=null;
  wrap.querySelectorAll('path.floor-plan-space').forEach(p=>{
    const rc=getRoomCode(p); if(!rc) return;
    const r=p.getBoundingClientRect();
    const cr=canvas.getBoundingClientRect();
    const wx1=(r.left-cr.left-tx)/scale, wy1=(r.top-cr.top-ty)/scale;
    const wx2=(r.right-cr.left-tx)/scale, wy2=(r.bottom-cr.top-ty)/scale;
    if(m.x>=wx1&&m.x<=wx2&&m.y>=wy1&&m.y<=wy2) found=rc;
  });
  return found;
}

// Precise polygon hit-test: is the marker (in world px) inside the given room path?
// Uses SVG's native isPointInFill via screen-coordinate conversion.
function isMarkerInRoom(m, roomPath){
  if(!m || !roomPath) return false;
  try{
    const cr=canvas.getBoundingClientRect();
    // Marker world px → screen px (same transform as renderMarkers)
    const screenX = cr.left + tx + m.x * scale;
    const screenY = cr.top  + ty + m.y * scale;
    // Screen px → path's local SVG coord system
    const svg = roomPath.ownerSVGElement;
    if(!svg) return false;
    const pt = svg.createSVGPoint();
    pt.x = screenX; pt.y = screenY;
    const ctm = roomPath.getScreenCTM();
    if(!ctm) return false;
    const localPt = pt.matrixTransform(ctm.inverse());
    // SVGGeometryElement.isPointInFill expects a DOMPoint in the element's local coords
    return roomPath.isPointInFill(localPt);
  } catch { return false; }
}

// ── Survey diff builder (shared between Advanced modal export + any future callers) ──
function buildSurveyDiff(){
  // Storey identity for the export's filename — uses the same building.floor
  // derivation as the rest of the app (skipping wing).
  const storeyId = importedAssets[0]?.spaceNumber
    ? floorPrefix(importedAssets[0].spaceNumber)
    : 'unknown';
  const confirmed=[];
  const relocated=[];
  const offmap=[];
  const stored=[];
  const gone=[];

  // Helper: baseline fields carried on every imported-asset record.
  const baseFields=(a,s)=>({
    id: a.assetId,
    type: a.equipType||null,
    original_model: a.model||null,
    corrected_model: s?.customName||null,
    space_name: a.spaceName||null,
    serial_number: a.serialNumber||null,
    details: a.details||{},
  });

  // Helper: room-relative fields carried on every marker-tied record.
  // m.roomX/Y are SVG-internal units offset from the room polygon's bbox
  // top-left.
  const roomFields=(m)=>({
    room_x: (m && m.roomX != null) ? +m.roomX.toFixed(3) : null,
    room_y: (m && m.roomY != null) ? +m.roomY.toFixed(3) : null,
  });

  importedAssets.forEach(a=>{
    const idStr=String(a.assetId);
    const s=getAssetStatus(idStr);
    if(!s) return;
    const m=markerForAsset(idStr);
    const status=s.status;
    if(status==='confirmed'){
      const room=s.room||(m?getRoomFromMarker(m):null)||a.spaceNumber||'unknown';
      const x=m?Math.round(m.x):null;
      const y=m?Math.round(m.y):null;
      confirmed.push({...baseFields(a,s), original_room:a.spaceNumber||null, current_room:room, x, y, ...roomFields(m)});
    }
    else if(status==='relocated'){
      const to=s.room||(m?getRoomFromMarker(m):null)||'unknown';
      const x=m?Math.round(m.x):null;
      const y=m?Math.round(m.y):null;
      relocated.push({...baseFields(a,s), from:a.spaceNumber||null, to, x, y, ...roomFields(m)});
    }
    else if(status==='offmap'){
      offmap.push({...baseFields(a,s), from:a.spaceNumber||null, location_hint:s.offmapLocation||null});
    }
    else if(status==='stored'){
      stored.push({...baseFields(a,s), from:a.spaceNumber||null, location:s.storageLocation||'unknown'});
    }
    else if(status==='gone'){
      gone.push({...baseFields(a,s), from:a.spaceNumber||null});
    }
  });

  // Newcomers — no "original" values, only the surveyor's input.
  const newcomers=newAssets.map(a=>{
    const m=newcomerMarkerFor(a.assetId);
    return {
      id: a.assetId,
      type: a.equip||null,
      model: a.label||null,
      room: a.spaceNumber||null,
      x: m?Math.round(m.x):null,
      y: m?Math.round(m.y):null,
      ...roomFields(m),
      serial_number: a.serialNumber||null,
      details: a.details||{},
    };
  });

  return {
    floor: storeyId,
    surveyed_at: new Date().toISOString(),
    confirmed,
    relocated,
    offmap,
    stored,
    gone,
    newcomers
  };
}

function downloadSurveyDiff(){
  const payload=buildSurveyDiff();
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='survey_diff_'+payload.floor+'_'+Date.now()+'.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}

// ── Excel export ─────────────────────────────────────────
// Single sheet, one row per imported asset + one row per newcomer.
// Columns shaped for round-trip: a future importer can consume this file.
function buildSurveyExcelRows(){
  const rows=[];

  // Detail-column spec — same labels the importer reads. Order matters
  // for column placement in the output sheet. Each row gets these
  // columns whether it's an import or a newcomer; empty if no value.
  const DETAIL_COLS = [
    ['Date in Operation',     'dateInOperation'    ],
    ['Date of Replacement',   'dateOfReplacement'  ],
    ['Costs',                 'costs'              ],
    ['IP Address',            'ipAddress'          ],
    ['Mac Address',           'macAddress'         ],
    ['Hostname',              'hostname'           ],
    ['Main Firmware',         'firmware'           ],
    ['Main Firmware Installed On', 'firmwareInstalledOn'],
    ['Outlet',                'outlet'             ],
    ['Switch port info',      'switchPortInfo'     ],
    ['Staging',               'staging'            ],
    ['Comments',              'comments'           ],
  ];
  // Build a {col: value} map from a details bundle. Missing keys become
  // empty strings (xlsx wants strings/primitives, not undefined).
  const detailColsFrom = (d)=>{
    const out={};
    DETAIL_COLS.forEach(([col,key])=>{ out[col] = (d && d[key]) || ''; });
    return out;
  };

  importedAssets.forEach(a=>{
    const idStr=String(a.assetId);
    const s=getAssetStatus(idStr);
    const m=markerForAsset(idStr);
    const status=s?.status||'';
    // current_room: for confirmed/relocated comes from status or marker, else blank
    let currentRoom='';
    if(status==='confirmed'||status==='relocated'){
      currentRoom=s?.room||(m?getRoomFromMarker(m):null)||a.spaceNumber||'';
    }
    const x=m?Math.round(m.x):'';
    const y=m?Math.round(m.y):'';
    const roomX=(m&&m.roomX!=null)?+m.roomX.toFixed(3):'';
    const roomY=(m&&m.roomY!=null)?+m.roomY.toFixed(3):'';
    rows.push({
      'Asset ID': a.assetId,
      'Source': 'imported',
      'Equipment Type': a.equipType||'',
      'Original model name': a.model||'',
      'Found model name': s?.customName||'',
      'Space Name': a.spaceName||'',
      'Original Room': a.spaceNumber||'',
      'Current Room': currentRoom,
      'Status': status,
      'Storage Location': status==='stored' ? (s?.storageLocation||'') : '',
      'Off-map Location': status==='offmap'  ? (s?.offmapLocation||'')  : '',
      'X': x,
      'Y': y,
      'Room X': roomX,
      'Room Y': roomY,
      'Sn': a.serialNumber||'',
      ...detailColsFrom(a.details),
    });
  });

  newAssets.forEach(a=>{
    const m=newcomerMarkerFor(a.assetId);
    const roomX=(m&&m.roomX!=null)?+m.roomX.toFixed(3):'';
    const roomY=(m&&m.roomY!=null)?+m.roomY.toFixed(3):'';
    rows.push({
      'Asset ID': a.assetId,
      'Source': 'newcomer',
      'Equipment Type': a.equip||'',
      'Original model name': '',
      'Found model name': a.label||'',
      'Space Name': '',
      'Original Room': '',
      'Current Room': a.spaceNumber||'',
      'Status': 'newcomer',
      'Storage Location': '',
      'Off-map Location': '',
      'X': m?Math.round(m.x):'',
      'Y': m?Math.round(m.y):'',
      'Room X': roomX,
      'Room Y': roomY,
      'Sn': a.serialNumber||'',
      ...detailColsFrom(a.details),
    });
  });

  return rows;
}

function downloadSurveyExcel(){
  const rows=buildSurveyExcelRows();
  if(rows.length===0){ showFpToast('Nothing to export',true); return; }

  const ws=XLSX.utils.json_to_sheet(rows);

  // Auto-size columns based on longest cell in each
  const cols=Object.keys(rows[0]);
  ws['!cols']=cols.map(col=>{
    const headerLen=col.length;
    const maxValLen=rows.reduce((m,r)=>Math.max(m,String(r[col]||'').length),0);
    return { wch: Math.min(40, Math.max(headerLen, maxValLen)+2) };
  });

  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Survey');

  // Filename: "<storey>_survey.xlsx" — flat, matches convention
  const storey=__safeStorey;
  const safeN=s=>String(s||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim()||'floorplan';
  const fname=(storey?safeN(storey):safeN(document.title))+'_survey.xlsx';

  XLSX.writeFile(wb,fname);
  showFpToast(`✓ Exported ${rows.length} rows → ${fname}`);
}

// ── Panel toggle ──────────────────────────────────────────
const sidePanel = document.getElementById('side-panel');
const fabPanelToggle = document.getElementById('fab-panel-toggle');

function setPanelOpen(open){
  sidePanel.classList.toggle('open',open);
  document.body.classList.toggle('panel-open',open);
  fabPanelToggle.classList.toggle('active',open);
  // Re-fit after panel transition
  setTimeout(fitToView,220);
}
fabPanelToggle.addEventListener('click',()=>setPanelOpen(!sidePanel.classList.contains('open')));

// Panel tabs — single source of truth for switching between Imports/New/Movers.
function setActiveTab(which){
  document.querySelectorAll('.panel-tab').forEach(t=>{
    t.classList.toggle('active', t.dataset.tab===which);
  });
  document.getElementById('panel-body-assets').classList.toggle('hidden',which!=='assets');
  document.getElementById('panel-body-new').classList.toggle('hidden',which!=='new');
  document.getElementById('panel-body-movers').classList.toggle('hidden',which!=='movers');
}
document.querySelectorAll('.panel-tab').forEach(tab=>{
  tab.addEventListener('click',()=>setActiveTab(tab.dataset.tab));
});

// Drive the right panel to a specific asset row: switch to whichever tab
// owns it, expand the parent room-group, scroll the row into view, flash it.
//
// Tab choice is driven by the asset's current status:
//   - relocated/offmap/stored/gone  → Movers
//   - newcomer                       → Newcomers
//   - everything else                → Imports
function jumpPanelToAsset(assetId){
  const idStr=String(assetId);
  const saved=getAssetStatus(idStr);
  const isMoved = !!(saved && ['relocated','offmap','stored','gone'].includes(saved.status));
  const isNewcomer = newAssets.some(a=>String(a.assetId)===idStr);
  const tab = isMoved ? 'movers'
            : isNewcomer ? 'new'
            : 'assets';
  const panelId = tab==='new'    ? 'panel-body-new'
                : tab==='movers' ? 'panel-body-movers'
                                 : 'panel-body-assets';
  setActiveTab(tab);
  setTimeout(()=>{
    const panel=document.getElementById(panelId);
    if(!panel) return;
    const target=panel.querySelector(`.asset-item[data-assetid="${CSS.escape(idStr)}"]`);
    if(!target) return;
    const grp=target.closest('.room-group');
    if(grp && !grp.classList.contains('open')){
      panel.querySelectorAll('.room-group').forEach(g=>g.classList.remove('open'));
      grp.classList.add('open');
    }
    target.scrollIntoView({block:'nearest',behavior:'smooth'});
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  },80);
}





const btnPlaceMarker = document.getElementById('btnPlaceMarker');
function setUIMode(mode){
  placingMode=false;
  btnPlaceMarker.classList.remove('active');
  canvas.classList.remove('placing','snipping','moving-marker');
  if(mode==='placing'){
    placingMode=true;
    btnPlaceMarker.classList.add('active');
    canvas.classList.add('placing');
  } else if(mode==='moving'){
    btnPlaceMarker.classList.add('active');
    canvas.classList.add('moving-marker');
  } else if(mode==='snipping'){
    canvas.classList.add('snipping');
  }
}
function setPlacingMode(on){
  if(!on){
    selectedAssetId=null;
  }
  setUIMode(on?'placing':'none');
}
btnPlaceMarker.addEventListener('click',()=>{
  const btnSnipEl=document.getElementById('btnSnip');
  if(btnSnipEl) btnSnipEl.classList.remove('active');
  setPlacingMode(!placingMode);
});

canvas.addEventListener('click',e=>{
  if(!placingMode||hasDragged) return;
  const pos=clientToWorld(e.clientX,e.clientY);
  const hitPath=e.target.closest('path.floor-plan-space');
  pendingRoomCode=hitPath?getRoomCode(hitPath):null;

  // Draft newcomer (new + flow) — user clicked Set position from a blank
  // newcomer modal. Click here = auto-save: generate ID, push newAssets
  // entry, push markers entry. The modal does NOT reopen — same auto-save
  // model the imported flow uses.
  if(draftNcomerActive && draftNcomerData){
    const {name, serial='', equip, details={}} = draftNcomerData;
    if(!name){
      // Defensive — Set position now gates on name, so this branch
      // shouldn't fire. Bail silently if state was tampered with.
      draftNcomerActive=false;
      draftNcomerData=null;
      setPlacingMode(false);
      return;
    }
    const newId = nextNewcomerId();
    const room = pendingRoomCode || (hitPath ? getRoomCode(hitPath) : null);
    newAssets.push({
      assetId: newId,
      label: name,
      equip,
      spaceNumber: room || 'Unknown',
      spaceName: '',
      serialNumber: serial,
      details,
      checked: false
    });
    const m = {
      id: Date.now().toString(),
      x: pos.x, y: pos.y,
      equip,
      label: name,
      assetId: newId,
      isNew: true
    };
    setMarkerRoomCoords(m, hitPath);
    markers.push(m);
    commit();
    focusAfterMarkerAction(hitPath, newId);
    if(!hitPath && selectedPath) showInfoBar(selectedPath);
    showFpToast(`✓ Added ${newId}`);
    draftNcomerActive=false;
    draftNcomerData=null;
    setPlacingMode(false);
    return;
  }

  // Position-from-Imports flow — user clicked "Position" in the marker-edit
  // modal for an imported asset. Place the marker directly with derived
  // status (confirmed if room matches its registered room, relocated if not).
  // No confirmation modal: nothing to confirm — type/name come from the import.
  if(selectedAssetId){
    const aid=selectedAssetId;
    const ia=assetById(aid);
    if(ia){
      pushUndoSnapshot(aid);
      placeImportedMarker(ia, pos.x, pos.y, pendingRoomCode,
                          derivedStatus(pendingRoomCode, ia.spaceNumber), true);
      commit();
      // Highlight the room and jump the panel to the asset's row.
      focusAfterMarkerAction(hitPath, aid);
      if(!hitPath && selectedPath) showInfoBar(selectedPath);
      showFpToast(`✓ Placed ${aid}`);
    }
    selectedAssetId=null;
    setPlacingMode(false);
    return;
  }

  // Place-marker fallback (toolbar Place marker button) — opens the asset
  // editor at this position. Refuse clicks outside any room: a marker
  // attached to "the unknown" can't be located later. Stay in placing
  // mode so the user can try again on a real room.
  if(!hitPath || !pendingRoomCode){
    showFpToast('Click inside a room to place the marker',true);
    return;
  }
  openAssetEditor({pos});
});

// ── Room code helpers ─────────────────────────────────────
// Every room polygon has data-room-code set at SVG-load time (see
// tagRoomsByCode above). These helpers all read from that attribute,
// keeping AVScout decoupled from the source-format-specific schema
// (Stipl's ifcguid, future PDF→SVG converter's whatever).
function pathId(path){
  return (path && path.getAttribute('data-room-code')) || '';
}
function getRoomCode(path){
  return path ? path.getAttribute('data-room-code') : null;
}
function findPathByRoomCode(code){
  if(!code) return null;
  // Room codes are alphanumeric + dots, safe to embed in attribute selector
  // when wrapped in quotes. No characters in the code need CSS escaping.
  return wrap.querySelector('[data-room-code="'+code.replace(/"/g,'')+'"]');
}

// ── Info bar ──────────────────────────────────────────────
function markersInRoom(pathEl){
  if(!pathEl) return [];
  // Polygon-precise: matches the room's actual shape, not just its bounding box.
  // Falls back to the bbox test if isMarkerInRoom fails for any reason.
  try{
    return markers.filter(m=>isMarkerInRoom(m,pathEl));
  }catch(err){
    try{
      const pathRect=pathEl.getBoundingClientRect();
      const canvRect=canvas.getBoundingClientRect();
      const wx1=(pathRect.left-canvRect.left-tx)/scale;
      const wy1=(pathRect.top-canvRect.top-ty)/scale;
      const wx2=(pathRect.right-canvRect.left-tx)/scale;
      const wy2=(pathRect.bottom-canvRect.top-ty)/scale;
      return markers.filter(m=>m.x>=wx1&&m.x<=wx2&&m.y>=wy1&&m.y<=wy2);
    }catch(err2){return [];}
  }
}
function showInfoBar(path){
  const roomCode=getRoomCode(path);
  if(!path||!roomCode){
    infobar.classList.add('empty');
    infoEmpty.style.display=''; infoRoom.style.display='none';
    infoDevices.style.display='none'; infoVisited.style.display='none';
    const _wrap=document.getElementById('info-unlinked-wrap');
    if(_wrap) _wrap.style.display='none';
    return;
  }
  infobar.classList.remove('empty');
  infoEmpty.style.display='none';
  infoRoomCode.textContent=roomCode;
  // Show space name from imported Excel data if available
  const importedRoom=importedAssets.find(a=>a.spaceNumber===roomCode);
  if(importedRoom&&importedRoom.spaceName){
    infoRoomSpaceName.textContent=importedRoom.spaceName;
    infoRoomSpaceName.style.display='flex';
  } else {
    infoRoomSpaceName.style.display='none';
  }
  infoRoomLink.href='https://tudesc.com/admin/data/educationspace/?q='+encodeURIComponent(roomCode);
  infoRoom.style.display='flex';
  const mInRoom=markersInRoom(path);
  // Acknowledged-without-marker: imports with status=confirmed pinned to this
  // room but no placed marker. They still count as "Found" in this room.
  const ackedHere=importedAssets.filter(a=>{
    const s=getAssetStatus(String(a.assetId));
    if(!s||s.status!=='confirmed') return false;
    if(s.room!==roomCode) return false;
    // Exclude the ones that already have a marker (those are in mInRoom).
    const hasMarker=markers.some(m=>String(m.assetId)===String(a.assetId)&&!m.isNew);
    return !hasMarker;
  });
  const totalCount=mInRoom.length + ackedHere.length;
  if(totalCount>0){
    const counts={};
    mInRoom.forEach(m=>{ const k=m.equip||'displays'; counts[k]=(counts[k]||0)+1; });
    ackedHere.forEach(a=>{ const k=a.equipType||'displays'; counts[k]=(counts[k]||0)+1; });
    const chipsHtml=Object.entries(counts).map(([k,n])=>{
      const t=EQUIP.find(t=>t.v===k)||{e:'📍',l:k};
      return `<div class="dev-chip"><span class="emoji">${t.e}</span><span>${escHtml(t.l)}</span><span class="count">${n}</span></div>`;
    }).join('');
    infoDevices.innerHTML='<span class="info-devices-label">Found</span>'+chipsHtml;
    infoDevices.style.display='flex';
  } else {
    infoDevices.innerHTML='<span class="info-devices-label">Found</span><span style="font-size:10px;color:var(--panel-muted);font-style:italic;">no devices</span>';
    infoDevices.style.display='flex';
  }
  infoVisited.style.display=path.classList.contains('fp-visited')?'flex':'none';
  // Action wrap: always visible when a room is selected (TUDesc link works for any room).
  // Examine button is shown only when this room has imported assets.
  const hasImportedAssets=importedAssets.some(a=>a.spaceNumber===roomCode);
  const infoUnlinkedWrap=document.getElementById('info-unlinked-wrap');
  infoUnlinkedWrap.style.display='flex';
  const examineBtn=document.getElementById('btn-acknowledge-all');
  if(examineBtn) examineBtn.style.display = hasImportedAssets ? 'inline-flex' : 'none';
}

// ── Room interactions ─────────────────────────────────────
function selectRoom(path){
  if(selectedPath&&selectedPath!==path){
    selectedPath.classList.remove('fp-selected');
    selectedPath.style.fill='';
  }
  if(!path){ selectedPath=null; showInfoBar(null); return; }
  path.classList.add('fp-selected');
  selectedPath=path;
  showInfoBar(path);
  // NB: selectRoom no longer drives the right panel. Map clicks just
  // highlight the room — the panel is reserved for explicit user actions
  // (clicking an asset row, performing a marker action, etc.) so they
  // don't lose context to a passive map click.
}

// Combined behaviour after a marker action (place/reposition/address):
// highlight the destination room on the map AND drive the panel to the
// asset's row. Tab choice is jumpPanelToAsset's responsibility now.
function focusAfterMarkerAction(path, assetId){
  if(path) selectRoom(path);
  if(assetId) jumpPanelToAsset(assetId);
}

wrap.addEventListener('click',e=>{
  if(placingMode||movingMarkerId||hasDragged) return;
  if(canvas.classList.contains('snipping')) return; // snip mode owns clicks
  if(suppressNextClick){ suppressNextClick=false; return; }
  const path=e.target.closest('path.floor-plan-space');
  if(!path) return;
  if(selectedPath===path){ selectRoom(null); return; }
  selectRoom(path);
});
wrap.addEventListener('dblclick',e=>{
  if(placingMode||movingMarkerId) return;
  if(canvas.classList.contains('snipping')) return; // snip mode owns clicks
  const path=e.target.closest('path.floor-plan-space');
  if(!path) return;
  e.preventDefault();
  const pid=pathId(path);
  if(path.classList.contains('fp-visited')){
    path.classList.remove('fp-visited');
    visited=visited.filter(id=>id!==pid);
  } else {
    path.classList.add('fp-visited');
    if(pid&&!visited.includes(pid)) visited.push(pid);
  }
  saveToStorage();
  if(selectedPath!==path){ selectRoom(path); } else { showInfoBar(path); }
  renderPanel();
});

// ── Markers ───────────────────────────────────────────────
function renderMarkers(){
  world.querySelectorAll('.marker').forEach(el=>el.remove());
  const fs=markerFontSize()+'px';
  markers.forEach(m=>{
    const el=document.createElement('div');
    el.className='marker'; el.dataset.id=m.id;
    el.style.left=m.x+'px'; el.style.top=m.y+'px';
    el.style.fontSize=fs;
    const labelColor=m.isNew?'#ff47c2':'#47c2ff';
    const labelText=m.assetId?String(m.assetId):(m.label||'');
    el.innerHTML=`<span class="marker-emoji">${equipEmoji(m.equip||'displays')}</span>
      ${labelText?`<div class="marker-label" style="color:${labelColor}">${escHtml(labelText)}</div>`:''}
    `;
    el.addEventListener('click',ev=>{
      ev.stopPropagation();
      if(movingMarkerId) return;
      if(placingMode) return;
      // Open the modal AND drive the right panel to this asset's row so the
      // user can see context behind the modal.
      if(m.assetId) jumpPanelToAsset(m.assetId);
      openAssetEditor({markerId:m.id});
    });
    world.appendChild(el);
  });
}
function applyVisited(){
  // visited[] now stores room codes (e.g. "08.03.01.010"). Lookup is a
  // direct attribute selector. Legacy ifcguid entries from older builds
  // are wiped at load-time (see VISITED_SCHEMA_VERSION).
  visited.forEach(code=>{
    if(!code) return;
    const el = findPathByRoomCode(code);
    if(el) el.classList.add('fp-visited');
  });
}

// ── Modal ─────────────────────────────────────────────────
const modalOverlay   = document.getElementById('modalOverlay');
const modalName      = document.getElementById('modalName');
const modalSerial    = document.getElementById('modalSerial');
const modalEquip     = document.getElementById('modalEquip');
const modalCog       = document.getElementById('modalCog');
const modalDetails   = document.getElementById('modalDetails');
const modalDetailsList = document.getElementById('modalDetailsList');

// Serial number used to live in a dedicated input above the equipment
// field. It now lives entirely inside the details drawer, so these two
// helpers — kept because many call sites still invoke them — are no-ops.
// Safe to delete in a future cleanup pass.
function showSerialEditable(_value){ /* no-op: handled by drawer */ }
function hideSerialField(){ /* no-op: handled by drawer */ }

// ── Details drawer ────────────────────────────────────────
// Field list driven by an ordered spec — adding a field later means
// touching just this array. The 'key' matches what the Excel parser
// stores on details{} (and what newcomers can edit).
const DETAILS_FIELDS = [
  { key:'dateInOperation',    label:'Date in Operation' },
  { key:'dateOfReplacement',  label:'Date of Replacement' },
  { key:'costs',              label:'Costs' },
  { key:'serialNumber',       label:'Sn' },        // top-level on imports, also on newcomers
  { key:'ipAddress',          label:'IP Address' },
  { key:'macAddress',         label:'Mac Address' },
  { key:'hostname',           label:'Hostname' },
  { key:'firmware',           label:'Main Firmware' },
  { key:'firmwareInstalledOn',label:'Main Firmware Installed On' },
  { key:'outlet',             label:'Outlet' },
  { key:'switchPortInfo',     label:'Switch port info' },
  { key:'staging',            label:'Staging' },
  { key:'comments',           label:'Comments' },
];

// Render the details drawer for the current modal context.
//   mode='import'   → all values read-only; rows hidden when empty
//   mode='newcomer' → all values editable inputs; ALL rows shown so
//                     the user can fill them in (newcomers start blank)
//   mode='hidden'   → cog button hidden, drawer reset
//
// The 'data' parameter is the underlying object: ia.details + ia.serialNumber
// merged for imports, na.details + na.serialNumber for newcomers.
function renderDetailsDrawer(mode, data){
  if(!modalCog || !modalDetailsList) return;
  if(mode==='hidden'){
    modalCog.style.display='none';
    if(modalDetails) modalDetails.hidden = true;
    modalCog.setAttribute('aria-expanded','false');
    modalDetailsList.innerHTML='';
    return;
  }
  modalCog.style.display='inline-flex';
  modalDetailsList.innerHTML='';

  if(mode==='import'){
    // Hide the cog if the import has no detail data at all (everything
    // empty) — nothing to show, button would be misleading.
    const anyValue = DETAILS_FIELDS.some(f=>{
      const v = (f.key==='serialNumber') ? data.serialNumber : data.details?.[f.key];
      return !!(v && String(v).trim());
    });
    if(!anyValue){
      modalCog.style.display='none';
      if(modalDetails) modalDetails.hidden = true;
      modalCog.setAttribute('aria-expanded','false');
      return;
    }
    DETAILS_FIELDS.forEach(f=>{
      const v = (f.key==='serialNumber') ? data.serialNumber : data.details?.[f.key];
      if(!v || !String(v).trim()) return;
      const row = document.createElement('div');
      row.className = 'modal-details-row';
      row.innerHTML = '<div class="dl">'+escHtml(f.label)+
                      '</div><div class="dv">'+escHtml(String(v))+'</div>';
      modalDetailsList.appendChild(row);
    });
  } else {
    // newcomer: editable inputs for every field. Each input carries its
    // detail key so readDetailsFromDrawer() can map them back. The
    // serialNumber row writes to na.serialNumber (top-level), the rest
    // write to na.details.* — both handled by readDetailsFromDrawer.
    DETAILS_FIELDS.forEach(f=>{
      const v = (f.key==='serialNumber') ? data.serialNumber : data.details?.[f.key];
      const row = document.createElement('div');
      row.className = 'modal-details-row';
      row.innerHTML = '<div class="dl">'+escHtml(f.label)+
                      '</div><div class="dv">'+
                      '<input type="text" data-detail-key="'+escHtml(f.key)+'" '+
                      'value="'+escHtml(v||'')+'" maxlength="120" autocomplete="off"/>'+
                      '<div class="detail-error" data-detail-error-for="'+escHtml(f.key)+'"></div>'+
                      '</div>';
      modalDetailsList.appendChild(row);
    });
  }
}

// ── Detail-field validators ───────────────────────────────
// Each validator: (value:string) -> string|null
//   null  → valid (also: empty string is always valid; the field is
//           optional and only the format gets checked when filled in).
//   string → error message to render under the field.
//
// Date format is strict per spec: "Aug. 1, 2019" — abbreviated month
// with trailing period, day without leading zero, year. Months use the
// 3-letter US abbreviations; September is "Sep.". May has no period
// because it's already 3 letters — but the period is still required by
// the strict spec, so "May." is the canonical form here.
const MONTH_ABBRS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_IN_MONTH = [31,29,31,30,31,30,31,31,30,31,30,31]; // Feb 29 allowed; loose

function validateStrictDate(v){
  if(!v) return null;
  // Pattern: "Mon. D, YYYY" — month abbr + period + space + day (no
  // leading zero, 1-31) + comma + space + 4-digit year.
  const m = v.match(/^([A-Z][a-z]{2})\.\s(\d{1,2}),\s(\d{4})$/);
  if(!m) return 'Format: "Aug. 1, 2019"';
  const monthIdx = MONTH_ABBRS.indexOf(m[1]);
  if(monthIdx < 0) return 'Unknown month: '+m[1];
  const day = parseInt(m[2],10);
  if(day < 1 || day > DAYS_IN_MONTH[monthIdx]) return 'Invalid day for '+m[1];
  if(/^0\d$/.test(m[2])) return 'No leading zero on the day';
  return null;
}

function validateIp(v){
  if(!v) return null;
  // IPv4: four octets 0-255, dot-separated. No leading zeros (so "192.168.001.1" is rejected).
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if(!m) return 'Format: 192.168.1.1';
  for(let i=1;i<=4;i++){
    const o = m[i];
    if(o.length>1 && o[0]==='0') return 'No leading zeros in octets';
    const n = parseInt(o,10);
    if(n<0||n>255) return 'Octets must be 0-255';
  }
  return null;
}

function validateMac(v){
  if(!v) return null;
  // 6 hex pairs separated by ':' or '-' — both forms common, both accepted.
  if(!/^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/.test(v)){
    return 'Format: 01:23:45:67:89:AB';
  }
  return null;
}

function validateHostname(v){
  if(!v) return null;
  // RFC 1123: alphanumeric + dashes + dots between labels. Each label
  // 1-63 chars, must not start/end with a dash. Total length 1-253.
  if(v.length > 253) return 'Hostname too long (max 253)';
  const labels = v.split('.');
  for(const lab of labels){
    if(lab.length === 0 || lab.length > 63) return 'Each label must be 1-63 chars';
    if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)){
      return 'Invalid characters in hostname';
    }
  }
  return null;
}

function validateSerial(v){
  if(!v) return null;
  if(v.length < 4) return 'Serial too short (min 4 chars)';
  if(v.length > 32) return 'Serial too long (max 32 chars)';
  if(!/^[A-Za-z0-9_\-]+$/.test(v)) return 'Only letters, digits, dashes, underscores';
  return null;
}

// Map detail-keys to their validator. Keys not listed have no validator
// (free text — Firmware, Outlet, Switch port info, Staging, Costs, Comments).
const DETAIL_VALIDATORS = {
  serialNumber:        validateSerial,
  dateInOperation:     validateStrictDate,
  dateOfReplacement:   validateStrictDate,
  firmwareInstalledOn: validateStrictDate,
  ipAddress:           validateIp,
  macAddress:          validateMac,
  hostname:            validateHostname,
};

// Validate every input in the drawer. Renders inline errors and returns
// false if anything fails. Opens the drawer (so the user can see the
// errors) and focuses the first failing input. Returns true when clean
// (or when the drawer isn't visible — imports aren't validated here).
function validateDrawer(){
  if(!modalDetailsList) return true;
  // Clear previous errors first
  modalDetailsList.querySelectorAll('.detail-error').forEach(el=>{
    el.textContent=''; el.classList.remove('show');
  });
  modalDetailsList.querySelectorAll('input[data-detail-key]').forEach(inp=>{
    inp.classList.remove('invalid');
  });

  let firstBad = null;
  modalDetailsList.querySelectorAll('input[data-detail-key]').forEach(inp=>{
    const k = inp.getAttribute('data-detail-key');
    const v = (inp.value||'').trim();
    const fn = DETAIL_VALIDATORS[k];
    if(!fn) return;
    const err = fn(v);
    if(err){
      inp.classList.add('invalid');
      const errEl = modalDetailsList.querySelector('[data-detail-error-for="'+k+'"]');
      if(errEl){ errEl.textContent = err; errEl.classList.add('show'); }
      if(!firstBad) firstBad = inp;
    }
  });

  if(firstBad){
    // Open the drawer so the user can see the inline errors
    if(modalDetails && modalDetails.hidden){
      modalDetails.hidden = false;
      if(modalCog) modalCog.setAttribute('aria-expanded','true');
    }
    firstBad.focus();
    return false;
  }
  return true;
}

// Read all editable inputs in the drawer. Returns {serialNumber, details}
// — serialNumber is split out because it lives on the asset object's
// top level, not inside the details bundle. Used by the Save handlers
// when persisting newcomer changes.
function readDetailsFromDrawer(){
  const out = { serialNumber: '', details: {} };
  if(!modalDetailsList) return out;
  modalDetailsList.querySelectorAll('input[data-detail-key]').forEach(inp=>{
    const k = inp.getAttribute('data-detail-key');
    const v = (inp.value||'').trim();
    if(!k) return;
    if(k==='serialNumber') out.serialNumber = v;
    else out.details[k] = v;
  });
  return out;
}

// Toggle drawer visibility — wired to the cog button. Persists across
// open/close of the modal? No — every modal open resets the drawer's
// expanded state to closed via render*. This handler only toggles
// within an open session.
if(modalCog){
  modalCog.addEventListener('click',()=>{
    if(!modalDetails) return;
    const wasOpen = !modalDetails.hidden;
    modalDetails.hidden = wasOpen;
    modalCog.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
  });
}

// Clear inline error + invalid styling on the next keystroke. Re-validation
// happens on Save attempt. Delegated listener so it works for inputs that
// are added/removed when the drawer re-renders for different assets.
if(modalDetailsList){
  modalDetailsList.addEventListener('input',(e)=>{
    const inp = e.target.closest('input[data-detail-key]');
    if(!inp) return;
    inp.classList.remove('invalid');
    const k = inp.getAttribute('data-detail-key');
    const errEl = modalDetailsList.querySelector('[data-detail-error-for="'+k+'"]');
    if(errEl){ errEl.textContent=''; errEl.classList.remove('show'); }
  });
}
const modalTitleEl   = document.getElementById('modalTitle');
const modalEl        = document.querySelector('#modalOverlay .modal');
const btnConfirm     = document.getElementById('btnModalConfirm');
const btnCancel      = document.getElementById('btnModalCancel');
const btnDelete      = document.getElementById('btnDeleteMarker');
const btnMove        = document.getElementById('btnMoveMarker');
const btnMoveNcomer  = document.getElementById('btnMoveMarkerNcomer');
const btnPositionMarker = document.getElementById('btnPositionMarker');
const btnRevertName  = document.getElementById('btnRevertName');

// Marker-jump button inside the modal title (built dynamically by
// buildLocationBadges when a marker exists). Closes the modal and
// zooms the canvas to the marker.
modalTitleEl.addEventListener('click',e=>{
  const btn = e.target.closest('.loc-badge-jump');
  if(!btn) return;
  e.stopPropagation();
  const mid = btn.dataset.markerId;
  if(!mid) return;
  closeModal();
  jumpToMarker(mid);
});

// Show revert button when name differs from original
let modalOriginalName = '';
modalName.addEventListener('input',()=>{
  if(btnRevertName.classList.contains('show')||modalOriginalName){
    btnRevertName.classList.toggle('show', modalName.value.trim()!==modalOriginalName);
  }
  updateConfirmEnabled();
});

// Toggles whether the Locate-by sub-form is visible. The rule:
//   show iff the asset has an identity to attach a location to.
// For imports, identity is fixed (the import provides it), so the gate
// auto-passes. For newcomers in draft mode, identity = a non-empty name.
// For newcomers in edit mode (existing entry), the saved name fills the
// field on open, so the gate also auto-passes from the start.
function updateLocateBySectionVisibility(){
  if(!modalEl) return;
  // Only newcomer mode ever needs to hide; imported flow is always shown.
  if(!modalEl.classList.contains('modal-newcomer-mode')){
    modalEl.classList.remove('locate-by-hidden');
    return;
  }
  const hasName = !!(modalName?.value||'').trim();
  modalEl.classList.toggle('locate-by-hidden', !hasName);
}

// Disable Save when there's nothing to commit. Only relevant in the
// panel-only path (imported asset with no marker, no placement happening) —
// other modes always have something to save (placing a marker, editing an
// existing marker's properties).
function updateConfirmEnabled(){
  // Toggle Locate-by visibility on every state change. Cheap, and keeps
  // the rule centralised: hide when the asset has no identity yet
  // (newcomer with no name typed), show otherwise.
  updateLocateBySectionVisibility();

  // Draft newcomer (new + flow): Save requires a name AND either a
  // valid room or a marker (the marker path auto-saves on map click,
  // so in practice this branch enforces "name + valid room"). Strict
  // mode — no half-formed newcomers.
  if(draftNcomerActive){
    const hasName = !!(modalName?.value||'').trim();
    const typedRoom = (locInput?.value||'').trim();
    const hasValidRoom = !!typedRoom && allRoomCodes().includes(typedRoom);
    btnConfirm.disabled = !(hasName && hasValidRoom);
    return;
  }

  // Place-marker mode: triggered from the toolbar Place marker button →
  // map click → fresh placement (no marker, no asset). The "create new"
  // sub-mode requires a name; the "link to existing import" sub-mode
  // gets its name from the import (controlled by the asset picker).
  // Room is already enforced at click time (refused outside any room).
  if(pendingPos && !editingId && !panelAssetId){
    if(modalMode==='link'){
      // Link mode: Save commits the picked import. Enabled iff a row is
      // selected. selectedAssetId tracks the picker's choice.
      btnConfirm.disabled = !selectedAssetId;
    } else {
      // Create-new mode: name must be non-empty.
      const hasName = !!(modalName?.value||'').trim();
      btnConfirm.disabled = !hasName;
    }
    return;
  }
  // Default: enabled
  if(!(panelAssetId && !editingId && !pendingPos)){
    btnConfirm.disabled=false;
    return;
  }
  const renameChanged = modalName.value.trim() !== modalOriginalName;
  const hasStatus = !!surveyStatus;

  // For "In room": the typed value must match a real room code. If the
  // user typed something bogus and didn't pick from the dropdown, Save is
  // disabled so they don't silently commit the previously-staged room.
  if(surveyStatus==='confirmed'){
    const typed=(locInput.value||'').trim();
    const isValid = typed===locStagedRoom || allRoomCodes().includes(typed);
    if(!isValid){ btnConfirm.disabled=true; return; }
  }

  // For "In room" with a saved status, picking a different room counts
  // as a change worth committing.
  const roomChanged = surveyStatus==='confirmed' && locStagedRoom && locStagedRoom!==locSavedRoom;
  // For unreviewed assets with no saved status, simply picking a status
  // without anything else is also a commit-worthy action.
  const saved = locAssetId ? getAssetStatus(locAssetId) : null;
  const wasReviewed = !!(saved && saved.status);
  const statusChanged = hasStatus && (
    !wasReviewed ||                             // was unreviewed, picked something
    (saved.status!==surveyStatus && !(surveyStatus==='confirmed' && (saved.status==='confirmed'||saved.status==='relocated')))
                                                // status family changed
  );
  btnConfirm.disabled = !(renameChanged || statusChanged || roomChanged);
}
const modalModeToggle   = document.getElementById('modalModeToggle');
const modalLinkSection  = document.getElementById('modalLinkSection');
const modalNewSection   = document.getElementById('modalNewSection');
const modalSurveySection= document.getElementById('modalSurveySection');
const btnModeLink       = document.getElementById('modalModeLink');
const btnModeNew        = document.getElementById('modalModeNew');
const modalAssetList    = document.getElementById('modal-asset-list');
const modalNoAssets     = document.getElementById('modal-no-assets');

// ── Location section refs + state ─────────────────────────
const locInput             = document.getElementById('locInput');
const locChevron           = document.getElementById('locChevron');
const locDropdown          = document.getElementById('locDropdown');
const lbTabRoom            = document.getElementById('lbTabRoom');
const lbTabMarker          = document.getElementById('lbTabMarker');
const btnRemoveMarker      = document.getElementById('btnRemoveMarker');
const locConfirm           = document.getElementById('locConfirm');

// Asset that the location fields are currently targeting.
let locAssetId=null;
// Saved (committed) room — what's actually in storage right now.
let locSavedRoom=null;
// Staged room — what the user has chosen in the form, not yet committed.
// Save commits stagedRoom (and optionally drops the marker).
let locStagedRoom=null;
// True if the user staged a room change while a marker exists, AND has
// confirmed they want the marker removed on Save.
let locStagedRemoveMarker=false;
// Whether the asset has a marker right now (committed state).
let locHasMarker=false;

// ── Survey status interaction ──────────────────────────────
let surveyStatus=null;       // 'confirmed'|'relocated'|'offmap'|'stored'|'gone'
let surveyStorageLoc=null;   // 'av_storage'|'faculty_storage'
let surveyOffmapLoc='';      // free text location hint for offmap

function setSurveyStatus(status){
  surveyStatus=status;
  if(!status){
    document.querySelectorAll('.survey-opt').forEach(el=>el.className='survey-opt');
    const storageOpts=document.getElementById('surveyStorageOpts');
    if(storageOpts) storageOpts.className='survey-storage-opts';
    const offmapOpts=document.getElementById('surveyOffmapOpts');
    if(offmapOpts) offmapOpts.className='survey-storage-opts';
    // Also collapse the "In a room" sub-form. Without this, the previously
    // open sub-form keeps its .show class after a Clear+reopen, leaving
    // tabs / typeahead / position button visible even though no status
    // is selected.
    const inRoomOpts=document.getElementById('surveyInRoomOpts');
    if(inRoomOpts) inRoomOpts.className='survey-storage-opts';
    surveyStorageLoc=null;
    surveyOffmapLoc='';
    getOffmapSegs().forEach(s=>{ if(s){ s.value=''; s.classList.remove('invalid'); } });
    if(typeof hideLocDropdown==='function') hideLocDropdown();
    if(typeof hideLocConfirm==='function') hideLocConfirm();
    return;
  }
  if(status!=='stored') surveyStorageLoc=null;
  if(status!=='offmap') surveyOffmapLoc='';
  ['confirmed','offmap','stored','gone'].forEach(s=>{
    const el=document.getElementById('surveyOpt'+s.charAt(0).toUpperCase()+s.slice(1));
    if(!el) return;
    el.className='survey-opt'+(status===s?' active-'+s:'');
  });
  const storageOpts=document.getElementById('surveyStorageOpts');
  if(storageOpts) storageOpts.className='survey-storage-opts'+(status==='stored'?' show':'');
  const offmapOpts=document.getElementById('surveyOffmapOpts');
  if(offmapOpts) offmapOpts.className='survey-storage-opts'+(status==='offmap'?' show':'');
  // "In a room" sub-form: typeahead + Position/Reposition button.
  const inRoomOpts=document.getElementById('surveyInRoomOpts');
  if(inRoomOpts) inRoomOpts.className='survey-storage-opts'+(status==='confirmed'?' show':'');
  if(status==='confirmed'){
    // Refresh the visible state of the typeahead's side button (Position
    // vs Reposition) since this can be re-entered without reopening modal.
    if(typeof updateLocationButtons==='function') updateLocationButtons();
  } else {
    // Picking another status hides the sub-form; also drop any stray
    // dropdown/confirm panels.
    if(typeof hideLocDropdown==='function') hideLocDropdown();
    if(typeof hideLocConfirm==='function') hideLocConfirm();
  }
  if(status==='offmap'){
    // Small delay to ensure the opts are visible before interacting
    setTimeout(()=>{
      initOffmapSegments();
      offmapValueToSegs(surveyOffmapLoc||'');
      const segs=getOffmapSegs();
      // Disable segments after first empty
      segs.forEach((s,j)=>{ if(j>0&&s) s.disabled=!segs[j-1]?.value.trim(); });
      if(segs[0]&&!segs[0].value) segs[0].focus();
    },30);
  }
  // The pick may toggle Save's enabled state in the panel-only flow.
  if(typeof updateConfirmEnabled==='function') updateConfirmEnabled();
}

function setSurveyStorage(loc){
  surveyStorageLoc=loc;
  document.querySelectorAll('.survey-storage-btn').forEach(b=>{
    b.classList.toggle('active',b.dataset.loc===loc);
  });
}

// ── Offmap segment input logic ────────────────────────────
function getOffmapSegs(){ return [0,1,2,3].map(i=>document.getElementById('offmapSeg'+i)); }

function offmapSegsToValue(){
  const segs=getOffmapSegs();
  // Build value from filled segments only, stopping at first empty after building
  const vals=segs.map(s=>s?s.value.trim():'');
  let result='';
  for(let i=0;i<4;i++){
    if(!vals[i]) break;
    result+=(i>0?'.':'')+vals[i];
  }
  return result;
}

function offmapValueToSegs(val){
  const parts=(val||'').split('.').concat(['','','','']).slice(0,4);
  const segs=getOffmapSegs();
  segs.forEach((s,i)=>{ if(s) s.value=parts[i]||''; });
}

function initOffmapSegments(){
  const segs=getOffmapSegs();
  segs.forEach((seg,i)=>{
    if(!seg) return;
    seg.addEventListener('input',e=>{
      // Only allow digits
      seg.value=seg.value.replace(/\D/g,'');
      surveyOffmapLoc=offmapSegsToValue();
      seg.classList.remove('invalid');
      // Enable/disable subsequent segments
      segs.forEach((s,j)=>{ if(j>0&&s) s.disabled=!segs[j-1]?.value.trim(); });
      // Auto-advance when segment is full
      if(seg.value.length===parseInt(seg.maxLength)&&i<3){
        const next=segs[i+1];
        if(next&&!next.disabled) next.focus();
      }
    });
    seg.addEventListener('keydown',e=>{
      if(e.key==='Backspace'&&seg.value===''&&i>0){
        const prev=segs[i-1];
        if(prev){ prev.focus(); prev.value=''; surveyOffmapLoc=offmapSegsToValue(); }
      }
      if(e.key==='.'&&i<3){
        e.preventDefault();
        const next=segs[i+1];
        if(next&&!next.disabled) next.focus();
      }
    });
  });
}

document.querySelectorAll('.survey-opt').forEach(opt=>{
  opt.addEventListener('click',()=>setSurveyStatus(opt.dataset.status));
});
document.querySelectorAll('.survey-storage-btn').forEach(btn=>{
  btn.addEventListener('click',e=>{ e.stopPropagation(); setSurveyStorage(btn.dataset.loc); });
});

function derivedStatus(markerRoomCode, registeredRoomCode){
  if(!markerRoomCode||!registeredRoomCode) return 'confirmed';
  return markerRoomCode===registeredRoomCode?'confirmed':'relocated';
}

// Build location-badge HTML for the modal title.
//   - Always shows the asset's CURRENT location (room code, or moved-status
//     descriptor for offmap/stored/gone).
//   - For moved imported assets where the registered room differs, adds a
//     "📦 from <registered>" badge alongside the current-location badge.
//   - Newcomers don't have a registered home, so they only get the current.
function buildLocationBadges({assetId, marker, isNewcomer}){
  const ia=assetId?assetById(assetId):null;
  const saved=assetId?getAssetStatus(assetId):null;
  const registeredRoom=ia?.spaceNumber||null;

  // Resolve the current location.
  let currentLabel=null;
  if(saved && saved.status==='offmap'){
    currentLabel=saved.offmapLocation ? `Off-map: ${saved.offmapLocation}` : 'Off-map';
  } else if(saved && saved.status==='stored'){
    const storageLabels={av_storage:'AV Storage', faculty_storage:'Faculty Storage'};
    currentLabel=storageLabels[saved.storageLocation]||saved.storageLocation||'Stored';
  } else if(saved && saved.status==='gone'){
    currentLabel='Gone';
  } else if(marker){
    const rc=getRoomFromMarker(marker);
    if(rc) currentLabel=rc;
  } else if(registeredRoom){
    currentLabel=registeredRoom;
  }

  let html='';
  if(currentLabel){
    if(marker){
      // Marker exists: the room pill IS the jump button — clicking it
      // closes the modal and zooms to the marker on the map. The marker
      // SVG sits inside the pill (small, 8×10) so the layout stays tight.
      html += `<button class="loc-badge loc-badge-jump" data-marker-id="${escHtml(String(marker.id||''))}" title="Jump to marker on map">${pinSvg({w:8,h:10,attrs:'style="flex-shrink:0"'})}${escHtml(currentLabel)}</button>`;
    } else {
      html += `<span class="loc-badge">${escHtml(currentLabel)}</span>`;
    }
  }
  // Original-location badge: only when moved away from registered room.
  // The chip carries a status-specific class so its color and emoji match
  // the survey palette (amber for moved/off-map, purple for stored, red
  // for gone).
  const movedAway = saved && ['relocated','offmap','stored','gone'].includes(saved.status);
  if(!isNewcomer && movedAway && registeredRoom && registeredRoom!==currentLabel){
    const statusEmojis={relocated:'📦', offmap:'📦', stored:'🗄️', gone:'🗑️'};
    const emoji=statusEmojis[saved.status]||'📦';
    html += `<span class="loc-badge moved-from status-${saved.status}" title="Originally registered in ${escHtml(registeredRoom)}">${emoji} from ${escHtml(registeredRoom)}</span>`;
  }
  return html;
}

// ── Location typeahead (inside survey-status "In a room" sub-form) ─────
// Cached sorted list of all room codes from the SVG. Built lazily on first
// access; the SVG doesn't change for a single floor so a single build is fine.
let _allRoomCodesCache=null;
function allRoomCodes(){
  if(_allRoomCodesCache) return _allRoomCodesCache;
  const set=new Set();
  wrap.querySelectorAll('path.floor-plan-space').forEach(p=>{
    const c=getRoomCode(p);
    if(c) set.add(c);
  });
  _allRoomCodesCache=Array.from(set).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  return _allRoomCodesCache;
}

// Set up the location fields for the given imported asset. Called from
// populateImported. Sets the typeahead's value and the Position/Reposition
// button visibility. Doesn't touch section visibility — that's driven by
// the survey-options state via setSurveyStatus.
function setupLocationFields(assetIdStr){
  const ia=assetById(assetIdStr);
  if(!ia){ locAssetId=null; return; }

  locAssetId=String(assetIdStr);

  // Resolve the current room: marker's room → saved status room → registered.
  const saved=getAssetStatus(assetIdStr);
  const existingMarker=markerForAsset(assetIdStr);
  let currentRoom=null;
  if(existingMarker) currentRoom=getRoomFromMarker(existingMarker);
  if(!currentRoom && saved && saved.room) currentRoom=saved.room;
  if(!currentRoom) currentRoom=ia.spaceNumber||null;

  locSavedRoom=currentRoom;
  locStagedRoom=currentRoom;        // initially staged = current
  locStagedRemoveMarker=false;
  locInput.value=currentRoom||'';
  locHasMarker=!!existingMarker;

  hideLocDropdown();
  hideLocConfirm();
  updateLocationButtons();
}

// Newcomer variant: same lb-row controls but reads from newAssets[] rather
// than importedAssets[]. The "saved room" for a newcomer is whatever's on
// na.spaceNumber (set when the marker was placed, or via the Room row in
// the modal). The marker is the newcomer's own marker, looked up via
// newcomerMarkerFor (not markerForAsset, which excludes newcomers).
function setupLocationFieldsForNewcomer(assetIdStr){
  const na=newAssets.find(a=>String(a.assetId)===String(assetIdStr));
  if(!na){ locAssetId=null; return; }

  locAssetId=String(assetIdStr);

  const existingMarker=newcomerMarkerFor(assetIdStr);
  let currentRoom=null;
  if(existingMarker) currentRoom=getRoomFromMarker(existingMarker);
  if(!currentRoom && na.spaceNumber && na.spaceNumber!=='Unknown') currentRoom=na.spaceNumber;

  locSavedRoom=currentRoom;
  locStagedRoom=currentRoom;
  locStagedRemoveMarker=false;
  locInput.value=currentRoom||'';
  locHasMarker=!!existingMarker;

  hideLocDropdown();
  hideLocConfirm();
  updateLocationButtons();
}

// Update the Marker control row based on marker state. Three cases:
//   - No marker yet:           [Set position]            (Room row interactive)
//   - Marker exists:           [Reposition] + [Remove]   (Room row disabled)
//   - Marker removal staged:   [Reposition] + [Remove]   (both DISABLED — Save
//                                                         must run before they
//                                                         can fire again).
//                              Room row interactive again so the user can
//                              pick a different room before saving.
// Also defaults the active tab: Marker when one exists, Room otherwise.
function updateLocationButtons(){
  if(!locAssetId){
    if(btnPositionMarker) btnPositionMarker.style.display='none';
    if(btnMove){           btnMove.style.display='none';           btnMove.disabled=false; }
    if(btnRemoveMarker){   btnRemoveMarker.style.display='none';   btnRemoveMarker.disabled=false; }
    setRoomRowDisabled(false);
    setMarkerRowDisabled(false);
    return;
  }
  if(locStagedRemoveMarker){
    if(btnPositionMarker) btnPositionMarker.style.display='none';
    if(btnMove){           btnMove.style.display='inline-flex';           btnMove.disabled=true; }
    if(btnRemoveMarker){   btnRemoveMarker.style.display='inline-flex';   btnRemoveMarker.disabled=true; }
    setLocateMode('room');
    setRoomRowDisabled(false);
    setMarkerRowDisabled(true);
    return;
  }
  if(locHasMarker){
    if(btnPositionMarker) btnPositionMarker.style.display='none';
    if(btnMove){           btnMove.style.display='inline-flex';           btnMove.disabled=false; }
    if(btnRemoveMarker){   btnRemoveMarker.style.display='inline-flex';   btnRemoveMarker.disabled=false; }
    setLocateMode('marker');
    setRoomRowDisabled(true);
    setMarkerRowDisabled(false);
  } else {
    if(btnPositionMarker) btnPositionMarker.style.display='inline-flex';
    if(btnMove){           btnMove.style.display='none';           btnMove.disabled=false; }
    if(btnRemoveMarker){   btnRemoveMarker.style.display='none';   btnRemoveMarker.disabled=false; }
    setLocateMode('room');
    setRoomRowDisabled(false);
    setMarkerRowDisabled(false);
  }
}

// Disable/enable the Room row. When a marker exists, the Room row is
// dimmed and inert — the user can only re-enable it by removing the
// marker via the Remove button.
function setRoomRowDisabled(disabled){
  if(!lbTabRoom) return;
  const row = lbTabRoom.closest('.lb-row');
  if(!row) return;
  row.classList.toggle('disabled', !!disabled);
  if(locInput)   locInput.disabled = !!disabled;
  if(locChevron) locChevron.disabled = !!disabled;
}

// Disable/enable the Marker row. Used when removal is staged: the row
// becomes the same dimmed/inert state the Room row had when Marker was
// active. The .disabled class on .lb-row is what carries the visuals;
// the per-button :disabled is set from updateLocationButtons.
function setMarkerRowDisabled(disabled){
  if(!lbTabMarker) return;
  const row = lbTabMarker.closest('.lb-row');
  if(!row) return;
  row.classList.toggle('disabled', !!disabled);
}

// Toggle which row is the "active" mode visually. Pure visual indicator —
// doesn't disable the other row's controls. Both Room and Marker controls
// remain interactive at all times; clicking inside either auto-promotes
// that row to active (see wiring below).
function setLocateMode(mode){
  if(!lbTabRoom || !lbTabMarker) return;
  // Active class lives on the parent .lb-row (where the bordered visual
  // group is styled) — not on the inner button.
  const roomRow   = lbTabRoom.closest('.lb-row');
  const markerRow = lbTabMarker.closest('.lb-row');
  if(roomRow)   roomRow  .classList.toggle('active', mode==='room');
  if(markerRow) markerRow.classList.toggle('active', mode==='marker');
}

function hideLocDropdown(){
  locDropdown.style.display='none';
  locDropdown.innerHTML='';
  if(locChevron) locChevron.classList.remove('open');
}
function hideLocConfirm(){
  locConfirm.style.display='none';
  locConfirm.innerHTML='';
  // Re-enable the input — the modal is back to its normal state.
  if(locInput) locInput.disabled=false;
}

// Marker-removal confirm panel — DEPRECATED. The flow that used this
// (changing the room via the typeahead while a marker exists) is no
// longer reachable: the Room row is fully disabled when a marker is
// present. The function is kept as a no-op so any stale callers don't
// crash; it should not be invoked under the current UX.
function showLocConfirm(){ /* no-op */ }

function renderLocDropdown(filter){
  const codes=allRoomCodes();
  const f=(filter||'').toLowerCase();
  const matches=f ? codes.filter(c=>c.toLowerCase().includes(f)) : codes;
  // If the user has typed a value that exactly matches a real room code,
  // there's nothing useful to pick from the list — hide the whole panel.
  if(f && matches.length>=1 && codes.includes(filter)){
    hideLocDropdown();
    return;
  }
  if(matches.length===0){
    locDropdown.innerHTML='<div class="loc-empty">No matching room</div>';
  } else {
    const slice=matches.slice(0,50);
    locDropdown.innerHTML=slice.map(c=>{
      // "current" = the room actually committed for this asset
      // "selected" = a staged choice the user hasn't saved yet (only
      //              shown when distinct from current)
      const isCurrent  = c===locSavedRoom;
      const isSelected = !isCurrent && c===locStagedRoom;
      const cls   = isCurrent ? ' current' : (isSelected ? ' selected' : '');
      const label = isCurrent ? ' · current' : (isSelected ? ' · selected' : '');
      return `<div class="loc-item${cls}" data-room="${escHtml(c)}">${escHtml(c)}${label}</div>`;
    }).join('');
  }
  locDropdown.style.display='';
  if(locChevron) locChevron.classList.add('open');
}

// Stage a room change (no commit — Save handles that). The Room row is
// disabled when a marker exists, so this only runs in the no-marker case;
// no marker-removal logic is needed here.
function stageRoom(newRoom){
  locStagedRoom=newRoom;
  locInput.value=newRoom;
  hideLocDropdown();
  updateLocationButtons();
  if(typeof updateConfirmEnabled==='function') updateConfirmEnabled();
}

// Wire up the typeahead. Done once at module load.
locInput.addEventListener('focus',()=>{ setLocateMode('room'); renderLocDropdown(locInput.value); updateChevronState(); });
locInput.addEventListener('blur',()=>{ setTimeout(updateChevronState,50); });
locInput.addEventListener('input',()=>{
  setLocateMode('room');
  hideLocConfirm();
  renderLocDropdown(locInput.value);
  updateChevronState();
  if(typeof updateConfirmEnabled==='function') updateConfirmEnabled();
});
locInput.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    locInput.value=locStagedRoom||locSavedRoom||'';
    hideLocDropdown(); hideLocConfirm(); locInput.blur();
    updateChevronState();
  }
});

// Tab clicks: pure visual mode toggle. Doesn't gate the other row's
// Row clicks. Only the Room row treats dead-space clicks as a shortcut:
// clicking on the "ROOM" label or empty padding triggers the chevron
// (opens/closes the dropdown). The Marker row only responds to clicks
// on its actual controls (pill, Reposition).
// Real controls always handle their own clicks via their own listeners.
function isRealControl(t){
  if(t.closest('.lb-tab')) return false;
  return !!t.closest('input, button, .loc-dropdown, .loc-confirm');
}

// Room row no longer has a dead-space click handler. The typeahead's
// own focus + chevron click already cover all interactions; auto-promote
// to Room mode happens via locInput.focus / locChevron click.
if(lbTabMarker){
  const row = lbTabMarker.closest('.lb-row');
  if(row) row.addEventListener('click',e=>{
    setLocateMode('marker');
    if(isRealControl(e.target)) return;
    // Dead-space click on Marker row → trigger Set position, but only
    // when no marker exists yet. With a marker placed, dead-space clicks
    // are inert (user must use Reposition or Remove explicitly).
    if(!locHasMarker || locStagedRemoveMarker){
      if(btnPositionMarker) btnPositionMarker.click();
    }
  });
}

// Remove button: stages marker removal. The actual marker is dropped
// when Save runs; until then both Reposition and Remove appear in their
// post-action disabled state, signalling that the user already acted but
// must still commit. Room row becomes interactive so the user can also
// change the room as part of the same Save.
if(btnRemoveMarker) btnRemoveMarker.addEventListener('click',e=>{
  e.preventDefault();
  e.stopPropagation();
  if(locAssetId){
    locStagedRemoveMarker = true;
    // Note: locHasMarker stays true (the marker still exists on the map
    // until Save). The staged flag is what gates display.
  }
  updateLocationButtons();
  if(typeof updateConfirmEnabled==='function') updateConfirmEnabled();
});

// Chevron toggle: opens the full list (no filter) or closes if open.
locChevron.addEventListener('click',e=>{
  e.preventDefault();
  e.stopPropagation();
  setLocateMode('room');
  if(locDropdown.style.display!=='none'){
    hideLocDropdown();
  } else {
    locInput.focus();
    renderLocDropdown('');
  }
  updateChevronState();
});

function updateChevronState(){
  const open=locDropdown.style.display!=='none';
  locChevron.classList.toggle('open',open);
}

// Click on a room in the dropdown — stage it. If a marker exists and the
// pick would replace it, show the inline confirm first.
locDropdown.addEventListener('click',e=>{
  const item=e.target.closest('.loc-item');
  if(!item) return;
  const newRoom=item.dataset.room;
  if(!newRoom) return;
  if(newRoom===locStagedRoom){ hideLocDropdown(); return; }
  hideLocDropdown();
  // Room row is disabled when a marker exists, so this only fires when
  // no marker is present — straight-through stage the new room.
  stageRoom(newRoom);
});

// Confirm panel was used to confirm marker removal when changing rooms
// via the typeahead. That flow is now unreachable (Room row disabled when
// marker exists; Remove button is the explicit removal path). The
// confirm element stays in the DOM (hidden) for hideLocConfirm() callers,
// but no click handler is needed.

// Click outside the typeahead area:
//   - If the marker-removal confirm panel is up, treat the outside click
//     as Cancel (revert input, close panel, re-enable input).
//   - Otherwise, just close the dropdown and revert any partially-typed value.
document.addEventListener('click',e=>{
  if(modalSurveySection.style.display==='none') return;
  if(surveyStatus!=='confirmed') return;
  const inside=e.target.closest('.loc-typeahead');
  if(inside) return;
  if(locConfirm.style.display && locConfirm.style.display!=='none'){
    locInput.value=locSavedRoom||'';
    hideLocConfirm();
    return;
  }
  hideLocDropdown();
  if(locInput.value!==(locStagedRoom||'')){
    locInput.value=locStagedRoom||locSavedRoom||'';
  }
});

function setModalMode(mode){
  modalMode=mode;
  btnModeLink.classList.toggle('active',mode==='link');
  btnModeNew.classList.toggle('active',mode==='new');
  modalLinkSection.style.display=mode==='link'?'':'none';
  modalNewSection.style.display=mode==='new'?'':'none';
  // Equipment type editor follows newcomer mode (only newcomers can change type)
  const _ef=document.getElementById('modalEquipField');
  if(_ef) _ef.style.display=mode==='new'?'':'none';
  btnConfirm.textContent=mode==='link'?'Place':'Place';
  // Details drawer: in 'new' (placing a newcomer) we expose editable
  // detail fields. In 'link' (binding to an import) the picker covers
  // identification, no drawer needed.
  if(mode==='new') renderDetailsDrawer('newcomer', {details:{}});
  else renderDetailsDrawer('hidden');
  // Mode flips between 'link' (need a picker selection) and 'new' (need a
  // typed name) — Save's enabled rule depends on the active mode.
  if(typeof updateConfirmEnabled==='function') updateConfirmEnabled();
}
btnModeLink.addEventListener('click',()=>setModalMode('link'));
btnModeNew .addEventListener('click',()=>setModalMode('new'));

function buildAssetPicker(roomCode){
  // Get imported assets for this room, minus already handled ones
  const roomAssets=importedAssets.filter(a=>
    a.spaceNumber===roomCode &&
    !isAssetHandled(a.assetId)
  );
  modalAssetList.innerHTML='';
  selectedAssetId=null;
  if(roomAssets.length===0){
    modalNoAssets.style.display='';
    modalAssetList.appendChild(modalNoAssets);
    // Auto-switch to new mode if no assets available
    setModalMode('new');
    modalModeToggle.style.display='flex';
    return false;
  }
  modalNoAssets.style.display='none';
  roomAssets.forEach(a=>{
    const div=document.createElement('div');
    div.className='modal-asset-opt';
    div.dataset.assetId=String(a.assetId);
    const emoji=equipEmoji(a.equipType);
    div.innerHTML=`
      <span class="opt-emoji">${emoji}</span>
      <div class="opt-info">
        <div class="opt-label">${escHtml(a.assetId+' ('+a.model+')')}</div>
        <div class="opt-sub">${escHtml(a.equipType)}</div>
      </div>`;
    div.addEventListener('click',()=>{
      modalAssetList.querySelectorAll('.modal-asset-opt').forEach(d=>d.classList.remove('selected'));
      div.classList.add('selected');
      selectedAssetId=String(a.assetId);
      // In place-marker link mode, the picker drives Save's enabled state.
      if(typeof updateConfirmEnabled==='function') updateConfirmEnabled();
    });
    modalAssetList.appendChild(div);
  });
  // Auto-select first
  const first=modalAssetList.querySelector('.modal-asset-opt');
  if(first){ first.classList.add('selected'); selectedAssetId=first.dataset.assetId; }
  return true;
}

// Open the main asset modal in DRAFT NEWCOMER mode. No newAssets entry
// exists yet; the entry is created on Save (Room path) or on Set position
// auto-save (Marker path). Cancel discards the draft entirely.
//
// State during draft:
//   draftNcomerActive = true
//   editingId = null (no marker yet)
//   panelAssetId = null (no asset yet)
//   locStagedRoom may be set from the typeahead
function openDraftNewcomerModal(){
  // Run openAssetEditor's reset path with no asset/marker, then mark the
  // session as a draft and apply newcomer-mode UI. This avoids duplicating
  // the modal's reset logic.
  openAssetEditor({});
  draftNcomerActive = true;
  draftNcomerData = null;

  // Newcomer-mode visuals: hides survey wrapper, shows Locate-by sub-form.
  if(modalEl) modalEl.classList.add('modal-newcomer-mode');
  modalSurveySection.style.display='';
  const inRoomOpts=document.getElementById('surveyInRoomOpts');
  if(inRoomOpts) inRoomOpts.classList.add('show');

  // Title placeholder — no ID pill, since we haven't assigned one yet.
  modalTitleEl.innerHTML = equipEmoji('displays')+' <span class="eq-badge">🐣 New asset</span>';

  // Equipment editor visible (newcomers can choose their type).
  const _equipField=document.getElementById('modalEquipField');
  if(_equipField) _equipField.style.display='';
  modalName.value='';
  showSerialEditable('');
  renderDetailsDrawer('newcomer', {details:{}});
  modalEquip.value='displays';

  // Locate-by section: locAssetId is null (no asset yet). We still want
  // both rows to be interactive, so set locHasMarker=false explicitly
  // and call updateLocationButtons. Since locAssetId is null, the
  // function will hide the marker row's buttons — fix that with a small
  // override below.
  locAssetId = null;
  // Prefill Room from the currently-selected path if any. Saves the user
  // a click when they're already standing in the room they want to add to.
  // The user can still clear the field, type a different room, or use
  // Set position to switch to the Marker path.
  const preselectedRoom = selectedPath ? getRoomCode(selectedPath) : null;
  locSavedRoom = preselectedRoom;
  locStagedRoom = preselectedRoom;
  locStagedRemoveMarker = false;
  locHasMarker = false;
  locInput.value = preselectedRoom || '';
  hideLocDropdown();
  hideLocConfirm();

  // For draft mode, force the Set position button visible (updateLocation
  // Buttons would hide it because locAssetId is null).
  if(btnPositionMarker) btnPositionMarker.style.display='inline-flex';
  if(btnMove) btnMove.style.display='none';
  if(btnRemoveMarker) btnRemoveMarker.style.display='none';
  setLocateMode('room');
  setRoomRowDisabled(false);
  setMarkerRowDisabled(false);

  // Bottom bar: just Cancel + Save (no Delete — there's nothing yet to
  // delete; Cancel discards).
  btnDelete.style.display='none';
  btnConfirm.textContent='Save';

  // Open and focus.
  modalOverlay.classList.add('open');
  setTimeout(()=>modalName?.focus(), 40);

  // Re-evaluate Save's enabled state with the new draft rules.
  if(typeof updateConfirmEnabled==='function') updateConfirmEnabled();
}

// Open the main asset modal in EDIT mode for an existing newcomer (can be
// markered or room-only). Routed from the panel row click — replaces the
// old secondary ncomer modal entirely.
//
// Markered newcomer: delegates to openAssetEditor({markerId}) which already
// handles the m.isNew branch (shows newcomer-mode + Locate-by).
//
// Room-only newcomer: opens the modal blank, then populates fields from
// newAssets[], shows the Locate-by section with the saved room and an
// empty Marker row (Set position is the only marker control). On Save,
// commits via the m.isNew branch — but with no marker, the Save handler's
// "panel asset" branch needs to find the newAssets entry. To make that
// path work without restructuring the whole Save handler, we set
// panelAssetId to the newcomer id AND mark the modal as newcomer-mode.
function openNewcomerEditor(assetId){
  const na=newAssetById(assetId);
  if(!na) return;
  const m=newcomerMarkerFor(assetId);
  if(m){
    // Markered case — existing flow handles it.
    openAssetEditor({markerId: m.id});
    return;
  }
  // Room-only case — manually compose the modal.
  openAssetEditor({});
  // Mark this as a newcomer-edit session.
  panelAssetId = String(assetId);
  draftNcomerActive = false;  // not a draft — already exists

  if(modalEl) modalEl.classList.add('modal-newcomer-mode');
  modalSurveySection.style.display='';
  const inRoomOpts=document.getElementById('surveyInRoomOpts');
  if(inRoomOpts) inRoomOpts.classList.add('show');

  // Title with id pill + Newcomer badge.
  const idPill='<span class="id-pill magenta">'+escHtml(String(assetId))+'</span>';
  modalTitleEl.innerHTML = equipEmoji(na.equip||'displays')+' '+idPill+
    ' <span class="eq-badge">🐣 Newcomer</span>';

  const _equipField=document.getElementById('modalEquipField');
  if(_equipField) _equipField.style.display='';
  modalName.value = na.label||'';
  showSerialEditable(na.serialNumber);
  renderDetailsDrawer('newcomer', {details: na.details||{}});
  modalEquip.value = na.equip||'displays';

  // Locate-by section: room set, no marker.
  setupLocationFieldsForNewcomer(assetId);

  // Bottom bar: Delete (red, no icon) + Cancel + Save.
  btnDelete.classList.add('btn-remove-m');
  btnDelete.textContent='Delete';
  btnDelete.style.display='inline-flex';
  btnConfirm.textContent='Save';

  modalOverlay.classList.add('open');
  setTimeout(()=>modalName?.focus(), 40);
  if(typeof updateConfirmEnabled==='function') updateConfirmEnabled();
}

function openAssetEditor({markerId, assetId, pos}={}){
  // ── Preserve selectedAssetId across setPlacingMode ────────
  const preSelected=selectedAssetId;
  editingId=markerId||null;
  pendingPos=pos||null;
  panelAssetId=assetId?String(assetId):null;
  setPlacingMode(false);
  if(preSelected) selectedAssetId=preSelected;

  // ── Shared reset ──────────────────────────────────────────
  modalModeToggle.style.display='none';
  modalLinkSection.style.display='none';
  modalNewSection.style.display='';
  modalSurveySection.style.display='none';
  // Details drawer: reset to hidden every modal open. Each populate
  // path reactivates it (if appropriate) via renderDetailsDrawer.
  renderDetailsDrawer('hidden');
  hideLocDropdown();
  hideLocConfirm();
  locAssetId=null;
  locSavedRoom=null;
  locStagedRoom=null;
  locStagedRemoveMarker=false;
  locHasMarker=false;
  btnDelete.style.display='none';
  // Restore Clear button to its default look (the newcomer flow may have
  // transformed it into a red "Delete" with an icon).
  btnDelete.classList.remove('btn-remove-m');
  btnDelete.textContent='Clear';
  btnMove.style.display='none';   btnMove.disabled=false;
  if(btnMoveNcomer) btnMoveNcomer.style.display='none';
  btnPositionMarker.style.display='none';
  if(btnRemoveMarker){ btnRemoveMarker.style.display='none'; btnRemoveMarker.disabled=false; }
  setRoomRowDisabled(false);
  setMarkerRowDisabled(false);
  setLocateMode('room');  // default tab
  // Drop newcomer-mode wrapper if it was applied. Reset block runs at the
  // top of every modal open, so this normalises the modal back to its
  // default (imported-asset) layout for the next open.
  if(modalEl) modalEl.classList.remove('modal-newcomer-mode');
  const inRoomOptsReset=document.getElementById('surveyInRoomOpts');
  if(inRoomOptsReset) inRoomOptsReset.classList.remove('show');
  btnRevertName.classList.remove('show');
  modalOriginalName='';
  // Equipment type editor: only shown for newcomers (imported assets keep
  // their imported type — not editable here).
  const _equipField=document.getElementById('modalEquipField');
  if(_equipField) _equipField.style.display='none';
  setSurveyStatus(null);

  // ── Helper: populate name + survey for an imported asset ──
  function populateImported(assetIdStr, markerObj){
    const ia=assetById(assetIdStr);
    const saved=getAssetStatus(assetIdStr);
    modalOriginalName=ia?.model||saved?.customName||'';
    const cn=saved?.customName||markerObj?.customName||null;
    modalName.value=cn||modalOriginalName;
    btnRevertName.classList.toggle('show',!!(cn&&cn!==modalOriginalName));
    // Serial number for imports lives in the details drawer (not as its
    // own field). We hide the dedicated serial field here so it doesn't
    // duplicate the drawer's serial row.
    hideSerialField();
    renderDetailsDrawer('import', ia || {});

    // Survey-status section is for the INITIAL decision and ongoing
    // adjustments. For assets that are off-map, stored, or gone, the section
    // is hidden — those are non-room states and changing them goes through
    // Clear → re-apply for clarity. "Relocated" is no longer hidden; it's
    // just "In a room" pointing at a different room than registered, fully
    // editable through the typeahead.
    const movedAwayStatuses = new Set(['offmap','stored','gone']);
    const isMoved = !!(saved && movedAwayStatuses.has(saved.status));

    if(isMoved){
      modalSurveySection.style.display='none';
      // Still load the in-memory survey vars so a name-only Save preserves
      // the existing status/location fields verbatim.
      setSurveyStatus(saved.status);
      if(saved.status==='stored'&&saved.storageLocation) setSurveyStorage(saved.storageLocation);
      if(saved.status==='offmap'&&saved.offmapLocation){
        surveyOffmapLoc=saved.offmapLocation;
      }
    } else {
      modalSurveySection.style.display='';
      // Set up the location typeahead first — setSurveyStatus reads
      // location state (locHasMarker, etc.) when activating "in room".
      setupLocationFields(assetIdStr);

      // Decide which status to pre-select:
      //  - If there's already a saved status, show that. Both 'confirmed'
      //    and 'relocated' map onto the unified "In a room" option, since
      //    the only difference is whether the room matches the registered
      //    one — a derived value, not a user choice.
      //  - If there's a marker placed, derive confirmed/relocated from it
      //    (placing a marker IS a confirmation of presence).
      //  - Otherwise leave unselected — the user opened the modal to look
      //    or rename, not to commit a status. Save without picking will
      //    only save the rename, no status change.
      let auto=null;
      if(saved?.status==='confirmed' || saved?.status==='relocated'){
        auto='confirmed';   // both map to "In a room"
      } else if(saved?.status){
        auto=saved.status;
      } else if(markerObj){
        const markerRoomCode=getRoomFromMarker(markerObj);
        auto=derivedStatus(markerRoomCode, ia?.spaceNumber);
        // derivedStatus returns 'confirmed' or 'relocated' — both → "In a room"
        if(auto==='relocated') auto='confirmed';
      }
      setSurveyStatus(auto);
      if(auto==='stored'&&saved?.storageLocation) setSurveyStorage(saved.storageLocation);
      if(auto==='offmap'&&saved?.offmapLocation){
        surveyOffmapLoc=saved.offmapLocation;
        // Segments populated via setSurveyStatus timeout above
      }
    }
    modalEquip.value=ia?.equipType||markerObj?.equip||'displays';
    // Now that name/status are loaded, recompute Save's enabled state.
    updateConfirmEnabled();
  }

  // ── Branch: editing existing marker ──────────────────────
  if(markerId){
    const m=markers.find(m=>m.id===markerId);
    const isNewcomer=m?.isNew;
    const pillColor=isNewcomer?'magenta':'cyan';
    const pillText=m?.assetId?String(m.assetId):'';
    const idPill=pillText?('<span class="id-pill '+pillColor+'">'+escHtml(pillText)+'</span>'):'';
    const equipEmoji_=isNewcomer
      ? equipEmoji(m?.equip||'displays')
      : equipEmoji(assetById(pillText)?.equipType||m?.equip||'displays');
    if(isNewcomer){
      const locHtml=buildLocationBadges({assetId:m?.assetId, marker:m, isNewcomer:true});
      modalTitleEl.innerHTML=equipEmoji_+' '+idPill+' <span class="eq-badge">🐣 Newcomer</span>'+locHtml;
    } else {
      const locHtml=buildLocationBadges({assetId:m?.assetId, marker:m, isNewcomer:false});
      modalTitleEl.innerHTML=equipEmoji_+' '+idPill+' <span class="eq-badge">'+escHtml(equipLabel(m?.equip||'displays'))+'</span>'+locHtml;
    }
    if(isNewcomer){
      const na=newAssets.find(a=>a.assetId===m?.assetId);
      modalName.value=na?.label||'';
      showSerialEditable(na?.serialNumber);
      renderDetailsDrawer('newcomer', {details: na?.details||{}});
      modalEquip.value=m?.equip||'displays';
      if(_equipField) _equipField.style.display='';
      // Show the Locate-by sub-form — same lb-rows the imported flow uses,
      // but with the wrapping survey UI hidden via .modal-newcomer-mode.
      if(modalEl) modalEl.classList.add('modal-newcomer-mode');
      modalSurveySection.style.display='';
      const inRoomOpts=document.getElementById('surveyInRoomOpts');
      if(inRoomOpts) inRoomOpts.classList.add('show');
      setupLocationFieldsForNewcomer(m?.assetId);
      // Bottom-bar Clear becomes "Delete" — fully removes the newcomer
      // (asset + marker). Same handler; cosmetic transformation only.
      btnDelete.classList.add('btn-remove-m');
      btnDelete.textContent='Delete';
      // The dedicated newcomer-only Reposition button at the bottom is
      // gone — Reposition lives in the Marker row now. Keep btnMoveNcomer
      // hidden defensively in case any leftover state lingered.
      if(btnMoveNcomer) btnMoveNcomer.style.display='none';
    } else {
      populateImported(String(m?.assetId), m);
    }
    btnDelete.style.display='inline-flex';
    btnMove.style.display='inline-flex';
    btnConfirm.textContent='Save';

  // ── Branch: panel asset row (no marker) ──────────────────
  } else if(assetId){
    const ia=assetById(assetId);
    const eLabel=equipLabel(ia?.equipType||'displays');
    const idPill='<span class="id-pill cyan">'+escHtml(String(assetId))+'</span>';
    const existingMarker=markerForAsset(assetId);
    const locHtml=buildLocationBadges({assetId, marker:existingMarker, isNewcomer:false});
    modalTitleEl.innerHTML=equipEmoji(ia?.equipType||'displays')+' '+idPill+' <span class="eq-badge">'+escHtml(eLabel)+'</span>'+locHtml;
    if(existingMarker){
      editingId=existingMarker.id;
      populateImported(String(assetId), existingMarker);
      btnDelete.style.display='inline-flex';
      btnMove.style.display='inline-flex';
    } else {
      populateImported(String(assetId), null);
      btnPositionMarker.style.display='inline-flex';
      // Clear is meaningful here only if there's a survey status to clear
      // (e.g. this asset was bulk-acknowledged as stored/offmap/gone, or
      // marked confirmed via the panel without placing a marker).
      const saved=getAssetStatus(assetId);
      if(saved && saved.status){
        btnDelete.style.display='inline-flex';
      }
    }
    btnConfirm.textContent='Save';

  // ── Branch: placing new marker (canvas click) ─────────────
  } else if(pos){
    modalName.value='';
    showSerialEditable('');
    modalEquip.value='displays';
    const roomCode=pendingRoomCode||null;

    // NB: Position-from-Imports (selectedAssetId set without modalMode) used
    // to open this modal as a "Place here / Cancel" confirmation, but that's
    // pure ceremony — there's nothing to confirm. The canvas click handler
    // now fast-paths that flow and never reaches this branch.

    if(importedAssets.length>0&&roomCode){
      modalTitleEl.textContent='Place marker';
      modalModeToggle.style.display='flex';
      const hasAvailable=buildAssetPicker(roomCode);
      if(hasAvailable) setModalMode('link');
      else { setModalMode('new'); if(_equipField) _equipField.style.display=''; }
    } else {
      modalTitleEl.textContent='Place marker';
      modalNewSection.style.display='';
      if(_equipField) _equipField.style.display='';
    }
    btnConfirm.textContent=btnConfirm.textContent||'Place';
  }

  modalOverlay.classList.add('open');
  // Recompute Save's enabled state for the final modal mode. populateImported
  // already handles the panel-only path; this catches placement and newcomer
  // flows (always enabled).
  updateConfirmEnabled();
  setTimeout(()=>{ if(markerId||assetId||modalMode==='new') modalName.focus(); },40);
}
function closeModal(){
  modalOverlay.classList.remove('open');
  selectedAssetId=null;
  pendingRoomCode=null;
  panelAssetId=null;
  // Drop the draft-newcomer flag too. The "Set position" path
  // re-establishes draftNcomerActive after closeModal, so its journey
  // through closeModal is harmless. Cancel/Esc/overlay-click thus all
  // discard the in-progress draft.
  draftNcomerActive=false;
  draftNcomerData=null;
  // Tidy up any in-progress location confirm panel.
  hideLocConfirm();
}

btnCancel.addEventListener('click',closeModal);
// Close on pointerdown on the backdrop — this is the moment the user
// commits to dismissing the modal, not when they release. pointerdown
// fires for both mouse and touch (replacing both mousedown + touchstart),
// so this works on mobile too. The e.target check ensures only clicks on
// the backdrop itself (not the modal content) close the modal.
modalOverlay.addEventListener('pointerdown',e=>{if(e.target===modalOverlay)closeModal();});
modalName.addEventListener('keydown',e=>{
  if(e.key==='Enter') btnConfirm.click();
  if(e.key==='Escape') closeModal();
});

btnConfirm.addEventListener('click',()=>{
  // ── Draft newcomer: Room-only path ─────────────────────────
  // The user clicked + → modal opened blank → they typed a room and
  // hit Save. (The Marker path doesn't reach Save — it auto-saves on
  // map click via the click handler that consumes draftNcomerActive.)
  if(draftNcomerActive){
    const label=(modalName?.value||'').trim();
    const equip=(modalEquip?.value)||'displays';
    const typedRoom=(locInput?.value||'').trim();
    const room = (typedRoom && allRoomCodes().includes(typedRoom)) ? typedRoom : null;
    // updateConfirmEnabled keeps Save disabled until name + valid room
    // are both present, so reaching here means we're good. Defensive
    // guard kept in case the disabled state was bypassed somehow.
    if(!label || !room) return;
    // Validate detail-drawer fields before committing. validateDrawer
    // shows inline errors and returns false if anything's invalid.
    if(!validateDrawer()) return;
    // Drawer holds both Sn and the rest of the details bundle now.
    const drawer = readDetailsFromDrawer();
    // Commit: generate ID, push newAssets entry, no markers entry.
    const newId = nextNewcomerId();
    newAssets.push({
      assetId: newId,
      label,
      equip,
      spaceNumber: room,
      spaceName: '',
      serialNumber: drawer.serialNumber,
      details: drawer.details,
      checked: false
    });
    saveToStorage(); renderPanel();
    closeModal();
    showFpToast(`✓ Added ${newId} to ${room}`);
    if(typeof jumpPanelToAsset==='function') jumpPanelToAsset(newId);
    return;
  }

  // If user typed a valid room into the location input but never clicked
  // a dropdown item, sync that value into locStagedRoom so the rest of
  // the handler reads the right room. We only commit a typed value when
  // it matches a real room; the input-validity check in
  // updateConfirmEnabled keeps Save disabled for unmatched values.
  // The Room row is disabled when a marker exists, so we don't need to
  // worry about the cross-row confirm flow that used to live here.
  if(surveyStatus==='confirmed' && locInput && !locInput.disabled){
    const typed=(locInput.value||'').trim();
    if(typed && typed!==locStagedRoom && allRoomCodes().includes(typed)){
      stageRoom(typed);
    }
  }

  // Validate offmap — building segment required
  if(surveyStatus==='offmap'){
    const loc=offmapSegsToValue();
    const seg0=document.getElementById('offmapSeg0');
    if(!loc||!loc.trim()){
      if(seg0){ seg0.classList.add('invalid'); seg0.focus(); }
      return;
    }
    surveyOffmapLoc=loc;
  }
  const label=modalName.value.trim();
  const equip=modalEquip.value;
  const customName=(label&&label!==modalOriginalName)?label:null;
  const offmapLoc=surveyStatus==='offmap'?surveyOffmapLoc.trim()||null:null;
  // Tracks the asset that was just placed (link or new-newcomer branch).
  // Used at the bottom of this handler to focus the panel on that asset.
  let placedAssetId=null;

  // ── Panel-only (no marker) ────────────────────────────────
  if(panelAssetId&&!editingId){
    // Newcomer fork: panelAssetId points to a newAssets entry (no marker).
    // Save updates name/equip/room. If the user staged a room change via
    // the typeahead, write it to spaceNumber.
    if(isNewcomerId(panelAssetId)){
      if(!validateDrawer()) return;
      const drawer = readDetailsFromDrawer();
      const na=newAssetById(panelAssetId);
      if(na){
        na.label = label;
        na.equip = equip;
        na.serialNumber = drawer.serialNumber;
        na.details = drawer.details;
        const typedRoom=(locInput?.value||'').trim();
        if(typedRoom && allRoomCodes().includes(typedRoom)){
          na.spaceNumber = typedRoom;
        }
      }
      closeModal(); commit();
      if(selectedPath) showInfoBar(selectedPath);
      showFpToast(`✓ Updated ${panelAssetId}`);
      return;
    }
    const ia=assetById(panelAssetId);
    // For "in a room" status, use the staged room from the typeahead and
    // derive the actual final status (confirmed vs relocated). For other
    // statuses, room is the registered home (irrelevant for offmap/stored
    // /gone but kept for symmetry).
    let finalStatus=surveyStatus;
    let room=ia?.spaceNumber||null;
    if(surveyStatus==='confirmed'){
      const targetRoom=locStagedRoom||locSavedRoom||room;
      finalStatus=derivedStatus(targetRoom, ia?.spaceNumber);
      room=targetRoom;
    }
    // If the user didn't pick a status and didn't change the rename,
    // there's nothing to save. Avoid touching assetStatuses at all so we
    // don't accidentally wipe a previously-saved rename.
    const renameChanged = customName!==null;
    if(finalStatus || renameChanged){
      pushUndoSnapshot(panelAssetId);
      // Pass customName only when it changed; undefined preserves the
      // existing value inside setAssetStatus.
      const cnArg = renameChanged ? customName : undefined;
      setAssetStatus(panelAssetId, finalStatus, room, finalStatus==='stored'?surveyStorageLoc:null, cnArg, offmapLoc);
      if(finalStatus==='offmap'||finalStatus==='stored'||finalStatus==='gone'){
        markers=markers.filter(mx=>!(String(mx.assetId)===String(panelAssetId)&&!mx.isNew));
      }
      // "In a room" with a different room than where the marker is, and
      // the user confirmed marker removal in the inline confirm: drop
      // the marker. This is the panel-only path so there shouldn't be a
      // marker, but keep the code path symmetric with editing-marker.
      if(finalStatus && (finalStatus==='confirmed'||finalStatus==='relocated') && locStagedRemoveMarker){
        markers=markers.filter(mx=>!(String(mx.assetId)===String(panelAssetId)&&!mx.isNew));
      }
    }
    closeModal(); commit();
    // If the user staged an "in a room" change, focus the panel/map on
    // the destination room and asset.
    if(finalStatus && (finalStatus==='confirmed'||finalStatus==='relocated') && room){
      const path=findPathByRoomCode(room);
      focusAfterMarkerAction(path, panelAssetId);
    } else if(selectedPath){
      showInfoBar(selectedPath);
    }
    return;
  }

  // ── Editing existing marker ───────────────────────────────
  if(editingId){
    const m=markers.find(m=>m.id===editingId);
    if(m){
      m.equip=equip;
      if(m.isNew){
        if(!validateDrawer()) return;
        const drawer = readDetailsFromDrawer();
        const na=newAssets.find(a=>a.assetId===m.assetId);
        if(na){
          na.label=label; na.equip=equip;
          na.serialNumber = drawer.serialNumber;
          na.details = drawer.details;
        }
        // If user staged marker removal in this session, drop the marker
        // but keep the newAssets entry — the newcomer becomes room-only.
        if(locStagedRemoveMarker){
          markers=markers.filter(mx=>!(String(mx.assetId)===String(m.assetId)&&mx.isNew));
        }
      } else {
        m.label=label;
        // For "in a room" status: use staged room, derive final status,
        // and remove the marker if user confirmed that.
        let finalStatus=surveyStatus;
        let room=getRoomFromMarker(m);
        let removeMarker=false;
        if(surveyStatus==='confirmed'){
          const ia=assetById(m.assetId);
          const targetRoom=locStagedRoom||locSavedRoom||room;
          finalStatus=derivedStatus(targetRoom, ia?.spaceNumber);
          room=targetRoom;
          removeMarker=locStagedRemoveMarker;
        }
        pushUndoSnapshot(m.assetId);
        const renameChanged = customName!==null;
        const cnArg = renameChanged ? customName : undefined;
        setAssetStatus(m.assetId, finalStatus, room, finalStatus==='stored'?surveyStorageLoc:null, cnArg, offmapLoc);
        if(finalStatus==='offmap'||finalStatus==='stored'||finalStatus==='gone'||removeMarker){
          markers=markers.filter(mx=>!(String(mx.assetId)===String(m.assetId)&&!mx.isNew));
        }
      }
    }
  // ── Placing new marker ────────────────────────────────────
  } else if(pendingPos){
    if(modalMode==='link'&&selectedAssetId){
      const ia=assetById(selectedAssetId);
      if(ia){
        pushUndoSnapshot(selectedAssetId);
        placeImportedMarker(ia, pendingPos.x, pendingPos.y, pendingRoomCode,
                            derivedStatus(pendingRoomCode, ia.spaceNumber), true);
        placedAssetId=String(selectedAssetId);
      }
    } else {
      // New newcomer — ID generated at confirm time so it's always fresh
      const label=modalName.value.trim();
      const equip=modalEquip.value;
      if(!validateDrawer()) return;
      const drawer = readDetailsFromDrawer();
      let maxN=0;
      newAssets.forEach(a=>{ const m=String(a.assetId).match(/^N-(\d+)$/); if(m) maxN=Math.max(maxN,parseInt(m[1])); });
      markers.forEach(m=>{ const x=String(m.assetId||'').match(/^N-(\d+)$/); if(x) maxN=Math.max(maxN,parseInt(x[1])); });
      const newcomerId='N-'+(maxN+1);
      const m={
        id:nextId(),
        x:pendingPos.x, y:pendingPos.y,
        label:newcomerId,
        equip, assetId:newcomerId, isNew:true
      };
      setMarkerRoomCoords(m, pendingRoomCode ? findPathByRoomCode(pendingRoomCode) : null);
      markers.push(m);
      newAssets.push({
        assetId:newcomerId,
        label:label,
        equip,
        spaceNumber:pendingRoomCode||'Unknown',
        spaceName:'',
        serialNumber: drawer.serialNumber,
        details: drawer.details,
        checked:false
      });
      placedAssetId=newcomerId;
    }
  }
  closeModal();
  renderMarkers();
  renderPanel();
  saveToStorage();
  // Drive the right panel to the asset that was just placed (or the room
  // for non-placement flows). focusAfterMarkerAction handles both.
  if(pendingPos && pendingRoomCode){
    const path=findPathByRoomCode(pendingRoomCode);
    focusAfterMarkerAction(path, placedAssetId);
  } else if(selectedPath){
    showInfoBar(selectedPath);
  }
});

btnRevertName.addEventListener('click',()=>{
  modalName.value=modalOriginalName;
  btnRevertName.classList.remove('show');
  updateConfirmEnabled();
});

btnDelete.addEventListener('click',()=>{
  // "Delete" (newcomer) — fully removes the asset (newAssets entry +
  // marker if any). Distinct from "Remove marker" inside the Locate-by
  // section, which only removes the marker and keeps the newcomer as
  // room-only. The bottom-bar Delete is the asset-level delete.
  const editingMarker=editingId?markers.find(mx=>mx.id===editingId):null;
  const newcomerAid =
    editingMarker && editingMarker.isNew ? editingMarker.assetId :
    (panelAssetId && isNewcomerId(panelAssetId) ? panelAssetId : null);

  if(newcomerAid){
    // Capture pre-delete state so the user can undo the removal. Newcomers
    // aren't tracked by assetStatuses, so the standard pushUndoSnapshot
    // path doesn't suit — we just snapshot the newAssets entry and any
    // matching marker, restore them on click.
    const naSnap = newAssets.find(a=>String(a.assetId)===String(newcomerAid));
    const mSnap  = markers.filter(mx=>String(mx.assetId)===String(newcomerAid) && mx.isNew);
    const naClone = naSnap ? {...naSnap} : null;
    const mClones = mSnap.map(mm=>({...mm}));

    newAssets = newAssets.filter(a=>String(a.assetId)!==String(newcomerAid));
    markers   = markers.filter(mx=>!(String(mx.assetId)===String(newcomerAid) && mx.isNew));
    closeModal();
    commit();
    showUndoToast(`Deleted ${newcomerAid}`, ()=>{
      // Re-insert the snapshot only if nothing has filled in the slot
      // since (e.g. user immediately reused N-X for a new newcomer).
      const stillGone = !newAssets.some(a=>String(a.assetId)===String(newcomerAid));
      if(stillGone && naClone){
        newAssets.push(naClone);
        mClones.forEach(mm=>markers.push(mm));
        commit();
      }
    });
    return;
  }

  // "Clear" (or "Remove Marker" when this asset is a newcomer) — reset
  // the asset to its pre-survey state. Works whether or not the asset
  // has a marker. We push an undo snapshot first so the user can restore
  // via the toast (or the Movers tab, if the asset still appears there).
  const m=editingId?markers.find(m=>m.id===editingId):null;
  const wasNewcomer = !!m?.isNew;
  const aid=m?.assetId || panelAssetId;
  let pushed=false;
  if(aid){
    pushUndoSnapshot(aid);
    pushed=true;
    if(m && !m.isNew){
      // Imported marker — drop status (but keep customName per the rename
      // independence rule that setAssetStatus enforces).
      setAssetStatus(m.assetId, null);
    } else if(!m && panelAssetId){
      // No marker, panel-only — drop status here too.
      setAssetStatus(panelAssetId, null);
    }
    // m.isNew (newcomer): no status entry to clear; just remove the marker.
  }
  if(editingId){
    markers=markers.filter(mx=>mx.id!==editingId);
    // Marker is gone — stop tracking it as the modal's editing target so
    // a subsequent Save doesn't try to update a non-existent marker.
    // The modal continues editing the asset by panelAssetId instead.
    if(aid && !panelAssetId) panelAssetId=String(aid);
    editingId=null;
  }
  commit();

  // Newcomers: removing the marker also removes the only thing the
  // modal can edit — close it instead of refreshing in place.
  if(wasNewcomer){
    closeModal();
    if(pushed && aid){
      showUndoToast(`Removed ${aid}`, ()=>{
        undoAssetStatus(aid);
      });
    }
    return;
  }

  // Refresh the modal UI in place to reflect the cleared state — typeahead
  // and Marker row buttons re-derive from the now-markerless asset, and
  // the survey-status options reset to "nothing picked".
  if(panelAssetId){
    const ia2=assetById(panelAssetId);
    if(ia2){
      // Re-build the title so the marker-jump pill no longer renders
      // (buildLocationBadges sees no marker → plain pill).
      const eLabel2=equipLabel(ia2?.equipType||'displays');
      const idPill2='<span class="id-pill cyan">'+escHtml(String(panelAssetId))+'</span>';
      const locHtml2=buildLocationBadges({assetId:panelAssetId, marker:null, isNewcomer:false});
      modalTitleEl.innerHTML=equipEmoji(ia2?.equipType||'displays')+' '+idPill2+' <span class="eq-badge">'+escHtml(eLabel2)+'</span>'+locHtml2;
    }
    setupLocationFields(panelAssetId);
    setSurveyStatus(null);
    btnDelete.style.display='none';   // nothing left to clear
    btnMove.style.display='none';
  }

  // Toast with an Undo button that pops the snapshot we just pushed.
  if(pushed && aid){
    showUndoToast(`Cleared ${aid}`, ()=>{
      undoAssetStatus(aid);
    });
  }
});
btnMove.addEventListener('click',()=>{
  movingMarkerId=editingId;
  closeModal();
  startRepositionUI();
});
if(btnMoveNcomer) btnMoveNcomer.addEventListener('click',()=>{
  movingMarkerId=editingId;
  closeModal();
  startRepositionUI();
});

btnPositionMarker.addEventListener('click',()=>{
  // Draft newcomer path: user is composing a brand-new newcomer in the
  // main modal and clicked Set position. Strict-mode rule (same as Save):
  // a name is required. If empty, focus the name field and bail — no
  // toast, just keep the modal open so the user can fill it in.
  if(draftNcomerActive){
    const name = (modalName?.value||'').trim();
    if(!name){
      modalName?.focus();
      return;
    }
    if(!validateDrawer()) return;
    const equip = (modalEquip?.value)||'displays';
    // Capture detail fields from the drawer BEFORE closeModal — once
    // closed, modalDetailsList inputs are inaccessible (the drawer is
    // re-rendered from scratch on each open). The map-click consumer
    // reads from draftNcomerData to commit the eventual newAssets push.
    const drawer = readDetailsFromDrawer();
    closeModal();
    draftNcomerActive = true;
    draftNcomerData = {name, serial: drawer.serialNumber, equip, details: drawer.details};
    setPlacingMode(true);
    showFpToast('Click on the map to place the new marker');
    return;
  }
  const aid=panelAssetId;
  const ia=assetById(aid);
  closeModal();
  if(!ia) return;
  selectedAssetId=aid;
  setPlacingMode(true);
  showFpToast('Click on the map to place marker for '+aid);
});
function startRepositionUI(){
  setUIMode('moving');
  let hint=document.getElementById('move-hint');
  if(!hint){
    hint=document.createElement('div');
    hint.id='move-hint';
    hint.textContent='Tap on the map to reposition the marker';
    document.body.appendChild(hint);
  }
}
function endRepositionUI(){
  setUIMode('none');
  const hint=document.getElementById('move-hint');
  if(hint) hint.remove();
}

// ── Bulk Check modal ──────────────────────────────────────
// Lists every unreviewed imported asset for the selected room with a status
// picker at the top. User chooses a status (Confirmed default), optionally
// picks off-map location, toggles which assets to apply to, hits Check.
{
  const ackOverlay   = document.getElementById('ackOverlay');
  const ackRoomSub   = document.getElementById('ack-room-sub');
  const ackList      = document.getElementById('ack-asset-list');
  const ackAllRow    = document.getElementById('ack-select-all-row');
  const ackConfirm   = document.getElementById('ack-confirm-btn');
  const ackCancel    = document.getElementById('ack-cancel-btn');
  const ackPicker    = document.getElementById('ack-status-picker');
  const ackOffmapWrap= document.getElementById('ack-offmap-wrap');

  let ackRoomCode = null;
  let ackAssignments = new Map(); // assetId → 'confirmed'|'stored-av'|'stored-faculty'|'offmap'|'gone'
  let ackStatus   = 'confirmed'; // currently active tab — the "paint brush"

  // Infobar button opens the modal
  document.getElementById('btn-acknowledge-all').addEventListener('click',()=>{
    if(!selectedPath) return;
    ackRoomCode = getRoomCode(selectedPath);
    if(!ackRoomCode) return;
    openAckModal(ackRoomCode);
  });

  function setAckStatus(s){
    ackStatus=s;
    document.getElementById('ackModal').dataset.status=s;
    ackPicker.querySelectorAll('.ack-tab').forEach(b=>{
      b.classList.toggle('active', b.dataset.status===s);
    });
    ackOffmapWrap.style.display = s==='offmap' ? 'block' : 'none';
    updateConfirmLabel();
    syncSelectAll();
  }

  ackPicker.addEventListener('click',e=>{
    const btn=e.target.closest('.ack-tab');
    if(btn) setAckStatus(btn.dataset.status);
  });

  // Offmap segment helpers
  function getAckOffmapSegs(){ return [0,1,2,3].map(i=>document.getElementById('ackOffmapSeg'+i)); }
  function getAckOffmapValue(){
    const vals=getAckOffmapSegs().map(s=>s?s.value.trim():'');
    let out='';
    for(let i=0;i<4;i++){ if(!vals[i]) break; out+=(i>0?'.':'')+vals[i]; }
    return out;
  }
  (function initAckOffmapSegs(){
    const segs=getAckOffmapSegs();
    segs.forEach((seg,i)=>{
      if(!seg) return;
      seg.addEventListener('input',()=>{
        seg.value=seg.value.replace(/\D/g,'');
        seg.classList.remove('invalid');
        segs.forEach((s,j)=>{ if(j>0&&s) s.disabled=!segs[j-1]?.value.trim(); });
        if(seg.value.length===parseInt(seg.maxLength)&&i<3){
          const next=segs[i+1];
          if(next&&!next.disabled) next.focus();
        }
      });
      seg.addEventListener('keydown',e=>{
        if(e.key==='Backspace'&&seg.value===''&&i>0){
          const prev=segs[i-1];
          if(prev){ prev.focus(); prev.value=''; }
        }
        if(e.key==='.'&&i<3){
          e.preventDefault();
          const next=segs[i+1];
          if(next&&!next.disabled) next.focus();
        }
      });
    });
  })();

  // Map real status fields → picker status key
  function statusToPickerKey(status, storageLocation){
    if(status==='confirmed') return 'confirmed';
    if(status==='stored' && storageLocation==='av_storage') return 'stored-av';
    if(status==='stored' && storageLocation==='faculty_storage') return 'stored-faculty';
    if(status==='offmap') return 'offmap';
    if(status==='gone') return 'gone';
    return null; // unreviewed or marker-tied status (relocated)
  }

  function openAckModal(roomCode){
    ackAssignments.clear();
    // Title shows the room code; subtitle shows the space name (from imports) if available.
    const codeInline = document.getElementById('ack-room-code-inline');
    if(codeInline) codeInline.textContent = roomCode;
    const imported = importedAssets.find(a=>a.spaceNumber===roomCode);
    ackRoomSub.textContent = imported?.spaceName || '';
    ackRoomSub.style.display = imported?.spaceName ? 'block' : 'none';
    // Reset offmap input
    getAckOffmapSegs().forEach(seg=>{ if(seg){ seg.value=''; seg.classList.remove('invalid'); } });
    setAckStatus('confirmed'); // default tab

    // Show every imported asset in this room. Marker-tied rows render in a
    // read-only "📍 placed" state with a "remove marker" action.
    const assets = importedAssets.filter(a=>a.spaceNumber===roomCode);
    if(assets.length===0) return;

    // Count newcomers + "moved in" assets physically inside this room.
    // - newcomers: markers with isNew flag inside the polygon
    // - moved in: imported markers whose original spaceNumber differs from this room
    //             (surveyor dragged a marker here from elsewhere)
    // Both are excluded from the Examine list (which is keyed on original room),
    // so we surface their counts here so the surveyor knows the room total.
    const roomPath = findPathByRoomCode(roomCode);
    let newcomerCount = 0;
    let movedInCount = 0;
    if(roomPath){
      markers.forEach(m=>{
        if(!isMarkerInRoom(m, roomPath)) return;
        if(m.isNew){ newcomerCount++; return; }
        const ia = assetById(m.assetId);
        if(ia && ia.spaceNumber && ia.spaceNumber !== roomCode){
          movedInCount++;
        }
      });
    }
    const hint=document.getElementById('ack-hint');
    if(hint){
      let txt = `Total assets found: ${assets.length} imports`;
      if(movedInCount>0){
        txt += ` + ${movedInCount} moved in (not shown)`;
      }
      if(newcomerCount>0){
        txt += ` + ${newcomerCount} newcomer${newcomerCount===1?'':'s'} (not shown)`;
      }
      hint.textContent = txt;
    }

    // Pre-fill any existing off-map location (use the first offmap asset's location)
    const firstOffmap = assets
      .map(a=>getAssetStatus(a.assetId))
      .find(s=>s?.status==='offmap' && s.offmapLocation);
    if(firstOffmap?.offmapLocation){
      offmapValueToSegsOnModal(firstOffmap.offmapLocation);
    }

    ackList.innerHTML='';
    assets.forEach(a=>{
      const idStr=String(a.assetId);
      const s=getAssetStatus(idStr);
      const hasMarker=markers.some(m=>String(m.assetId)===idStr && !m.isNew);
      const pickerKey=statusToPickerKey(s?.status, s?.storageLocation);

      // Pill class reflects the SAVED status — same outlined/filled/dotted scheme
      // as the right panel. Computed once per render, doesn't update on tab clicks.
      const pillClass=pillClassForStatus(s?.status);

      // Label markup: same rules as the right panel.
      //   - strikethrough when status removes the asset from this room (relocated/offmap/stored/gone)
      //   - italic + custom name when surveyor changed the model name
      const customName=s?.customName||null;
      const isStruck=s?.status==='relocated'||s?.status==='offmap'||s?.status==='stored'||s?.status==='gone';
      const labelClasses='ack-asset-label'+(isStruck?' strikethrough':'')+(customName?' renamed':'');
      const labelText=customName||a.model||equipLabel(a.equipType);

      // Green right-edge indicator: same rule as the right panel — any deliberate
      // status (confirmed/relocated/offmap/stored/gone) means "accounted for".
      const isAccounted=!!s?.status;

      const row=document.createElement('div');
      row.className='ack-asset-row'+(isAccounted?' accounted':'');
      row.dataset.id=idStr;
      if(hasMarker){
        // Marker-tied: read-only with remove-marker affordance.
        // The marker icon is the same teardrop-pin SVG used in the right panel.
        row.classList.add('is-marked');
        row.innerHTML=`
          <div class="ack-check ack-marked" title="On map">
            ${pinSvg({fill:'#0a8ab0',attrs:'aria-hidden="true"'})}
          </div>
          <span class="${pillClass}">${escHtml(idStr)}</span>
          <span class="ack-asset-emoji">${equipEmoji(a.equipType)}</span>
          <div class="ack-asset-info">
            <div class="${labelClasses}">${escHtml(labelText)}</div>
            <div class="ack-asset-sub">${escHtml(equipLabel(a.equipType))} · on map</div>
          </div>
          <button class="ack-remove-marker" data-id="${escHtml(idStr)}" title="Remove marker">✕ remove marker</button>`;
        // Remove-marker handler
        row.querySelector('.ack-remove-marker').addEventListener('click',(ev)=>{
          ev.stopPropagation();
          handleAckRemoveMarker(idStr,row);
        });
      } else {
        if(pickerKey){
          ackAssignments.set(idStr, pickerKey);
          row.dataset.assigned=pickerKey;
        }
        row.innerHTML=`
          <div class="ack-check"></div>
          <span class="${pillClass}">${escHtml(idStr)}</span>
          <span class="ack-asset-emoji">${equipEmoji(a.equipType)}</span>
          <div class="ack-asset-info">
            <div class="${labelClasses}">${escHtml(labelText)}</div>
            <div class="ack-asset-sub">${escHtml(equipLabel(a.equipType))}</div>
          </div>`;
        row.addEventListener('click',()=>toggleRow(idStr,row));
      }
      ackList.appendChild(row);
    });
    updateConfirmLabel();
    syncSelectAll();
    ackOverlay.classList.add('open');
  }

  // Helper: write a dotted value into the offmap 4-segment inputs
  function offmapValueToSegsOnModal(val){
    const parts=(val||'').split('.').concat(['','','','']).slice(0,4);
    const segs=getAckOffmapSegs();
    segs.forEach((s,i)=>{ if(s){ s.value=parts[i]||''; s.classList.remove('invalid'); } });
    // enable/disable progression
    segs.forEach((s,j)=>{ if(j>0&&s) s.disabled=!segs[j-1]?.value.trim(); });
  }

  // Pill class for an Examine row, derived from the asset's SAVED status
  // (not pending). Recomputed only at row-render time and after Apply.
  // Mirrors the right panel's outlined / filled / dotted scheme.
  function pillClassForStatus(status){
    let cls='asset-id-pill cyan';
    if(status==='confirmed') cls+=' filled';
    else if(status==='relocated'||status==='offmap'||status==='stored'||status==='gone') cls+=' dotted';
    return cls;
  }

  // Click a row under a tab:
  //   - if row already has this tab's status → clear assignment
  //   - else → assign current tab's status (overwriting any previous)
  function toggleRow(idStr, row){
    const current=ackAssignments.get(idStr);
    if(current===ackStatus){
      ackAssignments.delete(idStr);
      row.removeAttribute('data-assigned');
    } else {
      ackAssignments.set(idStr, ackStatus);
      row.dataset.assigned=ackStatus;
    }
    updateConfirmLabel();
    syncSelectAll();
  }

  // Remove the marker for this asset, clear status, and offer Undo via toast.
  function handleAckRemoveMarker(idStr, row){
    // Snapshot the marker + status so Undo can restore them
    const markerSnap = markerForAsset(idStr);
    if(!markerSnap) return; // shouldn't happen
    const snap = {
      marker: { ...markerSnap },
      status: getAssetStatus(idStr) ? { ...getAssetStatus(idStr) } : null
    };

    // Apply removal: drop marker + clear status
    markers = markers.filter(m=>!(String(m.assetId)===idStr && !m.isNew));
    setAssetStatus(idStr, null);
    commit();

    // Swap row to the unhandled state in-place. Status was just cleared
    // so labelClasses simplifies to no strikethrough; customName also gone.
    const ia = assetById(idStr);
    if(ia && row && row.parentNode){
      row.classList.remove('is-marked');
      row.classList.remove('accounted');
      row.removeAttribute('data-assigned');
      row.innerHTML=`
        <div class="ack-check"></div>
        <span class="asset-id-pill cyan">${escHtml(idStr)}</span>
        <span class="ack-asset-emoji">${equipEmoji(ia.equipType)}</span>
        <div class="ack-asset-info">
          <div class="ack-asset-label">${escHtml(ia.model||equipLabel(ia.equipType))}</div>
          <div class="ack-asset-sub">${escHtml(equipLabel(ia.equipType))}</div>
        </div>`;
      row.addEventListener('click',()=>toggleRow(idStr,row));
    }
    updateConfirmLabel(); syncSelectAll();
    if(selectedPath) showInfoBar(selectedPath);

    // Show undoable toast
    showUndoToast(`Marker removed for ${idStr}`, ()=>{
      // Restore marker + status
      markers.push(snap.marker);
      if(snap.status){
        setAssetStatus(idStr, snap.status.status, snap.status.room, snap.status.storageLocation, snap.status.customName, snap.status.offmapLocation);
      }
      commit();

      // If the modal is still open, swap row back to marker-tied with full markup parity
      if(ackOverlay.classList.contains('open') && row && row.parentNode){
        row.classList.add('is-marked');
        ackAssignments.delete(idStr);
        row.removeAttribute('data-assigned');
        const sNow=getAssetStatus(idStr);
        const pillClass=pillClassForStatus(sNow?.status);
        const customName=sNow?.customName||null;
        const isStruck=sNow?.status==='relocated'||sNow?.status==='offmap'||sNow?.status==='stored'||sNow?.status==='gone';
        const labelClasses='ack-asset-label'+(isStruck?' strikethrough':'')+(customName?' renamed':'');
        const labelText=customName||ia.model||equipLabel(ia.equipType);
        row.classList.toggle('accounted', !!sNow?.status);
        row.innerHTML=`
          <div class="ack-check ack-marked" title="On map">
            ${pinSvg({fill:'#0a8ab0',attrs:'aria-hidden="true"'})}
          </div>
          <span class="${pillClass}">${escHtml(idStr)}</span>
          <span class="ack-asset-emoji">${equipEmoji(ia.equipType)}</span>
          <div class="ack-asset-info">
            <div class="${labelClasses}">${escHtml(labelText)}</div>
            <div class="ack-asset-sub">${escHtml(equipLabel(ia.equipType))} · on map</div>
          </div>
          <button class="ack-remove-marker" data-id="${escHtml(idStr)}" title="Remove marker">✕ remove marker</button>`;
        row.querySelector('.ack-remove-marker').addEventListener('click',(ev)=>{
          ev.stopPropagation();
          handleAckRemoveMarker(idStr,row);
        });
        updateConfirmLabel(); syncSelectAll();
      }
      if(selectedPath) showInfoBar(selectedPath);
    });
  }

  // "Select all" on the active tab: assigns all rows in the list to current status.
  // Toggling again when every row is already on this status clears those assignments.
  function syncSelectAll(){
    // Marker-tied rows are read-only; exclude them.
    const rows=[...ackList.querySelectorAll('.ack-asset-row:not(.is-marked)')];
    if(rows.length===0){ ackAllRow.classList.remove('selected'); return; }
    const allOnThis=rows.every(r=>ackAssignments.get(r.dataset.id)===ackStatus);
    ackAllRow.classList.toggle('selected', allOnThis);
  }

  function updateConfirmLabel(){
    // Count changes vs stored state (includes clearings)
    // Marker-tied rows are read-only; don't count them.
    const rows=[...ackList.querySelectorAll('.ack-asset-row:not(.is-marked)')];
    let changes=0;
    rows.forEach(r=>{
      const idStr=r.dataset.id;
      const s=getAssetStatus(idStr);
      const currentKey=statusToPickerKey(s?.status, s?.storageLocation);
      const newKey=ackAssignments.get(idStr)||null;
      if(currentKey!==newKey) changes++;
    });
    ackConfirm.textContent = changes>0 ? `Apply (${changes})` : 'Apply';
    ackConfirm.disabled = changes===0;
    ackConfirm.style.opacity = changes===0 ? '0.4' : '1';
  }

  ackAllRow.addEventListener('click',()=>{
    const rows=[...ackList.querySelectorAll('.ack-asset-row:not(.is-marked)')];
    const allOnThis=rows.length>0 && rows.every(r=>ackAssignments.get(r.dataset.id)===ackStatus);
    if(allOnThis){
      // Clear only rows currently on this status
      rows.forEach(r=>{
        if(ackAssignments.get(r.dataset.id)===ackStatus){
          ackAssignments.delete(r.dataset.id);
          r.removeAttribute('data-assigned');
        }
      });
    } else {
      // Heading-toward-assigning-everything: warn if there are rows
      // already on a DIFFERENT status (we'd overwrite them). Rows
      // already on this status need no warning — they stay put.
      const conflicting = rows.filter(r=>{
        const a=ackAssignments.get(r.dataset.id);
        return a && a!==ackStatus;
      }).length;
      if(conflicting>0){
        const ok = confirm('This will overwrite the status on '+conflicting+
          ' currently selected asset'+(conflicting===1?'':'s')+'. Are you sure?');
        if(!ok) return;
      }
      rows.forEach(r=>{
        ackAssignments.set(r.dataset.id, ackStatus);
        r.dataset.assigned=ackStatus;
      });
    }
    updateConfirmLabel();
    syncSelectAll();
  });

  ackCancel.addEventListener('click',()=>ackOverlay.classList.remove('open'));
  ackOverlay.addEventListener('pointerdown',e=>{ if(e.target===ackOverlay) ackOverlay.classList.remove('open'); });

  ackConfirm.addEventListener('click',()=>{
    // Build the set of row IDs currently in the modal (excluding marker-tied,
    // which are read-only and not part of the bulk assignment loop).
    const modalRowIds=[...ackList.querySelectorAll('.ack-asset-row:not(.is-marked)')].map(r=>r.dataset.id);

    // Detect if anything changed — needed because Option A pre-fills existing statuses.
    // A "change" is any row whose new assignment differs from its current stored status.
    let anyChange=false;
    modalRowIds.forEach(idStr=>{
      const s=getAssetStatus(idStr);
      const currentKey=statusToPickerKey(s?.status, s?.storageLocation);
      const newKey=ackAssignments.get(idStr)||null;
      if(currentKey!==newKey) anyChange=true;
    });
    if(!anyChange){ ackOverlay.classList.remove('open'); return; }

    // Validate offmap location if any asset is assigned to offmap
    let offmapLoc=null;
    const hasOffmap=[...ackAssignments.values()].includes('offmap');
    if(hasOffmap){
      offmapLoc=getAckOffmapValue();
      const seg0=document.getElementById('ackOffmapSeg0');
      if(!offmapLoc){
        if(seg0){ seg0.classList.add('invalid'); seg0.focus(); }
        setAckStatus('offmap'); // jump to the offmap tab so user sees the error
        return;
      }
    }

    // Counts for the toast
    const counts={confirmed:0, stored:0, offmap:0, gone:0, cleared:0};

    modalRowIds.forEach(idStr=>{
      const newPicker=ackAssignments.get(idStr)||null;
      if(!newPicker){
        // Row is un-assigned in the modal — clear any existing status
        const existed=getAssetStatus(idStr);
        if(existed){
          setAssetStatus(idStr, null);
          counts.cleared++;
        }
        return;
      }
      // Map picker status → (realStatus, storageLocation)
      let realStatus=newPicker, storageLoc=null, thisOffmap=null;
      if(newPicker==='stored-av'){ realStatus='stored'; storageLoc='av_storage'; }
      else if(newPicker==='stored-faculty'){ realStatus='stored'; storageLoc='faculty_storage'; }
      else if(newPicker==='offmap'){ thisOffmap=offmapLoc; }

      pushUndoSnapshot(idStr);
      // Pass undefined for customName so setAssetStatus preserves any existing
      // rename (the bulk picker has no name input — it's a status-only action).
      setAssetStatus(idStr, realStatus, ackRoomCode, storageLoc, undefined, thisOffmap);
      if(realStatus==='offmap'||realStatus==='stored'||realStatus==='gone'){
        markers=markers.filter(mx=>!(String(mx.assetId)===idStr&&!mx.isNew));
      }
      counts[realStatus]=(counts[realStatus]||0)+1;
    });

    ackOverlay.classList.remove('open');
    renderMarkers();
    renderPanel();
    saveToStorage();
    if(selectedPath) showInfoBar(selectedPath);

    // Build summary toast
    const parts=[];
    if(counts.confirmed) parts.push(`${counts.confirmed} confirmed`);
    if(counts.stored)    parts.push(`${counts.stored} stored`);
    if(counts.offmap)    parts.push(`${counts.offmap} off-map`);
    if(counts.gone)      parts.push(`${counts.gone} gone`);
    if(counts.cleared)   parts.push(`${counts.cleared} cleared`);
    showFpToast(`✓ Updated ${ackRoomCode}: ${parts.join(' · ')}`);
  });
}



function renderPanel(){
  renderAssetsTab();
  renderNewTab();
  renderMoversTab();
}

function renderAssetsTab(){
  const listEl=document.getElementById('asset-room-list');
  const emptyEl=document.getElementById('panel-empty-assets');
  listEl.innerHTML='';

  if(importedAssets.length===0){
    emptyEl.style.display='';
    return;
  }
  emptyEl.style.display='none';

  // Group by spaceNumber
  const byRoom={};
  importedAssets.forEach(a=>{
    if(!byRoom[a.spaceNumber]) byRoom[a.spaceNumber]={name:a.spaceName,assets:[]};
    byRoom[a.spaceNumber].assets.push(a);
  });

  Object.entries(byRoom).sort(([a],[b])=>a.localeCompare(b)).forEach(([code,{name,assets}])=>{
    const total=assets.length;
    // Count assets with any deliberate survey status
    const done=assets.filter(a=>{
      const s=getAssetStatus(a.assetId);
      return !!(s&&['confirmed','relocated','offmap','stored','gone'].includes(s.status));
    }).length;
    const progressClass=done===0?'pending':(done===total?'done':'progress');

    const grp=document.createElement('div');
    grp.className='room-group';

    const path=findPathByRoomCode(code);
    const isSelected=selectedPath&&getRoomCode(selectedPath)===code;
    const isVisited=path&&path.classList.contains('fp-visited');

    grp.innerHTML=`
      <div class="room-group-header${isSelected?' selected':''}${isVisited?' visited':''}" data-code="${escHtml(code)}">
        <svg class="room-group-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 2l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="room-sel-dot"></div>
        <div class="room-visited-dot"></div>
        <div class="room-group-code">${escHtml(code)}</div>
        <div class="room-asset-count ${progressClass}">${done}/${total}</div>
      </div>
      <div class="room-assets"></div>`;

    const header=grp.querySelector('.room-group-header');
    const assetsDiv=grp.querySelector('.room-assets');

    // Build asset items
    assets.forEach(a=>{
      const assetIdStr=String(a.assetId);
      const placedMarker=markerForAsset(assetIdStr);
      const savedStatus=getAssetStatus(assetIdStr);
      const status=savedStatus?.status||null;
      const customName=placedMarker?.customName||savedStatus?.customName||null;

      // Pill style: outlined for untouched, filled for confirmed, dotted for non-map statuses
      let pillClass='asset-id-pill cyan';
      if(status==='confirmed') pillClass+=' filled';
      else if(status==='relocated'||status==='offmap'||status==='stored'||status==='gone') pillClass+=' dotted';

      // Right-side icon
      let rightIcon='';
      let labelTitle='';
      if(status==='confirmed'){
        if(placedMarker){
          rightIcon=pinSvg({cls:'asset-marker-icon jumpable',fill:'#0a8ab0',w:0,h:0,attrs:'data-jump-marker="'+escHtml(String(placedMarker.id))+'"'});
        } else {
          // Panel-confirmed, no marker — show ✅ emoji (same as "In a room" option)
          rightIcon=`<span class="asset-marker-icon" title="Confirmed (no marker)" style="font-size:13px;line-height:1;">✅</span>`;
        }
      } else if(status==='relocated'){
        const destRoom=placedMarker?.roomCode||savedStatus?.room||getRoomFromMarker(placedMarker)||null;
        rightIcon=`<span class="asset-status-icon" data-asset="${escHtml(assetIdStr)}" data-action="movers">📦</span>`;
        labelTitle=destRoom?`Moved to ${destRoom}`:'Moved — position unknown';
      } else if(status==='offmap'){
        rightIcon=`<span class="asset-status-icon" data-asset="${escHtml(assetIdStr)}" data-action="movers">📦</span>`;
        labelTitle=savedStatus?.offmapLocation?`Moved to ${savedStatus.offmapLocation}`:'Moved off-map';
      } else if(status==='stored'){
        const loc=savedStatus?.storageLocation==='av_storage'?'AV Storage':'Faculty Storage';
        rightIcon=`<span class="asset-status-icon" data-asset="${escHtml(assetIdStr)}" data-action="movers">🗄️</span>`;
        labelTitle=`In ${loc}`;
      } else if(status==='gone'){
        rightIcon=`<span class="asset-status-icon" data-asset="${escHtml(assetIdStr)}" data-action="movers">🗑️</span>`;
        labelTitle='Marked as gone';
      } else if(placedMarker){
        // Placed but no status yet — faint marker (rare edge case)
        rightIcon=pinSvg({cls:'asset-marker-icon jumpable',fill:'rgba(10,138,176,.4)',w:0,h:0,attrs:'data-jump-marker="'+escHtml(String(placedMarker.id))+'"'});
      }

      const isStruck=status==='relocated'||status==='offmap'||status==='stored'||status==='gone';
      // Right-border signal: any deliberate status means accounted for
      const isAccounted=!!status;

      const item=document.createElement('div');
      item.className='asset-item'+(isAccounted?' accounted':'');
      item.dataset.assetid=assetIdStr;
      item.style.cursor='pointer'; // all rows clickable
      if(labelTitle) item.setAttribute('title',labelTitle);
      item.innerHTML=`
        <span class="${pillClass}">${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label${isStruck?' strikethrough':''}${customName?' renamed':''}">
            ${escHtml(customName||a.model||equipLabel(a.equipType))}
          </div>
          <div class="asset-sub">${escHtml(equipLabel(a.equipType))}</div>
        </div>
        ${rightIcon}`;

      item.addEventListener('click',e=>{
        e.stopPropagation();
        // Pin icon on the right → jump to that marker on the floor
        // (zoom + frame the room). The pin only renders for assets that
        // have a placed marker, so jumpToMarker always finds one.
        const jumpEl=e.target.closest('[data-jump-marker]');
        if(jumpEl){
          jumpToMarker(jumpEl.getAttribute('data-jump-marker'));
          return;
        }
        if(isStruck){
          // Jump to Movers tab
          renderMoversTab();
          const moversTab=document.getElementById('moversTab');
          if(moversTab){
            document.querySelectorAll('.panel-tab').forEach(t=>t.classList.remove('active'));
            moversTab.classList.add('active');
            document.getElementById('panel-body-assets').classList.add('hidden');
            document.getElementById('panel-body-new').classList.add('hidden');
            document.getElementById('panel-body-movers').classList.remove('hidden');
          }
          setTimeout(()=>{
            // Scope to the Movers panel — both Imports and Movers rows have
            // data-assetid, and querySelector returns the first match (the
            // Imports one, which isn't inside a .room-group).
            const moversBody=document.getElementById('panel-body-movers');
            const target=moversBody?.querySelector(`.asset-item[data-assetid="${assetIdStr}"]`);
            if(target){
              // The Movers tab groups some sections (Moved by destination,
              // Off-map by location) under collapsible room-groups. If the
              // target sits inside one, expand it before scrolling.
              const grp=target.closest('.room-group');
              if(grp && !grp.classList.contains('open')){
                moversBody.querySelectorAll('.room-group').forEach(g=>g.classList.remove('open'));
                grp.classList.add('open');
              }
              target.scrollIntoView({block:'nearest',behavior:'smooth'});
              target.classList.remove('flash');
              void target.offsetWidth;
              target.classList.add('flash');
            }
          },80);
        } else {
          // Open asset modal from panel
          openAssetEditor({assetId:a.assetId});
        }
      });

      assetsDiv.appendChild(item);
    });

    // Click header to toggle expand + select room on map
    header.addEventListener('click',()=>{
      const isOpen=grp.classList.contains('open');
      listEl.querySelectorAll('.room-group').forEach(g=>g.classList.remove('open'));
      if(!isOpen){
        grp.classList.add('open');
        const path=findPathByRoomCode(code);
        if(path) selectRoom(path);
      } else {
        selectRoom(null);
      }
    });

    if(isSelected) grp.classList.add('open');
    listEl.appendChild(grp);
  });
}

function renderNewTab(){
  const listEl=document.getElementById('new-room-list');
  const emptyEl=document.getElementById('panel-empty-new');
  const discoStrip=document.getElementById('panel-disco-strip');
  const discoText=document.getElementById('disco-status-text');
  const eyeDisco=document.getElementById('btnEyeDisco');
  listEl.innerHTML='';

  const total=newAssets.length;
  if(total>0){
    discoText.textContent=total+' unregistered asset'+(total>1?'s':'');
    discoStrip.classList.add('has-data');
    if(eyeDisco) eyeDisco.classList.add('visible');
  } else {
    discoText.textContent='No newcomers yet';
    discoStrip.classList.remove('has-data');
    if(eyeDisco) eyeDisco.classList.remove('visible');
  }

  if(newAssets.length===0){
    emptyEl.style.display='';
    return;
  }
  emptyEl.style.display='none';

  // Group by spaceNumber
  const byRoom={};
  newAssets.forEach(a=>{
    if(!byRoom[a.spaceNumber]) byRoom[a.spaceNumber]=[];
    byRoom[a.spaceNumber].push(a);
  });

  Object.entries(byRoom).sort(([a],[b])=>a.localeCompare(b)).forEach(([code,assets])=>{
    const total=assets.length;
    const done=assets.filter(a=>a.checked).length;
    const progressClass=done===0?'pending':(done===total?'done':'progress');

    const path=findPathByRoomCode(code);
    const isSelected=selectedPath&&getRoomCode(selectedPath)===code;
    const isVisited=path&&path.classList.contains('fp-visited');

    const grp=document.createElement('div');
    grp.className='room-group';
    grp.innerHTML=`
      <div class="room-group-header${isSelected?' selected':''}${isVisited?' visited':''}" data-code="${escHtml(code)}">
        <svg class="room-group-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 2l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="room-sel-dot"></div>
        <div class="room-visited-dot"></div>
        <div class="room-group-code">${escHtml(code)}</div>
        <div class="room-asset-count ${progressClass}">${done}/${total}</div>
      </div>
      <div class="room-assets"></div>`;

    const header=grp.querySelector('.room-group-header');
    const assetsDiv=grp.querySelector('.room-assets');

    assets.forEach(a=>{
      const placedMarker=markers.find(m=>m.assetId===a.assetId&&m.isNew);
      const isPlaced=!!placedMarker;
      const markerIcon=isPlaced
        ?pinSvg({cls:'asset-marker-icon jumpable',fill:'#c020a0',w:0,h:0,attrs:'data-jump-marker="'+escHtml(String(placedMarker.id))+'"'})
        :'';
      const item=document.createElement('div');
      item.className='asset-item';
      item.innerHTML=`
        <span class="asset-id-pill magenta">${escHtml(a.assetId)}</span>
        <span class="asset-emoji">${equipEmoji(a.equip)}</span>
        <div class="asset-info">
          <div class="asset-label new-asset">${escHtml(a.label||'')}</div>
          <div class="asset-sub">${escHtml(equipLabel(a.equip))}</div>
        </div>
        ${markerIcon}`;
      item.addEventListener('click',e=>{
        e.stopPropagation();
        const jumpEl=e.target.closest('[data-jump-marker]');
        if(jumpEl){
          jumpToMarker(jumpEl.getAttribute('data-jump-marker'));
          return;
        }
        if(isPlaced){
          openAssetEditor({markerId:placedMarker.id});
        } else {
          openNewcomerEditor(a.assetId);
        }
      });
      assetsDiv.appendChild(item);
    });

    header.addEventListener('click',()=>{
      const isOpen=grp.classList.contains('open');
      listEl.querySelectorAll('.room-group').forEach(g=>g.classList.remove('open'));
      if(!isOpen){
        grp.classList.add('open');
        const path=findPathByRoomCode(code);
        if(path) selectRoom(path);
      } else {
        selectRoom(null);
      }
    });
    if(isSelected) grp.classList.add('open');
    listEl.appendChild(grp);
  });
}

function renderMoversTab(){
  const moversTab=document.getElementById('moversTab');
  const emptyEl=document.getElementById('panel-empty-movers');
  const roomListEl=document.getElementById('movers-room-list');
  const storedEl=document.getElementById('movers-stored-section');
  const goneEl=document.getElementById('movers-gone-section');
  if(!moversTab||!roomListEl) return;

  // Shared reset button (text, triggers full reset to imported state)
  const undoBtnHtml=`<button class="asset-undo-btn" data-undo title="Reset to imported state">reset</button>`;

  // Collect mover assets
  const relocated=[], offmap=[], avStored=[], facStored=[], gone=[];

  // Build a lookup from assetId → importedAsset (may be empty if Excel not loaded)
  const iaMap={};
  importedAssets.forEach(a=>{ iaMap[String(a.assetId)]=a; });

  // Iterate assetStatuses as the authoritative source
  Object.entries(assetStatuses).forEach(([idStr,s])=>{
    if(!s||!s.status) return;
    const a=iaMap[idStr]||{assetId:idStr, model:s.customName||idStr, equipType:'display', spaceNumber:s.room||'Unknown'};
    const m=markerForAsset(idStr);
    if(s.status==='relocated') relocated.push({a,m,s});
    else if(s.status==='offmap') offmap.push({a,m,s});
    else if(s.status==='stored'&&s.storageLocation==='av_storage') avStored.push({a,m,s});
    else if(s.status==='stored'&&s.storageLocation==='faculty_storage') facStored.push({a,m,s});
    else if(s.status==='gone') gone.push({a,m,s});
  });

  const hasAny=relocated.length||offmap.length||avStored.length||facStored.length||gone.length;

  // Show/hide tab
  moversTab.style.display=hasAny?'':'none';
  if(!hasAny){
    // If currently on movers tab, switch back to assets
    if(moversTab.classList.contains('active')){
      document.querySelectorAll('.panel-tab').forEach(t=>t.classList.remove('active'));
      const assetsTab=document.querySelector('.panel-tab[data-tab="assets"]');
      if(assetsTab) assetsTab.classList.add('active');
      document.getElementById('panel-body-assets').classList.remove('hidden');
      document.getElementById('panel-body-movers').classList.add('hidden');
    }
    return;
  }

  roomListEl.innerHTML='';
  emptyEl.style.display='none';

  // ── Relocated rooms ───────────────────────────────────────
  const byRoom={};
  relocated.forEach(({a,m,s})=>{
    // Prefer the marker's stored roomCode (set at placement time) over
    // the live bounding-box hit-test, which can fail if the room paths
    // haven't been laid out yet or the marker is right on a boundary.
    // The marker may also be missing entirely (relocated via the modal's
    // "remove marker" confirm); fall back to the saved status's room.
    const dest=(m&&m.roomCode)||getRoomFromMarker(m)||s.room||'Position unknown';
    if(!byRoom[dest]) byRoom[dest]=[];
    byRoom[dest].push({a,m,s});
  });

  if(Object.keys(byRoom).length){
    const hdr=document.createElement('div');
    hdr.className='movers-section-header';
    hdr.textContent='📦 Moved';
    roomListEl.appendChild(hdr);
  }

  const isSelected=selectedPath&&getRoomCode(selectedPath);
  Object.entries(byRoom).sort(([a],[b])=>a.localeCompare(b)).forEach(([dest,items])=>{
    const grp=document.createElement('div');
    grp.className='room-group';
    grp.innerHTML=`
      <div class="room-group-header" data-code="${escHtml(dest)}">
        <svg class="room-group-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 2l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="room-sel-dot"></div>
        <div class="room-visited-dot"></div>
        <div class="room-group-code">${escHtml(dest)}</div>
      </div>
      <div class="room-assets"></div>`;
    const assetsDiv=grp.querySelector('.room-assets');
    items.forEach(({a,m,s})=>{
      const assetIdStr=String(a.assetId);
      const markerSvg=pinSvg({cls:'asset-marker-icon',fill:'#0a8ab0',w:0,h:0});
      const item=document.createElement('div');
      item.className='asset-item';
      item.dataset.assetid=assetIdStr;
      item.innerHTML=`
        <span class="asset-id-pill cyan">${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label${(s?.customName||m?.customName)?' renamed':''}" title="Originally in ${escHtml(a.spaceNumber)}">${escHtml(s?.customName||m?.customName||a.model||equipLabel(a.equipType))}</div>
          <div class="asset-sub">${escHtml(equipLabel(a.equipType))}</div>
        </div>
        ${undoBtnHtml}`;
      assetsDiv.appendChild(item);
    });
    const header=grp.querySelector('.room-group-header');
    header.addEventListener('click',()=>{
      const isOpen=grp.classList.contains('open');
      roomListEl.querySelectorAll('.room-group').forEach(g=>g.classList.remove('open'));
      if(!isOpen){
        grp.classList.add('open');
        const path=findPathByRoomCode(dest);
        if(path) selectRoom(path);
      } else {
        selectRoom(null);
      }
    });
    if(isSelected===dest) grp.classList.add('open');
    roomListEl.appendChild(grp);
  });

  // ── Off-map section ───────────────────────────────────────
  if(offmap.length){
    const hdr=document.createElement('div');
    hdr.className='movers-section-header';
    hdr.textContent='📦 Off-map';
    roomListEl.appendChild(hdr);

    // Group by offmapLocation
    const byLoc={};
    offmap.forEach(({a,s})=>{
      const loc=s.offmapLocation||'Unknown';
      if(!byLoc[loc]) byLoc[loc]=[];
      byLoc[loc].push({a,s});
    });

    Object.entries(byLoc).sort(([a],[b])=>a.localeCompare(b)).forEach(([loc,items])=>{
      const grp=document.createElement('div');
      grp.className='room-group';
      grp.innerHTML=`
        <div class="room-group-header">
          <svg class="room-group-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M4 2l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="room-sel-dot" style="display:none"></div>
          <div class="room-visited-dot" style="display:none"></div>
          <div class="room-group-code">${escHtml(loc)}</div>
        </div>
        <div class="room-assets"></div>`;
      const assetsDiv=grp.querySelector('.room-assets');
      items.forEach(({a,s})=>{
        const assetIdStr=String(a.assetId);
        const item=document.createElement('div');
        item.className='asset-item';
        item.dataset.assetid=assetIdStr;
        item.innerHTML=`
          <span class="asset-id-pill cyan">${escHtml(assetIdStr)}</span>
          <span class="asset-emoji">${equipEmoji(a.equipType)}</span>
          <div class="asset-info">
            <div class="asset-label${s.customName?' renamed':''}" title="Originally in ${escHtml(a.spaceNumber||'')}">${escHtml(s.customName||a.model||equipLabel(a.equipType))}</div>
            <div class="asset-sub">${escHtml(equipLabel(a.equipType))}</div>
          </div>
          ${undoBtnHtml}`;
        assetsDiv.appendChild(item);
      });
      const header=grp.querySelector('.room-group-header');
      header.addEventListener('click',()=>{
        const isOpen=grp.classList.contains('open');
        roomListEl.querySelectorAll('.room-group').forEach(g=>g.classList.remove('open'));
        if(!isOpen) grp.classList.add('open');
      });
      roomListEl.appendChild(grp);
    });
  }
  function renderStoredSection(items, label, container){
    container.innerHTML='';
    if(!items.length) return;
    const hdr=document.createElement('div');
    hdr.className='movers-section-header';
    hdr.textContent=label;
    container.appendChild(hdr);
    items.forEach(({a,m,s})=>{
      const assetIdStr=String(a.assetId);
      const item=document.createElement('div');
      item.className='asset-item';
      item.dataset.assetid=assetIdStr;
      item.innerHTML=`
        <span class="asset-id-pill cyan">${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label${(s?.customName||m?.customName)?' renamed':''}">${escHtml(s?.customName||m?.customName||a.model||equipLabel(a.equipType))}</div>
          <div class="asset-sub">${escHtml(equipLabel(a.equipType))}</div>
        </div>
        ${undoBtnHtml}`;
      container.appendChild(item);
    });
  }
  renderStoredSection(avStored,'🗄️ AV Storage',storedEl);

  // Faculty storage — append after AV in same container
  if(facStored.length){
    const hdr=document.createElement('div');
    hdr.className='movers-section-header';
    hdr.textContent='🗄️ Faculty Storage';
    storedEl.appendChild(hdr);
    facStored.forEach(({a,m,s})=>{
      const assetIdStr=String(a.assetId);
      const item=document.createElement('div');
      item.className='asset-item';
      item.dataset.assetid=assetIdStr;
      item.innerHTML=`
        <span class="asset-id-pill cyan">${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label${(s?.customName||m?.customName)?' renamed':''}">${escHtml(s?.customName||m?.customName||a.model||equipLabel(a.equipType))}</div>
          <div class="asset-sub">${escHtml(equipLabel(a.equipType))}</div>
        </div>
        ${undoBtnHtml}`;
      storedEl.appendChild(item);
    });
  }

  // ── Gone section ──────────────────────────────────────────
  goneEl.innerHTML='';
  if(gone.length){
    const hdr=document.createElement('div');
    hdr.className='movers-section-header';
    hdr.textContent='🗑️ Gone';
    goneEl.appendChild(hdr);
    gone.forEach(({a,m,s})=>{
      const assetIdStr=String(a.assetId);
      const item=document.createElement('div');
      item.className='asset-item';
      item.dataset.assetid=assetIdStr;
      item.innerHTML=`
        <span class="asset-id-pill cyan dotted">${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label${(s?.customName||m?.customName)?' renamed':''}">${escHtml(s?.customName||m?.customName||a.model||equipLabel(a.equipType))}</div>
          <div class="asset-sub">${escHtml(equipLabel(a.equipType))}</div>
        </div>
        ${undoBtnHtml}`;
      goneEl.appendChild(item);
    });
  }
}

// Delegated click handler for the Movers tab.
//   - Click on the undo button → undoAssetStatus
//   - Click anywhere else on an asset row → open the asset editor modal
(function wireMoversTabClicks(){
  const moversPanel=document.getElementById('panel-body-movers');
  if(!moversPanel) return;
  moversPanel.addEventListener('click',e=>{
    const undoBtn=e.target.closest('[data-undo]');
    if(undoBtn){
      const row=undoBtn.closest('.asset-item');
      const assetId=row?.dataset.assetid;
      if(!assetId) return;
      e.stopPropagation();
      resetAssetToImported(assetId);
      return;
    }
    const row=e.target.closest('.asset-item');
    if(!row) return;
    const assetId=row.dataset.assetid;
    if(!assetId) return;
    e.stopPropagation();
    openAssetEditor({assetId});
  });
})();
// Uses SheetJS (XLSX) loaded from CDN
const importInput= document.getElementById('importFileInput');

// Multiple entry points all trigger the same file picker:
//   - Data modal → Import Excel button
//   - Imports tab empty-state Import button
document.getElementById('btn-import-excel')?.addEventListener('click',()=>{
  document.getElementById('advOverlay').classList.remove('open'); // close Data modal before picker opens
  importInput.click();
});
document.getElementById('btn-empty-import')?.addEventListener('click',()=>importInput.click());

importInput.addEventListener('change',e=>{
  const file=e.target.files[0];
  if(!file) return;
  importInput.value=''; // reset so same file can be re-imported

  if(typeof XLSX==='undefined'){
    showFpToast('SheetJS not loaded — check network connection',true);
    return;
  }

  const reader=new FileReader();
  reader.onload=ev=>{
    try{
      const wb=XLSX.read(ev.target.result,{type:'array'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{defval:''});
      // Parse + categorise rows, then show the filter modal. The modal
      // confirms (or cancels) before any state actually changes.
      const parsed=parseImportRows(rows);
      openImportFilterModal(file.name, parsed);
    }catch(err){
      showFpToast('Could not read Excel file: '+err.message, true);
    }
  };
  reader.readAsArrayBuffer(file);
});

// ── Import: parse + categorise (no side effects) ─────────────
// Reads raw Excel rows and produces:
//   matched:     array of asset objects whose Equipment Type maps to one
//                of our 21 known types AND whose Space Number is on this floor
//   unmatched:   Map<rawTypeString, count> for rows on this floor whose
//                Equipment Type doesn't map to any known type
//   skippedFloor: count of rows on other floors (logged to console as before)
function parseImportRows(rows){
  const norm=s=>String(s||'').replace(/\u00a0/g,' ').trim().toLowerCase();
  // No floor-prefix filtering at parse time. The import modal groups the
  // matched rows by storey and lets the user pick which storeys to import.
  // (When a floor IS loaded, the modal still defaults to ticking only that
  // storey, mirroring the previous behaviour.)

  const matched=[];
  const unmatched=new Map();

  rows.forEach(row=>{
    const keys=Object.keys(row);
    const get=name=>{ const k=keys.find(k=>norm(k)===norm(name)); return k?String(row[k]||'').trim():''; };
    // Legacy exports had an "ID" column; the newer URL-style export
    // tucks the id into the Equipment Type URL (e.g. "/admin/data/avrack/106/change/").
    const legacyId=get('ID');
    const spaceNumber=get('Space Number');
    const spaceName=get('Space Name');
    const equipType=get('Equipment Type');
    const model=get('Model');
    const serialNumber=get('Sn');
    // Detail fields surfaced in the modal's cog drawer. Empty values are
    // dropped at populate-time so blank rows never render.
    const dateInOperation    = get('Date in Operation');
    const ipAddress          = get('IP Address');
    const macAddress         = get('Mac Address');
    const hostname           = get('Hostname');
    // Firmware: newer exports split into Main/Sub. Treat "Main" as the
    // canonical firmware (drops "Sub"). Fall back to the legacy column
    // name so files in the old format still import correctly.
    const firmware           = get('Main Firmware') || get('Firmware');
    const firmwareInstalledOn= get('Main Firmware Installed On') || get('Firmware Installed On');
    const outlet             = get('Outlet');
    const switchPortInfo     = get('Switch port info');
    const staging            = get('Staging');
    // New optional fields in the URL-style export.
    const dateOfReplacement  = get('Date of Replacement');
    const costs              = get('Costs');
    const comments           = get('Comments');
    if(!spaceNumber) return;

    const mappedType=excelTypeToValue(equipType);
    if(mappedType==null){
      // Equipment type doesn't match any of the known types. Bucket by
      // the raw string (or URL slug, if the cell looks like a URL) so
      // the modal can show the user exactly what's in their file.
      const slug=extractStiplTypeSlug(equipType);
      const rawKey=slug || String(equipType||'').trim() || '(blank)';
      unmatched.set(rawKey, (unmatched.get(rawKey)||0)+1);
      return;
    }

    // Prefer the URL-embedded id when present (stable, matches Stipl's
    // back-end), then fall back to the legacy ID column, then a random
    // synthetic id for files that have neither.
    const stiplId=extractStiplTypeId(equipType);
    const assetId=stiplId || legacyId || ('?_'+Math.random().toString(36).slice(2));

    matched.push({
      assetId,
      spaceNumber,
      spaceName,
      equipType: mappedType,
      model: model||equipType||'Unknown',
      serialNumber: serialNumber||'',
      details: {
        dateInOperation, ipAddress, macAddress, hostname, firmware,
        firmwareInstalledOn, outlet, switchPortInfo, staging,
        dateOfReplacement, costs, comments
      },
    });
  });

  return { matched, unmatched };
}

// ── Import: filter modal ─────────────────────────────────────
// Persisted user preference for which equipment types to import.
// Stored as a JSON array of value strings (e.g. ["displays","cameras"]).
// Missing key → first-ever import → fall back to preselected:true defaults.
const EQUIP_FILTER_KEY='fp_equip_filter';

function loadEquipFilterSelection(){
  try{
    const raw=localStorage.getItem(EQUIP_FILTER_KEY);
    if(!raw) return null;
    const arr=JSON.parse(raw);
    if(!Array.isArray(arr)) return null;
    return new Set(arr.filter(v=>typeof v==='string'));
  }catch(e){ return null; }
}

function saveEquipFilterSelection(selectedSet){
  try{
    localStorage.setItem(EQUIP_FILTER_KEY, JSON.stringify([...selectedSet]));
  }catch(e){ /* quota or disabled — silent */ }
}

function openImportFilterModal(filename, parsed){
  const overlay=document.getElementById('importFilterOverlay');
  const filenameEl=document.getElementById('importFilterFilename');
  const subhead=document.getElementById('importFilterSubhead');
  const body=document.getElementById('importFilterBody');
  const confirmBtn=document.getElementById('importFilterConfirm');
  const cancelBtn=document.getElementById('importFilterCancel');
  const toggleAllBtn=document.getElementById('importFilterToggleAll');
  if(!overlay||!body||!confirmBtn||!cancelBtn) return;

  filenameEl.textContent=filename||'';

  // ── Build per-type and per-storey indexes from the matched rows ─────────
  //
  // typeCounts: equipType -> total count across all storeys in the file
  // storeyHits: storey   -> { count, hasSvg, isNew }
  //   count   = rows for this storey (filtered later by selectedTypes)
  //   hasSvg  = the storey record has an SVG attached
  //   isNew   = the storey is not yet known to AVScout (will be auto-created)

  const typeCounts=new Map();
  const storeyRows=new Map();      // storey -> [matched rows]
  parsed.matched.forEach(a=>{
    typeCounts.set(a.equipType, (typeCounts.get(a.equipType)||0)+1);
    const s=storeyOf(a.spaceNumber);
    if(!s) return;
    if(!storeyRows.has(s)) storeyRows.set(s, []);
    storeyRows.get(s).push(a);
  });

  // Determine initial TYPE selection: saved state if present, else preselected
  const saved=loadEquipFilterSelection();
  const selectedTypes=new Set();
  EQUIP.forEach(t=>{
    if(!typeCounts.has(t.v)) return;
    const initial = saved ? saved.has(t.v) : !!t.p;
    if(initial) selectedTypes.add(t.v);
  });

  // Determine initial STOREY selection: all storeys in the file ticked.
  // Bulk-import is the common case; users can untick individual rows.
  const selectedStoreys=new Set(storeyRows.keys());

  // We need to know which storeys already exist (so we can label "(new)").
  // listStoreys is async; render once with a "loading" stub, then refresh.
  let knownStoreysMap=new Map(); // storey -> {hasSvg}

  // ── Render ─────────────────────────────────────────────────────────────
  const matchedTypesAlpha=EQUIP.filter(t=>typeCounts.has(t.v))
    .slice().sort((a,b)=>a.l.localeCompare(b.l));

  // Helper: count rows matching the currently selected types in a given storey
  function storeyHitCount(storey){
    const rows=storeyRows.get(storey)||[];
    let n=0;
    for(const r of rows) if(selectedTypes.has(r.equipType)) n++;
    return n;
  }

  // Helper: total = rows that satisfy BOTH selectedTypes AND selectedStoreys
  function totalHitCount(){
    let n=0;
    parsed.matched.forEach(a=>{
      if(!selectedTypes.has(a.equipType)) return;
      const s=storeyOf(a.spaceNumber);
      if(!selectedStoreys.has(s)) return;
      n++;
    });
    return n;
  }

  function render(){
    const noMatched = matchedTypesAlpha.length===0;

    let html='';

    // Section 1: by equipment type
    if(noMatched){
      html += '<div class="import-filter-empty">No equipment in this file matches known types.</div>';
    } else {
      html += '<div class="import-filter-section-label">By equipment type</div>';
      html += '<div class="import-filter-list">';
      html += matchedTypesAlpha.map(t=>{
        const checked=selectedTypes.has(t.v)?'checked':'';
        const count=typeCounts.get(t.v);
        return '<label class="import-filter-row" data-axis="type" data-type="'+t.v+'">'
          +'<input type="checkbox" '+checked+'/>'
          +'<span class="if-emoji">'+t.e+'</span>'
          +'<span class="if-label">'+escHtml(t.l)+'</span>'
          +'<span class="if-count">'+count+' total</span>'
          +'</label>';
      }).join('');
      html += '</div>';
    }

    // Section 2: by floor (grouped by building)
    if(storeyRows.size > 0 && !noMatched){
      // Group by building (first segment of storey code)
      const byBuilding=new Map();
      for(const s of storeyRows.keys()){
        const b=buildingCodeOf(s);
        if(!byBuilding.has(b)) byBuilding.set(b, []);
        byBuilding.get(b).push(s);
      }
      const buildings=[...byBuilding.keys()].sort();

      html += '<div class="import-filter-section-label">By floor</div>';
      html += '<div class="import-filter-list import-filter-storey-list">';

      for(const b of buildings){
        const storeys=byBuilding.get(b).sort();
        html += '<div class="import-filter-building">';
        html += '<div class="import-filter-building-head">Building '+escHtml(b)+'</div>';
        for(const s of storeys){
          const hits=storeyHitCount(s);
          const checked=selectedStoreys.has(s)?'checked':'';
          const known=knownStoreysMap.get(s);
          let badge;
          if(!known){
            // Either not yet known or storey list still loading; show neutral
            badge='<span class="if-svg-state new" title="Will be created">○ (new)</span>';
          } else if(known.hasSvg){
            badge='<span class="if-svg-state attached" title="Floorplan attached">📐</span>';
          } else {
            badge='<span class="if-svg-state detached" title="No floorplan yet">○</span>';
          }
          html += '<label class="import-filter-row import-filter-storey-row" data-axis="storey" data-storey="'+escHtml(s)+'">'
            +'<input type="checkbox" '+checked+'/>'
            +'<span class="if-label">'+escHtml(floorLabel(s))+'</span>'
            +badge
            +'<span class="if-count">'+hits+' hit'+(hits===1?'':'s')+'</span>'
            +'</label>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // Section 3: unmatched (unchanged — these are equipment types we don't know)
    if(parsed.unmatched.size>0){
      const totalUnmatched=[...parsed.unmatched.values()].reduce((s,n)=>s+n,0);
      const rowsHtml=[...parsed.unmatched.entries()]
        .sort((a,b)=>a[0].localeCompare(b[0]))
        .map(([raw,n])=>
          '<div class="import-filter-row unmatched">'
          +'<span class="if-emoji">·</span>'
          +'<span class="if-label">'+escHtml(raw)+'</span>'
          +'<span class="if-count">'+n+' found</span>'
          +'</div>'
        ).join('');
      html += '<div class="import-filter-divider">'
        +'<div class="import-filter-section-label">Not matched ('+totalUnmatched+')</div>'
        +'<div class="import-filter-section-help">These don\'t match any of the 21 known equipment types. They will not be imported.</div>'
        +'<div class="import-filter-list">'+rowsHtml+'</div>'
        +'</div>';
    }

    body.innerHTML=html;

    if(noMatched){
      subhead.textContent='No equipment in this file matches the known equipment types.';
      toggleAllBtn.style.visibility='hidden';
    } else {
      subhead.textContent='Choose which equipment types and floors to import. Hit counts update as you toggle.';
      toggleAllBtn.style.visibility='visible';
    }

    wireRows();
    updateConfirmButton();
    updateToggleAllLabel();
  }

  function updateConfirmButton(){
    const total=totalHitCount();
    confirmBtn.textContent='Import '+total+' asset'+(total===1?'':'s');
    confirmBtn.disabled = (total===0);
  }
  function updateToggleAllLabel(){
    const allTypesOn   = matchedTypesAlpha.every(t=>selectedTypes.has(t.v));
    const allStoreysOn = [...storeyRows.keys()].every(s=>selectedStoreys.has(s));
    toggleAllBtn.textContent = (allTypesOn && allStoreysOn) ? 'Select none' : 'Select all';
  }
  // Update storey row hit-counts without re-rendering the whole modal
  function refreshStoreyCounts(){
    body.querySelectorAll('.import-filter-storey-row').forEach(row=>{
      const s=row.dataset.storey;
      const n=storeyHitCount(s);
      const countEl=row.querySelector('.if-count');
      if(countEl) countEl.textContent = n+' hit'+(n===1?'':'s');
    });
  }

  function wireRows(){
    // Type rows
    body.querySelectorAll('.import-filter-row[data-axis="type"]').forEach(row=>{
      const cb=row.querySelector('input[type="checkbox"]');
      const v=row.dataset.type;
      row.addEventListener('click',e=>{
        if(e.target!==cb) cb.checked=!cb.checked;
        if(cb.checked) selectedTypes.add(v); else selectedTypes.delete(v);
        refreshStoreyCounts();   // a type toggle changes per-storey hit counts
        updateConfirmButton();
        updateToggleAllLabel();
      });
    });
    // Storey rows
    body.querySelectorAll('.import-filter-row[data-axis="storey"]').forEach(row=>{
      const cb=row.querySelector('input[type="checkbox"]');
      const s=row.dataset.storey;
      row.addEventListener('click',e=>{
        if(e.target!==cb) cb.checked=!cb.checked;
        if(cb.checked) selectedStoreys.add(s); else selectedStoreys.delete(s);
        updateConfirmButton();
        updateToggleAllLabel();
      });
    });
  }

  render();

  // Resolve which storeys are already known (to show 📐 / ○ / (new) badges).
  // Done asynchronously after the initial render to avoid blocking.
  (async ()=>{
    try{
      const known=await __storage.listStoreys();
      knownStoreysMap=new Map();
      for(const rec of known){
        knownStoreysMap.set(rec.storey, { hasSvg: !!rec.svg });
      }
      render(); // Re-render with badges resolved
    }catch(e){
      console.warn('[import] could not list storeys:', e);
    }
  })();

  toggleAllBtn.onclick=()=>{
    const allTypesOn   = matchedTypesAlpha.every(t=>selectedTypes.has(t.v));
    const allStoreysOn = [...storeyRows.keys()].every(s=>selectedStoreys.has(s));
    const turnOn = !(allTypesOn && allStoreysOn);
    if(turnOn){
      matchedTypesAlpha.forEach(t=>selectedTypes.add(t.v));
      storeyRows.forEach((_,s)=>selectedStoreys.add(s));
    } else {
      selectedTypes.clear();
      selectedStoreys.clear();
    }
    render();
  };

  function close(){
    overlay.classList.remove('open');
    cancelBtn.onclick=null;
    confirmBtn.onclick=null;
    toggleAllBtn.onclick=null;
    overlay.onclick=null;
  }
  cancelBtn.onclick=close;
  overlay.onclick=e=>{ if(e.target===overlay) close(); };

  confirmBtn.onclick=async ()=>{
    if(confirmBtn.disabled) return;
    saveEquipFilterSelection(selectedTypes);
    // Split matched rows by destination storey, filtered by both axes.
    const byStorey=new Map(); // storey -> rows[]
    parsed.matched.forEach(a=>{
      if(!selectedTypes.has(a.equipType)) return;
      const s=storeyOf(a.spaceNumber);
      if(!selectedStoreys.has(s)) return;
      if(!byStorey.has(s)) byStorey.set(s, []);
      byStorey.get(s).push(a);
    });
    close();
    await commitMultiStoreyImport(filename, byStorey);
  };

  overlay.classList.add('open');
}

// ── Import: commit rows to one or more storeys ───────────────────────────
//
// Multi-storey commit. Splits the row set by destination storey and writes
// each storey's rows into its own IDB scope. For storeys that don't exist
// yet, creates the record (no SVG attached). After all writes complete,
// the page is reloaded so the active storey re-reads its imports from
// IDB.
//
// byStorey: Map<storeyCode, matchedRows[]>
async function commitMultiStoreyImport(filename, byStorey){
  if(byStorey.size === 0) return;

  // Flush in-memory state of the active storey first, so we don't lose
  // anything when the page reloads.
  saveToStorage();

  let totalAdded=0, totalDupes=0;
  const summaryParts=[];

  for(const [storey, rows] of byStorey.entries()){
    try{
      // 1. Ensure the storey record exists (may auto-create with no SVG)
      await __storage.createStoreyIfMissing(storey, storey);

      // 2. Read the existing per-storey state (from IDB)
      const SK_this = 'fp_state_' + (function(){
        let h=5381;
        for(let i=0;i<storey.length;i++) h=((h<<5)+h)^storey.charCodeAt(i);
        return (h>>>0).toString(36);
      })();
      const raw = await __storage.getSurveyItem(storey, SK_this);
      let state;
      try { state = raw ? JSON.parse(raw) : null; } catch(e){ state=null; }
      if(!state) state = { markers:[], visited:[], newAssets:[], assetStatuses:{}, lastSnapshot:null, importedAssets:[] };

      // 3. Append new rows, dedup by assetId
      const existing = new Set(
        (state.importedAssets||[]).map(a=>String(a.assetId))
            .concat((state.markers||[]).filter(m=>m.assetId&&!m.isNew).map(m=>String(m.assetId)))
      );
      let added=0, dupes=0;
      for(const r of rows){
        const idStr=String(r.assetId);
        if(existing.has(idStr)){ dupes++; continue; }
        state.importedAssets.push(r);
        existing.add(idStr);
        added++;
      }
      totalAdded += added; totalDupes += dupes;

      // 4. Write back
      await __storage.setSurveyItem(storey, SK_this, JSON.stringify(state));
      summaryParts.push(`${storey}: +${added}` + (dupes?` (${dupes} dup)`:''));
    }catch(e){
      console.error('[import] failed for storey', storey, e);
      summaryParts.push(`${storey}: failed`);
    }
  }

  // Reload to pick up the new state — this is the simplest way to flush
  // the active storey's in-memory view and re-render the rail.
  const msg = `✓ Imported ${totalAdded} asset${totalAdded===1?'':'s'} across ${byStorey.size} floor${byStorey.size===1?'':'s'}`
            + (totalDupes ? ` · ${totalDupes} dup${totalDupes===1?'':'s'}` : '');
  showFpToast(msg, false, 2500);
  // Stash a follow-up toast for after reload so the user sees confirmation,
  // and ask the rail-setup to open the right panel so the Imports tab is
  // visible immediately (matches the old commitImport's setPanelOpen(true)).
  try {
    sessionStorage.setItem('avscout:postReloadToast', msg);
    sessionStorage.setItem('avscout:postReloadOpenPanel', '1');
  } catch(e){}
  setTimeout(()=>location.reload(), 800);
}

// ── Storage ───────────────────────────────────────────────
//
// SK is the localStorage key the surveying app writes its state to.
// Boot.js installs a shim that routes any 'fp_state_*' read/write
// through SurveyKV (IndexedDB), scoped to the active storey. So this
// key just needs to be stable per-storey — anything storey-specific
// works, the hash is just a compact identifier.
const SK=(function(){
  // Derive from the storey code so it's stable across renames.
  const t = __safeStorey || __floorTitle || 'unknown';
  let h=5381;
  for(let i=0;i<t.length;i++) h=((h<<5)+h)^t.charCodeAt(i);
  return 'fp_state_'+(h>>>0).toString(36);
})();
function saveToStorage(){
  try{
    localStorage.setItem(SK,JSON.stringify({
      markers,
      visited,
      newAssets,
      assetStatuses,
      lastSnapshot,
      importedAssets
    }));
  }catch(e){}
}

// Standard "I just changed state" routine: re-render markers + panel, save
// to storage, refresh the info bar if a room is selected. 12+ call sites
// did this triplet (some plus the info-bar refresh) inline. Centralising
// makes intent clearer ("commit this change") and ensures the info bar
// stays in sync — a few sites used to skip it.
function commit(){
  renderMarkers(); renderPanel(); saveToStorage();
  if(selectedPath) showInfoBar(selectedPath);
}
function loadFromStorage(){
  try{
    const d=localStorage.getItem(SK);
    if(d){
      const p=JSON.parse(d);
      markers=p.markers||[];
      visited=p.visited||[];
      // Visited[] used to hold ifcguid strings. As of the data-room-code
      // refactor, it holds human-readable room codes. Strings that don't
      // look like a room code (building.wing.floor.room) are legacy entries; drop them.
      // Building is 1-3 digits; wing/floor are 2 alphanumeric chars; room is 3 digits.
      const ROOM_CODE_RE = /^\d{1,3}\.[A-Z0-9]{2}\.[A-Z0-9]{2}\.\d{3}$/;
      visited = visited.filter(v => typeof v === 'string' && ROOM_CODE_RE.test(v));
      newAssets=p.newAssets||[];
      assetStatuses=p.assetStatuses||{};
      // Backwards-compat: older builds persisted assetUndoStacks (a per-asset
      // array of snapshots). Translate to the new single-slot shape by taking
      // the most recent entry from each stack — that's all we ever read.
      if(p.lastSnapshot){
        lastSnapshot = p.lastSnapshot;
      } else if(p.assetUndoStacks){
        lastSnapshot = {};
        Object.keys(p.assetUndoStacks).forEach(k=>{
          const arr = p.assetUndoStacks[k];
          if(Array.isArray(arr) && arr.length) lastSnapshot[k] = arr[arr.length-1];
        });
      } else {
        lastSnapshot = {};
      }
      if(p.importedAssets&&p.importedAssets.length) importedAssets=p.importedAssets;
      // ── Migration: move m.status/m.storageLocation/m.customName → assetStatuses ──
      markers.forEach(m=>{
        if(!m.isNew&&(m.status||m.customName)){
          const key=String(m.assetId);
          if(!assetStatuses[key]) assetStatuses[key]={status:null,room:null,storageLocation:null,customName:null};
          if(m.status) assetStatuses[key].status=m.status;
          if(m.storageLocation) assetStatuses[key].storageLocation=m.storageLocation;
          if(m.customName) assetStatuses[key].customName=m.customName;
          delete m.status; delete m.storageLocation; delete m.customName; delete m.room;
        }
        // ── Migration: drop legacy bulkPlaced field (bulk placement feature removed) ──
        if('bulkPlaced' in m) delete m.bulkPlaced;
      });
    }
  }catch(e){}
}
loadFromStorage();
renderMarkers();
applyVisited();
renderPanel();

// ── Cache-loaded import strip: when imports were restored from localStorage ─
// (rather than freshly imported via the file picker), update the strip text
// and reveal the info button + eye button.
(function markStripIfCached(){
  if(!importedAssets || importedAssets.length===0) return;
  const strip=document.getElementById('panel-import-strip-inner');
  const statusText=document.getElementById('import-status-text2');
  const infoBtn=document.getElementById('btnImportCacheInfo');
  const eyeBtn=document.getElementById('btnEyeImports');
  if(strip) strip.classList.add('has-data');
  if(statusText) statusText.textContent='Imported from cache';
  if(infoBtn) infoBtn.style.display='inline-flex';
  if(eyeBtn) eyeBtn.classList.add('visible');
})();

// Reverse of markStripIfCached: returns the import strip to its empty/unimported
// look. Called by Reset Floor so the "Imported from cache" text doesn't linger
// after data is wiped.
function clearImportStripUI(){
  const strip=document.getElementById('panel-import-strip-inner');
  const statusText=document.getElementById('import-status-text2');
  const infoBtn=document.getElementById('btnImportCacheInfo');
  const eyeBtn=document.getElementById('btnEyeImports');
  if(strip) strip.classList.remove('has-data');
  if(statusText) statusText.textContent='No file imported';
  if(infoBtn) infoBtn.style.display='none';
  if(eyeBtn) eyeBtn.classList.remove('visible');
}

// Cache info modal: open / close
(function wireCacheInfoModal(){
  const overlay=document.getElementById('cacheInfoOverlay');
  const openBtn=document.getElementById('btnImportCacheInfo');
  const closeBtn=document.getElementById('cacheInfoClose');
  if(!overlay||!openBtn||!closeBtn) return;
  openBtn.addEventListener('click',()=>overlay.classList.add('open'));
  closeBtn.addEventListener('click',()=>overlay.classList.remove('open'));
  overlay.addEventListener('click',e=>{ if(e.target===overlay) overlay.classList.remove('open'); });
})();

// ── + button wiring ────────────────────────────────────
// The old secondary "ncomerOverlay" modal has been removed; the + button
// now opens the main asset modal in draft-newcomer mode.
(function wireAddNewcomer(){
  const stripBtn=document.getElementById('btnAddNewcomerStrip');
  const emptyBtn=document.getElementById('btnAddNewcomerEmpty');
  if(stripBtn) stripBtn.addEventListener('click',()=>openDraftNewcomerModal());
  if(emptyBtn) emptyBtn.addEventListener('click',()=>openDraftNewcomerModal());
})();

// ── Side panel: open on every launch, default to Imports tab ──
(function openPanelOnLaunch(){
  // Switch to Imports tab
  document.querySelectorAll('.panel-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.panel-body').forEach(b=>b.classList.add('hidden'));
  const assetsTab=document.querySelector('.panel-tab[data-tab="assets"]');
  const assetsBody=document.getElementById('panel-body-assets');
  if(assetsTab) assetsTab.classList.add('active');
  if(assetsBody) assetsBody.classList.remove('hidden');
  // Open the panel (small delay so the layout has settled)
  setTimeout(()=>setPanelOpen(true),200);
})();

// ── SVG snip optimisation ────────────────────────────────
// The original SVG carries the entire floor's architectural drawing (planDWG
// has thousands of <path>/<line> elements for every wall on the floor) plus
// every room polygon and label. A snip just crops the viewBox; everything
// else is invisible but still in the file. For a 200-room floor that's 1MB+
// of dead weight per snip.
//
// These helpers measure each candidate element on the LIVE original using
// getBoundingClientRect() (screen-pixel space — perfectly accurate, browser
// handles all the nested transforms). The intersect test against the user's
// crop rect (also screen pixels) tells us what to drop. We then prune the
// CLONE in lockstep using DOM order, so we never touch the live DOM.
//
// Usage in a snip flow:
//   const cropRect = { left, top, right, bottom };  // screen pixels
//   const drop     = buildSnipDropSet(origSvg, cropRect);
//   const cloned   = origSvg.cloneNode(true);
//   ...your existing prepareClone work on cloned...
//   applySnipDropSet(cloned, drop);
//   compressKeptSvg(cloned);
//   ...then set viewBox, append markers, serialize...

function _snipIntersects(rect, crop){
  // Note: we allow zero-width OR zero-height rects. Axis-aligned lines (stair
  // steps, wall edges, door jambs) report bbox height=0 or width=0 — they
  // are perfectly valid geometry that CAN intersect a crop region. Only
  // reject if the rect is missing entirely.
  if(!rect) return false;
  return !(rect.right  < crop.left  ||
           rect.left   > crop.right ||
           rect.bottom < crop.top   ||
           rect.top    > crop.bottom);
}

// Measure the live original SVG; return a Set of "drop indices" formatted as
// '<bucket>:<i>' where bucket is dwg / room / label and i is the element's
// position in document order within that bucket.
//
// Room polygons + labels are paired by data-room-code: a room is kept if EITHER its
// polygon OR its label intersects the crop. Prevents orphan labels.
//
// Diagnostic logging: set window.SNIP_DEBUG = true (in the page console)
// before snipping to dump per-inner-svg keep/drop counts and sample bboxes.
function buildSnipDropSet(origSvg, cropRect){
  const drop = new Set();
  const DEBUG = (typeof window !== 'undefined' && window.SNIP_DEBUG === true);

  // 1. planDWG drawing elements (walls, doors, lines, arcs)
  const dwgItems = origSvg.querySelectorAll(
    '#planDWG path, #planDWG line, #planDWG circle, #planDWG rect'
  );

  // Group elements by their nearest <svg> ancestor inside #planDWG, so we can
  // tell if a particular inner-svg layer is losing all its content.
  let groupStats = null;
  let zeroRectCount = 0;
  if(DEBUG){
    groupStats = new Map(); // svg ancestor → {kept: [], dropped: [], svgInfo}
    console.group('🔍 buildSnipDropSet diagnostic');
    console.log('cropRect (screen px):', cropRect);
    console.log('Total planDWG drawing elements:', dwgItems.length);
  }

  dwgItems.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const intersects = _snipIntersects(rect, cropRect);

    if(DEBUG){
      // Find nearest <svg> ancestor inside #planDWG
      let svgAnc = el.parentElement;
      while(svgAnc && svgAnc.tagName !== 'svg' && svgAnc.id !== 'planDWG') svgAnc = svgAnc.parentElement;
      const key = svgAnc || 'planDWG-direct';
      if(!groupStats.has(key)){
        const info = (svgAnc && svgAnc.tagName === 'svg')
          ? `viewBox="${svgAnc.getAttribute('viewBox')||'?'}" w=${svgAnc.getAttribute('width')||'?'}`
          : 'direct child of planDWG';
        groupStats.set(key, { kept: [], dropped: [], svgInfo: info, svgEl: svgAnc });
      }
      const stat = groupStats.get(key);
      if(intersects){
        stat.kept.push({ i, tag: el.tagName, rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height } });
      } else {
        stat.dropped.push({ i, tag: el.tagName, rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height } });
      }
      if(rect.width === 0 && rect.height === 0) zeroRectCount++;
    }

    if(!intersects) drop.add('dwg:' + i);
  });

  if(DEBUG){
    console.log('Elements with zero-sized bbox (0×0):', zeroRectCount);
    console.log('Per-inner-svg breakdown:');
    let groupIdx = 0;
    groupStats.forEach((stat, anc) => {
      console.group(`Group #${groupIdx} — ${stat.svgInfo}`);
      console.log(`Kept: ${stat.kept.length}, Dropped: ${stat.dropped.length}`);

      // Also: bounding rect of THIS svg ancestor itself (if it's an svg element)
      if(stat.svgEl && stat.svgEl.getBoundingClientRect){
        const r = stat.svgEl.getBoundingClientRect();
        console.log(`This svg's own bbox: l=${r.left.toFixed(1)} t=${r.top.toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)}`);
        console.log(`Intersects crop? ${_snipIntersects(r, cropRect)}`);
      }
      // Show first 3 kept and first 3 dropped (samples)
      if(stat.kept.length){
        console.log('Kept samples (first 3):');
        stat.kept.slice(0, 3).forEach(s => console.log(`  [${s.i}] ${s.tag} l=${s.rect.l.toFixed(1)} t=${s.rect.t.toFixed(1)} w=${s.rect.w.toFixed(1)} h=${s.rect.h.toFixed(1)}`));
      }
      if(stat.dropped.length){
        console.log('Dropped samples (first 5):');
        stat.dropped.slice(0, 5).forEach(s => console.log(`  [${s.i}] ${s.tag} l=${s.rect.l.toFixed(1)} t=${s.rect.t.toFixed(1)} w=${s.rect.w.toFixed(1)} h=${s.rect.h.toFixed(1)}`));
        // Also dropped samples that are near the crop region (within 100px) — these are the suspicious ones
        const nearMisses = stat.dropped.filter(s => {
          const dx = Math.max(0, Math.max(cropRect.left - (s.rect.l + s.rect.w), s.rect.l - cropRect.right));
          const dy = Math.max(0, Math.max(cropRect.top - (s.rect.t + s.rect.h), s.rect.t - cropRect.bottom));
          return dx + dy < 100;
        });
        if(nearMisses.length){
          console.log(`Near misses (within 100px of crop, first 5 of ${nearMisses.length}):`);
          nearMisses.slice(0, 5).forEach(s => console.log(`  [${s.i}] ${s.tag} l=${s.rect.l.toFixed(1)} t=${s.rect.t.toFixed(1)} w=${s.rect.w.toFixed(1)} h=${s.rect.h.toFixed(1)}`));
        }
      }
      console.groupEnd();
      groupIdx++;
    });
    console.groupEnd();
  }

  // 2. Rooms + labels (paired by data-room-code)
  const allRooms  = origSvg.querySelectorAll('path.floor-plan-space');
  const allLabels = origSvg.querySelectorAll('g.space_text');

  // First pass: room → keep? (true if polygon intersects). Pair rooms
  // and labels by data-room-code; both elements get tagged at SVG load.
  const decisions = new Map();
  allRooms.forEach(poly => {
    const g = poly.getAttribute('data-room-code');
    if(!g) return;
    decisions.set(g, _snipIntersects(poly.getBoundingClientRect(), cropRect));
  });

  // Second pass: also keep if label anchor intersects
  allLabels.forEach(lbl => {
    const g = lbl.getAttribute('data-room-code');
    if(!g) return;
    if(decisions.get(g)) return;  // already keeping
    const c = lbl.querySelector('circle');
    if(c && _snipIntersects(c.getBoundingClientRect(), cropRect)){
      decisions.set(g, true);
    }
  });

  // Flag drops by index
  allRooms.forEach((poly, i) => {
    const g = poly.getAttribute('data-room-code');
    if(!g || !decisions.get(g)) drop.add('room:' + i);
  });
  allLabels.forEach((lbl, i) => {
    const g = lbl.getAttribute('data-room-code');
    if(!g || !decisions.get(g)) drop.add('label:' + i);
  });

  return drop;
}

// Remove flagged elements from the clone. cloneNode(true) preserves DOM order,
// so the i-th element in each bucket of the clone matches the i-th of the
// original — indices are stable.
function applySnipDropSet(cloned, drop){
  // planDWG drawing elements — drop directly
  const dwgItems = cloned.querySelectorAll(
    '#planDWG path, #planDWG line, #planDWG circle, #planDWG rect'
  );
  dwgItems.forEach((el, i) => { if(drop.has('dwg:' + i)) el.remove(); });

  // Room polygons — also remove the parent .floor-plan-object-container if
  // that's the polygon's only child (typical structure)
  const rooms = cloned.querySelectorAll('path.floor-plan-space');
  rooms.forEach((poly, i) => {
    if(!drop.has('room:' + i)) return;
    const parent = poly.parentNode;
    if(parent && parent.classList && parent.classList.contains('floor-plan-object-container')){
      parent.parentNode.removeChild(parent);
    } else if(poly.parentNode){
      poly.parentNode.removeChild(poly);
    }
  });

  // Labels
  const labels = cloned.querySelectorAll('g.space_text');
  labels.forEach((lbl, i) => { if(drop.has('label:' + i)) lbl.remove(); });
}

// Strip dead inline styles on KEPT planDWG elements. The defs CSS rule
//   #planDWG path, #planDWG circle, #planDWG line { stroke-width: 20 !important }
// already overrides every inline stroke-width. Stipl exports an inline
// 'stroke:#000000;stroke-width:100;' on every single drawing element — that's
// pure dead weight (typically ~26% of the file before clipping, ~14% after).
// We only strip the EXACT pattern; any other inline style stays untouched.
function compressKeptSvg(cloned){
  const STROKE_BLACK_RE = /^\s*stroke:\s*#0{3,6}\s*;\s*stroke-width:\s*\d+(\.\d+)?\s*;?\s*$/i;
  cloned.querySelectorAll(
    '#planDWG path, #planDWG line, #planDWG circle, #planDWG rect'
  ).forEach(el => {
    const s = el.getAttribute('style') || '';
    if(STROKE_BLACK_RE.test(s)) el.removeAttribute('style');
  });
}

// ── Advanced modal ────────────────────────────────────────
{
  const advOverlay = document.getElementById('advOverlay');
  const advBtn     = document.getElementById('btnAdvanced');
  const advClose   = document.getElementById('adv-close-btn');
  const btnExport  = document.getElementById('btn-export-survey');
  const btnExportExcel = document.getElementById('btn-export-excel');
  const btnResetFloor = document.getElementById('btn-reset-floor');
  const btnBulkSnip = document.getElementById('btn-bulk-snip');
  const advSummary = document.getElementById('adv-summary');
  // New delete-section buttons. Declared up here so refreshAdvSummary
  // can toggle their disabled state alongside the existing buttons.
  const btnDeleteAssetsAll = document.getElementById('btn-delete-assets-all');
  const btnDeleteThisSvg   = document.getElementById('btn-delete-this-floor-svg');
  const btnDeleteAllSvgs   = document.getElementById('btn-delete-all-floors-svg');
  const btnDeleteAll       = document.getElementById('btn-delete-everything');

  async function refreshAdvSummary(){
    const mCount = markers.filter(m=>!m.isNew).length;
    const ncCount = markers.filter(m=>m.isNew).length;
    const sCount = Object.values(assetStatuses).filter(s=>s&&s.status).length;
    const vCount = visited.length;
    const iCount = importedAssets.length;
    const lines=[];
    lines.push(`Imported assets: <span class="val">${iCount}</span>`);
    lines.push(`Markers: <span class="val">${mCount}</span>${ncCount>0?` (+${ncCount} newcomers)`:''}`);
    lines.push(`Survey statuses: <span class="val">${sCount}</span>`);
    lines.push(`Visited rooms: <span class="val">${vCount}</span>`);
    advSummary.innerHTML = lines.join('<br/>');

    // Per-floor button state — derived from in-memory state of the active floor.
    btnExport.disabled      = sCount===0 && ncCount===0;
    btnExportExcel.disabled = iCount===0 && ncCount===0;
    btnResetFloor.disabled  = mCount===0 && ncCount===0 && sCount===0 && vCount===0 && iCount===0;
    btnBulkSnip.disabled    = (mCount+ncCount)===0;
    // The "Delete this Floor" action detaches the SVG; only available
    // when one is attached. __hasFloor is set by initAVScout when an
    // SVG is mounted on the active floor.
    if (btnDeleteThisSvg) btnDeleteThisSvg.disabled = !__hasFloor;

    // Cross-floor button state — needs to look at every storey in IDB.
    // We disable optimistically (assume nothing to do) and re-enable
    // below if the listing turns up anything. This avoids a flash of
    // "enabled, then immediately disabled" while the DB query runs.
    if (btnDeleteAssetsAll) btnDeleteAssetsAll.disabled = true;
    if (btnDeleteAllSvgs)   btnDeleteAllSvgs.disabled   = true;
    if (btnDeleteAll)       btnDeleteAll.disabled       = true;

    try {
      const storeys = await __storage.listStoreys();
      // Has at least one storey record? (i.e. anything to factory-reset)
      const anyStoreys = storeys.length > 0;
      // Has at least one storey with an SVG attached?
      const anySvg = storeys.some(s => !!s.svg);
      // Has at least one storey with any survey rows? Active floor's
      // counts are already in memory; for others we ask IDB.
      let anySurvey = (mCount + ncCount + sCount + vCount + iCount) > 0;
      if (!anySurvey) {
        for (const s of storeys) {
          if (s.storey === __safeStorey) continue;
          const all = await __storage.getSurveyAll(s.storey);
          if (Object.keys(all).length > 0) { anySurvey = true; break; }
        }
      }
      if (btnDeleteAssetsAll) btnDeleteAssetsAll.disabled = !anySurvey;
      if (btnDeleteAllSvgs)   btnDeleteAllSvgs.disabled   = !anySvg;
      // "Delete EVERYTHING" is meaningful when there's literally
      // anything to delete — a storey record, an SVG, or a survey row.
      if (btnDeleteAll) btnDeleteAll.disabled = !(anyStoreys || anySurvey);
    } catch (e) {
      // If we can't read the DB, leave the cross-floor buttons disabled.
      // Better to make them grey than risk doing nothing on click.
    }
  }

  advBtn.addEventListener('click',()=>{
    refreshAdvSummary();
    advOverlay.classList.add('open');
  });
  advClose.addEventListener('click',()=>advOverlay.classList.remove('open'));
  advOverlay.addEventListener('pointerdown',e=>{ if(e.target===advOverlay) advOverlay.classList.remove('open'); });

  btnExport.addEventListener('click',()=>{
    if(btnExport.disabled) return;
    downloadSurveyDiff();
    showFpToast('✓ Survey exported');
    advOverlay.classList.remove('open');
  });

  btnExportExcel.addEventListener('click',()=>{
    if(btnExportExcel.disabled) return;
    if(typeof XLSX==='undefined'){
      showFpToast('SheetJS not loaded — check network',true);
      return;
    }
    downloadSurveyExcel();
    advOverlay.classList.remove('open');
  });

  // Wipe everything that belongs to the active floor's survey state.
  // Used by both "Delete Assets on this floor" (with confirm) and
  // "Delete Assets on all floors" (which calls this for the active
  // floor and additionally clears the IDB rows for other floors).
  function wipeActiveFloorSurvey() {
    markers=[];
    newAssets=[];
    assetStatuses={};
    lastSnapshot={};
    importedAssets=[];
    wrap.querySelectorAll('.fp-visited').forEach(el=>el.classList.remove('fp-visited'));
    visited=[];
    if(selectedPath){ selectedPath.classList.remove('fp-selected'); selectedPath.style.fill=''; selectedPath=null; showInfoBar(null); }
    removeImportHighlight();
    removeDiscoHighlight();
    clearImportStripUI();
    try{ localStorage.removeItem(SK); }catch(e){}
    renderMarkers();
    renderPanel();
  }

  btnResetFloor.addEventListener('click',()=>{
    if(btnResetFloor.disabled) return;

    // Build a breakdown of what will be deleted
    const counts={
      markers:    markers.filter(m=>!m.isNew).length,
      newcomers:  markers.filter(m=>m.isNew).length,
      statuses:   Object.values(assetStatuses).filter(s=>s&&s.status).length,
      visited:    visited.length,
      imports:    importedAssets.length
    };
    const lines=['Delete Assets on this floor will delete:', ''];
    if(counts.markers>0)  lines.push(`• ${counts.markers} marker${counts.markers===1?'':'s'}`);
    if(counts.newcomers>0)lines.push(`• ${counts.newcomers} newcomer${counts.newcomers===1?'':'s'}`);
    if(counts.statuses>0) lines.push(`• ${counts.statuses} survey status${counts.statuses===1?'':'es'}`);
    if(counts.visited>0)  lines.push(`• ${counts.visited} visited room${counts.visited===1?'':'s'}`);
    if(counts.imports>0)  lines.push(`• ${counts.imports} imported asset${counts.imports===1?'':'s'}`);
    lines.push('', 'Continue?');
    if(!confirm(lines.join('\n'))) return;

    wipeActiveFloorSurvey();
    advOverlay.classList.remove('open');
    showFpToast('✓ Assets deleted on this floor');
  });

  // ── Delete Assets on all floors ──────────────────────────────────────────
  if (btnDeleteAssetsAll) btnDeleteAssetsAll.addEventListener('click', async () => {
    if (!confirm(
      'Delete survey data on EVERY floor?\n\n' +
      'This removes markers, statuses, visited rooms, imported assets, and\n' +
      'newcomers from every floor. The floor records and floorplan SVGs stay.\n\n' +
      'Continue?'
    )) return;

    // Step 1: wipe the active floor's in-memory + cached state.
    wipeActiveFloorSurvey();

    // Step 2: drop the IDB survey rows for every other floor.
    try {
      const storeys = await __storage.listStoreys();
      for (const s of storeys) {
        if (s.storey === __safeStorey) continue; // active floor already handled
        await __storage.clearSurvey(s.storey);
      }
    } catch (e) {
      showFpToast('Could not clear all floors: ' + e.message, true);
      return;
    }

    advOverlay.classList.remove('open');
    showFpToast('✓ Assets deleted on every floor');
  });

  // ── Delete this Floor (= detach SVG, keep record + survey) ───────────────
  if (btnDeleteThisSvg) btnDeleteThisSvg.addEventListener('click', async () => {
    if (!confirm(
      'Detach the floorplan SVG from this floor?\n\n' +
      'The floor record and all survey data stay. You can attach a new SVG\n' +
      'later from the floor\'s ⚙ menu in the left rail.\n\n' +
      'Continue?'
    )) return;
    try {
      await __storage.detachSvg(__safeStorey);
      location.reload();
    } catch (e) {
      showFpToast('Could not detach: ' + e.message, true);
    }
  });

  // ── Delete all Floors (= detach every floor's SVG) ───────────────────────
  if (btnDeleteAllSvgs) btnDeleteAllSvgs.addEventListener('click', async () => {
    if (!confirm(
      'Drop the floorplan SVG from EVERY floor?\n\n' +
      'All floor records and survey data stay. Each floor will show as\n' +
      '"no SVG attached" until you re-attach one.\n\n' +
      'Continue?'
    )) return;
    try {
      const storeys = await __storage.listStoreys();
      for (const s of storeys) {
        if (s.svg) await __storage.detachSvg(s.storey);
      }
      location.reload();
    } catch (e) {
      showFpToast('Could not detach SVGs: ' + e.message, true);
    }
  });

  // ── Delete EVERYTHING (factory reset) ────────────────────────────────────
  if (btnDeleteAll) btnDeleteAll.addEventListener('click', async () => {
    if (!confirm(
      'FACTORY RESET — remove everything?\n\n' +
      'This will delete:\n' +
      '• every floor record\n' +
      '• every floorplan SVG\n' +
      '• every survey row (markers, statuses, imports, visited rooms)\n' +
      '• cached app code (service worker)\n' +
      '• local preferences (localStorage)\n\n' +
      'You will land on the welcome screen as if AVScout were freshly installed.\n\n' +
      'Continue?'
    )) return;

    try {
      // 1. Delete every floor (also wipes its survey rows).
      const storeys = await __storage.listStoreys();
      for (const s of storeys) {
        await __storage.deleteStorey(s.storey);
      }
      // 2. Clear localStorage.
      try { localStorage.clear(); } catch (e) {}
      // 3. Clear sessionStorage.
      try { sessionStorage.clear(); } catch (e) {}
      // 4. Unregister service workers and clear their caches so the next
      //    load fetches a fresh bundle.
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
      }
      if ('caches' in window) {
        const names = await caches.keys();
        for (const n of names) await caches.delete(n);
      }
    } catch (e) {
      showFpToast('Factory reset hit an error: ' + e.message, true);
      return;
    }

    // Hard navigate to the root so we don't carry any in-memory state forward.
    location.replace(location.pathname);
  });

  // ── Bulk snip: one SVG per room that has markers, bundled in a zip ──
  btnBulkSnip.addEventListener('click', async ()=>{
    if(btnBulkSnip.disabled) return;
    if(typeof JSZip==='undefined'){
      showFpToast('JSZip not loaded — check network',true);
      return;
    }
    // Group markers by the room polygon they sit inside (polygon-precise).
    const rooms = [...wrap.querySelectorAll('path.floor-plan-space')];
    const roomMarkers = new Map(); // roomPath → [markers…]
    markers.forEach(m=>{
      for(const rp of rooms){
        if(isMarkerInRoom(m, rp)){
          if(!roomMarkers.has(rp)) roomMarkers.set(rp,[]);
          roomMarkers.get(rp).push(m);
          break;
        }
      }
    });
    const entries = [...roomMarkers.entries()]; // [[roomPath, markers[]], ...]
    if(entries.length===0){
      showFpToast('No markers in any room to snip',true);
      return;
    }

    // UI: show progress bar
    const progressWrap = document.getElementById('bulk-snip-progress');
    const progressFill = document.getElementById('bulk-snip-fill');
    const progressText = document.getElementById('bulk-snip-text');
    btnBulkSnip.disabled = true;
    progressWrap.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = `Preparing 0 / ${entries.length}…`;

    const origSvg = wrap.querySelector('svg');
    if(!origSvg){ btnBulkSnip.disabled=false; progressWrap.style.display='none'; return; }

    // Coord conversion plumbing — same formulas single-snip uses (known-good).
    const canvRect = canvas.getBoundingClientRect();
    let vbX=0,vbY=0,vbW=origSvg.clientWidth,vbH=origSvg.clientHeight;
    const vb=origSvg.viewBox?.baseVal;
    if(vb&&vb.width>0){ vbX=vb.x; vbY=vb.y; vbW=vb.width; vbH=vb.height; }
    const svgDisplayW = origSvg.clientWidth || 900;
    const svgDisplayH = origSvg.clientHeight || 600;
    const scaleX = vbW / svgDisplayW;
    const scaleY = vbH / svgDisplayH;

    // Fixed render target: long side ~1600px (computed per room below).
    const BULK_MARGIN_FRAC = 0.25;

    const zip = new JSZip();
    const yieldToUI = () => new Promise(r => setTimeout(r, 0));

    for(let i=0; i<entries.length; i++){
      const [roomPath, roomMarkersList] = entries[i];
      const roomCode = getRoomCode(roomPath) || ('room_'+i);

      // Path screen bbox → world-px crop → SVG-unit crop (same path as single snip).
      const r = roomPath.getBoundingClientRect();
      const wx1 = (r.left  - canvRect.left - tx) / scale;
      const wy1 = (r.top   - canvRect.top  - ty) / scale;
      const wx2 = (r.right - canvRect.left - tx) / scale;
      const wy2 = (r.bottom- canvRect.top  - ty) / scale;
      // Inflate by margin in world-px before converting.
      const wMargin = (wx2-wx1) * BULK_MARGIN_FRAC;
      const hMargin = (wy2-wy1) * BULK_MARGIN_FRAC;
      const svgX = vbX + (wx1 - wMargin) * scaleX;
      const svgY = vbY + (wy1 - hMargin) * scaleY;
      const svgW = (wx2 - wx1 + wMargin*2) * scaleX;
      const svgH = (wy2 - wy1 + hMargin*2) * scaleY;

      // Prepare clone: strip visited tint, highlight the current room.
      const cloned = origSvg.cloneNode(true);
      cloned.querySelectorAll('.fp-visited').forEach(el=>el.classList.remove('fp-visited'));
      const rpCode = roomPath.getAttribute('data-room-code');
      if(rpCode){
        const selEl = cloned.querySelector('[data-room-code="'+rpCode.replace(/"/g,'')+'"]');
        if(selEl) selEl.style.fill='rgba(71,194,255,0.18)';
      }
      // Drop everything outside the (margin-inflated) crop rect. Same screen-
      // pixel space as the room's getBoundingClientRect() — margin inflated
      // proportionally so we keep the surrounding context the snip wants to show.
      {
        const sMarginX = r.width  * BULK_MARGIN_FRAC;
        const sMarginY = r.height * BULK_MARGIN_FRAC;
        const cropRectScreen = {
          left:   r.left   - sMarginX,
          top:    r.top    - sMarginY,
          right:  r.right  + sMarginX,
          bottom: r.bottom + sMarginY
        };
        const drop = buildSnipDropSet(origSvg, cropRectScreen);
        applySnipDropSet(cloned, drop);
        compressKeptSvg(cloned);
      }
      cloned.setAttribute('viewBox', `${svgX} ${svgY} ${svgW} ${svgH}`);
      // Output size: scale so the LONGER side is ~1200px — matches single snip.
      const TARGET_LONG_SIDE = 1200;
      const longestSvgSide = Math.max(svgW, svgH);
      const pxPerUnit = TARGET_LONG_SIDE / longestSvgSide;
      cloned.setAttribute('width',  String(Math.round(svgW * pxPerUnit)));
      cloned.setAttribute('height', String(Math.round(svgH * pxPerUnit)));
      cloned.removeAttribute('id');
      cloned.style.cssText='';

      // Overlay markers for this room (coords converted the same way).
      const markerGroup = document.createElementNS('http://www.w3.org/2000/svg','g');
      markerGroup.setAttribute('id','snip-markers');
      // Fixed marker font sizes in OUTER VIEWBOX UNITS. Markers live OUTSIDE
      // panzoomEl in the snip output, so they don't get the 8.74× scale that
      // the source's room-label text gets via panzoomEl matrix(8.74,...).
      // Room labels effectively render at 0.56 * 8.74 ≈ 4.9 outer units; we
      // pick slightly bigger for the emoji and slightly smaller for the
      // auxiliary text label.
      const MARKER_EMOJI_SIZE  = 6.1;
      const MARKER_LABEL_SIZE  = 4.4;
      const MARKER_LABEL_OFFSET = 7.0;
      roomMarkersList.forEach(m=>{
        const msx = vbX + m.x*scaleX;
        const msy = vbY + m.y*scaleY;
        const g = document.createElementNS('http://www.w3.org/2000/svg','g');
        const txt = document.createElementNS('http://www.w3.org/2000/svg','text');
        txt.setAttribute('x',String(msx)); txt.setAttribute('y',String(msy));
        txt.setAttribute('font-size',String(MARKER_EMOJI_SIZE)); txt.setAttribute('text-anchor','middle');
        txt.textContent = equipEmoji(m.equip||'displays');
        g.appendChild(txt);
        if(m.label){
          const lbl = document.createElementNS('http://www.w3.org/2000/svg','text');
          lbl.setAttribute('x',String(msx)); lbl.setAttribute('y',String(msy+MARKER_LABEL_OFFSET));
          lbl.setAttribute('font-size',String(MARKER_LABEL_SIZE)); lbl.setAttribute('text-anchor','middle');
          lbl.setAttribute('fill','#ff47c2'); lbl.setAttribute('font-family','sans-serif');
          lbl.textContent = m.label;
          g.appendChild(lbl);
        }
        markerGroup.appendChild(g);
      });
      cloned.appendChild(markerGroup);

      const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(cloned);
      const safeName = roomCode.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
      zip.file(safeName + '.svg', svgStr);

      const done = i+1;
      progressFill.style.width = ((done/entries.length)*100) + '%';
      progressText.textContent = `Snipping ${done} / ${entries.length}`;
      await yieldToUI();
    }

    progressText.textContent = `Building zip…`;
    await yieldToUI();

    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    // Chrome <a download> flattens folder paths, so a flat filename it is:
    // "<storey>_snips.zip" alongside everything else in Downloads.
    const storey = __safeStorey;
    const safeNameFn = s => String(s||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim() || 'floorplan';
    const dlPath = (storey ? safeNameFn(storey) : safeNameFn(document.title)) + '_snips.zip';

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = dlPath;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 5000);

    // Done
    progressWrap.style.display = 'none';
    btnBulkSnip.disabled = false;
    advOverlay.classList.remove('open');
    showFpToast(`✓ Snipped ${entries.length} room${entries.length===1?'':'s'} → ${dlPath}`);
  });

  // ── Backup AVScout (export entire DB as .zip) ───────────────────────────
  //
  // Bundles every floor's SVG and survey JSON into a single .zip.
  // Format:
  //   manifest.json    → { format, savedAt, floorCount }
  //   floors/<id>.svg  → raw SVG content per floor
  //   surveys/<id>.json → per-floor survey state (markers/statuses/etc.)
  //
  // The active floor's in-memory state may have unsaved edits that
  // haven't drained to IDB yet (SurveyKV is a write-through cache but
  // the buffer can lag). Drain it before reading to capture every byte.
  const btnBackup = document.getElementById('btn-backup-avscout');
  if (btnBackup) btnBackup.addEventListener('click', async () => {
    if (typeof JSZip === 'undefined') {
      showFpToast('JSZip not loaded — check network', true);
      return;
    }
    btnBackup.disabled = true;
    try {
      // Flush any pending writes for the active storey before reading.
      if (__storage && __storage.SurveyKV && typeof __storage.SurveyKV.drain === 'function') {
        try { await __storage.SurveyKV.drain(); } catch (_) {}
      }

      const storeys = await __storage.listStoreys();
      if (!storeys.length) {
        showFpToast('Nothing to back up — AVScout has no floors yet.', true);
        return;
      }

      const zip = new JSZip();
      let withSvg = 0;
      for (const s of storeys) {
        const id = s.storey; // dot form e.g. "17.00"
        if (s.svg) {
          zip.file(`floors/${id}.svg`, s.svg);
          withSvg++;
        }
        // Survey rows live in a separate store keyed by storey + key.
        // We don't try to interpret them here — the restore path will
        // write them back verbatim.
        const surveyRows = await __storage.getSurveyAll(s.storey);
        const surveyPayload = {
          storey: id,
          title: s.title || id,
          rows: surveyRows,
        };
        zip.file(`surveys/${id}.json`, JSON.stringify(surveyPayload));
      }

      const manifest = {
        format:      'avscout-bundle-v1',
        savedAt:     new Date().toISOString(),
        floorCount:  storeys.length,
        floorsWithSvg: withSvg,
      };
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));

      const blob = await zip.generateAsync({
        type:        'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      const stamp = new Date().toISOString().slice(0,10); // YYYY-MM-DD
      const filename = `avscout-backup-${stamp}.zip`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);

      advOverlay.classList.remove('open');
      showFpToast(`✓ Backed up ${storeys.length} floor${storeys.length===1?'':'s'} → ${filename}`);
    } catch (err) {
      showFpToast('Backup failed: ' + (err && err.message || 'unknown'), true);
    } finally {
      btnBackup.disabled = false;
    }
  });

  // ── Load Backup ─────────────────────────────────────────────────────────
  //
  // Reverse of Backup. Opens a file picker, accepts an .avscout-bundle-v1
  // ZIP, then restores each floor.
  //   - If the floor doesn't exist → create it (writes SVG + survey rows).
  //   - If the floor exists → confirm yes/no per floor, then replace if yes.
  //
  // After processing, reload onto the most recently-touched floor in the
  // backup so initAVScout re-mounts with the new state visible.
  const btnLoadBackup = document.getElementById('btn-load-backup');
  const loadBackupInput = document.getElementById('loadBackupInput');
  if (btnLoadBackup && loadBackupInput) {
    btnLoadBackup.addEventListener('click', () => loadBackupInput.click());
    loadBackupInput.addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      // Reset the input so picking the same file twice in a row still fires change.
      ev.target.value = '';
      if (!file) return;
      if (typeof JSZip === 'undefined') {
        showFpToast('JSZip not loaded — check network', true);
        return;
      }
      btnLoadBackup.disabled = true;
      try {
        const buf = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);

        // Validate manifest. Reject anything we don't know how to parse.
        const manifestFile = zip.file('manifest.json');
        if (!manifestFile) throw new Error('Not an AVScout backup (no manifest.json)');
        const manifest = JSON.parse(await manifestFile.async('string'));
        if (manifest.format !== 'avscout-bundle-v1') {
          throw new Error(`Unsupported backup format: ${manifest.format || '(none)'}`);
        }

        // Group ZIP entries by storey id so we can process each floor
        // atomically (SVG + survey together).
        const incoming = new Map(); // storeyId → { svg?, surveyPayload? }
        zip.forEach((path, entry) => {
          if (entry.dir) return;
          let m = path.match(/^floors\/([^/]+)\.svg$/);
          if (m) {
            const id = m[1];
            if (!incoming.has(id)) incoming.set(id, {});
            incoming.get(id).svgEntry = entry;
            return;
          }
          m = path.match(/^surveys\/([^/]+)\.json$/);
          if (m) {
            const id = m[1];
            if (!incoming.has(id)) incoming.set(id, {});
            incoming.get(id).surveyEntry = entry;
          }
        });

        if (incoming.size === 0) throw new Error('Backup contains no floor data');

        const existing = await __storage.listStoreys();
        const existingIds = new Set(existing.map(s => s.storey));

        let restored = 0;
        let skipped  = 0;
        let lastTouched = null;
        for (const [storeyId, parts] of incoming) {
          // Decision: if storey already exists, ask per-floor.
          if (existingIds.has(storeyId)) {
            const label = storeyId.replace('.', '-');
            const ok = confirm(
              `Floor ${label} already exists in AVScout.\n\n` +
              `Restoring will replace its SVG and survey data with the backup\u2019s version.\n\n` +
              `Replace this floor?`
            );
            if (!ok) { skipped++; continue; }
          }

          const svgText = parts.svgEntry ? await parts.svgEntry.async('string') : null;
          const surveyPayload = parts.surveyEntry
            ? JSON.parse(await parts.surveyEntry.async('string'))
            : null;

          // Persist SVG: if present, use addStoreyFromSvg (handles both
          // create and replace via SVG identity). If absent, fall back to
          // createStoreyIfMissing so the storey record exists for survey rows.
          if (svgText) {
            await __storage.addStoreyFromSvg(svgText, `${storeyId}.svg`);
          } else if (typeof __storage.createStoreyIfMissing === 'function') {
            const title = surveyPayload && surveyPayload.title;
            await __storage.createStoreyIfMissing(storeyId, title);
          }

          // Persist survey rows. Clear first so the restored set is
          // authoritative (no leftover from a previous survey).
          if (surveyPayload && surveyPayload.rows) {
            if (typeof __storage.clearSurvey === 'function') {
              try { await __storage.clearSurvey(storeyId); } catch (_) {}
            }
            for (const [k, v] of Object.entries(surveyPayload.rows)) {
              await __storage.setSurveyItem(storeyId, k, v);
            }
          }

          await __storage.touchStorey(storeyId);
          lastTouched = storeyId;
          restored++;
        }

        const summary = `Restored ${restored} floor${restored===1?'':'s'}` +
                        (skipped ? `, skipped ${skipped}` : '');
        // Stash a post-reload toast so the user sees confirmation after the
        // reload re-mounts onto a restored floor.
        try {
          sessionStorage.setItem('avscout:postReloadToast', '\u2713 ' + summary);
        } catch (_) {}

        // Reload onto the most recently restored floor (it'll be the active
        // floor on next boot because touchStorey makes it newest).
        if (restored > 0) {
          const u = new URL(location.href);
          if (lastTouched) u.searchParams.set('goToFloor', lastTouched.replace('.', '-'));
          location.replace(u.pathname + (u.search || '') + u.hash);
        } else {
          showFpToast(summary);
        }
      } catch (err) {
        showFpToast('Load failed: ' + (err && err.message || 'unknown'), true);
      } finally {
        btnLoadBackup.disabled = false;
      }
    });
  }
}

// ── Snip tool ─────────────────────────────────────────────
// Click-to-snip: mousedown on a room snaps a rectangle around its bounding
// box plus a small margin. The rect can be dragged or resized by handles.
// Manual rectangle drawing has been removed.
{
  const btnSnip = document.getElementById('btnSnip');
  let snipping=false;
  let cropX=0, cropY=0, cropW=0, cropH=0;
  let resizingCorner=null, resizeStartMouse=null, resizeStartRect=null;
  let rectEl=null, panelEl=null, hintEl=null;

  // Margin around the room as a fraction of bbox dimensions (per side).
  const ROOM_MARGIN_FRAC = 0.25;
  const MIN_MARGIN_PX = 30;

  function setSnipMode(on){
    snipping=on;
    btnSnip.classList.toggle('active',on);
    setUIMode(on?'snipping':'none');
    if(on){ showHint(); }
    else  { teardown(); hideHint(); }
  }
  btnSnip.addEventListener('click',()=>{
    if(placingMode){ setPlacingMode(false); }
    setSnipMode(!snipping);
  });

  function showHint(){
    if(hintEl) return;
    hintEl=document.createElement('div');
    hintEl.id='snip-hint';
    hintEl.innerHTML='<span class="accent">Tap a room</span> to snip · drag corners to adjust';
    document.body.appendChild(hintEl);
  }
  function hideHint(){ if(hintEl){ hintEl.remove(); hintEl=null; } }

  // Find the room (path.floor-plan-space) at a given screen point.
  function roomAtPoint(cx,cy){
    const el=document.elementFromPoint(cx,cy);
    return el?.closest('path.floor-plan-space') || null;
  }

  // Snap the crop rect to a room's bounding box, expanded by margin.
  function snapToRoom(roomPath){
    // Auto-select the room so the info bar + marker filter know which one.
    // Skip if it's already selected (avoid flashing).
    if(selectedPath!==roomPath) selectRoom(roomPath);
    const r=roomPath.getBoundingClientRect();
    const mX=Math.max(MIN_MARGIN_PX, r.width  * ROOM_MARGIN_FRAC);
    const mY=Math.max(MIN_MARGIN_PX, r.height * ROOM_MARGIN_FRAC);
    const x=r.left  - mX;
    const y=r.top   - mY;
    const w=r.width + mX*2;
    const h=r.height+ mY*2;
    if(!rectEl) createRectEl();
    setRectGeom(x,y,w,h);
    finaliseRect();
    hideHint(); // panel takes over from here
  }

  let dragMode=null;
  let moveOffsetX=0, moveOffsetY=0;

  canvas.addEventListener('mousedown',e=>{
    if(!snipping||e.button!==0) return;
    if(e.target.closest('#snip-panel')) return;
    e.stopPropagation(); e.preventDefault();
    if(rectEl){
      // Crop is already shown — clicking inside moves it, outside cancels.
      if(isInsideCrop(e.clientX,e.clientY)){
        dragMode='moving';
        moveOffsetX=e.clientX-cropX; moveOffsetY=e.clientY-cropY;
        rectEl.style.cursor='grabbing';
      } else { teardown(); setSnipMode(false); }
      return;
    }
    // No crop yet — try to snap to a room under the click.
    const room=roomAtPoint(e.clientX,e.clientY);
    if(room) snapToRoom(room);
    // Click on empty space: do nothing (hint already says "tap a room").
  },{capture:true});

  window.addEventListener('mousemove',e=>{
    if(!dragMode) return;
    if(dragMode==='moving'){
      setRectGeom(e.clientX-moveOffsetX,e.clientY-moveOffsetY,cropW,cropH);
      positionPanel();
    } else if(dragMode==='resizing'){
      const dx=e.clientX-resizeStartMouse.x, dy=e.clientY-resizeStartMouse.y;
      let {x,y,w,h}=resizeStartRect;
      if(resizingCorner==='tl'){x+=dx;y+=dy;w-=dx;h-=dy;}
      if(resizingCorner==='tr'){y+=dy;w+=dx;h-=dy;}
      if(resizingCorner==='bl'){x+=dx;w-=dx;h+=dy;}
      if(resizingCorner==='br'){w+=dx;h+=dy;}
      if(w<20)w=20; if(h<20)h=20;
      setRectGeom(x,y,w,h); positionPanel();
    }
  });
  window.addEventListener('mouseup',()=>{
    if(!dragMode) return;
    if(dragMode==='moving'){ if(rectEl) rectEl.style.cursor='grab'; }
    else if(dragMode==='resizing'){ resizingCorner=null; }
    dragMode=null;
  });

  canvas.addEventListener('touchstart',e=>{
    if(!snipping||e.touches.length!==1) return;
    const t=e.touches[0];
    if(e.target.closest('#snip-panel')) return;
    e.stopPropagation(); e.preventDefault();
    if(rectEl){
      if(isInsideCrop(t.clientX,t.clientY)){
        dragMode='moving';
        moveOffsetX=t.clientX-cropX; moveOffsetY=t.clientY-cropY;
        rectEl.style.cursor='grabbing';
      } else { teardown(); setSnipMode(false); }
      return;
    }
    const room=roomAtPoint(t.clientX,t.clientY);
    if(room) snapToRoom(room);
  },{capture:true,passive:false});
  canvas.addEventListener('touchmove',e=>{
    if(!snipping||!dragMode||e.touches.length!==1) return;
    e.stopPropagation(); e.preventDefault();
    const t=e.touches[0];
    if(dragMode==='moving'){
      setRectGeom(t.clientX-moveOffsetX,t.clientY-moveOffsetY,cropW,cropH); positionPanel();
    } else if(dragMode==='resizing'){
      const dx=t.clientX-resizeStartMouse.x, dy=t.clientY-resizeStartMouse.y;
      let {x,y,w,h}=resizeStartRect;
      if(resizingCorner==='tl'){x+=dx;y+=dy;w-=dx;h-=dy;}
      if(resizingCorner==='tr'){y+=dy;w+=dx;h-=dy;}
      if(resizingCorner==='bl'){x+=dx;w-=dx;h+=dy;}
      if(resizingCorner==='br'){w+=dx;h+=dy;}
      if(w<20)w=20; if(h<20)h=20;
      setRectGeom(x,y,w,h); positionPanel();
    }
  },{capture:true,passive:false});
  canvas.addEventListener('touchend',e=>{
    if(!snipping||!dragMode) return;
    e.stopPropagation(); e.preventDefault();
    if(dragMode==='moving'){ if(rectEl) rectEl.style.cursor='grab'; }
    else if(dragMode==='resizing'){ resizingCorner=null; }
    dragMode=null;
  },{capture:true,passive:false});

  function startResizeTouch(e){
    if(e.touches.length!==1) return;
    e.stopPropagation(); e.preventDefault();
    const t=e.touches[0];
    dragMode='resizing';
    resizingCorner=e.currentTarget.dataset.corner;
    resizeStartMouse={x:t.clientX,y:t.clientY};
    resizeStartRect={x:cropX,y:cropY,w:cropW,h:cropH};
  }
  function isInsideCrop(cx,cy){ return cx>=cropX&&cx<=cropX+cropW&&cy>=cropY&&cy<=cropY+cropH; }
  function createRectEl(){
    rectEl=document.createElement('div'); rectEl.id='snip-rect'; rectEl.style.cursor='grab';
    document.body.appendChild(rectEl);
  }
  function setRectGeom(x,y,w,h){
    cropX=x;cropY=y;cropW=w;cropH=h;
    rectEl.style.left=x+'px';rectEl.style.top=y+'px';rectEl.style.width=w+'px';rectEl.style.height=h+'px';
  }
  function finaliseRect(){
    ['tl','tr','bl','br'].forEach(corner=>{
      const h=document.createElement('div');
      h.className='snip-handle '+corner; h.dataset.corner=corner;
      rectEl.appendChild(h);
      h.addEventListener('mousedown',startResize);
      h.addEventListener('touchstart',startResizeTouch,{passive:false});
    });
    showPanel();
  }
  function startResize(e){
    e.stopPropagation(); e.preventDefault();
    dragMode='resizing';
    resizingCorner=e.currentTarget.dataset.corner;
    resizeStartMouse={x:e.clientX,y:e.clientY};
    resizeStartRect={x:cropX,y:cropY,w:cropW,h:cropH};
  }
  function showPanel(){
    if(panelEl) panelEl.remove();
    panelEl=document.createElement('div'); panelEl.id='snip-panel';
    panelEl.innerHTML=`
      <input type="text" id="snip-name" placeholder="Snippet name…" maxlength="60" autocomplete="off"/>
      <button class="snip-btn png" id="snip-dl-png">⬇ PNG</button>
      <button class="snip-btn svg" id="snip-dl-svg">⬇ SVG</button>
      <button class="snip-btn cancel" id="snip-cancel">✕</button>`;
    document.body.appendChild(panelEl);
    positionPanel();
    setTimeout(()=>document.getElementById('snip-name').focus(),30);
    document.getElementById('snip-dl-png').addEventListener('click',()=>downloadPng());
    document.getElementById('snip-dl-svg').addEventListener('click',()=>downloadSvg());
    document.getElementById('snip-cancel').addEventListener('click',()=>{teardown();setSnipMode(false);});
    document.addEventListener('mousedown',outsideHandler,{capture:true});
  }
  function outsideHandler(e){
    if(rectEl&&rectEl.contains(e.target)) return;
    if(panelEl&&panelEl.contains(e.target)) return;
    if(e.target===btnSnip) return;
    teardown(); setSnipMode(false);
  }
  function positionPanel(){
    if(!panelEl) return;
    const margin=8;
    let px=cropX, py=cropY+cropH+margin;
    if(py+60>window.innerHeight) py=cropY-60-margin;
    if(px+320>window.innerWidth) px=window.innerWidth-320-margin;
    if(px<margin) px=margin;
    panelEl.style.left=px+'px'; panelEl.style.top=py+'px';
  }
  function teardown(){
    if(rectEl){rectEl.remove();rectEl=null;}
    if(panelEl){panelEl.remove();panelEl=null;}
    document.removeEventListener('mousedown',outsideHandler,{capture:true});
    dragMode=null; resizingCorner=null; cropX=0;cropY=0;cropW=0;cropH=0;
    // If snip mode is still active (e.g. user closed via the panel's Cancel),
    // bring back the hint so they know to tap another room.
    if(snipping) showHint();
  }
  function snippetName(){ return (document.getElementById('snip-name')?.value||'').trim()||'snippet'; }
  function safeFilename(s){ return s.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim()||'snippet'; }
  function prepareClone(origSvg,svgX,svgY,svgW,svgH){
    const cloned=origSvg.cloneNode(true);
    cloned.querySelectorAll('.fp-visited').forEach(el=>el.classList.remove('fp-visited'));
    if(selectedPath){
      const selCode = selectedPath.getAttribute('data-room-code');
      if(selCode){
        const selEl = cloned.querySelector('[data-room-code="'+selCode.replace(/"/g,'')+'"]');
        if(selEl) selEl.style.fill='rgba(71,194,255,0.18)';
      }
    }
    return cloned;
  }
  function downloadPng(){
    const canvRect=canvas.getBoundingClientRect();
    const wx1=(cropX-canvRect.left-tx)/scale, wy1=(cropY-canvRect.top-ty)/scale;
    const wx2=(cropX+cropW-canvRect.left-tx)/scale, wy2=(cropY+cropH-canvRect.top-ty)/scale;
    const origSvg=wrap.querySelector('svg');
    if(!origSvg){showFpToast('No SVG found.', true);return;}
    let vbX=0,vbY=0,vbW=origSvg.clientWidth,vbH=origSvg.clientHeight;
    const vb=origSvg.viewBox?.baseVal;
    if(vb&&vb.width>0){vbX=vb.x;vbY=vb.y;vbW=vb.width;vbH=vb.height;}
    const svgDisplayW=origSvg.clientWidth||900, svgDisplayH=origSvg.clientHeight||600;
    const scaleX=vbW/svgDisplayW, scaleY=vbH/svgDisplayH;
    const svgX=vbX+wx1*scaleX, svgY=vbY+wy1*scaleY;
    const svgW=(wx2-wx1)*scaleX, svgH=(wy2-wy1)*scaleY;
    // Target long side: 1200px. Keeps text readable and output consistent
    // regardless of zoom level at snip time.
    const TARGET_LONG_SIDE=1200;
    const aspect=(wx2-wx1)/(wy2-wy1);
    const outW = aspect>=1 ? TARGET_LONG_SIDE : Math.round(TARGET_LONG_SIDE*aspect);
    const outH = aspect>=1 ? Math.round(TARGET_LONG_SIDE/aspect) : TARGET_LONG_SIDE;
    const cloned=prepareClone(origSvg,svgX,svgY,svgW,svgH);
    cloned.setAttribute('viewBox',`${svgX} ${svgY} ${svgW} ${svgH}`);
    cloned.setAttribute('width',String(outW)); cloned.setAttribute('height',String(outH));
    cloned.removeAttribute('id'); cloned.style.cssText='background:#ffffff;';
    const markerGroup=document.createElementNS('http://www.w3.org/2000/svg','g');
    markers.forEach(m=>{
      // Only include markers that belong to the currently-selected room.
      // Falls back to crop-bbox filter if no room is selected (unlikely in new
      // snip flow since tapping a room auto-selects it).
      if(selectedPath){
        if(!isMarkerInRoom(m, selectedPath)) return;
      } else {
        const msxCheck=vbX+m.x*scaleX, msyCheck=vbY+m.y*scaleY;
        if(msxCheck<svgX||msxCheck>svgX+svgW||msyCheck<svgY||msyCheck>svgY+svgH) return;
      }
      const msx=vbX+m.x*scaleX, msy=vbY+m.y*scaleY;
      // Fixed marker font sizes in OUTER VIEWBOX UNITS — see downloadSvg /
      // bulk-snip for rationale (markers live outside panzoomEl, room labels
      // are inside, so we compensate for the 8.74× panzoom scale).
      const fs=6.1;
      const txt=document.createElementNS('http://www.w3.org/2000/svg','text');
      txt.setAttribute('x',String(msx)); txt.setAttribute('y',String(msy));
      txt.setAttribute('font-size',String(fs)); txt.setAttribute('text-anchor','middle');
      txt.textContent=equipEmoji(m.equip||'displays');
      markerGroup.appendChild(txt);
      if(m.label){
        const lbl=document.createElementNS('http://www.w3.org/2000/svg','text');
        lbl.setAttribute('x',String(msx)); lbl.setAttribute('y',String(msy+7.0));
        lbl.setAttribute('font-size',String(4.4)); lbl.setAttribute('text-anchor','middle');
        lbl.setAttribute('fill','#ff47c2'); lbl.setAttribute('font-family','sans-serif');
        lbl.textContent=m.label; markerGroup.appendChild(lbl);
      }
    });
    cloned.appendChild(markerGroup);
    const svgStr=new XMLSerializer().serializeToString(cloned);
    const dataUrl='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svgStr);
    const dpr=window.devicePixelRatio||1;
    const offscreen=document.createElement('canvas');
    offscreen.width=outW*dpr; offscreen.height=outH*dpr;
    const ctx=offscreen.getContext('2d');
    ctx.scale(dpr,dpr);
    const img=new Image();
    img.onload=()=>{
      ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,outW,outH);
      ctx.drawImage(img,0,0,outW,outH);
      offscreen.toBlob(pngBlob=>{
        const a=document.createElement('a');
        a.href=URL.createObjectURL(pngBlob);
        a.download=safeFilename(snippetName())+'.png'; a.click();
        setTimeout(()=>URL.revokeObjectURL(a.href),2000);
      },'image/png');
    };
    img.onerror=()=>showFpToast('PNG export failed.', true);
    img.src=dataUrl;
  }
  function downloadSvg(){
    const canvRect=canvas.getBoundingClientRect();
    const wx1=(cropX-canvRect.left-tx)/scale, wy1=(cropY-canvRect.top-ty)/scale;
    const wx2=(cropX+cropW-canvRect.left-tx)/scale, wy2=(cropY+cropH-canvRect.top-ty)/scale;
    const origSvg=wrap.querySelector('svg');
    if(!origSvg){showFpToast('No SVG found.', true);return;}
    let vbX=0,vbY=0,vbW=origSvg.clientWidth,vbH=origSvg.clientHeight;
    const vb=origSvg.viewBox?.baseVal;
    if(vb&&vb.width>0){vbX=vb.x;vbY=vb.y;vbW=vb.width;vbH=vb.height;}
    const svgDisplayW=origSvg.clientWidth||900, svgDisplayH=origSvg.clientHeight||600;
    const scaleX=vbW/svgDisplayW, scaleY=vbH/svgDisplayH;
    const svgX=vbX+wx1*scaleX, svgY=vbY+wy1*scaleY;
    const svgW=(wx2-wx1)*scaleX, svgH=(wy2-wy1)*scaleY;
    const cloned=prepareClone(origSvg,svgX,svgY,svgW,svgH);
    // Drop everything outside the crop rect (in SCREEN PIXELS — same space
    // as cropX/Y/W/H, so no coord math needed). Saves ~70-80% file size on
    // large floors. Must run BEFORE we append snip-markers to the clone,
    // otherwise marker indices would shift relative to the original.
    {
      const cropRectScreen = { left: cropX, top: cropY, right: cropX+cropW, bottom: cropY+cropH };
      const drop = buildSnipDropSet(origSvg, cropRectScreen);
      applySnipDropSet(cloned, drop);
      compressKeptSvg(cloned);
    }
    cloned.setAttribute('viewBox',`${svgX} ${svgY} ${svgW} ${svgH}`);
    // Target long side: 1200px. Same reasoning as PNG — consistency across zoom levels.
    const TARGET_LONG_SIDE_SVG=1200;
    const aspectSvg=(wx2-wx1)/(wy2-wy1);
    const outWSvg = aspectSvg>=1 ? TARGET_LONG_SIDE_SVG : Math.round(TARGET_LONG_SIDE_SVG*aspectSvg);
    const outHSvg = aspectSvg>=1 ? Math.round(TARGET_LONG_SIDE_SVG/aspectSvg) : TARGET_LONG_SIDE_SVG;
    cloned.setAttribute('width',String(outWSvg)); cloned.setAttribute('height',String(outHSvg));
    cloned.removeAttribute('id'); cloned.style.cssText='';
    const markerGroup=document.createElementNS('http://www.w3.org/2000/svg','g');
    markerGroup.setAttribute('id','snip-markers');
    markers.forEach(m=>{
      // Only include markers that belong to the currently-selected room.
      if(selectedPath){
        if(!isMarkerInRoom(m, selectedPath)) return;
      } else {
        const msxCheck=vbX+m.x*scaleX, msyCheck=vbY+m.y*scaleY;
        if(msxCheck<svgX||msxCheck>svgX+svgW||msyCheck<svgY||msyCheck>svgY+svgH) return;
      }
      const msx=vbX+m.x*scaleX, msy=vbY+m.y*scaleY;
      const g=document.createElementNS('http://www.w3.org/2000/svg','g');
      const txt=document.createElementNS('http://www.w3.org/2000/svg','text');
      txt.setAttribute('x',String(msx)); txt.setAttribute('y',String(msy));
      // Fixed marker font sizes in OUTER VIEWBOX UNITS. Markers live OUTSIDE
      // panzoomEl in the snip output, so they don't get the 8.74× scale that
      // the source's room-label text gets via panzoomEl matrix(8.74,...).
      // Room labels effectively render at 0.56 * 8.74 ≈ 4.9 outer units; the
      // emoji is slightly bigger and the auxiliary text label slightly smaller.
      txt.setAttribute('font-size','6.1'); txt.setAttribute('text-anchor','middle');
      txt.textContent=equipEmoji(m.equip||'displays');
      g.appendChild(txt);
      if(m.label){
        const lbl=document.createElementNS('http://www.w3.org/2000/svg','text');
        lbl.setAttribute('x',String(msx)); lbl.setAttribute('y',String(msy+7.0));
        lbl.setAttribute('font-size','4.4'); lbl.setAttribute('text-anchor','middle');
        lbl.setAttribute('fill','#ff47c2'); lbl.setAttribute('font-family','sans-serif');
        lbl.textContent=m.label; g.appendChild(lbl);
      }
      markerGroup.appendChild(g);
    });
    cloned.appendChild(markerGroup);
    const svgStr='<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(cloned);
    const blob=new Blob([svgStr],{type:'image/svg+xml'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=safeFilename(snippetName())+'.svg'; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  }
} // end snip tool


// ════════════════════════════════════════════════════════════════════════
//   Floor rail — Phase 3 addition
//
//   The rail lives in the same DOM as the surveying app. It shows
//   buildings → storeys, lets the user add/switch/detach/delete storeys,
//   and import/export survey JSON. Switching storeys reloads the page;
//   storage.SurveyKV.bindStorey is called in boot.js so the next reload
//   lands in the right scope.
// ════════════════════════════════════════════════════════════════════════

(function setupFloorRail(){
  const railEl    = document.getElementById('floor-rail');
  const treeEl    = document.getElementById('rail-tree');
  const toggleEl  = document.getElementById('fab-rail-toggle');
  const btnAddSvg = document.getElementById('btn-add-svg');
  const emptyEl   = document.getElementById('empty-state');
  const emptyBtn  = document.getElementById('empty-svg-btn');
  const ctxEl     = document.getElementById('ctx-menu');
  const confirmEl = document.getElementById('confirm-overlay');

  if (!railEl) return; // Defensive: if the HTML wasn't extended, do nothing.

  // Post-reload toast — used by commitMultiStoreyImport to surface the
  // result after the page refresh that re-mounts the active storey.
  try {
    const m = sessionStorage.getItem('avscout:postReloadToast');
    if (m) {
      sessionStorage.removeItem('avscout:postReloadToast');
      // Slight delay so the toast component is ready
      setTimeout(()=>showFpToast(m, false, 4000), 200);
    }
    // Detailed failure list from a multi-SVG upload — show as a native
    // alert so the user sees the per-file error messages.
    const failures = sessionStorage.getItem('avscout:postReloadFailures');
    if (failures) {
      sessionStorage.removeItem('avscout:postReloadFailures');
      setTimeout(()=>alert('Some SVGs were rejected:\n\n' + failures), 800);
    }
    // Same flag for auto-opening the panel after an XLS-import reload.
    if (sessionStorage.getItem('avscout:postReloadOpenPanel') === '1') {
      sessionStorage.removeItem('avscout:postReloadOpenPanel');
      const sp = document.getElementById('side-panel');
      if (sp && !sp.classList.contains('open')) {
        sp.classList.add('open');
        document.body.classList.add('panel-open');
        const fpt = document.getElementById('fab-panel-toggle');
        if (fpt) fpt.classList.add('active');
      }
    }
  } catch(e){}

  // ── Empty state ────────────────────────────────────────────────────────
  if (!__hasFloor) {
    if (emptyEl) emptyEl.hidden = false;
    document.body.classList.add('no-floor');
    // Auto-open the right panel so the user can still upload an XLS
    // (the panel hosts the Imports tab). The user can collapse it via
    // the existing FAB toggle if they want.
    const sp = document.getElementById('side-panel');
    if (sp && !sp.classList.contains('open')) {
      sp.classList.add('open');
      document.body.classList.add('panel-open');
      const fpt = document.getElementById('fab-panel-toggle');
      if (fpt) fpt.classList.add('active');
    }
  } else {
    if (emptyEl) emptyEl.hidden = true;
    document.body.classList.remove('no-floor');
  }

  // ── Rail open/close ────────────────────────────────────────────────────
  if (toggleEl) {
    toggleEl.addEventListener('click', () => {
      document.body.classList.toggle('rail-collapsed');
    });
  }
  // Rail is open by default. On narrow viewports we collapse it after the
  // user picks a storey (handled in handleOpenStorey below).

  // ── Confirm dialog ─────────────────────────────────────────────────────
  function showConfirm({ title, message, breakdown = [], confirmLabel = 'OK', danger = false }) {
    return new Promise((resolve) => {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-message').textContent = message;
      const bd = document.getElementById('confirm-breakdown');
      bd.innerHTML = '';
      if (breakdown.length) {
        bd.hidden = false;
        for (const line of breakdown) {
          const li = document.createElement('li');
          li.textContent = '• ' + line;
          bd.appendChild(li);
        }
      } else {
        bd.hidden = true;
      }
      const ok = document.getElementById('confirm-ok');
      ok.textContent = confirmLabel;
      ok.className = danger ? 'danger' : '';
      confirmEl.hidden = false;
      const cancel = document.getElementById('confirm-cancel');
      const done = (v) => {
        confirmEl.hidden = true;
        ok.onclick = null; cancel.onclick = null;
        resolve(v);
      };
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
    });
  }

  // ── Context menu ───────────────────────────────────────────────────────
  function hideCtx(){ if (ctxEl) ctxEl.hidden = true; }
  function showCtx(anchor, items) {
    if (!ctxEl) return;
    hideCtx();
    ctxEl.innerHTML = '';
    for (const it of items) {
      if (it.divider) {
        const sep = document.createElement('div'); sep.className = 'ctx-divider';
        ctxEl.appendChild(sep); continue;
      }
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.className = 'danger';
      b.onclick = () => { hideCtx(); it.onClick(); };
      ctxEl.appendChild(b);
    }
    const r = anchor.getBoundingClientRect();
    ctxEl.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
    ctxEl.style.top  = (r.bottom + 4) + 'px';
    ctxEl.hidden = false;
    setTimeout(() => document.addEventListener('click', hideCtx, { once: true }), 0);
  }

  // ── File pickers ───────────────────────────────────────────────────────
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        input.remove();
        resolve(f || null);
      });
      input.addEventListener('cancel', () => { input.remove(); resolve(null); });
      input.click();
    });
  }

  // Multi-file variant: returns an array of File (possibly empty).
  function pickFiles(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const files = input.files ? Array.from(input.files) : [];
        input.remove();
        resolve(files);
      });
      input.addEventListener('cancel', () => { input.remove(); resolve([]); });
      input.click();
    });
  }

  // ── Rail rendering ─────────────────────────────────────────────────────
  const _expanded = new Set(); // building codes
  let _buildings = [];

  // Track first refresh — that's the only moment we auto-set the rail's
  // collapsed state (cold start = collapsed if DB empty, else open).
  // Subsequent refreshes (after add/delete) leave the user's choice alone.
  let _firstRailRender = true;

  async function refreshRail() {
    if (!treeEl) return;
    _buildings = await __storage.listBuildings();
    treeEl.innerHTML = '';

    // Keep a body-level flag for whether the rail has anything to show.
    // CSS uses this to hide the rail toggle FAB on cold start — there's
    // nothing to toggle, and the welcome screen tells the user what to do.
    if (_buildings.length === 0) {
      document.body.classList.add('rail-empty');
    } else {
      document.body.classList.remove('rail-empty');
    }

    if (_firstRailRender) {
      if (_buildings.length === 0) {
        // Cold start — collapse the rail so the welcome screen has the
        // stage to itself.
        document.body.classList.add('rail-collapsed');
      } else {
        document.body.classList.remove('rail-collapsed');
      }
      _firstRailRender = false;
    }

    if (_buildings.length === 0) {
      // Welcome screen alongside already explains the next action, so the
      // rail-tree just stays empty rather than echoing the same message.
      return;
    }

    // Auto-expand: the building containing the active floor, or the
    // most recently opened if nothing else.
    if (_expanded.size === 0) {
      const active = __safeStorey;
      for (const b of _buildings) {
        if (b.storeys.some(s => s.storey === active)) _expanded.add(b.building);
      }
      if (_expanded.size === 0 && _buildings.length > 0) {
        _expanded.add(_buildings[0].building);
      }
    }

    for (const b of _buildings) {
      const isExpanded = _expanded.has(b.building);
      const bldgEl = document.createElement('div');
      bldgEl.className = 'rail-building' + (isExpanded ? '' : ' collapsed');

      const head = document.createElement('div');
      head.className = 'rail-building-head';
      head.innerHTML = `<span class="chev">▾</span>
        <span class="rail-building-code"></span>
        <span class="rail-building-count"></span>`;
      head.querySelector('.rail-building-code').textContent = b.building;
      head.querySelector('.rail-building-count').textContent =
        b.storeys.length + ' ' + (b.storeys.length === 1 ? 'floor' : 'floors');
      head.addEventListener('click', () => {
        if (_expanded.has(b.building)) _expanded.delete(b.building);
        else _expanded.add(b.building);
        refreshRail();
      });
      bldgEl.appendChild(head);

      const storeysEl = document.createElement('div');
      storeysEl.className = 'rail-storeys';
      for (const s of b.storeys) {
        const hasSvg = !!s.svg;
        const row = document.createElement('div');
        row.className = 'rail-storey' + (s.storey === __safeStorey ? ' active' : '');
        row.innerHTML = `<span class="storey-label"></span>
          <span class="storey-svg-state ${hasSvg ? 'attached' : 'detached'}"
                title="${hasSvg ? 'Floorplan attached' : 'No floorplan attached'}">${hasSvg ? '📐' : '○'}</span>
          <button class="rail-storey-menu" aria-label="Options" title="Options">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
              <path d="M8 1.5l.9.3.3 1.3.9.4 1.1-.7.9.9-.7 1.1.4.9 1.3.3.3.9-1.3.3-.4.9.7 1.1-.9.9-1.1-.7-.9.4-.3 1.3-.9.3-.3-1.3-.9-.4-1.1.7-.9-.9.7-1.1-.4-.9-1.3-.3-.3-.9 1.3-.3.4-.9-.7-1.1.9-.9 1.1.7.9-.4.3-1.3.9-.3z"/>
              <circle cx="8" cy="8" r="2.2"/>
            </svg>
          </button>`;
        // Label format: "08-03" rather than "08.03" so the row reads as a
        // single token. The data model still uses dots; this is presentation.
        row.querySelector('.storey-label').textContent = floorLabel(s.storey);
        row.addEventListener('click', (ev) => {
          if (ev.target.closest('.rail-storey-menu')) return;
          handleOpenStorey(s.storey);
        });
        row.querySelector('.rail-storey-menu').addEventListener('click', (ev) => {
          ev.stopPropagation();
          openStoreyMenu(ev.currentTarget, s);
        });
        storeysEl.appendChild(row);
      }
      bldgEl.appendChild(storeysEl);
      treeEl.appendChild(bldgEl);
    }
  }

  function openStoreyMenu(anchor, s) {
    // "Open" is unnecessary — clicking the row already opens the floor.
    // "Rename" is unnecessary — the floor code is the identity.
    const items = [
      { label: 'Export survey (JSON)…', onClick: () => handleExport(s.storey) },
    ];
    if (s.svg) {
      items.push({ label: 'Replace floorplan SVG…', onClick: () => handleAddSvgInto(s.storey) });
      items.push({ label: 'Detach floorplan', onClick: () => handleDetach(s.storey) });
    } else {
      items.push({ label: 'Attach floorplan SVG…', onClick: () => handleAddSvgInto(s.storey) });
    }
    items.push({ divider: true });
    items.push({ label: 'Delete floor…', danger: true, onClick: () => handleDelete(s.storey) });
    showCtx(anchor, items);
  }

  // ── Storey switching ────────────────────────────────────────────────────
  // To avoid the complexity of re-mounting 5500 lines of state, we reload
  // the page after committing the new active storey. boot.js picks the
  // most-recently-opened storey to mount, so a `touchStorey()` is enough.

  async function handleOpenStorey(storey) {
    if (storey === __safeStorey) return;
    await __storage.touchStorey(storey);
    location.reload();
  }

  async function handleAddSvg() {
    const files = await pickFiles('.svg,image/svg+xml');
    if (files.length === 0) return;

    // Process all files in parallel. Each addStoreyFromSvg derives its
    // own storey from the SVG's room codes, so there's no mismatch
    // concern within a multi-pick (only when *attaching* to a known
    // floor target, which is handleAddSvgInto's job, not this one).
    const results = await Promise.all(files.map(async (file) => {
      try {
        const text = await file.text();
        const r = await __storage.addStoreyFromSvg(text, file.name);
        return { ok: true, file: file.name, status: r.status, storey: r.record.storey };
      } catch (e) {
        return { ok: false, file: file.name, error: e.message };
      }
    }));

    const successes = results.filter(r => r.ok);
    const failures  = results.filter(r => !r.ok);

    // No successes — show errors and bail (no reload, user can try again)
    if (successes.length === 0) {
      const lines = ['No SVGs could be added:', ''].concat(
        failures.map(f => `• ${f.file}: ${f.error}`)
      );
      alert(lines.join('\n'));
      return;
    }

    // At least one success — set the first-success storey active so the
    // user lands on it after reload. Summarize all results (including
    // failures) via the post-reload toast.
    await __storage.touchStorey(successes[0].storey);

    const statusCounts = { created: 0, 'svg-replaced': 0, unchanged: 0 };
    for (const s of successes) {
      if (statusCounts[s.status] !== undefined) statusCounts[s.status]++;
    }
    const parts = [];
    if (statusCounts.created > 0)        parts.push(`${statusCounts.created} added`);
    if (statusCounts['svg-replaced'] > 0) parts.push(`${statusCounts['svg-replaced']} replaced`);
    if (statusCounts.unchanged > 0)      parts.push(`${statusCounts.unchanged} unchanged`);
    if (failures.length > 0)             parts.push(`${failures.length} rejected`);
    const msg = `✓ ${parts.join(' · ')}`;

    try {
      sessionStorage.setItem('avscout:postReloadToast', msg);
      if (failures.length > 0) {
        // Stash failures for a more detailed display after reload.
        const detail = failures.map(f => `${f.file}: ${f.error}`).join('\n');
        sessionStorage.setItem('avscout:postReloadFailures', detail);
      }
    } catch (e) {}

    location.reload();
  }

  async function handleAddSvgInto(storey) {
    const file = await pickFile('.svg,image/svg+xml');
    if (!file) return;
    const text = await file.text();
    try {
      await __storage.attachSvg(storey, text);
      await __storage.touchStorey(storey);
      location.reload();
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleDetach(storey) {
    const ok = await showConfirm({
      title: 'Detach floorplan from ' + floorLabel(storey) + '?',
      message: 'The SVG will be removed but all survey data (markers, visited rooms, imports) is kept. You can attach a new SVG later.',
      breakdown: [
        'Markers placed on the old SVG may not align with a new one',
        'You can re-attach an SVG any time',
      ],
      confirmLabel: 'Detach',
    });
    if (!ok) return;
    await __storage.detachSvg(storey);
    if (storey === __safeStorey) {
      location.reload();
    } else {
      refreshRail();
    }
  }

  async function handleDelete(storey) {
    const ok = await showConfirm({
      title: 'Delete floor ' + floorLabel(storey) + '?',
      message: 'This permanently removes the floor and all of its survey data.',
      breakdown: [
        'The floorplan SVG (if attached)',
        'All markers, visited rooms, imported assets',
        'Cannot be undone',
      ],
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (!ok) return;
    await __storage.deleteStorey(storey);
    if (storey === __safeStorey) {
      // Active floor gone — pick another, or fall back to empty state.
      const remaining = await __storage.listStoreys();
      if (remaining.length > 0) {
        await __storage.touchStorey(remaining[0].storey);
      }
      location.reload();
    } else {
      refreshRail();
    }
  }

  async function handleExport(storey) {
    try {
      const pkg = await __storage.exportPackage(storey);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const safe = (pkg.storey.title || storey).replace(/[^a-zA-Z0-9_.-]/g, '_');
      a.download = safe + '-survey.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      alert('Export failed: ' + e.message);
    }
  }

  async function handleImportJson() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let pkg;
    try { pkg = JSON.parse(await file.text()); }
    catch (e) { alert('Not valid JSON.'); return; }
    try {
      const rec = await __storage.importPackage(pkg);
      await __storage.touchStorey(rec.storey);
      location.reload();
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  }

  // ── Wire-up ────────────────────────────────────────────────────────────
  if (btnAddSvg) btnAddSvg.addEventListener('click', () => handleAddSvg());
  if (emptyBtn)  emptyBtn.addEventListener('click', () => handleAddSvg());

  refreshRail();
})();


}
