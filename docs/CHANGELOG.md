# Changelog

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
