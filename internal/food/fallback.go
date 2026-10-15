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
//
// The WHOLE meal text goes in one call; the rule-based parse is only a hint.
type Fallback interface {
	// spans are the unclaimed parts of text: return items only for them,
	// each with span_start/span_end (UTF-16, end exclusive) inside one span.
	EstimateMeal(ctx context.Context, text string, spans []Span, hint []parser.Item) ([]parser.Item, error)
}

var ErrNotConfigured = errors.New("ai fallback not configured")

// NoFallback is the default until the Gemini key is set up (AI_MODE=off).
type NoFallback struct{}

func (NoFallback) EstimateMeal(context.Context, string, []Span, []parser.Item) ([]parser.Item, error) {
	return nil, ErrNotConfigured
}

// Gemini calls the REST generateContent API once per meal with a strict
// JSON response schema. Errors and timeouts return an error, which the
// caller turns into generic confirm cards.
type Gemini struct {
	APIKey  string
	Model   string        // default gemini-flash-latest (2.5-flash is closed to new keys)
	BaseURL string        // default https://generativelanguage.googleapis.com/v1beta (tests point it at a fake server)
	Timeout time.Duration // default 8s
	Client  *http.Client
}

var geminiItem = map[string]any{
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
		"span_start":   map[string]any{"type": "INTEGER"},
		"span_end":     map[string]any{"type": "INTEGER"},
		"span_text":    map[string]any{"type": "STRING"},
	},
	"required": []string{"name", "span_start", "span_end", "span_text", "quantity", "unit", "kcal_low", "kcal_best", "kcal_high", "protein_low", "protein_best", "protein_high", "carbs_g", "fat_g"},
}

var geminiSchema = map[string]any{
	"type":       "OBJECT",
	"properties": map[string]any{"items": map[string]any{"type": "ARRAY", "items": geminiItem}},
	"required":   []string{"items"},
}

const geminiPrompt = `You estimate nutrition for one meal an Indian user typed in Hinglish, Hindi or English.
Return one item per food eaten, with the quantity and unit as the user said them (or one typical
Indian home serving if they gave none). Typical portions: katori = 150 g, plate = 300 g, glass = 250 ml,
spoon = 5 g, roti = 40 g. kcal_low <= kcal_best <= kcal_high, and make the range honest about doubt.
"X with Y, 1 bowl" means one bowl in total. Only the listed SPANS still need an answer (the rest of the
text is already logged); return items only for those spans, each with span_start/span_end inside one span
and span_text copied exactly from the text. Cooking-style words (tandoori, masala, fry) describe a dish,
they are not separate foods. A dictionary parser's guess is included as a HINT ONLY: it may be wrong,
miss foods, or split them badly. Answer only with JSON matching the schema.
`

func (g Gemini) EstimateMeal(ctx context.Context, text string, spans []Span, hint []parser.Item) ([]parser.Item, error) {
	if g.APIKey == "" {
		return nil, ErrNotConfigured
	}
	model, base, to, cl := g.Model, g.BaseURL, g.Timeout, g.Client
	if model == "" {
		model = "gemini-flash-latest"
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
	type h struct {
		Name     string  `json:"name"`
		Quantity float64 `json:"quantity"`
		Unit     string  `json:"unit"`
		Kcal     float64 `json:"kcal"`
	}
	hs := []h{}
	for _, it := range hint {
		hs = append(hs, h{it.Name, it.Quantity, it.Unit, it.Kcal.Best})
	}
	hj, _ := json.Marshal(hs)
	mt, _ := json.Marshal(text)
	sj, _ := json.Marshal(spans)
	body, _ := json.Marshal(map[string]any{
		"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": geminiPrompt + "Meal: " + string(mt) + "\nSPANS (UTF-16 offsets, end exclusive): " + string(sj) + "\nHint: " + string(hj)}}}},
		"generationConfig": map[string]any{
			"responseMimeType": "application/json",
			"responseSchema":   geminiSchema,
			"temperature":      0,
			"thinkingConfig":   map[string]any{"thinkingBudget": 0}, // a lookup, not a puzzle: keeps the answer inside the 8s timeout
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
		var ge struct {
			Error struct{ Status, Message string }
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&ge)
		msg := ge.Error.Message
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, fmt.Errorf("gemini: status %d %s: %s", resp.StatusCode, ge.Error.Status, msg)
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
			SpanStart   int     `json:"span_start"`
			SpanEnd     int     `json:"span_end"`
			SpanText    string  `json:"span_text"`
		}
	}
	if err := json.Unmarshal([]byte(gr.Candidates[0].Content.Parts[0].Text), &out); err != nil {
		return nil, fmt.Errorf("gemini: bad json: %w", err)
	}
	var res []parser.Item
	for _, it := range out.Items {
		if it.Quantity <= 0 || it.KcalLow > it.KcalBest || it.KcalBest > it.KcalHigh || it.ProteinLow > it.ProteinBest || it.ProteinBest > it.ProteinHigh {
			return nil, errors.New("gemini: invalid ranges")
		}
		res = append(res, parser.Item{Name: it.Name, AIName: it.Name, Matched: it.SpanText, SpanStart: it.SpanStart, SpanEnd: it.SpanEnd,
			Quantity: it.Quantity, Unit: it.Unit, Grams: it.Grams,
			Kcal:    parser.Range{Low: it.KcalLow, Best: it.KcalBest, High: it.KcalHigh},
			Protein: parser.Range{Low: it.ProteinLow, Best: it.ProteinBest, High: it.ProteinHigh},
			CarbsG:  it.CarbsG, FatG: it.FatG})
	}
	if len(res) == 0 {
		return nil, errors.New("gemini: no items")
	}
	return res, nil
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

// EstimateMeal follows the same contract as Gemini: one item per given
// span, positioned on it (name = the span's own words, so unknown dish words
// are never dropped). A next-answer override is returned exactly as set, so
// rule-breaking answers (overlapping or missing positions) reach the guard.
func (s *Stub) EstimateMeal(_ context.Context, text string, spans []Span, _ []parser.Item) ([]parser.Item, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.next != nil {
		out := append([]parser.Item(nil), (*s.next)...)
		s.next = nil
		return out, nil // verbatim: bad offsets must reach placeAI, the server guard
	}
	var out []parser.Item
	for _, sp := range spans {
		h := fnv.New32a()
		h.Write([]byte(text + "|" + sp.Text))
		v := float64(h.Sum32())
		k := math.Round(80 + math.Mod(v, 400))
		p := math.Round((2+math.Mod(v/7, 20))*10) / 10
		out = append(out, parser.Item{Name: sp.Text, AIName: sp.Text, Matched: sp.Text, SpanStart: sp.Start, SpanEnd: sp.End,
			Quantity: 1, Unit: "count",
			Kcal:    parser.Range{Low: math.Round(k * 0.7), Best: k, High: math.Round(k * 1.4)},
			Protein: parser.Range{Low: math.Round(p*7) / 10, Best: p, High: math.Round(p*14) / 10}})
	}
	return out, nil
}

// AICapPerDay is the per-user daily cap on fallback calls (spec v2: 20).
// Since a meal makes at most one call, this is 20 AI-assisted meals a day.
const AICapPerDay = 20
