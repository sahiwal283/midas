-- 0018: Hierarchical categories — parent_id self-reference (additive)

ALTER TABLE expense_categories
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES expense_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS expense_categories_parent_idx ON expense_categories (parent_id);
