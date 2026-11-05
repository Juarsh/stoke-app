package coach

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/akarsh/calorie-tracker/internal/store"
)

type fakeAI struct {
	answer string
	err    error
	delay  time.Duration
	last   Ask
	calls  int
}

func (f *fakeAI) Answer(ctx context.Context, in Ask) (string, error) {
	f.calls++
	f.last = in
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	if f.err != nil {
		return "", f.err
	}
	return f.answer, nil
}

type fakeUsage struct {
	n, cap int
	err    error
}

func (u *fakeUsage) TryCoachAsk(context.Context, int64, time.Time, int) (int, bool, error) {
	if u.err != nil {
		return u.n, false, u.err
	}
	if u.cap <= 0 {
		u.cap = 20
	}
	if u.n >= u.cap {
		return u.n, false, nil
	}
	u.n++
	return u.n, true, nil
}

func (u *fakeUsage) CoachAskCount(context.Context, int64, time.Time) (int, error) {
	return u.n, u.err
}

func testService(t *testing.T, ai CoachAI, usage store.CoachUsage) *Service {
	t.Helper()
	p, err := parser.New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	return &Service{Parser: p, Table: func() *parser.Parser { return p }, AI: ai, Usage: usage, Timeout: 50 * time.Millisecond}
}

func postAsk(t *testing.T, s *Service, uid int64, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/v1/coach", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(httpx.WithUser(req.Context(), uid))
	rec := httptest.NewRecorder()
	s.handleAsk(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestAskAISuccess(t *testing.T) {
	ai := &fakeAI{answer: "Have dal and roti."}
	u := &fakeUsage{}
	s := testService(t, ai, u)
	code, out := postAsk(t, s, 1, map[string]any{"question": "What should I eat?", "messages": []map[string]string{
		{"role": "user", "text": "hi"},
		{"role": "assistant", "text": "hello"},
	}})
	if code != 200 || out["source"] != "ai" || out["answer"] != "Have dal and roti." {
		t.Fatalf("ai: %d %v", code, out)
	}
	if out["picks"] != nil || out["reason"] != nil {
		t.Fatalf("ai should omit picks/reason: %v", out)
	}
	if ai.calls != 1 || ai.last.Question != "What should I eat?" || len(ai.last.Messages) != 2 {
		t.Fatalf("adapter input: %+v calls=%d", ai.last, ai.calls)
	}
	if u.n != 1 {
		t.Fatalf("cap reserved: %d", u.n)
	}
	if ai.last.Context == "" || !containsAll(ai.last.Context, "Date:", "Today's foods:", "Workouts (7d):", "Habits (7d):") {
		t.Fatalf("context missing pieces: %q", ai.last.Context)
	}
}

func TestAskMessagesCappedAt6(t *testing.T) {
	ai := &fakeAI{answer: "ok"}
	s := testService(t, ai, &fakeUsage{})
	var msgs []map[string]string
	for i := 0; i < 8; i++ {
		msgs = append(msgs, map[string]string{"role": "user", "text": "m" + itoa(i)})
	}
	_, _ = postAsk(t, s, 1, map[string]any{"question": "now?", "messages": msgs})
	if len(ai.last.Messages) != 6 || ai.last.Messages[0].Text != "m2" || ai.last.Messages[5].Text != "m7" {
		t.Fatalf("want last 6, got %+v", ai.last.Messages)
	}
}

func TestAskEmptyQuestion(t *testing.T) {
	s := testService(t, &fakeAI{answer: "nope"}, &fakeUsage{})
	code, out := postAsk(t, s, 1, map[string]any{"question": "  "})
	if code != http.StatusBadRequest {
		t.Fatalf("empty: %d %v", code, out)
	}
}

func TestAskAIErrorFallsBackToRules(t *testing.T) {
	ai := &fakeAI{err: errors.New("boom")}
	s := testService(t, ai, &fakeUsage{})
	code, out := postAsk(t, s, 1, map[string]any{"question": "ideas?"})
	if code != 200 || out["source"] != "rules" || out["reason"] != "ai_error" {
		t.Fatalf("error fallback: %d %v", code, out)
	}
	picks, _ := out["picks"].([]any)
	if len(picks) == 0 {
		t.Fatalf("expected rules picks: %v", out)
	}
}

func TestAskTimeoutFallsBackToRules(t *testing.T) {
	ai := &fakeAI{answer: "late", delay: 200 * time.Millisecond}
	s := testService(t, ai, &fakeUsage{})
	s.Timeout = 20 * time.Millisecond
	code, out := postAsk(t, s, 1, map[string]any{"question": "ideas?"})
	if code != 200 || out["source"] != "rules" || out["reason"] != "timeout" {
		t.Fatalf("timeout fallback: %d %v", code, out)
	}
}

func TestAskOverCapFallsBackToRules(t *testing.T) {
	ai := &fakeAI{answer: "should not run"}
	u := &fakeUsage{n: 20, cap: 20}
	s := testService(t, ai, u)
	code, out := postAsk(t, s, 1, map[string]any{"question": "ideas?"})
	if code != 200 || out["source"] != "rules" || out["reason"] != "over_cap" {
		t.Fatalf("over cap: %d %v", code, out)
	}
	if ai.calls != 0 {
		t.Fatalf("AI called over cap: %d", ai.calls)
	}
	if u.n != 20 {
		t.Fatalf("count changed: %d", u.n)
	}
}

func TestAskUnavailableNoCapSpend(t *testing.T) {
	u := &fakeUsage{}
	s := testService(t, NoCoachAI{}, u)
	code, out := postAsk(t, s, 1, map[string]any{"question": "ideas?"})
	if code != 200 || out["source"] != "rules" || out["reason"] != "unavailable" {
		t.Fatalf("unavailable: %d %v", code, out)
	}
	if u.n != 0 {
		t.Fatalf("cap spent without AI: %d", u.n)
	}
}

func containsAll(s string, parts ...string) bool {
	for _, p := range parts {
		if !bytes.Contains([]byte(s), []byte(p)) {
			return false
		}
	}
	return true
}

func itoa(i int) string { return string(rune('0' + i)) }
