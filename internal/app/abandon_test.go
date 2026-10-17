package app

import (
	"context"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/food"
)

type listOut struct {
	Entries []struct {
		ClientID *string `json:"client_id"`
		Source   string
		State    string
		KcalBest float64 `json:"kcal_best"`
	}
	Total struct {
		Kcal        float64
		NeedsReview int `json:"needs_review"`
	}
}

// The phone gave up at 35 minutes and the user typed the kcal. The server
// then gets the abandon: no further AI attempt is made (quota saved), a later
// poll says abandoned with no items, a late AI reading saved with the job id
// is refused (POST and PATCH), and the day's totals are the typed kcal only.
func TestAbandonedJobLateResultIgnored(t *testing.T) {
	d := food.RequeueDelays
	food.RequeueDelays = []time.Duration{60 * time.Millisecond}
	t.Cleanup(func() { food.RequeueDelays = d })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv, pool := setupCfg(t, &fakeAI{}, restartCfg(ctx))
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "busy"}, nil)
	var p parseOut
	if c := call(t, srv, "POST", "/v1/parse", "ab1", M{"text": "1 plate zorbu"}, &p); c != 202 || p.JobID == "" {
		t.Fatalf("parse: %d %+v", c, p)
	}
	waitRequeued(t, srv, "ab1", p.JobID)
	day := "2026-10-17"
	// the phone's placeholder (needs_review) and then the user's typed kcal, both tied to the job
	if c := call(t, srv, "POST", "/v1/entries", "ab1", M{"local_date": day, "items": []M{{"custom_name": "zorbu", "source": "custom", "state": "needs_review",
		"client_id": "p1", "parse_job_id": p.JobID}}}, nil); c != 201 {
		t.Fatalf("placeholder: %d", c)
	}
	if c := call(t, srv, "POST", "/v1/parse/jobs/"+p.JobID+"/abandon", "someone-else", nil, nil); c != 404 {
		t.Errorf("another user's abandon: %d, want 404", c)
	}
	var ab struct{ Status string }
	if c := call(t, srv, "POST", "/v1/parse/jobs/"+p.JobID+"/abandon", "ab1", nil, &ab); c != 200 || ab.Status != "abandoned" {
		t.Fatalf("abandon: %d %+v", c, ab)
	}
	if c := call(t, srv, "POST", "/v1/parse/jobs/"+p.JobID+"/abandon", "ab1", nil, nil); c != 200 {
		t.Errorf("abandon is idempotent: %d", c)
	}
	if c := call(t, srv, "POST", "/v1/parse/jobs/nope/abandon", "ab1", nil, nil); c != 404 {
		t.Errorf("unknown job: %d", c)
	}
	if c := call(t, srv, "PATCH", "/v1/entries/p1", "ab1", M{"state": "confirmed", "kcal": 300, "protein_g": 0, "custom_name": "zorbu"}, nil); c != 200 {
		t.Fatalf("typed kcal: %d", c)
	}
	callsAtAbandon, usedAtAbandon := aiCalls(t, srv), quotaUsed(t, srv)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": ""}, nil) // the AI would answer now
	time.Sleep(400 * time.Millisecond)                            // several requeue delays
	if n := aiCalls(t, srv); n != callsAtAbandon {
		t.Errorf("AI attempts after abandon: %d -> %d", callsAtAbandon, n)
	}
	if u := quotaUsed(t, srv); u != usedAtAbandon {
		t.Errorf("quota after abandon: %d -> %d", usedAtAbandon, u)
	}
	var raw map[string]any
	if c := call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "ab1", nil, &raw); c != 200 || raw["status"] != "abandoned" || raw["ai_state"] != "failed" ||
		raw["fallback_reason"] != "abandoned" || len(raw["items"].([]any)) != 0 {
		t.Fatalf("poll after abandon: %d %+v", c, raw)
	}
	var status string
	_ = pool.QueryRow(context.Background(), `SELECT status FROM ai_parse_jobs WHERE id=$1`, p.JobID).Scan(&status)
	if status != "abandoned" {
		t.Errorf("stored status %q", status)
	}
	// a late AI reading (e.g. an older app build) can neither add an entry nor overwrite the typed one
	var e409 struct{ Error struct{ Code string } }
	if c := call(t, srv, "POST", "/v1/entries", "ab1", M{"local_date": day, "items": []M{{"custom_name": "zorbu", "source": "ai_estimate", "confirmed": true,
		"kcal": 520, "protein_g": 9, "client_id": "p1-1", "parse_job_id": p.JobID}}}, &e409); c != 409 || e409.Error.Code != "job_abandoned" {
		t.Errorf("late AI add: %d %+v", c, e409)
	}
	if c := call(t, srv, "PATCH", "/v1/entries/p1", "ab1", M{"kcal": 520, "source": "ai_estimate"}, &e409); c != 409 || e409.Error.Code != "job_abandoned" {
		t.Errorf("late AI overwrite: %d %+v", c, e409)
	}
	var l listOut
	call(t, srv, "GET", "/v1/entries?date="+day, "ab1", nil, &l)
	if len(l.Entries) != 1 || l.Entries[0].KcalBest != 300 || l.Entries[0].Source != "custom" || l.Entries[0].State != "confirmed" || l.Total.Kcal != 300 || l.Total.NeedsReview != 0 {
		t.Errorf("entries after a late AI result: %+v", l)
	}
	var sum struct {
		KcalIn float64 `json:"kcal_in"`
	}
	call(t, srv, "GET", "/v1/summary?date="+day, "ab1", nil, &sum)
	if sum.KcalIn != 300 {
		t.Errorf("summary kcal_in=%v, want the typed 300", sum.KcalIn)
	}
	// a typed (custom) save tied to the abandoned job is fine
	if c := call(t, srv, "POST", "/v1/entries", "ab1", M{"local_date": day, "items": []M{{"custom_name": "raita", "source": "custom", "confirmed": true,
		"kcal": 80, "protein_g": 3, "client_id": "p2", "parse_job_id": p.JobID}}}, nil); c != 201 {
		t.Errorf("typed save tied to the job: %d", c)
	}
}

