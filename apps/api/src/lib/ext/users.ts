import { createHash, randomBytes } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { env } from '../../config/env';
import { db } from '../../db/index';
import { users, userEmailAliases } from '../../db/schema';
import { auditLog } from '../audit';
import { createError } from '../../middleware/error';
import { decideExtUserResolution, normalizeProvisionedUsername } from './userResolution';

/**
 * Resolve the acting Midas user for an /ext call.
 *
 * Lookup order: username -> users.email (direct) -> user_email_aliases.
 * When BOTH username and email are supplied, each is resolved independently
 * (see decideExtUserResolution) so a mismatch between the two never silently
 * picks one side — that would misattribute the expense to the wrong human.
 * At least one of username/email must be supplied.
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

  const byUsername = username
    ? (await db.query.users.findFirst({ where: sql`lower(${users.username}) = ${username}` })) ?? null
    : null;

  // Email side: direct users.email match first, then retired/alternate
  // addresses via the alias table, so a consumer sending a pre-merge email
  // resolves to the surviving account instead of failing or duplicating.
  let byEmail = email
    ? (await db.query.users.findFirst({ where: eq(users.email, email) })) ?? null
    : null;
  if (!byEmail && email) {
    const alias = await db.query.userEmailAliases.findFirst({
      where: sql`lower(${userEmailAliases.email}) = ${email}`,
    });
    if (alias) {
      byEmail = (await db.query.users.findFirst({ where: eq(users.id, alias.userId) })) ?? null;
    }
  }

  const decision = decideExtUserResolution({ byUsername, byEmail });

  if (decision.kind === 'ambiguous') {
    const [fromUsername, fromEmail] = decision.usernames;
    throw createError(
      `Submitter is ambiguous: username "${fromUsername}" and email resolve to a different Midas user `
      + `("${fromEmail}"). Fix the payload so submitterUsername and submitterEmail point to the same account.`,
      409,
      'SUBMITTER_AMBIGUOUS',
    );
  }

  if (decision.kind === 'existing') {
    const existing = decision.user;
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

  const newUsername = normalizeProvisionedUsername(username ?? email!.split('@')[0]);
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
