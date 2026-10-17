package food

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// Job is one meal waiting for (or done with) its AI answer.
type Job struct {
	ID      string
	UserID  int64
	Text    string
	Key     string
	Hint    []parser.Item
	Claimed []parser.Item // confident table items kept as they are
	Spans   []Span        // unclaimed parts the AI must answer for
	// FailClaimed / FailSpans: what a failed meal shows. Table dishes glued
	// to unknown words ("roti zorbali") stay as items to confirm; only the
	// unknown words need input. Nil means Claimed / Spans.
	FailClaimed []parser.Item
	FailSpans   []Span
	Generic     ParseResponse // claimed items + open spans, used to build the failed state
	Slot        string
	Status      string // pending (estimating), done, abandoned (the app gave up: no more attempts, late results dropped)
	Result      ParseResponse
	Created     time.Time
	// Requeues: times Gemini was still busy (rate_limited / unavailable /
	// timeout) after its retries and the job went back into the queue.
	Requeues  int
	NotBefore time.Time // the next attempt waits until then
	LastBusy  string    // fallback_reason of the last busy attempt
	FirstTry  time.Time // start of the first AI attempt: the give-up window counts from here
	Finished  time.Time // when the job became done: expiry counts from here
}

// Requeue policy: a busy job is tried again after RequeueDelays[n] (the
// last delay repeats) until the give-up window (AI_REQUEUE_MAX_MINUTES,
// default 30 min from the first try) runs out; then it ends as failed with
// fallback_reason gave_up. The last try is scheduled so that it starts no
// later than window - call timeout, i.e. it finishes inside the window.
var RequeueDelays = []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 3 * time.Minute, 4 * time.Minute, 5 * time.Minute}

// DefaultRequeueMax is the default give-up window (AI_REQUEUE_MAX_MINUTES).
const DefaultRequeueMax = 30 * time.Minute

// DefaultCallTimeout bounds one AI job attempt (retries included).
const DefaultCallTimeout = 30 * time.Second

// DoneTTL: a finished job can be polled this long after it finished.
const DoneTTL = time.Hour

// AbandonedTTL: an abandoned job is kept this long, so a late AI save that
// carries its id is still refused (job_abandoned).
const AbandonedTTL = 7 * 24 * time.Hour

func requeueDelay(n int) time.Duration {
	if n < 0 {
		n = 0
	}
	if n >= len(RequeueDelays) {
		n = len(RequeueDelays) - 1
	}
	return RequeueDelays[n]
}

// Queue drains AI jobs at a fixed rate (the per-minute cap) on one worker,
// so bursts wait instead of hitting the provider's rate limit. A job whose
// call came back busy goes back in with a later NotBefore. With a DB (set
// by Service.Start) jobs are durable in ai_parse_jobs: a restart resumes
// pending jobs (see resume) and polls read the row, so they work across
// restarts and instances. Without one the queue is memory-only.
type Queue struct {
	mu       sync.Mutex
	jobs     map[string]*Job
	waiting  []*Job // pending jobs, in order of arrival / requeue
	max      int
	wake     chan struct{}
	interval time.Duration
	// run makes the AI call; requeue=true means busy: try again later.
	run func(context.Context, *Job) (res ParseResponse, requeue bool)
	// gaveUp builds the failed (gave_up) result when the window runs out.
	gaveUp      func(*Job) ParseResponse
	ttl         time.Duration
	requeueMax  time.Duration // give-up window from the first try
	callTimeout time.Duration
	db          *pgxpool.Pool
	// release gives back the reserved call of a job that gave up on resume
	// without ever being tried.
	release func(*Job)
}

// NewQueue: perMinute calls a minute (<=0 means no spacing), at most max waiting.
func NewQueue(perMinute, max int) *Queue {
	iv := time.Duration(0)
	if perMinute > 0 {
		iv = time.Minute / time.Duration(perMinute)
	}
	return &Queue{jobs: map[string]*Job{}, max: max, wake: make(chan struct{}, 1), interval: iv, ttl: DoneTTL,
		requeueMax: DefaultRequeueMax, callTimeout: DefaultCallTimeout}
}

// SetRequeueMax sets the give-up window (<=0 keeps the default). Call before Start.
func (q *Queue) SetRequeueMax(d time.Duration) {
	if d > 0 {
		q.requeueMax = d
	}
}

// SetCallTimeout sets the per-attempt timeout (<=0 keeps the default). Call before Start.
func (q *Queue) SetCallTimeout(d time.Duration) {
	if d > 0 {
		q.callTimeout = d
	}
}

