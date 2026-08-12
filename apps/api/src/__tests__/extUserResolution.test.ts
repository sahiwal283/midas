import { describe, it, expect } from 'vitest';
import {
  decideExtUserResolution,
  normalizeProvisionedUsername,
  type ExtUserRecord,
} from '../lib/ext/userResolution';

function user(overrides: Partial<ExtUserRecord>): ExtUserRecord {
  return {
    id: 'id-default',
    username: 'default',
    email: 'default@example.com',
    name: 'Default',
    isActive: true,
    ...overrides,
  };
}

describe('decideExtUserResolution — resolution order', () => {
  it('uses the username match when only username resolves', () => {
    const byUsername = user({ id: 'u1', username: 'sahil' });
    const result = decideExtUserResolution({ byUsername, byEmail: null });
    expect(result).toEqual({ kind: 'existing', user: byUsername });
  });

  it('uses the email match when only email resolves (direct users.email or alias, already folded in)', () => {
    const byEmail = user({ id: 'u2', username: 'seri' });
    const result = decideExtUserResolution({ byUsername: null, byEmail });
    expect(result).toEqual({ kind: 'existing', user: byEmail });
  });

  it('uses the shared user when username and email resolve to the same account', () => {
    const shared = user({ id: 'u3', username: 'Salesguru' });
    const result = decideExtUserResolution({ byUsername: shared, byEmail: shared });
    expect(result).toEqual({ kind: 'existing', user: shared });
  });

  it('falls through to provision when neither username nor email resolves', () => {
    const result = decideExtUserResolution({ byUsername: null, byEmail: null });
    expect(result).toEqual({ kind: 'provision' });
  });
});

describe('decideExtUserResolution — identity collision (Finding 2)', () => {
  it('reports ambiguous when username and email resolve to two DIFFERENT existing users', () => {
    // Trade Show's own "admin" vs. Midas's system admin, mismatched email.
    const byUsername = user({ id: 'midas-admin-id', username: 'admin' });
    const byEmail = user({ id: 'tradeshow-admin-id', username: 'ts_admin' });
    const result = decideExtUserResolution({ byUsername, byEmail });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.usernames).toEqual(['admin', 'ts_admin']);
    }
  });

  it('never silently prefers the username match over a conflicting email match', () => {
    const byUsername = user({ id: 'a', username: 'salesguru' });
    const byEmail = user({ id: 'b', username: 'real.sales.guru' });
    const result = decideExtUserResolution({ byUsername, byEmail });
    expect(result.kind).toBe('ambiguous');
    // Must not resolve to either side's id as if it were a normal match.
    expect(result).not.toEqual({ kind: 'existing', user: byUsername });
    expect(result).not.toEqual({ kind: 'existing', user: byEmail });
  });
});

describe('normalizeProvisionedUsername (Finding 7)', () => {
  it('lowercases and keeps a normal local-part as-is', () => {
    expect(normalizeProvisionedUsername('Jane.Doe')).toBe('jane.doe');
  });

  it('strips characters outside the allowed charset', () => {
    expect(normalizeProvisionedUsername('jane+doe@evil')).toBe('jane-doe-evil');
  });

  it('caps length at 50 characters', () => {
    const huge = 'a'.repeat(500);
    const result = normalizeProvisionedUsername(huge);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('falls back to "user" when nothing safe survives sanitisation', () => {
    expect(normalizeProvisionedUsername('!!!///***')).toBe('user');
  });

  it('trims leading/trailing separators produced by sanitisation', () => {
    expect(normalizeProvisionedUsername('@@jane@@')).toBe('jane');
  });
});
