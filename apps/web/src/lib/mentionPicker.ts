import { useQuery } from '@tanstack/react-query';
import type { User } from '@midas/shared';
import { expenseApi } from '../api/expenses';

/** Someone who can be @-mentioned in an expense conversation. */
export type MentionableUser = Pick<User, 'id' | 'username' | 'name' | 'role'>;

/** Most suggestions the picker shows at once. */
const PICKER_LIMIT = 6;

/**
 * The people to suggest for what has been typed after the `@`. Username
 * matches come first; a match on any word of the name follows, because people
 * know each other by name rather than by handle. You cannot mention yourself.
 */
export function filterMentionable(
  users: MentionableUser[],
  query: string,
  currentUserId: string | undefined,
): MentionableUser[] {
  const q = query.toLowerCase();
  const others = users.filter((u) => u.id !== currentUserId);
  const byUsername = others.filter((u) => u.username.toLowerCase().startsWith(q));
  const byName = others.filter((u) => !byUsername.includes(u)
    && u.name.toLowerCase().split(/\s+/).some((word) => word.startsWith(q)));
  return [...byUsername, ...byName].slice(0, PICKER_LIMIT);
}

/**
 * Who can be mentioned on this expense. The composer and every bubble share
 * one cached request. A failure just means no picker and no highlighting —
 * the conversation itself must keep working.
 */
export function useMentionable(expenseId: string | undefined): MentionableUser[] {
  const { data } = useQuery({
    queryKey: ['expense-mentionable', expenseId],
    queryFn: () => expenseApi.mentionable(expenseId!),
    enabled: !!expenseId,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return data ?? [];
}
