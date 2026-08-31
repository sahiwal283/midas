# Repo cleanup and documentation — design

**Date:** 2026-08-31
**Version:** 1.8.0 → 1.8.1
**Goal:** leave Midas in a state that needs no attention for months. Every
document present is current; every line of code present is reachable.

---

## Why now

Midas has shipped 75 changelog entries and reached v1.8.0. The code is healthy —
695 tests green, clean type-check across all workspaces — but the
documentation has drifted badly:

- There is **no root README**. A newcomer's first stop does not exist.
- `docs/DATABASE_DESIGN.md` has not been touched since 2026-05-14 while
  `schema.ts` grew to 708 lines. It is the most confidently wrong file in the
  repo.
- `docs/` holds 38 loose files, roughly half of them one-shot artifacts:
  resolved blockers, completed migration handoffs, sign-off packages. Nothing
  marks them as spent, so all 38 read as equally authoritative.
- 44 superpowers plans and specs describe work that has long since shipped.

The risk is not that the docs are missing. It is that they are *plausible* — a
future reader trusts `ZOHO_AUTH_BLOCKER.md` and acts on a diagnosis that was
corrected months ago.

---

## Scope decisions

Four choices were made explicitly before design:

| Decision | Choice | Consequence |
|---|---|---|
| Cleanup aggressiveness | **Conservative — provably dead only** | No file splitting, no route removal, no restructuring of live code. Behavior is unchanged. |
| Obsolete docs | **Delete outright** | Git history preserves everything. `docs/` becomes a list where presence implies currency. |
| Diagrams | **Mermaid in markdown** | Renders on GitHub, diffs in git, editable without tooling. DB diagram grouped by domain rather than one unreadable ERD. |
| Deploy | **Full deploy + verify** | Proves the pruned tree builds and runs in prod, which is the point of walking away from it. |

---

## Part 1 — Documentation

### New: `README.md`

The front door, which does not currently exist. Contents:

- What Midas is and why it is standalone — other apps (Argo, Milo, the trade
  show app) delegate expense logic rather than reimplementing it.
- Workspace layout: `apps/api`, `apps/web`, `packages/{shared,import,ocr-client}`,
  `extension`.
- Quickstart: Docker local (with bundled Postgres) and non-Docker.
- Default seed credentials, with the warning to change them.
- Environment variable summary pointing at `.env.example` as the authority.
- A "where to go next" table linking every surviving doc.

### Rewrite: `docs/architecture.md`

Two mermaid diagrams:

1. **System / deployment graph.** Browser, PWA and Chrome extension → npmplus
   TLS termination (CT 104) → CT 3120 running `midas-api-1` and `midas-web-1` →
   CT 3220 PostgreSQL. Side channels to the OCR engine, the Zoho integration
   service, Authentik, and the payroll and trade-show databases.
2. **Expense lifecycle sequence.** Capture → OCR → accountant review → approve →
   Zoho push, showing where `expense_messages` and `audit_logs` are written.

Absorbs `EXPENSE_WORKFLOW.md`, `ACCOUNTANT_WORKFLOW.md` and
`PAYMENT_METHODS_DESIGN.md`, all of which predate several reworks of the flows
they describe.

### Rewrite: `docs/DATABASE_DESIGN.md`

Regenerated from the current `schema.ts`. Mermaid ERDs split by domain —
identity and auth, expense core, receipts and OCR, Zoho mapping, purchase
orders and cashbook, integration and audit — because one diagram over the full
table set is unreadable and therefore unread. Plus the PostgreSQL enum tables
and the drizzle migration workflow (`db:push` in dev, `db:generate` →
commit SQL → `db:migrate` in production).

### Merges

- `docs/ocr-integration.md` → `docs/OCR_ENGINE.md`
- `docs/deployment-proxmox.md` → `docs/PROXMOX_DEPLOYMENT.md`. The former is
  written for "when Proxmox access is restored"; it has been restored for months
  and the latter documents the actual running topology.

### Deletions

Fifteen one-shot documents:

`CONTRACT_ALIGNMENT`, `EXT_SANDBOX_HANDOFF`,
`MIDAS_AUTHENTIK_APP_SIDE_DEBUG_REPORT`, `MIGRATION_PLAN`, `PROJECT_DOCKET`
(still declares v0.3.0-alpha), `PILOT_CHECKLIST` (the pilot is live),
`TRADE_SHOW_AGENT_HANDOVER`, `TRADE_SHOW_APPLY_GO`,
`TRADE_SHOW_MIGRATION_CONTRACT`, `TRADE_SHOW_MIGRATION_REPLY`,
`TRADE_SHOW_OCR_INVALID_FIX`, `TRADE_SHOW_PAYMENT_METHODS`,
`trade-show-integration-response`, `ZOHO_AUTH_BLOCKER`, `ZOHO_MAPPING_REVIEW`,
plus the three absorbed workflow docs.

