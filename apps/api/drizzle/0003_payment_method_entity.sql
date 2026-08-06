-- Payment methods: default Zoho entity (Trade Show card.entity)
-- Apply: psql "$DATABASE_URL" -f apps/api/drizzle/0003_payment_method_entity.sql

ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "default_zoho_entity" text;

CREATE UNIQUE INDEX IF NOT EXISTS "payment_methods_last_four_active_uidx"
  ON "payment_methods" ("last_four")
  WHERE "is_active" = true AND "last_four" IS NOT NULL;
