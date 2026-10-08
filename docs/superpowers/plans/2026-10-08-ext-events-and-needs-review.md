# Ext Events Hand-off and Accountant "Needs Review" Implementation Plan (Midas)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Midas tells accountants when an expense needs them, and hands every submitter-facing notification on an Argo-sourced expense to Argo through an ordered event feed plus a signed ping, instead of notifying the submitter itself.

**Architecture:** `notifyUser` gains one decision: when the recipient is the owner of an expense whose source app has events enabled, write a row to a new `ext_events` outbox and ping the app; otherwise behave as today. A new `GET /ext/events` feed serves the outbox by sequence number. Accountant `needs_review` notifications are one push per expense and one grouped, counted bell row per submitter per show or day. A sweep reports expenses still missing details 15 minutes after creation.

**Tech Stack:** Express + TypeScript, Drizzle ORM on Postgres with hand-written idempotent SQL migrations under `apps/api/drizzle/`, Vitest (pure unit tests, the database is always mocked), React + TanStack Query web app, web-push.

**Spec:** `docs/superpowers/specs/2026-10-08-midas-expense-notifications-design.md` (copied from the Argo repo; the Argo half is implemented by a separate plan in `trade-show-app`).

## Global Constraints

- Branch: `feat/ext-events-needs-review`. Target release **v1.21.0**.
- With `events_enabled = false` on every connection (the default), behaviour for every existing user is unchanged except: accountants receive `needs_review`, and categories have a new "needs accountant" flag.
- Hand off only when ALL hold: the recipient is the expense's owner; the expense has a `sourceApp`; an active connection for that source app has `events_enabled = true`; the expense has an `externalUserId`. When handing off, write exactly one `ext_events` row and send the ping; write no `notifications` row, send no Midas push and no email.
- Hand-off event types are exactly: `approved`, `rejected`, `action_required`, `message`, `mention`, `reimbursement_paid`, `expense_incomplete`.
- `needs_review` goes to active users with role `accountant` only (not admin, not developer), never to the submitter, and never by email.
- A notification failure never fails the request that caused it. `notifyUser` and `notifyNeedsReview` never throw; route call sites use `void fn(...)` or `await fn(...)` on a function that cannot reject.
- The ping carries no expense data: an empty JSON body and the headers `X-Midas-Timestamp` (Unix seconds) and `X-Midas-Signature` (hex HMAC-SHA256 of the timestamp string keyed with env `EXT_EVENTS_PING_SECRET`). 3-second timeout, fire-and-forget. No secret or no URL means no ping.
- Feed contract: `GET /ext/events?since=<seq>&limit=<n>` → `{ events: FeedEvent[], nextCursor: string | null }`, ascending by `seq`, `seq > since`, default limit 100, max 200, scope `events:read`, only the calling connection's source app.
- The existing `GET /ext/messages` feed is not changed or removed.
- Schema changes go in `apps/api/src/db/schema.ts` AND a hand-written idempotent SQL file `apps/api/drizzle/0033_ext_events_needs_review.sql` (`IF NOT EXISTS` everywhere). Never edit an existing migration file.
- Tests live in `apps/api/src/__tests__/*.test.ts`, never touch a real database (mock `../db/index` or the `*Db.ts` module), and run with `npm run test -w apps/api -- <file>`. Type-check with `npm run lint -w apps/api`.
- Repo convention: pure logic in `lib/<name>.ts`, database access for it in `lib/<name>Db.ts` (see `closedPeriods.ts` / `closedPeriodsDb.ts`).
- Do not use `git stash`. Do not push, merge or deploy. Never ship or modify `.env`.
- Every commit message ends with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer on its own line.

## Review Focus

