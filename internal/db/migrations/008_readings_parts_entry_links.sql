-- A remembered food can have several items (a whole meal the AI split into
-- parts): one row per part, keyed by the user's own text.
ALTER TABLE user_readings ADD COLUMN IF NOT EXISTS part INT NOT NULL DEFAULT 0;
ALTER TABLE user_readings DROP CONSTRAINT IF EXISTS user_readings_user_id_norm_span_key;
CREATE UNIQUE INDEX IF NOT EXISTS user_readings_span_part ON user_readings(user_id, norm_span, part);

-- Which part of its span an entry is, and links to a parse job / app item so
-- a late AI answer can be tied to its review entry on the server.
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS span_part INT NOT NULL DEFAULT 0;
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS parse_job_id TEXT;
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS client_item_id TEXT;
CREATE INDEX IF NOT EXISTS food_entries_parse_job ON food_entries(user_id, parse_job_id) WHERE parse_job_id IS NOT NULL;
