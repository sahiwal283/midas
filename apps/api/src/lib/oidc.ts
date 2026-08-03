import { createRemoteJWKSet, jwtVerify } from 'jose';
import crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

export interface OidcClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  groups?: string[];
  [key: string]: unknown;
}

export interface OidcConfig {
  issuerUrl: string;
  discoveryUrl?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  postLogoutRedirectUri: string;
}

// ── Discovery (5-minute cache) ────────────────────────────────────────────────

let discoveryCache: { doc: OidcDiscovery; fetchedAt: number } | null = null;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

export async function loadDiscovery(config: OidcConfig): Promise<OidcDiscovery> {
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.doc;
  }
  const url = config.discoveryUrl ??
    `${config.issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${url}`);
  const doc = await res.json() as OidcDiscovery;
  discoveryCache = { doc, fetchedAt: Date.now() };
  return doc;
}

// ── PKCE + state generators ───────────────────────────────────────────────────

export function generateState(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateNonce(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function deriveCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Authorize URL ─────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(
  config: OidcConfig,
  discovery: OidcDiscovery,
  params: { state: string; nonce: string; codeChallenge: string }
): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${discovery.authorization_endpoint}?${p}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in?: number;
}

export async function exchangeCode(
  config: OidcConfig,
  discovery: OidcDiscovery,
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier,
  });
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<TokenResponse>;
}

// ── ID token validation ───────────────────────────────────────────────────────

// JWKS sets are cached by jwks_uri (jose handles internal key refresh)
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function validateIdToken(
  idToken: string,
  config: OidcConfig,
  discovery: OidcDiscovery,
  nonce: string
): Promise<OidcClaims> {
  // Detect signing algorithm. Authentik defaults to HS256 (HMAC with client secret)
  // when no certificate key pair is configured. RS256/ES256 use JWKS public keys.
  const signingAlgs = discovery.id_token_signing_alg_values_supported ?? ['RS256'];
  const usesHmac = signingAlgs.length > 0 && signingAlgs.every((a) => a.startsWith('HS'));

  let verificationKey: Uint8Array | ReturnType<typeof createRemoteJWKSet>;
  if (usesHmac) {
    // HS256: verification key is the client secret (symmetric shared secret)
    verificationKey = new TextEncoder().encode(config.clientSecret);
  } else {
    let jwks = jwksSets.get(discovery.jwks_uri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
      jwksSets.set(discovery.jwks_uri, jwks);
    }
    verificationKey = jwks;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Validate `iss` against the issuer advertised by the IdP's discovery document
  // (the authoritative, signed-metadata value) rather than a hand-configured env
  // value. Authentik's issuer-mode setting (global root vs. per-application) decides
  // the actual `iss` claim; trusting discovery.issuer makes Midas immune to that
  // drift. (config.issuerUrl is retained only as a discovery-URL fallback.)
  const { payload } = await jwtVerify(idToken, verificationKey as any, {
    issuer: discovery.issuer,
    audience: config.clientId,
  });

  if (payload['nonce'] !== nonce) {
    throw new Error('ID token nonce mismatch');
  }
  return payload as unknown as OidcClaims;
}

// ── In-memory state store (CSRF + PKCE, 10-minute TTL) ───────────────────────

interface StateEntry {
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

const stateMap = new Map<string, StateEntry>();
const STATE_TTL_MS = 10 * 60 * 1000;

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateMap) {
    if (v.expiresAt < now) stateMap.delete(k);
  }
}, 5 * 60 * 1000).unref();

export const oidcStateStore = {
  save(state: string, nonce: string, codeVerifier: string): void {
    stateMap.set(state, { nonce, codeVerifier, expiresAt: Date.now() + STATE_TTL_MS });
  },
  load(state: string): StateEntry | null {
    const entry = stateMap.get(state);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      stateMap.delete(state);
      return null;
    }
    return entry;
  },
  delete(state: string): void {
    stateMap.delete(state);
  },
};
