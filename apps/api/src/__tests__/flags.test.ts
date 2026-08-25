import { describe, it, expect } from 'vitest';
import { computeFlags, type FlagsInput } from '../lib/flags';

// Baseline "perfect" approved expense — all fields present, not yet synced
const approved: FlagsInput = {
  status: 'approved',
  categoryId: 'cat-001',
  paymentMethodId: 'pm-001',
  receipts: [{ id: 'r-001' }],
  zohoEntity: 'Corporate AMEX',
  zohoExpenseId: null,
  reimbursementStatus: 'not_requested',
  sourceApp: null,
};

// Baseline pending expense — common case before accountant review
const pending: FlagsInput = {
  status: 'pending',
  categoryId: null,
  paymentMethodId: null,
  receipts: [],
  zohoEntity: null,
  zohoExpenseId: null,
  reimbursementStatus: 'not_requested',
  sourceApp: null,
};

describe('computeFlags — Zoho readiness', () => {
  it('is ready_for_zoho when approved with all required fields', () => {
    expect(computeFlags(approved)).toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho when already synced', () => {
    expect(computeFlags({ ...approved, zohoExpenseId: 'Z-12345' })).not.toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho without zohoEntity', () => {
    expect(computeFlags({ ...approved, zohoEntity: null })).not.toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho without category', () => {
    expect(computeFlags({ ...approved, categoryId: null })).not.toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho without payment method', () => {
    expect(computeFlags({ ...approved, paymentMethodId: null })).not.toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho without a receipt', () => {
    expect(computeFlags({ ...approved, receipts: [] })).not.toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho when status is pending', () => {
    expect(computeFlags({ ...approved, status: 'pending' })).not.toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho when status is rejected', () => {
    expect(computeFlags({ ...approved, status: 'rejected' })).not.toContain('ready_for_zoho');
  });

  it('produces exactly [ready_for_zoho] when all fields are present and approved', () => {
    expect(computeFlags(approved)).toEqual(['ready_for_zoho']);
  });

  it('is ready_for_zoho when the card maps to a Zoho account id', () => {
    const flags = computeFlags({
      ...approved,
      paymentMethod: { zohoAccountName: '4849689000010206091' },
    });
    expect(flags).toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho when the card maps to a label, which the push rejects', () => {
    const flags = computeFlags({
      ...approved,
      paymentMethod: { zohoAccountName: 'Employee Reimbursements' },
    });
    expect(flags).not.toContain('ready_for_zoho');
  });

  it('is NOT ready_for_zoho when the card has no Zoho mapping', () => {
    const flags = computeFlags({ ...approved, paymentMethod: { zohoAccountName: null } });
    expect(flags).not.toContain('ready_for_zoho');
  });
});

describe('computeFlags — zoho_synced', () => {
  it('adds zoho_synced when zohoExpenseId is set', () => {
    expect(computeFlags({ ...approved, zohoExpenseId: 'Z-99' })).toContain('zoho_synced');
  });

  it('does NOT add zoho_synced when zohoExpenseId is null', () => {
    expect(computeFlags(approved)).not.toContain('zoho_synced');
  });
});

describe('computeFlags — missing field flags', () => {
  it('adds needs_category when categoryId is null', () => {
    expect(computeFlags({ ...pending, categoryId: null })).toContain('needs_category');
  });

  it('does NOT add needs_category when category is set', () => {
    expect(computeFlags({ ...pending, categoryId: 'cat-001' })).not.toContain('needs_category');
  });

  it('adds missing_receipt when receipts is empty', () => {
    expect(computeFlags({ ...pending, receipts: [] })).toContain('missing_receipt');
  });

  it('adds missing_receipt when receipts is undefined', () => {
    const row: FlagsInput = { ...pending };
    delete (row as Partial<FlagsInput>).receipts;
    expect(computeFlags(row)).toContain('missing_receipt');
  });

  it('does NOT add missing_receipt when a receipt exists', () => {
    expect(computeFlags({ ...pending, receipts: [{ id: 'r-001' }] })).not.toContain('missing_receipt');
  });

  it('adds needs_payment_method when paymentMethodId is null', () => {
    expect(computeFlags({ ...pending, paymentMethodId: null })).toContain('needs_payment_method');
  });

  it('does NOT add needs_payment_method when payment method is set', () => {
    expect(computeFlags({ ...pending, paymentMethodId: 'pm-001' })).not.toContain('needs_payment_method');
  });
});

describe('computeFlags — needs_entity', () => {
  it('adds needs_entity when approved and zohoEntity is null', () => {
    expect(computeFlags({ ...approved, zohoEntity: null })).toContain('needs_entity');
  });

  it('does NOT add needs_entity when approved and zohoEntity is set', () => {
    expect(computeFlags(approved)).not.toContain('needs_entity');
  });

  it('does NOT add needs_entity when status is pending (only for approved)', () => {
    expect(computeFlags({ ...pending, zohoEntity: null })).not.toContain('needs_entity');
  });

  it('does NOT add needs_entity when status is awaiting_info', () => {
    expect(computeFlags({ ...pending, status: 'awaiting_info', zohoEntity: null })).not.toContain('needs_entity');
  });
});

