# Midas Database Design

Schema file: `apps/api/src/db/schema.ts` (single source of truth)
ORM: Drizzle ORM + drizzle-kit
Database: PostgreSQL 15 (prod: CT 3220 at 192.168.1.211, reachable only from the app container)

This document is a map, not a mirror — column-level truth lives in `schema.ts`.
Diagrams are grouped by domain because one ERD over all 27 tables is unreadable.

---

## Domains at a glance

| Domain | Tables |
|---|---|
| Identity & auth | `users`, `user_email_aliases`, `sso_links` |
| Reference data | `companies`, `expense_categories`, `category_zoho_accounts`, `payment_methods`, `budgets`, `vendors`, `zoho_items` |
| Expense core | `expenses`, `expense_messages`, `receipts`, `captures`, `notifications`, `push_subscriptions` |
| Transactions & POs | `transactions`, `expense_details`, `purchase_orders`, `transaction_line_items` |
| App integration | `app_connections`, `app_connection_categories`, `category_mappings` |
| Governance | `audit_logs`, `closed_periods` |
| Cashbook | `cash_businesses`, `cash_drawer_entries` |

---

## Identity & auth

```mermaid
erDiagram
    users ||--o{ user_email_aliases : "known by"
    users ||--o{ sso_links : "linked to IdP"

    users {
        uuid id PK
        text username UK "identity key, lowercase"
        text email UK "optional, many NULLs allowed"
        text sso_username "pre-link to Authentik identity"
        user_role role "user|accountant|admin|partner|developer"
        text password_hash "null for SSO-only users"
        boolean is_active
        uuid manager_id
        text default_zoho_entity
        uuid default_payment_method_id
        text invite_token "single-use, 7-day"
    }
    user_email_aliases {
        uuid id PK
        uuid user_id FK
        text email UK "resolves stale addresses after merges"
    }
    sso_links {
        uuid id PK
        text provider "authentik"
        text subject "OIDC sub claim"
        uuid user_id FK
    }
```

- **Username, not email, is the identity key** — an Authentik account with no
  email can still be provisioned.
- `(provider, subject)` is unique: one IdP identity maps to exactly one user.
- Aliases keep external systems working when a person's address changes or two
  accounts merge — submissions sent to an old address still resolve.

## Reference data

```mermaid
erDiagram
    expense_categories ||--o{ expense_categories : "parent of"
    expense_categories ||--o{ category_zoho_accounts : "per-company COA account"
    companies ||--o{ category_zoho_accounts : ""
    companies ||--o{ budgets : "monthly budget"
    expense_categories ||--o{ budgets : "optional scope"
    users ||--o{ payment_methods : "assigned (personal cards)"

    companies {
        uuid id PK
        text name UK "expenses.zoho_entity stores this NAME"
        boolean zoho_enabled "false = never enters Zoho pipeline"
        boolean is_active
    }
    expense_categories {
        uuid id PK
        text name UK
        text zoho_account_id "default Zoho COA account"
        uuid parent_id FK "tree, arbitrary depth"
        boolean is_active
    }
    category_zoho_accounts {
        uuid id PK
        uuid category_id FK
        text company_name FK
        text zoho_account_id "overrides category default per company"
    }
    payment_methods {
        uuid id PK
        text label
        char last_four
        text zoho_account_name "Zoho paid-through account"
        text default_zoho_entity
        boolean requires_reimbursement "personal / out-of-pocket"
        boolean is_company_wide
        uuid assigned_user_id FK
    }
    budgets {
        uuid id PK
        text company_name FK
        char period "YYYY-MM"
        numeric amount
        uuid category_id FK "null = whole company"
    }
    vendors {
        uuid id PK
        text name
        text normalized_name UK "merchant matching"
        text zoho_vendor_id
    }
    zoho_items {
        uuid id PK
        text zoho_item_id
        text name
        text brand "unique with zoho_item_id"
    }
```

- **Company resolution for Zoho:** a category's COA account is looked up in
  `category_zoho_accounts` for the expense's company first, falling back to
  `expense_categories.zoho_account_id`. Beware: the fallback is not
  company-aware, so a missing per-company row can send another org's account id.
