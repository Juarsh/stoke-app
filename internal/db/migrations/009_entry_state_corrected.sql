-- corrected: the client's kcal/protein didn't match its dish and unit, so the
-- server saved its own numbers instead. Counts in totals like confirmed.
ALTER TABLE food_entries DROP CONSTRAINT IF EXISTS food_entries_state_check;
ALTER TABLE food_entries ADD CONSTRAINT food_entries_state_check CHECK (state IN ('confirmed','needs_review','corrected'));