All 44 files under `docs/superpowers/plans/` and `docs/superpowers/specs/`,
including this spec once the work lands. They describe shipped work; the
changelog is the durable record of what happened.

**Explicitly kept despite appearing spent:** `EXT_API_MERGE_LOCK.md` and
`SYNC_AND_OFFLINE.md`. Both are cited from live source — `requireScope.ts`,
`ext.ts`, `receipts.ts`, `extensionExpenses.ts`, `uploadQueue.ts` — so deleting
them would strand comments that a reader needs.

### Link repair

Every inbound reference from a surviving file is repaired: `EMBEDDING.md`,
`API_CONTRACTS.md`, `SECURITY.md`, `IMPORT_FRAMEWORK.md`, `ZOHO_INTEGRATION.md`,
`OCR_ENGINE.md`, `OPERATIONS.md`, `architecture.md`, `CLAUDE.md`, and the
comment in `apps/api/src/server.ts`.

`CHANGELOG.md` is left alone. It is a historical record, and rewriting past
entries to point at files that did not exist when they were written would be a
lie about the past.

**Result: 38 loose docs → 18.** Fifteen one-shots deleted, three absorbed into
`architecture.md`, two merged into their successors — twenty removed in total.

---

## Part 2 — Cleanup

Only what can be proven dead.

| Item | Evidence |
|---|---|
| The file literally named `""` | A tracked curl cookie jar, committed by accident. Present in prod too, having been tarballed over. |
| `apps/api/src/lib/telegram.ts` | `notifyTelegram` has zero callers. Removed along with `TELEGRAM_BOT_TOKEN` in `env.ts`, its `configAudit.ts` entry, the assertions in `configAudit.test.ts`, and the `.env.example` line. The env schema is a plain `z.object`, which strips unknown keys, so a leftover value in the production `.env` cannot break boot. |
| 8 local + 8 remote branches | Every one measures `0 ahead` of main. Deletion is lossless. |

The 11 unwired one-off scripts under `apps/api/src/scripts/` (`seed-*`, `sync-*`,
`repair-company-integration-state`, `merge-users`, `reset-admin-pw`,
`parity-ocr-smoke`) are **not** deleted unilaterally. Several are the kind of
tool wanted during an incident, so each is presented for an individual decision.

**Gate:** `npm run lint` clean and all 695 tests green. Any red stops the work.

---

## Part 3 — Release and deploy

**v1.8.1**, a semver PATCH: no user-visible behavior changes. Per
`docs/VERSIONING.md`, that means `MIDAS_VERSION` in
`packages/shared/src/version.ts` plus the `version` field in
`apps/api/package.json`, `apps/web/package.json` and
`packages/shared/package.json`, and a matching `CHANGELOG.md` section.

Work lands on `chore/cleanup-and-docs`, merges to `main`, tags `v1.8.1`, pushes
to GitHub.

Deploy follows `docs/OPERATIONS.md`: tarball → `scp` to the Proxmox host
(192.168.1.190) → `pct push` into CT 3120 →
`docker compose -f docker-compose.prod.yml up -d --no-deps --build api web`.
Verification is `GET /api/v1/meta` returning 1.8.1 with both containers healthy.

**No migration runs.** The schema is untouched by this release.

### Deliberate non-actions in production

Two prior incidents inform this. A laptop `.env` once reached production and
broke SSO, push notifications, payroll and Telegram; separately, the migrator
service is known broken in a way that silently applies nothing. Therefore:

- The production `.env` is not read, written, or copied over.
- The migrator service is not invoked at all.

---

## Success criteria

1. `README.md` exists and a newcomer can start Midas from it alone.
2. `architecture.md` and `DATABASE_DESIGN.md` render diagrams on GitHub that
   match the code as of v1.8.1.
3. `docs/` contains 18 files, every one of them current.
4. `npm run lint` clean; 695 tests green (622 api, 44 shared, 15 import, 14 ocr-client).
5. `main` tagged `v1.8.1` and pushed to GitHub.
6. `GET /api/v1/meta` on prod returns `"version":"1.8.1"`, both containers
   healthy.
