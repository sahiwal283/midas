import { describe, it, expect } from 'vitest';
import { toOwnerRef, fromOwnerRef } from './index';

describe('OwnerRef <-> sourceApp/sourceRefId mapping', () => {
  it('converts populated source fields to an OwnerRef', () => {
    expect(toOwnerRef({ sourceApp: 'trade_show', sourceRefId: 'booth-42' })).toEqual({
      ownerType: 'trade_show',
      ownerId: 'booth-42',
    });
  });

  it('returns null when either source field is missing (direct Midas entry)', () => {
    expect(toOwnerRef({ sourceApp: null, sourceRefId: null })).toBeNull();
    expect(toOwnerRef({ sourceApp: 'argo', sourceRefId: null })).toBeNull();
  });

  it('round-trips through fromOwnerRef', () => {
    const owner = { ownerType: 'argo', ownerId: 'event-7' };
    expect(fromOwnerRef(owner)).toEqual({ sourceApp: 'argo', sourceRefId: 'event-7' });
  });

  it('fromOwnerRef(null) yields null source fields (direct Midas entry)', () => {
    expect(fromOwnerRef(null)).toEqual({ sourceApp: null, sourceRefId: null });
  });
});
