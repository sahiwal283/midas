# Hierarchical Expense Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parent/child expense categories of arbitrary depth: cascading picker in the New Expense form (replacing the live Zoho COA dropdown), tree editing in Admin, ancestry-inherited Zoho mapping, descendant-aware filters and reports.

**Architecture:** One nullable `parent_id` self-FK on `expense_categories` (adjacency list). All tree logic lives in pure, unit-tested helpers (`apps/api/src/lib/categoryTree.ts` for API, `apps/web/src/lib/categoryTree.ts` for web) that operate on `{id, parentId, isActive}` arrays — DB code and components stay thin. Zoho account resolution walks the ancestry: per-entity table first (whole chain), then legacy column (whole chain); per-expense live pick still wins.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Vitest, React + TanStack Query, Tailwind. Prod deploy: file-push to CT 3120 per `docs/OPERATIONS.md` (tsx/Vite hot reload; api container runs `db:push --force` on restart).

## Global Constraints

- Drill rule: selecting at ANY level is valid; child selects are optional refinement labeled "— refine (optional) —".
- Effective activity: a category appears in pickers only if it AND every ancestor is active.
- Resolution order per expense: live pick (`zohoExpenseAccountId`) → per-entity table (ancestry walk) → legacy `zoho_account_id` column (ancestry walk) → null.
- Cycle prevention on re-parent: API returns 400; self-parenting is a cycle.
- Existing expense→category references are never modified; the seed only sets `parent_id` values.
- Version bump: 0.30.0-alpha → 0.31.0-alpha in `apps/api/package.json` and `apps/web/package.json`.
- Commits end with the standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session` trailer.

---

### Task 1: Schema — `parent_id` + migration 0018

**Files:**
- Modify: `apps/api/src/db/schema.ts` (expenseCategories, ~line 68)
- Create: `apps/api/drizzle/0018_category_parent.sql`

**Interfaces:**
- Produces: `expenseCategories.parentId: uuid | null` (drizzle `AnyPgColumn` self-reference).

- [ ] **Step 1: Add column.** Drizzle self-references need a typed lambda. Add the import `type AnyPgColumn` to the existing `drizzle-orm/pg-core` import at the top of `schema.ts`, then in `expenseCategories`:

```ts
export const expenseCategories = pgTable('expense_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').unique().notNull(),
  description: text('description'),
  /** Zoho Books expense (COA) account_id for create_books. */
  zohoAccountId: text('zoho_account_id'),
  /** Tree: null = top-level. Arbitrary depth; cycles rejected at the API layer. */
  parentId: uuid('parent_id').references((): AnyPgColumn => expenseCategories.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

- [ ] **Step 2: Migration SQL** `apps/api/drizzle/0018_category_parent.sql`:

```sql
-- 0018: Hierarchical categories — parent_id self-reference (additive)

ALTER TABLE expense_categories
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES expense_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS expense_categories_parent_idx ON expense_categories (parent_id);
```

- [ ] **Step 3: Lint** — Run: `cd apps/api && npm run lint` — expect clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/0018_category_parent.sql
git commit -m "feat(db): expense_categories.parent_id — hierarchical categories"
```

---

### Task 2: Pure tree helpers (TDD)

**Files:**
- Create: `apps/api/src/lib/categoryTree.ts`
- Test: `apps/api/src/__tests__/categoryTree.test.ts`

**Interfaces:**
- Produces (all pure; `CategoryNode = { id: string; parentId: string | null; isActive: boolean }`):
  - `wouldCreateCycle(nodes: CategoryNode[], id: string, newParentId: string | null): boolean`
  - `descendantIds(nodes: CategoryNode[], rootId: string): string[]` — includes rootId
  - `effectivelyActiveIds(nodes: CategoryNode[]): Set<string>` — active self AND all ancestors active
  - `topLevelAncestorId(nodes: CategoryNode[], id: string): string`
  - `ancestryChain(nodes: CategoryNode[], id: string): string[]` — `[id, parent, …, root]`
  All walks are guarded against malformed cycles in data (stop after `nodes.length` hops).

- [ ] **Step 1: Write failing tests** `apps/api/src/__tests__/categoryTree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  wouldCreateCycle, descendantIds, effectivelyActiveIds, topLevelAncestorId, ancestryChain,
  type CategoryNode,
} from '../lib/categoryTree';

// travel > transportation > uber ; travel > flight ; other (top)
const nodes: CategoryNode[] = [
  { id: 'travel', parentId: null, isActive: true },
  { id: 'transportation', parentId: 'travel', isActive: true },
  { id: 'uber', parentId: 'transportation', isActive: true },
  { id: 'flight', parentId: 'travel', isActive: true },
  { id: 'other', parentId: null, isActive: true },
];

