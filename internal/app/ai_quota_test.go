package app

import (
	"context"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/food"
)

type quotaOut struct {
	DailyCap       int64  `json:"daily_cap"`
	Used           int64  `json:"used"`
	Remaining      *int64 `json:"remaining"`
	UserDailyCap   int64  `json:"user_daily_cap"`
	Exhausted      bool   `json:"exhausted"`
	ExhaustedUntil string `json:"exhausted_until"`
	ResetsAt       string `json:"resets_at"`
	ResetZone      string `json:"reset_zone"`
}

// Still busy (rate_limited / timeout) after the client's retries: the job
// stays pending with ai_state estimating and goes back into the queue; the
// late answer fills the SAME job. The queue reservation covers the first
// attempt; the late answer that reaches Gemini is charged one more unit.
func TestAIBusyRequeuedThenLateAnswer(t *testing.T) {
	d := food.RequeueDelays
	food.RequeueDelays = []time.Duration{150 * time.Millisecond}
	t.Cleanup(func() { food.RequeueDelays = d })
	srv, _ := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap = testAdmin, 20 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "busy"}, nil)
	var p parseOut
	if c := call(t, srv, "POST", "/v1/parse", "busy1", M{"text": "2 roti aur 1 plate zorbu"}, &p); c != 202 || p.AIState != "estimating" {
		t.Fatalf("parse: %d %+v", c, p)
	}
	var j parseOut
	for i := 0; i < 100 && j.Requeues == 0; i++ {
		time.Sleep(5 * time.Millisecond)
		if c := call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "busy1", nil, &j); c != 202 {
			t.Fatalf("busy job ended: %d %+v", c, j)
		}
	}
	if j.Status != "pending" || j.AIState != "estimating" || j.Requeues != 1 || j.BusyReason != "rate_limited" || j.NextAttempt == "" {
		t.Fatalf("busy job: %+v", j)
	}
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": ""}, nil) // Gemini answers again
	for i := 0; i < 200; i++ {
		j = parseOut{}
		if c := call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "busy1", nil, &j); c == 200 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if j.JobID != p.JobID || j.AIState != "answered" || j.Answer != "ai" || j.FallbackReason != "" || len(j.Items) != 2 {
		t.Fatalf("late answer: %+v", j)
	}
	for _, it := range j.Items {
		if it.Kcal.Best <= 0 {
			t.Errorf("zero estimate: %+v", it)
		}
	}
	var q quotaOut
	if c := admin(t, srv, "GET", "/admin/ai-quota", testAdmin, nil, &q); c != 200 || q.Used != 2 || q.Remaining == nil || *q.Remaining != 18 {
		t.Errorf("want used=2 (queue + late answer that reached Gemini): %d %+v", c, q)
	}
	if n := aiCalls(t, srv); n != 2 {
		t.Errorf("stub calls %d, want 2 (busy + late answer)", n)
	}
}

// A 429 naming the daily quota marks the project exhausted until Google's
// reset: no more calls, fallback daily_limit with ai_resets_at.
func TestAIDailyQuotaExhausted(t *testing.T) {
	srv, _ := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap = testAdmin, 20 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "daily_limit"}, nil)
	_, r := parseAI(t, srv, "q1", "1 plate zorbu")
	if r.Fallback != "daily_limit" || r.FallbackReason != "daily_limit" || r.AIState != "failed" || len(r.Items) != 0 || r.AIResetsAt == "" || !r.NeedsConfirmation {
		t.Fatalf("daily quota: %+v", r)
	}
	at, err := time.Parse(time.RFC3339, r.AIResetsAt)
	if err != nil {
		t.Fatal(err)
	}
	if pt := at.In(mustLoc(t, "America/Los_Angeles")); pt.Hour() != 0 || pt.Minute() != 0 || time.Until(at) > 25*time.Hour {
		t.Errorf("resets at %v", pt)
	}
	before := aiCalls(t, srv)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": ""}, nil)
	c, r := parseAI(t, srv, "q2", "1 plate glorbu")
	if c != 200 || r.Fallback != "daily_limit" || r.FallbackReason != "daily_limit" || r.AIResetsAt == "" || aiCalls(t, srv) != before {
		t.Errorf("exhausted project still called the AI: %d %+v calls %d->%d", c, r, before, aiCalls(t, srv))
	}
	var q quotaOut
	admin(t, srv, "GET", "/admin/ai-quota", testAdmin, nil, &q)
	if !q.Exhausted || q.Remaining == nil || *q.Remaining != 0 || q.ExhaustedUntil == "" {
		t.Errorf("admin quota: %+v", q)
	}
}

