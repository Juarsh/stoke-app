package food

import (
	"sync"

	"context"
	"encoding/json"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A fake generateContent server: no real Gemini call in tests.
func fakeGemini(t *testing.T, status int, answer string, delay time.Duration, got *map[string]any) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-goog-api-key") != "k" || !strings.HasSuffix(r.URL.Path, "/models/gemini-2.5-flash:generateContent") {
			t.Errorf("bad request %s", r.URL.Path)
		}
		if got != nil {
			_ = json.NewDecoder(r.Body).Decode(got)
		}
		time.Sleep(delay)
		w.WriteHeader(status)
		b, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": answer}}}}}})
		w.Write(b)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestGeminiWholeMealStrictJSON(t *testing.T) {
	ans := `{"items":[{"name":"quinoa","quantity":1,"unit":"katori","grams":150,"kcal_low":160,"kcal_best":180,"kcal_high":220,"protein_low":5,"protein_best":6,"protein_high":7,"carbs_g":30,"fat_g":3},
	{"name":"roti","quantity":2,"unit":"count","grams":80,"kcal_low":180,"kcal_best":220,"kcal_high":260,"protein_low":5,"protein_best":6,"protein_high":7,"carbs_g":40,"fat_g":2}]}`
	var req map[string]any
	srv := fakeGemini(t, 200, ans, 0, &req)
	g := Gemini{APIKey: "k", BaseURL: srv.URL}
	out, err := g.EstimateMeal(context.Background(), "2 roti quinoa", []Span{{Start: 7, End: 13, Text: "quinoa"}}, []parser.Item{{Name: "roti", Quantity: 2, Unit: "count"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Kcal.Best != 180 || out[1].Quantity != 2 {
		t.Errorf("got %+v", out)
	}
	gc := req["generationConfig"].(map[string]any)
	if gc["responseMimeType"] != "application/json" || gc["responseSchema"] == nil {
		t.Errorf("no strict schema: %v", gc)
	}
	b, _ := json.Marshal(req["contents"])
	if !strings.Contains(string(b), "2 roti quinoa") || !strings.Contains(string(b), "Hint") || !strings.Contains(string(b), "SPANS") {
		t.Errorf("prompt lacks whole meal or hint: %s", b)
	}
}

func TestGeminiFailures(t *testing.T) {
	bad := `{"items":[{"name":"x","quantity":1,"unit":"count","kcal_low":90,"kcal_best":50,"kcal_high":60,"protein_low":0,"protein_best":0,"protein_high":0,"carbs_g":0,"fat_g":0}]}`
	for name, g := range map[string]Gemini{
		"status":  {APIKey: "k", BaseURL: fakeGemini(t, 429, "", 0, nil).URL},
		"badjson": {APIKey: "k", BaseURL: fakeGemini(t, 200, "not json", 0, nil).URL},
		"ranges":  {APIKey: "k", BaseURL: fakeGemini(t, 200, bad, 0, nil).URL},
		"empty":   {APIKey: "k", BaseURL: fakeGemini(t, 200, `{"items":[]}`, 0, nil).URL},
		"timeout": {APIKey: "k", BaseURL: fakeGemini(t, 200, `{"items":[]}`, 300*time.Millisecond, nil).URL, Timeout: 50 * time.Millisecond},
	} {
		if _, err := g.EstimateMeal(context.Background(), "x", nil, nil); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	if _, err := (Gemini{}).EstimateMeal(context.Background(), "x", nil, nil); err != ErrNotConfigured {
		t.Errorf("no key: %v", err)
	}
}

func TestQueueDrainsAtRate(t *testing.T) {
	q := NewQueue(600, 10) // one per 100ms
	var mu sync.Mutex
	var at []time.Time
	q.run = func(context.Context, *Job) ParseResponse {
		mu.Lock()
		at = append(at, time.Now())
		mu.Unlock()
		return ParseResponse{Status: "done"}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go q.Run(ctx)
	var ids []string
	for i := 0; i < 3; i++ {
		j, ok := q.Add(1, "x", "x", nil, ParseResponse{}, "lunch", nil, nil)
		if !ok {
			t.Fatal("full")
		}
		ids = append(ids, j.ID)
	}
	if _, ok := q.Get(2, ids[0]); ok {
		t.Error("other user can read the job")
	}
	time.Sleep(450 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(at) != 3 {
		t.Fatalf("ran %d", len(at))
	}
	for i := 1; i < 3; i++ {
		if d := at[i].Sub(at[i-1]); d < 90*time.Millisecond {
			t.Errorf("calls %v apart, want >= 100ms", d)
		}
	}
	if j, _ := q.Get(1, ids[2]); j.Status != "done" {
		t.Errorf("job not done: %+v", j)
	}
	// full queue refuses
	small := NewQueue(1, 1)
	small.Add(1, "a", "a", nil, ParseResponse{}, "", nil, nil)
	if _, ok := small.Add(1, "b", "b", nil, ParseResponse{}, "", nil, nil); ok {
		t.Error("full queue accepted a job")
	}
}

func TestPlaceAI(t *testing.T) {
	text := "2 roti, zorbo pakora aur kombucha"
	claimed := []parser.Item{{DishID: "roti", SpanStart: 2, SpanEnd: 6}}
	spans := []Span{{Start: 8, End: 20, Text: "zorbo pakora"}, {Start: 25, End: 33, Text: "kombucha"}}
	loc := func(hay, w string) (int, int, bool) {
		i := strings.Index(strings.ToLower(hay), strings.ToLower(w))
		if i < 0 {
			return 0, 0, false
		}
		return i, i + len(w), true
	}
	ai := []parser.Item{
		{Name: "pakora", AIName: "pakora", SpanStart: 8, SpanEnd: 20},   // valid offsets
		{Name: "kombucha", AIName: "kombucha"},                          // no offsets, found by name
		{Name: "roti", AIName: "roti", SpanStart: 2, SpanEnd: 6},        // overlaps table item -> dropped
		{Name: "mystery", AIName: "mystery", SpanStart: 0, SpanEnd: 33}, // whole text: invalid, not found -> did_you_mean
	}
	out := placeAI(text, ai, spans, claimed, loc)
	if len(out) != 3 {
		t.Fatalf("placed %d: %+v", len(out), out)
	}
	if out[0].Matched != "zorbo pakora" || out[1].SpanStart != 25 || out[1].Matched != "kombucha" {
		t.Errorf("placement: %+v", out)
	}
	if out[2].Source != parser.SourceDidYouMean || out[2].SpanStart != 8 || out[2].SpanEnd == 33 {
		t.Errorf("unplaced item: %+v", out[2])
	}
	for _, it := range out {
		if it.SpanStart == 0 && it.SpanEnd == len(text) {
			t.Errorf("whole-text span while table items exist: %+v", it)
		}
	}
}

func TestStubFollowsSpanContract(t *testing.T) {
	s := &Stub{}
	spans := []Span{{Start: 8, End: 20, Text: "zorbo pakora"}}
	out, _ := s.EstimateMeal(context.Background(), "2 roti, zorbo pakora", spans, nil)
	if len(out) != 1 || out[0].SpanStart != 8 || out[0].SpanEnd != 20 || out[0].Name != "zorbo pakora" {
		t.Errorf("stub: %+v", out)
	}
}
