-- Standalone partner expense tracker. Decoupled from the normal expense flow:
-- no receipts, no review queue, no reimbursement, no Zoho.
DO $$ BEGIN
  CREATE TYPE "public"."partner_expense_category" AS ENUM ('business', 'personal');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "partner_expenses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "amount" numeric(12, 2) NOT NULL,
  "item_location" text NOT NULL,
  "category" "partner_expense_category" DEFAULT 'business' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
