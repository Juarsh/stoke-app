// Package app wires the domain modules into one http.Handler.
package app

import (
	"context"
	"fmt"
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
	// GlobalAICap is the project-wide daily AI call limit (AI_DAILY_CAP,
	// default 20 = the free tier's requests per day per model; 0 = unlimited).
	GlobalAICap int64
	// UserAICap is the per-user daily AI call limit (AI_USER_DAILY_CAP, default 3; <0 = unlimited).
	UserAICap int64
	// QuotaResetTZ: the zone whose midnight resets the caps (AI_QUOTA_RESET_TZ,
	// default America/Los_Angeles, when Google resets its daily quota).
	QuotaResetTZ string
	// AIPerMinute is the queue drain rate: AI calls per minute (default 8; <0 = no spacing).
	AIPerMinute int
	// AIQueueMax: waiting AI jobs before parse answers fallback "busy" (default 500).
	AIQueueMax int
	// AIRequeueMax: how long a busy AI job keeps being requeued, from its
	// first try, before it ends as gave_up (AI_REQUEUE_MAX_MINUTES, default 30 min).
	AIRequeueMax time.Duration
	GeminiModel  string
	// GeminiRPM spaces Gemini HTTP attempts, retries included (GEMINI_RPM, default 10).
	GeminiRPM int
	// GeminiThinking is GEMINI_THINKING_BUDGET: "" = per-model default,
	// "omit" = never send thinkingConfig, or a non-negative integer.
	GeminiThinking string
	// AdminToken enables /admin/* (Bearer token); empty = routes 404.
	AdminToken string
	// Dishes overrides the embedded table (tests simulate table updates).
	Dishes []dishes.Dish
	// QueueCtx bounds the AI queue worker (default: runs for the process's
	// life). Cancelling it stops the worker like a process exit; pending
	// jobs stay in ai_parse_jobs for the next start (tests simulate restarts).
	QueueCtx context.Context
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
			rpm := c.GeminiRPM
			if rpm == 0 {
				rpm = 10
			}
			c.Fallback = food.Gemini{APIKey: c.GeminiKey, Model: c.GeminiModel, Limiter: food.NewLimiter(rpm), Thinking: c.GeminiThinking}
		default:
			c.Fallback = food.NoFallback{}
		}
	}
	if c.Advisor == nil {
		c.Advisor = coach.NoAdvisor{}
	}
	sum := &summary.Service{DB: c.DB, Contributors: []summary.Contributor{food.Contributor{}, activity.Contributor{}}}
	gl := &goals.Service{DB: c.DB}
	live := &food.Live{}
	live.Set(p)
	// a table imported by an admin (newer than the embedded one) wins
	if np, _, err := vers.Latest(context.Background(), dishes.TableVersion(c.Dishes)); err != nil {
		return nil, err
	} else if np != nil {
		live.Set(np)
	}
	fs := &food.Service{DB: c.DB, Parser: p, Live: live, Fallback: c.Fallback, Summary: sum}
	fs.Versions = vers
	fs.GlobalCap.Store(c.GlobalAICap)
	tz := c.QuotaResetTZ
	if tz == "" {
		tz = food.DefaultResetTZ
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("AI_QUOTA_RESET_TZ %q: %w", tz, err)
	}
	fs.Quota = &food.Quota{Reset: loc}
	fs.Quota.LoadExhausted(context.Background(), c.DB, time.Now())
	switch {
	case c.UserAICap == 0:
		fs.Quota.UserCap.Store(food.DefaultUserDailyCap)
	case c.UserAICap > 0:
		fs.Quota.UserCap.Store(c.UserAICap)
	}
	if c.AIPerMinute == 0 {
		c.AIPerMinute = 8
	}
	if c.AIQueueMax <= 0 {
		c.AIQueueMax = 500
	}
	q := food.NewQueue(c.AIPerMinute, c.AIQueueMax)
	q.SetRequeueMax(c.AIRequeueMax)
	qctx := c.QueueCtx
	if qctx == nil {
		qctx = context.Background()
	}
	fs.Start(qctx, q)
	mods := []interface {
		Routes(*http.ServeMux, func(http.Handler) http.Handler)
	}{
		fs,
		&activity.Service{DB: c.DB, Summary: sum, Goals: gl},
		gl, sum,
		&coach.Service{Parser: p, Table: live.Get, Goals: gl, Summary: sum, Advisor: c.Advisor},
	}
	mux := http.NewServeMux()
	wrap := auth.Middleware(c.Verifier, auth.PGUsers{DB: c.DB})
	for _, m := range mods {
		m.Routes(mux, wrap)
	}
	if stub != nil {
		fs.TestRoutes(mux, stub)
	}
	fs.AdminRoutes(mux, c.AdminToken)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]any{"ok": true, "time": time.Now().UTC()})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) { httpx.JSON(w, 200, version()) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { httpx.Error(w, 404, "not found") })
	return mux, nil
}
