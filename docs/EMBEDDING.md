# Embedding Midas in Another Application

Midas is the canonical Expense Engine: a standalone platform that other
internal apps (Trade Show App, Argo, Milo, ...) embed rather than reimplement.
This document describes the two supported embedding strategies, what's
exposed as reusable modules, and the extension points available to an
embedder — without any Trade-Show-specific (or any other embedder-specific)
logic living inside Midas itself.

See also: `docs/architecture.md` (overall system design),
`docs/OCR_ENGINE.md` (OCR subsystem), `docs/SYNC_AND_OFFLINE.md` (**sync-primary
+ offline To upload safety net** — read this before assuming Midas is async),
`docs/IMPORT_FRAMEWORK.md` (bulk import),
`docs/MIGRATION_PLAN.md` (the concrete trade-show-app → Midas field mapping),
`docs/CONTRACT_ALIGNMENT.md` + `docs/EXT_API_MERGE_LOCK.md` (Trade Show Ext
cutover — implement only when alignment COMPLETE on both sides).

---

## Two embedding strategies

### Strategy A — Service delegation (recommended default)

The embedding app runs its own UI/logic and delegates all expense/OCR/receipt
work to a standalone Midas deployment over HTTP, using the existing
app-to-app API:

```
POST   /api/v1/ext/expenses        Create an expense (bearer API key)
GET    /api/v1/ext/expenses/:id    Read an expense back
```

- The embedding app never touches OCR, storage, or the Postgres schema
  directly — Midas does the work and is the single source of truth.
- Every expense created this way carries `ownerType`/`ownerId`
  (`sourceApp`/`sourceRefId` on the wire — see "Polymorphic ownership" below)
  so it can be traced back to the record that created it, without Midas
  knowing anything about that record's domain.
- Setup: an admin issues an API key via `POST /api/v1/admin/connections`
  (`{ appName, permissions }` → returns the plaintext key once). The embedding
  app stores it server-side and sends `Authorization: Bearer <key>`.
- Users still interact with the standalone Midas web UI
  (`docs/architecture.md#frontend`) for review, reimbursement, and messaging
  — the embedding app can deep-link to `/expenses/:id` using `sourceUrl`.

This is the lowest-friction option and is what Midas's app-to-app API was
designed for. Use it unless the embedding app needs OCR results or expense
state *before* an expense exists in Midas (e.g. inline receipt preview during
data entry).

### Strategy B — Full module embed (npm packages)

The embedding app's own backend depends on Midas's packages directly and runs
its own copy of the OCR engine container, without going through the network
API:

| Package | What it provides |
|---|---|
| `@midas/shared` | `OwnerRef`/`toOwnerRef`/`fromOwnerRef` and other cross-cutting types (`packages/shared`) |
| `@midas/ocr-client` | The full OCR client — preprocessing, HTTP adapter, rule-based inference (`packages/ocr-client`, see `docs/OCR_ENGINE.md`) |
| `@midas/import` | Generic import pipeline framework (`packages/import`, see `docs/IMPORT_FRAMEWORK.md`) |

Plus the `services/ocr-engine` Python container, run as a sibling service.

This strategy is for an application that wants Midas's engine internals
in-process rather than as a remote API call — e.g. it needs OCR results
synchronously as part of its own request flow, or it doesn't want a network
hop to a separate Midas deployment at all. It requires the embedding app to
run its own Postgres schema compatible with `apps/api/src/db/schema.ts` (or
its own `ImportTargetPort`-equivalent persistence layer).

**Current scope:** `@midas/shared`, `@midas/ocr-client`, and `@midas/import`
are published as workspace packages today and are usable standalone by any
Node/TypeScript app in this monorepo (or via `npm pack`/a private registry
outside it). The API routes (`apps/api`) and web UI (`apps/web`) are not yet
factored into standalone importable packages — an app that wants Midas's
*full* HTTP surface and UI embedded in-process, rather than proxied to a
sibling deployment, would need that additional extraction. Until then,
**Strategy A (service delegation) is the supported path for reusing Midas's
API and UI**, and Strategy B is for reusing the OCR/import engine internals
only.

---

## What "no Trade-Show-specific logic" means in practice

Grep-verified: no file under `apps/`, `packages/`, or `services/` references
`trade_show`, `TradeShow`, or any other embedder name as a literal value.
Every place that used to assume "the caller is Trade Show App" now goes
through one of:

- **`ownerType`/`ownerId`** (`sourceApp`/`sourceRefId` columns) — an opaque
  pair chosen by the caller. Midas never special-cases any value.
- **`categoryKeywords`** (OCR) — injectable, defaults to a domain-agnostic
  keyword set (`DEFAULT_CATEGORY_KEYWORDS`).
- **`ImportSource`** (bulk import) — embedder-authored, framework-agnostic.

## Polymorphic ownership (`OwnerRef`)

```ts
import { toOwnerRef, fromOwnerRef, type OwnerRef } from '@midas/shared';

const owner: OwnerRef = { ownerType: 'trade_show', ownerId: 'booth-42-expense-9' };
// -> { sourceApp: 'trade_show', sourceRefId: 'booth-42-expense-9' } on the wire/DB
```

`ownerType` is an opaque string the caller defines — Midas imposes no
enum or fixed set of values. See `packages/shared/src/types/index.ts` for the
full rationale and `docs/architecture.md` for how it maps onto the `expenses`
table (including the `expenses_source_unique_idx` uniqueness guarantee used
for import idempotency).

## Extension points summary

| Concern | Extension point | Default |
|---|---|---|
| OCR category taxonomy | `ServiceOcrAdapter({ categoryKeywords })` | `DEFAULT_CATEGORY_KEYWORDS` (generic) |
| OCR provider | `services/ocr-engine/.env` `PRIMARY_OCR_PROVIDER`/`FALLBACK_OCR_PROVIDER` | `rapidocr`/`tesseract` (free, local) |
| Bulk data import | Implement `ImportSource` (`@midas/import`) | `JsonFileImportSource` example |
| Owning entity | `ownerType`/`ownerId` on every expense | `null` (direct Midas entry) |
| File storage | `STORAGE_MODE=local\|s3` (`apps/api/src/lib/storage.ts`) | `local` |
| Zoho sync | `ZOHO_MODE=mock\|service` (`apps/api/src/lib/zoho.ts`) | `mock` |

## Migration helpers

- **Bulk/one-time migration:** `@midas/import` + `DrizzleImportTargetPort` +
  `npm run import:run` — see `docs/IMPORT_FRAMEWORK.md`.
- **Field mapping reference:** `docs/MIGRATION_PLAN.md` documents the
  specific old-system → Midas field mapping used for the trade-show-app
  cutover; reuse its structure (status/reimbursement enum tables, migration
  order, duplicate-prevention notes) as a template for mapping any other
  source system into `ImportRecord`s.
- **App connection provisioning:** `POST /api/v1/admin/connections` (admin
  role required) issues a Bearer API key for Strategy A. There is currently
  no CLI wrapper for this — it's a single authenticated API call from an
  admin session or `curl`.

## What's deliberately NOT provided

- A generic multi-tenant schema (separate Postgres schema/row per embedder).
  Midas assumes one deployment per organization, with multiple owning
  applications distinguished by `ownerType`, not by tenant isolation.
- Automatic two-way sync back to the embedding app. Import is one-directional
  (external system → Midas) and Strategy A's `/api/v1/ext/` API is
  create/read only — Midas does not push status changes back to embedders.
  An embedder that needs notifications should poll `GET /api/v1/ext/expenses/:id`
  or watch for the expense's `sourceUrl` deep link to be visited.
