package app

import (
	"context"

	"github.com/akarsh/calorie-tracker/internal/food"
	"testing"
	"time"
)

// Every AI attempt is stored in ai_calls with the user id, a timestamp,
// the model and the outcome (for AI-calls-per-user-per-day metrics).
func TestAICallsLogged(t *testing.T) {
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap = testAdmin, 20 })
	before := time.Now().Add(-time.Minute)
	if _, r := parseAI(t, srv, "log1", "1 plate zorbu"); r.Answer != "ai" {
		t.Fatalf("ok parse: %+v", r)
	}
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "daily_limit"}, nil)
	if _, r := parseAI(t, srv, "log2", "1 plate zorbali"); r.FallbackReason != "daily_limit" {
		t.Fatalf("daily parse: %+v", r)
	}
	ctx := context.Background()
	type row struct {
		user    int64
		at      time.Time
		outcome string
	}
	var rows []row
	var r row
	for i := 0; i < 100; i++ { // the insert runs as the job finishes
		rows = rows[:0]
		rs, err := pool.Query(ctx, `SELECT user_id, created_at, outcome FROM ai_calls ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		for rs.Next() {
			if err := rs.Scan(&r.user, &r.at, &r.outcome); err != nil {
				t.Fatal(err)
			}
			rows = append(rows, r)
		}
		rs.Close()
		if len(rows) >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 ai_calls rows, got %+v", rows)
	}
	if rows[0].outcome != "used" || rows[1].outcome != "daily_limit" {
		t.Errorf("outcomes: %+v", rows)
	}
	if rows[0].user == 0 || rows[1].user == 0 || rows[0].user == rows[1].user {
		t.Errorf("user ids: %+v", rows)
	}
	for _, x := range rows {
		if x.at.Before(before) || x.at.After(time.Now().Add(time.Minute)) {
			t.Errorf("timestamp: %+v", x)
		}
	}
}

// A meal requeued several times (Gemini busy) logs one row per attempt, all
// with the same meal_id, so it counts as one distinct meal.
func TestAICallsRequeueSameMeal(t *testing.T) {
	d := food.RequeueDelays
	food.RequeueDelays = []time.Duration{20 * time.Millisecond}
	t.Cleanup(func() { food.RequeueDelays = d })
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap = testAdmin, 20 })
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "busy"}, nil)
	var p parseOut
	if c := call(t, srv, "POST", "/v1/parse", "rqlog", M{"text": "2 plate zorbu"}, &p); c != 202 {
		t.Fatalf("parse: %d", c)
	}
	for i := 0; i < 400; i++ {
		var j parseOut
		call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "rqlog", nil, &j)
		if j.Requeues >= 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": ""}, nil)
	for i := 0; i < 400; i++ {
		var j parseOut
		if c := call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "rqlog", nil, &j); c == 200 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	ctx := context.Background()
	var rows, meals, used int
	var meal string
	for i := 0; i < 100; i++ {
		if err := pool.QueryRow(ctx, `SELECT count(*), count(DISTINCT meal_id), count(*) FILTER (WHERE outcome='used'), max(meal_id) FROM ai_calls`).Scan(&rows, &meals, &used, &meal); err != nil {
			t.Fatal(err)
		}
		if used == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if rows < 3 || meals != 1 || used != 1 || meal != p.JobID {
		t.Fatalf("rows=%d distinct meals=%d used=%d meal=%q job=%q", rows, meals, used, meal, p.JobID)
	}
}
