import { describe, expect, it } from 'vitest';
import fixture from './fixtures/extEvents.json';
import {
  HANDOFF_TYPES, shouldHandOff, buildExtEventPayload, parseSince, clampLimit, toFeedEvent,
} from '../lib/extEvents';

const base = {
  type: 'approved', recipientId: 'owner', ownerId: 'owner',
  sourceApp: 'trade_show', externalUserId: 'argo-user-1', eventsEnabled: true,
};

describe('shouldHandOff', () => {
  it('hands off an owner-facing event on an event-enabled app expense', () => {
    expect(shouldHandOff(base)).toBe(true);
  });
  it.each(HANDOFF_TYPES)('covers %s', (type) => {
    expect(shouldHandOff({ ...base, type })).toBe(true);
  });
  it('never hands off to someone who is not the owner (staff replies, mentions of staff)', () => {
    expect(shouldHandOff({ ...base, recipientId: 'accountant' })).toBe(false);
  });
  it('does not hand off when the switch is off', () => {
    expect(shouldHandOff({ ...base, eventsEnabled: false })).toBe(false);
  });
  it('does not hand off a native Midas expense', () => {
    expect(shouldHandOff({ ...base, sourceApp: null })).toBe(false);
  });
  it('does not hand off when the app never told us who its user is', () => {
    expect(shouldHandOff({ ...base, externalUserId: null })).toBe(false);
    expect(shouldHandOff({ ...base, externalUserId: '' })).toBe(false);
  });
  it('does not hand off types the external app does not know (needs_review)', () => {
    expect(shouldHandOff({ ...base, type: 'needs_review' })).toBe(false);
  });
});

describe('buildExtEventPayload', () => {
  const expense = {
    id: 'e-1', userId: 'owner', sourceApp: 'trade_show', sourceRefId: 'argo-exp-1',
    externalUserId: 'argo-user-1', merchant: 'Staples', amount: '42.10', status: 'rejected',
  };
  it('snapshots the expense and carries only the fields that were supplied', () => {
    expect(buildExtEventPayload(expense, { note: 'Duplicate submission' })).toEqual({
      externalUserId: 'argo-user-1',
      expense: { id: 'e-1', sourceRefId: 'argo-exp-1', merchant: 'Staples', amount: '42.10', status: 'rejected' },
      note: 'Duplicate submission',
    });
  });
  it('omits empty and undefined optional fields', () => {
    const payload = buildExtEventPayload(expense, { senderName: undefined, excerpt: '', missing: [] });
    expect(Object.keys(payload).sort()).toEqual(['expense', 'externalUserId']);
  });
});

describe('feed helpers', () => {
  it('parseSince accepts a missing cursor and whole non-negative numbers only', () => {
    expect(parseSince(undefined)).toBe(0);
    expect(parseSince('')).toBe(0);
    expect(parseSince('41')).toBe(41);
    expect(parseSince('abc')).toBeNull();
    expect(parseSince('-1')).toBeNull();
    expect(parseSince('1.5')).toBeNull();
    expect(parseSince(['1'])).toBeNull();
  });
  it('clampLimit defaults to 100 and caps at 200', () => {
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit('5')).toBe(5);
    expect(clampLimit('100000')).toBe(200);
    expect(clampLimit('0')).toBe(100);
    expect(clampLimit('nope')).toBe(100);
  });
  it('toFeedEvent produces exactly the contract shape (shared fixture with Argo)', () => {
    const produced = fixture.rows.map((r) => toFeedEvent({ ...r, createdAt: new Date(r.createdAt) } as never));
    expect(produced).toEqual(fixture.events);
  });
});
