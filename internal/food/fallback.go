package food

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/akarsh/calorie-tracker/internal/parser"
)

// Fallback estimates meal text the dish table didn't recognise (Gemini in
// production). It is called at most ONCE per meal with every unknown span
// batched together, and only for spans missing from the shared cache.
// Implementations get ONLY the normalized spans, never anything that
// identifies the user. Results are always flagged ai_estimate and need
// confirmation.
type Fallback interface {
	EstimateBatch(ctx context.Context, spans []string) (map[string][]parser.Item, error)
}

var ErrNotConfigured = errors.New("ai fallback not configured")

// NoFallback is the default until the Gemini key is set up (AI_MODE=off).
type NoFallback struct{}

func (NoFallback) EstimateBatch(context.Context, []string) (map[string][]parser.Item, error) {
	return nil, ErrNotConfigured
}

// Gemini calls the REST generateContent API once per meal with a strict
// JSON response schema. Errors and timeouts return an error, which the
// caller turns into generic confirm cards.
type Gemini struct {
	APIKey  string
	Model   string        // default gemini-2.5-flash
	BaseURL string        // default https://generativelanguage.googleapis.com/v1beta (tests point it at a fake server)
	Timeout time.Duration // default 8s
	Client  *http.Client
}

var geminiSchema = map[string]any{
	"type": "OBJECT",
	"properties": map[string]any{
		"results": map[string]any{
			"type": "ARRAY",
			"items": map[string]any{
				"type": "OBJECT",
				"properties": map[string]any{
					"span": map[string]any{"type": "STRING"},
					"items": map[string]any{
						"type": "ARRAY",
						"items": map[string]any{
							"type": "OBJECT",
							"properties": map[string]any{
								"name":         map[string]any{"type": "STRING"},
								"quantity":     map[string]any{"type": "NUMBER"},
								"unit":         map[string]any{"type": "STRING", "enum": []string{"count", "piece", "katori", "plate", "glass", "cup", "spoon", "g", "ml", "slice", "bowl"}},
								"grams":        map[string]any{"type": "NUMBER"},
								"kcal_low":     map[string]any{"type": "NUMBER"},
								"kcal_best":    map[string]any{"type": "NUMBER"},
								"kcal_high":    map[string]any{"type": "NUMBER"},
								"protein_low":  map[string]any{"type": "NUMBER"},
								"protein_best": map[string]any{"type": "NUMBER"},
								"protein_high": map[string]any{"type": "NUMBER"},
								"carbs_g":      map[string]any{"type": "NUMBER"},
								"fat_g":        map[string]any{"type": "NUMBER"},
							},
							"required": []string{"name", "quantity", "unit", "kcal_low", "kcal_best", "kcal_high", "protein_low", "protein_best", "protein_high", "carbs_g", "fat_g"},
						},
					},
				},
				"required": []string{"span", "items"},
			},
		},
	},
	"required": []string{"results"},
}

const geminiPrompt = `You estimate nutrition for Indian home-style food described in Hinglish, Hindi or English.
For EACH span below, return one result whose "span" is copied exactly, with one item per food in it,
for ONE typical serving (the count is handled separately). Use typical Indian home portions:
katori = 150 g, plate = 300 g, glass = 250 ml, spoon = 5 g. kcal_low <= kcal_best <= kcal_high.
If a span is not food, return it with an empty items list. Answer only with JSON matching the schema.
Spans:
`

