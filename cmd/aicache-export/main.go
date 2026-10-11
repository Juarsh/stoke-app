// Command aicache-export writes the most-hit cached AI answers of the last
// N days, with hit counts, for the weekly manual review (JSON or CSV).
// Reviewed dishes go back in through POST /admin/dishes/import (admin token)
// with a source note; the cache never becomes table rows automatically.
// The same data is at GET /admin/ai-cache/top?days=7&limit=50&format=csv.
//
//	DATABASE_URL=... go run ./cmd/aicache-export -days 7 -limit 50 -format csv > top.csv
package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"flag"
	"log"
	"os"

	"github.com/akarsh/calorie-tracker/internal/db"
	"github.com/akarsh/calorie-tracker/internal/food"
)

func main() {
	days := flag.Int("days", 7, "look-back window")
	limit := flag.Int("limit", 50, "rows")
	format := flag.String("format", "csv", "csv or json")
	flag.Parse()
	ctx := context.Background()
	pool, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	top, err := food.TopCache(ctx, pool, *days, *limit)
	if err != nil {
		log.Fatal(err)
	}
	switch *format {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", " ")
		err = enc.Encode(map[string]any{"days": *days, "top": top})
	case "csv":
		err = food.WriteCSV(csv.NewWriter(os.Stdout), top)
	default:
		log.Fatal("-format must be csv or json")
	}
	if err != nil {
		log.Fatal(err)
	}
}
