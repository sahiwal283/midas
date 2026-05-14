# Midas ↔ OCR Service Integration

**Stage:** 1 (code complete, mocked) — Stage 2 will wire against real OCR service.

## Architecture decision: sync-first

Midas uses a fire-and-forget background IIFE to run OCR after every receipt upload. The user receives HTTP 201 immediately; OCR completes in the background and updates `receipts.ocrStatus`. Sync OCR (`POST /ocr/`) fits this pattern exactly — the network call takes 2–5 s on document_ai and the user never waits on it. Async OCR (job queue + polling) is deferred until there is a concrete need for multi-page PDF processing.

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

## Stage 2

Stage 2 will test the integration against the real OCR service using a synthetic (non-paid) image to verify:
- Token authentication works end-to-end
- Attribution headers appear in the OCR admin ledger
- `receipts.ocrRequestId` correlates to the OCR ledger row

No paid OCR calls are made in Stage 1 or Stage 2. Stage 3 (one controlled real smoke test) requires explicit approval.
