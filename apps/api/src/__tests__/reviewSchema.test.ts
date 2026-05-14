import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Mirror of the schema from accountant.ts — keep in sync if the route changes.
const REQUEST_TYPES = ['info_request', 'missing_receipt', 'missing_category', 'missing_payment_method', 'general'] as const;

const reviewSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    note: z.string().optional(),
    zohoEntity: z.string().optional(),
  }),
  z.object({
    action: z.literal('reject'),
    note: z.string().optional(),
  }),
  z.object({
    action: z.literal('request_info'),
    note: z.string().min(1, 'Explain what information is needed'),
    requestType: z.enum(REQUEST_TYPES).default('info_request'),
    internalNote: z.string().optional(),
  }),
]);

describe('reviewSchema — approve action', () => {
  it('parses a minimal approve', () => {
    const result = reviewSchema.parse({ action: 'approve' });
    expect(result.action).toBe('approve');
  });

  it('parses approve with optional note and zohoEntity', () => {
    const result = reviewSchema.parse({ action: 'approve', note: 'Looks good', zohoEntity: 'Corporate AMEX' });
    expect(result.action).toBe('approve');
    if (result.action === 'approve') {
      expect(result.note).toBe('Looks good');
      expect(result.zohoEntity).toBe('Corporate AMEX');
    }
  });

  it('rejects approve with unknown fields (passthrough check)', () => {
    // strip mode: unknown keys are stripped, not an error
    const result = reviewSchema.parse({ action: 'approve', unknownField: 'x' });
    expect(result.action).toBe('approve');
    expect('unknownField' in result).toBe(false);
  });
});

describe('reviewSchema — reject action', () => {
  it('parses a minimal reject', () => {
    const result = reviewSchema.parse({ action: 'reject' });
    expect(result.action).toBe('reject');
  });

  it('parses reject with optional note', () => {
    const result = reviewSchema.parse({ action: 'reject', note: 'Duplicate expense' });
    expect(result.action).toBe('reject');
    if (result.action === 'reject') expect(result.note).toBe('Duplicate expense');
  });
});

describe('reviewSchema — request_info action', () => {
  it('parses a valid request_info with note', () => {
    const result = reviewSchema.parse({ action: 'request_info', note: 'Please upload receipt' });
    expect(result.action).toBe('request_info');
    if (result.action === 'request_info') {
      expect(result.requestType).toBe('info_request'); // default
      expect(result.note).toBe('Please upload receipt');
    }
  });

  it('defaults requestType to info_request when omitted', () => {
    const result = reviewSchema.parse({ action: 'request_info', note: 'What is this for?' });
    if (result.action === 'request_info') {
      expect(result.requestType).toBe('info_request');
    }
  });

  it('accepts all valid requestType values', () => {
    const validTypes: typeof REQUEST_TYPES[number][] = [
      'info_request', 'missing_receipt', 'missing_category', 'missing_payment_method', 'general',
    ];
    for (const requestType of validTypes) {
      const result = reviewSchema.parse({ action: 'request_info', note: 'Test', requestType });
      if (result.action === 'request_info') {
        expect(result.requestType).toBe(requestType);
      }
    }
  });

  it('rejects request_info with an empty note', () => {
    expect(() => reviewSchema.parse({ action: 'request_info', note: '' })).toThrow();
  });

  it('rejects request_info with a missing note', () => {
    expect(() => reviewSchema.parse({ action: 'request_info' })).toThrow();
  });

  it('rejects request_info with an invalid requestType', () => {
    expect(() =>
      reviewSchema.parse({ action: 'request_info', note: 'Test', requestType: 'invalid_type' })
    ).toThrow();
  });

  it('accepts internalNote on request_info', () => {
    const result = reviewSchema.parse({
      action: 'request_info',
      note: 'Please upload receipt',
      internalNote: 'This is the third time we asked',
    });
    if (result.action === 'request_info') {
      expect(result.internalNote).toBe('This is the third time we asked');
    }
  });

  it('allows internalNote to be omitted', () => {
    const result = reviewSchema.parse({ action: 'request_info', note: 'Test' });
    if (result.action === 'request_info') {
      expect(result.internalNote).toBeUndefined();
    }
  });
});

describe('reviewSchema — discriminator', () => {
  it('rejects an unknown action', () => {
    expect(() => reviewSchema.parse({ action: 'unknown_action' })).toThrow();
  });

  it('rejects a missing action', () => {
    expect(() => reviewSchema.parse({ note: 'hi' })).toThrow();
  });

  it('does not allow approve fields on reject', () => {
    // zohoEntity is unknown for reject — should be stripped
    const result = reviewSchema.parse({ action: 'reject', zohoEntity: 'Corp' });
    expect(result.action).toBe('reject');
    expect('zohoEntity' in result).toBe(false);
  });
});
