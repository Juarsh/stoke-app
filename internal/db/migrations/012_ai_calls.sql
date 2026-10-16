-- One row per AI estimate attempt (queue worker), for "AI calls per user per day"
-- metrics. created_at is a real instant; bucket by any zone (e.g. IST) at query time.
-- Does not affect the caps (ai_usage / ai_global_usage stay the quota counters).
CREATE TABLE IF NOT EXISTS ai_calls (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model      TEXT NOT NULL DEFAULT '',
  outcome    TEXT NOT NULL,
  sends      INT NOT NULL DEFAULT 0,
  requeue    INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_calls_user_created ON ai_calls(user_id, created_at);
