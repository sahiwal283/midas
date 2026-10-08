// apps/api/src/__tests__/notifyNeedsReview.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/push', () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock('../lib/needsReviewDb', () => ({
  loadNeedsReviewExpense: vi.fn(),
  activeAccountantIds: vi.fn(async () => ['acc-1', 'acc-2']),
  bumpGroup: vi.fn(async () => ({ id: 'n-1', count: 1 })),
  setGroupText: vi.fn(async () => undefined),
}));

import { notifyNeedsReview } from '../lib/notifyNeedsReview';
import { loadNeedsReviewExpense, activeAccountantIds, bumpGroup, setGroupText } from '../lib/needsReviewDb';
import { sendPushToUser } from '../lib/push';

const expense = {
  id: 'e-1', userId: 'u-1', submitterName: 'Ana', merchant: 'Staples', amount: '42.10', date: '2026-10-08',
  sourceContext: { eventId: 'ev-9', eventName: 'Expo' }, sourceLabel: 'Expo',
  categoryName: 'Meals', categoryNeedsAccountant: false,
};

describe('notifyNeedsReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives every accountant a grouped bell row and one push for this expense', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    vi.mocked(bumpGroup).mockResolvedValueOnce({ id: 'n-1', count: 3 }).mockResolvedValueOnce({ id: 'n-2', count: 1 });
    await notifyNeedsReview('e-1', 'queued');

    expect(activeAccountantIds).toHaveBeenCalledWith('u-1');
    const first = { title: 'Ana submitted an expense for Expo', body: 'Open the review queue to see it.' };
    expect(bumpGroup).toHaveBeenCalledWith('acc-1', 'nr:u-1:event:ev-9', 'e-1', first);
    expect(bumpGroup).toHaveBeenCalledWith('acc-2', 'nr:u-1:event:ev-9', 'e-1', first);
    expect(setGroupText).toHaveBeenCalledTimes(1);
    expect(setGroupText).toHaveBeenCalledWith('n-1', 3, 'Ana submitted 3 expenses for Expo', 'Open the review queue to see it.');
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
    expect(sendPushToUser).toHaveBeenCalledWith('acc-1', {
      title: 'Expense needs review',
      body: 'Ana: $42.10 at Staples · Expo',
      url: '/accountant/e-1',
      tag: 'needs-review-e-1',
    });
  });

  it('stays silent for an auto-approved expense in an ordinary category', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    await notifyNeedsReview('e-1', 'auto_approved');
    expect(bumpGroup).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('notifies for an auto-approved expense in a needs-accountant category', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce({ ...expense, categoryName: 'Ask Accountant', categoryNeedsAccountant: true });
    await notifyNeedsReview('e-1', 'auto_approved');
    expect(sendPushToUser).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      title: 'Auto-approved expense needs you',
      body: 'Ana: $42.10 at Staples · category "Ask Accountant"',
    }));
  });

  it('does nothing when the expense has gone or there are no accountants', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(null);
    await notifyNeedsReview('e-x', 'queued');
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    vi.mocked(activeAccountantIds).mockResolvedValueOnce([]);
    await notifyNeedsReview('e-1', 'queued');
    expect(bumpGroup).not.toHaveBeenCalled();
  });

  it('one accountant failing does not stop the next, and nothing is thrown', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    vi.mocked(bumpGroup).mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce({ id: 'n-2', count: 1 });
    await expect(notifyNeedsReview('e-1', 'queued')).resolves.toBeUndefined();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(sendPushToUser).toHaveBeenCalledWith('acc-2', expect.anything());
  });

  it('a failed text rewrite neither blocks the push nor throws', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    vi.mocked(bumpGroup).mockResolvedValueOnce({ id: 'n-1', count: 3 }).mockResolvedValueOnce({ id: 'n-2', count: 1 });
    vi.mocked(setGroupText).mockRejectedValueOnce(new Error('db blip'));
    await expect(notifyNeedsReview('e-1', 'queued')).resolves.toBeUndefined();
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
    expect(sendPushToUser).toHaveBeenCalledWith('acc-1', expect.anything());
  });

  it('never throws when the expense cannot be loaded', async () => {
    vi.mocked(loadNeedsReviewExpense).mockRejectedValueOnce(new Error('db down'));
    await expect(notifyNeedsReview('e-1', 'queued')).resolves.toBeUndefined();
  });
});
