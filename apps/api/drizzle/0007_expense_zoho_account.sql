-- Per-expense Zoho Books expense account (live COA pick) — independent of Midas categories.
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "zoho_expense_account_id" text;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "zoho_expense_account_name" text;
