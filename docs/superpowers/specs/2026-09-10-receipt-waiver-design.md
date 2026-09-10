# Accountant receipt waiver — push to Zoho without a receipt, with a written reason

**Date:** 2026-09-10
**Status:** Approved for planning
**Target version:** Midas `1.11.0`
**Repo:** `~/Work/midas` (only — the OCR service is untouched)

---

## Problem

An accountant cannot push an approved expense whose submitter has lost the
receipt. The expense is otherwise complete and the charge is real, so it needs
to reach Zoho Books — but only with a written justification, and that
justification has to travel to Zoho so it is legible to whoever reads the
accounting record later.

The concrete case: an approved $74.45 expense, every check passing except
`Receipt attached`, with the submitter already asked for the receipt and unable
to produce it.

---

## What is actually true today

The receipt requirement is **not enforced anywhere on the server**. It is a
client-side affordance.

| Path | Receipt required? | Where |
|---|---|---|
| Accountant review page | Yes, by omission — the Push button is not rendered | `AccountantReview.tsx:145` computes `ready` in the browser |
| `pushExpenseToZoho` | **No** — guards cover entity, company, category, payment method, expense account, paid-through. No receipt check | `zohoPush.ts:56-110` |
| `POST /accountant/expenses/:id/zoho-push` | **No** — checks status only | `accountant.ts:753` |
| `POST /accountant/zoho/bulk-push` | **No** — checks status and integration status only | `accountant.ts:435` |
| Auto-push on submit | Yes, via full readiness | `pendingCompletionDb.ts:41`, `expenses.ts:475` |
| `ready_for_zoho` lane | Yes, in both TS and SQL | `flags.ts:70`, `queueLane.ts:15` |

So the accountant is blocked by a missing button, not a rejection. The push
endpoints would accept a receipt-less expense if called directly with an id.

**Scope of that hole, precisely:** the bulk push button sends only rows in the
`ready_for_zoho` lane, and that lane requires a receipt in SQL. So nothing
reaching Zoho through the UI today bypasses the rule. The gap is reachable only
by calling the endpoints directly. Adding the server guard therefore breaks
nothing that flows through the product.

That distinction matters for this design: if the rule stays advisory, a
justification requirement added to the detail page is bypassable, and the audit
trail has a hole from day one.

---

## Decisions

| Decision | Choice | Rejected alternative |
|---|---|---|
| Enforcement | Real server-side rule in `pushExpenseToZoho` | Advisory + UI-only override (justification trivially bypassable) |
| Overridable blockers | **Receipt only** | Receipt + open requests; any blocker (overriding a missing account id cannot help — the payload guard still fails) |
| Storage | Columns on `expenses` | Audit log only (retry needs retyping, not queryable); a conversation message (nothing distinguishes a waiver from chatter) |
| Zoho note budget | Reason capped at 200 chars, UI counter | Reason wins over description (can drop the merchant name); marker-only with detail in Midas |
| Flow | One action — push with a reason | Two steps (creates a "waived but not pushed" state) |
| Seam | Guard inside `pushExpenseToZoho`, waiver as an option | Waiver as a separate resource; guard duplicated per route |

**Why the guard lives in the library, not the routes.** Four call sites reach
`pushExpenseToZoho`. A rule enforced at each of them is a rule that must be
remembered four times; a rule enforced inside it is enforced by construction,
and a new caller inherits it. The option defaults to absent, so the safe
behavior is the default.

---

## Component 1 — Data model

**Purpose:** make the waiver part of the expense record.
**Migration:** `apps/api/drizzle/0031_expense_receipt_waiver.sql`

```sql
ALTER TABLE expenses
  ADD COLUMN receipt_waiver_reason text,
  ADD COLUMN receipt_waived_by_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN receipt_waived_at     timestamp;
```

All nullable. A row with a non-null `receipt_waiver_reason` is a waived expense.
`ON DELETE SET NULL` matches `closed_periods.closed_by_id` — the waiver survives
the person leaving the company.

No backfill. No index: waived expenses are rare and every read is already scoped
to a single expense or an already-filtered lane.

