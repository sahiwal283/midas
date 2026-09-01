# Midas API Contracts

All endpoints are at `/api/v1/`. Auth is httpOnly cookie JWT unless marked otherwise.

Error shape:
```json
{ "error": { "code": "SNAKE_CASE_CODE", "message": "Human-readable message" } }
```

---

## Auth

### POST /api/v1/auth/login

**Auth:** None  
**Rate limit:** 20 requests per 15 minutes

```json
// Request
{ "email": "string", "password": "string" }

// Response 200
{ "user": { "id": "uuid", "email": "string", "name": "string", "role": "user|accountant|admin" } }
// Sets httpOnly cookie "token" (8h TTL)
```

**Errors:** `401 INVALID_CREDENTIALS`

---

### POST /api/v1/auth/logout

**Auth:** None required (clears the cookie)

```json
// Response 200
{ "ok": true }
```

---

### GET /api/v1/auth/me

**Auth:** Required

```json
// Response 200
{ "user": { "id": "uuid", "email": "string", "name": "string", "role": "user|accountant|admin", "isActive": true } }
```

---

## Meta

### GET /api/v1/meta

**Auth:** None

```json
// Response 200
{
  "appName": "Midas",
  "version": "0.1.0-alpha",
  "environment": "development|production",
  "buildDate": "2026-05-08T00:00:00Z | null",
  "gitCommit": "abc1234 | null"
}
```

---

## Health

### GET /api/v1/health

**Auth:** None

```json
// Response 200
{ "ok": true }
```

---

## Expenses

All expense endpoints require authentication. Users see only their own expenses; accountants and admins see all.

### GET /api/v1/expenses

**Auth:** Required  
**Query params:** `status`, `categoryId`

```json
// Response 200
{
  "expenses": [{
    "id": "uuid",
    "merchant": "string",
    "amount": "decimal string",
    "currency": "USD",
    "date": "YYYY-MM-DD",
    "description": "string | null",
    "status": "draft|pending|in_review|awaiting_info|approved|zoho_sync_failed|rejected",
    "reimbursementStatus": "not_requested|pending|approved|paid",
    "reviewedById": "uuid | null",
    "reviewedAt": "ISO8601 | null",
    "reviewedBy": { "id": "uuid", "name": "string", "email": "string" } | null,
    "sourceApp": "browser_extension|argo|milo | null",
    "categoryId": "uuid | null",
    "paymentMethodId": "uuid | null",
    "zohoEntity": "string | null",
    "zohoExpenseId": "string | null",
    "createdAt": "ISO8601",
    "updatedAt": "ISO8601",
    "user": { "id": "uuid", "name": "string", "email": "string" },
    "category": { "id": "uuid", "name": "string" } | null,
    "paymentMethod": { "id": "uuid", "label": "string", "lastFour": "string | null", "brand": "string | null" } | null,
    "receipts": [{ "id": "uuid", "filename": "string", "mimeType": "string", "ocrStatus": "pending|processing|done|failed", "uploadedAt": "ISO8601" }]
  }]
}
```

---

### GET /api/v1/expenses/:id

**Auth:** Required (owner or accountant/admin)

Response: same expense shape as list, plus `messages` array (see Conversation section).  
`internalNote` on messages is `null` for regular users.

**Errors:** `404 NOT_FOUND`, `403 FORBIDDEN`

---

### POST /api/v1/expenses

**Auth:** Required

```json
// Request
{
  "merchant": "string (required)",
  "amount": "number > 0 (required)",
  "date": "YYYY-MM-DD (required)",
  "currency": "USD (default)",
  "categoryId": "uuid (optional)",
  "paymentMethodId": "uuid (optional)",
  "description": "string (optional)"
}

// Response 201
{ "expense": { ...expense } }
// Expense is created with status='draft'
```

**Errors:** `400 BAD_REQUEST` (validation)

---

### PATCH /api/v1/expenses/:id

**Auth:** Owner only; expense must be in `draft` status

All fields from POST are optional. Same response shape.

**Errors:** `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT` (not draft)

---

