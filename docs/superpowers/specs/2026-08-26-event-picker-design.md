# Event picker for Midas-entered expenses — design

Approved in chat 2026-08-26. Lets an expense created inside Midas be attached
to a trade-show event, so the accountant can enter event spend without going
through Argo (the trade show app, formerly `trade-show-app`).

## The problem

Midas is the expense hub for both daily and event spend, but every expense
*created in Midas* is necessarily daily. `createExpenseSchema`
(`apps/api/src/routes/expenses.ts:33`) has no way to set `sourceApp`,
`sourceLabel` or `sourceContext`, so a Midas-created row always has
`sourceApp = null` — which `scopeCondition` (`lib/queueScope.ts:48`) routes to
Daily Review. Event spend entered in Midas is therefore invisible to Event
Review, to the event breakdown in Reports, and to Argo.

## Context discovered

- **Midas already reads Argo's events**, read-only, over a direct Postgres
  link: `lib/tradeShowEvents.ts` with the `midas_ro` role (SELECT on `events`
  only, pg_hba scoped to CT 3120). Today it exposes just
  `listWindowedEvents(today)` — a ±10-day window for the dashboard's Upcoming
  Events card. The columns available are `id, name, venue, city, state,
  start_date, end_date, travel_start_date, travel_end_date`.
- **Argo's picker** (`trade-show-app/src/components/expenses/ExpenseForm.tsx:470`)
  is a native `<select>`, required, placeholder "Select an event". Its active
  list comes from `filterActiveEvents` (`src/utils/eventUtils.ts`): an event
  stays selectable until **1 month + 1 day past its end date**. Older events
  appear in a `<optgroup label="── Past Events ──">` behind a "show past
  events" toggle. It also offers inline **quick-create** for privileged roles
  and filters by event participation.
- **Two of Argo's behaviours cannot port.** Quick-create writes to `events`,
  which `midas_ro` cannot do. Participation filtering needs a participants
  table `midas_ro` cannot read — and is moot anyway, since Argo grants
  accountant/admin/developer/coordinator access to every event regardless.
- **Null `sourceRefId` is safe for Argo.** Its adapter maps Midas rows with
  `id: e.sourceRefId || e.id`
  (`backend/src/services/expenseStore/midasAdapter.ts:11`), so a Midas-created
  expense with no `sourceRefId` surfaces under its Midas UUID rather than
  breaking. The `expenses_source_unique_idx` unique index on
  `(source_app, source_ref_id)` also tolerates many `('trade_show', NULL)`
  rows, because Postgres treats NULLs as distinct.
- **`sourceApp = 'trade_show'` is a data contract, not a display name.** The
  app's rename to Argo does not change it (`docs/OPERATIONS.md:244`).
- Only `lib/sourceTypes.ts:23`, `db/seed.ts:87` (category mappings for ext
  ingest) and two spots in `routes/ext.ts` branch on the literal
  `'trade_show'`; none of them affect Midas-native creation.

## Decisions

1. **Event list comes from the existing read-only Postgres link.** Rejected:
   calling an Argo HTTP API (no such endpoint exists; needs credentials in
   both directions and leaves Midas reading the same data two ways) and
   mirroring events into a Midas table (a sync job plus a second source of
   truth for events, which `architecture.md` warns against).
2. **The server resolves the event name; the client only sends an id.** A
   client-supplied label would fragment `source_label`, which both the Reports
   event breakdown (`routes/reports.ts:81`) and the v1.4.0 Event filter group
   on.
3. **Event expenses never auto-push.** `isAutoPushEligible`
   (`lib/autoApprove.ts:6`) stays as written, so an accountant who enters
   event spend must still approve it in Event Review. One rule for all event
   spend beats a faster path that would leave some event expenses out of the
   queue.
4. **The picker is optional in Midas.** Argo makes it required because every
   Argo expense is event spend; in Midas most are not. The empty option reads
   "No event — daily expense", not Argo's "Select an event".
5. **No inline quick-create.** Granting Midas write access to another app's
   `events` table to save a click is not worth it. The picker links to Argo
   instead.
6. **The picker is available at entry and on accountant re-tag** — a daily
   expense that turns out to be event spend must be fixable without
   delete-and-re-enter.
7. **Every role sees the picker on the New Expense form**, not just
   accountants. Argo lets salespeople file their own event expenses, and a
   Midas user who attends a show has the same need; the accountant is simply
   the person who hit the gap first. Re-tagging an *existing* expense stays
   accountant/admin only, since it is a correction of someone else's row.

## Architecture

### Event list

`lib/tradeShowEvents.ts` gains `listSelectableEvents(today)`, returning
`{ id, name, city, state, startDate, endDate, isPast }[]`, active events first
(soonest start date), then past events most-recent-first.

