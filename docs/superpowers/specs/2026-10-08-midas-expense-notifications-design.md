# Expense Notifications via Midas — Design

**Date:** 2026-10-08
**Status:** Awaiting review
**Scope:** Two repositories: Midas (`~/Work/midas`, currently v1.20.0) and
Argo (`trade-show-app`, currently v2.32.0). Spec 2 of 2; spec 1 is
`2026-10-08-notification-catalog-design.md` (live as v2.32.0).
**Target releases:** Midas v1.21.0, Argo v2.33.0.

## Goal

Accountants work in Midas, so Midas tells them when an expense needs them.
Argo users work in Argo, so Argo tells them what happened to their expense:
approved, rejected, more info requested, a message, a mention, reimbursement
paid, or details missing. They can reply from Argo. Nobody hears the same
thing from both apps, and Argo's browser-computed "pending expenses" bell
goes away for every role.

Success means: an accountant gets a push in Midas for each expense that needs
them; an Argo user gets exactly one bell row and one push in Argo for each
event on their expense, within seconds in the normal case and within two
minutes in the worst; and no notification is lost when either app restarts.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Where does the accountant hear about submitted expenses? | Midas only. |
| Which Midas events reach the Argo user? | Approved, rejected, more info requested, new message, mentioned, reimbursement paid, expense missing details. |
| When is the accountant notified? | When an expense needs review: it enters the review queue, or it is auto-approved in a category marked "needs accountant". |
| What is "ask accountant"? | A category choice. Modelled as a flag on the category, not its name. |
| How is the accountant notified? | One push and one badge count per expense. The bell list shows one row per submitter per show (per day for non-show expenses) with a running count. No email. |
| Midas's own notifications to Argo submitters | Handed off: for Argo-sourced expenses Midas sends the submitter nothing itself and passes the event to Argo. |
| Transport | Pull plus ping: one ordered feed Argo pulls, a signed ping from Midas that triggers an immediate pull, and the existing 2-minute timer as the safety net. |
| Who in Midas gets "needs review"? | The `accountant` role only. Not admin, not developer. |

## What each person gets

### Argo user — bell and push in Argo

For expenses they submitted from Argo. `kind` is the value stored in Argo's
`notifications.kind`; "Midas type" is the type Midas already uses.

| kind | Midas type | Fires when | Link |
|---|---|---|---|
| `expense.approved` | `approved` | An accountant approves it | the expense |
| `expense.rejected` | `rejected` | An accountant rejects it; body carries the reject note when present | the expense |
| `expense.info_requested` | `action_required` | An accountant flags it as needing something | the expense, conversation |
| `expense.message` | `message` | An accountant posts in the thread | the expense, conversation |
| `expense.mention` | `mention` | An accountant @-mentions the submitter | the expense, conversation |
| `expense.reimbursement_paid` | `reimbursement_paid` | The reimbursement is marked paid | the expense |
| `expense.incomplete` | `expense_incomplete` | 15 minutes after creation the expense is still pending and lacks a receipt, category or payment method; once per expense; body lists what is missing | the expense |

- Opening an expense's conversation in Argo marks that user's unread
  `expense.message`, `expense.mention` and `expense.info_requested`
  notifications for that expense as read.
- The reply box in the expense modal is unchanged. A reply is posted to Midas
  through the existing Ext endpoint and reaches the accountant side through
  Midas's existing routing.
- `expense.incomplete` wording for Argo asks the user to add what is missing
  so the accountant can approve it. It does not promise automatic approval:
  Argo-sourced expenses always go to an accountant.

Mentions never need cross-app user matching. In Midas only people who can
open a thread can be mentioned: the submitter and Midas staff. A mention of
anyone but the submitter lands on a Midas staff member, who is notified in
Midas as today.

### Accountant — in Midas

New notification type `needs_review`.

| Fires when | Recipients |
|---|---|
| An expense enters the review queue: created by an external app with status `pending` (`POST /ext/expenses`), submitted in Midas and not auto-approved, captured by the browser extension as `pending`, or resubmitted from `rejected` back to `pending` | Every active user with role `accountant`, except the submitter |
| An expense is auto-approved (Midas submit or pending-completion auto-push) and its category has `needs_accountant = true` | Same |

