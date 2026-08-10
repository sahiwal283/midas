import { describe, expect, it } from 'vitest';
import { buildNotification, formatAmount, type NotificationType } from '../lib/notifyMessages';

describe('formatAmount', () => {
  it('formats numeric strings to two decimals', () => {
    expect(formatAmount('12.5')).toBe('$12.50');
  });

  it('formats numbers', () => {
    expect(formatAmount(100)).toBe('$100.00');
  });

  it('falls back to the raw value when not numeric', () => {
    expect(formatAmount('abc')).toBe('$abc');
  });
});

describe('buildNotification', () => {
  const input = { merchant: 'Staples', amount: '42.10' };

  const matrix: Array<[NotificationType, string, string]> = [
    [
      'action_required',
      'Action required: expense needs information',
      'Your accountant needs additional information for your $42.10 expense at Staples.',
    ],
    [
      'approved',
      'Expense approved',
      'Your $42.10 expense at Staples was approved.',
    ],
    [
      'rejected',
      'Expense rejected',
      'Your $42.10 expense at Staples was rejected.',
    ],
    [
      'reimbursement_paid',
      'Reimbursement paid',
      'Your $42.10 reimbursement for Staples was marked paid.',
    ],
  ];

  it.each(matrix)('%s → expected title + body', (type, title, body) => {
    expect(buildNotification(type, input)).toEqual({ title, body });
  });

  it('appends the note to rejection bodies when present', () => {
    const { body } = buildNotification('rejected', { ...input, note: 'Duplicate submission' });
    expect(body).toBe('Your $42.10 expense at Staples was rejected. Note: Duplicate submission');
  });

  it('ignores the note for non-rejection types', () => {
    const { body } = buildNotification('approved', { ...input, note: 'Looks good' });
    expect(body).toBe('Your $42.10 expense at Staples was approved.');
  });
});
