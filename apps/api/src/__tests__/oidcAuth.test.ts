/**
 * Unit tests for OIDC group-to-role mapping, local auth guards, and SSO provisioning logic.
 * These do not require a database or network connection.
 */

import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { validateIdToken, type OidcConfig, type OidcDiscovery } from '../lib/oidc';

// ── Group-to-role mapping (extracted from oidcAuth.ts for testability) ────────

type UserRole = 'admin' | 'accountant' | 'user';

function mapGroupsToRole(
  groups: string[],
  groupAdmin: string[] = ['app-midas-admins', 'midas-admins'],
  groupAccountant: string[] = ['app-midas-accountants', 'midas-accountants'],
  groupUser: string[] = ['app-midas-users', 'midas-users']
): UserRole | null {
  if (groups.some(g => groupAdmin.includes(g))) return 'admin';
  if (groups.some(g => groupAccountant.includes(g))) return 'accountant';
  if (groups.some(g => groupUser.includes(g))) return 'user';
  return null;
}

describe('mapGroupsToRole', () => {
  const ADMIN = 'app-midas-admins';
  const ACCOUNTANT = 'app-midas-accountants';
  const USER = 'app-midas-users';

  it('returns admin for admin group', () => {
    expect(mapGroupsToRole([ADMIN])).toBe('admin');
  });

  it('returns accountant for accountant group', () => {
    expect(mapGroupsToRole([ACCOUNTANT])).toBe('accountant');
  });

  it('returns user for user group', () => {
    expect(mapGroupsToRole([USER])).toBe('user');
  });

  it('returns null when no Midas groups present', () => {
    expect(mapGroupsToRole([])).toBeNull();
    expect(mapGroupsToRole(['other-group', 'coruscant-users'])).toBeNull();
  });

  it('admin takes precedence over accountant when in both', () => {
    expect(mapGroupsToRole([ADMIN, ACCOUNTANT])).toBe('admin');
  });

  it('admin takes precedence over user when in both', () => {
    expect(mapGroupsToRole([ADMIN, USER])).toBe('admin');
  });

  it('accountant takes precedence over user when in both', () => {
    expect(mapGroupsToRole([ACCOUNTANT, USER])).toBe('accountant');
  });

  it('admin takes precedence when all three groups present', () => {
    expect(mapGroupsToRole([ADMIN, ACCOUNTANT, USER])).toBe('admin');
  });

  it('ignores unrelated groups', () => {
    expect(mapGroupsToRole(['authentik Admins', 'luma-users'])).toBeNull();
  });

  it('respects custom group array override', () => {
    const custom = { admin: ['custom-admins'], acct: ['custom-accountants'], user: ['custom-users'] };
    expect(mapGroupsToRole(['custom-admins'], custom.admin, custom.acct, custom.user)).toBe('admin');
    expect(mapGroupsToRole(['custom-accountants'], custom.admin, custom.acct, custom.user)).toBe('accountant');
    expect(mapGroupsToRole(['custom-users'], custom.admin, custom.acct, custom.user)).toBe('user');
    expect(mapGroupsToRole(['midas-admins'], custom.admin, custom.acct, custom.user)).toBeNull();
  });

  it('group matching is case-sensitive', () => {
    expect(mapGroupsToRole(['App-Midas-Admins'])).toBeNull();
    expect(mapGroupsToRole(['APP-MIDAS-ADMINS'])).toBeNull();
  });

  // Legacy naming scheme (midas-* groups)
  it('returns admin for legacy midas-admins group', () => {
    expect(mapGroupsToRole(['midas-admins'])).toBe('admin');
  });

  it('returns accountant for legacy midas-accountants group', () => {
    expect(mapGroupsToRole(['midas-accountants'])).toBe('accountant');
  });

  it('returns user for legacy midas-users group', () => {
    expect(mapGroupsToRole(['midas-users'])).toBe('user');
  });

  // Cross-scheme precedence
  it('admin via suite-standard name wins over accountant via legacy name', () => {
    expect(mapGroupsToRole(['app-midas-admins', 'midas-accountants'])).toBe('admin');
  });

  it('admin via legacy name wins over accountant via suite-standard name', () => {
    expect(mapGroupsToRole(['midas-admins', 'app-midas-accountants'])).toBe('admin');
  });

  it('user in both naming schemes for admin still maps to admin', () => {
    expect(mapGroupsToRole(['app-midas-admins', 'midas-admins'])).toBe('admin');
  });

  it('user in only legacy user group and unrelated groups — still a user', () => {
    expect(mapGroupsToRole(['midas-users', 'authentik Admins', 'coruscant-team'])).toBe('user');
  });
});

