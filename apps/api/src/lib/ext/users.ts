import { createHash, randomBytes } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { env } from '../../config/env';
import { db } from '../../db/index';
import { users, userEmailAliases } from '../../db/schema';
import { auditLog } from '../audit';
import { createError } from '../../middleware/error';

/**
 * Resolve the acting Midas user for an /ext call.
 *
 * Username is the identity key, but `email` keeps working exactly as before so
 * existing consumers (Trade Show sends `submitterEmail`) need no change. At
 * least one of the two must be supplied.
 */
export async function resolveExtUser(opts: {
  email?: string | null;
  username?: string | null;
  displayName?: string | null;
}): Promise<{ id: string; username: string; email: string | null; name: string; provisioned: boolean }> {
  const email = opts.email?.trim().toLowerCase() || null;
  const username = opts.username?.trim().toLowerCase() || null;

  if (!email && !username) {
    throw createError('submitterUsername or submitterEmail is required', 422, 'MISSING_SUBMITTER');
  }
  if (email && !email.includes('@')) {
    throw createError('Invalid submitter email', 422, 'INVALID_EMAIL');
  }

  // Username first — it is the identity key and always present on a Midas user.
  let existing = username
    ? await db.query.users.findFirst({ where: sql`lower(${users.username}) = ${username}` })
    : await db.query.users.findFirst({ where: eq(users.email, email!) });

  // Then retired/alternate addresses, so a consumer still sending a pre-merge
  // email resolves to the surviving account instead of failing or duplicating.
  if (!existing && email) {
    const alias = await db.query.userEmailAliases.findFirst({
      where: sql`lower(${userEmailAliases.email}) = ${email}`,
    });
    if (alias) {
      existing = await db.query.users.findFirst({ where: eq(users.id, alias.userId) });
    }
  }

  if (existing) {
    if (!existing.isActive) throw createError('User is inactive', 422, 'USER_INACTIVE');
    return {
      id: existing.id,
      username: existing.username,
      email: existing.email,
      name: existing.name,
      provisioned: false,
    };
  }

  const label = username ?? email;
  if (!env.EXT_AUTO_PROVISION_USERS) {
    throw createError(`No Midas user found for ${label}`, 422, 'USER_NOT_FOUND');
  }

  const newUsername = username ?? email!.split('@')[0].toLowerCase();
  const name = (opts.displayName?.trim() || newUsername || 'User').slice(0, 200);
  // Unusable local password — SSO / break-glass later
  const passwordHash = createHash('sha256').update(randomBytes(32)).digest('hex');

  const [created] = await db.insert(users).values({
    username: newUsername,
    email,
    name,
    role: 'user',
    isActive: true,
    passwordHash,
  }).returning();

  await auditLog({
    entityType: 'user',
    entityId: created.id,
    action: 'ext.user_provisioned',
    metadata: { username: created.username, email },
    after: { id: created.id, username: created.username, email: created.email, role: created.role },
  });

  return {
    id: created.id,
    username: created.username,
    email: created.email,
    name: created.name,
    provisioned: true,
  };
}