// nextTry: when a busy job should be tried again, or ok=false to give up.
// The try must start by FirstTry + window - callTimeout so it ends in the window.
func (q *Queue) nextTry(j *Job, now time.Time) (time.Time, bool) {
	last := j.FirstTry.Add(q.requeueMax - q.callTimeout)
	if !now.Before(last) {
		return time.Time{}, false
	}
	at := now.Add(requeueDelay(j.Requeues))
	if at.After(last) {
		at = last
	}
	return at, true
}

func (q *Queue) poke() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// Add queues a job; false when the queue is full (requeued jobs count).
func (q *Queue) Add(uid int64, text, key string, hint []parser.Item, generic ParseResponse, slot string, claimed []parser.Item, spans []Span, fail ...FailSplit) (*Job, bool) {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	j := &Job{ID: hex.EncodeToString(b), UserID: uid, Text: text, Key: key, Hint: hint, Generic: generic, Slot: slot,
		Status: "pending", Created: time.Now(), Claimed: claimed, Spans: spans}
	if len(fail) > 0 {
		j.FailClaimed, j.FailSpans = fail[0].Claimed, fail[0].Spans
	}
	q.mu.Lock()
	q.gc()
	if len(q.waiting) >= q.max {
		q.mu.Unlock()
		return nil, false
	}
	if q.db != nil {
		// stored before it can run or be polled; a job that can't be stored
		// is refused like a full queue (the meal ends failed, never lost)
		if err := q.insertJob(j); err != nil {
			q.mu.Unlock()
			log.Printf("ai job store failed: job=%s err=%v", j.ID, err)
			return nil, false
		}
	}
	q.jobs[j.ID] = j
	q.waiting = append(q.waiting, j)
	q.mu.Unlock()
	q.poke()
	return j, true
}

// next takes the first job that is due, or says how long until one is.
func (q *Queue) next() (*Job, time.Duration) {
	q.mu.Lock()
	defer q.mu.Unlock()
	now := time.Now()
	wait := time.Duration(-1)
	for i, j := range q.waiting {
		if !j.NotBefore.After(now) {
			q.waiting = append(q.waiting[:i:i], q.waiting[i+1:]...)
			return j, 0
		}
		if d := j.NotBefore.Sub(now); wait < 0 || d < wait {
			wait = d
		}
	}
	return nil, wait
}

// Run is the worker: at most one AI call per interval.
func (q *Queue) Run(ctx context.Context) {
	var last time.Time
	for {
		j, wait := q.next()
		if j == nil {
			var timer <-chan time.Time
			if wait >= 0 {
				timer = time.After(wait)
			}
			select {
			case <-ctx.Done():
				return
			case <-q.wake:
			case <-timer:
			}
			continue
		}
		q.mu.Lock()
		gone := j.Status == "abandoned"
		q.mu.Unlock()
		if gone {
			continue // the app gave up on it: no AI call
		}
		if d := q.interval - time.Since(last); d > 0 {
			select {
			case <-time.After(d):
			case <-ctx.Done():
				return
			}
		}
		start := time.Now()
		if q.db != nil {
			if !q.claimJob(j, start) {
				continue // another instance moved it on; no call made
			}
		} else {
			q.mu.Lock()
			if j.FirstTry.IsZero() {
				j.FirstTry = start
			}
			q.mu.Unlock()
		}
		last = start
		cctx, cancel := context.WithTimeout(ctx, q.callTimeout)
		res, requeue := q.run(cctx, j)
		cancel()
		if ctx.Err() != nil {
			// shutting down mid-attempt: leave the job pending in the DB (its
			// lease runs out) so the next process resumes it, as after a crash
			return
		}
		now := time.Now()
		var at time.Time
		if requeue {
			var ok bool
			if at, ok = q.nextTry(j, now); !ok {
				log.Printf("ai busy, gave up: job=%s reason=%s requeues=%d after=%s", j.ID, res.FallbackReason, j.Requeues, now.Sub(j.FirstTry).Round(time.Second))
				res, requeue = q.gaveUp(j), false
			}
		}
		q.mu.Lock()
		if j.Status == "abandoned" {
			q.mu.Unlock()
			// abandoned while this attempt was in flight: the late result is dropped (the DB row is not pending either)
			log.Printf("ai job abandoned during its attempt, result dropped: job=%s", j.ID)
			continue
		}
		if requeue {
			j.NotBefore = at
			j.Requeues++
			j.LastBusy = res.FallbackReason
			q.waiting = append(q.waiting, j) // stays pending; the next try is charged only if it reaches Gemini
		} else {
			j.Result, j.Status, j.Finished = res, "done", now
			j.Hint = nil
		}
		snap := *j
		q.mu.Unlock()
		if q.db != nil {
			if requeue {
				q.saveRequeue(snap)
			} else if !q.saveDone(snap, false) {
				log.Printf("ai job result not stored (finished elsewhere or db error): job=%s", j.ID)
			}
		}
	}
}

