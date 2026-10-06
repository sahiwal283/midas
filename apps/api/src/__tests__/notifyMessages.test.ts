import { describe, expect, it } from 'vitest';
import { buildCatchUpPush, buildNotification, formatAmount, truncateExcerpt, type NotificationType } from '../lib/notifyMessages';

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

  it('words a reply for the accountant side as someone else\'s expense', () => {
    const { title, body } = buildNotification('message', {
      merchant: 'Summitt labs',
      amount: '948.00',
      senderName: 'Seri',
      excerpt: 'Fixed it',
      toStaff: true,
    });
    expect(title).toBe('Seri replied on an expense');
    expect(body).toBe('Seri on their $948.00 expense at Summitt labs: "Fixed it"');
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

describe('mention notifications', () => {
  it('tells a colleague who mentioned them, without calling the expense theirs', () => {
    const { title, body } = buildNotification('mention', {
      merchant: 'Summitt labs',
      amount: '948.00',
      senderName: 'Sahil',
      excerpt: '@digi please map the Equipment category',
      toStaff: true,
    });
    expect(title).toBe('Sahil mentioned you on an expense');
    expect(body).toBe('Sahil on a $948.00 expense at Summitt labs: "@digi please map the Equipment category"');
  });

  it('calls the expense yours when the submitter is mentioned', () => {
    const { title, body } = buildNotification('mention', {
      merchant: 'Summitt labs',
      amount: '948.00',
      senderName: 'Dana',
      excerpt: '@seri which card?',
    });
    expect(title).toBe('Dana mentioned you on your expense');
    expect(body).toBe('Dana on your $948.00 expense at Summitt labs: "@seri which card?"');
  });

  it('falls back to a generic sender when the name is missing', () => {
    const { title } = buildNotification('mention', { merchant: 'X', amount: '1', toStaff: true });
    expect(title).toBe('Someone mentioned you on an expense');
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

describe('buildCatchUpPush', () => {
  const one = { id: 'n1', title: 'New message on your expense', body: 'Digi: "hello"', path: '/expenses/e1#conversation' };
  const two = { id: 'n2', title: 'Expense approved', body: 'Your $5.00 expense was approved.', path: '/expenses/e2' };

  it('sends nothing when there is nothing unread', () => {
    expect(buildCatchUpPush([])).toBeNull();
  });

  it('replays a single missed notification as itself', () => {
    expect(buildCatchUpPush([one])).toEqual({
      title: one.title,
      body: one.body,
      url: one.path,
      tag: 'catch-up',
      notificationId: 'n1',
    });
  });

  it('summarises several, leading with the newest, and opens the dashboard', () => {
    expect(buildCatchUpPush([one, two])).toEqual({
      title: 'You have 2 unread notifications',
      body: 'Latest: New message on your expense — Digi: "hello"',
      url: '/dashboard',
      tag: 'catch-up',
    });
  });

  it('copes with a notification that has no body', () => {
    expect(buildCatchUpPush([{ ...one, body: null }, two])?.body)
      .toBe('Latest: New message on your expense');
  });
});
