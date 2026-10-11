package coach

import (
	"testing"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

func TestSuggest(t *testing.T) {
	p, _ := parser.New(dishes.MustLoad())
	for _, diet := range []string{"veg", "egg", "nonveg"} {
		for _, in := range []Input{{KcalLeft: 520, ProteinLeft: 38, Diet: diet}, {KcalLeft: 200, ProteinLeft: 10, Diet: diet}, {KcalLeft: 900, ProteinLeft: 60, Diet: diet}} {
			opts := Suggest(p, in)
			if len(opts) != 3 {
				t.Fatalf("%+v: want 3 options, got %d", in, len(opts))
			}
			for _, o := range opts {
				if o.KcalHigh > in.KcalLeft {
					t.Errorf("%+v: option %q goes past target (%v)", in, o.Title, o.KcalHigh)
				}
				for _, it := range o.Items {
					d, _ := p.Dish(it.DishID)
					if !d.Allowed(diet) {
						t.Errorf("%s user got %s", diet, it.DishID)
					}
				}
			}
			t.Logf("%s %v/%v: %q | %q | %q", diet, in.KcalLeft, in.ProteinLeft, opts[0].Title, opts[1].Title, opts[2].Title)
		}
	}
	if got := Suggest(p, Input{KcalLeft: 40, ProteinLeft: 20, Diet: "veg"}); len(got) != 0 {
		t.Errorf("at target should suggest nothing, got %v", got)
	}
}
