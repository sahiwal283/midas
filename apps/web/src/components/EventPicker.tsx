import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { expenseApi } from '../api/expenses';

/**
 * Trade-show event selector, mirroring Argo's own picker: selectable events
 * first, older ones behind a "show past events" toggle.
 *
 * Two deliberate differences. It is optional here — Argo's is required because
 * every Argo expense is event spend, while most Midas expenses are daily — and
 * it has no inline "create event" button, because Midas reads Argo's events
 * through a SELECT-only role and must not write to another app's table.
 *
 * Renders nothing when the trade show link is unavailable, so a missing
 * TRADESHOW_DATABASE_URL degrades to "no picker" rather than an empty dropdown.
 */
export function EventPicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (eventId: string) => void;
  className?: string;
}) {
  const [showPast, setShowPast] = useState(false);

  const { data } = useQuery({
    queryKey: ['events'],
    queryFn: () => expenseApi.events(),
    staleTime: 60_000,
  });

  if (!data?.available) return null;

  const current = data.events.filter((e) => !e.isPast);
  const past = data.events.filter((e) => e.isPast);
  // A past event already attached to this expense must stay reachable, or
  // saving the form would silently drop it.
  const selectedIsPast = past.some((e) => e.id === value);

  return (
    <div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
      >
        <option value="">No event — daily expense</option>
        {current.map((e) => (
          <option key={e.id} value={e.id}>{e.name}</option>
        ))}
        {(showPast || selectedIsPast) && past.length > 0 && (
          <optgroup label="── Past events ──">
            {past.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </optgroup>
        )}
      </select>
      {past.length > 0 && !selectedIsPast && (
        <button
          type="button"
          onClick={() => setShowPast(!showPast)}
          className="mt-1 flex items-center gap-1 text-xs text-charcoal/50 hover:text-charcoal/80"
        >
          <Clock className="h-3 w-3" />
          {showPast ? 'Hide past events' : `Show ${past.length} past event${past.length === 1 ? '' : 's'}`}
        </button>
      )}
      <p className="mt-1 text-xs text-charcoal/40">
        Event missing? Create it in the trade show app first.
      </p>
    </div>
  );
}
