/**
 * Scope the trade_show connection to the exact category vocabulary that app
 * already had (its own app_settings.categoryOptions), so it never inherits
 * Midas-only categories such as the tree parents.
 *
 * Idempotent and name-matched. Leaves-only: no parent categories, because the
 * Trade Show picker is a flat dropdown.
 *
 * Run: npx tsx src/scripts/seed-trade-show-vocabulary.ts
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index';
import { appConnections, appConnectionCategories, expenseCategories } from '../db/schema';

const APP_NAME = 'trade_show';

/** Verbatim from Trade Show's app_settings.categoryOptions (15 entries). */
const VOCABULARY = [
  'Booth / Marketing / Tools',
  'Travel - Flight',
  'Accommodation - Hotel',
  'Transportation - Uber / Lyft / Others',
  'Parking Fees',
  'Rental - Car / U-haul',
  'Meal and Entertainment',
  'Gas / Fuel',
  'Show Allowances - Per Diem',
  'Model',
  'Shipping Charges',
  'Other',
  'Stationaries',
  'Storage charges',
  'Travel Expenses',
];

async function main() {
  const conn = await db.query.appConnections.findFirst({
    where: eq(appConnections.appName, APP_NAME),
  });
  if (!conn) throw new Error(`No app connection named "${APP_NAME}"`);

  let added = 0;
  let already = 0;
  const missing: string[] = [];

  await db.transaction(async (tx) => {
    for (const name of VOCABULARY) {
      const cat = await tx.query.expenseCategories.findFirst({
        where: eq(expenseCategories.name, name),
      });
      if (!cat) { missing.push(name); continue; }

      const existing = await tx.query.appConnectionCategories.findFirst({
        where: and(
          eq(appConnectionCategories.connectionId, conn.id),
          eq(appConnectionCategories.categoryId, cat.id),
        ),
      });
      if (existing) { already++; console.log(`ok:    ${name}`); continue; }

      await tx.insert(appConnectionCategories).values({ connectionId: conn.id, categoryId: cat.id });
      added++;
      console.log(`added: ${name}`);
    }
  });

  console.log(`\n${APP_NAME}: ${added} added, ${already} already present, ${VOCABULARY.length} total in vocabulary`);
  if (missing.length) console.log(`WARN missing categories in Midas: ${missing.join(', ')}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error('SEED FAILED (rolled back):', err); process.exit(1); });
