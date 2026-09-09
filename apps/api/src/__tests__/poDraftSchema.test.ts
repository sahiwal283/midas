import { describe, expect, it } from 'vitest';
import { createPoSchema } from '../lib/poSchemas';

const BASE = { transactionDate: '2026-09-08' };

describe('createPoSchema', () => {
  it('accepts a draft with no vendor name yet', () => {
    const parsed = createPoSchema.parse(BASE);
    expect(parsed.vendorName).toBe('');
    expect(parsed.lineItems).toEqual([]);
  });

  it('accepts an explicitly empty vendor name', () => {
    expect(createPoSchema.parse({ ...BASE, vendorName: '' }).vendorName).toBe('');
  });

  it('still accepts a fully-specified purchase order', () => {
    const parsed = createPoSchema.parse({
      ...BASE,
      vendorName: 'Acme Expo',
      lineItems: [{
        lineNumber: 1, description: 'Booth carpet', quantity: 1,
        unitPrice: 420, total: 420,
      }],
    });
    expect(parsed.vendorName).toBe('Acme Expo');
    expect(parsed.lineItems).toHaveLength(1);
  });

  it('still rejects a missing transaction date', () => {
    expect(() => createPoSchema.parse({ vendorName: 'Acme' })).toThrow();
  });

  it('still rejects a malformed transaction date', () => {
    expect(() => createPoSchema.parse({ ...BASE, transactionDate: '09/08/2026' })).toThrow();
  });

  it('still rejects a line item with no description', () => {
    expect(() => createPoSchema.parse({
      ...BASE,
      lineItems: [{ lineNumber: 1, description: '', quantity: 1, unitPrice: 1, total: 1 }],
    })).toThrow();
  });
});