- `vendors` and `zoho_items` are caches of Zoho-side records used for PO
  vendor/line-item matching.

## Expense core

```mermaid
erDiagram
    users ||--o{ expenses : submits
    expenses ||--o{ receipts : has
    expenses ||--o{ expense_messages : "conversation"
    expenses ||--o{ captures : "extension screenshots"
    expenses ||--o{ notifications : about
    users ||--o{ notifications : receives
    users ||--o{ push_subscriptions : "devices"

    expenses {
        uuid id PK
        uuid user_id FK
        uuid category_id FK
        uuid payment_method_id FK
        text source_app "null = native Midas submission"
        text source_ref_id "unique with source_app"
        jsonb source_context "opaque embedder context (eventId...)"
        expense_kind expense_kind "business|partner"
        text merchant
        numeric amount
        date date
        expense_status status "draft...approved|rejected"
        integration_status integration_status "not_required...synced|failed"
        reimbursement_status reimbursement_status
        text zoho_entity "company NAME"
        text zoho_expense_id "Zoho record after push"
        uuid reviewed_by_id FK
    }
    receipts {
        uuid id PK
        uuid expense_id FK "XOR with transaction_id (DB check)"
        uuid transaction_id FK
        text storage_path
        ocr_status ocr_status
        jsonb ocr_data
        text ocr_request_id "OCR service correlation"
    }
    expense_messages {
        uuid id PK
        uuid expense_id FK
        uuid sender_id FK
        text body
        text request_type "info_request|missing_receipt|..."
        text internal_note "accountant-only"
        boolean is_resolved
    }
    captures {
        uuid id PK
        uuid user_id FK
        uuid expense_id FK
        text page_url
        text image_path
        capture_status status "draft|linked|discarded"
    }
```

- **Workflow status and integration status are separate axes.** `status`
  tracks human review; `integration_status` tracks the Zoho pipeline. The
  legacy `zoho_sync_failed` status value survives for compat, but new writes
  use `approved` + `integration_status='failed'`.
- `(source_app, source_ref_id)` is unique — an external app cannot import the
  same record twice. Both NULL (manual submissions) never collide.
- `expense_messages` is the **canonical conversation record**; any external
  notification channel is notify-only.
- A receipt belongs to an expense **or** a transaction, never both and never
  neither — enforced by a database check constraint, not convention.

## Transactions & purchase orders

```mermaid
erDiagram
    transactions ||--|| expense_details : "type=expense"
    transactions ||--|| purchase_orders : "type=purchase_order"
    transactions ||--o{ transaction_line_items : has
    transactions ||--o{ receipts : has
    vendors ||--o{ transactions : ""
    zoho_items ||--o{ transaction_line_items : "matched to"
    users ||--o{ transactions : submits

    transactions {
        uuid id PK
        transaction_type type "expense|purchase_order"
        uuid user_id FK
        uuid vendor_id FK
        text vendor_name "display / OCR string"
        numeric total
        transaction_status status
        integration_status integration_status
        text source_app "unique with source_ref_id"
        text zoho_record_id
    }
    expense_details {
        uuid transaction_id PK "1:1 extension"
        uuid category_id FK
        uuid payment_method_id FK
        reimbursement_status reimbursement_status
    }
    purchase_orders {
        uuid transaction_id PK "1:1 extension"
        text po_number "assigned by Zoho"
        text zoho_vendor_id
        date delivery_date
    }
    transaction_line_items {
        uuid id PK
        uuid transaction_id FK
        integer line_number "unique per transaction"
        uuid item_id FK
        numeric quantity
        numeric unit_price
        boolean needs_review "low OCR confidence"
    }
```

- `transactions` is the **shared financial root**: one table for the fields
  every money record needs, with 1:1 extension tables per type. Purchase
  orders live entirely here; classic expenses still live in `expenses`
  (the two models coexist).

## App integration

