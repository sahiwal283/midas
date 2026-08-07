# Zoho Integration

## Architecture

Midas **never** calls Zoho APIs directly. All Zoho communication goes through the shared **Zoho Integration Service** (CT 9503, `http://192.168.1.205:8000`), which handles OAuth and proxies to Zoho Books.

```
Midas API  →  Zoho Integration Service  →  Zoho Books
               (CT 9503, :8000)              (cloud)
```

Midas authenticates to the service with a per-app credential (`ZOHO_SERVICE_TOKEN`) sent as **`Authorization: Bearer <token>`**, and scopes the Zoho org with the **`X-Brand`** header. Do **not** put the app token in `X-Internal-Token` — that header is the service’s shared `INTERNAL_API_TOKEN` only; misuse yields `401 ZOHO_AUTH_INVALID` before Zoho OAuth runs. Midas stores **no** Zoho OAuth secrets — the service owns Zoho OAuth, org selection, and rate-limit behavior.

## Current Status (fixed 2026-08-03)

| Setting | Value |
|---------|-------|
| `ZOHO_MODE` | `service` (after Bearer fix) |
| `ZOHO_DRY_RUN` | `false` for live create_books |
| Live writes | Enabled once env flipped + Bearer client deployed |
| Service version | **1.34.1** (reachable; `/health` ok) |
| App auth to service | ✅ `Authorization: Bearer` + `X-Brand: haute_brands` |
| Service ↔ Zoho | ✅ `organizations/list` + `chartofaccounts/list` succeed with Bearer |
| Accountant push payload | Full `buildZohoServicePayload` (idempotency key, paid-through, source provenance) |

**Note:** An earlier Midas diagnosis treated `ZOHO_AUTH_INVALID` as Zoho OAuth failure. That was wrong — it was the inbound header bug (`X-Internal-Token` with the app secret). See [`docs/ZOHO_AUTH_BLOCKER.md`](./ZOHO_AUTH_BLOCKER.md) (corrected).

### Service contract

- **Auth:** `Authorization: Bearer <ZOHO_SERVICE_TOKEN>` (app credential). `X-Internal-Token` is **not** for Midas’s app token.
- **Brand scope:** `X-Brand: haute_brands`.
- **Endpoints:** `GET /health` (public — does not validate app token), `POST /zoho/expenses/create_books`, `POST /zoho/expenses/attach_receipt`, `/zoho/expenses/list_books`, `/zoho/organizations/list`, `/zoho/chartofaccounts/list`.
- **Error shape:** `{ "detail": { "error": { "source", "code", "internal_code", "message", "request_id" } } }`.
- **Codes:** `ZOHO_AUTH_INVALID` = inbound auth failed (wrong/missing token/header). `ZOHO_AUTH_FORBIDDEN` = brand/capability grant issue. Zoho OAuth problems look like `NO_CREDENTIALS`, `TOKEN_EXPIRED`, etc.

### Midas-side connectivity check

