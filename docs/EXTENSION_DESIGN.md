# Midas Browser Extension — Design

Reworked 2026-08-10 (see `docs/superpowers/specs/2026-08-10-extension-rework-design.md`).
The extension has **two workflows**, and both now flow through a **drag-to-crop** step:

| | Save Capture | New Expense |
|---|---|---|
| What user does | Click → crop → confirm | Click → crop → quick form |
| What gets created | `captures` row (status: `draft`) | Draft expense + receipt via the standard wizard pipeline |
| Expense status after submit | — | Decided by the **server**: `approved` (auto-push eligible) or `pending` |
| Zoho sync | Never | Server-side auto-push may approve + push immediately (same rules as the web wizard) |
| Where it appears | Captures page | My Expenses (+ Accountant queue when pending) |

> The old invariant "the extension never approves / never calls Zoho" is
> superseded: the extension still never *decides* anything — it drives the same
> `POST /expenses/:id/submit` endpoint as the web wizard, and the **server**
> applies the daily auto-push rules (complete staff-entered expenses for
> Zoho-enabled companies are approved and pushed automatically; everything else
> goes to the accountant queue).

---

## Capture + drag-to-crop flow

Both popup actions start the same way:

1. Popup sends `START_CAPTURE { intent }` to the service worker and closes.
2. The service worker snapshots the visible tab (`chrome.tabs.captureVisibleTab`,
   PNG, **physical pixels**), grabs any selected text, and parks the screenshot
   in `chrome.storage.session` (`inflightCapture`).
3. It messages the content script (`BEGIN_CROP`), which shows an overlay:
   the page dims, the user drags a selection rectangle (crisp gold border +
   live `W × H` dimensions label). **Mouse-up or Enter confirms** the crop;
   **Esc or the floating "Use full tab" button** skips it. The screenshot was
   taken *before* the overlay appeared, so the dimming never shows in the image.
4. The content script reports the CSS-pixel rect (`CROP_DONE`); the worker
   crops on an `OffscreenCanvas`, mapping CSS pixels → physical pixels by the
   real bitmap-to-viewport ratio (i.e. `devicePixelRatio`, derived from the
   actual image so zoomed pages stay accurate).
5. The result is stored as `pendingCapture` in `chrome.storage.session` and the
   popup is reopened (`chrome.action.openPopup()`, Chrome 127+; on older Chrome
   a badge appears and the next popup open resumes the flow).

