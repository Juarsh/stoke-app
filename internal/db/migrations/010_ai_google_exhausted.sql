-- Google's free-tier daily quota exhausted flag, keyed by the Pacific quota day.
-- Survives process restarts; cleared when the quota day rolls.
CREATE TABLE IF NOT EXISTS ai_google_exhausted (
  quota_day       DATE PRIMARY KEY,
  exhausted_until TIMESTAMPTZ NOT NULL
);
