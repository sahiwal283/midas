import { describe, it, expect } from 'vitest';

import { filterMentionable } from './mentionPicker';

const SAHIL = { id: 'u1', username: 'sahil', name: 'Sahil Khatri', role: 'developer' as const };
const DIGI = { id: 'u2', username: 'digi', name: 'Digvijay Rao', role: 'admin' as const };
const SERI = { id: 'u3', username: 'seri.k', name: 'Seri Kim', role: 'accountant' as const };
const DANA = { id: 'u4', username: 'dkhan', name: 'Dana Khan', role: 'user' as const };
const ALL = [SAHIL, DIGI, SERI, DANA];

describe('filterMentionable', () => {
  it('offers everyone but yourself on a bare @', () => {
    expect(filterMentionable(ALL, '', 'u1')).toEqual([DIGI, SERI, DANA]);
  });

  it('matches the start of a username', () => {
    expect(filterMentionable(ALL, 'di', 'u1')).toEqual([DIGI]);
  });

  // People think of each other by name, not by handle.
  it('matches the start of any word in the name', () => {
    expect(filterMentionable(ALL, 'dana', 'u1')).toEqual([DANA]);
    expect(filterMentionable(ALL, 'rao', 'u1')).toEqual([DIGI]);
  });

  it('lists username matches ahead of name matches', () => {
    expect(filterMentionable(ALL, 'd', 'u1')).toEqual([DIGI, DANA]);
    expect(filterMentionable(ALL, 'k', 'u3')).toEqual([SAHIL, DANA]);
  });

  it('is case-insensitive', () => {
    expect(filterMentionable(ALL, 'SER', 'u1')).toEqual([SERI]);
  });

  it('returns nothing when no one matches', () => {
    expect(filterMentionable(ALL, 'zz', 'u1')).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...DIGI, id: `m${i}`, username: `digi${i}` }));
    expect(filterMentionable(many, 'digi', 'u1')).toHaveLength(6);
  });
});
