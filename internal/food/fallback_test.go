package food

import (
	"context"
	"encoding/json"
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

func TestGeminiParsesStrictJSON(t *testing.T) {
	ans := `{"results":[{"span":"quinoa bowl","items":[{"name":"quinoa","quantity":1,"unit":"katori","grams":150,"kcal_low":160,"kcal_best":180,"kcal_high":220,"protein_low":5,"protein_best":6,"protein_high":7,"carbs_g":30,"fat_g":3}]},
	{"span":"not asked","items":[{"name":"x","quantity":1,"unit":"count","kcal_low":1,"kcal_best":2,"kcal_high":3,"protein_low":0,"protein_best":0,"protein_high":0,"carbs_g":0,"fat_g":0}]},
	{"span":"kombucha","items":[{"name":"bad","quantity":1,"unit":"glass","kcal_low":90,"kcal_best":50,"kcal_high":60,"protein_low":0,"protein_best":0,"protein_high":0,"carbs_g":0,"fat_g":0}]}]}`
	var req map[string]any
	srv := fakeGemini(t, 200, ans, 0, &req)
	g := Gemini{APIKey: "k", BaseURL: srv.URL}
	out, err := g.EstimateBatch(context.Background(), []string{"quinoa bowl", "kombucha"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out["quinoa bowl"][0].Kcal.Best != 180 || out["quinoa bowl"][0].CarbsG != 30 {
		t.Errorf("got %+v", out)
	}
	gc := req["generationConfig"].(map[string]any)
	if gc["responseMimeType"] != "application/json" || gc["responseSchema"] == nil {
		t.Errorf("no strict schema: %v", gc)
	}
}

func TestGeminiFailures(t *testing.T) {
	for name, g := range map[string]Gemini{
		"status":  {APIKey: "k", BaseURL: fakeGemini(t, 429, "", 0, nil).URL},
		"badjson": {APIKey: "k", BaseURL: fakeGemini(t, 200, "not json", 0, nil).URL},
		"timeout": {APIKey: "k", BaseURL: fakeGemini(t, 200, `{"results":[]}`, 300*time.Millisecond, nil).URL, Timeout: 50 * time.Millisecond},
	} {
		if _, err := g.EstimateBatch(context.Background(), []string{"x"}); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	if _, err := (Gemini{}).EstimateBatch(context.Background(), []string{"x"}); err != ErrNotConfigured {
		t.Errorf("no key: %v", err)
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter(8)
	l.now = func() time.Time { return now }
	for i := 0; i < 8; i++ {
		if !l.Allow() {
			t.Fatalf("call %d blocked", i)
		}
	}
	if l.Allow() {
		t.Error("9th call in a minute allowed")
	}
	now = now.Add(61 * time.Second)
	if !l.Allow() {
		t.Error("not released after a minute")
	}
}
