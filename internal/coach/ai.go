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
	APIKey string
	// Model defaults to DefaultGeminiModel (gemini-flash-lite-latest). GEMINI_MODEL overrides it.
	Model   string
	BaseURL string // default https://generativelanguage.googleapis.com/v1beta
	// Timeout defaults to DefaultAskTimeout (15s). The handler shares this budget.
	Timeout time.Duration
	Client  *http.Client
	// Thinking is GEMINI_THINKING_BUDGET, same meaning as food.Gemini.
	Thinking string
}

const (
	// DefaultGeminiModel is a free-tier Flash-Lite model: it is not a thinking
	// model (no thinkingConfig; Flash-Lite 400s on thinkingBudget) and answers
	// faster than gemini-flash-latest with thinkingBudget 0. GEMINI_MODEL overrides it.
	DefaultGeminiModel = "gemini-flash-lite-latest"
	defaultGeminiURL   = "https://generativelanguage.googleapis.com/v1beta"
	maxOutputTokens    = 250
	minRetryLeft       = 2 * time.Second
	coachSystemPrompt  = `You are Stoke's coach for food, training and habits.
Use only the user context given to you. Answer briefly in plain language.
Do not diagnose or treat medical conditions; if asked, politely refuse and suggest seeing a clinician.
Do not invent foods, workouts, habits or numbers that are not in the context.`
)

func (g GeminiAI) model() string {
	if g.Model == "" {
		return DefaultGeminiModel
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
		to = DefaultAskTimeout
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

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 && !retryBudgetLeft(actx) {
			return "", lastErr
		}
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
		raw, readErr := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		if readErr != nil && res.StatusCode == http.StatusOK {
			return "", readErr
		}
		if res.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("gemini: http %d", res.StatusCode)
			if geminiRetryable(res.StatusCode) && attempt == 0 {
				continue
			}
			return "", lastErr
		}
		answer, err := parseGeminiAnswer(raw)
		if err != nil {
			return "", err
		}
		return answer, nil
	}
	if lastErr == nil {
		lastErr = errors.New("gemini: empty answer")
	}
	return "", lastErr
}

func geminiRetryable(status int) bool {
	return status == http.StatusServiceUnavailable || status == http.StatusTooManyRequests
}

func retryBudgetLeft(ctx context.Context) bool {
	deadline, ok := ctx.Deadline()
	if !ok {
		return true
	}
	return time.Until(deadline) >= minRetryLeft
}

type geminiResponse struct {
	Candidates []struct {
		FinishReason string `json:"finishReason"`
		Content      struct {
			Parts []struct {
				Text    string `json:"text"`
				Thought bool   `json:"thought"`
			}
		}
	}
}

func parseGeminiAnswer(raw []byte) (string, error) {
	var gr geminiResponse
	if err := json.Unmarshal(raw, &gr); err != nil {
		return "", err
	}
	if len(gr.Candidates) == 0 {
		return "", errors.New("gemini: empty answer")
	}
	c := gr.Candidates[0]
	var b strings.Builder
	for _, p := range c.Content.Parts {
		if p.Thought {
			continue
		}
		b.WriteString(p.Text)
	}
	out := strings.TrimSpace(b.String())
	if strings.EqualFold(c.FinishReason, "MAX_TOKENS") {
		out = lastFullSentence(out)
	}
	if out == "" {
		return "", errors.New("gemini: empty answer")
	}
	return out, nil
}

// lastFullSentence keeps text through the last . ! or ?. A MAX_TOKENS cut-off
// with no complete sentence returns "" so the handler can fall back to rules.
func lastFullSentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if endsWithSentence(s) {
		return s
	}
	last := -1
	for i, r := range s {
		if r == '.' || r == '!' || r == '?' {
			last = i
		}
	}
	if last < 0 {
		return ""
	}
	return strings.TrimSpace(s[:last+1])
}

func endsWithSentence(s string) bool {
	s = strings.TrimRightFunc(s, func(r rune) bool {
		return r == '"' || r == '\'' || r == '”' || r == '’' || r == ')' || r == ']'
	})
	if s == "" {
		return false
	}
	r := []rune(s)
	last := r[len(r)-1]
	return last == '.' || last == '!' || last == '?'
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