`GET /api/v1/zoho/service-health` (accountant/admin) returns the service `/health` result + current `zohoMode`/`dryRun`/`liveWritesEnabled`. This is the safe way to confirm Midas → service reachability without touching Zoho.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ZOHO_MODE` | `mock` or `service` | `mock` |
| `ZOHO_SERVICE_BASE_URL` | Base URL of Zoho Integration Service | — |
| `ZOHO_SERVICE_TOKEN` | App credential from service admin | — |
| `ZOHO_DEFAULT_BRAND` | Brand identifier for org selection | `haute_brands` |
| `ZOHO_DRY_RUN` | Skip real POST even in service mode | `true` |

## Zoho Integration Service Contract

**Authentication:**
```
Authorization: Bearer <ZOHO_SERVICE_TOKEN>
X-Brand: <ZOHO_DEFAULT_BRAND>
```

**Create expense in Zoho Books:**
```
POST /zoho/expenses/create_books
```

**Registered capabilities (Midas app):**
- `expenses.list_books`
- `expenses.get_books`
- `expenses.create_books`
- `expenses.attach_receipt`
- `chartofaccounts.list`
- `organizations.list`

**Zoho Books org:** Haute Brands, org_id `856048585`

## Readiness Model

Before any expense can be pushed to Zoho, Midas evaluates 11 required fields:

1. Approved status
2. Not already synced
3. Merchant name
4. Amount > 0
5. Expense date
6. Submitter (user)
7. Category
8. Payment method
9. Accounting entity (`zohoEntity`)
10. Receipt attached
11. No unresolved accountant requests

Accountants can view readiness at any time via:
```
GET /api/v1/expenses/:id/zoho-readiness
```
This endpoint is read-only and never triggers a Zoho write.

## Activating Live Writes (requires explicit approval)

1. Accounting approves the Zoho Books field mapping
2. Admin sets on CT 3120:
   ```
   ZOHO_MODE=service
   ZOHO_DRY_RUN=false
   ```
3. Rebuild API container: `docker compose up -d --build api`
4. Verify `GET /api/v1/expenses/:id/zoho-readiness` returns `zohoMode: "live"`
5. Test with a single approved expense using the Zoho push endpoint

## Field Mapping (Midas → Zoho Books)

| Midas field | Zoho Books field | Notes |
|-------------|-----------------|-------|
| `merchant` | vendor/payee | Required |
| `amount` | amount | Required, numeric |
| `currency` | currency | Default USD |
| `date` | date | YYYY-MM-DD |
| `description` | description | Optional |
| `zohoEntity` | accounting entity | Set by accountant |
| `category.name` | category | From Midas category |
| `paymentMethod.label` | payment method | From Midas payment method |

## Security

- `ZOHO_SERVICE_TOKEN` is a server-side secret. Never expose it to the browser or commit it.
- The token is stored in `/opt/midas/.env` on CT 3120. It is excluded from all git commits.
- Midas does not store Zoho OAuth tokens. The integration service owns those.
- The dry-run gate (`ZOHO_DRY_RUN=true`) is the default and must be explicitly overridden.

---

## Settled accounting policies (2026-08-07)

Canonical decisions for the previously open mapping questions (full rationale in
`docs/superpowers/specs/2026-08-07-zoho-pipeline-design.md`):

- **Record type:** Zoho Books expense records via `create_books`. No other record types.
- **Category → COA:** daily = live COA pick in the wizard (OCR suggestion preselects,
  user can change); Trade Show = Midas category → `expense_categories.zoho_account_id`.
- **Paid-through:** `payment_methods.zoho_account_name`, managed in Admin → Payment
  Methods. Missing mapping fails the push as `MAPPING_ERROR`.
- **Company assignment:** derived from the card's `defaultZohoEntity`, user-editable.
  Companies with `zoho_enabled = false` (Summitt Labs) never enter this pipeline.
- **Sync mode:** automatic on submit for complete staff-entered daily expenses;
  explicit accountant push for event expenses and anything incomplete.
- **Vendors:** Midas NEVER creates Zoho vendors. Merchant text is descriptive only.
  Vendor matching (exact → alias → flag → create-if-configured) is the Integration
  Service's contract.
- **Duplicates (Zoho side):** idempotency key per expense on every push.
- **OCR mismatches:** `ocr_needs_review` does not block auto-push (submitter confirmed
  the fields); accountants spot-check via the queue's "OCR needs review" filter.

## Sync errors & retry

- Failures are classified (`apps/api/src/lib/zohoErrors.ts`) into: `AUTH_ERROR`,
  `MAPPING_ERROR`, `VALIDATION_ERROR`, `RATE_LIMIT`, `NETWORK_ERROR`, `ZOHO_ERROR`,
  `DUPLICATE`, `UNKNOWN`.
- Transient classes (network, 429, 5xx) auto-retry twice (2s/5s backoff) inside the
  push; everything else goes straight to `zoho_sync_failed`.
- The last error is stored on `expenses.zoho_sync_error` as `[CATEGORY] message` and
  shown to accountants in the Zoho sync card (with Retry). Employees never see it.
