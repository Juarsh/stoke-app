package parser

import (
	"encoding/json"
	"os"
	"testing"
)

// Reports how many dev meals would reach the AI fallback (food-like leftovers).
func TestAIReachRate(t *testing.T) {
	p := newP(t)
	for _, file := range []string{"testdata/dev-meals.json", "testdata/everyday-meals.json"} {
		var raw map[string]json.RawMessage
		b, _ := os.ReadFile(file)
		_ = json.Unmarshal(b, &raw)
		var meals []string
		var dm []devMeal
		if json.Unmarshal(raw["meals"], &dm) == nil && len(dm) > 0 && dm[0].In != "" {
			for _, m := range dm {
				meals = append(meals, m.In)
			}
		} else {
			_ = json.Unmarshal(raw["meals"], &meals)
		}
		reach, spans := 0, map[string]bool{}
		for _, m := range meals {
			u := p.Parse(m).Unmatched
			if len(u) > 0 {
				reach++
			}
			for _, s := range u {
				spans[s] = true
			}
		}
		t.Logf("%s: %d meals, %d reach AI (%.1f%%), %d distinct spans", file, len(meals), reach, 100*float64(reach)/float64(len(meals)), len(spans))
	}
}