1. **An accountant approves their own Argo-sourced expense, or an expense has a source app but no `externalUserId`.** Expected: no hand-off; the existing "never notify the actor" guards and native delivery apply. Pinned in Task 2 (`shouldHandOff`).
2. **Writing the `ext_events` row fails (database error).** Expected: the accountant's approve/reject still succeeds, the failure is logged, nothing is sent natively as a half-measure. Pinned in Task 3.
3. **Two expenses from one submitter arrive at the same moment.** Expected: one grouped bell row with count 2, not two rows; two pushes. Pinned in Task 5 (the upsert SQL's conflict target, asserted as text) and listed for the post-deploy check.
4. **The first sweep after deploy sees every old pending expense.** Expected: nobody is told about expenses created before this release. Pinned in Task 1 (migration backfill) and Task 7 (selection requires the stamp to be null).
5. **A caller sends `since=abc`, `since=-1`, or `limit=100000`.** Expected: 400 for a bad cursor, limit clamped to 200. Pinned in Task 2 (`parseSince`, `clampLimit`).

## File Structure

New:

| File | Responsibility |
|---|---|
| `apps/api/drizzle/0033_ext_events_needs_review.sql` | All schema changes for this release |
| `apps/api/src/lib/extEvents.ts` | Pure: hand-off decision, payload builder, feed cursor/limit parsing, row → feed event |
| `apps/api/src/lib/extEventsDb.ts` | Load the hand-off context for an expense, record an event, list events, list event-enabled source apps |
| `apps/api/src/lib/extPing.ts` | Sign and send the ping |
| `apps/api/src/lib/needsReview.ts` | Pure: group key, group target, bell text, push text |
| `apps/api/src/lib/needsReviewDb.ts` | Active accountants, grouped upsert, expense load |
| `apps/api/src/lib/notifyNeedsReview.ts` | Orchestrates one `needs_review` send; never throws |
| `apps/api/src/lib/incompleteSweep.ts` | Pure `missingDetails` + the 5-minute scheduler |
| `apps/api/src/lib/incompleteSweepDb.ts` | Claim due expenses (stamp first) |
| `apps/api/src/__tests__/fixtures/extEvents.json` | Feed contract fixture, byte-identical to Argo's copy |

Modified: `db/schema.ts`, `config/env.ts`, `lib/notify.ts`, `lib/notifyMessages.ts`, `lib/notificationLinks.ts`, `lib/expenseThreadDb.ts`, `lib/pendingCompletionDb.ts`, `middleware/requireScope.ts`, `routes/ext.ts`, `routes/expenses.ts`, `routes/extensionExpenses.ts`, `routes/accountant.ts`, `routes/admin.ts`, `routes/notifications.ts`, `server.ts`, `apps/web/src/pages/settings/CategoriesSection.tsx`, `apps/web/src/types/index.ts`, docs and version files.

---

### Task 1: Schema and migration 0033

**Files:**
- Create: `apps/api/drizzle/0033_ext_events_needs_review.sql`
- Modify: `apps/api/src/db/schema.ts`

**Interfaces:**
- Produces (Drizzle): `appConnections.eventsEnabled`, `appConnections.eventsPingUrl`, `expenseCategories.needsAccountant`, `expenses.incompleteNotifiedAt`, `notifications.groupKey`, `notifications.count`, table `extEvents { seq, id, sourceApp, type, expenseId, payload, createdAt }`, and the exported type `ExtEventPayload`.

- [ ] **Step 1: Write the SQL migration**

```sql
-- apps/api/drizzle/0033_ext_events_needs_review.sql
-- Ext event hand-off (v1.21.0): submitter-facing notifications on an
-- external app's expenses are recorded here for that app to pull, instead of
-- being delivered by Midas. Plus grouped accountant "needs review"
-- notifications and the category flag that asks for the accountant.

ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS events_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS events_ping_url text;

ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS needs_accountant boolean NOT NULL DEFAULT false;

-- When the missing-details sweep looked at this expense. Set once, whether or
-- not anything was missing, so no expense is examined twice.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS incomplete_notified_at timestamp;
-- Everything that exists today predates the sweep: mark it looked-at so the
-- first pass after deploy tells nobody about old expenses.
UPDATE expenses SET incomplete_notified_at = now() WHERE incomplete_notified_at IS NULL;

-- Grouped bell rows: one unread row per recipient per group, with a count.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_key text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS count integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_unread_group_idx
  ON notifications (user_id, group_key)
  WHERE read_at IS NULL AND group_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ext_events (
  seq         bigserial PRIMARY KEY,
  id          uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  source_app  text NOT NULL,
  type        text NOT NULL,
  expense_id  uuid REFERENCES expenses(id) ON DELETE CASCADE,
  payload     jsonb NOT NULL,
  created_at  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ext_events_source_app_seq_idx ON ext_events (source_app, seq);
```

- [ ] **Step 2: Mirror it in the Drizzle schema**

In `apps/api/src/db/schema.ts`:

Add `bigserial` to the `drizzle-orm/pg-core` import list.

Below the `ExpenseSourceContext` type add:

```ts
/** Snapshot an external app needs to notify its own user (see lib/extEvents). */
export type ExtEventPayload = {
  externalUserId: string;
  expense: { id: string; sourceRefId: string | null; merchant: string; amount: string; status: string };
  senderName?: string;
  excerpt?: string;
  messageId?: string;
  requestType?: string;
  note?: string;
  missing?: string[];
};
```

In `expenseCategories`, after `isActive`:

```ts
  /** "Ask the accountant": an expense in this category always notifies accountants, even when auto-approved. */
  needsAccountant: boolean('needs_accountant').default(false).notNull(),
```

In `expenses`, after `receiptWaivedAt`:

```ts
  /** When the missing-details sweep looked at this expense (set once; see lib/incompleteSweep). */
  incompleteNotifiedAt: timestamp('incomplete_notified_at'),
```

In `appConnections`, after `isActive`:

```ts
  /** When true, submitter-facing notifications for this app's expenses go to ext_events instead of Midas delivery. */
  eventsEnabled: boolean('events_enabled').default(false).notNull(),
  /** Where to POST the signed "you have events" ping. Null = no ping. */
  eventsPingUrl: text('events_ping_url'),
```

In `notifications`, update the type comment to include `'needs_review'`, add after `expenseId`:

```ts
  /** Set on grouped rows (needs_review): one unread row per user per key. */
  groupKey: text('group_key'),
  /** How many events this row stands for; the unread badge sums it. */
  count: integer('count').default(1).notNull(),
```

and add to its index list:

```ts
  uniqueIndex('notifications_unread_group_idx').on(t.userId, t.groupKey)
    .where(sql`read_at is null and group_key is not null`),
```

Directly below the `notifications` table add:

```ts
// ── Ext events ────────────────────────────────────────────────────────────────
// Outbox of submitter-facing events on an external app's expenses. The app
// pulls these by seq (GET /ext/events); Midas keeps no delivery state.

export const extEvents = pgTable('ext_events', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  id: uuid('id').defaultRandom().notNull().unique(),
  sourceApp: text('source_app').notNull(),
  type: text('type').notNull(),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<ExtEventPayload>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('ext_events_source_app_seq_idx').on(t.sourceApp, t.seq),
]);
```

- [ ] **Step 3: Type-check and run the suite**

Run (repo root): `npm run lint -w apps/api && npm run test -w apps/api`
Expected: no type errors; the existing suite passes unchanged.

- [ ] **Step 4: Prove the SQL applies on top of 0000–0032**

Run against a throwaway Postgres (requires Docker; if Docker is not available, say so in the report and skip this step, do not use the developer's local database):

```bash
docker run -d --rm --name midas-mig-check -e POSTGRES_PASSWORD=x -e POSTGRES_DB=midas -p 55433:5432 postgres:16
until docker exec midas-mig-check pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
( cd apps/api && DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/midas npx tsx src/db/runSqlMigrations.ts ) 2>&1 | tail -8
docker exec midas-mig-check psql -U postgres -d midas -tAc "select count(*) from information_schema.columns where (table_name,column_name) in (('app_connections','events_enabled'),('app_connections','events_ping_url'),('expense_categories','needs_accountant'),('expenses','incomplete_notified_at'),('notifications','group_key'),('notifications','count')); select to_regclass('public.ext_events') is not null;"
docker stop midas-mig-check
```

Expected: the runner prints `applied 0033_ext_events_needs_review`; the two queries print `6` and `t`.

If the runner fails on an EARLIER migration (the numbered files may assume a base schema that production got from `db:push`), do not work around it with stand-in tables. Record the exact error, stop the container, and report DONE_WITH_CONCERNS so the controller verifies the migration against the real schema at deploy.

- [ ] **Step 5: Commit**

```bash
git add apps/api/drizzle/0033_ext_events_needs_review.sql apps/api/src/db/schema.ts
git commit -m "feat(ext-events): schema for the event outbox, grouped notifications and the needs-accountant flag"
```

---

### Task 2: Hand-off building blocks (pure logic, outbox access, ping)

**Files:**
- Create: `apps/api/src/lib/extEvents.ts`, `apps/api/src/lib/extEventsDb.ts`, `apps/api/src/lib/extPing.ts`, `apps/api/src/__tests__/fixtures/extEvents.json`
- Modify: `apps/api/src/config/env.ts`
- Test: `apps/api/src/__tests__/extEvents.test.ts`, `apps/api/src/__tests__/extPing.test.ts`

**Interfaces:**
- Consumes: `extEvents`, `appConnections`, `expenses`, `ExtEventPayload` (Task 1); `NotificationInput` from `lib/notifyMessages`.
- Produces:
  - `HANDOFF_TYPES: readonly string[]`
  - `shouldHandOff(i: { type: string; recipientId: string; ownerId: string; sourceApp: string | null; externalUserId: string | null; eventsEnabled: boolean }): boolean`
  - `interface HandOffExpense { id: string; userId: string; sourceApp: string | null; sourceRefId: string | null; externalUserId: string | null; merchant: string; amount: string; status: string }`
  - `buildExtEventPayload(expense: HandOffExpense, input: { senderName?: string; excerpt?: string; messageId?: string; requestType?: string; note?: string; missing?: string[] }): ExtEventPayload`
  - `parseSince(raw: unknown): number | null` (null = invalid), `clampLimit(raw: unknown): number`
  - `interface FeedEvent` and `toFeedEvent(row: { seq: number; id: string; type: string; createdAt: Date; payload: ExtEventPayload }): FeedEvent`
  - `loadHandOffContext(expenseId: string): Promise<{ expense: HandOffExpense; eventsEnabled: boolean; pingUrls: string[] } | null>`
  - `recordExtEvent(e: { sourceApp: string; type: string; expenseId: string; payload: ExtEventPayload }): Promise<void>`
  - `listExtEvents(sourceApp: string, since: number, limit: number): Promise<Array<{ seq: number; id: string; type: string; createdAt: Date; payload: ExtEventPayload }>>`
  - `eventEnabledSourceApps(): Promise<string[]>`
  - `signPing(secret: string, timestamp: string): string`, `sendPings(urls: string[]): Promise<void>` (never throws)
  - env `EXT_EVENTS_PING_SECRET?: string`

- [ ] **Step 1: Write the contract fixture**

`apps/api/src/__tests__/fixtures/extEvents.json` (the Argo repo holds a byte-identical copy at `backend/tests/fixtures/midasEvents.json`; do not reformat it):

```json
{
  "rows": [
    { "seq": 41, "id": "11111111-1111-4111-8111-111111111111", "type": "approved", "createdAt": "2026-10-08T15:00:00.000Z",
      "payload": { "externalUserId": "argo-user-1", "expense": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sourceRefId": "argo-exp-1", "merchant": "Staples", "amount": "42.10", "status": "approved" } } },
    { "seq": 42, "id": "22222222-2222-4222-8222-222222222222", "type": "rejected", "createdAt": "2026-10-08T15:01:00.000Z",
      "payload": { "externalUserId": "argo-user-1", "expense": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sourceRefId": "argo-exp-1", "merchant": "Staples", "amount": "42.10", "status": "rejected" }, "note": "Duplicate submission" } },
    { "seq": 43, "id": "33333333-3333-4333-8333-333333333333", "type": "message", "createdAt": "2026-10-08T15:02:00.000Z",
      "payload": { "externalUserId": "argo-user-1", "expense": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sourceRefId": "argo-exp-1", "merchant": "Staples", "amount": "42.10", "status": "pending" }, "senderName": "Rita", "excerpt": "Which show was this for?", "messageId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    { "seq": 44, "id": "44444444-4444-4444-8444-444444444444", "type": "action_required", "createdAt": "2026-10-08T15:03:00.000Z",
      "payload": { "externalUserId": "argo-user-1", "expense": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sourceRefId": "argo-exp-1", "merchant": "Staples", "amount": "42.10", "status": "awaiting_info" }, "senderName": "Rita", "excerpt": "Please attach the itemised receipt", "requestType": "missing_receipt" } },
    { "seq": 45, "id": "55555555-5555-4555-8555-555555555555", "type": "expense_incomplete", "createdAt": "2026-10-08T15:04:00.000Z",
      "payload": { "externalUserId": "argo-user-2", "expense": { "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "sourceRefId": null, "merchant": "Uber", "amount": "18.00", "status": "pending" }, "missing": ["receipt", "payment method"] } }
  ],
  "events": [
    { "seq": 41, "id": "11111111-1111-4111-8111-111111111111", "type": "approved", "createdAt": "2026-10-08T15:00:00.000Z",
      "externalUserId": "argo-user-1", "expense": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sourceRefId": "argo-exp-1", "merchant": "Staples", "amount": "42.10", "status": "approved" } },
    { "seq": 42, "id": "22222222-2222-4222-8222-222222222222", "type": "rejected", "createdAt": "2026-10-08T15:01:00.000Z",
      "externalUserId": "argo-user-1", "expense": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sourceRefId": "argo-exp-1", "merchant": "Staples", "amount": "42.10", "status": "rejected" }, "note": "Duplicate submission" },
    { "seq": 43, "id": "33333333-3333-4333-8333-333333333333", "type": "message", "createdAt": "2026-10-08T15:02:00.000Z",
      "externalUserId": "argo-user-1", "expense": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sourceRefId": "argo-exp-1", "merchant": "Staples", "amount": "42.10", "status": "pending" }, "senderName": "Rita", "excerpt": "Which show was this for?", "messageId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { "seq": 44, "id": "44444444-4444-4444-8444-444444444444", "type": "action_required", "createdAt": "2026-10-08T15:03:00.000Z",
      "externalUserId": "argo-user-1", "expense": { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sourceRefId": "argo-exp-1", "merchant": "Staples", "amount": "42.10", "status": "awaiting_info" }, "senderName": "Rita", "excerpt": "Please attach the itemised receipt", "requestType": "missing_receipt" },
    { "seq": 45, "id": "55555555-5555-4555-8555-555555555555", "type": "expense_incomplete", "createdAt": "2026-10-08T15:04:00.000Z",
      "externalUserId": "argo-user-2", "expense": { "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "sourceRefId": null, "merchant": "Uber", "amount": "18.00", "status": "pending" }, "missing": ["receipt", "payment method"] }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/api/src/__tests__/extEvents.test.ts
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/extEvents.json';
import {
  HANDOFF_TYPES, shouldHandOff, buildExtEventPayload, parseSince, clampLimit, toFeedEvent,
} from '../lib/extEvents';

const base = {
  type: 'approved', recipientId: 'owner', ownerId: 'owner',
  sourceApp: 'trade_show', externalUserId: 'argo-user-1', eventsEnabled: true,
};

describe('shouldHandOff', () => {
  it('hands off an owner-facing event on an event-enabled app expense', () => {
    expect(shouldHandOff(base)).toBe(true);
  });
  it.each(HANDOFF_TYPES)('covers %s', (type) => {
    expect(shouldHandOff({ ...base, type })).toBe(true);
  });
  it('never hands off to someone who is not the owner (staff replies, mentions of staff)', () => {
    expect(shouldHandOff({ ...base, recipientId: 'accountant' })).toBe(false);
  });
  it('does not hand off when the switch is off', () => {
    expect(shouldHandOff({ ...base, eventsEnabled: false })).toBe(false);
  });
  it('does not hand off a native Midas expense', () => {
    expect(shouldHandOff({ ...base, sourceApp: null })).toBe(false);
  });
  it('does not hand off when the app never told us who its user is', () => {
    expect(shouldHandOff({ ...base, externalUserId: null })).toBe(false);
    expect(shouldHandOff({ ...base, externalUserId: '' })).toBe(false);
  });
  it('does not hand off types the external app does not know (needs_review)', () => {
    expect(shouldHandOff({ ...base, type: 'needs_review' })).toBe(false);
  });
});

describe('buildExtEventPayload', () => {
  const expense = {
    id: 'e-1', userId: 'owner', sourceApp: 'trade_show', sourceRefId: 'argo-exp-1',
    externalUserId: 'argo-user-1', merchant: 'Staples', amount: '42.10', status: 'rejected',
  };
  it('snapshots the expense and carries only the fields that were supplied', () => {
    expect(buildExtEventPayload(expense, { note: 'Duplicate submission' })).toEqual({
      externalUserId: 'argo-user-1',
      expense: { id: 'e-1', sourceRefId: 'argo-exp-1', merchant: 'Staples', amount: '42.10', status: 'rejected' },
      note: 'Duplicate submission',
    });
  });
  it('omits empty and undefined optional fields', () => {
    const payload = buildExtEventPayload(expense, { senderName: undefined, excerpt: '', missing: [] });
    expect(Object.keys(payload).sort()).toEqual(['expense', 'externalUserId']);
  });
});

describe('feed helpers', () => {
  it('parseSince accepts a missing cursor and whole non-negative numbers only', () => {
    expect(parseSince(undefined)).toBe(0);
    expect(parseSince('')).toBe(0);
    expect(parseSince('41')).toBe(41);
    expect(parseSince('abc')).toBeNull();
    expect(parseSince('-1')).toBeNull();
    expect(parseSince('1.5')).toBeNull();
    expect(parseSince(['1'])).toBeNull();
  });
  it('clampLimit defaults to 100 and caps at 200', () => {
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit('5')).toBe(5);
    expect(clampLimit('100000')).toBe(200);
    expect(clampLimit('0')).toBe(100);
    expect(clampLimit('nope')).toBe(100);
  });
  it('toFeedEvent produces exactly the contract shape (shared fixture with Argo)', () => {
    const produced = fixture.rows.map((r) => toFeedEvent({ ...r, createdAt: new Date(r.createdAt) } as never));
    expect(produced).toEqual(fixture.events);
  });
});
```

```ts
// apps/api/src/__tests__/extPing.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../config/env', () => ({ env: { EXT_EVENTS_PING_SECRET: 'shh' } }));
vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { env } from '../config/env';
import { signPing, sendPings } from '../lib/extPing';

describe('signPing', () => {
  it('is the hex HMAC-SHA256 of the timestamp string', () => {
    const expected = crypto.createHmac('sha256', 'shh').update('1760000000').digest('hex');
    expect(signPing('shh', '1760000000')).toBe(expected);
  });
});

describe('sendPings', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
    (env as { EXT_EVENTS_PING_SECRET?: string }).EXT_EVENTS_PING_SECRET = 'shh';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs an empty JSON body with a timestamp and its signature, and no expense data', async () => {
    await sendPings(['http://argo.test/api/midas/events-ping']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://argo.test/api/midas/events-ping');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    const ts = init.headers['X-Midas-Timestamp'];
    expect(ts).toMatch(/^\d{10}$/);
    expect(init.headers['X-Midas-Signature']).toBe(signPing('shh', ts));
    expect(init.signal).toBeDefined();
  });

  it('sends nothing without a secret or without URLs', async () => {
    await sendPings([]);
    (env as { EXT_EVENTS_PING_SECRET?: string }).EXT_EVENTS_PING_SECRET = undefined;
    await sendPings(['http://argo.test/x']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the other side is down, and still tries the next URL', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(sendPings(['http://a.test/x', 'http://b.test/x'])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run test -w apps/api -- extEvents extPing`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement the pure module**

```ts
// apps/api/src/lib/extEvents.ts
/**
 * Hand-off of submitter-facing notifications to the external app that owns
 * the expense. Pure: no db, no env. The app pulls what is recorded here from
 * GET /ext/events; Midas then sends that person nothing itself.
 */
import type { ExtEventPayload } from '../db/schema';

/** Notification types an external app is told about. needs_review is Midas-only. */
export const HANDOFF_TYPES = [
  'approved', 'rejected', 'action_required', 'message', 'mention',
  'reimbursement_paid', 'expense_incomplete',
] as const;

export interface HandOffDecisionInput {
  type: string;
  recipientId: string;
  ownerId: string;
  sourceApp: string | null;
  externalUserId: string | null;
  /** An active connection for sourceApp has events_enabled. */
  eventsEnabled: boolean;
}

/**
 * Only the expense's own submitter is handed off, and only when the app has
 * told us who that is. Everyone else (staff, a mentioned accountant) is a
 * Midas user and is notified here as usual.
 */
export function shouldHandOff(i: HandOffDecisionInput): boolean {
  return i.eventsEnabled
    && Boolean(i.sourceApp)
    && Boolean(i.externalUserId)
    && i.recipientId === i.ownerId
    && (HANDOFF_TYPES as readonly string[]).includes(i.type);
}

export interface HandOffExpense {
  id: string;
  userId: string;
  sourceApp: string | null;
  sourceRefId: string | null;
  externalUserId: string | null;
  merchant: string;
  amount: string;
  status: string;
}

export interface HandOffDetails {
  senderName?: string;
  excerpt?: string;
  messageId?: string;
  requestType?: string;
  note?: string;
  missing?: string[];
}

/** Everything the app needs to word its own notification, so it never calls back. */
export function buildExtEventPayload(expense: HandOffExpense, input: HandOffDetails): ExtEventPayload {
  return {
    externalUserId: expense.externalUserId ?? '',
    expense: {
      id: expense.id,
      sourceRefId: expense.sourceRefId,
      merchant: expense.merchant,
      amount: String(expense.amount),
      status: expense.status,
    },
    ...(input.senderName ? { senderName: input.senderName } : {}),
    ...(input.excerpt ? { excerpt: input.excerpt } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.requestType ? { requestType: input.requestType } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.missing && input.missing.length > 0 ? { missing: input.missing } : {}),
  };
}

/** The `since` cursor: the last seq the caller processed. Null means invalid. */
export function parseSince(raw: unknown): number | null {
  if (raw === undefined || raw === '') return 0;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export function clampLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export interface FeedEvent extends ExtEventPayload {
  seq: number;
  id: string;
  type: string;
  createdAt: string;
}

export interface ExtEventRow {
  seq: number;
  id: string;
  type: string;
  createdAt: Date;
  payload: ExtEventPayload;
}

/** The wire shape of one event: envelope fields first, then the payload, flat. */
export function toFeedEvent(row: ExtEventRow): FeedEvent {
  return {
    seq: Number(row.seq),
    id: row.id,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    ...row.payload,
  };
}
```

- [ ] **Step 5: Implement the database access**

```ts
// apps/api/src/lib/extEventsDb.ts
import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../db/index';
import { appConnections, expenses, extEvents, type ExtEventPayload } from '../db/schema';
import type { ExtEventRow, HandOffExpense } from './extEvents';

/** Active, events-enabled connections that speak for a source app (see lib/ext/connectionScope). */
function enabledConnectionsFor(sourceApp: string) {
  return and(
    eq(appConnections.isActive, true),
    eq(appConnections.eventsEnabled, true),
    or(
      eq(appConnections.sourceApp, sourceApp),
      and(isNull(appConnections.sourceApp), eq(appConnections.appName, sourceApp)),
    ),
  );
}

export interface HandOffContext {
  expense: HandOffExpense;
  eventsEnabled: boolean;
  pingUrls: string[];
}

/** What notifyUser needs to decide a hand-off. Null when the expense is gone. */
export async function loadHandOffContext(expenseId: string): Promise<HandOffContext | null> {
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
    columns: {
      id: true, userId: true, sourceApp: true, sourceRefId: true,
      externalUserId: true, merchant: true, amount: true, status: true,
    },
  });
  if (!expense) return null;
  if (!expense.sourceApp || !expense.externalUserId) {
    return { expense, eventsEnabled: false, pingUrls: [] };
  }

  const conns = await db.query.appConnections.findMany({
    where: enabledConnectionsFor(expense.sourceApp),
    columns: { eventsPingUrl: true },
  });
  return {
    expense,
    eventsEnabled: conns.length > 0,
    pingUrls: conns.map((c) => c.eventsPingUrl).filter((u): u is string => Boolean(u)),
  };
}

export async function recordExtEvent(e: {
  sourceApp: string; type: string; expenseId: string; payload: ExtEventPayload;
}): Promise<void> {
  await db.insert(extEvents).values(e);
}

export async function listExtEvents(sourceApp: string, since: number, limit: number): Promise<ExtEventRow[]> {
  return db.select({
    seq: extEvents.seq, id: extEvents.id, type: extEvents.type,
    createdAt: extEvents.createdAt, payload: extEvents.payload,
  })
    .from(extEvents)
    .where(and(eq(extEvents.sourceApp, sourceApp), gt(extEvents.seq, since)))
    .orderBy(asc(extEvents.seq))
    .limit(limit);
}

/** Source apps with at least one active, events-enabled connection (for the sweep). */
export async function eventEnabledSourceApps(): Promise<string[]> {
  const conns = await db.query.appConnections.findMany({
    where: and(eq(appConnections.isActive, true), eq(appConnections.eventsEnabled, true)),
    columns: { appName: true, sourceApp: true },
  });
  return [...new Set(conns.map((c) => c.sourceApp ?? c.appName))];
}
```

- [ ] **Step 6: Implement the ping and the env var**

In `apps/api/src/config/env.ts`, directly after the `VAPID_SUBJECT` line:

```ts
  // ── Ext events ping ────────────────────────────────────────────────────────
  // Shared secret for the "you have events" ping to an external app (see
  // lib/extPing). Unset = no pings; the app's own poll still delivers.
  EXT_EVENTS_PING_SECRET: z.string().optional(),
```

```ts
// apps/api/src/lib/extPing.ts
/**
 * The "you have events" ping. It carries no expense data: the receiving app
 * answers by pulling GET /ext/events. Fire-and-forget; the app's own timer
 * is the safety net, so a lost ping costs a short delay and nothing else.
 */
import crypto from 'node:crypto';
import { env } from '../config/env';
import { logger } from './logger';

const PING_TIMEOUT_MS = 3_000;

/** Hex HMAC-SHA256 of the timestamp string. The receiver recomputes it. */
export function signPing(secret: string, timestamp: string): string {
  return crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
}

/** Ping each URL once. Never throws. */
export async function sendPings(urls: string[]): Promise<void> {
  const secret = env.EXT_EVENTS_PING_SECRET;
  if (!secret || urls.length === 0) return;

  for (const url of urls) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Midas-Timestamp': timestamp,
          'X-Midas-Signature': signPing(secret, timestamp),
        },
        body: '{}',
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!res.ok) logger.warn({ url, status: res.status }, 'Ext events ping was not accepted');
    } catch (err) {
      logger.warn({ err, url }, 'Ext events ping failed');
    }
  }
}
```

- [ ] **Step 7: Run the tests and type-check**

Run: `npm run test -w apps/api -- extEvents extPing && npm run lint -w apps/api`
Expected: all PASS, no type errors. If importing the JSON fixture fails type-checking, check `resolveJsonModule` in `apps/api/tsconfig.json`; if it is off, read the fixture in the test with `JSON.parse(readFileSync(new URL('./fixtures/extEvents.json', import.meta.url), 'utf8'))` (or `path.join(__dirname, …)` if the test files are CommonJS) rather than changing tsconfig.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/extEvents.ts apps/api/src/lib/extEventsDb.ts apps/api/src/lib/extPing.ts apps/api/src/config/env.ts apps/api/src/__tests__/extEvents.test.ts apps/api/src/__tests__/extPing.test.ts apps/api/src/__tests__/fixtures/extEvents.json
git commit -m "feat(ext-events): hand-off decision, event outbox access and the signed ping"
```

---

### Task 3: `notifyUser` hands off

**Files:**
- Modify: `apps/api/src/lib/notify.ts`, `apps/api/src/lib/notifyMessages.ts` (two optional fields), `apps/api/src/lib/expenseThreadDb.ts` (pass `messageId`), `apps/api/src/routes/accountant.ts` (pass `requestType`)
- Test: `apps/api/src/__tests__/notifyHandOff.test.ts`

**Interfaces:**
- Consumes: `shouldHandOff`, `buildExtEventPayload` (Task 2); `loadHandOffContext`, `recordExtEvent` (Task 2); `sendPings` (Task 2).
- Produces: `notifyUser` unchanged in signature; `NotificationInput` gains `messageId?: string` and `requestType?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/__tests__/notifyHandOff.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => {
  const returning = vi.fn(async () => [{ id: 'n-1' }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const findFirst = vi.fn(async () => ({ email: 'owner@x.test', role: 'user' }));
  return { returning, values, insert, findFirst };
});
vi.mock('../db/index', () => ({
  db: { query: { users: { findFirst: dbMock.findFirst } }, insert: dbMock.insert, update: vi.fn() },
}));
vi.mock('../config/env', () => ({ env: { CORS_ORIGIN: 'http://midas.test', MIDAS_WEB_BASE_URL: '' } }));
vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/email', () => ({ sendEmail: vi.fn(async () => true) }));
vi.mock('../lib/push', () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock('../lib/extEventsDb', () => ({ loadHandOffContext: vi.fn(), recordExtEvent: vi.fn(async () => undefined) }));
vi.mock('../lib/extPing', () => ({ sendPings: vi.fn(async () => undefined) }));

import { notifyUser } from '../lib/notify';
import { loadHandOffContext, recordExtEvent } from '../lib/extEventsDb';
import { sendPings } from '../lib/extPing';
import { sendPushToUser } from '../lib/push';
import { sendEmail } from '../lib/email';
import { logger } from '../lib/logger';

const expense = {
  id: 'e-1', userId: 'owner', sourceApp: 'trade_show', sourceRefId: 'argo-exp-1',
  externalUserId: 'argo-user-1', merchant: 'Staples', amount: '42.10', status: 'rejected',
};
const input = { expenseId: 'e-1', merchant: 'Staples', amount: '42.10', note: 'Duplicate submission' };
const flush = () => new Promise((r) => setImmediate(r));

describe('notifyUser hand-off', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records one event, pings, and delivers nothing natively', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: true, pingUrls: ['http://argo.test/ping'] });
    await notifyUser('owner', 'rejected', input);
    await flush();
    expect(recordExtEvent).toHaveBeenCalledTimes(1);
    expect(recordExtEvent).toHaveBeenCalledWith({
      sourceApp: 'trade_show', type: 'rejected', expenseId: 'e-1',
      payload: {
        externalUserId: 'argo-user-1',
        expense: { id: 'e-1', sourceRefId: 'argo-exp-1', merchant: 'Staples', amount: '42.10', status: 'rejected' },
        note: 'Duplicate submission',
      },
    });
    expect(sendPings).toHaveBeenCalledWith(['http://argo.test/ping']);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('carries the message fields for a conversation event', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: true, pingUrls: [] });
    await notifyUser('owner', 'message', { ...input, note: undefined, senderName: 'Rita', excerpt: 'Which show?', messageId: 'm-1' }, { email: false });
    expect(vi.mocked(recordExtEvent).mock.calls[0][0].payload).toEqual(expect.objectContaining({
      senderName: 'Rita', excerpt: 'Which show?', messageId: 'm-1',
    }));
  });

  it('delivers natively, exactly as before, when the switch is off', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: false, pingUrls: [] });
    await notifyUser('owner', 'rejected', input);
    await flush();
    expect(recordExtEvent).not.toHaveBeenCalled();
    expect(sendPings).not.toHaveBeenCalled();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('delivers natively to a non-owner even when the switch is on (a staff reply recipient)', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: true, pingUrls: ['http://argo.test/ping'] });
    await notifyUser('accountant-1', 'message', { ...input, ownerId: 'owner', toStaff: true }, { email: false });
    expect(recordExtEvent).not.toHaveBeenCalled();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('delivers natively when the expense has gone', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce(null);
    await notifyUser('owner', 'approved', input);
    expect(recordExtEvent).not.toHaveBeenCalled();
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('never throws and sends nothing natively when the outbox write fails', async () => {
    vi.mocked(loadHandOffContext).mockResolvedValueOnce({ expense, eventsEnabled: true, pingUrls: ['http://argo.test/ping'] });
    vi.mocked(recordExtEvent).mockRejectedValueOnce(new Error('db down'));
    await expect(notifyUser('owner', 'approved', input)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    expect(sendPings).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w apps/api -- notifyHandOff`
Expected: FAIL: `recordExtEvent` never called (native delivery happens in every case).

- [ ] **Step 3: Implement**

In `apps/api/src/lib/notifyMessages.ts`, add to `NotificationInput` (after `toStaff`):

```ts
  /** The message this notification is about, when it is about one. */
  messageId?: string;
  /** What an info request asked for (accountant "request info"). */
  requestType?: string;
```

In `apps/api/src/lib/notify.ts`, add imports:

```ts
import { shouldHandOff, buildExtEventPayload } from './extEvents';
import { loadHandOffContext, recordExtEvent } from './extEventsDb';
import { sendPings } from './extPing';
```

add this function above `notifyUser`:

```ts
/**
 * Hand the notification to the external app that owns the expense, when it
 * is addressed to that app's own user (see lib/extEvents). True means the
 * event was recorded and Midas must deliver nothing itself.
 */
async function handOffToSourceApp(userId: string, type: NotificationType, input: NotifyInput): Promise<boolean> {
  const ctx = await loadHandOffContext(input.expenseId);
  if (!ctx) return false;
  if (!shouldHandOff({
    type,
    recipientId: userId,
    ownerId: ctx.expense.userId,
    sourceApp: ctx.expense.sourceApp,
    externalUserId: ctx.expense.externalUserId,
    eventsEnabled: ctx.eventsEnabled,
  })) return false;

  await recordExtEvent({
    sourceApp: ctx.expense.sourceApp!,
    type,
    expenseId: ctx.expense.id,
    payload: buildExtEventPayload(ctx.expense, input),
  });
  // After the row is durable: tell the app to pull. Fire-and-forget.
  void sendPings(ctx.pingUrls);
  return true;
}
```

and make it the first thing inside `notifyUser`'s existing `try`:

```ts
  try {
    if (await handOffToSourceApp(userId, type, input)) return;

    const { title, body } = buildNotification(type, input);
```

Update the doc comment above `notifyUser` to add one sentence: "For the submitter of an expense whose source app has events enabled, the notification is handed to that app instead (see handOffToSourceApp) and nothing is delivered here."

A failing `recordExtEvent` rejects inside the existing `try`, lands in the existing `catch`, is logged, and nothing native is sent, which is the required behaviour.

In `apps/api/src/lib/expenseThreadDb.ts`, in the `notifyUser(recipient, type, {...})` call inside the `for (const { userId: recipient, type } of planned)` loop, add `messageId: message.id,` to the object (the variable holding the inserted message row in that function; read the function to confirm its name).

In `apps/api/src/routes/accountant.ts`, in the single-expense review handler's `notifyUser(expense.userId, notifType, {...})` call (the one with `...(action === 'reject' && parsed.note ? { note: parsed.note } : {})`), add:

```ts
      ...(action === 'request_info' ? { requestType: parsed.requestType, excerpt: truncateExcerpt(parsed.note) } : {}),
```

and import `truncateExcerpt` from `'../lib/notifyMessages'` if the file does not already import it. Read the handler first: if the request-info note lives under a different property than `parsed.note`, use that property; if `parsed.requestType` can be undefined, the spread above already tolerates it.

- [ ] **Step 4: Run the tests and type-check**

Run: `npm run test -w apps/api -- notifyHandOff notifyMessages expenseThread && npm run lint -w apps/api`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/notify.ts apps/api/src/lib/notifyMessages.ts apps/api/src/lib/expenseThreadDb.ts apps/api/src/routes/accountant.ts apps/api/src/__tests__/notifyHandOff.test.ts
git commit -m "feat(ext-events): notifyUser hands the submitter's notification to the source app"
```

---

### Task 4: The feed endpoint and connection settings

**Files:**
- Modify: `apps/api/src/middleware/requireScope.ts`, `apps/api/src/routes/ext.ts`, `apps/api/src/routes/admin.ts`
- Test: `apps/api/src/__tests__/extScopes.test.ts` (extend), `apps/api/src/__tests__/extEventsRoute.test.ts`

**Interfaces:**
- Consumes: `parseSince`, `clampLimit`, `toFeedEvent` (Task 2); `listExtEvents` (Task 2); `connectionSourceApp` (existing).
- Produces: `GET /api/v1/ext/events`; scope `'events:read'`; `PATCH /api/v1/admin/connections/:id` accepts `eventsEnabled?: boolean` and `eventsPingUrl?: string | null`; `GET /admin/connections` returns both fields (it already returns every column except the key hash).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/__tests__/extEventsRoute.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/extEvents.json';

vi.mock('../lib/extEventsDb', () => ({ listExtEvents: vi.fn() }));

import { listExtEvents } from '../lib/extEventsDb';
import { buildEventsPage } from '../routes/extEventsHandler';

const rows = fixture.rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })) as never[];
const conn = { appName: 'trade_show_prod', sourceApp: 'trade_show' };

describe('buildEventsPage (GET /ext/events)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for the connection\'s own source app, after the cursor, and returns the contract shape', async () => {
    vi.mocked(listExtEvents).mockResolvedValueOnce(rows);
    const page = await buildEventsPage(conn, { since: '40', limit: '50' });
    expect(listExtEvents).toHaveBeenCalledWith('trade_show', 40, 50);
    expect(page).toEqual({ ok: true, body: { events: fixture.events, nextCursor: '45' } });
  });

  it('returns a null cursor for an empty page', async () => {
    vi.mocked(listExtEvents).mockResolvedValueOnce([]);
    expect(await buildEventsPage(conn, {})).toEqual({ ok: true, body: { events: [], nextCursor: null } });
    expect(listExtEvents).toHaveBeenCalledWith('trade_show', 0, 100);
  });

  it('rejects a bad cursor without querying', async () => {
    expect(await buildEventsPage(conn, { since: 'abc' })).toEqual({ ok: false });
    expect(listExtEvents).not.toHaveBeenCalled();
  });

  it('clamps an oversized limit', async () => {
    vi.mocked(listExtEvents).mockResolvedValueOnce([]);
    await buildEventsPage(conn, { limit: '100000' });
    expect(listExtEvents).toHaveBeenCalledWith('trade_show', 0, 200);
  });

  it('falls back to the app name when the connection has no source app', async () => {
    vi.mocked(listExtEvents).mockResolvedValueOnce([]);
    await buildEventsPage({ appName: 'trade_show', sourceApp: null }, {});
    expect(listExtEvents).toHaveBeenCalledWith('trade_show', 0, 100);
  });
});
```

Also open `apps/api/src/__tests__/extScopes.test.ts`, see how it lists the known scopes, and add `'events:read'` wherever that file enumerates them (if it asserts an exact list, the list must now include it).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w apps/api -- extEventsRoute`
Expected: FAIL, `../routes/extEventsHandler` not found.

