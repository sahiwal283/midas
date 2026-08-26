# Event Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an expense created in Midas be attached to a trade-show event from Argo, so event spend entered in Midas reaches Event Review, Reports and Argo instead of being stranded in Daily Review.

**Architecture:** Midas reads Argo's `events` table over the existing read-only Postgres link (`midas_ro`) and exposes it at `GET /api/v1/events`. Selecting an event sends only its **id**; the server resolves the name and writes the five `source_*` columns itself, so `source_label` — which Reports and the Event filter group on — can never be a client-invented string. All date maths and field mapping live in pure, unit-tested helpers; the DB adapter stays thin.

**Tech Stack:** Express 5 + Drizzle ORM + Zod (API), React 19 + TanStack Query + Tailwind (web), Vitest (tests), raw `pg` Pool for the cross-app read.

**Spec:** `docs/superpowers/specs/2026-08-26-event-picker-design.md`

## Global Constraints

- `sourceApp` value is exactly `'trade_show'` — a data contract, unchanged by the app's rename to Argo (`docs/OPERATIONS.md:244`).
- `sourceType` value is exactly `'trade_show_event'` (matches `lib/sourceTypes.ts:23`).
- Never write `source_label` from client input; always from the event row read out of Argo.
- Event expenses must stay ineligible for daily auto-push — do not touch `lib/autoApprove.ts`.
- The Argo DB role is SELECT-only on `events`. No INSERT/UPDATE against it, ever. No inline event creation.
- Unset `TRADESHOW_DATABASE_URL` must degrade to `{ events: [], available: false }`, never a 500.
- Tests run without a database: `npm test` in `apps/api` must stay DB-free.
- Lint gate for every task: `npm run lint` in the workspace you touched.

---

### Task 1: Pure event-selection helper

**Files:**
- Create: `apps/api/src/lib/eventSelection.ts`
- Test: `apps/api/src/__tests__/eventSelection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SelectableEventInput`, `SelectableEvent`, `selectionCutoff(endDate: string): string`, `orderSelectableEvents(events: SelectableEventInput[], today: string): SelectableEvent[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/eventSelection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { selectionCutoff, orderSelectableEvents } from '../lib/eventSelection';

describe('selectionCutoff', () => {
  it('is one month and one day past the end date', () => {
    expect(selectionCutoff('2026-11-03')).toBe('2026-12-04');
  });

  it('mirrors Argo month-overflow rather than clamping to month end', () => {
    // Argo does setMonth(+1) then setDate(+1) on a JS Date, so Jan 31 rolls
    // through Feb 31 -> Mar 3, then +1 day. Reproduced exactly, not "fixed" —
    // the two apps must agree on which events are selectable.
    expect(selectionCutoff('2026-01-31')).toBe('2026-03-04');
  });

  it('handles a leap-year February', () => {
    expect(selectionCutoff('2028-01-31')).toBe('2028-03-03');
  });
});

describe('orderSelectableEvents', () => {
  const events = [
    { id: 'c', name: 'Champs Chicago', city: null, state: null, startDate: '2026-09-10', endDate: '2026-09-12' },
    { id: 'a', name: 'Champs Austin', city: null, state: null, startDate: '2026-01-16', endDate: '2026-01-18' },
    { id: 'v', name: 'Champs Vegas', city: null, state: null, startDate: '2026-08-24', endDate: '2026-08-26' },
    { id: 'o', name: 'Old Show', city: null, state: null, startDate: '2025-03-01', endDate: '2025-03-03' },
  ];

  it('puts selectable events first by soonest start, then past by most recent end', () => {
    const ordered = orderSelectableEvents(events, '2026-08-26');
    expect(ordered.map((e) => e.id)).toEqual(['v', 'c', 'a', 'o']);
  });

  it('flags past events', () => {
    const byId = new Map(orderSelectableEvents(events, '2026-08-26').map((e) => [e.id, e.isPast]));
    expect(byId.get('v')).toBe(false);
    expect(byId.get('c')).toBe(false);
    expect(byId.get('a')).toBe(true);
    expect(byId.get('o')).toBe(true);
  });

  it('treats the cutoff day itself as past', () => {
    const one = [{ id: 'x', name: 'X', city: null, state: null, startDate: '2026-11-01', endDate: '2026-11-03' }];
    expect(orderSelectableEvents(one, '2026-12-03')[0].isPast).toBe(false);
    expect(orderSelectableEvents(one, '2026-12-04')[0].isPast).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/eventSelection.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/eventSelection"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/lib/eventSelection.ts`:

