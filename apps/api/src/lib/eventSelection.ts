// Which Argo events belong in Midas's event picker, and in what order.
//
// Pure date maths — no DB, no framework — so the cutoff rule can be tested
// against Argo's without a database. The rule itself is ported from Argo's
// filterActiveEvents (trade-show-app/src/utils/eventUtils.ts): an event stays
// selectable until one month and one day past its end date.

// Type-only: this file (and its pure-function unit tests) must stay
// importable without a DATABASE_URL/JWT_SECRET — pulling in the real
// `createError` would drag in ../middleware/error -> ../lib/logger ->
// ../config/env, which process.exit(1)s outside a fully configured
// environment. We reuse the same AppError shape by hand instead.
import type { AppError } from '../middleware/error';

export interface SelectableEventInput {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  startDate: string;
  endDate: string;
}

export interface SelectableEvent extends SelectableEventInput {
  /** Past the cutoff — shown only behind the picker's "past events" toggle. */
  isPast: boolean;
}

/**
 * The first day an event stops being selectable: end date + 1 month + 1 day.
 *
 * Argo computes this with setMonth(+1) then setDate(+1) on a JS Date, which
 * overflows rather than clamping — Jan 31 becomes Mar 3, not Feb 28. That
 * quirk is reproduced deliberately: if the two apps disagreed about which
 * events are selectable, the same expense could be taggable in one and not
 * the other.
 */
export function selectionCutoff(endDate: string): string {
  const [y, m, d] = endDate.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d));
  cutoff.setUTCMonth(cutoff.getUTCMonth() + 1);
  cutoff.setUTCDate(cutoff.getUTCDate() + 1);
  return cutoff.toISOString().slice(0, 10);
}

/** Selectable events first (soonest start), then past events (most recent end). */
export function orderSelectableEvents(
  events: SelectableEventInput[],
  today: string,
): SelectableEvent[] {
  const marked = events.map((e) => ({ ...e, isPast: today >= selectionCutoff(e.endDate) }));

  return marked.sort((a, b) => {
    if (a.isPast !== b.isPast) return a.isPast ? 1 : -1;
    return a.isPast
      ? b.endDate.localeCompare(a.endDate)
      : a.startDate.localeCompare(b.startDate);
  });
}

/** The five columns an event selection owns. */
export interface EventSourceFields {
  sourceApp: string | null;
  sourceType: string | null;
  sourceLabel: string | null;
  sourceContext: Record<string, unknown>;
}

/**
 * Columns to write when an event is chosen. `sourceLabel` comes from the event
 * row read out of Argo, never from the request — Reports and the Event Review
 * filter both group on it, so a client-supplied name would fragment them.
 * `sourceRefId` stays null: Midas owns this row, Argo did not create it.
 */
export function eventSourceFields(event: { id: string; name: string }): EventSourceFields {
  return {
    sourceApp: 'trade_show',
    sourceType: 'trade_show_event',
    sourceLabel: event.name,
    sourceContext: { eventId: event.id, eventName: event.name },
  };
}

/** Columns to write when the event is removed — back to a daily expense. */
export const CLEARED_EVENT_SOURCE_FIELDS: EventSourceFields = {
  sourceApp: null,
  sourceType: null,
  sourceLabel: null,
  sourceContext: {},
};

/** Looks an event id up; returns null when it does not exist. */
export type EventLookup = (id: string) => Promise<{ id: string; name: string } | null>;

/**
 * Turn a request's `eventId` into columns to write.
 *
 * - `undefined` (key absent)  -> undefined, leave the expense as it is
 * - `null`                    -> clear the event, back to a daily expense
 * - an id                     -> that event's source fields
 * - an unknown id             -> 400, never a silently untagged expense
 */
export async function resolveEventPatch(
  eventId: string | null | undefined,
  lookup: EventLookup,
): Promise<EventSourceFields | undefined> {
  if (eventId === undefined) return undefined;
  if (eventId === null) return CLEARED_EVENT_SOURCE_FIELDS;

  const event = await lookup(eventId);
  if (!event) {
    const err = new Error(`Unknown event: ${eventId}`) as AppError;
    err.statusCode = 400;
    err.code = 'UNKNOWN_EVENT';
    throw err;
  }
  return eventSourceFields(event);
}