describe('wouldCreateCycle', () => {
  it('rejects self-parenting', () => {
    expect(wouldCreateCycle(nodes, 'travel', 'travel')).toBe(true);
  });
  it('rejects parenting under own descendant', () => {
    expect(wouldCreateCycle(nodes, 'travel', 'uber')).toBe(true);
  });
  it('allows normal re-parent and detach', () => {
    expect(wouldCreateCycle(nodes, 'flight', 'transportation')).toBe(false);
    expect(wouldCreateCycle(nodes, 'uber', null)).toBe(false);
  });
});

describe('descendantIds', () => {
  it('returns node + all descendants', () => {
    expect(descendantIds(nodes, 'travel').sort()).toEqual(['flight', 'transportation', 'travel', 'uber']);
    expect(descendantIds(nodes, 'uber')).toEqual(['uber']);
  });
});

describe('effectivelyActiveIds', () => {
  it('hides the whole subtree when an ancestor is inactive', () => {
    const dimmed = nodes.map((n) => (n.id === 'transportation' ? { ...n, isActive: false } : n));
    const act = effectivelyActiveIds(dimmed);
    expect(act.has('travel')).toBe(true);
    expect(act.has('flight')).toBe(true);
    expect(act.has('transportation')).toBe(false);
    expect(act.has('uber')).toBe(false);
  });
});