---

## Component 2 — The guard

**Purpose:** refuse a receipt-less push unless it carries a justification.
**Interface:** `receiptPushBlocker(input) → { code, status, message } | null`
**Depends on:** nothing. Pure function.

Created at `apps/api/src/lib/receiptPushBlocker.ts`, following
`lib/poSubmitGate.ts` and `lib/expenseDelete.ts` — the codebase's established
answer to "the route needs a database, so the decision goes in `lib/` where it
can be tested".

```ts
export interface ReceiptPushInput {
  hasReceipt: boolean;
  /** Already on the row from an earlier waiver — makes a retry work. */
  storedWaiverReason: string | null;
  /** Supplied by an accountant on this call. */
  suppliedReason?: string;
}
```

Rules, in order:

1. A receipt exists → pass.
2. A supplied reason, trimmed, of 1–200 characters → pass.
3. A supplied reason that is empty/whitespace, or over 200 characters →
   `400 INVALID_WAIVER_REASON`.
4. No supplied reason but a stored one → pass (the retry case).
5. Otherwise → `409 MISSING_RECEIPT`, message:
   *"This expense has no receipt. Push it with a written reason, or ask the
   submitter to attach one."*

`MAX_WAIVER_REASON = 200` lives in **`packages/shared`**, not here, because the
web dialog's counter needs it and `apps/web` cannot import from `apps/api`. The
blocker and the route's zod schema both read it from there, so the limit has one
definition across all three surfaces.

It is deliberately *not* read by `lib/zohoNotes.ts`, which imports nothing by
design — the note builder truncates against its own headline floor rather than
against this constant, so the two concerns stay independent.

---

## Component 3 — `pushExpenseToZoho`

**Purpose:** enforce the rule for every caller; record the waiver.
**Interface:** `pushExpenseToZoho(expense, actorUserId, opts?)` where
`opts = { receiptWaiver?: { reason: string } }`.

1. Call `receiptPushBlocker` beside the existing `MISSING_*` guards, after the
   payment-method check and before payload construction. Return its blocker as
   the outcome when it returns one.
2. When a waiver is supplied and the row does not already carry one, write
   `receipt_waiver_reason`, `receipt_waived_by_id = actorUserId` and
   `receipt_waived_at = now()` **before** attempting the push, so a failed push
   still leaves the justification recorded.
3. Write an audit entry `expense.receipt_waived` via the existing `auditLog()`,
   carrying the reason, the actor, and the expense's failing checks at that
   moment. Dotted naming matches the `admin.*` / `budget.*` convention already
   in use.

The option is optional and its absence enforces, so `pendingCompletionDb` and
`POST /expenses/:id/submit` — neither of which knows about waivers — keep
working unchanged and cannot waive.

---

## Component 4 — Routes and authorization

**Purpose:** accept a reason only from an accountant.

**Only the single-expense route** gains an optional `receiptWaiverReason` in the
request body — `POST /accountant/expenses/:id/zoho-push` (`accountant.ts:753`) —
validated by zod as `z.string().trim().min(1).max(MAX_WAIVER_REASON).optional()`
and passed through as `opts.receiptWaiver`.

`POST /accountant/zoho/bulk-push` (`accountant.ts:435`) is **unchanged**. It
needs no waiver parameter: a waived expense already carries its reason on the
row and passes rule 4, so bulk retries work without one. This is the reason a
per-id reason on bulk is out of scope rather than merely unbuilt.

Both routes sit behind `requireRole('accountant', 'admin')` at the router level.

**`POST /expenses/:id/submit` is not role-gated** and reaches
`pushExpenseToZoho` on the auto-push path. It never passes the option, so a
submitter cannot self-waive even by forging the field — the route does not read
it. This is the security property that makes the option-shaped seam safe.

---

## Component 5 — Readiness, flags and the lane

**Purpose:** let a waived expense read as ready, so a failed push can be retried.

The receipt condition becomes "has a receipt **or** has a waiver" in three
places:

| Where | Form | Change |
|---|---|---|
| `lib/zohoReadiness.ts:60` | TS on a fetched row | `hasReceipt \|\| hasWaiver`; check label becomes `Receipt attached (or waived)` |
| `lib/flags.ts:70` | TS on a fetched row | same, inside `zohoReady` |
| `lib/queueLane.ts:15` | SQL `exists (…)` | `OR expenses.receipt_waiver_reason IS NOT NULL` |

Without this, a waived expense whose push then failed would sit outside the
`ready_for_zoho` lane and could not be retried — which would defeat the reason
the waiver is stored on the row at all.

**Known risk, stated rather than hidden:** this is one rule in three
expressions, one of which is SQL and therefore outside a test suite that never
touches a database. Each carries a comment naming the other two. See Testing.

---

## Component 6 — The Zoho note

**Purpose:** carry the justification into Zoho Books.
**Depends on:** `lib/zohoNotes.ts`, which imports nothing by design.

The waiver fields travel inside the payload's existing `provenance` object
(`buildZohoServicePayload`), are read from there by `toCreateBooksBody` before
nested objects are stripped for the wire, and are passed to `buildZohoNote`.

One line in the block, directly after `Pushed by:` — the waiver is a fact about
the push decision:

```
Urth Cafe — Breakfast last day KG/SP/SJ

Event: —
Submitted by: Shruti Patel (2026-09-09)
Pushed by: Digi (2026-09-10)
Receipt waived by Digi: submitter lost the receipt; charge verified against the Amex statement
Origin: Midas
Midas: https://…/expenses/abc
```

The waiver actor is named separately from `Pushed by` because they differ on a
retry: whoever waived it may not be whoever later re-pushed the failed record.

**Budget.** `ZOHO_NOTE_MAX` is 500 and is a hard Zoho ceiling — overshooting
earns a 1002 rejection that reaches the accountant as an opaque "sync failed".
Today the builder slices the block first and gives the headline whatever
remains. A 200-character reason on top of a long event name and a long URL could
consume the entire budget and drop the headline — silently undoing the earlier
fix that folded the merchant into the description because expenses were
otherwise unsearchable in Zoho.

So **the waiver line yields, not the merchant**: if including it in full would
leave the headline under a 40-character floor, the line is truncated with an
ellipsis to preserve that floor. The complete reason always remains on the Midas
record and in the audit log, and the note already carries the Midas URL.

In the ordinary case this never fires — a typical block is ~185 characters, so a
200-character reason still leaves ~90 for the headline.

---

## Component 7 — Web

**Purpose:** let the accountant waive and see that it was waived.

### The override button

`ZohoReadinessCard` (`AccountantReview.tsx:126`) gains a **Push without
receipt…** button, rendered **only when the receipt is the sole failing check**.
If a category or a card mapping is also missing, the card stays exactly as it is
today — waiving would not make the push succeed, and a button that then errors is
worse than no button.

### The dialog

Uses the existing `Modal` primitive, which already carries scroll-lock,
focus-trap and Escape handling.

```
┌─ Push without a receipt ──────────────────────┐
│ Urth Cafe · $74.45 · Shruti Patel             │
│                                               │
│ This expense has no receipt. Explain why it   │
│ is being pushed anyway — your note goes to    │
│ Zoho and stays on the Midas record.           │
│                                               │
│ Reason (required)                    142/200  │
│ ┌───────────────────────────────────────────┐ │
│ │ submitter lost the receipt; charge        │ │
│ │ verified against the Amex statement       │ │
│ └───────────────────────────────────────────┘ │
│                    [ Cancel ]  [ Push to Zoho ]│
└───────────────────────────────────────────────┘
```

The counter reads `n/200` from `MAX_WAIVER_REASON`. Confirm is disabled until the
reason has non-whitespace content, mirroring the server rather than relying on
it. The dialog says plainly that the note reaches Zoho — an accountant writing an
internal aside would word it differently from one writing into the accounting
record.

Errors surface through `zohoPushError`, which the page already wires
(`AccountantReview.tsx:263`).

### Where the waiver shows afterwards

**Not** on the readiness card: it returns `null` once `zohoExpenseId` is set
(`AccountantReview.tsx:135`), so anything rendered there vanishes exactly when
the justification matters most.

