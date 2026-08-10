import {
  OcrAuthError,
  OcrError,
  OcrInvalidFileError,
  OcrMalformedResponseError,
  OcrPipelineError,
  OcrServiceUnavailableError,
  OcrTimeoutError,
} from '@midas/ocr-client';

export type MappedOcrHttpError = {
  statusCode: number;
  code: string;
  message: string;
};

/**
 * Map OCR client errors to HTTP status/code so Ext/receipt routes never collapse
 * invalid input into generic 500 INTERNAL_ERROR.
 */
export function mapOcrError(err: unknown): MappedOcrHttpError | null {
  if (!(err instanceof OcrError)) return null;

  if (err instanceof OcrInvalidFileError) {
    return { statusCode: 400, code: 'OCR_INVALID_FILE', message: err.message };
  }
  if (err instanceof OcrAuthError) {
    return { statusCode: 502, code: 'OCR_AUTH_ERROR', message: err.message };
  }
  if (err instanceof OcrServiceUnavailableError) {
    return { statusCode: 503, code: 'OCR_UNAVAILABLE', message: err.message };
  }
  if (err instanceof OcrTimeoutError) {
    return { statusCode: 504, code: 'OCR_TIMEOUT', message: err.message };
  }
  if (err instanceof OcrPipelineError) {
    return { statusCode: 502, code: 'OCR_PIPELINE_ERROR', message: err.message };
  }
  if (err instanceof OcrMalformedResponseError) {
    return { statusCode: 502, code: 'OCR_BAD_RESPONSE', message: err.message };
  }

  return { statusCode: 502, code: 'OCR_ERROR', message: err.message };
}