describe('topLevelAncestorId / ancestryChain', () => {
  it('walks to the root', () => {
    expect(topLevelAncestorId(nodes, 'uber')).toBe('travel');
    expect(topLevelAncestorId(nodes, 'other')).toBe('other');
    expect(ancestryChain(nodes, 'uber')).toEqual(['uber', 'transportation', 'travel']);
  });
  it('survives malformed cyclic data without hanging', () => {
    const bad: CategoryNode[] = [
      { id: 'a', parentId: 'b', isActive: true },
      { id: 'b', parentId: 'a', isActive: true },
    ];
    expect(() => topLevelAncestorId(bad, 'a')).not.toThrow();
    expect(ancestryChain(bad, 'a').length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/__tests__/categoryTree.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `apps/api/src/lib/categoryTree.ts`:

```ts
// Pure tree helpers for hierarchical expense categories (adjacency list).
// All functions take a flat node array — no DB access — so they are trivially testable.

export interface CategoryNode {
  id: string;
  parentId: string | null;
  isActive: boolean;
}

function byId(nodes: CategoryNode[]): Map<string, CategoryNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** [id, parent, …, root]. Bounded by nodes.length so malformed cycles cannot hang. */
export function ancestryChain(nodes: CategoryNode[], id: string): string[] {
  const map = byId(nodes);
  const chain: string[] = [];
  let cur: string | null = id;
  while (cur && map.has(cur) && chain.length < nodes.length) {
    if (chain.includes(cur)) break;
    chain.push(cur);
    cur = map.get(cur)!.parentId;
  }
  return chain;
}

export function topLevelAncestorId(nodes: CategoryNode[], id: string): string {
  const chain = ancestryChain(nodes, id);
  return chain[chain.length - 1] ?? id;
}

/** True if setting `id`.parentId = newParentId would create a cycle (self-parent included). */
export function wouldCreateCycle(nodes: CategoryNode[], id: string, newParentId: string | null): boolean {
  if (!newParentId) return false;
  if (newParentId === id) return true;
  return ancestryChain(nodes, newParentId).includes(id);
}

/** rootId plus every descendant, breadth-first. */
export function descendantIds(nodes: CategoryNode[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    childrenOf.set(n.parentId, [...(childrenOf.get(n.parentId) ?? []), n.id]);
  }
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length && out.length <= nodes.length) {
    const cur = queue.shift()!;
    if (out.includes(cur)) continue;
    out.push(cur);
    queue.push(...(childrenOf.get(cur) ?? []));
  }
  return out;
}

/** Ids active in themselves AND in every ancestor. */
export function effectivelyActiveIds(nodes: CategoryNode[]): Set<string> {
  const map = byId(nodes);
  const active = new Set<string>();
  for (const n of nodes) {
    const chain = ancestryChain(nodes, n.id);
    if (chain.every((id) => map.get(id)?.isActive)) active.add(n.id);
  }
  return active;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/__tests__/categoryTree.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/categoryTree.ts apps/api/src/__tests__/categoryTree.test.ts
git commit -m "feat(api): pure tree helpers for hierarchical categories"
```

---

### Task 3: Zoho resolution walks the ancestry

**Files:**
- Modify: `apps/api/src/lib/categoryZohoAccounts.ts` (rewrite the lookup)
- Modify: `apps/api/src/lib/zohoPush.ts:53-54` (call site comment only — signature unchanged)

**Interfaces:**
- Consumes: `ancestryChain` from Task 2.
- Produces: `resolveCategoryEntityAccountId(categoryId, zohoEntity)` — same signature, now: per-entity row for the first ancestor (self first) that has one for this company; if the whole chain has none, first ancestor's legacy `zoho_account_id`. Returns `null` only when nothing in the chain maps. (`zohoPush` then passes it as `categoryEntityAccountId`; the payload's own `category.zohoAccountId` fallback becomes a no-op safety net.)

- [ ] **Step 1: Rewrite** `apps/api/src/lib/categoryZohoAccounts.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import { categoryZohoAccounts, expenseCategories } from '../db/schema';
import { ancestryChain } from './categoryTree';

/**
 * Zoho COA account for (category, company), inheriting up the category tree.
 * Order: per-entity rows for self → ancestors; then legacy zoho_account_id for
 * self → ancestors. expenses.zoho_entity stores the company NAME (companies.name).
 */
export async function resolveCategoryEntityAccountId(
  categoryId: string | null,
  zohoEntity: string | null,
): Promise<string | null> {
  if (!categoryId || !zohoEntity) return null;

  const cats = await db.select({
    id: expenseCategories.id,
    parentId: expenseCategories.parentId,
    isActive: expenseCategories.isActive,
    zohoAccountId: expenseCategories.zohoAccountId,
  }).from(expenseCategories);

  const chain = ancestryChain(cats, categoryId);
  if (chain.length === 0) return null;

  const rows = await db.select({
    categoryId: categoryZohoAccounts.categoryId,
    zohoAccountId: categoryZohoAccounts.zohoAccountId,
  }).from(categoryZohoAccounts)
    .where(eq(categoryZohoAccounts.companyName, zohoEntity));
  const perEntity = new Map(rows.map((r) => [r.categoryId, r.zohoAccountId]));

  for (const id of chain) {
    const hit = perEntity.get(id);
    if (hit) return hit;
  }
  const legacyById = new Map(cats.map((c) => [c.id, c.zohoAccountId]));
  for (const id of chain) {
    const legacy = legacyById.get(id);
    if (legacy) return legacy;
  }
  return null;
}
```

(`inArray` import only if used — drop unused imports so lint stays clean.)

- [ ] **Step 2: Full tests + lint** — `npm run test && npm run lint` → all pass (the payload-order tests from `zohoPayloadEntityAccounts.test.ts` still pass — the payload contract is unchanged).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/categoryZohoAccounts.ts
git commit -m "feat(zoho): category Zoho account resolution inherits from ancestors"
```

---

### Task 4: API routes — tree CRUD, effective-active list, descendant filters, report rollup

**Files:**
- Modify: `apps/api/src/routes/admin.ts:530-560` (categories CRUD)
- Modify: `apps/api/src/routes/expenses.ts:493-499` (categories/list) and `:56` (categoryId filter)
- Modify: `apps/api/src/routes/reports.ts:54-56` (byCategory rollup) and `:182-186` (budget category spend)
- Test: `apps/api/src/__tests__/categoryRollup.test.ts`

**Interfaces:**
- Consumes: `wouldCreateCycle`, `descendantIds`, `effectivelyActiveIds`, `topLevelAncestorId` (Task 2).
- Produces: `rollUpByTopAncestor(nodes, rows: { categoryId: string | null; name: string | null; spend: number; n: number }[], nameOf: (id: string) => string): { name: string; spend: number; n: number }[]` in `apps/api/src/lib/categoryTree.ts`.

- [ ] **Step 1: Admin CRUD.** In `admin.ts`, POST gains `parentId`; PATCH gains cycle-guarded `parentId` (explicit `null` allowed to detach):

```ts
router.post('/categories', accounting, asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parentId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  const [cat] = await db.insert(expenseCategories).values(body).returning();
  res.status(201).json({ category: cat });
}));

router.patch('/categories/:id', accounting, asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
    parentId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  if (body.parentId !== undefined) {
    const all = await db.query.expenseCategories.findMany();
    if (wouldCreateCycle(all, req.params.id, body.parentId)) {
      throw createError('That parent would create a cycle in the category tree', 400, 'CATEGORY_CYCLE');
    }
  }

  const [updated] = await db.update(expenseCategories)
    .set(body)
    .where(eq(expenseCategories.id, req.params.id))
    .returning();

  res.json({ category: updated });
}));
```

Add imports at top of `admin.ts`: `import { wouldCreateCycle } from '../lib/categoryTree';` (and `createError` if not already imported — check the file's existing error imports from `../middleware/error`).

- [ ] **Step 2: Picker list = effectively active.** In `expenses.ts` replace the `categories/list` handler body:

```ts
// Categories (read-only for all users). Only effectively-active nodes —
// a category is hidden when it OR any ancestor is inactive.
router.get('/categories/list', asyncHandler(async (_req, res) => {
  const all = await db.query.expenseCategories.findMany({
    orderBy: (c, { asc }) => [asc(c.name)],
  });
  const activeIds = effectivelyActiveIds(all);
  res.json({ categories: all.filter((c) => activeIds.has(c.id)) });
}));
```

Import: `import { effectivelyActiveIds, descendantIds } from '../lib/categoryTree';`

- [ ] **Step 3: Descendant-aware filter.** In `expenses.ts` line ~56, replace `if (categoryId) conditions.push(eq(expenses.categoryId, categoryId));` with:

```ts
  if (categoryId) {
    // A parent category matches itself and all descendants.
    const allCats = await db.query.expenseCategories.findMany({ columns: { id: true, parentId: true, isActive: true } });
    conditions.push(inArray(expenses.categoryId, descendantIds(allCats, categoryId)));
  }
