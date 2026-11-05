package coach

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGeminiAIRequestShape(t *testing.T) {
	var sawKeyQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("key") != "" {
			sawKeyQuery = true
		}
		if r.Header.Get("x-goog-api-key") == "" {
			t.Errorf("missing api key header")
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var req map[string]any
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("body: %v", err)
		}
		gen, _ := req["generationConfig"].(map[string]any)
		if gen["maxOutputTokens"] != float64(250) {
			t.Errorf("maxOutputTokens: %v", gen["maxOutputTokens"])
		}
		sys, _ := req["systemInstruction"].(map[string]any)
		parts, _ := sys["parts"].([]any)
		if len(parts) == 0 {
			t.Fatal("no system prompt")
		}
		text, _ := parts[0].(map[string]any)["text"].(string)
		if !strings.Contains(strings.ToLower(text), "diagnos") {
			t.Errorf("system prompt should refuse medical diagnosis: %q", text)
		}
		if !strings.Contains(text, "1800 kcal") {
			t.Errorf("context not in system prompt: %q", text)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"Try dal."}]}}]}`))
	}))
	defer srv.Close()
	g := GeminiAI{APIKey: "test-key", BaseURL: srv.URL, Timeout: time.Second, Client: srv.Client()}
	got, err := g.Answer(context.Background(), Ask{Question: "What can I eat?", Context: "Targets: 1800 kcal, 120 g protein"})
	if err != nil || got != "Try dal." {
		t.Fatalf("answer: %q %v", got, err)
	}
	if sawKeyQuery {
		t.Fatal("API key must not appear in the URL")
	}
}

func TestGeminiAIEmptyKey(t *testing.T) {
	_, err := (GeminiAI{}).Answer(context.Background(), Ask{Question: "hi"})
	if err != ErrNotConfigured {
		t.Fatalf("got %v", err)
	}
}

func TestGeminiAIHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	defer srv.Close()
	_, err := (GeminiAI{APIKey: "test-key", BaseURL: srv.URL, Client: srv.Client()}).Answer(context.Background(), Ask{Question: "hi"})
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("got %v", err)
	}
}

func TestGeminiAIDefaultModelIsFlashLite(t *testing.T) {
	if DefaultGeminiModel != "gemini-flash-lite-latest" {
		t.Fatalf("default model: %s", DefaultGeminiModel)
	}
	var path string
	var gen map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var req map[string]any
		_ = json.Unmarshal(body, &req)
		gen, _ = req["generationConfig"].(map[string]any)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"Try dal tonight."}]}}]}`))
	}))
	defer srv.Close()
	g := GeminiAI{APIKey: "test-key", BaseURL: srv.URL, Timeout: time.Second, Client: srv.Client()}
	got, err := g.Answer(context.Background(), Ask{Question: "What can I eat?"})
	if err != nil || got != "Try dal tonight." {
		t.Fatalf("answer: %q %v", got, err)
	}
	if !strings.Contains(path, "/models/gemini-flash-lite-latest:generateContent") {
		t.Fatalf("path: %s", path)
	}
	if _, ok := gen["thinkingConfig"]; ok {
		t.Fatalf("Flash-Lite must omit thinkingConfig: %v", gen)
	}
}

func TestGeminiAIHonoursConfiguredModel(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`))
	}))
	defer srv.Close()
	g := GeminiAI{APIKey: "k", Model: "gemini-flash-latest", BaseURL: srv.URL, Client: srv.Client()}
	if _, err := g.Answer(context.Background(), Ask{Question: "hi"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(path, "/models/gemini-flash-latest:generateContent") {
		t.Fatalf("path: %s", path)
	}
}

func TestGeminiAIFlashLatestSendsThinkingBudgetZero(t *testing.T) {
	var gen map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var req map[string]any
		_ = json.Unmarshal(body, &req)
		gen, _ = req["generationConfig"].(map[string]any)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`))
	}))
	defer srv.Close()
	g := GeminiAI{APIKey: "k", Model: "gemini-flash-latest", BaseURL: srv.URL, Client: srv.Client()}
	if _, err := g.Answer(context.Background(), Ask{Question: "hi"}); err != nil {
		t.Fatal(err)
	}
	tc, _ := gen["thinkingConfig"].(map[string]any)
	if tc["thinkingBudget"] != float64(0) {
		t.Fatalf("thinkingBudget: %v", gen)
	}
}

