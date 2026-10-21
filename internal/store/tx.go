package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Repositories for the older domains (food, summary, goals, activity, AI
// jobs and usage, dish table versions). Each is reached from the pool (*PG)
// or from a transaction (*Tx) and runs the same statements either way.

// ErrNoRows is returned when a single-row read or a RETURNING write matched
// nothing (the same value as pgx.ErrNoRows).
var ErrNoRows = pgx.ErrNoRows

// IsValueOutOfRange: a write refused for a number no column can hold or a
// failed CHECK (numeric_value_out_of_range 22003, check_violation 23514).
func IsValueOutOfRange(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && (pe.Code == "22003" || pe.Code == "23514")
}

// Tx is one database transaction.
type Tx struct{ tx pgx.Tx }

// Begin starts a transaction on the pool.
func (s *PG) Begin(ctx context.Context) (*Tx, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &Tx{tx: tx}, nil
}

func (t *Tx) Commit(ctx context.Context) error   { return t.tx.Commit(ctx) }
func (t *Tx) Rollback(ctx context.Context) error { return t.tx.Rollback(ctx) }

// Querier is a handle the repositories run on: the pool (*PG) or a
// transaction (*Tx).
type Querier interface {
	Food() FoodRepo
	Activity() ActivityRepo
}

// repo implements every repository on one querier (pool or transaction).
type repo struct{ q querier }

func (s *PG) Food() FoodRepo         { return repo{s.DB} }
func (s *PG) Readings() ReadingRepo  { return repo{s.DB} }
func (s *PG) AI() AIRepo             { return repo{s.DB} }
func (s *PG) Jobs() JobRepo          { return repo{s.DB} }
func (s *PG) Dishes() DishRepo       { return repo{s.DB} }
func (s *PG) Summaries() SummaryRepo { return repo{s.DB} }
func (s *PG) Goals() GoalsRepo       { return repo{s.DB} }
func (s *PG) Activity() ActivityRepo { return repo{s.DB} }
func (t *Tx) Food() FoodRepo         { return repo{t.tx} }
func (t *Tx) Readings() ReadingRepo  { return repo{t.tx} }
func (t *Tx) AI() AIRepo             { return repo{t.tx} }
func (t *Tx) Jobs() JobRepo          { return repo{t.tx} }
func (t *Tx) Dishes() DishRepo       { return repo{t.tx} }
func (t *Tx) Summaries() SummaryRepo { return repo{t.tx} }
func (t *Tx) Goals() GoalsRepo       { return repo{t.tx} }
func (t *Tx) Activity() ActivityRepo { return repo{t.tx} }
