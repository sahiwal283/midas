import { describe, expect, it } from 'vitest';
import { lineDraftsFromOcr, poHeaderFromOcr } from './ocrLineItems';

const CATALOGUE = [
  { itemId: 'i1', name: 'Booth Carpet 10x10', sku: 'CARPET-1010' },
  { itemId: 'i3', name: 'Drayage Handling', sku: 'DRAY-01' },
];

const OCR = {
  fields: {
    merchant: { value: 'Acme Expo Services', confidence: 0.93 },
    date: { value: '2026-09-01', confidence: 0.9 },
    taxAmount: { value: '31.20', confidence: 0.8 },
  },
  lineItems: [
    { description: 'Booth carpet 10x10', quantity: 1, unit: 'ea', unitPrice: 420, tax: 0, total: 420, confidence: 0.94 },
    { description: 'Forklift deposit', quantity: 1, unit: null, unitPrice: 150, tax: 0, total: 150, confidence: 0.55 },
  ],
};

describe('lineDraftsFromOcr', () => {
  it('returns an empty array when there is no OCR data at all', () => {
    expect(lineDraftsFromOcr(null, CATALOGUE)).toEqual([]);
    expect(lineDraftsFromOcr({}, CATALOGUE)).toEqual([]);
  });

  it('numbers lines from one', () => {
    const drafts = lineDraftsFromOcr(OCR, CATALOGUE);
    expect(drafts.map((d) => d.lineNumber)).toEqual([1, 2]);
  });

  it('carries description, qty, unit and price across as strings', () => {
    const [first] = lineDraftsFromOcr(OCR, CATALOGUE);
    expect(first.description).toBe('Booth carpet 10x10');
    expect(first.quantity).toBe('1');
    expect(first.unit).toBe('ea');
    expect(first.unitPrice).toBe('420');
  });

  it('preselects a confidently matched Zoho item', () => {
    const [first] = lineDraftsFromOcr(OCR, CATALOGUE);
    expect(first.zohoItemId).toBe('i1');
    expect(first.matchScore).toBeGreaterThan(0);
  });

  it('leaves an unmatched line for the user to pick', () => {
    const [, second] = lineDraftsFromOcr(OCR, CATALOGUE);
    expect(second.zohoItemId).toBe('');
    expect(second.matchScore).toBeNull();
  });

  it('keeps the OCR confidence so the UI can flag a weak line', () => {
    const [first, second] = lineDraftsFromOcr(OCR, CATALOGUE);
    expect(first.ocrConfidence).toBe(0.94);
    expect(second.ocrConfidence).toBe(0.55);
  });

  it('recomputes the line total from qty and price rather than trusting OCR arithmetic', () => {
    const drafts = lineDraftsFromOcr({
      lineItems: [{ description: 'Carpet', quantity: 3, unitPrice: 100, tax: 5, total: 999 }],
    }, CATALOGUE);
    expect(drafts[0].total).toBe('305.00');
  });

  it('defaults missing numbers to a usable draft rather than blank', () => {
    const drafts = lineDraftsFromOcr({
      lineItems: [{ description: 'Mystery', quantity: null, unitPrice: null, tax: null, total: null }],
    }, CATALOGUE);
    expect(drafts[0].quantity).toBe('1');
    expect(drafts[0].unitPrice).toBe('0');
    expect(drafts[0].tax).toBe('0');
  });

  it('derives the unit price from a lump-sum line rather than zeroing its total', () => {
    const [line] = lineDraftsFromOcr({
      lineItems: [{ description: 'Drayage handling', quantity: null, unitPrice: null, tax: null, total: 275.0 }],
    }, CATALOGUE);
    expect(line.quantity).toBe('1');
    expect(line.unitPrice).toBe('275');
    expect(line.total).toBe('275.00');
  });

  it('splits a total across the quantity when deriving the unit price', () => {
    const [line] = lineDraftsFromOcr({
      lineItems: [{ description: 'Booth carpet 10x10', quantity: 4, unitPrice: null, total: 300 }],
    }, CATALOGUE);
    expect(line.unitPrice).toBe('75');
    expect(line.total).toBe('300.00');
  });

  it('takes tax out of the total before deriving the unit price', () => {
    const [line] = lineDraftsFromOcr({
      lineItems: [{ description: 'Drayage handling', quantity: 2, unitPrice: null, tax: 20, total: 220 }],
    }, CATALOGUE);
    expect(line.unitPrice).toBe('100');
    expect(line.total).toBe('220.00');
  });

  it('keeps the derived total agreeing with its own line when the split is uneven', () => {
    const [line] = lineDraftsFromOcr({
      lineItems: [{ description: 'Drayage handling', quantity: 3, unitPrice: null, total: 275 }],
    }, CATALOGUE);
    // Rounded to the four decimals unit_price stores; the recomputed total
    // still reads back as the 275.00 OCR saw.
    expect(line.unitPrice).toBe('91.6667');
    expect(line.total).toBe('275.00');
  });

  it('still recomputes from the price when OCR gave both a price and a total', () => {
    const [line] = lineDraftsFromOcr({
      lineItems: [{ description: 'Carpet', quantity: 2, unitPrice: 100, tax: 0, total: 999 }],
    }, CATALOGUE);
    expect(line.unitPrice).toBe('100');
    expect(line.total).toBe('200.00');
  });

  it('falls back to a zero price when a total is quoted against no quantity', () => {
    const [line] = lineDraftsFromOcr({
      lineItems: [{ description: 'Mystery', quantity: 0, unitPrice: null, total: 275 }],
    }, CATALOGUE);
    expect(line.unitPrice).toBe('0');
  });

  it('matches against an empty catalogue without throwing', () => {
    expect(lineDraftsFromOcr(OCR, [])[0].zohoItemId).toBe('');
  });

  it('treats a null entry in lineItems as an empty line rather than throwing', () => {
    expect(() => lineDraftsFromOcr({ lineItems: [null] }, CATALOGUE)).not.toThrow();
    const [first] = lineDraftsFromOcr({ lineItems: [null] }, CATALOGUE);
    expect(first.description).toBe('');
    expect(first.zohoItemId).toBe('');
  });

  it('treats an undefined entry in lineItems as an empty line rather than throwing', () => {
    expect(() => lineDraftsFromOcr({ lineItems: [undefined] }, CATALOGUE)).not.toThrow();
    const [first] = lineDraftsFromOcr({ lineItems: [undefined] }, CATALOGUE);
    expect(first.description).toBe('');
    expect(first.zohoItemId).toBe('');
  });
});

describe('poHeaderFromOcr', () => {
  it('returns empty values when there is no OCR data', () => {
    expect(poHeaderFromOcr(null)).toEqual({ vendorName: '', transactionDate: '', taxTotal: '' });
  });

  it('reads vendor, date and tax off the fields block', () => {
    expect(poHeaderFromOcr(OCR)).toEqual({
      vendorName: 'Acme Expo Services',
      transactionDate: '2026-09-01',
      taxTotal: '31.20',
    });
  });

  it('skips a date that is not an ISO day', () => {
    expect(poHeaderFromOcr({ fields: { date: { value: 'Sept 1st' } } }).transactionDate).toBe('');
  });

  it('ignores fields the engine returned as null', () => {
    expect(poHeaderFromOcr({ fields: { merchant: { value: null } } }).vendorName).toBe('');
  });
});
