# Employee Mobile-First Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receipt-first expense wizard, companies backbone (incl. a no-Zoho company), HEIC support, mobile bottom-nav shell, upload-queue notification, action-first dashboard, clearer employee statuses.

**Architecture:** Phased 1→6, one commit per phase, all on `feature/employee-mobile-capture`. New `companies` table drives the Company dropdown and the never-auto-push rule for Zoho-less companies. The wizard reuses the existing draft→upload→OCR→submit endpoints (adds `draft: true` create). Mobile shell is CSS-breakpoint-driven (`lg`): sidebar hidden below, fixed bottom nav + More sheet shown.

**Tech Stack:** Drizzle + hand-written migration 0010, `heic-convert`, React + Tailwind breakpoints.

**Spec:** `docs/superpowers/specs/2026-08-07-employee-mobile-capture-design.md`

## Global Constraints

- All UI copy: **Company** (never "entity"/"brand"). DB column `expenses.zoho_entity` unchanged; it stores the company NAME.
- Companies seed: `Haute Brands` (zoho on), `Nirvana Kulture` (zoho on), `Boute` (zoho on), `Haute Collective` (**zoho off**) — CONFIRM real names against prod `GET /zoho/entities` + user's no-Zoho company at execution time; seed is idempotent by name.
- `isAutoPushEligible` new signature: `{ sourceApp, ready, companyZohoEnabled }` where `companyZohoEnabled?: boolean` — `false` → never eligible; `undefined`/`true` → existing behavior.
- HEIC/HEIF converted server-side to JPEG before storage; stored mimeType is `image/jpeg`.
- Employee status labels: approved+zohoId → "Accounting complete", approved/zoho_sync_failed without → "Approved". Accountant labels unchanged.
- Deploy: API needs Docker REBUILD (new dep) — `docker compose up -d --no-deps --build api`; web needs prod rebuild as usual.
- Suite has 2 pre-existing failures (`zohoReadiness`, `mapOcrError`).

---

### Phase 1: Companies backbone (API)

**Files:**
- Modify: `apps/api/src/db/schema.ts` (companies table, after Payment Methods section)
- Create: `apps/api/drizzle/0010_companies.sql`
- Modify: `apps/api/src/db/seed.ts` (seed 4 companies, idempotent by name)
- Create: `apps/api/src/routes/companies.ts` (GET list, authenticated)
- Modify: `apps/api/src/routes/admin.ts` (companies CRUD: POST/PATCH `/admin/companies`, GET `/admin/companies` incl. inactive)
- Modify: `apps/api/src/server.ts` (mount `/api/v1/companies`)
- Modify: `apps/api/src/lib/autoApprove.ts` + `apps/api/src/__tests__/autoApprove.test.ts`
- Modify: `apps/api/src/routes/expenses.ts` submit handler (look up company by `expense.zohoEntity` name, pass `companyZohoEnabled`)

**Schema:**

```ts
// ── Companies ─────────────────────────────────────────────────────────────────
// The sister companies Midas serves. expenses.zoho_entity stores the company
// NAME. zoho_enabled=false companies never enter the Zoho pipeline.

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').unique().notNull(),
  zohoEnabled: boolean('zoho_enabled').default(true).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

Migration `0010_companies.sql` (house style, IF NOT EXISTS guards):

```sql
-- Sister-company registry. expenses.zoho_entity stores the company name.
-- zoho_enabled = false companies never enter the Zoho pipeline.
CREATE TABLE IF NOT EXISTS "companies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL UNIQUE,
  "zoho_enabled" boolean DEFAULT true NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
```

**autoApprove:**

```ts
const AUTO_PUSH_SOURCES = new Set<string | null>([null, 'browser_extension']);

export function isAutoPushEligible(i: {
  sourceApp: string | null;
  ready: boolean;
  /** false = company opted out of Zoho → always accountant queue. */
  companyZohoEnabled?: boolean;
}): boolean {
  if (i.companyZohoEnabled === false) return false;
  return AUTO_PUSH_SOURCES.has(i.sourceApp) && i.ready;
}
```

New tests (append): `companyZohoEnabled: false` → false even when ready+null-source; `true`/`undefined` → unchanged behavior.

**Submit handler:** after loading the expense, look up `db.query.companies.findFirst({ where: eq(companies.name, expense.zohoEntity ?? '') })` (skip when no zohoEntity) and pass `companyZohoEnabled: company?.zohoEnabled` into `isAutoPushEligible`.

**Routes:** `GET /api/v1/companies` (authenticate only) → active companies ordered by sortOrder, name → `{ companies: [{ id, name, zohoEnabled }] }`. Admin: `GET /admin/companies` (all), `POST /admin/companies {name, zohoEnabled?, sortOrder?}` (409 on duplicate name), `PATCH /admin/companies/:id {name?, zohoEnabled?, isActive?, sortOrder?}`; audit `admin.company.created/updated`.

**Seed** (after users): for each of the 4 seed companies, insert if name missing (console log like users).

- [ ] Steps: failing autoApprove tests → implement all → `npm run test` (new tests pass, no new failures) → `npm run lint` → commit `feat(api): companies backbone with per-company Zoho enablement`.

---

### Phase 2: HEIC/HEIF support (API)

**Files:**
- Modify: `apps/api/package.json` (add `heic-convert@^2.1.0`; run `npm install` in workspace root)
- Create: `apps/api/src/lib/receiptImage.ts`
- Test: `apps/api/src/__tests__/receiptImage.test.ts`
- Modify: `apps/api/src/routes/receipts.ts` (ALLOWED_MIME + convert before `storage.save`)

**Lib:**

```ts
/** HEIC/HEIF (iPhone photos) are converted to JPEG at upload time so OCR and
 *  browsers only ever deal with JPEG. */