- [ ] **Step 3: Implement**

`routes/ext.ts` is large and its handlers are inline, so the testable part lives in its own small file:

```ts
// apps/api/src/routes/extEventsHandler.ts
import { connectionSourceApp, type ConnectionScopeInput } from '../lib/ext/connectionScope';
import { clampLimit, parseSince, toFeedEvent, type FeedEvent } from '../lib/extEvents';
import { listExtEvents } from '../lib/extEventsDb';

export type EventsPage =
  | { ok: true; body: { events: FeedEvent[]; nextCursor: string | null } }
  | { ok: false };

/** One page of the calling connection's events. `ok: false` means the cursor was invalid. */
export async function buildEventsPage(
  conn: ConnectionScopeInput | null | undefined,
  query: { since?: unknown; limit?: unknown },
): Promise<EventsPage> {
  const since = parseSince(query.since);
  if (since === null) return { ok: false };

  const rows = await listExtEvents(connectionSourceApp(conn), since, clampLimit(query.limit));
  const events = rows.map(toFeedEvent);
  return {
    ok: true,
    body: { events, nextCursor: events.length > 0 ? String(events[events.length - 1].seq) : null },
  };
}
```

In `apps/api/src/middleware/requireScope.ts`, add `| 'events:read'` to the `ExtScope` union (after `'messages:write'`).

