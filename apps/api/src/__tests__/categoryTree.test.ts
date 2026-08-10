import { describe, it, expect } from 'vitest';
import {
  wouldCreateCycle, descendantIds, effectivelyActiveIds, topLevelAncestorId, ancestryChain,
  type CategoryNode,
} from '../lib/categoryTree';

// travel > transportation > uber ; travel > flight ; other (top)
const nodes: CategoryNode[] = [
  { id: 'travel', parentId: null, isActive: true },
  { id: 'transportation', parentId: 'travel', isActive: true },
  { id: 'uber', parentId: 'transportation', isActive: true },
  { id: 'flight', parentId: 'travel', isActive: true },
  { id: 'other', parentId: null, isActive: true },
];

describe('wouldCreateCycle', () => {
  it('rejects self-parenting', () => {
    expect(wouldCreateCycle(nodes, 'travel', 'travel')).toBe(true);
  });
  it('rejects parenting under own descendant', () => {
    expect(wouldCreateCycle(nodes, 'travel', 'uber')).toBe(true);
  });
  it('allows normal re-parent and detach', () => {
    expect(wouldCreateCycle(nodes, 'flight', 'transportation')).toBe(false);
    expect(wouldCreateCycle(nodes, 'uber', null)).toBe(false);
  });
});

describe('descendantIds', () => {
  it('returns node + all descendants', () => {
    expect(descendantIds(nodes, 'travel').sort()).toEqual(['flight', 'transportation', 'travel', 'uber']);
    expect(descendantIds(nodes, 'uber')).toEqual(['uber']);
  });
});

describe('effectivelyActiveIds', () => {
  it('hides the whole subtree when an ancestor is inactive', () => {
    const dimmed = nodes.map((n) => (n.id === 'transportation' ? { ...n, isActive: false } : n));
    const act = effectivelyActiveIds(dimmed);
    expect(act.has('travel')).toBe(true);
    expect(act.has('flight')).toBe(true);
    expect(act.has('transportation')).toBe(false);
    expect(act.has('uber')).toBe(false);
  });
});

describe('topLevelAncestorId / ancestryChain', () => {
  it('walks to the root', () => {
    expect(topLevelAncestorId(nodes, 'uber')).toBe('travel');
    expect(topLevelAncestorId(nodes, 'other')).toBe('other');
    expect(ancestryChain(nodes, 'uber')).toEqual(['uber', 'transportation', 'travel']);
  });
  it('survives malformed cyclic data without hanging', () => {
    const bad: CategoryNode[] = [
      { id: 'a', parentId: 'b', isActive: true },
      { id: 'b', parentId: 'a', isActive: true },
    ];
    expect(() => topLevelAncestorId(bad, 'a')).not.toThrow();
    expect(ancestryChain(bad, 'a').length).toBeLessThanOrEqual(2);
  });
});
