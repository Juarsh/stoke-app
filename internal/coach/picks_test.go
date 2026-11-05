package coach

import (
	"testing"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

func TestPicksThatFit(t *testing.T) {
	p, err := parser.New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	for _, diet := range []string{"veg", "egg", "nonveg"} {
		picks := PicksThatFit(p, 520, 38, diet, 3)
		if len(picks) != 3 {
			t.Fatalf("%s: want 3 picks, got %d %#v", diet, len(picks), picks)
		}
		seen := map[string]bool{}
		for _, pk := range picks {
			if pk.Kcal > 520 {
				t.Errorf("%s: %q goes past target (%v)", diet, pk.Label, pk.Kcal)
			}
			if pk.DishID == "" || pk.Label == "" {
				t.Errorf("%s: empty pick %#v", diet, pk)
			}
			d, ok := p.Dish(pk.DishID)
			if !ok || !d.Allowed(diet) {
				t.Errorf("%s user got %s", diet, pk.DishID)
			}
			if seen[d.Category] {
				t.Errorf("%s: two picks in category %s", diet, d.Category)
			}
			seen[d.Category] = true
		}
	}
	light := PicksThatFit(p, 40, 20, "veg", 3)
	if len(light) == 0 {
		t.Fatal("over-target should still return lighter picks")
	}
	for _, pk := range light {
		if pk.Kcal > 150 {
			t.Errorf("lighter pick too heavy: %#v", pk)
		}
		d, _ := p.Dish(pk.DishID)
		if !d.Allowed("veg") {
			t.Errorf("veg user got %s", pk.DishID)
		}
	}
}
