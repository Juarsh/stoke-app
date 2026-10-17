package food

import (
	"context"
	"net/http"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// TestRoutes registers the /test/ai/* hooks. Call it ONLY when AI_MODE=stub;
// otherwise the routes don't exist (404).
func (s *Service) TestRoutes(mux *http.ServeMux, stub *Stub) {
	mux.HandleFunc("GET /test/ai/calls", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]any{"calls": stub.Calls(), "global_daily_cap": s.GlobalCap.Load()})
	})
	mux.HandleFunc("POST /test/ai/calls/reset", func(w http.ResponseWriter, r *http.Request) {
		stub.Reset()
		_, _ = s.DB.Exec(r.Context(), `DELETE FROM ai_cache`)
		_, _ = s.DB.Exec(r.Context(), `DELETE FROM ai_global_usage`)
		_, _ = s.DB.Exec(r.Context(), `DELETE FROM ai_usage`)
		_, _ = s.DB.Exec(r.Context(), `DELETE FROM ai_google_exhausted`)
		s.Quota.ClearExhausted()
		httpx.JSON(w, 200, map[string]any{"calls": 0})
	})
	mux.HandleFunc("POST /test/ai/next-answer", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Items []struct {
				parser.Item
				SpanText *string `json:"span_text"` // same as the Gemini contract
			} `json:"items"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		items := make([]parser.Item, 0, len(in.Items))
		for _, x := range in.Items {
			it := x.Item
			if x.SpanText != nil {
				it.Matched = *x.SpanText
			}
			items = append(items, it)
		}
		stub.SetNext(items)
		httpx.JSON(w, 200, map[string]any{"ok": true})
	})
	// POST /test/ai/fail {"mode":"error"|"timeout"|"busy"|"unavailable"|"daily_limit"|"hang"|""}: every AI call fails
	// that way until mode "" (or /test/ai/calls/reset)
	mux.HandleFunc("POST /test/ai/fail", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Mode  string `json:"mode"`
			Times int    `json:"times"` // >0: only the next n calls fail
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		if in.Mode != "" && in.Mode != "error" && in.Mode != "timeout" && in.Mode != "busy" && in.Mode != "unavailable" && in.Mode != "daily_limit" && in.Mode != "hang" {
			httpx.Error(w, 400, "mode must be error, timeout, busy, unavailable, daily_limit, hang or empty")
			return
		}
		stub.SetFailTimes(in.Mode, in.Times)
		httpx.JSON(w, 200, map[string]any{"mode": in.Mode, "times": in.Times})
	})
	mux.HandleFunc("POST /test/ai/daily-cap", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Cap int64 `json:"cap"`
		}
		if !httpx.Decode(w, r, &in) || in.Cap < 0 {
			if in.Cap < 0 {
				httpx.Error(w, 400, "cap must be >= 0")
			}
			return
		}
		s.GlobalCap.Store(in.Cap)
		httpx.JSON(w, 200, map[string]any{"global_daily_cap": in.Cap})
	})
}

// StartAttemptForTest runs the pre-send step of one AI attempt (the charge
// and the "in_flight" ai_calls row, see startAICall) for a meal, so tests
// can race attempts at the cap boundary. ok=false: refused by AI_DAILY_CAP.
func (s *Service) StartAttemptForTest(ctx context.Context, userID int64, mealID string, later bool) (id int64, ok bool) {
	return s.startAICall(ctx, &Job{ID: mealID, UserID: userID}, later)
}