Instead the **left receipt pane** (`AccountantReview.tsx:42`) replaces its bare
"No receipt attached" with the reason, who waived it, and when. It sits where the
absence is already visible and persists regardless of sync state.

### Types

The shared `Expense` type gains the three fields; they already arrive on the
expense the page loads, so no second fetch.

### Bulk push

No new UI. Once the lane accepts a waiver, a waived expense enters
`ready_for_zoho` by itself, the existing bulk button includes it, and the guard
honours the stored reason.

---

## Out of scope, deliberately

- **Editing or revoking a waiver.** The record is an audit artifact; rewriting a
  justification that has already reached Zoho needs its own rules about who may
  do it. Nothing in the reported situation calls for it.
- **Waiving any other blocker.** Receipt only.
- **A per-id reason on bulk push.** A single reason spanning many expenses is
  weaker evidence than one written per expense, and the stored-waiver path makes
  it unnecessary for retries.

---

## Failure behavior

| Failure | Behavior |
|---|---|
| Push fails after a waiver is written | Justification is already on the row; the expense lands in the retry lane and the stored reason satisfies the guard — no retyping |
| Receipt-less push with no reason | `409 MISSING_RECEIPT`; surfaces via `zohoPushError` on the review page and in `failed[]` for bulk |
| Empty or over-long reason | `400 INVALID_WAIVER_REASON`; the dialog renders the message |
| Waiver actor deleted later | `ON DELETE SET NULL` — the reason and timestamp survive |
| Reason too long for the note | Waiver line truncated with an ellipsis; merchant headline preserved; full reason still in Midas |

---

## Testing

The API suite never touches a database, which is why the decision lives in a
pure function.

**`lib/receiptPushBlocker`** — blocks with no receipt and no waiver; passes on a
receipt; passes on a supplied reason; passes on a stored reason (retry); rejects
whitespace-only; rejects over 200 characters; a receipt present wins even when a
reason is also supplied.

**`lib/zohoNotes`** — the waiver line renders; is absent without a waiver; a
200-character reason keeps the headline above its floor; a pathological event
name truncates the waiver line rather than the merchant; the note never exceeds
`ZOHO_NOTE_MAX`.

**`lib/flags` and `lib/zohoReadiness`** — a waived, receipt-less row reads as
ready in both, and both agree on the same fixture.

**Not covered:** `readyForZohoCondition()` is SQL and unreachable from the test
suite, so nothing asserts it agrees with the two TypeScript expressions of the
same rule. Mitigation is a cross-referencing comment on each of the three, plus
an explicit post-deploy check that a waived expense actually appears in the ready
lane.

`apps/web` has no component harness, so the dialog is covered by `tsc --noEmit`
and by hand.

---

## Versioning

`1.10.1 → 1.11.0` — MINOR per `docs/VERSIONING.md`: a new user-visible capability
and new API behavior. Bump `MIDAS_VERSION` plus the three `package.json` files,
and add a `docs/CHANGELOG.md` entry.

---

## Deployment

Midas only. **This release has a migration, and the previous one deliberately did
not** — which sidestepped a known problem that now applies.

The prod migrator service is broken: its npm script expects a `.env` the image
does not carry, so the runner must be invoked directly, and `docker compose run`
silently applies nothing unless given `--build`. A migration that appears to run
and does not is the worst available outcome, so:

1. Confirm the three columns are **absent** in the prod database before deploying.
2. Deploy and run the migration through the runner directly, with `--build`.
3. Confirm the three columns are **present** afterwards — do not trust the exit code.
4. Verify `GET /api/v1/meta` reports `1.11.0`.
5. Walk one waiver end to end and confirm the reason appears in the Zoho Books
   record's notes, and that the expense shows the waiver in the receipt pane.

**Rollback is asymmetric on purpose.** Redeploying the previous image is safe and
leaves three unused nullable columns behind, which are harmless. Dropping them is
destructive — it would discard justifications already written and already sent to
Zoho — so it is not part of the rollback.

No new environment variables.
