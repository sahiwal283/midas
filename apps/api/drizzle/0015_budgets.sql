-- 0015: Budgets + provenance source_type enum (additive)

DO $$ BEGIN
  CREATE TYPE transaction_source_type AS ENUM (
    'manual',
    'online_receipt',
    'purchase_order',
    'browser_extension',
    'trade_show_event',
    'import',
    'partner',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Soft provenance: keep text columns; app validates against known values.
-- Optional comment for operators.
COMMENT ON COLUMN expenses.source_type IS 'Provenance: manual|online_receipt|purchase_order|browser_extension|trade_show_event|import|partner|other';
COMMENT ON COLUMN transactions.source_type IS 'Provenance: same vocabulary as expenses.source_type';

CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL REFERENCES companies(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  period char(7) NOT NULL,
  amount numeric(12, 2) NOT NULL,
  category_id uuid REFERENCES expense_categories(id) ON DELETE SET NULL,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT budgets_period_ym CHECK (period ~ '^\d{4}-\d{2}$'),
  CONSTRAINT budgets_amount_nonneg CHECK (amount >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS budgets_company_period_category_uidx
  ON budgets (
    company_name,
    period,
    (COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

CREATE INDEX IF NOT EXISTS budgets_period_idx ON budgets (period);
CREATE INDEX IF NOT EXISTS budgets_company_idx ON budgets (company_name);
