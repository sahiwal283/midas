/**
 * One-off Trade Show → Midas reconciliation (spec: docs/superpowers/specs/2026-08-10-tradeshow-data-sync-design.md).
 * Reads a snapshot JSON exported read-only from the Trade Show DB and, in ONE transaction:
 *   1. Fixes user names/roles (match by email) and creates missing users (no password — SSO/invite).
 *   2. Ensures categories exist; fills category_zoho_accounts from Trade Show's per-entity ids.
 *   3. Inserts missing expenses + receipt rows (idempotent on (source_app, source_ref_id)).
 * Prints every change; ends with the Haute discrepancy report for accountant review.
 *
 * Run (prod, inside api container): npx tsx src/scripts/sync-tradeshow-data.ts src/scripts/data/tradeshow-sync-2026-08-10.json
 */
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import {
  users, expenseCategories, categoryZohoAccounts, expenses, receipts, paymentMethods, auditLogs,
} from '../db/schema';
import { env } from '../config/env';
import { mapTradeShowRole, cleanZohoAccountId, ENTITY_COMPANY_MAP } from '../lib/tradeshowSync';

interface SnapshotUser { email: string; name: string; role: string }
interface SnapshotCategory { name: string; zohoExpenseAccountIds: Record<string, string | null> | null }
interface SnapshotReceipt { filename: string; storagePath: string; mimeType: string; sizeBytes: number; sha256: string }
interface SnapshotExpense {
  sourceRefId: string; userEmail: string; externalUserId: string; categoryName: string;
  merchant: string; amount: string; date: string; description: string | null;
  cardUsed: string; paymentMethodLastFour: string; paymentMethodLabel: string;
  status: 'pending' | 'approved'; zohoEntity: string; location: string | null;
  eventId: string; eventName: string; submittedAt: string; createdAt: string;
  receipt: SnapshotReceipt | null;
}
interface Snapshot { users: SnapshotUser[]; categoryOptions: SnapshotCategory[]; expenses: SnapshotExpense[] }

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  console.error('Usage: npx tsx src/scripts/sync-tradeshow-data.ts <snapshot.json>');
  process.exit(1);
}
const snapshot: Snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));

