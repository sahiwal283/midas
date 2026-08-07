import { describe, expect, it } from 'vitest';
import { inviteExpiry, issueInvite, inviteState } from '../lib/invites';

const NOW = new Date('2026-08-07T12:00:00.000Z');

describe('inviteExpiry', () => {
  it('is exactly 7 days after now', () => {
    expect(inviteExpiry(NOW).toISOString()).toBe('2026-08-14T12:00:00.000Z');
  });

  it('is deterministic for the same input', () => {
    expect(inviteExpiry(NOW).getTime()).toBe(inviteExpiry(new Date(NOW)).getTime());
  });
});

describe('issueInvite', () => {
  it('returns a 32-char hex token and the 7-day expiry', () => {
    const { token, expiresAt } = issueInvite(NOW);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(expiresAt.getTime()).toBe(inviteExpiry(NOW).getTime());
  });

  it('generates unique tokens', () => {
    expect(issueInvite(NOW).token).not.toBe(issueInvite(NOW).token);
  });
});

describe('inviteState', () => {
  const base = {
    inviteToken: 'a'.repeat(32),
    inviteExpiresAt: new Date('2026-08-14T12:00:00.000Z'),
    passwordHash: null,
  };

  it('valid when token matches, no password, not expired', () => {
    expect(inviteState(base, base.inviteToken, NOW)).toBe('valid');
  });

  it('valid exactly at the expiry instant', () => {
    expect(inviteState(base, base.inviteToken, base.inviteExpiresAt)).toBe('valid');
  });

  it('expired one ms after the expiry instant', () => {
    const justAfter = new Date(base.inviteExpiresAt.getTime() + 1);
    expect(inviteState(base, base.inviteToken, justAfter)).toBe('expired');
  });

  it('expired when inviteExpiresAt is missing', () => {
    expect(inviteState({ ...base, inviteExpiresAt: null }, base.inviteToken, NOW)).toBe('expired');
  });

  it('invalid on token mismatch', () => {
    expect(inviteState(base, 'b'.repeat(32), NOW)).toBe('invalid');
  });

  it('invalid on empty presented token', () => {
    expect(inviteState(base, '', NOW)).toBe('invalid');
  });

  it('invalid when the user has no stored token', () => {
    expect(inviteState({ ...base, inviteToken: null }, base.inviteToken, NOW)).toBe('invalid');
  });

  it('invalid (single-use) once the user has a password, even if token matches and is unexpired', () => {
    expect(inviteState({ ...base, passwordHash: 'x' }, base.inviteToken, NOW)).toBe('invalid');
  });

  it('invalid wins over expired for a consumed, out-of-date token', () => {
    const late = new Date('2026-09-01T00:00:00.000Z');
    expect(inviteState({ ...base, passwordHash: 'x' }, 'wrong', late)).toBe('invalid');
  });
});