In `apps/api/src/routes/ext.ts`, add the import `import { buildEventsPage } from './extEventsHandler';` and, directly above the existing `router.get('/messages', requireScope('messages:read'), …)` route, add:

```ts
// ── Events feed ──────────────────────────────────────────────────────────────
// Submitter-facing events handed off by notifyUser (lib/extEvents), in seq
// order. The app keeps the cursor; Midas keeps no delivery state.
router.get('/events', requireScope('events:read'), asyncHandler(async (req, res) => {
  const page = await buildEventsPage(req.appConnection, { since: req.query.since, limit: req.query.limit });
  if (!page.ok) throw createError('Invalid cursor', 400, 'VALIDATION_ERROR');
  res.json(page.body);
}));
```

In `apps/api/src/routes/admin.ts`, in `router.patch('/connections/:id', …)`:

- extend the zod object with `eventsEnabled: z.boolean().optional(),` and `eventsPingUrl: z.string().url().nullable().optional(),`
- change the "nothing provided" guard to also accept the two new fields:

```ts
  if (body.isActive === undefined && body.permissions === undefined
    && body.eventsEnabled === undefined && body.eventsPingUrl === undefined) {
    throw createError('Provide isActive, permissions, eventsEnabled and/or eventsPingUrl', 400, 'VALIDATION_ERROR');
  }
```

