-- 0022: Retired / alternate emails that still resolve to a Midas user.
--
-- Merging two accounts removes one email from users, but external systems keep
-- sending it. Trade Show posts expenses as tech@cooliohcandy.com, which stopped
-- resolving the moment `sahil` was merged into `sahilk` — with
-- EXT_AUTO_PROVISION_USERS=false that is a hard USER_NOT_FOUND on submit.

CREATE TABLE IF NOT EXISTS user_email_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_aliases_email_idx
  ON user_email_aliases (lower(email));

CREATE INDEX IF NOT EXISTS user_email_aliases_user_idx
  ON user_email_aliases (user_id);