export function needsHeicConversion(mimeType: string, filename: string): boolean {
  const mt = mimeType.toLowerCase();
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return mt === 'image/heic' || mt === 'image/heif' || ext === 'heic' || ext === 'heif';
}

export function convertedName(filename: string): string {
  return filename.replace(/\.(heic|heif)$/i, '') + '.jpg';
}

export async function toJpegIfHeic(buffer: Buffer, mimeType: string, filename: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  if (!needsHeicConversion(mimeType, filename)) return { buffer, mimeType, filename };
  const convert = (await import('heic-convert')).default;
  const out = await convert({ buffer, format: 'JPEG', quality: 0.9 });
  return { buffer: Buffer.from(out), mimeType: 'image/jpeg', filename: convertedName(filename) };
}
```

Tests: `needsHeicConversion` matrix (heic/heif mime, .heic/.HEIF ext, jpeg false), `convertedName('IMG_1.HEIC') === 'IMG_1.jpg'` (no binary fixtures).

**Route:** add `image/heic`, `image/heif` to ALLOWED_MIME + `heic`/`heif` ext to the filter error message; before `storage.save`, run `toJpegIfHeic(req.file.buffer, req.file.mimetype, req.file.originalname)` and use its outputs (incl. `mimeType` for the receipts row). `heic-convert` has no bundled types → add `apps/api/src/types/heic-convert.d.ts` with `declare module 'heic-convert';`.

- [ ] Steps: failing tests → implement → tests pass → lint → commit `feat(api): accept and convert HEIC/HEIF receipt photos`.

---

### Phase 3: Web companies plumbing + Admin tab

**Files:**
- Create: `apps/web/src/api/companies.ts` — `companyApi.list()` (`GET /companies`), `companyApi.adminList/create/update` (`/admin/companies`).
- Modify: `packages/shared/src/types/index.ts` + `apps/web/src/types/index.ts` — `Company { id, name, zohoEnabled, isActive?, sortOrder? }`.
- Modify: `apps/web/src/pages/Admin.tsx` — add **Companies** tab (list: name, Zoho on/off toggle, active toggle; add-company row). Follows the Categories tab's existing style.

- [ ] Steps: implement → web `npm run lint` → commit `feat(web): companies admin tab and api`.

---

### Phase 4: Receipt-first wizard

**Files:**
- Modify: `apps/api/src/routes/expenses.ts` — `createExpenseSchema` gains `draft: z.boolean().optional()`; when `draft: true`, `merchant`/`amount`/`date` become optional (defaults `''`/`0`/today). Submit already re-validates: add explicit check in submit — merchant non-empty, amount > 0 required, else 409 `INCOMPLETE_DRAFT`.
- Rewrite: `apps/web/src/pages/ExpenseNew.tsx` as the wizard.
- Modify: `apps/web/src/api/expenses.ts` — `create` accepts the draft flag + optional fields; expose `uploadReceipt` return type (receipt incl. `ocrStatus`, `ocrData`).

**Wizard behavior (constraints, not prescriptive JSX):**
- Step 1 full-screen three-option chooser (Scan — `capture="environment"` input; Upload — file input `accept="image/*,.pdf,.heic,.heif"`; Enter manually). `?mode=scan` query param auto-opens the camera input on mount (used by the mobile nav camera button).
- Photo/upload: create draft (`draft: true`) → upload receipt → response's `ocrData.fields` (merchant/amount/date `FieldValue.value`s, optional-chained — shape from `packages/ocr-client/src/types.ts` FieldInference) prefills an editable "Check what we read" card. OCR failure/absence degrades to empty editable fields with a subtle note, never an error wall.
- Then: Payment method (from `expenseApi.paymentMethods()`), **Company** select (from `companyApi.list()`, auto-set from selected card's `defaultZohoEntity` when it matches a company name, editable), Expense category (Zoho COA select when the company is zohoEnabled — existing `zohoExpenseAccounts(entity)` — hidden for no-Zoho companies), Notes (optional textarea).
- Submit button = PATCH the draft with final fields then `POST /expenses/:id/submit`; success screen distinguishes `autoPushed`/approved vs pending review ("Approved ✓ — sent to accounting" vs "Submitted for review"). Add `submit` fn to `expenseApi` if missing.
- Manual path: same form without the OCR card; receipt optional at creation (existing submit readiness rules route incomplete → accountant/pending as today; keep the existing receipt-required-before-submit UX by prompting to attach on the review screen — reuse current upload widgets).
- Offline path preserved: reuse `enqueueUpload`/`isLikelyOfflineOrNetworkError` exactly as the current page does.
- Mobile-first layout: single column, big touch targets (`py-3`), sticky bottom Submit on small screens; desktop centers a `max-w-xl` card.

- [ ] Steps: API draft flag + lint/test → wizard page → web lint → commit `feat: receipt-first expense wizard`.

---

### Phase 5: Mobile shell + upload banner

**Files:**
- Create: `apps/web/src/components/MobileNav.tsx` — fixed bottom bar (`lg:hidden`): Home (`/dashboard`), centered raised camera button (`/expenses/new?mode=scan`, `h-14 w-14 rounded-full bg-brand-600 text-white -mt-5 shadow-lg`), My Expenses (`/expenses`); a **More** button (only when the user's role has extra nav) opening a bottom sheet listing the remaining links per role (same role logic as Sidebar) + Logout.
- Create: `apps/web/src/components/UploadRetryBanner.tsx` — shows when `getUploadQueueCount() > 0` (reuse the existing `upload-queue-count` query): "N expense(s) couldn't finish uploading — Tap to retry" (button triggers the queue retry — reuse the retry logic from `ToUpload.tsx` (read it first; extract shared helper into `lib/uploadQueue.ts` if it lives in the page) + a small "Details" link to `/to-upload`).
- Modify: `apps/web/src/components/Layout.tsx` — sidebar wrapped `hidden lg:flex` (adjust Sidebar root classes), `<UploadRetryBanner />` above Outlet, `<MobileNav />` fixed bottom, main gets `pb-20 lg:pb-0`.
- Modify: `apps/web/src/components/Sidebar.tsx` — remove the "To upload" NavLink (page stays routable).
- Density: `apps/web/src/pages/Dashboard.tsx` stats grid → `grid-cols-1 gap-3 sm:grid-cols-3`; page paddings on Dashboard/ExpenseList/ExpenseNew → `p-4 lg:p-8`; `apps/web/src/pages/ExpenseList.tsx` — table wrapped `hidden md:block`, plus a `md:hidden` stacked card list (merchant, amount, StatusBadge, date, tap → detail) rendered from the same `pageRows`.

- [ ] Steps: implement → web lint → commit `feat(web): mobile bottom nav, upload retry banner, mobile density`.

---

### Phase 6: Status language + action-first dashboard

**Files:**
- Modify: `apps/web/src/components/StatusBadge.tsx` — `StatusBadge` accepts optional `zohoExpenseId?: string | null`; when `variant='user'`: approved/zoho_sync_failed → `zohoExpenseId ? 'Accounting complete' : 'Approved'` (style stays green). Export helper `userStatusLabel(status, zohoExpenseId)` for Dashboard/lists.
- Modify: `apps/web/src/pages/Dashboard.tsx` — order: Action needed block (existing awaiting_info callout — keep) → **remove "Total Expenses" stat** → two stats (Under review, Approved) + Recent list uses `userStatusLabel`; upload-failure count folds into the Action block when > 0 (link to retry banner behavior).
- Modify: `apps/web/src/pages/ExpenseList.tsx`, `ExpenseQuickViewModal.tsx` (if it shows user labels), pass `zohoExpenseId` to user-variant badges. Grep `variant="user"` for all call sites.

- [ ] Steps: implement → web lint → commit `feat(web): action-first dashboard and clearer employee statuses`.

---

### Phase 7: Verify, version, ship

- [ ] Root `npm run lint` → 0 errors; API `npm run test` → only 2 pre-existing failures.
- [ ] Bump → **0.9.0-alpha** (3 package.json + version.ts) + CHANGELOG; commit; merge to main; push.
- [ ] Deploy: tarball changed files incl. `apps/api/package.json` + `package-lock.json`; **API container REBUILD** (`docker compose up -d --no-deps --build api` — new heic-convert dep), wait healthy, then web prod rebuild; verify meta 0.9.0-alpha, web 200, `GET /api/v1/companies` as partner (200 with 4 companies), HEIC gate: upload rejection lists heic as allowed.
- [ ] Confirm seed ran for companies (restart triggers seed? seed runs via migrator/startup — run `docker compose run --rm migrator` if needed).
- [ ] Report; user does the phone visual pass (acceptance gate).
