package food

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/akarsh/calorie-tracker/internal/parser"
)

// Durable jobs (ai_parse_jobs, migration 014). The queue keeps working
// copies in memory; every state change (queued, first try, requeue, done)
// is written to Postgres first-class, so a restart or a sleeping instance
// resumes pending jobs and still answers polls for finished ones. With no
// DB (unit tests) the queue is memory-only, as before.

// dbTimeout bounds one job-store statement.
const dbTimeout = 5 * time.Second

// leaseSlack: an attempt's lease is callTimeout + this.
const leaseSlack = 5 * time.Second

type jobPayload struct {
	Hint        []parser.Item `json:"hint"`
	Claimed     []parser.Item `json:"claimed"`
	Spans       []Span        `json:"spans"`
	FailClaimed []parser.Item `json:"fail_claimed"` // null = use claimed (see Job.FailClaimed)
	FailSpans   []Span        `json:"fail_spans"`
	Generic     ParseResponse `json:"generic"`
}

const jobCols = `id, user_id, text, cache_key, slot, payload, status, requeues, last_busy,
	next_attempt_at, lease_until, first_try_at, created_at, finished_at, result, attempts`

func dbCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), dbTimeout)
}

func tsOrNil(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

// insertJob stores a new pending job.
func (q *Queue) insertJob(j *Job) error {
	p, err := json.Marshal(jobPayload{Hint: j.Hint, Claimed: j.Claimed, Spans: j.Spans, FailClaimed: j.FailClaimed,
		FailSpans: j.FailSpans, Generic: j.Generic})
	if err != nil {
		return err
	}
	ctx, cancel := dbCtx()
	defer cancel()
	_, err = q.db.Exec(ctx, `INSERT INTO ai_parse_jobs(id,user_id,text,cache_key,slot,payload,status,created_at)
		VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`, j.ID, j.UserID, j.Text, j.Key, j.Slot, p, j.Created)
	return err
}

// scanJob reads one ai_parse_jobs row (jobCols order). lease is lease_until.
func scanJob(row pgx.Row) (j Job, lease time.Time, err error) {
	var payload, result []byte
	var next, leaseAt, first, fin *time.Time
	if err = row.Scan(&j.ID, &j.UserID, &j.Text, &j.Key, &j.Slot, &payload, &j.Status, &j.Requeues, &j.LastBusy,
		&next, &leaseAt, &first, &j.Created, &fin, &result, &j.Attempts); err != nil {
		return
	}
	var p jobPayload
	if err = json.Unmarshal(payload, &p); err != nil {
		return
	}
	j.Hint, j.Claimed, j.Spans, j.FailClaimed, j.FailSpans, j.Generic = p.Hint, p.Claimed, p.Spans, p.FailClaimed, p.FailSpans, p.Generic
	if len(result) > 0 {
		if err = json.Unmarshal(result, &j.Result); err != nil {
			return
		}
	}
	for _, x := range []struct {
		src *time.Time
		dst *time.Time
	}{{next, &j.NotBefore}, {leaseAt, &lease}, {first, &j.FirstTry}, {fin, &j.Finished}} {
		if x.src != nil {
			*x.dst = *x.src
		}
	}
	if j.Status != "pending" {
		j.Hint = nil
	}
	return
}

// loadJob reads a job by id for its owner. ok=false: no such job for this user.
func (q *Queue) loadJob(uid int64, id string) (Job, bool, error) {
	ctx, cancel := dbCtx()
	defer cancel()
	j, _, err := scanJob(q.db.QueryRow(ctx, `SELECT `+jobCols+` FROM ai_parse_jobs WHERE id=$1 AND user_id=$2`, id, uid))
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, err
	}
	return j, true, nil
}

