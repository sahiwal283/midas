// Content script — drag-to-crop overlay.
// The service worker snapshots the tab FIRST, then asks this script to show
// the overlay. The user drags a rectangle; we report the CSS-pixel rect back
// (CROP_DONE) and the worker crops the already-taken screenshot, so the dim
// overlay never appears in the final image.
import type { ExtMessage, CropRect } from '../shared/types';

let overlayActive = false;

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  if (message.type === 'BEGIN_CROP') {
    if (overlayActive) {
      sendResponse({ ok: true });
      return;
    }
    showCropOverlay();
    sendResponse({ ok: true });
  }
});

function finish(rect: CropRect | null): void {
  chrome.runtime.sendMessage({
    type: 'CROP_DONE',
    rect,
    devicePixelRatio: window.devicePixelRatio || 1,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  } satisfies ExtMessage);
}

function showCropOverlay(): void {
  overlayActive = true;

  // Host + shadow root so page CSS can't restyle the overlay.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;cursor:crosshair;user-select:none;';

  // Full-page dim shown until a selection exists; the selection box then
  // carries the dim via a huge box-shadow with a clear interior.
  const dim = document.createElement('div');
  dim.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);';

  const box = document.createElement('div');
  box.style.cssText = [
    'position:fixed',
    'display:none',
    'border:2px solid #f4c569',
    'outline:1px solid rgba(0,0,0,0.65)',
    'box-shadow:0 0 0 200vmax rgba(15,23,42,0.45)',
    'box-sizing:border-box',
    'pointer-events:none',
  ].join(';');

  const label = document.createElement('div');
  label.style.cssText = [
    'position:fixed',
    'display:none',
    'background:#111827',
    'color:#f9fafb',
    'font:600 12px/1.6 system-ui,-apple-system,sans-serif',
    'padding:2px 8px',
    'border-radius:6px',
    'pointer-events:none',
    'white-space:nowrap',
  ].join(';');

  const hint = document.createElement('div');
  hint.textContent = 'Drag to crop the receipt — Esc to skip';
  hint.style.cssText = [
    'position:fixed',
    'top:16px',
    'left:50%',
    'transform:translateX(-50%)',
    'background:#111827',
    'color:#f9fafb',
    'font:600 13px/1.6 system-ui,-apple-system,sans-serif',
    'padding:6px 14px',
    'border-radius:999px',
    'pointer-events:none',
  ].join(';');

  const fullTabBtn = document.createElement('button');
  fullTabBtn.textContent = 'Use full tab';
  fullTabBtn.style.cssText = [
    'position:fixed',
    'bottom:20px',
    'left:50%',
    'transform:translateX(-50%)',
    'background:#9a6f3b',
    'color:#fff',
    'border:none',
    'border-radius:999px',
    'padding:9px 20px',
    'font:700 13px system-ui,-apple-system,sans-serif',
    'cursor:pointer',
    'box-shadow:0 4px 14px rgba(0,0,0,0.35)',
  ].join(';');

  root.append(dim, box, label, hint, fullTabBtn);
  shadow.append(root);
  document.documentElement.append(host);

  let startX = 0;
  let startY = 0;
  let dragging = false;
  let rect: CropRect | null = null;

  function currentRect(x: number, y: number): CropRect {
    const left = Math.max(0, Math.min(startX, x));
    const top = Math.max(0, Math.min(startY, y));
    const right = Math.min(window.innerWidth, Math.max(startX, x));
    const bottom = Math.min(window.innerHeight, Math.max(startY, y));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function paint(r: CropRect): void {
    dim.style.display = 'none';
    box.style.display = 'block';
    box.style.left = `${r.x}px`;
    box.style.top = `${r.y}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;

    label.style.display = 'block';
    label.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    const labelY = r.y > 30 ? r.y - 26 : r.y + r.height + 6;
    label.style.left = `${r.x}px`;
    label.style.top = `${labelY}px`;
  }

  function cleanup(): void {
    overlayActive = false;
    document.removeEventListener('keydown', onKeyDown, true);
    host.remove();
  }

  function done(result: CropRect | null): void {
    cleanup();
    finish(result);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done(null); // skip crop — use full tab
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (rect && rect.width >= 8 && rect.height >= 8) done(rect);
    }
  }

  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target === fullTabBtn) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    hint.style.display = 'none';
    paint(currentRect(e.clientX, e.clientY));
  });

  root.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    rect = currentRect(e.clientX, e.clientY);
    paint(rect);
  });

  root.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !dragging || e.target === fullTabBtn) return;
    e.preventDefault();
    dragging = false;
    rect = currentRect(e.clientX, e.clientY);
    if (rect.width >= 8 && rect.height >= 8) {
      done(rect); // mouse-up confirms the selection
    } else {
      // Accidental click — reset to the initial dimmed state.
      rect = null;
      box.style.display = 'none';
      label.style.display = 'none';
      dim.style.display = 'block';
      hint.style.display = 'block';
    }
  });

  fullTabBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    done(null);
  });

  document.addEventListener('keydown', onKeyDown, true);
}
