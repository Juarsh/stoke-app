package store_test

import (
	"testing"
	"time"
)

func TestCoachAskCap(t *testing.T) {
	s := newStore(t)
	a, err := s.Resolve(ctx, "dev", "dev:ask-a", "", "")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := s.Resolve(ctx, "dev", "dev:ask-b", "", "")
	day := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	for i := 1; i <= 20; i++ {
		used, ok, err := s.TryCoachAsk(ctx, a, day, 20)
		if err != nil || !ok || used != i {
			t.Fatalf("ask %d: used=%d ok=%v err=%v", i, used, ok, err)
		}
	}
	used, ok, err := s.TryCoachAsk(ctx, a, day, 20)
	if err != nil || ok || used != 20 {
		t.Fatalf("over: used=%d ok=%v err=%v", used, ok, err)
	}
	n, err := s.CoachAskCount(ctx, a, day)
	if err != nil || n != 20 {
		t.Fatalf("count %d %v", n, err)
	}
	// another user and the next day each have their own cap
	used, ok, err = s.TryCoachAsk(ctx, b, day, 20)
	if err != nil || !ok || used != 1 {
		t.Fatalf("other user: used=%d ok=%v err=%v", used, ok, err)
	}
	used, ok, err = s.TryCoachAsk(ctx, a, day.AddDate(0, 0, 1), 20)
	if err != nil || !ok || used != 1 {
		t.Fatalf("next day: used=%d ok=%v err=%v", used, ok, err)
	}
	if n, _ = s.CoachAskCount(ctx, a, day); n != 20 {
		t.Fatalf("original day stayed at %d", n)
	}
}
