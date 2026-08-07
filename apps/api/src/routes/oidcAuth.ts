import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index';
import { users, ssoLinks } from '../db/schema';
import { env } from '../config/env';
import { asyncHandler } from '../middleware/error';
import { auditLog } from '../lib/audit';
import {
  loadDiscovery,
  buildAuthorizeUrl,
  exchangeCode,
  validateIdToken,
  generateState,
  generateNonce,
  generateCodeVerifier,
  deriveCodeChallenge,
  oidcStateStore,
  type OidcConfig,
  type OidcClaims,
} from '../lib/oidc';
import type { UserRole } from '@midas/shared';

const router = Router();

// ── GET /api/v1/auth/config ───────────────────────────────────────────────────
// Public — tells the frontend which login UI to render.

router.get('/config', (_req, res) => {
  res.json({
    authMode: env.AUTH_MODE,
    showLocalLogin: env.AUTH_MODE === 'local' || env.ALLOW_LOCAL_BREAK_GLASS,
  });
});

// ── GET /api/v1/auth/oidc/login ───────────────────────────────────────────────

router.get('/oidc/login', asyncHandler(async (_req, res) => {
  if (env.AUTH_MODE !== 'authentik') {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'OIDC not enabled' } });
    return;
  }

  const config = buildOidcConfig();
  const discovery = await loadDiscovery(config);
  const state = generateState();
  const nonce = generateNonce();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = deriveCodeChallenge(codeVerifier);

  oidcStateStore.save(state, nonce, codeVerifier);

  const url = buildAuthorizeUrl(config, discovery, { state, nonce, codeChallenge });
  console.log('[oidc:login-start]', {
    discoveryUrl: config.discoveryUrl,
    tokenEndpoint: discovery.token_endpoint,
    redirectUri: config.redirectUri,
    clientIdPrefix: config.clientId.slice(0, 8),
    scopes: config.scopes,
  });
  res.redirect(url);
}));

// ── GET /api/v1/auth/oidc/callback ────────────────────────────────────────────

