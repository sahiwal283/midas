-- Collapse leftover claim state (in_review) back to pending approval.
-- Claim/release endpoints removed; single-accountant workflow uses pending directly.
UPDATE "expenses"
SET
  "status" = 'pending',
  "reviewed_by_id" = NULL,
  "reviewed_at" = NULL,
  "updated_at" = now()
WHERE "status" = 'in_review';
