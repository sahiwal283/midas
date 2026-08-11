# Midas ↔ Authentik OIDC Integration

## Status (2026-06-24)

**`AUTH_MODE=authentik` is active on CT 3120** with `ALLOW_LOCAL_BREAK_GLASS=true` and `AUTHENTIK_AUTO_CREATE_USERS=true`. The Midas application and all required groups exist in Authentik. Local bcrypt login remains available as a break-glass path.

**Production entry point is now the HTTPS domain `https://midas.booute.duckdns.org`** (fronted by the NPM reverse proxy), **not** the old LAN URL `http://192.168.1.210:5173`. Because `COOKIE_SECURE=true` and `CORS_ORIGIN=https://midas.booute.duckdns.org`, SSO only works over the HTTPS domain — logging in via the plain-HTTP LAN IP will fail to set the session cookie. Use the domain.

> **2026-06-24 — SSO fix (v0.1.3-alpha).** All Authentik logins were failing at token exchange with `unexpected "iss" claim value`. Root cause: during the migration to the `midas.booute.duckdns.org` HTTPS domain, the running `.env` `AUTHENTIK_ISSUER_URL` had drifted to the per-application URL (`…/application/o/midas/`), but the Authentik provider issues ID tokens with the **root** issuer `https://auth.booute.duckdns.org/` (global issuer mode — this is what its discovery document advertises). Fix: `validateIdToken` now validates `iss` against `discovery.issuer` (the IdP's authoritative signed-metadata issuer) rather than the env value, so Midas is immune to issuer-mode drift. `AUTHENTIK_ISSUER_URL` is now only a discovery-URL fallback. See Troubleshooting below.

---

## Authentik instance

| Item | Value |
|---|---|
| Host | CT 111 (authentik), 192.168.1.164 |
| LAN HTTP | 192.168.1.164:9000 (direct LAN access) |
| External HTTPS | `https://auth.booute.duckdns.org/` (active — CT 3120 uses this) |
| Version | 2026.2.2 |
| Issuer | `https://auth.booute.duckdns.org/` |
| Per-app discovery URL | `https://auth.booute.duckdns.org/application/o/midas/.well-known/openid-configuration` |
| Admin UI | `http://192.168.1.164:9000/` (LAN) or `https://auth.booute.duckdns.org/` (external) |

CT 3120 (midas-app-prod) reaches Authentik via the external HTTPS URL. Hairpin NAT or split-horizon DNS allows this to work from inside the LAN.

---

## How it works

- **`AUTH_MODE=local`**: bcrypt login only. OIDC routes return 404. Safe default for new environments.
- **`AUTH_MODE=authentik`**: Authentik OIDC is required. Local login is blocked unless `ALLOW_LOCAL_BREAK_GLASS=true`. SSO button is the primary visual action; local login is collapsed under "Break-glass local login".

### OIDC flow

```
User → /api/v1/auth/oidc/login → Authentik authorize (PKCE S256) → Authentik login
     → callback to http://192.168.1.210:4000/api/v1/auth/oidc/callback
     ← API validates token, maps groups → role, sets JWT cookie
     → redirect to http://192.168.1.210:5173/dashboard
```

The callback hits the API (port 4000) directly — not through the Vite proxy. After setting the httpOnly JWT cookie the API redirects to `CORS_ORIGIN/dashboard`. The cookie is valid for all ports on the same host (`192.168.1.210`), so subsequent API calls through the Vite proxy at port 5173 correctly include it.

### Token signing — HS256

The Midas Authentik provider is configured with `signing_key_id=NULL`, which means Authentik signs ID tokens using HMAC-SHA256 with the client secret as the key. The Midas `oidc.ts` detects this from the discovery document (`id_token_signing_alg_values_supported: ["HS256"]`) and uses the client secret as the verification key instead of fetching JWKS.

**Long-term recommendation:** In the Authentik admin UI, assign a certificate keypair to the Midas provider. This switches signing to RS256 (public-key based), allows proper JWKS verification, and eliminates the need to trust the client secret for token integrity. The Midas code handles both HS256 and RS256 automatically.

### Group-to-role mapping

| Authentik group | Midas role |
|---|---|
| `midas-admins`, `app-midas-admins`, `IT` | admin |
| `midas-accountants`, `app-midas-accountants` | accountant |
| `midas-users`, `app-midas-users`, `Employees` | user |

Highest-privilege wins when a user is in multiple groups. No matching group → login denied (`denied_no_group`).

Groups gate **access**, not role. The mapped role is applied only when auto-creating a new
user; on every later login the user's existing Midas role is left alone (see the comment in
`routes/oidcAuth.ts` — "Midas owns roles"). Change a role in Settings → Users, not in Authentik.

