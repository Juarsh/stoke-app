package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/akarsh/calorie-tracker/internal/dishes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/auth"
	"github.com/akarsh/calorie-tracker/internal/db"
	"github.com/akarsh/calorie-tracker/internal/httpx"
)

// fakeVerifier stands in for Google: token "good-<sub>" is valid.
type fakeVerifier struct{}

func (fakeVerifier) Verify(_ context.Context, tok string) (auth.Identity, error) {
	if s, ok := strings.CutPrefix(tok, "good-"); ok {
		return auth.Identity{Sub: s, Email: s + "@example.com"}, nil
	}
	return auth.Identity{}, auth.ErrInvalid
}

// fakeAI just selects AI_MODE=stub in setup.
type fakeAI struct{ perMinute int }

var errSkip = errors.New("skip")

func setup(t *testing.T, ai *fakeAI) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	return setupCfg(t, ai, nil)
}

// setupWith: a server whose Config the test adjusts (e.g. its own Fallback).
func setupWith(t *testing.T, mod func(*Config)) *httptest.Server {
	t.Helper()
	srv, _ := setupCfg(t, nil, mod)
	return srv
}

func setupCfg(t *testing.T, ai *fakeAI, mod func(*Config)) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	if testDBURL == "" {
		t.Skip("no throwaway test database (see TestMain)")
	}
	url := testDBURL
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
		cfg.AIMode = "stub"
		cfg.AIPerMinute = ai.perMinute
		if cfg.AIPerMinute == 0 {
			cfg.AIPerMinute = -1 // most tests don't exercise the per-minute limiter
		}
	}
	if mod != nil {
		mod(&cfg)
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
	// "2 roti dal sabzi" has no separators (rule 2: confirm, never two
	// confident items); a separated table match stays claimed - see
	// TestFallbackKeepsClaimedItems
	if r.Items[0].NeedsConfirmation || !r.Items[2].NeedsConfirmation { // roti+dal listed pair; dal+sabzi not
		t.Errorf("rule 2: %+v", r.Items)
	}
	var r2 struct {
		Items []struct {
			Source            string
			NeedsConfirmation bool `json:"needs_confirmation"`
		}
		NeedsConfirmation bool `json:"needs_confirmation"`
	}
	call(t, srv, "POST", "/v1/parse", "a", M{"text": "2 roti, 1 katori dal"}, &r2)
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

type parseOut struct {
	NeedsConfirmation bool   `json:"needs_confirmation"`
	FallbackReason    string `json:"fallback_reason"`
	AIResetsAt        string `json:"ai_resets_at"`
	UserDailyLimit    int64  `json:"user_daily_limit"`
	Items             []struct {
		Name              string
		DishID            string `json:"dish_id"`
		SpanStart         int    `json:"span_start"`
		SpanEnd           int    `json:"span_end"`
		Flags             []string
		AIEstimate        bool `json:"ai_estimate"`
		Source            string
		Learned           bool
		NeedsConfirmation bool `json:"needs_confirmation"`
		OneTapOK          bool `json:"one_tap_ok"`
		Quantity          float64
		Kcal              struct{ Best float64 }
	}
	UsedAI      bool `json:"used_ai"`
	Fallback    string
	CustomItems []M `json:"custom_items"`
	Message     string
	Status      string
	JobID       string `json:"job_id"`
	Answer      string
	AIState     string `json:"ai_state"`
	FailedSpans []M    `json:"failed_spans"`
	Requeues    int    `json:"requeues"`
	BusyReason  string `json:"busy_reason"`
	NextAttempt string `json:"next_attempt_at"`
}

func aiCalls(t *testing.T, srv *httptest.Server) int {
	var c struct{ Calls int }
	call(t, srv, "GET", "/test/ai/calls", "", nil, &c)
	return c.Calls
}

func TestRememberedFoods(t *testing.T) {
	srv, _ := setup(t, nil)
	var r parseOut
	call(t, srv, "POST", "/v1/parse", "rm", M{"text": "paneer lababdar"}, &r)
	if !r.Items[0].NeedsConfirmation {
		t.Fatalf("first parse should need confirmation: %+v", r)
	}
	var cr struct{ Entries []entry }
	if c := call(t, srv, "POST", "/v1/entries", "rm", M{"items": []M{{"dish_id": "paneer_butter_masala", "qty": 1, "unit": "katori",
		"source": "did_you_mean", "confirmed": true, "span": "paneer lababdar"}}}, &cr); c != 201 {
		t.Fatalf("confirm save: %d", c)
	}
	r = parseOut{}
	call(t, srv, "POST", "/v1/parse", "rm", M{"text": "paneer lababdar"}, &r)
	if len(r.Items) != 1 || r.Items[0].Source != "table" || !r.Items[0].Learned || r.Items[0].NeedsConfirmation {
		t.Errorf("learned reading not applied: %+v", r)
	}
	// private to that user
	r = parseOut{}
	call(t, srv, "POST", "/v1/parse", "someone", M{"text": "paneer lababdar"}, &r)
	if r.Items[0].Learned {
		t.Errorf("reading leaked to another user")
	}
	var lst struct {
		Remembered []struct {
			ID   int64
			Span string
		}
	}
	call(t, srv, "GET", "/v1/remembered", "rm", nil, &lst)
	if len(lst.Remembered) != 1 || lst.Remembered[0].Span != "paneer lababdar" {
		t.Fatalf("list: %+v", lst)
	}
	if c := call(t, srv, "DELETE", fmt.Sprintf("/v1/remembered/%d", lst.Remembered[0].ID), "someone", nil, nil); c != 404 {
		t.Errorf("other user reset: %d", c)
	}
	if c := call(t, srv, "DELETE", fmt.Sprintf("/v1/remembered/%d", lst.Remembered[0].ID), "rm", nil, nil); c != 204 {
		t.Errorf("reset one: %d", c)
	}
	r = parseOut{}
	call(t, srv, "POST", "/v1/parse", "rm", M{"text": "paneer lababdar"}, &r)
	if r.Items[0].Learned {
		t.Errorf("reset reading still applied")
	}
	if c := call(t, srv, "DELETE", "/v1/remembered", "rm", nil, nil); c != 200 {
		t.Errorf("reset all: %d", c)
	}
	// a PATCH correction is remembered for the entry's span
	var cr2 struct{ Entries []entry }
	call(t, srv, "POST", "/v1/entries", "rm", M{"items": []M{{"dish_id": "paneer_butter_masala", "qty": 1, "unit": "katori",
		"source": "did_you_mean", "confirmed": true, "span": "paneer lababdar"}}}, &cr2)
	call(t, srv, "DELETE", "/v1/remembered", "rm", nil, nil)
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", cr2.Entries[0].ID), "rm", M{"dish_id": "kadai_paneer"}, nil); c != 200 {
		t.Fatalf("patch: %d", c)
	}
	r = parseOut{}
	call(t, srv, "POST", "/v1/parse", "rm", M{"text": "paneer lababdar"}, &r)
	if !r.Items[0].Learned || r.Items[0].Name != "Kadai paneer" && r.Items[0].Name != "kadai_paneer" {
		t.Errorf("patch correction not remembered: %+v", r.Items[0])
	}
}

