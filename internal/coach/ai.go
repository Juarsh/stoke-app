package coach

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/akarsh/calorie-tracker/internal/food"
)

// ErrNotConfigured: no CoachAI adapter (AI_MODE=off, or no key).
var ErrNotConfigured = errors.New("coach ai not configured")

// Message is one prior chat turn sent with a question (max 6).
type Message struct {
	Role string `json:"role"` // "user" or "assistant"
	Text string `json:"text"`
}

// Ask is what the adapter sees: the question, trimmed history, and a compact
// context string (today's targets/totals/left, foods, last 7 days of training
// and habits). Implementations must not log secrets.
type Ask struct {
	Question string
	Messages []Message
	Context  string
}

// CoachAI is the config-chosen LLM behind POST /v1/coach (same idea as food's
// Fallback). Production uses Gemini on the free Flash tier; tests inject a fake.
type CoachAI interface {
	Answer(ctx context.Context, in Ask) (string, error)
}

// NoCoachAI is the default when AI_MODE is off.
type NoCoachAI struct{}

func (NoCoachAI) Answer(context.Context, Ask) (string, error) { return "", ErrNotConfigured }

// GeminiAI calls generateContent with a short system prompt and a 250-token cap.
// The API key is sent only as the x-goog-api-key header (never in the URL or logs).
type GeminiAI struct {
	APIKey  string
	Model   string        // default gemini-flash-latest (free-tier Flash)
	BaseURL string        // default https://generativelanguage.googleapis.com/v1beta
	Timeout time.Duration // default 8s
	Client  *http.Client
	// Thinking is GEMINI_THINKING_BUDGET, same meaning as food.Gemini.
	Thinking string
}

const (
	defaultFlashModel = "gemini-flash-latest"
	defaultGeminiURL  = "https://generativelanguage.googleapis.com/v1beta"
	maxOutputTokens   = 250
	coachSystemPrompt = `You are Stoke's coach for food, training and habits.
Use only the user context given to you. Answer briefly in plain language.
Do not diagnose or treat medical conditions; if asked, politely refuse and suggest seeing a clinician.
Do not invent foods, workouts, habits or numbers that are not in the context.`
)

func (g GeminiAI) model() string {
	if g.Model == "" {
		return defaultFlashModel
	}
	return g.Model
}

func (g GeminiAI) Answer(ctx context.Context, in Ask) (string, error) {
	if g.APIKey == "" {
		return "", ErrNotConfigured
	}
	model, base, to, cl := g.model(), g.BaseURL, g.Timeout, g.Client
	if base == "" {
		base = defaultGeminiURL
	}
	if to == 0 {
		to = 8 * time.Second
	}
	if cl == nil {
		cl = http.DefaultClient
	}
	sys := coachSystemPrompt
	if c := strings.TrimSpace(in.Context); c != "" {
		sys += "\n\nUser context:\n" + c
	}
	contents := geminiContents(in)
	if len(contents) == 0 {
		return "", errors.New("empty question")
	}
	gen := map[string]any{
		"maxOutputTokens": maxOutputTokens,
		"temperature":     0.4,
	}
	if tb, ok := food.ThinkingBudget(model, g.Thinking); ok {
		gen["thinkingConfig"] = map[string]any{"thinkingBudget": tb}
	}
	body, err := json.Marshal(map[string]any{
		"systemInstruction": map[string]any{"parts": []any{map[string]any{"text": sys}}},
		"contents":          contents,
		"generationConfig":  gen,
	})
	if err != nil {
		return "", err
	}
	actx, cancel := context.WithTimeout(ctx, to)
	defer cancel()
	req, err := http.NewRequestWithContext(actx, "POST", base+"/models/"+model+":generateContent", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", g.APIKey)
	res, err := cl.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(actx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("%w", context.DeadlineExceeded)
		}
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		return "", fmt.Errorf("gemini: http %d", res.StatusCode)
	}
	var gr struct {
		Candidates []struct {
			Content struct {
				Parts []struct{ Text string }
			}
		}
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&gr); err != nil {
		return "", err
	}
	if len(gr.Candidates) == 0 || len(gr.Candidates[0].Content.Parts) == 0 {
		return "", errors.New("gemini: empty answer")
	}
	out := strings.TrimSpace(gr.Candidates[0].Content.Parts[0].Text)
	if out == "" {
		return "", errors.New("gemini: empty answer")
	}
	return out, nil
}

func geminiContents(in Ask) []any {
	var contents []any
	for _, m := range in.Messages {
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		text := strings.TrimSpace(m.Text)
		if text == "" {
			continue
		}
		contents = append(contents, map[string]any{"role": role, "parts": []any{map[string]any{"text": text}}})
	}
	// Gemini wants the first turn to be "user"; drop a leading model turn.
	for len(contents) > 0 {
		c, _ := contents[0].(map[string]any)
		if c["role"] == "user" {
			break
		}
		contents = contents[1:]
	}
	q := strings.TrimSpace(in.Question)
	if q != "" {
		contents = append(contents, map[string]any{"role": "user", "parts": []any{map[string]any{"text": q}}})
	}
	return contents
}
