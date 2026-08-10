# Hierarchical Expense Categories

**Date:** 2026-08-10 · **Status:** Approved
**Goal:** Replace the flat, cluttered category list with a parent/child tree of arbitrary depth. Upload forms show top-level categories first and reveal sub-options as the user drills in; specificity is preserved without overwhelming pickers.

## Decisions (user-confirmed)

| Question | Decision |
|---|---|
| Picker data source | Midas categories (not live Zoho COA); Zoho account resolved server-side |
| Drill rule | Selecting at any level is valid — sub-selects are optional refinement |
| Zoho mapping inheritance | Sub-category without its own mapping inherits from nearest ancestor |
| Initial tree | Shipped without pre-approval; fully editable in Admin → Categories |

## Design

### Schema (migration 0018)
`expense_categories.parent_id uuid NULL` self-FK → `expense_categories(id) ON DELETE SET NULL`. Adjacency list — no closure table (≈25 nodes, shallow). API enforces acyclicity on re-parent by walking ancestors. *Effective activity*: a category is shown in pickers only if it and every ancestor is active; deactivating a parent hides its subtree without touching child rows.

### Zoho resolution with inheritance
`resolveCategoryEntityAccountId(categoryId, zohoEntity)` walks up the ancestry: exact (category, company) row in `category_zoho_accounts`, else parent, until root. The legacy `expense_categories.zoho_account_id` fallback walks the same ancestry. Per-expense live COA pick (`expenses.zoho_expense_account_id`) still always wins. Resolution order per expense: live pick → per-entity table (ancestry walk) → legacy column (ancestry walk) → null.

### Upload form (ExpenseNew)
The Zoho COA dropdown is replaced by a cascading Midas category picker: a select of top-level categories; picking a node with children reveals a child select ("— refine (optional) —"), recursively to any depth. The deepest selected node becomes `categoryId` on the expense. Users never see Zoho ledger accounts. OCR category suggestion matches by name across the whole tree, deepest match preferred. The form no longer sets `zohoExpenseAccountId`; accountants retain their existing COA override at review/push time.

### Admin → Categories
Indented tree table. Per row: rename, active toggle (existing), parent dropdown to re-parent (cycle-guarded, includes "— top level —"), and "add sub-category". This is the tree-editing surface.

### API
- `GET /expenses/categories/list` → flat list including `parentId` (client builds the tree). Only effectively-active categories.
- `GET /admin/categories` → all categories with `parentId` (including inactive).
- `POST /admin/categories` accepts optional `parentId`.
- `PATCH /admin/categories/:id` accepts `parentId` (nullable); rejects cycles (400) and self-parenting.
- Expense list endpoints that filter by `categoryId` expand to the category's descendant set server-side.
- `/ext` category list/upsert: optional `parentId` pass-through, backward compatible.

### Filters & reports
- ExpenseList (client-side filter) and AccountantQueue (server param): selecting a parent matches parent + all descendants.
- Reports "Spend by category" rolls up to top-level ancestors. Budget actuals for a category include descendant spend.

### Initial tree (seeded idempotently, name-matched; editable afterward)
```
Travel (existing)
├─ Travel - Flight
├─ Travel Expenses
├─ Accommodation (existing)
│  └─ Accommodation - Hotel
└─ Transportation (existing)
   ├─ Transportation - Uber / Lyft / Others
   ├─ Rental - Car / U-haul
   ├─ Gas / Fuel
   └─ Parking Fees
Meals & Entertainment (existing)
├─ Meal and Entertainment
└─ Show Allowances - Per Diem
Show Operations (new)
├─ Booth / Marketing / Tools
├─ Model
├─ Shipping Charges
└─ Storage charges
Office & Admin (new)
├─ Office Supplies
├─ Stationaries
├─ Software & Subscriptions
├─ Professional Services
├─ Equipment
└─ Marketing & Advertising
Other (existing, top-level leaf)
```
Existing expense→category references unchanged; only `parent_id` values are set. The previously-unused duplicate categories become parents (no longer clutter).

## Out of scope
- Browser extension (no category field) and partner expenses (separate business/personal enum).
- Zoho chart-of-accounts structure (unchanged).
- Moving/merging historical expenses between categories.
- Multi-parent or tagging models.
