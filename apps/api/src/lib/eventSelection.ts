// Which Argo events belong in Midas's event picker, and in what order.
//
// Pure date maths — no DB, no framework — so the cutoff rule can be tested
// against Argo's without a database. The rule itself is ported from Argo's
// filterActiveEvents (trade-show-app/src/utils/eventUtils.ts): an event stays
// selectable until one month and one day past its end date.

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
