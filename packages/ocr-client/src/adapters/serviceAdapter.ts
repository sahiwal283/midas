import { readFile } from 'fs/promises';
import { extname, basename } from 'path';
import {
  OcrAuthError,
  OcrInvalidFileError,
  OcrMalformedResponseError,
  OcrPipelineError,
  OcrServiceUnavailableError,
  OcrTimeoutError,
} from '../errors';
import { cleanupPreparedFiles, prepareReceiptImageForOcr } from '../preprocessing';
import { RuleBasedInferenceEngine } from '../inference/ruleBasedInferenceEngine';
import type { CategoryKeywordMap, OcrAdapter, OcrField, OcrResult } from '../types';

export interface ServiceOcrAdapterConfig {
  baseUrl: string;
  internalToken: string;
  timeoutMs?: number;
  clientApp?: string;
  workflow?: string;
  externalRefType?: string;
  /**
   * When true (default), weak/empty fields returned by the OCR engine are
   * supplemented with the rule-based inference engine's read of the raw OCR text.
   * Disable only for testing — every production embedder should leave this on so
   * behavior matches the original combined pipeline.
   */
  enableRuleInferenceFallback?: boolean;
  /** Override the default category taxonomy used by the rule-based fallback. */
  categoryKeywords?: CategoryKeywordMap;
}

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

/** Minimum size for a plausible receipt image/PDF (UAT tiny fixtures are ~12 bytes). */
const MIN_RECEIPT_BYTES = 64;

async function assertReadableReceiptFile(filePath: string): Promise<void> {
  const fileBuffer = await readFile(filePath);
  if (fileBuffer.length < MIN_RECEIPT_BYTES) {
    throw new OcrInvalidFileError(
      `File too small to be a valid receipt (${fileBuffer.length} bytes; minimum ${MIN_RECEIPT_BYTES})`,
    );
  }

  const ext = extname(filePath).toLowerCase();
  const head = fileBuffer.subarray(0, 8).toString('latin1');
  const looksPdf = ext === '.pdf' || head.startsWith('%PDF');
  if (looksPdf && !head.startsWith('%PDF')) {
    throw new OcrInvalidFileError('Invalid PDF: missing %PDF header');
  }
}

function looksLikeInvalidFileFailure(detail: string, byteLength: number): boolean {
  if (byteLength < 1024) return true;
  const d = detail.toLowerCase();
  return (
    d.includes('pdf')
    || d.includes('corrupt')
    || d.includes('invalid')
    || d.includes('cannot identify')
    || d.includes('no images')
    || d.includes('empty file')
    || d.includes('unsupported')
  );
}

function nullField(source: OcrField['source'] = 'llm'): OcrField {
  return { value: null, confidence: 0, source };
}

/**
 * Talks to services/ocr-engine (the canonical Midas OCR engine). Every consumer —
 * standalone Midas, embedded Midas, or a direct integration — should use this
 * adapter rather than calling the engine's HTTP API directly, so preprocessing
 * and fallback field inference are always applied identically.
 */
export class ServiceOcrAdapter implements OcrAdapter {
  private readonly inferenceEngine: RuleBasedInferenceEngine;
  private readonly enableRuleInferenceFallback: boolean;

  constructor(private readonly config: ServiceOcrAdapterConfig) {
    if (!config.baseUrl) throw new OcrServiceUnavailableError('OCR base URL is not configured');
    if (!config.internalToken) throw new OcrServiceUnavailableError('OCR internal token is not configured');
    this.enableRuleInferenceFallback = config.enableRuleInferenceFallback ?? true;
    this.inferenceEngine = new RuleBasedInferenceEngine(config.categoryKeywords);
  }

  async process(filePath: string, receiptId: string): Promise<OcrResult> {
    // Reject clearly invalid inputs before paying for / hitting upstream OCR.
    // Upstream currently returns 500 for corrupt/minimal PDFs; map those here as 4xx-class errors.
    await assertReadableReceiptFile(filePath);

    const { pathForRequest, cleanup } = await prepareReceiptImageForOcr(filePath);
    try {
      const raw = await this.postFile(pathForRequest, receiptId);
      const result = mapResponse(raw);
      return this.enableRuleInferenceFallback ? await this.enrichWithRuleInference(result) : result;
    } finally {
      cleanupPreparedFiles(filePath, cleanup);
    }
  }