// claimJob takes the lease for one attempt. It succeeds only if the row is
// still pending, due, unleased, at the requeue count this copy knows and has
// an attempt left (attempts < AI_MAX_ATTEMPTS); it counts the attempt and
// sets first_try_at on the first one. ok=false: another instance
// moved the job on (j is then refreshed from the row; done=true if finished
// or gone). A DB error lets the attempt run anyway (best effort).
func (q *Queue) claimJob(j *Job, now time.Time) (ok bool) {
	ctx, cancel := dbCtx()
	defer cancel()
	var first time.Time
	var attempts int
	err := q.db.QueryRow(ctx, `UPDATE ai_parse_jobs SET lease_until=$2, first_try_at=COALESCE(first_try_at,$3), attempts=attempts+1
		WHERE id=$1 AND status='pending' AND requeues=$4 AND attempts < $5 AND (lease_until IS NULL OR lease_until < $3)
		AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
		RETURNING first_try_at, attempts`, j.ID, now.Add(q.callTimeout+leaseSlack), now, j.Requeues, q.maxAttempts).Scan(&first, &attempts)
	if err == nil {
		q.mu.Lock()
		j.FirstTry, j.Attempts = first, attempts
		q.mu.Unlock()
		return true
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		log.Printf("ai job claim failed (running anyway): job=%s err=%v", j.ID, err)
		q.mu.Lock()
		if j.FirstTry.IsZero() {
			j.FirstTry = now
		}
		j.Attempts++
		q.mu.Unlock()
		return true
	}
	// someone else has it (or no attempt is left): refresh this copy from the row
	q.refresh(ctx, j, now)
	return false
}

// refresh reloads this copy of a pending job from its row: dropped if it is
// finished elsewhere, else back in the queue at its next_attempt_at (after a
// live lease). A copy with no attempt left is finished as gave_up by Run.
func (q *Queue) refresh(ctx context.Context, j *Job, now time.Time) {
	cur, lease, err := scanJob(q.db.QueryRow(ctx, `SELECT `+jobCols+` FROM ai_parse_jobs WHERE id=$1`, j.ID))
	q.mu.Lock()
	defer q.mu.Unlock()
	switch {
	case errors.Is(err, pgx.ErrNoRows) || (err == nil && cur.Status != "pending"):
		delete(q.jobs, j.ID) // finished, abandoned (or deleted) elsewhere; polls read the row
	case err != nil:
		log.Printf("ai job reload failed: job=%s err=%v", j.ID, err)
		j.NotBefore = now.Add(time.Second)
		q.waiting = append(q.waiting, j)
	default:
		j.Requeues, j.LastBusy, j.FirstTry, j.Attempts = cur.Requeues, cur.LastBusy, cur.FirstTry, cur.Attempts
		j.NotBefore = cur.NotBefore
		if lease.After(j.NotBefore) {
			j.NotBefore = lease
		}
		if !j.NotBefore.After(now) {
			j.NotBefore = now.Add(time.Second)
		}
		q.waiting = append(q.waiting, j)
	}
}

// saveRequeue records a busy attempt: the job stays pending until NotBefore.
func (q *Queue) saveRequeue(j Job) {
	ctx, cancel := dbCtx()
	defer cancel()
	if _, err := q.db.Exec(ctx, `UPDATE ai_parse_jobs SET requeues=$2, last_busy=$3, next_attempt_at=$4, lease_until=NULL,
		first_try_at=COALESCE(first_try_at,$5) WHERE id=$1 AND status='pending'`,
		j.ID, j.Requeues, j.LastBusy, j.NotBefore, tsOrNil(j.FirstTry)); err != nil {
		log.Printf("ai job requeue save failed: job=%s err=%v", j.ID, err)
	}
}

// saveDone records the final result. requireFree: only if no attempt is in
// flight (used when giving up a reloaded job). false: the row was not
// pending (another instance finished it) or the write failed.
func (q *Queue) saveDone(j Job, requireFree bool) bool {
	res, err := json.Marshal(j.Result)
	if err != nil {
		log.Printf("ai job result encode failed: job=%s err=%v", j.ID, err)
		return false
	}
	ctx, cancel := dbCtx()
	defer cancel()
	tag, err := q.db.Exec(ctx, `UPDATE ai_parse_jobs SET status='done', result=$2, finished_at=$3, requeues=$4, last_busy=$5,
		lease_until=NULL, first_try_at=COALESCE(first_try_at,$6)
		WHERE id=$1 AND status='pending' AND (NOT $7 OR lease_until IS NULL OR lease_until < $3)`,
		j.ID, res, j.Finished, j.Requeues, j.LastBusy, tsOrNil(j.FirstTry), requireFree)
	if err != nil {
		log.Printf("ai job done save failed: job=%s err=%v", j.ID, err)
		return false
	}
	return tag.RowsAffected() == 1
}

