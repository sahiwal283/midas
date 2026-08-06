import type { UserRole } from '@midas/shared';

/** Developer is an all-access role: it passes every role gate in the app. */
export function roleAllowed(role: UserRole, allowed: UserRole[]): boolean {
  if (role === 'developer') return true;
  return allowed.includes(role);
}
