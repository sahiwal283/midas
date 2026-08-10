-- 0014: Transaction / PO foundation
-- Additive migration. Safe on DBs that already have expenses via db:push.

-- New enums
DO $$ BEGIN
  CREATE TYPE transaction_type AS ENUM ('expense', 'purchase_order');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE transaction_status AS ENUM (
    'draft', 'submitted', 'in_review', 'awaiting_info', 'approved', 'rejected', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE integration_status AS ENUM (
    'not_required', 'pending', 'queued', 'syncing', 'synced', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Extend expense_status with cancelled (keep zoho_sync_failed for compat)
ALTER TYPE expense_status ADD VALUE IF NOT EXISTS 'cancelled';

-- Expenses: integration status + request id
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS integration_status integration_status NOT NULL DEFAULT 'not_required';
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS zoho_request_id text;

-- Vendors
CREATE TABLE IF NOT EXISTS vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL,
  zoho_vendor_id text,
  default_entity text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vendors_normalized_name_idx ON vendors (normalized_name);
CREATE INDEX IF NOT EXISTS vendors_zoho_vendor_id_idx ON vendors (zoho_vendor_id);

-- Zoho items cache
CREATE TABLE IF NOT EXISTS zoho_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_item_id text NOT NULL,
  name text NOT NULL,
  sku text,
  unit text,
  brand text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  synced_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS zoho_items_brand_zoho_id_idx ON zoho_items (brand, zoho_item_id);
CREATE INDEX IF NOT EXISTS zoho_items_name_idx ON zoho_items (name);

-- Transactions root
CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type transaction_type NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name text NOT NULL,
  transaction_date date NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  total numeric(12, 2) NOT NULL,
  tax_total numeric(12, 2) NOT NULL DEFAULT 0,
  description text,
  status transaction_status NOT NULL DEFAULT 'draft',
  integration_status integration_status NOT NULL DEFAULT 'not_required',
  source_app text,
  source_ref_id text,
  source_label text,
  source_url text,
  source_type text,
  source_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_user_id text,
  zoho_entity text,
  zoho_record_id text,
  zoho_synced_at timestamp,
  zoho_sync_error text,
  zoho_request_id text,
  reviewed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_id_idx ON transactions (user_id);
CREATE INDEX IF NOT EXISTS transactions_type_idx ON transactions (type);
CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions (status);
CREATE INDEX IF NOT EXISTS transactions_integration_status_idx ON transactions (integration_status);
CREATE INDEX IF NOT EXISTS transactions_created_at_idx ON transactions (created_at);
CREATE INDEX IF NOT EXISTS transactions_vendor_id_idx ON transactions (vendor_id);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_source_unique_idx ON transactions (source_app, source_ref_id);

CREATE TABLE IF NOT EXISTS expense_details (
  transaction_id uuid PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  category_id uuid REFERENCES expense_categories(id) ON DELETE SET NULL,
  payment_method_id uuid REFERENCES payment_methods(id) ON DELETE SET NULL,
  reimbursement_status reimbursement_status NOT NULL DEFAULT 'not_requested',
  zoho_expense_account_id text,
  zoho_expense_account_name text
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  transaction_id uuid PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  po_number text,
  zoho_vendor_id text,
  delivery_date date,
  notes text
);

CREATE TABLE IF NOT EXISTS transaction_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  item_id uuid REFERENCES zoho_items(id) ON DELETE SET NULL,
  zoho_item_id text,
  description text NOT NULL,
  quantity numeric(14, 4) NOT NULL,
  unit text,
  unit_price numeric(12, 4) NOT NULL,
  tax numeric(12, 2) NOT NULL DEFAULT 0,
  total numeric(12, 2) NOT NULL,
  ocr_confidence numeric(5, 4),
  needs_review boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transaction_line_items_tx_idx ON transaction_line_items (transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS transaction_line_items_tx_line_idx ON transaction_line_items (transaction_id, line_number);

-- Backfill integration_status on expenses from Zoho fields / legacy status
UPDATE expenses
SET integration_status = CASE
  WHEN zoho_expense_id IS NOT NULL THEN 'synced'::integration_status
  WHEN status = 'zoho_sync_failed' THEN 'failed'::integration_status
  WHEN status IN ('pending', 'in_review', 'awaiting_info', 'approved') AND zoho_entity IS NOT NULL
    THEN 'pending'::integration_status
  ELSE 'not_required'::integration_status
END
WHERE integration_status = 'not_required'
  AND (
    zoho_expense_id IS NOT NULL
    OR status = 'zoho_sync_failed'
    OR (status IN ('pending', 'in_review', 'awaiting_info', 'approved') AND zoho_entity IS NOT NULL)
  );

-- Normalize legacy zoho_sync_failed → approved + failed integration
UPDATE expenses
SET status = 'approved'
WHERE status = 'zoho_sync_failed';

-- Backfill vendors from distinct merchants
INSERT INTO vendors (name, normalized_name)
SELECT DISTINCT ON (lower(trim(merchant)))
  trim(merchant),
  lower(trim(merchant))
FROM expenses
WHERE trim(merchant) <> ''
ON CONFLICT (normalized_name) DO NOTHING;

-- Backfill transactions from expenses (same UUID)
INSERT INTO transactions (
  id, type, user_id, vendor_id, vendor_name, transaction_date, currency, total, tax_total,
  description, status, integration_status,
  source_app, source_ref_id, source_label, source_url, source_type, source_context, external_user_id,
  zoho_entity, zoho_record_id, zoho_synced_at, zoho_sync_error, zoho_request_id,
  reviewed_by_id, reviewed_at, created_at, updated_at
)
SELECT
  e.id,
  'expense'::transaction_type,
  e.user_id,
  v.id,
  e.merchant,
  e.date,
  e.currency,
  e.amount,
  0,
  e.description,
  CASE e.status
    WHEN 'pending' THEN 'submitted'::transaction_status
    WHEN 'cancelled' THEN 'cancelled'::transaction_status
    WHEN 'draft' THEN 'draft'::transaction_status
    WHEN 'in_review' THEN 'in_review'::transaction_status
    WHEN 'awaiting_info' THEN 'awaiting_info'::transaction_status
    WHEN 'approved' THEN 'approved'::transaction_status
    WHEN 'rejected' THEN 'rejected'::transaction_status
    ELSE 'submitted'::transaction_status
  END,
  e.integration_status,
  e.source_app,
  e.source_ref_id,
  e.source_label,
  e.source_url,
  e.source_type,
  e.source_context,
  e.external_user_id,
  e.zoho_entity,
  e.zoho_expense_id,
  e.zoho_synced_at,
  e.zoho_sync_error,
  e.zoho_request_id,
  e.reviewed_by_id,
  e.reviewed_at,
  e.created_at,
  e.updated_at
FROM expenses e
LEFT JOIN vendors v ON v.normalized_name = lower(trim(e.merchant))
ON CONFLICT (id) DO NOTHING;

INSERT INTO expense_details (
  transaction_id, category_id, payment_method_id, reimbursement_status,
  zoho_expense_account_id, zoho_expense_account_name
)
SELECT
  e.id, e.category_id, e.payment_method_id, e.reimbursement_status,
  e.zoho_expense_account_id, e.zoho_expense_account_name
FROM expenses e
ON CONFLICT (transaction_id) DO NOTHING;