### POST /api/v1/expenses/:id/submit

**Auth:** Owner only; expense must be `draft`

```json
// Response 200
{ "expense": { ...expense, "status": "pending" } }
```

**Errors:** `409 CONFLICT` (not draft)

---

### DELETE /api/v1/expenses/:id

**Auth:** Owner only; expense must be `draft`

```json
// Response 200
{ "ok": true }
```

**Errors:** `409 CONFLICT` (not draft)

---

### GET /api/v1/expenses/categories/list

**Auth:** Required

```json
// Response 200
{ "categories": [{ "id": "uuid", "name": "string", "description": "string | null" }] }
// Only active categories, sorted alphabetically
```

---

## Receipts

### POST /api/v1/expenses/:expenseId/receipts

**Auth:** Owner  
**Content-Type:** `multipart/form-data`  
**Field name:** `file`  
**Limits:** 10 MB max; allowed types: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`  
**Sync-primary:** Waits for OCR before responding (see `docs/SYNC_AND_OFFLINE.md`).  
**Query:** `async=1` — optional escape hatch; returns immediately with `ocrStatus: pending`.

```json
// Response 201 (default sync path)
{
  "ocrMode": "sync",
  "receipt": {
    "id": "uuid",
    "filename": "string",
    "mimeType": "string",
    "sizeBytes": 0,
    "ocrStatus": "done|failed",
    "ocrText": "string | null",
    "ocrData": { "...OCR result..." },
    "ocrProvider": "string | null",
    "uploadedAt": "ISO8601"
  }
}
```

**Errors:** `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MIME`, `403 FORBIDDEN`

---

## Conversation (Messages)

### GET /api/v1/expenses/:expenseId/messages

**Auth:** Owner or accountant/admin

```json
// Response 200
{
  "messages": [{
    "id": "uuid",
    "expenseId": "uuid",
    "senderId": "uuid",
    "body": "string",
    "isSystem": false,
    "requestType": "info_request|missing_receipt|missing_category|missing_payment_method|general | null",
    "internalNote": "string | null",  // null for non-privileged users
    "isResolved": false,
    "resolvedAt": "ISO8601 | null",
    "resolvedById": "uuid | null",
    "createdAt": "ISO8601",
    "sender": { "id": "uuid", "name": "string", "role": "string" }
  }]
}
```

---

### POST /api/v1/expenses/:expenseId/messages

**Auth:** Owner or accountant/admin

```json
// Request
{ "body": "string (1–2000 chars)" }

// Response 201
{ "message": { ...message } }
```

**Side effect:** If the expense is `awaiting_info` and the sender is the owner, all open request messages are resolved and the expense status transitions to `in_review`.

---

## Accountant Workspace

All endpoints require `accountant` or `admin` role.

### GET /api/v1/accountant/queue

**Auth:** Accountant/Admin  
**Query params:** `status` (optional — filter to one status value)

Returns expenses in queue statuses: `pending`, `in_review`, `awaiting_info`, `zoho_sync_failed`, `approved`.

```json
// Response 200
{
  "expenses": [{
    ...expense,
    "flags": ["needs_category", "missing_receipt", "needs_payment_method", "needs_entity",
              "reimbursement_pending", "from_extension", "zoho_synced", "ready_for_zoho"],
    "zohoReady": false
  }]
}
```

**Flags reference:**

| Flag | Condition |
|------|-----------|
| `from_extension` | `sourceApp = 'browser_extension'` |
| `needs_category` | `categoryId` is null |
| `missing_receipt` | No receipts attached |
| `needs_payment_method` | `paymentMethodId` is null |
| `needs_entity` | `status = 'approved'` AND `zohoEntity` is null |
| `reimbursement_pending` | `reimbursementStatus = 'pending'` |
| `zoho_synced` | `zohoExpenseId` is set |
| `ready_for_zoho` | `approved` + entity + category + payment method + receipt + not synced |

---

### GET /api/v1/accountant/queue/summary

**Auth:** Accountant/Admin

```json
// Response 200
{
  "counts": {
    "pending": 0,
    "in_review": 0,
    "awaiting_info": 0,
    "zoho_sync_failed": 0,
    "approved": 0,
    "needs_category": 0,
    "missing_receipt": 0,
    "needs_payment_method": 0,
    "needs_entity": 0,
    "ready_for_zoho": 0,
    "reimbursement_pending": 0
  }
}
```

---

### GET /api/v1/accountant/expenses

**Auth:** Accountant/Admin

Returns all expenses (not filtered to queue statuses). Same shape as queue endpoint with flags.

---

### PATCH /api/v1/accountant/expenses/:id/review

**Auth:** Accountant/Admin

```json
// Request — approve
{ "action": "approve", "note": "string (optional)", "zohoEntity": "string (optional)" }

