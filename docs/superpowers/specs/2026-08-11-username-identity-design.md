# Username Identity — Make Email Optional

**Date:** 2026-08-11 · **Status:** Approved
**Goal:** Let a user be onboarded and sign in with a username, so an Authentik account without an email address provisions automatically. Email becomes optional metadata, not the identity key.

## Why

A new Authentik user (`sohanb`, in the `Employees` group) passed Midas's group gate but could not sign in: `users.email` is unique + not-null, so auto-provisioning refused an account with no email. Requiring an admin to add an email upstream defeats automatic onboarding.

## Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Username source for existing users | Authentik username → trade show username (by email) → email local-part |
| `admin` three-way collision | `admin@midas.local` keeps `admin` (break-glass seed); the others take real names |
| Login identifier | One field accepting **username or email** |
| Ext actor resolution | Add optional `submitterUsername`; `submitterEmail` keeps working unchanged |

## Design

### Schema (migration 0020)
- Add `users.username text NOT NULL UNIQUE` (compared case-insensitively, stored lowercase).
- Drop `NOT NULL` from `users.email`; keep the unique index. Postgres permits multiple NULLs in a unique index, so many users may have no email while present emails stay unique.

### Backfill
Runs in the migration transaction, priority order:
1. Authentik username via `sso_links` → `preferred_username` where a link exists.
2. Trade show username matched by email (from the Aug 10 sync data).
3. Email local-part.

`admin@midas.local` is pinned to `admin`. The script prints every assignment and aborts if any collision remains unresolved rather than silently suffixing.

### Login
`POST /auth/login` accepts `{ identifier, password }` — matched against username first, then email. `email` remains accepted as an alias for `identifier` so existing clients keep working. Error copy becomes "Invalid username or password". Rate limiting and the `ALLOW_LOCAL_BREAK_GLASS` gate are unchanged.

### SSO onboarding
`resolveLocalUser` order becomes:
1. SSO link on `(provider, sub)`.
2. **Username match** on `preferred_username`.
3. Email match — only when the token carries an email.
4. Auto-create — requires `preferred_username`; stores email when present, null otherwise.

`denied_no_email` becomes reachable only when Authentik sends neither a username nor an email.

### Ext API
`submitterUsername` added as an optional alternative to `submitterEmail` on create/patch/import. Resolution tries username, then email. Existing consumers are unaffected.

### Notifications
Email delivery is already fire-and-forget and never throws; it must skip cleanly when `email` is null instead of attempting a send.

### Invites
Invitations are email-delivered and therefore remain email-only. Admins creating a user without an email set a password directly; the admin form states this.

## Out of scope
- Removing `submitterEmail` from the ext contract.
- Changing Authentik's enrolment flow (making email required there is a separate, still-valid hardening step).
- Reimbursement or notification features that genuinely require a deliverable address.
- Renaming the `expenses.zoho_entity` column (tracked separately).
