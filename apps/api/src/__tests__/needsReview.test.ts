// apps/api/src/__tests__/needsReview.test.ts
import { describe, expect, it } from 'vitest';
import { groupKeyFor, groupTarget, groupText, pushText } from '../lib/needsReview';

describe('groupKeyFor', () => {
  it('groups a show expense by submitter and event', () => {
    expect(groupKeyFor({ userId: 'u-1', date: '2026-10-08', sourceContext: { eventId: 'ev-9' } })).toBe('nr:u-1:event:ev-9');
  });
  it('groups everything else by submitter and expense date', () => {
    expect(groupKeyFor({ userId: 'u-1', date: '2026-10-08', sourceContext: {} })).toBe('nr:u-1:day:2026-10-08');
    expect(groupKeyFor({ userId: 'u-1', date: '2026-10-08', sourceContext: null })).toBe('nr:u-1:day:2026-10-08');
  });
});

describe('groupTarget', () => {
  it('reads the kind back out of a key', () => {
    expect(groupTarget('nr:u-1:event:ev-9')).toBe('event');
    expect(groupTarget('nr:u-1:day:2026-10-08')).toBe('day');
    expect(groupTarget(null)).toBe('day');
  });
});

describe('groupText', () => {
  it('words one expense for a show', () => {
    expect(groupText({ submitterName: 'Ana', count: 1, eventName: 'Expo', date: '2026-10-08' }))
      .toEqual({ title: 'Ana submitted an expense for Expo', body: 'Open the review queue to see it.' });
  });
  it('words several expenses for a show', () => {
    expect(groupText({ submitterName: 'Ana', count: 6, eventName: 'Expo', date: '2026-10-08' }).title)
      .toBe('Ana submitted 6 expenses for Expo');
  });
  it('falls back to the date when there is no show', () => {
    expect(groupText({ submitterName: 'Ana', count: 2, eventName: null, date: '2026-10-08' }).title)
      .toBe('Ana submitted 2 expenses on Oct 8');
    expect(groupText({ submitterName: 'Ana', count: 1, date: '2026-01-05' }).title)
      .toBe('Ana submitted an expense on Jan 5');
  });
});

describe('pushText', () => {
  it('names the submitter, amount, merchant and show for a queued expense', () => {
    expect(pushText({ submitterName: 'Ana', merchant: 'Staples', amount: '42.1', eventName: 'Expo', reason: 'queued' }))
      .toEqual({ title: 'Expense needs review', body: 'Ana: $42.10 at Staples · Expo' });
  });
  it('says why an auto-approved expense still needs the accountant', () => {
    expect(pushText({ submitterName: 'Ana', merchant: 'Staples', amount: 9, reason: 'auto_approved', categoryName: 'Ask Accountant' }))
      .toEqual({ title: 'Auto-approved expense needs you', body: 'Ana: $9.00 at Staples · category "Ask Accountant"' });
  });
});
