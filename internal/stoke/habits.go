package stoke

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

// Limits match the phone (src/features/habits/model.ts LIMITS, draftErrors). The phone also checks that a short name
// fits its Home slot (font metrics); the server checks the length only.
const (
	habitName  = 40
	habitShort = 16
	countMax   = 999
	habitSets  = 20
	habitReps  = 200
	unitMax    = 16
	allDays    = 0b1111111
	monFri     = 0b0011111
	logMax     = 99999
)

var stepsRe = regexp.MustCompile(`(?i)^steps?$`)

type habitIn struct {
	Name          string     `json:"name"`
	ShortName     string     `json:"short_name"`
	ShortNameAuto bool       `json:"short_name_auto"`
	Icon          *string    `json:"icon"`
	Kind          string     `json:"kind"`
	TargetValue   *int       `json:"target_value"`
	Unit          *string    `json:"unit"`
	TargetSets    *int       `json:"target_sets"`
	TargetReps    *int       `json:"target_reps"`
	Schedule      string     `json:"schedule"`
	Weekdays      int        `json:"weekdays"`
	StartsOn      string     `json:"starts_on"`
	Position      int        `json:"position"`
	ArchivedAt    *time.Time `json:"archived_at"`
	Version       *int       `json:"version"`
}

func in(p *int, lo, hi int) bool { return p != nil && *p >= lo && *p <= hi }

func (s *Service) checkHabit(h habitIn) string {
	if e := firstOf(text("Name", h.Name, habitName), text("Short name", h.ShortName, habitShort), checkVersion(h.Version)); e != "" {
		return e
	}
	if h.Icon != nil && !idRe.MatchString(*h.Icon) {
		return "icon must be an icon name or null."
	}
	switch h.Kind {
	case "done":
		if h.TargetValue != nil || h.Unit != nil || h.TargetSets != nil || h.TargetReps != nil {
			return "A done habit has no target."
		}
	case "count":
		switch {
		case !in(h.TargetValue, 1, countMax):
			return fmt.Sprintf("Target must be a whole number from 1 to %d.", countMax)
		case h.Unit == nil:
			return "Pick a unit."
		case text("Unit", *h.Unit, unitMax) != "":
			// any short free text ("times", "laps", "big cups"); the phone sends it trimmed, with "times" for an empty field
			return text("Unit", *h.Unit, unitMax)
		case stepsRe.MatchString(*h.Unit):
			return "Steps are on the Food card, so they can’t be a habit."
		case h.TargetSets != nil || h.TargetReps != nil:
			return "A count habit has no sets or reps."
		}
	case "sets":
		if !in(h.TargetSets, 1, habitSets) || !in(h.TargetReps, 1, habitReps) {
			return fmt.Sprintf("Sets must be 1 to %d and reps 1 to %d.", habitSets, habitReps)
		}
		if h.TargetValue != nil || h.Unit != nil {
			return "A sets habit has no count target."
		}
	default:
		return "kind must be done, count or sets."
	}
	switch {
	case h.Schedule == "daily" && h.Weekdays != allDays, h.Schedule == "weekdays" && h.Weekdays != monFri:
		return "weekdays doesn’t match the schedule."
	case h.Schedule == "days" && (h.Weekdays < 1 || h.Weekdays > allDays):
		return "Pick at least one day."
	case h.Schedule != "daily" && h.Schedule != "weekdays" && h.Schedule != "days":
		return "schedule must be daily, weekdays or days."
	case h.Position < 0 || h.Position > 10000:
		return "position must be 0 to 10000."
	}
	return s.day("starts_on", h.StartsOn)
}

func (s *Service) listHabits(w http.ResponseWriter, r *http.Request) {
	hs, err := s.Habits.ListHabits(r.Context(), httpx.UserID(r))
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"habits": hs})
}

func (s *Service) getHabit(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	h, err := s.Habits.GetHabit(r.Context(), httpx.UserID(r), id)
	if err == nil && h.DeletedAt != nil {
		err = store.ErrGone
	}
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, h)
}

