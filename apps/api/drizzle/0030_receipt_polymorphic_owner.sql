-- Purchase orders require a receipt, but receipts could only belong to an
-- expense — and a purchase order is a `transactions` row with no expense.
--
-- Additive and idempotent: existing rows keep their expense_id untouched and
-- satisfy the new CHECK as-is, because transaction_id defaults to NULL.

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS transaction_id uuid;

ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_transaction_id_fkey;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE;

ALTER TABLE receipts ALTER COLUMN expense_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS receipts_transaction_id_idx ON receipts (transaction_id);

ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_one_owner;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_one_owner
  CHECK ((expense_id IS NOT NULL) <> (transaction_id IS NOT NULL));
