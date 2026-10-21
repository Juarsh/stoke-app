// Command api serves the Khaana Count (working name) JSON API.
//
//	DATABASE_URL       postgres://calorie:calorie@localhost:5432/calorie
//	PORT               8080
//	AUTH_MODE          google (default) | dev (accepts "Bearer dev:<name>"; local / CI only, refused when APP_ENV=production)
//	GOOGLE_CLIENT_IDS  comma-separated OAuth client IDs (token audiences)
//	MIGRATE_V2         1 to also create the V2 tables
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/akarsh/calorie-tracker/internal/app"
	"github.com/akarsh/calorie-tracker/internal/auth"
	"github.com/akarsh/calorie-tracker/internal/db"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	if err := checkStubGuard(os.Getenv("AI_MODE"), os.Getenv("APP_ENV")); err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, env("DATABASE_URL", "postgres://calorie:calorie@localhost:5432/calorie"))
	if err != nil {
		log.Fatal(err)
	}
	if err := db.Migrate(ctx, pool, os.Getenv("MIGRATE_V2") == "1"); err != nil {
		log.Fatal(err)
	}
	v, err := auth.FromConfig(os.Getenv("AUTH_MODE"), os.Getenv("APP_ENV"), os.Getenv("GOOGLE_CLIENT_IDS"))
	if err != nil {
		log.Fatal(err)
	}
	if _, dev := v.(auth.DevVerifier); dev {
		log.Println("WARNING: AUTH_MODE=dev accepts unsigned dev tokens; local and CI only")
	}
	thinking := os.Getenv("GEMINI_THINKING_BUDGET")
	if !foodValidThinking(thinking) {
		log.Fatalf("GEMINI_THINKING_BUDGET must be empty, omit, or a non-negative integer (got %q)", thinking)
	}
	h, err := app.New(app.Config{DB: pool, Verifier: v, AIMode: os.Getenv("AI_MODE"), GeminiKey: os.Getenv("GEMINI_API_KEY"), GlobalAICap: globalCap(),
		AIPerMinute: intEnv("AI_PER_MINUTE", 8), GeminiModel: os.Getenv("GEMINI_MODEL"), GeminiRPM: intEnv("GEMINI_RPM", 10),
		GeminiThinking: thinking,
		UserAICap:      int64(intEnv("AI_USER_DAILY_CAP", 3)), QuotaResetTZ: os.Getenv("AI_QUOTA_RESET_TZ"),
		AIRequeueMax:  time.Duration(intEnv("AI_REQUEUE_MAX_MINUTES", 30)) * time.Minute,
		AIMaxAttempts: maxAttempts(),
		AdminToken:    adminToken()})
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: ":" + env("PORT", "8080"), Handler: h, ReadHeaderTimeout: 5 * time.Second}
	log.Printf("listening on %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}

// AI_GLOBAL_DAILY_CAP: project-wide AI calls per day (default 200, under the lowest reported free-tier Flash RPD; 0 = unlimited).
func globalCap() int64 {
	v := os.Getenv("AI_DAILY_CAP")
	if v == "" {
		v = os.Getenv("AI_GLOBAL_DAILY_CAP") // old name
	}
	if v == "" {
		return 20 // Gemini free tier: 20 requests/day/model
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		log.Fatalf("AI_DAILY_CAP must be a non-negative integer")
	}
	return n
}

// AI_MAX_ATTEMPTS: Gemini attempts per meal (parse job), default 3, at least 1.
func maxAttempts() int {
	n := intEnv("AI_MAX_ATTEMPTS", 3)
	if n < 1 {
		log.Fatalf("AI_MAX_ATTEMPTS must be at least 1")
	}
	return n
}

func intEnv(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Fatalf("%s must be an integer", k)
	}
	return n
}

// checkStubGuard refuses AI_MODE=stub unless APP_ENV is dev or test: stub
// mode exposes unauthenticated /test/ai/* hooks.
func checkStubGuard(aiMode, appEnv string) error {
	if aiMode == "stub" && appEnv != "dev" && appEnv != "test" {
		return fmt.Errorf("AI_MODE=stub needs APP_ENV=dev or test (got %q)", appEnv)
	}
	if aiMode == "gemini" && os.Getenv("GEMINI_API_KEY") == "" {
		return fmt.Errorf("AI_MODE=gemini needs GEMINI_API_KEY")
	}
	return nil
}

// ADMIN_TOKEN enables /admin/*; it must be long enough to be a real secret.
func foodValidThinking(v string) bool {
	switch o := strings.TrimSpace(strings.ToLower(v)); o {
	case "", "omit", "none", "off":
		return true
	default:
		_, err := strconv.Atoi(o)
		return err == nil
	}
}

func adminToken() string {
	t := os.Getenv("ADMIN_TOKEN")
	if t != "" && len(t) < 24 {
		log.Fatal("ADMIN_TOKEN must be at least 24 characters")
	}
	return t
}
