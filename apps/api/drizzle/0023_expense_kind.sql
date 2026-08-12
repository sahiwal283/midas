-- 0023: Business vs partner spend on expenses (additive).
-- Partner-kind expenses are excluded from the accountant queue and Zoho push.

DO $$ BEGIN
  CREATE TYPE expense_kind AS ENUM ('business', 'partner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS expense_kind expense_kind NOT NULL DEFAULT 'business';

CREATE INDEX IF NOT EXISTS expenses_expense_kind_idx ON expenses (expense_kind);
