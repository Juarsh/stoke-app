-- needs_review: logged but not confirmed (e.g. offline, AI pending). Counts
-- toward the streak, not toward calorie/macro totals until confirmed.
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'confirmed'
  CHECK (state IN ('confirmed','needs_review'));
