package food

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const okAnswer = `{"items":[{"name":"quinoa","quantity":1,"unit":"katori","grams":150,"kcal_low":160,"kcal_best":180,"kcal_high":220,"protein_low":5,"protein_best":6,"protein_high":7,"carbs_g":30,"fat_g":3,"span_start":0,"span_end":6,"span_text":"quinoa"}]}`

// scripted: each request gets the next (status, header, body); the last repeats.
type step struct {
	status int
	hdr    map[string]string
	body   string
}

func scripted(t *testing.T, steps []step, hits *atomic.Int32) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(hits.Add(1)) - 1
		s := steps[min(n, len(steps)-1)]
		for k, v := range s.hdr {
			w.Header().Set(k, v)
		}
		w.WriteHeader(s.status)
		if s.status == 200 {
			b, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": okAnswer}}}}}})
			w.Write(b)
			return
		}
		w.Write([]byte(s.body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func gerr(code int, status, details string) string {
	return `{"error":{"code":` + jnum(code) + `,"status":"` + status + `","message":"m","details":[` + details + `]}}`
}

var sp = []Span{{Start: 0, End: 6, Text: "quinoa"}}

func TestGeminiRetries(t *testing.T) {
	quota := `{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests","quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}`
	minute := `{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"0.01s"}`
	cases := []struct {
		name     string
		steps    []step
		deadline time.Duration
		hits     int32
		code     string // "" = success
		daily    bool
	}{
		{"429 then ok (Retry-After)", []step{{429, map[string]string{"Retry-After": "0"}, gerr(429, "RESOURCE_EXHAUSTED", "")}, {200, nil, ""}}, 5 * time.Second, 2, "", false},
		{"503 twice then ok", []step{{503, nil, gerr(503, "UNAVAILABLE", "")}, {503, nil, gerr(503, "UNAVAILABLE", "")}, {200, nil, ""}}, 5 * time.Second, 3, "", false},
		{"429 always: 2 retries max", []step{{429, nil, gerr(429, "RESOURCE_EXHAUSTED", minute)}}, 5 * time.Second, 3, "rate_limited", false},
		{"503 always", []step{{503, nil, gerr(503, "UNAVAILABLE", "")}}, 5 * time.Second, 3, "unavailable", false},
		{"RetryInfo past the job deadline: no retry", []step{{429, nil, gerr(429, "RESOURCE_EXHAUSTED", `{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}`)}}, time.Second, 1, "rate_limited", false},
		{"Retry-After past the job deadline: no retry", []step{{503, map[string]string{"Retry-After": "60"}, gerr(503, "UNAVAILABLE", "")}}, time.Second, 1, "unavailable", false},
		{"400 not retried", []step{{400, nil, gerr(400, "INVALID_ARGUMENT", "")}}, 5 * time.Second, 1, "error", false},
		{"daily quota: no retry", []step{{429, nil, gerr(429, "RESOURCE_EXHAUSTED", quota)}}, 5 * time.Second, 1, "daily_limit", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var hits atomic.Int32
			srv := scripted(t, tc.steps, &hits)
			g := Gemini{APIKey: "secret-key-xyz", BaseURL: srv.URL, Backoff: 5 * time.Millisecond}
			ctx, cancel := context.WithTimeout(context.Background(), tc.deadline)
			defer cancel()
			var logs bytes.Buffer
			log.SetOutput(&logs)
			defer log.SetOutput(os.Stderr)
			out, err := g.EstimateMeal(ctx, "quinoa", sp, nil)
			log.SetOutput(os.Stderr)
			if hits.Load() != tc.hits {
				t.Errorf("attempts: got %d, want %d", hits.Load(), tc.hits)
			}
			if tc.code == "" {
				if err != nil || len(out) != 1 {
					t.Fatalf("want success, got %v %v", out, err)
				}
				return
			}
			var ae *AIError
			if !errors.As(err, &ae) || ae.Code() != tc.code || ae.DailyQuota != tc.daily || ae.Attempts != int(tc.hits) {
				t.Fatalf("want %s, got %#v (%v)", tc.code, ae, err)
			}
			l := logs.String()
			if strings.Contains(l, "secret-key-xyz") || strings.Contains(l, "quinoa") || !strings.Contains(l, "http_status=") ||
				!strings.Contains(l, "attempt=") || !strings.Contains(l, "latency_ms=") || !strings.Contains(l, "model=gemini-flash-latest") {
				t.Errorf("log: %s", l)
			}
			if tc.code != "error" && !strings.Contains(l, "google_status=\"") {
				t.Errorf("no google status in log: %s", l)
			}
		})
	}
}

// The limiter spaces attempts (retries included) and never bursts.
func TestLimiterSpacing(t *testing.T) {
	l := NewLimiter(600) // 100 ms apart
	t0 := time.Now()
	for i := 0; i < 4; i++ {
		if err := l.Wait(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if d := time.Since(t0); d < 290*time.Millisecond {
		t.Errorf("4 calls at 600/min took %v", d)
	}
	// a slot after the deadline is refused at once (and not consumed)
	l = NewLimiter(1)
	_ = l.Wait(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := l.Wait(ctx); !errors.Is(err, ErrLimiterDeadline) {
		t.Errorf("want ErrLimiterDeadline, got %v", err)
	}
	// a Gemini call that can't get a slot is rate_limited, with no HTTP call
	var hits atomic.Int32
	g := Gemini{APIKey: "k", BaseURL: scripted(t, []step{{200, nil, ""}}, &hits).URL, Limiter: l}
	_, err := g.EstimateMeal(ctx, "quinoa", sp, nil)
	var ae *AIError
	if !errors.As(err, &ae) || ae.Code() != "rate_limited" || hits.Load() != 0 {
		t.Errorf("limited: %v hits=%d", err, hits.Load())
	}
}

func TestQuotaDayAndReset(t *testing.T) {
	q := &Quota{}
	la, _ := time.LoadLocation("America/Los_Angeles")
	ist, _ := time.LoadLocation("Asia/Kolkata")
	// 12:00 IST on 15 Oct (PDT) = 23:30 PT on 14 Oct; reset at 12:30 IST
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, ist)
	if d := q.Day(now).Format("2006-01-02"); d != "2026-10-14" {
		t.Errorf("quota day %s", d)
	}
	if r := q.NextReset(now).In(ist); r.Hour() != 12 || r.Minute() != 30 {
		t.Errorf("reset (PDT) %v", r)
	}
	// winter (PST): reset at 13:30 IST
	if r := q.NextReset(time.Date(2026, 12, 15, 12, 0, 0, 0, ist)).In(ist); r.Hour() != 13 || r.Minute() != 30 {
		t.Errorf("reset (PST) %v", r)
	}
	q.MarkExhausted(now)
	if ex, until := q.Exhausted(now); !ex || !until.Equal(q.NextReset(now)) {
		t.Errorf("exhausted %v %v", ex, until)
	}
	if ex, _ := q.Exhausted(q.NextReset(now).Add(time.Second)); ex {
		t.Error("still exhausted after the reset")
	}
	_ = la
}
func jnum(n int) string { b, _ := json.Marshal(n); return string(b) }
