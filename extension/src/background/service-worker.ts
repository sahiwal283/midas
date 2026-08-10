// Manifest V3 service worker.
// Orchestrates the capture + crop flow and posts passive captures.
// The browser session cookie is sent automatically on credentialed fetches.
//
// The quick-expense pipeline (draft → receipt upload → PATCH → submit) lives
// in the popup and talks to the standard session-cookie API directly — this
// worker no longer calls POST /api/v1/extension/expenses.

import type { ExtMessage, CaptureResult, CaptureIntent, CropRect, PendingCapture } from '../shared/types';
import { PENDING_CAPTURE_KEY } from '../shared/types';
import { getConfig } from '../shared/config';

/**
 * Screenshot taken while the crop overlay is up. Persisted to storage.session
 * so the flow survives the service worker being suspended mid-crop.
 */
interface InflightCapture {
  intent: CaptureIntent;
  dataUrl: string;
  pageUrl: string;
  pageTitle: string;
  selectedText?: string;
  tabId: number;
}

const INFLIGHT_KEY = 'inflightCapture';

chrome.runtime.onMessage.addListener((message: ExtMessage, sender, sendResponse) => {
  switch (message.type) {
    case 'START_CAPTURE':
      startCapture(message.intent).then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
      return true;

    case 'CROP_DONE':
      finishCapture(message, sender.tab?.id).then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
      return true;

    case 'SAVE_CAPTURE':
      saveCapture(message.result).then(sendResponse).catch((err) =>
        sendResponse({ type: 'SAVE_CAPTURE_ERROR', error: String(err) }),
      );
      return true;
  }
});

// ── Capture + crop orchestration ──────────────────────────────────────────────

async function startCapture(intent: CaptureIntent): Promise<{ ok?: boolean; error?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.windowId === undefined) return { error: 'No active tab found' };

  const dataUrl = await captureVisibleTab(tab.windowId);
  const selectedText = await getSelectedText(tab.id);

  const inflight: InflightCapture = {
    intent,
    dataUrl,
    pageUrl: tab.url ?? '',
    pageTitle: tab.title ?? '',
    selectedText,
    tabId: tab.id,
  };
  await chrome.storage.session.set({ [INFLIGHT_KEY]: inflight });

  const overlayShown = await beginCropOverlay(tab.id);
  if (!overlayShown) {
    // Restricted page (chrome://, Web Store, PDF viewer…): skip cropping and
    // use the full tab image directly.
    await storePendingAndReopen({
      intent,
      capture: {
        imageDataUrl: dataUrl,
        pageUrl: inflight.pageUrl,
        pageTitle: inflight.pageTitle,
        selectedText,
      },
      createdAt: Date.now(),
    });
    await chrome.storage.session.remove(INFLIGHT_KEY);
  }
  return { ok: true };
}

async function finishCapture(
  message: Extract<ExtMessage, { type: 'CROP_DONE' }>,
  senderTabId: number | undefined,
): Promise<{ ok?: boolean; error?: string }> {
  const stored = await chrome.storage.session.get(INFLIGHT_KEY);
  const inflight = stored[INFLIGHT_KEY] as InflightCapture | undefined;
  if (!inflight) return { error: 'No capture in progress' };
  if (senderTabId !== undefined && senderTabId !== inflight.tabId) {
    return { error: 'Crop came from a different tab' };
  }

  let imageDataUrl = inflight.dataUrl;
  if (message.rect) {
    try {
      imageDataUrl = await cropDataUrl(inflight.dataUrl, message.rect, message.viewportWidth, message.devicePixelRatio);
    } catch {
      // Cropping failed (corrupt image, zero-size rect…) — fall back to full tab.
      imageDataUrl = inflight.dataUrl;
    }
  }

  await storePendingAndReopen({
    intent: inflight.intent,
    capture: {
      imageDataUrl,
      pageUrl: inflight.pageUrl,
      pageTitle: inflight.pageTitle,
      selectedText: inflight.selectedText,
    },
    createdAt: Date.now(),
  });
  await chrome.storage.session.remove(INFLIGHT_KEY);
  return { ok: true };
}

async function storePendingAndReopen(pending: PendingCapture): Promise<void> {
  await chrome.storage.session.set({ [PENDING_CAPTURE_KEY]: pending });
  try {
    // Chrome 127+: reopen the popup so the user lands straight in the flow.
    await chrome.action.openPopup();
  } catch {
    // Older Chrome or no focused window — badge as a fallback affordance; the
    // popup clears it and picks up the pending capture on next click.
    await chrome.action.setBadgeBackgroundColor({ color: '#9a6f3b' }).catch(() => undefined);
    await chrome.action.setBadgeText({ text: '1' }).catch(() => undefined);
  }
}

function captureVisibleTab(windowId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!dataUrl) return reject(new Error('Screenshot failed'));
      resolve(dataUrl);
    });
  });
}

/** Ask the content script to show the crop overlay; inject it if not present. */
async function beginCropOverlay(tabId: number): Promise<boolean> {
  const send = () =>
    new Promise<boolean>((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'BEGIN_CROP' } satisfies ExtMessage, (res) => {
        if (chrome.runtime.lastError || !res?.ok) return resolve(false);
        resolve(true);
      });
    });

  if (await send()) return true;

  // Content script may not be loaded (tab opened before install). Inject once.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    return await send();
  } catch {
    return false;
  }
}

async function getSelectedText(tabId: number): Promise<string | undefined> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection()?.toString() ?? '',
    });
    return results?.[0]?.result?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── Cropping (OffscreenCanvas — service workers have no DOM canvas) ───────────

/**
 * Crop a CSS-pixel rect out of a physical-pixel screenshot.
 * captureVisibleTab returns physical pixels; the overlay reports CSS pixels.
 * Scale by the actual image-to-viewport ratio (equals devicePixelRatio, but
 * derived from the real bitmap so zoomed pages stay accurate).
 */
async function cropDataUrl(
  dataUrl: string,
  rect: CropRect,
  viewportWidth: number,
  devicePixelRatio: number,
): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const scale = viewportWidth > 0 ? bitmap.width / viewportWidth : devicePixelRatio || 1;

  const sx = clamp(Math.round(rect.x * scale), 0, bitmap.width - 1);
  const sy = clamp(Math.round(rect.y * scale), 0, bitmap.height - 1);
  const sw = clamp(Math.round(rect.width * scale), 1, bitmap.width - sx);
  const sh = clamp(Math.round(rect.height * scale), 1, bitmap.height - sy);

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const out = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(out);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

// ── Save Capture (passive — does not create an expense) ───────────────────────

async function saveCapture(result: CaptureResult): Promise<{ type: string; error?: string; isAuth?: boolean }> {
  const { midasApiUrl } = await getConfig();

  const res = await fetch(`${midasApiUrl}/api/v1/captures`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageDataUrl: result.imageDataUrl,
      pageUrl: result.pageUrl,
      pageTitle: result.pageTitle,
      selectedText: result.selectedText,
    }),
  });

  if (res.status === 401) {
    return { type: 'SAVE_CAPTURE_ERROR', error: 'You must be logged in to Midas.', isAuth: true };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { type: 'SAVE_CAPTURE_ERROR', error: `Midas returned ${res.status}: ${body}` };
  }

  return { type: 'SAVE_CAPTURE_SUCCESS' };
}
