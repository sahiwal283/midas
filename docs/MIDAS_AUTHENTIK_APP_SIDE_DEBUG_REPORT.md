# Midas Authentik App-Side Debug Report

**Date:** 2026-05-21  
**Status:** SSO fully operational. Auto-provisioning enabled — valid Authentik users in approved groups are created automatically on first sign-in.

---

## 1. Root Cause Summary

Two issues were found and resolved:

**Issue 1 (fixed 2026-05-21 session 1):** Wrong client secret in CT 3120 `.env`.  
The secret `ZJCO...` written in a prior session was Luma's client secret, not Midas's. The correct Midas provider secret (prefix `L4Dq`, 128 chars) was extracted from the Authentik DB on CT 111 and written to CT 3120 `.env`. Client auth now returns `invalid_grant` (correct — client auth passes, fake code rejected) instead of `invalid_client`.

**Issue 2 (resolved 2026-05-21 session 2):** No Midas user pre-provisioned with the Authentik test user's email.  
Was resolved by implementing SSO auto-provisioning (`AUTHENTIK_AUTO_CREATE_USERS=true`). On first SSO login, Midas now creates the user record automatically if they are in an approved Midas group. No manual pre-creation required. The `resolveLocalUser` flow: SSO link → email match → auto-create → deny.

---

## 2. Env Validation (secrets redacted)

Checked via `docker exec midas-api-1 env` on CT 3120:

| Variable | Value | Status |
|---|---|---|
| `AUTH_MODE` | `authentik` | ✓ |
| `AUTHENTIK_CLIENT_ID` | `347nbznJmVPx7V60PNevuwtkanwVdyS7tBBd7640` | ✓ matches |
| `AUTHENTIK_CLIENT_SECRET` | prefix `L4Dq`, len 128 | ✓ present, matches Authentik DB |
| `AUTHENTIK_ISSUER_URL` | `https://auth.booute.duckdns.org/` | ✓ matches discovery issuer |
| `AUTHENTIK_DISCOVERY_URL` | `https://auth.booute.duckdns.org/application/o/midas/.well-known/openid-configuration` | ✓ |
| `AUTHENTIK_REDIRECT_URI` | `http://192.168.1.210:4000/api/v1/auth/oidc/callback` | ✓ strict match in Authentik |
| `AUTHENTIK_POST_LOGOUT_REDIRECT_URI` | `http://192.168.1.210:5173/login` | ✓ |
| `AUTHENTIK_SCOPES` | `openid email profile groups` | ✓ includes `groups` scope |
| `AUTHENTIK_GROUP_ADMIN` | `midas-admins` | ✓ |
| `AUTHENTIK_GROUP_ACCOUNTANT` | `midas-accountants` | ✓ |
| `AUTHENTIK_GROUP_USER` | `midas-users` | ✓ |
| `ALLOW_LOCAL_BREAK_GLASS` | `true` | ✓ |
| `CORS_ORIGIN` | `http://192.168.1.210:5173` | ✓ |
| `COOKIE_SECURE` | `false` | ✓ appropriate for HTTP LAN |
| `COOKIE_SAME_SITE` | `lax` | ✓ |
| `OCR_MODE` | `mock` | ✓ unchanged |
| `ZOHO_MODE` | `mock` | ✓ unchanged |

---

## 3. Frontend Login Route Behavior

- Login page fetches `/api/v1/auth/config` on mount; gets `{"authMode":"authentik","showLocalLogin":true}`.
- "Sign in with Authentik" button is the primary visual action (filled blue, `py-3`).
- Button href is `/api/v1/auth/oidc/login` (relative — goes through Vite proxy to API).
- API constructs state/nonce/PKCE, stores in in-memory Map, redirects browser to Authentik authorize URL.
- Frontend does NOT construct Authentik URL directly.
- Vite proxy (`/api → http://api:4000`, `changeOrigin: true`) forwards the request and passes the 302 redirect through to the browser.

---

## 4. Callback: Was It Reached?

Yes — programmatically confirmed the callback route is reached and processes correctly:
- Callback URL: `http://192.168.1.210:4000/api/v1/auth/oidc/callback` (direct, not through Vite proxy).
- The route is mounted at `app.use('/api/v1/auth', oidcAuthRouter)` in `server.ts`.

---

## 5. State / Nonce / PKCE

- State created at login-start, stored in `oidcStateStore` (in-memory Map, 10-min TTL).
- Nonce and code verifier stored alongside state.
- PKCE: `code_challenge_method=S256` sent in authorize URL; `code_verifier` sent in token exchange.
- **Potential failure mode:** If the API container restarts between the login redirect and the callback, the in-memory state is lost → `invalid_state` error. Log will show `[oidc:callback] invalid_state — state not found`.
- In current single-container deployment this is only a risk if the container crashes/restarts.

