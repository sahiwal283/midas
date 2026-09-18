-- When OCR corrections for this receipt were reported to the OCR service
-- (set once on expense submit or by the backfill, even if nothing changed),
-- so resubmits and re-runs never double-count.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ocr_corrections_reported_at timestamp;
