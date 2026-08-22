// Which trade show events belong on the accountant dashboard, and how each
// one reads. Pure date math — no DB, no framework — so the window rules are
// unit-testable and live in one place.

/** Days either side of today that the dashboard cares about. */
export const EVENT_WINDOW_DAYS = 10;

export type EventPhase = 'upcoming' | 'active' | 'recent';

export interface EventDates {
  /** Show dates — always present. */
  startDate: string;
  endDate: string;
  /** Travel dates — usually a day earlier; null on older rows. */
  travelStartDate?: string | null;
  travelEndDate?: string | null;
}

export interface EventWindowState {
  phase: EventPhase;
  /** Days until it starts (upcoming), or since it ended (recent). 0 when active. */
  days: number;
  /** The dates the window actually used — travel when set, else show. */
  effectiveStart: string;
  effectiveEnd: string;
}

/** Whole days between two YYYY-MM-DD dates (b - a). UTC to dodge DST drift. */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * Classify an event against today. Travel dates drive the window: flights and
 * hotels land on travel day, so an event whose travel started yesterday is
 * already generating expenses even though the show floor opens tomorrow.
 */
export function classifyEventWindow(event: EventDates, today: string): EventWindowState {
  const effectiveStart = event.travelStartDate || event.startDate;
  const effectiveEnd = event.travelEndDate || event.endDate;

  if (today < effectiveStart) {
    return { phase: 'upcoming', days: daysBetween(today, effectiveStart), effectiveStart, effectiveEnd };
  }
  if (today > effectiveEnd) {
    return { phase: 'recent', days: daysBetween(effectiveEnd, today), effectiveStart, effectiveEnd };
  }
  return { phase: 'active', days: 0, effectiveStart, effectiveEnd };
}

/** Is this event inside the dashboard's ±10-day window? */
export function isInEventWindow(
  event: EventDates,
  today: string,
  windowDays: number = EVENT_WINDOW_DAYS,
): boolean {
  const { phase, days } = classifyEventWindow(event, today);
  return phase === 'active' || days <= windowDays;
}

/** Active first, then soonest upcoming, then most recently ended. */
export function compareEventWindow(a: EventWindowState, b: EventWindowState): number {
  const rank: Record<EventPhase, number> = { active: 0, upcoming: 1, recent: 2 };
  if (rank[a.phase] !== rank[b.phase]) return rank[a.phase] - rank[b.phase];
  if (a.phase === 'active') return a.effectiveEnd.localeCompare(b.effectiveEnd);
  return a.days - b.days;
}
