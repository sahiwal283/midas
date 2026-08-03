# Midas OCR Engine

The canonical OCR engine for the Midas Expense Engine. This service owns **all** receipt
OCR behavior — preprocessing, multi-provider text extraction, field parsing (merchant,
amount, date, card, tax, tip, line items), vendor/category inference, confidence scoring,
and normalization.

## Provenance

This service was migrated verbatim (same Python source, same dependency versions, same
provider logic) from the standalone `ocr-service` that both Midas and Trade Show App
previously called as an external dependency (`http://192.168.1.195:8000`). It is now owned
and versioned inside the Midas repository so there is exactly one OCR implementation for
every consumer — standalone Midas, embedded Midas, and (during the Trade Show cutover
window) Trade Show App's legacy client.

See `../../docs/OCR_ENGINE.md` for the full architecture writeup and
`../../docs/ocr-integration.md` for the operational history of the Midas ↔ OCR integration
(including the cost-ledger safety rules — some providers are metered and bill per call).

`UPSTREAM_README.md` is the original service README, kept for reference. It documents
provider internals (Document AI, Google Vision, RapidOCR, EasyOCR, Tesseract), the
admin UI, the cost ledger, and the async job worker in more depth than is repeated here.

## Architecture (independently testable stages)

```
receipt file
     │
     ▼
┌─────────────────────────┐
│ Preprocessing            │  app/utils/image_normalize.py, app/services/pdf_processor.py
│ (format/orientation      │  HEIC/WebP → JPEG, PDF → image pages
│  cleanup)                 │
└────────────┬─────────────┘
             ▼
┌─────────────────────────┐
│ OCR Engine                │  app/services/ocr_engine.py
│ (provider selection +     │  document_ai | google_vision | rapidocr | easyocr | tesseract
│  fallback)                 │  app/services/*_processor.py (one module per provider)
└────────────┬─────────────┘
             ▼
┌─────────────────────────┐
│ Field extraction /        │  app/services/extraction_rules.py, app/services/postprocess.py
│ parsing                   │  merchant, amount, date, tax, tip, line items, card-last-4
│ (vendor detection, tax,   │
│  totals, line items)      │
└────────────┬─────────────┘
             ▼
┌─────────────────────────┐
│ LLM enhancement (opt-in)  │  app/services/llm_enhancement.py, llm_provider.py
│ — improves low-confidence │  Ollama / OpenAI / Gemini, disabled by default
│   fields only              │
└────────────┬─────────────┘
             ▼
┌─────────────────────────┐
│ Confidence scoring +       │  app/services/complexity_analyzer.py
│ normalization              │  overall confidence, needsReview, reviewReasons
└────────────┬─────────────┘
             ▼
┌─────────────────────────┐
│ Cost ledger / audit        │  app/db/ledger.py, app/db/audit.py
│ (optional — required only  │  per-call cost attribution, admin UI at /admin/ui
│  for metered providers)    │
└────────────┴─────────────┘
```

Each stage lives in its own module and can be tested independently — see `tests/`.

## Running locally

```bash
cd services/ocr-engine
cp .env.example .env       # safe defaults: rapidocr + tesseract, no cloud calls, no DB
docker build -t midas-ocr-engine .
docker run --rm -p 8000:8000 --env-file .env midas-ocr-engine
```

Or via the Midas root `docker-compose.yml` (`ocr-engine` service) — see
`docs/OCR_ENGINE.md` for the compose wiring and how the Node API's `OCR_MODE=service`
adapter talks to it.

## Cost warning

`PRIMARY_OCR_PROVIDER=document_ai` or `google_vision` are metered cloud APIs that cost
real money per receipt. **Never** set either as the primary/fallback provider outside of
a production environment with an approved cost ledger and explicit operator sign-off.
Local development and CI must always use `rapidocr`, `easyocr`, or `tesseract` (all free,
all local, no network egress required for OCR itself).

## Tests

```bash
cd services/ocr-engine
pip install -r requirements.txt
pytest
```
