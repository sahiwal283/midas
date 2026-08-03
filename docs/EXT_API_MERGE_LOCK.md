# Ext API Merge Lock (Trade Show ↔ Midas)

**Status:** LOCKED — alignment COMPLETE; Midas Required surface **implemented** (see `docs/TRADE_SHOW_AGENT_HANDOVER.md`)  
**Base:** `/api/v1/ext`  
**Auth:** `Authorization: Bearer <app_connection_key>` + scopes (§ Auth)  
**Errors:** `{ "error": { "code": "SNAKE_CASE", "message": "..." } }`

Do not change paths or required fields without updating `CONTRACT_ALIGNMENT.md` first.

---

## Auth & scopes

| Scope | Endpoints |
|---|---|
| `ocr:process` | `POST /ocr/process` |
| `expenses:create` | `POST /expenses` |
| `expenses:read` | `GET /expenses`, `GET /expenses/:id`, `GET /expenses/by-ref`, `GET …/content`, `GET /categories` |
| `expenses:update` | `PATCH /expenses/:id`, `PUT …/receipts/primary` |
| `expenses:delete` | `DELETE /expenses/:id` |
| `receipts:create` | `POST /expenses/:id/receipts` |
| `expenses:import` | `POST /expenses/import` |

Missing required scope → **403** `{ "error": { "code": "MISSING_SCOPE", "message": "..." } }`.  
Invalid/missing key → **401** `UNAUTHENTICATED`.

Actor headers on mutating calls:

| Header / body | Meaning |
|---|---|
| `submitterEmail` (body) or `X-Actor-Email` | Ownership email |
| `X-Actor-External-User-Id` | Trade Show `users.id` UUID |
| `X-Actor-Name` | Display name (optional) |
| `X-Request-Id` | Correlation (optional) |

`EXT_AUTO_PROVISION_USERS` — default **`false`**; sandbox ops sets **`true`**.

---

## Schema additions (Midas)

| Change | Notes |
|---|---|
| `expenses.source_context` jsonb | `eventId`, `eventName`, `location`, `cardUsed`, … |
| `expenses.external_user_id` text, indexed | TS `users.id` (generic embedder field) |
| Index `(source_app)` + `(source_context->>'eventId')` | Efficient `eventId` filter |
| `reimbursement_status` += `rejected` | Additive |
| Receipt `sha256` (or equivalent) | When provided |
| `category_mappings` (or equivalent) | `sourceApp` + suggestion string → `categoryId`; data-driven |

`sourceApp` for this consumer: **`trade_show`**.  
`sourceType` open vocabulary; TS uses **`trade_show_event`**.

---

## Required endpoints (Trade Show v1)

### 1. `POST /ocr/process` — scope `ocr:process`

`multipart/form-data` field `file`.

**Semantics:** Sync OCR via the one Midas pipeline. **Do not** create expense or receipt SoR rows (ephemeral temp ok if never listed / never billed as permanent receipt).

**Response 200:**

```json
{
  "ocrMode": "sync",
  "requestId": "string",
  "fields": {
    "merchant": { "value": "string|null", "confidence": 0.0 },
    "amount": { "value": "number|null", "confidence": 0.0 },
    "date": { "value": "YYYY-MM-DD|null", "confidence": 0.0 },
    "category": { "value": "string|null", "confidence": 0.0 },
    "location": { "value": "string|null", "confidence": 0.0 },
    "cardLastFour": { "value": "string|null", "confidence": 0.0 }
  },
  "ocr": { "text": "string", "confidence": 0.0, "provider": "string" },
  "quality": { "overallConfidence": 0.0, "needsReview": false, "reviewReasons": [] },
  "warnings": []
}
```

**Errors (do not collapse invalid input to 500 `INTERNAL_ERROR`):**

| HTTP | `error.code` | When |
|---|---|---|
| 400 | `NO_FILE` | Missing multipart `file` |
| 400 | `OCR_INVALID_FILE` | Tiny/corrupt/unreadable file (incl. minimal PDF fixtures); upstream 400/413/415/422 |
| 502 | `OCR_AUTH_ERROR` / `OCR_PIPELINE_ERROR` / `OCR_BAD_RESPONSE` | Upstream OCR auth or pipeline failure |
| 503 | `OCR_UNAVAILABLE` | Upstream unreachable / 503 |
| 504 | `OCR_TIMEOUT` | Upstream timed out |

**Correlation:** Ext sets response header `X-Request-Id` (uses inbound `X-Request-Id` or `X-Correlation-Id` when provided). Error JSON may include `requestId`.

### 2. `POST /expenses` — scope `expenses:create`

**Body (JSON):**

