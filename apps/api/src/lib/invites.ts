import crypto from 'crypto';

/** Invitation decision logic — pure except for token generation entropy. */

export const INVITE_TTL_DAYS = 7;

/** Deterministic expiry math (7 days from `now`) — unit-testable. */
export function inviteExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Issue a fresh single-use invite: 32 random hex chars + 7-day expiry. */
export function issueInvite(now: Date): { token: string; expiresAt: Date } {
  return {
    token: crypto.randomBytes(16).toString('hex'),
    expiresAt: inviteExpiry(now),
  };
}

export type InviteState = 'valid' | 'expired' | 'invalid';

/**
 * Validates an invite token against a user record.
 * - 'invalid'  — token mismatch/absent, or the user already set a password
 *                (invites are single-use: accepting one clears the token AND
 *                sets the hash, so a set password always means "consumed").
 * - 'expired'  — token matches but the expiry has passed (or is missing).
 * - 'valid'    — token matches and is still within its window.
 */
export function inviteState(
  user: { inviteToken: string | null; inviteExpiresAt: Date | null; passwordHash: string | null },
  token: string,
  now: Date,
): InviteState {
  if (!token || !user.inviteToken || user.inviteToken !== token) return 'invalid';
  if (user.passwordHash) return 'invalid';
  if (!user.inviteExpiresAt || now.getTime() > user.inviteExpiresAt.getTime()) return 'expired';
  return 'valid';
}
