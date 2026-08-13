import { describe, expect, it } from 'vitest';
import { editableFields, editRefusalMessage } from '../lib/expenseEdit';

describe('editableFields', () => {
  it('draft and awaiting_info are fully editable', () => {
    expect(editableFields('draft', null)).toBe('all');
    expect(editableFields('awaiting_info', null)).toBe('all');
  });

  it('pending is fully editable so submitters can complete missing fields pre-review', () => {
    expect(editableFields('pending', null)).toBe('all');
  });

  it('reviewed/terminal states are locked', () => {
    expect(editableFields('in_review', null)).toBe('none');
    expect(editableFields('approved', null)).toBe('none');
    expect(editableFields('rejected', null)).toBe('none');
  });

  it('Zoho-synced expenses are never editable regardless of status', () => {
    expect(editableFields('draft', 'zoho-123')).toBe('none');
    expect(editableFields('pending', 'zoho-123')).toBe('none');
  });
});

describe('editRefusalMessage', () => {
  it('explains the Zoho lock', () => {
    expect(editRefusalMessage('pending', 'zoho-123')).toMatch(/synced to Zoho/);
  });

  it('explains locked statuses', () => {
    expect(editRefusalMessage('approved', null)).toMatch(/approved/);
  });
});
