import { describe, expect, it } from 'vitest';
import {
  TRADE_SHOW_CARD_OPTIONS,
  parseCardUsedLastFour,
} from '../lib/tradeShowPaymentMethods';

describe('TRADE_SHOW_CARD_OPTIONS', () => {
  it('has 12 cards with unique lastFour', () => {
    expect(TRADE_SHOW_CARD_OPTIONS).toHaveLength(12);
    const fours = TRADE_SHOW_CARD_OPTIONS.map((c) => c.lastFour);
    expect(new Set(fours).size).toBe(12);
  });
});

describe('parseCardUsedLastFour', () => {
  it('parses paren form', () => {
    expect(parseCardUsedLastFour('Nirvana PNC (...4171)')).toBe('4171');
  });

  it('parses pipe form', () => {
    expect(parseCardUsedLastFour('Haute PNC | 3490')).toBe('3490');
  });

  it('handles trailing space in name', () => {
    expect(parseCardUsedLastFour('Brett Summitt Card  (...1039)')).toBe('1039');
  });

  it('returns null for empty', () => {
    expect(parseCardUsedLastFour(null)).toBeNull();
    expect(parseCardUsedLastFour('')).toBeNull();
  });
});