// Get returns a copy of the job if the user owns it. With a DB the row is
// the answer (any instance, any restart); a finished job expires ttl after
// it finished. A DB error falls back to this process's copy.
func (q *Queue) Get(uid int64, id string) (Job, bool) {
	if q.db != nil {
		j, ok, err := q.loadJob(uid, id)
		if err == nil {
			if !ok || (j.Status == "done" && time.Since(j.Finished) > q.ttl) {
				return Job{}, false
			}
			return j, true
		}
		log.Printf("ai job load failed, using memory: job=%s err=%v", id, err)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	j, ok := q.jobs[id]
	if !ok || j.UserID != uid {
		return Job{}, false
	}
	if j.Status == "done" && time.Since(j.Finished) > q.ttl {
		return Job{}, false
	}
	return *j, true
}

// Pending is the number of jobs waiting (requeued ones included).
func (q *Queue) Pending() int { q.mu.Lock(); defer q.mu.Unlock(); return len(q.waiting) }

func (q *Queue) gc() {
	for id, j := range q.jobs {
		// pending jobs are never dropped (they end within the give-up window);
		// done jobs stay pollable for ttl after they FINISHED, not after creation.
		if (j.Status == "done" && time.Since(j.Finished) > q.ttl) || (j.Status == "abandoned" && time.Since(j.Finished) > AbandonedTTL) {
			delete(q.jobs, id)
		}
	}
}

// Abandon: the app gave up on this job (its 35-minute backstop) and the user
// types the kcal. The job ends as abandoned: it leaves the queue, no further
// AI attempt is made, an attempt in flight has its result dropped, and polls
// say abandoned (no items). Idempotent. ok=false: no such job for this user
// (or it expired). A job that was never tried gets its reserved call back.
func (q *Queue) Abandon(uid int64, id string) (ok bool) {
	now := time.Now()
	q.mu.Lock()
	mem, inMem := q.jobs[id]
	if inMem && mem.UserID != uid {
		inMem = false
	}
	var wasPending, untried bool
	var snap Job
	if inMem {
		wasPending, untried = mem.Status == "pending", mem.FirstTry.IsZero()
		if mem.Status != "abandoned" {
			mem.Status, mem.Finished, mem.Result, mem.Hint = "abandoned", now, ParseResponse{}, nil
		}
		for i, w := range q.waiting {
			if w == mem {
				q.waiting = append(q.waiting[:i:i], q.waiting[i+1:]...)
				break
			}
		}
		snap = *mem
	}
	q.mu.Unlock()
	if q.db != nil {
		dbOK, dbPending, dbUntried, created, err := q.abandonRow(uid, id, now)
		if err != nil {
			log.Printf("ai job abandon store failed: job=%s err=%v", id, err)
			if !inMem {
				return false
			}
		} else {
			if !dbOK && !inMem {
				return false
			}
			if dbOK {
				wasPending, untried = dbPending, dbUntried
				snap.ID, snap.UserID, snap.Created = id, uid, created
			}
		}
	} else if !inMem {
		return false
	}
	if wasPending && untried && q.release != nil {
		q.release(&snap) // the reserved call was never made
	}
	log.Printf("ai job abandoned by the app: job=%s was_pending=%v untried=%v", id, wasPending, untried)
	return true
}

// Start wires the queue to the service and starts the worker.
func (s *Service) Start(ctx context.Context, q *Queue) {
	q.run = s.runJob
	q.gaveUp = func(j *Job) ParseResponse {
		c, sp := j.failSplit()
		return s.failedResponse(c, sp, j.Slot, "gave_up", "gave_up")
	}
	q.release = func(j *Job) {
		// only on the quota day it was reserved; a later day's counter never held it
		if s.DB != nil && s.Quota != nil && s.Quota.Day(j.Created) == s.Quota.Day(httpx.Now()) {
			s.releaseAI(context.Background(), j.UserID)
		}
	}
	q.db = s.DB
	s.Queue = q
	if q.db != nil {
		if err := q.resume(); err != nil {
			log.Printf("ai jobs resume failed: %v", err)
		}
		q.sweepDone()
		go func() {
			t := time.NewTicker(10 * time.Minute)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					q.sweepDone()
				}
			}
		}()
	}
	go q.Run(ctx)
}

