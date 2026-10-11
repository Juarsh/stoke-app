package food

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Versions keeps every published dish table (snapshots in Postgres) and a
// parser per version, built on first use.
type Versions struct {
	DB      *pgxpool.Pool
	Current int
	mu      sync.Mutex
	parsers map[int]*parser.Parser
}

var ErrUnknownVersion = errors.New("unknown dish table version")

// Publish stores the running table as its version's snapshot. Publishing a
// different table under an existing version number is refused: every
// change to dishes.json must bump the version.
func Publish(ctx context.Context, db *pgxpool.Pool, ds []dishes.Dish, p *parser.Parser) (*Versions, error) {
	b, err := json.Marshal(ds)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	h := hex.EncodeToString(sum[:])
	v := dishes.TableVersion(ds)
	var stored string
	err = db.QueryRow(ctx, `INSERT INTO dish_table_versions(version,sha256,snapshot) VALUES ($1,$2,$3)
		ON CONFLICT (version) DO UPDATE SET version=EXCLUDED.version RETURNING sha256`, v, h, b).Scan(&stored)
	if err != nil {
		return nil, err
	}
	if stored != h {
		return nil, fmt.Errorf("dish table version %d was already published with different contents; bump the version", v)
	}
	return &Versions{DB: db, Current: v, parsers: map[int]*parser.Parser{v: p}}, nil
}

// Parser returns the parser for a known version, or ErrUnknownVersion.
func (vs *Versions) Parser(ctx context.Context, v int) (*parser.Parser, error) {
	vs.mu.Lock()
	defer vs.mu.Unlock()
	if p, ok := vs.parsers[v]; ok {
		return p, nil
	}
	var raw []byte
	err := vs.DB.QueryRow(ctx, `SELECT snapshot FROM dish_table_versions WHERE version=$1`, v).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnknownVersion
	}
	if err != nil {
		return nil, err
	}
	var ds []dishes.Dish
	if err := json.Unmarshal(raw, &ds); err != nil {
		return nil, err
	}
	p, err := parser.New(ds)
	if err != nil {
		return nil, err
	}
	vs.parsers[v] = p
	return p, nil
}

// Known lists the published versions.
func (vs *Versions) Known(ctx context.Context) []int {
	out := []int{}
	rows, err := vs.DB.Query(ctx, `SELECT version FROM dish_table_versions ORDER BY version`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var v int
		if rows.Scan(&v) == nil {
			out = append(out, v)
		}
	}
	return out
}

// Adopt makes a newly published version current (keeps the old parsers).
func (vs *Versions) Adopt(n *Versions) {
	vs.mu.Lock()
	defer vs.mu.Unlock()
	for v, p := range n.parsers {
		vs.parsers[v] = p
	}
	if n.Current > vs.Current {
		vs.Current = n.Current
	}
}

// Latest loads the newest published snapshot if it's newer than have.
func (vs *Versions) Latest(ctx context.Context, have int) (*parser.Parser, int, error) {
	var v int
	if err := vs.DB.QueryRow(ctx, `SELECT COALESCE(MAX(version),0) FROM dish_table_versions`).Scan(&v); err != nil || v <= have {
		return nil, have, err
	}
	p, err := vs.Parser(ctx, v)
	if err != nil {
		return nil, have, err
	}
	vs.mu.Lock()
	vs.Current = v
	vs.mu.Unlock()
	return p, v, nil
}
