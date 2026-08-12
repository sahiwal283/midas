/**
 * One-off, idempotent repair for two data problems found during the Trade Show
 * integration review:
 *
 *  1. Expenses on a company with zoho_enabled=false were left with
 *     integration_status='pending', queueing a Zoho push that must never
 *     happen for that company. They become 'not_required'.
 *  2. `POST /ext/expenses` did not validate the company name, so some rows
 *     hold the literal string 'undefined' as zoho_entity. Those become NULL.
 *     Rows that are legitimately NULL are untouched — the match is on the
 *     literal string only.
 *
 * Safe to re-run: both updates are conditional on the bad state and converge
 * to zero matching rows once applied.
 *
 * Run: npx tsx src/scripts/repair-company-integration-state.ts [--apply]
 * Without --apply it reports what it would change and exits without writing.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index';

const APPLY = process.argv.includes('--apply');

async function main() {
  const queued = await db.execute(sql`
    SELECT e.id, e.zoho_entity, e.status
    FROM expenses e
    JOIN companies c ON c.name = e.zoho_entity
    WHERE c.zoho_enabled = false AND e.integration_status = 'pending'
  `);
  const bogus = await db.execute(sql`
    SELECT id, zoho_entity FROM expenses WHERE zoho_entity = 'undefined'
  `);

  console.log(`Non-Zoho company queued for push: ${queued.rows.length}`);
  console.log(`Literal 'undefined' company:      ${bogus.rows.length}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  const a = await db.execute(sql`
    UPDATE expenses e SET integration_status = 'not_required', updated_at = now()
    FROM companies c
    WHERE c.name = e.zoho_entity AND c.zoho_enabled = false AND e.integration_status = 'pending'
  `);
  const b = await db.execute(sql`
    UPDATE expenses SET zoho_entity = NULL, updated_at = now() WHERE zoho_entity = 'undefined'
  `);
  console.log(`\nUpdated integration_status: ${a.rowCount ?? 'n/a'}`);
  console.log(`Cleared bogus company:      ${b.rowCount ?? 'n/a'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
