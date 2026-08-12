/**
 * Pure decision logic for resolveExtUser, split out so it can be unit tested
 * without touching the database (see ../../__tests__/extUserResolution.test.ts).
 *
 * Resolution order once both lookups are done:
 *   1. Both a username match and an email match exist and are the SAME user
 *      -> use it.
 *   2. Both exist and are DIFFERENT users -> ambiguous, caller must disambiguate.
 *   3. Only one of the two resolves -> use it.
 *   4. Neither resolves -> provision (caller decides if auto-provision is on).
 */

export interface ExtUserRecord {
  id: string;
  username: string;
  email: string | null;
  name: string;
  isActive: boolean;
}

export type ExtUserResolution =
  | { kind: 'existing'; user: ExtUserRecord }
  | { kind: 'ambiguous'; usernames: [string, string] }
  | { kind: 'provision' };

/**
 * Decide what to do given the (already-fetched) username match and email
 * match. `byEmail` should already fold in the alias-table fallback — i.e. it
 * is the result of: direct `users.email` match, else `user_email_aliases` ->
 * `users` match.
 */
export function decideExtUserResolution(params: {
  byUsername: ExtUserRecord | null;
  byEmail: ExtUserRecord | null;
}): ExtUserResolution {
  const { byUsername, byEmail } = params;

  if (byUsername && byEmail) {
    if (byUsername.id === byEmail.id) return { kind: 'existing', user: byUsername };
    return { kind: 'ambiguous', usernames: [byUsername.username, byEmail.username] };
  }
  if (byUsername) return { kind: 'existing', user: byUsername };
  if (byEmail) return { kind: 'existing', user: byEmail };
  return { kind: 'provision' };
}

const USERNAME_MAX_LEN = 50;
const USERNAME_DISALLOWED = /[^a-z0-9._-]/g;

/**
 * Sanitise a caller-supplied or email-derived string into something safe to
 * store as `users.username`: same charset/length rule as the admin-facing
 * `usernameSchema` in routes/admin.ts ([a-z0-9._-], max 50), so a hostile or
 * sloppy /ext payload cannot create an absurd or unbounded username.
 */
export function normalizeProvisionedUsername(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(USERNAME_DISALLOWED, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return cleaned.slice(0, USERNAME_MAX_LEN) || 'user';
}
