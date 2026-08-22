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

let cached: Pool | null = null;

export function isTradeShowLinkEnabled(): boolean {
  return Boolean(process.env.TRADESHOW_DATABASE_URL);
}

function tradeShowPool(): Pool {
  const url = process.env.TRADESHOW_DATABASE_URL;
  if (!url) throw new Error('TRADESHOW_DATABASE_URL is not set');
  cached ??= new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30_000 });
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
