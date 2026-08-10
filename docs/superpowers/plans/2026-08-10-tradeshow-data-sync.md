# Trade Show → Midas Data Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the incomplete Trade Show → Midas migration: correct user names/roles, create 3 missing users, import 2 missing expenses with receipts, and store Trade Show's per-entity category→Zoho-account IDs in a new table used by Zoho push.

**Architecture:** One Drizzle migration adds `category_zoho_accounts` (category × company → Zoho account id); `zohoPush.ts` resolves it between the per-expense COA pick and the legacy single-column fallback. A one-off idempotent script (`apps/api/src/scripts/sync-tradeshow-data.ts`) reads a committed JSON snapshot (exported read-only from the Trade Show DB) and applies all data fixes to Midas in a single transaction. Trade show DB is never written.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Vitest, tsx. Prod: Proxmox host `root@192.168.1.190`; Midas app CT 3120 (`/opt/midas`, Docker Compose), Midas DB CT 3220, Trade Show backend CT 2220 (files at `/var/lib/expenseapp/uploads`), Trade Show DB CT 2320 (`expense_app_production`).

## Global Constraints

- Trade show DB (CT 2320) and backend (CT 2220) are READ-ONLY throughout — export/copy only, never write.
- All Midas data changes happen inside one DB transaction in the sync script.
- Trade show values are copied verbatim (including "BRETT  POMMERENCK" double space, trailing spaces in descriptions).
- Role map: `developer→developer`, `admin→admin`, `accountant→accountant`, `salesperson→user`, `coordinator→user`.
- The $1.00 test expense (TS id owned by tech@cooliohcandy.com, 2026-05-19) is intentionally NOT imported.
- Legacy `expense_categories.zoho_account_id` values are NOT modified.
- Version bump: 0.29.0-alpha → 0.30.0-alpha in `apps/api/package.json` and `apps/web/package.json`.
- Commits end with the standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session` trailer.

---

### Task 1: `category_zoho_accounts` schema + migration 0017

**Files:**
- Modify: `apps/api/src/db/schema.ts` (add table after `companies`, ~line 110)
- Create: `apps/api/drizzle/0017_category_zoho_accounts.sql`

**Interfaces:**
- Produces: Drizzle table export `categoryZohoAccounts` with columns `id, categoryId, companyName, zohoAccountId, createdAt`. Tasks 2 and 3 import it from `../db/schema`.

- [ ] **Step 1: Add table to schema.ts** (after the `companies`/`budgets` block, before `expenses`):

```ts
// ── Per-company Zoho COA account per category ─────────────────────────────────
// Trade Show parity: each category maps to a different Zoho Books expense
// account per sister company (expenses.zoho_entity stores the company NAME).

export const categoryZohoAccounts = pgTable('category_zoho_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').references(() => expenseCategories.id, { onDelete: 'cascade' }).notNull(),
  companyName: text('company_name').references(() => companies.name, { onDelete: 'restrict', onUpdate: 'cascade' }).notNull(),
  zohoAccountId: text('zoho_account_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('category_zoho_accounts_cat_company_idx').on(t.categoryId, t.companyName),
]);
```

- [ ] **Step 2: Write migration SQL** `apps/api/drizzle/0017_category_zoho_accounts.sql` (match 0015's additive style):

```sql
-- 0017: Per-company Zoho COA account per category (Trade Show parity, additive)

