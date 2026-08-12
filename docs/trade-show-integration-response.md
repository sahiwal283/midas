# Midas → Trade Show: response to the integration requests

Answering `trade-show-app/docs/midas-integration-requests.md`.

Everything below was checked against the Midas source and the live database on
2026-08-12, not against assumptions. Where your document states something about
Midas that is not true today, it is called out as **Correction**.

Midas at the time of writing: v0.43.0, CT 3120, database CT 3220.
376 expenses, all `source_app = 'trade_show'`. One app connection, `trade_show`.

**Update, 2026-08-12 — shipped as v0.44.0.** All six pre-cutover items below are
live in production. See "What we are building" for the per-item status and the
correction to the D2 row count (it was 70, not 13 — see that section).

---

## Decisions on the blocking items

### A1. Production app connection — **yes, separate**

You get a new connection `trade_show_prod` with its own key, scoped to the same
15 categories as the sandbox connection. Sandbox keeps `trade_show`. Revoking one
will not affect the other, and the audit log will show which environment wrote
each row.

**Correction on scoping:** `category_mappings` rows key on `source_app`, not on
the connection — `resolveCategoryId` filters
`categoryMappings.sourceApp = <body.sourceApp>`. The 26 existing `trade_show`
mappings therefore keep working for the new connection **as long as you keep
sending `sourceApp: "trade_show"`**. Do not switch the payload to
`trade_show_prod`; that is the connection name, not the source-app name. Only the
category *allowlist* (`app_connection_categories`) is per-connection, and the new
connection gets the same 15 rows.

### A2. Environment isolation — **one shared dataset, accepted explicitly**

There is no production Midas to protect. Midas has not launched; the instance you
are writing into is the only one that will exist, and the 376 rows you imported
are copies of real Trade Show expenses, so they are the intended data rather than
test pollution.

You may run write-path UAT against it. We are not asking you to prefix
`sourceRefId` or mark rows. If a specific UAT batch later needs removing, ask and
we will delete it by id — with 376 rows this does not need a mechanism.

### A3. Cutover — **keep what is already there**

No purge, no re-import, no freeze window.

The basis: only 3 of the 376 expenses have ever been reviewed inside Midas
(`reviewed_at IS NOT NULL`), and there are zero expense messages, so there is
almost no Midas-side work that a re-import would overwrite — and equally little
reason to run one.

**The risk you should weigh, since it is yours to see and not ours:** the import
ran on 2026-08-03. Any Trade Show expense created or edited in production since
then is either absent from Midas or stale in it. Before cutover, run your import
once more and read the response — it is idempotent on `sourceRefId`, so anything
it reports as `imported` is a row that was missing. If the count comes back
non-trivial, or if fields changed rather than rows being added, tell us and we
will add an upsert mode to `POST /ext/expenses/import` rather than have you
work around it.

### B2. Duplicate detection — **Midas will run it and return a warning**

We are wiring `isLikelyDuplicate` into `POST /ext/expenses` and
`PATCH /ext/expenses/:id`, returning it in the shape you proposed:

```json
{ "expense": {...}, "created": true,
  "warnings": [{ "code": "POSSIBLE_DUPLICATE", "matches": [...] }] }
```

Non-blocking, exactly as you asked — the create still succeeds. Keep your
`lib/duplicates.ts` deleted or unused; do not reimplement the check.

The rule is: same amount (±0.005), date within 3 days, and one merchant name
containing the other after normalisation. Match scope is the same submitter's
other expenses.

---

## Corrections — three things in your list are not true today

### C-1. Auto-provisioning is **off** in production

> *"`resolveExtUser` appears to auto-provision from `submitterEmail`. Confirm that
> is intended."*

It is gated behind `EXT_AUTO_PROVISION_USERS`, and production has
`EXT_AUTO_PROVISION_USERS=false`. Today an unrecognised submitter gets
`422 USER_NOT_FOUND`, not a new account.

Midas has 16 active users; 8 distinct users own the 376 imported expenses. **Any
Trade Show submitter outside that set will fail at cutover.** This is the item
most likely to bite you on day one and it was not on your list.

We will decide and tell you whether we turn provisioning on or pre-create the
roster. Either way, send us the list of Trade Show users who can submit expenses
and we will reconcile it against Midas before you cut over.

### C-2. Unknown categories become **null**, not `Other`, on the create path

> *"send whatever the user picked, letting you resolve it (exact name →
> `category_mappings` → `Other` with a warning)"*

