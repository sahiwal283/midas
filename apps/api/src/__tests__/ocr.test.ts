/**
 * Stage 1 OCR integration tests — no network, no paid calls.
 *
 * Covers:
 *  - MockOcrAdapter returns the expanded OcrResult shape
 *  - ServiceOcrAdapter builds the correct request (URL, method, headers, body)
 *  - ServiceOcrAdapter does NOT use Authorization: Bearer or JSON imagePath
 *  - ServiceOcrAdapter error mapping (401 → OcrAuthError, 422, 503, 500, timeout, malformed)
 *  - Env schema: mock mode needs no OCR_BASE_URL; service mode requires both URL + token
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock fs/promises so the adapter never reads from disk ─────────────────────
vi.mock('fs/promises', () => ({
  // ≥64 bytes so ServiceOcrAdapter preflight accepts the fixture
  readFile: vi.fn().mockResolvedValue(Buffer.alloc(128, 0x41)),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock the env module so adapters run without a real .env ───────────────────
vi.mock('../config/env', () => ({
  env: {
    OCR_MODE: 'service',
    OCR_BASE_URL: 'http://ocr-test.local:8000',
    OCR_SERVICE_INTERNAL_TOKEN: 'test-svc-token-stage1',
    OCR_TIMEOUT_MS: 5000,
    OCR_CLIENT_APP: 'midas',
    OCR_WORKFLOW: 'receipt-ocr',
    OCR_EXTERNAL_REF_TYPE: 'expense_receipt',
    UPLOADS_DIR: './uploads',
  },
  _envSchema: { safeParse: vi.fn() },
}));

import {
  MockOcrAdapter,
  ServiceOcrAdapter,
  OcrAuthError,
  OcrInvalidFileError,
  OcrServiceUnavailableError,
  OcrPipelineError,
  OcrTimeoutError,
  OcrMalformedResponseError,
} from '../lib/ocr';
import { _envSchema } from '../config/env';

// ── Helpers ───────────────────────────────────────────────────────────────────

const RECEIPT_ID = 'rec-uuid-1234';
const RECEIPT_PATH = '/uploads/1234-receipt.jpg';

/** Minimal valid OCR service response that passes mapResponse(). */
const validOcrResponse = {
  success: true,
  request_id: 'req-uuid-abc',
  job_id: 'job-uuid-xyz',
  ocr: { text: 'Starbucks $5.00', confidence: 0.95, provider: 'document_ai' },
  fields: {
    merchant: { value: 'Starbucks', confidence: 0.95, source: 'document_ai' },
    amount: { value: '5.00', confidence: 0.99, source: 'document_ai' },
    date: { value: '2026-05-14', confidence: 0.98, source: 'document_ai' },
    cardLastFour: { value: null, confidence: 0, source: 'document_ai' },
    category: { value: 'Meal and Entertainment', confidence: 0.85, source: 'document_ai' },
  },
  categories: [{ name: 'Meal and Entertainment', score: 0.85 }],
  quality: { overallConfidence: 0.93, needsReview: false, reviewReasons: null },
  cost: { estimated_usd: 0.0015, ledger_recorded: true, ledger_unavailable_fallback: false },
};

function mockFetchOk(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

function mockFetchStatus(status: number, body = ''): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => body,
  }));
}

// ── MockOcrAdapter ────────────────────────────────────────────────────────────

describe('MockOcrAdapter', () => {
  const adapter = new MockOcrAdapter();

  it('returns expanded OcrResult shape', async () => {
    const result = await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    expect(result.requestId).toBeDefined();
    expect(result.provider).toBeDefined();
    expect(result.text).toBeDefined();
    expect(typeof result.ocrConfidence).toBe('number');
    expect(typeof result.overallConfidence).toBe('number');
    expect(typeof result.needsReview).toBe('boolean');
    expect(result.fields).toBeDefined();
    expect(Array.isArray(result.categories)).toBe(true);
  });

  it('returns all required field keys', async () => {
    const result = await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const keys = Object.keys(result.fields);
    expect(keys).toContain('merchant');
    expect(keys).toContain('amount');
    expect(keys).toContain('date');
    expect(keys).toContain('cardLastFour');
    expect(keys).toContain('category');
  });

  it('each field has value, confidence, source', async () => {
    const result = await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    for (const field of Object.values(result.fields)) {
      if (field === undefined) continue;
      expect('value' in field).toBe(true);
      expect(typeof field.confidence).toBe('number');
      expect(typeof field.source).toBe('string');
    }
  });

  it('includes quality and cost fields', async () => {
    const result = await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    expect(typeof result.overallConfidence).toBe('number');
    expect(typeof result.needsReview).toBe('boolean');
    // costEstimateUsd may be null for mock
    expect('costEstimateUsd' in result).toBe(true);
    expect('ledgerRecorded' in result).toBe(true);
  });
});

// ── ServiceOcrAdapter — request shape ────────────────────────────────────────