async function main() {
  // Receipt files must already be in the uploads volume — verify before opening the transaction.
  for (const exp of snapshot.expenses) {
    if (exp.receipt) {
      const p = path.join(env.UPLOADS_DIR, exp.receipt.storagePath);
      const s = await stat(p).catch(() => null);
      if (!s) throw new Error(`Receipt file missing: ${p} — stage it in the uploads volume first`);
      if (s.size !== exp.receipt.sizeBytes) {
        throw new Error(`Receipt size mismatch for ${p}: disk=${s.size} snapshot=${exp.receipt.sizeBytes}`);
      }
    }
  }

  const actor = await db.query.users.findFirst({ where: eq(users.email, 'admin@midas.local') });

  await db.transaction(async (tx) => {
    const audit = async (entityType: string, entityId: string, action: string, extra: {
      before?: unknown; after?: unknown; metadata?: Record<string, unknown>;
    }) => {
      await tx.insert(auditLogs).values({
        entityType,
        entityId,
        userId: actor?.id ?? null,
        action,
        before: extra.before ?? null,
        after: extra.after ?? null,
        metadata: extra.metadata ?? null,
      });
    };

    // ── 1. Users ─────────────────────────────────────────────────────────────
    for (const tsUser of snapshot.users) {
      const role = mapTradeShowRole(tsUser.role);
      const existing = await tx.query.users.findFirst({ where: eq(users.email, tsUser.email) });
      if (existing) {
        if (existing.name === tsUser.name && existing.role === role) {
          console.log(`user ok:      ${tsUser.email} (${tsUser.name}, ${role})`);
          continue;
        }
        await tx.update(users)
          .set({ name: tsUser.name, role, updatedAt: new Date() })
          .where(eq(users.id, existing.id));
        console.log(`user updated: ${tsUser.email}  name "${existing.name}" → "${tsUser.name}", role ${existing.role} → ${role}`);
        await audit('user', existing.id, 'sync.tradeshow.user_updated', {
          before: { name: existing.name, role: existing.role },
          after: { name: tsUser.name, role },
        });
      } else {
        const [created] = await tx.insert(users).values({
          username: tsUser.email.split('@')[0].toLowerCase(),
          email: tsUser.email,
          name: tsUser.name,
          role,
          passwordHash: null,
          isActive: true,
        }).returning();
        console.log(`user created: ${tsUser.email} (${tsUser.name}, ${role}) — no password, SSO/invite login`);
        await audit('user', created.id, 'sync.tradeshow.user_created', {
          after: { email: tsUser.email, name: tsUser.name, role },
        });
      }
    }

    // ── 2. Categories + per-entity Zoho ids ──────────────────────────────────
    const discrepancies: { category: string; tsHauteId: string; midasLegacyId: string }[] = [];
    for (const cat of snapshot.categoryOptions) {
      let row = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, cat.name) });
      if (!row) {
        [row] = await tx.insert(expenseCategories).values({ name: cat.name, isActive: true }).returning();
        console.log(`category created: ${cat.name}`);
        await audit('expense_category', row.id, 'sync.tradeshow.category_created', {
          after: { name: cat.name },
        });
      }
      if (!cat.zohoExpenseAccountIds) continue;
      for (const [slug, rawId] of Object.entries(cat.zohoExpenseAccountIds)) {
        if (!rawId) continue;
        const companyName = ENTITY_COMPANY_MAP[slug];
        if (!companyName) throw new Error(`Unknown entity slug "${slug}" on category "${cat.name}"`);
        const accountId = cleanZohoAccountId(rawId);
        if (!accountId) { console.log(`WARN no numeric id in "${rawId}" (${cat.name}/${slug}) — skipped`); continue; }
        if (accountId !== rawId) console.log(`cleaned id:   ${cat.name}/${slug} "${rawId}" → ${accountId}`);
        await tx.insert(categoryZohoAccounts)
          .values({ categoryId: row.id, companyName, zohoAccountId: accountId })
          .onConflictDoUpdate({
            target: [categoryZohoAccounts.categoryId, categoryZohoAccounts.companyName],
            set: { zohoAccountId: accountId },
          });
        console.log(`zoho map:     ${cat.name} × ${companyName} → ${accountId}`);
        if (slug === 'haute_brands' && row.zohoAccountId && row.zohoAccountId !== accountId) {
          discrepancies.push({ category: cat.name, tsHauteId: accountId, midasLegacyId: row.zohoAccountId });
        }
      }
    }

    // ── 3. Missing expenses ──────────────────────────────────────────────────
    for (const exp of snapshot.expenses) {
      const dupe = await tx.query.expenses.findFirst({
        where: and(eq(expenses.sourceApp, 'trade_show'), eq(expenses.sourceRefId, exp.sourceRefId)),
      });
      if (dupe) { console.log(`expense ok:   ${exp.merchant} ${exp.amount} already imported`); continue; }

      const user = await tx.query.users.findFirst({ where: eq(users.email, exp.userEmail) });
      if (!user) throw new Error(`No Midas user for ${exp.userEmail}`);
      const category = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, exp.categoryName) });
      if (!category) throw new Error(`No Midas category named "${exp.categoryName}"`);
      const pms = await tx.select().from(paymentMethods).where(eq(paymentMethods.lastFour, exp.paymentMethodLastFour));
      const pm = pms.find((m) => m.label === exp.paymentMethodLabel) ?? pms[0] ?? null;
      if (!pm) console.log(`WARN no payment method ...${exp.paymentMethodLastFour} — inserting without one`);

      const [inserted] = await tx.insert(expenses).values({
        userId: user.id,
        categoryId: category.id,
        paymentMethodId: pm?.id ?? null,
        sourceApp: 'trade_show',
        sourceRefId: exp.sourceRefId,
        sourceType: 'trade_show_event',
        sourceLabel: exp.eventName,
        sourceContext: {
          eventId: exp.eventId, cardUsed: exp.cardUsed, location: exp.location,
          eventName: exp.eventName, submittedAt: exp.submittedAt, externalUserId: exp.externalUserId,
        },
        externalUserId: exp.externalUserId,
        merchant: exp.merchant,
        amount: exp.amount,
        currency: 'USD',
        date: exp.date,
        description: exp.description,
        status: exp.status,
        integrationStatus: 'pending',
        reimbursementStatus: 'not_requested',
        zohoEntity: exp.zohoEntity,
        createdAt: new Date(exp.createdAt),
      }).returning();
      console.log(`expense created: ${exp.merchant} $${exp.amount} (${exp.userEmail}, ${exp.status})`);
      await audit('expense', inserted.id, 'sync.tradeshow.expense_imported', {
        metadata: { sourceRefId: exp.sourceRefId },
      });

      if (exp.receipt) {
        await tx.insert(receipts).values({
          expenseId: inserted.id,
          filename: exp.receipt.filename,
          mimeType: exp.receipt.mimeType,
          sizeBytes: exp.receipt.sizeBytes,
          storagePath: exp.receipt.storagePath,
          sha256: exp.receipt.sha256,
          ocrStatus: 'done',
        });
        console.log(`  receipt:     ${exp.receipt.filename}`);
      }
    }

    // ── Haute discrepancy report ─────────────────────────────────────────────
    console.log('\n=== HAUTE ZOHO ACCOUNT DISCREPANCIES (for accountant review) ===');
    if (discrepancies.length === 0) console.log('none');
    for (const d of discrepancies) {
      console.log(`${d.category}: trade show → ${d.tsHauteId}  |  midas legacy column → ${d.midasLegacyId}`);
    }
    console.log('Per-entity table now holds trade show ids; legacy column left untouched (fallback only).');
  });

  console.log('\nSync committed.');
}

main().then(() => process.exit(0)).catch((err) => { console.error('SYNC FAILED (rolled back):', err); process.exit(1); });
