import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env';
import { db } from '../../db/index';
import { users } from '../../db/schema';
import { auditLog } from '../audit';
import { createError } from '../../middleware/error';

export async function resolveExtUser(opts: {
  email: string;
  displayName?: string | null;
}): Promise<{ id: string; email: string; name: string; provisioned: boolean }> {
  const email = opts.email.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw createError('Invalid submitter email', 422, 'INVALID_EMAIL');
  }

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    if (!existing.isActive) throw createError('User is inactive', 422, 'USER_INACTIVE');
    return { id: existing.id, email: existing.email, name: existing.name, provisioned: false };
  }

  if (!env.EXT_AUTO_PROVISION_USERS) {
    throw createError(`No Midas user found for email ${email}`, 422, 'USER_NOT_FOUND');
  }

  const name = (opts.displayName?.trim() || email.split('@')[0] || 'User').slice(0, 200);
  // Unusable local password — SSO / break-glass later
  const passwordHash = createHash('sha256').update(randomBytes(32)).digest('hex');

  const [created] = await db.insert(users).values({
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
    metadata: { email },
    after: { id: created.id, email: created.email, role: created.role },
  });

  return { id: created.id, email: created.email, name: created.name, provisioned: true };
}
