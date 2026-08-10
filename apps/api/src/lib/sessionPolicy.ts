/**
 * Sliding sessions: 30 days from last use. Any authenticated request on a
 * token older than REFRESH_AFTER_MS re-issues a fresh 30-day cookie, so
 * active users (web and extension) stay signed in indefinitely; only 30 full
 * days of inactivity logs someone out. Pure module — no env imports.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** Refresh when the token was issued more than REFRESH_AFTER_MS ago. */
export function shouldRefreshSession(iatSeconds: number | undefined, nowMs: number): boolean {
  if (!iatSeconds) return false;
  return nowMs - iatSeconds * 1000 > REFRESH_AFTER_MS;
}
