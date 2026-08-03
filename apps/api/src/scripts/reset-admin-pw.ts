// One-shot admin password reset for recovery situations.
// Usage: ADMIN_PASSWORD=<newpassword> npx tsx src/scripts/reset-admin-pw.ts
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';

if (!process.env.ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD env var is required.');
  console.error('Usage: ADMIN_PASSWORD=<newpassword> npx tsx src/scripts/reset-admin-pw.ts');
  process.exit(1);
}
const NEW_PASSWORD: string = process.env.ADMIN_PASSWORD;

async function run() {
  const hash = await bcrypt.hash(NEW_PASSWORD, 12);
  const result = await db
    .update(users)
    .set({ passwordHash: hash, isActive: true })
    .where(eq(users.email, 'admin@midas.local'))
    .returning({ id: users.id, email: users.email });

  if (!result.length) {
    console.error('No admin@midas.local user found — run db:seed first.');
    process.exit(1);
  }

  console.log(`\nAdmin password reset:`);
  console.log(`  email:    admin@midas.local`);
  console.log(`  password: ${NEW_PASSWORD}`);
  console.log(`\nThe account was also re-activated (isActive=true).\n`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
