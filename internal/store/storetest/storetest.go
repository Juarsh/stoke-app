// Package storetest gives tests a fresh, migrated Postgres schema in the Stoke test database (TEST_STOKE_DB_URL,
// default calorie_stoke_test on localhost). Each call makes its own schema and drops it when the test ends, so tests
// never touch any other database.
package storetest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/db"
)

const defaultURL = "postgres://calorie:calorie@localhost:5432/calorie_stoke_test"

func URL() string {
	if u := os.Getenv("TEST_STOKE_DB_URL"); u != "" {
		return u
	}
	return defaultURL
}

// Schema opens a pool whose search_path is a new empty schema; migrate runs every migration in it.
func Schema(t testing.TB, migrate bool) (*pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "t_" + hex.EncodeToString(b)
	admin, err := pgxpool.New(ctx, URL())
	if err != nil {
		t.Skipf("no Stoke test database: %v", err)
	}
	if err := admin.Ping(ctx); err != nil {
		admin.Close()
		t.Skipf("no Stoke test database: %v", err)
	}
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+name); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(URL())
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = name
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), `DROP SCHEMA `+name+` CASCADE`)
		admin.Close()
	})
	if migrate {
		if err := db.Migrate(ctx, pool, true); err != nil {
			t.Fatal(err)
		}
	}
	return pool, name
}
