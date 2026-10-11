// Package httpx has small JSON helpers shared by the domain packages.
// The API is JSON-only, no cookies; auth is a bearer token.
package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

type ctxKey int

const userKey ctxKey = 1

// IST is the default day boundary (users.tz is stored for later per-user zones).
var IST = time.FixedZone("IST", 5*3600+1800)

// Now is swappable in tests.
var Now = time.Now

func WithUser(ctx context.Context, id int64) context.Context { return context.WithValue(ctx, userKey, id) }

// UserID returns the authenticated user's id (set by auth middleware).
func UserID(r *http.Request) int64 { id, _ := r.Context().Value(userKey).(int64); return id }

func JSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func Error(w http.ResponseWriter, code int, msg string) {
	JSON(w, code, map[string]string{"error": msg})
}

// Decode reads a JSON body (max 64 KB) and rejects unknown fields.
func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		Error(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// LocalDate returns the IST calendar date of t (as a UTC midnight time.Time).
func LocalDate(t time.Time) time.Time {
	t = t.In(IST)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func Today() time.Time { return LocalDate(Now()) }

// Day parses YYYY-MM-DD, or "" for today (IST).
func Day(s string) (time.Time, error) {
	if s == "" {
		return Today(), nil
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return t, errors.New("date must be YYYY-MM-DD")
	}
	return t, nil
}

// DayParam reads ?date= and writes a 400 on error.
func DayParam(w http.ResponseWriter, r *http.Request) (time.Time, bool) {
	d, err := Day(r.URL.Query().Get("date"))
	if err != nil {
		Error(w, http.StatusBadRequest, err.Error())
		return d, false
	}
	return d, true
}

// SlotFor picks the meal slot by IST time of logging:
// before 11 breakfast, 11-16 lunch, 16-19 snacks, after 19 dinner.
func SlotFor(t time.Time) string {
	h := t.In(IST).Hour()
	switch {
	case h < 11:
		return "breakfast"
	case h < 16:
		return "lunch"
	case h < 19:
		return "snacks"
	}
	return "dinner"
}
