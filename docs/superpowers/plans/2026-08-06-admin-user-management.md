# Admin User Delete + Role Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins hard-delete users (safe mode + explicit purge for users who own data) and change any user's role across all five roles.

**Architecture:** Pure guard logic in a new `lib/userDelete.ts` (Vitest-covered, no DB); a new `DELETE /admin/users/:id` route that counts owned data, refuses with 409 + counts unless `?purge=true`, and purges transactionally-ordered (files → expenses (cascades receipts/messages) → sent messages → captures → partner expenses → user). Role changes ride the existing `PATCH /admin/users/:id` with extended enum + guards. Web: role `<select>` per row and a Delete button with a two-stage `window.confirm`.

**Tech Stack:** Express + zod + Drizzle, React + TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-admin-user-management-design.md`

## Global Constraints

- Role enums everywhere become `['user', 'accountant', 'admin', 'partner', 'developer']`.
- Error codes exactly: `SELF_DELETE`, `SELF_ROLE_CHANGE`, `LAST_ADMIN` (all 400), `HAS_DATA`, `ZOHO_LINKED` (both 409).
- "Active admin" = `role='admin' AND is_active=true`; developers do NOT count.
- Audit actions: `admin.user.deleted`, `admin.user.purged` (counts in `metadata`).
- No schema changes, no migration.
- API tests: `cd apps/api && npm run test -- <file>`. Suite has 2 pre-existing failures (`zohoReadiness`, `mapOcrError`) — unrelated; do not count them as regressions.

---

### Task 1: Guard lib `userDelete.ts`

**Files:**
- Create: `apps/api/src/lib/userDelete.ts`
- Test: `apps/api/src/__tests__/userDelete.test.ts`

**Interfaces:**
- Produces (used by Task 2):

```ts
export type UserAdminDecision = { ok: true } | { ok: false; status: 400 | 409; code: string; message: string };
export interface OwnedCounts { expenses: number; receipts: number; messages: number; captures: number; partnerExpenses: number }
export function canDeleteUser(i: { actorId: string; targetId: string; targetRole: string; targetIsActive: boolean; activeAdminCount: number }): UserAdminDecision
export function canChangeRole(i: { actorId: string; targetId: string; targetRole: string; newRole: string; targetIsActive: boolean; activeAdminCount: number }): UserAdminDecision
export function hasOwnedData(c: OwnedCounts): boolean
```

- [ ] **Step 1: Write the failing test**

`apps/api/src/__tests__/userDelete.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canDeleteUser, canChangeRole, hasOwnedData } from '../lib/userDelete';

const base = { actorId: 'a1', targetId: 't1', targetRole: 'user', targetIsActive: true, activeAdminCount: 2 };

describe('canDeleteUser', () => {
  it('allows deleting a regular user', () => {
    expect(canDeleteUser(base)).toEqual({ ok: true });
  });

  it('blocks self-delete', () => {
    const d = canDeleteUser({ ...base, targetId: 'a1' });
    expect(d).toMatchObject({ ok: false, status: 400, code: 'SELF_DELETE' });
  });

  it('blocks deleting the last active admin', () => {
    const d = canDeleteUser({ ...base, targetRole: 'admin', activeAdminCount: 1 });
    expect(d).toMatchObject({ ok: false, status: 400, code: 'LAST_ADMIN' });
  });

  it('allows deleting an admin when another active admin remains', () => {
    expect(canDeleteUser({ ...base, targetRole: 'admin', activeAdminCount: 2 })).toEqual({ ok: true });
  });

  it('allows deleting an inactive admin even if admin count is 1', () => {
    expect(canDeleteUser({ ...base, targetRole: 'admin', targetIsActive: false, activeAdminCount: 1 })).toEqual({ ok: true });
  });
});

describe('canChangeRole', () => {
  it('allows promoting a user to partner', () => {
    expect(canChangeRole({ ...base, newRole: 'partner' })).toEqual({ ok: true });
  });

  it('blocks changing your own role', () => {
    const d = canChangeRole({ ...base, targetId: 'a1', newRole: 'user' });
    expect(d).toMatchObject({ ok: false, status: 400, code: 'SELF_ROLE_CHANGE' });
  });

  it('blocks demoting the last active admin', () => {
    const d = canChangeRole({ ...base, targetRole: 'admin', newRole: 'user', activeAdminCount: 1 });
    expect(d).toMatchObject({ ok: false, status: 400, code: 'LAST_ADMIN' });
  });

  it('allows admin → admin no-op and demotion when another admin exists', () => {
    expect(canChangeRole({ ...base, targetRole: 'admin', newRole: 'admin', activeAdminCount: 1 })).toEqual({ ok: true });
    expect(canChangeRole({ ...base, targetRole: 'admin', newRole: 'user', activeAdminCount: 2 })).toEqual({ ok: true });
  });
});

