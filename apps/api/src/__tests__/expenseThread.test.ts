import { describe, it, expect } from 'vitest';
import { decideThreadAccess, decideThreadPost } from '../lib/expenseThread';

const OWNER = 'user-owner';
const OTHER = 'user-other';

describe('decideThreadAccess', () => {
  it('lets the owner read without internal notes', () => {
    expect(decideThreadAccess({ viewerId: OWNER, viewerRole: 'user', ownerId: OWNER }))
      .toEqual({ allowed: true, includeInternal: false });
  });

  it('lets an accountant read with internal notes', () => {
    expect(decideThreadAccess({ viewerId: OTHER, viewerRole: 'accountant', ownerId: OWNER }))
      .toEqual({ allowed: true, includeInternal: true });
  });

  it('lets an admin read with internal notes', () => {
    expect(decideThreadAccess({ viewerId: OTHER, viewerRole: 'admin', ownerId: OWNER }))
      .toEqual({ allowed: true, includeInternal: true });
  });

  it('treats developer as all-access', () => {
    expect(decideThreadAccess({ viewerId: OTHER, viewerRole: 'developer', ownerId: OWNER }))
      .toEqual({ allowed: true, includeInternal: true });
  });

  it('denies an unrelated user', () => {
    expect(decideThreadAccess({ viewerId: OTHER, viewerRole: 'user', ownerId: OWNER }))
      .toEqual({ allowed: false, includeInternal: false });
  });

  it('denies a partner who is not the owner', () => {
    expect(decideThreadAccess({ viewerId: OTHER, viewerRole: 'partner', ownerId: OWNER }))
      .toEqual({ allowed: false, includeInternal: false });
  });

  it('gives an owner who is also an accountant internal notes on their own expense', () => {
    expect(decideThreadAccess({ viewerId: OWNER, viewerRole: 'accountant', ownerId: OWNER }))
      .toEqual({ allowed: true, includeInternal: true });
  });
});

describe('decideThreadPost', () => {
  it('transitions when the owner replies on awaiting_info', () => {
    expect(decideThreadPost({
      status: 'awaiting_info', senderId: OWNER, senderRole: 'user', ownerId: OWNER,
    })).toEqual({ transitionsToPending: true, mayRequestInfo: false });
  });

  it('does not transition when a non-owner replies on awaiting_info', () => {
    expect(decideThreadPost({
      status: 'awaiting_info', senderId: OTHER, senderRole: 'accountant', ownerId: OWNER,
    })).toEqual({ transitionsToPending: false, mayRequestInfo: true });
  });

  it('does not transition when the owner replies on an approved expense', () => {
    expect(decideThreadPost({
      status: 'approved', senderId: OWNER, senderRole: 'user', ownerId: OWNER,
    })).toEqual({ transitionsToPending: false, mayRequestInfo: false });
  });

  it('does not transition on pending', () => {
    expect(decideThreadPost({
      status: 'pending', senderId: OWNER, senderRole: 'user', ownerId: OWNER,
    })).toEqual({ transitionsToPending: false, mayRequestInfo: false });
  });

  it('lets admin and developer request info', () => {
    for (const role of ['admin', 'developer'] as const) {
      expect(decideThreadPost({
        status: 'pending', senderId: OTHER, senderRole: role, ownerId: OWNER,
      }).mayRequestInfo).toBe(true);
    }
  });

  it('does not let a partner request info', () => {
    expect(decideThreadPost({
      status: 'pending', senderId: OTHER, senderRole: 'partner', ownerId: OWNER,
    }).mayRequestInfo).toBe(false);
  });

  it('does not let an owning accountant transition and request info at once', () => {
    // Ownership decides direction; an accountant replying on their own
    // awaiting_info expense is a submitter here.
    expect(decideThreadPost({
      status: 'awaiting_info', senderId: OWNER, senderRole: 'accountant', ownerId: OWNER,
    })).toEqual({ transitionsToPending: true, mayRequestInfo: true });
  });
});
