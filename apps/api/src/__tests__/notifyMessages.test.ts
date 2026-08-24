import { describe, expect, it } from 'vitest';
import { buildNotification, formatAmount, truncateExcerpt, type NotificationType } from '../lib/notifyMessages';

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

describe('message notifications', () => {
  it('names the sender and quotes the message', () => {
    const { title, body } = buildNotification('message', {
      merchant: 'Summitt labs',
      amount: '948.00',
      senderName: 'Dana',
      excerpt: 'Which card was this on?',
    });
    expect(title).toBe('New message on your expense');
    expect(body).toContain('Dana');
    expect(body).toContain('$948.00');
    expect(body).toContain('Summitt labs');
    expect(body).toContain('Which card was this on?');
  });

  it('falls back to a generic sender when the name is missing', () => {
    const { body } = buildNotification('message', {
      merchant: 'Summitt labs',
      amount: '948.00',
      excerpt: 'hello',
    });
    expect(body).toContain('Someone');
  });
});

describe('truncateExcerpt', () => {
  it('leaves a short message untouched', () => {
    expect(truncateExcerpt('Which card was this on?')).toBe('Which card was this on?');
  });

  it('collapses newlines and runs of whitespace into single spaces', () => {
    expect(truncateExcerpt('line one\n\nline  two')).toBe('line one line two');
  });

  it('trims surrounding whitespace', () => {
    expect(truncateExcerpt('  padded  ')).toBe('padded');
  });

  it('truncates on a word boundary and appends an ellipsis', () => {
    const long = 'word '.repeat(60).trim();
    const out = truncateExcerpt(long);
    expect(out.length).toBeLessThanOrEqual(121);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('wor…');
  });

  it('hard-cuts a single unbroken token that exceeds the limit', () => {
    const out = truncateExcerpt('x'.repeat(200));
    expect(out.length).toBe(121);
    expect(out.endsWith('…')).toBe(true);
  });
});