describe('hasOwnedData', () => {
  it('false when all counts are zero', () => {
    expect(hasOwnedData({ expenses: 0, receipts: 0, messages: 0, captures: 0, partnerExpenses: 0 })).toBe(false);
  });
  it('true when any count is nonzero', () => {
    expect(hasOwnedData({ expenses: 0, receipts: 0, messages: 1, captures: 0, partnerExpenses: 0 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `apps/api`): `npm run test -- src/__tests__/userDelete.test.ts`
Expected: FAIL — cannot resolve `../lib/userDelete`.

- [ ] **Step 3: Implement**

`apps/api/src/lib/userDelete.ts`:

```ts
/** Guard rules for admin user deletion and role changes. */

export type UserAdminDecision =
  | { ok: true }
  | { ok: false; status: 400 | 409; code: string; message: string };

export interface OwnedCounts {
  expenses: number;
  receipts: number;
  messages: number;
  captures: number;
  partnerExpenses: number;
}

export function canDeleteUser(i: {
  actorId: string;
  targetId: string;
  targetRole: string;
  targetIsActive: boolean;
  activeAdminCount: number;
}): UserAdminDecision {
  if (i.actorId === i.targetId) {
    return { ok: false, status: 400, code: 'SELF_DELETE', message: 'You cannot delete your own account' };
  }
  if (i.targetRole === 'admin' && i.targetIsActive && i.activeAdminCount <= 1) {
    return { ok: false, status: 400, code: 'LAST_ADMIN', message: 'Cannot delete the last active admin' };
  }
  return { ok: true };
}

export function canChangeRole(i: {
  actorId: string;
  targetId: string;
  targetRole: string;
  newRole: string;
  targetIsActive: boolean;
  activeAdminCount: number;
}): UserAdminDecision {
  if (i.actorId === i.targetId) {
    return { ok: false, status: 400, code: 'SELF_ROLE_CHANGE', message: 'You cannot change your own role' };
  }
  if (
    i.targetRole === 'admin' && i.newRole !== 'admin'
    && i.targetIsActive && i.activeAdminCount <= 1
  ) {
    return { ok: false, status: 400, code: 'LAST_ADMIN', message: 'Cannot demote the last active admin' };
  }
  return { ok: true };
}

export function hasOwnedData(c: OwnedCounts): boolean {
  return c.expenses > 0 || c.receipts > 0 || c.messages > 0 || c.captures > 0 || c.partnerExpenses > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (in `apps/api`): `npm run test -- src/__tests__/userDelete.test.ts`
Expected: PASS (11 assertions across 10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/userDelete.ts apps/api/src/__tests__/userDelete.test.ts
git commit -m "feat(api): user delete / role change guard logic"
```

---

### Task 2: API — DELETE route + PATCH role guards + extended enums

**Files:**
- Modify: `apps/api/src/routes/admin.ts` (imports, `createUserSchema:40`, `patchUserSchema:76`, PATCH handler `:80-124`, new DELETE handler after `:124`)

**Interfaces:**
- Consumes: Task 1 exports; `storage.delete(path)` from `../lib/storage`; drizzle tables `users, expenses, receipts, expenseMessages, captures, partnerExpenses` from `../db/schema`.
- Produces (Task 3 relies on): `DELETE /api/v1/admin/users/:id[?purge=true]` → `200 { ok: true, purged: boolean }`; `409` body `{ error: { code: 'HAS_DATA', message, counts: OwnedCounts } }` or `{ error: { code: 'ZOHO_LINKED', message } }`; `400` codes `SELF_DELETE` / `LAST_ADMIN` / `SELF_ROLE_CHANGE`. Error shape follows the app's `createError` middleware: `{ error: { code, message, ...extras } }`.

- [ ] **Step 1: Extend enums and imports**

In `apps/api/src/routes/admin.ts`:
- Both `z.enum(['user', 'accountant', 'admin'])` occurrences (create `:40`, patch `:76`) become `z.enum(['user', 'accountant', 'admin', 'partner', 'developer'])`.
- Extend the schema import to include `expenses, receipts, expenseMessages, captures, partnerExpenses`; import `and, count, inArray, isNotNull` from `drizzle-orm` (keep existing imports); add:

```ts
import { storage } from '../lib/storage';
import { canDeleteUser, canChangeRole, hasOwnedData, type OwnedCounts } from '../lib/userDelete';
```

- [ ] **Step 2: Add an active-admin counter helper (top of file, after `router.use`)**

```ts
async function countActiveAdmins(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
  return Number(row?.n ?? 0);
}
```

- [ ] **Step 3: Guard role changes in the PATCH handler**

In the PATCH handler, after the `target` lookup / not-found check and the existing self-deactivation guard, add:

```ts
  if (body.role !== undefined && body.role !== target.role) {
    const decision = canChangeRole({
      actorId: req.user!.id,
      targetId: target.id,
      targetRole: target.role,
      newRole: body.role,
      targetIsActive: target.isActive,
      activeAdminCount: await countActiveAdmins(),
    });
    if (!decision.ok) throw createError(decision.message, decision.status, decision.code);
  }
```

- [ ] **Step 4: Add the DELETE handler (after the PATCH handler)**

```ts
router.delete('/users/:id', asyncHandler(async (req, res) => {
  const purge = req.query.purge === 'true';

  const target = await db.query.users.findFirst({ where: eq(users.id, req.params.id) });
  if (!target) throw notFound('User not found');

  const decision = canDeleteUser({
    actorId: req.user!.id,
    targetId: target.id,
    targetRole: target.role,
    targetIsActive: target.isActive,
    activeAdminCount: await countActiveAdmins(),
  });
  if (!decision.ok) throw createError(decision.message, decision.status, decision.code);

  const owned = await db.query.expenses.findMany({
    where: eq(expenses.userId, target.id),
    columns: { id: true, zohoExpenseId: true },
    with: { receipts: { columns: { id: true, storagePath: true } } },
  });
  const [msgRow] = await db.select({ n: count() }).from(expenseMessages)
    .where(eq(expenseMessages.senderId, target.id));
  const [capRow] = await db.select({ n: count() }).from(captures)
    .where(eq(captures.userId, target.id));
  const [peRow] = await db.select({ n: count() }).from(partnerExpenses)
    .where(eq(partnerExpenses.userId, target.id));

  const counts: OwnedCounts = {
    expenses: owned.length,
    receipts: owned.reduce((n, e) => n + e.receipts.length, 0),
    messages: Number(msgRow?.n ?? 0),
    captures: Number(capRow?.n ?? 0),
    partnerExpenses: Number(peRow?.n ?? 0),
  };

  if (hasOwnedData(counts) && !purge) {
    throw createError('User owns data. Use purge to delete the user and all their data.', 409, 'HAS_DATA', { counts });
  }

  if (purge) {
    const zohoLinked = owned.filter((e) => e.zohoExpenseId).length;
    if (zohoLinked > 0) {
      throw createError(
        `${zohoLinked} expense(s) are synced to Zoho. Delete or unlink those expenses first.`,
        409, 'ZOHO_LINKED',
      );
    }
    for (const e of owned) {
      for (const r of e.receipts) await storage.delete(r.storagePath);
    }
    if (owned.length > 0) {
      await db.delete(expenses).where(inArray(expenses.id, owned.map((e) => e.id)));
    }
    await db.delete(expenseMessages).where(eq(expenseMessages.senderId, target.id));
    await db.delete(captures).where(eq(captures.userId, target.id));
    await db.delete(partnerExpenses).where(eq(partnerExpenses.userId, target.id));
  }

  await db.delete(users).where(eq(users.id, target.id));

  await auditLog({
    entityType: 'user',
    entityId: target.id,
    userId: req.user!.id,
    action: purge ? 'admin.user.purged' : 'admin.user.deleted',
    before: { email: target.email, name: target.name, role: target.role },
    metadata: { counts },
  });

  res.json({ ok: true, purged: purge });
}));
```

**Note on `createError`:** check its signature in `apps/api/src/middleware/error.ts`. If it does not accept an extras object as a 4th argument, attach counts by throwing the error after setting `err.extras = { counts }`, or extend `createError` to spread a 4th `extras` param into the JSON error body — whichever matches the existing error middleware. The response MUST end up as `{ error: { code: 'HAS_DATA', message, counts } }`.

- [ ] **Step 5: Verify**

Run (in `apps/api`): `npm run lint` — clean. `npm run test` — no NEW failures (the 2 pre-existing ones remain).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/middleware/error.ts
git commit -m "feat(api): admin user delete (safe + purge) and role-change guards"
```

(Include `error.ts` only if Step 4's note required touching it.)

---

### Task 3: Web — role select, Delete button, new role options

**Files:**
- Modify: `apps/web/src/pages/Admin.tsx` (create-form select `:124-132`, role cell `:174-182`, actions cell `:188-215`, mutations block `:62-74`)

**Interfaces:**
- Consumes: Task 2's DELETE endpoint and error shapes; existing `patchMutation` already accepts `{ id, role }`.

- [ ] **Step 1: Add the delete mutation (after `resetMutation`)**

```tsx
  const deleteMutation = useMutation({
    mutationFn: ({ id, purge }: { id: string; purge?: boolean }) =>
      client.delete(`/admin/users/${id}${purge ? '?purge=true' : ''}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  function handleDelete(u: { id: string; name: string }) {
    if (!window.confirm(`Delete ${u.name}? This cannot be undone.`)) return;
    deleteMutation.mutate({ id: u.id }, {
      onError: (err: any) => {
        const e = err?.response?.data?.error;
        if (e?.code === 'HAS_DATA') {
          const c = e.counts ?? {};
          const summary = [
            c.expenses ? `${c.expenses} expense(s)` : null,
            c.receipts ? `${c.receipts} receipt(s)` : null,
            c.messages ? `${c.messages} message(s)` : null,
            c.captures ? `${c.captures} capture(s)` : null,
            c.partnerExpenses ? `${c.partnerExpenses} partner expense(s)` : null,
          ].filter(Boolean).join(', ');
          if (window.confirm(`${u.name} owns: ${summary}.\n\nDelete the user AND all this data? This cannot be undone.`)) {
            deleteMutation.mutate({ id: u.id, purge: true }, {
              onError: (err2: any) => alert(err2?.response?.data?.error?.message ?? 'Delete failed'),
            });
          }
        } else {
          alert(e?.message ?? 'Delete failed');
        }
      },
    });
  }
```

- [ ] **Step 2: Role cell becomes a select**

Replace the `<span className="capitalize">{u.role}</span>` in the role cell (`:174-182`) with:

```tsx
                    <select
                      value={u.role}
                      onChange={(e) => patchMutation.mutate({ id: u.id, role: e.target.value })}
                      disabled={u.id === currentUser?.id || patchMutation.isPending}
                      title={u.id === currentUser?.id ? 'You cannot change your own role' : ''}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm capitalize text-gray-700 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:appearance-none"
                    >
                      {['user', 'accountant', 'admin', 'partner', 'developer'].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
```

(keep the SSO/Local badge `<span>` that follows). Add an `onError` to `patchMutation` so guard errors surface:

```tsx
  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; isActive?: boolean; role?: string }) =>
      client.patch(`/admin/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (err: any) => alert(err?.response?.data?.error?.message ?? 'Update failed'),
  });
```

- [ ] **Step 3: Delete button in the actions cell**

After the Reset Password button (`:214`), add:

```tsx
                      {u.id !== currentUser?.id && (
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={deleteMutation.isPending}
                          className="rounded border border-red-300 bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      )}
```

- [ ] **Step 4: New User form role options**

In the create-form `<select>` (`:129-131`), add:

```tsx
                <option value="partner">Partner</option>
                <option value="developer">Developer</option>
```

- [ ] **Step 5: Verify**

Run (in `apps/web`): `npm run lint` — clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Admin.tsx
git commit -m "feat(web): admin user delete with purge confirm + role assignment"
```

---

### Task 4: Final verification

- [ ] **Step 1:** Repo root `npm run lint` — all workspaces clean. `apps/api`: `npm run test` — only the 2 pre-existing failures.
- [ ] **Step 2:** Report: what shipped, error-code behaviors, and note the UI two-stage confirm flow.