  private async postFile(filePath: string, receiptId: string): Promise<unknown> {
    const { baseUrl, internalToken, timeoutMs = 120000, clientApp = 'midas', workflow = 'receipt-ocr', externalRefType = 'expense_receipt' } = this.config;

    const fileBuffer = await readFile(filePath);
    const blob = new Blob([fileBuffer], { type: inferMimeType(filePath) });
    const form = new FormData();
    form.append('file', blob, basename(filePath));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/ocr/`, {
        method: 'POST',
        headers: {
          'X-Internal-Token': internalToken,
          'X-Client-App': clientApp,
          'X-Workflow': workflow,
          'X-External-Reference-Type': externalRefType,
          'X-External-Reference-ID': `receipt:${receiptId}`,
        },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'timeout')) {
        throw new OcrTimeoutError(`OCR request timed out after ${timeoutMs}ms`);
      }
      throw new OcrServiceUnavailableError('OCR service unreachable');
    }
    clearTimeout(timeoutId);

    if (res.status === 401 || res.status === 403) {
      throw new OcrAuthError(`OCR service returned ${res.status} — check the internal token`);
    }
    if (res.status === 400 || res.status === 413 || res.status === 415 || res.status === 422) {
      const detail = await res.text().catch(() => '');
      throw new OcrInvalidFileError(
        `OCR service rejected the file (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }
    if (res.status === 503) {
      throw new OcrServiceUnavailableError('OCR service unavailable (503)');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Upstream OCR engine often returns 500 for corrupt/unreadable PDFs instead of 4xx.
      if (res.status >= 500 && looksLikeInvalidFileFailure(detail, fileBuffer.length)) {
        throw new OcrInvalidFileError(
          `OCR service could not read the file (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        );
      }
      throw new OcrPipelineError(
        `OCR pipeline error (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }

    try {
      return await res.json();
    } catch {
      throw new OcrMalformedResponseError('OCR response was not valid JSON');
    }
  }

  /**
   * Verbatim merge rules from expense-app
   * `receiptExternalOcr.enrichOcrApiResultWithRuleInference`.
   */
  private async enrichWithRuleInference(result: OcrResult): Promise<OcrResult> {
    if (!result.text || result.text.trim().length < 3) return result;

    const inferred = await this.inferenceEngine.infer({
      text: result.text,
      confidence: result.ocrConfidence,
      provider: result.provider,
    });
    const fields = { ...result.fields };
    const overall = result.overallConfidence;

    const unwrapField = (f: unknown): unknown => {
      if (f == null) return null;
      if (typeof f === 'object' && f !== null && 'value' in f) return (f as { value: unknown }).value;
      return f;
    };

    const fieldConfidence = (ext: unknown, hasValue: boolean): number => {
      if (ext && typeof ext === 'object' && typeof (ext as { confidence?: unknown }).confidence === 'number') {
        return (ext as { confidence: number }).confidence;
      }
      return hasValue ? 0.65 : 0;
    };

    const toFieldValue = (v: unknown): string => {
      // Expense-app keeps numbers as numbers in its API response; Midas OcrField
      // is string-typed, so stringify without forcing currency padding.
      return typeof v === 'number' ? String(v) : String(v);
    };

    const pick = (key: keyof typeof fields) => {
      const ext = fields[key];
      const inf = inferred[key as keyof typeof inferred] as { value: unknown; confidence: number } | undefined;
      if (!inf) return;

      const ev = unwrapField(ext);
      const iv = inf.value;
      const hasEv =
        ev != null &&
        ev !== '' &&
        !(typeof ev === 'number' && !isFinite(ev));
      const hasIv =
        iv != null &&
        iv !== '' &&
        !(typeof iv === 'number' && !isFinite(iv));

      const ec = fieldConfidence(ext, hasEv);
      const ic = typeof inf.confidence === 'number' ? inf.confidence : 0;

      const extWeak =
        !hasEv ||
        ec < 0.45 ||
        (typeof overall === 'number' && overall < 0.48);

      if (hasIv && extWeak) {
        fields[key] = { value: toFieldValue(iv), confidence: ic, source: 'inference' };
        return;
      }
      if (hasIv && hasEv && ic > ec + 0.08) {
        fields[key] = { value: toFieldValue(iv), confidence: ic, source: 'inference' };
      }
    };

    pick('merchant');
    pick('amount');
    pick('date');
    pick('category');
    pick('location');

    return { ...result, fields };
  }
}

function mapResponse(raw: unknown): OcrResult {
  if (typeof raw !== 'object' || raw === null || !(raw as Record<string, unknown>).success) {
    throw new OcrMalformedResponseError('OCR response missing required "success" field');
  }

  const r = raw as Record<string, unknown>;
  const ocr = (r.ocr ?? {}) as Record<string, unknown>;
  const quality = (r.quality ?? {}) as Record<string, unknown>;
  const cost = (r.cost ?? {}) as Record<string, unknown>;
  const rawFields = (r.fields ?? {}) as Record<string, unknown>;

  const field = (key: string): OcrField => {
    const f = rawFields[key];
    if (f && typeof f === 'object') {
      const ff = f as Record<string, unknown>;
      // Expense-app / OCR engine may return numeric amounts (and sometimes other
      // numeric fields). Dropping non-strings here made amount look empty and
      // incorrectly triggered rule-inference overwrite — breaking result parity.
      let value: string | null = null;
      if (typeof ff.value === 'string') value = ff.value;
      else if (typeof ff.value === 'number' && Number.isFinite(ff.value)) value = String(ff.value);
      return {
        value,
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
    ? (quality.reviewReasons as unknown[]).filter((x): x is string => typeof x === 'string')
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
      referenceNumber: rawFields.referenceNumber != null ? field('referenceNumber') : undefined,
    },
    categories,
    costEstimateUsd: typeof cost.estimated_usd === 'number' ? cost.estimated_usd : null,
    ledgerRecorded: cost.ledger_recorded === true,
  };
}