describe('computeFlags — reimbursement_pending', () => {
  it('adds reimbursement_pending when reimbursementStatus is pending', () => {
    expect(computeFlags({ ...approved, reimbursementStatus: 'pending' })).toContain('reimbursement_pending');
  });

  it('does NOT add reimbursement_pending when status is not_requested', () => {
    expect(computeFlags(approved)).not.toContain('reimbursement_pending');
  });

  it('does NOT add reimbursement_pending when status is paid', () => {
    expect(computeFlags({ ...approved, reimbursementStatus: 'paid' })).not.toContain('reimbursement_pending');
  });

  it('does NOT add reimbursement_pending when status is approved', () => {
    expect(computeFlags({ ...approved, reimbursementStatus: 'approved' })).not.toContain('reimbursement_pending');
  });
});

describe('computeFlags — from_extension', () => {
  it('adds from_extension when sourceApp is browser_extension', () => {
    expect(computeFlags({ ...pending, sourceApp: 'browser_extension' })).toContain('from_extension');
  });

  it('does NOT add from_extension for other sourceApp values', () => {
    expect(computeFlags({ ...pending, sourceApp: 'argo' })).not.toContain('from_extension');
    expect(computeFlags({ ...pending, sourceApp: 'milo' })).not.toContain('from_extension');
    expect(computeFlags({ ...pending, sourceApp: null })).not.toContain('from_extension');
  });
});

describe('computeFlags — combined scenarios', () => {
  it('empty pending expense has three missing-field flags', () => {
    const flags = computeFlags(pending);
    expect(flags).toContain('needs_category');
    expect(flags).toContain('missing_receipt');
    expect(flags).toContain('needs_payment_method');
    expect(flags).not.toContain('needs_entity'); // not approved
    expect(flags).not.toContain('ready_for_zoho');
    expect(flags).not.toContain('reimbursement_pending');
  });

  it('approved expense missing entity and receipt is not ready_for_zoho', () => {
    const flags = computeFlags({
      ...approved,
      zohoEntity: null,
      receipts: [],
    });
    expect(flags).toContain('needs_entity');
    expect(flags).toContain('missing_receipt');
    expect(flags).not.toContain('ready_for_zoho');
  });

  it('already-synced approved expense has zoho_synced but not ready_for_zoho', () => {
    const flags = computeFlags({ ...approved, zohoExpenseId: 'Z-100' });
    expect(flags).toContain('zoho_synced');
    expect(flags).not.toContain('ready_for_zoho');
    expect(flags).not.toContain('needs_entity'); // zohoEntity is set in approved baseline
  });

  it('extension submission pending review has from_extension + missing fields', () => {
    const flags = computeFlags({
      ...pending,
      sourceApp: 'browser_extension',
    });
    expect(flags).toContain('from_extension');
    expect(flags).toContain('needs_category');
    expect(flags).toContain('missing_receipt');
    expect(flags).toContain('needs_payment_method');
  });

  it('fully complete approved expense with reimbursement pending has both flags', () => {
    const flags = computeFlags({ ...approved, reimbursementStatus: 'pending' });
    expect(flags).toContain('ready_for_zoho');
    expect(flags).toContain('reimbursement_pending');
  });
});

describe('computeFlags — non-Zoho companies', () => {
  const readyRow = {
    sourceApp: 'trade_show',
    categoryId: 'cat-1',
    paymentMethodId: 'pm-1',
    receipts: [{ id: 'r-1' }],
    zohoEntity: 'Summitt Labs',
    zohoExpenseId: null,
    reimbursementStatus: 'not_requested',
    status: 'approved',
  };

  it('does not mark an expense ready for Zoho when its company has Zoho disabled', () => {
    expect(computeFlags({ ...readyRow, companyZohoEnabled: false })).not.toContain('ready_for_zoho');
  });

  it('still marks it ready when the company has Zoho enabled', () => {
    expect(computeFlags({ ...readyRow, companyZohoEnabled: true })).toContain('ready_for_zoho');
  });

  it('treats an unknown companyZohoEnabled as enabled, preserving today behaviour', () => {
    expect(computeFlags(readyRow)).toContain('ready_for_zoho');
  });

  it('leaves the other flags untouched for a non-Zoho company', () => {
    const flags = computeFlags({
      ...readyRow, companyZohoEnabled: false, receipts: [], paymentMethodId: null,
    });
    expect(flags).toContain('missing_receipt');
    expect(flags).toContain('needs_payment_method');
  });
});

describe('computeFlags — return type contains only known flags', () => {
  const KNOWN_FLAGS = new Set([
    'from_extension', 'needs_category', 'missing_receipt',
    'needs_payment_method', 'needs_entity', 'reimbursement_pending',
    'zoho_synced', 'ready_for_zoho',
  ]);

  it('never returns unknown flags', () => {
    const inputs: FlagsInput[] = [approved, pending, { ...approved, zohoExpenseId: 'Z-1' }];
    for (const input of inputs) {
      for (const flag of computeFlags(input)) {
        expect(KNOWN_FLAGS.has(flag)).toBe(true);
      }
    }
  });
});
