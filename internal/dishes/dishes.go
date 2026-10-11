// Package dishes holds our own Indian dish table (see data/dishes.txt and
// data/build_dishes.py). Values are our estimates or generic public-domain /
// open data; no IFCT table was copied.
package dishes

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed dishes.json
var raw []byte

type Dish struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Aliases      []string `json:"aliases"`
	Unit         string   `json:"unit"` // count, katori, spoon, plate, glass
	PortionGrams float64  `json:"portion_grams"`
	Kcal         float64  `json:"kcal"`
	KcalLow      float64  `json:"kcal_low"`
	KcalHigh     float64  `json:"kcal_high"`
	ProteinG     float64  `json:"protein_g"`
	ProteinLow   float64  `json:"protein_low"`
	ProteinHigh  float64  `json:"protein_high"`
	OilSensitive bool     `json:"oil_sensitive"`
	Source       string   `json:"source"` // usda_fdc, open_food_facts, estimate
	SourceNote   string   `json:"source_note"`
	IsEstimate   bool     `json:"is_estimate"`
	Diet         string   `json:"diet"`     // veg, egg, nonveg
	Category     string   `json:"category"` // bread, rice, dal, combo, main, protein, breakfast, snack, drink, fruit, sweet, condiment
	Brand        string   `json:"brand"`
	Version      int      `json:"version"`
	CarbsG       float64  `json:"carbs_g"` // estimate (see macro_note)
	FatG         float64  `json:"fat_g"`   // estimate (see macro_note)
	MacroNote    string   `json:"macro_note"`
	NeedsVerify  bool     `json:"needs_verification"`
	PieceGrams   float64  `json:"piece_grams,omitempty"`   // countable plate dishes: "8 momos" = 8 pieces
	Parts        []Part   `json:"parts,omitempty"`         // combos: split into these when a portion is given
	NeedsConfirm bool     `json:"needs_confirm,omitempty"` // generic placeholder rows: always ask the user
}

// Part is one component of a combo per one standard portion of the combo.
type Part struct {
	DishID string  `json:"dish_id"`
	Qty    float64 `json:"qty"`
	Unit   string  `json:"unit"`
}

// Allowed reports whether a dish fits a diet preference (veg < egg < nonveg).
func (d Dish) Allowed(diet string) bool {
	switch diet {
	case "veg":
		return d.Diet == "veg"
	case "egg":
		return d.Diet != "nonveg"
	}
	return true
}

// Load returns the embedded dish table.
func Load() ([]Dish, error) {
	var ds []Dish
	if err := json.Unmarshal(raw, &ds); err != nil {
		return nil, fmt.Errorf("dishes: %w", err)
	}
	return ds, nil
}

// MustLoad panics on a broken embedded table (caught by tests).
func MustLoad() []Dish {
	ds, err := Load()
	if err != nil {
		panic(err)
	}
	return ds
}
