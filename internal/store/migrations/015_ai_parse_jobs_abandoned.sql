-- The phone gave up on a meal (its 35-minute backstop; the user types the kcal):
-- POST /v1/parse/jobs/{id}/abandon marks the job 'abandoned'. No further AI
-- attempt is made, a result that arrives later is dropped, and an AI reading
-- saved with this job id is refused (job_abandoned). Abandoned rows are kept
-- for 7 days (finished_at = when it was abandoned) so a late save is still refused.
ALTER TABLE ai_parse_jobs DROP CONSTRAINT IF EXISTS ai_parse_jobs_status_check;
ALTER TABLE ai_parse_jobs ADD CONSTRAINT ai_parse_jobs_status_check CHECK (status IN ('pending','done','abandoned'));
CREATE INDEX IF NOT EXISTS ai_parse_jobs_abandoned ON ai_parse_jobs(user_id, id) WHERE status = 'abandoned';
