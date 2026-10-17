package app

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/food"
)

// restartCfg: the AI settings every process in these tests shares.
func restartCfg(ctx context.Context) func(*Config) {
	return func(c *Config) { c.AdminToken, c.GlobalAICap, c.QueueCtx = testAdmin, 20, ctx }
}

// restartSrv starts a NEW process (Service + Queue) on the same database,
// without wiping it: what Render does after a sleep or a crash.
func restartSrv(t *testing.T, pool *pgxpool.Pool) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cfg := Config{DB: pool, Verifier: fakeVerifier{}, AIMode: "stub", AIPerMinute: -1}
	restartCfg(ctx)(&cfg)
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(func() { cancel(); srv.Close() })
	return srv
}

// crashableSrv: a first process whose queue worker the test can kill.
func crashableSrv(t *testing.T) (*httptest.Server, *pgxpool.Pool, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	srv, pool := setupCfg(t, &fakeAI{}, restartCfg(ctx))
	t.Cleanup(cancel)
	return srv, pool, cancel
}

func pollDone(t *testing.T, srv *httptest.Server, user, id string) parseOut {
	t.Helper()
	for i := 0; i < 400; i++ {
		var j parseOut
		c := call(t, srv, "GET", "/v1/parse/jobs/"+id, user, nil, &j)
		if c == 200 {
			return j
		}
		if c != 202 {
			t.Fatalf("job poll: %d %+v", c, j)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job never finished")
	return parseOut{}
}

func waitRequeued(t *testing.T, srv *httptest.Server, user, id string) parseOut {
	t.Helper()
	var j parseOut
	for i := 0; i < 200 && j.Requeues == 0; i++ {
		time.Sleep(5 * time.Millisecond)
		if c := call(t, srv, "GET", "/v1/parse/jobs/"+id, user, nil, &j); c != 202 {
			t.Fatalf("busy job ended: %d %+v", c, j)
		}
	}
	if j.Requeues != 1 || j.BusyReason != "rate_limited" {
		t.Fatalf("not requeued: %+v", j)
	}
	return j
}

func mealOutcomes(t *testing.T, pool *pgxpool.Pool, meal string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT outcome FROM ai_calls WHERE meal_id=$1 ORDER BY id`, meal)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var o string
		_ = rows.Scan(&o)
		out = append(out, o)
	}
	return out
}

func quotaUsed(t *testing.T, srv *httptest.Server) int64 {
	t.Helper()
	var q quotaOut
	if c := admin(t, srv, "GET", "/admin/ai-quota", testAdmin, nil, &q); c != 200 {
		t.Fatalf("admin quota: %d", c)
	}
	return q.Used
}

// (a) A meal requeued (Gemini busy) when the process dies is still in the
// DB; the next process resumes it at its next_attempt_at and the answer
// fills the SAME job id. Polling works across the restart (user-scoped),
// quota and ai_calls are what one process would have recorded, and the
// finished job is still pollable from a third process until its TTL.
func TestJobResumesAfterRestart(t *testing.T) {
	d := food.RequeueDelays
	food.RequeueDelays = []time.Duration{400 * time.Millisecond}
	t.Cleanup(func() { food.RequeueDelays = d })
	srv1, pool, kill := crashableSrv(t)
	call(t, srv1, "POST", "/test/ai/fail", "", M{"mode": "busy"}, nil)
	var p parseOut
	if c := call(t, srv1, "POST", "/v1/parse", "rs1", M{"text": "2 roti aur 1 plate zorbu"}, &p); c != 202 || p.JobID == "" {
		t.Fatalf("parse: %d %+v", c, p)
	}
	waitRequeued(t, srv1, "rs1", p.JobID)
	kill() // the process sleeps / dies between attempts
	srv1.Close()
	var status string
	var requeues int
	var first *time.Time
	if err := pool.QueryRow(context.Background(), `SELECT status, requeues, first_try_at FROM ai_parse_jobs WHERE id=$1`, p.JobID).
		Scan(&status, &requeues, &first); err != nil || status != "pending" || requeues != 1 || first == nil {
		t.Fatalf("stored job: %v %s %d %v", err, status, requeues, first)
	}

	srv2 := restartSrv(t, pool) // Gemini answers again in the new process
	var mid parseOut
	if c := call(t, srv2, "GET", "/v1/parse/jobs/"+p.JobID, "rs1", nil, &mid); c != 202 && c != 200 {
		t.Fatalf("poll right after restart: %d %+v", c, mid)
	}
	if c := call(t, srv2, "GET", "/v1/parse/jobs/"+p.JobID, "someone-else", nil, nil); c != 404 {
		t.Errorf("another user's job: %d, want 404", c)
	}
	j := pollDone(t, srv2, "rs1", p.JobID)
	if j.JobID != p.JobID || j.Status != "done" || j.AIState != "answered" || j.Answer != "ai" || j.FallbackReason != "" || len(j.Items) != 2 {
		t.Fatalf("resumed answer: %+v", j)
	}
	for _, it := range j.Items {
		if it.Kcal.Best <= 0 {
			t.Errorf("zero estimate: %+v", it)
		}
	}
	if n := aiCalls(t, srv2); n != 1 {
		t.Errorf("new process made %d AI calls, want 1", n)
	}
	// same as without a restart: reservation + the later attempt that reached Gemini
	if u := quotaUsed(t, srv2); u != 2 {
		t.Errorf("quota used=%d, want 2", u)
	}
	if o := mealOutcomes(t, pool, p.JobID); len(o) != 2 || o[0] != "requeue:rate_limited" || o[1] != "used" {
		t.Errorf("ai_calls for the meal: %v", o)
	}

	srv3 := restartSrv(t, pool) // the finished job survives another restart
	if again := pollDone(t, srv3, "rs1", p.JobID); again.AIState != "answered" || len(again.Items) != 2 || again.Items[0].Kcal.Best != j.Items[0].Kcal.Best {
		t.Errorf("finished job after restart: %+v", again)
	}
	if c := call(t, srv3, "GET", "/v1/parse/jobs/"+p.JobID, "someone-else", nil, nil); c != 404 {
		t.Errorf("another user's finished job: %d, want 404", c)
	}
	if aiCalls(t, srv3) != 0 {
		t.Errorf("a finished job was run again")
	}
	_, _ = pool.Exec(context.Background(), `UPDATE ai_parse_jobs SET finished_at=now()-interval '61 minutes' WHERE id=$1`, p.JobID)
	if c := call(t, srv3, "GET", "/v1/parse/jobs/"+p.JobID, "rs1", nil, nil); c != 404 {
		t.Errorf("job past its 1 h TTL: %d, want 404", c)
	}
}

// (b) A job whose AI_REQUEUE_MAX window ran out while the process was
// asleep ends as gave_up on the next start, with no AI call, in the same
// failed shape as a live give-up: table dishes stay, the unknown words are
// failed_spans with no kcal. The tried meal keeps its charge.
func TestJobPastWindowGivesUpAfterRestart(t *testing.T) {
	d := food.RequeueDelays
	food.RequeueDelays = []time.Duration{time.Hour}
	t.Cleanup(func() { food.RequeueDelays = d })
	srv1, pool, kill := crashableSrv(t)
	call(t, srv1, "POST", "/test/ai/fail", "", M{"mode": "busy"}, nil)
	var p parseOut
	if c := call(t, srv1, "POST", "/v1/parse", "gu1", M{"text": "2 roti aur 1 plate zorbu"}, &p); c != 202 {
		t.Fatalf("parse: %d %+v", c, p)
	}
	waitRequeued(t, srv1, "gu1", p.JobID)
	kill()
	srv1.Close()
	// asleep for an hour, past the 30 min window
	if _, err := pool.Exec(context.Background(), `UPDATE ai_parse_jobs SET created_at=created_at-interval '1 hour',
		first_try_at=first_try_at-interval '1 hour', next_attempt_at=next_attempt_at-interval '1 hour' WHERE id=$1`, p.JobID); err != nil {
		t.Fatal(err)
	}

	srv2 := restartSrv(t, pool)
	j := pollDone(t, srv2, "gu1", p.JobID)
	if j.JobID != p.JobID || j.AIState != "failed" || j.Status != "done" || j.Fallback != "gave_up" || j.FallbackReason != "gave_up" ||
		j.Answer != "none" || j.Message != "Couldn't estimate this. Add the calories yourself." || !j.NeedsConfirmation {
		t.Fatalf("gave_up after restart: %+v", j)
	}
	if len(j.FailedSpans) != 1 || len(j.CustomItems) != 1 || len(j.Items) != 1 || j.Items[0].DishID != "roti" {
		t.Errorf("failed shape (roti kept, zorbu open): %+v", j)
	}
	for _, it := range j.Items {
		if it.AIEstimate {
			t.Errorf("AI number in a gave_up meal: %+v", it)
		}
	}
	if n := aiCalls(t, srv2); n != 0 {
		t.Errorf("gave up job called the AI %d times", n)
	}
	if o := mealOutcomes(t, pool, p.JobID); len(o) != 1 || o[0] != "requeue:rate_limited" {
		t.Errorf("ai_calls for the meal: %v (give-up writes no row)", o)
	}
	if u := quotaUsed(t, srv2); u != 1 {
		t.Errorf("quota used=%d, want 1 (the tried meal keeps its reservation)", u)
	}
	if c := call(t, srv2, "GET", "/v1/parse/jobs/"+p.JobID, "someone-else", nil, nil); c != 404 {
		t.Errorf("another user's job: %d, want 404", c)
	}
}

// A meal queued but never tried before the process died: a fresh one is
// resumed and answered (its reservation covers that first attempt); one
// that waited past the window gives up and its reserved call is given back.
func TestUntriedJobsAfterRestart(t *testing.T) {
	dead, cancel := context.WithCancel(context.Background())
	cancel() // the worker never runs: jobs are stored but never tried
	srv1, pool := setupCfg(t, &fakeAI{}, restartCfg(dead))
	var fresh, stale parseOut
	if c := call(t, srv1, "POST", "/v1/parse", "un1", M{"text": "1 plate zorbu"}, &fresh); c != 202 {
		t.Fatalf("parse: %d", c)
	}
	if c := call(t, srv1, "POST", "/v1/parse", "un2", M{"text": "1 plate glorbu"}, &stale); c != 202 {
		t.Fatalf("parse: %d", c)
	}
	if u := quotaUsed(t, srv1); u != 2 {
		t.Fatalf("reserved=%d, want 2", u)
	}
	srv1.Close()
	_, _ = pool.Exec(context.Background(), `UPDATE ai_parse_jobs SET created_at=created_at-interval '40 minutes' WHERE id=$1`, stale.JobID)

	srv2 := restartSrv(t, pool)
	if j := pollDone(t, srv2, "un2", stale.JobID); j.FallbackReason != "gave_up" || j.AIState != "failed" || len(j.FailedSpans) != 1 {
		t.Errorf("stale untried job: %+v", j)
	}
	if j := pollDone(t, srv2, "un1", fresh.JobID); j.AIState != "answered" || len(j.Items) != 1 {
		t.Errorf("fresh untried job: %+v", j)
	}
	if n := aiCalls(t, srv2); n != 1 {
		t.Errorf("AI calls %d, want 1 (only the fresh job)", n)
	}
	if u := quotaUsed(t, srv2); u != 1 {
		t.Errorf("quota used=%d, want 1 (stale reservation given back, fresh not charged twice)", u)
	}
}

// Two processes resuming the same pending job (an overlapping deploy) make
// ONE attempt between them: the attempt's lease in ai_parse_jobs decides.
func TestResumedJobRunsOnceAcrossInstances(t *testing.T) {
	dead, cancel := context.WithCancel(context.Background())
	cancel()
	srv1, pool := setupCfg(t, &fakeAI{}, restartCfg(dead))
	var p parseOut
	if c := call(t, srv1, "POST", "/v1/parse", "two1", M{"text": "1 plate zorbu"}, &p); c != 202 {
		t.Fatalf("parse: %d", c)
	}
	srv1.Close()
	a, b := restartSrv(t, pool), restartSrv(t, pool)
	if j := pollDone(t, a, "two1", p.JobID); j.AIState != "answered" {
		t.Fatalf("job: %+v", j)
	}
	if jb := pollDone(t, b, "two1", p.JobID); jb.AIState != "answered" {
		t.Errorf("other instance's poll: %+v", jb)
	}
	time.Sleep(50 * time.Millisecond)
	if n := aiCalls(t, a) + aiCalls(t, b); n != 1 {
		t.Errorf("AI calls across both instances: %d, want 1", n)
	}
	if o := mealOutcomes(t, pool, p.JobID); len(o) != 1 {
		t.Errorf("ai_calls rows: %v", o)
	}
	if u := quotaUsed(t, a); u != 1 {
		t.Errorf("quota used=%d, want 1", u)
	}
}
