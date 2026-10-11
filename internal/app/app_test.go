package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/auth"
	"github.com/akarsh/calorie-tracker/internal/db"
	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// fakeVerifier stands in for Google: token "good-<sub>" is valid.
type fakeVerifier struct{}

func (fakeVerifier) Verify(_ context.Context, tok string) (auth.Identity, error) {
	if s, ok := strings.CutPrefix(tok, "good-"); ok {
		return auth.Identity{Sub: s, Email: s + "@example.com"}, nil
	}
	return auth.Identity{}, auth.ErrInvalid
}

type fakeAI struct{ calls int }

func (f *fakeAI) Estimate(_ context.Context, text string) ([]parser.Item, error) {
	f.calls++
	return []parser.Item{{Name: text, Quantity: 1, Unit: "katori", Kcal: parser.Range{Low: 200, Best: 250, High: 300}, Protein: parser.Range{Low: 8, Best: 10, High: 12}}}, nil
}

var errSkip = errors.New("skip")

func setup(t *testing.T, ai *fakeAI) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://calorie:calorie@localhost:5432/calorie_test"
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Skipf("no test database: %v", err)
	}
	if _, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool, true); err != nil {
		t.Fatal(err)
	}
	cfg := Config{DB: pool, Verifier: fakeVerifier{}}
	if ai != nil {
		cfg.Fallback = ai
	}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(func() { srv.Close(); pool.Close() })
	return srv, pool
}

