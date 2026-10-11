-- The parsed text span an entry came from, so a later correction (PATCH)
-- can be remembered as that user's learned reading.
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS span TEXT NOT NULL DEFAULT '';