- Every expense sends its own push and adds one to the unread badge count.
- The bell list holds one row per accountant per group. Group key:
  `submitter id + event id` for expenses with an event (`sourceContext.eventId`),
  otherwise `submitter id + expense date`. While a group's row is unread, a
  new expense in that group increments its count and refreshes its text and
  time. Once the row is read, the next expense starts a new row.
- Row text: "Ana submitted 6 expenses for Expo" / "Ana submitted 2 expenses
  on Oct 8". A count of one reads "Ana submitted an expense for Expo".
- A push opens that expense's review page (`/accountant/<id>`). A bell row
  opens the review queue for that event (`/accountant/events`) or the daily
  review (`/accountant/daily`).
- No email for `needs_review`.
- Bulk import (`POST /ext/expenses/import`) sends nothing.

## Midas changes

### Hand-off rule

`notifyUser(userId, type, input)` in `apps/api/src/lib/notify.ts` is the one
function every owner-facing notification passes through. It gains one
decision, taken before anything is written:

> Hand off when **all** of these hold: the recipient is the expense's owner
> (`userId === expense.userId`); the expense has a `sourceApp`; an active app
> connection for that source app has `events_enabled = true`; and the expense
> has an `externalUserId`.

When handing off, Midas writes one `ext_events` row, sends the ping, and
writes no `notifications` row, no Midas push and no email. In every other
case `notifyUser` behaves exactly as today.

The decision is a pure function (`shouldHandOff(...)`) so it is unit-tested
without a database; `notifyUser` supplies the expense and connection.

### Event outbox

New table `ext_events`:

| Column | Type | Notes |
|---|---|---|
| `seq` | `bigserial` primary key | The feed order and the cursor |
| `id` | `uuid` unique, default random | Stable event id; Argo's dedupe key |
| `source_app` | `text` not null | Which app the event is for |
| `type` | `text` not null | One of the seven Midas types above |
| `expense_id` | `uuid` references `expenses(id)` on delete cascade | |
| `payload` | `jsonb` not null | Snapshot, see below |
| `created_at` | `timestamp` default now | |

Index on `(source_app, seq)`.

`payload` holds everything Argo needs, so Argo never calls back for detail:

```json
{
  "externalUserId": "<argo user id>",
  "expense": { "id": "<midas id>", "sourceRefId": "<argo expense id>", "merchant": "…", "amount": "12.50", "status": "approved" },
  "senderName": "…",        // message, mention, action_required
  "excerpt": "…",           // message, mention, action_required (already truncated)
  "messageId": "…",         // message, mention, action_required
  "requestType": "…",       // action_required
  "note": "…",              // rejected, when present
  "missing": ["receipt"]    // expense_incomplete
}
```

### Feed

`GET /ext/events?since=<seq>&limit=<n>` in `apps/api/src/routes/ext.ts`.

- Requires the new `events:read` permission on the app connection.
- Returns only rows whose `source_app` is the calling connection's source app.
- `since` is the last `seq` the caller has processed (default 0); rows with
  `seq > since`, ascending, at most `limit` (default 100, max 200).
- Response: `{ events: [{ seq, id, type, createdAt, ...payload }], nextCursor }`
  where `nextCursor` is the last returned `seq` as a string, or `null` when
  the page is empty.
The existing `GET /ext/messages` feed is left in place and unchanged, so an
Argo build from before this release keeps working during rollout.

### Ping

`app_connections` gains `events_enabled boolean not null default false` and
`events_ping_url text`. After an `ext_events` row is committed, Midas sends
`POST <events_ping_url>` with an empty JSON body and two headers:

- `X-Midas-Timestamp`: Unix seconds
- `X-Midas-Signature`: hex HMAC-SHA256 of the timestamp string, keyed with
  the shared secret in env `EXT_EVENTS_PING_SECRET`

Fire-and-forget, 3-second timeout, failures logged and ignored. No ping is
sent when the URL or the secret is missing. The ping carries no expense data.

### Missing-details sweep

