# Changelog

## 0.7.0-alpha (2026-08-06)

### Reports
- New **Reports** page (accountant/admin/developer): company-wide spend with preset filters (This/Last month, This/Last quarter, Q1–Q4, YTD) + custom date range + entity filter.
- KPI tiles (total, count, average, reimbursements pending), spend-over-time bar chart (weekly buckets for short ranges), category donut, entity and payment-method breakdowns, top-10 vendors and spenders.
- New `GET /api/v1/reports/summary` aggregate endpoint (SQL GROUP BYs, zero-filled periods); scope = all non-draft, non-rejected expenses.
- New web dependency: recharts.

## 0.6.0-alpha (2026-08-06)

### Daily expense auto-push
- Complete staff-entered daily expenses (entered in Midas or via the browser extension) **skip accountant approval**: on submit they are auto-approved (audit `auto_approved`) and pushed to Zoho immediately. Eligibility = all Zoho-required info present (entity, expense account, payment method with paid-through, amount, merchant, receipt, no open requests).
- Event expenses (Trade Show app, any ext-API source) and incomplete daily expenses still go to the accountant queue as before.
- Failed auto-pushes land in `zoho_sync_failed` for accountant retry. Reimbursable (personal-card) expenses auto-push too but stay in the Reimbursement lane until paid.
- Refactor: shared `lib/zohoPush.ts` used by both accountant push and auto-push.

## 0.5.1-alpha (2026-08-06)

### SSO
- **Fixed**: Authentik login no longer overwrites the user's Midas role on every login. Midas is the source of truth for roles (Admin → Users); Authentik groups only gate app access and set the initial role for auto-created users. Previously, roles assigned in Midas (e.g. developer/partner) were silently reset to the Authentik group mapping at next SSO login.

## 0.5.0-alpha (2026-08-06)

### Admin user management
- **Hard delete users**: instant for users with no data; users owning data get a 409 with per-type counts, and the UI offers an explicit **purge** (removes their expenses + receipt files, messages, captures, partner expenses). Zoho-synced expenses block purge (`ZOHO_LINKED`). Guards: no self-delete, never the last active admin. All deletions audit-logged (`admin.user.deleted` / `admin.user.purged`).
- **Role assignment**: role is editable per user (all five roles incl. partner/developer) from Admin → Users; API blocks self-role-change and demoting the last active admin.

## 0.4.0-alpha (2026-08-06)

### Partner Expenses (new)
- New **partner** role with a standalone partner expense tracker (`/partner-expenses`): shared table of User · Amount · Item/Location · Category, plus a simple intake form (Business/Personal, defaults Business). Fully decoupled from the normal expense flow — no receipts, review queue, reimbursement, or Zoho.
- New **developer** role: all-access, passes every role gate (API `requireRole` + web `ProtectedRoute`/nav).
- New `partner_expenses` table + `partner_expense_category` enum (migrations `0008`, `0009`); audit-logged creates.
- Seed users: `partner@midas.local` / `partner123`, `developer@midas.local` / `developer123`.

## 0.3.9-alpha (2026-08-03)

### Zoho expense accounts (daily expenses)
- New Expense: pick **brand/entity** first, then **expense account** from live Zoho COA (`GET /zoho/expense-accounts?zohoEntity=`).
- Stores `zoho_expense_account_id` / `name` on the expense — no local category maintenance for daily use.
- Trade Show can still use Midas `categoryId` + static `zoho_account_id` maps.

## 0.3.8-alpha (2026-08-03)

### Zoho
- **Fixed** Integration Service auth: send `Authorization: Bearer <ZOHO_SERVICE_TOKEN>` (not `X-Internal-Token`). Wrong header caused `401 ZOHO_AUTH_INVALID` before Zoho OAuth. Live `organizations/list` / COA confirmed with Bearer.
- Live create_books: send `account_id` + `paid_through_account_id`; parse nested `data.expense.expense_id`; strip nested `source` (Zoho Books field, 100-char limit).
- Categories: `zoho_account_id` + Haute Brands COA seed; Personal card → Employee Reimbursements paid-through.
- CT 3120: `ZOHO_MODE=service`, `ZOHO_DRY_RUN=false`. Smoke push succeeded (PORT of SD → Zoho expense id recorded).