func (g Gemini) EstimateBatch(ctx context.Context, spans []string) (map[string][]parser.Item, error) {
	if g.APIKey == "" {
		return nil, ErrNotConfigured
	}
	model, base, to, cl := g.Model, g.BaseURL, g.Timeout, g.Client
	if model == "" {
		model = "gemini-2.5-flash"
	}
	if base == "" {
		base = "https://generativelanguage.googleapis.com/v1beta"
	}
	if to == 0 {
		to = 8 * time.Second
	}
	if cl == nil {
		cl = http.DefaultClient
	}
	ctx, cancel := context.WithTimeout(ctx, to)
	defer cancel()
	list, _ := json.Marshal(spans)
	body, _ := json.Marshal(map[string]any{
		"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": geminiPrompt + string(list)}}}},
		"generationConfig": map[string]any{
			"responseMimeType": "application/json",
			"responseSchema":   geminiSchema,
			"temperature":      0,
		},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/models/"+model+":generateContent", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", g.APIKey)
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("gemini: status %d", resp.StatusCode)
	}
	var gr struct {
		Candidates []struct {
			Content struct {
				Parts []struct{ Text string }
			}
		}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&gr); err != nil {
		return nil, err
	}
	if len(gr.Candidates) == 0 || len(gr.Candidates[0].Content.Parts) == 0 {
		return nil, errors.New("gemini: empty answer")
	}
	var out struct {
		Results []struct {
			Span  string
			Items []struct {
				Name        string
				Quantity    float64
				Unit        string
				Grams       float64
				KcalLow     float64 `json:"kcal_low"`
				KcalBest    float64 `json:"kcal_best"`
				KcalHigh    float64 `json:"kcal_high"`
				ProteinLow  float64 `json:"protein_low"`
				ProteinBest float64 `json:"protein_best"`
				ProteinHigh float64 `json:"protein_high"`
				CarbsG      float64 `json:"carbs_g"`
				FatG        float64 `json:"fat_g"`
			}
		}
	}
	if err := json.Unmarshal([]byte(gr.Candidates[0].Content.Parts[0].Text), &out); err != nil {
		return nil, fmt.Errorf("gemini: bad json: %w", err)
	}
	asked := map[string]bool{}
	for _, s := range spans {
		asked[s] = true
	}
	res := map[string][]parser.Item{}
	for _, r := range out.Results {
		if !asked[r.Span] { // ignore anything we didn't ask about
			continue
		}
		for _, it := range r.Items {
			if it.Quantity <= 0 || it.KcalLow > it.KcalBest || it.KcalBest > it.KcalHigh {
				continue
			}
			res[r.Span] = append(res[r.Span], parser.Item{Name: it.Name, Matched: r.Span, Quantity: it.Quantity, Unit: it.Unit, Grams: it.Grams,
				Kcal:    parser.Range{Low: it.KcalLow, Best: it.KcalBest, High: it.KcalHigh},
				Protein: parser.Range{Low: it.ProteinLow, Best: it.ProteinBest, High: it.ProteinHigh},
				CarbsG:  it.CarbsG, FatG: it.FatG})
		}
	}
	return res, nil
}

// Limiter is a global sliding one-minute window on AI calls (per process).
type Limiter struct {
	mu    sync.Mutex
	limit int
	times []time.Time
	now   func() time.Time
}

func NewLimiter(perMinute int) *Limiter { return &Limiter{limit: perMinute, now: time.Now} }

// Allow reserves one call if fewer than limit calls happened in the last minute.
func (l *Limiter) Allow() bool {
	if l == nil || l.limit <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	keep := l.times[:0]
	for _, t := range l.times {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	l.times = keep
	if len(l.times) >= l.limit {
		return false
	}
	l.times = append(l.times, now)
	return true
}

// Stub is a deterministic fake Gemini (AI_MODE=stub) for tests and local
// runs: each span gets one item whose numbers come from a hash of the text.
// SetNext overrides the next call's answer: Items is returned for every span.
type Stub struct {
	mu    sync.Mutex
	calls int
	next  *[]parser.Item
}

func (s *Stub) Calls() int { s.mu.Lock(); defer s.mu.Unlock(); return s.calls }
func (s *Stub) Reset()     { s.mu.Lock(); defer s.mu.Unlock(); s.calls, s.next = 0, nil }
func (s *Stub) SetNext(items []parser.Item) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next = &items
}

func (s *Stub) EstimateBatch(_ context.Context, spans []string) (map[string][]parser.Item, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	out := map[string][]parser.Item{}
	if s.next != nil {
		for _, sp := range spans {
			out[sp] = append([]parser.Item(nil), (*s.next)...)
		}
		s.next = nil
		return out, nil
	}
	for _, sp := range spans {
		h := fnv.New32a()
		h.Write([]byte(sp))
		v := float64(h.Sum32())
		k := 150 + math.Mod(v, 300)
		p := 3 + math.Mod(v/7, 20)
		k, p = math.Round(k), math.Round(p*10)/10
		out[sp] = []parser.Item{{Name: sp, Matched: sp, Quantity: 1, Unit: "count",
			Kcal:    parser.Range{Low: math.Round(k * 0.7), Best: k, High: math.Round(k * 1.4)},
			Protein: parser.Range{Low: math.Round(p*7) / 10, Best: p, High: math.Round(p*14) / 10}}}
	}
	return out, nil
}

// AICapPerDay is the per-user daily cap on fallback calls (spec v2: 20).
// Since a meal makes at most one call, this is 20 AI-assisted meals a day.
const AICapPerDay = 20
