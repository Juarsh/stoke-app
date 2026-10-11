package food

import (
	"context"
	"errors"

	"github.com/akarsh/calorie-tracker/internal/parser"
)

// Fallback estimates meal text the dish table didn't recognise (Gemini in
// production). Implementations get ONLY the unmatched text, never anything
// that identifies the user. Returned items must use our units and are always
// flagged AIEstimate; the user confirms before saving.
type Fallback interface {
	Estimate(ctx context.Context, text string) ([]parser.Item, error)
}

var ErrNotConfigured = errors.New("ai fallback not configured")

// NoFallback is the default until the Gemini key is set up.
type NoFallback struct{}

func (NoFallback) Estimate(context.Context, string) ([]parser.Item, error) {
	return nil, ErrNotConfigured
}

// Gemini is the placeholder for the free-tier Gemini call (structured JSON
// output mapped to our units). Intentionally makes no network call yet.
type Gemini struct{ APIKey string }

func (g Gemini) Estimate(context.Context, string) ([]parser.Item, error) {
	return nil, ErrNotConfigured // TODO(day 4): call Gemini with a JSON schema response
}

// AICapPerDay is the per-user daily cap on fallback calls (spec v2: 20).
const AICapPerDay = 20
