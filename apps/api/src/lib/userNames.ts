import { inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';

/**
 * Display names for a handful of user ids, in one query.
 *
 * Zoho stores names, not Midas user ids — a note reading "Submitted by:
 * 3658f567" helps nobody. Callers pass the two or three ids they need
 * (submitter, pusher) rather than joining a user relation onto every push.
 */
export async function resolveUserNames(
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** YYYY-MM-DD, the form the rest of the Zoho payload uses for dates. */
export function toDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