- add to the `.set({...})` object:

```ts
      ...(body.eventsEnabled !== undefined ? { eventsEnabled: body.eventsEnabled } : {}),
      ...(body.eventsPingUrl !== undefined ? { eventsPingUrl: body.eventsPingUrl } : {}),
```

- add `eventsEnabled: appConnections.eventsEnabled, eventsPingUrl: appConnections.eventsPingUrl,` to the `.returning({...})` object.

- [ ] **Step 4: Run the tests and type-check**

Run: `npm run test -w apps/api -- extEventsRoute extScopes connectionScope && npm run lint -w apps/api`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/extEventsHandler.ts apps/api/src/routes/ext.ts apps/api/src/routes/admin.ts apps/api/src/middleware/requireScope.ts apps/api/src/__tests__/extEventsRoute.test.ts apps/api/src/__tests__/extScopes.test.ts
git commit -m "feat(ext-events): GET /ext/events feed and per-connection event settings"
```

---

### Task 5: Accountant `needs_review` (grouping, send, badge, links)

**Files:**
- Create: `apps/api/src/lib/needsReview.ts`, `apps/api/src/lib/needsReviewDb.ts`, `apps/api/src/lib/notifyNeedsReview.ts`
- Modify: `apps/api/src/lib/notificationLinks.ts`, `apps/api/src/routes/notifications.ts`
- Test: `apps/api/src/__tests__/needsReview.test.ts`, `apps/api/src/__tests__/notifyNeedsReview.test.ts`, `apps/api/src/__tests__/notificationLinks.test.ts` (extend)

**Interfaces:**
- Consumes: `notifications.groupKey`, `notifications.count`, `expenseCategories.needsAccountant` (Task 1); `sendPushToUser` (existing); `formatAmount` from `lib/notifyMessages`.
- Produces:
  - `groupKeyFor(e: { userId: string; date: string; sourceContext?: { eventId?: string } | null }): string`
  - `groupTarget(groupKey: string | null | undefined): 'event' | 'day'`
  - `groupText(i: { submitterName: string; count: number; eventName?: string | null; date: string }): { title: string; body: string }`
  - `pushText(i: { submitterName: string; merchant: string; amount: string | number; eventName?: string | null; reason: NeedsReviewReason; categoryName?: string | null }): { title: string; body: string }`
  - `type NeedsReviewReason = 'queued' | 'auto_approved'`
  - `notifyNeedsReview(expenseId: string, reason: NeedsReviewReason): Promise<void>` (never throws). For `'auto_approved'` it sends only when the expense's category has `needsAccountant`.
  - `notificationPath` accepts `groupKey?: string | null` and handles type `needs_review`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/__tests__/needsReview.test.ts
import { describe, expect, it } from 'vitest';
import { groupKeyFor, groupTarget, groupText, pushText } from '../lib/needsReview';

describe('groupKeyFor', () => {
  it('groups a show expense by submitter and event', () => {
    expect(groupKeyFor({ userId: 'u-1', date: '2026-10-08', sourceContext: { eventId: 'ev-9' } })).toBe('nr:u-1:event:ev-9');
  });
  it('groups everything else by submitter and expense date', () => {
    expect(groupKeyFor({ userId: 'u-1', date: '2026-10-08', sourceContext: {} })).toBe('nr:u-1:day:2026-10-08');
    expect(groupKeyFor({ userId: 'u-1', date: '2026-10-08', sourceContext: null })).toBe('nr:u-1:day:2026-10-08');
  });
});

describe('groupTarget', () => {
  it('reads the kind back out of a key', () => {
    expect(groupTarget('nr:u-1:event:ev-9')).toBe('event');
    expect(groupTarget('nr:u-1:day:2026-10-08')).toBe('day');
    expect(groupTarget(null)).toBe('day');
  });
});

describe('groupText', () => {
  it('words one expense for a show', () => {
    expect(groupText({ submitterName: 'Ana', count: 1, eventName: 'Expo', date: '2026-10-08' }))
      .toEqual({ title: 'Ana submitted an expense for Expo', body: 'Open the review queue to see it.' });
  });
  it('words several expenses for a show', () => {
    expect(groupText({ submitterName: 'Ana', count: 6, eventName: 'Expo', date: '2026-10-08' }).title)
      .toBe('Ana submitted 6 expenses for Expo');
  });
  it('falls back to the date when there is no show', () => {
    expect(groupText({ submitterName: 'Ana', count: 2, eventName: null, date: '2026-10-08' }).title)
      .toBe('Ana submitted 2 expenses on Oct 8');
    expect(groupText({ submitterName: 'Ana', count: 1, date: '2026-01-05' }).title)
      .toBe('Ana submitted an expense on Jan 5');
  });
});

describe('pushText', () => {
  it('names the submitter, amount, merchant and show for a queued expense', () => {
    expect(pushText({ submitterName: 'Ana', merchant: 'Staples', amount: '42.1', eventName: 'Expo', reason: 'queued' }))
      .toEqual({ title: 'Expense needs review', body: 'Ana: $42.10 at Staples · Expo' });
  });
  it('says why an auto-approved expense still needs the accountant', () => {
    expect(pushText({ submitterName: 'Ana', merchant: 'Staples', amount: 9, reason: 'auto_approved', categoryName: 'Ask Accountant' }))
      .toEqual({ title: 'Auto-approved expense needs you', body: 'Ana: $9.00 at Staples · category "Ask Accountant"' });
  });
});
```

```ts
// apps/api/src/__tests__/notifyNeedsReview.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/push', () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock('../lib/needsReviewDb', () => ({
  loadNeedsReviewExpense: vi.fn(),
  activeAccountantIds: vi.fn(async () => ['acc-1', 'acc-2']),
  bumpGroup: vi.fn(async () => ({ id: 'n-1', count: 1 })),
  setGroupText: vi.fn(async () => undefined),
}));

import { notifyNeedsReview } from '../lib/notifyNeedsReview';
import { loadNeedsReviewExpense, activeAccountantIds, bumpGroup, setGroupText } from '../lib/needsReviewDb';
import { sendPushToUser } from '../lib/push';

const expense = {
  id: 'e-1', userId: 'u-1', submitterName: 'Ana', merchant: 'Staples', amount: '42.10', date: '2026-10-08',
  sourceContext: { eventId: 'ev-9', eventName: 'Expo' }, sourceLabel: 'Expo',
  categoryName: 'Meals', categoryNeedsAccountant: false,
};

describe('notifyNeedsReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives every accountant a grouped bell row and one push for this expense', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    vi.mocked(bumpGroup).mockResolvedValueOnce({ id: 'n-1', count: 3 }).mockResolvedValueOnce({ id: 'n-2', count: 1 });
    await notifyNeedsReview('e-1', 'queued');

    expect(activeAccountantIds).toHaveBeenCalledWith('u-1');
    expect(bumpGroup).toHaveBeenCalledWith('acc-1', 'nr:u-1:event:ev-9', 'e-1');
    expect(setGroupText).toHaveBeenCalledWith('n-1', 'Ana submitted 3 expenses for Expo', 'Open the review queue to see it.');
    expect(setGroupText).toHaveBeenCalledWith('n-2', 'Ana submitted an expense for Expo', 'Open the review queue to see it.');
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
    expect(sendPushToUser).toHaveBeenCalledWith('acc-1', {
      title: 'Expense needs review',
      body: 'Ana: $42.10 at Staples · Expo',
      url: '/accountant/e-1',
      tag: 'needs-review-e-1',
    });
  });

  it('stays silent for an auto-approved expense in an ordinary category', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    await notifyNeedsReview('e-1', 'auto_approved');
    expect(bumpGroup).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('notifies for an auto-approved expense in a needs-accountant category', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce({ ...expense, categoryName: 'Ask Accountant', categoryNeedsAccountant: true });
    await notifyNeedsReview('e-1', 'auto_approved');
    expect(sendPushToUser).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      title: 'Auto-approved expense needs you',
      body: 'Ana: $42.10 at Staples · category "Ask Accountant"',
    }));
  });

  it('does nothing when the expense has gone or there are no accountants', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(null);
    await notifyNeedsReview('e-x', 'queued');
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    vi.mocked(activeAccountantIds).mockResolvedValueOnce([]);
    await notifyNeedsReview('e-1', 'queued');
    expect(bumpGroup).not.toHaveBeenCalled();
  });

  it('one accountant failing does not stop the next, and nothing is thrown', async () => {
    vi.mocked(loadNeedsReviewExpense).mockResolvedValueOnce(expense);
    vi.mocked(bumpGroup).mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce({ id: 'n-2', count: 1 });
    await expect(notifyNeedsReview('e-1', 'queued')).resolves.toBeUndefined();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(sendPushToUser).toHaveBeenCalledWith('acc-2', expect.anything());
  });

  it('never throws when the expense cannot be loaded', async () => {
    vi.mocked(loadNeedsReviewExpense).mockRejectedValueOnce(new Error('db down'));
    await expect(notifyNeedsReview('e-1', 'queued')).resolves.toBeUndefined();
  });
});
```

Add to `apps/api/src/__tests__/notificationLinks.test.ts`, following the style of the cases already in that file (read it first; reuse its helper for building an input if it has one):

```ts
describe('needs_review', () => {
  const base = { type: 'needs_review', expenseId: 'e-1', ownerId: 'u-1', recipientId: 'acc-1', recipientRole: 'accountant' as const };
  it('a show group opens event review', () => {
    expect(notificationPath({ ...base, groupKey: 'nr:u-1:event:ev-9' })).toBe('/accountant/events');
  });
  it('a day group opens daily review', () => {
    expect(notificationPath({ ...base, groupKey: 'nr:u-1:day:2026-10-08' })).toBe('/accountant/daily');
  });
  it('still opens the queue when the newest expense in the group was deleted', () => {
    expect(notificationPath({ ...base, expenseId: null, groupKey: 'nr:u-1:event:ev-9' })).toBe('/accountant/events');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w apps/api -- needsReview notifyNeedsReview notificationLinks`
Expected: FAIL: modules not found, and the three new `notificationPath` cases fail.

- [ ] **Step 3: Implement the pure module**

