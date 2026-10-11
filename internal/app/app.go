// Package app wires the domain modules into one http.Handler.
package app

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/activity"
	"github.com/akarsh/calorie-tracker/internal/auth"
	"github.com/akarsh/calorie-tracker/internal/coach"
	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/food"
	"github.com/akarsh/calorie-tracker/internal/goals"
	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/akarsh/calorie-tracker/internal/summary"
)

type Config struct {
	DB       *pgxpool.Pool
	Verifier auth.Verifier
	Fallback food.Fallback
	Advisor  coach.Advisor
	// AIMode: "off" (default), "gemini", or "stub" (deterministic fake;
	// also enables the /test/ai/* hooks, which 404 in every other mode).
	AIMode    string
	GeminiKey string
	// GlobalAICap is the project-wide daily AI call limit (0 = unlimited).
	GlobalAICap int64
	// AIPerMinute is the project-wide AI calls per minute (default 8; <0 = unlimited).
	AIPerMinute int
	GeminiModel string
	// Dishes overrides the embedded table (tests simulate table updates).
	Dishes []dishes.Dish
}

func New(c Config) (http.Handler, error) {
	if c.Dishes == nil {
		c.Dishes = dishes.MustLoad()
	}
	p, err := parser.New(c.Dishes)
	if err != nil {
		return nil, err
	}
	// keep every published table version so older offline entries validate
	vers, err := food.Publish(context.Background(), c.DB, c.Dishes, p)
	if err != nil {
		return nil, err
	}
	var stub *food.Stub
	if c.Fallback == nil {
		switch c.AIMode {
		case "stub":
			stub = &food.Stub{}
			c.Fallback = stub
		case "gemini":
			c.Fallback = food.Gemini{APIKey: c.GeminiKey, Model: c.GeminiModel}
		default:
			c.Fallback = food.NoFallback{}
		}
	}
	if c.Advisor == nil {
		c.Advisor = coach.NoAdvisor{}
	}
	sum := &summary.Service{DB: c.DB, Contributors: []summary.Contributor{food.Contributor{}, activity.Contributor{}}}
	gl := &goals.Service{DB: c.DB}
	fs := &food.Service{DB: c.DB, Parser: p, Fallback: c.Fallback, Summary: sum}
	fs.Versions = vers
	fs.GlobalCap.Store(c.GlobalAICap)
	if c.AIPerMinute == 0 {
		c.AIPerMinute = 8
	}
	fs.Limiter = food.NewLimiter(c.AIPerMinute)
	mods := []interface {
		Routes(*http.ServeMux, func(http.Handler) http.Handler)
	}{
		fs,
		&activity.Service{DB: c.DB, Summary: sum, Goals: gl},
		gl, sum,
		&coach.Service{Parser: p, Goals: gl, Summary: sum, Advisor: c.Advisor},
	}
	mux := http.NewServeMux()
	wrap := auth.Middleware(c.Verifier, auth.PGUsers{DB: c.DB})
	for _, m := range mods {
		m.Routes(mux, wrap)
	}
	if stub != nil {
		fs.TestRoutes(mux, stub)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]any{"ok": true, "time": time.Now().UTC()})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { httpx.Error(w, 404, "not found") })
	return mux, nil
}
