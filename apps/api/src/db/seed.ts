import { db } from './index';
import { users, expenseCategories, categoryMappings, companies } from './schema';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';

/** Categories used by Trade Show production + OCR suggestions (exact names). */
const TRADE_SHOW_CATEGORIES = [
  { name: 'Booth / Marketing / Tools', description: 'Booth materials, marketing, tools' },
  { name: 'Travel - Flight', description: 'Airfare' },
  { name: 'Accommodation - Hotel', description: 'Hotels and lodging' },
  { name: 'Transportation - Uber / Lyft / Others', description: 'Rideshare and local transport' },
  { name: 'Parking Fees', description: 'Parking' },
  { name: 'Rental - Car / U-haul', description: 'Vehicle rental' },
  { name: 'Meal and Entertainment', description: 'Meals and entertainment' },
  { name: 'Gas / Fuel', description: 'Fuel' },
  { name: 'Shipping Charges', description: 'Shipping and freight' },
  { name: 'Show Allowances - Per Diem', description: 'Per diem allowances' },
  { name: 'Travel Expenses', description: 'General travel expenses' },
  { name: 'Model', description: 'Model fees' },
  { name: 'Other', description: 'Uncategorized expenses' },
];

/** OCR / legacy suggestion → category name (sourceApp=trade_show). */
const TRADE_SHOW_OCR_MAPPINGS: Array<{ suggestion: string; categoryName: string }> = [
  { suggestion: 'Meal and Entertainment', categoryName: 'Meal and Entertainment' },
  { suggestion: 'Meals', categoryName: 'Meal and Entertainment' },
  { suggestion: 'Restaurant', categoryName: 'Meal and Entertainment' },
  { suggestion: 'Travel - Flight', categoryName: 'Travel - Flight' },
  { suggestion: 'Airfare', categoryName: 'Travel - Flight' },
  { suggestion: 'Flight', categoryName: 'Travel - Flight' },
  { suggestion: 'Accommodation - Hotel', categoryName: 'Accommodation - Hotel' },
  { suggestion: 'Hotel', categoryName: 'Accommodation - Hotel' },
  { suggestion: 'Transportation - Uber / Lyft / Others', categoryName: 'Transportation - Uber / Lyft / Others' },
  { suggestion: 'Uber', categoryName: 'Transportation - Uber / Lyft / Others' },
  { suggestion: 'Lyft', categoryName: 'Transportation - Uber / Lyft / Others' },
  { suggestion: 'Taxi', categoryName: 'Transportation - Uber / Lyft / Others' },
  { suggestion: 'Parking Fees', categoryName: 'Parking Fees' },
  { suggestion: 'Parking', categoryName: 'Parking Fees' },
  { suggestion: 'Rental - Car / U-haul', categoryName: 'Rental - Car / U-haul' },
  { suggestion: 'Car Rental', categoryName: 'Rental - Car / U-haul' },
  { suggestion: 'Gas / Fuel', categoryName: 'Gas / Fuel' },
  { suggestion: 'Fuel', categoryName: 'Gas / Fuel' },
  { suggestion: 'Booth / Marketing / Tools', categoryName: 'Booth / Marketing / Tools' },
  { suggestion: 'Shipping Charges', categoryName: 'Shipping Charges' },
  { suggestion: 'Shipping', categoryName: 'Shipping Charges' },
  { suggestion: 'Show Allowances - Per Diem', categoryName: 'Show Allowances - Per Diem' },
  { suggestion: 'Per Diem', categoryName: 'Show Allowances - Per Diem' },
  { suggestion: 'Travel Expenses', categoryName: 'Travel Expenses' },
  { suggestion: 'Model', categoryName: 'Model' },
  { suggestion: 'Other', categoryName: 'Other' },
];

