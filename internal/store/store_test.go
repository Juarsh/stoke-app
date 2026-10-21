package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/store"
	"github.com/akarsh/calorie-tracker/internal/store/storetest"
)

var ctx = context.Background()

func ip(n int) *int { return &n }

func newStore(t *testing.T) *store.PG {
	pool, _ := storetest.Schema(t, true)
	return &store.PG{DB: pool}
}

func TestResolveMapsIdentitiesToOurIDs(t *testing.T) {
	s := newStore(t)
	a, err := s.Resolve(ctx, "google", "1234567890", "a@x.in", "A")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := s.Resolve(ctx, "google", "1234567890", "a2@x.in", "A")
	b, _ := s.Resolve(ctx, "dev", "dev:b", "b@dev.local", "")
	if a != again || a == b {
		t.Fatalf("ids: %d %d %d", a, again, b)
	}
	var email, provider string
	_ = s.DB.QueryRow(ctx, `SELECT email FROM users WHERE id=$1`, a).Scan(&email)
	_ = s.DB.QueryRow(ctx, `SELECT provider FROM user_identities WHERE user_id=$1`, b).Scan(&provider)
	if email != "a2@x.in" || provider != "dev" {
		t.Fatalf("email %q provider %q", email, provider)
	}
	// a user made before M4 (users.google_sub only) keeps its id: 019 backfilled identities, Resolve finds the row
	var old int64
	_ = s.DB.QueryRow(ctx, `INSERT INTO users(google_sub,email) VALUES ('legacy-sub','l@x.in') RETURNING id`).Scan(&old)
	got, err := s.Resolve(ctx, "google", "legacy-sub", "l@x.in", "")
	if err != nil || got != old {
		t.Fatalf("legacy user %d, resolved %d (%v)", old, got, err)
	}
}

func habit(id, short string) store.Habit {
	return store.Habit{ID: id, Name: "Drink water", ShortName: short, ShortNameAuto: true, Kind: "done", Schedule: "daily", Weekdays: 127, StartsOn: "2026-10-01"}
}

