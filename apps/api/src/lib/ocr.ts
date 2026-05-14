import { readFile } from 'fs/promises';
import { extname, basename } from 'path';
import { env } from '../config/env';
import { logger } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OcrField {
  value: string | null;
  confidence: number;
  source: 'document_ai' | 'llm' | 'rule_based' | string;
}

export interface OcrResult {
  requestId: string;
  jobId: string | null;
  provider: string;
  text: string;
  ocrConfidence: number;
  overallConfidence: number;
  needsReview: boolean;
  reviewReasons: string[] | null;
  fields: {
    merchant: OcrField;
    amount: OcrField;
    date: OcrField;
    cardLastFour: OcrField;
    category: OcrField;
    location?: OcrField;
    taxAmount?: OcrField;
    tipAmount?: OcrField;
  };
  categories: Array<{ name: string; score: number }>;
  costEstimateUsd: number | null;
  ledgerRecorded: boolean;
}

export interface OcrAdapter {
  process(filePath: string, receiptId: string): Promise<OcrResult>;
}

// ── Error hierarchy ───────────────────────────────────────────────────────────

export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class OcrAuthError extends OcrError {}
export class OcrInvalidFileError extends OcrError {}
export class OcrServiceUnavailableError extends OcrError {}
export class OcrPipelineError extends OcrError {}
export class OcrTimeoutError extends OcrError {}
export class OcrMalformedResponseError extends OcrError {}

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase().replace('.', '');
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

function nullField(source: OcrField['source'] = 'llm'): OcrField {
  return { value: null, confidence: 0, source };
}

// ── Mock adapter ──────────────────────────────────────────────────────────────

export class MockOcrAdapter implements OcrAdapter {
  async process(_filePath: string, receiptId: string): Promise<OcrResult> {
    logger.debug('OCR mock: returning fake data for receipt %s', receiptId);
    return {
      requestId: '00000000-0000-0000-0000-000000000001',
      jobId: null,
      provider: 'mock',
      text: '[OCR mock] Receipt text would appear here after real OCR processing.',
      ocrConfidence: 0.95,
      overallConfidence: 0.92,
      needsReview: false,
      reviewReasons: null,
      fields: {
        merchant: { value: 'Sample Merchant', confidence: 0.95, source: 'llm' },
        amount: { value: '42.00', confidence: 0.99, source: 'llm' },
        date: { value: new Date().toISOString().slice(0, 10), confidence: 0.98, source: 'llm' },
        cardLastFour: nullField(),
        category: { value: 'Other', confidence: 0.6, source: 'rule_based' },
      },
      categories: [{ name: 'Other', score: 0.6 }],
      costEstimateUsd: null,
      ledgerRecorded: false,
    };
  }
}

// ── Service adapter ───────────────────────────────────────────────────────────

export class ServiceOcrAdapter implements OcrAdapter {
  async process(filePath: string, receiptId: string): Promise<OcrResult> {
    const baseUrl = env.OCR_BASE_URL;
    if (!baseUrl) throw new OcrServiceUnavailableError('OCR_BASE_URL is not configured');
    const token = env.OCR_SERVICE_INTERNAL_TOKEN;
    if (!token) throw new OcrServiceUnavailableError('OCR_SERVICE_INTERNAL_TOKEN is not configured');

    const fileBuffer = await readFile(filePath);
    const blob = new Blob([fileBuffer], { type: inferMimeType(filePath) });
    const form = new FormData();
    form.append('file', blob, basename(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error('timeout')),
      env.OCR_TIMEOUT_MS,
    );

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/ocr/`, {
        method: 'POST',
        headers: {
          'X-Internal-Token': token,
          'X-Client-App': env.OCR_CLIENT_APP,
          'X-Workflow': env.OCR_WORKFLOW,
          'X-External-Reference-Type': env.OCR_EXTERNAL_REF_TYPE,
          'X-External-Reference-ID': `receipt:${receiptId}`,
        },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'timeout')) {
        throw new OcrTimeoutError(`OCR request timed out after ${env.OCR_TIMEOUT_MS}ms`);
      }
      throw new OcrServiceUnavailableError('OCR service unreachable');
    }
    clearTimeout(timeoutId);

    if (res.status === 401 || res.status === 403) {
      throw new OcrAuthError(`OCR service returned ${res.status} — check OCR_SERVICE_INTERNAL_TOKEN`);
    }
    if (res.status === 422) {
      const detail = await res.text().catch(() => '');
      throw new OcrInvalidFileError(`OCR service rejected the file (422)${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    if (res.status === 503) {
      throw new OcrServiceUnavailableError('OCR service unavailable (503) — ledger may be down');
    }
    if (!res.ok) {
      throw new OcrPipelineError(`OCR pipeline error (${res.status})`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new OcrMalformedResponseError('OCR response was not valid JSON');
    }

    return mapResponse(body);
  }
}

// ── Response mapper ───────────────────────────────────────────────────────────

function mapResponse(raw: unknown): OcrResult {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !(raw as Record<string, unknown>).success
  ) {
    throw new OcrMalformedResponseError('OCR response missing required "success" field');
  }

  const r = raw as Record<string, unknown>;
  const ocr = (r.ocr ?? {}) as Record<string, unknown>;
  const quality = (r.quality ?? {}) as Record<string, unknown>;
  const cost = (r.cost ?? {}) as Record<string, unknown>;
  const rawFields = (r.fields ?? {}) as Record<string, unknown>;

  const field = (key: string): OcrField => {
    const f = rawFields[key];
    if (f && typeof f === 'object' && f !== null) {
      const ff = f as Record<string, unknown>;
      return {
        value: typeof ff.value === 'string' ? ff.value : null,
        confidence: typeof ff.confidence === 'number' ? ff.confidence : 0,
        source: typeof ff.source === 'string' ? ff.source : 'llm',
      };
    }
    return nullField();
  };

  const rawCategories = Array.isArray(r.categories) ? r.categories : [];
  const categories = rawCategories
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({
      name: typeof c.name === 'string' ? c.name : '',
      score: typeof c.score === 'number' ? c.score : 0,
    }));

  const reviewReasons = Array.isArray(quality.reviewReasons)
    ? (quality.reviewReasons as unknown[]).filter((r): r is string => typeof r === 'string')
    : null;

  return {
    requestId: typeof r.request_id === 'string' ? r.request_id : '',
    jobId: typeof r.job_id === 'string' ? r.job_id : null,
    provider: typeof ocr.provider === 'string' ? ocr.provider : 'unknown',
    text: typeof ocr.text === 'string' ? ocr.text : '',
    ocrConfidence: typeof ocr.confidence === 'number' ? ocr.confidence : 0,
    overallConfidence: typeof quality.overallConfidence === 'number' ? quality.overallConfidence : 0,
    needsReview: quality.needsReview === true,
    reviewReasons: reviewReasons && reviewReasons.length > 0 ? reviewReasons : null,
    fields: {
      merchant: field('merchant'),
      amount: field('amount'),
      date: field('date'),
      cardLastFour: field('cardLastFour'),
      category: field('category'),
      location: rawFields.location != null ? field('location') : undefined,
      taxAmount: rawFields.taxAmount != null ? field('taxAmount') : undefined,
      tipAmount: rawFields.tipAmount != null ? field('tipAmount') : undefined,
    },
    categories,
    costEstimateUsd: typeof cost.estimated_usd === 'number' ? cost.estimated_usd : null,
    ledgerRecorded: cost.ledger_recorded === true,
  };
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const ocr: OcrAdapter =
  env.OCR_MODE === 'service' ? new ServiceOcrAdapter() : new MockOcrAdapter();