// ── Group → role for provisioning scenarios ───────────────────────────────────
// Mirrors the auto-create path: group check runs before resolveLocalUser.

describe('auto-provision group scenarios', () => {
  // Legacy midas-* groups are in the default group lists, so no custom override needed.
  it('midas-admins group yields admin role (would auto-create admin)', () => {
    expect(mapGroupsToRole(['midas-admins'])).toBe('admin');
  });

  it('midas-accountants group yields accountant role (would auto-create accountant)', () => {
    expect(mapGroupsToRole(['midas-accountants'])).toBe('accountant');
  });

  it('midas-users group yields user role (would auto-create user)', () => {
    expect(mapGroupsToRole(['midas-users'])).toBe('user');
  });

  it('app-midas-admins group yields admin role (suite-standard name)', () => {
    expect(mapGroupsToRole(['app-midas-admins'])).toBe('admin');
  });

  it('no approved group → null → auto-create is blocked, no user created', () => {
    expect(mapGroupsToRole([])).toBeNull();
    expect(mapGroupsToRole(['some-other-group'])).toBeNull();
  });

  it('user in both legacy and suite-standard admin groups still yields admin', () => {
    expect(mapGroupsToRole(['midas-admins', 'app-midas-admins'])).toBe('admin');
  });
});

// ── Auto-provision gate ───────────────────────────────────────────────────────
// Mirrors the guard at the top of step 3 in resolveLocalUser.

function shouldAutoProvision(autoCreate: boolean, hasEmail: boolean): boolean {
  return autoCreate && hasEmail;
}

describe('auto-provision gate', () => {
  it('auto-provisions when flag is on and email present', () => {
    expect(shouldAutoProvision(true, true)).toBe(true);
  });

  it('does not auto-provision when flag is off', () => {
    expect(shouldAutoProvision(false, true)).toBe(false);
  });

  it('does not auto-provision when email is missing', () => {
    expect(shouldAutoProvision(true, false)).toBe(false);
  });

  it('does not auto-provision when both false', () => {
    expect(shouldAutoProvision(false, false)).toBe(false);
  });
});

// ── Display name resolution ───────────────────────────────────────────────────
// Mirrors resolveDisplayName exported from oidcAuth.ts.

function resolveDisplayName(claims: {
  name?: string;
  preferred_username?: string;
  email?: string;
}): string {
  const raw = claims.name ?? claims.preferred_username ?? claims.email ?? 'SSO User';
  return String(raw).slice(0, 100);
}

describe('resolveDisplayName', () => {
  it('uses name when present', () => {
    expect(resolveDisplayName({ name: 'Alice Smith', preferred_username: 'alice', email: 'alice@example.com' })).toBe('Alice Smith');
  });

  it('falls back to preferred_username when name is absent', () => {
    expect(resolveDisplayName({ preferred_username: 'alice123', email: 'alice@example.com' })).toBe('alice123');
  });

  it('falls back to email when name and preferred_username are absent', () => {
    expect(resolveDisplayName({ email: 'alice@example.com' })).toBe('alice@example.com');
  });

  it('falls back to SSO User when all are absent', () => {
    expect(resolveDisplayName({})).toBe('SSO User');
  });

  it('truncates long names to 100 characters', () => {
    const long = 'a'.repeat(200);
    expect(resolveDisplayName({ name: long })).toHaveLength(100);
  });

  it('truncates long emails to 100 characters', () => {
    const long = 'a'.repeat(90) + '@example.com';
    expect(resolveDisplayName({ email: long })).toHaveLength(100);
  });
});

// ── Local auth guard logic ────────────────────────────────────────────────────

function localLoginAllowed(authMode: string, allowBreakGlass: boolean): boolean {
  if (authMode === 'local') return true;
  if (authMode === 'authentik' && allowBreakGlass) return true;
  return false;
}

