import { describe, expect, it } from 'vitest';
import { shouldRefreshSession, REFRESH_AFTER_MS, SESSION_TTL_MS } from '../lib/sessionPolicy';

describe('shouldRefreshSession', () => {
  const now = 1_800_000_000_000;

  it('refreshes tokens older than the refresh window', () => {
    const iat = (now - REFRESH_AFTER_MS - 1000) / 1000;
    expect(shouldRefreshSession(iat, now)).toBe(true);
  });

  it('leaves fresh tokens alone', () => {
    const iat = (now - 60_000) / 1000;
    expect(shouldRefreshSession(iat, now)).toBe(false);
  });

  it('no iat → no refresh', () => {
    expect(shouldRefreshSession(undefined, now)).toBe(false);
  });

  it('session TTL is 30 days, refresh window 1 day', () => {
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(REFRESH_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});
