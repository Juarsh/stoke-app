package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/food"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// failAI fails every call (error), times out, or blocks (to fill the queue).
type failAI struct {
	err   error
	block chan struct{}
}

func (f failAI) EstimateMeal(ctx context.Context, _ string, _ []food.Span, _ []parser.Item) ([]parser.Item, error) {
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
		}
		return nil, errors.New("blocked")
	}
	return nil, f.err
}


// When the AI fails, confident table matches stay claimed table items; only
// the unclaimed span becomes a placeholder to confirm.
func TestFallbackKeepsClaimedItems(t *testing.T) {
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	cases := []struct {
		name, want string
		fb         food.Fallback
		perMin, mx int
	}{
		{"error", "error", failAI{err: errors.New("gemini 500")}, -1, 500},
		{"timeout", "error", failAI{err: context.DeadlineExceeded}, -1, 500},
		{"busy", "busy", failAI{block: block}, 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := setupWith(t, func(c *Config) { c.Fallback, c.AIMode, c.AIPerMinute, c.AIQueueMax = tc.fb, "gemini", tc.perMin, tc.mx })
			var r parseOut
			if tc.name == "busy" { // one job running, one waiting: the third is busy
				for _, u := range []string{"b1", "b2"} {
					call(t, srv, "POST", "/v1/parse", u, M{"text": "2 roti aur 1 plate zorbu", "use_ai": true}, nil)
					time.Sleep(20 * time.Millisecond)
				}
				if c := call(t, srv, "POST", "/v1/parse", "b3", M{"text": "2 roti aur 1 plate zorbu", "use_ai": true}, &r); c != 200 {
					t.Fatalf("busy parse: %d %+v", c, r)
				}
			} else {
				_, r = parseAI(t, srv, "f-"+tc.name, "2 roti aur 1 plate zorbu")
			}
			if r.Fallback != tc.want || len(r.Items) != 2 {
				t.Fatalf("fallback %q: %+v", tc.want, r)
			}
			roti, x := r.Items[0], r.Items[1]
			if roti.DishID != "roti" || roti.Source != "table" || roti.NeedsConfirmation || len(roti.Flags) != 0 || roti.Quantity != 2 {
				t.Errorf("claimed roti not kept: %+v", roti)
			}
			if x.Source != "generic" || !x.NeedsConfirmation || x.Kcal.Best <= 0 {
				t.Errorf("unclaimed span: %+v", x)
			}
		})
	}
}

// POST /test/ai/fail (stub builds only): confident table items survive.
func TestStubFailHook(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	for _, mode := range []string{"error", "timeout"} {
		if c := call(t, srv, "POST", "/test/ai/fail", "", M{"mode": mode}, nil); c != 200 {
			t.Fatalf("hook %s: %d", mode, c)
		}
		_, r := parseAI(t, srv, "hf-"+mode, "3 idli aur 1 plate tirnolu")
		if r.Fallback != "error" || len(r.Items) != 2 || r.Items[0].DishID != "idli" || r.Items[0].Source != "table" || r.Items[0].NeedsConfirmation {
			t.Errorf("%s: %+v", mode, r)
		}
	}
	if c := call(t, srv, "POST", "/test/ai/fail", "", M{"mode": "nope"}, nil); c != 400 {
		t.Errorf("bad mode: %d", c)
	}
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": ""}, nil)
}
