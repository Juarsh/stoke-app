// Package goals owns the profile, diet preference and target history
// (kcal + macros for fat_loss / maintain / muscle_gain).
package goals

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

// Profile is what the server keeps. Sex is never sent or stored: the phone
// works out the target and sends it with the maintenance figure.
type Profile struct {
	BirthYear       int     `json:"birth_year"`
	HeightCM        float64 `json:"height_cm"`
	WeightKG        float64 `json:"weight_kg"`
	ActivityLevel   string  `json:"activity_level"`
	Goal            string  `json:"goal"`
	MaintenanceKcal int     `json:"maintenance_kcal"`
}

type Target struct {
	EffectiveFrom string `json:"effective_from"`
	Kcal          int    `json:"kcal"`
	ProteinG      int    `json:"protein_g"`
	CarbsG        int    `json:"carbs_g"`
	FatG          int    `json:"fat_g"`
	WaterML       int    `json:"water_ml"`
	Steps         int    `json:"steps"`
	Custom        bool   `json:"custom"`
}

var activity = map[string]float64{"sedentary": 1.2, "light": 1.375, "moderate": 1.55, "active": 1.725, "very_active": 1.9}
var goalAdj = map[string]float64{"fat_loss": -500, "maintain": 0, "muscle_gain": 300}

// Rules the phone's target must meet (spec: Coach and onboarding, Oct 16).
const (
	MinTargetKcal  = 1200
	MaxCutKcal     = 500
	MaintenanceTol = 2.0 // rounding on the phone
)

// MaintenanceRange is Mifflin-St Jeor maintenance (BMR x activity) for the
// female (-161) and male (+5) constants; "prefer not to say" (-78) sits
// between them, so any honest phone figure is inside.
func MaintenanceRange(age int, heightCM, weightKG float64, act string) (float64, float64) {
	base := 10*weightKG + 6.25*heightCM - 5*float64(age)
	f := activity[act]
	return (base - 161) * f, (base + 5) * f
}

// Macros for a kcal target: protein 1.6 g/kg (fat loss, gain) or 1.2
// (maintain); fat 25% of kcal; carbs the rest.
func Macros(kcal int, weightKG float64, goal string) Target {
	perKg := 1.6
	if goal == "maintain" {
		perKg = 1.2
	}
	k := float64(kcal)
	prot := math.Round(weightKG * perKg)
	fat := math.Round(k * 0.25 / 9)
	carbs := math.Max(0, math.Round((k-prot*4-fat*9)/4))
	return Target{Kcal: kcal, ProteinG: int(prot), CarbsG: int(carbs), FatG: int(fat), WaterML: 2500, Steps: 8000}
}

// ProfileIn is PUT /v1/profile. A "sex" field is accepted and ignored: it is
// never stored, logged or echoed.
type ProfileIn struct {
	TargetKcal      int             `json:"target_kcal"`
	MaintenanceKcal float64         `json:"maintenance_kcal"`
	Goal            string          `json:"goal"`
	Diet            string          `json:"diet"`
	Age             int             `json:"age"`
	HeightCM        float64         `json:"height_cm"`
	WeightKG        float64         `json:"weight_kg"`
	ActivityLevel   string          `json:"activity_level"`
	Sex             json.RawMessage `json:"sex"` // ignored, never persisted
}

// Validate returns field -> problem; empty when the profile is valid.
func (p ProfileIn) Validate() map[string]string {
	bad := map[string]string{}
	if p.Age < 13 || p.Age > 100 {
		bad["age"] = "must be 13-100"
	}
	if p.HeightCM < 100 || p.HeightCM > 250 {
		bad["height_cm"] = "must be 100-250"
	}
	if p.WeightKG < 25 || p.WeightKG > 300 {
		bad["weight_kg"] = "must be 25-300"
	}
	if activity[p.ActivityLevel] == 0 {
		bad["activity_level"] = "must be sedentary, light, moderate, active or very_active"
	}
	if _, ok := goalAdj[p.Goal]; !ok {
		bad["goal"] = "must be fat_loss, maintain or muscle_gain"
	}
	if p.Diet != "" && p.Diet != "veg" && p.Diet != "egg" && p.Diet != "nonveg" {
		bad["diet"] = "must be veg, egg or nonveg"
	}
	if p.TargetKcal < MinTargetKcal || p.TargetKcal > 6000 {
		bad["target_kcal"] = "must be 1200-6000"
	}
	if len(bad) > 0 {
		return bad
	}
	lo, hi := MaintenanceRange(p.Age, p.HeightCM, p.WeightKG, p.ActivityLevel)
	if p.MaintenanceKcal < lo-MaintenanceTol || p.MaintenanceKcal > hi+MaintenanceTol {
		bad["maintenance_kcal"] = "must be within Mifflin-St Jeor maintenance for this age, height, weight and activity"
	} else if float64(p.TargetKcal) < p.MaintenanceKcal-MaxCutKcal-MaintenanceTol {
		bad["target_kcal"] = "must not be more than 500 kcal below maintenance"
	}
	return bad
}

