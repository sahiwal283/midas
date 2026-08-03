// Generic import pipeline runner — imports expenses from a JSON export into Midas.
//
// Usage:
//   npx tsx src/scripts/run-import.ts <path-to-records.json> [--dry-run]
//
// The JSON file must contain an array of ImportRecord objects (see
// packages/import/src/types.ts and docs/IMPORT_FRAMEWORK.md). To import from a
// live external system instead of a static file, implement `ImportSource`
// (see src/lib/import/jsonFileSource.ts for the simplest possible example)
// and swap it in below.
import { ImportService } from '@midas/import';
import { DrizzleImportTargetPort } from '../lib/import/drizzleImportTarget';
import { JsonFileImportSource } from '../lib/import/jsonFileSource';
import { pool } from '../db/index';

const filePath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!filePath) {
  console.error('Usage: npx tsx src/scripts/run-import.ts <path-to-records.json> [--dry-run]');
  process.exit(1);
}

async function run() {
  const source = new JsonFileImportSource(filePath);
  const target = new DrizzleImportTargetPort();
  const service = new ImportService(target);

  console.log(`Importing from ${filePath}${dryRun ? ' (dry run)' : ''}...`);
  const report = await service.run(source, { dryRun });

  console.log(`\nSource: ${report.sourceName}`);
  console.log(`Totals: ${report.totals.imported} imported, ${report.totals.skipped} skipped, ${report.totals.failed} failed`);

  for (const result of report.results) {
    if (result.status === 'imported') {
      console.log(`  [imported] ${result.externalId} -> ${result.midasExpenseId}`);
    } else if (result.status === 'skipped') {
      console.log(`  [skipped]  ${result.externalId} (${result.reason})`);
    } else {
      console.log(`  [failed]   ${result.externalId}: ${result.error ?? result.reason}`);
    }
  }

  if (report.totals.failed > 0) process.exitCode = 1;
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