router.get('/oidc/callback', asyncHandler(async (req, res) => {
  if (env.AUTH_MODE !== 'authentik') {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'OIDC not enabled' } });
    return;
  }

  const webBase = env.CORS_ORIGIN;
  const { code, state, error: oidcError } = req.query as Record<string, string | undefined>;

  console.log('[oidc:callback-received]', { hasCode: Boolean(code), hasState: Boolean(state), oidcError: oidcError ?? null });

  if (oidcError) {
    res.redirect(`${webBase}/login?oidc_error=${encodeURIComponent(oidcError)}`);
    return;
  }

  if (!code || !state) {
    console.error('[oidc:callback] missing_params');
    res.redirect(`${webBase}/login?oidc_error=missing_params`);
    return;
  }

  // Validate CSRF state
  const stored = oidcStateStore.load(state);
  if (!stored) {
    console.error('[oidc:callback] invalid_state — state not found (possible API restart or replay)');
    res.redirect(`${webBase}/login?oidc_error=invalid_state`);
    return;
  }
  oidcStateStore.delete(state);
  console.log('[oidc:state-valid]');

  // Exchange code → validate ID token
  const config = buildOidcConfig();
  let claims: OidcClaims;
  try {
    const discovery = await loadDiscovery(config);
    const tokens = await exchangeCode(config, discovery, code, stored.codeVerifier);
    if (!tokens.id_token) throw new Error('No id_token in response');
    claims = await validateIdToken(tokens.id_token, config, discovery, stored.nonce);
    console.log('[oidc:token-exchange-ok]', { sub: claims.sub, hasEmail: Boolean(claims.email), issuer: claims.iss });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const requestIdMatch = msg.match(/"request_id"\s*:\s*"([a-f0-9]+)"/);
    const requestId = requestIdMatch?.[1];
    console.error('[oidc:token-exchange-error]', {
      detail: msg.replace(/client_secret=[^&"'\s]+/g, '[REDACTED]'),
      requestId,
    });
    const params = new URLSearchParams({ oidc_error: 'token_error' });
    if (requestId) params.set('oidc_request_id', requestId);
    res.redirect(`${webBase}/login?${params}`);
    return;
  }

  // Map Authentik groups → Midas role (gate: must be in at least one approved group)
  const groups = (claims.groups ?? []) as string[];
  const role = mapGroupsToRole(groups);
  console.log('[oidc:groups-found]', { groups, role });
  if (!role) {
    console.error('[oidc:callback] denied_no_group — groups:', groups);
    await auditLog({
      entityType: 'sso',
      entityId: claims.sub,
      action: 'sso.login_denied_no_group',
      metadata: { provider: 'authentik', sub: claims.sub, emailDomain: claims.email?.split('@')[1] ?? null, groups },
    });
    res.redirect(`${webBase}/login?oidc_error=denied_no_group`);
    return;
  }

  // Resolve local user: SSO link → email match → auto-create → deny
  const resolved = await resolveLocalUser(claims, role, env.AUTHENTIK_AUTO_CREATE_USERS);

  if (!resolved) {
    console.error('[oidc:callback] denied_no_match — sub:', claims.sub, '| emailDomain:', claims.email?.split('@')[1] ?? 'no-email');
    res.redirect(`${webBase}/login?oidc_error=denied_no_match`);
    return;
  }

  const { user, wasCreated, wasLinkedByEmail } = resolved;

  // Audit creation/link events
  if (wasCreated) {
    await auditLog({
      entityType: 'user',
      entityId: user.id,
      action: 'sso.user_auto_created',
      after: { email: user.email, name: user.name, role: user.role },
      metadata: { provider: 'authentik', sub: claims.sub },
    });
    console.log('[oidc:user-auto-created]', { userId: user.id, email: user.email, role: user.role });
  } else if (wasLinkedByEmail) {
    await auditLog({
      entityType: 'user',
      entityId: user.id,
      action: 'sso.user_linked_by_email',
      metadata: { provider: 'authentik', sub: claims.sub, email: user.email },
    });
    console.log('[oidc:user-linked-by-email]', { userId: user.id, email: user.email });
  } else {
    console.log('[oidc:user-linked]', { userId: user.id, role: user.role, mappedRole: role });
  }

  if (!user.isActive) {
    console.error('[oidc:callback] denied_inactive — userId:', user.id);
    await auditLog({
      entityType: 'user',
      entityId: user.id,
      action: 'sso.login_denied_inactive_user',
      metadata: { provider: 'authentik', sub: claims.sub },
    });
    res.redirect(`${webBase}/login?oidc_error=denied_inactive`);
    return;
  }

  // Midas owns roles. Authentik groups only gate app access (the denied_no_group
  // check above) and set the initial role for auto-created users. Do NOT sync the
  // role on login — admins assign roles in Midas (Admin → Users) and an SSO login
  // must never overwrite that.

  // Touch lastSeenAt on returning SSO users (not on first-login — link was just created)
  if (!wasCreated && !wasLinkedByEmail) {
    await db.update(ssoLinks)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(ssoLinks.provider, 'authentik'), eq(ssoLinks.subject, claims.sub)));
  }

  // Every successful OIDC callback counts as a login.
  await db.update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  // Audit successful login
  await auditLog({
    entityType: 'user',
    entityId: user.id,
    action: 'sso.login_success',
    metadata: { provider: 'authentik', sub: claims.sub, role: user.role, mappedGroupRole: role, wasCreated, wasLinkedByEmail },
  });

  // Issue same JWT shape as local login
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    maxAge: 8 * 60 * 60 * 1000,
  });

  console.log('[oidc:session-created]', { userId: user.id, role: user.role, redirectTo: `${webBase}/dashboard` });
  res.redirect(`${webBase}/dashboard`);
}));

// ── POST /api/v1/auth/oidc/logout ─────────────────────────────────────────────
// Clears the session cookie and returns the Authentik end_session URL when available.
// The frontend should redirect the browser to logoutUrl if present.

