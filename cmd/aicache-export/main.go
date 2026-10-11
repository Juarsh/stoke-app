// Command aicache-export writes the most-used cached AI answers of the last
// N days as CSV for the weekly manual review. Reviewed dishes are added to
// dishes.json by hand against a real source; the cache itself never becomes
// table rows automatically. Run weekly, e.g. cron: 0 9 * * MON.
//
//	DATABASE_URL=... go run ./cmd/aicache-export -days 7 -limit 50 > top.csv
package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/akarsh/calorie-tracker/internal/db"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

func main() {
	days := flag.Int("days", 7, "look-back window")
	limit := flag.Int("limit", 50, "rows")
	flag.Parse()
	ctx := context.Background()
	pool, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT norm_text, hits, items, created_at::date::text FROM ai_cache
		WHERE last_hit_at > now() - make_interval(days => $1) ORDER BY hits DESC, norm_text LIMIT $2`, *days, *limit)
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()
	w := csv.NewWriter(os.Stdout)
	_ = w.Write([]string{"text", "hits", "first_seen", "ai_name", "qty", "unit", "kcal_best", "kcal_low", "kcal_high", "protein_best", "review_status"})
	for rows.Next() {
		var text, first string
		var hits int
		var raw []byte
		if err := rows.Scan(&text, &hits, &raw, &first); err != nil {
			log.Fatal(err)
		}
		var items []parser.Item
		_ = json.Unmarshal(raw, &items)
		for _, it := range items {
			f := func(x float64) string { return fmt.Sprint(x) }
			_ = w.Write([]string{text, fmt.Sprint(hits), first, it.Name, f(it.Quantity), it.Unit, f(it.Kcal.Best), f(it.Kcal.Low), f(it.Kcal.High), f(it.Protein.Best), "unreviewed"})
		}
	}
	w.Flush()
}
