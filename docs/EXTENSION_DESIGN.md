# Midas Browser Extension — Design

## Overview

The Midas browser extension has **two distinct workflows**. They differ in what they create in Midas and what happens next.

| | Save Capture | Submit Expense |
|---|---|---|
| What user does | One click | Click + fill form |
| What gets created | `captures` row (status: `draft`) | `expenses` + `receipts` + `captures` rows |
| Expense status | — | `pending` (enters accountant queue) |
| Accountant review | Not triggered | Required |
| Zoho sync | Never | Never (accountant does this after approval) |
| Auto-approve | Never | Never |
| Where it appears | Captures page | My Expenses + Accountant queue |

---

## Workflow 1: Save Capture

**Use case:** You see a receipt, invoice, or order confirmation online. You're not ready to submit an expense yet — you just want to save the evidence.

**Flow:**
1. User clicks extension icon → popup opens
2. Clicks **"Save Capture"**
3. Extension takes a screenshot of the visible tab
4. Preview is shown with page title, URL, and any selected text
5. User clicks **"Save Capture"** to confirm
6. Background service worker `POST /api/v1/captures` with `imageDataUrl`, `pageUrl`, `pageTitle`, `selectedText`
7. API creates a `captures` row with `status='draft'` and `source='extension'`
8. Popup shows success; "Open in Midas" button links to `/captures`

**Result in Midas:** Appears in Captures page → Unlinked tab. User can later link it to an expense manually from the Captures or ExpenseDetail pages, or discard it.

---

## Workflow 2: Submit Expense

**Use case:** You have a receipt open right now and want to submit an expense for accountant review immediately.

**Flow:**
1. User clicks extension icon → popup opens
2. Clicks **"Submit Expense"**
3. Extension takes a screenshot
4. Expense form appears with:
   - Merchant (pre-filled from page title, editable)
   - Amount *
   - Date * (defaults to today)
   - Currency (USD/EUR/GBP/CAD/MXN)
   - Notes/description
   - Reimbursement required (checkbox)
5. User fills form and clicks **"Submit Expense"**
6. Background service worker `POST /api/v1/extension/expenses` with screenshot + form data
7. API atomically creates:
   - `expenses` row: `status='pending'`, `source_app='browser_extension'`, `source_ref_id=pageUrl`
   - `receipts` row linked to expense, OCR triggered in background
   - `captures` row: `status='linked'`, linked to the expense
   - `audit_logs` row: `action='expense_created_from_extension'`
8. Popup shows success with expense ID and **"Open in Midas"** button → deep links to `/expenses/:id`

**Result in Midas:**
- Expense is immediately in accountant's review queue (`pending`)
- User sees it in My Expenses
- Accountant reviews, can approve/reject/request info via normal workflow
- OCR result attached to receipt automatically when done
- Zoho push happens only after accountant explicitly triggers it

---

## What the extension NEVER does

- Approves expenses
- Pushes to Zoho
- Sets zohoEntity or zohoExpenseId
- Creates expenses with `status='approved'` or `status='draft'` (always `'pending'`)
- Bypasses audit logging
- Stores auth tokens — uses the browser session cookie

---

## Architecture

```
Extension (Manifest V3)
├── popup/App.tsx         React UI — two-action home, form, success/error screens
├── background/           Service worker — all API calls go through here
│   └── service-worker.ts TAKE_SCREENSHOT | SAVE_CAPTURE | SUBMIT_EXPENSE handlers
├── content/capture.ts    Injected on all pages — responds to capture commands
├── options/index.html    Settings page — configure midasUrl + midasApiUrl
└── shared/
    ├── types.ts          Message types, payload interfaces
    └── config.ts         chrome.storage.sync wrapper

API endpoints used:
  POST /api/v1/captures              ← Save Capture workflow
  POST /api/v1/extension/expenses    ← Submit Expense workflow (new endpoint)

Auth: browser session cookie (httpOnly) — extension uses credentials:'include'
CORS: API allows chrome-extension:// and moz-extension:// origins
```

---

## Building the Extension

```bash
cd extension
npm install
npm run build       # outputs to extension/dist/
```

### Load in Chrome (dev)
1. Open `chrome://extensions`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select `extension/dist/`

### Load in Firefox (dev)
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `extension/dist/manifest.json`
Firefox note: manifest.json uses `background.service_worker` which requires Firefox 121+. Older Firefox needs `background.scripts` instead — toggle with `npm run build:firefox`.

---

## Testing Locally (Step by Step)

### Prerequisites
- Docker running: `docker compose up --build`
- Midas web app at http://localhost:5173
- Midas API at http://localhost:4000
- Extension loaded in Chrome (see above)

### Setup
1. Open http://localhost:5173 and log in as `user@midas.local` / `user123`
2. Open extension options: right-click extension icon → "Options" (or click ⚙️ in popup)
3. Set:
   - Web UI URL: `http://localhost:5173`
   - API URL: `http://localhost:4000`
4. Click "Save Settings"

### Test: Save Capture
1. Navigate to any webpage (e.g. an Amazon order confirmation)
2. Click the Midas extension icon
3. Click **"Save Capture"**
4. Review the screenshot preview
5. Click **"Save Capture"** to confirm
6. Expected: success screen + "Open in Midas" button
7. Verify: open http://localhost:5173/captures — capture appears in "Unlinked" tab

### Test: Submit Expense
1. Navigate to any webpage with a price visible
2. Select some text on the page (e.g. the price "£42.99") before clicking the extension
3. Click the Midas extension icon
4. Click **"Submit Expense"**
5. Fill in: merchant, amount, date. Check "Reimbursement required" if needed
6. Click **"Submit Expense"**
7. Expected: success screen with expense ID and "Open in Midas" button
8. Verify:
   - http://localhost:5173/expenses — expense appears with status "Pending Review"
   - Expense detail shows "📷 Browser extension" badge and source URL
   - http://localhost:5173/captures — capture appears in "Linked to expense" tab
   - http://localhost:4000/api/v1/accountant/queue — expense in accountant queue
   - Audit log: action = `expense_created_from_extension`

