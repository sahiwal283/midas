# Midas Import Framework

Midas ships a generic, embedder-agnostic import pipeline (`@midas/import`) for
bringing expense data from an external system into Midas — whether that's a
one-time cutover migration (e.g. an app adopting Midas as its expense engine)
or a recurring bulk import.

This is distinct from `docs/MIGRATION_PLAN.md`, which is the specific
field-mapping plan for one migration (trade-show-app → Midas). This document
describes the reusable framework itself, which any future embedder can reuse
for its own migration without touching Midas internals.

---

## Design goals

1. **No embedder-specific code in Midas.** The framework knows nothing about
   "trade show", "Argo", or any other calling application — it only knows
   about `ownerType`/`ownerId` (see `docs/architecture.md#extensibility`).
2. **Preserve everything the source has.** IDs (best-effort), timestamps, OCR
   metadata, attachments, categories, notes, and audit history all have a
   first-class place in the pipeline — nothing is silently dropped.
3. **Idempotent by construction.** Re-running an import after a partial
   failure never creates duplicates or clobbers existing data.
4. **Testable without a database.** The orchestration logic (`ImportService`)
   is unit-tested against an in-memory fake target — see
   `packages/import/src/__tests__/ImportService.test.ts`.

---

## Architecture

```
┌─────────────────────┐        ┌──────────────────┐        ┌───────────────────────────┐
│   ImportSource       │        │   ImportService   │        │   ImportTargetPort         │
│ (embedder-specific,  │──────▶│ (@midas/import,    │──────▶│ (Midas-specific, Drizzle)   │
│  e.g. legacy DB/API) │ yields │  generic orchestr.)│ calls  │ apps/api/.../drizzleImport- │
│                       │ records│                    │        │ Target.ts                   │
└─────────────────────┘        └──────────────────┘        └───────────────────────────┘
```

- **`ImportSource`** (embedder writes this) — reads from wherever the old
  data lives and yields `ImportRecord`s. Midas includes one trivial example,
  `JsonFileImportSource` (`apps/api/src/lib/import/jsonFileSource.ts`), which
  reads a JSON array from disk. Most real migrations will write a source that
  queries the legacy system's own database or API directly.
- **`ImportService`** (framework, in `@midas/import`) — the only piece with
  actual import logic: validation, idempotency checks, user/category
  resolution, dry-run support, and per-record error isolation (one bad record
  fails without aborting the whole run).
- **`ImportTargetPort`** (Midas implements this once) — the bridge into
  Midas's own Postgres/Drizzle storage. `DrizzleImportTargetPort`
  (`apps/api/src/lib/import/drizzleImportTarget.ts`) is Midas's concrete
  implementation and needs no changes per embedder — every embedder that
  bundles Midas can reuse it as-is.

## The `ImportRecord` shape

See `packages/import/src/types.ts` for the full type. At a glance:

| Field | Preserves |
|---|---|
| `externalId` | Idempotency key for logging/re-runs |
| `preserveId` | Original UUID, honored best-effort |
| `owner.{ownerType,ownerId}` | Polymorphic link back to the source record |
| `submitterEmail`, `reviewedByEmail` | Resolved to Midas users by email |
| `categoryName` | Resolved to a Midas category by name |
| `createdAt`, `updatedAt`, `reviewedAt` | Original timestamps |
| `attachments[]` | Receipt files + their OCR metadata |
| `notes[]` | Conversation history (`expense_messages`) |
| `auditHistory[]` | Audit trail (`audit_logs`); a single synthetic `expense.migrated` entry is written if the source has none |

## Running an import

```bash
# Preview without writing anything:
npm run import:run --workspace=@midas/api -- ./export.json --dry-run

# Actually import:
npm run import:run --workspace=@midas/api -- ./export.json
```

The script prints a per-record `[imported] / [skipped] / [failed]` line and a
final totals summary, and exits non-zero if any record failed.

To import from a live system instead of a static JSON file, implement
`ImportSource` against that system's own API/database and pass it to
`ImportService` in place of `JsonFileImportSource` — no other code changes
needed.

## Failure handling

- **Validation failures** (missing required fields) are reported as `failed`
  with a `reason` and never reach the database.
- **Unresolvable submitter email** fails the record — Midas requires a real
  user to own every expense (see `docs/MIGRATION_PLAN.md` for creating users
  ahead of a migration).
- **Unresolvable category name** does not fail the record — the expense is
  imported with `categoryId = null`.
- **Any other exception** (storage error, DB constraint, etc.) is caught per
  record and reported as `failed`; the run continues with the next record.
- Because idempotency is keyed on `owner`, fixing the underlying issue and
  re-running the same file is always safe.

## Extending the framework

- To import from a new source, write a new `ImportSource` — do not modify
  `ImportService` or `ImportTargetPort`.
- To preserve additional fields, extend `ImportRecord` in
  `packages/import/src/types.ts` and thread the new field through
  `ImportService` and `DrizzleImportTargetPort` together.
- `ImportTargetPort` should only ever need one implementation per Midas
  deployment (`DrizzleImportTargetPort`) — embedders reuse it rather than
  writing their own.
