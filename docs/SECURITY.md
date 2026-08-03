# Midas Security Reference

## Current posture (LAN/internal deployment)

Midas is currently deployed on a private LAN (Proxmox, no public routing). The security posture is appropriate for **internal testing only**. Several items must be addressed before exposing Midas to external networks or real user data.

---

## Authentication

### Mechanism
- httpOnly cookie JWT. The token is set by `POST /api/v1/auth/login` and sent automatically by the browser on every request.
- The cookie is never readable by JavaScript.
- `withCredentials: true` on all Axios calls.
- Token lifetime: `JWT_EXPIRES_IN` (default `8h`).

### Authentik OIDC (active as of 2026-05-20; auto-provisioning enabled 2026-05-21)

`AUTH_MODE=authentik` is live on CT 3120. All logins go through Authentik OIDC at `https://auth.booute.duckdns.org/`. Local break-glass login remains enabled (`ALLOW_LOCAL_BREAK_GLASS=true`). Client secret rotated 2026-05-21.

- Group-to-role mapping: `midas-admins`→admin, `midas-accountants`→accountant, `midas-users`→user.
- Role is synced from Authentik groups on every SSO login (Authentik groups are source of truth).
- `AUTHENTIK_AUTO_CREATE_USERS=true` — users in approved groups are auto-created on first SSO login.
- Users with no approved Midas group are denied regardless of auto-create setting.
- SSO links stored in `sso_links` table by `(provider, subject)`.
- Auto-provisioned users have `passwordHash=null` — they cannot use local login unless an admin sets a local password via reset-password.
- All SSO provisioning events are recorded in `audit_logs` (`sso.user_auto_created`, `sso.user_linked_by_email`, `sso.login_denied_no_group`, `sso.login_denied_inactive_user`, `sso.login_success`).

See `docs/AUTHENTIK_SETUP.md` for full details.

### Known gaps
- **No HTTPS yet**: `COOKIE_SECURE=false` — the JWT cookie is transmitted in plaintext over HTTP. Acceptable on a closed LAN; must flip to `true` before any external access.
- **No token refresh**: Long-lived tokens (8h). No refresh token mechanism.
- **HS256 token signing**: The Midas Authentik provider uses HMAC-SHA256 (client secret as key) because no certificate keypair is assigned. Upgrade path: assign an RSA certificate in Authentik admin UI → provider switches to RS256 automatically. Midas code handles both.
- **In-memory OIDC state store**: PKCE state is held in-memory; API restart invalidates in-flight OIDC sessions. Single-instance only.
- **Client secret rotation recommended**: The `AUTHENTIK_CLIENT_SECRET` (prefix `L4Dq`) appeared in session transcripts. Rotate via Authentik admin UI → Providers → Midas → Edit → regenerate, then update CT 3120 `.env` and run `docker compose up -d api`.

---

## Seed credentials

Default seed credentials are rotated on first deploy. The production `users` table must not contain the original seed passwords (`admin123`, `accountant123`, `user123`).

After rotation, credentials are stored at **`/root/midas-credentials.json` on CT 3120** with `chmod 600`. They are not stored in git, not in `.env`, and not logged.

Rotate again using:
```bash
# From Proxmox host
pct exec 3120 -- bash /opt/midas/scripts/rotate-credentials.sh
```

With `AUTH_MODE=authentik` active:
- Identity is managed by Authentik. Disable an account by removing the user from all Midas groups in Authentik.
- Local bcrypt accounts remain for break-glass. If credentials are compromised, deactivate the account via `PATCH /api/v1/admin/users/:id` or directly in the DB.
- Password reset: admin can generate a temporary password via `POST /api/v1/admin/users/:id/reset-password`. Plaintext is returned once and never stored.
- The `AUTHENTIK_CLIENT_SECRET` is in `/opt/midas/.env`. Treat it as a high-value secret — it is used to verify ID token signatures in HS256 mode.

---

