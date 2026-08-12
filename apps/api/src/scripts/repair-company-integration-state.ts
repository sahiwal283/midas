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
 * `syncExpenseToTransaction` mirrors every expense into `transactions`
 * (same id), so both problems above are duplicated there too. Both updates
 * are applied to `expenses` and `transactions` identically, and reported
 * per-table so the operator can see both.
 *
 * Safe to re-run: all updates are conditional on the bad state and converge
 * to zero matching rows once applied.
 *
 * Run: npx tsx src/scripts/repair-company-integration-state.ts [--apply]
 * Without --apply it reports what it would change and exits without writing.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index';

const APPLY = process.argv.includes('--apply');

async function main() {
  const queuedExpenses = await db.execute(sql`
    SELECT e.id, e.zoho_entity, e.status
    FROM expenses e
    JOIN companies c ON c.name = e.zoho_entity
    WHERE c.zoho_enabled = false AND e.integration_status = 'pending'
  `);
  const bogusExpenses = await db.execute(sql`
    SELECT id, zoho_entity FROM expenses WHERE zoho_entity = 'undefined'
  `);
  const queuedTransactions = await db.execute(sql`
    SELECT t.id, t.zoho_entity, t.status
    FROM transactions t
    JOIN companies c ON c.name = t.zoho_entity
    WHERE c.zoho_enabled = false AND t.integration_status = 'pending'
  `);
  const bogusTransactions = await db.execute(sql`
    SELECT id, zoho_entity FROM transactions WHERE zoho_entity = 'undefined'
  `);

  console.log('expenses:');
  console.log(`  Non-Zoho company queued for push: ${queuedExpenses.rows.length}`);
  console.log(`  Literal 'undefined' company:      ${bogusExpenses.rows.length}`);
  console.log('transactions:');
  console.log(`  Non-Zoho company queued for push: ${queuedTransactions.rows.length}`);
  console.log(`  Literal 'undefined' company:      ${bogusTransactions.rows.length}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  const ea = await db.execute(sql`
    UPDATE expenses e SET integration_status = 'not_required', updated_at = now()
    FROM companies c
    WHERE c.name = e.zoho_entity AND c.zoho_enabled = false AND e.integration_status = 'pending'
  `);
  const eb = await db.execute(sql`
    UPDATE expenses SET zoho_entity = NULL, updated_at = now() WHERE zoho_entity = 'undefined'
  `);
  const ta = await db.execute(sql`
    UPDATE transactions t SET integration_status = 'not_required', updated_at = now()
    FROM companies c
    WHERE c.name = t.zoho_entity AND c.zoho_enabled = false AND t.integration_status = 'pending'
  `);
  const tb = await db.execute(sql`
    UPDATE transactions SET zoho_entity = NULL, updated_at = now() WHERE zoho_entity = 'undefined'
  `);
  console.log('\nexpenses:');
  console.log(`  Updated integration_status: ${ea.rowCount ?? 'n/a'}`);
  console.log(`  Cleared bogus company:      ${eb.rowCount ?? 'n/a'}`);
  console.log('transactions:');
  console.log(`  Updated integration_status: ${ta.rowCount ?? 'n/a'}`);
  console.log(`  Cleared bogus company:      ${tb.rowCount ?? 'n/a'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
