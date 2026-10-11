-- App alignment: idempotent client ids, dish table version, carbs and fat.
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS dish_table_version INT;
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS carbs_g NUMERIC(7,1) NOT NULL DEFAULT 0 CHECK (carbs_g >= 0);
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS fat_g NUMERIC(7,1) NOT NULL DEFAULT 0 CHECK (fat_g >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS food_entries_client_id ON food_entries(user_id, client_id) WHERE client_id IS NOT NULL;
