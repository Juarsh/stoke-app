package food

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// seqFallback: the stub, failing with the given modes first (one per call).
type seqFallback struct {
	mu    sync.Mutex
	stub  *Stub
	modes []string
}

func (f *seqFallback) EstimateMeal(ctx context.Context, text string, spans []Span, hint []parser.Item) ([]parser.Item, error) {
	f.mu.Lock()
	mode := ""
	if len(f.modes) > 0 {
		mode, f.modes = f.modes[0], f.modes[1:]
	}
	f.mu.Unlock()
	f.stub.SetFail(mode)
	return f.stub.EstimateMeal(ctx, text, spans, hint)
}

func fastRequeue(t *testing.T) {
	d := RequeueDelays
	RequeueDelays = []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}
	t.Cleanup(func() { RequeueDelays = d })
}

func requeueSvc(t *testing.T, modes ...string) (*Service, *Stub, *Queue) {
	return requeueSvcWin(t, 0, modes...)
}

// requeueSvcWin: window>0 sets the give-up window (call timeout window/10).
func requeueSvcWin(t *testing.T, window time.Duration, modes ...string) (*Service, *Stub, *Queue) {
	p, err := parser.New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	stub := &Stub{}
	s := &Service{Parser: p, Fallback: &seqFallback{stub: stub, modes: modes}, Quota: &Quota{}}
	q := NewQueue(0, 10)
	if window > 0 {
		q.SetRequeueMax(window)
		q.SetCallTimeout(window / 10)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s.Start(ctx, q)
	return s, stub, q
}

func addJob(t *testing.T, q *Queue) *Job {
	text := "1 quinoa bowl"
	j, ok := q.Add(1, text, text, nil, ParseResponse{}, "lunch", nil, []Span{{Start: 2, End: len(text), Text: "quinoa bowl"}})
	if !ok {
		t.Fatal("queue full")
	}
	return j
}

func waitDone(t *testing.T, q *Queue, id string) Job {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if j, _ := q.Get(1, id); j.Status == "done" {
			return j
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("job never finished")
	return Job{}
}

// A busy answer (429 after the retries) keeps the job estimating and puts it
// back in the queue; the late answer fills the SAME job.
func TestBusyThenLateAnswerFillsSameJob(t *testing.T) {
	fastRequeue(t)
	_, stub, q := requeueSvc(t, "busy", "timeout")
	j := addJob(t, q)
	time.Sleep(10 * time.Millisecond)
	mid, _ := q.Get(1, j.ID)
	if mid.Status != "pending" || mid.Requeues != 1 || mid.LastBusy != "rate_limited" {
		t.Fatalf("after busy want pending with 1 requeue, got status=%s requeues=%d busy=%s", mid.Status, mid.Requeues, mid.LastBusy)
	}
	done := waitDone(t, q, j.ID)
	if done.ID != j.ID || done.Requeues != 2 || stub.Calls() != 3 {
		t.Fatalf("id=%s requeues=%d calls=%d", done.ID, done.Requeues, stub.Calls())
	}
	r := done.Result
	if r.AIState != "answered" || r.Answer != "ai" || r.FallbackReason != "" || len(r.Items) != 1 || r.Items[0].Kcal.Best <= 0 {
		t.Fatalf("late answer not filled: %+v", r)
	}
}

// Always busy: the job keeps estimating until the window runs out, then
// ends as failed with gave_up (never error, never timeout), and every try
// starts by FirstTry + window - call timeout.
func TestBusyGivesUpAfterWindow(t *testing.T) {
	fastRequeue(t)
	const window = 200 * time.Millisecond
	modes := make([]string, 100)
	for i := range modes {
		modes[i] = "busy"
		if i%2 == 1 {
			modes[i] = "timeout"
		}
	}
	_, stub, q := requeueSvcWin(t, window, modes...)
	j := addJob(t, q)
	done := waitDone(t, q, j.ID)
	assertFailed(t, done.Result, "gave_up")
	if done.Result.Fallback != "gave_up" || done.Result.Message != "Couldn't estimate this. Add the calories yourself." {
		t.Errorf("gave_up fallback/message: %q %q", done.Result.Fallback, done.Result.Message)
	}
	el := done.Finished.Sub(done.FirstTry)
	if el < window-window/10-20*time.Millisecond || el > window+30*time.Millisecond {
		t.Errorf("gave up after %s, want about the %s window", el, window)
	}
	// 20ms, 40ms, 40ms... until 180ms: a handful of tries, not a fixed count
	if c := stub.Calls(); c < 4 || c > 8 || done.Requeues != c-1 {
		t.Errorf("calls=%d requeues=%d", c, done.Requeues)
	}
}

// The setting is respected: a longer window allows more tries.
func TestRequeueWindowSetting(t *testing.T) {
	fastRequeue(t)
	busy := func(n int) []string {
		m := make([]string, n)
		for i := range m {
			m[i] = "busy"
		}
		return m
	}
	_, s1, q1 := requeueSvcWin(t, 100*time.Millisecond, busy(100)...)
	d1 := waitDone(t, q1, addJob(t, q1).ID)
	_, s2, q2 := requeueSvcWin(t, 400*time.Millisecond, busy(100)...)
	d2 := waitDone(t, q2, addJob(t, q2).ID)
	assertFailed(t, d1.Result, "gave_up")
	assertFailed(t, d2.Result, "gave_up")
	if s2.Calls() <= s1.Calls() || d2.Finished.Sub(d2.FirstTry) < 300*time.Millisecond {
		t.Errorf("window not respected: short calls=%d long calls=%d long elapsed=%s", s1.Calls(), s2.Calls(), d2.Finished.Sub(d2.FirstTry))
	}
}

// The last try is clamped to start by FirstTry + window - call timeout.
func TestNextTryFitsWindow(t *testing.T) {
	q := NewQueue(0, 1)
	t0 := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	j := &Job{FirstTry: t0}
	var tries []time.Time
	now := t0
	for {
		at, ok := q.nextTry(j, now)
		if !ok {
			break
		}
		if !at.After(now) || at.After(t0.Add(DefaultRequeueMax-DefaultCallTimeout)) {
			t.Fatalf("try at %s outside window", at.Sub(t0))
		}
		tries = append(tries, at)
		j.Requeues++
		now = at.Add(DefaultCallTimeout) // worst case: each try uses its whole timeout
	}
	if len(tries) == 0 || tries[0].Sub(t0) != 30*time.Second {
		t.Fatalf("first requeue should wait 30s: %v", tries)
	}
	if last := tries[len(tries)-1].Add(DefaultCallTimeout); last.After(t0.Add(DefaultRequeueMax)) {
		t.Errorf("last try ends at %s, after the 30 min window", last.Sub(t0))
	}
}

// Expiry counts from when a job finished, so a job that gave up after the
// full window is still pollable for the whole TTL.
func TestDoneJobExpiryFromFinish(t *testing.T) {
	q := NewQueue(0, 10)
	old := time.Now().Add(-2 * time.Hour)
	q.jobs["a"] = &Job{ID: "a", UserID: 1, Status: "done", Created: old, Finished: time.Now().Add(-5 * time.Minute)}
	q.jobs["b"] = &Job{ID: "b", UserID: 1, Status: "done", Created: old, Finished: old}
	q.jobs["c"] = &Job{ID: "c", UserID: 1, Status: "pending", Created: old}
	q.mu.Lock()
	q.gc()
	q.mu.Unlock()
	for id, want := range map[string]bool{"a": true, "b": false, "c": true} {
		if _, ok := q.Get(1, id); ok != want {
			t.Errorf("job %s kept=%v want %v", id, ok, want)
		}
	}
}

func TestFailedStatesHaveNoKcal(t *testing.T) {
	for mode, reason := range map[string]string{"daily_limit": "daily_limit", "error": "error"} {
		_, _, q := requeueSvc(t, mode)
		r := waitDone(t, q, addJob(t, q).ID).Result
		assertFailed(t, r, reason)
		if (reason == "daily_limit") != (r.AIResetsAt != "") {
			t.Errorf("%s: ai_resets_at=%q", mode, r.AIResetsAt)
		}
	}
	s, _, _ := requeueSvc(t)
	s.Quota.UserCap.Store(3)
	r := s.failedResponse(nil, []Span{{Start: 0, End: 4, Text: "poha"}}, "lunch", "cap_reached", "user_limit")
	assertFailed(t, r, "user_limit")
	if r.AIResetsAt == "" || r.UserDailyLimit != 3 {
		t.Errorf("user_limit extras: %+v", r)
	}
}

func assertFailed(t *testing.T, r ParseResponse, reason string) {
	t.Helper()
	if r.AIState != "failed" || r.FallbackReason != reason || r.Status != "done" {
		t.Errorf("want failed/%s, got ai_state=%s reason=%s status=%s", reason, r.AIState, r.FallbackReason, r.Status)
	}
	if len(r.Items) != 0 || r.Total.Kcal != 0 || len(r.FailedSpans) != 1 || len(r.CustomItems) != 1 || !r.CustomItems[0].NeedsInput {
		t.Errorf("failed state must carry no kcal, one open span: %+v", r)
	}
}
