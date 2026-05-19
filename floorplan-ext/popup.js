// popup.js

const btnCapture   = document.getElementById('btnCapture');
const statusBar    = document.getElementById('statusBar');
const itemsList    = document.getElementById('itemsList');
const emptyState   = document.getElementById('emptyState');
const listHeader   = document.getElementById('listHeader');
const countBadge   = document.getElementById('countBadge');
const btnClearAll  = document.getElementById('btnClearAll');
const btnExportZip = document.getElementById('btnExportZip');
const toast        = document.getElementById('toast');

let toastTimer = null;

// ── Utilities ────────────────────────────────────────────────────────────────

function showToast(msg, duration = 2200) {
  toast.textContent = msg;
  toast.classList.add('show');
  toast.classList.remove('has-action');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// Variant with a clickable action on the right side of the toast.
// Stays visible longer since the user may want to click it.
function showToastWithAction(msg, actionLabel, onClick, duration = 5000) {
  toast.innerHTML = '';
  const txt = document.createElement('span');
  txt.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = actionLabel;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    toast.classList.remove('show');
    clearTimeout(toastTimer);
    onClick();
  });
  toast.appendChild(txt);
  toast.appendChild(btn);
  toast.classList.add('show', 'has-action');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// Resolve the most recent download matching this file path and open it.
// We search by path (unique, because we overwrite) rather than tracking ID,
// because download IDs can change across browser sessions while paths are stable.
function openDownloadByPath(path) {
  // chrome.downloads.search matches by exact filename suffix when given a path.
  chrome.downloads.search({ filenameRegex: escapeRegex(path).replace(/\//g, '[\\\\/]') + '$', exists: true, orderBy: ['-startTime'], limit: 1 }, results => {
    if (chrome.runtime.lastError || !results || results.length === 0) {
      showToast("Can't find downloaded file — try Download again");
      return;
    }
    chrome.downloads.open(results[0].id);
  });
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── In-popup confirm modal ────────────────────────────────────────────────────
// Replaces window.confirm() for popup-side prompts because the native dialog
// is rendered at the size of the 380px popup and is effectively unreadable.
// Returns a Promise<boolean>.
function showConfirm({ title, body, confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const overlay = document.getElementById('cmOverlay');
    const titleEl = document.getElementById('cmTitle');
    const bodyEl  = document.getElementById('cmBody');
    const okBtn   = document.getElementById('cmConfirmBtn');
    const noBtn   = document.getElementById('cmCancelBtn');

    titleEl.textContent = title;
    bodyEl.innerHTML = body; // caller is responsible for escaping / formatting
    okBtn.textContent = confirmText;
    noBtn.textContent = cancelText;
    // Info-only mode: no cancel button (caller passed cancelText: '')
    noBtn.style.display = cancelText ? '' : 'none';
    okBtn.classList.toggle('danger', !!danger);

    function cleanup(result) {
      overlay.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      noBtn.removeEventListener('click', onNo);
      overlay.removeEventListener('click', onBg);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onNo() { cleanup(false); }
    function onBg(e) { if (e.target === overlay) cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter')  cleanup(true);
    }
    okBtn.addEventListener('click', onOk);
    noBtn.addEventListener('click', onNo);
    overlay.addEventListener('click', onBg);
    document.addEventListener('keydown', onKey);

    overlay.classList.add('open');
    setTimeout(() => okBtn.focus(), 50);
  });
}

function setStatus(msg, type = '') {
  statusBar.innerHTML = msg ? `<span class="status-dot"></span>${msg}` : '';
  statusBar.className = 'status-bar ' + type;
}

// Inline hyperlink to the Stipl web app. Used in status bar messages
// where the user needs to visit Stipl to capture a floorplan. Opens in
// a new tab with rel=noopener for safety.
const STIPL_LINK =
  '<a href="https://app.stipl.org/" target="_blank" rel="noopener noreferrer">app.stipl.org</a>';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname.slice(0, 22) + '…' : '');
  } catch { return url.slice(0, 30); }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Collision-resistant ID generator (extension scope; mirror of the IIFE one).
// Used for captured-floorplan IDs. Capture is user-paced so collisions are
// theoretical, but the suffix costs nothing.
let _idCounter = 0;
function nextId(){ return Date.now().toString() + '_' + (++_idCounter); }

function makeThumbnail(svgString) {
  const div = document.createElement('div');
  div.innerHTML = svgString;
  const svgEl = div.querySelector('svg');
  if (!svgEl) return null;
  svgEl.setAttribute('width', '38');
  svgEl.setAttribute('height', '38');
  svgEl.removeAttribute('id');
  return svgEl.outerHTML;
}

// Safe filename: strip characters not allowed in filenames
function safeFilename(title) {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'floorplan';
}

// Safe path segment: like safeFilename but for subfolders (no slashes anywhere).
// Trims trailing dots/spaces that Windows rejects.
function safePathSegment(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim() || 'Unknown';
}

// Build the structured download path for a captured floorplan item.
// Rules (per user decisions):
//   - Root: Floorplans/
//   - Kind folder: "Base" (clean rips) or "Surveyed" (with survey data)
//   - Building folder: "Building X" where X is storeyName split on first dash
//   - Filename: storeyName (or title fallback)
// If storeyName is missing, the building folder is skipped and the title is used.
function buildFloorplanPath(item, kind /* 'Base' | 'Surveyed' */, ext = 'html') {
  const kindFolder = safePathSegment(kind);
  const storey = (item.storeyName || '').trim();
  if (!storey) {
    const fallback = safeFilename(item.title || 'floorplan');
    return `Floorplans/${kindFolder}/${fallback}.${ext}`;
  }
  const buildingId = storey.split('-')[0].trim(); // "17-00" → "17", "30a-K1" → "30a"
  const buildingFolder = safePathSegment(`Building ${buildingId}`);
  const filename = safeFilename(storey);
  return `Floorplans/${kindFolder}/${buildingFolder}/${filename}.${ext}`;
}

// ── Storage ──────────────────────────────────────────────────────────────────

async function loadItems() {
  return new Promise(resolve => {
    chrome.storage.local.get(['floorplans'], r => resolve(r.floorplans || []));
  });
}

async function saveItems(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ floorplans: items }, () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || '';
        if (msg.toLowerCase().includes('quota')) {
          setStatus('Storage full — delete some plans to free space.', 'error');
        } else {
          setStatus('Save failed: ' + msg, 'error');
        }
        reject(new Error(msg));
      } else {
        resolve();
      }
    });
  });
}

// ── Interactive HTML template ─────────────────────────────────────────────────

// Full equipment type mapping — covers all types found in TUDesc exports
// plus the original set. Excel "Equipment Type" values map to these keys.
// ─────────────────────────────────────────────────────────────────────
// Inlined assets for the interactive HTML output.
// Both are plain strings injected verbatim into buildInteractiveHtml().
// Editing CSS or runtime JS happens HERE, not deep inside the template.
//
// INTERACTIVE_SCRIPT_TEMPLATE has 4 placeholders that get substituted
// per-floorplan inside buildInteractiveHtml:
//   __EQUIP_JSON__       — JSON-stringified short-form EQUIP_TYPES
//   __SVG_RAW_LITERAL__  — the floorplan SVG, wrapped as `\`...\``
//   __SAFE_STOREY__      — escaped storey name (e.g. "17-00")
//   __TITLE__            — escaped page/floor title
// ─────────────────────────────────────────────────────────────────────
const INTERACTIVE_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0e0f11;--surface:#16181c;--border:#2a2d35;
  --accent:#e8ff47;--accent2:#47c2ff;--text:#f0f0ef;--muted:#6b7280;
  --danger:#ff5f5f;--success:#4ade80;
  --info-h:66px;--tool-h:46px;
  --panel-w:300px;
  --panel-bg:#f0f2f4;--panel-surface:#ffffff;--panel-border:#d4dae0;
  --panel-text:#1a2030;--panel-muted:#6b7a8d;--panel-cyan:#0a8ab0;--panel-cyan-bg:rgba(10,138,176,.1);
}
html,body{width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);
  font-family:'Segoe UI',system-ui,sans-serif;}

/* ── toolbar ── */
#toolbar{
  position:fixed;top:0;left:0;right:0;height:var(--tool-h);
  background:var(--surface);border-bottom:1px solid var(--border);
  display:flex;align-items:center;padding:0 14px;gap:8px;z-index:200;
}
#tb-brand{display:flex;align-items:center;flex:1;min-width:0;}
#tb-logo{height:40px;width:auto;flex-shrink:0;margin-left:-12px;margin-top:1px;}
#toolbar h1{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--panel-muted);margin-left:auto;}
.tb-btn{
  padding:5px 11px;border:1px solid var(--border);background:transparent;color:var(--text);
  border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;display:flex;align-items:center;
  gap:5px;transition:background .15s,border-color .15s;white-space:nowrap;flex-shrink:0;
}
.tb-btn:hover{background:rgba(255,255,255,.07);border-color:#444;}
.tb-btn.active{background:var(--accent);color:#000;border-color:var(--accent);}
.tb-btn svg{width:12px;height:12px;flex-shrink:0;}
.tb-divider{width:1px;align-self:stretch;background:var(--border);margin:6px 4px;flex-shrink:0;}

/* ── Advanced modal ── */
#advOverlay{
  position:fixed;inset:0;background:rgba(0,0,0,.6);
  display:flex;align-items:center;justify-content:center;z-index:500;
  opacity:0;pointer-events:none;transition:opacity .15s;
}
#advOverlay.open{opacity:1;pointer-events:all;}
#advModal{
  background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:20px 18px 16px;width:360px;max-height:80vh;
  transform:translateY(8px);transition:transform .15s;
  display:flex;flex-direction:column;
}
#advOverlay.open #advModal{transform:translateY(0);}
#advModal h2{font-size:13px;font-weight:800;margin-bottom:14px;display:flex;align-items:center;gap:6px;}
#adv-body{flex:1;overflow-y:auto;}
.adv-section{margin-bottom:14px;}
.adv-section-title{
  font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
  color:var(--muted);margin-bottom:8px;
}
.adv-summary{
  font-size:10px;color:var(--muted);font-family:monospace;
  background:#1e2028;border:1px solid var(--border);border-radius:5px;
  padding:8px 10px;margin-bottom:10px;line-height:1.5;
}
.adv-summary .val{color:var(--text);font-weight:700;}
.adv-btn{
  width:100%;text-align:left;background:transparent;
  border:1px solid var(--border);border-radius:6px;padding:10px 12px;
  cursor:pointer;margin-bottom:8px;color:var(--text);
  transition:background .15s,border-color .15s;
  font-family:inherit;
}
.adv-btn:hover:not(:disabled){background:rgba(255,255,255,.04);}
.adv-btn:disabled{opacity:0.4;cursor:not-allowed;}
.adv-btn-label{font-size:11px;font-weight:700;margin-bottom:3px;}
.adv-btn-sub{font-size:10px;color:var(--muted);line-height:1.4;}
.adv-btn-export{border-color:rgba(71,194,255,.3);}
.adv-btn-export:hover:not(:disabled){background:rgba(71,194,255,.06);border-color:rgba(71,194,255,.5);}
.adv-btn-export .adv-btn-label{color:var(--accent2);}
.adv-btn-import{border-color:rgba(71,194,255,.3);}
.adv-btn-import:hover:not(:disabled){background:rgba(71,194,255,.06);border-color:rgba(71,194,255,.5);}
.adv-btn-import .adv-btn-label{color:var(--accent2);}
.adv-btn-snip{border-color:rgba(232,255,71,.3);}
.adv-btn-snip:hover:not(:disabled){background:rgba(232,255,71,.06);border-color:rgba(232,255,71,.5);}
.adv-btn-snip .adv-btn-label{color:var(--accent);}
.adv-progress-wrap{margin-top:8px;}
.adv-progress-bar{
  height:4px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;
}
.adv-progress-fill{
  height:100%;background:var(--accent);width:0%;transition:width .15s;
}
.adv-progress-text{
  margin-top:4px;font-size:10px;color:var(--muted);font-family:'DM Mono',monospace;
}
.adv-btn-danger{border-color:rgba(255,95,95,.3);}
.adv-btn-danger:hover:not(:disabled){background:rgba(255,95,95,.06);border-color:rgba(255,95,95,.5);}
.adv-btn-danger .adv-btn-label{color:var(--danger);}
#adv-actions{display:flex;justify-content:flex-end;margin-top:6px;}
#importFileInput{display:none;}

/* ── side panel ── */
#side-panel{
  position:fixed;top:var(--tool-h);right:0;bottom:0;width:var(--panel-w);
  background:var(--panel-bg);border-left:1px solid var(--panel-border);
  display:flex;flex-direction:column;z-index:150;
  transform:translateX(100%);transition:transform .2s ease;
}
#side-panel.open{transform:translateX(0);}
body.panel-open #canvas{right:var(--panel-w);}
body.panel-open #infobar{right:var(--panel-w);}
body.panel-open #fab-group{right:calc(var(--panel-w) + 14px);}

/* panel header */
#panel-header{
  display:flex;align-items:center;border-bottom:1px solid var(--panel-border);
  background:var(--panel-surface);flex-shrink:0;
}
.panel-tab{
  flex:1;padding:10px 4px;text-align:center;font-size:11px;font-weight:700;
  letter-spacing:.3px;color:var(--panel-muted);
  cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;
  user-select:none;display:flex;align-items:center;justify-content:center;gap:5px;
}
.panel-tab.active{color:var(--panel-cyan);border-bottom-color:var(--panel-cyan);}

/* panel import strip */
#panel-import-strip,#panel-disco-strip{
  padding:6px 12px;border-bottom:1px solid var(--panel-border);
  font-size:10px;color:var(--panel-muted);display:flex;align-items:center;gap:6px;
  flex-shrink:0;min-height:30px;background:var(--panel-surface);
  position:sticky;top:0;z-index:10;
}
#panel-import-strip.has-data{color:var(--panel-cyan);}
#import-status-dot{width:6px;height:6px;border-radius:50%;background:var(--panel-border);flex-shrink:0;}
#panel-import-strip.has-data #import-status-dot{background:var(--panel-cyan);}
#disco-status-dot{width:6px;height:6px;border-radius:50%;background:var(--panel-border);flex-shrink:0;}
#panel-disco-strip.has-data{color:#c020a0;}
#panel-disco-strip.has-data #disco-status-dot{background:#c020a0;}
.panel-eye-btn{
  width:24px;height:24px;border-radius:5px;border:1px solid var(--panel-border);
  background:transparent;cursor:pointer;display:none;margin-left:auto;flex-shrink:0;
  align-items:center;justify-content:center;color:var(--panel-muted);
  transition:background .12s,color .12s;user-select:none;
}
.panel-eye-btn:hover{background:#e6eaee;color:var(--panel-text);}
.panel-eye-btn.visible{display:flex;}
.imports-eye:active{background:rgba(232,255,71,.3);border-color:#c8dd30;color:#7a8800;}
.disco-eye:active{background:rgba(255,100,220,.2);border-color:#d030b0;color:#c020a0;}

/* Small "i" info button next to the import-strip status text. Matches the
   eye-button sizing so the strip stays visually balanced. */
.panel-strip-info{
  width:18px;height:18px;border-radius:50%;border:none;background:transparent;
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  color:var(--panel-muted);transition:color .12s,background .12s;
  flex-shrink:0;padding:0;margin-left:2px;
}
.panel-strip-info:hover{background:rgba(10,138,176,.1);color:var(--panel-cyan);}
/* "+ Add Newcomer" small button on the Newcomers strip — sits next to the eye. */
.panel-strip-add{
  height:20px;border-radius:5px;border:1px solid var(--panel-border);
  background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  color:var(--panel-muted);transition:color .12s,background .12s,border-color .12s;
  flex-shrink:0;padding:0 8px 0 6px;margin-left:auto;gap:4px;
  font-size:10px;font-weight:600;font-family:inherit;letter-spacing:.2px;
}
.panel-strip-add:hover{background:rgba(255,100,220,.12);color:#c020a0;border-color:#d030b0;}
.panel-strip-add:disabled{opacity:.4;cursor:not-allowed;}
.panel-strip-add:disabled:hover{background:transparent;color:var(--panel-muted);border-color:var(--panel-border);}
/* When the strip-add is shown, the eye-button can't take margin-left:auto anymore.
   We let .panel-strip-add carry the auto and reset the eye button's. */
#btnEyeDisco{margin-left:0;}

/* Cache info modal — light theme matching the Examine modal aesthetic. */
#cacheInfoOverlay{
  position:fixed;inset:0;background:rgba(0,0,0,.5);
  display:flex;align-items:center;justify-content:center;z-index:520;
  opacity:0;pointer-events:none;transition:opacity .15s;
}
#cacheInfoOverlay.open{opacity:1;pointer-events:all;}
#cacheInfoModal{
  background:#fff;border:1px solid var(--panel-border);border-radius:10px;
  padding:18px 20px 14px;width:360px;max-width:92vw;max-height:80vh;
  transform:translateY(8px);transition:transform .15s;
  display:flex;flex-direction:column;color:var(--panel-text);
  box-shadow:0 12px 28px rgba(0,0,0,.25);
}
#cacheInfoOverlay.open #cacheInfoModal{transform:translateY(0);}
#cacheInfoModal h2{
  font-size:14px;font-weight:700;margin-bottom:12px;color:#1f2937;
  display:flex;align-items:center;gap:7px;
}
.cache-info-body{
  font-size:11.5px;line-height:1.55;color:#374151;
  overflow-y:auto;padding-right:4px;
}
.cache-info-body p{margin-bottom:9px;}
.cache-info-body p:last-child{margin-bottom:0;}
.cache-info-body strong{color:var(--panel-cyan);font-weight:700;}
.cache-info-actions{
  display:flex;justify-content:flex-end;margin-top:14px;
}
#cacheInfoClose{background:var(--panel-cyan);color:#fff;border:none;}
#cacheInfoClose:hover{background:#0a7798;}

/* ── Pre-import equipment filter modal ───────────────────── */
#importFilterOverlay{
  position:fixed;inset:0;background:rgba(0,0,0,.5);
  display:flex;align-items:center;justify-content:center;z-index:520;
  opacity:0;pointer-events:none;transition:opacity .15s;
}
#importFilterOverlay.open{opacity:1;pointer-events:all;}
#importFilterModal{
  background:#fff;border:1px solid var(--panel-border);border-radius:10px;
  padding:18px 20px 14px;width:420px;max-width:92vw;max-height:85vh;
  transform:translateY(8px);transition:transform .15s;
  display:flex;flex-direction:column;color:var(--panel-text);
  box-shadow:0 12px 28px rgba(0,0,0,.25);
}
#importFilterOverlay.open #importFilterModal{transform:translateY(0);}
#importFilterModal h2{
  font-size:14px;font-weight:700;margin-bottom:4px;color:#1f2937;
  display:flex;align-items:center;gap:7px;
}
.import-filter-filename{
  font-size:11px;color:var(--panel-muted);margin-bottom:12px;
  font-family:'DM Mono',monospace;word-break:break-all;
}
.import-filter-subhead{
  font-size:11.5px;color:#374151;margin-bottom:10px;line-height:1.45;
}
.import-filter-body{
  overflow-y:auto;padding-right:4px;flex:1;min-height:0;
  margin:0 -4px;padding:0 8px;
}
.import-filter-list{
  display:flex;flex-direction:column;gap:2px;margin-bottom:6px;
}
.import-filter-row{
  display:flex;align-items:center;gap:10px;
  padding:7px 9px;border-radius:6px;cursor:pointer;
  transition:background .1s;user-select:none;
}
.import-filter-row:hover{background:rgba(0,0,0,.035);}
.import-filter-row input[type="checkbox"]{
  margin:0;flex-shrink:0;width:14px;height:14px;cursor:pointer;
  accent-color:var(--panel-cyan);
}
.import-filter-row .if-emoji{font-size:15px;flex-shrink:0;line-height:1;}
.import-filter-row .if-label{
  font-size:12px;font-weight:600;color:#1f2937;flex:1;
}
.import-filter-row .if-count{
  font-size:11px;font-family:'DM Mono',monospace;color:var(--panel-muted);
  background:rgba(0,0,0,.04);padding:2px 7px;border-radius:10px;
  flex-shrink:0;
}
.import-filter-empty{
  font-size:11.5px;color:var(--panel-muted);font-style:italic;
  padding:14px 9px;text-align:center;
}
.import-filter-divider{
  margin:10px 0 6px;border-top:1px dashed var(--panel-border);
  padding-top:10px;
}
.import-filter-section-label{
  font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;
  color:var(--panel-muted);margin-bottom:2px;padding:0 9px;
}
.import-filter-section-help{
  font-size:11px;color:var(--panel-muted);line-height:1.4;
  padding:0 9px;margin-bottom:6px;
}
.import-filter-row.unmatched{
  cursor:default;opacity:.7;
}
.import-filter-row.unmatched:hover{background:transparent;}
.import-filter-row.unmatched .if-label{
  color:var(--panel-muted);font-weight:500;font-style:italic;
}
.import-filter-actions{
  display:flex;justify-content:space-between;align-items:center;
  margin-top:14px;gap:10px;
}
.import-filter-toggle-all{
  font-size:11px;color:var(--panel-cyan);background:none;border:none;
  cursor:pointer;padding:4px 6px;font-weight:600;font-family:inherit;
}
.import-filter-toggle-all:hover{text-decoration:underline;}
.import-filter-buttons{display:flex;gap:8px;}
#importFilterConfirm{background:var(--panel-cyan);color:#fff;border:none;}
#importFilterConfirm:hover:not(:disabled){background:#0a7798;}
#importFilterConfirm:disabled{opacity:.45;cursor:not-allowed;}

