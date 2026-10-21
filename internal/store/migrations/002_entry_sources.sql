-- Parse-response sources (table | did_you_mean | generic | ai_estimate) plus custom.
ALTER TABLE food_entries DROP CONSTRAINT IF EXISTS food_entries_source_check;
ALTER TABLE food_entries ADD CONSTRAINT food_entries_source_check
  CHECK (source IN ('table','did_you_mean','generic','ai_estimate','custom','barcode','photo','ai','manual'));