### User provisioning on first SSO login

Midas is SSO-first. Users in approved Authentik groups are auto-provisioned on first sign-in (controlled by `AUTHENTIK_AUTO_CREATE_USERS`).

Resolution order:

1. **SSO link** — look up `sso_links` by `(provider=authentik, subject=sub)`. Fast path for returning users. Audit: `sso.login_success`.
2. **Email match** — if no SSO link, find an existing Midas user with the same email and auto-link. Audit: `sso.user_linked_by_email`.
3. **Auto-create** (`AUTHENTIK_AUTO_CREATE_USERS=true`) — if no link and no email match, create a new Midas user with `passwordHash=null` (SSO-only). Role comes from Authentik groups. Audit: `sso.user_auto_created`.
4. **Deny** — if `AUTHENTIK_AUTO_CREATE_USERS=false` and no match: `denied_no_match`. Admin must pre-provision via Admin → Users.

Auto-create is **gated by group membership**: only users in a group listed in `AUTHENTIK_GROUP_ADMIN` / `_ACCOUNTANT` / `_USER` (currently including `IT` and `Employees`) are auto-provisioned. A user with an Authentik account but no approved Midas group is always denied (`denied_no_group`).

**SSO-only users** (`passwordHash=null`) cannot use local login. The local login route returns 401 for accounts without a password hash. An admin can set a local fallback password via Admin → Users → Reset Password if needed.

---

## Current Midas provider in Authentik

| Field | Value |
|---|---|
| Application slug | `midas` |
| Provider type | OAuth2/OIDC, confidential client |
| Client ID | `347nbznJmVPx7V60PNevuwtkanwVdyS7tBBd7640` |
| Client Secret | stored in `/opt/midas/.env` on CT 3120 (rotated 2026-05-21) |
| Redirect URI | `http://192.168.1.210:4000/api/v1/auth/oidc/callback` |
| Launch URL | `https://midas.booute.duckdns.org/api/v1/auth/oidc/login` |
| Post-logout redirect | `https://midas.booute.duckdns.org/login` |
| Scopes | openid, email, profile, groups |
| Groups claim | "Coruscant groups claim" property mapping — expression: `return [g.name for g in request.user.ak_groups.all()]` |
| Signing | HS256 (client secret) — no certificate keypair assigned |
| PKCE | S256 supported |

---

> **Launch URL must be the OIDC start endpoint, not the app root** (fixed 2026-08-11).
> It was `https://midas.booute.duckdns.org`, so clicking the Midas tile in Authentik
> opened the Midas login page and required a manual "Sign in with SSO" click even
> though the user was already signed in to Authentik. Pointing it at
> `/api/v1/auth/oidc/login` starts the OIDC flow immediately, so an authenticated
> user lands straight in Midas. This matches the working pattern used by the
> Zoho Integration Admin app (`…/admin/auth/oidc/start`).

## Current Midas groups in Authentik

| Group | Maps to role |
|---|---|
| `midas-admins`, `app-midas-admins`, `IT` | admin |
| `midas-accountants`, `app-midas-accountants` | accountant |
| `midas-users`, `app-midas-users`, `Employees` | user |

