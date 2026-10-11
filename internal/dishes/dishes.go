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
