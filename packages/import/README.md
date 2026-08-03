# @midas/import

Generic import pipeline framework for bringing expense data from an external
system into Midas. Used both for one-time migrations (e.g. cutting a legacy
app over to Midas as its expense engine) and for ongoing bulk imports.

See `docs/IMPORT_FRAMEWORK.md` for the full design writeup. This README is a
quick reference for the package itself.

## What this package owns

- **`ImportRecord`** — the canonical, embedder-agnostic shape every source must
  produce: owner reference, submitter, merchant/amount/date, category, status,
  attachments, notes, and audit history.
- **`ImportSource`** — the interface an embedder implements per external
  system (`fetchRecords(): AsyncIterable<ImportRecord>`).
- **`ImportTargetPort`** — the interface Midas implements once against its own
  storage (Drizzle/Postgres) so this package never depends on an ORM.
- **`ImportService`** — orchestrates a run: validates records, skips ones
  already imported (idempotent by `owner`), creates the expense, then attaches
  receipts/notes/audit history, and returns an `ImportReport`.

## What this package does NOT own

- How to read from any *specific* external system (CSV, another database,
  another app's REST API). That is always the embedder's `ImportSource`.
- How Midas persists data. That is `apps/api/src/lib/import/drizzleImportTarget.ts`
  (Midas's own `ImportTargetPort` implementation, built on Drizzle).

## Usage

```ts
import { ImportService, type ImportSource, type ImportRecord } from '@midas/import';
import { DrizzleImportTargetPort } from '../lib/import/drizzleImportTarget';

const source: ImportSource = {
  name: 'legacy-app-v3',
  async *fetchRecords(): AsyncIterable<ImportRecord> {
    // yield one ImportRecord per external expense
  },
};

const service = new ImportService(new DrizzleImportTargetPort());
const report = await service.run(source, { dryRun: true });
console.log(report.totals);
```

Midas ships a ready-to-use file-based source and CLI runner —
see `apps/api/src/scripts/run-import.ts`:

```bash
npm run import:run --workspace=@midas/api -- ./my-export.json --dry-run
npm run import:run --workspace=@midas/api -- ./my-export.json
```

## Idempotency

Re-running an import is always safe. `ImportService` calls
`findExistingByOwner(record.owner)` before creating anything; if an expense
already exists for that `(ownerType, ownerId)` pair, the record is skipped
(never updated). Midas's own port backs this with the
`expenses_source_unique_idx` unique index on `(source_app, source_ref_id)`.
