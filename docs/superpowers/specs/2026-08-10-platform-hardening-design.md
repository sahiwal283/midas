# Platform Hardening — Design

**Date:** 2026-08-10
**Status:** Approved (roadmap sub-project H; extension rework excluded — needs
product requirements)

## 1. Authenticated file serving (kill public /uploads)

- New `GET /api/v1/files/receipts/:receiptId` — authenticated; allowed for the
  expense owner or accountant/admin (developer passes). Streams the file from
  `UPLOADS_DIR` with the stored mimeType; 404 unknown, 403 otherwise.
- Same pattern `GET /api/v1/files/captures/:captureId` (owner or privileged)
  if captures store files on disk (verify schema).
- Web: every place that builds a receipt/capture URL from `/uploads/...`
  switches to the new endpoints (grep `uploads` and the receiptContentUrl
  helper). Images keep working because the browser sends the session cookie.
- Then REMOVE `app.use('/uploads', express.static(...))` from server.ts.
- Ext-API consumers (Trade Show) must be checked: if `/api/v1/ext` returns
  `/uploads` URLs, keep a compatibility path — receipts fetched through the
  ext API get short-lived signed paths later; v1: ext responses include the
  API file route and ext clients authenticate with their key (verify what ext
  routes return; do not break their contract — EXT_API_MERGE_LOCK.md applies:
  do NOT modify ext.ts response shapes, only URL string values if present).

## 2. Close period (minimal, correct)

- `closed_periods` (migration 0013): `id uuid PK`, `period char(7) unique`
  ('YYYY-MM'), `closed_by_id uuid FK users`, `note text`, `created_at`.
- Pure lib `lib/closedPeriods.ts`: `periodOf(date: 'YYYY-MM-DD') → 'YYYY-MM'`,
  `isInClosedPeriods(date, periods: string[])`. Tests.
- Enforcement (when the expense's date falls in a closed period):
  employee PATCH / delete / submit → 409 `PERIOD_CLOSED`; accountant review
  and reimbursement changes → 409 `PERIOD_CLOSED`; admin force-delete stays
  (explicit override, audited). Corrections happen via the existing rejected-
  clone flow into an open period (documented as the adjustment path v1).
- API: `GET/POST/DELETE /accountant/closed-periods` (accountant/admin;
  DELETE = reopen, admin only). Audit both.
- UI: small "Close period" card on the accountant dashboard: month picker +
  Close button, list of closed periods with reopen (admin). Closed-period 409s
  surface with their message wherever edits already show errors.

## 3. Merchant normalization (reporting v1)

- Pure lib `lib/merchants.ts`: `normalizeMerchant(raw): string` — lowercase,
  strip punctuation/star-suffixes (`amazon.com*1a2b3` → `amazon`), drop
  `.com`/`inc`/`llc` tails, alias map (amzn→amazon, sq *→(strip), wal-mart→
  walmart, etc.), then Title Case for display. Tests.
- Reports `topVendors`: group post-SQL by normalized name (display the
  normalized label). Duplicate matcher keeps its own looser compare.

## 4. Production security pass (config + docs)

- Verify and document: helmet on, auth rate limit, CORS allowlist,
  COOKIE_SECURE=true in prod, JWT_SECRET length check, uploads no longer
  public (item 1), invite tokens single-use/expiring, seeded credentials
  rotated (partner/developer seed users must be rotated or deactivated before
  pilot — called out in OPERATIONS.md checklist).
- Add a "Production security checklist" section to docs/OPERATIONS.md.

## Testing

Vitest: closedPeriods lib, merchants lib. File routes by typecheck + prod
smoke (owner 200, other-user 403, receipt image renders in UI).

## Out of scope

Extension rework (needs requirements), S3/object storage + signed URLs
(file-stream endpoint chosen for this deployment), reversal records for
closed-period corrections.
