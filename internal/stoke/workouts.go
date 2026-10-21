package stoke

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

// Limits match the phone (src/features/workout/model.ts): kg 0–1,000, reps 1–200, a timed set 1 s–24 h.
const (
	kgMax        = 1000
	repsMax      = 200
	secsMax      = 24 * 3600
	titleMax     = 60
	maxWExercise = 30
	maxSets      = 30
)

type workoutIn struct {
	Title     string                  `json:"title"`
	PlanID    *string                 `json:"plan_id"`
	RoutineID *string                 `json:"routine_id"`
	LocalDate string                  `json:"local_date"`
	StartedAt time.Time               `json:"started_at"`
	EndedAt   time.Time               `json:"ended_at"`
	Exercises []store.WorkoutExercise `json:"exercises"`
	Version   *int                    `json:"version"`
}

// Summary is the server's count of a finished workout, by the phone's rules (stats() in workout/model.ts): volume is
// kg × reps over done sets (a bodyweight set counts its added kg only, a timed set counts no volume); reps are summed
// over done non-timed sets; seconds over done timed sets.
type Summary struct {
	Volume     float64 `json:"volume_kg"`
	Done       int     `json:"sets_done"`
	Total      int     `json:"sets_total"`
	Reps       int     `json:"reps"`
	Seconds    int     `json:"seconds"`
	Exercises  int     `json:"exercises"`
	Started    int     `json:"exercises_started"`
	DurationS  int     `json:"duration_s"`
	DurationMn int     `json:"duration_min"`
}

func Summarize(w store.Workout) Summary {
	var s Summary
	for _, x := range w.Exercises {
		started := false
		s.Total += len(x.Sets)
		for _, y := range x.Sets {
			if !y.Done {
				continue
			}
			s.Done++
			started = true
			if y.Reps == nil {
				continue
			}
			if x.Kind == "time" {
				s.Seconds += *y.Reps
				continue
			}
			s.Reps += *y.Reps
			if y.Kg != nil {
				s.Volume += *y.Kg * float64(*y.Reps)
			}
		}
		if started {
			s.Started++
		}
	}
	s.Volume = math.Round(s.Volume*100) / 100
	s.Exercises = len(w.Exercises)
	d := w.EndedAt.Sub(w.StartedAt)
	s.DurationS = int(d / time.Second)
	s.DurationMn = int(math.Round(d.Minutes()))
	return s
}

type workoutOut struct {
	store.Workout
	Summary Summary `json:"summary"`
}

func decimals2(f float64) bool { return math.Abs(f*100-math.Round(f*100)) < 1e-6 }

func (s *Service) checkWorkout(in workoutIn) string {
	if e := firstOf(text("Title", in.Title, titleMax), s.day("local_date", in.LocalDate), checkVersion(in.Version)); e != "" {
		return e
	}
	for _, p := range []*string{in.PlanID, in.RoutineID} {
		if p != nil && !idRe.MatchString(*p) {
			return "plan_id and routine_id must be ids or null."
		}
	}
	switch {
	case in.StartedAt.IsZero() || in.EndedAt.IsZero():
		return "A finished workout needs started_at and ended_at."
	case in.EndedAt.Before(in.StartedAt):
		return "ended_at is before started_at."
	case in.EndedAt.After(s.now().Add(10 * time.Minute)):
		return "ended_at can’t be in the future."
	case in.EndedAt.Sub(in.StartedAt) > 24*time.Hour:
		return "A workout can be at most 24 hours long."
	case len(in.Exercises) > maxWExercise:
		return fmt.Sprintf("A workout can have at most %d exercises.", maxWExercise)
	}
	exIDs := map[string]bool{}
	for _, x := range in.Exercises {
		if !idRe.MatchString(x.ID) || exIDs[x.ID] || !idRe.MatchString(x.ExerciseID) {
			return "Each exercise needs its own id and an exercise_id."
		}
		exIDs[x.ID] = true
		if x.Kind != "weight" && x.Kind != "bodyweight" && x.Kind != "time" {
			return "kind must be weight, bodyweight or time."
		}
		if e := firstOf(checkTarget(x.Target), checkRest(x.RestS)); e != "" {
			return e
		}
		if len(x.Sets) > maxSets {
			return fmt.Sprintf("An exercise can have at most %d sets.", maxSets)
		}
		setIDs := map[string]bool{}
		for _, y := range x.Sets {
			if !idRe.MatchString(y.ID) || setIDs[y.ID] {
				return "Each set needs its own id."
			}
			setIDs[y.ID] = true
			if e := checkSet(x.Kind, y); e != "" {
				return e
			}
		}
	}
	return ""
}