func call(t *testing.T, srv *httptest.Server, method, path, user string, body any, out any) int {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	if user != "" {
		req.Header.Set("Authorization", "Bearer good-"+user)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); res.StatusCode != 204 && !strings.HasPrefix(ct, "application/json") {
		t.Errorf("%s %s: content-type %q", method, path, ct)
	}
	if len(res.Cookies()) > 0 {
		t.Errorf("%s %s set cookies", method, path)
	}
	if out != nil && res.StatusCode != 204 {
		_ = json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

type M = map[string]any

func TestAuth(t *testing.T) {
	srv, _ := setup(t, nil)
	if c := call(t, srv, "POST", "/v1/parse", "", M{"text": "2 roti"}, nil); c != 401 {
		t.Errorf("no token: %d", c)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/v1/entries", nil)
	req.Header.Set("Authorization", "Bearer forged")
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 401 {
		t.Errorf("bad token: %d", res.StatusCode)
	}
	if c := call(t, srv, "GET", "/v1/dishes", "", nil, nil); c != 200 {
		t.Errorf("dishes public: %d", c)
	}
}

func TestParseShape(t *testing.T) {
	srv, _ := setup(t, nil)
	var r struct {
		Items []struct {
			Name              string `json:"name"`
			DishID            string `json:"dish_id"`
			AIEstimate        bool   `json:"ai_estimate"`
			Source            string
			NeedsConfirmation bool `json:"needs_confirmation"`
			Kcal              struct{ Best float64 }
		}
		NeedsConfirmation bool `json:"needs_confirmation"`
		Unmatched         []string
		Total             struct {
			Kcal, KcalLow, KcalHigh float64
			ProteinG                float64 `json:"protein_g"`
		}
		UsedAI   bool `json:"used_ai"`
		Fallback string
	}
	if c := call(t, srv, "POST", "/v1/parse", "a", M{"text": "2 roti dal sabzi thoda ghee, quinoa bowl"}, &r); c != 200 {
		t.Fatal(c)
	}
	if len(r.Items) != 5 || r.Items[0].DishID != "roti" || r.Total.Kcal <= 0 || r.Total.ProteinG <= 0 || r.UsedAI {
		t.Errorf("parse: %+v", r)
	}
	// unknown text is never 0 kcal: a generic placeholder that needs confirmation
	if q := r.Items[4]; q.Source != "generic" || !q.NeedsConfirmation || q.Kcal.Best <= 0 || !r.NeedsConfirmation {
		t.Errorf("placeholder: %+v", r.Items[4])
	}
	// a meal with leftovers flags every item; a clean meal doesn't
	if !r.Items[0].NeedsConfirmation {
		t.Errorf("leftover meal not flagged: %+v", r.Items[0])
	}
	var r2 struct {
		Items []struct {
			Source            string
			NeedsConfirmation bool `json:"needs_confirmation"`
		}
		NeedsConfirmation bool `json:"needs_confirmation"`
	}
	call(t, srv, "POST", "/v1/parse", "a", M{"text": "2 roti dal sabzi"}, &r2)
	if r2.Items[0].Source != "table" || r2.Items[0].NeedsConfirmation || r2.NeedsConfirmation {
		t.Errorf("table item: %+v", r2.Items[0])
	}
	if len(r.Unmatched) == 0 || r.Fallback != "not_configured" {
		t.Errorf("unmatched/fallback: %+v", r)
	}
	if c := call(t, srv, "POST", "/v1/parse", "a", M{"text": ""}, nil); c != 400 {
		t.Errorf("empty text: %d", c)
	}
}

func TestAICapAndFlag(t *testing.T) {
	ai := &fakeAI{}
	srv, _ := setup(t, ai)
	var r struct {
		Items []struct {
			AIEstimate bool `json:"ai_estimate"`
			Source     string
		}
		UsedAI      bool `json:"used_ai"`
		Fallback    string
		CustomItems []M `json:"custom_items"`
		Message     string
	}
	for i := 0; i < 20; i++ {
		call(t, srv, "POST", "/v1/parse", "cap", M{"text": "2 roti quinoa"}, &r)
		if !r.UsedAI || len(r.Items) != 2 || !r.Items[1].AIEstimate || r.Items[1].Source != "ai_estimate" || r.Items[0].AIEstimate {
			t.Fatalf("call %d: %+v", i, r)
		}
	}
	r = struct {
		Items []struct {
			AIEstimate bool `json:"ai_estimate"`
			Source     string
		}
		UsedAI      bool `json:"used_ai"`
		Fallback    string
		CustomItems []M `json:"custom_items"`
		Message     string
	}{}
	call(t, srv, "POST", "/v1/parse", "cap", M{"text": "2 roti quinoa"}, &r)
	if r.UsedAI || r.Fallback != "cap_reached" || len(r.CustomItems) != 1 || r.Message == "" || ai.calls != 20 || len(r.Items) != 2 || r.Items[1].Source != "generic" {
		t.Errorf("21st call: %+v (ai calls %d)", r, ai.calls)
	}
	// other users have their own cap
	call(t, srv, "POST", "/v1/parse", "other", M{"text": "quinoa"}, &r)
	if !r.UsedAI {
		t.Errorf("other user capped")
	}
	// use_ai=false skips the fallback
	call(t, srv, "POST", "/v1/parse", "other2", M{"text": "quinoa", "use_ai": false}, &r)
	if r.UsedAI || ai.calls != 21 {
		t.Errorf("use_ai false: %+v", r)
	}
}

type entry struct {
	ID          int64
	LocalDate   string `json:"local_date"`
	Slot        string
	DishID      *string `json:"dish_id"`
	Name        string
	Qty         float64
	Unit        string
	OilLevel    string  `json:"oil_level"`
	KcalBest    float64 `json:"kcal_best"`
	ProteinBest float64 `json:"protein_best"`
	Source      string
	UpdatedAt   time.Time `json:"updated_at"`
	DeletedAt   *string   `json:"deleted_at"`
}

func TestEntriesSummaryStreakCoach(t *testing.T) {
	srv, _ := setup(t, nil)
	fixed := time.Date(2026, 10, 14, 7, 0, 0, 0, time.UTC) // 12:30 IST -> lunch
	httpx.Now = func() time.Time { return fixed }
	t.Cleanup(func() { httpx.Now = time.Now })
	u := "u1"

	// coach before onboarding
	if c := call(t, srv, "GET", "/v1/coach/suggestions", u, nil, nil); c != 404 {
		t.Errorf("coach before profile: %d", c)
	}
	var prof struct{ Target struct{ Kcal, ProteinG int } }
	if c := call(t, srv, "PUT", "/v1/profile", u, M{"sex": "male", "birth_year": 1996, "height_cm": 175, "weight_kg": 80, "activity_level": "moderate", "goal": "fat_loss"}, &prof); c != 200 || prof.Target.Kcal != 2210 {
		t.Fatalf("profile %d %+v", c, prof)
	}
	if c := call(t, srv, "PATCH", "/v1/me", u, M{"diet": "veg"}, nil); c != 200 {
		t.Errorf("diet: %d", c)
	}

	// create from text: slot auto = lunch, date = today IST
	var cr struct {
		Entries   []entry
		Unmatched []string
		Summary   struct {
			KcalIn    float64 `json:"kcal_in"`
			Logged    bool
			StreakDay int `json:"streak_day"`
		}
	}
	if c := call(t, srv, "POST", "/v1/entries", u, M{"text": "2 roti dal"}, &cr); c != 201 {
		t.Fatalf("create: %d", c)
	}
	if len(cr.Entries) != 2 || cr.Entries[0].Slot != "lunch" || cr.Entries[0].LocalDate != "2026-10-14" || len(cr.Unmatched) != 0 || !cr.Summary.Logged || cr.Summary.StreakDay != 1 {
		t.Fatalf("create: %+v", cr)
	}
	// custom item (cap reached path) and an explicit slot/date
	if c := call(t, srv, "POST", "/v1/entries", u, M{"local_date": "2026-10-13", "slot": "dinner", "items": []M{{"custom_name": "ghar ka cake", "kcal": 300, "protein_g": 4, "source": "custom"}}}, &cr); c != 201 || cr.Entries[0].Source != "custom" {
		t.Fatalf("custom: %d %+v", c, cr)
	}
	// bad items
	if c := call(t, srv, "POST", "/v1/entries", u, M{"items": []M{{"dish_id": "nope", "source": "table"}}}, nil); c != 400 {
		t.Errorf("unknown dish: %d", c)
	}
	if c := call(t, srv, "POST", "/v1/entries", u, M{"slot": "brunch", "items": []M{{"dish_id": "roti", "source": "table"}}}, nil); c != 400 {
		t.Errorf("bad slot: %d", c)
	}

	// edit a chip: 2 roti -> 3 roti; dal oil normal -> less
	var list struct {
		Entries []entry
		Total   struct{ Kcal float64 }
	}
	call(t, srv, "GET", "/v1/entries", u, nil, &list)
	roti, dal := list.Entries[0], list.Entries[1]
	var ed entry
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", roti.ID), u, M{"qty": 3}, &ed); c != 200 || ed.Qty != 3 || ed.KcalBest != roti.KcalBest*1.5 {
		t.Errorf("edit qty: %d %+v", c, ed)
	}
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", dal.ID), u, M{"oil_level": "less", "slot": "dinner"}, &ed); c != 200 || ed.OilLevel != "less" || ed.KcalBest >= dal.KcalBest || ed.Slot != "dinner" {
		t.Errorf("edit oil: %d %+v", c, ed)
	}
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", dal.ID), u, M{"oil_level": "loads"}, nil); c != 400 {
		t.Errorf("bad oil: %d", c)
	}
	// stale client edit -> 409
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", dal.ID), u, M{"qty": 2, "if_unmodified_since": dal.UpdatedAt.Add(-time.Hour)}, nil); c != 409 {
		t.Errorf("stale edit: %d", c)
	}
	// other users can't see or edit
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", dal.ID), "intruder", M{"qty": 9}, nil); c != 404 {
		t.Errorf("cross-user edit: %d", c)
	}

	// steps: separate, not added to food budget by default
	if c := call(t, srv, "POST", "/v1/activity/steps", u, M{"days": []M{{"date": "2026-10-14", "steps": 6000}}}, nil); c != 200 {
		t.Errorf("steps: %d", c)
	}
	call(t, srv, "POST", "/v1/activity/steps", u, M{"days": []M{{"date": "2026-10-14", "steps": 8000}}}, nil) // re-sync replaces
	if c := call(t, srv, "POST", "/v1/activity/steps", u, M{"days": []M{{"date": "2026-12-01", "steps": 10}}}, nil); c != 400 {
		t.Errorf("future steps: %d", c)
	}
	var sum struct {
		KcalIn  float64 `json:"kcal_in"`
		KcalOut float64 `json:"kcal_out"`
		Steps   int
	}
	call(t, srv, "GET", "/v1/summary?date=2026-10-14", u, nil, &sum)
	call(t, srv, "GET", "/v1/entries?date=2026-10-14", u, nil, &list)
	if sum.Steps != 8000 || sum.KcalOut != 320 || sum.KcalIn != list.Total.Kcal {
		t.Errorf("summary %+v vs entries total %v", sum, list.Total.Kcal)
	}

	var co struct {
		Remaining struct {
			KcalLeft float64 `json:"kcal_left"`
			Steps    bool    `json:"steps_in_budget"`
		}
		Options []struct {
			KcalHigh float64 `json:"kcal_high"`
			Items    []M
		}
	}
	call(t, srv, "GET", "/v1/coach/suggestions", u, nil, &co)
	if co.Remaining.KcalLeft != 2210-sum.KcalIn || len(co.Options) != 3 {
		t.Errorf("coach: %+v", co)
	}
	for _, o := range co.Options {
		if o.KcalHigh > co.Remaining.KcalLeft {
			t.Errorf("coach pushes past target: %+v", o)
		}
		for _, it := range o.Items {
			if strings.Contains(fmt.Sprint(it["dish_id"]), "chicken") || strings.Contains(fmt.Sprint(it["dish_id"]), "egg") {
				t.Errorf("veg user got %v", it)
			}
		}
	}
	// opting in adds steps calories to the budget
	call(t, srv, "PATCH", "/v1/me", u, M{"steps_in_budget": true}, nil)
	call(t, srv, "GET", "/v1/coach/suggestions", u, nil, &co)
	if co.Remaining.KcalLeft != 2210-sum.KcalIn+320 {
		t.Errorf("steps in budget: %+v", co.Remaining)
	}

	// streak: logged 13th and 14th
	var st struct{ Current, Best int }
	call(t, srv, "GET", "/v1/streak", u, nil, &st)
	if st.Current != 2 {
		t.Errorf("streak: %+v", st)
	}

	// soft delete: hidden from list, visible to sync, summary rebuilt
	if c := call(t, srv, "DELETE", fmt.Sprintf("/v1/entries/%d", roti.ID), u, nil, nil); c != 204 {
		t.Errorf("delete: %d", c)
	}
	call(t, srv, "GET", "/v1/entries?date=2026-10-14", u, nil, &list)
	if len(list.Entries) != 1 {
		t.Errorf("after delete: %+v", list)
	}
	var sy struct{ Entries []entry }
	call(t, srv, "GET", "/v1/sync/entries", u, nil, &sy)
	deleted := 0
	for _, e := range sy.Entries {
		if e.DeletedAt != nil {
			deleted++
		}
	}
	if len(sy.Entries) != 3 || deleted != 1 {
		t.Errorf("sync: %+v", sy)
	}
	call(t, srv, "GET", "/v1/summary?date=2026-10-14", u, nil, &sum)
	if sum.KcalIn != list.Total.Kcal {
		t.Errorf("summary after delete %v vs %v", sum.KcalIn, list.Total.Kcal)
	}

	// account deletion removes everything
	if c := call(t, srv, "DELETE", "/v1/me", u, nil, nil); c != 204 {
		t.Errorf("delete me: %d", c)
	}
	call(t, srv, "GET", "/v1/entries?date=2026-10-14", u, nil, &list) // re-creates an empty user
	if len(list.Entries) != 0 {
		t.Errorf("data survived account deletion")
	}
}

