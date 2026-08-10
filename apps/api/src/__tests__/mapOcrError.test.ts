import { describe, it, expect } from 'vitest';
import {
  OcrAuthError,
  OcrInvalidFileError,
  OcrPipelineError,
  OcrServiceUnavailableError,
  OcrTimeoutError,
} from '@midas/ocr-client';
import { mapOcrError } from '../lib/mapOcrError';

describe('mapOcrError', () => {
  it('maps invalid file to 400 OCR_INVALID_FILE', () => {
    expect(mapOcrError(new OcrInvalidFileError('too small'))).toEqual({
      statusCode: 400,
      code: 'OCR_INVALID_FILE',
      message: 'too small',
    });
  });

  it('maps auth to 502', () => {
    expect(mapOcrError(new OcrAuthError('bad token'))?.code).toBe('OCR_AUTH_ERROR');
  });

  it('maps unavailable to 503', () => {
    expect(mapOcrError(new OcrServiceUnavailableError('down'))?.statusCode).toBe(503);
  });

  it('maps timeout to 504', () => {
    expect(mapOcrError(new OcrTimeoutError('slow'))?.statusCode).toBe(504);
  });

  it('maps pipeline to 502 OCR_PIPELINE_ERROR', () => {
    expect(mapOcrError(new OcrPipelineError('boom'))?.code).toBe('OCR_PIPELINE_ERROR');
  });

  it('returns null for non-OCR errors', () => {
    expect(mapOcrError(new Error('nope'))).toBeNull();
  });
});
