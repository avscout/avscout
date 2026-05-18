// background.js - Service worker for the extension

chrome.runtime.onInstalled.addListener(() => {
  console.log("Floorplan Collector installed.");
});

// Configure the side panel: clicking the extension icon opens the side panel
// (rather than the old popup, which we've removed).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[BG] setPanelBehavior:", error));
