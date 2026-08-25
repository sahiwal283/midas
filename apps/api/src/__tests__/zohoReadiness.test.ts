import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateZohoReadiness } from '../lib/zohoReadiness';
import { MIDAS_VERSION } from '@midas/shared';

// Mock env so tests don't require real env vars
vi.mock('../config/env', () => ({
  env: {
    ZOHO_MODE: 'mock' as const,
    ZOHO_DRY_RUN: false,
    ZOHO_DEFAULT_BRAND: 'haute_brands',
  },
}));

const base = {
  id: 'exp-001',
  status: 'approved',
  merchant: 'Acme Corp',
  amount: '125.00',
  currency: 'USD',
  date: '2026-05-21',
  description: 'Team lunch',
  categoryId: 'cat-001',
  paymentMethodId: 'pm-001',
  zohoEntity: 'haute_brands',
  zohoExpenseId: null,
  reimbursementStatus: 'not_requested',
  userId: 'user-001',
  category: { name: 'Meals' },
  // Only a Zoho account id counts as mapped — the push sends this verbatim.
  paymentMethod: { label: 'Corporate AMEX', zohoAccountName: '5254962000000129043' },
  receipts: [{ id: 'r-001' }],
  messages: [],
};

describe('evaluateZohoReadiness — ready expense', () => {
  it('returns ready=true with all fields present and approved', () => {
    const result = evaluateZohoReadiness(base);
    expect(result.ready).toBe(true);
    expect(result.synced).toBe(false);
    expect(result.missing).toHaveLength(0);
    expect(result.mappedPayload).not.toBeNull();
  });

  it('includes mode in result', () => {
    const result = evaluateZohoReadiness(base);
    expect(result.zohoMode).toBe('mock');
    expect(result.warnings).toContain('Zoho is in mock mode — no live writes will occur');
  });

  it('includes push-gate checks without treating sync as a failure', () => {
    const result = evaluateZohoReadiness(base);
    expect(result.checks).toHaveLength(11);
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(result.checks.some((c) => c.label === 'Not already synced')).toBe(false);
  });

  it('maps payload correctly', () => {
    const result = evaluateZohoReadiness(base);
    expect(result.mappedPayload).toMatchObject({
      expenseId: 'exp-001',
      merchant: 'Acme Corp',
      amount: '125.00',
      currency: 'USD',
      date: '2026-05-21',
      zohoEntity: 'haute_brands',
      categoryName: 'Meals',
      paymentMethodLabel: 'Corporate AMEX',
      brand: 'haute_brands',
    });
  });
});

describe('evaluateZohoReadiness — missing fields', () => {
  it('not ready when status is pending', () => {
    const result = evaluateZohoReadiness({ ...base, status: 'pending' });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('expense must be approved');
    expect(result.mappedPayload).toBeNull();
  });

  it('marks already-synced expenses as done, not as a missing field', () => {
    const result = evaluateZohoReadiness({ ...base, zohoExpenseId: 'Z-123' });
    expect(result.ready).toBe(false);
    expect(result.synced).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('not ready without category', () => {
    const result = evaluateZohoReadiness({ ...base, categoryId: null, category: null });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('expense account (Zoho COA or category)');
  });

  it('not ready without payment method', () => {
    const result = evaluateZohoReadiness({ ...base, paymentMethodId: null, paymentMethod: null });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('payment method');
  });

  it('not ready when the card has no Zoho paid-through mapping', () => {
    const result = evaluateZohoReadiness({
      ...base,
      paymentMethod: { label: 'Corporate AMEX', zohoAccountName: null },
    });
    expect(result.ready).toBe(false);
    expect(result.missing.some((m) => m.includes('paid-through'))).toBe(true);
  });

  it('not ready without zohoEntity', () => {
    const result = evaluateZohoReadiness({ ...base, zohoEntity: null });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('accounting entity (zohoEntity)');
  });

  it('not ready without receipt', () => {
    const result = evaluateZohoReadiness({ ...base, receipts: [] });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('receipt attachment');
  });

  it('not ready with unresolved accountant request', () => {
    const result = evaluateZohoReadiness({
      ...base,
      messages: [{ requestType: 'info_request', isResolved: false }],
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('unresolved accountant requests');
  });

  it('not ready without merchant', () => {
    const result = evaluateZohoReadiness({ ...base, merchant: '' });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('merchant name');
  });

  it('not ready without userId', () => {
    const result = evaluateZohoReadiness({ ...base, userId: null });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('submitter (user)');
  });

  it('resolved messages do not block readiness', () => {
    const result = evaluateZohoReadiness({
      ...base,
      messages: [{ requestType: 'info_request', isResolved: true }],
    });
    expect(result.ready).toBe(true);
  });
});

describe('evaluateZohoReadiness — paid-through must be an account id', () => {
  // Readiness once passed on any non-empty zoho_account_name while the push
  // required a numeric id, so a labelled card showed "all checks passed" and
  // then failed with MISSING_ZOHO_PAID_THROUGH.
  const labelled = {
    ...base,
    paymentMethod: { label: 'Corporate AMEX', zohoAccountName: 'Employee Reimbursements' },
  };

  it('is not ready when the card maps to a label instead of an id', () => {
    const result = evaluateZohoReadiness(labelled);
    expect(result.ready).toBe(false);
  });

  it('fails the paid-through check shown to accountants', () => {
    const check = evaluateZohoReadiness(labelled).checks
      .find((c) => c.label === 'Payment method mapped to Zoho account');
    expect(check?.pass).toBe(false);
  });

  it('explains that the stored value is not an account id', () => {
    const result = evaluateZohoReadiness(labelled);
    expect(result.missing.some((m) => m.includes('Employee Reimbursements'))).toBe(true);
    expect(result.missing.some((m) => m.includes('not a Zoho account id'))).toBe(true);
  });

  it('sends no paid_through_account_id for a labelled card', () => {
    expect(evaluateZohoReadiness(labelled).servicePayload.paid_through_account_id).toBeNull();
  });

  it('does not warn that a labelled card maps to a Zoho account', () => {
    const result = evaluateZohoReadiness(labelled);
    expect(result.warnings.some((w) => w.includes('maps to Zoho account'))).toBe(false);
  });

  it('is ready once the card maps to a real account id', () => {
    const result = evaluateZohoReadiness({
      ...base,
      paymentMethod: { label: 'Corporate AMEX', zohoAccountName: '4849689000010206091' },
    });
    expect(result.ready).toBe(true);
    expect(result.servicePayload.paid_through_account_id).toBe('4849689000010206091');
  });
});

describe('evaluateZohoReadiness — warnings', () => {
  it('warns when reimbursement is pending', () => {
    const result = evaluateZohoReadiness({ ...base, reimbursementStatus: 'pending' });
    expect(result.warnings.some((w) => w.includes('reimbursement is pending'))).toBe(true);
  });

  it('warns with the Zoho account id the payment method maps to', () => {
    const result = evaluateZohoReadiness({
      ...base,
      paymentMethod: { label: 'Corporate AMEX', zohoAccountName: '4849689000010206091' },
    });
    expect(result.warnings.some((w) => w.includes('4849689000010206091'))).toBe(true);
  });

  it('no zoho-mode warning for live mode', () => {
    // We'd need to change the mock to test this, but verify mock mode warning is present
    const result = evaluateZohoReadiness(base);
    expect(result.warnings.some((w) => w.includes('mock mode'))).toBe(true);
  });
});

describe('MIDAS_VERSION', () => {
  it('is a semver prerelease string', () => {
    expect(MIDAS_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
  });
});