## 0.3.7-alpha (2026-08-03)

### Zoho
- Accountant push sends full `buildZohoServicePayload`; service-health probes Zoho auth; queue button labels follow live/mock/dry-run/blocked.

## 0.3.6-alpha (2026-08-03)

### Accountant
- Removed **Claim / Release** (single-accountant workflow). Approve/Reject/Needs review work on pending directly.
- User reply / resolve-request returns expenses to `pending` (not `in_review`). Existing `in_review` rows migrated to `pending`.

## 0.3.5-alpha (2026-08-03)

### Accountant workflow / statuses
- Approval labels: **Pending approval**, **Approved**, **Rejected**, **Needs further review** (maps `pending`/`in_review` / `approved` / `rejected` / `awaiting_info`).
- Zoho shown separately: **Not pushed** | **Pushed** (`ZohoPushBadge`) — not mixed into approval status.
- Review Queue: **Approve / Reject / Needs review** available on pending expenses (no mandatory “Mark as Reviewing” first). Optional Claim/Release kept.
- Quick-view modal: accountant approve/reject/needs-further-review + reimbursement dropdown.

### Reimbursement (personal cards)
- `payment_methods.requires_reimbursement`; Personal (Need reimbursement) flagged.
- Auto-set `reimbursement_status=pending` when personal card is used; backfill existing personal-card rows.
- Reimbursement labels: Needs reimbursement → Approved (pending payment) → Paid.

## 0.3.4-alpha (2026-08-03)

### Payment methods (Trade Show parity)
- Synced all **12** Trade Show `cardOptions` into Midas `payment_methods` (label, last4, entity, Zoho paid-through id).
- New column `payment_methods.default_zoho_entity`; UI Admin Payment Methods shows Entity.
- Backfilled `payment_method_id` (+ `zohoEntity` when blank) on migrated `trade_show` expenses via `cardUsed` last-4.
- Ext: `GET /api/v1/ext/payment-methods` (`expenses:read`). Handoff: `docs/TRADE_SHOW_PAYMENT_METHODS.md`.

## 0.3.3-alpha (2026-08-03)

### UI
- **Receipt quick view**: paperclip pill opens a Trade Show–style modal with **inline receipt image/PDF** (not a navigate-away detail page). Also used on Accountant Queue.
- **Expense detail**: receipt files render inline; **Delete** available when permitted.
- **My Expenses**: row checkboxes, bulk delete, source-app filter (e.g. `trade_show`) for cleaning test imports.

### API
- `GET /expenses/:expenseId/receipts/:receiptId/content` — session-auth receipt stream for UI preview.
- Expanded `DELETE /expenses/:id` — owner draft/unreviewed pending; accountant/admin any without Zoho; admin `?force=true` for Zoho-linked.
- `POST /expenses/bulk-delete` — `{ ids, force? }` with per-id results.

## 0.3.2-alpha (2026-08-03)

### UI
- **My Expenses**: status tabs (All / Needs reply / Under review / Approved / Rejected / Drafts), search, month + category filters, and 10-per-page pagination (Trade Show–style).

## 0.3.1-alpha (2026-08-03)

### UI
- Expense tables (**My Expenses**, **Accountant Queue**): Trade Show–style paperclip **Receipt** pill (`N receipt` / `No receipt`) linking to expense detail `#receipts`.

## 0.3.0-alpha (2026-08-03)

### Ext API — Trade Show Expense Engine
- Full `/api/v1/ext/*` surface: OCR process, expenses CRUD/list/by-ref, receipts (+ content), categories, bulk import with `skipOcr` / Zoho ids / timestamps / idempotent re-import.
- Scope enforcement (`requireScope` → `MISSING_SCOPE`), `source_context` / `externalUserId`, reimbursement `rejected`, Trade Show category seed + mappings.
- Packages: `@midas/ocr-client`, `@midas/import`; migration SQL `0002_ext_trade_show_merge.sql`.
- Sandbox: CT 3120 Ext live; Trade Show CT 2600 migrated **375** expenses zero-loss (M3/M8 closed).

### OCR
- Invalid/tiny PDFs return **`400 OCR_INVALID_FILE`** (not `500 INTERNAL_ERROR`); upstream OCR failures map to `OCR_*` 502/503/504.
- Ext OCR echoes `X-Request-Id` / `requestId` for BFF correlation.
- ImageMagick prep prefers `magick` over legacy `convert`.