async function seed() {
  console.log('Seeding database...');

  // Legacy Midas standalone categories (keep for native UI)
  const legacyCategories = [
    { name: 'Meals & Entertainment', description: 'Business meals, team lunches, client dinners' },
    { name: 'Travel', description: 'Flights, trains, long-distance transportation' },
    { name: 'Accommodation', description: 'Hotels, short-term lodging' },
    { name: 'Transportation', description: 'Taxis, rideshare, car rental, parking, fuel' },
    { name: 'Office Supplies', description: 'Stationery, printer supplies, desk accessories' },
    { name: 'Software & Subscriptions', description: 'SaaS tools, app subscriptions' },
    { name: 'Marketing & Advertising', description: 'Trade show materials, ads, promotional items' },
    { name: 'Professional Services', description: 'Consultants, legal, accounting' },
    { name: 'Equipment', description: 'Hardware, tools, non-consumable purchases' },
  ];

  for (const cat of [...legacyCategories, ...TRADE_SHOW_CATEGORIES]) {
    const existing = await db.query.expenseCategories.findFirst({
      where: eq(expenseCategories.name, cat.name),
    });
    if (!existing) {
      await db.insert(expenseCategories).values(cat);
      console.log(`  + category: ${cat.name}`);
    }
  }

  for (const mapping of TRADE_SHOW_OCR_MAPPINGS) {
    const category = await db.query.expenseCategories.findFirst({
      where: eq(expenseCategories.name, mapping.categoryName),
    });
    if (!category) continue;

    const existing = await db.query.categoryMappings.findFirst({
      where: and(
        eq(categoryMappings.sourceApp, 'trade_show'),
        eq(categoryMappings.suggestion, mapping.suggestion),
      ),
    });
    if (!existing) {
      await db.insert(categoryMappings).values({
        sourceApp: 'trade_show',
        suggestion: mapping.suggestion,
        categoryId: category.id,
      });
      console.log(`  + category_mapping: trade_show / ${mapping.suggestion}`);
    }
  }

  const defaultUsers = [
    { email: 'admin@midas.local', name: 'Admin User', role: 'admin' as const, password: 'admin123' },
    { email: 'accountant@midas.local', name: 'Accountant User', role: 'accountant' as const, password: 'accountant123' },
    { email: 'user@midas.local', name: 'Regular User', role: 'user' as const, password: 'user123' },
    { email: 'partner@midas.local', name: 'Partner User', role: 'partner' as const, password: 'partner123' },
    { email: 'developer@midas.local', name: 'Developer User', role: 'developer' as const, password: 'developer123' },
  ];

  // Demo users are bootstrap-only: they exist so a fresh local database has
  // logins. The seed runs on every container start, so on a live system a
  // per-email existence check would resurrect deliberately deleted demo
  // accounts (with published default passwords). Any user in the table means
  // this is not a fresh database — skip the block entirely.
  const anyUser = await db.query.users.findFirst({ columns: { id: true } });
  if (anyUser) {
    console.log('  ~ users exist — skipping demo user seed');
  } else {
    for (const u of defaultUsers) {
      const passwordHash = await bcrypt.hash(u.password, 12);
      await db.insert(users).values({
        username: u.email.split('@')[0],
        email: u.email,
        name: u.name,
        role: u.role,
        passwordHash,
      });
      console.log(`  + user: ${u.email} (${u.role}) — password: ${u.password}`);
    }
  }

  const defaultCompanies = [
    { name: 'Haute Brands', zohoEnabled: true, sortOrder: 1 },
    { name: 'Nirvana Kulture', zohoEnabled: true, sortOrder: 2 },
    { name: 'Boomin Brands', zohoEnabled: true, sortOrder: 3 },
    { name: 'Summitt Labs', zohoEnabled: false, sortOrder: 4 },
  ];

  for (const c of defaultCompanies) {
    const existing = await db.query.companies.findFirst({ where: eq(companies.name, c.name) });
    if (!existing) {
      await db.insert(companies).values(c);
      console.log(`  + company: ${c.name}${c.zohoEnabled ? '' : ' (Zoho disabled)'}`);
    }
  }

  console.log('Seeding complete.');
  console.log('');
  console.log('Phase 0: create sandbox app connection via Admin → Connections with scopes:');
  console.log('  expenses:create, expenses:read, expenses:update, expenses:delete,');
  console.log('  receipts:create, expenses:import, ocr:process');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
