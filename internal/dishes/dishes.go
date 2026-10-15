// Package dishes holds our own Indian dish table (see data/dishes.txt and
// data/build_dishes.py). Values are our estimates or generic public-domain /
// open data; no IFCT table was copied.
package dishes

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
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
	// Units: every unit this dish comes in, with its gram weight and where
	// that weight comes from. A typed unit not listed is unit_mismatch.
	Units []DishUnit `json:"units,omitempty"`
}

// DishUnit is one valid unit for a dish.
type DishUnit struct {
	Unit   string  `json:"unit"`
	Grams  float64 `json:"grams"`
	Source string  `json:"source"`
}

// UnitGrams returns the dish's own gram weight for a unit, if listed.
func (d Dish) UnitGrams(unit string) (float64, bool) {
	for _, u := range d.Units {
		if u.Unit == unit {
			return u.Grams, true
		}
	}
	return 0, false
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

// TableVersion is the highest row version; clients send it with saved entries.
func TableVersion(ds []Dish) int {
	v := 1
	for _, d := range ds {
		v = max(v, d.Version)
	}
	return v
}

var snakeID = regexp.MustCompile(`^[a-z0-9]+(_[a-z0-9]+)*$`)

// Validate checks a whole table: stable snake_case unique ids, sane ranges,
// known units/diets, and no alias pointing at two dishes.
func Validate(ds []Dish) error {
	ids := map[string]bool{}
	terms := map[string]string{}
	for _, d := range ds {
		if !snakeID.MatchString(d.ID) || ids[d.ID] {
			return fmt.Errorf("dish %q: id must be unique snake_case", d.ID)
		}
		ids[d.ID] = true
		switch {
		case strings.TrimSpace(d.Name) == "":
			return fmt.Errorf("dish %s: name required", d.ID)
		case d.Unit == "" || d.PortionGrams <= 0:
			return fmt.Errorf("dish %s: unit and portion_grams required", d.ID)
		case d.KcalLow > d.Kcal || d.Kcal > d.KcalHigh || d.Kcal < 0 || d.KcalHigh > 3000:
			return fmt.Errorf("dish %s: need 0 <= kcal_low <= kcal <= kcal_high < 3000", d.ID)
		case d.ProteinLow > d.ProteinG || d.ProteinG > d.ProteinHigh || d.ProteinLow < 0:
			return fmt.Errorf("dish %s: need protein_low <= protein_g <= protein_high", d.ID)
		case d.CarbsG < 0 || d.FatG < 0:
			return fmt.Errorf("dish %s: carbs_g/fat_g must be >= 0", d.ID)
		case d.Diet != "veg" && d.Diet != "egg" && d.Diet != "nonveg":
			return fmt.Errorf("dish %s: diet must be veg, egg or nonveg", d.ID)
		case d.Version < 1:
			return fmt.Errorf("dish %s: version must be >= 1", d.ID)
		}
		for _, t := range append([]string{strings.ToLower(d.Name)}, d.Aliases...) {
			t = strings.ToLower(strings.TrimSpace(t))
			if o, ok := terms[t]; ok && o != d.ID {
				return fmt.Errorf("dish %s: alias %q already belongs to %s", d.ID, t, o)
			}
			terms[t] = d.ID
		}
	}
	return nil
}
