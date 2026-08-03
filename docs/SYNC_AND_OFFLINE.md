# Midas Sync Model: Live Sync + Offline Safety Net

**Clarification for embedders (Trade Show App, Argo, …):** Midas is **not**
async-only. The primary contract is **live synchronous** create/update/OCR.
An offline **"To upload"** queue is the safety net when the user cannot reach
Midas — not the default path.

---

## Primary path — live synchronous

When the client has connectivity, every mutating call completes in the request:

| Operation | Behavior |
|---|---|
| `POST /api/v1/expenses` | Response includes the created expense |
| `PATCH /api/v1/expenses/:id` | Response includes the updated expense |
| `POST /api/v1/expenses/:id/receipts` | **Awaits OCR**, then returns the receipt with `ocrStatus` (`done` / `failed`) and OCR fields populated |
| `POST /api/v1/ext/expenses` | Response includes the created expense (idempotent on `sourceApp`+`sourceRefId`) |
| OCR field suggestions | Available in the receipt upload response — no polling required |

Embedders (including Trade Show) should treat a successful HTTP response as
authoritative: the expense/receipt/OCR state is already persisted. Do **not**
assume you must poll for OCR completion on the happy path.

### Escape hatch (rare)

`POST /api/v1/expenses/:id/receipts?async=1` returns `201` immediately with
`ocrStatus: pending` and runs OCR in the background. Use only when the caller
cannot wait (e.g. very large PDFs). Prefer the default sync path.

---

## Safety net — "To upload" queue

When the user is offline, on a flaky show-floor network, or a sync call fails
transiently, the **client** queues the work locally and surfaces a **To upload**
list. When connectivity returns, the queue drains by calling the same
synchronous Midas APIs above.

```
Online (default)                         Offline / trouble
─────────────────                        ─────────────────
User submits expense                     User submits expense
    │                                        │
    ▼                                        ▼
POST Midas (sync, wait for OCR)          Save to local "To upload" queue
    │                                        │
    ▼                                        ▼
UI shows expense + OCR results           UI shows item in To upload list
                                         (retry when online)
```

### Ownership

| Layer | Responsibility |
|---|---|
| **Midas API** | Always sync-primary. No server-side “accept now, process later” for expense creates on the happy path. |
| **Midas web** | Ships a browser IndexedDB **To upload** queue + `/to-upload` UI. |
| **Embedders** | May keep their own offline queue (Trade Show already has one) **or** navigate users into Midas web. Either way, when online they call Midas synchronously. |

The offline queue is **client-side**. Midas server does not invent expenses that
never arrived — the queue retries until the sync POST succeeds.

### Idempotency

Queued creates should include a stable client key:

- Embedders: `sourceApp` + `sourceRefId` (`OwnerRef`) — unique in Midas
- Midas web queue: stores a `clientKey` UUID per queued item and reuses it on retry

---

## What “Midas is async” referred to (historical)

Older Midas receipt uploads returned `201` before OCR finished (fire-and-forget
background IIFE). That made embedders think the platform was async. **That is
no longer the default.** OCR now completes inside the upload request unless
`?async=1` is set.

Server-side async OCR *job queues* inside `services/ocr-engine` are an internal
engine concern for multi-page/paid providers — not the app-to-app expense
contract.

---

## Contract summary for the Trade Show merge

1. **Happy path:** Trade Show → Midas is synchronous HTTP; wait for the response; show OCR fields from it.
2. **Trouble path:** Trade Show (or Midas web) queues locally → “To upload” → retry sync POSTs when online.
3. **Do not** design the merge around polling OCR status as the primary UX.
4. Migration of historical data uses `@midas/import` (batch), which is separate from this live sync model — see `docs/IMPORT_FRAMEWORK.md`.
5. The full bilateral cutover (ownership, APIs, OCR, import, UI) is
   `docs/TRADE_SHOW_MIGRATION_CONTRACT.md` — sync/offline alone is not enough to merge.