// Request — reject
{ "action": "reject", "note": "string (optional)" }

// Request — request_info
{
  "action": "request_info",
  "note": "string (required, shown to employee)",
  "requestType": "info_request|missing_receipt|missing_category|missing_payment_method|general (default: info_request)",
  "internalNote": "string (optional, accountant-only)"
}

// Response 200
{ "expense": { ...expense } }
```

**Status transitions:**

| Action | Result status |
|--------|---------------|
| `approve` | `approved` |
| `reject` | `rejected` |
| `request_info` | `awaiting_info` |

When `request_info` is used, a message is created with the `requestType` and `internalNote`. The employee sees `note` but not `internalNote`.

---

### POST /api/v1/accountant/expenses/:id/claim

**Auth:** Accountant/Admin

Atomically claims a `pending` expense for review. Uses a conditional update (`WHERE status = 'pending'`) so two accountants cannot claim simultaneously. Records `reviewedById` and `reviewedAt` on the expense row.

```json
// Response 200
{ "expense": { ...expense, "status": "in_review", "reviewedById": "uuid", "reviewedAt": "ISO8601", "reviewedBy": { "id": "uuid", "name": "string", "email": "string" } } }
```

**Errors:** `404 NOT_FOUND`, `409 CONFLICT` (expense is not `pending`)

**Audit event:** `review.claimed`

---

### POST /api/v1/accountant/expenses/:id/release-claim

**Auth:** Accountant/Admin — only the claiming reviewer or an admin can release

Atomically releases a claimed expense back to `pending`. Uses a conditional update (`WHERE status = 'in_review'`). Clears `reviewedById` and `reviewedAt`.

```json
// Response 200
{ "expense": { ...expense, "status": "pending", "reviewedById": null, "reviewedAt": null } }
```

**Errors:** `404 NOT_FOUND`, `403 FORBIDDEN` (another accountant's claim), `409 CONFLICT` (expense is not `in_review`)

**Audit event:** `review.released`

---

### POST /api/v1/accountant/expenses/:id/resolve-request

**Auth:** Accountant/Admin

Manually closes all open request messages. If expense is `awaiting_info`, transitions it back to `in_review`.

```json
// Response 200
{ "ok": true, "resolvedCount": 2 }
```

---

### PATCH /api/v1/accountant/expenses/:id/reimbursement

**Auth:** Accountant/Admin

```json
// Request
{ "status": "not_requested|pending|approved|paid", "note": "string (optional)" }

// Response 200
{ "expense": { ...expense } }
```

---

### PATCH /api/v1/accountant/expenses/:id/zoho-entity

**Auth:** Accountant/Admin

```json
// Request
{ "zohoEntity": "string (required)" }

// Response 200
{ "expense": { ...expense } }
```

---

### POST /api/v1/accountant/expenses/:id/zoho-push

**Auth:** Accountant/Admin

Pushes an expense to Zoho. Expense must be `approved` or `zoho_sync_failed`.

**Required before push:**
- `zohoEntity` must be set
- `categoryId` must be set
- `paymentMethodId` must be set

```json
// Response 200 (mock — Zoho mode is 'mock' in non-production)
{ "expense": { ...expense }, "zoho": { "zohoExpenseId": "Z-mock-xxx", "syncedAt": "ISO8601" } }

