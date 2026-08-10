-- Closed accounting periods: a closed month ('YYYY-MM') locks every expense
-- dated in it (no edits/deletes/submits/reviews/reimbursement changes;
-- admin force-delete is the audited override). Reopen = delete row (admin).
CREATE TABLE IF NOT EXISTS "closed_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "period" char(7) NOT NULL,
  "closed_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "closed_periods_period_unique" ON "closed_periods" ("period");
