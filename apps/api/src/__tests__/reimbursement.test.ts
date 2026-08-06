import { describe, expect, it } from 'vitest';
import {
  nextReimbursementOnCardLink,
  paymentMethodRequiresReimbursement,
} from '../lib/reimbursement';

describe('paymentMethodRequiresReimbursement', () => {
  it('uses flag', () => {
    expect(paymentMethodRequiresReimbursement({ requiresReimbursement: true, label: 'Corp' })).toBe(true);
  });

  it('detects personal label', () => {
    expect(paymentMethodRequiresReimbursement({
      requiresReimbursement: false,
      label: 'Personal (Need reimbursement)',
    })).toBe(true);
  });
});

describe('nextReimbursementOnCardLink', () => {
  it('promotes not_requested → pending for personal cards', () => {
    expect(nextReimbursementOnCardLink('not_requested', {
      requiresReimbursement: true,
      label: 'Personal',
    })).toBe('pending');
  });

  it('leaves approved alone', () => {
    expect(nextReimbursementOnCardLink('approved', { requiresReimbursement: true })).toBeNull();
  });

  it('ignores company cards', () => {
    expect(nextReimbursementOnCardLink('not_requested', {
      requiresReimbursement: false,
      label: 'Haute PNC',
    })).toBeNull();
  });
});
