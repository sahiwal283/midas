/**
 * One-off runner for the Zoho COA → category import (same logic as
 * POST /admin/categories/sync-zoho). Usage:
 *   npx tsx src/scripts/sync-zoho-categories.ts
 */
import { syncCategoriesFromZoho } from '../lib/categorySyncDb';

async function main() {
  const summary = await syncCategoriesFromZoho(null);
  for (const s of summary) {
    const status = s.error ? `ERROR: ${s.error}` : `${s.accounts} accounts, created ${s.created.length}, mapped ${s.mapped}`;
    console.log(`${s.company} [${s.brand ?? 'no brand'}]: ${status}`);
    if (s.created.length) console.log(`  new: ${s.created.join(', ')}`);
  }
  process.exit(0);
}

void main();
