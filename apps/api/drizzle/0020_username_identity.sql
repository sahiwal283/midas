-- 0020: Username becomes the identity key; email becomes optional.
--
-- An Authentik account with no email could not be auto-provisioned because
-- users.email was unique + NOT NULL. Username replaces it as the identity key.
-- Postgres allows multiple NULLs in a unique index, so several users may have
-- no email while the emails that do exist stay unique.

ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;

-- Backfill, priority order. Explicit names first (Authentik, then Trade Show),
-- so people sign in with the username they already know.
UPDATE users SET username = v.username FROM (VALUES
  -- Authentik (authoritative — this is what they type at the IdP)
  ('sahilk@gmail.com',                       'sahilk'),
  ('nabeelvira@gmail.com',                   'nabeel'),
  -- Trade Show usernames, matched by email
  ('admin@cooliohcandy.com',                 'seriv'),
  ('rita@cooliohcandy.com',                  'rita'),
  ('tech@cooliohcandy.com',                  'sahil'),
  ('accounting@nirvanakulture.com',          'digi'),
  ('sales@nirvanakulture.com',               'shruti'),
  ('salesguru@summittlabs.com',              'brett'),
  ('sameer@summittlabs.com',                 'sameer'),
  ('zeeshanv@gmail.com',                     'zeeshanv'),
  ('doubledspecialtyfoodservices@gmail.com', 'darlad'),
  ('admin@company.com',                      'companyadmin'),
  -- Seed accounts keep their bare names; admin@midas.local owns `admin`
  ('admin@midas.local',                      'admin'),
  ('accountant@midas.local',                 'accountant'),
  ('user@midas.local',                       'user'),
  ('partner@midas.local',                    'partner'),
  ('developer@midas.local',                  'developer')
) AS v(email, username)
WHERE users.email = v.email AND users.username IS NULL;

-- Anything not named above falls back to the email local-part, lowercased.
UPDATE users
SET username = lower(split_part(email, '@', 1))
WHERE username IS NULL AND email IS NOT NULL;

-- Last resort so the NOT NULL below can never fail on unexpected rows.
UPDATE users SET username = 'user-' || left(id::text, 8) WHERE username IS NULL;

-- Abort rather than silently mangle data if the backfill left duplicates.
DO $$
DECLARE dupes int;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT lower(username) FROM users GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'username backfill produced % duplicate username(s) — resolve before migrating', dupes;
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

-- Email is now optional; its uniqueness (for non-null values) is retained.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
