-- Ext API / Trade Show merge schema (docs/EXT_API_MERGE_LOCK.md)
-- Apply on sandbox/prod when not using drizzle-kit push:
--   psql "$DATABASE_URL" -f apps/api/drizzle/0002_ext_trade_show_merge.sql

-- Reimbursement: additive enum value
DO $$ BEGIN
  ALTER TYPE "reimbursement_status" ADD VALUE IF NOT EXISTS 'rejected';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Expense embedder context
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "source_context" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "external_user_id" text;

CREATE INDEX IF NOT EXISTS "expenses_source_app_idx" ON "expenses" USING btree ("source_app");
CREATE INDEX IF NOT EXISTS "expenses_external_user_id_idx" ON "expenses" USING btree ("external_user_id");
CREATE INDEX IF NOT EXISTS "expenses_source_context_event_id_idx"
  ON "expenses" USING btree (("source_context"->>'eventId'));

-- Receipt checksum
ALTER TABLE "receipts" ADD COLUMN IF NOT EXISTS "sha256" text;

-- OCR / legacy suggestion → categoryId per sourceApp
CREATE TABLE IF NOT EXISTS "category_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_app" text NOT NULL,
  "suggestion" text NOT NULL,
  "category_id" uuid NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "category_mappings"
    ADD CONSTRAINT "category_mappings_category_id_expense_categories_id_fk"
    FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "category_mappings_source_suggestion_idx"
  ON "category_mappings" USING btree ("source_app", "suggestion");
CREATE INDEX IF NOT EXISTS "category_mappings_category_id_idx"
  ON "category_mappings" USING btree ("category_id");