func TestGeminiAIRetries503ThenSucceeds(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		if n == 1 {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"Have dal."}]}}]}`))
	}))
	defer srv.Close()
	got, err := (GeminiAI{APIKey: "k", BaseURL: srv.URL, Client: srv.Client(), Timeout: 5 * time.Second}).Answer(context.Background(), Ask{Question: "hi"})
	if err != nil || got != "Have dal." {
		t.Fatalf("got %q %v calls=%d", got, err, n)
	}
	if n != 2 {
		t.Fatalf("want one retry, calls=%d", n)
	}
}

func TestGeminiAIRetries429ThenSucceeds(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		if n == 1 {
			w.WriteHeader(429)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`))
	}))
	defer srv.Close()
	got, err := (GeminiAI{APIKey: "k", BaseURL: srv.URL, Client: srv.Client(), Timeout: 5 * time.Second}).Answer(context.Background(), Ask{Question: "hi"})
	if err != nil || got != "ok" || n != 2 {
		t.Fatalf("got %q %v calls=%d", got, err, n)
	}
}

func TestGeminiAIDoesNotRetryOn500(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		w.WriteHeader(500)
	}))
	defer srv.Close()
	_, err := (GeminiAI{APIKey: "k", BaseURL: srv.URL, Client: srv.Client()}).Answer(context.Background(), Ask{Question: "hi"})
	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("got %v", err)
	}
	if n != 1 {
		t.Fatalf("retried 500: calls=%d", n)
	}
}

func TestGeminiAISkipsRetryWhenNoTimeLeft(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		time.Sleep(30 * time.Millisecond)
		w.WriteHeader(503)
	}))
	defer srv.Close()
	_, err := (GeminiAI{APIKey: "k", BaseURL: srv.URL, Client: srv.Client(), Timeout: 40 * time.Millisecond}).Answer(context.Background(), Ask{Question: "hi"})
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("got %v", err)
	}
	if n != 1 {
		t.Fatalf("retried without time: calls=%d", n)
	}
}

func TestGeminiAIMaxTokensTrimsToLastSentence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"Have dal tonight. Then try some roti with"}]}}]}`))
	}))
	defer srv.Close()
	got, err := (GeminiAI{APIKey: "k", BaseURL: srv.URL, Client: srv.Client()}).Answer(context.Background(), Ask{Question: "hi"})
	if err != nil || got != "Have dal tonight." {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestGeminiAIMaxTokensWithoutSentenceIsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"You have your full vegetarian target of 22"}]}}]}`))
	}))
	defer srv.Close()
	_, err := (GeminiAI{APIKey: "k", BaseURL: srv.URL, Client: srv.Client()}).Answer(context.Background(), Ask{Question: "hi"})
	if err == nil || !strings.Contains(err.Error(), "empty answer") {
		t.Fatalf("got %v", err)
	}
}

func TestLastFullSentence(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Have dal tonight.", "Have dal tonight."},
		{"Have dal tonight. Then try some roti with", "Have dal tonight."},
		{"First! Second? Third is cut", "First! Second?"},
		{"No terminator at all", ""},
		{"  ", ""},
		{"Done!", "Done!"},
		{"He said \"Go.\"", "He said \"Go.\""},
	}
	for _, c := range cases {
		if got := lastFullSentence(c.in); got != c.want {
			t.Errorf("%q: got %q want %q", c.in, got, c.want)
		}
	}
}