On restricted pages (chrome://, Web Store, PDF viewer) where no content script
can run, the crop step is skipped and the full-tab image is used.

---

## Workflow 1: Save Capture

Passive evidence collection — no expense created.

1. Popup → **Save Capture** → crop flow above.
2. Popup reopens with the cropped preview; user confirms.
3. Service worker `POST /api/v1/captures` with `imageDataUrl`, `pageUrl`,
   `pageTitle`, `selectedText` → `captures` row (`status='draft'`,
   `source='extension'`).
4. Appears on the Captures page → Unlinked tab; link or discard later.

---

## Workflow 2: New Expense (wizard pipeline)

The popup drives the **same session-cookie endpoints as the web wizard** —
`POST /api/v1/extension/expenses` is no longer called (the API route remains
for backward compatibility only).

1. Popup → **New Expense** → crop flow above.
2. Popup reopens and runs the pipeline (each step has a retry affordance):
   - `POST /expenses { draft: true }` → draft id.
   - `POST /expenses/:id/receipts` (multipart `file`, the cropped PNG) —
     synchronous OCR; `receipt.ocrData.fields` prefills merchant / amount /
     date. If OCR yields nothing, the fields are empty and editable with a
     small note.
   - Reference data (best-effort; failures hide the affected select):
     `GET /payment-methods`, `GET /companies`.
3. Compact form: merchant, amount, date (all editable), payment method,
   **Company** (auto-set from the selected card's `defaultZohoEntity` when it
   matches a company), Zoho **expense category**
   (`GET /zoho/expense-accounts?zohoEntity=…` — only shown when the selected
   company is `zohoEnabled`; loading state; a load failure hides the select),
   notes.
4. `PATCH /expenses/:id` with the final fields, then `POST /expenses/:id/submit`.
5. Outcome screen mirrors the server's decision:
   - **"Approved — sent to accounting"** — `autoPushed: true`.
   - **"Approved"** — approved without push.
   - **"Submitted for review"** — `status: 'pending'`, accountant queue.
   Each links to `{midasUrl}/expenses/{id}`.

Auth errors at any step show "Not logged in to Midas" with a login link —
the extension uses the browser's Midas session cookie, never its own tokens.

---

## Architecture

```
Extension (Manifest V3)
├── popup/App.tsx         React UI — home, crop-resume, quick-expense form, outcomes
├── popup/api.ts          Credentialed fetch client for the wizard pipeline
├── background/           Service worker — capture orchestration + Save Capture POST
│   └── service-worker.ts START_CAPTURE | CROP_DONE | SAVE_CAPTURE handlers
├── content/capture.ts    Drag-to-crop overlay (shadow DOM, injected on demand too)
├── options/index.html    Settings — midasUrl + midasApiUrl
└── shared/
    ├── types.ts          Message types, pending-capture contract, API shapes
    └── config.ts         chrome.storage.sync wrapper

API endpoints used:
  POST  /api/v1/captures                       ← Save Capture
  POST  /api/v1/expenses { draft: true }       ← New Expense pipeline
  POST  /api/v1/expenses/:id/receipts          ← cropped PNG, sync OCR
  GET   /api/v1/payment-methods
  GET   /api/v1/companies
  GET   /api/v1/zoho/expense-accounts?zohoEntity=…
  PATCH /api/v1/expenses/:id
  POST  /api/v1/expenses/:id/submit            ← server decides approve/push/pending

Auth: browser session cookie (httpOnly) — credentials:'include' everywhere.
CORS: API allows chrome-extension:// and moz-extension:// origins.
State handoff: chrome.storage.session ('inflightCapture' during crop,
'pendingCapture' between popup sessions).
```

### Messaging (MV3)

The popup necessarily closes when the user clicks the page to crop, so the flow
cannot be popup-driven end-to-end. The service worker owns the state machine:

```
popup ── START_CAPTURE ──▶ worker ── captureVisibleTab
                             │  store inflightCapture (storage.session)
                             ├── BEGIN_CROP ──▶ content overlay
                             ◀── CROP_DONE (rect | null) ──┘
                             │  crop (OffscreenCanvas)
                             │  store pendingCapture, clear inflight
                             └── action.openPopup() ──▶ popup resumes
```

---

## Options page

Two fields (`extension/src/options/index.html`):

| Field | Meaning | Local dev | Production |
|-------|---------|-----------|------------|
| **Web UI URL** (`midasUrl`) | Address of the Midas web app; used for "Open in Midas" links | `http://localhost:5173` | `https://midas.booute.duckdns.org` |
| **API URL** (`midasApiUrl`) | API **origin only** — the extension appends `/api/v1/…` itself | `http://localhost:4000` | `https://midas.booute.duckdns.org` |

In production both values are the same domain because nginx proxies `/api/` to
the API container. Do **not** include an `/api` suffix in the API URL.

---

## Distribution

- `npm run package` (in `extension/`) builds `dist/` — including copying
  `manifest.json` and `icons/` — and zips it to
  `apps/web/public/midas-extension.zip`, a **committed artifact** served by the
  web app at `/midas-extension.zip`.
- The web app's **`/get-extension`** page (any authenticated user; linked from
  the Captures header and the sidebar under Captures) has the download button
  and numbered Chrome/Edge install steps, including the options values above
  and the "log into Midas in this browser first" step.
- Firefox is not supported yet; Chrome Web Store publishing is out of scope.

---

## Building the Extension

```bash
cd extension
npm install
npm run build       # dist/ — loadable via chrome://extensions → Load unpacked
npm run package     # build + zip → apps/web/public/midas-extension.zip
```

Local testing: set Options to `http://localhost:5173` / `http://localhost:4000`,
log in at `http://localhost:5173`, then exercise both flows. Verify:
crop overlay appears and the cropped image (not the full tab, not the dim
overlay) lands in the popup; New Expense shows OCR-prefilled fields; the
outcome screen matches the server decision (check My Expenses / queue).

---

## Extension Permissions

| Permission | Why needed |
|------------|-----------|
| `activeTab` | Temporary access to the active tab on popup click |
| `tabs` | `chrome.tabs.captureVisibleTab` from the service worker |
| `scripting` | Selected-text read + on-demand content-script injection for the crop overlay |
| `storage` | `chrome.storage.sync` (settings) + `chrome.storage.session` (capture handoff) |
| `<all_urls>` (host) | User-configurable Midas host; credentialed background fetches need an explicit host permission |

`<all_urls>` could become `optional_host_permissions` in a future version to
shrink the permission footprint.

---

## What Remains Deferred

| Feature | Notes |
|---------|-------|
| Desktop capture app (Electron) | Future project — capture anything on screen, not just browser tabs |
| Firefox support | Manifest variant exists (`build:firefox`) but is unwired and untested |
| Chrome Web Store publishing | Distribution is via `/get-extension` for now |
| Full-page (scrolling) capture | Visible area + crop covers the receipt use case |
| `<all_urls>` → `optional_host_permissions` | Permission-footprint reduction |
