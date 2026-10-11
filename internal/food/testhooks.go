package food

import (
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
		httpx.JSON(w, 200, map[string]any{"calls": 0})
	})
	mux.HandleFunc("POST /test/ai/next-answer", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Items []parser.Item `json:"items"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		stub.SetNext(in.Items)
		httpx.JSON(w, 200, map[string]any{"ok": true})
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
