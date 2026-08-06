/** Preset date-range math for the Reports page. All dates local, YYYY-MM-DD. */

export interface DateRange { from: string; to: string }

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function quarterRange(year: number, q: 1 | 2 | 3 | 4): DateRange {
  const startMonth = (q - 1) * 3;
  return { from: fmt(new Date(year, startMonth, 1)), to: fmt(new Date(year, startMonth + 3, 0)) };
}

export function presetRange(preset: string, now: Date = new Date()): DateRange {
  const y = now.getFullYear();
  const q = (Math.floor(now.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  switch (preset) {
    case 'this_month': return { from: fmt(new Date(y, now.getMonth(), 1)), to: fmt(new Date(y, now.getMonth() + 1, 0)) };
    case 'last_month': return { from: fmt(new Date(y, now.getMonth() - 1, 1)), to: fmt(new Date(y, now.getMonth(), 0)) };
    case 'this_quarter': return quarterRange(y, q);
    case 'last_quarter': return q === 1 ? quarterRange(y - 1, 4) : quarterRange(y, (q - 1) as 1 | 2 | 3);
    case 'q1': return quarterRange(y, 1);
    case 'q2': return quarterRange(y, 2);
    case 'q3': return quarterRange(y, 3);
    case 'q4': return quarterRange(y, 4);
    case 'ytd': return { from: fmt(new Date(y, 0, 1)), to: fmt(now) };
    default: return { from: fmt(new Date(y, 0, 1)), to: fmt(now) };
  }
}

export const PRESETS: Array<{ id: string; label: string }> = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'this_quarter', label: 'This quarter' },
  { id: 'last_quarter', label: 'Last quarter' },
  { id: 'q1', label: 'Q1' },
  { id: 'q2', label: 'Q2' },
  { id: 'q3', label: 'Q3' },
  { id: 'q4', label: 'Q4' },
  { id: 'ytd', label: 'YTD' },
];
