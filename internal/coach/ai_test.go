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
