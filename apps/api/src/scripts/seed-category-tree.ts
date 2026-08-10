/**
 * One-off: arrange existing categories into the initial tree
 * (spec: docs/superpowers/specs/2026-08-10-hierarchical-categories-design.md).
 * Idempotent, name-matched. Only parent_id values are written (plus the two new
 * parent categories). Admins can freely rearrange afterwards in Admin → Categories.
 *
 * Run: npx tsx src/scripts/seed-category-tree.ts
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenseCategories } from '../db/schema';

// parent name → child names
const TREE: Record<string, string[]> = {
  'Travel': ['Travel - Flight', 'Travel Expenses', 'Accommodation', 'Transportation'],
  'Accommodation': ['Accommodation - Hotel'],
  'Transportation': ['Transportation - Uber / Lyft / Others', 'Rental - Car / U-haul', 'Gas / Fuel', 'Parking Fees'],
  'Meals & Entertainment': ['Meal and Entertainment', 'Show Allowances - Per Diem'],
  'Show Operations': ['Booth / Marketing / Tools', 'Model', 'Shipping Charges', 'Storage charges'],
  'Office & Admin': ['Office Supplies', 'Stationaries', 'Software & Subscriptions', 'Professional Services', 'Equipment', 'Marketing & Advertising'],
};
const NEW_PARENTS = ['Show Operations', 'Office & Admin'];

async function main() {
  await db.transaction(async (tx) => {
    for (const name of NEW_PARENTS) {
      const existing = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, name) });
      if (!existing) {
        await tx.insert(expenseCategories).values({ name, isActive: true });
        console.log(`created parent: ${name}`);
      }
    }
    for (const [parentName, children] of Object.entries(TREE)) {
      const parent = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, parentName) });
      if (!parent) { console.log(`WARN parent "${parentName}" not found — skipping its children`); continue; }
      for (const childName of children) {
        const child = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, childName) });
        if (!child) { console.log(`WARN child "${childName}" not found — skipped`); continue; }
        if (child.parentId === parent.id) { console.log(`ok:       ${childName} already under ${parentName}`); continue; }
        await tx.update(expenseCategories).set({ parentId: parent.id }).where(eq(expenseCategories.id, child.id));
        console.log(`parented: ${childName} → ${parentName}`);
      }
    }
  });
  console.log('Category tree seeded.');
}

main().then(() => process.exit(0)).catch((err) => { console.error('SEED FAILED (rolled back):', err); process.exit(1); });
