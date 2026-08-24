/**
 * Create or rotate an Ext API app connection with Trade Show B4 scopes.
 *
 * Usage (from repo root, with env loaded):
 *   npm run ext:create-connection --workspace=@midas/api -- trade_show
 */
import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { appConnections } from '../db/schema';

const TRADE_SHOW_SCOPES = [
  'expenses:create',
  'expenses:read',
  'expenses:update',
  'expenses:delete',
  'receipts:create',
  'expenses:import',
  'ocr:process',
  'messages:read',
  'messages:write',
];

async function main() {
  const appName = process.argv[2] || 'trade_show';
  const apiKey = `midas_${randomBytes(32).toString('hex')}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  const existing = await db.query.appConnections.findFirst({
    where: eq(appConnections.appName, appName),
  });

  if (existing) {
    await db.update(appConnections).set({
      apiKeyHash,
      permissions: TRADE_SHOW_SCOPES,
      isActive: true,
    }).where(eq(appConnections.id, existing.id));
    console.log(`Rotated connection: ${appName} (${existing.id})`);
  } else {
    const [conn] = await db.insert(appConnections).values({
      appName,
      apiKeyHash,
      permissions: TRADE_SHOW_SCOPES,
      isActive: true,
    }).returning({ id: appConnections.id });
    console.log(`Created connection: ${appName} (${conn.id})`);
  }

  console.log('Scopes:', TRADE_SHOW_SCOPES.join(', '));
  console.log('');
  console.log('API key (shown once — store in Trade Show MIDAS_API_KEY):');
  console.log(apiKey);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
