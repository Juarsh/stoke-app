-- Entry versions (sync race fix): every food_entries row carries a server
-- version, 1 on insert and bumped by every write (trigger, so no write path can
-- forget it). PATCH takes the version the phone last saw; a different current
-- version is a 409 version_conflict with the server's row (never the phone's clock).
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION food_entries_bump_version() RETURNS trigger AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS food_entries_version ON food_entries;
CREATE TRIGGER food_entries_version BEFORE UPDATE ON food_entries FOR EACH ROW EXECUTE FUNCTION food_entries_bump_version();
