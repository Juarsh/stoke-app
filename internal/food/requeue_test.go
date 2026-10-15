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
	d, m := RequeueDelays, MaxRequeues
	RequeueDelays = []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}
	t.Cleanup(func() { RequeueDelays, MaxRequeues = d, m })
}

func requeueSvc(t *testing.T, modes ...string) (*Service, *Stub, *Queue) {
	p, err := parser.New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	stub := &Stub{}
	s := &Service{Parser: p, Fallback: &seqFallback{stub: stub, modes: modes}, Quota: &Quota{}}
	q := NewQueue(0, 10)
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

func TestBusyGivesUpAsErrorAfterMaxRequeues(t *testing.T) {
	fastRequeue(t)
	MaxRequeues = 2
	_, stub, q := requeueSvc(t, "busy", "busy", "busy", "busy")
	j := addJob(t, q)
	r := waitDone(t, q, j.ID).Result
	if stub.Calls() != 3 {
		t.Errorf("calls %d, want 1 + 2 requeues", stub.Calls())
	}
	assertFailed(t, r, "error")
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
