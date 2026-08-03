import { describe, it, expect } from 'vitest';
import { RuleBasedInferenceEngine } from '../inference/ruleBasedInferenceEngine';

describe('RuleBasedInferenceEngine (expense-app parity)', () => {
  const engine = new RuleBasedInferenceEngine();

  it('extracts merchant from a known brand mention', async () => {
    const result = await engine.infer({ text: 'STARBUCKS STORE #123\nTotal: $5.45', confidence: 0.9, provider: 'test' });
    expect(result.merchant.value).toBe('Starbucks');
    expect(result.merchant.confidence).toBeGreaterThan(0.9);
  });

  it('falls back to the first substantial line when no known brand matches', async () => {
    const result = await engine.infer({ text: "Joe's Diner\nTotal: $12.00", confidence: 0.9, provider: 'test' });
    expect(result.merchant.value).toBe("Joe's Diner");
  });

  it('extracts a total amount with the highest-confidence pattern', async () => {
    const result = await engine.infer({ text: 'Items: $10.00\nGrand Total: $12.34', confidence: 0.9, provider: 'test' });
    expect(result.amount.value).toBeCloseTo(12.34);
  });

  it('normalizes a US-format date to ISO', async () => {
    const result = await engine.infer({ text: 'Date: 03/15/2026', confidence: 0.9, provider: 'test' });
    expect(result.date.value).toBe('2026-03-15');
  });

  it('normalizes a written-month date to ISO', async () => {
    const result = await engine.infer({ text: 'March 15, 2026', confidence: 0.9, provider: 'test' });
    expect(result.date.value).toBe('2026-03-15');
  });

  it('extracts a masked card last four digits', async () => {
    const result = await engine.infer({ text: 'Card ending in 4242', confidence: 0.9, provider: 'test' });
    expect(result.cardLastFour.value).toBe('4242');
  });

  it('predicts Accommodation - Hotel from hotel keywords (expense-app taxonomy)', async () => {
    const result = await engine.infer({ text: 'Marriott Hotel — 2 nights stay', confidence: 0.9, provider: 'test' });
    expect(result.category.value).toBe('Accommodation - Hotel');
  });

  it('predicts Booth / Marketing / Tools from booth keywords (expense-app taxonomy)', async () => {
    const result = await engine.infer({ text: 'Booth signage and banner printing', confidence: 0.9, provider: 'test' });
    expect(result.category.value).toBe('Booth / Marketing / Tools');
  });

  it('predicts Transportation - Uber / Lyft / Others from uber keywords', async () => {
    const result = await engine.infer({ text: 'Your ride with Uber', confidence: 0.9, provider: 'test' });
    expect(result.category.value).toBe('Transportation - Uber / Lyft / Others');
  });

  it('returns null fields (not throwing) when nothing matches', async () => {
    const result = await engine.infer({ text: 'xxxxxxxxxx', confidence: 0.9, provider: 'test' });
    expect(result.amount.value).toBeNull();
    expect(result.date.value).toBeNull();
  });

  it('accepts a custom category taxonomy override', async () => {
    const custom = new RuleBasedInferenceEngine({
      'Booth / Event Marketing': { keywords: ['booth', 'signage', 'banner'], weight: 1.0 },
    });
    const result = await custom.infer({ text: 'Booth signage and banner printing', confidence: 0.9, provider: 'test' });
    expect(result.category.value).toBe('Booth / Event Marketing');
  });

  it('suggests up to 3 categories sorted by confidence', async () => {
    const suggestions = await engine.suggestCategories(
      {
        text: 'Uber ride to the airport for a flight, then hotel check-in',
        confidence: 0.9,
        provider: 'test',
      },
      await engine.infer({
        text: 'Uber ride to the airport for a flight, then hotel check-in',
        confidence: 0.9,
        provider: 'test',
      }),
    );
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i - 1].confidence).toBeGreaterThanOrEqual(suggestions[i].confidence);
    }
  });
});