### Test: Auth error
1. Log out of Midas in the browser
2. Click the extension, try Save Capture or Submit Expense
3. Expected: error screen "Not logged in to Midas" with "Log in to Midas" button

---

## Capture Schema Note

`captures.selected_text` was added in the revised schema. If running with an existing database, run `npm run db:push -w apps/api` to sync the new column.

`expenses.source_type` was added in the hardening pass. Run `npm run db:push -w apps/api` to sync.

---

## Extension Permissions

The `manifest.json` requests the following permissions. Each is necessary:

| Permission | Why needed | Could it be removed? |
|------------|-----------|----------------------|
| `activeTab` | Grants temporary access to the currently active tab when the user opens the popup | No — needed for scripting executeScript (selected text extraction) |
| `tabs` | Required by `chrome.tabs.captureVisibleTab` in the **background service worker** — `activeTab` alone is per-gesture and doesn't persist to the service worker context | No |
| `scripting` | `chrome.scripting.executeScript` to read `window.getSelection()` for selected text | No |
| `storage` | `chrome.storage.sync` for persisting `midasUrl` / `midasApiUrl` settings | No |
| `<all_urls>` (host permission) | The Midas API URL is user-configurable (defaults to `localhost:4000`), so the extension cannot know the host at build time. Credentialed fetch from a background service worker requires an explicit host permission — `activeTab` does not cover background requests. | Could be replaced with a user-granted `optional_host_permissions` flow in a future version |

**`tabs` vs `activeTab`**: `activeTab` is granted on explicit user gesture (clicking the popup icon) and applies to the popup context. The background service worker, however, persists beyond the gesture. `chrome.tabs.captureVisibleTab` called from the service worker requires the `tabs` permission (or `activeTab` at the time of the gesture, but that window has closed). We call captureVisibleTab from the service worker to keep the popup thin and stateless.

**Reducing `<all_urls>`**: A future improvement would declare `optional_host_permissions: ["*://*/*"]` and prompt the user to grant access to their specific Midas domain. This reduces the apparent permission footprint in the Chrome Web Store listing.

---

## Screenshot Upload Strategy

### Current approach (MVP)
Screenshots are encoded as base64 data URLs in the JSON body. The API decodes them server-side. The JSON body limit is set to 20 MB to accommodate large screenshots.

### Limitations
- A 1920×1080 PNG screenshot can reach 2–8 MB uncompressed. Base64 encoding adds ~33% overhead.
- Large payloads increase memory pressure on both the service worker and the API process.
- The 15 MB buffer size check in the API rejects excessively large images before storage.

### Future improvement: multipart or presigned URL upload
When the extension is used at scale, replace the base64 approach with:

**Option A — multipart/form-data**: The service worker converts the data URL to a `Blob` and sends it as a `FormData` field alongside the JSON metadata fields. The API uses `multer` (already a dependency) to receive the file. No base64 encoding overhead; suitable for most deployments.

**Option B — presigned S3 URL**: Extension first calls `POST /api/v1/extension/upload-token` to get a short-lived presigned URL, uploads the PNG directly to S3 from the service worker, then sends only the S3 key in the expense submission body. Zero data passes through the API process.

Option A is simpler and preferred unless storage is S3 (`STORAGE_MODE=s3`) and direct-upload latency matters.

---

## Accountant Queue: Extension-Submitted Expenses

The queue endpoint (`GET /api/v1/accountant/queue`) now includes a computed `flags` array on each expense:

| Flag | Meaning |
|------|---------|
| `from_extension` | Expense was submitted via the browser extension (`sourceApp === 'browser_extension'`) |
| `needs_category` | No category is assigned (`categoryId === null`) |

Accountants should prioritise expenses with `needs_category` during review. The web UI can surface these as visual badges on queue cards. No schema change was required — flags are derived at query time.

---

## Audit Trail

Extension-submitted expenses produce three audit log entries:

| Action | entityType | Notes |
|--------|-----------|-------|
| `expense_created_from_extension` | `expense` | Metadata: `pageUrl`, `pageTitle`, `hasSelectedText`, `captureId`, `receiptId` |
| `receipt_attached_from_extension` | `receipt` | Metadata: `expenseId` |
| `capture_linked_to_expense` | `capture` | Metadata: `expenseId`, `hasSelectedText` |

**Base64 data is never stored in audit metadata.** Only stable identifiers and boolean flags.

---

## What Remains Deferred

| Feature | Notes |
|---------|-------|
| Full-page capture | `chrome.tabs.captureVisibleTab` only captures visible area. Full-page requires injecting a content script to stitch segments — complex, not needed for MVP |
| Selected-area capture | Requires content script overlay UI — deferred |
| Firefox-specific manifest variant | `npm run build:firefox` script exists but the manifest variant is not yet wired in `vite.config.ts` |
| Extension icon assets | Placeholder paths in manifest — create 16/32/48/128px PNG icons in `extension/icons/` |
| Payment method / card field | Design documented in `docs/PAYMENT_METHODS_DESIGN.md`. Schema migration and API routes are scoped separately |
| `<all_urls>` → `optional_host_permissions` | Would reduce Chrome Web Store permission footprint. Requires a UX flow to prompt the user for access to their specific Midas domain |
| Multipart screenshot upload | Base64 JSON works for MVP. See "Screenshot Upload Strategy" above for migration path when scale requires it |
