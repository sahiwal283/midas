import { env } from '../config/env';
import {
  MockOcrAdapter,
  ServiceOcrAdapter as BaseServiceOcrAdapter,
  type OcrAdapter,
} from '@midas/ocr-client';

// The OCR engine lives in its own repo, ~/Work/services/ocrService (canonical,
// v0.17.0+; see docs/OCR_ENGINE.md) — not vendored here. This package's shared
// client lives in @midas/ocr-client — preprocessing, provider selection, and
// rule-based field inference all live there so every embedder of Midas gets
// identical OCR behavior. This file only wires Midas's env config in.

export type { OcrField, OcrResult, OcrAdapter } from '@midas/ocr-client';
export {
  OcrError,
  OcrAuthError,
  OcrInvalidFileError,
  OcrServiceUnavailableError,
  OcrPipelineError,
  OcrTimeoutError,
  OcrMalformedResponseError,
  MockOcrAdapter,
} from '@midas/ocr-client';

export class ServiceOcrAdapter extends BaseServiceOcrAdapter {
  constructor() {
    super({
      baseUrl: env.OCR_BASE_URL ?? '',
      internalToken: env.OCR_SERVICE_INTERNAL_TOKEN ?? '',
      timeoutMs: env.OCR_TIMEOUT_MS,
      clientApp: env.OCR_CLIENT_APP,
      workflow: env.OCR_WORKFLOW,
      externalRefType: env.OCR_EXTERNAL_REF_TYPE,
    });
  }
}

export const ocr: OcrAdapter =
  env.OCR_MODE === 'service' ? new ServiceOcrAdapter() : new MockOcrAdapter();
