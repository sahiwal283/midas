/** Period bucketing for /reports/summary. All date strings are YYYY-MM-DD. */

const DAY_MS = 86_400_000;

function parseUTC(d: string): Date { return new Date(`${d}T00:00:00Z`); }

export function granularityFor(from: string, to: string): 'week' | 'month' {
  const span = (parseUTC(to).getTime() - parseUTC(from).getTime()) / DAY_MS;
  return span <= 62 ? 'week' : 'month';
}

/** ISO week number + ISO week-numbering year (weeks start Monday). */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(d.getTime());
  const day = (t.getUTCDay() + 6) % 7;            // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3);         // nearest Thursday decides the ISO year
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4.getTime() - jan4Day * DAY_MS);
  const week = 1 + Math.round((t.getTime() - 3 * DAY_MS - week1Mon.getTime()) / (7 * DAY_MS));
  return { year: isoYear, week };
}

/** Monday of the ISO week containing d. */
function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - day * DAY_MS);
}

export function periodKey(date: string, g: 'week' | 'month'): string {
  const d = parseUTC(date);
  if (g === 'month') return date.slice(0, 7);
  const { year, week } = isoWeek(d);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function periodLabel(key: string): string {
  const weekMatch = /^(\d{4})-W(\d{2})$/.exec(key);
  if (weekMatch) {
    const [, y, w] = weekMatch;
    const jan4 = new Date(Date.UTC(Number(y), 0, 4));
    const monday = new Date(weekStart(jan4).getTime() + (Number(w) - 1) * 7 * DAY_MS);
    return `Wk of ${MONTHS[monday.getUTCMonth()]} ${monday.getUTCDate()}`;
  }
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function listPeriods(from: string, to: string, g: 'week' | 'month'): string[] {
  const keys: string[] = [];
  if (g === 'month') {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const ey = Number(to.slice(0, 4));
    const em = Number(to.slice(5, 7));
    while (y < ey || (y === ey && m <= em)) {
      keys.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return keys;
  }
  let cursor = weekStart(parseUTC(from));
  const end = weekStart(parseUTC(to));
  while (cursor.getTime() <= end.getTime()) {
    const { year, week } = isoWeek(cursor);
    keys.push(`${year}-W${String(week).padStart(2, '0')}`);
    cursor = new Date(cursor.getTime() + 7 * DAY_MS);
  }
  return keys;
}

export function fillPeriods(
  from: string,
  to: string,
  g: 'week' | 'month',
  rows: Map<string, { spend: number; count: number }>,
): Array<{ period: string; label: string; spend: number; count: number }> {
  return listPeriods(from, to, g).map((period) => ({
    period,
    label: periodLabel(period),
    spend: rows.get(period)?.spend ?? 0,
    count: rows.get(period)?.count ?? 0,
  }));
}
