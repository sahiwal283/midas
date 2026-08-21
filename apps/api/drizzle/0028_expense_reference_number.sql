-- 0028: Optional Zoho Books Reference Number (receipt / invoice / sales order #).
-- Max 50 characters is enforced in the API to match Zoho's field limit.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS reference_number text;
