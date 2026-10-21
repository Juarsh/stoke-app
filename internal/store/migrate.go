package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The embedded migrations (moved here from internal/db; the directory names,
// and so the schema_migrations names, are unchanged).

//go:embed migrations/*.sql
var v1 embed.FS

//go:embed migrations_v2/*.sql
var v2 embed.FS

// Open connects to Postgres and checks the connection.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	p, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := p.Ping(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

// Migrate applies V1 migrations, plus V2 tables when withV2 is set.
func Migrate(ctx context.Context, p *pgxpool.Pool, withV2 bool) error {
	if _, err := p.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	sets := []fs.FS{v1}
	if withV2 {
		sets = append(sets, v2)
	}
	for _, set := range sets {
		files, _ := fs.Glob(set, "*/*.sql")
		sort.Strings(files)
		for _, f := range files {
			var done bool
			if err := p.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=$1)`, f).Scan(&done); err != nil {
				return err
			}
			if done {
				continue
			}
			sql, _ := fs.ReadFile(set, f)
			tx, err := p.Begin(ctx)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, string(sql)); err != nil {
				tx.Rollback(ctx)
				return fmt.Errorf("migration %s: %w", f, err)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations(name) VALUES ($1)`, f); err != nil {
				tx.Rollback(ctx)
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
		}
	}
	return nil
}
