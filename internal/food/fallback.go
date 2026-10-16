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
	"strconv"
	"strings"
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
	Timeout time.Duration // per HTTP attempt, default 8s (capped by the job's deadline)
	Client  *http.Client
	// Limiter spaces every attempt (GEMINI_RPM a minute, shared by all jobs).
	Limiter *Limiter
	// Backoff is the first retry's base delay (default 1s; tests set it small).
	Backoff time.Duration
	// Thinking is GEMINI_THINKING_BUDGET: "" = per-model default (see
	// ThinkingBudget), "omit" = never send thinkingConfig, or a number sent
	// as thinkingConfig.thinkingBudget.
	Thinking string
}

// ThinkingBudget returns the thinkingConfig.thinkingBudget to send for this
// model, or ok=false to leave thinkingConfig out of the request entirely.
// Default: Flash-Lite models reject thinkingBudget (HTTP 400
// INVALID_ARGUMENT on gemini-3.5-flash-lite), so they get none; every other
// model (gemini-flash-latest) gets 0, a lookup not a puzzle, which keeps the
// answer inside the 8 s timeout. GEMINI_THINKING_BUDGET overrides it.
func ThinkingBudget(model, override string) (int, bool) {
	switch o := strings.TrimSpace(strings.ToLower(override)); o {
	case "":
	case "omit", "none", "off":
		return 0, false
	default:
		if n, err := strconv.Atoi(o); err == nil {
			return n, true
		}
		return 0, false // invalid values are rejected at startup; be safe here
	}
	if strings.Contains(strings.ToLower(model), "flash-lite") {
		return 0, false
	}
	return 0, true
}

// ValidThinking reports whether a GEMINI_THINKING_BUDGET value is usable.
func ValidThinking(v string) bool {
	switch o := strings.TrimSpace(strings.ToLower(v)); o {
	case "", "omit", "none", "off":
		return true
	default:
		_, err := strconv.Atoi(o)
		return err == nil
	}
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

// ModelName: the Gemini model this client calls (for ai_calls).
func (g Gemini) ModelName() string {
	if g.Model == "" {
		return "gemini-flash-latest"
	}
	return g.Model
}

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
		to = 20 * time.Second
	}
	if cl == nil {
		cl = http.DefaultClient
	}
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
	gen := map[string]any{
		"responseMimeType": "application/json",
		"responseSchema":   geminiSchema,
		"temperature":      0,
	}
	if tb, ok := ThinkingBudget(model, g.Thinking); ok {
		gen["thinkingConfig"] = map[string]any{"thinkingBudget": tb}
	}
	body, _ := json.Marshal(map[string]any{
		"contents":         []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": geminiPrompt + "Meal: " + string(mt) + "\nSPANS (UTF-16 offsets, end exclusive): " + string(sj) + "\nHint: " + string(hj)}}}},
		"generationConfig": gen,
	})
	bo := g.Backoff
	if bo == 0 {
		bo = time.Second
	}
	var resp *http.Response
	for attempt := 1; ; attempt++ {
		fail := func(status int, gs string, gc int, kind string, lat time.Duration) *AIError {
			return &AIError{HTTPStatus: status, GoogleStatus: gs, GoogleCode: gc, Model: model, Attempts: attempt, Kind: kind}
		}
		if err := g.Limiter.Wait(ctx); err != nil {
			logAttempt(model, attempt, 0, "", 0, "rate_limited", 0, 0)
			return nil, fail(0, "", 0, "rate_limited", 0)
		}
		actx, cancel := context.WithTimeout(ctx, to)
		req, err := http.NewRequestWithContext(actx, "POST", base+"/models/"+model+":generateContent", bytes.NewReader(body))
		if err != nil {
			cancel()
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-goog-api-key", g.APIKey)
		t0 := time.Now()
		r, err := cl.Do(req)
		lat := time.Since(t0)
		if err != nil {
			countSend(ctx, 0)
			cancel()
			kind := "network"
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(actx.Err(), context.DeadlineExceeded) {
				kind = "timeout"
			}
			logAttempt(model, attempt, 0, "", 0, kind, lat, 0)
			e := fail(0, "", 0, kind, lat)
			return nil, fmt.Errorf("%w: %w", e, context.DeadlineExceeded) // keep timeout detectable
		}
		countSend(ctx, r.StatusCode)
		if r.StatusCode == 200 {
			resp = r
			defer cancel()
			break
		}
		var ge struct {
			Error struct {
				Code    int
				Status  string
				Details []struct {
					Type       string `json:"@type"`
					RetryDelay string `json:"retryDelay"`
					Violations []struct {
						QuotaID string `json:"quotaId"`
					} `json:"violations"`
				}
			}
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&ge)
		r.Body.Close()
		cancel()
		ri, qid := "", ""
		for _, d := range ge.Error.Details {
			if strings.HasSuffix(d.Type, "google.rpc.RetryInfo") {
				ri = d.RetryDelay
			}
			for _, v := range d.Violations {
				if isDailyQuota(v.QuotaID) {
					qid = v.QuotaID
				}
			}
		}
		e := fail(r.StatusCode, ge.Error.Status, ge.Error.Code, "http", lat)
		if r.StatusCode == 429 && qid != "" {
			// daily quota: retrying can't help until Google's reset
			e.DailyQuota, e.QuotaID = true, qid
			logAttempt(model, attempt, r.StatusCode, ge.Error.Status, ge.Error.Code, "daily_quota", lat, 0)
			return nil, e
		}
		if r.StatusCode == 400 {
			// our request was bad (e.g. thinkingConfig the model rejects):
			// never retried, never marks Google's daily quota exhausted
			e.Kind = "bad_request"
			logAttempt(model, attempt, r.StatusCode, ge.Error.Status, ge.Error.Code, "bad_request", lat, 0)
			return nil, e
		}
		if !retryable(r.StatusCode) || attempt > MaxRetries {
			logAttempt(model, attempt, r.StatusCode, ge.Error.Status, ge.Error.Code, "http", lat, 0)
			return nil, e
		}
		wait := retryDelay(r.Header, ri, attempt-1, bo)
		if dl, ok := ctx.Deadline(); ok && time.Now().Add(wait).After(dl) {
			logAttempt(model, attempt, r.StatusCode, ge.Error.Status, ge.Error.Code, "http", lat, 0)
			return nil, e // the retry wouldn't fit in the job's time limit
		}
		logAttempt(model, attempt, r.StatusCode, ge.Error.Status, ge.Error.Code, "http", lat, wait)
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, e
		}
	}
	defer resp.Body.Close()
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
	fail  string // "error" | "timeout" | "busy" | "unavailable" | "daily_limit" | "" : every call fails this way until cleared
}