### Zoho / expenses UX
- Accountant **Zoho readiness** panel (read-only evaluation; no live Zoho write).
- New expense flow requires receipt capture (stacked from 0.2 line).

### Docs / ops
- Dual-app contract lock, migration reply/apply-go, OCR invalid-fix handoff, Authentik/Zoho/import docs.

## 0.2.0-alpha (2026-06-30)

### Intermediate line (pre-Ext merge)
- Version string advanced for Zoho readiness / receipt-required work; package.json versions were partially updated to `0.2.0` without a full changelog. Superseded by **0.3.0-alpha**, which is the first consistent cut including Ext + migration.

## 0.1.5-alpha (2026-06-25)

### UX clarity (copy/badges only — no behavior change)
- **Dashboard status labels deduped**: removed the duplicate `USER_STATUS_LABEL` map in `Dashboard.tsx` and now import the single source of truth `USER_LABELS` from `StatusBadge.tsx` (fixes "In review"/"Under review" drift; employee-facing labels stay plain-language).
- **Admin user source badge**: `/admin/users` now returns safe booleans `hasPassword` / `hasSso` (derived; the password hash and SSO subject IDs are NOT exposed), and the Admin Users table shows an **"SSO-only / Local / SSO + Local"** badge so admins know how each user signs in (and that a password reset on an SSO-only user creates a local credential).
- **Softer employee-facing OCR wording**: employees now see "Receipt scan complete / in progress / needs review / pending" instead of `OCR: <status>`. Accountant/admin keep the technical `OCR: <status>` + provider/confidence/error detail (unchanged, still role-gated). No OCR mode/behavior change.
- No Zoho/OCR/auth/schema changes. Zoho remains `mock` + dry-run; OCR remains `mock`.

## 0.1.4-alpha (2026-06-24)