```

(`inArray` is already imported in this file — verify; add to the drizzle-orm import if missing.)

- [ ] **Step 4: Report rollup helper (TDD).** Add to `apps/api/src/lib/categoryTree.ts`:

```ts
/** Roll spend rows up to their top-level ancestor. Rows with null categoryId stay "Uncategorized". */
export function rollUpByTopAncestor(
  nodes: CategoryNode[],
  rows: { categoryId: string | null; spend: number; n: number }[],
  nameOf: (id: string) => string,
): { name: string; spend: number; n: number }[] {
  const acc = new Map<string, { name: string; spend: number; n: number }>();
  for (const r of rows) {
    const key = r.categoryId ? topLevelAncestorId(nodes, r.categoryId) : '__uncategorized__';
    const name = r.categoryId ? nameOf(key) : 'Uncategorized';
    const cur = acc.get(key) ?? { name, spend: 0, n: 0 };
    cur.spend += r.spend;
    cur.n += r.n;
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => b.spend - a.spend);
}
```

Test `apps/api/src/__tests__/categoryRollup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rollUpByTopAncestor, type CategoryNode } from '../lib/categoryTree';

const nodes: CategoryNode[] = [
  { id: 'travel', parentId: null, isActive: true },
  { id: 'flight', parentId: 'travel', isActive: true },
  { id: 'other', parentId: null, isActive: true },
];
const names: Record<string, string> = { travel: 'Travel', flight: 'Travel - Flight', other: 'Other' };

describe('rollUpByTopAncestor', () => {
  it('sums descendants into the top-level parent and sorts by spend', () => {
    const rows = [
      { categoryId: 'flight', spend: 100, n: 2 },
      { categoryId: 'travel', spend: 50, n: 1 },
      { categoryId: 'other', spend: 30, n: 1 },
      { categoryId: null, spend: 5, n: 1 },
    ];
    const out = rollUpByTopAncestor(nodes, rows, (id) => names[id]);
    expect(out).toEqual([
      { name: 'Travel', spend: 150, n: 3 },
      { name: 'Other', spend: 30, n: 1 },
      { name: 'Uncategorized', spend: 5, n: 1 },
    ]);
  });
});
```

Run failing → implement → passing.

- [ ] **Step 5: Wire rollup into reports.** In `reports.ts`, change the byCategory query to select ids and roll up (num() already exists in the file for numeric coercion — reuse it):

```ts
  const allCats = await db.query.expenseCategories.findMany({ columns: { id: true, parentId: true, isActive: true, name: true } });
  const catNameOf = (id: string) => allCats.find((c) => c.id === id)?.name ?? 'Unknown';

  const byCategoryRaw = await db.select({ categoryId: expenses.categoryId, spend: sum(expenses.amount), n: count() })
    .from(expenses).where(scope).groupBy(expenses.categoryId);
  const byCategory = rollUpByTopAncestor(
    allCats,
    byCategoryRaw.map((r) => ({ categoryId: r.categoryId, spend: num(r.spend), n: Number(r.n) })),
    catNameOf,
  );
```

Downstream code reads `byCategory` rows as `{ name, spend, n }` — keep the response shape identical (check how the existing rows are serialized: previously `spend` came from SQL `sum` as string and was `num()`ed at line ~184; now it's already a number — update the two consumers in this handler accordingly, in particular `catSpend`).
For budget rows with `categoryId` (line ~182): replace the name-keyed `catSpend` lookup with a descendant-aware sum over `byCategoryRaw`:

```ts
  if (entity) {
    for (const row of budgetVsSpend) {
      if (!row.categoryId) continue;
      const ids = new Set(descendantIds(allCats, row.categoryId));
      const spend = byCategoryRaw
        .filter((r) => r.categoryId && ids.has(r.categoryId))
        .reduce((s, r) => s + num(r.spend), 0);
      row.spend = spend;
      row.remaining = row.budget - spend;
    }
  }
```

Imports in `reports.ts`: `import { rollUpByTopAncestor, descendantIds } from '../lib/categoryTree';`

- [ ] **Step 6: Full suite + lint** — `npm run test && npm run lint` → pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/expenses.ts apps/api/src/routes/reports.ts apps/api/src/lib/categoryTree.ts apps/api/src/__tests__/categoryRollup.test.ts
git commit -m "feat(api): category tree CRUD, effective-active picker list, descendant filters, report rollup"
```

