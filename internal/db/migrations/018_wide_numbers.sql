-- H1 (rg7): no input can overflow a numeric column (a 500 that, with the old
-- separate summary write, poisoned the day). Table rows are capped at 10,000 kcal
-- and 500 g protein per entry (400 above); these widths are defense in depth:
-- per-entry numbers up to 10^10, daily sums up to 10^12.
ALTER TABLE food_entries
  ALTER COLUMN kcal_best TYPE NUMERIC(12,1), ALTER COLUMN kcal_low TYPE NUMERIC(12,1), ALTER COLUMN kcal_high TYPE NUMERIC(12,1),
  ALTER COLUMN protein_best TYPE NUMERIC(12,1), ALTER COLUMN protein_low TYPE NUMERIC(12,1), ALTER COLUMN protein_high TYPE NUMERIC(12,1),
  ALTER COLUMN carbs_g TYPE NUMERIC(12,1), ALTER COLUMN fat_g TYPE NUMERIC(12,1);
ALTER TABLE daily_summaries
  ALTER COLUMN kcal_in TYPE NUMERIC(14,1), ALTER COLUMN protein_in TYPE NUMERIC(14,1), ALTER COLUMN kcal_out TYPE NUMERIC(14,1);
-- remembered readings copy a saved row's numbers
ALTER TABLE user_readings
  ALTER COLUMN kcal_best TYPE NUMERIC(12,1), ALTER COLUMN kcal_low TYPE NUMERIC(12,1), ALTER COLUMN kcal_high TYPE NUMERIC(12,1),
  ALTER COLUMN protein_best TYPE NUMERIC(12,1), ALTER COLUMN protein_low TYPE NUMERIC(12,1), ALTER COLUMN protein_high TYPE NUMERIC(12,1),
  ALTER COLUMN carbs_g TYPE NUMERIC(12,1), ALTER COLUMN fat_g TYPE NUMERIC(12,1);
