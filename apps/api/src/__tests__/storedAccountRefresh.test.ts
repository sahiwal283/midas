import { describe, expect, it } from 'vitest';
import { planStoredAccountRefresh } from '../lib/storedAccountRefresh';

const m = (o: Record<string, string | null>) => new Map(Object.entries(o));

describe('planStoredAccountRefresh', () => {
  // Remapping Equipment for Boomin left every unpushed Equipment expense
  // holding the old id, which wins at push time — so Retry failed again.
  it('moves expenses holding the old mapped account to the new one', () => {
    expect(planStoredAccountRefresh({
      categoryIds: ['equip'],
      before: m({ equip: 'old' }),
      after: m({ equip: 'new' }),
      legacyById: m({ equip: null }),
    })).toEqual([{ categoryId: 'equip', from: ['old'], to: 'new' }]);
  });

  it('also replaces a stored copy of the legacy default when the category gets its first company mapping', () => {
    expect(planStoredAccountRefresh({
      categoryIds: ['equip'],
      before: m({ equip: null }),
      after: m({ equip: 'new' }),
      legacyById: m({ equip: 'haute-default' }),
    })).toEqual([{ categoryId: 'equip', from: ['haute-default'], to: 'new' }]);
  });

  it('covers descendants that inherit the mapping, and skips ones with their own', () => {
    expect(planStoredAccountRefresh({
      categoryIds: ['equip', 'child-inherits', 'child-own'],
      before: m({ equip: 'old', 'child-inherits': 'old', 'child-own': 'own' }),
      after: m({ equip: 'new', 'child-inherits': 'new', 'child-own': 'own' }),
      legacyById: m({}),
    })).toEqual([
      { categoryId: 'equip', from: ['old'], to: 'new' },
      { categoryId: 'child-inherits', from: ['old'], to: 'new' },
    ]);
  });

  it('clears the stored account when the mapping is removed and nothing else resolves', () => {
    expect(planStoredAccountRefresh({
      categoryIds: ['equip'],
      before: m({ equip: 'old' }),
      after: m({ equip: null }),
      legacyById: m({ equip: null }),
    })).toEqual([{ categoryId: 'equip', from: ['old'], to: null }]);
  });

  it('plans nothing when the resolution did not change', () => {
    expect(planStoredAccountRefresh({
      categoryIds: ['equip'],
      before: m({ equip: 'same' }),
      after: m({ equip: 'same' }),
      legacyById: m({ equip: 'same' }),
    })).toEqual([]);
  });
});