---

### Task 5: Initial tree seed script

**Files:**
- Create: `apps/api/src/scripts/seed-category-tree.ts`

**Interfaces:**
- Consumes: nothing new. Idempotent; name-matched; creates "Show Operations" and "Office & Admin" if absent.

- [ ] **Step 1: Write the script:**

```ts
/**
 * One-off: arrange existing categories into the initial tree
 * (spec: docs/superpowers/specs/2026-08-10-hierarchical-categories-design.md).
 * Idempotent, name-matched. Only parent_id values are written (plus the two new
 * parent categories). Admins can freely rearrange afterwards in Admin → Categories.
 *
 * Run: npx tsx src/scripts/seed-category-tree.ts
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { expenseCategories } from '../db/schema';

// parent name → child names
const TREE: Record<string, string[]> = {
  'Travel': ['Travel - Flight', 'Travel Expenses', 'Accommodation', 'Transportation'],
  'Accommodation': ['Accommodation - Hotel'],
  'Transportation': ['Transportation - Uber / Lyft / Others', 'Rental - Car / U-haul', 'Gas / Fuel', 'Parking Fees'],
  'Meals & Entertainment': ['Meal and Entertainment', 'Show Allowances - Per Diem'],
  'Show Operations': ['Booth / Marketing / Tools', 'Model', 'Shipping Charges', 'Storage charges'],
  'Office & Admin': ['Office Supplies', 'Stationaries', 'Software & Subscriptions', 'Professional Services', 'Equipment', 'Marketing & Advertising'],
};
const NEW_PARENTS = ['Show Operations', 'Office & Admin'];

async function main() {
  await db.transaction(async (tx) => {
    for (const name of NEW_PARENTS) {
      const existing = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, name) });
      if (!existing) {
        await tx.insert(expenseCategories).values({ name, isActive: true });
        console.log(`created parent: ${name}`);
      }
    }
    for (const [parentName, children] of Object.entries(TREE)) {
      const parent = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, parentName) });
      if (!parent) { console.log(`WARN parent "${parentName}" not found — skipping its children`); continue; }
      for (const childName of children) {
        const child = await tx.query.expenseCategories.findFirst({ where: eq(expenseCategories.name, childName) });
        if (!child) { console.log(`WARN child "${childName}" not found — skipped`); continue; }
        if (child.parentId === parent.id) { console.log(`ok:      ${childName} already under ${parentName}`); continue; }
        await tx.update(expenseCategories).set({ parentId: parent.id }).where(eq(expenseCategories.id, child.id));
        console.log(`parented: ${childName} → ${parentName}`);
      }
    }
  });
  console.log('Category tree seeded.');
}

main().then(() => process.exit(0)).catch((err) => { console.error('SEED FAILED (rolled back):', err); process.exit(1); });
```

- [ ] **Step 2: Lint** — `npm run lint` → clean.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/scripts/seed-category-tree.ts
git commit -m "feat(sync): initial category tree seed script"
```

---

### Task 6: Web — tree lib + cascading CategoryPicker

**Files:**
- Create: `apps/web/src/lib/categoryTree.ts`
- Create: `apps/web/src/components/CategoryPicker.tsx`
- Modify: `apps/web/src/types.ts` (or wherever `ExpenseCategory` is declared — find with `grep -rn "interface ExpenseCategory" apps/web/src`): add `parentId: string | null;`

**Interfaces:**
- Produces:
  - `buildChildrenMap(cats: { id: string; parentId: string | null }[]): Map<string | null, typeof cats>` (children sorted by name when nodes carry `name`)
  - `pathFromRoot(cats, id): string[]` — `[root, …, id]`
  - `<CategoryPicker categories={ExpenseCategory[]} value={string} onChange={(id: string) => void} />` — renders one select per level; `value` is the deepest selected id ('' = none).

- [ ] **Step 1: Web tree lib** `apps/web/src/lib/categoryTree.ts`:

```ts
export interface CategoryTreeNode {
  id: string;
  name: string;
  parentId: string | null;
}

