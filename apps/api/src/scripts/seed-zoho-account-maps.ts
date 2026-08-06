/**
 * Seed Zoho Books COA account_ids onto expense_categories (Haute Brands org)
 * and set Personal card paid-through to Employee Reimbursements.
 *
 * Run: npx tsx --env-file=../../.env src/scripts/seed-zoho-account-maps.ts
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenseCategories, paymentMethods } from '../db/schema';

/** Haute Brands COA — verified via integration service chartofaccounts/list 2026-08-03 */
const CATEGORY_TO_ACCOUNT: Record<string, string> = {
  'Meals & Entertainment': '5254962000000091710', // Meals
  'Meal and Entertainment': '5254962000000091710',
  Travel: '5254962000000091704', // Sales Team Travel
  'Travel - Flight': '5254962000000091704',
  Accommodation: '5254962000000032023', // Lodging
  'Accommodation - Hotel': '5254962000000032023',
  Transportation: '5254962000001791016', // Car Ride-Uber/Lyft/Other
  'Transportation - Uber / Lyft / Others': '5254962000001791016',
  'Parking Fees': '5254962000000091848',
  'Gas / Fuel': '5254962000000091842',
  'Rental - Car / U-haul': '5254962000003010318',
  'Office Supplies': '5254962000000091498',
  'Software & Subscriptions': '5254962000000091716',
  'Marketing & Advertising': '5254962000000840009', // Booth/ Display/ Equipmet
  'Booth / Marketing / Tools': '5254962000000840009',
  'Professional Services': '5254962000000091782',
  Equipment: '5254962000000091522',
  Other: '5254962000000092006', // General Expenses
  'Shipping Charges': '5254962000000091728',
  'Show Allowances - Per Diem': '5254962000000091710', // Meals (per-diem placeholder)
};

const EMPLOYEE_REIMBURSEMENTS = '5254962000000035003';

async function main() {
  const cats = await db.select().from(expenseCategories);
  let catUpdated = 0;
  for (const cat of cats) {
    const accountId = CATEGORY_TO_ACCOUNT[cat.name];
    if (!accountId) {
      console.log(`skip category (no map): ${cat.name}`);
      continue;
    }
    if (cat.zohoAccountId === accountId) continue;
    await db.update(expenseCategories)
      .set({ zohoAccountId: accountId })
      .where(eq(expenseCategories.id, cat.id));
    console.log(`category ${cat.name} → ${accountId}`);
    catUpdated += 1;
  }

  const pms = await db.select().from(paymentMethods);
  let pmUpdated = 0;
  for (const pm of pms) {
    if (!pm.requiresReimbursement) continue;
    if (pm.zohoAccountName === EMPLOYEE_REIMBURSEMENTS) continue;
    await db.update(paymentMethods)
      .set({ zohoAccountName: EMPLOYEE_REIMBURSEMENTS, updatedAt: new Date() })
      .where(eq(paymentMethods.id, pm.id));
    console.log(`payment method ${pm.label} paid_through → Employee Reimbursements`);
    pmUpdated += 1;
  }

  console.log(JSON.stringify({ catUpdated, pmUpdated }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
