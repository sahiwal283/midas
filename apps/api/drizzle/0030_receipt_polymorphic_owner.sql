-- Purchase orders require a receipt, but receipts could only belong to an
-- expense — and a purchase order is a `transactions` row with no expense.
--
-- Additive and idempotent: existing rows keep their expense_id untouched and
-- satisfy the new CHECK as-is, because transaction_id defaults to NULL.

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS transaction_id uuid;

-- Name it the way drizzle-kit names foreign keys
-- (<table>_<col>_<ftable>_<fcol>_fk), not Postgres's default <table>_<col>_fkey.
-- A later `db:push`/`db:reset` against a migrated database diffs constraints by
-- name: under the Postgres default it would not recognise this FK as its own
-- and would add a second one on the same column.
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_transaction_id_fkey;
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_transaction_id_transactions_id_fk;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_transaction_id_transactions_id_fk
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE;

ALTER TABLE receipts ALTER COLUMN expense_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS receipts_transaction_id_idx ON receipts (transaction_id);

ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_one_owner;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_one_owner
  CHECK ((expense_id IS NOT NULL) <> (transaction_id IS NOT NULL));
