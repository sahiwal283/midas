#!/bin/bash
set -euo pipefail
cd /opt/midas
set -a
# shellcheck disable=SC1091
source .env
set +a

echo "Applying 0014_transactions_po.sql..."
docker run --rm --network host \
  -v /opt/midas/apps/api/drizzle:/drizzle:ro \
  postgres:15 \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /drizzle/0014_transactions_po.sql

echo "Recording migration..."
docker run --rm --network host -i postgres:15 \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS midas_sql_migrations (
  id text PRIMARY KEY,
  applied_at timestamp NOT NULL DEFAULT now()
);
INSERT INTO midas_sql_migrations (id) VALUES ('0014_transactions_po') ON CONFLICT DO NOTHING;
SELECT tablename FROM pg_tables
WHERE tablename IN (
  'transactions','purchase_orders','transaction_line_items',
  'vendors','zoho_items','expense_details'
)
ORDER BY 1;
SQL

echo "MIGRATION_OK"
