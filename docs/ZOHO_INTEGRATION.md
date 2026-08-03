# Zoho Integration

## Architecture

Midas **never** calls Zoho APIs directly. All Zoho communication goes through the shared **Zoho Integration Service** (CT 9503, `http://192.168.1.205:8000`), which handles OAuth and proxies to Zoho Books.

```
Midas API  →  Zoho Integration Service  →  Zoho Books
               (CT 9503, :8000)              (cloud)
```

Midas authenticates to the service with a per-app credential (`ZOHO_SERVICE_TOKEN`) sent in the **`X-Internal-Token`** header, and scopes the Zoho org with the **`X-Brand`** header. The service enforces brand-scoped permissions. Midas stores **no** Zoho OAuth secrets — the service owns Zoho OAuth, org selection, and rate-limit behavior.

## Current Status (v0.1.4-alpha, 2026-06-24)

| Setting | Value |
|---------|-------|
| `ZOHO_MODE` | `mock` (default — no service calls) |
| `ZOHO_DRY_RUN` | `true` |
| Live writes | **Disabled** |
| Service version | `zoho-integration-service` **1.28.0** (reachable; `/health` ok) |
| App auth to service | ✅ Midas token accepted (`X-Internal-Token`) |
| Service ↔ Zoho auth | ❌ **`ZOHO_AUTH_INVALID`** — service is **not currently authorized against Zoho** for the `haute_brands` org |
| Accounting approval | **Not yet obtained** |

No live Zoho expense will be created until: (1) the integration-service team establishes the Zoho OAuth connection for the brand/org (currently failing), (2) accounting approves the field mapping and open decisions, and (3) the operator sets `ZOHO_MODE=service` and `ZOHO_DRY_RUN=false`.

### Discovered service contract (2026-06-24)

- **Auth:** `X-Internal-Token: <app token>` (NOT `Authorization: Bearer`). Missing → `MISSING_TOKEN`; present-but-unauthorized-against-Zoho → `ZOHO_AUTH_INVALID`.
- **Brand scope:** `X-Brand: haute_brands`.
- **Endpoints observed:** `GET /health` (public), `POST /zoho/expenses/create_books`, `POST /zoho/expenses/attach_receipt`, `/zoho/expenses/list_books`, `/zoho/organizations/list`, `/zoho/chartofaccounts/list`, and a `/zoho/expenses/validate` path (exists but contract not exposed to the Midas app; `/openapi.json` is `403` for our app scope).
- **Error shape:** `{ "detail": { "error": { "source", "code", "internal_code", "message", "request_id" } } }` — `request_id` is returned and should be captured for support.
- **Dry-run validation:** a `validate` endpoint appears to exist, but its request/response contract is not visible to Midas and the service is not Zoho-authorized, so **no dry-run validation is wired in Midas**. Midas stays in local readiness-only mode. To enable it we need, from the service team: the documented `validate` contract (method, body, `dryRun` semantics, response incl. `request_id`) **and** a working Zoho OAuth connection for the org.

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
