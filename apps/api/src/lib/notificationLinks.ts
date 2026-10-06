/**
 * Where a notification takes the person who taps it.
 *
 * Pure: no db, no env. Shared by the push payload (lib/notify) and the
 * notification list (routes/notifications) so the bell, the dashboard and a
 * push on the lock screen all open the same place.
 */

import type { UserRole } from '@midas/shared';
import { roleAllowed } from './roles';

export interface NotificationPathInput {
  type: string;
  /** Null once the expense has been deleted out from under the notification. */
  expenseId: string | null;
  ownerId: string | null;
  recipientId: string;
  recipientRole: UserRole;
}

/** Notification types that are about the conversation rather than the record. */
const CONVERSATION_TYPES = new Set(['message', 'mention', 'action_required']);

export function notificationPath(input: NotificationPathInput): string {
  if (!input.expenseId) return '/dashboard';

  // Staff looking at someone else's expense work from the review page; on
  // their own expense they are a submitter like anyone else.
  const reviewing = input.recipientId !== input.ownerId
    && roleAllowed(input.recipientRole, ['accountant', 'admin']);
  const page = reviewing ? `/accountant/${input.expenseId}` : `/expenses/${input.expenseId}`;

  return CONVERSATION_TYPES.has(input.type) ? `${page}#conversation` : page;
}