// Response 502
{ "error": { "code": "ZOHO_SYNC_FAILED", "message": "Zoho push failed — expense marked for retry." } }
```

**On failure:** expense status transitions to `zoho_sync_failed` and is visible in the Zoho Failed queue.

---

### GET /api/v1/expenses/:id/zoho-readiness

**Auth:** Accountant/Admin

Read-only server-side evaluation of whether an expense meets all Zoho push requirements. No Zoho write occurs.

```json
// Response 200
{
  "readiness": {
    "ready": false,
    "missing": ["receipt attachment", "accounting entity (zohoEntity)"],
    "warnings": ["Zoho is in mock mode — no live writes will occur"],
    "zohoMode": "mock",
    "checks": [
      { "label": "Approved", "pass": true },
      { "label": "Category set", "pass": true }
    ],
    "mappedPayload": null
  }
}

// When ready=true, mappedPayload contains the preview of what would be sent to Zoho
```

**Evaluated fields (11 total):** approved status, not already synced, merchant, amount > 0, date, submitter, category, payment method, zohoEntity, receipt attached, no unresolved requests.

---

## Payment Methods

### GET /api/v1/payment-methods

**Auth:** Required

```json
// Response 200
{
  "paymentMethods": [{
    "id": "uuid",
    "label": "Amex Corporate Card",
    "lastFour": "1234 | null",
    "brand": "visa|mastercard|amex|discover|debit|cash|other | null",
    "zohoAccountName": "Corporate AMEX | null",
    "isActive": true,
    "isCompanyWide": true,
    "assignedUserId": "uuid | null",
    "createdAt": "ISO8601",
    "updatedAt": "ISO8601"
  }]
}
```

**Visibility rules:**
- Admins: all active methods (active and inactive for admin panel GET at `/payment-methods` admin endpoint below)
- Accountants: all active methods
- Users: company-wide active methods only

---

### POST /api/v1/payment-methods

**Auth:** Admin only

```json
// Request
{
  "label": "string (required, max 100 chars)",
  "lastFour": "4 digit string (optional)",
  "brand": "visa|mastercard|amex|discover|debit|cash|other (optional)",
  "zohoAccountName": "string (optional)",
  "isCompanyWide": true,
  "assignedUserId": "uuid (optional)"
}

// Response 201
{ "paymentMethod": { ...paymentMethod } }
```

---

### PATCH /api/v1/payment-methods/:id

**Auth:** Admin only

All fields are optional. Supports `isActive: false` to deactivate.

```json
// Response 200
{ "paymentMethod": { ...paymentMethod } }
```

---

## Browser Extension

### GET /api/v1/extension/categories

**Auth:** Session cookie

Returns active expense categories for populating the extension form.

```json
// Response 200
{ "categories": [{ "id": "uuid", "name": "string", "description": "string | null" }] }
```

---

### POST /api/v1/extension/expenses

**Auth:** Session cookie (same user session as main Midas UI)

Atomically creates an expense + receipt + capture. Expense enters `pending` status immediately — never draft, never auto-approved.

```json
// Request
{
  "imageDataUrl": "data:image/jpeg;base64,... (required, max 10 MB)",
  "merchant": "string (required)",
  "amount": "number > 0 (required)",
  "date": "YYYY-MM-DD (required)",
  "currency": "USD (default)",
  "categoryId": "uuid (optional)",
  "description": "string (optional, max 2000)",
  "reimbursementRequired": false,
  "pageUrl": "string URL (optional)",
  "pageTitle": "string (optional)",
  "selectedText": "string (optional, max 5000)"
}

// Response 201
{
  "expense": { ...expense, "status": "pending", "sourceApp": "browser_extension" },
  "receipt": { ...receipt },
  "capture": { ...capture },
  "midasUrl": "http://<web>/expenses/<id>"
}
```

**Errors:** `400 INVALID_IMAGE`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MIME`, `400 INVALID_CATEGORY`

---

## App-to-App API (`/api/v1/ext/`)