describe('localLoginAllowed', () => {
  it('allows local login when AUTH_MODE=local', () => {
    expect(localLoginAllowed('local', false)).toBe(true);
    expect(localLoginAllowed('local', true)).toBe(true);
  });

  it('blocks local login when AUTH_MODE=authentik and break-glass disabled', () => {
    expect(localLoginAllowed('authentik', false)).toBe(false);
  });

  it('allows local login when AUTH_MODE=authentik and ALLOW_LOCAL_BREAK_GLASS=true', () => {
    expect(localLoginAllowed('authentik', true)).toBe(true);
  });
});

// ── SSO-only user: local login guard ─────────────────────────────────────────
// SSO-auto-created users have passwordHash=null.
// auth.ts guards: if (!user || !user.isActive || !user.passwordHash) → 401.

describe('SSO-only user local login', () => {
  function localLoginGuard(user: { isActive: boolean; passwordHash: string | null } | null): boolean {
    // Returns true if login should proceed, false if it should be denied
    if (!user || !user.isActive || !user.passwordHash) return false;
    return true;
  }

  it('SSO-only user (null passwordHash) is denied local login', () => {
    expect(localLoginGuard({ isActive: true, passwordHash: null })).toBe(false);
  });

  it('inactive SSO-only user is denied', () => {
    expect(localLoginGuard({ isActive: false, passwordHash: null })).toBe(false);
  });

  it('local user with password hash can log in', () => {
    expect(localLoginGuard({ isActive: true, passwordHash: '$2a$12$fakehash' })).toBe(true);
  });

  it('inactive local user is denied even with a password hash', () => {
    expect(localLoginGuard({ isActive: false, passwordHash: '$2a$12$fakehash' })).toBe(false);
  });

  it('SSO user who was given a reset password (non-null hash) can local-login', () => {
    // Admin reset-password sets a hash → local login becomes possible as fallback
    expect(localLoginGuard({ isActive: true, passwordHash: '$2a$12$resettedhash' })).toBe(true);
  });
});

// ── showLocalLogin derived value (mirrors /auth/config response) ──────────────

function showLocalLogin(authMode: string, allowBreakGlass: boolean): boolean {
  return authMode === 'local' || allowBreakGlass;
}

describe('showLocalLogin', () => {
  it('is true when AUTH_MODE=local', () => {
    expect(showLocalLogin('local', false)).toBe(true);
  });

  it('is false when AUTH_MODE=authentik and no break-glass', () => {
    expect(showLocalLogin('authentik', false)).toBe(false);
  });

  it('is true when AUTH_MODE=authentik with break-glass', () => {
    expect(showLocalLogin('authentik', true)).toBe(true);
  });
});

// ── OIDC nonce validation ─────────────────────────────────────────────────────

function checkNonce(stored: string, fromToken: string): boolean {
  return stored === fromToken;
}

describe('nonce validation', () => {
  it('rejects mismatched nonce', () => {
    expect(checkNonce('abc123', 'xyz789')).toBe(false);
  });

  it('accepts matching nonce', () => {
    const nonce = 'abc123';
    expect(checkNonce(nonce, nonce)).toBe(true);
  });
});

// ── State store expiry ────────────────────────────────────────────────────────

describe('OIDC state store TTL', () => {
  it('expired entries return null', () => {
    interface StateEntry { nonce: string; codeVerifier: string; expiresAt: number }
    const store = new Map<string, StateEntry>();
    const STATE_TTL_MS = 10 * 60 * 1000;

    const state = 'test-state';
    store.set(state, {
      nonce: 'n1',
      codeVerifier: 'cv1',
      expiresAt: Date.now() - 1, // already expired
    });

    const entry = store.get(state);
    expect(entry).toBeDefined();
    const isExpired = entry!.expiresAt < Date.now();
    expect(isExpired).toBe(true);

    // Simulate load() behaviour: delete and return null if expired
    if (entry && entry.expiresAt < Date.now()) store.delete(state);
    expect(store.get(state)).toBeUndefined();
    void STATE_TTL_MS; // prevent unused warning
  });

  it('valid entries are returned', () => {
    interface StateEntry { nonce: string; codeVerifier: string; expiresAt: number }
    const store = new Map<string, StateEntry>();

    const state = 'test-state-2';
    store.set(state, {
      nonce: 'n2',
      codeVerifier: 'cv2',
      expiresAt: Date.now() + 60_000,
    });

    const entry = store.get(state);
    expect(entry).toBeDefined();
    expect(entry!.nonce).toBe('n2');
    expect(entry!.expiresAt > Date.now()).toBe(true);
  });
});

