-- AI_MAX_ATTEMPTS (default 3): Gemini attempts per meal (parse job). attempts
-- is counted when an attempt is claimed (lease taken), before the call, so an
-- attempt that dies with its process (kill -9, lease recovery) still counts and
-- a job never gets more than AI_MAX_ATTEMPTS attempts across restarts.
-- Pending rows from before: every requeue was a finished attempt.
ALTER TABLE ai_parse_jobs ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
UPDATE ai_parse_jobs SET attempts = requeues WHERE status = 'pending' AND attempts < requeues;
