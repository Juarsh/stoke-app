package app

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/food"
)

// F2 (CEO): every AI attempt is charged to AI_DAILY_CAP and logged in ai_calls
// BEFORE its Gemini send, then the row gets the outcome. A process killed
// mid-call leaves a charged "in_flight" attempt, never an uncounted one. The
// cap check and the charge are one atomic step.

func waitOutcomes(t *testing.T, get func() []string, want ...string) {
	t.Helper()
	for i := 0; i < 600; i++ {
		if same(get(), want...) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("ai_calls rows: %v, want %v", get(), want)
}

// Killed during the FIRST attempt (charged when the meal was queued): the row is
// "in_flight" and the unit is spent. The next process's attempt is charged again
// before it sends and marks the dead one "died".
func TestCrashMidFirstCallCharged(t *testing.T) {
	srv1, pool, kill := crashableSrv(t)
	call(t, srv1, "POST", "/test/ai/fail", "", M{"mode": "hang"}, nil)
	id := parseJob(t, srv1, "ch1", "2 roti aur 1 plate zorbu")
	rows := func() []string { return mealOutcomes(t, pool, id) }
	waitOutcomes(t, rows, "in_flight")
	if u := quotaUsed(t, srv1); u != 1 {
		t.Errorf("AI_DAILY_CAP used=%d mid-call, want 1", u)
	}
	kill() // kill -9 mid-call: the send is out, no answer, nothing after it runs
	srv1.Close()
	time.Sleep(100 * time.Millisecond)
	if o := rows(); !same(o, "in_flight") {
		t.Fatalf("after the kill: %v (the attempt must stay logged)", o)
	}
	if st, a, _ := jobAttempts(t, pool, id); st != "pending" || a != 1 {
		t.Fatalf("job after kill: %s attempts=%d", st, a)
	}
	// the dead process's lease runs out
	if _, err := pool.Exec(context.Background(), `UPDATE ai_parse_jobs SET lease_until=now()-interval '1 second', next_attempt_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	srv2 := restartSrv(t, pool)
	if u := quotaUsed(t, srv2); u != 1 {
		t.Errorf("AI_DAILY_CAP used=%d after the kill, want 1 (the dead attempt stays charged)", u)
	}
	j := pollDone(t, srv2, "ch1", id)
	if j.AIState != "answered" {
		t.Fatalf("attempt 2: %+v", j)
	}
	if o := rows(); !same(o, "died", "used") {
		t.Errorf("ai_calls rows: %v, want died, used", o)
	}
	if u := quotaUsed(t, srv2); u != 2 {
		t.Errorf("AI_DAILY_CAP used=%d, want 2 (both attempts)", u)
	}
	if u := userUsed(t, pool); u != 1 {
		t.Errorf("per-user cap used=%d, want 1 (once per meal)", u)
	}
}

// Killed during a LATER attempt: it was charged before the send (used=2 while
// it is in flight; before F2 this was 1, and the kill made it uncounted).
func TestCrashMidLaterCallCharged(t *testing.T) {
	fastDelays(t, 300*time.Millisecond)
	srv1, pool, kill := crashableSrv(t)
	call(t, srv1, "POST", "/test/ai/fail", "", M{"mode": "timeout", "times": 1}, nil)
	id := parseJob(t, srv1, "ch2", "2 roti aur 1 plate zorbu")
	rows := func() []string { return mealOutcomes(t, pool, id) }
	waitOutcomes(t, rows, "requeue:timeout")
	call(t, srv1, "POST", "/test/ai/fail", "", M{"mode": "hang"}, nil)
	waitOutcomes(t, rows, "requeue:timeout", "in_flight")
	if u := quotaUsed(t, srv1); u != 2 {
		t.Errorf("AI_DAILY_CAP used=%d while attempt 2 is in flight, want 2 (charged before the send)", u)
	}
	kill()
	srv1.Close()
	time.Sleep(100 * time.Millisecond)
	if o := rows(); !same(o, "requeue:timeout", "in_flight") {
		t.Errorf("after the kill: %v", o)
	}
	srv2 := restartSrvNoWorker(t, pool)
	if u := quotaUsed(t, srv2); u != 2 {
		t.Errorf("AI_DAILY_CAP used=%d after the kill, want 2", u)
	}
	if u := userUsed(t, pool); u != 1 {
		t.Errorf("per-user cap used=%d, want 1", u)
	}
}

// The cap reached blocks the next send: no Gemini call, no ai_calls row, the
// meal ends as daily_limit, the counter never goes past the cap.
func TestCapReachedBlocksNextSend(t *testing.T) {
	fastDelays(t, 200*time.Millisecond)
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap, c.UserAICap = testAdmin, 20, 5 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "timeout"}, nil)
	id := parseJob(t, srv, "ch3", "1 plate zorbu")
	waitOutcomes(t, func() []string { return mealOutcomes(t, pool, id) }, "requeue:timeout")
	call(t, srv, "POST", "/test/ai/daily-cap", "", M{"cap": 1}, nil) // used 1 of 1 now
	j := pollDone(t, srv, "ch3", id)
	if j.FallbackReason != "daily_limit" || j.AIState != "failed" {
		t.Fatalf("want daily_limit: %+v", j)
	}
	if n := aiCalls(t, srv); n != 1 {
		t.Errorf("Gemini sends: %d, want 1 (the cap blocks attempt 2)", n)
	}
	if o := mealOutcomes(t, pool, id); !same(o, "requeue:timeout") {
		t.Errorf("ai_calls rows: %v", o)
	}
	if u := quotaUsed(t, srv); u != 1 {
		t.Errorf("AI_DAILY_CAP used=%d, want 1", u)
	}
}

// At cap-1, many concurrent later attempts: exactly one is charged and logged,
// the others are refused; the counter ends at the cap, never above. Also the
// queue-time reservation: N+k concurrent meals at cap N -> exactly N queued.
func TestCapBoundaryConcurrent(t *testing.T) {
	_, pool := setupCfg(t, &fakeAI{}, nil)
	svc := &food.Service{DB: pool, Quota: &food.Quota{}, Fallback: &food.Stub{}}
	ctx := context.Background()
	for round := 0; round < 20; round++ {
		if _, err := pool.Exec(ctx, `DELETE FROM ai_global_usage; DELETE FROM ai_calls`); err != nil {
			t.Fatal(err)
		}
		const capN = 5
		svc.GlobalCap.Store(capN)
		for i := 0; i < capN-1; i++ { // cap-1 used
			if _, ok := svc.StartAttemptForTest(ctx, 1, fmt.Sprintf("pre-%d", i), true); !ok {
				t.Fatal("refused below the cap")
			}
		}
		var wg sync.WaitGroup
		var mu sync.Mutex
		passed := 0
		start := make(chan struct{})
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				if _, ok := svc.StartAttemptForTest(ctx, int64(100+i), fmt.Sprintf("race-%d", i), true); ok {
					mu.Lock()
					passed++
					mu.Unlock()
				}
			}(i)
		}
		close(start)
		wg.Wait()
		var used, logged int
		_ = pool.QueryRow(ctx, `SELECT COALESCE(SUM(calls),0) FROM ai_global_usage`).Scan(&used)
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM ai_calls WHERE meal_id LIKE 'race-%'`).Scan(&logged)
		if passed != 1 || used != capN || logged != 1 {
			t.Fatalf("round %d: %d attempts passed at cap-1 (want 1), used=%d (want %d), in_flight rows=%d (want 1)", round, passed, used, capN, logged)
		}
	}
}