```ts
// apps/api/src/lib/needsReview.ts
/**
 * Accountant "needs review" notifications. Every expense sends its own push;
 * the bell holds one unread row per accountant per group (a submitter's
 * expenses for one show, or for one day), with a running count. Pure.
 */
import { formatAmount } from './notifyMessages';

export type NeedsReviewReason = 'queued' | 'auto_approved';

export function groupKeyFor(e: {
  userId: string; date: string; sourceContext?: { eventId?: string } | null;
}): string {
  const eventId = e.sourceContext?.eventId;
  return eventId ? `nr:${e.userId}:event:${eventId}` : `nr:${e.userId}:day:${e.date}`;
}

/** Whether a group is for a show or for a day; decides which queue a bell row opens. */
export function groupTarget(groupKey: string | null | undefined): 'event' | 'day' {
  return groupKey?.split(':')[2] === 'event' ? 'event' : 'day';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-08' → 'Oct 8'. Falls back to the input when it is not a plain date. */
function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export function groupText(i: {
  submitterName: string; count: number; eventName?: string | null; date: string;
}): { title: string; body: string } {
  const what = i.count === 1 ? 'an expense' : `${i.count} expenses`;
  const where = i.eventName ? `for ${i.eventName}` : `on ${shortDate(i.date)}`;
  return { title: `${i.submitterName} submitted ${what} ${where}`, body: 'Open the review queue to see it.' };
}

export function pushText(i: {
  submitterName: string; merchant: string; amount: string | number;
  eventName?: string | null; reason: NeedsReviewReason; categoryName?: string | null;
}): { title: string; body: string } {
  const line = `${i.submitterName}: ${formatAmount(i.amount)} at ${i.merchant}`;
  if (i.reason === 'auto_approved') {
    return {
      title: 'Auto-approved expense needs you',
      body: `${line}${i.categoryName ? ` · category "${i.categoryName}"` : ''}`,
    };
  }
  return { title: 'Expense needs review', body: `${line}${i.eventName ? ` · ${i.eventName}` : ''}` };
}
```

- [ ] **Step 4: Implement the database access**

```ts
// apps/api/src/lib/needsReviewDb.ts
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { expenses, notifications, users } from '../db/schema';

export interface NeedsReviewExpense {
  id: string;
  userId: string;
  submitterName: string;
  merchant: string;
  amount: string;
  date: string;
  sourceContext: { eventId?: string; eventName?: string } | null;
  sourceLabel: string | null;
  categoryName: string | null;
  categoryNeedsAccountant: boolean;
}

export async function loadNeedsReviewExpense(expenseId: string): Promise<NeedsReviewExpense | null> {
  const row = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
    columns: { id: true, userId: true, merchant: true, amount: true, date: true, sourceContext: true, sourceLabel: true },
    with: {
      user: { columns: { name: true } },
      category: { columns: { name: true, needsAccountant: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    submitterName: row.user?.name ?? 'Someone',
    merchant: row.merchant,
    amount: String(row.amount),
    date: String(row.date),
    sourceContext: row.sourceContext ?? null,
    sourceLabel: row.sourceLabel,
    categoryName: row.category?.name ?? null,
    categoryNeedsAccountant: row.category?.needsAccountant ?? false,
  };
}

/** Active accountants, never the submitter. Accountant role only: not admin, not developer. */
export async function activeAccountantIds(exceptUserId: string): Promise<string[]> {
  const rows = await db.query.users.findMany({
    where: and(eq(users.role, 'accountant'), eq(users.isActive, true), ne(users.id, exceptUserId)),
    columns: { id: true },
  });
  return rows.map((u) => u.id);
}

/**
 * Add one to the recipient's unread row for this group, or start a new row.
 * One statement, keyed on the partial unique index notifications_unread_group_idx,
 * so two expenses arriving together still end as one row with count 2. The
 * WHERE on the conflict target must repeat the index predicate exactly, or
 * Postgres will not match the partial index.
 */
export async function bumpGroup(userId: string, groupKey: string, expenseId: string): Promise<{ id: string; count: number }> {
  const result = await db.execute(sql`
    INSERT INTO notifications (user_id, type, title, expense_id, group_key, count)
    VALUES (${userId}, 'needs_review', '', ${expenseId}, ${groupKey}, 1)
    ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
    DO UPDATE SET count = notifications.count + 1,
                  expense_id = EXCLUDED.expense_id,
                  created_at = now()
    RETURNING id, count
  `);
  const row = result.rows[0] as { id: string; count: number };
  return { id: row.id, count: Number(row.count) };
}

export async function setGroupText(notificationId: string, title: string, body: string): Promise<void> {
  await db.update(notifications).set({ title, body }).where(eq(notifications.id, notificationId));
}
```

If `expenses` has no `user` or `category` relation by those names in `db/schema.ts`, use the relation names that file defines (search for `expensesRelations`); the returned shape must stay as declared above.

- [ ] **Step 5: Implement the orchestrator**

```ts
// apps/api/src/lib/notifyNeedsReview.ts
import { logger } from './logger';
import { sendPushToUser } from './push';
import { groupKeyFor, groupText, pushText, type NeedsReviewReason } from './needsReview';
import { activeAccountantIds, bumpGroup, loadNeedsReviewExpense, setGroupText } from './needsReviewDb';

/**
 * Tell the accountants an expense needs them: one grouped, counted bell row
 * each and one push for this expense. No email. `auto_approved` only notifies
 * when the expense's category is marked "needs accountant". Never throws:
 * a notification must not fail the submission that caused it.
 */
export async function notifyNeedsReview(expenseId: string, reason: NeedsReviewReason): Promise<void> {
  try {
    const expense = await loadNeedsReviewExpense(expenseId);
    if (!expense) return;
    if (reason === 'auto_approved' && !expense.categoryNeedsAccountant) return;

    const recipients = await activeAccountantIds(expense.userId);
    if (recipients.length === 0) return;

    const eventName = expense.sourceContext?.eventName ?? expense.sourceLabel ?? null;
    const groupKey = groupKeyFor(expense);
    const push = pushText({
      submitterName: expense.submitterName, merchant: expense.merchant, amount: expense.amount,
      eventName, reason, categoryName: expense.categoryName,
    });

    for (const userId of recipients) {
      try {
        const group = await bumpGroup(userId, groupKey, expense.id);
        const text = groupText({
          submitterName: expense.submitterName, count: group.count, eventName, date: expense.date,
        });
        await setGroupText(group.id, text.title, text.body);
        // One push per expense. No notificationId: tapping one expense's push
        // must not mark the whole group read. A per-expense tag keeps pushes
        // from replacing each other on the lock screen.
        void sendPushToUser(userId, {
          title: push.title, body: push.body,
          url: `/accountant/${expense.id}`,
          tag: `needs-review-${expense.id}`,
        });
      } catch (err) {
        logger.error({ err, userId, expenseId }, 'needs_review notification failed for one accountant');
      }
    }
  } catch (err) {
    logger.error({ err, expenseId }, 'needs_review notification failed');
  }
}
```

- [ ] **Step 6: Links and the badge**

In `apps/api/src/lib/notificationLinks.ts`:

- add `import { groupTarget } from './needsReview';`
- add to `NotificationPathInput`: `/** Set on grouped rows (needs_review). */ groupKey?: string | null;`
- make this the first statement of `notificationPath`:

```ts
  // A grouped needs_review row stands for several expenses: open the queue
  // they sit in, not whichever one happened to arrive last.
  if (input.type === 'needs_review') {
    return groupTarget(input.groupKey) === 'event' ? '/accountant/events' : '/accountant/daily';
  }
```

In `apps/api/src/routes/notifications.ts`:

- in `listWithPaths`, add `groupKey: n.groupKey,` to the object passed to `notificationPath`
- change the unread count so a grouped row counts for every expense it stands for:

```ts
    .select({ unreadCount: sql<number>`coalesce(sum(${notifications.count}), 0)::int` })
```

- [ ] **Step 7: Run the tests and type-check**

Run: `npm run test -w apps/api -- needsReview notifyNeedsReview notificationLinks && npm run lint -w apps/api`
Expected: all PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/needsReview.ts apps/api/src/lib/needsReviewDb.ts apps/api/src/lib/notifyNeedsReview.ts apps/api/src/lib/notificationLinks.ts apps/api/src/routes/notifications.ts apps/api/src/__tests__/needsReview.test.ts apps/api/src/__tests__/notifyNeedsReview.test.ts apps/api/src/__tests__/notificationLinks.test.ts
git commit -m "feat(notifications): grouped needs-review notifications for accountants"
```

---

### Task 6: Fire `needs_review` where expenses enter the queue, and the category flag

**Files:**
- Modify: `apps/api/src/routes/ext.ts` (create and PATCH), `apps/api/src/routes/expenses.ts` (submit), `apps/api/src/routes/extensionExpenses.ts` (create), `apps/api/src/lib/pendingCompletionDb.ts`, `apps/api/src/routes/admin.ts` (category POST/PATCH), `apps/web/src/pages/settings/CategoriesSection.tsx`, `apps/web/src/types/index.ts`
- Test: `apps/api/src/__tests__/needsReviewTriggers.test.ts`

**Interfaces:**
- Consumes: `notifyNeedsReview(expenseId, reason)` (Task 5); `expenseCategories.needsAccountant` (Task 1).
- Produces: `shouldQueueNotify(i: { before: string | null; after: string }): boolean` in `lib/needsReview.ts`; `needsAccountant` accepted by `POST` and `PATCH /admin/categories`; a "Needs accountant" toggle in the categories settings page.

- [ ] **Step 1: Write the failing test**

The one piece of decision logic at the call sites is "did this write put the expense into the queue". Make it a pure function so it is tested once, not five times.

```ts
// apps/api/src/__tests__/needsReviewTriggers.test.ts
import { describe, expect, it } from 'vitest';
import { shouldQueueNotify } from '../lib/needsReview';

