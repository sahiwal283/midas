-- An accountant can push an approved expense whose submitter lost the receipt,
-- but only by writing why. The reason is stored here rather than only in the
-- audit log so it survives a failed push (the retry reads it back instead of
-- asking for it again) and so the expense can show why it was waived.
--
-- Additive and idempotent: all three columns are nullable and existing rows
-- read as "not waived", which is the pre-change behaviour.

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_waiver_reason text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_waived_by_id uuid;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_waived_at timestamp;

-- Named so a re-run is a no-op rather than a duplicate-constraint error.
-- ON DELETE SET NULL: the justification outlives the accountant who wrote it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_receipt_waived_by_id_fkey'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_receipt_waived_by_id_fkey
      FOREIGN KEY (receipt_waived_by_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
