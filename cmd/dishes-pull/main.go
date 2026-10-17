// Command dishes-pull writes the newest published dish table (including
// admin imports) to internal/dishes/dishes.json so the repo and the app's
// offline copy stay canonical. Each dish carries supported_units: the units
// the server saves it in, for that same table version (the app's unit chips
// come from these). Commit the result and copy it to the app.
//
//	DATABASE_URL=... go run ./cmd/dishes-pull > internal/dishes/dishes.json
//	go run ./cmd/dishes-pull -repo > internal/dishes/dishes.json   (no DB: the
//	    repo's own table, e.g. to add supported_units after a rules change)
package main

import (
	"bytes"
	"context"
	"flag"
	"log"
	"os"

	"github.com/akarsh/calorie-tracker/internal/db"
	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/food"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

func main() {
	repo := flag.Bool("repo", false, "annotate the repo's embedded table instead of pulling from DATABASE_URL")
	flag.Parse()
	ctx := context.Background()
	var out []byte
	if *repo {
		p, err := parser.New(dishes.MustLoad())
		if err != nil {
			log.Fatal(err)
		}
		if out, err = food.AddUnits(dishes.Raw(), p.SupportedUnits); err != nil {
			log.Fatal(err)
		}
	} else {
		pool, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
		if err != nil {
			log.Fatal(err)
		}
		v, t, err := food.PullTable(ctx, pool)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("dish table version %d: %d dishes", v, bytes.Count(t, []byte(`"supported_units"`)))
		out = t
	}
	_, _ = os.Stdout.Write(out)
}
