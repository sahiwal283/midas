import { describe, expect, it } from 'vitest';
import { normalizeSourceType } from '../lib/sourceTypes';

describe('normalizeSourceType', () => {
  it('keeps canonical values', () => {
    expect(normalizeSourceType('manual')).toBe('manual');
    expect(normalizeSourceType('purchase_order')).toBe('purchase_order');
  });

  it('maps legacy aliases', () => {
    expect(normalizeSourceType('trade_show')).toBe('trade_show_event');
    expect(normalizeSourceType('extension')).toBe('browser_extension');
    expect(normalizeSourceType('weird_thing')).toBe('other');
  });

  it('returns null for empty', () => {
    expect(normalizeSourceType(null)).toBeNull();
    expect(normalizeSourceType('')).toBeNull();
  });
});
