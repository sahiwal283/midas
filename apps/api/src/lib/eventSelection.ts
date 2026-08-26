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

/** Refusal shape for a request that needs Argo while the link is off. */
export const EVENTS_UNAVAILABLE_REFUSAL = {
  code: 'EVENTS_UNAVAILABLE',
  message: 'Event tagging is unavailable — the trade show link is not configured',
  status: 503,
} as const;

/** The `source_*` columns an event change reads before deciding what to write. */
export interface EventTaggedRow {
  sourceApp: string | null;
  sourceContext: Record<string, unknown> | null;
}

/**
 * Whether this row currently carries an event tag at all.
 *
 * `sourceApp` is the signal, not `sourceContext.eventId`: the four columns are
 * written and cleared together, and a row tagged by an older path might carry
 * the app without the context. Rows owned by another app (`browser_extension`,
 * `milo`, …) have no event, so there is nothing here to clear.
 */
export function hasEventTag(row: EventTaggedRow): boolean {
  return row.sourceApp === 'trade_show';
}

/** The event currently attached to a row, or null when it carries none. */
export function currentEventId(row: EventTaggedRow): string | null {
  if (!hasEventTag(row)) return null;
  // sourceContext is an open Record, so index it through an explicit cast —
  // `unknown` would not compare against a string id.
  return (row.sourceContext?.eventId as string | undefined) ?? null;
}

/**
 * Columns to write to move `row` to event `next` (or to no event), or
 * `undefined` when nothing needs writing.
 *
 * The `undefined` cases matter for more than saved writes. Clearing the event
 * on a row that never had one would null `source_app`, `source_type` and
 * `source_label` and reset `source_context` — destroying the provenance of a
 * row another app created (a browser-extension capture with no page URL has
 * `sourceApp` set and `sourceRefId` null, so it passes the ownership guard).
 * A clear only writes when there is an event to clear.
 */
export function eventChangeFor(
  row: EventTaggedRow,
  next: { id: string; name: string } | null,
): EventSourceFields | undefined {
  if (next === null) return hasEventTag(row) ? CLEARED_EVENT_SOURCE_FIELDS : undefined;
  return currentEventId(row) === next.id ? undefined : eventSourceFields(next);
}

/** Shape of a refusal to change an expense's event. Always 409. */
export interface EventOwnershipRefusal {
  code: 'EVENT_NOT_EDITABLE';
  message: string;
  status: 409;
}

/**
 * Whether an external app owns this row's event, and if so, why editing it
 * here is refused.
 *
 * A non-null `sourceRefId` pairs with `sourceApp` as that app's re-import /
 * dedupe key (enforced by the `(source_app, source_ref_id)` unique index).
 * Writing a new event here from Midas's side would touch that pair without
 * the owning app's knowledge, so any row Midas didn't create itself keeps
 * its event fixed from Midas's perspective — it can only be changed by the
 * app that owns it.
 *
 * Returns null when Midas owns the row (`sourceRefId` is null) and the event
 * is safe to edit here.
 */
export function eventOwnershipRefusal(
  sourceApp: string | null,
  sourceRefId: string | null,
): EventOwnershipRefusal | null {
  if (!sourceRefId) return null;

  let message: string;
  if (sourceApp === 'trade_show') {
    message = 'This expense came from the trade show app — change its event there.';
  } else if (sourceApp === 'browser_extension') {
    message = 'This expense was captured by the browser extension and its event cannot be changed here.';
  } else {
    message = `This expense was created by an external app (${sourceApp ?? 'unknown'}) and its event cannot be changed here.`;
  }

  return { code: 'EVENT_NOT_EDITABLE', message, status: 409 };
}

/** Looks an event id up; returns null when it does not exist. */
export type EventLookup = (id: string) => Promise<{ id: string; name: string } | null>;

/**
 * Turn a request's `eventId` into columns to write, given the row it applies
 * to (`null` on create, where there is no row yet).
 *
 * - `undefined` (key absent)  -> undefined, leave the expense as it is
 * - `null`                    -> clear the event, if the row actually has one
 * - an id                     -> that event's source fields, if it isn't already set
 * - an unknown id             -> 400, never a silently untagged expense
 *
 * `current` is required rather than optional on purpose: every caller has to
 * say what it is patching, so no call site can accidentally clear the source
 * columns of a row that carries another app's provenance.
 */
export async function resolveEventPatch(
  eventId: string | null | undefined,
  lookup: EventLookup,
  current: EventTaggedRow | null,
): Promise<EventSourceFields | undefined> {
  if (eventId === undefined) return undefined;
  const row: EventTaggedRow = current ?? { sourceApp: null, sourceContext: null };
  if (eventId === null) return eventChangeFor(row, null);

  const event = await lookup(eventId);
  if (!event) {
    const err = new Error(`Unknown event: ${eventId}`) as AppError;
    err.statusCode = 400;
    err.code = 'UNKNOWN_EVENT';
    throw err;
  }
  return eventChangeFor(row, event);
}
