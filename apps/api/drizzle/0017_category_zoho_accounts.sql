-- 0017: Per-company Zoho COA account per category (Trade Show parity, additive)

CREATE TABLE IF NOT EXISTS category_zoho_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES expense_categories(id) ON DELETE CASCADE,
  company_name text NOT NULL REFERENCES companies(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  zoho_account_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS category_zoho_accounts_cat_company_idx
  ON category_zoho_accounts (category_id, company_name);
