-- Shared AI cache (keyed on normalized text, no user data), global AI counter,
-- and per-user learned readings ("Remembered foods").
CREATE TABLE IF NOT EXISTS ai_cache (
  norm_text   TEXT PRIMARY KEY,
  items       JSONB NOT NULL,
  hits        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_hit_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_cache_last_hit ON ai_cache(last_hit_at);

CREATE TABLE IF NOT EXISTS ai_global_usage (
  local_date DATE PRIMARY KEY,
  calls      INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_readings (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  norm_span    TEXT NOT NULL,
  dish_id      TEXT,
  custom_name  TEXT NOT NULL DEFAULT '',
  qty          NUMERIC(8,2) NOT NULL,
  unit         TEXT NOT NULL,
  oil_level    TEXT NOT NULL DEFAULT '',
  kcal_best    NUMERIC(8,1) NOT NULL,
  kcal_low     NUMERIC(8,1) NOT NULL,
  kcal_high    NUMERIC(8,1) NOT NULL,
  protein_best NUMERIC(7,1) NOT NULL,
  protein_low  NUMERIC(7,1) NOT NULL,
  protein_high NUMERIC(7,1) NOT NULL,
  carbs_g      NUMERIC(7,1) NOT NULL DEFAULT 0,
  fat_g        NUMERIC(7,1) NOT NULL DEFAULT 0,
  uses         INT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, norm_span)
);
