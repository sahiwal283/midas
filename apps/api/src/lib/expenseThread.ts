/**
 * Pure decisions for an expense message thread.
 *
 * Two surfaces post to the same thread — the session-auth route used by the
 * Midas web app, and the API-key Ext route used by Trade Show. Both ask these
 * functions the same questions so the two doors cannot drift apart. A drifted
 * state machine strands expenses in awaiting_info.
 *
 * Pure: no db, no env. Callers supply the expense's owner and status.
 */

import type { UserRole } from '@midas/shared';
import { roleAllowed } from './roles';

export interface ThreadAccessInput {
  viewerId: string;
  viewerRole: UserRole;
  /** The expense's submitter. */
  ownerId: string;
}

export interface ThreadAccessDecision {
  allowed: boolean;
  /** Whether internalNote may be shown. Never true for a plain submitter. */
  includeInternal: boolean;
}

export function decideThreadAccess(input: ThreadAccessInput): ThreadAccessDecision {
  const isOwner = input.viewerId === input.ownerId;
  const isPrivileged = roleAllowed(input.viewerRole, ['accountant', 'admin']);
  if (!isOwner && !isPrivileged) return { allowed: false, includeInternal: false };
  return { allowed: true, includeInternal: isPrivileged };
}

export interface ThreadPostInput {
  /** Current expense status. */
  status: string;
  senderId: string;
  senderRole: UserRole;
  ownerId: string;
}

export interface ThreadPostDecision {
  /** Resolve open requests and flip awaiting_info -> pending. */
  transitionsToPending: boolean;
  /** Whether this sender may set requestType at all. */
  mayRequestInfo: boolean;
}

export function decideThreadPost(input: ThreadPostInput): ThreadPostDecision {
  const isOwner = input.senderId === input.ownerId;
  return {
    transitionsToPending: input.status === 'awaiting_info' && isOwner,
    mayRequestInfo: roleAllowed(input.senderRole, ['accountant', 'admin']),
  };
}
