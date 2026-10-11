// Package activity: steps from Health Connect in v1 (workouts in v2 reuse
// activity_entries with kind='workout'). Calories from steps are reported
// separately and are NOT added to the food budget unless the user opts in.
package activity

import (
	"context"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/summary"
)

type Rebuilder interface {
	Rebuild(ctx context.Context, userID int64, day time.Time) (summary.Day, error)
}

type Weigher interface {
	WeightKG(ctx context.Context, userID int64) float64
}

type Service struct {
	DB      *pgxpool.Pool
	Summary Rebuilder
	Goals   Weigher
}

// StepsKcal is a rough walking estimate: ~0.0005 kcal per step per kg
// (about 40 kcal per 1,000 steps at 80 kg). Shown as an estimate.
func StepsKcal(steps int, weightKG float64) float64 {
	return math.Round(float64(steps) * 0.0005 * weightKG)
}

func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /v1/activity/steps", wrap(http.HandlerFunc(s.ingest)))
	mux.Handle("GET /v1/activity/steps", wrap(http.HandlerFunc(s.list)))
}

type StepDay struct {
	Date       string `json:"date"`
	Steps      int    `json:"steps"`
	ExternalID string `json:"external_id"`
}

// ingest takes the day totals the app reads from Health Connect. Sending the
// same day again replaces it (Health Connect totals grow during the day).
func (s *Service) ingest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Source string    `json:"source"`
		Days   []StepDay `json:"days"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Source == "" {
		in.Source = "health_connect"
	}
	if in.Source != "health_connect" && in.Source != "manual" {
		httpx.Error(w, 400, "source must be health_connect or manual")
		return
	}
	if len(in.Days) == 0 || len(in.Days) > 31 {
		httpx.Error(w, 400, "send 1-31 days")
		return
	}
	uid := httpx.UserID(r)
	today := httpx.Today()
	wkg := s.Goals.WeightKG(r.Context(), uid)
	var touched []time.Time
	for i, d := range in.Days {
		day, err := httpx.Day(d.Date)
		if err != nil || d.Date == "" || day.After(today) {
			httpx.Error(w, 400, "days["+strconv.Itoa(i)+"].date must be YYYY-MM-DD and not in the future")
			return
		}
		if d.Steps < 0 || d.Steps > 200000 {
			httpx.Error(w, 400, "days["+strconv.Itoa(i)+"].steps must be 0-200000")
			return
		}
		ext := d.ExternalID
		if ext == "" {
			ext = "day:" + d.Date
		}
		_, err = s.DB.Exec(r.Context(), `INSERT INTO activity_entries(user_id,local_date,kind,source,steps,kcal_burned,external_id)
			VALUES ($1,$2,'steps',$3,$4,$5,$6)
			ON CONFLICT (user_id,source,external_id) WHERE external_id IS NOT NULL
			DO UPDATE SET steps=EXCLUDED.steps,kcal_burned=EXCLUDED.kcal_burned,local_date=EXCLUDED.local_date,deleted_at=NULL,updated_at=now()`,
			uid, day, in.Source, d.Steps, StepsKcal(d.Steps, wkg), ext)
		if err != nil {
			httpx.Error(w, 500, "save failed")
			return
		}
		touched = append(touched, day)
	}
	out := []summary.Day{}
	for _, d := range touched {
		sd, err := s.Summary.Rebuild(r.Context(), uid, d)
		if err != nil {
			httpx.Error(w, 500, "summary failed")
			return
		}
		out = append(out, sd)
	}
	httpx.JSON(w, 200, map[string]any{"summaries": out})
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	day, ok := httpx.DayParam(w, r)
	if !ok {
		return
	}
	var steps int
	var kcal float64
	_ = s.DB.QueryRow(r.Context(), `SELECT COALESCE(MAX(steps),0), COALESCE(MAX(kcal_burned),0) FROM activity_entries
		WHERE user_id=$1 AND local_date=$2 AND kind='steps' AND deleted_at IS NULL`, httpx.UserID(r), day).Scan(&steps, &kcal)
	httpx.JSON(w, 200, map[string]any{"date": day.Format("2006-01-02"), "steps": steps, "kcal_burned": kcal})
}

// Contributor fills steps and kcal_out. If several sources report a day we
// take the largest, to avoid double counting the same walk.
type Contributor struct{}

func (Contributor) Name() string { return "activity" }

func (Contributor) Contribute(ctx context.Context, q summary.Querier, uid int64, day time.Time, d *summary.Day) error {
	var kcal float64
	err := q.QueryRow(ctx, `SELECT COALESCE(MAX(steps),0), COALESCE(MAX(kcal_burned),0) FROM activity_entries
		WHERE user_id=$1 AND local_date=$2 AND kind='steps' AND deleted_at IS NULL`, uid, day).Scan(&d.Steps, &kcal)
	d.KcalOut += kcal
	return err
}
