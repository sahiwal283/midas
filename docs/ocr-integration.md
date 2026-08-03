# Midas ↔ OCR Service Integration

> **Update (2026-08-03):** OCR is now **live** (`OCR_MODE=service`) and points
> at the same CT 9500 engine Trade Show App uses (`http://192.168.1.195:8000`).
> The full pipeline is **not** only that container — see `docs/OCR_ENGINE.md`
> for the Node-side preprocessing + rule-based inference that Trade Show runs
> in `receiptExternalOcr.ts` and that Midas mirrors in `@midas/ocr-client`.
> This file remains as the historical Stage 1–3 operational log. Sections below
> that say “mock is the safe default” are historical; current operational
> default is live service mode.

**Stage:** 3 complete (2026-05-14) — one real receipt processed, all attribution headers confirmed, $0.1015 cost, reverted to `OCR_MODE=mock` at the time. **As of 2026-08-03, CT 3120 runs `OCR_MODE=service` permanently** against CT 9500.

## Historical note: OCR_MODE=mock (pilot era)

**During the pilot, `OCR_MODE=mock` was the safe default** so no network call was made to CT 9500. That is no longer the operational posture — production Midas uses live OCR, matching Trade Show App.

Any receipt upload while `OCR_MODE=service` triggers a real OCR call on CT 9500 (RapidOCR primary, Document AI fallback — metered). That is intentional.

To check the current mode:
```bash
ssh root@192.168.1.190 "pct exec 3120 -- docker logs --tail 5 midas-api-1 | grep 'OCR mode'"
```

To switch mode (requires API container recreation — `restart` alone does not reload the env_file):
```bash
# Set mock (safe default)
ssh root@192.168.1.190 "pct exec 3120 -- sed -i 's/^OCR_MODE=.*/OCR_MODE=mock/' /opt/midas/.env"

# Set service (Stage 3+ only — requires approval)
# ssh root@192.168.1.190 "pct exec 3120 -- sed -i 's/^OCR_MODE=.*/OCR_MODE=service/' /opt/midas/.env"

# Recreate container to reload env
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'"
```

---

## Architecture decision: sync-primary (updated 2026-08-03)

**Receipt upload awaits OCR by default.** `POST /api/v1/expenses/:id/receipts`
runs the live OCR pipeline and returns the receipt with `ocrStatus` of `done` or
`failed` in the same response. Embedders must not assume they need to poll.

Escape hatch: `?async=1` restores the old fire-and-forget behavior for rare
cases. Offline / flaky-network clients use the **To upload** queue
(`docs/SYNC_AND_OFFLINE.md`) — not server-side async — as the safety net.

## Required environment variables

| Variable | Description | Required in |
|----------|-------------|-------------|
| `OCR_MODE` | `mock` (default) or `service` | Always |
| `OCR_BASE_URL` | OCR service base URL, e.g. `http://192.168.1.195:8000` | service mode |
| `OCR_SERVICE_INTERNAL_TOKEN` | Service-to-service auth token | service mode |
| `OCR_TIMEOUT_MS` | Request timeout ms (default `30000`) | Optional |
| `OCR_CLIENT_APP` | Cost attribution app name (default `midas`) | Optional |
| `OCR_WORKFLOW` | Cost attribution workflow (default `receipt-ocr`) | Optional |
| `OCR_EXTERNAL_REF_TYPE` | Reference type header (default `expense_receipt`) | Optional |

The token must never be committed or logged. It lives server-side only — the frontend never touches OCR directly.

## Required headers (sent on every OCR request)

```
X-Internal-Token:          <OCR_SERVICE_INTERNAL_TOKEN>
X-Client-App:              midas
X-Workflow:                receipt-ocr
X-External-Reference-Type: expense_receipt
X-External-Reference-ID:   receipt:<receipts.id>
```

## Stable external reference ID format

```
receipt:<receipts.id>
```

Example: `receipt:8f3a1b2c-4d5e-6f7a-8b9c-0d1e2f3a4b5c`

This is deterministic and never changes for a given receipt. The OCR admin UI can filter by this value to see the full OCR history for any Midas receipt (`GET /admin/ledger/jobs?external_reference_id=receipt:<id>`).

## OCR output is draft suggestion only

OCR results are stored in `receipts.ocrData` (full JSON) and the enrichment columns (`ocrProvider`, `ocrNeedsReview`, etc.). They are **never** automatically committed to the expense's `merchant`, `amount`, or `date` fields. A user or accountant must review and confirm the extracted values before they influence accounting data.

