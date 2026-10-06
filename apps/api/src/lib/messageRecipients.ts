/**
 * Who hears about a new expense message.
 *
 * Conversation is two-directional: an accountant asking a question needs the
 * submitter to see it, and the submitter's reply needs to reach the accountant
 * side — accountants otherwise only discover replies by re-opening the queue.
 * Nobody is ever notified about their own message.
 *
 * A reply is routed to whoever is actually in the conversation, not whoever
 * holds the review: reviewedById is only set by an approve/reject/request-info
 * decision, so an accountant who simply wrote on an auto-approved expense holds
 * no claim and used to never hear the answer.
 *
 * Pure: no db, no env. The caller supplies everyone it might need.
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
  /** The most recent accountant/admin to post in this thread, when one has. */
  lastStaffPosterId: string | null;
  /** Every active accountant — the last resort so a reply is never dropped. */
  accountantIds: string[];
  /**
   * People @-mentioned in the message. The caller has already limited these
   * to users who can open the thread.
   */
  mentionedIds?: string[];
}

/** The user ids to notify; empty when this message should notify nobody. */
export function resolveMessageRecipients(input: MessageRecipientInput): string[] {
  if (input.isSystem) return [];

  // An accountant on their own expense is a submitter here, not a reviewer —
  // ownership decides the direction, role only breaks the tie.
  if (input.senderId !== input.ownerId) {
    return roleAllowed(input.senderRole, ['accountant', 'admin']) ? [input.ownerId] : [];
  }

  for (const candidate of [input.lastStaffPosterId, input.reviewedById]) {
    if (candidate && candidate !== input.senderId) return [candidate];
  }
  return input.accountantIds.filter((id) => id !== input.senderId);
}

export interface MessageNotification {
  userId: string;
  /** 'mention' when the message names them; 'message' for the usual routing. */
  type: 'mention' | 'message';
}

/**
 * Everyone to notify about a message, and why. A mention adds a recipient and
 * never removes one: whoever would have heard about the message without it
 * still does. Someone who is both hears once, as a mention.
 */
export function planMessageNotifications(input: MessageRecipientInput): MessageNotification[] {
  if (input.isSystem) return [];

  const mentioned = [...new Set(input.mentionedIds ?? [])].filter((id) => id !== input.senderId);
  const usual = resolveMessageRecipients(input).filter((id) => !mentioned.includes(id));
  return [
    ...mentioned.map((userId) => ({ userId, type: 'mention' as const })),
    ...usual.map((userId) => ({ userId, type: 'message' as const })),
  ];
}
