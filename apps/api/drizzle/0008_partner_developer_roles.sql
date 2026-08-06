-- Partner-only expense tracker roles.
-- 'partner' sees the partner expense tracker; 'developer' is all-access and
-- passes every role gate in the app (see apps/api/src/lib/roles.ts).
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'partner';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'developer';