A scheduler in the API process, every 5 minutes (same start/stop/single-flight
shape as Argo's schedulers). It selects expenses where: the source app has an
events-enabled connection; `status = 'pending'`; `created_at` is more than 15
minutes ago; `incomplete_notified_at` is null; and at least one of receipt,
category (or Zoho expense account), payment method is missing — the same
three checks `computeFlags` uses for `missing_receipt`, `needs_category` and
`needs_payment_method`. For each it stamps `expenses.incomplete_notified_at`
(new nullable timestamp column) and calls `notifyUser(owner,
'expense_incomplete', { missing })`, which hands off. The stamp is set first,
so a crash loses one notification and never duplicates it. Expenses that are
complete at 15 minutes are stamped too, so they are not re-examined forever.

### Accountant `needs_review`

- New pure module `lib/needsReview.ts`: `groupKeyFor(expense)`,
  `groupText(submitterName, count, eventName | date)`.
- New function `notifyNeedsReview(expense)` in `lib/notify.ts` (or a sibling
  file): resolves active accountants except the submitter and, for each,
  upserts the grouped bell row and sends one push for this expense.
- `notifications` gains `group_key text` and `count integer not null default
  1`. The upsert: update the recipient's unread row with the same `group_key`
  (`count = count + 1`, new title/body, `created_at = now()`), else insert.
  Done in one statement per recipient to stay correct under concurrent
  submissions.
- Unread badge: `GET /notifications` returns `unreadCount` as
  `coalesce(sum(count), 0)` over unread rows instead of `count(*)`.
- `notificationPath` learns `needs_review`: a single-expense push goes to
  `/accountant/<id>`; a grouped row goes to `/accountant/events` when the
  group has an event, else `/accountant/daily`.
- Call sites: `POST /ext/expenses` (created with status `pending`),
  `POST /expenses/:id/submit` (the fall-through to `pending`),
  `extensionExpenses` create, the rejected → pending resubmission paths, and
  the two auto-approve branches (submit and `maybeAutoPushPending`) when the
  category is flagged.
- `expense_categories` gains `needs_accountant boolean not null default
  false`, exposed in `GET/PATCH /admin/categories` and as a tick-box in
  `apps/web/src/pages/settings/CategoriesSection.tsx`.

### Midas schema delivery

Midas uses Drizzle: schema changes go in `apps/api/src/db/schema.ts` and a
generated SQL migration under `apps/api/drizzle/` (next number 0033), applied
with the repo's migrate command at deploy.

## Argo changes

### Scanner

`ExpenseMessageScanner` is replaced by `MidasEventScanner`
(`backend/src/services/midas/MidasEventScanner.ts`): same gate
(`isMessagingEnabled()`), same single-flight loop, same 2-minute interval
(`MIDAS_MESSAGE_SCAN_INTERVAL_MS` keeps its name), plus a public `trigger()`
used by the ping. `MidasClient` gains `listEventsSince(cursor, limit)`.

For each event: resolve `externalUserId` to an active Argo user (via the
catalog's `activeUsers`), build the notification in the new catalog file
`backend/src/services/notifications/expenseNotifications.ts`, and write it
with the event's `id` as the dedupe key. Unknown or inactive user: skip, log,
advance. Unknown `type`: skip, log, advance (forward compatibility).

**First run.** The cursor lives in the existing `midas_message_sync_state`
table under a new `source_app` key (`trade_show:events`). When no row exists
the scanner starts from `0`. That replays nothing, because the rollout turns
the events switch on only after Argo is deployed, so the feed is empty at
first run. No seeding walk is needed.

### Exactly-once bell row

`notifications` gains `source_event_id text` with a plain `UNIQUE`
constraint (nullable; existing rows stay null). `NotificationService.notify`
accepts an optional `dedupeKey`; the repository inserts with `ON CONFLICT
(source_event_id) DO NOTHING RETURNING *`, and the push is sent only when a
row came back. A redelivered event is a no-op.

### Ping endpoint

`POST /api/midas/events-ping`, mounted without `authenticateToken`. It checks
`X-Midas-Signature` against HMAC-SHA256 of `X-Midas-Timestamp` using env
`MIDAS_EVENTS_PING_SECRET` with a constant-time compare, and rejects
timestamps more than 5 minutes from now. Valid: respond `202` and call
`midasEventScanner.trigger()`. Invalid or secret unset: `401`, nothing else.
`trigger()` is a no-op while a scan is running, so repeated pings cannot pile
up work.

### Links, reading, replying

- New link page `expense` with `expenseId`: push URL `/#expense=<id>` (the
  hash `ExpenseSubmission` already handles), page `expenses`. Added to the
  shared link fixture and both link tables. `NotificationLink` gains
  `expenseId?: string`.
- `POST /api/expense-messages/:id/messages/read` now marks read, for the
  calling user, every unread notification whose `kind` is one of
  `expense.message`, `expense.mention`, `expense.info_requested` and whose
  link's `expenseId` is that expense.
- Message list and reply routes are unchanged.

### Removed

- The pending-expense section, its "N pending" chip and the expense fetch
  that fed them in `src/components/layout/Header.tsx`, for every role.
- The messages section in the bell and `GET /api/expense-messages/unread`.
- `ExpenseMessageScanner`, and the repository functions only it used. The
  header then has one source: the general notification list.

### Migration 046

- `ALTER TABLE notifications ADD COLUMN source_event_id TEXT UNIQUE`.
- Copy still-unread rows from `expense_message_notifications` into
  `notifications` as `expense.message` (or `expense.info_requested` when
  `request_type` is set), with `source_event_id = 'legacy-message:' ||
  midas_message_id`, the stored sender and snippet as the body, and an
  `expense` link when `expense_ref_id` is present.
- `expense_message_notifications` is left in place, unused.

## Rollout

The `events_enabled` switch stays off until both sides are deployed.

1. **Midas v1.21.0**, switch off. Outbox, feed, ping, sweep, `needs_review`
   and the category tick-box are live. Accountants start getting
   `needs_review`. Argo users see no change.
2. **Argo v2.33.0.** New scanner (empty feed), ping endpoint, header without
   the pending and messages sections, migration 046. Verify 046 applied (the
   42501 trap) before continuing.
3. **Switch on:** set `events_enabled = true` and `events_ping_url` on Argo's
   production connection, add `events:read` to its permissions, and set the
   shared secret in both apps' env. Midas now hands off.

Steps 2 and 3 are done back to back: between them, a new accountant message
does not reach the Argo bell (it is still in the expense's thread).

Rollback: turn the switch off (Midas notifies submitters itself again at
once); the previous Argo build works against the unchanged message feed.

## Failure handling

| Condition | Result |
|---|---|
| Ping lost, or Argo restarting | Next 2-minute pull delivers everything |
| Midas unreachable from Argo | Pull logs, cursor unmoved, retried next tick |
| Argo crashes mid-batch | Batch re-read; `source_event_id` makes the rewrite a no-op, no second push |
| Event for an unknown or inactive Argo user, or an unknown type | Skipped, logged, cursor advances |
| `ext_events` insert fails in Midas | Logged; the accountant's action still succeeds; that notification is lost (the trade-off `notifyUser` already makes) |
| Ping secret missing on either side | No pings are sent or accepted; delivery falls back to the 2-minute pull |

## Testing

Midas:

- `shouldHandOff`: owner vs non-owner, switch on vs off, no connection, no
  external user id, no source app.
- `notifyUser` hand-off path writes an event and no notification, push or
  email; the non-hand-off path is unchanged.
- `needsReview` grouping: key for event and non-event expenses, text for
  counts of one and many, increment while unread, new row after read.
- `needs_review` fires at each entry point and not for auto-approved
  expenses in an unflagged category, bulk import, or the submitter.
- Missing-details selection and the stamp-first ordering.
- Feed against a real database: ordering, `since`, `limit`, source-app
  scoping, permission check.
- Ping signature generation.

Argo:

- Each event type → kind, title, body, link.
- Redelivery writes no second row and sends no second push.
- Unknown user, inactive user, unknown type: skipped, cursor advances.
- Ping endpoint: valid signature triggers a scan; wrong signature, stale
  timestamp, missing secret → 401 and no scan; a trigger during a running
  scan does nothing.
- Read-on-open marks only that user's conversation notifications for that
  expense.
- Header tests updated: no pending section, no messages section.
- Migration 046 against a real local Postgres, including the carry-over.

Contract: one JSON fixture of sample feed events lives in the Argo repo and
is copied into the Midas repo; Midas's feed test asserts it produces that
shape and Argo's scanner test asserts it consumes it.

End to end, on production after the switch is on, with the user: submit a
test expense from Argo; confirm the accountant push and grouped bell row in
Midas; request info in Midas and confirm the Argo push; reply from Argo and
confirm it reaches Midas; approve and confirm the Argo notification; open the
expense in Argo and confirm the conversation notifications clear.

## Out of scope

- Rate limiting on Argo's registration endpoint and the other v2.32.0
  follow-ups.
- Email for any of these notifications.
- Notification preferences or muting in either app.
- Dropping `expense_message_notifications` or the `GET /ext/messages` feed.
- A retry queue for pings, and any Midas-side record of Argo read state.
- Notifying Midas admins or developers about `needs_review`.
