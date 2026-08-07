# Employee Mobile-First Capture — Design

**Date:** 2026-08-07
**Status:** Approved
**Roadmap:** sub-project A of `2026-08-07-product-roadmap.md`

## 1. Companies backbone

- New table `companies`: `id uuid PK`, `name text unique not null`,
  `zoho_enabled boolean not null default true`, `is_active boolean not null
  default true`, `sort_order integer not null default 0`, `created_at`.
- Seeded with the 4 sister companies (names supplied at seed time from the
  current Zoho entity list + the no-Zoho company; the no-Zoho one gets
  `zoho_enabled: false`).
- `GET /api/v1/companies` (authenticated): active companies ordered by
  `sort_order, name` → `{ companies: [{ id, name, zohoEnabled }] }`.
- Admin CRUD: `POST /admin/companies`, `PATCH /admin/companies/:id`
  (name, zohoEnabled, isActive, sortOrder) + a simple **Companies** tab in the
  existing Admin page. Full IA reorg is sub-project E.
- `expenses.zohoEntity` column name is unchanged (no data migration); it stores
  the company **name**. All UI copy says **Company**.
- Auto-push rule: an expense whose company has `zohoEnabled: false` is NEVER
  auto-pushed — it always goes to the accountant queue (`isAutoPushEligible`
  gains a `companyZohoEnabled` input; unknown company names default to eligible
  to preserve current behavior for legacy values).

## 2. Receipt-first wizard (replaces ExpenseNew)

- **Step 1 — full-screen choice:** Scan receipt (native camera capture on
  mobile) · Upload receipt (camera roll / file) · Enter manually.
- Photo/upload path: create a draft expense immediately (placeholder merchant
  "Processing receipt…" is NOT used — the draft is created with empty-able
  fields via a new draft-friendly create), upload the receipt to it, run OCR,
  and show an editable **review card** prefilled with OCR merchant / amount /
  date. User corrects, then fills payment method → company (auto-filled from
  the card's `defaultZohoEntity`, editable) → category → notes (optional).
- Manual path: same form, no OCR card; receipt attachable later (existing
  behavior preserved).
- **Submit expense** = existing draft→submit endpoint (auto-approve + Zoho push
  when eligible; accountant queue otherwise). Post-submit screen states which
  happened ("Approved ✓" / "Submitted for review").
- Implementation note: the current `POST /expenses` requires merchant+amount+
  date. The wizard's photo path needs a draft before OCR returns; add
  `POST /expenses` support for `draft: true` with optional merchant/amount/date
  (defaults: merchant '', amount 0, date today) — submit validation still
  requires real values, so junk drafts can't be submitted.

## 3. Phone photo formats (HEIC/HEIF)

- Receipts upload accepts `image/heic`, `image/heif` (+ `.heic`/`.heif` ext)
  alongside jpeg/png/webp/pdf.
- API converts HEIC→JPEG at upload time via `heic-convert` (new API dependency;
  API Docker image rebuild on deploy). Stored file and `mimeType` are the
  converted JPEG; OCR and browsers only ever see JPEG.
- Unit test: conversion helper picks conversion for heic/heif mimetypes and
  passthrough otherwise (no binary fixture needed — decision logic only).

## 4. Mobile shell

- Below Tailwind `lg`: sidebar hidden; fixed **bottom nav** with Home ·
  **camera button** (centered, raised, `bg-brand-600`, white camera icon) ·
  My Expenses. Camera button links to the wizard with the scan option primed
  (`/expenses/new?mode=scan`).
- A **More** sheet (trigger at top-right of mobile header) exposes remaining
  nav for privileged roles (Captures, Review Queue, Reports, Partner Expenses,
  Admin, Payment Methods, logout). Employee primary nav stays 3 items.
- Desktop (`lg+`) keeps today's sidebar untouched.
- Density: My Expenses renders as stacked cards on mobile (merchant, amount,
  status badge, date) instead of the wide table; Dashboard stats stack
  (`grid-cols-1 sm:grid-cols-3` instead of fixed 3-col); page padding tightens
  (`p-4 lg:p-8`).

## 5. Upload queue → notification

- "To upload" leaves primary navigation (desktop sidebar + mobile nav).
- Global banner (Layout-level, both form factors) when queued/failed uploads
  exist: "N expense(s) couldn't finish uploading — Tap to retry." Tap retries
  the queue; the existing /to-upload page stays routable as the banner's
  "details" link only.

## 6. Action-first Home + status language

- Dashboard (employee view) reordered: **Action needed** block first (expenses
  awaiting your reply + failed uploads, each linking through), then "Under
  review" count, then "Approved". Lifetime totals demoted/removed.
- Employee-facing status mapping (StatusBadge `variant="user"`):
  `approved` + no `zohoExpenseId` → **Approved ✓**; `approved` + `zohoExpenseId`
  → **Accounting complete ✓**; `zoho_sync_failed` → **Approved ✓** (retry is
  accounting's concern). Accountant-facing variants unchanged.

## Testing

- API: companies route + admin CRUD covered by lint/typecheck; unit tests for
  the extended `isAutoPushEligible` (zohoEnabled=false → never eligible) and
  the HEIC conversion decision helper.
- Web: `npm run lint`; status-mapping helper unit-testable if extracted; visual
  pass on a phone is the acceptance gate for the shell/wizard.

## Out of scope (later roadmap items)

Accountant workspace (B), Zoho mapping decisions & sync history (C), lifecycle
edit rules & duplicate detection (D), admin IA reorg & user fields (E),
notifications (F), reimbursement views (G), file-storage/security (H),
extension rework, merchant normalization, server-side list pagination.