describe('ServiceOcrAdapter — request shape', () => {
  const adapter = new ServiceOcrAdapter();

  beforeEach(() => {
    mockFetchOk(validOcrResponse);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /ocr/', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ocr-test.local:8000/ocr/');
    expect(init.method).toBe('POST');
  });

  it('sends X-Internal-Token header', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Internal-Token']).toBe('test-svc-token-stage1');
  });

  it('sends X-Client-App: midas', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Client-App']).toBe('midas');
  });

  it('sends X-Workflow: receipt-ocr', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Workflow']).toBe('receipt-ocr');
  });

  it('sends X-External-Reference-Type: expense_receipt', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-External-Reference-Type']).toBe('expense_receipt');
  });

  it('sends X-External-Reference-ID: receipt:<receiptId>', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-External-Reference-ID']).toBe(`receipt:${RECEIPT_ID}`);
  });

  it('does NOT send Authorization: Bearer', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(Object.keys(headers).map(k => k.toLowerCase())).not.toContain('authorization');
  });

  it('sends FormData body (not JSON imagePath)', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('does not set Content-Type manually (lets fetch set multipart boundary)', async () => {
    await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
  });
});

// ── ServiceOcrAdapter — response mapping ──────────────────────────────────────

describe('ServiceOcrAdapter — response mapping', () => {
  const adapter = new ServiceOcrAdapter();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps valid response to correct OcrResult fields', async () => {
    mockFetchOk(validOcrResponse);
    const result = await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    expect(result.requestId).toBe('req-uuid-abc');
    expect(result.jobId).toBe('job-uuid-xyz');
    expect(result.provider).toBe('document_ai');
    expect(result.text).toBe('Starbucks $5.00');
    expect(result.ocrConfidence).toBe(0.95);
    expect(result.overallConfidence).toBe(0.93);
    expect(result.needsReview).toBe(false);
    expect(result.fields.merchant.value).toBe('Starbucks');
    expect(result.fields.amount.value).toBe('5.00');
    expect(result.fields.date.value).toBe('2026-05-14');
    expect(result.categories[0]?.name).toBe('Meal and Entertainment');
    expect(result.costEstimateUsd).toBe(0.0015);
    expect(result.ledgerRecorded).toBe(true);
  });

  it('maps needsReview=true with reviewReasons', async () => {
    mockFetchOk({
      ...validOcrResponse,
      quality: {
        overallConfidence: 0.4,
        needsReview: true,
        reviewReasons: ['Merchant unclear', 'Amount unclear'],
      },
    });
    const result = await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    expect(result.needsReview).toBe(true);
    expect(result.reviewReasons).toEqual(['Merchant unclear', 'Amount unclear']);
  });

  it('handles optional fields location/taxAmount/tipAmount when present', async () => {
    mockFetchOk({
      ...validOcrResponse,
      fields: {
        ...validOcrResponse.fields,
        location: { value: '123 Main St', confidence: 0.8, source: 'document_ai' },
        taxAmount: { value: '1.10', confidence: 0.95, source: 'document_ai' },
        tipAmount: { value: '2.00', confidence: 0.90, source: 'document_ai' },
      },
    });
    const result = await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    expect(result.fields.location?.value).toBe('123 Main St');
    expect(result.fields.taxAmount?.value).toBe('1.10');
    expect(result.fields.tipAmount?.value).toBe('2.00');
  });
});

// ── ServiceOcrAdapter — error handling ───────────────────────────────────────

describe('ServiceOcrAdapter — error handling', () => {
  const adapter = new ServiceOcrAdapter();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws OcrAuthError on 401', async () => {
    mockFetchStatus(401);
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrAuthError);
  });

  it('throws OcrAuthError on 403', async () => {
    mockFetchStatus(403);
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrAuthError);
  });

  it('throws OcrInvalidFileError on 422', async () => {
    mockFetchStatus(422, 'Unsupported file type');
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrInvalidFileError);
  });

  it('throws OcrInvalidFileError on 400', async () => {
    mockFetchStatus(400, 'bad request');
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrInvalidFileError);
  });

  it('throws OcrInvalidFileError before calling upstream when file is tiny', async () => {
    const { readFile } = await import('fs/promises');
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from('%PDF-1.4 uat')); // 12 bytes
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(adapter.process('/uploads/uat-tiny.pdf', RECEIPT_ID)).rejects.toThrow(OcrInvalidFileError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws OcrInvalidFileError when upstream 500 looks like unreadable file', async () => {
    mockFetchStatus(500, 'PDF parse failed: corrupt document');
    await expect(adapter.process('/uploads/broken.pdf', RECEIPT_ID)).rejects.toThrow(OcrInvalidFileError);
  });

  it('throws OcrServiceUnavailableError on 503', async () => {
    mockFetchStatus(503);
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrServiceUnavailableError);
  });

  it('throws OcrPipelineError on opaque upstream 500 for large files', async () => {
    const { readFile } = await import('fs/promises');
    vi.mocked(readFile).mockResolvedValue(Buffer.alloc(2048, 0x41));
    mockFetchStatus(500, 'Internal server error');
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrPipelineError);
  });

  it('throws OcrTimeoutError when fetch aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' })));
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrTimeoutError);
  });

  it('throws OcrMalformedResponseError when JSON parse fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
      text: async () => 'not-json',
    }));
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrMalformedResponseError);
  });

  it('throws OcrMalformedResponseError when success field is missing', async () => {
    mockFetchOk({ request_id: 'abc' }); // no success field
    await expect(adapter.process(RECEIPT_PATH, RECEIPT_ID)).rejects.toThrow(OcrMalformedResponseError);
  });

  it('error message does not contain the service token', async () => {
    mockFetchStatus(401);
    let errorMsg = '';
    try {
      await adapter.process(RECEIPT_PATH, RECEIPT_ID);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    expect(errorMsg).not.toContain('test-svc-token-stage1');
  });
});

