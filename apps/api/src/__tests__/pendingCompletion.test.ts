import { describe, expect, it } from 'vitest';
import { isDailyAutoPushCandidate, incompleteSubmissionMessage } from '../lib/pendingCompletion';

describe('isDailyAutoPushCandidate', () => {
  it('true for Midas-entered business expense with Zoho-enabled company', () => {
    expect(isDailyAutoPushCandidate({ sourceApp: null, expenseKind: 'business', companyZohoEnabled: true })).toBe(true);
    expect(isDailyAutoPushCandidate({ sourceApp: null, expenseKind: 'business', companyZohoEnabled: undefined })).toBe(true);
  });

  it('true for browser extension source', () => {
    expect(isDailyAutoPushCandidate({ sourceApp: 'browser_extension', expenseKind: 'business', companyZohoEnabled: true })).toBe(true);
  });

  it('false for event/external sources (trade_show etc.)', () => {
    expect(isDailyAutoPushCandidate({ sourceApp: 'trade_show', expenseKind: 'business', companyZohoEnabled: true })).toBe(false);
  });

  it('false for partner expenses', () => {
    expect(isDailyAutoPushCandidate({ sourceApp: null, expenseKind: 'partner', companyZohoEnabled: true })).toBe(false);
  });

  it('false when the company opted out of Zoho', () => {
    expect(isDailyAutoPushCandidate({ sourceApp: null, expenseKind: 'business', companyZohoEnabled: false })).toBe(false);
  });
});

describe('incompleteSubmissionMessage', () => {
  it('lists every missing item and explains the bypass', () => {
    const body = incompleteSubmissionMessage(['receipt attachment', 'payment method']);
    expect(body).toContain('receipt attachment');
    expect(body).toContain('payment method');
    // The whole point: the user learns that completing it skips the accountant.
    expect(body.toLowerCase()).toContain('automatically');
  });

  it('handles a single missing item', () => {
    const body = incompleteSubmissionMessage(['receipt attachment']);
    expect(body).toContain('receipt attachment');
  });
});
