export interface ExtensionConfig {
  midasUrl: string; // e.g. http://localhost:5173 (web UI) — used for "Open in Midas" links
  midasApiUrl: string; // e.g. http://localhost:4000 (API origin — the extension appends /api/v1/…)
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  midasUrl: 'https://midas.booute.duckdns.org',
  midasApiUrl: 'https://midas.booute.duckdns.org',
};

export interface CaptureResult {
  imageDataUrl: string;
  pageUrl: string;
  pageTitle: string;
  selectedText?: string;
}

export type CaptureIntent = 'capture' | 'expense';

/** CSS-pixel selection rectangle reported by the crop overlay. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The capture the service worker finished (screenshot + optional crop) while
 * the popup was closed. Stored in chrome.storage.session under 'pendingCapture'
 * — the popup picks it up on next open and resumes the flow.
 */
export interface PendingCapture {
  intent: CaptureIntent;
  capture: CaptureResult;
  createdAt: number;
}

export const PENDING_CAPTURE_KEY = 'pendingCapture';

// ── Message types (popup ↔ service worker ↔ content script) ───────────────────

export type ExtMessage =
  // Popup → service worker: snapshot the active tab, then show the crop
  // overlay in the page. The popup closes; the result lands in
  // storage.session as PendingCapture and the popup is reopened.
  | { type: 'START_CAPTURE'; intent: CaptureIntent }
  // Service worker → content script: show the drag-to-crop overlay.
  | { type: 'BEGIN_CROP' }
  // Content script → service worker: user finished (rect) or skipped (null).
  | {
      type: 'CROP_DONE';
      rect: CropRect | null;
      devicePixelRatio: number;
      viewportWidth: number;
      viewportHeight: number;
    }
  // Popup → service worker: save a passive capture (no expense created).
  | { type: 'SAVE_CAPTURE'; result: CaptureResult }
  | { type: 'SAVE_CAPTURE_SUCCESS' }
  | { type: 'SAVE_CAPTURE_ERROR'; error: string };

// ── API resource shapes used by the popup's quick-expense pipeline ────────────

export interface PaymentMethodOption {
  id: string;
  label: string;
  lastFour: string | null;
  defaultZohoEntity: string | null;
}

export interface CompanyOption {
  id: string;
  name: string;
  zohoEnabled: boolean;
}

export interface ExpenseAccountOption {
  accountId: string;
  accountName: string;
}

export interface OcrFields {
  merchant?: { value?: string | null };
  amount?: { value?: number | string | null };
  date?: { value?: string | null };
}
