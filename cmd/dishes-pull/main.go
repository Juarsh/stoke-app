// Command dishes-pull writes the newest published dish table (including
// admin imports) to internal/dishes/dishes.json so the repo and the app's
// offline copy stay canonical. Commit the result.
//
//	DATABASE_URL=... go run ./cmd/dishes-pull > internal/dishes/dishes.json
package main

import (
	"context"
	"encoding/json"
	"log"
	"os"

	"github.com/akarsh/calorie-tracker/internal/db"
)

func main() {
	ctx := context.Background()
	pool, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT snapshot FROM dish_table_versions ORDER BY version DESC LIMIT 1`).Scan(&raw); err != nil {
		log.Fatal(err)
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		log.Fatal(err)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Fatal(err)
	}
}