// Abandoning a job that was never tried gives its reserved call back, and a
// restart does not resume it: no AI call is ever made for it.
func TestAbandonUntriedJobReleasesQuota(t *testing.T) {
	dead, cancel := context.WithCancel(context.Background())
	cancel() // the worker never runs
	srv1, pool := setupCfg(t, &fakeAI{}, restartCfg(dead))
	var p parseOut
	if c := call(t, srv1, "POST", "/v1/parse", "ab2", M{"text": "1 plate zorbu"}, &p); c != 202 {
		t.Fatalf("parse: %d", c)
	}
	if u := quotaUsed(t, srv1); u != 1 {
		t.Fatalf("reserved=%d", u)
	}
	if c := call(t, srv1, "POST", "/v1/parse/jobs/"+p.JobID+"/abandon", "ab2", nil, nil); c != 200 {
		t.Fatalf("abandon: %d", c)
	}
	if u := quotaUsed(t, srv1); u != 0 {
		t.Errorf("quota after abandoning an untried job: %d, want 0", u)
	}
	srv1.Close()
	srv2 := restartSrv(t, pool)
	time.Sleep(100 * time.Millisecond)
	if n := aiCalls(t, srv2); n != 0 {
		t.Errorf("abandoned job resumed: %d AI calls", n)
	}
	var raw map[string]any
	if c := call(t, srv2, "GET", "/v1/parse/jobs/"+p.JobID, "ab2", nil, &raw); c != 200 || raw["status"] != "abandoned" {
		t.Errorf("poll after restart: %d %+v", c, raw)
	}
	if u := quotaUsed(t, srv2); u != 0 {
		t.Errorf("quota after restart: %d", u)
	}
}

// next_reset_at: on every parse response (cap failures included), on the
// job poll and on the quota endpoint.
func TestNextResetAt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv, _ := setupCfg(t, &fakeAI{}, restartCfg(ctx))
	check := func(what, s string) {
		t.Helper()
		at, err := time.Parse(time.RFC3339, s)
		if err != nil || !at.After(time.Now()) || at.Sub(time.Now()) > 25*time.Hour {
			t.Errorf("%s next_reset_at=%q", what, s)
		}
	}
	var r struct {
		NextResetAt string `json:"next_reset_at"`
		JobID       string `json:"job_id"`
		Reason      string `json:"fallback_reason"`
	}
	call(t, srv, "POST", "/v1/parse", "nr1", M{"text": "2 roti"}, &r)
	check("table parse", r.NextResetAt)
	call(t, srv, "POST", "/v1/parse", "nr1", M{"text": "1 plate zorbu"}, &r)
	check("AI parse", r.NextResetAt)
	if r.JobID != "" {
		var j struct {
			NextResetAt string `json:"next_reset_at"`
		}
		call(t, srv, "GET", "/v1/parse/jobs/"+r.JobID, "nr1", nil, &j)
		check("job poll", j.NextResetAt)
	}
	for _, x := range []string{"1 plate glorbu", "1 plate florbu", "1 plate snorbu"} { // past the per-user cap of 3
		call(t, srv, "POST", "/v1/parse", "nr1", M{"text": x}, &r)
	}
	if r.Reason != "user_limit" {
		t.Fatalf("expected user_limit, got %+v", r)
	}
	check("user_limit", r.NextResetAt)
	var q map[string]any
	admin(t, srv, "GET", "/admin/ai-quota", testAdmin, nil, &q)
	s, _ := q["next_reset_at"].(string)
	check("quota", s)
	if s != q["resets_at"] {
		t.Errorf("next_reset_at %v != resets_at %v", s, q["resets_at"])
	}
}