// SetFail makes every following call fail ("error", "timeout") until "" is set.
func (s *Stub) SetFail(mode string) { s.mu.Lock(); defer s.mu.Unlock(); s.fail = mode }

func (s *Stub) Calls() int { s.mu.Lock(); defer s.mu.Unlock(); return s.calls }
func (s *Stub) Reset()     { s.mu.Lock(); defer s.mu.Unlock(); s.calls, s.next, s.fail = 0, nil, "" }
func (s *Stub) SetNext(items []parser.Item) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next = &items
}

// EstimateMeal follows the same contract as Gemini: one item per given
// span, positioned on it (name = the span's own words, so unknown dish words
// are never dropped). A next-answer override is returned exactly as set, so
// rule-breaking answers (overlapping or missing positions) reach the guard.
// ModelName: "stub" (for ai_calls).
func (s *Stub) ModelName() string { return "stub" }

func (s *Stub) EstimateMeal(ctx context.Context, text string, spans []Span, _ []parser.Item) ([]parser.Item, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	// one stub call is one HTTP send for cap counting: busy and daily_limit
	// are 429s (rejected before running, not counted); everything else counts
	switch s.fail {
	case "busy", "daily_limit":
		countSend(ctx, 429)
	case "unavailable":
		countSend(ctx, 503)
	case "timeout":
		countSend(ctx, 0)
	case "error":
		countSend(ctx, 500)
	default:
		countSend(ctx, 200)
	}
	switch s.fail {
	case "unavailable": // a 503 (Gemini overloaded): reached Gemini, busy
		return nil, &AIError{HTTPStatus: 503, GoogleStatus: "UNAVAILABLE", GoogleCode: 503, Model: "stub", Attempts: 1, Kind: "http"}
	case "error":
		return nil, errors.New("stub: forced error")
	case "timeout":
		return nil, fmt.Errorf("stub: forced timeout: %w", context.DeadlineExceeded)
	case "daily_limit": // a 429 naming the free tier's daily quota
		return nil, &AIError{HTTPStatus: 429, GoogleStatus: "RESOURCE_EXHAUSTED", GoogleCode: 429, Model: "stub", Attempts: 1, Kind: "http",
			DailyQuota: true, QuotaID: "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}
	case "busy": // what Gemini returns after its retries on 429
		return nil, &AIError{HTTPStatus: 429, GoogleStatus: "RESOURCE_EXHAUSTED", GoogleCode: 429, Model: "stub", Attempts: MaxRetries + 1, Kind: "http"}
	}
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
