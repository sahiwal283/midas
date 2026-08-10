// ── OCR engine response contract ────────────────────────────────────────────
// This shape is the wire contract with services/ocr-engine (POST /ocr/). It must stay
// in sync with that service's response format — see docs/OCR_ENGINE.md.

export interface OcrField {
  value: string | null;
  confidence: number;
  source: 'document_ai' | 'llm' | 'rule_based' | 'inference' | string;
}

export interface OcrLineItem {
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  tax: number | null;
  total: number | null;
  confidence: number;
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
  /** Normalized line items when the OCR engine extracts them (PO / detailed receipts). */
  lineItems?: OcrLineItem[];
  categories: Array<{ name: string; score: number }>;
  costEstimateUsd: number | null;
  ledgerRecorded: boolean;
}

export interface OcrAdapter {
  process(filePath: string, receiptId: string): Promise<OcrResult>;
}

// ── Rule-based field inference (client-side enrichment) ─────────────────────
// Used to supplement weak/empty fields when the OCR engine's own extraction is
// low-confidence. Ported from the receipt inference engine that both the web app
// and chat-bot integrations of the original expense system relied on, so every
// Midas embedder gets identical fallback behavior — not just the primary engine call.

export interface InferredOcrResult {
  text: string;
  confidence: number;
  provider: string;
}

export interface FieldValue<T> {
  value: T | null;
  confidence: number;
  source: 'ocr' | 'inference' | 'llm' | 'user';
  rawText?: string;
  alternatives?: Array<{ value: T; confidence: number }>;
}

export interface FieldInference {
  merchant: FieldValue<string>;
  amount: FieldValue<number>;
  date: FieldValue<string>;
  cardLastFour: FieldValue<string>;
  category: FieldValue<string>;
  location?: FieldValue<string>;
  taxAmount?: FieldValue<number>;
  tipAmount?: FieldValue<number>;
}

export interface CategorySuggestion {
  category: string;
  confidence: number;
  keywords: string[];
  source: 'rule-based' | 'llm' | 'user-history';
}

export interface CategoryKeywordRule {
  keywords: string[];
  weight: number;
}

export type CategoryKeywordMap = Record<string, CategoryKeywordRule>;
