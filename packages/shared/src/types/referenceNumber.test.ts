import { describe, it, expect } from 'vitest';
import { normalizeReferenceNumber, pickReferenceNumber } from './referenceNumber';

describe('normalizeReferenceNumber', () => {
  it('trims, rejects empty, and caps at 50 characters', () => {
    expect(normalizeReferenceNumber('  INV-1  ')).toBe('INV-1');
    expect(normalizeReferenceNumber('   ')).toBeNull();
    expect(normalizeReferenceNumber('x'.repeat(60))).toBe('x'.repeat(50));
  });
});

describe('pickReferenceNumber', () => {
  it('prefers an explicit OCR field over scanning the text', () => {
    expect(pickReferenceNumber({
      field: 'SO-9',
      text: 'Invoice # INV-1\nReceipt # 555',
    })).toBe('SO-9');
  });

  it('prefers invoice number, then receipt number, then order number', () => {
    expect(pickReferenceNumber({
      text: 'Receipt #: 8888\nInvoice # INV-42\nOrder 4500',
    })).toBe('INV-42');
    expect(pickReferenceNumber({ text: 'Receipt #: 02456' })).toBe('02456');
    expect(pickReferenceNumber({ text: 'Sales Order # 4500123' })).toBe('4500123');
  });

  it('does not treat "receipt total" as a receipt number', () => {
    expect(pickReferenceNumber({ text: 'Receipt Total $12.34' })).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(pickReferenceNumber({ text: 'Coffee and a bagel' })).toBeNull();
  });
});