The active/past split is a **pure helper** in a new `lib/eventSelection.ts`,
mirroring how `eventWindow.ts` already isolates the dashboard's window maths.
Rule, ported exactly from Argo: an event is active while
`today < end_date + 1 month + 1 day`. Keeping it in TypeScript rather than SQL
makes the month-boundary behaviour testable without a database.

`GET /api/v1/events` (authenticated, any role) returns
`{ events, available }`. When `TRADESHOW_DATABASE_URL` is unset, or the query
throws, it returns `{ events: [], available: false }` and logs — the same
degrade-don't-error contract `/accountant/upcoming-events` already uses. The
web UI hides the picker entirely when `available` is false, so a broken link
never presents an empty dropdown. Local dev has no picker unless
`TRADESHOW_DATABASE_URL` is set.

### What an event selection writes

`createExpenseSchema` and `updateExpenseSchema` gain one optional field:
`eventId: z.string().nullable().optional()`.

When `eventId` is a non-null value the server looks it up in the event list and
writes, atomically with the rest of the insert/update:

| Column | Value |
|---|---|
| `source_app` | `'trade_show'` |
| `source_type` | `'trade_show_event'` |
| `source_label` | the event's name, read from Argo |
| `source_context` | `{ eventId, eventName }` |
| `source_ref_id` | stays `null` — Midas owns this row |

An unrecognised `eventId` is a 400 (`UNKNOWN_EVENT`), never a silently
untagged expense. `eventId: null` clears all five fields, returning the expense
to daily. Omitting `eventId` leaves the expense unchanged.

### Web

A new `components/EventPicker.tsx` owns the fetch, the active/past grouping and
the "Show past events" toggle, and renders nothing when `available` is false.
Both consumers use it:

- **`pages/ExpenseNew.tsx`** — an optional Event field in the Expense Details
  section.
- **`components/AccountantDetailsEdit.tsx`** — attach, change or clear the
  event on an existing expense. Re-tagging moves the row between Daily and
  Event Review.

Two guards on re-tagging, both corrections to earlier drafts of this spec made
while reading the code:

- **Already pushed to Zoho → refused.** `planAccountantDetailsEdit`
  (`lib/accountantDetailsEdit.ts:57`) rejects *every* field edit once
  `zoho_expense_id` is set, with `NOT_EDITABLE` / 409. The event re-tag goes
  through that same planner and inherits the rule. There is no
  `SyncedChangeConfirm` override on this path — that pattern belongs to the
  category and company endpoints, which have their own routes.
- **Argo-owned rows → refused.** An expense with a non-null `source_ref_id`
  was created by Argo, and its `(source_app, source_ref_id)` pair is the
  idempotency key Argo re-imports against. Clearing or changing the event on
  such a row would break that pair, so re-tagging is limited to rows Midas
  owns (`source_ref_id IS NULL`).

Re-tagging is audit-logged through `planAccountantDetailsEdit`
(`lib/accountantDetailsEdit.ts`), so the before/after event is recoverable.

## Known limitation

If Argo renames an event, Midas rows keep the `source_label` captured at
selection time and will group separately from rows tagged after the rename.
This is already true of Argo-submitted expenses and is out of scope here;
`source_context.eventId` remains the stable key for anyone who needs one.

## Testing

Unit (no DB):

- `eventSelection.ts` — active vs past either side of the `end_date + 1 month
  + 1 day` cutoff, including a month-length boundary (e.g. Jan 31 → Feb 28)
  and same-day-as-cutoff.
- Ordering: active by soonest start, past by most recent end.

Route:

- `POST /expenses` with a valid `eventId` writes all five source fields.
- Unknown `eventId` → 400 `UNKNOWN_EVENT`, no row created.
- `PATCH` with `eventId: null` clears the fields back to daily.
- Omitting `eventId` on update leaves an existing event tag intact.
- An event-tagged expense does **not** auto-push on submit.

Manual, against prod's real event list: pick an event on a new expense, confirm
it lands in Event Review (not Daily) with the event shown in the v1.4.0 column,
then re-tag it to another event from the review screen.

## Files

| File | Change |
|---|---|
| `apps/api/src/lib/tradeShowEvents.ts` | `listSelectableEvents()` |
| `apps/api/src/lib/eventSelection.ts` | new — pure active/past split + ordering |
| `apps/api/src/routes/events.ts` | new — `GET /api/v1/events` |
| `apps/api/src/server.ts` | mount the events route |
| `apps/api/src/routes/expenses.ts` | `eventId` on create/update + resolution |
| `apps/api/src/routes/accountant.ts` | `eventId` on the details edit |
| `apps/api/src/lib/accountantDetailsEdit.ts` | plan + audit the event change |
| `apps/web/src/components/EventPicker.tsx` | new |
| `apps/web/src/pages/ExpenseNew.tsx` | picker in Expense Details |
| `apps/web/src/components/AccountantDetailsEdit.tsx` | picker in Correct details |
| `apps/web/src/api/expenses.ts` | `events()` client + `eventId` in payloads |