```ts
// Which Argo events belong in Midas's event picker, and in what order.
//
// Pure date maths — no DB, no framework — so the cutoff rule can be tested
// against Argo's without a database. The rule itself is ported from Argo's
// filterActiveEvents (trade-show-app/src/utils/eventUtils.ts): an event stays
// selectable until one month and one day past its end date.

export interface SelectableEventInput {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  startDate: string;
  endDate: string;
}

export interface SelectableEvent extends SelectableEventInput {
  /** Past the cutoff — shown only behind the picker's "past events" toggle. */
  isPast: boolean;
}

/**
 * The first day an event stops being selectable: end date + 1 month + 1 day.
 *
 * Argo computes this with setMonth(+1) then setDate(+1) on a JS Date, which
 * overflows rather than clamping — Jan 31 becomes Mar 3, not Feb 28. That
 * quirk is reproduced deliberately: if the two apps disagreed about which
 * events are selectable, the same expense could be taggable in one and not
 * the other.
 */
export function selectionCutoff(endDate: string): string {
  const [y, m, d] = endDate.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d));
  cutoff.setUTCMonth(cutoff.getUTCMonth() + 1);
  cutoff.setUTCDate(cutoff.getUTCDate() + 1);
  return cutoff.toISOString().slice(0, 10);
}

/** Selectable events first (soonest start), then past events (most recent end). */
export function orderSelectableEvents(
  events: SelectableEventInput[],
  today: string,
): SelectableEvent[] {
  const marked = events.map((e) => ({ ...e, isPast: today >= selectionCutoff(e.endDate) }));

  return marked.sort((a, b) => {
    if (a.isPast !== b.isPast) return a.isPast ? 1 : -1;
    return a.isPast
      ? b.endDate.localeCompare(a.endDate)
      : a.startDate.localeCompare(b.startDate);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/eventSelection.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/eventSelection.ts apps/api/src/__tests__/eventSelection.test.ts
git commit -m "feat(events): port Argo's event-selection cutoff as a pure helper"
```

---

### Task 2: Event source-field mapping

**Files:**
- Modify: `apps/api/src/lib/eventSelection.ts`
- Test: `apps/api/src/__tests__/eventSelection.test.ts`

**Interfaces:**
- Consumes: `SelectableEvent` from Task 1.
- Produces: `eventSourceFields(event: { id: string; name: string }): EventSourceFields` and `CLEARED_EVENT_SOURCE_FIELDS`, both used by Tasks 4 and 5. `EventSourceFields` is `{ sourceApp: string | null; sourceType: string | null; sourceLabel: string | null; sourceContext: Record<string, unknown> }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/__tests__/eventSelection.test.ts` (and extend the import on line 2 to `import { selectionCutoff, orderSelectableEvents, eventSourceFields, CLEARED_EVENT_SOURCE_FIELDS } from '../lib/eventSelection';`):

```ts
describe('eventSourceFields', () => {
  it('writes the trade_show contract, taking the label from the event row', () => {
    expect(eventSourceFields({ id: 'evt-1', name: 'Champs Spring LV 2026' })).toEqual({
      sourceApp: 'trade_show',
      sourceType: 'trade_show_event',
      sourceLabel: 'Champs Spring LV 2026',
      sourceContext: { eventId: 'evt-1', eventName: 'Champs Spring LV 2026' },
    });
  });

  it('clears back to a daily expense', () => {
    expect(CLEARED_EVENT_SOURCE_FIELDS).toEqual({
      sourceApp: null,
      sourceType: null,
      sourceLabel: null,
      sourceContext: {},
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/eventSelection.test.ts`
Expected: FAIL — `eventSourceFields is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/api/src/lib/eventSelection.ts`:

```ts
/** The five columns an event selection owns. */
export interface EventSourceFields {
  sourceApp: string | null;
  sourceType: string | null;
  sourceLabel: string | null;
  sourceContext: Record<string, unknown>;
}

/**
 * Columns to write when an event is chosen. `sourceLabel` comes from the event
 * row read out of Argo, never from the request — Reports and the Event Review
 * filter both group on it, so a client-supplied name would fragment them.
 * `sourceRefId` stays null: Midas owns this row, Argo did not create it.
 */
export function eventSourceFields(event: { id: string; name: string }): EventSourceFields {
  return {
    sourceApp: 'trade_show',
    sourceType: 'trade_show_event',
    sourceLabel: event.name,
    sourceContext: { eventId: event.id, eventName: event.name },
  };
}

/** Columns to write when the event is removed — back to a daily expense. */
export const CLEARED_EVENT_SOURCE_FIELDS: EventSourceFields = {
  sourceApp: null,
  sourceType: null,
  sourceLabel: null,
  sourceContext: {},
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/eventSelection.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/eventSelection.ts apps/api/src/__tests__/eventSelection.test.ts
git commit -m "feat(events): map an event selection to its source_* columns"
```

---

### Task 3: Event list adapter and endpoint

