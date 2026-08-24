import { describe, it, expect } from 'vitest';
import { resolveMessageRecipient } from '../lib/messageRecipients';

const owner = 'user-owner';
const accountant = 'user-accountant';
const reviewer = 'user-reviewer';

describe('resolveMessageRecipient', () => {
  it('notifies the owner when an accountant posts', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: accountant,
      senderRole: 'accountant',
      ownerId: owner,
      reviewedById: null,
    })).toBe(owner);
  });

  it('notifies the owner when an admin posts', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: accountant,
      senderRole: 'admin',
      ownerId: owner,
      reviewedById: null,
    })).toBe(owner);
  });

  it('notifies the owner when a developer posts', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: accountant,
      senderRole: 'developer',
      ownerId: owner,
      reviewedById: null,
    })).toBe(owner);
  });

  it('notifies the claiming reviewer when the owner replies', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: owner,
      senderRole: 'user',
      ownerId: owner,
      reviewedById: reviewer,
    })).toBe(reviewer);
  });

  it('notifies nobody when the owner replies on an unclaimed expense', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: owner,
      senderRole: 'user',
      ownerId: owner,
      reviewedById: null,
    })).toBeNull();
  });

  it('never notifies the sender when they are also the reviewer', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: owner,
      senderRole: 'user',
      ownerId: owner,
      reviewedById: owner,
    })).toBeNull();
  });

  it('never notifies an accountant messaging their own expense', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: accountant,
      senderRole: 'accountant',
      ownerId: accountant,
      reviewedById: null,
    })).toBeNull();
  });

  it('falls back to the owner when a privileged sender is the reviewer', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: reviewer,
      senderRole: 'accountant',
      ownerId: owner,
      reviewedById: reviewer,
    })).toBe(owner);
  });

  it('notifies nobody for system messages', () => {
    expect(resolveMessageRecipient({
      isSystem: true,
      senderId: accountant,
      senderRole: 'accountant',
      ownerId: owner,
      reviewedById: null,
    })).toBeNull();
  });

  it('treats a partner posting on their own expense as the owner path', () => {
    expect(resolveMessageRecipient({
      isSystem: false,
      senderId: owner,
      senderRole: 'partner',
      ownerId: owner,
      reviewedById: reviewer,
    })).toBe(reviewer);
  });
});
