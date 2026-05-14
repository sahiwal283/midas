-- Stage 1: OCR service integration — enrichment columns on receipts
-- Additive only. All columns are nullable with no defaults.
-- Apply via: cd apps/api && npm run db:push
-- Or run directly against the database if using explicit migrations.

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ocr_request_id           text,
  ADD COLUMN IF NOT EXISTS ocr_provider             text,
  ADD COLUMN IF NOT EXISTS ocr_confidence           numeric(5,4),
  ADD COLUMN IF NOT EXISTS ocr_overall_confidence   numeric(5,4),
  ADD COLUMN IF NOT EXISTS ocr_needs_review         boolean,
  ADD COLUMN IF NOT EXISTS ocr_review_reasons       text[],
  ADD COLUMN IF NOT EXISTS ocr_error_summary        text,
  ADD COLUMN IF NOT EXISTS ocr_cost_estimate_usd    numeric(10,6),
  ADD COLUMN IF NOT EXISTS ocr_submitted_at         timestamp,
  ADD COLUMN IF NOT EXISTS ocr_completed_at         timestamp;