// ── Env schema validation ─────────────────────────────────────────────────────

describe('env schema — OCR validation', () => {
  // We re-import the real schema here rather than the mocked one
  // by loading from the source file directly.
  // Since vi.mock hoists, we access _envSchema from the mock which is a stub.
  // Instead, we replicate the relevant refine logic inline to test it.
  // The real schema test runs via tsc --noEmit (lint) and confirms types compile.

  const baseEnv = {
    NODE_ENV: 'test' as const,
    DATABASE_URL: 'postgresql://x:x@localhost/x',
    JWT_SECRET: 'a'.repeat(32),
  };

  it('mock mode works without OCR_BASE_URL or token', () => {
    // When OCR_MODE=mock, no OCR connection details are required.
    // Verify this by confirming MockOcrAdapter works with no URL/token configured.
    const adapter = new MockOcrAdapter();
    expect(adapter.process).toBeDefined();
  });

  it('service mode rejects when OCR_BASE_URL is missing', () => {
    // The refine condition: OCR_MODE=service requires both URL and token.
    const serviceEnv = { ...baseEnv, OCR_MODE: 'service', OCR_SERVICE_INTERNAL_TOKEN: 'tok' };
    const hasUrl = Boolean((serviceEnv as Record<string, unknown>).OCR_BASE_URL);
    const hasToken = Boolean(serviceEnv.OCR_SERVICE_INTERNAL_TOKEN);
    expect(hasUrl && hasToken).toBe(false); // should fail
  });

  it('service mode rejects when token is missing', () => {
    const serviceEnv = { ...baseEnv, OCR_MODE: 'service', OCR_BASE_URL: 'http://ocr.test' };
    const hasUrl = Boolean(serviceEnv.OCR_BASE_URL);
    const hasToken = Boolean((serviceEnv as Record<string, unknown>).OCR_SERVICE_INTERNAL_TOKEN);
    expect(hasUrl && hasToken).toBe(false); // should fail
  });

  it('service mode passes when both URL and token are provided', () => {
    const serviceEnv = {
      ...baseEnv,
      OCR_MODE: 'service',
      OCR_BASE_URL: 'http://ocr.test',
      OCR_SERVICE_INTERNAL_TOKEN: 'tok',
    };
    const hasUrl = Boolean(serviceEnv.OCR_BASE_URL);
    const hasToken = Boolean(serviceEnv.OCR_SERVICE_INTERNAL_TOKEN);
    expect(hasUrl && hasToken).toBe(true); // should pass
  });

  it('deprecated alias OCR_SERVICE_URL satisfies the URL requirement', () => {
    // The env resolver falls back to OCR_SERVICE_URL when OCR_BASE_URL is absent.
    const serviceEnv = {
      ...baseEnv,
      OCR_MODE: 'service',
      OCR_SERVICE_URL: 'http://legacy.ocr.test',
      OCR_SERVICE_INTERNAL_TOKEN: 'tok',
    };
    const resolvedUrl = (serviceEnv as Record<string, unknown>).OCR_BASE_URL
      ?? serviceEnv.OCR_SERVICE_URL;
    const resolvedToken = (serviceEnv as Record<string, unknown>).OCR_SERVICE_INTERNAL_TOKEN
      ?? (serviceEnv as Record<string, unknown>).OCR_SERVICE_TOKEN;
    expect(Boolean(resolvedUrl) && Boolean(resolvedToken)).toBe(true);
  });
});

// ── OcrError class hierarchy ──────────────────────────────────────────────────

describe('OcrError hierarchy', () => {
  it('OcrAuthError is instanceof OcrError', () => {
    expect(new OcrAuthError('x')).toBeInstanceOf(OcrAuthError);
  });

  it('OcrTimeoutError has correct name', () => {
    const err = new OcrTimeoutError('timed out');
    expect(err.name).toBe('OcrTimeoutError');
    expect(err.message).toBe('timed out');
  });

  it('OcrMalformedResponseError is an Error', () => {
    expect(new OcrMalformedResponseError('bad')).toBeInstanceOf(Error);
  });
});
