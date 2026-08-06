/**
 * Upsert Trade Show payment cards into Midas and backfill expense.paymentMethodId.
 *
 * Usage (API container):
 *   npx tsx src/scripts/sync-trade-show-payment-methods.ts
 *   npx tsx src/scripts/sync-trade-show-payment-methods.ts --dry-run
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, paymentMethods } from '../db/schema';
import {
  TRADE_SHOW_CARD_OPTIONS,
  inferCardBrand,
  parseCardUsedLastFour,
} from '../lib/tradeShowPaymentMethods';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`Sync Trade Show payment methods (${dryRun ? 'DRY RUN' : 'APPLY'})`);
  console.log(`Catalog size: ${TRADE_SHOW_CARD_OPTIONS.length}`);

  const byLastFour = new Map<string, string>(); // lastFour → paymentMethodId

  for (const card of TRADE_SHOW_CARD_OPTIONS) {
    const label = card.name.trim();
    const lastFour = card.lastFour;
    const brand = inferCardBrand(label);
    const zohoAccountName = card.zohoPaymentAccountId;
    const defaultZohoEntity = card.entity;
    const requiresReimbursement = card.requiresReimbursement === true;

    const existing = await db.query.paymentMethods.findFirst({
      where: and(eq(paymentMethods.lastFour, lastFour), eq(paymentMethods.isActive, true)),
    });

    if (existing) {
      console.log(`  ~ update ${label} (...${lastFour}) id=${existing.id}`);
      if (!dryRun) {
        const [updated] = await db.update(paymentMethods)
          .set({
            label,
            brand,
            zohoAccountName,
            defaultZohoEntity,
            requiresReimbursement,
            isCompanyWide: true,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(paymentMethods.id, existing.id))
          .returning();
        byLastFour.set(lastFour, updated.id);
      } else {
        byLastFour.set(lastFour, existing.id);
      }
      continue;
    }

    console.log(`  + create ${label} (...${lastFour})`);
    if (!dryRun) {
      const [created] = await db.insert(paymentMethods).values({
        label,
        lastFour,
        brand,
        zohoAccountName,
        defaultZohoEntity,
        requiresReimbursement,
        isCompanyWide: true,
        isActive: true,
      }).returning();
      byLastFour.set(lastFour, created.id);
    }
  }

  // Backfill trade_show expenses missing paymentMethodId
  const rows = await db.query.expenses.findMany({
    where: and(eq(expenses.sourceApp, 'trade_show'), isNull(expenses.paymentMethodId)),
    columns: { id: true, zohoEntity: true, sourceContext: true },
  });

  let linked = 0;
  let entityFilled = 0;
  let unmatched = 0;

  for (const row of rows) {
    const cardUsed = typeof row.sourceContext?.cardUsed === 'string'
      ? row.sourceContext.cardUsed
      : null;
    const lastFour = parseCardUsedLastFour(cardUsed);
    const pmId = lastFour ? byLastFour.get(lastFour) : undefined;
    if (!pmId) {
      unmatched += 1;
      if (cardUsed) console.log(`  ! unmatched cardUsed=${JSON.stringify(cardUsed)} expense=${row.id}`);
      continue;
    }

    const card = TRADE_SHOW_CARD_OPTIONS.find((c) => c.lastFour === lastFour);
    const patch: { paymentMethodId: string; zohoEntity?: string; updatedAt: Date } = {
      paymentMethodId: pmId,
      updatedAt: new Date(),
    };
    if (!row.zohoEntity && card?.entity) {
      patch.zohoEntity = card.entity;
      entityFilled += 1;
    }

    linked += 1;
    if (!dryRun) {
      await db.update(expenses).set(patch).where(eq(expenses.id, row.id));
    }
  }

  const active = await db.query.paymentMethods.findMany({
    where: eq(paymentMethods.isActive, true),
    columns: {
      label: true,
      lastFour: true,
      defaultZohoEntity: true,
      zohoAccountName: true,
    },
    orderBy: [asc(paymentMethods.label), asc(paymentMethods.lastFour)],
  });

  console.log('');
  console.log(`Expenses linked: ${linked} (entity filled: ${entityFilled}, unmatched: ${unmatched})`);
  console.log(`Active payment methods after sync: ${active.length}`);
  console.log(JSON.stringify(active, null, 2));
  console.log(dryRun ? 'DRY RUN complete — no writes.' : 'APPLY complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
