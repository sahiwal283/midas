import { db } from './index';
import { users, expenseCategories } from './schema';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

async function seed() {
  console.log('Seeding database...');

  // Default categories
  const categories = [
    { name: 'Meals & Entertainment', description: 'Business meals, team lunches, client dinners' },
    { name: 'Travel', description: 'Flights, trains, long-distance transportation' },
    { name: 'Accommodation', description: 'Hotels, short-term lodging' },
    { name: 'Transportation', description: 'Taxis, rideshare, car rental, parking, fuel' },
    { name: 'Office Supplies', description: 'Stationery, printer supplies, desk accessories' },
    { name: 'Software & Subscriptions', description: 'SaaS tools, app subscriptions' },
    { name: 'Marketing & Advertising', description: 'Trade show materials, ads, promotional items' },
    { name: 'Professional Services', description: 'Consultants, legal, accounting' },
    { name: 'Equipment', description: 'Hardware, tools, non-consumable purchases' },
    { name: 'Other', description: 'Uncategorized expenses' },
  ];

  for (const cat of categories) {
    const existing = await db.query.expenseCategories.findFirst({
      where: eq(expenseCategories.name, cat.name),
    });
    if (!existing) {
      await db.insert(expenseCategories).values(cat);
      console.log(`  + category: ${cat.name}`);
    }
  }

  // Default users — passwords MUST be changed in production
  const defaultUsers = [
    { email: 'admin@midas.local', name: 'Admin User', role: 'admin' as const, password: 'admin123' },
    { email: 'accountant@midas.local', name: 'Accountant User', role: 'accountant' as const, password: 'accountant123' },
    { email: 'user@midas.local', name: 'Regular User', role: 'user' as const, password: 'user123' },
  ];

  for (const u of defaultUsers) {
    const existing = await db.query.users.findFirst({ where: eq(users.email, u.email) });
    if (!existing) {
      const passwordHash = await bcrypt.hash(u.password, 12);
      await db.insert(users).values({ email: u.email, name: u.name, role: u.role, passwordHash });
      console.log(`  + user: ${u.email} (${u.role}) — password: ${u.password}`);
    }
  }

  console.log('Seeding complete.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
