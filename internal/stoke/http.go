// Package stoke serves Stoke's training and habit data: plans with their routines, finished workouts with their sets
// (and the server's summary of each), habits with their daily logs. Same rules as food entries: the server answers
// with the row it stored and that row is the truth; an edit based on an older version is a 409 with the server's row
// (never a silent overwrite); a bad value is a 400 with the reason, never clamped. SQL lives in internal/store.
package stoke

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

type Service struct {
	Plans    store.Plans
	Workouts store.Workouts
	Habits   store.Habits
	// Now is the clock for "not in the future" checks (tests set it).
	Now func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	h := func(p string, f http.HandlerFunc) { mux.Handle(p, wrap(f)) }
	h("GET /v1/plans", s.listPlans)
	h("GET /v1/plans/{id}", s.getPlan)
	h("PUT /v1/plans/{id}", s.putPlan)
	h("DELETE /v1/plans/{id}", s.deletePlan)
	h("GET /v1/workouts", s.listWorkouts)
	h("GET /v1/workouts/{id}", s.getWorkout)
	h("PUT /v1/workouts/{id}", s.putWorkout)
	h("DELETE /v1/workouts/{id}", s.deleteWorkout)
	h("GET /v1/habits", s.listHabits)
	h("GET /v1/habits/{id}", s.getHabit)
	h("PUT /v1/habits/{id}", s.putHabit)
	h("DELETE /v1/habits/{id}", s.deleteHabit)
	h("GET /v1/habit-logs", s.listLogs)
	h("PUT /v1/habits/{id}/logs/{date}", s.putLog)
	h("DELETE /v1/habits/{id}/logs/{date}", s.deleteLog)
}

// refuse: 400 {"error":{"code":"invalid","message":reason}} (the phone shows the reason and keeps its value).
func refuse(w http.ResponseWriter, reason string) {
	httpx.JSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "invalid", "message": reason}})
}

// storeErr answers a repository error. 409 carries the server's row under "row".
func storeErr(w http.ResponseWriter, err error) {
	var c *store.Conflict
	switch {
	case errors.As(err, &c):
		httpx.JSON(w, http.StatusConflict, map[string]any{
			"error": map[string]any{"code": "version_conflict", "version": c.Version, "message": "Changed on another device. Showing the saved version."},
			"row":   c.Current,
		})
	case errors.Is(err, store.ErrGone):
		httpx.JSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "gone", "message": "Deleted on another device."}})
	case errors.Is(err, store.ErrNotFound):
		httpx.JSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "not_found", "message": "Not found."}})
	case errors.Is(err, store.ErrParentMissing):
		httpx.JSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "habit_not_found", "message": "This habit isn’t on the server yet."}})
	case errors.Is(err, store.ErrShortNameTaken):
		refuse(w, "Already used, pick another")
	default:
		log.Printf("stoke: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "server error")
	}
}

// decode: a strict JSON body (unknown fields refused), up to 512 KB (a long workout).
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		refuse(w, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

var idRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// pathID: the {id} path value, refused unless it is a plain id.
func pathID(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	id := r.PathValue(name)
	if !idRe.MatchString(id) {
		refuse(w, "Bad id.")
		return "", false
	}
	return id, true
}

// version: a body version must be a whole number from 1; nil = not sent.
func checkVersion(v *int) string {
	if v != nil && *v < 1 {
		return "version must be a whole number from 1."
	}
	return ""
}

// queryVersion: DELETE ?version=n (optional).
func queryVersion(w http.ResponseWriter, r *http.Request) (*int, bool) {
	q := r.URL.Query().Get("version")
	if q == "" {
		return nil, true
	}
	n, err := strconv.Atoi(q)
	if err != nil || n < 1 {
		refuse(w, "version must be a whole number from 1.")
		return nil, false
	}
	return &n, true
}

// text: a trimmed name of 1..max characters; leading or trailing spaces are refused, not trimmed.
func text(label, s string, max int) string {
	switch {
	case strings.TrimSpace(s) == "":
		return "Enter a " + strings.ToLower(label) + "."
	case strings.TrimSpace(s) != s:
		return label + " can’t start or end with a space."
	case utf8.RuneCountInString(s) > max:
		return label + " can be at most " + strconv.Itoa(max) + " characters."
	}
	return ""
}

// day: a YYYY-MM-DD date, at most one day after today in India (the phone's day may be ahead of the server's).
func (s *Service) day(label, d string) string {
	t, err := time.Parse("2006-01-02", d)
	if err != nil || t.Format("2006-01-02") != d {
		return label + " must be a date (YYYY-MM-DD)."
	}
	if t.After(httpx.LocalDate(s.now()).AddDate(0, 0, 1)) {
		return label + " can’t be in the future."
	}
	return ""
}

func dateRange(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	for _, d := range []string{from, to} {
		if d == "" {
			continue
		}
		if _, err := time.Parse("2006-01-02", d); err != nil {
			refuse(w, "from and to must be dates (YYYY-MM-DD).")
			return "", "", false
		}
	}
	return from, to, true
}

func firstOf(rs ...string) string {
	for _, r := range rs {
		if r != "" {
			return r
		}
	}
	return ""
}