That describes `POST /ext/expenses/import`, which calls
`resolveCategoryIdOrOther`. The live create and update paths
(`POST /ext/expenses`, `PATCH /ext/expenses/:id`) call `resolveCategoryId`, which
returns `null` when nothing matches — no `Other`, no warning. The expense is
created with no category and lands in the accountant's "Missing Expense Account"
lane.

We are changing create and update to match what you assumed: fall back to `Other`
and return a warning. Until that ships, an unmapped category name is silently
dropped.

### C-3. Companies are not validated on `/ext` write

`POST /ext/expenses` stores `body.company` straight into `zoho_entity` with no
check against the companies catalog. `assertActiveCompany` exists and is used on
the Midas-native path, but not here.

The live data shows the consequence: two expenses have the literal string
`"undefined"` as their company and one has none. We are adding validation and
cleaning up those three rows.

---

## Confirmations

**D1. Category vocabulary ownership — confirmed, with C-2 above.**
Send the user's chosen category name; Midas resolves it. To add or retire a
category for `trade_show`: ask us, and we change the allowlist in
Settings → Categories (per-connection) plus a `category_mappings` row if you need
an old Trade Show name to resolve to a Midas category. Retiring is a
deactivation, never a delete — existing expenses keep their category.

**D2. `Summitt Labs` / `zohoEnabled: false` — NOT confirmed. This is a live bug.**

You asked us to confirm that expenses on a non-Zoho company are retained normally
and simply never pushed. Retained, yes. Never pushed, no — not today:

- `computeFlags` marks an expense `ready_for_zoho` on `!!zohoEntity` alone, so
  Summitt Labs expenses appear in the accountant's "Ready for Zoho" lane.
- Approving one sets `integration_status = 'pending'` whenever `zoho_entity` is
  set, without consulting `zohoEnabled`.
- `pushExpenseToZoho` has no `zohoEnabled` guard, so a bulk push from that lane
  would genuinely attempt to send it.

This is not hypothetical: **70 of the 376 expenses are on Summitt Labs.** At the
time of writing 13 of those were already `approved` + `integration_status =
'pending'`; the rest were sitting in other statuses but the underlying gate was
the same for all of them. Nothing had been pushed because pushes are only ever
triggered by an explicit accountant action, but the lane was armed.

**Correction, 2026-08-12:** by the time the production repair actually ran, all
70 Summitt Labs expenses — not just the 13 approved ones — carried
`integration_status = 'pending'`. The repair script fixes the condition
(`zoho_enabled = false AND integration_status = 'pending'`), not a fixed count,
so it caught and corrected all 70. Re-running it now reports `0`. Behaviour is
exactly what you asked to confirm: `computeFlags`, approve, and
`pushExpenseToZoho` all now consult `zohoEnabled` and refuse a non-Zoho company
with `COMPANY_ZOHO_DISABLED`.

**D3. Zoho ownership — confirmed.**
Midas owns all Zoho Books posting for `source_app = 'trade_show'`, including the
retry policy (2 retries at 2s and 5s, transient errors only — network, 429, 5xx;
non-retryable errors fail immediately). Keep returning `409 MIDAS_OWNED` locally.

A failed push is visible in Midas as `integration_status = 'failed'`, surfaced in
the accountant's **Zoho Failed** lane on Event Review, on the dashboard's "Zoho
Failed" row, and on the expense detail page with the Zoho error message. It is
retried by an accountant, not automatically. Submitters do not currently see push
failures — tell us if Trade Show needs to.

**D4. User provisioning — see C-1.** Do send `submitterUsername`; it is the
identity key and works for users with no email address. `submitterEmail` keeps
working, including through `user_email_aliases` for accounts merged during
identity reconciliation, so a pre-merge address still resolves to the surviving
user. Send both if you have both.

**D5. Request volume — confirmed, no `/ext` limit.**
Rate limiting applies only to `POST /api/v1/auth/login` (200 per 15 min). `/ext`
is unlimited. Page at 200 as you do; keep sustained traffic under roughly 10
requests/second and tell us before any bulk job that would exceed it. If we add a
limit we will tell you the number first.

**D6. Status vocabulary — confirmed stable, with one caveat.**
`draft, pending, in_review, awaiting_info, approved, zoho_sync_failed, rejected,
cancelled`. Note `cancelled` exists in the database enum and is accepted on
expenses, but is **not** in the `/ext` API's accepted status list — sending it is
a 400. Your two mappings are correct and safe: `needs further review` ↔
`awaiting_info` holds, and treating `zoho_sync_failed` as approved is right —
`zoho_sync_failed` is retained for compatibility and new writes use
`approved` + `integration_status = 'failed'`. We will tell you before any value
is added or renamed.

