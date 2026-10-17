package app

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/food"
)

// AI_MAX_ATTEMPTS (default 3): Gemini attempts per meal (parse job). Every
// attempt counts toward AI_DAILY_CAP and logs its ai_calls row; the per-user
// cap counts the meal once. A job whose last attempt brings no answer ends as
// gave_up and never gets another attempt, across restarts and lease recovery.

func fastDelays(t *testing.T, d time.Duration) {
	old := food.RequeueDelays
	food.RequeueDelays = []time.Duration{d}
	t.Cleanup(func() { food.RequeueDelays = old })
}

func userUsed(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	_ = pool.QueryRow(context.Background(), `SELECT COALESCE(SUM(calls),0) FROM ai_usage`).Scan(&n)
	return n
}

func jobAttempts(t *testing.T, pool *pgxpool.Pool, id string) (status string, attempts, requeues int) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), `SELECT status, attempts, requeues FROM ai_parse_jobs WHERE id=$1`, id).
		Scan(&status, &attempts, &requeues); err != nil {
		t.Fatal(err)
	}
	return
}

func assertGaveUp(t *testing.T, j parseOut) {
	t.Helper()
	if j.Status != "done" || j.AIState != "failed" || j.Fallback != "gave_up" || j.FallbackReason != "gave_up" || j.Answer != "none" ||
		j.Message != "Couldn't estimate this. Add the calories yourself." || len(j.FailedSpans) != 1 {
		t.Fatalf("want gave_up: %+v", j)
	}
	for _, it := range j.Items {
		if it.AIEstimate {
			t.Errorf("AI number in a gave_up meal: %+v", it)
		}
	}
}

func parseJob(t *testing.T, srv *httptest.Server, user, text string) string {
	t.Helper()
	var p parseOut
	if c := call(t, srv, "POST", "/v1/parse", user, M{"text": text}, &p); c != 202 || p.JobID == "" {
		t.Fatalf("parse: %d %+v", c, p)
	}
	return p.JobID
}

func same(a []string, b ...string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// 3 timeouts: gave_up after exactly 3 attempts (3 ai_calls rows), 3 units of
// AI_DAILY_CAP, 1 of the user's cap; no 4th attempt ever.
func TestThreeTimeoutsGiveUp(t *testing.T) {
	fastDelays(t, 20*time.Millisecond)
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap, c.UserAICap = testAdmin, 20, 3 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "timeout"}, nil)
	id := parseJob(t, srv, "at1", "2 roti aur 1 plate zorbu")
	j := pollDone(t, srv, "at1", id)
	assertGaveUp(t, j)
	time.Sleep(150 * time.Millisecond) // several requeue delays: nothing more happens
	if n := aiCalls(t, srv); n != 3 {
		t.Errorf("AI attempts: %d, want 3", n)
	}
	if o := mealOutcomes(t, pool, id); !same(o, "requeue:timeout", "requeue:timeout", "requeue:timeout") {
		t.Errorf("ai_calls rows: %v, want 3 timeouts", o)
	}
	if u := quotaUsed(t, srv); u != 3 {
		t.Errorf("AI_DAILY_CAP used=%d, want 3", u)
	}
	if u := userUsed(t, pool); u != 1 {
		t.Errorf("per-user cap used=%d, want 1", u)
	}
	if st, a, _ := jobAttempts(t, pool, id); st != "done" || a != 3 {
		t.Errorf("stored job: %s attempts=%d", st, a)
	}
}

// 2 timeouts then an answer: used, on the 3rd (last) attempt.
func TestTwoTimeoutsThenAnswer(t *testing.T) {
	fastDelays(t, 20*time.Millisecond)
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap, c.UserAICap = testAdmin, 20, 3 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "timeout", "times": 2}, nil)
	id := parseJob(t, srv, "at2", "2 roti aur 1 plate zorbu")
	j := pollDone(t, srv, "at2", id)
	if j.AIState != "answered" || j.Answer != "ai" || j.FallbackReason != "" || len(j.Items) != 2 {
		t.Fatalf("want the answer: %+v", j)
	}
	if o := mealOutcomes(t, pool, id); !same(o, "requeue:timeout", "requeue:timeout", "used") {
		t.Errorf("ai_calls rows: %v", o)
	}
	if u := quotaUsed(t, srv); u != 3 {
		t.Errorf("AI_DAILY_CAP used=%d, want 3", u)
	}
	if u := userUsed(t, pool); u != 1 {
		t.Errorf("per-user cap used=%d, want 1", u)
	}
}

