import { describe, it, expect } from 'vitest';
import { rollUpByTopAncestor, type CategoryNode } from '../lib/categoryTree';

const nodes: CategoryNode[] = [
  { id: 'travel', parentId: null, isActive: true },
  { id: 'flight', parentId: 'travel', isActive: true },
  { id: 'other', parentId: null, isActive: true },
];
const names: Record<string, string> = { travel: 'Travel', flight: 'Travel - Flight', other: 'Other' };

describe('rollUpByTopAncestor', () => {
  it('sums descendants into the top-level parent and sorts by spend', () => {
    const rows = [
      { categoryId: 'flight', spend: 100, n: 2 },
      { categoryId: 'travel', spend: 50, n: 1 },
      { categoryId: 'other', spend: 30, n: 1 },
      { categoryId: null, spend: 5, n: 1 },
    ];
    const out = rollUpByTopAncestor(nodes, rows, (id) => names[id]);
    expect(out).toEqual([
      { name: 'Travel', spend: 150, n: 3 },
      { name: 'Other', spend: 30, n: 1 },
      { name: 'Uncategorized', spend: 5, n: 1 },
    ]);
  });
});