func checkSet(kind string, y store.WSet) string {
	max := repsMax
	if kind == "time" {
		max = secsMax
	}
	if y.Reps != nil && (*y.Reps < 1 || *y.Reps > max) {
		if kind == "time" {
			return "Seconds must be a whole number from 1 to 86,400."
		}
		return fmt.Sprintf("Reps must be a whole number from 1 to %d.", repsMax)
	}
	if y.Kg != nil {
		switch {
		case kind == "time":
			return "A timed set has no kg."
		case *y.Kg < 0 || *y.Kg > kgMax || math.IsNaN(*y.Kg):
			return "kg must be a number from 0 to 1,000."
		case !decimals2(*y.Kg):
			return "kg can have at most 2 decimals (like 62.5)."
		}
	}
	if y.Done && (y.Reps == nil || y.DoneAt == nil) {
		return "A ticked set has no valid reps."
	}
	if !y.Done && y.DoneAt != nil {
		return "A set that isn’t ticked has no done_at."
	}
	return ""
}

func (s *Service) listWorkouts(w http.ResponseWriter, r *http.Request) {
	from, to, ok := dateRange(w, r)
	if !ok {
		return
	}
	ws, err := s.Workouts.ListWorkouts(r.Context(), httpx.UserID(r), from, to)
	if err != nil {
		storeErr(w, err)
		return
	}
	out := make([]workoutOut, len(ws))
	for i, x := range ws {
		out[i] = workoutOut{x, Summarize(x)}
	}
	httpx.JSON(w, 200, map[string]any{"workouts": out})
}

func (s *Service) getWorkout(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	x, err := s.Workouts.GetWorkout(r.Context(), httpx.UserID(r), id)
	if err == nil && x.DeletedAt != nil {
		err = store.ErrGone
	}
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, workoutOut{x, Summarize(x)})
}

func (s *Service) putWorkout(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var in workoutIn
	if !decode(w, r, &in) {
		return
	}
	if e := s.checkWorkout(in); e != "" {
		refuse(w, e)
		return
	}
	if in.Exercises == nil {
		in.Exercises = []store.WorkoutExercise{}
	}
	for i := range in.Exercises {
		if in.Exercises[i].Sets == nil {
			in.Exercises[i].Sets = []store.WSet{}
		}
	}
	x, err := s.Workouts.PutWorkout(r.Context(), httpx.UserID(r), store.Workout{ID: id, Title: in.Title, PlanID: in.PlanID, RoutineID: in.RoutineID,
		LocalDate: in.LocalDate, StartedAt: in.StartedAt, EndedAt: in.EndedAt, Exercises: in.Exercises}, in.Version)
	if err != nil {
		storeErr(w, wrapWorkoutConflict(err))
		return
	}
	httpx.JSON(w, 200, workoutOut{x, Summarize(x)})
}

// wrapWorkoutConflict: a 409's server row carries its summary too.
func wrapWorkoutConflict(err error) error {
	var c *store.Conflict
	if errors.As(err, &c) {
		if x, ok := c.Current.(store.Workout); ok {
			return &store.Conflict{Current: workoutOut{x, Summarize(x)}, Version: c.Version}
		}
	}
	return err
}

func (s *Service) deleteWorkout(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	v, ok := queryVersion(w, r)
	if !ok {
		return
	}
	if err := s.Workouts.DeleteWorkout(r.Context(), httpx.UserID(r), id, v); err != nil {
		storeErr(w, wrapWorkoutConflict(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
