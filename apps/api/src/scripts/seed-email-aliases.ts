/**
 * Record the alternate addresses the three Trade Show-era people are known by,
 * so expenses posted from Trade Show (which has no SSO and sends its own
 * emails) always resolve to the right Midas user.
 *
 * Idempotent. Run: npx tsx src/scripts/seed-email-aliases.ts
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { users, userEmailAliases } from '../db/schema';

/** username → other addresses that must resolve to them. */
const ALIASES: Array<{ username: string; email: string; note: string }> = [
  // Trade Show posts Sahil's expenses as tech@…; that row was merged into sahilk.
  { username: 'sahilk', email: 'tech@cooliohcandy.com', note: 'Trade Show account (merged from sahil)' },
  // Seri signs in via Authentik as seri@haute.com but Trade Show posts as admin@…
  { username: 'seriv', email: 'seri@haute.com', note: 'Authentik account email' },
];

async function main() {
  for (const a of ALIASES) {
    const user = await db.query.users.findFirst({
      where: sql`lower(${users.username}) = ${a.username.toLowerCase()}`,
    });
    if (!user) { console.log(`WARN no user "${a.username}" — skipped ${a.email}`); continue; }

    // Never shadow a live users.email — that would make resolution ambiguous.
    const owner = await db.query.users.findFirst({ where: eq(users.email, a.email) });
    if (owner) {
      console.log(`skip:  ${a.email} is already ${owner.username}'s primary email`);
      continue;
    }

    const existing = await db.query.userEmailAliases.findFirst({
      where: sql`lower(${userEmailAliases.email}) = ${a.email.toLowerCase()}`,
    });
    if (existing) { console.log(`ok:    ${a.email} → already aliased`); continue; }

    await db.insert(userEmailAliases).values({ userId: user.id, email: a.email, note: a.note });
    console.log(`added: ${a.email} → ${user.username}`);
  }

  const rows = await db.select({
    email: userEmailAliases.email,
    username: users.username,
  }).from(userEmailAliases).innerJoin(users, eq(users.id, userEmailAliases.userId));
  console.log(`\n${rows.length} alias(es):`);
  for (const r of rows) console.log(`  ${r.email} → ${r.username}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error('FAILED:', err); process.exit(1); });
