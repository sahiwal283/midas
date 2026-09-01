# Midas

Internal expense platform. Midas owns the complete expense system — categories,
receipt uploads, OCR, accountant review, reimbursement, Zoho Books push,
in-app conversation, audit logs, and browser-extension capture — so that other
internal apps (the Trade Show app, Argo, Milo, …) delegate expense logic to it
instead of each building their own.

**Version:** see `packages/shared/src/version.ts` (exposed at `GET /api/v1/meta`).

---

## Workspace layout

| Path | What it is |
|---|---|
| `apps/api` | Express + TypeScript + Drizzle ORM backend (port 4000) |
| `apps/web` | React + Vite + Tailwind frontend, installable PWA (port 5173) |
| `extension/` | Manifest V3 browser extension (capture → expense) |
| `packages/shared` | Shared types, `OwnerRef`, `MIDAS_VERSION` |
| `packages/ocr-client` | OCR preprocessing + HTTP adapter + rule-based fallback |
| `packages/import` | Generic import pipeline for embedder data |
| `scripts/` | Backup, smoke-test, and ops shell scripts |

---

## Quickstart

### Docker (preferred)

```bash
cp .env.example .env          # defaults point at the bundled local Postgres
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

- Web: http://localhost:5173 · API: http://localhost:4000
- First run auto-syncs the schema and seeds default data.

### Without Docker

```bash
npm install
npm run dev        # api + web in parallel (needs a reachable Postgres in .env)
```

### Default seed credentials

| Email | Password | Role |
|-------|----------|------|
| admin@midas.local | admin123 | admin |
| accountant@midas.local | accountant123 | accountant |
| user@midas.local | user123 | user |

Change all of these before connecting to any shared environment.

---

## Everyday commands

```bash
npm run lint            # type-check all workspaces
npm run test -w apps/api    # backend unit tests (no DB needed)
npm run build           # build everything
npm run db:studio       # Drizzle Studio GUI
```

Backend recovery tools (run in `apps/api`): `npm run recover:admin-pw`,
`recover:merge-users`, `recover:company-state`.

---

## Configuration

Everything is env-driven; `.env.example` is the annotated authority. The
important toggles:

| Var | Meaning |
|---|---|
| `DATABASE_URL` / `POSTGRES_*` | PostgreSQL connection |
| `JWT_SECRET` | min 32 chars, different per environment |
| `AUTH_MODE` | `local` (password) or `authentik` (OIDC SSO) |
| `OCR_MODE` | `service` (live engine) or `mock` (offline tests) |
| `ZOHO_MODE` | `mock` locally; `service` pushes real records |
| `COOKIE_SECURE` | `false` locally, `true` behind HTTPS |

In production the API audits this configuration at boot and logs loudly about
anything missing — silent feature degradation has bitten before.

---

## Where to go next

| Question | Doc |
|---|---|
| How does the system fit together? | `docs/architecture.md` |
| What's in the database? | `docs/DATABASE_DESIGN.md` |
| What are the API contracts? | `docs/API_CONTRACTS.md` |
| How do I deploy / operate prod? | `docs/OPERATIONS.md`, `docs/PROXMOX_DEPLOYMENT.md` |
| How does Zoho integration work? | `docs/ZOHO_INTEGRATION.md`, `docs/ZOHO_PO_CONTRACT.md` |
| How does SSO work? | `docs/AUTHENTIK_SETUP.md` |
| How does OCR work? | `docs/OCR_ENGINE.md` |
| How does the extension work? | `docs/EXTENSION_DESIGN.md` |
| How do other apps embed Midas? | `docs/EMBEDDING.md`, `docs/EXT_API_MERGE_LOCK.md`, `docs/IMPORT_FRAMEWORK.md` |
| Sync/offline model? | `docs/SYNC_AND_OFFLINE.md` |
| Backups? | `docs/BACKUP_RESTORE.md` |
| Security posture? | `docs/SECURITY.md` |
| How are versions cut? | `docs/VERSIONING.md`, `docs/CHANGELOG.md` |

`CLAUDE.md` carries working notes for AI-assisted development in this repo.
