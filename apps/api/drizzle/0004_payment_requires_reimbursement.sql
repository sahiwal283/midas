-- Mark payment methods that require employee reimbursement (personal cards).
ALTER TABLE "payment_methods"
  ADD COLUMN IF NOT EXISTS "requires_reimbursement" boolean DEFAULT false NOT NULL;

-- Trade Show personal card (and any similarly named active card)
UPDATE "payment_methods"
SET "requires_reimbursement" = true,
    "updated_at" = now()
WHERE "is_active" = true
  AND (
    lower("label") LIKE '%personal%'
    OR "last_four" = '0000' AND lower("label") LIKE '%reimburs%'
  );

-- Backfill expenses on reimbursable cards that never entered the reimbursement workflow
UPDATE "expenses" e
SET "reimbursement_status" = 'pending',
    "updated_at" = now()
FROM "payment_methods" pm
WHERE e.payment_method_id = pm.id
  AND pm.requires_reimbursement = true
  AND e.reimbursement_status = 'not_requested';
