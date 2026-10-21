// Package db opens Postgres and applies the embedded migrations. The SQL and
// the migration files live in internal/store; this package keeps the old
// entry points for its callers.
package db

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/store"
)

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) { return store.Open(ctx, url) }

// Migrate applies V1 migrations, plus V2 tables when withV2 is set.
func Migrate(ctx context.Context, p *pgxpool.Pool, withV2 bool) error {
	return store.Migrate(ctx, p, withV2)
}