func TestSaveRules(t *testing.T) {
	srv, _ := setup(t, nil)
	u := "saver"
	cases := []struct {
		name string
		item M
		want int
	}{
		{"no source", M{"dish_id": "roti", "qty": 2}, 400},
		{"table ok", M{"dish_id": "roti", "qty": 2, "source": "table"}, 201},
		{"table but implausible, unconfirmed", M{"dish_id": "momos", "qty": 6, "unit": "plate", "source": "table"}, 400},
		{"table implausible, confirmed", M{"dish_id": "momos", "qty": 6, "unit": "plate", "source": "table", "confirmed": true}, 201},
		{"did_you_mean unconfirmed", M{"dish_id": "roti", "source": "did_you_mean"}, 400},
		{"did_you_mean confirmed", M{"dish_id": "roti", "source": "did_you_mean", "confirmed": true}, 201},
		{"generic row unconfirmed", M{"dish_id": "generic_paneer_dish", "source": "generic"}, 400},
		{"generic row confirmed", M{"dish_id": "generic_paneer_dish", "source": "generic", "confirmed": true}, 201},
		{"generic row sent as table", M{"dish_id": "generic_paneer_dish", "source": "table"}, 400},
		{"placeholder unconfirmed", M{"custom_name": "quinoa", "kcal": 250, "source": "generic"}, 400},
		{"ai unconfirmed", M{"custom_name": "quinoa", "kcal": 250, "source": "ai_estimate"}, 400},
		{"ai confirmed", M{"custom_name": "quinoa", "kcal": 250, "protein_g": 8, "source": "ai_estimate", "confirmed": true}, 201},
		{"ai 0 kcal", M{"custom_name": "quinoa", "kcal": 0, "source": "ai_estimate", "confirmed": true}, 400},
		{"generic 0 kcal", M{"custom_name": "x", "kcal": 0, "source": "generic", "confirmed": true}, 400},
		{"custom typed 0 kcal", M{"custom_name": "black tea", "kcal": 0, "source": "custom"}, 201},
		{"table water 0 kcal", M{"dish_id": "water", "qty": 2, "source": "table"}, 201},
		{"bad source", M{"dish_id": "roti", "source": "magic"}, 400},
	}
	for _, c := range cases {
		if got := call(t, srv, "POST", "/v1/entries", u, M{"items": []M{c.item}}, nil); got != c.want {
			t.Errorf("%s: got %d want %d", c.name, got, c.want)
		}
	}
	// text-only save keeps only confident table matches
	var cr struct {
		Entries           []entry
		NeedsConfirmation []M `json:"needs_confirmation"`
		Unmatched         []string
	}
	call(t, srv, "POST", "/v1/entries", u, M{"text": "2 roti, paneer lababdar, quinoa"}, &cr)
	if len(cr.Entries) != 0 || len(cr.NeedsConfirmation) != 2 || len(cr.Unmatched) != 1 {
		t.Errorf("text save with leftovers must save nothing: %+v", cr)
	}
	call(t, srv, "POST", "/v1/entries", u, M{"text": "2 roti dal"}, &cr)
	if len(cr.Entries) != 2 {
		t.Errorf("clean text save: %+v", cr)
	}
	for _, e := range cr.Entries {
		if e.KcalBest <= 0 {
			t.Errorf("0 kcal saved: %+v", e)
		}
	}
}