// abandonRow marks the user's job abandoned (idempotent). ok=false: no such
// job. wasPending/untried: its state before (an untried pending job gets its
// reserved call back).
func (q *Queue) abandonRow(uid int64, id string, now time.Time) (ok, wasPending, untried bool, created time.Time, err error) {
	ctx, cancel := dbCtx()
	defer cancel()
	var old string
	err = q.db.QueryRow(ctx, `WITH old AS (SELECT status, first_try_at IS NULL AS untried, created_at FROM ai_parse_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE)
		UPDATE ai_parse_jobs j SET status='abandoned', result=NULL, lease_until=NULL, next_attempt_at=NULL,
			finished_at=CASE WHEN old.status='abandoned' THEN j.finished_at ELSE $3 END
		FROM old WHERE j.id=$1 AND j.user_id=$2 RETURNING old.status, old.untried, old.created_at`, id, uid, now).Scan(&old, &untried, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, false, time.Time{}, nil
	}
	if err != nil {
		return false, false, false, time.Time{}, err
	}
	return true, old == "pending", untried, created, nil
}

// sweepDone deletes finished jobs past the poll TTL (abandoned ones after AbandonedTTL).
func (q *Queue) sweepDone() {
	ctx, cancel := dbCtx()
	defer cancel()
	if _, err := q.db.Exec(ctx, `DELETE FROM ai_parse_jobs WHERE (status='done' AND finished_at < $1) OR (status='abandoned' AND finished_at < $2)`,
		time.Now().Add(-q.ttl), time.Now().Add(-AbandonedTTL)); err != nil {
		log.Printf("ai job sweep failed: %v", err)
	}
}

// resume loads the pending jobs of an earlier process. A job that can no
// longer get a try that ends inside its AI_REQUEUE_MAX window (counted
// from its first try, or from when it was queued if it never got one) ends
// now as gave_up, with no AI call; the rest go back into the queue at
// their next_attempt_at (or after a dead process's lease runs out).
func (q *Queue) resume() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rows, err := q.db.Query(ctx, `SELECT `+jobCols+` FROM ai_parse_jobs WHERE status='pending' ORDER BY created_at, id`)
	if err != nil {
		return err
	}
	type loaded struct {
		j     *Job
		lease time.Time
	}
	var all []loaded
	for rows.Next() {
		j, lease, err := scanJob(rows)
		if err != nil {
			log.Printf("ai job reload skipped: %v", err)
			continue
		}
		all = append(all, loaded{&j, lease})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	now := time.Now()
	resumed, gaveUp := 0, 0
	for _, l := range all {
		j := l.j
		start := j.FirstTry
		if start.IsZero() {
			start = j.Created
		}
		// out of attempts (the last one may have died with its process), or out of time
		if q.spent(j) || !now.Before(start.Add(q.requeueMax-q.callTimeout)) {
			untried := j.FirstTry.IsZero()
			j.Result, j.Status, j.Finished = q.gaveUp(j), "done", now
			if q.saveDone(*j, true) {
				gaveUp++
				log.Printf("ai job gave up on resume: job=%s requeues=%d attempts=%d/%d queued=%s ago", j.ID, j.Requeues, j.Attempts, q.maxAttempts, now.Sub(j.Created).Round(time.Second))
				if untried && q.release != nil {
					q.release(j) // the reserved call was never made
				}
				continue
			}
			// leased by a live instance (or the write failed): leave it to the queue
			j.Result, j.Status, j.Finished = ParseResponse{}, "pending", time.Time{}
		}
		if l.lease.After(j.NotBefore) {
			j.NotBefore = l.lease
		}
		q.mu.Lock()
		if _, dup := q.jobs[j.ID]; !dup {
			q.jobs[j.ID] = j
			q.waiting = append(q.waiting, j)
			resumed++
		}
		q.mu.Unlock()
	}
	if resumed+gaveUp > 0 {
		log.Printf("ai jobs resumed=%d gave_up=%d", resumed, gaveUp)
	}
	q.poke()
	return nil
}
