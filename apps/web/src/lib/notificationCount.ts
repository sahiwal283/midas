/**
 * How many unread notifications a list of rows stands for. A grouped row
 * (needs_review) carries a `count`; every other row is one. This is the same
 * sum the API's `unreadCount` uses, so the two can be compared.
 */
export function shownUnreadCount(rows: ReadonlyArray<{ count?: number }>): number {
  return rows.reduce((sum, n) => sum + (n.count ?? 1), 0);
}