**Files:**
- Modify: `apps/api/src/lib/tradeShowEvents.ts` (append after `listWindowedEvents`)
- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/server.ts` (import block near line 20, mount near line 98)

**Interfaces:**
- Consumes: `orderSelectableEvents`, `SelectableEvent` (Task 1); `isTradeShowLinkEnabled`, `tradeShowPool`, `dateStr` (existing, in `tradeShowEvents.ts`).
- Produces: `listSelectableEvents(today: string): Promise<SelectableEvent[]>` and `findSelectableEvent(id: string, today: string): Promise<SelectableEvent | null>`, both used by Tasks 4 and 5. `GET /api/v1/events` → `{ events: SelectableEvent[], available: boolean }`.

- [ ] **Step 1: Add the adapter functions**

Append to `apps/api/src/lib/tradeShowEvents.ts`:

```ts
/**
 * Every event Midas will let a user tag an expense with, ordered selectable
 * first. Unlike listWindowedEvents this is not date-windowed in SQL: an
 * accountant reconciling last quarter's spend still needs older shows, and the
 * table is small enough (hundreds of rows) that filtering in TypeScript keeps
 * the cutoff rule in one tested place.
 */
export async function listSelectableEvents(today: string): Promise<SelectableEvent[]> {
  const { rows } = await tradeShowPool().query(
    `SELECT id, name, city, state, start_date, end_date
     FROM events
     ORDER BY start_date DESC`,
  );

  return orderSelectableEvents(
    rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      city: r.city,
      state: r.state,
      startDate: dateStr(r.start_date)!,
      endDate: dateStr(r.end_date)!,
    })),
    today,
  );
}

