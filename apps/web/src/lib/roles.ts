import type { UserRole } from '@midas/shared';

/**
 * Developer is an all-access role: it passes every role gate in the app.
 * Mirrors `apps/api/src/lib/roles.ts` — the two must agree, or the UI offers
 * actions the API then refuses (or hides ones it would allow).
 */
export function roleAllowed(role: UserRole | undefined | null, allowed: UserRole[]): boolean {
  if (!role) return false;
  if (role === 'developer') return true;
  return allowed.includes(role);
}
