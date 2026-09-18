import { describe, expect, it } from 'vitest';
import { diffOcrCorrections, lastFour, normalizeAmountCents, normalizeDate, normalizeText } from '../lib/ocrCorrections';

const submitted = { merchant: 'Uline', amount: '97.20', date: '2026-09-16', categoryName: 'Shipping Supplies', cardLastFour: '4242' };
// `source` is accepted (and ignored) here because production OCR field
// objects carry it; diffOcrCorrections no longer reads it — see below.
const f = (value: string | null, source = 'llm') => ({ value, source });

describe('normalizers', () => {
  it('normalizes amounts to cents', () => {
    expect(normalizeAmountCents('97.2')).toBe(9720);
    expect(normalizeAmountCents('$1,097.20')).toBe(109720);
    expect(normalizeAmountCents('')).toBeNull();
    expect(normalizeAmountCents(null)).toBeNull();
  });
  it('normalizes dates', () => {
    expect(normalizeDate('2026-09-16T00:00:00Z')).toBe('2026-09-16');
    expect(normalizeDate('09/16/2026')).toBe('2026-09-16');
    expect(normalizeDate('garbage')).toBeNull();
  });
  it('normalizes text and cards', () => {
    expect(normalizeText('  ULINE   Inc ')).toBe('uline inc');
    expect(lastFour('VISA ****4242')).toBe('4242');
    expect(lastFour('12')).toBeNull();
  });
});

describe('diffOcrCorrections', () => {
  it('reports nothing when the user kept the OCR values', () => {
    const out = diffOcrCorrections(
      { merchant: f('ULINE'), amount: f('97.2'), date: f('2026-09-16'), category: f('shipping'), cardLastFour: f('4242') },
      submitted,
    );
    expect(out).toEqual([]);
  });

  it('reports changed merchant, amount and date with raw originals', () => {
    const out = diffOcrCorrections(
      { merchant: f('ULINE WAREHOUSE'), amount: f('9.72'), date: f('2026-09-15') },
      submitted,
    );
    expect(out).toEqual([
      { field: 'merchant', original_value: 'ULINE WAREHOUSE', corrected_value: 'Uline' },
      { field: 'amount', original_value: '9.72', corrected_value: '97.20' },
      { field: 'date', original_value: '2026-09-15', corrected_value: '2026-09-16' },
    ]);
  });

  it('counts a missing OCR merchant the user filled in', () => {
    expect(diffOcrCorrections({ merchant: f(null) }, submitted)).toEqual([
      { field: 'merchant', original_value: null, corrected_value: 'Uline' },
    ]);
  });

  it('only reports category and card when OCR suggested one', () => {
    expect(diffOcrCorrections({ category: f(null), cardLastFour: f(null) }, submitted)).toEqual([]);
    expect(diffOcrCorrections({ category: f('Meals'), cardLastFour: f('1111') }, submitted)).toEqual([
      { field: 'category', original_value: 'Meals', corrected_value: 'Shipping Supplies' },
      { field: 'cardLastFour', original_value: '1111', corrected_value: '4242' },
    ]);
  });

  it('skips card comparison when the expense has no card on file', () => {
    expect(diffOcrCorrections({ cardLastFour: f('1111') }, { ...submitted, cardLastFour: null })).toEqual([]);
  });

  // Corrections are now reported regardless of the field's source: the user
  // sees and can correct an inferred/rule-based prefill exactly like an OCR
  // one, so it counts toward first-time-right accuracy the same way.
  it('reports fields Midas inferred or rule-filled itself, same as any other source', () => {
    expect(diffOcrCorrections({ merchant: f('Wrong', 'inference'), amount: f('1.00', 'rule_based') }, submitted)).toEqual([
      { field: 'merchant', original_value: 'Wrong', corrected_value: 'Uline' },
      { field: 'amount', original_value: '1.00', corrected_value: '97.20' },
    ]);
  });

  // Realistic production case: OCR extracted nothing usable for merchant, so
  // Midas's rule engine guessed a stray line off the receipt. The user fixed
  // it — that is a real correction, not a clean first-time-right scan.
  it('reports an inference-sourced merchant guess the user corrected', () => {
    expect(diffOcrCorrections({ merchant: f('S Arville St', 'inference') }, { ...submitted, merchant: 'Circle k' })).toEqual([
      { field: 'merchant', original_value: 'S Arville St', corrected_value: 'Circle k' },
    ]);
  });
});
