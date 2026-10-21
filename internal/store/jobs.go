package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// JobRow is one ai_parse_jobs row as stored (payload and result are JSON;
// package food decodes them). Nullable times are nil when NULL.
type JobRow struct {
	ID, Text, Key, Slot, Status, LastBusy string
	UserID                                int64
	Payload, Result                       []byte
	Requeues, Attempts                    int
	NextAttempt, LeaseUntil, FirstTry     *time.Time
	Created                               time.Time
	Finished                              *time.Time
}

// JobScan is one row of a list read: the row, or the error scanning it.
type JobScan struct {
	Row JobRow
	Err error
}

// JobRepo: durable AI parse jobs (ai_parse_jobs, package food's queue).
type JobRepo interface {
	InsertJob(ctx context.Context, id string, userID int64, text, key, slot string, payload []byte, created time.Time) error
	// Job: a job by id for its owner (ErrNoRows: none).
	Job(ctx context.Context, userID int64, id string) (JobRow, error)
	// JobByID: a job by id (ErrNoRows: none).
	JobByID(ctx context.Context, id string) (JobRow, error)
	// ClaimJob takes the lease for one attempt and scans first_try_at and attempts (ErrNoRows: not claimable).
	ClaimJob(ctx context.Context, id string, leaseUntil, now time.Time, requeues, maxAttempts int, firstTry *time.Time, attempts *int) error
	// SaveRequeue: firstTry is a time.Time or nil.
	SaveRequeue(ctx context.Context, id string, requeues int, lastBusy string, notBefore time.Time, firstTry any) error
	// SaveDone stores the result of a pending job; it returns the rows changed. firstTry is a time.Time or nil.
	SaveDone(ctx context.Context, id string, result []byte, finished time.Time, requeues int, lastBusy string, firstTry any, requireFree bool) (int64, error)
	// AbandonJob marks the user's job abandoned and scans its old status, untried and created_at (ErrNoRows: none).
	AbandonJob(ctx context.Context, userID int64, id string, now time.Time, old *string, untried *bool, created *time.Time) error
	// SweepJobs deletes done jobs finished before doneBefore and abandoned ones before abandonedBefore.
	SweepJobs(ctx context.Context, doneBefore, abandonedBefore time.Time) error
	// PendingJobs lists pending jobs by age (each with its own scan error).
	PendingJobs(ctx context.Context) ([]JobScan, error)
}

const jobCols = `id, user_id, text, cache_key, slot, payload, status, requeues, last_busy,
	next_attempt_at, lease_until, first_try_at, created_at, finished_at, result, attempts`

func scanJobRow(row pgx.Row) (JobRow, error) {
	var j JobRow
	err := row.Scan(&j.ID, &j.UserID, &j.Text, &j.Key, &j.Slot, &j.Payload, &j.Status, &j.Requeues, &j.LastBusy,
		&j.NextAttempt, &j.LeaseUntil, &j.FirstTry, &j.Created, &j.Finished, &j.Result, &j.Attempts)
	return j, err
}

func (r repo) InsertJob(ctx context.Context, id string, userID int64, text, key, slot string, payload []byte, created time.Time) error {
	_, err := r.q.Exec(ctx, `INSERT INTO ai_parse_jobs(id,user_id,text,cache_key,slot,payload,status,created_at)
		VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`, id, userID, text, key, slot, payload, created)
	return err
}

func (r repo) Job(ctx context.Context, userID int64, id string) (JobRow, error) {
	return scanJobRow(r.q.QueryRow(ctx, `SELECT `+jobCols+` FROM ai_parse_jobs WHERE id=$1 AND user_id=$2`, id, userID))
}

func (r repo) JobByID(ctx context.Context, id string) (JobRow, error) {
	return scanJobRow(r.q.QueryRow(ctx, `SELECT `+jobCols+` FROM ai_parse_jobs WHERE id=$1`, id))
}

func (r repo) ClaimJob(ctx context.Context, id string, leaseUntil, now time.Time, requeues, maxAttempts int, firstTry *time.Time, attempts *int) error {
	return r.q.QueryRow(ctx, `UPDATE ai_parse_jobs SET lease_until=$2, first_try_at=COALESCE(first_try_at,$3), attempts=attempts+1
		WHERE id=$1 AND status='pending' AND requeues=$4 AND attempts < $5 AND (lease_until IS NULL OR lease_until < $3)
		AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
		RETURNING first_try_at, attempts`, id, leaseUntil, now, requeues, maxAttempts).Scan(firstTry, attempts)
}

func (r repo) SaveRequeue(ctx context.Context, id string, requeues int, lastBusy string, notBefore time.Time, firstTry any) error {
	_, err := r.q.Exec(ctx, `UPDATE ai_parse_jobs SET requeues=$2, last_busy=$3, next_attempt_at=$4, lease_until=NULL,
		first_try_at=COALESCE(first_try_at,$5) WHERE id=$1 AND status='pending'`,
		id, requeues, lastBusy, notBefore, firstTry)
	return err
}

func (r repo) SaveDone(ctx context.Context, id string, result []byte, finished time.Time, requeues int, lastBusy string, firstTry any, requireFree bool) (int64, error) {
	tag, err := r.q.Exec(ctx, `UPDATE ai_parse_jobs SET status='done', result=$2, finished_at=$3, requeues=$4, last_busy=$5,
		lease_until=NULL, first_try_at=COALESCE(first_try_at,$6)
		WHERE id=$1 AND status='pending' AND (NOT $7 OR lease_until IS NULL OR lease_until < $3)`,
		id, result, finished, requeues, lastBusy, firstTry, requireFree)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (r repo) AbandonJob(ctx context.Context, userID int64, id string, now time.Time, old *string, untried *bool, created *time.Time) error {
	return r.q.QueryRow(ctx, `WITH old AS (SELECT status, first_try_at IS NULL AS untried, created_at FROM ai_parse_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE)
		UPDATE ai_parse_jobs j SET status='abandoned', result=NULL, lease_until=NULL, next_attempt_at=NULL,
			finished_at=CASE WHEN old.status='abandoned' THEN j.finished_at ELSE $3 END
		FROM old WHERE j.id=$1 AND j.user_id=$2 RETURNING old.status, old.untried, old.created_at`, id, userID, now).Scan(old, untried, created)
}

func (r repo) SweepJobs(ctx context.Context, doneBefore, abandonedBefore time.Time) error {
	_, err := r.q.Exec(ctx, `DELETE FROM ai_parse_jobs WHERE (status='done' AND finished_at < $1) OR (status='abandoned' AND finished_at < $2)`,
		doneBefore, abandonedBefore)
	return err
}

func (r repo) PendingJobs(ctx context.Context) ([]JobScan, error) {
	rows, err := r.q.Query(ctx, `SELECT `+jobCols+` FROM ai_parse_jobs WHERE status='pending' ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	var all []JobScan
	for rows.Next() {
		j, err := scanJobRow(rows)
		all = append(all, JobScan{Row: j, Err: err})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return all, nil
}