router.post('/oidc/logout', asyncHandler(async (_req, res) => {
  res.clearCookie('token');

  if (env.AUTH_MODE === 'authentik') {
    try {
      const discovery = await loadDiscovery(buildOidcConfig());
      if (discovery.end_session_endpoint) {
        const params = new URLSearchParams({
          post_logout_redirect_uri: env.AUTHENTIK_POST_LOGOUT_REDIRECT_URI ?? env.CORS_ORIGIN,
        });
        res.json({ ok: true, logoutUrl: `${discovery.end_session_endpoint}?${params}` });
        return;
      }
    } catch { /* non-fatal if discovery unavailable at logout */ }
  }

  res.json({ ok: true });
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildOidcConfig(): OidcConfig {
  return {
    issuerUrl: env.AUTHENTIK_ISSUER_URL!,
    discoveryUrl: env.AUTHENTIK_DISCOVERY_URL,
    clientId: env.AUTHENTIK_CLIENT_ID!,
    clientSecret: env.AUTHENTIK_CLIENT_SECRET!,
    redirectUri: env.AUTHENTIK_REDIRECT_URI!,
    postLogoutRedirectUri: env.AUTHENTIK_POST_LOGOUT_REDIRECT_URI ?? env.CORS_ORIGIN,
    scopes: env.AUTHENTIK_SCOPES,
  };
}

function mapGroupsToRole(groups: string[]): UserRole | null {
  if (groups.some(g => env.AUTHENTIK_GROUP_ADMIN.includes(g))) return 'admin';
  if (groups.some(g => env.AUTHENTIK_GROUP_ACCOUNTANT.includes(g))) return 'accountant';
  if (groups.some(g => env.AUTHENTIK_GROUP_USER.includes(g))) return 'user';
  return null;
}

// Exported for unit testing — derives display name from OIDC claims.
export function resolveDisplayName(claims: Pick<OidcClaims, 'name' | 'preferred_username' | 'email'>): string {
  const raw = claims.name ?? claims.preferred_username ?? claims.email ?? 'SSO User';
  return String(raw).slice(0, 100);
}

interface ResolvedUser {
  user: typeof users.$inferSelect;
  wasCreated: boolean;
  wasLinkedByEmail: boolean;
}

async function resolveLocalUser(
  claims: OidcClaims,
  role: UserRole,
  autoCreate: boolean,
): Promise<ResolvedUser | null> {
  // Step 1: existing SSO link → fast path for returning users
  const link = await db.query.ssoLinks.findFirst({
    where: and(eq(ssoLinks.provider, 'authentik'), eq(ssoLinks.subject, claims.sub)),
  });
  if (link) {
    const user = await db.query.users.findFirst({ where: eq(users.id, link.userId) });
    return user ? { user, wasCreated: false, wasLinkedByEmail: false } : null;
  }

  // Step 2: email match → auto-link to existing Midas user
  if (claims.email) {
    const matched = await db.query.users.findFirst({ where: eq(users.email, claims.email) });
    if (matched) {
      await db.insert(ssoLinks).values({
        provider: 'authentik',
        subject: claims.sub,
        userId: matched.id,
        metadata: { linkedBy: 'email', email: claims.email },
      });
      return { user: matched, wasCreated: false, wasLinkedByEmail: true };
    }
  }

  // Step 3: auto-create if enabled (only reachable when user is in an approved group)
  if (!autoCreate || !claims.email) return null;

  const name = resolveDisplayName(claims);
  const [newUser] = await db.insert(users)
    .values({ email: claims.email, name, role, passwordHash: null, isActive: true })
    .returning();

  await db.insert(ssoLinks).values({
    provider: 'authentik',
    subject: claims.sub,
    userId: newUser.id,
    metadata: { linkedBy: 'auto_provision', email: claims.email },
  });

  return { user: newUser, wasCreated: true, wasLinkedByEmail: false };
}

export default router;
