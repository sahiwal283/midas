-- 0019: Per-connection category vocabulary for the /ext API (additive).
-- A connection with no rows here is unrestricted, so existing consumers are
-- unaffected until they are explicitly scoped.

CREATE TABLE IF NOT EXISTS app_connection_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES app_connections(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES expense_categories(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_connection_categories_conn_cat_idx
  ON app_connection_categories (connection_id, category_id);

CREATE INDEX IF NOT EXISTS app_connection_categories_conn_idx
  ON app_connection_categories (connection_id);
