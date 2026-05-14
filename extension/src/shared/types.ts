export interface ExtensionConfig {
  midasUrl: string; // e.g. http://localhost:5173 (web UI) — API is at the same host on port 4000
  midasApiUrl: string; // e.g. http://localhost:4000 (API)
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  midasUrl: 'http://localhost:5173',
  midasApiUrl: 'http://localhost:4000',
};

export type CaptureMode = 'visible';

export interface CaptureResult {
  imageDataUrl: string;
  pageUrl: string;
  pageTitle: string;
  selectedText?: string;
}

// ── Expense submission payload (sent popup → background → Midas API) ───────────

export interface SubmitExpensePayload {
  capture: CaptureResult;
  merchant: string;
  amount: number;
  date: string;
  currency: string;
  categoryId?: string;
  description?: string;
  reimbursementRequired: boolean;
}

export interface SubmitExpenseResult {
  expenseId: string;
  midasUrl: string; // direct link to the expense in Midas web UI
}

export interface ExtensionCategory {
  id: string;
  name: string;
  description: string | null;
}

// ── Message types between popup ↔ service worker ──────────────────────────────

export type ExtMessage =
  // Screenshot helpers
  | { type: 'TAKE_SCREENSHOT' }
  | { type: 'SCREENSHOT_RESULT'; dataUrl: string }
  | { type: 'SCREENSHOT_ERROR'; error: string }
  // Category fetch (popup requests via background to avoid CORS complexity)
  | { type: 'GET_CATEGORIES' }
  // Save capture (passive, no expense created)
  | { type: 'SAVE_CAPTURE'; result: CaptureResult }
  | { type: 'SAVE_CAPTURE_SUCCESS' }
  | { type: 'SAVE_CAPTURE_ERROR'; error: string }
  // Submit expense (creates expense + receipt + capture in one call)
  | { type: 'SUBMIT_EXPENSE'; payload: SubmitExpensePayload }
  | { type: 'SUBMIT_EXPENSE_SUCCESS'; result: SubmitExpenseResult }
  | { type: 'SUBMIT_EXPENSE_ERROR'; error: string; isAuth?: boolean };