**Auth:** Bearer API key in `Authorization: Bearer <key>` header (not session cookie).  
Keys are SHA-256 hashed in `app_connections` and issued by admin (`POST /api/v1/admin/connections`).

**Scopes** (required on the connection; missing → `403 MISSING_SCOPE`):  
`ocr:process`, `expenses:create`, `expenses:read`, `expenses:update`, `expenses:delete`, `receipts:create`, `expenses:import`

**Normative lock for Trade Show:** `docs/EXT_API_MERGE_LOCK.md`  
**Local sandbox setup:** `npm run ext:create-connection` in `apps/api` issues a scoped key.

Actor headers on mutating calls: `X-Actor-Email` / body `submitterEmail`, `X-Actor-External-User-Id`, optional `X-Actor-Name`.

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/ocr/process` | `ocr:process` | Sync OCR, no expense persist |
| `GET` | `/categories` | `expenses:read` | Active categories **scoped to the calling connection** (Settings → Connections → Categories). No allowlist rows = unrestricted. |
| `GET` | `/payment-methods` | `expenses:read` | Active, company-wide cards. `defaultCompany` (+ deprecated `defaultZohoEntity`) |
| `GET` | `/companies` | `expenses:read` | Active companies by `sortOrder`; `name` is the identifier. Includes `zohoEnabled:false` companies |
| `GET` | `/health/vocabulary` | `expenses:read` | Cutover self-check: counts of categories/payment methods/companies visible to this connection |
| `POST` | `/expenses` | `expenses:create` | Idempotent `(sourceApp,sourceRefId)`; default status `pending` |
| `GET` | `/expenses` | `expenses:read` | Filters: `sourceApp`, `eventId`, `externalUserId`, `q`, dates, cursor |
| `GET` | `/expenses/by-ref` | `expenses:read` | `?sourceApp=&sourceRefId=` |
| `GET` | `/expenses/:id` | `expenses:read` | Full DTO + `midasUrl` |
| `PATCH` | `/expenses/:id` | `expenses:update` | Only `draft\|pending\|awaiting_info` |
| `DELETE` | `/expenses/:id` | `expenses:delete` | `draft` or unreviewed `pending` without Zoho id |
| `POST` | `/expenses/:id/receipts` | `receipts:create` | Sync OCR; `?async=1` |
| `PUT` | `/expenses/:id/receipts/primary` | `expenses:update` | Replace primary receipt |
| `GET` | `/expenses/:id/receipts/:receiptId/content` | `expenses:read` | Byte stream |
| `POST` | `/expenses/import` | `expenses:import` | Bulk; `dryRun`; `skipOcr` on receipts |

**Identity is the username.** `users.email` is optional; `users.username` is the unique
identity key, so an IdP account with no email address can be onboarded. `POST /auth/login`
takes `{ identifier, password }` where identifier is a username *or* an email (`email` is
still accepted as an alias). On `/ext`, `submitterUsername` is preferred and
`submitterEmail` keeps working unchanged.

**Company (formerly "entity").** Expense payloads accept `company`; the older
`zohoEntity` is a deprecated alias that still works, and `company` wins when both
are sent. Responses return both. Applies to `POST /expenses`, `PATCH /expenses/:id`
and `POST /expenses/import`. The `expenses.zoho_entity` column is unchanged.

Env: `EXT_AUTO_PROVISION_USERS` (default `false`) auto-creates Midas users by email on Ext mutate.

Smoke: `MIDAS_API_KEY=… npm run ext:smoke --workspace=@midas/api`

---


## Admin

**All admin endpoints require `admin` role. Accountants and users receive 403.**

Local user management is temporary until Authentik SSO is connected. Local accounts may remain as break-glass logins after SSO is wired.

### GET /api/v1/admin/users

```json
// Response 200
{ "users": [{ "id": "uuid", "email": "string", "name": "string", "role": "user|accountant|admin", "isActive": true, "createdAt": "ISO8601", "updatedAt": "ISO8601" }] }
```

`passwordHash` is never returned.

---

### POST /api/v1/admin/users

```json
// Request
{ "name": "string (1-100)", "email": "string (valid email)", "role": "user|accountant|admin", "password": "string (min 8 chars)" }

