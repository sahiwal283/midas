-- Which sourceApp a connection speaks for.
--
-- app_name identifies the CREDENTIAL ("trade_show_prod", "trade_show" for the
-- sandbox key); source_app identifies the DATA those credentials own, and
-- several connections legitimately share one. Expenses carry source_app, so
-- comparing them to app_name — as the message endpoints first did — 404s every
-- request from a key whose name carries an environment suffix.
--
-- NULL means "falls back to app_name", preserving behaviour for any connection
-- where the two genuinely match.

ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS source_app text;

UPDATE app_connections SET source_app = 'trade_show'
 WHERE source_app IS NULL AND app_name IN ('trade_show', 'trade_show_prod');
