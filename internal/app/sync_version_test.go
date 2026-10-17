package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/food"
)

type verEntry struct {
	ClientID *string `json:"client_id"`
	Version  int     `json:"version"`
	KcalBest float64 `json:"kcal_best"`
	Source   string  `json:"source"`
	State    string  `json:"state"`
}
type verConflict struct {
	Error struct {
		Code    string `json:"code"`
		Version int    `json:"version"`
	} `json:"error"`
	Entry verEntry `json:"entry"`
}

// Entry versions replace the phone-clock precondition: insert = 1, every write +1, a stale
// version is a 409 version_conflict carrying the server's row; the client's retry on that
// version goes through. if_unmodified_since (old apps, skewed clocks) is ignored, so it can
// never jam a queue. Two writes racing on one version: exactly one wins.
func TestEntryVersionConflict(t *testing.T) {
	srv, pool := setup(t, nil)
	day := "2026-10-17"
	var cr struct{ Entries []verEntry }
	if c := call(t, srv, "POST", "/v1/entries", "ver", M{"local_date": day, "items": []M{{"custom_name": "poha", "source": "custom", "confirmed": true,
		"kcal": 300, "protein_g": 5, "client_id": "c1"}}}, &cr); c != 201 || cr.Entries[0].Version != 1 {
		t.Fatalf("insert: %d %+v", c, cr)
	}
	var e verEntry
	if c := call(t, srv, "PATCH", "/v1/entries/c1", "ver", M{"version": 1, "kcal": 350, "custom_name": "poha"}, &e); c != 200 || e.Version != 2 || e.KcalBest != 350 {
		t.Fatalf("patch v1: %d %+v", c, e)
	}
	var vc verConflict
	if c := call(t, srv, "PATCH", "/v1/entries/c1", "ver", M{"version": 1, "kcal": 400, "custom_name": "poha"}, &vc); c != 409 ||
		vc.Error.Code != "version_conflict" || vc.Error.Version != 2 || vc.Entry.Version != 2 || vc.Entry.KcalBest != 350 {
		t.Fatalf("stale version: %d %+v", c, vc)
	}
	// the phone reapplies its own edit on the server's version
	if c := call(t, srv, "PATCH", "/v1/entries/c1", "ver", M{"version": vc.Entry.Version, "kcal": 400, "custom_name": "poha"}, &e); c != 200 || e.Version != 3 || e.KcalBest != 400 {
		t.Fatalf("retry on the server version: %d %+v", c, e)
	}
	// a phone clock 60 s slow or fast: if_unmodified_since is ignored either way
	for _, skew := range []time.Duration{-60 * time.Second, 60 * time.Second, -24 * time.Hour} {
		if c := call(t, srv, "PATCH", "/v1/entries/c1", "ver", M{"version": e.Version, "kcal": 410, "custom_name": "poha",
			"if_unmodified_since": time.Now().Add(skew).UTC().Format(time.RFC3339)}, &e); c != 200 {
			t.Fatalf("skew %v: %d", skew, c)
		}
	}
	if c := call(t, srv, "PATCH", "/v1/entries/c1", "ver", M{"kcal": 420, "custom_name": "poha", "if_unmodified_since": "2000-01-01T00:00:00Z"}, &e); c != 200 {
		t.Fatalf("old app's clock precondition must not 409: %d", c)
	}
	// racing writes on one version: one 200, one 409
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = call(t, srv, "PATCH", "/v1/entries/c1", "ver", M{"version": e.Version, "kcal": 430 + i, "custom_name": "poha"}, nil)
		}(i)
	}
	wg.Wait()
	if !((codes[0] == 200 && codes[1] == 409) || (codes[0] == 409 && codes[1] == 200)) {
		t.Errorf("racing writes: %v", codes)
	}
	var l listOut
	call(t, srv, "GET", "/v1/entries?date="+day, "ver", nil, &l)
	var sum struct {
		KcalIn float64 `json:"kcal_in"`
	}
	call(t, srv, "GET", "/v1/summary?date="+day, "ver", nil, &sum)
	if len(l.Entries) != 1 || l.Total.Kcal != l.Entries[0].KcalBest || sum.KcalIn != l.Total.Kcal || (sum.KcalIn != 430 && sum.KcalIn != 431) {
		t.Errorf("list %+v vs summary %v", l, sum.KcalIn)
	}
	// delete is a write too
	var v0, v1 int
	_ = pool.QueryRow(context.Background(), `SELECT version FROM food_entries WHERE client_id='c1'`).Scan(&v0)
	if c := call(t, srv, "DELETE", "/v1/entries/c1", "ver", nil, nil); c != 204 {
		t.Fatalf("delete: %d", c)
	}
	_ = pool.QueryRow(context.Background(), `SELECT version FROM food_entries WHERE client_id='c1'`).Scan(&v1)
	if v1 != v0+1 {
		t.Errorf("delete version %d -> %d", v0, v1)
	}
}

