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
  id: 'e-1', userId: 'owner', merchant: 'Uber', amount: '18.00', ...complete, ...over,
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
});

describe('runIncompleteSweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not touch the database when no app has events enabled', async () => {
    vi.mocked(eventEnabledSourceApps).mockResolvedValueOnce([]);
    await runIncompleteSweep();
    expect(claimDueExpenses).not.toHaveBeenCalled();
  });

  it('tells the owner once per incomplete expense, listing what is missing', async () => {
    vi.mocked(claimDueExpenses).mockResolvedValueOnce([
      due({ id: 'e-1', hasReceipt: false }),
      due({ id: 'e-2' }),
      due({ id: 'e-3', paymentMethodId: null, hasReceipt: false }),
    ] as never);
    await runIncompleteSweep();
    expect(claimDueExpenses).toHaveBeenCalledWith(['trade_show'], 100);
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenCalledWith('owner', 'expense_incomplete', {
      expenseId: 'e-1', merchant: 'Uber', amount: '18.00', missing: ['receipt'],
    });
    expect(notifyUser).toHaveBeenCalledWith('owner', 'expense_incomplete', {
      expenseId: 'e-3', merchant: 'Uber', amount: '18.00', missing: ['receipt', 'payment method'],
    });
  });

  it('never throws', async () => {
    vi.mocked(claimDueExpenses).mockRejectedValueOnce(new Error('db down'));
    await expect(runIncompleteSweep()).resolves.toBeUndefined();
  });
});