// The meal reservation (per-user + shared, one transaction) at the boundary:
// 12 users race for a shared cap of 4 -> exactly 4 meals queued, the rest
// daily_limit, and a refused meal costs its user nothing.
func TestReserveConcurrentAtCap(t *testing.T) {
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap, c.UserAICap = testAdmin, 4, 3 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "hang"}, nil) // keep them in flight: no answers needed
	var wg sync.WaitGroup
	var mu sync.Mutex
	queued, limited := 0, 0
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var p parseOut
			c := call(t, srv, "POST", "/v1/parse", fmt.Sprintf("rc%d", i), M{"text": fmt.Sprintf("1 plate zorbu%c", 'a'+i)}, &p)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case c == 202 && p.JobID != "":
				queued++
			case p.FallbackReason == "daily_limit":
				limited++
			default:
				t.Errorf("parse %d: %d %+v", i, c, p)
			}
		}(i)
	}
	wg.Wait()
	if queued != 4 || limited != 8 {
		t.Errorf("queued=%d limited=%d, want 4 / 8", queued, limited)
	}
	if u := quotaUsed(t, srv); u != 4 {
		t.Errorf("AI_DAILY_CAP used=%d, want 4", u)
	}
	if u := userUsed(t, pool); u != 4 {
		t.Errorf("per-user units used=%d, want 4 (a refused meal costs its user nothing)", u)
	}
}
