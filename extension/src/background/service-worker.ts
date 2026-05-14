// Manifest V3 service worker.
// All API calls go through here so the popup stays thin.
// The browser session cookie is sent automatically on credentialed fetches.
//
// INVARIANTS (never relax these):
//   - Never call Zoho from this worker.
//   - Never approve or transition expenses past 'pending'.
//   - Never bypass audit logging — the API endpoint handles it.

import type { ExtMessage, CaptureResult, SubmitExpensePayload, ExtensionCategory } from '../shared/types';
import { getConfig } from '../shared/config';

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'TAKE_SCREENSHOT':
      takeScreenshot().then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
      return true;

    case 'GET_CATEGORIES':
      getCategories().then(sendResponse).catch(() => sendResponse({ categories: [] }));
      return true;

    case 'SAVE_CAPTURE':
      saveCapture(message.result).then(sendResponse).catch((err) =>
        sendResponse({ type: 'SAVE_CAPTURE_ERROR', error: String(err) }),
      );
      return true;

    case 'SUBMIT_EXPENSE':
      submitExpense(message.payload).then(sendResponse).catch((err) =>
        sendResponse({ type: 'SUBMIT_EXPENSE_ERROR', error: String(err) }),
      );
      return true;
  }
});

// ── Screenshot ────────────────────────────────────────────────────────────────

async function takeScreenshot(): Promise<{ dataUrl?: string; error?: string }> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.windowId) return resolve({ error: 'No active tab found' });

      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png', quality: 90 }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          return resolve({ error: chrome.runtime.lastError.message });
        }
        resolve({ dataUrl });
      });
    });
  });
}

// ── Categories (fetched via background to avoid popup CORS issues) ────────────

async function getCategories(): Promise<{ categories: ExtensionCategory[] }> {
  const { midasApiUrl } = await getConfig();
  const res = await fetch(`${midasApiUrl}/api/v1/extension/categories`, {
    credentials: 'include',
  });
  if (!res.ok) return { categories: [] };
  return res.json() as Promise<{ categories: ExtensionCategory[] }>;
}

// ── Save Capture (passive — does not create an expense) ───────────────────────

async function saveCapture(result: CaptureResult): Promise<{ type: string; error?: string }> {
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
    throw Object.assign(new Error('Not logged in to Midas'), { isAuth: true });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Midas returned ${res.status}: ${body}`);
  }

  return { type: 'SAVE_CAPTURE_SUCCESS' };
}

// ── Submit Expense (creates expense + receipt + capture atomically in API) ────

async function submitExpense(payload: SubmitExpensePayload): Promise<{ type: string; result?: { expenseId: string; midasUrl: string }; error?: string; isAuth?: boolean }> {
  const { midasApiUrl } = await getConfig();

  const res = await fetch(`${midasApiUrl}/api/v1/extension/expenses`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageDataUrl: payload.capture.imageDataUrl,
      merchant: payload.merchant,
      amount: payload.amount,
      date: payload.date,
      currency: payload.currency,
      categoryId: payload.categoryId,
      description: payload.description,
      reimbursementRequired: payload.reimbursementRequired,
      pageUrl: payload.capture.pageUrl,
      pageTitle: payload.capture.pageTitle,
      selectedText: payload.capture.selectedText,
    }),
  });

  if (res.status === 401) {
    return { type: 'SUBMIT_EXPENSE_ERROR', error: 'You must be logged in to Midas to submit expenses.', isAuth: true };
  }

  if (!res.ok) {
    let message = `Midas API error (${res.status})`;
    try {
      const data = await res.json() as { error?: { message?: string } };
      if (data?.error?.message) message = data.error.message;
    } catch {}
    return { type: 'SUBMIT_EXPENSE_ERROR', error: message };
  }

  const data = await res.json() as { expense: { id: string }; midasUrl: string };

  return {
    type: 'SUBMIT_EXPENSE_SUCCESS',
    result: { expenseId: data.expense.id, midasUrl: data.midasUrl },
  };
}
