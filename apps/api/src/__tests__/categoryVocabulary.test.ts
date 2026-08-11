import { describe, it, expect } from 'vitest';
import { applyVocabulary } from '../lib/ext/categoryVocabulary';

const cats = [
  { id: 'a', name: 'Travel - Flight' },
  { id: 'b', name: 'Show Operations' },
  { id: 'c', name: 'Parking Fees' },
];

describe('applyVocabulary', () => {
  it('returns everything when the connection is unrestricted (null)', () => {
    expect(applyVocabulary(cats, null)).toHaveLength(3);
  });

  it('returns only the allowlisted categories', () => {
    const out = applyVocabulary(cats, new Set(['a', 'c']));
    expect(out.map((c) => c.name)).toEqual(['Travel - Flight', 'Parking Fees']);
  });

  it('hides Midas-only categories the consumer never had', () => {
    const out = applyVocabulary(cats, new Set(['a', 'c']));
    expect(out.some((c) => c.name === 'Show Operations')).toBe(false);
  });

  it('an empty allowlist set yields nothing (distinct from unrestricted null)', () => {
    expect(applyVocabulary(cats, new Set())).toHaveLength(0);
  });
});
