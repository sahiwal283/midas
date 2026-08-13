import { describe, expect, it } from 'vitest';
import { editableFields, editRefusalMessage } from '../lib/expenseEdit';
import { isLikelyDuplicate } from '../lib/duplicates';

describe('editableFields', () => {
  it('zoho-synced is never editable regardless of status', () => {
    expect(editableFields('draft', 'zoho-123')).toBe('none');
    expect(editableFields('approved', 'zoho-123')).toBe('none');
  });
  it('draft and awaiting_info are fully editable', () => {
    expect(editableFields('draft', null)).toBe('all');
    expect(editableFields('awaiting_info', null)).toBe('all');
  });
  it('pending is fully editable so submitters can complete missing fields pre-review', () => {
    expect(editableFields('pending', null)).toBe('all');
  });
  it('in_review/approved/rejected/zoho_sync_failed are locked', () => {
    for (const s of ['in_review', 'approved', 'rejected', 'zoho_sync_failed']) {
      expect(editableFields(s, null)).toBe('none');
    }
  });
  it('refusal messages are state-specific', () => {
    expect(editRefusalMessage('approved', 'z1')).toMatch(/synced to Zoho/);
    expect(editRefusalMessage('approved', null)).toMatch(/approved/);
  });
});

describe('isLikelyDuplicate', () => {
  const base = { merchant: 'Delta Air Lines', amount: 482.17, date: '2026-08-05' };

  it('matches same amount, close date, overlapping merchant', () => {
    expect(isLikelyDuplicate(base, { merchant: 'DELTA', amount: '482.17', date: '2026-08-05' })).toBe(true);
    expect(isLikelyDuplicate(base, { merchant: 'delta air lines inc.', amount: 482.17, date: '2026-08-07' })).toBe(true);
  });

  it('rejects different amounts, far dates, unrelated merchants', () => {
    expect(isLikelyDuplicate(base, { merchant: 'DELTA', amount: 482.18, date: '2026-08-05' })).toBe(false);
    expect(isLikelyDuplicate(base, { merchant: 'DELTA', amount: 482.17, date: '2026-08-10' })).toBe(false);
    expect(isLikelyDuplicate(base, { merchant: 'United', amount: 482.17, date: '2026-08-05' })).toBe(false);
  });
});
