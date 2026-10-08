-- apps/api/drizzle/0033_ext_events_needs_review.sql
-- Ext event hand-off (v1.21.0): submitter-facing notifications on an
-- external app's expenses are recorded here for that app to pull, instead of
-- being delivered by Midas. Plus grouped accountant "needs review"
-- notifications and the category flag that asks for the accountant.

ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS events_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS events_ping_url text;

ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS needs_accountant boolean NOT NULL DEFAULT false;

-- When the missing-details sweep looked at this expense. Set once, whether or
-- not anything was missing, so no expense is examined twice.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS incomplete_notified_at timestamp;
-- Everything that exists today predates the sweep: mark it looked-at so the
-- first pass after deploy tells nobody about old expenses.
UPDATE expenses SET incomplete_notified_at = now() WHERE incomplete_notified_at IS NULL;

-- Grouped bell rows: one unread row per recipient per group, with a count.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_key text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS count integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_unread_group_idx
  ON notifications (user_id, group_key)
  WHERE read_at IS NULL AND group_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ext_events (
  seq         bigserial PRIMARY KEY,
  id          uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  source_app  text NOT NULL,
  type        text NOT NULL,
  expense_id  uuid REFERENCES expenses(id) ON DELETE CASCADE,
  payload     jsonb NOT NULL,
  created_at  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ext_events_source_app_seq_idx ON ext_events (source_app, seq);