// The attempt count is in the DB: 2 timeouts, the process is killed while the
// job waits for its requeue, the next process makes attempt 3 (timeout) and
// the job gives up. No 4th attempt.
func TestAttemptsSurviveRestart(t *testing.T) {
	fastDelays(t, 400*time.Millisecond)
	srv1, pool, kill := crashableSrv(t)
	call(t, srv1, "POST", "/test/ai/fail", "", M{"mode": "timeout"}, nil)
	id := parseJob(t, srv1, "at3", "2 roti aur 1 plate zorbu")
	for i := 0; ; i++ {
		if _, a, r := jobAttempts(t, pool, id); a == 2 && r == 2 {
			break
		}
		if i > 400 {
			t.Fatal("never got 2 attempts")
		}
		time.Sleep(5 * time.Millisecond)
	}
	var mid map[string]any
	if c := call(t, srv1, "GET", "/v1/parse/jobs/"+id, "at3", nil, &mid); c != 202 || mid["attempts"] != float64(2) || mid["max_attempts"] != float64(3) {
		t.Errorf("pending poll: %d %v", c, mid)
	}
	kill() // kill -9 mid-requeue: the worker is gone, the row stays pending
	srv1.Close()
	if st, a, _ := jobAttempts(t, pool, id); st != "pending" || a != 2 {
		t.Fatalf("stored after kill: %s attempts=%d", st, a)
	}
	srv2 := restartSrv(t, pool)
	call(t, srv2, "POST", "/test/ai/fail", "", M{"mode": "timeout"}, nil) // still timing out in the new process
	assertGaveUp(t, pollDone(t, srv2, "at3", id))
	time.Sleep(500 * time.Millisecond)
	if n := aiCalls(t, srv2); n != 1 {
		t.Errorf("new process made %d AI attempts, want 1 (the 3rd)", n)
	}
	if o := mealOutcomes(t, pool, id); !same(o, "requeue:timeout", "requeue:timeout", "requeue:timeout") {
		t.Errorf("ai_calls rows: %v", o)
	}
	if u := quotaUsed(t, srv2); u != 3 {
		t.Errorf("AI_DAILY_CAP used=%d, want 3", u)
	}
	if u := userUsed(t, pool); u != 1 {
		t.Errorf("per-user cap used=%d, want 1", u)
	}
	srv3 := restartSrv(t, pool) // and a further restart does nothing
	time.Sleep(100 * time.Millisecond)
	if n := aiCalls(t, srv3); n != 0 {
		t.Errorf("a gave_up job was tried again: %d", n)
	}
}