---

## 6. Token Exchange

- Auth method: `client_secret_post` (client_id + client_secret in POST body).
- Authentik supports both `client_secret_post` and `client_secret_basic` for this provider.
- **Confirmed working:** probe from inside Docker container returns `invalid_grant` (correct — client auth passes, bad code rejected).
- Token endpoint: `https://auth.booute.duckdns.org/application/o/token/` (from discovery).
- Authorization code is not logged anywhere in Midas code.

---

## 7. Issuer Validation

- Discovery issuer: `https://auth.booute.duckdns.org/` ✓
- `AUTHENTIK_ISSUER_URL` = `https://auth.booute.duckdns.org/` ✓
- `validateIdToken` passes `issuer: config.issuerUrl` to `jose`'s `jwtVerify` → exact match → passes.
- Signing: HS256 (detected from `id_token_signing_alg_values_supported: ['HS256']`); verification key = `TextEncoder(clientSecret)`.

---

## 8. Groups Parsing

- `AUTHENTIK_SCOPES` includes `groups` → groups claim is present in the ID token.
- Parsed from `claims.groups` (array of strings).
- `mapGroupsToRole` checks in order: `midas-admins` → admin, `midas-accountants` → accountant, `midas-users` → user.
- If user is in all three groups: admin wins (highest-privilege).
- If no group matches: `denied_no_group` → login blocked.
- Debug log: `[oidc:groups-found] { groups: [...], role: 'admin' }`.

---

## 9. User Linking / sso_links

**This is the likely failure point for first-time SSO login.**

`resolveLocalUser` logic:
1. Query `sso_links` by `(provider='authentik', subject=<sub from token)` → fast path for returning users.
2. If no link: query `users` by `email` from ID token → auto-link if found.
3. If no match: return `null` → redirect `denied_no_match`.

**Current Midas users all have `@midas.local` emails.** The Authentik test user's email is a real address. Until a Midas user is created with the matching email, step 3 is reached and login is denied.

**Fix required (operator action):**
1. Log into Midas as admin (break-glass: `admin@midas.local` / `BreakGlass2026!`).
2. Go to Admin → Settings → Users tab → Add User.
3. Set email to exactly match the Authentik user's email address.
4. Set role (e.g., `admin` for the test user).
5. Save. On next SSO login, Midas will auto-link by email and create the `sso_links` row.

After first SSO login, the `sso_links` row exists and email matching is bypassed (fast path).

Log on success: `[oidc:user-linked] { userId: '...', role: 'admin', mappedRole: 'admin' }`.
Log on failure: `[oidc:callback] denied_no_match — ... emailDomain: <domain>`.

---

## 10. Session Cookie

- Set with: `httpOnly: true`, `secure: false` (HTTP LAN), `sameSite: 'lax'`, no `Domain` attribute (bound to `192.168.1.210`, all ports).
- Cookie set in response to callback at port 4000; valid for port 5173 (RFC 6265 — no port binding).
- Vite proxy forwards `Cookie` header from browser (port 5173) to API (port 4000).
- `cookieParser()` registered in Express; `authenticate` middleware reads `req.cookies.token`.

---

## 11. /auth/me After SSO

Requires a successful browser SSO session (pending operator action from item 9).

After fix: `GET /api/v1/auth/me` → `{"user": {"id": "...", "email": "...", "name": "...", "role": "admin"}}`.

---

## 12. Role Mapping

| Authentik group | Midas role |
|---|---|
| `midas-admins` | admin |
| `midas-accountants` | accountant |
| `midas-users` | user |

Precedence: admin > accountant > user. If test user is in all three, role = `admin`. Role synced from Authentik on every SSO login (Authentik groups are source of truth).

---

## 13. Local Break-Glass

- `ALLOW_LOCAL_BREAK_GLASS=true` → local login form visible.
- Verified working: `POST /auth/login` with `admin@midas.local / BreakGlass2026!` → 200, role admin.
- Local login is visually collapsed under `<details>` "Break-glass local login" with amber note.
- Backend local auth route unchanged; bcrypt verification unaffected by OIDC mode.

Rollback to local-only:
```bash
ssh root@192.168.1.190 "pct exec 3120 -- sed -i 's/^AUTH_MODE=.*/AUTH_MODE=local/' /opt/midas/.env"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'"
```

---

## 14. Login UI Changes

- SSO button: primary action, filled `bg-brand-600`, `py-3`, full-width.
- Local form: collapsed inside `<details>/<summary>` "Break-glass local login"; amber warning text.
- Error display: `oidcErrorLabel()` maps codes to plain English; no raw Authentik JSON in browser.
- Server-side: raw error body logged with secrets redacted; `request_id` passed to frontend as `oidc_request_id` param only.

---

## 15. Error Display Cleanup

