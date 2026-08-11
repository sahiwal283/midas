-- 0021: Explicit pre-linking of a Midas user to an IdP identity.
--
-- Username and email matching only link a user when one of those happens to
-- agree with the IdP. An admin can now state the Authentik username directly,
-- so the link is deterministic instead of incidental.

ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_username text;

CREATE UNIQUE INDEX IF NOT EXISTS users_sso_username_lower_idx
  ON users (lower(sso_username)) WHERE sso_username IS NOT NULL;
