package app

import (
	"testing"
	"time"
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

// Still rate limited after the client's retries: fallback busy, generic
// estimates to confirm (never 0 kcal), counted once against the caps.
func TestAIBusyAfterRetries(t *testing.T) {
	srv, _ := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap = testAdmin, 20 })
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "busy"}, nil)
	_, r := parseAI(t, srv, "busy1", "2 roti aur 1 plate zorbu")
	if r.Fallback != "busy" || r.FallbackReason != "rate_limited" || !r.NeedsConfirmation || len(r.Items) != 2 {
		t.Fatalf("busy: %+v", r)
	}
	for _, it := range r.Items {
		if it.Kcal.Best <= 0 {
			t.Errorf("zero estimate: %+v", it)
		}
		if it.DishID != "roti" && (!it.NeedsConfirmation || it.OneTapOK) {
			t.Errorf("placeholder must need confirmation: %+v", it)
		}
	}
	var q quotaOut
	if c := admin(t, srv, "GET", "/admin/ai-quota", testAdmin, nil, &q); c != 200 || q.Used != 1 || q.Remaining == nil || *q.Remaining != 19 ||
		q.DailyCap != 20 || q.UserDailyCap != 3 || q.Exhausted || q.ResetZone != "America/Los_Angeles" {
		t.Errorf("quota after one failed meal: %d %+v", c, q)
	}
}

// A 429 naming the daily quota marks the project exhausted until Google's
// reset: no more calls, fallback daily_limit with ai_resets_at.
func TestAIDailyQuotaExhausted(t *testing.T) {
	srv, _ := setupCfg(t, &fakeAI{}, func(c *Config) { c.AdminToken, c.GlobalAICap = testAdmin, 20 })
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "daily_limit"}, nil)
	_, r := parseAI(t, srv, "q1", "1 plate zorbu")
	if r.Fallback != "daily_limit" || r.FallbackReason != "daily_limit" || r.AIResetsAt == "" || !r.NeedsConfirmation {
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
