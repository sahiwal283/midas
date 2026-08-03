# Midas OCR Subsystem

Midas owns the complete OCR **pipeline** for receipt processing — not only the
Python OCR container. There is one pipeline, used identically by standalone
Midas and by Midas embedded in another app.

---

## What Trade Show App actually does (source of truth)

Inspected from `/opt/trade-show-app` on CT 2220 and local `trade-show-app` source
(2026-08-03). The live path is **not** “whatever is inside the OCR container”
alone.

### Live request path

```
Receipt file (web upload or Telegram)
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Trade Show backend (Node) — backend/src/services/ocr/                 │
│                                                                         │
│  1. prepareReceiptImageForExternalOcr()                                 │
│     • HEIC/HEIF → JPEG via ImageMagick `convert`                        │
│     • Raster normalize: -auto-orient -resize 2000x2000\> -strip         │
│     • PDF left unchanged                                                │
│                                                                         │
│  2. POST {OCR_SERVICE_URL}/ocr/   (default http://192.168.1.195:8000) │
│     Header: X-Internal-Token: OCR_SERVICE_INTERNAL_TOKEN                │
│     Timeout: OCR_TIMEOUT (default 120000 ms)                            │
│                                                                         │
│  3. enrichOcrApiResultWithRuleInference()                               │
│     RuleBasedInferenceEngine over raw ocr.text — backfills weak/empty   │
│     merchant / amount / date / category / location                      │
│                                                                         │
│  4. FieldWarningService.analyzeFields()  (API response warnings)        │
│  5. ReservationParser (checklist/hotel/flight only — Trade Show UI)     │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ HTTP
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Live OCR engine — CT 9500 @ 192.168.1.195:8000  (ocr-service v0.15.0) │
│                                                                         │
│  PRIMARY_OCR_PROVIDER=rapidocr                                          │
│  FALLBACK_OCR_PROVIDER=document_ai   ← metered cloud fallback           │
│  REQUIRE_COST_LEDGER=true                                               │
│  ENABLE_LLM_INFERENCE=false                                             │
│  OCR_REQUIRE_SERVICE_TOKEN=true                                         │
│                                                                         │
│  Internally: preprocess → provider extract → field parse → confidence   │
│  scoring → cost ledger                                                  │
└───────────────────────────────────────────────────────────────────────┘
```

### What is NOT on the live path

Production `dist/` still contains leftover **embedded** OCR artifacts
(`OCRService.js`, EasyOCR/Paddle/Tesseract providers, `*.py` processors).
Those are **not** invoked by the current `/api/ocr/v2/process` route. The
route only calls `receiptExternalOcr.runExternalReceiptOcrWithCleanup()`.
If the external engine is unhealthy, the API returns 503 — it does **not**
fall back to the embedded stack (despite an outdated comment saying so).

### Env on Trade Show production (CT 2220)

| Variable | Value |
|---|---|
| `OCR_SERVICE_URL` | `http://192.168.1.195:8000` |
| `OCR_SERVICE_INTERNAL_TOKEN` | set (required) |
| `OCR_TIMEOUT` | `120000` (default if unset) |

---

## How Midas mirrors that pipeline (exact parity)

Verified 2026-08-03 against the same receipt on CT 2220 (Trade Show) and CT 3120
(Midas): identical `text`, `provider`, confidences, and field values/sources.

| Trade Show piece | Midas equivalent |
|---|---|
| `prepareReceiptImageForExternalOcr` | `@midas/ocr-client` `prepareReceiptImageForOcr` (same ImageMagick commands) |
| `POST /ocr/` to CT 9500 | `ServiceOcrAdapter` → `OCR_BASE_URL=http://192.168.1.195:8000` |
| `enrichOcrApiResultWithRuleInference` | `ServiceOcrAdapter.enrichWithRuleInference` (same merge thresholds) |
| `RuleBasedInferenceEngine` | **Verbatim copy** of the expense-app engine + taxonomy |
| Category keywords | Same expense-app map in `DEFAULT_CATEGORY_KEYWORDS` |
| `FieldWarningService` | UI-only warnings — does not change extracted field values |
| `ReservationParser` | Checklist/hotel/flight only — **not** part of expense receipt OCR |

Do not "improve" the inference heuristics or category map without re-running a
side-by-side parity check against Trade Show — users prefer this OCR as-is.

`services/ocr-engine/` is a vendored copy of the Python engine source for
ownership/versioning. **Runtime** should call the same live engine Trade Show
uses (`http://192.168.1.195:8000`) unless you intentionally run a local copy.

OCR is **live by default** (`OCR_MODE=service`). `mock` is only for offline
tests/CI.

```dotenv
OCR_MODE=service
OCR_BASE_URL=http://192.168.1.195:8000
OCR_SERVICE_INTERNAL_TOKEN=<same token Trade Show / CT 9500 use>
OCR_TIMEOUT_MS=120000
```

---

## `OcrAdapter` interface

```ts
interface OcrAdapter {
  process(filePath: string, receiptId: string): Promise<OcrResult>;
}
```

- **`ServiceOcrAdapter`** — live path (preprocess → engine → rule inference).
- **`MockOcrAdapter`** — offline tests only.

Wire-up: `apps/api/src/lib/ocr.ts` selects based on `OCR_MODE`.

### Category inference

`DEFAULT_CATEGORY_KEYWORDS` is the **exact** expense-app taxonomy (including
`Booth / Marketing / Tools`, `Show Allowances - Per Diem`, etc.). Those strings
are OCR suggestions from the verified pipeline, not Midas DB category rows.
Overrides via `ServiceOcrAdapter({ categoryKeywords })` are for tests only —
changing the default changes OCR results vs Trade Show.

---

## Cost / safety (live engine)

CT 9500’s fallback is **Document AI** (paid). Every live receipt can incur
cost when RapidOCR confidence is low enough to trigger fallback. Midas
attributes spend via:

```
X-Client-App: midas
X-Workflow: receipt-ocr
X-External-Reference-Type: expense_receipt
X-External-Reference-ID: receipt:<receipts.id>
```

Operational history of earlier Midas ↔ OCR probes: `docs/ocr-integration.md`.

---

## Local engine (optional)

```bash
docker compose --profile ocr up -d ocr-engine   # localhost:8001
OCR_BASE_URL=http://localhost:8001
```

Local `.env.example` for `services/ocr-engine` defaults to free providers
(`rapidocr` / `tesseract`) so a laptop copy does not bill Document AI. That
local config is **not** identical to CT 9500 production
(`rapidocr` / `document_ai`). For behavior parity with Trade Show, point at
CT 9500.
