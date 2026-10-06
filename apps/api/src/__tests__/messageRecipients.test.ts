import { describe, it, expect } from 'vitest';
import { resolveMessageRecipients, type MessageRecipientInput } from '../lib/messageRecipients';

const owner = 'user-owner';
const accountant = 'user-accountant';
const reviewer = 'user-reviewer';
const otherAccountant = 'user-accountant-2';

function input(over: Partial<MessageRecipientInput>): MessageRecipientInput {
  return {
    isSystem: false,
    senderId: accountant,
    senderRole: 'accountant',
    ownerId: owner,
    reviewedById: null,
    lastStaffPosterId: null,
    accountantIds: [],
    ...over,
  };
}

describe('resolveMessageRecipients', () => {
  it('notifies the owner when an accountant posts', () => {
    expect(resolveMessageRecipients(input({}))).toEqual([owner]);
  });

  it('notifies the owner when an admin posts', () => {
    expect(resolveMessageRecipients(input({ senderRole: 'admin' }))).toEqual([owner]);
  });

  it('notifies the owner when a developer posts', () => {
    expect(resolveMessageRecipients(input({ senderRole: 'developer' }))).toEqual([owner]);
  });

  it('notifies only the owner even when accountants exist', () => {
    expect(resolveMessageRecipients(input({ accountantIds: [accountant, otherAccountant] })))
      .toEqual([owner]);
  });

  it('notifies the claiming reviewer when the owner replies', () => {
    expect(resolveMessageRecipients(input({
      senderId: owner, senderRole: 'user', reviewedById: reviewer,
    }))).toEqual([reviewer]);
  });

  it('prefers whoever last wrote in the thread over the reviewer', () => {
    expect(resolveMessageRecipients(input({
      senderId: owner, senderRole: 'user',
      reviewedById: reviewer, lastStaffPosterId: accountant,
      accountantIds: [accountant, otherAccountant],
    }))).toEqual([accountant]);
  });

  it('reaches the accountant who messaged an expense nobody reviewed', () => {
    expect(resolveMessageRecipients(input({
      senderId: owner, senderRole: 'user', lastStaffPosterId: accountant,
    }))).toEqual([accountant]);
  });

  it('falls back to every accountant when no staff member touched the expense', () => {
    expect(resolveMessageRecipients(input({
      senderId: owner, senderRole: 'user', accountantIds: [accountant, otherAccountant],
    }))).toEqual([accountant, otherAccountant]);
  });

  it('notifies nobody when the owner replies and there is nobody to tell', () => {
    expect(resolveMessageRecipients(input({ senderId: owner, senderRole: 'user' }))).toEqual([]);
  });

  it('never notifies the sender when they are also the reviewer', () => {
    expect(resolveMessageRecipients(input({
      senderId: owner, senderRole: 'user', reviewedById: owner,
    }))).toEqual([]);
  });

  it('skips the sender in the accountant fallback', () => {
    expect(resolveMessageRecipients(input({
      senderId: accountant, senderRole: 'accountant', ownerId: accountant,
      accountantIds: [accountant, otherAccountant],
    }))).toEqual([otherAccountant]);
  });

  it('never notifies an accountant messaging their own expense when alone', () => {
    expect(resolveMessageRecipients(input({
      ownerId: accountant, accountantIds: [accountant],
    }))).toEqual([]);
  });

  it('falls back to the owner when a privileged sender is the reviewer', () => {
    expect(resolveMessageRecipients(input({
      senderId: reviewer, reviewedById: reviewer,
    }))).toEqual([owner]);
  });

  it('notifies nobody for system messages', () => {
    expect(resolveMessageRecipients(input({ isSystem: true, accountantIds: [otherAccountant] })))
      .toEqual([]);
  });

  it('notifies nobody when an unprivileged non-owner posts', () => {
    expect(resolveMessageRecipients(input({ senderId: 'user-other', senderRole: 'user' })))
      .toEqual([]);
  });

  it('treats a partner posting on their own expense as the owner path', () => {
    expect(resolveMessageRecipients(input({
      senderId: owner, senderRole: 'partner', reviewedById: reviewer,
    }))).toEqual([reviewer]);
  });
});
