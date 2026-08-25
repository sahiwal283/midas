import { describe, it, expect } from 'vitest';
import { auditPostedAccounts, MAPPING_WARNING_PREFIX } from '../lib/zohoAccountAudit';

const sent = {
  accountId: '4849689000007752119',
  paidThroughAccountId: '4849689000010206091',
};

describe('auditPostedAccounts — matching records', () => {
  it('reports no mismatch when Zoho stored exactly what was sent', () => {
    const result = auditPostedAccounts(sent, { ...sent });
    expect(result.mismatched).toBe(false);
    expect(result.mismatches).toHaveLength(0);
    expect(result.warning).toBeNull();
  });

  it('ignores surrounding whitespace on either side', () => {
    const result = auditPostedAccounts(
      { accountId: ' 4849689000007752119 ', paidThroughAccountId: sent.paidThroughAccountId },
      { accountId: '4849689000007752119', paidThroughAccountId: ` ${sent.paidThroughAccountId} ` },
    );
    expect(result.mismatched).toBe(false);
  });
});

describe('auditPostedAccounts — the paid-through override that broke Boomin Brands', () => {
  it('flags a paid-through account swapped for another org’s account', () => {
    const result = auditPostedAccounts(sent, {
      accountId: sent.accountId,
      paidThroughAccountId: '5254962000000129043',
    });
    expect(result.mismatched).toBe(true);
    expect(result.mismatches).toEqual([
      {
        field: 'paid_through_account_id',
        sent: '4849689000010206091',
        stored: '5254962000000129043',
      },
    ]);
  });

  it('names both fields when the service overrode both', () => {
    const result = auditPostedAccounts(sent, {
      accountId: '2212769000000952149',
      paidThroughAccountId: '2212769000013783986',
    });
    expect(result.mismatched).toBe(true);
    expect(result.mismatches.map((m) => m.field)).toEqual([
      'account_id',
      'paid_through_account_id',
    ]);
  });

  it('produces a storable warning tagged for the UI', () => {
    const result = auditPostedAccounts(sent, {
      accountId: sent.accountId,
      paidThroughAccountId: '5254962000000129043',
    });
    expect(result.warning).toContain(`[${MAPPING_WARNING_PREFIX}]`);
    expect(result.warning).toContain('4849689000010206091');
    expect(result.warning).toContain('5254962000000129043');
    expect(result.warning).toContain('paid-through account');
  });

  it('keeps the warning short enough for the zoho_sync_error column', () => {
    const result = auditPostedAccounts(sent, {
      accountId: '2212769000000952149',
      paidThroughAccountId: '2212769000013783986',
    });
    expect(result.warning!.length).toBeLessThanOrEqual(500);
  });
});

describe('auditPostedAccounts — never false-alarms', () => {
  it('reports no mismatch when the readback failed entirely', () => {
    expect(auditPostedAccounts(sent, null).mismatched).toBe(false);
  });

  it('reports no mismatch when Zoho returned no account values', () => {
    const result = auditPostedAccounts(sent, { accountId: null, paidThroughAccountId: null });
    expect(result.mismatched).toBe(false);
    expect(result.warning).toBeNull();
  });

  it('reports no mismatch for a field Midas never sent', () => {
    const result = auditPostedAccounts(
      { accountId: null, paidThroughAccountId: null },
      { accountId: '4849689000007752119', paidThroughAccountId: '4849689000010206091' },
    );
    expect(result.mismatched).toBe(false);
  });

  it('flags only the field that actually differs', () => {
    const result = auditPostedAccounts(sent, {
      accountId: sent.accountId,
      paidThroughAccountId: null,
    });
    expect(result.mismatched).toBe(false);
  });
});
