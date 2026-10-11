package food

import (
	"context"
	"errors"
	"hash/fnv"
	"math"
	"sync"

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

// Gemini is the placeholder for the free-tier call (structured JSON output
// mapped to our units). Intentionally makes no network call yet.
type Gemini struct{ APIKey string }

func (g Gemini) EstimateBatch(context.Context, []string) (map[string][]parser.Item, error) {
	return nil, ErrNotConfigured // TODO: one generateContent call with a JSON schema for all spans
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