type Service struct{ DB *pgxpool.Pool }

// pg: the store on this service's pool.
func (s *Service) pg() *store.PG { return &store.PG{DB: s.DB} }

// TargetFor returns the target in effect on a day (nil if onboarding not done).
func (s *Service) TargetFor(ctx context.Context, userID int64, day time.Time) (*Target, error) {
	var t Target
	var eff time.Time
	err := s.pg().Goals().TargetOn(ctx, userID, day, &eff, &t.Kcal, &t.ProteinG, &t.CarbsG, &t.FatG, &t.WaterML, &t.Steps, &t.Custom)
	if err == store.ErrNoRows {
		// a target set "today" still applies to earlier days when no older one exists
		err = s.pg().Goals().FirstTarget(ctx, userID, &eff, &t.Kcal, &t.ProteinG, &t.CarbsG, &t.FatG, &t.WaterML, &t.Steps, &t.Custom)
	}
	if err == store.ErrNoRows {
		return nil, nil
	}
	t.EffectiveFrom = eff.Format("2006-01-02")
	return &t, err
}

// WeightKG returns the profile weight (70 if unknown).
func (s *Service) WeightKG(ctx context.Context, userID int64) float64 {
	var w float64
	if s.pg().Goals().WeightKG(ctx, userID, &w) != nil {
		return 70
	}
	return w
}

// Diet returns veg / egg / nonveg.
func (s *Service) Diet(ctx context.Context, userID int64) string {
	var d string
	if s.pg().Goals().Diet(ctx, userID, &d) != nil {
		return "nonveg"
	}
	return d
}

func (s *Service) StepsInBudget(ctx context.Context, userID int64) bool {
	var b bool
	_ = s.pg().Goals().StepsInBudget(ctx, userID, &b)
	return b
}

func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /v1/me", wrap(http.HandlerFunc(s.getMe)))
	mux.Handle("PATCH /v1/me", wrap(http.HandlerFunc(s.patchMe)))
	mux.Handle("DELETE /v1/me", wrap(http.HandlerFunc(s.deleteMe)))
	mux.Handle("PUT /v1/profile", wrap(http.HandlerFunc(s.putProfile)))
	mux.Handle("GET /v1/targets", wrap(http.HandlerFunc(s.getTarget)))
	mux.Handle("PUT /v1/targets", wrap(http.HandlerFunc(s.putTarget)))
}

type me struct {
	Email         string   `json:"email"`
	Name          string   `json:"name"`
	TZ            string   `json:"tz"`
	Diet          string   `json:"diet"`
	StepsInBudget bool     `json:"steps_in_budget"`
	Profile       *Profile `json:"profile"`
}

func (s *Service) getMe(w http.ResponseWriter, r *http.Request) {
	uid := httpx.UserID(r)
	var m me
	if err := s.pg().Goals().Me(r.Context(), uid, &m.Email, &m.Name, &m.TZ, &m.Diet, &m.StepsInBudget); err != nil {
		httpx.Error(w, 500, "lookup failed")
		return
	}
	var p Profile
	var mk *int
	if s.pg().Goals().Profile(r.Context(), uid, &p.BirthYear, &p.HeightCM, &p.WeightKG, &p.ActivityLevel, &p.Goal, &mk) == nil {
		if mk != nil {
			p.MaintenanceKcal = *mk
		}
		m.Profile = &p
	}
	httpx.JSON(w, 200, m)
}

