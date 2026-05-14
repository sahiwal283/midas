// Content script — injected into every page.
// Listens for capture commands from the popup via chrome.runtime.
import type { ExtMessage } from '../shared/types';

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  if (message.type === 'CAPTURE_REQUEST') {
    captureVisible().then((dataUrl) => {
      sendResponse({
        type: 'CAPTURE_RESULT',
        result: {
          imageDataUrl: dataUrl,
          pageUrl: window.location.href,
          pageTitle: document.title,
        },
      });
    }).catch((err) => {
      sendResponse({ type: 'CAPTURE_ERROR', error: String(err) });
    });
    return true; // async
  }
});

// Visible area capture using chrome.tabs.captureVisibleTab via the service worker.
// The content script signals readiness; the actual screenshot is taken by the background.
async function captureVisible(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
      if (response?.dataUrl) return resolve(response.dataUrl);
      reject('No screenshot data returned');
    });
  });
}