```mermaid
erDiagram
    app_connections ||--o{ app_connection_categories : "category vocabulary"
    expense_categories ||--o{ app_connection_categories : ""
    expense_categories ||--o{ category_mappings : "suggestion target"

    app_connections {
        uuid id PK
        text app_name UK "credential identity, e.g. trade_show_prod"
        text source_app "data ownership; null falls back to app_name"
        text api_key_hash "SHA-256"
        jsonb permissions "scope strings"
        boolean is_active
    }
    app_connection_categories {
        uuid id PK
        uuid connection_id FK
        uuid category_id FK "no rows = unrestricted"
    }
    category_mappings {
        uuid id PK
        text source_app
        text suggestion "OCR / legacy category string"
        uuid category_id FK
    }
```

- External apps call `/api/v1/ext/*` with Bearer keys; only the SHA-256 hash
  is stored. Scopes live in `permissions`
  (see `docs/EXT_API_MERGE_LOCK.md` for the contract).
- A connection with no vocabulary rows sees every active category — restriction
  is opt-in.

## Governance

```mermaid
erDiagram
    users ||--o{ closed_periods : closes

    audit_logs {
        uuid id PK
        text entity_type
        text entity_id
        uuid user_id "NOT an FK - historical snapshot"
        text action
        jsonb before
        jsonb after
    }
    closed_periods {
        uuid id PK
        char period UK "YYYY-MM"
        uuid closed_by_id FK
    }
```

- `audit_logs` is **append-only** — a trigger rejects UPDATE and DELETE.
  `user_id` is deliberately not a foreign key: an FK cascade could never run
  against immutable rows and made every user in the log undeletable.
- A closed month locks every expense dated in it (no edits, submits, reviews,
  or reimbursement changes). Admin force-delete is the audited override.

## Cashbook

```mermaid
erDiagram
    cash_businesses ||--o{ cash_drawer_entries : ledger
    users ||--o{ cash_drawer_entries : records

    cash_businesses {
        uuid id PK
        text name UK
        boolean payroll_linked "entries live in payroll DB instead"
        timestamp archived_at
    }
    cash_drawer_entries {
        uuid id PK
        uuid business_id FK
        cash_entry_kind kind "DEPOSIT|WITHDRAWAL"
        bigint amount_cents "always positive; kind is direction"
        text invoice_number "required for deposits"
        text category "PETTY_CASH marks petty-cash purchases"
        date entry_date "backdatable, never future"
        timestamp voided_at "entries void, never delete"
    }
```

- Money is **integer cents, always**. Ledgers are append-only: entries void,
  they never delete.
- The payroll-linked business has no local rows — its drawer is read from the
  payroll app's database at request time (`lib/payrollDrawer.ts`).

---

## Enums

| Enum | Values |
|---|---|
| `user_role` | `user`, `accountant`, `admin`, `partner`, `developer` |
| `expense_status` | `draft`, `pending`, `in_review`, `awaiting_info`, `approved`, `zoho_sync_failed` (legacy), `rejected`, `cancelled` |
| `transaction_status` | `draft`, `submitted`, `in_review`, `awaiting_info`, `approved`, `rejected`, `cancelled` |
| `integration_status` | `not_required`, `pending`, `queued`, `syncing`, `synced`, `failed` |
| `reimbursement_status` | `not_requested`, `pending`, `approved`, `rejected`, `paid` |
| `ocr_status` | `pending`, `processing`, `done`, `failed` |
| `capture_source` | `extension`, `manual` |
| `capture_status` | `draft`, `linked`, `discarded` |
| `expense_kind` | `business`, `partner` |
| `transaction_type` | `expense`, `purchase_order` |
| `cash_entry_kind` | `DEPOSIT`, `WITHDRAWAL` |

---

## Migration workflow

| Environment | Command | Mechanism |
|---|---|---|
| Local dev | `npm run db:push` | `drizzle-kit push` — direct schema sync, no files |
| Production | `npm run db:generate` → commit SQL → run migrator | Numbered SQL files in `apps/api/drizzle/`, applied by `src/db/runSqlMigrations.ts` |

Production migrations run via the compose `migrator` service **before**
rebuilding the app:

```bash
docker compose -f docker-compose.prod.yml run --rm --build migrator
```

The `--build` flag is required — without it the migrator reuses a stale image
and silently applies nothing. See `docs/OPERATIONS.md` for the full deploy
sequence and `docs/BACKUP_RESTORE.md` before anything destructive.