**D7. Receipt content endpoint — confirmed, with a caveat.**
`GET /ext/expenses/:id/receipts/:receiptId/content` and its Bearer-key auth model
are stable. The caveat is ours to fix, not yours to work around: the handler
reads the file directly from `UPLOADS_DIR` instead of going through the storage
adapter, so it would break if Midas moved to `STORAGE_MODE=s3`. Production is
`local` today. We will route it through the adapter; the contract does not change.

---

## What we are building

**Before cutover — all six shipped in v0.44.0, 2026-08-12**

1. **Done.** `zohoEnabled` respected end to end — flags, approve, and push —
   plus the production data fix (70 rows, not 13; see the D2 correction above).
   For a non-Zoho company, every `integration_status` write in
   `routes/transactions.ts` silently downgrades to `not_required` instead of
   queueing a push — there is no error response there. `pushExpenseToZoho`
   (and, as of this fix wave, `pushPurchaseOrderToZoho`) instead refuse the
   push outright, returning **409 `COMPANY_ZOHO_DISABLED`** (not 400). (D2)
2. **Done.** Unknown category on `POST /ext/expenses` and
   `PATCH /ext/expenses/:id` now falls back to `Other` and returns a warning
   with code `CATEGORY_FALLBACK` in the response `warnings[]` array, instead of
   silently storing `null`. (C-2)
3. **Done.** Company is validated on `/ext` write: an unrecognised company name
   returns `400 UNKNOWN_COMPANY` instead of being stored verbatim. The 3 bad
   rows (`zoho_entity = 'undefined'`, 2 rows; and a null case) were cleaned by
   the same repair script — see D2's numbers above. (C-3)
4. **Done.** `trade_show_prod` connection and key issued in production, scoped
   to the same 15 categories as sandbox `trade_show` (verified: both
   connections `is_active = true`, 15 categories each). Sandbox `trade_show`
   and its key were left untouched. (A1)
5. **Done.** Duplicate warnings on create and update: `POST /ext/expenses` and
   `PATCH /ext/expenses/:id` return a warning with code `POSSIBLE_DUPLICATE`
   (non-blocking — the write still succeeds) when `isLikelyDuplicate` matches
   another expense from the same submitter within the date/amount/merchant
   rule in B2. (B2)
6. **Done.** Decision: auto-provisioning is now **on**
   (`EXT_AUTO_PROVISION_USERS=true`), verified inside the running production
   container, not just in `.env`. Roster reconciliation against Trade Show's
   live database (read-only query, CT 2600) found all 8 active submitters
   resolve to an existing Midas account — no unmatched user. Two things worth
   your attention before you rely on that: (a) three Trade Show usernames
   (`Salesguru`, `sahil`, `seri`) don't match their Midas counterpart's
   username (`brett`, `sahilk`, `seriv`) — they only resolve because the email
   matches (directly, or via `user_email_aliases` for `sahil` /
   `tech@cooliohcandy.com`). If a submission ever carries `submitterUsername` without
   `submitterEmail` for these three people, it will provision a **new**
   duplicate account instead of resolving to the existing one — always send
   both fields for them. (b) Trade Show's `admin` user
   (`admin@company.com`) shares the literal username `admin` with Midas's own
   admin account (`admin@midas.local`), which is a different identity. Because
   username resolution runs before email, any submission with
   `submitterUsername: "admin"` will attribute the expense to Midas's admin
   account, not create or match a distinct Trade Show admin identity. Sending
   `submitterEmail` alone will not route around it — the username match wins
   whenever a username is present. Rename that Trade Show account to something
   that isn't `admin` before cutover if that submitter's expenses need to be
   attributed correctly. (C-1)

**Soon after**

7. `GET /ext/expenses/summary` — `groupBy[]` over `status`, `date`, `category`,
   `eventId`, `company`, plus the existing filters, returning `count` and
   `sumAmount`. Your six consumer rows all reduce to that one endpoint. (B1)
8. `updatedSince` on `GET /ext/expenses`. (C1)
9. Receipt content through the storage adapter. (D7)

**Not scheduled**

10. Change webhook. (C2) We would rather do this once, properly, than ship a
    half-feature — tell us when polling actually hurts and we will design it then.
11. `defaultZohoEntity` removal. (C3) No timeline; it costs us nothing to keep.
    You will get notice measured in weeks, not days, and we will not drop it
    before you confirm.
