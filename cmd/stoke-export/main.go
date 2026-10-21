// Command stoke-export dumps and restores Stoke data as JSON through plain Postgres (any host: local, Neon, ...).
//
//	stoke-export export [-user ID] [-out file]   all tables, or one user's rows (users.id = ID and every user_id table)
//	stoke-export import [-in file]               into a migrated database (runs the migrations first), one transaction
//
// DATABASE_URL picks the database (MIGRATE_V2=1 as for cmd/api). An import refuses rows that already exist: nothing is merged or overwritten.
// For a whole-database move with the schema too, scripts/db-move.sh (pg_dump / pg_restore) does the same job.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/akarsh/calorie-tracker/internal/db"
	"github.com/akarsh/calorie-tracker/internal/store"
)

func main() {
	if len(os.Args) < 2 || (os.Args[1] != "export" && os.Args[1] != "import") {
		fmt.Fprintln(os.Stderr, "usage: stoke-export export [-user ID] [-out file] | import [-in file]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	user := fs.Int64("user", 0, "export only this user id")
	out := fs.String("out", "-", "write the dump here (- = stdout)")
	in := fs.String("in", "-", "read the dump from here (- = stdin)")
	_ = fs.Parse(os.Args[2:])
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("DATABASE_URL is required")
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	s := &store.PG{DB: pool}
	if os.Args[1] == "export" {
		var uid *int64
		if *user > 0 {
			uid = user
		}
		d, err := s.Export(ctx, uid)
		if err != nil {
			log.Fatal(err)
		}
		w := io.Writer(os.Stdout)
		if *out != "-" {
			f, err := os.Create(*out)
			if err != nil {
				log.Fatal(err)
			}
			defer f.Close()
			w = f
		}
		enc := json.NewEncoder(w)
		if err := enc.Encode(d); err != nil {
			log.Fatal(err)
		}
		n := 0
		for _, rs := range d.Rows {
			n += len(rs)
		}
		log.Printf("exported %d rows from %d tables", n, len(d.Tables))
		return
	}
	r := io.Reader(os.Stdin)
	if *in != "-" {
		f, err := os.Open(*in)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		r = f
	}
	var d store.Dump
	if err := json.NewDecoder(r).Decode(&d); err != nil {
		log.Fatal(err)
	}
	if err := db.Migrate(ctx, pool, os.Getenv("MIGRATE_V2") == "1"); err != nil { // as cmd/api
		log.Fatal(err)
	}
	if err := s.Import(ctx, d); err != nil {
		log.Fatal(err)
	}
	log.Printf("imported %d tables", len(d.Tables))
}
