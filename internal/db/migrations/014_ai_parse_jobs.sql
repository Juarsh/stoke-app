-- Durable AI parse jobs: a meal waiting on the AI survives a restart / sleep.
-- The worker keeps a copy in memory; this row is the source of truth.
-- payload: what the AI call and the failed state need (hint, claimed, spans,
-- fail_claimed, fail_spans, generic). result: the finished ParseResponse.
-- first_try_at starts the AI_REQUEUE_MAX_MINUTES window; lease_until marks an
-- attempt in flight (so a second instance never runs the same attempt).
-- Done rows are deleted an hour after finished_at (the poll TTL).
CREATE TABLE IF NOT EXISTS ai_parse_jobs (
  id              TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  cache_key       TEXT NOT NULL DEFAULT '',
  slot            TEXT NOT NULL DEFAULT '',
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  requeues        INT NOT NULL DEFAULT 0,
  last_busy       TEXT NOT NULL DEFAULT '',
  next_attempt_at TIMESTAMPTZ,
  lease_until     TIMESTAMPTZ,
  first_try_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  result          JSONB
);
CREATE INDEX IF NOT EXISTS ai_parse_jobs_pending ON ai_parse_jobs(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ai_parse_jobs_done ON ai_parse_jobs(finished_at) WHERE status = 'done';
