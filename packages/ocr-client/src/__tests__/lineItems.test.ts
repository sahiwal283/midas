import { describe, expect, it } from 'vitest';
import { MockOcrAdapter } from '../adapters/mockAdapter';
import { normalizeLineItems } from '../adapters/serviceAdapter';

describe('normalizeLineItems', () => {
  it('returns undefined when the service sent nothing', () => {
    expect(normalizeLineItems(undefined)).toBeUndefined();
    expect(normalizeLineItems(null)).toBeUndefined();
  });

  it('returns undefined when line_items is not an array', () => {
    expect(normalizeLineItems('carpet, drayage')).toBeUndefined();
  });

  it('maps a well-formed line', () => {
    expect(normalizeLineItems([{
      description: 'Booth carpet 10x10',
      quantity: 2,
      unit: 'ea',
      unitPrice: 210,
      tax: 12.5,
      total: 432.5,
      confidence: 0.91,
    }])).toEqual([{
      description: 'Booth carpet 10x10',
      quantity: 2,
      unit: 'ea',
      unitPrice: 210,
      tax: 12.5,
      total: 432.5,
      confidence: 0.91,
    }]);
  });

  it('nulls out non-numeric values rather than trusting them', () => {
    const [line] = normalizeLineItems([
      { description: 'Mystery', quantity: 'lots', total: null, confidence: 'high' },
    ])!;
    expect(line.quantity).toBeNull();
    expect(line.total).toBeNull();
    expect(line.confidence).toBe(0);
  });

  it('skips entries that are not objects or have no description', () => {
    const result = normalizeLineItems([
      'nope',
      { total: 5 },
      { description: '   ' },
      { description: 'Real line', total: 5 },
    ]);
    expect(result).toEqual([{
      description: 'Real line',
      quantity: null,
      unit: null,
      unitPrice: null,
      tax: null,
      total: 5,
      confidence: 0,
    }]);
  });

  it('returns undefined when every entry was skipped', () => {
    expect(normalizeLineItems([{ total: 1 }])).toBeUndefined();
  });
});

describe('MockOcrAdapter purchase-order mode', () => {
  it('returns no line items for the default receipt workflow', async () => {
    const result = await new MockOcrAdapter().process('/tmp/r.jpg', 'receipt-1');
    expect(result.lineItems).toBeUndefined();
  });

  it('returns deterministic line items under the purchase-order workflow', async () => {
    const result = await new MockOcrAdapter()
      .process('/tmp/r.jpg', 'receipt-1', { workflow: 'purchase-order' });

    expect(result.lineItems).toHaveLength(3);
    expect(result.lineItems![0].description).toBe('Booth carpet 10x10');
    expect(result.lineItems!.every((li) => li.confidence > 0)).toBe(true);
  });

  it('is stable across calls so tests can assert on it', async () => {
    const adapter = new MockOcrAdapter();
    const a = await adapter.process('/tmp/r.jpg', 'r1', { workflow: 'purchase-order' });
    const b = await adapter.process('/tmp/r.jpg', 'r2', { workflow: 'purchase-order' });
    expect(a.lineItems).toEqual(b.lineItems);
  });
});