// Tester rg2 item 6: a late AI save is refused (job_abandoned), then the user's typed kcal
// must go through (source custom, with or without the job id), and the summary is the typed
// value. A confirm that would keep a stored AI reading of the abandoned job is refused.
func TestTypedKcalAfterAbandonedAISave(t *testing.T) {
	d := food.RequeueDelays
	food.RequeueDelays = []time.Duration{60 * time.Millisecond}
	t.Cleanup(func() { food.RequeueDelays = d })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv, _ := setupCfg(t, &fakeAI{}, restartCfg(ctx))
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "busy"}, nil)
	var p parseOut
	if c := call(t, srv, "POST", "/v1/parse", "tk", M{"text": "1 plate zorbu, 1 bowl qelto"}, &p); c != 202 {
		t.Fatalf("parse: %d", c)
	}
	day := "2026-10-17"
	// placeholder p1 (custom, needs_review) and an AI reading p3 kept for review, both tied to the job
	for _, it := range []M{{"custom_name": "zorbu", "source": "custom", "state": "needs_review", "client_id": "p1", "parse_job_id": p.JobID},
		{"custom_name": "qelto", "source": "ai_estimate", "state": "needs_review", "kcal": 520, "protein_g": 4, "client_id": "p3", "parse_job_id": p.JobID}} {
		if c := call(t, srv, "POST", "/v1/entries", "tk", M{"local_date": day, "items": []M{it}}, nil); c != 201 {
			t.Fatalf("seed %v: %d", it["client_id"], c)
		}
	}
	if c := call(t, srv, "POST", "/v1/parse/jobs/"+p.JobID+"/abandon", "tk", nil, nil); c != 200 {
		t.Fatalf("abandon: %d", c)
	}
	var e409 struct{ Error struct{ Code string } }
	// the exact sequence: late AI save (POST dup -> PATCH ai_estimate) refused ...
	if c := call(t, srv, "PATCH", "/v1/entries/p1", "tk", M{"version": 1, "kcal": 520, "source": "ai_estimate", "parse_job_id": p.JobID, "state": "confirmed", "custom_name": "zorbu"}, &e409); c != 409 || e409.Error.Code != "job_abandoned" {
		t.Fatalf("late AI save: %d %+v", c, e409)
	}
	// ... then the typed 300 goes through as custom, even carrying the job id
	var e verEntry
	if c := call(t, srv, "PATCH", "/v1/entries/p1", "tk", M{"version": 1, "kcal": 300, "protein_g": 0, "source": "custom", "parse_job_id": p.JobID, "state": "confirmed", "custom_name": "zorbu"}, &e); c != 200 ||
		e.KcalBest != 300 || e.Source != "custom" || e.State != "confirmed" {
		t.Fatalf("typed kcal after job_abandoned: %d %+v", c, e)
	}
	// confirming the stored AI reading of the abandoned job is an AI-source write: refused
	if c := call(t, srv, "PATCH", "/v1/entries/p3", "tk", M{"state": "confirmed"}, &e409); c != 409 || e409.Error.Code != "job_abandoned" {
		t.Errorf("confirm of an abandoned AI reading: %d %+v", c, e409)
	}
	// the user's own number for it is accepted (no source field: kcal makes it custom)
	if c := call(t, srv, "PATCH", "/v1/entries/p3", "tk", M{"state": "confirmed", "kcal": 200, "protein_g": 0, "custom_name": "qelto"}, &e); c != 200 || e.Source != "custom" {
		t.Fatalf("typed kcal on the AI row: %d %+v", c, e)
	}
	var l listOut
	call(t, srv, "GET", "/v1/entries?date="+day, "tk", nil, &l)
	var sum struct {
		KcalIn float64 `json:"kcal_in"`
	}
	call(t, srv, "GET", "/v1/summary?date="+day, "tk", nil, &sum)
	if l.Total.Kcal != 500 || sum.KcalIn != 500 || l.Total.NeedsReview != 0 {
		t.Errorf("totals %+v summary %v, want the typed 300+200", l.Total, sum.KcalIn)
	}
}