## New receipt columns (Stage 1 migration)

See `drizzle/0001_ocr_receipt_columns.sql`. Apply via `npm run db:push` when deploying.

Key columns:
- `ocr_request_id` — OCR service `request_id` for ledger correlation
- `ocr_provider` — which provider ran (document_ai, google_vision, tesseract)
- `ocr_needs_review` — true when OCR service flagged the receipt
- `ocr_review_reasons` — array of reasons when needs_review is true
- `ocr_error_summary` — human-readable error when ocrStatus = failed
- `ocr_cost_estimate_usd` — estimated cost of this OCR call

## Stage 2 — completed 2026-05-14

Stage 2 was completed against CT 9500 (192.168.1.195:8000) using a three-probe auth verification. No file was uploaded; no provider pipeline ran; no paid call was made.

**Probes run:**
1. `POST /ocr/` with no token → `401 Unauthorized` (auth guard active)
2. `POST /ocr/` with wrong token → `403 Forbidden` (token rejection confirmed)
3. `POST /ocr/` with correct token + no file → `422 Unprocessable Entity` (FastAPI parameter validation; fires before endpoint body, before any ledger job creation)

**Verification:** OCR service ledger queried after all three probes — zero jobs with `client_app=midas`, zero `provider_calls` records. Definitively $0 cost.

**What was activated during Stage 2 (then immediately reverted):**
- `OCR_MODE=service` set temporarily in `/opt/midas/.env` on CT 3120 (reverted to `mock` after verification)
- `OCR_BASE_URL=http://192.168.1.195:8000` set (kept in .env, inactive while `OCR_MODE=mock`)
- `OCR_SERVICE_INTERNAL_TOKEN` set (64-char token, kept in .env, inactive while `OCR_MODE=mock`)
- API container recreated (`docker compose up -d api`) after each change — startup log confirmed mode on both switches

## Stage 3 — completed 2026-05-14

One controlled real receipt OCR call. Operator approval received and documented.

**What was done:**
1. Switched CT 3120 to `OCR_MODE=service`, recreated API container
2. Uploaded one synthetic PNG (400×200 grey gradient, no readable text) to expense `bc6ea37e-070a-444e-8bfd-4fdc56899d97`
3. OCR completed in ~5 seconds via `document_ai` provider
4. Confirmed OCR DB entry: `job_id=208b79a4`, `request_id=fb58ba7c`
5. Confirmed all attribution headers stored in OCR DB: `client_app=midas`, `workflow=receipt-ocr`, `external_reference_type=expense_receipt`, `external_reference_id=receipt:8ef0e789`
6. Switched back to `OCR_MODE=mock` immediately — service window was ~14 minutes

**Results:**
- OCR provider: `document_ai` (with `google_vision` backup call)
- Cost: `$0.1015` (`document_ai`: $0.1000, `google_vision`: $0.0015)
- `ocrNeedsReview: true` — reason: "No text extracted from image" (expected, synthetic image)
- `ocrConfidence: 0`, `ocrOverallConfidence: 0` (expected, blank image)
- Expense accounting fields (`merchant`, `amount`, `date`) were NOT overwritten — OCR data stored in `ocrData` only
- Total midas jobs in OCR DB after Stage 3: **exactly 1**

**OCR admin ledger lookup (resolved as of OCR v0.11.0):** During Stage 3 initial verification, `GET /admin/ledger/jobs?client_app=midas` returned empty results despite the job being present in the OCR DB. The OCR service shipped fixes in v0.10.1 (external_reference_id filtering, workflow + external_reference_type filters, `/admin/ledger/filter-options`, unknown filter values return empty rather than all) and v0.11.0 (added `/admin/ledger/dashboard`, `/admin/ledger/job-lookup`). After v0.11.0, the Stage 3 job (`job_id=208b79a4`) was successfully retrieved by `external_reference_id=receipt:8ef0e789`, with nested provider calls and $0.1015 total cost confirmed. No Midas-side changes were required.

**Operator cost verification (v0.11.0+):** Use `GET /admin/ledger/job-lookup?external_reference_id=receipt:<receipts.id>` or `/admin/ledger/jobs?client_app=midas` to verify Midas job attribution and cost from the OCR admin API. Midas also stores `ocrRequestId`, `ocrCostEstimateUsd`, and `ocrProvider` per receipt for independent Midas-side tracking.

**Warning for future tests:** While `OCR_MODE=service` is active, any receipt uploaded by any Midas user creates a real paid OCR call. Minimize the service window and coordinate with users before switching.
