// Package goals owns the profile, diet preference and target history
// (kcal + macros for fat_loss / maintain / muscle_gain).
package goals

import (
	"context"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
)

type Profile struct {
	Sex           string  `json:"sex"`
	BirthYear     int     `json:"birth_year"`
	HeightCM      float64 `json:"height_cm"`
	WeightKG      float64 `json:"weight_kg"`
	ActivityLevel string  `json:"activity_level"`
	Goal          string  `json:"goal"`
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

// Compute uses Mifflin-St Jeor. Protein 1.6 g/kg (fat loss, gain) or 1.2 (maintain);
// fat 25% of kcal; carbs the rest.
func Compute(p Profile, year int) Target {
	age := float64(year - p.BirthYear)
	bmr := 10*p.WeightKG + 6.25*p.HeightCM - 5*age
	if p.Sex == "male" {
		bmr += 5
	} else {
		bmr -= 161
	}
	kcal := bmr*activity[p.ActivityLevel] + goalAdj[p.Goal]
	if kcal < 1200 {
		kcal = 1200
	}
	kcal = math.Round(kcal/10) * 10
	perKg := 1.6
	if p.Goal == "maintain" {
		perKg = 1.2
	}
	prot := math.Round(p.WeightKG * perKg)
	fat := math.Round(kcal * 0.25 / 9)
	carbs := math.Max(0, math.Round((kcal-prot*4-fat*9)/4))
	return Target{Kcal: int(kcal), ProteinG: int(prot), CarbsG: int(carbs), FatG: int(fat), WaterML: 2500, Steps: 8000}
}

func (p Profile) validate(year int) string {
	switch {
	case p.Sex != "male" && p.Sex != "female":
		return "sex must be male or female"
	case year-p.BirthYear < 13 || year-p.BirthYear > 100:
		return "birth_year out of range"
	case p.HeightCM < 100 || p.HeightCM > 250:
		return "height_cm must be 100-250"
	case p.WeightKG < 25 || p.WeightKG > 300:
		return "weight_kg must be 25-300"
	case activity[p.ActivityLevel] == 0:
		return "activity_level must be sedentary, light, moderate, active or very_active"
	}
	if _, ok := goalAdj[p.Goal]; !ok {
		return "goal must be fat_loss, maintain or muscle_gain"
	}
	return ""
}

type Service struct{ DB *pgxpool.Pool }

// TargetFor returns the target in effect on a day (nil if onboarding not done).
func (s *Service) TargetFor(ctx context.Context, userID int64, day time.Time) (*Target, error) {
	var t Target
	var eff time.Time
	err := s.DB.QueryRow(ctx, `SELECT effective_from,kcal,protein_g,carbs_g,fat_g,water_ml,steps,custom FROM targets
		WHERE user_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC LIMIT 1`, userID, day).
		Scan(&eff, &t.Kcal, &t.ProteinG, &t.CarbsG, &t.FatG, &t.WaterML, &t.Steps, &t.Custom)
	if err == pgx.ErrNoRows {
		// a target set "today" still applies to earlier days when no older one exists
		err = s.DB.QueryRow(ctx, `SELECT effective_from,kcal,protein_g,carbs_g,fat_g,water_ml,steps,custom FROM targets
			WHERE user_id=$1 ORDER BY effective_from LIMIT 1`, userID).
			Scan(&eff, &t.Kcal, &t.ProteinG, &t.CarbsG, &t.FatG, &t.WaterML, &t.Steps, &t.Custom)
	}
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	t.EffectiveFrom = eff.Format("2006-01-02")
	return &t, err
}

// WeightKG returns the profile weight (70 if unknown).
func (s *Service) WeightKG(ctx context.Context, userID int64) float64 {
	var w float64
	if s.DB.QueryRow(ctx, `SELECT weight_kg FROM profiles WHERE user_id=$1`, userID).Scan(&w) != nil {
		return 70
	}
	return w
}

// Diet returns veg / egg / nonveg.
func (s *Service) Diet(ctx context.Context, userID int64) string {
	var d string
	if s.DB.QueryRow(ctx, `SELECT diet FROM users WHERE id=$1`, userID).Scan(&d) != nil {
		return "nonveg"
	}
	return d
}

func (s *Service) StepsInBudget(ctx context.Context, userID int64) bool {
	var b bool
	_ = s.DB.QueryRow(ctx, `SELECT steps_in_budget FROM users WHERE id=$1`, userID).Scan(&b)
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
	if err := s.DB.QueryRow(r.Context(), `SELECT email,name,tz,diet,steps_in_budget FROM users WHERE id=$1`, uid).
		Scan(&m.Email, &m.Name, &m.TZ, &m.Diet, &m.StepsInBudget); err != nil {
		httpx.Error(w, 500, "lookup failed")
		return
	}
	var p Profile
	if s.DB.QueryRow(r.Context(), `SELECT sex,birth_year,height_cm,weight_kg,activity_level,goal FROM profiles WHERE user_id=$1`, uid).
		Scan(&p.Sex, &p.BirthYear, &p.HeightCM, &p.WeightKG, &p.ActivityLevel, &p.Goal) == nil {
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
	_, err := s.DB.Exec(r.Context(), `UPDATE users SET name=COALESCE($2,name), diet=COALESCE($3,diet), steps_in_budget=COALESCE($4,steps_in_budget) WHERE id=$1`,
		httpx.UserID(r), in.Name, in.Diet, in.StepsInBudget)
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	s.getMe(w, r)
}

// deleteMe removes the account and all data (Play requirement). Hard delete via ON DELETE CASCADE.
func (s *Service) deleteMe(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.Exec(r.Context(), `DELETE FROM users WHERE id=$1`, httpx.UserID(r)); err != nil {
		httpx.Error(w, 500, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) putProfile(w http.ResponseWriter, r *http.Request) {
	var p Profile
	if !httpx.Decode(w, r, &p) {
		return
	}
	today := httpx.Today()
	if msg := p.validate(today.Year()); msg != "" {
		httpx.Error(w, 400, msg)
		return
	}
	uid := httpx.UserID(r)
	t := Compute(p, today.Year())
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer tx.Rollback(r.Context())
	_, err = tx.Exec(r.Context(), `INSERT INTO profiles(user_id,sex,birth_year,height_cm,weight_kg,activity_level,goal) VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (user_id) DO UPDATE SET sex=$2,birth_year=$3,height_cm=$4,weight_kg=$5,activity_level=$6,goal=$7,updated_at=now()`,
		uid, p.Sex, p.BirthYear, p.HeightCM, p.WeightKG, p.ActivityLevel, p.Goal)
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

func upsertTarget(ctx context.Context, tx pgx.Tx, uid int64, day time.Time, t Target) error {
	_, err := tx.Exec(ctx, `INSERT INTO targets(user_id,effective_from,kcal,protein_g,carbs_g,fat_g,water_ml,steps,custom) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (user_id,effective_from) DO UPDATE SET kcal=$3,protein_g=$4,carbs_g=$5,fat_g=$6,water_ml=$7,steps=$8,custom=$9,updated_at=now()`,
		uid, day, t.Kcal, t.ProteinG, t.CarbsG, t.FatG, t.WaterML, t.Steps, t.Custom)
	return err
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
	tx, err := s.DB.Begin(r.Context())
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
