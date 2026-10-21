package stoke

import (
	"fmt"
	"net/http"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

// Limits match the phone (src/features/plans/model.ts LIMITS).
const (
	planName     = 30
	maxRoutines  = 7
	maxExercises = 20
	maxSetsGoal  = 10
	maxRepsGoal  = 50
	maxRest      = 600
)

type planIn struct {
	Name     string          `json:"name"`
	Days     []string        `json:"days"`
	Active   bool            `json:"active"`
	Routines []store.Routine `json:"routines"`
	Version  *int            `json:"version"`
}

func checkTarget(t *store.Target) string {
	if t == nil {
		return ""
	}
	switch {
	case t.Sets < 1 || t.Sets > maxSetsGoal:
		return fmt.Sprintf("Target sets must be 1 to %d.", maxSetsGoal)
	case t.RepsLow < 1 || t.RepsHigh > maxRepsGoal || t.RepsLow > t.RepsHigh:
		return fmt.Sprintf("Target reps must be 1 to %d, low to high.", maxRepsGoal)
	}
	return ""
}

func checkRest(r int) string {
	if r < 0 || r > maxRest {
		return fmt.Sprintf("Rest must be 0 to %d seconds.", maxRest)
	}
	return ""
}

func checkPlan(p planIn) string {
	if e := firstOf(text("Name", p.Name, planName), checkVersion(p.Version)); e != "" {
		return e
	}
	if len(p.Routines) > maxRoutines {
		return fmt.Sprintf("A plan can have at most %d routines.", maxRoutines)
	}
	ids := map[string]bool{}
	for _, r := range p.Routines {
		if !idRe.MatchString(r.ID) || ids[r.ID] {
			return "Each routine needs its own id."
		}
		ids[r.ID] = true
		if e := text("Routine name", r.Name, planName); e != "" {
			return e
		}
		if len(r.Exercises) > maxExercises {
			return fmt.Sprintf("A routine can have at most %d exercises.", maxExercises)
		}
		for _, x := range r.Exercises {
			if !idRe.MatchString(x.ExerciseID) {
				return "An exercise has no id."
			}
			if e := firstOf(checkTarget(x.Target), checkRest(x.RestS)); e != "" {
				return e
			}
		}
	}
	if len(p.Days) != 7 {
		return "days must list Mon to Sun (7 entries)."
	}
	for _, d := range p.Days {
		if d != "" && !ids[d] {
			return "A day names a routine that isn’t in this plan."
		}
	}
	return ""
}

func (s *Service) listPlans(w http.ResponseWriter, r *http.Request) {
	ps, err := s.Plans.ListPlans(r.Context(), httpx.UserID(r))
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"plans": ps})
}

func (s *Service) getPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	p, err := s.Plans.GetPlan(r.Context(), httpx.UserID(r), id)
	if err == nil && p.DeletedAt != nil {
		err = store.ErrGone
	}
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, p)
}

func (s *Service) putPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var in planIn
	if !decode(w, r, &in) {
		return
	}
	if e := checkPlan(in); e != "" {
		refuse(w, e)
		return
	}
	if in.Routines == nil {
		in.Routines = []store.Routine{}
	}
	for i := range in.Routines {
		if in.Routines[i].Exercises == nil {
			in.Routines[i].Exercises = []store.RoutineExercise{}
		}
	}
	p, err := s.Plans.PutPlan(r.Context(), httpx.UserID(r), store.Plan{ID: id, Name: in.Name, Days: in.Days, Active: in.Active, Routines: in.Routines}, in.Version)
	if err != nil {
		storeErr(w, err)
		return
	}
	httpx.JSON(w, 200, p)
}

func (s *Service) deletePlan(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	v, ok := queryVersion(w, r)
	if !ok {
		return
	}
	if err := s.Plans.DeletePlan(r.Context(), httpx.UserID(r), id, v); err != nil {
		storeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
