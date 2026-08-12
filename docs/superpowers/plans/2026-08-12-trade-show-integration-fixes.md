# Trade Show Integration Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six pre-cutover items from `docs/trade-show-integration-response.md` so Trade Show can retire its expense database and run entirely on Midas.

**Architecture:** Four independent code changes plus a data repair and an environment change. `zohoEnabled` becomes a first-class input to the flag/approve/push chain rather than being ignored. The `/ext` write path gains a `warnings[]` contract carrying category fallback, company validation and duplicate detection. A second app connection is issued for production Trade Show with its own category allowlist.

**Tech Stack:** TypeScript, Express, Drizzle ORM, Vitest, PostgreSQL. Deploy: file-push to CT 3120 per `docs/OPERATIONS.md`; database is CT 3220.

## Global Constraints

- Version bump 0.43.0 → **0.44.0** in all four places: `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`, `packages/shared/src/version.ts`. All four must agree.
- Commit bodies end with:

  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KSQ1yoTYfUJZ9B7hFBb75r
  ```

- **Never write to the Trade Show database.** Midas is the only system being changed. Reading Trade Show data is fine.
- Production Midas is CT 3120 (app) + CT 3220 (database). Any table created or altered must end up owned by `midas`, not `postgres` — a `postgres`-owned table crash-loops the API with `must be owner of table`.
- A file-push deploy never deletes files. After any commit that deletes a file, remove it explicitly on CT 3120.
- `docker compose restart` does NOT reload `.env` (env_file injects at container create time). Environment changes require `up -d --force-recreate`.
- The `/ext` API contract is additive only. Existing response fields keep their names and meanings; `warnings` is a new optional array. No existing consumer may break.
- Non-Zoho companies (`companies.zoho_enabled = false`, i.e. `Summitt Labs`) must be retained normally and never pushed to Zoho. That is the whole point of Task 1 — do not weaken it.
- `sourceApp` stays `'trade_show'` for both the sandbox and production connections. `category_mappings` keys on `source_app`, so changing it would orphan 26 mappings. Only the connection *name* differs.

---

### Task 1: Respect `zohoEnabled` through flags, approve and push (TDD)

**Files:**
- Modify: `apps/api/src/lib/flags.ts` (`FlagsInput`, `computeFlags`)
- Modify: `apps/api/src/lib/zohoPush.ts` (guards at the top of `pushExpenseToZoho`, ~lines 44-60)
- Modify: `apps/api/src/routes/accountant.ts` (bulk approve ~line 320; single review approve ~line 439; the three `computeFlags` call sites at ~126, ~221, ~271)
- Create: `apps/api/src/lib/companyZoho.ts`
- Test: `apps/api/src/__tests__/flags.test.ts` (extend), `apps/api/src/__tests__/companyZoho.test.ts` (new)

**Interfaces:**
- Produces:
  - `FlagsInput.companyZohoEnabled?: boolean` — when `false`, `computeFlags` must not emit `ready_for_zoho`.
  - `zohoEnabledByCompanyName(): Promise<Map<string, boolean>>` in `lib/companyZoho.ts` — one query, name → `zohoEnabled && isActive`.
  - `pushExpenseToZoho` gains a `COMPANY_ZOHO_DISABLED` 409 outcome.

- [ ] **Step 1: Write the failing flags test**

Append to `apps/api/src/__tests__/flags.test.ts`. Read the file first and match its existing row-builder helper if it has one; if it builds literals inline, do the same.

```ts
describe('computeFlags — non-Zoho companies', () => {
  const readyRow = {
    sourceApp: 'trade_show',
    categoryId: 'cat-1',
    paymentMethodId: 'pm-1',
    receipts: [{ id: 'r-1' }],
    zohoEntity: 'Summitt Labs',
    zohoExpenseId: null,
    reimbursementStatus: 'not_requested',
    status: 'approved',
  };

  it('does not mark an expense ready for Zoho when its company has Zoho disabled', () => {
    expect(computeFlags({ ...readyRow, companyZohoEnabled: false })).not.toContain('ready_for_zoho');
  });

  it('still marks it ready when the company has Zoho enabled', () => {
    expect(computeFlags({ ...readyRow, companyZohoEnabled: true })).toContain('ready_for_zoho');
  });

  it('treats an unknown companyZohoEnabled as enabled, preserving today behaviour', () => {
    expect(computeFlags(readyRow)).toContain('ready_for_zoho');
  });

  it('leaves the other flags untouched for a non-Zoho company', () => {
    const flags = computeFlags({
      ...readyRow, companyZohoEnabled: false, receipts: [], paymentMethodId: null,
    });
    expect(flags).toContain('missing_receipt');
    expect(flags).toContain('needs_payment_method');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/flags.test.ts`
Expected: the first test FAILS (`ready_for_zoho` is still emitted). The third should already pass.

- [ ] **Step 3: Implement the flags change**

In `apps/api/src/lib/flags.ts`, add to `FlagsInput`:

```ts
  /**
   * Whether the expense's company posts to Zoho at all. Undefined means unknown,
   * which is treated as enabled so callers that cannot supply it keep today's
   * behaviour. `false` is what suppresses ready_for_zoho — a Summitt Labs
   * expense is complete and correct, it simply has nowhere to be pushed.
   */
  companyZohoEnabled?: boolean;
```

and add `row.companyZohoEnabled !== false &&` to the `zohoReady` conjunction.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/flags.test.ts`
Expected: all pass.

- [ ] **Step 5: Write the failing lookup test**

Create `apps/api/src/__tests__/companyZoho.test.ts`. This helper hits the database, and the unit suite runs without one — so test the pure part only. Export a pure `buildZohoEnabledMap(rows)` from `lib/companyZoho.ts` alongside the DB function and test that:

```ts
import { describe, it, expect } from 'vitest';
import { buildZohoEnabledMap } from '../lib/companyZoho';

describe('buildZohoEnabledMap', () => {
  it('maps company name to whether it can post to Zoho', () => {
    const m = buildZohoEnabledMap([
      { name: 'Haute Brands', zohoEnabled: true, isActive: true },
      { name: 'Summitt Labs', zohoEnabled: false, isActive: true },
    ]);
    expect(m.get('Haute Brands')).toBe(true);
    expect(m.get('Summitt Labs')).toBe(false);
  });

  it('treats an inactive company as not Zoho-capable', () => {
    const m = buildZohoEnabledMap([{ name: 'Old Co', zohoEnabled: true, isActive: false }]);
    expect(m.get('Old Co')).toBe(false);
  });

  it('returns an empty map for no companies', () => {
    expect(buildZohoEnabledMap([]).size).toBe(0);
  });
});
```

- [ ] **Step 6: Run to verify it fails, then implement**

Run: `cd apps/api && npx vitest run src/__tests__/companyZoho.test.ts` — FAIL, module not found.

Create `apps/api/src/lib/companyZoho.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { companies } from '../db/schema';

/** Pure: company name → whether it can post to Zoho at all. */
export function buildZohoEnabledMap(
  rows: { name: string; zohoEnabled: boolean; isActive: boolean }[],
): Map<string, boolean> {
  return new Map(rows.map((c) => [c.name, c.zohoEnabled && c.isActive]));
}

/**
 * One query for the whole company list. There are a handful of companies, so the
 * accountant queue reads them once per request rather than joining per row.
 */
export async function zohoEnabledByCompanyName(): Promise<Map<string, boolean>> {
  const rows = await db.query.companies.findMany({
    columns: { name: true, zohoEnabled: true, isActive: true },
  });
  return buildZohoEnabledMap(rows);
}
```

Run the test again: PASS. (`eq` may be unused — drop the import if so; lint will tell you.)

- [ ] **Step 7: Guard the push**

In `apps/api/src/lib/zohoPush.ts`, after the existing `MISSING_ZOHO_ENTITY` guard and before `MISSING_CATEGORY`, add a company check. `pushExpenseToZoho` currently takes only the expense, so look up the single company inline rather than threading a map through every caller:

```ts
  if (!(await isCompanyZohoEnabled(expense.zohoEntity))) {
    return {
      ok: false, status: 409, code: 'COMPANY_ZOHO_DISABLED',
      message: `Company "${expense.zohoEntity}" does not post to Zoho`,
    };
  }
```

`isCompanyZohoEnabled` already exists in `apps/api/src/lib/companies.ts` — import it, do not write a second one.

- [ ] **Step 8: Fix both approve paths**

In `apps/api/src/routes/accountant.ts`:

Bulk approve (~line 320) currently reads `integrationStatus: expense.zohoEntity ? 'pending' : 'not_required'`. An expense on a non-Zoho company must land on `not_required`, not `pending`. Load the map once before the approve loop:

```ts
  const zohoByCompany = await zohoEnabledByCompanyName();
```

and change the assignment to:

```ts
      integrationStatus: expense.zohoEntity && zohoByCompany.get(expense.zohoEntity) !== false
        ? 'pending'
        : 'not_required',
```

Single review approve (~line 439) has the same expression over `(('zohoEntity' in parsed && parsed.zohoEntity) || expense.zohoEntity)`. Compute the effective company into a local first, then apply the same `!== false` test against a map (or a single `isCompanyZohoEnabled` call — one expense, one lookup is fine here):

```ts
  const effectiveCompany = ('zohoEntity' in parsed && parsed.zohoEntity) || expense.zohoEntity;
  const companyPostsToZoho = effectiveCompany ? await isCompanyZohoEnabled(effectiveCompany) : false;
```

then `integrationStatus: action === 'approve' ? (companyPostsToZoho ? 'pending' : 'not_required') : expense.integrationStatus`.

- [ ] **Step 9: Feed the flag through the three queue call sites**

The three `computeFlags(row)` calls in `accountant.ts` (~126 in `/queue`, ~221 in `/queue/summary`, ~271 in `/expenses`) must pass `companyZohoEnabled`. In each handler, call `zohoEnabledByCompanyName()` once before the loop and pass:

```ts
    const flags = computeFlags({ ...row, companyZohoEnabled: row.zohoEntity ? zohoByCompany.get(row.zohoEntity) : undefined });
```

Preserve each site's existing cast where one is present (`row as Parameters<typeof computeFlags>[0]`) — spreading may break the cast, so adjust the type expression rather than deleting it.

- [ ] **Step 10: Full suite and lint**

Run: `cd apps/api && npm run test && npm run lint`
Expected: all pass. Report the count.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/lib/flags.ts apps/api/src/lib/companyZoho.ts apps/api/src/lib/zohoPush.ts apps/api/src/routes/accountant.ts apps/api/src/__tests__/flags.test.ts apps/api/src/__tests__/companyZoho.test.ts
git commit -m "fix(api): non-Zoho companies are never queued or pushed to Zoho"
```

---

### Task 2: Repair the affected production rows

**Files:**
- Create: `apps/api/src/scripts/repair-company-integration-state.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (it is pure SQL over current data).
- Produces: an idempotent, re-runnable repair script. No exports.

Context — what is actually wrong in production right now, measured 2026-08-12:
- 70 expenses are on `Summitt Labs` (`zoho_enabled = false`); **13 of them are `status='approved'` with `integration_status='pending'`**, i.e. queued for a push that must never happen.
- 2 expenses have the literal string `'undefined'` as `zoho_entity`; 1 has `NULL`.

- [ ] **Step 1: Write the script**

Create `apps/api/src/scripts/repair-company-integration-state.ts`:

```ts
/**
 * One-off, idempotent repair for two data problems found during the Trade Show
 * integration review:
 *
 *  1. Expenses on a company with zoho_enabled=false were approved with
 *     integration_status='pending', queueing a push that must never happen.
 *     They become 'not_required'.
 *  2. `POST /ext/expenses` did not validate the company name, so some rows hold
 *     the literal string 'undefined'. Those become NULL.
 *
 * Safe to re-run: both updates are conditional and converge.
 *
 * Run: npx tsx src/scripts/repair-company-integration-state.ts [--apply]
 * Without --apply it reports what it would change and exits.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index';

const APPLY = process.argv.includes('--apply');

async function main() {
  const queued = await db.execute(sql`
    SELECT e.id, e.zoho_entity, e.status
    FROM expenses e
    JOIN companies c ON c.name = e.zoho_entity
    WHERE c.zoho_enabled = false AND e.integration_status = 'pending'
  `);
  const bogus = await db.execute(sql`
    SELECT id, zoho_entity FROM expenses WHERE zoho_entity = 'undefined'
  `);

  console.log(`Non-Zoho company queued for push: ${queued.rows.length}`);
  console.log(`Literal 'undefined' company:      ${bogus.rows.length}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  const a = await db.execute(sql`
    UPDATE expenses e SET integration_status = 'not_required', updated_at = now()
    FROM companies c
    WHERE c.name = e.zoho_entity AND c.zoho_enabled = false AND e.integration_status = 'pending'
  `);
  const b = await db.execute(sql`
    UPDATE expenses SET zoho_entity = NULL, updated_at = now() WHERE zoho_entity = 'undefined'
  `);
  console.log(`\nUpdated integration_status: ${a.rowCount ?? 'n/a'}`);
  console.log(`Cleared bogus company:      ${b.rowCount ?? 'n/a'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Check how the repo's other scripts (e.g. `apps/api/src/scripts/merge-users.ts`) obtain a raw-SQL result and read its row count — `db.execute` return shapes differ between drivers. Match whatever `merge-users.ts` does rather than trusting the snippet above, and say in your report if it differed.

- [ ] **Step 2: Verify the dry run against a restore, not production**

```bash
ssh root@192.168.1.190 "pct exec 3220 -- su - postgres -c 'pg_dump -d midas'" > /tmp/repair-test.sql
dropdb -h 127.0.0.1 midas_repair_test 2>/dev/null; createdb -h 127.0.0.1 midas_repair_test
psql -q postgresql://sahilkhatri@127.0.0.1:5432/midas_repair_test -f /tmp/repair-test.sql
cd apps/api
DATABASE_URL=postgresql://sahilkhatri@127.0.0.1:5432/midas_repair_test JWT_SECRET=repair-test-secret-at-least-32-chars OCR_MODE=mock ZOHO_MODE=mock STORAGE_MODE=local UPLOADS_DIR=./uploads npx tsx src/scripts/repair-company-integration-state.ts
```
Expected: reports 13 and 2.

- [ ] **Step 3: Apply on the restore and verify convergence**

Re-run with `--apply`, then run the dry run a third time. Expected: 0 and 0 — proving idempotence. Then confirm no Summitt Labs expense is left in a pushable state:

```bash
psql postgresql://sahilkhatri@127.0.0.1:5432/midas_repair_test -c \
  "select c.zoho_enabled, e.integration_status, count(*) from expenses e join companies c on c.name=e.zoho_entity group by 1,2 order by 1,2"
```
Expected: no row with `zoho_enabled = f` and `integration_status = 'pending'`.

Drop the test database when done.

- [ ] **Step 4: Lint and commit**

Run: `cd apps/api && npm run lint`

```bash
git add apps/api/src/scripts/repair-company-integration-state.ts
git commit -m "chore(api): idempotent repair for non-Zoho queued pushes and bogus company names"
```

Do NOT run this against production — Task 5 does that as part of the deploy.

---

### Task 3: The `/ext` write path — a `warnings[]` contract

**Files:**
- Modify: `apps/api/src/routes/ext.ts` (`POST /expenses` ~lines 379-468; `PATCH /expenses/:id` ~lines 499-559)
- Create: `apps/api/src/lib/ext/extWarnings.ts`
- Test: `apps/api/src/__tests__/extWarnings.test.ts`

**Interfaces:**
- Consumes: `resolveCategoryIdOrOther` (already exported from `apps/api/src/lib/ext/categories.ts`), `assertActiveCompany` and `isCompanyZohoEnabled` (from `apps/api/src/lib/companies.ts`), `isLikelyDuplicate` (from `apps/api/src/lib/duplicates.ts`).
- Produces:
  - `type ExtWarning = { code: string; message: string; matches?: DuplicateMatch[] }`
  - `type DuplicateMatch = { id: string; merchant: string; amount: number; date: string }`
  - `findDuplicateMatches(candidate, existingRows): DuplicateMatch[]` — pure.
  - `POST /ext/expenses` and `PATCH /ext/expenses/:id` responses gain an optional `warnings: ExtWarning[]`, omitted or `[]` when there is nothing to report.

Three behaviour changes land together because they all alter the same two handlers and share one response field:

**(a) Unknown category → `Other` + warning.** Both handlers call `resolveCategoryId`, which returns `null` for an unmatched name, so the expense is created with no category and no signal. Switch both to `resolveCategoryIdOrOther`, which already returns `{ categoryId, warning? }`, and surface its warning.

**(b) Company validated.** Neither handler validates `body.company` / `body.zohoEntity`; the literal string `'undefined'` reached production this way. Call `assertActiveCompany` on any supplied company value. It throws `400 UNKNOWN_COMPANY` for an unknown or inactive name and returns `null` for empty/null — a 400 is correct here, not a warning, because storing an unknown company silently corrupts the Zoho routing.

**(c) Duplicate detection.** Non-blocking: the create still succeeds.

- [ ] **Step 1: Write the failing duplicate-matcher test**

Create `apps/api/src/__tests__/extWarnings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findDuplicateMatches } from '../lib/ext/extWarnings';

const candidate = { merchant: 'Starbucks #123', amount: 12.5, date: '2026-08-10' };

describe('findDuplicateMatches', () => {
  it('matches on same amount, near date and similar merchant', () => {
    const m = findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: '2026-08-09' },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ id: 'e1', merchant: 'Starbucks', amount: 12.5, date: '2026-08-09' });
  });

  it('ignores a different amount', () => {
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '13.00', date: '2026-08-09' },
    ])).toHaveLength(0);
  });

  it('ignores a date more than three days away', () => {
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: '2026-08-01' },
    ])).toHaveLength(0);
  });

  it('ignores an unrelated merchant', () => {
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Hilton Garden Inn', amount: '12.50', date: '2026-08-10' },
    ])).toHaveLength(0);
  });

  it('returns every match when there are several', () => {
    expect(findDuplicateMatches(candidate, [
      { id: 'e1', merchant: 'Starbucks', amount: '12.50', date: '2026-08-09' },
      { id: 'e2', merchant: 'starbucks #123', amount: '12.50', date: '2026-08-10' },
    ])).toHaveLength(2);
  });

  it('returns nothing for an empty candidate set', () => {
    expect(findDuplicateMatches(candidate, [])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/extWarnings.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/lib/ext/extWarnings.ts`:

```ts
import { isLikelyDuplicate } from '../duplicates';

export interface DuplicateMatch {
  id: string;
  merchant: string;
  amount: number;
  date: string;
}

export interface ExtWarning {
  code: string;
  message: string;
  matches?: DuplicateMatch[];
}

/**
 * Pure duplicate scan over already-fetched candidate rows. Reuses the same
 * matcher the Midas-native create path uses, so a consumer never has to
 * reimplement it or fetch candidates itself.
 */
export function findDuplicateMatches(
  candidate: { merchant: string; amount: number; date: string },
  existing: { id: string; merchant: string; amount: number | string; date: string }[],
): DuplicateMatch[] {
  return existing
    .filter((e) => isLikelyDuplicate(candidate, { merchant: e.merchant, amount: e.amount, date: e.date }))
    .map((e) => ({ id: e.id, merchant: e.merchant, amount: Number(e.amount), date: e.date }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/extWarnings.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Wire all three into `POST /ext/expenses`**

In `apps/api/src/routes/ext.ts`, inside the create handler, after the duplicate-`sourceRefId` early return and after `resolveExtUser`:

Replace the `resolveCategoryId` call with `resolveCategoryIdOrOther` and collect its warning:

```ts
  const warnings: ExtWarning[] = [];

  const resolvedCat = await resolveCategoryIdOrOther({
    sourceApp: body.sourceApp,
    categoryId: body.categoryId,
    categoryName: body.categoryName,
  });
  const categoryId = resolvedCat.categoryId;
  if (resolvedCat.warning) {
    warnings.push({ code: 'CATEGORY_FALLBACK', message: resolvedCat.warning });
  }
```

Validate the company before the insert, and store the validated name:

```ts
  const company = await assertActiveCompany(body.company ?? body.zohoEntity);
```

then use `zohoEntity: company` in the insert instead of `body.company ?? body.zohoEntity ?? null`.

Scan for duplicates against this submitter's other expenses, excluding drafts and rejected rows (a rejected near-identical expense is not a useful warning) — read the schema for the exact status values before writing the `notInArray`:

```ts
  const candidates = await db.query.expenses.findMany({
    columns: { id: true, merchant: true, amount: true, date: true },
    where: and(
      eq(expenses.userId, user.id),
      notInArray(expenses.status, ['draft', 'rejected', 'cancelled']),
    ),
    limit: 500,
  });
  const matches = findDuplicateMatches(
    { merchant: body.merchant, amount: body.amount, date: body.date },
    candidates,
  );
  if (matches.length) {
    warnings.push({
      code: 'POSSIBLE_DUPLICATE',
      message: `${matches.length} existing expense(s) look like this one`,
      matches,
    });
  }
```

Add `notInArray` to the `drizzle-orm` import. Return the warnings, keeping every existing field:

```ts
  res.status(201).json({ expense, midasUrl: expense!.midasUrl, created: true, warnings });
```

The `sourceRefId` early-return path (`created: false`) returns the already-stored expense; give it `warnings: []` so the field's presence is consistent rather than conditional.

- [ ] **Step 6: Wire category fallback, company validation and duplicates into `PATCH /ext/expenses/:id`**

Same three changes, adapted to the patch's partial semantics:
- Category: switch `resolveCategoryId` → `resolveCategoryIdOrOther` in the `categoryName` branch, pushing its warning.
- Company: when `body.company` or `body.zohoEntity` is present, run it through `assertActiveCompany` and store the returned value.
- Duplicates: only scan when the patch changes `merchant`, `amount` or `date` — otherwise there is nothing new to compare. Build the candidate from the merged values (patch value if supplied, else the existing row's), and **exclude the expense being patched** from the candidate set, or it will always match itself.

Return `res.json({ expense, midasUrl: expense!.midasUrl, warnings })`.

- [ ] **Step 7: Full suite and lint**

Run: `cd apps/api && npm run test && npm run lint`
Expected: pass. If any existing test asserted on the exact create/patch response object, it may need the new field — update the assertion, do not remove the test.

- [ ] **Step 8: Verify against a restored database end to end**

Start the API against a restore (same recipe as Task 2, Step 2) and exercise the real contract with the `trade_show` connection's key. You will need a key: rotate one on the RESTORE ONLY via `npx tsx src/scripts/create-ext-connection.ts trade_show`. Never rotate the production key here — Task 4 owns key issuance.

Confirm, and put the actual responses in your report:
1. Creating with `categoryName: "Not A Real Category"` returns 201 with a `CATEGORY_FALLBACK` warning and the expense's category set to `Other`.
2. Creating with `company: "undefined"` returns `400 UNKNOWN_COMPANY` and creates nothing.
3. Creating with `company: "Summitt Labs"` succeeds (it is a real, active company — only Zoho posting is disabled).
4. Creating the same merchant/amount/date twice under different `sourceRefId`s returns a `POSSIBLE_DUPLICATE` warning on the second, with the first expense in `matches`, and still returns 201 with `created: true`.
5. A create with a valid category and company returns `warnings: []`.

Drop the test database afterwards.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/ext/extWarnings.ts apps/api/src/__tests__/extWarnings.test.ts apps/api/src/routes/ext.ts
git commit -m "feat(api): ext write path returns warnings for category fallback and duplicates, validates company"
```

---

### Task 4: A production Trade Show connection

**Files:**
- Modify: `apps/api/src/scripts/seed-trade-show-vocabulary.ts` (accept the connection name as an argument instead of hardcoding `trade_show`)
- Modify: `docs/OPERATIONS.md` (record how to issue and scope a consumer connection)

**Interfaces:**
- Consumes: `create-ext-connection.ts` (already takes the app name as `process.argv[2]`).
- Produces: no code exports. Operationally, a `trade_show_prod` connection with the same 7 permissions and the same 15-category allowlist as `trade_show`.

- [ ] **Step 1: Parameterise the vocabulary seed**

`apps/api/src/scripts/seed-trade-show-vocabulary.ts` hardcodes `const APP_NAME = 'trade_show'`. Change it to read `process.argv[2] || 'trade_show'` so the same 15-entry vocabulary can be applied to a second connection without copying the script. Keep the default, keep it idempotent, and keep the existing behaviour of failing loudly if the named connection does not exist. Update the usage comment at the top of the file.

- [ ] **Step 2: Verify on a restore before touching production**

Restore per Task 2 Step 2, then against the restore:

```bash
cd apps/api
export DATABASE_URL=postgresql://sahilkhatri@127.0.0.1:5432/midas_conn_test JWT_SECRET=conn-test-secret-at-least-32-chars OCR_MODE=mock ZOHO_MODE=mock STORAGE_MODE=local UPLOADS_DIR=./uploads
npx tsx src/scripts/create-ext-connection.ts trade_show_prod
npx tsx src/scripts/seed-trade-show-vocabulary.ts trade_show_prod
psql $DATABASE_URL -c "select ac.app_name, count(acc.category_id) from app_connections ac left join app_connection_categories acc on acc.connection_id = ac.id group by 1 order by 1"
```
Expected: `trade_show` 15 and `trade_show_prod` 15. Confirm the original `trade_show` connection's key hash was NOT changed by this (query `api_key_hash` before and after and compare) — creating a sibling must not rotate the existing key.

Re-run both scripts a second time and confirm the counts stay at 15 (idempotence) — note that `create-ext-connection.ts` ROTATES the key when the connection already exists, so a second run is expected to change the key. Say so in your report.

Drop the test database.

- [ ] **Step 3: Document the procedure**

Add a short section to `docs/OPERATIONS.md` covering: how to issue a consumer connection (`create-ext-connection.ts <name>`), how to scope its categories (`seed-trade-show-vocabulary.ts <name>`), that the key is printed once and never recoverable, that re-running the create script rotates the key, and that `sourceApp` in request bodies is independent of the connection name — `category_mappings` keys on `source_app`, so consumers keep sending `trade_show`.

- [ ] **Step 4: Lint and commit**

Run: `cd apps/api && npm run lint`

```bash
git add apps/api/src/scripts/seed-trade-show-vocabulary.ts docs/OPERATIONS.md
git commit -m "chore(api): scope any connection to the Trade Show vocabulary; document key issuance"
```

Production key issuance happens in Task 5, not here.

---

### Task 5: Turn on auto-provisioning, reconcile the roster, ship

**Files:**
- Modify: `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`, `packages/shared/src/version.ts` → `0.44.0`
- Modify: `docs/trade-show-integration-response.md` (record what shipped)

**Interfaces:** none — this task is release and operations.

- [ ] **Step 1: Confirm the provisioning path is sound before enabling it**

`EXT_AUTO_PROVISION_USERS=false` in production today, so an unknown submitter gets `422 USER_NOT_FOUND`. Read `apps/api/src/lib/ext/users.ts` and confirm all of the following before flipping it, reporting each:
- A provisioned user gets `role: 'user'` and an unusable password hash (no local login).
- Username is the identity key; `submitterEmail` still resolves through `user_email_aliases` so a pre-merge address finds the surviving account instead of creating a duplicate.
- Provisioning is audit-logged (`ext.user_provisioned`).
- An inactive existing user is rejected (`422 USER_INACTIVE`) rather than silently duplicated.

If any of those is not true, STOP and report — enabling auto-provisioning on a path that can duplicate identities would undo the identity reconciliation work.

- [ ] **Step 2: Reconcile the Trade Show roster against Midas**

Midas has 16 active users; 8 distinct users own the 376 imported expenses. Read Trade Show's user list directly from its database (read-only — never write to Trade Show) and report which Trade Show submitters have no Midas match by username or email, including aliases:

```bash
# Trade Show sandbox DB is on CT 2600 — find its connection string first:
ssh root@192.168.1.190 "pct exec 2600 -- bash -c 'cd /opt/trade-show-app 2>/dev/null && grep -h DATABASE_URL .env 2>/dev/null'"
```

If you cannot reach the Trade Show database, say so and instead report the Midas side alone: the 16 active usernames and emails plus the 2 aliases, so the list can be diffed by hand. Do not guess at Trade Show's roster.

- [ ] **Step 3: Bump versions and run every check**

```bash
sed -i '' 's/"version": "0.43.0"/"version": "0.44.0"/' apps/api/package.json apps/web/package.json packages/shared/package.json
sed -i '' "s/export const MIDAS_VERSION = '.*';/export const MIDAS_VERSION = '0.44.0';/" packages/shared/src/version.ts
(cd apps/api && npm run lint && npm run test) && (cd apps/web && npm run lint && npm run build)
git add -A apps packages && git commit -m "chore: bump version to 0.44.0"
```

- [ ] **Step 4: Merge and push**

```bash
git checkout main && git merge --no-ff <feature-branch> && git push origin main
```

- [ ] **Step 5: Deploy code to CT 3120**

No schema migrations in this plan — code and data only.

```bash
tar czf /tmp/tsfix.tgz apps/api/src apps/web/src apps/api/package.json apps/web/package.json packages/shared/src packages/shared/package.json
scp /tmp/tsfix.tgz root@192.168.1.190:/tmp/
ssh root@192.168.1.190 "pct push 3120 /tmp/tsfix.tgz /tmp/d.tgz && pct exec 3120 -- bash -c 'cd /opt/midas && tar xzf /tmp/d.tgz; rm -f /tmp/d.tgz; find . -name \"._*\" -delete'"
```

Check `git diff --diff-filter=D --name-only <merge-base> HEAD` — if this branch deleted any file, remove it explicitly on CT 3120, because a file-push deploy never deletes.

- [ ] **Step 6: Enable auto-provisioning — with a container recreate, not a restart**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && sed -i s/EXT_AUTO_PROVISION_USERS=false/EXT_AUTO_PROVISION_USERS=true/ .env && grep EXT_AUTO_PROVISION .env'"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose up -d --no-deps --force-recreate --build api'"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --no-deps --build web'"
```

`--force-recreate` is required: `env_file` values are injected when the container is created, so a plain restart would leave provisioning off while the file says on. Verify the value inside the running container, not just in the file:

```bash
ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 printenv EXT_AUTO_PROVISION_USERS"
```
Expected: `true`.

- [ ] **Step 7: Run the data repair against production**

Now, and only now, run Task 2's script against the real database — dry run first, read the numbers, then apply:

```bash
ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 npx tsx src/scripts/repair-company-integration-state.ts"
ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 npx tsx src/scripts/repair-company-integration-state.ts --apply"
ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 npx tsx src/scripts/repair-company-integration-state.ts"
```
Expected: 13 and 2, then the updates, then 0 and 0. If the container has no `npx`/source (it may run compiled `dist/`), run the script from your workstation against CT 3220's `DATABASE_URL` instead — check which works and report it.

- [ ] **Step 8: Issue the production connection**

```bash
ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 npx tsx src/scripts/create-ext-connection.ts trade_show_prod"
ssh root@192.168.1.190 "pct exec 3120 -- docker exec midas-api-1 npx tsx src/scripts/seed-trade-show-vocabulary.ts trade_show_prod"
```

**The API key prints once and is not recoverable.** Capture it and put it in your report — it has to reach the Trade Show team. Then verify the scoping:

```bash
ssh root@192.168.1.190 "pct exec 3220 -- su - postgres -c \"psql -d midas -At -c 'select ac.app_name, ac.is_active, count(acc.category_id) from app_connections ac left join app_connection_categories acc on acc.connection_id = ac.id group by 1,2 order by 1'\""
```
Expected: both connections active with 15 categories each.

- [ ] **Step 9: Verify in production**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://midas.booute.duckdns.org/         # 200
ssh root@192.168.1.190 "pct exec 3120 -- curl -s http://localhost:4000/api/v1/meta" # 0.44.0
ssh root@192.168.1.190 "pct exec 3120 -- docker logs midas-api-1 --tail 20"         # no crash loop
```

Then confirm no Summitt Labs expense is pushable any more:

```bash
ssh root@192.168.1.190 "pct exec 3220 -- su - postgres -c \"psql -d midas -At -c 'select c.zoho_enabled, e.integration_status, count(*) from expenses e join companies c on c.name = e.zoho_entity group by 1,2 order by 1,2'\""
```
Expected: no row with `zoho_enabled = f` and `integration_status = 'pending'`.

Finally, confirm the new key works end to end with a read-only call:

```bash
curl -s -H "Authorization: Bearer <the new key>" https://midas.booute.duckdns.org/api/v1/ext/health/vocabulary
```
Expected: `appName: "trade_show_prod"`, `categories.visible: 15`, `scoped: true`.

- [ ] **Step 10: Record what shipped**

Update `docs/trade-show-integration-response.md`: mark the six pre-cutover items done, note the shipped version, and add the `POSSIBLE_DUPLICATE` / `CATEGORY_FALLBACK` / `UNKNOWN_COMPANY` codes to the confirmations so the document matches reality. Commit and push.

- [ ] **Step 11: Report**

Cover: what shipped, the production repair numbers, the new connection name (and that its key is in the report), that auto-provisioning is verified `true` inside the container, the roster reconciliation result, and anything a Trade Show engineer must change on their side.
