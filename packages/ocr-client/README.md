# @midas/ocr-client

The Node-side OCR client for the Midas Expense Engine. Every embedder (standalone
Midas, Midas embedded in another app) should use this package instead of calling
the OCR engine service (`~/Work/services/ocrService`, canonical, v0.17.0+)
directly, so preprocessing and fallback field inference are always applied
identically.

## What this package owns

- **`OcrAdapter` interface** — `MockOcrAdapter` (default, no network calls) and
  `ServiceOcrAdapter` (talks to the OCR engine service over HTTP).
- **Preprocessing** (`prepareReceiptImageForOcr`) — HEIC → JPEG, EXIF auto-orient,
  max-dimension resize, before the file is sent to the engine.
- **Rule-based field inference** (`RuleBasedInferenceEngine`) — regex/keyword
  extraction of merchant, amount, date, card, category, location, tax, and tip
  used to backfill weak/empty fields from the engine's response.

## Usage

```ts
import { ServiceOcrAdapter, MockOcrAdapter, type OcrAdapter } from '@midas/ocr-client';

const ocr: OcrAdapter =
  process.env.OCR_MODE === 'service'
    ? new ServiceOcrAdapter({
        baseUrl: process.env.OCR_BASE_URL!,
        internalToken: process.env.OCR_SERVICE_INTERNAL_TOKEN!,
      })
    : new MockOcrAdapter();

const result = await ocr.process('/path/to/receipt.jpg', receiptId);
```

## Customizing category inference

`ServiceOcrAdapter` accepts a `categoryKeywords` override so embedders can supply
their own taxonomy instead of the generic default in `defaultCategoryKeywords.ts`:

```ts
new ServiceOcrAdapter({
  baseUrl,
  internalToken,
  categoryKeywords: {
    'Booth / Event Marketing': { keywords: ['booth', 'signage', 'banner'], weight: 1.0 },
    ...DEFAULT_CATEGORY_KEYWORDS,
  },
});
```

Do not edit `defaultCategoryKeywords.ts` to add embedder-specific categories —
keep the shared default domain-agnostic (see `docs/OCR_ENGINE.md`).
