-- 0027: Cashbook merged from the standalone app (CT 120). Integer cents,
-- append-only ledger (void, never delete). The payroll-linked business keeps
-- its ledger in the payroll database.

DO $$ BEGIN
  CREATE TYPE cash_entry_kind AS ENUM ('DEPOSIT', 'WITHDRAWAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cash_businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  payroll_linked boolean NOT NULL DEFAULT false,
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_businesses_name_unique ON cash_businesses (name);

CREATE TABLE IF NOT EXISTS cash_drawer_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES cash_businesses(id) ON DELETE CASCADE,
  kind cash_entry_kind NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  invoice_number text,
  notes text,
  category text,
  receipt_path text,
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_label text,
  voided_at timestamp,
  voided_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_entries_business_idx ON cash_drawer_entries (business_id, created_at);
CREATE INDEX IF NOT EXISTS cash_entries_entry_date_idx ON cash_drawer_entries (business_id, entry_date);