func TestHooks404OutsideStub(t *testing.T) {
	srv, _ := setup(t, nil)
	for _, rt := range [][2]string{{"GET", "/test/ai/calls"}, {"POST", "/test/ai/calls/reset"}, {"POST", "/test/ai/next-answer"}, {"POST", "/test/ai/daily-cap"}, {"POST", "/test/ai/fail"}} {
		if c := call(t, srv, rt[0], rt[1], "", M{}, nil); c != 404 {
			t.Errorf("%s %s outside stub: %d", rt[0], rt[1], c)
		}
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
	if c := call(t, srv, "PUT", "/v1/profile", u, M{"sex": "male", "age": 30, "height_cm": 175, "weight_kg": 80, "activity_level": "moderate", "goal": "fat_loss", "maintenance_kcal": 2710, "target_kcal": 2210}, &prof); c != 200 || prof.Target.Kcal != 2210 {
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
	if c := call(t, srv, "POST", "/v1/entries", u, M{"text": "2 roti, 1 katori dal"}, &cr); c != 201 {
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
	// stale client edit (a row version the server has moved past) -> 409; the phone clock
	// (if_unmodified_since) is never a precondition (see TestEntryVersionConflict)
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", dal.ID), u, M{"qty": 2, "version": 0, "if_unmodified_since": dal.UpdatedAt.Add(-time.Hour)}, nil); c != 409 {
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
	call(t, srv, "POST", "/v1/entries", u, M{"text": "2 roti, 1 katori dal"}, &cr)
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
	good := M{"dish_id": "roti", "qty": 2, "unit": "count", "source": "table", "client_id": "c-1", "dish_table_version": 3,
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
	if len(list.Entries) != 1 || list.Entries[0]["carbs_g"].(float64) != 40 || list.Entries[0]["client_id"] != "c-1" || list.Entries[0]["dish_table_version"].(float64) != 3 {
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
		"kcal off":            {mod("kcal", 300.0), 201},
		"protein off":         {mod("protein_g", 12.0), 201},
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

// An app offline on table v1 syncs after the server moved to v2 (roti's
// numbers changed). v1 entries validate against v1 and keep version 1.
func TestOfflineSyncAcrossTableUpdate(t *testing.T) {
	srv1, pool := setup(t, nil)
	v1 := dishes.MustLoad()
	ver1 := dishes.TableVersion(v1)
	roti1, _ := (func() (dishes.Dish, bool) {
		for _, d := range v1 {
			if d.ID == "roti" {
				return d, true
			}
		}
		return dishes.Dish{}, false
	})()
	// publish v2: roti gets heavier, version bumped
	v2 := make([]dishes.Dish, len(v1))
	copy(v2, v1)
	for i := range v2 {
		if v2[i].ID == "roti" {
			v2[i].Kcal, v2[i].KcalLow, v2[i].KcalHigh = roti1.Kcal+40, roti1.KcalLow+40, roti1.KcalHigh+40
			v2[i].Version = ver1 + 1
		}
	}
	h2, err := New(Config{DB: pool, Verifier: fakeVerifier{}, Dishes: v2})
	if err != nil {
		t.Fatal(err)
	}
	srv2 := httptest.NewServer(h2)
	defer srv2.Close()
	_ = srv1
	// republishing changed contents under an old number is refused
	bad := make([]dishes.Dish, len(v1))
	copy(bad, v1)
	bad[0].Kcal += 1
	if _, err := New(Config{DB: pool, Verifier: fakeVerifier{}, Dishes: bad}); err == nil {
		t.Error("changed table under the same version was accepted")
	}
	item := func(cid string, ver int, kcal float64) M {
		return M{"items": []M{{"dish_id": "roti", "qty": 1, "source": "table", "client_id": cid,
			"dish_table_version": ver, "kcal": kcal, "protein_g": roti1.ProteinG}}}
	}
	type out struct {
		Entries []struct {
			KcalBest float64 `json:"kcal_best"`
			TableVer *int    `json:"dish_table_version"`
		}
		Error      string
		KeepEntry  bool `json:"keep_entry"`
		Retry      bool
		ServerVers int `json:"server_version"`
	}
	// offline v1 entry, synced after the update: accepted with v1 numbers
	var o out
	if c := call(t, srv2, "POST", "/v1/entries", "off", item("e1", ver1, roti1.Kcal), &o); c != 201 {
		t.Fatalf("v1 entry after update: %d %+v", c, o)
	}
	if o.Entries[0].KcalBest != roti1.Kcal || o.Entries[0].TableVer == nil || *o.Entries[0].TableVer != ver1 {
		t.Errorf("v1 entry stored as %+v", o.Entries[0])
	}
	// v2 numbers under v2: fine
	o = out{}
	if c := call(t, srv2, "POST", "/v1/entries", "off", item("e2", ver1+1, roti1.Kcal+40), &o); c != 201 || *o.Entries[0].TableVer != ver1+1 {
		t.Errorf("v2 entry: %d %+v", c, o)
	}
	// v1 numbers claimed as v2: mismatch
	if c := call(t, srv2, "POST", "/v1/entries", "off", item("e3", ver1+1, roti1.Kcal), nil); c != 201 {
		t.Errorf("v1 numbers labelled v2: %d", c)
	}
	// a version the server has never seen: 409, keep and retry
	o = out{}
	if c := call(t, srv2, "POST", "/v1/entries", "off", item("e4", ver1+7, 100), &o); c != 409 || !o.KeepEntry || !o.Retry || o.ServerVers != ver1+1 {
		t.Errorf("unknown version: %d %+v", c, o)
	}
	// a fresh server process (v2) still knows v1 from the stored snapshot
	h3, _ := New(Config{DB: pool, Verifier: fakeVerifier{}, Dishes: v2})
	srv3 := httptest.NewServer(h3)
	defer srv3.Close()
	if c := call(t, srv3, "POST", "/v1/entries", "off", item("e5", ver1, roti1.Kcal), nil); c != 201 {
		t.Errorf("v1 after restart: %d", c)
	}
}

// A needs_review entry keeps the streak alive but adds nothing to totals
// until it's confirmed.
func TestNeedsReviewStreakNotCalories(t *testing.T) {
	srv, _ := setup(t, nil)
	fixed := time.Date(2026, 10, 14, 13, 0, 0, 0, httpx.IST)
	httpx.Now = func() time.Time { return fixed }
	t.Cleanup(func() { httpx.Now = time.Now })
	u := "rev"
	// 13th: confirmed; 14th: only a pending entry (e.g. offline AI not done)
	if c := call(t, srv, "POST", "/v1/entries", u, M{"local_date": "2026-10-13", "items": []M{{"dish_id": "roti", "qty": 2, "source": "table"}}}, nil); c != 201 {
		t.Fatalf("day 1: %d", c)
	}
	var cr struct{ Entries []entry }
	if c := call(t, srv, "POST", "/v1/entries", u, M{"local_date": "2026-10-14", "items": []M{
		{"custom_name": "office canteen thali", "source": "ai_estimate", "state": "needs_review", "client_id": "p1"},
		{"dish_id": "dal", "source": "did_you_mean", "state": "needs_review"}}}, &cr); c != 201 {
		t.Fatalf("pending save: %d", c)
	}
	var sum struct {
		KcalIn float64 `json:"kcal_in"`
		Logged bool
	}
	call(t, srv, "GET", "/v1/summary?date=2026-10-14", u, nil, &sum)
	if sum.KcalIn != 0 || !sum.Logged {
		t.Errorf("pending day summary: %+v", sum)
	}
	var list struct {
		Entries []struct{ State string }
		Total   struct {
			Kcal        float64
			NeedsReview int `json:"needs_review"`
		}
	}
	call(t, srv, "GET", "/v1/entries?date=2026-10-14", u, nil, &list)
	if list.Total.Kcal != 0 || list.Total.NeedsReview != 2 || list.Entries[0].State != "needs_review" {
		t.Errorf("pending totals: %+v", list)
	}
	var st struct{ Current int }
	call(t, srv, "GET", "/v1/streak", u, nil, &st)
	if st.Current != 2 {
		t.Errorf("streak with a pending-only day: %+v", st)
	}
	// confirming without numbers fails for a custom item; with numbers it counts
	if c := call(t, srv, "PATCH", "/v1/entries/p1", u, M{"state": "confirmed"}, nil); c != 400 {
		t.Errorf("confirm without kcal: %d", c)
	}
	if c := call(t, srv, "PATCH", "/v1/entries/p1", u, M{"state": "confirmed", "kcal": 650, "protein_g": 20}, nil); c != 200 {
		t.Fatalf("confirm: %d", c)
	}
	call(t, srv, "GET", "/v1/summary?date=2026-10-14", u, nil, &sum)
	if sum.KcalIn != 650 {
		t.Errorf("after confirm: %+v", sum)
	}
	if c := call(t, srv, "POST", "/v1/entries", u, M{"items": []M{{"custom_name": "x", "state": "maybe"}}}, nil); c != 400 {
		t.Errorf("bad state: %d", c)
	}
}

// parseAI posts a meal and, if it's queued (202), polls the job until done.
func parseAI(t *testing.T, srv *httptest.Server, user, text string) (int, parseOut) {
	t.Helper()
	var r parseOut
	c := call(t, srv, "POST", "/v1/parse", user, M{"text": text}, &r)
	if c != 202 {
		return c, r
	}
	if r.Status != "pending" || r.JobID == "" {
		t.Fatalf("202 without a job: %+v", r)
	}
	for i := 0; i < 200; i++ {
		var j parseOut
		jc := call(t, srv, "GET", "/v1/parse/jobs/"+r.JobID, user, nil, &j)
		if jc == 200 {
			return 202, j
		}
		if jc != 202 {
			t.Fatalf("job poll: %d", jc)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("job never finished")
	return 0, r
}

func TestStrictTableOrWholeMealAI(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	// clean: every span exact with a stated count/unit -> table, 200, no AI
	c, r := parseAI(t, srv, "s1", "2 roti, 1 katori dal")
	if c != 200 || r.Answer != "table" || r.Items[0].Source != "table" || r.Items[0].NeedsConfirmation || aiCalls(t, srv) != 0 {
		t.Errorf("clean meal: %d %+v", c, r)
	}
	// anything else -> the WHOLE meal in one queued AI call
	// a typo covers its own words: did_you_mean to confirm, never an AI call
	if c, r := parseAI(t, srv, "s1", "2 chapatii"); c != 200 || r.Items[0].Source != "did_you_mean" || !r.Items[0].NeedsConfirmation || aiCalls(t, srv) != 0 {
		t.Errorf("typo meal: %d %+v", c, r)
	}
	for i, text := range []string{"paneer lababdar", "2 roti quinoa"} {
		c, r = parseAI(t, srv, "s1", text)
		if c != 202 || r.Answer != "ai" || len(r.Items) == 0 || aiCalls(t, srv) != i+1 {
			t.Fatalf("%q: %d calls %d %+v", text, c, aiCalls(t, srv), r)
		}
		for _, it := range r.Items {
			if it.Source != "ai_estimate" || !it.NeedsConfirmation || !it.AIEstimate {
				t.Errorf("%q: AI item not flagged: %+v", text, it)
			}
		}
	}
	// combo readings cover all their words: confirm, no AI call
	for _, text := range []string{"rajma with rice, 1 bowl", "1 katori chole bhature"} {
		before := aiCalls(t, srv)
		if c, r := parseAI(t, srv, "s1", text); c != 200 || len(r.Items) == 0 || !r.Items[0].NeedsConfirmation || aiCalls(t, srv) != before {
			t.Errorf("%q: %d %+v", text, c, r)
		}
	}
	// same meal again (another user, different spacing/case): cache, no call, still ai_estimate
	calls := aiCalls(t, srv)
	c, r = parseAI(t, srv, "s2", "Paneer  Lababdar!")
	if c != 200 || r.Fallback != "cache" || r.Items[0].Source != "ai_estimate" || !r.Items[0].NeedsConfirmation || aiCalls(t, srv) != calls {
		t.Errorf("cache: %d %+v", c, r)
	}
	// use_ai=false: rule-based guess, everything to confirm
	var g parseOut
	call(t, srv, "POST", "/v1/parse", "s3", M{"text": "paneer lababdar", "use_ai": false}, &g)
	if g.Answer != "generic" || !g.Items[0].NeedsConfirmation {
		t.Errorf("no-AI guess: %+v", g)
	}
	// jobs are private
	var p parseOut
	call(t, srv, "POST", "/v1/parse", "s4", M{"text": "mystery bowl one"}, &p)
	if c := call(t, srv, "GET", "/v1/parse/jobs/"+p.JobID, "s5", nil, nil); c != 404 {
		t.Errorf("other user's job: %d", c)
	}
}

func TestAICapsAndBadAnswers(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	for i := 0; i < 3; i++ { // AI_USER_DAILY_CAP default 3
		if c, _ := parseAI(t, srv, "cap", fmt.Sprintf("zorb meal %d", i)); c != 202 {
			t.Fatalf("call %d: %d", i, c)
		}
	}
	c, r := parseAI(t, srv, "cap", "zorb meal last")
	if c != 200 || r.Fallback != "cap_reached" || r.FallbackReason != "user_limit" || r.UserDailyLimit != 3 || r.AIResetsAt == "" ||
		r.Answer != "none" || r.AIState != "failed" || len(r.Items) != 0 || len(r.FailedSpans) != 1 || r.Message == "" || aiCalls(t, srv) != 3 {
		t.Errorf("per-user cap: %d %+v", c, r)
	}
	// project-wide cap
	call(t, srv, "POST", "/test/ai/daily-cap", "", M{"cap": 4}, nil)
	parseAI(t, srv, "other", "glarp one")
	c, r = parseAI(t, srv, "other", "glarp two")
	if r.Fallback != "global_cap_reached" || r.FallbackReason != "daily_limit" || r.AIResetsAt == "" || r.UserDailyLimit != 0 || aiCalls(t, srv) != 4 {
		t.Errorf("global cap: %d %+v", c, r)
	}
	call(t, srv, "POST", "/test/ai/daily-cap", "", M{"cap": 0}, nil)
	// implausible answers: failed (error), no kcal, never cached
	for i, k := range []float64{0, 3200} {
		call(t, srv, "POST", "/test/ai/next-answer", "", M{"items": []M{{"name": "x", "quantity": 1, "unit": "count", "kcal": M{"low": k, "best": k, "high": k}}}}, nil)
		text := []string{"weird thing a", "weird thing b"}[i]
		_, r = parseAI(t, srv, fmt.Sprintf("bad%d", i), text) // users differ: 3 AI meals/user/day
		if r.AIState != "failed" || r.FallbackReason != "error" || r.Fallback != "error" || len(r.Items) != 0 {
			t.Errorf("implausible %v shown: %+v", k, r)
		}
		before := aiCalls(t, srv)
		parseAI(t, srv, fmt.Sprintf("bad%db", i), text)
		if aiCalls(t, srv) != before+1 {
			t.Errorf("implausible %v was cached", k)
		}
	}
	// user corrections never reach the shared cache
	parseAI(t, srv, "u1", "quinoa bowl")
	call(t, srv, "POST", "/v1/entries", "u1", M{"items": []M{{"custom_name": "my quinoa", "qty": 1, "kcal": 999, "protein_g": 30,
		"source": "ai_estimate", "confirmed": true, "span": "quinoa bowl"}}}, nil)
	_, r = parseAI(t, srv, "u3", "quinoa bowl")
	if r.Items[0].Kcal.Best == 999 || r.Items[0].Source != "ai_estimate" {
		t.Errorf("correction leaked into the shared cache: %+v", r.Items[0])
	}
	// ...but the user who confirmed it gets it back as a learned table answer
	_, r = parseAI(t, srv, "u1", "quinoa bowl")
	if r.Answer != "table" || !r.Items[0].Learned || r.Items[0].Kcal.Best != 999 {
		t.Errorf("remembered food: %+v", r)
	}
}

func TestQueueSpacesCalls(t *testing.T) {
	srv, _ := setup(t, &fakeAI{perMinute: 600}) // 100ms apart
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	start := time.Now()
	var ids []string
	for i := 0; i < 3; i++ {
		var r parseOut
		if c := call(t, srv, "POST", "/v1/parse", "q", M{"text": fmt.Sprintf("queue meal %d", i)}, &r); c != 202 {
			t.Fatalf("enqueue: %d", c)
		}
		ids = append(ids, r.JobID)
	}
	for _, id := range ids {
		for {
			if c := call(t, srv, "GET", "/v1/parse/jobs/"+id, "q", nil, nil); c == 200 {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	if d := time.Since(start); d < 190*time.Millisecond {
		t.Errorf("3 calls drained in %v; want spacing of 100ms", d)
	}
}

func TestProteinAlias(t *testing.T) {
	srv, _ := setup(t, nil)
	var cr struct {
		Entries []struct {
			ProteinBest float64 `json:"protein_best"`
		}
	}
	if c := call(t, srv, "POST", "/v1/entries", "pa", M{"items": []M{{"custom_name": "shake", "kcal": 200, "protein": 25, "source": "custom"}}}, &cr); c != 201 || cr.Entries[0].ProteinBest != 25 {
		t.Errorf("protein alias: %d %+v", c, cr)
	}
}

const testAdmin = "test-admin-token-0123456789abcdef"

func admin(t *testing.T, srv *httptest.Server, method, path, token string, body any, out any) int {
	t.Helper()
	var rd io.Reader = http.NoBody
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		if s, ok := out.(*string); ok {
			b, _ := io.ReadAll(resp.Body)
			*s = string(b)
		} else {
			_ = json.NewDecoder(resp.Body).Decode(out)
		}
	}
	return resp.StatusCode
}

func TestAdminExportImport(t *testing.T) {
	_, pool := setup(t, nil)
	h, err := New(Config{DB: pool, Verifier: fakeVerifier{}, AIMode: "stub", AIPerMinute: -1, AdminToken: testAdmin})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	// no / wrong token
	if c := admin(t, srv, "GET", "/admin/ai-cache/top", "", nil, nil); c != 401 {
		t.Errorf("no token: %d", c)
	}
	if c := admin(t, srv, "GET", "/admin/ai-cache/top", "wrong", nil, nil); c != 401 {
		t.Errorf("wrong token: %d", c)
	}
	// make cache entries: one meal twice (1 call + 1 hit), another once
	parseAI(t, srv, "a1", "kuttu cheela")
	parseAI(t, srv, "a2", "kuttu cheela")
	parseAI(t, srv, "a3", "glarp bites")
	var top struct {
		Top []struct {
			Text  string
			Hits  int
			Items []M
		}
	}
	if c := admin(t, srv, "GET", "/admin/ai-cache/top?days=7", testAdmin, nil, &top); c != 200 || len(top.Top) != 2 || top.Top[0].Text != "kuttu cheela" || top.Top[0].Hits != 1 {
		t.Fatalf("export json: %d %+v", c, top)
	}
	var csvOut string
	admin(t, srv, "GET", "/admin/ai-cache/top?format=csv", testAdmin, nil, &csvOut)
	if !strings.HasPrefix(csvOut, "text,hits,") || !strings.Contains(csvOut, "kuttu cheela,1,") {
		t.Errorf("export csv: %q", csvOut)
	}
	// import: checked row with a source note -> new table version
	var before []M
	call(t, srv, "GET", "/v1/dishes", "", nil, &before)
	row := M{"id": "kuttu_cheela", "name": "kuttu cheela", "aliases": []string{"kuttu chilla"}, "unit": "katori", "portion_grams": 150,
		"kcal": 260, "kcal_low": 220, "kcal_high": 310, "protein_g": 3, "protein_low": 2, "protein_high": 4, "carbs_g": 45, "fat_g": 8,
		"diet": "veg", "category": "breakfast", "source": "usda_fdc", "source_note": "Checked against IFCT 2017 buckwheat flour recipe calc",
		"from_cache": []string{"Kuttu Cheela"}}
	noNote := M{}
	for k, v := range row {
		noNote[k] = v
	}
	noNote["source_note"] = ""
	if c := admin(t, srv, "POST", "/admin/dishes/import", testAdmin, M{"items": []M{noNote}}, nil); c != 400 {
		t.Errorf("import without source note: %d", c)
	}
	if c := admin(t, srv, "POST", "/admin/dishes/import", "", M{"items": []M{row}}, nil); c != 401 {
		t.Errorf("import without token: %d", c)
	}
	var imp struct {
		Version int `json:"dish_table_version"`
		Added   []string
		Dropped int `json:"dropped_cache"`
	}
	v1 := dishes.TableVersion(dishes.MustLoad())
	if c := admin(t, srv, "POST", "/admin/dishes/import", testAdmin, M{"items": []M{row}, "note": "week 41 review"}, &imp); c != 201 || imp.Version != v1+1 || imp.Dropped != 1 {
		t.Fatalf("import: %d %+v", c, imp)
	}
	var after []M
	call(t, srv, "GET", "/v1/dishes", "", nil, &after)
	if len(after) != len(before)+1 {
		t.Errorf("table not updated: %d -> %d", len(before), len(after))
	}
	// the meal is now a strict table answer (no AI), and old-version entries still validate
	c, r := parseAI(t, srv, "a4", "1 katori kuttu cheela")
	if c != 200 || r.Answer != "table" {
		t.Errorf("imported dish not used: %d %+v", c, r)
	}
	var cr struct{ Entries []entry }
	if c := call(t, srv, "POST", "/v1/entries", "a4", M{"items": []M{{"dish_id": "roti", "qty": 1, "source": "table", "dish_table_version": v1}}}, &cr); c != 201 {
		t.Errorf("old version entry after import: %d", c)
	}
	// a restarted server picks up the imported version from the DB
	h2, err := New(Config{DB: pool, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	srv2 := httptest.NewServer(h2)
	defer srv2.Close()
	var again []M
	call(t, srv2, "GET", "/v1/dishes", "", nil, &again)
	if len(again) != len(after) {
		t.Errorf("restart lost the import: %d vs %d", len(again), len(after))
	}
	// invalid table (alias clash) is refused
	clash := M{}
	for k, v := range row {
		clash[k] = v
	}
	clash["id"], clash["aliases"] = "roti_two", []string{"chapati"}
	if c := admin(t, srv, "POST", "/admin/dishes/import", testAdmin, M{"items": []M{clash}}, nil); c != 422 {
		t.Errorf("alias clash: %d", c)
	}
	// no token configured -> 404
	srv3, _ := setup(t, nil)
	if c := admin(t, srv3, "GET", "/admin/ai-cache/top", testAdmin, nil, nil); c != 404 {
		t.Errorf("admin without ADMIN_TOKEN: %d", c)
	}
}

// A count-less exact match uses the default portion: table answer, no AI,
// no confirmation flag, default_portion=true. Text-only saves still ask.
func TestDefaultPortion(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	var r struct {
		Answer string
		Items  []struct {
			DishID            string `json:"dish_id"`
			Source            string
			NeedsConfirmation bool `json:"needs_confirmation"`
			DefaultPortion    bool `json:"default_portion"`
			Unit              string
		}
	}
	if c := call(t, srv, "POST", "/v1/parse", "dp", M{"text": "2 roti, palak paneer"}, &r); c != 200 || r.Answer != "table" || aiCalls(t, srv) != 0 {
		t.Fatalf("count-less meal: %d %+v calls %d", c, r, aiCalls(t, srv))
	}
	if a, b := r.Items[0], r.Items[1]; a.DefaultPortion || !b.DefaultPortion || b.NeedsConfirmation || b.Source != "table" || b.Unit == "" {
		t.Errorf("items: %+v", r.Items)
	}
	var cr struct {
		Entries           []entry
		NeedsConfirmation []M `json:"needs_confirmation"`
	}
	call(t, srv, "POST", "/v1/entries", "dp", M{"text": "palak paneer"}, &cr)
	if len(cr.Entries) != 0 || len(cr.NeedsConfirmation) != 1 {
		t.Errorf("text-only save of a default portion must ask: %+v", cr)
	}
	cr.Entries, cr.NeedsConfirmation = nil, nil
	call(t, srv, "POST", "/v1/entries", "dp", M{"text": "2 roti"}, &cr)
	if len(cr.Entries) != 1 {
		t.Errorf("stated count text save: %+v", cr)
	}
	// everyday combos: components at default portions, table, no AI
	for text, want := range map[string][]string{"dal chawal": {"dal", "rice"}, "bread butter": {"bread", "butter"},
		"chole bhature": {"chole", "bhatura"}, "1 plate rajma chawal": {"rajma", "rice"}, "kadhi chawal": {"kadhi", "rice"}} {
		r.Items = nil
		if c := call(t, srv, "POST", "/v1/parse", "dp", M{"text": text}, &r); c != 200 || r.Answer != "table" || len(r.Items) != len(want) {
			t.Errorf("%q: %d %+v", text, c, r)
			continue
		}
		for i, it := range r.Items {
			if it.DishID != want[i] || !it.DefaultPortion || it.NeedsConfirmation || it.Source != "table" {
				t.Errorf("%q item %d: %+v", text, i, it)
			}
		}
	}
	if aiCalls(t, srv) != 0 {
		t.Errorf("combos called the AI %d times", aiCalls(t, srv))
	}
	// the normal Add of the parsed item (app confirms) saves it
	if c := call(t, srv, "POST", "/v1/entries", "dp", M{"items": []M{{"dish_id": "palak_paneer", "qty": 1, "source": "table"}}}, nil); c != 201 {
		t.Errorf("add default portion item: %d", c)
	}
}

// AI items keep the user's text; confirming them remembers that text, so the
// same meal next time is a table answer with no AI call. PATCH corrections
// are remembered too, and a reset brings the AI back.
func TestRememberAIMealThenReparse(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	text := "2 roti, zorbo pakora"
	var first struct {
		JobID string `json:"job_id"`
	}
	if c := call(t, srv, "POST", "/v1/parse", "rm2", M{"text": text}, &first); c != 202 {
		t.Fatalf("expected a queued AI job: %d", c)
	}
	type pitem struct {
		Name      string
		DishID    string `json:"dish_id"`
		AIName    string `json:"ai_name"`
		Matched   string `json:"matched_text"`
		Quantity  float64
		Unit      string
		Kcal      struct{ Best float64 }
		Source    string
		SpanStart int `json:"span_start"`
		SpanEnd   int `json:"span_end"`
	}
	var full struct{ Items []pitem }
	for call(t, srv, "GET", "/v1/parse/jobs/"+first.JobID, "rm2", nil, &full) != 200 {
		time.Sleep(5 * time.Millisecond)
	}
	// the table keeps "2 roti" (and pakora); the AI only answers the unknown span
	var aiItem *pitem
	for i, it := range full.Items {
		if it.Source == "ai_estimate" {
			aiItem = &full.Items[i]
		} else if it.Source != "table" {
			t.Errorf("unexpected item: %+v", it)
		}
		if it.SpanStart == 0 && it.SpanEnd == len(text) {
			t.Errorf("whole-text span with table items present: %+v", it)
		}
	}
	if aiItem == nil || full.Items[0].DishID != "roti" || full.Items[0].Matched != "roti" {
		t.Fatalf("items: %+v", full.Items)
	}
	if aiItem.Matched != text[aiItem.SpanStart:aiItem.SpanEnd] || aiItem.AIName == "" || !strings.Contains(aiItem.Matched, "zorbo") {
		t.Errorf("AI item must keep the user's own span: %+v", aiItem)
	}
	var items []M
	for _, it := range full.Items {
		if it.Source == "table" {
			items = append(items, M{"dish_id": it.DishID, "qty": it.Quantity, "unit": it.Unit, "source": "table", "span": it.Matched})
		} else {
			items = append(items, M{"custom_name": it.Name, "qty": it.Quantity, "unit": it.Unit, "kcal": it.Kcal.Best, "protein_g": 1,
				"source": "ai_estimate", "confirmed": true, "span": it.Matched, "parse_job_id": first.JobID, "client_item_id": "ci-1"})
		}
	}
	var cr struct {
		Entries []struct {
			ID         int64
			CustomName string `json:"custom_name"`
		}
	}
	if c := call(t, srv, "POST", "/v1/entries", "rm2", M{"items": items}, &cr); c != 201 {
		t.Fatalf("confirm: %d", c)
	}
	var job struct{ Entries []struct{ ID int64 } }
	call(t, srv, "GET", "/v1/parse/jobs/"+first.JobID, "rm2", nil, &job)
	if len(job.Entries) != 1 {
		t.Errorf("job not tied to its entry: %+v", job)
	}
	before := aiCalls(t, srv)
	c, r := parseAI(t, srv, "rm2", text)
	if c != 200 || r.Answer != "table" || aiCalls(t, srv) != before {
		t.Fatalf("second time should be remembered, no AI: %d %+v", c, r)
	}
	found := false
	for _, it := range r.Items {
		if it.NeedsConfirmation || it.Source != "table" {
			t.Errorf("second-time item needs a decision: %+v", it)
		}
		found = found || it.Learned
	}
	if !found {
		t.Errorf("remembered span not used: %+v", r.Items)
	}
	// PATCH correction of the AI entry is remembered
	var aiEntry int64
	for _, e := range cr.Entries {
		if e.CustomName != "" {
			aiEntry = e.ID
		}
	}
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", aiEntry), "rm2", M{"kcal": 432, "job_id": first.JobID}, nil); c != 200 {
		t.Fatalf("patch: %d", c)
	}
	_, r = parseAI(t, srv, "rm2", text)
	got := false
	for _, it := range r.Items {
		got = got || (it.Learned && it.Kcal.Best == 432)
	}
	if !got || aiCalls(t, srv) != before {
		t.Errorf("PATCH correction not remembered: %+v", r.Items)
	}
	// reset all -> asks again (cache answer, still needs a decision)
	if c := call(t, srv, "DELETE", "/v1/remembered", "rm2", nil, nil); c != 200 {
		t.Fatalf("reset: %d", c)
	}
	_, r = parseAI(t, srv, "rm2", text)
	if r.Answer != "ai" {
		t.Errorf("after reset should be an AI answer again: %+v", r)
	}
}

// AI answers only the unclaimed spans; table items keep theirs; the cache
// key includes the claimed spans.
func TestAISpanContract(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	type it struct {
		DishID    string `json:"dish_id"`
		Source    string
		Matched   string `json:"matched_text"`
		SpanStart int    `json:"span_start"`
		SpanEnd   int    `json:"span_end"`
		NC        bool   `json:"needs_confirmation"`
	}
	get := func(user, text string) (int, []it, string) {
		var r struct {
			JobID    string `json:"job_id"`
			Items    []it
			Fallback string
		}
		c := call(t, srv, "POST", "/v1/parse", user, M{"text": text}, &r)
		if c == 202 {
			for call(t, srv, "GET", "/v1/parse/jobs/"+r.JobID, user, nil, &r) != 200 {
				time.Sleep(5 * time.Millisecond)
			}
		}
		return c, r.Items, r.Fallback
	}
	text := "2 roti, 1 katori dal, kombucha"
	c, items, _ := get("sp1", text)
	if c != 202 || len(items) != 3 {
		t.Fatalf("%d %+v", c, items)
	}
	if items[0].DishID != "roti" || items[0].Source != "table" || items[0].NC || items[1].DishID != "dal" || items[1].Source != "table" {
		t.Errorf("table items must stay confident: %+v", items)
	}
	if a := items[2]; a.Source != "ai_estimate" || !a.NC || a.Matched != "kombucha" || text[a.SpanStart:a.SpanEnd] != "kombucha" {
		t.Errorf("AI item: %+v", a)
	}
	// same text, other user: cache, no call
	n := aiCalls(t, srv)
	if c, items, fb := get("sp2", text); c != 200 || fb != "cache" || len(items) != 3 || aiCalls(t, srv) != n {
		t.Errorf("cache: %d %s %+v", c, fb, items)
	}
	// an AI answer for a claimed span is dropped; one with no position is a did-you-mean
	call(t, srv, "POST", "/test/ai/next-answer", "", M{"items": []M{
		{"name": "roti", "quantity": 2, "unit": "count", "span_start": 2, "span_end": 6, "kcal": M{"low": 150, "best": 200, "high": 250}},
		{"name": "fermented tea", "quantity": 1, "unit": "glass", "span_start": 23, "span_end": 31, "kcal": M{"low": 30, "best": 40, "high": 60}},
	}}, nil)
	c, items, _ = get("sp3", "2 roti, 1 katori dal, kombuchaa")
	if len(items) != 3 || items[0].Source != "table" || items[2].Source != "ai_estimate" {
		t.Errorf("drop overlapping AI item: %+v", items)
	}
	call(t, srv, "POST", "/test/ai/next-answer", "", M{"items": []M{
		{"name": "something", "quantity": 1, "unit": "count", "span_start": 0, "span_end": 1, "kcal": M{"low": 30, "best": 40, "high": 60}},
	}}, nil)
	_, items, _ = get("sp4", "2 roti, glorbix")
	last := items[len(items)-1]
	if last.Source != "did_you_mean" || !last.NC || (last.SpanStart == 0 && last.SpanEnd == len("2 roti, glorbix")) {
		t.Errorf("unplaced AI item: %+v", items)
	}
}

// next-answer overrides go to the server guard (placeAI) verbatim: the stub
// must not fix rule-breaking answers. Overlaps with claimed table text are
// dropped; an answer with no position is placed by its words or flagged.
func TestNextAnswerReachesGuard(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	type it struct {
		Name      string
		Source    string
		Matched   string   `json:"matched_text"`
		SpanStart int      `json:"span_start"`
		SpanEnd   int      `json:"span_end"`
		NC        bool     `json:"needs_confirmation"`
		Flags     []string `json:"flags"`
	}
	get := func(user, text string) []it {
		var r struct {
			JobID string `json:"job_id"`
			Items []it
		}
		if call(t, srv, "POST", "/v1/parse", user, M{"text": text}, &r) == 202 {
			for call(t, srv, "GET", "/v1/parse/jobs/"+r.JobID, user, nil, &r) != 200 {
				time.Sleep(5 * time.Millisecond)
			}
		}
		return r.Items
	}
	kc := M{"low": 30, "best": 40, "high": 60}
	// "2 roti, glorbix, zanthu": roti is claimed at [2,6)
	text := "2 roti, glorbix, zanthu"
	call(t, srv, "POST", "/test/ai/next-answer", "", M{"items": []M{
		{"name": "overlapper", "quantity": 1, "unit": "count", "span_start": 0, "span_end": 10, "kcal": kc}, // overlaps roti
		{"name": "nowhere", "quantity": 1, "unit": "count", "kcal": kc},                                     // no position, words not in text
		{"name": "zanthu", "quantity": 1, "unit": "count", "kcal": kc},                                      // no position: never placed by name
		{"name": "zanthu stew", "span_text": "zanthu", "quantity": 1, "unit": "count", "kcal": kc},          // span_text places it
	}}, nil)
	items := get("g1", text)
	var roti, unplaced, placed *it
	for i := range items {
		switch items[i].Name {
		case "overlapper":
			t.Errorf("overlapping AI answer must be dropped: %+v", items)
		case "nowhere":
			unplaced = &items[i]
		case "zanthu stew":
			placed = &items[i]
		case "zanthu":
			if items[i].Source != "did_you_mean" || !slices.Contains(items[i].Flags, "ai_unplaced") {
				t.Errorf("an item with no position must not be placed by its name: %+v", items[i])
			}
		}
		if items[i].Source == "table" {
			roti = &items[i]
		}
	}
	if roti == nil || roti.NC || text[roti.SpanStart:roti.SpanEnd] != "roti" {
		t.Errorf("table item must stay confident: %+v", items)
	}
	if unplaced == nil || unplaced.Source != "did_you_mean" || !unplaced.NC || !slices.Contains(unplaced.Flags, "ai_unplaced") {
		t.Errorf("missing position must be flagged ai_unplaced, not corrected by the stub: %+v", items)
	}
	if placed == nil || placed.Source != "ai_estimate" || text[placed.SpanStart:placed.SpanEnd] != "zanthu" {
		t.Errorf("span_text must place the item: %+v", items)
	}
}

// Tester's shareable separator cases (testdata/separator-cases.json).
func TestSeparatorCases(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	var f struct {
		Cases []struct {
			ID, Input, Expect, Rule string
			KnownDish               string `json:"known_dish"`
			KnownText               string `json:"known_text"`
		}
	}
	b, err := os.ReadFile("testdata/separator-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(b, &f)
	pass := 0
	for i, c := range f.Cases {
		_, r := parseAI(t, srv, fmt.Sprintf("sep%d", i), c.Input)
		confirmed, flagged := false, false
		t16 := utf16.Encode([]rune(c.Input))
		for _, it := range r.Items {
			if it.DishID == c.KnownDish && it.Source == "table" && !it.NeedsConfirmation {
				confirmed = true
			}
			if it.SpanStart < it.SpanEnd && it.SpanEnd <= len(t16) &&
				strings.Contains(string(utf16.Decode(t16[it.SpanStart:it.SpanEnd])), c.KnownText) && slices.Contains(it.Flags, "leftover_nearby") {
				flagged = true
			}
		}
		ok := confirmed == (c.Expect == "confirmed")
		if c.Expect == "unconfirmed" && !flagged {
			ok = false // must be unconfirmed for the right reason
		}
		if ok {
			pass++
		} else {
			t.Errorf("%s %q (%s): want %s, got %+v", c.ID, c.Input, c.Rule, c.Expect, r.Items)
		}
	}
	t.Logf("separator cases: %d/%d", pass, len(f.Cases))
}