#panel-import-strip-inner{
  padding:6px 12px;border-bottom:1px solid var(--panel-border);
  font-size:10px;color:var(--panel-muted);display:flex;align-items:center;gap:6px;
  flex-shrink:0;min-height:30px;background:var(--panel-surface);
  position:sticky;top:0;z-index:10;
}
#panel-import-strip-inner.has-data{color:var(--panel-cyan);}
#import-status-dot2{width:6px;height:6px;border-radius:50%;background:var(--panel-border);flex-shrink:0;}
#panel-import-strip-inner.has-data #import-status-dot2{background:var(--panel-cyan);}
.panel-body{flex:1;overflow-y:auto;padding:0;scrollbar-width:thin;scrollbar-color:var(--panel-border) transparent;}
.panel-body.hidden{display:none;}

/* panel empty state */
.panel-empty{
  padding:40px 20px;text-align:center;color:var(--panel-muted);
  font-size:11px;line-height:1.6;
  display:flex;flex-direction:column;align-items:center;gap:10px;
}
.panel-empty-icon{font-size:40px;margin-bottom:4px;opacity:.85;}
.panel-empty-title{
  font-size:15px;font-weight:800;color:var(--panel-text);
  letter-spacing:-.3px;margin-bottom:2px;
}
.panel-empty-sub{font-size:11px;line-height:1.6;color:var(--panel-muted);margin-bottom:6px;}
.panel-empty-btn{
  display:inline-flex;align-items:center;gap:7px;
  padding:9px 18px;background:transparent;color:var(--panel-cyan);
  border:1.5px solid var(--panel-cyan);border-radius:6px;
  font-family:inherit;font-weight:700;font-size:12px;
  cursor:pointer;transition:background .15s,transform .1s;letter-spacing:.3px;
}
.panel-empty-btn:hover{background:rgba(71,194,255,.1);}
.panel-empty-btn:active{transform:scale(.97);}
.panel-empty-btn svg{width:13px;height:13px;flex-shrink:0;}
.panel-empty-btn:disabled{opacity:.45;cursor:not-allowed;}
.panel-empty-btn:disabled:hover{background:transparent;}
.panel-empty-btn:disabled:active{transform:none;}

