package coach

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// Pick is one rules-based "Picks that fit what's left today" row (ported from
// the app's src/lib/coach.ts so the fallback matches what the Coach tab shows).
type Pick struct {
	DishID  string  `json:"dish_id"`
	Name    string  `json:"name"`
	Qty     float64 `json:"qty"`
	Unit    string  `json:"unit"`
	Kcal    float64 `json:"kcal"`
	Protein float64 `json:"protein"`
	Label   string  `json:"label"`
}

var pickSkipCat = map[string]bool{"condiment": true, "drink": true, "sweet": true}

// PicksThatFit returns up to n dishes from the table that fit kcalLeft,
// favouring protein and respecting diet. When the user is at or over target
// (kcalLeft < 80) it returns lighter picks instead, matching the app.
func PicksThatFit(p *parser.Parser, kcalLeft, proteinLeft float64, diet string, n int) []Pick {
	if n <= 0 {
		n = 3
	}
	if p == nil {
		return []Pick{}
	}
	table := p.Table()
	if kcalLeft >= 80 {
		return suggestPicks(table, kcalLeft, proteinLeft, diet, n)
	}
	return lighterPicks(table, diet, n)
}

func suggestPicks(table []dishes.Dish, kcalLeft, proteinLeft float64, diet string, n int) []Pick {
	var out []Pick
	for _, d := range table {
		if !pickable(d) || !d.Allowed(diet) {
			continue
		}
		qty := 1.0
		if d.Unit == "count" {
			qty = math.Max(1, math.Min(3, math.Floor(kcalLeft/d.Kcal)))
		}
		kcal := math.Round(d.Kcal * qty)
		if kcal > kcalLeft {
			continue
		}
		protein := math.Round(d.ProteinG*qty*10) / 10
		out = append(out, newPick(d, qty, kcal, protein))
	}
	sort.SliceStable(out, func(i, j int) bool {
		si, sj := pickScore(out[i], kcalLeft, proteinLeft), pickScore(out[j], kcalLeft, proteinLeft)
		if si != sj {
			return si > sj
		}
		return out[i].DishID < out[j].DishID
	})
	return pickOnePerCategory(table, out, n)
}

func lighterPicks(table []dishes.Dish, diet string, n int) []Pick {
	var out []Pick
	for _, d := range table {
		if !pickable(d) || !d.Allowed(diet) || d.Kcal > 150 {
			continue
		}
		kcal := math.Round(d.Kcal)
		protein := math.Round(d.ProteinG*10) / 10
		out = append(out, newPick(d, 1, kcal, protein))
	}
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := out[i].Protein/math.Max(out[i].Kcal, 1), out[j].Protein/math.Max(out[j].Kcal, 1)
		if pi != pj {
			return pi > pj
		}
		return out[i].DishID < out[j].DishID
	})
	return pickOnePerCategory(table, out, n)
}

func pickable(d dishes.Dish) bool {
	return !pickSkipCat[d.Category] && d.Kcal > 0 && !d.NeedsVerify && !d.NeedsConfirm && !d.EstimateUnverified
}

func pickScore(s Pick, kcalLeft, proteinLeft float64) float64 {
	p := 0.0
	if proteinLeft > 0 {
		p = math.Min(s.Protein, proteinLeft) / math.Max(s.Kcal, 1) * 1000
	}
	return p + s.Kcal/kcalLeft
}

func pickOnePerCategory(table []dishes.Dish, in []Pick, n int) []Pick {
	catOf := map[string]string{}
	for _, d := range table {
		catOf[d.ID] = d.Category
	}
	seen := map[string]bool{}
	out := []Pick{}
	for _, s := range in {
		c := catOf[s.DishID]
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, s)
		if len(out) == n {
			break
		}
	}
	return out
}

func newPick(d dishes.Dish, qty, kcal, protein float64) Pick {
	unitBit := ""
	if d.Unit != "count" {
		unitBit = d.Unit + " "
	}
	label := strings.Join(strings.Fields(fmt.Sprintf("%s %s%s", trimQty(qty), unitBit, d.Name)), " ")
	return Pick{DishID: d.ID, Name: d.Name, Qty: qty, Unit: d.Unit, Kcal: kcal, Protein: protein, Label: label}
}

func trimQty(f float64) string { return strings.TrimSuffix(fmt.Sprintf("%.1f", f), ".0") }
