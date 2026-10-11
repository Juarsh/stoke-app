package food

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sync"
	"time"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// Job is one meal waiting for (or done with) its single AI call.
type Job struct {
	ID      string
	UserID  int64
	Text    string
	Key     string
	Hint    []parser.Item
	Generic ParseResponse // answer if the AI fails
	Slot    string
	Status  string // pending, done
	Result  ParseResponse
	Created time.Time
}

// Queue drains AI jobs at a fixed rate (the per-minute cap) on one worker,
// so bursts wait instead of hitting the provider's rate limit. In-memory:
// pending jobs are lost on restart, and the app then falls back to its
// needs_review flow and re-parses later.
type Queue struct {
	mu       sync.Mutex
	jobs     map[string]*Job
	ch       chan *Job
	interval time.Duration
	run      func(context.Context, *Job) ParseResponse
	ttl      time.Duration
}

// NewQueue: perMinute calls a minute (<=0 means no spacing), at most max waiting.
func NewQueue(perMinute, max int) *Queue {
	iv := time.Duration(0)
	if perMinute > 0 {
		iv = time.Minute / time.Duration(perMinute)
	}
	return &Queue{jobs: map[string]*Job{}, ch: make(chan *Job, max), interval: iv, ttl: time.Hour}
}

// Add queues a job; false when the queue is full.
func (q *Queue) Add(uid int64, text, key string, hint []parser.Item, generic ParseResponse, slot string) (*Job, bool) {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	j := &Job{ID: hex.EncodeToString(b), UserID: uid, Text: text, Key: key, Hint: hint, Generic: generic, Slot: slot,
		Status: "pending", Created: time.Now()}
	q.mu.Lock()
	q.gc()
	q.jobs[j.ID] = j
	q.mu.Unlock()
	select {
	case q.ch <- j:
		return j, true
	default:
		q.mu.Lock()
		delete(q.jobs, j.ID)
		q.mu.Unlock()
		return nil, false
	}
}

// Run is the worker: one AI call per interval.
func (q *Queue) Run(ctx context.Context) {
	var last time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case j := <-q.ch:
			if wait := q.interval - time.Since(last); wait > 0 {
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					return
				}
			}
			last = time.Now()
			cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			res := q.run(cctx, j)
			cancel()
			q.mu.Lock()
			j.Result, j.Status = res, "done"
			j.Hint = nil
			q.mu.Unlock()
		}
	}
}

// Get returns a copy of the job if the user owns it.
func (q *Queue) Get(uid int64, id string) (Job, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	j, ok := q.jobs[id]
	if !ok || j.UserID != uid {
		return Job{}, false
	}
	return *j, true
}

// Pending is the number of jobs waiting.
func (q *Queue) Pending() int { return len(q.ch) }

func (q *Queue) gc() {
	for id, j := range q.jobs {
		if time.Since(j.Created) > q.ttl {
			delete(q.jobs, id)
		}
	}
}

// Start wires the queue to the service and starts the worker.
func (s *Service) Start(ctx context.Context, q *Queue) {
	q.run = s.runJob
	s.Queue = q
	go q.Run(ctx)
}

func (s *Service) handleJob(w http.ResponseWriter, r *http.Request) {
	j, ok := s.Queue.Get(httpx.UserID(r), r.PathValue("id"))
	if !ok {
		httpx.Error(w, 404, "no such job (jobs expire after an hour)")
		return
	}
	if j.Status != "done" {
		httpx.JSON(w, 202, map[string]any{"status": "pending", "job_id": j.ID, "queue_length": s.Queue.Pending()})
		return
	}
	out := j.Result
	out.JobID = j.ID
	httpx.JSON(w, 200, out)
}
