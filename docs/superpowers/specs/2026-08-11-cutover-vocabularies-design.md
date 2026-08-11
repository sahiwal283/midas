# Cutover Readiness — Ext Vocabularies & "Company" Terminology

**Date:** 2026-08-11 · **Status:** Approved
**Goal:** Make Midas the authoritative source for the three vocabularies Trade Show needs at cutover — categories, payment methods, companies — and retire "entity" in favour of "company" without breaking the consumer mid-migration.

## Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Replacement term | **Company** (matches the existing `companies` table) |
| Rename depth | **Additive** — `company` added everywhere, `zohoEntity` kept and deprecated |
| "Sameer Summitt Card OLD" | Deactivate |
| Summitt Labs (`zoho_enabled=false`) | Include in `/ext/companies` with a `zohoEnabled` flag |

## Starting state (measured 2026-08-11)

- **Categories** — `/ext/categories` exists and is scoped per connection; `trade_show` sees exactly its 15. No change needed.
- **Payment methods** — `/ext/payment-methods` exists, returns 12 active + company-wide cards, correctly shaped for Trade Show's `cardOptions`.
- **Companies** — **no ext endpoint exists.** Trade Show cannot read companies from Midas at all. This is the gap.
- **Terminology** — "entity" appears 153 times across `apps/api/src`, including the `expenses.zoho_entity` column and the `zohoEntity` field Trade Show's `MidasExpenseStore` sends on every write.

## Design

### 1. `GET /ext/companies` (new)
Behind the existing `expenses:read` scope. Returns active companies ordered by `sortOrder`:

```json
{ "companies": [ { "name": "Haute Brands", "zohoEnabled": true, "sortOrder": 1 } ] }
```

`name` is the identifier because `expenses.zoho_entity` already stores the company NAME and Trade Show already sends names — introducing ids here would add a translation step with nothing to gain. Non-Zoho companies are included with `zohoEnabled: false` so the consumer can decide; Midas stays app-agnostic.

### 2. Additive `company` field
- **Responses**: the `/ext` expense DTO gains `company`, carrying the same value as `zohoEntity`. Both are returned.
- **Requests**: `/ext/expenses` (create), `PATCH /ext/expenses/:id`, and `/ext/expenses/import` accept either `company` or `zohoEntity`; `company` wins when both are present.
- **Payment methods**: `defaultCompany` added alongside `defaultZohoEntity`.
- **DB**: the `expenses.zoho_entity` column is unchanged. A rename buys nothing a field alias does not, and would mean migrating 377 live rows mid-cutover.
- `zohoEntity` is documented as deprecated but remains supported indefinitely.

### 3. UI labels → "Company"
Changed: payment-method form "Default Zoho entity", expense quick-view "Entity", payment-methods table header "Entity".

**Deliberately unchanged:** Admin → Audit Log "Entity type" / "Entity" columns. Those mean *database entity* (user, expense, connection) — a different concept that "Company" would make incorrect.

### 4. `GET /ext/health/vocabulary` (new)
One call returning the counts a consumer verifies before flipping over — categories visible to the calling connection, payment methods, companies — plus whether the connection is category-scoped. Turns cutover verification into a single request.

### 5. Data hygiene
Deactivate the payment method "Sameer Summitt Card OLD" (…3019). Existing expenses keep their reference to it; it stops appearing in pickers.

## Out of scope
- The sandbox Midas database being ~2 months behind production (13 missing tables). It cannot validate any of this until migrated — tracked separately.
- Trade Show's duplicate `resolveCategoryName` regex map, which duplicates Midas's `category_mappings`.
- Renaming the `zoho_entity` DB column.
- Any change to Zoho brand slugs (`haute_brands` etc.), which are the integration service's contract.
