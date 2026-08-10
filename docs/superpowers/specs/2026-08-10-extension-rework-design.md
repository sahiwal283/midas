# Extension Rework — Design

**Date:** 2026-08-10
**Status:** Approved (final roadmap item; desktop app deferred to a future project)

## 1. Capture + drag-to-crop

Both popup actions (Save Capture / New Expense) flow through a crop step:
1. Service worker snapshots the visible tab (`chrome.tabs.captureVisibleTab`,
   PNG, as today).
2. A content-script overlay dims the page; the user drags a rectangle around
   the receipt. Esc or "Use full tab" skips cropping.
3. Crop happens on a canvas at `devicePixelRatio` scale (sharp output).
4. The cropped PNG data URL replaces the full-tab image in both flows.

## 2. Quick expense form (same pipeline as the web wizard)

The New Expense flow stops using `POST /api/v1/extension/expenses` and drives
the standard session-cookie endpoints (CORS for `chrome-extension://` already
allows this):

1. `POST /expenses` `{ draft: true }` → draft id.
2. `POST /expenses/:id/receipts` with the cropped PNG → OCR runs; response's
   `ocrData.fields` prefills merchant / amount / date.
3. Compact popup form: merchant, amount, date (all editable), payment method
   (`GET /payment-methods`), **Company** (`GET /companies`, auto-set from the
   card's default), Zoho expense category (`GET /zoho/expense-accounts` —
   only when the selected company is zohoEnabled), notes (optional).
4. `PATCH /expenses/:id` with final fields, then `POST /expenses/:id/submit`.
   Popup shows the server's outcome: "Approved ✓ — sent to accounting"
   (autoPushed), "Approved ✓", or "Submitted for review". All auto-push rules
   are server-side and unchanged.

Save Capture keeps `POST /api/v1/captures` (with the cropped image).
`POST /api/v1/extension/expenses` remains for backward compatibility but the
popup no longer calls it.

## 3. Distribution + instructions

- Extension build gains `npm run package`: builds `extension/dist` then zips it
  to `apps/web/public/midas-extension.zip` (committed artifact, versioned with
  the app).
- New web page `/get-extension` (any authenticated user; linked from the
  Captures page header and the desktop sidebar under the Captures link):
  Download button (`/midas-extension.zip`) + numbered Chrome/Edge steps:
  unzip → chrome://extensions → Developer mode → Load unpacked → pin the
  icon → Options: set Midas URL `https://midas.booute.duckdns.org` and API URL
  `https://midas.booute.duckdns.org/api` (VERIFY the exact values the options
  page expects from extension/src/options — print the right ones) → log into
  Midas in the same browser. Firefox: short note that it's Chrome/Edge only
  for now.

## 4. Docs

Rewrite `docs/EXTENSION_DESIGN.md`: crop flow, wizard-pipeline submission, the
auto-push alignment (supersedes "never auto-approves / never calls Zoho" — the
SERVER decides now), distribution model. Roadmap doc: extension rework marked
done; desktop app recorded as deferred future project.

## Testing

Extension has no test harness — gates are `npm run build` in extension/ plus
type-checking. API untouched except verification that no server change is
needed (readiness treats extension expenses as daily already). Web lint. User
does the manual end-to-end (install, crop, submit).

## Out of scope

Desktop (Electron) app, Chrome Web Store publishing, Firefox support,
full-screen capture via getDisplayMedia.
