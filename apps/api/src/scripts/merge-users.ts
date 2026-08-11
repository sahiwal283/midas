/**
 * Merge two Midas user accounts that are the same person.
 *
 * Reassigns every reference from <from> to <to> inside one transaction, then
 * removes the now-unreferenced source row. The full list of foreign keys was
 * taken from information_schema, not memory — missing one would orphan data or
 * fail the final delete.
 *
 * Run: npx tsx src/scripts/merge-users.ts <fromUsername> <toUsername> [--dry-run]
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { users, userEmailAliases } from '../db/schema';

/** Every column that points at users.id, plus the soft manager_id reference. */
const REFERENCES: Array<{ table: string; column: string }> = [
  { table: 'audit_logs', column: 'user_id' },
  { table: 'captures', column: 'user_id' },
  { table: 'closed_periods', column: 'closed_by_id' },
  { table: 'expense_messages', column: 'sender_id' },
  { table: 'expense_messages', column: 'resolved_by_id' },
  { table: 'expenses', column: 'user_id' },
  { table: 'expenses', column: 'reviewed_by_id' },
  { table: 'notifications', column: 'user_id' },
  { table: 'partner_expenses', column: 'user_id' },
  { table: 'payment_methods', column: 'assigned_user_id' },
  { table: 'sso_links', column: 'user_id' },
  { table: 'transactions', column: 'user_id' },
  { table: 'transactions', column: 'reviewed_by_id' },
  { table: 'users', column: 'manager_id' },
];

async function main() {
  const [fromName, toName, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes('--dry-run');

  if (!fromName || !toName) {
    console.error('Usage: npx tsx src/scripts/merge-users.ts <fromUsername> <toUsername> [--dry-run]');
    process.exit(1);
  }
  if (fromName.toLowerCase() === toName.toLowerCase()) {
    console.error('Refusing to merge a user into itself.');
    process.exit(1);
  }

  const from = await db.query.users.findFirst({
    where: sql`lower(${users.username}) = ${fromName.toLowerCase()}`,
  });
  const to = await db.query.users.findFirst({
    where: sql`lower(${users.username}) = ${toName.toLowerCase()}`,
  });
  if (!from) throw new Error(`No user with username "${fromName}"`);
  if (!to) throw new Error(`No user with username "${toName}"`);

  console.log(`Merging  ${from.username} (${from.email ?? 'no email'}, ${from.name})`);
  console.log(`   into  ${to.username} (${to.email ?? 'no email'}, ${to.name})`);
  console.log(dryRun ? '\n--dry-run: nothing will be written.\n' : '');

  await db.transaction(async (tx) => {
    const moved: Record<string, number> = {};

    for (const ref of REFERENCES) {
      const countRows = await tx.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(ref.table)} WHERE ${sql.identifier(ref.column)} = ${from.id}`,
      );
      const n = Number((countRows.rows?.[0] as { n?: number } | undefined)?.n ?? 0);
      if (n === 0) continue;

      moved[`${ref.table}.${ref.column}`] = n;
      console.log(`  ${n.toString().padStart(4)} × ${ref.table}.${ref.column}`);
      if (!dryRun) {
        await tx.execute(
          sql`UPDATE ${sql.identifier(ref.table)} SET ${sql.identifier(ref.column)} = ${to.id} WHERE ${sql.identifier(ref.column)} = ${from.id}`,
        );
      }
    }

    if (Object.keys(moved).length === 0) console.log('  (no references to move)');

    if (dryRun) {
      console.log('\nDry run complete — rolling back.');
      throw new DryRunAbort();
    }

    // Preserve the source email as an alias. External systems keep sending it
    // (Trade Show posts expenses by submitterEmail), and without this the merge
    // silently breaks their submissions.
    if (from.email) {
      await tx.insert(userEmailAliases)
        .values({ userId: to.id, email: from.email, note: `merged from ${from.username}` })
        .onConflictDoNothing();
      console.log(`  kept ${from.email} as an alias of ${to.username}`);
    }

    // Audit before deleting, so the record survives the source row.
    await tx.execute(sql`
      INSERT INTO audit_logs (entity_type, entity_id, user_id, action, before, after, metadata)
      VALUES ('user', ${to.id}, ${to.id}, 'user.merged',
              ${JSON.stringify({ username: from.username, email: from.email, name: from.name })}::jsonb,
              ${JSON.stringify({ username: to.username, email: to.email, name: to.name })}::jsonb,
              ${JSON.stringify({ moved })}::jsonb)
    `);

    await tx.delete(users).where(eq(users.id, from.id));
    console.log(`\nRemoved ${from.username}; all references now point at ${to.username}.`);
  }).catch((err) => {
    if (err instanceof DryRunAbort) return;
    throw err;
  });
}

class DryRunAbort extends Error {}

main().then(() => process.exit(0)).catch((err) => {
  console.error('MERGE FAILED (rolled back):', err instanceof Error ? err.message : err);
  process.exit(1);
});
