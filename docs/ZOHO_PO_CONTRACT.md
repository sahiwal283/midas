# Zoho Purchase Order Contract (Midas ↔ Integration Service)

**Audience:** Zoho Integration Service agent + Midas  
**Status:** Live (verified 2026-08-10 against service `v1.35.0` on CT 9503)  
**Auth:** Identical to expenses (`Authorization: Bearer`, `X-Brand`)

Midas never calls Zoho Books directly. All PO traffic goes through the Zoho Integration Service.

## Endpoints (actual)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/zoho/purchaseorders/create` | Create PO (Books wire body) |
| POST | `/zoho/purchaseorders/attach_receipt` | Attach receipt file to PO |
| GET | `/zoho/vendors/list` | List vendors (`data.contacts[]`) |
| GET | `/zoho/items/list` | List items (`data.items[]`) |

> **Note:** Do **not** use `/create_books` for POs. That path is expense-only. PO create is `/zoho/purchaseorders/create`.

## Create PO body (Midas → service)

Midas builds an internal payload, then converts to **Zoho Books shape** via `toZohoBooksPoCreateBody()`.  
Sending camelCase `lineItems` or nested `source` causes Zoho validation errors (unknown keys treated as Books fields).

```json
{
  "idempotencyKey": "midas-po-<transactionUuid>",
  "reference_number": "midas-po-<transactionUuid>",
  "vendor_id": "<zoho contact_id>",
  "date": "YYYY-MM-DD",
  "line_items": [
    {
      "item_id": "<zoho item_id>",
      "quantity": 10,
      "rate": 5.3,
      "name": "Mini Marshmallows"
    }
  ]
}
```

### Required before push

- `vendor_id` from Zoho vendor list (`contact_id`)
- Every line must have `item_id` from Zoho items list
- Midas validates these before calling the service (`MISSING_ZOHO_VENDOR` / `MISSING_ZOHO_ITEM`)

### Idempotency

- Key is deterministic: `midas-po-<transactionId>`.
- Also sent as `reference_number` (truncated to 50 chars) so Books retains a stable reference.
- **Service caveat (2026-08-10):** retries with the same `idempotencyKey` have been observed to create a second Books PO. Prefer not to blind-retry after ambiguous timeouts until the service enforces uniqueness. Cancel/delete accidental probe POs in Books when testing.

### Expected success response

```json
{
  "purchaseorder_id": "<books_po_id>"
}
```

(Any of `zohoPurchaseOrderId` | `purchaseorder_id` | nested `data.purchaseorder.purchaseorder_id` is accepted by the Midas parser.)

### Error shape

Same as expenses: `{ "detail": { "error": { "code", "message", "request_id", ... } } }`.

### Vendors / items response shape

- Vendors: `data.contacts[]` with `contact_id`, `contact_name` / `company_name`
- Items: `data.items[]` with `item_id`, `name`

## Midas env (unchanged)

| Variable | Role |
|----------|------|
| `ZOHO_MODE` | `mock` \| `service` |
| `ZOHO_DRY_RUN` | Skip live POST when true |
| `ZOHO_SERVICE_BASE_URL` | Service base |
| `ZOHO_SERVICE_TOKEN` | App Bearer token |
| `ZOHO_DEFAULT_BRAND` | Default `X-Brand` (e.g. `haute_brands`) |

## Capability grants (service admin / CT 9503)

Midas app needs at least:

- `purchaseorders.create` (or the service’s create capability name for `/create`)
- `purchaseorders.attach_receipt`
- `vendors.list` / `vendors.get`
- `items.list` / `items.get` / `items.search`

Use `scripts/grant_midas_po_capabilities.py` in the Zoho Integration Service repo, then grant vendor/item list capabilities if 403s appear.