func mustLoc(t *testing.T, n string) *time.Location {
	l, err := time.LoadLocation(n)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// one_tap_ok: only confident table items with nothing to choose.
func TestOneTapOK(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	cases := []struct {
		text, dish string
		want       bool
	}{
		{"2 roti", "roti", true},
		{"1 katori dal", "dal", true},
		{"8 plates momos", "momos", false},        // unit_mismatch
		{"1 plate bhel puri", "bhel_puri", false}, // estimate_unverified
		{"2 rotti", "roti", false},                // did_you_mean
		{"chicken rice", "", false},               // compound_name
	}
	for _, tc := range cases {
		var r parseOut
		call(t, srv, "POST", "/v1/parse", "ot", M{"text": tc.text}, &r)
		for _, it := range r.Items {
			if tc.dish != "" && it.DishID != tc.dish {
				continue
			}
			if it.OneTapOK != tc.want {
				t.Errorf("%q %s: one_tap_ok=%v want %v (%+v)", tc.text, it.DishID, it.OneTapOK, tc.want, it)
			}
			if it.OneTapOK && (it.NeedsConfirmation || it.Source != "table") {
				t.Errorf("%q: one-tap item needs confirmation", tc.text)
			}
		}
	}
	// AI estimates are never one-tap
	_, r := parseAI(t, srv, "ot2", "1 plate zorbu")
	for _, it := range r.Items {
		if it.AIEstimate && it.OneTapOK {
			t.Errorf("ai estimate one-tap: %+v", it)
		}
	}
}

// Google's daily-quota exhausted mark is stored in the DB (keyed by the
// Pacific quota day), so a process restart keeps it until the next reset.
func TestAIExhaustedSurvivesRestart(t *testing.T) {
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap = testAdmin, 20 })
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "daily_limit"}, nil)
	_, r := parseAI(t, srv, "ex1", "1 plate zorbu")
	if r.FallbackReason != "daily_limit" {
		t.Fatalf("daily: %+v", r)
	}
	var q quotaOut
	admin(t, srv, "GET", "/admin/ai-quota", testAdmin, nil, &q)
	if !q.Exhausted {
		t.Fatalf("not marked: %+v", q)
	}
	// simulate a restart: a new Quota loads from the same DB
	loc := mustLoc(t, "America/Los_Angeles")
	fresh := &food.Quota{Reset: loc}
	fresh.LoadExhausted(context.Background(), pool, time.Now())
	if ex, until := fresh.Exhausted(time.Now()); !ex || until.IsZero() {
		t.Errorf("exhausted mark lost after restart: ex=%v until=%v", ex, until)
	}
	// after the reset time the mark is gone
	if ex, _ := fresh.Exhausted(time.Now().Add(25 * time.Hour)); ex {
		t.Error("still exhausted a day later")
	}
}

// A later attempt that only gets 429s (busy) is NOT charged; an unavailable
// (503) requeue attempt that reaches Gemini IS charged.
func TestAIRequeueChargesNon429Only(t *testing.T) {
	d := food.RequeueDelays
	food.RequeueDelays = []time.Duration{30 * time.Millisecond}
	t.Cleanup(func() { food.RequeueDelays = d })
	srv, _ := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap = testAdmin, 20 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "busy"}, nil)
	var p parseOut
	if c := call(t, srv, "POST", "/v1/parse", "rq1", M{"text": "2 plate zorbu"}, &p); c != 202 {
		t.Fatalf("parse: %d", c)
	}
	// wait for one requeue of busy, then clear so the next try succeeds
	for i := 0; i < 100; i++ {
		var j parseOut
		call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "rq1", nil, &j)
		if j.Requeues >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	var q quotaOut
	admin(t, srv, "GET", "/admin/ai-quota", testAdmin, nil, &q)
	if q.Used != 1 {
		t.Errorf("busy requeues must not charge: used=%d", q.Used)
	}
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": ""}, nil)
	for i := 0; i < 200; i++ {
		var j parseOut
		if c := call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "rq1", nil, &j); c == 200 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	admin(t, srv, "GET", "/admin/ai-quota", testAdmin, nil, &q)
	if q.Used != 2 {
		t.Errorf("late answer must charge one more: used=%d", q.Used)
	}
}
