// Content script — install presence marker.
// Runs only on the Midas web app origins (see manifest.json) and stamps the
// extension version onto <html>, so the web app can detect the extension is
// installed and skip the first-run setup modal. No messaging, no DOM UI.
try {
  document.documentElement.dataset.midasExtension = chrome.runtime.getManifest().version;
} catch {
  // Non-fatal — the web app simply won't detect the extension.
}
