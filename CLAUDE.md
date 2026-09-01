# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**Midas** is a standalone internal expense platform. Other apps (Argo for trade shows, Milo for payroll, etc.) delegate expense logic to Midas rather than each building their own. Midas owns: expense categories, receipt uploads, OCR integration, accountant review queues, reimbursement workflows, Zoho push, in-app conversation, audit logs, browser extension captures.

See `docs/architecture.md` for full architecture and domain details.

---

## Development Commands

### Start everything (Docker — preferred)

**Local dev** (with bundled Postgres):
```bash
cp .env.example .env  # DATABASE_URL defaults to local db container
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

**Production** (CT 3220 as DB — `docker-compose.yml` only, no local db service):
```bash
# .env must have DATABASE_URL pointing to CT 3220 (192.168.1.211)
docker compose up --build
```

- API: http://localhost:4000
- Web: http://localhost:5173
- DB: localhost:5432 (local dev only; bound to 127.0.0.1)

On first run, the API container automatically runs `db:push --force` (schema sync) then `db:seed`.

### Workspace root
```bash
npm run dev       # Start api + web in parallel (non-Docker)
npm run build     # Build all workspaces
npm run lint      # Type-check all workspaces
```

### Backend (`apps/api/`)
```bash
npm run dev             # Hot reload (tsx watch)
npm run build           # tsc → dist/
npm run lint            # tsc --noEmit
npm run test            # Vitest unit tests (no DB required)
npm run test:watch      # Vitest in watch mode

npm run db:push         # Sync schema to DB (dev only — no migration files)
npm run db:generate     # Generate migration SQL from schema changes
npm run db:migrate      # Apply pending migrations (production)
npm run db:seed         # Seed default categories + users
npm run db:reset        # drizzle-kit push --force + seed
npm run db:studio       # Drizzle Studio GUI
```

### Frontend (`apps/web/`)
```bash
npm run dev    # Vite dev server (port 5173)
npm run build  # Production build → dist/
npm run lint   # tsc --noEmit
```

### Extension (`extension/`)
```bash
npm run build  # Build → extension/dist/ (load unpacked in Chrome)
npm run dev    # Watch mode
```

---

## Architecture

**Migration system: Drizzle ORM + drizzle-kit** (not Prisma)
- Schema: `apps/api/src/db/schema.ts` — TypeScript-first, PostgreSQL enums, no magic
- Local dev: `db:push` (direct sync, no migration files)
- Production: `db:generate` → commit SQL files → `db:migrate`

**Auth: httpOnly cookie JWT** — NOT localStorage. The cookie is set by `POST /api/v1/auth/login` and sent automatically by the browser on every request. The frontend uses `withCredentials: true` on all Axios calls. Never move the token to localStorage without documenting the security tradeoff.

**Integration adapters** (toggle via env):
- `OCR_MODE=mock|service` → `apps/api/src/lib/ocr.ts`
- `ZOHO_MODE=mock|service` → `apps/api/src/lib/zoho.ts`
- `STORAGE_MODE=local|s3` → `apps/api/src/lib/storage.ts`
Midas does NOT implement Zoho OAuth or OCR. Those belong in separate services.

**App-to-app API** at `/api/v1/ext/` uses Bearer API keys issued by admin. Keys are SHA-256 hashed in `app_connections` table.

**Conversation ownership**: `expense_messages` is the canonical record. Telegram is notify-only. Never let Telegram be the source of truth.

### Key file locations
- DB schema: `apps/api/src/db/schema.ts`
- Auth middleware: `apps/api/src/middleware/auth.ts`
- Error handling: `apps/api/src/middleware/error.ts` (`asyncHandler`, `createError`, `notFound`)
- Audit log: `apps/api/src/lib/audit.ts` (`auditLog()`)
- React auth: `apps/web/src/contexts/AuthContext.tsx`
- API client: `apps/web/src/api/client.ts` (axios, `withCredentials: true`)

---

## Default Seed Credentials

| Email | Password | Role |
|-------|----------|------|
| admin@midas.local | admin123 | admin |
| accountant@midas.local | accountant123 | accountant |
| user@midas.local | user123 | user |

Change all passwords before connecting to any production or shared environment.

---

## Database Schema (key tables)

| Table | Notes |
|-------|-------|
| `expenses` | `source_app` + `source_ref_id` nullable — no event coupling |
| `expense_messages` | In-app conversation, owns audit trail |
| `receipts` | Per-expense file attachments + OCR state |
| `captures` | Browser extension screenshots, linked to expenses by user |
| `audit_logs` | Immutable, append-only, never update/delete |
| `app_connections` | API key registry for external apps |

---

## Environment Variables

See `.env.example`. Critical ones:
- `DATABASE_URL` — PostgreSQL connection string (built from POSTGRES_* in Docker)
- `JWT_SECRET` — min 32 characters, different per environment
- `COOKIE_SECURE` — `false` locally, `true` in production (requires HTTPS)
- `OCR_MODE`, `ZOHO_MODE`, `STORAGE_MODE` — `mock` locally, `service` in production

---

## Proxmox Deployment

See `docs/PROXMOX_DEPLOYMENT.md` and `docs/OPERATIONS.md`. No code changes are needed — only `.env` values and proxy config change between local and Proxmox.

---

## Extension Development

See `docs/EXTENSION_DESIGN.md` for full design rationale, testing steps, and deferred items.

Build: `npm run build` in `extension/`. Load `extension/dist/` as an unpacked extension in Chrome (`chrome://extensions → Load unpacked`).

The extension has two workflows:
- **Save Capture** → `POST /api/v1/captures` — passive screenshot, no expense created
- **Submit Expense** → `POST /api/v1/extension/expenses` — creates expense (`status='pending'`) + receipt + capture atomically. Never approves. Never calls Zoho.

Configure both `midasUrl` (web UI, e.g. `http://localhost:5173`) and `midasApiUrl` (API, e.g. `http://localhost:4000`) in extension Options before testing. User must be logged into Midas in the same browser (session cookie auth).

**CORS:** The API allows `chrome-extension://` and `moz-extension://` origins so the extension service worker can make credentialed fetch calls. This is configured in `apps/api/src/server.ts`.