## Upload validation

All file upload endpoints enforce:
- **Size limit**: 10 MB
- **Allowed MIME types**: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`
- Enforced server-side. Frontend validation is supplementary only.

| Endpoint | Method | Validation |
|---|---|---|
| `/api/v1/expenses/:id/receipts` | POST multipart | multer fileFilter + size limit |
| `/api/v1/captures` | POST JSON body (base64) | MIME + size check after decode |
| `/api/v1/extension/expenses` | POST JSON body (base64) | MIME + size check after decode |

Error codes:
- `415 UNSUPPORTED_MIME` — file type not allowed
- `413 FILE_TOO_LARGE` — exceeds 10 MB (both JSON/base64 and multipart routes)
- `400 INVALID_IMAGE` — malformed data URL

Multer's internal `LIMIT_FILE_SIZE` error is caught by the global error handler (`middleware/error.ts`) and mapped to HTTP 413 `FILE_TOO_LARGE`. Previously this surfaced as 500; fixed 2026-05-08.

Note: PDF extension bypass in `receipts.ts` allows `.pdf` files where the browser sends `application/octet-stream` (a known browser quirk on some platforms). This is intentional and safe because the file content is never executed.

---

## API keys (app-to-app)

External apps connect via `/api/v1/ext/` using Bearer API keys. Keys are:
- Issued by admin through the API key management endpoint.
- SHA-256 hashed before storage in `app_connections` — raw keys are never persisted.
- Scoped to the `app_connections` table; revocation is immediate (delete the row).

---

## Database access

- PostgreSQL on CT 3220 (192.168.1.211).
- `pg_hba.conf` restricts connections to `192.168.1.210/32` (CT 3120 only).
- Not exposed on any public interface.
- No connection pooler yet — connection limit relies on Express app behavior.

---

## HTTP security headers

`helmet` middleware is applied globally in `apps/api/src/server.ts`. Default helmet config enables:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `X-XSS-Protection: 0` (modern browsers)
- `Strict-Transport-Security` (inactive without HTTPS)
- `Content-Security-Policy` (default-src 'self')

---

## Secrets management

Secrets live in `/opt/midas/.env` on CT 3120. Current secret surface:
- `JWT_SECRET` — must be min 32 characters, unique per environment
- `DATABASE_URL` — contains DB password in connection string
- `POSTGRES_PASSWORD` — DB password separately

**Required before any external access:**
- Move secrets to a secrets manager (Vault, Docker secrets, or Proxmox secrets store).
- Rotate `JWT_SECRET` if the `.env` file was ever committed or logged.
- Never log `DATABASE_URL` or any env var containing credentials.

---

## HTTPS / TLS

Not yet configured. Planned path:
1. Deploy Nginx Proxy Manager (CT 104 already running).
2. Point `midas.internal` → CT 3120:5173 and `midas-api.internal` → CT 3120:4000.
3. Issue LAN certificates (self-signed or internal CA via NPM).
4. Set `COOKIE_SECURE=true` and `COOKIE_DOMAIN=.internal` in `.env`.
5. Restart containers.

Do not open public routing until HTTPS is configured.

---

---

## Checklist: before opening external access

- [ ] HTTPS configured (NPM or certbot)
- [ ] `COOKIE_SECURE=true` in `.env`
- [ ] Seed credentials rotated
- [x] Authentik SSO wired *(2026-05-20 — AUTH_MODE=authentik, ALLOW_LOCAL_BREAK_GLASS=true)*
- [ ] Assign RSA certificate to Midas Authentik provider (upgrade from HS256 to RS256)
- [ ] JWT_SECRET rotated to fresh value in production `.env`
- [ ] DB not exposed publicly (verify `pg_hba.conf`)
- [ ] Backup solution verified and tested restore performed
- [ ] Rate limiting verified on auth endpoints
- [ ] Upload directory (`/opt/midas/uploads`) not directly web-accessible without auth