To assign a user to a group: Authentik admin UI → Directory → Groups → select group → Members tab.

**Two independent gates.** Binding the *application* to a group in Authentik controls
who sees/launches Midas from the Authentik portal. It does **not** grant Midas access:
Midas separately requires one of the group **names above** to appear in the token's
`groups` claim. A user can have the app assigned and still hit `denied_no_group`.

`IT` and `Employees` were added 2026-08-11 so the org-wide groups work without creating
per-app `midas-*` groups. Matching is exact and **case-sensitive** — `employee` and
`employees` both fail against the real group name, which is `Employees`.

Group membership only sets the *initial* role for auto-created users. Existing users keep
whatever role they have in Midas (Settings → Users); an SSO login never overwrites it.

---

## Environment variables (CT 3120 `/opt/midas/.env`)

```bash
AUTH_MODE=authentik
ALLOW_LOCAL_BREAK_GLASS=true

AUTHENTIK_ISSUER_URL=https://auth.booute.duckdns.org/
AUTHENTIK_DISCOVERY_URL=https://auth.booute.duckdns.org/application/o/midas/.well-known/openid-configuration
AUTHENTIK_CLIENT_ID=347nbznJmVPx7V60PNevuwtkanwVdyS7tBBd7640
AUTHENTIK_CLIENT_SECRET=<in /opt/midas/.env — do not commit>
AUTHENTIK_REDIRECT_URI=http://192.168.1.210:4000/api/v1/auth/oidc/callback
AUTHENTIK_POST_LOGOUT_REDIRECT_URI=http://192.168.1.210:5173/login
AUTHENTIK_SCOPES=openid email profile groups

# Group name → role mapping (must match Authentik group names exactly, case-sensitive)
AUTHENTIK_GROUP_ADMIN=app-midas-admins,midas-admins,IT
AUTHENTIK_GROUP_ACCOUNTANT=app-midas-accountants,midas-accountants
AUTHENTIK_GROUP_USER=app-midas-users,midas-users,Employees
```

> **Changing these requires recreating the container, not restarting it.** Compose injects
> `.env` via `env_file:` at container *create* time, so `docker compose restart api` keeps
> the old values (verified 2026-08-11 — `printenv` still showed the previous list). Use:
>
> ```bash
> ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d --force-recreate --no-deps api'"
> ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 printenv AUTHENTIK_GROUP_ADMIN"   # confirm
> ```

---

## Verification

```bash
# Auth config
curl -s http://192.168.1.210:4000/api/v1/auth/config
# {"authMode":"authentik","showLocalLogin":true}

# OIDC redirect (tests discovery + authorize URL construction)
curl -sI http://192.168.1.210:4000/api/v1/auth/oidc/login
# HTTP 302, Location: https://auth.booute.duckdns.org/application/o/authorize/?...
# (scope includes groups, code_challenge_method=S256)

# Authentik discovery (from any host with HTTPS access)
curl -s https://auth.booute.duckdns.org/application/o/midas/.well-known/openid-configuration \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("issuer:", d["issuer"]); print("algs:", d.get("id_token_signing_alg_values_supported"))'
# issuer: https://auth.booute.duckdns.org/
# algs: ['HS256']
```

For a full E2E SSO test, open `http://192.168.1.210:5173/login` in a browser and click "Sign in with Authentik". Log in with an Authentik account that is in one of the three Midas groups. You should land on `/dashboard` with the correct role.

---

## Enable / disable / rollback

```bash
# Enable Authentik SSO
ssh root@192.168.1.190 "pct exec 3120 -- sed -i 's/^AUTH_MODE=.*/AUTH_MODE=authentik/' /opt/midas/.env"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'"

# Disable (revert to local-only)
ssh root@192.168.1.190 "pct exec 3120 -- sed -i 's/^AUTH_MODE=.*/AUTH_MODE=local/' /opt/midas/.env"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'"

# Verify after change
ssh root@192.168.1.190 "pct exec 3120 -- curl -s http://localhost:4000/api/v1/auth/config"
```

