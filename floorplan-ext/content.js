// content.js - Injected into every page to capture the floorplan SVG

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "extractFloorplan") {

    // ── 1. Find the root SVG ──────────────────────────────────────────────
    // Prefer #svg-element (outer wrapper with <defs>/styles), fall back to #floorplan
    const rootSvg =
      document.querySelector("svg#svg-element") ||
      document.querySelector("svg#floorplan");

    if (!rootSvg) {
      sendResponse({
        success: false,
        error: "No SVG with id #svg-element or #floorplan found on this page."
      });
      return true;
    }

    // ── 2. Detect the selected storey name ────────────────────────────────
    // Reads the text of the active button inside .storeys
    // e.g. <div class="storeys"><button class="selected ng-star-inserted">30a-K1</button>…
    let storeyName = null;
    const selectedBtn = document.querySelector(
      ".storeys .selected.ng-star-inserted, .storeys button.selected"
    );
    if (selectedBtn) {
      storeyName = selectedBtn.textContent.trim();
    }

    // ── 3. Default title: storey name > page title > hostname ─────────────
    const defaultTitle =
      storeyName ||
      document.title ||
      window.location.hostname;

    // ── 4. Serialize the full SVG (preserves <defs>, styles, transforms) ──
    const serializer = new XMLSerializer();
    const svgContent = serializer.serializeToString(rootSvg);

    sendResponse({
      success: true,
      svgContent,
      defaultTitle,
      storeyName,
      pageTitle: document.title || window.location.hostname,
      pageUrl: window.location.href,
      timestamp: Date.now(),
      dimensions: {
        width:  rootSvg.getAttribute("width")  || rootSvg.viewBox?.baseVal?.width  || "unknown",
        height: rootSvg.getAttribute("height") || rootSvg.viewBox?.baseVal?.height || "unknown"
      }
    });

    return true;
  }
});
