package store_test

import (
	"encoding/json"
	"testing"

	"github.com/akarsh/calorie-tracker/internal/store"
	"github.com/akarsh/calorie-tracker/internal/store/storetest"
)

// fill: a user with a food entry, a plan, a workout, a habit with a log (and a second user).
func fill(t *testing.T, s *store.PG) (int64, int64) {
	t.Helper()
	a, _ := s.Resolve(ctx, "google", "sub-a", "a@x.in", "A")
	b, _ := s.Resolve(ctx, "dev", "dev:b", "", "")
	if _, err := s.DB.Exec(ctx, `INSERT INTO food_entries(user_id,client_id,local_date,slot,custom_name,qty,unit,kcal_best,kcal_low,kcal_high,protein_best,protein_low,protein_high,source)
		VALUES ($1,'c1','2026-10-20','lunch','dal',1,'bowl',200,180,220,10,9,11,'custom')`, a); err != nil {
		t.Fatal(err)
	}
	for _, u := range []int64{a, b} {
		if _, err := s.PutPlan(ctx, u, store.Plan{ID: "p1", Name: "PPL", Days: []string{"r1", "", "", "", "", "", ""}, Routines: []store.Routine{{ID: "r1", Name: "Push", Exercises: []store.RoutineExercise{}}}}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.PutWorkout(ctx, a, sampleWorkout(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutHabit(ctx, a, habit("h1", "Water"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutLog(ctx, a, store.HabitLog{ID: "l1", HabitID: "h1", LocalDate: "2026-10-20", Done: true, TargetSnapshot: json.RawMessage(`{"kind":"done"}`), LoggedAt: sampleWorkout().StartedAt}, nil); err != nil {
		t.Fatal(err)
	}
	return a, b
}

// dumpJSON: a dump's rows, comparable across databases.
func dumpJSON(t *testing.T, d store.Dump) string {
	d.Created = d.Created.Truncate(0)
	d.Created = d.Created.AddDate(-d.Created.Year()+1, 0, 0)
	b, err := json.Marshal(struct {
		T []string
		R map[string][]json.RawMessage
	}{d.Tables, d.Rows})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestExportImportRoundTrip(t *testing.T) {
	src := newStore(t)
	a, _ := fill(t, src)

	// whole database -> an empty migrated schema: every table back, row for row
	all, err := src.Export(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(all) // through JSON, as the command writes it
	var back store.Dump
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	dstPool, _ := storetest.Schema(t, true)
	dst := &store.PG{DB: dstPool}
	if _, err := dst.DB.Exec(ctx, `TRUNCATE dishes CASCADE`); err != nil { // the migrations seed shared rows; the dump has them
		t.Logf("truncate dishes: %v", err)
	}
	if err := dst.Import(ctx, back); err != nil {
		t.Fatal(err)
	}
	again, err := dst.Export(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if dumpJSON(t, all) != dumpJSON(t, again) {
		t.Fatal("whole-database round trip differs")
	}
	// the restored database works: versions and sequences continue
	if w, err := dst.GetWorkout(ctx, a, "w1"); err != nil || len(w.Exercises[0].Sets) != 3 {
		t.Fatalf("restored workout: %+v %v", w, err)
	}
	if id, err := dst.Resolve(ctx, "dev", "dev:new", "", ""); err != nil || id <= a {
		t.Fatalf("sequence after import: %d %v", id, err)
	}
	// importing again refuses (rows exist): nothing is merged or overwritten
	if err := dst.Import(ctx, back); err == nil {
		t.Fatal("second import should fail")
	}

	// one user -> a fresh schema: only that user's rows
	one, err := src.Export(ctx, &a)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(one.Rows["users"]); n != 1 {
		t.Fatalf("users in one-user dump: %d", n)
	}
	if n := len(one.Rows["plans"]); n != 1 {
		t.Fatalf("plans in one-user dump: %d", n)
	}
	p2, _ := storetest.Schema(t, true)
	dst2 := &store.PG{DB: p2}
	if err := dst2.Import(ctx, one); err != nil {
		t.Fatal(err)
	}
	re, _ := dst2.Export(ctx, &a)
	if dumpJSON(t, one) != dumpJSON(t, re) {
		t.Fatal("one-user round trip differs")
	}
	if err := dst2.Import(ctx, store.Dump{Format: "x"}); err == nil {
		t.Fatal("bad format accepted")
	}
}
