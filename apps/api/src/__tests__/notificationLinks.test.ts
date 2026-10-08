import { describe, it, expect } from 'vitest';
import { notificationPath } from '../lib/notificationLinks';

const base = { expenseId: 'exp-1', ownerId: 'user-owner' };

describe('notificationPath', () => {
  it('sends the submitter to their expense', () => {
    expect(notificationPath({ ...base, type: 'approved', recipientId: 'user-owner', recipientRole: 'user' }))
      .toBe('/expenses/exp-1');
  });

  it('lands a message on the conversation', () => {
    expect(notificationPath({ ...base, type: 'message', recipientId: 'user-owner', recipientRole: 'user' }))
      .toBe('/expenses/exp-1#conversation');
  });

  it('lands a mention on the conversation, on the page that fits the recipient', () => {
    expect(notificationPath({ ...base, type: 'mention', recipientId: 'user-owner', recipientRole: 'user' }))
      .toBe('/expenses/exp-1#conversation');
    expect(notificationPath({ ...base, type: 'mention', recipientId: 'a', recipientRole: 'admin' }))
      .toBe('/accountant/exp-1#conversation');
  });

  it('lands an information request on the conversation', () => {
    expect(notificationPath({ ...base, type: 'action_required', recipientId: 'user-owner', recipientRole: 'user' }))
      .toBe('/expenses/exp-1#conversation');
  });

  it('sends an accountant to the review page for someone else\'s expense', () => {
    expect(notificationPath({ ...base, type: 'message', recipientId: 'user-acct', recipientRole: 'accountant' }))
      .toBe('/accountant/exp-1#conversation');
  });

  it('sends admins and developers to the review page too', () => {
    expect(notificationPath({ ...base, type: 'message', recipientId: 'a', recipientRole: 'admin' }))
      .toBe('/accountant/exp-1#conversation');
    expect(notificationPath({ ...base, type: 'message', recipientId: 'd', recipientRole: 'developer' }))
      .toBe('/accountant/exp-1#conversation');
  });

  it('keeps an accountant on the submitter page for their own expense', () => {
    expect(notificationPath({ ...base, type: 'approved', recipientId: 'user-owner', recipientRole: 'accountant' }))
      .toBe('/expenses/exp-1');
  });

  it('falls back to the dashboard when the expense is gone', () => {
    expect(notificationPath({ expenseId: null, ownerId: null, type: 'message', recipientId: 'x', recipientRole: 'user' }))
      .toBe('/dashboard');
  });
});

describe('needs_review', () => {
  const base = { type: 'needs_review', expenseId: 'e-1', ownerId: 'u-1', recipientId: 'acc-1', recipientRole: 'accountant' as const };
  it('a show group opens event review', () => {
    expect(notificationPath({ ...base, groupKey: 'nr:u-1:event:ev-9' })).toBe('/accountant/events');
  });
  it('a day group opens daily review', () => {
    expect(notificationPath({ ...base, groupKey: 'nr:u-1:day:2026-10-08' })).toBe('/accountant/daily');
  });
  it('still opens the queue when the newest expense in the group was deleted', () => {
    expect(notificationPath({ ...base, expenseId: null, groupKey: 'nr:u-1:event:ev-9' })).toBe('/accountant/events');
  });
});