func (s *Service) handleJob(w http.ResponseWriter, r *http.Request) {
	j, ok := s.Queue.Get(httpx.UserID(r), r.PathValue("id"))
	if !ok {
		httpx.Error(w, 404, "no such job (jobs expire an hour after they finish)")
		return
	}
	links := s.jobEntries(r.Context(), j.UserID, j.ID)
	if j.Status == "abandoned" {
		// the app gave up on this meal: never an AI answer, whatever came back later
		httpx.JSON(w, 200, map[string]any{"status": "abandoned", "ai_state": "failed", "fallback_reason": "abandoned", "job_id": j.ID,
			"items": []parser.Item{}, "entries": links, "next_reset_at": s.nextResetAt()})
		return
	}
	if j.Status != "done" {
		body := map[string]any{"status": "pending", "ai_state": "estimating", "job_id": j.ID, "queue_length": s.Queue.Pending(),
			"requeues": j.Requeues, "entries": links, "next_reset_at": s.nextResetAt()}
		if j.Requeues > 0 {
			body["busy_reason"] = j.LastBusy // rate_limited | unavailable | timeout: still estimating
			body["next_attempt_at"] = j.NotBefore.UTC().Format(time.RFC3339)
		}
		httpx.JSON(w, 202, body)
		return
	}
	out := j.Result
	out.JobID = j.ID
	out.Entries = links
	out.NextResetAt = s.nextResetAt()
	httpx.JSON(w, 200, out)
}

// handleAbandon: POST /v1/parse/jobs/{id}/abandon - the app gave up on the
// meal (see Queue.Abandon). 404 when there is no such job for this user.
func (s *Service) handleAbandon(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.Queue.Abandon(httpx.UserID(r), id) {
		httpx.Error(w, 404, "no such job")
		return
	}
	httpx.JSON(w, 200, map[string]any{"job_id": id, "status": "abandoned"})
}

// jobAbandoned: the app abandoned this parse job (an AI reading saved with its id is refused).
func (s *Service) jobAbandoned(ctx context.Context, uid int64, job string) bool {
	if job == "" || s.Queue == nil {
		return false
	}
	if s.Queue.db == nil {
		j, ok := s.Queue.Get(uid, job)
		return ok && j.Status == "abandoned"
	}
	var n int
	_ = s.DB.QueryRow(ctx, `SELECT count(*) FROM ai_parse_jobs WHERE id=$1 AND user_id=$2 AND status='abandoned'`, job, uid).Scan(&n)
	return n > 0
}

// abandonedBody: 409 for an AI reading saved with an abandoned job's id.
func abandonedBody(i int, job string) map[string]any {
	return map[string]any{"error": map[string]any{"code": "job_abandoned", "item": i, "job_id": job,
		"message": "The app gave up on this AI estimate; the user's own kcal stands. Late AI readings for it are not saved."}}
}

// JobEntry is an entry saved with this parse job's id (typically a
// needs_review entry waiting for the AI answer).
type JobEntry struct {
	ID           int64   `json:"id"`
	ClientID     *string `json:"client_id"`
	ClientItemID *string `json:"client_item_id"`
	State        string  `json:"state"`
}

func (s *Service) jobEntries(ctx context.Context, uid int64, job string) []JobEntry {
	out := []JobEntry{}
	rows, err := s.DB.Query(ctx, `SELECT id, client_id, client_item_id, state FROM food_entries
		WHERE user_id=$1 AND parse_job_id=$2 AND deleted_at IS NULL ORDER BY id`, uid, job)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var e JobEntry
		if rows.Scan(&e.ID, &e.ClientID, &e.ClientItemID, &e.State) == nil {
			out = append(out, e)
		}
	}
	return out
}

// FailSplit is the failed-state reading of a meal (see Job.FailClaimed).
type FailSplit struct {
	Claimed []parser.Item
	Spans   []Span
}

func (j *Job) failSplit() ([]parser.Item, []Span) {
	if j.FailClaimed == nil {
		return j.Claimed, j.Spans
	}
	return j.FailClaimed, j.FailSpans
}
