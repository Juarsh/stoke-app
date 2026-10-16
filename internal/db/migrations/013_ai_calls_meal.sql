-- meal_id: the parse job (one meal's text) the AI attempt belongs to. AI runs
-- once per meal over all its open spans, never per item, so there is no item id.
-- Requeued attempts of the same meal share meal_id.
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS meal_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS ai_calls_user_meal ON ai_calls(user_id, meal_id);