CREATE TABLE IF NOT EXISTS category_zoho_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES expense_categories(id) ON DELETE CASCADE,
  company_name text NOT NULL REFERENCES companies(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  zoho_account_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS category_zoho_accounts_cat_company_idx
  ON category_zoho_accounts (category_id, company_name);
```

Check `apps/api/drizzle/meta/_journal.json` — if journal entries exist for 0014–0016, add a matching 0017 entry; if prior hand-written migrations aren't journaled, leave it alone (mirror whatever 0016 did).

- [ ] **Step 3: Type-check**

Run: `cd apps/api && npm run lint`
Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/0017_category_zoho_accounts.sql
git commit -m "feat(db): category_zoho_accounts — per-company Zoho COA account per category"
```

---

### Task 2: Zoho push resolves per-entity account (TDD)

**Files:**
- Create: `apps/api/src/lib/categoryZohoAccounts.ts`
- Modify: `apps/api/src/lib/zohoPayload.ts` (PayloadExpense + `buildZohoServicePayload` accountId resolution, ~lines 47–81)
- Modify: `apps/api/src/lib/zohoPush.ts` (`pushExpenseToZoho`, ~line 53)
- Test: `apps/api/src/__tests__/zohoPayloadEntityAccounts.test.ts`

**Interfaces:**
- Consumes: `categoryZohoAccounts` table from Task 1.
- Produces: `PayloadExpense.categoryEntityAccountId?: string | null`; `resolveCategoryEntityAccountId(categoryId: string | null, zohoEntity: string | null): Promise<string | null>`.

- [ ] **Step 1: Write failing tests** `apps/api/src/__tests__/zohoPayloadEntityAccounts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildZohoServicePayload, type PayloadExpense } from '../lib/zohoPayload';

const base: PayloadExpense = {
  id: 'e1',
  merchant: 'Southwest Airlines',
  amount: '305.80',
  currency: 'USD',
  date: '2026-07-31',
  description: null,
  categoryId: 'cat1',
  paymentMethodId: 'pm1',
  zohoEntity: 'Nirvana Kulture',
  reimbursementStatus: 'not_requested',
  userId: 'u1',
  category: { name: 'Travel - Flight', zohoAccountId: 'legacy-fallback-id' },
  paymentMethod: { label: 'Nirvana PNC', zohoAccountName: '1234567890123' },
};

describe('per-entity Zoho account resolution', () => {
  it('uses categoryEntityAccountId when no per-expense COA pick exists', () => {
    const p = buildZohoServicePayload({ ...base, categoryEntityAccountId: 'entity-id-1' });
    expect(p.account_id).toBe('entity-id-1');
  });

  it('per-expense COA pick still wins over the entity mapping', () => {
    const p = buildZohoServicePayload({
      ...base,
      zohoExpenseAccountId: 'live-pick-id',
      categoryEntityAccountId: 'entity-id-1',
    });
    expect(p.account_id).toBe('live-pick-id');
  });

  it('falls back to legacy category.zohoAccountId when no entity mapping', () => {
    const p = buildZohoServicePayload({ ...base, categoryEntityAccountId: null });
    expect(p.account_id).toBe('legacy-fallback-id');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/__tests__/zohoPayloadEntityAccounts.test.ts`
Expected: FAIL — test 1 gets `legacy-fallback-id` instead of `entity-id-1` (`categoryEntityAccountId` is an unknown property, TS error or ignored).

- [ ] **Step 3: Implement resolution order** in `zohoPayload.ts`:

Add to `PayloadExpense` (after `zohoExpenseAccountName`):
```ts
  /** category_zoho_accounts lookup for (category, zoho_entity) — resolved by caller. */
  categoryEntityAccountId?: string | null;
```

Change the accountId resolution in `buildZohoServicePayload`:
```ts
  // Resolution order: live per-expense COA pick → per-entity category map → legacy single-column map.
  const accountId =
    expense.zohoExpenseAccountId?.trim()
    || expense.categoryEntityAccountId?.trim()
    || expense.category?.zohoAccountId?.trim()
    || null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/__tests__/zohoPayloadEntityAccounts.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Create the DB lookup helper** `apps/api/src/lib/categoryZohoAccounts.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { categoryZohoAccounts } from '../db/schema';

/**
 * Zoho COA account for (category, company). expenses.zoho_entity stores the
 * company NAME (companies.name), which is what company_name references.
 */
export async function resolveCategoryEntityAccountId(
  categoryId: string | null,
  zohoEntity: string | null,
): Promise<string | null> {
  if (!categoryId || !zohoEntity) return null;
  const [row] = await db
    .select({ zohoAccountId: categoryZohoAccounts.zohoAccountId })
    .from(categoryZohoAccounts)
    .where(and(
      eq(categoryZohoAccounts.categoryId, categoryId),
      eq(categoryZohoAccounts.companyName, zohoEntity),
    ))
    .limit(1);
  return row?.zohoAccountId ?? null;
}
```

- [ ] **Step 6: Wire into `zohoPush.ts`** — replace line 53 (`const payload = buildZohoServicePayload(expense);`) with:

```ts
  const categoryEntityAccountId = await resolveCategoryEntityAccountId(expense.categoryId, expense.zohoEntity);
  const payload = buildZohoServicePayload({ ...expense, categoryEntityAccountId });
```

and add the import: `import { resolveCategoryEntityAccountId } from './categoryZohoAccounts';`

- [ ] **Step 7: Full test suite + lint**

Run: `cd apps/api && npm run test && npm run lint`
Expected: all pass (307+ tests), clean lint.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/zohoPayload.ts apps/api/src/lib/zohoPush.ts apps/api/src/lib/categoryZohoAccounts.ts apps/api/src/__tests__/zohoPayloadEntityAccounts.test.ts
git commit -m "feat(zoho): resolve per-entity category Zoho account on push"
```

---

### Task 3: Pure sync helpers (TDD)

**Files:**
- Create: `apps/api/src/lib/tradeshowSync.ts`
- Test: `apps/api/src/__tests__/tradeshowSync.test.ts`

**Interfaces:**
- Produces (consumed by Task 4's script):
  - `mapTradeShowRole(tsRole: string): 'user' | 'accountant' | 'admin' | 'partner' | 'developer'`
  - `cleanZohoAccountId(raw: string): string | null`
  - `ENTITY_COMPANY_MAP: Record<string, string>`

- [ ] **Step 1: Write failing tests** `apps/api/src/__tests__/tradeshowSync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapTradeShowRole, cleanZohoAccountId, ENTITY_COMPANY_MAP } from '../lib/tradeshowSync';

describe('mapTradeShowRole', () => {
  it('maps 1:1 roles through', () => {
    expect(mapTradeShowRole('developer')).toBe('developer');
    expect(mapTradeShowRole('admin')).toBe('admin');
    expect(mapTradeShowRole('accountant')).toBe('accountant');
  });
  it('maps salesperson and coordinator to user (user decision 2026-08-10)', () => {
    expect(mapTradeShowRole('salesperson')).toBe('user');
    expect(mapTradeShowRole('coordinator')).toBe('user');
  });
  it('throws on unknown roles rather than guessing', () => {
    expect(() => mapTradeShowRole('pending')).toThrow();
    expect(() => mapTradeShowRole('temporary')).toThrow();
  });
});

describe('cleanZohoAccountId', () => {
  it('passes clean numeric ids through', () => {
    expect(cleanZohoAccountId('5254962000000091172')).toBe('5254962000000091172');
  });
  it('extracts the numeric id from polluted "Haute: 525..." values', () => {
    expect(cleanZohoAccountId('Haute: 5254962000000000460')).toBe('5254962000000000460');
    expect(cleanZohoAccountId('Boomin: 4849689000000000442')).toBe('4849689000000000442');
  });
  it('returns null when no long numeric id is present', () => {
    expect(cleanZohoAccountId('n/a')).toBeNull();
    expect(cleanZohoAccountId('')).toBeNull();
  });
});

describe('ENTITY_COMPANY_MAP', () => {
  it('maps trade show entity slugs to Midas company names', () => {
    expect(ENTITY_COMPANY_MAP.haute_brands).toBe('Haute Brands');
    expect(ENTITY_COMPANY_MAP.boomin_brands).toBe('Boomin Brands');
    expect(ENTITY_COMPANY_MAP.nirvana_kulture).toBe('Nirvana Kulture');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/__tests__/tradeshowSync.test.ts`
Expected: FAIL — module `../lib/tradeshowSync` not found.

- [ ] **Step 3: Implement** `apps/api/src/lib/tradeshowSync.ts`:

```ts
// Pure helpers for the one-off Trade Show → Midas reconciliation
// (scripts/sync-tradeshow-data.ts). Kept separate so they're unit-testable.

const ROLE_MAP: Record<string, 'user' | 'accountant' | 'admin' | 'partner' | 'developer'> = {
  developer: 'developer',
  admin: 'admin',
  accountant: 'accountant',
  // User decision 2026-08-10: no Midas equivalent — both become standard users.
  salesperson: 'user',
  coordinator: 'user',
};

export function mapTradeShowRole(tsRole: string): 'user' | 'accountant' | 'admin' | 'partner' | 'developer' {
  const mapped = ROLE_MAP[tsRole];
  if (!mapped) throw new Error(`No Midas role mapping for trade show role "${tsRole}"`);
  return mapped;
}

/** Trade show "Storage charges" ids are polluted ("Haute: 525..."). Extract the numeric id. */
export function cleanZohoAccountId(raw: string): string | null {
  const match = raw.match(/\d{10,}/);
  return match ? match[0] : null;
}

export const ENTITY_COMPANY_MAP: Record<string, string> = {
  haute_brands: 'Haute Brands',
  boomin_brands: 'Boomin Brands',
  nirvana_kulture: 'Nirvana Kulture',
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/__tests__/tradeshowSync.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/tradeshowSync.ts apps/api/src/__tests__/tradeshowSync.test.ts
git commit -m "feat(sync): trade show role/zoho-id mapping helpers"
```

---

### Task 4: Snapshot JSON + sync script

**Files:**
- Create: `apps/api/src/scripts/data/tradeshow-sync-2026-08-10.json`
- Create: `apps/api/src/scripts/sync-tradeshow-data.ts`

**Interfaces:**
- Consumes: `categoryZohoAccounts` (Task 1), `mapTradeShowRole` / `cleanZohoAccountId` / `ENTITY_COMPANY_MAP` (Task 3).
- Produces: runnable script `npx tsx src/scripts/sync-tradeshow-data.ts <snapshot.json>`; exits non-zero on any failure (transaction rolls back).

- [ ] **Step 1: Build the snapshot JSON.** Regenerate values fresh from the trade show DB (read-only) rather than trusting this document; the queries and expected shape:

```bash
# users (all 11): ssh root@192.168.1.190 "pct exec 2320 -- su - postgres -c \
#   \"psql -d expense_app_production -Atc 'select json_agg(json_build_object(
#      $$email$$, email, $$name$$, name, $$role$$, role)) from users'\""
# categoryOptions: select value from app_settings where key='categoryOptions'
# 2 missing expenses by id, with event names (see spec §5):
#   b663598e-d28e-4e85-922d-790d78c3c4e8 (Southwest 305.80)
#   270052c5-c829-46ae-be09-5a6810aeda2e (SAHARA 454.12)
```

Snapshot shape (values below verified against prod on 2026-08-10 — regenerate and diff; investigate any mismatch before proceeding):

```json
{
  "users": [
    { "email": "admin@company.com", "name": "Admin", "role": "developer" },
    { "email": "nabeelvira@gmail.com", "name": "Nabeel Vira", "role": "developer" },
    { "email": "tech@cooliohcandy.com", "name": "Sahil Khatri", "role": "developer" },
    { "email": "admin@cooliohcandy.com", "name": "Seri Vira", "role": "salesperson" },
    { "email": "rita@cooliohcandy.com", "name": "Rita Dubb", "role": "coordinator" },
    { "email": "salesguru@summittlabs.com", "name": "BRETT  POMMERENCK", "role": "salesperson" },
    { "email": "accounting@nirvanakulture.com", "name": "Digi", "role": "admin" },
    { "email": "sales@nirvanakulture.com", "name": "Shruti Patel", "role": "salesperson" },
    { "email": "sameer@summittlabs.com", "name": "Sameer", "role": "admin" },
    { "email": "zeeshanv@gmail.com", "name": "Zeeshan Vira", "role": "admin" },
    { "email": "doubledspecialtyfoodservices@gmail.com", "name": "Darla Davis", "role": "salesperson" }
  ],
  "categoryOptions": [ /* verbatim app_settings.categoryOptions array (15 entries) */ ],
  "expenses": [
    {
      "sourceRefId": "b663598e-d28e-4e85-922d-790d78c3c4e8",
      "userEmail": "sales@nirvanakulture.com",
      "externalUserId": "58736b1f-67aa-4178-82b5-324e7b988d20",
      "categoryName": "Travel - Flight",
      "merchant": "Southwest Airlines",
      "amount": "305.80",
      "date": "2026-07-31",
      "description": "Brenda flight ",
      "cardUsed": "Nirvana PNC (...4171)",
      "paymentMethodLastFour": "4171",
      "paymentMethodLabel": "Nirvana PNC",
      "status": "approved",
      "zohoEntity": "Nirvana Kulture",
      "location": "Las Vegas\r\nCO",
      "eventId": "02745bfe-0903-419f-af68-4c2a9bba2954",
      "eventName": "NACs 2026",
      "submittedAt": "2026-07-31T19:59:28.897Z",
      "createdAt": "2026-07-31T19:59:28.897Z",
      "receipt": {
        "filename": "1785527968893-990509128.jpeg",
        "storagePath": "<epoch-at-export>-1785527968893-990509128.jpeg",
        "mimeType": "image/jpeg",
        "sizeBytes": 233300,
        "sha256": "<computed at export>"
      }
    },
    {
      "sourceRefId": "270052c5-c829-46ae-be09-5a6810aeda2e",
      "userEmail": "nabeelvira@gmail.com",
      "externalUserId": "14a8b40f-561d-4103-9588-d42e9fed0e43",
      "categoryName": "Accommodation - Hotel",
      "merchant": "SAHARA Las Vegas, Las Vegas",
      "amount": "454.12",
      "date": "2026-06-24",
      "description": "BRETT  POMMERENCK - hotel",
      "cardUsed": "Brett Summitt Card  (...1039)",
      "paymentMethodLastFour": "1039",
      "paymentMethodLabel": "Brett Summitt Card",
      "status": "pending",
      "zohoEntity": "Summitt Labs",
      "location": null,
      "eventId": "3a179e5b-8d2a-4f60-92e9-335ea57324bc",
      "eventName": "Champs Summer LV 2026",
      "submittedAt": "2026-07-31T20:31:29.004Z",
      "createdAt": "2026-07-31T20:31:29.004Z",
      "receipt": {
        "filename": "receipt-1785529872424-917981024.pdf",
        "storagePath": "<epoch-at-export>-receipt-1785529872424-917981024.pdf",
        "mimeType": "application/pdf",
        "sizeBytes": 642745,
        "sha256": "<computed at export>"
      }
    }
  ]
}
```

Compute sha256 with `shasum -a 256` on files copied locally from CT 2220 `/var/lib/expenseapp/uploads/` (read-only `scp` via the proxmox host). Pick `storagePath` as `<Date.now() at export>-<original filename>` (mirrors how the 374 existing receipts were named, e.g. `1785779705932-1769528645507-971144024.png`).

- [ ] **Step 2: Write the sync script** `apps/api/src/scripts/sync-tradeshow-data.ts`:

```ts
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
import { and, eq, inArray } from 'drizzle-orm';
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
    const audit = (entityType: string, entityId: string, action: string, metadata: unknown) =>
      tx.insert(auditLogs).values({
        entityType, entityId, userId: actor?.id ?? null, action,
        metadata: metadata as Record<string, unknown>,
      });

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
          email: tsUser.email, name: tsUser.name, role, passwordHash: null, isActive: true,
        }).returning();
        console.log(`user created: ${tsUser.email} (${tsUser.name}, ${role}) — no password, SSO/invite login`);
        await audit('user', created.id, 'sync.tradeshow.user_created', { email: tsUser.email, name: tsUser.name, role });
      }
    }

    // ── 2. Categories + per-entity Zoho ids ──────────────────────────────────
    const discrepancies: { category: string; tsHauteId: string; midasLegacyId: string }[] = [];
    for (const cat of snapshot.categoryOptions) {
      let row = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, cat.name) });
      if (!row) {
        [row] = await tx.insert(expenseCategories).values({ name: cat.name, isActive: true }).returning();
        console.log(`category created: ${cat.name}`);
        await audit('expense_category', row.id, 'sync.tradeshow.category_created', { name: cat.name });
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
      await audit('expense', inserted.id, 'sync.tradeshow.expense_imported', { sourceRefId: exp.sourceRefId });

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
```

Adjust to the actual `auditLogs` insert shape (check `apps/api/src/lib/audit.ts` — if `auditLog()` works standalone with a `tx`, prefer it; otherwise the direct insert above, matching the columns in `schema.ts`).

- [ ] **Step 3: Type-check + full tests**

Run: `cd apps/api && npm run lint && npm run test`
Expected: clean.

- [ ] **Step 4: Local rehearsal (optional but recommended).** With local Docker dev running (`docker compose -f docker-compose.yml -f docker-compose.local.yml up`), the script will create all 11 users and both categories against the seeded DB; expenses may warn about missing payment methods. Verify it commits and prints sensibly, then `npm run db:reset` to restore the seed. Skip if local stack isn't running.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scripts/sync-tradeshow-data.ts apps/api/src/scripts/data/tradeshow-sync-2026-08-10.json
git commit -m "feat(sync): trade show reconciliation script + prod snapshot"
```

---

### Task 5: Version bump + deploy + prod run

**Files:**
- Modify: `apps/api/package.json:3`, `apps/web/package.json:3` (0.29.0-alpha → 0.30.0-alpha)

- [ ] **Step 1: Bump versions, commit, push**

```bash
sed -i '' 's/"version": "0.29.0-alpha"/"version": "0.30.0-alpha"/' apps/api/package.json apps/web/package.json
git add apps/api/package.json apps/web/package.json
git commit -m "chore: bump version to 0.30.0-alpha"
git push
```

- [ ] **Step 2: Stage the 2 receipt files into the prod uploads volume** (names = snapshot `storagePath` values):

```bash
# pull read-only from trade show backend, push into midas uploads volume
ssh root@192.168.1.190 "pct pull 2220 /var/lib/expenseapp/uploads/1785527968893-990509128.jpeg /tmp/r1.jpeg \
  && pct pull 2220 /var/lib/expenseapp/uploads/receipt-1785529872424-917981024.pdf /tmp/r2.pdf \
  && pct push 3120 /tmp/r1.jpeg /var/lib/docker/volumes/midas_uploads/_data/<storagePath-1> \
  && pct push 3120 /tmp/r2.pdf /var/lib/docker/volumes/midas_uploads/_data/<storagePath-2> \
  && rm /tmp/r1.jpeg /tmp/r2.pdf"
# verify sizes: 233300 and 642745 bytes
ssh root@192.168.1.190 "pct exec 3120 -- ls -la /var/lib/docker/volumes/midas_uploads/_data/ | tail -5"
```

(`<storagePath-1/2>` = the exact `storagePath` strings written into the snapshot JSON in Task 4.)

- [ ] **Step 3: Deploy to prod (CT 3120)**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && git pull && docker compose build api web && docker compose up -d'"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose exec -T api npm run db:migrate'"
# health check
ssh root@192.168.1.190 "pct exec 3120 -- curl -s http://localhost:4000/api/v1/health"
```

Expected: migration applies 0017; health endpoint returns ok with version 0.30.0-alpha. If `db:migrate` errors on journal bookkeeping for the hand-written file, apply the SQL directly (precedent: `scripts/apply-0014.sh`) and note it.

- [ ] **Step 4: Run the sync script in prod**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose exec -T api npx tsx src/scripts/sync-tradeshow-data.ts src/scripts/data/tradeshow-sync-2026-08-10.json'"
```

Expected output: 8 `user updated`, 3 `user created`, 2 `category created` (Stationaries, Storage charges), ~23 `zoho map` lines, 2 `expense created` with receipts, discrepancy report (7 rows), `Sync committed.`

- [ ] **Step 5: Commit any fixups made during deploy**

---

### Task 6: Verification

- [ ] **Step 1: Users match trade show** — run against CT 3220:

```sql
select email, name, role from users
where email in ('admin@company.com','nabeelvira@gmail.com','tech@cooliohcandy.com',
'admin@cooliohcandy.com','rita@cooliohcandy.com','salesguru@summittlabs.com',
'accounting@nirvanakulture.com','sales@nirvanakulture.com','sameer@summittlabs.com',
'zeeshanv@gmail.com','doubledspecialtyfoodservices@gmail.com') order by email;
```

Expected: 11 rows; names verbatim from trade show; roles per the map (developer×3, admin×3, user×5). `tech@cooliohcandy.com` still `is_active=false`.

- [ ] **Step 2: Expense counts and field parity** — re-run the CSV export + python diff from the investigation (both DBs → compare by `source_ref_id`): expect 376 Midas `trade_show` rows, 1 remaining "missing" (the $1 test, intentional), and only the 5 known accepted mismatches (3 zoho_entity, 1 zoho_expense_id, 1 status).

- [ ] **Step 3: Zoho id table** —

```sql
select c.name, cza.company_name, cza.zoho_account_id
from category_zoho_accounts cza join expense_categories c on c.id = cza.category_id
order by c.name, cza.company_name;
```

Expected: ~23 rows matching trade show's `categoryOptions` non-null ids (cleaned numerics for Storage charges).

- [ ] **Step 4: Receipts** — both new expenses have a `receipts` row; `GET /uploads/<storagePath>` serves the files (spot-check via the web UI or curl with an authed session).

- [ ] **Step 5: Report to user** — final message includes: counts of users updated/created, expenses imported, zoho map rows, and the full 7-row Haute discrepancy table for the accountant.
