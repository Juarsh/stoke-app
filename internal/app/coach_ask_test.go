package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/akarsh/calorie-tracker/internal/coach"
)

type fakeCoachAI struct {
	answer string
	err    error
	calls  int
	last   coach.Ask
}

func (f *fakeCoachAI) Answer(_ context.Context, in coach.Ask) (string, error) {
	f.calls++
	f.last = in
	if f.err != nil {
		return "", f.err
	}
	return f.answer, nil
}

func TestPostCoachRequiresAuth(t *testing.T) {
	srv, _ := setup(t, nil)
	if c := call(t, srv, "POST", "/v1/coach", "", M{"question": "What can I eat?"}, nil); c != 401 {
		t.Fatalf("no token: %d", c)
	}
}

func TestPostCoachAIAndFallback(t *testing.T) {
	ai := &fakeCoachAI{answer: "Have dal tonight."}
	srv := setupWith(t, func(c *Config) { c.CoachAI = ai })
	u := "ask1"
	if c := call(t, srv, "PUT", "/v1/profile", u, M{
		"sex": "male", "age": 30, "height_cm": 175, "weight_kg": 80,
		"activity_level": "moderate", "goal": "fat_loss",
		"maintenance_kcal": 2710, "target_kcal": 2210,
	}, nil); c != 200 {
		t.Fatalf("profile: %d", c)
	}
	if c := call(t, srv, "PATCH", "/v1/me", u, M{"diet": "veg"}, nil); c != 200 {
		t.Fatalf("diet: %d", c)
	}
	if c := call(t, srv, "POST", "/v1/entries", u, M{"text": "2 roti, 1 katori dal"}, nil); c != 201 {
		t.Fatalf("log food: %d", c)
	}
	var out M
	if c := call(t, srv, "POST", "/v1/coach", u, M{"question": "What should I eat next?"}, &out); c != 200 {
		t.Fatalf("ask: %d %v", c, out)
	}
	if out["source"] != "ai" || out["answer"] != "Have dal tonight." {
		t.Fatalf("ai response: %v", out)
	}
	if ai.calls != 1 || ai.last.Question != "What should I eat next?" {
		t.Fatalf("adapter: calls=%d last=%+v", ai.calls, ai.last)
	}
	ctx := ai.last.Context
	if !strings.Contains(ctx, "2210") || !strings.Contains(strings.ToLower(ctx), "roti") && !strings.Contains(strings.ToLower(ctx), "dal") {
		t.Fatalf("context should include target and today's foods: %q", ctx)
	}

	ai.err = errors.New("model down")
	ai.answer = ""
	out = M{}
	if c := call(t, srv, "POST", "/v1/coach", u, M{"question": "Again?"}, &out); c != 200 || out["source"] != "rules" || out["reason"] != "ai_error" {
		t.Fatalf("error fallback: %v", out)
	}
	picks, _ := out["picks"].([]any)
	if len(picks) == 0 {
		t.Fatalf("rules picks missing: %v", out)
	}
}

func TestPostCoachDailyCap(t *testing.T) {
	ai := &fakeCoachAI{answer: "ok"}
	srv := setupWith(t, func(c *Config) {
		c.CoachAI = ai
		c.CoachDailyCap = 2
	})
	u := "ask2"
	call(t, srv, "PUT", "/v1/profile", u, M{
		"sex": "female", "age": 28, "height_cm": 165, "weight_kg": 62,
		"activity_level": "moderate", "goal": "maintain",
		"maintenance_kcal": 2000, "target_kcal": 2000,
	}, nil)
	for i := 0; i < 2; i++ {
		var out M
		if c := call(t, srv, "POST", "/v1/coach", u, M{"question": "Q?"}, &out); c != 200 || out["source"] != "ai" {
			t.Fatalf("ask %d: %d %v", i, c, out)
		}
	}
	var out M
	if c := call(t, srv, "POST", "/v1/coach", u, M{"question": "One more?"}, &out); c != 200 || out["source"] != "rules" || out["reason"] != "over_cap" {
		t.Fatalf("third ask: %v", out)
	}
	if ai.calls != 2 {
		t.Fatalf("AI calls over cap: %d", ai.calls)
	}
}