```json
{
  "sourceApp": "trade_show",
  "sourceRefId": "<ts-expense-uuid>",
  "submitterEmail": "user@example.com",
  "externalUserId": "<ts-user-uuid>",
  "eventId": "<ts-event-uuid>",
  "sourceLabel": "Event Name",
  "sourceUrl": "https://...",
  "sourceType": "trade_show_event",
  "merchant": "string",
  "amount": 12.34,
  "currency": "USD",
  "date": "YYYY-MM-DD",
  "description": "string|null",
  "categoryId": "uuid|null",
  "categoryName": "string|null",
  "paymentMethodId": "uuid|null",
  "cardUsed": "string|null",
  "location": "string|null",
  "reimbursementRequired": false,
  "status": "pending",
  "zohoEntity": null,
  "metadata": {}
}
```

**Rules:**

- Require `sourceApp`, `sourceRefId`. If `sourceApp=trade_show`: also require `eventId`, `sourceLabel`, `sourceType` (`sourceUrl` optional).
- Default `status` = **`pending`** when omitted.
- Idempotent on `(sourceApp, sourceRefId)` → **200** `{ expense, midasUrl, created: false }`.
- New → **201** `{ expense, midasUrl, created: true }`.
- Full expense DTO (see § DTO).
- Persist `eventId` / location / cardUsed into `source_context`; `externalUserId` into column + context.

### 3. `GET /expenses` — scope `expenses:read`

| Param | Required | Description |
|---|---|---|
| `sourceApp` | yes for TS | `trade_show` |
| `eventId` | no | `source_context.eventId` |
| `eventIds` | no | comma-separated |
| `externalUserId` | no | TS user UUID |
| `status` | no | |
| `q` | no | merchant/description |
| `dateFrom` / `dateTo` | no | |
| `limit` / `cursor` | no | |

Response: `{ "expenses": [ /* DTO */ ], "nextCursor": "string|null" }`.

### 4. `GET /expenses/:id` — scope `expenses:read`

Full DTO (not status stub).

### 5. `GET /expenses/by-ref?sourceApp=&sourceRefId=` — scope `expenses:read`

Lookup by OwnerRef. **404** if missing. Full DTO.

### 6. `PATCH /expenses/:id` — scope `expenses:update`

Allowed when status ∈ `{draft, pending, awaiting_info}`; else **409**.

### 7. `DELETE /expenses/:id` — scope `expenses:delete`

Hard-delete **only if**:

- `status === draft`, **or**
- `status === pending` **and** `reviewedAt` is null **and** `zohoExpenseId` is null  

Otherwise **409**. Retain `audit_logs`. GC receipt blobs on success. Imported approved / Zoho-linked never deletable via Ext.

### 8. `POST /expenses/:id/receipts` — scope `receipts:create`

Multipart `file`. Default sync OCR; `?async=1` escape hatch.  
`PUT /expenses/:id/receipts/primary` — replace primary (scope `expenses:update`).

### 9. `GET /expenses/:id/receipts/:receiptId/content` — scope `expenses:read`

Stream bytes (app key). Signed URL may be added later for S3 (additive).

### 10. `POST /expenses/import` — scope `expenses:import`

JSON body wraps `@midas/import` (same rules as CLI).

```json
{
  "sourceApp": "trade_show",
  "dryRun": false,
  "items": [ /* Merge Contract §9.8 item shape */ ]
}
```

Rules: upsert `(sourceApp, sourceRefId)`; preserve timestamps; map status (`needs further review` → `awaiting_info`); `receipt.skipOcr=true` stores file + OCR without re-billing; optional `receipt.sha256`; per-item `created|updated|skipped|failed`; batch ≥ 50; unmapped category → `Other` + warning.

### 11. `GET /categories` — scope `expenses:read`

`{ "categories": [{ "id", "name", "description", "isActive" }] }`

---

## Deferred (not blocking Trade Show v1)

| Method | Path | Reason |
|---|---|---|
| `PATCH` | `/expenses/:id/review` | Midas UI + `midasUrl` |
| `PATCH` | `/expenses/:id/reimbursement` | Midas UI |
| `POST` | `/expenses/:id/zoho-push` | Midas UI |

Scopes `expenses:review`, `zoho:push` deferred with those endpoints.

---

## Expense DTO (full)

Returned by create/get/list/by-ref (fields may be null where N/A):

