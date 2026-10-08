import { connectionSourceApp, type ConnectionScopeInput } from '../lib/ext/connectionScope';
import { clampLimit, parseSince, toFeedEvent, type FeedEvent } from '../lib/extEvents';
import { listExtEvents } from '../lib/extEventsDb';

export type EventsPage =
  | { ok: true; body: { events: FeedEvent[]; nextCursor: string | null } }
  | { ok: false };

/** One page of the calling connection's events. `ok: false` means the cursor was invalid. */
export async function buildEventsPage(
  conn: ConnectionScopeInput | null | undefined,
  query: { since?: unknown; limit?: unknown },
): Promise<EventsPage> {
  const since = parseSince(query.since);
  if (since === null) return { ok: false };

  const rows = await listExtEvents(connectionSourceApp(conn), since, clampLimit(query.limit));
  const events = rows.map(toFeedEvent);
  return {
    ok: true,
    body: { events, nextCursor: events.length > 0 ? String(events[events.length - 1].seq) : null },
  };
}
