import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/extEventsDb', () => ({ eventEnabledSourceApps: vi.fn(async () => ['trade_show']) }));
vi.mock('../lib/incompleteSweepDb', () => ({ claimDueExpenses: vi.fn(async () => []) }));
vi.mock('../lib/notify', () => ({ notifyUser: vi.fn(async () => undefined) }));

import { missingDetails, runIncompleteSweep } from '../lib/incompleteSweep';
import { eventEnabledSourceApps } from '../lib/extEventsDb';
import { claimDueExpenses } from '../lib/incompleteSweepDb';
import { notifyUser } from '../lib/notify';

const complete = { hasReceipt: true, categoryId: 'c', zohoExpenseAccountId: null, paymentMethodId: 'p' };
const due = (over: Record<string, unknown> = {}) => ({
  id: 'e-1', userId: 'owner', merchant: 'Uber', amount: '18.00', sourceApp: 'trade_show', cardUsed: null,
  ...complete, ...over,
});

describe('missingDetails', () => {
  it('is empty for a complete expense', () => {
    expect(missingDetails(complete)).toEqual([]);
  });
  it('lists what is missing, in a fixed order', () => {
    expect(missingDetails({ hasReceipt: false, categoryId: null, zohoExpenseAccountId: null, paymentMethodId: null }))
      .toEqual(['receipt', 'category', 'payment method']);
  });
  it('accepts a Zoho expense account in place of a category', () => {
    expect(missingDetails({ ...complete, categoryId: null, zohoExpenseAccountId: '123' })).toEqual([]);
  });
  it('accepts a written receipt waiver in place of a receipt, but not a blank one', () => {
    expect(missingDetails({ ...complete, hasReceipt: false, receiptWaiverReason: 'Lost; vendor confirmed' })).toEqual([]);
    expect(missingDetails({ ...complete, hasReceipt: false, receiptWaiverReason: '   ' })).toEqual(['receipt']);
  });
  it('accepts a card the app sent in place of a mapped payment method, but not a blank one', () => {
    expect(missingDetails({ ...complete, paymentMethodId: null, cardUsed: 'Amex ••1234' })).toEqual([]);
    expect(missingDetails({ ...complete, paymentMethodId: null, cardUsed: '   ' })).toEqual(['payment method']);
    expect(missingDetails({ ...complete, paymentMethodId: null, cardUsed: null })).toEqual(['payment method']);
  });
});

describe('runIncompleteSweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('still claims, and tells no one, when no app has events enabled', async () => {
    vi.mocked(eventEnabledSourceApps).mockResolvedValueOnce([]);
    vi.mocked(claimDueExpenses).mockResolvedValueOnce([due({ hasReceipt: false })] as never);
    await runIncompleteSweep();
    expect(claimDueExpenses).toHaveBeenCalledWith(100);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('tells the owner once per incomplete expense, listing what is missing, never by email', async () => {
    vi.mocked(claimDueExpenses).mockResolvedValueOnce([
      due({ id: 'e-1', hasReceipt: false }),
      due({ id: 'e-2' }),
      due({ id: 'e-3', paymentMethodId: null, hasReceipt: false }),
    ] as never);
    await runIncompleteSweep();
    expect(claimDueExpenses).toHaveBeenCalledWith(100);
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenCalledWith('owner', 'expense_incomplete', {
      expenseId: 'e-1', merchant: 'Uber', amount: '18.00', missing: ['receipt'],
    }, { email: false });
    expect(notifyUser).toHaveBeenCalledWith('owner', 'expense_incomplete', {
      expenseId: 'e-3', merchant: 'Uber', amount: '18.00', missing: ['receipt', 'payment method'],
    }, { email: false });
  });

  it('notifies only for apps with events enabled; the rest are claimed and dropped', async () => {
    vi.mocked(claimDueExpenses).mockResolvedValueOnce([
      due({ id: 'e-1', hasReceipt: false, sourceApp: 'other_app' }),
      due({ id: 'e-2', hasReceipt: false, sourceApp: 'trade_show' }),
    ] as never);
    await runIncompleteSweep();
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith('owner', 'expense_incomplete',
      expect.objectContaining({ expenseId: 'e-2' }), { email: false });
  });

  it('does not report a payment method as missing when the app sent a card', async () => {
    vi.mocked(claimDueExpenses).mockResolvedValueOnce([
      due({ id: 'e-1', paymentMethodId: null, cardUsed: 'Amex ••1234' }),
      due({ id: 'e-2', paymentMethodId: null, cardUsed: 'Amex ••1234', hasReceipt: false }),
    ] as never);
    await runIncompleteSweep();
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect(notifyUser).toHaveBeenCalledWith('owner', 'expense_incomplete', {
      expenseId: 'e-2', merchant: 'Uber', amount: '18.00', missing: ['receipt'],
    }, { email: false });
  });

  it('never throws', async () => {
    vi.mocked(claimDueExpenses).mockRejectedValueOnce(new Error('db down'));
    await expect(runIncompleteSweep()).resolves.toBeUndefined();
  });

  it('claims nothing when the enabled-apps lookup fails, so no expense is stamped unreported', async () => {
    vi.mocked(eventEnabledSourceApps).mockRejectedValueOnce(new Error('db down'));
    await expect(runIncompleteSweep()).resolves.toBeUndefined();
    expect(claimDueExpenses).not.toHaveBeenCalled();
  });
});
