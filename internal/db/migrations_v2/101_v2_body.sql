-- V2 (NOT applied by default; set MIGRATE_V2=1 once V2 is built).
-- Workouts reuse activity_entries (kind='workout'); water goes in body_entries (kind='water').
CREATE TABLE IF NOT EXISTS body_entries (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date  DATE NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('weight','waist','chest','arm','hip','water')),
  value       NUMERIC(8,2) NOT NULL CHECK (value > 0),
  unit        TEXT NOT NULL CHECK (unit IN ('kg','cm','ml')),
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS body_entries_user_day ON body_entries(user_id, local_date) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS progress_photos (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date  DATE NOT NULL,
  device_uri  TEXT NOT NULL,
  cloud_url   TEXT,
  source      TEXT NOT NULL DEFAULT 'device',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(5,1);
ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS workout_min INT NOT NULL DEFAULT 0;
