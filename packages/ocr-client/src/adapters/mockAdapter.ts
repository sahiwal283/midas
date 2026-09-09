import type { OcrAdapter, OcrField, OcrLineItem, OcrProcessOptions, OcrResult } from '../types';

function nullField(source: OcrField['source'] = 'llm'): OcrField {
  return { value: null, confidence: 0, source };
}

/** Fixed sample lines, so mock-mode dev and tests exercise the PO path. */
const MOCK_PO_LINE_ITEMS: OcrLineItem[] = [
  { description: 'Booth carpet 10x10', quantity: 1, unit: 'ea', unitPrice: 420, tax: 0, total: 420, confidence: 0.94 },
  { description: 'Electrical drop 500w', quantity: 2, unit: 'ea', unitPrice: 90, tax: 0, total: 180, confidence: 0.88 },
  { description: 'Drayage handling', quantity: 1, unit: 'ea', unitPrice: 275, tax: 0, total: 275, confidence: 0.61 },
];

/** Returns fixed synthetic data — no network calls, no cost, safe as the default everywhere. */
export class MockOcrAdapter implements OcrAdapter {
  async process(
    _filePath: string,
    _receiptId: string,
    opts?: OcrProcessOptions,
  ): Promise<OcrResult> {
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
      lineItems: opts?.workflow === 'purchase-order' ? MOCK_PO_LINE_ITEMS : undefined,
      categories: [{ name: 'Other', score: 0.6 }],
      costEstimateUsd: null,
      ledgerRecorded: false,
    };
  }
}
