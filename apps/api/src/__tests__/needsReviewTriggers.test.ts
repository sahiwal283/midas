import { describe, expect, it } from 'vitest';
import { shouldQueueNotify } from '../lib/needsReview';

describe('shouldQueueNotify', () => {
  it('fires when a new expense is created pending', () => {
    expect(shouldQueueNotify({ before: null, after: 'pending' })).toBe(true);
  });
  it('fires when a draft is submitted or a rejected expense is resubmitted', () => {
    expect(shouldQueueNotify({ before: 'draft', after: 'pending' })).toBe(true);
    expect(shouldQueueNotify({ before: 'rejected', after: 'pending' })).toBe(true);
  });
  it('does not fire for an edit that leaves it pending', () => {
    expect(shouldQueueNotify({ before: 'pending', after: 'pending' })).toBe(false);
  });
  it('does not fire when an expense comes back from an info request', () => {
    expect(shouldQueueNotify({ before: 'awaiting_info', after: 'pending' })).toBe(false);
    expect(shouldQueueNotify({ before: 'in_review', after: 'pending' })).toBe(false);
  });
  it('does not fire for any other resulting status', () => {
    expect(shouldQueueNotify({ before: null, after: 'approved' })).toBe(false);
    expect(shouldQueueNotify({ before: 'pending', after: 'approved' })).toBe(false);
    expect(shouldQueueNotify({ before: null, after: 'draft' })).toBe(false);
  });
});