/** One event by id, or null. Used to resolve a client's chosen eventId. */
export async function findSelectableEvent(
  id: string,
  today: string,
): Promise<SelectableEvent | null> {
  const { rows } = await tradeShowPool().query(
    `SELECT id, name, city, state, start_date, end_date FROM events WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return orderSelectableEvents(
    [{
      id: String(r.id),
      name: r.name,
      city: r.city,
      state: r.state,
      startDate: dateStr(r.start_date)!,
      endDate: dateStr(r.end_date)!,
    }],
    today,
  )[0];
}
```

Extend the existing import at the top of the file to pull in the helpers:

```ts
import { orderSelectableEvents, type SelectableEvent } from './eventSelection';
```

- [ ] **Step 2: Create the route**

Create `apps/api/src/routes/events.ts`:

```ts
// Argo's event list, for the expense form's event picker.
//
// Read-only and best-effort: an unset TRADESHOW_DATABASE_URL or an unreachable
// Argo database returns an empty list with available:false, exactly as
// /accountant/upcoming-events does. The picker hides itself rather than
// showing an empty dropdown, and expense entry keeps working.

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { isTradeShowLinkEnabled, listSelectableEvents } from '../lib/tradeShowEvents';
import { localTodayIso } from '../lib/cashLedger';

const router = Router();
router.use(authenticate);

router.get('/', asyncHandler(async (_req, res) => {
  if (!isTradeShowLinkEnabled()) {
    res.json({ events: [], available: false });
    return;
  }

  try {
    const events = await listSelectableEvents(localTodayIso());
    res.json({ events, available: true });
  } catch (err) {
    console.error('[events] trade show lookup failed:', err);
    res.json({ events: [], available: false });
  }
}));

export default router;
```

- [ ] **Step 3: Mount the route**

In `apps/api/src/server.ts`, add to the import block alongside the other routers:

```ts
import eventsRouter from './routes/events';
```

and mount it beside the other `/api/v1` routes (after the `companies` line):

```ts
app.use('/api/v1/events', eventsRouter);
```

- [ ] **Step 4: Verify it compiles and the suite still passes**

Run: `cd apps/api && npm run lint && npm test`
Expected: `tsc --noEmit` silent; all existing tests pass (this task adds no unit tests — the adapter is a thin DB wrapper whose logic lives in Task 1's tested helper, and `npm test` is deliberately DB-free).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/tradeShowEvents.ts apps/api/src/routes/events.ts apps/api/src/server.ts
git commit -m "feat(events): expose Argo's event list at GET /api/v1/events"
```

---

### Task 4: Accept eventId on expense create and update

**Files:**
- Modify: `apps/api/src/routes/expenses.ts` (`createExpenseSchema` line 33, `POST /` line 149, `PATCH /:id`)
- Test: `apps/api/src/__tests__/eventSelection.test.ts`

**Interfaces:**
- Consumes: `eventSourceFields`, `CLEARED_EVENT_SOURCE_FIELDS` (Task 2); `findSelectableEvent` (Task 3).
- Produces: `EventLookup = (id: string) => Promise<{ id: string; name: string } | null>` and `resolveEventPatch(eventId: string | null | undefined, lookup: EventLookup): Promise<EventSourceFields | undefined>`, both exported from `lib/eventSelection.ts`. Taking the lookup as a parameter rather than calling the adapter directly is what keeps this module DB-free and unit-testable.

**Already covered — do not add:** `autoApprove.test.ts:14` already asserts `isAutoPushEligible({ sourceApp: 'trade_show', ready: true }) === false`, which is the spec's "event-tagged expense does not auto-push" requirement. Leave `lib/autoApprove.ts` untouched.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/__tests__/eventSelection.test.ts`, and add to its imports: `import { resolveEventPatch } from '../lib/eventSelection';`

```ts
describe('resolveEventPatch', () => {
  const lookup = async (id: string) =>
    id === 'evt-1' ? { id: 'evt-1', name: 'Champs Spring LV 2026' } : null;

  it('leaves the expense alone when eventId is absent', async () => {
    expect(await resolveEventPatch(undefined, lookup)).toBeUndefined();
  });

  it('clears the event when eventId is null', async () => {
    expect(await resolveEventPatch(null, lookup)).toEqual(CLEARED_EVENT_SOURCE_FIELDS);
  });

  it('resolves a known event to its source fields', async () => {
    expect(await resolveEventPatch('evt-1', lookup)).toEqual({
      sourceApp: 'trade_show',
      sourceType: 'trade_show_event',
      sourceLabel: 'Champs Spring LV 2026',
      sourceContext: { eventId: 'evt-1', eventName: 'Champs Spring LV 2026' },
    });
  });

  it('throws UNKNOWN_EVENT rather than silently leaving the expense untagged', async () => {
    await expect(resolveEventPatch('nope', lookup)).rejects.toMatchObject({
      code: 'UNKNOWN_EVENT',
      statusCode: 400,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/eventSelection.test.ts`
Expected: FAIL — `resolveEventPatch is not a function`.

- [ ] **Step 3: Implement the resolver**

Append to `apps/api/src/lib/eventSelection.ts`. Note the hand-rolled error: this module must stay importable without `DATABASE_URL`/`JWT_SECRET`, and importing `createError` would drag in `../config/env`, which calls `process.exit(1)` outside a configured environment — the same reasoning `lib/queueScope.ts:3` documents.

```ts
import type { AppError } from '../middleware/error';

/** Looks an event id up; returns null when it does not exist. */
export type EventLookup = (id: string) => Promise<{ id: string; name: string } | null>;

/**
 * Turn a request's `eventId` into columns to write.
 *
 * - `undefined` (key absent)  -> undefined, leave the expense as it is
 * - `null`                    -> clear the event, back to a daily expense
 * - an id                     -> that event's source fields
 * - an unknown id             -> 400, never a silently untagged expense
 */
export async function resolveEventPatch(
  eventId: string | null | undefined,
  lookup: EventLookup,
): Promise<EventSourceFields | undefined> {
  if (eventId === undefined) return undefined;
  if (eventId === null) return CLEARED_EVENT_SOURCE_FIELDS;

  const event = await lookup(eventId);
  if (!event) {
    const err = new Error(`Unknown event: ${eventId}`) as AppError;
    err.statusCode = 400;
    err.code = 'UNKNOWN_EVENT';
    throw err;
  }
  return eventSourceFields(event);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/eventSelection.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Wire it into the expense routes**

In `apps/api/src/routes/expenses.ts`, add to `createExpenseSchema` (after the `expenseKind` line):

```ts
  /** Argo event id. null clears the event; absent leaves it unchanged. */
  eventId: z.string().min(1).nullable().optional(),
```

Add these imports at the top of the file:

```ts
import { resolveEventPatch } from '../lib/eventSelection';
import { findSelectableEvent, isTradeShowLinkEnabled } from '../lib/tradeShowEvents';
import { localTodayIso } from '../lib/cashLedger';
```

Add this helper just above `router.post('/')`:

```ts
/** Resolve a request's eventId against Argo, or refuse if the link is down. */
async function eventPatch(eventId: string | null | undefined) {
  if (eventId === undefined || eventId === null) return resolveEventPatch(eventId, async () => null);
  if (!isTradeShowLinkEnabled()) {
    throw createError('Event tagging is unavailable — the trade show link is not configured', 503, 'EVENTS_UNAVAILABLE');
  }
  return resolveEventPatch(eventId, (id) => findSelectableEvent(id, localTodayIso()));
}
```

In `POST /`, immediately before `const [expense] = await db.insert(expenses).values({`:

```ts
  const event = await eventPatch(body.eventId);
```

and spread it into the insert values, after `reimbursementStatus,`:

```ts
    ...(event ?? {}),
```

In `PATCH /:id`, resolve the same way and spread `...(event ?? {})` into the `.set({ ... })` object alongside the other patched columns.

- [ ] **Step 6: Verify**

Run: `cd apps/api && npm run lint && npm test`
Expected: `tsc --noEmit` silent; 541+ tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/eventSelection.ts apps/api/src/routes/expenses.ts apps/api/src/__tests__/eventSelection.test.ts
git commit -m "feat(expenses): accept eventId on create and update"
```

---

### Task 5: Accountant re-tag on the details edit

**Files:**
- Modify: `apps/api/src/lib/accountantDetailsEdit.ts`
- Modify: `apps/api/src/routes/accountant.ts` (`detailsSchema` line 939, `PATCH /expenses/:id/details` line 946)
- Test: `apps/api/src/__tests__/accountantDetailsEdit.test.ts`

**Interfaces:**
- Consumes: `eventSourceFields`, `CLEARED_EVENT_SOURCE_FIELDS`, `resolveEventPatch` (Tasks 2, 4); `findSelectableEvent` (Task 3).
- Produces: `DetailsEditTarget` gains `sourceRefId: string | null` and `sourceContext: Record<string, unknown> | null`; `DetailsEditPatch` gains `event?: { id: string; name: string } | null`; `DetailsEditChanges` gains the four `source*` keys; refusal code union gains `'EVENT_NOT_EDITABLE'`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/__tests__/accountantDetailsEdit.test.ts`:

```ts
describe('planAccountantDetailsEdit — event re-tag', () => {
  const midasOwned = {
    merchant: 'SPEEDEE MART', amount: '10.46', date: '2026-08-25',
    paymentMethodId: null, zohoExpenseId: null,
    sourceRefId: null, sourceContext: {},
  };

  it('attaches an event to a Midas-owned expense', () => {
    const plan = planAccountantDetailsEdit(
      midasOwned,
      { event: { id: 'evt-1', name: 'Champs Spring LV 2026' } },
      [],
    );
    expect(plan).toEqual({
      ok: true,
      changes: {
        sourceApp: 'trade_show',
        sourceType: 'trade_show_event',
        sourceLabel: 'Champs Spring LV 2026',
        sourceContext: { eventId: 'evt-1', eventName: 'Champs Spring LV 2026' },
      },
    });
  });

  it('clears the event back to daily', () => {
    const tagged = { ...midasOwned, sourceContext: { eventId: 'evt-1' } };
    const plan = planAccountantDetailsEdit(tagged, { event: null }, []);
    expect(plan).toEqual({
      ok: true,
      changes: { sourceApp: null, sourceType: null, sourceLabel: null, sourceContext: {} },
    });
  });

  it('is a no-op when the same event is re-selected', () => {
    const tagged = { ...midasOwned, sourceContext: { eventId: 'evt-1', eventName: 'Champs Spring LV 2026' } };
    const plan = planAccountantDetailsEdit(
      tagged,
      { event: { id: 'evt-1', name: 'Champs Spring LV 2026' } },
      [],
    );
    expect(plan).toEqual({ ok: true, changes: {} });
  });

  it('refuses to re-tag an Argo-created row, whose (source_app, source_ref_id) is Argo\'s idempotency key', () => {
    const argoOwned = { ...midasOwned, sourceRefId: 'ts-4471' };
    const plan = planAccountantDetailsEdit(argoOwned, { event: null }, []);
    expect(plan).toMatchObject({ ok: false, refusal: { code: 'EVENT_NOT_EDITABLE', status: 409 } });
  });

  it('still refuses every edit once pushed to Zoho', () => {
    const pushed = { ...midasOwned, zohoExpenseId: 'zoho-1' };
    const plan = planAccountantDetailsEdit(
      pushed,
      { event: { id: 'evt-1', name: 'Champs Spring LV 2026' } },
      [],
    );
    expect(plan).toMatchObject({ ok: false, refusal: { code: 'NOT_EDITABLE', status: 409 } });
  });
});
```

Add to that file's imports if not already present: `import { planAccountantDetailsEdit } from '../lib/accountantDetailsEdit';`

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/accountantDetailsEdit.test.ts`
Expected: FAIL — the `event` key is not in `DetailsEditPatch`, and no `source*` changes are produced.

- [ ] **Step 3: Extend the planner**

In `apps/api/src/lib/accountantDetailsEdit.ts`, add the import:

```ts
import { eventSourceFields, CLEARED_EVENT_SOURCE_FIELDS } from './eventSelection';
```

Extend the three interfaces:

```ts
export interface DetailsEditTarget {
  merchant: string | null;
  amount: string | null;
  date: string;
  paymentMethodId: string | null;
  zohoExpenseId: string | null;
  /** Non-null means Argo created this row and owns its source identity. */
  sourceRefId: string | null;
  sourceContext: Record<string, unknown> | null;
}

export interface DetailsEditPatch {
  merchant?: string;
  amount?: number;
  date?: string;
  paymentMethodId?: string;
  /** Attach an event, or null to clear it. Absent leaves it alone. */
  event?: { id: string; name: string } | null;
}

export interface DetailsEditChanges {
  merchant?: string;
  amount?: string;
  date?: string;
  paymentMethodId?: string;
  sourceApp?: string | null;
  sourceType?: string | null;
  sourceLabel?: string | null;
  sourceContext?: Record<string, unknown>;
}
```

Widen the refusal code union:

```ts
  code: 'NOT_EDITABLE' | 'PERIOD_CLOSED' | 'EVENT_NOT_EDITABLE';
```

Then, inside `planAccountantDetailsEdit`, after the closed-period guard and before `const changes: DetailsEditChanges = {};`:

```ts
  // An Argo-created row's (source_app, source_ref_id) pair is the key Argo
  // re-imports against. Re-tagging it here would break that pair, so the event
  // on those rows is Argo's to change, not ours.
  if (patch.event !== undefined && expense.sourceRefId) {
    return {
      ok: false,
      refusal: {
        code: 'EVENT_NOT_EDITABLE',
        message: 'This expense came from the trade show app — change its event there.',
        status: 409,
      },
    };
  }
```

and after the `paymentMethodId` comparison, before `return { ok: true, changes };`:

```ts
  if (patch.event !== undefined) {
    // sourceContext is an open Record, so index it through an explicit cast —
    // `unknown` would not compare against a string id.
    const currentEventId = (expense.sourceContext?.eventId as string | undefined) ?? null;
    const nextEventId = patch.event?.id ?? null;
    if (currentEventId !== nextEventId) {
      Object.assign(changes, patch.event ? eventSourceFields(patch.event) : CLEARED_EVENT_SOURCE_FIELDS);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/accountantDetailsEdit.test.ts`
Expected: PASS — existing tests plus the 5 new ones.

- [ ] **Step 5: Wire the route**

In `apps/api/src/routes/accountant.ts`, extend `detailsSchema`:

```ts
const detailsSchema = z.object({
  merchant: z.string().min(1).optional(),
  amount: z.coerce.number().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentMethodId: z.string().uuid().optional(),
  /** Argo event id; null clears the event. */
  eventId: z.string().min(1).nullable().optional(),
});
```

Add imports:

```ts
import { findSelectableEvent } from '../lib/tradeShowEvents';
```

In the handler, between the `notFound` guard and the `planAccountantDetailsEdit` call, turn `eventId` into the planner's `event` shape:

```ts
  // The name is read from Argo, never taken from the request — see the spec's
  // "server resolves the event name" decision.
  let event: { id: string; name: string } | null | undefined;
  if (patch.eventId === null) {
    event = null;
  } else if (patch.eventId !== undefined) {
    const found = await findSelectableEvent(patch.eventId, localTodayIso());
    if (!found) throw createError(`Unknown event: ${patch.eventId}`, 400, 'UNKNOWN_EVENT');
    event = { id: found.id, name: found.name };
  }

  const plan = planAccountantDetailsEdit(expense, { ...patch, event }, await getClosedPeriods());
```

- [ ] **Step 6: Verify**

Run: `cd apps/api && npm run lint && npm test`
Expected: `tsc --noEmit` silent; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/accountantDetailsEdit.ts apps/api/src/routes/accountant.ts apps/api/src/__tests__/accountantDetailsEdit.test.ts
git commit -m "feat(accountant): re-tag an expense's event from the review screen"
```

---

### Task 6: EventPicker component and API client

**Files:**
- Create: `apps/web/src/components/EventPicker.tsx`
- Modify: `apps/web/src/api/expenses.ts` (`expenseApi.create` line 20, `expenseApi.update` line 37, `accountantApi.updateDetails` line 226)

**Interfaces:**
- Consumes: `GET /api/v1/events` (Task 3).
- Produces: `<EventPicker value={string} onChange={(id: string) => void} />` used by Tasks 7 and 8; `expenseApi.events()`; `eventId` accepted by `expenseApi.create`, `expenseApi.update` and `accountantApi.updateDetails`.

- [ ] **Step 1: Add the API client methods**

In `apps/web/src/api/expenses.ts`, add to `expenseApi` after `checkDuplicate`:

```ts
  /** Argo's event list for the picker. available:false → hide the picker. */
  events: () =>
    client.get<{
      events: Array<{ id: string; name: string; city: string | null; state: string | null; startDate: string; endDate: string; isPast: boolean }>;
      available: boolean;
    }>('/events').then((r) => r.data),
```

Add `eventId?: string | null;` to the `create` parameter type and `eventId: string | null;` to the `update` `Partial<{...}>` type. Add `eventId?: string | null;` to `accountantApi.updateDetails`' `data` type.

- [ ] **Step 2: Create the component**

Create `apps/web/src/components/EventPicker.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { expenseApi } from '../api/expenses';

/**
 * Trade-show event selector, mirroring Argo's own picker: selectable events
 * first, older ones behind a "show past events" toggle.
 *
 * Two deliberate differences. It is optional here — Argo's is required because
 * every Argo expense is event spend, while most Midas expenses are daily — and
 * it has no inline "create event" button, because Midas reads Argo's events
 * through a SELECT-only role and must not write to another app's table.
 *
 * Renders nothing when the trade show link is unavailable, so a missing
 * TRADESHOW_DATABASE_URL degrades to "no picker" rather than an empty dropdown.
 */
export function EventPicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (eventId: string) => void;
  className?: string;
}) {
  const [showPast, setShowPast] = useState(false);

  const { data } = useQuery({
    queryKey: ['events'],
    queryFn: () => expenseApi.events(),
    staleTime: 60_000,
  });

  if (!data?.available) return null;

  const current = data.events.filter((e) => !e.isPast);
  const past = data.events.filter((e) => e.isPast);
  // A past event already attached to this expense must stay reachable, or
  // saving the form would silently drop it.
  const selectedIsPast = past.some((e) => e.id === value);

  return (
    <div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
      >
        <option value="">No event — daily expense</option>
        {current.map((e) => (
          <option key={e.id} value={e.id}>{e.name}</option>
        ))}
        {(showPast || selectedIsPast) && past.length > 0 && (
          <optgroup label="── Past events ──">
            {past.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </optgroup>
        )}
      </select>
      {past.length > 0 && !selectedIsPast && (
        <button
          type="button"
          onClick={() => setShowPast(!showPast)}
          className="mt-1 flex items-center gap-1 text-xs text-charcoal/50 hover:text-charcoal/80"
        >
          <Clock className="h-3 w-3" />
          {showPast ? 'Hide past events' : `Show ${past.length} past event${past.length === 1 ? '' : 's'}`}
        </button>
      )}
      <p className="mt-1 text-xs text-charcoal/40">
        Event missing? Create it in the trade show app first.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/web && npm run lint`
Expected: `tsc --noEmit` silent.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/EventPicker.tsx apps/web/src/api/expenses.ts
git commit -m "feat(web): event picker component mirroring Argo's"
```

---

### Task 7: Picker on the New Expense form

**Files:**
- Modify: `apps/web/src/pages/ExpenseNew.tsx` (form state line 56, payload line 289, fields near line 608)

**Interfaces:**
- Consumes: `<EventPicker>` (Task 6), `eventId` on `expenseApi.create`/`update` (Task 6).
- Produces: nothing downstream.

- [ ] **Step 1: Add the field to form state**

In `apps/web/src/pages/ExpenseNew.tsx`, add to the `useState` object at line 56, after `referenceNumber: '',`:

```ts
    eventId: '',
```

- [ ] **Step 2: Add the import**

```tsx
import { EventPicker } from '../components/EventPicker';
```

- [ ] **Step 3: Send it in the payload**

In `doSubmit`, add to the `payload` object after `referenceNumber:`:

```ts
        eventId: form.eventId || null,
```

Sending `null` rather than `undefined` when empty matters: on the wizard's second pass the expense already exists and goes through `expenseApi.update`, where an absent key means "leave alone" — so clearing a previously chosen event needs an explicit null.

- [ ] **Step 4: Render the picker**

Immediately after the `<Field label="Category">…</Field>` block (around line 618), add:

```tsx
          <Field label="Event">
            <EventPicker
              value={form.eventId}
              onChange={(id) => set('eventId', id)}
              className={inputCls}
            />
          </Field>
```

- [ ] **Step 5: Verify**

Run: `cd apps/web && npm run lint && npm run build`
Expected: both silent/successful.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/ExpenseNew.tsx
git commit -m "feat(web): pick an event when entering an expense"
```

---

### Task 8: Picker on the accountant's Correct details editor

**Files:**
- Modify: `apps/web/src/components/AccountantDetailsEdit.tsx` (form state line 24, mutation line 34, form body)

**Interfaces:**
- Consumes: `<EventPicker>` (Task 6), `eventId` on `accountantApi.updateDetails` (Task 6).
- Produces: nothing downstream.

- [ ] **Step 1: Seed the field from the expense**

In `apps/web/src/components/AccountantDetailsEdit.tsx`, extend the form state at line 24:

```ts
  const [form, setForm] = useState({ merchant: '', amount: '', date: '', paymentMethodId: '', eventId: '' });
```

In `openEditor()` (line 68), seed every field including the new one:

```ts
  function openEditor() {
    setForm({
      merchant: expense.merchant ?? '',
      amount: expense.amount != null ? String(expense.amount) : '',
      date: expense.date ?? '',
      paymentMethodId: expense.paymentMethodId ?? '',
      eventId: (expense.sourceContext as { eventId?: string } | null)?.eventId ?? '',
    });
    setError('');
    setEditing(true);
  }
```

If `sourceContext` is not yet on the web `Expense` type, add it to `packages/shared/src/types/index.ts` next to `sourceLabel`:

```ts
  /** Embedder context — `{ eventId, eventName }` for trade-show expenses. */
  sourceContext?: Record<string, unknown> | null;
```

and include `sourceContext` in the accountant expense serializer if it is not already returned (the queue's `findMany` returns all columns, so it already is).

- [ ] **Step 2: Send it in the patch**

In the `mutationFn`, extend the patch type and add the comparison, after the `paymentMethodId` block:

```ts
      const currentEventId = (expense.sourceContext as { eventId?: string } | null)?.eventId ?? '';
      if (form.eventId !== currentEventId) patch.eventId = form.eventId || null;
```

and widen the patch type to `{ merchant?: string; amount?: number; date?: string; paymentMethodId?: string; eventId?: string | null }`.

- [ ] **Step 3: Render the picker**

Add inside the editing form, after the payment-method field:

```tsx
          <div>
            <label className="mb-1 block text-xs font-medium text-charcoal/60">Event</label>
            <EventPicker
              value={form.eventId}
              onChange={(id) => setForm((f) => ({ ...f, eventId: id }))}
              className={inputCls}
            />
          </div>
```

with the import:

```tsx
import { EventPicker } from './EventPicker';
```

- [ ] **Step 4: Surface the new refusal**

The component's `onError` (line 58) passes the server's message straight through for known codes and swallows it otherwise. Add the new code to that list so an Argo-owned row explains itself instead of showing "Could not save changes":

```ts
      setError(
        (code === 'NOT_EDITABLE' || code === 'PERIOD_CLOSED' || code === 'EVENT_NOT_EDITABLE') && message
          ? message
          : message ?? 'Could not save changes. Please try again.',
      );
```

- [ ] **Step 5: Verify**

Run: `cd apps/web && npm run lint && npm run build`
Expected: both silent/successful.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/AccountantDetailsEdit.tsx packages/shared/src/types/index.ts
git commit -m "feat(accountant): change an expense's event from the review screen"
```

---

### Task 9: Release and verify against prod

**Files:**
- Modify: `packages/shared/src/version.ts`, `apps/api/package.json`, `apps/web/package.json`, `packages/shared/package.json`, `docs/CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a deployed, verified release.

- [ ] **Step 1: Bump the version**

MINOR — new user-visible feature plus a new endpoint. Set `1.5.0` in `packages/shared/src/version.ts` (`MIDAS_VERSION`) and in the `"version"` field of all three package.json files. All four must agree (`docs/VERSIONING.md`).

- [ ] **Step 2: Write the changelog entry**

Add a `## 1.5.0 (2026-08-26)` section to `docs/CHANGELOG.md` above `## 1.4.1`, covering: the picker on the New Expense form, event re-tagging from the review screen, `GET /api/v1/events`, and the two refusals (already pushed to Zoho; Argo-owned rows).

- [ ] **Step 3: Full verification**

```bash
cd apps/api && npm run lint && npm test
cd ../web && npm run lint && npm run build
```
Expected: `tsc --noEmit` silent in both; all API tests pass.

- [ ] **Step 4: Commit and tag**

```bash
git add -A
git commit -m "chore: bump version to 1.5.0"
git tag v1.5.0
```

- [ ] **Step 5: Deploy**

Follow `docs/OPERATIONS.md` "Deploying a new version". `/opt/midas` on CT 3120 is **not** a git checkout — ship a tarball of changed files:

```bash
COPYFILE_DISABLE=1 tar czf /tmp/midas-1.5.0.tar.gz $(git diff --name-only v1.4.1 HEAD | tr '\n' ' ')
scp /tmp/midas-1.5.0.tar.gz root@192.168.1.190:/tmp/
ssh root@192.168.1.190 "pct push 3120 /tmp/midas-1.5.0.tar.gz /tmp/midas-1.5.0.tar.gz \
  && pct exec 3120 -- bash -c 'cd /opt/midas && tar xzf /tmp/midas-1.5.0.tar.gz'"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --no-deps --build api'"
ssh root@192.168.1.190 "pct exec 3120 -- bash -c 'cd /opt/midas && docker compose -f docker-compose.prod.yml up -d --no-deps --build web'"
```

Use the **prod compose file only** for both containers — building either from the base file downgrades it to the dev target.

- [ ] **Step 6: Verify on prod**

```bash
curl -s https://midas.booute.duckdns.org/api/v1/meta          # expect 1.5.0 + "environment":"production"
curl -s -o /dev/null -w '%{http_code}\n' https://midas.booute.duckdns.org/   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' https://midas.booute.duckdns.org/api/v1/events  # expect 401, not 404
ssh root@192.168.1.190 "pct exec 3120 -- docker logs midas-api-1 2>&1 | grep -iE 'CONFIG (MISSING|SUSPECT)'"
```

The `.env` reload on container recreate is the moment config regressions surface — the only expected line is the known-missing `TELEGRAM_BOT_TOKEN`.

Then in the browser: create an expense with an event attached, confirm it lands in **Event Review** (not Daily) with the event shown in the v1.4.0 Event column; re-tag it to a different event from the review screen; clear the event and confirm it moves to Daily Review.

- [ ] **Step 7: Push**

```bash
git push origin main
git push origin v1.5.0
```