describe('shouldQueueNotify', () => {
  it('fires when a new expense is created pending', () => {
    expect(shouldQueueNotify({ before: null, after: 'pending' })).toBe(true);
  });
  it('fires when a draft is submitted or a rejected expense is resubmitted', () => {
    expect(shouldQueueNotify({ before: 'draft', after: 'pending' })).toBe(true);
    expect(shouldQueueNotify({ before: 'rejected', after: 'pending' })).toBe(true);
  });
  it('does not fire for an edit that leaves it pending', () => {
    expect(shouldQueueNotify({ before: 'pending', after: 'pending' })).toBe(false);
  });
  it('does not fire when an expense comes back from an info request', () => {
    expect(shouldQueueNotify({ before: 'awaiting_info', after: 'pending' })).toBe(false);
    expect(shouldQueueNotify({ before: 'in_review', after: 'pending' })).toBe(false);
  });
  it('does not fire for any other resulting status', () => {
    expect(shouldQueueNotify({ before: null, after: 'approved' })).toBe(false);
    expect(shouldQueueNotify({ before: 'pending', after: 'approved' })).toBe(false);
    expect(shouldQueueNotify({ before: null, after: 'draft' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w apps/api -- needsReviewTriggers`
Expected: FAIL, `shouldQueueNotify` is not exported.

- [ ] **Step 3: Implement the rule**

Append to `apps/api/src/lib/needsReview.ts`:

```ts
/** Statuses from which a move to `pending` is a fresh arrival in the accountant's queue. */
const ENTERS_QUEUE_FROM = new Set<string | null>([null, 'draft', 'rejected', 'cancelled']);

/**
 * Whether a write put the expense into the review queue. An expense that was
 * already with the accountant (pending, in review, awaiting info) coming back
 * to pending is a reply, which the conversation routing already reports.
 */
export function shouldQueueNotify(i: { before: string | null; after: string }): boolean {
  return i.after === 'pending' && ENTERS_QUEUE_FROM.has(i.before);
}
```

- [ ] **Step 4: Wire the call sites**

Each call is `void notifyNeedsReview(...)`: it never throws and must not delay the response. Add `import { notifyNeedsReview } from '../lib/notifyNeedsReview';` and `import { shouldQueueNotify } from '../lib/needsReview';` where used.

1. `apps/api/src/routes/ext.ts`, `POST /expenses`, directly after the `await auditLog({ ... action: 'ext.created' ... })` call:

```ts
  if (shouldQueueNotify({ before: null, after: inserted.status })) {
    void notifyNeedsReview(inserted.id, 'queued');
  }
```

2. `apps/api/src/routes/ext.ts`, `PATCH /expenses/:id`, directly after the `await auditLog({ ... action: 'ext.updated' ... })` call:

```ts
  if (shouldQueueNotify({ before: existing.status, after: updated.status })) {
    void notifyNeedsReview(updated.id, 'queued');
  }
```

3. `apps/api/src/routes/expenses.ts`, `POST /:id/submit`:

   - In the auto-approve branch (the block that writes the `auto_approved` audit entry with `reason: 'complete daily expense'`), directly after that `auditLog` call:

```ts
    void notifyNeedsReview(expense.id, 'auto_approved');
```

   - In the fall-through to `pending`, the expense is waiting on the SUBMITTER when Midas has just told them what is missing (`missingForAutoPush`), and on the accountant otherwise. Directly after the `if (missingForAutoPush) { ... }` block:

```ts
  // Waiting on the accountant, not on the submitter completing it.
  if (!missingForAutoPush) void notifyNeedsReview(expense.id, 'queued');
```

4. `apps/api/src/lib/pendingCompletionDb.ts`, in `maybeAutoPushPending`, directly after the `auditLog` call with `reason: 'completed after submission'`:

```ts
  void notifyNeedsReview(expense.id, 'auto_approved');
```

   (import from `./notifyNeedsReview`).

5. `apps/api/src/routes/extensionExpenses.ts`, in the capture-create handler, directly after the block of `auditLog` calls that follow the expense insert (before the response is sent):

```ts
  void notifyNeedsReview(expense.id, 'queued');
```

Do not add a call to the bulk import handler (`POST /expenses/import`) or to the partner-expense branch of submit.

- [ ] **Step 5: The category flag in the admin API**

In `apps/api/src/routes/admin.ts`:

- `POST /categories`: add `needsAccountant: z.boolean().optional(),` to the zod object.
- `PATCH /categories/:id`: add `needsAccountant: z.boolean().optional(),` to the zod object.

Both handlers pass the parsed body straight to Drizzle, so no other change is needed; `GET /categories` already returns every column.

- [ ] **Step 6: The category flag in the settings page**

In `apps/web/src/types/index.ts`, add `needsAccountant?: boolean;` to the `ExpenseCategory` interface.

In `apps/web/src/pages/settings/CategoriesSection.tsx`:

- widen the `patchMutation` variables type to include `needsAccountant?: boolean`:

```ts
    mutationFn: ({ id, ...body }: { id: string; name?: string; isActive?: boolean; needsAccountant?: boolean; parentId?: string | null }) =>
```

- directly before the existing Active/Hidden pill button (the `<button>` whose `onClick` is `patchMutation.mutate({ id: cat.id, isActive: !cat.isActive })`), add a second pill in the same style:

```tsx
              <button
                type="button"
                onClick={() => patchMutation.mutate({ id: cat.id, needsAccountant: !cat.needsAccountant })}
                className={`rounded-full px-2.5 py-0.5 text-xs ${cat.needsAccountant ? 'bg-gold-100 text-gold-800' : 'bg-brand-50 text-muted'}`}
                title={cat.needsAccountant
                  ? 'Accountants are notified about every expense in this category, even auto-approved ones. Click to turn off.'
                  : 'Click to notify accountants about every expense in this category, even auto-approved ones.'}
                aria-pressed={Boolean(cat.needsAccountant)}
              >
                {cat.needsAccountant ? 'Needs accountant' : 'No alert'}
              </button>
```

Match the surrounding JSX's indentation and wrapper; if the Active pill sits inside a flex container, put the new pill in the same container.

- [ ] **Step 7: Run the tests, type-check and build the web app**

Run: `npm run test -w apps/api && npm run lint && npm run build -w apps/web`
Expected: the whole API suite passes; no type errors in any workspace; the web build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/needsReview.ts apps/api/src/lib/pendingCompletionDb.ts apps/api/src/routes/ext.ts apps/api/src/routes/expenses.ts apps/api/src/routes/extensionExpenses.ts apps/api/src/routes/admin.ts apps/api/src/__tests__/needsReviewTriggers.test.ts apps/web/src/pages/settings/CategoriesSection.tsx apps/web/src/types/index.ts
git commit -m "feat(notifications): notify accountants when an expense enters the queue or its category asks for them"
```

---

### Task 7: Missing-details sweep

**Files:**
- Create: `apps/api/src/lib/incompleteSweep.ts`, `apps/api/src/lib/incompleteSweepDb.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/__tests__/incompleteSweep.test.ts`

**Interfaces:**
- Consumes: `expenses.incompleteNotifiedAt` (Task 1); `eventEnabledSourceApps()` (Task 2); `notifyUser` (Task 3, which hands off).
- Produces:
  - `missingDetails(e: { hasReceipt: boolean; receiptWaiverReason?: string | null; categoryId: string | null; zohoExpenseAccountId: string | null; paymentMethodId: string | null }): string[]` (values from `'receipt'`, `'category'`, `'payment method'`, in that order)
  - `runIncompleteSweep(): Promise<void>` (one pass; never throws)
  - `startIncompleteSweep(): void` (5-minute timer)
  - `claimDueExpenses(sourceApps: string[], limit: number): Promise<DueExpense[]>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/__tests__/incompleteSweep.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/extEventsDb', () => ({ eventEnabledSourceApps: vi.fn(async () => ['trade_show']) }));
vi.mock('../lib/incompleteSweepDb', () => ({ claimDueExpenses: vi.fn(async () => []) }));
vi.mock('../lib/notify', () => ({ notifyUser: vi.fn(async () => undefined) }));

import { missingDetails, runIncompleteSweep } from '../lib/incompleteSweep';
import { eventEnabledSourceApps } from '../lib/extEventsDb';
import { claimDueExpenses } from '../lib/incompleteSweepDb';
import { notifyUser } from '../lib/notify';

const complete = { hasReceipt: true, categoryId: 'c', zohoExpenseAccountId: null, paymentMethodId: 'p' };
const due = (over: Record<string, unknown> = {}) => ({
  id: 'e-1', userId: 'owner', merchant: 'Uber', amount: '18.00', ...complete, ...over,
});

describe('missingDetails', () => {
  it('is empty for a complete expense', () => {
    expect(missingDetails(complete)).toEqual([]);
  });
  it('lists what is missing, in a fixed order', () => {
    expect(missingDetails({ hasReceipt: false, categoryId: null, zohoExpenseAccountId: null, paymentMethodId: null }))
      .toEqual(['receipt', 'category', 'payment method']);
  });
  it('accepts a Zoho expense account in place of a category', () => {
    expect(missingDetails({ ...complete, categoryId: null, zohoExpenseAccountId: '123' })).toEqual([]);
  });
  it('accepts a written receipt waiver in place of a receipt, but not a blank one', () => {
    expect(missingDetails({ ...complete, hasReceipt: false, receiptWaiverReason: 'Lost; vendor confirmed' })).toEqual([]);
    expect(missingDetails({ ...complete, hasReceipt: false, receiptWaiverReason: '   ' })).toEqual(['receipt']);
  });
});

describe('runIncompleteSweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not touch the database when no app has events enabled', async () => {
    vi.mocked(eventEnabledSourceApps).mockResolvedValueOnce([]);
    await runIncompleteSweep();
    expect(claimDueExpenses).not.toHaveBeenCalled();
  });

  it('tells the owner once per incomplete expense, listing what is missing', async () => {
    vi.mocked(claimDueExpenses).mockResolvedValueOnce([
      due({ id: 'e-1', hasReceipt: false }),
      due({ id: 'e-2' }),
      due({ id: 'e-3', paymentMethodId: null, hasReceipt: false }),
    ]);
    await runIncompleteSweep();
    expect(claimDueExpenses).toHaveBeenCalledWith(['trade_show'], 100);
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(notifyUser).toHaveBeenCalledWith('owner', 'expense_incomplete', {
      expenseId: 'e-1', merchant: 'Uber', amount: '18.00', missing: ['receipt'],
    });
    expect(notifyUser).toHaveBeenCalledWith('owner', 'expense_incomplete', {
      expenseId: 'e-3', merchant: 'Uber', amount: '18.00', missing: ['receipt', 'payment method'],
    });
  });

  it('never throws', async () => {
    vi.mocked(claimDueExpenses).mockRejectedValueOnce(new Error('db down'));
    await expect(runIncompleteSweep()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w apps/api -- incompleteSweep`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/lib/incompleteSweepDb.ts
import { sql } from 'drizzle-orm';
import { db } from '../db/index';

export interface DueExpense {
  id: string;
  userId: string;
  merchant: string;
  amount: string;
  hasReceipt: boolean;
  receiptWaiverReason: string | null;
  categoryId: string | null;
  zohoExpenseAccountId: string | null;
  paymentMethodId: string | null;
}

/** How long an external app gets to finish uploading before we look. */
const SETTLE_MINUTES = 15;

/**
 * Stamp and return expenses the sweep has not looked at yet: from an
 * events-enabled app, still pending, older than the settle window. The stamp
 * is written in the same statement that selects them, so a crash loses one
 * notification and never sends one twice, and complete expenses are not
 * re-examined on every pass.
 */
export async function claimDueExpenses(sourceApps: string[], limit: number): Promise<DueExpense[]> {
  if (sourceApps.length === 0) return [];
  const apps = sql.join(sourceApps.map((a) => sql`${a}`), sql`, `);
  const result = await db.execute(sql`
    UPDATE expenses e
       SET incomplete_notified_at = now()
     WHERE e.id IN (
       SELECT id FROM expenses
        WHERE status = 'pending'
          AND incomplete_notified_at IS NULL
          AND external_user_id IS NOT NULL
          AND source_app IN (${apps})
          AND created_at < now() - make_interval(mins => ${SETTLE_MINUTES})
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING e.id, e.user_id AS "userId", e.merchant, e.amount::text AS amount,
              e.receipt_waiver_reason AS "receiptWaiverReason",
              e.category_id AS "categoryId",
              e.zoho_expense_account_id AS "zohoExpenseAccountId",
              e.payment_method_id AS "paymentMethodId",
              EXISTS (SELECT 1 FROM receipts r WHERE r.expense_id = e.id) AS "hasReceipt"
  `);
  return result.rows as unknown as DueExpense[];
}
```

```ts
// apps/api/src/lib/incompleteSweep.ts
/**
 * "Expense missing details" for external-app expenses. An app creates the
 * expense first and uploads its receipt a moment later, so checking at
 * creation would always report a missing receipt. This looks once, 15
 * minutes later, and tells the submitter (through the hand-off) what to add.
 */
import { logger } from './logger';
import { notifyUser } from './notify';
import { eventEnabledSourceApps } from './extEventsDb';
import { claimDueExpenses } from './incompleteSweepDb';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const BATCH = 100;

/** The same three checks lib/flags uses for missing_receipt, needs_category and needs_payment_method. */
export function missingDetails(e: {
  hasReceipt: boolean;
  receiptWaiverReason?: string | null;
  categoryId: string | null;
  zohoExpenseAccountId: string | null;
  paymentMethodId: string | null;
}): string[] {
  const missing: string[] = [];
  if (!e.hasReceipt && !(e.receiptWaiverReason ?? '').trim()) missing.push('receipt');
  if (!e.categoryId && !e.zohoExpenseAccountId) missing.push('category');
  if (!e.paymentMethodId) missing.push('payment method');
  return missing;
}

let running = false;

/** One pass. Never throws. */
export async function runIncompleteSweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const apps = await eventEnabledSourceApps();
    if (apps.length === 0) return;

    const due = await claimDueExpenses(apps, BATCH);
    for (const expense of due) {
      const missing = missingDetails(expense);
      if (missing.length === 0) continue;
      // notifyUser hands this to the source app and never throws.
      await notifyUser(expense.userId, 'expense_incomplete', {
        expenseId: expense.id, merchant: expense.merchant, amount: expense.amount, missing,
      });
    }
  } catch (err) {
    logger.error({ err }, 'Missing-details sweep failed');
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startIncompleteSweep(): void {
  if (timer) return;
  setTimeout(() => void runIncompleteSweep(), STARTUP_DELAY_MS);
  timer = setInterval(() => void runIncompleteSweep(), SWEEP_INTERVAL_MS);
  logger.info('Missing-details sweep started (every 5 minutes)');
}
```

Confirm against `apps/api/src/lib/flags.ts` that the three checks match `missing_receipt`, `needs_category` and `needs_payment_method` there; if `flags.ts` treats a case differently (for example the receipt waiver), follow `flags.ts` and adjust the matching test case.

In `apps/api/src/server.ts`, add `import { startIncompleteSweep } from './lib/incompleteSweep';` and, inside the `app.listen` callback after `reportConfigGaps();`:

```ts
  startIncompleteSweep();
```

- [ ] **Step 4: Run the tests and type-check**

Run: `npm run test -w apps/api && npm run lint -w apps/api`
Expected: whole suite PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/incompleteSweep.ts apps/api/src/lib/incompleteSweepDb.ts apps/api/src/server.ts apps/api/src/__tests__/incompleteSweep.test.ts
git commit -m "feat(ext-events): tell the submitter what an external-app expense is still missing"
```

---

### Task 8: Docs and release v1.21.0

**Files:**
- Modify: `docs/API_CONTRACTS.md`, `docs/CHANGELOG.md`, `CLAUDE.md`, `.env.example`, `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`, `packages/shared/src/version.ts`

**Interfaces:**
- Produces: a release commit on the branch. Merge, push and deploy are the controller's (see "Deploy and switch-on" below) and are NOT part of this task.

- [ ] **Step 1: Full verification**

Run (repo root): `npm run lint && npm run test -w apps/api && npm run build`
Expected: no type errors in any workspace; the whole API suite passes; every workspace builds. Record the test count in the report.

- [ ] **Step 2: Document the contract**

In `docs/API_CONTRACTS.md`, directly after the section that documents `GET /ext/messages` (find it with `grep -n "ext/messages" docs/API_CONTRACTS.md`), add:

````markdown
### GET /ext/events

Scope: `events:read`. Submitter-facing events on the calling connection's
source app, handed off by Midas instead of being delivered to the submitter
in Midas (see "Event hand-off" below). Ordered by `seq`.

Query: `since` (the last `seq` processed; omit for the start), `limit`
(default 100, max 200). A non-numeric `since` is a 400.

```json
{
  "events": [
    {
      "seq": 42,
      "id": "22222222-2222-4222-8222-222222222222",
      "type": "rejected",
      "createdAt": "2026-10-08T15:01:00.000Z",
      "externalUserId": "<the app's user id for the submitter>",
      "expense": { "id": "<midas id>", "sourceRefId": "<the app's expense id>", "merchant": "Staples", "amount": "42.10", "status": "rejected" },
      "note": "Duplicate submission"
    }
  ],
  "nextCursor": "42"
}
```

`type` is one of `approved`, `rejected`, `action_required`, `message`,
`mention`, `reimbursement_paid`, `expense_incomplete`. Optional fields by
type: `senderName`, `excerpt`, `messageId` (message, mention,
action_required); `requestType` (action_required); `note` (rejected);
`missing` (expense_incomplete). Consumers must ignore types and fields they
do not know. `id` is stable and unique: use it to de-duplicate, since a page
may be re-read after a crash. `nextCursor` is null for an empty page.

### Event hand-off

A connection with `events_enabled = true` takes over notifying its own users.
For an expense from that source app that carries an `externalUserId`, every
notification addressed to the submitter is written to `ext_events` and
nothing is delivered in Midas (no bell row, push or email). Notifications to
anyone else are unaffected. After recording an event Midas POSTs an empty
JSON body to the connection's `events_ping_url` with `X-Midas-Timestamp`
(Unix seconds) and `X-Midas-Signature` (hex HMAC-SHA256 of the timestamp,
keyed with `EXT_EVENTS_PING_SECRET`). The ping is best-effort: the consumer
must also poll. Set both fields with `PATCH /api/v1/admin/connections/:id`
(`eventsEnabled`, `eventsPingUrl`) and grant the `events:read` permission.
````

- [ ] **Step 3: Changelog, env example, CLAUDE.md**

At the top of `docs/CHANGELOG.md`, directly below `# Changelog`:

```markdown
## 1.21.0

### Added
- **Accountants are told when an expense needs them.** Each expense that lands in the review queue sends its own push. The bell shows one line per submitter per show (or per day for non-show expenses), such as "Ana submitted 6 expenses for Expo", and its count grows until it is read. The badge counts every expense. No email.
- **"Needs accountant" on categories.** Settings → Categories has a new toggle. Expenses in a category with it on notify accountants even when they are auto-approved.
- **Apps that send expenses to Midas can notify their own users.** With events turned on for a connection, Midas stops notifying that app's submitters itself and records each event (approved, rejected, more info requested, message, mention, reimbursement paid, expense missing details) for the app to collect from `GET /ext/events`. Argo uses this from v2.33.0.
- **Missing details are reported for app-submitted expenses.** Fifteen minutes after an app creates an expense, if it still has no receipt, category or payment method, the submitter is told once what to add.

### Notes
- Migration `0033_ext_events_needs_review`: `ext_events` table; `app_connections.events_enabled` and `events_ping_url`; `notifications.group_key` and `count`; `expense_categories.needs_accountant`; `expenses.incomplete_notified_at` (existing expenses are stamped so none are reported retroactively).
- New optional env `EXT_EVENTS_PING_SECRET`. New Ext scope `events:read`. `PATCH /api/v1/admin/connections/:id` accepts `eventsEnabled` and `eventsPingUrl`. `GET /api/v1/notifications` `unreadCount` now sums grouped rows.
- Events are off for every connection until switched on, so nothing changes for submitters at upgrade. `GET /ext/messages` is unchanged.
```

In `.env.example`, after the VAPID lines, add:

```
# Shared secret for the "you have events" ping to external apps (see docs/API_CONTRACTS.md, Event hand-off).
# Unset = no pings; the app's own poll still delivers.
# EXT_EVENTS_PING_SECRET=
```

In `CLAUDE.md`, add a short paragraph in the section that describes notifications or the Ext API (find with `grep -n -i "notif\|ext api\|conversation" CLAUDE.md`; if there is no fitting section, add it under the project overview's architecture notes):

```markdown
**Notification hand-off.** `notifyUser` (lib/notify.ts) is the one path for
submitter-facing notifications. For the owner of an expense whose source app
has `events_enabled`, it writes `ext_events` and pings the app instead of
delivering in Midas (lib/extEvents.ts decides; the app pulls
`GET /ext/events`). Accountant `needs_review` notifications go through
`notifyNeedsReview` (lib/notifyNeedsReview.ts): one push per expense, one
grouped and counted bell row per submitter per show or day.
```

- [ ] **Step 4: Bump the version in all four places**

Set `1.21.0` in `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json` (the `"version"` field in each) and in `packages/shared/src/version.ts` (the `MIDAS_VERSION` constant). Then:

```bash
git grep -n "1\.20\.0" -- . ':!docs' ':!*package-lock.json'
```

Expected: no output. If `package-lock.json` records workspace versions, run `npm install --package-lock-only` and include the lock file.

- [ ] **Step 5: Commit**

```bash
git add docs/API_CONTRACTS.md docs/CHANGELOG.md CLAUDE.md .env.example apps/api/package.json apps/web/package.json packages/shared/package.json packages/shared/src/version.ts package-lock.json
git commit -m "chore: bump version to 1.21.0"
```

---

## Deploy and switch-on (controller, after the whole-branch review)

These steps change production and are run by the controller, in this order, together with the Argo plan (`trade-show-app/docs/superpowers/plans/2026-10-08-midas-expense-notifications-argo.md`).

1. **Merge and push Midas** (`main`).
2. **Deploy Midas v1.21.0 to CT 3120** with the verified tarball recipe: `git archive` of the changed files → `scp` to the Proxmox host → `pct push 3120` → `tar -xzf` in `/opt/midas` (never include `.env`) → `docker compose -f docker-compose.prod.yml up -d --build api web`. Remove any file deleted in git by hand (none in this release).
3. **Verify the migration** from the migrator log (`docker logs midas-migrator-1 2>&1 | grep -E "applying|applied"` shows `0033_ext_events_needs_review`) and the schema itself on CT 3220 (`ext_events` exists; `app_connections.events_enabled` exists). `/api/v1/meta` reports `1.21.0` and `environment: production`.
4. **Set `EXT_EVENTS_PING_SECRET`** in `/opt/midas/.env` on CT 3120 (generate with `openssl rand -hex 32`) and recreate the api container so it is read. Put the same value in Argo's `/etc/expenseapp/backend.env` as `MIDAS_EVENTS_PING_SECRET`.
5. **Deploy Argo v2.33.0** (Argo plan).
6. **Switch on**, as a Midas admin: add `events:read` to the production Argo connection's permissions and set `eventsEnabled: true` and `eventsPingUrl: http://192.168.1.201:3000/api/midas/events-ping` with `PATCH /api/v1/admin/connections/:id`. Leave the sandbox connection off.
7. **End-to-end check with the user** as listed in the spec's Testing section.

Rollback: `PATCH` the connection with `eventsEnabled: false`. Midas notifies submitters itself again at once.
