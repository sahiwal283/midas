import { describe, expect, it } from 'vitest';
import { normalizeMerchant } from '../lib/merchants';

describe('normalizeMerchant', () => {
  it('collapses Amazon variants to one label', () => {
    expect(normalizeMerchant('AMAZON.COM')).toBe('Amazon');
    expect(normalizeMerchant('Amazon.com*123')).toBe('Amazon');
    expect(normalizeMerchant('AMZN')).toBe('Amazon');
    expect(normalizeMerchant('amazon.com*1a2b3')).toBe('Amazon');
    expect(normalizeMerchant('AMZN MKTP US')).toBe('Amazon');
  });

  it('strips star/hash processor suffixes', () => {
    expect(normalizeMerchant('WAL-MART #1234')).toBe('Walmart');
    expect(normalizeMerchant('UBER *TRIP')).toBe('Uber');
  });

  it('strips leading SQ (Square) prefixes', () => {
    expect(normalizeMerchant('SQ *COFFEE SHOP')).toBe('Coffee Shop');
    expect(normalizeMerchant('SQ BAKERY')).toBe('Bakery');
  });

  it('applies the alias map after punctuation stripping', () => {
    expect(normalizeMerchant("MCDONALD'S")).toBe('Mcdonalds');
    expect(normalizeMerchant('WAL MART')).toBe('Walmart');
  });

  it('drops corporate tails', () => {
    expect(normalizeMerchant('Acme Inc')).toBe('Acme');
    expect(normalizeMerchant('Widgets LLC')).toBe('Widgets');
    expect(normalizeMerchant('shop.example.com')).toBe('Shop Example');
  });

  it('Title Cases multi-word names', () => {
    expect(normalizeMerchant('home depot')).toBe('Home Depot');
  });

  it('falls back to the raw value when nothing survives', () => {
    expect(normalizeMerchant('***')).toBe('***');
  });
});
