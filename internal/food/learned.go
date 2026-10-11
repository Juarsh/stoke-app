package food

import (
	"context"
	"net/http"
	"strconv"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Reading is a user's remembered interpretation of a normalized text span
// ("Remembered foods"). It is private to that user and never goes into the
// shared AI cache.
type Reading struct {
	ID          int64   `json:"id"`
	Span        string  `json:"span"`
	DishID      *string `json:"dish_id"`
	CustomName  string  `json:"custom_name"`
	Qty         float64 `json:"qty"`
	Unit        string  `json:"unit"`
	OilLevel    string  `json:"oil_level"`
	KcalBest    float64 `json:"kcal_best"`
	KcalLow     float64 `json:"kcal_low"`
	KcalHigh    float64 `json:"kcal_high"`
	ProteinBest float64 `json:"protein_best"`
	ProteinLow  float64 `json:"protein_low"`
	ProteinHigh float64 `json:"protein_high"`
	CarbsG      float64 `json:"carbs_g"`
	FatG        float64 `json:"fat_g"`
	Uses        int     `json:"uses"`
	UpdatedAt   string  `json:"updated_at"`
}

const readingCols = `id,norm_span,dish_id,custom_name,qty::float8,unit,oil_level,kcal_best::float8,kcal_low::float8,kcal_high::float8,
	protein_best::float8,protein_low::float8,protein_high::float8,carbs_g::float8,fat_g::float8,uses,to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF')`

func scanReading(row pgx.Row) (Reading, error) {
	var r Reading
	err := row.Scan(&r.ID, &r.Span, &r.DishID, &r.CustomName, &r.Qty, &r.Unit, &r.OilLevel, &r.KcalBest, &r.KcalLow, &r.KcalHigh,
		&r.ProteinBest, &r.ProteinLow, &r.ProteinHigh, &r.CarbsG, &r.FatG, &r.Uses, &r.UpdatedAt)
	return r, err
}

func (s *Service) readings(ctx context.Context, uid int64) map[string]Reading {
	out := map[string]Reading{}
	if uid == 0 {
		return out
	}
	rows, err := s.DB.Query(ctx, `SELECT `+readingCols+` FROM user_readings WHERE user_id=$1`, uid)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		if r, err := scanReading(rows); err == nil {
			out[r.Span] = r
		}
	}
	return out
}

// item turns a reading into a parse item: table source, learned, no confirmation.
func (r Reading) item(matched string) parser.Item {
	it := parser.Item{Matched: matched, Quantity: r.Qty, Unit: r.Unit, OilLevel: r.OilLevel,
		Kcal:    parser.Range{Low: r.KcalLow, Best: r.KcalBest, High: r.KcalHigh},
		Protein: parser.Range{Low: r.ProteinLow, Best: r.ProteinBest, High: r.ProteinHigh},
		CarbsG:  r.CarbsG, FatG: r.FatG, Source: parser.SourceTable, Learned: true, Confidence: 1,
		DataSource: "learned", SourceNote: "Remembered from your earlier confirmation"}
	if r.DishID != nil {
		it.DishID = *r.DishID
	}
	it.Name = r.CustomName
	if it.Name == "" {
		it.Name = it.DishID
	}
	return it
}

// remember stores what the user confirmed for a span (insert or overwrite).
func remember(ctx context.Context, tx execer, uid int64, span string, e Entry) error {
	key := Normalize(span)
	if key == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO user_readings(user_id,norm_span,dish_id,custom_name,qty,unit,oil_level,kcal_best,kcal_low,kcal_high,
		protein_best,protein_low,protein_high,carbs_g,fat_g) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		ON CONFLICT (user_id,norm_span) DO UPDATE SET dish_id=EXCLUDED.dish_id,custom_name=EXCLUDED.custom_name,qty=EXCLUDED.qty,
		unit=EXCLUDED.unit,oil_level=EXCLUDED.oil_level,kcal_best=EXCLUDED.kcal_best,kcal_low=EXCLUDED.kcal_low,kcal_high=EXCLUDED.kcal_high,
		protein_best=EXCLUDED.protein_best,protein_low=EXCLUDED.protein_low,protein_high=EXCLUDED.protein_high,carbs_g=EXCLUDED.carbs_g,
		fat_g=EXCLUDED.fat_g,uses=user_readings.uses+1,updated_at=now()`,
		uid, key, e.DishID, e.CustomName, e.Qty, e.Unit, e.OilLevel, e.KcalBest, e.KcalLow, e.KcalHigh,
		e.ProteinBest, e.ProteinLow, e.ProteinHigh, e.CarbsG, e.FatG)
	return err
}

func (s *Service) handleListReadings(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.Query(r.Context(), `SELECT `+readingCols+` FROM user_readings WHERE user_id=$1 ORDER BY updated_at DESC`, httpx.UserID(r))
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer rows.Close()
	out := []Reading{}
	for rows.Next() {
		rd, err := scanReading(rows)
		if err != nil {
			httpx.Error(w, 500, "db")
			return
		}
		out = append(out, rd)
	}
	httpx.JSON(w, 200, map[string]any{"remembered": out})
}

func (s *Service) handleResetReading(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		httpx.Error(w, 400, "bad id")
		return
	}
	tag, err := s.DB.Exec(r.Context(), `DELETE FROM user_readings WHERE id=$1 AND user_id=$2`, id, httpx.UserID(r))
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Error(w, 404, "not found")
		return
	}
	w.WriteHeader(204)
}

func (s *Service) handleResetAllReadings(w http.ResponseWriter, r *http.Request) {
	tag, err := s.DB.Exec(r.Context(), `DELETE FROM user_readings WHERE user_id=$1`, httpx.UserID(r))
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	httpx.JSON(w, 200, map[string]any{"deleted": tag.RowsAffected()})
}
