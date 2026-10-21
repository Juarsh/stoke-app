package food

import (
	"context"
	"net/http"
	"strconv"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/akarsh/calorie-tracker/internal/store"
)

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
	Part        int     `json:"part"` // item index within the remembered text
	UpdatedAt   string  `json:"updated_at"`
}

func (s *Service) readings(ctx context.Context, uid int64) map[string][]Reading {
	out := map[string][]Reading{}
	if uid == 0 {
		return out
	}
	rows, err := s.pg().Readings().BySpan(ctx, uid)
	if err != nil {
		return out
	}
	for _, row := range rows {
		r := Reading(row)
		out[r.Span] = append(out[r.Span], r)
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

// learnedItems turns all parts of a remembered text into parse items.
func learnedItems(rs []Reading, matched string) []parser.Item {
	var out []parser.Item
	for _, r := range rs {
		out = append(out, r.item(matched))
	}
	return out
}

// remember stores what the user confirmed for their own text (span = the
// parse item's matched_text: the typed span or the whole meal). part is the
// item's index within that text; replace clears older parts first.
func remember(ctx context.Context, tx *store.Tx, uid int64, span string, part int, replace bool, e Entry) error {
	key := Normalize(span)
	if key == "" {
		return nil
	}
	if replace {
		if err := tx.Readings().ForgetSpan(ctx, uid, key); err != nil {
			return err
		}
	}
	return tx.Readings().Remember(ctx, uid, key, part, e)
}

func (s *Service) handleListReadings(w http.ResponseWriter, r *http.Request) {
	rows, err := s.pg().Readings().Recent(r.Context(), httpx.UserID(r))
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	out := []Reading{}
	for _, row := range rows {
		out = append(out, Reading(row))
	}
	httpx.JSON(w, 200, map[string]any{"remembered": out})
}

func (s *Service) handleResetReading(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		httpx.Error(w, 400, "bad id")
		return
	}
	n, err := s.pg().Readings().ResetSpan(r.Context(), httpx.UserID(r), id)
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	if n == 0 {
		httpx.Error(w, 404, "not found")
		return
	}
	w.WriteHeader(204)
}

func (s *Service) handleResetAllReadings(w http.ResponseWriter, r *http.Request) {
	n, err := s.pg().Readings().ResetAll(r.Context(), httpx.UserID(r))
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	httpx.JSON(w, 200, map[string]any{"deleted": n})
}
