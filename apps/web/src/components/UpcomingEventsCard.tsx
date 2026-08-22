import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarDays, MapPin } from 'lucide-react';
import { accountantApi, type UpcomingEvent } from '../api/expenses';

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Aug 26 – 29" / "Aug 30 – Sep 2" — year omitted, the window is ±10 days. */
function dateRange(start: string, end: string): string {
  const fmt = (iso: string, withMonth: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return withMonth
      ? dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : String(dt.getDate());
  };
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `${fmt(start, true)} – ${fmt(end, !sameMonth)}`;
}

function PhasePill({ event }: { event: UpcomingEvent }) {
  if (event.phase === 'active') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        Happening now
      </span>
    );
  }
  if (event.phase === 'upcoming') {
    return (
      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
        {event.days === 0 ? 'Starts today' : `In ${event.days} day${event.days !== 1 ? 's' : ''}`}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-ink/5 px-2 py-0.5 text-[11px] font-semibold text-charcoal/60">
      Ended {event.days === 0 ? 'today' : `${event.days} day${event.days !== 1 ? 's' : ''} ago`}
    </span>
  );
}

/**
 * Trade show events within ±10 days, read from the trade show app. Renders
 * nothing when the link is unavailable — a dashboard card that can't load its
 * data is worse than no card.
 */
export function UpcomingEventsCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['upcoming-events'],
    queryFn: () => accountantApi.upcomingEvents(),
    staleTime: 5 * 60_000,
  });

  if (isLoading || !data?.available) return null;

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5 shadow-panel">
      <div className="mb-3 flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-brand-600" />
        <h2 className="text-sm font-semibold text-ink">Upcoming Events</h2>
        <span className="text-xs text-charcoal/40">next 10 days</span>
      </div>

      {data.events.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">No events in the next 10 days.</p>
      ) : (
        <ul className="divide-y divide-ink/5">
          {data.events.map((e) => (
            <li key={e.id}>
              <Link
                to={`/reports?scope=event&show=${encodeURIComponent(e.name)}`}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 transition-colors hover:bg-ink/[0.02]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate font-medium text-ink">{e.name}</p>
                    <PhasePill event={e} />
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-charcoal/50">
                    <span>{dateRange(e.startDate, e.endDate)}</span>
                    {(e.city || e.state) && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {[e.city, e.state].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold tabular-nums text-ink">{usd(e.spend)}</p>
                  <p className="text-[11px] text-charcoal/40">
                    {e.expenseCount} expense{e.expenseCount !== 1 ? 's' : ''}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