---

## Token endpoint authentication

Midas uses `client_secret_post` (client_id and client_secret in the POST body). Authentik supports both `client_secret_post` and `client_secret_basic` for this provider. The client_secret in `/opt/midas/.env` must exactly match the value in Authentik's provider settings. Mismatches cause HTTP 400 `invalid_client`. To get the correct value: Authentik admin UI → Providers → Midas → Edit → copy client secret.

**Important**: If you regenerate the Authentik client secret, update `AUTHENTIK_CLIENT_SECRET` in `/opt/midas/.env` and recreate the API container (`docker compose up -d api`).

---

## Known limitations

- **In-memory state store**: OIDC PKCE state (nonce, code verifier) is held in-memory with a 10-minute TTL. Restarting the API container invalidates all in-flight OIDC sessions. This is correct for a single-instance deployment. Do not run multiple API replicas without a shared state store (Redis or DB-backed).

- **HS256 signing**: Less secure than RS256 because token verification requires the client secret. If the secret is compromised, tokens can be forged. Mitigation: assign a certificate keypair in the Authentik admin UI to switch to RS256.

- **Backchannel logout**: The Authentik provider is configured for backchannel logout, but Midas does not implement a backchannel logout endpoint. Logout from Authentik will not invalidate existing Midas JWT cookies (8-hour TTL). For a complete logout, both Midas and Authentik sessions must be cleared.

- **No Coruscant dependency**: The Midas OIDC integration is implemented natively using `jose`. It does not depend on Coruscant or the `shared-auth-node` package.

---

## Troubleshooting

### `[oidc:token-exchange-error] unexpected "iss" claim value`

The browser completes Authentik login, the callback is reached, state is valid, but the API logs this at token exchange and the user is bounced back to `/login?oidc_error=token_error`.

**Cause:** the `iss` claim in the ID token does not match the issuer Midas validates against. Authentik's *issuer mode* decides the `iss` value:
- **Global/root** issuer mode → `iss = https://auth.booute.duckdns.org/`
- **Per-application** issuer mode → `iss = https://auth.booute.duckdns.org/application/o/midas/`

As of v0.1.3-alpha, Midas validates `iss` against `discovery.issuer` (whatever the provider's discovery document advertises), so it adapts to either mode automatically. Confirm the live issuer with:

```bash
curl -s https://auth.booute.duckdns.org/application/o/midas/.well-known/openid-configuration | grep -o '"issuer":"[^"]*"'
```

If you are on an older build that validated against the env value, set `AUTHENTIK_ISSUER_URL` in `/opt/midas/.env` to **exactly** the `issuer` value above (trailing slash included) and `docker compose up -d api`.

### SSO works on the domain but not on the LAN IP

Expected. `COOKIE_SECURE=true` means the session cookie is only set over HTTPS, and `CORS_ORIGIN` is the HTTPS domain. Always access Midas at `https://midas.booute.duckdns.org`, not `http://192.168.1.210:5173`.

### Break-glass recovery (local admin)

If SSO is down and you need in, log in as `admin@midas.local` (local bcrypt, always allowed while `ALLOW_LOCAL_BREAK_GLASS=true`). If the password is unknown, reset it with the safe one-shot script:

```bash
pct exec 3120 -- bash -lc 'cd /opt/midas && PW="<choose-strong>"; docker exec -e ADMIN_PASSWORD="$PW" midas-api-1 npx tsx src/scripts/reset-admin-pw.ts'
```

This sets the hash and re-activates the account; it does not touch SSO users. Rotate the password again after recovery.

### Full rollback to local-only auth

Set `AUTH_MODE=local` in `/opt/midas/.env`, then `docker compose up -d api`. The SSO button disappears and local login is the only path. No data changes; SSO links are preserved for when SSO is re-enabled.
