-- Zoho Books expense account (COA) id per Midas category — required for create_books.
ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "zoho_account_id" text;