func (s *Service) patchMe(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name          *string `json:"name"`
		Diet          *string `json:"diet"`
		StepsInBudget *bool   `json:"steps_in_budget"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Diet != nil && *in.Diet != "veg" && *in.Diet != "egg" && *in.Diet != "nonveg" {
		httpx.Error(w, 400, "diet must be veg, egg or nonveg")
		return
	}
	err := s.pg().Goals().UpdateMe(r.Context(), httpx.UserID(r), in.Name, in.Diet, in.StepsInBudget)
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	s.getMe(w, r)
}

// deleteMe removes the account and all data (Play requirement). Hard delete via ON DELETE CASCADE.
func (s *Service) deleteMe(w http.ResponseWriter, r *http.Request) {
	if err := s.pg().Goals().DeleteUser(r.Context(), httpx.UserID(r)); err != nil {
		httpx.Error(w, 500, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// putProfile stores the phone's onboarding answers and its target as is
// (never recomputed). Invalid -> 422 {"error":{"code":"profile_invalid","fields":{...}}}.
func (s *Service) putProfile(w http.ResponseWriter, r *http.Request) {
	var in ProfileIn
	if !httpx.Decode(w, r, &in) {
		return
	}
	in.Sex = nil // never stored, logged or echoed
	if bad := in.Validate(); len(bad) > 0 {
		httpx.JSON(w, 422, map[string]any{"error": map[string]any{"code": "profile_invalid",
			"message": "Profile or target doesn't add up; nothing was saved.", "fields": bad}})
		return
	}
	today := httpx.Today()
	uid := httpx.UserID(r)
	p := Profile{BirthYear: today.Year() - in.Age, HeightCM: in.HeightCM, WeightKG: in.WeightKG, ActivityLevel: in.ActivityLevel,
		Goal: in.Goal, MaintenanceKcal: int(math.Round(in.MaintenanceKcal))}
	t := Macros(in.TargetKcal, in.WeightKG, in.Goal)
	tx, err := s.pg().Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer tx.Rollback(r.Context())
	err = tx.Goals().PutProfile(r.Context(), uid, p.BirthYear, p.HeightCM, p.WeightKG, p.ActivityLevel, p.Goal, p.MaintenanceKcal)
	if err == nil && in.Diet != "" {
		err = tx.Goals().SetDiet(r.Context(), uid, in.Diet)
	}
	if err == nil {
		err = upsertTarget(r.Context(), tx, uid, today, t)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		httpx.Error(w, 500, "save failed")
		return
	}
	t.EffectiveFrom = today.Format("2006-01-02")
	httpx.JSON(w, 200, map[string]any{"profile": p, "target": t})
}

func upsertTarget(ctx context.Context, tx *store.Tx, uid int64, day time.Time, t Target) error {
	return tx.Goals().PutTarget(ctx, uid, day, t.Kcal, t.ProteinG, t.CarbsG, t.FatG, t.WaterML, t.Steps, t.Custom)
}

func (s *Service) getTarget(w http.ResponseWriter, r *http.Request) {
	day, ok := httpx.DayParam(w, r)
	if !ok {
		return
	}
	t, err := s.TargetFor(r.Context(), httpx.UserID(r), day)
	if err != nil {
		httpx.Error(w, 500, "lookup failed")
		return
	}
	if t == nil {
		httpx.Error(w, 404, "no target yet; PUT /v1/profile first")
		return
	}
	httpx.JSON(w, 200, t)
}

// putTarget lets the user edit targets; history is kept (effective from today).
func (s *Service) putTarget(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Kcal     int  `json:"kcal"`
		ProteinG int  `json:"protein_g"`
		CarbsG   *int `json:"carbs_g"`
		FatG     *int `json:"fat_g"`
		WaterML  *int `json:"water_ml"`
		Steps    *int `json:"steps"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Kcal < 800 || in.Kcal > 6000 || in.ProteinG < 0 || in.ProteinG > 400 {
		httpx.Error(w, 400, "kcal must be 800-6000 and protein_g 0-400")
		return
	}
	fat := int(math.Round(float64(in.Kcal) * 0.25 / 9))
	t := Target{Kcal: in.Kcal, ProteinG: in.ProteinG, FatG: fat, WaterML: 2500, Steps: 8000, Custom: true}
	if in.FatG != nil {
		t.FatG = *in.FatG
	}
	t.CarbsG = max(0, (in.Kcal-in.ProteinG*4-t.FatG*9)/4)
	if in.CarbsG != nil {
		t.CarbsG = *in.CarbsG
	}
	if in.WaterML != nil {
		t.WaterML = *in.WaterML
	}
	if in.Steps != nil {
		t.Steps = *in.Steps
	}
	today := httpx.Today()
	tx, err := s.pg().Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer tx.Rollback(r.Context())
	if err := upsertTarget(r.Context(), tx, httpx.UserID(r), today, t); err != nil || tx.Commit(r.Context()) != nil {
		httpx.Error(w, 500, "save failed")
		return
	}
	t.EffectiveFrom = today.Format("2006-01-02")
	httpx.JSON(w, 200, t)
}