func TestClientIDVersionAndNumbers(t *testing.T) {
	srv, _ := setup(t, nil)
	u := "app"
	// table: 2 roti = 220 kcal, 7 g protein (version 1)
	good := M{"dish_id": "roti", "qty": 2, "unit": "count", "source": "table", "client_id": "c-1", "dish_table_version": 1,
		"kcal": 221, "kcal_low": 165, "kcal_high": 275, "protein_g": 7, "protein_low": 5.2, "protein_high": 8.8, "carbs_g": 40, "fat_g": 3}
	var cr struct {
		Entries    []entry
		Duplicates []string
	}
	if c := call(t, srv, "POST", "/v1/entries", u, M{"items": []M{good}}, &cr); c != 201 {
		t.Fatalf("create: %d", c)
	}
	first := cr.Entries[0]
	if first.KcalBest != 221 {
		t.Errorf("client's confirmed numbers not stored: %+v", first)
	}
	// repeat client_id: same entry back, nothing new
	if c := call(t, srv, "POST", "/v1/entries", u, M{"items": []M{good}}, &cr); c != 200 || cr.Entries[0].ID != first.ID || len(cr.Duplicates) != 1 {
		t.Errorf("idempotency: %d %+v", c, cr)
	}
	var list struct{ Entries []M }
	call(t, srv, "GET", "/v1/entries", u, nil, &list)
	if len(list.Entries) != 1 || list.Entries[0]["carbs_g"].(float64) != 40 || list.Entries[0]["client_id"] != "c-1" || list.Entries[0]["dish_table_version"].(float64) != 1 {
		t.Errorf("stored fields: %+v", list.Entries)
	}
	mod := func(k string, v any) M {
		m := M{}
		for a, b := range good {
			m[a] = b
		}
		m["client_id"] = "c-" + k
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
		return m
	}
	for name, c := range map[string]struct {
		item M
		want int
	}{
		"kcal off":            {mod("kcal", 300.0), 422},
		"protein off":         {mod("protein_g", 12.0), 422},
		"old table version":   {mod("dish_table_version", 0), 409},
		"numbers, no version": {mod("dish_table_version", nil), 400},
		"range excludes best": {mod("kcal_high", 200.0), 422},
	} {
		if got := call(t, srv, "POST", "/v1/entries", u, M{"items": []M{c.item}}, nil); got != c.want {
			t.Errorf("%s: got %d want %d", name, got, c.want)
		}
	}
	// delete by client_id (the app's id)
	if c := call(t, srv, "DELETE", "/v1/entries/c-1", u, nil, nil); c != 204 {
		t.Errorf("delete by client_id: %d", c)
	}
}