// Response 201
{ "user": { "id": "uuid", "email": "string", "name": "string", "role": "string", "isActive": true, "createdAt": "ISO8601" } }
```

**Errors:** `400 BAD_REQUEST` (validation), `409 CONFLICT` (email already in use)  
**Audit event:** `admin.user.created`

---

### PATCH /api/v1/admin/users/:id

```json
// Request (all optional)
{ "name": "string", "role": "user|accountant|admin", "isActive": boolean }

// Response 200
{ "user": { "id": "uuid", "email": "string", "name": "string", "role": "string", "isActive": boolean } }
```

**Errors:** `400 SELF_DEACTIVATION` (admin cannot deactivate their own account), `404 NOT_FOUND`  
**Audit events:** `admin.user.deactivated`, `admin.user.reactivated`, `admin.user.updated`

---

### POST /api/v1/admin/users/:id/reset-password

Generates a secure temporary password, hashes it, and returns the plaintext **once**. Do not call this endpoint twice expecting the same password.

```json
// Response 200
{ "ok": true, "tempPassword": "string (16 chars)", "warning": "This temporary password is shown only once. Share it securely with the user." }
```

**Errors:** `404 NOT_FOUND`  
**Audit event:** `admin.user.password_reset`  
**Note:** Plaintext password is never stored and never logged.

---

## Error Codes Reference

| Code | HTTP | Meaning |
|------|------|---------|
| `INVALID_CREDENTIALS` | 401 | Email/password mismatch or inactive account |
| `UNAUTHORIZED` | 401 | No valid session cookie |
| `FORBIDDEN` | 403 | Valid session but insufficient permissions |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | State conflict (e.g., editing non-draft expense) |
| `MISSING_ZOHO_ENTITY` | 409 | Zoho entity required before push |
| `MISSING_CATEGORY` | 409 | Category required before Zoho push |
| `MISSING_PAYMENT_METHOD` | 409 | Payment method required before Zoho push |
| `INVALID_IMAGE` | 400 | imageDataUrl malformed |
| `INVALID_CATEGORY` | 400 | categoryId not found or inactive |
| `FILE_TOO_LARGE` | 413 | Upload exceeds 10 MB |
| `UNSUPPORTED_MIME` | 415 | File type not allowed |
| `ZOHO_SYNC_FAILED` | 502 | Zoho push failed (expense marked for retry) |
| `BAD_REQUEST` | 400 | Validation error — see message for details |

---

## Zoho integration-service endpoints (v0.1.4-alpha)

### GET `/api/v1/zoho/service-health`
Accountant/admin only. Read-only connectivity probe to the Zoho Integration Service. Never touches Zoho, never creates a record, never returns the app token.

```json
{
  "service": { "reachable": true, "ok": true, "baseUrl": "http://192.168.1.205:8000",
               "status": 200, "serviceVersion": "1.28.0", "detail": "ok" },
  "zohoMode": "mock", "dryRun": true, "liveWritesEnabled": false
}
```

### GET `/api/v1/expenses/:id/zoho-readiness` — added `servicePayload`
The readiness response now also includes `servicePayload`: the generic, event-agnostic payload Midas would propose to the integration service (preview only — no network call):

```json
{
  "idempotencyKey": "midas-expense-<id>",
  "expenseId": "...", "merchant": "...", "amount": "...", "currency": "USD", "date": "YYYY-MM-DD",
  "description": "...",
  "category": { "id": "...", "name": "...", "proposedZohoAccount": null },
  "paymentMethod": { "id": "...", "label": "...", "proposedPaidThroughAccount": "..." },
  "reimbursable": false,
  "submitter": { "userId": "..." },
  "brand": "haute_brands", "zohoEntity": "...|null",
  "receipt": { "count": 1 },
  "source": { "app": "midas", "type": null, "id": null, "url": null, "label": null }
}
```
`proposedZohoAccount` / `proposedPaidThroughAccount` are placeholders pending accounting's Chart-of-Accounts and paid-through mappings.
