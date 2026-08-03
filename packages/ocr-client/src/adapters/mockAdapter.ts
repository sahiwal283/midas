import type { OcrAdapter, OcrField, OcrResult } from '../types';

function nullField(source: OcrField['source'] = 'llm'): OcrField {
  return { value: null, confidence: 0, source };
}

/** Returns fixed synthetic data — no network calls, no cost, safe as the default everywhere. */
export class MockOcrAdapter implements OcrAdapter {
  async process(_filePath: string, _receiptId: string): Promise<OcrResult> {
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
