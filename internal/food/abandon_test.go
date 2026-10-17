package food

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// blockingFallback: each call waits for release, then answers via the stub.
type blockingFallback struct {
	stub    *Stub
	started chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (f *blockingFallback) EstimateMeal(ctx context.Context, text string, spans []Span, hint []parser.Item) ([]parser.Item, error) {
	f.calls.Add(1)
	f.started <- struct{}{}
	<-f.release
	return f.stub.EstimateMeal(ctx, text, spans, hint)
}

// An attempt in flight when the app abandons the job: its result is dropped.
func TestAbandonDropsInFlightResult(t *testing.T) {
	p, err := parser.New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	fb := &blockingFallback{stub: &Stub{}, started: make(chan struct{}, 4), release: make(chan struct{})}
	s := &Service{Parser: p, Fallback: fb, Quota: &Quota{}}
	q := NewQueue(0, 10)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s.Start(ctx, q)
	j := addJob(t, q)
	<-fb.started
	if !q.Abandon(1, j.ID) {
		t.Fatal("abandon")
	}
	if q.Abandon(2, j.ID) {
		t.Error("another user abandoned it")
	}
	close(fb.release) // the AI answers after the abandon
	time.Sleep(50 * time.Millisecond)
	got, ok := q.Get(1, j.ID)
	if !ok || got.Status != "abandoned" || len(got.Result.Items) != 0 {
		t.Fatalf("late result kept: %+v", got)
	}
	if fb.calls.Load() != 1 || q.Pending() != 0 {
		t.Errorf("calls=%d pending=%d", fb.calls.Load(), q.Pending())
	}
}

// A requeued (busy) job abandoned before its next try never gets another attempt.
func TestAbandonStopsRequeue(t *testing.T) {
	fastRequeue(t)
	_, stub, q := requeueSvc(t, "busy", "busy", "busy")
	j := addJob(t, q)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if g, _ := q.Get(1, j.ID); g.Requeues > 0 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !q.Abandon(1, j.ID) {
		t.Fatal("abandon")
	}
	n := stub.Calls()
	time.Sleep(200 * time.Millisecond)
	if stub.Calls() != n {
		t.Errorf("AI attempts after abandon: %d -> %d", n, stub.Calls())
	}
	if g, _ := q.Get(1, j.ID); g.Status != "abandoned" {
		t.Errorf("status %q", g.Status)
	}
}

// NextReset across the US DST change: midnight Pacific is 12:30 PM IST in
// PDT and 1:30 PM IST from Nov 1 (PST).
func TestNextResetAcrossDST(t *testing.T) {
	q := &Quota{}
	for _, c := range []struct{ now, want string }{
		{"2026-10-18T06:59:00Z", "2026-10-18T07:00:00Z"}, // 12:29 PM IST -> 12:30 PM IST today
		{"2026-10-18T07:01:00Z", "2026-10-19T07:00:00Z"}, // 12:31 PM IST -> tomorrow 12:30 PM IST
		{"2026-11-01T05:00:00Z", "2026-11-01T07:00:00Z"}, // Nov 1 10:30 AM IST: still the PDT day
		{"2026-11-01T07:01:00Z", "2026-11-02T08:00:00Z"}, // after it: next midnight is PST = 1:30 PM IST
	} {
		now, _ := time.Parse(time.RFC3339, c.now)
		if got := q.NextReset(now).UTC().Format(time.RFC3339); got != c.want {
			t.Errorf("NextReset(%s)=%s, want %s", c.now, got, c.want)
		}
	}
}
