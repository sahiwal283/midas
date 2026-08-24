/**
 * Who hears about a new expense message.
 *
 * Conversation is two-directional: an accountant asking a question needs the
 * submitter to see it, and the submitter's reply needs to reach whoever claimed
 * the review — accountants otherwise only discover replies by re-opening the
 * queue. Nobody is ever notified about their own message.
 *
 * Pure: no db, no env. The route supplies the expense's owner and reviewer.
 */

import type { UserRole } from '@midas/shared';
import { roleAllowed } from './roles';

export interface MessageRecipientInput {
  /** System messages are written by the app itself — they notify nobody. */
  isSystem: boolean;
  senderId: string;
  senderRole: UserRole;
  /** The expense's submitter. */
  ownerId: string;
  /** The accountant who claimed the review, when one has. */
  reviewedById: string | null;
}

/** The user id to notify, or null when this message should notify nobody. */
export function resolveMessageRecipient(input: MessageRecipientInput): string | null {
  if (input.isSystem) return null;

  // An accountant on their own expense is a submitter here, not a reviewer —
  // ownership decides the direction, role only breaks the tie.
  const isOwner = input.senderId === input.ownerId;
  const recipient = isOwner
    ? input.reviewedById
    : roleAllowed(input.senderRole, ['accountant', 'admin'])
      ? input.ownerId
      : null;

  if (!recipient || recipient === input.senderId) return null;
  return recipient;
}
