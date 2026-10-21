package stoke_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/auth"
	"github.com/akarsh/calorie-tracker/internal/stoke"
	"github.com/akarsh/calorie-tracker/internal/store"
	"github.com/akarsh/calorie-tracker/internal/store/storetest"
)

var now = time.Date(2026, 10, 21, 6, 0, 0, 0, time.UTC)

func server(t *testing.T) *httptest.Server {
	pool, _ := storetest.Schema(t, true)
	st := &store.PG{DB: pool}
	mux := http.NewServeMux()
	(&stoke.Service{Plans: st, Workouts: st, Habits: st, Now: func() time.Time { return now }}).Routes(mux, auth.Middleware(auth.DevVerifier{}, auth.PGUsers{DB: pool}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func call(t *testing.T, srv *httptest.Server, method, path, user string, body any) (int, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if s, ok := body.(string); ok {
		rd = bytes.NewReader([]byte(s))
	} else {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rd)
	req.Header.Set("Authorization", "Bearer dev:"+user)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func reason(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	s, _ := e["message"].(string)
	return s
}

func workout(ver any) map[string]any {
	w := map[string]any{"title": "Push", "plan_id": nil, "routine_id": nil, "local_date": "2026-10-21",
		"started_at": "2026-10-21T05:00:00.123Z", "ended_at": "2026-10-21T05:47:00Z",
		"exercises": []any{
			map[string]any{"id": "x1", "exercise_id": "wger-73", "kind": "weight", "rest_s": 90, "target": map[string]any{"sets": 3, "repsLow": 8, "repsHigh": 10},
				"sets": []any{
					map[string]any{"id": "s1", "done": true, "kg": 62.5, "reps": 10, "done_at": "2026-10-21T05:05:00Z"},
					map[string]any{"id": "s2", "done": true, "kg": 62.5, "reps": 8, "done_at": "2026-10-21T05:08:00Z"},
					map[string]any{"id": "s3", "done": false, "kg": nil, "reps": nil, "done_at": nil}}},
			map[string]any{"id": "x2", "exercise_id": "pullup", "kind": "bodyweight", "rest_s": 120, "target": nil,
				"sets": []any{map[string]any{"id": "s4", "done": true, "kg": nil, "reps": 6, "done_at": "2026-10-21T05:20:00Z"},
					map[string]any{"id": "s5", "done": true, "kg": 10, "reps": 5, "done_at": "2026-10-21T05:24:00Z"}}},
			map[string]any{"id": "x3", "exercise_id": "plank", "kind": "time", "rest_s": 60, "target": nil,
				"sets": []any{map[string]any{"id": "s6", "done": true, "kg": nil, "reps": 60, "done_at": "2026-10-21T05:40:00Z"}}},
		}}
	if ver != nil {
		w["version"] = ver
	}
	return w
}

func TestWorkoutSummaryAndVersions(t *testing.T) {
	srv := server(t)
	code, w := call(t, srv, "PUT", "/v1/workouts/w1", "a", workout(nil))
	if code != 200 {
		t.Fatalf("%d %v", code, w)
	}
	sum := w["summary"].(map[string]any)
	// 62.5×10 + 62.5×8 + 10×5 (bodyweight: added kg only) = 1175; plank counts no volume
	want := map[string]float64{"volume_kg": 1175, "sets_done": 5, "sets_total": 6, "reps": 29, "seconds": 60, "exercises": 3, "exercises_started": 3, "duration_min": 47}
	for k, v := range want {
		if sum[k] != v {
			t.Errorf("summary %s = %v, want %v", k, sum[k], v)
		}
	}
	if w["version"] != 1.0 || w["started_at"] != "2026-10-21T05:00:00.123Z" {
		t.Fatalf("row: %v %v", w["version"], w["started_at"])
	}
	// replay (lost answer): the stored row
	if code, r := call(t, srv, "PUT", "/v1/workouts/w1", "a", workout(nil)); code != 200 || r["version"] != 1.0 {
		t.Fatalf("replay %d %v", code, r)
	}
	// device B edits on version 1
	b := workout(1)
	b["title"] = "Push day"
	if code, r := call(t, srv, "PUT", "/v1/workouts/w1", "a", b); code != 200 || r["version"] != 2.0 {
		t.Fatalf("edit %d %v", code, r)
	}
	// device A edits on version 1 too: 409 with the server's row (and its summary); the row is not overwritten
	a := workout(1)
	a["title"] = "Chest"
	code, c := call(t, srv, "PUT", "/v1/workouts/w1", "a", a)
	row, _ := c["row"].(map[string]any)
	if code != 409 || row["title"] != "Push day" || row["summary"] == nil || c["error"].(map[string]any)["code"] != "version_conflict" || reason(c) == "" {
		t.Fatalf("conflict %d %v", code, c)
	}
	if _, g := call(t, srv, "GET", "/v1/workouts/w1", "a", nil); g["title"] != "Push day" {
		t.Fatalf("overwritten: %v", g["title"])
	}
	// other users don't see it
	if code, _ := call(t, srv, "GET", "/v1/workouts/w1", "b", nil); code != 404 {
		t.Fatalf("other user %d", code)
	}
	// delete: stale version 409, right version 204, then edits are gone (404)
	if code, _ := call(t, srv, "DELETE", "/v1/workouts/w1?version=1", "a", nil); code != 409 {
		t.Fatalf("stale delete %d", code)
	}
	if code, _ := call(t, srv, "DELETE", "/v1/workouts/w1?version=2", "a", nil); code != 204 {
		t.Fatalf("delete %d", code)
	}
	if code, g := call(t, srv, "PUT", "/v1/workouts/w1", "a", workout(2)); code != 404 || g["error"].(map[string]any)["code"] != "gone" {
		t.Fatalf("after delete %d %v", code, g)
	}
	if _, l := call(t, srv, "GET", "/v1/workouts?from=2026-10-01", "a", nil); len(l["workouts"].([]any)) != 0 {
		t.Fatalf("list after delete %v", l)
	}
}

func TestBadValuesAreRefusedWithAReason(t *testing.T) {
	srv := server(t)
	set := func(f func(w map[string]any)) map[string]any { w := workout(nil); f(w); return w }
	ex := func(w map[string]any, i int) map[string]any { return w["exercises"].([]any)[i].(map[string]any) }
	st := func(w map[string]any, i, j int) map[string]any { return ex(w, i)["sets"].([]any)[j].(map[string]any) }
	cases := []struct {
		path, why string
		body      any
	}{
		{"/v1/workouts/w1", "kg must be a number from 0 to 1,000.", set(func(w map[string]any) { st(w, 0, 0)["kg"] = 1200 })},
		{"/v1/workouts/w1", "kg must be a number from 0 to 1,000.", set(func(w map[string]any) { st(w, 0, 0)["kg"] = -5 })},
		{"/v1/workouts/w1", "Reps must be a whole number from 1 to 200.", set(func(w map[string]any) { st(w, 0, 0)["reps"] = 500 })},
		{"/v1/workouts/w1", "A timed set has no kg.", set(func(w map[string]any) { st(w, 2, 0)["kg"] = 5 })},
		{"/v1/workouts/w1", "kg can have at most 2 decimals (like 62.5).", set(func(w map[string]any) { st(w, 0, 0)["kg"] = 62.555 })},
		{"/v1/workouts/w1", "Seconds must be a whole number from 1 to 86,400.", set(func(w map[string]any) { st(w, 2, 0)["reps"] = 90000 })},
		{"/v1/workouts/w1", "ended_at is before started_at.", set(func(w map[string]any) { w["ended_at"] = "2026-10-21T04:00:00Z" })},
		{"/v1/workouts/w1", "local_date can’t be in the future.", set(func(w map[string]any) { w["local_date"] = "2026-10-25" })},
		{"/v1/workouts/w1", "kind must be weight, bodyweight or time.", set(func(w map[string]any) { ex(w, 0)["kind"] = "cardio" })},
		{"/v1/workouts/w1", "Rest must be 0 to 600 seconds.", set(func(w map[string]any) { ex(w, 0)["rest_s"] = 900 })},
		{"/v1/workouts/w1", "Enter a title.", set(func(w map[string]any) { w["title"] = "  " })},
		{"/v1/workouts/w1", "version must be a whole number from 1.", workout(0)},
		{"/v1/workouts/w1", "invalid JSON", `{"title":"x","colour":"red"}`},
		{"/v1/workouts/bad%20id", "Bad id.", workout(nil)},
		{"/v1/habits/h1", "Target must be a whole number from 1 to 999.", map[string]any{"name": "Water", "short_name": "Water", "short_name_auto": true, "icon": "drop", "kind": "count", "target_value": 0, "unit": "glasses", "target_sets": nil, "target_reps": nil, "schedule": "daily", "weekdays": 127, "starts_on": "2026-10-01", "position": 0, "archived_at": nil}},
		{"/v1/habits/h1", "Steps are on the Food card, so they can’t be a habit.", map[string]any{"name": "Walk", "short_name": "Walk", "kind": "count", "target_value": 10, "unit": "steps", "schedule": "daily", "weekdays": 127, "starts_on": "2026-10-01"}},
		{"/v1/habits/h1", "Unit can be at most 16 characters.", map[string]any{"name": "Swim", "short_name": "Swim", "kind": "count", "target_value": 10, "unit": "lengths of the pool", "schedule": "daily", "weekdays": 127, "starts_on": "2026-10-01"}},
		{"/v1/habits/h1", "Unit can’t start or end with a space.", map[string]any{"name": "Swim", "short_name": "Swim", "kind": "count", "target_value": 10, "unit": " laps", "schedule": "daily", "weekdays": 127, "starts_on": "2026-10-01"}},
		{"/v1/habits/h1", "Enter a unit.", map[string]any{"name": "Swim", "short_name": "Swim", "kind": "count", "target_value": 10, "unit": "", "schedule": "daily", "weekdays": 127, "starts_on": "2026-10-01"}},
		{"/v1/habits/h1", "Pick a unit.", map[string]any{"name": "Swim", "short_name": "Swim", "kind": "count", "target_value": 10, "unit": nil, "schedule": "daily", "weekdays": 127, "starts_on": "2026-10-01"}},
		{"/v1/habits/h1", "Short name can be at most 16 characters.", map[string]any{"name": "Walk", "short_name": "Walk the dog twice", "kind": "done", "schedule": "daily", "weekdays": 127, "starts_on": "2026-10-01"}},
		{"/v1/habits/h1", "weekdays doesn’t match the schedule.", map[string]any{"name": "Walk", "short_name": "Walk", "kind": "done", "schedule": "weekdays", "weekdays": 127, "starts_on": "2026-10-01"}},
		{"/v1/plans/p1", "A day names a routine that isn’t in this plan.", map[string]any{"name": "PPL", "days": []string{"r9", "", "", "", "", "", ""}, "active": true, "routines": []any{}}},
		{"/v1/plans/p1", "Target reps must be 1 to 50, low to high.", map[string]any{"name": "PPL", "days": []string{"", "", "", "", "", "", ""}, "routines": []any{map[string]any{"id": "r1", "name": "Push", "exercises": []any{map[string]any{"exercise_id": "a", "rest_s": 90, "target": map[string]any{"sets": 3, "repsLow": 12, "repsHigh": 8}}}}}}},
		{"/v1/plans/p1", "days must list Mon to Sun (7 entries).", map[string]any{"name": "PPL", "days": []string{""}, "routines": []any{}}},
	}
	for _, c := range cases {
		code, out := call(t, srv, "PUT", c.path, "a", c.body)
		if code != 400 || !strings.HasPrefix(reason(out), c.why) {
			t.Errorf("%s %q: %d %q", c.path, c.why, code, reason(out))
		}
	}
	// nothing was stored by a refused write
	if code, _ := call(t, srv, "GET", "/v1/workouts/w1", "a", nil); code != 404 {
		t.Errorf("refused workout was stored (%d)", code)
	}
}

func habit(short string, ver any) map[string]any {
	h := map[string]any{"name": "Drink water", "short_name": short, "short_name_auto": false, "icon": "drop", "kind": "count", "target_value": 8, "unit": "glasses",
		"target_sets": nil, "target_reps": nil, "schedule": "days", "weekdays": 0b0010101, "starts_on": "2026-10-01", "position": 0, "archived_at": nil}
	if ver != nil {
		h["version"] = ver
	}
	return h
}

func TestHabitsAndLogs(t *testing.T) {
	srv := server(t)
	if code, h := call(t, srv, "PUT", "/v1/habits/h1", "a", habit("Water", nil)); code != 200 || h["version"] != 1.0 || h["weekdays"] != 21.0 {
		t.Fatalf("%d %v", code, h)
	}
	// a count unit is short free text, stored and returned as sent (and a stored "glass" stays "glass")
	for i, u := range []string{"times", "big cups", "glass", "लैप्स"} {
		hu := habit(fmt.Sprintf("U%d", i), nil)
		hu["unit"] = u
		id := fmt.Sprintf("/v1/habits/u%d", i)
		if code, h := call(t, srv, "PUT", id, "a", hu); code != 200 || h["unit"] != u {
			t.Fatalf("unit %q: %d %v", u, code, h)
		}
		if _, h := call(t, srv, "GET", "/v1/habits", "a", nil); !strings.Contains(fmt.Sprint(h["habits"]), "unit:"+u) {
			t.Fatalf("unit %q not round-tripped: %v", u, h)
		}
		if code, _ := call(t, srv, "DELETE", id+"?version=1", "a", nil); code != 204 {
			t.Fatalf("delete %s %d", id, code)
		}
	}
	if code, h := call(t, srv, "PUT", "/v1/habits/h2", "a", habit("wa-ter", nil)); code != 400 || reason(h) != "Already used, pick another" {
		t.Fatalf("short name %d %v", code, h)
	}
	logBody := func(v int, ver any) map[string]any {
		b := map[string]any{"id": fmt.Sprintf("l%d", v), "value": v, "done": v >= 8, "logged_at": "2026-10-21T05:00:00Z",
			"target_snapshot": map[string]any{"kind": "count", "value": 8, "unit": "glasses", "sets": nil, "reps": nil}}
		if ver != nil {
			b["version"] = ver
		}
		return b
	}
	if code, l := call(t, srv, "PUT", "/v1/habits/h1/logs/2026-10-21", "a", logBody(3, nil)); code != 200 || l["value"] != 3.0 {
		t.Fatalf("log %d %v", code, l)
	}
	// second phone, same day, never saw the first log: 409 with the server's log
	code, c := call(t, srv, "PUT", "/v1/habits/h1/logs/2026-10-21", "a", logBody(5, nil))
	if row, _ := c["row"].(map[string]any); code != 409 || row["value"] != 3.0 {
		t.Fatalf("conflict %d %v", code, c)
	}
	if code, l := call(t, srv, "PUT", "/v1/habits/h1/logs/2026-10-21", "a", logBody(8, 1)); code != 200 || l["version"] != 2.0 || l["done"] != true {
		t.Fatalf("edit %d %v", code, l)
	}
	if code, l := call(t, srv, "PUT", "/v1/habits/nope/logs/2026-10-21", "a", logBody(8, nil)); code != 404 || l["error"].(map[string]any)["code"] != "habit_not_found" {
		t.Fatalf("no habit %d %v", code, l)
	}
	if code, l := call(t, srv, "PUT", "/v1/habits/h1/logs/2026-10-30", "a", logBody(8, nil)); code != 400 || reason(l) != "The day can’t be in the future." {
		t.Fatalf("future %d %v", code, l)
	}
	if _, ls := call(t, srv, "GET", "/v1/habit-logs?from=2026-10-01&to=2026-10-31", "a", nil); len(ls["logs"].([]any)) != 1 {
		t.Fatalf("logs %v", ls)
	}
	if code, _ := call(t, srv, "DELETE", "/v1/habits/h1/logs/2026-10-21?version=2", "a", nil); code != 204 {
		t.Fatalf("delete log %d", code)
	}
	// archive is an edit (archived_at); then the short name is free again
	arch := habit("Water", 1)
	arch["archived_at"] = "2026-10-21T05:00:00Z"
	if code, h := call(t, srv, "PUT", "/v1/habits/h1", "a", arch); code != 200 || h["archived_at"] == nil {
		t.Fatalf("archive %d %v", code, h)
	}
	if code, _ := call(t, srv, "PUT", "/v1/habits/h2", "a", habit("Water", nil)); code != 200 {
		t.Fatalf("short name after archive %d", code)
	}
	if _, hs := call(t, srv, "GET", "/v1/habits", "a", nil); len(hs["habits"].([]any)) != 2 {
		t.Fatalf("habits %v", hs)
	}
}

func TestPlans(t *testing.T) {
	srv := server(t)
	p := map[string]any{"name": "PPL", "days": []string{"r1", "", "r2", "", "r1", "", ""}, "active": true, "routines": []any{
		map[string]any{"id": "r1", "name": "Push", "exercises": []any{map[string]any{"exercise_id": "wger-73", "rest_s": 90, "target": map[string]any{"sets": 3, "repsLow": 8, "repsHigh": 12}}}},
		map[string]any{"id": "r2", "name": "Pull", "exercises": []any{}}}}
	code, out := call(t, srv, "PUT", "/v1/plans/p1", "a", p)
	if code != 200 || out["version"] != 1.0 || len(out["routines"].([]any)) != 2 {
		t.Fatalf("%d %v", code, out)
	}
	if _, l := call(t, srv, "GET", "/v1/plans", "a", nil); len(l["plans"].([]any)) != 1 {
		t.Fatalf("list %v", l)
	}
	if code, _ := call(t, srv, "DELETE", "/v1/plans/p1", "a", nil); code != 204 { // version 1 = this phone's own create
		t.Fatalf("delete %d", code)
	}
	if code, _ := call(t, srv, "GET", "/v1/plans/p1", "a", nil); code != 404 {
		t.Fatalf("get deleted %d", code)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/v1/plans", nil)
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 401 {
		t.Fatalf("no token %d", res.StatusCode)
	}
}