### Zoho — integration-service prep (still mock/dry-run; NO live writes)
- **Fixed** `ServiceZohoAdapter` auth: the integration service (v1.28.0) authenticates apps with the **`X-Internal-Token`** header, not `Authorization: Bearer`. The previous Bearer header would have failed app auth on the first service-mode attempt. Brand scoping (`X-Brand`) unchanged.
- Added request **timeouts** (AbortController) to all service calls and hardened error handling so the app token is **never** included in logs or thrown errors.
- Added `checkServiceHealth()` client probe + read-only **`GET /api/v1/zoho/service-health`** (accountant/admin) — reports service reachability/version and current `zohoMode`/`dryRun`/`liveWritesEnabled`. Safe in any mode (only hits the service's public `/health`; never touches Zoho).
- Added `buildZohoServicePayload()` — a **generic, event-agnostic** proposed payload (no `event_id`, works for any `source_app`): idempotency key (`midas-expense-<id>`), category/payment-method with proposed-account placeholders, reimbursable flag, submitter, brand, receipt count, and `source.{app,type,id,url,label}`. Surfaced as `servicePayload` in the readiness response (preview only).
- Tests: client uses `X-Internal-Token` (not Bearer), token redaction on failure, health parse/unreachable handling, payload mapping + idempotency, mock-mode makes no service call.
- **Discovered blocker:** the integration service is **not currently authorized against Zoho** — every Zoho data endpoint returns `ZOHO_AUTH_INVALID`. Live/dry-run-against-real-Zoho cannot proceed until the service team establishes the Zoho OAuth connection for the `haute_brands` org. Midas remains in local readiness-only mode; no dry-run validation endpoint was wired (its contract is not exposed to the Midas app). See `docs/ZOHO_INTEGRATION.md`.

## 0.1.3-alpha (2026-06-24)

### Auth / SSO — fix: Authentik SSO restored
- **Fixed** `unexpected "iss" claim value` token-exchange failure that blocked all Authentik SSO logins.
- Root cause: the Authentik provider advertises a **global/root issuer** (`https://auth.booute.duckdns.org/`) in its discovery document and ID tokens, but Midas was validating the `iss` claim against the per-application env value `AUTHENTIK_ISSUER_URL` (`.../application/o/midas/`).
- `validateIdToken` now validates `iss` against **`discovery.issuer`** (the IdP's authoritative, signed-metadata issuer) instead of the hand-configured env value. Midas is now immune to Authentik issuer-mode drift (global vs. per-application).
- `AUTHENTIK_ISSUER_URL` is retained as a discovery-URL fallback only; it is no longer used for `iss` validation.
- Group-to-role mapping, auto-provisioning, break-glass, and CORS/cookie behavior unchanged.
- Added `validateIdToken` regression tests: accepts tokens matching the discovery issuer (even when the env `issuerUrl` differs), rejects forged issuers, and rejects nonce mismatches.

---

## 0.1.2-alpha (2026-05-21)

### Auth / SSO
- Authentik group-to-role mapping now accepts **both** suite-standard (`app-midas-*`) and legacy (`midas-*`) group names simultaneously
- `AUTHENTIK_GROUP_ADMIN`, `AUTHENTIK_GROUP_ACCOUNTANT`, `AUTHENTIK_GROUP_USER` now accept comma-separated lists; defaults cover both naming schemes
- Precedence unchanged: admin > accountant > user; any approved group in either scheme grants access
- No Authentik group changes required — both naming schemes work until migration is complete

### Testing
- `oidcAuth.test.ts` updated: `mapGroupsToRole` now tests both `app-midas-*` and `midas-*` groups, cross-scheme precedence, mixed-group scenarios, and custom array overrides

---

## 0.1.1-alpha (2026-05-21)

### Integration
- Zoho Integration Service onboarding groundwork (dry-run/safe mode only)
- Midas app identity registered on Zoho Integration Service (CT 9503); credential wired to CT 3120
- `ZOHO_SERVICE_BASE_URL`, `ZOHO_DEFAULT_BRAND`, `ZOHO_DRY_RUN` env vars added
- `ServiceZohoAdapter` corrected: proper auth headers, correct route (`/zoho/expenses/create_books`), dry-run gate
- Zoho readiness model: `evaluateZohoReadiness()` evaluates all 11 required fields server-side
- New API endpoint: `GET /api/v1/expenses/:id/zoho-readiness` (accountant/admin only, read-only)
- Zoho readiness panel in expense detail calls server-side evaluation; shows checklist, missing fields, payload preview
- No live Zoho writes. `ZOHO_MODE=mock` and `ZOHO_DRY_RUN=true` are enforced defaults

### Auth / SSO
- Authentik OIDC SSO enabled and validated on CT 3120
- Auto-provisioning via `AUTHENTIK_AUTO_CREATE_USERS=true`: users auto-created on first SSO login when in an approved Midas group
- SSO-only users have `passwordHash=null`; local login guard blocks them from the password endpoint
- Audit events: `sso.login_success`, `sso.user_auto_created`, `sso.user_linked_by_email`, `sso.login_denied_*`
- Local break-glass login remains (`ALLOW_LOCAL_BREAK_GLASS=true`)

### Branding
- Midas SVG logo added (`/logo.svg`, `MidasLogo` React component)
- Logo in: browser favicon, web manifest, login page, sidebar header
- No external CDN or font dependency

### Infrastructure
- `ZOHO_SERVICE_TOKEN` deployed to CT 3120 via secure Proxmox-mediated handoff (no token printed)
- `ZOHO_MODE=mock` default enforced; dry-run gate guards `ServiceZohoAdapter`

### Testing
- 127 API unit tests pass
- New: `zohoReadiness.test.ts` — 18 tests covering ready state, missing fields, warnings, payload mapping, version string

### Docs
- `docs/ZOHO_INTEGRATION.md` added (integration contract, safety model, activation path)
- `docs/VERSIONING.md`, `docs/OPERATIONS.md`, `docs/API_CONTRACTS.md` updated
- `docs/CHANGELOG.md` created

---

## 0.1.0-alpha (2026-05-08)

Initial Midas scaffold deployed to Proxmox CT 3120.

- Expense CRUD, accountant review queue, receipt uploads, OCR mock
- Zoho mock adapter (no live writes)
- In-app conversation, audit logs
- Browser extension captures
- Admin user management, payment methods
- Authentik OIDC integration scaffolded (enabled in 0.1.1-alpha)
- Postgres on CT 3220, Docker Compose deployment