func TestVersionRules(t *testing.T) {
	s := newStore(t)
	uid, _ := s.Resolve(ctx, "dev", "dev:v", "", "")
	h, err := s.PutHabit(ctx, uid, habit("h1", "Water"), nil)
	if err != nil || h.Version != 1 {
		t.Fatalf("create: %+v %v", h, err)
	}
	// replay of the same write (its answer was lost): the stored row, nothing written
	if r, err := s.PutHabit(ctx, uid, habit("h1", "Water"), nil); err != nil || r.Version != 1 {
		t.Fatalf("replay: %+v %v", r, err)
	}
	// device B edits on version 1 -> 2
	b := habit("h1", "Agua")
	if r, err := s.PutHabit(ctx, uid, b, ip(1)); err != nil || r.Version != 2 || r.ShortName != "Agua" {
		t.Fatalf("edit: %+v %v", r, err)
	}
	// device A, still on version 1 (or sending none): a conflict with the server's row, nothing overwritten
	for _, v := range []*int{ip(1), nil} {
		_, err = s.PutHabit(ctx, uid, habit("h1", "H2O"), v)
		var c *store.Conflict
		if !errors.As(err, &c) || c.Version != 2 || c.Current.(store.Habit).ShortName != "Agua" {
			t.Fatalf("stale edit: %v", err)
		}
	}
	if _, err := s.PutHabit(ctx, uid, habit("h2", "agua"), nil); !errors.Is(err, store.ErrShortNameTaken) {
		t.Fatalf("short name: %v", err)
	}
	// stale delete is a conflict; the right version deletes; a later edit is ErrGone
	var c *store.Conflict
	if err := s.DeleteHabit(ctx, uid, "h1", ip(1)); !errors.As(err, &c) {
		t.Fatalf("stale delete: %v", err)
	}
	if err := s.DeleteHabit(ctx, uid, "h1", ip(2)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutHabit(ctx, uid, b, ip(2)); !errors.Is(err, store.ErrGone) {
		t.Fatalf("edit after delete: %v", err)
	}
	if err := s.DeleteHabit(ctx, uid, "nope", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	// another user never sees the row
	other, _ := s.Resolve(ctx, "dev", "dev:o", "", "")
	if _, err := s.GetHabit(ctx, other, "h1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("other user: %v", err)
	}
}

func TestLogsConflictWithoutVersion(t *testing.T) {
	s := newStore(t)
	uid, _ := s.Resolve(ctx, "dev", "dev:l", "", "")
	if _, err := s.PutLog(ctx, uid, store.HabitLog{ID: "l1", HabitID: "nope", LocalDate: "2026-10-20", Done: true, TargetSnapshot: json.RawMessage(`{}`), LoggedAt: time.Now()}, nil); !errors.Is(err, store.ErrParentMissing) {
		t.Fatalf("parent: %v", err)
	}
	_, _ = s.PutHabit(ctx, uid, habit("h", "Water"), nil)
	snap := json.RawMessage(`{"kind":"count","value":8,"unit":"glasses","sets":null,"reps":null}`)
	a := store.HabitLog{ID: "la", HabitID: "h", LocalDate: "2026-10-20", Value: ip(3), TargetSnapshot: snap, LoggedAt: time.Now()}
	if l, err := s.PutLog(ctx, uid, a, nil); err != nil || l.Version != 1 {
		t.Fatalf("log: %+v %v", l, err)
	}
	if l, err := s.PutLog(ctx, uid, a, nil); err != nil || l.Version != 1 {
		t.Fatalf("replay: %+v %v", l, err)
	}
	// a second phone logged the same day without knowing: conflict, the first log stays
	bl := a
	bl.ID, bl.Value = "lb", ip(5)
	var c *store.Conflict
	if _, err := s.PutLog(ctx, uid, bl, nil); !errors.As(err, &c) || *c.Current.(store.HabitLog).Value != 3 {
		t.Fatalf("second phone: %v", err)
	}
	// un-tick then tick again (a deleted log is logged again)
	if err := s.DeleteLog(ctx, uid, "h", "2026-10-20", ip(1)); err != nil {
		t.Fatal(err)
	}
	if l, err := s.PutLog(ctx, uid, bl, ip(2)); err != nil || *l.Value != 5 || l.DeletedAt != nil {
		t.Fatalf("again: %+v %v", l, err)
	}
	ls, _ := s.ListLogs(ctx, uid, "2026-10-01", "2026-10-31")
	if len(ls) != 1 {
		t.Fatalf("logs %d", len(ls))
	}
}

func sampleWorkout() store.Workout {
	kg, r1, r2, secs := 60.0, 10, 8, 45
	at := time.Date(2026, 10, 20, 5, 10, 0, 0, time.UTC)
	return store.Workout{ID: "w1", Title: "Push", LocalDate: "2026-10-20", StartedAt: at, EndedAt: at.Add(50 * time.Minute), Exercises: []store.WorkoutExercise{
		{ID: "x1", ExerciseID: "wger-73", Kind: "weight", RestS: 90, Target: &store.Target{Sets: 3, RepsLow: 8, RepsHigh: 10}, Sets: []store.WSet{
			{ID: "s1", Done: true, Kg: &kg, Reps: &r1, DoneAt: &at}, {ID: "s2", Done: true, Kg: &kg, Reps: &r2, DoneAt: &at}, {ID: "s3"}}},
		{ID: "x2", ExerciseID: "plank", Kind: "time", RestS: 60, Sets: []store.WSet{{ID: "s4", Done: true, Reps: &secs, DoneAt: &at}}},
	}}
}

func TestWorkoutRoundTripAndReplay(t *testing.T) {
	s := newStore(t)
	uid, _ := s.Resolve(ctx, "dev", "dev:w", "", "")
	w, err := s.PutWorkout(ctx, uid, sampleWorkout(), nil)
	if err != nil || w.Version != 1 || len(w.Exercises) != 2 || len(w.Exercises[0].Sets) != 3 || *w.Exercises[1].Sets[0].Reps != 45 {
		t.Fatalf("put: %+v %v", w, err)
	}
	if r, err := s.PutWorkout(ctx, uid, sampleWorkout(), ip(1)); err != nil || r.Version != 1 {
		t.Fatalf("replay with version: %+v %v", r, err)
	}
	e := sampleWorkout()
	e.Title = "Push day"
	if r, err := s.PutWorkout(ctx, uid, e, ip(1)); err != nil || r.Version != 2 {
		t.Fatalf("edit: %+v %v", r, err)
	}
}

func TestPlanRoutines(t *testing.T) {
	s := newStore(t)
	uid, _ := s.Resolve(ctx, "dev", "dev:p", "", "")
	p := store.Plan{ID: "p1", Name: "PPL", Days: []string{"r1", "", "r2", "", "", "", ""}, Active: true, Routines: []store.Routine{
		{ID: "r1", Name: "Push", Exercises: []store.RoutineExercise{{ExerciseID: "wger-73", RestS: 90, Target: &store.Target{Sets: 3, RepsLow: 8, RepsHigh: 12}}}},
		{ID: "r2", Name: "Pull", Exercises: []store.RoutineExercise{}},
	}}
	got, err := s.PutPlan(ctx, uid, p, nil)
	if err != nil || got.Version != 1 || len(got.Routines) != 2 || got.Routines[0].Exercises[0].Target.RepsHigh != 12 {
		t.Fatalf("%+v %v", got, err)
	}
	p.Routines = p.Routines[:1]
	p.Days[2] = ""
	got, err = s.PutPlan(ctx, uid, p, ip(1))
	if err != nil || got.Version != 2 || len(got.Routines) != 1 {
		t.Fatalf("edit: %+v %v", got, err)
	}
}