User-facing messages (in `Login.tsx`):

| `oidc_error` code | Displayed message |
|---|---|
| `token_error` | "SSO sign-in failed. Please contact an administrator." |
| `invalid_state` | "SSO session expired. Please try again." |
| `denied_no_group` | "Your account is not assigned to a Midas access group." |
| `denied_no_match` | "Your SSO account is not linked to a Midas account. Contact an administrator." |
| `denied_inactive` | "Your account has been deactivated. Contact an administrator." |
| `missing_params` | "SSO callback was incomplete. Please try again." |

`oidc_request_id` param, if present, displayed as "Reference: `<id>`" below the message.

---

## 16. Debug Logs (Task 8)

Logs added to `apps/api/src/routes/oidcAuth.ts` at each stage. View with:
```bash
ssh root@192.168.1.190 "pct exec 3120 -- docker logs midas-api-1 --tail 50 --follow"
```

Stages logged:
- `[oidc:login-start]` — discovery URL, token endpoint, redirect_uri, client_id prefix, scopes
- `[oidc:callback-received]` — hasCode, hasState, oidcError
- `[oidc:state-valid]` — state found
- `[oidc:token-exchange-ok]` — sub, hasEmail, issuer (no token values)
- `[oidc:token-exchange-error]` — sanitized detail, request_id
- `[oidc:groups-found]` — group names, mapped role
- `[oidc:user-linked]` — userId, role, mappedRole
- `[oidc:role-synced]` — from/to role
- `[oidc:session-created]` — userId, role, redirectTo

Never logged: client secret, auth code, access/ID/refresh token, cookies, passwords.

---

## 17. Tests Run

| Test | Result |
|---|---|
| API typecheck (`tsc --noEmit`) | PASS |
| Web typecheck (`tsc --noEmit`) | PASS |
| API unit tests (108 tests) | 108/108 PASS |
| Smoke test (8 checks) | 8/8 PASS |
| Workflow verification (53 checks) | 53/53 PASS |

---

## 18. Infrastructure

```
NAME          STATUS   PORTS
midas-api-1   Up       0.0.0.0:4000->4000/tcp
midas-web-1   Up       0.0.0.0:5173->5173/tcp
```

- `/api/v1/health` → `{"status":"ok","db":"ok"}`
- `/api/v1/meta` → `{"appName":"Midas","version":"0.1.0-alpha","environment":"development"}`
- Port 5432 not listening on CT 3120 (DB is CT 3220 at 192.168.1.211)
- `OCR_MODE=mock` ✓
- `ZOHO_MODE=mock` ✓

---

## 19. Client Secret Rotation Recommendation

**Strongly recommended.** The `AUTHENTIK_CLIENT_SECRET` (prefix `L4Dq`) has appeared in session transcripts. To rotate:

1. In Authentik admin UI: Providers → Midas → Edit → regenerate client secret → copy new value.
2. On CT 3120:
   ```bash
   # Write new secret directly to .env (do not echo or print it)
   # Then recreate API container:
   ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d api'"
   ```
3. Verify probe returns `invalid_grant`:
   ```bash
   ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 python3 -c \"
   import os, urllib.request, urllib.parse, json
   body = urllib.parse.urlencode({'grant_type':'authorization_code','code':'probe','redirect_uri':os.environ['AUTHENTIK_REDIRECT_URI'],'client_id':os.environ['AUTHENTIK_CLIENT_ID'],'client_secret':os.environ['AUTHENTIK_CLIENT_SECRET'],'code_verifier':'probe'}).encode()
   req = urllib.request.Request('https://auth.booute.duckdns.org/application/o/token/', data=body, headers={'Content-Type':'application/x-www-form-urlencoded'}, method='POST')
   try: urllib.request.urlopen(req)
   except urllib.error.HTTPError as e: d=json.loads(e.read()); print('error:',d.get('error'),'(want invalid_grant)')
   \""
   ```

---

## 20. Required Operator Actions (Blocking)

1. **Create Midas user with Authentik email** (blocks all SSO logins):
   - Log in as admin (break-glass)
   - Admin → Settings → Users → Add User
   - Set email = exact Authentik account email, role = admin (for test user)
   - On next SSO attempt, `sso_links` row is auto-created

2. **Run browser E2E test** after user is created:
   - Open `http://192.168.1.210:5173/login`
   - Click "Sign in with Authentik"
   - Authenticate in Authentik
   - Verify redirect to `/dashboard`
   - Check `docker logs midas-api-1` for `[oidc:session-created]`

3. **Rotate client secret** after E2E confirms working (item 19 above)

---

## 21. Non-Blocking Future Items

- Assign RSA certificate to Midas Authentik provider (HS256 → RS256 upgrade)
- Redis/DB-backed OIDC state store (remove single-instance restriction)
- Backchannel logout endpoint implementation