/* room group in panel */
.room-group{border-bottom:1px solid var(--panel-border);}
.room-group-header{
  display:flex;align-items:center;gap:8px;padding:8px 12px;
  cursor:pointer;user-select:none;background:var(--panel-surface);
  transition:background .12s;position:relative;
}
.room-group-header:hover{background:#e6eaee;}
.room-group-header.selected{background:var(--panel-cyan-bg);}
.asset-item.accounted{box-shadow:inset -3px 0 0 var(--success);}
.room-group-chevron{
  width:12px;height:12px;flex-shrink:0;color:var(--panel-muted);
  transition:transform .15s;
}
.room-group.open .room-group-chevron{transform:rotate(90deg);}
.room-group-code{font-size:11px;font-weight:700;flex:1;color:var(--panel-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.room-sel-dot{
  width:7px;height:7px;border-radius:50%;background:var(--panel-cyan);
  flex-shrink:0;opacity:0;transition:opacity .15s;
}
.room-group-header.selected .room-sel-dot{opacity:1;}
.room-visited-dot{
  width:7px;height:7px;border-radius:50%;background:var(--success);
  flex-shrink:0;opacity:0;
}
.room-group-header.visited .room-visited-dot{opacity:1;}
.room-asset-count{
  font-size:10px;font-weight:700;font-family:monospace;
  padding:1px 7px;border-radius:10px;flex-shrink:0;white-space:nowrap;
  border:1px solid transparent;transition:background .15s,color .15s,border-color .15s;
}
.room-asset-count.pending{background:rgba(107,114,128,.12);color:var(--panel-muted);border-color:rgba(107,114,128,.25);}
.room-asset-count.progress{background:rgba(71,194,255,.15);color:#0a6c88;border-color:rgba(71,194,255,.45);}
.room-asset-count.done{background:rgba(74,222,128,.18);color:#166534;border-color:rgba(74,222,128,.45);}

/* asset list inside room group */
.room-assets{display:none;padding:0 0 4px 0;background:var(--panel-bg);}
.room-group.open .room-assets{display:block;}
.asset-item{
  display:flex;align-items:center;gap:8px;padding:5px 12px 5px 28px;
  font-size:11px;transition:background .1s;cursor:default;
}
.asset-item:hover{background:rgba(10,138,176,.05);}
.asset-item.placed{opacity:.55;}
.asset-check{
  width:14px;height:14px;border-radius:3px;border:1.5px solid #b0bbc8;
  background:#e8ecf0;
  flex-shrink:0;display:flex;align-items:center;justify-content:center;
  cursor:pointer;transition:border-color .15s,background .15s;
}
.asset-check:hover{border-color:var(--panel-cyan);background:#d4eef5;}
.asset-check.checked{background:var(--success);border-color:var(--success);}
.asset-check.checked::after{content:'✓';font-size:9px;color:#000;font-weight:800;}
.asset-check.manual-check{cursor:pointer;}
.asset-id-pill{font-size:9px;font-weight:800;font-family:monospace;padding:1px 6px;border-radius:3px;flex-shrink:0;white-space:nowrap;}
.asset-id-pill.cyan{background:rgba(71,194,255,.12);color:#0a8ab0;border:1px solid rgba(71,194,255,.3);}
.asset-id-pill.cyan.filled{background:#0a8ab0;color:#fff;border:1px solid #0a8ab0;}
.asset-id-pill.cyan.dotted{background:transparent;color:#0a8ab0;border:1px dashed rgba(10,138,176,.5);}
.asset-id-pill.magenta{background:rgba(255,71,194,.12);color:#c020a0;border:1px solid rgba(255,71,194,.3);}
.asset-marker-icon{flex-shrink:0;margin-left:auto;}
.asset-marker-icon.jumpable{
  /* The SVG's intrinsic width/height attributes have been removed in
     markup so this CSS is the only source of size. Sized to roughly
     match the equipment emojis on the left of the row (~13px). Larger
     hit area via padding only — no negative margin, otherwise the
     icon would be drawn behind the .asset-item.accounted right stripe. */
  width:16px;height:21px;
  cursor:pointer;padding:2px 4px;
  border-radius:4px;transition:background .12s,transform .08s;
}
.asset-marker-icon.jumpable:hover{background:rgba(10,138,176,.14);}
.asset-marker-icon.jumpable:active{transform:scale(.92);}
.asset-status-icon{flex-shrink:0;margin-left:auto;font-size:12px;line-height:1;cursor:pointer;}
.asset-undo-btn{
  flex-shrink:0;margin-left:auto;
  padding:3px 9px;border:1px solid rgba(255,255,255,.08);
  background:transparent;border-radius:4px;cursor:pointer;
  color:var(--muted);font-family:inherit;font-size:10px;font-weight:600;
  letter-spacing:.3px;text-transform:lowercase;
  transition:background .12s,color .12s,border-color .12s;
}
.asset-undo-btn:hover{
  background:rgba(255,255,255,.04);
  color:var(--panel-text);
  border-color:rgba(255,255,255,.18);
}
.asset-label.strikethrough{text-decoration:line-through;color:var(--panel-muted);}
.room-group-code .room-done-check{color:#4ade80;font-size:10px;margin-left:4px;}
.movers-section-header{
  padding:8px 12px 4px;font-size:10px;font-weight:700;letter-spacing:.8px;
  text-transform:uppercase;color:var(--panel-muted);
  border-bottom:1px solid var(--panel-border);
  background:var(--panel-bg);position:sticky;top:0;z-index:5;
}
.asset-item.flash{animation:rowflash .9s ease-out;}
@keyframes rowflash{0%{background:rgba(245,158,11,.35);}100%{background:transparent;}}
@keyframes mflash{
  0%{transform:translate(-50%,-100%) scale(1);}
  35%{transform:translate(-50%,-100%) scale(1.6);filter:drop-shadow(0 0 8px #4ade80);}
  100%{transform:translate(-50%,-100%) scale(1);}
}
.marker.flash{animation:mflash .9s ease-out;}
.asset-emoji{font-size:13px;flex-shrink:0;line-height:1;}
.asset-info{flex:1;min-width:0;}
.asset-label{font-weight:600;color:var(--panel-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.asset-label.new-asset{color:var(--panel-cyan);}
.asset-label.renamed{font-style:italic;}
.btn-revert-m{background:rgba(255,255,255,.06);color:var(--muted);border:1px solid var(--border);font-size:10px;}
.modal-name-wrap{position:relative;display:flex;align-items:center;margin-bottom:12px;}
.modal-name-wrap input{flex:1;margin-bottom:0;}
.btn-undo-name{
  flex-shrink:0;margin-left:6px;
  height:30px;padding:0 10px;border-radius:5px;
  background:rgba(255,255,255,.06);border:1px solid var(--border);
  color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.2px;
  cursor:pointer;
  display:none;align-items:center;justify-content:center;gap:5px;
  white-space:nowrap;
  transition:background .12s,color .12s,border-color .12s;
}
.btn-undo-name:hover{background:rgba(255,255,255,.12);color:var(--text);border-color:#3a3d45;}
.btn-undo-name.show{display:inline-flex;}
.asset-sub{font-size:9px;color:var(--panel-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.asset-new-badge{
  font-size:8px;font-weight:700;background:rgba(10,138,176,.12);color:var(--panel-cyan);
  border:1px solid rgba(10,138,176,.3);border-radius:3px;padding:1px 5px;flex-shrink:0;
}

/* ── FAB group ── */
#fab-group{
  position:fixed;right:14px;top:calc(var(--tool-h) + var(--info-h) + 16px);
  display:flex;flex-direction:column;align-items:center;gap:8px;z-index:180;
  pointer-events:none;transition:right .2s ease;
}
#fab-group>*{pointer-events:all;}
.fab{
  width:40px;height:40px;border-radius:50%;border:none;
  background:var(--surface);box-shadow:0 2px 10px rgba(0,0,0,.55);
  cursor:pointer;display:flex;align-items:center;justify-content:center;
  color:var(--text);transition:background .14s,transform .1s;flex-shrink:0;
}
.fab:hover{background:#22252d;transform:scale(1.07);}
.fab:active{transform:scale(.95);}
.fab svg{width:18px;height:18px;pointer-events:none;}
.fab-text{
  font-family:'DM Mono','Courier New',monospace;
  font-size:10px;font-weight:600;letter-spacing:.3px;
  text-transform:lowercase;
}
.fab.active{background:var(--accent);color:#000;box-shadow:0 2px 10px rgba(232,255,71,.35);}
#fab-panel-toggle{background:rgba(71,194,255,.12);color:var(--accent2);}
#fab-panel-toggle.active{background:var(--accent2);color:#000;}
#fab-compass{display:none;}
@media(max-width:768px){#fab-compass{display:flex;}}
#compass-needle{transition:transform .35s cubic-bezier(.34,1.56,.64,1);}
#fab-zoom-pct{
  background:var(--surface);border:1px solid var(--border);border-radius:16px;
  font-family:'Courier New',monospace;font-size:10px;font-weight:600;color:var(--muted);
  padding:4px 8px;text-align:center;min-width:44px;white-space:nowrap;
  box-shadow:0 1px 6px rgba(0,0,0,.4);user-select:none;line-height:1.4;
}

/* ── info bar ── */
#infobar{
  position:fixed;top:var(--tool-h);left:0;right:0;height:var(--info-h);
  background:var(--panel-bg);border-bottom:1px solid var(--panel-border);
  display:flex;align-items:center;padding:0;gap:0;z-index:190;
  overflow:hidden;transition:right .2s ease;
}
#infobar.empty{ border-bottom-color:transparent; }

/* left: room identity — tinted background, stacked: code+link on top, space name below */
#info-room{
  display:flex;flex-direction:column;justify-content:center;gap:3px;
  min-width:0;flex-shrink:0;
  background:#d9e7ed;
  padding:0 14px;
  align-self:stretch;
  border-right:1px solid var(--panel-border);
}
#info-room-text{
  display:flex;flex-direction:row;align-items:baseline;gap:8px;flex-shrink:0;
}
#info-room-code{
  font-size:14px;font-weight:600;letter-spacing:-.2px;
  white-space:nowrap;line-height:1.15;color:var(--panel-text);
}
#info-room-space-name{
  font-size:11px;font-weight:600;color:var(--panel-text);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  display:none;align-items:center;gap:5px;min-width:0;
}
#info-room-space-name::before{
  content:'XLS';font-size:7px;font-weight:800;letter-spacing:.3px;
  background:var(--panel-cyan-bg);border:1px solid rgba(10,138,176,.25);
  color:var(--panel-cyan);border-radius:3px;padding:1px 4px;flex-shrink:0;
}

/* middle: device summary chips — wraps onto 2 rows when needed */
#info-devices{
  display:flex;align-items:flex-start;gap:5px 6px;flex:1;
  min-width:0;padding:8px 14px;
  flex-wrap:wrap;overflow:hidden;
  align-content:center;
}
.dev-chip{
  display:inline-flex;align-items:center;gap:4px;
  background:var(--panel-surface);border:1px solid var(--panel-border);
  border-radius:5px;padding:3px 8px;font-size:11px;white-space:nowrap;flex-shrink:0;
  color:var(--panel-text);
}
.dev-chip .emoji{font-size:13px;line-height:1;}
.dev-chip .count{
  background:var(--panel-cyan);color:#ffffff;font-weight:800;font-size:10px;
  padding:0px 5px;border-radius:3px;min-width:16px;text-align:center;
}
.info-devices-label{
  font-size:10px;font-weight:700;letter-spacing:.3px;
  color:var(--panel-muted);text-transform:uppercase;flex-shrink:0;
  margin-right:2px;align-self:center;
}

/* right: visited badge */
#info-visited{
  flex-shrink:0;margin-left:auto;padding:0 14px;border-left:1px solid var(--panel-border);
  align-self:stretch;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
}
#info-visited-dot{
  width:10px;height:10px;border-radius:50%;
  background:#4ade80;border:1px solid rgba(0,0,0,.12);
}
#info-visited-label{font-size:9px;color:var(--panel-muted);font-weight:700;letter-spacing:.5px;text-transform:uppercase;}
#info-empty{font-size:11px;color:var(--panel-muted);font-style:italic;padding:0 14px;}

/* acknowledge button in infobar */
#info-unlinked-wrap{
  flex-shrink:0;margin-left:auto;padding:0 14px 0 14px;border-left:1px solid var(--panel-border);
  display:none;flex-direction:column;align-items:stretch;justify-content:center;gap:5px;
  align-self:stretch;width:140px;
}
.info-action-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  background:rgba(71,194,255,.12);border:1px solid var(--accent2);
  color:var(--panel-cyan);border-radius:5px;padding:5px 10px;font-size:11px;font-weight:700;
  cursor:pointer;white-space:nowrap;letter-spacing:.2px;
  text-decoration:none;
  transition:background .15s,transform .08s;
}
.info-action-btn:hover{ background:rgba(71,194,255,.22); }
.info-action-btn:active{ transform:translateY(1px); }
.info-action-btn svg{ width:12px;height:12px;flex-shrink:0; }
/* keep the legacy id selector for the Examine button — same look as .info-action-btn */
#btn-acknowledge-all{ /* inherits .info-action-btn now */ }

/* bulk acknowledge modal */
#ackOverlay{
  position:fixed;inset:0;background:rgba(0,0,0,.6);
  display:flex;align-items:center;justify-content:center;z-index:310;
  opacity:0;pointer-events:none;transition:opacity .15s;
}
#ackOverlay.open{opacity:1;pointer-events:all;}
#ackModal{
  background:#ffffff;color:#1f2937;
  border:1px solid #e5e7eb;border-radius:10px;
  padding:20px 18px 16px;width:360px;
  transform:translateY(8px);transition:transform .15s;
  max-height:80vh;display:flex;flex-direction:column;
  box-shadow:0 10px 40px rgba(0,0,0,.35);
}
#ackOverlay.open #ackModal{transform:translateY(0);}
#ackModal h2{font-size:14px;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:7px;color:#1f2937;}
#ack-room-sub{font-size:10px;color:#6b7280;margin-bottom:14px;}

/* Tab row: sits on a light grey shelf. Active tab merges into the white modal body below. */
#ack-status-picker{
  display:flex;gap:2px;margin:0 -18px 0;padding:0 10px;
  background:#f3f4f6;border-bottom:1px solid #e5e7eb;
}
.ack-tab{
  flex:1;padding:9px 4px 8px;text-align:center;font-size:10px;font-weight:700;
  letter-spacing:.3px;color:#6b7280;
  cursor:pointer;
  border:1px solid transparent;border-bottom:none;
  border-radius:6px 6px 0 0;
  margin-bottom:-1px; /* active tab covers the shelf border */
  transition:color .15s,background .15s,border-color .15s;
  user-select:none;display:flex;flex-direction:column;align-items:center;gap:2px;
  position:relative;
}
.ack-tab span:first-child{font-size:15px;line-height:1;}
.ack-tab:hover:not(.active){background:rgba(255,255,255,.5);color:#1f2937;}

/* Active tab: white background merges with modal body, coloured top accent + side borders */
.ack-tab.active{
  background:#ffffff;
  border-color:#e5e7eb;
  border-top-width:3px;
  padding-top:7px;
}
.ack-tab.active[data-status="confirmed"]{color:#15803d;border-top-color:#4ade80;}
.ack-tab.active[data-status="stored-av"]{color:#6d28d9;border-top-color:#a78bfa;}
.ack-tab.active[data-status="stored-faculty"]{color:#1e3a8a;border-top-color:#1d4ed8;}
.ack-tab.active[data-status="offmap"]{color:#b45309;border-top-color:#f59e0b;}
.ack-tab.active[data-status="gone"]{color:#b91c1c;border-top-color:#ef4444;}

/* Inactive tab: faint background tint per status (shows identity at a glance).
   Confirmed and AV were noticeably paler than the rest — bumped to match. */
.ack-tab[data-status="confirmed"]:not(.active){background:rgba(74,222,128,.16);}
.ack-tab[data-status="stored-av"]:not(.active){background:rgba(167,139,250,.18);}
.ack-tab[data-status="stored-faculty"]:not(.active){background:rgba(29,78,216,.1);}
.ack-tab[data-status="offmap"]:not(.active){background:rgba(245,158,11,.1);}
.ack-tab[data-status="gone"]:not(.active){background:rgba(239,68,68,.1);}

#ack-hint{
  font-size:10px;color:#6b7280;font-style:italic;
  margin:12px 0 10px;
}

.ack-offmap-label{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#6b7280;margin-bottom:5px;}
.ack-offmap-segments{display:flex;align-items:center;gap:2px;}
.ack-offmap-seg{
  width:44px;padding:5px 6px;background:#f9fafb;border:1px solid #d1d5db;
  border-radius:5px;color:#1f2937;font-size:11px;font-family:monospace;
  text-align:center;outline:none;transition:border-color .15s;
}
.ack-offmap-seg:focus{border-color:#f59e0b;background:#fff;}
.ack-offmap-seg.invalid{border-color:#ef4444;}
.ack-offmap-seg:disabled{opacity:.4;background:#f3f4f6;}
.ack-offmap-dot{color:#9ca3af;font-size:13px;font-weight:700;user-select:none;line-height:1;}

#ack-select-all-row{
  display:flex;align-items:center;gap:8px;padding:6px 0;
  border-bottom:1px solid #e5e7eb;margin-bottom:8px;
  font-size:11px;font-weight:700;cursor:pointer;color:#15803d;
  user-select:none;
}
#ack-asset-list{
  overflow-y:auto;flex:1;max-height:280px;
  scrollbar-width:thin;scrollbar-color:#d1d5db transparent;
  border:1px solid #e5e7eb;border-radius:6px;margin-bottom:12px;background:#fff;
}
.ack-asset-row{
  display:flex;align-items:center;gap:8px;padding:8px 10px;
  cursor:pointer;font-size:11px;transition:background .1s;
  border-bottom:1px solid #f3f4f6;color:#1f2937;
}
.ack-asset-row:last-child{border-bottom:none;}
.ack-asset-row:hover{background:#f9fafb;}
/* "Accounted for": any deliberate status — same green right-edge as the right panel */
.ack-asset-row.accounted{box-shadow:inset -3px 0 0 #4ade80;}
.ack-check{
  width:14px;height:14px;border-radius:3px;border:1.5px solid #9ca3af;
  background:#fff;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  pointer-events:none;
}
/* Base state: row unassigned (checkbox empty, no tint) */
.ack-asset-row .ack-check{background:#fff;border-color:#9ca3af;}

/* Per-row assigned state drives colour. data-assigned on each row. */
.ack-asset-row[data-assigned="confirmed"] .ack-check{background:#22c55e;border-color:#22c55e;}
.ack-asset-row[data-assigned="confirmed"] .ack-check::after{content:'✓';font-size:9px;color:#fff;font-weight:800;}
.ack-asset-row[data-assigned="confirmed"]{background:rgba(74,222,128,.12);}

.ack-asset-row[data-assigned="stored-av"] .ack-check{background:#a78bfa;border-color:#a78bfa;}
.ack-asset-row[data-assigned="stored-av"] .ack-check::after{content:'✓';font-size:9px;color:#fff;font-weight:800;}
.ack-asset-row[data-assigned="stored-av"]{background:rgba(167,139,250,.14);}

.ack-asset-row[data-assigned="stored-faculty"] .ack-check{background:#1d4ed8;border-color:#1d4ed8;}
.ack-asset-row[data-assigned="stored-faculty"] .ack-check::after{content:'✓';font-size:9px;color:#fff;font-weight:800;}
.ack-asset-row[data-assigned="stored-faculty"]{background:rgba(29,78,216,.12);}

.ack-asset-row[data-assigned="offmap"] .ack-check{background:#f59e0b;border-color:#f59e0b;}
.ack-asset-row[data-assigned="offmap"] .ack-check::after{content:'✓';font-size:9px;color:#fff;font-weight:800;}
.ack-asset-row[data-assigned="offmap"]{background:rgba(245,158,11,.14);}

.ack-asset-row[data-assigned="gone"] .ack-check{background:#ef4444;border-color:#ef4444;}
.ack-asset-row[data-assigned="gone"] .ack-check::after{content:'✓';font-size:9px;color:#fff;font-weight:800;}
.ack-asset-row[data-assigned="gone"]{background:rgba(239,68,68,.12);}

/* Select-all row: colour follows the currently active tab */
#ack-select-all-row{color:#15803d;}
#ackModal[data-status="stored-av"] #ack-select-all-row{color:#6d28d9;}
#ackModal[data-status="stored-faculty"] #ack-select-all-row{color:#1e3a8a;}
#ackModal[data-status="offmap"] #ack-select-all-row{color:#b45309;}
#ackModal[data-status="gone"] #ack-select-all-row{color:#b91c1c;}
#ack-select-all-row.selected .ack-check{background:currentColor;border-color:currentColor;}
#ack-select-all-row.selected .ack-check::after{content:'✓';font-size:9px;color:#fff;font-weight:800;}

.ack-asset-emoji{font-size:14px;flex-shrink:0;line-height:1;}
.ack-asset-info{flex:1;min-width:0;}
.ack-asset-label{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1f2937;}
.ack-asset-label.strikethrough{text-decoration:line-through;color:#6b7280;}
.ack-asset-label.renamed{font-style:italic;}
.ack-asset-sub{font-size:9px;color:#6b7280;}

/* Marker-tied rows: read-only, with a remove-marker button */
.ack-asset-row.is-marked{ cursor:default; opacity:.85; background:#f9fafb; }
.ack-asset-row.is-marked:hover{ background:#f3f4f6; }
.ack-asset-row.is-marked .ack-check.ack-marked{
  background:transparent;border:none;
  width:14px;height:14px;line-height:1;
  display:flex;align-items:center;justify-content:center;
}
.ack-asset-row.is-marked .ack-check.ack-marked svg{
  width:10px;height:13px;display:block;
}
.ack-remove-marker{
  flex-shrink:0;background:transparent;border:1px solid #d4dae0;color:#6b7280;
  font-size:9px;font-weight:600;padding:3px 7px;border-radius:4px;cursor:pointer;
  letter-spacing:.2px;white-space:nowrap;transition:background .12s,border-color .12s,color .12s;
}
.ack-remove-marker:hover{
  background:rgba(239,68,68,.08);border-color:#ef4444;color:#ef4444;
}

/* Toast: was unstyled before — now a small light card at the bottom centre. */
#fp-toast{
  position:fixed;bottom:18px;left:50%;transform:translateX(-50%) translateY(8px);
  background:#1f2937;color:#fff;border-radius:6px;padding:8px 14px;font-size:11px;
  font-weight:600;letter-spacing:.2px;box-shadow:0 4px 16px rgba(0,0,0,.35);
  pointer-events:none;opacity:0;transition:opacity .15s,transform .15s;
  z-index:500;display:inline-flex;align-items:center;gap:10px;max-width:80vw;
  white-space:nowrap;
}
#fp-toast.show{ opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto; }
#fp-toast.warn{ background:#7f1d1d; }
.fp-toast-undo{
  background:transparent;border:1px solid rgba(255,255,255,.4);
  color:#47c2ff;font-size:10px;font-weight:700;letter-spacing:.4px;
  padding:3px 9px;border-radius:4px;cursor:pointer;text-transform:uppercase;
  transition:background .12s,border-color .12s;
}
.fp-toast-undo:hover{ background:rgba(71,194,255,.15);border-color:#47c2ff; }
#ack-actions{display:flex;gap:8px;justify-content:flex-end;}
/* Override .btn-modal defaults for this light-themed modal */
#ack-confirm-btn{background:#15803d;color:#fff;border:none;}
#ack-confirm-btn:hover{background:#166534;}
#ack-cancel-btn{background:#e5e7eb;color:#374151;border:none;}
#ack-cancel-btn:hover{background:#d1d5db;}

/* The asset id pill inside ack rows needs darker ink on light bg */
/* Pills inside the Examine modal use the same colour scheme as the right panel,
   but with OPAQUE backgrounds so the per-row pastel tints can't bleed through. */
#ackModal .asset-id-pill.cyan{background:#e7f4fa;color:#0a8ab0;border:1px solid #b6dceb;}
#ackModal .asset-id-pill.cyan.filled{background:#0a8ab0;color:#fff;border:1px solid #0a8ab0;}
#ackModal .asset-id-pill.cyan.dotted{background:#ffffff;color:#0a8ab0;border:1px dashed rgba(10,138,176,.5);}

/* ── canvas ── */
#canvas{
  position:fixed;top:calc(var(--tool-h) + var(--info-h));left:0;right:0;bottom:0;
  overflow:hidden;cursor:grab;user-select:none;transition:right .2s ease;
}
/* Placing-mode crosshair: covers descendants with !important so the cursor
   stays a crosshair even over child elements that declare their own cursor
   — room polygons (pointer), #svg-wrap (default), markers (pointer). */
#canvas.placing,
#canvas.placing *{cursor:crosshair !important;}
#canvas.dragging{cursor:grabbing;}
#canvas.moving-marker{cursor:move;}

#world{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform;}
#svg-wrap{display:block;line-height:0;position:relative;}
#svg-wrap svg{display:block;max-width:none !important;}

/* room states */
path.floor-plan-space{cursor:pointer;transition:fill .12s;}
g.space_text{pointer-events:none;}
#svg-wrap{cursor:default;}
path.floor-plan-space.fp-selected{fill:rgba(71,194,255,.18) !important;stroke:#47c2ff !important;stroke-width:0.08 !important;}
path.floor-plan-space.fp-visited {fill:rgba(144,238,144,.35) !important;}
path.floor-plan-space.fp-visited.fp-selected{fill:rgba(144,238,144,.35) !important;stroke:#47c2ff !important;stroke-width:0.08 !important;}
path.floor-plan-space.fp-imported{fill:rgba(232,255,71,.28) !important;stroke:#e8ff47 !important;stroke-width:0.06 !important;}
path.floor-plan-space.fp-imported.fp-selected{fill:rgba(232,255,71,.28) !important;stroke:#e8ff47 !important;stroke-width:0.08 !important;}
path.floor-plan-space.fp-imported.fp-visited{fill:rgba(232,255,71,.28) !important;}
path.floor-plan-space.fp-disco{fill:rgba(255,100,220,.22) !important;stroke:#ff64dc !important;stroke-width:0.06 !important;}
path.floor-plan-space.fp-disco.fp-selected{fill:rgba(255,100,220,.22) !important;stroke:#ff64dc !important;stroke-width:0.08 !important;}
path.floor-plan-space.fp-disco.fp-visited{fill:rgba(255,100,220,.22) !important;}

/* ── markers ── */
.marker{
  position:absolute;transform:translate(-50%,-100%);
  cursor:pointer;z-index:10;filter:none;transition:transform .1s;
}
.marker:hover{cursor:pointer;}
.marker.being-moved{opacity:.75;transform:translate(-50%,-100%) scale(1.2);cursor:move;z-index:20;}
.marker-emoji{font-size:1em;line-height:1;display:block;text-align:center;}
.marker-label{
  position:absolute;left:50%;transform:translateX(-50%);
  top:calc(100% + 1px);color:#ff47c2;font-size:.85em;font-weight:600;
  white-space:nowrap;pointer-events:none;
  max-width:110px;overflow:hidden;text-overflow:ellipsis;
}

/* ── modal ── */
.modal-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.6);
  display:flex;align-items:center;justify-content:center;z-index:300;
  opacity:0;pointer-events:none;transition:opacity .15s;
}
.modal-overlay.open{opacity:1;pointer-events:all;}
.modal{
  background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:20px 18px 16px;width:360px;
  transform:translateY(8px);transition:transform .15s;
}
.modal-overlay.open .modal{transform:translateY(0);}
.modal h2{font-size:13px;font-weight:800;margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}

/* Title row holds the h2 and the cog button. h2 wins flex space; cog
   sits at the right edge. The h2's own bottom-margin still controls the
   gap to whatever follows (mode toggle / link section / etc.). */
.modal-title-row{
  display:flex;align-items:flex-start;gap:8px;
}
.modal-title-row > h2{flex:1;min-width:0;}
.modal-cog{
  flex-shrink:0;width:26px;height:26px;border-radius:6px;
  background:transparent;border:1px solid var(--border);
  color:var(--muted);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;
  transition:background .12s,color .12s,border-color .12s;
  margin-top:-2px;
}
.modal-cog:hover{background:rgba(255,255,255,.06);color:var(--text);border-color:#3a3d45;}
.modal-cog[aria-expanded="true"]{background:var(--accent);color:#0e0f11;border-color:var(--accent);}

/* Details drawer: collapsed via [hidden]; visible flat list when open.
   Each row is "label : value" — label dimmed, value monospace for the
   technical fields (IPs, MACs, serials). */
.modal-details{
  margin-bottom:12px;padding:10px 12px;border:1px solid var(--border);
  border-radius:6px;background:rgba(255,255,255,.02);
}
.modal-details[hidden]{display:none;}
.modal-details-list{display:flex;flex-direction:column;gap:6px;}
.modal-details-row{
  display:flex;gap:10px;font-size:11px;line-height:1.35;align-items:baseline;
}
.modal-details-row .dl{
  flex:0 0 38%;color:var(--muted);
  font-size:10px;text-transform:uppercase;letter-spacing:.4px;font-weight:600;
}
.modal-details-row .dv{
  flex:1;font-family:'DM Mono',monospace;color:var(--text);word-break:break-all;
}
.modal-details-row .dv input{
  width:100%;background:#1e2028;border:1px solid var(--border);
  border-radius:4px;color:var(--text);
  padding:4px 6px;font:inherit;outline:none;margin:0;
}
.modal-details-row .dv input:focus{border-color:var(--accent2);}
.modal-details-row .dv input.invalid{border-color:var(--danger);background:rgba(255,95,95,.06);}
.modal-details-row .dv input.invalid:focus{border-color:var(--danger);box-shadow:0 0 0 2px rgba(255,95,95,.18);}
.detail-error{
  display:none;font-family:'Syne',sans-serif;font-size:10px;
  color:var(--danger);margin-top:3px;line-height:1.3;
}
.detail-error.show{display:block;}
.modal-details-empty{color:var(--muted);font-style:italic;font-size:11px;}
.modal h2 .eq-badge{font-size:10px;font-weight:600;color:var(--muted);background:rgba(255,255,255,.05);padding:2px 7px;border-radius:4px;}
.modal h2 .loc-badge{font-size:10px;font-weight:600;color:var(--muted);background:rgba(255,255,255,.05);padding:2px 7px;border-radius:4px;}
/* Status-tinted variants for the moved-from chip — match survey palette. */
.modal h2 .loc-badge.status-relocated{color:#f59e0b;background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.30);}
.modal h2 .loc-badge.status-offmap   {color:#f59e0b;background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.30);}
.modal h2 .loc-badge.status-stored   {color:#a78bfa;background:rgba(167,139,250,.10);border:1px solid rgba(167,139,250,.30);}
.modal h2 .loc-badge.status-gone     {color:var(--danger);background:rgba(255,95,95,.10);border:1px solid rgba(255,95,95,.30);}
.modal h2 .id-pill{font-size:11px;font-weight:800;font-family:monospace;padding:2px 8px;border-radius:4px;}
.modal h2 .id-pill.cyan{background:rgba(71,194,255,.15);color:#47c2ff;border:1px solid rgba(71,194,255,.3);}
.modal h2 .id-pill.magenta{background:rgba(255,71,194,.15);color:#ff47c2;border:1px solid rgba(255,71,194,.3);}
/* When a marker exists, the room pill itself is the jump button. Same
   look as a regular .loc-badge but interactive: cursor + subtle hover
   highlight. The marker SVG sits inline before the room code. */
.modal h2 .loc-badge-jump{
  display:inline-flex;align-items:center;gap:4px;
  cursor:pointer;font-family:inherit;
  /* base look matches .loc-badge — selectors for both apply since this
     element also has the .loc-badge class */
  transition:background .12s;
}
.modal h2 .loc-badge-jump:hover{background:rgba(71,194,255,.18);color:#47c2ff;}
.modal h2 .loc-badge-jump svg{display:block;}
.field-label{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);margin-bottom:4px;}
.modal input,.modal select{
  width:100%;padding:8px 10px;background:#1e2028;border:1px solid var(--border);
  border-radius:6px;color:var(--text);font-size:12px;outline:none;
  transition:border-color .15s;margin-bottom:12px;
}
.modal input:focus,.modal select:focus{border-color:var(--accent2);}
.modal input:disabled{
  background:#16181c;color:var(--muted);cursor:not-allowed;opacity:.7;
}
.field-readonly{
  display:none;font-family:'DM Mono',monospace;font-size:12px;
  color:var(--text);padding:8px 10px;background:rgba(255,255,255,.04);
  border-radius:6px;margin-bottom:12px;word-break:break-all;line-height:1.3;
}
.field-readonly.show{display:block;}
.modal select option{background:#1e2028;}
.modal-actions{
  display:flex;gap:8px;margin-top:4px;
  align-items:center;justify-content:flex-end;
  flex-wrap:nowrap;
}
.btn-modal{padding:7px 14px;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;transition:opacity .15s;white-space:nowrap;}
.btn-modal:hover{opacity:.85;}
.btn-modal:disabled{opacity:.35;cursor:not-allowed;}
.btn-modal:disabled:hover{opacity:.35;}
.btn-confirm{background:var(--accent);color:#000;}
.btn-cancel{background:var(--border);color:var(--text);}
/* Cancel pushes itself to the right edge, so anything left of it (Clear,
   Reposition, Remove Marker) stays grouped on the left. */
.modal-actions .btn-cancel{margin-left:auto;}
.btn-delete-m{background:var(--danger);color:#fff;display:inline-flex;align-items:center;gap:5px;}
.btn-position-m{background:rgba(71,194,255,.15);color:#47c2ff;border:1px solid rgba(71,194,255,.3);display:inline-flex;align-items:center;gap:5px;}
/* survey status section */
.survey-divider{border:none;border-top:1px solid var(--border);margin:10px 0;}
.survey-label{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;}

/* Location section: room typeahead + Position/Reposition button.
   The typeahead is a relative container so the dropdown panel can absolutely
   position itself underneath the input. */
/* "Found" sub-form: two rows, each with a tab-style mode button (Room /
   Marker) and the relevant control next to it. Mirrors the storage-button
   pattern (purple) but tinted green to match the "Found" status colour. */
.locate-by-label{
  font-size:9px;font-weight:700;letter-spacing:.6px;
  text-transform:uppercase;color:var(--muted);margin-bottom:4px;
}
/* Newcomer mode: bump the Locate-by label to match the other field
   labels (Name / Description, Equipment Type) since those are visually
   primary in that flow. Imported mode keeps the smaller default — there
   the Locate-by label sits inside the green Found-status card and a
   smaller treatment fits better. */
.modal.modal-newcomer-mode .locate-by-label{
  font-size:10px;letter-spacing:.8px;
}

/* Newcomer mode: the survey section's wrapper UI (status label, divider,
   the four status options' radios/titles/subtitles) is hidden — only the
   Locate-by sub-form inside #surveyOptConfirmed remains visible. The Found
   option's green tinted background is suppressed too, since picking a
   status isn't part of the newcomer flow. */
/* Newcomer mode: the survey-status wrapper UI (label, the four status
   options' radios/titles/subtitles) is hidden — only the Locate-by
   sub-form inside #surveyOptConfirmed remains visible. The survey-divider
   stays visible: in newcomer mode it serves as the separator between
   Equipment Type and Locate by. */
.modal.modal-newcomer-mode .survey-label{display:none;}
.modal.modal-newcomer-mode #surveyOptOffmap,
.modal.modal-newcomer-mode #surveyOptStored,
.modal.modal-newcomer-mode #surveyOptGone{display:none;}
.modal.modal-newcomer-mode #surveyOptConfirmed{
  background:transparent;border:none;padding:0;margin:0;
}
.modal.modal-newcomer-mode #surveyOptConfirmed .survey-radio,
.modal.modal-newcomer-mode #surveyOptConfirmed > .survey-opt-body > .survey-opt-title,
.modal.modal-newcomer-mode #surveyOptConfirmed > .survey-opt-body > .survey-opt-sub{display:none;}
.modal.modal-newcomer-mode #surveyInRoomOpts{
  display:block !important;max-height:none !important;overflow:visible !important;
  padding:0 !important;margin:0 !important;
}
/* When the asset doesn't yet have an identity (newcomer with no name
   typed), the Locate-by sub-form is hidden — there's nothing to attach
   a location to. The Equipment/Locate-by divider hides with it so they
   appear together. Imported assets always pass the identity gate, so
   this class is only ever applied in newcomer mode. */
.modal.locate-by-hidden #surveyInRoomOpts{display:none !important;}
.modal.locate-by-hidden .survey-divider{display:none !important;}
.lb-row{
  display:flex;align-items:center;gap:8px;margin-bottom:5px;
  padding:5px 8px;border-radius:6px;border:1px solid #d4dbe5;
  background:#ffffff;
  cursor:pointer;
  position:relative;
  /* Right-edge accent stripe — invisible by default, turns bright green
     on the active row. Matches the panel's accounted-asset stripe. */
  box-shadow:inset -3px 0 0 transparent;
  transition:background .12s,border-color .12s,box-shadow .12s;
}
.lb-row:last-child{margin-bottom:0;}
.lb-row:hover{background:rgba(74,222,128,.05);border-color:rgba(74,222,128,.4);}
.lb-row.active{
  background:rgba(74,222,128,.14);border-color:#4ade80;
  box-shadow:inset -3px 0 0 #4ade80;
}
.lb-row.disabled{
  opacity:.45;cursor:not-allowed;background:#f5f6f8;
  pointer-events:none;
}
.lb-tab{
  background:transparent;border:none;padding:0;
  color:#9ca3af;font-size:10px;font-weight:700;
  cursor:pointer;letter-spacing:.4px;text-transform:uppercase;
  font-family:inherit;flex-shrink:0;width:54px;text-align:left;
  transition:color .12s;
}
.lb-row.active .lb-tab{color:#15803d;}
.lb-row:hover:not(.active) .lb-tab{color:#4ade80;}
.lb-control{flex:1;display:flex;gap:6px;align-items:center;min-width:0;}
.lb-control .btn-modal{flex-shrink:0;}
.lb-pill{
  display:inline-flex;align-items:center;gap:4px;flex-shrink:0;
  background:rgba(74,222,128,.12);color:#4ade80;
  border:1px solid rgba(74,222,128,.4);border-radius:14px;
  padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;
  font-family:inherit;white-space:nowrap;
  transition:background .12s;
}
.lb-pill:hover{background:rgba(74,222,128,.22);}
/* Position / Reposition buttons inside the In-room rows: green-tinted to
   match the Found status colour, and padded so their rendered height
   matches the typeahead input — giving Room and Marker rows the same
   visual height. */
.lb-control .btn-position-m,
.lb-control .btn-move-m,
.lb-control .btn-remove-m{
  padding:4px 11px;font-size:11px;
  display:inline-flex;align-items:center;gap:5px;
}
.lb-control .btn-position-m,
.lb-control .btn-move-m{
  background:#4ade80;color:#0a2614;border:1px solid #4ade80;
}
.lb-control .btn-position-m:hover:not(:disabled),
.lb-control .btn-move-m:hover:not(:disabled){
  background:#3bce6f;border-color:#3bce6f;
}
.lb-control .btn-remove-m{
  background:var(--danger);color:#fff;border:1px solid var(--danger);
}
.lb-control .btn-remove-m:hover:not(:disabled){background:#b91c1c;border-color:#b91c1c;}
/* The lb-control variant must win over the global .btn-modal.btn-remove-m
   rule below, since the Marker row's Remove button has both classes.
   Doubling the .lb-control class is a CSS specificity trick: 0,2,1 vs
   the global rule's 0,2,0, so this rule wins without using !important. */
.lb-control.lb-control .btn-remove-m{
  background:var(--danger);color:#fff;border:1px solid var(--danger);
}
/* Global .btn-remove-m for use outside .lb-control (e.g. the newcomer
   modal's bottom action bar where Clear is transformed into a red
   "Remove Marker" button). Lighter pink/red for those. */
.btn-modal.btn-remove-m{
  background:rgba(255,95,95,.15);color:var(--danger);border:1px solid rgba(255,95,95,.4);
}
.btn-modal.btn-remove-m:hover:not(:disabled){background:rgba(255,95,95,.25);border-color:var(--danger);}
.loc-typeahead{position:relative;flex:1;min-width:0;}
.loc-input-wrap{position:relative;display:block;}
#locInput{
  width:100%;padding:4px 28px 4px 10px;border:1px solid var(--border);border-radius:6px;
  background:var(--surface);color:var(--text);font-size:12px;font-family:inherit;
  outline:none;transition:border-color .12s;
  display:block;margin:0;
}
#locInput:focus{border-color:var(--accent2);}
#locInput:disabled{opacity:.55;cursor:not-allowed;}
.loc-chevron{
  position:absolute;right:4px;top:50%;transform:translateY(-50%);
  width:22px;height:22px;border:none;background:transparent;cursor:pointer;
  display:flex;align-items:center;justify-content:center;color:#4ade80;
  border-radius:4px;transition:background .12s,color .12s;padding:0;
}
.loc-chevron:hover{background:rgba(74,222,128,.18);color:#3bce6f;}
.loc-chevron.open svg{transform:rotate(180deg);}
.loc-chevron svg{transition:transform .15s;display:block;}
.loc-dropdown{
  position:absolute;left:0;right:0;top:100%;margin-top:-1px;
  background:var(--surface);border:1px solid var(--border);border-radius:0 0 6px 6px;
  max-height:180px;overflow-y:auto;z-index:50;
  box-shadow:0 4px 14px rgba(0,0,0,.45);
}
.loc-item{
  padding:6px 10px;font-size:12px;cursor:pointer;
  display:flex;align-items:center;gap:6px;
}
.loc-item:hover,.loc-item.active{background:rgba(71,194,255,.10);color:var(--accent2);}
.loc-item.current{color:var(--muted);font-style:italic;}
.loc-item.selected{color:var(--accent2);}
.loc-empty{padding:8px 10px;font-size:11px;color:var(--muted);font-style:italic;}
.loc-confirm{
  position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:55;
  background:var(--surface);border:1px solid #f59e0b;border-radius:6px;
  padding:10px 12px;font-size:11px;line-height:1.5;color:var(--text);
  box-shadow:0 4px 14px rgba(0,0,0,.45);
}
.loc-confirm-msg{margin-bottom:8px;}
.loc-confirm-msg b{color:#f59e0b;}
.loc-confirm-actions{display:flex;gap:6px;justify-content:flex-end;}
.loc-confirm-actions button{
  padding:5px 10px;border-radius:5px;font-size:10px;font-weight:600;
  border:1px solid var(--border);background:transparent;color:var(--text);
  cursor:pointer;transition:background .12s;
}
.loc-confirm-actions button:hover{background:rgba(255,255,255,.06);}
.loc-confirm-actions button.confirm{background:#f59e0b;color:#000;border-color:#f59e0b;}
.loc-confirm-actions button.confirm:hover{background:#fbbf24;}

.survey-options{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}
.survey-opt{
  display:flex;align-items:flex-start;gap:9px;padding:7px 9px;border-radius:6px;
  border:1px solid var(--border);cursor:pointer;font-size:11px;color:var(--text);
  background:transparent;transition:background .12s,border-color .12s;
}
.survey-opt:hover{background:rgba(255,255,255,.04);}
.survey-opt.active-confirmed{border-color:#4ade80;background:rgba(74,222,128,.08);}
.survey-opt.active-relocated{border-color:#f59e0b;background:rgba(245,158,11,.08);}
.survey-opt.active-offmap{border-color:#f59e0b;background:rgba(245,158,11,.08);}
.survey-opt.active-stored{border-color:#a78bfa;background:rgba(167,139,250,.08);}
.survey-opt.active-gone{border-color:var(--danger);background:rgba(255,95,95,.08);}
.survey-radio{
  width:13px;height:13px;border-radius:50%;border:1.5px solid var(--muted);
  flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;
}
.survey-opt.active-confirmed .survey-radio{border-color:#4ade80;}
.survey-opt.active-confirmed .survey-radio::after{content:'';width:6px;height:6px;border-radius:50%;background:#4ade80;}
.survey-opt.active-relocated .survey-radio{border-color:#f59e0b;}
.survey-opt.active-relocated .survey-radio::after{content:'';width:6px;height:6px;border-radius:50%;background:#f59e0b;}
.survey-opt.active-offmap .survey-radio{border-color:#f59e0b;}
.survey-opt.active-offmap .survey-radio::after{content:'';width:6px;height:6px;border-radius:50%;background:#f59e0b;}
.survey-opt.active-stored .survey-radio{border-color:#a78bfa;}
.survey-opt.active-stored .survey-radio::after{content:'';width:6px;height:6px;border-radius:50%;background:#a78bfa;}
.survey-opt.active-gone .survey-radio{border-color:var(--danger);}
.survey-opt.active-gone .survey-radio::after{content:'';width:6px;height:6px;border-radius:50%;background:var(--danger);}
.survey-opt-body{flex:1;min-width:0;}
.survey-opt-title{font-weight:700;font-size:11px;}
.survey-opt-sub{font-size:10px;color:var(--muted);margin-top:1px;}
.survey-storage-opts{display:none;flex-direction:column;gap:4px;margin-top:7px;}
.survey-storage-opts.show{display:flex;}
.offmap-segments{display:flex;align-items:center;gap:2px;}
.offmap-seg{
  width:38px;padding:5px 6px;background:#1e2028;border:1px solid var(--border);
  border-radius:5px;color:var(--text);font-size:11px;font-family:monospace;
  text-align:center;outline:none;transition:border-color .15s;
}
.offmap-seg:focus{border-color:#f59e0b;}
.offmap-seg.invalid{border-color:var(--danger);}
.offmap-seg:disabled{opacity:.3;}
.offmap-dot{color:var(--muted);font-size:13px;font-weight:700;user-select:none;line-height:1;}
.offmap-hint{font-size:9px;color:var(--muted);margin-top:4px;}
.survey-storage-btn{
  padding:5px 9px;border-radius:5px;border:1px solid var(--border);
  background:transparent;color:var(--muted);font-size:10px;font-weight:700;
  cursor:pointer;text-align:left;transition:background .12s,border-color .12s,color .12s;
}
.survey-storage-btn:hover{background:rgba(167,139,250,.08);border-color:#a78bfa;color:#a78bfa;}
.survey-storage-btn.active{background:rgba(167,139,250,.15);border-color:#a78bfa;color:#a78bfa;}
.btn-move-m{background:rgba(71,194,255,.15);color:var(--accent2);border:1px solid rgba(71,194,255,.3);display:inline-flex;align-items:center;gap:5px;}

/* modal mode toggle */
.modal-mode-toggle{
  display:flex;border:1px solid var(--border);border-radius:6px;
  overflow:hidden;margin-bottom:14px;
}
.modal-mode-btn{
  flex:1;padding:6px 8px;border:none;background:transparent;
  color:var(--muted);font-size:10px;font-weight:700;cursor:pointer;
  text-transform:uppercase;letter-spacing:.5px;transition:background .15s,color .15s;
}
.modal-mode-btn.active{background:var(--accent2);color:#000;}
.modal-mode-btn:not(.active):hover{background:rgba(255,255,255,.05);color:var(--text);}

/* asset picker inside modal */
#modal-asset-list{
  max-height:160px;overflow-y:auto;margin-bottom:12px;
  border:1px solid var(--border);border-radius:6px;
  scrollbar-width:thin;scrollbar-color:var(--border) transparent;
}
.modal-asset-opt{
  display:flex;align-items:center;gap:8px;padding:7px 10px;
  cursor:pointer;font-size:11px;transition:background .1s;
  border-bottom:1px solid rgba(255,255,255,.04);
}
.modal-asset-opt:last-child{border-bottom:none;}
.modal-asset-opt:hover{background:rgba(255,255,255,.05);}
.modal-asset-opt.selected{background:rgba(71,194,255,.12);}
.modal-asset-opt .opt-emoji{font-size:14px;flex-shrink:0;}
.modal-asset-opt .opt-info{flex:1;min-width:0;}
.modal-asset-opt .opt-label{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.modal-asset-opt .opt-sub{font-size:9px;color:var(--muted);}
#modal-no-assets{padding:14px;text-align:center;font-size:11px;color:var(--muted);font-style:italic;}

/* ── move hint ── */
#move-hint{
  position:fixed;bottom:18px;left:50%;transform:translateX(-50%);
  background:var(--accent);color:#000;font-size:11px;font-weight:700;
  padding:6px 18px;border-radius:20px;z-index:400;pointer-events:none;
  white-space:nowrap;
}

/* ── Light theme override for the marker-edit modal (#modalOverlay).
   Re-skins the dark surfaces, inputs, pickers, survey + off-map sections
   to match the rest of the app (Examine, Cache info, Newcomer modals).
   Toolbar stays dark — this is scoped only to #modalOverlay. ── */
#modalOverlay .modal{
  background:#ffffff;border:1px solid var(--panel-border);
  box-shadow:0 12px 28px rgba(0,0,0,.25);color:var(--panel-text);
}
#modalOverlay .modal h2{color:#1f2937;}
#modalOverlay .modal h2 .eq-badge{
  color:var(--panel-muted);background:rgba(10,138,176,.08);
  border:1px solid rgba(10,138,176,.18);
}
#modalOverlay .modal h2 .loc-badge{
  color:var(--panel-muted);background:rgba(10,138,176,.08);
  border:1px solid rgba(10,138,176,.18);
}
#modalOverlay .modal h2 .loc-badge.status-relocated{
  color:#b45309;background:rgba(245,158,11,.14);
  border:1px solid rgba(245,158,11,.40);
}
#modalOverlay .modal h2 .loc-badge.status-offmap{
  color:#b45309;background:rgba(245,158,11,.14);
  border:1px solid rgba(245,158,11,.40);
}
#modalOverlay .modal h2 .loc-badge.status-stored{
  color:#7c3aed;background:rgba(167,139,250,.14);
  border:1px solid rgba(167,139,250,.40);
}
#modalOverlay .modal h2 .loc-badge.status-gone{
  color:#b91c1c;background:rgba(255,95,95,.14);
  border:1px solid rgba(255,95,95,.40);
}
#modalOverlay .modal h2 .id-pill.cyan{
  background:rgba(71,194,255,.12);color:var(--panel-cyan);border:1px solid rgba(71,194,255,.3);
}
#modalOverlay .modal h2 .id-pill.magenta{
  background:rgba(255,71,194,.12);color:#c020a0;border:1px solid rgba(255,71,194,.3);
}
#modalOverlay .modal h2 .loc-badge-jump:hover{background:rgba(71,194,255,.18);color:var(--panel-cyan);}
#modalOverlay .field-label{color:var(--panel-muted);}
#modalOverlay .modal input,
#modalOverlay .modal select{
  background:#ffffff;border:1px solid var(--panel-border);color:var(--panel-text);
}
#modalOverlay .modal input:focus,
#modalOverlay .modal select:focus{
  border-color:var(--panel-cyan);box-shadow:0 0 0 2px rgba(10,138,176,.15);
}
#modalOverlay .modal input:disabled{
  background:#f0f3f6;color:#9ca3af;cursor:not-allowed;
}
#modalOverlay .field-readonly{
  background:#f0f3f6;color:#374151;border:1px solid var(--panel-border);
}
#modalOverlay .modal-cog{
  border:1px solid var(--panel-border);color:var(--panel-muted);
}
#modalOverlay .modal-cog:hover{background:#f0f3f6;color:var(--panel-text);border-color:#9ca3af;}
#modalOverlay .modal-cog[aria-expanded="true"]{background:#22c55e;color:#fff;border-color:#22c55e;}
#modalOverlay .modal-details{
  background:#fafbfc;border:1px solid var(--panel-border);
}
#modalOverlay .modal-details-row .dl{color:var(--panel-muted);}
#modalOverlay .modal-details-row .dv{color:var(--panel-text);}
#modalOverlay .modal-details-row .dv input{
  background:#ffffff;border:1px solid var(--panel-border);color:var(--panel-text);
}
#modalOverlay .modal-details-row .dv input:focus{border-color:var(--panel-cyan);}
#modalOverlay .modal-details-row .dv input.invalid{
  border-color:#dc2626;background:#fef2f2;
}
#modalOverlay .modal-details-row .dv input.invalid:focus{
  border-color:#dc2626;box-shadow:0 0 0 2px rgba(220,38,38,.15);
}
#modalOverlay .detail-error{color:#dc2626;}
#modalOverlay .modal select option{background:#ffffff;color:var(--panel-text);}

/* Modal action buttons — re-skin to light */
#modalOverlay .btn-cancel{
  background:#f3f4f6;color:var(--panel-text);border:1px solid var(--panel-border);
}
#modalOverlay .btn-cancel:hover{background:#e5e7eb;}
#modalOverlay .btn-confirm{background:var(--panel-cyan);color:#fff;border:none;}
#modalOverlay .btn-confirm:hover{background:#0a7798;}
#modalOverlay .btn-delete-m{
  background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;
}
#modalOverlay .btn-delete-m:hover{background:#fee2e2;border-color:#fca5a5;}
#modalOverlay .btn-position-m,
#modalOverlay .btn-move-m{
  background:rgba(71,194,255,.12);color:var(--panel-cyan);border:1px solid var(--accent2);
}
#modalOverlay .btn-position-m:hover,
#modalOverlay .btn-move-m:hover{background:rgba(71,194,255,.22);}

/* Undo-rename button (text + icon) */
#modalOverlay .btn-undo-name{
  background:#f3f4f6;border:1px solid var(--panel-border);color:var(--panel-muted);
}
#modalOverlay .btn-undo-name:hover{
  background:#e5e7eb;color:var(--panel-text);border-color:#9ca3af;
}

/* Mode toggle (Link / New) */
#modalOverlay .modal-mode-toggle{border-color:var(--panel-border);}
#modalOverlay .modal-mode-btn{color:var(--panel-muted);}
#modalOverlay .modal-mode-btn.active{background:var(--panel-cyan);color:#fff;}
#modalOverlay .modal-mode-btn:not(.active):hover{
  background:#f3f4f6;color:var(--panel-text);
}

/* Asset picker (link mode) */
#modalOverlay #modal-asset-list{
  border:1px solid var(--panel-border);scrollbar-color:#cbd5e1 transparent;
}
#modalOverlay .modal-asset-opt{
  border-bottom:1px solid #f3f4f6;color:var(--panel-text);
}
#modalOverlay .modal-asset-opt:hover{background:#f9fafb;}
#modalOverlay .modal-asset-opt.selected{background:rgba(71,194,255,.12);}
#modalOverlay .modal-asset-opt .opt-sub{color:var(--panel-muted);}
#modalOverlay #modal-no-assets{color:var(--panel-muted);}

/* Survey status section */
#modalOverlay .survey-divider{border-top-color:var(--panel-border);}
#modalOverlay .survey-label{color:var(--panel-muted);}

/* Location typeahead — light theme */
#modalOverlay .locate-by-label{color:var(--panel-muted);}
#modalOverlay .modal.modal-newcomer-mode #surveyOptConfirmed{
  background:transparent;border:none;
}
#modalOverlay .lb-row{
  background:#ffffff;border:1px solid #cbd5e1;
  box-shadow:inset -3px 0 0 transparent;
}
#modalOverlay .lb-row:hover:not(.active){
  background:#f9fafb;border-color:rgba(74,222,128,.4);
}
#modalOverlay .lb-row.active{
  background:rgba(74,222,128,.18);border-color:#4ade80;
  box-shadow:inset -3px 0 0 #4ade80;
}
#modalOverlay .lb-tab{color:#9ca3af;}
#modalOverlay .lb-row.active .lb-tab{color:#15803d;}
#modalOverlay .lb-row:hover:not(.active) .lb-tab{color:#22c55e;}
#modalOverlay .lb-pill{
  background:rgba(34,197,94,.12);color:#15803d;
  border:1px solid rgba(34,197,94,.4);
}
#modalOverlay .lb-pill:hover{background:rgba(34,197,94,.22);}
#modalOverlay .lb-control .btn-position-m,
#modalOverlay .lb-control .btn-move-m{
  background:#22c55e;color:#fff;border:1px solid #22c55e;
}
#modalOverlay .lb-control .btn-position-m:hover:not(:disabled),
#modalOverlay .lb-control .btn-move-m:hover:not(:disabled){
  background:#16a34a;border-color:#16a34a;
}
#modalOverlay .lb-control .btn-remove-m{
  background:#dc2626;color:#fff;border:1px solid #dc2626;
}
#modalOverlay .lb-control .btn-remove-m:hover:not(:disabled){background:#b91c1c;border-color:#b91c1c;}
/* Same specificity-doubling trick for the light theme: lb-control rule
   must beat the global .btn-modal.btn-remove-m rule below. */
#modalOverlay .lb-control.lb-control .btn-remove-m{
  background:#dc2626;color:#fff;border:1px solid #dc2626;
}
#modalOverlay .btn-modal.btn-remove-m{
  background:rgba(220,38,38,.10);color:#dc2626;border:1px solid rgba(220,38,38,.40);
}
#modalOverlay .btn-modal.btn-remove-m:hover:not(:disabled){background:rgba(220,38,38,.18);border-color:#dc2626;}
#modalOverlay #locInput{
  background:#ffffff;border:1px solid var(--panel-border);color:var(--panel-text);
}
#modalOverlay #locInput:focus{border-color:var(--panel-cyan);}
#modalOverlay .loc-chevron{color:#22c55e;}
#modalOverlay .loc-chevron:hover{background:rgba(34,197,94,.12);color:#16a34a;}
#modalOverlay .loc-dropdown{
  background:#ffffff;border:1px solid var(--panel-border);
  box-shadow:0 4px 14px rgba(0,0,0,.10);
}
#modalOverlay .loc-item{color:var(--panel-text);}
#modalOverlay .loc-item:hover,#modalOverlay .loc-item.active{
  background:rgba(10,138,176,.08);color:var(--panel-cyan);
}
#modalOverlay .loc-item.current{color:var(--panel-muted);}
#modalOverlay .loc-item.selected{color:var(--panel-cyan);}
#modalOverlay .loc-empty{color:var(--panel-muted);}
#modalOverlay .loc-confirm{
  background:#fffbeb;border:1px solid #f59e0b;color:var(--panel-text);
  box-shadow:0 4px 14px rgba(0,0,0,.10);
}
#modalOverlay .loc-confirm-msg b{color:#b45309;}
#modalOverlay .loc-confirm-actions button{
  border:1px solid var(--panel-border);color:var(--panel-text);
}
#modalOverlay .loc-confirm-actions button:hover{background:#f9fafb;}
#modalOverlay .loc-confirm-actions button.confirm{
  background:#f59e0b;color:#000;border-color:#f59e0b;
}
#modalOverlay .loc-confirm-actions button.confirm:hover{background:#fbbf24;}

#modalOverlay .survey-opt{
  border:1px solid var(--panel-border);color:var(--panel-text);
}
#modalOverlay .survey-opt:hover{background:#f9fafb;}
#modalOverlay .survey-opt-sub{color:var(--panel-muted);}
#modalOverlay .survey-radio{border-color:#9ca3af;}
#modalOverlay .survey-opt.active-confirmed{background:rgba(74,222,128,.12);}
#modalOverlay .survey-opt.active-relocated{background:rgba(245,158,11,.12);}
#modalOverlay .survey-opt.active-offmap{background:rgba(245,158,11,.12);}
#modalOverlay .survey-opt.active-stored{background:rgba(167,139,250,.14);}
#modalOverlay .survey-opt.active-gone{background:rgba(255,95,95,.10);}

/* Off-map dotted-segment input */
#modalOverlay .offmap-seg{
  background:#ffffff;border:1px solid var(--panel-border);color:var(--panel-text);
}
#modalOverlay .offmap-seg:focus{border-color:#f59e0b;box-shadow:0 0 0 2px rgba(245,158,11,.18);}
#modalOverlay .offmap-dot{color:var(--panel-muted);}
#modalOverlay .offmap-hint{color:var(--panel-muted);}

/* Storage location buttons (av / faculty) */
#modalOverlay .survey-storage-btn{
  border:1px solid var(--panel-border);background:#ffffff;color:var(--panel-muted);
}
#modalOverlay .survey-storage-btn:hover{
  background:rgba(167,139,250,.08);border-color:#a78bfa;color:#7c3aed;
}
#modalOverlay .survey-storage-btn.active{
  background:rgba(167,139,250,.18);border-color:#a78bfa;color:#7c3aed;
}

/* ── snip ── */
#canvas.snipping{cursor:crosshair;}
#snip-hint{
  position:fixed;
  bottom:18px;left:50%;transform:translateX(-50%);
  background:var(--surface);color:var(--text);
  border:1px solid var(--border);border-radius:20px;
  font-size:11px;font-weight:600;
  padding:7px 14px;
  z-index:340;pointer-events:none;
  white-space:nowrap;
  box-shadow:0 4px 12px rgba(0,0,0,.4);
}
#snip-hint .accent{color:var(--accent);}
#snip-rect{
  position:fixed;pointer-events:none;z-index:350;
  border:2px solid var(--accent);background:rgba(232,255,71,0.08);
  box-shadow:0 0 0 9999px rgba(0,0,0,0.35);
}
.snip-handle{
  position:absolute;width:10px;height:10px;background:var(--accent);border-radius:2px;
  pointer-events:all;cursor:nwse-resize;
}
.snip-handle.tl{top:-5px;left:-5px;cursor:nwse-resize;}
.snip-handle.tr{top:-5px;right:-5px;cursor:nesw-resize;}
.snip-handle.bl{bottom:-5px;left:-5px;cursor:nesw-resize;}
.snip-handle.br{bottom:-5px;right:-5px;cursor:nwse-resize;}
@media(pointer:coarse){.snip-handle{display:none;}}
#snip-panel{
  position:fixed;z-index:360;
  background:var(--surface);border:1px solid var(--border);border-radius:8px;
  padding:10px 12px;display:flex;align-items:center;gap:8px;
  box-shadow:0 4px 20px rgba(0,0,0,.5);pointer-events:all;
}
#snip-panel input{
  background:#1e2028;border:1px solid var(--border);border-radius:5px;
  color:var(--text);font-size:11px;padding:5px 8px;outline:none;width:130px;
  transition:border-color .15s;
}
#snip-panel input:focus{border-color:var(--accent2);}
.snip-btn{
  padding:5px 10px;border:none;border-radius:5px;font-size:10px;font-weight:700;
  cursor:pointer;white-space:nowrap;transition:opacity .15s;
}
.snip-btn:hover{opacity:.85;}
.snip-btn.png{background:var(--accent);color:#000;}
.snip-btn.svg{background:var(--accent2);color:#000;}
.snip-btn.cancel{background:var(--border);color:var(--text);}
`;

const INTERACTIVE_SCRIPT_TEMPLATE = `(function(){
'use strict';

// ── Equipment types (inlined from extension) ──────────────
const EQUIP = __EQUIP_JSON__;
function equipEmoji(v){ const t=EQUIP.find(t=>t.v===v); return t?t.e:'📍'; }
function equipLabel(v){ const t=EQUIP.find(t=>t.v===v); return t?t.l:v; }
function normaliseExcelType(str){
  if(str==null) return '';
  return String(str).replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim().toLowerCase();
}
// Exact match against any alias in t.x (excelMatch). Returns null if
// no type matches — caller routes the row into the Unmatched bucket.
function excelTypeToValue(str){
  const norm=normaliseExcelType(str);
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
const SVG_RAW = __SVG_RAW_LITERAL__;
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

// Floor prefix: first two segments e.g. "08.03" from "08.03.01.050"
function floorPrefix(code){
  const p=code.split('.');
  return p.length>=2 ? p[0]+'.'+p[1] : code;
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
  showUndoToast(\`Reset \${idStr}\`, ()=>{
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
  const rot=compassEnabled?\` rotate(\${-compassHeading}deg)\`:'';
  world.style.transform=\`translate(\${tx}px,\${ty}px) scale(\${scale})\${rot}\`;
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
    const el = world.querySelector(\`.marker[data-id="\${CSS.escape(String(m.id))}"]\`);
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
  compassNeedle.style.transform=\`rotate(\${h}deg)\`;
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
  const floorPrefix=importedAssets[0]?.spaceNumber?.split('.').slice(0,3).join('.')||'unknown';
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
    floor: floorPrefix,
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
  // for column placement in the output sheet. Each row gets these 9
  // columns whether it's an import or a newcomer; empty if no value.
  const DETAIL_COLS = [
    ['Date in Operation',     'dateInOperation'    ],
    ['IP Address',            'ipAddress'          ],
    ['Mac Address',           'macAddress'         ],
    ['Hostname',              'hostname'           ],
    ['Firmware',              'firmware'           ],
    ['Firmware Installed On', 'firmwareInstalledOn'],
    ['Outlet',                'outlet'             ],
    ['Switch port info',      'switchPortInfo'     ],
    ['Staging',               'staging'            ],
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
  const storey="__SAFE_STOREY__";
  const safeN=s=>String(s||'').replace(/[<>:"/\\\\|?*\\x00-\\x1f]/g,'_').trim()||'floorplan';
  const fname=(storey?safeN(storey):safeN(document.title))+'_survey.xlsx';

  XLSX.writeFile(wb,fname);
  showFpToast(\`✓ Exported \${rows.length} rows → \${fname}\`);
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
    const target=panel.querySelector(\`.asset-item[data-assetid="\${CSS.escape(idStr)}"]\`);
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
    showFpToast(\`✓ Added \${newId}\`);
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
      showFpToast(\`✓ Placed \${aid}\`);
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
      return \`<div class="dev-chip"><span class="emoji">\${t.e}</span><span>\${escHtml(t.l)}</span><span class="count">\${n}</span></div>\`;
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
    el.innerHTML=\`<span class="marker-emoji">\${equipEmoji(m.equip||'displays')}</span>
      \${labelText?\`<div class="marker-label" style="color:\${labelColor}">\${escHtml(labelText)}</div>\`:''}
    \`;
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
  { key:'serialNumber',       label:'Sn' },        // top-level on imports, also on newcomers
  { key:'ipAddress',          label:'IP Address' },
  { key:'macAddress',         label:'Mac Address' },
  { key:'hostname',           label:'Hostname' },
  { key:'firmware',           label:'Firmware' },
  { key:'firmwareInstalledOn',label:'Firmware Installed On' },
  { key:'outlet',             label:'Outlet' },
  { key:'switchPortInfo',     label:'Switch port info' },
  { key:'staging',            label:'Staging' },
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
  const m = v.match(/^([A-Z][a-z]{2})\\.\\s(\\d{1,2}),\\s(\\d{4})$/);
  if(!m) return 'Format: "Aug. 1, 2019"';
  const monthIdx = MONTH_ABBRS.indexOf(m[1]);
  if(monthIdx < 0) return 'Unknown month: '+m[1];
  const day = parseInt(m[2],10);
  if(day < 1 || day > DAYS_IN_MONTH[monthIdx]) return 'Invalid day for '+m[1];
  if(/^0\\d$/.test(m[2])) return 'No leading zero on the day';
  return null;
}

function validateIp(v){
  if(!v) return null;
  // IPv4: four octets 0-255, dot-separated. No leading zeros (so "192.168.001.1" is rejected).
  const m = v.match(/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/);
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
  if(!/^([0-9A-Fa-f]{2}[:\\-]){5}[0-9A-Fa-f]{2}$/.test(v)){
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
  if(!/^[A-Za-z0-9_\\-]+$/.test(v)) return 'Only letters, digits, dashes, underscores';
  return null;
}

// Map detail-keys to their validator. Keys not listed have no validator
// (free text — Firmware, Outlet, Switch port info, Staging).
const DETAIL_VALIDATORS = {
  serialNumber:        validateSerial,
  dateInOperation:     validateStrictDate,
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
      seg.value=seg.value.replace(/\\D/g,'');
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
    currentLabel=saved.offmapLocation ? \`Off-map: \${saved.offmapLocation}\` : 'Off-map';
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
      html += \`<button class="loc-badge loc-badge-jump" data-marker-id="\${escHtml(String(marker.id||''))}" title="Jump to marker on map">\${pinSvg({w:8,h:10,attrs:'style="flex-shrink:0"'})}\${escHtml(currentLabel)}</button>\`;
    } else {
      html += \`<span class="loc-badge">\${escHtml(currentLabel)}</span>\`;
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
    html += \`<span class="loc-badge moved-from status-\${saved.status}" title="Originally registered in \${escHtml(registeredRoom)}">\${emoji} from \${escHtml(registeredRoom)}</span>\`;
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
      return \`<div class="loc-item\${cls}" data-room="\${escHtml(c)}">\${escHtml(c)}\${label}</div>\`;
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
    div.innerHTML=\`
      <span class="opt-emoji">\${emoji}</span>
      <div class="opt-info">
        <div class="opt-label">\${escHtml(a.assetId+' ('+a.model+')')}</div>
        <div class="opt-sub">\${escHtml(a.equipType)}</div>
      </div>\`;
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
    showFpToast(\`✓ Added \${newId} to \${room}\`);
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
      showFpToast(\`✓ Updated \${panelAssetId}\`);
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
      newAssets.forEach(a=>{ const m=String(a.assetId).match(/^N-(\\d+)$/); if(m) maxN=Math.max(maxN,parseInt(m[1])); });
      markers.forEach(m=>{ const x=String(m.assetId||'').match(/^N-(\\d+)$/); if(x) maxN=Math.max(maxN,parseInt(x[1])); });
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
    showUndoToast(\`Deleted \${newcomerAid}\`, ()=>{
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
      showUndoToast(\`Removed \${aid}\`, ()=>{
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
    showUndoToast(\`Cleared \${aid}\`, ()=>{
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
        seg.value=seg.value.replace(/\\D/g,'');
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
      let txt = \`Total assets found: \${assets.length} imports\`;
      if(movedInCount>0){
        txt += \` + \${movedInCount} moved in (not shown)\`;
      }
      if(newcomerCount>0){
        txt += \` + \${newcomerCount} newcomer\${newcomerCount===1?'':'s'} (not shown)\`;
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
        row.innerHTML=\`
          <div class="ack-check ack-marked" title="On map">
            \${pinSvg({fill:'#0a8ab0',attrs:'aria-hidden="true"'})}
          </div>
          <span class="\${pillClass}">\${escHtml(idStr)}</span>
          <span class="ack-asset-emoji">\${equipEmoji(a.equipType)}</span>
          <div class="ack-asset-info">
            <div class="\${labelClasses}">\${escHtml(labelText)}</div>
            <div class="ack-asset-sub">\${escHtml(equipLabel(a.equipType))} · on map</div>
          </div>
          <button class="ack-remove-marker" data-id="\${escHtml(idStr)}" title="Remove marker">✕ remove marker</button>\`;
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
        row.innerHTML=\`
          <div class="ack-check"></div>
          <span class="\${pillClass}">\${escHtml(idStr)}</span>
          <span class="ack-asset-emoji">\${equipEmoji(a.equipType)}</span>
          <div class="ack-asset-info">
            <div class="\${labelClasses}">\${escHtml(labelText)}</div>
            <div class="ack-asset-sub">\${escHtml(equipLabel(a.equipType))}</div>
          </div>\`;
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
      row.innerHTML=\`
        <div class="ack-check"></div>
        <span class="asset-id-pill cyan">\${escHtml(idStr)}</span>
        <span class="ack-asset-emoji">\${equipEmoji(ia.equipType)}</span>
        <div class="ack-asset-info">
          <div class="ack-asset-label">\${escHtml(ia.model||equipLabel(ia.equipType))}</div>
          <div class="ack-asset-sub">\${escHtml(equipLabel(ia.equipType))}</div>
        </div>\`;
      row.addEventListener('click',()=>toggleRow(idStr,row));
    }
    updateConfirmLabel(); syncSelectAll();
    if(selectedPath) showInfoBar(selectedPath);

    // Show undoable toast
    showUndoToast(\`Marker removed for \${idStr}\`, ()=>{
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
        row.innerHTML=\`
          <div class="ack-check ack-marked" title="On map">
            \${pinSvg({fill:'#0a8ab0',attrs:'aria-hidden="true"'})}
          </div>
          <span class="\${pillClass}">\${escHtml(idStr)}</span>
          <span class="ack-asset-emoji">\${equipEmoji(ia.equipType)}</span>
          <div class="ack-asset-info">
            <div class="\${labelClasses}">\${escHtml(labelText)}</div>
            <div class="ack-asset-sub">\${escHtml(equipLabel(ia.equipType))} · on map</div>
          </div>
          <button class="ack-remove-marker" data-id="\${escHtml(idStr)}" title="Remove marker">✕ remove marker</button>\`;
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
    ackConfirm.textContent = changes>0 ? \`Apply (\${changes})\` : 'Apply';
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
    if(counts.confirmed) parts.push(\`\${counts.confirmed} confirmed\`);
    if(counts.stored)    parts.push(\`\${counts.stored} stored\`);
    if(counts.offmap)    parts.push(\`\${counts.offmap} off-map\`);
    if(counts.gone)      parts.push(\`\${counts.gone} gone\`);
    if(counts.cleared)   parts.push(\`\${counts.cleared} cleared\`);
    showFpToast(\`✓ Updated \${ackRoomCode}: \${parts.join(' · ')}\`);
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

    grp.innerHTML=\`
      <div class="room-group-header\${isSelected?' selected':''}\${isVisited?' visited':''}" data-code="\${escHtml(code)}">
        <svg class="room-group-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 2l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="room-sel-dot"></div>
        <div class="room-visited-dot"></div>
        <div class="room-group-code">\${escHtml(code)}</div>
        <div class="room-asset-count \${progressClass}">\${done}/\${total}</div>
      </div>
      <div class="room-assets"></div>\`;

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
          rightIcon=\`<span class="asset-marker-icon" title="Confirmed (no marker)" style="font-size:13px;line-height:1;">✅</span>\`;
        }
      } else if(status==='relocated'){
        const destRoom=placedMarker?.roomCode||savedStatus?.room||getRoomFromMarker(placedMarker)||null;
        rightIcon=\`<span class="asset-status-icon" data-asset="\${escHtml(assetIdStr)}" data-action="movers">📦</span>\`;
        labelTitle=destRoom?\`Moved to \${destRoom}\`:'Moved — position unknown';
      } else if(status==='offmap'){
        rightIcon=\`<span class="asset-status-icon" data-asset="\${escHtml(assetIdStr)}" data-action="movers">📦</span>\`;
        labelTitle=savedStatus?.offmapLocation?\`Moved to \${savedStatus.offmapLocation}\`:'Moved off-map';
      } else if(status==='stored'){
        const loc=savedStatus?.storageLocation==='av_storage'?'AV Storage':'Faculty Storage';
        rightIcon=\`<span class="asset-status-icon" data-asset="\${escHtml(assetIdStr)}" data-action="movers">🗄️</span>\`;
        labelTitle=\`In \${loc}\`;
      } else if(status==='gone'){
        rightIcon=\`<span class="asset-status-icon" data-asset="\${escHtml(assetIdStr)}" data-action="movers">🗑️</span>\`;
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
      item.innerHTML=\`
        <span class="\${pillClass}">\${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">\${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label\${isStruck?' strikethrough':''}\${customName?' renamed':''}">
            \${escHtml(customName||a.model||equipLabel(a.equipType))}
          </div>
          <div class="asset-sub">\${escHtml(equipLabel(a.equipType))}</div>
        </div>
        \${rightIcon}\`;

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
            const target=moversBody?.querySelector(\`.asset-item[data-assetid="\${assetIdStr}"]\`);
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
    grp.innerHTML=\`
      <div class="room-group-header\${isSelected?' selected':''}\${isVisited?' visited':''}" data-code="\${escHtml(code)}">
        <svg class="room-group-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 2l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="room-sel-dot"></div>
        <div class="room-visited-dot"></div>
        <div class="room-group-code">\${escHtml(code)}</div>
        <div class="room-asset-count \${progressClass}">\${done}/\${total}</div>
      </div>
      <div class="room-assets"></div>\`;

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
      item.innerHTML=\`
        <span class="asset-id-pill magenta">\${escHtml(a.assetId)}</span>
        <span class="asset-emoji">\${equipEmoji(a.equip)}</span>
        <div class="asset-info">
          <div class="asset-label new-asset">\${escHtml(a.label||'')}</div>
          <div class="asset-sub">\${escHtml(equipLabel(a.equip))}</div>
        </div>
        \${markerIcon}\`;
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
  const undoBtnHtml=\`<button class="asset-undo-btn" data-undo title="Reset to imported state">reset</button>\`;

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
    grp.innerHTML=\`
      <div class="room-group-header" data-code="\${escHtml(dest)}">
        <svg class="room-group-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 2l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="room-sel-dot"></div>
        <div class="room-visited-dot"></div>
        <div class="room-group-code">\${escHtml(dest)}</div>
      </div>
      <div class="room-assets"></div>\`;
    const assetsDiv=grp.querySelector('.room-assets');
    items.forEach(({a,m,s})=>{
      const assetIdStr=String(a.assetId);
      const markerSvg=pinSvg({cls:'asset-marker-icon',fill:'#0a8ab0',w:0,h:0});
      const item=document.createElement('div');
      item.className='asset-item';
      item.dataset.assetid=assetIdStr;
      item.innerHTML=\`
        <span class="asset-id-pill cyan">\${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">\${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label\${(s?.customName||m?.customName)?' renamed':''}" title="Originally in \${escHtml(a.spaceNumber)}">\${escHtml(s?.customName||m?.customName||a.model||equipLabel(a.equipType))}</div>
          <div class="asset-sub">\${escHtml(equipLabel(a.equipType))}</div>
        </div>
        \${undoBtnHtml}\`;
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
      grp.innerHTML=\`
        <div class="room-group-header">
          <svg class="room-group-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M4 2l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="room-sel-dot" style="display:none"></div>
          <div class="room-visited-dot" style="display:none"></div>
          <div class="room-group-code">\${escHtml(loc)}</div>
        </div>
        <div class="room-assets"></div>\`;
      const assetsDiv=grp.querySelector('.room-assets');
      items.forEach(({a,s})=>{
        const assetIdStr=String(a.assetId);
        const item=document.createElement('div');
        item.className='asset-item';
        item.dataset.assetid=assetIdStr;
        item.innerHTML=\`
          <span class="asset-id-pill cyan">\${escHtml(assetIdStr)}</span>
          <span class="asset-emoji">\${equipEmoji(a.equipType)}</span>
          <div class="asset-info">
            <div class="asset-label\${s.customName?' renamed':''}" title="Originally in \${escHtml(a.spaceNumber||'')}">\${escHtml(s.customName||a.model||equipLabel(a.equipType))}</div>
            <div class="asset-sub">\${escHtml(equipLabel(a.equipType))}</div>
          </div>
          \${undoBtnHtml}\`;
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
      item.innerHTML=\`
        <span class="asset-id-pill cyan">\${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">\${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label\${(s?.customName||m?.customName)?' renamed':''}">\${escHtml(s?.customName||m?.customName||a.model||equipLabel(a.equipType))}</div>
          <div class="asset-sub">\${escHtml(equipLabel(a.equipType))}</div>
        </div>
        \${undoBtnHtml}\`;
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
      item.innerHTML=\`
        <span class="asset-id-pill cyan">\${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">\${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label\${(s?.customName||m?.customName)?' renamed':''}">\${escHtml(s?.customName||m?.customName||a.model||equipLabel(a.equipType))}</div>
          <div class="asset-sub">\${escHtml(equipLabel(a.equipType))}</div>
        </div>
        \${undoBtnHtml}\`;
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
      item.innerHTML=\`
        <span class="asset-id-pill cyan dotted">\${escHtml(assetIdStr)}</span>
        <span class="asset-emoji">\${equipEmoji(a.equipType)}</span>
        <div class="asset-info">
          <div class="asset-label\${(s?.customName||m?.customName)?' renamed':''}">\${escHtml(s?.customName||m?.customName||a.model||equipLabel(a.equipType))}</div>
          <div class="asset-sub">\${escHtml(equipLabel(a.equipType))}</div>
        </div>
        \${undoBtnHtml}\`;
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
  const norm=s=>String(s||'').replace(/\\u00a0/g,' ').trim().toLowerCase();
  const svgRoomCodes=getAllRoomCodes();
  const svgPrefixes=new Set([...svgRoomCodes].map(c=>floorPrefix(c)));

  const matched=[];
  const unmatched=new Map();
  const skippedFloor=[];

  rows.forEach(row=>{
    const keys=Object.keys(row);
    const get=name=>{ const k=keys.find(k=>norm(k)===norm(name)); return k?String(row[k]||'').trim():''; };
    const assetId=get('ID');
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
    const firmware           = get('Firmware');
    const firmwareInstalledOn= get('Firmware Installed On');
    const outlet             = get('Outlet');
    const switchPortInfo     = get('Switch port info');
    const staging            = get('Staging');
    if(!spaceNumber) return;

    const prefix=floorPrefix(spaceNumber);
    if(!svgPrefixes.has(prefix)){
      skippedFloor.push({assetId, spaceNumber, equipType});
      return;
    }

    const mappedType=excelTypeToValue(equipType);
    if(mappedType==null){
      // Equipment type doesn't match any of the 21. Bucket by the raw
      // Excel string (trimmed but otherwise verbatim) so the modal can
      // show the user exactly what's in their file.
      const rawKey=String(equipType||'').trim() || '(blank)';
      unmatched.set(rawKey, (unmatched.get(rawKey)||0)+1);
      return;
    }

    matched.push({
      assetId: assetId||('?_'+Math.random().toString(36).slice(2)),
      spaceNumber,
      spaceName,
      equipType: mappedType,
      model: model||equipType||'Unknown',
      serialNumber: serialNumber||'',
      details: {
        dateInOperation, ipAddress, macAddress, hostname, firmware,
        firmwareInstalledOn, outlet, switchPortInfo, staging
      },
    });
  });

  if(skippedFloor.length>0){
    console.group('[FloorPlan] Skipped assets (floor not in this map)');
    skippedFloor.forEach(s=>console.log(\`  ID \${s.assetId} | \${s.spaceNumber} | \${s.equipType}\`));
    console.groupEnd();
  }

  return { matched, unmatched, skippedFloor: skippedFloor.length };
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

  // Tally matched assets per type — only count rows that survived parsing
  const typeCounts=new Map();
  parsed.matched.forEach(a=>{
    typeCounts.set(a.equipType, (typeCounts.get(a.equipType)||0)+1);
  });

  // Determine initial selection: saved state if present, else preselected defaults
  const saved=loadEquipFilterSelection();
  const selected=new Set();
  EQUIP.forEach(t=>{
    if(!typeCounts.has(t.v)) return; // not in this file → not in selection
    const initial = saved ? saved.has(t.v) : !!t.p;
    if(initial) selected.add(t.v);
  });

  // Render: matched section
  const matchedTypesAlpha=EQUIP.filter(t=>typeCounts.has(t.v))
    .slice().sort((a,b)=>a.l.localeCompare(b.l));

  const matchedHtml=matchedTypesAlpha.length===0
    ? '<div class="import-filter-empty">Nothing to import from this floor.</div>'
    : '<div class="import-filter-list">'
      + matchedTypesAlpha.map(t=>{
          const checked=selected.has(t.v)?'checked':'';
          const count=typeCounts.get(t.v);
          return '<label class="import-filter-row" data-type="'+t.v+'">'
            +'<input type="checkbox" '+checked+'/>'
            +'<span class="if-emoji">'+t.e+'</span>'
            +'<span class="if-label">'+escHtml(t.l)+'</span>'
            +'<span class="if-count">'+count+' found</span>'
            +'</label>';
        }).join('')
      + '</div>';

  // Render: unmatched section (only if any)
  let unmatchedHtml='';
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
    unmatchedHtml=
      '<div class="import-filter-divider">'
      +'<div class="import-filter-section-label">Not matched ('+totalUnmatched+')</div>'
      +'<div class="import-filter-section-help">These don\\'t match any of the 21 known equipment types. They will not be imported.</div>'
      +'<div class="import-filter-list">'+rowsHtml+'</div>'
      +'</div>';
  }

  body.innerHTML=matchedHtml+unmatchedHtml;

  // Customise subhead / actions for the no-matches case
  if(matchedTypesAlpha.length===0){
    subhead.textContent='No equipment in this file matches this floor.';
    toggleAllBtn.style.visibility='hidden';
  } else {
    subhead.textContent='Choose which equipment types to import. Counts reflect rows for this floor only.';
    toggleAllBtn.style.visibility='visible';
  }

  // ── Live-update count and toggle-all state ──
  function updateConfirmButton(){
    let total=0;
    selected.forEach(v=>{ total += (typeCounts.get(v)||0); });
    confirmBtn.textContent='Import '+total+' asset'+(total===1?'':'s');
    confirmBtn.disabled = (total===0);
  }
  function updateToggleAllLabel(){
    const allSelected = matchedTypesAlpha.every(t=>selected.has(t.v));
    toggleAllBtn.textContent = allSelected ? 'Select none' : 'Select all';
  }
  updateConfirmButton();
  updateToggleAllLabel();

  // ── Wire row checkboxes ──
  body.querySelectorAll('.import-filter-row[data-type]').forEach(row=>{
    const cb=row.querySelector('input[type="checkbox"]');
    const v=row.dataset.type;
    row.addEventListener('click',e=>{
      // Clicking the row toggles the checkbox; native label behaviour
      // would do this, but we want the same handler to fire for both.
      if(e.target!==cb){
        cb.checked=!cb.checked;
      }
      if(cb.checked) selected.add(v); else selected.delete(v);
      updateConfirmButton();
      updateToggleAllLabel();
    });
  });

  toggleAllBtn.onclick=()=>{
    const allSelected = matchedTypesAlpha.every(t=>selected.has(t.v));
    matchedTypesAlpha.forEach(t=>{
      if(allSelected) selected.delete(t.v); else selected.add(t.v);
    });
    body.querySelectorAll('.import-filter-row[data-type]').forEach(row=>{
      const cb=row.querySelector('input[type="checkbox"]');
      cb.checked=selected.has(row.dataset.type);
    });
    updateConfirmButton();
    updateToggleAllLabel();
  };

  // ── Cancel / overlay click ──
  function close(){
    overlay.classList.remove('open');
    cancelBtn.onclick=null;
    confirmBtn.onclick=null;
    toggleAllBtn.onclick=null;
    overlay.onclick=null;
  }
  cancelBtn.onclick=close;
  overlay.onclick=e=>{ if(e.target===overlay) close(); };

  // ── Confirm ──
  confirmBtn.onclick=()=>{
    if(confirmBtn.disabled) return;
    saveEquipFilterSelection(selected);
    const filtered = parsed.matched.filter(a=>selected.has(a.equipType));
    close();
    commitImport(filename, filtered, parsed.skippedFloor);
  };

  overlay.classList.add('open');
}

// ── Import: commit to importedAssets list (was second half of processImport) ──
function commitImport(filename, matched, skippedFloorCount){
  // Dedup: keep existing markers linked to assetIds, don't overwrite their checked state
  const existingAssetIds=new Set(markers.filter(m=>m.assetId&&!m.isNew).map(m=>String(m.assetId)));

  let added=0, dupes=0;
  const newList=[...importedAssets];
  matched.forEach(a=>{
    const idStr=String(a.assetId);
    const alreadyInList=newList.some(x=>String(x.assetId)===idStr);
    if(alreadyInList){ dupes++; return; }
    if(existingAssetIds.has(idStr)){ dupes++; return; }
    newList.push(a); added++;
  });
  importedAssets=newList;

  // Update import strip
  const strip=document.getElementById('panel-import-strip-inner');
  const statusText=document.getElementById('import-status-text2');
  if(strip) strip.classList.add('has-data');
  if(statusText) statusText.textContent=importedAssets.length+' assets from '+filename;
  const eyeImportsBtn=document.getElementById('btnEyeImports');
  if(eyeImportsBtn) eyeImportsBtn.classList.add('visible');
  // The "this is from cache" info button only applies to cache-restored state.
  // A fresh import means we have a known filename, so hide it.
  const infoCacheBtn=document.getElementById('btnImportCacheInfo');
  if(infoCacheBtn) infoCacheBtn.style.display='none';

  renderPanel();
  setPanelOpen(true);

  // Build user-facing summary
  let msg='✓ Imported '+added+' asset'+(added===1?'':'s');
  const extras=[];
  if(dupes>0) extras.push(dupes+' dup'+(dupes===1?'':'s'));
  if(skippedFloorCount>0) extras.push(skippedFloorCount+' skipped (other floors)');
  if(extras.length) msg += ' · ' + extras.join(' · ');
  showFpToast(msg, false, 4000);
}

// ── Storage ───────────────────────────────────────────────
const SK=(function(){
  const t='__TITLE__';
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
      // look like a room code (NN.NN.XX.NNN) are legacy entries; drop them.
      // The user re-marks rooms on first run with the new build.
      const ROOM_CODE_RE = /^\\d{2}\\.\\d{2}\\.[A-Z0-9]{2}\\.\\d{3}$/;
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

// ── Save: bake state into downloadable HTML ───────────────
document.getElementById('btnSaveMarkers').addEventListener('click',()=>{
  const state=JSON.stringify({
    markers, visited,
    newAssets,
    assetStatuses,
    importedAssets
  });
  let html=document.documentElement.outerHTML;
  html=html
    .replace(/const SK='[^']+';/,\`const SK='baked';\`)
    .replace(/loadFromStorage\\(\\);/,\`(function(){const p=\${state};markers=p.markers||[];visited=p.visited||[];newAssets=p.newAssets||[];assetStatuses=p.assetStatuses||{};if(p.importedAssets&&p.importedAssets.length)importedAssets=p.importedAssets;})()\`);
  const blob=new Blob([html],{type:'text/html'});
  // Chrome's <a download> flattens folder paths, so a flat filename is the
  // honest choice: "<storey>_saved.html" lands next to its base file alphabetically
  // when Downloads is sorted.
  const storey = "__SAFE_STOREY__";
  const safeName = s => String(s||'').replace(/[<>:"/\\\\|?*\\x00-\\x1f]/g,'_').trim() || 'floorplan';
  const dlPath = (storey ? safeName(storey) : safeName(document.title)) + '_saved.html';
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=dlPath;
  a.click();
});

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
          ? \`viewBox="\${svgAnc.getAttribute('viewBox')||'?'}" w=\${svgAnc.getAttribute('width')||'?'}\`
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
      console.group(\`Group #\${groupIdx} — \${stat.svgInfo}\`);
      console.log(\`Kept: \${stat.kept.length}, Dropped: \${stat.dropped.length}\`);

      // Also: bounding rect of THIS svg ancestor itself (if it's an svg element)
      if(stat.svgEl && stat.svgEl.getBoundingClientRect){
        const r = stat.svgEl.getBoundingClientRect();
        console.log(\`This svg's own bbox: l=\${r.left.toFixed(1)} t=\${r.top.toFixed(1)} w=\${r.width.toFixed(1)} h=\${r.height.toFixed(1)}\`);
        console.log(\`Intersects crop? \${_snipIntersects(r, cropRect)}\`);
      }
      // Show first 3 kept and first 3 dropped (samples)
      if(stat.kept.length){
        console.log('Kept samples (first 3):');
        stat.kept.slice(0, 3).forEach(s => console.log(\`  [\${s.i}] \${s.tag} l=\${s.rect.l.toFixed(1)} t=\${s.rect.t.toFixed(1)} w=\${s.rect.w.toFixed(1)} h=\${s.rect.h.toFixed(1)}\`));
      }
      if(stat.dropped.length){
        console.log('Dropped samples (first 5):');
        stat.dropped.slice(0, 5).forEach(s => console.log(\`  [\${s.i}] \${s.tag} l=\${s.rect.l.toFixed(1)} t=\${s.rect.t.toFixed(1)} w=\${s.rect.w.toFixed(1)} h=\${s.rect.h.toFixed(1)}\`));
        // Also dropped samples that are near the crop region (within 100px) — these are the suspicious ones
        const nearMisses = stat.dropped.filter(s => {
          const dx = Math.max(0, Math.max(cropRect.left - (s.rect.l + s.rect.w), s.rect.l - cropRect.right));
          const dy = Math.max(0, Math.max(cropRect.top - (s.rect.t + s.rect.h), s.rect.t - cropRect.bottom));
          return dx + dy < 100;
        });
        if(nearMisses.length){
          console.log(\`Near misses (within 100px of crop, first 5 of \${nearMisses.length}):\`);
          nearMisses.slice(0, 5).forEach(s => console.log(\`  [\${s.i}] \${s.tag} l=\${s.rect.l.toFixed(1)} t=\${s.rect.t.toFixed(1)} w=\${s.rect.w.toFixed(1)} h=\${s.rect.h.toFixed(1)}\`));
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
  const STROKE_BLACK_RE = /^\\s*stroke:\\s*#0{3,6}\\s*;\\s*stroke-width:\\s*\\d+(\\.\\d+)?\\s*;?\\s*$/i;
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

  function refreshAdvSummary(){
    const mCount = markers.filter(m=>!m.isNew).length;
    const ncCount = markers.filter(m=>m.isNew).length;
    const sCount = Object.values(assetStatuses).filter(s=>s&&s.status).length;
    const vCount = visited.length;
    const iCount = importedAssets.length;
    const lines=[];
    lines.push(\`Imported assets: <span class="val">\${iCount}</span>\`);
    lines.push(\`Markers: <span class="val">\${mCount}</span>\${ncCount>0?\` (+\${ncCount} newcomers)\`:''}\`);
    lines.push(\`Survey statuses: <span class="val">\${sCount}</span>\`);
    lines.push(\`Visited rooms: <span class="val">\${vCount}</span>\`);
    advSummary.innerHTML = lines.join('<br/>');

    // Enable/disable buttons
    btnExport.disabled      = sCount===0 && ncCount===0;
    btnExportExcel.disabled = iCount===0 && ncCount===0;
    btnResetFloor.disabled  = mCount===0 && ncCount===0 && sCount===0 && vCount===0 && iCount===0;
    btnBulkSnip.disabled    = (mCount+ncCount)===0;
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
    const lines=['Reset floor will delete:', ''];
    if(counts.markers>0)  lines.push(\`• \${counts.markers} marker\${counts.markers===1?'':'s'}\`);
    if(counts.newcomers>0)lines.push(\`• \${counts.newcomers} newcomer\${counts.newcomers===1?'':'s'}\`);
    if(counts.statuses>0) lines.push(\`• \${counts.statuses} survey status\${counts.statuses===1?'':'es'}\`);
    if(counts.visited>0)  lines.push(\`• \${counts.visited} visited room\${counts.visited===1?'':'s'}\`);
    if(counts.imports>0)  lines.push(\`• \${counts.imports} imported asset\${counts.imports===1?'':'s'}\`);
    lines.push('', 'Continue?');
    if(!confirm(lines.join('\\n'))) return;

    // Wipe everything
    markers=[];
    newAssets=[];
    assetStatuses={};
    lastSnapshot={};
    importedAssets=[];
    wrap.querySelectorAll('.fp-visited').forEach(el=>el.classList.remove('fp-visited'));
    visited=[];
    if(selectedPath){ selectedPath.classList.remove('fp-selected'); selectedPath.style.fill=''; selectedPath=null; showInfoBar(null); }

    // Strip any lingering eye-button highlight classes (in case the user was
    // holding an eye button when reset was tapped, or in case a class survived).
    removeImportHighlight();
    removeDiscoHighlight();

    // Return the import strip to its empty look — without this, the
    // "Imported from cache" text persists after a reset because nothing
    // else redraws it. (The disco strip resets via renderPanel.)
    clearImportStripUI();

    // Drop the key from localStorage entirely so next load is truly fresh
    try{ localStorage.removeItem(SK); }catch(e){}

    renderMarkers();
    renderPanel();
    advOverlay.classList.remove('open');
    showFpToast('✓ Floor reset to clean state');
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
    progressText.textContent = \`Preparing 0 / \${entries.length}…\`;

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
      cloned.setAttribute('viewBox', \`\${svgX} \${svgY} \${svgW} \${svgH}\`);
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

      const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\\n' + new XMLSerializer().serializeToString(cloned);
      const safeName = roomCode.replace(/[<>:"/\\\\|?*\\x00-\\x1f]/g,'_');
      zip.file(safeName + '.svg', svgStr);

      const done = i+1;
      progressFill.style.width = ((done/entries.length)*100) + '%';
      progressText.textContent = \`Snipping \${done} / \${entries.length}\`;
      await yieldToUI();
    }

    progressText.textContent = \`Building zip…\`;
    await yieldToUI();

    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    // Chrome <a download> flattens folder paths, so a flat filename it is:
    // "<storey>_snips.zip" alongside everything else in Downloads.
    const storey = "__SAFE_STOREY__";
    const safeNameFn = s => String(s||'').replace(/[<>:"/\\\\|?*\\x00-\\x1f]/g,'_').trim() || 'floorplan';
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
    showFpToast(\`✓ Snipped \${entries.length} room\${entries.length===1?'':'s'} → \${dlPath}\`);
  });
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
    panelEl.innerHTML=\`
      <input type="text" id="snip-name" placeholder="Snippet name…" maxlength="60" autocomplete="off"/>
      <button class="snip-btn png" id="snip-dl-png">⬇ PNG</button>
      <button class="snip-btn svg" id="snip-dl-svg">⬇ SVG</button>
      <button class="snip-btn cancel" id="snip-cancel">✕</button>\`;
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
  function safeFilename(s){ return s.replace(/[<>:"/\\\\|?*\\x00-\\x1f]/g,'_').trim()||'snippet'; }
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
    cloned.setAttribute('viewBox',\`\${svgX} \${svgY} \${svgW} \${svgH}\`);
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
    cloned.setAttribute('viewBox',\`\${svgX} \${svgY} \${svgW} \${svgH}\`);
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
    const svgStr='<?xml version="1.0" encoding="UTF-8"?>\\n'+new XMLSerializer().serializeToString(cloned);
    const blob=new Blob([svgStr],{type:'image/svg+xml'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=safeFilename(snippetName())+'.svg'; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  }
} // end snip tool

})();`;

// 21 equipment types — alphabetical by label.
// `preselected: true` types are checked by default in the pre-import modal
// on the very first import; thereafter the last user selection wins.
// `excelMatch` is an exact-match alias list (after lowercase + whitespace
// normalisation). NO substring/includes matching — collisions are too easy
// once we have 21 types (e.g. "Audio Processor" includes "Processor"
// which would also match "Video Processor").
const EQUIP_TYPES = [
  { value: 'amplifiers',         label: 'Amplifiers',         emoji: '🎚️', preselected: false,
    excelMatch: ['amplifier', 'amplifiers'] },
  { value: 'audio_processors',   label: 'Audio Processors',   emoji: '🎛️', preselected: false,
    excelMatch: ['audio processor', 'audio processors'] },
  { value: 'av_via_usb',         label: 'AV via USB',         emoji: '🔌', preselected: true,
    excelMatch: ['av via usb'] },
  { value: 'avracks',            label: 'AVRacks',            emoji: '🗄️', preselected: true,
    excelMatch: ['avrack', 'avracks', 'av rack', 'av racks'] },
  { value: 'cameras',            label: 'Cameras',            emoji: '📷', preselected: true,
    excelMatch: ['camera', 'cameras'] },
  { value: 'controllers',        label: 'Controllers',        emoji: '🕹️', preselected: false,
    excelMatch: ['controller', 'controllers'] },
  { value: 'convertors',         label: 'Convertors',         emoji: '🔄', preselected: false,
    excelMatch: ['convertor', 'convertors', 'converter', 'converters'] },
  { value: 'displays',           label: 'Displays',           emoji: '📺', preselected: true,
    excelMatch: ['display', 'displays'] },
  { value: 'endecoders',         label: 'EnDecoders',         emoji: '🔣', preselected: false,
    excelMatch: ['endecoder', 'endecoders', 'encoder', 'encoders', 'decoder', 'decoders', 'en/decoder', 'en/decoders'] },
  { value: 'extenders',          label: 'Extenders',          emoji: '↔️', preselected: false,
    excelMatch: ['extender', 'extenders'] },
  { value: 'interactive_boards', label: 'Interactive Boards', emoji: '📋', preselected: true,
    excelMatch: ['interactive board', 'interactive boards', 'ia board', 'ia boards'] },
  { value: 'loudspeakers',       label: 'LoudSpeakers',       emoji: '📢', preselected: true,
    excelMatch: ['loudspeaker', 'loudspeakers', 'loud speaker', 'loud speakers'] },
  { value: 'microphones',        label: 'Microphones',        emoji: '🎙️', preselected: true,
    excelMatch: ['microphone', 'microphones'] },
  { value: 'monitors',           label: 'Monitors',           emoji: '🖥️', preselected: true,
    excelMatch: ['monitor', 'monitors'] },
  { value: 'operation_panels',   label: 'Operation Panels',   emoji: '📟', preselected: true,
    excelMatch: ['operation panel', 'operation panels'] },
  { value: 'projectors',         label: 'Projectors',         emoji: '📽️', preselected: true,
    excelMatch: ['projector', 'projectors'] },
  { value: 'recorders',          label: 'Recorders',          emoji: '⏺️', preselected: false,
    excelMatch: ['recorder', 'recorders'] },
  { value: 'screens',            label: 'Screens',            emoji: '🪟', preselected: true,
    excelMatch: ['screen', 'screens'] },
  { value: 'switchers',          label: 'Switchers',          emoji: '🔀', preselected: false,
    excelMatch: ['switcher', 'switchers'] },
  { value: 'video_processor',    label: 'Video Processor',    emoji: '🎞️', preselected: false,
    excelMatch: ['video processor', 'video processors'] },
  { value: 'visualizers',        label: 'Visualizers',        emoji: '🔍', preselected: true,
    excelMatch: ['visualizer', 'visualizers', 'visualiser', 'visualisers'] },
];

function equipEmoji(value) {
  const t = EQUIP_TYPES.find(t => t.value === value);
  return t ? t.emoji : '📍';
}
function equipLabel(value) {
  const t = EQUIP_TYPES.find(t => t.value === value);
  return t ? t.label : value;
}
// Normalise an Excel cell value for matching: lowercase, collapse all
// whitespace runs (incl. NBSP) to single spaces, trim. Returns '' for
// nullish input.
function normaliseExcelType(str) {
  if (str == null) return '';
  return String(str).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
// Map an Excel "Equipment Type" string to our internal value key.
// Exact match against any alias in excelMatch (after normalisation on
// both sides). Returns null if no type matches — caller can then route
// the row into the "Unmatched" bucket of the pre-import modal.
function excelTypeToValue(str) {
  const norm = normaliseExcelType(str);
  if (!norm) return null;
  for (const t of EQUIP_TYPES) {
    if (t.excelMatch.some(m => norm === m)) return t.value;
  }
  return null;
}

function buildInteractiveHtml(title, svgContent, storeyName) {
  const escapedSvg = svgContent
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  const safeStorey = escHtml(storeyName || '');

  const equipOptionsHtml = EQUIP_TYPES.map(t =>
    `<option value="${t.value}">${t.emoji} ${t.label}</option>`
  ).join('');

  // Marker pin SVG for static button HTML interpolated below. Mirrors the
  // pinSvg helper defined inside the inner IIFE — different scope, same
  // definition. The four button uses below all want the default 10×13 size
  // with currentColor fill and the flex-shrink inline style.
  const PIN_PATH_OUTER='M5 0C2.24 0 0 2.24 0 5c0 3.75 5 8 5 8s5-4.25 5-8C10 2.24 7.76 0 5 0zm0 7A2 2 0 1 1 5 3a2 2 0 0 1 0 4z';
  const pinSvgBtn=`<svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" style="flex-shrink:0"><path d="${PIN_PATH_OUTER}"/></svg>`;

  // Inline the full EQUIP_TYPES array into the HTML so the script is self-contained
  const equipJson = JSON.stringify(EQUIP_TYPES.map(({value,label,emoji,excelMatch,preselected}) =>
    ({v:value,l:label,e:emoji,x:excelMatch,p:!!preselected})
  ));

  
  // Build the interactive script by substituting placeholders
  // in the top-of-file template. Function-form .replace() avoids $-substitution
  // hazards: a literal `$` in any of these values would otherwise be interpreted
  // as `$&` / `$1` / `$$` etc. by string-form .replace().
  // .split().join() handles the 3× occurrence of __SAFE_STOREY__.
  const scriptText = INTERACTIVE_SCRIPT_TEMPLATE
    .replace('__EQUIP_JSON__',      () => equipJson)
    .replace('__SVG_RAW_LITERAL__', () => '`' + escapedSvg + '`')
    .split('__SAFE_STOREY__').join(safeStorey)
    .replace('__TITLE__',           () => escHtml(title));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(title)}</title>
<style>${INTERACTIVE_CSS}</style>
</head>
<body>

<!-- Toolbar -->
<div id="toolbar">
  <div id="tb-brand">
    <svg id="tb-logo" viewBox="0 0 285.06 75" xmlns="http://www.w3.org/2000/svg">
      <defs><style>.al{fill:#fff}.ab{fill:#2bace2}</style></defs>
      <path class="al" d="M193.5,24.06c-5.39-6.3-14.6-8.39-22.32-5.2-8.42,3.48-13.24,11.97-12.45,20.98.37,4.24,2.19,7.84,4.77,10.91-.78,1.45-1.86,2.22-3.3,2.05l-11.23,11.69c-.56.58-.86,2.28-.23,2.92l3.31,3.31c.5.5,2.11.25,2.73-.07l11.7-12.3c-.32-1.39.67-3.07,1.99-3.25,7.93,4.27,17.72,3.29,24.13-3.05,7.7-7.62,7.98-19.72.9-28ZM187.59,49.07c-5.05,4.05-12.51,4.28-17.75.25-5.23-4.03-7.33-11-4.59-17.42,2.35-5.49,7.47-8.9,13.07-8.96,5.83-.06,10.94,3.14,13.36,8.52,2.81,6.25,1.22,13.35-4.09,17.61Z"/>
      <path class="ab" d="M38.85,17.75l-9.41-.04-15.18,38.14,9.36.04,2.82-7.24,15.18.04,2.72,7.22,9.53-.04-15.02-38.11ZM29.4,41.18l4.74-12.49,4.84,12.46-9.58.04Z"/>
      <path class="al" d="M227.01,18.18l-.12,23.51c-.02,3.3-2.5,6.14-5.39,6.87-2.53.64-4.92.29-7.01-1.29-1.52-1.15-3-3.46-3.01-5.9l-.07-23.19h-8.62s.06,22.61.06,22.61c0,2.19.57,4.45,1.28,6.44,1.48,4.17,4.69,7.23,8.89,8.56,8.53,2.71,18.34-.05,21.45-8.86.68-1.93,1.19-4.04,1.19-6.15l.03-22.63-8.7.03Z"/>
      <path class="al" d="M111.64,35.81c-2.22-1.17-4.69-1.84-7.14-2.64l-4.83-1.58c-1.29-.42-1.93-1.88-1.85-3.03.08-1.25.9-2.36,2.25-2.8,4.26-1.37,7.94.57,11.52,2.89l4.68-6.18c-5.13-4.43-12.17-6.21-18.7-4.23-3.65,1.1-6.5,3.71-7.58,6.76-1.37,3.85-.97,7.94,1.51,10.88,1.75,2.08,4.3,3.18,6.83,3.96l7.54,2.34c1.59.49,2.55,2.07,2.43,3.5-.42,5.1-10.64,4.12-15.66-1.16l-4.83,6.13c5.68,5.57,13.97,7.57,21.41,5.1,4.8-1.6,7.71-5.67,7.78-10.73.06-4.06-1.85-7.36-5.36-9.22Z"/>
      <polygon class="ab" points="77.17 17.7 67.31 44.27 57.67 17.68 47.97 17.72 62.68 55.9 71.46 55.88 86.72 17.74 77.17 17.7"/>
      <path class="al" d="M139.2,48.74c-3.42-.47-6.67-2.55-8.35-6.22-2.31-5.03-1.06-11.08,3.17-14.55,4.78-3.92,11.56-2.74,15.45,2.09l5.93-5.97c-5.64-6.33-14.64-8.38-22.6-5.02-7.31,3.09-12.06,10.53-11.89,18.82.22,10.69,8.53,18.91,19.27,18.94,5.82.01,11.32-2.2,15.05-6.82l-5.77-5.58c-2.51,3.23-6.27,4.85-10.25,4.3Z"/>
      <polygon class="al" points="240.54 18.15 240.55 26.23 251.35 26.25 251.32 55.9 260.13 55.87 260.15 26.26 271 26.23 271.01 18.16 240.54 18.15"/>
      <path class="al" d="M177.83,26.27c-9.62.69-12.16,11.74-9.39,11.94.65.05,1.27-.55,1.29-1.29.4-4.6,4.04-8.06,8.72-8.3.32-.3.65-.96.64-1.33,0-.41-.77-1.06-1.27-1.02Z"/>
    </svg>
    <h1>${escHtml(title)}</h1>
  </div>
  <div class="tb-divider"></div>
  <input type="file" id="importFileInput" accept=".xlsx"/>
  <button class="tb-btn" id="btnPlaceMarker">
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M6 1A3 3 0 0 1 9 4C9 7 6 11 6 11S3 7 3 4A3 3 0 0 1 6 1z"/>
      <circle cx="6" cy="4" r="1" fill="currentColor" stroke="none"/>
    </svg>Marker
  </button>
  <button class="tb-btn" id="btnSnip">
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6">
      <rect x="1" y="1" width="10" height="10" rx="1" stroke-dasharray="2.5 1.5"/>
      <line x1="4" y1="7" x2="8" y2="7" stroke-linecap="round"/>
      <line x1="6" y1="5" x2="6" y2="9" stroke-linecap="round"/>
    </svg>Snip
  </button>
  <div class="tb-divider"></div>
  <button class="tb-btn" id="btnSaveMarkers">
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M6 1v6M3.5 4.5L6 7l2.5-2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M1.5 10h9" stroke-linecap="round"/>
    </svg>Save
  </button>
  <button class="tb-btn" id="btnAdvanced" title="Data">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
      <path d="M8 1.5l.9.3.3 1.3.9.4 1.1-.7.9.9-.7 1.1.4.9 1.3.3.3.9-1.3.3-.4.9.7 1.1-.9.9-1.1-.7-.9.4-.3 1.3-.9.3-.3-1.3-.9-.4-1.1.7-.9-.9.7-1.1-.4-.9-1.3-.3-.3-.9 1.3-.3.4-.9-.7-1.1.9-.9 1.1.7.9-.4.3-1.3.9-.3z"/>
      <circle cx="8" cy="8" r="2.2"/>
    </svg>Data
  </button>
</div>

<!-- Side Panel -->
<div id="side-panel">
  <div id="panel-header">
    <div class="panel-tab active" data-tab="assets">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 6h8M6 2v8" stroke-linecap="round"/><circle cx="6" cy="6" r="5"/></svg>
      Imports
    </div>
    <div class="panel-tab" data-tab="new">
      🐣 Newcomers
    </div>
    <div class="panel-tab" id="moversTab" data-tab="movers" style="display:none">
      ♻️ Movers
    </div>
  </div>
  <div id="panel-import-strip" style="display:none">
    <div id="import-status-dot"></div>
    <span id="import-status-text">No file imported</span>
  </div>
  <div class="panel-body" id="panel-body-assets">
    <div id="panel-import-strip-inner">
      <div id="import-status-dot2"></div>
      <span id="import-status-text2">No file imported</span>
      <button class="panel-strip-info" id="btnImportCacheInfo" title="About cached imports" style="display:none">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
          <circle cx="7" cy="7" r="6"/>
          <line x1="7" y1="6" x2="7" y2="10" stroke-linecap="round"/>
          <circle cx="7" cy="4.2" r=".6" fill="currentColor"/>
        </svg>
      </button>
      <button class="panel-eye-btn imports-eye" id="btnEyeImports" title="Hold to highlight imported rooms">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" width="14" height="14">
          <g id="eye-imports-open" display="none"><path d="M1 7C2.5 4 4.5 2.5 7 2.5S11.5 4 13 7C11.5 10 9.5 11.5 7 11.5S2.5 10 1 7z"/><circle cx="7" cy="7" r="2" fill="currentColor" stroke="none"/></g>
          <g id="eye-imports-closed"><path d="M1 7C2.5 4 4.5 2.5 7 2.5S11.5 4 13 7C11.5 10 9.5 11.5 7 11.5S2.5 10 1 7z" opacity=".4"/><circle cx="7" cy="7" r="2" opacity=".4"/><line x1="2" y1="2" x2="12" y2="12" stroke-linecap="round" stroke-width="1.6"/></g>
        </svg>
      </button>
    </div>
    <div class="panel-empty" id="panel-empty-assets">
      <div class="panel-empty-icon">📂</div>
      <div class="panel-empty-title">Let's get started!</div>
      <div class="panel-empty-sub">Import an Excel file with asset data<br/>to begin your survey.</div>
      <button class="panel-empty-btn" id="btn-empty-import">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M7 1v8M4 6l3 3 3-3" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 11h10" stroke-linecap="round"/>
        </svg>
        Import Excel
      </button>
    </div>
    <div id="asset-room-list"></div>
  </div>
  <div class="panel-body hidden" id="panel-body-new">
    <div id="panel-disco-strip">
      <div id="disco-status-dot"></div>
      <span id="disco-status-text">No newcomers yet</span>
      <button class="panel-strip-add" id="btnAddNewcomerStrip" title="Add a newcomer">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" width="12" height="12">
          <line x1="7" y1="2.5" x2="7" y2="11.5" stroke-linecap="round"/>
          <line x1="2.5" y1="7" x2="11.5" y2="7" stroke-linecap="round"/>
        </svg>
        Add Newcomer
      </button>
      <button class="panel-eye-btn disco-eye" id="btnEyeDisco" title="Hold to highlight newcomer rooms">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" width="14" height="14">
          <g id="eye-disco-open" display="none"><path d="M1 7C2.5 4 4.5 2.5 7 2.5S11.5 4 13 7C11.5 10 9.5 11.5 7 11.5S2.5 10 1 7z"/><circle cx="7" cy="7" r="2" fill="currentColor" stroke="none"/></g>
          <g id="eye-disco-closed"><path d="M1 7C2.5 4 4.5 2.5 7 2.5S11.5 4 13 7C11.5 10 9.5 11.5 7 11.5S2.5 10 1 7z" opacity=".4"/><circle cx="7" cy="7" r="2" opacity=".4"/><line x1="2" y1="2" x2="12" y2="12" stroke-linecap="round" stroke-width="1.6"/></g>
        </svg>
      </button>
    </div>
    <div class="panel-empty" id="panel-empty-new">
      <div class="panel-empty-icon">🐣</div>
      <div class="panel-empty-title">No newcomers yet</div>
      <div class="panel-empty-sub">Add a newcomer, then pick a room on the map.</div>
      <button class="panel-empty-btn" id="btnAddNewcomerEmpty">
        <span style="font-size:13px;line-height:1;">＋</span>
        Add Newcomer
      </button>
    </div>
    <div id="new-room-list"></div>
  </div>
  <div class="panel-body hidden" id="panel-body-movers">
    <div class="panel-empty" id="panel-empty-movers">
      <div class="panel-empty-icon">♻️</div>
      No movers yet.
    </div>
    <div id="movers-room-list"></div>
    <div id="movers-stored-section"></div>
    <div id="movers-gone-section"></div>
  </div>
</div>

<!-- FAB group -->
<div id="fab-group">
  <button class="fab" id="fab-panel-toggle" title="Toggle asset panel">
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">
      <rect x="2" y="3" width="16" height="14" rx="2"/>
      <line x1="13" y1="3" x2="13" y2="17"/>
    </svg>
  </button>
  <button class="fab" id="fab-compass" title="Align to North">
    <svg viewBox="0 0 20 20" width="20" height="20">
      <g id="compass-needle">
        <polygon points="10,2 12,10 10,11 8,10" fill="#e8ff47"/>
        <polygon points="10,18 12,10 10,11 8,10" fill="#555"/>
      </g>
      <circle cx="10" cy="10" r="2" fill="var(--surface)"/>
    </svg>
  </button>
  <button class="fab fab-text" id="fab-reset" title="Reset view">reset</button>
  <button class="fab" id="fab-zi" title="Zoom in">
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">
      <circle cx="9" cy="9" r="6"/><line x1="13.5" y1="13.5" x2="18" y2="18"/>
      <line x1="9" y1="6" x2="9" y2="12"/><line x1="6" y1="9" x2="12" y2="9"/>
    </svg>
  </button>
  <div id="fab-zoom-pct">100%</div>
  <button class="fab" id="fab-zo" title="Zoom out">
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">
      <circle cx="9" cy="9" r="6"/><line x1="13.5" y1="13.5" x2="18" y2="18"/>
      <line x1="6" y1="9" x2="12" y2="9"/>
    </svg>
  </button>
</div>

<!-- Info bar -->
<div id="infobar" class="empty">
  <span id="info-empty">Single-click a room to select · Double-click to mark as visited</span>
  <div id="info-room" style="display:none">
    <div id="info-room-text">
      <div id="info-room-code"></div>
    </div>
    <div id="info-room-space-name"></div>
  </div>
  <div id="info-devices" style="display:none"></div>
  <div id="info-visited" style="display:none">
    <div id="info-visited-dot"></div>
    <div id="info-visited-label">Visited</div>
  </div>
  <div id="info-unlinked-wrap">
    <a id="info-room-link" class="info-action-btn" href="#" target="_blank" title="View this room in TUDesc">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <path d="M2 7c1.5-3 3.5-4.5 5-4.5S10.5 4 12 7c-1.5 3-3.5 4.5-5 4.5S3.5 10 2 7z" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="7" cy="7" r="1.6" fill="currentColor" stroke="none"/>
      </svg>
      <span>View in TUDesc</span>
    </a>
    <button id="btn-acknowledge-all" class="info-action-btn" title="Examine this room">
      <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <path d="M8 1 L3 8 L7 8 L6 13 L11 6 L7 6 Z"/>
      </svg>
      <span>Examine</span>
    </button>
  </div>
</div>

<!-- Bulk-link modal -->
<!-- Bulk check modal -->
<div id="ackOverlay">
  <div id="ackModal">
    <h2>
      <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" style="width:14px;height:14px;color:var(--accent2);">
        <path d="M8 1 L3 8 L7 8 L6 13 L11 6 L7 6 Z"/>
      </svg>
      <span>Examine room <span id="ack-room-code-inline"></span></span>
    </h2>
    <div id="ack-room-sub"></div>
    <div id="ack-status-picker">
      <div class="ack-tab active" data-status="confirmed"><span>✅</span><span>Confirmed</span></div>
      <div class="ack-tab" data-status="stored-av"><span>🗄️</span><span>AV</span></div>
      <div class="ack-tab" data-status="stored-faculty"><span>🗄️</span><span>Faculty</span></div>
      <div class="ack-tab" data-status="offmap"><span>📦</span><span>Off-map</span></div>
      <div class="ack-tab" data-status="gone"><span>🗑️</span><span>Gone</span></div>
    </div>
    <div id="ack-hint">Pick a status, then click assets to assign it.</div>
    <div id="ack-offmap-wrap" style="display:none;margin-bottom:10px;">
      <div class="ack-offmap-label">Location for all off-map assets</div>
      <div class="ack-offmap-segments">
        <input class="ack-offmap-seg" id="ackOffmapSeg0" type="text" maxlength="4" placeholder="Bldg" autocomplete="off"/>
        <span class="ack-offmap-dot">.</span>
        <input class="ack-offmap-seg" id="ackOffmapSeg1" type="text" maxlength="4" placeholder="Wing" autocomplete="off"/>
        <span class="ack-offmap-dot">.</span>
        <input class="ack-offmap-seg" id="ackOffmapSeg2" type="text" maxlength="4" placeholder="Flr" autocomplete="off"/>
        <span class="ack-offmap-dot">.</span>
        <input class="ack-offmap-seg" id="ackOffmapSeg3" type="text" maxlength="4" placeholder="Room" autocomplete="off"/>
      </div>
    </div>
    <div id="ack-select-all-row" class="selected">
      <div class="ack-check"></div>
      Select all
    </div>
    <div id="ack-asset-list"></div>
    <div id="ack-actions">
      <button class="btn-modal btn-cancel" id="ack-cancel-btn">Cancel</button>
      <button class="btn-modal btn-confirm" id="ack-confirm-btn">Check</button>
    </div>
  </div>
</div>

<!-- Advanced modal -->
<div id="advOverlay">
  <div id="advModal">
    <h2>⚙️ Data</h2>
    <div id="adv-body">
      <div class="adv-section">
        <div class="adv-summary" id="adv-summary"></div>
        <button class="adv-btn adv-btn-import" id="btn-import-excel">
          <div class="adv-btn-label">Import Excel</div>
          <div class="adv-btn-sub">Load an asset list from an .xlsx file.</div>
        </button>
        <button class="adv-btn adv-btn-export" id="btn-export-excel">
          <div class="adv-btn-label">Export to Excel</div>
          <div class="adv-btn-sub">Download the full survey as an .xlsx spreadsheet.</div>
        </button>
        <button class="adv-btn adv-btn-export" id="btn-export-survey">
          <div class="adv-btn-label">Export survey (JSON)</div>
          <div class="adv-btn-sub">Download survey results as JSON (for backend upload).</div>
        </button>
        <button class="adv-btn adv-btn-snip" id="btn-bulk-snip">
          <div class="adv-btn-label">Bulk snip rooms</div>
          <div class="adv-btn-sub">Download one SVG per room that has markers (zip archive).</div>
          <div class="adv-progress-wrap" id="bulk-snip-progress" style="display:none;">
            <div class="adv-progress-bar"><div class="adv-progress-fill" id="bulk-snip-fill"></div></div>
            <div class="adv-progress-text" id="bulk-snip-text"></div>
          </div>
        </button>
        <button class="adv-btn adv-btn-danger" id="btn-reset-floor">
          <div class="adv-btn-label">Reset floor</div>
          <div class="adv-btn-sub">Clears everything: markers, statuses, newcomers, imports, visited rooms.</div>
        </button>
      </div>
    </div>
    <div id="adv-actions">
      <button class="btn-modal btn-cancel" id="adv-close-btn">Close</button>
    </div>
  </div>
</div>

<!-- Cache info modal — shown when user taps the "i" button next to "Imported from cache" -->
<div id="cacheInfoOverlay">
  <div id="cacheInfoModal">
    <h2>About cached imports</h2>
    <div class="cache-info-body">
      <p><strong>Where the data lives.</strong> Once you import an Excel file, the asset list is stored in your browser's local cache so you don't have to re-import every time you open this floor.</p>
      <p><strong>What survives.</strong> Refreshing or reopening the file keeps your cached imports, markers, statuses, and newcomers intact.</p>
      <p><strong>What clears it.</strong> Clearing browser cookies, site data, or running this in a private/incognito window will remove the cache. Different browsers or devices each have their own cache.</p>
      <p><strong>How to be safe.</strong> When you're done surveying, hit <strong>Save</strong> in the toolbar. That bakes the current state into a downloadable HTML file you can keep — or send to others — independent of any cache.</p>
    </div>
    <div class="cache-info-actions">
      <button class="btn-modal btn-confirm" id="cacheInfoClose">Got it</button>
    </div>
  </div>
</div>

<!-- Pre-import equipment-type filter modal -->
<div id="importFilterOverlay">
  <div id="importFilterModal">
    <h2>📥 Select equipment to import</h2>
    <div class="import-filter-filename" id="importFilterFilename"></div>
    <div class="import-filter-subhead" id="importFilterSubhead">
      Choose which equipment types to import from this file. Counts reflect rows for this floor only.
    </div>
    <div class="import-filter-body" id="importFilterBody">
      <!-- Populated dynamically: matched list, then unmatched section if any -->
    </div>
    <div class="import-filter-actions">
      <button class="import-filter-toggle-all" id="importFilterToggleAll" type="button">Select all</button>
      <div class="import-filter-buttons">
        <button class="btn-modal btn-cancel" id="importFilterCancel" type="button">Cancel</button>
        <button class="btn-modal btn-confirm" id="importFilterConfirm" type="button">Import 0 assets</button>
      </div>
    </div>
  </div>
</div>

<!-- Canvas -->
<div id="canvas">
  <div id="world">
    <div id="svg-wrap"></div>
  </div>
</div>

<!-- Marker modal -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-title-row">
      <h2 id="modalTitle">Place Asset Marker</h2>
      <button type="button" class="modal-cog" id="modalCog" title="Show details" aria-expanded="false" style="display:none">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
    </div>

    <!-- Details drawer (collapsed by default; toggled via cog button) -->
    <div id="modalDetails" class="modal-details" hidden>
      <div class="modal-details-list" id="modalDetailsList"></div>
    </div>

    <!-- Mode toggle: only shown when placing new (not editing existing) -->
    <div class="modal-mode-toggle" id="modalModeToggle">
      <button class="modal-mode-btn active" id="modalModeLink">🔗 Link to an Import</button>
      <button class="modal-mode-btn" id="modalModeNew">🐣 Add Newcomer</button>
    </div>

    <!-- Link-to-asset section -->
    <div id="modalLinkSection">
      <div class="field-label">Select asset</div>
      <div id="modal-asset-list">
        <div id="modal-no-assets">No unplaced assets for this room</div>
      </div>
    </div>

    <!-- New asset section -->
    <div id="modalNewSection" style="display:none">
      <div class="field-label">Name / Description</div>
      <div class="modal-name-wrap">
        <input type="text" id="modalName" placeholder="e.g. Beamer podium, Exit B…" maxlength="80" autocomplete="off"/>
        <button class="btn-undo-name" id="btnRevertName" title="Reset to imported name">
          <span aria-hidden="true">↩</span>
          <span>reset name</span>
        </button>
      </div>
      <div id="modalEquipField">
        <div class="field-label">Equipment type</div>
        <select id="modalEquip">${equipOptionsHtml}</select>
      </div>
    </div>

    <!-- Survey status — only shown when editing an imported marker -->
    <div id="modalSurveySection" style="display:none">
      <hr class="survey-divider"/>
      <div class="survey-label">Status</div>
      <div class="survey-options">
        <div class="survey-opt" data-status="confirmed" id="surveyOptConfirmed">
          <div class="survey-radio"></div>
          <div class="survey-opt-body">
            <div class="survey-opt-title">✅ Found</div>
            <div class="survey-opt-sub">Asset found in a room on this floor</div>
            <div class="survey-storage-opts" id="surveyInRoomOpts">
              <div class="locate-by-label">Locate by</div>
              <div class="lb-row">
                <button type="button" class="lb-tab active" id="lbTabRoom" data-mode="room">Room</button>
                <div class="lb-control">
                  <div class="loc-typeahead">
                    <div class="loc-input-wrap">
                      <input type="text" id="locInput" autocomplete="off" placeholder="Search room…"/>
                      <button type="button" class="loc-chevron" id="locChevron" tabindex="-1" aria-label="Show all rooms">
                        <svg viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l4 4 4-4"/></svg>
                      </button>
                    </div>
                    <div class="loc-dropdown" id="locDropdown" style="display:none"></div>
                    <div class="loc-confirm" id="locConfirm" style="display:none"></div>
                  </div>
                </div>
              </div>
              <div class="lb-row">
                <button type="button" class="lb-tab" id="lbTabMarker" data-mode="marker">Marker</button>
                <div class="lb-control" id="lbMarkerControl">
                  <button class="btn-modal btn-position-m" id="btnPositionMarker">
                    ${pinSvgBtn}
                    Set position
                  </button>
                  <button class="btn-modal btn-move-m" id="btnMoveMarker" style="display:none">
                    ${pinSvgBtn}
                    Reposition
                  </button>
                  <button class="btn-modal btn-remove-m" id="btnRemoveMarker" style="display:none">
                    ${pinSvgBtn}
                    Remove
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="survey-opt" data-status="offmap" id="surveyOptOffmap">
          <div class="survey-radio"></div>
          <div class="survey-opt-body">
            <div class="survey-opt-title">📦 Off-map</div>
            <div class="survey-opt-sub">Moved to another floor or building</div>
            <div class="survey-storage-opts" id="surveyOffmapOpts">
              <div class="offmap-segments" id="offmapSegments">
                <input class="offmap-seg" id="offmapSeg0" type="text" maxlength="4" placeholder="Bldg" autocomplete="off"/>
                <span class="offmap-dot">.</span>
                <input class="offmap-seg" id="offmapSeg1" type="text" maxlength="4" placeholder="Wing" autocomplete="off"/>
                <span class="offmap-dot">.</span>
                <input class="offmap-seg" id="offmapSeg2" type="text" maxlength="4" placeholder="Flr" autocomplete="off"/>
                <span class="offmap-dot">.</span>
                <input class="offmap-seg" id="offmapSeg3" type="text" maxlength="4" placeholder="Room" autocomplete="off"/>
              </div>
              <div class="offmap-hint" id="offmapHint">Building is required</div>
            </div>
          </div>
        </div>
        <div class="survey-opt" data-status="stored" id="surveyOptStored">
          <div class="survey-radio"></div>
          <div class="survey-opt-body">
            <div class="survey-opt-title">🗄️ Stored</div>
            <div class="survey-opt-sub">Asset is in storage</div>
            <div class="survey-storage-opts" id="surveyStorageOpts">
              <button class="survey-storage-btn" data-loc="av_storage" id="storageAV">AV Storage</button>
              <button class="survey-storage-btn" data-loc="faculty_storage" id="storageFaculty">Faculty Storage</button>
            </div>
          </div>
        </div>
        <div class="survey-opt" data-status="gone" id="surveyOptGone">
          <div class="survey-radio"></div>
          <div class="survey-opt-body">
            <div class="survey-opt-title">🗑️ Gone</div>
            <div class="survey-opt-sub">Decommissioned, disposed or stolen</div>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn-modal btn-delete-m"    id="btnDeleteMarker"   style="display:none">
        Clear
      </button>
      <button class="btn-modal btn-move-m btn-move-m-ncomer" id="btnMoveMarkerNcomer" style="display:none">
        ${pinSvgBtn}
        Reposition
      </button>
      <button class="btn-modal btn-cancel"      id="btnModalCancel">Cancel</button>
      <button class="btn-modal btn-confirm"     id="btnModalConfirm">Place</button>
    </div>
  </div>
</div>

<div id="fp-toast"></div>

<script>
/* global XLSX */
${scriptText}
</script>

<!-- SheetJS for Excel parsing — loaded from CDN -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<!-- JSZip for Bulk Snip zip export — loaded from CDN -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
</body>
</html>`;
}

// ── Render ───────────────────────────────────────────────────────────────────

// Page-based rendering. The captured-plans list can grow long; rather
// than rely on flex-overflow scrolling (which had cross-browser issues),
// we paginate. 7 items fit comfortably in the side panel above the
// paginator row. State lives only in memory — resets to page 1 on reload.
const PAGE_SIZE = 6;
let currentPage = 1;

async function render() {
  const items = await loadItems();
  const hasItems = items.length > 0;

  countBadge.textContent = `${items.length} plan${items.length !== 1 ? 's' : ''}`;
  countBadge.className   = 'count-badge' + (hasItems ? ' has-items' : '');
  listHeader.style.display = hasItems ? 'flex' : 'none';

  Array.from(itemsList.querySelectorAll('.item-card')).forEach(el => el.remove());

  // Remove any previous paginator so we can redraw it cleanly
  const existingPager = document.getElementById('pager');
  if (existingPager) existingPager.remove();

  if (!hasItems) {
    emptyState.style.display = 'flex';
    return;
  }
  emptyState.style.display = 'none';

  // Clamp current page in case the underlying list shrunk (e.g. deletes)
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const endIdx   = Math.min(startIdx + PAGE_SIZE, items.length);

  // Only render the current page's slice. The card's data-idx is the
  // ABSOLUTE index into the items array (not the slice index), so all
  // the existing click handlers continue to work without changes.
  for (let idx = startIdx; idx < endIdx; idx++) {
    const item = items[idx];
    const card = document.createElement('div');
    card.className   = 'item-card';
    card.dataset.idx = idx;

    const thumb = makeThumbnail(item.svgContent) || `
      <svg viewBox="0 0 38 38" fill="none">
        <rect x="3" y="3" width="14" height="14" rx="2" stroke="#6b7280" stroke-width="1.5"/>
        <rect x="21" y="3" width="14" height="14" rx="2" stroke="#6b7280" stroke-width="1.5"/>
        <rect x="3" y="21" width="14" height="14" rx="2" stroke="#6b7280" stroke-width="1.5"/>
        <rect x="21" y="21" width="14" height="14" rx="2" stroke="#6b7280" stroke-width="1.5"/>
      </svg>`;

    const subtitle = shortenUrl(item.pageUrl);
    const storeyBadge = item.storeyName
      ? `<span class="storey-badge">${escHtml(item.storeyName)}</span>`
      : '';
    const pathRow = item.downloadPath
      ? `<div class="item-path" data-idx="${idx}" title="Open ${escHtml(item.downloadPath)}">📁 ${escHtml(item.downloadPath)}</div>`
      : '';
    const openBtn = item.downloadPath
      ? `<button class="item-btn open" data-idx="${idx}" title="Open downloaded file">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M6.5 1.5h4v4" stroke-linecap="round"/>
            <path d="M10.5 1.5L5.5 6.5" stroke-linecap="round"/>
            <path d="M10 7v3a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>Open
        </button>`
      : '';

    card.innerHTML = `
      <div class="item-top">
        <div class="item-preview">${thumb}</div>
        <div class="item-meta">
          <div class="item-title-row">
            <div class="item-title" title="${escHtml(item.title)}">${escHtml(item.title)}</div>
            ${storeyBadge}
            <div class="item-time">${formatTime(item.timestamp)}</div>
          </div>
          <div class="item-url" title="${escHtml(item.pageUrl)}">${escHtml(subtitle)}</div>
          ${pathRow}
        </div>
      </div>
      <div class="item-actions">
        <button class="item-btn download-svg" data-idx="${idx}" title="Download SVG (for AVScout)">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M6 1v6M3.5 4.5L6 7l2.5-2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M1.5 10h9" stroke-linecap="round"/>
          </svg>Download SVG
        </button>
        <button class="item-btn download" data-idx="${idx}" title="Download interactive HTML">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M6 1v6M3.5 4.5L6 7l2.5-2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M1.5 10h9" stroke-linecap="round"/>
          </svg>Download HTML
        </button>
        ${openBtn}
        <button class="item-btn delete" data-idx="${idx}" title="Delete">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M2 3h8M5 3V2h2v1M4 3l.5 7h3L8 3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>Delete
        </button>
      </div>`;

    itemsList.appendChild(card);
  }

  // Paginator — only shown when there's more than one page.
  if (totalPages > 1) {
    const pager = document.createElement('div');
    pager.id = 'pager';
    pager.className = 'pager';
    const prevDisabled = currentPage <= 1 ? 'disabled' : '';
    const nextDisabled = currentPage >= totalPages ? 'disabled' : '';
    pager.innerHTML = `
      <button class="pager-btn" id="pagerPrev" ${prevDisabled} aria-label="Previous page">←&nbsp;Prev</button>
      <div class="pager-info"><span class="pager-current">${currentPage}</span>&nbsp;/&nbsp;<span class="pager-total">${totalPages}</span></div>
      <button class="pager-btn" id="pagerNext" ${nextDisabled} aria-label="Next page">Next&nbsp;→</button>
    `;
    itemsList.parentElement.insertBefore(pager, itemsList.nextSibling);
    document.getElementById('pagerPrev').addEventListener('click', () => {
      if (currentPage > 1) { currentPage--; render(); }
    });
    document.getElementById('pagerNext').addEventListener('click', () => {
      if (currentPage < totalPages) { currentPage++; render(); }
    });
  }

  bindCardEvents();
}

// ── Card events ──────────────────────────────────────────────────────────────

function bindCardEvents() {
  // Download the raw SVG file. Lands at Floorplans/Base/Building XX/<floor>.svg
  // — the same hierarchy Download HTML uses, with .svg extension. This is
  // the format AVScout's PWA "+ Add SVG" button expects.
  itemsList.querySelectorAll('.item-btn.download-svg').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx   = parseInt(btn.dataset.idx);
      const items = await loadItems();
      const item  = items[idx];
      const blob  = new Blob([item.svgContent], { type: 'image/svg+xml' });
      const url   = URL.createObjectURL(blob);
      const path  = buildFloorplanPath(item, 'Base', 'svg');

      chrome.downloads.download({
        url,
        filename: path,
        conflictAction: 'overwrite',
        saveAs: false
      }, (downloadId) => {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        if (chrome.runtime.lastError || !downloadId) {
          showToast('Download failed: ' + (chrome.runtime.lastError?.message || 'unknown'));
          return;
        }
        // The SVG download is a fire-and-forget handoff to AVScout; we
        // deliberately don't persist its path. The interactive HTML
        // download still gets `item.downloadPath` (used by the Open
        // button + path subtitle) — separate intent, separate field.
        showToastWithAction(`✓ Saved to ${path}`, 'Open', () => openDownloadByPath(path));
      });
    });
  });

  itemsList.querySelectorAll('.item-btn.download').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx      = parseInt(btn.dataset.idx);
      const items    = await loadItems();
      const item     = items[idx];
      const html     = buildInteractiveHtml(item.title, item.svgContent, item.storeyName);
      const blob     = new Blob([html], { type: 'text/html' });
      const url      = URL.createObjectURL(blob);
      const path     = buildFloorplanPath(item, 'Base');

      chrome.downloads.download({
        url,
        filename: path,
        conflictAction: 'overwrite',
        saveAs: false
      }, async (downloadId) => {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        if (chrome.runtime.lastError || !downloadId) {
          showToast('Download failed: ' + (chrome.runtime.lastError?.message || 'unknown'));
          return;
        }
        // Persist the path on the item so the card can show it + offer Open.
        const latest = await loadItems();
        if (latest[idx]) {
          latest[idx].downloadPath = path;
          await saveItems(latest);
        }
        showToastWithAction(`✓ Saved to ${path}`, 'Open', () => openDownloadByPath(path));
        render();
      });
    });
  });

  itemsList.querySelectorAll('.item-btn.open').forEach(btn => {
    btn.addEventListener('click', async () => {
      const items = await loadItems();
      const item  = items[parseInt(btn.dataset.idx)];
      if (!item?.downloadPath) {
        showToast('No download on file — click Download first');
        return;
      }
      openDownloadByPath(item.downloadPath);
    });
  });

  // Clickable path subtitle opens the downloaded file (same as Open button)
  itemsList.querySelectorAll('.item-path').forEach(el => {
    el.addEventListener('click', async () => {
      const items = await loadItems();
      const item  = items[parseInt(el.dataset.idx)];
      if (!item?.downloadPath) return;
      openDownloadByPath(item.downloadPath);
    });
  });

  itemsList.querySelectorAll('.item-btn.delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const items = await loadItems();
      items.splice(parseInt(btn.dataset.idx), 1);
      await saveItems(items);
      showToast('Deleted');
      render();
    });
  });
}

// ── Capture ──────────────────────────────────────────────────────────────────

btnCapture.addEventListener('click', async () => {
  btnCapture.disabled = true;
  setStatus('Scanning page…');

  // Side panels don't belong to a specific tab, so `currentWindow: true`
  // can return a tab from a different Chrome window than the one the user
  // is actually looking at. `lastFocusedWindow` tracks the last window the
  // user interacted with — more reliable for side-panel contexts.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!tab || !tab.id) {
    btnCapture.disabled = false;
    setStatus(`No active tab found — focus an ${STIPL_LINK} tab and try again`, 'error');
    return;
  }
  if (!isStiplUrl(tab.url)) {
    btnCapture.disabled = false;
    setStatus(`Visit ${STIPL_LINK} to capture a floorplan`, '');
    return;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    btnCapture.disabled = false;
    setStatus('Cannot inject: ' + (err?.message || 'unknown'), 'error');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: 'extractFloorplan' }, async (response) => {
    btnCapture.disabled = false;

    if (chrome.runtime.lastError || !response) {
      setStatus('Could not connect to page. Try reloading.', 'error');
      return;
    }
    if (!response.success) {
      setStatus(response.error, 'error');
      return;
    }

    const items = await loadItems();
    const incomingStorey = response.storeyName || null;

    if (incomingStorey) {
      const dupIdx = items.findIndex(i => i.storeyName === incomingStorey);
      if (dupIdx !== -1) {
        await showConfirm({
          title: 'Already captured',
          body: `A plan for <strong>${escHtml(incomingStorey)}</strong> already exists.<br/><br/>Please delete it first, then capture and download again.`,
          confirmText: 'OK',
          cancelText: ''
        });
        setStatus('Capture cancelled.', '');
        return;
      }
    }

    const base  = response.defaultTitle || response.pageTitle || 'Untitled Plan';
    const same  = items.filter(i => i.title === base || i.title.startsWith(base + ' #')).length;
    const title = base + (same > 0 ? ` #${same + 1}` : '');

    items.unshift({
      id:          nextId(),
      title,
      svgContent:  response.svgContent,
      pageTitle:   response.pageTitle,
      pageUrl:     response.pageUrl,
      storeyName:  incomingStorey,
      timestamp:   response.timestamp,
      dimensions:  response.dimensions
    });

    try {
      await saveItems(items);
    } catch (_) { return; }
    setStatus(`Captured "${title}"`, 'success');
    // A new plan was just added to the front — jump to page 1 so the
    // user sees it instead of being stranded on whatever page they
    // happened to be on.
    currentPage = 1;
    render();
  });
});

// ── Export All as ZIP ────────────────────────────────────────────────────────
//
// Bundles every captured floorplan as a raw .svg file inside a Floorplans/Base/
// Building XX/ hierarchy — the same path scheme that the per-item Download
// HTML uses, but with .svg files containing the raw SVG content.

btnExportZip.addEventListener('click', async () => {
  const items = await loadItems();
  if (!items.length) { showToast('Nothing to export'); return; }

  if (typeof JSZip === 'undefined') {
    showToast('JSZip not loaded — check jszip.min.js');
    return;
  }

  btnExportZip.disabled = true;
  setStatus('Building ZIP…');

  try {
    const zip = new JSZip();
    // Multiple captures could share a floor code and collide on the same
    // path. Dedupe by appending -2, -3, etc.
    const usedPaths = new Set();
    items.forEach(item => {
      let path = buildFloorplanPath(item, 'Base', 'svg');
      if (usedPaths.has(path)) {
        const dot  = path.lastIndexOf('.');
        const base = dot >= 0 ? path.slice(0, dot) : path;
        const ext  = dot >= 0 ? path.slice(dot)    : '';
        for (let i = 2; i < 100; i++) {
          const candidate = `${base}-${i}${ext}`;
          if (!usedPaths.has(candidate)) { path = candidate; break; }
        }
      }
      usedPaths.add(path);
      zip.file(path, item.svgContent);
    });

    const blob = await zip.generateAsync({
      type:               'blob',
      compression:        'DEFLATE',
      compressionOptions: { level: 6 }
    });

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = 'floorplans.zip';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);

    setStatus(`Exported ${items.length} floorplan${items.length > 1 ? 's' : ''}`, 'success');
    showToast(`✓ ${items.length} SVG${items.length > 1 ? 's' : ''} exported`);
  } catch (err) {
    setStatus('Export failed: ' + err.message, 'error');
  } finally {
    btnExportZip.disabled = false;
  }
});

// ── Clear All ────────────────────────────────────────────────────────────────

btnClearAll.addEventListener('click', async () => {
  const items = await loadItems();
  const n = items.length;
  if (n === 0) return;
  const ok = await showConfirm({
    title: 'Delete all floorplans?',
    body: `This will remove <strong>${n} captured floorplan${n===1?'':'s'}</strong> from the extension.<br/><br/>Downloaded files on disk are not affected.`,
    confirmText: 'Delete all',
    cancelText: 'Cancel',
    danger: true
  });
  if (!ok) return;
  await saveItems([]);
  setStatus('');
  render();
});

// ── Capture eligibility ──────────────────────────────────────────────────────
// Capture only works on stipl.org (SVG extraction needs their specific DOM).
// We disable the button on other sites and show a hint in the status bar.
const STIPL_HOST_RE = /(?:^|\.)stipl\.org$/i;

function isStiplUrl(url) {
  if (!url) return false;
  try {
    return STIPL_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function updateCaptureEligibility() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const eligible = isStiplUrl(tab?.url);
    btnCapture.disabled = !eligible;
    if (!eligible) {
      setStatus(`Visit ${STIPL_LINK} to capture a floorplan`, '');
    } else {
      // Only clear a "not on stipl" status — don't clobber success/error messages.
      // textContent returns rendered text, so "app.stipl.org" (from the inline
      // hyperlink) is what we match here.
      if (statusBar.textContent.includes('stipl.org')) setStatus('');
    }
  } catch {
    // Query failures (rare) — leave button state alone
  }
}

// Keep eligibility in sync with whatever the user is looking at
chrome.tabs.onActivated.addListener(updateCaptureEligibility);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') updateCaptureEligibility();
});
chrome.windows?.onFocusChanged.addListener(updateCaptureEligibility);

// ── Init ─────────────────────────────────────────────────────────────────────
render();
updateCaptureEligibility();
