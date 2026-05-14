# Payment Methods Design

## Purpose

Payment methods let employees tag which card or payment instrument was used for an expense. This is required before an expense can be pushed to Zoho (Zoho needs to know the "paid through" account).

---

## Schema

Table: `payment_methods`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `label` | text | Display name: "Amex Corporate Card", "Chase Debit" |
| `last_four` | char(4) | Optional last 4 card digits for disambiguation |
| `brand` | text | `visa \| mastercard \| amex \| discover \| debit \| cash \| other` |
| `zoho_account_name` | text | Maps to Zoho "paid through" account name |
| `is_active` | boolean | Inactive methods hidden from employee forms |
| `is_company_wide` | boolean | If false, only visible to assigned user |
| `assigned_user_id` | uuid FK | For personal cards assigned to one employee |
| `created_at` / `updated_at` | timestamp | |

`expenses.payment_method_id` is a nullable FK → `payment_methods.id`. Null means not yet specified.

---

## Visibility rules

- **Admins** see all payment methods (active + inactive) in the admin panel.
- **Accountants** see all active methods.
- **Users** see only company-wide active methods.

---

## Admin management

Managed at `/payment-methods` (admin only, link in Sidebar under Admin).

Available actions:
- Add new payment method (label, last four, brand, Zoho account name, company-wide flag)
- Deactivate — hides from employee forms; existing expenses that reference it are unaffected

---

## Zoho mapping

`zoho_account_name` is a free-text field that the Zoho Integration Service uses to look up the correct "paid through" account in Zoho. When adding a payment method, set this to exactly what Zoho calls the account (e.g., "Corporate AMEX", "Chase Debit Checking").

This field is a placeholder until the Zoho Integration Service is wired. For now it is stored but not transmitted.

---

## Extension support

The browser extension submit form (`/api/v1/extension/expenses`) accepts an optional `paymentMethodId` field. If omitted, the expense is created without a payment method and will appear in the "Missing Payment Method" queue after approval.

---

## Seed data

No payment methods are seeded by default. An admin must create them before employees see the payment method dropdown. The dropdown in `ExpenseNew` is hidden when no active methods exist.

---

## Future: per-user assigned cards

`is_company_wide = false` + `assigned_user_id` supports personal cards. The current UI shows only company-wide methods. Per-user card visibility requires:
1. Query: `isCompanyWide = true OR assignedUserId = currentUser.id`
2. UI: "My Cards" vs. "Company Cards" groups

Not yet implemented.

---

## Future: Zoho account validation

When Zoho is wired, the admin form should validate `zoho_account_name` against a known Zoho chart of accounts entry. Until then, mismatches surface at push time as `ZOHO_SYNC_FAILED`.