func (s *Service) putHabit(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var h habitIn
	if !decode(w, r, &h) {
		return
	}
	if e := s.checkHabit(h); e != "" {
		refuse(w, e)
		return
	}
	out, err := s.Habits.PutHabit(r.Context(), httpx.UserID(r), store.Habit{ID: id, Name: h.Name, ShortName: h.ShortName, ShortNameAuto: h.ShortNameAuto, Icon: h.Icon,
		Kind: h.Kind, TargetValue: h.TargetValue, Unit: h.Unit, TargetSets: h.TargetSets, TargetReps: h.TargetReps, Schedule: h.Schedule, Weekdays: h.Weekdays,
		StartsOn: h.StartsOn, Position: h.Position, ArchivedAt: h.ArchivedAt}, h.Version)
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}

func (s *Service) deleteHabit(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	v, ok := queryVersion(w, r)
	if !ok {
		return
	}
	if err := s.Habits.DeleteHabit(r.Context(), httpx.UserID(r), id, v); err != nil {
		storeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type logIn struct {
	ID             string          `json:"id"`
	Value          *int            `json:"value"`
	Done           bool            `json:"done"`
	TargetSnapshot json.RawMessage `json:"target_snapshot"`
	LoggedAt       time.Time       `json:"logged_at"`
	Version        *int            `json:"version"`
}

type snapIn struct {
	Kind  string  `json:"kind"`
	Value *int    `json:"value"`
	Unit  *string `json:"unit"`
	Sets  *int    `json:"sets"`
	Reps  *int    `json:"reps"`
}

func checkLog(l logIn) string {
	if !idRe.MatchString(l.ID) {
		return "A log needs an id."
	}
	if e := checkVersion(l.Version); e != "" {
		return e
	}
	if l.Value != nil && (*l.Value < 0 || *l.Value > logMax) {
		return fmt.Sprintf("value must be a whole number from 0 to %d.", logMax)
	}
	if l.LoggedAt.IsZero() {
		return "A log needs logged_at."
	}
	var sn snapIn
	if err := strictJSON(l.TargetSnapshot, &sn); err != nil || (sn.Kind != "done" && sn.Kind != "count" && sn.Kind != "sets") {
		return "target_snapshot must be the habit's target {kind, value, unit, sets, reps}."
	}
	return ""
}

func strictJSON(raw []byte, v any) error {
	if len(raw) == 0 {
		return fmt.Errorf("empty")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func (s *Service) logPath(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return "", "", false
	}
	d := r.PathValue("date")
	if e := s.day("The day", d); e != "" {
		refuse(w, e)
		return "", "", false
	}
	return id, d, true
}

func (s *Service) listLogs(w http.ResponseWriter, r *http.Request) {
	from, to, ok := dateRange(w, r)
	if !ok {
		return
	}
	ls, err := s.Habits.ListLogs(r.Context(), httpx.UserID(r), from, to)
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"logs": ls})
}

func (s *Service) putLog(w http.ResponseWriter, r *http.Request) {
	id, d, ok := s.logPath(w, r)
	if !ok {
		return
	}
	var l logIn
	if !decode(w, r, &l) {
		return
	}
	if e := checkLog(l); e != "" {
		refuse(w, e)
		return
	}
	out, err := s.Habits.PutLog(r.Context(), httpx.UserID(r), store.HabitLog{ID: l.ID, HabitID: id, LocalDate: d, Value: l.Value, Done: l.Done,
		TargetSnapshot: l.TargetSnapshot, LoggedAt: l.LoggedAt}, l.Version)
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}

func (s *Service) deleteLog(w http.ResponseWriter, r *http.Request) {
	id, d, ok := s.logPath(w, r)
	if !ok {
		return
	}
	v, ok := queryVersion(w, r)
	if !ok {
		return
	}
	if err := s.Habits.DeleteLog(r.Context(), httpx.UserID(r), id, d, v); err != nil {
		storeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
