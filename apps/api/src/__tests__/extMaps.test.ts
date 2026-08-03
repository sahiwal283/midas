import { describe, expect, it } from 'vitest';
import { mapImportExpenseStatus, mapImportReimbursementStatus } from '../lib/ext/maps';

describe('mapImportExpenseStatus', () => {
  it('maps Trade Show needs further review to awaiting_info', () => {
    expect(mapImportExpenseStatus('needs further review')).toBe('awaiting_info');
  });

  it('maps common statuses', () => {
    expect(mapImportExpenseStatus('pending')).toBe('pending');
    expect(mapImportExpenseStatus('approved')).toBe('approved');
    expect(mapImportExpenseStatus('rejected')).toBe('rejected');
    expect(mapImportExpenseStatus('draft')).toBe('draft');
  });

  it('defaults unknown to pending', () => {
    expect(mapImportExpenseStatus('weird')).toBe('pending');
    expect(mapImportExpenseStatus(null)).toBe('pending');
  });
});

describe('mapImportReimbursementStatus', () => {
  it('includes rejected', () => {
    expect(mapImportReimbursementStatus('rejected')).toBe('rejected');
  });

  it('maps pending review and required flag', () => {
    expect(mapImportReimbursementStatus('pending review')).toBe('pending');
    expect(mapImportReimbursementStatus(null, true)).toBe('pending');
    expect(mapImportReimbursementStatus(null, false)).toBe('not_requested');
  });
});
