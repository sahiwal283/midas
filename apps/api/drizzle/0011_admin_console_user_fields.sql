-- Admin console: user org profile, last login, invitation tokens.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "department" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employee_id" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "cost_center" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "manager_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "default_zoho_entity" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "default_payment_method_id" uuid REFERENCES "payment_methods"("id") ON DELETE SET NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "invite_token" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "invite_expires_at" timestamp;
