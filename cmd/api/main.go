// Command api serves the Khaana Count (working name) JSON API.
//
//	DATABASE_URL       postgres://calorie:calorie@localhost:5432/calorie
//	PORT               8080
//	AUTH_MODE          google (default) | dev (accepts "Bearer dev:<name>", local only)
//	GOOGLE_CLIENT_IDS  comma-separated OAuth client IDs (token audiences)
//	MIGRATE_V2         1 to also create the V2 tables
package main

import (
	"context"
	"log"
	"net/http"
	"os"
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
	ctx := context.Background()
	pool, err := db.Open(ctx, env("DATABASE_URL", "postgres://calorie:calorie@localhost:5432/calorie"))
	if err != nil {
		log.Fatal(err)
	}
	if err := db.Migrate(ctx, pool, os.Getenv("MIGRATE_V2") == "1"); err != nil {
		log.Fatal(err)
	}
	var v auth.Verifier
	switch env("AUTH_MODE", "google") {
	case "dev":
		log.Println("WARNING: AUTH_MODE=dev accepts unsigned dev tokens; never use in production")
		v = auth.DevVerifier{}
	default:
		ids := strings.Split(os.Getenv("GOOGLE_CLIENT_IDS"), ",")
		if ids[0] == "" {
			log.Fatal("GOOGLE_CLIENT_IDS is required unless AUTH_MODE=dev")
		}
		v = auth.NewGoogleVerifier(ids)
	}
	h, err := app.New(app.Config{DB: pool, Verifier: v})
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: ":" + env("PORT", "8080"), Handler: h, ReadHeaderTimeout: 5 * time.Second}
	log.Printf("listening on %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}