// AI_USER_DAILY_CAP counts once per meal (job): 3 timeouts of one meal use 1 of the user's
// 3, so 2 more meals are allowed (the 4th is user_limit). AI_DAILY_CAP counts every attempt.
func TestUserCapOncePerMeal(t *testing.T) {
	d := food.RequeueDelays
	food.RequeueDelays = []time.Duration{20 * time.Millisecond}
	t.Cleanup(func() { food.RequeueDelays = d })
	srv, pool := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap, c.UserAICap = testAdmin, 20, 3 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "timeout"}, nil)
	var p parseOut
	if c := call(t, srv, "POST", "/v1/parse", "cap1", M{"text": "2 plate zorbu"}, &p); c != 202 {
		t.Fatalf("parse: %d", c)
	}
	for i := 0; i < 400; i++ {
		var j parseOut
		call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "cap1", nil, &j)
		if aiCalls(t, srv) >= 3 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": ""}, nil)
	for i := 0; i < 400; i++ {
		if c := call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "cap1", nil, nil); c == 200 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	attempts := aiCalls(t, srv)
	if attempts < 4 {
		t.Fatalf("want 3 timeouts + the answer, got %d attempts", attempts)
	}
	var userCalls int
	_ = pool.QueryRow(context.Background(), `SELECT COALESCE(SUM(calls),0) FROM ai_usage`).Scan(&userCalls)
	if userCalls != 1 {
		t.Errorf("per-user cap after one meal with %d attempts: %d, want 1", attempts, userCalls)
	}
	if u := quotaUsed(t, srv); u != int64(attempts) {
		t.Errorf("AI_DAILY_CAP counts every attempt: used=%d, attempts=%d", u, attempts)
	}
	for i, txt := range []string{"1 bowl qelto", "1 plate vrumba"} {
		var r parseOut
		c := call(t, srv, "POST", "/v1/parse", "cap1", M{"text": txt}, &r)
		if (c != 200 && c != 202) || r.FallbackReason == "user_limit" {
			t.Fatalf("meal %d after the timeouts: %d %+v", i+2, c, r)
		}
		if c == 202 {
			for k := 0; k < 400; k++ {
				if c := call(t, srv, "GET", "/v1/parse/jobs/"+r.JobID, "cap1", nil, &r); c == 200 {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
		}
		if r.FallbackReason == "user_limit" {
			t.Fatalf("meal %d refused: %+v", i+2, r)
		}
	}
	var r parseOut
	call(t, srv, "POST", "/v1/parse", "cap1", M{"text": "1 cup zintho"}, &r)
	if r.FallbackReason != "user_limit" {
		t.Errorf("4th meal: %+v, want user_limit", r)
	}
}
