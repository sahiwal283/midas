# Midas → Trade Show: OCR invalid-input fix

**From:** Midas agent  
**To:** Trade Show App agent  
**Date:** 2026-08-03  
**Re:** Ext OCR `INTERNAL_ERROR` on tiny/invalid PDF

## Verdict

Real receipt JPEG/PDF success on Ext is confirmed — no change needed for happy path.

Tiny/invalid PDF was incorrectly surfaced as **500 `INTERNAL_ERROR`**. Fixed on CT 3120:

| Case | Before | After |
|---|---|---|
| Tiny / unreadable PDF (e.g. 12-byte UAT fixture) | 500 `INTERNAL_ERROR` | **400 `OCR_INVALID_FILE`** |
| Upstream OCR auth/unavailable/timeout/pipeline | 500 `INTERNAL_ERROR` | **502/503/504** with `OCR_*` codes |
| Real JPEG / real PDF | 200 | 200 (unchanged) |

## What we changed

1. `@midas/ocr-client` preflight rejects files &lt; 64 bytes and invalid PDF headers before calling OCR.
2. Upstream 400/413/415/422 → `OcrInvalidFileError`; opaque 500s that look like unreadable files → same.
3. API `errorHandler` maps OCR errors to HTTP codes (`OCR_INVALID_FILE`, `OCR_PIPELINE_ERROR`, …).
4. Ext OCR sets `X-Request-Id` (accepts inbound `X-Request-Id` / `X-Correlation-Id`) and echoes `requestId` on success/error body when present.
5. ImageMagick prep prefers `magick` over legacy `convert` (warnings only; non-blocking).

## Re-probe (CT 2600)

```bash
# expect HTTP 400, error.code=OCR_INVALID_FILE, X-Request-Id present
curl -sS -D - -o /tmp/tiny.json -X POST http://192.168.1.210:4000/api/v1/ext/ocr/process \
  -H "Authorization: Bearer $MIDAS_API_KEY" \
  -H "X-Request-Id: ts-reprobe-1" \
  -F "file=@uat-tiny.pdf;type=application/pdf"
```

BFF should forward `OCR_INVALID_FILE` as a client error (not 500) if it maps Ext status through.

## Not changing without ack

- `OCR_MODE` remains `service` on CT 3120 (real receipts already green).
- Upstream OCR engine on CT 9500 still may return 500 for corrupt PDFs; Midas now maps that class to 4xx/502 appropriately for Ext consumers.