// Lease recovery: the process dies DURING attempt 3 (claimed, lease taken,
// no answer stored). The next process finds the lease expired: the job has
// no attempt left, so it ends as gave_up with no AI call and nothing given back.
func TestLastAttemptDiedNoFourth(t *testing.T) {
	fastDelays(t, time.Hour)
	srv1, pool, kill := crashableSrv(t)
	call(t, srv1, "POST", "/test/ai/fail", "", M{"mode": "timeout"}, nil)
	id := parseJob(t, srv1, "at4", "2 roti aur 1 plate zorbu")
	for i := 0; ; i++ {
		if _, a, r := jobAttempts(t, pool, id); a == 1 && r == 1 {
			break
		}
		if i > 400 {
			t.Fatal("never requeued")
		}
		time.Sleep(5 * time.Millisecond)
	}
	kill()
	srv1.Close()
	before := quotaUsed(t, restartSrvNoWorker(t, pool))
	// what claimJob leaves when attempts 2 and 3 were claimed and the process died in attempt 3
	if _, err := pool.Exec(context.Background(), `UPDATE ai_parse_jobs SET attempts=3, requeues=2, next_attempt_at=now()-interval '1 minute',
		lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	srv2 := restartSrv(t, pool) // Gemini would answer now
	assertGaveUp(t, pollDone(t, srv2, "at4", id))
	time.Sleep(100 * time.Millisecond)
	if n := aiCalls(t, srv2); n != 0 {
		t.Errorf("a 4th attempt was made: %d calls", n)
	}
	if u := quotaUsed(t, srv2); u != before {
		t.Errorf("AI_DAILY_CAP used %d -> %d: a tried job gives nothing back and is not charged again", before, u)
	}
	if u := userUsed(t, pool); u != 1 {
		t.Errorf("per-user cap used=%d, want 1", u)
	}
	// the same with the lease still live at the restart: it waits for the lease, then gives up, still no call
	id2 := parseJob(t, srv2, "at4", "1 plate qorbu")
	_ = pollDone(t, srv2, "at4", id2) // answered on attempt 1 (Gemini answers)
	if _, err := pool.Exec(context.Background(), `UPDATE ai_parse_jobs SET status='pending', result=NULL, finished_at=NULL, attempts=3, requeues=2,
		next_attempt_at=now(), lease_until=now()+interval '300 milliseconds' WHERE id=$1`, id2); err != nil {
		t.Fatal(err)
	}
	calls := aiCalls(t, srv2)
	srv3 := restartSrv(t, pool)
	assertGaveUp(t, pollDone(t, srv3, "at4", id2))
	if n := aiCalls(t, srv3); n != 0 || aiCalls(t, srv2) != calls {
		t.Errorf("a 4th attempt after lease recovery: %d", n)
	}
}

// restartSrvNoWorker: a process to read admin numbers from, whose queue
// worker is already stopped (it never runs a job).
func restartSrvNoWorker(t *testing.T, pool *pgxpool.Pool) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg := Config{DB: pool, Verifier: fakeVerifier{}, AIMode: "stub", AIPerMinute: -1}
	restartCfg(ctx)(&cfg)
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// AI_MAX_ATTEMPTS=1: one attempt, then gave_up (busy, or an error on that last attempt).
func TestMaxAttemptsOne(t *testing.T) {
	fastDelays(t, 20*time.Millisecond)
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap, c.UserAICap, c.AIMaxAttempts = testAdmin, 20, 5, 1 })
	for i, mode := range []string{"timeout", "busy", "unavailable", "error"} {
		call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
		call(t, srv, "POST", "/test/ai/fail", "", M{"mode": mode}, nil)
		id := parseJob(t, srv, "at5", []string{"1 plate zorbu", "1 plate qelto", "1 plate vrumba", "1 plate xantho"}[i])
		assertGaveUp(t, pollDone(t, srv, "at5", id))
		time.Sleep(60 * time.Millisecond)
		if n := aiCalls(t, srv); n != 1 {
			t.Errorf("%s: %d attempts, want 1", mode, n)
		}
		if o := mealOutcomes(t, pool, id); len(o) != 1 {
			t.Errorf("%s: ai_calls rows %v", mode, o)
		}
		if u := quotaUsed(t, srv); u != 1 {
			t.Errorf("%s: AI_DAILY_CAP used=%d, want 1", mode, u)
		}
	}
}

// With the default 3, an error on attempt 1 still ends the meal as error at once
// (as before); a daily cap reached before attempt 3 still ends it as daily_limit.
func TestAttemptCapKeepsErrorAndDailyLimit(t *testing.T) {
	fastDelays(t, 20*time.Millisecond)
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap, c.UserAICap = testAdmin, 2, 5 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "error"}, nil)
	id := parseJob(t, srv, "at6", "1 plate zorbu")
	if j := pollDone(t, srv, "at6", id); j.FallbackReason != "error" || j.AIState != "failed" {
		t.Errorf("error on attempt 1: %+v", j)
	}
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "timeout"}, nil)
	id = parseJob(t, srv, "at6", "1 plate qelto")
	if j := pollDone(t, srv, "at6", id); j.FallbackReason != "daily_limit" || j.AIState != "failed" {
		t.Errorf("AI_DAILY_CAP=2 used up before attempt 3: %+v", j)
	}
	if n := aiCalls(t, srv); n != 2 {
		t.Errorf("attempts: %d, want 2", n)
	}
	if o := mealOutcomes(t, pool, id); !same(o, "requeue:timeout", "requeue:timeout") {
		t.Errorf("ai_calls rows: %v", o)
	}
	if u := quotaUsed(t, srv); u != 2 {
		t.Errorf("AI_DAILY_CAP used=%d, want 2", u)
	}
}