export function buildChildrenMap<T extends CategoryTreeNode>(cats: T[]): Map<string | null, T[]> {
  const map = new Map<string | null, T[]>();
  for (const c of cats) {
    const key = c.parentId ?? null;
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return map;
}

/** [rootId, …, id]; bounded against malformed cycles. */
export function pathFromRoot(cats: CategoryTreeNode[], id: string): string[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const path: string[] = [];
  let cur: string | null = id;
  while (cur && byId.has(cur) && path.length < cats.length) {
    if (path.includes(cur)) break;
    path.unshift(cur);
    cur = byId.get(cur)!.parentId ?? null;
  }
  return path;
}
```

- [ ] **Step 2: CategoryPicker** `apps/web/src/components/CategoryPicker.tsx`:

```tsx
import { useMemo } from 'react';
import { buildChildrenMap, pathFromRoot, type CategoryTreeNode } from '../lib/categoryTree';

const selectCls = 'w-full rounded-lg border border-ink/15 bg-white px-3 py-3 lg:py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

interface Props {
  categories: CategoryTreeNode[];
  /** Deepest selected category id, '' for none. */
  value: string;
  onChange: (id: string) => void;
}

/**
 * Cascading category picker: one select per tree level. Selecting a node with
 * children reveals an optional "refine" select below; any level is a valid
 * final answer (the deepest selection wins).
 */
export function CategoryPicker({ categories, value, onChange }: Props) {
  const children = useMemo(() => buildChildrenMap(categories), [categories]);
  const path = useMemo(() => (value ? pathFromRoot(categories, value) : []), [categories, value]);

  // Levels to render: root select, then one per selected node that has children.
  const levels: { parent: string | null; selected: string }[] = [];
  levels.push({ parent: null, selected: path[0] ?? '' });
  for (let i = 0; i < path.length; i++) {
    if ((children.get(path[i]) ?? []).length > 0) {
      levels.push({ parent: path[i], selected: path[i + 1] ?? '' });
    }
  }

  return (
    <div className="space-y-2">
      {levels.map((level, idx) => {
        const options = children.get(level.parent) ?? [];
        if (options.length === 0) return null;
        return (
          <select
            key={level.parent ?? 'root'}
            value={level.selected}
            onChange={(e) => {
              // Selecting sets the deepest choice; clearing falls back to this level's parent.
              onChange(e.target.value || level.parent || '');
            }}
            className={selectCls}
          >
            <option value="">{idx === 0 ? '— Select category —' : '— refine (optional) —'}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Type update.** Find `ExpenseCategory` (`grep -rn "ExpenseCategory" apps/web/src/types.ts apps/web/src/api/expenses.ts`) and add `parentId: string | null;` to the interface.

- [ ] **Step 4: Lint** — `cd apps/web && npm run lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/categoryTree.ts apps/web/src/components/CategoryPicker.tsx apps/web/src/types.ts
git commit -m "feat(web): cascading CategoryPicker + category tree lib"
```

---

### Task 7: ExpenseNew — Midas category picker replaces Zoho COA dropdown

**Files:**
- Modify: `apps/web/src/pages/ExpenseNew.tsx` (form state ~line 46-57, OCR suggestion effect ~164-182, submit payload ~255-263, category Field ~549-571)

**Interfaces:**
- Consumes: `CategoryPicker` (Task 6), `expenseApi.categories()` (exists — GET `/expenses/categories/list`), `expenseApi.create/update` already accept `categoryId`.

- [ ] **Step 1: Form state.** In the `form` state object replace `zohoExpenseAccountId: ''` / `zohoExpenseAccountName: ''` with `categoryId: ''`. Remove the two `zoho-expense-accounts` artifacts:
  - Delete the `useQuery` for `['zoho-expense-accounts', form.company]` and the `expenseAccounts` variable.
  - In `setCompany` and `setPaymentMethod`, stop clearing `zohoExpenseAccountId`/`zohoExpenseAccountName` (category choice is company-independent — do NOT clear `categoryId` on company change).
  - Load categories instead:

```ts
  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    staleTime: 60_000,
  });
```

- [ ] **Step 2: OCR suggestion matches the Midas tree.** Replace the COA-matching effect (~lines 164-182) with name matching over `categories`, deepest match preferred:

```ts
  // Preselect the Midas category matching the OCR suggestion — never overriding
  // a non-empty user pick. Deepest (most specific) name match wins.
  useEffect(() => {
    if (!ocrCategorySuggestion || form.categoryId) return;
    const sugg = ocrCategorySuggestion.trim().toLowerCase();
    if (!sugg || categories.length === 0) return;
    const matches = categories.filter((c) => {
      const name = c.name.toLowerCase();
      return name.includes(sugg) || sugg.includes(name);
    });
    if (matches.length === 0) return;
    const deepest = matches.reduce((a, b) =>
      pathFromRoot(categories, b.id).length > pathFromRoot(categories, a.id).length ? b : a);
    setForm((f) => (f.categoryId ? f : { ...f, categoryId: deepest.id }));
    setCategoryAutoSuggested(true);
  }, [ocrCategorySuggestion, categories, form.categoryId]);
```

Imports: `import { CategoryPicker } from '../components/CategoryPicker';` and `import { pathFromRoot } from '../lib/categoryTree';`

- [ ] **Step 3: Submit payload.** In `doSubmit` replace the `zohoExpenseAccountId`/`zohoExpenseAccountName` lines with:

```ts
        categoryId: form.categoryId || undefined,
```

- [ ] **Step 4: Render.** Replace the `{form.company && zohoOn && (<Field label="Expense category">…</Field>)}` block with an always-visible field (categories are company-independent now):

```tsx
          <Field label="Category">
            <CategoryPicker
              categories={categories}
              value={form.categoryId}
              onChange={(id) => { setCategoryAutoSuggested(false); set('categoryId', id); }}
            />
            {categoryAutoSuggested && !!form.categoryId && (
              <p className="mt-1 text-xs text-charcoal/40">Suggested from the receipt — change if wrong.</p>
            )}
          </Field>
```

- [ ] **Step 5: Lint + manual smoke.** `cd apps/web && npm run lint`. Then with the local stack (if running) or in prod after deploy: New Expense → pick "Travel" → refine select appears with Flight/Expenses/Accommodation/Transportation → pick "Transportation" → third select appears → stopping at any level submits fine.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/ExpenseNew.tsx
git commit -m "feat(web): New Expense uses cascading Midas category picker"
```

---

### Task 8: Admin tree editing + ExpenseList descendant filter

**Files:**
- Modify: `apps/web/src/pages/Admin.tsx` (`CategoriesTab`, ~line 973-1024)
- Modify: `apps/web/src/pages/ExpenseList.tsx` (~line 165 category filter)

**Interfaces:**
- Consumes: `buildChildrenMap`, `pathFromRoot` (Task 6); PATCH `/admin/categories/:id` with `{ parentId }` (Task 4; 400 `CATEGORY_CYCLE` on cycles).

- [ ] **Step 1: Rewrite `CategoriesTab`** as an indented tree with rename, active toggle, re-parent, add-sub:

```tsx
function CategoriesTab() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [newParent, setNewParent] = useState('');
  const [error, setError] = useState('');
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => client.get('/admin/categories').then((r) => r.data.categories),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-categories'] });
    qc.invalidateQueries({ queryKey: ['expense-categories'] });
  };
  const addMutation = useMutation({
    mutationFn: () => client.post('/admin/categories', { name, parentId: newParent || null }),
    onSuccess: () => { invalidate(); setName(''); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not add category'),
  });
  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; isActive?: boolean; parentId?: string | null }) =>
      client.patch(`/admin/categories/${id}`, body),
    onSuccess: () => { invalidate(); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not update category'),
  });

  // Depth-first flatten for indented rendering.
  const ordered = useMemo(() => {
    const byParent = new Map<string | null, any[]>();
    for (const c of categories) {
      const key = c.parentId ?? null;
      byParent.set(key, [...(byParent.get(key) ?? []), c]);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    const out: { cat: any; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const c of byParent.get(parentId) ?? []) {
        out.push({ cat: c, depth });
        if (depth < categories.length) walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [categories]);

  // Valid parents for a node: everything except itself and its descendants.
  const validParents = (id: string) => {
    const blocked = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of categories) {
        if (c.parentId && blocked.has(c.parentId) && !blocked.has(c.id)) { blocked.add(c.id); grew = true; }
      }
    }
    return categories.filter((c: any) => !blocked.has(c.id));
  };

  if (isLoading) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <ErrorPanel message={error} onDismiss={() => setError('')} />
      <div className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <select
          value={newParent}
          onChange={(e) => setNewParent(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        >
          <option value="">— top level —</option>
          {ordered.map(({ cat, depth }) => (
            <option key={cat.id} value={cat.id}>{' '.repeat(depth * 3)}{cat.name}</option>
          ))}
        </select>
        <button
          onClick={() => addMutation.mutate()}
          disabled={!name.trim()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Add
        </button>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white">
        {ordered.map(({ cat, depth }) => (
          <div key={cat.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-3 last:border-0">
            <div style={{ paddingLeft: depth * 20 }}>
              <p className="font-medium text-gray-900">{depth > 0 && <span className="text-gray-300">└ </span>}{cat.name}</p>
              {cat.description && <p className="text-xs text-gray-400">{cat.description}</p>}
            </div>
            <div className="flex items-center gap-2">
              <select
                value={cat.parentId ?? ''}
                onChange={(e) => patchMutation.mutate({ id: cat.id, parentId: e.target.value || null })}
                className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:border-brand-500 focus:outline-none"
                title="Parent category"
              >
                <option value="">— top level —</option>
                {validParents(cat.id).map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                onClick={() => patchMutation.mutate({ id: cat.id, isActive: !cat.isActive })}
                className={`rounded-full px-2.5 py-0.5 text-xs ${cat.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                title={cat.isActive ? 'Click to hide (hides whole subtree from pickers)' : 'Click to activate'}
              >
                {cat.isActive ? 'Active' : 'Hidden'}
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400">
        Hiding a category hides its whole subtree from pickers. Existing expenses keep their category either way.
      </p>
    </div>
  );
}
```

(`useMemo` must be imported in Admin.tsx — check the React import line.)

- [ ] **Step 2: ExpenseList descendant filter.** In `ExpenseList.tsx`, the client-side filter (~line 165) `if (categoryId && e.categoryId !== categoryId) return false;` becomes a descendant-set check. The page already loads expenses; add a categories query and compute the allowed set:

```ts
  const { data: allCategories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => expenseApi.categories(),
    staleTime: 60_000,
  });
  const categoryIdSet = useMemo(() => {
    if (!categoryId) return null;
    const allowed = new Set([categoryId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of allCategories) {
        if (c.parentId && allowed.has(c.parentId) && !allowed.has(c.id)) { allowed.add(c.id); grew = true; }
      }
    }
    return allowed;
  }, [categoryId, allCategories]);
```

and in the filter: `if (categoryIdSet && (!e.categoryId || !categoryIdSet.has(e.categoryId))) return false;`
Also extend the `categoryOptions` memo's dropdown to show ALL active categories (from `allCategories`, indented like Admin) instead of only categories seen on loaded expenses — parents with zero direct expenses must be selectable to roll up children. Keep the existing option shape (`id`/`name`).

- [ ] **Step 3: Lint** — `cd apps/web && npm run lint` → clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/Admin.tsx apps/web/src/pages/ExpenseList.tsx
git commit -m "feat(web): admin category tree editing + descendant-aware list filter"
```

---

### Task 9: Version bump, deploy, seed, verify

**Files:**
- Modify: `apps/api/package.json:3`, `apps/web/package.json:3` → `0.31.0-alpha`

- [ ] **Step 1: Bump + full checks + merge + push**

```bash
sed -i '' 's/"version": "0.30.0-alpha"/"version": "0.31.0-alpha"/' apps/api/package.json apps/web/package.json
cd apps/api && npm run test && npm run lint && cd ../web && npm run lint && cd ../..
git add apps/api/package.json apps/web/package.json
git commit -m "chore: bump version to 0.31.0-alpha"
git checkout main && git merge --no-ff <feature-branch> && git push origin main
```

- [ ] **Step 2: Deploy to CT 3120** (file-push per OPERATIONS.md — `/opt/midas` is NOT a git repo). Tar the changed files, push, clean AppleDouble files:

```bash
tar czf /tmp/midas-cat-deploy.tgz \
  apps/api/src/db/schema.ts apps/api/src/lib/categoryTree.ts apps/api/src/lib/categoryZohoAccounts.ts \
  apps/api/src/routes/admin.ts apps/api/src/routes/expenses.ts apps/api/src/routes/reports.ts \
  apps/api/src/scripts/seed-category-tree.ts apps/api/drizzle/0018_category_parent.sql apps/api/package.json \
  apps/web/src/lib/categoryTree.ts apps/web/src/components/CategoryPicker.tsx apps/web/src/types.ts \
  apps/web/src/pages/ExpenseNew.tsx apps/web/src/pages/Admin.tsx apps/web/src/pages/ExpenseList.tsx apps/web/package.json
scp /tmp/midas-cat-deploy.tgz root@192.168.1.190:/tmp/
ssh root@192.168.1.190 "pct push 3120 /tmp/midas-cat-deploy.tgz /tmp/d.tgz && pct exec 3120 -- bash -c 'cd /opt/midas && tar xzf /tmp/d.tgz && rm /tmp/d.tgz && find . -name \"._*\" -delete'"
# api: package.json changed → rebuild (also applies schema via db:push on start)
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d --no-deps --build api'"
# web: PROD compose file ONLY (base compose web is the dev server and 403s the domain)
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --no-deps --build web'"
curl -s -o /dev/null -w '%{http_code}\n' https://midas.booute.duckdns.org/   # expect 200
ssh root@192.168.1.190 "pct exec 3120 -- curl -s http://localhost:4000/api/v1/health"  # expect ok + db ok
```

- [ ] **Step 3: Seed the tree in prod**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose exec -T api npx tsx src/scripts/seed-category-tree.ts'"
```

Expected: `created parent: Show Operations`, `created parent: Office & Admin`, ~20 `parented:` lines, `Category tree seeded.`

- [ ] **Step 4: Verify in prod DB** (CT 3220, read-only):

```sql
select c.name, p.name as parent from expense_categories c
left join expense_categories p on p.id = c.parent_id order by coalesce(p.name, c.name), c.name;
-- Expect the spec's tree; 6 top-level roots: Travel, Meals & Entertainment,
-- Show Operations, Office & Admin, Other, (Accommodation/Transportation appear under Travel).
select count(*) from expense_categories where parent_id is not null;  -- expect ~20
```

Also verify: `GET /expenses/categories/list` returns `parentId`; New Expense form shows top-level-only first select; Admin → Categories renders the indented tree; Reports "Spend by category" shows the rolled-up roots.

- [ ] **Step 5: Report to user** — tree shipped, where to edit it (Admin → Categories), what changed in the upload form, and that Zoho accounts now resolve via inheritance.
