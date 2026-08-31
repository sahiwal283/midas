// Read-only view of the trade show app's event calendar, for the accountant
// dashboard's Upcoming Events card.
//
// Raw SQL against the trade show app's Postgres, same reasoning as
// lib/payrollDrawer.ts: that schema is owned by the trade show repo, so a
// duplicated Drizzle schema here would drift. This adapter reads and never
// writes — its DB role has SELECT on `events` and nothing else.
//
// Unset TRADESHOW_DATABASE_URL disables the feature cleanly (the route
// returns an empty list); it never becomes a dashboard error.

import { Pool } from 'pg';
import {
  classifyEventWindow,
  compareEventWindow,
  isInEventWindow,
  type EventPhase,
} from './eventWindow';
import { orderSelectableEvents, type SelectableEvent } from './eventSelection';

let cached: Pool | null = null;

export function isTradeShowLinkEnabled(): boolean {
  return Boolean(process.env.TRADESHOW_DATABASE_URL);
}

function tradeShowPool(): Pool {
  const url = process.env.TRADESHOW_DATABASE_URL;
  if (!url) throw new Error('TRADESHOW_DATABASE_URL is not set');
  // connectionTimeoutMillis is not optional here: this pool now sits on the
  // expense create/update path, so a host that is unreachable-but-not-refusing
  // would otherwise hang the user's submit until TCP gives up, and two such
  // requests would saturate max: 2 for the dashboard card as well.
  cached ??= new Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return cached;
}

export interface WindowedEvent {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  venue: string | null;
  /** Show dates — what the card displays. */
  startDate: string;
  endDate: string;
  /** Travel dates — what the window math used (null when unset). */
  travelStartDate: string | null;
  travelEndDate: string | null;
  phase: EventPhase;
  days: number;
}

/** postgres DATE comes back as a Date; flatten to YYYY-MM-DD. */
function dateStr(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}

/**
 * Events inside the dashboard's ±10-day window, ordered active → soonest
 * upcoming → most recently ended.
 *
 * The SQL pre-filters generously on show dates (±40 days) so the query stays
 * indexed and small; the exact travel-date window is then applied by the
 * tested pure helper rather than duplicated in SQL.
 */
export async function listWindowedEvents(today: string): Promise<WindowedEvent[]> {
  const { rows } = await tradeShowPool().query(
    `SELECT id, name, venue, city, state,
            start_date, end_date, travel_start_date, travel_end_date
     FROM events
     WHERE end_date >= $1::date - 40 AND start_date <= $1::date + 40
     ORDER BY start_date`,
    [today],
  );

  return rows
    .map((r) => {
      const dates = {
        startDate: dateStr(r.start_date)!,
        endDate: dateStr(r.end_date)!,
        travelStartDate: dateStr(r.travel_start_date),
        travelEndDate: dateStr(r.travel_end_date),
      };
      return { row: r, dates, state: classifyEventWindow(dates, today) };
    })
    .filter(({ dates }) => isInEventWindow(dates, today))
    .sort((a, b) => compareEventWindow(a.state, b.state))
    .map(({ row, dates, state }) => ({
      id: row.id,
      name: row.name,
      city: row.city,
      state: row.state,
      venue: row.venue,
      ...dates,
      phase: state.phase,
      days: state.days,
    }));
}

/**
 * Every event Midas will let a user tag an expense with, ordered selectable
 * first. Unlike listWindowedEvents this is not date-windowed in SQL: an
 * accountant reconciling last quarter's spend still needs older shows, and the
 * table is small enough (hundreds of rows) that filtering in TypeScript keeps
 * the cutoff rule in one tested place.
 */
export async function listSelectableEvents(today: string): Promise<SelectableEvent[]> {
  const { rows } = await tradeShowPool().query(
    `SELECT id, name, city, state, start_date, end_date
     FROM events
     ORDER BY start_date DESC`,
  );

  return orderSelectableEvents(
    rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      city: r.city,
      state: r.state,
      startDate: dateStr(r.start_date)!,
      endDate: dateStr(r.end_date)!,
    })),
    today,
  );
}

/** One row of the picker's SELECT — `pg` hands DATE columns back as Date. */
interface EventRow {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  start_date: Date | string;
  end_date: Date | string;
}

/**
 * Postgres invalid_text_representation (22P02).
 *
 * Argo's `events.id` is a uuid column, so comparing it against a string that
 * isn't a uuid is a database error, not an empty result. Midas deliberately
 * does not validate the id's shape — Argo owns its key format — so this is
 * where an unparseable id becomes "no such event".
 */
export function isMalformedIdError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '22P02';
}

/** One event by id, or null. Used to resolve a client's chosen eventId. */
export async function findSelectableEvent(
  id: string,
  today: string,
): Promise<SelectableEvent | null> {
  let rows: EventRow[];
  try {
    ({ rows } = await tradeShowPool().query<EventRow>(
      `SELECT id, name, city, state, start_date, end_date FROM events WHERE id = $1`,
      [id],
    ));
  } catch (err) {
    // A malformed id is an unknown event (400 UNKNOWN_EVENT upstream), never a
    // 500. Every other failure — link down, permissions — still propagates.
    if (isMalformedIdError(err)) return null;
    throw err;
  }
  if (rows.length === 0) return null;
  const r = rows[0];
  return orderSelectableEvents(
    [{
      id: String(r.id),
      name: r.name,
      city: r.city,
      state: r.state,
      startDate: dateStr(r.start_date)!,
      endDate: dateStr(r.end_date)!,
    }],
    today,
  )[0];
}

/**
 * Run dates for an event, for the note Midas writes onto Zoho records.
 *
 * Best-effort by contract: an unset link, an unreachable Argo, a malformed or
 * unknown id all return null so the note falls back to the event name alone.
 * A Zoho push must never fail because a cosmetic lookup did.
 */
export async function tryEventDates(
  eventId: string | null | undefined,
): Promise<{ startDate: string; endDate: string } | null> {
  if (!eventId || !isTradeShowLinkEnabled()) return null;
  try {
    const { rows } = await tradeShowPool().query<EventRow>(
      `SELECT id, name, city, state, start_date, end_date FROM events WHERE id = $1`,
      [eventId],
    );
    const r = rows[0];
    if (!r) return null;
    const startDate = dateStr(r.start_date);
    const endDate = dateStr(r.end_date);
    return startDate && endDate ? { startDate, endDate } : null;
  } catch (err) {
    // console, not lib/logger: that pulls in config/env, which this module
    // must stay free of so it loads in unit tests without a configured env.
    console.warn('[events] date lookup failed for', eventId, '- name only:', err);
    return null;
  }
}