```json
{
  "id": "uuid",
  "merchant": "string",
  "amount": "12.34",
  "currency": "USD",
  "date": "YYYY-MM-DD",
  "description": "string|null",
  "status": "pending",
  "reimbursementStatus": "not_requested",
  "sourceApp": "trade_show",
  "sourceRefId": "uuid",
  "sourceLabel": "string",
  "sourceUrl": "string|null",
  "sourceType": "trade_show_event",
  "eventId": "uuid",
  "externalUserId": "uuid",
  "location": "string|null",
  "cardUsed": "string|null",
  "sourceContext": {},
  "category": { "id": "uuid", "name": "string" },
  "paymentMethod": { "id": "uuid", "label": "string" } | null,
  "user": { "id": "uuid", "name": "string", "email": "string" },
  "receipts": [
    {
      "id": "uuid",
      "filename": "string",
      "mimeType": "string",
      "ocrStatus": "done",
      "contentPath": "/api/v1/ext/expenses/.../receipts/.../content",
      "sha256": "string|null"
    }
  ],
  "zohoEntity": "string|null",
  "zohoExpenseId": "string|null",
  "zohoSyncedAt": "ISO8601|null",
  "midasUrl": "https://midas.../expenses/<id>",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "reviewedAt": "ISO8601|null"
}
```

Top-level create/get envelope may also repeat `midasUrl` beside `expense`.

---

## Status / reimbursement map

| TS expense status | Midas |
|---|---|
| `pending` | `pending` |
| `needs further review` | `awaiting_info` |
| `approved` | `approved` |
| `rejected` | `rejected` |
| — | `draft` / `in_review` / `zoho_sync_failed` (Midas-native / system) |

| TS reimbursement | Midas |
|---|---|
| not required | `not_requested` |
| pending review / null when required | `pending` |
| approved | `approved` |
| rejected | `rejected` |
| paid | `paid` |

---

## Category seed (exact names)

```
Booth / Marketing / Tools
Travel - Flight
Accommodation - Hotel
Transportation - Uber / Lyft / Others
Parking Fees
Rental - Car / U-haul
Meal and Entertainment
Gas / Fuel
Shipping Charges
Show Allowances - Per Diem
Travel Expenses
Model
Other
```

OCR suggestion → category name (initial `category_mappings` for `sourceApp=trade_show`): see Trade Show alignment response §3.2 (Meal/Restaurant → Meal and Entertainment, etc.; unknown → Other).

---

## Curl sketches

```bash
# Sync OCR
curl -sS -X POST "$MIDAS/api/v1/ext/ocr/process" \
  -H "Authorization: Bearer $KEY" \
  -F "file=@receipt.jpg"

# Create
curl -sS -X POST "$MIDAS/api/v1/ext/expenses" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "X-Actor-External-User-Id: $TS_USER_ID" \
  -d '{"sourceApp":"trade_show","sourceRefId":"...","submitterEmail":"...","eventId":"...","sourceLabel":"Expo","sourceType":"trade_show_event","merchant":"...","amount":10,"date":"2026-08-01","status":"pending","categoryName":"Meal and Entertainment"}'

# List by event
curl -sS "$MIDAS/api/v1/ext/expenses?sourceApp=trade_show&eventId=$EVENT" \
  -H "Authorization: Bearer $KEY"

# By legacy ref
curl -sS "$MIDAS/api/v1/ext/expenses/by-ref?sourceApp=trade_show&sourceRefId=$TS_EXPENSE_ID" \
  -H "Authorization: Bearer $KEY"

# Import dry-run
curl -sS -X POST "$MIDAS/api/v1/ext/expenses/import" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"sourceApp":"trade_show","dryRun":true,"items":[]}'
```

---

## Conformance checklist (Midas)

- [x] App key + **scope enforcement** on all `/ext/*` (`requireScope`)
- [x] `sourceApp=trade_show` + unique `sourceRefId`; idempotent create (200 + `created:false`)
- [x] Filterable `eventId` via `source_context`; `externalUserId` column
- [x] `GET /expenses/by-ref`
- [x] User auto-provision when `EXT_AUTO_PROVISION_USERS=true`
- [x] Sync OCR standalone (no expense persist)
- [x] OCR invalid input → `400 OCR_INVALID_FILE` (+ `X-Request-Id`); not `500 INTERNAL_ERROR`
- [x] Sync receipt upload; `async=1` optional
- [x] Full GET + list DTOs + `midasUrl`
- [x] PATCH / DELETE rules (incl. no Zoho-linked delete)
- [x] Idempotent import + `skipOcr` + timestamps + checksums (HTTP wraps ImportService; re-import skips)
- [x] Category seed + mappings + `GET /categories`
- [x] Status + reimbursement maps (incl. `rejected`)
- [x] Receipt content stream
- [x] Sandbox connection key with B4 scopes *(local: `npm run ext:create-connection`; see `docs/EXT_SANDBOX_HANDOFF.md`)*