// ── ID token issuer validation (regression for "unexpected iss claim value") ──
// Authentik with a global ("root") issuer mode emits iss = https://auth.../ while the
// per-application discovery URL lives at .../application/o/midas/. validateIdToken must
// validate `iss` against the issuer the discovery document advertises — NOT a hand-set
// env value — otherwise token exchange fails with `unexpected "iss" claim value`.

describe('validateIdToken issuer handling', () => {
  const CLIENT_SECRET = 'test-client-secret-value';
  const CLIENT_ID = 'test-client-id';
  const DISCOVERY_ISSUER = 'https://auth.booute.duckdns.org/';
  const NONCE = 'nonce-abc-123';

  const config: OidcConfig = {
    // Deliberately DIFFERENT from the discovery issuer to prove env value is not used.
    issuerUrl: 'https://auth.booute.duckdns.org/application/o/midas/',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: 'https://midas.booute.duckdns.org/api/v1/auth/oidc/callback',
    scopes: ['openid', 'email', 'profile', 'groups'],
    postLogoutRedirectUri: 'https://midas.booute.duckdns.org/login',
  };

  const discovery: OidcDiscovery = {
    issuer: DISCOVERY_ISSUER,
    authorization_endpoint: 'https://auth.booute.duckdns.org/application/o/authorize/',
    token_endpoint: 'https://auth.booute.duckdns.org/application/o/token/',
    jwks_uri: 'https://auth.booute.duckdns.org/application/o/midas/jwks/',
    id_token_signing_alg_values_supported: ['HS256'],
  };

  async function signIdToken(claims: Record<string, unknown>, issuer: string): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(CLIENT_SECRET));
  }

  it('accepts a token whose iss matches the discovery issuer (even when env issuerUrl differs)', async () => {
    const token = await signIdToken({ sub: 'user-1', email: 'a@b.com', nonce: NONCE }, DISCOVERY_ISSUER);
    const claims = await validateIdToken(token, config, discovery, NONCE);
    expect(claims.sub).toBe('user-1');
    expect(claims.iss).toBe(DISCOVERY_ISSUER);
  });

  it('rejects a token whose iss does not match the discovery issuer', async () => {
    const token = await signIdToken({ sub: 'user-1', email: 'a@b.com', nonce: NONCE }, 'https://evil.example/');
    await expect(validateIdToken(token, config, discovery, NONCE)).rejects.toThrow();
  });

  it('rejects a token with a mismatched nonce', async () => {
    const token = await signIdToken({ sub: 'user-1', email: 'a@b.com', nonce: 'wrong-nonce' }, DISCOVERY_ISSUER);
    await expect(validateIdToken(token, config, discovery, NONCE)).rejects.toThrow(/nonce/i);
  });
});

// ── HS256 detection ───────────────────────────────────────────────────────────

describe('HS256 detection', () => {
  it('detects HS256-only providers', () => {
    const signingAlgs = ['HS256'];
    expect(signingAlgs.every((a) => a.startsWith('HS'))).toBe(true);
  });

  it('detects RS256 providers (uses JWKS)', () => {
    const signingAlgs = ['RS256'];
    expect(signingAlgs.every((a) => a.startsWith('HS'))).toBe(false);
  });

  it('detects mixed alg list as non-HMAC-only', () => {
    const signingAlgs = ['RS256', 'HS256'];
    expect(signingAlgs.every((a) => a.startsWith('HS'))).toBe(false);
  });

  it('defaults to non-HMAC when alg list missing (conservative)', () => {
    const signingAlgs: string[] = [];
    // empty list → default to RS256 path (JWKS), not HS
    const usesHmac = signingAlgs.length > 0 && signingAlgs.every((a) => a.startsWith('HS'));
    expect(usesHmac).toBe(false);
  });
});
